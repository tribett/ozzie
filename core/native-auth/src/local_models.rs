//! Models Ozzie downloads and sets up itself for AI on this Mac (the owner's request of 2026-11-18; spec S9; contract
//! N6 "Download and set up"). Ollama only: LM Studio, and any model the person brought, keep local_ai.rs's path.
//!
//! - Only the three models in providers.json `local` (small, medium, large) are ever downloaded: the page names one by
//!   its catalogue id, and any other text is refused.
//! - Downloading is Ollama's own `POST /api/pull` on 127.0.0.1:11434, read line by line as Ollama streams it. Closing
//!   the connection stops it; Ollama keeps what came and its docs say a pull resumes from there. There is no total time
//!   limit, but a download that moves no bytes and takes no step for `STALL_WAIT` is stopped and said to have stalled.
//! - Setting up is one `POST /api/create` making Ozzie's own copy, `ozzie-<model>` (`setup_name`), from the downloaded
//!   model with room for Ozzie's questions (`num_ctx` `ROOM`). The copy shares the model's files (about 1 KB more on
//!   disk, measured), keeps its template and abilities, and Ollama uses the room it names for `/v1` requests whatever
//!   its own Context length setting says (a model's parameters come after that default; Ollama's source, measured).
//! - Then "Check that it answers" (local_ai.rs) runs on Ozzie's copy, and only an answer chooses it, and only if no other
//!   choice of AI was made since the person pressed the button.
//! - "Remove this model from this Mac" deletes Ozzie's copy, and the model too only when Ozzie downloaded it itself
//!   (`local-models.json` in the app's data folder); never a model the person got on their own.
//!
//! Every request goes to Ollama's address on this Mac only, carries a catalogue id or Ozzie's fixed copy name and
//! nothing else, and nothing about the church.
use crate::local_ai::{self, App, Failure, LocalHttp};
use crate::model::{self, ModelError};
use crate::name_guard::NameGuard;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

/// The room, in tokens, Ozzie's copy gives the model: Ollama's "8k", what the check asks for (`CONTEXT_NEEDED`). The
/// check's question is about 3,900 tokens and a larger church's Ask about 3,800 before its answer (measured,
/// 2026-11-18), so 4k (Ollama's default below 24 GB of graphics memory) is too little. 8k cost about 0.6 GB more
/// memory than 4k for qwen3:8b (5.59 GB loaded at 4k, 6.19 GB at 8k, measured); the small model's layers are the same
/// shape, so about the same on an 8 GB Mac, which fits there.
pub const ROOM: u64 = local_ai::CONTEXT_NEEDED;
/// How long a download may go without a byte or a step before it counts as stalled. Ollama sends a line every 60 ms
/// while it downloads (its source), with the same count when nothing moves; it says nothing while it checks the
/// finished files, which takes seconds on this Mac's own disk.
pub const STALL_WAIT: Duration = Duration::from_secs(120);
/// What a download needs free beyond the model's own size, so the Mac keeps room to work afterwards.
pub const DISK_HEADROOM: u64 = 3_000_000_000;
/// Setting up (`/api/show`, `/api/create` from a model already on this Mac: under a second, measured) and removing.
pub const SETUP_WAIT: Duration = Duration::from_secs(60);
/// How often the download's connection is looked at when Ollama says nothing: Stop is heard within this.
pub const PULL_POLL: Duration = Duration::from_secs(1);
/// The progress the page is told, at most this often (a new step is told at once).
pub const REPORT_EVERY: Duration = Duration::from_millis(250);
/// What Ozzie downloaded itself, in the app's data folder.
pub const KEPT_FILE: &str = "local-models.json";
/// A line of Ollama's stream, at most (its lines are under 300 bytes).
const MAX_LINE: usize = 65_536;
/// The response's head, at most.
const MAX_HEAD: usize = 16_384;
/// A chunk's size line, at most (Ollama's are a few hex digits).
const MAX_SIZE_LINE: usize = 1_024;
/// Files counted in one download, at most (a model has about five).
pub const MAX_FILES: usize = 64;
/// The most bytes a download's counts ever say, for one file or the whole: the page refuses larger numbers
/// (onboarding-bridge.ts), so an absurd count from the stream can never keep an ending from reaching it (review L-3).
pub const MAX_BYTES: u64 = 1 << 50;

