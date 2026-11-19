use super::*;
use crate::test_support::{CHURCH, FakeClock, NOW, PLAN, fake_b1, id, key};
use serde_json::{Value, json};

/// The fictional B1 church's full capture, as JSON.
fn base() -> Value {
    let clock = FakeClock::at(NOW);
    let fake = fake_b1(clock.clone());
    let capture = crate::b1::check(
        &fake,
        &*clock,
        &crate::test_support::FakeZones::standard(),
        &key(),
        &id(CHURCH),
        &id(PLAN),
        None,
    )
    .unwrap();
    serde_json::from_str(&capture.to_json().unwrap()).unwrap()
}
fn parse(value: &Value) -> Result<SystemCapture, Invalid> {
    SystemCapture::from_json(value.to_string().as_bytes())
}
/// An empty capture of `system`, with no reads.
fn empty(system: &str) -> Value {
    json!({
        "version": 1, "system": system, "church": {"id": "CHUfict01", "time_zone": null},
        "started_at": "2026-11-17T15:00:00Z", "completed_at": "2026-11-17T15:00:05Z", "reads": [],
        "service": null, "busy": null, "positions": [], "assignments": [], "on_service": [], "team_members": [],
        "blockouts": null, "groups": [], "events": [], "forms": [], "names": {}, "labels": {}
    })
}

#[test]
fn a_capture_round_trips_through_its_json() {
    let value = base();
    let capture = parse(&value).unwrap();
    let again: Value = serde_json::from_str(&capture.to_json().unwrap()).unwrap();
    assert_eq!(again, value);
    // snake_case and closed words, as the page reads them.
    assert_eq!(value["system"], "b1");
    assert_eq!(value["reads"][0]["read"], "b1.church");
    assert_eq!(value["reads"][0]["outcome"], "ok");
    assert_eq!(value["assignments"][2]["status"], "declined");
    for system in ["breeze", "genesis"] {
        assert!(parse(&empty(system)).is_ok(), "{system}");
    }
}

/// Only the three systems Ozzie reads: a capture naming any other system is refused, the system on hold included (its
/// name is assembled here only so a search of the library for that name finds nothing; no check enforces that).
#[test]
fn a_capture_from_an_unknown_system_is_refused() {
    let on_hold = ["sub", "splash"].concat();
    for system in [on_hold.as_str(), "planning-center", "B1", ""] {
        assert_eq!(
            parse(&empty(system)).unwrap_err(),
            Invalid::Shape,
            "{system}"
        );
    }
}

#[test]
fn unknown_and_missing_fields_are_refused() {
    let paths: &[&[&str]] = &[
        &[],
        &["church"],
        &["service"],
        &["positions", "0"],
        &["assignments", "0"],
        &["team_members", "0"],
        &["blockouts", "0"],
        &["groups", "0"],
        &["events", "0"],
        &["forms", "0"],
        &["reads", "0"],
    ];
    for path in paths {
        let mut value = base();
        let mut at = &mut value;
        for step in *path {
            at = match step.parse::<usize>() {
                Ok(i) => &mut at[i],
                Err(_) => &mut at[*step],
            };
        }
        at.as_object_mut()
            .unwrap()
            .insert("note".into(), json!("free text"));
        assert_eq!(parse(&value).unwrap_err(), Invalid::Shape, "{path:?}");
    }
    // A nullable field must still be there.
    for (path, field) in [("church", "time_zone"), ("service", "ends_at")] {
        let mut value = base();
        value[path].as_object_mut().unwrap().remove(field);
        assert_eq!(parse(&value).unwrap_err(), Invalid::Shape, "{field}");
    }
    for field in [
        "service",
        "blockouts",
        "names",
        "labels",
        "reads",
        "on_service",
    ] {
        let mut value = base();
        value.as_object_mut().unwrap().remove(field);
        assert_eq!(parse(&value).unwrap_err(), Invalid::Shape, "{field}");
    }
    // A duplicate key.
    let text = base()
        .to_string()
        .replacen("\"version\":1", "\"version\":1,\"version\":1", 1);
    assert_eq!(
        SystemCapture::from_json(text.as_bytes()).unwrap_err(),
        Invalid::Shape
    );
    let mut value = base();
    value["version"] = json!(2);
    assert_eq!(parse(&value).unwrap_err(), Invalid::Version);
}

