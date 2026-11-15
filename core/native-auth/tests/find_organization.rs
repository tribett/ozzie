//! One-click Planning Center connect: sign in with Ozzie's own Public registration and let
//! Planning Center name the organization, then hand over to an ordinary bound connection.
use ozzie_native_auth::credentials::{CredentialStore, StoreError};
use ozzie_native_auth::oauth::*;
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct MemoryStore(Mutex<std::collections::HashMap<String, Vec<u8>>>);
impl CredentialStore for MemoryStore {
    fn put(&self, w: &str, o: &str, value: &[u8]) -> Result<(), StoreError> {
        if w.is_empty() || o.is_empty() {
            return Err(StoreError::Unavailable);
        }
        self.0
            .lock()
            .unwrap()
            .insert(format!("{w}:{o}"), value.to_vec());
        Ok(())
    }
    fn get(&self, w: &str, o: &str) -> Result<Option<Vec<u8>>, StoreError> {
        if w.is_empty() || o.is_empty() {
            return Err(StoreError::Unavailable);
        }
        Ok(self.0.lock().unwrap().get(&format!("{w}:{o}")).cloned())
    }
    fn delete(&self, w: &str, o: &str) -> Result<(), StoreError> {
        if w.is_empty() || o.is_empty() {
            return Err(StoreError::Unavailable);
        }
        self.0.lock().unwrap().remove(&format!("{w}:{o}"));
        Ok(())
    }
}
/// Names `organization` at userinfo and records every revoked token.
struct Church {
    organization: &'static str,
    access: &'static str,
    refresh: &'static str,
    revoked: Mutex<Vec<String>>,
}
impl Church {
    fn new(organization: &'static str) -> Arc<Self> {
        Arc::new(Self {
            organization,
            access: "fictional-found-access",
            refresh: "fictional-found-refresh",
            revoked: Mutex::default(),
        })
    }
}
impl Provider for Church {
    fn exchange(&self, _: &str, _: &str, verifier: &str) -> Result<Tokens, AuthError> {
        assert_eq!(verifier.len(), 43);
        Ok(Tokens {
            access_token: self.access.into(),
            refresh_token: Some(self.refresh.into()),
            token_type: "bearer".into(),
            expires_in: 7200,
        })
    }
    fn organization(&self, _: &str) -> Result<String, AuthError> {
        Ok(self.organization.into())
    }
    fn refresh(&self, _: &str, _: &str) -> Result<Tokens, AuthError> {
        Ok(Tokens {
            access_token: "fictional-refreshed-access".into(),
            refresh_token: Some("fictional-refreshed-refresh".into()),
            token_type: "bearer".into(),
            expires_in: 7200,
        })
    }
    fn revoke(&self, client: &str, token: &str, _: &str) -> Result<(), AuthError> {
        self.revoked
            .lock()
            .unwrap()
            .push(format!("{client}/{token}"));
        Ok(())
    }
}
fn finder(store: Arc<MemoryStore>, church: Arc<Church>) -> AuthController {
    AuthController::find_organization(
        "fictional-app-client".into(),
        "local:",
        store,
        church,
        Arc::new(|| 1_000),
    )
    .unwrap()
}
fn sign_in(auth: &AuthController, scopes: Scopes) -> Result<ConnectionStatus, AuthError> {
    let url = url::Url::parse(&auth.begin_with(scopes).unwrap()).unwrap();
    let pairs: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
    assert_eq!(pairs["code_challenge_method"], "S256");
    let granted = scopes.oauth().replace(' ', "+");
    auth.callback(&format!(
        "{REDIRECT_URI}?code=fictional-code&state={}&scope={granted}",
        pairs["state"]
    ))
}

#[test]
fn one_click_sign_in_saves_under_the_organization_planning_center_names_and_hands_over() {
    let store = Arc::new(MemoryStore::default());
    let auth = finder(store.clone(), Church::new("1001"));
    // Nothing is saved or claimed before sign-in.
    let before = auth.status().unwrap();
    assert_eq!(before.state, ConnectionState::Disconnected);
    assert_eq!(before.organization, "");
    assert!(auth.adopt_found().is_err());

    let url = url::Url::parse(&auth.begin().unwrap()).unwrap();
    assert!(
        url.query_pairs()
            .any(|(k, v)| k == "client_id" && v == "fictional-app-client")
    );
    let status = sign_in(&auth, Scopes::Services).unwrap();
    assert_eq!(status.state, ConnectionState::Connected);
    assert_eq!(status.organization, "1001");
    let json = serde_json::to_string(&status).unwrap();
    assert!(
        !json.contains("fictional-found"),
        "status carries no credential"
    );
    assert!(store.get("local:1001", "1001").unwrap().is_some());

    let bound = auth.adopt_found().unwrap();
    let handed = bound.status().unwrap();
    assert_eq!(handed.state, ConnectionState::Connected);
    assert_eq!(handed.organization, "1001");
    assert_eq!(handed.scopes, Some(Scopes::Services));
    assert_eq!(handed.checked_at_ms, Some(1_000));
    assert!(
        handed.found,
        "the hand-over says Planning Center named the organization"
    );
    assert!(
        serde_json::to_string(&handed)
            .unwrap()
            .contains("\"found\":true")
    );
    // Single use: the finder is retired and cannot hand over twice.
    assert_eq!(auth.status().unwrap().state, ConnectionState::Cancelled);
    assert!(auth.adopt_found().is_err());
    // The bound connection is an ordinary one: refresh re-verifies and keeps the saved scopes.
    let refreshed = bound.refresh().unwrap();
    assert_eq!(refreshed.state, ConnectionState::Connected);
    assert_eq!(refreshed.scopes, Some(Scopes::Services));
}

