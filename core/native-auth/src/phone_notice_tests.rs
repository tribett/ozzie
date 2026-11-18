//! The phone notice over a temporary folder, a stand-in Keychain and a stand-in sender. No test here
//! reaches ntfy.sh: the real sender's own check is run with a stand-in for its one POST that fails the
//! test if reached, and the wire tests use a listener on this Mac's loopback address. The one test
//! that really posts to ntfy.sh is ignored and run by hand.
use super::*;
use crate::credentials::StoreError;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc;
use std::time::Instant;

struct TempDir(PathBuf);
impl TempDir {
    fn new(label: &str) -> Self {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        Self(std::env::temp_dir().join(format!(
            "ozzie-phone-{label}-{}-{nanos}",
            std::process::id()
        )))
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The next Keychain read, held: it says when it has read the value, then waits to be let go (as a
/// read behind a Keychain dialog would).
type HeldRead = (mpsc::Sender<()>, mpsc::Receiver<()>);

/// A Keychain stand-in that counts reads, can refuse writes or deletes, and can hold one read.
#[derive(Default)]
struct Keychain {
    items: Mutex<HashMap<(String, String), Vec<u8>>>,
    reads: AtomicUsize,
    refuse_put: std::sync::atomic::AtomicBool,
    refuse_delete: std::sync::atomic::AtomicBool,
    hold: Mutex<Option<HeldRead>>,
}
impl Keychain {
    /// Holds the next read after it has read the value: returns (it has read, let it go).
    fn hold_next_read(&self) -> (mpsc::Receiver<()>, mpsc::Sender<()>) {
        let (read_tx, read_rx) = mpsc::channel();
        let (go_tx, go_rx) = mpsc::channel();
        *self.hold.lock().unwrap() = Some((read_tx, go_rx));
        (read_rx, go_tx)
    }
    fn kept(&self) -> Option<String> {
        self.items
            .lock()
            .unwrap()
            .get(&(KEYCHAIN_WORKSPACE.into(), KEYCHAIN_ITEM.into()))
            .map(|v| String::from_utf8(v.clone()).unwrap())
    }
    fn plant(&self, value: &[u8]) {
        self.items.lock().unwrap().insert(
            (KEYCHAIN_WORKSPACE.into(), KEYCHAIN_ITEM.into()),
            value.to_vec(),
        );
    }
}
impl CredentialStore for Keychain {
    fn put(&self, workspace: &str, organization: &str, value: &[u8]) -> Result<(), StoreError> {
        if self.refuse_put.load(Ordering::SeqCst) {
            return Err(StoreError::Denied);
        }
        self.items
            .lock()
            .unwrap()
            .insert((workspace.into(), organization.into()), value.to_vec());
        Ok(())
    }
    fn get(&self, workspace: &str, organization: &str) -> Result<Option<Vec<u8>>, StoreError> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        let value = self
            .items
            .lock()
            .unwrap()
            .get(&(workspace.into(), organization.into()))
            .cloned();
        let held = self.hold.lock().unwrap().take();
        if let Some((read, go)) = held {
            read.send(()).unwrap();
            go.recv().unwrap();
        }
        Ok(value)
    }
    fn delete(&self, workspace: &str, organization: &str) -> Result<(), StoreError> {
        if self.refuse_delete.load(Ordering::SeqCst) {
            return Err(StoreError::Locked);
        }
        self.items
            .lock()
            .unwrap()
            .remove(&(workspace.into(), organization.into()));
        Ok(())
    }
}

/// A sender stand-in: records each request (as its URL, title and body) and answers `answer`.
/// It can also hold one POST after recording it (a POST already on its way when something changes).
struct Recorder {
    sent: Mutex<Vec<(String, &'static str, &'static str)>>,
    answer: Outcome,
    hold: Mutex<Option<HeldRead>>,
}
impl Recorder {
    fn new(answer: Outcome) -> Self {
        Self {
            sent: Mutex::new(Vec::new()),
            answer,
            hold: Mutex::new(None),
        }
    }
    fn sent(&self) -> Vec<(String, &'static str, &'static str)> {
        self.sent.lock().unwrap().clone()
    }
    /// Holds the next POST after it is recorded: returns (it is on its way, let it finish).
    fn hold_next_post(&self) -> (mpsc::Receiver<()>, mpsc::Sender<()>) {
        let (posting_tx, posting_rx) = mpsc::channel();
        let (go_tx, go_rx) = mpsc::channel();
        *self.hold.lock().unwrap() = Some((posting_tx, go_rx));
        (posting_rx, go_tx)
    }
}
impl Post for Recorder {
    fn post(&self, request: &Request) -> Outcome {
        self.sent.lock().unwrap().push((
            request.url().as_str().to_owned(),
            request.title(),
            request.body(),
        ));
        let held = self.hold.lock().unwrap().take();
        if let Some((posting, go)) = held {
            posting.send(()).unwrap();
            go.recv().unwrap();
        }
        self.answer
    }
}

struct Setup {
    dir: TempDir,
    keychain: Arc<Keychain>,
    recorder: Arc<Recorder>,
    clock: Arc<AtomicU64>,
    phone: PhoneNotice,
}
fn setup(label: &str) -> Setup {
    let dir = TempDir::new(label);
    let keychain = Arc::new(Keychain::default());
    let recorder = Arc::new(Recorder::new(Outcome::Accepted));
    let clock = Arc::new(AtomicU64::new(1_000));
    let read = clock.clone();
    let phone = PhoneNotice::with_clock(
        dir.0.clone(),
        keychain.clone(),
        recorder.clone(),
        Box::new(move || read.load(Ordering::SeqCst)),
    );
    Setup {
        dir,
        keychain,
        recorder,
        clock,
        phone,
    }
}
const A_CHANNEL: &str = "ozzie-0123-4567-89ab-cdef-ghjk-mnpq-rstv-wxyz";

// ---- The closed set of lines ----------------------------------------------------------------------

#[test]
fn every_kind_of_notice_maps_to_one_line_of_a_closed_set() {
    assert_eq!(
        [
            "briefing-ready",
            "needs-decision",
            "checked",
            "couldnt-check"
        ]
        .map(Line::for_notice),
        [
            Some(Line::BriefingReady),
            Some(Line::NeedsDecision),
            Some(Line::Checked),
            Some(Line::CouldntCheck)
        ]
    );
    // Anything else the page might name has no line, whatever it holds.
    for kind in [
        "",
        "Avery declined Greeter",
        "Briefing-Ready",
        "needs-decision\n",
        " checked",
        "sunday-attention",
        "test",
        "https://ntfy.sh/other",
    ] {
        assert_eq!(Line::for_notice(kind), None, "{kind:?}");
    }
    // Fourteen lines (one coverage line per day of the watched service, onboarding spec §5.2), all different,
    // each one plain sentence: printable ASCII, no digit (so no count), no line break, no address, no quotation.
    let texts: Vec<&str> = Line::ALL.iter().map(|l| l.text()).collect();
    let mut distinct = texts.clone();
    distinct.sort();
    distinct.dedup();
    assert_eq!(distinct.len(), 14);
    // The day is a closed word; the service's own name or any text never becomes a line.
    for (day, line) in [
        ("sunday", Line::SundayAttention),
        ("wednesday", Line::WednesdayAttention),
        ("weekend", Line::WeekendAttention),
        ("service", Line::ServiceAttention),
    ] {
        assert_eq!(Line::attention(day), Some(line));
    }
    for other in ["Sunday", "youth night", "", "sunday ", "weekday", "Riley"] {
        assert_eq!(Line::attention(other), None, "{other:?}");
    }
    // Only the Sunday line says Sunday.
    for line in Line::ALL {
        assert_eq!(
            line.text().contains("Sunday"),
            line == Line::SundayAttention,
            "{line:?}"
        );
    }
    for text in &texts {
        assert!(text.bytes().all(|b| (b' '..=b'~').contains(&b)), "{text}");
        assert!(!text.bytes().any(|b| b.is_ascii_digit()), "{text}");
        assert!(text.len() <= 100 && text.ends_with('.'), "{text}");
        for refused in ["@", "/", ":", "\"", "[", "]", "{", "<", "http"] {
            assert!(!text.contains(refused), "{text} holds {refused}");
        }
    }
    assert_eq!(TITLE, "Ozzie");
}

#[test]
fn the_lines_name_no_one_from_the_fictional_church() {
    // Every person, team and plan in the fictional Sunday the app's tests and the example use.
    let fixture = std::fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/fictional-sunday.ts"),
    )
    .unwrap();
    let quoted: Vec<&str> = fixture
        .split('"')
        .skip(1)
        .step_by(2)
        .filter(|s| s.len() >= 3 && s.chars().next().is_some_and(char::is_uppercase))
        .collect();
    assert!(
        quoted.contains(&"Avery Brightwater"),
        "the fixture was read"
    );
    for line in Line::ALL {
        for name in &quoted {
            for word in name.split_whitespace().filter(|w| w.len() >= 4) {
                // The fixture's own plan title says "Sunday"; the Sunday notice says it too.
                if word == "Sunday" || word == "Ozzie" {
                    continue;
                }
                assert!(
                    !line.text().contains(word),
                    "{:?} holds {word:?} from {name:?}",
                    line
                );
            }
        }
    }
}

// ---- The channel ----------------------------------------------------------------------------------

#[test]
fn a_channel_is_ozzie_and_160_random_bits_in_a_typeable_alphabet() {
    // ntfy allows up to 64 characters.
    assert_eq!(CHANNEL_LEN, 45);
    assert_eq!(CHANNEL_BYTES * 8, 160);
    let mut alphabet = CHANNEL_ALPHABET.to_vec();
    alphabet.sort();
    alphabet.dedup();
    assert_eq!(alphabet.len(), 32);
    for confusable in b"ilou" {
        assert!(!CHANNEL_ALPHABET.contains(confusable));
    }
    // Fixed bits give fixed characters, most significant first.
    assert_eq!(
        Channel::from_random(&[0; CHANNEL_BYTES]).as_str(),
        "ozzie-0000-0000-0000-0000-0000-0000-0000-0000"
    );
    assert_eq!(
        Channel::from_random(&[0xff; CHANNEL_BYTES]).as_str(),
        "ozzie-zzzz-zzzz-zzzz-zzzz-zzzz-zzzz-zzzz-zzzz"
    );
    let mut counting = [0u8; CHANNEL_BYTES];
    // 0x00 0x44 0x32 0x14 0xc7 is 00000 00001 00010 00011 00100 00101 00110 00111.
    counting[..5].copy_from_slice(&[0x00, 0x44, 0x32, 0x14, 0xc7]);
    assert!(
        Channel::from_random(&counting)
            .as_str()
            .starts_with("ozzie-0123-4567-0000")
    );
    // From the operating system: every one fits the grammar, and none repeats.
    let mut seen = std::collections::HashSet::new();
    for _ in 0..2_000 {
        let channel = Channel::random().unwrap();
        assert!(channel_ok(channel.as_str()));
        assert!(seen.insert(channel.as_str().to_owned()));
    }
    // Every character of the alphabet turns up.
    let used: std::collections::HashSet<char> = seen
        .iter()
        .flat_map(|c| c[PREFIX.len()..].chars())
        .filter(|c| *c != '-')
        .collect();
    assert_eq!(used.len(), 32);
}

#[test]
fn only_a_channel_exactly_as_ozzie_makes_them_passes() {
    assert!(channel_ok(A_CHANNEL));
    for hostile in [
        "",
        "ozzie-",
        "ozzie",
        "ozzie-0123-4567-89ab-cdef-ghjk-mnpq-rstv",
        "ozzie-0123-4567-89ab-cdef-ghjk-mnpq-rstv-wxyz-0000",
        "ozzie-0123-4567-89ab-cdef-ghjk-mnpq-rstv-wxyZ",
        "ozzie-0123-4567-89ab-cdef-ghjk-mnpq-rstv-wxyi",
        "ozzie-0123-4567-89ab-cdef-ghjk-mnpq-rstvwxyz-",
        "ozzie-0123-4567-89ab-cdef-ghjk-mnpq-rst--wxyz",
        "OZZIE-0123-4567-89ab-cdef-ghjk-mnpq-rstv-wxyz",
        "xozzie-123-4567-89ab-cdef-ghjk-mnpq-rstv-wxyz",
        "ozzie-0123-4567-89ab-cdef-ghjk-mnpq-rstv-wx/z",
        "ozzie-0123-4567-89ab-cdef-ghjk-mnpq-rstv-wx.z",
        "ozzie-0123-4567-89ab-cdef-ghjk-mnpq-rstv-w?yz",
        "ozzie-0123-4567-89ab-cdef-ghjk-mnpq-rstv-w#yz",
        "ozzie-0123-4567-89ab-cdef-ghjk-mnpq-rstv-w@yz",
        "ozzie-0123-4567-89ab-cdef-ghjk-mnpq-rstv-w yz",
        "ozzie-0123-4567-89ab-cdef-ghjk-mnpq-rstv-wxy\n",
        "ozzie-0123-4567-89ab-cdef-ghjk-mnpq-rstv-wxy\u{0430}",
        "ozzie-0123-4567-89ab-cdef-ghjk-mnpq-rstv-wxyz\0",
        "../../ozzie-0123-4567-89ab-cdef-ghjk-mnpq-rs",
        "evil.example/ozzie-0123-4567-89ab-cdef-ghjk",
        "https://evil.example/ozzie-0123-4567-89ab-c",
    ] {
        assert!(!channel_ok(hostile), "{hostile:?}");
        assert!(Channel::parse(hostile.as_bytes()).is_none(), "{hostile:?}");
    }
    assert!(Channel::parse(&[0xff, 0xfe]).is_none());
}

#[test]
fn the_request_is_only_ever_to_ntfy_sh_and_the_channel_path() {
    let channel = Channel::parse(A_CHANNEL.as_bytes()).unwrap();
    for line in Line::ALL {
        let request = Request::new(&channel, line).unwrap();
        assert_eq!(
            request.url().as_str(),
            format!("https://ntfy.sh/{A_CHANNEL}")
        );
        assert!(request_ok(&request));
        assert_eq!(request.url().scheme(), "https");
        assert_eq!(request.url().host_str(), Some("ntfy.sh"));
        assert_eq!(request.url().port_or_known_default(), Some(443));
        assert_eq!(request.url().query(), None);
        assert_eq!((request.title(), request.body()), ("Ozzie", line.text()));
    }
    // A request whose address was changed after it was built is refused by the shape check and
    // by the real sender, which then sends nothing. The real sender runs here with a stand-in for its
    // one POST that fails the test if it is ever reached, so even if the check regressed nothing
    // could reach a network.
    fn never(url: &str, _: &'static str) -> Outcome {
        panic!("the real sender went on to post a request of another shape: {url}")
    }
    let guarded = NtfyHttp { send: never };
    for other in [
        "https://ntfy.sh.evil.example/ozzie-0123-4567-89ab-cdef-ghjk-mnpq-rstv-wxyz",
        "http://ntfy.sh/ozzie-0123-4567-89ab-cdef-ghjk-mnpq-rstv-wxyz",
        "https://ntfy.sh:8443/ozzie-0123-4567-89ab-cdef-ghjk-mnpq-rstv-wxyz",
        "https://user@ntfy.sh/ozzie-0123-4567-89ab-cdef-ghjk-mnpq-rstv-wxyz",
        "https://ntfy.sh/ozzie-0123-4567-89ab-cdef-ghjk-mnpq-rstv-wxyz?up=1",
        "https://ntfy.sh/ozzie-0123-4567-89ab-cdef-ghjk-mnpq-rstv-wxyz#x",
        "https://ntfy.sh/ozzie-0123-4567-89ab-cdef-ghjk-mnpq-rstv-wxyz/json",
        "https://ntfy.sh/",
        "https://127.0.0.1/ozzie-0123-4567-89ab-cdef-ghjk-mnpq-rstv-wxyz",
    ] {
        let request = Request {
            url: Url::parse(other).unwrap(),
            line: Line::Test,
        };
        assert!(!request_ok(&request), "{other}");
        assert_eq!(guarded.post(&request), Outcome::Unavailable, "{other}");
    }
    // A request of the one shape goes on to the POST, once, with its address and line.
    static POSTED: Mutex<Vec<(String, &'static str)>> = Mutex::new(Vec::new());
    fn noted(url: &str, body: &'static str) -> Outcome {
        POSTED.lock().unwrap().push((url.to_owned(), body));
        Outcome::Accepted
    }
    let request = Request::new(&channel, Line::Checked).unwrap();
    assert_eq!(NtfyHttp { send: noted }.post(&request), Outcome::Accepted);
    assert_eq!(
        *POSTED.lock().unwrap(),
        vec![(format!("https://ntfy.sh/{A_CHANNEL}"), Line::Checked.text())]
    );
    // The app's sender is the real HTTPS one, and that is the only place it is named.
    let source = include_str!("phone_notice.rs");
    assert!(source.contains(
        "impl Default for NtfyHttp {\n    fn default() -> Self {\n        Self { send: https_post }\n    }\n}"
    ));
    assert_eq!(source.matches("send: https_post").count(), 1);
}

#[test]
fn debug_output_never_shows_the_channel() {
    let channel = Channel::parse(A_CHANNEL.as_bytes()).unwrap();
    let request = Request::new(&channel, Line::Checked).unwrap();
    let view = PhoneView {
        on: true,
        channel: Some(A_CHANNEL.into()),
        last: Some(LastNotice {
            outcome: Outcome::Accepted,
            at_ms: 1_000,
        }),
    };
    for shown in [
        format!("{channel:?}"),
        format!("{request:?}"),
        format!("{view:?}"),
    ] {
        assert!(!shown.contains("0123"), "{shown}");
        assert!(!shown.contains(&A_CHANNEL[PREFIX.len()..]), "{shown}");
    }
    assert_eq!(
        format!("{view:?}"),
        "PhoneView { on: true, channel: hidden, last: Some(LastNotice { outcome: Accepted, at_ms: 1000 }) }"
    );
    // What the page receives: the last notice is a closed code and a time, never the channel.
    let sent = serde_json::to_value(&view).unwrap();
    assert_eq!(
        sent["last"],
        serde_json::json!({ "outcome": "accepted", "at_ms": 1000 })
    );
    assert!(
        !serde_json::to_string(&sent["last"])
            .unwrap()
            .contains(&A_CHANNEL[PREFIX.len()..])
    );
}

// ---- On, off, a new channel -----------------------------------------------------------------------

#[test]
fn off_by_default_nothing_is_read_or_sent() {
    let s = setup("off");
    assert!(!s.phone.is_on());
    assert!(!s.phone.status().on && s.phone.status().channel.is_none());
    for line in Line::ALL {
        assert_eq!(s.phone.send(line), Outcome::Off);
    }
    // Off reads nothing from the Keychain, even with a channel left there.
    s.keychain.plant(A_CHANNEL.as_bytes());
    assert_eq!(s.phone.send(Line::NeedsDecision), Outcome::Off);
    assert_eq!(s.keychain.reads.load(Ordering::SeqCst), 0);
    assert!(s.recorder.sent().is_empty());
    assert_eq!(s.phone.new_channel().err(), Some(PhoneError::Off));
    assert!(!s.dir.0.exists() || !s.dir.0.join(ON_FILE).exists());
}

#[test]
fn turning_it_on_keeps_a_new_channel_in_the_keychain_and_sends_each_line_to_it() {
    let s = setup("on");
    let view = s.phone.turn_on().unwrap();
    assert!(view.on);
    let channel = view.channel.clone().unwrap();
    assert!(channel_ok(&channel));
    assert_eq!(s.keychain.kept().as_deref(), Some(channel.as_str()));
    // The marker holds nothing and only this user can read it.
    let marker = s.dir.0.join(ON_FILE);
    assert_eq!(std::fs::read(&marker).unwrap(), Vec::<u8>::new());
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&marker).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    // Turning on again keeps the same channel.
    assert_eq!(s.phone.turn_on().unwrap().channel, Some(channel.clone()));
    assert_eq!(s.phone.status().channel, Some(channel.clone()));
    // Every line reaches the phone; past an hour's twelve, the next hour (by this Mac's clock) takes the rest.
    for (n, line) in Line::ALL.into_iter().enumerate() {
        if n > 0 && n % PER_HOUR == 0 {
            s.clock.fetch_add(HOUR_MS, Ordering::SeqCst);
        }
        assert_eq!(s.phone.send(line), Outcome::Accepted, "{line:?}");
    }
    let url = format!("https://ntfy.sh/{channel}");
    assert_eq!(
        s.recorder.sent(),
        Line::ALL
            .iter()
            .map(|l| (url.clone(), "Ozzie", l.text()))
            .collect::<Vec<_>>()
    );
    // The channel is in no file in the app's data folder.
    for entry in std::fs::read_dir(&s.dir.0).unwrap() {
        let bytes = std::fs::read(entry.unwrap().path()).unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains(&channel[PREFIX.len()..]));
    }
}

