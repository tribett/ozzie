//! B1 and Breeze with the church's own time zone (`ZoneOffsets`, here a fixed table with 2026's clock changes), and the
//! no-zone fallbacks they replace only when the zone is known.
use crate::capture::{Outcome, ReadWord, SystemCapture, Time};
use crate::test_support::{FakeB1, FakeClock, FakeZones, NOW, fake_b1, id, key, ok};
use crate::zones::{NoZones, ZoneOffsets};
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
fn church(zone: Value) -> Value {
    json!({"id": "CHUfict01", "name": "Cedar Hollow Fellowship", "timeZone": zone})
}
/// The fictional B1 church with its zone, plan day and times set.
fn b1_capture(zone: Value, day: &str, times: Value, zones: &dyn ZoneOffsets) -> SystemCapture {
    b1_capture_in(zone, None, day, times, zones)
}
/// The same, with a zone the caller supplies (the one the person confirmed in Ozzie).
fn b1_capture_in(
    zone: Value,
    supplied: Option<&str>,
    day: &str,
    times: Value,
    zones: &dyn ZoneOffsets,
) -> SystemCapture {
    let supplied = supplied.map(|z| crate::capture::ZoneName::new(z).unwrap());
    let clock = FakeClock::at(NOW);
    let fake = fake_b1(clock.clone());
    fake.set("/membership/churches/CHUfict01", ok(church(zone)));
    fake.set(
        "/doing/plans/PLAfict01",
        ok(json!({"id": "PLAfict01", "name": "Sunday Gathering", "serviceDate": format!("{day}T00:00:00.000Z")})),
    );
    fake.set("/doing/times/plan/PLAfict01", ok(times));
    b1::check(
        &fake,
        &*clock,
        zones,
        &key(),
        &id("CHUfict01"),
        &id("PLAfict01"),
        supplied.as_ref(),
    )
    .unwrap()
}
fn span(start: &str, end: &str) -> Value {
    json!({"id": format!("TIM{}", &start[11..13]), "startTime": start, "endTime": end})
}
fn ms(t: &str) -> i64 {
    Time::parse(t).unwrap().unix_millis()
}
fn overlaps(a: (&Time, &Time), b: (&Time, Option<&Time>)) -> bool {
    let b_end = b.1.map_or(b.0.unix_millis() + 1000, Time::unix_millis);
    a.0.unix_millis() < b_end && a.1.unix_millis() > b.0.unix_millis()
}

#[test]
fn b1_with_a_zone_takes_the_times_on_the_plans_own_day() {
    let zones = FakeZones::standard();
    // Chicago: a Saturday 10:00 rehearsal (16:00Z) isn't the Sunday 9:00 service (15:00Z).
    let capture = b1_capture(
        json!("America/Chicago"),
        "2026-11-22",
        json!([
            span("2026-11-21T16:00:00.000Z", "2026-11-21T17:00:00.000Z"),
            span("2026-11-22T15:00:00.000Z", "2026-11-22T16:30:00.000Z")
        ]),
        &zones,
    );
    assert_eq!(outcome(&capture, b1::TIMES), Outcome::Ok);
    let service = capture.service().unwrap();
    assert_eq!(service.starts_at.as_str(), "2026-11-22T15:00:00.000Z");
    assert_eq!(
        service.ends_at.as_ref().unwrap().as_str(),
        "2026-11-22T16:30:00.000Z"
    );
    assert_eq!(service.day.unwrap().to_string(), "2026-11-22");
    // Sydney: Saturday 18:00 (07:00Z) is another day; Sunday 9:00 and 11:00 (22:00Z and 00:00Z) are the service.
    let capture = b1_capture(
        json!("Australia/Sydney"),
        "2026-11-22",
        json!([
            span("2026-11-21T07:00:00.000Z", "2026-11-21T08:00:00.000Z"),
            span("2026-11-21T22:00:00.000Z", "2026-11-21T23:15:00.000Z"),
            span("2026-11-22T00:00:00.000Z", "2026-11-22T01:15:00.000Z")
        ]),
        &zones,
    );
    assert_eq!(outcome(&capture, b1::TIMES), Outcome::Ok);
    let service = capture.service().unwrap();
    assert_eq!(service.starts_at.as_str(), "2026-11-21T22:00:00.000Z");
    assert_eq!(
        service.ends_at.as_ref().unwrap().as_str(),
        "2026-11-22T01:15:00.000Z"
    );
    assert_eq!(service.day.unwrap().to_string(), "2026-11-22");
}

