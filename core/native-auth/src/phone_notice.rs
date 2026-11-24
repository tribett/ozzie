//! A notice on the leader's own phone (owner decision 2026-11-16: "If free, do it now"). Off unless the
//! leader turns it on in Settings. While it's on, each time Ozzie sends a notice, the same fixed line
//! also goes to the leader's phone through ntfy.sh, a free service Ozzie doesn't run, whether or not
//! the Mac's own notifications show it: the leader installs the free ntfy app and subscribes to one
//! channel (ntfy calls it a topic), with no account.
//!
//! It rides on the Mac's notices and nothing else: the desktop app's two notice commands
//! (`notify_ozzie`, `notify_sunday_attention`) call `PhoneNotice::send` after showing theirs, so the
//! moments, quiet hours, kinds and the person's Church rules on notices are the page's existing gate,
//! unchanged (uncertain findings, Worth a look, bring no notice unless the person chose "Always tell
//! me right away" for that kind). The page can also say a notice stays on this Mac (one only about a
//! background check): it can take the phone line away, never add one. The only other send is the
//! leader's own "Send a test notice".
//!
//! What can leave this Mac, and only from here:
//!  - one HTTPS POST to exactly `https://ntfy.sh/<channel>` (`Request`), no proxy, no redirect
//!    followed, one attempt, given up after SEND_LIMIT, its answer's body never read;
//!  - its body: one sentence of the closed set `Line::text`, chosen here by the kind of notice. The
//!    Mac notices' own fixed words are reused (they hold no name, count, link or church detail);
//!    nothing the page, Planning Center or the leader wrote can reach it. Ozzie sets two headers, the
//!    title "Ozzie" (TITLE) and `content-type: text/plain; charset=utf-8`; the HTTP library adds only
//!    host, accept and content-length (pinned on the wire by a loopback test).
//!  - at most PER_HOUR of them in any hour by this Mac's clock while Ozzie is running, test notices
//!    included, so a runaway page can't flood the leader's phone or ntfy.sh; past that a phone notice
//!    is skipped and the Mac's still shows. Time asleep counts; a clock set back counts the earlier
//!    ones as just sent, so it never frees more.
//!
//! The channel is a secret-like value: `ozzie-` and 160 bits from the operating system's randomness,
//! in a typeable alphabet (`CHANNEL_ALPHABET`). It is kept only in this Mac's Keychain
//! (KEYCHAIN_SERVICE), checked against its grammar (`channel_ok`) before any request is built from
//! it, and never written to a file, the task record, a saved check or a log; `Debug` never shows it.
//! The page only receives it to show it with a Copy button. Anyone who learns it can read the lines
//! and post their own to the leader's phone, which is why it is long and random and "Make a new
//! channel" replaces it at any time. Whether this is on is a marker file beside Ozzie's other data
//! (ON_FILE, holding nothing), as for the copy shared with other AI apps (shared_check.rs): nothing is
//! read or sent while it's absent.
//!
//! Turning it off removes the marker first, at once, then forgets the channel; "Make a new channel"
//! replaces it. No Keychain read is ever made while holding the lock changes take, so turning off
//! never waits behind one (a Keychain dialog, say). A send reads the channel, then checks again just
//! before its POST that this is still on and that nothing changed meanwhile (`epoch`), so a read that
//! finishes after turning off, a new channel, or off and on again sends nothing: the old channel gets
//! nothing more, except a POST already on its way at that moment. Every start of the app forgets a
//! channel left behind while off.
//!
//! What became of the last phone notice (a closed `Outcome` and its time, never the channel) is kept
//! in memory for Settings, as `LastNotice`; it is forgotten when this is turned off, on, or given a
//! new channel, and when Ozzie quits. A send that ends after such a change (one held in its Keychain
//! read, or a POST already on its way) doesn't write it.
use crate::credentials::{CredentialStore, read_private};
use serde::Serialize;
use std::fs::OpenOptions;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use url::Url;
use zeroize::Zeroizing;

