//! Reproductions of the re-check's (review C) findings, written before their fixes.
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
        .unwrap()
        .outcome
}
fn b1_with(church: serde_json::Value, times: Option<serde_json::Value>) -> SystemCapture {
    let clock = FakeClock::at(NOW);
    let fake = fake_b1(clock.clone());
    fake.set("/membership/churches/CHUfict01", ok(church));
    if let Some(times) = times {
        fake.set("/doing/times/plan/PLAfict01", ok(times));
    }
    // The no-zone rules (a zone this Mac doesn't know); zoned_tests.rs has the zoned cases.
    b1::check(
        &fake,
        &*clock,
        &crate::zones::NoZones,
        &key(),
        &id("CHUfict01"),
        &id("PLAfict01"),
        None,
    )
    .unwrap()
}

/// M2: B1's saved day can be a day early at UTC+12 or more, or for a church whose zone isn't known: no day is sent.
#[test]
fn c_m2_no_service_day_where_b1s_day_may_be_early() {
    let auckland = b1_with(
        json!({"id": "CHUfict01", "name": "Kauri Hill", "timeZone": "Pacific/Auckland"}),
        None,
    );
    assert!(auckland.service().unwrap().day.is_none());
    let unknown = b1_with(
        json!({"id": "CHUfict01", "name": "Cedar Hollow", "timeZone": null}),
        None,
    );
    assert!(unknown.service().unwrap().day.is_none());
    // Third re-check, N10: a zone this Mac doesn't know (here, no zone data at all) is never the capture's zone, and
    // the check runs as with no zone, so no day either. With the zone data, Chicago's day is 11-22 (zoned_tests.rs).
    let chicago = b1_with(
        json!({"id": "CHUfict01", "name": "Cedar Hollow", "timeZone": "America/Chicago"}),
        None,
    );
    assert!(chicago.church().time_zone.is_none());
    assert!(chicago.service().unwrap().day.is_none());
}

/// L1 (the Sydney case): a plan time left out of the service near it makes the times read `truncated`. Sydney, plan
/// day 11-22: Saturday 18:00 AEDT (07:00Z) and Sunday 9:00 (Saturday 22:00Z).
#[test]
fn c_l1_a_nearby_time_left_out_of_the_service_is_truncated() {
    let capture = b1_with(
        json!({"id": "CHUfict01", "name": "Wattle Rise", "timeZone": "Australia/Sydney"}),
        Some(json!([
            {"id": "TIMsat", "startTime": "2026-11-21T07:00:00.000Z", "endTime": "2026-11-21T08:00:00.000Z"},
            {"id": "TIMsun", "startTime": "2026-11-21T22:00:00.000Z", "endTime": "2026-11-21T23:30:00.000Z"}
        ])),
    );
    assert_eq!(outcome(&capture, b1::TIMES), Outcome::Truncated);
}

/// Seam: a church with no forms has nothing to count, so the count read is `ok`, not `not-requested`.
#[test]
fn seam_no_forms_means_counts_read_ok() {
    let clock = FakeClock::at(NOW);
    let fake = FakeB1::empty(clock.clone());
    let p = "/functions/v1/public-api/v1";
    fake.set(
        &format!("{p}/me"),
        ok(json!({"church": {"id": "CHUgen01"}})),
    );
    fake.set(
        &format!("{p}/groups"),
        ok(json!({"data": [{"id": "grp-1"}], "limit": 200})),
    );
    fake.set(
        &format!("{p}/events"),
        ok(json!({"data": [], "limit": 200})),
    );
    fake.set(&format!("{p}/forms"), ok(json!({"data": [], "limit": 200})));
    let capture = genesis::check(
        &fake,
        &*clock,
        &crate::test_support::FakeZones::standard(),
        &crate::test_support::genesis_key(),
        &id("CHUgen01"),
        None,
    )
    .unwrap();
    assert_eq!(outcome(&capture, genesis::FORM_SUBMISSIONS), Outcome::Ok);
}

