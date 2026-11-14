//! Sunday capture projections. Fictional payloads only; canaries must never survive.
use super::*;
use crate::oauth::Binding;

const CANARIES: [&str; 8] = [
    "care-canary",
    "contact-canary@example.invalid",
    "secret-canary",
    "name-canary",
    "first-name-canary",
    "photo-canary",
    "phone-canary",
    "Organization",
];

fn binding() -> Binding {
    Binding {
        workspace: "local:1001".into(),
        organization: "1001".into(),
        client_id: "fictional-client".into(),
    }
}
fn request(collection: Collection, team: Option<&str>, person: Option<&str>) -> SourceRequest {
    SourceRequest::capture(&binding(), "10", "20", collection, team, person, 100, 0).unwrap()
}
fn team(collection: Collection) -> SourceRequest {
    request(collection, Some("70"), None)
}
fn person(collection: Collection) -> SourceRequest {
    request(collection, None, Some("50"))
}
fn project(request: &SourceRequest, raw: Value) -> Result<Value, SourceError> {
    project_page(
        request,
        &serde_json::to_vec(&raw).unwrap(),
        &Default::default(),
    )
    .map(|page| page.envelope()["body"].clone())
}
fn clean(body: &Value) {
    let wire = body.to_string();
    for canary in CANARIES {
        assert!(!wire.contains(canary), "{canary} survived: {wire}");
    }
}

#[test]
fn capture_urls_are_exact_get_paths_with_only_the_contract_fixed_query() {
    let base = "https://api.planningcenteronline.com/services/v2";
    for (request, url) in [
        (
            request(Collection::Plan, None, None),
            format!("{base}/service_types/10/plans/20"),
        ),
        (
            request(Collection::PlanTimes, None, None),
            format!("{base}/service_types/10/plans/20/plan_times?per_page=100&offset=0"),
        ),
        (
            request(Collection::NeededPositions, None, None),
            format!("{base}/service_types/10/plans/20/needed_positions?per_page=100&offset=0"),
        ),
        (
            request(Collection::TeamMembers, None, None),
            format!(
                "{base}/service_types/10/plans/20/team_members?include=person&per_page=100&offset=0"
            ),
        ),
        (
            team(Collection::TeamPositionAssignments),
            format!(
                "{base}/teams/70/person_team_position_assignments?include=person,team_position&per_page=100&offset=0"
            ),
        ),
        (
            team(Collection::TeamLeaders),
            format!("{base}/teams/70/team_leaders?include=people&per_page=100&offset=0"),
        ),
        (
            person(Collection::PersonSchedules),
            format!(
                "{base}/people/50/schedules?filter=all&include=plan_times&per_page=100&offset=0"
            ),
        ),
        (
            person(Collection::PersonSchedulesUnfiltered),
            format!("{base}/people/50/schedules?include=plan_times&per_page=100&offset=0"),
        ),
        (
            person(Collection::PersonBlockouts),
            format!("{base}/people/50/blockouts?per_page=100&offset=0"),
        ),
    ] {
        assert_eq!(request.url(), url);
    }
    assert_eq!(
        Collection::PersonSchedulesUnfiltered.label(),
        "person_schedules"
    );
    assert_eq!(
        Collection::TeamPositionAssignments.label(),
        "team_position_assignments"
    );
}

