use crate::oauth::{
    AuthError, Grant, NamedOrganization, OrganizationDiagnostic, OrganizationFailure, Provider,
    REDIRECT_URI, Tokens, UserInfoReason, church_name, numeric_id,
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
    /// `refused`: what a reply refusing the request (400, 401 or 403) is. Anything else that isn't
    /// a 200 (out of reach, 429, 5xx) is a provider failure.
    fn token(&self, params: &[(&str, &str)], refused: AuthError) -> Result<Grant, AuthError> {
        let form = Zeroizing::new(
            url::form_urlencoded::Serializer::new(String::new())
                .extend_pairs(params.iter().copied())
                .finish(),
        );
        let response = self.0.send(Endpoint::Token, Some(&form), None)?;
        if response.status != 200 {
            return Err(if matches!(response.status, 400 | 401 | 403) {
                refused
            } else {
                AuthError::ProviderFailure
            });
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
        self.token(
            &[
                ("client_id", client),
                ("code", code),
                ("code_verifier", verifier),
                ("redirect_uri", REDIRECT_URI),
                ("grant_type", "authorization_code"),
            ],
            AuthError::ProviderFailure,
        )
    }
    fn organization(&self, access: &str) -> Result<String, AuthError> {
        self.organization_detailed(access)
            .map_err(|failure| failure.error)
    }
    fn organization_detailed(&self, access: &str) -> Result<String, OrganizationFailure> {
        self.organization_named(access).map(|named| named.id)
    }
    /// One userinfo read, as always. Besides `organization_id` it keeps only `organization_name`,
    /// the church's name (display text, `church_name`); the person's own name and email in the
    /// same response are never read.
    fn organization_named(&self, access: &str) -> Result<NamedOrganization, OrganizationFailure> {
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
        // Separately, so the projection above stays exactly as it was: the church's name, only
        // from an object, only as display text. Every other field (the person's own name and email
        // among them) is skipped by the deserializer without being read into a value (review S2, N4).
        #[derive(serde::Deserialize)]
        struct Church {
            #[serde(default)]
            organization_name: Option<String>,
        }
        let object = response
            .body
            .iter()
            .find(|b| !b.is_ascii_whitespace())
            .is_some_and(|b| *b == b'{');
        let name = object
            .then(|| serde_json::from_slice::<Church>(&response.body).ok())
            .flatten()
            .and_then(|church| church.organization_name)
            .and_then(|name| church_name(&name));
        Ok(NamedOrganization { id, name })
    }
    fn refresh(&self, client: &str, refresh: &str) -> Result<Tokens, AuthError> {
        self.refresh_grant(client, refresh)
            .map(|grant| grant.tokens)
    }
    /// A renewal Planning Center refuses (the refresh token was revoked or ran out: `invalid_grant`)
    /// is `InvalidToken`, as when there is nothing saved to renew: only a new sign-in helps. Out of
    /// reach is a provider failure, worth another try.
    fn refresh_grant(&self, client: &str, refresh: &str) -> Result<Grant, AuthError> {
        self.token(
            &[
                ("client_id", client),
                ("refresh_token", refresh),
                ("grant_type", "refresh_token"),
            ],
            AuthError::InvalidToken,
        )
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
        match self.0.send(Endpoint::Revoke, Some(&form), None)?.status {
            200 => Ok(()),
            // Reached, and refused (RFC 7009 answers 200 even for a token that is already
            // invalid, so this is the registration itself): trying again won't help.
            400 | 401 | 403 => Err(AuthError::RevokeRefused),
            _ => Err(AuthError::ProviderFailure),
        }
    }
}
