//! Church reads: People forms, Check-Ins and Registrations. Fictional payloads only; canaries must
//! never survive, no child is ever named, and a submitted answer is never read.
use super::*;

const API: &str = "https://api.planningcenteronline.com";

fn forms() -> SourceRequest {
    org(Collection::PeopleForms)
}
fn submissions() -> SourceRequest {
    at(
        Collection::PeopleFormSubmissions,
        Target::form("610").within(&window()),
    )
    .unwrap()
}
fn checkins_events() -> SourceRequest {
    org(Collection::CheckInsEvents)
}
fn locations() -> SourceRequest {
    at(Collection::CheckInsLocations, Target::checkins_event("620")).unwrap()
}
fn periods() -> SourceRequest {
    at(
        Collection::CheckInsEventPeriods,
        Target::checkins_event("620").within(&window()),
    )
    .unwrap()
}
fn counts() -> SourceRequest {
    at(
        Collection::CheckInsLocationCounts,
        Target::checkins_event_time("630"),
    )
    .unwrap()
}
fn signups() -> SourceRequest {
    org(Collection::RegistrationsSignups)
}
fn attendees() -> SourceRequest {
    at(Collection::RegistrationsAttendees, Target::signup("640")).unwrap()
}
fn invalid(request: &SourceRequest, raw: Value) {
    assert_eq!(
        project(request, raw.clone()).err(),
        Some(SourceError::InvalidResponse),
        "{raw}"
    );
}

#[test]
fn church_urls_are_exact_get_paths_with_pinned_versions_and_fixed_queries() {
    let window = format!("where[ends_at][gt]={W0}&where[starts_at][lt]={W1}&order=starts_at");
    for (request, url, version, label) in [
        (
            forms(),
            format!("{API}/people/v2/forms?filter=not_archived&per_page=100&offset=0"),
            "2025-11-10",
            "people_forms",
        ),
        (
            submissions(),
            format!(
                "{API}/people/v2/forms/610/form_submissions?include=person&fields[Person]=name,child&where[created_at][gte]={W0}&where[created_at][lt]={W1}&order=created_at&per_page=100&offset=0"
            ),
            "2025-11-10",
            "people_form_submissions",
        ),
        (
            checkins_events(),
            format!("{API}/check-ins/v2/events?filter=not_archived&per_page=100&offset=0"),
            "2025-05-28",
            "checkins_events",
        ),
        (
            locations(),
            format!("{API}/check-ins/v2/events/620/locations?per_page=100&offset=0"),
            "2025-05-28",
            "checkins_locations",
        ),
        (
            periods(),
            format!(
                "{API}/check-ins/v2/events/620/event_periods?include=event_times&{window}&per_page=100&offset=0"
            ),
            "2025-05-28",
            "checkins_event_periods",
        ),
        (
            counts(),
            format!(
                "{API}/check-ins/v2/event_times/630/location_event_times?include=location&per_page=100&offset=0"
            ),
            "2025-05-28",
            "checkins_location_counts",
        ),
        (
            signups(),
            format!("{API}/registrations/v2/signups?filter=unarchived&per_page=100&offset=0"),
            "2025-05-01",
            "registrations_signups",
        ),
        (
            attendees(),
            format!(
                "{API}/registrations/v2/signups/640/attendees?filter=active&fields[Attendee]=active,canceled,waitlisted&per_page=100&offset=0"
            ),
            "2025-05-01",
            "registrations_attendees",
        ),
    ] {
        assert_eq!(request.url(), url, "{label}");
        assert_eq!(request.collection.product().version(), version, "{label}");
        assert_eq!(request.collection.label(), label);
        // Never on the stdin protocol, whatever the request names.
        assert!(!request.collection.protocol(), "{label}");
    }
}