#[test]
fn a_fresh_bound_controller_finds_the_one_click_connection_on_next_launch() {
    let store = Arc::new(MemoryStore::default());
    let church = Church::new("1001");
    let auth = finder(store.clone(), church.clone());
    sign_in(&auth, Scopes::ServicesAndOperations).unwrap();
    drop(auth.adopt_found().unwrap());
    let next = AuthController::new(
        Binding {
            workspace: "local:1001".into(),
            organization: "1001".into(),
            client_id: "fictional-app-client".into(),
        },
        store,
        church,
        Arc::new(|| 2_000),
    )
    .unwrap();
    assert_eq!(
        next.status().unwrap().state,
        ConnectionState::StoredUnchecked
    );
    let status = next.refresh().unwrap();
    assert_eq!(status.state, ConnectionState::Connected);
    assert_eq!(status.scopes, Some(Scopes::ServicesAndOperations));
    assert!(!status.found);
}

#[test]
fn the_finder_never_reads_refreshes_or_claims_a_connection_of_its_own() {
    let store = Arc::new(MemoryStore::default());
    let auth = finder(store.clone(), Church::new("1001"));
    assert!(auth.refresh().is_err());
    sign_in(&auth, Scopes::Services).unwrap();
    // Even after sign-in, the finder has no saved connection of its own to refresh or read.
    assert!(auth.refresh().is_err());
}

#[test]
fn an_unusable_organization_id_saves_nothing() {
    for bad in ["", "0", "01", "abc", "1001 "] {
        let store = Arc::new(MemoryStore::default());
        let auth = finder(
            store.clone(),
            Arc::new(Church {
                organization: bad,
                access: "fictional-found-access",
                refresh: "fictional-found-refresh",
                revoked: Mutex::default(),
            }),
        );
        let error = sign_in(&auth, Scopes::Services).unwrap_err();
        assert_eq!(
            error,
            AuthError::OrganizationUnverified,
            "organization {bad:?}"
        );
        assert!(
            store.0.lock().unwrap().is_empty(),
            "nothing saved for {bad:?}"
        );
        let status = auth.status().unwrap();
        assert_eq!(status.state, ConnectionState::Failed);
        assert!(auth.adopt_found().is_err());
    }
}

#[test]
fn signing_in_again_replaces_and_revokes_the_saved_connection_for_that_organization() {
    let store = Arc::new(MemoryStore::default());
    let church = Church::new("1001");
    // A connection saved earlier (for example with pasted IDs) for the same organization.
    let pasted = AuthController::new(
        Binding {
            workspace: "local:1001".into(),
            organization: "1001".into(),
            client_id: "fictional-own-client".into(),
        },
        store.clone(),
        Arc::new(Church {
            organization: "1001",
            access: "fictional-older-access",
            refresh: "fictional-older-refresh",
            revoked: Mutex::default(),
        }),
        Arc::new(|| 0),
    )
    .unwrap();
    sign_in(&pasted, Scopes::Services).unwrap();
    let auth = finder(store.clone(), church.clone());
    sign_in(&auth, Scopes::Services).unwrap();
    assert_eq!(
        church.revoked.lock().unwrap().as_slice(),
        ["fictional-own-client/fictional-older-refresh"],
        "the replaced credential's refresh token is revoked as the registration it was issued to"
    );
    let saved = String::from_utf8(store.get("local:1001", "1001").unwrap().unwrap()).unwrap();
    assert!(saved.contains("fictional-found-access"));
    assert!(!saved.contains("fictional-older-access"));
}

