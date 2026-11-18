//! The task ledger over a temporary folder and a fake clock. Fictional names only.
use super::*;
use std::{
    collections::BTreeMap,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

static CLOCK: AtomicU64 = AtomicU64::new(1_795_000_000_000);
fn clock() -> u64 {
    CLOCK.fetch_add(1_000, Ordering::SeqCst)
}

struct TempDir(PathBuf);
impl TempDir {
    fn new(label: &str) -> Self {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "ozzie-ledger-{label}-{}-{nanos}",
            std::process::id()
        ));
        Self(path)
    }
    fn file(&self) -> PathBuf {
        self.0.join(LEDGER_FILE)
    }
    fn lines(&self) -> Vec<String> {
        std::fs::read_to_string(self.file())
            .unwrap()
            .lines()
            .map(str::to_owned)
            .collect()
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn open(dir: &TempDir) -> TaskLedger {
    TaskLedger::open_with(&dir.0, clock, COMPACT_AFTER_LINES).unwrap()
}
fn task(n: usize) -> String {
    format!("00000000-0000-4000-8000-{n:012x}")
}
/// A step's reply hash, as agent.rs records it (`agent::reply_hash`).
const REPLY: &str = "5a5f2a9cb1d8e7f60312a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9";
/// The sha-256 of a bundled procedure's file.
fn hash(skill: &str) -> String {
    fixed::skill(skill).unwrap().hash.clone()
}
fn admit(ledger: &TaskLedger, n: usize) -> TaskRow {
    ledger
        .admit(&task(n), "ask", ASK_SKILL, &hash(ASK_SKILL))
        .unwrap()
}
fn states(row: &TaskRow) -> Vec<(EventType, String)> {
    row.events
        .iter()
        .map(|e| (e.kind, e.detail.clone()))
        .collect()
}

// ---- Parity with the TypeScript ledger and the frozen contract -----------------------------

fn core_file(path: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join(path);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|_| panic!("{} beside this crate", path.display()))
}
fn between<'a>(text: &'a str, start: &str, end: &str) -> &'a str {
    let from = text.find(start).unwrap_or_else(|| panic!("{start}")) + start.len();
    let rest = &text[from..];
    &rest[..rest.find(end).unwrap_or_else(|| panic!("{end}"))]
}
fn quoted(text: &str) -> Vec<String> {
    text.split('"')
        .skip(1)
        .step_by(2)
        .map(str::to_owned)
        .collect()
}

#[test]
fn states_transitions_codes_and_event_types_match_the_typescript_ledger_and_contract() {
    let ledger_ts = core_file("src/ledger.ts");
    let states = quoted(between(&ledger_ts, "export type RunState =", ";"));
    assert_eq!(states, RunState::ALL.map(|s| s.as_str().to_owned()));
    for line in between(
        &ledger_ts,
        "const NEXT: Record<RunState, RunState[]> = {",
        "};",
    )
    .lines()
    .map(str::trim)
    .filter(|line| !line.is_empty())
    {
        let (from, to) = line.split_once(':').unwrap();
        let from = RunState::parse(from).unwrap();
        let next: Vec<&str> = from.next().iter().map(|s| s.as_str()).collect();
        assert_eq!(quoted(to), next, "{line}");
    }
    let broker = core_file("src/broker.ts");
    let contract = core_file("src/harness/contract.ts");
    let tool_errors = quoted(between(&broker, "export type ToolError =", ";"));
    let mut codes = tool_errors.clone();
    let failure = between(&contract, "export type FailureCode =", ";");
    assert!(failure.trim_start().starts_with("ToolError |"));
    codes.extend(quoted(failure));
    assert_eq!(codes, FailureCode::ALL.map(|c| c.as_str().to_owned()));
    assert_eq!(
        quoted(between(&broker, "export type Completeness =", ";")),
        COMPLETENESS.map(str::to_owned)
    );
    let event = between(&contract, "export interface TaskEvent {", "}");
    assert_eq!(
        quoted(between(event, "type:", ";")),
        EventType::ALL.map(|t| t.as_str().to_owned())
    );
}

// ---- Lifecycle ------------------------------------------------------------------------------

