//! The seam with the page: each system's main captures from fixed data, byte for byte against the files committed in
//! core/test/church-systems/captures/, which the page's own tests parse and map. A change on either side breaks a test
//! on the other. The files are written only when `OZZIE_WRITE_CAPTURES=1` is set; otherwise this test writes nothing.
use crate::capture::SystemCapture;
use crate::test_support::{Answer, FakeClock, NOW, breeze_key, fake_b1, genesis_key, id, key, ok};
use crate::{b1, breeze, genesis};
use serde_json::json;
use std::path::PathBuf;

fn folder() -> PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../test/church-systems/captures")
}
fn b1_at(unix_millis: i64, change: impl Fn(&crate::test_support::FakeB1)) -> SystemCapture {
    b1_in(unix_millis, None, change)
}
/// The same, with a zone the caller supplies (the one the person confirmed in Ozzie).
fn b1_in(
    unix_millis: i64,
    zone: Option<&str>,
    change: impl Fn(&crate::test_support::FakeB1),
) -> SystemCapture {
    let zone = zone.map(|z| crate::capture::ZoneName::new(z).unwrap());
    let clock = FakeClock::at(unix_millis);
    let fake = fake_b1(clock.clone());
    change(&fake);
    b1::check(
        &fake,
        &*clock,
        &crate::test_support::FakeZones::standard(),
        &key(),
        &id("CHUfict01"),
        &id("PLAfict01"),
        zone.as_ref(),
    )
    .unwrap()
}
/// Every capture the page pins, by file name.
fn captures() -> Vec<(&'static str, SystemCapture)> {
    let mut out = Vec::new();
    out.push(("b1-full", b1_at(NOW, |_| {})));
    out.push((
        "b1-failed-read",
        b1_at(NOW, |fake| {
            fake.set(
                "/doing/blockoutDates/upcoming",
                Answer::Fail(crate::http::ReadError::Timeout),
            )
        }),
    ));
    // Chicago, read at Saturday 18:00 CST: 00:00 UTC of the service's day, so the blockouts read is truncated.
    let service_day = crate::capture::Time::parse("2026-11-22T00:00:00Z")
        .unwrap()
        .unix_millis();
    out.push(("b1-service-day", b1_at(service_day, |_| {})));
    // The plan not yet shared with its volunteers (`prepared` true): `service.shared` false.
    out.push((
        "b1-not-shared",
        b1_at(NOW, |fake| {
            fake.set(
                "/doing/plans/PLAfict01",
                ok(json!({"id": "PLAfict01", "name": "Sunday Gathering", "serviceDate": "2026-11-22T00:00:00.000Z",
                          "prepared": true})),
            );
        }),
    ));
    // The plan with a second service time (11:00 to 12:15 CST): the service is the whole span, and `times` is 2, so
    // the page names no single time for a role (issue 45).
    out.push((
        "b1-two-times",
        b1_at(NOW, |fake| {
            fake.set(
                "/doing/times/plan/PLAfict01",
                ok(json!([
                    {"id": "TIMservice", "planId": "PLAfict01", "displayName": "Sunday", "startTime": "2026-11-22T15:00:00.000Z",
                     "endTime": "2026-11-22T16:30:00.000Z", "teams": "Worship,Technical,Hospitality", "serviceTimeType": "service"},
                    {"id": "TIMsecond", "planId": "PLAfict01", "displayName": "Second service", "startTime": "2026-11-22T17:00:00.000Z",
                     "endTime": "2026-11-22T18:15:00.000Z", "teams": "Worship", "serviceTimeType": "service"}
                ])),
            );
        }),
    ));
    // A church with no zone in B1, checked with the zone the person confirmed (Auckland): B1 saved the Sunday 11-22
    // plan as 11-21, the Saturday 19:00 rehearsal (06:00Z) is left out, and Drew's Sunday blockout runs Auckland
    // midnight to midnight, so it covers the service (21:00Z).
    out.push((
        "b1-zone-supplied",
        b1_in(NOW, Some("Pacific/Auckland"), |fake| {
            fake.set(
                "/membership/churches/CHUfict01",
                ok(json!({"id": "CHUfict01", "name": "Cedar Hollow Fellowship", "timeZone": null})),
            );
            fake.set(
                "/doing/plans/PLAfict01",
                ok(json!({"id": "PLAfict01", "name": "Sunday Gathering", "serviceDate": "2026-11-21T00:00:00.000Z"})),
            );
            fake.set(
                "/doing/times/plan/PLAfict01",
                ok(json!([
                    {"id": "TIMrehearse", "startTime": "2026-11-21T06:00:00.000Z", "endTime": "2026-11-21T07:00:00.000Z"},
                    {"id": "TIMservice", "startTime": "2026-11-21T21:00:00.000Z", "endTime": "2026-11-21T22:15:00.000Z"}
                ])),
            );
        }),
    ));

    let clock = FakeClock::at(NOW);
    let fake = breeze::tests::fixture(clock.clone());
    out.push((
        "breeze-full",
        breeze::check(
            &fake,
            &*clock,
            &crate::test_support::FakeZones::standard(),
            &breeze_key(),
            &id("cedarhollow"),
            &id("4401"),
            None,
        )
        .unwrap(),
    ));
    let clock = FakeClock::at(NOW);
    let fake = genesis::tests::fixture(clock.clone());
    out.push((
        "genesis-full",
        genesis::check(
            &fake,
            &*clock,
            &crate::test_support::FakeZones::standard(),
            &genesis_key(),
            &id("5f0c2a4e-1b7d-4c3e-9a10-fictional001"),
            crate::capture::ZoneName::new("America/Chicago").as_ref(),
        )
        .unwrap(),
    ));
    out
}
/// A capture as the committed file holds it: valid, pretty JSON, one newline at the end.
fn text(capture: &SystemCapture) -> String {
    capture.valid().unwrap();
    serde_json::to_string_pretty(capture).unwrap() + "\n"
}

#[test]
fn the_committed_captures_are_what_the_crate_makes() {
    let write = std::env::var("OZZIE_WRITE_CAPTURES").as_deref() == Ok("1");
    let folder = folder();
    if write {
        std::fs::create_dir_all(&folder).unwrap();
    }
    for (name, capture) in captures() {
        let made = text(&capture);
        // What the page parses must also be what this crate parses.
        assert_eq!(
            SystemCapture::from_json(made.as_bytes()).unwrap(),
            capture,
            "{name}"
        );
        let path = folder.join(format!("{name}.json"));
        if write {
            std::fs::write(&path, &made).unwrap();
        } else {
            let committed = std::fs::read_to_string(&path).unwrap_or_else(|_| {
                panic!("{name}.json: run with OZZIE_WRITE_CAPTURES=1 to make it")
            });
            assert!(
                committed == made,
                "{name}.json differs from what the crate makes now"
            );
        }
    }
}

#[test]
fn the_captures_hold_no_secret_and_cover_every_system() {
    let names: Vec<&str> = captures().iter().map(|(n, _)| *n).collect();
    for system in ["b1-", "breeze-", "genesis-"] {
        assert!(names.iter().any(|n| n.starts_with(system)), "{system}");
    }
    let secrets = [
        crate::test_support::key_text(),
        crate::test_support::breeze_key_text(),
        crate::test_support::genesis_key_text(),
    ];
    for (name, capture) in captures() {
        let made = text(&capture);
        for secret in &secrets {
            assert!(!made.contains(secret.as_str()), "{name}");
        }
    }
}