#[test]
fn team_and_person_ids_are_required_exactly_for_their_collections() {
    let b = binding();
    let make = |c, t: Option<&str>, p: Option<&str>, offset| {
        SourceRequest::capture(&b, "10", "20", c, t, p, 100, offset).err()
    };
    let invalid = Some(SourceError::InvalidRequest);
    for c in [Collection::TeamPositionAssignments, Collection::TeamLeaders] {
        assert_eq!(make(c, None, None, 0), invalid);
        assert_eq!(make(c, Some("70"), Some("50"), 0), invalid);
        assert_eq!(make(c, None, Some("50"), 0), invalid);
        assert_eq!(make(c, Some("70"), None, 0), None);
    }
    for c in [
        Collection::PersonSchedules,
        Collection::PersonSchedulesUnfiltered,
        Collection::PersonBlockouts,
    ] {
        assert_eq!(make(c, None, None, 0), invalid);
        assert_eq!(make(c, Some("70"), None, 0), invalid);
        assert_eq!(make(c, Some("70"), Some("50"), 0), invalid);
        assert_eq!(make(c, None, Some("50"), 0), None);
    }
    for c in [
        Collection::Plan,
        Collection::PlanTimes,
        Collection::NeededPositions,
        Collection::TeamMembers,
    ] {
        assert_eq!(make(c, Some("70"), None, 0), invalid);
        assert_eq!(make(c, None, Some("50"), 0), invalid);
        assert_eq!(make(c, None, None, 0), None);
    }
    for bad in ["", "070", "7/../1", "70?include=emails", "-1", "1.5"] {
        assert_eq!(
            make(Collection::TeamLeaders, Some(bad), None, 0),
            invalid,
            "{bad}"
        );
        assert_eq!(
            make(Collection::PersonBlockouts, None, Some(bad), 0),
            invalid,
            "{bad}"
        );
    }
    // A single object has no pages.
    assert_eq!(make(Collection::Plan, None, None, 100), invalid);
}

#[test]
fn stdin_protocol_cannot_reach_capture_collections_ids_or_includes() {
    const REQUEST: &str = r#"{"version":1,"workspace":"fictional-workspace","organization":"1001","client_id":"fictional-client","service_type_id":"10","plan_id":"20","collection":"team_members","per_page":100,"offset":0}"#;
    for collection in [
        "plan",
        "team_position_assignments",
        "team_leaders",
        "person_schedules",
        "person_schedules_unfiltered",
        "person_blockouts",
    ] {
        let text = REQUEST.replace("team_members", collection);
        assert_eq!(
            parse_request(text.as_bytes()).err(),
            Some(SourceError::InvalidRequest),
            "{collection}"
        );
        let text = text.replace("\"offset\":0", "\"offset\":0,\"team_id\":\"70\"");
        assert_eq!(
            parse_request(text.as_bytes()).err(),
            Some(SourceError::InvalidRequest)
        );
    }
    for extra in [
        r#""team_id":"70""#,
        r#""person_id":"50""#,
        r#""profile":"capture""#,
    ] {
        let text = REQUEST.replace("\"offset\":0", &format!("\"offset\":0,{extra}"));
        assert_eq!(
            parse_request(text.as_bytes()).err(),
            Some(SourceError::InvalidRequest),
            "{extra}"
        );
    }
    // Protocol team_members keeps its original closed URL and schema.
    let legacy = parse_request(REQUEST.as_bytes()).unwrap();
    assert_eq!(
        legacy.url(),
        "https://api.planningcenteronline.com/services/v2/service_types/10/plans/20/team_members?per_page=100&offset=0"
    );
    let body = project(
        &legacy,
        json!({"data":[{"id":"40","type":"PlanPerson","attributes":{"status":"C","team_position_name":"Drums","name":"name-canary"},"relationships":{"person":{"data":{"id":"50","type":"Person"}}}}],"included":[{"id":"50","type":"Person","attributes":{"full_name":"name-canary"}}]}),
    )
    .unwrap();
    assert_eq!(
        body,
        json!({"data":[{"id":"40","type":"PlanPerson","attributes":{"status":"C"},"relationships":{"person":{"data":{"id":"50","type":"Person"}}}}]})
    );
}

