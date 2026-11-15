//! Ozzie managed through ozzie.church: this Mac's side of the hosted Ozzie API contract (v1).
//!
//! - Connecting: the app opens `{base}/connect?redirect_port=…&state=…&code_challenge=…&device_label=…` (an S256
//!   challenge, a fresh state and DEVICE_LABEL, which names no one). The person signs in there; the browser comes back
//!   to `http://127.0.0.1:<port>/ozzie/callback?code=…&state=…`, read by a one-attempt loopback receiver with the same
//!   request rules as Planning Center's (callback.rs `read_loopback_get`), for at most five minutes. A request with
//!   the wrong state is answered and ignored. The one-time code and the verifier go to `POST /api/v1/device/token`;
//!   the device token that comes back is kept in the Keychain (KEYCHAIN_SERVICE / MANAGED_TOKEN_ACCOUNT) only.
//! - Sending: with a device token saved, the managed route sends agent steps and rewords to ozzie.church with it
//!   (model.rs `Target::Hosted`). Every native check still runs on this Mac first and every reply is read by the same
//!   code as before; only the address, the body's outer shape and the authorization change. ozzie.church refuses
//!   with `{"error":"<code>"}`: 402 `allowance-paused` is `allowance-paused`, 401 is `not-configured` (connect
//!   again), 429 `rate-limited` is `rate-limited`, 429 `step-limit` is `step-limit` (an agent step's `limit`), 400
//!   `contact-detail` is `contact-detail`, anything else `provider-failure`. Nothing from a reply body is ever
//!   carried in an error.
//! - Status: plan and usage from `GET /api/v1/account`, kept in ACCOUNT_FILE for up to ACCOUNT_CACHE_MS; when
//!   ozzie.church can't be reached, the last one known with when it was read (`offline`).
//! - Disconnecting: `POST /api/v1/device/revoke` (best effort), then the Keychain item is deleted.
//!
//! The device token is a credential: never in an error, a status, IPC, a log, a file or a process argument. Release
//! builds always use HOSTED_BASE; a debug build may point at a local server with OZZIE_DEV_HOSTED_URL (https, or
//! http only on 127.0.0.1).
use crate::credentials::StoreError;
use crate::model::{self, ModelError, ModelHttp, ModelKeys, ModelStatus, NativeModelHttp};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    net::{Ipv4Addr, TcpListener, TcpStream},
    path::Path,
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use zeroize::Zeroizing;

/// The only address a release build sends to.
pub const HOSTED_BASE: &str = "https://ozzie.church";
/// Debug builds only: another base for testing against a local server (`dev_base` rules).
pub const DEV_HOSTED_ENV: &str = "OZZIE_DEV_HOSTED_URL";
/// Keychain account (service KEYCHAIN_SERVICE) for this Mac's device token.
pub const MANAGED_TOKEN_ACCOUNT: &str = "ozzie-managed";
pub const CONNECT_PATH: &str = "/connect";
pub const CALLBACK_PATH: &str = "/ozzie/callback";
pub const TOKEN_PATH: &str = "/api/v1/device/token";
pub const ACCOUNT_PATH: &str = "/api/v1/account";
pub const AGENT_STEP_PATH: &str = "/api/v1/agent-step";
pub const REWORD_PATH: &str = "/api/v1/reword";
pub const REVOKE_PATH: &str = "/api/v1/device/revoke";
/// The device label ozzie.church shows on the account page. Fixed: a Mac's own name often holds its owner's.
pub const DEVICE_LABEL: &str = "Ozzie for Mac";
/// How long a connect waits for the browser, as for a Planning Center sign-in.
pub const CONNECT_LIFETIME_MS: u64 = crate::oauth::ATTEMPT_LIFETIME_MS;
/// How long a plan-and-usage reading is used before ozzie.church is asked again.
pub const ACCOUNT_CACHE_MS: u64 = 60_000;
/// The last plan-and-usage reading, in the app data directory. Counts, a plan id and a date only.
pub const ACCOUNT_FILE: &str = "managed-account.json";
const MAX_PLAN_CHARS: usize = 32;
const MAX_STEPS: u64 = 100_000_000;
const MAX_CODE_CHARS: usize = 512;
/// Account, token and revoke requests; an agent step keeps model.rs's longer limit.
const ACCOUNT_TIMEOUT: Duration = Duration::from_secs(10);