#[test]
fn a_task_moves_admitted_running_verified_with_its_events_and_times() {
    let dir = TempDir::new("lifecycle");
    let ledger = open(&dir);
    let row = admit(&ledger, 1);
    assert_eq!(
        (row.state, row.kind, row.failure),
        (RunState::Admitted, TaskKind::Ask, None)
    );
    assert_eq!(row.created_at, row.updated_at);
    assert!(row.created_at.ends_with('Z') && row.created_at.len() == 24);
    ledger.transition(&task(1), "running", None).unwrap();
    assert_eq!(ledger.reserve_step(&task(1)), Ok(1));
    ledger
        .finish_step(&task(1), 1, "tool_calls", 1, REPLY)
        .unwrap();
    ledger
        .event(&task(1), "tool", "sunday.open_needs complete")
        .unwrap();
    assert_eq!(ledger.reserve_step(&task(1)), Ok(2));
    ledger.finish_step(&task(1), 2, "stop", 0, REPLY).unwrap();
    let row = ledger.transition(&task(1), "verified", None).unwrap();
    assert_eq!(row.state, RunState::Verified);
    assert_eq!(
        states(&row),
        [
            (EventType::Admitted, String::new()),
            (EventType::Running, String::new()),
            (EventType::Model, "1".into()),
            (EventType::Model, "1 tool_calls".into()),
            (EventType::Tool, "sunday.open_needs complete".into()),
            (EventType::Model, "2".into()),
            (EventType::Model, "2 stop".into()),
            (EventType::Verified, String::new()),
        ]
    );
    assert!(
        row.events
            .iter()
            .enumerate()
            .all(|(i, e)| e.sequence as usize == i && e.task_id == task(1))
    );
    assert!(row.updated_at > row.created_at);
    // The row is the contract's TaskEvent shape over IPC.
    let json = serde_json::to_value(&row).unwrap();
    assert_eq!(
        json["events"][4],
        serde_json::json!({"task_id": task(1), "sequence": 4, "at": row.events[4].at, "type": "tool", "detail": "sunday.open_needs complete"})
    );
    assert_eq!(json["state"], "verified");
    assert_eq!(json["failure"], serde_json::Value::Null);
    // Failed and cancelled carry their codes.
    admit(&ledger, 2);
    ledger.transition(&task(2), "running", None).unwrap();
    let failed = ledger
        .transition(&task(2), "failed", Some("fidelity"))
        .unwrap();
    assert_eq!(failed.failure, Some(FailureCode::Fidelity));
    assert_eq!(failed.events.last().unwrap().detail, "fidelity");
    assert_eq!(
        serde_json::to_value(&failed).unwrap()["failure"],
        "fidelity"
    );
    admit(&ledger, 3);
    let cancelled = ledger
        .transition(&task(3), "cancelled", Some("cancelled"))
        .unwrap();
    assert_eq!(cancelled.failure, Some(FailureCode::Cancelled));
    admit(&ledger, 4);
    assert_eq!(
        ledger
            .transition(&task(4), "cancelled", None)
            .unwrap()
            .failure,
        None
    );
    // Newest first.
    let listed: Vec<String> = ledger.list(10).into_iter().map(|r| r.task_id).collect();
    assert_eq!(listed, [task(4), task(3), task(2), task(1)]);
    assert_eq!(ledger.list(2).len(), 2);
}

#[test]
fn only_the_typescript_graph_is_allowed_and_terminal_is_terminal() {
    let dir = TempDir::new("graph");
    let ledger = open(&dir);
    admit(&ledger, 1);
    for (to, code) in [
        ("verified", None),
        ("failed", Some("timeout")),
        ("admitted", None),
    ] {
        assert_eq!(
            ledger.transition(&task(1), to, code).err(),
            Some(LedgerError::Transition),
            "{to}"
        );
    }
    ledger.transition(&task(1), "running", None).unwrap();
    assert_eq!(
        ledger.transition(&task(1), "running", None).err(),
        Some(LedgerError::Transition)
    );
    assert_eq!(
        ledger.transition(&task(1), "admitted", None).err(),
        Some(LedgerError::Transition)
    );
    ledger.transition(&task(1), "cancelled", None).unwrap();
    // Late results can't revive a cancelled run, and nothing follows a terminal state.
    for (to, code) in [
        ("verified", None),
        ("failed", Some("timeout")),
        ("running", None),
        ("cancelled", None),
    ] {
        assert_eq!(
            ledger.transition(&task(1), to, code).err(),
            Some(LedgerError::Transition),
            "{to}"
        );
    }
    assert_eq!(
        ledger.event(&task(1), "tool", "denied").err(),
        Some(LedgerError::Transition)
    );
    assert_eq!(ledger.reserve_step(&task(1)), Err(StepRefusal::Task));
    admit(&ledger, 2);
    ledger.transition(&task(2), "running", None).unwrap();
    ledger.transition(&task(2), "verified", None).unwrap();
    assert_eq!(
        ledger
            .transition(&task(2), "failed", Some("fidelity"))
            .err(),
        Some(LedgerError::Transition)
    );
    // Admitting twice, unknown tasks, and states outside the vocabulary.
    assert_eq!(
        ledger
            .admit(&task(2), "ask", ASK_SKILL, &hash(ASK_SKILL))
            .err(),
        Some(LedgerError::Transition)
    );
    assert_eq!(
        ledger.transition(&task(9), "running", None).err(),
        Some(LedgerError::UnknownTask)
    );
    assert_eq!(
        ledger.event(&task(9), "tool", "denied").err(),
        Some(LedgerError::UnknownTask)
    );
    assert_eq!(ledger.reserve_step(&task(9)), Err(StepRefusal::Task));
    admit(&ledger, 3);
    for to in ["proposed", "done", "RUNNING", ""] {
        assert_eq!(
            ledger.transition(&task(3), to, None).err(),
            Some(if to == "proposed" {
                LedgerError::Transition
            } else {
                LedgerError::Invalid
            }),
            "{to}"
        );
    }
}

#[test]
fn failure_codes_follow_the_contract_and_interrupted_is_the_hosts_alone() {
    let dir = TempDir::new("codes");
    let ledger = open(&dir);
    admit(&ledger, 1);
    ledger.transition(&task(1), "running", None).unwrap();
    for (to, code) in [
        ("failed", None),
        ("failed", Some("oops")),
        ("failed", Some("Egress")),
        ("failed", Some("interrupted")),
        ("verified", Some("egress")),
        ("cancelled", Some("timeout")),
        ("running", Some("limit")),
    ] {
        assert_eq!(
            ledger.transition(&task(1), to, code).err(),
            Some(LedgerError::Invalid),
            "{to} {code:?}"
        );
    }
    for code in FailureCode::ALL
        .iter()
        .filter(|c| **c != FailureCode::Interrupted)
    {
        let n = 100 + *code as usize;
        admit(&ledger, n);
        ledger.transition(&task(n), "running", None).unwrap();
        let row = ledger
            .transition(&task(n), "failed", Some(code.as_str()))
            .unwrap();
        assert_eq!(row.failure, Some(*code));
    }
}

