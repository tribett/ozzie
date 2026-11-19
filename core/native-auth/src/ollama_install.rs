//! Getting Ollama for a church that chose AI on this Mac and doesn't have it (the owner's request of 2026-11-18,
//! onboarding decision 25; spec S9c; contract N6 "Ozzie gets Ollama"). Ollama is another company's app: Ozzie downloads
//! the official macOS build, proves it is Ollama's own signed and notarized app before anything is moved or opened,
//! puts it in /Applications, opens it, and waits for its server. Then "Download and set up" (local_models.rs) takes over.
//!
//! Only after the person presses "Download Ollama and set it up": nothing here runs on its own. In order:
//!
//! 1. **Download** `DOWNLOAD_URL`, Ollama's own stable address (the one its install script uses), following at most
//!    `MAX_REDIRECTS` redirects by hand, each checked against `Policy::official`: https only, no user or port, the
//!    three hosts it really redirects through (measured 2026-11-18: ollama.com 307 → github.com 302 → github.com 302 →
//!    release-assets.githubusercontent.com 200), and on github.com only Ollama's own releases. The answer must say
//!    its size (Content-Length), at most `MAX_DOWNLOAD_BYTES`, and the body must be exactly that size. Stop, or a
//!    minute with no bytes, closes the connection and deletes the partial file at once.
//! 2. **Unpack** into a fresh private folder (0700, ours) inside Ozzie's own caches folder. The archive is read first
//!    (`check_zip`): every entry under `Ollama.app/`, plain names only (no `..`, no absolute path, no backslash), only
//!    folders, files and links, no set-id bit and nothing others can write, every link resolving inside the app, no
//!    entry reached through a link or a file, no two names that APFS would take for one, only the extra fields that carry
//!    times or owners, data descriptors only after deflated data, and the local headers laid end to end exactly as the
//!    central directory says, so no hidden entry can be unpacked. Then Apple's `/usr/bin/unzip` (the tool Ollama's own
//!    install script uses; it finds each entry through the central directory, never by reading the file as a stream)
//!    unpacks it, with only the two paths inside that folder as arguments and its size watched as it writes, and the tree
//!    on disk is compared with what was read (`check_tree`): nothing more, nothing less, no link changed.
//! 3. **Verify** (`Verifier`; `MacVerifier` on a Mac): the app's signature is whole (strict, nested code, every
//!    architecture), it is signed with a Developer ID by Ollama's team `TEAM_ID`, it is `BUNDLE_ID`, it is notarized,
//!    it is no older than `MIN_VERSION` (an old, genuinely signed build served in place of the current one is refused),
//!    and Gatekeeper (`/usr/sbin/spctl --assess --type execute`) accepts it as a notarized Developer ID app. Each failure
//!    has its own closed ending, and everything downloaded is deleted. The hosts in step 1 are hygiene; this is the proof.
//! 4. **Install**: an atomic move into /Applications that never replaces anything (`renamex_np` with `RENAME_EXCL`). An
//!    Ollama already there is never replaced. When /Applications needs an administrator's password (or is on another
//!    disk), Ozzie never asks for one: the checked app is kept in Ozzie's own folder and shown in Finder for the person to
//!    drag (`CantInstall`). ~/Applications isn't used: Ollama asks to move itself to /Applications on its first start
//!    from anywhere else (its docs, "Changing Install Location"). After the move the same folder (same device and inode)
//!    is verified again where it now is, before it is opened.
//! 5. **Open** it by its exact path (`/usr/bin/open /Applications/Ollama.app`), and wait at most `SERVER_WAIT` for its
//!    server on 127.0.0.1:11434, saying "still starting" after `STILL_STARTING`.
//!
//! The page sees numbers and closed words only (`Progress`); nothing Ollama, GitHub or a tool wrote reaches it, and no
//! file path either. What Ozzie did is kept as closed codes and times in `ollama-install.json` (app data folder), for
//! What happened and Settings; no path, so no folder named after the person.
use crate::local_ai::{self, LocalHttp};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

/// Ollama's own stable address for its macOS app (the one `ollama.com/install.sh` downloads on a Mac); it redirects
/// to the latest release on GitHub.
pub const DOWNLOAD_URL: &str = "https://ollama.com/download/Ollama-darwin.zip";
/// The hosts the download may pass through, exactly (measured 2026-11-18, v0.40.16).
pub const DOWNLOAD_HOSTS: [&str; 3] = [
    "ollama.com",
    "github.com",
    "release-assets.githubusercontent.com",
];
/// On github.com, only Ollama's own releases.
pub const GITHUB_RELEASES: &str = "/ollama/ollama/releases/";
/// On ollama.com, only its download pages.
pub const OLLAMA_DOWNLOADS: &str = "/download/";
/// The Apple Developer Team that signs Ollama's macOS app: "Developer ID Application: Infra Technologies, Inc
/// (3MU9H2V9Y9)", read from the real v0.40.16 app with `codesign -dv --verbose=4` (2026-11-18) and the same in
/// Installomator's `ollama` label (`expectedTeamID`) and the app's own designated requirement.
pub const TEAM_ID: &str = "3MU9H2V9Y9";
/// The app's bundle identifier (its Info.plist and designated requirement, v0.40.16; still Electron's name).
pub const BUNDLE_ID: &str = "com.electron.ollama";
/// The oldest Ollama Ozzie installs (`CFBundleShortVersionString`, sealed by the signature): v0.40.16, the build the
/// address served on 2026-11-18. Ollama's address always serves its latest release, so only an old build served in its
/// place, signed and notarized long ago and perhaps since fixed, is refused (review, 2026-11-19).
pub const MIN_VERSION: [u64; 3] = [0, 40, 16];
/// The app's folder name, inside the archive and in /Applications.
pub const APP_NAME: &str = "Ollama.app";
/// Where Ozzie puts it.
pub const DESTINATION: &str = "/Applications";
/// The archive's size, at most: 229,245,253 bytes for v0.40.16 (2026-11-18), so four times as much leaves room to grow.
pub const MAX_DOWNLOAD_BYTES: u64 = 1_000_000_000;
/// Redirects followed, at most (the real chain has three).
pub const MAX_REDIRECTS: usize = 5;
/// Entries in the archive, at most (95 in v0.40.16).
pub const MAX_ENTRIES: usize = 4_096;
/// The archive's unpacked size, at most (726,809,430 bytes in v0.40.16).
pub const MAX_UNPACKED_BYTES: u64 = 4_000_000_000;
/// A name or a link's target, at most.
const MAX_NAME: usize = 1_024;
/// A download that moves no byte for this long is stopped.
pub const STALL_WAIT: Duration = Duration::from_secs(60);
/// The whole download, at most.
pub const DOWNLOAD_WAIT: Duration = Duration::from_secs(60 * 60);
/// Unpacking, at most (about 2 seconds for v0.40.16 on the build Mac).
pub const UNPACK_WAIT: Duration = Duration::from_secs(300);
/// Gatekeeper's assessment, at most (6 seconds measured).
pub const ASSESS_WAIT: Duration = Duration::from_secs(120);
/// How long Ozzie waits for Ollama's server once the app is open.
pub const SERVER_WAIT: Duration = Duration::from_secs(120);
/// After this, the page says Ollama is still starting.
pub const STILL_STARTING: Duration = Duration::from_secs(20);
/// How often the server is asked, and how often Stop and a stall are looked at.
pub const POLL: Duration = Duration::from_secs(1);
/// The progress the page is told, at most this often (a new step is told at once).
pub const REPORT_EVERY: Duration = Duration::from_millis(250);
/// The folder in Ozzie's caches folder that holds the work.
pub const WORK_FOLDER: &str = "ollama-install";
/// What Ozzie did, in the app data folder.
pub const RECORD_FILE: &str = "ollama-install.json";
/// Endings kept in the record.
const RECORD_KEEP: usize = 20;
/// The archive and its unpacked app, together, are about 4.2 times the archive (v0.40.16): five times, and a gigabyte
/// more so the Mac keeps room to work.
pub fn room_needed(archive: u64) -> u64 {
    archive.saturating_mul(5).saturating_add(1_000_000_000)
}

