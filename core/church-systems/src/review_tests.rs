//! Reproductions of the read-path review's findings, written before their fixes: each failed on the code it was
//! written against, and now holds the fix in place.
use crate::capture::{Outcome, ReadWord, SystemCapture};
use crate::test_support::{FakeB1, FakeClock, NOW, fake_b1, id, key, ok};
use crate::{b1, genesis};
use serde_json::json;
use std::sync::Arc;

fn outcome(capture: &SystemCapture, word: ReadWord) -> Outcome {
    capture
        .reads()
        .iter()
        .find(|r| r.read == word)
        .unwrap_or_else(|| panic!("{word:?} recorded"))
        .outcome
}
fn b1_at(unix_millis: i64) -> (FakeB1, Arc<FakeClock>) {
    let clock = FakeClock::at(unix_millis);
    (fake_b1(clock.clone()), clock)
}
fn b1_check(fake: &FakeB1, clock: &FakeClock) -> SystemCapture {
    b1::check(
        fake,
        clock,
        &crate::test_support::FakeZones::standard(),
        &key(),
        &id("CHUfict01"),
        &id("PLAfict01"),
        None,
    )
    .unwrap()
}
fn ms(text: &str) -> i64 {
    crate::capture::Time::parse(text).unwrap().unix_millis()
}

/// H1: from 00:00 UTC of the service day B1 stops listing a blockout that ends that day, so the read is cut short.
/// Chicago: that moment is Saturday 18:00 CST.
#[test]
fn h1_blockouts_read_on_or_after_the_service_days_utc_midnight_are_truncated() {
    let (fake, clock) = b1_at(ms("2026-11-22T00:00:00Z"));
    assert_eq!(
        outcome(&b1_check(&fake, &clock), b1::BLOCKOUTS),
        Outcome::Truncated
    );
    let (fake, clock) = b1_at(ms("2026-11-22T01:00:00Z"));
    assert_eq!(
        outcome(&b1_check(&fake, &clock), b1::BLOCKOUTS),
        Outcome::Truncated
    );
    // A minute before (Saturday 17:59 CST), the list is still whole.
    let (fake, clock) = b1_at(ms("2026-11-21T23:59:00Z"));
    assert_eq!(
        outcome(&b1_check(&fake, &clock), b1::BLOCKOUTS),
        Outcome::Ok
    );
}

/// These reproductions are of the no-zone rules (a church whose zone this Mac doesn't know), so they run without zones;
/// zoned_tests.rs has the same cases with the church's zone.
fn b1_no_zone(fake: &FakeB1, clock: &FakeClock) -> SystemCapture {
    b1::check(
        fake,
        clock,
        &crate::zones::NoZones,
        &key(),
        &id("CHUfict01"),
        &id("PLAfict01"),
        None,
    )
    .unwrap()
}
fn b1_times(times: serde_json::Value) -> SystemCapture {
    let (fake, clock) = b1_at(NOW);
    fake.set("/doing/times/plan/PLAfict01", ok(times));
    b1_no_zone(&fake, &clock)
}

