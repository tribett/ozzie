//! The responsibilities store over a temporary folder and a fake clock. No names exist here at all.
use super::*;
use serde_json::json;
use std::sync::atomic::{AtomicU64, Ordering};

// Saturday 14 November 2026, 15:00 UTC (10:00 in New York).
const SAT: u64 = 1_794_668_400_000;
const MIN: u64 = 60_000;
const HOUR: u64 = 60 * MIN;

struct TempDir(PathBuf);
impl TempDir {
    fn new(label: &str) -> Self {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        Self(std::env::temp_dir().join(format!(
            "ozzie-responsibilities-{label}-{}-{nanos}",
            std::process::id()
        )))
    }
    fn file(&self) -> PathBuf {
        self.0.join(STORE_FILE)
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
struct Fixture {
    dir: TempDir,
    now: Arc<AtomicU64>,
    store: ResponsibilityStore,
}
impl Fixture {
    fn new(label: &str) -> Self {
        let dir = TempDir::new(label);
        let now = Arc::new(AtomicU64::new(SAT));
        let store = Self::open_at(&dir, &now);
        Self { dir, now, store }
    }
    fn open_at(dir: &TempDir, now: &Arc<AtomicU64>) -> ResponsibilityStore {
        let clock = now.clone();
        ResponsibilityStore::open_with(
            &dir.0,
            Arc::new(move || clock.load(Ordering::SeqCst)),
            MIN_GAP_MS,
        )
    }
    fn reopen(&self) -> ResponsibilityStore {
        Self::open_at(&self.dir, &self.now)
    }
    fn advance(&self, ms: u64) {
        self.now.fetch_add(ms, Ordering::SeqCst);
    }
    fn set(&self, ms: u64) {
        self.now.store(ms, Ordering::SeqCst);
    }
}
/// The plan responsibilities.ts `defaultPlan("keep-sunday-covered", …)` makes on that Saturday.
fn sunday_plan() -> Value {
    json!({
        "template": "keep-sunday-covered",
        "schedule": { "time": "07:00", "weekdays": [], "on_change": true },
        "report": "decisions-only",
        "lifetime": { "kind": "until", "until": "2026-11-15", "ends_at": "2026-11-16T05:00:00.000Z" },
        "limits": { "checks_per_day": 6, "ai_steps_per_day": 12 },
        "zone": "America/New_York"
    })
}
fn weekly_plan() -> Value {
    json!({
        "template": "watch-room-bookings",
        "schedule": { "time": "09:00", "weekdays": [4], "on_change": false },
        "report": "decisions-only",
        "lifetime": { "kind": "until-stopped" },
        "limits": { "checks_per_day": 3, "ai_steps_per_day": 6 },
        "zone": "America/New_York"
    })
}
fn with(mut plan: Value, path: &[&str], value: Value) -> Value {
    let (last, parents) = path.split_last().unwrap();
    let mut at = &mut plan;
    for key in parents {
        at = at.get_mut(*key).unwrap();
    }
    at.as_object_mut()
        .unwrap()
        .insert((*last).to_owned(), value);
    plan
}

#[test]
fn a_confirmed_plan_becomes_an_active_responsibility_with_its_fixed_title() {
    let f = Fixture::new("create");
    let row = f.store.create(sunday_plan()).unwrap();
    assert!(id_ok(&row.id));
    assert_eq!(
        (row.template, row.title, row.skill_id, row.status),
        (
            "keep-sunday-covered",
            "Keep Sunday covered",
            "sunday-ready",
            Status::Active
        )
    );
    assert_eq!(
        row.schedule,
        ScheduleRow {
            time: "07:00".into(),
            weekdays: vec![],
            on_change: true
        }
    );
    assert_eq!(
        row.lifetime,
        LifetimeRow::Until {
            until: "2026-11-15".into(),
            ends_at: "2026-11-16T05:00:00.000Z".into()
        }
    );
    assert_eq!(row.created_at, "2026-11-14T15:00:00.000Z");
    assert_eq!(row.confirmed_at, row.created_at);
    assert!(row.runs.is_empty() && row.open_run.is_none());
    let listing = f.reopen().list().unwrap();
    assert_eq!(listing.items, vec![row]);
    assert!(!listing.paused_all);
    let weekly = f.store.create(weekly_plan()).unwrap();
    assert_eq!(weekly.schedule.weekdays, vec![4]);
    assert_eq!(weekly.lifetime, LifetimeRow::UntilStopped);
    // The listing serializes to exactly what responsibilities.ts reads.
    let value = serde_json::to_value(&weekly).unwrap();
    assert_eq!(value["lifetime"], json!({ "kind": "until-stopped" }));
    assert_eq!(value["report"], json!("decisions-only"));
    assert_eq!(value["status"], json!("active"));
    // It keeps the zone it was confirmed in.
    assert_eq!(value["zone"], json!("America/New_York"));
}

#[test]
fn every_field_is_checked_and_free_text_has_nowhere_to_go() {
    let f = Fixture::new("invalid");
    let refused = [
        with(
            sunday_plan(),
            &["title"],
            json!("Keep Sunday covered for Avery"),
        ),
        with(
            sunday_plan(),
            &["schedule", "note"],
            json!("call Avery first"),
        ),
        with(
            sunday_plan(),
            &["lifetime", "label"],
            json!("until Avery is back"),
        ),
        with(sunday_plan(), &["template"], json!("send-reminders")),
        with(sunday_plan(), &["template"], json!("Keep Sunday covered")),
        with(sunday_plan(), &["schedule", "time"], json!("7am")),
        with(sunday_plan(), &["schedule", "time"], json!("24:00")),
        with(sunday_plan(), &["schedule", "weekdays"], json!([7])),
        with(sunday_plan(), &["schedule", "weekdays"], json!([3, 1])),
        with(sunday_plan(), &["schedule", "weekdays"], json!([1, 1])),
        with(weekly_plan(), &["schedule", "on_change"], json!(true)),
        with(sunday_plan(), &["report"], json!("loudly")),
        with(sunday_plan(), &["limits", "checks_per_day"], json!(7)),
        with(sunday_plan(), &["limits", "checks_per_day"], json!(0)),
        with(sunday_plan(), &["limits", "ai_steps_per_day"], json!(13)),
        with(weekly_plan(), &["limits", "checks_per_day"], json!(4)),
        // Dated lifetimes: a real date, ending when that date ends somewhere, ahead and within a year.
        with(sunday_plan(), &["lifetime", "until"], json!("2026-02-30")),
        with(sunday_plan(), &["lifetime", "until"], json!("15 Nov 2026")),
        with(
            sunday_plan(),
            &["lifetime", "ends_at"],
            json!("2026-11-20T05:00:00.000Z"),
        ),
        with(
            sunday_plan(),
            &["lifetime", "ends_at"],
            json!("2026-11-16T05:00:00Z"),
        ),
        with(
            with(sunday_plan(), &["lifetime", "until"], json!("2026-11-13")),
            &["lifetime", "ends_at"],
            json!("2026-11-14T05:00:00.000Z"),
        ),
        with(
            with(sunday_plan(), &["lifetime", "until"], json!("2028-01-02")),
            &["lifetime", "ends_at"],
            json!("2028-01-03T05:00:00.000Z"),
        ),
        with(
            sunday_plan(),
            &["lifetime"],
            json!({ "kind": "until-stopped", "until": "2026-11-15" }),
        ),
        with(sunday_plan(), &["lifetime"], json!({ "kind": "forever" })),
        // The zone is a time zone this Mac's database has, never free text.
        with(sunday_plan(), &["zone"], json!("Avery Brightwater")),
        with(sunday_plan(), &["zone"], json!("America/Avery_Brightwater")),
        with(sunday_plan(), &["zone"], json!("America/../../etc/passwd")),
        with(sunday_plan(), &["zone"], json!("")),
        with(sunday_plan(), &["zone"], json!(null)),
        json!("Keep an eye on Sunday for Avery"),
        json!(null),
    ];
    for plan in refused {
        assert_eq!(
            f.store.create(plan.clone()).err(),
            Some(ResponsibilityError::Invalid),
            "{plan}"
        );
    }
    assert!(f.store.list().unwrap().items.is_empty());
    assert!(!f.dir.file().exists(), "a refused plan writes nothing");
}

#[test]
fn the_file_is_private_and_holds_only_fixed_fields() {
    let f = Fixture::new("private");
    let row = f.store.create(sunday_plan()).unwrap();
    let grant = f.store.run_begin(&row.id, "start").unwrap();
    f.store
        .run_end(&row.id, &grant.run_id, "ok", None, 2, 1)
        .unwrap();
    let text = std::fs::read_to_string(f.dir.file()).unwrap();
    let doc: Value = serde_json::from_str(&text).unwrap();
    let keys = |v: &Value| {
        v.as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<Vec<String>>()
    };
    assert_eq!(keys(&doc), ["items", "paused_all", "used", "v"]);
    assert_eq!(
        keys(&doc["items"][0]),
        [
            "ai_steps_per_day",
            "checks_per_day",
            "confirmed_ms",
            "created_ms",
            "ends_ms",
            "id",
            "on_change",
            "report",
            "runs",
            "status",
            "template",
            "time_minutes",
            "until",
            "weekdays",
            "zone"
        ]
    );
    assert_eq!(
        keys(&doc["used"][0]),
        ["ai_steps", "run_id", "started_ms", "template"]
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&f.dir.file()), 0o600);
        assert_eq!(mode(&f.dir.0), 0o700);
    }
}

