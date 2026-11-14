use ozzie_native_auth::{
    credentials::{CredentialStore, StoreError},
    oauth::{AuthController, AuthError, Provider, Tokens},
    source::{SourceError, parse_request},
};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
const REQUEST: &str = r#"{"version":1,"workspace":"fictional-workspace","organization":"1001","client_id":"fictional-client","service_type_id":"10","plan_id":"20","collection":"needed_positions","per_page":100,"offset":0}"#;
const RECORD:&[u8]=br#"{"client_id":"fictional-client","organization":"1001","tokens":{"access_token":"fictional-native-secret-canary","refresh_token":"fictional-refresh-canary","token_type":"bearer","expires_in":7200}}"#;
struct Store {
    record: Mutex<Option<Vec<u8>>>,
    failure: Mutex<Option<StoreError>>,
}
impl CredentialStore for Store {
    fn get(&self, w: &str, o: &str) -> Result<Option<Vec<u8>>, StoreError> {
        assert_eq!(w, "fictional-workspace");
        assert_eq!(o, "1001");
        if let Some(e) = *self.failure.lock().unwrap() {
            Err(e)
        } else {
            Ok(self.record.lock().unwrap().clone())
        }
    }
    fn put(&self, _: &str, _: &str, _: &[u8]) -> Result<(), StoreError> {
        panic!("no credential writes during a read")
    }
    fn delete(&self, _: &str, _: &str) -> Result<(), StoreError> {
        panic!("no credential deletion during a read")
    }
}
struct Identity {
    result: Result<String, AuthError>,
    calls: AtomicUsize,
    cancel: Option<Arc<AtomicBool>>,
}
impl Provider for Identity {
    fn organization(&self, access: &str) -> Result<String, AuthError> {
        assert_eq!(access, "fictional-native-secret-canary");
        self.calls.fetch_add(1, Ordering::SeqCst);
        if let Some(c) = &self.cancel {
            c.store(true, Ordering::SeqCst);
        }
        self.result.clone()
    }
    fn exchange(&self, _: &str, _: &str, _: &str) -> Result<Tokens, AuthError> {
        panic!("no acquisition")
    }
    fn refresh(&self, _: &str, _: &str) -> Result<Tokens, AuthError> {
        panic!("no automatic refresh")
    }
    fn revoke(&self, _: &str, _: &str, _: &str) -> Result<(), AuthError> {
        panic!("no revocation")
    }
}
fn setup(
    record: Option<Vec<u8>>,
    identity: Result<String, AuthError>,
    cancel: Option<Arc<AtomicBool>>,
) -> (AuthController, Arc<Store>, Arc<Identity>) {
    let store = Arc::new(Store {
        record: Mutex::new(record),
        failure: Mutex::new(None),
    });
    let provider = Arc::new(Identity {
        result: identity,
        calls: AtomicUsize::new(0),
        cancel,
    });
    let auth = AuthController::new(
        parse_request(REQUEST.as_bytes()).unwrap().binding(),
        store.clone(),
        provider.clone(),
        Arc::new(|| 0),
    )
    .unwrap();
    (auth, store, provider)
}
#[test]
fn missing_locked_denied_and_unavailable_are_distinct_without_provider_requests() {
    for (failure, expected) in [
        (None, SourceError::MissingCredentials),
        (Some(StoreError::Locked), SourceError::Locked),
        (Some(StoreError::Denied), SourceError::Denied),
        (Some(StoreError::Unavailable), SourceError::StoreUnavailable),
    ] {
        let (auth, store, provider) = setup(None, Err(AuthError::ProviderFailure), None);
        *store.failure.lock().unwrap() = failure;
        assert_eq!(
            auth.read_source(
                &parse_request(REQUEST.as_bytes()).unwrap(),
                &AtomicBool::new(false)
            )
            .err(),
            Some(expected)
        );
        assert_eq!(provider.calls.load(Ordering::SeqCst), 0);
    }
}
#[test]
fn every_binding_dimension_denies_before_identity_or_source_access() {
    for (from, to) in [
        ("fictional-workspace", "another-workspace"),
        ("1001", "1002"),
        ("fictional-client", "another-client"),
    ] {
        let (auth, _, provider) = setup(Some(RECORD.into()), Err(AuthError::ProviderFailure), None);
        let request = parse_request(REQUEST.replace(from, to).as_bytes()).unwrap();
        assert_eq!(
            auth.read_source(&request, &AtomicBool::new(false)).err(),
            Some(SourceError::BindingMismatch)
        );
        assert_eq!(provider.calls.load(Ordering::SeqCst), 0);
    }
}
#[test]
fn stored_validation_is_reused_instead_of_accepting_a_parallel_credential_format() {
    for (from, to, error) in [
        (
            "fictional-client",
            "wrong-client",
            SourceError::OrganizationUnverified,
        ),
        ("1001", "1002", SourceError::OrganizationUnverified),
        ("7200", "0", SourceError::InvalidCredentials),
        ("bearer", "basic", SourceError::InvalidCredentials),
        (
            "fictional-native-secret-canary",
            "",
            SourceError::InvalidCredentials,
        ),
    ] {
        let record = String::from_utf8(RECORD.into())
            .unwrap()
            .replace(from, to)
            .into_bytes();
        let (auth, _, provider) = setup(Some(record), Err(AuthError::ProviderFailure), None);
        assert_eq!(
            auth.read_source(
                &parse_request(REQUEST.as_bytes()).unwrap(),
                &AtomicBool::new(false)
            )
            .err(),
            Some(error)
        );
        assert_eq!(provider.calls.load(Ordering::SeqCst), 0);
    }
    let (auth, _, _) = setup(
        Some(b"invalid secret-care-name-canary".to_vec()),
        Err(AuthError::ProviderFailure),
        None,
    );
    assert_eq!(
        auth.read_source(
            &parse_request(REQUEST.as_bytes()).unwrap(),
            &AtomicBool::new(false)
        )
        .err(),
        Some(SourceError::InvalidCredentials)
    );
}
#[test]
fn organization_mismatch_unverified_identity_and_failures_stop_without_refresh() {
    for (result, expected) in [
        (Ok("9999".into()), SourceError::OrganizationUnverified),
        (
            Err(AuthError::OrganizationUnverified),
            SourceError::OrganizationUnverified,
        ),
        (
            Err(AuthError::ProviderFailure),
            SourceError::ProviderFailure,
        ),
    ] {
        let (auth, _, provider) = setup(Some(RECORD.into()), result, None);
        assert_eq!(
            auth.read_source(
                &parse_request(REQUEST.as_bytes()).unwrap(),
                &AtomicBool::new(false)
            )
            .err(),
            Some(expected)
        );
        assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
    }
}
#[test]
fn cancel_during_identity_discards_even_a_successful_identity_result_before_source_access() {
    let cancel = Arc::new(AtomicBool::new(false));
    let (auth, _, provider) = setup(Some(RECORD.into()), Ok("1001".into()), Some(cancel.clone()));
    assert_eq!(
        auth.read_source(&parse_request(REQUEST.as_bytes()).unwrap(), &cancel)
            .err(),
        Some(SourceError::Cancelled)
    );
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
}
