//! The last check, shared with other AI apps on this Mac (harness plan H5). Off unless the leader turns
//! it on in Settings. The webview builds the shared tool results with the same read-only agent tools
//! Ask Ozzie uses (core/mcp/snapshot.ts `sharedEnvelopes`); this module checks every one again exactly
//! as `agent_step` checks a tool message before it may reach a model (`agent::tool_message_ok`: the
//! closed grammar of fixed/vocabulary.json, no hidden character, escape or contact detail, and no
//! name this session has shown in any label, time or fixed sentence), adds the task ledger's
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
use crate::agent::tool_message_ok;
use crate::ledger::{EventType, FailureCode, RunState, TaskKind, TaskRow};
use crate::name_guard::NameGuard;
use crate::sunday_check::{parse_rfc3339, rfc3339};
use serde::Serialize;
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
/// Most recent ledger tasks shared (core/mcp/snapshot.ts MAX_SHARED_TASKS).
pub const MAX_TASKS: usize = 20;
/// Largest file written (core/mcp/snapshot.ts MAX_SHARED_BYTES).
pub const MAX_BYTES: usize = 256 * 1024;

/// One share, stop, clear or start-up clean-up at a time, so a share can't land after sharing was
/// turned off, whatever order the commands arrive in.
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
            if !tool_message_ok(text, &tool, names) {
                return Err(ShareError::Invalid);
            }
            seen.push(tool);
            Ok(value)
        })
        .collect()
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
    if !copy_id_ok(copy_id) {
        return Err(ShareError::Invalid);
    }
    let envelopes = checked_envelopes(envelopes, names)?;
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
    std::fs::symlink_metadata(dir.join(ON_FILE)).is_ok_and(|m| m.file_type().is_file())
}

/// Turning sharing on: writes the marker (0600). Nothing is shared until the next check is.
pub fn start(dir: &Path) -> Result<(), ShareError> {
    let _guard = locked();
    create_private_dir(dir).map_err(|_| ShareError::Unavailable)?;
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options
        .open(dir.join(ON_FILE))
        .and_then(|file| file.sync_all())
        .map_err(|_| ShareError::Unavailable)
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
    let _guard = locked();
    if !is_on(dir) {
        return Err(ShareError::Off);
    }
    let bytes = shared_bytes(envelopes, tasks, names, copy_id, now_ms)?;
    write_private(dir, &bytes).map_err(|_| ShareError::Unavailable)
}

/// Turning sharing off: removes the marker first (so nothing more is written, and the next start
/// clears what's left even if this fails part-way), then the copy and any half-written one, each
/// tried whatever happened to the one before. Already gone is fine; anything else that can't be
/// removed is `Unavailable`.
pub fn stop(dir: &Path) -> Result<(), ShareError> {
    let _guard = locked();
    let marker = remove(&dir.join(ON_FILE));
    let copies = remove_copies(dir);
    marker.and(copies)
}

/// Nothing current to share (no check, another church's, a disconnected Planning Center, deleted
/// recordings, a refused share): removes the copy and any half-written one. Sharing stays on.
pub fn clear(dir: &Path) -> Result<(), ShareError> {
    let _guard = locked();
    remove_copies(dir)
}

/// At every start of the app: a half-written copy is always removed, and while sharing is off the
/// copy too, so a copy that outlived turning sharing off (a failed removal, a crash) never stays.
pub fn startup(dir: &Path) -> Result<(), ShareError> {
    let _guard = locked();
    remove(&partial_path(dir))?;
    if is_on(dir) {
        Ok(())
    } else {
        remove(&dir.join(SHARED_FILE))
    }
}

fn partial_path(dir: &Path) -> PathBuf {
    dir.join(format!(".{SHARED_FILE}.partial"))
}
fn remove(path: &Path) -> Result<(), ShareError> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(ShareError::Unavailable),
    }
}
fn remove_copies(dir: &Path) -> Result<(), ShareError> {
    let file = remove(&dir.join(SHARED_FILE));
    let partial = remove(&partial_path(dir));
    file.and(partial)
}

fn create_private_dir(dir: &Path) -> io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(dir)
}

fn write_private(dir: &Path, bytes: &[u8]) -> io::Result<()> {
    create_private_dir(dir)?;
    // Written aside then renamed, so a reader never sees half a file. A partial file left by a
    // crash is removed first.
    let partial = partial_path(dir);
    let _ = std::fs::remove_file(&partial);
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let written = options.open(&partial).and_then(|mut file| {
        file.write_all(bytes)?;
        file.sync_all()
    });
    if let Err(error) = written.and_then(|()| std::fs::rename(&partial, dir.join(SHARED_FILE))) {
        let _ = std::fs::remove_file(&partial);
        return Err(error);
    }
    Ok(())
}

#[cfg(test)]
#[path = "shared_check_tests.rs"]
mod tests;