#[test]
fn the_organization_is_one_get_of_the_services_root_keeping_only_its_time_zone() {
    let org = request(Collection::Organization, None, None);
    // The product root itself, with no query: not paginated, nothing else asked.
    assert_eq!(
        org.url(),
        "https://api.planningcenteronline.com/services/v2"
    );
    assert_eq!(org.collection.label(), "organization");
    assert_eq!(org.collection.product(), Product::Services);
    assert_eq!(
        SourceRequest::capture(
            &binding(),
            "10",
            "20",
            Collection::Organization,
            None,
            None,
            100,
            100
        )
        .err(),
        Some(SourceError::InvalidRequest)
    );
    assert_eq!(
        SourceRequest::capture(
            &binding(),
            "10",
            "20",
            Collection::Organization,
            Some("70"),
            None,
            100,
            0
        )
        .err(),
        Some(SourceError::InvalidRequest)
    );
    // Never on the stdin protocol.
    let text = r#"{"version":1,"workspace":"fictional-workspace","organization":"1001","client_id":"fictional-client","service_type_id":"10","plan_id":"20","collection":"organization","per_page":100,"offset":0}"#;
    assert_eq!(
        parse_request(text.as_bytes()).err(),
        Some(SourceError::InvalidRequest)
    );
    let body = project(
        &org,
        json!({"data":{"id":"1001","type":"Organization","attributes":{"time_zone":"America/New_York","name":"name-canary","owner_name":"first-name-canary","secret":"secret-canary","ccli":"care-canary","date_format":1,"twenty_four_hour_time":false},
            "relationships":{},"links":{"self":"https://api.planningcenteronline.com/services/v2","people":"secret-canary"}},"included":[],"meta":{"can_include":["secret-canary"]}}),
    )
    .unwrap();
    assert_eq!(
        body,
        json!({"data":{"id":"1001","type":"Organization","attributes":{"time_zone":"America/New_York"}},"meta":{}})
    );
    let wire = body.to_string();
    for canary in [
        "name-canary",
        "first-name-canary",
        "secret-canary",
        "care-canary",
    ] {
        assert!(!wire.contains(canary), "{canary}");
    }
    // Canonicalizable and nested IANA names keep their shape; an absent or null zone is kept as such.
    for zone in [
        json!("Asia/Kolkata"),
        json!("Etc/GMT+5"),
        json!("America/Argentina/Buenos_Aires"),
        json!("UTC"),
        Value::Null,
    ] {
        let raw =
            json!({"data":{"id":"1001","type":"Organization","attributes":{"time_zone":zone}}});
        assert_eq!(
            project(&org, raw).unwrap()["data"]["attributes"]["time_zone"],
            zone
        );
    }
    let ok =
        |zone: &str| json!({"id":"1001","type":"Organization","attributes":{"time_zone":zone}});
    for raw in [
        // Another organization's settings, or several.
        json!({"data":{"id":"1002","type":"Organization","attributes":{"time_zone":"America/New_York"}}}),
        json!({"data":[ok("America/New_York")]}),
        // Free text where a zone name belongs.
        json!({"data":ok("Eastern Time (US & Canada)")}),
        json!({"data":ok("America/New York")}),
        json!({"data":ok("../etc")}),
        json!({"data":ok(&format!("America/{}", "x".repeat(60)))}),
        json!({"data":{"id":"1001","type":"Organization","attributes":{"time_zone":5}}}),
        json!({"data":{"id":"1001","type":"Plan","attributes":{"time_zone":"UTC"}}}),
        json!({"data":ok("UTC"),"meta":{"parent":{"id":"1002","type":"Organization"}}}),
    ] {
        assert_eq!(
            project(&org, raw.clone()).err(),
            Some(SourceError::InvalidResponse),
            "{raw}"
        );
    }
    assert!(
        zone_name("Asia/Kathmandu")
            && !zone_name("")
            && !zone_name("/Foo")
            && !zone_name("Foo/")
            && !zone_name("EST")
    );
}

#[test]
fn plan_is_a_single_minimized_object_under_its_service_type() {
    let plan = request(Collection::Plan, None, None);
    let body = project(
        &plan,
        json!({"data":{"id":"20","type":"Plan","attributes":{"dates":"November 15, 2026","sort_date":"2026-11-15T09:00:00Z","title":"Fictional Sunday","series_title":null,"plan_notes_count":2,"public":true,"notes":"care-canary"},"relationships":{"service_type":{"data":{"id":"10","type":"ServiceType"}},"created_by":{"data":{"id":"99","type":"Person"}}},"links":{"self":"secret-canary"}},"included":[],"meta":{"parent":{"id":"10","type":"ServiceType"},"can_include":["secret-canary"]}}),
    )
    .unwrap();
    assert_eq!(
        body,
        json!({"data":{"id":"20","type":"Plan","attributes":{"dates":"November 15, 2026","sort_date":"2026-11-15T09:00:00Z","title":"Fictional Sunday","series_title":null}},"meta":{}})
    );
    clean(&body);
    let ok = json!({"id":"20","type":"Plan","attributes":{"sort_date":"2026-11-15T09:00:00Z"}});
    for raw in [
        json!({"data":[ok]}),
        json!({"data":{"id":"20","type":"Plan","attributes":{"title":"Fictional Sunday"}}}),
        json!({"data":{"id":"20","type":"Plan","attributes":{"sort_date":"next Sunday"}}}),
        json!({"data":{"id":"20","type":"Plan","attributes":{"sort_date":"2026-11-15T09:00:00Z","title":7}}}),
        json!({"data":{"id":"20","type":"PlanTime","attributes":{"sort_date":"2026-11-15T09:00:00Z"}}}),
        json!({"data":ok,"meta":{"parent":{"id":"20","type":"Plan"}}}),
        json!({"data":ok,"meta":{"parent":{"id":"11","type":"ServiceType"}}}),
        json!({"data":ok,"meta":{"next":{"offset":100}},"links":{"next":"https://api.planningcenteronline.com/services/v2/service_types/10/plans/20?per_page=100&offset=100"}}),
        json!({"data":ok,"links":{"next":"https://api.planningcenteronline.com/services/v2/service_types/10/plans/20?per_page=100&offset=100"}}),
    ] {
        assert_eq!(
            project(&plan, raw.clone()).err(),
            Some(SourceError::InvalidResponse),
            "{raw}"
        );
    }
}

