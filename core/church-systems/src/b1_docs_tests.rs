//! B1 Church, checked against its docs and its server source (the 2026-11-17 audit): times by B1's own type, rows the
//! server tolerates, plans not yet shared, the forms list a read-only key gets, the plan picker, route words, group
//! sizes, and whether each person was asked.
use crate::capture::{Outcome, ReadWord, SystemCapture};
use crate::test_support::{FakeB1, FakeClock, FakeZones, NOW, fake_b1, id, key, ok};
use crate::{b1, breeze};
use serde_json::{Value, json};

fn outcome(capture: &SystemCapture, word: ReadWord) -> Outcome {
    capture
        .reads()
        .iter()
        .find(|r| r.read == word)
        .unwrap()
        .outcome
}
fn check(fake: &FakeB1, clock: &FakeClock) -> SystemCapture {
    b1::check(
        fake,
        clock,
        &FakeZones::standard(),
        &key(),
        &id("CHUfict01"),
        &id("PLAfict01"),
        None,
    )
    .unwrap()
}
/// The fictional church in `zone`, its plan saved on `day`, with these times.
fn with_times(zone: &str, day: &str, times: Value) -> SystemCapture {
    let clock = FakeClock::at(NOW);
    let fake = fake_b1(clock.clone());
    fake.set(
        "/membership/churches/CHUfict01",
        ok(json!({"id": "CHUfict01", "name": "Cedar Hollow Fellowship", "timeZone": zone})),
    );
    fake.set(
        "/doing/plans/PLAfict01",
        ok(json!({"id": "PLAfict01", "name": "Sunday Gathering", "serviceDate": format!("{day}T00:00:00.000Z")})),
    );
    fake.set("/doing/times/plan/PLAfict01", ok(times));
    check(&fake, &clock)
}
fn time(id: &str, kind: Option<&str>, start: Option<&str>, end: &str) -> Value {
    let mut row = json!({"id": id, "planId": "PLAfict01", "startTime": start, "endTime": end});
    if let Some(kind) = kind {
        row["serviceTimeType"] = json!(kind);
    }
    row
}
fn service(capture: &SystemCapture) -> (String, Option<String>, Option<String>) {
    let s = capture.service().unwrap();
    (
        s.starts_at.as_str().to_owned(),
        s.ends_at.as_ref().map(|e| e.as_str().to_owned()),
        s.day.map(|d| d.to_string()),
    )
}

/// Item 1: The service is made only of times B1 types as a service; a rehearsal or "other" time never enters it and, by
/// itself, no longer makes the read `truncated`. Which day is still worked out from the zone (`real_day`).
#[test]
fn the_service_is_only_the_times_b1_types_as_a_service() {
    // Auckland, plan saved 11-21 (Sunday 11-22): a Saturday rehearsal and the Sunday service.
    let capture = with_times(
        "Pacific/Auckland",
        "2026-11-21",
        json!([
            time(
                "TIMa",
                Some("rehearsal"),
                Some("2026-11-21T06:00:00.000Z"),
                "2026-11-21T07:00:00.000Z"
            ),
            time(
                "TIMb",
                Some("service"),
                Some("2026-11-21T21:00:00.000Z"),
                "2026-11-21T22:15:00.000Z"
            )
        ]),
    );
    assert_eq!(outcome(&capture, b1::TIMES), Outcome::Ok);
    assert_eq!(
        service(&capture),
        (
            "2026-11-21T21:00:00.000Z".into(),
            Some("2026-11-21T22:15:00.000Z".into()),
            Some("2026-11-22".into())
        )
    );
    // Chicago: a Saturday rehearsal.
    let capture = with_times(
        "America/Chicago",
        "2026-11-22",
        json!([
            time(
                "TIMa",
                Some("rehearsal"),
                Some("2026-11-21T16:00:00.000Z"),
                "2026-11-21T17:00:00.000Z"
            ),
            time(
                "TIMb",
                Some("service"),
                Some("2026-11-22T15:00:00.000Z"),
                "2026-11-22T16:30:00.000Z"
            )
        ]),
    );
    assert_eq!(outcome(&capture, b1::TIMES), Outcome::Ok);
    assert_eq!(service(&capture).0, "2026-11-22T15:00:00.000Z");
    // Sydney: a Saturday "other" time.
    let capture = with_times(
        "Australia/Sydney",
        "2026-11-22",
        json!([
            time(
                "TIMa",
                Some("other"),
                Some("2026-11-21T07:00:00.000Z"),
                "2026-11-21T08:00:00.000Z"
            ),
            time(
                "TIMb",
                Some("service"),
                Some("2026-11-21T22:00:00.000Z"),
                "2026-11-21T23:15:00.000Z"
            )
        ]),
    );
    assert_eq!(outcome(&capture, b1::TIMES), Outcome::Ok);
    assert_eq!(service(&capture).2.as_deref(), Some("2026-11-22"));
    // A rehearsal the same morning never widens the service.
    let capture = with_times(
        "America/Chicago",
        "2026-11-22",
        json!([
            time(
                "TIMa",
                Some("rehearsal"),
                Some("2026-11-22T14:00:00.000Z"),
                "2026-11-22T15:00:00.000Z"
            ),
            time(
                "TIMb",
                Some("service"),
                Some("2026-11-22T16:00:00.000Z"),
                "2026-11-22T17:15:00.000Z"
            )
        ]),
    );
    assert_eq!(outcome(&capture, b1::TIMES), Outcome::Ok);
    assert_eq!(
        service(&capture),
        (
            "2026-11-22T16:00:00.000Z".into(),
            Some("2026-11-22T17:15:00.000Z".into()),
            Some("2026-11-22".into())
        )
    );
    // A time with no type is a service, as B1 itself reads it (its signup deadline: `serviceTimeType || "service"`).
    let capture = with_times(
        "America/Chicago",
        "2026-11-22",
        json!([time(
            "TIMb",
            None,
            Some("2026-11-22T15:00:00.000Z"),
            "2026-11-22T16:30:00.000Z"
        )]),
    );
    assert_eq!(outcome(&capture, b1::TIMES), Outcome::Ok);
}

