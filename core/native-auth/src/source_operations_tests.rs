//! v2 operations reads (Calendar, People workflows, Groups). Fictional payloads only;
//! canaries must never survive, and nothing here carries a person's name.
use super::*;
use crate::oauth::Binding;

const CANARIES: [&str; 9] = [
    "care-canary",
    "contact-canary@example.invalid",
    "secret-canary",
    "name-canary",
    "first-name-canary",
    "photo-canary",
    "phone-canary",
    "note-canary",
    "Organization",
];
const W0: &str = "2026-11-21T10:00:00Z";
const W1: &str = "2026-11-23T12:00:00Z";

fn binding() -> Binding {
    Binding {
        workspace: "local:1001".into(),
        organization: "1001".into(),
        client_id: "fictional-client".into(),
    }
}
fn window() -> Window {
    Window {
        starts_at: W0.into(),
        ends_at: W1.into(),
    }
}
fn at(collection: Collection, target: Target) -> Result<SourceRequest, SourceError> {
    SourceRequest::capture_at(&binding(), "10", "20", collection, &target, 100, 0)
}
fn org(collection: Collection) -> SourceRequest {
    at(collection, Target::default()).unwrap()
}
fn bookings() -> SourceRequest {
    at(
        Collection::CalendarResourceBookings,
        Target::default().within(&window()),
    )
    .unwrap()
}
fn workflow(collection: Collection) -> SourceRequest {
    at(collection, Target::workflow("795")).unwrap()
}
fn conflicts() -> SourceRequest {
    at(Collection::CalendarEventConflicts, Target::event("231")).unwrap()
}
fn memberships() -> SourceRequest {
    at(
        Collection::GroupsPersonMemberships,
        Target::groups_person("50"),
    )
    .unwrap()
}
fn events() -> SourceRequest {
    at(
        Collection::GroupsGroupEvents,
        Target::group("287").within(&window()),
    )
    .unwrap()
}
fn project(request: &SourceRequest, raw: Value) -> Result<Value, SourceError> {
    project_page(
        request,
        &serde_json::to_vec(&raw).unwrap(),
        &Default::default(),
    )
    .map(|page| page.envelope()["body"].clone())
}
/// The page's local labels (never part of the envelope).
fn labels(request: &SourceRequest, raw: Value) -> BTreeMap<String, String> {
    project_page(
        request,
        &serde_json::to_vec(&raw).unwrap(),
        &Default::default(),
    )
    .unwrap()
    .labels()
    .clone()
}
fn clean(body: &Value) {
    let wire = body.to_string();
    for canary in CANARIES {
        assert!(!wire.contains(canary), "{canary} survived: {wire}");
    }
}

#[test]
fn operations_urls_are_exact_get_paths_with_pinned_versions_and_fixed_queries() {
    let api = "https://api.planningcenteronline.com";
    let window = format!("where[ends_at][gt]={W0}&where[starts_at][lt]={W1}&order=starts_at");
    for (request, url, version, label) in [
        (
            org(Collection::CalendarRooms),
            format!("{api}/calendar/v2/resources?filter=rooms&per_page=100&offset=0"),
            "2022-07-07",
            "calendar_rooms",
        ),
        (
            bookings(),
            format!(
                "{api}/calendar/v2/resource_bookings?filter=rooms&include=event_resource_request&{window}&per_page=100&offset=0"
            ),
            "2022-07-07",
            "calendar_resource_bookings",
        ),
        (
            conflicts(),
            format!("{api}/calendar/v2/events/231/conflicts?per_page=100&offset=0"),
            "2022-07-07",
            "calendar_conflicts",
        ),
        (
            org(Collection::PeopleWorkflows),
            format!("{api}/people/v2/workflows?per_page=100&offset=0"),
            "2025-11-10",
            "people_workflows",
        ),
        (
            workflow(Collection::PeopleWorkflowSteps),
            format!("{api}/people/v2/workflows/795/steps?per_page=100&offset=0"),
            "2025-11-10",
            "people_workflow_steps",
        ),
        (
            workflow(Collection::PeopleWorkflowReadyCards),
            format!("{api}/people/v2/workflows/795/cards?where[stage]=ready&per_page=100&offset=0"),
            "2025-11-10",
            "people_workflow_ready_cards",
        ),
        (
            workflow(Collection::PeopleWorkflowSnoozedCards),
            format!(
                "{api}/people/v2/workflows/795/cards?where[stage]=snoozed&per_page=100&offset=0"
            ),
            "2025-11-10",
            "people_workflow_snoozed_cards",
        ),
        (
            memberships(),
            format!("{api}/groups/v2/people/50/memberships?per_page=100&offset=0"),
            "2023-07-10",
            "groups_person_memberships",
        ),
        (
            events(),
            format!("{api}/groups/v2/groups/287/events?{window}&per_page=100&offset=0"),
            "2023-07-10",
            "groups_group_events",
        ),
    ] {
        assert_eq!(request.url(), url);
        assert_eq!(request.collection.product().version(), version, "{label}");
        assert_eq!(request.collection.label(), label);
    }
    // Services keeps its original pin.
    assert_eq!(Collection::Plan.product().version(), VERSION);
    assert_eq!(VERSION, "2018-11-01");
}

#[test]
fn operations_targets_require_exactly_their_own_id_and_window() {
    let invalid = Some(SourceError::InvalidRequest);
    let w = window();
    let make = |c, t: Target| at(c, t).err();
    // Organization-wide reads take no id; windowed ones require the window.
    assert_eq!(make(Collection::CalendarRooms, Target::default()), None);
    assert_eq!(
        make(Collection::CalendarRooms, Target::default().within(&w)),
        invalid
    );
    assert_eq!(
        make(Collection::CalendarResourceBookings, Target::default()),
        invalid
    );
    assert_eq!(
        make(Collection::PeopleWorkflows, Target::workflow("795")),
        invalid
    );
    for c in [
        Collection::PeopleWorkflowSteps,
        Collection::PeopleWorkflowReadyCards,
        Collection::PeopleWorkflowSnoozedCards,
    ] {
        assert_eq!(make(c, Target::workflow("795")), None);
        assert_eq!(make(c, Target::default()), invalid);
        assert_eq!(make(c, Target::group("795")), invalid);
        assert_eq!(make(c, Target::workflow("795").within(&w)), invalid);
        // Services ids never stand in for operations ids.
        assert_eq!(make(c, Target::person("795")), invalid);
        assert_eq!(make(c, Target::team("795")), invalid);
    }
    assert_eq!(
        make(
            Collection::GroupsPersonMemberships,
            Target::groups_person("50")
        ),
        None
    );
    assert_eq!(
        make(Collection::GroupsPersonMemberships, Target::person("50")),
        invalid
    );
    let mut both = Target::groups_person("50");
    both.person_id = Some("50".into());
    assert_eq!(make(Collection::GroupsPersonMemberships, both), invalid);
    assert_eq!(
        make(Collection::GroupsGroupEvents, Target::group("287")),
        invalid
    );
    assert_eq!(
        make(
            Collection::GroupsGroupEvents,
            Target::group("287").within(&w)
        ),
        None
    );
    // Services collections refuse operations ids and windows.
    assert_eq!(
        make(Collection::PlanTimes, Target::workflow("795")),
        invalid
    );
    assert_eq!(
        make(Collection::PersonBlockouts, Target::groups_person("50")),
        invalid
    );
    assert_eq!(
        make(Collection::PlanTimes, Target::default().within(&w)),
        invalid
    );
    for bad in ["", "0795", "7/../1", "795?include=person", "-1", "1.5"] {
        assert_eq!(
            make(Collection::PeopleWorkflowSteps, Target::workflow(bad)),
            invalid,
            "{bad}"
        );
        assert_eq!(
            make(Collection::GroupsGroupEvents, Target::group(bad).within(&w)),
            invalid,
            "{bad}"
        );
        assert_eq!(
            make(
                Collection::GroupsPersonMemberships,
                Target::groups_person(bad)
            ),
            invalid,
            "{bad}"
        );
    }
    // Windows are canonical whole-second UTC instants, in order.
    for (starts_at, ends_at) in [
        (W1, W0),
        (W0, W0),
        ("2026-11-21T10:00:00.000Z", W1),
        ("2026-11-21T10:00:00+00:00", W1),
        ("2026-11-21", W1),
        (W0, "2026-11-23T12:00:00Z&filter=all"),
        ("", W1),
    ] {
        let w = Window {
            starts_at: starts_at.into(),
            ends_at: ends_at.into(),
        };
        assert_eq!(
            make(
                Collection::CalendarResourceBookings,
                Target::default().within(&w)
            ),
            invalid,
            "{starts_at} {ends_at}"
        );
    }
}

