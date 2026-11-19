use super::*;
use crate::test_support::{
    Answer, FakeB1, FakeClock, NOW, breeze_key, breeze_key_text, id, key as b1_key, ok, raw,
};
use serde_json::json;
use std::sync::Arc;

const CHURCH: &str = "cedarhollow";
const INSTANCE: &str = "4401";

/// Every write path research 4 lists, and the money paths it says to avoid. Kept here, never in breeze.rs.
const WRITE_PATHS: &[&str] = &[
    "/api/people/add",
    "/api/people/update",
    "/api/people/delete",
    "/api/tags/add_tag",
    "/api/tags/add_tag_folder",
    "/api/tags/delete_tag",
    "/api/tags/delete_tag_folder",
    "/api/tags/assign",
    "/api/tags/unassign",
    "/api/events/add",
    "/api/events/delete",
    "/api/events/attendance/add",
    "/api/events/attendance/delete",
    "/api/forms/remove_form_entry",
    "/api/volunteers/add",
    "/api/volunteers/remove",
    "/api/volunteers/update",
    "/api/volunteers/add_role",
    "/api/volunteers/remove_role",
    "/api/families/create",
    "/api/families/destroy",
    "/api/families/add",
    "/api/families/remove",
    "/api/giving/add",
    "/api/giving/edit",
    "/api/giving/delete",
    "/api/giving/list",
    "/api/funds",
    "/api/pledges",
];
/// The verbs research 4 recommends refusing as a second line, and the areas never to touch.
const WRITE_WORDS: &[&str] = &[
    "add",
    "update",
    "delete",
    "remove",
    "assign",
    "unassign",
    "create",
    "destroy",
    "edit",
    "add_tag",
    "add_tag_folder",
    "delete_tag",
    "delete_tag_folder",
    "remove_form_entry",
    "add_role",
    "remove_role",
    "families",
    "giving",
    "funds",
    "pledges",
    "payment",
    "payments",
    "list_log",
];
/// The exact read paths, and the query names each may carry.
const READ_PATHS: &[(&str, &[&str])] = &[
    ("/api/account/summary", &[]),
    ("/api/events", &["start", "end", "limit"]),
    ("/api/events/list_event", &["instance_id"]),
    ("/api/volunteers/list", &["instance_id"]),
    (
        "/api/volunteers/list_roles",
        &["instance_id", "show_quantity"],
    ),
    ("/api/people", &["details", "limit"]),
    ("/api/tags/list_tags", &[]),
    ("/api/forms/list_forms", &[]),
    ("/api/forms/list_form_entries", &["form_id"]),
    ("/api/events/attendance/list", &["instance_id", "type"]),
];

fn every_read() -> Vec<Read> {
    let day = Date::parse("2026-11-22").unwrap();
    let all = vec![
        Read::Account,
        Read::Events {
            start: day,
            end: day.next_day().unwrap(),
        },
        Read::Event(id(INSTANCE)),
        Read::Volunteers(id(INSTANCE)),
        Read::Roles(id(INSTANCE)),
        Read::People,
        Read::Tags,
        Read::Forms,
        Read::FormEntries(id("41")),
        Read::Attendance(id(INSTANCE)),
    ];
    fn index(read: &Read) -> usize {
        match read {
            Read::Account => 0,
            Read::Events { .. } => 1,
            Read::Event(_) => 2,
            Read::Volunteers(_) => 3,
            Read::Roles(_) => 4,
            Read::People => 5,
            Read::Tags => 6,
            Read::Forms => 7,
            Read::FormEntries(_) => 8,
            Read::Attendance(_) => 9,
        }
    }
    let covered: BTreeSet<usize> = all.iter().map(index).collect();
    assert_eq!(covered, (0..=9).collect());
    all
}

pub(crate) use crate::test_support::breeze::fixture;
fn setup() -> (FakeB1, Arc<FakeClock>) {
    let clock = FakeClock::at(NOW);
    (fixture(clock.clone()), clock)
}
fn run_check(fake: &FakeB1, clock: &FakeClock) -> SystemCapture {
    check(
        fake,
        clock,
        &crate::test_support::FakeZones::standard(),
        &breeze_key(),
        &id(CHURCH),
        &id(INSTANCE),
        None,
    )
    .unwrap()
}
fn outcome(capture: &SystemCapture, word: ReadWord) -> Outcome {
    capture
        .reads()
        .iter()
        .find(|r| r.read == word)
        .unwrap()
        .outcome
}

#[test]
fn every_read_is_a_get_of_an_exact_read_path_at_the_churchs_own_address() {
    let http = crate::http::NativeHttp::new().unwrap();
    let host = church_host(&id(CHURCH)).unwrap();
    for read in every_read() {
        let get = Get::new(
            &At {
                host: &host,
                read: &read,
            },
            Auth::ApiKey(breeze_key()),
        );
        let url = get.url();
        assert_eq!(url.scheme(), "https");
        assert_eq!(url.host_str(), Some("cedarhollow.breezechms.com"));
        assert_eq!(url.port(), None);
        assert_eq!(get.method(), "GET");
        let allowed = READ_PATHS
            .iter()
            .find(|(path, _)| *path == url.path())
            .unwrap_or_else(|| panic!("{read:?}: {} is not a listed read path", url.path()));
        for (name, value) in url.query_pairs() {
            assert!(allowed.1.contains(&name.as_ref()), "{read:?}: {name}");
            for word in WRITE_WORDS {
                assert!(!value.eq_ignore_ascii_case(word), "{read:?}: {value}");
            }
        }
        for write in WRITE_PATHS {
            assert!(!url.as_str().contains(write), "{read:?}: {write}");
        }
        for segment in url.path_segments().unwrap() {
            assert!(
                !WRITE_WORDS.iter().any(|w| segment.eq_ignore_ascii_case(w)),
                "{read:?}: {segment}"
            );
        }
        let built = http.build(&get).unwrap();
        assert_eq!(built.method().as_str(), "GET");
        assert!(built.body().is_none());
        assert_eq!(built.url(), url);
        assert!(built.headers()["api-key"].is_sensitive());
        assert_eq!(
            built.headers()["api-key"].to_str().unwrap(),
            breeze_key_text()
        );
        assert!(built.headers().get("authorization").is_none());
        assert!(!url.as_str().contains(&breeze_key_text()));
    }
}