/// The clocks-forward weekend in New Zealand: the day can't be told, so the service (the service-typed time only) has
/// no day and the read is `truncated`; the rehearsal is never taken.
#[test]
fn on_the_clocks_change_weekend_only_the_service_time_is_taken_and_no_day() {
    let capture = with_times(
        "Pacific/Auckland",
        "2026-09-26",
        json!([
            time(
                "TIMa",
                Some("rehearsal"),
                Some("2026-09-26T07:00:00.000Z"),
                "2026-09-26T08:00:00.000Z"
            ),
            time(
                "TIMb",
                Some("service"),
                Some("2026-09-26T21:00:00.000Z"),
                "2026-09-26T22:15:00.000Z"
            )
        ]),
    );
    assert_eq!(outcome(&capture, b1::TIMES), Outcome::Truncated);
    let (start, _, day) = service(&capture);
    assert_eq!(start, "2026-09-26T21:00:00.000Z");
    assert!(day.is_none());
}

/// No service-typed time: today's rule over every time, and `truncated`. An unknown type is not a service and marks
/// the read `truncated`.
#[test]
fn no_service_typed_time_or_an_unknown_type_is_truncated() {
    let capture = with_times(
        "America/Chicago",
        "2026-11-22",
        json!([time(
            "TIMa",
            Some("rehearsal"),
            Some("2026-11-22T14:00:00.000Z"),
            "2026-11-22T15:00:00.000Z"
        )]),
    );
    assert_eq!(outcome(&capture, b1::TIMES), Outcome::Truncated);
    assert_eq!(service(&capture).0, "2026-11-22T14:00:00.000Z");
    let capture = with_times(
        "America/Chicago",
        "2026-11-22",
        json!([
            time(
                "TIMa",
                Some("soundcheck"),
                Some("2026-11-22T14:00:00.000Z"),
                "2026-11-22T15:00:00.000Z"
            ),
            time(
                "TIMb",
                Some("service"),
                Some("2026-11-22T16:00:00.000Z"),
                "2026-11-22T17:15:00.000Z"
            )
        ]),
    );
    assert_eq!(outcome(&capture, b1::TIMES), Outcome::Truncated);
    assert_eq!(service(&capture).0, "2026-11-22T16:00:00.000Z");
}

