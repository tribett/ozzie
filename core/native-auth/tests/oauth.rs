use ozzie_native_auth::credentials::{CredentialStore, StoreError};
use ozzie_native_auth::oauth::*;
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct MemoryStore(Mutex<std::collections::HashMap<String, Vec<u8>>>);
impl CredentialStore for MemoryStore {
    fn put(&self, w: &str, o: &str, value: &[u8]) -> Result<(), StoreError> {
        self.0
            .lock()
            .unwrap()
            .insert(format!("{w}:{o}"), value.to_vec());
        Ok(())
    }
    fn get(&self, w: &str, o: &str) -> Result<Option<Vec<u8>>, StoreError> {
        Ok(self.0.lock().unwrap().get(&format!("{w}:{o}")).cloned())
    }
    fn delete(&self, w: &str, o: &str) -> Result<(), StoreError> {
        self.0.lock().unwrap().remove(&format!("{w}:{o}"));
        Ok(())
    }
}
struct FictionalProvider;
impl Provider for FictionalProvider {
    fn exchange(&self, _: &str, _: &str, verifier: &str) -> Result<Tokens, AuthError> {
        assert_eq!(verifier.len(), 43);
        Ok(Tokens {
            access_token: "fictional-native-access".into(),
            refresh_token: Some("fictional-native-refresh".into()),
            token_type: "bearer".into(),
            expires_in: 7200,
        })
    }
    fn organization(&self, _: &str) -> Result<String, AuthError> {
        Ok("1001".into())
    }
    fn refresh(&self, _: &str, _: &str) -> Result<Tokens, AuthError> {
        Ok(Tokens {
            access_token: "fictional-refreshed-access".into(),
            refresh_token: Some("fictional-refreshed-refresh".into()),
            token_type: "bearer".into(),
            expires_in: 7200,
        })
    }
    fn revoke(&self, _: &str, _: &str, _: &str) -> Result<(), AuthError> {
        Ok(())
    }
}
fn controller(store: Arc<MemoryStore>) -> AuthController {
    AuthController::new(
        Binding {
            workspace: "fictional-workspace".into(),
            organization: "1001".into(),
            client_id: "fictional-client".into(),
        },
        store,
        Arc::new(FictionalProvider),
        Arc::new(|| 0),
    )
    .unwrap()
}
#[test]
fn public_pkce_callback_verifies_org_stores_privately_and_returns_only_status() {
    let store = Arc::new(MemoryStore::default());
    let auth = controller(store.clone());
    let url = url::Url::parse(&auth.begin().unwrap()).unwrap();
    assert_eq!(
        url.query_pairs()
            .find(|(k, _)| k == "code_challenge_method")
            .unwrap()
            .1,
        "S256"
    );
    let state = url
        .query_pairs()
        .find(|(k, _)| k == "state")
        .unwrap()
        .1
        .into_owned();
    let status = auth
        .callback(&format!("{REDIRECT_URI}?code=fictional-code&state={state}"))
        .unwrap();
    assert_eq!(status.state, ConnectionState::Connected);
    let json = serde_json::to_string(&status).unwrap();
    assert!(!json.contains("access"));
    assert!(!json.contains("refresh"));
    assert!(!json.contains("verifier"));
    assert!(store.get("fictional-workspace", "1001").unwrap().is_some());
}

fn callback_url(auth: &AuthController) -> String {
    let url = url::Url::parse(&auth.begin().unwrap()).unwrap();
    let state = url
        .query_pairs()
        .find(|(k, _)| k == "state")
        .unwrap()
        .1
        .into_owned();
    format!("{REDIRECT_URI}?code=fictional-code&state={state}")
}
#[test]
fn wrong_state_and_reused_callback_never_connect() {
    let auth = controller(Arc::new(MemoryStore::default()));
    let callback = callback_url(&auth);
    assert_eq!(
        auth.callback(&format!("{REDIRECT_URI}?code=fictional-code&state=wrong"))
            .err(),
        Some(AuthError::StateMismatch)
    );
    auth.callback(&callback).unwrap();
    assert_eq!(
        auth.callback(&callback).err(),
        Some(AuthError::StateMismatch)
    );
}
#[test]
fn expires_at_five_minutes_and_consumes_attempt() {
    let clock = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let now = clock.clone();
    let store = Arc::new(MemoryStore::default());
    let auth = AuthController::new(
        Binding {
            workspace: "fictional-workspace".into(),
            organization: "1001".into(),
            client_id: "fictional-client".into(),
        },
        store.clone(),
        Arc::new(FictionalProvider),
        Arc::new(move || now.load(std::sync::atomic::Ordering::SeqCst)),
    )
    .unwrap();
    let callback = callback_url(&auth);
    clock.store(300_000, std::sync::atomic::Ordering::SeqCst);
    assert_eq!(auth.callback(&callback).err(), Some(AuthError::Expired));
    assert!(store.get("fictional-workspace", "1001").unwrap().is_none());
    assert_eq!(
        auth.callback(&callback).err(),
        Some(AuthError::StateMismatch)
    );
}
#[test]
fn refuses_wrong_callback_destination_and_duplicate_parameters() {
    for replacement in [
        "https://unintended.invalid/oauth/callback",
        "http://127.0.0.1:42819/wrong-path",
    ] {
        let auth = controller(Arc::new(MemoryStore::default()));
        let callback = callback_url(&auth).replace(REDIRECT_URI, replacement);
        assert!(auth.callback(&callback).is_err());
    }
    let auth = controller(Arc::new(MemoryStore::default()));
    let callback = callback_url(&auth);
    assert!(
        auth.callback(&format!("{callback}&code=second-code"))
            .is_err()
    );
}