#[test]
fn a_new_channel_replaces_the_old_one_which_gets_nothing_more() {
    let s = setup("new");
    let old = s.phone.turn_on().unwrap().channel.unwrap();
    let new = s.phone.new_channel().unwrap().channel.unwrap();
    assert_ne!(old, new);
    assert_eq!(s.keychain.kept(), Some(new.clone()));
    s.phone.send(Line::Checked);
    assert_eq!(
        s.recorder
            .sent()
            .into_iter()
            .map(|(url, _, _)| url)
            .collect::<Vec<_>>(),
        vec![format!("https://ntfy.sh/{new}")]
    );
    // A new channel that can't be kept leaves the old one working.
    s.keychain.refuse_put.store(true, Ordering::SeqCst);
    assert_eq!(s.phone.new_channel().err(), Some(PhoneError::Unavailable));
    assert_eq!(s.phone.status().channel, Some(new));
}

#[test]
fn turning_it_off_stops_sending_and_forgets_the_channel() {
    let s = setup("stop");
    s.phone.turn_on().unwrap();
    s.phone.turn_off().unwrap();
    assert!(!s.phone.is_on());
    assert_eq!(s.keychain.kept(), None);
    assert_eq!(s.phone.send(Line::NeedsDecision), Outcome::Off);
    assert!(s.recorder.sent().is_empty());
    // Off twice is fine.
    s.phone.turn_off().unwrap();
    // Turned on again: a channel never used before.
    let first = {
        let v = s.phone.turn_on().unwrap();
        v.channel.unwrap()
    };
    s.phone.turn_off().unwrap();
    let second = s.phone.turn_on().unwrap().channel.unwrap();
    assert_ne!(first, second);
    // The Keychain can't forget it: the marker is gone anyway, so nothing is sent, and it says so.
    s.keychain.refuse_delete.store(true, Ordering::SeqCst);
    assert_eq!(s.phone.turn_off().err(), Some(PhoneError::Unavailable));
    assert!(!s.phone.is_on());
    assert_eq!(s.phone.send(Line::Checked), Outcome::Off);
    assert!(s.recorder.sent().is_empty());
    // The next start forgets it once the Keychain lets it.
    assert_eq!(s.phone.startup().err(), Some(PhoneError::Unavailable));
    s.keychain.refuse_delete.store(false, Ordering::SeqCst);
    s.phone.startup().unwrap();
    assert_eq!(s.keychain.kept(), None);
}