#[test]
fn b1_far_ahead_of_utc_gets_its_real_day() {
    // Auckland: B1's admin site saved Sunday's plan as 2026-11-21 (the UTC day of local noon); the service is Sunday
    // 10:00 NZDT, 2026-11-21T21:00Z. Its real local day is given, and nothing is truncated.
    let capture = b1_capture(
        json!("Pacific/Auckland"),
        "2026-11-21",
        json!([span("2026-11-21T21:00:00.000Z", "2026-11-21T22:15:00.000Z")]),
        &FakeZones::standard(),
    );
    assert_eq!(outcome(&capture, b1::TIMES), Outcome::Ok);
    assert_eq!(outcome(&capture, b1::BLOCKOUTS), Outcome::Ok);
    assert_eq!(
        capture.service().unwrap().day.unwrap().to_string(),
        "2026-11-22"
    );
    // The same without the zone data: as before, the day is null and the reads say they can't be sure.
    let capture = b1_capture(
        json!("Pacific/Auckland"),
        "2026-11-21",
        json!([span("2026-11-21T21:00:00.000Z", "2026-11-21T22:15:00.000Z")]),
        &NoZones,
    );
    assert!(capture.service().unwrap().day.is_none());
    assert_eq!(outcome(&capture, b1::TIMES), Outcome::Truncated);
}

#[test]
fn b1_times_on_neither_day_leave_the_day_null_and_the_read_truncated() {
    // Chicago, plan day 11-22, one time at Saturday 06:00 local (11-21T12:00Z): within the window, on neither day.
    let capture = b1_capture(
        json!("America/Chicago"),
        "2026-11-22",
        json!([span("2026-11-21T12:00:00.000Z", "2026-11-21T13:00:00.000Z")]),
        &FakeZones::standard(),
    );
    assert_eq!(outcome(&capture, b1::TIMES), Outcome::Truncated);
    assert!(capture.service().unwrap().day.is_none());
    assert_eq!(outcome(&capture, b1::BLOCKOUTS), Outcome::Truncated);
}

#[test]
fn b1_blockouts_are_real_local_days_in_the_churchs_zone() {
    // Chicago, a 19:00 Sunday service (Monday 01:00Z): Drew's Sunday blockout covers it, Ellis's Monday one doesn't.
    let clock = FakeClock::at(NOW);
    let fake = fake_b1(clock.clone());
    fake.set(
        "/doing/times/plan/PLAfict01",
        ok(json!([span(
            "2026-11-23T01:00:00.000Z",
            "2026-11-23T02:15:00.000Z"
        )])),
    );
    fake.set(
        "/doing/blockoutDates/upcoming",
        ok(json!([
            {"personId": "PERdrew", "startDate": "2026-11-22T00:00:00.000Z", "endDate": "2026-11-22T00:00:00.000Z"},
            {"personId": "PERellis", "startDate": "2026-11-23T00:00:00.000Z", "endDate": "2026-11-23T00:00:00.000Z"}
        ])),
    );
    let zones = FakeZones::standard();
    let capture = b1::check(
        &fake,
        &*clock,
        &zones,
        &key(),
        &id("CHUfict01"),
        &id("PLAfict01"),
        None,
    )
    .unwrap();
    assert_eq!(outcome(&capture, b1::BLOCKOUTS), Outcome::Ok);
    let service = capture.service().unwrap();
    assert_eq!(service.day.unwrap().to_string(), "2026-11-22");
    let blockouts = capture.blockouts().unwrap();
    assert_eq!(blockouts[0].starts_at.as_str(), "2026-11-22T00:00:00-06:00");
    assert_eq!(blockouts[0].ends_at.as_str(), "2026-11-23T00:00:00-06:00");
    assert!(overlaps(
        (&blockouts[0].starts_at, &blockouts[0].ends_at),
        (&service.starts_at, service.ends_at.as_ref())
    ));
    assert!(!overlaps(
        (&blockouts[1].starts_at, &blockouts[1].ends_at),
        (&service.starts_at, service.ends_at.as_ref())
    ));
    // The late rule counts from the service's own day: read at Sunday 00:00Z it is late.
    let late = FakeClock::at(ms("2026-11-22T00:00:00Z"));
    let fake = fake_b1(late.clone());
    let capture = b1::check(
        &fake,
        &*late,
        &zones,
        &key(),
        &id("CHUfict01"),
        &id("PLAfict01"),
        None,
    )
    .unwrap();
    assert_eq!(outcome(&capture, b1::BLOCKOUTS), Outcome::Truncated);
}