#[test]
fn breeze_rs_names_no_write_path() {
    let text = include_str!("breeze.rs");
    for write in WRITE_PATHS {
        let tail = write.trim_start_matches("/api/");
        assert!(!text.contains(tail), "{write}");
    }
    for word in WRITE_WORDS {
        assert!(!text.contains(&format!("F(\"{word}\")")), "{word}");
        assert!(!text.contains(&format!("\"{word}\"")), "{word}");
    }
}

#[test]
fn only_a_subdomain_can_be_a_church() {
    let (fake, clock) = setup();
    for bad in ["Cedar", "-cedar", "cedar-", "cedar_hollow", &"a".repeat(64)] {
        assert_eq!(
            check(
                &fake,
                &*clock,
                &crate::test_support::FakeZones::standard(),
                &breeze_key(),
                &id(bad),
                &id(INSTANCE),
                None
            )
            .unwrap_err(),
            ReadError::NotFound,
            "{bad}"
        );
    }
    assert_eq!(
        check(
            &fake,
            &*clock,
            &crate::test_support::FakeZones::standard(),
            &b1_key(),
            &id(CHURCH),
            &id(INSTANCE),
            None
        )
        .unwrap_err(),
        ReadError::KeyRefused
    );
    assert!(fake.calls().is_empty());
}

#[test]
fn a_full_check_gives_the_expected_capture() {
    let (fake, clock) = setup();
    let capture = run_check(&fake, &clock);
    let words: Vec<(&str, Outcome)> = capture
        .reads()
        .iter()
        .map(|r| (r.read.as_str(), r.outcome))
        .collect();
    // Attendance is read only once the service has started; this one is next Sunday.
    assert_eq!(
        words,
        READS
            .iter()
            .map(|w| (
                w.as_str(),
                if *w == ATTENDANCE {
                    Outcome::NotRequested
                } else {
                    Outcome::Ok
                }
            ))
            .collect::<Vec<_>>()
    );
    assert_eq!(capture.system(), System::Breeze);
    assert_eq!(capture.church().id, id(CHURCH));
    assert_eq!(
        capture.church().time_zone.as_ref().unwrap().as_str(),
        "America/Chicago"
    );
    let service = capture.service().unwrap();
    assert_eq!(service.id, id(INSTANCE));
    assert_eq!(service.starts_at.as_str(), "2026-11-22T09:00:00-06:00");
    // Breeze's local times, placed in the account's zone: the day is the local day of the start.
    assert_eq!(
        service.ends_at.as_ref().unwrap().as_str(),
        "2026-11-22T10:30:00-06:00"
    );
    assert_eq!(service.day.unwrap().to_string(), "2026-11-22");
    let needed: Vec<(&str, Option<u32>, Option<&Id>)> = capture
        .positions()
        .iter()
        .map(|p| (p.id.as_str(), p.needed, p.team_id.as_ref()))
        .collect();
    assert_eq!(
        needed,
        vec![
            ("9627", Some(2), None),
            ("9628", Some(1), None),
            ("9629", Some(1), None)
        ]
    );
    let assigned: Vec<(&str, &str, &str, Status)> = capture
        .assignments()
        .iter()
        .map(|a| {
            (
                a.id.as_str(),
                a.position_id.as_str(),
                a.person_id.as_str(),
                a.status,
            )
        })
        .collect();
    assert_eq!(
        assigned,
        vec![
            ("501-9627", "9627", "157857", Status::Unconfirmed),
            ("502-9627", "9627", "157858", Status::Declined),
            ("502-9628", "9628", "157858", Status::Declined),
            ("503-9629", "9629", "157859", Status::Accepted),
        ]
    );
    // The volunteer with no role is on the service, in no role, with no assignment.
    assert_eq!(capture.on_service(), &[id("157860")]);
    // Names for the scheduled people only.
    let names: Vec<&str> = capture.names().values().map(Name::as_str).collect();
    assert_eq!(
        names,
        vec![
            "Avery Quillfeather",
            "Blake Marrowstone",
            "Casey Thimbleton",
            "Ellis Brightwater"
        ]
    );
    assert!(capture.blockouts().is_none());
    assert!(capture.team_members().is_empty());
    assert_eq!(capture.events().len(), 2);
    assert!(capture.events()[1].ends_at.is_none());
    assert!(capture.events().iter().all(|e| e.attendance.is_none()));
    assert_eq!(capture.groups()[0].members, None);
    // Entry counts for the newest forms, counts only.
    let counts: Vec<(&str, Option<u32>)> = capture
        .forms()
        .iter()
        .map(|f| (f.id.as_str(), f.submissions))
        .collect();
    assert_eq!(counts, vec![("41", Some(2)), ("42", Some(0))]);
    let labels: BTreeMap<String, &str> = capture
        .labels()
        .iter()
        .map(|(k, v)| (k.to_string(), v.as_str()))
        .collect();
    assert_eq!(labels["church"], "Cedar Hollow Fellowship");
    assert_eq!(labels["service"], "Sunday Gathering");
    assert_eq!(labels["position:9629"], "Sound");
    assert_eq!(labels["group:301"], "Worship Team");
    assert_eq!(labels["form:41"], "Fall Sign-up");
    let text = capture.to_json().unwrap();
    assert_eq!(SystemCapture::from_json(text.as_bytes()).unwrap(), capture);
    assert!(!text.contains(&breeze_key_text()));
    let mut value: Value = serde_json::from_str(&text).unwrap();
    value.as_object_mut().unwrap().remove("names");
    for part in [
        "Avery",
        "Quillfeather",
        "Blake",
        "Marrowstone",
        "Casey",
        "Ellis",
        "Brightwater",
    ] {
        assert!(!value.to_string().contains(part));
    }
    // Paced for 20 a minute, within 14, GET only, the key only in its header.
    let calls = fake.calls();
    assert_eq!(calls.len(), 10);
    for pair in calls.windows(2) {
        assert!(pair[1].at - pair[0].at >= Duration::from_millis(3500));
    }
    for call in &calls {
        assert_eq!(call.method, "GET");
        assert_eq!(call.auth, breeze_key_text());
        assert!(!call.url.contains(&breeze_key_text()));
    }
}