#[test]
fn start_up_forgets_a_channel_left_while_off_and_keeps_one_while_on() {
    let s = setup("startup");
    s.keychain.plant(A_CHANNEL.as_bytes());
    s.phone.startup().unwrap();
    assert_eq!(s.keychain.kept(), None);
    let channel = s.phone.turn_on().unwrap().channel.unwrap();
    s.phone.startup().unwrap();
    assert_eq!(s.keychain.kept(), Some(channel));
}

#[test]
fn turning_it_on_fails_whole_when_the_channel_or_marker_cant_be_kept() {
    let s = setup("fail");
    s.keychain.refuse_put.store(true, Ordering::SeqCst);
    assert_eq!(s.phone.turn_on().err(), Some(PhoneError::Unavailable));
    assert!(!s.phone.is_on());
    s.keychain.refuse_put.store(false, Ordering::SeqCst);
    // A file where the folder should be: the marker can't be written, and the channel isn't kept.
    let blocked = TempDir::new("blocked");
    std::fs::write(&blocked.0, b"not a folder").unwrap();
    let keychain = Arc::new(Keychain::default());
    let phone = PhoneNotice::new(
        blocked.0.clone(),
        keychain.clone(),
        Arc::new(Recorder::new(Outcome::Accepted)),
    );
    assert_eq!(phone.turn_on().err(), Some(PhoneError::Unavailable));
    assert_eq!(keychain.kept(), None);
    assert_eq!(phone.send(Line::Test), Outcome::Off);
}