/// A zone whose clocks go forward at local midnight on 2026-11-22 (as some South American zones have done).
struct MidnightGap;
impl ZoneOffsets for MidnightGap {
    fn offset_seconds(&self, zone: &crate::capture::ZoneName, at: i64) -> Option<i32> {
        (zone.as_str() == "America/Santiago").then(|| {
            if at < ms("2026-11-22T04:00:00Z") / 1000 {
                -14_400
            } else {
                -10_800
            }
        })
    }
}

#[test]
fn b1_a_blockout_whose_midnight_the_zone_skips_is_left_out_not_guessed() {
    let clock = FakeClock::at(NOW);
    let fake = fake_b1(clock.clone());
    fake.set(
        "/membership/churches/CHUfict01",
        ok(church(json!("America/Santiago"))),
    );
    let capture = b1::check(
        &fake,
        &*clock,
        &MidnightGap,
        &key(),
        &id("CHUfict01"),
        &id("PLAfict01"),
        None,
    )
    .unwrap();
    assert_eq!(outcome(&capture, b1::BLOCKOUTS), Outcome::Truncated);
    // Drew's blockout starts on 11-22, whose midnight never happens there: left out. Ellis's (December) is kept.
    let people: Vec<&str> = capture
        .blockouts()
        .unwrap()
        .iter()
        .map(|b| b.person_id.as_str())
        .collect();
    assert_eq!(people, vec!["PERellis"]);
}

/// The no-zone day rule, pinned for a late service (the coordinator's case): plan day 2026-11-22, one time 7 PM
/// Central Sunday (11-23T01:00Z to 02:15Z), church zone null. A blockout for 11-22 must overlap the service; one for
/// 11-23 must not.
#[test]
fn b1_without_a_zone_a_late_service_still_meets_its_own_days_blockouts_only() {
    let clock = FakeClock::at(NOW);
    let fake = fake_b1(clock.clone());
    fake.set("/membership/churches/CHUfict01", ok(church(Value::Null)));
    fake.set(
        "/doing/times/plan/PLAfict01",
        ok(json!([span(
            "2026-11-23T01:00:00.000Z",
            "2026-11-23T02:15:00.000Z"
        )])),
    );
    fake.set(
        "/doing/blockoutDates/upcoming",
        ok(json!([
            {"personId": "PERdrew", "startDate": "2026-11-22T00:00:00.000Z", "endDate": "2026-11-22T00:00:00.000Z"},
            {"personId": "PERellis", "startDate": "2026-11-23T00:00:00.000Z", "endDate": "2026-11-23T00:00:00.000Z"}
        ])),
    );
    for zones in [&FakeZones::standard() as &dyn ZoneOffsets, &NoZones] {
        let capture = b1::check(
            &fake,
            &*clock,
            zones,
            &key(),
            &id("CHUfict01"),
            &id("PLAfict01"),
            None,
        )
        .unwrap();
        let service = capture.service().unwrap();
        assert!(capture.church().time_zone.is_none());
        assert!(service.day.is_none());
        let blockouts = capture.blockouts().unwrap();
        let drew = blockouts
            .iter()
            .find(|b| b.person_id.as_str() == "PERdrew")
            .unwrap();
        let ellis = blockouts
            .iter()
            .find(|b| b.person_id.as_str() == "PERellis")
            .unwrap();
        assert!(overlaps(
            (&drew.starts_at, &drew.ends_at),
            (&service.starts_at, service.ends_at.as_ref())
        ));
        assert!(!overlaps(
            (&ellis.starts_at, &ellis.ends_at),
            (&service.starts_at, service.ends_at.as_ref())
        ));
    }
}

