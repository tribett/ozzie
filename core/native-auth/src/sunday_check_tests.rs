//! Sunday check orchestration over an injected HTTP boundary. Fictional data only.
use super::*;
use crate::{
    credentials::{CredentialStore, StoreError},
    oauth::{AuthController, AuthError, Binding, ConnectionState, Provider, Tokens},
    source::{SourceHttp, SourcePage, SourceRequest, instant, project_page},
};
use serde_json::json;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    mpsc,
};

const SECRET: &str = "fictional-native-secret-canary";
const BASE: &str = "https://api.planningcenteronline.com/services/v2";
const PLAN: &str = "https://api.planningcenteronline.com/services/v2/service_types/10/plans/20";
const STORED: &str = r#"{"client_id":"fictional-client","organization":"1001","tokens":{"access_token":"fictional-native-secret-canary","refresh_token":null,"token_type":"bearer","expires_in":7200}}"#;
/// The same connection, signed in with the opt-in operations scopes.
const STORED_OPERATIONS: &str = r#"{"client_id":"fictional-client","organization":"1001","tokens":{"access_token":"fictional-native-secret-canary","refresh_token":null,"token_type":"bearer","expires_in":7200},"scopes":"services-and-operations"}"#;

/// Holds one stored credential; deletes only when built as revocable.
struct Store {
    bytes: Mutex<Option<Vec<u8>>>,
    revocable: bool,
}
impl CredentialStore for Store {
    fn put(&self, _: &str, _: &str, _: &[u8]) -> Result<(), StoreError> {
        panic!("a Sunday check never writes credentials")
    }
    fn get(&self, _: &str, _: &str) -> Result<Option<Vec<u8>>, StoreError> {
        Ok(self.bytes.lock().unwrap().clone())
    }
    fn delete(&self, _: &str, _: &str) -> Result<(), StoreError> {
        assert!(self.revocable, "a Sunday check never deletes credentials");
        *self.bytes.lock().unwrap() = None;
        Ok(())
    }
}
/// Answers userinfo with `organization` (or fails on the `fail_on`th call) and counts calls.
struct IdentityProvider {
    organization: &'static str,
    calls: Arc<AtomicUsize>,
    fail_on: Option<usize>,
    revoked: Arc<AtomicUsize>,
}
impl Provider for IdentityProvider {
    fn organization(&self, access: &str) -> Result<String, AuthError> {
        assert_eq!(access, SECRET);
        let n = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
        if self.fail_on == Some(n) {
            return Err(AuthError::ProviderFailure);
        }
        Ok(self.organization.into())
    }
    fn exchange(&self, _: &str, _: &str, _: &str) -> Result<Tokens, AuthError> {
        panic!("no acquisition")
    }
    fn refresh(&self, _: &str, _: &str) -> Result<Tokens, AuthError> {
        panic!("no refresh")
    }
    fn revoke(&self, _: &str, token: &str, _: &str) -> Result<(), AuthError> {
        assert_eq!(token, SECRET);
        self.revoked.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}
struct Fixture {
    auth: Arc<AuthController>,
    calls: Arc<AtomicUsize>,
    revoked: Arc<AtomicUsize>,
    store: Arc<Store>,
}
fn fixture(organization: &'static str, fail_on: Option<usize>, revocable: bool) -> Fixture {
    fixture_stored(organization, fail_on, revocable, STORED)
}
fn fixture_stored(
    organization: &'static str,
    fail_on: Option<usize>,
    revocable: bool,
    stored: &str,
) -> Fixture {
    let calls = Arc::new(AtomicUsize::new(0));
    let revoked = Arc::new(AtomicUsize::new(0));
    let store = Arc::new(Store {
        bytes: Mutex::new(Some(stored.as_bytes().to_vec())),
        revocable,
    });
    let auth = AuthController::new(
        Binding {
            workspace: "local:1001".into(),
            organization: "1001".into(),
            client_id: "fictional-client".into(),
        },
        store.clone(),
        Arc::new(IdentityProvider {
            organization,
            calls: calls.clone(),
            fail_on,
            revoked: revoked.clone(),
        }),
        Arc::new(|| 0),
    )
    .unwrap();
    Fixture {
        auth: Arc::new(auth),
        calls,
        revoked,
        store,
    }
}
fn controller() -> Arc<AuthController> {
    fixture("1001", None, false).auth
}
/// A controller whose saved connection consented to the operations scopes.
fn granted() -> Arc<AuthController> {
    fixture_stored("1001", None, false, STORED_OPERATIONS).auth
}

/// Scripted provider: URL -> queued answers, then a fixed answer; unscripted list URLs
/// answer an empty page. Optionally fails every person-scoped read with one error.
#[derive(Default)]
struct Script {
    pages: BTreeMap<String, Result<Value, SourceError>>,
    queued: Mutex<BTreeMap<String, Vec<Result<Value, SourceError>>>>,
    people: Option<SourceError>,
    /// Fails every URL starting with one of these prefixes (e.g. a product without a scope).
    fail_prefix: Vec<(String, SourceError)>,
    headers: BTreeMap<String, String>,
    seen: Mutex<Vec<String>>,
    cancel_after: Option<(usize, Arc<AuthController>)>,
}
impl Script {
    fn page(mut self, url: String, raw: Value) -> Self {
        self.pages.insert(url, Ok(raw));
        self
    }
    fn fail(mut self, url: String, error: SourceError) -> Self {
        self.pages.insert(url, Err(error));
        self
    }
    fn queue(self, url: String, answers: Vec<Result<Value, SourceError>>) -> Self {
        self.queued.lock().unwrap().insert(url, answers);
        self
    }
    fn seen(&self) -> Vec<String> {
        self.seen.lock().unwrap().clone()
    }
}
impl SourceHttp for Script {
    fn read(&self, request: &SourceRequest, access: &str) -> Result<SourcePage, SourceError> {
        assert_eq!(access, SECRET);
        let url = request.url();
        let count = {
            let mut seen = self.seen.lock().unwrap();
            seen.push(url.clone());
            seen.len()
        };
        if let Some((after, auth)) = &self.cancel_after
            && count >= *after
        {
            auth.cancel();
        }
        if let Some(error) = self.people
            && url.contains("/people/")
        {
            return Err(error);
        }
        if let Some((_, error)) = self.fail_prefix.iter().find(|(p, _)| url.starts_with(p)) {
            return Err(*error);
        }
        let queued = self
            .queued
            .lock()
            .unwrap()
            .get_mut(&url)
            .filter(|answers| !answers.is_empty())
            .map(|answers| answers.remove(0));
        let raw = match queued.or_else(|| self.pages.get(&url).cloned()) {
            Some(Ok(raw)) => raw,
            Some(Err(error)) => return Err(error),
            None => json!({"data":[]}),
        };
        project_page(request, &serde_json::to_vec(&raw).unwrap(), &self.headers)
    }
}

struct FakeClock {
    wall: AtomicU64,
    elapsed: AtomicU64,
    step: u64,
    sleeps: Mutex<Vec<u64>>,
    /// Simulates a disconnect arriving while the check waits.
    cancel_on_sleep: Option<Arc<AuthController>>,
}
impl FakeClock {
    fn new() -> Self {
        Self::stepping(1)
    }
    fn stepping(step: u64) -> Self {
        Self {
            // 2026-11-13T12:00:00.000Z
            wall: AtomicU64::new(1_794_571_200_000),
            elapsed: AtomicU64::new(0),
            step,
            sleeps: Mutex::new(Vec::new()),
            cancel_on_sleep: None,
        }
    }
    fn sleeps(&self) -> Vec<u64> {
        self.sleeps.lock().unwrap().clone()
    }
}
impl Clock for FakeClock {
    fn now_ms(&self) -> u64 {
        self.wall.load(Ordering::SeqCst)
    }
    fn elapsed_ms(&self) -> u64 {
        // Every budget check is one more unit of fictional work.
        self.elapsed.fetch_add(self.step, Ordering::SeqCst)
    }
    fn sleep_ms(&self, ms: u64, stop: &dyn Fn() -> bool) -> bool {
        self.sleeps.lock().unwrap().push(ms);
        if let Some(auth) = &self.cancel_on_sleep {
            auth.cancel();
            return stop();
        }
        self.wall.fetch_add(ms, Ordering::SeqCst);
        self.elapsed.fetch_add(ms, Ordering::SeqCst);
        stop()
    }
}

fn person_rel(id: &str) -> Value {
    json!({"data":{"id":id,"type":"Person"}})
}
fn team_rel(id: &str) -> Value {
    json!({"data":{"id":id,"type":"Team"}})
}
fn plan_page() -> Value {
    json!({"data":{"id":"20","type":"Plan","attributes":{"dates":"November 22, 2026","sort_date":"2026-11-22T09:00:00Z","title":"Fictional Sunday","series_title":null,"notes":"care-canary"}}})
}
fn schedules_url(person: &str) -> String {
    format!("{BASE}/people/{person}/schedules?filter=all&include=plan_times&per_page=100&offset=0")
}
fn unfiltered_url(person: &str) -> String {
    format!("{BASE}/people/{person}/schedules?include=plan_times&per_page=100&offset=0")
}
/// The Services Organization: the church's time zone, plus settings that must be dropped.
fn organization_page() -> Value {
    json!({"data":{"id":"1001","type":"Organization","attributes":{"time_zone":"America/New_York","name":"name-canary","owner_name":"name-canary","secret":"care-canary"},
        "links":{"self":BASE}}})
}
fn sunday() -> Script {
    Script::default()
        .page(PLAN.into(), plan_page())
        .page(BASE.into(), organization_page())
        .page(
            format!("{PLAN}/plan_times?per_page=100&offset=0"),
            json!({"data":[{"id":"60","type":"PlanTime","attributes":{"starts_at":"2026-11-22T09:00:00Z","ends_at":"2026-11-22T10:15:00Z","time_type":"service"}}]}),
        )
        .page(
            format!("{PLAN}/needed_positions?per_page=100&offset=0"),
            json!({"data":[{"id":"30","type":"NeededPosition","attributes":{"quantity":1,"team_position_name":"Drums"},"relationships":{"team":team_rel("70")}}]}),
        )
        .page(
            format!("{PLAN}/team_members?include=person&per_page=100&offset=0"),
            json!({"data":[{"id":"40","type":"PlanPerson","attributes":{"status":"C","team_position_name":"Keys","name":"name-canary"},"relationships":{"person":person_rel("50"),"team":team_rel("71")}}],
                "included":[{"id":"50","type":"Person","attributes":{"full_name":"Avery Fictional","email":"contact-canary@example.invalid"}}]}),
        )
        .page(
            format!("{BASE}/teams/70/person_team_position_assignments?include=person,team_position&per_page=100&offset=0"),
            json!({"data":[{"id":"80","type":"PersonTeamPositionAssignment","attributes":{"schedule_preference":"care-canary"},"relationships":{"person":person_rel("51"),"team_position":{"data":{"id":"90","type":"TeamPosition"}}}},
                           {"id":"81","type":"PersonTeamPositionAssignment","attributes":{},"relationships":{"person":person_rel("50"),"team_position":{"data":{"id":"90","type":"TeamPosition"}}}}],
                "included":[{"id":"51","type":"Person","attributes":{"full_name":"Blair Fictional","phone":"phone-canary"}},
                            {"id":"50","type":"Person","attributes":{"full_name":"Avery Fictional"}},
                            {"id":"90","type":"TeamPosition","attributes":{"name":"Drums"}}]}),
        )
        .page(
            format!("{BASE}/teams/70/team_leaders?include=people&per_page=100&offset=0"),
            json!({"data":[{"id":"85","type":"TeamLeader","attributes":{},"relationships":{"people":person_rel("52"),"team":team_rel("70")}}],
                "included":[{"id":"52","type":"Person","attributes":{"full_name":"Casey Fictional"}}]}),
        )
        .page(
            schedules_url("50"),
            json!({"data":[{"id":"95","type":"Schedule","attributes":{"status":"C","team_position_name":"Keys","sort_date":"2026-11-15T09:00:00Z","decline_reason":"care-canary"},"relationships":{"times":{"data":[{"id":"61","type":"PlanTime"}]}}}],
                "included":[{"id":"61","type":"PlanTime","attributes":{"starts_at":"2026-11-15T09:00:00Z","ends_at":"2026-11-15T10:00:00Z"}}]}),
        )
        .page(
            format!("{BASE}/people/51/blockouts?per_page=100&offset=0"),
            json!({"data":[{"id":"97","type":"Blockout","attributes":{"starts_at":"2026-11-22T05:00:00Z","ends_at":"2026-11-23T04:59:59Z","repeat_frequency":"no_repeat","reason":"care-canary"}}]}),
        )
}
fn run_with(
    auth: &AuthController,
    script: &dyn SourceHttp,
    clock: &FakeClock,
) -> Result<SundayCapture, SourceError> {
    run(
        auth,
        "10",
        "20",
        &[],
        &AtomicBool::new(false),
        script,
        clock,
    )
    .map(|(capture, _)| capture)
}
fn check(script: &Script, clock: &FakeClock) -> Result<SundayCapture, SourceError> {
    run_with(&controller(), script, clock)
}
fn reads<'a>(capture: &'a SundayCapture, collection: &str) -> Vec<&'a SundayRead> {
    capture
        .reads
        .iter()
        .filter(|r| r.collection == collection)
        .collect()
}
fn outcomes(capture: &SundayCapture, collection: &str) -> Vec<(u64, String)> {
    reads(capture, collection)
        .iter()
        .map(|r| (r.offset, r.outcome.clone()))
        .collect()
}

