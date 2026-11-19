use super::*;
use crate::test_support::FakeZones;

fn zone(name: &str) -> ZoneName {
    ZoneName::new(name).unwrap()
}
fn day(text: &str) -> Date {
    Date::parse(text).unwrap()
}
const H: i64 = 3600;

#[test]
fn a_local_time_is_one_instant_a_gap_or_ambiguous_never_a_guess() {
    let zones = FakeZones::standard();
    let chicago = zone("America/Chicago");
    let single = |d: &str, s: i64| match zones.local_to_instant(&chicago, day(d), s) {
        LocalResult::Single(t) => t.as_str().to_owned(),
        other => panic!("{other:?}"),
    };
    assert_eq!(single("2026-11-22", 9 * H), "2026-11-22T09:00:00-06:00");
    assert_eq!(
        single("2026-07-12", 9 * H + 30 * 60),
        "2026-07-12T09:30:00-05:00"
    );
    // Spring forward, 2026-03-08: 2:00 to 2:59 never happens.
    assert_eq!(
        zones.local_to_instant(&chicago, day("2026-03-08"), 2 * H + 30 * 60),
        LocalResult::Gap
    );
    assert_eq!(single("2026-03-08", 3 * H), "2026-03-08T03:00:00-05:00");
    // Fall back, 2026-11-01: 1:00 to 1:59 happens twice.
    match zones.local_to_instant(&chicago, day("2026-11-01"), H + 30 * 60) {
        LocalResult::Ambiguous(a, b) => {
            assert_eq!(a.as_str(), "2026-11-01T01:30:00-05:00");
            assert_eq!(b.as_str(), "2026-11-01T01:30:00-06:00");
        }
        other => panic!("{other:?}"),
    }
    // Auckland in its summer; a zone the table doesn't know.
    match zones.local_to_instant(&zone("Pacific/Auckland"), day("2026-11-22"), 10 * H) {
        LocalResult::Single(t) => assert_eq!(t.as_str(), "2026-11-22T10:00:00+13:00"),
        other => panic!("{other:?}"),
    }
    assert_eq!(
        zones.local_to_instant(&zone("Europe/Oslo"), day("2026-11-22"), 0),
        LocalResult::Unknown
    );
    assert_eq!(
        NoZones.local_to_instant(&chicago, day("2026-11-22"), 0),
        LocalResult::Unknown
    );
}

#[test]
fn an_instant_falls_on_its_local_day() {
    let zones = FakeZones::standard();
    let t = Time::parse("2026-11-23T01:00:00.000Z").unwrap();
    assert_eq!(
        zones.local_day(&zone("America/Chicago"), &t),
        Some(day("2026-11-22"))
    );
    assert_eq!(
        zones.local_day(&zone("Pacific/Auckland"), &t),
        Some(day("2026-11-23"))
    );
    let t = Time::parse("2026-11-21T21:00:00.000Z").unwrap();
    assert_eq!(
        zones.local_day(&zone("Pacific/Auckland"), &t),
        Some(day("2026-11-22"))
    );
    assert_eq!(zones.local_day(&zone("Europe/Oslo"), &t), None);
}

/// This Mac's own zone data, on fixed dates: Chicago's winter and summer offsets, Auckland's, a gap, and a name it
/// doesn't know.
#[cfg(target_os = "macos")]
#[test]
fn the_system_knows_real_zones() {
    let at = |t: &str| Time::parse(t).unwrap().unix_millis() / 1000;
    let chicago = zone("America/Chicago");
    let auckland = zone("Pacific/Auckland");
    assert_eq!(
        SystemZones.offset_seconds(&chicago, at("2026-01-15T12:00:00Z")),
        Some(-21_600)
    );
    assert_eq!(
        SystemZones.offset_seconds(&chicago, at("2026-07-15T12:00:00Z")),
        Some(-18_000)
    );
    assert_eq!(
        SystemZones.offset_seconds(&auckland, at("2026-01-15T12:00:00Z")),
        Some(46_800)
    );
    assert_eq!(
        SystemZones.offset_seconds(&auckland, at("2026-07-15T12:00:00Z")),
        Some(43_200)
    );
    assert_eq!(
        SystemZones.offset_seconds(&zone("America/Nowhere"), at("2026-01-15T12:00:00Z")),
        None
    );
    assert_eq!(
        SystemZones.local_to_instant(&chicago, day("2026-03-08"), 2 * H + 30 * 60),
        LocalResult::Gap
    );
    match SystemZones.local_to_instant(&chicago, day("2026-11-22"), 9 * H) {
        LocalResult::Single(t) => assert_eq!(t.as_str(), "2026-11-22T09:00:00-06:00"),
        other => panic!("{other:?}"),
    }
}