/// Seam: a B1 plan whose roles have no team has no team members to read: `ok` and empty.
#[test]
fn seam_no_teams_means_group_members_read_ok() {
    let clock = FakeClock::at(NOW);
    let fake = fake_b1(clock.clone());
    fake.set(
        "/doing/positions/plan/PLAfict01",
        ok(json!([{"id": "POSvocal", "name": "Vocals", "count": 1, "groupId": null}])),
    );
    fake.set(
        "/doing/assignments/plan/PLAfict01",
        ok(json!([{"id": "ASGone", "positionId": "POSvocal", "personId": "PERavery", "status": "Accepted"}])),
    );
    let capture = b1::check(
        &fake,
        &*clock,
        &crate::test_support::FakeZones::standard(),
        &key(),
        &id("CHUfict01"),
        &id("PLAfict01"),
        None,
    )
    .unwrap();
    assert_eq!(outcome(&capture, b1::GROUP_MEMBERS), Outcome::Ok);
    let _: &Arc<FakeClock> = &clock;
}

/// M3: each busy entry carries the other assignment's answer; anything but Accepted or Unconfirmed isn't busy.
#[test]
fn c_m3_busy_carries_its_answer() {
    use crate::capture::BusyAnswer;
    let clock = FakeClock::at(NOW);
    let fake = fake_b1(clock.clone());
    fake.set(
        "/doing/plans/overview",
        ok(json!([
            {"serviceDate": "2026-11-22T00:00:00.000Z", "planId": "PLAlate", "personId": "PERdrew", "status": "Unconfirmed"},
            {"serviceDate": "2026-11-22T00:00:00.000Z", "planId": "PLAlate", "personId": "PERellis", "status": "Accepted"},
            {"serviceDate": "2026-11-22T00:00:00.000Z", "planId": "PLAlate", "personId": "PERblake", "status": "Tentative"},
            {"serviceDate": "2026-11-22T00:00:00.000Z", "planId": "PLAlate", "personId": "PERcasey", "status": "Declined"}
        ])),
    );
    let capture = b1::check(
        &fake,
        &*clock,
        &crate::test_support::FakeZones::standard(),
        &key(),
        &id("CHUfict01"),
        &id("PLAfict01"),
        None,
    )
    .unwrap();
    let busy: Vec<(&str, BusyAnswer)> = capture
        .busy()
        .unwrap()
        .iter()
        .map(|b| (b.person_id.as_str(), b.answer))
        .collect();
    assert_eq!(
        busy,
        vec![
            ("PERdrew", BusyAnswer::Unconfirmed),
            ("PERellis", BusyAnswer::Accepted)
        ]
    );
    let text = capture.to_json().unwrap();
    assert!(text.contains(r#""answer":"unconfirmed""#) && text.contains(r#""answer":"accepted""#));
}

/// L5 (review A): names and labels are kept in NFC, so one name written two ways is one name.
#[test]
fn names_are_kept_in_nfc() {
    use crate::capture::{Label, Name};
    assert_eq!(
        Name::new("Jose\u{301} Quillfeather"),
        Name::new("Jos\u{e9} Quillfeather")
    );
    assert_eq!(Label::new("Cafe\u{301}"), Label::new("Caf\u{e9}"));
    // A name that isn't in NFC isn't as a capture keeps it.
    assert!(serde_json::from_str::<Name>("\"Jose\u{301}\"").is_err());
}

/// Breeze's answers are mapped since a live read confirmed the codes: a Breeze capture with an answer is taken. (A
/// system whose answers are off, `Supplies::answers` false, has them refused as `not-supplied`.)
#[test]
fn a_breeze_answer_is_supplied_now_its_codes_are_confirmed() {
    let capture = json!({
        "version": 1, "system": "breeze", "church": {"id": "cedarhollow", "time_zone": null},
        "started_at": "2026-11-17T15:00:00Z", "completed_at": "2026-11-17T15:00:05Z", "reads": [],
        "service": null, "busy": null, "positions": [{"id": "9627", "team_id": null, "needed": 1}],
        "assignments": [{"id": "501-9627", "position_id": "9627", "person_id": "157857", "status": "accepted", "asked": null}],
        "on_service": [], "team_members": [], "blockouts": null, "groups": [], "events": [], "forms": [], "names": {}, "labels": {}
    });
    assert!(SystemCapture::from_json(capture.to_string().as_bytes()).is_ok());
}
