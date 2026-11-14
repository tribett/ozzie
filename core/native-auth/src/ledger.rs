//! Local task ledger: accepted-task state outside any conversation (build contract §2.4, harness
//! plan H3), for What happened, automatic checks and the watchdog.
//!
//! Name-free by construction: a task is its id (a lowercase UUID), kind (ask | skill | check), skill
//! id and hash, state, times, failure code, events, the number of tool calls each model step
//! minted and the sha-256 of each step's reply (so agent.rs can require the conversation to echo
//! exactly what it returned). Every field is a fixed vocabulary or a fixed shape: the skill is one of the bundled
//! procedures (fixed.rs), paired with its kind (ask runs answer-from-what-was-read and nothing else
//! does; check runs sunday-ready; skill runs any other), and is admitted only under the sha-256 of
//! the bundled file. Event details are a closed grammar over the tool allowlist, completeness and
//! failure codes (see `detail_ok`). Questions, answers and source text are never stored; there is
//! no field for them.
//!
//! Model events are native code's alone (agent.rs): `reserve_step` appends `<n>` immediately
//! before a step's request is sent, at most MAX_STEPS per task and one step in flight at a time,
//! and `finish_step` appends `<n> <outcome>` with the number of tool calls that reply minted and
//! the reply's hash. Step
//! and tool-call caps are counted from these persisted events, never from the webview; the webview
//! records tool events only.
//!
//! States follow core/src/ledger.ts (pinned by a test): proposed → admitted → running →
//! verified | failed | cancelled, cancel allowed from admitted and running, terminal is terminal.
//! A task enters the ledger when admitted. The one transition outside that graph belongs to the host,
//! not the worker: `recover()` at app start fails every task still admitted or running with
//! `interrupted`, a code the webview cannot set.
//!
//! Storage: `task-ledger.jsonl` in the app data folder (file 0600, folder 0700), one JSON object per
//! line, each a complete snapshot of one task. Every change appends one line and fsyncs it before
//! the change is visible; the last valid snapshot of a task wins and a terminal one is never
//! replaced. Opening checks every line again exactly as a live change is checked (a line that fails
//! is dropped), keeps the newest KEEP_TASKS tasks and rewrites the file compacted (temporary file,
//! fsync, rename), so a torn last line from a crash is never appended to; the file is compacted
//! again every `compact_after` appends. `task-ledger.lock` is held for the ledger's lifetime, so a
//! second copy of the app can't interleave writes; one process serializes through a mutex.
//! A JSON-lines file rather than SQLite: the data is a few hundred small records, rusqlite's bundled
//! SQLite would add a C build to both crates and their CI, and it is not in the build cache.
use crate::agent::{MAX_STEPS, MAX_TOOL_CALLS, NATIVE_TOOL_ALLOWLIST};
use crate::fixed::{self, ASK_SKILL, CHECK_SKILL};
use crate::sunday_check::{rfc3339, unix_ms};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs::{File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
};

pub const LEDGER_FILE: &str = "task-ledger.jsonl";
pub const LOCK_FILE: &str = "task-ledger.lock";
/// Tasks kept; the oldest are dropped first.
pub const KEEP_TASKS: usize = 500;
/// Tool and model events per task (contract limits: 6 model steps and 10 tool calls).
pub const MAX_STEP_EVENTS: usize = 48;
/// All events per task: step events plus admitted, running and one terminal event.
pub const MAX_EVENTS: usize = MAX_STEP_EVENTS + 3;
pub const COMPACT_AFTER_LINES: usize = 2_000;
/// Admission order stays below 2^53, so it is exact as a JavaScript number and can never wrap.
pub const MAX_ORDER: u64 = 1 << 53;
const MAX_LINE_BYTES: usize = 16_384;
const MAX_FILE_BYTES: u64 = 32 << 20;
const RECORD_VERSION: u8 = 1;
/// contract.ts Completeness (core/src/broker.ts), pinned by a test.
const COMPLETENESS: [&str; 4] = ["complete", "partial", "stale", "denied"];

/// The closed error vocabulary for ledger commands.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LedgerError {
    /// A field failed its shape or vocabulary.
    Invalid,
    UnknownTask,
    /// Not allowed from the task's state (terminal is terminal), or the task already exists.
    Transition,
    /// The task already holds MAX_STEP_EVENTS tool and model events.
    Full,
    /// The ledger file can't be read or written, or another copy of the app holds it.
    Unavailable,
}

