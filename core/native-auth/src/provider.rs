use crate::oauth::{
    AuthError, Grant, OrganizationDiagnostic, OrganizationFailure, Provider, REDIRECT_URI, Tokens,
    UserInfoReason, numeric_id,
};
use std::{io::Read, time::Duration};
use zeroize::Zeroizing;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Endpoint {
    Token,
    UserInfo,
    Revoke,
}
impl Endpoint {
    fn url(self) -> &'static str {
        match self {
            Self::Token => "https://api.planningcenteronline.com/oauth/token",
            Self::UserInfo => "https://api.planningcenteronline.com/oauth/userinfo",
            Self::Revoke => "https://api.planningcenteronline.com/oauth/revoke",
        }
    }
}
pub struct Response {
    pub status: u16,
    pub body: Zeroizing<Vec<u8>>,
}
/// Only fixed authorization endpoints exist here, never church-record mutation tools.
pub trait Http: Send + Sync {
    fn send(
        &self,
        endpoint: Endpoint,
        form: Option<&str>,
        bearer: Option<&str>,
    ) -> Result<Response, AuthError>;
}
pub struct NativeHttp(reqwest::blocking::Client);
impl NativeHttp {
    pub fn new() -> Result<Self, AuthError> {
        Ok(Self(
            reqwest::blocking::Client::builder()
                .https_only(true)
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(15))
                .connect_timeout(Duration::from_secs(5))
                .user_agent("Ozzie (https://ozzie.church)")
                .build()
                .map_err(|_| AuthError::ProviderFailure)?,
        ))
    }
}
impl Http for NativeHttp {
    fn send(
        &self,
        endpoint: Endpoint,
        form: Option<&str>,
        bearer: Option<&str>,
    ) -> Result<Response, AuthError> {
        let mut request = if endpoint == Endpoint::UserInfo {
            self.0.get(endpoint.url())
        } else {
            self.0.post(endpoint.url())
        };
        if let Some(form) = form {
            request = request
                .header("Content-Type", "application/x-www-form-urlencoded")
                .body(form.to_owned());
        }
        if let Some(bearer) = bearer {
            request = request.bearer_auth(bearer);
        }
        let response = request.send().map_err(|_| AuthError::ProviderFailure)?;
        let status = response.status().as_u16();
        let mut body = Zeroizing::new(Vec::new());
        response
            .take(65_537)
            .read_to_end(&mut body)
            .map_err(|_| AuthError::ProviderFailure)?;
        if body.len() > 65_536 {
            return Err(AuthError::ProviderFailure);
        }
        Ok(Response { status, body })
    }
}
pub struct PcoProvider<H: Http>(pub H);
impl<H: Http> PcoProvider<H> {
    fn token(&self, params: &[(&str, &str)]) -> Result<Grant, AuthError> {
        let form = Zeroizing::new(
            url::form_urlencoded::Serializer::new(String::new())
                .extend_pairs(params.iter().copied())
                .finish(),
        );
        let response = self.0.send(Endpoint::Token, Some(&form), None)?;
        if response.status != 200 {
            return Err(AuthError::ProviderFailure);
        }
        let tokens: Tokens =
            serde_json::from_slice(&response.body).map_err(|_| AuthError::InvalidToken)?;
        // Non-secret: the scope Planning Center says it granted (Doorkeeper always states it).
        #[derive(serde::Deserialize)]
        struct Stated {
            scope: Option<String>,
        }
        let stated: Stated =
            serde_json::from_slice(&response.body).map_err(|_| AuthError::InvalidToken)?;
        Ok(Grant {
            tokens,
            scope: stated.scope,
        })
    }
}
impl<H: Http> Provider for PcoProvider<H> {
    fn exchange(&self, client: &str, code: &str, verifier: &str) -> Result<Tokens, AuthError> {
        self.exchange_grant(client, code, verifier)
            .map(|grant| grant.tokens)
    }
    fn exchange_grant(&self, client: &str, code: &str, verifier: &str) -> Result<Grant, AuthError> {
        self.token(&[
            ("client_id", client),
            ("code", code),
            ("code_verifier", verifier),
            ("redirect_uri", REDIRECT_URI),
            ("grant_type", "authorization_code"),
        ])
    }
    fn organization(&self, access: &str) -> Result<String, AuthError> {
        self.organization_detailed(access)
            .map_err(|failure| failure.error)
    }
    fn organization_detailed(&self, access: &str) -> Result<String, OrganizationFailure> {
        let failure = |reason| OrganizationFailure {
            error: AuthError::OrganizationUnverified,
            diagnostic: OrganizationDiagnostic::userinfo(reason),
        };
        let response = self
            .0
            .send(Endpoint::UserInfo, None, Some(access))
            .map_err(|error| OrganizationFailure {
                error,
                diagnostic: OrganizationDiagnostic::userinfo(UserInfoReason::TransportFailure),
            })?;
        // Rate limiting says nothing about which organization the credential belongs to.
        if response.status == 429 {
            return Err(OrganizationFailure {
                error: AuthError::ProviderFailure,
                diagnostic: OrganizationDiagnostic::userinfo(UserInfoReason::ProviderFailure),
            });
        }
        if response.status != 200 {
            return Err(failure(if matches!(response.status, 401 | 403) {
                UserInfoReason::AccessDenied
            } else {
                UserInfoReason::ProviderFailure
            }));
        }
        // Preserve the original projection and accepted ID predicates; never trust profile/ID-token claims.
        #[derive(serde::Deserialize)]
        struct Identity {
            organization_id: Option<serde_json::Value>,
        }
        let identity: Identity = serde_json::from_slice(&response.body)
            .map_err(|_| failure(UserInfoReason::InvalidJson))?;
        let id = match identity.organization_id {
            Some(serde_json::Value::String(id)) => id,
            Some(serde_json::Value::Number(id)) => id
                .as_u64()
                .map(|n| n.to_string())
                .ok_or_else(|| failure(UserInfoReason::OrganizationIdInvalid))?,
            None | Some(serde_json::Value::Null) => {
                return Err(failure(UserInfoReason::OrganizationIdMissing));
            }
            _ => return Err(failure(UserInfoReason::OrganizationIdInvalid)),
        };
        if !numeric_id(&id) {
            return Err(failure(UserInfoReason::OrganizationIdInvalid));
        }
        Ok(id)
    }
    fn refresh(&self, client: &str, refresh: &str) -> Result<Tokens, AuthError> {
        self.refresh_grant(client, refresh)
            .map(|grant| grant.tokens)
    }
    fn refresh_grant(&self, client: &str, refresh: &str) -> Result<Grant, AuthError> {
        self.token(&[
            ("client_id", client),
            ("refresh_token", refresh),
            ("grant_type", "refresh_token"),
        ])
    }
    fn revoke(&self, client: &str, token: &str, hint: &str) -> Result<(), AuthError> {
        let form = Zeroizing::new(
            url::form_urlencoded::Serializer::new(String::new())
                .extend_pairs([
                    ("client_id", client),
                    ("token", token),
                    ("token_type_hint", hint),
                ])
                .finish(),
        );
        if self.0.send(Endpoint::Revoke, Some(&form), None)?.status != 200 {
            return Err(AuthError::ProviderFailure);
        }
        Ok(())
    }
}
