//! Identical external BASE/FINAL fixture. Only public legacy interfaces are imported.
use base64::Engine;
use ozzie_native_auth::{
    credentials::{CredentialStore, StoreError},
    oauth::*,
};
use sha2::Digest;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicU64, Ordering},
};

#[derive(Default)]
struct Store {
    bytes: Mutex<Option<Vec<u8>>>,
    trace: Mutex<Vec<&'static str>>,
}
impl CredentialStore for Store {
    fn get(&self, _: &str, _: &str) -> Result<Option<Vec<u8>>, StoreError> {
        self.trace.lock().unwrap().push("get");
        Ok(self.bytes.lock().unwrap().clone())
    }
    fn put(&self, _: &str, _: &str, b: &[u8]) -> Result<(), StoreError> {
        self.trace.lock().unwrap().push("put");
        *self.bytes.lock().unwrap() = Some(b.to_vec());
        Ok(())
    }
    fn delete(&self, _: &str, _: &str) -> Result<(), StoreError> {
        self.trace.lock().unwrap().push("delete");
        *self.bytes.lock().unwrap() = None;
        Ok(())
    }
}
#[derive(Default)]
struct FakeProvider {
    challenge: Mutex<Option<String>>,
    trace: Mutex<Vec<&'static str>>,
}
fn tokens() -> Tokens {
    Tokens {
        access_token: "fictional-access".into(),
        refresh_token: Some("fictional-refresh".into()),
        token_type: "bearer".into(),
        expires_in: 7200,
    }
}
impl Provider for FakeProvider {
    fn exchange(&self, client: &str, code: &str, verifier: &str) -> Result<Tokens, AuthError> {
        assert_eq!((client, code), ("fictional-client", "fictional-code"));
        assert_eq!(verifier.len(), 43);
        assert_eq!(
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(sha2::Sha256::digest(verifier.as_bytes())),
            self.challenge.lock().unwrap().take().unwrap()
        );
        self.trace.lock().unwrap().push("exchange-pkce-correlated");
        Ok(tokens())
    }
    fn organization(&self, access: &str) -> Result<String, AuthError> {
        assert_eq!(access, "fictional-access");
        self.trace.lock().unwrap().push("organization");
        Ok("1001".into())
    }
    fn refresh(&self, client: &str, refresh: &str) -> Result<Tokens, AuthError> {
        assert_eq!((client, refresh), ("fictional-client", "fictional-refresh"));
        self.trace.lock().unwrap().push("refresh");
        let mut t = tokens();
        t.refresh_token = None;
        Ok(t)
    }
    fn revoke(&self, client: &str, token: &str, hint: &str) -> Result<(), AuthError> {
        assert_eq!(
            (client, token, hint),
            ("fictional-client", "fictional-refresh", "refresh_token")
        );
        self.trace.lock().unwrap().push("revoke-failed");
        Err(AuthError::ProviderFailure)
    }
}
fn binding() -> Binding {
    Binding {
        workspace: "fictional-workspace".into(),
        organization: "1001".into(),
        client_id: "fictional-client".into(),
    }
}
fn begin(auth: &AuthController, p: &FakeProvider) -> String {
    let u = url::Url::parse(&auth.begin().unwrap()).unwrap();
    let q: std::collections::HashMap<_, _> = u.query_pairs().into_owned().collect();
    assert_eq!(q["client_id"], "fictional-client");
    assert_eq!(q["redirect_uri"], REDIRECT_URI);
    assert_eq!(q["response_type"], "code");
    // The default sign-in is unchanged: Services and identity only (operations scopes are opt-in).
    assert_eq!(q["scope"], "services openid");
    assert_eq!(q["code_challenge_method"], "S256");
    assert_eq!(q["state"].len(), 43);
    assert_eq!(q.len(), 7);
    *p.challenge.lock().unwrap() = Some(q["code_challenge"].clone());
    format!("{REDIRECT_URI}?code=fictional-code&state={}", q["state"])
}
fn status(auth: &AuthController, state: &str, checked: &str, problem: &str) -> String {
    let actual = serde_json::to_string(&auth.status().unwrap()).unwrap();
    // A verified connection also reports its granted scope set (additive, last field).
    let scopes = if state == "connected" {
        ",\"scopes\":\"services\""
    } else {
        ""
    };
    let expected = format!(
        "{{\"state\":\"{state}\",\"organization\":\"1001\",\"checked_at_ms\":{checked},\"source\":\"Planning Center /oauth/userinfo\",\"problem\":{problem}{scopes}}}"
    );
    assert_eq!(actual, expected);
    actual
}
#[test]
fn sunday_legacy_literal_trace() {
    let s = Arc::new(Store::default());
    let p = Arc::new(FakeProvider::default());
    let clock = Arc::new(AtomicU64::new(17));
    let c = clock.clone();
    let auth = AuthController::new(
        binding(),
        s.clone(),
        p.clone(),
        Arc::new(move || c.load(Ordering::SeqCst)),
    )
    .unwrap();
    let mut rows = vec![status(&auth, "disconnected", "null", "null")];
    let callback = begin(&auth, &p);
    rows.push(status(&auth, "waiting", "null", "null"));
    assert_eq!(
        auth.callback("invalid").err(),
        Some(AuthError::InvalidCallback)
    );
    assert_eq!(
        auth.callback(&format!("{REDIRECT_URI}?state=wrong&code=fictional-code"))
            .err(),
        Some(AuthError::StateMismatch)
    );
    auth.callback(&callback).unwrap();
    rows.push(status(&auth, "connected", "17", "null"));
    assert_eq!(
        auth.callback(&callback).err(),
        Some(AuthError::StateMismatch)
    );
    let expected = br#"{"client_id":"fictional-client","organization":"1001","tokens":{"access_token":"fictional-access","refresh_token":"fictional-refresh","token_type":"bearer","expires_in":7200}}"#;
    assert_eq!(
        s.bytes.lock().unwrap().as_deref(),
        Some(expected.as_slice())
    );
    auth.refresh().unwrap();
    rows.push(status(&auth, "connected", "17", "null"));
    assert_eq!(
        s.bytes.lock().unwrap().as_deref(),
        Some(expected.as_slice())
    );
    assert_eq!(auth.disconnect().err(), Some(AuthError::ProviderFailure));
    rows.push(status(&auth, "failed", "null", "\"provider-failure\""));
    assert_eq!(
        s.bytes.lock().unwrap().as_deref(),
        Some(expected.as_slice())
    );
    let c = clock.clone();
    let other = AuthController::new(
        binding(),
        s.clone(),
        p.clone(),
        Arc::new(move || c.load(Ordering::SeqCst)),
    )
    .unwrap();
    rows.push(status(&other, "stored-unchecked", "null", "null"));
    let expired = begin(&other, &p);
    clock.store(300_017, Ordering::SeqCst);
    assert_eq!(other.callback(&expired).err(), Some(AuthError::Expired));
    rows.push(status(&other, "expired", "null", "\"expired\""));
    assert_eq!(
        other.callback(&expired).err(),
        Some(AuthError::StateMismatch)
    );
    let cancelled = begin(&other, &p);
    other.cancel();
    rows.push(status(&other, "cancelled", "null", "null"));
    assert_eq!(
        other.callback(&cancelled).err(),
        Some(AuthError::StateMismatch)
    );
    assert_eq!(
        *s.trace.lock().unwrap(),
        ["get", "put", "get", "put", "get", "get", "get"]
    );
    assert_eq!(
        *p.trace.lock().unwrap(),
        [
            "exchange-pkce-correlated",
            "organization",
            "refresh",
            "organization",
            "revoke-failed"
        ]
    );
    println!(
        "LEGACY_TRACE={}",
        serde_json::json!({
            "statuses_in_literal_key_order":rows,
            "store":*s.trace.lock().unwrap(),
            "provider":*p.trace.lock().unwrap(),
            "stored_fake_bytes":String::from_utf8(expected.to_vec()).unwrap(),
            "entropy":"Only state/nonce/challenge/verifier values omitted after length, URL fields and actual SHA256 challenge-verifier correlation checks"
        })
    );
}
