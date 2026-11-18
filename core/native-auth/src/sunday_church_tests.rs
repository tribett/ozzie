//! Church reads inside the Sunday check: People forms, Check-Ins and Registrations. Fictional data
//! only. The fake clock reads 2026-11-13T12:00:00Z (a Friday), so the recent window is
//! [2026-11-05T12:00:00Z, 2026-11-13T12:00:00Z) and its Sunday is November 8.
use super::*;

const CI: &str = "https://api.planningcenteronline.com/check-ins/v2";
const REG: &str = "https://api.planningcenteronline.com/registrations/v2";
const PEOPLE: &str = "https://api.planningcenteronline.com/people/v2";
const RECENT: &str = "where[ends_at][gt]=2026-11-05T12:00:00Z&where[starts_at][lt]=2026-11-13T12:00:00Z&order=starts_at";

fn stored(scopes: &str) -> String {
    format!(
        r#"{{"client_id":"fictional-client","organization":"1001","tokens":{{"access_token":"fictional-native-secret-canary","refresh_token":null,"token_type":"bearer","expires_in":7200}},"scopes":"{scopes}"}}"#
    )
}
fn connected(scopes: &str) -> Arc<AuthController> {
    fixture_stored("1001", None, false, &stored(scopes)).auth
}
fn church_check(
    auth: &AuthController,
    script: &Script,
    forms: Option<&[String]>,
) -> Result<(SundayCapture, ReadNames), SourceError> {
    church_check_with(
        auth,
        script,
        ChurchReads {
            operations: true,
            forms,
            checkins_event: None,
        },
    )
}
fn church_check_with(
    auth: &AuthController,
    script: &Script,
    church: ChurchReads<'_>,
) -> Result<(SundayCapture, ReadNames), SourceError> {
    run_with_church(
        auth,
        "10",
        "20",
        &[],
        church,
        &AtomicBool::new(false),
        script,
        &FakeClock::new(),
    )
}
fn church_urls(script: &Script) -> Vec<String> {
    script
        .seen()
        .into_iter()
        .filter(|url| {
            url.starts_with(CI)
                || url.starts_with(REG)
                || url.starts_with(&format!("{PEOPLE}/forms"))
        })
        .collect()
}
fn ids(
    capture: &SundayCapture,
    collection: &str,
    id: fn(&SundayRead) -> Option<&str>,
) -> Vec<String> {
    reads(capture, collection)
        .iter()
        .map(|r| id(r).unwrap_or("-").to_owned())
        .collect()
}
fn periods_url(event: &str) -> String {
    format!("{CI}/events/{event}/event_periods?include=event_times&{RECENT}&per_page=100&offset=0")
}
fn counts_url(time: &str) -> String {
    format!("{CI}/event_times/{time}/location_event_times?include=location&per_page=100&offset=0")
}
/// Shaped like Planning Center's published examples: an EventTime renders `event` and
/// `event_period`; an EventPeriod renders `event` only; a Location renders `parent` only; a
/// LocationEventTime renders its room only because the read includes it.
fn time_row(id: &str, event: &str, period: &str, starts_at: &str) -> Value {
    json!({"id":id,"type":"EventTime","attributes":{"starts_at":starts_at,"name":"name-canary"},
        "relationships":{"event":{"data":{"id":event,"type":"Event"}},"event_period":{"data":{"id":period,"type":"EventPeriod"}}}})
}
fn period_row(id: &str, event: &str, starts_at: &str, ends_at: &str) -> Value {
    json!({"id":id,"type":"EventPeriod","attributes":{"starts_at":starts_at,"ends_at":ends_at},
        "relationships":{"event":{"data":{"id":event,"type":"Event"}}}})
}
fn room_row(id: &str, name: &str) -> Value {
    json!({"id":id,"type":"Location","attributes":{"name":name,"kind":"Location","age_min_in_months":0},
        "relationships":{"parent":{"data":null}}})
}
fn count_page(time: &str, rooms: &[(&str, u64, u64, u64)]) -> Value {
    json!({"data":rooms.iter().enumerate().map(|(i, (room, regular, guest, volunteer))| json!({
        "id":format!("67{i}{time}"),"type":"LocationEventTime",
        "attributes":{"regular_count":regular,"guest_count":guest,"volunteer_count":volunteer},
        "relationships":{"location":{"data":{"id":room,"type":"Location"}}}})).collect::<Vec<_>>(),
        "meta":{"parent":{"id":time,"type":"EventTime"}}})
}
/// Two Check-Ins events: Sunday Kids (two times last Sunday, and next Sunday's time already in a
/// weekly period) and a Wednesday night (one time).
fn check_ins_script() -> Script {
    sunday()
        .page(
            format!("{CI}/events?filter=not_archived&per_page=100&offset=0"),
            json!({"data":[
                {"id":"620","type":"Event","attributes":{"name":"Sunday Kids","archived_at":null}},
                {"id":"621","type":"Event","attributes":{"name":"Wednesday Night","archived_at":null}}]}),
        )
        .page(
            format!("{CI}/events/620/locations?per_page=100&offset=0"),
            json!({"data":[room_row("650","Nursery")],"meta":{"parent":{"id":"620","type":"Event"}}}),
        )
        .page(
            periods_url("620"),
            json!({"data":[
                    period_row("660","620","2026-11-08T05:00:00Z","2026-11-09T05:00:00Z"),
                    period_row("661","620","2026-11-09T05:00:00Z","2026-11-16T05:00:00Z")],
                "included":[time_row("630","620","660","2026-11-08T14:00:00Z"),time_row("631","620","660","2026-11-08T16:00:00Z"),
                    time_row("632","620","661","2026-11-15T14:00:00Z")]}),
        )
        .page(
            periods_url("621"),
            json!({"data":[period_row("662","621","2026-11-11T05:00:00Z","2026-11-12T05:00:00Z")],
                "included":[time_row("633","621","662","2026-11-11T23:00:00Z")]}),
        )
        .page(counts_url("630"), count_page("630", &[("650", 8, 1, 1)]))
        .page(counts_url("631"), count_page("631", &[("650", 5, 0, 2)]))
        .page(counts_url("633"), count_page("633", &[("651", 12, 2, 3)]))
}
fn registrations_script() -> Script {
    let signup = |id: &str, closed: Value| {
        json!({"id":id,"type":"Signup","attributes":{"name":"Fall retreat","archived":false,"closed":closed,
            "open_at":"2026-10-01T12:00:00Z","close_at":"2026-11-20T23:00:00Z","maximum_capacity":40}})
    };
    sunday()
        .page(
            format!("{REG}/signups?filter=unarchived&per_page=100&offset=0"),
            json!({"data":[signup("640",json!(false)),signup("641",json!(true)),
                {"id":"642","type":"Signup","attributes":{"name":"Picnic","archived":false}}]}),
        )
        .page(
            format!("{REG}/signups/640/attendees?filter=active&fields[Attendee]=active,canceled,waitlisted&per_page=100&offset=0"),
            json!({"data":[
                {"id":"680","type":"Attendee","attributes":{"active":true,"canceled":false,"waitlisted":false,"name":"name-canary"}},
                {"id":"681","type":"Attendee","attributes":{"active":true,"canceled":false,"waitlisted":false}}],
                "meta":{"count":2,"total_count":2}}),
        )
}
fn forms_script() -> Script {
    sunday()
        .page(
            format!("{PEOPLE}/forms?filter=not_archived&per_page=100&offset=0"),
            json!({"data":[{"id":"610","type":"Form","attributes":{"name":"Volunteer interest","archived":false}},
                {"id":"611","type":"Form","attributes":{"name":"Prayer requests","archived":false}}]}),
        )
        .page(
            format!("{PEOPLE}/forms/610/form_submissions?include=person&fields[Person]=name,child&where[created_at][gte]=2026-11-05T12:00:00Z&where[created_at][lt]=2026-11-13T12:00:00Z&order=created_at&per_page=100&offset=0"),
            json!({"data":[
                {"id":"700","type":"FormSubmission","attributes":{"created_at":"2026-11-08T15:00:00Z"},
                    "relationships":{"form":{"data":{"id":"610","type":"Form"}},"person":{"data":{"id":"190","type":"Person"}}}},
                {"id":"701","type":"FormSubmission","attributes":{"created_at":"2026-11-10T15:00:00Z"},
                    "relationships":{"form":{"data":{"id":"610","type":"Form"}},"person":{"data":{"id":"191","type":"Person"}}}}],
                "included":[{"id":"190","type":"Person","attributes":{"name":"Dana Fictional","child":false}},
                    {"id":"191","type":"Person","attributes":{"name":"Emery Fictional","child":false}}]}),
        )
}
fn given(forms: &[&str]) -> Vec<String> {
    forms.iter().map(|f| f.to_string()).collect()
}