#[test]
fn only_the_granted_product_is_ever_read() {
    use crate::oauth::Scopes;
    let services = Scopes::Services;
    let operations = Scopes::ServicesAndOperations;
    let check_ins = Scopes::Services.with_check_ins(true);
    let registrations = Scopes::Services.with_registrations(true);
    for (product, granted) in [
        (Product::Services, [true, true, true, true]),
        (Product::People, [false, true, false, false]),
        (Product::Calendar, [false, true, false, false]),
        (Product::Groups, [false, true, false, false]),
        (Product::CheckIns, [false, false, true, false]),
        (Product::Registrations, [false, false, false, true]),
    ] {
        assert_eq!(
            [services, operations, check_ins, registrations].map(|s| product.granted(s)),
            granted,
            "{product:?}"
        );
    }
    // Forms are People: they come with the existing People opt-in, never with Check-Ins.
    assert_eq!(Collection::PeopleForms.product(), Product::People);
    assert_eq!(Collection::PeopleFormSubmissions.product(), Product::People);
}

#[test]
fn church_targets_require_exactly_their_own_id_and_window() {
    let ok = |collection: Collection, target: Target| at(collection, target).is_ok();
    // Each needs its own id, numeric, and nothing else.
    for (collection, own) in [
        (
            Collection::PeopleFormSubmissions,
            Target::form("610").within(&window()),
        ),
        (Collection::CheckInsLocations, Target::checkins_event("620")),
        (
            Collection::CheckInsEventPeriods,
            Target::checkins_event("620").within(&window()),
        ),
        (
            Collection::CheckInsLocationCounts,
            Target::checkins_event_time("630"),
        ),
        (Collection::RegistrationsAttendees, Target::signup("640")),
    ] {
        assert!(ok(collection, own.clone()), "{collection:?}");
        let mut none = own.clone();
        none.form_id = None;
        none.checkins_event_id = None;
        none.checkins_event_time_id = None;
        none.signup_id = None;
        assert!(!ok(collection, none), "{collection:?} without its id");
        for extra in [
            Target::person("50"),
            Target::workflow("795"),
            Target::people_person("50"),
            Target::form("611"),
            Target::checkins_event("621"),
            Target::checkins_event_time("631"),
            Target::signup("641"),
        ] {
            let mut both = own.clone();
            both.person_id = both.person_id.or(extra.person_id);
            both.workflow_id = both.workflow_id.or(extra.workflow_id);
            both.people_person_id = both.people_person_id.or(extra.people_person_id);
            both.form_id = both.form_id.or(extra.form_id);
            both.checkins_event_id = both.checkins_event_id.or(extra.checkins_event_id);
            both.checkins_event_time_id =
                both.checkins_event_time_id.or(extra.checkins_event_time_id);
            both.signup_id = both.signup_id.or(extra.signup_id);
            if both != own {
                assert!(!ok(collection, both), "{collection:?} with another id");
            }
        }
    }
    for bad in ["", "0610", "61a", "610/../1", "6 10"] {
        assert!(!ok(
            Collection::CheckInsLocations,
            Target::checkins_event(bad)
        ));
        assert!(!ok(Collection::RegistrationsAttendees, Target::signup(bad)));
        assert!(!ok(
            Collection::PeopleFormSubmissions,
            Target::form(bad).within(&window())
        ));
    }
    // The recent reads need a valid window; every other church read refuses one.
    assert!(!ok(Collection::PeopleFormSubmissions, Target::form("610")));
    assert!(!ok(
        Collection::CheckInsEventPeriods,
        Target::checkins_event("620")
    ));
    let backwards = Window {
        starts_at: W1.into(),
        ends_at: W0.into(),
    };
    assert!(!ok(
        Collection::CheckInsEventPeriods,
        Target::checkins_event("620").within(&backwards)
    ));
    for collection in [
        Collection::PeopleForms,
        Collection::CheckInsEvents,
        Collection::RegistrationsSignups,
    ] {
        assert!(ok(collection, Target::default()));
        assert!(!ok(collection, Target::default().within(&window())));
        assert!(!ok(collection, Target::form("610")));
    }
    assert!(!ok(
        Collection::CheckInsLocations,
        Target::checkins_event("620").within(&window())
    ));
    assert!(!ok(
        Collection::RegistrationsAttendees,
        Target::signup("640").within(&window())
    ));
}

