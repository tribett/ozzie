use crate::credentials::{CredentialStore, StoreError, read_private};
use crate::sunday::{RetireReason, RetiredTag, VerifiedCredentialReceipt};
use crate::sunday_read::{SundayPagePermit, SundayReadFailure};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicU64, Ordering},
};
use zeroize::Zeroizing;

pub const REDIRECT_URI: &str = "http://127.0.0.1:42819/oauth/callback";
pub const ATTEMPT_LIFETIME_MS: u64 = 300_000;
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AuthError {
    InvalidConfiguration,
    StateMismatch,
    InvalidCallback,
    Expired,
    Cancelled,
    OrganizationUnverified,
    ProviderFailure,
    InvalidToken,
    Busy,
    Store(StoreError),
    /// Planning Center's token response granted a scope this request did not ask for, or did
    /// not grant Services. Nothing is saved; the refused credential is revoked when possible.
    ScopeMismatch,
}

/// Deliberately has no Debug implementation; never sent over IPC or logged.
#[derive(serde::Serialize, serde::Deserialize, zeroize::Zeroize, zeroize::ZeroizeOnDrop)]
pub struct Tokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub token_type: String,
    pub expires_in: u64,
}
impl Tokens {
    fn validate(&self) -> Result<(), AuthError> {
        let valid = |s: &str| !s.is_empty() && s.len() <= 8192 && !s.chars().any(char::is_control);
        if !valid(&self.access_token)
            || !self.token_type.eq_ignore_ascii_case("bearer")
            || self.expires_in == 0
            || self.refresh_token.as_deref().is_some_and(|r| !valid(r))
        {
            return Err(AuthError::InvalidToken);
        }
        Ok(())
    }
}
/// A token response and the non-secret `scope` it says Planning Center granted. RFC 6749 §5.1
/// lets a response omit `scope` only when it is identical to the request (§6: on refresh, to the
/// original grant), so `None` means exactly what was asked for.
pub struct Grant {
    pub tokens: Tokens,
    pub scope: Option<String>,
}
impl Grant {
    fn unstated(tokens: Tokens) -> Self {
        Self {
            tokens,
            scope: None,
        }
    }
}
/// Content-free metadata only. Private fields keep version and stage/reason pairs closed.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct OrganizationDiagnostic {
    version: u8,
    #[serde(flatten)]
    detail: OrganizationDetail,
}
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "stage", content = "reason", rename_all = "kebab-case")]
enum OrganizationDetail {
    Userinfo(UserInfoReason),
    OrganizationBinding(BindingReason),
}
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
enum BindingReason {
    OrganizationMismatch,
}
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum UserInfoReason {
    TransportFailure,
    AccessDenied,
    ProviderFailure,
    InvalidJson,
    OrganizationIdMissing,
    OrganizationIdInvalid,
    Unclassified,
}
impl OrganizationDiagnostic {
    pub fn userinfo(reason: UserInfoReason) -> Self {
        Self {
            version: 1,
            detail: OrganizationDetail::Userinfo(reason),
        }
    }
    pub fn mismatch() -> Self {
        Self {
            version: 1,
            detail: OrganizationDetail::OrganizationBinding(BindingReason::OrganizationMismatch),
        }
    }
}
#[derive(Debug)]
pub struct OrganizationFailure {
    pub error: AuthError,
    pub diagnostic: OrganizationDiagnostic,
}
pub trait Provider: Send + Sync {
    fn exchange(&self, client: &str, code: &str, verifier: &str) -> Result<Tokens, AuthError>;
    fn organization(&self, access: &str) -> Result<String, AuthError>;
    /// Legacy providers preserve their exact outer error without inventing an origin.
    fn organization_detailed(&self, access: &str) -> Result<String, OrganizationFailure> {
        self.organization(access)
            .map_err(|error| OrganizationFailure {
                error,
                diagnostic: OrganizationDiagnostic::userinfo(UserInfoReason::Unclassified),
            })
    }
    fn refresh(&self, client: &str, refresh: &str) -> Result<Tokens, AuthError>;
    fn revoke(&self, client: &str, token: &str, hint: &str) -> Result<(), AuthError>;
    /// `exchange` plus the granted `scope`. Providers that cannot see it keep this default: no
    /// stated scope, which means exactly the scope asked for.
    fn exchange_grant(&self, client: &str, code: &str, verifier: &str) -> Result<Grant, AuthError> {
        self.exchange(client, code, verifier).map(Grant::unstated)
    }
    /// `refresh` plus the granted `scope`; the default states none (the original grant).
    fn refresh_grant(&self, client: &str, refresh: &str) -> Result<Grant, AuthError> {
        self.refresh(client, refresh).map(Grant::unstated)
    }
}
/// A Planning Center product set: what a sign-in asks consent for, and what a token response
/// granted. Each product scope permits both reading and writing in that product; Ozzie never
/// writes, and enforces GET-only source reads in its own HTTP layer (`source::NativeSourceHttp`),
/// not through the scope. Least privilege is the default: `Services`. `ServicesAndOperations` is
/// an explicit opt-in for the Sunday check's Calendar, People and Groups reads, and widening a
/// saved connection needs new consent.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Scopes {
    #[default]
    Services,
    ServicesAndOperations,
}
impl Scopes {
    /// The exact OAuth `scope` parameter for this set.
    pub fn oauth(self) -> &'static str {
        match self {
            Self::Services => "services openid",
            Self::ServicesAndOperations => "services calendar people groups openid",
        }
    }
    /// True when Calendar, People and Groups were all granted for the operations reads.
    pub fn operations(self) -> bool {
        self == Self::ServicesAndOperations
    }
    /// The set a token response granted when `asked` was requested. `scope` is the response's
    /// space-separated `scope`; `None` means exactly `asked` (RFC 6749 §5.1). A grant naming
    /// anything `asked` did not, or leaving out Services, is refused: Ozzie never holds a
    /// credential wider than the consent it asked for. Operations count only when Calendar,
    /// People and Groups were all granted; anything less is `Services`.
    pub fn granted(asked: Scopes, scope: Option<&str>) -> Result<Scopes, AuthError> {
        let Some(scope) = scope else {
            return Ok(asked);
        };
        let allowed: Vec<&str> = asked.oauth().split(' ').collect();
        let granted: Vec<&str> = scope.split_ascii_whitespace().collect();
        if granted.iter().any(|token| !allowed.contains(token)) || !granted.contains(&"services") {
            return Err(AuthError::ScopeMismatch);
        }
        let operations = ["calendar", "people", "groups"]
            .iter()
            .all(|product| granted.contains(product));
        Ok(if operations {
            Self::ServicesAndOperations
        } else {
            Self::Services
        })
    }
    /// The smaller of two sets: a refresh can keep or narrow a saved set, never widen it.
    pub fn narrower(self, other: Scopes) -> Scopes {
        if self.operations() && other.operations() {
            Self::ServicesAndOperations
        } else {
            Self::Services
        }
    }
    fn is_default(&self) -> bool {
        *self == Self::Services
    }
}
#[derive(Clone)]
pub struct Binding {
    pub workspace: String,
    pub organization: String,
    pub client_id: String,
}
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConnectionState {
    Disconnected,
    Waiting,
    Checking,
    Connected,
    StoredUnchecked,
    Cancelled,
    Expired,
    Failed,
}
#[derive(Debug, Clone, serde::Serialize)]
pub struct ConnectionStatus {
    pub state: ConnectionState,
    pub organization: String,
    pub checked_at_ms: Option<u64>,
    pub source: &'static str,
    pub problem: Option<AuthError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub organization_diagnostic: Option<OrganizationDiagnostic>,
    /// The set Planning Center granted the saved connection (never wider than was asked for),
    /// once this session has verified it (`connected`); absent otherwise.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scopes: Option<Scopes>,
    /// True on a connection handed over from a one-click sign-in (`find_organization`): Planning
    /// Center named this organization at sign-in, so the app can remember it. Omitted when false.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub found: bool,
}
#[derive(serde::Serialize, serde::Deserialize)]
struct StoredConnection {
    client_id: String,
    organization: String,
    tokens: Tokens,
    /// Non-secret: the set Planning Center granted, read from the token response. Omitted for
    /// the default, so default records keep their original bytes; an unknown value fails to
    /// decode and the record is refused.
    #[serde(default, skip_serializing_if = "Scopes::is_default")]
    scopes: Scopes,
}
struct Attempt {
    state: String,
    verifier: Zeroizing<String>,
    expires: u64,
    generation: u64,
    scopes: Scopes,
}
struct State {
    pending: Option<Attempt>,
    status: ConnectionStatus,
    // Operation-scoped fact: bytes were saved but never conditionally published.
    unchecked_save: Option<u64>,
    /// Positive knowledge that nothing is saved: seen absent at construction or deleted here,
    /// with nothing written since. A sign-in then has no displaced credential to look up.
    nothing_stored: bool,
}
pub(crate) enum SundayReceiverDecision {
    Retry,
    Finish,
}
enum SundayWriterFailure {
    Refused(crate::sunday::SundayRefusal),
    Authentication(AuthError),
}
impl SundayWriterFailure {
    fn known_retirement(&self) -> bool {
        matches!(
            self,
            Self::Authentication(AuthError::Cancelled)
                | Self::Refused(crate::sunday::SundayRefusal::Retired)
        )
    }
    fn authentication(self) -> AuthError {
        match self {
            Self::Refused(_) => AuthError::Cancelled,
            Self::Authentication(error) => error,
        }
    }
}
pub struct AuthController {
    binding: Binding,
    /// One-click sign-in only (`find_organization`): the workspace prefix the found organization
    /// is saved under. Such a controller signs in and saves once, then hands over through
    /// `adopt_found`; it never refreshes, reads or disconnects a saved connection itself.
    finding: Option<&'static str>,
    store: Arc<dyn CredentialStore>,
    provider: Arc<dyn Provider>,
    now: Arc<dyn Fn() -> u64 + Send + Sync>,
    state: Mutex<State>,
    generation: AtomicU64,
    busy: AtomicBool,
    cancelled: AtomicBool,
    sunday: Option<(
        Arc<crate::sunday::SundayAuthority>,
        crate::sunday::ControllerInstance,
    )>,
}
struct Operation<'a>(&'a AtomicBool);
impl Drop for Operation<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}
impl AuthController {
    pub fn new(
        binding: Binding,
        store: Arc<dyn CredentialStore>,
        provider: Arc<dyn Provider>,
        now: Arc<dyn Fn() -> u64 + Send + Sync>,
    ) -> Result<Self, AuthError> {
        if binding.workspace.is_empty()
            || binding.workspace.len() > 128
            || binding.client_id.is_empty()
            || binding.client_id.len() > 256
            || binding.client_id.chars().any(char::is_control)
            || !numeric_id(&binding.organization)
        {
            return Err(AuthError::InvalidConfiguration);
        }
        let present = read_private(store.as_ref(), &binding.workspace, &binding.organization)
            .map_err(AuthError::Store)?
            .is_some();
        let status = ConnectionStatus {
            state: if present {
                ConnectionState::StoredUnchecked
            } else {
                ConnectionState::Disconnected
            },
            organization: binding.organization.clone(),
            checked_at_ms: None,
            source: "Planning Center /oauth/userinfo",
            problem: None,
            organization_diagnostic: None,
            scopes: None,
            found: false,
        };
        Ok(Self {
            binding,
            finding: None,
            store,
            provider,
            now,
            state: Mutex::new(State {
                pending: None,
                status,
                unchecked_save: None,
                nothing_stored: !present,
            }),
            generation: AtomicU64::new(0),
            busy: AtomicBool::new(false),
            cancelled: AtomicBool::new(false),
            sunday: None,
        })
    }
    pub fn new_with_sunday_authority(
        binding: Binding,
        store: Arc<dyn CredentialStore>,
        provider: Arc<dyn Provider>,
        now: Arc<dyn Fn() -> u64 + Send + Sync>,
        authority: Arc<crate::sunday::SundayAuthority>,
    ) -> Result<Self, AuthError> {
        let controller = authority.attach().map_err(|_| AuthError::Busy)?;
        match Self::new(binding, store, provider, now) {
            Ok(mut auth) => {
                auth.sunday = Some((authority, controller));
                Ok(auth)
            }
            Err(error) => {
                authority.withdraw(&controller);
                Err(error)
            }
        }
    }
    /// One-click sign-in with Ozzie's own Public registration: no organization is known yet.
    /// After Planning Center's consent, the organization its userinfo names (a plain numeric
    /// id, or nothing is saved) becomes the binding: the credential is saved under
    /// `workspace_prefix` + that id, replacing and revoking any saved connection there. The app
    /// then calls `adopt_found` for an ordinary bound controller and drops this one.
    pub fn find_organization(
        client_id: String,
        workspace_prefix: &'static str,
        store: Arc<dyn CredentialStore>,
        provider: Arc<dyn Provider>,
        now: Arc<dyn Fn() -> u64 + Send + Sync>,
    ) -> Result<Self, AuthError> {
        if client_id.is_empty()
            || client_id.len() > 256
            || client_id.chars().any(char::is_control)
            || workspace_prefix.is_empty()
            || workspace_prefix.len() > 64
        {
            return Err(AuthError::InvalidConfiguration);
        }
        Ok(Self {
            binding: Binding {
                workspace: String::new(),
                organization: String::new(),
                client_id,
            },
            finding: Some(workspace_prefix),
            store,
            provider,
            now,
            state: Mutex::new(State {
                pending: None,
                status: ConnectionStatus {
                    state: ConnectionState::Disconnected,
                    organization: String::new(),
                    checked_at_ms: None,
                    source: "Planning Center /oauth/userinfo",
                    problem: None,
                    organization_diagnostic: None,
                    scopes: None,
                    found: false,
                },
                unchecked_save: None,
                nothing_stored: true,
            }),
            generation: AtomicU64::new(0),
            busy: AtomicBool::new(false),
            cancelled: AtomicBool::new(false),
            sunday: None,
        })
    }
    /// Hands a finished one-click sign-in over to an ordinary controller bound to the
    /// organization Planning Center named, connected as of this sign-in's check. Refused unless
    /// this is a finder whose sign-in saved a connection, and unless the record saved there
    /// still names this registration, organization and granted scopes. Single use: the finder
    /// is retired. Every later read still re-verifies the organization with Planning Center.
    pub fn adopt_found(&self) -> Result<AuthController, AuthError> {
        let prefix = self.finding.ok_or(AuthError::InvalidConfiguration)?;
        let _operation = self.operation()?;
        let status = self.lock()?.status.clone();
        let scopes = status.scopes.ok_or(AuthError::InvalidToken)?;
        if status.state != ConnectionState::Connected || !numeric_id(&status.organization) {
            return Err(AuthError::InvalidToken);
        }
        let bound = Self::new(
            Binding {
                workspace: format!("{prefix}{}", status.organization),
                organization: status.organization.clone(),
                client_id: self.binding.client_id.clone(),
            },
            self.store.clone(),
            self.provider.clone(),
            self.now.clone(),
        )?;
        let stored = bound.stored()?;
        if stored.scopes != scopes {
            return Err(AuthError::InvalidToken);
        }
        drop(stored);
        {
            let mut state = bound.lock()?;
            state.status.state = ConnectionState::Connected;
            state.status.checked_at_ms = status.checked_at_ms;
            state.status.scopes = Some(scopes);
            state.status.found = true;
        }
        drop(_operation);
        self.cancel();
        Ok(bound)
    }
    fn prepare_mutation(&self, reason: RetireReason) -> Result<Option<RetiredTag>, AuthError> {
        let Some((authority, controller)) = &self.sunday else {
            return Ok(None);
        };
        let classify = |refusal| match refusal {
            crate::sunday::SundayRefusal::Busy | crate::sunday::SundayRefusal::Contended => {
                AuthError::Busy
            }
            _ => AuthError::Cancelled,
        };
        let tag = authority
            .retire_controller(controller, reason)
            .map_err(classify)?;
        authority.check_writer(controller, &tag).map_err(classify)?;
        Ok(Some(tag))
    }
    fn check_writer(
        &self,
        generation: u64,
        expires: Option<u64>,
        tag: Option<&RetiredTag>,
    ) -> Result<(), AuthError> {
        self.check_writer_failure(generation, expires, tag)
            .map_err(SundayWriterFailure::authentication)
    }
    fn check_writer_failure(
        &self,
        generation: u64,
        expires: Option<u64>,
        tag: Option<&RetiredTag>,
    ) -> Result<(), SundayWriterFailure> {
        let authentication = self
            .check(generation, expires)
            .map_err(SundayWriterFailure::Authentication);
        let native = if let Some(tag) = tag {
            let (a, c) = self
                .sunday
                .as_ref()
                .ok_or(SundayWriterFailure::Authentication(AuthError::Busy))?;
            a.check_writer(c, tag).map_err(SundayWriterFailure::Refused)
        } else {
            Ok(())
        };
        // Proven retirement is cleanup evidence even if its deadline also expired.
        // Poison, contention and foreign scope never become retirement evidence.
        if matches!(
            &native,
            Err(SundayWriterFailure::Refused(
                crate::sunday::SundayRefusal::Retired
            ))
        ) {
            return native;
        }
        authentication?;
        native
    }
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, State>, AuthError> {
        self.state.lock().map_err(|_| AuthError::ProviderFailure)
    }
    fn operation(&self) -> Result<Operation<'_>, AuthError> {
        self.busy
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| AuthError::Busy)?;
        Ok(Operation(&self.busy))
    }
    fn check(&self, generation: u64, expires: Option<u64>) -> Result<(), AuthError> {
        if self.cancelled.load(Ordering::SeqCst)
            || generation != self.generation.load(Ordering::SeqCst)
        {
            return Err(AuthError::Cancelled);
        }
        if expires.is_some_and(|e| (self.now)() >= e) {
            return Err(AuthError::Expired);
        }
        Ok(())
    }
    pub fn status(&self) -> Result<ConnectionStatus, AuthError> {
        let mut state = self.lock()?;
        if state
            .pending
            .as_ref()
            .is_some_and(|a| (self.now)() >= a.expires)
        {
            state.pending = None;
            state.status.state = ConnectionState::Expired;
            state.status.organization_diagnostic = None;
            state.status.scopes = None;
        }
        Ok(state.status.clone())
    }
    /// Starts the default, least-privilege sign-in (`Scopes::Services`).
    pub fn begin(&self) -> Result<String, AuthError> {
        self.begin_with(Scopes::default())
    }
    /// Starts a sign-in asking consent for exactly `scopes`. The set Planning Center grants
    /// (never wider: a wider grant is refused) is what is saved with the connection.
    pub fn begin_with(&self, scopes: Scopes) -> Result<String, AuthError> {
        use base64::Engine;
        use sha2::Digest;
        let writer = self.prepare_mutation(RetireReason::AuthorityChanged)?;
        let _operation = self.operation()?;
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.cancelled.store(false, Ordering::SeqCst);
        self.lock()?.status.organization_diagnostic = None;
        let mut random = [0u8; 32];
        getrandom::fill(&mut random).map_err(|_| AuthError::ProviderFailure)?;
        let verifier =
            Zeroizing::new(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(random));
        getrandom::fill(&mut random).map_err(|_| AuthError::ProviderFailure)?;
        let state = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(random);
        let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(sha2::Sha256::digest(verifier.as_bytes()));
        let mut url = url::Url::parse("https://api.planningcenteronline.com/oauth/authorize")
            .map_err(|_| AuthError::InvalidConfiguration)?;
        url.query_pairs_mut().extend_pairs([
            ("client_id", self.binding.client_id.as_str()),
            ("redirect_uri", REDIRECT_URI),
            ("response_type", "code"),
            // Product scopes permit read and write in Planning Center; Ozzie only reads (GET).
            ("scope", scopes.oauth()),
            ("state", &state),
            ("code_challenge", &challenge),
            ("code_challenge_method", "S256"),
        ]);
        let mut inner = self.lock()?;
        self.check(generation, None)?;
        self.check_writer(generation, None, writer.as_ref())?;
        inner.unchecked_save = None;
        inner.pending = Some(Attempt {
            state,
            verifier,
            expires: (self.now)() + ATTEMPT_LIFETIME_MS,
            generation,
            scopes,
        });
        inner.status.state = ConnectionState::Waiting;
        inner.status.checked_at_ms = None;
        inner.status.problem = None;
        inner.status.organization_diagnostic = None;
        inner.status.scopes = None;
        Ok(url.into())
    }
    pub fn cancel(&self) {
        if let Some((authority, controller)) = &self.sunday {
            let _ = authority.retire_controller(controller, RetireReason::ExplicitCancel);
        }
        // Increment before taking the mutex so a blocked native store cannot win a cancellation race.
        self.cancelled.store(true, Ordering::SeqCst);
        self.generation.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut state) = self.state.lock() {
            state.pending = None;
            state.status.state = ConnectionState::Cancelled;
            state.status.checked_at_ms = None;
            state.status.problem = None;
            state.status.organization_diagnostic = None;
            state.status.scopes = None;
        }
    }
    fn record(
        &self,
        generation: u64,
        result: Result<ConnectionStatus, AuthError>,
        diagnostic: Option<OrganizationDiagnostic>,
        expires: Option<u64>,
    ) -> Result<ConnectionStatus, AuthError> {
        if let Err(error) = &result {
            let mut state = self.lock()?;
            if generation == self.generation.load(Ordering::SeqCst) {
                state.status.state =
                    if self.sunday.is_some() && state.unchecked_save == Some(generation) {
                        ConnectionState::StoredUnchecked
                    } else {
                        match error {
                            AuthError::Expired => ConnectionState::Expired,
                            AuthError::Cancelled => ConnectionState::Cancelled,
                            _ => ConnectionState::Failed,
                        }
                    };
                state.status.checked_at_ms = None;
                state.status.scopes = None;
                state.status.problem = Some(error.clone());
                state.status.organization_diagnostic = if self.check(generation, expires).is_err()
                    || matches!(error, AuthError::Cancelled | AuthError::Expired)
                {
                    None
                } else {
                    diagnostic
                };
            }
        }
        result
    }
    fn save(
        &self,
        tokens: Tokens,
        scopes: Scopes,
        generation: u64,
        expires: Option<u64>,
        diagnostic: &mut Option<OrganizationDiagnostic>,
        writer: Option<&RetiredTag>,
    ) -> Result<ConnectionStatus, AuthError> {
        tokens.validate()?;
        self.check_writer(generation, expires, writer)?;
        let organization = self.provider.organization_detailed(&tokens.access_token);
        if writer.is_some() {
            self.check_writer(generation, expires, writer)?;
        }
        // Preserve original outer errors; only a still-live operation may retain details.
        // A one-click finder (never on the Sunday writer path) takes the organization named.
        let (workspace, bound_organization) = match (organization, self.finding) {
            (Err(failure), _) => {
                if self.check_writer(generation, expires, writer).is_ok() {
                    *diagnostic = Some(failure.diagnostic);
                }
                return Err(failure.error);
            }
            (Ok(id), Some(prefix)) if writer.is_none() => {
                if !numeric_id(&id) {
                    if self.check_writer(generation, expires, writer).is_ok() {
                        *diagnostic = Some(OrganizationDiagnostic::userinfo(
                            UserInfoReason::OrganizationIdInvalid,
                        ));
                    }
                    return Err(AuthError::OrganizationUnverified);
                }
                (format!("{prefix}{id}"), id)
            }
            (Ok(_), Some(_)) => return Err(AuthError::InvalidConfiguration),
            (Ok(id), None) if id != self.binding.organization => {
                if self.check_writer(generation, expires, writer).is_ok() {
                    *diagnostic = Some(OrganizationDiagnostic::mismatch());
                }
                return Err(AuthError::OrganizationUnverified);
            }
            (Ok(_), None) => (
                self.binding.workspace.clone(),
                self.binding.organization.clone(),
            ),
        };
        self.check_writer(generation, expires, writer)?;
        // A finder learns only now which saved connection a sign-in replaces.
        // An unreadable slot fails closed rather than orphaning a credential it can't see.
        let previous = match self.finding {
            Some(_) => read_private(self.store.as_ref(), &workspace, &bound_organization)
                .map_err(AuthError::Store)?,
            None => None,
        };
        let replaced = previous
            .as_ref()
            .and_then(|bytes| serde_json::from_slice::<StoredConnection>(bytes).ok())
            .filter(|old| {
                old.tokens.access_token != tokens.access_token
                    && (old.tokens.refresh_token.is_none()
                        || old.tokens.refresh_token != tokens.refresh_token)
            });
        let record = StoredConnection {
            client_id: self.binding.client_id.clone(),
            organization: bound_organization.clone(),
            tokens,
            scopes,
        };
        let bytes =
            Zeroizing::new(serde_json::to_vec(&record).map_err(|_| AuthError::InvalidToken)?);
        let mut state = self.lock()?;
        self.check_writer(generation, expires, writer)?;
        let put = self.store.put(&workspace, &bound_organization, &bytes);
        if writer.is_some() && put.is_err() {
            // An uncertain failed put never supplies cleanup or receipt evidence.
            self.check_writer(generation, expires, writer)?;
        }
        put.map_err(AuthError::Store)?;
        state.nothing_stored = false;
        if writer.is_some() {
            state.unchecked_save = Some(generation);
            state.status.state = ConnectionState::StoredUnchecked;
            state.status.checked_at_ms = None;
            state.status.problem = None;
            state.status.organization_diagnostic = None;
        }
        if let Err(failure) = self.check_writer_failure(generation, expires, writer) {
            if writer.is_some() {
                self.compensate_sunday_save(
                    &bytes, generation, expires, writer, &failure, &mut state,
                );
            } else if let (Some(_), Some(old)) = (self.finding, previous.as_ref()) {
                // A one-click sign-in cancelled after its write puts back the connection it
                // replaced, and revokes its own new credential, which nothing will hold.
                self.store
                    .put(&workspace, &bound_organization, old)
                    .map_err(AuthError::Store)?;
                // Unless Planning Center handed back the very credential just put back.
                let undecodable = serde_json::from_slice::<StoredConnection>(old).is_err();
                if replaced.is_some() || undecodable {
                    self.discard(&record.tokens);
                }
            } else {
                self.store
                    .delete(&workspace, &bound_organization)
                    .map_err(AuthError::Store)?;
                state.nothing_stored = true;
                if self.finding.is_some() {
                    self.discard(&record.tokens);
                }
            }
            return Err(failure.authentication());
        }
        if let Some(tag) = writer {
            let (a, c) = self.sunday.as_ref().ok_or(AuthError::Busy)?;
            let receipt = VerifiedCredentialReceipt::new(
                c,
                (
                    &self.binding.workspace,
                    &self.binding.organization,
                    &self.binding.client_id,
                ),
                &bytes,
            );
            let checked = (self.now)();
            if let Err(failure) = self.check_writer_failure(generation, expires, writer) {
                self.compensate_sunday_save(
                    &bytes, generation, expires, writer, &failure, &mut state,
                );
                return Err(failure.authentication());
            }
            let (publication, displaced) = match a.publish(c, tag, receipt) {
                Ok(publication) => publication,
                Err(refusal) => {
                    let failure = SundayWriterFailure::Refused(refusal);
                    self.compensate_sunday_save(
                        &bytes, generation, expires, writer, &failure, &mut state,
                    );
                    return Err(failure.authentication());
                }
            };
            state.unchecked_save = None;
            state.status.state = ConnectionState::Connected;
            state.status.checked_at_ms = Some(checked);
            state.status.problem = None;
            state.status.organization_diagnostic = None;
            state.status.scopes = Some(scopes);
            let status = state.status.clone();
            drop(publication);
            drop(displaced);
            return Ok(status);
        }
        state.status.state = ConnectionState::Connected;
        state.status.checked_at_ms = Some((self.now)());
        state.status.problem = None;
        state.status.organization_diagnostic = None;
        state.status.scopes = Some(scopes);
        if self.finding.is_some() {
            state.status.organization = bound_organization;
        }
        let status = state.status.clone();
        drop(state);
        // Revoked as the registration it was issued to (a pasted ID may differ from Ozzie's).
        if let Some(old) = replaced {
            self.discard_as(&old.client_id, &old.tokens);
        }
        Ok(status)
    }
    // Called only while the existing OAuth operation exclusion and State are held.
    // The get/delete trait cannot exclude an external process after the comparison.
    fn compensate_sunday_save(
        &self,
        bytes: &[u8],
        generation: u64,
        expires: Option<u64>,
        writer: Option<&RetiredTag>,
        failure: &SundayWriterFailure,
        state: &mut State,
    ) {
        if !failure.known_retirement() {
            return;
        }
        let current = read_private(
            self.store.as_ref(),
            &self.binding.workspace,
            &self.binding.organization,
        );
        if !self
            .check_writer_failure(generation, expires, writer)
            .is_err_and(|failure| failure.known_retirement())
        {
            return;
        }
        if let Ok(Some(current)) = current
            && current.as_slice() == bytes
        {
            let deleted = self
                .store
                .delete(&self.binding.workspace, &self.binding.organization);
            let _post_delete = self.check_writer_failure(generation, expires, writer);
            state.nothing_stored |= deleted.is_ok();
            // A deadline cannot turn our confirmed delete back into a stored claim.
            if deleted.is_ok() && state.unchecked_save == Some(generation) {
                state.unchecked_save = None;
            }
        }
    }
    /// Best-effort revocation of a credential Ozzie will not keep (a refused grant, or one a new
    /// sign-in displaced), through the same revoke request as disconnect. Its failure changes no
    /// outcome: nothing here holds the credential afterwards. Not on the Sunday authority's
    /// path, whose provider and store I/O are fixed.
    fn discard(&self, tokens: &Tokens) {
        self.discard_as(&self.binding.client_id, tokens);
    }
    fn discard_as(&self, client: &str, tokens: &Tokens) {
        if self.sunday.is_some() {
            return;
        }
        let (token, hint) = match tokens.refresh_token.as_deref() {
            Some(refresh) => (refresh, "refresh_token"),
            None => (tokens.access_token.as_str(), "access_token"),
        };
        let _ = self.provider.revoke(client, token, hint);
    }
    /// The saved connection a sign-in for `new` is about to replace, unless it is that same
    /// credential (Planning Center may hand back an existing token). Unreadable records are
    /// left alone: the save that follows reports any store failure itself.
    fn displaced(&self, new: &Tokens) -> Option<StoredConnection> {
        if self.lock().ok()?.nothing_stored {
            return None;
        }
        let old = self.stored().ok()?;
        let same = old.tokens.access_token == new.access_token
            || (old.tokens.refresh_token.is_some()
                && old.tokens.refresh_token == new.refresh_token);
        (!same).then_some(old)
    }
    /// Identity only (workspace, organization, client id); never credentials.
    pub(crate) fn binding(&self) -> &Binding {
        &self.binding
    }
    fn stored(&self) -> Result<StoredConnection, AuthError> {
        // A finder has no saved connection of its own; it hands over through `adopt_found`.
        if self.finding.is_some() {
            return Err(AuthError::InvalidToken);
        }
        let bytes = read_private(
            self.store.as_ref(),
            &self.binding.workspace,
            &self.binding.organization,
        )
        .map_err(AuthError::Store)?
        .ok_or(AuthError::InvalidToken)?;
        self.decode_stored(&bytes)
    }
    fn decode_stored(&self, bytes: &[u8]) -> Result<StoredConnection, AuthError> {
        let stored: StoredConnection =
            serde_json::from_slice(bytes).map_err(|_| AuthError::InvalidToken)?;
        if stored.client_id != self.binding.client_id
            || stored.organization != self.binding.organization
        {
            return Err(AuthError::OrganizationUnverified);
        }
        stored.tokens.validate()?;
        Ok(stored)
    }
    /// Closed native read only. Tokens never leave this controller through a public callback.
    pub fn read_source(
        &self,
        request: &crate::source::SourceRequest,
        cancelled: &AtomicBool,
    ) -> Result<crate::source::SourcePage, crate::source::SourceError> {
        if self.sunday.is_some() {
            return Err(crate::source::SourceError::Busy);
        }
        self.read_source_using(request, cancelled, &crate::source::NativeSourceHttp::new()?)
    }
    pub(crate) fn read_source_using(
        &self,
        request: &crate::source::SourceRequest,
        cancelled: &AtomicBool,
        http: &dyn crate::source::SourceHttp,
    ) -> Result<crate::source::SourcePage, crate::source::SourceError> {
        use crate::source::SourceError;
        if self.sunday.is_some() {
            return Err(SourceError::Busy);
        }
        request.validate()?;
        let generation = self.generation.load(Ordering::SeqCst);
        self.source_bound(request, generation, cancelled)?;
        self.source_session(generation, cancelled, |access, _, check| {
            let organization = self.provider.organization(access);
            check()?;
            if organization.map_err(source_error)? != self.binding.organization {
                return Err(SourceError::OrganizationUnverified);
            }
            check()?;
            http.read(request, access)
        })
    }
    /// Resolves the stored credential to this controller's organization once, for the
    /// current generation only. The returned proof holds no credential.
    pub(crate) fn verify_source(
        &self,
        cancelled: &AtomicBool,
    ) -> Result<VerifiedSource, crate::source::SourceError> {
        use crate::source::SourceError;
        if self.sunday.is_some() {
            return Err(SourceError::Busy);
        }
        let generation = self.generation.load(Ordering::SeqCst);
        self.source_session(generation, cancelled, |access, scopes, check| {
            let organization = self.provider.organization(access);
            check()?;
            if organization.map_err(source_error)? != self.binding.organization {
                return Err(SourceError::OrganizationUnverified);
            }
            Ok(VerifiedSource { generation, scopes })
        })
    }
    /// One page under an earlier identity proof. Any cancel, new connection attempt or
    /// disconnect since that proof refuses the read; binding and credential checks still run.
    pub(crate) fn read_verified_using(
        &self,
        verified: &VerifiedSource,
        request: &crate::source::SourceRequest,
        cancelled: &AtomicBool,
        http: &dyn crate::source::SourceHttp,
    ) -> Result<crate::source::SourcePage, crate::source::SourceError> {
        if self.sunday.is_some() {
            return Err(crate::source::SourceError::Busy);
        }
        request.validate()?;
        // Defense in depth: products this connection was never granted are never requested.
        if request.collection.product() != crate::source::Product::Services
            && !verified.scopes.operations()
        {
            return Err(crate::source::SourceError::InvalidRequest);
        }
        self.source_bound(request, verified.generation, cancelled)?;
        self.source_session(verified.generation, cancelled, |access, _, _| {
            http.read(request, access)
        })
    }
    /// True once the proof's generation has ended (cancel, disconnect or a new attempt).
    pub(crate) fn source_ended(&self, verified: &VerifiedSource) -> bool {
        self.check(verified.generation, None).is_err()
    }
    fn source_bound(
        &self,
        request: &crate::source::SourceRequest,
        generation: u64,
        cancelled: &AtomicBool,
    ) -> Result<(), crate::source::SourceError> {
        if cancelled.load(Ordering::SeqCst) {
            return Err(crate::source::SourceError::Cancelled);
        }
        self.check(generation, None).map_err(source_error)?;
        if request.workspace != self.binding.workspace
            || request.organization != self.binding.organization
            || request.client_id != self.binding.client_id
        {
            return Err(crate::source::SourceError::BindingMismatch);
        }
        Ok(())
    }
    /// Holds the operation and the stored credential around `step`; every boundary re-checks
    /// cancellation and generation so a late result never outlives a cancel.
    fn source_session<T>(
        &self,
        generation: u64,
        cancelled: &AtomicBool,
        step: impl FnOnce(
            &str,
            Scopes,
            &dyn Fn() -> Result<(), crate::source::SourceError>,
        ) -> Result<T, crate::source::SourceError>,
    ) -> Result<T, crate::source::SourceError> {
        use crate::source::SourceError;
        let check = || {
            if cancelled.load(Ordering::SeqCst) {
                return Err(SourceError::Cancelled);
            }
            self.check(generation, None).map_err(source_error)
        };
        check()?;
        let _operation = self.operation().map_err(source_error)?;
        check()?;
        let present = read_private(
            self.store.as_ref(),
            &self.binding.workspace,
            &self.binding.organization,
        );
        check()?;
        if present
            .map_err(|e| source_error(AuthError::Store(e)))?
            .is_none()
        {
            return Err(SourceError::MissingCredentials);
        }
        let stored = self.stored();
        check()?;
        let stored = stored.map_err(source_error)?;
        let result = step(&stored.tokens.access_token, stored.scopes, &check);
        check()?;
        let result = result?;
        check()?;
        Ok(result)
    }
    fn sunday_check(
        &self,
        permit: &SundayPagePermit,
        request: &crate::source::SourceRequest,
    ) -> Result<Arc<VerifiedCredentialReceipt>, SundayReadFailure> {
        request.validate()?;
        let (a, c) = self
            .sunday
            .as_ref()
            .ok_or(crate::sunday::SundayRefusal::NotReady)?;
        if request.workspace != self.binding.workspace
            || request.organization != self.binding.organization
            || request.client_id != self.binding.client_id
        {
            return Err(crate::sunday::SundayRefusal::BindingMismatch.into());
        }
        Ok(a.check_page(permit, c, request)?)
    }
    pub fn read_sunday_page(
        &self,
        permit: SundayPagePermit,
        request: &crate::source::SourceRequest,
    ) -> Result<crate::source::SourcePage, SundayReadFailure> {
        self.sunday_check(&permit, request)?;
        let operation = self
            .operation()
            .map_err(|_| crate::sunday::SundayRefusal::Busy)?;
        self.sunday_check(&permit, request)?;
        let client = crate::source::NativeSourceHttp::new();
        let checked = self.sunday_check(&permit, request);
        let result = match checked {
            Err(error) => Err(error),
            Ok(_) => match &client {
                Ok(http) => self.guarded_sunday_body(&permit, request, http, &operation),
                Err(error) => Err((*error).into()),
            },
        };
        // Actual destruction precedes the final check and any result publication.
        let before_drop = self.sunday_check(&permit, request).map(|_| ());
        drop(client);
        self.sunday_check(&permit, request)?;
        before_drop?;
        result
    }
    #[cfg(test)]
    pub(crate) fn read_sunday_page_using(
        &self,
        permit: SundayPagePermit,
        request: &crate::source::SourceRequest,
        http: &dyn crate::source::SourceHttp,
    ) -> Result<crate::source::SourcePage, SundayReadFailure> {
        self.sunday_check(&permit, request)?;
        let operation = self
            .operation()
            .map_err(|_| crate::sunday::SundayRefusal::Busy)?;
        self.guarded_sunday_body(&permit, request, http, &operation)
    }
    fn guarded_sunday_body(
        &self,
        permit: &SundayPagePermit,
        request: &crate::source::SourceRequest,
        http: &dyn crate::source::SourceHttp,
        _operation: &Operation<'_>,
    ) -> Result<crate::source::SourcePage, SundayReadFailure> {
        use crate::source::SourceError;
        let map = |error| match error {
            AuthError::Store(StoreError::Locked) => SourceError::Locked,
            AuthError::Store(StoreError::Denied) => SourceError::Denied,
            AuthError::Store(StoreError::Unavailable) => SourceError::StoreUnavailable,
            AuthError::OrganizationUnverified => SourceError::OrganizationUnverified,
            AuthError::InvalidToken | AuthError::Expired => SourceError::InvalidCredentials,
            AuthError::Cancelled => SourceError::Cancelled,
            AuthError::Busy => SourceError::Busy,
            _ => SourceError::ProviderFailure,
        };
        let receipt = self.sunday_check(permit, request)?;
        self.sunday_check(permit, request)?;
        let first = read_private(
            self.store.as_ref(),
            &self.binding.workspace,
            &self.binding.organization,
        );
        self.sunday_check(permit, request)?;
        let first = first
            .map_err(|e| map(AuthError::Store(e)))?
            .ok_or(SourceError::MissingCredentials)?;
        if !receipt.matches_bytes(&first) {
            return Err(crate::sunday::SundayRefusal::ReceiptMismatch.into());
        }
        drop(first);
        self.sunday_check(permit, request)?;
        let second = read_private(
            self.store.as_ref(),
            &self.binding.workspace,
            &self.binding.organization,
        );
        self.sunday_check(permit, request)?;
        let second = second
            .map_err(|e| map(AuthError::Store(e)))?
            .ok_or(SourceError::MissingCredentials)?;
        if !receipt.matches_bytes(&second) {
            return Err(crate::sunday::SundayRefusal::ReceiptMismatch.into());
        }
        let stored = self.decode_stored(&second).map_err(map)?;
        drop(second);
        self.sunday_check(permit, request)?;
        let organization = self.provider.organization(&stored.tokens.access_token);
        self.sunday_check(permit, request)?;
        if organization.map_err(map)? != self.binding.organization {
            return Err(SourceError::OrganizationUnverified.into());
        }
        self.sunday_check(permit, request)?;
        let page = http.read(request, &stored.tokens.access_token);
        self.sunday_check(permit, request)?;
        drop(stored);
        self.sunday_check(permit, request)?;
        Ok(page?)
    }
    pub fn refresh(&self) -> Result<ConnectionStatus, AuthError> {
        let writer = self.prepare_mutation(RetireReason::AuthorityChanged)?;
        if self.cancelled.load(Ordering::SeqCst) {
            return Err(AuthError::Cancelled);
        }
        let _operation = self.operation()?;
        let generation = self.generation.load(Ordering::SeqCst);
        let mut diagnostic = None;
        let result = (|| {
            let mut state = self.lock()?;
            self.check_writer(generation, None, writer.as_ref())?;
            state.unchecked_save = None;
            state.status.state = ConnectionState::Checking;
            state.status.organization_diagnostic = None;
            state.status.scopes = None;
            drop(state);
            let stored = self.stored();
            if writer.is_some() {
                self.check_writer(generation, None, writer.as_ref())?;
            }
            let stored = stored?;
            self.check_writer(generation, None, writer.as_ref())?;
            let previous = stored
                .tokens
                .refresh_token
                .as_deref()
                .ok_or(AuthError::InvalidToken)?;
            let grant = self
                .provider
                .refresh_grant(&self.binding.client_id, previous);
            if writer.is_some() {
                self.check_writer(generation, None, writer.as_ref())?;
            }
            let Grant { mut tokens, scope } = grant?;
            // A refresh keeps the saved granted set or narrows it to what this response grants;
            // it never widens it (only a new sign-in can). A grant naming anything Ozzie never
            // asks for, or without Services, is refused like a sign-in's.
            let scopes = match Scopes::granted(Scopes::ServicesAndOperations, scope.as_deref()) {
                Ok(fresh) => stored.scopes.narrower(fresh),
                Err(error) => {
                    self.discard(&tokens);
                    return Err(error);
                }
            };
            if tokens.refresh_token.is_none() {
                tokens.refresh_token = Some(previous.into());
            }
            if writer.is_some() {
                self.check_writer(generation, None, writer.as_ref())?;
            }
            self.save(
                tokens,
                scopes,
                generation,
                None,
                &mut diagnostic,
                writer.as_ref(),
            )
        })();
        self.record(generation, result, diagnostic, None)
    }
    /// Cancels, waits up to DISCONNECT_WAIT for an in-flight read, then revokes and deletes.
    /// `Busy` means nothing was revoked or deleted yet.
    pub fn disconnect(&self) -> Result<ConnectionStatus, AuthError> {
        self.disconnect_within(DISCONNECT_WAIT)
    }
    pub(crate) fn disconnect_within(
        &self,
        wait: std::time::Duration,
    ) -> Result<ConnectionStatus, AuthError> {
        if let Some((authority, controller)) = &self.sunday {
            authority
                .retire_controller(controller, RetireReason::AuthorityChanged)
                .map_err(|_| AuthError::Busy)?;
            return Err(AuthError::Busy);
        }
        if let Some(prefix) = self.finding {
            // A finder whose sign-in saved a connection (and wasn't handed over) disconnects that
            // connection through an ordinary bound controller: revoke, then delete.
            let saved = self.lock()?.status.organization.clone();
            self.cancel();
            if numeric_id(&saved) {
                let bound = Self::new(
                    Binding {
                        workspace: format!("{prefix}{saved}"),
                        organization: saved,
                        client_id: self.binding.client_id.clone(),
                    },
                    self.store.clone(),
                    self.provider.clone(),
                    self.now.clone(),
                )?;
                return bound.disconnect_within(wait);
            }
            let mut state = self.lock()?;
            state.status.state = ConnectionState::Disconnected;
            return Ok(state.status.clone());
        }
        self.cancel();
        let started = std::time::Instant::now();
        let _operation = loop {
            match self.operation() {
                Ok(operation) => break operation,
                Err(_) if started.elapsed() < wait => {
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
                Err(error) => return Err(error),
            }
        };
        let generation = self.generation.load(Ordering::SeqCst);
        let result = (|| {
            if read_private(
                self.store.as_ref(),
                &self.binding.workspace,
                &self.binding.organization,
            )
            .map_err(AuthError::Store)?
            .is_some()
            {
                let stored = self.stored()?;
                let (token, hint) = match stored.tokens.refresh_token.as_deref() {
                    Some(r) => (r, "refresh_token"),
                    None => (stored.tokens.access_token.as_str(), "access_token"),
                };
                self.provider.revoke(&self.binding.client_id, token, hint)?;
            }
            self.store
                .delete(&self.binding.workspace, &self.binding.organization)
                .map_err(AuthError::Store)?;
            let mut state = self.lock()?;
            state.nothing_stored = true;
            state.status.state = ConnectionState::Disconnected;
            state.status.checked_at_ms = None;
            state.status.problem = None;
            state.status.organization_diagnostic = None;
            Ok(state.status.clone())
        })();
        self.record(generation, result, None, None)
    }
    fn sunday_callback(&self, callback: &str) -> Result<ConnectionStatus, AuthError> {
        let url = url::Url::parse(callback).map_err(|_| AuthError::InvalidCallback)?;
        if callback.split('?').next() != Some(REDIRECT_URI)
            || url.fragment().is_some()
            || callback.len() > 8192
        {
            return Err(AuthError::InvalidCallback);
        }
        let mut query = std::collections::HashMap::new();
        for (k, v) in url.query_pairs().into_owned() {
            if query.insert(k, v).is_some() {
                return Err(AuthError::InvalidCallback);
            }
        }
        // Validate without consuming; invalid callbacks cannot retire unrelated work.
        let generation = {
            let state = self.state.try_lock().map_err(|_| AuthError::Busy)?;
            let pending = state.pending.as_ref().ok_or(AuthError::StateMismatch)?;
            if query.get("state").map(String::as_str) != Some(pending.state.as_str()) {
                return Err(AuthError::StateMismatch);
            }
            self.check(pending.generation, None)?;
            if !query.contains_key("error")
                && query
                    .get("code")
                    .is_none_or(|c| c.is_empty() || c.len() > 4096)
            {
                return Err(AuthError::InvalidCallback);
            }
            pending.generation
        };
        let writer = match self.prepare_mutation(RetireReason::AuthorityChanged) {
            Ok(writer) => writer,
            Err(AuthError::Cancelled) => {
                let mut state = self.state.try_lock().map_err(|_| AuthError::Busy)?;
                if generation == self.generation.load(Ordering::SeqCst)
                    && state.pending.as_ref().is_some_and(|pending| {
                        pending.generation == generation
                            && query.get("state").map(String::as_str)
                                == Some(pending.state.as_str())
                    })
                {
                    state.pending = None;
                    state.status.state = ConnectionState::Cancelled;
                    state.status.checked_at_ms = None;
                    state.status.problem = Some(AuthError::Cancelled);
                    state.status.organization_diagnostic = None;
                }
                return Err(AuthError::Cancelled);
            }
            Err(error) => return Err(error),
        };
        let _operation = self.operation()?;
        let attempt = {
            let mut state = self.state.try_lock().map_err(|_| AuthError::Busy)?;
            let pending = state.pending.as_ref().ok_or(AuthError::StateMismatch)?;
            if pending.generation != generation
                || query.get("state").map(String::as_str) != Some(pending.state.as_str())
            {
                return Err(AuthError::StateMismatch);
            }
            self.check_writer(generation, None, writer.as_ref())?;
            if (self.now)() >= pending.expires {
                state.pending = None;
                state.status.state = ConnectionState::Expired;
                state.status.checked_at_ms = None;
                state.status.problem = Some(AuthError::Expired);
                state.status.organization_diagnostic = None;
                return Err(AuthError::Expired);
            }
            let pending = state.pending.take().ok_or(AuthError::StateMismatch)?;
            state.unchecked_save = None;
            state.status.state = ConnectionState::Checking;
            state.status.organization_diagnostic = None;
            state.status.scopes = None;
            pending
        };
        let mut diagnostic = None;
        let result = (|| {
            self.check_writer(generation, Some(attempt.expires), writer.as_ref())?;
            if query.contains_key("error") {
                return Err(AuthError::Cancelled);
            }
            let code = query.get("code").ok_or(AuthError::InvalidCallback)?;
            let grant =
                self.provider
                    .exchange_grant(&self.binding.client_id, code, &attempt.verifier);
            self.check_writer(generation, Some(attempt.expires), writer.as_ref())?;
            let Grant { tokens, scope } = grant?;
            // What Planning Center granted, never what was asked for; wider is refused.
            let scopes = Scopes::granted(attempt.scopes, scope.as_deref())?;
            self.save(
                tokens,
                scopes,
                generation,
                Some(attempt.expires),
                &mut diagnostic,
                writer.as_ref(),
            )
        })();
        self.record(generation, result, diagnostic, Some(attempt.expires))
    }
    pub(crate) fn callback_waiting(&self) -> Result<bool, AuthError> {
        if self.sunday.is_none() {
            return self
                .status()
                .map(|status| status.state == ConnectionState::Waiting);
        }
        let identity = match self.state.try_lock() {
            // Contention is not evidence that the owned receiver may be torn down.
            Err(std::sync::TryLockError::WouldBlock) => return Ok(true),
            Err(std::sync::TryLockError::Poisoned(_)) => return Err(AuthError::ProviderFailure),
            Ok(state) => state.pending.as_ref().map(|p| (p.generation, p.expires)),
        };
        let Some((generation, expires)) = identity else {
            return Ok(false);
        };
        // The trusted clock may reenter; hold neither State nor publication while calling it.
        let now = (self.now)();
        let mut state = match self.state.try_lock() {
            Err(std::sync::TryLockError::WouldBlock) => return Ok(true),
            Err(std::sync::TryLockError::Poisoned(_)) => return Err(AuthError::ProviderFailure),
            Ok(state) => state,
        };
        let Some(pending) = state.pending.as_ref() else {
            return Ok(false);
        };
        if (pending.generation, pending.expires) != (generation, expires) {
            return Ok(true);
        }
        if self.cancelled.load(Ordering::SeqCst)
            || self.generation.load(Ordering::SeqCst) != generation
        {
            return Ok(false);
        }
        if now >= expires {
            state.pending = None;
            state.status.state = ConnectionState::Expired;
            state.status.checked_at_ms = None;
            state.status.problem = Some(AuthError::Expired);
            state.status.organization_diagnostic = None;
            return Ok(false);
        }
        Ok(true)
    }
    pub(crate) fn sunday_receiver_decision(
        &self,
        result: &Result<ConnectionStatus, AuthError>,
    ) -> SundayReceiverDecision {
        match result {
            Err(AuthError::StateMismatch | AuthError::InvalidCallback) => {
                SundayReceiverDecision::Retry
            }
            Err(AuthError::Busy) if self.sunday.is_some() => SundayReceiverDecision::Retry,
            _ => SundayReceiverDecision::Finish,
        }
    }
    pub fn callback(&self, callback: &str) -> Result<ConnectionStatus, AuthError> {
        if self.sunday.is_some() {
            return self.sunday_callback(callback);
        }
        let _operation = self.operation()?;
        let url = url::Url::parse(callback).map_err(|_| AuthError::InvalidCallback)?;
        if callback.split('?').next() != Some(REDIRECT_URI)
            || url.fragment().is_some()
            || callback.len() > 8192
        {
            return Err(AuthError::InvalidCallback);
        }
        let mut query = std::collections::HashMap::new();
        for (key, value) in url.query_pairs().into_owned() {
            if query.insert(key, value).is_some() {
                return Err(AuthError::InvalidCallback);
            }
        }
        let mut state = self.lock()?;
        if state.pending.as_ref().map(|a| a.state.as_str())
            != query.get("state").map(String::as_str)
            || state.pending.is_none()
        {
            return Err(AuthError::StateMismatch);
        }
        let attempt = state.pending.take().ok_or(AuthError::StateMismatch)?;
        state.status.state = ConnectionState::Checking;
        state.status.organization_diagnostic = None;
        state.status.scopes = None;
        drop(state);
        let mut diagnostic = None;
        let result = (|| {
            self.check(attempt.generation, Some(attempt.expires))?;
            if query.contains_key("error") {
                return Err(AuthError::Cancelled);
            }
            let code = query
                .get("code")
                .filter(|code| !code.is_empty() && code.len() <= 4096)
                .ok_or(AuthError::InvalidCallback)?;
            let Grant { tokens, scope } =
                self.provider
                    .exchange_grant(&self.binding.client_id, code, &attempt.verifier)?;
            // What Planning Center granted, never what was asked for. A wider grant is refused
            // and its credential revoked; nothing is saved.
            let scopes = match Scopes::granted(attempt.scopes, scope.as_deref()) {
                Ok(scopes) => scopes,
                Err(error) => {
                    self.discard(&tokens);
                    return Err(error);
                }
            };
            // A new sign-in replaces the saved credential; once the new one is saved and
            // verified, the old one (possibly wider) is revoked rather than left valid.
            let displaced = self.displaced(&tokens);
            let status = self.save(
                tokens,
                scopes,
                attempt.generation,
                Some(attempt.expires),
                &mut diagnostic,
                None,
            )?;
            if let Some(old) = displaced {
                self.discard(&old.tokens);
            }
            Ok(status)
        })();
        self.record(
            attempt.generation,
            result,
            diagnostic,
            Some(attempt.expires),
        )
    }
}
/// Token-free proof that one generation's stored credential resolved to the bound organization.
pub(crate) struct VerifiedSource {
    generation: u64,
    /// The saved connection's granted set at verification time.
    scopes: Scopes,
}
impl VerifiedSource {
    pub(crate) fn scopes(&self) -> Scopes {
        self.scopes
    }
}
fn source_error(error: AuthError) -> crate::source::SourceError {
    use crate::source::SourceError;
    match error {
        AuthError::Store(StoreError::Locked) => SourceError::Locked,
        AuthError::Store(StoreError::Denied) => SourceError::Denied,
        AuthError::Store(StoreError::Unavailable) => SourceError::StoreUnavailable,
        AuthError::OrganizationUnverified => SourceError::OrganizationUnverified,
        AuthError::InvalidToken | AuthError::Expired => SourceError::InvalidCredentials,
        AuthError::Cancelled => SourceError::Cancelled,
        AuthError::Busy => SourceError::Busy,
        _ => SourceError::ProviderFailure,
    }
}
/// How long disconnect waits for an in-flight read to finish before revoking.
pub const DISCONNECT_WAIT: std::time::Duration = std::time::Duration::from_secs(6);
pub fn numeric_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 32
        && !id.starts_with('0')
        && id.bytes().all(|c| c.is_ascii_digit())
}

/// Epoch timestamps anchored to monotonic elapsed time: wall-clock adjustment
/// cannot extend a pending authorization attempt.
pub fn system_clock() -> Result<Arc<dyn Fn() -> u64 + Send + Sync>, AuthError> {
    let epoch = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| AuthError::InvalidConfiguration)?
        .as_millis() as u64;
    let started = std::time::Instant::now();
    Ok(Arc::new(move || {
        epoch.saturating_add(started.elapsed().as_millis() as u64)
    }))
}

#[cfg(test)]
#[path = "sunday_read_tests.rs"]
mod sunday_read_tests;

#[cfg(test)]
#[path = "sunday_gate_tests.rs"]
mod sunday_gate_tests;