// ---- What the page reads ------------------------------------------------------------------------------------------

/// The steps the page says.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    /// Asking ollama.com for the app.
    Starting,
    Downloading,
    /// Unpacking and verifying.
    Checking,
    /// Moving it into Applications.
    Installing,
    /// Opening it and waiting for its server.
    Opening,
    /// Still waiting, after `STILL_STARTING`.
    StillStarting,
}
/// How getting Ollama ended (closed words; the page has a sentence for each).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum End {
    /// Installed, opened, and its server answers.
    Ready,
    /// The person pressed Stop.
    Cancelled,
    /// ollama.com (or GitHub) couldn't be reached.
    Offline,
    /// A redirect left the allowed hosts, or wasn't https, or there were too many.
    Redirected,
    /// The download said it was larger than `MAX_DOWNLOAD_BYTES`, or brought more than it said.
    TooLarge,
    /// No byte for `STALL_WAIT`, or the whole download took longer than `DOWNLOAD_WAIT`.
    Stalled,
    /// Not a 200 with a size, or fewer bytes than it said, or the file couldn't be written.
    DownloadFailed,
    /// Not enough free space for the archive and the app.
    NoRoom,
    /// The archive isn't the plain Ollama app it should be (`check_zip`, unzip, `check_tree`).
    BadArchive,
    /// The app isn't signed, or its signature is broken.
    NotSigned,
    /// Signed, but not by Ollama's team with a Developer ID.
    WrongTeam,
    /// Signed by Ollama's team, but not Ollama's app.
    WrongApp,
    /// Not notarized, or Gatekeeper doesn't accept it as notarized.
    NotNotarized,
    /// Ollama's own app, but older than `MIN_VERSION`.
    Outdated,
    /// An Ollama is already in Applications: never replaced.
    AlreadyInstalled,
    /// Applications needs an administrator's password (or is on another disk): the checked app is shown in Finder.
    CantInstall,
    /// The move failed another way, or what is in Applications afterwards isn't what was moved.
    InstallFailed,
    /// It is installed, but opening it failed.
    WontOpen,
    /// It is installed and opened, but its server didn't answer within `SERVER_WAIT`.
    NotAnswering,
    /// Anything else (Ozzie's own folder couldn't be made).
    Failed,
}
impl End {
    /// Ollama is in Applications because of this job.
    pub fn installed(self) -> bool {
        matches!(self, Self::Ready | Self::WontOpen | Self::NotAnswering)
    }
}
/// What the one job is doing, or how it ended: numbers and closed words only.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Progress {
    pub phase: Phase,
    pub done_bytes: u64,
    /// 0 until the answer said its size.
    pub total_bytes: u64,
    pub end: Option<End>,
}
impl Progress {
    pub fn starting() -> Self {
        Self {
            phase: Phase::Starting,
            done_bytes: 0,
            total_bytes: 0,
            end: None,
        }
    }
}
/// Why getting Ollama can't start (the page has a sentence for each).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Refusal {
    /// It is already under way.
    Busy,
    /// No model Ozzie offers fits this Mac's memory (16 GB or more needed): Ollama is never offered there.
    TooSmall,
    /// Ollama.app is in /Applications or ~/Applications already.
    AlreadyInstalled,
    /// Ollama's server answers already.
    AlreadyRunning,
    /// Ozzie's folders couldn't be read.
    Unavailable,
}
/// Whether getting Ollama may start, from what was just found: never on a Mac too small for every model Ozzie offers,
/// never over an Ollama that is installed or running.
pub fn may_start(found: &local_ai::LocalFind) -> Result<(), Refusal> {
    if found.advice == "too-small" {
        return Err(Refusal::TooSmall);
    }
    let ollama = found.apps.iter().find(|a| a.app == local_ai::App::Ollama);
    if ollama.is_some_and(|a| a.running) {
        return Err(Refusal::AlreadyRunning);
    }
    if ollama.is_some_and(|a| a.installed) {
        return Err(Refusal::AlreadyInstalled);
    }
    Ok(())
}

// ---- Where the download may go ------------------------------------------------------------------------------------

/// The download's address and the hosts it may pass through.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Policy {
    pub start: String,
    pub https_only: bool,
    /// Exact `host` (or `host:port`, tests only), lowercase.
    pub hosts: Vec<String>,
}
impl Policy {
    /// The only policy the app uses.
    pub fn official() -> Self {
        Self {
            start: DOWNLOAD_URL.into(),
            https_only: true,
            hosts: DOWNLOAD_HOSTS.iter().map(|h| (*h).into()).collect(),
        }
    }
    /// A step of the download may go to `url`.
    pub fn allows(&self, url: &url::Url) -> bool {
        let scheme_ok = url.scheme() == "https" || (!self.https_only && url.scheme() == "http");
        let Some(host) = url.host_str() else {
            return false;
        };
        let authority = match url.port() {
            Some(port) => format!("{host}:{port}"),
            None => host.to_owned(),
        };
        let path_ok = match host {
            "github.com" => url.path().starts_with(GITHUB_RELEASES),
            "ollama.com" => url.path().starts_with(OLLAMA_DOWNLOADS),
            _ => true,
        };
        scheme_ok
            && url.username().is_empty()
            && url.password().is_none()
            && self.hosts.iter().any(|h| *h == authority)
            && path_ok
    }
    /// Where a redirect from `from` to `location` goes, when it may.
    pub fn next(&self, from: &url::Url, location: &str) -> Option<url::Url> {
        let to = from.join(location.trim()).ok()?;
        self.allows(&to).then_some(to)
    }
}

// ---- Downloading --------------------------------------------------------------------------------------------------