#[test]
fn a_marker_that_is_a_link_is_not_on() {
    let s = setup("link");
    std::fs::create_dir_all(&s.dir.0).unwrap();
    let target = s.dir.0.join("elsewhere");
    std::fs::write(&target, b"").unwrap();
    std::os::unix::fs::symlink(&target, s.dir.0.join(ON_FILE)).unwrap();
    s.keychain.plant(A_CHANNEL.as_bytes());
    assert!(!s.phone.is_on());
    assert_eq!(s.phone.send(Line::Checked), Outcome::Off);
    assert!(s.recorder.sent().is_empty());
}

// ---- Hostile stored values ------------------------------------------------------------------------

#[test]
fn a_stored_value_that_isnt_a_channel_sends_nothing() {
    let s = setup("hostile");
    s.phone.turn_on().unwrap();
    for hostile in [
        b"".as_slice(),
        b"ozzie-",
        b"ntfy.sh.evil.example/x",
        b"../../../etc",
        b"ozzie-0123-4567-89ab-cdef-ghjk-mnpq-rstv-wxyz?x=1",
        b"ozzie-0123-4567-89ab-cdef-ghjk-mnpq-rstv-wxyz/../other",
        b"ozzie-0123-4567-89ab-cdef-ghjk-mnpq-rstv-wxyz\r\nX-Evil: 1",
        b"ozzie-0123-4567-89ab-cdef-ghjk-mnpq-rstv-WXYZ",
        b"Avery Brightwater",
        b"\xff\xfe\xfd",
        &[b'a'; 4096],
    ] {
        s.keychain.plant(hostile);
        for line in Line::ALL {
            assert_eq!(s.phone.send(line), Outcome::Unavailable, "{hostile:?}");
        }
        assert_eq!(s.phone.status().channel, None);
    }
    // Nothing was sent, and the hour's allowance wasn't spent on them.
    assert!(s.recorder.sent().is_empty());
    s.keychain.plant(A_CHANNEL.as_bytes());
    assert_eq!(s.phone.send(Line::Test), Outcome::Accepted);
    assert_eq!(s.recorder.sent().len(), 1);
}

