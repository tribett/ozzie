use ozzie_native_auth::source::{MAX_OUTPUT, SourceError, parse_request, project_page};
use serde_json::{Value, json};

const REQUEST: &str = r#"{"version":1,"workspace":"fictional-workspace","organization":"1001","client_id":"fictional-client","service_type_id":"10","plan_id":"20","collection":"team_members","per_page":100,"offset":0}"#;

fn project(attributes: Value) -> Value {
    let request = parse_request(REQUEST.as_bytes()).unwrap();
    project_page(
        &request,
        &serde_json::to_vec(&json!({"data":[{"id":"40","type":"PlanPerson","attributes":attributes}],"meta":{"count":1,"total_count":1}})).unwrap(),
        &Default::default(),
    ).unwrap().envelope()
}

#[test]
fn preserves_source_notification_facts_without_classifying_them() {
    assert_eq!(
        project(
            json!({"status":"U","notification_sent_at":null,"notification_prepared_at":"2026-10-30T12:30:00.123-04:00","prepare_notification":false})
        )["body"]["data"][0]["attributes"],
        json!({"status":"U","notification_sent_at":null,"notification_prepared_at":"2026-10-30T12:30:00.123-04:00","prepare_notification":false})
    );
}

fn cases() -> Value {
    serde_json::from_str(include_str!(
        "../../test/notification-projection/cases.json"
    ))
    .unwrap()
}

#[test]
fn preserves_missing_null_boolean_and_zoned_instants_for_every_status() {
    for attributes in cases()["valid_attributes"].as_array().unwrap() {
        assert_eq!(
            project(attributes.clone())["body"]["data"][0]["attributes"],
            *attributes
        );
    }
}

#[test]
fn malformed_recognized_facts_refuse_the_whole_page_with_sanitized_error() {
    let fixtures = cases();
    for (key, values) in [
        ("notification_sent_at", "invalid_timestamps"),
        ("notification_prepared_at", "invalid_timestamps"),
        ("prepare_notification", "invalid_booleans"),
    ] {
        for value in fixtures[values].as_array().unwrap() {
            let mut attributes = json!({"status":"U"});
            attributes[key] = value.clone();
            let request = parse_request(REQUEST.as_bytes()).unwrap();
            // A valid sibling cannot hide a malformed row or become a complete zero.
            let bytes = serde_json::to_vec(&json!({"data":[{"id":"40","type":"PlanPerson","attributes":{"status":"C"}},{"id":"41","type":"PlanPerson","attributes":attributes}],"meta":{"count":2,"total_count":2}})).unwrap();
            let error = project_page(&request, &bytes, &Default::default()).err();
            assert_eq!(error, Some(SourceError::InvalidResponse), "{key}: {value}");
            assert_eq!(
                error.unwrap().envelope(),
                json!({"version":1,"ok":false,"code":"provider-failure","reason":"invalid-response"})
            );
        }
    }
}

#[test]
fn unrelated_source_prose_is_stripped_and_other_collections_do_not_gain_fields() {
    let canaries = json!({"name":"fictional-name-canary","email":"fictional-contact-canary","phone":"fictional-phone-canary","care":"fictional-care-canary","notes":"fictional-notes-canary","instructions":"fictional-source-prose-canary","sent":true,"notification_state":"fictional-classification-canary"});
    let mut attrs = canaries.clone();
    attrs["status"] = json!("U");
    attrs["notification_sent_at"] = Value::Null;
    let envelope = project(attrs);
    assert_eq!(
        envelope["body"]["data"][0]["attributes"],
        json!({"status":"U","notification_sent_at":null})
    );
    for value in canaries
        .as_object()
        .unwrap()
        .values()
        .filter_map(Value::as_str)
    {
        assert!(!envelope.to_string().contains(value));
    }
    for (collection, kind, attributes) in [
        ("needed_positions", "NeededPosition", json!({"quantity":2})),
        (
            "plan_times",
            "PlanTime",
            json!({"starts_at":"2026-11-01T10:00:00-05:00","ends_at":"2026-11-01T11:00:00-05:00","time_type":"service"}),
        ),
    ] {
        let mut raw_attributes = attributes.clone();
        // Not recognized on these resources, even when malformed as notification facts.
        raw_attributes["notification_sent_at"] = json!(["fictional-canary"]);
        raw_attributes["notification_prepared_at"] = json!({"care":"fictional-canary"});
        raw_attributes["prepare_notification"] = Value::Null;
        let request =
            parse_request(REQUEST.replace("team_members", collection).as_bytes()).unwrap();
        let bytes = serde_json::to_vec(
            &json!({"data":[{"id":"40","type":kind,"attributes":raw_attributes}]}),
        )
        .unwrap();
        let output = project_page(&request, &bytes, &Default::default())
            .unwrap()
            .envelope();
        assert_eq!(
            output,
            json!({"version":1,"ok":true,"status":200,"headers":{},"body":{"data":[{"id":"40","type":kind,"attributes":attributes}]}})
        );
    }
}

#[test]
fn preserves_identical_raw_facts_under_c_u_d_without_inferred_state() {
    for status in ["C", "U", "D"] {
        let attrs = json!({"status":status,"notification_sent_at":"2026-10-30T12:30:00Z","notification_prepared_at":null,"prepare_notification":false});
        assert_eq!(
            project(attrs.clone())["body"]["data"][0]["attributes"],
            attrs
        );
    }
}

#[test]
fn notification_size_and_duplicate_keys_refuse_instead_of_disappearing() {
    let request = parse_request(REQUEST.as_bytes()).unwrap();
    for key in [
        "notification_sent_at",
        "notification_prepared_at",
        "prepare_notification",
    ] {
        let raw = format!(
            r#"{{"data":[{{"id":"40","type":"PlanPerson","attributes":{{"status":"U","{key}":null,"{key}":false}}}}]}}"#
        );
        assert_eq!(
            project_page(&request, raw.as_bytes(), &Default::default()).err(),
            Some(SourceError::InvalidResponse)
        );
        let raw = serde_json::to_vec(&json!({"data":[{"id":"40","type":"PlanPerson","attributes":{"status":"U",key:"x".repeat(256)}}]})).unwrap();
        assert_eq!(
            project_page(&request, &raw, &Default::default()).err(),
            Some(SourceError::InvalidResponse)
        );
        let raw = serde_json::to_vec(&json!({"data":[{"id":"40","type":"PlanPerson","attributes":{"status":"U",key:"x".repeat(MAX_OUTPUT)}}]})).unwrap();
        assert_eq!(
            project_page(&request, &raw, &Default::default()).err(),
            Some(SourceError::Oversized)
        );
    }
}