#[test]
fn free_text_is_refused_everywhere_but_names_and_labels() {
    let cases: Vec<(&str, Value)> = vec![
        ("/church/id", json!("Cedar Hollow Fellowship")),
        ("/church/time_zone", json!("Central Time, roughly")),
        ("/service/id", json!("Sunday 9am")),
        ("/positions/0/id", json!("Vocals please")),
        ("/positions/0/team_id", json!("the worship team")),
        ("/positions/0/needed", json!("two")),
        ("/assignments/0/person_id", json!("Avery Quillfeather")),
        ("/assignments/0/status", json!("said maybe")),
        ("/reads/0/read", json!("b1.notes")),
        ("/reads/0/outcome", json!("fine")),
        ("/reads/0/checked_at", json!("this morning")),
        ("/groups/0/members", json!(-1)),
        ("/events/0/attendance", json!(1.5)),
        ("/system", json!("planning-center")),
    ];
    for (pointer, bad) in cases {
        let mut value = base();
        *value.pointer_mut(pointer).unwrap() = bad;
        assert_eq!(parse(&value).unwrap_err(), Invalid::Shape, "{pointer}");
    }
    // A name or label key that isn't an id / label key.
    let mut value = base();
    value["names"]["Avery Quillfeather"] = json!("Avery Quillfeather");
    assert_eq!(parse(&value).unwrap_err(), Invalid::Shape);
    let mut value = base();
    value["labels"]["note"] = json!("Bring the banners");
    assert_eq!(parse(&value).unwrap_err(), Invalid::Shape);
    // Names and labels must be as a capture keeps them: no control characters, no surrounding space, not empty.
    for bad in [
        "",
        " Avery",
        "Avery\nQuillfeather",
        "Avery\u{202e}Q",
        &"x".repeat(MAX_NAME_UNITS + 1),
    ] {
        let mut value = base();
        value["names"]["PERavery"] = json!(bad);
        assert_eq!(parse(&value).unwrap_err(), Invalid::Shape, "{bad:?}");
    }
}

#[test]
fn text_is_cleaned_when_it_is_made() {
    assert_eq!(
        Name::new("  Avery \t\n Quillfeather ").unwrap().as_str(),
        "Avery Quillfeather"
    );
    assert_eq!(
        Name::new("Av\u{0}ery\u{200b} Q\u{202e}").unwrap().as_str(),
        "Avery Q"
    );
    assert!(Name::new(" \u{feff}\u{7} ").is_none());
    assert_eq!(
        Name::new(&"n".repeat(500)).unwrap().as_str().len(),
        MAX_NAME_UNITS
    );
    assert_eq!(
        Label::new(&"l".repeat(500)).unwrap().as_str().len(),
        MAX_LABEL_UNITS
    );
    // UTF-16 units, as the page counts: a character outside the basic plane is two.
    let wide = Label::new(&"\u{1f54a}".repeat(150)).unwrap();
    assert_eq!(wide.as_str().encode_utf16().count(), MAX_LABEL_UNITS);
    // A space is kept only with a character after it inside the cap.
    let cut = Name::new(&format!("{} tail", "a".repeat(MAX_NAME_UNITS - 1))).unwrap();
    assert_eq!(cut.as_str(), "a".repeat(MAX_NAME_UNITS - 1));
    let cut = Name::new(&format!("{} tail", "a".repeat(MAX_NAME_UNITS - 2))).unwrap();
    assert_eq!(
        cut.as_str(),
        format!("{} t", "a".repeat(MAX_NAME_UNITS - 2))
    );
    assert_eq!(format!("{:?}", Name::new("Avery").unwrap()), "Name(..)");
}

#[test]
fn ids_are_letters_digits_dash_and_underscore_up_to_64() {
    for good in ["a", "PLA00000001", "x-y_z", &"9".repeat(64)] {
        assert!(Id::new(good).is_some(), "{good}");
    }
    for bad in [
        "",
        " a",
        "a b",
        "a/b",
        "a.b",
        "a?b",
        "../x",
        "é",
        &"9".repeat(65),
    ] {
        assert!(Id::new(bad).is_none(), "{bad}");
    }
}