#[test]
fn the_stdin_protocol_cannot_name_a_church_collection_or_id() {
    for collection in [
        "people_forms",
        "people_form_submissions",
        "checkins_events",
        "checkins_locations",
        "checkins_event_periods",
        "checkins_location_counts",
        "registrations_signups",
        "registrations_attendees",
    ] {
        let text = format!(
            r#"{{"version":1,"workspace":"fictional-workspace","organization":"1001","client_id":"fictional-client","service_type_id":"10","plan_id":"20","collection":"{collection}","per_page":100,"offset":0}}"#
        );
        assert_eq!(
            parse_request(text.as_bytes()).err(),
            Some(SourceError::InvalidRequest),
            "{collection}"
        );
    }
    for field in [
        "form_id",
        "checkins_event_id",
        "checkins_event_time_id",
        "signup_id",
    ] {
        let text = format!(
            r#"{{"version":1,"workspace":"fictional-workspace","organization":"1001","client_id":"fictional-client","service_type_id":"10","plan_id":"20","collection":"needed_positions","per_page":100,"offset":0,"{field}":"610"}}"#
        );
        assert_eq!(
            parse_request(text.as_bytes()).err(),
            Some(SourceError::InvalidRequest),
            "{field}"
        );
    }
}

#[test]
fn forms_keep_whether_they_are_archived_and_their_names_as_local_labels_only() {
    let raw = json!({"data":[
        {"id":"610","type":"Form","attributes":{"name":"Volunteer interest","active":true,"archived":false,
            "description":"note-canary","public_url":"https://example.invalid/secret-canary","submission_count":12,"login_required":false},
         "relationships":{"campus":{"data":{"id":"1","type":"Campus"}}}},
        {"id":"611","type":"Form","attributes":{"name":"Prayer\nrequests","archived":false}}
    ],"meta":{"count":2,"total_count":2}});
    let body = project(&forms(), raw.clone()).unwrap();
    clean(&body);
    assert_eq!(
        body["data"],
        json!([
            {"id":"610","type":"Form","attributes":{"active":true,"archived":false}},
            {"id":"611","type":"Form","attributes":{"archived":false}}
        ])
    );
    assert!(!body.to_string().contains("Volunteer interest"));
    assert_eq!(
        labels(&forms(), raw),
        BTreeMap::from([
            ("form:610".to_string(), "Volunteer interest".to_string()),
            ("form:611".to_string(), "Prayer requests".to_string()),
        ])
    );
    // An archived form is never read as one to watch, even if the filter was ignored.
    invalid(
        &forms(),
        json!({"data":[{"id":"612","type":"Form","attributes":{"name":"Old","archived":true}}]}),
    );
    invalid(
        &forms(),
        json!({"data":[{"id":"612","type":"Form","attributes":{"archived":"no"}}]}),
    );
    invalid(
        &forms(),
        json!({"data":[{"id":"612","type":"Event","attributes":{}}]}),
    );
}

fn submission(id: &str, created_at: &str, form: Value, person: &str) -> Value {
    json!({"id":id,"type":"FormSubmission",
        "attributes":{"created_at":created_at,"updated_at":created_at,"verified":true,"requires_verification":false,
            "selected_options_by_field":{"1":"care-canary"}},
        "relationships":{"form":form,"person":{"data":{"id":person,"type":"Person"}},
            "form_submission_values":{"data":[{"id":"9","type":"FormSubmissionValue"}]},
            "form_fields":{"data":[{"id":"8","type":"FormField"}]}}})
}
fn form_link(id: &str) -> Value {
    json!({"data":{"id":id,"type":"Form"}})
}