/// An answer's head: its status, where it redirects, and the size it says.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Head {
    pub status: u16,
    pub location: Option<String>,
    pub length: Option<u64>,
}
/// What one GET brought.
pub enum Heard<'a> {
    Head(&'a Head),
    Bytes(&'a [u8]),
    /// About `POLL` passed with nothing: Stop and a stall are looked at.
    Quiet,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FetchFailure {
    /// No connection could be made (offline, no such host, TLS refused).
    Unreachable,
    /// The connection broke or timed out while the answer came.
    Broken,
}
/// How the download reaches the internet: one GET, no redirect followed, no proxy.
pub trait Fetch {
    /// GETs `url`: `heard` gets the head once, then each piece of the body, and `Quiet` about every `POLL` with
    /// nothing; returning false closes the connection. Ok when the body ended or was closed.
    fn get(&self, url: &url::Url, heard: &mut dyn FnMut(Heard<'_>) -> bool) -> Result<(), FetchFailure>;
}

/// The real download: rustls with the built-in roots, https only, no proxy, no redirect followed (Ozzie follows them by
/// hand, each one checked), no retry. The request is sent and read on a thread of its own, so Stop and a stall are
/// heard every `POLL` however long the network takes; closing drops the connection.
pub struct NativeFetch {
    client: reqwest::blocking::Client,
}
impl NativeFetch {
    pub fn new() -> Option<Self> {
        Self::build(true)
    }
    /// Plain http too: only for the loopback fake in this crate's tests.
    #[cfg(test)]
    pub(crate) fn for_loopback_tests() -> Option<Self> {
        Self::build(false)
    }
    fn build(https_only: bool) -> Option<Self> {
        reqwest::blocking::Client::builder()
            .https_only(https_only)
            .no_proxy()
            .retry(reqwest::retry::never())
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(15))
            // Each wait: for the head, and for each piece of the body (reqwest's blocking reads wait this long each).
            .timeout(Duration::from_secs(30))
            .user_agent("Ozzie (https://ozzie.church)")
            .build()
            .ok()
            .map(|client| Self { client })
    }
}
enum Piece {
    Head(Head),
    Bytes(Vec<u8>),
    Done,
    Failed(FetchFailure),
}
impl Fetch for NativeFetch {
    fn get(&self, url: &url::Url, heard: &mut dyn FnMut(Heard<'_>) -> bool) -> Result<(), FetchFailure> {
        let (tx, rx) = std::sync::mpsc::sync_channel::<Piece>(8);
        let request = self.client.get(url.as_str()).header("Accept", "*/*");
        // The reader stops at its next send once this side has gone (Stop, a stall, a refusal).
        std::thread::Builder::new()
            .name("ozzie-ollama-download".into())
            .spawn(move || {
                let mut response = match request.send() {
                    Ok(response) => response,
                    Err(error) => {
                        let _ = tx.send(Piece::Failed(if error.is_connect() || error.is_builder() {
                            FetchFailure::Unreachable
                        } else {
                            FetchFailure::Broken
                        }));
                        return;
                    }
                };
                let head = Head {
                    status: response.status().as_u16(),
                    location: response
                        .headers()
                        .get(reqwest::header::LOCATION)
                        .and_then(|v| v.to_str().ok())
                        .filter(|v| v.len() <= 4_096)
                        .map(str::to_owned),
                    length: response
                        .headers()
                        .get(reqwest::header::CONTENT_LENGTH)
                        .and_then(|v| v.to_str().ok())
                        .and_then(|v| v.trim().parse().ok()),
                };
                if tx.send(Piece::Head(head)).is_err() {
                    return;
                }
                let mut buffer = vec![0u8; 65_536];
                loop {
                    match response.read(&mut buffer) {
                        Ok(0) => {
                            let _ = tx.send(Piece::Done);
                            return;
                        }
                        Ok(n) => {
                            if tx.send(Piece::Bytes(buffer[..n].to_vec())).is_err() {
                                return;
                            }
                        }
                        Err(_) => {
                            let _ = tx.send(Piece::Failed(FetchFailure::Broken));
                            return;
                        }
                    }
                }
            })
            .map_err(|_| FetchFailure::Unreachable)?;
        loop {
            match rx.recv_timeout(POLL) {
                Ok(Piece::Head(head)) => {
                    if !heard(Heard::Head(&head)) {
                        return Ok(());
                    }
                }
                Ok(Piece::Bytes(bytes)) => {
                    if !heard(Heard::Bytes(&bytes)) {
                        return Ok(());
                    }
                }
                Ok(Piece::Done) => return Ok(()),
                Ok(Piece::Failed(failure)) => return Err(failure),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    if !heard(Heard::Quiet) {
                        return Ok(());
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return Err(FetchFailure::Broken),
            }
        }
    }
}

/// The waits of one job; tests shorten them.
#[derive(Clone, Copy, Debug)]
pub struct Waits {
    pub stall: Duration,
    pub download: Duration,
    pub server: Duration,
    pub still_starting: Duration,
    pub poll: Duration,
}
impl Waits {
    pub const REAL: Self = Self {
        stall: STALL_WAIT,
        download: DOWNLOAD_WAIT,
        server: SERVER_WAIT,
        still_starting: STILL_STARTING,
        poll: POLL,
    };
}

/// Downloads the archive into `file` (created new, 0600, never through a link), following redirects by hand under
/// `policy`. `room` says whether this Mac has room for an archive of the size the answer said. Ok with its size once
/// every byte it said came; otherwise how it ended, and `file` is gone.
pub fn download(
    fetch: &dyn Fetch,
    policy: &Policy,
    file: &Path,
    cancel: &AtomicBool,
    waits: Waits,
    room: &dyn Fn(u64) -> bool,
    report: &mut dyn FnMut(Phase, u64, u64),
) -> Result<u64, End> {
    let got = download_into(fetch, policy, file, cancel, waits, room, report);
    if got.is_err() {
        let _ = std::fs::remove_file(file);
    }
    got
}
fn download_into(
    fetch: &dyn Fetch,
    policy: &Policy,
    file: &Path,
    cancel: &AtomicBool,
    waits: Waits,
    room: &dyn Fn(u64) -> bool,
    report: &mut dyn FnMut(Phase, u64, u64),
) -> Result<u64, End> {
    let mut url = url::Url::parse(&policy.start).map_err(|_| End::Redirected)?;
    if !policy.allows(&url) {
        return Err(End::Redirected);
    }
    let started = Instant::now();
    for _hop in 0..=MAX_REDIRECTS {
        let mut out: Option<File> = None;
        let mut outcome: Option<Result<(), End>> = None;
        let mut next: Option<url::Url> = None;
        let (mut done, mut total) = (0u64, 0u64);
        let mut moved = Instant::now();
        let mut told = Instant::now().checked_sub(REPORT_EVERY).unwrap_or_else(Instant::now);
        let mut heard = |what: Heard<'_>| -> bool {
            match what {
                Heard::Head(head) => match head.status {
                    301 | 302 | 303 | 307 | 308 => {
                        match head.location.as_deref().and_then(|l| policy.next(&url, l)) {
                            Some(to) => next = Some(to),
                            None => outcome = Some(Err(End::Redirected)),
                        }
                        return false;
                    }
                    200 => {
                        let Some(length) = head.length.filter(|l| *l > 0) else {
                            outcome = Some(Err(End::DownloadFailed));
                            return false;
                        };
                        if length > MAX_DOWNLOAD_BYTES {
                            outcome = Some(Err(End::TooLarge));
                            return false;
                        }
                        if !room(length) {
                            outcome = Some(Err(End::NoRoom));
                            return false;
                        }
                        match create_private_file(file) {
                            Ok(f) => out = Some(f),
                            Err(_) => {
                                outcome = Some(Err(End::DownloadFailed));
                                return false;
                            }
                        }
                        total = length;
                        report(Phase::Downloading, 0, total);
                        moved = Instant::now();
                    }
                    _ => {
                        outcome = Some(Err(End::DownloadFailed));
                        return false;
                    }
                },
                Heard::Bytes(bytes) => {
                    let Some(f) = out.as_mut() else {
                        outcome = Some(Err(End::DownloadFailed));
                        return false;
                    };
                    done = done.saturating_add(bytes.len() as u64);
                    if done > total {
                        outcome = Some(Err(End::TooLarge));
                        return false;
                    }
                    if f.write_all(bytes).is_err() {
                        outcome = Some(Err(End::DownloadFailed));
                        return false;
                    }
                    moved = Instant::now();
                    if told.elapsed() >= REPORT_EVERY {
                        report(Phase::Downloading, done, total);
                        told = Instant::now();
                    }
                }
                Heard::Quiet => {}
            }
            if cancel.load(Ordering::SeqCst) {
                outcome = Some(Err(End::Cancelled));
                return false;
            }
            if moved.elapsed() >= waits.stall || started.elapsed() >= waits.download {
                outcome = Some(Err(End::Stalled));
                return false;
            }
            true
        };
        let fetched = fetch.get(&url, &mut heard);
        if let Some(ended) = outcome {
            return ended.map(|()| total);
        }
        if let Some(to) = next {
            url = to;
            continue;
        }
        return match fetched {
            Err(FetchFailure::Unreachable) => Err(End::Offline),
            Err(FetchFailure::Broken) => Err(End::DownloadFailed),
            Ok(()) => {
                let Some(mut f) = out else {
                    return Err(End::DownloadFailed);
                };
                if done != total || f.flush().and_then(|()| f.sync_all()).is_err() {
                    return Err(End::DownloadFailed);
                }
                report(Phase::Downloading, done, total);
                Ok(total)
            }
        };
    }
    Err(End::Redirected)
}
/// A new file only this user can read or write, never opened through a link.
fn create_private_file(path: &Path) -> std::io::Result<File> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
}

// ---- Ozzie's own folders ------------------------------------------------------------------------------------------

/// `path` as a folder only this user can use: made 0700 if absent; refused when it is a link, isn't a folder, or
/// belongs to someone else. Its permissions are made 0700 if they were wider.
pub(crate) fn private_dir(path: &Path) -> std::io::Result<()> {
    match std::fs::DirBuilder::new().mode(0o700).create(path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e),
    }
    let meta = std::fs::symlink_metadata(path)?;
    // SAFETY: geteuid has no preconditions and can't fail.
    let me = unsafe { libc::geteuid() };
    if !meta.file_type().is_dir() || meta.uid() != me {
        return Err(std::io::ErrorKind::PermissionDenied.into());
    }
    if meta.mode() & 0o077 != 0 {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}
/// Ozzie's work folder inside `caches`: `ollama-install`, private.
pub fn work_root(caches: &Path) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(caches)?;
    let root = caches.join(WORK_FOLDER);
    private_dir(&root)?;
    Ok(root)
}
/// Where a checked app waits for the person to drag it into Applications (`CantInstall`).
pub fn kept_app(caches: &Path) -> PathBuf {
    caches.join(WORK_FOLDER).join("ready").join(APP_NAME)
}
/// How long a work folder is left alone by the clean-up at start: a copy of Ozzie that quit mid-way may have left unzip
/// or spctl finishing in it (review, 2026-11-19). A new job removes them all.
pub const CLEAN_SETTLED: Duration = Duration::from_secs(10 * 60);
/// Held for a job's whole run, and by the clean-up at start: a second copy of Ozzie never works in, or cleans, the same
/// folder at the same time (`flock` on `ollama-install/.lock`; released when it closes, a quit included).
pub struct Lock(#[allow(dead_code)] File);
pub fn lock(root: &Path) -> Option<Lock> {
    use std::os::fd::AsRawFd;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(root.join(".lock"))
        .ok()?;
    // SAFETY: the descriptor is open for the call; flock only takes an advisory lock on it.
    let locked = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0;
    locked.then_some(Lock(file))
}
/// Something at the work folder's place that isn't a folder (a link) is removed itself, never followed.
fn clear_link(caches: &Path) {
    let root = caches.join(WORK_FOLDER);
    if std::fs::symlink_metadata(&root).is_ok_and(|m| !m.file_type().is_dir()) {
        let _ = std::fs::remove_file(&root);
    }
}
/// At start: what an earlier job left (a quit or a crash mid-way), every `work-*` folder untouched for `settled`; with
/// `ready` too, the checked app kept for the person to drag. Only with the lock, and only inside Ozzie's own folder.
pub fn clean(caches: &Path, ready: bool, settled: Duration) {
    clear_link(caches);
    if !caches.join(WORK_FOLDER).is_dir() {
        return;
    }
    let Ok(root) = work_root(caches) else {
        return;
    };
    let Some(_lock) = lock(&root) else {
        return;
    };
    clean_in(&root, ready, settled);
}
/// Removes `work-*` folders untouched for `settled` (and `ready` when asked) in `root`, without following any link.
fn clean_in(root: &Path, ready: bool, settled: Duration) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let path = entry.path();
        let old = std::fs::symlink_metadata(&path)
            .and_then(|m| m.modified())
            .is_ok_and(|t| t.elapsed().unwrap_or_default() >= settled);
        if (name.starts_with("work-") && old) || (ready && name == "ready") {
            match std::fs::symlink_metadata(&path) {
                Ok(m) if m.file_type().is_dir() => {
                    let _ = std::fs::remove_dir_all(&path);
                }
                Ok(_) => {
                    let _ = std::fs::remove_file(&path);
                }
                Err(_) => {}
            }
        }
    }
}
/// A fresh private folder for one job.
fn new_work(root: &Path) -> std::io::Result<PathBuf> {
    let mut bytes = [0u8; 8];
    getrandom::fill(&mut bytes).map_err(|_| std::io::ErrorKind::Other)?;
    let name: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let work = root.join(format!("work-{name}"));
    std::fs::DirBuilder::new().mode(0o700).create(&work)?;
    private_dir(&work)?;
    Ok(work)
}

// ---- Reading the archive ------------------------------------------------------------------------------------------

/// What one archive entry is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Kind {
    Folder,
    File { size: u64 },
    Link { target: String },
}
/// What the archive holds, read without unpacking it: names (each under `Ollama.app/`, no trailing slash) and kinds.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct Plan {
    pub entries: BTreeMap<String, Kind>,
    pub unpacked_bytes: u64,
}
const EOCD: u32 = 0x0605_4b50;
const CENTRAL: u32 = 0x0201_4b50;
const LOCAL: u32 = 0x0403_4b50;
const DESCRIPTOR: u32 = 0x0807_4b50;
fn u16_at(b: &[u8], at: usize) -> Option<u64> {
    b.get(at..at + 2).map(|s| u64::from(u16::from_le_bytes([s[0], s[1]])))
}
fn u32_at(b: &[u8], at: usize) -> Option<u64> {
    b.get(at..at + 4)
        .map(|s| u64::from(u32::from_le_bytes([s[0], s[1], s[2], s[3]])))
}
fn read_at(file: &mut File, at: u64, len: usize) -> Option<Vec<u8>> {
    file.seek(SeekFrom::Start(at)).ok()?;
    let mut bytes = vec![0u8; len];
    file.read_exact(&mut bytes).ok()?;
    Some(bytes)
}
/// The extra fields a zip tool writes for times and owners only: 0x5455 (extended time), 0x5855 (Info-ZIP's old Unix
/// times and owner: all the real v0.40.16 archive has), 0x7875 (Info-ZIP's Unix owner). None of them can name a file, a
/// path or a link's target, as 0x7075 (a Unicode name), 0x756e and 0x000d (Unix fields with a link's target) can, so a
/// tool reading those couldn't make a name or kind other than the one checked (review, 2026-11-19).
const EXTRA_FIELDS: [u64; 3] = [0x5455, 0x5855, 0x7875];
/// The extra field bytes are whole records, each one of `EXTRA_FIELDS`.
fn extra_ok(bytes: &[u8]) -> bool {
    let mut at = 0;
    while at < bytes.len() {
        let (Some(id), Some(len)) = (u16_at(bytes, at), u16_at(bytes, at + 2)) else {
            return false;
        };
        if !EXTRA_FIELDS.contains(&id) {
            return false;
        }
        at += 4 + len as usize;
    }
    at == bytes.len()
}
/// One name's parts, when it is a plain relative name under `Ollama.app`: printable ASCII, no backslash or colon, no
/// empty, `.` or `..` part. A folder's trailing slash is dropped.
fn plain_name(raw: &[u8], folder: bool) -> Option<Vec<String>> {
    if raw.is_empty() || raw.len() > MAX_NAME || !raw.iter().all(|b| (0x20..0x7f).contains(b)) {
        return None;
    }
    let text = std::str::from_utf8(raw).ok()?;
    if text.contains('\\') || text.contains(':') || text.starts_with('/') {
        return None;
    }
    let text = match (folder, text.strip_suffix('/')) {
        (true, Some(stripped)) => stripped,
        (false, None) => text,
        _ => return None,
    };
    let parts: Vec<String> = text.split('/').map(str::to_owned).collect();
    if parts.iter().any(|p| p.is_empty() || p == "." || p == "..") || parts[0] != APP_NAME {
        return None;
    }
    Some(parts)
}
/// Where the link at `link` (its parts) ends up, followed through every link in `links` (by lowercase name, as APFS
/// matches names) as the system would; None when it leaves `Ollama.app`, reaches the app's own folder, or goes round.
fn resolve(link: &[String], links: &BTreeMap<String, String>) -> Option<Vec<String>> {
    let mut todo: Vec<String> = link.iter().rev().cloned().collect();
    let mut at: Vec<String> = Vec::new();
    let mut hops = 0;
    while let Some(part) = todo.pop() {
        match part.as_str() {
            "" | "." => continue,
            // Never above the app's own folder, even on the way back into it.
            ".." => {
                at.pop()?;
                if at.is_empty() {
                    return None;
                }
                continue;
            }
            _ => {}
        }
        at.push(part);
        let key = at.join("/").to_ascii_lowercase();
        if let Some(target) = links.get(&key) {
            hops += 1;
            if hops > 32 || target.starts_with('/') {
                return None;
            }
            at.pop();
            for piece in target.split('/').rev() {
                todo.push(piece.to_owned());
            }
        }
        if at.is_empty() {
            return None;
        }
    }
    (at.len() >= 2 && at[0] == APP_NAME).then_some(at)
}
/// Reads the archive's central directory and local headers without unpacking anything. Refused (None) unless it is
/// exactly what the Ollama app's archive should be: see the module's step 2.
pub fn check_zip(path: &Path) -> Option<Plan> {
    let mut file = File::open(path).ok()?;
    let length = file.metadata().ok()?.len();
    if length < 22 || length > MAX_DOWNLOAD_BYTES {
        return None;
    }
    // The end record: the last 22 bytes plus a comment of at most 64 KB.
    let tail_len = length.min(22 + 65_535) as usize;
    let tail = read_at(&mut file, length - tail_len as u64, tail_len)?;
    let at = (0..=tail_len - 22).rev().find(|&i| {
        u32_at(&tail, i) == Some(u64::from(EOCD)) && i + 22 + u16_at(&tail, i + 20).unwrap_or(0) as usize == tail_len
    })?;
    let eocd_at = length - tail_len as u64 + at as u64;
    let field = |offset| u16_at(&tail, at + offset);
    let (disk, cd_disk, here, count) = (field(4)?, field(6)?, field(8)?, field(10)?);
    let (cd_size, cd_at) = (u32_at(&tail, at + 12)?, u32_at(&tail, at + 16)?);
    // One disk, no ZIP64 (its markers are all-ones), the directory right before the end record, a sane count.
    if disk != 0 || cd_disk != 0 || here != count || count == 0xFFFF || cd_at == 0xFFFF_FFFF {
        return None;
    }
    if count == 0 || count as usize > MAX_ENTRIES || cd_at.checked_add(cd_size)? != eocd_at {
        return None;
    }
    let directory = read_at(&mut file, cd_at, usize::try_from(cd_size).ok()?)?;
    struct Entry {
        parts: Vec<String>,
        kind: Kind,
        flags: u64,
        method: u64,
        crc: u64,
        packed: u64,
        size: u64,
        offset: u64,
    }
    let mut entries: Vec<Entry> = Vec::new();
    let mut pos = 0usize;
    for _ in 0..count {
        if u32_at(&directory, pos)? != u64::from(CENTRAL) {
            return None;
        }
        let made_by = u16_at(&directory, pos + 4)?;
        let flags = u16_at(&directory, pos + 8)?;
        let method = u16_at(&directory, pos + 10)?;
        let crc = u32_at(&directory, pos + 16)?;
        let packed = u32_at(&directory, pos + 20)?;
        let size = u32_at(&directory, pos + 24)?;
        let name_len = u16_at(&directory, pos + 28)? as usize;
        let extra_len = u16_at(&directory, pos + 30)? as usize;
        let comment_len = u16_at(&directory, pos + 32)? as usize;
        let start_disk = u16_at(&directory, pos + 34)?;
        let mode = u32_at(&directory, pos + 38)? >> 16;
        let offset = u32_at(&directory, pos + 42)?;
        let raw = directory.get(pos + 46..pos + 46 + name_len)?;
        if !extra_ok(directory.get(pos + 46 + name_len..pos + 46 + name_len + extra_len)?) {
            return None;
        }
        // Unix entries only (their modes say what each is); only the deflate options, a data descriptor and UTF-8
        // names among the flags (never encryption); stored or deflated; no ZIP64 sizes.
        if made_by >> 8 != 3
            || (flags & !0b1000_0000_1110) != 0
            || !(method == 0 || method == 8)
            || start_disk != 0
            || [packed, size, offset].contains(&0xFFFF_FFFF)
        {
            return None;
        }
        // A data descriptor only after deflated data (as the real archive has it); stored data is exactly its size, so
        // its end never depends on how a reader decodes it.
        if (flags & 0b1000 != 0 && method != 8) || (method == 0 && packed != size) {
            return None;
        }
        // Set-id bits, the sticky bit, and anything others could write are never unpacked.
        if mode & 0o7022 != 0 {
            return None;
        }
        let kind = match mode & 0o170000 {
            0o040000 if size == 0 => Kind::Folder,
            0o100000 => Kind::File { size },
            0o120000 if method == 0 && packed == size && (1..=MAX_NAME as u64).contains(&size) => Kind::Link {
                target: String::new(),
            },
            _ => return None,
        };
        let parts = plain_name(raw, kind == Kind::Folder)?;
        entries.push(Entry {
            parts,
            kind,
            flags,
            method,
            crc,
            packed,
            size,
            offset,
        });
        pos += 46 + name_len + extra_len + comment_len;
    }
    if pos != directory.len() {
        return None;
    }
    // The local headers, end to end in the directory's order of offsets, from the first byte to the directory: no
    // gap, no overlap, no entry the directory doesn't name.
    entries.sort_by_key(|e| e.offset);
    let mut at_byte = 0u64;
    for entry in &mut entries {
        if entry.offset != at_byte {
            return None;
        }
        let header = read_at(&mut file, entry.offset, 30)?;
        let name_len = u16_at(&header, 26)?;
        let extra_len = u16_at(&header, 28)?;
        let flags = u16_at(&header, 6)?;
        if u32_at(&header, 0)? != u64::from(LOCAL)
            || (flags & 0b1000) != (entry.flags & 0b1000)
            || u16_at(&header, 8)? != entry.method
        {
            return None;
        }
        let name = read_at(&mut file, entry.offset + 30, name_len as usize)?;
        if !extra_ok(&read_at(&mut file, entry.offset + 30 + name_len, extra_len as usize)?) {
            return None;
        }
        let mut expected = entry.parts.join("/");
        if entry.kind == Kind::Folder {
            expected.push('/');
        }
        if name != expected.as_bytes() {
            return None;
        }
        let data = entry.offset + 30 + name_len + extra_len;
        let end = data.checked_add(entry.packed)?;
        if flags & 0b1000 == 0 {
            if (u32_at(&header, 14)?, u32_at(&header, 18)?, u32_at(&header, 22)?) != (entry.crc, entry.packed, entry.size) {
                return None;
            }
            at_byte = end;
        } else {
            // The local header leaves its sizes to the descriptor (zero), as zip tools write it.
            if (u32_at(&header, 14)?, u32_at(&header, 18)?, u32_at(&header, 22)?) != (0, 0, 0) {
                return None;
            }
            // A data descriptor follows the data, with or without its signature, and says what the directory says.
            let tail = read_at(&mut file, end, 16.min(cd_at.checked_sub(end)? as usize))?;
            let skip = if u32_at(&tail, 0) == Some(u64::from(DESCRIPTOR)) { 4 } else { 0 };
            if (u32_at(&tail, skip)?, u32_at(&tail, skip + 4)?, u32_at(&tail, skip + 8)?) != (entry.crc, entry.packed, entry.size) {
                return None;
            }
            at_byte = end + 12 + skip as u64;
        }
        if at_byte > cd_at {
            return None;
        }
        if let Kind::Link { target } = &mut entry.kind {
            let raw = read_at(&mut file, data, entry.size as usize)?;
            if !raw.iter().all(|b| (0x20..0x7f).contains(b)) || raw.contains(&b'\\') || raw.contains(&b':') {
                return None;
            }
            *target = String::from_utf8(raw).ok()?;
        }
    }
    if at_byte != cd_at {
        return None;
    }
    // Names APFS would take for one (it ignores case by default), and the size unpacked.
    let mut seen = BTreeSet::new();
    let mut unpacked = 0u64;
    for entry in &entries {
        if !seen.insert(entry.parts.join("/").to_ascii_lowercase()) {
            return None;
        }
        if let Kind::File { size } = entry.kind {
            unpacked = unpacked.checked_add(size)?;
        }
    }
    if unpacked > MAX_UNPACKED_BYTES {
        return None;
    }
    // Every entry's parents are folders: never a file or a link that unpacking could write through.
    let not_folders: BTreeSet<String> = entries
        .iter()
        .filter(|e| e.kind != Kind::Folder)
        .map(|e| e.parts.join("/").to_ascii_lowercase())
        .collect();
    let links: BTreeMap<String, String> = entries
        .iter()
        .filter_map(|e| match &e.kind {
            Kind::Link { target } => Some((e.parts.join("/").to_ascii_lowercase(), target.clone())),
            _ => None,
        })
        .collect();
    for entry in &entries {
        // No entry is reached through a link or a file: unpacking could otherwise write where a link points.
        for depth in 1..entry.parts.len() {
            if not_folders.contains(&entry.parts[..depth].join("/").to_ascii_lowercase()) {
                return None;
            }
        }
        // Every link, followed as the system would, stays inside the app.
        if let Kind::Link { target } = &entry.kind {
            if target.starts_with('/') {
                return None;
            }
            let mut from = entry.parts[..entry.parts.len() - 1].to_vec();
            from.extend(target.split('/').map(str::to_owned));
            resolve(&from, &links)?;
        }
    }
    Some(Plan {
        entries: entries
            .into_iter()
            .map(|e| (e.parts.join("/"), e.kind))
            .collect(),
        unpacked_bytes: unpacked,
    })
}