fn breeze_capture(service: Value, events: Value) -> SystemCapture {
    let clock = FakeClock::at(NOW);
    let fake: FakeB1 = breeze::tests::fixture(clock.clone());
    fake.set("/api/events/list_event", ok(service));
    fake.set("/api/events", ok(events));
    breeze::check(
        &fake,
        &*clock,
        &FakeZones::standard(),
        &crate::test_support::breeze_key(),
        &id("cedarhollow"),
        &id("4401"),
        None,
    )
    .unwrap()
}

#[test]
fn breeze_local_times_become_instants_in_the_accounts_zone() {
    let service = json!({"id": "4401", "name": "Sunday Gathering", "start_datetime": "2026-11-22 09:00:00",
                         "end_datetime": "2026-11-22 10:30:00"});
    let capture = breeze_capture(
        service.clone(),
        json!([service, {"id": "4402", "start_datetime": "2026-07-12 18:00:00", "end_datetime": "0000-00-00 00:00:00"}]),
    );
    assert_eq!(outcome(&capture, breeze::EVENTS), Outcome::Ok);
    assert_eq!(
        capture.church().time_zone.as_ref().unwrap().as_str(),
        "America/Chicago"
    );
    let s = capture.service().unwrap();
    assert_eq!(s.starts_at.as_str(), "2026-11-22T09:00:00-06:00");
    assert_eq!(
        s.ends_at.as_ref().unwrap().as_str(),
        "2026-11-22T10:30:00-06:00"
    );
    assert_eq!(s.day.unwrap().to_string(), "2026-11-22");
    // A summer event gets the summer offset; a zero end date is no end.
    let summer = capture
        .events()
        .iter()
        .find(|e| e.id.as_str() == "4402")
        .unwrap();
    assert_eq!(summer.starts_at.as_str(), "2026-07-12T18:00:00-05:00");
    assert!(summer.ends_at.is_none());
}

#[test]
fn breeze_times_a_clock_change_skips_or_repeats_are_left_out_not_guessed() {
    // The service starts in the hour skipped on 2026-03-08: no service, and the read says so.
    let gap = json!({"id": "4401", "name": "Sunday Gathering", "start_datetime": "2026-03-08 02:30:00",
                     "end_datetime": "2026-03-08 04:00:00"});
    let capture = breeze_capture(gap.clone(), json!([gap]));
    assert_eq!(outcome(&capture, breeze::EVENTS), Outcome::Truncated);
    assert!(capture.service().is_none());
    assert!(capture.events().is_empty());
    // It ends in the hour repeated on 2026-11-01: the service is kept with no end, and the read says so.
    let ambiguous = json!({"id": "4401", "name": "Early Prayer", "start_datetime": "2026-11-01 00:30:00",
                           "end_datetime": "2026-11-01 01:30:00"});
    let capture = breeze_capture(ambiguous.clone(), json!([ambiguous]));
    assert_eq!(outcome(&capture, breeze::EVENTS), Outcome::Truncated);
    let s = capture.service().unwrap();
    assert_eq!(s.starts_at.as_str(), "2026-11-01T00:30:00-05:00");
    assert!(s.ends_at.is_none());
}

/// Review D, H1: B1 saves a plan's day as the UTC date of local noon on the real day. So the real day is the one of
/// the stored day and the day after whose local noon, in the church's zone, falls on the stored UTC date.
#[test]
fn b1s_real_day_is_the_one_whose_local_noon_falls_on_the_stored_date() {
    let zones = FakeZones::standard();
    let real = |zone: &str, stored: &str| {
        b1::real_day(
            crate::capture::Date::parse(stored).unwrap(),
            &crate::capture::ZoneName::new(zone).unwrap(),
            &zones,
        )
        .map(|d| d.to_string())
    };
    // Sunday 2026-11-22 as each church's B1 saves it: noon Sunday local, as a UTC date.
    // Auckland (+13): noon is 23:00Z Saturday, stored 11-21.
    assert_eq!(
        real("Pacific/Auckland", "2026-11-21").as_deref(),
        Some("2026-11-22")
    );
    // Kiritimati (+14): noon is 22:00Z Saturday, stored 11-21.
    assert_eq!(
        real("Pacific/Kiritimati", "2026-11-21").as_deref(),
        Some("2026-11-22")
    );
    // Sydney (+11): noon is 01:00Z Sunday, stored 11-22.
    assert_eq!(
        real("Australia/Sydney", "2026-11-22").as_deref(),
        Some("2026-11-22")
    );
    // Kolkata (+5:30): 06:30Z Sunday. Chicago (-6): 18:00Z Sunday. Honolulu (-10): 22:00Z Sunday. All stored 11-22.
    for zone in ["Asia/Kolkata", "America/Chicago", "Pacific/Honolulu"] {
        assert_eq!(
            real(zone, "2026-11-22").as_deref(),
            Some("2026-11-22"),
            "{zone}"
        );
    }
    // Auckland in winter (+12): noon is 00:00Z the same day, so B1 stores the real day.
    assert_eq!(
        real("Pacific/Auckland", "2026-07-12").as_deref(),
        Some("2026-07-12")
    );
    // A zone this Mac doesn't know: no real day.
    assert_eq!(real("Europe/Oslo", "2026-11-22"), None);
}