#[test]
fn recover_fails_tasks_an_earlier_launch_left_running() {
    let dir = TempDir::new("recover");
    {
        let ledger = open(&dir);
        admit(&ledger, 1);
        admit(&ledger, 2);
        ledger.transition(&task(2), "running", None).unwrap();
        ledger
            .event(&task(2), "tool", "rooms.conflicts partial")
            .unwrap();
        admit(&ledger, 3);
        ledger.transition(&task(3), "running", None).unwrap();
        ledger.transition(&task(3), "verified", None).unwrap();
        admit(&ledger, 4);
        ledger.transition(&task(4), "cancelled", None).unwrap();
    }
    let ledger = open(&dir);
    assert_eq!(ledger.recover(), Ok(2));
    let rows: BTreeMap<String, TaskRow> = ledger
        .list(10)
        .into_iter()
        .map(|r| (r.task_id.clone(), r))
        .collect();
    for n in [1, 2] {
        let row = &rows[&task(n)];
        assert_eq!(
            (row.state, row.failure),
            (RunState::Failed, Some(FailureCode::Interrupted))
        );
        assert_eq!(
            states(row).last().unwrap(),
            &(EventType::Failed, "interrupted".into())
        );
    }
    assert_eq!(rows[&task(3)].state, RunState::Verified);
    assert_eq!(rows[&task(4)].state, RunState::Cancelled);
    assert_eq!(ledger.recover(), Ok(0));
    drop(ledger);
    // Recovery is on disk.
    let ledger = open(&dir);
    assert_eq!(
        ledger
            .list(10)
            .iter()
            .filter(|r| r.failure == Some(FailureCode::Interrupted))
            .count(),
        2
    );
}

// ---- The watchdog while the app runs --------------------------------------------------------

/// Each watchdog test's own wall clock: it moves only when that test moves it.
static SWEEP_NOW: AtomicU64 = AtomicU64::new(1_795_000_000_000);
fn sweep_clock() -> u64 {
    SWEEP_NOW.load(Ordering::SeqCst)
}
static JUMP_NOW: AtomicU64 = AtomicU64::new(1_795_000_000_000);
fn jump_clock() -> u64 {
    JUMP_NOW.load(Ordering::SeqCst)
}
static BAD_NOW: AtomicU64 = AtomicU64::new(1_795_000_000_000);
fn bad_clock() -> u64 {
    BAD_NOW.load(Ordering::SeqCst)
}
/// A watchdog whose awake time (monotonic, not counting sleep) the test moves.
fn watchdog() -> (Arc<AtomicU64>, Watchdog) {
    let awake = Arc::new(AtomicU64::new(0));
    let read = awake.clone();
    (
        awake,
        Watchdog::with_clock(move || read.load(Ordering::SeqCst)),
    )
}
fn rows_by_id(ledger: &TaskLedger) -> BTreeMap<String, TaskRow> {
    ledger
        .list(usize::MAX)
        .into_iter()
        .map(|r| (r.task_id.clone(), r))
        .collect()
}

#[test]
fn the_watchdog_ends_only_tasks_past_their_ceiling_once_and_refuses_their_late_work() {
    let dir = TempDir::new("sweep");
    let start = SWEEP_NOW.load(Ordering::SeqCst);
    let (awake, mut watchdog) = watchdog();
    // The Mac stays awake: wall-clock and awake time move together.
    let at = |ms: u64| {
        SWEEP_NOW.store(start + ms, Ordering::SeqCst);
        awake.store(ms, Ordering::SeqCst);
    };
    let ledger = TaskLedger::open_with(&dir.0, sweep_clock, COMPACT_AFTER_LINES).unwrap();
    // A question left admitted, and one left running with a model step in flight (its page reloaded).
    admit(&ledger, 1);
    admit(&ledger, 2);
    ledger.transition(&task(2), "running", None).unwrap();
    assert_eq!(ledger.reserve_step(&task(2)), Ok(1));
    // Tasks that finished: verified, cancelled, failed.
    admit(&ledger, 3);
    ledger.transition(&task(3), "running", None).unwrap();
    ledger.transition(&task(3), "verified", None).unwrap();
    admit(&ledger, 4);
    ledger.transition(&task(4), "cancelled", None).unwrap();
    admit(&ledger, 5);
    ledger.transition(&task(5), "running", None).unwrap();
    ledger
        .transition(&task(5), "failed", Some("timeout"))
        .unwrap();
    // Every wake, the watchdog notes what is unfinished.
    assert_eq!(watchdog.sweep(&ledger), Some(0));
    // A procedure admitted five minutes later, still running.
    at(5 * 60_000);
    admit(&ledger, 6);
    ledger.transition(&task(6), "running", None).unwrap();
    ledger
        .event(&task(6), "tool", "rooms.conflicts complete")
        .unwrap();
    assert_eq!(watchdog.sweep(&ledger), Some(0));
    let before = rows_by_id(&ledger);
    // A wall clock set back before admission, and exactly the ceiling: nothing has run longer.
    at(STALE_AFTER_MS + 1);
    SWEEP_NOW.store(start - 3_600_000, Ordering::SeqCst);
    assert_eq!(watchdog.sweep(&ledger), Some(0));
    at(STALE_AFTER_MS);
    assert_eq!(watchdog.sweep(&ledger), Some(0));
    assert_eq!(rows_by_id(&ledger), before);
    // Past it: the two left behind are failed `interrupted`, as recovery at start would.
    at(STALE_AFTER_MS + 1);
    assert_eq!(watchdog.sweep(&ledger), Some(2));
    let after = rows_by_id(&ledger);
    for n in [1, 2] {
        let row = &after[&task(n)];
        assert_eq!(
            (row.state, row.failure),
            (RunState::Failed, Some(FailureCode::Interrupted))
        );
        assert_eq!(
            states(row).last().unwrap(),
            &(EventType::Failed, "interrupted".into())
        );
        assert_eq!(row.updated_at, rfc3339(start + STALE_AFTER_MS + 1));
    }
    // Terminal tasks and the one still inside its ceiling are untouched.
    for n in [3, 4, 5, 6] {
        assert_eq!(after[&task(n)], before[&task(n)], "task {n}");
    }
    // Idempotent, and finished tasks are no longer watched.
    assert_eq!(watchdog.sweep(&ledger), Some(0));
    assert_eq!(rows_by_id(&ledger), after);
    assert_eq!(watchdog.seen.keys().collect::<Vec<_>>(), [&task(6)]);
    // Late work from the worker that lost them is refused, as for any terminal task.
    assert_eq!(
        ledger.finish_step(&task(2), 1, "stop", 0, REPLY),
        Err(StepRefusal::Task)
    );
    assert_eq!(ledger.reserve_step(&task(2)), Err(StepRefusal::Task));
    for (n, to, code) in [
        (2, "verified", None),
        (2, "failed", Some("timeout")),
        (2, "cancelled", None),
        (1, "running", None),
    ] {
        assert_eq!(
            ledger.transition(&task(n), to, code).err(),
            Some(LedgerError::Transition),
            "{n} {to}"
        );
    }
    assert_eq!(
        ledger.event(&task(2), "tool", "denied").err(),
        Some(LedgerError::Transition)
    );
    assert_eq!(rows_by_id(&ledger), after);
    // The later task's own ceiling, measured from its own admission and first sighting.
    at(5 * 60_000 + STALE_AFTER_MS);
    assert_eq!(watchdog.sweep(&ledger), Some(0));
    at(5 * 60_000 + STALE_AFTER_MS + 1);
    assert_eq!(watchdog.sweep(&ledger), Some(1));
    assert_eq!(
        ledger.list(1)[0].failure,
        Some(FailureCode::Interrupted),
        "task 6"
    );
    assert_eq!(watchdog.sweep(&ledger), Some(0));
    assert!(watchdog.seen.is_empty());
    // On disk: read back the same, and recovery at the next start has nothing left to end.
    let swept = rows_by_id(&ledger);
    drop(ledger);
    let ledger = TaskLedger::open_with(&dir.0, sweep_clock, COMPACT_AFTER_LINES).unwrap();
    assert_eq!(ledger.recover(), Ok(0));
    assert_eq!(rows_by_id(&ledger), swept);
}