/// Why native code can't take a model step for a task. agent.rs maps these to its own codes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StepRefusal {
    /// Not in the ledger, not running, or a step for it is already in flight.
    Task,
    /// MAX_STEPS steps taken, or the task already holds MAX_STEP_EVENTS tool and model events.
    Limit,
    /// The ledger file can't be written.
    Unavailable,
}
impl From<LedgerError> for StepRefusal {
    fn from(error: LedgerError) -> Self {
        match error {
            LedgerError::UnknownTask | LedgerError::Transition | LedgerError::Invalid => Self::Task,
            LedgerError::Full => Self::Limit,
            LedgerError::Unavailable => Self::Unavailable,
        }
    }
}

/// What agent.rs needs to know about a running task before a step. Name-free fields only.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StepView {
    pub kind: TaskKind,
    pub skill_id: String,
    /// Steps taken so far (0 to MAX_STEPS); the next is `steps + 1`.
    pub steps: u8,
    /// Tool calls each finished step minted, in step order: the ids minted for this task are
    /// `call_<step>_<n>` with n below `minted[step - 1]`.
    pub minted: Vec<u8>,
    /// The sha-256 of each finished step's reply (`agent::reply_hash`), in step order; empty for a
    /// step that returned no reply.
    pub replies: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskKind {
    Ask,
    Skill,
    Check,
}
impl TaskKind {
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "ask" => Some(Self::Ask),
            "skill" => Some(Self::Skill),
            "check" => Some(Self::Check),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RunState {
    Proposed,
    Admitted,
    Running,
    Verified,
    Failed,
    Cancelled,
}
impl RunState {
    pub const ALL: [Self; 6] = [
        Self::Proposed,
        Self::Admitted,
        Self::Running,
        Self::Verified,
        Self::Failed,
        Self::Cancelled,
    ];
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Proposed => "proposed",
            Self::Admitted => "admitted",
            Self::Running => "running",
            Self::Verified => "verified",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
    pub fn parse(text: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|state| state.as_str() == text)
    }
    /// core/src/ledger.ts NEXT.
    pub fn next(self) -> &'static [Self] {
        match self {
            Self::Proposed => &[Self::Admitted, Self::Cancelled],
            Self::Admitted => &[Self::Running, Self::Cancelled],
            Self::Running => &[Self::Verified, Self::Failed, Self::Cancelled],
            Self::Verified | Self::Failed | Self::Cancelled => &[],
        }
    }
    pub fn terminal(self) -> bool {
        self.next().is_empty()
    }
}

/// contract.ts FailureCode (ToolError plus the task codes), pinned by a test.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FailureCode {
    Denied,
    Stale,
    Partial,
    ProviderFailure,
    Unverified,
    InvalidTask,
    Limit,
    Timeout,
    Cancelled,
    Egress,
    Fidelity,
    Transport,
    NoModel,
    Interrupted,
}
impl FailureCode {
    pub const ALL: [Self; 14] = [
        Self::Denied,
        Self::Stale,
        Self::Partial,
        Self::ProviderFailure,
        Self::Unverified,
        Self::InvalidTask,
        Self::Limit,
        Self::Timeout,
        Self::Cancelled,
        Self::Egress,
        Self::Fidelity,
        Self::Transport,
        Self::NoModel,
        Self::Interrupted,
    ];
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Denied => "denied",
            Self::Stale => "stale",
            Self::Partial => "partial",
            Self::ProviderFailure => "provider-failure",
            Self::Unverified => "unverified",
            Self::InvalidTask => "invalid-task",
            Self::Limit => "limit",
            Self::Timeout => "timeout",
            Self::Cancelled => "cancelled",
            Self::Egress => "egress",
            Self::Fidelity => "fidelity",
            Self::Transport => "transport",
            Self::NoModel => "no-model",
            Self::Interrupted => "interrupted",
        }
    }
    pub fn parse(text: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|code| code.as_str() == text)
    }
}