/// The three sizes, as the page says them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Size {
    Small,
    Medium,
    Large,
}
/// The catalogue, in order: providers.json `local` small, medium, large.
pub fn entries() -> [(Size, &'static crate::own_key::LocalModel); 3] {
    let local = &crate::own_key::catalog().local;
    [
        (Size::Small, &local.small),
        (Size::Medium, &local.medium),
        (Size::Large, &local.large),
    ]
}
/// The catalogue's entry for exactly this id; None for anything else the page might send.
pub fn entry(id: &str) -> Option<(Size, &'static crate::own_key::LocalModel)> {
    entries().into_iter().find(|(_, m)| m.id == id)
}
/// Ozzie's own copy of a catalogue model, with a tag always ("ozzie-qwen3:8b"), so Ollama lists it under exactly this
/// name and the check finds it.
pub fn setup_name(id: &str) -> String {
    if id.contains(':') {
        format!("ozzie-{id}")
    } else {
        format!("ozzie-{id}:latest")
    }
}
/// A catalogue model Ozzie no longer offers (providers.json `offered`), by its own id or Ozzie's copy's name.
pub fn no_longer_offered(model: &str) -> bool {
    entries()
        .iter()
        .any(|(_, m)| !m.offered && (m.id == model || setup_name(&m.id) == model))
}
/// One of Ozzie's three copy names, exactly.
pub fn is_setup_name(model: &str) -> bool {
    entries().iter().any(|(_, m)| setup_name(&m.id) == model)
}
/// The name a person reads for a model: Ozzie's copy is named as the model it is a copy of.
pub fn shown_name(model: &str) -> &str {
    entries()
        .into_iter()
        .find(|(_, m)| setup_name(&m.id) == model)
        .map_or(model, |(_, m)| m.id.as_str())
}

/// Whether a model would fit on the disk where Ollama keeps models.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Disk {
    Enough,
    NotEnough,
    /// Ozzie can't tell where Ollama keeps models here (it was moved), or couldn't read the space.
    Unknown,
    /// It is already on this Mac.
    NotNeeded,
}
/// One catalogue model as it stands on this Mac.
#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct CatalogueRow {
    pub size: Size,
    pub id: String,
    pub size_bytes: u64,
    /// At most half this Mac's memory (local_ai's rule).
    pub fits: bool,
    /// Ozzie offers to download and set it up (providers.json `offered`). A row that isn't is shown only when Ozzie's own
    /// copy or download of it is on this Mac, so it can be removed.
    pub offered: bool,
    /// The one `local_ai::advice` picks for this Mac's memory.
    pub recommended: bool,
    /// Ollama lists the model, or Ozzie's copy of it (which holds its files).
    pub downloaded: bool,
    /// Ollama lists Ozzie's copy.
    pub set_up: bool,
    pub disk: Disk,
    /// Ozzie downloaded it itself (`local-models.json`): "Remove this model from this Mac" deletes it too.
    pub downloaded_by_ozzie: bool,
}
/// Whether `size` fits in `free` with room to spare.
pub fn disk_room(size: u64, free: Option<u64>, downloaded: bool) -> Disk {
    match free {
        _ if downloaded => Disk::NotNeeded,
        None => Disk::Unknown,
        Some(free) if free >= size.saturating_add(DISK_HEADROOM) => Disk::Enough,
        Some(_) => Disk::NotEnough,
    }
}
/// The three rows, from what Ollama lists (None: Ollama isn't answering, so nothing counts as downloaded).
pub fn catalogue(
    listed: Option<&[(String, Option<u64>)]>,
    memory_bytes: u64,
    free_bytes: Option<u64>,
    kept: &Kept,
) -> Vec<CatalogueRow> {
    let (_, recommended) = local_ai::advice(memory_bytes);
    let has = |name: &str| {
        listed.is_some_and(|models| {
            models
                .iter()
                .any(|(id, _)| local_ai::same_model(id, name))
        })
    };
    entries()
        .into_iter()
        .map(|(size, m)| {
            let set_up = has(&setup_name(&m.id));
            let downloaded = set_up || has(&m.id);
            CatalogueRow {
                size,
                id: m.id.clone(),
                size_bytes: m.size_bytes,
                fits: local_ai::fits(Some(m.size_bytes), memory_bytes),
                offered: m.offered,
                recommended: recommended.is_some_and(|r| r.id == m.id),
                downloaded,
                set_up,
                disk: disk_room(m.size_bytes, free_bytes, downloaded),
                downloaded_by_ozzie: kept.downloaded.iter().any(|id| *id == m.id),
            }
        })
        .collect()
}