/// The closed error vocabulary of connecting and disconnecting. Nothing from a reply, a code or a token.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ManagedError {
    /// Another connect is already waiting for the browser.
    Busy,
    /// This Mac couldn't start the sign-in (no loopback port or no randomness).
    Unavailable,
    /// The browser couldn't be opened.
    BrowserUnavailable,
    /// The person cancelled here or on ozzie.church.
    Cancelled,
    /// Nobody finished signing in within five minutes.
    Expired,
    /// ozzie.church refused the one-time code (used, expired or not for this Mac).
    Refused,
    /// ozzie.church couldn't be reached, or answered with something Ozzie doesn't accept.
    ProviderFailure,
    /// The Keychain couldn't save or remove this Mac's connection.
    Keychain,
}

/// Where Ozzie managed is reached in this build.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostedConfig {
    /// HOSTED_BASE, or a debug build's checked override; never ends with `/`.
    pub base: String,
    /// A debug build: the override is honoured and the managed route may still go straight to AI Gateway with the
    /// owner's key when this Mac has no device token (model.rs `target`).
    pub debug: bool,
}
impl HostedConfig {
    /// This build's: release builds never read the environment.
    pub fn current() -> Self {
        let debug = cfg!(debug_assertions);
        let env = if debug {
            std::env::var(DEV_HOSTED_ENV).ok()
        } else {
            None
        };
        Self::from_env(debug, env.as_deref())
    }
    /// HOSTED_BASE unless `debug` and `env` passes `dev_base`.
    pub fn from_env(debug: bool, env: Option<&str>) -> Self {
        let base = env
            .filter(|_| debug)
            .and_then(dev_base)
            .unwrap_or_else(|| HOSTED_BASE.to_owned());
        Self { base, debug }
    }
    /// Plain http only for a debug build's 127.0.0.1 server.
    pub fn https_only(&self) -> bool {
        self.base.starts_with("https://")
    }
    pub fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }
}
/// A debug override: `https://<host>[:port]`, or `http://127.0.0.1[:port]`, with no path, user, query or fragment,
/// and never Planning Center or Church Center.
fn dev_base(text: &str) -> Option<String> {
    let text = text.trim_end_matches('/');
    let url = url::Url::parse(text).ok()?;
    let clean = text.len() <= 100
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && url.path() == "/";
    let host = url.host_str()?.trim_end_matches('.');
    let allowed = match url.scheme() {
        "https" => !host.is_empty() && !model::planning_center_host(host),
        "http" => url.host() == Some(url::Host::Ipv4(Ipv4Addr::LOCALHOST)),
        _ => false,
    };
    (clean && allowed).then(|| url.as_str().trim_end_matches('/').to_owned())
}