#[test]
fn cancelled_attempt_cannot_exchange() {
    let store = Arc::new(MemoryStore::default());
    let auth = controller(store.clone());
    let callback = callback_url(&auth);
    auth.cancel();
    assert_eq!(
        auth.callback(&callback).err(),
        Some(AuthError::StateMismatch)
    );
    assert!(store.get("fictional-workspace", "1001").unwrap().is_none());
}
#[test]
fn refresh_reverifies_organization_and_disconnect_cleans_up() {
    let store = Arc::new(MemoryStore::default());
    let auth = controller(store.clone());
    auth.callback(&callback_url(&auth)).unwrap();
    assert_eq!(auth.refresh().unwrap().state, ConnectionState::Connected);
    assert_eq!(
        auth.disconnect().unwrap().state,
        ConnectionState::Disconnected
    );
    assert!(store.get("fictional-workspace", "1001").unwrap().is_none());
}
struct BlockingProvider {
    started: std::sync::mpsc::SyncSender<()>,
    release: Mutex<std::sync::mpsc::Receiver<()>>,
}
impl Provider for BlockingProvider {
    fn exchange(&self, c: &str, code: &str, v: &str) -> Result<Tokens, AuthError> {
        self.started.send(()).unwrap();
        self.release.lock().unwrap().recv().unwrap();
        FictionalProvider.exchange(c, code, v)
    }
    fn organization(&self, a: &str) -> Result<String, AuthError> {
        FictionalProvider.organization(a)
    }
    fn refresh(&self, c: &str, r: &str) -> Result<Tokens, AuthError> {
        FictionalProvider.refresh(c, r)
    }
    fn revoke(&self, c: &str, t: &str, h: &str) -> Result<(), AuthError> {
        FictionalProvider.revoke(c, t, h)
    }
}
#[test]
fn cancellation_during_provider_work_prevents_late_storage() {
    let (started_tx, started_rx) = std::sync::mpsc::sync_channel(1);
    let (release_tx, release_rx) = std::sync::mpsc::sync_channel(1);
    let store = Arc::new(MemoryStore::default());
    let auth = Arc::new(
        AuthController::new(
            Binding {
                workspace: "fictional-workspace".into(),
                organization: "1001".into(),
                client_id: "fictional-client".into(),
            },
            store.clone(),
            Arc::new(BlockingProvider {
                started: started_tx,
                release: Mutex::new(release_rx),
            }),
            Arc::new(|| 0),
        )
        .unwrap(),
    );
    let callback = callback_url(&auth);
    let worker_auth = auth.clone();
    let worker = std::thread::spawn(move || worker_auth.callback(&callback));
    started_rx
        .recv_timeout(std::time::Duration::from_secs(2))
        .unwrap();
    auth.cancel();
    release_tx.send(()).unwrap();
    assert_eq!(worker.join().unwrap().err(), Some(AuthError::Cancelled));
    assert!(store.get("fictional-workspace", "1001").unwrap().is_none());
}