/// The one host anything here is sent to.
pub const HOST: &str = "ntfy.sh";
/// The notice's title on the phone, as on the Mac.
pub const TITLE: &str = "Ozzie";
pub const PREFIX: &str = "ozzie-";
/// Crockford's base 32 in lower case: no i, l, o or u, so a channel read off the screen is typed back
/// right. Each character carries 5 bits.
pub const CHANNEL_ALPHABET: &[u8; 32] = b"0123456789abcdefghjkmnpqrstvwxyz";
/// 20 random bytes: 160 bits, 32 characters, shown in 8 groups of 4.
pub const CHANNEL_BYTES: usize = 20;
const GROUPS: usize = 8;
const GROUP: usize = 4;
/// `ozzie-` + 8 groups of 4 joined by 7 dashes; ntfy allows up to 64 of [-_A-Za-z0-9].
pub const CHANNEL_LEN: usize = PREFIX.len() + GROUPS * GROUP + GROUPS - 1;
/// Present while the leader has this on. Holds no data.
pub const ON_FILE: &str = ".phone-notice.on";
/// Where the channel is kept in this Mac's Keychain: one item.
pub const KEYCHAIN_SERVICE: &str = crate::keychain_service!("church.ozzie.phone-notice.v1");
const KEYCHAIN_WORKSPACE: &str = "phone-notice";
const KEYCHAIN_ITEM: &str = "channel";
/// One attempt, given up after this long.
pub const SEND_LIMIT: Duration = Duration::from_secs(10);
const CONNECT_LIMIT: Duration = Duration::from_secs(5);
/// Most phone notices sent in any hour while Ozzie is running, test notices included.
pub const PER_HOUR: usize = 12;
const HOUR_MS: u64 = 3_600_000;

/// The closed set of lines a phone can receive: one per kind of notice Ozzie shows on this Mac, the
/// same fixed words (pinned to the desktop app's by its tests), and the leader's test notice.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Line {
    BriefingReady,
    NeedsDecision,
    Checked,
    CouldntCheck,
    SundayAttention,
    // The watched service's coverage, by its real day (onboarding spec §5.2, decision 18): nothing may call a
    // non-Sunday service "Sunday". The page passes the day as a closed word (`attention`), never text.
    MondayAttention,
    TuesdayAttention,
    WednesdayAttention,
    ThursdayAttention,
    FridayAttention,
    SaturdayAttention,
    WeekendAttention,
    ServiceAttention,
    Test,
}
impl Line {
    pub const ALL: [Line; 14] = [
        Line::BriefingReady,
        Line::NeedsDecision,
        Line::Checked,
        Line::CouldntCheck,
        Line::SundayAttention,
        Line::MondayAttention,
        Line::TuesdayAttention,
        Line::WednesdayAttention,
        Line::ThursdayAttention,
        Line::FridayAttention,
        Line::SaturdayAttention,
        Line::WeekendAttention,
        Line::ServiceAttention,
        Line::Test,
    ];
    /// The coverage line for the watched service's day: a weekday, "weekend" (times on Saturday and Sunday) or
    /// "service" (any other spread, or not known). Anything else has none.
    pub fn attention(day: &str) -> Option<Line> {
        Some(match day {
            "sunday" => Line::SundayAttention,
            "monday" => Line::MondayAttention,
            "tuesday" => Line::TuesdayAttention,
            "wednesday" => Line::WednesdayAttention,
            "thursday" => Line::ThursdayAttention,
            "friday" => Line::FridayAttention,
            "saturday" => Line::SaturdayAttention,
            "weekend" => Line::WeekendAttention,
            "service" => Line::ServiceAttention,
            _ => return None,
        })
    }
    pub fn text(self) -> &'static str {
        match self {
            Line::BriefingReady => "Your morning briefing is ready.",
            Line::NeedsDecision => {
                "Something Ozzie is keeping an eye on needs a decision. Open Ozzie to see it."
            }
            Line::Checked => {
                "Ozzie finished a check you asked for. Open Ozzie to see what it found."
            }
            Line::CouldntCheck => "Ozzie couldn't finish a check. Open Ozzie to see what happened.",
            Line::SundayAttention => "Sunday coverage needs attention. Open Ozzie to see details.",
            Line::MondayAttention => "Monday coverage needs attention. Open Ozzie to see details.",
            Line::TuesdayAttention => {
                "Tuesday coverage needs attention. Open Ozzie to see details."
            }
            Line::WednesdayAttention => {
                "Wednesday coverage needs attention. Open Ozzie to see details."
            }
            Line::ThursdayAttention => {
                "Thursday coverage needs attention. Open Ozzie to see details."
            }
            Line::FridayAttention => "Friday coverage needs attention. Open Ozzie to see details.",
            Line::SaturdayAttention => {
                "Saturday coverage needs attention. Open Ozzie to see details."
            }
            Line::WeekendAttention => {
                "This weekend's coverage needs attention. Open Ozzie to see details."
            }
            Line::ServiceAttention => {
                "Service coverage needs attention. Open Ozzie to see details."
            }
            Line::Test => "A test notice from Ozzie. Notices will reach this phone like this one.",
        }
    }
    /// The line for one of the four kinds the page names for `notify_ozzie` (always_on.rs
    /// `notice_body`); anything else has none.
    pub fn for_notice(kind: &str) -> Option<Line> {
        Some(match kind {
            "briefing-ready" => Line::BriefingReady,
            "needs-decision" => Line::NeedsDecision,
            "checked" => Line::Checked,
            "couldnt-check" => Line::CouldntCheck,
            _ => return None,
        })
    }
}