#[test]
fn reads_the_contract_sequence_in_order_and_keeps_names_out_of_bodies() {
    let script = sunday();
    let clock = FakeClock::new();
    let f = fixture("1001", None, false);
    let capture = run_with(&f.auth, &script, &clock).unwrap();
    let blockouts = |p: &str| format!("{BASE}/people/{p}/blockouts?per_page=100&offset=0");
    let mut expected = vec![
        PLAN.to_string(),
        format!("{PLAN}/plan_times?per_page=100&offset=0"),
        format!("{PLAN}/needed_positions?per_page=100&offset=0"),
        format!("{PLAN}/team_members?include=person&per_page=100&offset=0"),
    ];
    // Teams: needed positions first, then team members.
    for t in ["70", "71"] {
        expected.push(format!(
            "{BASE}/teams/{t}/person_team_position_assignments?include=person,team_position&per_page=100&offset=0"
        ));
        expected.push(format!(
            "{BASE}/teams/{t}/team_leaders?include=people&per_page=100&offset=0"
        ));
    }
    // People: scheduled (team_members) first, then candidates from assignments; no duplicates.
    for p in ["50", "51"] {
        expected.push(schedules_url(p));
        expected.push(blockouts(p));
    }
    // Then the church's time zone, from the Services root.
    expected.push(BASE.to_string());
    // A default (Services-only) connection makes exactly the Services requests, nothing else.
    assert_eq!(script.seen(), expected);
    // Its operations reads are still listed, unrequested: rooms, bookings, workflows, and
    // memberships for people on the plan only (50; 51 is a candidate).
    let ops: Vec<(&str, &str)> = capture.reads[expected.len()..]
        .iter()
        .map(|r| (r.collection.as_str(), r.outcome.as_str()))
        .collect();
    assert_eq!(
        ops,
        [
            ("calendar_rooms", NOT_REQUESTED),
            ("calendar_resource_bookings", NOT_REQUESTED),
            ("people_workflows", NOT_REQUESTED),
            ("groups_person_memberships", NOT_REQUESTED),
        ]
    );
    assert!(
        capture.reads[expected.len()..]
            .iter()
            .all(|r| r.body.is_none())
    );
    // One organization check for the whole check, not one per page.
    assert_eq!(f.calls.load(Ordering::SeqCst), 1);

    assert_eq!(capture.version, 1);
    assert_eq!(capture.kind, "live");
    assert_eq!(capture.organization, "1001");
    assert_eq!(capture.service_type_id, "10");
    assert_eq!(capture.plan_id, "20");
    assert_eq!(capture.started_at, "2026-11-13T12:00:00.000Z");
    assert!(instant(&json!(capture.completed_at)));
    // The team leader (52) is named in a read but is neither on the plan nor in the people set.
    assert_eq!(
        capture.names,
        BTreeMap::from([
            ("50".to_string(), "Avery Fictional".to_string()),
            ("51".to_string(), "Blair Fictional".to_string()),
        ])
    );
    assert_eq!(capture.reads.len(), expected.len() + 4);
    for read in &capture.reads[..expected.len()] {
        assert_eq!(read.outcome, "ok", "{}", read.collection);
        assert_eq!(read.offset, 0);
        assert!(instant(&json!(read.checked_at)));
        assert!(!read.fallback);
        let body = read.body.as_ref().unwrap();
        assert!(body.get("links").is_none());
        for row in body["included"].as_array().into_iter().flatten() {
            assert_ne!(row["type"], "Person");
        }
    }
    let assignments = reads(&capture, "team_position_assignments");
    assert_eq!(assignments[0].team_id.as_deref(), Some("70"));
    assert_eq!(assignments[0].person_id, None);
    assert_eq!(
        assignments[0].body.as_ref().unwrap()["included"],
        json!([{"id":"90","type":"TeamPosition","attributes":{"name":"Drums"}}])
    );
    let schedules = reads(&capture, "person_schedules");
    assert_eq!(schedules[0].person_id.as_deref(), Some("50"));
    assert_eq!(schedules[0].team_id, None);
    assert_eq!(
        schedules[0].body.as_ref().unwrap()["included"][0]["type"],
        "PlanTime"
    );
    assert_eq!(
        reads(&capture, "plan")[0].body.as_ref().unwrap()["data"]["attributes"]["title"],
        "Fictional Sunday"
    );
    // Only the time zone survives from the organization's settings.
    assert_eq!(
        reads(&capture, "organization")[0].body.as_ref().unwrap()["data"],
        json!({"id":"1001","type":"Organization","attributes":{"time_zone":"America/New_York"}})
    );

    // Names exist only in `names`; secrets and dropped facts exist nowhere.
    let reads_wire = serde_json::to_string(&capture.reads).unwrap();
    for name in ["Avery Fictional", "Blair Fictional", "Casey Fictional"] {
        assert!(!reads_wire.contains(name), "{name}");
    }
    let wire = serde_json::to_string(&capture).unwrap();
    for canary in [
        SECRET,
        "care-canary",
        "name-canary",
        "contact-canary@example.invalid",
        "phone-canary",
        "Casey Fictional",
    ] {
        assert!(!wire.contains(canary), "{canary}");
    }
    assert!(clock.sleeps().is_empty());
}

#[test]
fn the_organization_is_checked_once_and_a_failed_or_mismatched_check_reads_nothing() {
    // Regression (review r5): one identity request per check, so a userinfo blip mid-check
    // cannot turn into a fallback or a per-page failure (operations reads included).
    let f = fixture_stored("1001", Some(9), false, STORED_OPERATIONS);
    let script = sunday();
    let capture = run_with(&f.auth, &script, &FakeClock::new()).unwrap();
    assert_eq!(f.calls.load(Ordering::SeqCst), 1);
    assert!(script.seen().contains(&schedules_url("50")));
    assert!(!script.seen().contains(&unfiltered_url("50")));
    assert!(
        capture
            .reads
            .iter()
            .all(|r| r.outcome == "ok" && !r.fallback)
    );

    for (organization, fail_on, error) in [
        ("1001", Some(1), SourceError::ProviderFailure),
        ("999", None, SourceError::OrganizationUnverified),
    ] {
        let f = fixture(organization, fail_on, false);
        let script = sunday();
        assert_eq!(
            run_with(&f.auth, &script, &FakeClock::new()).err(),
            Some(error)
        );
        assert!(script.seen().is_empty());
    }
}

/// A page of `n` team_members rows starting at `offset`, all for person 50 on team 71.
fn member_rows(offset: u64, n: u64) -> Vec<Value> {
    (offset..offset + n)
        .map(|i| json!({"id":format!("{}", 1000 + i),"type":"PlanPerson","attributes":{"status":"C"},"relationships":{"person":person_rel("50"),"team":team_rel("71")}}))
        .collect()
}

#[test]
fn pages_tile_by_next_offset_and_a_third_page_with_more_is_truncated() {
    let members =
        |offset: u64| format!("{PLAN}/team_members?include=person&per_page=100&offset={offset}");
    let link =
        |offset: u64| format!("{PLAN}/team_members?include=person&offset={offset}&per_page=100");
    let full = |offset: u64| json!({"data":member_rows(offset, 100),"meta":{"total_count":350,"next":{"offset":offset + 100}},"links":{"next":link(offset + 100)}});
    let times = |offset: u64| format!("{PLAN}/plan_times?per_page=100&offset={offset}");
    let time_rows: Vec<Value> = (0..100)
        .map(|i| json!({"id":format!("{}", 600 + i),"type":"PlanTime","attributes":{"starts_at":"2026-11-22T09:00:00Z","ends_at":"2026-11-22T10:15:00Z"}}))
        .collect();
    let script = sunday()
        .page(members(0), full(0))
        .page(members(100), full(100))
        .page(members(200), full(200))
        .page(
            times(0),
            json!({"data":time_rows,"meta":{"total_count":101,"next":{"offset":100}},"links":{"next":times(100)}}),
        )
        .page(
            times(100),
            json!({"data":[{"id":"700","type":"PlanTime","attributes":{"starts_at":"2026-11-22T11:00:00Z","ends_at":"2026-11-22T12:15:00Z"}}],"meta":{"total_count":101}}),
        );
    let capture = check(&script, &FakeClock::new()).unwrap();
    assert_eq!(
        outcomes(&capture, "team_members"),
        [
            (0, "ok".into()),
            (100, "ok".into()),
            (200, "truncated".into())
        ]
    );
    assert!(!script.seen().contains(&members(300)));
    assert_eq!(
        outcomes(&capture, "plan_times"),
        [(0, "ok".into()), (100, "ok".into())]
    );
}

#[test]
fn a_next_offset_that_skips_rows_or_a_short_last_page_is_truncated_not_ok() {
    // Regression (review r2, r6): pages must tile the collection exactly.
    let times = |offset: u64| format!("{PLAN}/plan_times?per_page=100&offset={offset}");
    let one = |id: &str| json!({"id":id,"type":"PlanTime","attributes":{"starts_at":"2026-11-22T09:00:00Z","ends_at":"2026-11-22T10:15:00Z"}});
    let script = sunday()
        .page(
            times(0),
            json!({"data":[one("60")],"meta":{"count":1,"total_count":9001,"next":{"offset":9000}},"links":{"next":times(9000)}}),
        )
        .page(times(9000), json!({"data":[one("61")]}))
        .page(
            format!("{PLAN}/needed_positions?per_page=100&offset=0"),
            json!({"data":[],"meta":{"count":0,"total_count":500}}),
        );
    let capture = check(&script, &FakeClock::new()).unwrap();
    assert_eq!(outcomes(&capture, "plan_times"), [(0, "truncated".into())]);
    assert!(!script.seen().contains(&times(9000)));
    assert_eq!(
        outcomes(&capture, "needed_positions"),
        [(0, "truncated".into())]
    );
    // A last page that reaches total_count is complete.
    let script = sunday().page(
        times(0),
        json!({"data":[one("60")],"meta":{"count":1,"total_count":1}}),
    );
    let capture = check(&script, &FakeClock::new()).unwrap();
    assert_eq!(outcomes(&capture, "plan_times"), [(0, "ok".into())]);
}

#[test]
fn team_and_people_bounds_mark_the_contributing_read_truncated() {
    let needs: Vec<Value> = (1..=12)
        .map(|t| json!({"id":format!("{}", 300 + t),"type":"NeededPosition","attributes":{"quantity":1},"relationships":{"team":team_rel(&format!("{}", 700 + t))}}))
        .collect();
    let members: Vec<Value> = (1..=45)
        .map(|p| json!({"id":format!("{}", 400 + p),"type":"PlanPerson","attributes":{"status":"C"},"relationships":{"person":person_rel(&format!("{}", 500 + p)),"team":team_rel("701")}}))
        .collect();
    let script = sunday()
        .page(
            format!("{PLAN}/needed_positions?per_page=100&offset=0"),
            json!({ "data": needs }),
        )
        .page(
            format!("{PLAN}/team_members?include=person&per_page=100&offset=0"),
            json!({ "data": members }),
        );
    let capture = check(&script, &FakeClock::new()).unwrap();
    assert_eq!(reads(&capture, "needed_positions")[0].outcome, "truncated");
    assert_eq!(reads(&capture, "team_members")[0].outcome, "truncated");
    let teams: Vec<_> = reads(&capture, "team_leaders")
        .iter()
        .map(|r| r.team_id.clone().unwrap())
        .collect();
    assert_eq!(
        teams,
        (701..=710).map(|t| t.to_string()).collect::<Vec<_>>()
    );
    let people: Vec<_> = reads(&capture, "person_blockouts")
        .iter()
        .map(|r| r.person_id.clone().unwrap())
        .collect();
    assert_eq!(
        people,
        (501..=540).map(|p| p.to_string()).collect::<Vec<_>>()
    );
    assert!(
        !script
            .seen()
            .iter()
            .any(|u| u.contains("/teams/711/") || u.contains("/people/541/"))
    );
}

#[test]
fn names_are_kept_only_for_people_on_the_plan_or_whose_own_reads_were_planned() {
    // Regression (review r4): 60 candidates arrive with names; only the 40 read keep them.
    let rows: Vec<Value> = (1..=60)
        .map(|p| json!({"id":format!("{}", 800 + p),"type":"PersonTeamPositionAssignment","relationships":{"person":person_rel(&format!("{}", 600 + p)),"team_position":{"data":{"id":"90","type":"TeamPosition"}}}}))
        .collect();
    let mut included: Vec<Value> = (1..=60)
        .map(|p| json!({"id":format!("{}", 600 + p),"type":"Person","attributes":{"full_name":format!("Fictional Person {p}")}}))
        .collect();
    included.push(json!({"id":"90","type":"TeamPosition","attributes":{"name":"Drums"}}));
    let script = sunday().page(
        format!("{BASE}/teams/70/person_team_position_assignments?include=person,team_position&per_page=100&offset=0"),
        json!({"data": rows, "included": included}),
    );
    let capture = check(&script, &FakeClock::new()).unwrap();
    let planned: BTreeSet<String> = capture
        .reads
        .iter()
        .filter_map(|r| r.person_id.clone())
        .collect();
    assert_eq!(planned.len(), MAX_PEOPLE);
    // Person 50 is on the plan; the rest are the 39 candidates whose reads were planned.
    assert_eq!(
        capture.names.keys().cloned().collect::<BTreeSet<_>>(),
        planned
    );
    assert!(!capture.names.contains_key("660"));
    assert!(
        !serde_json::to_string(&capture)
            .unwrap()
            .contains("Fictional Person 60")
    );
}

#[test]
fn a_failed_read_is_recorded_and_the_rest_of_the_check_continues() {
    let script = sunday()
        .fail(
            format!("{PLAN}/plan_times?per_page=100&offset=0"),
            SourceError::ProviderFailure,
        )
        .fail(
            format!("{BASE}/teams/70/team_leaders?include=people&per_page=100&offset=0"),
            SourceError::Denied,
        )
        // A malformed page is refused whole, never partially kept.
        .page(
            format!("{BASE}/people/51/blockouts?per_page=100&offset=0"),
            json!({"data":[{"id":"97","type":"Blockout","attributes":{"starts_at":"care-canary","ends_at":"2026-11-23T04:59:59Z"}}]}),
        );
    let capture = check(&script, &FakeClock::new()).unwrap();
    let times = reads(&capture, "plan_times");
    assert_eq!(times.len(), 1);
    assert_eq!(times[0].outcome, "provider-failure");
    assert!(times[0].body.is_none());
    assert!(instant(&json!(times[0].checked_at)));
    let leaders = reads(&capture, "team_leaders");
    assert_eq!(leaders[0].team_id.as_deref(), Some("70"));
    assert_eq!(leaders[0].outcome, "denied");
    assert_eq!(leaders[1].outcome, "ok");
    let blockouts = reads(&capture, "person_blockouts");
    assert_eq!(blockouts[1].person_id.as_deref(), Some("51"));
    assert_eq!(blockouts[1].outcome, "invalid-response");
    assert!(blockouts[1].body.is_none());
    // Everything after the failures was still read.
    assert_eq!(reads(&capture, "person_schedules").len(), 2);
    assert!(
        !serde_json::to_string(&capture)
            .unwrap()
            .contains("care-canary")
    );
    assert!(!capture.names.contains_key("52"));
}

#[test]
fn only_an_explicit_refusal_of_the_all_filter_falls_back_and_only_then_says_so() {
    // Regression (review r5 / L5): 429, 5xx, transport and denial never fall back.
    let script = sunday()
        .fail(schedules_url("50"), SourceError::Rejected)
        .page(
            unfiltered_url("50"),
            json!({"data":[{"id":"96","type":"Schedule","attributes":{"status":"U","sort_date":"2026-11-29T09:00:00Z"}}]}),
        )
        .fail(schedules_url("51"), SourceError::ProviderFailure);
    let capture = check(&script, &FakeClock::new()).unwrap();
    let person = |p: &str| -> Vec<(bool, String)> {
        reads(&capture, "person_schedules")
            .iter()
            .filter(|r| r.person_id.as_deref() == Some(p))
            .map(|r| (r.fallback, r.outcome.clone()))
            .collect()
    };
    assert_eq!(
        person("50"),
        [(false, "rejected".into()), (true, "ok".into())]
    );
    assert_eq!(person("51"), [(false, "provider-failure".into())]);
    let seen = script.seen();
    assert_eq!(
        seen.iter().filter(|u| **u == unfiltered_url("50")).count(),
        1
    );
    assert!(!seen.contains(&unfiltered_url("51")));
    for error in [
        SourceError::RateLimited(Some(1)),
        SourceError::Denied,
        SourceError::Timeout,
        SourceError::InvalidResponse,
    ] {
        let script = sunday().fail(schedules_url("50"), error);
        let capture = check(&script, &FakeClock::new()).unwrap();
        assert!(!script.seen().contains(&unfiltered_url("50")), "{error:?}");
        assert!(capture.reads.iter().all(|r| !r.fallback));
    }
    let wire = serde_json::to_value(check(&sunday(), &FakeClock::new()).unwrap()).unwrap();
    assert!(
        wire["reads"]
            .as_array()
            .unwrap()
            .iter()
            .all(|r| r.get("fallback").is_none())
    );
}