/// Item 2: A time with no start (the server tolerates one) is left out and the read says so; the others are kept.
#[test]
fn a_time_with_no_start_is_left_out_not_the_whole_read() {
    let capture = with_times(
        "America/Chicago",
        "2026-11-22",
        json!([
            time("TIMa", Some("service"), None, "2026-11-22T15:00:00.000Z"),
            time(
                "TIMb",
                Some("service"),
                Some("2026-11-22T15:00:00.000Z"),
                "2026-11-22T16:30:00.000Z"
            )
        ]),
    );
    assert_eq!(outcome(&capture, b1::TIMES), Outcome::Truncated);
    assert_eq!(service(&capture).0, "2026-11-22T15:00:00.000Z");
}

/// Item 3: Another plan not yet shared with its volunteers (`prepared` true: B1 keeps it from members until it is
/// published) makes nobody busy; if whether it is shared can't be read, `busy` is `truncated`.
#[test]
fn a_plan_not_yet_shared_makes_nobody_busy() {
    let (clock, fake) = {
        let clock = FakeClock::at(NOW);
        (clock.clone(), fake_b1(clock))
    };
    let capture = check(&fake, &clock);
    assert_eq!(outcome(&capture, b1::PLANS_DAY), Outcome::Ok);
    assert_eq!(capture.busy().unwrap().len(), 1);
    let asked = fake
        .calls()
        .iter()
        .find(|c| c.url.contains("/doing/plans/ids"))
        .unwrap()
        .url
        .clone();
    assert!(asked.ends_with("/doing/plans/ids?ids=PLAlate"), "{asked}");
    fake.set(
        "/doing/plans/ids",
        ok(json!([{"id": "PLAlate", "serviceDate": "2026-11-22T00:00:00.000Z", "prepared": true}])),
    );
    let capture = check(&fake, &clock);
    assert_eq!(outcome(&capture, b1::PLANS_DAY), Outcome::Ok);
    assert!(capture.busy().unwrap().is_empty());
    fake.set("/doing/plans/ids", crate::test_support::raw(500, ""));
    let capture = check(&fake, &clock);
    assert_eq!(outcome(&capture, b1::PLANS_DAY), Outcome::Truncated);
}

/// Item 4: With a read-only key, B1 lists only the forms the key's maker has a permission on, and nothing in the answer
/// says whether that is all of them: `b1.forms` is never `ok`.
#[test]
fn the_forms_list_is_never_known_to_be_whole() {
    let clock = FakeClock::at(NOW);
    let fake = fake_b1(clock.clone());
    assert_eq!(
        outcome(&check(&fake, &clock), b1::FORMS),
        Outcome::Truncated
    );
    fake.set("/membership/forms", ok(json!([])));
    assert_eq!(
        outcome(&check(&fake, &clock), b1::FORMS),
        Outcome::Truncated
    );
}

/// Item 5: The plan picker reads plans by date (the overview, from yesterday for `PICKER_DAYS`), never every plan with its
/// notes, and says for each whether it has been shared with its volunteers.
#[test]
fn the_picker_reads_plans_by_date_and_says_which_are_shared() {
    let clock = FakeClock::at(NOW);
    let fake = fake_b1(clock.clone());
    fake.set(
        "/doing/plans/overview",
        ok(json!([
            {"serviceDate": "2026-11-29T00:00:00.000Z", "planId": "PLAfict02", "planName": "Advent One", "positionId": "P1"},
            {"serviceDate": "2026-11-22T00:00:00.000Z", "planId": "PLAfict01", "planName": "Sunday Gathering", "positionId": "P2"},
            {"serviceDate": "2026-11-22T00:00:00.000Z", "planId": "PLAfict01", "planName": "Sunday Gathering", "positionId": "P3"}
        ])),
    );
    fake.set(
        "/doing/plans/ids?ids=PLAfict01%2CPLAfict02",
        ok(json!([{"id": "PLAfict01", "serviceDate": "2026-11-22T00:00:00.000Z", "prepared": false},
                  {"id": "PLAfict02", "serviceDate": "2026-11-29T00:00:00.000Z", "prepared": true}])),
    );
    let choices = b1::plans(&fake, &*clock, &key(), &id("CHUfict01")).unwrap();
    let listed: Vec<(&str, String, Option<bool>)> = choices
        .iter()
        .map(|c| (c.id.as_str(), c.service_date.to_string(), c.shared))
        .collect();
    assert_eq!(
        listed,
        vec![
            ("PLAfict01", "2026-11-22".into(), Some(true)),
            ("PLAfict02", "2026-11-29".into(), Some(false))
        ]
    );
    let paths = fake.paths();
    assert!(!paths.iter().any(|p| p == "/doing/plans"), "{paths:?}");
    let overview = fake
        .calls()
        .iter()
        .find(|c| c.url.contains("overview"))
        .unwrap()
        .url
        .clone();
    assert!(
        overview.contains("startDate=2026-11-16") && overview.contains("endDate=2027-01-11"),
        "{overview}"
    );
    // Whether they are shared can't be read: the plans are still offered, with nothing said either way.
    fake.set(
        "/doing/plans/ids?ids=PLAfict01%2CPLAfict02",
        crate::test_support::raw(500, ""),
    );
    let choices = b1::plans(&fake, &*clock, &key(), &id("CHUfict01")).unwrap();
    assert!(choices.iter().all(|c| c.shared.is_none()));
}