#[test]
fn b1_far_east_a_saturday_rehearsal_is_not_the_service() {
    // The reviewer's case: Auckland, plan stored 11-21 (Sunday 11-22), a Saturday 19:00 rehearsal (06:00Z) and the
    // Sunday 10:00 service (21:00Z). The service is Sunday's time, on Sunday.
    let capture = b1_capture(
        json!("Pacific/Auckland"),
        "2026-11-21",
        json!([
            span("2026-11-21T06:00:00.000Z", "2026-11-21T07:00:00.000Z"),
            span("2026-11-21T21:00:00.000Z", "2026-11-21T22:15:00.000Z")
        ]),
        &FakeZones::standard(),
    );
    assert_eq!(outcome(&capture, b1::TIMES), Outcome::Ok);
    let service = capture.service().unwrap();
    assert_eq!(service.starts_at.as_str(), "2026-11-21T21:00:00.000Z");
    assert_eq!(
        service.ends_at.as_ref().unwrap().as_str(),
        "2026-11-21T22:15:00.000Z"
    );
    assert_eq!(service.day.unwrap().to_string(), "2026-11-22");
}

#[test]
fn b1_a_plan_with_no_time_on_its_real_day_is_truncated_with_no_day() {
    let zones = FakeZones::standard();
    // Chicago, Sunday plan, its only time Saturday 17:00 (23:00Z): the day before.
    for times in [
        json!([span("2026-11-21T23:00:00.000Z", "2026-11-22T00:00:00.000Z")]),
        // Or Monday 19:00 (Tuesday 01:00Z): not taken as the day after any more.
        json!([span("2026-11-24T01:00:00.000Z", "2026-11-24T02:00:00.000Z")]),
    ] {
        let capture = b1_capture(
            json!("America/Chicago"),
            "2026-11-22",
            times.clone(),
            &zones,
        );
        assert_eq!(outcome(&capture, b1::TIMES), Outcome::Truncated, "{times}");
        if let Some(service) = capture.service() {
            assert!(service.day.is_none());
        }
    }
}

/// Re-check, N2: on New Zealand's clocks-forward weekend, noon on Saturday 09-26 (NZST, 00:00Z) and noon on Sunday
/// 09-27 (NZDT, 23:00Z the day before) are both stored as 2026-09-26, so the real day can't be told. On the
/// clocks-back weekend, no real day is stored as 2026-04-04. Both give no real day.
#[test]
fn b1s_real_day_is_unknown_when_both_days_or_neither_store_as_the_plans_day() {
    let zones = FakeZones::standard();
    for zone in ["Pacific/Auckland", "Antarctica/McMurdo"] {
        let real = |stored: &str| {
            b1::real_day(
                crate::capture::Date::parse(stored).unwrap(),
                &crate::capture::ZoneName::new(zone).unwrap(),
                &zones,
            )
            .map(|d| d.to_string())
        };
        // Clocks forward (Sunday 2026-09-27).
        assert_eq!(real("2026-09-25").as_deref(), Some("2026-09-25"), "{zone}");
        assert_eq!(real("2026-09-26"), None, "{zone}");
        assert_eq!(real("2026-09-27").as_deref(), Some("2026-09-28"), "{zone}");
        // Clocks back (Sunday 2026-04-05): Saturday is stored as 04-03 and Sunday as 04-05.
        assert_eq!(real("2026-04-03").as_deref(), Some("2026-04-04"), "{zone}");
        assert_eq!(real("2026-04-04"), None, "{zone}");
        assert_eq!(real("2026-04-05").as_deref(), Some("2026-04-05"), "{zone}");
    }
}