/// The tree `unzip` made in `unpacked` is exactly the plan: only `Ollama.app` at the top, every entry the plan's kind
/// (folders the plan implies included), every file its size, every link its target, all of it this user's, none with a
/// set-id bit or writable by others, and no second link to a file. Read without following any link.
pub fn check_tree(unpacked: &Path, plan: &Plan) -> bool {
    // SAFETY: geteuid has no preconditions and can't fail.
    let me = unsafe { libc::geteuid() };
    let mut implied: BTreeSet<String> = BTreeSet::new();
    for name in plan.entries.keys() {
        let parts: Vec<&str> = name.split('/').collect();
        for depth in 1..parts.len() {
            implied.insert(parts[..depth].join("/"));
        }
    }
    let Ok(top) = std::fs::read_dir(unpacked) else {
        return false;
    };
    let top: Vec<_> = top.flatten().map(|e| e.file_name()).collect();
    if top.len() != 1 || top[0] != APP_NAME {
        return false;
    }
    let mut found: BTreeSet<String> = BTreeSet::new();
    let mut todo = vec![APP_NAME.to_owned()];
    while let Some(name) = todo.pop() {
        if found.len() > MAX_ENTRIES * 2 {
            return false;
        }
        let path = unpacked.join(&name);
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            return false;
        };
        if meta.uid() != me || (!meta.file_type().is_symlink() && meta.mode() & 0o7022 != 0) {
            return false;
        }
        let ok = match plan.entries.get(&name) {
            Some(Kind::Folder) => meta.file_type().is_dir(),
            None if implied.contains(&name) => meta.file_type().is_dir(),
            Some(Kind::File { size }) => meta.file_type().is_file() && meta.len() == *size && meta.nlink() == 1,
            Some(Kind::Link { target }) => {
                meta.file_type().is_symlink()
                    && std::fs::read_link(&path).is_ok_and(|t| t.as_os_str() == std::ffi::OsStr::new(target))
            }
            None => false,
        };
        if !ok {
            return false;
        }
        found.insert(name.clone());
        if meta.file_type().is_dir() {
            let Ok(children) = std::fs::read_dir(&path) else {
                return false;
            };
            for child in children.flatten() {
                let Some(child) = child.file_name().to_str().map(str::to_owned) else {
                    return false;
                };
                todo.push(format!("{name}/{child}"));
            }
        }
    }
    plan.entries.keys().all(|name| found.contains(name)) && implied.iter().all(|name| found.contains(name))
}

