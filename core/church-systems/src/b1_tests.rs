use super::*;
use crate::capture::{Outcome, Status};
use crate::test_support::{
    Answer, CHURCH as CHURCH_ID, FakeB1, FakeClock, NOW, PEOPLE as FICTIONAL, PLAN as PLAN_ID,
    fake_b1, id, key, key_text, ok, raw,
};
use serde_json::json;
use std::time::Duration;

fn run_check(fake: &FakeB1, clock: &FakeClock) -> SystemCapture {
    check(
        fake,
        clock,
        &crate::test_support::FakeZones::standard(),
        &key(),
        &id(CHURCH_ID),
        &id(PLAN_ID),
        None,
    )
    .unwrap()
}
fn setup() -> (FakeB1, std::sync::Arc<FakeClock>) {
    let clock = FakeClock::at(NOW);
    (fake_b1(clock.clone()), clock)
}
fn outcomes(capture: &SystemCapture) -> Vec<(&'static str, Outcome)> {
    capture
        .reads()
        .iter()
        .map(|r| (r.read.as_str(), r.outcome))
        .collect()
}
fn outcome(capture: &SystemCapture, word: ReadWord) -> Outcome {
    capture
        .reads()
        .iter()
        .find(|r| r.read == word)
        .map(|r| r.outcome)
        .unwrap()
}

/// Every `Read` variant, one each: `index` is exhaustive, so a new variant fails to compile until it is listed here.
fn every_read() -> Vec<Read> {
    let all = vec![
        Read::Church(id(CHURCH_ID)),
        Read::PlansByIds(vec![id(PLAN_ID)]),
        Read::Plan(id(PLAN_ID)),
        Read::Overview {
            start: Date::parse("2026-11-21").unwrap(),
            end: Date::parse("2026-11-23").unwrap(),
        },
        Read::PlanTimes(vec![id("PLAother")]),
        Read::Positions(id(PLAN_ID)),
        Read::Assignments(id(PLAN_ID)),
        Read::Times(id(PLAN_ID)),
        Read::Blockouts,
        Read::TeamMembers(vec![id("GRPworship"), id("GRPwelcome")]),
        Read::Names(vec![id("PERavery"), id("PERblake")]),
        Read::Groups,
        Read::Events,
        Read::Forms,
        Read::Lookup(id("cedarhollow")),
    ];
    fn index(read: &Read) -> usize {
        match read {
            Read::Church(_) => 0,
            Read::PlansByIds(_) => 1,
            Read::Plan(_) => 2,
            Read::Positions(_) => 3,
            Read::Assignments(_) => 4,
            Read::Times(_) => 5,
            Read::Blockouts => 6,
            Read::TeamMembers(_) => 7,
            Read::Names(_) => 8,
            Read::Groups => 9,
            Read::Events => 10,
            Read::Forms => 11,
            Read::Overview { .. } => 12,
            Read::PlanTimes(_) => 13,
            Read::Lookup(_) => 14,
        }
    }
    let covered: BTreeSet<usize> = all.iter().map(index).collect();
    assert_eq!(covered, (0..=14).collect());
    all
}
/// The closed list of paths, `{id}` for an id.
const PATHS: &[&str] = &[
    "/membership/churches/{id}",
    "/doing/plans/ids",
    "/doing/plans/{id}",
    "/doing/plans/overview",
    "/doing/times/plans",
    "/doing/positions/plan/{id}",
    "/doing/assignments/plan/{id}",
    "/doing/times/plan/{id}",
    "/doing/blockoutDates/upcoming",
    "/membership/groupmembers",
    "/membership/people/names",
    "/membership/groups",
    "/content/events/timeline",
    "/membership/forms",
    "/membership/churches/lookup",
];
/// B1's write routes and sign-in routes: no path may contain one.
const WRITE_WORDS: &[&str] = &[
    "autofill",
    "notifyRange",
    "textRange",
    "issueRequests",
    "copy",
    "accept",
    "decline",
    "signup",
    "respond",
    "login",
    "register",
    "token",
    "authorize",
    "apiKeys",
    "approve",
    "deny",
    "checkin",
    "checkout",
    "log",
    "advancedSearch",
    "duplicates",
    "save",
    "delete",
    "connections",
];

#[test]
fn every_read_is_a_get_of_a_listed_https_path_on_the_one_host() {
    let http = crate::http::NativeHttp::new().unwrap();
    for read in every_read() {
        let get = Get::new(&read, Auth::Bearer(key()));
        let url = get.url();
        assert_eq!(url.scheme(), "https", "{read:?}");
        assert_eq!(url.host_str(), Some(HOST), "{read:?}");
        assert_eq!(url.port(), None, "{read:?}");
        assert_eq!(url.username(), "");
        assert!(url.password().is_none() && url.fragment().is_none());
        assert_eq!(get.method(), "GET");
        let template = url
            .path_segments()
            .unwrap()
            .map(|s| {
                if s == CHURCH_ID || s == PLAN_ID {
                    "{id}"
                } else {
                    s
                }
            })
            .collect::<Vec<_>>()
            .join("/");
        assert!(
            PATHS.contains(&format!("/{template}").as_str()),
            "{read:?}: {template}"
        );
        for segment in url.path_segments().unwrap() {
            for word in WRITE_WORDS {
                assert!(!segment.eq_ignore_ascii_case(word), "{read:?}: {word}");
            }
        }
        for (name, _) in url.query_pairs() {
            assert!(
                [
                    "groupIds",
                    "ids",
                    "startDate",
                    "endDate",
                    "planIds",
                    "subDomain"
                ]
                .contains(&name.as_ref()),
                "{read:?}: {name}"
            );
        }
        assert!(!url.as_str().contains(&key_text()));
        // What the real client would send: a bodiless GET of exactly this address.
        let built = http.build(&get).unwrap();
        assert_eq!(built.method().as_str(), "GET");
        assert!(built.body().is_none());
        assert_eq!(built.url(), url);
        assert_eq!(built.headers()["accept"], "application/json");
        assert!(built.headers()["authorization"].is_sensitive());
        assert_eq!(
            built.headers()["authorization"].to_str().unwrap(),
            format!("Bearer {}", key_text())
        );
    }
}

#[test]
fn an_id_that_is_a_route_word_is_refused_before_anything_is_sent() {
    let (fake, clock) = setup();
    for word in [
        "overview",
        "Overview",
        "ids",
        "presenter",
        "autofill",
        "DECLINE",
    ] {
        assert_eq!(
            check(
                &fake,
                &*clock,
                &crate::test_support::FakeZones::standard(),
                &key(),
                &id(CHURCH_ID),
                &id(word),
                None,
            )
            .unwrap_err(),
            ReadError::NotFound
        );
        assert_eq!(
            plans(&fake, &*clock, &key(), &id(word)).unwrap_err(),
            ReadError::NotFound
        );
    }
    assert!(fake.calls().is_empty());
}

