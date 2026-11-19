//! Tests only: a fake clock, a fake B1 answering fixed fictional data, an in-memory key store, and a key-shaped
//! canary built from parts at run time (no key-shaped text is written in any file).
use crate::capture::{Id, System};
use crate::http::{Get, Http, ReadError, Reply};
use crate::keys::Key;
use crate::run::Clock;
use ozzie_native_auth::credentials::{CredentialStore, StoreError};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// 2026-11-17T15:00:00Z.
pub const NOW: i64 = 1_794_927_600_000;

pub struct FakeClock {
    state: Mutex<(Duration, i64)>,
}
impl FakeClock {
    pub fn at(unix_millis: i64) -> Arc<FakeClock> {
        Arc::new(FakeClock {
            state: Mutex::new((Duration::from_secs(1000), unix_millis)),
        })
    }
    pub fn advance(&self, by: Duration) {
        self.state.lock().unwrap().0 += by;
    }
}
impl Clock for FakeClock {
    fn elapsed(&self) -> Duration {
        self.state.lock().unwrap().0
    }
    fn unix_millis(&self) -> i64 {
        let (elapsed, base) = *self.state.lock().unwrap();
        base + (elapsed - Duration::from_secs(1000)).as_millis() as i64
    }
    fn sleep(&self, wait: Duration) {
        self.advance(wait);
    }
}

/// The B1 key every test uses: `cak_` + 8 hex + `.` + 48 hex, assembled here.
pub fn key_text() -> String {
    format!(
        "{}{}.{}",
        ["ca", "k_"].concat(),
        "c3".repeat(4),
        "9e".repeat(24)
    )
}
pub fn key() -> Key {
    Key::parse(System::B1, &key_text()).unwrap()
}
/// A Breeze-shaped key (its format isn't documented; 32 letters and digits), assembled here.
pub fn breeze_key_text() -> String {
    ["b7", "e4"].concat().repeat(8)
}
pub fn breeze_key() -> Key {
    Key::parse(System::Breeze, &breeze_key_text()).unwrap()
}
/// A Genesis-shaped key: `gk_live_` and 32 letters and digits, assembled here.
pub fn genesis_key_text() -> String {
    format!(
        "{}{}",
        ["gk_", "live_"].concat(),
        ["a3", "f9"].concat().repeat(8)
    )
}
pub fn genesis_key() -> Key {
    Key::parse(System::Genesis, &genesis_key_text()).unwrap()
}
pub fn id(text: &str) -> Id {
    Id::new(text).unwrap()
}