#[test]
fn capture_needed_positions_and_plan_times_keep_contract_facts_only() {
    let body = project(
        &request(Collection::NeededPositions, None, None),
        json!({"data":[{"id":"30","type":"NeededPosition","attributes":{"quantity":2,"team_position_name":"Drums","scheduled_to":"care-canary"},"relationships":{"team":{"data":{"id":"70","type":"Team"}},"time":{"data":{"id":"60","type":"PlanTime"}},"plan":{"data":{"id":"20","type":"Plan"}}}}],"included":[{"id":"70","type":"Team","attributes":{"name":"care-canary"}}],"meta":{"count":1,"total_count":1,"parent":{"id":"20","type":"Plan"}}}),
    )
    .unwrap();
    assert_eq!(
        body,
        json!({"data":[{"id":"30","type":"NeededPosition","attributes":{"quantity":2,"team_position_name":"Drums"},"relationships":{"team":{"data":{"id":"70","type":"Team"}},"time":{"data":{"id":"60","type":"PlanTime"}}}}],"meta":{"count":1,"total_count":1}})
    );
    clean(&body);
    let body = project(
        &request(Collection::PlanTimes, None, None),
        json!({"data":[{"id":"60","type":"PlanTime","attributes":{"starts_at":"2026-11-15T09:00:00Z","ends_at":"2026-11-15T10:15:00Z","time_type":"service","name":"care-canary","team_reminders":["secret-canary"]},"relationships":{"assigned_teams":{"data":[{"id":"70","type":"Team"}]}}}]}),
    )
    .unwrap();
    assert_eq!(
        body,
        json!({"data":[{"id":"60","type":"PlanTime","attributes":{"starts_at":"2026-11-15T09:00:00Z","ends_at":"2026-11-15T10:15:00Z","time_type":"service"}}]})
    );
    clean(&body);
}

#[test]
fn capture_team_members_keep_position_and_notification_facts_and_only_person_names() {
    let body = project(
        &request(Collection::TeamMembers, None, None),
        json!({"data":[{"id":"40","type":"PlanPerson","attributes":{"status":"U","team_position_name":"Drums","notification_sent_at":"2026-11-10T12:00:00Z","notification_prepared_at":null,"prepare_notification":false,"name":"name-canary","decline_reason":"care-canary","photo_thumbnail":"photo-canary","notes":"care-canary"},"relationships":{"person":{"data":{"id":"50","type":"Person"}},"team":{"data":{"id":"70","type":"Team"}},"times":{"data":[{"id":"60","type":"PlanTime"}]},"responds_to":{"data":{"id":"51","type":"Person"}}}}],
            "included":[
                {"id":"50","type":"Person","attributes":{"full_name":"Avery Fictional","first_name":"first-name-canary","photo_url":"photo-canary","notes":"care-canary","email":"contact-canary@example.invalid","phone":"phone-canary"},"relationships":{"emails":{"data":[{"id":"9","type":"Email"}]}},"links":{"self":"secret-canary"}},
                {"id":"9","type":"Organization","attributes":{"name":"care-canary"}}
            ],
            "meta":{"count":1,"total_count":1,"parent":{"id":"20","type":"Plan"}}}),
    )
    .unwrap();
    assert_eq!(
        body,
        json!({"data":[{"id":"40","type":"PlanPerson","attributes":{"status":"U","team_position_name":"Drums","notification_sent_at":"2026-11-10T12:00:00Z","notification_prepared_at":null,"prepare_notification":false},"relationships":{"person":{"data":{"id":"50","type":"Person"}},"team":{"data":{"id":"70","type":"Team"}},"times":{"data":[{"id":"60","type":"PlanTime"}]}}}],
            "included":[{"id":"50","type":"Person","attributes":{"name":"Avery Fictional"}}],
            "meta":{"count":1,"total_count":1}})
    );
    clean(&body);
}