#[test]
fn a_run_is_granted_only_when_active_and_nothing_is_paused() {
    let f = Fixture::new("begin");
    let row = f.store.create(weekly_plan()).unwrap();
    assert_eq!(
        f.store
            .run_begin("00000000-0000-4000-8000-000000000009", "start")
            .err(),
        Some(ResponsibilityError::Unknown)
    );
    assert_eq!(
        f.store.run_begin(&row.id, "whenever").err(),
        Some(ResponsibilityError::Invalid)
    );
    f.store.pause(&row.id).unwrap();
    assert_eq!(
        f.store.run_begin(&row.id, "scheduled").err(),
        Some(ResponsibilityError::Paused)
    );
    f.store.resume(&row.id).unwrap();
    f.store.pause_all(true).unwrap();
    assert!(f.store.paused_all());
    assert_eq!(
        f.store.run_begin(&row.id, "scheduled").err(),
        Some(ResponsibilityError::PausedAll)
    );
    // Pausing everything survives a restart.
    assert!(f.reopen().paused_all());
    f.store.pause_all(false).unwrap();
    let grant = f.store.run_begin(&row.id, "scheduled").unwrap();
    assert!(id_ok(&grant.run_id));
    assert_eq!((grant.ai_steps, grant.checks_left), (6, 2));
    // A second run while one is open, and a run right after it, are refused.
    assert_eq!(
        f.store.run_begin(&row.id, "manual").err(),
        Some(ResponsibilityError::Busy)
    );
    f.store
        .run_end(&row.id, &grant.run_id, "ok", None, 0, 0)
        .unwrap();
    assert_eq!(
        f.store.run_begin(&row.id, "catch-up").err(),
        Some(ResponsibilityError::TooSoon)
    );
    f.store.stop(&row.id).unwrap();
    f.advance(HOUR);
    assert_eq!(
        f.store.run_begin(&row.id, "scheduled").err(),
        Some(ResponsibilityError::Ended)
    );
    assert_eq!(
        f.store.resume(&row.id).err(),
        Some(ResponsibilityError::Ended)
    );
    assert_eq!(
        f.store.edit(&row.id, weekly_plan()).err(),
        Some(ResponsibilityError::Ended)
    );
}