#[test]
fn a_local_time_without_the_accounts_zone_leaves_the_service_and_events_out() {
    let (fake, clock) = setup();
    fake.set(
        "/api/account/summary",
        ok(json!({"id": "1001", "name": "Cedar Hollow Fellowship", "subdomain": CHURCH, "details": {}})),
    );
    fake.set(
        "/api/events/list_event",
        ok(json!({"id": INSTANCE, "name": "Sunday Gathering", "start_datetime": "2026-11-22 09:00:00",
                  "end_datetime": "2026-11-22 10:30:00"})),
    );
    let capture = run_check(&fake, &clock);
    assert_eq!(outcome(&capture, EVENTS), Outcome::InvalidResponse);
    assert!(capture.service().is_none() && capture.events().is_empty());
    assert!(!capture.labels().contains_key(&LabelKey::Service));
    // The rest is still read.
    assert_eq!(outcome(&capture, ROLES), Outcome::Ok);
    // A window that fails leaves out the service it came with.
    let (fake, clock) = setup();
    fake.set(
        "/api/events",
        ok(json!([{"id": "4402", "start_datetime": "next Friday at six"}])),
    );
    let capture = run_check(&fake, &clock);
    assert_eq!(outcome(&capture, EVENTS), Outcome::InvalidResponse);
    assert!(capture.service().is_none());
    // Another instance than the one asked is refused.
    let (fake, clock) = setup();
    fake.set(
        "/api/events/list_event",
        ok(json!({"id": "9999", "start_datetime": "2026-11-22T09:00:00-06:00"})),
    );
    assert_eq!(
        outcome(&run_check(&fake, &clock), EVENTS),
        Outcome::InvalidResponse
    );
}

#[test]
fn a_window_the_run_stops_before_keeps_the_service_as_truncated() {
    let (fake, clock) = setup();
    let limits = Limits {
        max_requests: 2,
        ..LIMITS
    };
    let capture = check_with(
        &fake,
        &*clock,
        &crate::test_support::FakeZones::standard(),
        &breeze_key(),
        &id(CHURCH),
        &id(INSTANCE),
        None,
        limits,
    )
    .unwrap();
    assert_eq!(outcome(&capture, EVENTS), Outcome::Truncated);
    assert!(capture.service().is_some() && capture.events().is_empty());
    assert_eq!(outcome(&capture, ROLES), Outcome::NotRequested);
    assert_eq!(fake.calls().len(), 2);
}

/// Breeze's answer codes, confirmed live (2026-11-17, older volunteers page): "0" no response, "1" declined, "2"
/// accepted. Anything else is unknown.
#[test]
fn answers_are_the_codes_confirmed_live() {
    for (response, status) in [
        (json!("0"), Status::Unconfirmed),
        (json!("1"), Status::Declined),
        (json!("2"), Status::Accepted),
        (json!(1), Status::Declined),
        (json!("3"), Status::Unknown),
        (json!("yes"), Status::Unknown),
        (Value::Null, Status::Unknown),
    ] {
        assert_eq!(answer(&response), status, "{response}");
    }
}

#[test]
fn volunteers_without_a_role_or_with_an_unknown_role() {
    let (fake, clock) = setup();
    fake.set(
        "/api/volunteers/list",
        ok(
            json!([{"id": "501", "person_id": "157857", "response": "0", "role_ids": ["9627"]},
                  {"id": "503", "person_id": "157859", "response": "0", "role_ids": null}]),
        ),
    );
    let capture = run_check(&fake, &clock);
    // A volunteer with no role is on the service in no role: the read is whole.
    assert_eq!(outcome(&capture, VOLUNTEERS), Outcome::Ok);
    assert_eq!(capture.assignments().len(), 1);
    assert_eq!(capture.on_service(), &[id("157859")]);
    capture.valid().unwrap();
    for bad in [
        json!([{"id": "501", "person_id": "157857", "role_ids": ["8888"]}]),
        json!([{"id": "501", "person_id": "157857", "role_ids": "9627"}]),
        json!([{"id": "501", "person_id": 157857, "role_ids": ["9627"]}]),
        json!([{"id": "501", "person_id": "157857", "role_ids": [9627]}]),
        json!({"success": false}),
    ] {
        let (fake, clock) = setup();
        fake.set("/api/volunteers/list", ok(bad.clone()));
        let capture = run_check(&fake, &clock);
        assert_eq!(
            outcome(&capture, VOLUNTEERS),
            Outcome::InvalidResponse,
            "{bad}"
        );
        assert!(capture.assignments().is_empty());
        assert_eq!(outcome(&capture, PEOPLE), Outcome::NotRequested);
    }
}

#[test]
fn a_wrong_quantity_rejects_the_roles() {
    for bad in [
        json!("two"),
        json!("-1"),
        json!("1.5"),
        json!(true),
        json!("9999999"),
    ] {
        let (fake, clock) = setup();
        fake.set(
            "/api/volunteers/list_roles",
            ok(json!([{"id": "9627", "name": "Vocals", "quantity": bad}])),
        );
        let capture = run_check(&fake, &clock);
        assert_eq!(outcome(&capture, ROLES), Outcome::InvalidResponse);
        assert!(capture.positions().is_empty());
        assert_eq!(outcome(&capture, VOLUNTEERS), Outcome::NotRequested);
    }
}

#[test]
fn a_refused_or_wrong_account_stops_or_flags_the_check() {
    for answer in [raw(401, "{}"), raw(403, "")] {
        let (fake, clock) = setup();
        fake.set("/api/account/summary", answer);
        let capture = run_check(&fake, &clock);
        assert_eq!(outcome(&capture, ACCOUNT), Outcome::KeyRefused);
        assert!(
            capture.reads()[1..]
                .iter()
                .all(|r| r.outcome == Outcome::NotRequested)
        );
        assert_eq!(fake.calls().len(), 1);
    }
    let (fake, clock) = setup();
    fake.set(
        "/api/account/summary",
        ok(json!({"id": "1", "name": "Other", "subdomain": "otherchurch"})),
    );
    let capture = run_check(&fake, &clock);
    assert_eq!(outcome(&capture, ACCOUNT), Outcome::InvalidResponse);
    assert!(capture.church().time_zone.is_none());
    // A zone Ozzie can't read is left out and the read says so.
    let (fake, clock) = setup();
    fake.set(
        "/api/account/summary",
        ok(json!({"id": "1001", "name": "Cedar", "subdomain": CHURCH, "details": {"timezone": "Eastern"}})),
    );
    assert_eq!(
        outcome(&run_check(&fake, &clock), ACCOUNT),
        Outcome::Truncated
    );
    // 429, then the run stops.
    let (fake, clock) = setup();
    fake.set("/api/volunteers/list_roles", Answer::Retry(429, "30"));
    let capture = run_check(&fake, &clock);
    assert_eq!(outcome(&capture, ROLES), Outcome::RateLimited);
    assert_eq!(outcome(&capture, FORMS), Outcome::NotRequested);
}