/// contract.ts TaskEvent["type"], pinned by a test.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EventType {
    Admitted,
    Running,
    Tool,
    Model,
    Verified,
    Failed,
    Cancelled,
}
impl EventType {
    pub const ALL: [Self; 7] = [
        Self::Admitted,
        Self::Running,
        Self::Tool,
        Self::Model,
        Self::Verified,
        Self::Failed,
        Self::Cancelled,
    ];
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Admitted => "admitted",
            Self::Running => "running",
            Self::Tool => "tool",
            Self::Model => "model",
            Self::Verified => "verified",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
    pub fn parse(text: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.as_str() == text)
    }
    /// The state a lifecycle event records; None for tool and model events.
    fn state(self) -> Option<RunState> {
        match self {
            Self::Admitted => Some(RunState::Admitted),
            Self::Running => Some(RunState::Running),
            Self::Verified => Some(RunState::Verified),
            Self::Failed => Some(RunState::Failed),
            Self::Cancelled => Some(RunState::Cancelled),
            Self::Tool | Self::Model => None,
        }
    }
    fn of(state: RunState) -> Self {
        match state {
            RunState::Proposed | RunState::Admitted => Self::Admitted,
            RunState::Running => Self::Running,
            RunState::Verified => Self::Verified,
            RunState::Failed => Self::Failed,
            RunState::Cancelled => Self::Cancelled,
        }
    }
}

/// A lowercase UUID, as `crypto.randomUUID()` writes it.
pub fn task_id_ok(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(i, b)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                b == b'-'
            } else {
                matches!(b, b'0'..=b'9' | b'a'..=b'f')
            }
        })
}
pub fn skill_id_ok(id: &str) -> bool {
    (1..=48).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}
/// A bundled procedure, with the kind that runs it: ask runs answer-from-what-was-read and nothing
/// else runs it; check (the automatic check) runs sunday-ready; skill runs any other.
pub fn pairing_ok(kind: TaskKind, skill_id: &str) -> bool {
    fixed::skill(skill_id).is_some()
        && match kind {
            TaskKind::Ask => skill_id == ASK_SKILL,
            TaskKind::Check => skill_id == CHECK_SKILL,
            TaskKind::Skill => skill_id != ASK_SKILL,
        }
}
/// sha-256, lowercase hex (contract.ts Skill.hash).
pub fn skill_hash_ok(hash: &str) -> bool {
    hash.len() == 64 && hash.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}
/// A step's reply hash: sha-256 in lowercase hex, or empty for a step that returned no reply.
pub fn reply_hash_ok(hash: &str) -> bool {
    hash.is_empty() || skill_hash_ok(hash)
}
/// Event details: at most 64 of `[a-z0-9_.:\- ]`, and then one closed grammar per event type:
///  - tool: `<allowlisted tool> <status>` or `<status>` alone (a tool the allowlist doesn't hold is
///    never named), where status is a Completeness value or a FailureCode;
///  - model: `<step>` or `<step> <stop|tool_calls|length|FailureCode>`, step 1-99 (and, as
///    `record_ok` replays them, reservations in order up to MAX_STEPS, each closed at most once);
///  - admitted, running, verified: empty; failed: its FailureCode; cancelled: empty or `cancelled`.
pub fn detail_ok(kind: EventType, detail: &str) -> bool {
    let shape = detail.len() <= 64
        && detail
            .bytes()
            .all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'_' | b'.' | b':' | b'-' | b' '));
    let status = |s: &str| COMPLETENESS.contains(&s) || FailureCode::parse(s).is_some();
    let step = |s: &str| {
        (1..=2).contains(&s.len()) && !s.starts_with('0') && s.bytes().all(|b| b.is_ascii_digit())
    };
    shape
        && match kind {
            EventType::Tool => match detail.split_once(' ') {
                Some((tool, s)) => NATIVE_TOOL_ALLOWLIST.contains(&tool) && status(s),
                None => status(detail),
            },
            EventType::Model => match detail.split_once(' ') {
                Some((n, outcome)) => {
                    step(n)
                        && (matches!(outcome, "stop" | "tool_calls" | "length")
                            || FailureCode::parse(outcome).is_some())
                }
                None => step(detail),
            },
            EventType::Admitted | EventType::Running | EventType::Verified => detail.is_empty(),
            EventType::Failed => FailureCode::parse(detail).is_some(),
            EventType::Cancelled => detail.is_empty() || detail == "cancelled",
        }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Event {
    sequence: u32,
    at_ms: u64,
    #[serde(rename = "type")]
    kind: EventType,
    detail: String,
}
/// One task as stored: one line of the ledger file.
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    v: u8,
    /// Admission order, for retention and newest-first listing.
    order: u64,
    task_id: String,
    kind: TaskKind,
    skill_id: String,
    skill_hash: String,
    state: RunState,
    created_ms: u64,
    updated_ms: u64,
    failure: Option<FailureCode>,
    events: Vec<Event>,
    /// Tool calls each finished model step minted (see `StepView::minted`).
    #[serde(default)]
    minted: Vec<u8>,
    /// Each finished model step's reply hash (see `StepView::replies`). Empty in records written
    /// before replies were hashed; a task that is still running always has one per finished step.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    replies: Vec<String>,
}