#[test]
fn a_dated_lifetime_ends_on_its_own() {
    let f = Fixture::new("expired");
    let row = f.store.create(sunday_plan()).unwrap();
    f.set(Date::ENDS - 1);
    let grant = f.store.run_begin(&row.id, "scheduled").unwrap();
    // The lifetime ends while the run is open: the run is closed as interrupted.
    f.set(Date::ENDS);
    assert_eq!(
        f.store.run_begin(&row.id, "scheduled").err(),
        Some(ResponsibilityError::Expired)
    );
    let listed = &f.store.list().unwrap().items[0];
    assert_eq!(listed.status, Status::Ended);
    assert_eq!(listed.runs[0].run_id, grant.run_id);
    assert_eq!(listed.runs[0].outcome, Some(Outcome::Interrupted));
    assert_eq!(listed.runs[0].code, Some(FailureCode::Interrupted));
    assert_eq!(
        f.store
            .run_end(&row.id, &grant.run_id, "ok", None, 0, 0)
            .err(),
        Some(ResponsibilityError::NoRun)
    );
    // Still ended after a restart, and still readable.
    assert_eq!(f.reopen().list().unwrap().items[0].status, Status::Ended);
}
struct Date;
impl Date {
    /// 2026-11-16T05:00:00.000Z, the end of Sunday 15 November in New York.
    const ENDS: u64 = 1_794_805_200_000;
}