/// M1: a Chicago Saturday 10:00 rehearsal (16:00Z) and the Sunday 9:00 service (15:00Z next day) are not one block, so
/// the service's times can't be told from the rehearsal without the church's zone.
#[test]
fn m1_a_chicago_saturday_rehearsal_is_not_silently_part_of_the_service() {
    let capture = b1_times(json!([
        {"id": "TIMreh", "startTime": "2026-11-21T16:00:00.000Z", "endTime": "2026-11-21T17:00:00.000Z"},
        {"id": "TIMsun", "startTime": "2026-11-22T15:00:00.000Z", "endTime": "2026-11-22T16:30:00.000Z"}
    ]));
    assert_eq!(outcome(&capture, b1::TIMES), Outcome::Truncated);
    let service = capture.service().unwrap();
    assert!(service.ends_at.is_none());
}
/// M1: Sydney (AEDT, UTC+11), 9:00 and 11:00 Sunday are Saturday 22:00Z and Sunday 00:00Z: one block, the service.
#[test]
fn m1_a_sydney_sunday_morning_is_one_block() {
    let capture = b1_times(json!([
        {"id": "TIM9", "startTime": "2026-11-21T22:00:00.000Z", "endTime": "2026-11-21T23:15:00.000Z"},
        {"id": "TIM11", "startTime": "2026-11-22T00:00:00.000Z", "endTime": "2026-11-22T01:15:00.000Z"}
    ]));
    assert_eq!(outcome(&capture, b1::TIMES), Outcome::Ok);
    let service = capture.service().unwrap();
    assert_eq!(service.starts_at.as_str(), "2026-11-21T22:00:00.000Z");
    assert_eq!(
        service.ends_at.as_ref().unwrap().as_str(),
        "2026-11-22T01:15:00.000Z"
    );
}
/// M1: two services the same Chicago morning, 9:00 and 11:00, are one block.
#[test]
fn m1_two_services_the_same_morning_are_one_block() {
    let capture = b1_times(json!([
        {"id": "TIM9", "startTime": "2026-11-22T15:00:00.000Z", "endTime": "2026-11-22T16:15:00.000Z"},
        {"id": "TIM11", "startTime": "2026-11-22T17:00:00.000Z", "endTime": "2026-11-22T18:15:00.000Z"}
    ]));
    assert_eq!(outcome(&capture, b1::TIMES), Outcome::Ok);
    let service = capture.service().unwrap();
    assert_eq!(service.starts_at.as_str(), "2026-11-22T15:00:00.000Z");
    assert_eq!(
        service.ends_at.as_ref().unwrap().as_str(),
        "2026-11-22T18:15:00.000Z"
    );
}

fn genesis_fake() -> (FakeB1, Arc<FakeClock>) {
    let clock = FakeClock::at(NOW);
    let fake = FakeB1::empty(clock.clone());
    let p = "/functions/v1/public-api/v1";
    fake.set(
        &format!("{p}/me"),
        ok(json!({"church": {"id": "CHUgen01", "name": "Cedar Hollow"}})),
    );
    fake.set(
        &format!("{p}/groups"),
        ok(json!({"data": [{"id": "grp-1"}], "limit": 200, "offset": 0})),
    );
    fake.set(
        &format!("{p}/events"),
        ok(json!({"data": [], "limit": 200, "offset": 0})),
    );
    fake.set(
        &format!("{p}/forms"),
        ok(json!({"data": [], "limit": 200, "offset": 0})),
    );
    (fake, clock)
}

/// L2: when `/me` doesn't prove the key belongs to this church, nothing else is read under the church.
#[test]
fn l2_genesis_reads_nothing_more_when_me_fails() {
    let (fake, clock) = genesis_fake();
    fake.set(
        "/functions/v1/public-api/v1/me",
        crate::test_support::Answer::Fail(crate::http::ReadError::Timeout),
    );
    let capture = genesis::check(
        &fake,
        &*clock,
        &crate::test_support::FakeZones::standard(),
        &crate::test_support::genesis_key(),
        &id("CHUgen01"),
        None,
    )
    .unwrap();
    assert_eq!(outcome(&capture, genesis::ME), Outcome::Timeout);
    for read in &capture.reads()[1..] {
        assert_eq!(read.outcome, Outcome::NotRequested, "{:?}", read.read);
    }
    assert!(capture.groups().is_empty());
}