/// 32 random bytes in base64url per the contract; any token of 32 to 256 base64url characters is accepted.
fn token_ok(token: &str) -> bool {
    (32..=256).contains(&token.len())
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
/// This Mac's device token, or `not-configured`.
pub(crate) fn device_token(keys: &dyn ModelKeys) -> Result<Zeroizing<String>, ModelError> {
    match keys.key(MANAGED_TOKEN_ACCOUNT) {
        Ok(Some(token)) if token_ok(&token) => Ok(token),
        _ => Err(ModelError::NotConfigured),
    }
}
/// Whether this Mac holds a usable device token. Presence only.
pub fn connected(keys: &dyn ModelKeys) -> bool {
    device_token(keys).is_ok()
}

/// Where the device token is kept. Reads go through `ModelKeys` under MANAGED_TOKEN_ACCOUNT; only connecting and
/// disconnecting write.
pub trait TokenStore: ModelKeys {
    fn put_token(&self, token: &str) -> Result<(), StoreError>;
    fn delete_token(&self) -> Result<(), StoreError>;
}
#[cfg(target_os = "macos")]
impl TokenStore for model::KeychainKeys {
    fn put_token(&self, token: &str) -> Result<(), StoreError> {
        security_framework::passwords::set_generic_password(
            model::KEYCHAIN_SERVICE,
            MANAGED_TOKEN_ACCOUNT,
            token.as_bytes(),
        )
        .map_err(|error| crate::credentials::classify_status(error.code()))
    }
    fn delete_token(&self) -> Result<(), StoreError> {
        match security_framework::passwords::delete_generic_password(
            model::KEYCHAIN_SERVICE,
            MANAGED_TOKEN_ACCOUNT,
        ) {
            Ok(()) => Ok(()),
            Err(error) if error.code() == -25300 => Ok(()),
            Err(error) => Err(crate::credentials::classify_status(error.code())),
        }
    }
}

/// A hosted reply's refusal, from its status and the fixed `{"error":"<code>"}` vocabulary only:
/// each code ozzie.church answers that the Mac can explain gets its own error, anything else is
/// `provider-failure`.
pub(crate) fn refusal(status: u16, body: &[u8]) -> Option<ModelError> {
    #[derive(Deserialize)]
    struct Refused {
        error: String,
    }
    let code = serde_json::from_slice::<Refused>(body)
        .ok()
        .map(|refused| refused.error);
    let is = |wanted: &str| code.as_deref() == Some(wanted);
    match status {
        200 => None,
        402 if is("allowance-paused") => Some(ModelError::AllowancePaused),
        401 => Some(ModelError::NotConfigured),
        429 if is("rate-limited") => Some(ModelError::RateLimited),
        429 if is("step-limit") => Some(ModelError::StepLimit),
        400 if is("contact-detail") => Some(ModelError::ContactDetail),
        _ => Some(ModelError::ProviderFailure),
    }
}

// ---- Plan and usage ---------------------------------------------------------------------------------

/// "three-quarters", "nine-tenths" or "paused" (owner decision 2026-10-26: warnings at three quarters and nine
/// tenths; at the limit AI drafting pauses and nothing charges itself).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Warning {
    ThreeQuarters,
    NineTenths,
    Paused,
}
impl Warning {
    fn parse(text: &str) -> Option<Self> {
        match text {
            "three-quarters" => Some(Self::ThreeQuarters),
            "nine-tenths" => Some(Self::NineTenths),
            "paused" => Some(Self::Paused),
            _ => None,
        }
    }
    /// The warning the counts call for, when ozzie.church didn't say (the token reply carries none).
    fn for_counts(used: u64, allowance: u64) -> Option<Self> {
        let (used, allowance) = (u128::from(used), u128::from(allowance));
        if used >= allowance {
            Some(Self::Paused)
        } else if used * 10 >= allowance * 9 {
            Some(Self::NineTenths)
        } else if used * 4 >= allowance * 3 {
            Some(Self::ThreeQuarters)
        } else {
            None
        }
    }
}
/// The account's plan and usage, every field checked, and when it was read. A plan id, counts and a date: no person
/// and no free text, so it may go to the webview and into ACCOUNT_FILE.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Account {
    pub plan: String,
    pub allowance_steps: u64,
    pub used_steps: u64,
    /// When the allowance resets: an ISO 8601 date or date and time.
    pub period_ends: String,
    pub warning: Option<Warning>,
    /// When ozzie.church reported this (Unix milliseconds).
    pub checked_at_ms: u64,
    /// ozzie.church couldn't be reached just now: this is the last reading, from `checked_at_ms`.
    pub offline: bool,
}
/// The account object as ozzie.church sends it. Unknown fields are ignored and never kept.
#[derive(Deserialize)]
struct AccountWire {
    plan: String,
    allowance_steps: u64,
    used_steps: u64,
    period_ends: String,
    #[serde(default)]
    warning: Option<String>,
}
fn plan_ok(plan: &str) -> bool {
    (1..=MAX_PLAN_CHARS).contains(&plan.len())
        && plan.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
        && plan
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}
/// `YYYY-MM-DD`, optionally followed by `T` and a time with an offset (`2026-12-01T00:00:00.000Z`).
fn period_ok(text: &str) -> bool {
    let n = |range: std::ops::Range<usize>| text[range].parse::<u32>().unwrap_or(0);
    let digits = |range: std::ops::Range<usize>| text[range].bytes().all(|b| b.is_ascii_digit());
    text.is_ascii()
        && (10..=35).contains(&text.len())
        && digits(0..4)
        && &text[4..5] == "-"
        && digits(5..7)
        && &text[7..8] == "-"
        && digits(8..10)
        && (1..=12).contains(&n(5..7))
        && (1..=31).contains(&n(8..10))
        && (text.len() == 10
            || (&text[10..11] == "T"
                && text[11..]
                    .bytes()
                    .all(|b| b.is_ascii_digit() || b":.Z+-".contains(&b))))
}
impl AccountWire {
    /// `counted`: no warning was sent, so it comes from the counts.
    fn checked(self, counted: bool, now: u64) -> Option<Account> {
        let ok = plan_ok(&self.plan)
            && self.allowance_steps <= MAX_STEPS
            && self.used_steps <= MAX_STEPS
            && period_ok(&self.period_ends);
        let warning = match (counted, self.warning.as_deref()) {
            (true, _) => Warning::for_counts(self.used_steps, self.allowance_steps),
            (false, None) => None,
            (false, Some(text)) => Some(Warning::parse(text)?),
        };
        ok.then_some(Account {
            plan: self.plan,
            allowance_steps: self.allowance_steps,
            used_steps: self.used_steps,
            period_ends: self.period_ends,
            warning,
            checked_at_ms: now,
            offline: false,
        })
    }
}
impl Account {
    /// The same checks, for a reading read back from ACCOUNT_FILE.
    fn valid(&self) -> bool {
        plan_ok(&self.plan)
            && self.allowance_steps <= MAX_STEPS
            && self.used_steps <= MAX_STEPS
            && period_ok(&self.period_ends)
    }
}