#[test]
fn a_failure_storm_trips_the_breaker_and_the_rest_is_recorded_without_requests() {
    // Regression (review r1): 40 people, every person read failing, no backoff before.
    let members: Vec<Value> = (1..=40)
        .map(|p| json!({"id":format!("{}", 400 + p),"type":"PlanPerson","attributes":{"status":"C"},"relationships":{"person":person_rel(&format!("{}", 500 + p)),"team":team_rel("71")}}))
        .collect();
    let mut script = sunday().page(
        format!("{PLAN}/team_members?include=person&per_page=100&offset=0"),
        json!({ "data": members }),
    );
    script.people = Some(SourceError::ProviderFailure);
    let f = fixture("1001", None, false);
    let clock = FakeClock::new();
    let capture = run_with(&f.auth, &script, &clock).unwrap();
    let people_requests = script
        .seen()
        .iter()
        .filter(|u| u.contains("/people/"))
        .count();
    assert_eq!(people_requests, BREAKER_STRIKES);
    assert_eq!(f.calls.load(Ordering::SeqCst), 1);
    let person_reads: Vec<_> = capture
        .reads
        .iter()
        .filter(|r| r.person_id.is_some())
        .collect();
    // Every planned person read is still listed, honestly, with the tripping reason.
    assert_eq!(person_reads.len(), 2 * MAX_PEOPLE);
    assert!(
        person_reads
            .iter()
            .all(|r| r.outcome == "provider-failure" && r.body.is_none() && !r.fallback)
    );
    assert!(clock.sleeps().is_empty());
}

#[test]
fn a_rate_limited_read_waits_retry_after_once_then_records_and_storms_trip_the_breaker() {
    // One 429, then success: bounded Retry-After wait, one retry, recorded as ok.
    let script = sunday().queue(
        format!("{PLAN}/plan_times?per_page=100&offset=0"),
        vec![Err(SourceError::RateLimited(Some(7)))],
    );
    let clock = FakeClock::new();
    let capture = check(&script, &clock).unwrap();
    assert_eq!(outcomes(&capture, "plan_times"), [(0, "ok".into())]);
    assert_eq!(clock.sleeps(), [7_000]);
    // Retry-After beyond the bound, or missing, waits the bound.
    for after in [Some(600), None] {
        let script = sunday().queue(
            format!("{PLAN}/plan_times?per_page=100&offset=0"),
            vec![Err(SourceError::RateLimited(after))],
        );
        let clock = FakeClock::new();
        check(&script, &clock).unwrap();
        assert_eq!(clock.sleeps(), [MAX_WAIT_MS]);
    }
    // A 429 storm: each read waits once, retries once, records rate-limited; then the breaker.
    let mut script = sunday();
    script.people = Some(SourceError::RateLimited(Some(5)));
    let clock = FakeClock::new();
    let capture = check(&script, &clock).unwrap();
    let people_requests = script
        .seen()
        .iter()
        .filter(|u| u.contains("/people/"))
        .count();
    assert_eq!(people_requests, 2 * BREAKER_STRIKES);
    assert_eq!(clock.sleeps(), [5_000; BREAKER_STRIKES]);
    assert!(
        capture
            .reads
            .iter()
            .filter(|r| r.person_id.is_some())
            .all(|r| r.outcome == "rate-limited")
    );
}

#[test]
fn waits_end_early_when_the_check_is_cancelled() {
    // A disconnect during a Retry-After wait ends the check without another request.
    let auth = controller();
    let script = sunday().queue(
        format!("{PLAN}/plan_times?per_page=100&offset=0"),
        vec![Err(SourceError::RateLimited(Some(10)))],
    );
    let clock = FakeClock {
        cancel_on_sleep: Some(auth.clone()),
        ..FakeClock::new()
    };
    assert_eq!(
        run_with(&auth, &script, &clock).err(),
        Some(SourceError::Cancelled)
    );
    assert_eq!(script.seen().len(), 2);
    // The same for a rate-header pause.
    let auth = controller();
    let mut script = sunday();
    script.headers = BTreeMap::from([
        ("x-pco-api-request-rate-limit".into(), "100".into()),
        ("x-pco-api-request-rate-count".into(), "95".into()),
    ]);
    let clock = FakeClock {
        cancel_on_sleep: Some(auth.clone()),
        ..FakeClock::new()
    };
    assert_eq!(
        run_with(&auth, &script, &clock).err(),
        Some(SourceError::Cancelled)
    );
    assert_eq!(script.seen().len(), 1);
}

#[test]
fn cancellation_aborts_the_whole_check_instead_of_returning_a_partial_capture() {
    let auth = controller();
    let script = Script {
        cancel_after: Some((3, auth.clone())),
        ..sunday()
    };
    assert_eq!(
        run_with(&auth, &script, &FakeClock::new()).err(),
        Some(SourceError::Cancelled)
    );
    assert_eq!(script.seen().len(), 3);
    let script = sunday();
    let result = run(
        &controller(),
        "10",
        "20",
        &[],
        &AtomicBool::new(true),
        &script,
        &FakeClock::new(),
    );
    assert_eq!(result.err(), Some(SourceError::Cancelled));
    assert!(script.seen().is_empty());
}

/// Blocks the first data read until released, to hold a read in flight.
struct Gate {
    inner: Script,
    entered: Mutex<Option<mpsc::Sender<()>>>,
    release: Mutex<mpsc::Receiver<()>>,
}
impl SourceHttp for Gate {
    fn read(&self, request: &SourceRequest, access: &str) -> Result<SourcePage, SourceError> {
        if let Some(entered) = self.entered.lock().unwrap().take() {
            entered.send(()).unwrap();
            self.release.lock().unwrap().recv().unwrap();
        }
        self.inner.read(request, access)
    }
}
/// Opens the gate; also on drop, so a failing assertion fails instead of deadlocking.
struct Release(mpsc::Sender<()>);
impl Release {
    fn open(&self) {
        let _ = self.0.send(());
    }
}
impl Drop for Release {
    fn drop(&mut self) {
        self.open();
    }
}
fn gate() -> (Gate, mpsc::Receiver<()>, Release) {
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let gate = Gate {
        inner: sunday(),
        entered: Mutex::new(Some(entered_tx)),
        release: Mutex::new(release_rx),
    };
    (gate, entered_rx, Release(release_tx))
}

#[test]
fn disconnect_waits_for_the_in_flight_read_then_revokes() {
    // Regression (review r7): disconnect used to fail Busy and keep the credential.
    let f = fixture("1001", None, true);
    let (gate, entered, release) = gate();
    std::thread::scope(|s| {
        // Owned here so unwinding opens the gate before the scope joins.
        let release = release;
        let check = s.spawn(|| run_with(&f.auth, &gate, &FakeClock::new()));
        entered.recv().unwrap();
        let disconnect = s.spawn(|| f.auth.disconnect_within(Duration::from_secs(5)));
        std::thread::sleep(Duration::from_millis(100));
        assert!(!disconnect.is_finished());
        assert_eq!(f.revoked.load(Ordering::SeqCst), 0);
        release.open();
        assert_eq!(
            disconnect.join().unwrap().unwrap().state,
            ConnectionState::Disconnected
        );
        assert_eq!(check.join().unwrap().err(), Some(SourceError::Cancelled));
    });
    assert_eq!(f.revoked.load(Ordering::SeqCst), 1);
    assert!(f.store.bytes.lock().unwrap().is_none());
}

#[test]
fn disconnect_that_cannot_wait_out_the_read_says_busy_and_revokes_nothing() {
    let f = fixture("1001", None, true);
    let (gate, entered, release) = gate();
    std::thread::scope(|s| {
        // Owned here so unwinding opens the gate before the scope joins.
        let release = release;
        let check = s.spawn(|| run_with(&f.auth, &gate, &FakeClock::new()));
        entered.recv().unwrap();
        assert_eq!(
            f.auth.disconnect_within(Duration::from_millis(150)).err(),
            Some(AuthError::Busy)
        );
        assert_eq!(f.revoked.load(Ordering::SeqCst), 0);
        assert!(f.store.bytes.lock().unwrap().is_some());
        release.open();
        // The disconnect still cancelled the check.
        assert_eq!(check.join().unwrap().err(), Some(SourceError::Cancelled));
    });
}

#[test]
fn an_exhausted_budget_records_each_remaining_read_as_timeout_without_requesting_it() {
    let script = sunday();
    // Each budget check costs a quarter of the budget: four reads fit. Operations scopes are
    // granted here so those reads, too, are listed as not read in time.
    let clock = FakeClock::stepping(BUDGET_MS / 4);
    let capture = run_with(&granted(), &script, &clock).unwrap();
    assert_eq!(script.seen().len(), 4);
    let outcomes: Vec<_> = capture
        .reads
        .iter()
        .map(|r| (r.collection.as_str(), r.outcome.as_str()))
        .collect();
    assert_eq!(
        outcomes[..4],
        [
            ("plan", "ok"),
            ("plan_times", "ok"),
            ("needed_positions", "ok"),
            ("team_members", "ok")
        ]
    );
    // Teams and people already known are still listed, each marked as not read in time.
    assert!(
        capture.reads[4..]
            .iter()
            .all(|r| r.outcome == "timeout" && r.body.is_none())
    );
    assert_eq!(
        capture.reads[4..]
            .iter()
            .map(|r| (
                r.collection.as_str(),
                r.team_id.as_deref(),
                r.person_id.as_deref()
            ))
            .collect::<Vec<_>>(),
        [
            ("team_position_assignments", Some("70"), None),
            ("team_leaders", Some("70"), None),
            ("team_position_assignments", Some("71"), None),
            ("team_leaders", Some("71"), None),
            ("person_schedules", None, Some("50")),
            ("person_blockouts", None, Some("50")),
            ("organization", None, None),
            ("calendar_rooms", None, None),
            ("calendar_resource_bookings", None, None),
            ("people_workflows", None, None),
            ("groups_person_memberships", None, None),
        ]
    );
}

#[test]
fn rate_headers_near_the_limit_wait_out_the_window_before_the_next_read() {
    let mut script = sunday();
    script.headers = BTreeMap::from([
        ("x-pco-api-request-rate-limit".into(), "100".into()),
        ("x-pco-api-request-rate-count".into(), "95".into()),
        ("x-pco-api-request-rate-period".into(), "20 seconds".into()),
    ]);
    let clock = FakeClock::new();
    let capture = check(&script, &clock).unwrap();
    let sleeps = clock.sleeps();
    // Every answered read near the limit waits one window; waits count against the budget.
    let answered = capture.reads.iter().filter(|r| r.outcome == "ok").count();
    assert!(answered >= 4);
    assert_eq!(sleeps.len(), answered);
    assert!(sleeps.iter().all(|&ms| ms == 20_000));
    let mut quiet = sunday();
    quiet.headers = BTreeMap::from([
        ("x-pco-api-request-rate-limit".into(), "100".into()),
        ("x-pco-api-request-rate-count".into(), "12".into()),
    ]);
    let clock = FakeClock::new();
    check(&quiet, &clock).unwrap();
    assert!(clock.sleeps().is_empty());
}

#[test]
fn invalid_service_type_or_plan_ids_are_refused_before_any_read() {
    for (st, plan) in [("07", "20"), ("10", ""), ("10", "20/../21"), ("x", "20")] {
        let f = fixture("1001", None, false);
        let script = sunday();
        let result = run(
            &f.auth,
            st,
            plan,
            &[],
            &AtomicBool::new(false),
            &script,
            &FakeClock::new(),
        );
        assert_eq!(result.err(), Some(SourceError::InvalidRequest));
        assert!(script.seen().is_empty());
        assert_eq!(f.calls.load(Ordering::SeqCst), 0);
    }
}

#[test]
fn timestamps_are_rfc3339_utc_with_milliseconds_and_round_trip() {
    assert_eq!(rfc3339(0), "1970-01-01T00:00:00.000Z");
    assert_eq!(rfc3339(951_782_400_000), "2000-02-29T00:00:00.000Z");
    assert_eq!(rfc3339(1_794_571_200_000), "2026-11-13T12:00:00.000Z");
    assert_eq!(rfc3339(1_798_761_599_999), "2026-12-31T23:59:59.999Z");
    for ms in [
        0,
        951_782_400_000,
        1_794_571_200_000,
        1_798_761_599_999,
        4_102_444_800_000,
    ] {
        assert!(instant(&json!(rfc3339(ms))));
        assert_eq!(parse_rfc3339(&rfc3339(ms)), Some(ms));
    }
    for bad in [
        "2026-11-13T12:00:00Z",
        "2026-11-13T12:00:00.000+00:00",
        "2026-13-01T00:00:00.000Z",
        "2026-02-30T00:00:00.000Z",
        "2026-11-13T25:00:00.000Z",
        "2026-11-13T12:00:00.0000",
        "+026-11-13T12:00:00.000Z",
    ] {
        assert_eq!(parse_rfc3339(bad), None, "{bad}");
    }
}

struct TempDir(std::path::PathBuf);
impl TempDir {
    fn new(label: &str) -> Self {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "ozzie-sunday-{label}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn captured_at(ms: u64) -> SundayCapture {
    let mut capture = check(&sunday(), &FakeClock::new()).unwrap();
    capture.completed_at = rfc3339(ms);
    capture
}
#[cfg(unix)]
fn mode(path: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}

#[test]
fn recordings_are_private_org_bound_files_reloaded_as_recordings_with_names_intact() {
    let root = TempDir::new("save");
    let dir = root.0.join("recordings");
    let capture = check(&sunday(), &FakeClock::new()).unwrap();
    let path_id = save_recording(&dir, &capture).unwrap();
    let completed = parse_rfc3339(&capture.completed_at).unwrap();
    assert_eq!(path_id, format!("sunday-1001-20-{completed}.json"));
    #[cfg(unix)]
    {
        assert_eq!(mode(&dir.join(&path_id)), 0o600);
        assert_eq!(mode(&dir), 0o700);
    }
    // Only finished files are listed; no partial file is left behind.
    assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
    let listed = list_recordings(&dir, "1001").unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].path_id, path_id);
    assert_eq!(listed[0].organization, "1001");
    assert_eq!(listed[0].plan_id, "20");
    assert_eq!(listed[0].completed_at, capture.completed_at);
    let loaded = load_recording(&dir, "1001", &path_id).unwrap();
    assert_eq!(loaded.kind, "recording");
    assert_eq!(loaded.completed_at, capture.completed_at);
    assert_eq!(loaded.names, capture.names);
    assert_eq!(
        serde_json::to_value(&loaded.reads).unwrap(),
        serde_json::to_value(&capture.reads).unwrap()
    );
    assert!(
        !std::fs::read_to_string(dir.join(&path_id))
            .unwrap()
            .contains(SECRET)
    );
    // A missing directory is an empty list, not an error.
    assert!(
        list_recordings(&root.0.join("absent"), "1001")
            .unwrap()
            .is_empty()
    );
}