#[test]
fn a_clock_jump_or_a_long_sleep_never_ends_a_task_the_watchdog_has_not_seen_stuck_while_awake() {
    let dir = TempDir::new("sweep-awake");
    let start = JUMP_NOW.load(Ordering::SeqCst);
    let (awake, mut watchdog) = watchdog();
    let ledger = TaskLedger::open_with(&dir.0, jump_clock, COMPACT_AFTER_LINES).unwrap();
    admit(&ledger, 1);
    ledger.transition(&task(1), "running", None).unwrap();
    assert_eq!(watchdog.sweep(&ledger), Some(0));
    // The wall clock jumps two ceilings forward (set by hand, or corrected) within a minute.
    JUMP_NOW.store(start + 2 * STALE_AFTER_MS, Ordering::SeqCst);
    awake.store(60_000, Ordering::SeqCst);
    assert_eq!(watchdog.sweep(&ledger), Some(0));
    // The Mac sleeps three hours with the task in flight: thirty seconds more of awake time.
    JUMP_NOW.store(start + 3 * 3_600_000, Ordering::SeqCst);
    awake.store(90_000, Ordering::SeqCst);
    assert_eq!(watchdog.sweep(&ledger), Some(0));
    assert_eq!(ledger.list(1)[0].state, RunState::Running);
    // Seen unfinished for the whole ceiling of awake time: ended, once.
    awake.store(STALE_AFTER_MS - 1, Ordering::SeqCst);
    assert_eq!(watchdog.sweep(&ledger), Some(0));
    awake.store(STALE_AFTER_MS, Ordering::SeqCst);
    assert_eq!(watchdog.sweep(&ledger), Some(1));
    assert_eq!(watchdog.sweep(&ledger), Some(0));
    let row = &ledger.list(1)[0];
    assert_eq!(
        (row.state, row.failure),
        (RunState::Failed, Some(FailureCode::Interrupted))
    );
}

#[test]
fn the_watchdog_skips_a_wake_while_the_ledger_is_busy_rather_than_waiting() {
    let dir = TempDir::new("sweep-busy");
    let ledger = open(&dir);
    admit(&ledger, 1);
    let (_awake, mut watchdog) = watchdog();
    let held = ledger.lock();
    std::thread::scope(|scope| {
        let (sent, swept) = std::sync::mpsc::channel();
        let (watchdog, ledger) = (&mut watchdog, &ledger);
        scope.spawn(move || sent.send(watchdog.sweep(ledger)).unwrap());
        assert_eq!(
            swept.recv_timeout(std::time::Duration::from_secs(5)),
            Ok(None),
            "skipped at once, not waited for"
        );
        drop(held);
    });
    assert!(watchdog.seen.is_empty());
    assert_eq!(watchdog.sweep(&ledger), Some(0));
    assert_eq!(watchdog.seen.len(), 1);
}