/// Unpacks a checked archive into a folder.
pub trait Unpack {
    /// Unpacks `zip` (read as `plan`) into `into`; false when it failed, took longer than `UNPACK_WAIT`, or wrote more
    /// than the plan says. Stop isn't heard here: a late press doesn't turn a good archive into a bad one.
    fn unpack(&self, zip: &Path, into: &Path, plan: &Plan) -> bool;
}
/// What unpacking may write beyond the files' own sizes before it is stopped.
pub const UNPACK_SLACK: u64 = 16_000_000;
/// Apple's own `/usr/bin/unzip` (Info-ZIP 6.00 with Apple's changes), the tool Ollama's install script uses, which
/// keeps the app's signature whole (the real v0.40.16 archive: codesign and Gatekeeper accept what it unpacks). It finds
/// each entry through the central directory `check_zip` read, never by reading the file as a stream, so no entry hidden
/// between the ones read can come out (review, 2026-11-19). `-qq` quiet, `-n` never overwrite; its only arguments that
/// aren't fixed are the archive and the folder, both inside Ozzie's private work folder. It is stopped as soon as the
/// folder holds more than the plan's bytes (`UNPACK_SLACK` more) or entries, so data that inflates beyond what it said
/// can't fill the disk. Nothing it prints is read.
pub struct Unzip;
impl Unpack for Unzip {
    fn unpack(&self, zip: &Path, into: &Path, plan: &Plan) -> bool {
        let child = std::process::Command::new("/usr/bin/unzip")
            .arg("-qq")
            .arg("-n")
            .arg(zip)
            .arg("-d")
            .arg(into)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
        let Ok(mut child) = child else {
            return false;
        };
        let limit = plan.unpacked_bytes.saturating_add(UNPACK_SLACK);
        let within = || written_within(into, limit, plan.entries.len() + 8);
        finished(&mut child, UNPACK_WAIT, &AtomicBool::new(false), &within).is_some_and(|status| status.success())
            && within()
    }
}
/// What is under `dir` is at most `bytes` in files and `entries` entries, read without following any link.
pub fn written_within(dir: &Path, bytes: u64, entries: usize) -> bool {
    let (mut total, mut count) = (0u64, 0usize);
    let mut todo = vec![dir.to_path_buf()];
    while let Some(next) = todo.pop() {
        let Ok(children) = std::fs::read_dir(&next) else {
            continue;
        };
        for child in children.flatten() {
            count += 1;
            if count > entries {
                return false;
            }
            let Ok(meta) = std::fs::symlink_metadata(child.path()) else {
                continue;
            };
            if meta.file_type().is_dir() {
                todo.push(child.path());
            } else {
                total = total.saturating_add(meta.len());
                if total > bytes {
                    return false;
                }
            }
        }
    }
    true
}
/// Waits for a program Ozzie started, at most `wait`, stopping it if `cancel` is set or `within` says it has gone too
/// far; None when it was stopped.
fn finished(
    child: &mut std::process::Child,
    wait: Duration,
    cancel: &AtomicBool,
    within: &dyn Fn() -> bool,
) -> Option<std::process::ExitStatus> {
    let until = Instant::now() + wait;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status),
            Ok(None) if Instant::now() < until && !cancel.load(Ordering::SeqCst) && within() => {
                std::thread::sleep(Duration::from_millis(100));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

// ---- Verifying ----------------------------------------------------------------------------------------------------

/// Why an app isn't Ollama's own (each its own closed ending).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Rejected {
    NotSigned,
    WrongTeam,
    WrongApp,
    NotNotarized,
    Outdated,
}
impl From<Rejected> for End {
    fn from(rejected: Rejected) -> Self {
        match rejected {
            Rejected::NotSigned => Self::NotSigned,
            Rejected::WrongTeam => Self::WrongTeam,
            Rejected::WrongApp => Self::WrongApp,
            Rejected::NotNotarized => Self::NotNotarized,
            Rejected::Outdated => Self::Outdated,
        }
    }
}
/// Proves an app is Ollama's own before it is moved or opened.
pub trait Verifier {
    fn verify(&self, app: &Path) -> Result<(), Rejected>;
}
/// The requirement every check ends with: Apple's anchor, a Developer ID Application certificate issued under
/// Apple's Developer ID authority, Ollama's team, Ollama's identifier, and notarized (the app's own designated
/// requirement, v0.40.16, with `notarized` added).
pub fn requirement(team: &str, bundle_id: &str) -> String {
    format!(
        "anchor apple generic and identifier \"{bundle_id}\" and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \"{team}\" and notarized"
    )
}
/// The real verifier: Security.framework's static code checks, then Gatekeeper's own assessment. `team` and
/// `bundle_id` are this file's pinned constants in the app (`OLLAMA`); tests name others to see each refusal.
#[cfg(target_os = "macos")]
pub struct MacVerifier {
    pub team: &'static str,
    pub bundle_id: &'static str,
    pub min_version: [u64; 3],
}
#[cfg(target_os = "macos")]
impl MacVerifier {
    pub const OLLAMA: Self = Self {
        team: TEAM_ID,
        bundle_id: BUNDLE_ID,
        min_version: MIN_VERSION,
    };
}
#[cfg(target_os = "macos")]
impl Verifier for MacVerifier {
    fn verify(&self, app: &Path) -> Result<(), Rejected> {
        use core_foundation::url::CFURL;
        use security_framework::os::macos::code_signing::{Flags, SecRequirement, SecStaticCode};
        use std::str::FromStr;
        let meta = std::fs::symlink_metadata(app).map_err(|_| Rejected::NotSigned)?;
        if !meta.file_type().is_dir() {
            return Err(Rejected::NotSigned);
        }
        let url = CFURL::from_path(app, true).ok_or(Rejected::NotSigned)?;
        let code = SecStaticCode::from_path(&url, Flags::NONE).map_err(|_| Rejected::NotSigned)?;
        // `codesign --verify --deep --strict`, every architecture, links kept inside the bundle.
        let whole = Flags::STRICT_VALIDATE
            | Flags::CHECK_NESTED_CODE
            | Flags::CHECK_ALL_ARCHITECTURES
            | Flags::RESTRICT_SYMLINKS;
        let holds = |text: &str, flags: Flags| {
            SecRequirement::from_str(text)
                .ok()
                .is_some_and(|req| code.check_validity(flags, &req).is_ok())
        };
        // Whole and signed at all: an unsigned app, or one changed after signing, fails here.
        if !holds("always", whole) {
            return Err(Rejected::NotSigned);
        }
        // Then who signed it, what it is and whether Apple notarized it, each said on its own (the signature was just
        // checked whole, so only the requirement is evaluated here).
        let team = format!(
            "anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \"{}\"",
            self.team
        );
        if !holds(&team, Flags::BASIC_VALIDATE_ONLY) {
            return Err(Rejected::WrongTeam);
        }
        if !holds(&format!("identifier \"{}\"", self.bundle_id), Flags::BASIC_VALIDATE_ONLY) {
            return Err(Rejected::WrongApp);
        }
        // Its Info.plist is sealed by the signature just checked whole.
        if bundle_version(app).is_none_or(|v| v < self.min_version) {
            return Err(Rejected::Outdated);
        }
        if !holds("notarized", Flags::BASIC_VALIDATE_ONLY) {
            return Err(Rejected::NotNotarized);
        }
        // The whole requirement at once, with the whole signature checked again.
        if !holds(&requirement(self.team, self.bundle_id), whole) {
            return Err(Rejected::NotSigned);
        }
        if !gatekeeper_accepts(app, self.team) {
            return Err(Rejected::NotNotarized);
        }
        Ok(())
    }
}
/// An app's `CFBundleShortVersionString` as numbers ("0.40.16" is [0, 40, 16]); None when it isn't one.
#[cfg(target_os = "macos")]
pub fn bundle_version(app: &Path) -> Option<[u64; 3]> {
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::data::CFData;
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::propertylist::{CFPropertyList, create_with_data, kCFPropertyListImmutable};
    use core_foundation::string::CFString;
    let bytes = crate::model::read_small(&app.join("Contents").join("Info.plist")).ok()??;
    let (list, _) = create_with_data(CFData::from_buffer(&bytes), kCFPropertyListImmutable).ok()?;
    // SAFETY: a Create function's result belongs to the caller: wrapped once, released when it drops.
    let list = unsafe { CFPropertyList::wrap_under_create_rule(list) };
    let dict: CFDictionary = list.downcast_into()?;
    let key = CFString::from_static_string("CFBundleShortVersionString");
    let value = dict.find(key.as_CFTypeRef())?;
    // SAFETY: a value the dictionary holds, retained here for as long as it is read.
    let text = unsafe { CFType::wrap_under_get_rule(*value) }.downcast::<CFString>()?.to_string();
    parse_version(&text)
}
/// "0.40.16" as [0, 40, 16]; one to three whole numbers, nothing else.
pub fn parse_version(text: &str) -> Option<[u64; 3]> {
    let parts: Vec<&str> = text.split('.').collect();
    if parts.is_empty() || parts.len() > 3 {
        return None;
    }
    let mut version = [0u64; 3];
    for (slot, part) in version.iter_mut().zip(&parts) {
        if part.is_empty() || part.len() > 9 || !part.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        *slot = part.parse().ok()?;
    }
    Some(version)
}
/// Gatekeeper's own decision (`/usr/sbin/spctl --assess --type execute -vv <app>`): it must accept the app as a
/// notarized Developer ID app from `team`. Its words are read for those fixed lines only and go nowhere; a Mac with
/// Gatekeeper turned off ("override=security disabled") isn't counted as accepting it.
#[cfg(target_os = "macos")]
pub fn gatekeeper_accepts(app: &Path, team: &str) -> bool {
    let child = std::process::Command::new("/usr/sbin/spctl")
        .args(["--assess", "--type", "execute", "-vv"])
        .arg(app)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn();
    let Ok(mut child) = child else {
        return false;
    };
    // Waited for first, then read: its few lines fit the pipe, and a hung assessment is stopped after its wait.
    let Some(status) = finished(&mut child, ASSESS_WAIT, &AtomicBool::new(false), &|| true) else {
        return false;
    };
    let mut said = Vec::new();
    if let Some(stderr) = child.stderr.take() {
        let _ = stderr.take(8_192).read_to_end(&mut said);
    }
    gatekeeper_said(status.success(), &String::from_utf8_lossy(&said), team)
}
/// Whether spctl's words say accepted as a notarized Developer ID app from `team`.
pub fn gatekeeper_said(success: bool, said: &str, team: &str) -> bool {
    let lines: Vec<&str> = said.lines().map(str::trim).collect();
    success
        && lines.iter().any(|l| l.ends_with(": accepted"))
        && lines.contains(&"source=Notarized Developer ID")
        && lines
            .iter()
            .any(|l| l.starts_with("origin=Developer ID Application: ") && l.ends_with(&format!("({team})")))
        && !lines.iter().any(|l| l.starts_with("override="))
}