#[test]
fn another_organizations_recordings_are_never_listed_or_loaded() {
    // Regression (review r3): recordings were not bound to an organization.
    let root = TempDir::new("org");
    let dir = root.0.join("recordings");
    let ours = save_recording(&dir, &captured_at(1_794_571_260_000)).unwrap();
    let mut other = captured_at(1_794_571_320_000);
    other.organization = "999".into();
    // Its organization read still names 1001: another organization's settings are never kept.
    assert_eq!(
        save_recording(&dir, &other).err().map(|e| e.kind()),
        Some(io::ErrorKind::InvalidData)
    );
    for read in other
        .reads
        .iter_mut()
        .filter(|r| r.collection == "organization")
    {
        read.body.as_mut().unwrap()["data"]["id"] = json!("999");
    }
    let theirs = save_recording(&dir, &other).unwrap();
    assert!(theirs.starts_with("sunday-999-20-"));
    let listed: Vec<_> = list_recordings(&dir, "1001")
        .unwrap()
        .into_iter()
        .map(|r| (r.organization, r.path_id))
        .collect();
    assert_eq!(listed, [("1001".to_string(), ours.clone())]);
    assert_eq!(
        load_recording(&dir, "1001", &theirs).err(),
        Some(RecordingError::InvalidName)
    );
    // A file named for this organization but holding another's capture is refused.
    let disguised = theirs.replace("sunday-999-", "sunday-1001-");
    std::fs::copy(dir.join(&theirs), dir.join(&disguised)).unwrap();
    assert_eq!(
        load_recording(&dir, "1001", &disguised).err(),
        Some(RecordingError::Unavailable)
    );
    for bad in ["", "01001", "1001/../999", "x"] {
        assert!(list_recordings(&dir, bad).is_err(), "{bad}");
        assert_eq!(
            load_recording(&dir, bad, &ours).err(),
            Some(RecordingError::InvalidName)
        );
    }
    // Deleting one organization's recordings leaves the other's.
    assert_eq!(delete_recordings(&dir, "1001").unwrap(), 2);
    assert!(list_recordings(&dir, "1001").unwrap().is_empty());
    assert_eq!(list_recordings(&dir, "999").unwrap().len(), 1);
    assert_eq!(
        delete_recordings(&root.0.join("absent"), "1001").unwrap(),
        0
    );
}

#[test]
fn only_the_five_newest_recordings_per_organization_and_plan_are_kept() {
    let root = TempDir::new("keep");
    let dir = root.0.join("recordings");
    // An older directory with looser permissions is tightened.
    std::fs::create_dir_all(&dir).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let base = 1_794_571_200_000;
    for i in 0..7 {
        save_recording(&dir, &captured_at(base + i * 60_000)).unwrap();
    }
    let mut plan_21 = captured_at(base);
    plan_21.plan_id = "21".into();
    // Windowed reads are bound to their plan's date, and membership reads to its people, which
    // this blanked plan no longer has.
    plan_21
        .reads
        .retain(|read| read.window.is_none() && read.groups_person_id.is_none());
    for read in &mut plan_21.reads {
        // Plan-scoped bodies are bound to their plan; keep this one free of them.
        read.body = None;
        read.outcome = "timeout".into();
    }
    save_recording(&dir, &plan_21).unwrap();
    #[cfg(unix)]
    assert_eq!(mode(&dir), 0o700);
    let listed: Vec<_> = list_recordings(&dir, "1001")
        .unwrap()
        .into_iter()
        .map(|r| (r.plan_id, r.completed_at))
        .collect();
    let mut expected: Vec<_> = (2..7)
        .rev()
        .map(|i| ("20".to_string(), rfc3339(base + i * 60_000)))
        .collect();
    expected.push(("21".into(), rfc3339(base)));
    assert_eq!(listed, expected);
}

#[test]
fn tampered_or_inconsistent_recordings_are_refused_on_load() {
    let root = TempDir::new("tamper");
    let dir = root.0.join("recordings");
    let path_id = save_recording(&dir, &captured_at(1_794_571_260_000)).unwrap();
    let original: Value =
        serde_json::from_slice(&std::fs::read(dir.join(&path_id)).unwrap()).unwrap();
    let index = |v: &Value, collection: &str| {
        v["reads"]
            .as_array()
            .unwrap()
            .iter()
            .position(|r| r["collection"] == collection)
            .unwrap()
    };
    let members = index(&original, "team_members");
    let assignments = index(&original, "team_position_assignments");
    type Tamper = Box<dyn Fn(&mut Value)>;
    let tampers: Vec<Tamper> = vec![
        Box::new(move |v| {
            v["reads"][members]["body"]["data"][0]["attributes"]["email"] =
                json!("contact-canary@example.invalid")
        }),
        Box::new(move |v| {
            v["reads"][assignments]["body"]["included"]
                .as_array_mut()
                .unwrap()
                .push(json!({"id":"51","type":"Person","attributes":{"name":"name-canary"}}))
        }),
        Box::new(move |v| v["reads"][members]["body"]["links"] = json!({"next":null})),
        Box::new(move |v| v["reads"][members]["body"] = Value::Null),
        Box::new(move |v| v["reads"][members]["outcome"] = json!("fine")),
        Box::new(move |v| v["reads"][members]["fallback"] = json!(true)),
        Box::new(move |v| v["reads"][members]["team_id"] = json!("70")),
        Box::new(move |v| v["reads"][0]["checked_at"] = json!("yesterday")),
        Box::new(|v| v["completed_at"] = json!(rfc3339(1_794_571_260_001))),
        Box::new(|v| v["plan_id"] = json!("21")),
        Box::new(|v| v["names"]["50"] = json!("x".repeat(257))),
        Box::new(|v| v["secret"] = json!("care-canary")),
        Box::new(|v| v["version"] = json!(2)),
    ];
    for (i, tamper) in tampers.iter().enumerate() {
        let mut value = original.clone();
        tamper(&mut value);
        std::fs::write(dir.join(&path_id), serde_json::to_vec(&value).unwrap()).unwrap();
        assert_eq!(
            load_recording(&dir, "1001", &path_id).err(),
            Some(RecordingError::Unavailable),
            "tamper {i}"
        );
    }
    std::fs::write(dir.join(&path_id), serde_json::to_vec(&original).unwrap()).unwrap();
    assert!(load_recording(&dir, "1001", &path_id).is_ok());
}

#[test]
fn recording_ids_are_bare_validated_file_names_without_traversal() {
    let root = TempDir::new("load");
    let dir = root.0.join("recordings");
    let good = save_recording(&dir, &captured_at(1_794_571_260_000)).unwrap();
    std::fs::write(root.0.join("sunday-1001-20-1.json"), b"{}").unwrap();
    for bad in [
        "../sunday-1001-20-1.json",
        "recordings/sunday-1001-20-1794571260000.json",
        "/etc/passwd",
        "sunday-1001-020-1.json",
        "sunday-1001-20-.json",
        "sunday-1001-20-1.json.bak",
        "sunday-1001-20-1.JSON",
        "sunday-1001-20-1x.json",
        "sunday-1001-20-1-2.json",
        "sunday-20-1794571260000.json",
        ".sunday-1001-20-1794571260000.json.partial",
        "",
    ] {
        assert_eq!(
            load_recording(&dir, "1001", bad).err(),
            Some(RecordingError::InvalidName),
            "{bad}"
        );
    }
    assert_eq!(
        load_recording(&dir, "1001", "sunday-1001-20-2.json").err(),
        Some(RecordingError::Unavailable)
    );
    // Content that is not a capture, a name whose time disagrees, or a link is not offered.
    std::fs::copy(dir.join(&good), dir.join("sunday-1001-20-5.json")).unwrap();
    std::fs::write(dir.join("sunday-1001-20-6.json"), b"{\"version\":2}").unwrap();
    std::fs::write(dir.join("notes.txt"), b"care-canary").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(dir.join(&good), dir.join("sunday-1001-20-7.json")).unwrap();
    for name in [
        "sunday-1001-20-5.json",
        "sunday-1001-20-6.json",
        "sunday-1001-20-7.json",
    ] {
        assert_eq!(
            load_recording(&dir, "1001", name).err(),
            Some(RecordingError::Unavailable),
            "{name}"
        );
    }
    // Listing reads names only: links are skipped, unreadable content is refused on load.
    let listed: Vec<_> = list_recordings(&dir, "1001")
        .unwrap()
        .into_iter()
        .map(|r| r.path_id)
        .collect();
    assert_eq!(
        listed,
        [
            good.clone(),
            "sunday-1001-20-6.json".to_string(),
            "sunday-1001-20-5.json".to_string()
        ]
    );
}

#[test]
fn the_system_clock_wakes_early_when_a_wait_is_cancelled() {
    let clock = SystemClock(Instant::now());
    let started = Instant::now();
    assert!(clock.sleep_ms(MAX_WAIT_MS, &|| true));
    let stop = AtomicBool::new(false);
    std::thread::scope(|s| {
        s.spawn(|| {
            std::thread::sleep(Duration::from_millis(150));
            stop.store(true, Ordering::SeqCst);
        });
        assert!(clock.sleep_ms(MAX_WAIT_MS, &|| stop.load(Ordering::SeqCst)));
    });
    assert!(started.elapsed() < Duration::from_secs(2));
    assert!(!clock.sleep_ms(30, &|| false));
}

// ---- v2 operations reads (contract: "v2 operations reads") ----

const API: &str = "https://api.planningcenteronline.com";
/// The plan's sort_date is 2026-11-22T09:00:00Z: the church-local Sunday widened to every UTC
/// offset ([D-1 10:00Z, D+1 12:00Z)), and to 24 hours either side of 09:00Z in case that `Z` is
/// a true UTC instant (the start moves to D-1 09:00Z).
const W0: &str = "2026-11-21T09:00:00Z";
const W1: &str = "2026-11-23T12:00:00Z";
const OPERATIONS: [&str; 9] = [
    "calendar_rooms",
    "calendar_resource_bookings",
    "calendar_conflicts",
    "people_workflows",
    "people_workflow_steps",
    "people_workflow_ready_cards",
    "people_workflow_snoozed_cards",
    "groups_person_memberships",
    "groups_group_events",
];
fn rooms_url() -> String {
    format!("{API}/calendar/v2/resources?filter=rooms&per_page=100&offset=0")
}
fn bookings_url(offset: u64) -> String {
    format!(
        "{API}/calendar/v2/resource_bookings?filter=rooms&include=event_resource_request&where[ends_at][gt]={W0}&where[starts_at][lt]={W1}&order=starts_at&per_page=100&offset={offset}"
    )
}
fn conflicts_url(event: &str) -> String {
    format!("{API}/calendar/v2/events/{event}/conflicts?per_page=100&offset=0")
}
fn workflows_url() -> String {
    format!("{API}/people/v2/workflows?per_page=100&offset=0")
}
fn steps_url(w: &str) -> String {
    format!("{API}/people/v2/workflows/{w}/steps?per_page=100&offset=0")
}
fn cards_url(w: &str, stage: &str) -> String {
    format!("{API}/people/v2/workflows/{w}/cards?where[stage]={stage}&per_page=100&offset=0")
}
fn memberships_url(p: &str) -> String {
    format!("{API}/groups/v2/people/{p}/memberships?per_page=100&offset=0")
}
fn group_events_url(g: &str) -> String {
    format!(
        "{API}/groups/v2/groups/{g}/events?where[ends_at][gt]={W0}&where[starts_at][lt]={W1}&order=starts_at&per_page=100&offset=0"
    )
}
fn org_meta(count: usize) -> Value {
    json!({"count":count,"total_count":count,"parent":{"id":"1001","type":"Organization"}})
}
/// Staged shape (fictional data in the Planning Center test organization): one room, six approved bookings on the
/// Sunday (two crossing the UTC date), one workflow step with three cards, one group meeting.
fn operations() -> Script {
    let times = [
        ("2026-11-22T14:00:00Z", "2026-11-22T16:00:00Z"),
        ("2026-11-22T15:45:00Z", "2026-11-22T16:15:00Z"),
        ("2026-11-22T18:00:00Z", "2026-11-22T19:45:00Z"),
        ("2026-11-22T21:00:00Z", "2026-11-22T21:30:00Z"),
        ("2026-11-22T23:00:00Z", "2026-11-23T00:15:00Z"),
        ("2026-11-23T01:00:00Z", "2026-11-23T01:30:00Z"),
    ];
    let bookings: Vec<Value> = times
        .iter()
        .enumerate()
        .map(|(i, (s, e))| json!({"id":format!("39{i}"),"type":"ResourceBooking","attributes":{"starts_at":s,"ends_at":e,"quantity":1,"created_at":"2026-10-23T21:13:58Z"},
            "relationships":{"event":{"data":{"id":format!("23{i}"),"type":"Event"}},"event_instance":{"data":{"id":format!("24{i}"),"type":"EventInstance"}},
                "resource":{"data":{"id":"887","type":"Resource"}},"event_resource_request":{"data":{"id":format!("37{i}"),"type":"EventResourceRequest"}}}}))
        .collect();
    let mut included: Vec<Value> = (0..times.len())
        .map(|i| json!({"id":format!("37{i}"),"type":"EventResourceRequest","attributes":{"approval_status":"A","notes":"note-canary"},
            "relationships":{"event":{"data":{"id":format!("23{i}"),"type":"Event"}},"resource":{"data":{"id":"887","type":"Resource"}},"created_by":{"data":{"id":"180","type":"Person"}}}}))
        .collect();
    included.push(json!({"id":"180","type":"Person","attributes":{"name":"Operator name-canary"}}));
    let card = |id: &str, stage: &str, due: &str, snooze: Value, assignee: Value| {
        json!({"id":id,"type":"WorkflowCard","attributes":{"stage":stage,"calculated_due_at":due,"overdue":false,"snooze_until":snooze,"completed_at":null,"removed_at":null},
            "relationships":{"assignee":{"data":assignee},"current_step":{"data":{"id":"2211","type":"WorkflowStep"}},"person":{"data":{"id":"202","type":"Person"}},"workflow":{"data":{"id":"795","type":"Workflow"}}}})
    };
    // Calendar's own records: 701 (events 230/231) open, 702 (events 232/233) won by 232.
    let conflict = |id: &str, resolved_at: Value, winner: Value| {
        json!({"id":id,"type":"Conflict","attributes":{"created_at":"2026-11-01T12:00:00Z","note":"note-canary","resolved_at":resolved_at},
            "relationships":{"resource":{"data":{"id":"887","type":"Resource"}},"winner":{"data":winner},"resolved_by":{"data":{"id":"180","type":"Person"}}}})
    };
    let open = || conflict("701", Value::Null, Value::Null);
    let won = || {
        conflict(
            "702",
            json!("2026-11-03T15:00:00Z"),
            json!({"id":"232","type":"Event"}),
        )
    };
    let event_meta = |e: &str| json!({"total_count":1,"parent":{"id":e,"type":"Event"}});
    sunday()
        .page(
            rooms_url(),
            json!({"data":[{"id":"887","type":"Resource","attributes":{"kind":"Room","name":"Sanctuary (fictional)","description":"care-canary"}}],"meta":org_meta(1)}),
        )
        .page(
            bookings_url(0),
            json!({"data":bookings,"included":included,"meta":org_meta(6)}),
        )
        .page(
            conflicts_url("230"),
            json!({"data":[open()],"meta":event_meta("230")}),
        )
        .page(
            conflicts_url("231"),
            json!({"data":[open()],"meta":event_meta("231")}),
        )
        .page(
            conflicts_url("232"),
            json!({"data":[won()],"meta":event_meta("232")}),
        )
        .page(
            conflicts_url("233"),
            json!({"data":[won()],"meta":event_meta("233")}),
        )
        .page(
            workflows_url(),
            json!({"data":[{"id":"795","type":"Workflow","attributes":{"name":"New guest follow-up (fictional)","total_cards_count":3}}],"meta":org_meta(1)}),
        )
        .page(
            steps_url("795"),
            json!({"data":[{"id":"2211","type":"WorkflowStep","attributes":{"name":"Welcome","sequence":0,"expected_response_time_in_days":3,"description":"care-canary"},"relationships":{"default_assignee":{"data":null},"workflow":{"data":{"id":"795","type":"Workflow"}}}}],
                "meta":{"total_count":1,"parent":{"id":"795","type":"Workflow"}}}),
        )
        .page(
            cards_url("795", "ready"),
            json!({"data":[card("562", "ready", "2026-10-26T21:27:40Z", Value::Null, Value::Null),
                           card("561", "ready", "2026-10-26T21:20:43Z", Value::Null, json!({"id":"180","type":"Assignee"}))],
                "meta":{"total_count":2,"parent":{"id":"795","type":"Workflow"}}}),
        )
        .page(
            cards_url("795", "snoozed"),
            json!({"data":[card("563", "snoozed", "2026-12-03T22:30:17Z", json!("2026-11-30T12:00:00Z"), Value::Null)],"meta":{"total_count":1}}),
        )
        .page(
            memberships_url("50"),
            json!({"data":[{"id":"550","type":"Membership","attributes":{"role":"member","joined_at":"2026-09-25T12:01:22Z"},"relationships":{"group":{"data":{"id":"287","type":"Group"}},"person":person_rel("50")}}],
                "included":[{"id":"50","type":"Person","attributes":{"name":"Avery name-canary"}}],
                "meta":{"total_count":1,"parent":{"id":"50","type":"Person"}}}),
        )
        .page(
            group_events_url("287"),
            json!({"data":[{"id":"581","type":"Event","attributes":{"starts_at":"2026-11-22T14:30:00Z","ends_at":"2026-11-22T15:30:00Z","canceled":false,"name":"care-canary"},"relationships":{"group":{"data":{"id":"287","type":"Group"}}}}],
                "meta":{"total_count":1,"parent":{"id":"287","type":"Group"}}}),
        )
}
fn is_operations(read: &SundayRead) -> bool {
    OPERATIONS.contains(&read.collection.as_str())
}
fn requested(script: &Script, prefix: &str) -> usize {
    script
        .seen()
        .iter()
        .filter(|u| u.starts_with(prefix))
        .count()
}
/// A check by a connection that opted in to the operations scopes.
fn ops_check(script: &Script, clock: &FakeClock) -> Result<SundayCapture, SourceError> {
    run_with(&granted(), script, clock)
}