#[test]
fn people_beyond_a_full_list_are_noted() {
    let (fake, clock) = setup();
    let many: Vec<Value> = (0..3000)
        .map(|n| json!({"id": format!("9{n}"), "first_name": "Fictional", "last_name": "Person"}))
        .collect();
    fake.set("/api/people", ok(Value::Array(many)));
    let capture = run_check(&fake, &clock);
    assert_eq!(outcome(&capture, PEOPLE), Outcome::Truncated);
    assert!(capture.names().is_empty());
}

#[test]
fn the_budget_and_the_breaker_hold() {
    let (mut fake, clock) = setup();
    fake.latency = Duration::from_secs(20);
    let capture = run_check(&fake, &clock);
    assert!(
        capture
            .reads()
            .iter()
            .any(|r| r.outcome == Outcome::Timeout)
    );
    assert!(fake.calls().len() <= 5);
    let first = fake.calls()[0].at;
    for call in fake.calls() {
        assert!(call.limit <= LIMITS.budget - (call.at - first));
    }
    let (fake, clock) = setup();
    fake.set("/api/volunteers/list_roles", raw(500, ""));
    fake.set("/api/tags/list_tags", Answer::Fail(ReadError::Unreachable));
    fake.set("/api/forms/list_forms", raw(502, ""));
    fake.set("/api/events/list_event", raw(500, ""));
    let capture = run_check(&fake, &clock);
    assert_eq!(outcome(&capture, EVENTS), Outcome::Refused);
    assert_eq!(outcome(&capture, ROLES), Outcome::Refused);
    assert_eq!(outcome(&capture, VOLUNTEERS), Outcome::NotRequested);
    assert_eq!(outcome(&capture, TAGS), Outcome::Unreachable);
    assert_eq!(outcome(&capture, FORMS), Outcome::NotRequested);
}

#[test]
fn verify_key_and_the_picker() {
    let (fake, clock) = setup();
    let church = verify_key(&fake, &*clock, &breeze_key(), &id(CHURCH), None).unwrap();
    assert_eq!(church.name.unwrap().as_str(), "Cedar Hollow Fellowship");
    for answer in [raw(401, "{}"), raw(403, "{}")] {
        let (fake, clock) = setup();
        fake.set("/api/account/summary", answer);
        assert_eq!(
            verify_key(&fake, &*clock, &breeze_key(), &id(CHURCH), None).unwrap_err(),
            ReadError::KeyRefused
        );
    }
    // The picker reads days as written, local times included, soonest first.
    let (fake, clock) = setup();
    fake.set(
        "/api/events",
        ok(json!([
            {"id": "4403", "name": "Advent One", "start_datetime": "2026-11-29 09:00:00"},
            {"id": INSTANCE, "name": "Sunday Gathering", "start_datetime": "2026-11-22T09:00:00-06:00"}
        ])),
    );
    let choices = events(&fake, &*clock, &breeze_key(), &id(CHURCH), None, None).unwrap();
    let listed: Vec<(&str, String)> = choices
        .iter()
        .map(|c| (c.id.as_str(), c.day.to_string()))
        .collect();
    assert_eq!(
        listed,
        vec![
            (INSTANCE, "2026-11-22".to_owned()),
            ("4403", "2026-11-29".to_owned())
        ]
    );
    let query = &fake.calls()[1].url;
    assert!(
        query.contains("start=2026-11-16") && query.contains("end=2026-12-14"),
        "{query}"
    );
    let (fake, clock) = setup();
    fake.set(
        "/api/events",
        ok(json!([{"id": "4403", "start_datetime": "next Sunday"}])),
    );
    assert_eq!(
        events(&fake, &*clock, &breeze_key(), &id(CHURCH), None, None).unwrap_err(),
        ReadError::InvalidResponse
    );
    assert_eq!(
        written_day("2026-11-22 09:00:00").unwrap().to_string(),
        "2026-11-22"
    );
    assert!(written_day("2026-11-22 9:00").is_none());
}

#[test]
fn the_key_is_in_its_header_only() {
    let (fake, clock) = setup();
    let capture = run_check(&fake, &clock);
    let host = church_host(&id(CHURCH)).unwrap();
    let get = Get::new(
        &At {
            host: &host,
            read: &Read::Account,
        },
        Auth::ApiKey(breeze_key()),
    );
    for text in [
        format!("{capture:?}"),
        capture.to_json().unwrap(),
        format!("{get:?}"),
        format!("{:?}", breeze_key()),
        format!(
            "{:?}",
            verify_key(&fake, &*clock, &breeze_key(), &id(CHURCH), None)
        ),
    ] {
        assert!(!text.contains(&breeze_key_text()));
    }
}

/// An event with no roles and nobody scheduled (seen live on Breeze's sample events): every read `ok`, nothing in the
/// lists, and nothing to name. The capture says plainly there are no roles; it doesn't say anything was missed.
#[test]
fn an_event_with_no_roles_and_no_volunteers_is_ok_and_empty() {
    let (fake, clock) = setup();
    fake.set("/api/volunteers/list_roles", ok(json!([])));
    fake.set("/api/volunteers/list", ok(json!([])));
    let capture = run_check(&fake, &clock);
    for word in [ROLES, VOLUNTEERS, PEOPLE] {
        assert_eq!(outcome(&capture, word), Outcome::Ok, "{word:?}");
    }
    assert!(
        capture.positions().is_empty()
            && capture.assignments().is_empty()
            && capture.names().is_empty()
    );
    assert!(capture.service().is_some());
    // Only the roles and volunteers reads are asked: no names read for nobody.
    assert!(!fake.paths().iter().any(|p| p == "/api/people"));
}

/// The answer codes are one table (`ANSWER_CODES`), on now that a live read confirmed it, with the registry's flag.
/// With no table every answer is unknown.
#[test]
fn answer_codes_switch_on_in_one_table() {
    assert_eq!(
        ANSWER_CODES,
        Some(
            &[
                ("0", Status::Unconfirmed),
                ("1", Status::Declined),
                ("2", Status::Accepted)
            ][..]
        )
    );
    assert!(System::Breeze.supplies().answers);
    let table: &[(&str, Status)] = &[
        ("0", Status::Unconfirmed),
        ("1", Status::Accepted),
        ("2", Status::Declined),
    ];
    for (code, status) in [
        (json!("0"), Status::Unconfirmed),
        (json!("1"), Status::Accepted),
        (json!("2"), Status::Declined),
        (json!(2), Status::Declined),
        (json!("3"), Status::Unknown),
        (json!(""), Status::Unknown),
        (Value::Null, Status::Unknown),
        (json!(true), Status::Unknown),
    ] {
        assert_eq!(answer_with(Some(table), &code), status, "{code}");
        assert_eq!(answer_with(None, &code), Status::Unknown, "{code}");
    }
}

