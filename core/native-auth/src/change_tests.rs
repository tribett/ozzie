//! Adding one person to an open role, over injected HTTP boundaries for reads and the write. Fictional
//! people and ids only: Riley (50) holds Greeter on Hospitality (30) and Nursery volunteer on the
//! Nursery kids team (31); Avery (51) is already on the plan; Blair (52) is blocked out in the check;
//! Casey (53) holds Greeter but the check never read them.
use super::*;
use crate::{
    credentials::{CredentialStore, StoreError},
    oauth::{AuthError, Binding, Provider, Tokens},
    source::{SourcePage, project_page},
    sunday_check::{SundayRead, parse_rfc3339},
};
use std::{
    collections::BTreeMap,
    sync::atomic::{AtomicU64, AtomicUsize},
};

const SECRET: &str = "fictional-native-secret-canary";
const ORG: &str = "1001";
const ST: &str = "10";
const PLAN: &str = "20";
const TEAM: &str = "30";
const KIDS: &str = "31";
const GREETER: &str = "40";
const NURSERY: &str = "41";
const RILEY: &str = "50";
const AVERY: &str = "51";
const BLAIR: &str = "52";
const CASEY: &str = "53";
/// The signed-in leader, as Planning Center records who scheduled a row.
const LEADER: &str = "180";
/// The id Planning Center gives a need a delete gave back.
const NEW_NEED: &str = "42";
const STARTS: &str = "2026-11-29T14:30:00Z";
const ENDS: &str = "2026-11-29T15:30:00Z";
const SORT: &str = "2026-11-29T09:30:00Z";
/// Names that must never be in anything this module returns.
const NAMES: &[&str] = &["Riley", "Avery", "Blair", "Casey", "Name-Canary"];

fn now_ms() -> u64 {
    parse_rfc3339("2026-11-20T15:00:00.000Z").unwrap()
}

// ---- The saved sign-in --------------------------------------------------------------------------

struct Store(Vec<u8>);
impl CredentialStore for Store {
    fn put(&self, _: &str, _: &str, _: &[u8]) -> Result<(), StoreError> {
        panic!("a change never saves credentials")
    }
    fn get(&self, _: &str, _: &str) -> Result<Option<Vec<u8>>, StoreError> {
        Ok(Some(self.0.clone()))
    }
    fn delete(&self, _: &str, _: &str) -> Result<(), StoreError> {
        panic!("a change never deletes credentials")
    }
}
struct Identity(String, AtomicUsize);
impl Provider for Identity {
    fn organization(&self, access: &str) -> Result<String, AuthError> {
        assert_eq!(access, SECRET);
        self.1.fetch_add(1, Ordering::SeqCst);
        Ok(self.0.clone())
    }
    fn exchange(&self, _: &str, _: &str, _: &str) -> Result<Tokens, AuthError> {
        panic!("no sign-in is ever started from here")
    }
    fn refresh(&self, _: &str, _: &str) -> Result<Tokens, AuthError> {
        panic!("no renewal here")
    }
    fn revoke(&self, _: &str, _: &str, _: &str) -> Result<(), AuthError> {
        panic!("no revoke")
    }
}
fn controller_for(organization: &str, scopes: &str) -> (Arc<AuthController>, Arc<Identity>) {
    let stored = format!(
        r#"{{"client_id":"fictional-client","organization":"{organization}","tokens":{{"access_token":"{SECRET}","refresh_token":"fictional-refresh-canary","token_type":"bearer","expires_in":7200}},"scopes":"{scopes}"}}"#
    );
    let identity = Arc::new(Identity(organization.into(), AtomicUsize::new(0)));
    let auth = AuthController::new(
        Binding {
            workspace: format!("local:{organization}"),
            organization: organization.into(),
            client_id: "fictional-client".into(),
        },
        Arc::new(Store(stored.into_bytes())),
        identity.clone(),
        Arc::new(|| 0),
    )
    .unwrap();
    (Arc::new(auth), identity)
}
fn controller() -> Arc<AuthController> {
    controller_for(ORG, "services-and-operations").0
}

// ---- A fake Planning Center ---------------------------------------------------------------------

/// What the fake answers a write.
#[derive(Clone, Copy)]
enum Script {
    /// This status, with the new row's id when `made`; the row is added (or removed) when `apply`.
    Answer {
        status: u16,
        made: bool,
        apply: bool,
    },
    /// No answer at all; the change happened when `apply`.
    NoAnswer { apply: bool },
}
struct Fake {
    replies: Mutex<BTreeMap<&'static str, Result<Value, SourceError>>>,
    members: Mutex<Vec<Value>>,
    reads: Mutex<Vec<String>>,
    writes: Mutex<Vec<(String, String, Option<Value>)>>,
    script: Mutex<Script>,
    /// Reads of the plan's people fail once this many have answered.
    members_fail_after: Mutex<Option<usize>>,
    stall_ms: AtomicU64,
    /// How long a write takes before it answers.
    send_stall_ms: AtomicU64,
    /// A row someone else adds to the plan while the write is under way.
    on_send: Mutex<Option<Value>>,
    /// Each add's row id counts up from this, when set; otherwise every add is row "900".
    next_row: Mutex<Option<u64>>,
    /// A change Planning Center makes to the plan's rows while a write is under way.
    on_send_edit: Mutex<Option<RowsEdit>>,
}
/// A change to the fake plan's rows.
type RowsEdit = Box<dyn FnOnce(&mut Vec<Value>) + Send>;
impl Fake {
    fn new() -> Arc<Self> {
        let fake = Self {
            replies: Mutex::new(BTreeMap::new()),
            members: Mutex::new(vec![member("80", AVERY, TEAM, "C", false, false)]),
            reads: Mutex::new(Vec::new()),
            writes: Mutex::new(Vec::new()),
            script: Mutex::new(Script::Answer {
                status: 201,
                made: true,
                apply: true,
            }),
            members_fail_after: Mutex::new(None),
            stall_ms: AtomicU64::new(0),
            send_stall_ms: AtomicU64::new(0),
            on_send: Mutex::new(None),
            next_row: Mutex::new(None),
            on_send_edit: Mutex::new(None),
        };
        for (key, reply) in [
            ("plan", plan_reply()),
            ("plan_times", list(vec![plan_time("60", STARTS, ENDS)])),
            (
                "needed_positions",
                list(vec![
                    needed(GREETER, TEAM, "Greeter", 1, None),
                    needed(NURSERY, KIDS, "Nursery volunteer", 1, None),
                ]),
            ),
            ("team_position_assignments", assignments()),
            ("person_child", child_reply(json!(false))),
            ("person_blockouts", list(vec![])),
            ("person_schedules", list(vec![])),
            (
                "people_background_checks",
                list(vec![check(
                    "95",
                    "complete_clear",
                    json!(true),
                    json!("2027-10-23"),
                )]),
            ),
            ("pending_checks_awaiting_applicant", list(vec![])),
            ("pending_checks_report_processing", list(vec![])),
            ("pending_checks_needs_review", list(vec![])),
        ] {
            fake.replies.lock().unwrap().insert(key, Ok(reply));
        }
        Arc::new(fake)
    }
    fn set(&self, key: &'static str, reply: Result<Value, SourceError>) {
        self.replies.lock().unwrap().insert(key, reply);
    }
    fn script(&self, script: Script) {
        *self.script.lock().unwrap() = script;
    }
    fn reads(&self) -> Vec<String> {
        self.reads.lock().unwrap().clone()
    }
    fn writes(&self) -> Vec<(String, String, Option<Value>)> {
        self.writes.lock().unwrap().clone()
    }
    fn members_reply(&self) -> Result<Value, SourceError> {
        let mut fail = self.members_fail_after.lock().unwrap();
        if let Some(left) = fail.as_mut() {
            if *left == 0 {
                return Err(SourceError::ProviderFailure);
            }
            *left -= 1;
        }
        let rows = self.members.lock().unwrap().clone();
        // Each person once, as Planning Center includes them.
        let ids: std::collections::BTreeSet<String> = rows
            .iter()
            .filter_map(|row| row["relationships"]["person"]["data"]["id"].as_str())
            .map(str::to_owned)
            .collect();
        let people: Vec<Value> = ids
            .iter()
            .map(|id| json!({"id": id, "type": "Person", "attributes": {"full_name": "Fictional Name-Canary"}}))
            .collect();
        Ok(json!({"data": rows, "included": people, "meta": {"total_count": rows.len()}}))
    }
}
impl SourceHttp for Fake {
    fn read(&self, request: &SourceRequest, access: &str) -> Result<SourcePage, SourceError> {
        assert_eq!(access, SECRET);
        self.reads.lock().unwrap().push(request.url());
        std::thread::sleep(Duration::from_millis(self.stall_ms.load(Ordering::SeqCst)));
        let label = request.collection.label();
        let reply = if label == "team_members" {
            self.members_reply()
        } else {
            self.replies
                .lock()
                .unwrap()
                .get(label)
                .cloned()
                .unwrap_or_else(|| panic!("unexpected read {label}"))
        }?;
        project_page(
            request,
            &serde_json::to_vec(&reply).unwrap(),
            &Default::default(),
        )
    }
}
impl ChangeHttp for Fake {
    fn send(&self, write: &Write, access: &str) -> Sent {
        assert_eq!(access, SECRET);
        assert!(write.valid());
        self.writes
            .lock()
            .unwrap()
            .push((write.method().to_string(), write.url(), write.body()));
        std::thread::sleep(Duration::from_millis(
            self.send_stall_ms.load(Ordering::SeqCst),
        ));
        if let Some(row) = self.on_send.lock().unwrap().take() {
            self.members.lock().unwrap().push(row);
        }
        if let Some(edit) = self.on_send_edit.lock().unwrap().take() {
            edit(&mut self.members.lock().unwrap());
        }
        let id = match self.next_row.lock().unwrap().as_mut() {
            Some(next) if matches!(write, Write::PencilIn { .. }) => {
                *next += 1;
                (*next - 1).to_string()
            }
            _ => "900".to_owned(),
        };
        let (apply, answer) = match *self.script.lock().unwrap() {
            Script::Answer {
                status,
                made,
                apply,
            } => (
                apply,
                Ok(Answer {
                    status,
                    row: made.then(|| id.clone()),
                    scheduled_by: made.then(|| LEADER.to_owned()),
                }),
            ),
            Script::NoAnswer { apply } => (apply, Err(Unsent::NoAnswer)),
        };
        if apply {
            let mut members = self.members.lock().unwrap();
            match write {
                Write::PencilIn {
                    person,
                    team,
                    position,
                    ..
                } => {
                    members.push(member(&id, person, team, "U", true, false));
                    self.move_need(team, position, -1);
                }
                Write::Remove { row, .. } => {
                    if let Some(at) = members.iter().position(|m| m["id"] == row.as_str()) {
                        let removed = members.remove(at);
                        let team = removed["relationships"]["team"]["data"]["id"]
                            .as_str()
                            .unwrap()
                            .to_owned();
                        self.move_need(&team, "Greeter", 1);
                    }
                }
            }
        }
        answer
    }
}
impl Fake {
    /// Planning Center's needed positions after a create (one fewer, the row gone at none) or a delete
    /// (one more, under a new id), as seen live on 2026-11-17.
    fn move_need(&self, team: &str, position: &str, by: i64) {
        let mut replies = self.replies.lock().unwrap();
        let Some(Ok(reply)) = replies.get_mut("needed_positions") else {
            return;
        };
        let rows = reply["data"].as_array_mut().unwrap();
        let at = rows.iter().position(|row| {
            row["relationships"]["team"]["data"]["id"] == team
                && row["attributes"]["team_position_name"] == position
        });
        match (at, by) {
            (Some(at), -1) => {
                let left = rows[at]["attributes"]["quantity"].as_u64().unwrap() - 1;
                if left == 0 {
                    rows.remove(at);
                } else {
                    rows[at]["attributes"]["quantity"] = json!(left);
                }
            }
            (None, 1) => rows.push(needed(NEW_NEED, team, position, 1, None)),
            (Some(at), 1) => {
                let more = rows[at]["attributes"]["quantity"].as_u64().unwrap() + 1;
                rows[at]["attributes"]["quantity"] = json!(more);
            }
            _ => {}
        }
    }
}
/// One change to the fake Planning Center, for a table of cases.
type Setup = Box<dyn Fn(&Fake)>;
fn clients(fake: &Arc<Fake>) -> MakeClients {
    let fake = fake.clone();
    Box::new(move || {
        Ok((
            fake.clone() as Arc<dyn SourceHttp + Send + Sync>,
            fake as Arc<dyn ChangeHttp>,
        ))
    })
}

// ---- Fixed data -----------------------------------------------------------------------------------