#[test]
fn team_position_assignments_and_leaders_keep_links_and_included_names_only() {
    let body = project(
        &team(Collection::TeamPositionAssignments),
        json!({"data":[{"id":"80","type":"PersonTeamPositionAssignment","attributes":{"schedule_preference":"care-canary","preferred_weeks":["secret-canary"],"created_at":"2020-01-01T00:00:00Z"},"relationships":{"person":{"data":{"id":"50","type":"Person"}},"team_position":{"data":{"id":"90","type":"TeamPosition"}},"time_preference_options":{"data":[]}}}],
            "included":[
                {"id":"50","type":"Person","attributes":{"full_name":"Avery Fictional","email":"contact-canary@example.invalid"}},
                {"id":"90","type":"TeamPosition","attributes":{"name":"Drums","tags":["care-canary"]},"relationships":{"team":{"data":{"id":"70","type":"Team"}}}}
            ],
            "meta":{"count":1,"total_count":1,"parent":{"id":"70","type":"Team"}}}),
    )
    .unwrap();
    assert_eq!(
        body,
        json!({"data":[{"id":"80","type":"PersonTeamPositionAssignment","attributes":{},"relationships":{"person":{"data":{"id":"50","type":"Person"}},"team_position":{"data":{"id":"90","type":"TeamPosition"}}}}],
            "included":[{"id":"50","type":"Person","attributes":{"name":"Avery Fictional"}},{"id":"90","type":"TeamPosition","attributes":{"name":"Drums"}}],
            "meta":{"count":1,"total_count":1}})
    );
    clean(&body);
    let body = project(
        &team(Collection::TeamLeaders),
        json!({"data":[{"id":"85","type":"TeamLeader","attributes":{"send_responses_for_accepts":true,"send_responses_for_declines":"care-canary"},"relationships":{"people":{"data":{"id":"51","type":"Person"}},"team":{"data":{"id":"70","type":"Team"}}}}],
            "included":[{"id":"51","type":"Person","attributes":{"full_name":"Blair Fictional","phone":"phone-canary"}}],
            "meta":{"parent":{"id":"70","type":"Team"}}}),
    )
    .unwrap();
    assert_eq!(
        body,
        json!({"data":[{"id":"85","type":"TeamLeader","attributes":{},"relationships":{"people":{"data":{"id":"51","type":"Person"}},"team":{"data":{"id":"70","type":"Team"}}}}],
            "included":[{"id":"51","type":"Person","attributes":{"name":"Blair Fictional"}}],
            "meta":{}})
    );
    clean(&body);
}