/// One canned answer.
#[derive(Clone)]
pub enum Answer {
    Json(u16, String),
    Retry(u16, &'static str),
    Fail(ReadError),
}
pub fn ok(value: Value) -> Answer {
    Answer::Json(200, value.to_string())
}
pub fn raw(status: u16, body: &str) -> Answer {
    Answer::Json(status, body.to_owned())
}

/// One request as the fake saw it.
#[derive(Clone, Debug)]
pub struct Call {
    pub url: String,
    pub method: &'static str,
    pub auth: String,
    pub at: Duration,
    pub limit: Duration,
}

/// A fake B1: answers by path; `/membership/people/names` answers from `people`, filtered by the `ids` asked.
pub struct FakeB1 {
    pub answers: Mutex<HashMap<String, Answer>>,
    pub people: BTreeMap<String, Value>,
    pub calls: Mutex<Vec<Call>>,
    pub clock: Arc<FakeClock>,
    pub latency: Duration,
}
impl FakeB1 {
    /// A fake system with no answers yet (every path 404s until `set`).
    pub fn empty(clock: Arc<FakeClock>) -> FakeB1 {
        FakeB1 {
            answers: Mutex::new(HashMap::new()),
            people: BTreeMap::new(),
            calls: Mutex::new(Vec::new()),
            clock,
            latency: Duration::from_millis(40),
        }
    }
    pub fn set(&self, path: &str, answer: Answer) {
        self.answers.lock().unwrap().insert(path.to_owned(), answer);
    }
    pub fn calls(&self) -> Vec<Call> {
        self.calls.lock().unwrap().clone()
    }
    pub fn paths(&self) -> Vec<String> {
        self.calls()
            .iter()
            .map(|c| url::Url::parse(&c.url).unwrap().path().to_owned())
            .collect()
    }
}
impl Http for FakeB1 {
    fn get(&self, request: &Get) -> Result<Reply, ReadError> {
        let url = request.url().clone();
        self.calls.lock().unwrap().push(Call {
            url: url.to_string(),
            method: request.method(),
            auth: request.auth_header().1.to_string(),
            at: self.clock.elapsed(),
            limit: request.limit(),
        });
        self.clock.advance(self.latency);
        let path = url.path().to_owned();
        // A read answered by its whole query (`<path>?<query>`) when that is set, as for one form's entries.
        if let Some(query) = url.query()
            && let Some(answer) = self
                .answers
                .lock()
                .unwrap()
                .get(&format!("{path}?{query}"))
                .cloned()
        {
            return reply(answer);
        }
        let found = self.answers.lock().unwrap().get(&path).cloned();
        if let Some(answer) = found {
            return reply(answer);
        }
        if path == "/membership/people/names" {
            let asked: Vec<String> = url
                .query_pairs()
                .find(|(k, _)| k == "ids")
                .map(|(_, v)| v.split(',').map(str::to_owned).collect())
                .unwrap_or_default();
            let rows: Vec<Value> = asked
                .iter()
                .filter_map(|i| self.people.get(i).cloned())
                .collect();
            return Ok(Reply::new(200, Value::Array(rows).to_string().into_bytes()));
        }
        Ok(Reply::new(404, b"{}".to_vec()))
    }
}
fn reply(answer: Answer) -> Result<Reply, ReadError> {
    match answer {
        Answer::Json(status, body) => Ok(Reply::new(status, body.into_bytes())),
        Answer::Retry(status, after) => Ok(Reply::new(status, Vec::new()).with_retry_after(after)),
        Answer::Fail(error) => Err(error),
    }
}

pub const CHURCH: &str = "CHUfict01";
pub const PLAN: &str = "PLAfict01";
/// Fictional people, by id: (id, display name).
pub const PEOPLE: &[(&str, &str)] = &[
    ("PERavery", "Avery Quillfeather"),
    ("PERblake", "Blake Marrowstone"),
    ("PERcasey", "Casey Thimbleton"),
    ("PERdrew", "Drew Pennywhistle"),
    ("PERellis", "Ellis Brackenfield"),
    ("PERzed", "Zed Outsider"),
];

/// A fictional church on B1: Cedar Hollow Fellowship's Sunday, 2026-11-22, 9:00 to 10:30 in Chicago (CST, UTC-6), as
/// B1 writes it (b1-church-times.md): times as UTC instants, days as that day's UTC midnight.
/// - Vocals wants 2: Avery accepted, Blake unconfirmed. Sound wants 1: nobody (an open role). Greeter wants 2: Casey
///   declined.
/// - Worship team: Avery, Blake and Drew (Drew has no assignment and a blockout on the Sunday). Welcome team: Casey
///   and Ellis (Ellis has a blockout in December).
/// - Zed isn't on any team; Zed's blockout is left out.
pub fn fake_b1(clock: Arc<FakeClock>) -> FakeB1 {
    let mut answers = HashMap::new();
    let mut answer = |path: &str, value: Value| {
        answers.insert(path.to_owned(), ok(value));
    };
    answer(
        &format!("/membership/churches/{CHURCH}"),
        json!({"id": CHURCH, "name": "Cedar Hollow Fellowship", "timeZone": "America/Chicago",
               "subDomain": "cedarhollow", "city": "Fictionville", "settings": []}),
    );
    answer(
        "/doing/plans",
        json!([
            {"id": PLAN, "name": "Sunday Gathering", "serviceDate": "2026-11-22T00:00:00.000Z", "prepared": false},
            {"id": "PLAfict00", "name": "Last Week", "serviceDate": "2026-11-15T00:00:00.000Z"},
            {"id": "PLAfict02", "name": "Advent One", "serviceDate": "2026-11-29T00:00:00.000Z"}
        ]),
    );
    answer(
        &format!("/doing/plans/{PLAN}"),
        json!({"id": PLAN, "churchId": CHURCH, "name": "Sunday Gathering", "serviceDate": "2026-11-22T00:00:00.000Z",
               "ministryId": "GRPministry", "notes": "Bring the fictional banners", "prepared": false}),
    );
    answer(
        &format!("/doing/positions/plan/{PLAN}"),
        json!([
            {"id": "POSvocal", "planId": PLAN, "categoryName": "Worship", "name": "Vocals", "count": 2,
             "groupId": "GRPworship", "allowSelfSignup": false},
            {"id": "POSsound", "planId": PLAN, "categoryName": "Technical", "name": "Sound", "count": 1,
             "groupId": "GRPworship"},
            {"id": "POSgreet", "planId": PLAN, "categoryName": "Hospitality", "name": "Greeter", "count": 2,
             "groupId": "GRPwelcome", "description": null}
        ]),
    );
    answer(
        &format!("/doing/assignments/plan/{PLAN}"),
        json!([
            {"id": "ASGone", "positionId": "POSvocal", "personId": "PERavery", "status": "Accepted",
             "planId": PLAN, "notified": "2026-11-10T12:00:00.000Z"},
            {"id": "ASGtwo", "positionId": "POSvocal", "personId": "PERblake", "status": "Unconfirmed",
             "planId": PLAN, "notified": null},
            {"id": "ASGthree", "positionId": "POSgreet", "personId": "PERcasey", "status": "Declined",
             "planId": PLAN}
        ]),
    );
    answer(
        "/membership/groupmembers",
        json!([
            {"id": "GMa", "groupId": "GRPworship", "personId": "PERavery", "leader": true,
             "person": {"id": "PERavery", "name": {"display": "Avery Quillfeather"}}},
            {"id": "GMb", "groupId": "GRPworship", "personId": "PERblake"},
            {"id": "GMc", "groupId": "GRPworship", "personId": "PERdrew"},
            {"id": "GMd", "groupId": "GRPwelcome", "personId": "PERcasey"},
            {"id": "GMe", "groupId": "GRPwelcome", "personId": "PERellis"}
        ]),
    );
    answer(
        &format!("/doing/times/plan/{PLAN}"),
        json!([
            {"id": "TIMservice", "planId": PLAN, "displayName": "Sunday", "startTime": "2026-11-22T15:00:00.000Z",
             "endTime": "2026-11-22T16:30:00.000Z", "teams": "Worship,Technical,Hospitality",
             "serviceTimeType": "service"},
            {"id": "TIMrehearse", "planId": PLAN, "displayName": "Rehearsal",
             "startTime": "2026-11-20T01:00:00.000Z", "endTime": "2026-11-20T02:30:00.000Z", "teams": "Worship",
             "serviceTimeType": "rehearsal"}
        ]),
    );
    answer(
        "/doing/blockoutDates/upcoming",
        json!([
            {"id": "BLKone", "personId": "PERdrew", "startDate": "2026-11-22T00:00:00.000Z",
             "endDate": "2026-11-22T00:00:00.000Z"},
            {"id": "BLKtwo", "personId": "PERellis", "startDate": "2026-12-01T00:00:00.000Z",
             "endDate": "2026-12-03T00:00:00.000Z"},
            {"id": "BLKthree", "personId": "PERzed", "startDate": "2026-11-22T00:00:00.000Z",
             "endDate": "2026-11-22T00:00:00.000Z"}
        ]),
    );
    // The day before to the day after: another plan the same Sunday (11:00 CST) with Drew on it, Casey's declined one
    // (not busy), and a position nobody holds.
    answer(
        "/doing/plans/overview",
        json!([
            {"serviceDate": "2026-11-22T00:00:00.000Z", "planId": PLAN, "planName": "Sunday Gathering", "positionId": "POSvocal",
             "personId": "PERavery", "status": "Accepted", "assignmentId": "ASGone", "needed": 2},
            {"serviceDate": "2026-11-22T00:00:00.000Z", "planId": "PLAlate", "planName": "Late Service",
             "positionId": "POSlate", "personId": "PERdrew", "status": "Unconfirmed", "assignmentId": "ASGlate"},
            {"serviceDate": "2026-11-22T00:00:00.000Z", "planId": "PLAlate", "positionId": "POSlate2",
             "personId": "PERcasey", "status": "Declined"},
            {"serviceDate": "2026-11-22T00:00:00.000Z", "planId": "PLAlate", "positionId": "POSopen",
             "personId": null, "status": null, "assignmentId": null}
        ]),
    );
    // The other plan, shared with its volunteers (`prepared` false).
    answer(
        "/doing/plans/ids",
        json!([{"id": "PLAlate", "name": "Late Service", "serviceDate": "2026-11-22T00:00:00.000Z", "prepared": false}]),
    );
    answer(
        "/doing/times/plans",
        json!([{"id": "TIMlate", "planId": "PLAlate", "displayName": "Late",
                "startTime": "2026-11-22T17:00:00.000Z", "endTime": "2026-11-22T18:15:00.000Z"}]),
    );
    answer(
        "/membership/groups",
        json!([
            {"id": "GRPworship", "name": "Worship Team", "memberCount": 3, "categoryName": "Serving", "tags": ""},
            {"id": "GRPwelcome", "name": "Welcome Team", "memberCount": 2},
            {"id": "GRPyouth", "name": "Youth Night", "memberCount": null}
        ]),
    );
    answer(
        "/content/events/timeline",
        json!([
            {"id": "EVTsupper", "title": "Harvest Supper", "start": "2026-11-28T00:00:00.000Z",
             "end": "2026-11-28T02:00:00.000Z", "allDay": false, "recurrenceRule": null}
        ]),
    );
    answer(
        "/membership/forms",
        json!([{"id": "FRMfall", "name": "Fall Sign-up", "contentType": "form", "archived": false}]),
    );
    let people = PEOPLE
        .iter()
        .map(|(pid, name)| {
            let (first, last) = name.split_once(' ').unwrap();
            (
                (*pid).to_owned(),
                json!({"id": pid, "name": {"display": name, "first": first, "last": last}, "photo": null}),
            )
        })
        .collect();
    FakeB1 {
        answers: Mutex::new(answers),
        people,
        calls: Mutex::new(Vec::new()),
        clock,
        latency: Duration::from_millis(40),
    }
}

/// A key store in memory, keyed by (workspace, organization).
#[derive(Default)]
pub struct MemoryStore(pub Mutex<BTreeMap<(String, String), Vec<u8>>>);
impl CredentialStore for MemoryStore {
    fn put(&self, workspace: &str, organization: &str, value: &[u8]) -> Result<(), StoreError> {
        self.0.lock().unwrap().insert(
            (workspace.to_owned(), organization.to_owned()),
            value.to_vec(),
        );
        Ok(())
    }
    fn get(&self, workspace: &str, organization: &str) -> Result<Option<Vec<u8>>, StoreError> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .get(&(workspace.to_owned(), organization.to_owned()))
            .cloned())
    }
    fn delete(&self, workspace: &str, organization: &str) -> Result<(), StoreError> {
        self.0
            .lock()
            .unwrap()
            .remove(&(workspace.to_owned(), organization.to_owned()));
        Ok(())
    }
    fn accounts(&self) -> Result<Vec<(String, String)>, StoreError> {
        Ok(self.0.lock().unwrap().keys().cloned().collect())
    }
}