// ---- Installing and opening ---------------------------------------------------------------------------------------

/// Opens the installed app.
pub trait Opener {
    /// Opens the app at `app`; false when it couldn't be opened.
    fn open(&self, app: &Path) -> bool;
}
/// LaunchServices through `/usr/bin/open`, with the installed app's exact path (never a name another app could
/// answer to).
pub struct OpenApp;
impl Opener for OpenApp {
    fn open(&self, app: &Path) -> bool {
        std::process::Command::new("/usr/bin/open")
            .arg(app)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
    }
}
/// How a move ended.
#[derive(Debug, PartialEq, Eq)]
pub enum Moved {
    Done,
    /// Something is already at the destination: nothing replaced.
    Taken,
    /// The folder needs an administrator, or is on another disk.
    NotAllowed,
    Failed,
}
/// Moves `from` to `to` in one step, never replacing anything there (`renamex_np` with `RENAME_EXCL`).
pub fn move_new(from: &Path, to: &Path) -> Moved {
    use std::os::unix::ffi::OsStrExt;
    let (Ok(from), Ok(to)) = (
        std::ffi::CString::new(from.as_os_str().as_bytes()),
        std::ffi::CString::new(to.as_os_str().as_bytes()),
    ) else {
        return Moved::Failed;
    };
    // SAFETY: both are NUL-terminated strings that outlive the call; the call reads them only.
    let moved = unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) };
    if moved == 0 {
        return Moved::Done;
    }
    match std::io::Error::last_os_error().raw_os_error() {
        Some(libc::EEXIST | libc::ENOTEMPTY) => Moved::Taken,
        Some(libc::EACCES | libc::EPERM | libc::EROFS | libc::EXDEV) => Moved::NotAllowed,
        _ => Moved::Failed,
    }
}
/// The same folder: device and inode.
fn identity(path: &Path) -> Option<(u64, u64)> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    meta.file_type().is_dir().then(|| (meta.dev(), meta.ino()))
}

