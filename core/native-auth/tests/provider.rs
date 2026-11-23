use ozzie_native_auth::{oauth::*, provider::*};
use std::sync::Mutex;
use zeroize::Zeroizing;
struct Scripted {
    response: String,
    status: u16,
    calls: Mutex<Vec<(Endpoint, Option<String>, bool)>>,
}
impl Http for Scripted {
    fn send(
        &self,
        endpoint: Endpoint,
        form: Option<&str>,
        bearer: Option<&str>,
    ) -> Result<Response, AuthError> {
        self.calls
            .lock()
            .unwrap()
            .push((endpoint, form.map(str::to_owned), bearer.is_some()));
        Ok(Response {
            status: self.status,
            body: Zeroizing::new(self.response.as_bytes().to_vec()),
            retry_after: None,
        })
    }
}
fn scripted(response: &str) -> PcoProvider<Scripted> {
    PcoProvider(Scripted {
        response: response.into(),
        status: 200,
        calls: Mutex::new(vec![]),
    })
}
#[test]
fn public_exchange_uses_form_pkce_without_shared_secret_or_token_response_org() {
    let provider = scripted(
        r#"{"access_token":"fictional-access","refresh_token":"fictional-refresh","token_type":"bearer","expires_in":7200}"#,
    );
    let tokens = provider
        .exchange("fictional-client", "fictional-code", "fictional-verifier")
        .unwrap();
    assert_eq!(tokens.access_token, "fictional-access");
    let calls = provider.0.calls.lock().unwrap();
    let (endpoint, form, bearer) = &calls[0];
    assert_eq!(*endpoint, Endpoint::Token);
    let form: std::collections::HashMap<_, _> =
        url::form_urlencoded::parse(form.as_ref().unwrap().as_bytes())
            .into_owned()
            .collect();
    assert_eq!(form.get("code_verifier").unwrap(), "fictional-verifier");
    assert_eq!(form.get("redirect_uri").unwrap(), REDIRECT_URI);
    assert!(!form.contains_key("client_secret"));
    assert!(!bearer);
}
#[test]
fn userinfo_retains_only_documented_organization_identity() {
    for body in [
        r#"{"organization_id":1001,"name":"fictional-name","email":"fictional@example.invalid"}"#,
        r#"{"organization_id":"1001"}"#,
    ] {
        let provider = scripted(body);
        assert_eq!(provider.organization("fictional-access").unwrap(), "1001");
        assert_eq!(
            provider.0.calls.lock().unwrap()[0],
            (Endpoint::UserInfo, None, true)
        );
    }
}
#[test]
fn unknown_or_malformed_organization_fails_closed() {
    for body in [
        "{}",
        "null",
        r#"{"organization_id":null}"#,
        r#"{"organization_id":false}"#,
        r#"{"organization_id":1.1}"#,
        r#"{"organization_id":""}"#,
    ] {
        assert_eq!(
            scripted(body).organization("fictional-access").err(),
            Some(AuthError::OrganizationUnverified)
        );
    }
}
#[test]
fn malformed_or_denied_token_responses_never_expose_provider_body() {
    for body in [
        "fictional-error-secret",
        r#"{"access_token":"fictional-error-secret"}"#,
    ] {
        let error = scripted(body)
            .exchange("client", "code", "verifier")
            .err()
            .unwrap();
        assert_eq!(error, AuthError::InvalidToken);
        assert!(!format!("{error:?}").contains("fictional-error-secret"));
    }
    let provider = PcoProvider(Scripted {
        response: "fictional-error-secret".into(),
        status: 401,
        calls: Mutex::new(vec![]),
    });
    // A refused renewal (below): the saved sign-in can't be renewed, and the body isn't kept.
    let error = provider.refresh("client", "fictional-refresh").err();
    assert_eq!(error, Some(AuthError::InvalidToken));
    assert!(!format!("{error:?}").contains("fictional-error-secret"));
}
#[test]
fn a_refused_renewal_is_told_apart_from_an_unreachable_planning_center() {
    // A refresh token Planning Center no longer accepts (revoked, or run out: `invalid_grant`) can't
    // be renewed by trying again, and signing in again is what helps. Out of reach or overloaded is
    // worth another try. (RFC 6749 §5.2 refuses with 400 or 401; 403 is a refusal as for revoke.)
    for (status, error) in [
        (400, AuthError::InvalidToken),
        (401, AuthError::InvalidToken),
        (403, AuthError::InvalidToken),
        (429, AuthError::ProviderFailure),
        (500, AuthError::ProviderFailure),
        (503, AuthError::ProviderFailure),
    ] {
        assert_eq!(
            with_status(status, r#"{"error":"invalid_grant"}"#)
                .refresh("client", "fictional-refresh")
                .err(),
            Some(error),
            "{status}"
        );
    }
    // A sign-in's code exchange is unchanged: a refusal there is the provider failure it was.
    for status in [400, 401, 403, 503] {
        assert_eq!(
            with_status(status, "{}")
                .exchange("client", "fictional-code", "fictional-verifier")
                .err(),
            Some(AuthError::ProviderFailure),
            "{status}"
        );
    }
}
#[test]
fn revoke_prefers_refresh_token_and_has_no_client_secret() {
    let provider = scripted("{}");
    provider
        .revoke("client", "fictional-refresh", "refresh_token")
        .unwrap();
    let calls = provider.0.calls.lock().unwrap();
    assert_eq!(calls[0].0, Endpoint::Revoke);
    let form = calls[0].1.as_ref().unwrap();
    assert!(form.contains("token_type_hint=refresh_token"));
    assert!(!form.contains("client_secret"));
}
fn with_status(status: u16, response: &str) -> PcoProvider<Scripted> {
    PcoProvider(Scripted {
        response: response.into(),
        status,
        calls: Mutex::new(vec![]),
    })
}
#[test]
fn a_refused_revoke_is_told_apart_from_an_unreachable_planning_center() {
    for (status, error) in [
        (400, AuthError::RevokeRefused),
        (401, AuthError::RevokeRefused),
        (403, AuthError::RevokeRefused),
        (429, AuthError::ProviderFailure),
        (503, AuthError::ProviderFailure),
    ] {
        assert_eq!(
            with_status(status, "{}")
                .revoke("client", "fictional-refresh", "refresh_token")
                .err(),
            Some(error),
            "{status}"
        );
    }
}
#[test]
fn userinfo_keeps_the_churchs_name_and_never_the_persons() {
    // The same single userinfo read as before: one request, the church's name kept as display
    // text; the signed-in person's own name and email are never read.
    let body = format!(
        r#"{{"sub":"1","name":"fictional-person-canary","email":"fictional-email-canary","organization_id":1001,"organization_name":" Fictional Grace{} Church "}}"#,
        '\u{202E}'
    );
    let provider = scripted(&body);
    let named = provider.organization_named("fictional-access").unwrap();
    assert_eq!(named.id, "1001");
    assert_eq!(named.name.as_deref(), Some("Fictional Grace Church"));
    assert_eq!(provider.0.calls.lock().unwrap().len(), 1);
    assert_eq!(provider.0.calls.lock().unwrap()[0].0, Endpoint::UserInfo);
    for body in [
        r#"{"organization_id":1001}"#,
        r#"{"organization_id":1001,"organization_name":7}"#,
        r#"{"organization_id":1001,"organization_name":"   "}"#,
        "[1001]",
    ] {
        let named = scripted(body)
            .organization_named("fictional-access")
            .unwrap();
        assert_eq!((named.id.as_str(), named.name), ("1001", None), "{body}");
    }
}