/// One task for What happened. `events` are contract.ts TaskEvents.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct TaskRow {
    pub task_id: String,
    pub kind: TaskKind,
    pub skill_id: String,
    pub skill_hash: String,
    pub state: RunState,
    pub created_at: String,
    pub updated_at: String,
    pub failure: Option<FailureCode>,
    pub events: Vec<TaskEventRow>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct TaskEventRow {
    pub task_id: String,
    pub sequence: u32,
    pub at: String,
    #[serde(rename = "type")]
    pub kind: EventType,
    pub detail: String,
}
fn row(record: &Record) -> TaskRow {
    TaskRow {
        task_id: record.task_id.clone(),
        kind: record.kind,
        skill_id: record.skill_id.clone(),
        skill_hash: record.skill_hash.clone(),
        state: record.state,
        created_at: rfc3339(record.created_ms),
        updated_at: rfc3339(record.updated_ms),
        failure: record.failure,
        events: record
            .events
            .iter()
            .map(|event| TaskEventRow {
                task_id: record.task_id.clone(),
                sequence: event.sequence,
                at: rfc3339(event.at_ms),
                kind: event.kind,
                detail: event.detail.clone(),
            })
            .collect(),
    }
}

/// `from` → `to` as a change may make it: the graph, staying put, or the host's recovery.
fn may_follow(from: RunState, to: RunState, failure: Option<FailureCode>) -> bool {
    from == to
        || from.next().contains(&to)
        || (to == RunState::Failed
            && failure == Some(FailureCode::Interrupted)
            && matches!(from, RunState::Admitted | RunState::Running))
}
fn failure_ok(state: RunState, failure: Option<FailureCode>) -> bool {
    match state {
        RunState::Failed => failure.is_some(),
        RunState::Cancelled => failure.is_none() || failure == Some(FailureCode::Cancelled),
        _ => failure.is_none(),
    }
}
/// Model events as native code appends them: reservations `1`, `2` … in order, at most MAX_STEPS,
/// a new one only once the last is closed, and each closed by at most one `<n> <outcome>`. Returns
/// the steps taken and whether the last is still in flight.
fn model_steps(events: &[Event]) -> Option<(u8, bool)> {
    let (mut taken, mut open) = (0u8, false);
    for event in events.iter().filter(|event| event.kind == EventType::Model) {
        match event.detail.split_once(' ') {
            None => {
                let n: u8 = event.detail.parse().ok()?;
                if open || n != taken + 1 || n > MAX_STEPS {
                    return None;
                }
                (taken, open) = (n, true);
            }
            Some((n, _)) => {
                if !open || n.parse::<u8>().ok()? != taken {
                    return None;
                }
                open = false;
            }
        }
    }
    Some((taken, open))
}
/// One minted count per finished step, and no more than MAX_TOOL_CALLS in all; reply hashes, when
/// kept, one per finished step too.
fn minted_ok(record: &Record) -> bool {
    let total: usize = record.minted.iter().map(|&n| usize::from(n)).sum();
    let replies_ok = (record.replies.is_empty() || record.replies.len() == record.minted.len())
        && record.replies.iter().all(|hash| reply_hash_ok(hash));
    replies_ok
        && model_steps(&record.events).is_some_and(|(taken, open)| {
            record.minted.len() == usize::from(taken) - usize::from(open) && total <= MAX_TOOL_CALLS
        })
}
/// Every rule a stored task meets, checked on every change and again for every line read back.
/// The skill must be a bundled procedure paired with its kind; its hash is compared with the
/// bundled file only at admission, so a task stays readable after the file changes in an update.
fn record_ok(record: &Record) -> bool {
    let fields = record.v == RECORD_VERSION
        && record.order < MAX_ORDER
        && task_id_ok(&record.task_id)
        && skill_id_ok(&record.skill_id)
        && pairing_ok(record.kind, &record.skill_id)
        && skill_hash_ok(&record.skill_hash)
        && record.state != RunState::Proposed
        && failure_ok(record.state, record.failure)
        && record.created_ms <= record.updated_ms
        && (1..=MAX_EVENTS).contains(&record.events.len())
        && record.events[0].kind == EventType::Admitted
        && record
            .events
            .iter()
            .filter(|event| event.kind.state().is_none())
            .count()
            <= MAX_STEP_EVENTS;
    if !fields {
        return false;
    }
    // Lifecycle events replay the state; step events only while it is not terminal.
    let mut state = RunState::Proposed;
    let mut last_at = record.created_ms;
    let replayed = record.events.iter().enumerate().all(|(i, event)| {
        let ordered = event.sequence as usize == i && event.at_ms >= last_at;
        last_at = event.at_ms;
        let allowed = match event.kind.state() {
            Some(to) => {
                let ok = to != state && may_follow(state, to, record.failure);
                state = to;
                ok
            }
            None => matches!(state, RunState::Admitted | RunState::Running),
        };
        ordered && allowed && detail_ok(event.kind, &event.detail)
    });
    let terminal_detail = record
        .events
        .iter()
        .rev()
        .find(|event| event.kind.state().is_some())
        .is_some_and(|event| match record.state {
            RunState::Failed => record.failure.map(FailureCode::as_str) == Some(&*event.detail),
            RunState::Cancelled => {
                (event.detail == "cancelled") == (record.failure == Some(FailureCode::Cancelled))
            }
            _ => true,
        });
    replayed
        && state == record.state
        && last_at <= record.updated_ms
        && terminal_detail
        && minted_ok(record)
}
/// A later snapshot of the same task may replace an earlier one only as a real change would.
fn successor_ok(old: &Record, new: &Record) -> bool {
    !old.state.terminal()
        && old.order == new.order
        && old.kind == new.kind
        && old.skill_id == new.skill_id
        && old.skill_hash == new.skill_hash
        && old.created_ms == new.created_ms
        && new.events.len() >= old.events.len()
        && may_follow(old.state, new.state, new.failure)
        && new.events[..old.events.len()] == old.events[..]
        && new.minted.starts_with(&old.minted)
        && new.replies.starts_with(&old.replies)
}