struct ChangingOrganization(Mutex<Option<String>>);
impl Provider for ChangingOrganization {
    fn exchange(&self, c: &str, code: &str, v: &str) -> Result<Tokens, AuthError> {
        FictionalProvider.exchange(c, code, v)
    }
    fn organization(&self, _: &str) -> Result<String, AuthError> {
        self.0
            .lock()
            .unwrap()
            .clone()
            .ok_or(AuthError::OrganizationUnverified)
    }
    fn refresh(&self, c: &str, r: &str) -> Result<Tokens, AuthError> {
        FictionalProvider.refresh(c, r)
    }
    fn revoke(&self, c: &str, t: &str, h: &str) -> Result<(), AuthError> {
        FictionalProvider.revoke(c, t, h)
    }
}
#[test]
fn exchange_and_refresh_fail_closed_on_missing_or_mismatched_source_organization() {
    for id in [None, Some("1002".into())] {
        let store = Arc::new(MemoryStore::default());
        let provider = Arc::new(ChangingOrganization(Mutex::new(id.clone())));
        let auth = AuthController::new(
            Binding {
                workspace: "fictional-workspace".into(),
                organization: "1001".into(),
                client_id: "fictional-client".into(),
            },
            store.clone(),
            provider.clone(),
            Arc::new(|| 0),
        )
        .unwrap();
        assert_eq!(
            auth.callback(&callback_url(&auth)).err(),
            Some(AuthError::OrganizationUnverified)
        );
        assert!(store.get("fictional-workspace", "1001").unwrap().is_none());
        *provider.0.lock().unwrap() = Some("1001".into());
        auth.callback(&callback_url(&auth)).unwrap();
        let previous = store.get("fictional-workspace", "1001").unwrap();
        *provider.0.lock().unwrap() = id;
        assert_eq!(
            auth.refresh().err(),
            Some(AuthError::OrganizationUnverified)
        );
        assert_eq!(store.get("fictional-workspace", "1001").unwrap(), previous);
        assert_eq!(auth.status().unwrap().state, ConnectionState::Failed);
    }
}
#[test]
fn provider_denial_callback_is_denied_ends_the_attempt_and_saves_nothing() {
    // Onboarding spec N2: "You chose not to allow Ozzie" is told apart from cancelling on this Mac.
    let store = Arc::new(MemoryStore::default());
    let auth = controller(store.clone());
    let callback = callback_url(&auth).replace("code=fictional-code", "error=access_denied");
    assert_eq!(auth.callback(&callback).err(), Some(AuthError::Denied));
    let status = auth.status().unwrap();
    assert_eq!(status.state, ConnectionState::Cancelled);
    assert_eq!(status.problem, Some(AuthError::Denied));
    assert_eq!(store.get("fictional-workspace", "1001").unwrap(), None);
    assert_eq!(
        serde_json::to_string(&status.problem).unwrap(),
        r#""denied""#
    );
    assert_eq!(
        auth.callback(&callback).err(),
        Some(AuthError::StateMismatch)
    );
    // Any other error from Planning Center still ends it as cancelled.
    let auth = controller(Arc::new(MemoryStore::default()));
    let callback = callback_url(&auth).replace("code=fictional-code", "error=server_error");
    assert_eq!(auth.callback(&callback).err(), Some(AuthError::Cancelled));
    assert_eq!(auth.status().unwrap().problem, Some(AuthError::Cancelled));
}

/// Loopback tests share the fixed callback port; run them one at a time.
static LOOPBACK: Mutex<()> = Mutex::new(());
#[test]
fn actual_loopback_receiver_rejects_wrong_hosts_and_closes_after_one_callback() {
    use std::{
        io::{Read, Write},
        net::TcpStream,
    };
    let _port = LOOPBACK.lock().unwrap_or_else(|e| e.into_inner());
    let auth = Arc::new(controller(Arc::new(MemoryStore::default())));
    let callback = callback_url(&auth);
    let path = callback.strip_prefix("http://127.0.0.1:42819").unwrap();
    let mut receiver = ozzie_native_auth::callback::CallbackServer::start(auth.clone()).unwrap();
    let request = |host: &str| {
        let mut stream = TcpStream::connect("127.0.0.1:42819").unwrap();
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(3)))
            .unwrap();
        write!(stream, "GET {path} HTTP/1.1\r\nHost: {host}\r\n\r\n").unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        response
    };
    let rejected = request("unintended.invalid");
    assert!(rejected.starts_with("HTTP/1.1 400"));
    assert!(!rejected.contains("fictional-code"));
    let response = request("127.0.0.1:42819");
    assert!(response.starts_with("HTTP/1.1 200"));
    assert!(!response.contains("fictional-native-access"));
    assert_eq!(auth.status().unwrap().state, ConnectionState::Connected);
    receiver.stop();
    assert!(std::net::TcpListener::bind("127.0.0.1:42819").is_ok());
}
#[test]
fn loopback_receiver_waits_for_a_callback_request_that_arrives_after_the_connection() {
    // A browser may open the connection before its request bytes arrive. The accepted
    // socket must honor the read timeout instead of failing on an empty nonblocking read.
    use std::{
        io::{Read, Write},
        net::TcpStream,
    };
    let _port = LOOPBACK.lock().unwrap_or_else(|e| e.into_inner());
    let auth = Arc::new(controller(Arc::new(MemoryStore::default())));
    let callback = callback_url(&auth);
    let path = callback.strip_prefix("http://127.0.0.1:42819").unwrap();
    let mut receiver = ozzie_native_auth::callback::CallbackServer::start(auth.clone()).unwrap();
    let mut stream = TcpStream::connect("127.0.0.1:42819").unwrap();
    stream
        .set_read_timeout(Some(std::time::Duration::from_secs(3)))
        .unwrap();
    std::thread::sleep(std::time::Duration::from_millis(300));
    write!(
        stream,
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:42819\r\n\r\n"
    )
    .unwrap();
    let mut response = String::new();
    let read = stream.read_to_string(&mut response);
    receiver.stop();
    assert!(read.is_ok(), "{read:?}");
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    assert_eq!(auth.status().unwrap().state, ConnectionState::Connected);
}