/// The live shape from Breeze's older volunteers page: roles with `quantity` null (that page has no quantity), so the
/// number wanted is null; a volunteer with no role is on the service in no role, and the read is whole.
#[test]
fn live_roles_have_no_quantity_and_a_roleless_volunteer_is_on_the_service() {
    let (fake, clock) = setup();
    fake.set(
        "/api/volunteers/list_roles",
        ok(json!([{"id": "9627", "name": "Vocals", "quantity": null},
                  {"id": "9628", "name": "Guitar", "quantity": null}])),
    );
    fake.set(
        "/api/volunteers/list",
        ok(json!([
            {"id": "501", "person_id": "157857", "response": "1", "rsvped_on": "2026-11-17 10:00:00", "role_ids": ["9627"]},
            {"id": "505", "person_id": "157858", "response": "0", "rsvped_on": "0000-00-00 00:00:00", "role_ids": null}
        ])),
    );
    let capture = run_check(&fake, &clock);
    assert_eq!(outcome(&capture, ROLES), Outcome::Ok);
    assert!(capture.positions().iter().all(|p| p.needed.is_none()));
    assert_eq!(outcome(&capture, VOLUNTEERS), Outcome::Ok);
    assert_eq!(capture.assignments().len(), 1);
    assert_eq!(capture.on_service(), &[id("157858")]);
    assert_eq!(capture.assignments()[0].status, Status::Declined);
}

/// A volunteer with no role whom the people list doesn't name can't be kept (the capture names everyone on the
/// service), so they are left out and the volunteers read says so.
#[test]
fn a_roleless_volunteer_with_no_name_is_left_out_and_said() {
    let (fake, clock) = setup();
    fake.set(
        "/api/people",
        ok(json!([{"id": "157857", "first_name": "Avery", "last_name": "Quillfeather"}])),
    );
    let capture = run_check(&fake, &clock);
    assert!(capture.on_service().is_empty());
    assert_eq!(outcome(&capture, VOLUNTEERS), Outcome::Truncated);
    assert_eq!(outcome(&capture, PEOPLE), Outcome::Truncated);
    // A person with a role elsewhere on the service is in no role only if they hold none.
    let (fake, clock) = setup();
    fake.set(
        "/api/volunteers/list",
        ok(
            json!([{"id": "501", "person_id": "157857", "response": "0", "role_ids": ["9627"]},
                  {"id": "509", "person_id": "157857", "response": "0", "role_ids": []}]),
        ),
    );
    let capture = run_check(&fake, &clock);
    assert!(capture.on_service().is_empty());
    assert_eq!(outcome(&capture, VOLUNTEERS), Outcome::Ok);
}

/// Review E, M2: a 401 or 403 on the first read means the key doesn't open the church (`key-refused`); after a read
/// was answered, it is that read refused (`refused`) and the run goes on. Only a 429 is `rate-limited`.
#[test]
fn a_refusal_after_an_answered_read_is_that_read_refused() {
    for answer in [raw(401, "{}"), raw(403, "")] {
        let (fake, clock) = setup();
        fake.set("/api/volunteers/list_roles", answer.clone());
        let capture = run_check(&fake, &clock);
        assert_eq!(outcome(&capture, ACCOUNT), Outcome::Ok);
        assert_eq!(outcome(&capture, ROLES), Outcome::Refused);
        assert_eq!(outcome(&capture, VOLUNTEERS), Outcome::NotRequested);
        assert_eq!(outcome(&capture, TAGS), Outcome::Ok);
        assert_eq!(outcome(&capture, FORMS), Outcome::Ok);
        // The picker: its second read.
        let (fake, clock) = setup();
        fake.set("/api/events", answer);
        assert_eq!(
            events(&fake, &*clock, &breeze_key(), &id(CHURCH), None, None).unwrap_err(),
            ReadError::Refused
        );
    }
    // Everything after the first read refused: the breaker stops the run after three in a row.
    let (fake, clock) = setup();
    for path in [
        "/api/events/list_event",
        "/api/volunteers/list_roles",
        "/api/tags/list_tags",
    ] {
        fake.set(path, raw(403, ""));
    }
    let capture = run_check(&fake, &clock);
    assert_eq!(outcome(&capture, TAGS), Outcome::Refused);
    assert_eq!(outcome(&capture, FORMS), Outcome::NotRequested);
}

/// The events list asks for one more than the capture keeps (Breeze's `limit`, at most 1000 in its docs), so a list
/// Breeze cut, or one longer than the cap, is `truncated`.
#[test]
fn the_events_list_asks_for_one_more_than_it_keeps() {
    let (fake, clock) = setup();
    let capture = run_check(&fake, &clock);
    assert_eq!(outcome(&capture, EVENTS), Outcome::Ok);
    let url = fake
        .calls()
        .iter()
        .find(|c| c.url.contains("/api/events?"))
        .unwrap()
        .url
        .clone();
    assert!(url.contains(&format!("limit={}", MAX_EVENTS + 1)), "{url}");
    let (fake, clock) = setup();
    let service = json!({"id": INSTANCE, "name": "Sunday Gathering", "start_datetime": "2026-11-22 09:00:00",
                         "end_datetime": "2026-11-22 10:30:00"});
    let mut rows = vec![service];
    rows.extend(
        (0..MAX_EVENTS)
            .map(|n| json!({"id": format!("5{n:03}"), "start_datetime": "2026-11-28 18:00:00"})),
    );
    fake.set("/api/events", ok(Value::Array(rows)));
    let capture = run_check(&fake, &clock);
    assert_eq!(outcome(&capture, EVENTS), Outcome::Truncated);
    assert_eq!(capture.events().len(), MAX_EVENTS);
}

