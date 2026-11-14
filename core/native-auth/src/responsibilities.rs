//! Ongoing responsibilities: what Ozzie keeps an eye on without another prompt (owner decisions,
//! November 4 and 14), and the native limits on every automatic run.
//!
//! A responsibility comes only from a plan a person confirmed, built from a fixed template
//! (core/src/harness/responsibilities.ts TEMPLATES, pinned by a test), and at most one per template
//! is active or paused at a time (`exists`). The page asks here before every automatic run:
//! `run_begin` refuses unless the responsibility is active, inside its lifetime, inside its
//! template's daily limits, not too soon after its last run, not already running, and not under
//! "Pause everything"; it returns a grant (a run id and how many AI steps the run may use).
//! `take_ai_step` spends those steps one at a time and `run_end` records the outcome.
//!
//! Exactly what this store enforces, and what it doesn't:
//!  - It decides whether an automatic run may START and records it. The Planning Center read a run
//!    makes is the ordinary `check_sunday` command (the same as "Check now"), which this store does
//!    not gate: a page that skipped `run_begin` could still read, bounded only by `check_sunday`'s
//!    own one-at-a-time rule and read caps. Ozzie's page always asks first; that is cooperation, not
//!    enforcement.
//!  - Daily limits count per TEMPLATE over a rolling 24 hours (`used`), so stopping a responsibility
//!    and setting it up again doesn't reset them.
//!  - An AI step paid from a grant (`responsibility_agent_step`) is refused past the run's grant, past
//!    the template's AI steps for the day, while it or everything is paused, once it has ended, and
//!    for any ledger task but a running procedure of the run's own template.
//!  - The page could instead send a model step down Ask's path (`agent_step`), which knows nothing of
//!    grants. What bounds EVERY model call, automatic or asked for, is the AI route's paid call cap
//!    and daily step cap (model.json, model.rs): that is the hard ceiling; grants only divide what
//!    automatic runs may use beneath it.
//!
//! Name-free by construction: the store holds a template id, schedule numbers, dates and times, a
//! time zone name checked against this Mac's time-zone database, fixed enums and counters. There is
//! no field for text: every input field is checked against a closed shape (`deny_unknown_fields`),
//! so a title, a note or a person's name has nowhere to go.
//!
//! Storage: `responsibilities.json` in the app data folder (file 0600, folder 0700), one JSON
//! document replaced atomically on every change (temporary file, fsync, rename). Opening checks
//! every record again exactly as a change is checked; a record that fails is dropped. A document
//! that can't be read refuses every run (`unavailable`) rather than resetting the limits.
use crate::ledger::FailureCode;
use crate::sunday_check::rfc3339;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

pub const STORE_FILE: &str = "responsibilities.json";
/// Responsibilities kept, stopped ones included; the oldest stopped one makes room first.
pub const MAX_RESPONSIBILITIES: usize = 20;
/// Runs kept per responsibility (more than a day's worth at every template's limit).
pub const RUNS_KEPT: usize = 30;
pub const DAY_MS: u64 = 86_400_000;
/// Two granted runs of one responsibility are never closer than this: a catch-up is one run, never a burst.
pub const MIN_GAP_MS: u64 = 5 * 60_000;
/// Developer builds with OZZIE_DEV_FAST_SCHEDULE=1 only.
pub const FAST_MIN_GAP_MS: u64 = 20_000;
/// A run still open after this belonged to an app that closed or a page that stopped; it is closed as interrupted.
pub const RUN_TIMEOUT_MS: u64 = 10 * 60_000;
/// AI steps one run may use (agent::MAX_STEPS, the per-task cap agent_step enforces as well).
pub const MAX_AI_STEPS_PER_RUN: u8 = crate::agent::MAX_STEPS;
const MAX_FILE_BYTES: u64 = 1 << 20;
const STORE_VERSION: u8 = 1;
/// Ends of a dated lifetime: the end of that date somewhere between UTC-12 and UTC+14.
const ZONE_EARLY_MS: u64 = 14 * 3_600_000;
const ZONE_LATE_MS: u64 = 12 * 3_600_000;
/// A dated lifetime ends within a year.
const LONGEST_MS: u64 = 367 * DAY_MS;
/// Rolling-window entries kept (every template's daily checks fit several times over).
const USED_KEPT: usize = 64;
/// This Mac's time-zone database; a stored zone must name one of its files.
const ZONEINFO: &str = "/usr/share/zoneinfo";