#[test]
fn submissions_keep_when_and_who_submitted_and_never_an_answer() {
    let raw = json!({
        "data":[submission("700","2026-11-22T15:00:00Z",form_link("610"),"50")],
        "included":[
            {"id":"50","type":"Person","attributes":{"name":"Avery Fictional","child":false,"first_name":"first-name-canary",
                "avatar":"photo-canary","birthdate":"2001-01-01"},"relationships":{"emails":{"data":[]}}},
            {"id":"9","type":"FormSubmissionValue","attributes":{"value":"care-canary","display_value":"note-canary"}},
            {"id":"8","type":"FormField","attributes":{"label":"secret-canary"}}
        ],
        "meta":{"count":1,"total_count":1,"parent":{"id":"610","type":"Form"}}});
    let body = project(&submissions(), raw).unwrap();
    clean(&body);
    assert_eq!(
        body["data"],
        json!([{"id":"700","type":"FormSubmission","attributes":{"created_at":"2026-11-22T15:00:00Z"},
            "relationships":{"form":{"data":{"id":"610","type":"Form"}},"person":{"data":{"id":"50","type":"Person"}}}}])
    );
    // Who it's for: the display name only, and only for someone Planning Center says isn't a
    // child, with that `child: false` kept as the proof (the check moves the name into `names`
    // and keeps the proof). Answers and fields are other types, dropped unread.
    assert_eq!(
        body["included"],
        json!([{"id":"50","type":"Person","attributes":{"child":false,"name":"Avery Fictional"}}])
    );
}

/// A form that allows submitting for household members can name a child as the submission's
/// person. A child's name is never kept: only `child: false` keeps a name.
#[test]
fn a_submission_for_a_child_or_for_someone_not_said_to_be_an_adult_keeps_no_name() {
    let page = |person: Value| json!({"data":[submission("700","2026-11-22T15:00:00Z",form_link("610"),"51")],"included":[person]});
    for (attributes, kept) in [
        (
            json!({"name":"Kid Fictional-Child","child":true,"grade":2}),
            json!({}),
        ),
        (json!({"name":"Kid Fictional-Child"}), json!({})),
        (
            json!({"name":"Kid Fictional-Child","child":null}),
            json!({}),
        ),
        (
            json!({"name":"Kid Fictional-Child","child":"false"}),
            json!({}),
        ),
        (json!({"name":"Kid Fictional-Child","child":0}), json!({})),
        (json!({"child":false}), json!({"child":false})),
        (
            json!({"name":"Avery Fictional","child":false}),
            json!({"child":false,"name":"Avery Fictional"}),
        ),
    ] {
        let raw = page(json!({"id":"51","type":"Person","attributes":attributes}));
        let body = project(&submissions(), raw).unwrap();
        assert_eq!(body["included"][0]["attributes"], kept, "{attributes}");
        if kept.get("name").is_none() {
            assert!(
                !body.to_string().contains("Kid Fictional-Child"),
                "{attributes}"
            );
        }
    }
    // The sparse fieldset asks for `name` and `child` only; anything else that comes back is
    // trimmed, never kept.
    let raw = page(
        json!({"id":"51","type":"Person","attributes":{"name":"Avery Fictional","child":false,"birthdate":"care-canary","grade":"note-canary"}}),
    );
    let body = project(&submissions(), raw).unwrap();
    clean(&body);
}

#[test]
fn a_submission_of_another_form_or_outside_the_window_is_refused_whole() {
    let page = |row: Value| json!({"data":[row]});
    // The window's start is inside, its end is not.
    assert!(
        project(
            &submissions(),
            page(submission("700", W0, form_link("610"), "50"))
        )
        .is_ok()
    );
    for row in [
        submission("700", W1, form_link("610"), "50"),
        submission("700", "2026-11-21T09:59:59Z", form_link("610"), "50"),
        submission("700", "2026-11-22T15:00:00Z", form_link("611"), "50"),
        submission("700", "2026-11-22T15:00:00Z", json!({"data":null}), "50"),
        json!({"id":"700","type":"FormSubmission","attributes":{"created_at":"2026-11-22T15:00:00Z"}}),
        json!({"id":"700","type":"FormSubmission","attributes":{},"relationships":{"form":form_link("610")}}),
    ] {
        invalid(&submissions(), page(row));
    }
}