/// Entry counts for at most the 5 newest forms, one request each, with no `details` (so no answers); the rest stay
/// null and the read is `truncated`.
#[test]
fn form_entry_counts_for_the_five_newest_forms_only() {
    let (fake, clock) = setup();
    let forms: Vec<Value> = (1..=7)
        .map(|n| json!({"id": format!("6{n}"), "name": format!("Form {n}"), "created_on": format!("2026-0{n}-01 10:00:00")}))
        .collect();
    fake.set("/api/forms/list_forms", ok(Value::Array(forms)));
    for n in 1..=7 {
        let rows: Vec<Value> = (0..n)
            .map(|e| json!({"id": format!("8{n}{e}"), "form_id": format!("6{n}")}))
            .collect();
        fake.set(
            &format!("/api/forms/list_form_entries?form_id=6{n}"),
            ok(Value::Array(rows)),
        );
    }
    let capture = run_check(&fake, &clock);
    assert_eq!(outcome(&capture, FORM_ENTRIES), Outcome::Truncated);
    let counts: BTreeMap<&str, Option<u32>> = capture
        .forms()
        .iter()
        .map(|f| (f.id.as_str(), f.submissions))
        .collect();
    assert_eq!(counts["67"], Some(7));
    assert_eq!(counts["63"], Some(3));
    assert_eq!(counts["62"], None);
    assert_eq!(counts["61"], None);
    let asked: Vec<String> = fake
        .calls()
        .iter()
        .filter(|c| c.url.contains("list_form_entries"))
        .map(|c| c.url.clone())
        .collect();
    assert_eq!(asked.len(), 5);
    assert!(asked.iter().all(|u| !u.contains("details")), "{asked:?}");
    // A failed count leaves every count null.
    let (fake, clock) = setup();
    fake.set("/api/forms/list_form_entries?form_id=42", raw(500, ""));
    let capture = run_check(&fake, &clock);
    assert_eq!(outcome(&capture, FORM_ENTRIES), Outcome::Refused);
    assert!(capture.forms().iter().all(|f| f.submissions.is_none()));
    // No forms: nothing to count.
    let (fake, clock) = setup();
    fake.set("/api/forms/list_forms", ok(json!([])));
    assert_eq!(
        outcome(&run_check(&fake, &clock), FORM_ENTRIES),
        Outcome::Ok
    );
}

/// Attendance: once the service has started, the people checked in to it (`type=person`), as a head count only.
#[test]
fn attendance_is_read_once_the_service_has_ended() {
    let after = Time::parse("2026-11-22T17:00:00Z").unwrap().unix_millis();
    let clock = FakeClock::at(after);
    let fake = fixture(clock.clone());
    let capture = run_check(&fake, &clock);
    assert_eq!(outcome(&capture, ATTENDANCE), Outcome::Ok);
    let service = capture
        .events()
        .iter()
        .find(|e| e.id == id(INSTANCE))
        .unwrap();
    assert_eq!(service.attendance, Some(3));
    assert!(
        capture
            .events()
            .iter()
            .filter(|e| e.id != id(INSTANCE))
            .all(|e| e.attendance.is_none())
    );
    let url = fake
        .calls()
        .iter()
        .find(|c| c.url.contains("attendance"))
        .unwrap()
        .url
        .clone();
    assert!(
        url.ends_with(&format!(
            "/api/events/attendance/list?instance_id={INSTANCE}&type=person"
        )),
        "{url}"
    );
    let text = capture.to_json().unwrap();
    assert!(!text.contains("7001") && !text.contains("time_in"));
    // Before it starts there's nothing to count: not read, and null.
    let (fake, clock) = setup();
    let capture = run_check(&fake, &clock);
    assert_eq!(outcome(&capture, ATTENDANCE), Outcome::NotRequested);
    assert!(capture.events().iter().all(|e| e.attendance.is_none()));
    assert!(!fake.calls().iter().any(|c| c.url.contains("attendance")));
}

/// One pacer shared by the key check, the picker and the check: one 3.5 s gap across all three.
#[test]
fn a_shared_pacer_keeps_one_gap_across_calls() {
    let (fake, clock) = setup();
    let pacer = crate::run::Pacer::new();
    verify_key(&fake, &*clock, &breeze_key(), &id(CHURCH), Some(&pacer)).unwrap();
    events(
        &fake,
        &*clock,
        &breeze_key(),
        &id(CHURCH),
        Some(&pacer),
        None,
    )
    .unwrap();
    check(
        &fake,
        &*clock,
        &crate::test_support::FakeZones::standard(),
        &breeze_key(),
        &id(CHURCH),
        &id(INSTANCE),
        Some(&pacer),
    )
    .unwrap();
    let calls = fake.calls();
    assert_eq!(calls.len(), 13);
    for pair in calls.windows(2) {
        assert!(pair[1].at - pair[0].at >= Duration::from_millis(3500));
    }
    // In any 60 s, at most 18.
    for (i, call) in calls.iter().enumerate() {
        let within = calls[i..]
            .iter()
            .filter(|c| c.at - call.at < Duration::from_secs(60))
            .count();
        assert!(within <= 18);
    }
}

/// Live (2026-11-17): `list_form_entries` without `details` answers an object keyed by entry id, each value the entry
/// (`id`, `oid`, `form_id`, `created_on`, `person_id`, `response`). The docs' sample is an array. Either is counted and
/// nothing of an entry is kept; an empty form may be `[]` or `{}`; anything else is refused.
#[test]
fn form_entries_are_counted_as_an_object_keyed_by_entry_or_an_array() {
    let entry = |id: &str| {
        json!({"id": id, "oid": "1001", "form_id": "41", "created_on": "2026-11-17 21:40:00", "person_id": "157857",
               "response": {"person_id": ""}})
    };
    for (answer, expected) in [
        (
            json!({"8801": entry("8801"), "8802": entry("8802"), "8803": entry("8803")}),
            Some(3),
        ),
        (json!([entry("8801"), entry("8802")]), Some(2)),
        (json!({}), Some(0)),
        (json!([]), Some(0)),
    ] {
        let (fake, clock) = setup();
        fake.set(
            "/api/forms/list_form_entries?form_id=41",
            ok(answer.clone()),
        );
        let capture = run_check(&fake, &clock);
        assert_eq!(outcome(&capture, FORM_ENTRIES), Outcome::Ok, "{answer}");
        assert_eq!(capture.forms()[0].submissions, expected, "{answer}");
        let text = capture.to_json().unwrap();
        assert!(
            !text.contains("8801") && !text.contains("21:40"),
            "{answer}"
        );
    }
    for bad in [
        json!("3"),
        json!(3),
        json!({"8801": "x"}),
        json!([1, 2]),
        json!(null),
    ] {
        let (fake, clock) = setup();
        fake.set("/api/forms/list_form_entries?form_id=41", ok(bad.clone()));
        let capture = run_check(&fake, &clock);
        assert_eq!(
            outcome(&capture, FORM_ENTRIES),
            Outcome::InvalidResponse,
            "{bad}"
        );
        assert!(
            capture.forms().iter().all(|f| f.submissions.is_none()),
            "{bad}"
        );
    }
}