#[test]
fn one_task_that_cannot_be_ended_never_keeps_the_rest_from_being_ended() {
    let dir = TempDir::new("sweep-bad");
    let start = BAD_NOW.load(Ordering::SeqCst);
    let ledger = TaskLedger::open_with(&dir.0, bad_clock, COMPACT_AFTER_LINES).unwrap();
    for n in 1..=3 {
        admit(&ledger, n);
    }
    // Task 1 as a future bug might leave it in memory: no change to it passes `record_ok`.
    ledger.lock().tasks[0].skill_id = "not-bundled".into();
    // Recovery at start ends the others and reports the one it couldn't.
    assert_eq!(ledger.recover(), Err(LedgerError::Invalid));
    let rows = rows_by_id(&ledger);
    assert_eq!(rows[&task(1)].state, RunState::Admitted);
    for n in [2, 3] {
        assert_eq!(rows[&task(n)].failure, Some(FailureCode::Interrupted));
    }
    // And the watchdog, on every wake.
    admit(&ledger, 4);
    let (awake, mut watchdog) = watchdog();
    assert_eq!(watchdog.sweep(&ledger), Some(0));
    BAD_NOW.store(start + STALE_AFTER_MS + 1, Ordering::SeqCst);
    awake.store(STALE_AFTER_MS, Ordering::SeqCst);
    assert_eq!(watchdog.sweep(&ledger), Some(1));
    assert_eq!(
        rows_by_id(&ledger)[&task(4)].failure,
        Some(FailureCode::Interrupted)
    );
    assert_eq!(watchdog.sweep(&ledger), Some(0));
}

#[test]
fn the_watchdog_ceiling_is_safely_above_every_limit_a_worker_holds_a_task_to() {
    // A question or procedure's whole run (core/src/harness/contract.ts HARNESS_LIMITS.runMs).
    let contract = core_file("src/harness/contract.ts");
    let run_ms: u64 = between(&contract, "runMs:", ",")
        .trim()
        .replace('_', "")
        .parse()
        .unwrap();
    // A responsibility run, and the automatic Sunday check's whole budget.
    for limit in [
        run_ms,
        crate::responsibilities::RUN_TIMEOUT_MS,
        crate::sunday_check::BUDGET_MS,
    ] {
        assert!(STALE_AFTER_MS >= 2 * limit, "{limit} ms");
    }
}

// ---- Name-free ------------------------------------------------------------------------------

#[test]
fn only_name_free_fields_and_details_are_stored() {
    let dir = TempDir::new("name-free");
    let ledger = open(&dir);
    let (ask, help, ready) = (hash(ASK_SKILL), hash("who-could-help"), hash(CHECK_SKILL));
    for (task_id, kind, skill, hash) in [
        ("task-1", "ask", ASK_SKILL, ask.as_str()),
        (
            "00000000-0000-4000-8000-00000000000A",
            "ask",
            ASK_SKILL,
            &ask,
        ),
        (task(1).as_str(), "question", ASK_SKILL, &ask),
        (task(1).as_str(), "ask", "Who could help?", &ask),
        (task(1).as_str(), "ask", "who could help", &ask),
        (task(1).as_str(), "skill", "is-riley-free", &ask),
        (
            task(1).as_str(),
            "skill",
            "smith-family-is-in-the-hospital",
            &ask,
        ),
        (task(1).as_str(), "skill", "call-555-123-4567", &ask),
        (task(1).as_str(), "skill", "thornbury", &ask),
        (task(1).as_str(), "skill", &"a".repeat(49), &ask),
        (task(1).as_str(), "skill", "", &ask),
        // Only bundled procedures, under the hash of their own file.
        (task(1).as_str(), "skill", "sunday-check", &ready),
        (task(1).as_str(), "skill", "who-could-help", "abc123"),
        (task(1).as_str(), "skill", "who-could-help", &ask),
        (
            task(1).as_str(),
            "skill",
            "who-could-help",
            &help.to_uppercase(),
        ),
        (task(1).as_str(), "skill", "who-could-help", &"0".repeat(64)),
        // Kind and procedure go together.
        (task(1).as_str(), "ask", "who-could-help", &help),
        (task(1).as_str(), "skill", ASK_SKILL, &ask),
        (task(1).as_str(), "check", ASK_SKILL, &ask),
        (task(1).as_str(), "check", "who-could-help", &help),
    ] {
        assert_eq!(
            ledger.admit(task_id, kind, skill, hash).err(),
            Some(LedgerError::Invalid),
            "{kind} {skill} {hash}"
        );
    }
    // Every pairing the contract allows.
    for (n, kind, skill) in [
        (2, "ask", ASK_SKILL),
        (3, "skill", "who-could-help"),
        (4, "skill", CHECK_SKILL),
        (5, "skill", "room-check"),
        (6, "skill", "follow-up-owners"),
        (7, "skill", "group-night"),
    ] {
        ledger.admit(&task(n), kind, skill, &hash(skill)).unwrap();
    }
    ledger
        .admit(&task(1), "check", CHECK_SKILL, &ready)
        .unwrap();
    ledger.transition(&task(1), "running", None).unwrap();
    for (kind, detail) in [
        ("tool", "Is Riley free?"),
        ("tool", "riley"),
        ("tool", "sunday.open_needs Riley"),
        ("tool", "sunday.open_needs riley"),
        ("tool", "shell.run complete"),
        ("tool", "sunday.open_needs"),
        ("tool", "sunday.open_needs complete extra"),
        ("tool", "[Person 1] complete"),
        ("model", "1 Riley"),
        ("model", "one"),
        ("model", "0"),
        ("model", "01"),
        ("model", "100"),
        ("model", "2 the answer was fine"),
        ("verified", ""),
        ("failed", "egress"),
        ("admitted", ""),
        ("note", "anything"),
        ("tool", &"a".repeat(65)),
        ("tool", "denied\u{200b}"),
    ] {
        assert_eq!(
            ledger.event(&task(1), kind, detail).err(),
            Some(LedgerError::Invalid),
            "{kind} {detail:?}"
        );
    }
    for detail in [
        "denied",
        "timeout",
        "planning_center.refresh stale",
        "drafts.prepare_note provider-failure",
    ] {
        assert!(ledger.event(&task(1), "tool", detail).is_ok(), "{detail}");
    }
    // Model events are native code's alone: the grammar holds them, the webview can't add them.
    for detail in ["6", "3 tool_calls", "4 egress", "5 length"] {
        assert!(detail_ok(EventType::Model, detail), "{detail}");
        assert_eq!(
            ledger.event(&task(1), "model", detail).err(),
            Some(LedgerError::Invalid),
            "{detail}"
        );
    }
    // The file holds only what the rows show: no field for a question, an answer or source text.
    let text = std::fs::read_to_string(dir.file()).unwrap();
    assert!(!text.to_lowercase().contains("riley") && !text.contains('?'));
    let record: serde_json::Value = serde_json::from_str(dir.lines().last().unwrap()).unwrap();
    let mut keys: Vec<&str> = record
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "created_ms",
            "events",
            "failure",
            "kind",
            "minted",
            "order",
            "skill_hash",
            "skill_id",
            "state",
            "task_id",
            "updated_ms",
            "v"
        ]
    );
}