/// One fixed template. Mirrored in core/src/harness/responsibilities.ts (pinned by a test there).
#[derive(Debug)]
pub struct Template {
    pub id: &'static str,
    pub title: &'static str,
    pub skill_id: &'static str,
    pub checks_per_day: u8,
    pub ai_steps_per_day: u8,
    pub on_change: bool,
}
const fn template(
    id: &'static str,
    title: &'static str,
    skill_id: &'static str,
    checks_per_day: u8,
    ai_steps_per_day: u8,
    on_change: bool,
) -> Template {
    Template {
        id,
        title,
        skill_id,
        checks_per_day,
        ai_steps_per_day,
        on_change,
    }
}
pub const TEMPLATES: [Template; 5] = [
    template(
        "keep-sunday-covered",
        "Keep Sunday covered",
        "sunday-ready",
        6,
        12,
        true,
    ),
    template(
        "watch-room-bookings",
        "Watch room bookings",
        "room-check",
        3,
        6,
        false,
    ),
    template(
        "follow-ups-without-owner",
        "Follow-ups without an owner",
        "follow-up-owners",
        3,
        6,
        false,
    ),
    template(
        "group-night-clashes",
        "Group night clashes",
        "group-night",
        3,
        6,
        false,
    ),
    template(
        "morning-briefing",
        "Morning briefing",
        "sunday-ready",
        3,
        6,
        false,
    ),
];
pub fn template_for(id: &str) -> Option<&'static Template> {
    TEMPLATES.iter().find(|t| t.id == id)
}