/// Item 6: Every word B1 routes beside an id slot this crate fills is refused as an id.
#[test]
fn the_church_routes_write_words_are_route_words_too() {
    for word in [
        "deleteAbandoned",
        "byIds",
        "add",
        "select",
        "all",
        "search",
        "lookup",
    ] {
        assert!(!b1::path_word_ok(word), "{word}");
        assert!(!b1::path_word_ok(&word.to_uppercase()), "{word}");
    }
}

/// Item 7: A team's size is its roster when the roster was read (B1's `memberCount` also counts people since removed);
/// otherwise the list's count.
#[test]
fn a_teams_size_is_its_roster_when_read() {
    let clock = FakeClock::at(NOW);
    let fake = fake_b1(clock.clone());
    fake.set(
        "/membership/groups",
        ok(json!([
            {"id": "GRPworship", "name": "Worship Team", "memberCount": 7},
            {"id": "GRPwelcome", "name": "Welcome Team", "memberCount": 2},
            {"id": "GRPyouth", "name": "Youth Night", "memberCount": 9}
        ])),
    );
    let capture = check(&fake, &clock);
    let sizes: Vec<(&str, Option<u32>)> = capture
        .groups()
        .iter()
        .map(|g| (g.id.as_str(), g.members))
        .collect();
    assert_eq!(
        sizes,
        vec![
            ("GRPworship", Some(3)),
            ("GRPwelcome", Some(2)),
            ("GRPyouth", Some(9))
        ]
    );
}