fn list(rows: Vec<Value>) -> Value {
    json!({"data": rows, "meta": {"total_count": rows.len()}})
}
fn plan_reply() -> Value {
    json!({"data": {"id": PLAN, "type": "Plan",
        "attributes": {"sort_date": SORT, "dates": "November 29, 2026", "title": "Fictional Sunday"}}})
}
fn plan_time(id: &str, starts: &str, ends: &str) -> Value {
    json!({"id": id, "type": "PlanTime", "attributes": {"starts_at": starts, "ends_at": ends, "time_type": "service"}})
}
fn needed(id: &str, team: &str, position: &str, quantity: u64, time: Option<&str>) -> Value {
    let time = time.map_or(Value::Null, |t| json!({"id": t, "type": "PlanTime"}));
    json!({"id": id, "type": "NeededPosition",
        "attributes": {"quantity": quantity, "team_position_name": position},
        "relationships": {"team": {"data": {"id": team, "type": "Team"}}, "time": {"data": time}}})
}
fn member(id: &str, person: &str, team: &str, status: &str, prepared: bool, sent: bool) -> Value {
    json!({"id": id, "type": "PlanPerson",
        "attributes": {"status": status, "team_position_name": "Greeter",
            "prepare_notification": prepared,
            "notification_prepared_at": if prepared { json!("2026-11-20T15:00:05Z") } else { Value::Null },
            "notification_sent_at": if sent { json!("2026-11-20T15:10:00Z") } else { Value::Null }},
        "relationships": {"person": {"data": {"id": person, "type": "Person"}},
            "team": {"data": {"id": team, "type": "Team"}},
            "times": {"data": [{"id": "60", "type": "PlanTime"}]}}})
}
/// Riley holds Greeter and Nursery volunteer; Blair and Casey hold Greeter.
fn assignments() -> Value {
    let row = |id: &str, person: &str, position: &str| {
        json!({"id": id, "type": "PersonTeamPositionAssignment", "attributes": {},
            "relationships": {"person": {"data": {"id": person, "type": "Person"}},
                "team_position": {"data": {"id": position, "type": "TeamPosition"}}}})
    };
    json!({"data": [row("90", RILEY, "70"), row("91", RILEY, "71"), row("92", BLAIR, "70"), row("93", CASEY, "70")],
        "included": [
            {"id": "70", "type": "TeamPosition", "attributes": {"name": "Greeter"}},
            {"id": "71", "type": "TeamPosition", "attributes": {"name": "Nursery volunteer"}},
            {"id": RILEY, "type": "Person", "attributes": {"full_name": "Riley Name-Canary"}},
            {"id": BLAIR, "type": "Person", "attributes": {"full_name": "Blair Name-Canary"}},
            {"id": CASEY, "type": "Person", "attributes": {"full_name": "Casey Name-Canary"}}]})
}
fn child_reply(child: Value) -> Value {
    person_reply(child, Some(json!("active")))
}
/// The person read: `child`, and `status` when given (None leaves it out of the record).
fn person_reply(child: Value, status: Option<Value>) -> Value {
    let mut reply = json!({"data": {"id": RILEY, "type": "Person",
        "attributes": {"child": child, "name": "Riley Name-Canary", "inactivated_at": "2026-01-01T00:00:00Z"}}});
    if let Some(status) = status {
        reply["data"]["attributes"]["status"] = status;
    }
    reply
}
fn blockout(starts: &str, ends: &str, repeat: &str) -> Value {
    json!({"id": "86", "type": "Blockout",
        "attributes": {"starts_at": starts, "ends_at": ends, "repeat_frequency": repeat, "reason": "Name-Canary trip"}})
}
fn schedule(plan: &str, status: &str, time: Option<(&str, &str)>) -> Value {
    let mut reply = json!({"data": [{"id": "85", "type": "Schedule",
        "attributes": {"status": status, "sort_date": SORT, "team_position_name": "Usher"},
        "relationships": {"plan": {"data": {"id": plan, "type": "Plan"}}, "team": {"data": {"id": "32", "type": "Team"}},
            "times": {"data": [{"id": "61", "type": "PlanTime"}]}}}]});
    if let Some((starts, ends)) = time {
        reply["included"] = json!([plan_time("61", starts, ends)]);
    }
    reply
}
fn check(id: &str, status: &str, current: Value, expires: Value) -> Value {
    json!({"id": id, "type": "BackgroundCheck",
        "attributes": {"status": status, "current": current, "expires_on": expires, "note": "Name-Canary note"},
        "relationships": {"person": {"data": {"id": RILEY, "type": "Person"}}}})
}
fn pending(status: &str) -> Value {
    json!({"id": "97", "type": "BackgroundCheck", "attributes": {"status": status},
        "relationships": {"person": {"data": {"id": RILEY, "type": "Person"}}}})
}

/// A live check of the fictional Sunday, as `check_sunday` records it.
fn capture() -> SundayCapture {
    let read = |value: Value| -> SundayRead { serde_json::from_value(value).unwrap() };
    let ok = |collection: &str, body: Value| {
        read(
            json!({"collection": collection, "offset": 0, "checked_at": "2026-11-20T14:59:00.000Z", "outcome": "ok", "body": body}),
        )
    };
    let person = |collection: &str, id: &str, body: Value| {
        read(
            json!({"collection": collection, "person_id": id, "offset": 0, "checked_at": "2026-11-20T14:59:00.000Z", "outcome": "ok", "body": body}),
        )
    };
    let mut assignment_body = assignments();
    assignment_body["included"] = json!([
        {"id": "70", "type": "TeamPosition", "attributes": {"name": "Greeter"}},
        {"id": "71", "type": "TeamPosition", "attributes": {"name": "Nursery volunteer"}}]);
    let team = |id: &str| {
        let mut r = ok("team_position_assignments", assignment_body.clone());
        r.team_id = Some(id.into());
        r
    };
    SundayCapture {
        version: 1,
        kind: "live".into(),
        organization: ORG.into(),
        service_type_id: ST.into(),
        plan_id: PLAN.into(),
        started_at: "2026-11-20T14:58:00.000Z".into(),
        completed_at: "2026-11-20T14:59:30.000Z".into(),
        reads: vec![
            ok("plan", plan_reply()),
            ok("plan_times", list(vec![plan_time("60", STARTS, ENDS)])),
            ok(
                "needed_positions",
                list(vec![
                    needed(GREETER, TEAM, "Greeter", 1, None),
                    needed(NURSERY, KIDS, "Nursery volunteer", 1, None),
                ]),
            ),
            ok(
                "team_members",
                list(vec![member("80", AVERY, TEAM, "C", false, false)]),
            ),
            team(TEAM),
            team(KIDS),
            person("person_schedules", RILEY, list(vec![])),
            person("person_blockouts", RILEY, list(vec![])),
            person("person_schedules", BLAIR, list(vec![])),
            person(
                "person_blockouts",
                BLAIR,
                list(vec![blockout(
                    "2026-11-29T00:00:00Z",
                    "2026-11-30T00:00:00Z",
                    "no_repeat",
                )]),
            ),
        ],
        names: [RILEY, AVERY, BLAIR, CASEY]
            .iter()
            .map(|id| ((*id).to_owned(), format!("Fictional {id} Name-Canary")))
            .collect(),
        labels: BTreeMap::new(),
        kids_teams: Vec::new(),
        forms: None,
        checkins_event: None,
    }
}