#[test]
fn checkins_events_keep_their_names_as_labels_and_never_an_archived_one() {
    let raw = json!({"data":[{"id":"620","type":"Event","attributes":{"name":"Sunday Kids","archived_at":null,
        "frequency":"Weekly","integration_key":"secret-canary","app_source":"note-canary"}}]});
    let body = project(&checkins_events(), raw.clone()).unwrap();
    clean(&body);
    assert_eq!(
        body["data"],
        json!([{"id":"620","type":"Event","attributes":{"archived_at":null}}])
    );
    assert_eq!(
        labels(&checkins_events(), raw),
        BTreeMap::from([("checkins_event:620".to_string(), "Sunday Kids".to_string())])
    );
    invalid(
        &checkins_events(),
        json!({"data":[{"id":"620","type":"Event","attributes":{"name":"Old","archived_at":"2026-01-01T00:00:00Z"}}]}),
    );
}

/// Planning Center's published Location example: `parent` is its only rendered relationship.
fn location(id: &str, kind: &str, parent: Value) -> Value {
    json!({"id":id,"type":"Location","attributes":{"name":"Nursery","kind":kind,"age_min_in_months":0,"age_max_in_months":24,
        "gender":"care-canary","questions":"note-canary","attendees_per_volunteer":4,"min_volunteers":2,"max_occupancy":12},
        "relationships":{"parent":parent},"links":{"self":"https://example.invalid/secret-canary"}})
}

#[test]
fn checkins_locations_keep_their_kind_and_name_as_a_label_and_are_tied_to_their_event_by_the_request()
 {
    let raw = json!({"data":[location("650","Location",json!({"data":null})),
            location("651","Location",json!({"data":{"type":"Parent","id":"655"}}))],
        "meta":{"count":2,"total_count":2,"parent":{"id":"620","type":"Event"}}});
    let body = project(&locations(), raw.clone()).unwrap();
    clean(&body);
    // No link is kept: the room's event is the one the request named, which `meta.parent` confirms.
    assert_eq!(
        body["data"],
        json!([{"id":"650","type":"Location","attributes":{"kind":"Location"}},
               {"id":"651","type":"Location","attributes":{"kind":"Location"}}])
    );
    assert!(!body.to_string().contains("age_"));
    assert_eq!(
        labels(&locations(), raw)["checkins_location:650"],
        "Nursery".to_string()
    );
    // A page saying it's another event's rooms is refused whole; so is a kind that isn't a code.
    invalid(
        &locations(),
        json!({"data":[location("650","Location",json!({"data":null}))],"meta":{"parent":{"id":"621","type":"Event"}}}),
    );
    invalid(
        &locations(),
        json!({"data":[location("650","Folder room",json!({"data":null}))]}),
    );
}

/// Planning Center's published EventPeriod example renders `event` only.
fn period(id: &str, starts_at: &str, ends_at: &str, event: &str) -> Value {
    json!({"id":id,"type":"EventPeriod","attributes":{"starts_at":starts_at,"ends_at":ends_at,"note":"note-canary",
        "regular_count":20,"guest_count":2,"volunteer_count":4},
        "relationships":{"event":{"data":{"id":event,"type":"Event"}}}})
}
/// Planning Center's published EventTime example renders `event` and `event_period`.
fn event_time(id: &str, starts_at: &str, event: &str, period: &str) -> Value {
    json!({"id":id,"type":"EventTime","attributes":{"starts_at":starts_at,"name":"name-canary","regular_count":9,
        "guest_count":1,"volunteer_count":2,"total_count":12,"hour":9,"minute":0,"day_of_week":0,"hides_at":"2026-11-22T17:00:00Z"},
        "relationships":{"event":{"data":{"id":event,"type":"Event"}},"event_period":{"data":{"id":period,"type":"EventPeriod"}}}})
}