#[test]
fn a_services_only_connection_never_requests_operations_and_lists_them_not_checked() {
    // The default sign-in grants Services only. Each product scope would permit writes in that
    // product, so Ozzie asks for no more by default, and never requests what was not consented.
    let script = operations();
    let capture = check(&script, &FakeClock::new()).unwrap();
    assert!(script.seen().iter().all(|u| u.starts_with(BASE)));
    let ops: Vec<&SundayRead> = capture.reads.iter().filter(|r| is_operations(r)).collect();
    assert_eq!(
        ops.iter()
            .map(|r| r.collection.as_str())
            .collect::<Vec<_>>(),
        [
            "calendar_rooms",
            "calendar_resource_bookings",
            "people_workflows",
            "groups_person_memberships",
        ]
    );
    assert!(
        ops.iter().all(|r| r.outcome == NOT_REQUESTED
            && r.body.is_none()
            && instant(&json!(r.checked_at)))
    );
    assert!(
        capture
            .reads
            .iter()
            .filter(|r| !is_operations(r))
            .all(|r| r.outcome == "ok")
    );
    // Saved and reloaded, they stay "not checked".
    let root = TempDir::new("not-requested");
    let dir = root.0.join("recordings");
    let path_id = save_recording(&dir, &capture).unwrap();
    let loaded = load_recording(&dir, "1001", &path_id).unwrap();
    assert_eq!(
        loaded
            .reads
            .iter()
            .filter(|r| r.outcome == NOT_REQUESTED)
            .count(),
        4
    );
    // Defense in depth below the check: the verified read path refuses those products too.
    let auth = controller();
    let verified = auth.verify_source(&AtomicBool::new(false)).unwrap();
    let request = SourceRequest::capture_at(
        auth.binding(),
        "10",
        "20",
        Collection::CalendarRooms,
        &Target::default(),
        100,
        0,
    )
    .unwrap();
    let script = operations();
    assert_eq!(
        auth.read_verified_using(&verified, &request, &AtomicBool::new(false), &script)
            .err(),
        Some(SourceError::InvalidRequest)
    );
    assert!(script.seen().is_empty());
}

#[test]
fn operations_reads_follow_services_reads_inside_the_plans_window_without_names() {
    let script = operations();
    let f = fixture_stored("1001", None, false, STORED_OPERATIONS);
    let capture = run_with(&f.auth, &script, &FakeClock::new()).unwrap();
    let seen = script.seen();
    let start = seen.iter().position(|u| *u == rooms_url()).unwrap();
    // Services first (13 reads for this plan, the church's time zone last), unchanged.
    assert_eq!(start, 13);
    assert_eq!(seen[start - 1], BASE);
    assert!(seen[..start].iter().all(|u| u.starts_with(BASE)));
    assert_eq!(
        seen[start..],
        [
            rooms_url(),
            bookings_url(0),
            conflicts_url("230"),
            conflicts_url("231"),
            conflicts_url("232"),
            conflicts_url("233"),
            conflicts_url("234"),
            conflicts_url("235"),
            workflows_url(),
            steps_url("795"),
            cards_url("795", "ready"),
            cards_url("795", "snoozed"),
            memberships_url("50"),
            group_events_url("287"),
        ]
    );
    assert_eq!(f.calls.load(Ordering::SeqCst), 1);
    let ops: Vec<&SundayRead> = capture.reads.iter().filter(|r| is_operations(r)).collect();
    assert_eq!(ops.len(), 14);
    // One conflicts read per booked event, in booking order; a shared id pairs two events.
    let conflicts = reads(&capture, "calendar_conflicts");
    assert_eq!(
        conflicts
            .iter()
            .map(|r| r.event_id.as_deref().unwrap())
            .collect::<Vec<_>>(),
        ["230", "231", "232", "233", "234", "235"]
    );
    let row = |i: usize| conflicts[i].body.as_ref().unwrap()["data"].clone();
    let open = json!([{"id":"701","type":"Conflict","attributes":{"resolved_at":null},
        "relationships":{"resource":{"data":{"id":"887","type":"Resource"}},"winner":{"data":null}}}]);
    assert_eq!((row(0), row(1)), (open.clone(), open));
    assert_eq!(
        row(2),
        json!([{"id":"702","type":"Conflict","attributes":{"resolved_at":"2026-11-03T15:00:00Z"},
            "relationships":{"resource":{"data":{"id":"887","type":"Resource"}},"winner":{"data":{"id":"232","type":"Event"}}}}])
    );
    assert_eq!(row(4), json!([]));
    for read in &conflicts {
        assert_eq!(
            (read.window.as_ref(), read.person_id.as_deref()),
            (None, None)
        );
    }
    for read in &ops {
        assert_eq!(read.outcome, "ok", "{}", read.collection);
        // Operations reads never borrow the Services scope keys the coverage mapper groups by.
        assert_eq!(
            (read.team_id.as_deref(), read.person_id.as_deref()),
            (None, None)
        );
        let body = read.body.as_ref().unwrap();
        assert!(body.get("links").is_none());
    }
    let window = Some(Window {
        starts_at: W0.into(),
        ends_at: W1.into(),
    });
    let bookings = reads(&capture, "calendar_resource_bookings");
    assert_eq!(bookings[0].window, window);
    let body = bookings[0].body.as_ref().unwrap();
    assert_eq!(body["data"].as_array().unwrap().len(), 6);
    assert_eq!(
        body["included"][5],
        json!({"id":"375","type":"EventResourceRequest","attributes":{"approval_status":"A"},
            "relationships":{"event":{"data":{"id":"235","type":"Event"}},"resource":{"data":{"id":"887","type":"Resource"}}}})
    );
    for c in [
        "people_workflow_steps",
        "people_workflow_ready_cards",
        "people_workflow_snoozed_cards",
    ] {
        assert_eq!(reads(&capture, c)[0].workflow_id.as_deref(), Some("795"));
    }
    let cards = reads(&capture, "people_workflow_ready_cards")[0]
        .body
        .as_ref()
        .unwrap()["data"]
        .clone();
    assert_eq!(cards[0]["relationships"]["assignee"], json!({"data":null}));
    assert_eq!(
        cards[1]["relationships"]["assignee"],
        json!({"data":{"id":"180","type":"Assignee"}})
    );
    assert!(cards[0]["relationships"].get("person").is_none());
    let memberships = reads(&capture, "groups_person_memberships");
    assert_eq!(memberships[0].groups_person_id.as_deref(), Some("50"));
    let events = reads(&capture, "groups_group_events");
    assert_eq!(events[0].group_id.as_deref(), Some("287"));
    assert_eq!(events[0].window, window);
    for read in [&capture.reads[0], reads(&capture, "calendar_rooms")[0]] {
        assert_eq!(read.window, None);
    }
    // No operations read adds a name; the operator and the members stay unnamed.
    assert_eq!(
        capture.names,
        BTreeMap::from([
            ("50".to_string(), "Avery Fictional".to_string()),
            ("51".to_string(), "Blair Fictional".to_string()),
        ])
    );
    // Room, workflow and step names are local labels, never in a body.
    assert_eq!(
        capture.labels,
        BTreeMap::from([
            ("room:887".to_string(), "Sanctuary (fictional)".to_string()),
            (
                "workflow:795".to_string(),
                "New guest follow-up (fictional)".to_string()
            ),
            ("step:2211".to_string(), "Welcome".to_string()),
        ])
    );
    let bodies = serde_json::to_string(&capture.reads).unwrap();
    for label in capture.labels.values() {
        assert!(!bodies.contains(label.as_str()), "{label}");
    }
    let wire = serde_json::to_value(&capture).unwrap();
    assert_eq!(wire["labels"]["room:887"], "Sanctuary (fictional)");
    // A Services-only capture has no labels and keeps its original shape.
    let services = check(&operations(), &FakeClock::new()).unwrap();
    assert!(services.labels.is_empty());
    assert!(
        serde_json::to_value(&services)
            .unwrap()
            .get("labels")
            .is_none()
    );
    let wire = serde_json::to_string(&capture).unwrap();
    for canary in [
        SECRET,
        "care-canary",
        "note-canary",
        "name-canary",
        "Operator",
    ] {
        assert!(!wire.contains(canary), "{canary}");
    }
}

#[test]
fn provider_denial_of_operations_products_records_denied_reads_and_keeps_services_whole() {
    let people = ["50", "53", "54", "55", "56"];
    let members: Vec<Value> = people
        .iter()
        .enumerate()
        .map(|(i, p)| json!({"id":format!("{}", 410 + i),"type":"PlanPerson","attributes":{"status":"C"},"relationships":{"person":person_rel(p),"team":team_rel("71")}}))
        .collect();
    let mut script = operations().page(
        format!("{PLAN}/team_members?include=person&per_page=100&offset=0"),
        json!({ "data": members }),
    );
    // Consented, but Planning Center still refuses those products (403: e.g. the signed-in
    // person has no Calendar, People or Groups permission, or the token lacks the scope).
    script.fail_prefix = ["calendar", "people/v2", "groups"]
        .iter()
        .map(|p| (format!("{API}/{p}/"), SourceError::Denied))
        .collect();
    let capture = ops_check(&script, &FakeClock::new()).unwrap();
    // Services is whole: every Services read answered.
    assert!(
        capture
            .reads
            .iter()
            .filter(|r| !is_operations(r))
            .all(|r| r.outcome == "ok")
    );
    assert_eq!(reads(&capture, "person_blockouts").len(), 6);
    // Each product is tried until its own breaker; one product never decides another's outcome.
    assert_eq!(requested(&script, &format!("{API}/calendar/")), 2);
    assert_eq!(requested(&script, &format!("{API}/people/v2/")), 1);
    assert_eq!(
        requested(&script, &format!("{API}/groups/")),
        BREAKER_STRIKES
    );
    let ops: Vec<&SundayRead> = capture.reads.iter().filter(|r| is_operations(r)).collect();
    assert!(
        ops.iter()
            .all(|r| r.outcome == "denied" && r.body.is_none())
    );
    assert_eq!(
        ops.iter()
            .map(|r| r.collection.as_str())
            .collect::<Vec<_>>(),
        [
            "calendar_rooms",
            "calendar_resource_bookings",
            "people_workflows",
            "groups_person_memberships",
            "groups_person_memberships",
            "groups_person_memberships",
            "groups_person_memberships",
            "groups_person_memberships",
        ]
    );
    // Every planned membership read is listed, honestly, even past the breaker.
    assert_eq!(
        reads(&capture, "groups_person_memberships")
            .iter()
            .map(|r| r.groups_person_id.clone().unwrap())
            .collect::<Vec<_>>(),
        people
    );
}

