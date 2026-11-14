use ozzie_native_auth::{oauth::*, provider::*};
use std::sync::atomic::{AtomicUsize, Ordering};
use zeroize::Zeroizing;

struct FictionalHttp {
    status: u16,
    body: Vec<u8>,
    error: Option<AuthError>,
    calls: AtomicUsize,
}
impl Http for FictionalHttp {
    fn send(
        &self,
        endpoint: Endpoint,
        form: Option<&str>,
        bearer: Option<&str>,
    ) -> Result<Response, AuthError> {
        assert_eq!(endpoint, Endpoint::UserInfo);
        assert!(form.is_none());
        assert_eq!(bearer, Some("fictional-access-canary"));
        self.calls.fetch_add(1, Ordering::SeqCst);
        if let Some(error) = &self.error {
            return Err(error.clone());
        }
        Ok(Response {
            status: self.status,
            body: Zeroizing::new(self.body.clone()),
        })
    }
}
fn response(status: u16, body: &str) -> PcoProvider<FictionalHttp> {
    PcoProvider(FictionalHttp {
        status,
        body: body.as_bytes().into(),
        error: None,
        calls: AtomicUsize::new(0),
    })
}
fn diagnostic(value: &OrganizationDiagnostic) -> serde_json::Value {
    serde_json::to_value(value).unwrap()
}
#[test]
fn userinfo_rate_limit_is_a_provider_failure_not_an_organization_contradiction() {
    // Being asked to slow down says nothing about which organization the credential has.
    let p = response(429, "fictional-body-canary");
    let error = p
        .organization_detailed("fictional-access-canary")
        .unwrap_err();
    assert_eq!(error.error, AuthError::ProviderFailure);
    assert_eq!(
        diagnostic(&error.diagnostic),
        serde_json::json!({"version":1,"stage":"userinfo","reason":"provider-failure"})
    );
    assert_eq!(
        p.organization("fictional-access-canary").err(),
        Some(AuthError::ProviderFailure)
    );
    assert_eq!(p.0.calls.load(Ordering::SeqCst), 2);
}
#[test]
fn provider_classifies_failures_from_one_existing_userinfo_request_without_changing_outer_errors() {
    for (status, body, reason) in [
        (401, "fictional-body-canary", "access-denied"),
        (403, "fictional-body-canary", "access-denied"),
        (400, "fictional-body-canary", "provider-failure"),
        (500, "fictional-body-canary", "provider-failure"),
        (302, "fictional-body-canary", "provider-failure"),
        (201, "{}", "provider-failure"),
        (200, "not-json-fictional-canary", "invalid-json"),
        (200, "null", "invalid-json"),
        (200, "false", "invalid-json"),
        (200, "42", "invalid-json"),
        (200, "{}", "organization-id-missing"),
        (
            200,
            r#"{"organization_id":null,"name":"fictional-name-canary","email":"fictional@example.invalid"}"#,
            "organization-id-missing",
        ),
    ] {
        let p = response(status, body);
        let error = p
            .organization_detailed("fictional-access-canary")
            .unwrap_err();
        assert_eq!(error.error, AuthError::OrganizationUnverified);
        assert_eq!(
            diagnostic(&error.diagnostic),
            serde_json::json!({"version":1,"stage":"userinfo","reason":reason})
        );
        assert_eq!(p.0.calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            p.organization("fictional-access-canary").err(),
            Some(AuthError::OrganizationUnverified)
        );
        assert_eq!(p.0.calls.load(Ordering::SeqCst), 2);
    }
}