#[test]
fn checkins_periods_keep_their_interval_and_their_times_start_and_period_only() {
    let raw = json!({
        "data":[period("660","2026-11-22T05:00:00Z","2026-11-23T05:00:00Z","620")],
        "included":[event_time("630","2026-11-22T14:00:00Z","620","660"),event_time("631","2026-11-22T16:00:00Z","620","660"),
            {"id":"620","type":"Event","attributes":{"name":"name-canary"}}],
        "meta":{"count":1,"total_count":1,"parent":{"id":"620","type":"Event"}}});
    let body = project(&periods(), raw).unwrap();
    clean(&body);
    assert_eq!(
        body["data"],
        json!([{"id":"660","type":"EventPeriod","attributes":{"starts_at":"2026-11-22T05:00:00Z","ends_at":"2026-11-23T05:00:00Z"},
            "relationships":{"event":{"data":{"id":"620","type":"Event"}}}}])
    );
    let time = |id: &str, at: &str| {
        json!({"id":id,"type":"EventTime","attributes":{"starts_at":at},
        "relationships":{"event":{"data":{"id":"620","type":"Event"}},"event_period":{"data":{"id":"660","type":"EventPeriod"}}}})
    };
    assert_eq!(
        body["included"],
        json!([
            time("630", "2026-11-22T14:00:00Z"),
            time("631", "2026-11-22T16:00:00Z")
        ])
    );
    // No period or event-time total survives (the page's own `meta` counts are its paging).
    for rows in [&body["data"], &body["included"]] {
        assert!(!rows.to_string().contains("count"), "{rows}");
    }
    // A period of another event, one outside the window, or a time of another event is refused.
    let page = |row: Value| json!({"data":[row]});
    invalid(
        &periods(),
        page(period(
            "660",
            "2026-11-22T05:00:00Z",
            "2026-11-23T05:00:00Z",
            "621",
        )),
    );
    invalid(
        &periods(),
        page(period(
            "660",
            "2026-11-14T05:00:00Z",
            "2026-11-21T10:00:00Z",
            "620",
        )),
    );
    invalid(
        &periods(),
        json!({"data":[period("660","2026-11-22T05:00:00Z","2026-11-23T05:00:00Z","620")],
            "included":[event_time("630","2026-11-22T14:00:00Z","621","660")]}),
    );
    invalid(
        &periods(),
        json!({"data":[period("660","2026-11-22T05:00:00Z","2026-11-23T05:00:00Z","620")],
            "included":[{"id":"630","type":"EventTime","attributes":{"name":"9:00"}}]}),
    );
}

fn count_row(id: &str, relationships: Value, regular: Value) -> Value {
    json!({"id":id,"type":"LocationEventTime","attributes":{"regular_count":regular,"guest_count":1,"volunteer_count":1,
        "created_at":"2026-11-22T14:01:00Z","updated_at":"2026-11-22T15:00:00Z"},"relationships":relationships})
}
fn room(id: &str) -> Value {
    json!({"location":{"data":{"id":id,"type":"Location"}}})
}