#[test]
fn daily_limits_count_the_last_24_hours() {
    let f = Fixture::new("limits");
    let row = f.store.create(weekly_plan()).unwrap();
    for _ in 0..3 {
        let grant = f.store.run_begin(&row.id, "scheduled").unwrap();
        f.store
            .run_end(&row.id, &grant.run_id, "ok", None, 0, 0)
            .unwrap();
        f.advance(MIN_GAP_MS);
    }
    assert_eq!(
        f.store.run_begin(&row.id, "retry").err(),
        Some(ResponsibilityError::ChecksLimit)
    );
    // 24 hours after the first, one check is free again.
    f.set(SAT + DAY_MS);
    let grant = f.store.run_begin(&row.id, "scheduled").unwrap();
    assert_eq!(grant.checks_left, 0);
}

#[test]
fn ai_steps_are_spent_one_at_a_time_within_the_grant_and_the_day() {
    let f = Fixture::new("ai");
    let row = f
        .store
        .create(with(
            weekly_plan(),
            &["limits", "ai_steps_per_day"],
            json!(4),
        ))
        .unwrap();
    let first = f.store.run_begin(&row.id, "scheduled").unwrap();
    assert_eq!(first.ai_steps, 4);
    for n in 1..=3 {
        assert_eq!(f.store.take_ai_step(&first.run_id, "room-check"), Ok(n));
    }
    f.store
        .run_end(&row.id, &first.run_id, "ok", None, 1, 0)
        .unwrap();
    // A closed run can't take another step.
    assert_eq!(
        f.store.take_ai_step(&first.run_id, "room-check").err(),
        Some(ResponsibilityError::NoRun)
    );
    f.advance(MIN_GAP_MS);
    let second = f.store.run_begin(&row.id, "scheduled").unwrap();
    assert_eq!(second.ai_steps, 1, "4 a day, 3 used");
    assert_eq!(f.store.take_ai_step(&second.run_id, "room-check"), Ok(1));
    assert_eq!(
        f.store.take_ai_step(&second.run_id, "room-check").err(),
        Some(ResponsibilityError::AiLimit)
    );
    assert_eq!(
        f.store
            .take_ai_step("00000000-0000-4000-8000-00000000000a", "room-check")
            .err(),
        Some(ResponsibilityError::NoRun)
    );
    let listed = f.store.list().unwrap();
    assert_eq!(listed.items[0].open_run.as_ref().unwrap().ai_steps, 1);
    // A single run never gets more than the per-task cap.
    let g = Fixture::new("ai-cap");
    let sunday = g.store.create(sunday_plan()).unwrap();
    assert_eq!(
        g.store.run_begin(&sunday.id, "start").unwrap().ai_steps,
        MAX_AI_STEPS_PER_RUN
    );
}