/// What model_status can say about Ozzie managed on this Mac.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AccountState {
    /// No device token is saved.
    NotConnected,
    /// ozzie.church refused the saved token (revoked, say): connect again.
    Reconnect,
    /// The latest reading (fresh, cached, or the last one known when offline).
    Known(Account),
    /// Connected, but ozzie.church couldn't be reached and nothing was read before.
    Unknown,
}
static CACHE: Mutex<()> = Mutex::new(());
fn read_cache(dir: &Path) -> Option<Account> {
    let bytes = model::read_small(&dir.join(ACCOUNT_FILE)).ok()??;
    serde_json::from_slice::<Account>(&bytes)
        .ok()
        .filter(Account::valid)
}
fn write_cache(dir: &Path, account: &Account) {
    let saved = Account {
        offline: false,
        ..account.clone()
    };
    if let Ok(bytes) = serde_json::to_vec(&saved) {
        // A reading that can't be kept is still shown; the next status asks again.
        let _ = model::write_private(&dir.join(ACCOUNT_FILE), &bytes);
    }
}
fn clear_cache(dir: &Path) {
    let _lock = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    let _ = std::fs::remove_file(dir.join(ACCOUNT_FILE));
}

/// Plan and usage for this Mac's connection: a reading younger than ACCOUNT_CACHE_MS, else `GET /api/v1/account`.
pub fn account(hosted: &HostedConfig, keys: &dyn ModelKeys, dir: &Path, now: u64) -> AccountState {
    if !connected(keys) {
        return AccountState::NotConnected;
    }
    match NativeModelHttp::hosted(hosted, ACCOUNT_TIMEOUT) {
        Ok(http) => account_using(hosted, keys, &http, dir, now),
        Err(_) => account_using(hosted, keys, &Unreachable, dir, now),
    }
}
/// A client that couldn't be built: every request fails as unreachable.
struct Unreachable;
impl ModelHttp for Unreachable {
    fn post(
        &self,
        _: &str,
        _: Option<&str>,
        _: &[(&str, &str)],
        _: &[u8],
    ) -> Result<(u16, Zeroizing<Vec<u8>>), ModelError> {
        Err(ModelError::ProviderFailure)
    }
}
pub(crate) fn account_using(
    hosted: &HostedConfig,
    keys: &dyn ModelKeys,
    http: &dyn ModelHttp,
    dir: &Path,
    now: u64,
) -> AccountState {
    let Ok(token) = device_token(keys) else {
        return AccountState::NotConnected;
    };
    let _lock = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    let cached = read_cache(dir);
    if let Some(account) = cached
        .as_ref()
        .filter(|a| now >= a.checked_at_ms && now - a.checked_at_ms < ACCOUNT_CACHE_MS)
    {
        return AccountState::Known(account.clone());
    }
    let answer = http.get(&hosted.url(ACCOUNT_PATH), Some(&token));
    drop(token);
    let fresh = match answer {
        Ok((200, bytes)) => serde_json::from_slice::<AccountWire>(&bytes)
            .ok()
            .and_then(|wire| wire.checked(false, now)),
        Ok((401, _)) => {
            let _ = std::fs::remove_file(dir.join(ACCOUNT_FILE));
            return AccountState::Reconnect;
        }
        _ => None,
    };
    match (fresh, cached) {
        (Some(account), _) => {
            write_cache(dir, &account);
            AccountState::Known(account)
        }
        (None, Some(last)) => AccountState::Known(Account {
            offline: true,
            ..last
        }),
        (None, None) => AccountState::Unknown,
    }
}
/// Adds Ozzie managed to a model status: whether this Mac is connected, plan and usage, and — when the managed route
/// is chosen and ozzie.church refused the token — `reconnect` instead of `ready`.
pub fn attach(status: &mut ModelStatus, state: AccountState) {
    match state {
        AccountState::NotConnected => status.managed = "not-connected",
        AccountState::Reconnect => {
            status.managed = "reconnect";
            status.account = None;
            if status.route == "managed" {
                status.configured = false;
                status.setup = "reconnect";
            }
        }
        AccountState::Known(account) => {
            status.managed = "connected";
            status.account = Some(account);
        }
        AccountState::Unknown => status.managed = "connected",
    }
}