/// What Ozzie downloaded itself: catalogue ids only. Removing deletes a model only if it is here.
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq, Eq)]
pub struct Kept {
    #[serde(default)]
    pub downloaded: Vec<String>,
}
static KEPT: Mutex<()> = Mutex::new(());
/// The app data folders a download job is under way for, once each (review L-1).
static IN_FLIGHT: Mutex<Vec<std::path::PathBuf>> = Mutex::new(Vec::new());
/// Held by a download job from its own check of the record until it ends: `kept_now` doesn't change the record for that
/// folder meanwhile. Per folder, so one job never holds back another folder's record.
pub(crate) struct InFlight(std::path::PathBuf);
impl InFlight {
    pub(crate) fn start(dir: &Path) -> Self {
        IN_FLIGHT
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(dir.to_path_buf());
        Self(dir.to_path_buf())
    }
    fn under_way(dir: &Path) -> bool {
        IN_FLIGHT
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .any(|d| d == dir)
    }
}
impl Drop for InFlight {
    fn drop(&mut self) {
        let mut under_way = IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(at) = under_way.iter().position(|d| *d == self.0) {
            under_way.remove(at);
        }
    }
}
/// What Ozzie downloaded itself, as recorded in `dir`; nothing when the file is absent or unreadable (so nothing the
/// person got on their own is ever taken for Ozzie's).
pub fn kept(dir: &Path) -> Kept {
    let _lock = KEPT.lock().unwrap_or_else(|e| e.into_inner());
    read_kept(dir)
}
fn read_kept(dir: &Path) -> Kept {
    let mut kept: Kept = model::read_small(&dir.join(KEPT_FILE))
        .ok()
        .flatten()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    kept.downloaded.retain(|id| entry(id).is_some());
    kept.downloaded.dedup();
    kept
}
fn change_kept(dir: &Path, change: impl FnOnce(&mut Vec<String>)) -> Result<(), ModelError> {
    let _lock = KEPT.lock().unwrap_or_else(|e| e.into_inner());
    let mut kept = read_kept(dir);
    change(&mut kept.downloaded);
    write_kept(dir, &kept)
}
fn write_kept(dir: &Path, kept: &Kept) -> Result<(), ModelError> {
    let bytes = serde_json::to_vec_pretty(kept).map_err(|_| ModelError::InvalidRequest)?;
    model::write_private(&dir.join(KEPT_FILE), &bytes).map_err(|_| ModelError::ProviderFailure)
}
/// What Ozzie downloaded itself, checked against what Ollama lists now (`listed`; None: Ollama isn't answering, so
/// nothing can be told and the record stays). A model Ollama no longer lists was deleted by the person, in Ollama or
/// with its command: it leaves the record, so a model of the same name they later get on their own is never taken for
/// Ozzie's and never removed by Ozzie (review L-2). Read this way wherever the record decides anything: finding, the
/// job and removing. A model deleted and got again by the person with no list read by Ozzie in between can't be told
/// apart from Ozzie's download.
///
/// A list that can't tell is never trusted (review L-1): one at `local_ai::MAX_MODELS` (it was cut, so the model may be
/// past its end), or any list while a download into this folder is under way (`InFlight`: Ollama's mid-pull view). The
/// record stays as it was then. An empty list is trusted: Ollama answered and lists nothing, so the record empties.
/// Forgetting is the safe direction, since a model Ozzie forgot is never removed by Ozzie (review L-2, 2026-11-18).
pub fn kept_now(dir: &Path, listed: Option<&[(String, Option<u64>)]>) -> Kept {
    let Some(listed) =
        listed.filter(|listed| listed.len() < local_ai::MAX_MODELS && !InFlight::under_way(dir))
    else {
        return kept(dir);
    };
    let _lock = KEPT.lock().unwrap_or_else(|e| e.into_inner());
    let mut kept = read_kept(dir);
    let before = kept.downloaded.len();
    kept.downloaded
        .retain(|id| listed.iter().any(|(m, _)| local_ai::same_model(m, id)));
    if kept.downloaded.len() != before {
        // A record that can't be written keeps the stale id; the next list read drops it.
        let _ = write_kept(dir, &kept);
    }
    kept
}
/// "AI on this Mac"'s finding, with the free space and what Ozzie downloaded itself, that record checked against the
/// very list Ollama gave (`kept_now`).
pub fn find(
    dir: &Path,
    http: &dyn LocalHttp,
    installed: impl Fn(App) -> bool,
    memory_bytes: u64,
    free_bytes: Option<u64>,
) -> local_ai::LocalFind {
    local_ai::find_reading(http, installed, memory_bytes, free_bytes, |listed| {
        kept_now(dir, listed)
    })
}

/// Free space where Ollama keeps models: its usual folder (`~/.ollama/models`, which a running Ollama always has a
/// `blobs` folder in). None when that folder isn't there (the person moved it, or set `OLLAMA_MODELS`): Ozzie can't
/// tell where Ollama keeps models then, and Ollama's own "no space left" still ends a download that doesn't fit.
pub fn ollama_free_bytes() -> Option<u64> {
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from)?;
    let blobs = home.join(".ollama").join("models").join("blobs");
    blobs.is_dir().then(|| free_bytes_at(&blobs)).flatten()
}
/// The space free to this user on the disk that holds `path`, as Finder counts it: on macOS the volume's capacity "for
/// important usage", which includes space macOS frees on demand (purgeable files, local snapshots). statvfs's
/// `f_bavail` leaves that out and can read many gigabytes lower, so a Mac Finder shows room on could be refused (review
/// L-5). statvfs where that capacity can't be read; None when `path` isn't there.
pub fn free_bytes_at(path: &Path) -> Option<u64> {
    let free = statvfs_free(path)?;
    #[cfg(target_os = "macos")]
    if let Some(important) = important_free(path) {
        return Some(important.max(free));
    }
    Some(free)
}
/// statvfs's space free to this user.
pub(crate) fn statvfs_free(path: &Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut stat = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    // SAFETY: `path` is a NUL-terminated string that outlives the call, and `stat` points at room for one statvfs,
    // which the call fills in before it is read, and is read only when the call says it succeeded.
    let stat = unsafe {
        if libc::statvfs(path.as_ptr(), stat.as_mut_ptr()) != 0 {
            return None;
        }
        stat.assume_init()
    };
    Some(u64::from(stat.f_bavail).saturating_mul(stat.f_frsize))
}
/// The volume's "available capacity for important usage" (CFURL.h, macOS 10.13 and later), through CoreFoundation,
/// which this crate already links (security-framework); None when it can't be read.
#[cfg(target_os = "macos")]
pub(crate) fn important_free(path: &Path) -> Option<u64> {
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::number::CFNumber;
    use core_foundation::url::CFURL;
    use core_foundation_sys::base::{Boolean, CFTypeRef};
    use core_foundation_sys::error::CFErrorRef;
    use core_foundation_sys::string::CFStringRef;
    use core_foundation_sys::url::CFURLRef;
    // Both in CFURL.h; core-foundation-sys 0.8.7 lists them only as comments.
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        static kCFURLVolumeAvailableCapacityForImportantUsageKey: CFStringRef;
        fn CFURLCopyResourcePropertyForKey(
            url: CFURLRef,
            key: CFStringRef,
            value: *mut CFTypeRef,
            error: *mut CFErrorRef,
        ) -> Boolean;
    }
    let url = CFURL::from_path(path, true)?;
    let mut value: CFTypeRef = std::ptr::null();
    // SAFETY: `url` is a live CFURL for the call; the key is CoreFoundation's own constant; `value` is a place for one
    // CFTypeRef, written only on success; no error object is asked for (null).
    let copied = unsafe {
        CFURLCopyResourcePropertyForKey(
            url.as_concrete_TypeRef(),
            kCFURLVolumeAvailableCapacityForImportantUsageKey,
            &mut value,
            std::ptr::null_mut(),
        )
    };
    if copied == 0 || value.is_null() {
        return None;
    }
    // SAFETY: a Copy function's result belongs to the caller (CoreFoundation's Create rule): wrapped once, released
    // when it drops.
    let value = unsafe { CFType::wrap_under_create_rule(value) };
    value
        .downcast::<CFNumber>()?
        .to_i64()
        .and_then(|bytes| u64::try_from(bytes).ok())
}