#[test]
fn ending_a_run_records_counts_and_closed_codes_only() {
    let f = Fixture::new("end");
    let row = f.store.create(weekly_plan()).unwrap();
    let grant = f.store.run_begin(&row.id, "scheduled").unwrap();
    for (outcome, code) in [
        ("ok", Some("provider-failure")),
        ("failed", None),
        ("failed", Some("Planning Center was down")),
        ("failed", Some("interrupted")),
        ("done", None),
    ] {
        assert_eq!(
            f.store
                .run_end(&row.id, &grant.run_id, outcome, code, 0, 0)
                .err(),
            Some(ResponsibilityError::Invalid),
            "{outcome} {code:?}"
        );
    }
    assert_eq!(
        f.store
            .run_end(
                &row.id,
                "00000000-0000-4000-8000-00000000000b",
                "ok",
                None,
                0,
                0
            )
            .err(),
        Some(ResponsibilityError::NoRun)
    );
    f.advance(MIN);
    let ended = f
        .store
        .run_end(
            &row.id,
            &grant.run_id,
            "failed",
            Some("provider-failure"),
            500,
            3,
        )
        .unwrap();
    let run = &ended.runs[0];
    assert_eq!(run.outcome, Some(Outcome::Failed));
    assert_eq!(run.code, Some(FailureCode::ProviderFailure));
    assert_eq!((run.noticed, run.drafts), (99, 3));
    assert_eq!(run.ended_at.as_deref(), Some("2026-11-14T15:01:00.000Z"));
    assert!(ended.open_run.is_none());
}

#[test]
fn a_run_left_open_too_long_is_closed_as_interrupted() {
    let f = Fixture::new("stale");
    let row = f.store.create(weekly_plan()).unwrap();
    let grant = f.store.run_begin(&row.id, "scheduled").unwrap();
    f.advance(RUN_TIMEOUT_MS);
    let next = f.store.run_begin(&row.id, "retry").unwrap();
    assert_ne!(next.run_id, grant.run_id);
    let listed = &f.store.list().unwrap().items[0];
    assert_eq!(listed.runs[1].outcome, Some(Outcome::Interrupted));
    assert_eq!(listed.open_run.as_ref().unwrap().run_id, next.run_id);
}

#[test]
fn edits_keep_the_template_and_are_confirmed_again() {
    let f = Fixture::new("edit");
    let row = f.store.create(sunday_plan()).unwrap();
    f.advance(HOUR);
    let edited = f
        .store
        .edit(
            &row.id,
            with(
                with(sunday_plan(), &["schedule", "time"], json!("08:30")),
                &["report"],
                json!("every-check"),
            ),
        )
        .unwrap();
    assert_eq!(edited.schedule.time, "08:30");
    assert_eq!(edited.report, Report::EveryCheck);
    assert_eq!(edited.confirmed_at, "2026-11-14T16:00:00.000Z");
    assert_eq!(edited.created_at, row.created_at);
    assert_eq!(
        f.store.edit(&row.id, weekly_plan()).err(),
        Some(ResponsibilityError::Invalid),
        "another template is a new responsibility"
    );
}

#[test]
fn an_unreadable_store_refuses_every_run_instead_of_resetting_its_limits() {
    let f = Fixture::new("corrupt");
    let row = f.store.create(weekly_plan()).unwrap();
    std::fs::write(f.dir.file(), b"{ not json").unwrap();
    let store = f.reopen();
    assert_eq!(store.list().err(), Some(ResponsibilityError::Unavailable));
    assert_eq!(
        store.run_begin(&row.id, "scheduled").err(),
        Some(ResponsibilityError::Unavailable)
    );
    assert_eq!(
        store.create(weekly_plan()).err(),
        Some(ResponsibilityError::Unavailable)
    );
}