#[test]
fn the_recent_window_is_the_eight_days_before_the_check_in_whole_seconds() {
    assert_eq!(
        recent_window(1_794_571_200_000),
        Some(Window {
            starts_at: "2026-11-05T12:00:00Z".into(),
            ends_at: "2026-11-13T12:00:00Z".into(),
        })
    );
    // A start part-way through a second is rounded up, never back.
    assert_eq!(
        recent_window(1_794_571_200_001).unwrap().ends_at,
        "2026-11-13T12:00:01Z"
    );
}

#[test]
fn without_their_own_grant_check_ins_and_registrations_are_never_read_or_recorded() {
    for scopes in ["services", "services-and-operations"] {
        let script = check_ins_script();
        let (capture, _) = church_check(&connected(scopes), &script, None).unwrap();
        assert!(church_urls(&script).is_empty(), "{scopes}");
        assert!(
            capture
                .reads
                .iter()
                .all(|r| !r.collection.starts_with("checkins_")
                    && !r.collection.starts_with("registrations_")
                    && !r.collection.starts_with("people_form")),
            "{scopes}"
        );
        assert!(capture.forms.is_none());
        assert!(
            !serde_json::to_string(&capture)
                .unwrap()
                .contains("\"forms\"")
        );
    }
}

#[test]
fn check_ins_reads_events_rooms_recent_periods_then_counts_for_the_latest_times() {
    let script = check_ins_script();
    let (capture, _) = church_check(&connected("services+check-ins"), &script, None).unwrap();
    assert_eq!(
        church_urls(&script),
        [
            format!("{CI}/events?filter=not_archived&per_page=100&offset=0"),
            format!("{CI}/events/620/locations?per_page=100&offset=0"),
            periods_url("620"),
            format!("{CI}/events/621/locations?per_page=100&offset=0"),
            periods_url("621"),
            // Times that started inside the window, latest first; next Sunday's (632) isn't read.
            counts_url("633"),
            counts_url("631"),
            counts_url("630"),
        ]
    );
    for read in capture
        .reads
        .iter()
        .filter(|r| r.collection.starts_with("checkins_"))
    {
        assert_eq!(read.outcome, "ok", "{}", read.collection);
    }
    assert_eq!(
        ids(&capture, "checkins_locations", |r| r
            .checkins_event_id
            .as_deref()),
        ["620", "621"]
    );
    assert_eq!(
        ids(&capture, "checkins_location_counts", |r| r
            .checkins_event_time_id
            .as_deref()),
        ["633", "631", "630"]
    );
    let periods = reads(&capture, "checkins_event_periods");
    assert_eq!(
        periods[0].window,
        Some(Window {
            starts_at: "2026-11-05T12:00:00Z".into(),
            ends_at: "2026-11-13T12:00:00Z".into(),
        })
    );
    // Names are local labels; no body keeps a name, and no person is named at all.
    assert_eq!(capture.labels["checkins_event:620"], "Sunday Kids");
    assert_eq!(capture.labels["checkins_location:650"], "Nursery");
    let bodies = serde_json::to_string(&capture.reads).unwrap();
    for text in ["Sunday Kids", "Nursery", "name-canary", "age_min"] {
        assert!(!bodies.contains(text), "{text}");
    }
    assert_eq!(capture.names.len(), 2, "only the Services plan's people");
    // A Check-Ins-only grant reads no Calendar, People or Groups.
    assert!(
        reads(&capture, "calendar_rooms")
            .iter()
            .all(|r| r.outcome == NOT_REQUESTED)
    );
    assert!(valid_capture(&capture));
}