// ---- Downloading --------------------------------------------------------------------------------------------------

/// What the stream said, or that no whole line came: about a second passed with nothing, or only part of a line did.
pub enum Heard<'a> {
    Line(&'a [u8]),
    Quiet,
}
/// How a download reaches Ollama on this Mac.
pub trait PullHttp {
    /// `POST /api/pull` with `body`. `heard` gets each line as it comes (an answer that isn't 200 comes as one line too),
    /// and `Quiet` after every read that brought no whole line, or about a second with nothing, so Stop and a stall are
    /// heard however the bytes come (review L-3); returning false closes the connection, which stops Ollama's
    /// download. Ok(status) when the stream ended or was closed; Err when Ollama isn't listening or the connection broke.
    fn pull(&self, body: &[u8], heard: &mut dyn FnMut(Heard<'_>) -> bool) -> Result<u16, Failure>;
}

/// The steps the page says.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    /// Asking Ollama's library for the model.
    Starting,
    Downloading,
    /// Ollama checks the downloaded files.
    Verifying,
    /// Ollama puts the model in place.
    Finishing,
    /// Making Ozzie's copy with room.
    SettingUp,
    /// "Check that it answers".
    Checking,
}
/// How a download and set-up ended (closed words; the page has a sentence for each).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum End {
    /// Downloaded (or already there) and set up; the check's own verdict is in `Progress::check`.
    Done,
    /// The person pressed Stop the download.
    Cancelled,
    /// The disk where Ollama keeps models filled up.
    NoSpace,
    /// Ollama couldn't reach its library.
    Offline,
    /// Ollama's library doesn't have it.
    NotFound,
    /// Ollama went away (not answering, or the connection dropped).
    Stopped,
    /// No bytes and no step for `STALL_WAIT`.
    Stalled,
    /// Ollama refused the download in a way none of the above covers.
    Failed,
    /// The model is on this Mac, but Ozzie's copy couldn't be made (an Ollama older than its current create).
    NotSetUp,
}
/// What the check said, without the route's status (the page reads that itself).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct CheckView {
    pub verdict: local_ai::Verdict,
    pub seconds: Option<u64>,
    pub small_room: bool,
}
/// What the one download and set-up is doing, or how it ended: numbers and closed words only.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Progress {
    /// The catalogue id.
    pub model: String,
    pub phase: Phase,
    pub done_bytes: u64,
    pub total_bytes: u64,
    /// None while it runs.
    pub end: Option<End>,
    /// On `done`: what "Check that it answers" said.
    pub check: Option<CheckView>,
}
impl Progress {
    pub fn starting(id: &str) -> Self {
        Self {
            model: id.to_owned(),
            phase: Phase::Starting,
            done_bytes: 0,
            total_bytes: entry(id).map_or(0, |(_, m)| m.size_bytes.min(MAX_BYTES)),
            end: None,
            check: None,
        }
    }
}

/// An error line's fixed words, as Ollama and Go write them, to a closed ending. Nothing Ollama wrote goes further.
pub(crate) fn ended_by(error: &str) -> End {
    let text = error.to_ascii_lowercase();
    let any = |phrases: &[&str]| phrases.iter().any(|p| text.contains(p));
    if any(&["no space left", "not enough space", "disk full"]) {
        End::NoSpace
    } else if any(&[
        "no such host",
        "network is unreachable",
        "no route to host",
        "dial tcp",
        "i/o timeout",
        "connection refused",
        "connection reset",
        "tls handshake",
    ]) {
        End::Offline
    } else if any(&["file does not exist", "not found", "manifest unknown"]) {
        End::NotFound
    } else {
        End::Failed
    }
}