#[test]
fn times_need_an_explicit_offset_and_a_real_moment() {
    for good in [
        "2026-11-22T09:00:00Z",
        "2026-11-22T09:00:00.5Z",
        "2026-11-22T09:00:00.123-06:00",
        "2026-02-28T23:59:59+14:00",
        "2028-02-29T00:00:00+00:00",
    ] {
        assert!(Time::parse(good).is_some(), "{good}");
    }
    for bad in [
        "2026-11-22T09:00:00",
        "2026-11-22 09:00:00Z",
        "2026-11-22t09:00:00z",
        "2026-11-22T09:00:00.1234Z",
        "2026-11-22T09:00Z",
        "2026-11-22T24:00:00Z",
        "2026-11-22T09:60:00Z",
        "2026-11-22T09:00:60Z",
        "2026-02-29T09:00:00Z",
        "2026-13-01T09:00:00Z",
        "2026-11-22T09:00:00-00:00",
        "2026-11-22T09:00:00+24:00",
        "2026-11-22T09:00:00+0600",
        "2026-11-22",
        "2026-11-22T09:00:00\u{ff3a}",
    ] {
        assert!(Time::parse(bad).is_none(), "{bad}");
    }
    let a = Time::parse("2026-11-22T09:00:00-06:00").unwrap();
    let b = Time::parse("2026-11-22T15:00:00Z").unwrap();
    assert_eq!(a.unix_millis(), b.unix_millis());
    assert_eq!(Time::from_unix_millis(b.unix_millis()).unwrap(), b);
    assert_eq!(
        Time::parse("2026-11-22T09:00:00.25Z")
            .unwrap()
            .unix_millis()
            % 1000,
        250
    );
    assert_eq!(
        Time::from_unix_millis(0).unwrap().as_str(),
        "1970-01-01T00:00:00Z"
    );
    assert_eq!(a.numeric_offset(), Some(-360));
    assert!(b.is_utc() && b.numeric_offset().is_none());
    let day = Date::parse("2026-12-31").unwrap();
    assert_eq!(day.next_day().unwrap().to_string(), "2027-01-01");
    assert_eq!(
        Time::at_midnight(day, 330).unwrap().as_str(),
        "2026-12-31T00:00:00+05:30"
    );
}

#[test]
fn the_run_times_and_intervals_must_be_in_order() {
    let mut value = base();
    value["started_at"] = json!("2026-11-17T09:00:00-06:00");
    assert_eq!(parse(&value).unwrap_err(), Invalid::Times);
    let mut value = base();
    value["completed_at"] = json!("2026-11-17T14:59:59Z");
    assert_eq!(parse(&value).unwrap_err(), Invalid::Times);
    let mut value = base();
    value["reads"][0]["checked_at"] = json!("2026-11-18T00:00:00Z");
    assert_eq!(parse(&value).unwrap_err(), Invalid::Times);
    // A service and a blockout must end after they start; an event may end as it starts.
    let mut value = base();
    value["service"]["ends_at"] = value["service"]["starts_at"].clone();
    assert_eq!(parse(&value).unwrap_err(), Invalid::Times);
    let mut value = base();
    value["blockouts"][0]["ends_at"] = value["blockouts"][0]["starts_at"].clone();
    assert_eq!(parse(&value).unwrap_err(), Invalid::Times);
    let mut value = base();
    value["events"][0]["ends_at"] = value["events"][0]["starts_at"].clone();
    assert!(parse(&value).is_ok());
    value["events"][0]["ends_at"] = json!("2026-11-27T17:00:00-06:00");
    assert_eq!(parse(&value).unwrap_err(), Invalid::Times);
}

#[test]
fn reads_are_this_systems_words_each_once() {
    let mut value = base();
    value["reads"][1]["read"] = json!("b1.church");
    assert_eq!(parse(&value).unwrap_err(), Invalid::Reads);
    let mut value = base();
    value["reads"][0]["read"] = json!("breeze.account");
    assert_eq!(parse(&value).unwrap_err(), Invalid::Reads);
}