#[test]
fn a_task_holds_a_bounded_number_of_events_and_can_still_finish() {
    let dir = TempDir::new("events");
    let ledger = open(&dir);
    admit(&ledger, 1);
    ledger.transition(&task(1), "running", None).unwrap();
    for _ in 0..MAX_STEP_EVENTS {
        ledger
            .event(&task(1), "tool", "today.attention complete")
            .unwrap();
    }
    assert_eq!(
        ledger.event(&task(1), "tool", "denied").err(),
        Some(LedgerError::Full)
    );
    assert_eq!(ledger.reserve_step(&task(1)), Err(StepRefusal::Limit));
    let row = ledger
        .transition(&task(1), "failed", Some("limit"))
        .unwrap();
    assert_eq!(row.events.len(), MAX_EVENTS);
    drop(ledger);
    assert_eq!(open(&dir).list(1)[0].events.len(), MAX_EVENTS);
}

// ---- Storage --------------------------------------------------------------------------------

#[test]
fn the_ledger_survives_reopening_and_drops_torn_or_invalid_lines() {
    let dir = TempDir::new("reopen");
    let before = {
        let ledger = open(&dir);
        admit(&ledger, 1);
        ledger.transition(&task(1), "running", None).unwrap();
        admit(&ledger, 2);
        ledger.list(10)
    };
    // A crash mid-append, garbage, a record holding a name, a terminal task regressed, and a snapshot
    // that rewrites history: all dropped when the ledger is read back.
    let good: serde_json::Value = serde_json::from_str(&dir.lines()[0]).unwrap();
    let mut named = good.clone();
    named["task_id"] = serde_json::json!(task(3));
    named["order"] = serde_json::json!(7);
    named["events"][0]["detail"] = serde_json::json!("riley thornbury");
    let mut questioned = named.clone();
    questioned["events"][0]["detail"] = serde_json::json!("");
    questioned["question"] = serde_json::json!("Is Riley free?");
    let mut rewritten = good.clone();
    rewritten["skill_id"] = serde_json::json!("other-skill");
    {
        let mut file = OpenOptions::new().append(true).open(dir.file()).unwrap();
        for line in [
            named.to_string(),
            questioned.to_string(),
            rewritten.to_string(),
            "not json".into(),
        ] {
            writeln!(file, "{line}").unwrap();
        }
        write!(file, "{{\"v\":1,\"order\":9,\"task_id\":\"{}", task(4)).unwrap();
    }
    let ledger = open(&dir);
    assert_eq!(ledger.list(10), before);
    // Reopening compacted the file: one line per task, and appends after a torn line are safe.
    assert_eq!(dir.lines().len(), 2);
    admit(&ledger, 5);
    drop(ledger);
    assert_eq!(open(&dir).list(10).len(), 3);
}

#[test]
fn a_terminal_snapshot_is_never_replaced_when_read_back() {
    let dir = TempDir::new("terminal-replay");
    {
        let ledger = open(&dir);
        admit(&ledger, 1);
        ledger.transition(&task(1), "running", None).unwrap();
    }
    let running = dir.lines().last().unwrap().clone();
    {
        let ledger = open(&dir);
        ledger.transition(&task(1), "cancelled", None).unwrap();
    }
    // Append the older running snapshot after the cancelled one, as a stale writer might.
    let mut file = OpenOptions::new().append(true).open(dir.file()).unwrap();
    writeln!(file, "{running}").unwrap();
    drop(file);
    let ledger = open(&dir);
    assert_eq!(ledger.list(1)[0].state, RunState::Cancelled);
    assert_eq!(ledger.recover(), Ok(0));
}

#[test]
fn only_the_newest_five_hundred_tasks_are_kept() {
    let dir = TempDir::new("retention");
    let ledger = TaskLedger::open_with(&dir.0, clock, 100).unwrap();
    for n in 0..KEEP_TASKS + 5 {
        admit(&ledger, n);
    }
    let rows = ledger.list(usize::MAX);
    assert_eq!(rows.len(), KEEP_TASKS);
    assert_eq!(rows.first().unwrap().task_id, task(KEEP_TASKS + 4));
    assert_eq!(rows.last().unwrap().task_id, task(5));
    assert_eq!(
        ledger.transition(&task(0), "running", None).err(),
        Some(LedgerError::UnknownTask)
    );
    drop(ledger);
    let ledger = open(&dir);
    assert_eq!(ledger.list(usize::MAX), rows);
    assert_eq!(dir.lines().len(), KEEP_TASKS);
    // Admission order keeps counting after a reopen.
    admit(&ledger, 9_999);
    assert_eq!(ledger.list(1)[0].task_id, task(9_999));
}

#[test]
fn the_file_is_compacted_as_it_grows() {
    let dir = TempDir::new("compact");
    let ledger = TaskLedger::open_with(&dir.0, clock, 10).unwrap();
    admit(&ledger, 1);
    ledger.transition(&task(1), "running", None).unwrap();
    for _ in 0..25 {
        ledger.event(&task(1), "tool", "denied").unwrap();
    }
    assert!(dir.lines().len() <= 10, "{}", dir.lines().len());
    let before = ledger.list(1);
    drop(ledger);
    assert_eq!(open(&dir).list(1), before);
}

