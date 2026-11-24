//! The last check, shared with other AI apps on this Mac (harness plan H5). Off unless the leader turns
//! it on in Settings. The webview builds the shared tool results with the same read-only agent tools
//! Ask Ozzie uses (core/mcp/snapshot.ts `sharedEnvelopes`); this module checks every one again exactly
//! as `agent_step` checks a tool message before it may reach a model (`agent::tool_message_ok`: the
//! closed grammar of fixed/vocabulary.json, no hidden character, escape or contact detail, and no
//! name this session has shown in any label, time or fixed sentence) and for background-check
//! wording (background.rs; owner decision 2026-11-14: never in the shared copy), adds the task ledger's
//! name-free rows, and writes `shared-check.json` in the app data folder (file 0600, written aside
//! then renamed). Ozzie's read-only server (core/mcp) reads only that file and checks it again.
//!
//! Every result is refused unless it comes from one of SHARED_TOOLS, each at most once: who could
//! help, drafts, checking Planning Center again and the fictional email import are never shared.
//! Nothing here reads Planning Center or reaches a network.
//!
//! Whether sharing is on is kept here too, as a marker file beside the copy (ON_FILE), so it holds
//! without the webview: nothing is written while it's absent, turning sharing off removes it before
//! the copy, and every start of the app removes a copy (and any half-written one) left while off.
//!
//! The same checks and the same file handling keep a second copy, in its own Place with its own
//! marker: the copy Siri and Shortcuts answer from (shortcuts_check.rs, ADR 0006).
//!
//! A church on B1 Church or Breeze is shared the same way (0.10.0), from the same tools over that
//! system's own check, with two more keys after `format`: `system` ("b1" or "breeze") and
//! `role_numbers` ("all", "some" or "none": whether that system gave the number of people needed
//! for every role on the service). Every result must then name that system, or the Church rules on
//! this Mac, as its source; a copy with no system may name neither, nor Genesis; and `role_numbers`
//! must fit the rows (`numbers_fit`). A Planning Center
//! copy has neither key and is byte for byte as before; a reader older than 0.10.0 checks the keys
//! exactly, so it refuses a system's copy whole and says nothing is shared.
use crate::agent::tool_message_ok;
use crate::background;
use crate::ledger::{EventType, FailureCode, RunState, TaskKind, TaskRow};
use crate::name_guard::NameGuard;
use crate::sunday_check::{parse_rfc3339, rfc3339};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs::OpenOptions,
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
};

pub const SHARED_FILE: &str = "shared-check.json";
pub const SHARED_FORMAT: &str = "ozzie-shared-check-2";
/// Present while the leader has sharing on. Holds no data.
pub const ON_FILE: &str = ".shared-check.on";
/// core/mcp/snapshot.ts SHARED_TOOLS, pinned by a test.
pub const SHARED_TOOLS: [&str; 9] = [
    "sunday.overview",
    "sunday.open_needs",
    "sunday.pending_requests",
    "sunday.rule_checkins",
    "sunday.not_checked",
    "rooms.conflicts",
    "followups.unowned",
    "groups.clashes",
    "rules.current",
];
/// Where one copy lives in the app data folder: its file, and the marker present while the leader
/// has it on. Each copy is turned on and off, written, cleared and cleaned up on its own.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Place {
    pub file: &'static str,
    pub on_file: &'static str,
}
/// The copy for other AI apps (core/mcp).
pub const OTHER_AI_APPS: Place = Place {
    file: SHARED_FILE,
    on_file: ON_FILE,
};
/// The church system a copy's check read when it isn't Planning Center (core/mcp/snapshot.ts
/// SHARED_SYSTEMS). Genesis shares no volunteer schedules, so it has no copy.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SystemId {
    B1,
    Breeze,
}
impl SystemId {
    /// The source its results name (fixed/vocabulary.json `sources`).
    pub const fn source(self) -> &'static str {
        match self {
            Self::B1 => "B1 Church",
            Self::Breeze => "Breeze",
        }
    }
}
/// Whether that system gave the number of people needed for every role on the service, for some
/// of them, or for none (Breeze's older volunteers page gives none): what Siri, Shortcuts and other
/// AI apps are told about whether a role is full (core/mcp/snapshot.ts ROLE_NUMBERS).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub enum RoleNumbers {
    #[serde(rename = "all")]
    Every,
    #[serde(rename = "some")]
    Partly,
    #[serde(rename = "none")]
    Unshared,
}
/// A church on B1 Church or Breeze, as the webview hands it in. Absent for Planning Center.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SharedSystem {
    pub id: SystemId,
    pub role_numbers: RoleNumbers,
}
/// Every other church system a result can name (fixed/vocabulary.json `sources`): never in a copy
/// with no system, so a system's check can't be written as Planning Center's.
const OTHER_SOURCES: [&str; 3] = ["B1 Church", "Breeze", "Genesis"];
/// The Church rules' own source: settings on this Mac, in every church's copy.
const RULES_SOURCE: &str = "Church rules on this Mac";