#[test]
fn every_cap_is_enforced() {
    /// `field` at its cap is fine and one more is refused, everything else emptied so references hold.
    fn over(field: &str, item: impl Fn(usize) -> Value, max: usize) {
        let mut value = base();
        value["positions"] = json!([{"id": "POSone", "team_id": "GRPone", "needed": 1}]);
        value["assignments"] = json!([]);
        value["team_members"] = json!([{"team_id": "GRPone", "person_id": "PERone"}]);
        value["blockouts"] = json!([]);
        value["busy"] = json!([]);
        value["names"] = json!({});
        value["labels"] = json!({});
        value[field] = Value::Array((0..max).map(&item).collect());
        assert!(parse(&value).is_ok(), "{field} at the cap");
        value[field] = Value::Array((0..=max).map(&item).collect());
        assert_eq!(parse(&value).unwrap_err(), Invalid::TooMany, "{field}");
    }
    let base_value = base();
    let start = base_value["service"]["starts_at"].clone();
    let end = base_value["service"]["ends_at"].clone();
    over(
        "positions",
        |n| json!({"id": format!("P{n}"), "team_id": "GRPone", "needed": 1}),
        MAX_POSITIONS,
    );
    over(
        "assignments",
        |n| json!({"id": format!("A{n}"), "position_id": "POSone", "person_id": "PERone", "status": "accepted", "asked": null}),
        MAX_ASSIGNMENTS,
    );
    over(
        "team_members",
        |n| json!({"team_id": "GRPone", "person_id": format!("P{n}")}),
        MAX_TEAM_MEMBERS,
    );
    over(
        "blockouts",
        |_| json!({"person_id": "PERone", "starts_at": start, "ends_at": end}),
        MAX_BLOCKOUTS,
    );
    over(
        "groups",
        |n| json!({"id": format!("G{n}"), "members": null}),
        MAX_GROUPS,
    );
    over(
        "events",
        |n| json!({"id": format!("E{n}"), "starts_at": start, "ends_at": null, "attendance": null}),
        MAX_EVENTS,
    );
    over(
        "forms",
        |n| json!({"id": format!("F{n}"), "submissions": null}),
        MAX_FORMS,
    );
    // Names: more than 3000 people is refused.
    let mut value = empty("b1");
    value["team_members"] = Value::Array(
        (0..=MAX_NAMES)
            .map(|n| json!({"team_id": "GRPone", "person_id": format!("P{n}")}))
            .collect(),
    );
    value["positions"] = json!([{"id": "POSone", "team_id": "GRPone", "needed": 1}]);
    let names: serde_json::Map<String, Value> = (0..=MAX_NAMES)
        .map(|n| (format!("P{n}"), json!("Fictional Person")))
        .collect();
    value["names"] = Value::Object(names);
    assert_eq!(parse(&value).unwrap_err(), Invalid::TooMany);
    // Counts.
    let mut value = base();
    value["positions"][0]["needed"] = json!(MAX_COUNT + 1);
    assert_eq!(parse(&value).unwrap_err(), Invalid::Count);
}

#[test]
fn duplicates_and_dangling_references_are_refused() {
    let mut value = base();
    let first = value["positions"][0].clone();
    value["positions"].as_array_mut().unwrap().push(first);
    assert_eq!(parse(&value).unwrap_err(), Invalid::Duplicate);
    let mut value = base();
    let first = value["team_members"][0].clone();
    value["team_members"].as_array_mut().unwrap().push(first);
    assert_eq!(parse(&value).unwrap_err(), Invalid::Duplicate);
    for (pointer, bad) in [
        ("/assignments/0/position_id", json!("POSnowhere")),
        ("/team_members/0/team_id", json!("GRPnowhere")),
        ("/blockouts/0/person_id", json!("PERnobody")),
    ] {
        let mut value = base();
        *value.pointer_mut(pointer).unwrap() = bad;
        assert_eq!(parse(&value).unwrap_err(), Invalid::Reference, "{pointer}");
    }
    let mut value = base();
    value["names"]["PERnobody"] = json!("Nobody Fictional");
    assert_eq!(parse(&value).unwrap_err(), Invalid::Reference);
    for key in [
        "position:POSnowhere",
        "team:GRPyouth",
        "group:GRPnowhere",
        "event:EVTx",
        "form:FRMx",
    ] {
        let mut value = base();
        value["labels"][key] = json!("Something");
        assert_eq!(parse(&value).unwrap_err(), Invalid::Reference, "{key}");
    }
    let mut value = base();
    value["service"] = Value::Null;
    value["blockouts"] = Value::Null;
    assert_eq!(parse(&value).unwrap_err(), Invalid::Reference);
}

#[test]
fn a_system_cant_hand_over_what_its_api_doesnt_have() {
    let service = json!({"id": "S1", "day": "2026-11-22", "starts_at": "2026-11-22T09:00:00-06:00", "ends_at": null,
                         "shared": null});
    let mut value = empty("genesis");
    value["service"] = service.clone();
    assert_eq!(parse(&value).unwrap_err(), Invalid::NotSupplied);
    let mut value = empty("genesis");
    value["positions"] = json!([{"id": "P1", "team_id": null, "needed": 1}]);
    assert_eq!(parse(&value).unwrap_err(), Invalid::NotSupplied);
    for system in ["breeze", "genesis"] {
        let mut value = empty(system);
        value["blockouts"] = json!([]);
        assert_eq!(parse(&value).unwrap_err(), Invalid::NotSupplied, "{system}");
    }
    let mut value = empty("breeze");
    value["service"] = service;
    assert!(parse(&value).is_ok());
    let mut value = empty("b1");
    value["events"] = json!([{"id": "E1", "starts_at": "2026-11-22T09:00:00Z", "ends_at": null, "attendance": 4}]);
    assert_eq!(parse(&value).unwrap_err(), Invalid::NotSupplied);
    value["events"][0]["attendance"] = Value::Null;
    assert!(parse(&value).is_ok());
}