fn private_dir(dir: &Path) -> io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(dir)
}
fn private_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options
}
/// Valid snapshots in admission order, newest KEEP_TASKS only.
fn load(path: &Path) -> io::Result<Vec<Record>> {
    let file = match File::open(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        result => result?,
    };
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(io::ErrorKind::InvalidData.into());
    }
    let mut tasks: Vec<Record> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    for line in bytes.split(|b| *b == b'\n') {
        if line.is_empty() || line.len() > MAX_LINE_BYTES {
            continue;
        }
        let Ok(record) = serde_json::from_slice::<Record>(line) else {
            continue;
        };
        if !record_ok(&record) {
            continue;
        }
        match index.get(&record.task_id) {
            Some(&at) => {
                if successor_ok(&tasks[at], &record) {
                    tasks[at] = record;
                }
            }
            None => {
                index.insert(record.task_id.clone(), tasks.len());
                tasks.push(record);
            }
        }
    }
    tasks.sort_by_key(|record| record.order);
    let excess = tasks.len().saturating_sub(KEEP_TASKS);
    tasks.drain(..excess);
    Ok(tasks)
}

struct Inner {
    path: PathBuf,
    /// Append handle; None after a failed compaction left it pointing at a replaced file.
    file: Option<File>,
    _lock: File,
    tasks: Vec<Record>,
    next_order: u64,
    appended: usize,
}
impl Inner {
    /// Appends one snapshot and fsyncs it. On failure the file is rewritten from memory, which
    /// doesn't hold this change, so a partly written line never stays in front of later appends.
    fn append(&mut self, record: &Record) -> Result<(), LedgerError> {
        let mut line = serde_json::to_vec(record).map_err(|_| LedgerError::Unavailable)?;
        if line.len() > MAX_LINE_BYTES {
            return Err(LedgerError::Full);
        }
        line.push(b'\n');
        let file = self.file.as_mut().ok_or(LedgerError::Unavailable)?;
        if file
            .write_all(&line)
            .and_then(|()| file.sync_data())
            .is_err()
        {
            let _ = self.compact();
            return Err(LedgerError::Unavailable);
        }
        self.appended += 1;
        Ok(())
    }
    /// Rewrites the file from memory: temporary file, fsync, rename, then a fresh append handle.
    fn compact(&mut self) -> io::Result<()> {
        let dir = self.path.parent().ok_or(io::ErrorKind::InvalidInput)?;
        let partial = dir.join(format!(".{LEDGER_FILE}.partial"));
        let _ = std::fs::remove_file(&partial);
        let mut text = Vec::new();
        for record in &self.tasks {
            serde_json::to_writer(&mut text, record)?;
            text.push(b'\n');
        }
        let written = private_options()
            .write(true)
            .create_new(true)
            .open(&partial)
            .and_then(|mut file| {
                file.write_all(&text)?;
                file.sync_all()
            });
        if let Err(error) = written.and_then(|()| std::fs::rename(&partial, &self.path)) {
            let _ = std::fs::remove_file(&partial);
            return Err(error);
        }
        // The rename is done; best effort to make it durable (not every folder accepts fsync).
        let _ = File::open(dir).and_then(|d| d.sync_all());
        self.file = None;
        self.file = Some(OpenOptions::new().append(true).open(&self.path)?);
        self.appended = 0;
        Ok(())
    }
    fn maybe_compact(&mut self, after: usize) {
        if self.appended >= after {
            // The appended file is still complete if this fails; it is retried after the next append.
            let _ = self.compact();
        }
    }
    fn position(&self, task_id: &str) -> Result<usize, LedgerError> {
        self.tasks
            .iter()
            .position(|record| record.task_id == task_id)
            .ok_or(LedgerError::UnknownTask)
    }
}