#[test]
fn a_full_check_gives_the_expected_capture() {
    let (fake, clock) = setup();
    let capture = run_check(&fake, &clock);
    // Every read whole, but forms: a read-only key's forms list is never known to be all of them.
    assert_eq!(
        outcomes(&capture),
        READS
            .iter()
            .map(|w| (
                w.as_str(),
                if *w == FORMS {
                    Outcome::Truncated
                } else {
                    Outcome::Ok
                }
            ))
            .collect::<Vec<_>>()
    );
    assert_eq!(capture.church().id, id(CHURCH_ID));
    assert_eq!(
        capture.church().time_zone.as_ref().unwrap().as_str(),
        "America/Chicago"
    );
    assert_eq!(capture.started_at().as_str(), "2026-11-17T15:00:00Z");
    // The service is the plan's own day: the Thursday rehearsal isn't part of it.
    let service = capture.service().unwrap();
    assert_eq!(service.id, id(PLAN_ID));
    assert_eq!(service.starts_at.as_str(), "2026-11-22T15:00:00.000Z");
    assert_eq!(
        service.ends_at.as_ref().unwrap().as_str(),
        "2026-11-22T16:30:00.000Z"
    );
    // Roles with their wanted number; Sound has nobody (an open role).
    let positions: Vec<(&str, Option<&str>, Option<u32>)> = capture
        .positions()
        .iter()
        .map(|p| (p.id.as_str(), p.team_id.as_ref().map(Id::as_str), p.needed))
        .collect();
    assert_eq!(
        positions,
        vec![
            ("POSvocal", Some("GRPworship"), Some(2)),
            ("POSsound", Some("GRPworship"), Some(1)),
            ("POSgreet", Some("GRPwelcome"), Some(2)),
        ]
    );
    assert!(
        !capture
            .assignments()
            .iter()
            .any(|a| a.position_id == id("POSsound"))
    );
    // Accepted, Unconfirmed and Declined, each as itself.
    let answers: Vec<(&str, &str, Status)> = capture
        .assignments()
        .iter()
        .map(|a| (a.position_id.as_str(), a.person_id.as_str(), a.status))
        .collect();
    assert_eq!(
        answers,
        vec![
            ("POSvocal", "PERavery", Status::Accepted),
            ("POSvocal", "PERblake", Status::Unconfirmed),
            ("POSgreet", "PERcasey", Status::Declined),
        ]
    );
    // Drew is on another plan that morning (11:00 CST): busy then. Casey declined hers, so isn't.
    let busy: Vec<(&str, &str, &str)> = capture
        .busy()
        .unwrap()
        .iter()
        .map(|b| {
            (
                b.person_id.as_str(),
                b.starts_at.as_str(),
                b.ends_at.as_str(),
            )
        })
        .collect();
    assert_eq!(
        busy,
        vec![(
            "PERdrew",
            "2026-11-22T17:00:00.000Z",
            "2026-11-22T18:15:00.000Z"
        )]
    );
    assert_eq!(service.day.unwrap().to_string(), "2026-11-22");
    // Drew is on the worship team with no assignment.
    assert!(
        capture
            .team_members()
            .contains(&crate::capture::TeamMember {
                team_id: id("GRPworship"),
                person_id: id("PERdrew"),
            })
    );
    assert!(
        !capture
            .assignments()
            .iter()
            .any(|a| a.person_id == id("PERdrew"))
    );
    assert_eq!(capture.team_members().len(), 5);
    // Drew's blockout covers the Sunday at the service's own offset; Ellis's December one doesn't; Zed's (on no team)
    // is left out.
    let blockouts: Vec<(&str, &str, &str)> = capture
        .blockouts()
        .unwrap()
        .iter()
        .map(|b| {
            (
                b.person_id.as_str(),
                b.starts_at.as_str(),
                b.ends_at.as_str(),
            )
        })
        .collect();
    assert_eq!(
        blockouts,
        vec![
            (
                "PERdrew",
                "2026-11-22T00:00:00-06:00",
                "2026-11-23T00:00:00-06:00"
            ),
            (
                "PERellis",
                "2026-12-01T00:00:00-06:00",
                "2026-12-04T00:00:00-06:00"
            ),
        ]
    );
    let drew = &capture.blockouts().unwrap()[0];
    assert!(drew.starts_at.unix_millis() <= service.starts_at.unix_millis());
    assert!(drew.ends_at.unix_millis() >= service.ends_at.as_ref().unwrap().unix_millis());
    // Names for the people in the capture only.
    let names: Vec<(&str, &str)> = capture
        .names()
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    assert_eq!(
        names,
        vec![
            ("PERavery", "Avery Quillfeather"),
            ("PERblake", "Blake Marrowstone"),
            ("PERcasey", "Casey Thimbleton"),
            ("PERdrew", "Drew Pennywhistle"),
            ("PERellis", "Ellis Brackenfield"),
        ]
    );
    // Groups, events, forms, and the church's words as labels.
    let groups: Vec<(&str, Option<u32>)> = capture
        .groups()
        .iter()
        .map(|g| (g.id.as_str(), g.members))
        .collect();
    assert_eq!(
        groups,
        vec![
            ("GRPworship", Some(3)),
            ("GRPwelcome", Some(2)),
            ("GRPyouth", None)
        ]
    );
    assert_eq!(
        capture.events()[0].starts_at.as_str(),
        "2026-11-28T00:00:00.000Z"
    );
    assert_eq!(capture.events()[0].attendance, None);
    assert_eq!(capture.forms()[0].submissions, None);
    let labels: BTreeMap<String, &str> = capture
        .labels()
        .iter()
        .map(|(k, v)| (k.to_string(), v.as_str()))
        .collect();
    assert_eq!(labels["church"], "Cedar Hollow Fellowship");
    assert_eq!(labels["service"], "Sunday Gathering");
    assert_eq!(labels["position:POSsound"], "Sound");
    assert_eq!(labels["team:GRPworship"], "Worship Team");
    assert_eq!(labels["group:GRPyouth"], "Youth Night");
    assert_eq!(labels["event:EVTsupper"], "Harvest Supper");
    assert_eq!(labels["form:FRMfall"], "Fall Sign-up");
    assert!(!labels.contains_key("team:GRPyouth"));
    capture.valid().unwrap();
    // The JSON parses back to the same capture.
    let text = capture.to_json().unwrap();
    assert_eq!(SystemCapture::from_json(text.as_bytes()).unwrap(), capture);
    // Never a submissions read, never a write: every call a GET, the key only in the header.
    for call in fake.calls() {
        assert_eq!(call.method, "GET");
        assert!(!call.url.contains("formsubmissions"));
        assert!(!call.url.contains(&key_text()));
        assert_eq!(call.auth, format!("Bearer {}", key_text()));
    }
}