/// An archived form (`is_archived` other than "0") isn't one of the newest to count: its count stays null.
#[test]
fn archived_forms_are_not_counted() {
    let (fake, clock) = setup();
    fake.set(
        "/api/forms/list_forms",
        ok(json!([
            {"id": "41", "name": "Fall Sign-up", "created_on": "2026-09-01 10:00:00", "folder_id": "0",
             "is_archived": "0", "url_slug": "fall"},
            {"id": "43", "name": "Old Retreat", "created_on": "2026-10-01 10:00:00", "folder_id": "0",
             "is_archived": "1", "url_slug": "retreat"}
        ])),
    );
    let capture = run_check(&fake, &clock);
    let counts: BTreeMap<&str, Option<u32>> = capture
        .forms()
        .iter()
        .map(|f| (f.id.as_str(), f.submissions))
        .collect();
    assert_eq!(counts["41"], Some(2));
    assert_eq!(counts["43"], None);
    assert!(!fake.calls().iter().any(|c| c.url.contains("form_id=43")));
    assert_eq!(outcome(&capture, FORM_ENTRIES), Outcome::Truncated);
}

/// Review E, M1: a volunteer with no role is on the service only when their answer is accepted or no response yet. A
/// declined one is left out (they said no); one with an answer code Ozzie doesn't know is left out and the read says
/// something was.
#[test]
fn only_an_accepted_or_unanswered_roleless_volunteer_is_on_the_service() {
    for (response, on, word) in [
        ("2", true, Outcome::Ok),
        ("0", true, Outcome::Ok),
        ("1", false, Outcome::Ok),
        ("7", false, Outcome::Truncated),
    ] {
        let (fake, clock) = setup();
        fake.set(
            "/api/volunteers/list",
            ok(json!([{"id": "501", "person_id": "157857", "response": "0", "role_ids": ["9627"]},
                      {"id": "504", "person_id": "157860", "response": response, "role_ids": null}])),
        );
        let capture = run_check(&fake, &clock);
        assert_eq!(
            capture.on_service().contains(&id("157860")),
            on,
            "{response}"
        );
        assert_eq!(outcome(&capture, VOLUNTEERS), word, "{response}");
    }
}

/// Review E, M5: attendance is the people checked in by name, read only once the service has ended (its end known and
/// passed); before that, or with no end, it isn't read.
#[test]
fn attendance_waits_for_the_service_to_end() {
    for at in ["2026-11-22T15:10:00Z", "2026-11-22T16:29:00Z"] {
        let clock = FakeClock::at(Time::parse(at).unwrap().unix_millis());
        let fake = fixture(clock.clone());
        let capture = run_check(&fake, &clock);
        assert_eq!(outcome(&capture, ATTENDANCE), Outcome::NotRequested, "{at}");
        assert!(!fake.calls().iter().any(|c| c.url.contains("attendance")));
    }
    // No end: never known to have ended.
    let clock = FakeClock::at(Time::parse("2026-11-23T12:00:00Z").unwrap().unix_millis());
    let fake = fixture(clock.clone());
    let service = json!({"id": INSTANCE, "name": "Sunday Gathering", "start_datetime": "2026-11-22 09:00:00",
                         "end_datetime": "0000-00-00 00:00:00"});
    fake.set("/api/events/list_event", ok(service.clone()));
    fake.set("/api/events", ok(json!([service])));
    let capture = run_check(&fake, &clock);
    assert_eq!(outcome(&capture, ATTENDANCE), Outcome::NotRequested);
}

/// Review E, L1 and M5: nothing of a check-in or a form entry (an id, a name, a field) reaches the capture, its debug
/// text, or an error, including a checked-in person who isn't scheduled.
#[test]
fn nothing_of_a_check_in_or_a_form_entry_is_kept() {
    let markers = [
        "157899",
        "Zebulon",
        "Markerfield",
        "Secretname",
        "marker@example.org",
        "7799",
        "8899",
        "23:41",
    ];
    let after = Time::parse("2026-11-22T17:00:00Z").unwrap().unix_millis();
    let clock = FakeClock::at(after);
    let fake = fixture(clock.clone());
    fake.set(
        "/api/events/attendance/list",
        ok(json!([
            {"id": "7799", "instance_id": INSTANCE, "person_id": "157899", "time_in": "2026-11-22 23:41:00",
             "details": {"first_name": "Zebulon", "last_name": "Markerfield"}},
            {"id": "7002", "instance_id": INSTANCE, "person_id": "157859", "time_in": "2026-11-22 08:55:00"}
        ])),
    );
    fake.set(
        "/api/forms/list_form_entries?form_id=41",
        ok(json!({"8899": {"id": "8899", "oid": "1001", "form_id": "41", "created_on": "2026-11-17 23:41:00",
                           "person_id": "157899",
                           "response": {"name": "Secretname", "email": "marker@example.org"}}})),
    );
    // The checked-in person is in Breeze's people list too, so nothing but the rule keeps them out of `names` and
    // `on_service`.
    fake.set(
        "/api/people",
        ok(json!([
            {"id": "157857", "first_name": "Avery", "last_name": "Quillfeather"},
            {"id": "157858", "first_name": "Blake", "last_name": "Marrowstone"},
            {"id": "157859", "first_name": "Casey", "last_name": "Thimbleton"},
            {"id": "157860", "first_name": "Ellis", "last_name": "Brightwater"},
            {"id": "157899", "first_name": "Zebulon", "last_name": "Markerfield"}
        ])),
    );
    let capture = run_check(&fake, &clock);
    assert_eq!(outcome(&capture, ATTENDANCE), Outcome::Ok);
    assert_eq!(outcome(&capture, FORM_ENTRIES), Outcome::Ok);
    let text = capture.to_json().unwrap();
    let debug = format!("{capture:?}");
    for marker in markers {
        assert!(
            !text.contains(marker) && !debug.contains(marker),
            "{marker}"
        );
    }
    assert!(!capture.on_service().contains(&id("157899")));
    // An answer Ozzie can't use: the error says nothing of it.
    fake.set(
        "/api/events/attendance/list",
        ok(json!([{"id": "7799"}, "Zebulon Markerfield"])),
    );
    fake.set(
        "/api/forms/list_form_entries?form_id=41",
        ok(json!({"8899": "Secretname"})),
    );
    let capture = run_check(&fake, &clock);
    assert_eq!(outcome(&capture, ATTENDANCE), Outcome::InvalidResponse);
    assert_eq!(outcome(&capture, FORM_ENTRIES), Outcome::InvalidResponse);
    let text = format!("{}{capture:?}", capture.to_json().unwrap());
    for marker in markers {
        assert!(!text.contains(marker), "{marker}");
    }
}