/// The download's counts: each file's (total, done) by its digest. Ollama names the files one at a time, so the whole
/// is at least the catalogue's size, and the bar doesn't jump back as each new file is named. Whatever the stream says,
/// the counts stay within `MAX_BYTES` and `MAX_FILES` files, and sums never overflow (review L-3).
struct Counts {
    files: BTreeMap<String, (u64, u64)>,
    at_least: u64,
}
impl Counts {
    /// A file's counts as Ollama gave them, clamped; a file past the first `MAX_FILES` isn't counted.
    fn file(&mut self, digest: &str, total: u64, done: u64) {
        if self.files.len() >= MAX_FILES && !self.files.contains_key(digest) {
            return;
        }
        let total = total.min(MAX_BYTES);
        self.files.insert(digest.to_owned(), (total, done.min(total)));
    }
    fn done(&self) -> u64 {
        self.files
            .values()
            .fold(0u64, |sum, (_, done)| sum.saturating_add(*done))
            .min(self.total())
    }
    fn total(&self) -> u64 {
        self.files
            .values()
            .fold(0u64, |sum, (total, _)| sum.saturating_add(*total))
            .max(self.at_least)
            .min(MAX_BYTES)
    }
}

/// Downloads catalogue model `id` through Ollama, telling `report` each step and the bytes as they come. Ok once
/// Ollama said success; otherwise how it ended. `cancel` is the person's Stop.
pub fn download(
    id: &str,
    pull: &dyn PullHttp,
    cancel: &AtomicBool,
    stall: Duration,
    report: &mut dyn FnMut(Phase, u64, u64),
) -> Result<(), End> {
    let Some((_, entry)) = entry(id) else {
        return Err(End::NotFound);
    };
    let body = serde_json::to_vec(&json!({"model": entry.id, "stream": true}))
        .map_err(|_| End::Failed)?;
    let mut counts = Counts {
        files: BTreeMap::new(),
        at_least: entry.size_bytes,
    };
    let mut phase = Phase::Starting;
    let mut outcome: Option<Result<(), End>> = None;
    let mut moved = Instant::now();
    let mut told = (Instant::now(), u64::MAX);
    let mut heard = |what: Heard<'_>| -> bool {
        let before = (phase, counts.done());
        if let Heard::Line(line) = what {
            let value: Value = serde_json::from_slice(line).unwrap_or(Value::Null);
            if let Some(error) = value["error"].as_str() {
                outcome = Some(Err(ended_by(error)));
                return false;
            }
            let status = value["status"].as_str().unwrap_or("");
            match status {
                // Ollama sends nothing after success: reading stops here, so a listener that holds the connection open
                // can't keep the job, and its busy slot, waiting (review M-1, 2026-11-18).
                "success" => {
                    outcome = Some(Ok(()));
                    return false;
                }
                "pulling manifest" => phase = Phase::Starting,
                "verifying sha256 digest" => phase = Phase::Verifying,
                "writing manifest" | "removing unused layers" | "removing any unused layers" => {
                    phase = Phase::Finishing
                }
                _ if status.starts_with("pulling ") => {
                    if let (Some(digest), Some(total)) =
                        (value["digest"].as_str(), value["total"].as_u64())
                    {
                        counts.file(digest, total, value["completed"].as_u64().unwrap_or(0));
                        phase = Phase::Downloading;
                    }
                }
                _ => {}
            }
        }
        let now = Instant::now();
        if (phase, counts.done()) != before {
            moved = now;
        }
        // Stop counts only while the download hasn't ended: one pressed after Ollama said success leaves it downloaded,
        // and recorded as Ozzie's, so it can be removed later (review L-1).
        if outcome.is_none() && cancel.load(Ordering::SeqCst) {
            outcome = Some(Err(End::Cancelled));
            return false;
        }
        if outcome.is_none() && now.duration_since(moved) >= stall {
            outcome = Some(Err(End::Stalled));
            return false;
        }
        if phase != before.0 || now.duration_since(told.0) >= REPORT_EVERY {
            let done = counts.done();
            if phase != before.0 || done != told.1 {
                report(phase, done, counts.total());
                told = (now, done);
            }
        }
        true
    };
    let answered = pull.pull(&body, &mut heard);
    match (answered, outcome) {
        (_, Some(ended)) => ended,
        // The stream ended (or broke) before Ollama said it was done: it went away.
        (Ok(200) | Err(_), None) => Err(End::Stopped),
        (Ok(_), None) => Err(End::Failed),
    }
}

// ---- Setting up ---------------------------------------------------------------------------------------------------

/// The request that makes Ozzie's copy of `id` with room: Ollama's current create (from v0.5.5, its JSON shape).
pub fn create_body(id: &str) -> Value {
    json!({
        "model": setup_name(id),
        "from": id,
        "parameters": {"num_ctx": ROOM},
        "stream": false,
    })
}
/// `/api/show`'s `parameters` text names exactly `ROOM` for `num_ctx`.
fn has_room(parameters: &str) -> bool {
    parameters.lines().any(|line| {
        let mut words = line.split_whitespace();
        words.next() == Some("num_ctx") && words.next().and_then(|n| n.parse().ok()) == Some(ROOM)
    })
}
/// Ollama lists Ozzie's copy of `id` and it has the room Ozzie gives it, and it runs on this Mac (a copy made from a
/// model served elsewhere is served from there too: it is made again from the model on this Mac).
fn copy_ready(id: &str, http: &dyn LocalHttp) -> Result<bool, End> {
    let body = serde_json::to_vec(&json!({"model": setup_name(id)})).map_err(|_| End::Failed)?;
    match http.post(&format!("{}/api/show", local_ai::OLLAMA), &body, SETUP_WAIT) {
        Ok((200, answer)) => {
            let value: Value = serde_json::from_slice(&answer).unwrap_or(Value::Null);
            Ok(value["parameters"].as_str().is_some_and(has_room) && !local_ai::names_a_remote(&value))
        }
        Ok(_) => Ok(false),
        Err(_) => Err(End::Stopped),
    }
}
/// Makes Ozzie's copy of `id` unless it is there with the right room. Only from a model Ollama lists now: Ollama's
/// create would otherwise download the model itself, which only `download` may do.
pub fn set_up(id: &str, http: &dyn LocalHttp) -> Result<(), End> {
    if copy_ready(id, http)? {
        return Ok(());
    }
    let listed = local_ai::listed(App::Ollama, http).ok_or(End::Stopped)?;
    if !listed.iter().any(|(m, _)| local_ai::same_model(m, id)) {
        return Err(End::NotSetUp);
    }
    let body = serde_json::to_vec(&create_body(id)).map_err(|_| End::Failed)?;
    match http.post(&format!("{}/api/create", local_ai::OLLAMA), &body, SETUP_WAIT) {
        Ok((200, answer)) => {
            let value: Value = serde_json::from_slice(&answer).unwrap_or(Value::Null);
            if value["status"] == "success" {
                Ok(())
            } else {
                Err(End::NotSetUp)
            }
        }
        Ok(_) => Err(End::NotSetUp),
        Err(_) => Err(End::Stopped),
    }
}