#[test]
fn person_schedules_and_blockouts_drop_names_reasons_and_free_text() {
    for collection in [
        Collection::PersonSchedules,
        Collection::PersonSchedulesUnfiltered,
    ] {
        let body = project(
            &person(collection),
            json!({"data":[{"id":"95","type":"Schedule","attributes":{"status":"C","team_position_name":"Drums","sort_date":"2026-11-08T09:00:00Z","person_name":"name-canary","responds_to_name":"name-canary","decline_reason":"care-canary","organization_name":"care-canary","team_name":"care-canary","dates":"care-canary"},"relationships":{"plan":{"data":{"id":"21","type":"Plan"}},"team":{"data":{"id":"70","type":"Team"}},"times":{"data":[{"id":"61","type":"PlanTime"}]},"person":{"data":{"id":"50","type":"Person"}},"responds_to_person":{"data":{"id":"52","type":"Person"}}}}],
                "included":[{"id":"61","type":"PlanTime","attributes":{"starts_at":"2026-11-08T09:00:00Z","ends_at":"2026-11-08T10:00:00Z","time_type":"service","name":"care-canary"}}],
                "meta":{"count":1,"total_count":1,"parent":{"id":"50","type":"Person"}}}),
        )
        .unwrap();
        assert_eq!(
            body,
            json!({"data":[{"id":"95","type":"Schedule","attributes":{"status":"C","team_position_name":"Drums","sort_date":"2026-11-08T09:00:00Z"},"relationships":{"plan":{"data":{"id":"21","type":"Plan"}},"team":{"data":{"id":"70","type":"Team"}},"times":{"data":[{"id":"61","type":"PlanTime"}]}}}],
                "included":[{"id":"61","type":"PlanTime","attributes":{"starts_at":"2026-11-08T09:00:00Z","ends_at":"2026-11-08T10:00:00Z","time_type":"service"}}],
                "meta":{"count":1,"total_count":1}})
        );
        clean(&body);
    }
    let body = project(
        &person(Collection::PersonBlockouts),
        json!({"data":[{"id":"97","type":"Blockout","attributes":{"starts_at":"2026-11-15T05:00:00Z","ends_at":"2026-11-16T04:59:59Z","repeat_frequency":"no_repeat","description":"care-canary","reason":"care-canary","group_identifier":"secret-canary","settings":"secret-canary","organization_name":"care-canary"},"relationships":{"person":{"data":{"id":"50","type":"Person"}}}}],
            "included":[{"id":"50","type":"Person","attributes":{"full_name":"name-canary"}}],
            "meta":{"count":1,"total_count":1,"parent":{"id":"50","type":"Person"}}}),
    )
    .unwrap();
    assert_eq!(
        body,
        json!({"data":[{"id":"97","type":"Blockout","attributes":{"starts_at":"2026-11-15T05:00:00Z","ends_at":"2026-11-16T04:59:59Z","repeat_frequency":"no_repeat"}}],"meta":{"count":1,"total_count":1}})
    );
    clean(&body);
}

#[test]
fn malformed_required_facts_and_contradictions_reject_the_whole_page() {
    let cases = [
        // Person rows must carry a display name; null or missing names do not become blanks.
        (
            team(Collection::TeamPositionAssignments),
            json!({"data":[],"included":[{"id":"50","type":"Person","attributes":{"email":"contact-canary@example.invalid"}}]}),
        ),
        (
            team(Collection::TeamPositionAssignments),
            json!({"data":[],"included":[{"id":"50","type":"Person","attributes":{"full_name":null}}]}),
        ),
        (
            team(Collection::TeamPositionAssignments),
            json!({"data":[],"included":[{"id":"50","type":"Person","attributes":{"full_name":"Avery Fictional"}},{"id":"50","type":"Person","attributes":{"full_name":"name-canary"}}]}),
        ),
        (
            team(Collection::TeamPositionAssignments),
            json!({"data":[],"included":[{"id":"90","type":"TeamPosition","attributes":{}}]}),
        ),
        (
            team(Collection::TeamPositionAssignments),
            json!({"data":[],"included":{"id":"50","type":"Person"}}),
        ),
        (
            team(Collection::TeamPositionAssignments),
            json!({"data":[{"id":"80","type":"Schedule","attributes":{}}]}),
        ),
        (
            team(Collection::TeamLeaders),
            json!({"data":[{"id":"85","type":"TeamLeader","attributes":{},"relationships":{"people":{"data":{"id":"51","type":"secret-canary"}}}}]}),
        ),
        (
            person(Collection::PersonSchedules),
            json!({"data":[{"id":"95","type":"Schedule","attributes":{"sort_date":"2026-11-08T09:00:00Z"}}]}),
        ),
        (
            person(Collection::PersonSchedules),
            json!({"data":[{"id":"95","type":"Schedule","attributes":{"status":"C","sort_date":null}}]}),
        ),
        (
            person(Collection::PersonSchedules),
            json!({"data":[{"id":"95","type":"Schedule","attributes":{"status":"care-canary\n","sort_date":"2026-11-08T09:00:00Z"}}]}),
        ),
        (
            person(Collection::PersonSchedules),
            json!({"data":[],"included":[{"id":"61","type":"PlanTime","attributes":{"starts_at":"soon","ends_at":"2026-11-08T10:00:00Z"}}]}),
        ),
        (
            person(Collection::PersonBlockouts),
            json!({"data":[{"id":"97","type":"Blockout","attributes":{"starts_at":"2026-11-15","ends_at":"2026-11-16T04:59:59Z"}}]}),
        ),
        (
            person(Collection::PersonBlockouts),
            json!({"data":[{"id":"97","type":"Blockout","attributes":{"starts_at":"2026-11-15T05:00:00Z","ends_at":"2026-11-16T04:59:59Z","repeat_frequency":"care-canary"}}]}),
        ),
        (
            request(Collection::TeamMembers, None, None),
            json!({"data":[{"id":"40","type":"PlanPerson","attributes":{"status":"C","team_position_name":["secret-canary"]}}]}),
        ),
    ];
    for (request, raw) in cases {
        assert_eq!(
            project(&request, raw.clone()).err(),
            Some(SourceError::InvalidResponse),
            "{raw}"
        );
    }
}