/// L3: a Genesis page the server cut to its own limit (echoed back) is not the whole list.
#[test]
fn l3_genesis_a_page_cut_to_the_echoed_limit_is_truncated() {
    let (fake, clock) = genesis_fake();
    let fifty: Vec<_> = (0..50).map(|n| json!({"id": format!("grp-{n}")})).collect();
    fake.set(
        "/functions/v1/public-api/v1/groups",
        ok(json!({"data": fifty, "limit": 50, "offset": 0})),
    );
    let capture = genesis::check(
        &fake,
        &*clock,
        &crate::test_support::FakeZones::standard(),
        &crate::test_support::genesis_key(),
        &id("CHUgen01"),
        None,
    )
    .unwrap();
    assert_eq!(outcome(&capture, genesis::GROUPS), Outcome::Truncated);
    // So is one whose echoed total is more than it holds.
    let (fake, clock) = genesis_fake();
    fake.set(
        "/functions/v1/public-api/v1/groups",
        ok(json!({"data": [{"id": "grp-1"}], "limit": 200, "offset": 0, "total": 7})),
    );
    let capture = genesis::check(
        &fake,
        &*clock,
        &crate::test_support::FakeZones::standard(),
        &crate::test_support::genesis_key(),
        &id("CHUgen01"),
        None,
    )
    .unwrap();
    assert_eq!(outcome(&capture, genesis::GROUPS), Outcome::Truncated);
}

/// L4: someone asked about whom B1 doesn't name: the people read is partial.
#[test]
fn l4_b1_a_name_not_returned_makes_people_truncated() {
    let (mut fake, clock) = b1_at(NOW);
    fake.people.remove("PERblake");
    let capture = b1_check(&fake, &clock);
    assert_eq!(outcome(&capture, b1::PEOPLE), Outcome::Truncated);
}

/// L1: zone names from no IANA area, or `Etc/GMT` offsets that don't exist, are left out rather than sent to a page
/// whose Intl would refuse the whole capture.
#[test]
fn l1_zone_names_outside_the_iana_areas_are_left_out() {
    use crate::capture::ZoneName;
    for good in [
        "America/Chicago",
        "Pacific/Auckland",
        "Etc/GMT+5",
        "Etc/GMT-14",
        "Etc/UTC",
        "US/Pacific",
        "UTC",
    ] {
        assert!(ZoneName::new(good).is_some(), "{good}");
    }
    for bad in [
        "Foo/Bar",
        "Etc/GMT+15",
        "Etc/GMT-15",
        "Etc/GMT+05",
        "Etc/Nowhere",
        "Mars/Olympus",
    ] {
        assert!(ZoneName::new(bad).is_none(), "{bad}");
    }
    let (fake, clock) = b1_at(NOW);
    fake.set(
        "/membership/churches/CHUfict01",
        ok(json!({"id": "CHUfict01", "name": "Cedar Hollow", "timeZone": "Foo/Bar"})),
    );
    let capture = b1_check(&fake, &clock);
    assert!(capture.church().time_zone.is_none());
    assert_eq!(outcome(&capture, b1::CHURCH), Outcome::Truncated);
}

/// L5: characters that show as nothing or a blank box are dropped from names and labels.
#[test]
fn l5_blank_looking_characters_are_dropped() {
    use crate::capture::{Label, Name};
    for blank in [
        '\u{3164}',
        '\u{ffa0}',
        '\u{2800}',
        '\u{34f}',
        '\u{fe0f}',
        '\u{1d173}',
        '\u{fffc}',
        '\u{e000}',
        '\u{fffe}',
        '\u{10fffd}',
        '\u{fdd0}',
        '\u{115f}',
    ] {
        assert!(
            Name::new(&blank.to_string()).is_none(),
            "{:x}",
            blank as u32
        );
        assert_eq!(Label::new(&format!("A{blank}B")).unwrap().as_str(), "AB");
    }
    // Letters, accents and ordinary emoji stay.
    assert_eq!(Name::new("José Ñúñez").unwrap().as_str(), "José Ñúñez");
}

/// L8: a Breeze church can't be one of Breeze's own subdomains or a punycode look-alike; the key is never sent.
#[test]
fn l8_breeze_reserved_and_punycode_subdomains_are_refused() {
    for label in [
        "www",
        "api",
        "status",
        "support",
        "help",
        "xn--cdrhollow-x9a",
    ] {
        assert!(crate::breeze::church_host(&id(label)).is_none(), "{label}");
    }
    assert!(crate::breeze::church_host(&id("cedarhollow")).is_some());
}