// ---- The whole job ------------------------------------------------------------------------------------------------

/// One "Download and set up", from the press to the check's verdict.
pub struct Job<'a> {
    pub dir: &'a Path,
    /// A catalogue id.
    pub id: &'a str,
    pub names: &'a NameGuard,
    pub http: &'a dyn LocalHttp,
    pub pull: &'a dyn PullHttp,
    pub clock: &'a dyn Fn() -> u64,
    pub cancel: &'a AtomicBool,
    /// `model::route_generation` when the person pressed the button.
    pub choices: u64,
    pub stall: Duration,
}
/// Downloads the model if Ollama doesn't have it (recording that Ozzie did), makes Ozzie's copy with room if it isn't
/// there, then checks that the copy answers; on `answers` the route is the copy, if nothing else was chosen since the
/// press. Every step is told to `report`; the last `Progress` is how it ended.
pub fn run(job: &Job<'_>, report: &mut dyn FnMut(&Progress)) -> Progress {
    let mut now = Progress::starting(job.id);
    let mut tell = |now: &Progress| report(now);
    let ended = |mut now: Progress, end: End| {
        now.end = Some(end);
        now
    };
    if entry(job.id).is_none() {
        return ended(now, End::NotFound);
    }
    tell(&now);
    let Some(listed) = local_ai::listed(App::Ollama, job.http) else {
        return ended(now, End::Stopped);
    };
    // A model of Ozzie's the person deleted since leaves the record here, before anything is downloaded (review L-2).
    kept_now(job.dir, Some(listed.as_slice()));
    // From here to the end the list may be Ollama's mid-pull view: finding meanwhile leaves the record (review L-1).
    let _in_flight = InFlight::start(job.dir);
    let has = |name: &str| listed.iter().any(|(m, _)| local_ai::same_model(m, name));
    let ready = has(&setup_name(job.id)) && copy_ready(job.id, job.http) == Ok(true);
    if !has(job.id) && !ready {
        let downloaded = download(job.id, job.pull, job.cancel, job.stall, &mut |phase, done, total| {
            now.phase = phase;
            now.done_bytes = done;
            now.total_bytes = total;
            tell(&now);
        });
        if let Err(end) = downloaded {
            return ended(now, end);
        }
        now.done_bytes = now.total_bytes;
        // Ozzie downloaded it: only now may "Remove this model from this Mac" delete it. A record that can't be written
        // leaves the model to the person.
        let _ = change_kept(job.dir, |ids| {
            if !ids.iter().any(|id| id == job.id) {
                ids.push(job.id.to_owned());
            }
        });
    }
    // Setting up before Stop is looked at: a Stop here ends at setting-up, which tells the page the model is on this Mac
    // (the download, if any, said success) and only Set up is left; a Stop during the download ends at its own step.
    now.phase = Phase::SettingUp;
    if job.cancel.load(Ordering::SeqCst) {
        return ended(now, End::Cancelled);
    }
    tell(&now);
    if let Err(end) = set_up(job.id, job.http) {
        return ended(now, end);
    }
    now.phase = Phase::Checking;
    tell(&now);
    let checked = local_ai::check_since(
        job.dir,
        App::Ollama,
        &setup_name(job.id),
        job.names,
        job.http,
        job.clock,
        job.choices,
    );
    match checked {
        Ok(checked) => {
            now.check = Some(CheckView {
                verdict: checked.verdict,
                seconds: checked.seconds,
                small_room: checked.small_room,
            });
            ended(now, End::Done)
        }
        Err(_) => ended(now, End::Failed),
    }
}

