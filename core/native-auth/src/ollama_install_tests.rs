//! Getting Ollama, over fakes: an in-memory download and a real HTTP listener on this Mac's loopback (no internet),
//! archives made here byte by byte, a verifier that says what each test needs, an opener and an Ollama server that
//! answer as told. Apple's own unzip unpacks the archives, as in the app; the real verifier is tried on bundles made
//! here and on a system app, and on the real Ollama app only when a path is given (`OZZIE_OLLAMA_APP`, ignored by
//! default). Nothing here runs a downloaded program.
use super::*;
use crate::local_ai::{App, AppFound, Failure, LocalFind};
use std::io::{BufRead, BufReader};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::AtomicUsize;
use std::sync::{Arc, Mutex};

// ---- Scratch folders ----------------------------------------------------------------------------------------------

/// A scratch folder standing in for Ozzie's caches, its data folder and /Applications.
struct Scratch(PathBuf);
impl Scratch {
    fn new(name: &str) -> Self {
        static N: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "ozzie-ollama-{}-{}-{name}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        for sub in ["caches", "data", "Applications", "outside"] {
            std::fs::create_dir_all(dir.join(sub)).unwrap();
        }
        Self(dir)
    }
    fn caches(&self) -> PathBuf {
        self.0.join("caches")
    }
    fn data(&self) -> PathBuf {
        self.0.join("data")
    }
    fn apps(&self) -> PathBuf {
        self.0.join("Applications")
    }
    fn outside(&self) -> PathBuf {
        self.0.join("outside")
    }
    /// Whatever is left of Ozzie's work: names under `ollama-install`.
    fn left(&self) -> Vec<String> {
        let root = self.caches().join(WORK_FOLDER);
        let mut names: Vec<String> = std::fs::read_dir(&root)
            .map(|r| r.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect())
            .unwrap_or_default();
        names.sort();
        names
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::set_permissions(self.apps(), std::fs::Permissions::from_mode(0o755));
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// What Ozzie's folder holds after a job that left nothing: its lock file only.
const LEFT_NOTHING: [&str; 1] = [".lock"];

// ---- Archives made here -------------------------------------------------------------------------------------------

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &b in data {
        crc ^= u32::from(b);
        for _ in 0..8 {
            crc = if crc & 1 != 0 { (crc >> 1) ^ 0xEDB8_8320 } else { crc >> 1 };
        }
    }
    !crc
}
#[derive(Clone)]
struct Entry {
    name: String,
    mode: u32,
    data: Vec<u8>,
}
fn folder(name: &str) -> Entry {
    Entry {
        name: name.into(),
        mode: 0o040755,
        data: vec![],
    }
}
fn file(name: &str, data: &str) -> Entry {
    Entry {
        name: name.into(),
        mode: 0o100644,
        data: data.as_bytes().to_vec(),
    }
}
fn link(name: &str, target: &str) -> Entry {
    Entry {
        name: name.into(),
        mode: 0o120755,
        data: target.as_bytes().to_vec(),
    }
}
/// How an archive is spoiled after it is laid out.
#[derive(Clone, Copy, Default)]
struct Spoil {
    /// A local header the central directory doesn't name, before the directory.
    hidden_entry: bool,
    /// The first local header names another file than the directory does.
    local_name: bool,
    /// Made on a system other than Unix (its modes say nothing).
    not_unix: bool,
    /// The encryption flag.
    encrypted: bool,
    /// One extra field of this id (4 bytes of data) on every entry, in both headers.
    extra: u16,
    /// A data descriptor's flag on stored entries.
    stored_descriptor: bool,
}
/// A stored (uncompressed) zip, laid out as a zip tool lays it out.
fn zip_bytes(entries: &[Entry], spoil: Spoil) -> Vec<u8> {
    let mut out = Vec::new();
    let mut central = Vec::new();
    let flags: u16 = if spoil.encrypted { 1 } else if spoil.stored_descriptor { 0b1000 } else { 0 };
    let extra: Vec<u8> = if spoil.extra == 0 { vec![] } else { [spoil.extra.to_le_bytes().as_slice(), &4u16.to_le_bytes(), &[0, 0, 0, 0]].concat() };
    for (i, e) in entries.iter().enumerate() {
        let offset = out.len() as u32;
        let crc = crc32(&e.data);
        let size = e.data.len() as u32;
        let local_name = if spoil.local_name && i == 1 { e.name.replace("Contents", "Kontents") } else { e.name.clone() };
        out.extend(0x0403_4b50u32.to_le_bytes());
        out.extend(20u16.to_le_bytes());
        out.extend(flags.to_le_bytes());
        out.extend(0u16.to_le_bytes()); // stored
        out.extend([0u8; 4]); // time, date
        // With a data descriptor, the local header leaves the sizes to it (zero), as zip tools write it.
        let local_sizes = if spoil.stored_descriptor { [0u32; 3] } else { [crc, size, size] };
        for v in local_sizes {
            out.extend(v.to_le_bytes());
        }
        out.extend((local_name.len() as u16).to_le_bytes());
        out.extend((extra.len() as u16).to_le_bytes());
        out.extend(local_name.as_bytes());
        out.extend(&extra);
        out.extend(&e.data);
        if spoil.stored_descriptor {
            for v in [0x0807_4b50u32, crc, size, size] {
                out.extend(v.to_le_bytes());
            }
        }
        let made_by: u16 = if spoil.not_unix { 20 } else { (3 << 8) | 20 };
        central.extend(0x0201_4b50u32.to_le_bytes());
        central.extend(made_by.to_le_bytes());
        central.extend(20u16.to_le_bytes());
        central.extend(flags.to_le_bytes());
        central.extend(0u16.to_le_bytes());
        central.extend([0u8; 4]);
        central.extend(crc.to_le_bytes());
        central.extend(size.to_le_bytes());
        central.extend(size.to_le_bytes());
        central.extend((e.name.len() as u16).to_le_bytes());
        central.extend((extra.len() as u16).to_le_bytes());
        central.extend([0u8; 6]); // comment, disk, internal
        central.extend((e.mode << 16).to_le_bytes());
        central.extend(offset.to_le_bytes());
        central.extend(e.name.as_bytes());
        central.extend(&extra);
    }
    if spoil.hidden_entry {
        let name = "Ollama.app/Contents/../../../hidden";
        out.extend(0x0403_4b50u32.to_le_bytes());
        out.extend(20u16.to_le_bytes());
        out.extend([0u8; 8]);
        out.extend(crc32(b"x").to_le_bytes());
        out.extend(1u32.to_le_bytes());
        out.extend(1u32.to_le_bytes());
        out.extend((name.len() as u16).to_le_bytes());
        out.extend(0u16.to_le_bytes());
        out.extend(name.as_bytes());
        out.push(b'x');
    }
    let cd_at = out.len() as u32;
    let cd_size = central.len() as u32;
    out.extend(central);
    out.extend(0x0605_4b50u32.to_le_bytes());
    out.extend([0u8; 4]);
    out.extend((entries.len() as u16).to_le_bytes());
    out.extend((entries.len() as u16).to_le_bytes());
    out.extend(cd_size.to_le_bytes());
    out.extend(cd_at.to_le_bytes());
    out.extend(0u16.to_le_bytes());
    out
}
/// A small app laid out as Ollama's is: folders, an executable, a framework with Squirrel's own links (one reached
/// through another). It is never run.
fn app_entries() -> Vec<Entry> {
    vec![
        folder("Ollama.app/"),
        folder("Ollama.app/Contents/"),
        file("Ollama.app/Contents/Info.plist", "<plist>fictional</plist>\n"),
        folder("Ollama.app/Contents/MacOS/"),
        Entry {
            name: "Ollama.app/Contents/MacOS/Ollama".into(),
            mode: 0o100755,
            data: b"#!/bin/sh\nexit 1\n".to_vec(),
        },
        folder("Ollama.app/Contents/Frameworks/S.framework/Versions/A/Resources/"),
        file("Ollama.app/Contents/Frameworks/S.framework/Versions/A/S", "fictional"),
        link("Ollama.app/Contents/Frameworks/S.framework/Versions/A/Resources/ShipIt", "../S"),
        link("Ollama.app/Contents/Frameworks/S.framework/Versions/Current", "A"),
        link("Ollama.app/Contents/Frameworks/S.framework/S", "Versions/Current/S"),
        link("Ollama.app/Contents/Frameworks/S.framework/Resources", "Versions/Current/Resources"),
        file("Ollama.app/Contents/Resources/libx.0.1.dylib", "fictional"),
        link("Ollama.app/Contents/Resources/libx.dylib", "libx.0.1.dylib"),
    ]
}
fn app_zip() -> Vec<u8> {
    zip_bytes(&app_entries(), Spoil::default())
}
/// `check_zip` on these bytes.
fn read_zip(bytes: &[u8]) -> Option<Plan> {
    let s = Scratch::new("zip");
    let path = s.0.join("a.zip");
    std::fs::write(&path, bytes).unwrap();
    check_zip(&path)
}
/// The app's entries with one more, or one changed.
fn with(extra: Entry) -> Vec<u8> {
    let mut entries = app_entries();
    entries.push(extra);
    zip_bytes(&entries, Spoil::default())
}