struct Scratch(PathBuf);
impl Scratch {
    fn new(name: &str) -> Self {
        let mut random = [0u8; 8];
        getrandom::fill(&mut random).unwrap();
        let tag: String = random.iter().map(|b| format!("{b:02x}")).collect();
        let dir = std::env::temp_dir().join(format!("ozzie-change-{name}-{tag}"));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The open role a needed position stands for, as the page names it (team, Planning Center's name).
fn role(needed: &str) -> (&str, &str) {
    match needed {
        GREETER => (TEAM, "Greeter"),
        NURSERY => (KIDS, "Nursery volunteer"),
        other => (other, "Greeter"),
    }
}
/// One fictional session: the check remembered, changes on for the church, a clock that can move.
struct Session {
    changes: Changes,
    switch: ChangeSwitch,
    turns: Turns,
    fake: Arc<Fake>,
    auth: Arc<AuthController>,
    clock: Arc<AtomicU64>,
    _dir: Scratch,
}
fn session() -> Session {
    let dir = Scratch::new("session");
    let switch = ChangeSwitch::at(&dir.0);
    switch.set(ORG, true).unwrap();
    let clock = Arc::new(AtomicU64::new(now_ms()));
    let tick = clock.clone();
    let changes = Changes::with_clock(Arc::new(move || tick.load(Ordering::SeqCst)));
    changes.keep_log(ChangeLog::at(&dir.0));
    changes.remember(&capture());
    Session {
        changes,
        switch,
        turns: Turns::default(),
        fake: Fake::new(),
        auth: controller(),
        clock,
        _dir: dir,
    }
}
impl Session {
    fn prepare_as(
        &self,
        auth: &Arc<AuthController>,
        needed: &str,
        person: &str,
        kids: &[&str],
    ) -> Result<Proposed, Refusal> {
        let auth = auth.clone();
        let kids: Vec<String> = kids.iter().map(|k| (*k).to_owned()).collect();
        let (team, position) = role(needed);
        self.changes.prepare_with(
            &self.switch,
            &self.turns,
            PLAN,
            team,
            position,
            person,
            &kids,
            move || Some(auth),
            clients(&self.fake),
            Duration::from_secs(10),
        )
    }
    fn prepare(&self, needed: &str, person: &str) -> Result<Proposed, Refusal> {
        self.prepare_as(&self.auth, needed, person, &[])
    }
    /// The same, on another watched service's plan (several services watched).
    fn prepare_on(&self, plan: &str, needed: &str, person: &str) -> Result<Proposed, Refusal> {
        let auth = self.auth.clone();
        let (team, position) = role(needed);
        self.changes.prepare_with(
            &self.switch,
            &self.turns,
            plan,
            team,
            position,
            person,
            &[],
            move || Some(auth),
            clients(&self.fake),
            Duration::from_secs(10),
        )
    }
    fn carry_out(&self, id: &ChangeId, despite: Option<DespiteTheAdvice>) -> Outcome {
        let auth = self.auth.clone();
        self.changes.carry_out_with(
            &self.switch,
            &self.turns,
            id,
            Confirmation::OnScreen,
            despite,
            move || Some(auth),
            clients(&self.fake),
            Duration::from_secs(10),
        )
    }
    fn undo(&self, row: &str) -> Undone {
        let auth = self.auth.clone();
        self.changes.undo_with(
            &self.switch,
            &self.turns,
            row,
            Confirmation::OnScreen,
            move || Some(auth),
            clients(&self.fake),
            Duration::from_secs(10),
        )
    }
    fn advance(&self, ms: u64) {
        self.clock.fetch_add(ms, Ordering::SeqCst);
    }
}
fn made(outcome: &Outcome) -> &ChangeRecord {
    match outcome {
        Outcome::Made { record } | Outcome::MadeAfterAll { record } => record,
        other => panic!("not made: {other:?}"),
    }
}
fn no_names(text: &str) {
    for name in NAMES {
        assert!(!text.contains(name), "{name} in {text}");
    }
}

// ---- The closed list of writes ----------------------------------------------------------------------

#[test]
fn the_write_list_is_two_exact_requests_built_from_typed_fields() {
    let http = NativeChangeHttp::new().unwrap();
    let pencil = Write::PencilIn {
        service_type: ST.into(),
        plan: PLAN.into(),
        person: RILEY.into(),
        team: TEAM.into(),
        position: "Greeter".into(),
    };
    let built = http.build(&pencil, SECRET).unwrap();
    assert_eq!(built.method(), reqwest::Method::POST);
    assert_eq!(
        built.url().as_str(),
        "https://api.planningcenteronline.com/services/v2/service_types/10/plans/20/team_members"
    );
    assert_eq!(built.headers()["x-pco-api-version"], "2018-11-01");
    assert_eq!(built.headers()["accept"], "application/json");
    assert_eq!(built.headers()["content-type"], "application/json");
    assert_eq!(
        built.headers()["authorization"],
        format!("Bearer {SECRET}").as_str()
    );
    let body: Value = serde_json::from_slice(built.body().unwrap().as_bytes().unwrap()).unwrap();
    assert_eq!(
        body,
        json!({"data": {"type": "PlanPerson", "attributes": {"person_id": "50", "team_id": "30",
            "team_position_name": "Greeter", "status": "U", "prepare_notification": true}}})
    );
    let remove = Write::Remove {
        service_type: ST.into(),
        plan: PLAN.into(),
        row: "900".into(),
    };
    let built = http.build(&remove, SECRET).unwrap();
    assert_eq!(built.method(), reqwest::Method::DELETE);
    assert_eq!(
        built.url().as_str(),
        "https://api.planningcenteronline.com/services/v2/service_types/10/plans/20/team_members/900"
    );
    assert!(built.body().is_none());
    assert_eq!(built.headers()["x-pco-api-version"], "2018-11-01");
    // Nothing else can be built: ids are digits, the position one plain line.
    let pencil_with = |person: &str, position: &str| Write::PencilIn {
        service_type: ST.into(),
        plan: PLAN.into(),
        person: person.into(),
        team: TEAM.into(),
        position: position.into(),
    };
    for bad in [
        pencil_with("5/../0", "Greeter"),
        pencil_with("050", "Greeter"),
        pencil_with("", "Greeter"),
        pencil_with(RILEY, ""),
        pencil_with(RILEY, " Greeter"),
        pencil_with(RILEY, "Greeter\nnotes"),
        pencil_with(RILEY, "Greet\u{202E}er"),
        pencil_with(RILEY, &"G".repeat(121)),
        Write::Remove {
            service_type: ST.into(),
            plan: PLAN.into(),
            row: "900?x=1".into(),
        },
    ] {
        assert!(!bad.valid());
        assert_eq!(http.build(&bad, SECRET).err(), Some(Unsent::NotSent));
    }
    assert!(pencil_with(RILEY, &"G".repeat(120)).valid());
}

#[test]
fn only_the_row_and_who_scheduled_it_are_kept_from_a_write_answer() {
    // The live answer's shape (2026-11-17), with its name and everything else dropped unread.
    assert_eq!(
        made_row(
            br#"{"data":{"type":"PlanPerson","id":"900","attributes":{"name":"Riley Name-Canary","status":"U"},
                "relationships":{"scheduled_by":{"data":{"id":"180","type":"Person"}},"responds_to":{"data":{"id":"0","type":"Person"}}}}}"#
        ),
        (Some("900".into()), Some("180".into()))
    );
    assert_eq!(
        made_row(br#"{"data":{"type":"PlanPerson","id":"900"}}"#),
        (Some("900".into()), None)
    );
    for bad in [
        &br#"{"data":{"type":"Person","id":"900"}}"#[..],
        br#"{"errors":[{"status":"422"}]}"#,
        b"not json",
    ] {
        assert_eq!(made_row(bad), (None, None));
    }
    assert_eq!(
        made_row(br#"{"data":{"type":"PlanPerson","id":"9 00"}}"#),
        (None, None)
    );
}

// ---- The happy path ---------------------------------------------------------------------------------

#[test]
fn a_change_is_made_once_after_the_same_fresh_read_and_read_back() {
    let s = session();
    let proposed = s.prepare(GREETER, RILEY).unwrap();
    assert_eq!(proposed.plan, PLAN);
    assert_eq!(proposed.team, TEAM);
    assert_eq!(proposed.person, RILEY);
    assert_eq!(proposed.position, "Greeter");
    assert_eq!(proposed.sunday, "2026-11-29");
    assert_eq!(
        proposed.times,
        [ServiceTime {
            starts_at: STARTS.into(),
            ends_at: ENDS.into()
        }]
    );
    assert_eq!(proposed.still_needed, 1);
    assert!(!proposed.kids_team && !proposed.advised_against);
    assert_eq!(proposed.background_check, None);
    assert_eq!(proposed.checked_at, "2026-11-20T15:00:00.000Z");
    assert_eq!(proposed.expires_at, "2026-11-20T15:05:00.000Z");
    // A non-kids team reads no background check, and nothing is written yet.
    assert!(
        s.fake
            .reads()
            .iter()
            .all(|url| !url.contains("background_checks"))
    );
    assert!(s.fake.writes().is_empty());
    let read_before = s.fake.reads().len();
    s.advance(30_000);
    let outcome = s.carry_out(&proposed.change, None);
    let record = made(&outcome).clone();
    assert!(matches!(outcome, Outcome::Made { .. }));
    assert_eq!(record.row.as_deref(), Some("900"));
    assert_eq!(record.confirmed_by.as_deref(), Some(LEADER));
    assert_eq!(record.came_back, CameBack::Made);
    assert_eq!(record.action, Action::AddedUnconfirmed);
    assert_eq!(record.status, Some(201));
    assert_eq!(record.read_back, Some(ReadBack::AsExpected));
    assert_eq!(record.despite_advice, None);
    assert_eq!(record.confirmation, Confirmation::OnScreen);
    assert_eq!(record.confirmed_at, "2026-11-20T15:00:30.000Z");
    // Exactly one write, the design's.
    let writes = s.fake.writes();
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0].0, "POST");
    assert!(
        writes[0]
            .1
            .ends_with("/service_types/10/plans/20/team_members")
    );
    // Read again in full before writing, then the plan's people read back.
    let reads = s.fake.reads();
    let again = &reads[read_before..];
    assert!(again[0].ends_with("/service_types/10/plans/20"));
    for part in [
        "/plans/20/plan_times",
        "/needed_positions",
        "/team_members",
        "/person_team_position_assignments",
        "/people/v2/people/50?fields[Person]=child,status",
        "/people/50/blockouts",
        "/people/50/schedules",
    ] {
        assert!(
            again.iter().any(|url| url.contains(part)),
            "{part} not read again: {again:?}"
        );
    }
    assert!(again.last().unwrap().contains("/team_members"));
    // Used once.
    assert_eq!(
        s.carry_out(&proposed.change, None),
        Outcome::NotMade {
            reason: Refusal::UnknownChange
        }
    );
    assert_eq!(s.fake.writes().len(), 1);
    // Nothing returned names anyone.
    no_names(&serde_json::to_string(&proposed).unwrap());
    no_names(&format!("{proposed:?}"));
    no_names(&serde_json::to_string(&outcome).unwrap());
    no_names(&format!("{outcome:?}"));
}

#[test]
fn prepare_reads_planning_center_only_after_the_check_and_the_switch_agree() {
    let check = |s: &Session, needed: &str, person: &str, expected: Refusal| {
        assert_eq!(
            s.prepare(needed, person).err(),
            Some(expected),
            "{needed} {person}"
        );
        assert!(s.fake.reads().is_empty(), "read for {expected:?}");
        assert!(s.fake.writes().is_empty());
    };
    let s = session();
    // Someone the check left out, didn't read, or found on the plan; a role it didn't show.
    check(&s, GREETER, BLAIR, Refusal::NotListedToHelp);
    check(&s, GREETER, CASEY, Refusal::NotListedToHelp);
    check(&s, GREETER, AVERY, Refusal::NotListedToHelp);
    check(&s, "49", RILEY, Refusal::NotInThisCheck);
    check(&s, "4x", RILEY, Refusal::NotInThisCheck);
    check(&s, GREETER, "50 ", Refusal::NotInThisCheck);
    // Off for this church.
    let s = session();
    s.switch.set(ORG, false).unwrap();
    check(&s, GREETER, RILEY, Refusal::Off);
    // No live check: none yet, a recording, or another church's.
    let s = session();
    s.changes.forget();
    check(&s, GREETER, RILEY, Refusal::NoLiveCheck);
    let mut recording = capture();
    recording.kind = "recording".into();
    s.changes.remember(&recording);
    check(&s, GREETER, RILEY, Refusal::NoLiveCheck);
    let mut other = capture();
    other.organization = "1002".into();
    s.changes.remember(&other);
    // Its switch is asked first (off there), then the sign-in's church.
    check(&s, GREETER, RILEY, Refusal::Off);
    s.switch.set("1002", true).unwrap();
    check(&s, GREETER, RILEY, Refusal::ChurchChanged);
    // A split team, and a role the check showed with nothing open.
    let s = session();
    let mut split = capture();
    split.reads[2].body = Some(list(vec![needed(GREETER, TEAM, "Greeter", 1, Some("60"))]));
    s.changes.remember(&split);
    check(&s, GREETER, RILEY, Refusal::SplitTeam);
    let mut filled = capture();
    filled.reads[2].body = Some(list(vec![needed(GREETER, TEAM, "Greeter", 0, None)]));
    s.changes.remember(&filled);
    check(&s, GREETER, RILEY, Refusal::RoleNotOpen);
    // A check whose plan people didn't answer lists no one.
    let mut cut = capture();
    cut.reads[3].outcome = "truncated".into();
    s.changes.remember(&cut);
    check(&s, GREETER, RILEY, Refusal::NotListedToHelp);
    // Not connected.
    let s = session();
    assert_eq!(
        s.changes
            .prepare_with(
                &s.switch,
                &s.turns,
                PLAN,
                TEAM,
                "Greeter",
                RILEY,
                &[],
                || None,
                clients(&s.fake),
                DEADLINE
            )
            .err(),
        Some(Refusal::NotConnected)
    );
}

#[test]
fn the_fresh_read_refuses_whatever_changed_since_the_check() {
    let cases: Vec<(&str, Setup, Refusal)> = vec![
        (
            "role filled",
            Box::new(|f| f.set("needed_positions", Ok(list(vec![])))),
            Refusal::RoleNotOpen,
        ),
        (
            "split now",
            Box::new(|f| {
                f.set(
                    "needed_positions",
                    Ok(list(vec![needed(GREETER, TEAM, "Greeter", 1, Some("60"))])),
                )
            }),
            Refusal::SplitTeam,
        ),
        (
            "on the plan now",
            Box::new(|f| {
                f.members
                    .lock()
                    .unwrap()
                    .push(member("81", RILEY, "32", "D", false, false))
            }),
            Refusal::AlreadyOnPlan,
        ),
        (
            "position dropped",
            Box::new(|f| {
                let mut reply = assignments();
                reply["data"].as_array_mut().unwrap().remove(0);
                f.set("team_position_assignments", Ok(reply));
            }),
            Refusal::NoLongerInThatPosition,
        ),
        (
            "a child",
            Box::new(|f| f.set("person_child", Ok(child_reply(json!(true))))),
            Refusal::Child,
        ),
        (
            "child not said",
            Box::new(|f| f.set("person_child", Ok(child_reply(Value::Null)))),
            Refusal::CouldNotCheck,
        ),
        (
            "People refused",
            Box::new(|f| f.set("person_child", Err(SourceError::Denied))),
            Refusal::NoPeopleAccess,
        ),
        // Review S, L9: an inactive person is never added; nor one whose record doesn't say.
        (
            "inactive",
            Box::new(|f| {
                f.set(
                    "person_child",
                    Ok(person_reply(json!(false), Some(json!("inactive")))),
                )
            }),
            Refusal::Inactive,
        ),
        (
            "status not said",
            Box::new(|f| f.set("person_child", Ok(person_reply(json!(false), None)))),
            Refusal::StatusUnknown,
        ),
        (
            "status null",
            Box::new(|f| {
                f.set(
                    "person_child",
                    Ok(person_reply(json!(false), Some(Value::Null))),
                )
            }),
            Refusal::StatusUnknown,
        ),
        (
            "status not one Ozzie knows",
            Box::new(|f| {
                f.set(
                    "person_child",
                    Ok(person_reply(json!(false), Some(json!("archived")))),
                )
            }),
            Refusal::StatusUnknown,
        ),
        (
            "status not a code",
            Box::new(|f| {
                f.set(
                    "person_child",
                    Ok(person_reply(json!(false), Some(json!(true)))),
                )
            }),
            Refusal::CouldNotCheck,
        ),
        (
            "a child listed inactive is refused as a child",
            Box::new(|f| {
                f.set(
                    "person_child",
                    Ok(person_reply(json!(true), Some(json!("inactive")))),
                )
            }),
            Refusal::Child,
        ),
        (
            "blocked out",
            Box::new(|f| {
                f.set(
                    "person_blockouts",
                    Ok(list(vec![blockout(
                        "2026-11-29T00:00:00Z",
                        "2026-11-30T00:00:00Z",
                        "no_repeat",
                    )])),
                )
            }),
            Refusal::BlockedOut,
        ),
        (
            "repeating blockout",
            Box::new(|f| {
                f.set(
                    "person_blockouts",
                    Ok(list(vec![blockout(
                        "2026-01-04T00:00:00Z",
                        "2026-01-05T00:00:00Z",
                        "every_1",
                    )])),
                )
            }),
            Refusal::RepeatingBlockout,
        ),
        (
            "another plan then",
            Box::new(|f| {
                f.set(
                    "person_schedules",
                    Ok(schedule("21", "U", Some(("2026-11-29T15:00:00Z", ENDS)))),
                )
            }),
            Refusal::OtherPlanThen,
        ),
        (
            "another plan's times unread that Sunday",
            Box::new(|f| f.set("person_schedules", Ok(schedule("21", "U", None)))),
            Refusal::CouldNotCheck,
        ),
        (
            "a Services read refused",
            Box::new(|f| f.set("plan_times", Err(SourceError::Denied))),
            Refusal::NotAllowed,
        ),
        (
            "Planning Center out of reach",
            Box::new(|f| f.set("needed_positions", Err(SourceError::ProviderFailure))),
            Refusal::CouldNotCheck,
        ),
        (
            "the plan moved into the past",
            Box::new(|f| {
                f.set(
                    "plan_times",
                    Ok(list(vec![plan_time(
                        "60",
                        "2026-11-20T14:30:00Z",
                        "2026-11-20T15:30:00Z",
                    )])),
                )
            }),
            Refusal::PlanPassed,
        ),
    ];
    for (what, change, expected) in cases {
        let s = session();
        change(&s.fake);
        assert_eq!(s.prepare(GREETER, RILEY).err(), Some(expected), "{what}");
        assert!(s.fake.writes().is_empty(), "{what}");
    }
    // A rehearsal already over neither ends the Sunday nor meets an old blockout; the service still
    // ahead is what counts, and the card shows both times.
    let s = session();
    let mut rehearsal = plan_time("59", "2026-11-19T23:00:00Z", "2026-11-20T01:00:00Z");
    rehearsal["attributes"]["time_type"] = json!("rehearsal");
    s.fake.set(
        "plan_times",
        Ok(list(vec![rehearsal.clone(), plan_time("60", STARTS, ENDS)])),
    );
    s.fake.set(
        "person_blockouts",
        Ok(list(vec![blockout(
            "2026-11-19T22:00:00Z",
            "2026-11-20T02:00:00Z",
            "no_repeat",
        )])),
    );
    assert_eq!(s.prepare(GREETER, RILEY).unwrap().times.len(), 2);
    // Only rehearsals ahead, every service over: the Sunday has passed.
    let s = session();
    let mut later = plan_time("61", "2026-11-28T23:00:00Z", "2026-11-29T01:00:00Z");
    later["attributes"]["time_type"] = json!("rehearsal");
    s.fake.set(
        "plan_times",
        Ok(list(vec![
            later,
            plan_time("60", "2026-11-20T14:00:00Z", "2026-11-20T14:30:00Z"),
        ])),
    );
    assert_eq!(s.prepare(GREETER, RILEY).err(), Some(Refusal::PlanPassed));
    // A declined or other-Sunday schedule, and a blockout another day, don't count.
    let s = session();
    s.fake.set(
        "person_schedules",
        Ok(schedule("21", "D", Some((STARTS, ENDS)))),
    );
    s.fake.set(
        "person_blockouts",
        Ok(list(vec![blockout(
            "2026-12-06T00:00:00Z",
            "2026-12-07T00:00:00Z",
            "no_repeat",
        )])),
    );
    assert!(s.prepare(GREETER, RILEY).is_ok());
    // A sign-in without People can't confirm "not a child": refused before any plan read.
    let s = session();
    let (services_only, _) = controller_for(ORG, "services");
    assert_eq!(
        s.prepare_as(&services_only, GREETER, RILEY, &[]).err(),
        Some(Refusal::NoPeopleAccess)
    );
    assert!(s.fake.reads().is_empty());
}

#[test]
fn the_write_is_refused_unless_the_second_read_matches_the_confirmation() {
    // Still open, but not as the card said.
    let s = session();
    let proposed = s.prepare(GREETER, RILEY).unwrap();
    s.fake.set(
        "needed_positions",
        Ok(list(vec![needed(GREETER, TEAM, "Greeter", 2, None)])),
    );
    assert_eq!(
        s.carry_out(&proposed.change, None),
        Outcome::NotMade {
            reason: Refusal::ChangedSinceYouLooked
        }
    );
    assert!(s.fake.writes().is_empty());
    // Blocked out since.
    let s = session();
    let proposed = s.prepare(GREETER, RILEY).unwrap();
    s.fake.set(
        "person_blockouts",
        Ok(list(vec![blockout(STARTS, ENDS, "no_repeat")])),
    );
    assert_eq!(
        s.carry_out(&proposed.change, None),
        Outcome::NotMade {
            reason: Refusal::BlockedOut
        }
    );
    // Planning Center lists the person as a child now.
    let s = session();
    let proposed = s.prepare(GREETER, RILEY).unwrap();
    s.fake.set("person_child", Ok(child_reply(json!(true))));
    assert_eq!(
        s.carry_out(&proposed.change, None),
        Outcome::NotMade {
            reason: Refusal::Child
        }
    );
    assert!(s.fake.writes().is_empty());
}

#[test]
fn a_prepared_change_is_used_once_expires_and_dies_with_its_check() {
    // Expired.
    let s = session();
    let proposed = s.prepare(GREETER, RILEY).unwrap();
    s.advance(PREPARED_FOR.as_millis() as u64);
    assert_eq!(
        s.carry_out(&proposed.change, None),
        Outcome::NotMade {
            reason: Refusal::Expired
        }
    );
    // A new check, a recording shown, a church switch: each drops it.
    for drop_it in [
        Box::new(|s: &Session| s.changes.remember(&capture())) as Box<dyn Fn(&Session)>,
        Box::new(|s: &Session| {
            let mut recording = capture();
            recording.kind = "recording".into();
            s.changes.remember(&recording);
        }),
        Box::new(|s: &Session| s.changes.forget()),
    ] {
        let s = session();
        let proposed = s.prepare(GREETER, RILEY).unwrap();
        drop_it(&s);
        assert_eq!(
            s.carry_out(&proposed.change, None),
            Outcome::NotMade {
                reason: Refusal::UnknownChange
            }
        );
        assert!(s.fake.writes().is_empty());
    }
    // A second prepare replaces the first.
    let s = session();
    let first = s.prepare(GREETER, RILEY).unwrap();
    let second = s.prepare(NURSERY, RILEY).unwrap();
    assert_ne!(first.change, second.change);
    assert_eq!(
        s.carry_out(&first.change, None),
        Outcome::NotMade {
            reason: Refusal::UnknownChange
        }
    );
    // An id the page made up.
    assert_eq!(ChangeId::parse("not-an-id"), None);
    assert_eq!(ChangeId::parse(&"A".repeat(32)), None);
    let made_up = ChangeId::parse(&"0".repeat(32)).unwrap();
    assert_eq!(
        s.carry_out(&made_up, None),
        Outcome::NotMade {
            reason: Refusal::UnknownChange
        }
    );
    // The real one is still there after a wrong id, and used by the right one.
    assert!(matches!(
        s.carry_out(
            &second.change,
            Some(DespiteTheAdvice::about(BackgroundCheck::Current))
        ),
        Outcome::NotMade {
            reason: Refusal::NothingToAcknowledge
        }
    ));
    assert!(s.fake.writes().is_empty());
}

#[test]
fn switch_church_connection_turn_and_pace_are_checked_before_the_write() {
    // Switched off after the card was shown.
    let s = session();
    let proposed = s.prepare(GREETER, RILEY).unwrap();
    s.switch.set(ORG, false).unwrap();
    assert_eq!(
        s.carry_out(&proposed.change, None),
        Outcome::NotMade {
            reason: Refusal::Off
        }
    );
    // Another church signed in.
    let s = session();
    let proposed = s.prepare(GREETER, RILEY).unwrap();
    let (other, _) = controller_for("1002", "services-and-operations");
    let outcome = s.changes.carry_out_with(
        &s.switch,
        &s.turns,
        &proposed.change,
        Confirmation::OnScreen,
        None,
        move || Some(other),
        clients(&s.fake),
        DEADLINE,
    );
    assert_eq!(
        outcome,
        Outcome::NotMade {
            reason: Refusal::ChurchChanged
        }
    );
    // A check, the picker or a note reading; another change under way.
    for (holder, expected) in [
        (Reader::Check, Refusal::BusyWithACheck),
        (Reader::Picker, Refusal::BusyWithACheck),
        (Reader::Note, Refusal::BusyWithACheck),
        (Reader::Change, Refusal::BusyWithAnotherChange),
    ] {
        let s = session();
        let proposed = s.prepare(GREETER, RILEY).unwrap();
        let held = s.turns.take_now(holder).unwrap();
        assert_eq!(
            s.carry_out(&proposed.change, None),
            Outcome::NotMade { reason: expected }
        );
        drop(held);
        let held = s.turns.take_now(holder).unwrap();
        assert_eq!(s.prepare(GREETER, RILEY).err(), Some(expected));
        drop(held);
    }
    assert!(session().fake.writes().is_empty());
}

#[test]
fn writes_are_paced_per_minute_and_per_day_for_each_church() {
    let s = session();
    // Planning Center answers with the row but the fake leaves the plan as it was, so Riley stays
    // listed and can be prepared again.
    s.fake.script(Script::Answer {
        status: 201,
        made: true,
        apply: false,
    });
    let once = |s: &Session| {
        // Each change ends with a new check, as the page takes one after every change.
        s.changes.remember(&capture());
        let proposed = s.prepare(GREETER, RILEY).unwrap();
        s.carry_out(&proposed.change, None)
    };
    for _ in 0..PER_MINUTE {
        assert!(matches!(once(&s), Outcome::Made { .. }));
    }
    assert_eq!(
        once(&s),
        Outcome::NotMade {
            reason: Refusal::TooManyJustNow
        }
    );
    assert_eq!(s.fake.writes().len(), PER_MINUTE);
    let mut sent = PER_MINUTE;
    while sent < PER_DAY {
        s.advance(MINUTE_MS);
        assert!(matches!(once(&s), Outcome::Made { .. }));
        sent += 1;
    }
    s.advance(MINUTE_MS);
    assert_eq!(
        once(&s),
        Outcome::NotMade {
            reason: Refusal::TooManyToday
        }
    );
    assert_eq!(s.fake.writes().len(), PER_DAY);
    s.advance(DAY_MS);
    assert!(matches!(once(&s), Outcome::Made { .. }));
    // Fresh reads are paced too.
    let s = session();
    for _ in 0..LOOKS_PER_MINUTE {
        s.prepare(GREETER, RILEY).unwrap();
    }
    assert_eq!(
        s.prepare(GREETER, RILEY).err(),
        Some(Refusal::TooManyJustNow)
    );
}

#[test]
fn past_the_deadline_nothing_is_sent() {
    let s = session();
    let proposed = s.prepare(GREETER, RILEY).unwrap();
    s.fake.stall_ms.store(40, Ordering::SeqCst);
    let auth = s.auth.clone();
    let outcome = s.changes.carry_out_with(
        &s.switch,
        &s.turns,
        &proposed.change,
        Confirmation::OnScreen,
        None,
        move || Some(auth),
        clients(&s.fake),
        Duration::from_millis(100),
    );
    assert_eq!(
        outcome,
        Outcome::NotMade {
            reason: Refusal::DeadlinePassed
        }
    );
    assert!(s.fake.writes().is_empty());
}

#[test]
fn planning_centers_answer_decides_and_doubt_is_read_back_never_retried() {
    let run = |script: Script, members_fail_after: Option<usize>| {
        let s = session();
        let proposed = s.prepare(GREETER, RILEY).unwrap();
        s.fake.script(script);
        // The second read of the plan's people (just before writing) answers; then, if set, fail.
        *s.fake.members_fail_after.lock().unwrap() = members_fail_after;
        let outcome = s.carry_out(&proposed.change, None);
        assert_eq!(s.fake.writes().len(), 1, "sent once, never again");
        (outcome, s)
    };
    let answer = |status, made, apply| Script::Answer {
        status,
        made,
        apply,
    };
    assert_eq!(
        run(answer(403, false, false), None).0,
        Outcome::RefusedByPlanningCenter {
            status: 403,
            not_allowed: true
        }
    );
    assert_eq!(
        run(answer(422, false, false), None).0,
        Outcome::RefusedByPlanningCenter {
            status: 422,
            not_allowed: false
        }
    );
    assert_eq!(
        run(answer(429, false, false), None).0,
        Outcome::RefusedByPlanningCenter {
            status: 429,
            not_allowed: false
        }
    );
    // No answer: the plan read again decides.
    let (outcome, s) = run(Script::NoAnswer { apply: true }, None);
    assert_eq!(made(&outcome).row.as_deref(), Some("900"));
    assert_eq!(made(&outcome).status, None);
    assert!(matches!(outcome, Outcome::MadeAfterAll { .. }));
    // ...and that row can be undone, as Ozzie's own.
    assert_eq!(s.undo("900"), Undone::Removed);
    assert_eq!(
        run(Script::NoAnswer { apply: false }, None).0,
        Outcome::NothingChanged
    );
    assert_eq!(
        run(Script::NoAnswer { apply: true }, Some(1)).0,
        Outcome::Unknown
    );
    // A 5xx, or a success without the row's id, is read back too.
    assert!(matches!(
        run(answer(500, false, true), None).0,
        Outcome::MadeAfterAll { .. }
    ));
    assert_eq!(
        run(answer(503, false, false), None).0,
        Outcome::NothingChanged
    );
    assert!(matches!(
        run(answer(201, false, true), None).0,
        Outcome::MadeAfterAll { .. }
    ));
    // Made, but the read back didn't answer: said so.
    let (outcome, _) = run(answer(201, true, true), Some(1));
    assert_eq!(made(&outcome).read_back, Some(ReadBack::NotSeen));
}

// ---- Kids teams: a fact, advice, and a separate choice --------------------------------------------

#[test]
fn a_kids_team_shows_the_background_check_as_planning_center_records_it() {
    let current = |expires: Value| check("95", "complete_clear", json!(true), expires);
    let cases: Vec<(&str, Setup, BackgroundCheck)> = vec![
        ("current", Box::new(|_| {}), BackgroundCheck::Current),
        (
            "current with no end date",
            Box::new(move |f| {
                f.set(
                    "people_background_checks",
                    Ok(list(vec![current(Value::Null)])),
                )
            }),
            BackgroundCheck::Current,
        ),
        (
            "entered by hand",
            Box::new(|f| {
                f.set(
                    "people_background_checks",
                    Ok(list(vec![check(
                        "95",
                        "manual_clear",
                        json!(true),
                        json!("2027-10-23"),
                    )])),
                )
            }),
            BackgroundCheck::Current,
        ),
        (
            "none on file",
            Box::new(|f| f.set("people_background_checks", Ok(list(vec![])))),
            BackgroundCheck::NoneOnFile,
        ),
        (
            "expired",
            Box::new(|f| {
                f.set(
                    "people_background_checks",
                    Ok(list(vec![check(
                        "95",
                        "complete_clear",
                        json!(false),
                        json!("2026-10-01"),
                    )])),
                )
            }),
            BackgroundCheck::Expired,
        ),
        (
            "ends that Sunday",
            Box::new(move |f| {
                f.set(
                    "people_background_checks",
                    Ok(list(vec![current(json!("2026-11-29"))])),
                )
            }),
            BackgroundCheck::ExpiresByThatSunday,
        ),
        (
            "ends before that Sunday",
            Box::new(move |f| {
                f.set(
                    "people_background_checks",
                    Ok(list(vec![current(json!("2026-11-25"))])),
                )
            }),
            BackgroundCheck::ExpiresByThatSunday,
        ),
        (
            "an expired check and a new one processing",
            Box::new(|f| {
                f.set(
                    "people_background_checks",
                    Ok(list(vec![check(
                        "95",
                        "complete_clear",
                        json!(false),
                        json!("2026-10-01"),
                    )])),
                );
                f.set(
                    "pending_checks_report_processing",
                    Ok(list(vec![pending("report_processing")])),
                );
            }),
            BackgroundCheck::Pending,
        ),
        (
            "cleared read failed",
            Box::new(|f| {
                f.set(
                    "people_background_checks",
                    Err(SourceError::ProviderFailure),
                )
            }),
            BackgroundCheck::CouldNotRead,
        ),
        (
            "cleared read refused",
            Box::new(|f| f.set("people_background_checks", Err(SourceError::Denied))),
            BackgroundCheck::CouldNotRead,
        ),
        (
            "a pending read failed",
            Box::new(|f| f.set("pending_checks_needs_review", Err(SourceError::Timeout))),
            BackgroundCheck::CouldNotRead,
        ),
        (
            "a cleared check without its end date",
            Box::new(|f| {
                let mut row = check("95", "complete_clear", json!(true), Value::Null);
                row["attributes"]
                    .as_object_mut()
                    .unwrap()
                    .remove("expires_on");
                f.set("people_background_checks", Ok(list(vec![row])));
            }),
            BackgroundCheck::CouldNotRead,
        ),
    ];
    for (what, setup, expected) in cases {
        let s = session();
        setup(&s.fake);
        let proposed = s.prepare_as(&s.auth, NURSERY, RILEY, &[KIDS]).unwrap();
        assert!(proposed.kids_team, "{what}");
        assert_eq!(proposed.background_check, Some(expected), "{what}");
        assert_eq!(
            proposed.advised_against,
            expected != BackgroundCheck::Current,
            "{what}"
        );
    }
    // Each unfinished status Planning Center reports is pending.
    for (key, status) in [
        ("pending_checks_awaiting_applicant", "awaiting_applicant"),
        ("pending_checks_report_processing", "report_processing"),
        ("pending_checks_needs_review", "needs_review"),
    ] {
        let s = session();
        s.fake.set("people_background_checks", Ok(list(vec![])));
        s.fake.set(key, Ok(list(vec![pending(status)])));
        let proposed = s.prepare_as(&s.auth, NURSERY, RILEY, &[KIDS]).unwrap();
        assert_eq!(
            proposed.background_check,
            Some(BackgroundCheck::Pending),
            "{status}"
        );
        // The read asked for that status only, its status and person, and nothing that didn't clear.
        let reads = s.fake.reads();
        assert!(reads.iter().any(|url| url.ends_with(&format!(
            "/people/v2/people/50/background_checks?filter={status}&fields[BackgroundCheck]=status,person&per_page=100&offset=0"
        ))));
        assert!(reads.iter().all(|url| !url.contains("complete_not_clear")
            && !url.contains("canceled")
            && !url.contains("expired_invitation")));
    }
    // A pending read answering another status is refused, never counted.
    let s = session();
    s.fake.set("people_background_checks", Ok(list(vec![])));
    s.fake.set(
        "pending_checks_needs_review",
        Ok(list(vec![pending("complete_not_clear")])),
    );
    let proposed = s.prepare_as(&s.auth, NURSERY, RILEY, &[KIDS]).unwrap();
    assert_eq!(
        proposed.background_check,
        Some(BackgroundCheck::CouldNotRead)
    );
    // The check's own kids teams count too; a child is never added to any team.
    let s = session();
    let mut kids = capture();
    kids.kids_teams = vec![KIDS.into()];
    s.changes.remember(&kids);
    assert!(s.prepare(NURSERY, RILEY).unwrap().kids_team);
    s.fake.set("person_child", Ok(child_reply(json!(true))));
    assert_eq!(s.prepare(NURSERY, RILEY).err(), Some(Refusal::Child));
}

#[test]
fn advice_against_needs_its_own_choice_to_go_ahead_and_the_record_says_so() {
    let advised = |s: &Session| {
        s.fake.set("people_background_checks", Ok(list(vec![])));
        let proposed = s.prepare_as(&s.auth, NURSERY, RILEY, &[KIDS]).unwrap();
        assert!(proposed.advised_against);
        assert_eq!(proposed.background_check, Some(BackgroundCheck::NoneOnFile));
        proposed
    };
    // The confirmation alone writes nothing, nor a choice about other advice.
    for despite in [
        None,
        Some(DespiteTheAdvice::about(BackgroundCheck::Pending)),
        Some(DespiteTheAdvice::about(BackgroundCheck::Current)),
    ] {
        let s = session();
        let proposed = advised(&s);
        assert_eq!(
            s.carry_out(&proposed.change, despite),
            Outcome::NotMade {
                reason: Refusal::AdviceNotAcknowledged
            }
        );
        assert!(s.fake.writes().is_empty());
    }
    // With it, the change is made and the record says the leader went ahead despite the advice.
    let s = session();
    let proposed = advised(&s);
    let outcome = s.carry_out(
        &proposed.change,
        Some(DespiteTheAdvice::about(BackgroundCheck::NoneOnFile)),
    );
    assert_eq!(
        made(&outcome).despite_advice,
        Some(BackgroundCheck::NoneOnFile)
    );
    assert!(
        serde_json::to_string(&outcome)
            .unwrap()
            .contains(r#""despite_advice":"none-on-file""#)
    );
    // If the record changed since the card (a check cleared meanwhile), nothing is written.
    let s = session();
    let proposed = advised(&s);
    s.fake.set(
        "people_background_checks",
        Ok(list(vec![check(
            "95",
            "complete_clear",
            json!(true),
            json!("2027-10-23"),
        )])),
    );
    assert_eq!(
        s.carry_out(
            &proposed.change,
            Some(DespiteTheAdvice::about(BackgroundCheck::NoneOnFile))
        ),
        Outcome::NotMade {
            reason: Refusal::ChangedSinceYouLooked
        }
    );
    // A current check needs nothing more.
    let s = session();
    let proposed = s.prepare_as(&s.auth, NURSERY, RILEY, &[KIDS]).unwrap();
    assert!(!proposed.advised_against);
    assert!(matches!(
        s.carry_out(&proposed.change, None),
        Outcome::Made { .. }
    ));
}

// ---- Undo -----------------------------------------------------------------------------------------

#[test]
fn undo_removes_only_its_own_unsent_unanswered_row() {
    let made_once = || {
        let s = session();
        let proposed = s.prepare(GREETER, RILEY).unwrap();
        assert_eq!(
            made(&s.carry_out(&proposed.change, None)).row.as_deref(),
            Some("900")
        );
        s
    };
    let s = made_once();
    assert_eq!(
        s.undo("80"),
        Undone::NotRemoved {
            reason: Refusal::NotOzziesChange
        }
    );
    assert_eq!(s.undo("900"), Undone::Removed);
    let writes = s.fake.writes();
    assert_eq!(writes.len(), 2);
    assert_eq!(writes[1].0, "DELETE");
    assert!(
        writes[1]
            .1
            .ends_with("/service_types/10/plans/20/team_members/900")
    );
    assert_eq!(writes[1].2, None);
    // Once removed, it isn't Ozzie's to remove again.
    assert_eq!(
        s.undo("900"),
        Undone::NotRemoved {
            reason: Refusal::NotOzziesChange
        }
    );
    // Sent, answered or gone since: nothing is written.
    for (what, change, expected) in [
        (
            "sent",
            Box::new(|f: &Fake| {
                f.members.lock().unwrap().last_mut().unwrap()["attributes"]["notification_sent_at"] =
                    json!("2026-11-20T15:10:00Z")
            }) as Box<dyn Fn(&Fake)>,
            Undone::NotRemoved {
                reason: Refusal::RequestAlreadySent,
            },
        ),
        (
            "accepted",
            Box::new(|f: &Fake| {
                f.members.lock().unwrap().last_mut().unwrap()["attributes"]["status"] = json!("C")
            }),
            Undone::NotRemoved {
                reason: Refusal::PersonAnswered,
            },
        ),
        (
            "removed in Planning Center",
            Box::new(|f: &Fake| {
                f.members.lock().unwrap().pop();
            }),
            Undone::AlreadyGone,
        ),
    ] {
        let s = made_once();
        change(&s.fake);
        assert_eq!(s.undo("900"), expected, "{what}");
        assert_eq!(s.fake.writes().len(), 1, "{what}");
    }
    // A church switch forgets the rows made.
    let s = made_once();
    s.changes.forget();
    assert_eq!(
        s.undo("900"),
        Undone::NotRemoved {
            reason: Refusal::NotOzziesChange
        }
    );
    // Planning Center refusing the delete.
    let s = made_once();
    s.fake.script(Script::Answer {
        status: 403,
        made: false,
        apply: false,
    });
    assert_eq!(
        s.undo("900"),
        Undone::RefusedByPlanningCenter {
            status: 403,
            not_allowed: true
        }
    );
    // No answer: read back decides.
    let s = made_once();
    s.fake.script(Script::NoAnswer { apply: true });
    assert_eq!(s.undo("900"), Undone::Removed);
    let s = made_once();
    s.fake.script(Script::NoAnswer { apply: false });
    assert_eq!(s.undo("900"), Undone::Unknown);
}

// ---- After a change: a new check, and What happened's records ------------------------------------

#[test]
fn after_a_change_or_an_undo_the_next_change_starts_from_a_new_check() {
    let s = session();
    let proposed = s.prepare(GREETER, RILEY).unwrap();
    assert!(matches!(
        s.carry_out(&proposed.change, None),
        Outcome::Made { .. }
    ));
    // Planning Center changed: the check it came from is dropped.
    assert_eq!(s.prepare(GREETER, RILEY).err(), Some(Refusal::NoLiveCheck));
    assert_eq!(s.undo("900"), Undone::Removed);
    // The undo gave the open role back under a new id (seen live). A page that kept the old check
    // can't make a change from it: Ozzie reads the new id and asks for a new check.
    s.changes.remember(&capture());
    assert_eq!(s.prepare(GREETER, RILEY).err(), Some(Refusal::CheckAgain));
    assert_eq!(s.fake.writes().len(), 2, "nothing more was written");
    // A new check names the role by its new id; the change can be prepared again.
    let mut fresh = capture();
    fresh.reads[2].body = Some(list(vec![
        needed(NEW_NEED, TEAM, "Greeter", 1, None),
        needed(NURSERY, KIDS, "Nursery volunteer", 1, None),
    ]));
    s.changes.remember(&fresh);
    assert!(s.prepare(GREETER, RILEY).is_ok());
    // Two needs by the same team and name can't be told apart: no change is offered for either.
    let mut twice = capture();
    twice.reads[2].body = Some(list(vec![
        needed(GREETER, TEAM, "Greeter", 1, None),
        needed("43", TEAM, "Greeter", 1, None),
    ]));
    s.changes.remember(&twice);
    assert_eq!(
        s.prepare(GREETER, RILEY).err(),
        Some(Refusal::NotInThisCheck)
    );
}

#[test]
fn every_write_that_went_out_is_kept_for_what_happened_and_nothing_else() {
    let s = session();
    let log = ChangeLog::at(&s._dir.0);
    // Nothing sent, nothing kept.
    let proposed = s.prepare(GREETER, RILEY).unwrap();
    s.switch.set(ORG, false).unwrap();
    s.carry_out(&proposed.change, None);
    assert!(log.list(ORG, 10).is_empty());
    s.switch.set(ORG, true).unwrap();
    // Made, then taken off again.
    let proposed = s.prepare(GREETER, RILEY).unwrap();
    s.carry_out(&proposed.change, None);
    assert_eq!(s.undo("900"), Undone::Removed);
    // Refused by Planning Center (after a new check, which names the need by its new id).
    let mut fresh = capture();
    fresh.reads[2].body = Some(list(vec![needed(NEW_NEED, TEAM, "Greeter", 1, None)]));
    s.changes.remember(&fresh);
    let proposed = s.prepare(GREETER, RILEY).unwrap();
    s.fake.script(Script::Answer {
        status: 403,
        made: false,
        apply: false,
    });
    s.carry_out(&proposed.change, None);
    let records = log.list(ORG, 10);
    assert_eq!(records.len(), 3);
    // Newest first.
    assert_eq!(
        (records[0].action, records[0].came_back, records[0].status),
        (Action::AddedUnconfirmed, CameBack::Refused, Some(403))
    );
    assert_eq!(records[0].row, None);
    assert_eq!(
        (records[1].action, records[1].came_back, records[1].status),
        (Action::TookOff, CameBack::Removed, Some(201))
    );
    assert_eq!(records[1].row.as_deref(), Some("900"));
    // The delete's answer doesn't name the account: the add's scheduler isn't repeated (review S, L10).
    assert_eq!(records[1].confirmed_by, None);
    let made = &records[2];
    assert_eq!(
        (made.action, made.came_back, made.status),
        (Action::AddedUnconfirmed, CameBack::Made, Some(201))
    );
    assert_eq!(made.confirmed_by.as_deref(), Some(LEADER));
    assert_eq!(made.read_back, Some(ReadBack::AsExpected));
    assert_eq!(
        made.prepared_at.as_deref(),
        Some("2026-11-20T15:00:00.000Z")
    );
    // Another church's records aren't this one's.
    assert!(log.list("1002", 10).is_empty());
    // Which role and which Sunday, so What happened can say them after a restart (neither is a name).
    assert_eq!(
        (made.role.as_str(), made.sunday.as_str()),
        ("Greeter", "2026-11-29")
    );
    assert_eq!(
        (records[1].role.as_str(), records[1].sunday.as_str()),
        ("Greeter", "2026-11-29")
    );
    // The file holds ids, codes, times, the role and the date: no name, nothing secret, 0600.
    let text = std::fs::read_to_string(s._dir.0.join("changes-log.jsonl")).unwrap();
    no_names(&text);
    for secret in [SECRET, "fictional-refresh-canary"] {
        assert!(!text.contains(secret), "{secret}");
    }
    assert_eq!(text.lines().count(), 3);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let mode = std::fs::metadata(s._dir.0.join("changes-log.jsonl"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    // A line that isn't exactly a record this module writes is skipped, never shown.
    let mut tampered = text.clone();
    tampered.push_str("{\"action\":\"added-unconfirmed\",\"name\":\"Riley Name-Canary\"}\n");
    tampered.push_str(&text.lines().next().unwrap().replace(RILEY, "Riley"));
    tampered.push('\n');
    tampered.push_str(
        &text
            .lines()
            .next()
            .unwrap()
            .replace("2026-11-29", "2026-13-45"),
    );
    tampered.push('\n');
    tampered.push_str(
        &text
            .lines()
            .next()
            .unwrap()
            .replace("\"Greeter\"", "\"Greeter\\nnotes\""),
    );
    tampered.push('\n');
    std::fs::write(s._dir.0.join("changes-log.jsonl"), tampered).unwrap();
    assert_eq!(log.list(ORG, 10).len(), 3);
    // The newest are kept.
    let one: ChangeRecord = serde_json::from_str(text.lines().next().unwrap()).unwrap();
    for _ in 0..KEEP_RECORDS + 5 {
        log.append(&one).unwrap();
    }
    assert_eq!(log.list(ORG, usize::MAX).len(), KEEP_RECORDS);
}

#[test]
fn a_kids_change_made_despite_the_advice_says_so_in_what_happened() {
    let s = session();
    s.fake.set("people_background_checks", Ok(list(vec![])));
    s.fake.set(
        "pending_checks_awaiting_applicant",
        Ok(list(vec![pending("awaiting_applicant")])),
    );
    let proposed = s.prepare_as(&s.auth, NURSERY, RILEY, &[KIDS]).unwrap();
    assert_eq!(proposed.background_check, Some(BackgroundCheck::Pending));
    s.carry_out(
        &proposed.change,
        Some(DespiteTheAdvice::about(BackgroundCheck::Pending)),
    );
    let records = ChangeLog::at(&s._dir.0).list(ORG, 10);
    assert_eq!(records[0].despite_advice, Some(BackgroundCheck::Pending));
    assert!(
        std::fs::read_to_string(s._dir.0.join("changes-log.jsonl"))
            .unwrap()
            .contains(r#""despite_advice":"pending""#)
    );
    assert_eq!(
        BackgroundCheck::parse("pending"),
        Some(BackgroundCheck::Pending)
    );
    assert_eq!(BackgroundCheck::parse("Pending"), None);
}

// ---- The switch -------------------------------------------------------------------------------------

#[test]
fn changes_are_off_unless_turned_on_for_that_church() {
    let dir = Scratch::new("switch");
    let switch = ChangeSwitch::at(&dir.0);
    assert!(!switch.is_on(ORG));
    switch.set(ORG, true).unwrap();
    switch.set("1002", true).unwrap();
    assert!(switch.is_on(ORG) && switch.is_on("1002"));
    switch.set(ORG, false).unwrap();
    assert!(!switch.is_on(ORG) && switch.is_on("1002"));
    assert!(switch.set("10x", true).is_err());
    assert!(!switch.is_on("1002 "));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let mode = std::fs::metadata(dir.0.join("changes.json"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    // Anything that isn't exactly the file this writes reads as off.
    for text in [
        "",
        "not json",
        r#"{"version":2,"on":["1002"]}"#,
        r#"{"version":1,"on":["1002"],"also":true}"#,
        r#"{"version":1,"on":["1002","x"]}"#,
        r#"{"version":1,"on":"1002"}"#,
    ] {
        std::fs::write(dir.0.join("changes.json"), text).unwrap();
        assert!(!switch.is_on("1002"), "{text}");
    }
    std::fs::write(dir.0.join("changes.json"), r#"{"version":1,"on":["1002"]}"#).unwrap();
    assert!(switch.is_on("1002"));
    // A link in its place is never followed.
    #[cfg(unix)]
    {
        let target = dir.0.join("elsewhere.json");
        std::fs::write(&target, r#"{"version":1,"on":["1002"]}"#).unwrap();
        std::fs::remove_file(dir.0.join("changes.json")).unwrap();
        std::os::unix::fs::symlink(&target, dir.0.join("changes.json")).unwrap();
        assert!(!switch.is_on("1002"));
    }
}

// ---- Structure ------------------------------------------------------------------------------------

/// The crate's own source files (and its developer tools, where on disk), by name.
fn sources(root: &Path) -> Vec<(String, String)> {
    let mut files = Vec::new();
    for dir in [root.to_path_buf(), root.join("bin")] {
        for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.extension().is_some_and(|e| e == "rs") {
                let name = path
                    .strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned();
                files.push((name, std::fs::read_to_string(&path).unwrap()));
            }
        }
    }
    files.sort();
    files
}
fn crate_sources() -> Vec<(String, String)> {
    sources(&Path::new(env!("CARGO_MANIFEST_DIR")).join("src"))
}
/// Every method a file's code calls, outside its `tests` module (comments are never code).
fn methods(source: &str) -> Vec<String> {
    struct Calls(Vec<String>);
    impl<'a> syn::visit::Visit<'a> for Calls {
        fn visit_item_mod(&mut self, m: &'a syn::ItemMod) {
            if m.ident != "tests" {
                syn::visit::visit_item_mod(self, m);
            }
        }
        fn visit_expr_method_call(&mut self, call: &'a syn::ExprMethodCall) {
            self.0.push(call.method.to_string());
            syn::visit::visit_expr_method_call(self, call);
        }
    }
    use syn::visit::Visit as _;
    let mut calls = Calls(Vec::new());
    calls.visit_file(&syn::parse_file(source).unwrap());
    calls.0
}
/// A written-out form of a type, enough to tell one public signature from another.
fn ty(t: &syn::Type) -> String {
    let args = |a: &syn::PathArguments| match a {
        syn::PathArguments::None => String::new(),
        syn::PathArguments::AngleBracketed(g) => format!(
            "<{}>",
            g.args
                .iter()
                .map(|arg| match arg {
                    syn::GenericArgument::Type(t) => ty(t),
                    _ => "?".into(),
                })
                .collect::<Vec<_>>()
                .join(", ")
        ),
        syn::PathArguments::Parenthesized(p) => format!(
            "({}){}",
            p.inputs.iter().map(ty).collect::<Vec<_>>().join(", "),
            ret(&p.output)
        ),
    };
    let path = |p: &syn::Path| {
        p.segments
            .iter()
            .map(|s| format!("{}{}", s.ident, args(&s.arguments)))
            .collect::<Vec<_>>()
            .join("::")
    };
    match t {
        syn::Type::Path(p) => path(&p.path),
        syn::Type::Reference(r) => format!(
            "&{}{}",
            if r.mutability.is_some() { "mut " } else { "" },
            ty(&r.elem)
        ),
        syn::Type::Tuple(t) => format!(
            "({})",
            t.elems.iter().map(ty).collect::<Vec<_>>().join(", ")
        ),
        syn::Type::Slice(s) => format!("[{}]", ty(&s.elem)),
        syn::Type::ImplTrait(i) => format!(
            "impl {}",
            i.bounds
                .iter()
                .filter_map(|b| match b {
                    syn::TypeParamBound::Trait(t) => Some(path(&t.path)),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join(" + ")
        ),
        _ => "?".into(),
    }
}
fn ret(output: &syn::ReturnType) -> String {
    match output {
        syn::ReturnType::Default => String::new(),
        syn::ReturnType::Type(_, t) => format!(" -> {}", ty(t)),
    }
}

/// Every path a file's code names, imports flattened (`use crate::{change as c}` is caught).
fn paths(source: &str) -> Vec<String> {
    #[derive(Default)]
    struct Named {
        aliases: BTreeMap<String, String>,
        all: Vec<String>,
    }
    impl Named {
        fn flatten(&mut self, tree: &syn::UseTree, prefix: &str) {
            match tree {
                syn::UseTree::Path(p) => self.flatten(&p.tree, &format!("{prefix}{}::", p.ident)),
                syn::UseTree::Name(n) => {
                    let path = if n.ident == "self" {
                        prefix.trim_end_matches("::").to_owned()
                    } else {
                        format!("{prefix}{}", n.ident)
                    };
                    let alias = path.rsplit("::").next().unwrap_or_default().to_owned();
                    self.aliases.insert(alias, path.clone());
                    self.all.push(path);
                }
                syn::UseTree::Rename(r) => {
                    let path = format!("{prefix}{}", r.ident);
                    self.aliases.insert(r.rename.to_string(), path.clone());
                    self.all.push(path);
                }
                syn::UseTree::Glob(_) => self.all.push(format!("{prefix}*")),
                syn::UseTree::Group(g) => g.items.iter().for_each(|t| self.flatten(t, prefix)),
            }
        }
    }
    impl<'a> syn::visit::Visit<'a> for Named {
        fn visit_item_mod(&mut self, m: &'a syn::ItemMod) {
            if m.ident != "tests" {
                syn::visit::visit_item_mod(self, m);
            }
        }
        fn visit_item_use(&mut self, u: &'a syn::ItemUse) {
            self.flatten(&u.tree, "");
        }
        fn visit_path(&mut self, p: &'a syn::Path) {
            let joined: Vec<String> = p.segments.iter().map(|s| s.ident.to_string()).collect();
            self.all.push(joined.join("::"));
            syn::visit::visit_path(self, p);
        }
    }
    use syn::visit::Visit as _;
    let mut named = Named::default();
    named.visit_file(&syn::parse_file(source).unwrap());
    let aliases = named.aliases.clone();
    named
        .all
        .into_iter()
        .map(|path| {
            let (first, rest) = path.split_once("::").unwrap_or((&path, ""));
            match aliases.get(first) {
                Some(original) if original != &path && rest.is_empty() => original.clone(),
                Some(original) if original != &path => format!("{original}::{rest}"),
                _ => path,
            }
        })
        .collect()
}
/// Whether a full path reaches this module.
fn reaches_change(path: &str) -> bool {
    let segments: Vec<&str> = path.split("::").collect();
    segments
        .iter()
        .position(|s| *s == "change")
        .is_some_and(|at| {
            matches!(
                segments[..at],
                [] | ["crate"] | ["super"] | ["ozzie_native_auth"] | ["", "ozzie_native_auth"]
            ) && (at + 1 < segments.len() || at > 0)
        })
}

/// Structure: in this crate only change.rs, its tests, lib.rs's declaration and oauth.rs's one write
/// session (`change_verified_using`, given change.rs's closed `Write`) name this module or the reads
/// it alone makes. So no model route, agent step, Ozzie managed, task ledger, recording, check, shared
/// copy for other AI apps or Siri, notice, background job or developer tool can reach it. In the
/// desktop app only changes.rs does (its own structure tests pin which of its commands calls what).
#[test]
fn only_this_module_names_a_change() {
    let files = crate_sources();
    assert!(files.len() > 40, "{}", files.len());
    for name in [
        "model.rs",
        "agent.rs",
        "hosted.rs",
        "ledger.rs",
        "shared_check.rs",
        "shortcuts_check.rs",
        "sunday_check.rs",
        "phone_notice.rs",
        "responsibilities.rs",
        "background.rs",
        "contact.rs",
    ] {
        assert!(files.iter().any(|(n, _)| n == name), "{name}");
    }
    let allowed_in_oauth = [
        "crate::change::Write",
        "crate::change::ChangeHttp",
        "crate::change::Sent",
    ];
    for (name, source) in &files {
        if ["change.rs", "change_tests.rs"].contains(&name.as_str()) {
            continue;
        }
        let source = if name == "lib.rs" {
            assert_eq!(source.matches("pub mod change;").count(), 1);
            source.replace("pub mod change;", "")
        } else {
            source.clone()
        };
        for path in paths(&source) {
            if name == "oauth.rs" && allowed_in_oauth.contains(&path.as_str()) {
                continue;
            }
            assert!(!reaches_change(&path), "{name} reaches {path}");
            for segment in [
                "PersonChild",
                "PendingChecksAwaitingApplicant",
                "PendingChecksReportProcessing",
                "PendingChecksNeedsReview",
                "Changes",
                "ChangeSwitch",
                "NativeChangeHttp",
            ] {
                // The read list itself, and its GET-only test's list of every read.
                if ["source.rs", "source_operations_tests.rs"].contains(&name.as_str())
                    && segment.starts_with('P')
                {
                    continue;
                }
                assert!(!path.split("::").any(|s| s == segment), "{name}: {path}");
            }
        }
        for token in ["change_verified_using", "carry_out", "DespiteTheAdvice"] {
            if name == "oauth.rs" && token == "change_verified_using" {
                assert_eq!(source.matches(token).count(), 1, "oauth.rs defines it once");
                continue;
            }
            assert!(!source.contains(token), "{name} names {token}");
        }
    }
    // In the desktop app, only changes.rs (and its own structure tests, which name it in text).
    let desktop = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../product/desktop/src-tauri/src");
    if desktop.exists() {
        let files = sources(&desktop);
        assert!(!files.is_empty());
        let mut reaching = Vec::new();
        for (name, source) in files {
            if name == "changes_tests.rs" {
                continue;
            }
            if paths(&source)
                .iter()
                .any(|path| path.starts_with("ozzie_native_auth::change"))
            {
                reaching.push(name.clone());
            }
            assert!(!source.contains("change_verified_using"), "desktop {name}");
        }
        assert_eq!(reaching, ["changes.rs"]);
    }
    // The reader catches what plain text would miss.
    assert!(
        paths("use crate::{change as c};\nfn f() { c::x(); }")
            .iter()
            .any(|p| reaches_change(p))
    );
    assert!(
        paths("use crate::change::*;")
            .iter()
            .any(|p| reaches_change(p))
    );
    assert!(!reaches_change("change") && !reaches_change("self::changed"));
}

/// Structure: only change.rs builds a write to Planning Center. The source client stays GET-only (its
/// own test, unchanged); the files that post anything at all are the sign-in's fixed OAuth endpoints,
/// the phone notice and Ozzie managed, and none of them names a Planning Center product path; nothing
/// else names an HTTP write method or a free-form request. The private developer tool, where on disk,
/// is the only other file with a write, and is left out of the public copy.
#[test]
fn only_this_module_builds_a_write_to_planning_center() {
    let files = crate_sources();
    let products = [
        "/services/v2",
        "/people/v2",
        "/calendar/v2",
        "/groups/v2",
        "/check-ins/v2",
        "/registrations/v2",
    ];
    let mut posting = Vec::new();
    for (name, source) in &files {
        if name.ends_with("_tests.rs")
            || name == "hosted_fake.rs"
            || name == "change.rs"
            || name == "bin/ozzie-dev.rs"
        {
            continue;
        }
        let called = methods(source);
        for path in paths(source) {
            for method in ["POST", "PUT", "PATCH", "DELETE"] {
                assert!(
                    !path.ends_with(&format!("Method::{method}")),
                    "{name} names {path}"
                );
            }
        }
        for method in ["request", "patch"] {
            assert!(!called.iter().any(|m| m == method), "{name} calls {method}");
        }
        if called.iter().any(|m| m == "post") {
            posting.push(name.clone());
            for product in products {
                assert!(
                    !source.contains(product),
                    "{name} posts and names {product}"
                );
            }
        }
    }
    // Each posts only to its own host (Ozzie's AI, AI on this Mac, the church's own AI key, the phone
    // notice, Planning Center's sign-in), and none names a Planning Center product (asserted above).
    assert_eq!(
        posting,
        [
            "hosted.rs",
            "local_ai.rs",
            "local_models.rs",
            "model.rs",
            "own_key.rs",
            "phone_notice.rs",
            "provider.rs"
        ]
    );
    // change.rs names exactly two methods, each for its one write, and calls no other.
    let own = include_str!("change.rs");
    let own = &own[..own.find("#[cfg(test)]\n#[path").unwrap()];
    let named: Vec<String> = paths(own)
        .into_iter()
        .filter(|p| p.contains("Method::"))
        .collect();
    assert_eq!(
        named,
        ["reqwest::Method::POST", "reqwest::Method::DELETE"],
        "{named:?}"
    );
    for method in ["post", "put", "patch", "delete", "head"] {
        assert!(!methods(own).iter().any(|m| m == method), "{method}");
    }
    // The developer tool is the private one, where it is on disk.
    let dev = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/bin/ozzie-dev.rs");
    assert_eq!(
        files.iter().any(|(n, _)| n == "bin/ozzie-dev.rs"),
        dev.exists()
    );
}

/// Structure: change.rs reaches the network only through the verified source path and its own one
/// write session, the disk only for the switch's file, and nothing else: no process, environment,
/// output, log or panic with a value.
#[test]
fn this_module_reaches_only_its_reads_its_write_and_the_switch_file() {
    let source = include_str!("change.rs");
    let source = &source[..source.find("#[cfg(test)]\n#[path").unwrap()];
    let file = syn::parse_file(source).unwrap();
    // Where the filesystem is named: only the switch's own functions.
    struct Fs {
        within: Vec<String>,
        found: Vec<(Option<String>, String)>,
        macros: Vec<String>,
        calls: Vec<(Option<String>, String, String)>,
    }
    impl<'a> syn::visit::Visit<'a> for Fs {
        fn visit_impl_item_fn(&mut self, f: &'a syn::ImplItemFn) {
            self.within.push(f.sig.ident.to_string());
            syn::visit::visit_impl_item_fn(self, f);
            self.within.pop();
        }
        fn visit_item_fn(&mut self, f: &'a syn::ItemFn) {
            self.within.push(f.sig.ident.to_string());
            syn::visit::visit_item_fn(self, f);
            self.within.pop();
        }
        fn visit_path(&mut self, p: &'a syn::Path) {
            let joined: Vec<String> = p.segments.iter().map(|s| s.ident.to_string()).collect();
            self.found
                .push((self.within.last().cloned(), joined.join("::")));
            syn::visit::visit_path(self, p);
        }
        fn visit_macro(&mut self, m: &'a syn::Macro) {
            self.macros.push(
                m.path
                    .segments
                    .iter()
                    .map(|s| s.ident.to_string())
                    .collect::<Vec<_>>()
                    .join("::"),
            );
            syn::visit::visit_macro(self, m);
        }
        fn visit_expr_method_call(&mut self, call: &'a syn::ExprMethodCall) {
            let receiver = match &*call.receiver {
                syn::Expr::Path(p) => p
                    .path
                    .segments
                    .iter()
                    .map(|s| s.ident.to_string())
                    .collect::<Vec<_>>()
                    .join("::"),
                syn::Expr::Field(f) => match &f.member {
                    syn::Member::Named(n) => n.to_string(),
                    _ => String::new(),
                },
                _ => String::new(),
            };
            self.calls.push((
                self.within.last().cloned(),
                receiver,
                call.method.to_string(),
            ));
            syn::visit::visit_expr_method_call(self, call);
        }
    }
    use syn::visit::Visit as _;
    let mut fs = Fs {
        within: Vec::new(),
        found: Vec::new(),
        macros: Vec::new(),
        calls: Vec::new(),
    };
    fs.visit_file(&file);
    for (within, path) in &fs.found {
        let segments: Vec<&str> = path.split("::").collect();
        if segments.contains(&"fs") || segments.contains(&"io") {
            assert!(
                matches!(
                    within.as_deref(),
                    Some("on_list" | "set" | "send" | "read_all" | "append" | "turn") | None
                ),
                "{path} in {within:?}"
            );
        }
        for banned in [
            "process", "env", "net", "Command", "log", "tracing", "Display",
        ] {
            assert!(!segments.contains(&banned), "change.rs reaches {path}");
        }
        assert!(!path.starts_with("objc2"), "{path}");
    }
    for name in &fs.macros {
        assert!(
            ![
                "print",
                "println",
                "eprint",
                "eprintln",
                "dbg",
                "panic",
                "assert",
                "assert_eq",
                "assert_ne",
                "unreachable",
                "todo",
                "unimplemented",
                "write",
                "writeln"
            ]
            .contains(&name.rsplit("::").next().unwrap_or_default()),
            "change.rs uses {name}!"
        );
    }
    for (within, _, method) in &fs.calls {
        assert!(
            ![
                "unwrap",
                "expect",
                "unwrap_err",
                "expect_err",
                "unwrap_unchecked"
            ]
            .contains(&method.as_str()),
            "change.rs calls {method} in {within:?}"
        );
    }
    assert!(!source.contains("unsafe"));
    // The controller is asked for these and nothing else; reads never through `read_source`.
    let mut asked: Vec<&str> = fs
        .calls
        .iter()
        .filter(|(_, receiver, _)| receiver == "auth")
        .map(|(_, _, method)| method.as_str())
        .collect();
    asked.sort_unstable();
    asked.dedup();
    assert_eq!(
        asked,
        [
            "binding",
            "change_verified_using",
            "read_verified_using",
            "verify_source"
        ]
    );
    // The write session is asked only from the two places a person's yes reaches.
    let writes: BTreeSet<Option<&str>> = fs
        .calls
        .iter()
        .filter(|(_, _, method)| method == "change_verified_using")
        .map(|(within, _, _)| within.as_deref())
        .collect();
    assert_eq!(
        writes,
        BTreeSet::from([Some("carry_out_with"), Some("undo_with")])
    );
    // The turn is taken without waiting.
    let turns: Vec<&str> = fs
        .calls
        .iter()
        .filter(|(_, receiver, _)| receiver == "turns")
        .map(|(_, _, method)| method.as_str())
        .collect();
    assert_eq!(turns, ["take_now"]);
    // Nothing holding a change derives Clone, Debug or Serialize but the closed replies.
    for item in &file.items {
        let (name, attrs) = match item {
            syn::Item::Struct(s) => (s.ident.to_string(), &s.attrs),
            syn::Item::Enum(e) => (e.ident.to_string(), &e.attrs),
            _ => continue,
        };
        let derives: String = attrs
            .iter()
            .filter(|a| a.path().is_ident("derive"))
            .map(|a| {
                let mut list = Vec::new();
                let _ = a.parse_nested_meta(|m| {
                    list.push(
                        m.path
                            .segments
                            .iter()
                            .map(|s| s.ident.to_string())
                            .collect::<Vec<_>>()
                            .join("::"),
                    );
                    Ok(())
                });
                list.join(",")
            })
            .collect::<Vec<_>>()
            .join(",");
        if derives.contains("Serialize") || derives.contains("Deserialize") {
            assert!(
                [
                    "BackgroundCheck",
                    "Confirmation",
                    "ChangeId",
                    "ServiceTime",
                    "Proposed",
                    "Refusal",
                    "ReadBack",
                    "Action",
                    "CameBack",
                    "ChangeRecord",
                    "Outcome",
                    "Undone"
                ]
                .contains(&name.as_str())
                    && (!derives.contains("Deserialize")
                        || [
                            "BackgroundCheck",
                            "Confirmation",
                            "ReadBack",
                            "Action",
                            "CameBack",
                            "ChangeRecord"
                        ]
                        .contains(&name.as_str())),
                "{name} derives {derives}"
            );
        }
        if [
            "Write", "Prepared", "Seen", "Role", "State", "MadeRow", "Ask", "Changes",
        ]
        .contains(&name.as_str())
        {
            assert!(
                !derives.contains("Serialize") && !derives.contains("Debug"),
                "{name} derives {derives}"
            );
        }
    }
}

/// Everything change.rs makes public, outside its tests: a new public item, field or signature fails
/// here and needs its own review.
#[test]
fn the_public_api_is_exactly_this() {
    let file = syn::parse_file(include_str!("change.rs")).unwrap();
    let public = |v: &syn::Visibility| matches!(v, syn::Visibility::Public(_));
    let signature = |owner: &str, sig: &syn::Signature| {
        let inputs: Vec<String> = sig
            .inputs
            .iter()
            .map(|input| match input {
                syn::FnArg::Receiver(r) if r.reference.is_some() => "&self".into(),
                syn::FnArg::Receiver(_) => "self".into(),
                syn::FnArg::Typed(t) => ty(&t.ty),
            })
            .collect();
        format!(
            "fn {owner}{}({}){}",
            sig.ident,
            inputs.join(", "),
            ret(&sig.output)
        )
    };
    let mut api = Vec::new();
    for item in &file.items {
        match item {
            syn::Item::Fn(f) if public(&f.vis) => api.push(signature("", &f.sig)),
            syn::Item::Const(c) if public(&c.vis) => api.push(format!("const {}", c.ident)),
            syn::Item::Struct(s) if public(&s.vis) => {
                let fields = s.fields.iter().filter(|f| public(&f.vis)).count();
                api.push(format!("struct {} ({fields} public)", s.ident));
            }
            syn::Item::Enum(e) if public(&e.vis) => api.push(format!(
                "enum {} {{{}}}",
                e.ident,
                e.variants
                    .iter()
                    .map(|v| v.ident.to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            )),
            syn::Item::Impl(i) => {
                let owner = ty(&i.self_ty);
                if let Some((_, path, _)) = &i.trait_ {
                    let of: Vec<String> =
                        path.segments.iter().map(|s| s.ident.to_string()).collect();
                    api.push(format!("impl {} for {owner}", of.join("::")));
                }
                for inner in &i.items {
                    if let syn::ImplItem::Fn(f) = inner
                        && public(&f.vis)
                    {
                        api.push(signature(&format!("{owner}::"), &f.sig));
                    }
                }
            }
            syn::Item::Use(u) if public(&u.vis) => api.push("pub use".into()),
            syn::Item::Type(t) if public(&t.vis) => api.push(format!("type {}", t.ident)),
            syn::Item::Trait(t) if public(&t.vis) => api.push(format!("trait {}", t.ident)),
            syn::Item::Mod(m) if public(&m.vis) => api.push(format!("mod {}", m.ident)),
            _ => {}
        }
    }
    assert_eq!(
        api,
        [
            "const PREPARED_FOR",
            "const DEADLINE",
            "const PER_MINUTE",
            "const PER_DAY",
            "const LOOKS_PER_MINUTE",
            "const UNDOS_PER_MINUTE",
            "const LONGEST_TURN",
            "impl ChangeHttp for NativeChangeHttp",
            "enum BackgroundCheck {Current, NoneOnFile, Pending, Expired, ExpiresByThatSunday, CouldNotRead}",
            "fn BackgroundCheck::advised_against(self) -> bool",
            "struct DespiteTheAdvice (0 public)",
            "fn DespiteTheAdvice::about(BackgroundCheck) -> Self",
            "fn BackgroundCheck::parse(&str) -> Option<Self>",
            "enum Confirmation {OnScreen}",
            "struct ChangeId (0 public)",
            "fn ChangeId::parse(&str) -> Option<Self>",
            "struct ServiceTime (0 public)",
            "struct Proposed (0 public)",
            "enum Refusal {Off, NoLiveCheck, NotInThisCheck, NotListedToHelp, RoleNotOpen, SplitTeam, Child, Inactive, StatusUnknown, NoPeopleAccess, AlreadyOnPlan, NoLongerInThatPosition, BlockedOut, RepeatingBlockout, OtherPlanThen, PlanPassed, ChangedSinceYouLooked, CheckAgain, Expired, UnknownChange, AdviceNotAcknowledged, NothingToAcknowledge, BusyWithACheck, BusyWithAnotherChange, TooManyJustNow, TooManyToday, NotConnected, ChurchChanged, NotAllowed, CouldNotCheck, DeadlinePassed, NotOzziesChange, RequestAlreadySent, PersonAnswered, OtherSystem}",
            "enum ReadBack {AsExpected, NotSeen}",
            "enum Action {AddedUnconfirmed, TookOff}",
            "enum CameBack {Made, MadeAfterAll, Refused, NothingChanged, Unknown, Removed, AlreadyGone, SeveralRows}",
            "struct ChangeRecord (0 public)",
            "struct ChangeLog (0 public)",
            "const KEEP_RECORDS",
            "fn ChangeLog::at(&Path) -> Self",
            "fn ChangeLog::list(&self, &str, usize) -> Vec<ChangeRecord>",
            "enum Outcome {Made, MadeAfterAll, NotMade, RefusedByPlanningCenter, NothingChanged, Unknown, SeveralRows}",
            "enum Undone {Removed, AlreadyGone, NotRemoved, RefusedByPlanningCenter, Unknown}",
            "struct ChangeSwitch (0 public)",
            "fn ChangeSwitch::at(&Path) -> Self",
            "fn ChangeSwitch::is_on(&self, &str) -> bool",
            "fn ChangeSwitch::set(&self, &str, bool) -> std::io::Result<()>",
            "struct Changes (0 public)",
            "impl Default for Changes",
            "fn Changes::remember(&self, &SundayCapture)",
            "fn Changes::forget(&self)",
            "fn Changes::left(&self, &ChangeSwitch, &str)",
            "fn Changes::turn(&self, &ChangeSwitch, &str, bool) -> std::io::Result<bool>",
            "fn Changes::keep_log(&self, ChangeLog)",
            "fn Changes::prepare(&self, &ChangeSwitch, &Turns, &str, &str, &str, &str, &[String], impl FnOnce() -> Option<Arc<AuthController>>) -> Result<Proposed, Refusal>",
            "fn Changes::carry_out(&self, &ChangeSwitch, &Turns, &ChangeId, Confirmation, Option<DespiteTheAdvice>, impl FnOnce() -> Option<Arc<AuthController>>) -> Outcome",
            "fn Changes::undo(&self, &ChangeSwitch, &Turns, &str, Confirmation, impl FnOnce() -> Option<Arc<AuthController>>) -> Undone",
        ]
    );
}

// ---- Review S (security), 2026-11-17 ------------------------------------------------------------------

/// M3: a check Planning Center still marks current whose end date has passed is expired, said with that
/// date; one marked not current for another reason is expired with no date; one ending by that Sunday
/// carries its end date.
#[test]
fn an_end_date_that_has_passed_is_expired_whatever_planning_center_marks() {
    let cases = [
        // The staged control in the test organization: entered by hand, marked current, ended Oct 1.
        (
            check("95", "manual_clear", json!(true), json!("2026-10-01")),
            BackgroundCheck::Expired,
            Some("2026-10-01"),
        ),
        // Marked not current with a date still ahead (replaced, say): not current, no date.
        (
            check("95", "complete_clear", json!(false), json!("2027-03-01")),
            BackgroundCheck::Expired,
            None,
        ),
        (
            check("95", "complete_clear", json!(false), json!("2026-10-01")),
            BackgroundCheck::Expired,
            Some("2026-10-01"),
        ),
        (
            check("95", "complete_clear", json!(true), json!("2026-11-25")),
            BackgroundCheck::ExpiresByThatSunday,
            Some("2026-11-25"),
        ),
        (
            check("95", "complete_clear", json!(true), json!("2027-10-23")),
            BackgroundCheck::Current,
            None,
        ),
    ];
    for (row, fact, date) in cases {
        let s = session();
        s.fake.set("people_background_checks", Ok(list(vec![row])));
        let proposed = s.prepare_as(&s.auth, NURSERY, RILEY, &[KIDS]).unwrap();
        assert_eq!(proposed.background_check, Some(fact), "{date:?}");
        assert_eq!(proposed.background_check_date.as_deref(), date, "{fact:?}");
        let text = serde_json::to_string(&proposed).unwrap();
        assert_eq!(text.contains("background_check_date"), date.is_some());
    }
    // A passed check beside a current one that lasts: current.
    let s = session();
    s.fake.set(
        "people_background_checks",
        Ok(list(vec![
            check("95", "manual_clear", json!(true), json!("2026-10-01")),
            check("96", "complete_clear", json!(true), json!("2027-10-23")),
        ])),
    );
    let proposed = s.prepare_as(&s.auth, NURSERY, RILEY, &[KIDS]).unwrap();
    assert_eq!(proposed.background_check, Some(BackgroundCheck::Current));
}

/// M1: taking off is never held back by how many were added, and has its own pace; C11: not with the
/// switch off.
#[test]
fn undo_has_its_own_pace_and_needs_the_switch() {
    let s = session();
    s.fake.script(Script::Answer {
        status: 201,
        made: true,
        apply: false,
    });
    // Twenty adds in a day (the day's limit for adding).
    for _ in 0..PER_DAY {
        s.changes.remember(&capture());
        let proposed = s.prepare(GREETER, RILEY).unwrap();
        assert!(matches!(
            s.carry_out(&proposed.change, None),
            Outcome::Made { .. }
        ));
        s.advance(MINUTE_MS);
    }
    s.changes.remember(&capture());
    let proposed = s.prepare(GREETER, RILEY).unwrap();
    assert_eq!(
        s.carry_out(&proposed.change, None),
        Outcome::NotMade {
            reason: Refusal::TooManyToday
        }
    );
    // The row is still there to take off (the fake left the plan as it was; put it back).
    s.fake
        .members
        .lock()
        .unwrap()
        .push(member("900", RILEY, TEAM, "U", true, false));
    s.fake.script(Script::Answer {
        status: 204,
        made: false,
        apply: true,
    });
    assert_eq!(s.undo("900"), Undone::Removed);
    // Off: nothing is taken off, and nothing is asked of Planning Center.
    let s = session();
    let proposed = s.prepare(GREETER, RILEY).unwrap();
    assert!(matches!(
        s.carry_out(&proposed.change, None),
        Outcome::Made { .. }
    ));
    let writes = s.fake.writes().len();
    let reads = s.fake.reads().len();
    s.switch.set(ORG, false).unwrap();
    assert_eq!(
        s.undo("900"),
        Undone::NotRemoved {
            reason: Refusal::Off
        }
    );
    assert_eq!(
        (s.fake.writes().len(), s.fake.reads().len()),
        (writes, reads)
    );
}

/// L5: with the switch off, nothing renews the sign-in, takes the turn or reads: the switch is
/// asked first.
#[test]
fn the_switch_is_asked_before_the_sign_in_the_turn_or_any_read() {
    let s = session();
    let proposed = s.prepare(GREETER, RILEY).unwrap();
    s.switch.set(ORG, false).unwrap();
    let held = s.turns.take_now(Reader::Check).unwrap();
    let connected = AtomicUsize::new(0);
    let reads = s.fake.reads().len();
    let connect = || {
        connected.fetch_add(1, Ordering::SeqCst);
        Some(s.auth.clone())
    };
    assert_eq!(
        s.changes
            .prepare_with(
                &s.switch,
                &s.turns,
                PLAN,
                TEAM,
                "Greeter",
                RILEY,
                &[],
                connect,
                clients(&s.fake),
                DEADLINE
            )
            .err(),
        Some(Refusal::Off)
    );
    let connect = || {
        connected.fetch_add(1, Ordering::SeqCst);
        Some(s.auth.clone())
    };
    assert_eq!(
        s.changes.carry_out_with(
            &s.switch,
            &s.turns,
            &proposed.change,
            Confirmation::OnScreen,
            None,
            connect,
            clients(&s.fake),
            DEADLINE,
        ),
        Outcome::NotMade {
            reason: Refusal::Off
        }
    );
    assert_eq!(connected.load(Ordering::SeqCst), 0);
    assert_eq!(s.fake.reads().len(), reads);
    drop(held);
}

/// L1: the page names the plan; a change is prepared only for the plan the last live check read.
#[test]
fn a_change_is_prepared_only_for_the_plan_the_check_read() {
    let s = session();
    let auth = s.auth.clone();
    assert_eq!(
        s.changes
            .prepare_with(
                &s.switch,
                &s.turns,
                "21",
                TEAM,
                "Greeter",
                RILEY,
                &[],
                move || Some(auth),
                clients(&s.fake),
                DEADLINE
            )
            .err(),
        Some(Refusal::CheckAgain)
    );
    assert!(s.fake.reads().is_empty());
}

/// C17: the deadline passing while the write is already on its way is never "nothing sent": the plan
/// read again decides.
#[test]
fn a_deadline_during_the_write_is_read_back_never_called_nothing_sent() {
    for (script, expected) in [
        (Script::NoAnswer { apply: true }, "made-after-all"),
        (
            Script::Answer {
                status: 201,
                made: true,
                apply: true,
            },
            "made",
        ),
        (Script::NoAnswer { apply: false }, "nothing-changed"),
    ] {
        let s = session();
        let proposed = s.prepare(GREETER, RILEY).unwrap();
        s.fake.script(script);
        s.fake.send_stall_ms.store(400, Ordering::SeqCst);
        let auth = s.auth.clone();
        let outcome = s.changes.carry_out_with(
            &s.switch,
            &s.turns,
            &proposed.change,
            Confirmation::OnScreen,
            None,
            move || Some(auth),
            clients(&s.fake),
            Duration::from_millis(200),
        );
        let said = serde_json::to_value(&outcome).unwrap();
        assert_eq!(said["result"], expected, "{said}");
        assert_eq!(s.fake.writes().len(), 1);
    }
}

/// L2 and C40: after no answer, only a row for that person, on that team, in that position is taken for
/// Ozzie's; L3: two such rows are said as such, never as "couldn't look again".
#[test]
fn reading_back_takes_only_that_persons_row_on_that_team_in_that_position() {
    let run = |row: Value| {
        let s = session();
        let proposed = s.prepare(GREETER, RILEY).unwrap();
        s.fake.script(Script::NoAnswer { apply: false });
        *s.fake.on_send.lock().unwrap() = Some(row);
        s.carry_out(&proposed.change, None)
    };
    // Riley on another team, or in another position on this team (or the name stored differently):
    // never taken for Ozzie's, and never "nothing changed" either (review X, L-a).
    assert_eq!(
        run(member("901", RILEY, "32", "U", true, false)),
        Outcome::Unknown
    );
    let mut usher = member("902", RILEY, TEAM, "U", true, false);
    usher["attributes"]["team_position_name"] = json!("Usher");
    assert_eq!(run(usher), Outcome::Unknown);
    let mut spaced = member("904", RILEY, TEAM, "U", true, false);
    spaced["attributes"]["team_position_name"] = json!("Greeter ");
    assert_eq!(run(spaced), Outcome::Unknown);
    // Someone else on the plan: Riley is on no row, so nothing changed.
    assert_eq!(
        run(member("905", AVERY, TEAM, "U", true, false)),
        Outcome::NothingChanged
    );
    // That row, and one more just like it: which is Ozzie's can't be told.
    let s = session();
    let proposed = s.prepare(GREETER, RILEY).unwrap();
    s.fake.script(Script::NoAnswer { apply: true });
    *s.fake.on_send.lock().unwrap() = Some(member("903", RILEY, TEAM, "U", true, false));
    assert_eq!(s.carry_out(&proposed.change, None), Outcome::SeveralRows);
    let records = ChangeLog::at(&s._dir.0).list(ORG, 1);
    assert_eq!(records[0].came_back, CameBack::SeveralRows);
    // Nothing of it can be taken off: no row is Ozzie's for sure.
    assert_eq!(
        s.undo("900"),
        Undone::NotRemoved {
            reason: Refusal::NotOzziesChange
        }
    );
}

/// M2 and D4/D6 (core): leaving a church, or turning changes off, drops what waits for a yes and the
/// rows made, and leaving turns changes off for that church.
#[test]
fn leaving_a_church_or_turning_changes_off_drops_everything_waiting() {
    let s = session();
    let proposed = s.prepare(GREETER, RILEY).unwrap();
    s.changes.left(&s.switch, ORG);
    assert!(!s.switch.is_on(ORG));
    s.switch.set(ORG, true).unwrap();
    assert_eq!(
        s.carry_out(&proposed.change, None),
        Outcome::NotMade {
            reason: Refusal::UnknownChange
        }
    );
    let s = session();
    let proposed = s.prepare(GREETER, RILEY).unwrap();
    assert!(!s.changes.turn(&s.switch, ORG, false).unwrap());
    assert!(s.changes.turn(&s.switch, ORG, true).unwrap());
    assert_eq!(
        s.carry_out(&proposed.change, None),
        Outcome::NotMade {
            reason: Refusal::UnknownChange
        }
    );
    // A row made, then changes off and on again: it is no longer Ozzie's to take off.
    let s = session();
    let proposed = s.prepare(GREETER, RILEY).unwrap();
    assert!(matches!(
        s.carry_out(&proposed.change, None),
        Outcome::Made { .. }
    ));
    s.changes.turn(&s.switch, ORG, false).unwrap();
    s.changes.turn(&s.switch, ORG, true).unwrap();
    assert_eq!(
        s.undo("900"),
        Undone::NotRemoved {
            reason: Refusal::NotOzziesChange
        }
    );
    assert!(s.fake.writes().len() == 1);
    // Another church's switch is its own.
    s.switch.set("1002", true).unwrap();
    s.changes.left(&s.switch, ORG);
    assert!(s.switch.is_on("1002"));
}

/// L6: a change's hold on the turn is bounded, and the bound covers its parts.
#[test]
fn a_change_holds_the_turn_no_longer_than_its_bound() {
    // Reads to the deadline, an identity check under way (15 s), the write (10 s), the read back and a
    // page under way (5 s).
    assert!(LONGEST_TURN >= DEADLINE + READ_BACK + Duration::from_secs(15 + 10 + 5));
    assert!(LONGEST_TURN <= Duration::from_secs(70));
}

// ---- Review X (re-check), 2026-11-17 ------------------------------------------------------------------

/// L-a: after a delete that got no answer, the row is taken as removed only when no row for that person
/// has its id, whatever team or position the plan now shows for it.
#[test]
fn an_undo_is_removed_only_when_its_row_is_gone() {
    let s = session();
    let proposed = s.prepare(GREETER, RILEY).unwrap();
    assert!(matches!(
        s.carry_out(&proposed.change, None),
        Outcome::Made { .. }
    ));
    // The delete gets no answer, and reading back shows the row still there, under a position name
    // that no longer matches: it was not removed.
    *s.fake.on_send_edit.lock().unwrap() = Some(Box::new(|members: &mut Vec<Value>| {
        let row = members.iter_mut().find(|m| m["id"] == "900").unwrap();
        row["attributes"]["team_position_name"] = json!("greeter");
    }));
    s.fake.script(Script::NoAnswer { apply: false });
    assert_eq!(s.undo("900"), Undone::Unknown);
}

/// L5 (N2b): core's undo asks the switch before it connects, takes the turn or reads.
#[test]
fn undo_asks_the_switch_before_the_sign_in_the_turn_or_any_read() {
    let s = session();
    let proposed = s.prepare(GREETER, RILEY).unwrap();
    assert!(matches!(
        s.carry_out(&proposed.change, None),
        Outcome::Made { .. }
    ));
    s.switch.set(ORG, false).unwrap();
    let held = s.turns.take_now(Reader::Check).unwrap();
    let connected = AtomicUsize::new(0);
    let reads = s.fake.reads().len();
    let connect = || {
        connected.fetch_add(1, Ordering::SeqCst);
        Some(s.auth.clone())
    };
    assert_eq!(
        s.changes.undo_with(
            &s.switch,
            &s.turns,
            "900",
            Confirmation::OnScreen,
            connect,
            clients(&s.fake),
            DEADLINE,
        ),
        Undone::NotRemoved {
            reason: Refusal::Off
        }
    );
    assert_eq!(connected.load(Ordering::SeqCst), 0);
    assert_eq!(s.fake.reads().len(), reads);
    drop(held);
}

/// M1 (N4a, N4c): taking off has its own limit of ten a minute, and every delete sent counts toward it.
#[test]
fn taking_off_is_paced_ten_a_minute() {
    let s = session();
    *s.fake.next_row.lock().unwrap() = Some(1000);
    s.fake.script(Script::Answer {
        status: 201,
        made: true,
        apply: false,
    });
    let count = UNDOS_PER_MINUTE + 1;
    for _ in 0..count {
        s.changes.remember(&capture());
        let proposed = s.prepare(GREETER, RILEY).unwrap();
        assert!(matches!(
            s.carry_out(&proposed.change, None),
            Outcome::Made { .. }
        ));
        s.advance(MINUTE_MS);
    }
    for id in 1000..1000 + count as u64 {
        s.fake
            .members
            .lock()
            .unwrap()
            .push(member(&id.to_string(), RILEY, TEAM, "U", true, false));
    }
    s.fake.script(Script::Answer {
        status: 204,
        made: false,
        apply: true,
    });
    for id in 1000..1000 + UNDOS_PER_MINUTE as u64 {
        assert_eq!(s.undo(&id.to_string()), Undone::Removed, "{id}");
    }
    let last = (1000 + UNDOS_PER_MINUTE as u64).to_string();
    let deletes = s.fake.writes().len();
    assert_eq!(
        s.undo(&last),
        Undone::NotRemoved {
            reason: Refusal::TooManyJustNow
        }
    );
    assert_eq!(s.fake.writes().len(), deletes);
    s.advance(MINUTE_MS);
    assert_eq!(s.undo(&last), Undone::Removed);
}

/// M3 (N5b, N5c): "today" is the earliest calendar date anywhere (UTC-12), and a check ending today has
/// not passed: it ends by that Sunday, said with its date.
#[test]
fn a_check_ending_today_where_today_is_earliest_anywhere_has_not_passed() {
    // 2026-11-21T01:00Z: already the 21st in UTC, still the 20th at UTC-12.
    for (advance, label) in [
        (0, "the 20th everywhere"),
        (10 * 60 * MINUTE_MS, "the 21st in UTC"),
    ] {
        let s = session();
        s.advance(advance);
        s.changes.remember(&capture());
        s.fake.set(
            "people_background_checks",
            Ok(list(vec![check(
                "95",
                "complete_clear",
                json!(true),
                json!("2026-11-20"),
            )])),
        );
        let proposed = s.prepare_as(&s.auth, NURSERY, RILEY, &[KIDS]).unwrap();
        assert_eq!(
            proposed.background_check,
            Some(BackgroundCheck::ExpiresByThatSunday),
            "{label}"
        );
        assert_eq!(
            proposed.background_check_date.as_deref(),
            Some("2026-11-20"),
            "{label}"
        );
    }
}

/// The fictional second service watched (owner decision 2026-11-19, several services): another
/// service type and its own plan, read after the first in the same round.
const YOUTH_ST: &str = "11";
const YOUTH_PLAN: &str = "21";
fn youth_capture() -> SundayCapture {
    let mut youth = capture();
    youth.service_type_id = YOUTH_ST.into();
    youth.plan_id = YOUTH_PLAN.into();
    youth
}
/// The fake Planning Center as it was before any write: Avery on the plan, both roles open.
fn reset_plan(fake: &Fake) {
    *fake.members.lock().unwrap() = vec![member("80", AVERY, TEAM, "C", false, false)];
    fake.set(
        "needed_positions",
        Ok(list(vec![
            needed(GREETER, TEAM, "Greeter", 1, None),
            needed(NURSERY, KIDS, "Nursery volunteer", 1, None),
        ])),
    );
}

/// Several services watched: each keeps its own live check, so a change can be prepared on either
/// plan; a change is read and written on the plan the page named only; the other service's check
/// doesn't drop a change waiting on the first; and a write leaves the other service's check standing.
#[test]
fn each_watched_service_keeps_its_own_check_and_a_change_goes_to_its_own_plan() {
    let s = session();
    // Planning Center gives each add its own row: 901 on the first plan, 902 on the second.
    *s.fake.next_row.lock().unwrap() = Some(901);
    s.changes.remember(&youth_capture());
    // The first service's change, waiting for the leader's yes, survives the second service's check.
    let first = s.prepare(GREETER, RILEY).unwrap();
    assert_eq!(first.plan, PLAN);
    s.changes.remember(&youth_capture());
    assert!(matches!(
        s.carry_out(&first.change, None),
        Outcome::Made { .. }
    ));
    let writes = s.fake.writes();
    assert_eq!(writes.len(), 1);
    assert_eq!(
        writes[0].1,
        format!("{ORIGIN}/services/v2/service_types/{ST}/plans/{PLAN}/team_members")
    );
    // Its own check is dropped after the write; the second service's stands, and its change is read
    // and written on its own plan, never the first's.
    assert_eq!(s.prepare(GREETER, RILEY).err(), Some(Refusal::CheckAgain));
    reset_plan(&s.fake);
    let reads_before = s.fake.reads().len();
    let second = s.prepare_on(YOUTH_PLAN, GREETER, RILEY).unwrap();
    assert_eq!(second.plan, YOUTH_PLAN);
    let reads: Vec<String> = s.fake.reads()[reads_before..].to_vec();
    let plan_reads: Vec<&String> = reads.iter().filter(|url| url.contains("/plans/")).collect();
    assert!(!plan_reads.is_empty());
    for url in plan_reads {
        assert!(
            url.contains(&format!("/service_types/{YOUTH_ST}/plans/{YOUTH_PLAN}")),
            "{url}"
        );
    }
    assert!(matches!(
        s.carry_out(&second.change, None),
        Outcome::Made { .. }
    ));
    let writes = s.fake.writes();
    assert_eq!(writes.len(), 2);
    assert_eq!(
        writes[1].1,
        format!("{ORIGIN}/services/v2/service_types/{YOUTH_ST}/plans/{YOUTH_PLAN}/team_members")
    );
    // Undo removes the row on the plan it was made on.
    assert_eq!(s.undo("902"), Undone::Removed);
    let writes = s.fake.writes();
    assert_eq!(writes[2].0, "DELETE");
    assert_eq!(
        writes[2].1,
        format!(
            "{ORIGIN}/services/v2/service_types/{YOUTH_ST}/plans/{YOUTH_PLAN}/team_members/902"
        )
    );
}

/// Several services watched: a new check of one service drops a change waiting on its plan; a
/// recording of one service drops only that service's check; a service that moved on to its next plan
/// keeps only the new plan's check; and a check of another church drops every service's check and
/// the change waiting.
#[test]
fn each_services_check_stands_or_falls_on_its_own_and_another_church_drops_all() {
    // A new check of the second service drops a change waiting on its plan.
    let s = session();
    s.changes.remember(&youth_capture());
    let waiting = s.prepare_on(YOUTH_PLAN, GREETER, RILEY).unwrap();
    s.changes.remember(&youth_capture());
    assert_eq!(
        s.carry_out(&waiting.change, None),
        Outcome::NotMade {
            reason: Refusal::UnknownChange
        }
    );
    // A recording of the second service: only its check falls.
    let mut recording = youth_capture();
    recording.kind = "recording".into();
    s.changes.remember(&recording);
    assert_eq!(
        s.prepare_on(YOUTH_PLAN, GREETER, RILEY).err(),
        Some(Refusal::CheckAgain)
    );
    assert!(s.prepare(GREETER, RILEY).is_ok());
    // The second service moved on to its next plan: the old plan's check no longer stands.
    s.changes.remember(&youth_capture());
    let mut next = youth_capture();
    next.plan_id = "22".into();
    s.changes.remember(&next);
    assert_eq!(
        s.prepare_on(YOUTH_PLAN, GREETER, RILEY).err(),
        Some(Refusal::CheckAgain)
    );
    assert!(s.prepare_on("22", GREETER, RILEY).is_ok());
    // A check of another church: nothing of this one's checks or its change waiting stays.
    let waiting = s.prepare(GREETER, RILEY).unwrap();
    let mut other = youth_capture();
    other.organization = "2002".into();
    s.changes.remember(&other);
    assert_eq!(
        s.carry_out(&waiting.change, None),
        Outcome::NotMade {
            reason: Refusal::UnknownChange
        }
    );
    assert_eq!(s.prepare(GREETER, RILEY).err(), Some(Refusal::CheckAgain));
    assert_eq!(
        s.prepare_on("22", GREETER, RILEY).err(),
        Some(Refusal::CheckAgain)
    );
    assert!(s.fake.writes().is_empty());
}
