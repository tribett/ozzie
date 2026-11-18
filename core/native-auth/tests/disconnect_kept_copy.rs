//! Disconnect when this Mac's Keychain reads and replaces the saved sign-in but won't remove it
//! (seen 2026-11-17 on the owner's Mac: Planning Center accepted the revoke, then the delete was
//! refused, and Ozzie reported a failed connection with the storage "unavailable" while it was in
//! fact signed out). Fictional tokens; the Keychain and Planning Center are fakes.
use ozzie_native_auth::credentials::{CredentialStore, StoreError};
use ozzie_native_auth::oauth::*;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// Reads and writes like the Keychain; a delete is refused with `refuse_delete` while it is set.
#[derive(Default)]
struct Keychain {
    items: Mutex<HashMap<String, Vec<u8>>>,
    refuse_delete: Mutex<Option<StoreError>>,
}
impl CredentialStore for Keychain {
    fn put(&self, w: &str, o: &str, value: &[u8]) -> Result<(), StoreError> {
        self.items
            .lock()
            .unwrap()
            .insert(format!("{w}:{o}"), value.to_vec());
        Ok(())
    }
    fn get(&self, w: &str, o: &str) -> Result<Option<Vec<u8>>, StoreError> {
        Ok(self.items.lock().unwrap().get(&format!("{w}:{o}")).cloned())
    }
    fn delete(&self, w: &str, o: &str) -> Result<(), StoreError> {
        if let Some(error) = *self.refuse_delete.lock().unwrap() {
            return Err(error);
        }
        self.items.lock().unwrap().remove(&format!("{w}:{o}"));
        Ok(())
    }
}
/// Planning Center: a sign-in, the identity check, and revokes, recorded (or refused when told).
#[derive(Default)]
struct Pco {
    revoked: Mutex<Vec<String>>,
    revoke_fails: Mutex<bool>,
}
impl Provider for Pco {
    fn exchange(&self, _: &str, _: &str, _: &str) -> Result<Tokens, AuthError> {
        Ok(Tokens {
            access_token: "fictional-access".into(),
            refresh_token: Some("fictional-refresh".into()),
            token_type: "bearer".into(),
            expires_in: 7200,
        })
    }
    fn organization(&self, _: &str) -> Result<String, AuthError> {
        Ok("1001".into())
    }
    fn refresh(&self, _: &str, _: &str) -> Result<Tokens, AuthError> {
        Err(AuthError::InvalidToken)
    }
    fn revoke(&self, _: &str, token: &str, _: &str) -> Result<(), AuthError> {
        if *self.revoke_fails.lock().unwrap() {
            return Err(AuthError::ProviderFailure);
        }
        self.revoked.lock().unwrap().push(token.into());
        Ok(())
    }
}
fn connected(store: Arc<Keychain>, pco: Arc<Pco>) -> AuthController {
    let auth = AuthController::new(
        Binding {
            workspace: "local:1001".into(),
            organization: "1001".into(),
            client_id: "fictional-client".into(),
        },
        store,
        pco,
        Arc::new(|| 0),
    )
    .unwrap();
    let url = url::Url::parse(&auth.begin().unwrap()).unwrap();
    let (_, state) = url.query_pairs().find(|(k, _)| k == "state").unwrap();
    let status = auth
        .callback(&format!("{REDIRECT_URI}?code=fictional-code&state={state}"))
        .unwrap();
    assert_eq!(status.state, ConnectionState::Connected);
    auth
}

#[test]
fn signed_out_at_planning_center_is_disconnected_even_when_the_keychain_keeps_the_copy() {
    for refused in [
        StoreError::Unavailable,
        StoreError::Locked,
        StoreError::Denied,
    ] {
        let (store, pco) = (Arc::new(Keychain::default()), Arc::new(Pco::default()));
        let auth = connected(store.clone(), pco.clone());
        *store.refuse_delete.lock().unwrap() = Some(refused);
        let status = auth.disconnect().unwrap();
        // Planning Center stopped accepting it: the connection is gone, and the status says the
        // copy on this Mac couldn't be removed (it no longer works).
        assert_eq!(status.state, ConnectionState::Disconnected, "{refused:?}");
        assert_eq!(status.problem, Some(AuthError::Store(refused)));
        assert_eq!(*pco.revoked.lock().unwrap(), ["fictional-refresh"]);
        assert!(store.get("local:1001", "1001").unwrap().is_some());
        assert_eq!(
            serde_json::to_value(&status).unwrap()["problem"],
            serde_json::json!({ "store": serde_json::to_value(refused).unwrap() })
        );
    }
}

#[test]
fn not_signed_out_at_planning_center_is_not_disconnected() {
    // Planning Center couldn't be reached: nothing was revoked, nothing removed, and Disconnect
    // fails as before, so the sign-in can still be signed out later.
    let (store, pco) = (Arc::new(Keychain::default()), Arc::new(Pco::default()));
    let auth = connected(store.clone(), pco.clone());
    *pco.revoke_fails.lock().unwrap() = true;
    *store.refuse_delete.lock().unwrap() = Some(StoreError::Unavailable);
    assert_eq!(auth.disconnect().err(), Some(AuthError::ProviderFailure));
    assert!(pco.revoked.lock().unwrap().is_empty());
    assert!(store.get("local:1001", "1001").unwrap().is_some());
    // Nothing revocable at all (bytes that aren't a sign-in) and the delete refused: an error, as
    // before; there is nothing to say was signed out.
    let (store, pco) = (Arc::new(Keychain::default()), Arc::new(Pco::default()));
    let auth = connected(store.clone(), pco.clone());
    store.put("local:1001", "1001", b"not a sign-in").unwrap();
    *store.refuse_delete.lock().unwrap() = Some(StoreError::Unavailable);
    assert_eq!(
        auth.disconnect().err(),
        Some(AuthError::Store(StoreError::Unavailable))
    );
    assert!(pco.revoked.lock().unwrap().is_empty());
}