// ---- At most PER_HOUR an hour -----------------------------------------------------------------------

#[test]
fn at_most_twelve_an_hour_and_never_a_retry() {
    let s = setup("hour");
    s.phone.turn_on().unwrap();
    for _ in 0..PER_HOUR {
        assert_eq!(s.phone.send(Line::Checked), Outcome::Accepted);
    }
    assert_eq!(s.phone.send(Line::Checked), Outcome::TooMany);
    assert_eq!(s.phone.send(Line::Test), Outcome::TooMany);
    assert_eq!(s.recorder.sent().len(), PER_HOUR);
    s.clock.fetch_add(HOUR_MS - 1, Ordering::SeqCst);
    assert_eq!(s.phone.send(Line::Checked), Outcome::TooMany);
    s.clock.fetch_add(1, Ordering::SeqCst);
    assert_eq!(s.phone.send(Line::Checked), Outcome::Accepted);
    assert_eq!(s.recorder.sent().len(), PER_HOUR + 1);
    // An answer that isn't success is reported as it is, and nothing is tried again.
    let refusing = TempDir::new("refused");
    let keychain = Arc::new(Keychain::default());
    let recorder = Arc::new(Recorder::new(Outcome::Refused));
    let phone = PhoneNotice::new(refusing.0.clone(), keychain, recorder.clone());
    phone.turn_on().unwrap();
    assert_eq!(phone.send(Line::NeedsDecision), Outcome::Refused);
    assert_eq!(recorder.sent().len(), 1);
}