fn push_event(record: &mut Record, kind: EventType, detail: String, at_ms: u64) {
    record.events.push(Event {
        sequence: record.events.len() as u32,
        at_ms,
        kind,
        detail,
    });
    record.updated_ms = at_ms;
}
/// A tool or model event, within MAX_STEP_EVENTS for the task.
fn push_step_event(
    record: &mut Record,
    kind: EventType,
    detail: String,
    at_ms: u64,
) -> Result<(), LedgerError> {
    let steps = record
        .events
        .iter()
        .filter(|event| event.kind.state().is_none())
        .count();
    if steps >= MAX_STEP_EVENTS {
        return Err(LedgerError::Full);
    }
    push_event(record, kind, detail, at_ms);
    Ok(())
}

/// The ledger (see the module comment). Shared across threads behind one mutex.
pub struct TaskLedger {
    inner: Mutex<Inner>,
    clock: fn() -> u64,
    compact_after: usize,
}
impl TaskLedger {
    /// Opens (or creates) the ledger in `dir`, the app data folder.
    pub fn open(dir: &Path) -> Result<Self, LedgerError> {
        Self::open_with(dir, unix_ms, COMPACT_AFTER_LINES)
    }
    pub(crate) fn open_with(
        dir: &Path,
        clock: fn() -> u64,
        compact_after: usize,
    ) -> Result<Self, LedgerError> {
        let unavailable = |_: io::Error| LedgerError::Unavailable;
        private_dir(dir).map_err(unavailable)?;
        let lock = private_options()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(dir.join(LOCK_FILE))
            .map_err(unavailable)?;
        lock.try_lock().map_err(|_| LedgerError::Unavailable)?;
        let path = dir.join(LEDGER_FILE);
        let tasks = load(&path).map_err(unavailable)?;
        // record_ok keeps every order below MAX_ORDER, so this can't overflow.
        let next_order = tasks.last().map_or(0, |record| record.order + 1);
        let mut inner = Inner {
            path,
            file: None,
            _lock: lock,
            tasks,
            next_order,
            appended: 0,
        };
        inner.compact().map_err(unavailable)?;
        Ok(Self {
            inner: Mutex::new(inner),
            clock,
            compact_after: compact_after.max(1),
        })
    }
    fn lock(&self) -> MutexGuard<'_, Inner> {
        // A change edits a copy and commits it only after its line is on disk, so a panic elsewhere
        // never leaves memory half-changed.
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Records a new task as admitted. The skill must be a bundled procedure paired with `kind`
    /// (`pairing_ok`) and `skill_hash` the sha-256 of its bundled file, so the id is one of a few
    /// fixed words and is never name-scanned: a member named Read, Ready, Sunday, Help, Room or
    /// Night can't stop a procedure from running (review 2026-11-14 C4).
    pub fn admit(
        &self,
        task_id: &str,
        kind: &str,
        skill_id: &str,
        skill_hash: &str,
    ) -> Result<TaskRow, LedgerError> {
        let kind = TaskKind::parse(kind).ok_or(LedgerError::Invalid)?;
        let bundled = fixed::skill(skill_id).is_some_and(|skill| skill.hash == skill_hash);
        if !task_id_ok(task_id) || !skill_id_ok(skill_id) || !pairing_ok(kind, skill_id) || !bundled
        {
            return Err(LedgerError::Invalid);
        }
        let now = (self.clock)();
        let mut inner = self.lock();
        if inner.tasks.iter().any(|record| record.task_id == task_id) {
            return Err(LedgerError::Transition);
        }
        if inner.next_order >= MAX_ORDER {
            return Err(LedgerError::Unavailable);
        }
        let mut record = Record {
            v: RECORD_VERSION,
            order: inner.next_order,
            task_id: task_id.to_owned(),
            kind,
            skill_id: skill_id.to_owned(),
            skill_hash: skill_hash.to_owned(),
            state: RunState::Admitted,
            created_ms: now,
            updated_ms: now,
            failure: None,
            events: Vec::new(),
            minted: Vec::new(),
            replies: Vec::new(),
        };
        push_event(&mut record, EventType::Admitted, String::new(), now);
        if !record_ok(&record) {
            return Err(LedgerError::Invalid);
        }
        inner.append(&record)?;
        inner.next_order = record.order + 1;
        inner.tasks.push(record);
        let excess = inner.tasks.len().saturating_sub(KEEP_TASKS);
        inner.tasks.drain(..excess);
        let row = inner
            .tasks
            .last()
            .map(row)
            .ok_or(LedgerError::Unavailable)?;
        inner.maybe_compact(self.compact_after);
        Ok(row)
    }