// ---- What Ozzie did -----------------------------------------------------------------------------------------------

/// One job's ending, as kept for What happened and Settings: a time and closed words, never a path.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Done {
    pub at_ms: u64,
    pub end: End,
}
#[derive(Serialize, Deserialize, Default)]
struct Record {
    #[serde(default)]
    done: Vec<Done>,
}
/// The endings kept, oldest first; none when the file is absent or unreadable.
pub fn history(data: &Path) -> Vec<Done> {
    crate::model::read_small(&data.join(RECORD_FILE))
        .ok()
        .flatten()
        .and_then(|bytes| serde_json::from_slice::<Record>(&bytes).ok())
        .map(|r| r.done)
        .unwrap_or_default()
}
/// Keeps one ending; `replace_last`: it is this job's own, in place of the one kept when Ollama went into Applications.
fn remember(data: &Path, done: Done, replace_last: bool) {
    let mut record = Record { done: history(data) };
    if replace_last {
        record.done.pop();
    }
    record.done.push(done);
    let over = record.done.len().saturating_sub(RECORD_KEEP);
    record.done.drain(..over);
    if let Ok(bytes) = serde_json::to_vec_pretty(&record) {
        // A record that can't be written leaves What happened without this line; nothing else depends on it.
        let _ = crate::model::write_private(&data.join(RECORD_FILE), &bytes);
    }
}
/// When Ozzie last installed Ollama, while an Ollama is still in Applications; None otherwise.
pub fn installed_by_ozzie(data: &Path, destination: &Path) -> Option<u64> {
    if identity(&destination.join(APP_NAME)).is_none() {
        return None;
    }
    history(data).iter().rev().find(|d| d.end.installed()).map(|d| d.at_ms)
}