#[test]
fn the_hour_is_by_this_macs_clock_so_sleep_counts_and_a_clock_set_back_never_frees_more() {
    let s = setup("clock");
    s.phone.turn_on().unwrap();
    let start = 10 * HOUR_MS;
    s.clock.store(start, Ordering::SeqCst);
    for _ in 0..PER_HOUR {
        assert_eq!(s.phone.send(Line::Checked), Outcome::Accepted);
    }
    assert_eq!(s.phone.send(Line::Checked), Outcome::TooMany);
    // The clock set back two hours: the twelve count from now, so nothing more goes for a full hour.
    s.clock.store(start - 2 * HOUR_MS, Ordering::SeqCst);
    assert_eq!(s.phone.send(Line::Checked), Outcome::TooMany);
    s.clock.store(start - HOUR_MS - 1, Ordering::SeqCst);
    assert_eq!(s.phone.send(Line::Checked), Outcome::TooMany);
    s.clock.store(start - HOUR_MS, Ordering::SeqCst);
    assert_eq!(s.phone.send(Line::Checked), Outcome::Accepted);
    assert_eq!(s.recorder.sent().len(), PER_HOUR + 1);

    // An hour asleep counts as an hour: the next notice after waking goes.
    let t = setup("asleep");
    t.phone.turn_on().unwrap();
    for _ in 0..PER_HOUR {
        assert_eq!(t.phone.send(Line::Checked), Outcome::Accepted);
    }
    t.clock.fetch_add(3 * HOUR_MS, Ordering::SeqCst);
    assert_eq!(t.phone.send(Line::Checked), Outcome::Accepted);

    // The app's clock is this Mac's: a notice's time is now, in milliseconds since 1970.
    let real = TempDir::new("wall");
    let phone = PhoneNotice::new(
        real.0.clone(),
        Arc::new(Keychain::default()),
        Arc::new(Recorder::new(Outcome::Accepted)),
    );
    phone.turn_on().unwrap();
    let before = wall_ms();
    let last = phone.send_noted(Line::Test);
    assert_eq!(last.outcome, Outcome::Accepted);
    assert!(before <= last.at_ms && last.at_ms <= wall_ms(), "{last:?}");
}
fn wall_ms() -> u64 {
    u64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis(),
    )
    .unwrap()
}

// ---- What became of the last phone notice ----------------------------------------------------------

#[test]
fn the_last_phone_notice_and_when_are_kept_in_memory_for_settings_never_the_channel() {
    let s = setup("last");
    // Off: nothing kept, and a notice while off keeps nothing.
    assert_eq!(s.phone.status().last, None);
    assert_eq!(s.phone.send(Line::Checked), Outcome::Off);
    let view = s.phone.turn_on().unwrap();
    assert_eq!(view.last, None);
    assert_eq!(s.phone.status().last, None);
    // A real notice: what ntfy.sh made of it, and when.
    s.clock.store(5_000, Ordering::SeqCst);
    assert_eq!(s.phone.send(Line::NeedsDecision), Outcome::Accepted);
    let accepted = LastNotice {
        outcome: Outcome::Accepted,
        at_ms: 5_000,
    };
    assert_eq!(s.phone.status().last, Some(accepted));
    // The test notice: the same record, and the command gets it back.
    s.clock.store(6_000, Ordering::SeqCst);
    let test = s.phone.send_noted(Line::Test);
    assert_eq!(
        test,
        LastNotice {
            outcome: Outcome::Accepted,
            at_ms: 6_000
        }
    );
    assert_eq!(s.phone.status().last, Some(test));
    // Too many this hour.
    for _ in 2..PER_HOUR {
        s.phone.send(Line::Checked);
    }
    s.clock.store(7_000, Ordering::SeqCst);
    assert_eq!(s.phone.send(Line::Checked), Outcome::TooMany);
    assert_eq!(
        s.phone.status().last,
        Some(LastNotice {
            outcome: Outcome::TooMany,
            at_ms: 7_000
        })
    );
    // The channel couldn't be read.
    s.clock.fetch_add(HOUR_MS, Ordering::SeqCst);
    s.keychain.plant(b"not a channel");
    assert_eq!(s.phone.send(Line::Checked), Outcome::Unavailable);
    assert_eq!(
        s.phone.status().last.map(|l| l.outcome),
        Some(Outcome::Unavailable)
    );
    // Turning it off forgets it; turning it on again starts with none.
    s.phone.turn_off().unwrap();
    assert_eq!(s.phone.status().last, None);
    s.phone.turn_on().unwrap();
    assert_eq!(s.phone.status().last, None);
    // A new channel starts with none too.
    s.phone.send(Line::Checked);
    assert!(s.phone.status().last.is_some());
    assert_eq!(s.phone.new_channel().unwrap().last, None);
    assert_eq!(s.phone.status().last, None);

    // Refused and unreachable are kept as they are.
    for answer in [Outcome::Refused, Outcome::Unreachable] {
        let dir = TempDir::new("answers");
        let phone = PhoneNotice::new(
            dir.0.clone(),
            Arc::new(Keychain::default()),
            Arc::new(Recorder::new(answer)),
        );
        phone.turn_on().unwrap();
        assert_eq!(phone.send(Line::SundayAttention), answer);
        assert_eq!(phone.status().last.map(|l| l.outcome), Some(answer));
    }
}

// ---- Turning it off never waits on the Keychain -----------------------------------------------------

/// Runs `change` while a send is held inside its Keychain read (as behind a Keychain dialog), then lets
/// the read go. `change` must finish while the read is still held. Returns what the send came to.
fn while_a_read_is_held(s: &Setup, change: impl FnOnce(&PhoneNotice) + Send) -> Outcome {
    while_held(s, s.keychain.hold_next_read(), change)
}
/// The same, with the send held where `held` holds it (its Keychain read, or its POST).
fn while_held(
    s: &Setup,
    held: (mpsc::Receiver<()>, mpsc::Sender<()>),
    change: impl FnOnce(&PhoneNotice) + Send,
) -> Outcome {
    let (read, go) = held;
    std::thread::scope(|scope| {
        let phone = &s.phone;
        let sending = scope.spawn(move || phone.send(Line::NeedsDecision));
        read.recv_timeout(Duration::from_secs(5))
            .expect("the send reached the point it is held at");
        let (done_tx, done_rx) = mpsc::channel();
        scope.spawn(move || {
            change(phone);
            done_tx.send(()).unwrap();
        });
        let done = done_rx.recv_timeout(Duration::from_secs(5));
        // Always let the send go on, so a regression fails the test instead of hanging it.
        go.send(()).unwrap();
        assert!(done.is_ok(), "the change waited on the held send");
        sending.join().unwrap()
    })
}