/// Whether `text` is a channel exactly as Ozzie makes them: `ozzie-`, then 8 groups of 4 characters
/// of CHANNEL_ALPHABET joined by dashes. Nothing else is ever put in a request.
pub fn channel_ok(text: &str) -> bool {
    let Some(rest) = text.strip_prefix(PREFIX) else {
        return false;
    };
    text.len() == CHANNEL_LEN
        && rest.split('-').count() == GROUPS
        && rest
            .split('-')
            .all(|g| g.len() == GROUP && g.bytes().all(|b| CHANNEL_ALPHABET.contains(&b)))
}

/// A channel that passed `channel_ok`. Its `Debug` never shows it.
pub struct Channel(Zeroizing<String>);
impl Channel {
    /// A stored value, only if it is exactly a channel.
    pub fn parse(bytes: &[u8]) -> Option<Self> {
        let text = std::str::from_utf8(bytes).ok()?;
        channel_ok(text).then(|| Self(Zeroizing::new(text.to_owned())))
    }
    /// A new channel from the operating system's randomness.
    pub fn random() -> Result<Self, PhoneError> {
        let mut random = Zeroizing::new([0u8; CHANNEL_BYTES]);
        getrandom::fill(random.as_mut()).map_err(|_| PhoneError::Unavailable)?;
        Ok(Self::from_random(&random))
    }
    /// The 160 bits as 32 characters of 5 bits each, most significant first.
    fn from_random(random: &[u8; CHANNEL_BYTES]) -> Self {
        let mut text = Zeroizing::new(String::with_capacity(CHANNEL_LEN));
        text.push_str(PREFIX);
        let (mut bits, mut held) = (0u32, 0u32);
        let mut written = 0;
        for byte in random {
            bits = (bits << 8) | u32::from(*byte);
            held += 8;
            while held >= 5 {
                held -= 5;
                if written > 0 && written % GROUP == 0 {
                    text.push('-');
                }
                text.push(char::from(CHANNEL_ALPHABET[((bits >> held) & 31) as usize]));
                written += 1;
            }
            bits &= (1 << held) - 1;
        }
        Self(text)
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
impl std::fmt::Debug for Channel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Channel(hidden)")
    }
}

/// The one request: built only here, from a checked channel and a line of the closed set, so its
/// host, path, title and body are always these. Its `Debug` never shows the channel.
pub struct Request {
    url: Url,
    line: Line,
}
impl Request {
    fn new(channel: &Channel, line: Line) -> Option<Self> {
        let url = Url::parse(&format!("https://{HOST}/{}", channel.as_str())).ok()?;
        let request = Self { url, line };
        request_ok(&request).then_some(request)
    }
    pub fn url(&self) -> &Url {
        &self.url
    }
    pub fn title(&self) -> &'static str {
        TITLE
    }
    pub fn body(&self) -> &'static str {
        self.line.text()
    }
    pub fn line(&self) -> Line {
        self.line
    }
}
impl std::fmt::Debug for Request {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Request(https://{HOST}/<hidden>, {:?})", self.line)
    }
}
/// The shape every request must have before it goes: `https://ntfy.sh/<channel>` exactly, with no
/// port, user, query or fragment.
pub fn request_ok(request: &Request) -> bool {
    let url = &request.url;
    url.scheme() == "https"
        && url.host_str() == Some(HOST)
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && url.path().strip_prefix('/').is_some_and(channel_ok)
}