struct RejectedProvider;
impl Provider for RejectedProvider {
    fn exchange(&self, _: &str, _: &str, _: &str) -> Result<Tokens, AuthError> {
        Err(AuthError::InvalidToken)
    }
    fn organization(&self, _: &str) -> Result<String, AuthError> {
        panic!("identity must not run after rejected verifier")
    }
    fn refresh(&self, _: &str, _: &str) -> Result<Tokens, AuthError> {
        Err(AuthError::ProviderFailure)
    }
    fn revoke(&self, _: &str, _: &str, _: &str) -> Result<(), AuthError> {
        Err(AuthError::ProviderFailure)
    }
}
#[test]
fn provider_rejected_verifier_does_not_store_and_consumes_attempt() {
    let store = Arc::new(MemoryStore::default());
    let auth = AuthController::new(
        Binding {
            workspace: "fictional-workspace".into(),
            organization: "1001".into(),
            client_id: "fictional-client".into(),
        },
        store.clone(),
        Arc::new(RejectedProvider),
        Arc::new(|| 0),
    )
    .unwrap();
    let callback = callback_url(&auth);
    assert_eq!(
        auth.callback(&callback).err(),
        Some(AuthError::InvalidToken)
    );
    assert_eq!(
        auth.callback(&callback).err(),
        Some(AuthError::StateMismatch)
    );
    assert!(store.get("fictional-workspace", "1001").unwrap().is_none());
}
#[test]
fn another_workspace_cannot_consume_an_attempt_or_receive_its_credential() {
    let store = Arc::new(MemoryStore::default());
    let auth_a = controller(store.clone());
    let auth_b = AuthController::new(
        Binding {
            workspace: "another-workspace".into(),
            organization: "1001".into(),
            client_id: "fictional-client".into(),
        },
        store.clone(),
        Arc::new(FictionalProvider),
        Arc::new(|| 0),
    )
    .unwrap();
    let callback = callback_url(&auth_a);
    assert_eq!(
        auth_b.callback(&callback).err(),
        Some(AuthError::StateMismatch)
    );
    auth_a.callback(&callback).unwrap();
    assert!(store.get("another-workspace", "1001").unwrap().is_none());
}
#[test]
fn failed_revoke_retains_credentials_for_retry() {
    let store = Arc::new(MemoryStore::default());
    let initial = controller(store.clone());
    initial.callback(&callback_url(&initial)).unwrap();
    let denied = AuthController::new(
        Binding {
            workspace: "fictional-workspace".into(),
            organization: "1001".into(),
            client_id: "fictional-client".into(),
        },
        store.clone(),
        Arc::new(RejectedProvider),
        Arc::new(|| 0),
    )
    .unwrap();
    assert_eq!(
        denied.status().unwrap().state,
        ConnectionState::StoredUnchecked
    );
    assert_eq!(denied.disconnect().err(), Some(AuthError::ProviderFailure));
    assert!(store.get("fictional-workspace", "1001").unwrap().is_some());
}
struct DeniedStore;
impl CredentialStore for DeniedStore {
    fn put(&self, _: &str, _: &str, _: &[u8]) -> Result<(), StoreError> {
        Err(StoreError::Denied)
    }
    fn get(&self, _: &str, _: &str) -> Result<Option<Vec<u8>>, StoreError> {
        Ok(None)
    }
    fn delete(&self, _: &str, _: &str) -> Result<(), StoreError> {
        Err(StoreError::Denied)
    }
}
#[test]
fn denied_native_storage_is_not_a_successful_connection() {
    let auth = AuthController::new(
        Binding {
            workspace: "fictional-workspace".into(),
            organization: "1001".into(),
            client_id: "fictional-client".into(),
        },
        Arc::new(DeniedStore),
        Arc::new(FictionalProvider),
        Arc::new(|| 0),
    )
    .unwrap();
    assert_eq!(
        auth.callback(&callback_url(&auth)).err(),
        Some(AuthError::Store(StoreError::Denied))
    );
    assert_eq!(auth.status().unwrap().state, ConnectionState::Failed);
}