#[test]
fn turning_it_off_never_waits_on_a_keychain_read_and_a_read_finished_after_sends_nothing() {
    let s = setup("held-off");
    let channel = s.phone.turn_on().unwrap().channel.unwrap();
    let outcome = while_a_read_is_held(&s, |phone| {
        assert_eq!(phone.turn_off(), Ok(()));
        assert!(!phone.is_on());
    });
    // The read came back with the channel after it was turned off: checked again just before the
    // POST, so nothing was sent.
    assert_eq!(outcome, Outcome::Off);
    assert!(s.recorder.sent().is_empty());
    assert_eq!(s.keychain.kept(), None);
    assert!(!channel.is_empty());
}

#[test]
fn a_read_finished_after_a_new_channel_or_off_and_on_again_never_reaches_the_old_channel() {
    // A new channel while the read is held.
    let s = setup("held-new");
    let old = s.phone.turn_on().unwrap().channel.unwrap();
    let outcome = while_a_read_is_held(&s, |phone| {
        phone.new_channel().unwrap();
    });
    assert_eq!(outcome, Outcome::Unavailable);
    assert!(s.recorder.sent().is_empty(), "the old channel {old} got it");
    // The new one works.
    assert_eq!(s.phone.send(Line::Checked), Outcome::Accepted);
    let new = s.phone.status().channel.unwrap();
    assert_eq!(
        s.recorder.sent(),
        vec![(
            format!("https://ntfy.sh/{new}"),
            "Ozzie",
            Line::Checked.text()
        )]
    );

    // Off and on again while the read is held.
    let t = setup("held-again");
    t.phone.turn_on().unwrap();
    let outcome = while_a_read_is_held(&t, |phone| {
        phone.turn_off().unwrap();
        phone.turn_on().unwrap();
    });
    assert_ne!(outcome, Outcome::Accepted);
    assert!(t.recorder.sent().is_empty());

    // Settings asking whether it's on, held in its read, doesn't hold up turning it off either.
    let u = setup("held-status");
    u.phone.turn_on().unwrap();
    let (read, go) = u.keychain.hold_next_read();
    std::thread::scope(|scope| {
        let phone = &u.phone;
        let asking = scope.spawn(move || phone.status());
        read.recv_timeout(Duration::from_secs(5)).unwrap();
        let (done_tx, done_rx) = mpsc::channel();
        scope.spawn(move || {
            done_tx.send(phone.turn_off()).unwrap();
        });
        let done = done_rx.recv_timeout(Duration::from_secs(5));
        go.send(()).unwrap();
        assert_eq!(done.expect("turning off waited on the read"), Ok(()));
        asking.join().unwrap();
    });
    assert!(!u.phone.is_on());
    assert_eq!(u.keychain.kept(), None);
}

#[test]
fn a_send_that_ends_after_a_change_never_writes_the_last_notice_settings_shows() {
    /// A send held at `hold` while `change` runs: what it returned, and the last notice afterwards.
    fn after(
        label: &str,
        hold: fn(&Setup) -> (mpsc::Receiver<()>, mpsc::Sender<()>),
        change: fn(&PhoneNotice),
    ) -> (Outcome, Option<LastNotice>, Vec<String>) {
        let s = setup(label);
        let old = s.phone.turn_on().unwrap().channel.unwrap();
        let outcome = while_held(&s, hold(&s), change);
        let urls = s
            .recorder
            .sent()
            .into_iter()
            .map(|(url, _, _)| url)
            .collect();
        assert!(s.phone.is_on(), "{label}");
        assert_ne!(s.phone.status().channel, Some(old), "{label}");
        (outcome, s.phone.status().last, urls)
    }
    let read = |s: &Setup| s.keychain.hold_next_read();
    let post = |s: &Setup| s.recorder.hold_next_post();
    let new_channel = |phone: &PhoneNotice| {
        phone.new_channel().unwrap();
    };
    let off_and_on = |phone: &PhoneNotice| {
        phone.turn_off().unwrap();
        phone.turn_on().unwrap();
    };
    for (label, change) in [
        ("new", new_channel as fn(&PhoneNotice)),
        ("again", off_and_on as fn(&PhoneNotice)),
    ] {
        // Held in its Keychain read: it ends refused by the recheck, and Settings still shows nothing.
        let (outcome, last, urls) = after(&format!("{label}-read"), read, change);
        assert_eq!(outcome, Outcome::Unavailable, "{label}");
        assert_eq!(last, None, "{label}: the old send wrote the last notice");
        assert!(urls.is_empty(), "{label}");
        // Held in its POST (already on its way to the old channel when the change came): ntfy.sh accepts
        // it, and still Settings, now about the new channel, shows nothing for it.
        let (outcome, last, urls) = after(&format!("{label}-post"), post, change);
        assert_eq!(outcome, Outcome::Accepted, "{label}");
        assert_eq!(last, None, "{label}: the old POST wrote the last notice");
        assert_eq!(urls.len(), 1, "{label}");
    }
    // With nothing changed meanwhile, a held send still writes it.
    let s = setup("unchanged");
    s.phone.turn_on().unwrap();
    let outcome = while_held(&s, s.recorder.hold_next_post(), |_| {});
    assert_eq!(outcome, Outcome::Accepted);
    assert_eq!(
        s.phone.status().last,
        Some(LastNotice {
            outcome: Outcome::Accepted,
            at_ms: 1_000
        })
    );
}

