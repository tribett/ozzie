//! Check-Ins and Registrations are each their own opt-in: asked for only when chosen, counted only
//! when granted, refused when a grant names more than was asked, and never widened by a refresh.
//! The original Services and operations sets keep their saved bytes. Fictional values only.
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

fn scope_of(url: &str) -> String {
    url::Url::parse(url)
        .unwrap()
        .query_pairs()
        .find(|(k, _)| k == "scope")
        .unwrap()
        .1
        .into_owned()
}
fn granted(
    asked: Scopes,
    scope: &str,
) -> (
    Arc<MemoryStore>,
    Result<ConnectionStatus, AuthError>,
    Arc<Scripted>,
) {
    let store = Arc::new(MemoryStore::default());
    let http = Scripted::new();
    http.token("fictional-access", Some("fictional-refresh"), Some(scope));
    let auth = controller(&store, &http);
    let status = sign_in(&auth, asked);
    (store, status, http)
}
const ALL: &str = r#""services calendar people groups check_ins registrations openid""#;

#[test]
fn each_product_is_asked_for_only_when_chosen_by_planning_centers_own_scope_name() {
    let store = Arc::new(MemoryStore::default());
    let http = Scripted::new();
    let auth = controller(&store, &http);
    for (scopes, asked) in [
        (Scopes::Services, "services openid"),
        (
            Scopes::ServicesAndOperations,
            "services calendar people groups openid",
        ),
        (
            Scopes::Services.with_check_ins(true),
            "services check_ins openid",
        ),
        (
            Scopes::Services.with_registrations(true),
            "services registrations openid",
        ),
        (
            Scopes::ServicesAndOperations
                .with_check_ins(true)
                .with_registrations(true),
            "services calendar people groups check_ins registrations openid",
        ),
        // Turning one off again asks for less.
        (
            Scopes::Widest.with_check_ins(false),
            "services calendar people groups registrations openid",
        ),
    ] {
        assert_eq!(scope_of(&auth.begin_with(scopes).unwrap()), asked);
        assert_eq!(scopes.oauth(), asked);
    }
}