#[test]
fn stdin_protocol_cannot_reach_operations_collections_ids_or_windows() {
    const REQUEST: &str = r#"{"version":1,"workspace":"fictional-workspace","organization":"1001","client_id":"fictional-client","service_type_id":"10","plan_id":"20","collection":"needed_positions","per_page":100,"offset":0}"#;
    for collection in [
        "calendar_rooms",
        "calendar_resource_bookings",
        "people_workflows",
        "people_workflow_steps",
        "people_workflow_ready_cards",
        "people_workflow_snoozed_cards",
        "groups_person_memberships",
        "groups_group_events",
        "people_background_checks",
    ] {
        let text = REQUEST.replace("needed_positions", collection);
        assert_eq!(
            parse_request(text.as_bytes()).err(),
            Some(SourceError::InvalidRequest),
            "{collection}"
        );
    }
    for extra in [
        r#""workflow_id":"795""#,
        r#""group_id":"287""#,
        r#""groups_person_id":"50""#,
        r#""window":{"starts_at":"2026-11-21T10:00:00Z","ends_at":"2026-11-23T12:00:00Z"}"#,
    ] {
        let text = REQUEST.replace("\"offset\":0", &format!("\"offset\":0,{extra}"));
        assert_eq!(
            parse_request(text.as_bytes()).err(),
            Some(SourceError::InvalidRequest),
            "{extra}"
        );
    }
}

#[test]
fn rooms_keep_kind_in_the_body_and_their_name_as_a_local_label_only() {
    let raw = json!({"data":[{"id":"887","type":"Resource","attributes":{"kind":"Room","name":"Sanctuary (fictional)","description":"care-canary","home_location":"care-canary","image":"photo-canary","path_name":"secret-canary","serial_number":"secret-canary","quantity":1,"created_at":"2026-10-23T21:12:23Z"},"relationships":{"resource_folder":{"data":{"id":"9","type":"ResourceFolder"}}},"links":{"self":"secret-canary"}}],
        "included":[{"id":"9","type":"ResourceFolder","attributes":{"name":"care-canary"}}],
        "links":{"self":"secret-canary"},
        "meta":{"count":1,"total_count":1,"can_include":["secret-canary"],"parent":{"id":"1001","type":"Organization"}}});
    let body = project(&org(Collection::CalendarRooms), raw.clone()).unwrap();
    assert_eq!(
        body,
        json!({"data":[{"id":"887","type":"Resource","attributes":{"kind":"Room"}}],"meta":{"count":1,"total_count":1},"links":{}})
    );
    clean(&body);
    assert!(!body.to_string().contains("Sanctuary"));
    assert_eq!(
        labels(&org(Collection::CalendarRooms), raw),
        BTreeMap::from([("room:887".to_string(), "Sanctuary (fictional)".to_string())])
    );
}

/// One staged-shape booking: approved request, real UTC interval, event and instance links.
fn booking(id: &str, starts_at: &str, ends_at: &str, event: Value, request: &str) -> Value {
    json!({"id":id,"type":"ResourceBooking",
        "attributes":{"starts_at":starts_at,"ends_at":ends_at,"quantity":1,"created_at":"2026-10-23T21:13:58Z","updated_at":"2026-10-23T21:13:58Z"},
        "relationships":{"event":{"data":event},"event_instance":{"data":{"id":format!("{id}1"),"type":"EventInstance"}},
            "resource":{"data":{"id":"887","type":"Resource"}},
            "event_resource_request":{"data":{"id":request,"type":"EventResourceRequest"}}},
        "links":{"self":"secret-canary"}})
}
fn request_row(id: &str, status: &str, event: &str) -> Value {
    json!({"id":id,"type":"EventResourceRequest",
        "attributes":{"approval_status":status,"approval_sent":true,"notes":"note-canary","quantity":1,"visible_on_kiosks":false,"created_at":"2026-10-23T21:13:58Z"},
        "relationships":{"event":{"data":{"id":event,"type":"Event"}},"resource":{"data":{"id":"887","type":"Resource"}},
            "created_by":{"data":{"id":"180","type":"Person"}},"room_setup":{"data":null}}})
}

#[test]
fn bookings_keep_interval_event_links_and_request_approval_only() {
    let raw = json!({
        "data":[
            booking("391", "2026-11-22T14:00:00Z", "2026-11-22T16:00:00Z", json!({"id":"231","type":"Event"}), "372"),
            // Redacted event (Calendar 2026-06-22 note, applies to every version): a stub type.
            booking("392", "2026-11-23T01:00:00Z", "2026-11-23T01:30:00Z", json!({"id":"232","type":"BookedEvent"}), "373"),
        ],
        "included":[
            request_row("372", "A", "231"),
            request_row("373", "P", "232"),
            {"id":"180","type":"Person","attributes":{"first_name":"first-name-canary","name":"name-canary","email":"contact-canary@example.invalid"}},
            {"id":"231","type":"Event","attributes":{"name":"name-canary","summary":"care-canary"}},
            {"id":"887","type":"Resource","attributes":{"kind":"Room","name":"care-canary"}}
        ],
        "meta":{"count":2,"total_count":2,"parent":{"id":"1001","type":"Organization"}}
    });
    let body = project(&bookings(), raw).unwrap();
    let kept = |id: &str, starts_at: &str, ends_at: &str, event: Value, request: &str| {
        json!({"id":id,"type":"ResourceBooking","attributes":{"starts_at":starts_at,"ends_at":ends_at,"quantity":1},
            "relationships":{"event":{"data":event},"event_instance":{"data":{"id":format!("{id}1"),"type":"EventInstance"}},
                "resource":{"data":{"id":"887","type":"Resource"}},
                "event_resource_request":{"data":{"id":request,"type":"EventResourceRequest"}}}})
    };
    assert_eq!(
        body,
        json!({"data":[
                kept("391", "2026-11-22T14:00:00Z", "2026-11-22T16:00:00Z", json!({"id":"231","type":"Event"}), "372"),
                kept("392", "2026-11-23T01:00:00Z", "2026-11-23T01:30:00Z", json!({"id":"232","type":"BookedEvent"}), "373"),
            ],
            "included":[
                {"id":"372","type":"EventResourceRequest","attributes":{"approval_status":"A"},
                 "relationships":{"event":{"data":{"id":"231","type":"Event"}},"resource":{"data":{"id":"887","type":"Resource"}}}},
                {"id":"373","type":"EventResourceRequest","attributes":{"approval_status":"P"},
                 "relationships":{"event":{"data":{"id":"232","type":"Event"}},"resource":{"data":{"id":"887","type":"Resource"}}}}
            ],
            "meta":{"count":2,"total_count":2}})
    );
    clean(&body);
    // A booking without the request link, and a request whose event is a redacted stub, still project.
    let mut row = booking(
        "393",
        "2026-11-22T15:45:00Z",
        "2026-11-22T16:15:00Z",
        json!({"id":"233","type":"Event"}),
        "374",
    );
    row["relationships"]
        .as_object_mut()
        .unwrap()
        .remove("event_resource_request");
    let mut stub = request_row("374", "R", "233");
    stub["relationships"]["event"]["data"]["type"] = json!("BookedEvent");
    let body = project(&bookings(), json!({"data":[row],"included":[stub]})).unwrap();
    assert!(
        body["data"][0]["relationships"]
            .get("event_resource_request")
            .is_none()
    );
    assert_eq!(
        body["included"][0]["relationships"]["event"]["data"]["type"],
        "BookedEvent"
    );
    assert_eq!(
        body["included"][0]["attributes"],
        json!({"approval_status":"R"})
    );
}