#[test]
fn a_record_that_fails_its_checks_is_dropped_when_read_back() {
    let f = Fixture::new("tampered");
    f.store.create(sunday_plan()).unwrap();
    f.store.create(weekly_plan()).unwrap();
    let mut doc: Value = serde_json::from_slice(&std::fs::read(f.dir.file()).unwrap()).unwrap();
    // Raised past its template's limit, and a field the store doesn't have.
    doc["items"][0]["checks_per_day"] = json!(50);
    doc["items"][1]["note"] = json!("free text");
    std::fs::write(f.dir.file(), serde_json::to_vec(&doc).unwrap()).unwrap();
    // A field the store doesn't have makes the whole document unreadable; a bad value drops one record.
    assert_eq!(
        f.reopen().list().err(),
        Some(ResponsibilityError::Unavailable)
    );
    doc["items"][1].as_object_mut().unwrap().remove("note");
    std::fs::write(f.dir.file(), serde_json::to_vec(&doc).unwrap()).unwrap();
    let listed = f.reopen().list().unwrap();
    assert_eq!(listed.items.len(), 1);
    assert_eq!(listed.items[0].template, "watch-room-bookings");
}

#[test]
fn room_is_made_by_dropping_the_oldest_stopped_one() {
    let f = Fixture::new("full");
    let mut ids = Vec::new();
    for _ in 0..MAX_RESPONSIBILITIES {
        let id = f.store.create(weekly_plan()).unwrap().id;
        f.store.stop(&id).unwrap();
        ids.push(id);
        f.advance(1);
    }
    f.store.create(sunday_plan()).unwrap();
    let listed = f.store.list().unwrap().items;
    assert_eq!(listed.len(), MAX_RESPONSIBILITIES);
    assert!(listed.iter().all(|r| r.id != ids[0]));
    assert!(listed.iter().any(|r| r.id == ids[1]));
}

#[test]
fn one_responsibility_per_template_is_active_or_paused() {
    let f = Fixture::new("exists");
    let row = f.store.create(sunday_plan()).unwrap();
    assert_eq!(
        f.store.create(sunday_plan()).err(),
        Some(ResponsibilityError::Exists)
    );
    // Another template is fine.
    f.store.create(weekly_plan()).unwrap();
    f.store.pause(&row.id).unwrap();
    assert_eq!(
        f.store.create(sunday_plan()).err(),
        Some(ResponsibilityError::Exists),
        "a paused one still counts"
    );
    f.store.stop(&row.id).unwrap();
    let again = f.store.create(sunday_plan()).unwrap();
    assert_ne!(again.id, row.id);
    // Its lifetime ending frees the template too.
    f.set(Date::ENDS);
    f.store
        .create(sunday_plan_until("2026-11-22", 1_795_410_000_000))
        .unwrap();
    assert_eq!(
        serde_json::to_value(ResponsibilityError::Exists).unwrap(),
        json!("exists")
    );
}
/// A Keep Sunday covered plan ending at the end of `until` in New York (`ends_ms`).
fn sunday_plan_until(until: &str, ends_ms: u64) -> Value {
    with(
        with(sunday_plan(), &["lifetime", "until"], json!(until)),
        &["lifetime", "ends_at"],
        json!(rfc3339(ends_ms)),
    )
}