#[test]
fn check_ins_and_registrations_count_only_when_granted_and_each_on_its_own() {
    let asked = Scopes::Widest;
    for (scope, operations, check_ins, registrations) in [
        (ALL, true, true, true),
        (r#""services check_ins openid""#, false, true, false),
        (r#""registrations services""#, false, false, true),
        (
            r#""services calendar people groups registrations openid""#,
            true,
            false,
            true,
        ),
        (
            r#""services calendar people check_ins openid""#,
            false,
            true,
            false,
        ),
        (r#""services openid""#, false, false, false),
    ] {
        let (_, status, http) = granted(asked, scope);
        let scopes = status.unwrap().scopes.unwrap();
        assert_eq!(
            (
                scopes.operations(),
                scopes.check_ins(),
                scopes.registrations()
            ),
            (operations, check_ins, registrations),
            "{scope}"
        );
        assert!(http.revoked().is_empty());
    }
}

#[test]
fn a_grant_naming_check_ins_or_registrations_that_was_not_asked_for_is_refused_and_revoked() {
    for (asked, scope) in [
        (Scopes::Services, r#""services check_ins openid""#),
        (Scopes::Services, r#""services registrations openid""#),
        (Scopes::ServicesAndOperations, ALL),
        (
            Scopes::Services.with_check_ins(true),
            r#""services check_ins registrations openid""#,
        ),
        (
            Scopes::Services.with_registrations(true),
            r#""services check_ins openid""#,
        ),
        // A spelling Planning Center doesn't use is not Check-Ins.
        (
            Scopes::Services.with_check_ins(true),
            r#""services check-ins openid""#,
        ),
        (
            Scopes::Widest,
            r#""services check_ins registrations giving openid""#,
        ),
        (Scopes::Widest, r#""check_ins registrations openid""#),
    ] {
        let (store, status, http) = granted(asked, scope);
        assert_eq!(
            status.err(),
            Some(AuthError::ScopeMismatch),
            "{asked:?} {scope}"
        );
        assert!(store.saved().is_none(), "{scope}");
        assert_eq!(
            http.revoked(),
            [("fictional-refresh".into(), "refresh_token".into())],
            "{scope}"
        );
    }
}

#[test]
fn saved_and_reported_sets_have_one_spelling_and_the_original_two_keep_their_bytes() {
    for (asked, scope, label) in [
        (
            Scopes::Services.with_check_ins(true),
            r#""services check_ins openid""#,
            "services+check-ins",
        ),
        (
            Scopes::Services.with_registrations(true),
            r#""services registrations openid""#,
            "services+registrations",
        ),
        (
            Scopes::Widest,
            ALL,
            "services-and-operations+check-ins+registrations",
        ),
    ] {
        let (store, status, _) = granted(asked, scope);
        let status = status.unwrap();
        assert_eq!(serde_json::to_value(&status).unwrap()["scopes"], label);
        assert!(
            store
                .saved()
                .unwrap()
                .contains(&format!(r#""scopes":"{label}""#))
        );
        assert_eq!(Scopes::from_label(label), status.scopes);
    }
    let (store, status, _) = granted(
        Scopes::ServicesAndOperations,
        r#""services calendar people groups openid""#,
    );
    assert_eq!(
        serde_json::to_value(status.unwrap()).unwrap()["scopes"],
        "services-and-operations"
    );
    assert!(
        store
            .saved()
            .unwrap()
            .contains(r#""scopes":"services-and-operations""#)
    );
    let (store, status, _) = granted(
        Scopes::Services.with_check_ins(true),
        r#""services openid""#,
    );
    assert_eq!(
        serde_json::to_value(status.unwrap()).unwrap()["scopes"],
        "services"
    );
    assert!(!store.saved().unwrap().contains("scopes"));
    // Any other spelling is not a set Ozzie knows.
    for bad in [
        "services+registrations+check-ins",
        "services+check-ins+check-ins",
        "services+giving",
        "services-and-operations+",
        "check-ins",
        "Services+check-ins",
        "services check-ins",
        "",
    ] {
        assert_eq!(Scopes::from_label(bad), None, "{bad}");
        assert!(
            serde_json::from_str::<Scopes>(&format!("{bad:?}")).is_err(),
            "{bad}"
        );
    }
}

#[test]
fn a_saved_record_with_an_unknown_set_is_refused_not_guessed() {
    let (store, status, http) = granted(
        Scopes::Services.with_check_ins(true),
        r#""services check_ins openid""#,
    );
    status.unwrap();
    let widened = store
        .saved()
        .unwrap()
        .replace("services+check-ins", "services+check-ins+giving");
    store
        .put("fictional-workspace", "1001", widened.as_bytes())
        .unwrap();
    http.token("fictional-a2", Some("fictional-r2"), None);
    let restarted = controller(&store, &http);
    assert!(restarted.refresh().is_err());
    assert_eq!(restarted.status().unwrap().scopes, None);
}

/// A saved sign-in this version can't read (a later version's spelling, or a damaged one) never
/// blocks Disconnect: Ozzie still signs it out at Planning Center when it can tell which
/// credential it is, and removes it from this Mac. A new sign-in replaces it the same way.
#[test]
fn disconnect_and_a_new_sign_in_never_fail_on_a_saved_spelling_this_version_cannot_read() {
    for unknown in ["services+check-ins+giving", "everything"] {
        let (store, status, http) = granted(
            Scopes::Services.with_check_ins(true),
            r#""services check_ins openid""#,
        );
        status.unwrap();
        let later = store
            .saved()
            .unwrap()
            .replace("services+check-ins", unknown);
        store
            .put("fictional-workspace", "1001", later.as_bytes())
            .unwrap();
        let restarted = controller(&store, &http);
        let status = restarted.disconnect().unwrap();
        assert_eq!(status.state, ConnectionState::Disconnected, "{unknown}");
        assert!(store.saved().is_none(), "{unknown}");
        assert_eq!(
            http.revoked(),
            [("fictional-refresh".into(), "refresh_token".into())],
            "{unknown}"
        );
    }
    // Bytes that aren't a sign-in at all: nothing to revoke, and they're still removed.
    let store = Arc::new(MemoryStore::default());
    let http = Scripted::new();
    store
        .put("fictional-workspace", "1001", b"not a saved sign-in")
        .unwrap();
    let auth = controller(&store, &http);
    assert_eq!(
        auth.disconnect().unwrap().state,
        ConnectionState::Disconnected
    );
    assert!(store.saved().is_none());
    assert!(http.revoked().is_empty());
    // A new sign-in over an unreadable saved one replaces it and signs the old one out.
    let (store, status, http) = granted(
        Scopes::Services.with_check_ins(true),
        r#""services check_ins openid""#,
    );
    status.unwrap();
    let later = store
        .saved()
        .unwrap()
        .replace("services+check-ins", "services+check-ins+giving");
    store
        .put("fictional-workspace", "1001", later.as_bytes())
        .unwrap();
    http.token(
        "fictional-a2",
        Some("fictional-r2"),
        Some(r#""services openid""#),
    );
    let restarted = controller(&store, &http);
    assert_eq!(
        sign_in(&restarted, Scopes::Services).unwrap().scopes,
        Some(Scopes::Services)
    );
    assert!(store.saved().unwrap().contains("fictional-a2"));
    assert_eq!(
        http.revoked(),
        [("fictional-refresh".into(), "refresh_token".into())]
    );
}

/// An unreadable saved sign-in that names another church is never signed out as this one: it's
/// removed from this Mac without a revoke, and the result says so. One whose tokens don't pass
/// the usual checks but still hold a refresh token is signed out with it before it's removed.
#[test]
fn disconnect_on_an_unreadable_sign_in_checks_its_church_and_still_revokes_a_refresh_token() {
    let (store, status, http) = granted(
        Scopes::Services.with_check_ins(true),
        r#""services check_ins openid""#,
    );
    status.unwrap();
    let other = store
        .saved()
        .unwrap()
        .replace("services+check-ins", "services+check-ins+giving")
        .replace(r#""organization":"1001""#, r#""organization":"1002""#);
    assert!(other.contains(r#""organization":"1002""#));
    store
        .put("fictional-workspace", "1001", other.as_bytes())
        .unwrap();
    let status = controller(&store, &http).disconnect().unwrap();
    assert_eq!(status.state, ConnectionState::Disconnected);
    assert_eq!(status.problem, Some(AuthError::OrganizationUnverified));
    assert_eq!(
        serde_json::to_value(&status).unwrap()["problem"],
        "organization-unverified"
    );
    assert!(store.saved().is_none());
    assert!(http.revoked().is_empty());

    // Tokens that fail the usual checks (here `expires_in: 0`), with a refresh token still there.
    let (store, status, http) = granted(Scopes::Services, r#""services openid""#);
    status.unwrap();
    let damaged = store
        .saved()
        .unwrap()
        .replace(r#""expires_in":7200"#, r#""expires_in":0"#);
    assert!(damaged.contains(r#""expires_in":0"#));
    store
        .put("fictional-workspace", "1001", damaged.as_bytes())
        .unwrap();
    let status = controller(&store, &http).disconnect().unwrap();
    assert_eq!(status.state, ConnectionState::Disconnected);
    assert_eq!(status.problem, None);
    assert!(store.saved().is_none());
    assert_eq!(
        http.revoked(),
        [("fictional-refresh".into(), "refresh_token".into())]
    );
}

#[test]
fn a_refresh_keeps_or_narrows_check_ins_and_registrations_and_never_widens_them() {
    let store = Arc::new(MemoryStore::default());
    let http = Scripted::new();
    http.token(
        "fictional-a1",
        Some("fictional-r1"),
        Some(r#""services check_ins openid""#),
    );
    let auth = controller(&store, &http);
    let check_ins = Scopes::Services.with_check_ins(true);
    assert_eq!(sign_in(&auth, check_ins).unwrap().scopes, Some(check_ins));
    // Omitted on refresh: the original grant.
    http.token("fictional-a2", Some("fictional-r2"), None);
    assert_eq!(auth.refresh().unwrap().scopes, Some(check_ins));
    // A refresh naming more of what Ozzie can ask for never adds it to the saved set.
    http.token("fictional-a3", Some("fictional-r3"), Some(ALL));
    assert_eq!(auth.refresh().unwrap().scopes, Some(check_ins));
    assert!(
        store
            .saved()
            .unwrap()
            .contains(r#""scopes":"services+check-ins""#)
    );
    // A refresh without Check-Ins narrows it away, for good.
    http.token(
        "fictional-a4",
        Some("fictional-r4"),
        Some(r#""services openid""#),
    );
    assert_eq!(auth.refresh().unwrap().scopes, Some(Scopes::Services));
    http.token(
        "fictional-a5",
        Some("fictional-r5"),
        Some(r#""services check_ins openid""#),
    );
    assert_eq!(auth.refresh().unwrap().scopes, Some(Scopes::Services));
    assert!(!store.saved().unwrap().contains("scopes"));
    // Anything Ozzie never asks for is refused on refresh too.
    http.token(
        "fictional-a6",
        Some("fictional-r6"),
        Some(r#""services check_ins people_write openid""#),
    );
    assert_eq!(auth.refresh().err(), Some(AuthError::ScopeMismatch));
    assert_eq!(
        http.revoked(),
        [("fictional-r6".into(), "refresh_token".into())]
    );
}