/// The contract's `asked`: B1's `notified` (set when B1 notifies the person: B1Admin's notify, autofill, the
/// confirmation workflow). A time is `true`; null or empty is `false` (B1Admin itself counts `!notified` as not
/// notified); a missing field or anything else is `null`. Breeze doesn't say: always `null`.
#[test]
fn asked_is_b1s_notified() {
    let clock = FakeClock::at(NOW);
    let fake = fake_b1(clock.clone());
    fake.set(
        "/doing/assignments/plan/PLAfict01",
        ok(json!([
            {"id": "A1", "positionId": "POSvocal", "personId": "PERavery", "status": "Accepted",
             "notified": "2026-11-10T12:00:00.000Z"},
            {"id": "A2", "positionId": "POSvocal", "personId": "PERblake", "status": "Unconfirmed", "notified": null},
            {"id": "A3", "positionId": "POSsound", "personId": "PERdrew", "status": "Unconfirmed", "notified": ""},
            {"id": "A4", "positionId": "POSgreet", "personId": "PERcasey", "status": "Declined"},
            {"id": "A5", "positionId": "POSgreet", "personId": "PERellis", "status": "Unconfirmed", "notified": 5}
        ])),
    );
    let capture = check(&fake, &clock);
    let asked: Vec<(&str, Option<bool>)> = capture
        .assignments()
        .iter()
        .map(|a| (a.id.as_str(), a.asked))
        .collect();
    assert_eq!(
        asked,
        vec![
            ("A1", Some(true)),
            ("A2", Some(false)),
            ("A3", Some(false)),
            ("A4", None),
            ("A5", None)
        ]
    );
    let text = capture.to_json().unwrap();
    assert!(text.contains(r#""asked":true"#) && text.contains(r#""asked":null"#));
    let clock = FakeClock::at(NOW);
    let fake = breeze::tests::fixture(clock.clone());
    let capture = breeze::check(
        &fake,
        &*clock,
        &FakeZones::standard(),
        &crate::test_support::breeze_key(),
        &id("cedarhollow"),
        &id("4401"),
        None,
    )
    .unwrap();
    assert!(capture.assignments().iter().all(|a| a.asked.is_none()));
}

/// Review E, L3: in `busy` too, another plan's time with no start (B1's server tolerates one) is left out and the read
/// says so; the rest are kept.
#[test]
fn another_plans_time_with_no_start_is_left_out_of_busy() {
    let clock = FakeClock::at(NOW);
    let fake = fake_b1(clock.clone());
    fake.set(
        "/doing/times/plans",
        ok(json!([
            {"id": "TIMx", "planId": "PLAlate", "startTime": null, "endTime": "2026-11-22T18:15:00.000Z"},
            {"id": "TIMlate", "planId": "PLAlate", "startTime": "2026-11-22T17:00:00.000Z",
             "endTime": "2026-11-22T18:15:00.000Z"}
        ])),
    );
    let capture = check(&fake, &clock);
    assert_eq!(outcome(&capture, b1::PLANS_DAY), Outcome::Truncated);
    assert_eq!(capture.busy().unwrap().len(), 1);
}

/// Review E, L8: the service says whether B1 has shared the plan with its volunteers, from the checked plan's own
/// `prepared` (the picker's mapping): false or none is shared, true is not yet; anything else can't be read (null).
/// Breeze doesn't say: null.
#[test]
fn the_service_says_whether_the_plan_is_shared() {
    for (prepared, shared) in [
        (json!(false), Some(true)),
        (Value::Null, Some(true)),
        (json!(true), Some(false)),
        (json!(1), None),
    ] {
        let clock = FakeClock::at(NOW);
        let fake = fake_b1(clock.clone());
        fake.set(
            "/doing/plans/PLAfict01",
            ok(json!({"id": "PLAfict01", "name": "Sunday Gathering", "serviceDate": "2026-11-22T00:00:00.000Z",
                      "prepared": prepared})),
        );
        let capture = check(&fake, &clock);
        assert_eq!(capture.service().unwrap().shared, shared, "{prepared}");
        assert_eq!(outcome(&capture, b1::PLANS), Outcome::Ok, "{prepared}");
    }
    let clock = FakeClock::at(NOW);
    let fake = breeze::tests::fixture(clock.clone());
    let capture = breeze::check(
        &fake,
        &*clock,
        &FakeZones::standard(),
        &crate::test_support::breeze_key(),
        &id("cedarhollow"),
        &id("4401"),
        None,
    )
    .unwrap();
    assert_eq!(capture.service().unwrap().shared, None);
}

/// Review E re-check, N4: an answer with no `prepared` field at all can't say whether the plan is shared: null, in the
/// check, the picker and `busy` (which keeps that plan and says it couldn't tell). An explicit false or null is shared
/// (B1's server casts the `bit(1)` column to a boolean, a null one to false).
#[test]
fn no_prepared_field_means_it_cant_be_told() {
    let clock = FakeClock::at(NOW);
    let fake = fake_b1(clock.clone());
    fake.set(
        "/doing/plans/PLAfict01",
        ok(json!({"id": "PLAfict01", "name": "Sunday Gathering", "serviceDate": "2026-11-22T00:00:00.000Z"})),
    );
    fake.set(
        "/doing/plans/ids",
        ok(json!([{"id": "PLAlate", "serviceDate": "2026-11-22T00:00:00.000Z"}])),
    );
    let capture = check(&fake, &clock);
    assert_eq!(capture.service().unwrap().shared, None);
    assert_eq!(capture.busy().unwrap().len(), 1);
    assert_eq!(outcome(&capture, b1::PLANS_DAY), Outcome::Truncated);
    fake.set(
        "/doing/plans/ids",
        ok(
            json!([{"id": "PLAfict01", "serviceDate": "2026-11-22T00:00:00.000Z", "prepared": null},
                  {"id": "PLAlate", "serviceDate": "2026-11-22T00:00:00.000Z"}]),
        ),
    );
    let choices = b1::plans(&fake, &*clock, &key(), &id("CHUfict01")).unwrap();
    let shared: Vec<(&str, Option<bool>)> =
        choices.iter().map(|c| (c.id.as_str(), c.shared)).collect();
    assert_eq!(shared, vec![("PLAfict01", Some(true)), ("PLAlate", None)]);
}