/// The same, with this Mac's own zone data.
#[cfg(target_os = "macos")]
#[test]
fn b1s_real_day_on_the_clock_change_weekends_with_this_macs_zones() {
    let zones = crate::zones::SystemZones;
    for zone in ["Pacific/Auckland", "Antarctica/McMurdo"] {
        let real = |stored: &str| {
            b1::real_day(
                crate::capture::Date::parse(stored).unwrap(),
                &crate::capture::ZoneName::new(zone).unwrap(),
                &zones,
            )
            .map(|d| d.to_string())
        };
        assert_eq!(real("2026-09-26"), None, "{zone}");
        assert_eq!(real("2026-04-04"), None, "{zone}");
        assert_eq!(real("2026-11-21").as_deref(), Some("2026-11-22"), "{zone}");
    }
}

#[test]
fn b1_on_the_clocks_forward_sunday_a_saturday_rehearsal_is_not_the_service() {
    // The reviewer's case: a Sunday plan stored 2026-09-26, a Saturday 19:00 NZST rehearsal (07:00Z) and the Sunday
    // 10:00 NZDT service (21:00Z). The real day can't be told, so nothing is said to be the service's day.
    for zone in ["Pacific/Auckland", "Antarctica/McMurdo"] {
        let capture = b1_capture(
            json!(zone),
            "2026-09-26",
            json!([
                span("2026-09-26T07:00:00.000Z", "2026-09-26T08:00:00.000Z"),
                span("2026-09-26T21:00:00.000Z", "2026-09-26T22:15:00.000Z")
            ]),
            &FakeZones::standard(),
        );
        assert_eq!(outcome(&capture, b1::TIMES), Outcome::Truncated, "{zone}");
        if let Some(service) = capture.service() {
            assert!(service.day.is_none(), "{zone}");
        }
    }
}

/// Re-check, N1: a zone the caller supplies (the one the person confirmed in Ozzie) is used for everything and is the
/// capture's zone, over B1's own (missing here, or a default).
#[test]
fn b1_a_supplied_zone_is_used_over_b1s_own() {
    let zones = FakeZones::standard();
    let times = json!([span("2026-11-21T21:00:00.000Z", "2026-11-21T22:15:00.000Z")]);
    for b1_zone in [Value::Null, json!("America/New_York")] {
        let capture = b1_capture_in(
            b1_zone.clone(),
            Some("Pacific/Auckland"),
            "2026-11-21",
            times.clone(),
            &zones,
        );
        assert_eq!(
            capture.church.time_zone.as_ref().map(|z| z.as_str()),
            Some("Pacific/Auckland"),
            "{b1_zone}"
        );
        assert_eq!(outcome(&capture, b1::TIMES), Outcome::Ok);
        let service = capture.service().unwrap();
        assert_eq!(service.day.unwrap().to_string(), "2026-11-22");
        // Drew's blockout for Sunday 11-22 runs Auckland midnight to midnight, so it covers the service.
        let drew = capture
            .blockouts()
            .unwrap()
            .iter()
            .find(|b| b.person_id.as_str() == "PERdrew")
            .unwrap();
        assert_eq!(drew.starts_at.as_str(), "2026-11-22T00:00:00+13:00");
        assert!(overlaps(
            (&drew.starts_at, &drew.ends_at),
            (&service.starts_at, service.ends_at.as_ref())
        ));
    }
    // No zone from either: today's zone-free behaviour, nothing guessed.
    let capture = b1_capture_in(Value::Null, None, "2026-11-21", times, &zones);
    assert!(capture.church.time_zone.is_none());
    assert!(capture.service().unwrap().day.is_none());
}

