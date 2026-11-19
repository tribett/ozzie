use super::*;
use crate::test_support::{
    Answer, FakeB1, FakeClock, FakeZones, NOW, genesis_key, genesis_key_text, id, key as b1_key,
    ok, raw,
};
use serde_json::json;
use std::collections::BTreeMap;
use std::sync::Arc;

const CHURCH: &str = "5f0c2a4e-1b7d-4c3e-9a10-fictional001";
const P: &str = "/functions/v1/public-api/v1";

/// The read paths, `{id}` for a form id, and the query names each may carry.
const READ_PATHS: &[(&str, &[&str])] = &[
    ("/me", &[]),
    ("/groups", &["limit", "offset"]),
    ("/events", &["from", "to", "limit", "offset"]),
    ("/forms", &["limit", "offset"]),
    ("/forms/{id}/submissions", &["limit", "offset"]),
];
/// Paths Genesis documents that Ozzie never builds: giving, people, households, group members, the export, and every
/// write (research 3).
const NEVER: &[&str] = &[
    "giving",
    "summary",
    "contacts",
    "export",
    "households",
    "members",
    "attendance",
    "tags",
];

fn every_read() -> Vec<Read> {
    let day = Date::parse("2026-11-16").unwrap();
    let all = vec![
        Read::Me,
        Read::Groups,
        Read::Events {
            from: day,
            to: day.next_day().unwrap(),
        },
        Read::Forms,
        Read::Submissions(id("FRMfall")),
    ];
    fn index(read: &Read) -> usize {
        match read {
            Read::Me => 0,
            Read::Groups => 1,
            Read::Events { .. } => 2,
            Read::Forms => 3,
            Read::Submissions(_) => 4,
        }
    }
    assert_eq!(
        all.iter().map(index).collect::<BTreeSet<_>>(),
        (0..=4).collect()
    );
    all
}

