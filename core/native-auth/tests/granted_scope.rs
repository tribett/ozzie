//! The token response's granted `scope` decides the saved and reported set, never the request;
//! a new sign-in revokes the credential it displaces. Fictional values only; no live calls.
use ozzie_native_auth::credentials::{CredentialStore, StoreError};
use ozzie_native_auth::oauth::*;
use ozzie_native_auth::provider::{Endpoint, Http, PcoProvider, Response};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
};
use zeroize::Zeroizing;

const KEY: &str = "fictional-workspace:1001";

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
impl MemoryStore {
    fn saved(&self) -> Option<String> {
        self.0
            .lock()
            .unwrap()
            .get(KEY)
            .map(|b| String::from_utf8(b.clone()).unwrap())
    }
}
/// Planning Center (Doorkeeper) answers the token request with the scope it actually granted.
struct NarrowGrant;
impl Http for NarrowGrant {
    fn send(
        &self,
        endpoint: Endpoint,
        _: Option<&str>,
        _: Option<&str>,
    ) -> Result<Response, AuthError> {
        let body = match endpoint {
            Endpoint::Token => br#"{"access_token":"fictional-access","token_type":"bearer","expires_in":7200,"refresh_token":"fictional-refresh","scope":"services openid","created_at":1794571200}"#.to_vec(),
            Endpoint::UserInfo => br#"{"organization_id":"1001"}"#.to_vec(),
            Endpoint::Revoke => b"{}".to_vec(),
        };
        Ok(Response {
            status: 200,
            body: Zeroizing::new(body),
            retry_after: None,
        })
    }
}
/// Token answers in order; records every revoke request's (token, hint).
#[derive(Default)]
struct Scripted {
    tokens: Mutex<VecDeque<String>>,
    organization: Mutex<String>,
    revoke_status: Mutex<u16>,
    revoked: Mutex<Vec<(String, String)>>,
}
impl Scripted {
    fn new() -> Arc<Self> {
        let scripted = Self::default();
        *scripted.organization.lock().unwrap() = "1001".into();
        *scripted.revoke_status.lock().unwrap() = 200;
        Arc::new(scripted)
    }
    /// Queues one token response; `scope` is the raw JSON value, or `None` to omit it.
    fn token(&self, access: &str, refresh: Option<&str>, scope: Option<&str>) {
        let mut body = serde_json::json!({"access_token":access,"token_type":"bearer","expires_in":7200,"created_at":1794571200});
        if let Some(refresh) = refresh {
            body["refresh_token"] = refresh.into();
        }
        if let Some(scope) = scope {
            body["scope"] = serde_json::from_str(scope).unwrap();
        }
        self.tokens.lock().unwrap().push_back(body.to_string());
    }
    fn revoked(&self) -> Vec<(String, String)> {
        self.revoked.lock().unwrap().clone()
    }
}
struct Shared(Arc<Scripted>);
impl Http for Shared {
    fn send(
        &self,
        endpoint: Endpoint,
        form: Option<&str>,
        _: Option<&str>,
    ) -> Result<Response, AuthError> {
        let (status, body) = match endpoint {
            Endpoint::Token => (
                200,
                self.0
                    .tokens
                    .lock()
                    .unwrap()
                    .pop_front()
                    .expect("unscripted token request"),
            ),
            Endpoint::UserInfo => (
                200,
                format!(
                    r#"{{"organization_id":"{}"}}"#,
                    self.0.organization.lock().unwrap()
                ),
            ),
            Endpoint::Revoke => {
                let pairs: std::collections::HashMap<String, String> =
                    url::form_urlencoded::parse(form.unwrap().as_bytes())
                        .into_owned()
                        .collect();
                assert_eq!(pairs["client_id"], "fictional-client");
                self.0
                    .revoked
                    .lock()
                    .unwrap()
                    .push((pairs["token"].clone(), pairs["token_type_hint"].clone()));
                (*self.0.revoke_status.lock().unwrap(), "{}".into())
            }
        };
        Ok(Response {
            status,
            body: Zeroizing::new(body.into_bytes()),
            retry_after: None,
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
fn controller(store: &Arc<MemoryStore>, http: &Arc<Scripted>) -> AuthController {
    AuthController::new(
        binding(),
        store.clone(),
        Arc::new(PcoProvider(Shared(http.clone()))),
        Arc::new(|| 0),
    )
    .unwrap()
}
fn callback_for(url: &str) -> String {
    let state = url::Url::parse(url)
        .unwrap()
        .query_pairs()
        .find(|(k, _)| k == "state")
        .unwrap()
        .1
        .into_owned();
    format!("{REDIRECT_URI}?code=fictional-code&state={state}")
}
fn sign_in(auth: &AuthController, scopes: Scopes) -> Result<ConnectionStatus, AuthError> {
    auth.callback(&callback_for(&auth.begin_with(scopes).unwrap()))
}
const OPERATIONS: &str = r#""services calendar people groups openid""#;
const SERVICES: &str = r#""services openid""#;

#[test]
fn status_reports_what_planning_center_granted_not_what_was_asked() {
    let store = Arc::new(MemoryStore::default());
    let auth = AuthController::new(
        binding(),
        store.clone(),
        Arc::new(PcoProvider(NarrowGrant)),
        Arc::new(|| 0),
    )
    .unwrap();
    let url = auth.begin_with(Scopes::ServicesAndOperations).unwrap();
    let status = auth.callback(&callback_for(&url)).unwrap();
    // Planning Center granted Services only; Ozzie must not claim (or attempt) operations.
    assert_eq!(status.scopes, Some(Scopes::Services));
    assert_eq!(serde_json::to_value(&status).unwrap()["scopes"], "services");
    // The saved record is the granted set: the default, byte-for-byte the original format.
    assert!(!store.saved().unwrap().contains("scopes"));
}

#[test]
fn a_grant_wider_than_asked_or_without_services_is_refused_saved_nowhere_and_revoked() {
    for (asked, granted) in [
        (Scopes::Services, r#""services people openid""#),
        (Scopes::Services, OPERATIONS),
        (
            Scopes::ServicesAndOperations,
            r#""services calendar people groups giving openid""#,
        ),
        (Scopes::ServicesAndOperations, r#""openid""#),
        (
            Scopes::ServicesAndOperations,
            r#""calendar people groups openid""#,
        ),
        (Scopes::Services, r#""""#),
    ] {
        let store = Arc::new(MemoryStore::default());
        let http = Scripted::new();
        http.token(
            "fictional-wide-access",
            Some("fictional-wide-refresh"),
            Some(granted),
        );
        let auth = controller(&store, &http);
        assert_eq!(
            sign_in(&auth, asked).err(),
            Some(AuthError::ScopeMismatch),
            "{asked:?} {granted}"
        );
        let status = auth.status().unwrap();
        assert_eq!(status.state, ConnectionState::Failed);
        assert_eq!(status.problem, Some(AuthError::ScopeMismatch));
        assert_eq!(status.scopes, None);
        assert_eq!(
            serde_json::to_value(&status).unwrap()["problem"],
            "scope-mismatch"
        );
        assert!(store.saved().is_none(), "{granted}");
        // The refused credential is not left valid at Planning Center.
        assert_eq!(
            http.revoked(),
            [("fictional-wide-refresh".into(), "refresh_token".into())]
        );
    }
}

#[test]
fn operations_count_only_when_calendar_people_and_groups_were_all_granted() {
    for (granted, expected) in [
        (OPERATIONS, Scopes::ServicesAndOperations),
        (
            r#""openid groups  people calendar services""#,
            Scopes::ServicesAndOperations,
        ),
        (r#""services calendar people openid""#, Scopes::Services),
        (r#""services groups""#, Scopes::Services),
        (SERVICES, Scopes::Services),
    ] {
        let store = Arc::new(MemoryStore::default());
        let http = Scripted::new();
        http.token("fictional-access", Some("fictional-refresh"), Some(granted));
        let auth = controller(&store, &http);
        let status = sign_in(&auth, Scopes::ServicesAndOperations).unwrap();
        assert_eq!(status.scopes, Some(expected), "{granted}");
        assert_eq!(
            store.saved().unwrap().contains("services-and-operations"),
            expected.operations(),
            "{granted}"
        );
        assert!(http.revoked().is_empty());
    }
    // An omitted scope is exactly the request (RFC 6749 §5.1).
    let store = Arc::new(MemoryStore::default());
    let http = Scripted::new();
    http.token("fictional-access", Some("fictional-refresh"), None);
    let auth = controller(&store, &http);
    assert_eq!(
        sign_in(&auth, Scopes::ServicesAndOperations)
            .unwrap()
            .scopes,
        Some(Scopes::ServicesAndOperations)
    );
    // A scope that is not a string is not a usable token response.
    let http = Scripted::new();
    http.token("fictional-access", Some("fictional-refresh"), Some("7"));
    let auth = controller(&Arc::new(MemoryStore::default()), &http);
    assert_eq!(
        sign_in(&auth, Scopes::Services).err(),
        Some(AuthError::InvalidToken)
    );
}

#[test]
fn refresh_keeps_or_narrows_the_granted_set_and_a_restart_reports_the_saved_one() {
    let store = Arc::new(MemoryStore::default());
    let http = Scripted::new();
    http.token("fictional-a1", Some("fictional-r1"), Some(OPERATIONS));
    let auth = controller(&store, &http);
    assert_eq!(
        sign_in(&auth, Scopes::ServicesAndOperations)
            .unwrap()
            .scopes,
        Some(Scopes::ServicesAndOperations)
    );
    // Omitted on refresh: the original grant (RFC 6749 §6).
    http.token("fictional-a2", Some("fictional-r2"), None);
    assert_eq!(
        auth.refresh().unwrap().scopes,
        Some(Scopes::ServicesAndOperations)
    );
    // After an app restart, a new controller reports the saved granted set once it has checked.
    let restarted = controller(&store, &http);
    assert_eq!(restarted.status().unwrap().scopes, None);
    http.token("fictional-a3", Some("fictional-r3"), Some(OPERATIONS));
    assert_eq!(
        restarted.refresh().unwrap().scopes,
        Some(Scopes::ServicesAndOperations)
    );
    // Planning Center narrowed the grant: the saved and reported set narrow with it.
    http.token("fictional-a4", Some("fictional-r4"), Some(SERVICES));
    assert_eq!(restarted.refresh().unwrap().scopes, Some(Scopes::Services));
    assert!(!store.saved().unwrap().contains("scopes"));
    // A refresh never widens it back, whatever the response says.
    http.token("fictional-a5", Some("fictional-r5"), Some(OPERATIONS));
    assert_eq!(restarted.refresh().unwrap().scopes, Some(Scopes::Services));
    assert!(!store.saved().unwrap().contains("scopes"));
    let again = controller(&store, &http);
    http.token("fictional-a6", Some("fictional-r6"), None);
    assert_eq!(again.refresh().unwrap().scopes, Some(Scopes::Services));
    // A refresh granting something Ozzie never asks for is refused; the saved record stays and
    // the refused credential is revoked.
    let before = store.saved();
    http.token(
        "fictional-a7",
        Some("fictional-r7"),
        Some(r#""services giving openid""#),
    );
    assert_eq!(again.refresh().err(), Some(AuthError::ScopeMismatch));
    assert_eq!(store.saved(), before);
    assert_eq!(again.status().unwrap().scopes, None);
    assert_eq!(
        http.revoked(),
        [("fictional-r7".into(), "refresh_token".into())]
    );
}

#[test]
fn a_new_sign_in_revokes_the_credential_it_replaces() {
    let store = Arc::new(MemoryStore::default());
    let http = Scripted::new();
    let auth = controller(&store, &http);
    // Nothing saved yet: nothing to revoke.
    http.token("fictional-a1", Some("fictional-r1"), Some(OPERATIONS));
    sign_in(&auth, Scopes::ServicesAndOperations).unwrap();
    assert!(http.revoked().is_empty());
    // Narrowing to Services: the wider credential it replaces is revoked once B is saved.
    http.token("fictional-a2", Some("fictional-r2"), Some(SERVICES));
    assert_eq!(
        sign_in(&auth, Scopes::Services).unwrap().scopes,
        Some(Scopes::Services)
    );
    assert!(store.saved().unwrap().contains("fictional-a2"));
    assert_eq!(
        http.revoked(),
        [("fictional-r1".into(), "refresh_token".into())]
    );
    // Planning Center handing back the same credential is not a replacement.
    http.token("fictional-a2", Some("fictional-r2"), Some(SERVICES));
    sign_in(&auth, Scopes::Services).unwrap();
    assert_eq!(http.revoked().len(), 1);
    // A failed sign-in replaces nothing and revokes nothing.
    *http.organization.lock().unwrap() = "1002".into();
    http.token("fictional-a3", Some("fictional-r3"), Some(SERVICES));
    assert_eq!(
        sign_in(&auth, Scopes::Services).err(),
        Some(AuthError::OrganizationUnverified)
    );
    assert!(store.saved().unwrap().contains("fictional-a2"));
    assert_eq!(http.revoked().len(), 1);
    *http.organization.lock().unwrap() = "1001".into();
    // After a restart the saved credential is still replaced and revoked; a failed revoke never
    // fails the new sign-in.
    let restarted = controller(&store, &http);
    *http.revoke_status.lock().unwrap() = 500;
    http.token("fictional-a4", None, Some(SERVICES));
    sign_in(&restarted, Scopes::Services).unwrap();
    assert!(store.saved().unwrap().contains("fictional-a4"));
    assert_eq!(
        http.revoked()[1..],
        [("fictional-r2".into(), "refresh_token".into())]
    );
    // A replaced credential without a refresh token is revoked by its access token.
    *http.revoke_status.lock().unwrap() = 200;
    http.token("fictional-a5", Some("fictional-r5"), Some(SERVICES));
    sign_in(&restarted, Scopes::Services).unwrap();
    assert_eq!(
        http.revoked()[2..],
        [("fictional-a4".into(), "access_token".into())]
    );
    // Disconnect, then sign in: nothing left to replace.
    restarted.disconnect().unwrap();
    let revoked = http.revoked().len();
    http.token("fictional-a6", Some("fictional-r6"), Some(SERVICES));
    sign_in(&restarted, Scopes::Services).unwrap();
    assert_eq!(http.revoked().len(), revoked);
}