#[test]
fn a_services_denial_storm_does_not_silence_operations_reads() {
    let members: Vec<Value> = ["50", "53", "54", "55", "56"]
        .iter()
        .enumerate()
        .map(|(i, p)| json!({"id":format!("{}", 410 + i),"type":"PlanPerson","attributes":{"status":"C"},"relationships":{"person":person_rel(p),"team":team_rel("71")}}))
        .collect();
    let mut script = operations().page(
        format!("{PLAN}/team_members?include=person&per_page=100&offset=0"),
        json!({ "data": members }),
    );
    script.fail_prefix = vec![(format!("{BASE}/people/"), SourceError::Denied)];
    let capture = ops_check(&script, &FakeClock::new()).unwrap();
    // Each endpoint (schedules, blockouts) stops after its own BREAKER_STRIKES denials.
    for endpoint in ["schedules", "blockouts"] {
        assert_eq!(
            script
                .seen()
                .iter()
                .filter(|u| u.starts_with(&format!("{BASE}/people/")) && u.contains(endpoint))
                .count(),
            BREAKER_STRIKES,
            "{endpoint}"
        );
    }
    assert_eq!(
        requested(&script, &format!("{BASE}/people/")),
        2 * BREAKER_STRIKES
    );
    assert!(
        capture
            .reads
            .iter()
            .filter(|r| r.person_id.is_some())
            .all(|r| r.outcome == "denied")
    );
    assert!(
        capture
            .reads
            .iter()
            .filter(|r| is_operations(r))
            .all(|r| r.outcome == "ok")
    );
    assert!(script.seen().contains(&group_events_url("287")));
}

#[test]
fn provider_wide_failures_still_trip_one_shared_breaker() {
    // Transport, timeout, 5xx and 429 storms say nothing about one product: they stop everything.
    let mut script = operations().queue(workflows_url(), vec![Err(SourceError::ProviderFailure)]);
    script.fail_prefix = vec![(format!("{API}/calendar/"), SourceError::ProviderFailure)];
    let capture = ops_check(&script, &FakeClock::new()).unwrap();
    assert_eq!(requested(&script, &format!("{API}/calendar/")), 2);
    assert_eq!(requested(&script, &format!("{API}/people/v2/")), 1);
    assert_eq!(requested(&script, &format!("{API}/groups/")), 0);
    assert_eq!(
        reads(&capture, "groups_person_memberships")[0].outcome,
        "provider-failure"
    );
}

#[test]
fn a_plan_person_with_no_groups_profile_is_in_no_group_not_unchecked() {
    // Live, 2026-11-13: Groups answers 404 for a Services person with no Groups profile. That
    // is a complete answer (in no group), so it is an ok, empty read: no strike, no retry.
    let people = ["53", "54", "55", "50"];
    let members: Vec<Value> = people
        .iter()
        .enumerate()
        .map(|(i, p)| json!({"id":format!("{}", 410 + i),"type":"PlanPerson","attributes":{"status":"C"},"relationships":{"person":person_rel(p),"team":team_rel("71")}}))
        .collect();
    let mut script = operations().page(
        format!("{PLAN}/team_members?include=person&per_page=100&offset=0"),
        json!({ "data": members }),
    );
    for p in &people[..3] {
        script = script.fail(memberships_url(p), SourceError::NotFound);
    }
    let capture = ops_check(&script, &FakeClock::new()).unwrap();
    let memberships = reads(&capture, "groups_person_memberships");
    assert_eq!(
        memberships
            .iter()
            .map(|r| r.groups_person_id.clone().unwrap())
            .collect::<Vec<_>>(),
        people
    );
    for read in &memberships[..3] {
        assert_eq!(read.outcome, "ok");
        assert_eq!(
            read.body,
            Some(json!({"data":[],"meta":{"count":0,"total_count":0}}))
        );
    }
    // Asked once each, and three in a row trip no breaker: the next person's memberships
    // and that group's Sunday events are still read.
    for p in people {
        assert_eq!(
            script
                .seen()
                .iter()
                .filter(|u| **u == memberships_url(p))
                .count(),
            1,
            "{p}"
        );
    }
    assert_eq!(memberships[3].outcome, "ok");
    assert_eq!(
        reads(&capture, "groups_group_events")
            .iter()
            .map(|r| (r.group_id.clone().unwrap(), r.outcome.clone()))
            .collect::<Vec<_>>(),
        [("287".to_string(), "ok".to_string())]
    );
    assert!(capture.reads.iter().all(|r| r.outcome == "ok"));
    // A recording keeps them as they are, and never holds the internal reason itself.
    let root = TempDir::new("not-in-groups");
    let dir = root.0.join("recordings");
    let path_id = save_recording(&dir, &capture).unwrap();
    let loaded = load_recording(&dir, "1001", &path_id).unwrap();
    assert_eq!(
        serde_json::to_value(&loaded.reads).unwrap(),
        serde_json::to_value(&capture.reads).unwrap()
    );
    let original: Value =
        serde_json::from_slice(&std::fs::read(dir.join(&path_id)).unwrap()).unwrap();
    let index = original["reads"]
        .as_array()
        .unwrap()
        .iter()
        .position(|r| r["collection"] == "groups_person_memberships")
        .unwrap();
    let mut tampered = original.clone();
    tampered["reads"][index]["outcome"] = json!("not-found");
    tampered["reads"][index]
        .as_object_mut()
        .unwrap()
        .remove("body");
    std::fs::write(dir.join(&path_id), serde_json::to_vec(&tampered).unwrap()).unwrap();
    assert_eq!(
        load_recording(&dir, "1001", &path_id).err(),
        Some(RecordingError::Unavailable)
    );
}

#[test]
fn a_404_from_any_other_read_is_still_a_provider_failure_that_counts() {
    // Only memberships read 404 as "in no group". Anywhere else it is a failure, recorded as
    // provider-failure (never the internal not-found) and counted by the shared breaker.
    let mut script = operations()
        .fail(
            format!("{PLAN}/plan_times?per_page=100&offset=0"),
            SourceError::NotFound,
        )
        .queue(workflows_url(), vec![Err(SourceError::NotFound)]);
    script.fail_prefix = vec![(format!("{API}/calendar/"), SourceError::NotFound)];
    let capture = ops_check(&script, &FakeClock::new()).unwrap();
    for collection in [
        "plan_times",
        "calendar_rooms",
        "calendar_resource_bookings",
        "people_workflows",
    ] {
        assert_eq!(
            outcomes(&capture, collection),
            [(0, "provider-failure".into())],
            "{collection}"
        );
        assert!(reads(&capture, collection)[0].body.is_none());
    }
    // Rooms, bookings and workflows in a row: the breaker trips before Groups is asked.
    assert_eq!(requested(&script, &format!("{API}/calendar/")), 2);
    assert_eq!(requested(&script, &format!("{API}/people/v2/")), 1);
    assert_eq!(requested(&script, &format!("{API}/groups/")), 0);
    assert_eq!(
        reads(&capture, "groups_person_memberships")[0].outcome,
        "provider-failure"
    );
    assert!(capture.reads.iter().all(|r| r.outcome != "not-found"));
}

#[test]
fn operations_bounds_mark_the_contributing_read_truncated() {
    let workflows: Vec<Value> = (801..=812)
        .map(|w| json!({"id":format!("{w}"),"type":"Workflow","attributes":{"name":"Fictional"}}))
        .collect();
    let groups: Vec<Value> = (901..=925)
        .map(|g| json!({"id":format!("{}", g + 1000),"type":"Membership","attributes":{"role":"member"},"relationships":{"group":{"data":{"id":format!("{g}"),"type":"Group"}},"person":person_rel("50")}}))
        .collect();
    let page = |offset: u64| {
        let rows: Vec<Value> = (offset..offset + 100)
            .map(|i| json!({"id":format!("{}", 5000 + i),"type":"ResourceBooking","attributes":{"starts_at":"2026-11-22T14:00:00Z","ends_at":"2026-11-22T15:00:00Z"},"relationships":{"resource":{"data":{"id":"887","type":"Resource"}}}}))
            .collect();
        json!({"data":rows,"meta":{"total_count":350,"next":{"offset":offset + 100}},"links":{"next":bookings_url(offset + 100)}})
    };
    let script = operations()
        .page(workflows_url(), json!({ "data": workflows }))
        .page(memberships_url("50"), json!({ "data": groups }))
        .page(bookings_url(0), page(0))
        .page(bookings_url(100), page(100))
        .page(bookings_url(200), page(200));
    let capture = ops_check(&script, &FakeClock::new()).unwrap();
    assert_eq!(reads(&capture, "people_workflows")[0].outcome, "truncated");
    let read: Vec<String> = reads(&capture, "people_workflow_steps")
        .iter()
        .map(|r| r.workflow_id.clone().unwrap())
        .collect();
    assert_eq!(read.len(), MAX_WORKFLOWS);
    assert_eq!(read, (801..=810).map(|w| w.to_string()).collect::<Vec<_>>());
    assert!(!script.seen().iter().any(|u| u.contains("/workflows/811/")));
    assert_eq!(
        reads(&capture, "groups_person_memberships")[0].outcome,
        "truncated"
    );
    let events: Vec<String> = reads(&capture, "groups_group_events")
        .iter()
        .map(|r| r.group_id.clone().unwrap())
        .collect();
    assert_eq!(events.len(), MAX_GROUPS);
    assert!(!script.seen().iter().any(|u| u.contains("/groups/921/")));
    assert_eq!(
        outcomes(&capture, "calendar_resource_bookings"),
        [
            (0, "ok".into()),
            (100, "ok".into()),
            (200, "truncated".into())
        ]
    );
    assert!(!script.seen().contains(&bookings_url(300)));
}

#[test]
fn conflicts_are_read_for_at_most_the_bound_of_visible_booked_events() {
    // 25 bookings of 23 distinct visible events (one repeated) and one redacted stub.
    let mut rows: Vec<Value> = (0..25)
        .map(|i| {
            let event = 400 + i.min(22);
            json!({"id":format!("{}", 6000 + i),"type":"ResourceBooking","attributes":{"starts_at":"2026-11-22T14:00:00Z","ends_at":"2026-11-22T15:00:00Z"},
                "relationships":{"event":{"data":{"id":format!("{event}"),"type":"Event"}},"resource":{"data":{"id":"887","type":"Resource"}}}})
        })
        .collect();
    rows.insert(0, json!({"id":"5999","type":"ResourceBooking","attributes":{"starts_at":"2026-11-22T14:00:00Z","ends_at":"2026-11-22T15:00:00Z"},
        "relationships":{"event":{"data":{"id":"399","type":"BookedEvent"}},"resource":{"data":{"id":"887","type":"Resource"}}}}));
    let script = operations().page(bookings_url(0), json!({ "data": rows }));
    let capture = ops_check(&script, &FakeClock::new()).unwrap();
    let read: Vec<String> = reads(&capture, "calendar_conflicts")
        .iter()
        .map(|r| r.event_id.clone().unwrap())
        .collect();
    assert_eq!(
        read,
        (400..400 + MAX_CONFLICT_EVENTS)
            .map(|e| e.to_string())
            .collect::<Vec<_>>()
    );
    assert!(!script.seen().contains(&conflicts_url("399")));
    assert!(!script.seen().contains(&conflicts_url("420")));
    // The read that supplied more events than were read says so.
    assert_eq!(
        outcomes(&capture, "calendar_resource_bookings"),
        [(0, "truncated".into())]
    );
    // Without a plan date there are no bookings, so no conflicts either.
    let script = operations().fail(PLAN.into(), SourceError::ProviderFailure);
    let capture = ops_check(&script, &FakeClock::new()).unwrap();
    assert!(reads(&capture, "calendar_conflicts").is_empty());
}

#[test]
fn without_a_plan_date_no_windowed_read_is_made_and_the_rest_still_run() {
    let script = operations().fail(PLAN.into(), SourceError::ProviderFailure);
    let capture = ops_check(&script, &FakeClock::new()).unwrap();
    assert_eq!(reads(&capture, "plan")[0].outcome, "provider-failure");
    assert!(reads(&capture, "calendar_resource_bookings").is_empty());
    assert!(reads(&capture, "groups_group_events").is_empty());
    assert!(
        !script
            .seen()
            .iter()
            .any(|u| u.contains("/resource_bookings") || u.contains("/events?"))
    );
    for c in [
        "calendar_rooms",
        "people_workflows",
        "people_workflow_ready_cards",
        "groups_person_memberships",
    ] {
        assert_eq!(reads(&capture, c)[0].outcome, "ok", "{c}");
    }
}

#[test]
fn operations_windows_are_the_plan_date_widened_to_every_utc_offset() {
    // [D-1 10:00Z, D+1 12:00Z) holds local day D for every offset -12:00..+14:00. A `Z`
    // sort_date T also gets [T-24h, T+24h): if T is a true UTC instant, its local day lies there.
    let band = ("2026-11-21T10:00:00Z", "2026-11-23T12:00:00Z");
    for (sort_date, starts_at, ends_at) in [
        ("2026-11-22T09:30:00Z", "2026-11-21T09:30:00Z", band.1),
        ("2026-11-22T11:00:00Z", band.0, band.1),
        // An explicit offset already names the local date.
        ("2026-11-22T09:30:00-05:00", band.0, band.1),
        ("2026-11-22T23:59:59+14:00", band.0, band.1),
        // Sunday 09:00 at UTC+10 as a true instant: that Sunday ends at 2026-11-22T14:00Z.
        (
            "2026-11-21T23:00:00Z",
            "2026-11-20T10:00:00Z",
            "2026-11-22T23:00:00Z",
        ),
        // Saturday 18:00 at UTC-8 as a true instant: that day starts at 2026-11-21T08:00Z.
        (
            "2026-11-22T02:00:00Z",
            "2026-11-21T02:00:00Z",
            "2026-11-23T12:00:00Z",
        ),
        // Fractions round outward to whole seconds.
        ("2026-11-22T21:15:30.250Z", band.0, "2026-11-23T21:15:31Z"),
        (
            "2027-01-01T09:00:00Z",
            "2026-12-31T09:00:00Z",
            "2027-01-02T12:00:00Z",
        ),
        (
            "2028-03-01T09:00:00Z",
            "2028-02-29T09:00:00Z",
            "2028-03-02T12:00:00Z",
        ),
        // Planning Center's own spelling for a 9:30 AM Eastern service (local wall clock with a
        // `Z`, verified live 2026-11-13): FICTIONAL_WINDOW in core/src/fictional-operations.ts.
        (
            "2026-11-22T09:30:00Z",
            "2026-11-21T09:30:00Z",
            "2026-11-23T12:00:00Z",
        ),
    ] {
        let w = window_for(sort_date).unwrap();
        assert_eq!(
            (w.starts_at.as_str(), w.ends_at.as_str()),
            (starts_at, ends_at),
            "{sort_date}"
        );
    }
    assert!(window_for("next Sunday").is_none());
}