#[test]
fn check_ins_counts_are_bounded_and_a_bound_leaves_out_the_oldest_times() {
    let times: Vec<String> = (0..=MAX_CHECKINS_TIMES)
        .map(|i| format!("7{i:02}"))
        .collect();
    // One time an hour on November 8, from 00:00Z: the first one is the oldest.
    let included: Vec<Value> = times
        .iter()
        .enumerate()
        .map(|(i, t)| time_row(t, "620", "660", &format!("2026-11-08T{i:02}:00:00Z")))
        .collect();
    let script = check_ins_script().page(
        periods_url("620"),
        json!({"data":[period_row("660","620","2026-11-08T00:00:00Z","2026-11-09T00:00:00Z")],"included":included}),
    );
    let (capture, _) = church_check(&connected("services+check-ins"), &script, None).unwrap();
    let counted = ids(&capture, "checkins_location_counts", |r| {
        r.checkins_event_time_id.as_deref()
    });
    assert_eq!(counted.len(), MAX_CHECKINS_TIMES);
    assert!(!counted.contains(&times[0]), "the oldest is left out");
    assert!(counted.contains(&times[MAX_CHECKINS_TIMES]));
    let period = reads(&capture, "checkins_event_periods")
        .into_iter()
        .find(|r| r.checkins_event_id.as_deref() == Some("620"))
        .unwrap();
    assert_eq!(period.outcome, TRUNCATED);
    assert!(valid_capture(&capture));
}