#[test]
fn concurrent_changes_are_serialized_and_all_kept() {
    let dir = TempDir::new("concurrent");
    let ledger = Arc::new(TaskLedger::open_with(&dir.0, clock, 50).unwrap());
    let threads: Vec<_> = (0..8)
        .map(|t| {
            let ledger = ledger.clone();
            std::thread::spawn(move || {
                for i in 0..10 {
                    let n = t * 100 + i;
                    admit(&ledger, n);
                    ledger.transition(&task(n), "running", None).unwrap();
                    ledger
                        .event(&task(n), "tool", "groups.clashes complete")
                        .unwrap();
                    ledger.transition(&task(n), "verified", None).unwrap();
                }
            })
        })
        .collect();
    for thread in threads {
        thread.join().unwrap();
    }
    let rows = ledger.list(usize::MAX);
    assert_eq!(rows.len(), 80);
    assert!(
        rows.iter()
            .all(|r| r.state == RunState::Verified && r.events.len() == 4)
    );
    drop(ledger);
    assert_eq!(open(&dir).list(usize::MAX), rows);
}

#[test]
fn a_second_copy_of_the_app_cannot_open_the_same_ledger() {
    let dir = TempDir::new("lock");
    let first = open(&dir);
    assert_eq!(
        TaskLedger::open_with(&dir.0, clock, 10).err(),
        Some(LedgerError::Unavailable)
    );
    drop(first);
    assert!(TaskLedger::open_with(&dir.0, clock, 10).is_ok());
}

#[cfg(unix)]
#[test]
fn the_ledger_is_private_to_this_account() {
    use std::os::unix::fs::PermissionsExt;
    let dir = TempDir::new("private");
    let ledger = open(&dir);
    admit(&ledger, 1);
    let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(&dir.0), 0o700);
    assert_eq!(mode(&dir.file()), 0o600);
    assert_eq!(mode(&dir.0.join(LOCK_FILE)), 0o600);
}

#[test]
fn an_oversized_ledger_file_is_refused_rather_than_truncated() {
    let dir = TempDir::new("oversized");
    std::fs::create_dir_all(&dir.0).unwrap();
    let file = File::create(dir.file()).unwrap();
    file.set_len(MAX_FILE_BYTES + 1).unwrap();
    assert_eq!(
        TaskLedger::open_with(&dir.0, clock, 10).err(),
        Some(LedgerError::Unavailable)
    );
    assert_eq!(
        std::fs::metadata(dir.file()).unwrap().len(),
        MAX_FILE_BYTES + 1
    );
}

// ---- Native model steps ---------------------------------------------------------------------

#[test]
fn model_steps_are_taken_one_at_a_time_up_to_six_and_closed_once() {
    let dir = TempDir::new("steps");
    let ledger = open(&dir);
    admit(&ledger, 1);
    // Only a running task takes a step.
    assert_eq!(ledger.reserve_step(&task(1)), Err(StepRefusal::Task));
    assert_eq!(ledger.step_view(&task(1)), Err(StepRefusal::Task));
    ledger.transition(&task(1), "running", None).unwrap();
    assert_eq!(
        ledger.step_view(&task(1)),
        Ok(StepView {
            kind: TaskKind::Ask,
            skill_id: ASK_SKILL.into(),
            steps: 0,
            minted: Vec::new(),
            replies: Vec::new(),
        })
    );
    assert_eq!(ledger.reserve_step(&task(1)), Ok(1));
    // A reply hash is sha-256 in lowercase hex, or empty for a step with no reply.
    for bad in [
        "abc",
        &REPLY.to_uppercase(),
        &format!("{REPLY}0"),
        "Riley Thornbury",
    ] {
        assert_eq!(
            ledger.finish_step(&task(1), 1, "tool_calls", 1, bad),
            Err(StepRefusal::Task),
            "{bad}"
        );
    }
    // One step in flight at a time; a step closes only as the one in flight, once.
    assert_eq!(ledger.reserve_step(&task(1)), Err(StepRefusal::Task));
    assert_eq!(ledger.step_view(&task(1)), Err(StepRefusal::Task));
    assert_eq!(
        ledger.finish_step(&task(1), 2, "stop", 0, REPLY),
        Err(StepRefusal::Task)
    );
    assert_eq!(
        ledger.finish_step(&task(1), 1, "the answer", 0, REPLY),
        Err(StepRefusal::Task)
    );
    ledger
        .finish_step(&task(1), 1, "tool_calls", 4, REPLY)
        .unwrap();
    assert_eq!(
        ledger.finish_step(&task(1), 1, "stop", 0, REPLY),
        Err(StepRefusal::Task)
    );
    // Minted calls stay within MAX_TOOL_CALLS across the task.
    assert_eq!(ledger.reserve_step(&task(1)), Ok(2));
    assert_eq!(
        ledger.finish_step(&task(1), 2, "tool_calls", 7, REPLY),
        Err(StepRefusal::Limit)
    );
    ledger
        .finish_step(&task(1), 2, "tool_calls", 6, REPLY)
        .unwrap();
    for step in 3..=MAX_STEPS {
        assert_eq!(ledger.reserve_step(&task(1)), Ok(step));
        ledger.finish_step(&task(1), step, "egress", 0, "").unwrap();
    }
    assert_eq!(ledger.reserve_step(&task(1)), Err(StepRefusal::Limit));
    assert_eq!(ledger.step_view(&task(1)), Err(StepRefusal::Limit));
    // A step in flight when the task is cancelled stays as it was; nothing follows.
    admit(&ledger, 2);
    ledger.transition(&task(2), "running", None).unwrap();
    ledger.reserve_step(&task(2)).unwrap();
    ledger.transition(&task(2), "cancelled", None).unwrap();
    assert_eq!(
        ledger.finish_step(&task(2), 1, "stop", 0, REPLY),
        Err(StepRefusal::Task)
    );
    // All of it is on disk and read back the same.
    let before = ledger.list(10);
    drop(ledger);
    let ledger = open(&dir);
    assert_eq!(ledger.list(10), before);
    assert_eq!(ledger.step_view(&task(1)), Err(StepRefusal::Limit));
}