#[test]
fn stopping_and_setting_up_again_does_not_reset_the_days_limits() {
    let f = Fixture::new("window");
    let first = f.store.create(weekly_plan()).unwrap();
    for n in 0..3 {
        let grant = f.store.run_begin(&first.id, "scheduled").unwrap();
        if n == 0 {
            for _ in 0..grant.ai_steps {
                f.store.take_ai_step(&grant.run_id, "room-check").unwrap();
            }
        }
        f.store
            .run_end(&first.id, &grant.run_id, "ok", None, 0, 0)
            .unwrap();
        f.advance(MIN_GAP_MS);
    }
    f.store.stop(&first.id).unwrap();
    let second = f.store.create(weekly_plan()).unwrap();
    assert_eq!(
        f.store.run_begin(&second.id, "start").err(),
        Some(ResponsibilityError::ChecksLimit)
    );
    // After a restart, and with the stopped one gone from the file altogether, the window holds.
    let mut doc: Value = serde_json::from_slice(&std::fs::read(f.dir.file()).unwrap()).unwrap();
    doc["items"]
        .as_array_mut()
        .unwrap()
        .retain(|r| r["id"] != json!(first.id));
    std::fs::write(f.dir.file(), serde_json::to_vec(&doc).unwrap()).unwrap();
    let reopened = f.reopen();
    assert_eq!(reopened.list().unwrap().items.len(), 1);
    assert_eq!(
        reopened.run_begin(&second.id, "start").err(),
        Some(ResponsibilityError::ChecksLimit)
    );
    // A day after the first run, one check is free again, with the AI steps that day left.
    f.set(SAT + DAY_MS);
    let grant = f.store.run_begin(&second.id, "start").unwrap();
    assert_eq!(
        (grant.checks_left, grant.ai_steps),
        (0, 6.min(MAX_AI_STEPS_PER_RUN))
    );
}

#[test]
fn a_store_written_before_the_window_existed_still_counts_its_runs() {
    let f = Fixture::new("legacy");
    let row = f.store.create(weekly_plan()).unwrap();
    for _ in 0..3 {
        let grant = f.store.run_begin(&row.id, "scheduled").unwrap();
        f.store
            .run_end(&row.id, &grant.run_id, "ok", None, 0, 0)
            .unwrap();
        f.advance(MIN_GAP_MS);
    }
    // As the store wrote it before: no `used`, no zone.
    let mut doc: Value = serde_json::from_slice(&std::fs::read(f.dir.file()).unwrap()).unwrap();
    doc.as_object_mut().unwrap().remove("used");
    doc["items"][0].as_object_mut().unwrap().remove("zone");
    std::fs::write(f.dir.file(), serde_json::to_vec(&doc).unwrap()).unwrap();
    let store = f.reopen();
    let listed = store.list().unwrap();
    assert_eq!(listed.items[0].zone, None);
    assert_eq!(
        store.run_begin(&row.id, "retry").err(),
        Some(ResponsibilityError::ChecksLimit)
    );
}

#[test]
fn ai_steps_stop_while_paused_and_only_its_own_procedure_may_spend_them() {
    let f = Fixture::new("ai-paused");
    let row = f.store.create(weekly_plan()).unwrap();
    let grant = f.store.run_begin(&row.id, "scheduled").unwrap();
    assert_eq!(f.store.take_ai_step(&grant.run_id, "room-check"), Ok(1));
    // A task of another procedure can't spend this run's grant.
    for other in ["sunday-ready", "group-night", "", "room-check "] {
        assert_eq!(
            f.store.take_ai_step(&grant.run_id, other).err(),
            Some(ResponsibilityError::Invalid),
            "{other:?}"
        );
    }
    f.store.pause_all(true).unwrap();
    assert_eq!(
        f.store.take_ai_step(&grant.run_id, "room-check").err(),
        Some(ResponsibilityError::PausedAll)
    );
    f.store.pause_all(false).unwrap();
    f.store.pause(&row.id).unwrap();
    assert_eq!(
        f.store.take_ai_step(&grant.run_id, "room-check").err(),
        Some(ResponsibilityError::Paused)
    );
    f.store.resume(&row.id).unwrap();
    assert_eq!(f.store.take_ai_step(&grant.run_id, "room-check"), Ok(2));
    // Stopped: its open run is closed, so there is nothing left to spend.
    f.store.stop(&row.id).unwrap();
    assert_eq!(
        f.store.take_ai_step(&grant.run_id, "room-check").err(),
        Some(ResponsibilityError::NoRun)
    );
    let listed = &f.store.list().unwrap().items[0];
    assert_eq!(listed.runs[0].outcome, Some(Outcome::Interrupted));
    assert_eq!(listed.runs[0].ai_steps, 2);
}

