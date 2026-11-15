//! Setup's Sunday picker over an injected HTTP boundary. Fictional data only.
use super::*;
use crate::{
    credentials::{CredentialStore, StoreError},
    oauth::{AuthError, Binding, Provider, Tokens},
    source::{SourcePage, parse_request, project_page},
};
use serde_json::json;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};

const SECRET: &str = "fictional-native-secret-canary";
const STORED: &str = r#"{"client_id":"fictional-client","organization":"1001","tokens":{"access_token":"fictional-native-secret-canary","refresh_token":null,"token_type":"bearer","expires_in":7200}}"#;
const TYPES: &str =
    "https://api.planningcenteronline.com/services/v2/service_types?per_page=100&offset=0";
const PLANS: &str = "https://api.planningcenteronline.com/services/v2/service_types/1500/plans?filter=future&order=sort_date&per_page=12&offset=0";

struct Store(Option<Vec<u8>>);
impl CredentialStore for Store {
    fn put(&self, _: &str, _: &str, _: &[u8]) -> Result<(), StoreError> {
        panic!("choosing a Sunday never writes credentials")
    }
    fn get(&self, _: &str, _: &str) -> Result<Option<Vec<u8>>, StoreError> {
        Ok(self.0.clone())
    }
    fn delete(&self, _: &str, _: &str) -> Result<(), StoreError> {
        panic!("choosing a Sunday never deletes credentials")
    }
}
struct Identity(&'static str, Arc<AtomicUsize>);
impl Provider for Identity {
    fn organization(&self, access: &str) -> Result<String, AuthError> {
        assert_eq!(access, SECRET);
        self.1.fetch_add(1, Ordering::SeqCst);
        Ok(self.0.into())
    }
    fn exchange(&self, _: &str, _: &str, _: &str) -> Result<Tokens, AuthError> {
        panic!("no acquisition")
    }
    fn refresh(&self, _: &str, _: &str) -> Result<Tokens, AuthError> {
        panic!("no refresh")
    }
    fn revoke(&self, _: &str, _: &str, _: &str) -> Result<(), AuthError> {
        panic!("no revoke")
    }
}
fn controller(organization: &'static str) -> (AuthController, Arc<AtomicUsize>) {
    let checks = Arc::new(AtomicUsize::new(0));
    let auth = AuthController::new(
        Binding {
            workspace: "local:1001".into(),
            organization: "1001".into(),
            client_id: "fictional-client".into(),
        },
        Arc::new(Store(Some(STORED.as_bytes().to_vec()))),
        Arc::new(Identity(organization, checks.clone())),
        Arc::new(|| 0),
    )
    .unwrap();
    (auth, checks)
}
/// Answers one URL with one raw page (or error) and records every URL asked for.
struct Page {
    url: &'static str,
    answer: Result<Value, SourceError>,
    seen: Mutex<Vec<String>>,
}
impl Page {
    fn new(url: &'static str, answer: Result<Value, SourceError>) -> Self {
        Self {
            url,
            answer,
            seen: Mutex::new(Vec::new()),
        }
    }
}
impl SourceHttp for Page {
    fn read(&self, request: &SourceRequest, access: &str) -> Result<SourcePage, SourceError> {
        assert_eq!(access, SECRET);
        self.seen.lock().unwrap().push(request.url());
        assert_eq!(request.url(), self.url);
        let raw = self.answer.clone()?;
        project_page(
            request,
            &serde_json::to_vec(&raw).unwrap(),
            &Default::default(),
        )
    }
}
fn types_page() -> Value {
    json!({
        "data": [
            {"type": "ServiceType", "id": "1500", "attributes": {"name": "Sunday  Morning\u{202E}", "archived_at": null, "deleted_at": null,
              "permissions": "secret-canary", "sequence": 0, "frequency": "Weekly"},
             "relationships": {"parent": {"data": {"type": "Folder", "id": "9"}}}, "links": {"self": "https://example.invalid/canary"}},
            {"type": "ServiceType", "id": "1501", "attributes": {"name": "Youth Night", "archived_at": "2026-01-04T12:00:00Z"}},
            {"type": "ServiceType", "id": "1502", "attributes": {"name": null}},
        ],
        "meta": {"count": 3, "total_count": 3, "parent": {"type": "Organization", "id": "1001"}},
    })
}
fn plans_page() -> Value {
    json!({
        "data": [
            {"type": "Plan", "id": "92902300", "attributes": {"sort_date": "2026-12-06T09:00:00Z", "dates": "December 6, 2026", "title": null,
              "series_title": "Advent", "plan_notes_count": 3, "public": true},
             "relationships": {"service_type": {"data": {"type": "ServiceType", "id": "1500"}}, "created_by": {"data": {"type": "Person", "id": "77"}}}},
            {"type": "Plan", "id": "92902197", "attributes": {"sort_date": "2026-11-29T09:00:00Z", "dates": "November 29, 2026",
              "title": "Ozzie Demo — Main Sunday (fictional)", "series_title": null},
             "relationships": {"service_type": {"data": {"type": "ServiceType", "id": "1500"}}}},
            {"type": "Plan", "id": "92902400", "attributes": {"sort_date": null, "dates": "No dates", "title": "Someday"},
             "relationships": {"service_type": {"data": {"type": "ServiceType", "id": "1500"}}}},
        ],
        "meta": {"count": 3, "total_count": 3, "parent": {"type": "ServiceType", "id": "1500"}},
    })
}

#[test]
fn the_picker_reads_are_two_exact_get_urls_with_the_services_version() {
    let binding = Binding {
        workspace: "local:1001".into(),
        organization: "1001".into(),
        client_id: "fictional-client".into(),
    };
    let http = NativeSourceHttp::new().unwrap();
    for (request, url) in [
        (
            SourceRequest::capture_at(
                &binding,
                "",
                "",
                Collection::ServiceTypes,
                &Target::default(),
                SERVICE_TYPES,
                0,
            ),
            TYPES,
        ),
        (
            SourceRequest::capture_at(
                &binding,
                "1500",
                "",
                Collection::UpcomingPlans,
                &Target::default(),
                UPCOMING,
                0,
            ),
            PLANS,
        ),
    ] {
        let request = request.unwrap();
        let built = http.build(&request, SECRET).unwrap();
        assert_eq!(built.method(), reqwest::Method::GET);
        assert!(built.body().is_none());
        assert_eq!(built.url().as_str(), url);
        assert_eq!(built.headers()["x-pco-api-version"], "2018-11-01");
    }
}

#[test]
fn a_picker_read_names_only_the_ids_it_needs_and_never_reaches_the_stdin_protocol() {
    let binding = Binding {
        workspace: "local:1001".into(),
        organization: "1001".into(),
        client_id: "fictional-client".into(),
    };
    let make = |collection, service_type: &str, plan: &str, target: Target| {
        SourceRequest::capture_at(&binding, service_type, plan, collection, &target, 12, 0).err()
    };
    let invalid = Some(SourceError::InvalidRequest);
    assert_eq!(
        make(Collection::ServiceTypes, "1500", "", Target::default()),
        invalid
    );
    assert_eq!(
        make(Collection::ServiceTypes, "", "20", Target::default()),
        invalid
    );
    assert_eq!(
        make(Collection::ServiceTypes, "", "", Target::team("70")),
        invalid
    );
    assert_eq!(
        make(Collection::UpcomingPlans, "", "", Target::default()),
        invalid
    );
    assert_eq!(
        make(Collection::UpcomingPlans, "1500", "20", Target::default()),
        invalid
    );
    for bad in ["0150", "15x", "1500/../1", "1500?filter=past", " 1500"] {
        assert_eq!(
            make(Collection::UpcomingPlans, bad, "", Target::default()),
            invalid,
            "{bad}"
        );
    }
    // A Sunday read still names both.
    assert_eq!(
        make(Collection::Plan, "1500", "", Target::default()),
        invalid
    );
    assert_eq!(
        make(Collection::Organization, "", "", Target::default()),
        invalid
    );
    for c in ["service_types", "upcoming_plans"] {
        let text = format!(
            r#"{{"version":1,"workspace":"fictional-workspace","organization":"1001","client_id":"fictional-client","service_type_id":"","plan_id":"","collection":"{c}","per_page":12,"offset":0}}"#
        );
        assert_eq!(parse_request(text.as_bytes()).err(), invalid, "{c}");
    }
}

#[test]
fn service_types_keep_ids_and_local_names_only_and_skip_archived_ones() {
    let (auth, checks) = controller("1001");
    let http = Page::new(TYPES, Ok(types_page()));
    let choices = service_types_using(&auth, &AtomicBool::new(false), &http).unwrap();
    assert_eq!(
        checks.load(Ordering::SeqCst),
        1,
        "the organization is checked first"
    );
    assert_eq!(
        serde_json::to_value(&choices).unwrap(),
        json!({"items": [{"id": "1500", "name": "Sunday Morning"}, {"id": "1502", "name": null}], "more": false})
    );
    // The projected page keeps no name in its body and nothing it wasn't asked for.
    let request = SourceRequest::capture_at(
        auth.binding(),
        "",
        "",
        Collection::ServiceTypes,
        &Target::default(),
        SERVICE_TYPES,
        0,
    )
    .unwrap();
    let page = project_page(
        &request,
        &serde_json::to_vec(&types_page()).unwrap(),
        &Default::default(),
    )
    .unwrap();
    let wire = page.envelope().to_string();
    for canary in [
        "Sunday",
        "Youth",
        "secret-canary",
        "Weekly",
        "Folder",
        "example.invalid",
    ] {
        assert!(!wire.contains(canary), "{canary} survived: {wire}");
    }
}

#[test]
fn upcoming_plans_are_that_service_types_dated_plans_soonest_first() {
    let (auth, _) = controller("1001");
    let http = Page::new(PLANS, Ok(plans_page()));
    let choices = upcoming_plans_using(&auth, "1500", &AtomicBool::new(false), &http).unwrap();
    assert_eq!(
        serde_json::to_value(&choices).unwrap(),
        json!({"items": [
            {"id": "92902197", "sort_date": "2026-11-29T09:00:00Z", "dates": "November 29, 2026", "title": "Ozzie Demo — Main Sunday (fictional)", "series_title": null},
            {"id": "92902300", "sort_date": "2026-12-06T09:00:00Z", "dates": "December 6, 2026", "title": null, "series_title": "Advent"},
        ], "more": false})
    );
    // A plan of another service type, or a page about another one, is refused, not shown.
    let mut other = plans_page();
    other["data"][0]["relationships"]["service_type"]["data"]["id"] = json!("1501");
    let mut parent = plans_page();
    parent["meta"]["parent"]["id"] = json!("1501");
    let mut unlinked = plans_page();
    unlinked["data"][1]["relationships"] = json!({});
    for raw in [other, parent, unlinked] {
        let http = Page::new(PLANS, Ok(raw));
        assert_eq!(
            upcoming_plans_using(&auth, "1500", &AtomicBool::new(false), &http).err(),
            Some(SourceError::InvalidResponse)
        );
    }
}

#[test]
fn more_than_one_page_says_so_and_a_next_link_must_keep_the_same_query() {
    let (auth, _) = controller("1001");
    let next = "https://api.planningcenteronline.com/services/v2/service_types/1500/plans?filter=future&order=sort_date&per_page=12&offset=12";
    let mut paged = plans_page();
    paged["meta"]["next"] = json!({"offset": 12});
    paged["meta"]["total_count"] = json!(20);
    paged["links"] = json!({"next": next});
    let http = Page::new(PLANS, Ok(paged.clone()));
    assert!(
        upcoming_plans_using(&auth, "1500", &AtomicBool::new(false), &http)
            .unwrap()
            .more
    );
    // A next link that drops the future filter, points at another host, or at another service
    // type's plans isn't the same list.
    for link in [
        next.replace("filter=future&", ""),
        next.replace("api.planningcenteronline.com", "api.example.invalid"),
        next.replace("https://", "http://"),
        next.replace("service_types/1500/", "service_types/1501/"),
    ] {
        paged["links"]["next"] = json!(link);
        let http = Page::new(PLANS, Ok(paged.clone()));
        assert_eq!(
            upcoming_plans_using(&auth, "1500", &AtomicBool::new(false), &http).err(),
            Some(SourceError::InvalidResponse),
            "{link}"
        );
    }
    // The same for the service types' next link.
    let types_next =
        "https://api.planningcenteronline.com/services/v2/service_types?per_page=100&offset=100";
    let mut types = types_page();
    types["meta"]["next"] = json!({"offset": 100});
    types["meta"]["total_count"] = json!(150);
    for (link, ok) in [
        (types_next.to_owned(), true),
        (
            types_next.replace("api.planningcenteronline.com", "api.example.invalid"),
            false,
        ),
        (
            types_next.replace("service_types?", "service_types/1500/plans?"),
            false,
        ),
    ] {
        types["links"] = json!({"next": link});
        let http = Page::new(TYPES, Ok(types.clone()));
        let read = service_types_using(&auth, &AtomicBool::new(false), &http);
        if ok {
            assert!(read.unwrap().more, "{link}");
        } else {
            assert_eq!(read.err(), Some(SourceError::InvalidResponse), "{link}");
        }
    }
}

#[test]
fn more_is_told_from_the_total_alone_counting_every_row_planning_center_sent() {
    let (auth, _) = controller("1001");
    // No next link, but Planning Center counts more plans than this page holds.
    let mut plans = plans_page();
    plans["meta"]["total_count"] = json!(20);
    let http = Page::new(PLANS, Ok(plans));
    assert!(
        upcoming_plans_using(&auth, "1500", &AtomicBool::new(false), &http)
            .unwrap()
            .more
    );
    let mut types = types_page();
    types["meta"]["total_count"] = json!(150);
    let http = Page::new(TYPES, Ok(types));
    assert!(
        service_types_using(&auth, &AtomicBool::new(false), &http)
            .unwrap()
            .more
    );
    // Rows skipped locally (archived, undated) still count as sent: a total equal to the rows
    // Planning Center sent is the whole list.
    let http = Page::new(TYPES, Ok(types_page()));
    let read = service_types_using(&auth, &AtomicBool::new(false), &http).unwrap();
    assert_eq!((read.items.len(), read.more), (2, false));
    let http = Page::new(PLANS, Ok(plans_page()));
    let read = upcoming_plans_using(&auth, "1500", &AtomicBool::new(false), &http).unwrap();
    assert_eq!((read.items.len(), read.more), (2, false));
}

#[test]
fn service_types_must_be_about_this_organization() {
    let (auth, _) = controller("1001");
    for parent in [
        json!({"type": "Organization", "id": "2002"}),
        json!({"type": "Folder", "id": "9"}),
        json!({"type": "ServiceType", "id": "1001"}),
        json!({"type": "Organization"}),
    ] {
        let mut types = types_page();
        types["meta"]["parent"] = parent.clone();
        let http = Page::new(TYPES, Ok(types));
        assert_eq!(
            service_types_using(&auth, &AtomicBool::new(false), &http).err(),
            Some(SourceError::InvalidResponse),
            "{parent}"
        );
    }
}

#[test]
fn another_organization_a_refusal_or_a_cancel_reads_nothing_and_keeps_its_reason() {
    let (other, _) = controller("2002");
    let http = Page::new(TYPES, Ok(types_page()));
    assert_eq!(
        service_types_using(&other, &AtomicBool::new(false), &http).err(),
        Some(SourceError::OrganizationUnverified)
    );
    assert!(
        http.seen.lock().unwrap().is_empty(),
        "nothing is read for another organization"
    );
    let (auth, _) = controller("1001");
    for error in [
        SourceError::Denied,
        SourceError::ProviderFailure,
        SourceError::RateLimited(Some(30)),
    ] {
        let http = Page::new(TYPES, Err(error));
        assert_eq!(
            service_types_using(&auth, &AtomicBool::new(false), &http).err(),
            Some(error)
        );
    }
    let http = Page::new(PLANS, Ok(plans_page()));
    assert_eq!(
        upcoming_plans_using(&auth, "1500", &AtomicBool::new(true), &http).err(),
        Some(SourceError::Cancelled)
    );
    assert!(http.seen.lock().unwrap().is_empty());
}

/// Holds the controller in a read of the service types until the test lets it finish.
struct Held {
    entered: Mutex<Option<std::sync::mpsc::Sender<()>>>,
    release: Mutex<std::sync::mpsc::Receiver<()>>,
}
impl SourceHttp for Held {
    fn read(&self, request: &SourceRequest, access: &str) -> Result<SourcePage, SourceError> {
        assert_eq!(access, SECRET);
        let raw = if request.url() == TYPES {
            if let Some(entered) = self.entered.lock().unwrap().take() {
                entered.send(()).unwrap();
                self.release.lock().unwrap().recv().unwrap();
            }
            types_page()
        } else {
            assert_eq!(request.url(), PLANS);
            plans_page()
        };
        project_page(
            request,
            &serde_json::to_vec(&raw).unwrap(),
            &Default::default(),
        )
    }
}

#[test]
fn a_picker_read_waits_for_the_controller_instead_of_answering_busy() {
    let (auth, _) = controller("1001");
    let (entered, inside) = std::sync::mpsc::channel();
    let (release, released) = std::sync::mpsc::channel();
    let http = Held {
        entered: Mutex::new(Some(entered)),
        release: Mutex::new(released),
    };
    std::thread::scope(|scope| {
        let first = scope.spawn(|| service_types_using(&auth, &AtomicBool::new(false), &http));
        inside.recv().unwrap();
        // The controller is mid-read; the next picker read waits for it rather than failing.
        let second =
            scope.spawn(|| upcoming_plans_using(&auth, "1500", &AtomicBool::new(false), &http));
        std::thread::sleep(std::time::Duration::from_millis(100));
        let waited = !second.is_finished();
        // Released before any assertion, so a failure can't leave the first read blocked.
        release.send(()).unwrap();
        let (first, second) = (first.join().unwrap(), second.join().unwrap());
        assert!(waited, "the second read waits");
        assert_eq!(first.unwrap().items.len(), 2);
        assert_eq!(second.err(), None, "not busy");
    });
}

#[test]
fn waiting_retries_only_busy_and_stops_at_its_bound_or_a_cancel() {
    use std::time::{Duration, Instant};
    let tries = AtomicUsize::new(0);
    let busy_twice = || match tries.fetch_add(1, Ordering::SeqCst) {
        0 | 1 => Err(SourceError::Busy),
        _ => Ok("read"),
    };
    assert_eq!(
        waiting(Duration::from_secs(5), &AtomicBool::new(false), busy_twice),
        Ok("read")
    );
    assert_eq!(tries.load(Ordering::SeqCst), 3);
    // Any other answer is final at once.
    let tries = AtomicUsize::new(0);
    let denied = || {
        tries.fetch_add(1, Ordering::SeqCst);
        Err::<(), _>(SourceError::Denied)
    };
    assert_eq!(
        waiting(Duration::from_secs(5), &AtomicBool::new(false), denied),
        Err(SourceError::Denied)
    );
    assert_eq!(tries.load(Ordering::SeqCst), 1);
    // Still busy at the bound: busy, after more than one try.
    let tries = AtomicUsize::new(0);
    let always = || {
        tries.fetch_add(1, Ordering::SeqCst);
        Err::<(), _>(SourceError::Busy)
    };
    let started = Instant::now();
    assert_eq!(
        waiting(Duration::from_millis(120), &AtomicBool::new(false), always),
        Err(SourceError::Busy)
    );
    assert!(started.elapsed() >= Duration::from_millis(120));
    assert!(started.elapsed() < Duration::from_secs(2));
    assert!(tries.load(Ordering::SeqCst) > 1);
    // A cancel ends the wait.
    let cancelled = AtomicBool::new(true);
    assert_eq!(
        waiting(Duration::from_secs(5), &cancelled, || Err::<(), _>(
            SourceError::Busy
        )),
        Err(SourceError::Cancelled)
    );
    assert_eq!(WAIT_FOR_CONTROLLER, Duration::from_secs(10));
}