#[test]
fn room_counts_keep_the_three_counts_and_their_room_and_nothing_about_anyone() {
    // With `include=location`, the row names its room (JSON:API full linkage); the included
    // Location rows are dropped unread, and the count's event time is the one the request named.
    let raw = json!({"data":[count_row("670",room("650"),json!(8))],
        "included":[{"id":"650","type":"Location","attributes":{"name":"Nursery","gender":"care-canary"}},
            {"id":"1","type":"CheckIn","attributes":{"first_name":"first-name-canary","last_name":"name-canary"}}],
        "meta":{"count":1,"total_count":1,"parent":{"id":"630","type":"EventTime"}}});
    let body = project(&counts(), raw).unwrap();
    clean(&body);
    assert_eq!(
        body,
        json!({"data":[{"id":"670","type":"LocationEventTime","attributes":{"regular_count":8,"guest_count":1,"volunteer_count":1},
            "relationships":{"location":{"data":{"id":"650","type":"Location"}}}}],
            "meta":{"count":1,"total_count":1}})
    );
    // Planning Center's published example renders `"relationships":{}`. Without the room a count
    // can't be placed, so such a page is refused whole (fail closed) until a live read shows the
    // link is rendered with the include.
    let page = |row: Value| json!({"data":[row]});
    invalid(&counts(), page(count_row("670", json!({}), json!(8))));
    for row in [
        count_row("670", json!({"location":{"data":null}}), json!(8)),
        count_row("670", room("650"), json!(-1)),
        count_row("670", room("650"), json!("8")),
        count_row("670", room("650"), json!(1.5)),
        json!({"id":"670","type":"LocationEventTime","attributes":{"regular_count":8,"guest_count":1},"relationships":room("650")}),
    ] {
        invalid(&counts(), page(row));
    }
    // Another event time's page is refused by its `meta.parent`, or by a row's own `event_time`
    // link when Planning Center renders one; one naming the requested time is kept.
    invalid(
        &counts(),
        json!({"data":[count_row("670",room("650"),json!(8))],"meta":{"parent":{"id":"631","type":"EventTime"}}}),
    );
    let both = |time: &str| json!({"location":{"data":{"id":"650","type":"Location"}},"event_time":{"data":{"id":time,"type":"EventTime"}}});
    invalid(&counts(), page(count_row("670", both("999"), json!(8))));
    let kept = project(&counts(), page(count_row("670", both("630"), json!(8)))).unwrap();
    assert_eq!(
        kept["data"][0]["relationships"]["event_time"],
        json!({"data":{"id":"630","type":"EventTime"}})
    );
}

fn signup(id: &str, closed: Value, max: Value, archived: Value) -> Value {
    json!({"id":id,"type":"Signup","attributes":{"name":"Fall retreat","archived":archived,"closed":closed,"open":true,
        "open_at":"2026-10-01T12:00:00Z","close_at":"2026-11-20T23:00:00Z","maximum_capacity":max,
        "description":"note-canary","logo_url":"https://example.invalid/photo-canary","new_registration_url":"https://example.invalid/secret-canary"},
        "relationships":{"campuses":{"data":[]},"next_signup_time":{"data":{"id":"5","type":"SignupTime"}}}})
}

#[test]
fn signups_keep_when_registration_opens_and_closes_and_the_overall_limit() {
    let raw = json!({"data":[signup("640",json!(false),json!(40),json!(false)),signup("641",json!(true),json!(null),json!(false))]});
    let body = project(&signups(), raw.clone()).unwrap();
    clean(&body);
    assert_eq!(
        body["data"][0],
        json!({"id":"640","type":"Signup","attributes":{"archived":false,"closed":false,"open_at":"2026-10-01T12:00:00Z",
            "close_at":"2026-11-20T23:00:00Z","maximum_capacity":40}})
    );
    assert_eq!(
        body["data"][1]["attributes"]["maximum_capacity"],
        Value::Null
    );
    assert_eq!(labels(&signups(), raw)["signup:640"], "Fall retreat");
    let page = |row: Value| json!({"data":[row]});
    invalid(
        &signups(),
        page(signup("640", json!(false), json!(40), json!(true))),
    );
    invalid(
        &signups(),
        page(signup("640", json!(false), json!("40"), json!(false))),
    );
    invalid(
        &signups(),
        page(signup("640", json!("no"), json!(40), json!(false))),
    );
}

fn attendee(id: &str, active: Value, canceled: Value, waitlisted: Value) -> Value {
    json!({"id":id,"type":"Attendee","attributes":{"active":active,"canceled":canceled,"waitlisted":waitlisted,
        "waitlisted_at":null,"created_at":"2026-11-02T12:00:00Z","name":"name-canary","complete":true},
        "relationships":{"person":{"data":{"id":"50","type":"Person"}},"registration":{"data":{"id":"6","type":"Registration"}},
            "emergency_contact":{"data":{"id":"7","type":"EmergencyContact"}},"selection_type":{"data":{"id":"8","type":"SelectionType"}}}})
}