pub(crate) use crate::test_support::genesis::fixture;
fn setup() -> (FakeB1, Arc<FakeClock>) {
    let clock = FakeClock::at(NOW);
    (fixture(clock.clone()), clock)
}
/// The church's zone, as the person confirmed it.
fn chicago() -> ZoneName {
    ZoneName::new("America/Chicago").unwrap()
}
fn run_check(fake: &FakeB1, clock: &FakeClock) -> SystemCapture {
    check(
        fake,
        clock,
        &FakeZones::standard(),
        &genesis_key(),
        &id(CHURCH),
        Some(&chicago()),
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
fn every_read_is_a_get_on_the_one_host_under_the_fixed_base() {
    let http = crate::http::NativeHttp::new().unwrap();
    for read in every_read() {
        let get = Get::new(&read, Auth::Bearer(genesis_key()));
        let url = get.url();
        assert_eq!(url.scheme(), "https");
        assert_eq!(url.host_str(), Some(HOST));
        assert_eq!(url.port(), None);
        assert_eq!(get.method(), "GET");
        let rest = url
            .path()
            .strip_prefix(P)
            .unwrap_or_else(|| panic!("{read:?}: {}", url.path()));
        let template = rest.replace("/FRMfall/", "/{id}/");
        let allowed = READ_PATHS
            .iter()
            .find(|(path, _)| *path == template)
            .unwrap_or_else(|| panic!("{read:?}: {template}"));
        for (name, _) in url.query_pairs() {
            assert!(allowed.1.contains(&name.as_ref()), "{read:?}: {name}");
        }
        for segment in rest.split('/') {
            assert!(
                !NEVER.iter().any(|w| segment.eq_ignore_ascii_case(w)),
                "{read:?}: {segment}"
            );
        }
        let built = http.build(&get).unwrap();
        assert_eq!(built.method().as_str(), "GET");
        assert!(built.body().is_none());
        assert_eq!(
            built.headers()["authorization"].to_str().unwrap(),
            format!("Bearer {}", genesis_key_text())
        );
        assert!(!url.as_str().contains(&genesis_key_text()));
    }
}

#[test]
fn genesis_rs_names_no_giving_or_other_path() {
    let text = include_str!("genesis.rs");
    for word in NEVER {
        assert!(!text.contains(&format!("Fixed(\"{word}\")")), "{word}");
    }
    assert!(!text.contains(&["\"giv", "ing\""].concat()));
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
    assert_eq!(
        words,
        READS
            .iter()
            .map(|w| (w.as_str(), Outcome::Ok))
            .collect::<Vec<_>>()
    );
    assert_eq!(capture.system(), System::Genesis);
    // Nothing Genesis can't supply, and no names.
    assert!(
        capture.service().is_none()
            && capture.positions().is_empty()
            && capture.assignments().is_empty()
    );
    assert!(capture.team_members().is_empty() && capture.blockouts().is_none());
    assert!(capture.names().is_empty());
    let groups: Vec<(&str, Option<u32>)> = capture
        .groups()
        .iter()
        .map(|g| (g.id.as_str(), g.members))
        .collect();
    // Live groups carry no member count (grp-2); one would be read if Genesis sent it (grp-1).
    assert_eq!(groups, vec![("grp-1", Some(12)), ("grp-2", None)]);
    let events: Vec<(&str, Option<u32>)> = capture
        .events()
        .iter()
        .map(|e| (e.id.as_str(), e.attendance))
        .collect();
    assert_eq!(events, vec![("evt-1", Some(142)), ("evt-2", None)]);
    // Local times placed in the church's zone; an event with no end time has no end.
    assert_eq!(
        capture.events()[0].starts_at.as_str(),
        "2026-11-22T09:00:00-06:00"
    );
    assert_eq!(
        capture.events()[0].ends_at.as_ref().unwrap().as_str(),
        "2026-11-22T10:30:00-06:00"
    );
    assert!(capture.events()[1].ends_at.is_none());
    assert_eq!(
        capture.church().time_zone.as_ref().unwrap().as_str(),
        "America/Chicago"
    );
    let labels_text: Vec<&str> = capture.labels().values().map(|l| l.as_str()).collect();
    assert!(labels_text.contains(&"Sunday Gathering"));
    let forms: Vec<(&str, Option<u32>)> = capture
        .forms()
        .iter()
        .map(|f| (f.id.as_str(), f.submissions))
        .collect();
    assert_eq!(forms, vec![("FRMfall", Some(2)), ("FRMcare", Some(0))]);
    let labels: BTreeMap<String, &str> = capture
        .labels()
        .iter()
        .map(|(k, v)| (k.to_string(), v.as_str()))
        .collect();
    assert_eq!(labels["church"], "Cedar Hollow Fellowship");
    assert_eq!(labels["group:grp-1"], "Tuesday Bible Study");
    assert_eq!(labels["form:FRMcare"], "Prayer Card");
    // Submissions are counted, never kept.
    let text = capture.to_json().unwrap();
    assert!(!text.contains("Quillfeather") && !text.contains("Marrowstone"));
    assert_eq!(SystemCapture::from_json(text.as_bytes()).unwrap(), capture);
    // The window, pacing and the key.
    let calls = fake.calls();
    assert_eq!(calls.len(), 6);
    assert!(
        calls[2].url.contains("from=2026-11-16") && calls[2].url.contains("to=2026-12-14"),
        "{}",
        calls[2].url
    );
    for pair in calls.windows(2) {
        assert!(pair[1].at - pair[0].at >= Duration::from_millis(600));
    }
    for call in &calls {
        assert_eq!(call.method, "GET");
        assert_eq!(call.auth, format!("Bearer {}", genesis_key_text()));
    }
}

#[test]
fn a_key_for_another_church_or_a_refused_key_stops_the_check() {
    let (fake, clock) = setup();
    fake.set(
        &format!("{P}/me"),
        ok(json!({"church": {"id": "other-church", "name": "Other"}})),
    );
    let capture = run_check(&fake, &clock);
    assert_eq!(outcome(&capture, ME), Outcome::KeyRefused);
    assert!(
        capture.reads()[1..]
            .iter()
            .all(|r| r.outcome == Outcome::NotRequested)
    );
    assert_eq!(fake.calls().len(), 1);
    let (fake, clock) = setup();
    fake.set(&format!("{P}/me"), raw(401, r#"{"error":"invalid key"}"#));
    assert_eq!(outcome(&run_check(&fake, &clock), ME), Outcome::KeyRefused);
    assert_eq!(
        check(
            &fake,
            &*clock,
            &FakeZones::standard(),
            &b1_key(),
            &id(CHURCH),
            None
        )
        .unwrap_err(),
        ReadError::KeyRefused
    );
}

#[test]
fn shapes_outside_the_documented_envelope_are_refused() {
    for (path, bad, word) in [
        ("/groups", json!([{"id": "grp-1"}]), GROUPS),
        ("/groups", json!({"items": []}), GROUPS),
        ("/groups", json!({"data": [{"id": "grp 1"}]}), GROUPS),
        (
            "/groups",
            json!({"data": [{"id": "grp-1", "member_count": "12"}]}),
            GROUPS,
        ),
        (
            "/groups",
            json!({"data": [{"id": "grp-1"}, {"id": "grp-1"}]}),
            GROUPS,
        ),
        (
            "/events",
            json!({"data": [{"id": "evt-1", "start_date": "2026-11-22", "start_time": "9:00"}]}),
            EVENTS,
        ),
        ("/events", json!({"data": [{"id": "evt-1"}]}), EVENTS),
        (
            "/events",
            json!({"data": [{"id": "evt-1", "start_date": "2026-11-22", "start_time": "09:00:00", "attendance_adults": -3}]}),
            EVENTS,
        ),
        (
            "/forms",
            json!({"data": [{"id": "FRMfall", "name": 7}]}),
            FORMS,
        ),
    ] {
        let (fake, clock) = setup();
        fake.set(&format!("{P}{path}"), ok(bad.clone()));
        let capture = run_check(&fake, &clock);
        assert_eq!(outcome(&capture, word), Outcome::InvalidResponse, "{bad}");
    }
    // An error body is refused.
    let (fake, clock) = setup();
    fake.set(&format!("{P}/groups"), raw(200, r#"{"error":"bad input"}"#));
    assert_eq!(outcome(&run_check(&fake, &clock), GROUPS), Outcome::Refused);
    // 403 (missing permission) on forms: refused, and no counts read.
    let (fake, clock) = setup();
    fake.set(
        &format!("{P}/forms"),
        raw(403, r#"{"error":"missing permission"}"#),
    );
    let capture = run_check(&fake, &clock);
    assert_eq!(outcome(&capture, FORMS), Outcome::Refused);
    assert_eq!(outcome(&capture, FORM_SUBMISSIONS), Outcome::NotRequested);
}

#[test]
fn counts_that_may_be_more_are_truncated_and_a_failed_count_leaves_none() {
    let (fake, clock) = setup();
    let full: Vec<Value> = (0..200)
        .map(|n| json!({"id": format!("sub-{n}")}))
        .collect();
    fake.set(
        &format!("{P}/forms/FRMfall/submissions"),
        ok(json!({"data": full, "limit": 200, "offset": 0})),
    );
    let capture = run_check(&fake, &clock);
    assert_eq!(outcome(&capture, FORM_SUBMISSIONS), Outcome::Truncated);
    assert_eq!(capture.forms()[0].submissions, Some(200));
    let (fake, clock) = setup();
    fake.set(
        &format!("{P}/forms/FRMcare/submissions"),
        Answer::Fail(ReadError::Timeout),
    );
    let capture = run_check(&fake, &clock);
    assert_eq!(outcome(&capture, FORM_SUBMISSIONS), Outcome::Timeout);
    assert!(capture.forms().iter().all(|f| f.submissions.is_none()));
    // The request cap: forms past it keep null and the read says so.
    let (fake, clock) = setup();
    let limits = Limits {
        max_requests: 5,
        ..LIMITS
    };
    let capture = check_with(
        &fake,
        &*clock,
        &FakeZones::standard(),
        &genesis_key(),
        &id(CHURCH),
        Some(&chicago()),
        limits,
    )
    .unwrap();
    assert_eq!(outcome(&capture, FORM_SUBMISSIONS), Outcome::Truncated);
    assert_eq!(capture.forms()[0].submissions, Some(2));
    assert_eq!(capture.forms()[1].submissions, None);
    // A full groups page may have more.
    let (fake, clock) = setup();
    let many: Vec<Value> = (0..200)
        .map(|n| json!({"id": format!("grp-{n}")}))
        .collect();
    fake.set(&format!("{P}/groups"), ok(json!({"data": many})));
    assert_eq!(
        outcome(&run_check(&fake, &clock), GROUPS),
        Outcome::Truncated
    );
}

#[test]
fn verify_key_gives_the_church() {
    let (fake, clock) = setup();
    let church = verify_key(&fake, &*clock, &genesis_key()).unwrap();
    assert_eq!(church.id, id(CHURCH));
    let (fake, clock) = setup();
    fake.set(&format!("{P}/me"), raw(401, r#"{"error":"invalid key"}"#));
    assert_eq!(
        verify_key(&fake, &*clock, &genesis_key()).unwrap_err(),
        ReadError::KeyRefused
    );
    let (fake, clock) = setup();
    fake.set(&format!("{P}/me"), ok(json!({"id": CHURCH})));
    assert_eq!(
        verify_key(&fake, &*clock, &genesis_key()).unwrap_err(),
        ReadError::InvalidResponse
    );
    for text in [
        format!("{:?}", genesis_key()),
        format!("{:?}", verify_key(&fake, &*clock, &genesis_key())),
    ] {
        assert!(!text.contains(&genesis_key_text()));
    }
}

#[test]
fn events_without_the_churchs_zone_are_left_out_and_the_read_says_so() {
    let (fake, clock) = setup();
    let capture = check(
        &fake,
        &*clock,
        &FakeZones::standard(),
        &genesis_key(),
        &id(CHURCH),
        None,
    )
    .unwrap();
    assert_eq!(outcome(&capture, EVENTS), Outcome::Truncated);
    assert!(capture.events().is_empty());
    assert!(capture.church().time_zone.is_none());
    // No events at all: nothing left out.
    let (fake, clock) = setup();
    fake.set(
        &format!("{P}/events"),
        ok(json!({"data": [], "limit": 200, "offset": 0})),
    );
    let capture = check(
        &fake,
        &*clock,
        &FakeZones::standard(),
        &genesis_key(),
        &id(CHURCH),
        None,
    )
    .unwrap();
    assert_eq!(outcome(&capture, EVENTS), Outcome::Ok);
}

#[test]
fn an_event_end_not_after_its_start_or_in_a_skipped_hour_is_no_end() {
    let (fake, clock) = setup();
    fake.set(
        &format!("{P}/events"),
        ok(json!({"data": [
            {"id": "evt-a", "title": "Same Time", "start_date": "2026-11-22", "start_time": "09:00:00",
             "end_date": null, "end_time": "09:00:00"},
            {"id": "evt-b", "title": "Overnight", "start_date": "2026-11-22", "start_time": "22:00:00",
             "end_date": "2026-11-23", "end_time": "01:00:00"},
            {"id": "evt-c", "title": "Spring Forward", "start_date": "2026-03-08", "start_time": "02:30:00",
             "end_date": null, "end_time": "04:00:00"}
        ], "limit": 200, "offset": 0})),
    );
    let capture = run_check(&fake, &clock);
    // evt-c starts in the hour skipped on 2026-03-08: left out, and the read says so.
    assert_eq!(outcome(&capture, EVENTS), Outcome::Truncated);
    let ids: Vec<&str> = capture.events().iter().map(|e| e.id.as_str()).collect();
    assert_eq!(ids, vec!["evt-a", "evt-b"]);
    assert!(capture.events()[0].ends_at.is_none());
    assert_eq!(
        capture.events()[1].ends_at.as_ref().unwrap().as_str(),
        "2026-11-23T01:00:00-06:00"
    );
}

/// Review D, L3: an end before the start with no `end_date` (it crosses midnight) can't be placed without guessing
/// the day. The event keeps its start, its end is null, and the read says an end was left out. Its attendance is still
/// its own.
#[test]
fn an_end_before_its_start_with_no_end_date_is_left_out_and_said() {
    let (fake, clock) = setup();
    fake.set(
        &format!("{P}/events"),
        ok(json!({"data": [
            {"id": "evt-late", "title": "Watch Night", "start_date": "2026-11-21", "start_time": "22:00:00",
             "end_date": null, "end_time": "01:00:00",
             "attendance_adults": 20, "attendance_children": 5, "attendance_students": 3}
        ], "limit": 200, "offset": 0})),
    );
    let capture = run_check(&fake, &clock);
    assert_eq!(outcome(&capture, EVENTS), Outcome::Truncated);
    let event = &capture.events()[0];
    assert_eq!(event.starts_at.as_str(), "2026-11-21T22:00:00-06:00");
    assert!(event.ends_at.is_none());
    assert_eq!(event.attendance, Some(28));
}