fn scope_of(url: &str) -> String {
    url::Url::parse(url)
        .unwrap()
        .query_pairs()
        .find(|(k, _)| k == "scope")
        .unwrap()
        .1
        .into_owned()
}
/// Signs in with the default (`None`) or an explicit scope set.
fn connect_with(auth: &AuthController, scopes: Option<Scopes>) -> ConnectionStatus {
    let url = match scopes {
        None => auth.begin(),
        Some(scopes) => auth.begin_with(scopes),
    }
    .unwrap();
    let state = url::Url::parse(&url)
        .unwrap()
        .query_pairs()
        .find(|(k, _)| k == "state")
        .unwrap()
        .1
        .into_owned();
    auth.callback(&format!("{REDIRECT_URI}?code=fictional-code&state={state}"))
        .unwrap()
}
fn saved(store: &MemoryStore) -> String {
    String::from_utf8(
        store
            .0
            .lock()
            .unwrap()
            .get("fictional-workspace:1001")
            .unwrap()
            .clone(),
    )
    .unwrap()
}

#[test]
fn sign_in_asks_for_services_only_unless_operations_are_explicitly_chosen() {
    // Each Planning Center product scope permits reading and writing in that product. Ozzie's
    // source client only issues GETs, but the default still asks for the least: Services.
    let auth = controller(Arc::new(MemoryStore::default()));
    assert_eq!(scope_of(&auth.begin().unwrap()), "services openid");
    assert_eq!(
        scope_of(&auth.begin_with(Scopes::Services).unwrap()),
        "services openid"
    );
    assert_eq!(
        scope_of(&auth.begin_with(Scopes::ServicesAndOperations).unwrap()),
        "services calendar people groups openid"
    );
    // Nothing is known about a set until a saved connection has been verified.
    assert_eq!(auth.status().unwrap().scopes, None);
}

#[test]
fn the_granted_scope_set_is_saved_reported_and_never_widened_by_refresh() {
    let store = Arc::new(MemoryStore::default());
    let auth = controller(store.clone());
    let status = connect_with(&auth, Some(Scopes::ServicesAndOperations));
    assert_eq!(status.scopes, Some(Scopes::ServicesAndOperations));
    assert_eq!(
        serde_json::to_value(&status).unwrap()["scopes"],
        "services-and-operations"
    );
    assert!(saved(&store).contains(r#""scopes":"services-and-operations""#));
    assert_eq!(
        auth.refresh().unwrap().scopes,
        Some(Scopes::ServicesAndOperations)
    );
    assert!(saved(&store).contains(r#""scopes":"services-and-operations""#));
    // A new session over the saved record knows the set only after its own check.
    let again = controller(store.clone());
    assert_eq!(again.status().unwrap().scopes, None);
    assert_eq!(
        again.refresh().unwrap().scopes,
        Some(Scopes::ServicesAndOperations)
    );
    // Consenting again with the default narrows the set; refresh never widens it back.
    let status = connect_with(&auth, None);
    assert_eq!(status.scopes, Some(Scopes::Services));
    assert_eq!(serde_json::to_value(&status).unwrap()["scopes"], "services");
    // A default connection's record is byte-for-byte the original format.
    assert!(!saved(&store).contains("scopes"));
    assert_eq!(auth.refresh().unwrap().scopes, Some(Scopes::Services));
    assert!(!saved(&store).contains("scopes"));
    // Failure forgets the reported set.
    auth.cancel();
    assert_eq!(auth.status().unwrap().scopes, None);
}

#[test]
fn a_saved_record_naming_an_unknown_scope_set_is_refused() {
    let store = Arc::new(MemoryStore::default());
    connect_with(
        &controller(store.clone()),
        Some(Scopes::ServicesAndOperations),
    );
    let widened = saved(&store).replace("services-and-operations", "everything");
    store
        .put("fictional-workspace", "1001", widened.as_bytes())
        .unwrap();
    let auth = controller(store.clone());
    assert_eq!(auth.refresh().err(), Some(AuthError::InvalidToken));
    assert_eq!(auth.status().unwrap().scopes, None);
}