use ozzie_native_auth::credentials::{CredentialStore, StoreError};
use std::sync::{Arc, Mutex, atomic::AtomicU64};
#[derive(Default)]
struct MemoryStore {
    value: Mutex<Option<Vec<u8>>>,
    reads: AtomicUsize,
    writes: AtomicUsize,
}
impl CredentialStore for MemoryStore {
    fn get(&self, _: &str, _: &str) -> Result<Option<Vec<u8>>, StoreError> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        Ok(self.value.lock().unwrap().clone())
    }
    fn put(&self, _: &str, _: &str, value: &[u8]) -> Result<(), StoreError> {
        self.writes.fetch_add(1, Ordering::SeqCst);
        *self.value.lock().unwrap() = Some(value.to_vec());
        Ok(())
    }
    fn delete(&self, _: &str, _: &str) -> Result<(), StoreError> {
        *self.value.lock().unwrap() = None;
        Ok(())
    }
}
struct FlowHttp {
    reply: Mutex<(u16, String)>,
    calls: Mutex<Vec<Endpoint>>,
    pause: Mutex<
        Option<(
            std::sync::mpsc::SyncSender<()>,
            std::sync::mpsc::Receiver<()>,
        )>,
    >,
    userinfo_error: Mutex<Option<AuthError>>,
    token_failure: std::sync::atomic::AtomicBool,
}
impl FlowHttp {
    fn reply(&self, status: u16, body: &str) {
        *self.reply.lock().unwrap() = (status, body.into());
    }
}
struct SharedHttp(Arc<FlowHttp>);
impl Http for SharedHttp {
    fn send(
        &self,
        endpoint: Endpoint,
        _: Option<&str>,
        _: Option<&str>,
    ) -> Result<Response, AuthError> {
        self.0.calls.lock().unwrap().push(endpoint);
        let (status, body) = if endpoint == Endpoint::UserInfo {
            let reply = self.0.reply.lock().unwrap().clone();
            if let Some((started, release)) = self.0.pause.lock().unwrap().take() {
                started.send(()).unwrap();
                release
                    .recv_timeout(std::time::Duration::from_secs(5))
                    .unwrap();
            }
            if let Some(error) = self.0.userinfo_error.lock().unwrap().clone() {
                return Err(error);
            }
            reply
        } else {
            if self.0.token_failure.load(Ordering::SeqCst) {
                return Err(AuthError::ProviderFailure);
            }
            (200, r#"{"access_token":"fictional-access-canary","refresh_token":"fictional-refresh-canary","token_type":"bearer","expires_in":7200}"#.into())
        };
        Ok(Response {
            status,
            body: Zeroizing::new(body.into_bytes()),
        })
    }
}
fn binding() -> Binding {
    Binding {
        workspace: "fictional-workspace".into(),
        organization: "1001".into(),
        client_id: "fictional-client".into(),
    }
}
fn callback(auth: &AuthController) -> String {
    let url = url::Url::parse(&auth.begin().unwrap()).unwrap();
    let state = url
        .query_pairs()
        .find(|(key, _)| key == "state")
        .unwrap()
        .1
        .into_owned();
    format!("{REDIRECT_URI}?code=fictional-code-canary&state={state}")
}
fn fixture() -> (
    AuthController,
    Arc<MemoryStore>,
    Arc<FlowHttp>,
    Arc<AtomicU64>,
) {
    let store = Arc::new(MemoryStore::default());
    let http = Arc::new(FlowHttp {
        reply: Mutex::new((200, r#"{"organization_id":1001}"#.into())),
        calls: Mutex::new(vec![]),
        pause: Mutex::new(None),
        userinfo_error: Mutex::new(None),
        token_failure: std::sync::atomic::AtomicBool::new(false),
    });
    let clock = Arc::new(AtomicU64::new(0));
    let now = clock.clone();
    let auth = AuthController::new(
        binding(),
        store.clone(),
        Arc::new(PcoProvider(SharedHttp(http.clone()))),
        Arc::new(move || now.load(Ordering::SeqCst)),
    )
    .unwrap();
    (auth, store, http, clock)
}
#[test]
fn mismatch_is_published_atomically_with_failure_and_never_saves_on_exchange_or_refresh() {
    for refresh in [false, true] {
        let (auth, store, http, _) = fixture();
        if refresh {
            auth.callback(&callback(&auth)).unwrap();
        }
        let writes_before = store.writes.load(Ordering::SeqCst);
        let reads_before = store.reads.load(Ordering::SeqCst);
        http.calls.lock().unwrap().clear();
        http.reply(200, r#"{"organization_id":987654321,"name":"fictional-name-canary","email":"fictional-email-canary"}"#);
        let result = if refresh {
            auth.refresh()
        } else {
            auth.callback(&callback(&auth))
        };
        assert_eq!(result.err(), Some(AuthError::OrganizationUnverified));
        let status = auth.status().unwrap();
        assert_eq!(status.state, ConnectionState::Failed);
        assert_eq!(status.problem, Some(AuthError::OrganizationUnverified));
        assert!(status.checked_at_ms.is_none());
        assert_eq!(
            diagnostic(status.organization_diagnostic.as_ref().unwrap()),
            serde_json::json!({"version":1,"stage":"organization-binding","reason":"organization-mismatch"})
        );
        assert_eq!(store.writes.load(Ordering::SeqCst), writes_before);
        assert_eq!(
            store.reads.load(Ordering::SeqCst),
            reads_before + usize::from(refresh)
        );
        assert_eq!(
            *http.calls.lock().unwrap(),
            [Endpoint::Token, Endpoint::UserInfo]
        );
        let json = serde_json::to_string(&status).unwrap();
        for canary in [
            "987654321",
            "fictional-name-canary",
            "fictional-email-canary",
            "fictional-access-canary",
            "fictional-refresh-canary",
            "fictional-code-canary",
            "organization_id",
            "http:",
        ] {
            assert!(!json.contains(canary));
        }
    }
}

#[test]
fn invalid_ids_stay_denied_and_valid_number_string_and_original_projection_controls_stay_accepted()
{
    for value in [
        "false",
        "true",
        "[]",
        "{}",
        "1.1",
        "1.0",
        "-1",
        "0",
        "18446744073709551616",
        r#""""#,
        r#""0""#,
        r#""01""#,
        r#""1.0""#,
        r#"" 1001""#,
        r#""+1001""#,
        r#""fictional-actual-id-canary""#,
        r#""100000000000000000000000000000000""#,
    ] {
        let p = response(200, &format!(r#"{{"organization_id":{value}}}"#));
        let failure = p
            .organization_detailed("fictional-access-canary")
            .unwrap_err();
        assert_eq!(failure.error, AuthError::OrganizationUnverified);
        assert_eq!(
            diagnostic(&failure.diagnostic),
            serde_json::json!({"version":1,"stage":"userinfo","reason":"organization-id-invalid"})
        );
        assert_eq!(p.0.calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            p.organization("fictional-access-canary").err(),
            Some(AuthError::OrganizationUnverified)
        );
    }
    for (body, id) in [
        (
            r#"{"organization_id":1001,"name":"fictional-name-canary","email":"fictional-email-canary","id_token":"fictional-id-token-canary"}"#,
            "1001",
        ),
        (r#"{"organization_id":"1001"}"#, "1001"),
        (
            r#"{"organization_id":18446744073709551615}"#,
            "18446744073709551615",
        ),
        (
            r#"{"organization_id":"10000000000000000000000000000000"}"#,
            "10000000000000000000000000000000",
        ),
        ("[1001]", "1001"),
    ] {
        let p = response(200, body);
        assert_eq!(
            p.organization_detailed("fictional-access-canary").unwrap(),
            id
        );
        assert_eq!(p.organization("fictional-access-canary").unwrap(), id);
        assert_eq!(p.0.calls.load(Ordering::SeqCst), 2);
    }
    for body in [
        r#"{"organization_id":1001,"organization_id":1001}"#,
        r#"{"organization_id":1001} trailing"#,
        "[1001,1002]",
        "\"fictional-string-root\"",
    ] {
        let failure = response(200, body)
            .organization_detailed("fictional-access-canary")
            .unwrap_err();
        assert_eq!(diagnostic(&failure.diagnostic)["reason"], "invalid-json");
    }
}
#[test]
fn transport_keeps_original_outer_error_and_closed_metadata_never_contains_body_or_credentials() {
    for outer in [
        AuthError::ProviderFailure,
        AuthError::OrganizationUnverified,
    ] {
        let mut p = response(200, "fictional-body-canary");
        p.0.error = Some(outer.clone());
        let failure = p
            .organization_detailed("fictional-access-canary")
            .unwrap_err();
        assert_eq!(failure.error, outer);
        let json = serde_json::to_string(&failure.diagnostic).unwrap();
        assert_eq!(
            json,
            r#"{"version":1,"stage":"userinfo","reason":"transport-failure"}"#
        );
        assert_eq!(p.organization("fictional-access-canary").err(), Some(outer));
    }
}
struct LegacyProvider {
    result: Mutex<Result<String, AuthError>>,
    calls: AtomicUsize,
}
fn legacy() -> LegacyProvider {
    LegacyProvider {
        result: Mutex::new(Err(AuthError::OrganizationUnverified)),
        calls: AtomicUsize::new(0),
    }
}
fn fictional_tokens() -> Tokens {
    Tokens {
        access_token: "fictional-access-canary".into(),
        refresh_token: Some("fictional-refresh-canary".into()),
        token_type: "bearer".into(),
        expires_in: 7200,
    }
}
impl Provider for LegacyProvider {
    fn exchange(&self, _: &str, _: &str, _: &str) -> Result<Tokens, AuthError> {
        Ok(fictional_tokens())
    }
    fn organization(&self, _: &str) -> Result<String, AuthError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.result.lock().unwrap().clone()
    }
    fn refresh(&self, _: &str, _: &str) -> Result<Tokens, AuthError> {
        Ok(fictional_tokens())
    }
    fn revoke(&self, _: &str, _: &str, _: &str) -> Result<(), AuthError> {
        Ok(())
    }
}
#[test]
fn unchanged_legacy_provider_gets_unclassified_adapter_without_invented_origin() {
    let failure = legacy()
        .organization_detailed("fictional-access-canary")
        .unwrap_err();
    assert_eq!(failure.error, AuthError::OrganizationUnverified);
    assert_eq!(
        diagnostic(&failure.diagnostic),
        serde_json::json!({"version":1,"stage":"userinfo","reason":"unclassified"})
    );
}
#[test]
fn every_userinfo_failure_is_atomic_on_controller_exchange_and_refresh_with_no_extra_io() {
    for refresh in [false, true] {
        for (status_code, body, reason) in [
            (401, "fictional-body-canary", "access-denied"),
            (503, "fictional-body-canary", "provider-failure"),
            (200, "fictional-malformed-body-canary", "invalid-json"),
            (
                200,
                r#"{"organization_id":null}"#,
                "organization-id-missing",
            ),
            (
                200,
                r#"{"organization_id":"fictional-actual-id-canary"}"#,
                "organization-id-invalid",
            ),
        ] {
            let (auth, store, http, _) = fixture();
            assert!(auth.status().unwrap().organization_diagnostic.is_none());
            assert!(
                !serde_json::to_string(&auth.status().unwrap())
                    .unwrap()
                    .contains("organization_diagnostic")
            );
            if refresh {
                auth.callback(&callback(&auth)).unwrap();
            }
            let writes = store.writes.load(Ordering::SeqCst);
            let reads = store.reads.load(Ordering::SeqCst);
            http.calls.lock().unwrap().clear();
            http.reply(status_code, body);
            let error = if refresh {
                auth.refresh()
            } else {
                auth.callback(&callback(&auth))
            }
            .unwrap_err();
            assert_eq!(error, AuthError::OrganizationUnverified);
            let status = auth.status().unwrap();
            assert_eq!(status.state, ConnectionState::Failed);
            assert_eq!(status.problem, Some(AuthError::OrganizationUnverified));
            assert!(status.checked_at_ms.is_none());
            assert_eq!(
                diagnostic(status.organization_diagnostic.as_ref().unwrap()),
                serde_json::json!({"version":1,"stage":"userinfo","reason":reason})
            );
            assert_eq!(store.writes.load(Ordering::SeqCst), writes);
            assert_eq!(
                store.reads.load(Ordering::SeqCst),
                reads + usize::from(refresh)
            );
            assert_eq!(
                *http.calls.lock().unwrap(),
                [Endpoint::Token, Endpoint::UserInfo]
            );
            let json = serde_json::to_string(&status).unwrap();
            for canary in [
                body,
                "fictional-actual-id-canary",
                "fictional-access-canary",
                "fictional-name-canary",
                "fictional-email-canary",
            ] {
                assert!(!json.contains(canary));
            }
        }
    }
}
#[test]
fn begin_success_cancel_expiry_and_new_failure_clear_previous_metadata_without_status_reads() {
    let (auth, store, http, clock) = fixture();
    http.reply(403, "fictional-body-canary");
    assert_eq!(
        auth.callback(&callback(&auth)).err(),
        Some(AuthError::OrganizationUnverified)
    );
    assert!(auth.status().unwrap().organization_diagnostic.is_some());
    let next = callback(&auth);
    let waiting = auth.status().unwrap();
    assert_eq!(waiting.state, ConnectionState::Waiting);
    assert!(waiting.organization_diagnostic.is_none());
    assert!(waiting.problem.is_none());
    http.reply(200, r#"{"organization_id":1001}"#);
    let success = auth.callback(&next).unwrap();
    assert_eq!(success.state, ConnectionState::Connected);
    assert!(success.organization_diagnostic.is_none());
    http.reply(403, "fictional-body-canary");
    assert!(auth.refresh().is_err());
    assert!(auth.status().unwrap().organization_diagnostic.is_some());
    http.reply(200, r#"{"organization_id":"1001"}"#);
    assert!(auth.refresh().unwrap().organization_diagnostic.is_none());
    http.reply(403, "fictional-body-canary");
    assert!(auth.refresh().is_err());
    auth.cancel();
    let cancelled = auth.status().unwrap();
    assert_eq!(cancelled.state, ConnectionState::Cancelled);
    assert!(cancelled.organization_diagnostic.is_none());
    let expired = callback(&auth);
    clock.store(ATTEMPT_LIFETIME_MS, Ordering::SeqCst);
    assert_eq!(auth.status().unwrap().state, ConnectionState::Expired);
    assert!(auth.status().unwrap().organization_diagnostic.is_none());
    assert_eq!(
        auth.callback(&expired).err(),
        Some(AuthError::StateMismatch)
    );
    assert_eq!(store.reads.load(Ordering::SeqCst), 4); // constructor + three refreshes
}

fn pause_userinfo(
    http: &FlowHttp,
) -> (
    std::sync::mpsc::Receiver<()>,
    std::sync::mpsc::SyncSender<()>,
) {
    let (started_tx, started_rx) = std::sync::mpsc::sync_channel(1);
    let (release_tx, release_rx) = std::sync::mpsc::sync_channel(1);
    *http.pause.lock().unwrap() = Some((started_tx, release_rx));
    (started_rx, release_tx)
}
#[test]
fn late_failed_exchange_and_refresh_keep_original_outer_error_but_never_publish_cancelled_details()
{
    for refresh in [false, true] {
        let (auth, store, http, _) = fixture();
        if refresh {
            auth.callback(&callback(&auth)).unwrap();
        }
        let next = if refresh { None } else { Some(callback(&auth)) };
        let writes = store.writes.load(Ordering::SeqCst);
        let (started, release) = pause_userinfo(&http);
        http.reply(403, "fictional-body-canary");
        let auth = Arc::new(auth);
        let worker_auth = auth.clone();
        let worker = std::thread::spawn(move || {
            if refresh {
                worker_auth.refresh()
            } else {
                worker_auth.callback(&next.unwrap())
            }
        });
        started
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        let checking = auth.status().unwrap();
        assert_eq!(checking.state, ConnectionState::Checking);
        assert!(checking.organization_diagnostic.is_none());
        auth.cancel();
        assert_eq!(auth.begin().err(), Some(AuthError::Busy)); // existing guard forbids a second in-flight operation
        assert_eq!(auth.status().unwrap().state, ConnectionState::Cancelled);
        release.send(()).unwrap();
        assert_eq!(
            worker.join().unwrap().err(),
            Some(AuthError::OrganizationUnverified)
        );
        let cancelled = auth.status().unwrap();
        assert_eq!(cancelled.state, ConnectionState::Cancelled);
        assert!(cancelled.problem.is_none());
        assert!(cancelled.organization_diagnostic.is_none());
        assert_eq!(store.writes.load(Ordering::SeqCst), writes);
        let new_attempt = callback(&auth);
        assert!(auth.status().unwrap().organization_diagnostic.is_none());
        http.reply(200, r#"{"organization_id":1001}"#);
        let success = auth.callback(&new_attempt).unwrap();
        assert_eq!(success.state, ConnectionState::Connected);
        assert!(success.organization_diagnostic.is_none());
    }
}
#[test]
fn expired_userinfo_failure_keeps_original_error_without_late_metadata_and_success_cannot_save() {
    for failed in [false, true] {
        let (auth, store, http, clock) = fixture();
        let next = callback(&auth);
        if failed {
            http.reply(403, "fictional-body-canary");
        }
        let (started, release) = pause_userinfo(&http);
        let auth = Arc::new(auth);
        let worker_auth = auth.clone();
        let worker = std::thread::spawn(move || worker_auth.callback(&next));
        started
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        clock.store(ATTEMPT_LIFETIME_MS, Ordering::SeqCst);
        assert!(auth.status().unwrap().organization_diagnostic.is_none());
        release.send(()).unwrap();
        assert_eq!(
            worker.join().unwrap().err(),
            Some(if failed {
                AuthError::OrganizationUnverified
            } else {
                AuthError::Expired
            })
        );
        let status = auth.status().unwrap();
        assert!(status.organization_diagnostic.is_none());
        assert!(status.checked_at_ms.is_none());
        assert_eq!(store.writes.load(Ordering::SeqCst), 0);
    }
}
#[test]
fn superseded_callback_cannot_attach_diagnostics_to_the_new_waiting_attempt() {
    let (auth, store, http, _) = fixture();
    let old = callback(&auth);
    let new = callback(&auth);
    assert_eq!(auth.callback(&old).err(), Some(AuthError::StateMismatch));
    let waiting = auth.status().unwrap();
    assert_eq!(waiting.state, ConnectionState::Waiting);
    assert!(waiting.organization_diagnostic.is_none());
    assert!(http.calls.lock().unwrap().is_empty());
    assert_eq!(store.reads.load(Ordering::SeqCst), 1);
    auth.callback(&new).unwrap();
    assert!(auth.status().unwrap().organization_diagnostic.is_none());
}

#[test]
fn transport_detail_does_not_change_controller_outer_failure_or_add_reads_on_exchange_and_refresh()
{
    for refresh in [false, true] {
        let (auth, store, http, _) = fixture();
        if refresh {
            auth.callback(&callback(&auth)).unwrap();
        }
        let reads = store.reads.load(Ordering::SeqCst);
        let writes = store.writes.load(Ordering::SeqCst);
        http.calls.lock().unwrap().clear();
        *http.userinfo_error.lock().unwrap() = Some(AuthError::ProviderFailure);
        let result = if refresh {
            auth.refresh()
        } else {
            auth.callback(&callback(&auth))
        };
        assert_eq!(result.err(), Some(AuthError::ProviderFailure));
        let status = auth.status().unwrap();
        assert_eq!(status.state, ConnectionState::Failed);
        assert_eq!(status.problem, Some(AuthError::ProviderFailure));
        assert_eq!(
            diagnostic(status.organization_diagnostic.as_ref().unwrap()),
            serde_json::json!({"version":1,"stage":"userinfo","reason":"transport-failure"})
        );
        assert_eq!(
            store.reads.load(Ordering::SeqCst),
            reads + usize::from(refresh)
        );
        assert_eq!(store.writes.load(Ordering::SeqCst), writes);
        assert_eq!(
            *http.calls.lock().unwrap(),
            [Endpoint::Token, Endpoint::UserInfo]
        );
    }
}
#[test]
fn token_failure_after_earlier_org_failure_never_reuses_diagnostic_or_calls_userinfo() {
    let (auth, store, http, _) = fixture();
    auth.callback(&callback(&auth)).unwrap();
    http.reply(403, "fictional-body-canary");
    assert!(auth.refresh().is_err());
    assert!(auth.status().unwrap().organization_diagnostic.is_some());
    http.token_failure.store(true, Ordering::SeqCst);
    http.calls.lock().unwrap().clear();
    let reads = store.reads.load(Ordering::SeqCst);
    assert_eq!(auth.refresh().err(), Some(AuthError::ProviderFailure));
    let status = auth.status().unwrap();
    assert_eq!(status.problem, Some(AuthError::ProviderFailure));
    assert!(status.organization_diagnostic.is_none());
    assert_eq!(store.reads.load(Ordering::SeqCst), reads + 1);
    assert_eq!(*http.calls.lock().unwrap(), [Endpoint::Token]);
    assert_eq!(store.writes.load(Ordering::SeqCst), 1);
}

#[test]
fn controller_preserves_unclassified_legacy_errors_and_original_read_counts() {
    for refresh in [false, true] {
        for outer in [
            AuthError::OrganizationUnverified,
            AuthError::ProviderFailure,
        ] {
            let provider = Arc::new(legacy());
            let store = Arc::new(MemoryStore::default());
            let auth =
                AuthController::new(binding(), store.clone(), provider.clone(), Arc::new(|| 0))
                    .unwrap();
            if refresh {
                *provider.result.lock().unwrap() = Ok("1001".into());
                auth.callback(&callback(&auth)).unwrap();
            }
            *provider.result.lock().unwrap() = Err(outer.clone());
            let calls = provider.calls.load(Ordering::SeqCst);
            let reads = store.reads.load(Ordering::SeqCst);
            let writes = store.writes.load(Ordering::SeqCst);
            let result = if refresh {
                auth.refresh()
            } else {
                auth.callback(&callback(&auth))
            };
            assert_eq!(result.err(), Some(outer.clone()));
            let status = auth.status().unwrap();
            assert_eq!(status.state, ConnectionState::Failed);
            assert_eq!(status.problem, Some(outer));
            assert_eq!(
                diagnostic(status.organization_diagnostic.as_ref().unwrap()),
                serde_json::json!({"version":1,"stage":"userinfo","reason":"unclassified"})
            );
            assert_eq!(provider.calls.load(Ordering::SeqCst), calls + 1);
            assert_eq!(
                store.reads.load(Ordering::SeqCst),
                reads + usize::from(refresh)
            );
            assert_eq!(store.writes.load(Ordering::SeqCst), writes);
        }
    }
}