#[test]
fn names_are_only_in_names() {
    let (fake, clock) = setup();
    let capture = run_check(&fake, &clock);
    let mut value: Value = serde_json::from_str(&capture.to_json().unwrap()).unwrap();
    value.as_object_mut().unwrap().remove("names");
    let rest = value.to_string();
    for (_, name) in FICTIONAL {
        for part in name.split(' ') {
            assert!(!rest.contains(part), "{part}");
        }
    }
    assert!(!format!("{capture:?}").contains("Quillfeather"));
}

#[test]
fn a_bad_key_stops_the_check_at_the_church_read() {
    for answer in [raw(401, "{}"), raw(403, "[]")] {
        let (fake, clock) = setup();
        fake.set(&format!("/membership/churches/{CHURCH_ID}"), answer);
        let capture = run_check(&fake, &clock);
        assert_eq!(outcome(&capture, CHURCH), Outcome::KeyRefused);
        for read in &capture.reads()[1..] {
            assert_eq!(read.outcome, Outcome::NotRequested, "{:?}", read.read);
        }
        assert_eq!(fake.calls().len(), 1);
        assert!(
            capture.positions().is_empty()
                && capture.service().is_none()
                && capture.blockouts().is_none()
        );
        assert!(capture.names().is_empty());
    }
}

#[test]
fn a_200_that_carries_an_error_is_refused() {
    for body in [
        json!({"error": "Missing required parameters"}),
        json!({"errors": ["Login failed"]}),
    ] {
        let (fake, clock) = setup();
        fake.set(&format!("/doing/positions/plan/{PLAN_ID}"), ok(body));
        let capture = run_check(&fake, &clock);
        assert_eq!(outcome(&capture, POSITIONS), Outcome::Refused);
        assert!(capture.positions().is_empty());
        // What depends on positions isn't asked.
        assert_eq!(outcome(&capture, ASSIGNMENTS), Outcome::NotRequested);
        assert_eq!(outcome(&capture, GROUP_MEMBERS), Outcome::NotRequested);
        assert!(capture.assignments().is_empty() && capture.team_members().is_empty());
    }
}