#[test]
fn meta_parent_must_name_this_reads_own_plan_team_or_person() {
    for (request, wrong) in [
        (
            request(Collection::TeamMembers, None, None),
            [
                json!({"id":"21","type":"Plan"}),
                json!({"id":"20","type":"Team"}),
            ],
        ),
        (
            team(Collection::TeamPositionAssignments),
            [
                json!({"id":"71","type":"Team"}),
                json!({"id":"20","type":"Plan"}),
            ],
        ),
        (
            team(Collection::TeamLeaders),
            [
                json!({"id":"71","type":"Team"}),
                json!({"id":"70","type":"Person"}),
            ],
        ),
        (
            person(Collection::PersonSchedules),
            [
                json!({"id":"51","type":"Person"}),
                json!({"id":"50","type":"Team"}),
            ],
        ),
        (
            person(Collection::PersonBlockouts),
            [
                json!({"id":"51","type":"Person"}),
                json!({"id":"1001","type":"Organization"}),
            ],
        ),
    ] {
        let (kind, id) = request.parent();
        assert!(
            project(
                &request,
                json!({"data":[],"meta":{"parent":{"id":id,"type":kind}}})
            )
            .is_ok()
        );
        for parent in wrong {
            assert_eq!(
                project(&request, json!({"data":[],"meta":{"parent":parent}})).err(),
                Some(SourceError::InvalidResponse),
                "{parent}"
            );
        }
    }
}