#[test]
fn recordings_keep_operations_reads_and_refuse_tampered_ones() {
    let root = TempDir::new("operations");
    let dir = root.0.join("recordings");
    let mut capture = ops_check(&operations(), &FakeClock::new()).unwrap();
    capture.completed_at = rfc3339(1_794_571_260_000);
    let path_id = save_recording(&dir, &capture).unwrap();
    let loaded = load_recording(&dir, "1001", &path_id).unwrap();
    assert_eq!(
        serde_json::to_value(&loaded.reads).unwrap(),
        serde_json::to_value(&capture.reads).unwrap()
    );
    let original: Value =
        serde_json::from_slice(&std::fs::read(dir.join(&path_id)).unwrap()).unwrap();
    let index = |collection: &str| {
        original["reads"]
            .as_array()
            .unwrap()
            .iter()
            .position(|r| r["collection"] == collection)
            .unwrap()
    };
    let (bookings, rooms, steps, ready) = (
        index("calendar_resource_bookings"),
        index("calendar_rooms"),
        index("people_workflow_steps"),
        index("people_workflow_ready_cards"),
    );
    let (memberships, events) = (
        index("groups_person_memberships"),
        index("groups_group_events"),
    );
    type Tamper = Box<dyn Fn(&mut Value)>;
    let tampers: Vec<Tamper> = vec![
        Box::new(move |v| {
            v["reads"][bookings]["window"]["starts_at"] = json!("2026-11-20T10:00:00Z")
        }),
        Box::new(move |v| {
            v["reads"][bookings]
                .as_object_mut()
                .unwrap()
                .remove("window");
        }),
        Box::new(move |v| v["reads"][rooms]["window"] = v["reads"][bookings]["window"].clone()),
        // A plan date the windows no longer follow.
        Box::new(|v| {
            v["reads"][0]["body"]["data"]["attributes"]["sort_date"] = json!("2026-11-29T09:00:00Z")
        }),
        Box::new(move |v| {
            let id = v["reads"][steps]["workflow_id"].take();
            v["reads"][steps]
                .as_object_mut()
                .unwrap()
                .remove("workflow_id");
            v["reads"][steps]["person_id"] = id;
        }),
        Box::new(move |v| v["reads"][memberships]["person_id"] = json!("50")),
        Box::new(move |v| {
            v["reads"][bookings]["body"]["included"][0]["attributes"]["notes"] =
                json!("note-canary")
        }),
        Box::new(move |v| {
            v["reads"][ready]["body"]["data"][1]["relationships"]["assignee"]["data"]["name"] =
                json!("name-canary")
        }),
        Box::new(move |v| {
            v["reads"][ready]["body"]["data"][0]["relationships"]["person"] =
                json!({"data":{"id":"202","type":"Person"}})
        }),
        Box::new(move |v| v["reads"][events]["collection"] = json!("groups_person_events")),
        Box::new(move |v| v["reads"][events]["fallback"] = json!(true)),
    ];
    for (i, tamper) in tampers.iter().enumerate() {
        let mut value = original.clone();
        tamper(&mut value);
        std::fs::write(dir.join(&path_id), serde_json::to_vec(&value).unwrap()).unwrap();
        assert_eq!(
            load_recording(&dir, "1001", &path_id).err(),
            Some(RecordingError::Unavailable),
            "tamper {i}"
        );
    }
    std::fs::write(dir.join(&path_id), serde_json::to_vec(&original).unwrap()).unwrap();
    assert!(load_recording(&dir, "1001", &path_id).is_ok());
}

#[test]
fn a_refused_card_query_trips_its_breaker_even_between_working_step_reads() {
    let workflows: Vec<Value> = (801..=810)
        .map(|w| json!({"id":format!("{w}"),"type":"Workflow","attributes":{"name":"Fictional"}}))
        .collect();
    let mut script = operations().page(workflows_url(), json!({ "data": workflows }));
    // e.g. `where[stage]` (not verified live) refused with 400 for every workflow.
    script.fail_prefix = (801..=810)
        .map(|w| {
            (
                format!("{API}/people/v2/workflows/{w}/cards"),
                SourceError::Rejected,
            )
        })
        .collect();
    let _ = ops_check(&script, &FakeClock::new()).unwrap();
    let refused = script
        .seen()
        .iter()
        .filter(|u| u.contains("/cards?"))
        .count();
    assert!(
        refused <= BREAKER_STRIKES,
        "{refused} identical refused card queries sent; interleaved step successes reset the People breaker"
    );
}
/// Saves an operations capture, applies `tamper` to the file, and reports whether it loads.
fn tamper_accepted(tamper: &dyn Fn(&mut Value)) -> bool {
    let root = TempDir::new("tamper-accepted");
    let dir = root.0.join("recordings");
    let mut capture = ops_check(&operations(), &FakeClock::new()).unwrap();
    capture.completed_at = rfc3339(1_794_571_260_000);
    let path_id = save_recording(&dir, &capture).unwrap();
    let mut value: Value =
        serde_json::from_slice(&std::fs::read(dir.join(&path_id)).unwrap()).unwrap();
    tamper(&mut value);
    std::fs::write(dir.join(&path_id), serde_json::to_vec(&value).unwrap()).unwrap();
    load_recording(&dir, "1001", &path_id).is_ok()
}
fn read_index(v: &Value, collection: &str) -> usize {
    v["reads"]
        .as_array()
        .unwrap()
        .iter()
        .position(|r| r["collection"] == collection)
        .unwrap()
}
#[test]
fn a_recording_cannot_move_group_events_to_a_group_no_membership_names() {
    assert!(
        !tamper_accepted(&|v| {
            let i = read_index(v, "groups_group_events");
            v["reads"][i]["group_id"] = json!("288");
        }),
        "group events relabeled to group 288 (rows still say 287, no membership names 288) accepted"
    );
}
#[test]
fn a_recording_cannot_move_steps_to_a_workflow_never_listed() {
    assert!(
        !tamper_accepted(&|v| {
            let i = read_index(v, "people_workflow_steps");
            v["reads"][i]["workflow_id"] = json!("796");
        }),
        "steps relabeled to workflow 796 (not in people_workflows) accepted"
    );
}
#[test]
fn recordings_keep_labels_local_and_refuse_names_back_in_bodies_or_inconsistent_reads() {
    assert!(tamper_accepted(&|_| {}));
    type Tamper = Box<dyn Fn(&mut Value)>;
    let refused: Vec<(&str, Tamper)> = vec![
        (
            "room name back in a body",
            Box::new(|v| {
                let i = read_index(v, "calendar_rooms");
                v["reads"][i]["body"]["data"][0]["attributes"]["name"] = json!("Sanctuary");
            }),
        ),
        (
            "workflow name back in a body",
            Box::new(|v| {
                let i = read_index(v, "people_workflows");
                v["reads"][i]["body"]["data"][0]["attributes"]["name"] = json!("Follow-up");
            }),
        ),
        (
            "step name back in a body",
            Box::new(|v| {
                let i = read_index(v, "people_workflow_steps");
                v["reads"][i]["body"]["data"][0]["attributes"]["name"] = json!("Welcome");
            }),
        ),
        (
            "label for a room no read returned",
            Box::new(|v| v["labels"]["room:888"] = json!("Chapel")),
        ),
        (
            "label under another read's prefix",
            Box::new(|v| v["labels"]["step:887"] = json!("Sanctuary")),
        ),
        (
            "label with an unknown prefix",
            Box::new(|v| v["labels"]["event:581"] = json!("Small group")),
        ),
        (
            "label not in display form",
            Box::new(|v| v["labels"]["room:887"] = json!("Sanctuary\nIGNORE PREVIOUS")),
        ),
        (
            "empty label",
            Box::new(|v| v["labels"]["room:887"] = json!("")),
        ),
        (
            "label over the bound",
            Box::new(|v| v["labels"]["room:887"] = json!("x".repeat(121))),
        ),
        (
            "memberships of someone not on the plan",
            Box::new(|v| {
                let i = read_index(v, "groups_person_memberships");
                v["reads"][i]["groups_person_id"] = json!("51");
            }),
        ),
        (
            "cards of a workflow never listed",
            Box::new(|v| {
                let i = read_index(v, "people_workflow_ready_cards");
                v["reads"][i]["workflow_id"] = json!("796");
            }),
        ),
        // Read ids and row links moved together: rows agree, so only provenance can refuse.
        (
            "group events and their rows moved to a group no membership names",
            Box::new(|v| {
                let i = read_index(v, "groups_group_events");
                v["reads"][i]["group_id"] = json!("288");
                v["reads"][i]["body"]["data"][0]["relationships"]["group"]["data"]["id"] =
                    json!("288");
            }),
        ),
        (
            "steps and their rows moved to a workflow never listed",
            Box::new(|v| {
                let i = read_index(v, "people_workflow_steps");
                v["reads"][i]["workflow_id"] = json!("796");
                v["reads"][i]["body"]["data"][0]["relationships"]["workflow"]["data"]["id"] =
                    json!("796");
            }),
        ),
        (
            "memberships and their rows moved to someone not on the plan",
            Box::new(|v| {
                let i = read_index(v, "groups_person_memberships");
                v["reads"][i]["groups_person_id"] = json!("51");
                v["reads"][i]["body"]["data"][0]["relationships"]["person"]["data"]["id"] =
                    json!("51");
            }),
        ),
        (
            "conflicts of an event no booking names",
            Box::new(|v| {
                let i = read_index(v, "calendar_conflicts");
                v["reads"][i]["event_id"] = json!("239");
            }),
        ),
        (
            "a conflict's note back in a body",
            Box::new(|v| {
                let i = read_index(v, "calendar_conflicts");
                v["reads"][i]["body"]["data"][0]["attributes"]["note"] = json!("note-canary");
            }),
        ),
        (
            "a conflict's resolver back in a body",
            Box::new(|v| {
                let i = read_index(v, "calendar_conflicts");
                v["reads"][i]["body"]["data"][0]["relationships"]["resolved_by"] =
                    json!({"data":{"id":"180","type":"Person"}});
            }),
        ),
        (
            "one operations read not-requested among answered ones",
            Box::new(|v| {
                let i = read_index(v, "calendar_rooms");
                v["reads"][i]["outcome"] = json!("not-requested");
                v["reads"][i].as_object_mut().unwrap().remove("body");
                v.as_object_mut().unwrap().remove("labels");
            }),
        ),
    ];
    for (what, tamper) in &refused {
        assert!(!tamper_accepted(tamper.as_ref()), "{what}");
    }
    // Older recordings have no `labels` at all; dropping them leaves a loadable recording.
    assert!(tamper_accepted(&|v| {
        v.as_object_mut().unwrap().remove("labels");
    }));
}
#[test]
fn a_recording_cannot_mark_a_services_read_not_requested() {
    assert!(
        !tamper_accepted(&|v| {
            let i = read_index(v, "team_leaders");
            v["reads"][i]["outcome"] = json!("not-requested");
            v["reads"][i].as_object_mut().unwrap().remove("body");
        }),
        "a Services read recorded not-requested accepted"
    );
}
#[test]
fn the_window_covers_the_local_sunday_if_sort_date_is_a_true_utc_instant() {
    // Sunday 09:00 at UTC+10 is Saturday 23:00Z. Local Sunday = [Sat 14:00Z, Sun 14:00Z).
    let w = window_for("2026-11-21T23:00:00Z").unwrap();
    assert!(
        w.ends_at.as_str() >= "2026-11-22T14:00:00Z",
        "window {}..{} ends before the local Sunday does",
        w.starts_at,
        w.ends_at
    );
}

#[test]
fn names_pruned_from_the_capture_are_still_refused_by_the_model_guard() {
    use crate::{
        model::{DraftRequest, ModelError, NOTE_PREFIX, REWORDINGS, SYSTEM, check_draft},
        name_guard::NameGuard,
    };
    // A leader on no position (52) and candidates past MAX_PEOPLE are read, then pruned.
    let rows: Vec<Value> = (1..=60)
        .map(|p| json!({"id":format!("{}", 800 + p),"type":"PersonTeamPositionAssignment","relationships":{"person":person_rel(&format!("{}", 600 + p)),"team_position":{"data":{"id":"90","type":"TeamPosition"}}}}))
        .collect();
    let included: Vec<Value> = (1..=60)
        .map(|p| json!({"id":format!("{}", 600 + p),"type":"Person","attributes":{"full_name":format!("Pruned{p} Fictional")}}))
        .collect();
    let script = sunday().page(
        format!("{BASE}/teams/70/person_team_position_assignments?include=person,team_position&per_page=100&offset=0"),
        json!({"data": rows, "included": included}),
    );
    let (capture, read) = run(
        &controller(),
        "10",
        "20",
        &[],
        &AtomicBool::new(false),
        &script,
        &FakeClock::new(),
    )
    .unwrap();
    assert!(!capture.names.contains_key("52"));
    assert!(!capture.names.contains_key("660"));
    let wire = serde_json::to_string(&capture).unwrap();
    assert!(!wire.contains("Casey") && !wire.contains("Pruned60"));
    let note = |name: &str| DraftRequest {
        system: SYSTEM.into(),
        user: format!(
            "{}{NOTE_PREFIX}Hi [Volunteer A],\n\n{name} said you might help with [Role] on Sunday. Would you?\n\nThanks,\n[Your name]",
            REWORDINGS[0]
        ),
        max_tokens: 120,
    };
    // What the app's session guard held before: only the capture's (pruned) names.
    let mut shown = NameGuard::default();
    shown.remember(capture.names.values());
    assert_eq!(check_draft(&note("Casey"), &shown), Ok(()));
    // With every name the check read, the pruned ones are refused too.
    let mut guard = shown.clone();
    guard.remember(read.iter());
    for name in ["Casey", "Pruned60", "Pruned1", "Avery"] {
        assert_eq!(
            check_draft(&note(name), &guard),
            Err(ModelError::NamePresent),
            "{name}"
        );
    }
    assert_eq!(check_draft(&note("the team"), &guard), Ok(()));
    // The Ask route checks the same session guard (whole words).
    let question = |text: &str| crate::model::AskRequest {
        system: crate::model::ASK_SYSTEM.into(),
        user: format!(
            "S | X | 2026-11-20 10:00 | 26 | 0\nD | 2026-11-22{}{text}",
            crate::model::QUESTION_PREFIX
        ),
        max_tokens: 600,
    };
    let ask = |text: &str, names: &NameGuard| crate::model::check_ask(&question(text), names);
    assert_eq!(ask("Can Casey cover the greeters?", &shown), Ok(()));
    for text in [
        "Can Casey cover the greeters?",
        "Is Pruned60 Fictional free?",
    ] {
        assert_eq!(ask(text, &guard), Err(ModelError::NamePresent), "{text}");
    }
    assert_eq!(ask("Who is still needed?", &guard), Ok(()));
    let read: BTreeSet<&str> = read.iter().map(String::as_str).collect();
    assert!(read.contains("Casey Fictional") && read.contains("Pruned60 Fictional"));
    // Operations reads add no names, to the capture or to the guard.
    let (_, ops) = run(
        &granted(),
        "10",
        "20",
        &[],
        &AtomicBool::new(false),
        &operations(),
        &FakeClock::new(),
    )
    .unwrap();
    assert!(!ops.iter().any(|n| n.contains("name-canary")));
}