/// Why a download can't start (the page has a sentence for each).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Refusal {
    /// Not one of the catalogue's three ids.
    NotInCatalogue,
    /// In the catalogue, but Ozzie doesn't offer it (providers.json `offered`).
    NotOffered,
    /// Ollama isn't answering.
    NotRunning,
    /// Too big for this Mac's memory.
    TooBig,
    /// Not enough free space where Ollama keeps models.
    NoRoom,
    /// A download is already under way.
    Busy,
}
/// Whether "Download and set up" may start for `id`, from what was just found.
pub fn may_start(found: &local_ai::LocalFind, id: &str) -> Result<(), Refusal> {
    let row = found
        .catalogue
        .iter()
        .find(|row| row.id == id && entry(id).is_some())
        .ok_or(Refusal::NotInCatalogue)?;
    if !row.offered {
        return Err(Refusal::NotOffered);
    }
    if !found.apps.iter().any(|a| a.app == App::Ollama && a.running) {
        return Err(Refusal::NotRunning);
    }
    if !row.fits {
        return Err(Refusal::TooBig);
    }
    if row.disk == Disk::NotEnough {
        return Err(Refusal::NoRoom);
    }
    Ok(())
}

// ---- Removing -----------------------------------------------------------------------------------------------------

/// How "Remove this model from this Mac" ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Removed {
    /// Ozzie's copy is gone, and the model too when Ozzie downloaded it.
    Removed,
    /// Nothing of Ozzie's was there.
    None,
    /// Ollama isn't answering; nothing changed.
    Stopped,
    /// Ollama refused; what it removed before refusing is gone.
    Failed,
}
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct Removal {
    pub removed: Removed,
    /// AI on this Mac was this model, so no AI is chosen now.
    pub route_cleared: bool,
}
/// Deletes Ozzie's copy of `id`, and `id` itself only when Ozzie downloaded it; then, if the route chosen was one of
/// them, no AI is chosen. Never a model the person got on their own.
pub fn remove(dir: &Path, id: &str, http: &dyn LocalHttp) -> Result<Removal, ModelError> {
    if entry(id).is_none() {
        return Err(ModelError::InvalidRequest);
    }
    // What Ollama lists now decides what is Ozzie's: one the person deleted since isn't (review L-2). Ollama not
    // answering: nothing can be removed anyway, and the record stays.
    let Some(listed) = local_ai::listed(App::Ollama, http) else {
        return Ok(Removal {
            removed: Removed::Stopped,
            route_cleared: false,
        });
    };
    let mut names = vec![setup_name(id)];
    if kept_now(dir, Some(listed.as_slice()))
        .downloaded
        .iter()
        .any(|kept| kept == id)
    {
        names.push(id.to_owned());
    }
    let mut gone = Vec::new();
    let mut removed = Removed::None;
    for name in &names {
        let body = serde_json::to_vec(&json!({"model": name})).map_err(|_| ModelError::InvalidRequest)?;
        match http.delete(&format!("{}/api/delete", local_ai::OLLAMA), &body, SETUP_WAIT) {
            Ok((200, _)) => {
                gone.push(name.clone());
                removed = Removed::Removed;
            }
            // Already gone: nothing to remove, and nothing in the way of the next.
            Ok((404, _)) => gone.push(name.clone()),
            Ok(_) => {
                removed = Removed::Failed;
                break;
            }
            Err(_) => {
                removed = if gone.is_empty() {
                    Removed::Stopped
                } else {
                    Removed::Failed
                };
                break;
            }
        }
    }
    if gone.iter().any(|name| name == id) {
        change_kept(dir, |ids| ids.retain(|kept| kept != id))?;
    }
    let route_cleared = model::clear_local_if(dir, &gone)?;
    Ok(Removal {
        removed,
        route_cleared,
    })
}

// ---- The real connection ------------------------------------------------------------------------------------------