#[test]
fn next_links_must_repeat_the_exact_fixed_query_with_only_paging_changed() {
    let base = "https://api.planningcenteronline.com/services/v2";
    let page = |next: &str| json!({"data":[],"meta":{"next":{"offset":100}},"links":{"next":next}});
    let members = request(Collection::TeamMembers, None, None);
    let assignments = team(Collection::TeamPositionAssignments);
    let schedules = person(Collection::PersonSchedules);
    let unfiltered = person(Collection::PersonSchedulesUnfiltered);
    let blockouts = person(Collection::PersonBlockouts);
    let plan = format!("{base}/service_types/10/plans/20");
    for (request, next) in [
        (
            &members,
            format!("{plan}/team_members?include=person&offset=100&per_page=100"),
        ),
        (
            &members,
            format!("{plan}/team_members?include=person&per_page=100&offset=100"),
        ),
        (
            &members,
            format!("{plan}/team_members?per_page=100&offset=100&include=person"),
        ),
        (
            &assignments,
            format!(
                "{base}/teams/70/person_team_position_assignments?include=person,team_position&offset=100&per_page=100"
            ),
        ),
        (
            &assignments,
            format!(
                "{base}/teams/70/person_team_position_assignments?include=person%2Cteam_position&offset=100&per_page=100"
            ),
        ),
        (
            &schedules,
            format!(
                "{base}/people/50/schedules?filter=all&include=plan_times&offset=100&per_page=100"
            ),
        ),
        (
            &unfiltered,
            format!("{base}/people/50/schedules?include=plan_times&offset=100&per_page=100"),
        ),
        (
            &blockouts,
            format!("{base}/people/50/blockouts?offset=100&per_page=100"),
        ),
    ] {
        let body = project(request, page(&next)).unwrap();
        assert_eq!(body["links"]["next"], json!(next));
    }
    for (request, next) in [
        (
            &members,
            format!("{plan}/team_members?offset=100&per_page=100"),
        ),
        (
            &members,
            format!("{plan}/team_members?include=person,emails&offset=100&per_page=100"),
        ),
        (
            &members,
            format!("{plan}/team_members?include=person&include=person&offset=100&per_page=100"),
        ),
        (
            &members,
            format!("{plan}/team_members?include=person&offset=100&per_page=25"),
        ),
        (
            &members,
            format!("{plan}/team_members?include=person&offset=100&per_page=100&filter=all"),
        ),
        (
            &members,
            format!("{plan}/team_members?include=%70erson&offset=100&per_page=100"),
        ),
        (
            &members,
            format!("{plan}/team_members?include=person&offset=100&per_page=100&"),
        ),
        (
            &members,
            format!("{plan}/team_members?include=person&offset=100&per_page=100#secret-canary"),
        ),
        (
            &assignments,
            format!(
                "{base}/teams/70/person_team_position_assignments?include=team_position,person&offset=100&per_page=100"
            ),
        ),
        (
            &assignments,
            format!(
                "{base}/teams/71/person_team_position_assignments?include=person,team_position&offset=100&per_page=100"
            ),
        ),
        (
            &schedules,
            format!("{base}/people/50/schedules?include=plan_times&offset=100&per_page=100"),
        ),
        (
            &unfiltered,
            format!(
                "{base}/people/50/schedules?filter=all&include=plan_times&offset=100&per_page=100"
            ),
        ),
        (
            &blockouts,
            format!("{base}/people/51/blockouts?offset=100&per_page=100"),
        ),
        (
            &blockouts,
            format!("{base}/people/50/blockouts?offset=99&per_page=100"),
        ),
        (
            &blockouts,
            "https://evil.invalid/services/v2/people/50/blockouts?offset=100&per_page=100"
                .to_string(),
        ),
    ] {
        assert_eq!(
            project(request, page(&next)).err(),
            Some(SourceError::InvalidResponse),
            "{next}"
        );
    }
}

#[test]
fn capture_reads_distinguish_rate_limits_and_refusals_while_the_protocol_keeps_two_outcomes() {
    const REQUEST: &str = r#"{"version":1,"workspace":"fictional-workspace","organization":"1001","client_id":"fictional-client","service_type_id":"10","plan_id":"20","collection":"team_members","per_page":100,"offset":0}"#;
    let capture = person(Collection::PersonSchedules);
    let protocol = parse_request(REQUEST.as_bytes()).unwrap();
    for (status, retry, expected) in [
        (200, None, None),
        (401, None, Some(SourceError::Denied)),
        (403, None, Some(SourceError::Denied)),
        (429, Some("7"), Some(SourceError::RateLimited(Some(7)))),
        (429, None, Some(SourceError::RateLimited(None))),
        (
            429,
            Some("Wed, 21 Oct 2026 07:28:00 GMT"),
            Some(SourceError::RateLimited(None)),
        ),
        (429, Some("+7"), Some(SourceError::RateLimited(None))),
        (429, Some("999999"), Some(SourceError::RateLimited(None))),
        (400, None, Some(SourceError::Rejected)),
        (422, None, Some(SourceError::Rejected)),
        (404, None, Some(SourceError::ProviderFailure)),
        (500, None, Some(SourceError::ProviderFailure)),
        (503, Some("7"), Some(SourceError::ProviderFailure)),
    ] {
        assert_eq!(status_error(&capture, status, retry), expected, "{status}");
    }
    // The stdin protocol's closed vocabulary (and the TypeScript codec reading it) is unchanged.
    for status in [400, 422, 429, 500] {
        assert_eq!(
            status_error(&protocol, status, Some("7")),
            Some(SourceError::ProviderFailure)
        );
    }
    assert_eq!(
        SourceError::RateLimited(Some(7)).envelope(),
        json!({"version":1,"ok":false,"code":"provider-failure","reason":"rate-limited"})
    );
    assert_eq!(
        SourceError::Rejected.envelope(),
        json!({"version":1,"ok":false,"code":"provider-failure","reason":"rejected"})
    );
}