// ---- Connecting -------------------------------------------------------------------------------------

/// One browser sign-in waiting for its callback. Not Debug: it holds the verifier.
pub struct ConnectAttempt {
    listener: TcpListener,
    /// `127.0.0.1:<port>`, the only Host the receiver accepts.
    host: String,
    state: String,
    verifier: Zeroizing<String>,
    url: String,
    expires_ms: u64,
}
enum Callback {
    Code(Zeroizing<String>),
    /// Not this attempt's (wrong state, malformed): answered and ignored.
    Ignore,
    Cancelled,
    Refused,
}
/// Equal length and bytes, without stopping at the first difference.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}
fn code_ok(code: &str) -> bool {
    (1..=MAX_CODE_CHARS).contains(&code.len())
        && code
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-._~".contains(&b))
}
fn random_text() -> Result<String, ManagedError> {
    use base64::Engine;
    let mut random = Zeroizing::new([0u8; 32]);
    getrandom::fill(random.as_mut()).map_err(|_| ManagedError::Unavailable)?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(random.as_ref()))
}
impl ConnectAttempt {
    /// A loopback port, a verifier, its S256 challenge and a state, and the browser address that carries them.
    pub fn begin(hosted: &HostedConfig, now_ms: u64) -> Result<Self, ManagedError> {
        use base64::Engine;
        use sha2::Digest;
        let listener =
            TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(|_| ManagedError::Unavailable)?;
        listener
            .set_nonblocking(true)
            .map_err(|_| ManagedError::Unavailable)?;
        let port = listener
            .local_addr()
            .map_err(|_| ManagedError::Unavailable)?
            .port();
        let verifier = Zeroizing::new(random_text()?);
        let state = random_text()?;
        let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(sha2::Sha256::digest(verifier.as_bytes()));
        let mut url =
            url::Url::parse(&hosted.url(CONNECT_PATH)).map_err(|_| ManagedError::Unavailable)?;
        url.query_pairs_mut().extend_pairs([
            ("redirect_port", port.to_string().as_str()),
            ("state", &state),
            ("code_challenge", &challenge),
            ("device_label", DEVICE_LABEL),
        ]);
        Ok(Self {
            listener,
            host: format!("127.0.0.1:{port}"),
            state,
            verifier,
            url: url.into(),
            expires_ms: now_ms.saturating_add(CONNECT_LIFETIME_MS),
        })
    }
    /// The browser address: challenge, state, port and label only.
    pub fn url(&self) -> &str {
        &self.url
    }
    fn read(&self, target: &str) -> Callback {
        let Ok(url) = url::Url::parse(&format!("http://{}{target}", self.host)) else {
            return Callback::Ignore;
        };
        if url.path() != CALLBACK_PATH || url.fragment().is_some() {
            return Callback::Ignore;
        }
        let mut query: HashMap<String, Zeroizing<String>> = HashMap::new();
        for (key, value) in url.query_pairs() {
            if query
                .insert(key.into_owned(), Zeroizing::new(value.into_owned()))
                .is_some()
            {
                return Callback::Ignore;
            }
        }
        let ours = query
            .get("state")
            .is_some_and(|state| same(state.as_bytes(), self.state.as_bytes()));
        if !ours {
            return Callback::Ignore;
        }
        if query.contains_key("error") {
            return Callback::Cancelled;
        }
        match query.remove("code") {
            Some(code) if code_ok(&code) => Callback::Code(code),
            _ => Callback::Refused,
        }
    }
    /// Answers loopback requests until this attempt's callback arrives, the person cancels or five minutes pass. The
    /// browser's connection is returned open so the page it sees can say how connecting ended.
    fn wait(
        &self,
        cancel: &AtomicBool,
        now: &dyn Fn() -> u64,
    ) -> Result<(Zeroizing<String>, TcpStream), ManagedError> {
        loop {
            if cancel.load(Ordering::SeqCst) {
                return Err(ManagedError::Cancelled);
            }
            if now() >= self.expires_ms {
                return Err(ManagedError::Expired);
            }
            match self.listener.accept() {
                Ok((mut stream, _)) => {
                    // Accepted sockets inherit the listener's nonblocking mode on macOS.
                    if stream.set_nonblocking(false).is_err() {
                        continue;
                    }
                    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
                    let Some(target) =
                        crate::callback::read_loopback_get(&mut stream, &self.host, CALLBACK_PATH)
                    else {
                        page(&mut stream, Page::Failed);
                        continue;
                    };
                    match self.read(&target) {
                        Callback::Code(code) => return Ok((code, stream)),
                        Callback::Ignore => page(&mut stream, Page::Failed),
                        Callback::Cancelled => {
                            page(&mut stream, Page::Cancelled);
                            return Err(ManagedError::Cancelled);
                        }
                        Callback::Refused => {
                            page(&mut stream, Page::Failed);
                            return Err(ManagedError::Refused);
                        }
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(25))
                }
                Err(_) => return Err(ManagedError::Unavailable),
            }
        }
    }
}
enum Page {
    Connected,
    Failed,
    Cancelled,
}
fn page(stream: &mut TcpStream, page: Page) {
    let (status, text) = match page {
        Page::Connected => (
            "200 OK",
            "This Mac is connected to Ozzie managed. You can close this tab and return to Ozzie.",
        ),
        Page::Failed => (
            "400 Bad Request",
            "This Mac couldn't be connected. Return to Ozzie and try again.",
        ),
        Page::Cancelled => ("200 OK", "Connecting was cancelled. Return to Ozzie."),
    };
    let body = format!("<!doctype html><title>Ozzie</title><p>{text}</p>");
    crate::callback::write_page(stream, status, &body);
}