/// What became of one phone notice: closed codes, said plainly by the page.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Outcome {
    /// ntfy.sh answered with success: sent.
    Accepted,
    /// ntfy.sh answered, but not with success (a limit, a redirect, an error).
    Refused,
    /// ntfy.sh couldn't be reached in time.
    Unreachable,
    /// Turned off (before the send, or while it read the channel): nothing was sent.
    Off,
    /// The channel couldn't be read, isn't one Ozzie makes, or was replaced while it was read:
    /// nothing was sent.
    Unavailable,
    /// PER_HOUR already went out in the last hour: nothing was sent.
    TooMany,
}

/// What became of the last phone notice, and when (`at_ms`: milliseconds since 1970 by this Mac's
/// clock). In memory only; it never holds the channel.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct LastNotice {
    pub outcome: Outcome,
    pub at_ms: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PhoneError {
    /// Making a new channel needs this turned on.
    Off,
    /// The Keychain or the app's data folder couldn't be written or cleared, or no randomness.
    Unavailable,
}

/// What Settings shows: whether it's on, the channel to subscribe to (none while off, or when it
/// couldn't be read), and what became of the last phone notice (none while off). `Debug` never shows
/// the channel.
#[derive(Serialize)]
pub struct PhoneView {
    pub on: bool,
    pub channel: Option<String>,
    pub last: Option<LastNotice>,
}
impl std::fmt::Debug for PhoneView {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let channel = if self.channel.is_some() {
            "hidden"
        } else {
            "none"
        };
        write!(
            f,
            "PhoneView {{ on: {}, channel: {channel}, last: {:?} }}",
            self.on, self.last
        )
    }
}

/// Sends one request. The real one is `NtfyHttp`; tests use a stand-in that never reaches a network.
pub trait Post: Send + Sync {
    fn post(&self, request: &Request) -> Outcome;
}