/// A fixed table of zone offsets for tests, with 2026's clock changes: Chicago and New York (US), Auckland and McMurdo,
/// and Sydney.
pub struct FakeZones(Vec<(&'static str, Vec<(i64, i32)>)>);
impl FakeZones {
    pub fn standard() -> FakeZones {
        let at = |t: &str| crate::capture::Time::parse(t).unwrap().unix_millis() / 1000;
        FakeZones(vec![
            (
                "America/Chicago",
                vec![
                    (i64::MIN, -21_600),
                    (at("2026-03-08T08:00:00Z"), -18_000),
                    (at("2026-11-01T07:00:00Z"), -21_600),
                ],
            ),
            (
                "America/New_York",
                vec![
                    (i64::MIN, -18_000),
                    (at("2026-03-08T07:00:00Z"), -14_400),
                    (at("2026-11-01T06:00:00Z"), -18_000),
                ],
            ),
            (
                "Pacific/Auckland",
                vec![
                    (i64::MIN, 46_800),
                    (at("2026-04-04T14:00:00Z"), 43_200),
                    (at("2026-09-26T14:00:00Z"), 46_800),
                ],
            ),
            // Same rules as Auckland.
            (
                "Antarctica/McMurdo",
                vec![
                    (i64::MIN, 46_800),
                    (at("2026-04-04T14:00:00Z"), 43_200),
                    (at("2026-09-26T14:00:00Z"), 46_800),
                ],
            ),
            (
                "Australia/Sydney",
                vec![
                    (i64::MIN, 39_600),
                    (at("2026-04-04T16:00:00Z"), 36_000),
                    (at("2026-10-03T16:00:00Z"), 39_600),
                ],
            ),
            ("Pacific/Honolulu", vec![(i64::MIN, -36_000)]),
            ("Asia/Kolkata", vec![(i64::MIN, 19_800)]),
            ("Pacific/Kiritimati", vec![(i64::MIN, 50_400)]),
            ("UTC", vec![(i64::MIN, 0)]),
        ])
    }
}
impl crate::zones::ZoneOffsets for FakeZones {
    fn offset_seconds(&self, zone: &crate::capture::ZoneName, at_unix: i64) -> Option<i32> {
        let (_, rules) = self.0.iter().find(|(name, _)| *name == zone.as_str())?;
        rules
            .iter()
            .rev()
            .find(|(from, _)| *from <= at_unix)
            .map(|(_, o)| *o)
    }
}

/// The full fictional Breeze account, as the developer tool's tests and this crate's tests both use it.
pub mod breeze {
    use super::*;
    const CHURCH: &str = "cedarhollow";
    const INSTANCE: &str = "4401";

    pub fn fixture(clock: Arc<FakeClock>) -> FakeB1 {
        let fake = FakeB1::empty(clock);
        fake.set(
            "/api/account/summary",
            ok(json!({"id": "1001", "name": "Cedar Hollow Fellowship", "subdomain": CHURCH, "status": "1",
                      "created_on": "2020-01-01 00:00:00",
                      "details": {"timezone": "America/Chicago", "country": {"id": "1", "name": "United States"}}})),
        );
        // Breeze's live shape (2026-11-17): local wall-clock times in the account's zone.
        let service = json!({"id": INSTANCE, "oid": "1001", "event_id": "77", "name": "Sunday Gathering",
            "category_id": "0", "settings_id": "5", "start_datetime": "2026-11-22 09:00:00",
            "end_datetime": "2026-11-22 10:30:00", "is_modified": "0", "created_on": "2026-01-01 00:00:00"});
        fake.set("/api/events/list_event", ok(service.clone()));
        fake.set(
            "/api/events",
            ok(json!([service, {"id": "4402", "name": "Harvest Supper", "start_datetime": "2026-11-27 18:00:00",
                               "end_datetime": "0000-00-00 00:00:00"}])),
        );
        fake.set(
            "/api/volunteers/list_roles",
            ok(json!([{"id": "9627", "name": "Vocals", "quantity": "2"},
                      {"id": "9628", "name": "Greeter", "quantity": "1"},
                      {"id": "9629", "name": "Sound", "quantity": "1"}])),
        );
        fake.set(
            "/api/volunteers/list",
            ok(json!([
                {"id": "501", "oid": "1001", "instance_id": INSTANCE, "person_id": "157857", "response": "0",
                 "comment": "", "rsvped_on": "0000-00-00 00:00:00", "created_on": "2026-11-01 08:00:00",
                 "role_ids": ["9627"]},
                {"id": "502", "instance_id": INSTANCE, "person_id": "157858", "response": "1",
                 "role_ids": ["9627", "9628"]},
                {"id": "503", "instance_id": INSTANCE, "person_id": "157859", "response": "2",
                 "rsvped_on": "0000-00-00 00:00:00", "role_ids": ["9629"]},
                // On the service in no role (`role_ids` null, a documented shape).
                {"id": "504", "instance_id": INSTANCE, "person_id": "157860", "response": "2", "role_ids": null}
            ])),
        );
        fake.set(
            "/api/people",
            ok(json!([
                {"id": "157857", "first_name": "Avery", "last_name": "Quillfeather", "path": "img/profiles/generic/blue.jpg"},
                {"id": "157858", "first_name": "Blake", "last_name": "Marrowstone"},
                {"id": "157859", "first_name": "Casey", "last_name": "Thimbleton"},
                {"id": "157860", "first_name": "Ellis", "last_name": "Brightwater"}
            ])),
        );
        fake.set(
            "/api/tags/list_tags",
            ok(json!([{"id": "301", "name": "Worship Team", "created_on": "2024-01-01 00:00:00", "folder_id": "1"}])),
        );
        fake.set(
            "/api/forms/list_forms",
            ok(
                json!([{"id": "41", "name": "Fall Sign-up", "created_on": "2026-09-01 10:00:00", "folder_id": "0",
                        "is_archived": "0", "url_slug": "fall"},
                       {"id": "42", "name": "Prayer Card", "created_on": "2025-02-01 10:00:00", "folder_id": "0",
                        "is_archived": "0", "url_slug": "prayer"}]),
            ),
        );
        // Entries without `details=1`, in the live shape (2026-11-17): an object keyed by entry id; an empty form `{}`.
        fake.set(
            "/api/forms/list_form_entries?form_id=41",
            ok(json!({
                "9001": {"id": "9001", "oid": "1001", "form_id": "41", "created_on": "2026-09-02 08:00:00",
                         "person_id": "157857", "response": {"person_id": ""}},
                "9002": {"id": "9002", "oid": "1001", "form_id": "41", "created_on": "2026-09-03 08:00:00",
                         "person_id": null, "response": {"person_id": ""}}
            })),
        );
        fake.set("/api/forms/list_form_entries?form_id=42", ok(json!({})));
        // Check-ins for the service (only read once it has started).
        fake.set(
            "/api/events/attendance/list",
            ok(json!([{"id": "7001", "instance_id": INSTANCE, "person_id": "157857", "time_in": "2026-11-22 08:50:00"},
                      {"id": "7002", "instance_id": INSTANCE, "person_id": "157859", "time_in": "2026-11-22 08:55:00"},
                      {"id": "7003", "instance_id": INSTANCE, "person_id": "157860", "time_in": "2026-11-22 08:58:00"}])),
        );
        fake
    }
}

/// The full fictional Genesis account, as the developer tool's tests and this crate's tests both use it.
pub mod genesis {
    use super::*;
    const CHURCH: &str = "5f0c2a4e-1b7d-4c3e-9a10-fictional001";
    const P: &str = "/functions/v1/public-api/v1";

    pub fn fixture(clock: Arc<FakeClock>) -> FakeB1 {
        let fake = FakeB1::empty(clock);
        fake.set(
            &format!("{P}/me"),
            ok(
                json!({"church": {"id": CHURCH, "name": "Cedar Hollow Fellowship"},
                      "permissions": ["groups:read", "events:read", "forms:read"]}),
            ),
        );
        fake.set(
            &format!("{P}/groups"),
            ok(json!({"data": [
                {"id": "grp-1", "name": "Tuesday Bible Study", "description": "", "group_type": "small_group",
                 "is_public": true, "frequency_label": "Weekly", "meeting_day": "Tuesday", "meeting_frequency": "weekly",
                 "meeting_time": "19:00", "meeting_location": "Fellowship Hall", "meeting_room": null, "schedule": "",
                 "meeting_dates": [], "upcoming_meeting_dates": [], "next_meeting_date": null, "member_count": 12},
                {"id": "grp-2", "name": "Youth Night", "group_type": "ministry", "meeting_room": null}
            ], "limit": 200, "offset": 0})),
        );
        fake.set(
            &format!("{P}/events"),
            ok(json!({"data": [
                {"id": "evt-1", "title": "Sunday Gathering", "event_type": "service", "start_date": "2026-11-22",
                 "start_time": "09:00:00", "end_date": null, "end_time": "10:30:00", "location_name": "Main Hall",
                 "is_published": true, "attendance_adults": 90, "attendance_children": 40, "attendance_students": 12},
                {"id": "evt-2", "title": "Harvest Supper", "event_type": "meal", "start_date": "2026-11-27",
                 "start_time": "18:00:00", "end_date": "2026-11-27", "end_time": null, "location_name": "Hall",
                 "is_published": true, "attendance_adults": 10, "attendance_children": null, "attendance_students": 0}
            ], "limit": 200, "offset": 0})),
        );
        fake.set(
            &format!("{P}/forms"),
            ok(json!({"data": [
                {"id": "FRMfall", "name": "Fall Sign-up", "title": "Fall Sign-up", "description": "", "purpose": "signup",
                 "is_active": true, "created_at": "2026-09-01T10:00:00-05:00"},
                {"id": "FRMcare", "name": "Prayer Card"}],
                      "limit": 200, "offset": 0})),
        );
        fake.set(
            &format!("{P}/forms/FRMfall/submissions"),
            ok(json!({"data": [
                {"id": "sub-1", "answers": {"name": "Avery Quillfeather"}},
                {"id": "sub-2", "answers": {"name": "Blake Marrowstone"}}
            ], "limit": 200, "offset": 0})),
        );
        fake.set(
            &format!("{P}/forms/FRMcare/submissions"),
            ok(json!({"data": [], "limit": 200, "offset": 0})),
        );
        fake
    }
}

/// The text without any whitespace, for the source scans.
pub fn squeeze(text: &str) -> String {
    text.chars().filter(|c| !c.is_whitespace()).collect()
}
/// Whether `word` appears as a whole identifier (not inside a longer one).
pub fn has_word(text: &str, word: &str) -> bool {
    let ident = |c: Option<char>| c.is_some_and(|c| c.is_alphanumeric() || c == '_');
    text.match_indices(word).any(|(at, _)| {
        !ident(text[..at].chars().next_back()) && !ident(text[at + word.len()..].chars().next())
    })
}
/// How many requests one source file builds: client GETs, POSTs and sends.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Built {
    pub gets: usize,
    pub posts: usize,
    pub executes: usize,
}
/// The source scan behind http.rs `allowed`, for one file (`name` is its path from its crate's src): it panics on any
/// way to build a request other than a GET, to change a built one, or to name the HTTP library outside http.rs, and
/// counts the GETs, POSTs and sends it finds. Needles are assembled here so this file doesn't contain them either.
/// No POST exists anywhere, http.rs included. The developer tool's crate runs it over its own files too.
pub fn scan_requests(name: &str, text: &str) -> Built {
    let post = [".po", "st("].concat();
    let forbidden: Vec<String> = [
        [".pu", "t("],
        [".pat", "ch("],
        [".del", "ete("],
        [".he", "ad("],
        ["::po", "st("],
        ["::pu", "t("],
        ["::pat", "ch("],
        ["::del", "ete("],
        ["::he", "ad("],
        [".requ", "est("],
        ["method", "_mut"],
        ["from_", "parts"],
        // Changing a built request's address, headers or body (review C, M1).
        ["url", "_mut"],
        [".set_", "path("],
        [".set_", "query("],
        [".set_", "host("],
        [".set_", "port("],
        ["headers", "_mut"],
        ["body", "_mut"],
    ]
    .iter()
    .map(|p| p.concat())
    .collect();
    // Words that name (or rename) the HTTP library's method type, anywhere, as a whole identifier.
    let words: Vec<String> = [["Meth", "od"], ["Ve", "rb"]]
        .iter()
        .map(|p| p.concat())
        .collect();
    let client = ["reqw", "est"].concat();
    let get_call = ["client.", "get("].concat();
    let execute = [".exec", "ute("].concat();
    let mut flat = squeeze(text);
    // The one named exception: keys.rs saves and forgets a key through the Keychain trait, called by its path.
    if name == "keys.rs" {
        for allowed in [
            ["CredentialStore::p", "ut("],
            ["CredentialStore::del", "ete("],
        ] {
            flat = flat.replace(&allowed.concat(), "CredentialStore-call(");
        }
    }
    for needle in &forbidden {
        assert!(!flat.contains(needle.as_str()), "{name}: {needle}");
    }
    for word in &words {
        assert!(!has_word(text, word), "{name}: {word}");
    }
    if name != "http.rs" {
        assert!(!text.contains(&client), "{name} names the HTTP library");
    }
    // No POST in any file.
    let posts = flat.matches(post.as_str()).count();
    assert_eq!(posts, 0, "{name}: {post}");
    if name == "http.rs" {
        assert_eq!(flat.matches(get_call.as_str()).count(), 1);
        assert!(flat.contains(&["redirect::Policy::", "none()"].concat()));
        assert!(flat.contains(&[".https_", "only(true)"].concat()));
        assert!(flat.contains(&[".no_", "proxy()"].concat()));
        assert!(flat.contains(&[".refer", "er(false)"].concat()));
    }
    Built {
        gets: flat.matches(get_call.as_str()).count(),
        posts,
        executes: flat.matches(execute.as_str()).count(),
    }
}
/// The developer tool takes nothing secret from the command line or the environment: no file reads the environment,
/// only `main` reads the command line (as command words), and only `save` reads standard input, through `key_from`.
/// Empty `main` and `dev` (the tool's crate isn't here) check `dev_support` alone.
pub fn dev_tool_inputs(main: &str, dev: &str, support: &str) {
    let var = ["env::", "var"].concat();
    let vars = ["env::", "vars"].concat();
    let args = ["env::", "args"].concat();
    for text in [main, dev, support] {
        assert!(!text.contains(&var) && !text.contains(&vars));
    }
    assert!(!dev.contains(&args) && !support.contains(&args));
    if !dev.is_empty() {
        assert!(main.contains(&args));
        assert_eq!(dev.matches("key_from(").count(), 2);
    }
}