/// Most recent ledger tasks shared (core/mcp/snapshot.ts MAX_SHARED_TASKS).
pub const MAX_TASKS: usize = 20;
/// Largest file written (core/mcp/snapshot.ts MAX_SHARED_BYTES).
pub const MAX_BYTES: usize = 256 * 1024;

/// One share, stop, clear or start-up clean-up at a time (of either copy), so a share can't land
/// after sharing was turned off, whatever order the commands arrive in.
static LOCK: Mutex<()> = Mutex::new(());
fn locked() -> MutexGuard<'static, ()> {
    LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ShareError {
    /// A result that isn't a shared tool's, appears twice, or fails the tool-message check; or a
    /// copy id outside its shape.
    Invalid,
    /// Sharing is off: nothing is written.
    Off,
    /// The app data folder couldn't be written, or the copy couldn't be removed.
    Unavailable,
}

#[derive(Serialize)]
struct SharedEvent<'a> {
    #[serde(rename = "type")]
    kind: EventType,
    detail: &'a str,
    at: &'a str,
}
/// A ledger row without its task id or procedure hash: what ran and how it ended.
#[derive(Serialize)]
struct SharedTask<'a> {
    kind: TaskKind,
    skill_id: &'a str,
    state: RunState,
    created_at: &'a str,
    updated_at: &'a str,
    failure: Option<FailureCode>,
    events: Vec<SharedEvent<'a>>,
}
#[derive(Serialize)]
struct SharedCheck<'a> {
    format: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    system: Option<SystemId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    role_numbers: Option<RoleNumbers>,
    copy_id: &'a str,
    checked_at: String,
    shared_at: String,
    envelopes: Vec<Value>,
    tasks: Vec<SharedTask<'a>>,
}

/// A copy id (core/mcp/snapshot.ts COPY_ID): six consonant-digit pairs, random in the webview, so
/// it can't spell a word or a name or hold a run of digits that reads as a phone number.
pub fn copy_id_ok(id: &str) -> bool {
    let b = id.as_bytes();
    b.len() == 12
        && b.chunks(2).all(|pair| {
            b"BCDFGHJKLMNPQRSTVWXZ".contains(&pair[0]) && (b'2'..=b'9').contains(&pair[1])
        })
}

/// An envelope's check time (any spelling the closed grammar allows: minutes, seconds or
/// milliseconds, `Z` or an offset) as milliseconds since 1970, or None.
fn instant_ms(text: &str) -> Option<u64> {
    let (base, offset_minutes) = if let Some(base) = text.strip_suffix('Z') {
        (base, 0i64)
    } else {
        let at = text.len().checked_sub(6)?;
        let (base, zone) = (text.get(..at)?, text.get(at..)?.as_bytes());
        let sign = match zone[0] {
            b'+' => 1,
            b'-' => -1,
            _ => return None,
        };
        let hh = std::str::from_utf8(&zone[1..3]).ok()?;
        let mm = std::str::from_utf8(&zone[4..6]).ok()?;
        if zone[3] != b':' || !hh.bytes().chain(mm.bytes()).all(|c| c.is_ascii_digit()) {
            return None;
        }
        let (h, m): (i64, i64) = (hh.parse().ok()?, mm.parse().ok()?);
        if h > 23 || m > 59 {
            return None;
        }
        (base, sign * (h * 60 + m))
    };
    let padded = match base.len() {
        16 => format!("{base}:00.000Z"),
        19 => format!("{base}.000Z"),
        23 => format!("{base}Z"),
        _ => return None,
    };
    let local = i64::try_from(parse_rfc3339(&padded)?).ok()?;
    u64::try_from(local.checked_sub(offset_minutes * 60_000)?).ok()
}