/// The closed error vocabulary for responsibility commands (a bare string to the webview).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ResponsibilityError {
    /// A field failed its shape, vocabulary or the template's limits.
    Invalid,
    Unknown,
    Paused,
    PausedAll,
    /// Stopped by a person, or its lifetime already ended.
    Ended,
    /// Its lifetime ended just now; it is marked ended.
    Expired,
    ChecksLimit,
    AiLimit,
    /// The last run started less than MIN_GAP_MS ago.
    TooSoon,
    /// A run is still open.
    Busy,
    /// MAX_RESPONSIBILITIES are active or paused.
    Full,
    /// One of this template is already active or paused: change that one instead.
    Exists,
    /// No open run with that id.
    NoRun,
    /// The store can't be read or written.
    Unavailable,
}
type Result<T> = std::result::Result<T, ResponsibilityError>;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Report {
    DecisionsOnly,
    EveryCheck,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Status {
    Active,
    Paused,
    Ended,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Trigger {
    Start,
    Scheduled,
    CatchUp,
    Retry,
    Change,
    Manual,
}
impl Trigger {
    pub fn parse(text: &str) -> Option<Self> {
        serde_json::from_value(Value::String(text.to_owned())).ok()
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Outcome {
    Ok,
    Failed,
    Interrupted,
}

// ---- Input: a confirmed plan, exactly the shape responsibilities.ts `Plan` sends -----------------

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PlanInput {
    template: String,
    schedule: ScheduleInput,
    report: Report,
    lifetime: LifetimeInput,
    limits: LimitsInput,
    /// The IANA zone the schedule and lifetime were worked out in.
    zone: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ScheduleInput {
    time: String,
    weekdays: Vec<u8>,
    on_change: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LifetimeInput {
    kind: String,
    #[serde(default)]
    until: Option<String>,
    #[serde(default)]
    ends_at: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LimitsInput {
    checks_per_day: u8,
    ai_steps_per_day: u8,
}

// ---- Stored ----------------------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Run {
    run_id: String,
    trigger: Trigger,
    started_ms: u64,
    ended_ms: Option<u64>,
    outcome: Option<Outcome>,
    code: Option<FailureCode>,
    noticed: u8,
    drafts: u8,
    ai_granted: u8,
    ai_steps: u8,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    id: String,
    template: String,
    /// Minutes after midnight, church-local.
    time_minutes: u16,
    /// Bit d (0 = Sunday) set for each weekday it runs; 0 for every day.
    weekdays: u8,
    on_change: bool,
    report: Report,
    /// A dated lifetime: the church-local date and the instant it ends. Both or neither.
    until: Option<String>,
    ends_ms: Option<u64>,
    checks_per_day: u8,
    ai_steps_per_day: u8,
    status: Status,
    created_ms: u64,
    confirmed_ms: u64,
    /// Newest first.
    runs: Vec<Run>,
    /// The zone it was confirmed in (`zone_ok`). Absent on records made before zones were kept.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    zone: Option<String>,
}
/// One run counted toward its template's rolling 24 hours, kept apart from the record so that
/// stopping a responsibility and setting it up again doesn't reset what was used.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Used {
    template: String,
    run_id: String,
    started_ms: u64,
    ai_steps: u8,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Doc {
    v: u8,
    paused_all: bool,
    items: Vec<Record>,
    #[serde(default)]
    used: Vec<Used>,
}

// ---- Output: what responsibilities.ts `Responsibility` reads ----------------------------------------

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ScheduleRow {
    pub time: String,
    pub weekdays: Vec<u8>,
    pub on_change: bool,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum LifetimeRow {
    Until { until: String, ends_at: String },
    UntilStopped,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LimitsRow {
    pub checks_per_day: u8,
    pub ai_steps_per_day: u8,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct RunRow {
    pub run_id: String,
    pub trigger: Trigger,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub outcome: Option<Outcome>,
    pub code: Option<FailureCode>,
    pub noticed: u8,
    pub drafts: u8,
    pub ai_steps: u8,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ResponsibilityRow {
    pub id: String,
    pub template: &'static str,
    pub title: &'static str,
    pub skill_id: &'static str,
    pub schedule: ScheduleRow,
    pub report: Report,
    pub lifetime: LifetimeRow,
    pub limits: LimitsRow,
    pub status: Status,
    pub created_at: String,
    pub confirmed_at: String,
    pub runs: Vec<RunRow>,
    pub open_run: Option<RunRow>,
    pub zone: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Listing {
    pub paused_all: bool,
    pub items: Vec<ResponsibilityRow>,
}
/// What `run_begin` hands out: this run's id and how many AI steps it may use.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Grant {
    pub run_id: String,
    pub ai_steps: u8,
    /// Checks left in the last 24 hours after this one.
    pub checks_left: u8,
}

fn run_row(run: &Run) -> RunRow {
    RunRow {
        run_id: run.run_id.clone(),
        trigger: run.trigger,
        started_at: rfc3339(run.started_ms),
        ended_at: run.ended_ms.map(rfc3339),
        outcome: run.outcome,
        code: run.code,
        noticed: run.noticed,
        drafts: run.drafts,
        ai_steps: run.ai_steps,
    }
}
fn row(record: &Record) -> ResponsibilityRow {
    let t = template_for(&record.template).expect("checked when stored");
    ResponsibilityRow {
        id: record.id.clone(),
        template: t.id,
        title: t.title,
        skill_id: t.skill_id,
        schedule: ScheduleRow {
            time: format!(
                "{:02}:{:02}",
                record.time_minutes / 60,
                record.time_minutes % 60
            ),
            weekdays: (0..7).filter(|d| record.weekdays & (1 << d) != 0).collect(),
            on_change: record.on_change,
        },
        report: record.report,
        lifetime: match (&record.until, record.ends_ms) {
            (Some(until), Some(ends)) => LifetimeRow::Until {
                until: until.clone(),
                ends_at: rfc3339(ends),
            },
            _ => LifetimeRow::UntilStopped,
        },
        limits: LimitsRow {
            checks_per_day: record.checks_per_day,
            ai_steps_per_day: record.ai_steps_per_day,
        },
        status: record.status,
        created_at: rfc3339(record.created_ms),
        confirmed_at: rfc3339(record.confirmed_ms),
        runs: record.runs.iter().map(run_row).collect(),
        open_run: record
            .runs
            .first()
            .filter(|r| r.ended_ms.is_none())
            .map(run_row),
        zone: record.zone.clone(),
    }
}

// ---- Shapes -----------------------------------------------------------------------------------------

/// A lowercase UUID, as `crypto.randomUUID()` writes it.
pub fn id_ok(id: &str) -> bool {
    crate::ledger::task_id_ok(id)
}
fn new_id() -> Result<String> {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).map_err(|_| ResponsibilityError::Unavailable)?;
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let hex: String = b.iter().map(|x| format!("{x:02x}")).collect();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    ))
}
/// Days since 1970-01-01 of a proleptic Gregorian date.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}
fn digits(text: &str) -> Option<i64> {
    (!text.is_empty() && text.bytes().all(|b| b.is_ascii_digit()))
        .then(|| text.parse().ok())
        .flatten()
}
/// `YYYY-MM-DD` that names a real date → UTC midnight in ms.
pub fn date_ms(text: &str) -> Option<u64> {
    let b = text.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let (y, m, d) = (
        digits(&text[0..4])?,
        digits(&text[5..7])?,
        digits(&text[8..10])?,
    );
    if !(1970..=9999).contains(&y) || !(1..=12).contains(&m) || d < 1 {
        return None;
    }
    let days = days_from_civil(y, m, d);
    // A day past the month's end rolls into the next month: refuse it.
    if d > 28 && days_from_civil(y, m, d) - days_from_civil(y, m, 1) >= month_len(y, m) {
        return None;
    }
    u64::try_from(days).ok().map(|n| n * DAY_MS)
}
fn month_len(y: i64, m: i64) -> i64 {
    let (ny, nm) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
    days_from_civil(ny, nm, 1) - days_from_civil(y, m, 1)
}
/// Exactly the spelling `Date.prototype.toISOString` writes (`2026-11-23T05:00:00.000Z`).
pub fn instant_ms(text: &str) -> Option<u64> {
    let b = text.as_bytes();
    if b.len() != 24 || [10, 13, 16, 19, 23].map(|i| b[i]) != *b"T::.Z" {
        return None;
    }
    let day = date_ms(&text[0..10])?;
    let (h, mi, s, ms) = (
        digits(&text[11..13])?,
        digits(&text[14..16])?,
        digits(&text[17..19])?,
        digits(&text[20..23])?,
    );
    if h > 23 || mi > 59 || s > 59 {
        return None;
    }
    Some(day + u64::try_from(((h * 60 + mi) * 60 + s) * 1000 + ms).ok()?)
}
fn clock_minutes(text: &str) -> Option<u16> {
    let b = text.as_bytes();
    if b.len() != 5 || b[2] != b':' {
        return None;
    }
    let (h, m) = (digits(&text[0..2])?, digits(&text[3..5])?);
    (h <= 23 && m <= 59).then(|| (h * 60 + m) as u16)
}
/// An IANA time zone name this Mac's time-zone database has (`UTC`, `America/New_York`): the same
/// shape church-time.ts `isTimeZone` accepts, with no dots (so never a path outside the database),
/// and a file of that name under /usr/share/zoneinfo. Without that database, the shape alone.
pub fn zone_ok(zone: &str) -> bool {
    if zone == "UTC" {
        return true;
    }
    let mut parts = zone.split('/');
    let area = parts.next().unwrap_or_default();
    let rest: Vec<&str> = parts.collect();
    let shape = zone.len() <= 64
        && !area.is_empty()
        && area.bytes().all(|b| b.is_ascii_alphabetic() || b == b'_')
        && !rest.is_empty()
        && rest.iter().all(|p| {
            !p.is_empty()
                && p.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'+' | b'-'))
        });
    let database = Path::new(ZONEINFO);
    shape && (!database.is_dir() || database.join(zone).is_file())
}
/// The lifetime window for a dated plan: the end of `until` in some zone, ahead of now, within a year.
fn lifetime_ok(until: &str, ends_ms: u64, now: u64) -> bool {
    date_ms(until).is_some_and(|day| {
        let next = day + DAY_MS;
        ends_ms + ZONE_EARLY_MS >= next
            && ends_ms <= next + ZONE_LATE_MS
            && ends_ms > now
            && ends_ms <= now + LONGEST_MS
    })
}
fn run_ok(run: &Run) -> bool {
    id_ok(&run.run_id)
        && run.ai_granted <= MAX_AI_STEPS_PER_RUN
        && run.ai_steps <= run.ai_granted
        && run.noticed <= 99
        && run.drafts <= 99
        && match (run.ended_ms, run.outcome) {
            (None, None) => run.code.is_none(),
            (Some(end), Some(outcome)) => {
                end >= run.started_ms
                    && match outcome {
                        Outcome::Ok => run.code.is_none(),
                        Outcome::Failed => run.code.is_some(),
                        Outcome::Interrupted => run.code == Some(FailureCode::Interrupted),
                    }
            }
            _ => false,
        }
}
/// Every rule a stored responsibility meets, checked on every change and for every record read back.
fn record_ok(r: &Record) -> bool {
    let Some(t) = template_for(&r.template) else {
        return false;
    };
    let lifetime = match (&r.until, r.ends_ms) {
        // Expiry is checked against its own confirmation, not today: an ended one stays readable.
        (Some(until), Some(ends)) => {
            lifetime_ok(until, ends, r.confirmed_ms.min(ends.saturating_sub(1)))
        }
        (None, None) => true,
        _ => false,
    };
    id_ok(&r.id)
        && r.zone.as_deref().is_none_or(zone_ok)
        && r.time_minutes < 24 * 60
        && r.weekdays < 1 << 7
        && (!r.on_change || t.on_change)
        && (1..=t.checks_per_day).contains(&r.checks_per_day)
        && (1..=t.ai_steps_per_day).contains(&r.ai_steps_per_day)
        && lifetime
        && r.created_ms <= r.confirmed_ms
        && r.runs.len() <= RUNS_KEPT
        && r.runs.iter().all(run_ok)
        // Newest first; only the newest may still be open.
        && r.runs.windows(2).all(|w| w[0].started_ms >= w[1].started_ms)
        && r.runs.iter().skip(1).all(|run| run.ended_ms.is_some())
}
fn used_ok(u: &Used) -> bool {
    template_for(&u.template).is_some() && id_ok(&u.run_id) && u.ai_steps <= MAX_AI_STEPS_PER_RUN
}
fn doc_ok(doc: &Doc) -> bool {
    doc.items.iter().all(record_ok) && doc.used.len() <= USED_KEPT && doc.used.iter().all(used_ok)
}

/// A confirmed plan, checked against its template. Unknown fields (any free text) are refused.
fn parse_plan(plan: Value, now: u64) -> Result<(PlanInput, &'static Template)> {
    let plan: PlanInput = serde_json::from_value(plan).map_err(|_| ResponsibilityError::Invalid)?;
    let t = template_for(&plan.template).ok_or(ResponsibilityError::Invalid)?;
    let s = &plan.schedule;
    let weekdays_ok = s.weekdays.len() <= 7
        && s.weekdays.iter().all(|d| *d <= 6)
        && s.weekdays.is_sorted_by(|a, b| a < b);
    let lifetime_ok = match (
        plan.lifetime.kind.as_str(),
        &plan.lifetime.until,
        &plan.lifetime.ends_at,
    ) {
        ("until", Some(until), Some(ends)) => {
            instant_ms(ends).is_some_and(|e| lifetime_ok(until, e, now))
        }
        ("until-stopped", None, None) => true,
        _ => false,
    };
    let ok = clock_minutes(&s.time).is_some()
        && zone_ok(&plan.zone)
        && weekdays_ok
        && (!s.on_change || t.on_change)
        && (1..=t.checks_per_day).contains(&plan.limits.checks_per_day)
        && (1..=t.ai_steps_per_day).contains(&plan.limits.ai_steps_per_day)
        && lifetime_ok;
    if ok {
        Ok((plan, t))
    } else {
        Err(ResponsibilityError::Invalid)
    }
}
fn apply(record: &mut Record, plan: &PlanInput) {
    record.time_minutes = clock_minutes(&plan.schedule.time).unwrap_or(0);
    record.weekdays = plan
        .schedule
        .weekdays
        .iter()
        .fold(0, |mask, d| mask | (1 << d));
    record.on_change = plan.schedule.on_change;
    record.report = plan.report;
    record.until = plan.lifetime.until.clone();
    record.ends_ms = plan.lifetime.ends_at.as_deref().and_then(instant_ms);
    record.checks_per_day = plan.limits.checks_per_day;
    record.ai_steps_per_day = plan.limits.ai_steps_per_day;
    record.zone = Some(plan.zone.clone());
}

// ---- Files ------------------------------------------------------------------------------------------

fn read_doc(path: &Path) -> io::Result<Doc> {
    let file = match std::fs::File::open(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(Doc {
                v: STORE_VERSION,
                ..Doc::default()
            });
        }
        result => result?,
    };
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(io::ErrorKind::InvalidData.into());
    }
    let mut doc: Doc = serde_json::from_slice(&bytes).map_err(|_| io::ErrorKind::InvalidData)?;
    if doc.v != STORE_VERSION {
        return Err(io::ErrorKind::InvalidData.into());
    }
    doc.items.retain(record_ok);
    doc.items.truncate(MAX_RESPONSIBILITIES);
    doc.used.retain(used_ok);
    doc.used.truncate(USED_KEPT);
    Ok(doc)
}
/// Private file in a private folder, replaced atomically.
fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let dir = path.parent().ok_or(io::ErrorKind::InvalidInput)?;
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(dir)?;
    let partial = dir.join(format!(".{STORE_FILE}.partial"));
    let _ = std::fs::remove_file(&partial);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let written = options.open(&partial).and_then(|mut file| {
        file.write_all(bytes)?;
        file.sync_all()
    });
    if let Err(error) = written.and_then(|()| std::fs::rename(&partial, path)) {
        let _ = std::fs::remove_file(&partial);
        return Err(error);
    }
    Ok(())
}

pub type Clock = Arc<dyn Fn() -> u64 + Send + Sync>;

/// The store. One process serializes every change through a mutex; each change is written before it is visible.
pub struct ResponsibilityStore {
    path: PathBuf,
    clock: Clock,
    min_gap_ms: u64,
    /// None when the file couldn't be read: every command answers `unavailable`.
    doc: Mutex<Option<Doc>>,
}
impl ResponsibilityStore {
    /// `fast`: developer builds with OZZIE_DEV_FAST_SCHEDULE=1 only (a shorter gap between runs).
    pub fn open(dir: &Path, fast: bool) -> Self {
        let clock: Clock = Arc::new(crate::sunday_check::unix_ms);
        Self::open_with(dir, clock, if fast { FAST_MIN_GAP_MS } else { MIN_GAP_MS })
    }
    pub fn open_with(dir: &Path, clock: Clock, min_gap_ms: u64) -> Self {
        let path = dir.join(STORE_FILE);
        let doc = read_doc(&path).ok();
        Self {
            path,
            clock,
            min_gap_ms,
            doc: Mutex::new(doc),
        }
    }
    /// One change: on a copy, written (when anything changed) before it replaces the state in memory.
    /// A refused change keeps only what happens on its own: ended lifetimes and runs left open too long.
    fn change<T>(&self, work: impl FnOnce(&mut Doc, u64) -> Result<T>) -> Result<T> {
        let mut guard = self.doc.lock().unwrap_or_else(|e| e.into_inner());
        let current = guard.as_ref().ok_or(ResponsibilityError::Unavailable)?;
        let now = (self.clock)();
        let mut tidied = current.clone();
        tidy(&mut tidied, now);
        let mut next = tidied.clone();
        let result = work(&mut next, now);
        let keep = if result.is_ok() { next } else { tidied };
        // Only shapes the store accepts are ever kept.
        if !doc_ok(&keep) {
            return Err(ResponsibilityError::Invalid);
        }
        let before = serde_json::to_vec(current).map_err(|_| ResponsibilityError::Unavailable)?;
        let after = serde_json::to_vec(&keep).map_err(|_| ResponsibilityError::Unavailable)?;
        if before != after {
            write_private(&self.path, &after).map_err(|_| ResponsibilityError::Unavailable)?;
            *guard = Some(keep);
        }
        result
    }
    fn find(doc: &mut Doc, id: &str) -> Result<usize> {
        doc.items
            .iter()
            .position(|r| r.id == id)
            .ok_or(ResponsibilityError::Unknown)
    }

    pub fn list(&self) -> Result<Listing> {
        self.change(|doc, _| {
            Ok(Listing {
                paused_all: doc.paused_all,
                items: doc.items.iter().map(row).collect(),
            })
        })
    }
    pub fn paused_all(&self) -> bool {
        self.doc
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .is_some_and(|d| d.paused_all)
    }
    /// A new responsibility from a plan a person just confirmed. Starts active. Refused as `exists`
    /// while one of the same template is active or paused (that one is changed instead).
    pub fn create(&self, plan: Value) -> Result<ResponsibilityRow> {
        self.change(|doc, now| {
            let (plan, t) = parse_plan(plan, now)?;
            if doc
                .items
                .iter()
                .any(|r| r.template == t.id && r.status != Status::Ended)
            {
                return Err(ResponsibilityError::Exists);
            }
            if doc.items.len() >= MAX_RESPONSIBILITIES {
                let oldest_ended = doc
                    .items
                    .iter()
                    .enumerate()
                    .filter(|(_, r)| r.status == Status::Ended)
                    .min_by_key(|(_, r)| r.created_ms)
                    .map(|(i, _)| i)
                    .ok_or(ResponsibilityError::Full)?;
                doc.items.remove(oldest_ended);
            }
            let mut record = Record {
                id: new_id()?,
                template: t.id.to_owned(),
                time_minutes: 0,
                weekdays: 0,
                on_change: false,
                report: Report::DecisionsOnly,
                until: None,
                ends_ms: None,
                checks_per_day: 1,
                ai_steps_per_day: 1,
                status: Status::Active,
                created_ms: now,
                confirmed_ms: now,
                runs: Vec::new(),
                zone: None,
            };
            apply(&mut record, &plan);
            if !record_ok(&record) {
                return Err(ResponsibilityError::Invalid);
            }
            let out = row(&record);
            doc.items.push(record);
            Ok(out)
        })
    }
    /// A changed plan for the same template, confirmed again. Its runs and status are kept.
    pub fn edit(&self, id: &str, plan: Value) -> Result<ResponsibilityRow> {
        self.change(|doc, now| {
            let at = Self::find(doc, id)?;
            let (plan, t) = parse_plan(plan, now)?;
            let record = &mut doc.items[at];
            if record.status == Status::Ended {
                return Err(ended(record, now));
            }
            if t.id != record.template {
                return Err(ResponsibilityError::Invalid);
            }
            apply(record, &plan);
            record.confirmed_ms = now.max(record.created_ms);
            if !record_ok(record) {
                return Err(ResponsibilityError::Invalid);
            }
            Ok(row(record))
        })
    }
    fn set_status(&self, id: &str, to: Status) -> Result<ResponsibilityRow> {
        self.change(|doc, now| {
            let at = Self::find(doc, id)?;
            let record = &mut doc.items[at];
            if record.status == Status::Ended {
                return Err(ended(record, now));
            }
            record.status = to;
            Ok(row(record))
        })
    }
    pub fn pause(&self, id: &str) -> Result<ResponsibilityRow> {
        self.set_status(id, Status::Paused)
    }
    pub fn resume(&self, id: &str) -> Result<ResponsibilityRow> {
        self.set_status(id, Status::Active)
    }
    /// Stopped for good. It stays listed (with its runs) until room is needed.
    pub fn stop(&self, id: &str) -> Result<ResponsibilityRow> {
        self.set_status(id, Status::Ended)
    }
    /// "Pause everything": no responsibility runs until it is lifted. Each one keeps its own status.
    pub fn pause_all(&self, paused: bool) -> Result<Listing> {
        self.change(|doc, _| {
            doc.paused_all = paused;
            Ok(Listing {
                paused_all: doc.paused_all,
                items: doc.items.iter().map(row).collect(),
            })
        })
    }

    /// Asked before every automatic run. Refuses unless the responsibility is active, inside its
    /// lifetime and its template's daily limits, not too soon after its last run, not already
    /// running, nothing is paused, and the trigger is one its plan allows (a change brings a run
    /// sooner only when the plan watches for changes); then records the run as started and returns
    /// its grant.
    pub fn run_begin(&self, id: &str, trigger: &str) -> Result<Grant> {
        let trigger = Trigger::parse(trigger).ok_or(ResponsibilityError::Invalid)?;
        let min_gap = self.min_gap_ms;
        self.change(|doc, now| {
            if doc.paused_all {
                return Err(ResponsibilityError::PausedAll);
            }
            let at = Self::find(doc, id)?;
            let Doc { items, used, .. } = doc;
            let record = &mut items[at];
            match record.status {
                Status::Paused => return Err(ResponsibilityError::Paused),
                Status::Ended => return Err(ended(record, now)),
                Status::Active => {}
            }
            if trigger == Trigger::Change && !record.on_change {
                return Err(ResponsibilityError::Invalid);
            }
            if record.runs.first().is_some_and(|r| r.ended_ms.is_none()) {
                return Err(ResponsibilityError::Busy);
            }
            // The template's rolling 24 hours, whichever of its responsibilities used them.
            let recent: Vec<&Used> = used
                .iter()
                .filter(|u| {
                    u.template == record.template
                        && u.started_ms <= now
                        && now - u.started_ms < DAY_MS
                })
                .collect();
            if recent.len() >= usize::from(record.checks_per_day) {
                return Err(ResponsibilityError::ChecksLimit);
            }
            if record
                .runs
                .first()
                .is_some_and(|r| r.started_ms <= now && now - r.started_ms < min_gap)
            {
                return Err(ResponsibilityError::TooSoon);
            }
            let ai_used: u16 = recent.iter().map(|u| u16::from(u.ai_steps)).sum();
            let ai_left = u16::from(record.ai_steps_per_day).saturating_sub(ai_used);
            let ai_granted =
                u8::try_from(ai_left.min(u16::from(MAX_AI_STEPS_PER_RUN))).unwrap_or(0);
            let checks_left = record.checks_per_day - recent.len() as u8 - 1;
            let run = Run {
                run_id: new_id()?,
                trigger,
                started_ms: now,
                ended_ms: None,
                outcome: None,
                code: None,
                noticed: 0,
                drafts: 0,
                ai_granted,
                ai_steps: 0,
            };
            let grant = Grant {
                run_id: run.run_id.clone(),
                ai_steps: ai_granted,
                checks_left,
            };
            used.insert(
                0,
                Used {
                    template: record.template.clone(),
                    run_id: run.run_id.clone(),
                    started_ms: now,
                    ai_steps: 0,
                },
            );
            used.truncate(USED_KEPT);
            record.runs.insert(0, run);
            record.runs.truncate(RUNS_KEPT);
            Ok(grant)
        })
    }
    /// One AI step of an open run, within its grant, counted before the step is sent. `skill_id` is
    /// the procedure of the ledger task the step belongs to: only the run's own template's procedure
    /// may spend its grant (`invalid` otherwise). Refused while the responsibility or everything is
    /// paused, and once it has ended (its open run is then closed).
    pub fn take_ai_step(&self, run_id: &str, skill_id: &str) -> Result<u8> {
        self.change(|doc, now| {
            let paused_all = doc.paused_all;
            let Doc { items, used, .. } = doc;
            let record = items
                .iter_mut()
                .find(|r| {
                    r.runs
                        .first()
                        .is_some_and(|run| run.run_id == run_id && run.ended_ms.is_none())
                })
                .ok_or(ResponsibilityError::NoRun)?;
            if paused_all {
                return Err(ResponsibilityError::PausedAll);
            }
            match record.status {
                Status::Paused => return Err(ResponsibilityError::Paused),
                Status::Ended => return Err(ended(record, now)),
                Status::Active => {}
            }
            if template_for(&record.template).is_none_or(|t| t.skill_id != skill_id) {
                return Err(ResponsibilityError::Invalid);
            }
            let run = &mut record.runs[0];
            if run.ai_steps >= run.ai_granted {
                return Err(ResponsibilityError::AiLimit);
            }
            run.ai_steps += 1;
            let steps = run.ai_steps;
            if let Some(entry) = used.iter_mut().find(|u| u.run_id == run_id) {
                entry.ai_steps = entry.ai_steps.max(steps);
            }
            Ok(steps)
        })
    }
    /// Closes an open run: "ok", or "failed" with its FailureCode. Counts only; never text.
    pub fn run_end(
        &self,
        id: &str,
        run_id: &str,
        outcome: &str,
        code: Option<&str>,
        noticed: u32,
        drafts: u32,
    ) -> Result<ResponsibilityRow> {
        let outcome = match outcome {
            "ok" => Outcome::Ok,
            "failed" => Outcome::Failed,
            _ => return Err(ResponsibilityError::Invalid),
        };
        let code = match code {
            None => None,
            Some(text) => Some(FailureCode::parse(text).ok_or(ResponsibilityError::Invalid)?),
        };
        if (outcome == Outcome::Failed) != code.is_some() || code == Some(FailureCode::Interrupted)
        {
            return Err(ResponsibilityError::Invalid);
        }
        self.change(|doc, now| {
            let at = Self::find(doc, id)?;
            let record = &mut doc.items[at];
            let run = record
                .runs
                .first_mut()
                .filter(|r| r.run_id == run_id && r.ended_ms.is_none())
                .ok_or(ResponsibilityError::NoRun)?;
            run.ended_ms = Some(now.max(run.started_ms));
            run.outcome = Some(outcome);
            run.code = code;
            run.noticed = noticed.min(99) as u8;
            run.drafts = drafts.min(99) as u8;
            Ok(row(record))
        })
    }
}

/// Why an ended responsibility can't run: its lifetime is over, or a person stopped it.
fn ended(record: &Record, now: u64) -> ResponsibilityError {
    if record.ends_ms.is_some_and(|end| now >= end) {
        ResponsibilityError::Expired
    } else {
        ResponsibilityError::Ended
    }
}
/// Ends responsibilities whose lifetime is over, closes runs left open too long, and keeps each
/// template's rolling 24 hours: every run a record still lists is counted (a store written before
/// `used` existed included), and anything older than a day is let go.
fn tidy(doc: &mut Doc, now: u64) {
    for record in &doc.items {
        for run in &record.runs {
            if now.saturating_sub(run.started_ms) >= DAY_MS {
                continue;
            }
            match doc.used.iter_mut().find(|u| u.run_id == run.run_id) {
                Some(entry) => entry.ai_steps = entry.ai_steps.max(run.ai_steps),
                None => doc.used.push(Used {
                    template: record.template.clone(),
                    run_id: run.run_id.clone(),
                    started_ms: run.started_ms,
                    ai_steps: run.ai_steps,
                }),
            }
        }
    }
    doc.used
        .retain(|u| now.saturating_sub(u.started_ms) < DAY_MS);
    doc.used.sort_by_key(|u| std::cmp::Reverse(u.started_ms));
    doc.used.truncate(USED_KEPT);
    for record in &mut doc.items {
        if record.status != Status::Ended && record.ends_ms.is_some_and(|end| now >= end) {
            record.status = Status::Ended;
        }
        if let Some(run) = record.runs.first_mut()
            && run.ended_ms.is_none()
            && (now.saturating_sub(run.started_ms) >= RUN_TIMEOUT_MS
                || record.status == Status::Ended)
        {
            run.ended_ms = Some(now.max(run.started_ms));
            run.outcome = Some(Outcome::Interrupted);
            run.code = Some(FailureCode::Interrupted);
        }
    }
}

#[cfg(test)]
#[path = "responsibilities_tests.rs"]
mod tests;