// ---- People background checks (kids rule) ------------------------------------------------------

fn background_url(person: &str) -> String {
    format!(
        "{API}/people/v2/people/{person}/background_checks?filter=complete_clear&per_page=100&offset=0"
    )
}
/// The `sunday()` plan's only scheduled person is 50 (Keys, team 71). Two more on team 71: 53
/// pending and 54 declined; 51 is a candidate on team 70 who isn't on the plan.
fn kids_sunday() -> Script {
    operations()
        .page(
            format!("{PLAN}/team_members?include=person&per_page=100&offset=0"),
            json!({"data":[
                {"id":"40","type":"PlanPerson","attributes":{"status":"C","team_position_name":"Keys"},"relationships":{"person":person_rel("50"),"team":team_rel("71")}},
                {"id":"41","type":"PlanPerson","attributes":{"status":"U","team_position_name":"Keys"},"relationships":{"person":person_rel("53"),"team":team_rel("71")}},
                {"id":"42","type":"PlanPerson","attributes":{"status":"D","team_position_name":"Keys"},"relationships":{"person":person_rel("54"),"team":team_rel("71")}}],
                "included":[{"id":"50","type":"Person","attributes":{"full_name":"Avery Fictional"}},
                            {"id":"53","type":"Person","attributes":{"full_name":"Dana Fictional"}},
                            {"id":"54","type":"Person","attributes":{"full_name":"Emery Fictional"}}]}),
        )
        .page(
            background_url("50"),
            json!({"data":[{"id":"901","type":"BackgroundCheck","attributes":{"completed_at":"2026-01-05T12:00:00Z","current":true,"expires_on":"2027-01-05",
                "note":"note-canary","report_url":"https://example.invalid/secret-canary","status":"complete_clear","status_updated_at":"2026-01-05T12:00:00Z"},
                "relationships":{"person":person_rel("50"),"created_by":person_rel("180")}}],
                "included":[{"id":"180","type":"Person","attributes":{"name":"Operator name-canary"}}],
                "meta":{"count":1,"total_count":1,"parent":{"id":"50","type":"Person"}}}),
        )
}
fn kids_check(
    auth: &AuthController,
    script: &Script,
    kids: &[&str],
) -> Result<SundayCapture, SourceError> {
    let kids: Vec<String> = kids.iter().map(|k| (*k).to_string()).collect();
    run(
        auth,
        "10",
        "20",
        &kids,
        &AtomicBool::new(false),
        script,
        &FakeClock::new(),
    )
    .map(|(capture, _)| capture)
}

#[test]
fn background_checks_are_read_last_and_only_for_people_scheduled_on_kids_teams() {
    let script = kids_sunday();
    let capture = kids_check(&granted(), &script, &["71"]).unwrap();
    let seen = script.seen();
    let checks: Vec<&String> = seen
        .iter()
        .filter(|u| u.contains("background_checks"))
        .collect();
    // Confirmed 50 and pending 53, in plan order; not declined 54, not candidate 51.
    assert_eq!(checks, [&background_url("50"), &background_url("53")]);
    assert_eq!(
        seen.len() - 2,
        seen.iter()
            .position(|u| *u == background_url("50"))
            .unwrap()
    );
    let reads = reads(&capture, "people_background_checks");
    assert_eq!(
        reads
            .iter()
            .map(|r| (
                r.people_person_id.as_deref(),
                r.person_id.as_deref(),
                r.outcome.as_str()
            ))
            .collect::<Vec<_>>(),
        [(Some("50"), None, "ok"), (Some("53"), None, "ok")]
    );
    assert_eq!(
        reads[0].body.as_ref().unwrap()["data"][0]["attributes"],
        json!({"status":"complete_clear","current":true,"expires_on":"2027-01-05"})
    );
    let wire = serde_json::to_string(&capture).unwrap();
    for canary in [
        "note-canary",
        "secret-canary",
        "name-canary",
        "report_url",
        "created_by",
    ] {
        assert!(!wire.contains(canary), "{canary} survived");
    }
    let bodies = serde_json::to_string(&reads.iter().map(|r| &r.body).collect::<Vec<_>>()).unwrap();
    for dropped in ["completed_at", "status_updated_at", "included"] {
        assert!(!bodies.contains(dropped), "{dropped} survived");
    }
    // No name is added for a background check: 180 (whoever entered it) is never kept.
    assert!(!capture.names.contains_key("180"));
    // A capture with background-check reads saves and reloads as it was.
    let root = TempDir::new("background");
    let dir = root.0.join("recordings");
    let path_id = save_recording(&dir, &capture).unwrap();
    let loaded = load_recording(&dir, "1001", &path_id).unwrap();
    assert_eq!(
        serde_json::to_value(&loaded.reads).unwrap(),
        serde_json::to_value(&capture.reads).unwrap()
    );
}

#[test]
fn without_a_kids_team_no_background_check_is_ever_read() {
    let script = kids_sunday();
    let capture = kids_check(&granted(), &script, &[]).unwrap();
    assert!(
        !script
            .seen()
            .iter()
            .any(|u| u.contains("background_checks"))
    );
    assert!(reads(&capture, "people_background_checks").is_empty());
    // A kids team with nobody scheduled reads nothing either.
    let script = kids_sunday();
    kids_check(&granted(), &script, &["70"]).unwrap();
    assert!(
        !script
            .seen()
            .iter()
            .any(|u| u.contains("background_checks"))
    );
}

#[test]
fn a_services_only_connection_records_background_checks_not_requested_and_asks_nothing() {
    let script = kids_sunday();
    let capture = kids_check(&controller(), &script, &["71"]).unwrap();
    assert!(script.seen().iter().all(|u| u.starts_with(BASE)));
    let reads = reads(&capture, "people_background_checks");
    assert_eq!(reads.len(), 2);
    assert!(
        reads
            .iter()
            .all(|r| r.outcome == NOT_REQUESTED && r.body.is_none())
    );
    // Consent marks every People, Calendar and Groups read alike, so it saves and reloads.
    let root = TempDir::new("background-not-requested");
    let dir = root.0.join("recordings");
    let path_id = save_recording(&dir, &capture).unwrap();
    assert!(load_recording(&dir, "1001", &path_id).is_ok());
}

#[test]
fn a_refused_background_read_is_recorded_as_refused_and_never_as_no_check() {
    let mut script = kids_sunday();
    script.fail_prefix = vec![(format!("{API}/people/v2/people/"), SourceError::Denied)];
    let capture = kids_check(&granted(), &script, &["71"]).unwrap();
    let refused = reads(&capture, "people_background_checks");
    assert!(
        refused
            .iter()
            .all(|r| r.outcome == "denied" && r.body.is_none())
    );
    // The rest of the check is whole.
    assert!(
        capture
            .reads
            .iter()
            .filter(|r| r.collection == "team_members")
            .all(|r| r.outcome == "ok")
    );
    // A page Planning Center answered with another outcome than cleared is refused whole.
    let script = kids_sunday().page(
        background_url("53"),
        json!({"data":[{"id":"902","type":"BackgroundCheck","attributes":{"status":"complete_not_clear","current":true,"expires_on":null},
            "relationships":{"person":person_rel("53")}}]}),
    );
    let capture = kids_check(&granted(), &script, &["71"]).unwrap();
    let outcomes: Vec<(Option<&str>, &str)> = reads(&capture, "people_background_checks")
        .iter()
        .map(|r| (r.people_person_id.as_deref(), r.outcome.as_str()))
        .collect();
    assert_eq!(
        outcomes,
        [(Some("50"), "ok"), (Some("53"), "invalid-response")]
    );
    assert!(
        !serde_json::to_string(&capture)
            .unwrap()
            .contains("complete_not_clear")
    );
}

#[test]
fn kids_team_ids_are_validated_before_any_read() {
    let eleven: Vec<String> = (70..81).map(|t| t.to_string()).collect();
    let eleven: Vec<&str> = eleven.iter().map(String::as_str).collect();
    for bad in [
        vec!["07"],
        vec!["x"],
        vec![""],
        vec!["71", "71"],
        vec!["71/../72"],
        eleven,
    ] {
        let script = kids_sunday();
        assert_eq!(
            kids_check(&granted(), &script, &bad).err(),
            Some(SourceError::InvalidRequest),
            "{bad:?}"
        );
        assert!(script.seen().is_empty());
    }
}

#[test]
fn recordings_refuse_background_reads_that_were_tampered_with() {
    let root = TempDir::new("background-tamper");
    let dir = root.0.join("recordings");
    let mut capture = kids_check(&granted(), &kids_sunday(), &["71"]).unwrap();
    capture.completed_at = rfc3339(1_794_571_260_000);
    let path_id = save_recording(&dir, &capture).unwrap();
    let original: Value =
        serde_json::from_slice(&std::fs::read(dir.join(&path_id)).unwrap()).unwrap();
    let at = read_index(&original, "people_background_checks");
    type Tamper = Box<dyn Fn(&mut Value)>;
    let tampers: Vec<Tamper> = vec![
        // A check's other fields or outcomes never come back in.
        Box::new(move |v| {
            v["reads"][at]["body"]["data"][0]["attributes"]["note"] = json!("note-canary")
        }),
        Box::new(move |v| {
            v["reads"][at]["body"]["data"][0]["attributes"]["status"] = json!("complete_not_clear")
        }),
        Box::new(move |v| {
            v["reads"][at]["body"]["data"][0]["relationships"]["created_by"] =
                json!({"data":{"id":"180","type":"Person"}})
        }),
        // Never someone who isn't on this plan, and never under a Services or Groups person id.
        Box::new(move |v| v["reads"][at]["people_person_id"] = json!("51")),
        Box::new(move |v| {
            let id = v["reads"][at]["people_person_id"].take();
            v["reads"][at]
                .as_object_mut()
                .unwrap()
                .remove("people_person_id");
            v["reads"][at]["person_id"] = id;
        }),
        Box::new(move |v| v["reads"][at]["groups_person_id"] = json!("50")),
        // Not requested is consent: one People read alone can't claim it.
        Box::new(move |v| {
            v["reads"][at]["outcome"] = json!(NOT_REQUESTED);
            v["reads"][at].as_object_mut().unwrap().remove("body");
        }),
    ];
    for (i, tamper) in tampers.iter().enumerate() {
        let mut value = original.clone();
        tamper(&mut value);
        std::fs::write(dir.join(&path_id), serde_json::to_vec(&value).unwrap()).unwrap();
        assert_eq!(
            load_recording(&dir, "1001", &path_id).err(),
            Some(RecordingError::Unavailable),
            "tamper {i}"
        );
    }
    std::fs::write(dir.join(&path_id), serde_json::to_vec(&original).unwrap()).unwrap();
    assert!(load_recording(&dir, "1001", &path_id).is_ok());
}

#[test]
fn background_checks_are_read_for_at_most_forty_people_and_never_mark_the_plan_truncated_for_it() {
    // 45 people confirmed on kids team 71. People reads already stop at MAX_PEOPLE (that bound marks
    // team_members truncated, as before); background checks are read for the first 40 only.
    let rows: Vec<Value> = (0..45)
        .map(|i| json!({"id":format!("{}", 4000 + i),"type":"PlanPerson","attributes":{"status":"C","team_position_name":"Keys"},
            "relationships":{"person":person_rel(&format!("{}", 600 + i)),"team":team_rel("71")}}))
        .collect();
    let script = operations().page(
        format!("{PLAN}/team_members?include=person&per_page=100&offset=0"),
        json!({"data": rows, "meta":{"count":45,"total_count":45}}),
    );
    let capture = kids_check(&granted(), &script, &["71"]).unwrap();
    let asked: Vec<String> = script
        .seen()
        .into_iter()
        .filter(|u| u.contains("background_checks"))
        .collect();
    assert_eq!(asked.len(), MAX_BACKGROUND_PEOPLE);
    assert_eq!(asked[0], background_url("600"));
    assert_eq!(asked[39], background_url("639"));
    assert_eq!(reads(&capture, "people_background_checks").len(), 40);
    assert_eq!(capture.kids_teams, ["71"]);
}

#[test]
fn a_background_404_is_a_provider_failure_never_an_empty_answer() {
    let script = kids_sunday().fail(background_url("50"), SourceError::NotFound);
    let capture = kids_check(&granted(), &script, &["71"]).unwrap();
    let outcomes: Vec<(Option<&str>, &str, bool)> = reads(&capture, "people_background_checks")
        .iter()
        .map(|r| {
            (
                r.people_person_id.as_deref(),
                r.outcome.as_str(),
                r.body.is_some(),
            )
        })
        .collect();
    assert_eq!(
        outcomes,
        [
            (Some("50"), "provider-failure", false),
            (Some("53"), "ok", true)
        ]
    );
}

#[test]
fn recordings_keep_background_reads_only_for_people_on_the_kids_teams_the_check_was_given() {
    let root = TempDir::new("background-kids-teams");
    let dir = root.0.join("recordings");
    let mut capture = kids_check(&granted(), &kids_sunday(), &["71"]).unwrap();
    capture.completed_at = rfc3339(1_794_571_260_000);
    assert_eq!(capture.kids_teams, ["71"]);
    let path_id = save_recording(&dir, &capture).unwrap();
    let original: Value =
        serde_json::from_slice(&std::fs::read(dir.join(&path_id)).unwrap()).unwrap();
    assert_eq!(original["kids_teams"], json!(["71"]));
    let at = read_index(&original, "people_background_checks");
    type Tamper = Box<dyn Fn(&mut Value)>;
    let tampers: Vec<Tamper> = vec![
        // The kids teams can't be widened, narrowed away or made up.
        Box::new(|v| v["kids_teams"] = json!(["70"])),
        Box::new(|v| {
            v.as_object_mut().unwrap().remove("kids_teams");
        }),
        Box::new(|v| v["kids_teams"] = json!(["71", "71"])),
        Box::new(|v| v["kids_teams"] = json!(["071"])),
        // Someone on the plan and on team 71 who declined is not someone whose check was read.
        Box::new(move |v| v["reads"][at]["people_person_id"] = json!("54")),
    ];
    for (i, tamper) in tampers.iter().enumerate() {
        let mut value = original.clone();
        tamper(&mut value);
        std::fs::write(dir.join(&path_id), serde_json::to_vec(&value).unwrap()).unwrap();
        assert_eq!(
            load_recording(&dir, "1001", &path_id).err(),
            Some(RecordingError::Unavailable),
            "tamper {i}"
        );
    }
    std::fs::write(dir.join(&path_id), serde_json::to_vec(&original).unwrap()).unwrap();
    assert_eq!(
        load_recording(&dir, "1001", &path_id).unwrap().kids_teams,
        ["71"]
    );
    // A check given no kids teams records none, and its recording has no kids_teams key.
    let plain = kids_check(&granted(), &kids_sunday(), &[]).unwrap();
    assert!(plain.kids_teams.is_empty());
    assert!(
        !serde_json::to_string(&plain)
            .unwrap()
            .contains("kids_teams")
    );
}