#[test]
fn each_failure_has_its_word_and_leaves_its_part_empty() {
    let assignments = format!("/doing/assignments/plan/{PLAN_ID}");
    let cases: Vec<(Answer, Outcome)> = vec![
        (raw(401, "{}"), Outcome::Refused),
        (raw(404, "{}"), Outcome::NotFound),
        (raw(500, r#"{"errors":["x"]}"#), Outcome::Refused),
        (raw(302, ""), Outcome::Refused),
        (Answer::Fail(ReadError::Timeout), Outcome::Timeout),
        (Answer::Fail(ReadError::Unreachable), Outcome::Unreachable),
        (Answer::Fail(ReadError::TooLarge), Outcome::TooLarge),
        (raw(200, "[{\"id\": "), Outcome::InvalidResponse),
        (raw(200, "<html>Sign in</html>"), Outcome::InvalidResponse),
        (
            raw(
                200,
                r#"[{"id":"ASGone","positionId":"POSvocal","personId":"PERavery","personId":"PERzed","status":"Accepted"}]"#,
            ),
            Outcome::InvalidResponse,
        ),
        (ok(json!({"id": "ASGone"})), Outcome::InvalidResponse),
        (
            ok(
                json!([{"id": "ASGone", "positionId": "POSvocal", "personId": 42, "status": "Accepted"}]),
            ),
            Outcome::InvalidResponse,
        ),
        (
            ok(
                json!([{"id": "ASG one", "positionId": "POSvocal", "personId": "PERavery", "status": "Accepted"}]),
            ),
            Outcome::InvalidResponse,
        ),
        (
            ok(
                json!([{"id": "ASGone", "positionId": "POSvocal", "personId": "PERavery", "status": true}]),
            ),
            Outcome::InvalidResponse,
        ),
        (
            ok(
                json!([{"id": "ASGone", "positionId": "POSelsewhere", "personId": "PERavery", "status": "Accepted"}]),
            ),
            Outcome::InvalidResponse,
        ),
        (
            ok(
                json!([{"id": "ASGone", "positionId": "POSvocal", "personId": "PERavery", "status": "Accepted",
                       "planId": "PLAother"}]),
            ),
            Outcome::InvalidResponse,
        ),
    ];
    for (answer, expected) in cases {
        let (fake, clock) = setup();
        fake.set(&assignments, answer);
        let capture = run_check(&fake, &clock);
        assert_eq!(outcome(&capture, ASSIGNMENTS), expected);
        assert!(capture.assignments().is_empty(), "{expected:?}");
        // One failure doesn't stop the run; the rest is read (forms are never `ok`, see `the_forms_list_...`).
        assert_eq!(outcome(&capture, FORMS), Outcome::Truncated, "{expected:?}");
        assert!(!capture.positions().is_empty());
    }
}

#[test]
fn a_wrong_type_or_a_bad_id_rejects_the_read_it_is_in() {
    let positions = format!("/doing/positions/plan/{PLAN_ID}");
    for row in [
        json!({"id": "POSvocal", "count": "2"}),
        json!({"id": "POSvocal", "count": -1}),
        json!({"id": "POSvocal", "count": 1.5}),
        json!({"id": "POSvocal", "groupId": "GRP worship"}),
        json!({"id": "POSvocal", "groupId": 7}),
        json!({"id": "POSvocal", "name": ["Vocals"]}),
        json!({"id": "x".repeat(65)}),
        json!({"id": null}),
    ] {
        let (fake, clock) = setup();
        fake.set(&positions, ok(json!([row])));
        let capture = run_check(&fake, &clock);
        assert_eq!(
            outcome(&capture, POSITIONS),
            Outcome::InvalidResponse,
            "{row}"
        );
        assert!(capture.positions().is_empty());
    }
    // A church read for another church is refused too.
    let (fake, clock) = setup();
    fake.set(
        &format!("/membership/churches/{CHURCH_ID}"),
        ok(json!({"id": "CHUother", "name": "Another"})),
    );
    let capture = run_check(&fake, &clock);
    assert_eq!(outcome(&capture, CHURCH), Outcome::InvalidResponse);
    assert!(!capture.labels().contains_key(&LabelKey::Church));
}

#[test]
fn answer_words_are_matched_exactly() {
    for (word, expected) in [
        (json!("Accepted"), Status::Accepted),
        (json!("Unconfirmed"), Status::Unconfirmed),
        (json!("Declined"), Status::Declined),
        (json!("accepted"), Status::Unknown),
        (json!("DECLINED"), Status::Unknown),
        (json!("Tentative"), Status::Unknown),
        (json!(""), Status::Unknown),
        (Value::Null, Status::Unknown),
    ] {
        let (fake, clock) = setup();
        fake.set(
            &format!("/doing/assignments/plan/{PLAN_ID}"),
            ok(json!([{"id": "ASGone", "positionId": "POSvocal", "personId": "PERavery", "status": word}])),
        );
        let capture = run_check(&fake, &clock);
        assert_eq!(outcome(&capture, ASSIGNMENTS), Outcome::Ok);
        assert_eq!(capture.assignments()[0].status, expected, "{word}");
    }
}

#[test]
fn a_time_must_be_an_instant_and_end_after_it_starts() {
    for (start, end) in [
        ("2026-11-22T15:00:00", "2026-11-22T16:30:00"),
        ("2026-11-22 15:00:00", "2026-11-22 16:30:00"),
        ("2026-11-22T15:00:00.000Z", "2026-11-22T15:00:00.000Z"),
        ("2026-11-22T15:00:00.000Z", "2026-11-22T14:00:00.000Z"),
        ("2026-11-22T15:00:00.000000Z", "2026-11-22T16:00:00.000Z"),
    ] {
        let (fake, clock) = setup();
        fake.set(
            &format!("/doing/times/plan/{PLAN_ID}"),
            ok(json!([{"id": "TIMservice", "startTime": start, "endTime": end}])),
        );
        let capture = run_check(&fake, &clock);
        assert_eq!(
            outcome(&capture, TIMES),
            Outcome::InvalidResponse,
            "{start}"
        );
        assert!(capture.service().is_none());
        // With no service there is nothing to place blockouts against: they aren't read.
        assert_eq!(outcome(&capture, BLOCKOUTS), Outcome::NotRequested);
        assert!(capture.blockouts().is_none());
        assert!(!capture.labels().contains_key(&LabelKey::Service));
    }
    // `Z` and a numeric offset are both instants (b1-church-times.md 2.1).
    for (start, end) in [
        ("2026-11-22T15:00:00Z", "2026-11-22T16:30:00Z"),
        ("2026-11-22T09:00:00-06:00", "2026-11-22T10:30:00-06:00"),
    ] {
        let (fake, clock) = setup();
        fake.set(
            &format!("/doing/times/plan/{PLAN_ID}"),
            ok(json!([{"id": "TIMservice", "startTime": start, "endTime": end}])),
        );
        let capture = run_check(&fake, &clock);
        assert_eq!(outcome(&capture, TIMES), Outcome::Ok);
        assert_eq!(
            capture.service().unwrap().starts_at.unix_millis(),
            1_795_359_600_000
        );
    }
    // Only a rehearsal days before: no time on the plan's day, so no service, and the read says the plan's times
    // couldn't be placed.
    let (fake, clock) = setup();
    fake.set(
        &format!("/doing/times/plan/{PLAN_ID}"),
        ok(json!([{"id": "TIMrehearse", "startTime": "2026-11-20T01:00:00.000Z", "endTime": null}])),
    );
    let capture = run_check(&fake, &clock);
    assert_eq!(outcome(&capture, TIMES), Outcome::Truncated);
    assert!(capture.service().is_none());
    // A service time without an end: the service has none.
    let (fake, clock) = setup();
    fake.set(
        &format!("/doing/times/plan/{PLAN_ID}"),
        ok(json!([{"id": "TIMservice", "startTime": "2026-11-22T15:00:00.000Z"}])),
    );
    let capture = run_check(&fake, &clock);
    assert!(capture.service().unwrap().ends_at.is_none());
    // Without the church's zone (this Mac doesn't know it): times more than a day apart that could each be on the
    // plan's day are kept, and the read says it may hold another day's time (a Saturday morning rehearsal).
    let (fake, clock) = setup();
    fake.set(
        &format!("/doing/times/plan/{PLAN_ID}"),
        ok(json!([
            {"id": "TIMsat", "startTime": "2026-11-21T14:00:00.000Z", "endTime": "2026-11-21T15:00:00.000Z"},
            {"id": "TIMsun", "startTime": "2026-11-22T15:00:00.000Z", "endTime": "2026-11-22T16:30:00.000Z"}
        ])),
    );
    let capture = check(
        &fake,
        &*clock,
        &crate::zones::NoZones,
        &key(),
        &id(CHURCH_ID),
        &id(PLAN_ID),
        None,
    )
    .unwrap();
    assert_eq!(outcome(&capture, TIMES), Outcome::Truncated);
    assert_eq!(
        capture.service().unwrap().starts_at.as_str(),
        "2026-11-21T14:00:00.000Z"
    );
}

#[test]
fn blockouts_follow_b1s_own_day_rule_against_the_service() {
    // Chicago, b1-church-times.md 2.1 and 2.3: Sunday 2026-11-22, 9:00 to 10:15 CST is 15:00Z to 16:15Z; an evening
    // service at 19:00 CST is 01:00Z to 02:00Z on the Monday.
    let day = Date::parse("2026-11-22").unwrap();
    let service = |start: &str, end: &str| crate::capture::Service {
        id: id(PLAN_ID),
        day: Some(day),
        starts_at: Time::parse(start).unwrap(),
        ends_at: Some(Time::parse(end).unwrap()),
        shared: None,
    };
    let morning = service("2026-11-22T15:00:00.000Z", "2026-11-22T16:15:00.000Z");
    let evening = service("2026-11-23T01:00:00.000Z", "2026-11-23T02:00:00.000Z");
    let meets = |first: &str, last: &str, s: &crate::capture::Service| {
        let (a, b) = blockout_moments(
            Date::parse(first).unwrap(),
            Date::parse(last).unwrap(),
            day,
            s,
        )
        .unwrap();
        assert!(b.unix_millis() > a.unix_millis());
        let (s0, s1) = (
            s.starts_at.unix_millis(),
            s.ends_at.as_ref().unwrap().unix_millis(),
        );
        a.unix_millis() < s1 && b.unix_millis() > s0
    };
    for s in [&morning, &evening] {
        // Inclusive of both days: blocked when first <= plan day <= last.
        assert!(meets("2026-11-20", "2026-11-22", s));
        assert!(meets("2026-11-22", "2026-11-22", s));
        assert!(meets("2026-11-22", "2026-11-30", s));
        // Not blocked on the day before or after, however the UTC days fall.
        assert!(!meets("2026-11-21", "2026-11-21", s));
        assert!(!meets("2026-11-23", "2026-11-23", s));
        assert!(!meets("2026-11-23", "2026-12-01", s));
        assert!(!meets("2026-11-01", "2026-11-21", s));
    }
    // The fixture's same-day blockout is written as its UTC day, already covering the morning service.
    let (a, b) = blockout_moments(day, day, day, &morning).unwrap();
    assert_eq!(
        (a.as_str(), b.as_str()),
        ("2026-11-22T00:00:00Z", "2026-11-23T00:00:00Z")
    );
    // For the evening service it is widened to cover it.
    let (_, b) = blockout_moments(day, day, day, &evening).unwrap();
    assert_eq!(b.as_str(), "2026-11-23T02:00:00Z");
}

#[test]
fn repeating_events_are_left_out_by_design_and_the_read_is_whole() {
    let (fake, clock) = setup();
    fake.set(
        "/content/events/timeline",
        ok(json!([
            {"id": "EVTsupper", "title": "Harvest Supper", "start": "2026-11-28T00:00:00.000Z",
             "end": "2026-11-28T02:00:00.000Z", "recurrenceRule": null},
            {"id": "EVTweekly", "title": "Sunday Gathering", "start": "2026-11-22T15:00:00.000Z",
             "end": "2026-11-22T16:15:00.000Z", "recurrenceRule": "FREQ=WEEKLY;BYDAY=SU",
             "exceptionDates": ["2026-12-06T15:00:00.000Z"]}
        ])),
    );
    let capture = run_check(&fake, &clock);
    // Left out by design (facts.ts says so), never a read cut short: the check isn't partial for it (round 3).
    assert_eq!(outcome(&capture, EVENTS), Outcome::Ok);
    assert_eq!(capture.events().len(), 1);
    assert_eq!(capture.events()[0].id, id("EVTsupper"));
    assert!(
        !capture
            .labels()
            .contains_key(&LabelKey::Event(id("EVTweekly")))
    );
}

#[test]
fn a_day_is_accepted_only_where_it_cant_be_a_shifted_day() {
    assert_eq!(b1_day("2026-11-22").unwrap().to_string(), "2026-11-22");
    assert_eq!(
        b1_day("2026-11-22T00:00:00Z").unwrap().to_string(),
        "2026-11-22"
    );
    assert_eq!(
        b1_day("2026-11-22T00:00:00.000Z").unwrap().to_string(),
        "2026-11-22"
    );
    for text in [
        "2026-11-22T06:00:00.000Z",
        "2026-11-21T23:00:00.000Z",
        "2026-11-22T00:00:00-06:00",
        "2026-11-22T00:00:00",
        "2026-02-30",
        "11/22/2026",
        "",
    ] {
        assert!(b1_day(text).is_none(), "{text}");
    }
    let (fake, clock) = setup();
    fake.set(
        "/doing/blockoutDates/upcoming",
        ok(json!([{"personId": "PERdrew", "startDate": "2026-11-22T06:00:00.000Z", "endDate": "2026-11-22"}])),
    );
    let capture = run_check(&fake, &clock);
    assert_eq!(outcome(&capture, BLOCKOUTS), Outcome::InvalidResponse);
    assert!(capture.blockouts().is_none());
    // A blockout that ends before it starts is refused.
    let (fake, clock) = setup();
    fake.set(
        "/doing/blockoutDates/upcoming",
        ok(json!([{"personId": "PERdrew", "startDate": "2026-11-23", "endDate": "2026-11-22"}])),
    );
    assert_eq!(
        outcome(&run_check(&fake, &clock), BLOCKOUTS),
        Outcome::InvalidResponse
    );
}

#[test]
fn rate_limited_stops_the_run_with_a_capped_wait() {
    let (fake, clock) = setup();
    fake.set(
        &format!("/doing/positions/plan/{PLAN_ID}"),
        Answer::Retry(429, "3600"),
    );
    let capture = run_check(&fake, &clock);
    assert_eq!(outcome(&capture, POSITIONS), Outcome::RateLimited);
    let after: Vec<Outcome> = capture.reads()[3..].iter().map(|r| r.outcome).collect();
    assert!(
        after.iter().all(|o| *o == Outcome::NotRequested),
        "{after:?}"
    );
    assert_eq!(fake.calls().len(), 3);
    // The wait it asked for, capped, is what plans() and verify_key() give back.
    let (fake, clock) = setup();
    fake.set("/doing/plans/overview", Answer::Retry(429, "3600"));
    assert_eq!(
        plans(&fake, &*clock, &key(), &id(CHURCH_ID)).unwrap_err(),
        ReadError::RateLimited(Some(Duration::from_secs(60)))
    );
}

#[test]
fn three_failures_in_a_row_stop_the_run() {
    let (fake, clock) = setup();
    fake.set(&format!("/doing/plans/{PLAN_ID}"), raw(500, "{}"));
    fake.set(&format!("/doing/positions/plan/{PLAN_ID}"), raw(500, "{}"));
    fake.set("/membership/groups", Answer::Fail(ReadError::Unreachable));
    let capture = run_check(&fake, &clock);
    assert_eq!(
        outcomes(&capture),
        vec![
            ("b1.church", Outcome::Ok),
            ("b1.plans", Outcome::Refused),
            ("b1.positions", Outcome::Refused),
            // Dependents aren't asked, and aren't failures.
            ("b1.assignments", Outcome::NotRequested),
            ("b1.group_members", Outcome::NotRequested),
            ("b1.times", Outcome::NotRequested),
            ("b1.blockouts", Outcome::NotRequested),
            ("b1.plans_day", Outcome::NotRequested),
            ("b1.people", Outcome::NotRequested),
            ("b1.groups", Outcome::Unreachable),
            ("b1.events", Outcome::NotRequested),
            ("b1.forms", Outcome::NotRequested),
        ]
    );
    assert_eq!(fake.calls().len(), 4);
    // A success between failures resets the count.
    let (fake, clock) = setup();
    fake.set(&format!("/doing/plans/{PLAN_ID}"), raw(500, "{}"));
    fake.set("/membership/groups", raw(500, "{}"));
    fake.set("/content/events/timeline", raw(500, "{}"));
    let capture = run_check(&fake, &clock);
    assert_eq!(outcome(&capture, POSITIONS), Outcome::Ok);
    assert_eq!(outcome(&capture, GROUPS), Outcome::Refused);
    assert_eq!(outcome(&capture, EVENTS), Outcome::Refused);
    assert_eq!(outcome(&capture, FORMS), Outcome::Truncated);
}

#[test]
fn requests_are_paced_capped_and_inside_the_budget() {
    // Pacing: no two request starts closer than 250 ms, so at most 4 a second.
    let (mut fake, clock) = setup();
    fake.latency = Duration::ZERO;
    run_check(&fake, &clock);
    let starts: Vec<Duration> = fake.calls().iter().map(|c| c.at).collect();
    // 13 reads and whether the other plan is shared (`/doing/plans/ids`, for `busy`).
    assert_eq!(starts.len(), 14);
    for pair in starts.windows(2) {
        assert!(pair[1] - pair[0] >= Duration::from_millis(250), "{pair:?}");
    }
    for window in starts.windows(5) {
        assert!(window[4] - window[0] >= Duration::from_secs(1));
    }
    // The request cap: no more than the limit is sent, the rest not requested.
    let (fake, clock) = setup();
    let limits = Limits {
        max_requests: 4,
        ..LIMITS
    };
    let capture = check_with(
        &fake,
        &*clock,
        &crate::test_support::FakeZones::standard(),
        &key(),
        &id(CHURCH_ID),
        &id(PLAN_ID),
        None,
        limits,
    )
    .unwrap();
    assert_eq!(fake.calls().len(), 4);
    assert_eq!(outcome(&capture, ASSIGNMENTS), Outcome::Ok);
    assert!(
        capture.reads()[4..]
            .iter()
            .all(|r| r.outcome == Outcome::NotRequested)
    );
    // The 40-request default with many people: names are asked 100 at a time and the run never passes 40.
    let (mut fake, clock) = setup();
    let many: Vec<Value> = (0..2000)
        .map(|n| json!({"groupId": "GRPworship", "personId": format!("PERmany{n}")}))
        .collect();
    fake.set("/membership/groupmembers", ok(Value::Array(many)));
    for n in 0..2000 {
        let pid = format!("PERmany{n}");
        fake.people.insert(
            pid.clone(),
            json!({"id": pid, "name": {"display": format!("Fictional Person {n}")}}),
        );
    }
    let capture = run_check(&fake, &clock);
    assert!(fake.calls().len() <= 40);
    assert_eq!(capture.team_members().len(), 2000);
    assert_eq!(outcome(&capture, PEOPLE), Outcome::Ok);
    assert_eq!(capture.names().len(), 2003);
    let names_calls = fake
        .paths()
        .iter()
        .filter(|p| *p == "/membership/people/names")
        .count();
    assert_eq!(names_calls, 21);
    // The budget: a slow system uses it up; the read that would start after it is a timeout, the rest not
    // requested, and no request is given more time than is left.
    let (mut fake, clock) = setup();
    fake.latency = Duration::from_secs(14);
    let capture = run_check(&fake, &clock);
    assert_eq!(fake.calls().len(), 5);
    assert_eq!(outcome(&capture, TIMES), Outcome::Timeout);
    assert!(
        capture.reads()[6..]
            .iter()
            .all(|r| r.outcome == Outcome::NotRequested)
    );
    let first = fake.calls()[0].at;
    for call in fake.calls() {
        assert!(call.limit <= Duration::from_secs(15));
        assert!(call.limit <= LIMITS.budget - (call.at - first));
    }
    assert_eq!(fake.calls()[4].limit, Duration::from_secs(4));
}

#[test]
fn a_run_that_stops_part_way_through_names_keeps_them_as_truncated() {
    let (mut fake, clock) = setup();
    let many: Vec<Value> = (0..250)
        .map(|n| json!({"groupId": "GRPworship", "personId": format!("PERmany{n}")}))
        .collect();
    fake.set("/membership/groupmembers", ok(Value::Array(many)));
    for n in 0..250 {
        let pid = format!("PERmany{n}");
        fake.people.insert(
            pid.clone(),
            json!({"id": pid, "name": {"display": "Fictional Person"}}),
        );
    }
    // Church, plans, positions, assignments, group members, times, blockouts, the overview (nobody here is on another
    // plan, so no plan times), then one names request.
    let limits = Limits {
        max_requests: 9,
        ..LIMITS
    };
    let capture = check_with(
        &fake,
        &*clock,
        &crate::test_support::FakeZones::standard(),
        &key(),
        &id(CHURCH_ID),
        &id(PLAN_ID),
        None,
        limits,
    )
    .unwrap();
    assert_eq!(outcome(&capture, PEOPLE), Outcome::Truncated);
    assert_eq!(capture.names().len(), 100);
    // A names request that fails leaves no names at all.
    let (mut fake, clock) = setup();
    fake.people.insert(
        "PERavery".into(),
        json!({"id": "PERzed", "name": {"display": "Zed Outsider"}}),
    );
    let capture = run_check(&fake, &clock);
    assert_eq!(outcome(&capture, PEOPLE), Outcome::InvalidResponse);
    assert!(capture.names().is_empty());
}

#[test]
fn caps_cut_and_say_so() {
    let (fake, clock) = setup();
    let many: Vec<Value> = (0..250)
        .map(|n| json!({"id": format!("POS{n}"), "count": 1, "groupId": "GRPworship"}))
        .collect();
    fake.set(
        &format!("/doing/positions/plan/{PLAN_ID}"),
        ok(Value::Array(many)),
    );
    fake.set(
        &format!("/doing/assignments/plan/{PLAN_ID}"),
        ok(json!([
            {"id": "ASGkept", "positionId": "POS3", "personId": "PERavery", "status": "Accepted"},
            {"id": "ASGcut", "positionId": "POS240", "personId": "PERblake", "status": "Accepted"}
        ])),
    );
    let capture = run_check(&fake, &clock);
    assert_eq!(capture.positions().len(), MAX_POSITIONS);
    assert_eq!(outcome(&capture, POSITIONS), Outcome::Truncated);
    assert_eq!(outcome(&capture, ASSIGNMENTS), Outcome::Truncated);
    assert_eq!(capture.assignments().len(), 1);
    capture.valid().unwrap();
    // A zone Ozzie can't read is left out and the church read says so.
    let (fake, clock) = setup();
    fake.set(
        &format!("/membership/churches/{CHURCH_ID}"),
        ok(json!({"id": CHURCH_ID, "name": "Cedar Hollow Fellowship", "timeZone": "Central Standard Time"})),
    );
    let capture = run_check(&fake, &clock);
    assert_eq!(outcome(&capture, CHURCH), Outcome::Truncated);
    assert!(capture.church().time_zone.is_none());
}

/// The church record as B1 answers it live (2026-11-17, a new church): every field the live read showed, with invented
/// values, and `timeZone` null.
fn live_church_record(time_zone: serde_json::Value) -> Value {
    json!({
        "address1": "1 Fictional Way", "address2": "", "archivedDate": null, "city": "Fictionville",
        "country": "US", "emailApprovedDate": null, "firstDayOfWeek": 0, "id": CHURCH_ID,
        "latitude": null, "longitude": null, "name": "Cedar Hollow Fellowship",
        "registrationDate": "2026-11-17T14:02:11.000Z", "state": "IL", "subDomain": "cedarhollow",
        "timeZone": time_zone, "zip": "00000"
    })
}

#[test]
fn verify_key_reads_the_churchs_own_record() {
    let (fake, clock) = setup();
    fake.set(
        &format!("/membership/churches/{CHURCH_ID}"),
        ok(live_church_record(Value::Null)),
    );
    let church = verify_key(&fake, &*clock, &key(), &id(CHURCH_ID)).unwrap();
    assert_eq!(church.id, id(CHURCH_ID));
    assert_eq!(church.name.unwrap().as_str(), "Cedar Hollow Fellowship");
    assert_eq!(
        fake.paths(),
        vec![format!("/membership/churches/{CHURCH_ID}")]
    );
    for answer in [raw(401, "{}"), raw(403, "{}")] {
        let (fake, clock) = setup();
        fake.set(&format!("/membership/churches/{CHURCH_ID}"), answer);
        assert_eq!(
            verify_key(&fake, &*clock, &key(), &id(CHURCH_ID)).unwrap_err(),
            ReadError::KeyRefused
        );
    }
    for answer in [
        ok(json!({"error": "nope"})),
        ok(json!([])),
        ok(json!({"id": "CHUother01", "name": "Another"})),
        ok(json!({"id": "CHU 1"})),
        ok(json!({"id": CHURCH_ID, "timeZone": 5})),
    ] {
        let (fake, clock) = setup();
        fake.set(&format!("/membership/churches/{CHURCH_ID}"), answer);
        let error = verify_key(&fake, &*clock, &key(), &id(CHURCH_ID)).unwrap_err();
        assert!(
            matches!(error, ReadError::InvalidResponse | ReadError::Refused),
            "{error}"
        );
    }
    // An id that is one of B1's route words is refused before anything is sent.
    let (fake, clock) = setup();
    assert_eq!(
        verify_key(&fake, &*clock, &key(), &id("upcoming")).unwrap_err(),
        ReadError::NotFound
    );
    assert!(fake.calls().is_empty());
}

#[test]
fn a_church_with_no_time_zone_reads_ok_with_a_null_zone() {
    let (fake, clock) = setup();
    fake.set(
        &format!("/membership/churches/{CHURCH_ID}"),
        ok(live_church_record(Value::Null)),
    );
    let capture = run_check(&fake, &clock);
    assert_eq!(outcome(&capture, CHURCH), Outcome::Ok);
    assert!(capture.church().time_zone.is_none());
    // With no zone, B1's own day can't be trusted: the service's day is null.
    assert!(capture.service().unwrap().day.is_none());
    let (fake, clock) = setup();
    fake.set(
        &format!("/membership/churches/{CHURCH_ID}"),
        ok(live_church_record(json!("America/Chicago"))),
    );
    let capture = run_check(&fake, &clock);
    assert_eq!(outcome(&capture, CHURCH), Outcome::Ok);
    assert_eq!(
        capture.church().time_zone.as_ref().unwrap().as_str(),
        "America/Chicago"
    );
}

#[test]
fn plans_lists_upcoming_plans_after_proving_the_key() {
    let (fake, clock) = setup();
    // Whether each is shared: a plan the answer names; one it leaves out couldn't be told (null).
    fake.set(
        "/doing/plans/ids?ids=PLAfict01%2CPLAlate",
        ok(json!([{"id": "PLAfict01", "serviceDate": "2026-11-22T00:00:00.000Z", "prepared": false},
                  {"id": "PLAlate", "serviceDate": "2026-11-22T00:00:00.000Z", "prepared": false}])),
    );
    let choices = plans(&fake, &*clock, &key(), &id(CHURCH_ID)).unwrap();
    let listed: Vec<(String, String, Option<bool>)> = choices
        .iter()
        .map(|c| {
            (
                c.id.as_str().to_owned(),
                c.service_date.to_string(),
                c.shared,
            )
        })
        .collect();
    assert_eq!(
        listed,
        vec![
            (PLAN_ID.to_owned(), "2026-11-22".to_owned(), Some(true)),
            ("PLAlate".to_owned(), "2026-11-22".to_owned(), Some(true)),
        ]
    );
    assert_eq!(choices[1].name.as_ref().unwrap().as_str(), "Late Service");
    assert_eq!(
        fake.paths(),
        vec![
            format!("/membership/churches/{CHURCH_ID}"),
            "/doing/plans/overview".to_owned(),
            "/doing/plans/ids".to_owned()
        ]
    );
    // A bad key: B1 would answer the overview 200 [] (research 2.3), but the church read refuses it first.
    let (fake, clock) = setup();
    fake.set(&format!("/membership/churches/{CHURCH_ID}"), raw(401, "{}"));
    fake.set("/doing/plans/overview", ok(json!([])));
    assert_eq!(
        plans(&fake, &*clock, &key(), &id(CHURCH_ID)).unwrap_err(),
        ReadError::KeyRefused
    );
    assert_eq!(fake.calls().len(), 1);
    // After a good church read, an empty list is a real empty list, and nothing more is asked.
    let (fake, clock) = setup();
    fake.set("/doing/plans/overview", ok(json!([])));
    assert!(
        plans(&fake, &*clock, &key(), &id(CHURCH_ID))
            .unwrap()
            .is_empty()
    );
    assert_eq!(fake.calls().len(), 2);
    // A plan whose day can't be read, or one plan with two days, refuses the list.
    for rows in [
        json!([{"planId": PLAN_ID, "serviceDate": "next Sunday"}]),
        json!([{"planId": PLAN_ID, "serviceDate": "2026-11-22T00:00:00.000Z"},
               {"planId": PLAN_ID, "serviceDate": "2026-11-29T00:00:00.000Z"}]),
    ] {
        let (fake, clock) = setup();
        fake.set("/doing/plans/overview", ok(rows));
        assert_eq!(
            plans(&fake, &*clock, &key(), &id(CHURCH_ID)).unwrap_err(),
            ReadError::InvalidResponse
        );
    }
}

#[test]
fn the_key_never_appears_in_errors_captures_or_requests() {
    let secret = key_text();
    let (fake, clock) = setup();
    let capture = run_check(&fake, &clock);
    let get = Get::new(&Read::Groups, Auth::Bearer(key()));
    let printed = [
        format!("{:?}", key()),
        format!("{get:?}"),
        get.url().to_string(),
        format!("{capture:?}"),
        capture.to_json().unwrap(),
        format!("{:?}", plans(&fake, &*clock, &key(), &id(CHURCH_ID))),
        format!("{:?}", verify_key(&fake, &*clock, &key(), &id(CHURCH_ID))),
        format!(
            "{:?}",
            crate::keys::Key::parse(System::B1, &format!("{secret}x"))
        ),
        serde_json::to_string(
            &crate::keys::Key::parse(System::B1, &format!("{secret}x")).unwrap_err(),
        )
        .unwrap(),
    ];
    for error in [
        ReadError::KeyRefused,
        ReadError::Refused,
        ReadError::NotFound,
        ReadError::RateLimited(Some(Duration::from_secs(5))),
        ReadError::Timeout,
        ReadError::Unreachable,
        ReadError::TooLarge,
        ReadError::InvalidResponse,
    ] {
        for text in [
            format!("{error:?}"),
            format!("{error}"),
            serde_json::to_string(&error).unwrap(),
        ] {
            assert!(!text.contains(&secret));
        }
    }
    for text in printed {
        assert!(!text.contains(&secret), "{text}");
        assert!(!text.contains(&secret[4..20]));
    }
    // The header is the one place it goes.
    assert!(get.auth_header().1.contains(&secret));
}

#[test]
fn a_key_for_another_system_is_refused() {
    // No other system's key can be made yet (keys.rs says `unsupported`); a B1 check only ever takes a B1 key.
    assert!(crate::keys::Key::parse(System::Breeze, &key_text()).is_err());
    assert_eq!(key().system(), System::B1);
}

/// What B1's anonymous lookup answers for a church's address (ChurchController `getBySubDomain`).
fn lookup_answer() -> Value {
    json!({"id": CHURCH_ID, "name": "Cedar Hollow Fellowship", "subDomain": "cedarhollow", "firstDayOfWeek": 0})
}

#[test]
fn connect_looks_the_address_up_then_reads_that_churchs_own_record() {
    let (fake, clock) = setup();
    fake.set("/membership/churches/lookup", ok(lookup_answer()));
    fake.set(
        &format!("/membership/churches/{CHURCH_ID}"),
        ok(live_church_record(Value::Null)),
    );
    let church = connect(&fake, &*clock, &key(), &id("cedarhollow")).unwrap();
    assert_eq!(church.id, id(CHURCH_ID));
    assert_eq!(church.name.unwrap().as_str(), "Cedar Hollow Fellowship");
    let calls = fake.calls();
    assert_eq!(calls.len(), 2);
    assert_eq!(
        calls[0].url,
        "https://api.churchapps.org/membership/churches/lookup?subDomain=cedarhollow"
    );
    assert_eq!(
        calls[1].url,
        format!("https://api.churchapps.org/membership/churches/{CHURCH_ID}")
    );
    // Both go to B1's one host, each a GET with the key's one header, paced like every run.
    assert!(calls.iter().all(|c| c.method == "GET"));
    assert!(calls[1].at - calls[0].at >= Duration::from_millis(250));
}

#[test]
fn connect_says_which_part_failed_in_closed_words() {
    // `{}`: B1 has no church at that address.
    let (fake, clock) = setup();
    fake.set("/membership/churches/lookup", ok(json!({})));
    assert_eq!(
        connect(&fake, &*clock, &key(), &id("nosuchchurch")).unwrap_err(),
        ReadError::NotFound
    );
    assert_eq!(fake.calls().len(), 1);
    // The key doesn't open that church (a bad key, or another church's): 401 on the church's own record.
    for answer in [raw(401, "{}"), raw(403, "{}")] {
        let (fake, clock) = setup();
        fake.set("/membership/churches/lookup", ok(lookup_answer()));
        fake.set(&format!("/membership/churches/{CHURCH_ID}"), answer);
        assert_eq!(
            connect(&fake, &*clock, &key(), &id("cedarhollow")).unwrap_err(),
            ReadError::KeyRefused
        );
    }
    // B1's lookup failing is that read refused (its 500 `{error}`), never a key problem.
    for answer in [
        raw(500, r#"{"error":"Internal server error"}"#),
        ok(json!({"error": "x"})),
    ] {
        let (fake, clock) = setup();
        fake.set("/membership/churches/lookup", answer);
        assert_eq!(
            connect(&fake, &*clock, &key(), &id("cedarhollow")).unwrap_err(),
            ReadError::Refused
        );
    }
    // A lookup answer that isn't a church Ozzie can read: an id that is a route word, a bad id, not an object.
    for answer in [
        ok(json!({"id": "lookup", "name": "x"})),
        ok(json!({"id": "Upcoming"})),
        ok(json!({"id": "CHU 1"})),
        ok(json!({"id": null})),
        ok(json!([])),
        ok(json!({"id": CHURCH_ID, "name": 5})),
    ] {
        let (fake, clock) = setup();
        fake.set("/membership/churches/lookup", answer);
        assert_eq!(
            connect(&fake, &*clock, &key(), &id("cedarhollow")).unwrap_err(),
            ReadError::InvalidResponse
        );
        assert_eq!(fake.calls().len(), 1);
    }
    // The church's record must be the church the address named.
    let (fake, clock) = setup();
    fake.set("/membership/churches/lookup", ok(lookup_answer()));
    fake.set(
        &format!("/membership/churches/{CHURCH_ID}"),
        ok(json!({"id": "CHUother01", "name": "Another"})),
    );
    assert_eq!(
        connect(&fake, &*clock, &key(), &id("cedarhollow")).unwrap_err(),
        ReadError::InvalidResponse
    );
    // Not reached, slowed down, another system's key.
    let (fake, clock) = setup();
    fake.set(
        "/membership/churches/lookup",
        Answer::Fail(ReadError::Unreachable),
    );
    assert_eq!(
        connect(&fake, &*clock, &key(), &id("cedarhollow")).unwrap_err(),
        ReadError::Unreachable
    );
    let (fake, clock) = setup();
    assert_eq!(
        connect(
            &fake,
            &*clock,
            &crate::test_support::breeze_key(),
            &id("cedarhollow")
        )
        .unwrap_err(),
        ReadError::KeyRefused
    );
    assert!(fake.calls().is_empty());
}

#[test]
fn the_lookup_is_a_read_the_guard_lets_out_and_lookup_is_never_a_church_id() {
    let http = crate::http::NativeHttp::new().unwrap();
    let get = Get::new(&Read::Lookup(id("cedarhollow")), Auth::Bearer(key()));
    assert_eq!(
        get.url().as_str(),
        "https://api.churchapps.org/membership/churches/lookup?subDomain=cedarhollow"
    );
    assert_eq!(crate::http::allowed(&http.build(&get).unwrap()), Ok(()));
    // `lookup` as a church id is still refused before anything is sent.
    let (fake, clock) = setup();
    assert_eq!(
        verify_key(&fake, &*clock, &key(), &id("lookup")).unwrap_err(),
        ReadError::NotFound
    );
    assert!(fake.calls().is_empty());
}