#[test]
fn a_change_brings_a_run_sooner_only_when_the_plan_watches_for_changes() {
    let f = Fixture::new("trigger");
    let weekly = f.store.create(weekly_plan()).unwrap();
    assert_eq!(
        f.store.run_begin(&weekly.id, "change").err(),
        Some(ResponsibilityError::Invalid)
    );
    let quiet = f
        .store
        .create(with(
            sunday_plan(),
            &["schedule", "on_change"],
            json!(false),
        ))
        .unwrap();
    assert_eq!(
        f.store.run_begin(&quiet.id, "change").err(),
        Some(ResponsibilityError::Invalid)
    );
    f.store.stop(&quiet.id).unwrap();
    let sunday = f.store.create(sunday_plan()).unwrap();
    assert!(f.store.run_begin(&sunday.id, "change").is_ok());
    // Every other trigger is the page saying why it asked; each is allowed.
    for trigger in ["scheduled", "catch-up", "retry", "manual", "start"] {
        assert!(Trigger::parse(trigger).is_some(), "{trigger}");
    }
}

#[test]
fn zones_are_names_this_macs_time_zone_database_has() {
    for good in [
        "UTC",
        "America/New_York",
        "America/Argentina/Buenos_Aires",
        "Etc/GMT+5",
        "Asia/Kolkata",
    ] {
        assert!(zone_ok(good), "{good}");
    }
    for bad in [
        "",
        "utc ",
        "America",
        "America/",
        "/America/New_York",
        "America/New York",
        "America/../../etc/passwd",
        "America/New_York.",
        "Avery/Brightwater",
        "America/Avery_Brightwater",
        &format!("America/{}", "A".repeat(60)),
    ] {
        assert!(!zone_ok(bad), "{bad}");
    }
}

#[test]
fn a_fast_developer_schedule_only_shortens_the_gap() {
    let dir = TempDir::new("fast");
    let store = ResponsibilityStore::open(&dir.0, true);
    assert_eq!(store.min_gap_ms, FAST_MIN_GAP_MS);
    assert_eq!(
        ResponsibilityStore::open(&dir.0, false).min_gap_ms,
        MIN_GAP_MS
    );
}

#[test]
fn dates_and_instants_are_read_exactly() {
    assert_eq!(date_ms("2026-11-15"), Some(1_794_700_800_000));
    assert_eq!(date_ms("2028-02-29").map(|ms| ms % DAY_MS), Some(0));
    for bad in [
        "2026-02-29",
        "2026-04-31",
        "2026-13-01",
        "2026-00-10",
        "2026-1-15",
        "20261115",
        "",
    ] {
        assert_eq!(date_ms(bad), None, "{bad}");
    }
    assert_eq!(instant_ms("2026-11-16T05:00:00.000Z"), Some(Date::ENDS));
    assert_eq!(rfc3339(Date::ENDS), "2026-11-16T05:00:00.000Z");
    for bad in [
        "2026-11-16T05:00:00Z",
        "2026-11-16T24:00:00.000Z",
        "2026-11-16 05:00:00.000Z",
    ] {
        assert_eq!(instant_ms(bad), None, "{bad}");
    }
    assert_eq!(Trigger::parse("catch-up"), Some(Trigger::CatchUp));
    assert_eq!(Trigger::parse("Catch-up"), None);
    assert_eq!(SAT, instant_ms("2026-11-14T15:00:00.000Z").unwrap());
    assert_eq!(MIN * 60, HOUR);
}