// ---- A download in memory -----------------------------------------------------------------------------------------

/// One scripted answer.
#[derive(Clone)]
enum Answer {
    Redirect(String),
    /// A 200 with this size said (None: no size) and these bytes, then quiet for `quiet` polls.
    Body { length: Option<u64>, bytes: Vec<u8>, quiet: usize },
    Status(u16),
    Unreachable,
}
/// The internet as the download sees it: an answer per address, and every address asked.
struct FakeNet {
    answers: BTreeMap<String, Answer>,
    asked: Mutex<Vec<String>>,
    /// Bytes handed to the download before it closed.
    given: Mutex<u64>,
}
impl FakeNet {
    fn new(answers: &[(&str, Answer)]) -> Self {
        Self {
            answers: answers.iter().map(|(u, a)| ((*u).into(), a.clone())).collect(),
            asked: Mutex::new(vec![]),
            given: Mutex::new(0),
        }
    }
    /// The real chain's shape, with this archive at its end.
    fn official(archive: Vec<u8>) -> Self {
        let length = archive.len() as u64;
        Self::new(&[
            (DOWNLOAD_URL, Answer::Redirect("https://github.com/ollama/ollama/releases/latest/download/Ollama-darwin.zip".into())),
            (
                "https://github.com/ollama/ollama/releases/latest/download/Ollama-darwin.zip",
                Answer::Redirect("https://github.com/ollama/ollama/releases/download/v0.40.16/Ollama-darwin.zip".into()),
            ),
            (
                "https://github.com/ollama/ollama/releases/download/v0.40.16/Ollama-darwin.zip",
                Answer::Redirect("https://release-assets.githubusercontent.com/github-production-release-asset/658928958/fictional".into()),
            ),
            (
                "https://release-assets.githubusercontent.com/github-production-release-asset/658928958/fictional",
                Answer::Body { length: Some(length), bytes: archive, quiet: 0 },
            ),
        ])
    }
}
impl Fetch for FakeNet {
    fn get(&self, url: &url::Url, heard: &mut dyn FnMut(Heard<'_>) -> bool) -> Result<(), FetchFailure> {
        self.asked.lock().unwrap().push(url.to_string());
        match self.answers.get(url.as_str()).cloned().unwrap_or(Answer::Status(404)) {
            Answer::Redirect(to) => {
                heard(Heard::Head(&Head { status: 302, location: Some(to), length: Some(0) }));
                Ok(())
            }
            Answer::Status(status) => {
                heard(Heard::Head(&Head { status, location: None, length: Some(0) }));
                Ok(())
            }
            Answer::Unreachable => Err(FetchFailure::Unreachable),
            Answer::Body { length, bytes, quiet } => {
                if !heard(Heard::Head(&Head { status: 200, location: None, length })) {
                    return Ok(());
                }
                for piece in bytes.chunks(64) {
                    if !heard(Heard::Bytes(piece)) {
                        return Ok(());
                    }
                    *self.given.lock().unwrap() += piece.len() as u64;
                }
                for _ in 0..quiet {
                    std::thread::sleep(Duration::from_millis(20));
                    if !heard(Heard::Quiet) {
                        return Ok(());
                    }
                }
                Ok(())
            }
        }
    }
}

// ---- A verifier, an opener and Ollama's server, as told -----------------------------------------------------------

/// Says each verification's outcome in turn (then passes), and keeps the paths it was asked about.
#[derive(Default)]
struct SaysVerifier {
    outcomes: Mutex<Vec<Result<(), Rejected>>>,
    asked: Mutex<Vec<PathBuf>>,
}
impl SaysVerifier {
    fn saying(outcomes: &[Result<(), Rejected>]) -> Self {
        Self {
            outcomes: Mutex::new(outcomes.iter().rev().cloned().collect()),
            asked: Mutex::new(vec![]),
        }
    }
}
impl Verifier for SaysVerifier {
    fn verify(&self, app: &Path) -> Result<(), Rejected> {
        self.asked.lock().unwrap().push(app.to_path_buf());
        self.outcomes.lock().unwrap().pop().unwrap_or(Ok(()))
    }
}
#[derive(Default)]
struct Opens {
    fails: bool,
    opened: Mutex<Vec<PathBuf>>,
}
impl Opener for Opens {
    fn open(&self, app: &Path) -> bool {
        self.opened.lock().unwrap().push(app.to_path_buf());
        !self.fails
    }
}
/// Ollama's server on this Mac: answers after `after` asks, or never.
struct Server {
    after: Option<usize>,
    asked: AtomicUsize,
}
impl Server {
    fn answering_after(n: usize) -> Self {
        Self { after: Some(n), asked: AtomicUsize::new(0) }
    }
    fn never() -> Self {
        Self { after: None, asked: AtomicUsize::new(0) }
    }
}
impl LocalHttp for Server {
    fn get(&self, url: &str, _wait: Duration) -> Result<(u16, Vec<u8>), Failure> {
        assert_eq!(url, "http://127.0.0.1:11434/api/version");
        let n = self.asked.fetch_add(1, Ordering::SeqCst);
        match self.after {
            Some(after) if n >= after => Ok((200, br#"{"version":"0.40.16"}"#.to_vec())),
            _ => Err(Failure::Unreachable),
        }
    }
    fn post(&self, _: &str, _: &[u8], _: Duration) -> Result<(u16, Vec<u8>), Failure> {
        panic!("getting Ollama never posts to it")
    }
    fn delete(&self, _: &str, _: &[u8], _: Duration) -> Result<(u16, Vec<u8>), Failure> {
        panic!("getting Ollama never deletes anything in it")
    }
}
const FAST: Waits = Waits {
    stall: Duration::from_millis(300),
    download: Duration::from_secs(30),
    server: Duration::from_millis(400),
    still_starting: Duration::from_millis(100),
    poll: Duration::from_millis(20),
};
/// One job over these fakes, with real unzip unless `unpack` says otherwise; the progress it told, and how it ended.
struct Ran {
    told: Vec<Progress>,
    ended: Progress,
}
fn run_job(s: &Scratch, net: &dyn Fetch, verifier: &dyn Verifier, opener: &dyn Opener, server: &dyn LocalHttp, cancel: &AtomicBool) -> Ran {
    run_with(s, net, &Policy::official(), &Unzip, verifier, opener, server, cancel, &|_| Some(u64::MAX / 4))
}
#[allow(clippy::too_many_arguments)]
fn run_with(
    s: &Scratch,
    net: &dyn Fetch,
    policy: &Policy,
    unpack: &dyn Unpack,
    verifier: &dyn Verifier,
    opener: &dyn Opener,
    server: &dyn LocalHttp,
    cancel: &AtomicBool,
    free: &dyn Fn(&Path) -> Option<u64>,
) -> Ran {
    let (caches, data, apps) = (s.caches(), s.data(), s.apps());
    let job = Job {
        caches: &caches,
        data: &data,
        destination: &apps,
        policy,
        fetch: net,
        unpack,
        verifier,
        opener,
        http: server,
        free,
        cancel,
        clock: &|| 1_763_500_000_000,
        waits: FAST,
    };
    let mut told = vec![];
    let ended = run(&job, &mut |p| told.push(p.clone()));
    Ran { told, ended }
}
fn no_cancel() -> AtomicBool {
    AtomicBool::new(false)
}

// ---- The policy ---------------------------------------------------------------------------------------------------

#[test]
fn the_download_starts_at_ollamas_own_address_and_passes_only_its_three_hosts_over_https() {
    let p = Policy::official();
    assert_eq!(p.start, "https://ollama.com/download/Ollama-darwin.zip");
    assert!(p.https_only);
    assert_eq!(p.hosts, ["ollama.com", "github.com", "release-assets.githubusercontent.com"]);
    let ok = |u: &str| p.allows(&url::Url::parse(u).unwrap());
    // The real chain (2026-11-18).
    for u in [
        DOWNLOAD_URL,
        "https://github.com/ollama/ollama/releases/latest/download/Ollama-darwin.zip",
        "https://github.com/ollama/ollama/releases/download/v0.40.16/Ollama-darwin.zip",
        "https://release-assets.githubusercontent.com/github-production-release-asset/658928958/3416bdbe?sig=x",
    ] {
        assert!(ok(u), "{u}");
    }
    for u in [
        "http://ollama.com/download/Ollama-darwin.zip",
        "http://release-assets.githubusercontent.com/x",
        "https://ollama.com.example.org/download/Ollama-darwin.zip",
        "https://example.org/ollama.com/download/Ollama-darwin.zip",
        "https://evil.example/download/Ollama-darwin.zip",
        "https://objects.githubusercontent.com/x",
        "https://github.com/someone-else/ollama/releases/download/v1/Ollama-darwin.zip",
        "https://github.com/ollama/ollama/archive/main.zip",
        "https://ollama.com/install.sh",
        "https://user@ollama.com/download/Ollama-darwin.zip",
        "https://ollama.com:8443/download/Ollama-darwin.zip",
        "https://140.82.112.3/ollama/ollama/releases/x",
        "file:///etc/passwd",
    ] {
        assert!(!ok(u), "{u}");
    }
    // A relative redirect is read against where it came from, and checked like any other.
    let from = url::Url::parse("https://github.com/ollama/ollama/releases/latest/download/Ollama-darwin.zip").unwrap();
    assert_eq!(
        p.next(&from, "/ollama/ollama/releases/download/v0.40.16/Ollama-darwin.zip").map(|u| u.to_string()).as_deref(),
        Some("https://github.com/ollama/ollama/releases/download/v0.40.16/Ollama-darwin.zip")
    );
    assert_eq!(p.next(&from, "/someone/else"), None);
    assert_eq!(p.next(&from, "//evil.example/x"), None);
}

#[test]
fn a_redirect_off_the_list_is_refused_and_nothing_is_downloaded_or_kept() {
    for (to, why) in [
        ("https://evil.example/Ollama-darwin.zip", "another host"),
        ("http://github.com/ollama/ollama/releases/download/v0.40.16/Ollama-darwin.zip", "not https"),
        ("https://github.com/attacker/ollama/releases/download/v0.40.16/Ollama-darwin.zip", "not Ollama's releases"),
    ] {
        let s = Scratch::new("redirect");
        let net = FakeNet::new(&[
            (DOWNLOAD_URL, Answer::Redirect(to.into())),
            (to, Answer::Body { length: Some(app_zip().len() as u64), bytes: app_zip(), quiet: 0 }),
        ]);
        let verifier = SaysVerifier::default();
        let ran = run_job(&s, &net, &verifier, &Opens::default(), &Server::answering_after(0), &no_cancel());
        assert_eq!(ran.ended.end, Some(End::Redirected), "{why}");
        // The address off the list was never asked; nothing was checked, installed, or left.
        assert_eq!(*net.asked.lock().unwrap(), [DOWNLOAD_URL], "{why}");
        assert!(verifier.asked.lock().unwrap().is_empty());
        assert!(std::fs::read_dir(s.apps()).unwrap().next().is_none());
        assert_eq!(s.left(), LEFT_NOTHING, "{why}");
        assert_eq!(history(&s.data()).last().map(|d| d.end), Some(End::Redirected));
    }
    // More redirects than the real chain could need.
    let s = Scratch::new("loop");
    let a = "https://github.com/ollama/ollama/releases/a";
    let b = "https://github.com/ollama/ollama/releases/b";
    let net = FakeNet::new(&[(DOWNLOAD_URL, Answer::Redirect(a.into())), (a, Answer::Redirect(b.into())), (b, Answer::Redirect(a.into()))]);
    let ran = run_job(&s, &net, &SaysVerifier::default(), &Opens::default(), &Server::answering_after(0), &no_cancel());
    assert_eq!(ran.ended.end, Some(End::Redirected));
    assert_eq!(net.asked.lock().unwrap().len(), MAX_REDIRECTS + 1);
}

#[test]
fn an_oversize_or_unsized_download_is_refused_and_deleted() {
    let at = "https://release-assets.githubusercontent.com/x";
    let cases = [
        // Said too large: refused before any byte.
        (Answer::Body { length: Some(MAX_DOWNLOAD_BYTES + 1), bytes: vec![0; 10], quiet: 0 }, End::TooLarge, 0),
        // Brought more than it said.
        (Answer::Body { length: Some(100), bytes: vec![7; 1000], quiet: 0 }, End::TooLarge, 64),
        // Said no size.
        (Answer::Body { length: None, bytes: vec![7; 100], quiet: 0 }, End::DownloadFailed, 0),
        // Brought less than it said.
        (Answer::Body { length: Some(1000), bytes: vec![7; 100], quiet: 0 }, End::DownloadFailed, 100),
        (Answer::Status(404), End::DownloadFailed, 0),
        (Answer::Unreachable, End::Offline, 0),
    ];
    for (answer, end, given) in cases {
        let s = Scratch::new("size");
        let net = FakeNet::new(&[(DOWNLOAD_URL, Answer::Redirect(at.into())), (at, answer)]);
        let ran = run_job(&s, &net, &SaysVerifier::default(), &Opens::default(), &Server::answering_after(0), &no_cancel());
        assert_eq!(ran.ended.end, Some(end));
        assert_eq!(*net.given.lock().unwrap(), given, "{end:?}");
        assert_eq!(s.left(), LEFT_NOTHING, "{end:?}");
    }
    // Not enough free space for the archive and the app: refused before any byte.
    let s = Scratch::new("room");
    let net = FakeNet::official(app_zip());
    let ran = run_with(&s, &net, &Policy::official(), &Unzip, &SaysVerifier::default(), &Opens::default(), &Server::answering_after(0), &no_cancel(), &|_| Some(1_000));
    assert_eq!(ran.ended.end, Some(End::NoRoom));
    assert_eq!(*net.given.lock().unwrap(), 0);
    assert_eq!(room_needed(229_245_253), 2_146_226_265);
}

#[test]
fn stop_removes_the_partial_file_at_once_and_a_stall_ends_the_download() {
    let at = "https://release-assets.githubusercontent.com/x";
    // Stop pressed once bytes have come: the partial file and the work folder are gone, nothing installed.
    let s = Scratch::new("stop");
    let cancel = no_cancel();
    let net = FakeNet::new(&[
        (DOWNLOAD_URL, Answer::Redirect(at.into())),
        (at, Answer::Body { length: Some(10_000), bytes: vec![1; 640], quiet: 1_000 }),
    ]);
    let (caches, data, apps) = (s.caches(), s.data(), s.apps());
    let verifier = SaysVerifier::default();
    let job = Job {
        caches: &caches,
        data: &data,
        destination: &apps,
        policy: &Policy::official(),
        fetch: &net,
        unpack: &Unzip,
        verifier: &verifier,
        opener: &Opens::default(),
        http: &Server::answering_after(0),
        free: &|_| None,
        cancel: &cancel,
        clock: &|| 1,
        waits: FAST,
    };
    let mut partial_seen = false;
    let ended = run(&job, &mut |p| {
        if p.done_bytes > 0 {
            // The partial file is in Ozzie's private work folder while it downloads.
            let root = caches.join(WORK_FOLDER);
            let work = std::fs::read_dir(&root).unwrap().flatten().find(|e| e.file_name().to_string_lossy().starts_with("work-")).unwrap().path();
            partial_seen = work.join("Ollama-darwin.zip").is_file();
            assert_eq!(std::fs::metadata(&work).unwrap().mode() & 0o777, 0o700);
            assert_eq!(std::fs::metadata(work.join("Ollama-darwin.zip")).unwrap().mode() & 0o777, 0o600);
            cancel.store(true, Ordering::SeqCst);
        }
    });
    assert!(partial_seen);
    assert_eq!((ended.phase, ended.end), (Phase::Downloading, Some(End::Cancelled)));
    assert_eq!(s.left(), LEFT_NOTHING);
    assert!(verifier.asked.lock().unwrap().is_empty());
    // Bytes that stop coming: a stall, and the partial is gone too.
    let s = Scratch::new("stall");
    let net = FakeNet::new(&[
        (DOWNLOAD_URL, Answer::Redirect(at.into())),
        (at, Answer::Body { length: Some(10_000), bytes: vec![1; 640], quiet: 1_000 }),
    ]);
    let started = Instant::now();
    let ran = run_job(&s, &net, &SaysVerifier::default(), &Opens::default(), &Server::answering_after(0), &no_cancel());
    assert_eq!(ran.ended.end, Some(End::Stalled));
    assert!(started.elapsed() < Duration::from_secs(5));
    assert_eq!(s.left(), LEFT_NOTHING);
}

// ---- A real connection on this Mac's loopback ----------------------------------------------------------------------

/// What the loopback server does for a path.
#[derive(Clone)]
enum Serve {
    Redirect(String),
    /// Says this size, sends these bytes, then waits this long before closing.
    Body { length: u64, bytes: Vec<u8>, then_wait: Duration },
}
fn serve(routes: Vec<(&'static str, Serve)>) -> (String, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let asked = Arc::new(Mutex::new(vec![]));
    let seen = asked.clone();
    let routes: BTreeMap<&'static str, Serve> = routes.into_iter().collect();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let routes = routes.clone();
            let seen = seen.clone();
            std::thread::spawn(move || answer(stream, &routes, &seen));
        }
    });
    (base, asked)
}
fn answer(mut stream: TcpStream, routes: &BTreeMap<&'static str, Serve>, seen: &Mutex<Vec<String>>) {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut first = String::new();
    reader.read_line(&mut first).unwrap();
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
            break;
        }
    }
    let path = first.split_whitespace().nth(1).unwrap_or("").to_owned();
    seen.lock().unwrap().push(path.clone());
    match routes.get(path.as_str()) {
        Some(Serve::Redirect(to)) => {
            let _ = write!(stream, "HTTP/1.1 302 Found\r\nLocation: {to}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        }
        Some(Serve::Body { length, bytes, then_wait }) => {
            let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n");
            let _ = stream.write_all(bytes);
            let _ = stream.flush();
            std::thread::sleep(*then_wait);
        }
        None => {
            let _ = write!(stream, "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        }
    }
}
fn loopback_policy(base: &str) -> Policy {
    Policy {
        start: format!("{base}/download/Ollama-darwin.zip"),
        https_only: false,
        hosts: vec![base.trim_start_matches("http://").to_owned()],
    }
}

#[test]
fn over_a_real_connection_a_redirect_off_the_list_is_never_followed() {
    let (base, asked) = serve(vec![("/download/Ollama-darwin.zip", Serve::Redirect("http://127.0.0.2:9/x".into()))]);
    let s = Scratch::new("real-redirect");
    let fetch = NativeFetch::for_loopback_tests().unwrap();
    let ran = run_with(&s, &fetch, &loopback_policy(&base), &Unzip, &SaysVerifier::default(), &Opens::default(), &Server::never(), &no_cancel(), &|_| None);
    assert_eq!(ran.ended.end, Some(End::Redirected));
    assert_eq!(*asked.lock().unwrap(), ["/download/Ollama-darwin.zip"]);
    // The app's own client is https only: a plain address is never asked at all.
    let official = NativeFetch::new().unwrap();
    let mut heard_anything = false;
    let got = official.get(&url::Url::parse(&format!("{base}/download/Ollama-darwin.zip")).unwrap(), &mut |_| {
        heard_anything = true;
        true
    });
    assert!(got.is_err() && !heard_anything);
    assert_eq!(asked.lock().unwrap().len(), 1);
}

#[test]
fn over_a_real_connection_stop_is_heard_within_a_poll_and_the_partial_is_gone() {
    let (base, _) = serve(vec![
        ("/download/Ollama-darwin.zip", Serve::Redirect("/download/v1/Ollama-darwin.zip".into())),
        ("/download/v1/Ollama-darwin.zip", Serve::Body { length: 1_000_000, bytes: vec![9; 4_096], then_wait: Duration::from_secs(20) }),
    ]);
    let s = Scratch::new("real-stop");
    let fetch = NativeFetch::for_loopback_tests().unwrap();
    let file = s.0.join("partial.zip");
    let cancel = no_cancel();
    let started = Instant::now();
    let got = download(&fetch, &loopback_policy(&base), &file, &cancel, FAST, &|_| true, &mut |_, done, total| {
        assert_eq!(total, 1_000_000);
        if done > 0 {
            cancel.store(true, Ordering::SeqCst);
        }
    });
    assert_eq!(got, Err(End::Cancelled));
    assert!(started.elapsed() < Duration::from_secs(5), "{:?}", started.elapsed());
    assert!(!file.exists());
    // A server that goes quiet: stalled within the stall wait and a poll, and the partial is gone.
    let started = Instant::now();
    let got = download(&fetch, &loopback_policy(&base), &file, &no_cancel(), FAST, &|_| true, &mut |_, _, _| {});
    assert_eq!(got, Err(End::Stalled));
    assert!(started.elapsed() < Duration::from_secs(5));
    assert!(!file.exists());
}

// ---- The archive --------------------------------------------------------------------------------------------------

#[test]
fn only_the_extra_fields_for_times_and_owners_are_read() {
    // The real archive's own field (0x5855), the extended time and the newer owner field: no name, no target.
    for id in [0x5855, 0x5455, 0x7875] {
        assert!(read_zip(&zip_bytes(&app_entries(), Spoil { extra: id, ..Spoil::default() })).is_some(), "{id:#x}");
    }
    assert!(extra_ok(&[]));
    // A record that runs past the end, or doesn't fill it, is refused.
    assert!(!extra_ok(&[0x55, 0x58, 8, 0, 1, 2]));
    assert!(!extra_ok(&[0x55, 0x58, 0, 0, 7]));
}

#[test]
fn versions_are_whole_numbers_and_compared_as_numbers() {
    assert_eq!(parse_version("0.40.16"), Some([0, 40, 16]));
    assert_eq!(parse_version("1.2"), Some([1, 2, 0]));
    assert!(parse_version("0.40.16").unwrap() >= MIN_VERSION);
    assert!(parse_version("0.40.9").unwrap() < MIN_VERSION);
    assert!(parse_version("0.100.0").unwrap() > MIN_VERSION);
    for bad in ["", "0.40.16-rc1", "v0.40.16", "0..16", "1.2.3.4", "0.40.1600000000000"] {
        assert_eq!(parse_version(bad), None, "{bad}");
    }
}

#[cfg(target_os = "macos")]
#[test]
fn unpacking_is_stopped_once_it_writes_more_than_the_archive_said() {
    let s = Scratch::new("guard");
    std::fs::write(s.0.join("big"), vec![0u8; 2_000]).unwrap();
    assert!(written_within(&s.0, 10_000, 100));
    assert!(!written_within(&s.0, 1_000, 100));
    assert!(!written_within(&s.0, 10_000, 3));
    // A program still writing past its limit is stopped at the next look, long before its own wait.
    let mut child = std::process::Command::new("/bin/sleep").arg("30").spawn().unwrap();
    let started = Instant::now();
    assert_eq!(finished(&mut child, Duration::from_secs(60), &no_cancel(), &|| false).map(|s| s.success()), None);
    assert!(started.elapsed() < Duration::from_secs(5));
}

/// Swaps the app for another folder of the same name while it is being checked, as code of this user's could.
struct SwapsVerifier;
impl Verifier for SwapsVerifier {
    fn verify(&self, app: &Path) -> Result<(), Rejected> {
        std::fs::rename(app, app.with_extension("checked")).unwrap();
        std::fs::create_dir_all(app.join("Contents")).unwrap();
        Ok(())
    }
}

#[cfg(target_os = "macos")]
#[test]
fn a_folder_swapped_while_it_was_checked_is_never_moved() {
    let s = Scratch::new("swap");
    let opens = Opens::default();
    let ran = run_job(&s, &FakeNet::official(app_zip()), &SwapsVerifier, &opens, &Server::answering_after(0), &no_cancel());
    assert_eq!(ran.ended.end, Some(End::InstallFailed));
    assert!(std::fs::read_dir(s.apps()).unwrap().next().is_none());
    assert!(opens.opened.lock().unwrap().is_empty());
    assert_eq!(s.left(), LEFT_NOTHING);
}

#[cfg(target_os = "macos")]
#[test]
fn a_stop_pressed_after_the_download_finished_changes_nothing() {
    // Stop is offered only while downloading; a press already on its way when the download ends isn't heard by the
    // unpacking, so a good archive is never called a bad one (review, 2026-11-19).
    let s = Scratch::new("late-stop");
    let cancel = no_cancel();
    let (caches, data, apps) = (s.caches(), s.data(), s.apps());
    let (net, verifier, opens, server) = (FakeNet::official(app_zip()), SaysVerifier::default(), Opens::default(), Server::answering_after(0));
    let job = Job {
        caches: &caches,
        data: &data,
        destination: &apps,
        policy: &Policy::official(),
        fetch: &net,
        unpack: &Unzip,
        verifier: &verifier,
        opener: &opens,
        http: &server,
        free: &|_| None,
        cancel: &cancel,
        clock: &|| 1,
        waits: FAST,
    };
    let ended = run(&job, &mut |p| {
        if p.phase == Phase::Checking {
            cancel.store(true, Ordering::SeqCst);
        }
    });
    assert_eq!(ended.end, Some(End::Ready));
}

#[test]
fn a_plain_app_archive_is_read_whole_with_its_links() {
    let plan = read_zip(&app_zip()).expect("the plain app reads");
    assert_eq!(plan.entries.len(), app_entries().len());
    assert_eq!(plan.entries.get("Ollama.app/Contents/Frameworks/S.framework/Versions/Current"), Some(&Kind::Link { target: "A".into() }));
    assert_eq!(plan.entries.get("Ollama.app/Contents"), Some(&Kind::Folder));
    assert_eq!(plan.unpacked_bytes, app_entries().iter().filter(|e| e.mode >> 12 == 0o10).map(|e| e.data.len() as u64).sum::<u64>());
}

#[test]
fn an_archive_entry_or_link_that_would_leave_the_folder_is_refused() {
    let refused = [
        ("a name climbing out", with(file("Ollama.app/../../outside/evil", "x"))),
        ("a name climbing out from inside", with(file("Ollama.app/Contents/../../evil", "x"))),
        ("an absolute name", with(file("/tmp/evil", "x"))),
        ("a name outside the app", with(file("Other.app/Contents/x", "x"))),
        ("a backslash", with(file("Ollama.app\\..\\evil", "x"))),
        ("a link out of the app", with(link("Ollama.app/Contents/out", "../../outside"))),
        ("a link to an absolute path", with(link("Ollama.app/Contents/etc", "/etc"))),
        // Read without its leading slash it would look inside the app; the system reads it from the disk's root.
        ("a link to an absolute path that reads as inside", with(link("Ollama.app/Contents/abs", "/tmp/x"))),
        ("a link to the app's own folder", with(link("Ollama.app/Contents/up", ".."))),
        ("a link out and back in", with(link("Ollama.app/Contents/round", "../../Ollama.app/Contents"))),
        // Through Squirrel's own Current (to A): from A, six levels up leaves the app.
        ("a link out through another link", with(link("Ollama.app/Contents/Frameworks/S.framework/out", "Versions/Current/../../../../../../x"))),
        // Read as text it stays inside (S.framework/../up/../../x is Contents/x), but `up` is itself a link to Contents,
        // so the system climbs from Contents and leaves the app.
        ("a link that looks inside but leaves through another", {
            let mut e = app_entries();
            e.push(link("Ollama.app/Contents/Frameworks/up", ".."));
            e.push(link("Ollama.app/Contents/Frameworks/S.framework/sneak", "../up/../../x"));
            zip_bytes(&e, Spoil::default())
        }),
        ("an entry reached through a link", with(file("Ollama.app/Contents/Frameworks/S.framework/Versions/Current/evil", "x"))),
        ("two links round each other", {
            let mut e = app_entries();
            e.push(link("Ollama.app/Contents/l1", "l2/x"));
            e.push(link("Ollama.app/Contents/l2", "l1/x"));
            zip_bytes(&e, Spoil::default())
        }),
        ("two names APFS takes for one", with(file("Ollama.app/contents/info.plist", "x"))),
        ("a set-id program", with(Entry { name: "Ollama.app/Contents/MacOS/setid".into(), mode: 0o104755, data: b"x".to_vec() })),
        ("a file others can write", with(Entry { name: "Ollama.app/Contents/open".into(), mode: 0o100666, data: b"x".to_vec() })),
        ("a device", with(Entry { name: "Ollama.app/Contents/dev".into(), mode: 0o020644, data: vec![] })),
        ("a hidden entry the directory doesn't name", zip_bytes(&app_entries(), Spoil { hidden_entry: true, ..Spoil::default() })),
        ("a local name that differs", zip_bytes(&app_entries(), Spoil { local_name: true, ..Spoil::default() })),
        ("modes from another system", zip_bytes(&app_entries(), Spoil { not_unix: true, ..Spoil::default() })),
        ("an encrypted entry", zip_bytes(&app_entries(), Spoil { encrypted: true, ..Spoil::default() })),
        // A field that can carry another name (Info-ZIP's Unicode path) or a link's target (two Unix fields).
        ("a Unicode name field", zip_bytes(&app_entries(), Spoil { extra: 0x7075, ..Spoil::default() })),
        ("a Unix field with a link's target", zip_bytes(&app_entries(), Spoil { extra: 0x756e, ..Spoil::default() })),
        ("PKWARE's Unix field", zip_bytes(&app_entries(), Spoil { extra: 0x000d, ..Spoil::default() })),
        // Stored data whose end a reader would have to find by decoding it.
        ("a data descriptor after stored data", zip_bytes(&app_entries(), Spoil { stored_descriptor: true, ..Spoil::default() })),
        // A file named like a folder, with entries under it: a reader that made it a link would write through it.
        ("an entry under a file", with(file("Ollama.app/Contents/Info.plist/x", "x"))),
        ("nothing", zip_bytes(&[], Spoil::default())),
        ("not a zip", b"PK\x03\x04 not really".to_vec()),
    ];
    for (why, bytes) in refused {
        assert_eq!(read_zip(&bytes), None, "{why}");
    }
}

#[cfg(target_os = "macos")]
#[test]
fn an_archive_entry_escaping_the_folder_ends_the_job_and_nothing_is_written_anywhere() {
    let s = Scratch::new("escape");
    let escape = zip_bytes(
        &[folder("Ollama.app/"), file("Ollama.app/../outside/escaped", "x"), link("Ollama.app/out", "../outside")],
        Spoil::default(),
    );
    let net = FakeNet::official(escape);
    let verifier = SaysVerifier::default();
    let ran = run_job(&s, &net, &verifier, &Opens::default(), &Server::answering_after(0), &no_cancel());
    assert_eq!(ran.ended.end, Some(End::BadArchive));
    assert_eq!(ran.told.last().map(|p| p.phase), Some(Phase::Checking));
    assert!(!s.outside().join("escaped").exists() && !s.caches().join("outside").exists());
    assert!(verifier.asked.lock().unwrap().is_empty());
    assert!(std::fs::read_dir(s.apps()).unwrap().next().is_none());
    assert_eq!(s.left(), LEFT_NOTHING);
}

#[cfg(target_os = "macos")]
#[test]
fn what_unzip_unpacked_must_be_exactly_what_was_read() {
    let s = Scratch::new("tree");
    let zip = s.0.join("a.zip");
    std::fs::write(&zip, app_zip()).unwrap();
    let plan = check_zip(&zip).unwrap();
    let unpacked = s.0.join("unpacked");
    std::fs::create_dir(&unpacked).unwrap();
    assert!(Unzip.unpack(&zip, &unpacked, &plan));
    assert!(check_tree(&unpacked, &plan));
    // Anything more, a link changed, a file grown, or a mode others could write, and it is refused.
    let contents = unpacked.join("Ollama.app/Contents");
    std::fs::write(contents.join("extra"), "x").unwrap();
    assert!(!check_tree(&unpacked, &plan));
    std::fs::remove_file(contents.join("extra")).unwrap();
    assert!(check_tree(&unpacked, &plan));
    let current = contents.join("Frameworks/S.framework/Versions/Current");
    std::fs::remove_file(&current).unwrap();
    std::os::unix::fs::symlink("/", &current).unwrap();
    assert!(!check_tree(&unpacked, &plan));
    std::fs::remove_file(&current).unwrap();
    std::os::unix::fs::symlink("A", &current).unwrap();
    assert!(check_tree(&unpacked, &plan));
    std::fs::set_permissions(contents.join("Info.plist"), std::fs::Permissions::from_mode(0o666)).unwrap();
    assert!(!check_tree(&unpacked, &plan));
    std::fs::set_permissions(contents.join("Info.plist"), std::fs::Permissions::from_mode(0o644)).unwrap();
    std::fs::write(unpacked.join("second"), "x").unwrap();
    assert!(!check_tree(&unpacked, &plan));
}

// ---- Verifying, installing, opening -------------------------------------------------------------------------------

#[cfg(target_os = "macos")]
#[test]
fn each_verification_failure_has_its_own_ending_and_leaves_nothing_behind() {
    for (rejected, end) in [
        (Rejected::NotSigned, End::NotSigned),
        (Rejected::WrongTeam, End::WrongTeam),
        (Rejected::WrongApp, End::WrongApp),
        (Rejected::NotNotarized, End::NotNotarized),
        (Rejected::Outdated, End::Outdated),
    ] {
        let s = Scratch::new("verify");
        let net = FakeNet::official(app_zip());
        let verifier = SaysVerifier::saying(&[Err(rejected)]);
        let opens = Opens::default();
        let ran = run_job(&s, &net, &verifier, &opens, &Server::answering_after(0), &no_cancel());
        assert_eq!(ran.ended.end, Some(end));
        // It was the unpacked app in Ozzie's private work folder that was verified, and only once.
        let asked = verifier.asked.lock().unwrap().clone();
        assert_eq!(asked.len(), 1);
        assert!(asked[0].starts_with(s.caches().join(WORK_FOLDER)) && asked[0].ends_with("unpacked/Ollama.app"));
        assert!(std::fs::read_dir(s.apps()).unwrap().next().is_none(), "{end:?}");
        assert!(opens.opened.lock().unwrap().is_empty());
        assert_eq!(s.left(), LEFT_NOTHING, "{end:?}");
        assert!(!End::from(rejected).installed());
    }
}

#[cfg(target_os = "macos")]
#[test]
fn a_checked_app_is_moved_into_applications_checked_again_there_opened_and_waited_for() {
    let s = Scratch::new("install");
    let net = FakeNet::official(app_zip());
    let verifier = SaysVerifier::default();
    let opens = Opens::default();
    let server = Server::answering_after(3);
    let ran = run_job(&s, &net, &verifier, &opens, &server, &no_cancel());
    assert_eq!(ran.ended.end, Some(End::Ready));
    let installed = s.apps().join(APP_NAME);
    assert!(installed.join("Contents/Info.plist").is_file());
    assert_eq!(
        std::fs::read_link(installed.join("Contents/Frameworks/S.framework/Versions/Current")).unwrap(),
        Path::new("A")
    );
    // Verified in the work folder, then again where it is now, then opened by that exact path.
    let asked = verifier.asked.lock().unwrap().clone();
    assert_eq!(asked.len(), 2);
    assert!(asked[0].ends_with("unpacked/Ollama.app"));
    assert_eq!(asked[1], installed);
    assert_eq!(*opens.opened.lock().unwrap(), [installed.clone()]);
    let phases: Vec<Phase> = ran.told.iter().map(|p| p.phase).collect();
    for phase in [Phase::Starting, Phase::Downloading, Phase::Checking, Phase::Installing, Phase::Opening] {
        assert!(phases.contains(&phase), "{phase:?}");
    }
    assert!(!phases.contains(&Phase::StillStarting));
    let downloading = ran.told.iter().rfind(|p| p.phase == Phase::Downloading).unwrap();
    assert_eq!((downloading.done_bytes, downloading.total_bytes), (app_zip().len() as u64, app_zip().len() as u64));
    // Nothing of the work is left; the record says when Ozzie installed it, and nothing more.
    assert_eq!(s.left(), LEFT_NOTHING);
    assert_eq!(installed_by_ozzie(&s.data(), &s.apps()), Some(1_763_500_000_000));
    let record = std::fs::read_to_string(s.data().join(RECORD_FILE)).unwrap();
    assert_eq!(serde_json::from_str::<serde_json::Value>(&record).unwrap(), serde_json::json!({"done": [{"at_ms": 1_763_500_000_000u64, "end": "ready"}]}));
    assert!(!record.contains('/'));
    // Once the person drags it to the Trash, Settings no longer says Ozzie installed it.
    std::fs::remove_dir_all(&installed).unwrap();
    assert_eq!(installed_by_ozzie(&s.data(), &s.apps()), None);
}

#[cfg(target_os = "macos")]
#[test]
fn a_check_that_fails_where_the_app_now_is_takes_it_out_again_and_never_opens_it() {
    let s = Scratch::new("reverify");
    let net = FakeNet::official(app_zip());
    let verifier = SaysVerifier::saying(&[Ok(()), Err(Rejected::WrongTeam)]);
    let opens = Opens::default();
    let ran = run_job(&s, &net, &verifier, &opens, &Server::answering_after(0), &no_cancel());
    assert_eq!(ran.ended.end, Some(End::WrongTeam));
    assert!(!s.apps().join(APP_NAME).exists());
    assert!(opens.opened.lock().unwrap().is_empty());
    assert_eq!(installed_by_ozzie(&s.data(), &s.apps()), None);
}

#[cfg(target_os = "macos")]
#[test]
fn an_ollama_already_in_applications_is_never_replaced() {
    let s = Scratch::new("already");
    let theirs = s.apps().join(APP_NAME);
    std::fs::create_dir_all(theirs.join("Contents")).unwrap();
    std::fs::write(theirs.join("Contents/theirs"), "the person's own").unwrap();
    let net = FakeNet::official(app_zip());
    let opens = Opens::default();
    let ran = run_job(&s, &net, &SaysVerifier::default(), &opens, &Server::answering_after(0), &no_cancel());
    assert_eq!(ran.ended.end, Some(End::AlreadyInstalled));
    assert_eq!(std::fs::read_to_string(theirs.join("Contents/theirs")).unwrap(), "the person's own");
    assert!(!theirs.join("Contents/Info.plist").exists());
    assert!(opens.opened.lock().unwrap().is_empty());
    assert_eq!(s.left(), LEFT_NOTHING);
    // An empty folder of that name too: a plain rename would replace it; Ozzie's never does.
    let s = Scratch::new("already-empty");
    std::fs::create_dir(s.apps().join(APP_NAME)).unwrap();
    let ran = run_job(&s, &FakeNet::official(app_zip()), &SaysVerifier::default(), &Opens::default(), &Server::answering_after(0), &no_cancel());
    assert_eq!(ran.ended.end, Some(End::AlreadyInstalled));
    assert_eq!(std::fs::read_dir(s.apps().join(APP_NAME)).unwrap().count(), 0);
}

#[cfg(target_os = "macos")]
#[test]
fn applications_that_needs_a_password_falls_back_to_finder_without_asking_for_one() {
    let s = Scratch::new("no-write");
    std::fs::set_permissions(s.apps(), std::fs::Permissions::from_mode(0o555)).unwrap();
    let net = FakeNet::official(app_zip());
    let opens = Opens::default();
    let verifier = SaysVerifier::default();
    let ran = run_job(&s, &net, &verifier, &opens, &Server::answering_after(0), &no_cancel());
    assert_eq!(ran.ended.end, Some(End::CantInstall));
    // Nothing in Applications, nothing opened, and the checked app waits in Ozzie's own folder for the person.
    assert!(std::fs::read_dir(s.apps()).unwrap().next().is_none());
    assert!(opens.opened.lock().unwrap().is_empty());
    assert!(kept_app(&s.caches()).join("Contents/Info.plist").is_file());
    assert_eq!(s.left(), [".lock", "ready"]);
    assert_eq!(verifier.asked.lock().unwrap().len(), 1);
    assert_eq!(installed_by_ozzie(&s.data(), &s.apps()), None);
    // The next job, or the start of Ozzie, clears what an earlier one left.
    clean(&s.caches(), false, Duration::ZERO);
    assert_eq!(s.left(), [".lock", "ready"]);
    clean(&s.caches(), true, Duration::ZERO);
    assert_eq!(s.left(), [".lock"]);
    // No way to ask for a password exists in this module: no sudo, no AppleScript, no authorization services.
    let code = include_str!("ollama_install.rs").split("#[cfg(test)]").next().unwrap();
    for never in ["sudo", "osascript", "AuthorizationExecute", "administrator privileges", "AuthorizationCreate", "SMJobBless"] {
        assert!(!code.contains(never), "{never}");
    }
}

#[cfg(target_os = "macos")]
#[test]
fn a_server_that_never_answers_ends_with_the_bounded_wait() {
    let s = Scratch::new("never");
    let server = Server::never();
    let started = Instant::now();
    let ran = run_job(&s, &FakeNet::official(app_zip()), &SaysVerifier::default(), &Opens::default(), &server, &no_cancel());
    assert_eq!(ran.ended.end, Some(End::NotAnswering));
    assert!(started.elapsed() < Duration::from_secs(10));
    // "Still starting" was said once on the way, and the wait asked more than once.
    assert_eq!(ran.told.iter().filter(|p| p.phase == Phase::StillStarting).count(), 1);
    assert!(server.asked.load(Ordering::SeqCst) > 2);
    // It is installed all the same, and Settings can say so.
    assert!(s.apps().join(APP_NAME).is_dir());
    assert!(End::NotAnswering.installed());
    assert_eq!(installed_by_ozzie(&s.data(), &s.apps()), Some(1_763_500_000_000));
    // Ozzie quitting while it waits still leaves the record true: Ollama is in Applications as soon as it is there.
    let s = Scratch::new("quit-waiting");
    let (caches, data, apps) = (s.caches(), s.data(), s.apps());
    let (net, verifier, opens, server, cancel) = (FakeNet::official(app_zip()), SaysVerifier::default(), Opens::default(), Server::never(), no_cancel());
    let job = Job {
        caches: &caches,
        data: &data,
        destination: &apps,
        policy: &Policy::official(),
        fetch: &net,
        unpack: &Unzip,
        verifier: &verifier,
        opener: &opens,
        http: &server,
        free: &|_| None,
        cancel: &cancel,
        clock: &|| 7,
        waits: FAST,
    };
    let mut while_opening = vec![];
    let ended = run(&job, &mut |p| {
        if p.phase == Phase::Opening {
            while_opening = history(&data);
        }
    });
    assert_eq!(while_opening, [Done { at_ms: 7, end: End::NotAnswering }]);
    assert_eq!(installed_by_ozzie(&data, &apps), Some(7));
    // The ending takes its place: one line per time, not two.
    assert_eq!(ended.end, Some(End::NotAnswering));
    assert_eq!(history(&data), [Done { at_ms: 7, end: End::NotAnswering }]);
    // An app that won't open is said as such, and never waited for.
    let s = Scratch::new("wont-open");
    let server = Server::never();
    let ran = run_job(&s, &FakeNet::official(app_zip()), &SaysVerifier::default(), &Opens { fails: true, ..Opens::default() }, &server, &no_cancel());
    assert_eq!(ran.ended.end, Some(End::WontOpen));
    assert_eq!(server.asked.load(Ordering::SeqCst), 0);
}

#[cfg(target_os = "macos")]
#[test]
fn ozzies_work_folder_is_its_own_and_what_a_quit_left_is_removed_without_following_links() {
    let s = Scratch::new("folders");
    // A link where the work folder should be is never used as the folder: refused, and a job's first clean-up removes
    // the link itself (never what it points to), then works in a folder of its own.
    std::os::unix::fs::symlink(s.outside(), s.caches().join(WORK_FOLDER)).unwrap();
    assert!(work_root(&s.caches()).is_err());
    let ran = run_job(&s, &FakeNet::official(app_zip()), &SaysVerifier::default(), &Opens::default(), &Server::answering_after(0), &no_cancel());
    assert_eq!(ran.ended.end, Some(End::Ready));
    assert!(std::fs::read_dir(s.outside()).unwrap().next().is_none());
    assert!(std::fs::symlink_metadata(s.caches().join(WORK_FOLDER)).unwrap().file_type().is_dir());
    // A folder of Ozzie's with wider permissions is narrowed.
    std::fs::remove_dir_all(s.caches().join(WORK_FOLDER)).unwrap();
    std::fs::DirBuilder::new().mode(0o755).create(s.caches().join(WORK_FOLDER)).unwrap();
    let root = work_root(&s.caches()).unwrap();
    assert_eq!(std::fs::metadata(&root).unwrap().mode() & 0o777, 0o700);
    // A work folder a quit left, holding a link to a file of the person's: removed, and the file kept.
    std::fs::write(s.outside().join("keep"), "the person's").unwrap();
    let left = root.join("work-0123456789abcdef");
    std::fs::create_dir_all(left.join("unpacked")).unwrap();
    std::os::unix::fs::symlink(s.outside(), left.join("unpacked/link")).unwrap();
    std::fs::write(left.join("Ollama-darwin.zip"), "partial").unwrap();
    // At start, a folder touched in the last ten minutes is left: a copy that quit may still have unzip finishing there.
    clean(&s.caches(), false, CLEAN_SETTLED);
    assert_eq!(s.left(), [".lock", "work-0123456789abcdef"]);
    clean(&s.caches(), false, Duration::ZERO);
    assert_eq!(s.left(), [".lock"]);
    assert_eq!(std::fs::read_to_string(s.outside().join("keep")).unwrap(), "the person's");
    // While a job (or another copy of Ozzie) holds the lock, nothing is cleaned and no second job starts.
    let root = work_root(&s.caches()).unwrap();
    std::fs::create_dir(root.join("work-fedcba9876543210")).unwrap();
    let held = lock(&root).expect("the lock");
    assert!(lock(&root).is_none());
    clean(&s.caches(), true, Duration::ZERO);
    assert_eq!(s.left(), [".lock", "work-fedcba9876543210"]);
    let (net, verifier) = (FakeNet::official(app_zip()), SaysVerifier::default());
    let ran = run_job(&s, &net, &verifier, &Opens::default(), &Server::answering_after(0), &no_cancel());
    assert_eq!(ran.ended.end, Some(End::Failed));
    assert!(net.asked.lock().unwrap().is_empty() && verifier.asked.lock().unwrap().is_empty());
    drop(held);
    assert!(lock(&root).is_some());
}

#[test]
fn ollama_is_offered_only_where_ozzie_offers_a_model_and_never_over_one_already_there() {
    let found = |advice: &'static str, installed: bool, running: bool| LocalFind {
        memory_gb: Some(16),
        advice,
        recommended: None,
        recommended_size_bytes: None,
        apps: vec![
            AppFound { app: App::Ollama, installed, running, start_hint: "", models: vec![], elsewhere: 0, open: running },
            AppFound { app: App::LmStudio, installed: false, running: false, start_hint: "", models: vec![], elsewhere: 0, open: false },
        ],
        free_bytes: None,
        catalogue: vec![],
    };
    assert_eq!(may_start(&found("medium", false, false)), Ok(()));
    assert_eq!(may_start(&found("large", false, false)), Ok(()));
    assert_eq!(may_start(&found("unknown", false, false)), Ok(()));
    assert_eq!(may_start(&found("too-small", false, false)), Err(Refusal::TooSmall));
    assert_eq!(may_start(&found("medium", true, false)), Err(Refusal::AlreadyInstalled));
    assert_eq!(may_start(&found("medium", true, true)), Err(Refusal::AlreadyRunning));
}

#[test]
fn the_page_and_the_record_get_closed_words_only() {
    let words = |v: serde_json::Value| v.as_str().unwrap().to_owned();
    let ends = [
        End::Ready, End::Cancelled, End::Offline, End::Redirected, End::TooLarge, End::Stalled, End::DownloadFailed, End::NoRoom,
        End::BadArchive, End::NotSigned, End::WrongTeam, End::WrongApp, End::NotNotarized, End::AlreadyInstalled, End::CantInstall,
        End::InstallFailed, End::WontOpen, End::NotAnswering, End::Failed, End::Outdated,
    ];
    let said: Vec<String> = ends.iter().map(|e| words(serde_json::to_value(e).unwrap())).collect();
    assert_eq!(
        said,
        [
            "ready", "cancelled", "offline", "redirected", "too-large", "stalled", "download-failed", "no-room", "bad-archive", "not-signed",
            "wrong-team", "wrong-app", "not-notarized", "already-installed", "cant-install", "install-failed", "wont-open", "not-answering", "failed",
            "outdated"
        ]
    );
    // The page's own closed lists (onboarding-bridge.ts) are exactly native's: every ending, step and refusal.
    let page = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../product/desktop/src/onboarding-bridge.ts"))
        .expect("product/desktop/src/onboarding-bridge.ts, the page's side of these words");
    let code = include_str!("ollama_install.rs");
    for (native, list) in [
        ("pub enum Phase {", "const OLLAMA_PHASES = ["),
        ("pub enum End {", "const OLLAMA_ENDS = ["),
        ("pub enum Refusal {", "const OLLAMA_REFUSALS = ["),
    ] {
        let (mut native_words, mut page_list) = (variants(code, native), page_words(&page, list));
        native_words.sort();
        page_list.sort();
        assert_eq!(native_words, page_list, "{native}");
    }
    let p = serde_json::to_value(Progress::starting()).unwrap();
    assert_eq!(p, serde_json::json!({"phase": "starting", "done_bytes": 0, "total_bytes": 0, "end": null}));
}

/// An enum's variants as serde writes them (kebab-case), read from this crate's source.
fn variants(source: &str, start: &str) -> Vec<String> {
    let body = &source[source.find(start).unwrap_or_else(|| panic!("{start}")) + start.len()..];
    let body = &body[..body.find("\n}").unwrap()];
    body.lines()
        .map(str::trim)
        .filter(|line| !line.starts_with("//") && line.ends_with(','))
        .map(|line| {
            let mut word = String::new();
            for (i, c) in line.trim_end_matches(',').chars().enumerate() {
                if c.is_ascii_uppercase() && i > 0 {
                    word.push('-');
                }
                word.push(c.to_ascii_lowercase());
            }
            word
        })
        .collect()
}
/// The quoted words of one closed list in the page's source.
fn page_words(source: &str, start: &str) -> Vec<String> {
    let from = source.find(start).unwrap_or_else(|| panic!("{start}")) + start.len();
    let list = &source[from..];
    let list = &list[..list.find("] as const;").unwrap()];
    list.split('"').skip(1).step_by(2).map(str::to_owned).collect()
}

#[test]
fn gatekeeper_counts_only_a_notarized_developer_id_app_from_ollamas_team() {
    let accepted = "/x/Ollama.app: accepted\nsource=Notarized Developer ID\norigin=Developer ID Application: Infra Technologies, Inc (3MU9H2V9Y9)\n";
    assert!(gatekeeper_said(true, accepted, TEAM_ID));
    assert!(!gatekeeper_said(false, accepted, TEAM_ID));
    assert!(!gatekeeper_said(true, accepted, "AAAAAAAAAA"));
    // Signed with a Developer ID but not notarized; Gatekeeper turned off; rejected.
    assert!(!gatekeeper_said(true, &accepted.replace("Notarized Developer ID", "Developer ID"), TEAM_ID));
    assert!(!gatekeeper_said(true, "/x/Ollama.app: accepted\noverride=security disabled\nsource=Notarized Developer ID\norigin=Developer ID Application: Infra Technologies, Inc (3MU9H2V9Y9)\n", TEAM_ID));
    assert!(!gatekeeper_said(true, "/x/Ollama.app: rejected\nsource=Unnotarized Developer ID\n", TEAM_ID));
    // Team, identifier and notarization are all in the requirement the check ends with.
    let req = requirement(TEAM_ID, BUNDLE_ID);
    for part in ["anchor apple generic", "identifier \"com.electron.ollama\"", "1.2.840.113635.100.6.2.6", "1.2.840.113635.100.6.1.13", "subject.OU] = \"3MU9H2V9Y9\"", "notarized"] {
        assert!(req.contains(part), "{part}");
    }
}

// ---- The real verifier --------------------------------------------------------------------------------------------

/// A small bundle made here: never run.
#[cfg(target_os = "macos")]
fn bundle(at: &Path, id: &str) -> PathBuf {
    let app = at.join("Fixture.app");
    std::fs::create_dir_all(app.join("Contents/MacOS")).unwrap();
    std::fs::write(
        app.join("Contents/Info.plist"),
        format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict><key>CFBundleIdentifier</key><string>{id}</string><key>CFBundleExecutable</key><string>Fixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>\n"),
    )
    .unwrap();
    std::fs::copy("/usr/bin/true", app.join("Contents/MacOS/Fixture")).unwrap();
    app
}

#[cfg(target_os = "macos")]
#[test]
fn the_real_verifier_refuses_an_unsigned_app_a_self_signed_one_and_one_of_apples_own() {
    let s = Scratch::new("real-verify");
    let app = bundle(&s.0, BUNDLE_ID);
    // /usr/bin/true is signed by Apple; strip it so the bundle is truly unsigned.
    let stripped = std::process::Command::new("/usr/bin/codesign")
        .args(["--remove-signature"])
        .arg(app.join("Contents/MacOS/Fixture"))
        .status()
        .unwrap();
    assert!(stripped.success());
    assert_eq!(MacVerifier::OLLAMA.verify(&app), Err(Rejected::NotSigned));
    // Signed by anyone at all (ad hoc), even claiming Ollama's identifier: not Ollama's team.
    let signed = std::process::Command::new("/usr/bin/codesign")
        .args(["--force", "--deep", "--sign", "-", "--identifier", BUNDLE_ID])
        .arg(&app)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .unwrap();
    assert!(signed.success());
    assert_eq!(MacVerifier::OLLAMA.verify(&app), Err(Rejected::WrongTeam));
    // Changed after signing: the signature is no longer whole.
    std::fs::write(app.join("Contents/Info.plist"), "changed").unwrap();
    assert_eq!(MacVerifier::OLLAMA.verify(&app), Err(Rejected::NotSigned));
    // Apple's own app is signed, but not with a Developer ID from Ollama's team.
    let calculator = Path::new("/System/Applications/Calculator.app");
    if calculator.is_dir() {
        assert_eq!(MacVerifier::OLLAMA.verify(calculator), Err(Rejected::WrongTeam));
    }
    // A link where the app should be is never followed.
    let linked = s.0.join("Linked.app");
    std::os::unix::fs::symlink(calculator, &linked).unwrap();
    assert_eq!(MacVerifier::OLLAMA.verify(&linked), Err(Rejected::NotSigned));
}

/// The real Ollama app (v0.40.16 on 2026-11-18): `OZZIE_OLLAMA_APP=/path/to/Ollama.app cargo test -- --ignored real_ollama`.
/// Reads it only; never opens it.
#[cfg(target_os = "macos")]
#[test]
#[ignore = "needs the real Ollama.app: set OZZIE_OLLAMA_APP"]
fn the_real_ollama_app_passes_and_another_team_or_identifier_does_not() {
    let app = PathBuf::from(std::env::var_os("OZZIE_OLLAMA_APP").expect("OZZIE_OLLAMA_APP"));
    assert_eq!(MacVerifier::OLLAMA.verify(&app), Ok(()));
    assert_eq!(MacVerifier { team: "AAAAAAAAAA", ..MacVerifier::OLLAMA }.verify(&app), Err(Rejected::WrongTeam));
    assert_eq!(MacVerifier { bundle_id: "com.example.not-ollama", ..MacVerifier::OLLAMA }.verify(&app), Err(Rejected::WrongApp));
    // An older Ollama than Ozzie installs, however genuinely signed: refused (a downgrade served in the latest's place).
    assert_eq!(bundle_version(&app).map(|v| v >= MIN_VERSION), Some(true));
    assert_eq!(MacVerifier { min_version: [99, 0, 0], ..MacVerifier::OLLAMA }.verify(&app), Err(Rejected::Outdated));
    assert!(gatekeeper_accepts(&app, TEAM_ID));
    assert!(!gatekeeper_accepts(&app, "AAAAAAAAAA"));
}

/// The real archive: `OZZIE_OLLAMA_ZIP=/path/to/Ollama-darwin.zip cargo test -- --ignored real_ollama`. Read, unpacked
/// into a scratch folder with unzip, compared and verified; never opened.
#[cfg(target_os = "macos")]
#[test]
#[ignore = "needs the real Ollama-darwin.zip: set OZZIE_OLLAMA_ZIP"]
fn the_real_ollama_archive_reads_unpacks_and_verifies() {
    let zip = PathBuf::from(std::env::var_os("OZZIE_OLLAMA_ZIP").expect("OZZIE_OLLAMA_ZIP"));
    let plan = check_zip(&zip).expect("the real archive reads");
    assert!(plan.entries.len() < MAX_ENTRIES && plan.unpacked_bytes < MAX_UNPACKED_BYTES);
    let s = Scratch::new("real-zip");
    let unpacked = s.0.join("unpacked");
    std::fs::create_dir(&unpacked).unwrap();
    assert!(Unzip.unpack(&zip, &unpacked, &plan));
    assert!(check_tree(&unpacked, &plan));
    assert_eq!(MacVerifier::OLLAMA.verify(&unpacked.join(APP_NAME)), Ok(()));
}