/// The tool results, each checked as a tool message from a shared tool, at most one per tool.
pub fn checked_envelopes(
    envelopes: &[String],
    names: &NameGuard,
) -> Result<Vec<Value>, ShareError> {
    if envelopes.is_empty() || envelopes.len() > SHARED_TOOLS.len() {
        return Err(ShareError::Invalid);
    }
    let mut seen: Vec<String> = Vec::new();
    envelopes
        .iter()
        .map(|text| {
            let value: Value = serde_json::from_str(text).map_err(|_| ShareError::Invalid)?;
            let tool = value
                .get("tool")
                .and_then(Value::as_str)
                .filter(|tool| SHARED_TOOLS.contains(tool) && !seen.iter().any(|s| s == tool))
                .ok_or(ShareError::Invalid)?
                .to_owned();
            // Background-check wording never goes into the copy for other AI apps, even as
            // placeholders (owner decision 2026-11-14; review B L3): refused whole, as any result
            // that fails its check is, so nothing is written.
            if !tool_message_ok(text, &tool, names) || background::in_tool_result(text) {
                return Err(ShareError::Invalid);
            }
            seen.push(tool);
            Ok(value)
        })
        .collect()
}

/// Whether checked results fit the church system they are shared as: with `system`, every one
/// names that system or the Church rules on this Mac as its source, and at least one names the
/// system; with none (Planning Center), none names another church system.
fn sources_fit(envelopes: &[Value], system: Option<SharedSystem>) -> bool {
    let sources: Vec<Option<&str>> = envelopes
        .iter()
        .map(|e| e.get("source").and_then(Value::as_str))
        .collect();
    match system {
        Some(s) => {
            let own = Some(s.id.source());
            sources.iter().all(|&x| x == own || x == Some(RULES_SOURCE)) && sources.contains(&own)
        }
        None => !sources
            .iter()
            .any(|x| x.is_some_and(|x| OTHER_SOURCES.contains(&x))),
    }
}