/// Review E, L5: whether a roleless volunteer holds a role elsewhere is judged on every assignment read, not the ones
/// kept under the cap.
#[test]
fn a_roleless_volunteer_with_a_role_cut_at_the_cap_is_not_on_the_service() {
    let (fake, clock) = setup();
    let mut rows: Vec<Value> = (0..MAX_ASSIGNMENTS)
        .map(|n| json!({"id": format!("6{n:03}"), "person_id": "157857", "response": "2", "role_ids": ["9627"]}))
        .collect();
    rows.push(json!({"id": "7000", "person_id": "157860", "response": "2", "role_ids": ["9628"]}));
    rows.push(json!({"id": "7001", "person_id": "157860", "response": "2", "role_ids": null}));
    fake.set("/api/volunteers/list", ok(Value::Array(rows)));
    let capture = run_check(&fake, &clock);
    assert!(capture.on_service().is_empty());
    assert_eq!(outcome(&capture, VOLUNTEERS), Outcome::Truncated);
}

/// Round 4, live: Ozzie picked "Event Location limit" (no time of day) over "Breeze Sunday" at 9:35 AM the same day.
/// The picker now says each event's start as written (none for Breeze's midnight) and, when several share the soonest
/// day, how many people are listed on each, so the page can pick the one being staffed.
#[test]
fn the_picker_says_start_times_and_counts_who_is_on_each_event_of_a_crowded_day() {
    let (fake, clock) = setup();
    fake.set(
        "/api/events",
        ok(json!([
            {"id": "6001", "name": "Event Location limit", "start_datetime": "2026-11-22 00:00:00"},
            {"id": "6002", "name": "Breeze Sunday", "start_datetime": "2026-11-22 09:35:00"},
            {"id": "6003", "name": "Youth Night", "start_datetime": "2026-11-22T18:00:00-06:00"},
            {"id": "6004", "name": "Advent One", "start_datetime": "2026-11-29 09:00:00"}
        ])),
    );
    fake.set(
        "/api/volunteers/list?instance_id=6002",
        ok(json!([
            {"id": "1", "person_id": "11", "response": "2", "role_ids": ["9"]},
            {"id": "2", "person_id": "12", "response": "0", "role_ids": ["9"]},
            {"id": "3", "person_id": "12", "response": "0", "role_ids": ["8"]},
            {"id": "4", "person_id": "13", "response": "1", "role_ids": ["9"]}
        ])),
    );
    fake.set("/api/volunteers/list?instance_id=6003", ok(json!([])));
    fake.set("/api/volunteers/list?instance_id=6001", ok(json!([])));
    let from = Date::parse("2026-11-22");
    let choices = events(&fake, &*clock, &breeze_key(), &id(CHURCH), None, from).unwrap();
    let seen: Vec<(&str, Option<&str>, Option<u32>)> = choices
        .iter()
        .map(|c| (c.id.as_str(), c.time.as_deref(), c.people))
        .collect();
    // By day, then start time, the event with no time of day last; declined people aren't counted, each person once.
    assert_eq!(
        seen,
        vec![
            ("6002", Some("09:35"), Some(2)),
            ("6003", Some("18:00"), Some(0)),
            ("6001", None, Some(0)),
            ("6004", Some("09:00"), None),
        ]
    );
    let counted: Vec<String> = fake
        .calls()
        .iter()
        .filter(|c| c.url.contains("/api/volunteers/list"))
        .map(|c| c.url.clone())
        .collect();
    assert_eq!(counted.len(), 3);
    assert!(counted.iter().all(|u| u.contains("instance_id=600")));
    // One event that day: nothing is counted. A count that can't be read leaves the rest uncounted, never the list.
    let (fake, clock) = setup();
    fake.set(
        "/api/events",
        ok(json!([
            {"id": "6002", "name": "Breeze Sunday", "start_datetime": "2026-11-22 09:35:00"},
            {"id": "6004", "name": "Advent One", "start_datetime": "2026-11-29 09:00:00"}
        ])),
    );
    let one = events(&fake, &*clock, &breeze_key(), &id(CHURCH), None, from).unwrap();
    assert!(one.iter().all(|c| c.people.is_none()));
    assert!(!fake.calls().iter().any(|c| c.url.contains("volunteers")));
    let (fake, clock) = setup();
    fake.set(
        "/api/events",
        ok(json!([
            {"id": "6001", "start_datetime": "2026-11-22 00:00:00"},
            {"id": "6002", "start_datetime": "2026-11-22 09:35:00"}
        ])),
    );
    fake.set("/api/volunteers/list?instance_id=6002", raw(500, ""));
    let failed = events(&fake, &*clock, &breeze_key(), &id(CHURCH), None, from).unwrap();
    assert!(failed.iter().all(|c| c.people.is_none()));
    // Without `from` (moving on, Settings' list) nothing is counted.
    let (fake, clock) = setup();
    fake.set(
        "/api/events",
        ok(json!([
            {"id": "6001", "start_datetime": "2026-11-22 00:00:00"},
            {"id": "6002", "start_datetime": "2026-11-22 09:35:00"}
        ])),
    );
    events(&fake, &*clock, &breeze_key(), &id(CHURCH), None, None).unwrap();
    assert!(!fake.calls().iter().any(|c| c.url.contains("volunteers")));
    // The soonest day is the first on or after `from`: yesterday's events aren't the ones counted.
    let (fake, clock) = setup();
    fake.set(
        "/api/events",
        ok(json!([
            {"id": "5001", "start_datetime": "2026-11-21 09:00:00"},
            {"id": "5002", "start_datetime": "2026-11-21 11:00:00"},
            {"id": "6002", "start_datetime": "2026-11-22 09:35:00"}
        ])),
    );
    events(&fake, &*clock, &breeze_key(), &id(CHURCH), None, from).unwrap();
    assert!(!fake.calls().iter().any(|c| c.url.contains("volunteers")));
    assert_eq!(written_clock("2026-11-22 00:00:00"), None);
    assert_eq!(written_clock("2026-11-22T00:00:00-06:00"), None);
    assert_eq!(
        written_clock("2026-11-22 09:35:00").as_deref(),
        Some("09:35")
    );
    assert_eq!(written_clock("2026-11-22 9:35"), None);
}