    /// Moves a task along core/src/ledger.ts's graph. `failed` needs a FailureCode, `cancelled` takes
    /// none or `cancelled`, the others none; `interrupted` is the host's (`recover`) alone.
    pub fn transition(
        &self,
        task_id: &str,
        to: &str,
        code: Option<&str>,
    ) -> Result<TaskRow, LedgerError> {
        let to = RunState::parse(to).ok_or(LedgerError::Invalid)?;
        let code = code
            .map(|code| FailureCode::parse(code).ok_or(LedgerError::Invalid))
            .transpose()?;
        if !failure_ok(to, code) || code == Some(FailureCode::Interrupted) {
            return Err(LedgerError::Invalid);
        }
        self.change(task_id, |record, now| {
            if !record.state.next().contains(&to) {
                return Err(LedgerError::Transition);
            }
            record.state = to;
            record.failure = code;
            let detail = code.map_or_else(String::new, |code| code.as_str().to_owned());
            push_event(record, EventType::of(to), detail, now);
            Ok(())
        })
    }

    /// Adds a tool event (see `detail_ok`) to a task that is admitted or running. Model events are
    /// native code's alone (`reserve_step`, `finish_step`), so `model` is refused here.
    pub fn event(&self, task_id: &str, kind: &str, detail: &str) -> Result<TaskRow, LedgerError> {
        let kind = EventType::parse(kind)
            .filter(|kind| *kind == EventType::Tool)
            .ok_or(LedgerError::Invalid)?;
        if !detail_ok(kind, detail) {
            return Err(LedgerError::Invalid);
        }
        self.change(task_id, |record, now| {
            if record.state.terminal() {
                return Err(LedgerError::Transition);
            }
            push_step_event(record, kind, detail.to_owned(), now)
        })
    }

    /// The task as agent.rs sees it before a step: running, with no step in flight, or refused.
    pub fn step_view(&self, task_id: &str) -> Result<StepView, StepRefusal> {
        if !task_id_ok(task_id) {
            return Err(StepRefusal::Task);
        }
        let inner = self.lock();
        let record = &inner.tasks[inner.position(task_id)?];
        let (steps, open) = model_steps(&record.events).ok_or(StepRefusal::Task)?;
        // A running task holds a reply hash for every finished step (only records from before
        // replies were hashed lack them, and those were all ended by `recover`).
        if record.state != RunState::Running || open || record.replies.len() != record.minted.len()
        {
            return Err(StepRefusal::Task);
        }
        if steps >= MAX_STEPS {
            return Err(StepRefusal::Limit);
        }
        Ok(StepView {
            kind: record.kind,
            skill_id: record.skill_id.clone(),
            steps,
            minted: record.minted.clone(),
            replies: record.replies.clone(),
        })
    }