/// Third re-check, N10: a zone the caller supplies that this Mac's zone data doesn't know (`Pacific/auckland`, the
/// wrong case: CoreFoundation, unlike Intl, reads names exactly) is refused before anything is sent, for B1 and Genesis.
#[test]
fn a_supplied_zone_this_mac_doesnt_know_is_refused_before_any_request() {
    let unknown = crate::capture::ZoneName::new("Pacific/auckland").unwrap();
    let clock = FakeClock::at(NOW);
    let fake = fake_b1(clock.clone());
    let result = b1::check(
        &fake,
        &*clock,
        &FakeZones::standard(),
        &key(),
        &id("CHUfict01"),
        &id("PLAfict01"),
        Some(&unknown),
    );
    assert_eq!(result.unwrap_err(), crate::http::ReadError::UnknownZone);
    assert_eq!(crate::http::ReadError::UnknownZone.word(), "bad-zone");
    assert!(fake.calls().is_empty());

    let fake = crate::test_support::genesis::fixture(clock.clone());
    let result = crate::genesis::check(
        &fake,
        &*clock,
        &FakeZones::standard(),
        &crate::test_support::genesis_key(),
        &id("5f0c2a4e-1b7d-4c3e-9a10-fictional001"),
        Some(&unknown),
    );
    assert_eq!(result.unwrap_err(), crate::http::ReadError::UnknownZone);
    assert!(fake.calls().is_empty());
}

/// The church's own zone (B1's or Breeze's) that this Mac doesn't know is never the capture's zone: it is null, and
/// the check runs as with no zone (no day, nothing placed by the name).
#[test]
fn a_churchs_own_zone_this_mac_doesnt_know_is_not_the_captures_zone() {
    let zones = FakeZones::standard();
    let times = json!([span("2026-11-21T21:00:00.000Z", "2026-11-21T22:15:00.000Z")]);
    // Wrong case, and a real name this table doesn't hold.
    for b1_zone in ["Pacific/auckland", "Europe/Oslo"] {
        let capture = b1_capture(json!(b1_zone), "2026-11-21", times.clone(), &zones);
        let none = b1_capture(Value::Null, "2026-11-21", times.clone(), &zones);
        assert!(capture.church.time_zone.is_none(), "{b1_zone}");
        assert_eq!(capture.service(), none.service(), "{b1_zone}");
        assert_eq!(capture.blockouts(), none.blockouts(), "{b1_zone}");
        assert_eq!(
            outcome(&capture, b1::TIMES),
            outcome(&none, b1::TIMES),
            "{b1_zone}"
        );
    }
    // Breeze: an account zone this Mac doesn't know gives the same as an account with none.
    let clock = FakeClock::at(NOW);
    let fake: FakeB1 = breeze::tests::fixture(clock.clone());
    fake.set(
        "/api/account/summary",
        ok(json!({"id": "1001", "name": "Cedar Hollow Fellowship", "subdomain": "cedarhollow", "status": "1",
                  "created_on": "2020-01-01 00:00:00", "details": {"timezone": "America/chicago"}})),
    );
    let capture = breeze::check(
        &fake,
        &*clock,
        &zones,
        &crate::test_support::breeze_key(),
        &id("cedarhollow"),
        &id("4401"),
        None,
    )
    .unwrap();
    assert!(capture.church.time_zone.is_none());
    assert!(capture.service().is_none());
}

/// The same with this Mac's own zone data: `Pacific/auckland` unknown, `Pacific/Auckland` known.
#[cfg(target_os = "macos")]
#[test]
fn a_supplied_zone_with_this_macs_zones() {
    let zones = crate::zones::SystemZones;
    let check = |zone: &str| {
        let clock = FakeClock::at(NOW);
        let fake = fake_b1(clock.clone());
        let result = b1::check(
            &fake,
            &*clock,
            &zones,
            &key(),
            &id("CHUfict01"),
            &id("PLAfict01"),
            Some(&crate::capture::ZoneName::new(zone).unwrap()),
        );
        (result, fake.calls().len())
    };
    let (result, sent) = check("Pacific/auckland");
    assert_eq!(result.unwrap_err(), crate::http::ReadError::UnknownZone);
    assert_eq!(sent, 0);
    let (result, sent) = check("Pacific/Auckland");
    assert_eq!(
        result
            .unwrap()
            .church
            .time_zone
            .as_ref()
            .map(|z| z.as_str()),
        Some("Pacific/Auckland")
    );
    assert!(sent > 0);
    // B1's own zone in the wrong case: null.
    let clock = FakeClock::at(NOW);
    let fake = fake_b1(clock.clone());
    fake.set(
        "/membership/churches/CHUfict01",
        ok(church(json!("Pacific/auckland"))),
    );
    let capture = b1::check(
        &fake,
        &*clock,
        &zones,
        &key(),
        &id("CHUfict01"),
        &id("PLAfict01"),
        None,
    )
    .unwrap();
    assert!(capture.church.time_zone.is_none());
}