// ---- The bytes on the wire ------------------------------------------------------------------------

/// One request read from a loopback listener: what the HTTP library really writes. Answers `reply`.
fn capture(listener: TcpListener, reply: &'static [u8]) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut seen = Vec::new();
        let mut buffer = [0u8; 4096];
        loop {
            let n = stream.read(&mut buffer).unwrap_or(0);
            seen.extend_from_slice(&buffer[..n]);
            let text = String::from_utf8_lossy(&seen).to_string();
            if let Some(end) = text.find("\r\n\r\n") {
                let length = text[..end]
                    .lines()
                    .find_map(|l| l.strip_prefix("content-length: "))
                    .map_or(0, |v| v.trim().parse::<usize>().unwrap());
                if seen.len() >= end + 4 + length {
                    break;
                }
            }
            if n == 0 {
                break;
            }
        }
        let _ = stream.write_all(reply);
        seen
    })
}

#[test]
fn on_the_wire_one_post_with_the_title_and_the_fixed_line_and_nothing_else() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = capture(
        listener,
        b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}",
    );
    let client = client(false, Duration::from_secs(5)).unwrap();
    let url = format!("http://127.0.0.1:{port}/{A_CHANNEL}");
    assert_eq!(
        post_once(&client, &url, Line::NeedsDecision.text()),
        Outcome::Accepted
    );
    let raw = String::from_utf8(server.join().unwrap()).unwrap();
    let (head, body) = raw.split_once("\r\n\r\n").unwrap();
    let mut lines = head.lines();
    assert_eq!(
        lines.next(),
        Some(format!("POST /{A_CHANNEL} HTTP/1.1").as_str())
    );
    let mut headers: Vec<String> = lines.map(str::to_owned).collect();
    headers.sort();
    let mut expected = vec![
        "accept: */*".to_owned(),
        format!("content-length: {}", Line::NeedsDecision.text().len()),
        "content-type: text/plain; charset=utf-8".to_owned(),
        format!("host: 127.0.0.1:{port}"),
        "title: Ozzie".to_owned(),
    ];
    expected.sort();
    assert_eq!(headers, expected);
    assert_eq!(body, Line::NeedsDecision.text());
}

#[test]
fn a_redirect_is_never_followed_and_a_silent_server_is_given_up_on() {
    // A redirect to a second listener: reported as refused, and the second one is never asked.
    let elsewhere = TcpListener::bind("127.0.0.1:0").unwrap();
    let elsewhere_port = elsewhere.local_addr().unwrap().port();
    elsewhere.set_nonblocking(true).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let reply: &'static [u8] = Box::leak(
        format!(
            "HTTP/1.1 307 Temporary Redirect\r\nlocation: http://127.0.0.1:{elsewhere_port}/x\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
        )
        .into_bytes()
        .into_boxed_slice(),
    );
    let server = capture(listener, reply);
    let plain_client = client(false, Duration::from_secs(5)).unwrap();
    let url = format!("http://127.0.0.1:{port}/{A_CHANNEL}");
    assert_eq!(
        post_once(&plain_client, &url, Line::Test.text()),
        Outcome::Refused
    );
    server.join().unwrap();
    std::thread::sleep(Duration::from_millis(100));
    assert!(elsewhere.accept().is_err(), "the redirect was followed");

    // A server that never answers: given up on at the limit, as unreachable.
    let silent = TcpListener::bind("127.0.0.1:0").unwrap();
    let silent_port = silent.local_addr().unwrap().port();
    let hold = std::thread::spawn(move || {
        let held = silent.accept();
        std::thread::sleep(Duration::from_millis(1_500));
        drop(held);
    });
    let quick = client(false, Duration::from_millis(400)).unwrap();
    let started = Instant::now();
    assert_eq!(
        post_once(
            &quick,
            &format!("http://127.0.0.1:{silent_port}/{A_CHANNEL}"),
            Line::Test.text()
        ),
        Outcome::Unreachable
    );
    assert!(started.elapsed() < Duration::from_millis(1_400));
    hold.join().unwrap();

    // The real sender's client is HTTPS only: plain HTTP is refused before anything is written.
    let plain = TcpListener::bind("127.0.0.1:0").unwrap();
    let plain_port = plain.local_addr().unwrap().port();
    plain.set_nonblocking(true).unwrap();
    let https_only = client(true, Duration::from_secs(2)).unwrap();
    assert_eq!(
        post_once(
            &https_only,
            &format!("http://127.0.0.1:{plain_port}/{A_CHANNEL}"),
            Line::Test.text()
        ),
        Outcome::Unreachable
    );
    assert!(plain.accept().is_err(), "plain HTTP reached the listener");
    assert_eq!(SEND_LIMIT, Duration::from_secs(10));
}

/// Really posts the test line to ntfy.sh, once. Run by hand only:
/// `cargo test --locked -- --ignored really_posts_the_test_line_to_ntfy_sh`. With
/// OZZIE_NTFY_TEST_CHANNEL set (in the environment, never on a command line) to a channel a phone is
/// subscribed to, the line shows there; otherwise a fresh random channel is used. Nothing is printed.
#[test]
#[ignore]
fn really_posts_the_test_line_to_ntfy_sh() {
    let dir = TempDir::new("live");
    let keychain = Arc::new(Keychain::default());
    let phone = PhoneNotice::new(
        dir.0.clone(),
        keychain.clone(),
        Arc::new(NtfyHttp::default()),
    );
    phone.turn_on().unwrap();
    if let Ok(chosen) = std::env::var("OZZIE_NTFY_TEST_CHANNEL") {
        assert!(
            channel_ok(&chosen),
            "OZZIE_NTFY_TEST_CHANNEL isn't a channel Ozzie makes"
        );
        keychain.plant(chosen.as_bytes());
    }
    assert_eq!(phone.send(Line::Test), Outcome::Accepted);
    phone.turn_off().unwrap();
}