/// L10: a church at UTC+12 or more has its plan's day saved as the day before, so the times and blockouts can't be
/// placed and their reads say so.
#[test]
fn l10_a_far_east_church_has_times_and_blockouts_truncated() {
    let (fake, clock) = b1_at(NOW);
    fake.set(
        "/membership/churches/CHUfict01",
        ok(json!({"id": "CHUfict01", "name": "Kauri Hill", "timeZone": "Pacific/Auckland"})),
    );
    let capture = b1_no_zone(&fake, &clock);
    assert_eq!(outcome(&capture, b1::TIMES), Outcome::Truncated);
    assert_eq!(outcome(&capture, b1::BLOCKOUTS), Outcome::Truncated);
}

/// M1: when the service's times are not one block, the blockouts placed against it are not `ok` either.
#[test]
fn m1_an_unclear_service_leaves_blockouts_truncated() {
    let capture = b1_times(json!([
        {"id": "TIMreh", "startTime": "2026-11-21T16:00:00.000Z", "endTime": "2026-11-21T17:00:00.000Z"},
        {"id": "TIMsun", "startTime": "2026-11-22T15:00:00.000Z", "endTime": "2026-11-22T16:30:00.000Z"}
    ]));
    assert_eq!(outcome(&capture, b1::BLOCKOUTS), Outcome::Truncated);
    // Run with no zone data (N10: an unknown zone is no zone), so no day is named.
    assert!(capture.service().unwrap().day.is_none());
}

/// `busy`: another plan whose times can't all be placed is `truncated`; a failed overview leaves `busy` null.
#[test]
fn busy_is_partial_or_null_when_it_cant_be_placed() {
    let (fake, clock) = b1_at(NOW);
    fake.set(
        "/doing/times/plans",
        ok(json!([{"id": "TIMlate", "planId": "PLAlate", "startTime": "2026-11-22T17:00:00.000Z", "endTime": null}])),
    );
    let capture = b1_check(&fake, &clock);
    assert_eq!(outcome(&capture, b1::PLANS_DAY), Outcome::Truncated);
    assert!(capture.busy().unwrap().is_empty());
    let (fake, clock) = b1_at(NOW);
    fake.set("/doing/times/plans", ok(json!([])));
    assert_eq!(
        outcome(&b1_check(&fake, &clock), b1::PLANS_DAY),
        Outcome::Truncated
    );
    let (fake, clock) = b1_at(NOW);
    fake.set(
        "/doing/plans/overview",
        ok(json!({"error": "Missing required parameters: startDate, endDate"})),
    );
    let capture = b1_check(&fake, &clock);
    assert_eq!(outcome(&capture, b1::PLANS_DAY), Outcome::Refused);
    assert!(capture.busy().is_none());
    // Plan times for a plan not asked about: refused.
    let (fake, clock) = b1_at(NOW);
    fake.set(
        "/doing/times/plans",
        ok(json!([{"id": "TIMx", "planId": "PLAelse", "startTime": "2026-11-22T17:00:00.000Z"}])),
    );
    assert_eq!(
        outcome(&b1_check(&fake, &clock), b1::PLANS_DAY),
        Outcome::InvalidResponse
    );
    // The overview asks for the day before to the day after.
    let (fake, clock) = b1_at(NOW);
    b1_check(&fake, &clock);
    let overview = fake
        .calls()
        .into_iter()
        .find(|c| c.url.contains("overview"))
        .unwrap();
    assert!(
        overview.url.contains("startDate=2026-11-21")
            && overview.url.contains("endDate=2026-11-23")
    );
}

