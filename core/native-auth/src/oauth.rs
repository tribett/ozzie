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
/// How long before a saved sign-in's access token runs out (Planning Center's last two hours) a read
/// renews it first (`AuthController::renew_if_due`): longer than a whole Sunday check and its waits.
pub const RENEW_BEFORE_MS: u64 = 10 * 60_000;
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
    /// Planning Center answered a revoke with a refusal (400, 401 or 403), as for a registration
    /// it no longer has: trying again won't help, unlike an unreachable Planning Center.
    RevokeRefused,
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
/// The organization a credential belongs to, and the church's name when userinfo states one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NamedOrganization {
    pub id: String,
    pub name: Option<String>,
}
/// A church's name as Planning Center's userinfo states it (`organization_name`), kept only to
/// show the person which church a connection is for: never a person's name, never sent to a
/// model. Display text only, by the one rule the page applies too (core/test/church-name-parity.json,
/// run by both sides' tests): control, space and line or paragraph separator characters become one
/// space; format characters (bidirectional, zero-width, soft hyphen, tags), private-use and
/// surrogate characters are dropped; spaces collapse and trim; at most 120 code points. Nothing left
/// is no name, and the organization number is shown instead (review S2, M1).
pub fn church_name(raw: &str) -> Option<String> {
    use icu_properties::{CodePointMapData, props::GeneralCategory as G};
    let categories = CodePointMapData::<G>::new();
    let mut cleaned = String::with_capacity(raw.len());
    for c in raw.chars() {
        match categories.get(c) {
            G::Control | G::SpaceSeparator | G::LineSeparator | G::ParagraphSeparator => {
                if !cleaned.is_empty() && !cleaned.ends_with(' ') {
                    cleaned.push(' ');
                }
            }
            G::Format | G::PrivateUse | G::Surrogate => {}
            _ => cleaned.push(c),
        }
    }
    let name: String = cleaned.trim_end_matches(' ').chars().take(120).collect();
    let name = name.trim_end_matches(' ');
    (!name.is_empty()).then(|| name.to_string())
}
pub trait Provider: Send + Sync {
    fn exchange(&self, client: &str, code: &str, verifier: &str) -> Result<Tokens, AuthError>;
    fn organization(&self, access: &str) -> Result<String, AuthError>;
    /// `organization_detailed` plus the church's name from the same userinfo response. Providers
    /// that can't see a name keep this default: no name.
    fn organization_named(&self, access: &str) -> Result<NamedOrganization, OrganizationFailure> {
        self.organization_detailed(access)
            .map(|id| NamedOrganization { id, name: None })
    }
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
/// not through the scope. Least privilege is the default: `Services`. Every other product is an
/// explicit opt-in, and widening a saved connection needs new consent:
/// - operations: Calendar, People and Groups together (rooms, follow-ups, group events, the
///   background-check read and the People forms the church chooses);
/// - Check-Ins (`check_ins`): how many checked in per room, as counts only;
/// - Registrations (`registrations`): upcoming signups and how many registered, as counts only.
///
/// Closed: the only spellings are the eight canonical ones `label` writes. The two original
/// sets keep their original names and bytes (`Services`, `ServicesAndOperations`), so saved
/// connections and older status readers are unchanged.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Scopes {
    operations: bool,
    check_ins: bool,
    registrations: bool,
}
// The two original sets keep their original (variant) names, so every caller and every saved
// record from before Check-Ins and Registrations reads exactly as it did.
#[allow(non_upper_case_globals)]
impl Scopes {
    /// Services alone: the default, least-privilege set.
    pub const Services: Scopes = Scopes {
        operations: false,
        check_ins: false,
        registrations: false,
    };
    /// Services with Calendar, People and Groups.
    pub const ServicesAndOperations: Scopes = Scopes {
        operations: true,
        check_ins: false,
        registrations: false,
    };
    /// The widest set Ozzie ever asks for. A refresh checks its grant against this, then keeps
    /// or narrows the saved set; it never widens it.
    pub const Widest: Scopes = Scopes {
        operations: true,
        check_ins: true,
        registrations: true,
    };
    /// What a sign-in asks for, from the person's three choices: operations (Calendar, People and
    /// Groups), Check-Ins and Registrations. Services is always included; nothing else can be.
    pub fn asked(operations: bool, check_ins: bool, registrations: bool) -> Scopes {
        Scopes {
            operations,
            check_ins,
            registrations,
        }
    }
    /// This set, with Check-Ins asked for (or not).
    pub fn with_check_ins(self, on: bool) -> Scopes {
        Scopes {
            check_ins: on,
            ..self
        }
    }
    /// This set, with Registrations asked for (or not).
    pub fn with_registrations(self, on: bool) -> Scopes {
        Scopes {
            registrations: on,
            ..self
        }
    }
    /// The exact OAuth `scope` parameter for this set: Planning Center's own scope names.
    pub fn oauth(self) -> String {
        let mut scope = String::from("services");
        if self.operations {
            scope.push_str(" calendar people groups");
        }
        if self.check_ins {
            scope.push_str(" check_ins");
        }
        if self.registrations {
            scope.push_str(" registrations");
        }
        scope.push_str(" openid");
        scope
    }
    /// True when Calendar, People and Groups were all granted for the operations reads.
    pub fn operations(self) -> bool {
        self.operations
    }
    /// True when Check-Ins was granted.
    pub fn check_ins(self) -> bool {
        self.check_ins
    }
    /// True when Registrations was granted.
    pub fn registrations(self) -> bool {
        self.registrations
    }
    /// The set a token response granted when `asked` was requested. `scope` is the response's
    /// space-separated `scope`; `None` means exactly `asked` (RFC 6749 §5.1). A grant naming
    /// anything `asked` did not, or leaving out Services, is refused: Ozzie never holds a
    /// credential wider than the consent it asked for. Operations count only when Calendar,
    /// People and Groups were all granted; Check-Ins and Registrations each count on their own.
    pub fn granted(asked: Scopes, scope: Option<&str>) -> Result<Scopes, AuthError> {
        let Some(scope) = scope else {
            return Ok(asked);
        };
        let allowed = asked.oauth();
        let allowed: Vec<&str> = allowed.split(' ').collect();
        let granted: Vec<&str> = scope.split_ascii_whitespace().collect();
        if granted.iter().any(|token| !allowed.contains(token)) || !granted.contains(&"services") {
            return Err(AuthError::ScopeMismatch);
        }
        Ok(Scopes {
            operations: ["calendar", "people", "groups"]
                .iter()
                .all(|product| granted.contains(product)),
            check_ins: granted.contains(&"check_ins"),
            registrations: granted.contains(&"registrations"),
        })
    }
    /// The smaller of two sets: a refresh can keep or narrow a saved set, never widen it.
    pub fn narrower(self, other: Scopes) -> Scopes {
        Scopes {
            operations: self.operations && other.operations,
            check_ins: self.check_ins && other.check_ins,
            registrations: self.registrations && other.registrations,
        }
    }
    fn is_default(&self) -> bool {
        *self == Self::Services
    }
    /// The one spelling of this set, in saved records and in the status the webview reads:
    /// `services` or `services-and-operations`, then `+check-ins`, then `+registrations`.
    pub fn label(self) -> String {
        let mut label = String::from(if self.operations {
            "services-and-operations"
        } else {
            "services"
        });
        if self.check_ins {
            label.push_str("+check-ins");
        }
        if self.registrations {
            label.push_str("+registrations");
        }
        label
    }
    /// Only a canonical `label`; any other spelling (unknown, reordered, repeated) is `None`.
    pub fn from_label(text: &str) -> Option<Scopes> {
        let mut parts = text.split('+');
        let operations = match parts.next()? {
            "services" => false,
            "services-and-operations" => true,
            _ => return None,
        };
        let mut scopes = Scopes {
            operations,
            ..Scopes::Services
        };
        for part in parts {
            match part {
                "check-ins" => scopes.check_ins = true,
                "registrations" => scopes.registrations = true,
                _ => return None,
            }
        }
        (scopes.label() == text).then_some(scopes)
    }
}
impl serde::Serialize for Scopes {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.label())
    }
}
impl<'de> serde::Deserialize<'de> for Scopes {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        Scopes::from_label(&text).ok_or_else(|| serde::de::Error::custom("unknown scope set"))
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
    /// On a connection handed over from a one-click sign-in: when that sign-in was checked. A
    /// renewal changes `checked_at_ms`, never this, so the page applies the organization Planning
    /// Center named once per sign-in (review M, L7). Omitted otherwise.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub found_at_ms: Option<u64>,
    /// The church's name as Planning Center's userinfo stated it at this connection's last
    /// sign-in or check (`church_name`), when it did. Shown to the person only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub organization_name: Option<String>,
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
    /// Non-secret: the church's name from the userinfo read the save already made. Omitted when
    /// unknown, so records without one keep their original bytes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    organization_name: Option<String>,
}
/// The church name a saved record carries, checked again as display text.
fn stored_name(bytes: &[u8]) -> Option<String> {
    #[derive(serde::Deserialize)]
    struct Named {
        organization_name: Option<String>,
    }
    serde_json::from_slice::<Named>(bytes)
        .ok()?
        .organization_name
        .as_deref()
        .and_then(church_name)
}
/// Just enough of a saved record to sign out of it: the registration it was issued to and its
/// tokens. Reads records of any registration or scope set, unlike `decode_stored`.
#[derive(serde::Deserialize)]
struct Revocable {
    client_id: String,
    tokens: Tokens,
}
impl Revocable {
    fn read(bytes: &[u8]) -> Option<Self> {
        let record: Self = serde_json::from_slice(bytes).ok()?;
        (!record.client_id.is_empty() && record.tokens.validate().is_ok()).then_some(record)
    }
}
/// What Disconnect can still tell about a saved sign-in this version can't otherwise read (a later
/// version's spelling, damaged tokens): its registration, the church it names when it says, and a
/// token Planning Center can revoke. Never kept, shown or logged.
#[derive(serde::Deserialize)]
struct Leftover {
    client_id: String,
    #[serde(default)]
    organization: Option<String>,
    tokens: LeftoverTokens,
}
#[derive(serde::Deserialize, zeroize::Zeroize, zeroize::ZeroizeOnDrop)]
struct LeftoverTokens {
    #[serde(default)]
    access_token: Option<String>,
    #[serde(default)]
    refresh_token: Option<String>,
}
impl Leftover {
    fn read(bytes: &[u8]) -> Option<Self> {
        let record: Self = serde_json::from_slice(bytes).ok()?;
        (!record.client_id.is_empty()).then_some(record)
    }
    /// The token to revoke: the refresh token when one is readable, else the access token.
    fn revocable(&self) -> Option<(&str, &'static str)> {
        let usable =
            |s: &&String| !s.is_empty() && s.len() <= 8192 && !s.chars().any(char::is_control);
        if let Some(refresh) = self.tokens.refresh_token.as_ref().filter(usable) {
            return Some((refresh, "refresh_token"));
        }
        self.tokens
            .access_token
            .as_ref()
            .filter(usable)
            .map(|access| (access.as_str(), "access_token"))
    }
}
/// A one-way fingerprint (SHA-256) of a saved record's bytes: which credential a sign-in left
/// behind was, so a retry or removal acts on that record and never on a newer sign-in saved in the
/// same slot since. Kept in memory only; never shown, logged or sent.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct RecordFingerprint([u8; 32]);
impl RecordFingerprint {
    fn of(bytes: &[u8]) -> Self {
        use sha2::Digest;
        Self(sha2::Sha256::digest(bytes).into())
    }
}
impl std::fmt::Debug for RecordFingerprint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("RecordFingerprint")
    }
}
/// What signing out of a saved sign-in found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Retired {
    /// Signed out and removed, or nothing was saved there.
    Done,
    /// The slot holds another record than the one expected (a newer sign-in): left untouched.
    Changed,
}
/// A sign-in still saved: why, which record it is, and the registration it was saved with (a
/// public client ID), when those could be read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotRetired {
    pub error: AuthError,
    pub record: Option<RecordFingerprint>,
    pub client: Option<String>,
}
/// Removes a saved sign-in from this Mac without a revoke, only if the slot still holds `expected`:
/// for a sign-in Planning Center refused to sign out of, on the person's request.
pub fn remove_saved_record(
    store: &dyn CredentialStore,
    prefix: &str,
    organization: &str,
    expected: RecordFingerprint,
) -> Result<Retired, AuthError> {
    if prefix.is_empty() || !numeric_id(organization) {
        return Err(AuthError::InvalidConfiguration);
    }
    let workspace = format!("{prefix}{organization}");
    let Some(bytes) = read_private(store, &workspace, organization).map_err(AuthError::Store)?
    else {
        return Ok(Retired::Done);
    };
    if RecordFingerprint::of(&bytes) != expected {
        return Ok(Retired::Changed);
    }
    store
        .delete(&workspace, organization)
        .map(|()| Retired::Done)
        .map_err(AuthError::Store)
}
/// Which record is saved for `organization` now, if any: its fingerprint, the bytes read only to
/// make it and then dropped. What a leftover from before this launch is tied to (review S3, L1).
pub fn saved_record_fingerprint(
    store: &dyn CredentialStore,
    prefix: &str,
    organization: &str,
) -> Result<Option<RecordFingerprint>, AuthError> {
    if prefix.is_empty() || !numeric_id(organization) {
        return Err(AuthError::InvalidConfiguration);
    }
    let workspace = format!("{prefix}{organization}");
    Ok(read_private(store, &workspace, organization)
        .map_err(AuthError::Store)?
        .map(|bytes| RecordFingerprint::of(&bytes)))
}
/// Planning Center may hand back an existing token: the same access token, or the same refresh token.
fn same_credential(a: &Tokens, b: &Tokens) -> bool {
    a.access_token == b.access_token
        || (a.refresh_token.is_some() && a.refresh_token == b.refresh_token)
}
/// What a revoke request sends for `tokens`: the refresh token when there is one.
fn revocation(tokens: &Tokens) -> (&str, &str) {
    match tokens.refresh_token.as_deref() {
        Some(refresh) => (refresh, "refresh_token"),
        None => (tokens.access_token.as_str(), "access_token"),
    }
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
    /// When the saved access token runs out, by this controller's clock: its `expires_in` from when
    /// this controller saved it (a sign-in or a renewal), or 0 once Planning Center refused it at an
    /// identity check. Unknown for a saved sign-in this controller hasn't checked. Not a secret.
    runs_out: Option<u64>,
    /// Credentials this controller has written to the Keychain (a sign-in's or a refresh's), so a
    /// refresh can tell whether its own was written (`refresh_as`).
    writes: u64,
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
    /// One renewal at a time (`renew_if_due`): a read that finds one under way waits for it.
    renewing: Mutex<()>,
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
        let saved = read_private(store.as_ref(), &binding.workspace, &binding.organization)
            .map_err(AuthError::Store)?;
        let present = saved.is_some();
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
            found_at_ms: None,
            organization_name: saved.as_deref().and_then(|bytes| stored_name(bytes)),
        };
        drop(saved);
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
                runs_out: None,
                writes: 0,
            }),
            generation: AtomicU64::new(0),
            busy: AtomicBool::new(false),
            cancelled: AtomicBool::new(false),
            sunday: None,
            renewing: Mutex::new(()),
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
                    found_at_ms: None,
                    organization_name: None,
                },
                unchecked_save: None,
                nothing_stored: true,
                runs_out: None,
                writes: 0,
            }),
            generation: AtomicU64::new(0),
            busy: AtomicBool::new(false),
            cancelled: AtomicBool::new(false),
            sunday: None,
            renewing: Mutex::new(()),
        })
    }
    /// Hands a finished one-click sign-in over to an ordinary controller bound to the
    /// organization Planning Center named, connected as of this sign-in's check. Refused unless
    /// this is a finder whose sign-in saved a connection, and unless the record saved there
    /// still names this registration, organization and granted scopes. Single use: the finder
    /// is retired. Every later read still re-verifies the organization with Planning Center.
    pub fn adopt_found(&self) -> Result<AuthController, AuthError> {
        let prefix = self.finding.ok_or(AuthError::InvalidConfiguration)?;
        // A finder interrupted after its save (Cancel, Quit, another sign-in) is never handed over,
        // even before its status says so.
        if self.cancelled.load(Ordering::SeqCst) {
            return Err(AuthError::Cancelled);
        }
        let _operation = self.operation()?;
        let (status, runs_out) = {
            let state = self.lock()?;
            (state.status.clone(), state.runs_out)
        };
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
            state.status.found_at_ms = status.checked_at_ms;
            state.runs_out = runs_out;
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
        Ok(self.status_of(&mut state))
    }
    fn status_of(&self, state: &mut State) -> ConnectionStatus {
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
        state.status.clone()
    }
    /// `status` without waiting: while an operation holds this controller's state (its Keychain
    /// write mid-sign-in or mid-check), it answers `checking` at once, which is what it is doing,
    /// so status polling and reads never queue behind the Keychain (review S, L1).
    pub fn status_or_busy(&self) -> Result<ConnectionStatus, AuthError> {
        match self.state.try_lock() {
            Ok(mut state) => Ok(self.status_of(&mut state)),
            Err(std::sync::TryLockError::WouldBlock) => Ok(ConnectionStatus {
                state: ConnectionState::Checking,
                organization: self.binding.organization.clone(),
                checked_at_ms: None,
                source: "Planning Center /oauth/userinfo",
                problem: None,
                organization_diagnostic: None,
                scopes: None,
                found: false,
                found_at_ms: None,
                organization_name: None,
            }),
            Err(std::sync::TryLockError::Poisoned(_)) => Err(AuthError::ProviderFailure),
        }
    }
    /// The atomic half of `cancel`: from now on every operation of this controller fails its next
    /// check and a finder is never handed over. Takes no lock, so a caller holding its own lock can
    /// stop a controller without waiting for that controller's Keychain write; `cancel` afterwards
    /// updates the status.
    pub fn interrupt(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        self.generation.fetch_add(1, Ordering::SeqCst);
    }
    /// Whether this controller was cancelled or interrupted.
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
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
            ("scope", scopes.oauth().as_str()),
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
    /// `rotating`: a refresh, after which Planning Center no longer accepts the credential it was
    /// refreshed from; otherwise a sign-in. `renewal`: a refresh renewing a connection this
    /// controller already confirmed (`renew_if_due`).
    #[allow(clippy::too_many_arguments)]
    fn save(
        &self,
        tokens: Tokens,
        scopes: Scopes,
        generation: u64,
        expires: Option<u64>,
        diagnostic: &mut Option<OrganizationDiagnostic>,
        writer: Option<&RetiredTag>,
        rotating: bool,
        renewal: bool,
    ) -> Result<ConnectionStatus, AuthError> {
        tokens.validate()?;
        // Planning Center issued these tokens before now, so their life counted from here ends no
        // earlier than theirs does by more than this save takes; `RENEW_BEFORE_MS` covers that.
        let runs_out = (self.now)().saturating_add(tokens.expires_in.saturating_mul(1000));
        self.check_writer(generation, expires, writer)?;
        // The same userinfo read as always; its church name is kept for the person to see.
        let organization = self
            .provider
            .organization_named(&tokens.access_token)
            .map(|named| {
                let name = named.name.as_deref().and_then(church_name);
                (named.id, name)
            });
        if writer.is_some() {
            self.check_writer(generation, expires, writer)?;
        }
        let (organization, name) = match organization {
            Ok((id, name)) => (Ok(id), name),
            Err(failure) => (Err(failure), None),
        };
        // Preserve original outer errors; only a still-live operation may retain details.
        // A one-click finder (never on the Sunday writer path) takes the organization named.
        let (workspace, bound_organization) = match (organization, self.finding) {
            (Err(failure), _) if renewal && writer.is_none() && unanswered(&failure.diagnostic) => {
                return self.keep_renewed(tokens, scopes, generation, runs_out);
            }
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
        // The saved connection a sign-in replaces, to put back if the sign-in is cancelled after
        // its write and to revoke once it succeeded, as the registration it was issued to (which
        // may differ: Ozzie's own, or one typed under Advanced; review R, L2c). A finder learns
        // only now which slot that is, and an unreadable slot fails closed rather than orphaning a
        // credential it can't see. A bound sign-in reads its own slot best effort, as before.
        // A refresh replaces nothing it could put back: the old credential no longer works.
        let previous = if self.finding.is_some() {
            read_private(self.store.as_ref(), &workspace, &bound_organization)
                .map_err(AuthError::Store)?
        } else if rotating || writer.is_some() || self.lock()?.nothing_stored {
            None
        } else {
            read_private(self.store.as_ref(), &workspace, &bound_organization)
                .ok()
                .flatten()
        };
        let replaced = previous
            .as_deref()
            .and_then(|bytes| Revocable::read(bytes))
            .filter(|old| !same_credential(&old.tokens, &tokens));
        let record = StoredConnection {
            client_id: self.binding.client_id.clone(),
            organization: bound_organization.clone(),
            tokens,
            scopes,
            organization_name: name.clone(),
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
        state.writes += 1;
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
                return Err(failure.authentication());
            }
            if rotating {
                // A refresh cancelled after its write keeps what it wrote: Planning Center already
                // stopped accepting the credential it replaced, so this is the only one that works
                // (review S, L2). The cancel still ends the operation.
                return Err(failure.authentication());
            }
            // A sign-in cancelled after its write puts back the connection it replaced, or
            // removes its own when it replaced nothing, and revokes its own new credential, which
            // nothing will hold.
            let discard = match previous.as_ref() {
                Some(old) => {
                    self.store
                        .put(&workspace, &bound_organization, old)
                        .map_err(AuthError::Store)?;
                    // Unless Planning Center handed back the very credential just put back.
                    replaced.is_some() || Revocable::read(old).is_none()
                }
                None => {
                    self.store
                        .delete(&workspace, &bound_organization)
                        .map_err(AuthError::Store)?;
                    state.nothing_stored = true;
                    true
                }
            };
            // Revoked after this controller's state is released, so its status never waits on
            // Planning Center (review S, L1).
            drop(state);
            if discard {
                self.discard(&record.tokens);
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
            state.runs_out = Some(runs_out);
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
        state.status.organization_name = name;
        state.runs_out = Some(runs_out);
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
    /// A renewal Planning Center granted whose identity check then went unanswered (out of reach,
    /// a 5xx or a 429). Planning Center no longer accepts the refresh token it renewed from, so
    /// dropping these would leave nothing that works until a new sign-in. They are saved for the
    /// church this controller is bound to, exactly as a checked renewal saves them with the
    /// church's name it already had, and the connection stays as it was: its last check time is
    /// still the last time Planning Center confirmed the church. Nothing is read with them before a
    /// read's own identity check confirms that church (`identify`). Another church, or a reply
    /// refusing or garbling the identity, still saves nothing (`save`). A cancel before the write
    /// saves nothing; one after it keeps what it wrote, as `save` does for a refresh.
    fn keep_renewed(
        &self,
        tokens: Tokens,
        scopes: Scopes,
        generation: u64,
        runs_out: u64,
    ) -> Result<ConnectionStatus, AuthError> {
        self.check(generation, None)?;
        let mut state = self.lock()?;
        let record = StoredConnection {
            client_id: self.binding.client_id.clone(),
            organization: self.binding.organization.clone(),
            tokens,
            scopes,
            organization_name: state.status.organization_name.clone(),
        };
        let bytes =
            Zeroizing::new(serde_json::to_vec(&record).map_err(|_| AuthError::InvalidToken)?);
        self.check(generation, None)?;
        self.store
            .put(&self.binding.workspace, &self.binding.organization, &bytes)
            .map_err(AuthError::Store)?;
        state.nothing_stored = false;
        state.writes += 1;
        state.runs_out = Some(runs_out);
        self.check(generation, None)?;
        state.status.state = ConnectionState::Connected;
        state.status.scopes = Some(scopes);
        state.status.problem = None;
        state.status.organization_diagnostic = None;
        Ok(state.status.clone())
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
        let (token, hint) = revocation(tokens);
        self.revoke_quietly(client, token, hint);
    }
    fn revoke_quietly(&self, client: &str, token: &str, hint: &str) {
        if self.sunday.is_some() {
            return;
        }
        let _ = self.provider.revoke(client, token, hint);
    }
    /// Identity only (workspace, organization, client id); never credentials.
    pub(crate) fn binding(&self) -> &Binding {
        &self.binding
    }
    /// The registration (a public client ID, not a secret) and organization this controller is
    /// bound to; a one-click finder's organization is empty until it hands over.
    pub fn bound_to(&self) -> (&str, &str) {
        (&self.binding.client_id, &self.binding.organization)
    }
    /// Signs Ozzie out of another organization's saved connection, keeping this controller's own:
    /// only for a church switch the person answered (`connections`), with the organization chosen
    /// natively, never by the page. Planning Center revokes it first, as the registration it was
    /// issued to, and the item is deleted only once that succeeded (review R, L1). A revoke that
    /// fails, or a slot (this one or the kept one) that can't be read, leaves the item for a retry.
    /// Never revokes this controller's own credential: a slot holding that same credential is only
    /// deleted (N1). Bytes that aren't a usable connection are deleted: there is nothing to revoke.
    /// `expected`: act only if the slot still holds that record, so a retry never touches a newer
    /// sign-in saved there since (review S2, M2); a different record is `Retired::Changed`.
    pub fn retire_saved(
        &self,
        prefix: &str,
        organization: &str,
        expected: Option<RecordFingerprint>,
    ) -> Result<Retired, NotRetired> {
        let failed = |error, record, client| NotRetired {
            error,
            record,
            client,
        };
        if self.finding.is_some()
            || self.sunday.is_some()
            || prefix.is_empty()
            || !numeric_id(organization)
            || organization == self.binding.organization
        {
            return Err(failed(AuthError::InvalidConfiguration, None, None));
        }
        let workspace = format!("{prefix}{organization}");
        let Some(bytes) = read_private(self.store.as_ref(), &workspace, organization)
            .map_err(|e| failed(AuthError::Store(e), None, None))?
        else {
            return Ok(Retired::Done);
        };
        let record = RecordFingerprint::of(&bytes);
        if expected.is_some_and(|expected| expected != record) {
            return Ok(Retired::Changed);
        }
        let mut client = None;
        if let Some(old) = Revocable::read(&bytes) {
            client = Some(old.client_id.clone());
            let kept = read_private(
                self.store.as_ref(),
                &self.binding.workspace,
                &self.binding.organization,
            )
            .map_err(|e| failed(AuthError::Store(e), Some(record), client.clone()))?;
            let same = kept
                .as_deref()
                .map(Vec::as_slice)
                .and_then(Revocable::read)
                .is_some_and(|kept| same_credential(&kept.tokens, &old.tokens));
            if !same {
                let (token, hint) = revocation(&old.tokens);
                self.provider
                    .revoke(&old.client_id, token, hint)
                    .map_err(|e| failed(e, Some(record), client.clone()))?;
            }
        }
        self.store
            .delete(&workspace, organization)
            .map(|()| Retired::Done)
            .map_err(|e| failed(AuthError::Store(e), Some(record), client))
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
            let organization = self.identify(access);
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
            let organization = self.identify(access);
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
        if !request.collection.product().granted(verified.scopes) {
            return Err(crate::source::SourceError::InvalidRequest);
        }
        self.source_bound(request, verified.generation, cancelled)?;
        self.source_session(verified.generation, cancelled, |access, _, _| {
            http.read(request, access)
        })
    }
    /// A read's identity check: the organization the saved access token belongs to, from one
    /// userinfo read as before. When Planning Center refuses the token itself (401 or 403), it ran
    /// out sooner than this controller's clock says (the clock `system_clock` keeps doesn't count
    /// time this Mac spent asleep) or was withdrawn: the next read renews it first
    /// (`renewal_due`). The read itself fails as it always did.
    fn identify(&self, access: &str) -> Result<String, AuthError> {
        self.provider
            .organization_detailed(access)
            .map_err(|failure| {
                if failure.diagnostic
                    == OrganizationDiagnostic::userinfo(UserInfoReason::AccessDenied)
                    && let Ok(mut state) = self.state.lock()
                    && state.runs_out.is_some()
                {
                    state.runs_out = Some(0);
                }
                // Planning Center unanswered says nothing about the church: out of reach (review M, L5).
                if unanswered(&failure.diagnostic) {
                    AuthError::ProviderFailure
                } else {
                    failure.error
                }
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
        self.refresh_as(false, &mut Reached::default())
    }
    /// `refresh`; `renewal` when it renews a connection this controller already confirmed
    /// (`renew_if_due`), whose renewed tokens are kept if only the identity check goes unanswered
    /// (`keep_renewed`). `reached`: how far it got.
    fn refresh_as(
        &self,
        renewal: bool,
        reached: &mut Reached,
    ) -> Result<ConnectionStatus, AuthError> {
        let writer = self.prepare_mutation(RetireReason::AuthorityChanged)?;
        if self.cancelled.load(Ordering::SeqCst) {
            return Err(AuthError::Cancelled);
        }
        let _operation = self.operation()?;
        let generation = self.generation.load(Ordering::SeqCst);
        let mut diagnostic = None;
        // Planning Center's answer, in case it is never written: what to sign out of then.
        let mut fresh: Option<(Zeroizing<String>, &'static str)> = None;
        let mut writes = None;
        let result = (|| {
            let mut state = self.lock()?;
            writes = Some(state.writes);
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
            reached.asked = true;
            let grant = self
                .provider
                .refresh_grant(&self.binding.client_id, previous);
            reached.unreachable = matches!(grant, Err(AuthError::ProviderFailure));
            if writer.is_some() {
                self.check_writer(generation, None, writer.as_ref())?;
            }
            let Grant { mut tokens, scope } = grant?;
            // A refresh keeps the saved granted set or narrows it to what this response grants;
            // it never widens it (only a new sign-in can). A grant naming anything Ozzie never
            // asks for, or without Services, is refused like a sign-in's.
            let scopes = match Scopes::granted(Scopes::Widest, scope.as_deref()) {
                Ok(fresh) => stored.scopes.narrower(fresh),
                Err(error) => {
                    self.discard(&tokens);
                    return Err(error);
                }
            };
            // Its own refresh token, only when Planning Center gave a new one. Without one the saved
            // refresh token goes on working, and revoking even the new access token may revoke the
            // grant it came from (RFC 7009 §2.1), the saved sign-in with it: nothing is signed out
            // then, nor when Planning Center handed back the saved credential (review N, 2).
            if !same_credential(&stored.tokens, &tokens) {
                fresh = tokens
                    .refresh_token
                    .as_deref()
                    .map(|new| (Zeroizing::new(new.to_owned()), "refresh_token"));
            }
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
                true,
                renewal,
            )
        })();
        // Stopped after Planning Center answered and before its write (Quit, Cancel, Disconnect, a
        // church switch): the renewed credential is held nowhere, so it is signed out at Planning
        // Center, best effort (review M, L3), on a thread of its own: the request (up to 15 s) never
        // holds this refresh's operation, the renewal's turn or the read's locks, so a sign-in right
        // after Cancel isn't answered busy meanwhile (review N, 3). At Quit, Ozzie may exit first.
        if matches!(result, Err(AuthError::Cancelled))
            && writes.is_some_and(|before| self.lock().is_ok_and(|s| s.writes == before))
            && let Some((token, hint)) = fresh.take()
        {
            self.revoke_aside(token, hint);
        }
        self.record(generation, result, diagnostic, None)
    }
    /// `revoke_quietly` on a thread of its own, holding nothing of this controller's: the token
    /// moves there and is wiped when the request ends.
    fn revoke_aside(&self, token: Zeroizing<String>, hint: &'static str) {
        if self.sunday.is_some() {
            return;
        }
        let (provider, client) = (self.provider.clone(), self.binding.client_id.clone());
        let _ = std::thread::Builder::new()
            .name("ozzie-revoke".into())
            .spawn(move || {
                let _ = provider.revoke(&client, &token, hint);
            });
    }
    /// Whether a read should renew this connection's sign-in first: it is connected, and its access
    /// token runs out within `RENEW_BEFORE_MS` by this controller's clock, or Planning Center already
    /// refused it (`identify`). Never waits for a Keychain write in progress (`status_or_busy`).
    pub fn renewal_due(&self) -> bool {
        // The clock is read before State is held, as everywhere a clock may reenter.
        let now = (self.now)();
        match self.state.try_lock() {
            Ok(state) => self.due(&state, now),
            Err(_) => false,
        }
    }
    fn due(&self, state: &State, now: u64) -> bool {
        !self.is_cancelled()
            && state.status.state == ConnectionState::Connected
            && state
                .runs_out
                .is_some_and(|at| now.saturating_add(RENEW_BEFORE_MS) >= at)
    }
    /// Renews this connection's sign-in when it is due (`renewal_due`), once, through `refresh`, the
    /// renewal "Check saved connection" makes, with all of its guards: the church must still match,
    /// the Keychain record is replaced exactly as there, and a cancel, Disconnect or new sign-in on
    /// this controller meanwhile saves nothing. True when it renewed; false when nothing was due,
    /// including when another read renewed it while this one waited its turn.
    ///
    /// A failed renewal fails the read, as `renewal_error` reports it: `invalid-credentials` when
    /// only a new sign-in helps (the connection is then `failed`, as after "Check saved
    /// connection"), `provider-failure` when Planning Center didn't renew it just now, and a
    /// Keychain error before Planning Center was asked as itself. After `provider-failure` or a
    /// locked Keychain the connection stays as it was, nothing showing the sign-in itself is bad, so
    /// the next read tries again; a Keychain that refuses or isn't there leaves it `failed`. A renewal Planning Center granted whose identity check alone went unanswered keeps
    /// the renewed tokens and counts as renewed (`keep_renewed`); the read's own identity check
    /// then confirms the church before anything is read.
    pub fn renew_if_due(&self) -> Result<bool, crate::source::SourceError> {
        let _turn = self.renewing.lock().unwrap_or_else(|e| e.into_inner());
        let now = (self.now)();
        let broken = |error| renewal_error(error, &Reached::default());
        let before = {
            let state = self.lock().map_err(broken)?;
            if !self.due(&state, now) {
                return Ok(false);
            }
            state.status.clone()
        };
        let generation = self.generation.load(Ordering::SeqCst);
        let mut reached = Reached::default();
        match self.refresh_as(true, &mut reached) {
            Ok(_) => Ok(true),
            Err(error) => {
                // Nothing shows the sign-in itself is bad when Planning Center didn't renew it just
                // now, or when the Keychain was locked before Planning Center was asked (review M,
                // L4): the connection is as it was, and the next read tries again. A Keychain that
                // refuses or isn't there leaves it failed, which says why (review N, 4).
                let untouched = (reached.unreachable && error == AuthError::ProviderFailure)
                    || (!reached.asked && error == AuthError::Store(StoreError::Locked));
                if untouched {
                    let mut state = self.lock().map_err(broken)?;
                    if !self.is_cancelled()
                        && generation == self.generation.load(Ordering::SeqCst)
                        && state.status.state == ConnectionState::Failed
                        && state.status.problem.as_ref() == Some(&error)
                    {
                        state.status = before;
                    }
                }
                Err(renewal_error(error, &reached))
            }
        }
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
        // Set when an unreadable saved sign-in named another church: it's removed, not revoked.
        let mut unrevoked = false;
        let result = (|| {
            if read_private(
                self.store.as_ref(),
                &self.binding.workspace,
                &self.binding.organization,
            )
            .map_err(AuthError::Store)?
            .is_some()
            {
                let tokens = match self.stored() {
                    Ok(stored) => Some(stored.tokens),
                    // A saved sign-in this version can't read (a later version's spelling of what
                    // was granted, or damaged tokens) never blocks Disconnect. The credential it
                    // still names is signed out as this registration's, by its refresh token when
                    // one is readable, but only if it names this church: one naming another church
                    // is removed without a revoke, and the result says so. Bytes that aren't a
                    // sign-in at all hold nothing to revoke. Either way it is then deleted.
                    Err(AuthError::InvalidToken) => {
                        let bytes = read_private(
                            self.store.as_ref(),
                            &self.binding.workspace,
                            &self.binding.organization,
                        )
                        .map_err(AuthError::Store)?;
                        if let Some(old) =
                            bytes.as_deref().map(Vec::as_slice).and_then(Leftover::read)
                        {
                            if old.client_id != self.binding.client_id {
                                return Err(AuthError::OrganizationUnverified);
                            }
                            if old
                                .organization
                                .as_deref()
                                .is_some_and(|church| church != self.binding.organization)
                            {
                                unrevoked = true;
                            } else if let Some((token, hint)) = old.revocable() {
                                self.provider.revoke(&self.binding.client_id, token, hint)?;
                            }
                        }
                        None
                    }
                    Err(error) => return Err(error),
                };
                if let Some(tokens) = tokens {
                    let (token, hint) = revocation(&tokens);
                    self.provider.revoke(&self.binding.client_id, token, hint)?;
                }
            }
            self.store
                .delete(&self.binding.workspace, &self.binding.organization)
                .map_err(AuthError::Store)?;
            let mut state = self.lock()?;
            state.nothing_stored = true;
            state.status.state = ConnectionState::Disconnected;
            state.status.checked_at_ms = None;
            state.status.problem = unrevoked.then_some(AuthError::OrganizationUnverified);
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
                false,
                false,
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
            // verified, the old one (possibly wider) is revoked rather than left valid (`save`).
            self.save(
                tokens,
                scopes,
                attempt.generation,
                Some(attempt.expires),
                &mut diagnostic,
                None,
                false,
                false,
            )
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
/// How far a refresh got (`refresh_as`).
#[derive(Default)]
struct Reached {
    /// Planning Center was asked to renew.
    asked: bool,
    /// The request to renew went unanswered: out of reach, a 429 or a 5xx.
    unreachable: bool,
}
/// A failed renewal as the read it ends reports it, true to what helps: `provider-failure` only
/// when Planning Center didn't renew it just now (no answer, a 429 or a 5xx; another try may work);
/// a Keychain error before Planning Center was asked, a cancel or another sign-in under way as they
/// are; anything else `invalid-credentials`, which only a new sign-in mends: Planning Center refused
/// it, nothing to renew with, a renewal whose identity check named another church or refused the
/// new token, or whose write the Keychain refused (the old refresh token is spent either way, review
/// N, 8), a grant naming a scope set Ozzie never asks for, a controller left broken by a fault.
fn renewal_error(error: AuthError, reached: &Reached) -> crate::source::SourceError {
    match error {
        AuthError::ProviderFailure if reached.unreachable => {
            crate::source::SourceError::ProviderFailure
        }
        AuthError::Store(_) if !reached.asked => source_error(error),
        AuthError::Cancelled | AuthError::Busy => source_error(error),
        _ => crate::source::SourceError::InvalidCredentials,
    }
}
/// An identity check Planning Center didn't answer usefully: out of reach, a 429, or any status but
/// 200, 401 and 403 (a 5xx, say), as `PcoProvider::organization_named` reports them. It says nothing
/// about which church a credential belongs to.
fn unanswered(diagnostic: &OrganizationDiagnostic) -> bool {
    [
        UserInfoReason::TransportFailure,
        UserInfoReason::ProviderFailure,
    ]
    .into_iter()
    .any(|reason| *diagnostic == OrganizationDiagnostic::userinfo(reason))
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

#[cfg(test)]
#[path = "renewal_tests.rs"]
mod renewal_tests;