#[test]
fn registrations_read_signups_then_count_attendees_of_open_ones_only() {
    let script = registrations_script();
    let (capture, read) =
        church_check(&connected("services+registrations"), &script, None).unwrap();
    assert_eq!(
        church_urls(&script),
        [
            format!("{REG}/signups?filter=unarchived&per_page=100&offset=0"),
            format!(
                "{REG}/signups/640/attendees?filter=active&fields[Attendee]=active,canceled,waitlisted&per_page=100&offset=0"
            ),
        ]
    );
    let attendees = reads(&capture, "registrations_attendees");
    assert_eq!(attendees[0].signup_id.as_deref(), Some("640"));
    assert_eq!(
        attendees[0].body.as_ref().unwrap()["data"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(capture.labels["signup:640"], "Fall retreat");
    assert_eq!(capture.labels["signup:642"], "Picnic");
    // Counting attendees names nobody.
    assert!(read.iter().all(|name| name != "name-canary"));
    assert!(
        !serde_json::to_string(&capture)
            .unwrap()
            .contains("name-canary")
    );
    assert!(valid_capture(&capture));
}

#[test]
fn more_open_signups_than_the_bound_mark_the_signup_list_partly_read() {
    let rows: Vec<Value> = (0..=MAX_SIGNUPS)
        .map(|i| json!({"id":format!("64{i:02}"),"type":"Signup","attributes":{"closed":false}}))
        .collect();
    let script = registrations_script().page(
        format!("{REG}/signups?filter=unarchived&per_page=100&offset=0"),
        json!({"data":rows}),
    );
    let (capture, _) = church_check(&connected("services+registrations"), &script, None).unwrap();
    assert_eq!(
        reads(&capture, "registrations_attendees").len(),
        MAX_SIGNUPS
    );
    assert_eq!(
        reads(&capture, "registrations_signups")[0].outcome,
        TRUNCATED
    );
}

#[test]
fn forms_are_read_only_once_turned_on_and_submissions_only_for_chosen_listed_forms() {
    let script = forms_script();
    let chosen = given(&["610", "612"]);
    let (capture, read) = church_check(
        &connected("services-and-operations"),
        &script,
        Some(&chosen),
    )
    .unwrap();
    assert_eq!(
        church_urls(&script),
        [
            format!("{PEOPLE}/forms?filter=not_archived&per_page=100&offset=0"),
            format!(
                "{PEOPLE}/forms/610/form_submissions?include=person&fields[Person]=name,child&where[created_at][gte]=2026-11-05T12:00:00Z&where[created_at][lt]=2026-11-13T12:00:00Z&order=created_at&per_page=100&offset=0"
            ),
        ],
        "612 isn't in the list, and 611 wasn't chosen"
    );
    assert_eq!(capture.forms.as_deref(), Some(&chosen[..]));
    assert_eq!(
        ids(&capture, "people_form_submissions", |r| r
            .form_id
            .as_deref()),
        ["610"]
    );
    // Who submitted is kept on this Mac with the capture's names, and the name guard learns it.
    assert_eq!(capture.names["190"], "Dana Fictional");
    assert_eq!(capture.names["191"], "Emery Fictional");
    assert!(read.iter().any(|name| name == "Emery Fictional"));
    let bodies = serde_json::to_string(&capture.reads).unwrap();
    assert!(!bodies.contains("Dana Fictional"));
    assert!(!bodies.contains("Volunteer interest"));
    assert_eq!(capture.labels["form:610"], "Volunteer interest");
    assert!(valid_capture(&capture));

    // Turned on with nothing chosen yet: the list only, so Church rules can offer it.
    let script = forms_script();
    let (capture, _) =
        church_check(&connected("services-and-operations"), &script, Some(&[])).unwrap();
    assert_eq!(church_urls(&script).len(), 1);
    assert_eq!(capture.forms.as_deref(), Some(&[][..]));
    assert!(valid_capture(&capture));

    // Without People (a Services-only connection) the list is recorded as not asked, and no
    // submission is read: "not connected for this yet", never "no submissions".
    let script = forms_script();
    let (capture, _) = church_check(&connected("services"), &script, Some(&chosen)).unwrap();
    assert!(church_urls(&script).is_empty());
    assert_eq!(
        outcomes(&capture, "people_forms"),
        [(0, NOT_REQUESTED.to_string())]
    );
    assert!(reads(&capture, "people_form_submissions").is_empty());
    assert!(valid_capture(&capture));
}

#[test]
fn the_check_refuses_too_many_repeated_or_malformed_form_ids_before_reading() {
    let ten: Vec<String> = (0..=MAX_FORMS).map(|i| format!("61{i}")).collect();
    for bad in [
        ten,
        given(&["610", "610"]),
        given(&["0610"]),
        given(&["610/1"]),
    ] {
        let script = forms_script();
        assert_eq!(
            church_check(&connected("services-and-operations"), &script, Some(&bad)).err(),
            Some(SourceError::InvalidRequest),
            "{bad:?}"
        );
        assert!(script.seen().is_empty());
    }
}

#[test]
fn a_product_the_connection_was_not_granted_is_refused_below_the_check_too() {
    let auth = connected("services-and-operations");
    let script = check_ins_script();
    let verified = auth.verify_source(&AtomicBool::new(false)).unwrap();
    for (collection, target) in [
        (Collection::CheckInsEvents, Target::default()),
        (Collection::RegistrationsSignups, Target::default()),
    ] {
        let request =
            SourceRequest::capture_at(auth.binding(), "10", "20", collection, &target, 100, 0)
                .unwrap();
        assert_eq!(
            auth.read_verified_using(&verified, &request, &AtomicBool::new(false), &script)
                .err(),
            Some(SourceError::InvalidRequest)
        );
    }
    assert!(script.seen().is_empty());
}

/// Every church read in one capture: forms, Check-Ins and Registrations.
fn everything() -> SundayCapture {
    let mut script = check_ins_script();
    for (url, page) in registrations_script()
        .pages
        .into_iter()
        .chain(forms_script().pages)
    {
        script.pages.entry(url).or_insert(page);
    }
    let (mut capture, _) = church_check(
        &connected("services-and-operations+check-ins+registrations"),
        &script,
        Some(&given(&["610"])),
    )
    .unwrap();
    capture.completed_at = rfc3339(1_794_571_260_000);
    capture
}

#[test]
fn recordings_keep_church_reads_and_refuse_them_tampered_with() {
    let root = TempDir::new("church-tamper");
    let dir = root.0.join("recordings");
    let capture = everything();
    assert!(valid_capture(&capture));
    let path_id = save_recording(&dir, &capture).unwrap();
    let loaded = load_recording(&dir, "1001", &path_id).unwrap();
    assert_eq!(loaded.kind, "recording");
    assert_eq!(loaded.forms.as_deref(), Some(&given(&["610"])[..]));
    assert_eq!(loaded.labels["signup:640"], "Fall retreat");
    let original: Value =
        serde_json::from_slice(&std::fs::read(dir.join(&path_id)).unwrap()).unwrap();
    let counts = read_index(&original, "checkins_location_counts");
    let periods = read_index(&original, "checkins_event_periods");
    let attendees = read_index(&original, "registrations_attendees");
    let submissions = read_index(&original, "people_form_submissions");
    let events = read_index(&original, "checkins_events");
    type Tamper = Box<dyn Fn(&mut Value)>;
    let tampers: Vec<Tamper> = vec![
        // Counts for an event time no period read placed inside the window (next Sunday's).
        Box::new(move |v| v["reads"][counts]["checkins_event_time_id"] = json!("632")),
        // Another listed event's rooms or periods, with nothing in the body to say so.
        Box::new(move |v| {
            let periods = read_index(v, "checkins_event_periods");
            v["reads"][periods]["checkins_event_id"] = json!("629");
        }),
        Box::new(move |v| {
            v["reads"][submissions]["form_id"] = json!("611");
            for row in v["reads"][submissions]["body"]["data"]
                .as_array_mut()
                .unwrap()
            {
                row["relationships"]["form"]["data"]["id"] = json!("611");
            }
        }),
        Box::new(move |v| {
            let rooms = read_index(v, "checkins_locations");
            v["reads"][rooms]["checkins_event_id"] = json!("629");
        }),
        // A chosen Check-Ins event that isn't an id, or that the rooms and periods weren't read for.
        Box::new(|v| v["checkins_event"] = json!("0620")),
        Box::new(|v| v["checkins_event"] = json!("621")),
        // A period read for another week, or with no window at all.
        Box::new(move |v| {
            v["reads"][periods]["window"] =
                json!({"starts_at":"2026-10-29T12:00:00Z","ends_at":"2026-11-06T12:00:00Z"})
        }),
        Box::new(move |v| {
            v["reads"][periods]
                .as_object_mut()
                .unwrap()
                .remove("window");
        }),
        // Attendees of a signup that wasn't open, or of no listed signup.
        Box::new(move |v| v["reads"][attendees]["signup_id"] = json!("641")),
        Box::new(move |v| v["reads"][attendees]["signup_id"] = json!("699")),
        // Submissions of a form the check wasn't given, or with forms turned off.
        Box::new(move |v| v["reads"][submissions]["form_id"] = json!("611")),
        Box::new(|v| v["forms"] = json!(["611"])),
        Box::new(|v| {
            v.as_object_mut().unwrap().remove("forms");
        }),
        Box::new(|v| v["forms"] = json!(["0610"])),
        // A count, flag or answer that was never kept never comes back in.
        Box::new(move |v| {
            v["reads"][counts]["body"]["data"][0]["attributes"]["first_name"] = json!("name-canary")
        }),
        Box::new(move |v| {
            v["reads"][attendees]["body"]["data"][0]["attributes"]["active"] = json!(false)
        }),
        Box::new(move |v| {
            v["reads"][submissions]["body"]["data"][0]["attributes"]["answers"] =
                json!("care-canary")
        }),
        // A name back in a body, or a label for a row no read holds.
        Box::new(move |v| {
            v["reads"][events]["body"]["data"][0]["attributes"]["name"] = json!("Sunday Kids")
        }),
        Box::new(|v| v["labels"]["checkins_location:999"] = json!("Gym")),
        // Check-Ins and Registrations are only read once granted: never "not asked".
        Box::new(move |v| {
            v["reads"][events]["outcome"] = json!(NOT_REQUESTED);
            v["reads"][events].as_object_mut().unwrap().remove("body");
        }),
    ];
    for (i, tamper) in tampers.iter().enumerate() {
        let mut value = original.clone();
        tamper(&mut value);
        std::fs::write(dir.join(&path_id), serde_json::to_vec(&value).unwrap()).unwrap();
        assert_eq!(
            load_recording(&dir, "1001", &path_id).err(),
            Some(RecordingError::Unavailable),
            "tamper {i}"
        );
    }
    std::fs::write(dir.join(&path_id), serde_json::to_vec(&original).unwrap()).unwrap();
    assert!(load_recording(&dir, "1001", &path_id).is_ok());
}

#[test]
fn a_submission_for_a_child_counts_but_keeps_no_name_no_person_and_teaches_the_guard_nothing() {
    let script = forms_script().page(
        format!("{PEOPLE}/forms/610/form_submissions?include=person&fields[Person]=name,child&where[created_at][gte]=2026-11-05T12:00:00Z&where[created_at][lt]=2026-11-13T12:00:00Z&order=created_at&per_page=100&offset=0"),
        json!({"data":[
            {"id":"700","type":"FormSubmission","attributes":{"created_at":"2026-11-08T15:00:00Z"},
                "relationships":{"form":{"data":{"id":"610","type":"Form"}},"person":{"data":{"id":"190","type":"Person"}}}},
            {"id":"701","type":"FormSubmission","attributes":{"created_at":"2026-11-09T15:00:00Z"},
                "relationships":{"form":{"data":{"id":"610","type":"Form"}},"person":{"data":{"id":"192","type":"Person"}}}},
            {"id":"702","type":"FormSubmission","attributes":{"created_at":"2026-11-10T15:00:00Z"},
                "relationships":{"form":{"data":{"id":"610","type":"Form"}},"person":{"data":{"id":"193","type":"Person"}}}}],
            "included":[{"id":"190","type":"Person","attributes":{"name":"Dana Fictional","child":false}},
                {"id":"192","type":"Person","attributes":{"name":"Kid Fictional-Child","child":true}},
                {"id":"193","type":"Person","attributes":{"name":"Rowan Fictional-Unsaid"}}]}),
    );
    let (capture, read) = church_check(
        &connected("services-and-operations"),
        &script,
        Some(&given(&["610"])),
    )
    .unwrap();
    let submissions = reads(&capture, "people_form_submissions");
    let rows = submissions[0].body.as_ref().unwrap()["data"]
        .as_array()
        .unwrap();
    // Every submission is still counted.
    assert_eq!(rows.len(), 3);
    // Only the adult keeps a person link and a name; the child and the person not said to be an
    // adult keep neither, anywhere: not in the body, names, the guard or a recording.
    let people: Vec<Option<&str>> = rows
        .iter()
        .map(|r| r["relationships"]["person"]["data"]["id"].as_str())
        .collect();
    assert_eq!(people, [Some("190"), None, None]);
    assert_eq!(
        capture.names.get("190").map(String::as_str),
        Some("Dana Fictional")
    );
    assert!(!capture.names.contains_key("192") && !capture.names.contains_key("193"));
    assert!(
        read.iter()
            .all(|name| name != "Kid Fictional-Child" && name != "Rowan Fictional-Unsaid")
    );
    let saved = serde_json::to_string(&capture).unwrap();
    assert!(!saved.contains("Kid Fictional-Child") && !saved.contains("Rowan Fictional-Unsaid"));
    // The stored body keeps, for each linked person, only Planning Center's `child: false` proof.
    assert_eq!(
        submissions[0].body.as_ref().unwrap()["included"],
        json!([{"id":"190","type":"Person","attributes":{"child":false}}])
    );
    assert!(valid_capture(&capture));
}

/// A recording made before a submission's person had to be proved an adult (or tampered with since)
/// can't load: every person link needs its `child: false` proof in the same body, and a proof row
/// carries nothing else.
#[test]
fn a_forms_recording_without_the_adult_proof_for_every_linked_person_is_refused() {
    let root = TempDir::new("forms-proof");
    let dir = root.0.join("recordings");
    let (mut capture, _) = church_check(
        &connected("services-and-operations"),
        &forms_script(),
        Some(&given(&["610"])),
    )
    .unwrap();
    capture.completed_at = rfc3339(1_794_571_260_000);
    let path_id = save_recording(&dir, &capture).unwrap();
    let original: Value =
        serde_json::from_slice(&std::fs::read(dir.join(&path_id)).unwrap()).unwrap();
    let at = read_index(&original, "people_form_submissions");
    assert_eq!(
        original["reads"][at]["body"]["included"],
        json!([{"id":"190","type":"Person","attributes":{"child":false}},{"id":"191","type":"Person","attributes":{"child":false}}])
    );
    type Tamper = Box<dyn Fn(&mut Value)>;
    let tampers: Vec<Tamper> = vec![
        // A pre-fix recording: person links and names, and no proof at all.
        Box::new(move |v| {
            v["reads"][at]["body"]
                .as_object_mut()
                .unwrap()
                .remove("included");
        }),
        // One link without its proof.
        Box::new(move |v| {
            v["reads"][at]["body"]["included"]
                .as_array_mut()
                .unwrap()
                .remove(1);
        }),
        // A proof that isn't one, or that carries a name.
        Box::new(move |v| {
            v["reads"][at]["body"]["included"][0]["attributes"]["child"] = json!(true)
        }),
        Box::new(move |v| {
            v["reads"][at]["body"]["included"][0]["attributes"]["name"] =
                json!("Kid Fictional-Child")
        }),
        Box::new(move |v| v["reads"][at]["body"]["included"][0]["attributes"] = json!({})),
    ];
    for (i, tamper) in tampers.iter().enumerate() {
        let mut value = original.clone();
        tamper(&mut value);
        std::fs::write(dir.join(&path_id), serde_json::to_vec(&value).unwrap()).unwrap();
        assert_eq!(
            load_recording(&dir, "1001", &path_id).err(),
            Some(RecordingError::Unavailable),
            "tamper {i}"
        );
    }
    std::fs::write(dir.join(&path_id), serde_json::to_vec(&original).unwrap()).unwrap();
    assert!(load_recording(&dir, "1001", &path_id).is_ok());
}

#[test]
fn a_chosen_check_ins_event_is_the_only_one_read_and_must_be_listed() {
    let script = check_ins_script();
    let (capture, _) = church_check_with(
        &connected("services+check-ins"),
        &script,
        ChurchReads {
            operations: true,
            forms: None,
            checkins_event: Some("621"),
        },
    )
    .unwrap();
    assert_eq!(
        church_urls(&script),
        [
            format!("{CI}/events?filter=not_archived&per_page=100&offset=0"),
            format!("{CI}/events/621/locations?per_page=100&offset=0"),
            periods_url("621"),
            counts_url("633"),
        ]
    );
    assert_eq!(capture.checkins_event.as_deref(), Some("621"));
    assert!(valid_capture(&capture));
    // Not in Check-Ins' list: the list is read, nothing else.
    let script = check_ins_script();
    let (capture, _) = church_check_with(
        &connected("services+check-ins"),
        &script,
        ChurchReads {
            operations: true,
            forms: None,
            checkins_event: Some("699"),
        },
    )
    .unwrap();
    assert_eq!(church_urls(&script).len(), 1);
    assert!(valid_capture(&capture));
    // A malformed choice is refused before anything is read.
    for bad in ["0621", "621/1", ""] {
        let script = check_ins_script();
        assert_eq!(
            church_check_with(
                &connected("services+check-ins"),
                &script,
                ChurchReads {
                    operations: true,
                    forms: None,
                    checkins_event: Some(bad),
                },
            )
            .err(),
            Some(SourceError::InvalidRequest),
            "{bad}"
        );
        assert!(script.seen().is_empty());
    }
}

#[test]
fn a_recording_with_a_chosen_event_keeps_only_that_events_reads() {
    let script = check_ins_script();
    let (mut capture, _) = church_check_with(
        &connected("services+check-ins"),
        &script,
        ChurchReads {
            operations: true,
            forms: None,
            checkins_event: Some("621"),
        },
    )
    .unwrap();
    assert!(valid_capture(&capture));
    let rooms = capture
        .reads
        .iter()
        .position(|r| r.collection == "checkins_locations")
        .unwrap();
    capture.reads[rooms].checkins_event_id = Some("620".into());
    assert!(!valid_capture(&capture));
}

#[test]
fn review_first_run_h1_a_people_grant_reads_no_rooms_follow_ups_or_groups_until_settings_turn_them_on()
 {
    let operations = |url: &String| {
        url.contains("/calendar/v2") || url.contains("/workflows") || url.contains("/groups/v2")
    };
    // People allowed from a note (the sign-in now holds Calendar, People and Groups), the Settings switch off.
    let script = check_ins_script();
    let (capture, _) = church_check_with(
        &connected("services-and-operations"),
        &script,
        ChurchReads::default(),
    )
    .unwrap();
    assert!(
        script.seen().iter().all(|url| !operations(url)),
        "{:?}",
        script.seen()
    );
    for collection in [
        "calendar_rooms",
        "people_workflows",
        "groups_person_memberships",
    ] {
        assert!(
            capture
                .reads
                .iter()
                .filter(|r| r.collection == collection)
                .all(|r| r.outcome == NOT_REQUESTED),
            "{collection}"
        );
    }
    // Turned on in Settings: they are read.
    let script = check_ins_script();
    church_check_with(
        &connected("services-and-operations"),
        &script,
        ChurchReads {
            operations: true,
            ..ChurchReads::default()
        },
    )
    .unwrap();
    assert!(
        script.seen().iter().any(|url| url.contains("/calendar/v2")),
        "{:?}",
        script.seen()
    );
}