// ---- The whole job ------------------------------------------------------------------------------------------------

/// One "Download Ollama and set it up", from the press to Ollama answering.
pub struct Job<'a> {
    /// Ozzie's caches folder: the work happens in `ollama-install` there.
    pub caches: &'a Path,
    /// The app data folder: what Ozzie did is kept there.
    pub data: &'a Path,
    /// /Applications in the app; a scratch folder in tests.
    pub destination: &'a Path,
    pub policy: &'a Policy,
    pub fetch: &'a dyn Fetch,
    pub unpack: &'a dyn Unpack,
    pub verifier: &'a dyn Verifier,
    pub opener: &'a dyn Opener,
    /// Ollama's server on this Mac (local_ai's loopback client).
    pub http: &'a dyn LocalHttp,
    /// Free space where the work happens, in bytes; None when it can't be told.
    pub free: &'a dyn Fn(&Path) -> Option<u64>,
    pub cancel: &'a AtomicBool,
    pub clock: &'a dyn Fn() -> u64,
    pub waits: Waits,
}
/// Runs the whole job, telling `report` each step and the bytes; the last `Progress` is how it ended, and that ending
/// is kept in the record.
pub fn run(job: &Job<'_>, report: &mut dyn FnMut(&Progress)) -> Progress {
    let mut now = Progress::starting();
    report(&now);
    let mut kept_installed = false;
    let end = steps(job, &mut now, report, &mut kept_installed);
    now.end = Some(end);
    remember(
        job.data,
        Done {
            at_ms: (job.clock)(),
            end,
        },
        kept_installed,
    );
    now
}
fn steps(job: &Job<'_>, now: &mut Progress, report: &mut dyn FnMut(&Progress), kept_installed: &mut bool) -> End {
    clear_link(job.caches);
    let Ok(root) = work_root(job.caches) else {
        return End::Failed;
    };
    // One job in this folder at a time, across copies of Ozzie too.
    let Some(_lock) = lock(&root) else {
        return End::Failed;
    };
    // What an earlier job left goes first, the checked app kept for dragging included: this job replaces it.
    clean_in(&root, true, Duration::ZERO);
    let Ok(work) = new_work(&root) else {
        return End::Failed;
    };
    let end = in_work(job, &work, now, report, kept_installed);
    // Nothing downloaded stays, whatever happened: an installed app was moved out of here first, and an app the
    // person must drag was moved to `ready`.
    let _ = std::fs::remove_dir_all(&work);
    end
}
fn in_work(
    job: &Job<'_>,
    work: &Path,
    now: &mut Progress,
    report: &mut dyn FnMut(&Progress),
    kept_installed: &mut bool,
) -> End {
    let zip = work.join("Ollama-darwin.zip");
    let free = |len: u64| (job.free)(work).is_none_or(|free| free >= room_needed(len));
    let downloaded = download(
        job.fetch,
        job.policy,
        &zip,
        job.cancel,
        job.waits,
        &free,
        &mut |phase, done, total| {
            now.phase = phase;
            now.done_bytes = done;
            now.total_bytes = total;
            report(now);
        },
    );
    if let Err(end) = downloaded {
        return end;
    }
    now.phase = Phase::Checking;
    report(now);
    // From here on Stop isn't offered (unpacking and checking take seconds), and a late press isn't heard.
    let Some(plan) = check_zip(&zip) else {
        return End::BadArchive;
    };
    let unpacked = work.join("unpacked");
    if std::fs::DirBuilder::new().mode(0o700).create(&unpacked).is_err() {
        return End::Failed;
    }
    let ok = job.unpack.unpack(&zip, &unpacked, &plan);
    let _ = std::fs::remove_file(&zip);
    if !ok || !check_tree(&unpacked, &plan) {
        return End::BadArchive;
    }
    let app = unpacked.join(APP_NAME);
    // The folder checked is the folder moved: its device and inode, taken before the check and compared after it.
    let Some(moved_id) = identity(&app) else {
        return End::BadArchive;
    };
    if let Err(rejected) = job.verifier.verify(&app) {
        return rejected.into();
    }
    if identity(&app) != Some(moved_id) {
        return End::InstallFailed;
    }
    now.phase = Phase::Installing;
    report(now);
    let installed = job.destination.join(APP_NAME);
    match move_new(&app, &installed) {
        Moved::Done => {}
        Moved::Taken => return End::AlreadyInstalled,
        Moved::NotAllowed => {
            // Kept, checked, for the person to drag into Applications themselves; never a password asked for.
            let kept = kept_app(job.caches);
            let ready = kept.parent().map(Path::to_path_buf).unwrap_or_default();
            if private_dir(&ready).is_err() || move_new(&app, &kept) != Moved::Done {
                return End::InstallFailed;
            }
            return End::CantInstall;
        }
        Moved::Failed => return End::InstallFailed,
    }
    // What is in Applications now is the very folder that was checked, and it is checked again where it is.
    if identity(&installed) != Some(moved_id) {
        return End::InstallFailed;
    }
    if let Err(rejected) = job.verifier.verify(&installed) {
        // It is the folder Ozzie moved there (same device and inode): Ozzie takes it out again.
        if identity(&installed) == Some(moved_id) {
            let _ = std::fs::remove_dir_all(&installed);
        }
        return rejected.into();
    }
    // Ollama is in Applications now: kept at once, so a quit while Ozzie waits for it still leaves Settings and What
    // happened true (the ending replaces it).
    remember(
        job.data,
        Done {
            at_ms: (job.clock)(),
            end: End::NotAnswering,
        },
        false,
    );
    *kept_installed = true;
    now.phase = Phase::Opening;
    report(now);
    if !job.opener.open(&installed) {
        return End::WontOpen;
    }
    wait_for_server(job, now, report)
}
/// Asks Ollama's server on this Mac every `poll` until it answers, at most `server`; "still starting" after
/// `still_starting`.
fn wait_for_server(job: &Job<'_>, now: &mut Progress, report: &mut dyn FnMut(&Progress)) -> End {
    let started = Instant::now();
    loop {
        let answered = job
            .http
            .get(&format!("{}/api/version", local_ai::OLLAMA), local_ai::FIND_WAIT)
            .is_ok_and(|(status, _)| status == 200);
        if answered {
            return End::Ready;
        }
        if started.elapsed() >= job.waits.server {
            return End::NotAnswering;
        }
        if now.phase != Phase::StillStarting && started.elapsed() >= job.waits.still_starting {
            now.phase = Phase::StillStarting;
            report(now);
        }
        std::thread::sleep(job.waits.poll);
    }
}

#[cfg(test)]
#[path = "ollama_install_tests.rs"]
mod tests;