/// The real download stream: plain HTTP/1.1 to Ollama's address on this Mac and nowhere else (an IP literal: no
/// proxy, no name lookup, no redirect can apply), with a short read wait so Stop and a stall are heard while Ollama is
/// quiet. Dropping the connection is how Ollama is told to stop.
pub struct NativePull;
impl PullHttp for NativePull {
    fn pull(&self, body: &[u8], heard: &mut dyn FnMut(Heard<'_>) -> bool) -> Result<u16, Failure> {
        pull_at(ollama_address().ok_or(Failure::Unreachable)?, body, PULL_POLL, heard)
    }
}
/// Ollama's address as a socket address, from local_ai's origin; only ever this Mac's loopback.
pub fn ollama_address() -> Option<SocketAddr> {
    let origin = url::Url::parse(local_ai::OLLAMA).ok()?;
    let ip: std::net::IpAddr = origin.host_str()?.parse().ok()?;
    let address = SocketAddr::new(ip, origin.port()?);
    address.ip().is_loopback().then_some(address)
}
/// How the body after the head is read.
enum Framing {
    Chunked,
    Length(u64),
    UntilClosed,
}
/// One streamed POST to `/api/pull` at a loopback `address`.
pub(crate) fn pull_at(
    address: SocketAddr,
    body: &[u8],
    poll: Duration,
    heard: &mut dyn FnMut(Heard<'_>) -> bool,
) -> Result<u16, Failure> {
    if !address.ip().is_loopback() {
        return Err(Failure::Unreachable);
    }
    let mut stream =
        TcpStream::connect_timeout(&address, local_ai::FIND_WAIT).map_err(|_| Failure::Unreachable)?;
    stream
        .set_read_timeout(Some(poll))
        .and_then(|()| stream.set_write_timeout(Some(local_ai::FIND_WAIT.max(poll))))
        .map_err(|_| Failure::Unreachable)?;
    let head = format!(
        "POST /api/pull HTTP/1.1\r\nHost: {address}\r\nUser-Agent: Ozzie (https://ozzie.church)\r\nContent-Type: application/json\r\nAccept: application/x-ndjson\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream
        .write_all(head.as_bytes())
        .and_then(|()| stream.write_all(body))
        .map_err(|_| Failure::Unreachable)?;
    let close = |stream: &TcpStream| {
        let _ = stream.shutdown(std::net::Shutdown::Both);
    };
    let mut raw: Vec<u8> = Vec::new();
    let mut status: Option<(u16, Framing)> = None;
    let mut line: Vec<u8> = Vec::new();
    // Chunked: bytes left in the chunk being read, or None while a size line is awaited.
    let mut chunk_left: Option<u64> = None;
    let mut body_read: u64 = 0;
    let mut buffer = [0u8; 16_384];
    loop {
        let n = match stream.read(&mut buffer) {
            Ok(n) => n,
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                if !heard(Heard::Quiet) {
                    close(&stream);
                    return Ok(status.map_or(0, |(code, _)| code));
                }
                continue;
            }
            Err(_) => return Err(Failure::Unreachable),
        };
        let closed = n == 0;
        raw.extend_from_slice(&buffer[..n]);
        // The head, once.
        if status.is_none() {
            let Some(end) = raw.windows(4).position(|w| w == b"\r\n\r\n") else {
                if closed || raw.len() > MAX_HEAD {
                    return Err(Failure::Unreachable);
                }
                // Part of the head: Stop and a stall are still heard.
                if !heard(Heard::Quiet) {
                    close(&stream);
                    return Ok(0);
                }
                continue;
            };
            let text = String::from_utf8_lossy(&raw[..end]).to_ascii_lowercase();
            let mut lines = text.split("\r\n");
            let code = lines
                .next()
                .and_then(|first| first.split_whitespace().nth(1))
                .and_then(|code| code.parse::<u16>().ok())
                .ok_or(Failure::Unreachable)?;
            let mut framing = Framing::UntilClosed;
            for header in lines {
                let (name, value) = header.split_once(':').unwrap_or((header, ""));
                match (name.trim(), value.trim()) {
                    ("transfer-encoding", v) if v.contains("chunked") => framing = Framing::Chunked,
                    ("content-length", v) if !matches!(framing, Framing::Chunked) => {
                        framing = Framing::Length(v.parse().map_err(|_| Failure::Unreachable)?)
                    }
                    _ => {}
                }
            }
            status = Some((code, framing));
            raw.drain(..end + 4);
        }
        let Some((code, framing)) = &status else {
            continue;
        };
        let code = *code;
        // The body's bytes so far, unframed, into lines.
        let mut finished = false;
        let mut body_bytes: Vec<u8> = Vec::new();
        match framing {
            Framing::Chunked => loop {
                match chunk_left {
                    None => {
                        let Some(at) = raw.windows(2).position(|w| w == b"\r\n") else {
                            // Never a size line without end (review L-3).
                            if raw.len() > MAX_SIZE_LINE {
                                close(&stream);
                                return Err(Failure::Unreachable);
                            }
                            break;
                        };
                        let size_text = String::from_utf8_lossy(&raw[..at]).to_string();
                        let size = u64::from_str_radix(
                            size_text.split(';').next().unwrap_or("").trim(),
                            16,
                        )
                        .map_err(|_| Failure::Unreachable)?;
                        raw.drain(..at + 2);
                        if size == 0 {
                            finished = true;
                            break;
                        }
                        chunk_left = Some(size);
                    }
                    Some(0) => {
                        if raw.len() < 2 {
                            break;
                        }
                        raw.drain(..2);
                        chunk_left = None;
                    }
                    Some(left) => {
                        if raw.is_empty() {
                            break;
                        }
                        let take = (left as usize).min(raw.len());
                        body_bytes.extend(raw.drain(..take));
                        chunk_left = Some(left - take as u64);
                    }
                }
            },
            Framing::Length(length) => {
                let take = ((length - body_read) as usize).min(raw.len());
                body_bytes.extend(raw.drain(..take));
                body_read += take as u64;
                finished = body_read >= *length;
            }
            Framing::UntilClosed => body_bytes.append(&mut raw),
        }
        let mut said = false;
        for byte in body_bytes {
            if byte == b'\n' {
                let whole = std::mem::take(&mut line);
                let whole = whole.strip_suffix(b"\r").unwrap_or(&whole);
                if whole.is_empty() {
                    continue;
                }
                said = true;
                if !heard(Heard::Line(whole)) {
                    close(&stream);
                    return Ok(code);
                }
            } else if line.len() < MAX_LINE {
                line.push(byte);
            } else {
                close(&stream);
                return Err(Failure::Unreachable);
            }
        }
        if finished || closed {
            if !line.is_empty() {
                let rest = std::mem::take(&mut line);
                heard(Heard::Line(&rest));
            }
            close(&stream);
            if closed && !finished && matches!(framing, Framing::Chunked | Framing::Length(_)) {
                // The connection ended before the answer did.
                return Err(Failure::Unreachable);
            }
            return Ok(code);
        }
        // Bytes, but no whole line: Stop and a stall are heard on every read, however the stream dribbles (review L-3).
        if !said && !heard(Heard::Quiet) {
            close(&stream);
            return Ok(code);
        }
    }
}

#[cfg(test)]
#[path = "local_models_tests.rs"]
mod tests;