#[test]
fn zone_names_have_the_pages_shape() {
    for good in [
        "UTC",
        "America/Chicago",
        "America/Argentina/Buenos_Aires",
        "Etc/GMT+5",
        "America/Port-au-Prince",
    ] {
        assert!(ZoneName::new(good).is_some(), "{good}");
    }
    for bad in [
        "",
        "Chicago",
        "GMT",
        "Etc/",
        "/UTC",
        "America//Chicago",
        "Central Standard Time",
        "Am3rica/X",
        &"A/".repeat(40),
    ] {
        assert!(ZoneName::new(bad).is_none(), "{bad}");
    }
}

/// `on_service`: people scheduled for this service in no role. Each has a name, once; at most 500; only from a system
/// with a Sunday check; a name may be kept for them.
#[test]
fn on_service_people_are_named_once_capped_and_only_from_a_sunday_check() {
    let mut value = empty("breeze");
    value["on_service"] = json!(["PERfree"]);
    value["names"] = json!({"PERfree": "Fictional Helper"});
    assert!(parse(&value).is_ok());
    // No name for them.
    value["names"] = json!({});
    assert_eq!(parse(&value).unwrap_err(), Invalid::Reference);
    // Twice.
    value["on_service"] = json!(["PERfree", "PERfree"]);
    value["names"] = json!({"PERfree": "Fictional Helper"});
    assert_eq!(parse(&value).unwrap_err(), Invalid::Duplicate);
    // Over the cap.
    let ids: Vec<String> = (0..=MAX_ON_SERVICE).map(|n| format!("P{n}")).collect();
    let names: serde_json::Map<String, Value> = ids
        .iter()
        .map(|i| (i.clone(), json!("Fictional Person")))
        .collect();
    value["names"] = Value::Object(names);
    value["on_service"] = json!(ids[..MAX_ON_SERVICE]);
    assert_eq!(
        parse(&value).unwrap_err(),
        Invalid::Reference,
        "a name for someone not in it"
    );
    value["on_service"] = json!(ids);
    assert_eq!(parse(&value).unwrap_err(), Invalid::TooMany);
    // A system with no Sunday check has nobody on a service.
    let mut value = empty("genesis");
    value["on_service"] = json!(["PERfree"]);
    value["names"] = json!({"PERfree": "Fictional Helper"});
    assert_eq!(parse(&value).unwrap_err(), Invalid::NotSupplied);
}

/// `asked` is required on every assignment (null when the system doesn't say), and only a system that says whether a
/// request was sent (B1) may give one.
#[test]
fn asked_is_required_and_only_from_a_system_that_says() {
    let mut value = base();
    value["assignments"][0]
        .as_object_mut()
        .unwrap()
        .remove("asked");
    assert_eq!(parse(&value).unwrap_err(), Invalid::Shape);
    let mut value = empty("breeze");
    value["positions"] = json!([{"id": "9627", "team_id": null, "needed": 1}]);
    value["assignments"] = json!([{"id": "501-9627", "position_id": "9627", "person_id": "157857", "status": "accepted", "asked": null}]);
    assert!(parse(&value).is_ok());
    value["assignments"][0]["asked"] = json!(true);
    assert_eq!(parse(&value).unwrap_err(), Invalid::NotSupplied);
}

/// Review E, L5: someone in a role isn't also on the service in no role.
#[test]
fn on_service_holds_no_one_in_a_role() {
    let mut value = empty("breeze");
    value["positions"] = json!([{"id": "9627", "team_id": null, "needed": 1}]);
    value["assignments"] = json!([{"id": "501-9627", "position_id": "9627", "person_id": "157857", "status": "accepted", "asked": null}]);
    value["on_service"] = json!(["157857"]);
    value["names"] = json!({"157857": "Fictional Helper"});
    assert_eq!(parse(&value).unwrap_err(), Invalid::Duplicate);
}

/// `service.shared` is required (null when the system doesn't say), and only B1 may give a value.
#[test]
fn service_shared_is_required_and_only_from_b1() {
    let mut value = base();
    value["service"].as_object_mut().unwrap().remove("shared");
    assert_eq!(parse(&value).unwrap_err(), Invalid::Shape);
    let mut value = empty("breeze");
    value["service"] = json!({"id": "4401", "day": null, "starts_at": "2026-11-22T09:00:00-06:00", "ends_at": null, "shared": null});
    assert!(parse(&value).is_ok());
    value["service"]["shared"] = json!(true);
    assert_eq!(parse(&value).unwrap_err(), Invalid::NotSupplied);
}