/// L11: a Breeze assignment id two different pairs would share refuses the volunteers read, not the whole capture.
#[test]
fn l11_breeze_colliding_assignment_ids_refuse_the_read_only() {
    let clock = FakeClock::at(NOW);
    let fake = FakeB1::empty(clock.clone());
    let service = json!({"id": "4401", "name": "Sunday", "start_datetime": "2026-11-22T15:00:00Z",
                         "end_datetime": "2026-11-22T16:00:00Z"});
    fake.set(
        "/api/account/summary",
        ok(json!({"id": "1", "name": "Cedar", "subdomain": "cedarhollow"})),
    );
    fake.set("/api/events/list_event", ok(service.clone()));
    fake.set("/api/events", ok(json!([service])));
    fake.set(
        "/api/volunteers/list_roles",
        ok(json!([{"id": "3", "quantity": "1"}, {"id": "2-3", "quantity": "1"}])),
    );
    fake.set(
        "/api/volunteers/list",
        ok(json!([{"id": "1-2", "person_id": "11", "role_ids": ["3"]}, {"id": "1", "person_id": "12", "role_ids": ["2-3"]}])),
    );
    fake.set("/api/tags/list_tags", ok(json!([])));
    fake.set("/api/forms/list_forms", ok(json!([])));
    let capture = crate::breeze::check(
        &fake,
        &*clock,
        &crate::test_support::FakeZones::standard(),
        &crate::test_support::breeze_key(),
        &id("cedarhollow"),
        &id("4401"),
        None,
    )
    .unwrap();
    assert_eq!(
        outcome(&capture, crate::breeze::VOLUNTEERS),
        Outcome::InvalidResponse
    );
    assert!(capture.assignments().is_empty());
}

/// The contract additions: `service.day` and `busy` are required fields; `busy` and team members only from a system
/// that supplies them.
#[test]
fn the_contract_additions_are_required_and_limited_to_their_systems() {
    let (fake, clock) = b1_at(NOW);
    let capture = b1_check(&fake, &clock);
    let mut value: serde_json::Value = serde_json::from_str(&capture.to_json().unwrap()).unwrap();
    assert_eq!(value["service"]["day"], "2026-11-22");
    for (path, field) in [("", "busy"), ("service", "day")] {
        let mut without = value.clone();
        let at = if path.is_empty() {
            &mut without
        } else {
            &mut without[path]
        };
        at.as_object_mut().unwrap().remove(field);
        assert!(
            SystemCapture::from_json(without.to_string().as_bytes()).is_err(),
            "{field}"
        );
    }
    value["service"]["day"] = json!("2026-02-30");
    assert!(SystemCapture::from_json(value.to_string().as_bytes()).is_err());
    let empty = |system: &str| {
        json!({
            "version": 1, "system": system, "church": {"id": "CHUfict01", "time_zone": null},
            "started_at": "2026-11-17T15:00:00Z", "completed_at": "2026-11-17T15:00:05Z", "reads": [],
            "service": null, "busy": null, "positions": [{"id": "P1", "team_id": "T1", "needed": 1}],
            "assignments": [], "on_service": [], "team_members": [], "blockouts": null,
            "groups": [], "events": [], "forms": [], "names": {}, "labels": {}
        })
    };
    let mut breeze = empty("breeze");
    breeze["busy"] = json!([]);
    assert_eq!(
        SystemCapture::from_json(breeze.to_string().as_bytes()).unwrap_err(),
        crate::capture::Invalid::NotSupplied
    );
    let mut breeze = empty("breeze");
    breeze["team_members"] = json!([{"team_id": "T1", "person_id": "PER1"}]);
    assert_eq!(
        SystemCapture::from_json(breeze.to_string().as_bytes()).unwrap_err(),
        crate::capture::Invalid::NotSupplied
    );
    let mut b1 = empty("b1");
    b1["team_members"] = json!([{"team_id": "T1", "person_id": "PER1"}]);
    b1["busy"] = json!([{"person_id": "PER1", "starts_at": "2026-11-22T17:00:00Z", "ends_at": "2026-11-22T17:00:00Z", "answer": "accepted"}]);
    assert_eq!(
        SystemCapture::from_json(b1.to_string().as_bytes()).unwrap_err(),
        crate::capture::Invalid::Times
    );
    b1["busy"] = json!([{"person_id": "PERnobody", "starts_at": "2026-11-22T17:00:00Z", "ends_at": "2026-11-22T18:00:00Z", "answer": "accepted"}]);
    assert_eq!(
        SystemCapture::from_json(b1.to_string().as_bytes()).unwrap_err(),
        crate::capture::Invalid::Reference
    );
}
