use ozzie_native_auth::source::{SourceError, parse_request};
const REQUEST: &str = r#"{"version":1,"workspace":"fictional-workspace","organization":"1001","client_id":"fictional-client","service_type_id":"10","plan_id":"20","collection":"needed_positions","per_page":100,"offset":0}"#;
#[test]
fn closed_request_reconstructs_only_the_bound_nested_services_url() {
    let request = parse_request(REQUEST.as_bytes()).unwrap();
    assert_eq!(
        request.url(),
        "https://api.planningcenteronline.com/services/v2/service_types/10/plans/20/needed_positions?per_page=100&offset=0"
    );
    for bad in [
        REQUEST.replace("\"version\":1", "\"version\":2"),
        REQUEST.replace("\"offset\":0", "\"offset\":10001"),
        REQUEST.replace("\"per_page\":100", "\"per_page\":101"),
        REQUEST.replace("\"plan_id\":\"20\"", "\"plan_id\":\"20/people\""),
        REQUEST.replace("\"needed_positions\"", "\"people\""),
        REQUEST.replace(
            "\"offset\":0",
            "\"offset\":0,\"url\":\"https://evil.invalid\"",
        ),
        REQUEST.replace("\"offset\":0", "\"offset\":0,\"offset\":1"),
    ] {
        assert_eq!(
            parse_request(bad.as_bytes()).err(),
            Some(SourceError::InvalidRequest)
        );
    }
}

#[test]
fn credential_free_page_preserves_count_and_linkage_contradictions_without_names() {
    use ozzie_native_auth::source::project_page;
    use serde_json::json;
    let request = parse_request(REQUEST.as_bytes()).unwrap();
    let raw = json!({"data":[{"id":"30","type":"NeededPosition","attributes":{"quantity":2,"team_position_name":"Fictional Name Canary","notes":"care-canary","email":"contact-canary"},"relationships":{"plan":{"data":{"id":"21","type":"Plan"}},"time":{"data":null}},"links":{"self":"secret-canary"}}],"meta":{"count":2,"total_count":3,"can_include":["secret-canary"]},"included":[{"id":"secret-canary","attributes":{"name":"Fictional Name Canary"}}]});
    let page = project_page(
        &request,
        &serde_json::to_vec(&raw).unwrap(),
        &Default::default(),
    )
    .unwrap();
    let value = page.envelope();
    assert_eq!(
        value["body"],
        json!({"data":[{"id":"30","type":"NeededPosition","attributes":{"quantity":2},"relationships":{"plan":{"data":{"id":"21","type":"Plan"}},"time":{"data":null}}}],"meta":{"count":2,"total_count":3}})
    );
    let wire = value.to_string();
    for canary in [
        "secret-canary",
        "Fictional Name Canary",
        "care-canary",
        "contact-canary",
        "included",
    ] {
        assert!(!wire.contains(canary));
    }
}
#[test]
fn duplicate_response_counts_cannot_disappear_during_projection() {
    use ozzie_native_auth::source::project_page;
    let request = parse_request(REQUEST.as_bytes()).unwrap();
    assert_eq!(
        project_page(
            &request,
            br#"{"data":[],"meta":{"total_count":2,"total_count":0}}"#,
            &Default::default()
        )
        .err(),
        Some(SourceError::InvalidResponse)
    );
}