/// HTTPS only, through rustls, no system proxy, no redirect followed, no referer.
fn client(https_only: bool, limit: Duration) -> Option<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .https_only(https_only)
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .referer(false)
        .connect_timeout(CONNECT_LIMIT.min(limit))
        .timeout(limit)
        .build()
        .ok()
}
/// POSTs `body` with the title to `url` once. Success is a 2xx answer; its body is never read.
fn post_once(client: &reqwest::blocking::Client, url: &str, body: &'static str) -> Outcome {
    let sent = client
        .post(url)
        .header("Title", TITLE)
        .header(reqwest::header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(body)
        .send();
    match sent {
        Ok(answer) if answer.status().is_success() => Outcome::Accepted,
        Ok(_) => Outcome::Refused,
        Err(_) => Outcome::Unreachable,
    }
}

/// The real sender: checks the request's shape, then `send` makes the one POST (`https_post`, a new
/// client for each notice, on its own thread, never on the app's async runtime). Tests put a stand-in
/// in `send`'s place that fails the test if reached, so the check is exercised without a network.
pub struct NtfyHttp {
    send: fn(&str, &'static str) -> Outcome,
}
impl Default for NtfyHttp {
    fn default() -> Self {
        Self { send: https_post }
    }
}
fn https_post(url: &str, body: &'static str) -> Outcome {
    match client(true, SEND_LIMIT) {
        Some(client) => post_once(&client, url, body),
        None => Outcome::Unavailable,
    }
}
impl Post for NtfyHttp {
    fn post(&self, request: &Request) -> Outcome {
        if !request_ok(request) {
            return Outcome::Unavailable;
        }
        (self.send)(request.url().as_str(), request.body())
    }
}

type Clock = Box<dyn Fn() -> u64 + Send + Sync>;

/// This Mac's clock, in milliseconds since 1970 (0 if it is set before then).
pub fn wall_clock() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

/// The phone notice for this Mac: the marker in `dir`, the channel in `store`, sent through `post`.
pub struct PhoneNotice {
    dir: PathBuf,
    store: Arc<dyn CredentialStore>,
    post: Arc<dyn Post>,
    /// Milliseconds by this Mac's clock (`wall_clock` in the app), which may be set back.
    clock: Clock,
    /// When each recent phone notice went (for PER_HOUR).
    sent: Mutex<Vec<u64>>,
    /// What became of the last phone notice, while on.
    last: Mutex<Option<LastNotice>>,
    /// Moves on with every change of channel or of on and off: a send whose channel was read before a
    /// change sends nothing.
    epoch: AtomicU64,
    /// One change (on, off, new channel, start-up clean-up) at a time. Never held across a Keychain
    /// read, so nothing waits behind one.
    lock: Mutex<()>,
}
impl PhoneNotice {
    pub fn new(dir: PathBuf, store: Arc<dyn CredentialStore>, post: Arc<dyn Post>) -> Self {
        Self::with_clock(dir, store, post, Box::new(wall_clock))
    }
    fn with_clock(
        dir: PathBuf,
        store: Arc<dyn CredentialStore>,
        post: Arc<dyn Post>,
        clock: Clock,
    ) -> Self {
        Self {
            dir,
            store,
            post,
            clock,
            sent: Mutex::new(Vec::new()),
            last: Mutex::new(None),
            epoch: AtomicU64::new(0),
            lock: Mutex::new(()),
        }
    }
    fn locked(&self) -> MutexGuard<'_, ()> {
        self.lock.lock().unwrap_or_else(|e| e.into_inner())
    }
    fn last_slot(&self) -> MutexGuard<'_, Option<LastNotice>> {
        self.last.lock().unwrap_or_else(|e| e.into_inner())
    }
    /// A change of channel or of on and off: a send that read the channel before it sends nothing.
    fn changed(&self) {
        self.epoch.fetch_add(1, Ordering::SeqCst);
    }

    /// Whether it's on: the marker is a regular file (never a link).
    pub fn is_on(&self) -> bool {
        std::fs::symlink_metadata(self.dir.join(ON_FILE)).is_ok_and(|m| m.file_type().is_file())
    }
    /// The kept channel, only if it is exactly one Ozzie makes. Never called holding `lock`.
    fn stored(&self) -> Option<Channel> {
        let secret = read_private(&*self.store, KEYCHAIN_WORKSPACE, KEYCHAIN_ITEM).ok()??;
        Channel::parse(&secret)
    }
    fn view(&self, on: bool, channel: Option<&Channel>) -> PhoneView {
        PhoneView {
            on,
            channel: channel.map(|c| c.as_str().to_owned()),
            last: if on { *self.last_slot() } else { None },
        }
    }

    /// For Settings. Off reads nothing from the Keychain.
    pub fn status(&self) -> PhoneView {
        if !self.is_on() {
            return self.view(false, None);
        }
        self.view(true, self.stored().as_ref())
    }

    /// Turning it on: a new channel goes to the Keychain, then the marker is written (0600). Already on
    /// with a channel that reads back: that one stays.
    pub fn turn_on(&self) -> Result<PhoneView, PhoneError> {
        if self.is_on()
            && let Some(channel) = self.stored()
        {
            return Ok(self.view(true, Some(&channel)));
        }
        let _guard = self.locked();
        let channel = self.replace_channel()?;
        if write_marker(&self.dir).is_err() {
            let _ = self.store.delete(KEYCHAIN_WORKSPACE, KEYCHAIN_ITEM);
            return Err(PhoneError::Unavailable);
        }
        Ok(self.view(true, Some(&channel)))
    }

    /// "Make a new channel": replaces the kept one, so the old one gets nothing more. Only while on.
    pub fn new_channel(&self) -> Result<PhoneView, PhoneError> {
        let _guard = self.locked();
        if !self.is_on() {
            return Err(PhoneError::Off);
        }
        let channel = self.replace_channel()?;
        Ok(self.view(true, Some(&channel)))
    }
    /// A new channel in the Keychain, then a change, so a send that read the old one sends nothing;
    /// the last notice was about the old one, so it is forgotten.
    fn replace_channel(&self) -> Result<Channel, PhoneError> {
        let channel = Channel::random()?;
        self.store
            .put(
                KEYCHAIN_WORKSPACE,
                KEYCHAIN_ITEM,
                channel.as_str().as_bytes(),
            )
            .map_err(|_| PhoneError::Unavailable)?;
        self.changed();
        *self.last_slot() = None;
        Ok(channel)
    }

    /// Turning it off: removes the marker first, at once and without waiting for anything else (so
    /// nothing more is sent), then forgets the channel, each tried whatever happened to the other.
    /// Already gone is fine.
    pub fn turn_off(&self) -> Result<(), PhoneError> {
        let first = remove_marker(&self.dir);
        self.changed();
        *self.last_slot() = None;
        let _guard = self.locked();
        // Again under the lock: off wins over a turning on that was under way.
        let marker = first.and(remove_marker(&self.dir));
        self.changed();
        let forgotten = self
            .store
            .delete(KEYCHAIN_WORKSPACE, KEYCHAIN_ITEM)
            .map_err(|_| PhoneError::Unavailable);
        marker.and(forgotten)
    }

    /// At every start of the app: while off, a channel left behind (a failed removal, a crash) is
    /// forgotten.
    pub fn startup(&self) -> Result<(), PhoneError> {
        let _guard = self.locked();
        if self.is_on() {
            return Ok(());
        }
        self.store
            .delete(KEYCHAIN_WORKSPACE, KEYCHAIN_ITEM)
            .map_err(|_| PhoneError::Unavailable)
    }

    /// One phone notice with `line`, while on: one attempt, never retried. Off reads nothing.
    pub fn send(&self, line: Line) -> Outcome {
        self.send_noted(line).outcome
    }
    /// `send`, and what became of it and when, as Settings shows it. Kept as the last notice only if
    /// nothing changed while it ran: not when it was off from the start (nothing at all happened), and
    /// not when a new channel, turning off, or off and on again came meanwhile, since Settings then
    /// shows the new state and this send was about the old one.
    pub fn send_noted(&self, line: Line) -> LastNotice {
        let at_ms = (self.clock)();
        let epoch = self.epoch.load(Ordering::SeqCst);
        let noted = |outcome| {
            let last = LastNotice { outcome, at_ms };
            // Checked under the record's lock: a change moves `epoch` on before it clears the record,
            // so a change either comes before this check (nothing kept) or clears what was kept.
            let mut slot = self.last_slot();
            if self.epoch.load(Ordering::SeqCst) == epoch {
                *slot = Some(last);
            }
            last
        };
        if !self.is_on() {
            return LastNotice {
                outcome: Outcome::Off,
                at_ms,
            };
        }
        let Some(request) = self.stored().and_then(|c| Request::new(&c, line)) else {
            return noted(Outcome::Unavailable);
        };
        // Checked again after the Keychain read, just before the POST: turned off meanwhile, or the
        // channel changed (a new one, or off and on again), sends nothing to the channel read.
        if !self.is_on() {
            return noted(Outcome::Off);
        }
        if self.epoch.load(Ordering::SeqCst) != epoch {
            return noted(Outcome::Unavailable);
        }
        if !self.take_turn(at_ms) {
            return noted(Outcome::TooMany);
        }
        noted(self.post.post(&request))
    }
    /// Counts this notice against PER_HOUR, or says the hour's are used up. By this Mac's clock, so an
    /// hour asleep counts; one sent "later" than `now` (the clock was set back) counts as sent now.
    fn take_turn(&self, now: u64) -> bool {
        let mut sent = self.sent.lock().unwrap_or_else(|e| e.into_inner());
        for at in sent.iter_mut() {
            *at = (*at).min(now);
        }
        sent.retain(|at| now - *at < HOUR_MS);
        if sent.len() >= PER_HOUR {
            return false;
        }
        sent.push(now);
        true
    }
}

fn write_marker(dir: &Path) -> io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(dir)?;
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options.open(dir.join(ON_FILE))?.sync_all()
}
fn remove_marker(dir: &Path) -> Result<(), PhoneError> {
    match std::fs::remove_file(dir.join(ON_FILE)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(PhoneError::Unavailable),
    }
}

#[cfg(test)]
#[path = "phone_notice_tests.rs"]
mod tests;