/// One Conflict row in the 2022-07-07 OpenAPI shape (identical in 2026-06-22 and 2026-10-19).
fn conflict(id: &str, resolved_at: Value, winner: Value) -> Value {
    json!({"id":id,"type":"Conflict",
        "attributes":{"created_at":"2026-11-01T12:00:00Z","note":"care-canary","resolved_at":resolved_at,"updated_at":"2026-11-02T12:00:00Z"},
        "relationships":{"resource":{"data":{"id":"887","type":"Resource"}},"winner":{"data":winner},
            "resolved_by":{"data":{"id":"180","type":"Person"}}},
        "links":{"self":"secret-canary"}})
}
#[test]
fn conflicts_keep_resolved_state_resource_and_winner_only() {
    let raw = json!({"data":[
            conflict("701", Value::Null, Value::Null),
            conflict("702", json!("2026-11-03T15:00:00Z"), json!({"id":"231","type":"Event"})),
            // Calendar 2026-06-22 (every version): an event the user cannot see is a stub.
            conflict("703", json!("2026-11-03T15:00:00Z"), json!({"id":"232","type":"BookedEvent"})),
        ],
        "included":[{"id":"180","type":"Person","attributes":{"name":"name-canary"}}],
        "meta":{"count":3,"total_count":3,"parent":{"id":"231","type":"Event"}}});
    let body = project(&conflicts(), raw).unwrap();
    let kept = |id: &str, resolved_at: Value, winner: Value| {
        json!({"id":id,"type":"Conflict","attributes":{"resolved_at":resolved_at},
            "relationships":{"resource":{"data":{"id":"887","type":"Resource"}},"winner":{"data":winner}}})
    };
    assert_eq!(
        body,
        json!({"data":[
                kept("701", Value::Null, Value::Null),
                kept("702", json!("2026-11-03T15:00:00Z"), json!({"id":"231","type":"Event"})),
                kept("703", json!("2026-11-03T15:00:00Z"), json!({"id":"232","type":"BookedEvent"})),
            ],
            "meta":{"count":3,"total_count":3}})
    );
    clean(&body);
    // `resolved_at` and `winner` may be absent entirely (unresolved).
    let bare = json!({"data":[{"id":"704","type":"Conflict","attributes":{},"relationships":{"resource":{"data":{"id":"887","type":"Resource"}}}}]});
    assert_eq!(
        project(&conflicts(), bare).unwrap(),
        json!({"data":[{"id":"704","type":"Conflict","attributes":{},"relationships":{"resource":{"data":{"id":"887","type":"Resource"}}}}]})
    );
    let mut no_resource = conflict("705", Value::Null, Value::Null);
    no_resource["relationships"]
        .as_object_mut()
        .unwrap()
        .remove("resource");
    let mut null_resource = conflict("705", Value::Null, Value::Null);
    null_resource["relationships"]["resource"]["data"] = Value::Null;
    let mut room_as_event = conflict("705", Value::Null, Value::Null);
    room_as_event["relationships"]["resource"]["data"]["type"] = json!("Event");
    for raw in [
        json!({ "data": [no_resource] }),
        json!({ "data": [null_resource] }),
        json!({ "data": [room_as_event] }),
        json!({"data":[conflict("705", json!("yesterday"), Value::Null)]}),
        json!({"data":[conflict("705", Value::Null, json!({"id":"180","type":"Person"}))]}),
        json!({"data":[conflict("705", Value::Null, Value::Null)],"meta":{"parent":{"id":"232","type":"Event"}}}),
        json!({"data":[conflict("705", Value::Null, Value::Null)],"meta":{"parent":{"id":"1001","type":"Organization"}}}),
        json!({"data":[{"id":"705","type":"ResourceBooking","attributes":{}}]}),
    ] {
        assert_eq!(
            project(&conflicts(), raw.clone()).err(),
            Some(SourceError::InvalidResponse),
            "{raw}"
        );
    }
    // Next links stay on this event's conflicts, paging only.
    let api = "https://api.planningcenteronline.com";
    let page = |next: &str| json!({"data":[],"meta":{"next":{"offset":100}},"links":{"next":next}});
    let mine = format!("{api}/calendar/v2/events/231/conflicts?offset=100&per_page=100");
    assert!(project(&conflicts(), page(&mine)).is_ok());
    for next in [
        format!("{api}/calendar/v2/events/232/conflicts?offset=100&per_page=100"),
        format!("{api}/calendar/v2/conflicts?offset=100&per_page=100"),
        format!("{api}/calendar/v2/events/231/conflicts?filter=unresolved&offset=100&per_page=100"),
        format!(
            "{api}/calendar/v2/events/231/conflicts?include=resolved_by&offset=100&per_page=100"
        ),
    ] {
        assert_eq!(
            project(&conflicts(), page(&next)).err(),
            Some(SourceError::InvalidResponse),
            "{next}"
        );
    }
    // Exactly an event id, never another scope, a window, or the stdin protocol.
    let invalid = Some(SourceError::InvalidRequest);
    let make = |t: Target| at(Collection::CalendarEventConflicts, t).err();
    assert_eq!(make(Target::default()), invalid);
    assert_eq!(make(Target::event("231").within(&window())), invalid);
    assert_eq!(make(Target::person("231")), invalid);
    assert_eq!(make(Target::group("231")), invalid);
    for bad in ["", "0231", "231/../1", "231?include=resolved_by"] {
        assert_eq!(make(Target::event(bad)), invalid, "{bad}");
    }
    for c in [Collection::CalendarRooms, Collection::GroupsGroupEvents] {
        let mut target = target_for(c);
        target.event_id = Some("231".into());
        assert_eq!(at(c, target).err(), invalid);
    }
    const REQUEST: &str = r#"{"version":1,"workspace":"fictional-workspace","organization":"1001","client_id":"fictional-client","service_type_id":"10","plan_id":"20","collection":"calendar_event_conflicts","per_page":100,"offset":0}"#;
    assert_eq!(parse_request(REQUEST.as_bytes()).err(), invalid);
    assert_eq!(
        parse_request(
            REQUEST
                .replace(r#""offset":0"#, r#""offset":0,"event_id":"231""#)
                .as_bytes()
        )
        .err(),
        invalid
    );
}
#[test]
fn workflows_steps_and_cards_keep_lifecycle_assignment_due_and_snooze_only() {
    let raw = json!({"data":[{"id":"795","type":"Workflow","attributes":{"name":"New guest follow-up (fictional)","total_cards_count":3,"total_overdue_card_count":1,"my_ready_card_count":0,"encrypted_workflow_incoming_automations_param":"secret-canary","archived_at":null},"relationships":{"campus":{"data":{"id":"5","type":"Campus"}},"workflow_category":{"data":null}}}],
        "included":[],
        "meta":{"count":1,"total_count":1,"parent":{"id":"1001","type":"Organization"}}});
    let body = project(&org(Collection::PeopleWorkflows), raw.clone()).unwrap();
    assert_eq!(
        body,
        json!({"data":[{"id":"795","type":"Workflow","attributes":{}}],"meta":{"count":1,"total_count":1}})
    );
    clean(&body);
    assert_eq!(
        labels(&org(Collection::PeopleWorkflows), raw),
        BTreeMap::from([(
            "workflow:795".to_string(),
            "New guest follow-up (fictional)".to_string()
        )])
    );
    let raw = json!({"data":[{"id":"2211","type":"WorkflowStep","attributes":{"name":"Welcome","sequence":0,"expected_response_time_in_days":3,"description":"care-canary","default_assignee_id":"180","action_type":"assign","encrypted_trigger_resource":"secret-canary"},"relationships":{"default_assignee":{"data":{"id":"180","type":"Person"}},"workflow":{"data":{"id":"795","type":"Workflow"}}}}],
        "included":[{"id":"180","type":"Person","attributes":{"name":"name-canary"}}],
        "meta":{"count":1,"total_count":1,"parent":{"id":"795","type":"Workflow"}}});
    let body = project(&workflow(Collection::PeopleWorkflowSteps), raw.clone()).unwrap();
    assert_eq!(
        body,
        json!({"data":[{"id":"2211","type":"WorkflowStep","attributes":{"sequence":0,"expected_response_time_in_days":3},"relationships":{"workflow":{"data":{"id":"795","type":"Workflow"}}}}],"meta":{"count":1,"total_count":1}})
    );
    clean(&body);
    assert_eq!(
        labels(&workflow(Collection::PeopleWorkflowSteps), raw),
        BTreeMap::from([("step:2211".to_string(), "Welcome".to_string())])
    );
    // The three staged cards: unassigned and due, owned control, snoozed control.
    let card = |id: &str, stage: &str, due: &str, snooze: Value, assignee: Value| {
        json!({"id":id,"type":"WorkflowCard",
            "attributes":{"stage":stage,"calculated_due_at":due,"overdue":false,"snooze_until":snooze,"completed_at":null,"removed_at":null,
                "created_at":"2026-10-23T21:27:40Z","moved_to_step_at":"2026-10-23T21:27:40Z","calculated_due_at_in_days_ago":-3,"flagged_for_notification_at":null,"sticky_assignment":false},
            "relationships":{"assignee":{"data":assignee},"current_step":{"data":{"id":"2211","type":"WorkflowStep"}},
                "person":{"data":{"id":"202","type":"Person"}},"workflow":{"data":{"id":"795","type":"Workflow"}}}})
    };
    let kept = |id: &str, stage: &str, due: &str, snooze: Value, assignee: Value| {
        json!({"id":id,"type":"WorkflowCard",
            "attributes":{"stage":stage,"calculated_due_at":due,"overdue":false,"snooze_until":snooze,"completed_at":null,"removed_at":null},
            "relationships":{"assignee":{"data":assignee},"current_step":{"data":{"id":"2211","type":"WorkflowStep"}},
                "workflow":{"data":{"id":"795","type":"Workflow"}}}})
    };
    let owner = json!({"id":"180","type":"Assignee"});
    let body = project(
        &workflow(Collection::PeopleWorkflowReadyCards),
        json!({"data":[
                card("562", "ready", "2026-10-26T21:27:40Z", Value::Null, Value::Null),
                card("561", "ready", "2026-10-26T21:20:43Z", Value::Null, owner.clone()),
            ],
            "included":[{"id":"180","type":"Person","attributes":{"name":"name-canary","first_name":"first-name-canary"}}],
            "meta":{"count":2,"total_count":2,"parent":{"id":"795","type":"Workflow"}}}),
    )
    .unwrap();
    assert_eq!(
        body,
        json!({"data":[
                kept("562", "ready", "2026-10-26T21:27:40Z", Value::Null, Value::Null),
                kept("561", "ready", "2026-10-26T21:20:43Z", Value::Null, owner.clone()),
            ],
            "meta":{"count":2,"total_count":2}})
    );
    clean(&body);
    let body = project(
        &workflow(Collection::PeopleWorkflowSnoozedCards),
        json!({"data":[card("563", "snoozed", "2026-12-03T22:30:17Z", json!("2026-11-30T12:00:00Z"), Value::Null)]}),
    )
    .unwrap();
    assert_eq!(
        body,
        json!({"data":[kept("563", "snoozed", "2026-12-03T22:30:17Z", json!("2026-11-30T12:00:00Z"), Value::Null)]})
    );
    // The assignee may be typed Person (as the include returned it in staging); only its id stays.
    let body = project(
        &workflow(Collection::PeopleWorkflowReadyCards),
        json!({"data":[card("561", "ready", "2026-10-26T21:20:43Z", Value::Null, json!({"id":"180","type":"Person"}))]}),
    )
    .unwrap();
    assert_eq!(
        body["data"][0]["relationships"]["assignee"],
        json!({"data":{"id":"180","type":"Person"}})
    );
}

#[test]
fn memberships_and_group_events_keep_ids_intervals_and_statuses_only() {
    let body = project(
        &memberships(),
        json!({"data":[{"id":"550","type":"Membership","attributes":{"role":"member","joined_at":"2026-09-25T12:01:22Z","first_name":"first-name-canary"},"relationships":{"group":{"data":{"id":"287","type":"Group"}},"person":{"data":{"id":"50","type":"Person"}}}}],
            "included":[{"id":"50","type":"Person","attributes":{"name":"name-canary","avatar_url":"photo-canary"}},{"id":"287","type":"Group","attributes":{"name":"care-canary"}}],
            "meta":{"count":1,"total_count":1,"parent":{"id":"50","type":"Person"}}}),
    )
    .unwrap();
    assert_eq!(
        body,
        json!({"data":[{"id":"550","type":"Membership","attributes":{"role":"member"},"relationships":{"group":{"data":{"id":"287","type":"Group"}},"person":{"data":{"id":"50","type":"Person"}}}}],"meta":{"count":1,"total_count":1}})
    );
    clean(&body);
    let body = project(
        &events(),
        json!({"data":[{"id":"581","type":"Event","attributes":{"starts_at":"2026-11-22T14:30:00Z","ends_at":"2026-11-22T15:30:00Z","canceled":false,"name":"care-canary","description":"care-canary","virtual_location_url":"secret-canary","reminders_sent":false,"automated_reminder_enabled":false,"visitors_count":0},"relationships":{"group":{"data":{"id":"287","type":"Group"}},"location":{"data":{"id":"9","type":"Location"}},"attendance_submitter":{"data":{"id":"180","type":"Person"}},"repeating_event":{"data":null}}}],
            "meta":{"count":1,"total_count":1,"parent":{"id":"287","type":"Group"}}}),
    )
    .unwrap();
    assert_eq!(
        body,
        json!({"data":[{"id":"581","type":"Event","attributes":{"starts_at":"2026-11-22T14:30:00Z","ends_at":"2026-11-22T15:30:00Z","canceled":false},"relationships":{"group":{"data":{"id":"287","type":"Group"}}}}],"meta":{"count":1,"total_count":1}})
    );
    clean(&body);
}

#[test]
fn operations_meta_parent_must_name_the_org_workflow_group_or_person() {
    for (request, wrong) in [
        (
            org(Collection::CalendarRooms),
            [
                json!({"id":"1002","type":"Organization"}),
                json!({"id":"1001","type":"Resource"}),
            ],
        ),
        (
            bookings(),
            [
                json!({"id":"887","type":"Resource"}),
                json!({"id":"999","type":"Organization"}),
            ],
        ),
        (
            org(Collection::PeopleWorkflows),
            [
                json!({"id":"10","type":"Organization"}),
                json!({"id":"1001","type":"Workflow"}),
            ],
        ),
        (
            workflow(Collection::PeopleWorkflowReadyCards),
            [
                json!({"id":"796","type":"Workflow"}),
                json!({"id":"795","type":"WorkflowStep"}),
            ],
        ),
        (
            workflow(Collection::PeopleWorkflowSteps),
            [
                json!({"id":"796","type":"Workflow"}),
                json!({"id":"1001","type":"Organization"}),
            ],
        ),
        (
            memberships(),
            [
                json!({"id":"51","type":"Person"}),
                json!({"id":"50","type":"Group"}),
            ],
        ),
        (
            events(),
            [
                json!({"id":"288","type":"Group"}),
                json!({"id":"287","type":"Person"}),
            ],
        ),
    ] {
        let (kind, id) = request.parent();
        assert!(
            project(
                &request,
                json!({"data":[],"meta":{"parent":{"id":id,"type":kind}}})
            )
            .is_ok(),
            "{kind} {id}"
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
fn operations_next_links_repeat_the_window_and_fixed_query_with_only_paging_changed() {
    let api = "https://api.planningcenteronline.com";
    let page = |next: &str| json!({"data":[],"meta":{"next":{"offset":100}},"links":{"next":next}});
    let encoded = |s: &str| {
        s.replace('[', "%5B")
            .replace(']', "%5D")
            .replace(':', "%3A")
    };
    let lower = |s: &str| {
        s.replace('[', "%5b")
            .replace(']', "%5d")
            .replace(':', "%3a")
    };
    let b = format!("{api}/calendar/v2/resource_bookings");
    let window = format!("where[ends_at][gt]={W0}&where[starts_at][lt]={W1}");
    let e = format!("{api}/groups/v2/groups/287/events");
    let cards = format!("{api}/people/v2/workflows/795/cards");
    let bookings = bookings();
    let events = events();
    let ready = workflow(Collection::PeopleWorkflowReadyCards);
    let rooms = org(Collection::CalendarRooms);
    let members = memberships();
    for (request, next) in [
        (
            &bookings,
            format!(
                "{b}?filter=rooms&include=event_resource_request&{window}&order=starts_at&per_page=100&offset=100"
            ),
        ),
        // Rails-style encoding of brackets, colons and commas is the same query.
        (
            &bookings,
            format!(
                "{b}?filter=rooms&include=event_resource_request&{}&order=starts_at&offset=100&per_page=100",
                encoded(&window)
            ),
        ),
        (
            &bookings,
            format!(
                "{b}?offset=100&order=starts_at&per_page=100&{}&include=event_resource_request&filter=rooms",
                lower(&window)
            ),
        ),
        (
            &events,
            format!("{e}?{window}&order=starts_at&offset=100&per_page=100"),
        ),
        (
            &events,
            format!(
                "{e}?order=starts_at&{}&offset=100&per_page=100",
                encoded(&window)
            ),
        ),
        (
            &ready,
            format!("{cards}?where[stage]=ready&offset=100&per_page=100"),
        ),
        (
            &ready,
            format!("{cards}?where%5Bstage%5D=ready&offset=100&per_page=100"),
        ),
        (
            &rooms,
            format!("{api}/calendar/v2/resources?filter=rooms&offset=100&per_page=100"),
        ),
        (
            &members,
            format!("{api}/groups/v2/people/50/memberships?offset=100&per_page=100"),
        ),
    ] {
        let body = project(request, page(&next)).unwrap();
        assert_eq!(body["links"]["next"], json!(next));
    }
    let other = "where[ends_at][gt]=2026-11-21T10:00:01Z&where[starts_at][lt]=2026-11-23T12:00:00Z";
    for (request, next) in [
        // A different window, a missing or repeated filter, or another collection's query.
        (
            &bookings,
            format!(
                "{b}?filter=rooms&include=event_resource_request&{other}&order=starts_at&offset=100&per_page=100"
            ),
        ),
        (
            &bookings,
            format!(
                "{b}?filter=rooms&include=event_resource_request&where[ends_at][gt]={W0}&order=starts_at&offset=100&per_page=100"
            ),
        ),
        (
            &bookings,
            format!(
                "{b}?include=event_resource_request&{window}&order=starts_at&offset=100&per_page=100"
            ),
        ),
        (
            &bookings,
            format!(
                "{b}?filter=rooms&include=event_resource_request,resource&{window}&order=starts_at&offset=100&per_page=100"
            ),
        ),
        (
            &bookings,
            format!(
                "{b}?filter=rooms&include=event_resource_request&{window}&{window}&order=starts_at&offset=100&per_page=100"
            ),
        ),
        (
            &bookings,
            format!(
                "{b}?filter=rooms&include=event_resource_request&{window}&order=-starts_at&offset=100&per_page=100"
            ),
        ),
        (
            &bookings,
            format!(
                "{b}?filter=rooms&include=event_resource_request&{window}&order=starts_at&offset=100&per_page=100&where[resource][id]=887"
            ),
        ),
        // Only brackets, colons and commas may be encoded; never letters, digits or doubly.
        (
            &bookings,
            format!(
                "{b}?filter=r%6Foms&include=event_resource_request&{window}&order=starts_at&offset=100&per_page=100"
            ),
        ),
        (
            &bookings,
            format!(
                "{b}?filter=rooms&include=event_resource_request&{}&order=starts_at&offset=100&per_page=100",
                window.replace('[', "%255B")
            ),
        ),
        (
            &events,
            format!(
                "{api}/groups/v2/groups/288/events?{window}&order=starts_at&offset=100&per_page=100"
            ),
        ),
        (
            &events,
            format!(
                "{api}/groups/v2/people/50/events?{window}&order=starts_at&offset=100&per_page=100"
            ),
        ),
        (
            &ready,
            format!("{cards}?where[stage]=snoozed&offset=100&per_page=100"),
        ),
        (&ready, format!("{cards}?offset=100&per_page=100")),
        (
            &ready,
            format!(
                "{api}/people/v2/workflows/796/cards?where[stage]=ready&offset=100&per_page=100"
            ),
        ),
        (
            &rooms,
            format!("{api}/calendar/v2/resources?filter=resources&offset=100&per_page=100"),
        ),
        (
            &members,
            format!("{api}/groups/v2/people/50/memberships?include=person&offset=100&per_page=100"),
        ),
        (
            &members,
            format!("{api}/services/v2/people/50/memberships?offset=100&per_page=100"),
        ),
    ] {
        assert_eq!(
            project(request, page(&next)).err(),
            Some(SourceError::InvalidResponse),
            "{next}"
        );
    }
}

/// A valid target for every collection. Exhaustive on purpose: a new collection must be added
/// here (and so to the GET-only test) before the crate compiles.
fn target_for(collection: Collection) -> Target {
    match collection {
        Collection::Plan
        | Collection::PlanTimes
        | Collection::NeededPositions
        | Collection::TeamMembers
        | Collection::Organization
        | Collection::CalendarRooms
        | Collection::PeopleWorkflows => Target::default(),
        Collection::TeamPositionAssignments | Collection::TeamLeaders => Target::team("70"),
        Collection::PersonSchedules
        | Collection::PersonSchedulesUnfiltered
        | Collection::PersonBlockouts => Target::person("50"),
        Collection::PeopleWorkflowSteps
        | Collection::PeopleWorkflowReadyCards
        | Collection::PeopleWorkflowSnoozedCards => Target::workflow("795"),
        Collection::GroupsPersonMemberships => Target::groups_person("50"),
        Collection::CalendarResourceBookings => Target::default().within(&window()),
        Collection::CalendarEventConflicts => Target::event("231"),
        Collection::GroupsGroupEvents => Target::group("287").within(&window()),
        Collection::PeopleBackgroundChecks => Target::people_person("50"),
        // Setup's Sunday picker: no target, and less of a plan (see `valid`).
        Collection::ServiceTypes | Collection::UpcomingPlans => Target::default(),
        // Church reads (source_church_tests.rs).
        Collection::PeopleForms | Collection::CheckInsEvents | Collection::RegistrationsSignups => {
            Target::default()
        }
        Collection::PeopleFormSubmissions => Target::form("610").within(&window()),
        Collection::CheckInsLocations => Target::checkins_event("620"),
        Collection::CheckInsEventPeriods => Target::checkins_event("620").within(&window()),
        Collection::CheckInsLocationCounts => Target::checkins_event_time("630"),
        Collection::RegistrationsAttendees => Target::signup("640"),
        // Filling in To on a drafted note (contact_tests.rs).
        Collection::PersonEmails | Collection::PersonPhoneNumbers => Target::people_person("50"),
        // Adding someone to a role (change_tests.rs).
        Collection::PersonChild
        | Collection::PendingChecksAwaitingApplicant
        | Collection::PendingChecksReportProcessing
        | Collection::PendingChecksNeedsReview => Target::people_person("50"),
    }
}
/// A valid request for every collection: the picker's reads come before a plan is chosen, so
/// service types name no service type or plan, and upcoming plans name no plan; a person's
/// contact read names neither.
fn valid(collection: Collection) -> SourceRequest {
    let (service_type, plan) = match collection {
        Collection::ServiceTypes
        | Collection::PersonEmails
        | Collection::PersonPhoneNumbers
        | Collection::PersonChild
        | Collection::PendingChecksAwaitingApplicant
        | Collection::PendingChecksReportProcessing
        | Collection::PendingChecksNeedsReview => ("", ""),
        Collection::UpcomingPlans => ("10", ""),
        _ => ("10", "20"),
    };
    SourceRequest::capture_at(
        &binding(),
        service_type,
        plan,
        collection,
        &target_for(collection),
        100,
        0,
    )
    .unwrap()
}
const ALL: [Collection; 36] = [
    Collection::Plan,
    Collection::Organization,
    Collection::PlanTimes,
    Collection::NeededPositions,
    Collection::TeamMembers,
    Collection::TeamPositionAssignments,
    Collection::TeamLeaders,
    Collection::PersonSchedules,
    Collection::PersonSchedulesUnfiltered,
    Collection::PersonBlockouts,
    Collection::CalendarRooms,
    Collection::CalendarResourceBookings,
    Collection::CalendarEventConflicts,
    Collection::PeopleWorkflows,
    Collection::PeopleWorkflowSteps,
    Collection::PeopleWorkflowReadyCards,
    Collection::PeopleWorkflowSnoozedCards,
    Collection::GroupsPersonMemberships,
    Collection::GroupsGroupEvents,
    Collection::PeopleBackgroundChecks,
    Collection::ServiceTypes,
    Collection::UpcomingPlans,
    Collection::PeopleForms,
    Collection::PeopleFormSubmissions,
    Collection::CheckInsEvents,
    Collection::CheckInsLocations,
    Collection::CheckInsEventPeriods,
    Collection::CheckInsLocationCounts,
    Collection::RegistrationsSignups,
    Collection::RegistrationsAttendees,
    Collection::PersonEmails,
    Collection::PersonPhoneNumbers,
    Collection::PersonChild,
    Collection::PendingChecksAwaitingApplicant,
    Collection::PendingChecksReportProcessing,
    Collection::PendingChecksNeedsReview,
];

#[test]
fn the_source_client_only_ever_builds_get_requests_for_every_collection() {
    // Planning Center product scopes permit both reading and writing in that product. The read
    // path's GET-only rule is enforced here, in the HTTP layer: every request built is a bodiless GET
    // of the allowlisted URL, with that product's pinned version.
    let http = NativeSourceHttp::new().unwrap();
    let mut requests: Vec<SourceRequest> = ALL.iter().map(|&c| valid(c)).collect();
    // The stdin protocol's own requests too.
    for c in ["needed_positions", "team_members", "plan_times"] {
        let text = format!(
            r#"{{"version":1,"workspace":"fictional-workspace","organization":"1001","client_id":"fictional-client","service_type_id":"10","plan_id":"20","collection":"{c}","per_page":100,"offset":0}}"#
        );
        requests.push(parse_request(text.as_bytes()).unwrap());
    }
    for request in &requests {
        let built = http
            .build(request, "fictional-native-secret-canary")
            .unwrap();
        let label = request.collection.label();
        assert_eq!(built.method(), reqwest::Method::GET, "{label}");
        assert!(built.body().is_none(), "{label}");
        assert_eq!(built.url().as_str(), request.url(), "{label}");
        assert_eq!(
            built.headers()["x-pco-api-version"],
            request.collection.product().version(),
            "{label}"
        );
        assert_eq!(built.headers()["accept"], "application/json");
    }
    // An invalid request is refused before anything is built.
    let mut bad = at(Collection::CalendarRooms, Target::default()).unwrap();
    bad.workflow_id = Some("795".into());
    assert_eq!(
        http.build(&bad, "fictional-native-secret-canary").err(),
        Some(SourceError::InvalidRequest)
    );
    // Structural guard: the source client names no other HTTP method anywhere.
    let source = include_str!("source.rs");
    for method in [
        ".post(",
        ".put(",
        ".patch(",
        ".delete(",
        ".head(",
        "Method::",
        ".request(",
    ] {
        assert!(!source.contains(method), "{method}");
    }
}

#[test]
fn malformed_operations_rows_and_links_reject_the_whole_page() {
    let ok_booking = booking(
        "391",
        "2026-11-22T14:00:00Z",
        "2026-11-22T16:00:00Z",
        json!({"id":"231","type":"Event"}),
        "372",
    );
    let mut wrong_resource = ok_booking.clone();
    wrong_resource["relationships"]["resource"]["data"]["type"] = json!("Person");
    let mut wrong_event = ok_booking.clone();
    wrong_event["relationships"]["event"]["data"]["type"] = json!("Organization");
    let mut no_end = ok_booking.clone();
    no_end["attributes"]["ends_at"] = Value::Null;
    let mut bad_request = request_row("372", "A", "231");
    bad_request["attributes"]
        .as_object_mut()
        .unwrap()
        .remove("approval_status");
    let mut spaced = request_row("372", "A", "231");
    spaced["attributes"]["approval_status"] = json!("A pending\n");
    let mut person_event = request_row("372", "A", "231");
    person_event["relationships"]["event"]["data"]["type"] = json!("Person");
    let card = |attrs: Value, rels: Value| json!({"data":[{"id":"561","type":"WorkflowCard","attributes":attrs,"relationships":rels}]});
    let cases = [
        (bookings(), json!({"data":[wrong_resource]})),
        (bookings(), json!({"data":[wrong_event]})),
        (bookings(), json!({"data":[no_end]})),
        (
            bookings(),
            json!({"data":[ok_booking.clone()],"included":[bad_request]}),
        ),
        (
            bookings(),
            json!({"data":[ok_booking.clone()],"included":[spaced]}),
        ),
        (
            bookings(),
            json!({"data":[ok_booking.clone()],"included":[person_event]}),
        ),
        (
            bookings(),
            json!({"data":[ok_booking.clone()],"included":[request_row("372", "A", "231"), request_row("372", "R", "231")]}),
        ),
        (
            bookings(),
            json!({"data":[{"id":"391","type":"Resource","attributes":{"kind":"Room"}}]}),
        ),
        (
            org(Collection::CalendarRooms),
            json!({"data":[{"id":"887","type":"Resource","attributes":{"name":"Sanctuary"}}]}),
        ),
        (
            org(Collection::CalendarRooms),
            json!({"data":[{"id":"887","type":"Resource","attributes":{"kind":"Room","name":["care-canary"]}}]}),
        ),
        (
            workflow(Collection::PeopleWorkflowReadyCards),
            card(
                json!({"calculated_due_at":"2026-10-26T21:27:40Z"}),
                json!({}),
            ),
        ),
        (
            workflow(Collection::PeopleWorkflowReadyCards),
            card(
                json!({"stage":"ready","calculated_due_at":"in three days"}),
                json!({}),
            ),
        ),
        (
            workflow(Collection::PeopleWorkflowReadyCards),
            card(
                json!({"stage":"ready","snooze_until":"2026-11-30"}),
                json!({}),
            ),
        ),
        (
            workflow(Collection::PeopleWorkflowReadyCards),
            card(json!({"stage":"ready","overdue":"no"}), json!({})),
        ),
        (
            workflow(Collection::PeopleWorkflowReadyCards),
            card(
                json!({"stage":"ready"}),
                json!({"assignee":{"data":{"id":"180","type":"Organization"}}}),
            ),
        ),
        (
            workflow(Collection::PeopleWorkflowReadyCards),
            card(
                json!({"stage":"ready"}),
                json!({"current_step":{"data":{"id":"2211","type":"Workflow"}}}),
            ),
        ),
        (
            workflow(Collection::PeopleWorkflowReadyCards),
            card(
                json!({"stage":"ready"}),
                json!({"assignee":{"data":{"id":"x180","type":"Assignee"}}}),
            ),
        ),
        (
            workflow(Collection::PeopleWorkflowSteps),
            json!({"data":[{"id":"2211","type":"WorkflowStep","attributes":{"name":"Welcome","sequence":-1}}]}),
        ),
        (
            memberships(),
            json!({"data":[{"id":"550","type":"Membership","attributes":{"role":"member"},"relationships":{"group":{"data":{"id":"287","type":"Person"}}}}]}),
        ),
        (
            events(),
            json!({"data":[{"id":"581","type":"Event","attributes":{"starts_at":"2026-11-22T14:30:00Z"}}]}),
        ),
        (
            events(),
            json!({"data":[{"id":"581","type":"Event","attributes":{"starts_at":"2026-11-22T14:30:00Z","ends_at":"2026-11-22T15:30:00Z","canceled":"no"}}]}),
        ),
        (
            events(),
            json!({"data":[{"id":"581","type":"Membership","attributes":{"starts_at":"2026-11-22T14:30:00Z","ends_at":"2026-11-22T15:30:00Z"}}]}),
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

// Planning Center may silently ignore a parent, a filter or a window: every row must show it.
#[test]
fn rows_must_belong_to_the_requested_parent_even_without_meta_parent() {
    // Cards read for workflow 795; the row says workflow 999 and there is no meta.parent.
    let card = json!({"data":[{"id":"561","type":"WorkflowCard","attributes":{"stage":"ready","overdue":true},
        "relationships":{"assignee":{"data":null},"workflow":{"data":{"id":"999","type":"Workflow"}}}}]});
    assert_eq!(
        project(&workflow(Collection::PeopleWorkflowReadyCards), card).err(),
        Some(SourceError::InvalidResponse),
        "card of another workflow accepted"
    );
}
#[test]
fn membership_rows_must_name_the_requested_person() {
    let m = json!({"data":[{"id":"550","type":"Membership","attributes":{"role":"member"},
        "relationships":{"group":{"data":{"id":"287","type":"Group"}},"person":{"data":{"id":"77","type":"Person"}}}}]});
    assert_eq!(
        project(&memberships(), m).err(),
        Some(SourceError::InvalidResponse),
        "membership of another person accepted"
    );
}
#[test]
fn group_event_rows_must_name_the_requested_group() {
    let e = json!({"data":[{"id":"581","type":"Event","attributes":{"starts_at":"2026-11-22T14:30:00Z","ends_at":"2026-11-22T15:30:00Z"},
        "relationships":{"group":{"data":{"id":"999","type":"Group"}}}}]});
    assert_eq!(
        project(&events(), e).err(),
        Some(SourceError::InvalidResponse),
        "event of another group accepted"
    );
}
#[test]
fn a_silently_ignored_stage_filter_rejects_the_page() {
    let card = json!({"data":[{"id":"561","type":"WorkflowCard","attributes":{"stage":"completed","completed_at":"2026-11-01T00:00:00Z"},
        "relationships":{"assignee":{"data":null},"workflow":{"data":{"id":"795","type":"Workflow"}}}}]});
    assert_eq!(
        project(&workflow(Collection::PeopleWorkflowReadyCards), card).err(),
        Some(SourceError::InvalidResponse),
        "completed card accepted in a where[stage]=ready read"
    );
}
#[test]
fn a_silently_ignored_window_rejects_the_page() {
    let e = json!({"data":[{"id":"581","type":"Event","attributes":{"starts_at":"2019-01-06T14:30:00Z","ends_at":"2019-01-06T15:30:00Z"},
        "relationships":{"group":{"data":{"id":"287","type":"Group"}}}}]});
    assert_eq!(
        project(&events(), e).err(),
        Some(SourceError::InvalidResponse),
        "event outside the requested window accepted"
    );
}
#[test]
fn every_row_names_its_parent_stage_kind_and_window() {
    let card = |stage: &str, workflow: Value| {
        json!({"data":[{"id":"561","type":"WorkflowCard","attributes":{"stage":stage},
        "relationships":{"assignee":{"data":null},"workflow":workflow}}]})
    };
    let mine = json!({"data":{"id":"795","type":"Workflow"}});
    let step = |workflow: Value| json!({"data":[{"id":"2211","type":"WorkflowStep","attributes":{"sequence":0},"relationships":{"workflow":workflow}}]});
    let membership = |person: Option<Value>| {
        let mut rels = json!({"group":{"data":{"id":"287","type":"Group"}}});
        if let Some(person) = person {
            rels["person"] = person;
        }
        json!({"data":[{"id":"550","type":"Membership","attributes":{"role":"member"},"relationships":rels}]})
    };
    let event = |starts: &str, ends: &str, group: Option<Value>| {
        let mut row =
            json!({"id":"581","type":"Event","attributes":{"starts_at":starts,"ends_at":ends}});
        if let Some(group) = group {
            row["relationships"] = json!({ "group": group });
        }
        json!({ "data": [row] })
    };
    let ours = || Some(json!({"data":{"id":"287","type":"Group"}}));
    let booking = |starts: &str, ends: &str| json!({"data":[{"id":"391","type":"ResourceBooking","attributes":{"starts_at":starts,"ends_at":ends}}]});
    let room =
        |kind: &str| json!({"data":[{"id":"887","type":"Resource","attributes":{"kind":kind}}]});
    let ready = workflow(Collection::PeopleWorkflowReadyCards);
    let snoozed = workflow(Collection::PeopleWorkflowSnoozedCards);
    let steps = workflow(Collection::PeopleWorkflowSteps);
    let rooms = org(Collection::CalendarRooms);
    let accepted = [
        (&ready, card("ready", mine.clone())),
        (&snoozed, card("snoozed", mine.clone())),
        (&steps, step(mine.clone())),
        (
            &memberships(),
            membership(Some(json!({"data":{"id":"50","type":"Person"}}))),
        ),
        // Half-open overlap, offsets applied: 06:59-05:00 is 11:59Z, before W1.
        (
            &events(),
            event(
                "2026-11-23T06:59:00-05:00",
                "2026-11-23T08:00:00-05:00",
                ours(),
            ),
        ),
        (
            &events(),
            event("2026-11-21T09:00:00Z", "2026-11-21T10:00:00.001Z", ours()),
        ),
        (
            &bookings(),
            booking("2026-11-20T00:00:00Z", "2026-11-24T00:00:00Z"),
        ),
        (&rooms, room("Room")),
    ];
    for (request, raw) in accepted {
        assert!(project(request, raw.clone()).is_ok(), "{raw}");
    }
    let refused = [
        (&ready, card("ready", json!({"data":null}))),
        (
            &ready,
            card("ready", json!({"data":[{"id":"795","type":"Workflow"}]})),
        ),
        (&ready, card("snoozed", mine.clone())),
        (&snoozed, card("ready", mine.clone())),
        (
            &snoozed,
            card("snoozed", json!({"data":{"id":"796","type":"Workflow"}})),
        ),
        (
            &ready,
            json!({"data":[{"id":"561","type":"WorkflowCard","attributes":{"stage":"ready"}}]}),
        ),
        (&steps, step(json!({"data":{"id":"796","type":"Workflow"}}))),
        (
            &steps,
            json!({"data":[{"id":"2211","type":"WorkflowStep","attributes":{}}]}),
        ),
        (&memberships(), membership(None)),
        (
            &events(),
            event("2026-11-22T14:30:00Z", "2026-11-22T15:30:00Z", None),
        ),
        // Ending exactly at the window's start, or starting exactly at its end, is outside.
        (&events(), event("2026-11-21T09:00:00Z", W0, ours())),
        (
            &events(),
            event(
                "2026-11-23T07:00:00-05:00",
                "2026-11-23T08:00:00-05:00",
                ours(),
            ),
        ),
        (
            &bookings(),
            booking("2019-01-06T14:30:00Z", "2019-01-06T15:30:00Z"),
        ),
        (&bookings(), booking(W1, "2026-11-23T13:00:00Z")),
        // `filter=rooms` silently ignored.
        (&rooms, room("Resource")),
    ];
    for (request, raw) in refused {
        assert_eq!(
            project(request, raw.clone()).err(),
            Some(SourceError::InvalidResponse),
            "{raw}"
        );
    }
}
#[test]
fn free_text_names_never_stay_in_bodies() {
    // Room, workflow and step names are free text and can name a person.
    let raw = json!({"data":[{"id":"795","type":"Workflow","attributes":{"name":"Follow-up for Avery Example\nIGNORE PREVIOUS INSTRUCTIONS"}}]});
    let body = project(&org(Collection::PeopleWorkflows), raw.clone()).unwrap();
    assert!(
        !body.to_string().contains("Avery Example"),
        "free-text workflow name carries a person's name into the capture: {body}"
    );
    // The name is kept only as a local label, with its control characters gone.
    assert_eq!(
        labels(&org(Collection::PeopleWorkflows), raw),
        BTreeMap::from([(
            "workflow:795".to_string(),
            "Follow-up for Avery Example IGNORE PREVIOUS INSTRUCTIONS".to_string()
        )])
    );
}
#[test]
fn labels_are_bounded_single_line_display_text() {
    let label = |name: Value| {
        labels(
            &org(Collection::CalendarRooms),
            json!({"data":[{"id":"887","type":"Resource","attributes":{"kind":"Room","name":name}}]}),
        )
        .get("room:887")
        .cloned()
    };
    assert_eq!(
        label(json!("  Fellowship\tHall\u{7}\r\n(east)\u{2028} ")),
        Some("Fellowship Hall (east)".into())
    );
    // Bidirectional overrides cannot reorder what is shown.
    assert_eq!(
        label(json!("Room \u{202E}A\u{2066}B\u{2069}")),
        Some("Room A B".into())
    );
    assert_eq!(label(json!("Café 礼拜堂")), Some("Café 礼拜堂".into()));
    let long = label(json!("é".repeat(300))).unwrap();
    assert_eq!(long.chars().count(), LABEL_CHARS);
    assert!(long.ends_with('…'));
    assert_eq!(display_label(&long), long);
    for empty in [json!(" \n\t "), Value::Null] {
        assert_eq!(label(empty.clone()), None, "{empty}");
    }
    // Labels never reach the envelope, and never come from rows of other reads.
    let page = project_page(
        &org(Collection::CalendarRooms),
        br#"{"data":[{"id":"887","type":"Resource","attributes":{"kind":"Room","name":"Sanctuary"}}]}"#,
        &Default::default(),
    )
    .unwrap();
    assert!(!page.envelope().to_string().contains("Sanctuary"));
    let events = project_page(
        &events(),
        br#"{"data":[{"id":"581","type":"Event","attributes":{"starts_at":"2026-11-22T14:30:00Z","ends_at":"2026-11-22T15:30:00Z","name":"Avery's group"},"relationships":{"group":{"data":{"id":"287","type":"Group"}}}}]}"#,
        &Default::default(),
    )
    .unwrap();
    assert!(events.labels().is_empty());
    assert!(!events.envelope().to_string().contains("Avery"));
    // One page naming the same row two ways is a contradiction.
    assert_eq!(
        project(
            &org(Collection::CalendarRooms),
            json!({"data":[{"id":"887","type":"Resource","attributes":{"kind":"Room","name":"North"}},
                           {"id":"887","type":"Resource","attributes":{"kind":"Room","name":"South"}}]})
        )
        .err(),
        Some(SourceError::InvalidResponse)
    );
}

#[test]
fn only_a_groups_membership_404_means_not_found_and_every_other_404_stays_a_failure() {
    // Live, 2026-11-13: Groups answers 404 for a Services person with no Groups profile. That
    // is the one collection where 404 is an answer; everywhere else it is still a failure.
    for collection in ALL {
        let request = valid(collection);
        let expected = if collection == Collection::GroupsPersonMemberships {
            SourceError::NotFound
        } else {
            SourceError::ProviderFailure
        };
        assert_eq!(
            status_error(&request, 404, None),
            Some(expected),
            "{}",
            collection.label()
        );
    }
    // Only 404 reads that way: every other status keeps its meaning for memberships too.
    let memberships = at(
        Collection::GroupsPersonMemberships,
        Target::groups_person("50"),
    )
    .unwrap();
    for (status, expected) in [
        (200, None),
        (401, Some(SourceError::Denied)),
        (403, Some(SourceError::Denied)),
        (400, Some(SourceError::Rejected)),
        (410, Some(SourceError::ProviderFailure)),
        (500, Some(SourceError::ProviderFailure)),
    ] {
        assert_eq!(
            status_error(&memberships, status, None),
            expected,
            "{status}"
        );
    }
    // The stdin protocol's closed vocabulary is unchanged.
    for c in ["needed_positions", "team_members", "plan_times"] {
        let text = format!(
            r#"{{"version":1,"workspace":"fictional-workspace","organization":"1001","client_id":"fictional-client","service_type_id":"10","plan_id":"20","collection":"{c}","per_page":100,"offset":0}}"#
        );
        let request = parse_request(text.as_bytes()).unwrap();
        assert_eq!(
            status_error(&request, 404, None),
            Some(SourceError::ProviderFailure),
            "{c}"
        );
    }
    assert_eq!(SourceError::NotFound.reason(), "not-found");
    assert_eq!(
        SourceError::NotFound.envelope(),
        json!({"version":1,"ok":false,"code":"provider-failure","reason":"not-found"})
    );
}

// ---- People background checks (kids rule) ------------------------------------------------------

fn background(person: &str) -> SourceRequest {
    at(
        Collection::PeopleBackgroundChecks,
        Target::people_person(person),
    )
    .unwrap()
}
/// A cleared check as Planning Center documents it (People 2025-11-10 `BackgroundCheck`), with
/// every field Ozzie must drop carrying a canary.
fn cleared(id: &str, person: &str) -> Value {
    json!({"id":id,"type":"BackgroundCheck","attributes":{"completed_at":"2026-01-05T12:00:00Z","current":true,
        "expires_on":"2027-01-05","note":"note-canary","report_url":"https://example.invalid/secret-canary",
        "status":"complete_clear","status_updated_at":"2026-01-05T12:00:00Z"},
        "relationships":{"person":{"data":{"id":person,"type":"Person"}},"created_by":{"data":{"id":"180","type":"Person"}}},
        "links":{"self":"https://api.planningcenteronline.com/people/v2/background_checks/1"}})
}

#[test]
fn background_checks_are_one_persons_cleared_checks_by_an_exact_get_with_the_people_pin() {
    let request = background("50");
    assert_eq!(
        request.url(),
        "https://api.planningcenteronline.com/people/v2/people/50/background_checks?filter=complete_clear&per_page=100&offset=0"
    );
    assert_eq!(request.collection.product(), Product::People);
    assert_eq!(request.collection.product().version(), "2025-11-10");
    assert_eq!(request.collection.label(), "people_background_checks");
    let built = NativeSourceHttp::new()
        .unwrap()
        .build(&request, "fictional-native-secret-canary")
        .unwrap();
    assert_eq!(built.method(), reqwest::Method::GET);
    assert!(built.body().is_none());
    assert_eq!(built.headers()["X-PCO-API-Version"], "2025-11-10");
}

#[test]
fn background_check_targets_take_only_a_people_person_id() {
    let invalid = Some(SourceError::InvalidRequest);
    let make = |t: Target| at(Collection::PeopleBackgroundChecks, t).err();
    assert_eq!(make(Target::people_person("50")), None);
    assert_eq!(make(Target::default()), invalid);
    // Services and Groups person ids never stand in for it, and it never rides along with them.
    assert_eq!(make(Target::person("50")), invalid);
    assert_eq!(make(Target::groups_person("50")), invalid);
    let mut both = Target::people_person("50");
    both.person_id = Some("50".into());
    assert_eq!(make(both), invalid);
    assert_eq!(make(Target::people_person("50").within(&window())), invalid);
    assert_eq!(
        at(Collection::PersonSchedules, Target::people_person("50")).err(),
        invalid
    );
    for bad in ["", "050", "5/../1", "50?filter=all", "-1", "1.5"] {
        assert_eq!(make(Target::people_person(bad)), invalid, "{bad}");
    }
}

#[test]
fn a_background_check_keeps_only_whether_it_is_current_and_its_expiry() {
    let body = project(
        &background("50"),
        json!({"data":[cleared("901", "50")],
            "included":[{"id":"50","type":"Person","attributes":{"name":"name-canary","first_name":"first-name-canary"}}],
            "meta":{"count":1,"total_count":1,"can_include":["created_by","person"],"parent":{"id":"50","type":"Person"}}}),
    )
    .unwrap();
    assert_eq!(
        body,
        json!({"data":[{"id":"901","type":"BackgroundCheck",
            "attributes":{"status":"complete_clear","current":true,"expires_on":"2027-01-05"},
            "relationships":{"person":{"data":{"id":"50","type":"Person"}}}}],
            "meta":{"count":1,"total_count":1}})
    );
    clean(&body);
    let wire = body.to_string();
    for dropped in [
        "completed_at",
        "status_updated_at",
        "report_url",
        "note",
        "created_by",
        "180",
        "links",
    ] {
        assert!(!wire.contains(dropped), "{dropped} survived: {wire}");
    }
    // No expiry, or no `current` at all, still projects: the webview decides what that means.
    let mut open = cleared("902", "50");
    open["attributes"]["expires_on"] = Value::Null;
    open["attributes"]
        .as_object_mut()
        .unwrap()
        .remove("current");
    assert!(project(&background("50"), json!({ "data": [open] })).is_ok());
    // An empty answer is an answer.
    assert_eq!(
        project(
            &background("50"),
            json!({"data":[],"meta":{"count":0,"total_count":0}})
        )
        .unwrap(),
        json!({"data":[],"meta":{"count":0,"total_count":0}})
    );
}

#[test]
fn a_background_page_that_breaks_the_filter_or_names_someone_else_is_refused_whole() {
    type Tamper = fn(&mut Value);
    let tampers: [(&str, Tamper); 10] = [
        // Planning Center ignoring the filter must never hand over another outcome.
        ("status not clear", |r| {
            r["attributes"]["status"] = json!("complete_not_clear")
        }),
        ("status pending", |r| {
            r["attributes"]["status"] = json!("needs_review")
        }),
        ("manual not clear", |r| {
            r["attributes"]["status"] = json!("manual_not_clear")
        }),
        ("no status", |r| {
            r["attributes"].as_object_mut().unwrap().remove("status");
        }),
        ("another person", |r| {
            r["relationships"]["person"]["data"]["id"] = json!("51")
        }),
        ("no person", |r| {
            r["relationships"].as_object_mut().unwrap().remove("person");
        }),
        ("person typed otherwise", |r| {
            r["relationships"]["person"]["data"]["type"] = json!("Assignee")
        }),
        ("free-text expiry", |r| {
            r["attributes"]["expires_on"] = json!("next spring")
        }),
        ("expiry as an instant", |r| {
            r["attributes"]["expires_on"] = json!("2027-01-05T00:00:00Z")
        }),
        ("another row type", |r| r["type"] = json!("Person")),
    ];
    for (label, tamper) in tampers {
        let mut row = cleared("901", "50");
        tamper(&mut row);
        assert_eq!(
            project(
                &background("50"),
                json!({"data":[cleared("900", "50"), row]})
            )
            .err(),
            Some(SourceError::InvalidResponse),
            "{label}"
        );
    }
    // A parent that isn't this person is a contradiction.
    assert_eq!(
        project(
            &background("50"),
            json!({"data":[],"meta":{"parent":{"id":"51","type":"Person"}}})
        )
        .err(),
        Some(SourceError::InvalidResponse)
    );
}

#[test]
fn a_background_next_link_must_keep_the_cleared_filter() {
    let next = |link: &str| {
        project(
            &background("50"),
            json!({"data":[cleared("901", "50")],"meta":{"next":{"offset":100}},"links":{"next":link}}),
        )
    };
    let base = "https://api.planningcenteronline.com/people/v2/people/50/background_checks";
    assert!(
        next(&format!(
            "{base}?filter=complete_clear&offset=100&per_page=100"
        ))
        .is_ok()
    );
    for bad in [
        format!("{base}?offset=100&per_page=100"),
        format!("{base}?filter=expired&offset=100&per_page=100"),
        format!("{base}?filter=complete_clear,complete_not_clear&offset=100&per_page=100"),
        format!("{base}?filter=complete_clear&include=created_by&offset=100&per_page=100"),
        "https://api.planningcenteronline.com/people/v2/people/51/background_checks?filter=complete_clear&offset=100&per_page=100".into(),
    ] {
        assert_eq!(
            next(&bad).err(),
            Some(SourceError::InvalidResponse),
            "{bad}"
        );
    }
}

#[test]
fn a_check_entered_by_hand_counts_as_cleared() {
    // Shape seen live on 2026-11-14 for the `complete_clear` filter (values fictional): `manual_clear`.
    let mut row = cleared("70", "50");
    row["attributes"]["status"] = json!("manual_clear");
    let page = project(&background("50"), json!({"data":[row],"meta":{"count":1,"total_count":1,"parent":{"id":"50","type":"Person"}}}))
        .unwrap();
    assert_eq!(
        page["data"][0]["attributes"]["status"],
        json!("manual_clear")
    );
    assert!(page["data"][0]["attributes"].get("note").is_none());
}

#[path = "source_church_tests.rs"]
mod church;