#[test]
fn native_caps_reject_extra_fields_and_all_arbitrary_request_capabilities() {
    for extra in [
        "url", "method", "headers", "include", "search", "query", "token", "secret",
    ] {
        let text = REQUEST.replace(
            "\"offset\":0",
            &format!("\"offset\":0,\"{extra}\":\"fictional-canary\""),
        );
        assert_eq!(
            parse_request(text.as_bytes()).err(),
            Some(SourceError::InvalidRequest)
        );
    }
    assert_eq!(
        parse_request(&vec![b' '; 4097]).err(),
        Some(SourceError::Oversized)
    );
    for (from, to) in [
        ("\"offset\":0", "\"offset\":-1"),
        ("\"offset\":0", "\"offset\":1.5"),
        ("\"1001\"", "\"01001\""),
        ("\"fictional-workspace\"", "\"../scope\""),
        ("\"fictional-client\"", "\"https://evil.invalid\""),
    ] {
        assert_eq!(
            parse_request(REQUEST.replace(from, to).as_bytes()).err(),
            Some(SourceError::InvalidRequest)
        );
    }
}
#[test]
fn native_response_limits_injection_and_unknown_shape_fail_without_truncation() {
    use ozzie_native_auth::source::{MAX_OUTPUT, project_page};
    use serde_json::json;
    let request = parse_request(REQUEST.as_bytes()).unwrap();
    for raw in [
        json!({"data":vec![json!({"id":"30","type":"NeededPosition","attributes":{"quantity":1}});101]}),
        json!({"data":[],"links":{"next":"https://evil.invalid"}}),
        json!({"data":[],"links":{"next":"https://api.planningcenteronline.com/services/v2/service_types/10/plans/20/needed_positions?per_page=100&offset=1&include=person"}}),
        json!({"data":[],"meta":{"total_count":"secret-care-name-canary"}}),
        json!({"data":[],"errors":[{"detail":"secret-care-name-canary"}]}),
        json!({"data":[{"id":"30","type":"NeededPosition","attributes":{"quantity":1},"relationships":{"time":{"data":{"id":"30","type":"secret-care-name-canary"}}}}]}),
    ] {
        assert!(
            project_page(
                &request,
                &serde_json::to_vec(&raw).unwrap(),
                &Default::default()
            )
            .is_err()
        );
    }
    assert_eq!(
        project_page(&request, &vec![b' '; MAX_OUTPUT + 1], &Default::default()).err(),
        Some(SourceError::Oversized)
    );
    assert_eq!(
        project_page(
            &request,
            br#"{"data":[],"meta":{"next":{"offset":100},"total_count":0}}"#,
            &Default::default()
        )
        .err(),
        Some(SourceError::InvalidResponse)
    );
}
#[test]
fn native_headers_and_all_three_collections_are_minimized_against_closed_schemas() {
    use ozzie_native_auth::source::project_page;
    use serde_json::json;
    use std::collections::BTreeMap;
    let headers = BTreeMap::from([
        ("authorization".into(), "fictional-secret-canary".into()),
        ("x-pco-api-version".into(), "2018-11-01".into()),
        ("x-pco-api-request-rate-period".into(), "20 seconds".into()),
        ("retry-after".into(), "care-canary".into()),
    ]);
    for (collection, row) in [
        (
            "team_members",
            json!({"id":"40","type":"PlanPerson","attributes":{"status":"U","name":"fictional-name-canary","decline_reason":"care-canary"},"relationships":{"person":{"data":{"id":"50","type":"Person"}},"times":{"data":[{"id":"60","type":"PlanTime"}]}}}),
        ),
        (
            "plan_times",
            json!({"id":"60","type":"PlanTime","attributes":{"starts_at":"2026-11-01T10:00:00-05:00","ends_at":"2026-11-01T11:00:00-05:00","time_type":"service","name":"fictional-name-canary"},"relationships":{"assigned_teams":{"data":[{"id":"70","type":"Team"}]},"assigned_positions":{"data":[]}}}),
        ),
    ] {
        let request =
            parse_request(REQUEST.replace("needed_positions", collection).as_bytes()).unwrap();
        let value = project_page(
            &request,
            &serde_json::to_vec(&json!({"data":[row],"meta":{"count":1,"total_count":1}})).unwrap(),
            &headers,
        )
        .unwrap()
        .envelope();
        assert_eq!(
            value["headers"],
            json!({"x-pco-api-version":"2018-11-01","x-pco-api-request-rate-period":"20 seconds"})
        );
        for canary in [
            "fictional-secret-canary",
            "fictional-name-canary",
            "care-canary",
        ] {
            assert!(!value.to_string().contains(canary));
        }
        assert_eq!(
            value["body"]["data"][0]["id"],
            if collection == "team_members" {
                "40"
            } else {
                "60"
            }
        );
    }
}
#[test]
fn existing_native_consumer_workspace_binding_is_accepted_without_rekeying_credentials() {
    assert!(
        parse_request(
            REQUEST
                .replace("fictional-workspace", "local:1001")
                .as_bytes()
        )
        .is_ok()
    );
}