/// Whether the page's `role_numbers` fits the rows checked here (privacy review L3): a role the overview
/// or the open roles count as needing people carries the system's number ("remaining"), or "not known"
/// where there is none. So a counted number means the system numbered a role (never "none"), and "not
/// known" means one it didn't (never "all"). Roles with no number that need nobody aren't rows, so
/// "some" and the rest are the page's, from the roles its check read.
fn numbers_fit(envelopes: &[Value], numbers: RoleNumbers) -> bool {
    let rows = envelopes.iter().flat_map(|e| {
        let list = match e.get("tool").and_then(Value::as_str) {
            Some("sunday.overview") => "findings",
            Some("sunday.open_needs") => "needs",
            _ => return Vec::new(),
        };
        e.pointer(&format!("/payload/{list}"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    });
    let mut remaining = rows
        .filter(|r| r.get("kind").and_then(Value::as_str) == Some("needs people"))
        .map(|r| r.get("remaining").is_some_and(Value::is_number));
    match numbers {
        RoleNumbers::Every => remaining.all(|numbered| numbered),
        RoleNumbers::Unshared => remaining.all(|numbered| !numbered),
        RoleNumbers::Partly => true,
    }
}

/// The file's bytes: the checked results, when they were checked (the earliest check time among
/// them, never the time of saving), the copy id and the newest MAX_TASKS ledger rows (newest first).
pub fn shared_bytes(
    envelopes: &[String],
    tasks: &[TaskRow],
    names: &NameGuard,
    copy_id: &str,
    now_ms: u64,
) -> Result<Vec<u8>, ShareError> {
    shared_bytes_of(envelopes, tasks, names, copy_id, None, now_ms)
}

/// `shared_bytes` for a church on `system` (None: Planning Center, exactly as `shared_bytes`).
pub fn shared_bytes_of(
    envelopes: &[String],
    tasks: &[TaskRow],
    names: &NameGuard,
    copy_id: &str,
    system: Option<SharedSystem>,
    now_ms: u64,
) -> Result<Vec<u8>, ShareError> {
    if !copy_id_ok(copy_id) {
        return Err(ShareError::Invalid);
    }
    let envelopes = checked_envelopes(envelopes, names)?;
    if !sources_fit(&envelopes, system)
        || system.is_some_and(|s| !numbers_fit(&envelopes, s.role_numbers))
    {
        return Err(ShareError::Invalid);
    }
    let checked_ms = envelopes
        .iter()
        .map(|e| {
            e.get("check_time")
                .and_then(Value::as_str)
                .and_then(instant_ms)
        })
        .collect::<Option<Vec<u64>>>()
        .and_then(|times| times.into_iter().min())
        .ok_or(ShareError::Invalid)?;
    let check = SharedCheck {
        format: SHARED_FORMAT,
        system: system.map(|s| s.id),
        role_numbers: system.map(|s| s.role_numbers),
        copy_id,
        checked_at: rfc3339(checked_ms),
        shared_at: rfc3339(now_ms),
        envelopes,
        tasks: tasks
            .iter()
            .take(MAX_TASKS)
            .map(|t| SharedTask {
                kind: t.kind,
                skill_id: &t.skill_id,
                state: t.state,
                created_at: &t.created_at,
                updated_at: &t.updated_at,
                failure: t.failure,
                events: t
                    .events
                    .iter()
                    .map(|e| SharedEvent {
                        kind: e.kind,
                        detail: &e.detail,
                        at: &e.at,
                    })
                    .collect(),
            })
            .collect(),
    };
    let bytes = serde_json::to_vec(&check).map_err(|_| ShareError::Invalid)?;
    if bytes.len() > MAX_BYTES {
        return Err(ShareError::Invalid);
    }
    Ok(bytes)
}

/// Whether the leader has sharing on: the marker is a regular file (never a link).
pub fn is_on(dir: &Path) -> bool {
    is_on_at(OTHER_AI_APPS, dir)
}
/// Turning sharing on: writes the marker (0600). Nothing is shared until the next check is.
pub fn start(dir: &Path) -> Result<(), ShareError> {
    start_at(OTHER_AI_APPS, dir)
}
/// Checks and writes the shared file in `dir`, replacing the last one whole. Refused while off.
pub fn share(
    dir: &Path,
    envelopes: &[String],
    tasks: &[TaskRow],
    names: &NameGuard,
    copy_id: &str,
    now_ms: u64,
) -> Result<(), ShareError> {
    share_at(OTHER_AI_APPS, dir, envelopes, tasks, names, copy_id, now_ms)
}
/// `share` for a church on `system` (None: Planning Center, exactly as `share`).
pub fn share_of(
    dir: &Path,
    envelopes: &[String],
    tasks: &[TaskRow],
    names: &NameGuard,
    copy_id: &str,
    system: Option<SharedSystem>,
    now_ms: u64,
) -> Result<(), ShareError> {
    share_system_at(
        OTHER_AI_APPS,
        dir,
        envelopes,
        tasks,
        names,
        copy_id,
        system,
        now_ms,
    )
}
/// Turning sharing off (`stop_at`).
pub fn stop(dir: &Path) -> Result<(), ShareError> {
    stop_at(OTHER_AI_APPS, dir)
}
/// Nothing current to share (`clear_at`).
pub fn clear(dir: &Path) -> Result<(), ShareError> {
    clear_at(OTHER_AI_APPS, dir)
}
/// At every start of the app (`startup_at`).
pub fn startup(dir: &Path) -> Result<(), ShareError> {
    startup_at(OTHER_AI_APPS, dir)
}

/// Whether the copy at `place` is on: its marker is a regular file (never a link).
pub fn is_on_at(place: Place, dir: &Path) -> bool {
    std::fs::symlink_metadata(dir.join(place.on_file)).is_ok_and(|m| m.file_type().is_file())
}

/// Turning a copy on: writes its marker (0600). Nothing is written until the next check is.
pub fn start_at(place: Place, dir: &Path) -> Result<(), ShareError> {
    let _guard = locked();
    create_private_dir(dir).map_err(|_| ShareError::Unavailable)?;
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options
        .open(dir.join(place.on_file))
        .and_then(|file| file.sync_all())
        .map_err(|_| ShareError::Unavailable)
}

/// Checks and writes the copy at `place` in `dir` (`shared_bytes`), replacing the last one whole.
/// Refused while that copy is off.
pub fn share_at(
    place: Place,
    dir: &Path,
    envelopes: &[String],
    tasks: &[TaskRow],
    names: &NameGuard,
    copy_id: &str,
    now_ms: u64,
) -> Result<(), ShareError> {
    share_system_at(place, dir, envelopes, tasks, names, copy_id, None, now_ms)
}

/// `share_at` for a church on `system` (`shared_bytes_of`; None: Planning Center, exactly as
/// `share_at`).
#[allow(clippy::too_many_arguments)]
pub fn share_system_at(
    place: Place,
    dir: &Path,
    envelopes: &[String],
    tasks: &[TaskRow],
    names: &NameGuard,
    copy_id: &str,
    system: Option<SharedSystem>,
    now_ms: u64,
) -> Result<(), ShareError> {
    let _guard = locked();
    if !is_on_at(place, dir) {
        return Err(ShareError::Off);
    }
    let bytes = shared_bytes_of(envelopes, tasks, names, copy_id, system, now_ms)?;
    write_private(place, dir, &bytes).map_err(|_| ShareError::Unavailable)
}

/// Writes fixed bytes, chosen here in native code and holding no fact, as the copy at `place`, under
/// the same lock and the same on-marker as every share (shortcuts_check.rs `save_genesis`).
pub(crate) fn write_fixed_at(
    place: Place,
    dir: &Path,
    bytes: &'static [u8],
) -> Result<(), ShareError> {
    let _guard = locked();
    if !is_on_at(place, dir) {
        return Err(ShareError::Off);
    }
    write_private(place, dir, bytes).map_err(|_| ShareError::Unavailable)
}

/// Turning a copy off: removes its marker first (so nothing more is written, and the next start
/// clears what's left even if this fails part-way), then the copy and any half-written one, each
/// tried whatever happened to the one before. Already gone is fine; anything else that can't be
/// removed is `Unavailable`.
pub fn stop_at(place: Place, dir: &Path) -> Result<(), ShareError> {
    let _guard = locked();
    let marker = remove(&dir.join(place.on_file));
    let copies = remove_copies(place, dir);
    marker.and(copies)
}

/// Nothing current to share (no check, another church's, a disconnected Planning Center, deleted
/// recordings, a refused share): removes the copy and any half-written one. It stays on.
pub fn clear_at(place: Place, dir: &Path) -> Result<(), ShareError> {
    let _guard = locked();
    remove_copies(place, dir)
}

/// At every start of the app: a half-written copy is always removed, and while the copy is off the
/// copy too, so a copy that outlived turning it off (a failed removal, a crash) never stays.
pub fn startup_at(place: Place, dir: &Path) -> Result<(), ShareError> {
    let _guard = locked();
    remove(&partial_path(place, dir))?;
    if is_on_at(place, dir) {
        Ok(())
    } else {
        remove(&dir.join(place.file))
    }
}

fn partial_path(place: Place, dir: &Path) -> PathBuf {
    dir.join(format!(".{}.partial", place.file))
}
fn remove(path: &Path) -> Result<(), ShareError> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(ShareError::Unavailable),
    }
}
fn remove_copies(place: Place, dir: &Path) -> Result<(), ShareError> {
    let file = remove(&dir.join(place.file));
    let partial = remove(&partial_path(place, dir));
    file.and(partial)
}

fn create_private_dir(dir: &Path) -> io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(dir)
}

fn write_private(place: Place, dir: &Path, bytes: &[u8]) -> io::Result<()> {
    create_private_dir(dir)?;
    // Written aside then renamed, so a reader never sees half a file. A partial file left by a
    // crash is removed first.
    let partial = partial_path(place, dir);
    let _ = std::fs::remove_file(&partial);
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let written = options.open(&partial).and_then(|mut file| {
        file.write_all(bytes)?;
        file.sync_all()
    });
    if let Err(error) = written.and_then(|()| std::fs::rename(&partial, dir.join(place.file))) {
        let _ = std::fs::remove_file(&partial);
        return Err(error);
    }
    Ok(())
}

#[cfg(test)]
#[path = "shared_check_tests.rs"]
mod tests;