#[test]
fn records_with_forged_steps_skills_or_orders_are_dropped_when_read_back() {
    let dir = TempDir::new("forged");
    {
        let ledger = open(&dir);
        admit(&ledger, 1);
        ledger.transition(&task(1), "running", None).unwrap();
        ledger.reserve_step(&task(1)).unwrap();
        ledger
            .finish_step(&task(1), 1, "tool_calls", 2, REPLY)
            .unwrap();
    }
    let good: serde_json::Value = serde_json::from_str(dir.lines().last().unwrap()).unwrap();
    let forged = |n: usize, change: &dyn Fn(&mut serde_json::Value)| {
        let mut record = good.clone();
        record["task_id"] = serde_json::json!(task(n));
        record["order"] = serde_json::json!(n);
        change(&mut record);
        record.to_string()
    };
    let lines = [
        // More minted calls than the contract allows, or minted with no step behind them.
        forged(2, &|r| r["minted"] = serde_json::json!([11])),
        forged(3, &|r| r["minted"] = serde_json::json!([1, 1])),
        // A step numbered out of order, or closed twice.
        forged(4, &|r| r["events"][2]["detail"] = serde_json::json!("2")),
        forged(5, &|r| {
            r["events"][3]["detail"] = serde_json::json!("2 stop")
        }),
        // A procedure that isn't bundled, or one paired with the wrong kind.
        forged(6, &|r| {
            r["skill_id"] = serde_json::json!("smith-family-is-in-the-hospital")
        }),
        forged(7, &|r| r["kind"] = serde_json::json!("check")),
        // An admission order at or past MAX_ORDER, which next_order would overflow or round.
        forged(8, &|r| r["order"] = serde_json::json!(u64::MAX)),
        forged(9, &|r| r["order"] = serde_json::json!(MAX_ORDER)),
        // Reply hashes that aren't one per finished step, or aren't hashes.
        forged(10, &|r| r["replies"] = serde_json::json!([REPLY, REPLY])),
        forged(12, &|r| {
            r["replies"] = serde_json::json!(["the model said Riley"])
        }),
        // From before replies were hashed: kept, but it can't take another step.
        forged(11, &|r| {
            r.as_object_mut().unwrap().remove("replies");
        }),
    ];
    {
        let mut file = OpenOptions::new().append(true).open(dir.file()).unwrap();
        for line in &lines {
            writeln!(file, "{line}").unwrap();
        }
    }
    let ledger = open(&dir);
    let ids: Vec<String> = ledger.list(20).into_iter().map(|r| r.task_id).collect();
    assert_eq!(ids, [task(11), task(1)]);
    let view = ledger.step_view(&task(1)).unwrap();
    assert_eq!(
        (view.minted, view.replies),
        (vec![2], vec![REPLY.to_owned()])
    );
    assert_eq!(ledger.step_view(&task(11)), Err(StepRefusal::Task));
    admit(&ledger, 10);
    assert_eq!(ledger.list(1)[0].task_id, task(10));
}

#[test]
fn admission_order_never_wraps() {
    let dir = TempDir::new("order");
    {
        let ledger = open(&dir);
        admit(&ledger, 1);
    }
    // The highest order a record may hold: the next admission would reach MAX_ORDER.
    let mut record: serde_json::Value = serde_json::from_str(&dir.lines()[0]).unwrap();
    record["order"] = serde_json::json!(MAX_ORDER - 1);
    std::fs::write(dir.file(), format!("{record}\n")).unwrap();
    let ledger = open(&dir);
    assert_eq!(ledger.list(1)[0].task_id, task(1));
    assert_eq!(
        ledger
            .admit(&task(2), "ask", ASK_SKILL, &hash(ASK_SKILL))
            .err(),
        Some(LedgerError::Unavailable)
    );
    assert_eq!(ledger.list(10).len(), 1);
}

#[test]
fn review_m4_how_long_a_task_has_been_running_is_awake_time_from_its_move_to_running() {
    static AWAKE: AtomicU64 = AtomicU64::new(5_000);
    fn awake() -> u64 {
        AWAKE.load(Ordering::SeqCst)
    }
    let dir = TempDir::new("running-for");
    let ledger = open(&dir).with_awake(awake);
    admit(&ledger, 1);
    // Admitted is not running yet.
    assert_eq!(ledger.running_for(&task(1)), None);
    ledger.transition(&task(1), "running", None).unwrap();
    assert_eq!(
        ledger.running_for(&task(1)),
        Some(std::time::Duration::ZERO)
    );
    // The ledger's own clock (the wall clock, which can jump) plays no part.
    AWAKE.store(35_000, Ordering::SeqCst);
    assert_eq!(
        ledger.running_for(&task(1)),
        Some(std::time::Duration::from_secs(30))
    );
    // Ended, unknown, or from an earlier launch (never seen running here): none.
    ledger
        .transition(&task(1), "failed", Some("timeout"))
        .unwrap();
    assert_eq!(ledger.running_for(&task(1)), None);
    assert_eq!(ledger.running_for(&task(2)), None);
    admit(&ledger, 3);
    ledger.transition(&task(3), "running", None).unwrap();
    drop(ledger);
    let reopened = open(&dir).with_awake(awake);
    assert_eq!(reopened.running_for(&task(3)), None);
}