/// Waits for the browser, exchanges the one-time code, keeps the device token in the Keychain and returns the
/// account. A token this replaces is revoked (best effort) once the new one is saved.
pub fn connect(
    attempt: &ConnectAttempt,
    hosted: &HostedConfig,
    store: &dyn TokenStore,
    cancel: &AtomicBool,
    now: &dyn Fn() -> u64,
    dir: &Path,
) -> Result<Account, ManagedError> {
    let http =
        NativeModelHttp::hosted(hosted, ACCOUNT_TIMEOUT).map_err(|_| ManagedError::Unavailable)?;
    connect_using(attempt, hosted, store, &http, cancel, now, dir)
}
pub(crate) fn connect_using(
    attempt: &ConnectAttempt,
    hosted: &HostedConfig,
    store: &dyn TokenStore,
    http: &dyn ModelHttp,
    cancel: &AtomicBool,
    now: &dyn Fn() -> u64,
    dir: &Path,
) -> Result<Account, ManagedError> {
    let (code, mut stream) = attempt.wait(cancel, now)?;
    let result = (|| {
        let (token, account) = exchange(hosted, http, &code, &attempt.verifier, now())?;
        // A connect cancelled while the code was exchanged leaves nothing valid behind.
        if cancel.load(Ordering::SeqCst) {
            revoke(hosted, http, &token);
            return Err(ManagedError::Cancelled);
        }
        let previous = device_token(store).ok();
        if store.put_token(&token).is_err() {
            revoke(hosted, http, &token);
            return Err(ManagedError::Keychain);
        }
        if let Some(old) = previous.filter(|old| !same(old.as_bytes(), token.as_bytes())) {
            revoke(hosted, http, &old);
        }
        let _lock = CACHE.lock().unwrap_or_else(|e| e.into_inner());
        write_cache(dir, &account);
        Ok(account)
    })();
    page(
        &mut stream,
        match result {
            Ok(_) => Page::Connected,
            Err(ManagedError::Cancelled) => Page::Cancelled,
            Err(_) => Page::Failed,
        },
    );
    result
}
/// `POST /api/v1/device/token { code, code_verifier }` → the device token and the account.
fn exchange(
    hosted: &HostedConfig,
    http: &dyn ModelHttp,
    code: &str,
    verifier: &str,
    now: u64,
) -> Result<(Zeroizing<String>, Account), ManagedError> {
    #[derive(Serialize)]
    struct TokenRequest<'a> {
        code: &'a str,
        code_verifier: &'a str,
    }
    #[derive(Deserialize)]
    struct TokenReply {
        device_token: String,
        account: AccountWire,
    }
    let body = Zeroizing::new(
        serde_json::to_vec(&TokenRequest {
            code,
            code_verifier: verifier,
        })
        .map_err(|_| ManagedError::Unavailable)?,
    );
    let (status, bytes) = http
        .post(&hosted.url(TOKEN_PATH), None, &[], &body)
        .map_err(|_| ManagedError::ProviderFailure)?;
    match status {
        200 => {}
        400 | 401 | 403 | 404 | 409 | 410 => return Err(ManagedError::Refused),
        _ => return Err(ManagedError::ProviderFailure),
    }
    let mut reply: TokenReply =
        serde_json::from_slice(&bytes).map_err(|_| ManagedError::ProviderFailure)?;
    let token = Zeroizing::new(std::mem::take(&mut reply.device_token));
    if !token_ok(&token) {
        return Err(ManagedError::ProviderFailure);
    }
    let account = reply
        .account
        .checked(true, now)
        .ok_or(ManagedError::ProviderFailure)?;
    Ok((token, account))
}
/// `POST /api/v1/device/revoke` with the token. Best effort: whether it worked.
fn revoke(hosted: &HostedConfig, http: &dyn ModelHttp, token: &str) -> bool {
    matches!(
        http.post(&hosted.url(REVOKE_PATH), Some(token), &[], b"{}"),
        Ok((200..=299, _))
    )
}

/// Revokes this Mac's device token (best effort) and deletes it from the Keychain, with the last plan reading.
pub fn disconnect(
    hosted: &HostedConfig,
    store: &dyn TokenStore,
    dir: &Path,
) -> Result<(), ManagedError> {
    match NativeModelHttp::hosted(hosted, ACCOUNT_TIMEOUT) {
        Ok(http) => disconnect_using(hosted, store, &http, dir),
        Err(_) => disconnect_using(hosted, store, &Unreachable, dir),
    }
}
pub(crate) fn disconnect_using(
    hosted: &HostedConfig,
    store: &dyn TokenStore,
    http: &dyn ModelHttp,
    dir: &Path,
) -> Result<(), ManagedError> {
    if let Ok(token) = device_token(store) {
        revoke(hosted, http, &token);
    }
    store.delete_token().map_err(|_| ManagedError::Keychain)?;
    clear_cache(dir);
    Ok(())
}

#[cfg(test)]
#[path = "hosted_fake.rs"]
pub(crate) mod fake;
#[cfg(test)]
#[path = "hosted_tests.rs"]
mod tests;