#[test]
fn the_hand_over_refuses_a_saved_record_that_changed_underneath_it() {
    let store = Arc::new(MemoryStore::default());
    let auth = finder(store.clone(), Church::new("1001"));
    sign_in(&auth, Scopes::Services).unwrap();
    store.delete("local:1001", "1001").unwrap();
    assert!(auth.adopt_found().is_err());

    let store = Arc::new(MemoryStore::default());
    let auth = finder(store.clone(), Church::new("1001"));
    sign_in(&auth, Scopes::Services).unwrap();
    store
        .put(
            "local:1001",
            "1001",
            br#"{"client_id":"someone-else","organization":"1001","tokens":{"access_token":"x","refresh_token":"y","token_type":"bearer","expires_in":7200}}"#,
        )
        .unwrap();
    assert!(auth.adopt_found().is_err());
}

#[test]
fn the_finder_refuses_a_bad_registration_or_prefix() {
    let store = Arc::new(MemoryStore::default());
    let church = Church::new("1001");
    for (client, prefix) in [
        ("", "local:"),
        ("bad\nclient", "local:"),
        ("fictional-app-client", ""),
    ] {
        assert!(
            AuthController::find_organization(
                client.into(),
                prefix,
                store.clone(),
                church.clone(),
                Arc::new(|| 0)
            )
            .is_err()
        );
    }
}

#[test]
fn disconnecting_a_finder_that_saved_but_was_not_handed_over_revokes_and_deletes() {
    let store = Arc::new(MemoryStore::default());
    let church = Church::new("1001");
    let auth = finder(store.clone(), church.clone());
    // Before sign-in there is nothing to revoke.
    assert_eq!(
        auth.disconnect().unwrap().state,
        ConnectionState::Disconnected
    );
    let auth = finder(store.clone(), church.clone());
    sign_in(&auth, Scopes::Services).unwrap();
    let status = auth.disconnect().unwrap();
    assert_eq!(status.state, ConnectionState::Disconnected);
    assert!(store.get("local:1001", "1001").unwrap().is_none());
    assert_eq!(
        church.revoked.lock().unwrap().as_slice(),
        ["fictional-app-client/fictional-found-refresh"]
    );
}

/// Switching organizations needs the person's confirmation (independent review R, M1/M2), so a
/// sign-in never revokes or deletes another organization's saved connection on its own. The
/// desktop app asks first and signs out only on the person's answer (connections.rs; tested in
/// tests/church_switch.rs).
#[test]
fn a_sign_in_never_revokes_or_deletes_another_organizations_connection_on_its_own() {
    let store = Arc::new(MemoryStore::default());
    let earlier = AuthController::new(
        Binding {
            workspace: "local:1001".into(),
            organization: "1001".into(),
            client_id: "fictional-own-client".into(),
        },
        store.clone(),
        Arc::new(Church {
            organization: "1001",
            access: "fictional-earlier-access",
            refresh: "fictional-earlier-refresh",
            revoked: Mutex::default(),
        }),
        Arc::new(|| 0),
    )
    .unwrap();
    sign_in(&earlier, Scopes::Services).unwrap();
    // Planning Center names another organization: that sign-in completes and hands over.
    let church = Church::new("2002");
    let auth = finder(store.clone(), church.clone());
    assert_eq!(
        sign_in(&auth, Scopes::Services).unwrap().organization,
        "2002"
    );
    assert_eq!(
        auth.adopt_found().unwrap().status().unwrap().organization,
        "2002"
    );
    // A sign-in that saves nothing.
    let unusable = Church::new("0");
    assert!(sign_in(&finder(store.clone(), unusable.clone()), Scopes::Services).is_err());
    let saved = String::from_utf8(store.get("local:1001", "1001").unwrap().unwrap()).unwrap();
    assert!(saved.contains("fictional-earlier-access"));
    assert!(church.revoked.lock().unwrap().is_empty());
    assert!(unusable.revoked.lock().unwrap().is_empty());
}

/// Fails every read of the slot, so the finder can't see what it would overwrite.
struct Unreadable(MemoryStore);
impl CredentialStore for Unreadable {
    fn put(&self, w: &str, o: &str, v: &[u8]) -> Result<(), StoreError> {
        self.0.put(w, o, v)
    }
    fn get(&self, _: &str, _: &str) -> Result<Option<Vec<u8>>, StoreError> {
        Err(StoreError::Locked)
    }
    fn delete(&self, w: &str, o: &str) -> Result<(), StoreError> {
        self.0.delete(w, o)
    }
}
#[test]
fn an_unreadable_saved_slot_fails_closed_without_overwriting_it() {
    let store = Arc::new(Unreadable(MemoryStore::default()));
    let auth = AuthController::find_organization(
        "fictional-app-client".into(),
        "local:",
        store.clone(),
        Church::new("1001"),
        Arc::new(|| 0),
    )
    .unwrap();
    assert_eq!(
        sign_in(&auth, Scopes::Services).unwrap_err(),
        AuthError::Store(StoreError::Locked)
    );
    assert!(store.0.0.lock().unwrap().is_empty());
}