#[test]
fn attendees_are_counted_only_when_active_and_keep_nothing_about_who_they_are() {
    let raw = json!({"data":[attendee("680",json!(true),json!(false),json!(false))],
        "included":[{"id":"50","type":"Person","attributes":{"name":"name-canary"}}],
        "meta":{"count":1,"total_count":1,"parent":{"id":"640","type":"Signup"}}});
    let body = project(&attendees(), raw).unwrap();
    clean(&body);
    assert_eq!(
        body["data"],
        json!([{"id":"680","type":"Attendee","attributes":{"active":true,"canceled":false,"waitlisted":false}}])
    );
    // No person, registration, contact or option link, and no included row, is kept.
    assert!(body.get("included").is_none());
    assert!(!body.to_string().contains("Person"));
    let page = |row: Value| json!({"data":[row]});
    for row in [
        attendee("680", json!(false), json!(false), json!(false)),
        attendee("680", json!(true), json!(true), json!(false)),
        attendee("680", json!(true), json!(false), json!(true)),
        json!({"id":"680","type":"Attendee","attributes":{"canceled":false}}),
    ] {
        invalid(&attendees(), page(row));
    }
}

#[test]
fn church_meta_parent_must_name_the_requested_form_event_time_signup_or_organization() {
    let empty = |kind: &str, id: &str| json!({"data":[],"meta":{"parent":{"id":id,"type":kind}}});
    for (request, kind, id) in [
        (forms(), "Organization", "1001"),
        (checkins_events(), "Organization", "1001"),
        (signups(), "Organization", "1001"),
        (submissions(), "Form", "610"),
        (locations(), "Event", "620"),
        (periods(), "Event", "620"),
        (counts(), "EventTime", "630"),
        (attendees(), "Signup", "640"),
    ] {
        assert!(project(&request, empty(kind, id)).is_ok(), "{kind}");
        assert_eq!(
            project(&request, empty(kind, "999")).err(),
            Some(SourceError::InvalidResponse),
            "{kind}"
        );
        assert_eq!(
            project(&request, empty("Person", id)).err(),
            Some(SourceError::InvalidResponse),
            "{kind}"
        );
    }
}

#[test]
fn church_next_links_repeat_the_fixed_query_and_window_with_only_paging_changed() {
    let next = |request: &SourceRequest, link: String| {
        project(
            request,
            json!({"data":[],"meta":{"next":{"offset":100}},"links":{"next":link}}),
        )
    };
    let path = |request: &SourceRequest| request.url().split('?').next().unwrap().to_owned();
    for request in [
        forms(),
        submissions(),
        checkins_events(),
        periods(),
        signups(),
        attendees(),
    ] {
        let good = request.url().replace("offset=0", "offset=100");
        assert!(next(&request, good.clone()).is_ok(), "{good}");
        // Dropping the fixed query (a filter, include or window) is refused.
        assert_eq!(
            next(
                &request,
                format!("{}?per_page=100&offset=100", path(&request))
            )
            .err(),
            Some(SourceError::InvalidResponse),
            "{good}"
        );
    }
    // Another form's, or a filter Planning Center widened, is refused.
    let other = submissions()
        .url()
        .replace("/610/", "/611/")
        .replace("offset=0", "offset=100");
    assert!(next(&submissions(), other).is_err());
    let widened = attendees()
        .url()
        .replace("filter=active", "filter=waitlist")
        .replace("offset=0", "offset=100");
    assert!(next(&attendees(), widened).is_err());
}

#[test]
fn church_labels_are_bounded_single_line_display_text() {
    let long = format!("Retreat\u{202E} for {}", "x".repeat(300));
    let raw =
        json!({"data":[{"id":"640","type":"Signup","attributes":{"name":long,"closed":false}}]});
    let label = &labels(&signups(), raw)["signup:640"];
    assert_eq!(label.chars().count(), LABEL_CHARS);
    assert!(label.ends_with('…'));
    assert!(!label.contains('\u{202E}'));
}