    /// Takes the task's next model step, durably, immediately before its request is sent: appends
    /// `<n>` and returns n. Refused unless the task is running with no step in flight and fewer
    /// than MAX_STEPS taken.
    pub fn reserve_step(&self, task_id: &str) -> Result<u8, StepRefusal> {
        let mut step = 0;
        self.change(task_id, |record, now| {
            let (taken, open) = model_steps(&record.events).ok_or(LedgerError::Invalid)?;
            if record.state != RunState::Running || open {
                return Err(LedgerError::Transition);
            }
            if taken >= MAX_STEPS {
                return Err(LedgerError::Full);
            }
            step = taken + 1;
            push_step_event(record, EventType::Model, step.to_string(), now)
        })?;
        Ok(step)
    }

    /// Closes step `step` with its outcome (`stop`, `tool_calls`, `length` or a FailureCode), the
    /// number of tool calls its reply minted and the reply's hash (`agent::reply_hash`; empty when
    /// the step returned no reply). Refused unless that step is the one in flight on a running task
    /// and the task's minted calls stay within MAX_TOOL_CALLS.
    pub fn finish_step(
        &self,
        task_id: &str,
        step: u8,
        outcome: &str,
        minted: u8,
        reply: &str,
    ) -> Result<(), StepRefusal> {
        let detail = format!("{step} {outcome}");
        if !detail_ok(EventType::Model, &detail) || !reply_hash_ok(reply) {
            return Err(StepRefusal::Task);
        }
        self.change(task_id, |record, now| {
            let (taken, open) = model_steps(&record.events).ok_or(LedgerError::Invalid)?;
            if record.state != RunState::Running || !open || taken != step {
                return Err(LedgerError::Transition);
            }
            let total: usize = record.minted.iter().map(|&n| usize::from(n)).sum();
            if total + usize::from(minted) > MAX_TOOL_CALLS {
                return Err(LedgerError::Full);
            }
            if record.replies.len() != record.minted.len() {
                return Err(LedgerError::Invalid);
            }
            record.minted.push(minted);
            record.replies.push(reply.to_owned());
            push_step_event(record, EventType::Model, detail, now)
        })?;
        Ok(())
    }

    fn change(
        &self,
        task_id: &str,
        edit: impl FnOnce(&mut Record, u64) -> Result<(), LedgerError>,
    ) -> Result<TaskRow, LedgerError> {
        if !task_id_ok(task_id) {
            return Err(LedgerError::Invalid);
        }
        let now = (self.clock)();
        let mut inner = self.lock();
        let at = inner.position(task_id)?;
        let mut record = inner.tasks[at].clone();
        let at_ms = now.max(record.updated_ms);
        edit(&mut record, at_ms)?;
        if !record_ok(&record) {
            return Err(LedgerError::Invalid);
        }
        inner.append(&record)?;
        inner.tasks[at] = record;
        let row = row(&inner.tasks[at]);
        inner.maybe_compact(self.compact_after);
        Ok(row)
    }

    /// At app start, before anything can run: every task still admitted or running belonged to an
    /// earlier launch and is failed `interrupted`. Returns how many.
    pub fn recover(&self) -> Result<usize, LedgerError> {
        let now = (self.clock)();
        let mut inner = self.lock();
        let mut count = 0;
        for at in 0..inner.tasks.len() {
            if !matches!(
                inner.tasks[at].state,
                RunState::Admitted | RunState::Running
            ) {
                continue;
            }
            let mut record = inner.tasks[at].clone();
            let at_ms = now.max(record.updated_ms);
            record.state = RunState::Failed;
            record.failure = Some(FailureCode::Interrupted);
            push_event(
                &mut record,
                EventType::Failed,
                FailureCode::Interrupted.as_str().to_owned(),
                at_ms,
            );
            if !record_ok(&record) {
                return Err(LedgerError::Invalid);
            }
            inner.append(&record)?;
            inner.tasks[at] = record;
            count += 1;
        }
        inner.maybe_compact(self.compact_after);
        Ok(count)
    }

    /// Up to `limit` tasks, newest first.
    pub fn list(&self, limit: usize) -> Vec<TaskRow> {
        self.lock()
            .tasks
            .iter()
            .rev()
            .take(limit)
            .map(row)
            .collect()
    }
}

#[cfg(test)]
#[path = "ledger_tests.rs"]
mod tests;
