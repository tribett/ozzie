//! Model route for placeholder-only text: rewording a draft note, and Ask Ozzie questions
//! answered from a placeholder-only fact sheet.
//!
//! Open-source Ozzie lets a pastor use their own provider key or a local model; the managed
//! route goes through ozzie.church with this Mac's device token (hosted.rs), which calls Vercel AI
//! Gateway with zero data retention required on every request. The own and local routes speak the
//! OpenAI Chat Completions format; ozzie.church takes the checked request and answers in it. Debug
//! builds keep the managed route's earlier direct path to AI Gateway with the owner's key, used only
//! when this Mac has no device token; release builds never read that key.
//!
//! Apart from Planning Center's OAuth sign-in endpoints (token exchange, refresh, revoke) and
//! Ozzie managed's connect and revoke (hosted.rs, which carry no church data), these are the only
//! non-GET requests Ozzie makes: one POST per call to the configured model provider, or to
//! ozzie.church for the managed route. They never go to Planning Center, share no client or
//! credential with the Planning Center paths, and carry only text that already passed a
//! placeholder boundary in the webview and passes the native checks here. Keys and the device
//! token are read from the Keychain here and in hosted.rs and never leave them: not in errors,
//! status or IPC.
use crate::background::background_wording;
use crate::credentials::{StoreError, classify_status};
use crate::hosted::{self, HostedConfig};
use crate::name_guard::NameGuard;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
    time::{Duration, Instant},
};
use zeroize::Zeroizing;

pub const MANAGED_BASE: &str = "https://ai-gateway.vercel.sh/v1";
/// Available on the managed route's model allowlist (verified live 2026-11-13).
pub const MANAGED_MODEL: &str = "anthropic/claude-haiku-5.5";
/// Vercel Custom Reporting tags so spend on the managed route can be attributed to Ozzie. Fixed values only:
/// nothing identifying a person, and never the `ai-reporting-user` header.
pub const MANAGED_TAGS: (&str, &str) = (
    "ai-reporting-tags",
    "app:ozzie,route:managed,feature:reword",
);
pub const LOCAL_BASE: &str = "http://127.0.0.1:11434/v1";
pub const LOCAL_MODEL: &str = "llama3.2";
/// Vercel AI Gateway's host. An own-provider route pointed here gets the managed route's zero
/// data retention requirement too.
pub const GATEWAY_HOST: &str = "ai-gateway.vercel.sh";
pub const KEYCHAIN_SERVICE: &str = "church.ozzie.model.v1";
/// Keychain account for the managed route's key.
pub const MANAGED_ACCOUNT: &str = "vercel-ai-gateway";
/// An own-provider key is saved under `own-provider:<host>` (with `:<port>` when the URL names
/// one), so it only ever goes to the host it was saved for: pointing the route at another host
/// finds no key. A key under the old plain account `own-provider` is bound to no host and is never
/// used; status reports `own-key-not-bound` until it is saved again under the host's account.
pub const OWN_ACCOUNT_PREFIX: &str = "own-provider:";
pub const LEGACY_OWN_ACCOUNT: &str = "own-provider";
pub const CONFIG_FILE: &str = "model.json";
pub const LEDGER_FILE: &str = "model-usage.json";
pub const MAX_SYSTEM_CHARS: usize = 2000;
pub const MAX_USER_CHARS: usize = 4000;
pub const MAX_REPLY_CHARS: usize = 4000;
pub const MAX_TOKENS: u32 = 400;
/// Calls allowed on the managed route's direct path (debug builds, the owner's AI Gateway key) until the owner
/// raises `call_cap` in model.json. The own-key route has a monthly limit instead (`DEFAULT_MONTH_LIMIT`).
pub const DEFAULT_CALL_CAP: u64 = 200;
/// AI requests a UTC month on the church's own key (onboarding spec S8, "The monthly limit"), changeable in
/// Settings within `MONTH_LIMITS` (`set_month_limit`). Stops a runaway bill on a key the church pays for.
pub const DEFAULT_MONTH_LIMIT: u64 = 1_000;
pub const MONTH_LIMITS: std::ops::RangeInclusive<u64> = 100..=20_000;
/// Agent steps per route per day (UTC), on every route, local included, whatever the call cap,
/// until the owner changes `agent_steps_per_day` in model.json.
pub const DEFAULT_AGENT_STEPS_PER_DAY: u64 = 200;
/// Model ids: `^[A-Za-z0-9._:/@+-]{1,100}$`, no contact detail and no remembered name.
pub const MAX_MODEL_CHARS: usize = 100;
const DAY_MS: u64 = 86_400_000;
const MAX_RESPONSE_BYTES: u64 = 262_144;

// The only request shape the app sends (core/src/draft-request.ts, pinned by a test):
// the fixed system text, one fixed rewording choice, then Ozzie's own placeholder note.
pub const SYSTEM: &str = "You help a church volunteer coordinator word a short, kind, plain note asking one volunteer whether they can serve. Reply with only the revised note. Keep each of [Volunteer A], [Role] and [Your name] that appears in the note exactly as written; add no names and no other bracketed text. Make it easy to say no. No guilt, pressure, flattery, scripture, prayers, blessings, sermons or devotional content. Under 90 words.";
pub const REWORDINGS: [&str; 4] = [
    "Make it warmer.",
    "Make it shorter.",
    "Make it more casual.",
    "Make it a little more formal.",
];
pub const NOTE_PREFIX: &str = "\n\nNote:\n";
pub const LABELS: [&str; 3] = ["[Volunteer A]", "[Role]", "[Your name]"];
const MAX_FILE_BYTES: u64 = 16_384;

/// The whole error vocabulary. Nothing from a provider body or a key is ever carried.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ModelError {
    NotConfigured,
    Budget,
    RateLimited,
    ProviderFailure,
    InvalidRequest,
    /// The provider refused this model for this account (e.g. a team model allowlist).
    ModelNotAllowed,
    /// A name this session has shown appears in the request; nothing was sent.
    NamePresent,
    /// Today's agent steps on this route (model.json `agent_steps_per_day`) are spent, or, through ozzie.church, the
    /// account's own daily ceiling (429 `rate-limited`, reason `daily-limit`; re-check NM1), which rewording can meet
    /// too. AI starts again after midnight UTC.
    DailyLimit,
    /// Ozzie managed: the church's allowance on ozzie.church is spent, so AI help is paused until
    /// it resets or the plan changes (HTTP 402 `allowance-paused`). Checks and briefings keep working.
    AllowancePaused,
    /// Ozzie managed: ozzie.church refused the request as holding a phone number or email address
    /// (HTTP 400 `contact-detail`). Nothing went to the AI.
    ContactDetail,
    /// Ozzie managed, agent steps only: ozzie.church says the task has taken its model steps
    /// (HTTP 429 `step-limit`).
    StepLimit,
    /// Background-check wording in what the request would carry (background.rs; owner decision
    /// 2026-11-14): refused here before any key, budget or network, or by ozzie.church (HTTP 400
    /// `background-check`) before the AI. Nothing was sent to the AI, and nothing of the text is kept.
    BackgroundCheck,
    /// Rewording only: the note holds a hidden character (a control, format, private-use or
    /// default-ignorable character, the blank braille pattern or a line separator other than a line
    /// break; `hidden_in_note`), found here or by ozzie.church (HTTP 400 `hidden-character`). Nothing
    /// was sent to the AI (review B2 M-1).
    HiddenCharacter,
    /// The company says the church's account has no credit left (Anthropic's "credit balance is too low" or 402,
    /// OpenAI's `insufficient_quota` / `credit_balance_exhausted`, Google's "outstanding balance"), in normal use after
    /// the key was saved. Nothing more is sent until credit is added.
    NoCredit,
    /// The church's own key: this UTC month's AI requests (model.json `month_limit`) are spent; AI pauses until
    /// the next month. Nothing was sent.
    MonthLimit,
    /// AI on this Mac: the model chosen doesn't run on this Mac (Ollama's cloud models, a model served from another
    /// computer), or Ozzie can't tell it does (`local_ai::on_this_mac`). Nothing was sent, and it is never chosen.
    NotOnThisMac,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Route {
    Managed,
    Own,
    Local,
}
impl Route {
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "managed" => Some(Self::Managed),
            "own" => Some(Self::Own),
            "local" => Some(Self::Local),
            _ => None,
        }
    }
    fn name(self) -> &'static str {
        match self {
            Self::Managed => "managed",
            Self::Own => "own",
            Self::Local => "local",
        }
    }
}

/// Non-secret route settings, stored as model.json in the app data directory.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RouteConfig {
    pub route: Route,
    pub base_url: String,
    pub model: String,
    /// Owner-set ceiling on paid calls. Only editable in model.json, never over IPC.
    #[serde(default = "default_cap")]
    pub call_cap: u64,
    /// Owner-set ceiling on agent steps per UTC day, on any route. Only editable in model.json.
    #[serde(default = "default_day_cap")]
    pub agent_steps_per_day: u64,
    /// The own-key route's AI requests a UTC month (`set_month_limit`, within MONTH_LIMITS).
    #[serde(default = "default_month_limit")]
    pub month_limit: u64,
    /// A local model only: when "Check that it answers" last passed for this address and model (Unix ms). Until
    /// then the route is chosen but not checked, never "ready".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checked_at_ms: Option<u64>,
}
fn default_cap() -> u64 {
    DEFAULT_CALL_CAP
}
fn default_month_limit() -> u64 {
    DEFAULT_MONTH_LIMIT
}
fn default_day_cap() -> u64 {
    DEFAULT_AGENT_STEPS_PER_DAY
}
/// A URL's host as every check compares it: the url crate's lowercase, punycoded form without a
/// trailing dot ("api.planningcenteronline.com." is the same host), with `:<port>` only when the
/// URL names a port other than the scheme's default.
fn host_key(url: &url::Url) -> Option<String> {
    let host = url.host_str()?.trim_end_matches('.');
    if host.is_empty() {
        return None;
    }
    Some(match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_owned(),
    })
}
/// `host_key` of a URL given as text.
pub fn host_key_of(url: &str) -> Option<String> {
    url::Url::parse(url).ok().as_ref().and_then(host_key)
}
/// Planning Center and Church Center (its people-facing site), on any route.
pub(crate) fn planning_center_host(host: &str) -> bool {
    ["planningcenteronline.com", "churchcenter.com"]
        .iter()
        .any(|domain| host == *domain || host.ends_with(&format!(".{domain}")))
}
/// An 8-digit date stamp in a model id ("claude-3-5-sonnet-20241022", "…@20240620"): 20YYMMDD.
fn date_stamp(digits: &str) -> bool {
    let n = |range: std::ops::Range<usize>| digits[range].parse::<u32>().unwrap_or(0);
    digits.len() == 8
        && digits.bytes().all(|b| b.is_ascii_digit())
        && digits.starts_with("20")
        && (1..=12).contains(&n(4..6))
        && (1..=31).contains(&n(6..8))
}
/// The model id rules every route keeps (see MAX_MODEL_CHARS): the charset, and no email address
/// or phone number once version date stamps are set aside.
fn model_id_ok(model: &str) -> bool {
    let charset = (1..=MAX_MODEL_CHARS).contains(&model.len())
        && model
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:/@+-".contains(&b));
    if !charset {
        return false;
    }
    // Set aside each date stamp, with the "@" a Vertex-style version puts before one.
    let mut rest = String::with_capacity(model.len());
    let bytes = model.as_bytes();
    let mut at = 0;
    while at < bytes.len() {
        let run = bytes[at..]
            .iter()
            .take_while(|b| b.is_ascii_digit())
            .count();
        if run > 0 {
            let digits = &model[at..at + run];
            if !date_stamp(digits) {
                rest.push_str(digits);
            } else if rest.ends_with('@') {
                rest.pop();
            }
            at += run;
        } else {
            rest.push(char::from(bytes[at]));
            at += 1;
        }
    }
    !contact_detail_strict(&rest)
}
/// Words that name model vendors and families rather than anyone. A model id is name-checked
/// without them, so a member called Claude doesn't stop every request to a Claude model.
const MODEL_WORDS: [&str; 34] = [
    "anthropic",
    "claude",
    "haiku",
    "sonnet",
    "opus",
    "openai",
    "gpt",
    "llama",
    "meta",
    "mistral",
    "mixtral",
    "gemini",
    "gemma",
    "google",
    "qwen",
    "deepseek",
    "grok",
    "xai",
    "phi",
    "microsoft",
    "instruct",
    "chat",
    "mini",
    "nano",
    "turbo",
    "preview",
    "latest",
    "vertex",
    "bedrock",
    "amazon",
    "nova",
    "pro",
    "flash",
    "lite",
];
/// No name this session has shown in the model id (it is sent with every request). The two
/// built-in model ids are fixed text and pass; any other is checked word by word, as Ask checks a
/// question, with vendor and family words (MODEL_WORDS) set aside.
pub fn model_free_of_names(model: &str, names: &NameGuard) -> bool {
    // Ozzie's own set-up copies on this Mac ("ozzie-qwen3:8b") are fixed text from providers.json too, so a member
    // called Ozzie never stops them.
    if model == MANAGED_MODEL || model == LOCAL_MODEL || crate::local_models::is_setup_name(model) {
        return true;
    }
    let mut words: Vec<&str> = Vec::new();
    let mut start = None;
    let class = |b: u8| (b.is_ascii_alphabetic(), b.is_ascii_digit());
    let bytes = model.as_bytes();
    for at in 0..=bytes.len() {
        let continues =
            start.is_some_and(|s: usize| at < bytes.len() && class(bytes[s]) == class(bytes[at]));
        if continues {
            continue;
        }
        if let Some(s) = start.take() {
            words.push(&model[s..at]);
        }
        if at < bytes.len() && bytes[at].is_ascii_alphanumeric() {
            start = Some(at);
        }
    }
    let kept: Vec<&str> = words
        .into_iter()
        .filter(|word| !MODEL_WORDS.contains(&word.to_ascii_lowercase().as_str()))
        .collect();
    !names.present_as_word(&kept.join(" "))
}
impl RouteConfig {
    pub fn managed() -> Self {
        Self {
            route: Route::Managed,
            base_url: MANAGED_BASE.into(),
            model: MANAGED_MODEL.into(),
            call_cap: DEFAULT_CALL_CAP,
            agent_steps_per_day: DEFAULT_AGENT_STEPS_PER_DAY,
            month_limit: DEFAULT_MONTH_LIMIT,
            checked_at_ms: None,
        }
    }
    /// The base URL's host (see `host_key`).
    fn host(&self) -> Option<String> {
        url::Url::parse(&self.base_url)
            .ok()
            .as_ref()
            .and_then(host_key)
    }
    /// Keychain account under KEYCHAIN_SERVICE for this route's key: MANAGED_ACCOUNT, or the own
    /// provider's account bound to the base URL's host (OWN_ACCOUNT_PREFIX). A local model needs none.
    pub fn key_account(&self) -> Option<String> {
        match self.route {
            Route::Managed => Some(MANAGED_ACCOUNT.to_owned()),
            Route::Own => self
                .host()
                .map(|host| format!("{OWN_ACCOUNT_PREFIX}{host}")),
            Route::Local => None,
        }
    }
    /// Zero data retention is required on the managed route, and on an own-provider route whose
    /// host is AI Gateway's.
    pub fn zero_retention(&self) -> bool {
        match self.route {
            Route::Managed => true,
            Route::Own => self.host().as_deref() == Some(GATEWAY_HOST),
            Route::Local => false,
        }
    }
    /// Fills route defaults, then applies the URL and model rules.
    pub fn new(
        route: Route,
        base_url: Option<&str>,
        model: Option<&str>,
    ) -> Result<Self, ModelError> {
        let base_url = match (route, base_url) {
            (Route::Managed, None) => MANAGED_BASE,
            (Route::Local, None) => LOCAL_BASE,
            (Route::Own, None) => return Err(ModelError::InvalidRequest),
            (_, Some(base)) => base,
        };
        let model = match (route, model) {
            (Route::Managed, None) => MANAGED_MODEL,
            (Route::Local, None) => LOCAL_MODEL,
            (Route::Own, None) => return Err(ModelError::InvalidRequest),
            (_, Some(model)) => model,
        };
        let config = Self {
            route,
            base_url: base_url.trim_end_matches('/').into(),
            model: model.into(),
            call_cap: DEFAULT_CALL_CAP,
            agent_steps_per_day: DEFAULT_AGENT_STEPS_PER_DAY,
            month_limit: DEFAULT_MONTH_LIMIT,
            checked_at_ms: None,
        };
        config.endpoint().map_err(|_| ModelError::InvalidRequest)?;
        Ok(config)
    }
    /// The one URL a request may go to: `{base}/chat/completions`.
    /// Managed is fixed; own must be https; local must be this Mac's loopback; never Planning
    /// Center or Church Center. The model id keeps `model_id_ok` on every route.
    pub fn endpoint(&self) -> Result<String, ModelError> {
        let refuse = Err(ModelError::NotConfigured);
        let base = self.base_url.as_str();
        let Ok(url) = url::Url::parse(base) else {
            return refuse;
        };
        let Some(host) = host_key(&url) else {
            return refuse;
        };
        let clean = model_id_ok(&self.model)
            && self.call_cap <= 1_000_000
            && self.agent_steps_per_day <= 100_000
            && self.month_limit <= 1_000_000
            && base.len() <= 256
            && !base.ends_with('/')
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
            && url.as_str().trim_end_matches('/') == base;
        // Never Planning Center, whatever the route, trailing dot or not.
        let planning_center = url
            .host_str()
            .is_some_and(|raw| planning_center_host(raw.trim_end_matches('.')));
        let loopback = match url.host() {
            Some(url::Host::Ipv4(ip)) => ip == std::net::Ipv4Addr::LOCALHOST,
            Some(url::Host::Ipv6(ip)) => ip == std::net::Ipv6Addr::LOCALHOST,
            Some(url::Host::Domain(_)) => host.split(':').next() == Some("localhost"),
            None => false,
        };
        let allowed = match self.route {
            Route::Managed => base == MANAGED_BASE,
            Route::Own => url.scheme() == "https",
            Route::Local => matches!(url.scheme(), "http" | "https") && loopback,
        };
        if !clean || planning_center || !allowed {
            return refuse;
        }
        // Claude through Anthropic's own Messages API (anthropic.rs); everything else speaks Chat Completions.
        if crate::own_key::messages_wire(self) {
            return Ok(format!("{base}/messages"));
        }
        Ok(format!("{base}/chat/completions"))
    }
}

/// Read-only key source. A church's own key is written only by own_key.rs (`own_key::KeyStore`), after its
/// check works; keys saved earlier with macOS `security` keep working. hosted.rs writes only Ozzie managed's
/// device token (`hosted::TokenStore`).
pub trait ModelKeys: Send + Sync {
    fn key(&self, account: &str) -> Result<Option<Zeroizing<String>>, StoreError>;
}
/// Keychain items under KEYCHAIN_SERVICE, account `RouteConfig::key_account`, e.g.
/// `security add-generic-password -s church.ozzie.model.v1 -a vercel-ai-gateway -w`, or
/// `-a own-provider:api.example.com` for an own provider at that host.
pub struct KeychainKeys;
#[cfg(target_os = "macos")]
impl ModelKeys for KeychainKeys {
    fn key(&self, account: &str) -> Result<Option<Zeroizing<String>>, StoreError> {
        match security_framework::passwords::get_generic_password(KEYCHAIN_SERVICE, account) {
            Ok(bytes) => {
                let bytes = Zeroizing::new(bytes);
                Ok(std::str::from_utf8(&bytes)
                    .ok()
                    .map(|s| Zeroizing::new(s.to_owned())))
            }
            Err(error) if error.code() == -25300 => Ok(None),
            Err(error) => Err(classify_status(error.code())),
        }
    }
}
fn usable_key(key: &str) -> bool {
    (1..=4096).contains(&key.len()) && key.bytes().all(|b| b.is_ascii_graphic())
}
/// The route's key, read from its own account only: an own-provider key saved for another host,
/// or under the old unbound account, is never read here.
fn key_for(
    config: &RouteConfig,
    keys: &dyn ModelKeys,
) -> Result<Option<Zeroizing<String>>, ModelError> {
    if config.route == Route::Local {
        return Ok(None);
    }
    // The owner's AI Gateway key is for development only: a release build never reads it.
    if config.route == Route::Managed && !cfg!(debug_assertions) {
        return Err(ModelError::NotConfigured);
    }
    let account = config.key_account().ok_or(ModelError::NotConfigured)?;
    match keys.key(&account) {
        Ok(Some(key)) if usable_key(&key) => Ok(Some(key)),
        _ => Err(ModelError::NotConfigured),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DraftRequest {
    pub system: String,
    pub user: String,
    pub max_tokens: u32,
}
/// Model reply text and reported usage. Not Debug: replies are not logged.
pub struct Reply {
    pub text: String,
    pub prompt_tokens: Option<u64>,
    pub completion_tokens: Option<u64>,
}
/// The exact Chat Completions body. Managed requests always require zero data retention.
pub fn request_body(config: &RouteConfig, request: &DraftRequest) -> Result<Value, ModelError> {
    let system = request.system.chars().count();
    let user = request.user.chars().count();
    if system > MAX_SYSTEM_CHARS || user == 0 || user > MAX_USER_CHARS || request.max_tokens == 0 {
        return Err(ModelError::InvalidRequest);
    }
    let mut body = json!({
        "model": config.model,
        "messages": [
            {"role": "system", "content": request.system},
            {"role": "user", "content": request.user},
        ],
        "max_tokens": request.max_tokens.min(MAX_TOKENS),
        "temperature": 0.4,
    });
    if config.zero_retention() {
        body["providerOptions"] = json!({"gateway": {"zeroDataRetention": true}});
    }
    if config.route == Route::Managed {
        // A one-note reword needs no hidden reasoning; adaptive thinking can spend the whole
        // token budget and return empty text (observed live with claude-haiku-5.5).
        body["reasoning"] = json!({"enabled": false});
    }
    // The church's own key at a company Ozzie knows: that company's request rules (providers.json).
    crate::own_key::shape(config, &mut body);
    Ok(body)
}

/// Every `[`…`]` in the text is one of the three labels, with no stray brackets.
fn labels_only(text: &str) -> bool {
    let mut rest = text;
    while let Some(at) = rest.find(['[', ']']) {
        rest = &rest[at..];
        let Some(label) = LABELS.iter().find(|label| rest.starts_with(**label)) else {
            return false;
        };
        rest = &rest[label.len()..];
    }
    true
}
/// Every label occurrence stands alone: no letter or number touches it on either side, so a
/// label cannot glue a name back together ("Ri[Role]ley").
/// A label may only touch whitespace or the text's edges, an opening quote/bracket before it,
/// or sentence punctuation after it that is itself followed by whitespace or the end. Nothing
/// may join a label's own letters to neighbouring letters (e.g. "[Role]-y").
fn labels_standalone(text: &str) -> bool {
    LABELS.iter().all(|label| {
        text.match_indices(label).all(|(at, _)| {
            let before = text[..at].chars().next_back();
            let mut after = text[at + label.len()..].chars();
            let before_ok =
                before.is_none_or(|c| c.is_whitespace() || "(\"'\u{201c}\u{2018}".contains(c));
            // Skip a run of closing punctuation; whatever follows must be whitespace or the end.
            let closing = ",.!?:;)\"'\u{201d}\u{2019}";
            let after_ok = after
                .find(|c| !closing.contains(*c))
                .is_none_or(char::is_whitespace);
            before_ok && after_ok
        })
    })
}
/// A character a note may not hold: the question rule's (`not_in_a_question`, `invisible`) apart from
/// a line break, and apart from the joiners an emoji is spelled with: a variation selector after a
/// pictograph, a digit, `#` or `*` (a keycap), and a zero-width joiner between pictographs (an emoji
/// sequence; a skin-tone modifier or a variation selector may come first). The background-check
/// list's newer characters count as hidden too (review B3 L-1). Mirrored by ozzie.church (web
/// requests.ts `hiddenInNote`) and the page (core/src/draft-request.ts `hiddenInNote`).
pub(crate) fn hidden_in_note(note: &str) -> bool {
    use icu_properties::{CodePointSetData, props::ExtendedPictographic};
    let pictographs = CodePointSetData::new::<ExtendedPictographic>();
    let pictograph = |c: Option<char>| {
        c.is_some_and(|c| pictographs.contains(c) || ('\u{1f3fb}'..='\u{1f3ff}').contains(&c))
    };
    let chars: Vec<char> = note.chars().collect();
    chars.iter().enumerate().any(|(at, &c)| {
        let before = at.checked_sub(1).map(|i| chars[i]);
        let after = chars.get(at + 1).copied();
        let joiner = match c {
            '\u{fe0e}' | '\u{fe0f}' => {
                pictograph(before)
                    || before.is_some_and(|b| b.is_ascii_digit() || b == '#' || b == '*')
            }
            '\u{200d}' => (pictograph(before) || before == Some('\u{fe0f}')) && pictograph(after),
            _ => false,
        };
        c != '\n'
            && !joiner
            && (not_in_a_question(c)
                || crate::name_guard::invisible(c)
                || crate::background::newer(c))
    })
}
/// Native defense in depth behind the webview's placeholder boundary: the exact request
/// shape the app produces, no background-check wording and no hidden character in the note, and no
/// name this session has shown.
pub fn check_draft(request: &DraftRequest, names: &NameGuard) -> Result<(), ModelError> {
    if request.system != SYSTEM {
        return Err(ModelError::InvalidRequest);
    }
    let note = REWORDINGS
        .iter()
        .find_map(|choice| {
            request
                .user
                .strip_prefix(choice)
                .and_then(|rest| rest.strip_prefix(NOTE_PREFIX))
        })
        .ok_or(ModelError::InvalidRequest)?;
    // The system text and the choice are pinned above; the note is what varies (a position name
    // can carry anything a church typed into Planning Center).
    if background_wording(note) {
        return Err(ModelError::BackgroundCheck);
    }
    // Compatibility forms (fullwidth brackets and the like) count as brackets too, so every
    // structural and name check runs on both the raw text and its NFKC form.
    let compat = icu_normalizer::ComposingNormalizerBorrowed::new_nfkc().normalize(&request.user);
    let compat_note = icu_normalizer::ComposingNormalizerBorrowed::new_nfkc().normalize(note);
    if !note.contains("[Volunteer A]")
        || !labels_only(&request.user)
        || !labels_only(&compat)
        || !labels_standalone(&request.user)
        || !labels_standalone(&compat)
    {
        return Err(ModelError::InvalidRequest);
    }
    // The system text and choice are fixed above, so only the note can carry a name. Labels must
    // be standalone (checked above), so check the note with labels removed outright and with
    // labels replaced by spaces, in raw and NFKC form. Checking it with labels kept adds no
    // catches and would refuse names inside label words (Nam in "[Your name]", Olu in "[Volunteer A]").
    let without = |text: &str, with: &str| {
        LABELS
            .iter()
            .fold(text.to_owned(), |text, label| text.replace(label, with))
    };
    if [
        without(note, ""),
        without(note, " "),
        without(&compat_note, ""),
        without(&compat_note, " "),
    ]
    .iter()
    .any(|text| names.present(text))
    {
        return Err(ModelError::NamePresent);
    }
    // No phone number or email address either (review M5): agent steps refuse them natively and the page takes them
    // out, but rewording now reaches outside companies with a church's own key, so the backstop holds here too. Raw
    // and NFKC, so fullwidth digits count.
    if [note, compat_note.as_ref()]
        .iter()
        .any(|text| contact_detail_strict(text))
    {
        return Err(ModelError::ContactDetail);
    }
    // No hidden character either, as a question may hold none (review B2 M-1); after the name check,
    // so a name split by an invisible character is still refused as a name. The page sends a position
    // name holding one as [Role], so only something else could put one here.
    if hidden_in_note(note) {
        return Err(ModelError::HiddenCharacter);
    }
    Ok(())
}

/// The longest question Ask takes (agent.rs `question_ok`; ozzie.church's hosted limits mirror it).
pub const MAX_ASK_QUESTION_CHARS: usize = 600;

// Ask labels, for agent.rs: a label stands alone, and labels are stripped before names are looked for.
/// As `labels_standalone`, plus a possessive 's after a label ("[Person 1]'s role").
pub(crate) fn ask_labels_standalone(text: &str, labels: &[(usize, usize)]) -> bool {
    labels.iter().all(|&(start, end)| {
        let before = text[..start].chars().next_back();
        let before_ok =
            before.is_none_or(|c| c.is_whitespace() || "(\"'\u{201c}\u{2018}".contains(c));
        let rest = &text[end..];
        let rest = rest
            .strip_prefix("'s")
            .or_else(|| rest.strip_prefix("\u{2019}s"))
            .unwrap_or(rest);
        let closing = ",.!?:;)\"'\u{201d}\u{2019}";
        let after_ok = rest
            .chars()
            .find(|c| !closing.contains(*c))
            .is_none_or(char::is_whitespace);
        before_ok && after_ok
    })
}
/// `labels` are sorted, non-overlapping byte ranges; agent.rs strips its own label ranges with it.
pub(crate) fn strip_ask_labels(text: &str, labels: &[(usize, usize)], with: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    for &(start, end) in labels {
        out.push_str(&text[last..start]);
        out.push_str(with);
        last = end;
    }
    out.push_str(&text[last..]);
    out
}

// Contact details (coordinator decision 2026-11-13). Mirrors `hasContactDetail` in
// core/src/ask.ts; both run the vectors in core/test/ask-parity.json.
fn space(c: char) -> bool {
    matches!(
        c,
        ' ' | '\t' | '\u{a0}' | '\u{2000}'..='\u{200a}' | '\u{202f}' | '\u{205f}' | '\u{3000}'
    )
}
/// "x@y" with letters or numbers on both sides ("pat@church"), or, with up to three spaces
/// around the @, a letter or number before it and a dotted domain after it ("pat @ example.org").
/// The ideographic and fullwidth full stops count as dots.
fn email_at(chars: &[char], at: usize) -> bool {
    use crate::name_guard::letter_or_number;
    let word = |c: Option<&char>| c.is_some_and(|&c| letter_or_number(c));
    let before = at.checked_sub(1).and_then(|i| chars.get(i));
    if (word(before) || before.is_some_and(|c| "._%+-".contains(*c))) && word(chars.get(at + 1)) {
        return true;
    }
    let mut left = at;
    while left > 0 && at - left < 3 && space(chars[left - 1]) {
        left -= 1;
    }
    let mut right = at + 1;
    while right < chars.len() && right - at <= 3 && space(chars[right]) {
        right += 1;
    }
    if (left == at && right == at + 1) || left == 0 || !letter_or_number(chars[left - 1]) {
        return false;
    }
    let mut domain = right;
    while domain < chars.len() && (letter_or_number(chars[domain]) || chars[domain] == '-') {
        domain += 1;
    }
    domain > right
        && chars
            .get(domain)
            .is_some_and(|c| matches!(c, '.' | '\u{3002}' | '\u{ff0e}' | '\u{ff61}'))
        && word(chars.get(domain + 1))
}
/// A run of digits and the characters between it and the next run.
struct DigitGroup {
    digits: usize,
    gap: String,
}
/// `min_digits` or more digits once dates (2026-11-22, 11/22/2026) and times (9:30, 10:30-11:30,
/// 9.30) are set aside. A dotted time only counts when the dots don't run on, so "06.12.34.56.78"
/// is a phone.
fn phone_like(groups: &[DigitGroup], min_digits: usize) -> bool {
    let date_separator = |gap: &str| {
        let mut chars = gap.chars();
        matches!(
            (chars.next(), chars.next()),
            (
                Some('-' | '/' | '.' | '\u{2010}'..='\u{2015}' | '\u{2212}'),
                None
            )
        )
    };
    let mut total = 0;
    let mut i = 0;
    while i < groups.len() {
        let a = &groups[i];
        let (b, c) = (groups.get(i + 1), groups.get(i + 2));
        let date = match (b, c) {
            (Some(b), Some(c)) => {
                a.gap == b.gap
                    && date_separator(&a.gap)
                    && ((a.digits == 4 && b.digits <= 2 && c.digits <= 2)
                        || (a.digits <= 2 && b.digits <= 2 && c.digits == 4))
            }
            _ => false,
        };
        let time = b.is_some_and(|b| {
            a.digits <= 2
                && b.digits == 2
                && (a.gap == ":"
                    || (a.gap == "." && (i == 0 || groups[i - 1].gap != ".") && b.gap != "."))
        });
        if date || time {
            if total >= min_digits {
                return true;
            }
            total = 0;
            i += if date { 3 } else { 2 };
            continue;
        }
        total += a.digits;
        i += 1;
    }
    total >= min_digits
}
/// An email address, or 7+ digits (any decimal digits) whose groups are separated by one to
/// three of anything but letters, numbers and line breaks.
pub fn contact_detail(text: &str) -> bool {
    let chars: Vec<char> = text.chars().collect();
    (0..chars.len()).any(|at| chars[at] == '@' && email_at(&chars, at))
        || digit_contact(&chars, 3, 7)
}
/// `contact_detail`, and the disguises it leaves to the closed grammars (native only so far; see
/// `pendingNative` in core/test/ask-parity.json): an email address written out ("pat [at]
/// example [dot] org", "pat (at) example.org", "pat at example dot org"), and 10+ digits whose
/// groups are separated by up to eight of anything but letters, numbers and line breaks
/// ("555----123----4567"). Ask's question and every agent step use it.
pub fn contact_detail_strict(text: &str) -> bool {
    let chars: Vec<char> = text.chars().collect();
    contact_detail(text) || spelled_email(&chars) || digit_contact(&chars, 8, 10)
}
/// Word, at, word, then one or more dot-word pairs ending in a 2-24 letter top-level domain, where
/// "at" is "@", "[at]", "(at)", "{at}", "<at>" or the word "at", and "dot" is a "." with no space
/// on either side, "[dot]" and the like, or the word "dot". Spaces may surround a written-out at
/// or dot, never a bare ".", so "Ask Pat at noon. Then" is not an address.
fn spelled_email(chars: &[char]) -> bool {
    use crate::name_guard::letter_or_number;
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum T {
        Word(usize, usize),
        At,
        Dot,
        TightDot,
        Space,
        Other,
    }
    let lower: Vec<char> = chars.iter().map(|c| c.to_ascii_lowercase()).collect();
    let word = |c: char| letter_or_number(c) || "_%+-".contains(c);
    // "[at]", "(dot)" and the like at `i`: the token and its length.
    let bracketed = |i: usize| {
        let close = match lower[i] {
            '[' => ']',
            '(' => ')',
            '{' => '}',
            '<' => '>',
            _ => return None,
        };
        [("at", T::At), ("dot", T::Dot)]
            .into_iter()
            .find_map(|(inner, token)| {
                let end = i + 1 + inner.len();
                let fits = lower.get(i + 1..end)?.iter().copied().eq(inner.chars())
                    && lower.get(end) == Some(&close);
                fits.then_some((token, inner.len() + 2))
            })
    };
    let mut tokens: Vec<T> = Vec::new();
    let mut i = 0;
    while i < lower.len() {
        let c = lower[i];
        if word(c) {
            let start = i;
            while i < lower.len() && word(lower[i]) {
                i += 1;
            }
            tokens.push(T::Word(start, i));
            continue;
        }
        if let Some((token, len)) = bracketed(i) {
            tokens.push(token);
            i += len;
            continue;
        }
        let token = match c {
            '@' | '\u{ff20}' => T::At,
            '.' | '\u{3002}' | '\u{ff0e}' | '\u{ff61}' => T::TightDot,
            c if c.is_whitespace() => T::Space,
            _ => T::Other,
        };
        // A run of spaces is one space.
        if !(token == T::Space && tokens.last() == Some(&T::Space)) {
            tokens.push(token);
        }
        i += 1;
    }
    // The words "at" and "dot" between spaces; a bare "." only with no space on either side.
    let text_of = |(a, b): (usize, usize)| lower[a..b].iter().collect::<String>();
    let n = tokens.len();
    let mut joined: Vec<T> = Vec::with_capacity(n);
    for k in 0..n {
        let spaced = k > 0 && k + 1 < n && tokens[k - 1] == T::Space && tokens[k + 1] == T::Space;
        joined.push(match tokens[k] {
            T::Word(a, b) if spaced && text_of((a, b)) == "at" => T::At,
            T::Word(a, b) if spaced && text_of((a, b)) == "dot" => T::Dot,
            T::TightDot => {
                let tight = k > 0
                    && k + 1 < n
                    && matches!(tokens[k - 1], T::Word(..))
                    && matches!(tokens[k + 1], T::Word(..));
                if tight { T::Dot } else { T::Other }
            }
            token => token,
        });
    }
    // Spaces only ever sit beside an at or a dot here; drop them there, keep them elsewhere.
    let mut flat: Vec<T> = Vec::with_capacity(n);
    for (k, token) in joined.iter().enumerate() {
        let beside = |t: Option<&T>| matches!(t, Some(T::At | T::Dot));
        if *token == T::Space && (beside(joined.get(k + 1)) || beside(flat.last())) {
            continue;
        }
        flat.push(*token);
    }
    (0..flat.len()).any(|k| {
        let [T::Word(..), T::At, T::Word(..), rest @ ..] = &flat[k..] else {
            return false;
        };
        let mut last = None;
        for pair in rest.chunks(2) {
            match pair {
                [T::Dot, T::Word(a, b)] => last = Some((*a, *b)),
                _ => break,
            }
        }
        last.is_some_and(|(a, b)| {
            (2..=24).contains(&(b - a)) && lower[a..b].iter().all(|c| c.is_alphabetic())
        })
    })
}
/// `min_digits` or more decimal digits (any script) whose groups are separated by one to
/// `max_gap` of anything but letters, numbers and line breaks, dates and times set aside.
fn digit_contact(chars: &[char], max_gap: usize, min_digits: usize) -> bool {
    use crate::name_guard::{decimal_digit, letter_or_number, line_break};
    let mut groups: Vec<DigitGroup> = Vec::new();
    let (mut digits, mut gap) = (0usize, String::new());
    for c in chars.iter().copied().chain(std::iter::once('\n')) {
        if decimal_digit(c) {
            if digits == 0
                && let Some(last) = groups.last_mut()
            {
                last.gap = std::mem::take(&mut gap);
            }
            digits += 1;
            gap.clear();
            continue;
        }
        if digits > 0 {
            groups.push(DigitGroup {
                digits,
                gap: String::new(),
            });
            digits = 0;
        }
        if groups.is_empty() {
            continue;
        }
        if !letter_or_number(c) && !line_break(c) && gap.chars().count() < max_gap {
            gap.push(c);
        } else {
            if phone_like(&groups, min_digits) {
                return true;
            }
            groups.clear();
            gap.clear();
        }
    }
    false
}

/// Line breaks of every kind (U+2028, U+2029 and U+0085 included), controls, format and
/// private-use characters. The webview turns them into spaces or removes them, so a question
/// carrying one did not come from it; a line separator could otherwise start a forged fact line
/// for any reader that splits on it. agent.rs refuses the same set apart from `\n` and `\t`.
pub(crate) fn not_in_a_question(c: char) -> bool {
    use icu_properties::props::GeneralCategory::{
        Control, Format, LineSeparator, ParagraphSeparator, PrivateUse, Surrogate,
    };
    crate::name_guard::line_break(c)
        || matches!(
            crate::name_guard::category(c),
            Control | Format | PrivateUse | Surrogate | LineSeparator | ParagraphSeparator
        )
}

// Usage ledger: calls are reserved before any request, so failures and timeouts still count.
#[derive(Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct Usage {
    calls: u64,
    prompt_tokens: u64,
    completion_tokens: u64,
    /// The UTC day (days since 1970-01-01) `agent_steps` counts, and the agent steps that day.
    agent_day: u64,
    agent_steps: u64,
    /// The own-key route only: the UTC month `month_calls` counts (`civil::month_of_day`), and the calls in it.
    #[serde(skip_serializing_if = "is_zero")]
    month: u64,
    #[serde(skip_serializing_if = "is_zero")]
    month_calls: u64,
}
fn is_zero(n: &u64) -> bool {
    *n == 0
}
/// What one call reserves in the usage file before it is sent, on its UTC day.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Spend {
    /// Rewording: one call against the route's cap or monthly limit.
    Call { day: u64 },
    /// An agent step: one call, and one of the route's agent steps for this UTC day.
    AgentStep { day: u64 },
}
impl Spend {
    fn day(self) -> u64 {
        match self {
            Self::Call { day } | Self::AgentStep { day } => day,
        }
    }
}
/// Days since 1970-01-01, UTC.
pub(crate) fn utc_day(unix_ms: u64) -> u64 {
    unix_ms / DAY_MS
}
/// One call's spend against the route's usage: refused when a cap is spent. The church's own key has a UTC
/// monthly limit (`month_limit`, onboarding spec S8; it replaced the lifetime call cap there, which stopped a
/// church's AI for good after a few dozen questions). The lifetime `call_cap` stays only on the managed route's
/// direct path (debug builds, the owner's key). Through ozzie.church (`hosted`) neither applies: the account's
/// monthly allowance and its honest pause are the limit there (owner, 2026-10-26 / 2026-11-14). The daily
/// agent-step cap applies everywhere.
fn spend_on(
    config: &RouteConfig,
    ledger: &mut Ledger,
    spend: Spend,
    hosted: bool,
) -> Result<(), ModelError> {
    let route = config.route;
    let usage = ledger.usage(route);
    if route == Route::Managed && !hosted && usage.calls >= config.call_cap {
        return Err(ModelError::Budget);
    }
    let monthly = route == Route::Own && !hosted;
    if monthly {
        // A clock that steps back keeps counting the later month rather than starting afresh.
        let month = crate::civil::month_of_day(spend.day());
        if month > usage.month {
            usage.month = month;
            usage.month_calls = 0;
        }
        if usage.month_calls >= config.month_limit {
            return Err(ModelError::MonthLimit);
        }
    }
    if let Spend::AgentStep { day } = spend {
        // A clock that steps back keeps counting the later day rather than starting afresh.
        if day > usage.agent_day {
            usage.agent_day = day;
            usage.agent_steps = 0;
        }
        if usage.agent_steps >= config.agent_steps_per_day {
            return Err(ModelError::DailyLimit);
        }
        usage.agent_steps += 1;
    }
    usage.calls += 1;
    if monthly {
        usage.month_calls += 1;
    }
    Ok(())
}
fn reserve(
    config: &RouteConfig,
    ledger: &Path,
    spend: Spend,
    hosted: bool,
) -> Result<(), ModelError> {
    update_ledger(ledger, |ledger| spend_on(config, ledger, spend, hosted))
}
/// Whether `reserve` would succeed now, without spending anything.
fn affordable(
    config: &RouteConfig,
    ledger: &Path,
    spend: Spend,
    hosted: bool,
) -> Result<(), ModelError> {
    let _lock = LEDGER.lock().unwrap_or_else(|e| e.into_inner());
    let mut ledger = read_ledger(ledger)?;
    spend_on(config, &mut ledger, spend, hosted)
}
#[derive(Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct Ledger {
    managed: Usage,
    own: Usage,
    local: Usage,
}
impl Ledger {
    fn usage(&mut self, route: Route) -> &mut Usage {
        match route {
            Route::Managed => &mut self.managed,
            Route::Own => &mut self.own,
            Route::Local => &mut self.local,
        }
    }
}
static LEDGER: Mutex<()> = Mutex::new(());
pub(crate) fn read_small(path: &Path) -> io::Result<Option<Vec<u8>>> {
    let file = match std::fs::File::open(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        result => result?,
    };
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(io::ErrorKind::InvalidData.into());
    }
    Ok(Some(bytes))
}
/// Private file in a private folder, replaced atomically.
pub(crate) fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let dir = path.parent().ok_or(io::ErrorKind::InvalidInput)?;
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(dir)?;
    let name = path.file_name().ok_or(io::ErrorKind::InvalidInput)?;
    let partial = dir.join(format!(".{}.partial", name.to_string_lossy()));
    let _ = std::fs::remove_file(&partial);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let written = options.open(&partial).and_then(|mut file| {
        file.write_all(bytes)?;
        file.sync_all()
    });
    if let Err(error) = written.and_then(|()| std::fs::rename(&partial, path)) {
        let _ = std::fs::remove_file(&partial);
        return Err(error);
    }
    Ok(())
}
/// The usage file. An unreadable one cannot prove the cap holds: refuse rather than reset it.
fn read_ledger(path: &Path) -> Result<Ledger, ModelError> {
    match read_small(path) {
        Ok(None) => Ok(Ledger::default()),
        Ok(Some(bytes)) => serde_json::from_slice(&bytes).map_err(|_| ModelError::Budget),
        Err(_) => Err(ModelError::Budget),
    }
}
fn update_ledger(
    path: &Path,
    change: impl FnOnce(&mut Ledger) -> Result<(), ModelError>,
) -> Result<(), ModelError> {
    let _lock = LEDGER.lock().unwrap_or_else(|e| e.into_inner());
    let mut ledger = read_ledger(path)?;
    change(&mut ledger)?;
    let bytes = serde_json::to_vec(&ledger).map_err(|_| ModelError::Budget)?;
    write_private(path, &bytes).map_err(|_| ModelError::Budget)
}

/// How a request's key travels, decided with the route's wire (`own_key::key_header`), never guessed from the request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyHeader {
    /// `Authorization: Bearer`: every route but Anthropic's own Messages API, and Ozzie managed's device token.
    Bearer,
    /// Anthropic's own `x-api-key` header for a Console key, whatever its kind (`sk-ant-api`, `sk-ant-usr`,
    /// `sk-ant-svc`): a bearer token is how Anthropic's sign-in tokens arrive, so a key is never sent that way (owner's
    /// live test, 2026-11-18).
    XApiKey,
}

// Separate client from every Planning Center client: its own builder, no shared state.
pub trait ModelHttp {
    /// One POST. `key`: the key and the header it travels in.
    fn post(
        &self,
        url: &str,
        key: Option<(&str, KeyHeader)>,
        headers: &[(&str, &str)],
        body: &[u8],
    ) -> Result<(u16, Zeroizing<Vec<u8>>), ModelError>;
    /// A GET with the key as a bearer token: only Ozzie managed's account status (hosted.rs) uses it.
    fn get(&self, url: &str, key: Option<&str>) -> Result<(u16, Zeroizing<Vec<u8>>), ModelError> {
        let _ = (url, key);
        Err(ModelError::ProviderFailure)
    }
}
/// How long one request on the route waits for its whole answer. A model on this Mac gets the check's first-question
/// wait: an Ask's first step reads a new question there, which took up to 47 seconds for ~3,800 tokens on a 16 GB Mac
/// (qwen3:8b, thinking off, 2026-11-18), well past the 45 seconds an AI company is given. That is the most one call
/// waits there, a second try without the thinking setting included (`NativeModelHttp`'s deadline); an Ask's step
/// waits no longer than its task has left (`agent::agent_step`, review M4).
pub fn request_wait(route: Route) -> Duration {
    match route {
        Route::Local => crate::local_ai::ANSWER_WAIT,
        Route::Managed | Route::Own => Duration::from_secs(45),
    }
}
pub struct NativeModelHttp {
    client: reqwest::blocking::Client,
    /// When every request through this client gives up, and after which none is sent: a model on this Mac's one
    /// call (and its task's time left), so asking again without the thinking setting never gets a wait of its own.
    until: Option<Instant>,
}
impl NativeModelHttp {
    pub(crate) fn new(route: Route) -> Result<Self, ModelError> {
        // Plain http is only ever reachable for a validated loopback local model.
        let client = Self::build(route != Route::Local, request_wait(route))?;
        Ok(if route == Route::Local {
            client.within(request_wait(route))
        } else {
            client
        })
    }
    /// The same client, giving up `left` from now at the latest, for every request through it together.
    pub(crate) fn within(mut self, left: Duration) -> Self {
        let end = Instant::now() + left;
        self.until = Some(self.until.map_or(end, |until| until.min(end)));
        self
    }
    /// The client for a request on `config`'s route: the managed route's may reach a debug build's 127.0.0.1
    /// server for Ozzie managed (`HostedConfig::https_only`); every other route's is `new`'s. A model on this Mac gets
    /// one only once its app says, now, that the model runs on this Mac (`local_ai::confirm_route`): every question on
    /// that route (rewording, Ask, a job's step) comes through here, so one pointed elsewhere since it was checked is
    /// never asked (`not-on-this-mac`).
    pub(crate) fn for_route(config: &RouteConfig, hosted: &HostedConfig) -> Result<Self, ModelError> {
        Self::for_route_after(config, hosted, &*this_mac_for(config)?)
    }
    /// `for_route`, asking `local` whether a model on this Mac runs here.
    pub(crate) fn for_route_after(
        config: &RouteConfig,
        hosted: &HostedConfig,
        local: &dyn crate::local_ai::LocalHttp,
    ) -> Result<Self, ModelError> {
        crate::local_ai::confirm_route(config, local)?;
        if config.route == Route::Managed {
            Self::build(hosted.https_only(), request_wait(config.route))
        } else {
            Self::new(config.route)
        }
    }
    /// One own-key check (own_key.rs): https only, and a shorter wait than a real answer's.
    pub fn key_check() -> Result<Self, ModelError> {
        Self::build(true, crate::own_key::CHECK_TIMEOUT)
    }
    /// Ozzie managed's connect, account and revoke requests.
    pub(crate) fn hosted(hosted: &HostedConfig, timeout: Duration) -> Result<Self, ModelError> {
        Self::build(hosted.https_only(), timeout)
    }
    fn build(https_only: bool, timeout: Duration) -> Result<Self, ModelError> {
        Ok(Self {
            client: reqwest::blocking::Client::builder()
                .https_only(https_only)
                .no_proxy()
                .retry(reqwest::retry::never())
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(5))
                .timeout(timeout)
                .user_agent("Ozzie (https://ozzie.church)")
                .build()
                .map_err(|_| ModelError::ProviderFailure)?,
            until: None,
        })
    }
    fn read(
        response: reqwest::blocking::Response,
    ) -> Result<(u16, Zeroizing<Vec<u8>>), ModelError> {
        let status = response.status().as_u16();
        let mut bytes = Zeroizing::new(Vec::new());
        response
            .take(MAX_RESPONSE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| ModelError::ProviderFailure)?;
        if bytes.len() as u64 > MAX_RESPONSE_BYTES {
            return Err(ModelError::ProviderFailure);
        }
        Ok((status, bytes))
    }
}
impl ModelHttp for NativeModelHttp {
    fn post(
        &self,
        url: &str,
        key: Option<(&str, KeyHeader)>,
        headers: &[(&str, &str)],
        body: &[u8],
    ) -> Result<(u16, Zeroizing<Vec<u8>>), ModelError> {
        let mut request = self
            .client
            .post(url)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json")
            .body(body.to_vec());
        // Past the deadline nothing is sent; before it, the request waits only for what is left.
        if let Some(until) = self.until {
            let left = until.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(ModelError::ProviderFailure);
            }
            request = request.timeout(left);
        }
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        match key {
            Some((key, KeyHeader::XApiKey)) => {
                let mut value = reqwest::header::HeaderValue::from_str(key)
                    .map_err(|_| ModelError::ProviderFailure)?;
                value.set_sensitive(true);
                request = request.header(crate::anthropic::KEY_HEADER, value);
            }
            Some((key, KeyHeader::Bearer)) => request = request.bearer_auth(key),
            None => {}
        }
        let response = request.send().map_err(|_| ModelError::ProviderFailure)?;
        Self::read(response)
    }
    fn get(&self, url: &str, key: Option<&str>) -> Result<(u16, Zeroizing<Vec<u8>>), ModelError> {
        let mut request = self.client.get(url).header("Accept", "application/json");
        if let Some(key) = key {
            request = request.bearer_auth(key);
        }
        let response = request.send().map_err(|_| ModelError::ProviderFailure)?;
        Self::read(response)
    }
}

/// Where one request on the configured route goes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Target {
    /// `RouteConfig::endpoint` with the route's key: an own provider, a local model, and (debug
    /// builds only, when this Mac has no device token) the managed route straight to AI Gateway.
    Direct(String),
    /// Ozzie managed through ozzie.church with this Mac's device token: the base URL.
    Hosted(String),
}
/// The managed route goes through ozzie.church whenever a device token is saved. Without one, a
/// debug build falls back to the direct gateway path and a release build is `not-configured`. Reads
/// the Keychain for the token's presence, so callers run their request checks first.
pub(crate) fn target(
    config: &RouteConfig,
    keys: &dyn ModelKeys,
    hosted: &HostedConfig,
) -> Result<Target, ModelError> {
    let direct = config.endpoint()?;
    if config.route != Route::Managed {
        return Ok(Target::Direct(direct));
    }
    if hosted::connected(keys) {
        return Ok(Target::Hosted(hosted.base.clone()));
    }
    if hosted.debug {
        Ok(Target::Direct(direct))
    } else {
        Err(ModelError::NotConfigured)
    }
}
/// The reword body ozzie.church takes: the exact checked request, its token limit capped as the
/// direct body caps it. The server writes the Chat Completions request (zero data retention).
fn hosted_reword_body(request: &DraftRequest) -> Result<Vec<u8>, ModelError> {
    serde_json::to_vec(&json!({
        "system": request.system,
        "user": request.user,
        "max_tokens": request.max_tokens.min(MAX_TOKENS),
    }))
    .map_err(|_| ModelError::InvalidRequest)
}

/// The model id goes out with every request: no name this session has shown in it.
pub(crate) fn check_model(config: &RouteConfig, names: &NameGuard) -> Result<(), ModelError> {
    if model_free_of_names(&config.model, names) {
        Ok(())
    } else {
        Err(ModelError::NamePresent)
    }
}

/// Rewords one placeholder-only draft through the configured route.
pub fn reword(
    config: &RouteConfig,
    ledger: &Path,
    request: &DraftRequest,
    keys: &dyn ModelKeys,
    names: &NameGuard,
) -> Result<Reply, ModelError> {
    // Everything that can refuse without a client does so first.
    let hosted = HostedConfig::current();
    config.endpoint()?;
    request_body(config, request)?;
    check_draft(request, names)?;
    check_model(config, names)?;
    let http = NativeModelHttp::for_route(config, &hosted)?;
    reword_with(config, ledger, request, keys, names, &http, &hosted)
}
/// What asks the app on this Mac whether `config`'s model runs here (`local_ai::confirm_route`): the real client, to
/// 127.0.0.1 only, for a model on this Mac; nothing for any other route, which is never asked.
pub(crate) fn this_mac_for(
    config: &RouteConfig,
) -> Result<Box<dyn crate::local_ai::LocalHttp>, ModelError> {
    Ok(if config.route == Route::Local {
        Box::new(crate::local_ai::NativeLocalHttp::new(crate::local_ai::SHOW_WAIT)?)
    } else {
        Box::new(crate::local_ai::NoLocalHttp)
    })
}
/// When every request through a client gives up, if it does (agent_tests.rs).
#[cfg(test)]
impl NativeModelHttp {
    pub(crate) fn deadline(&self) -> Option<Instant> {
        self.until
    }
}
/// The current build's `HostedConfig`; tests choose one with the `_with` form.
#[cfg(test)]
pub(crate) fn reword_using(
    config: &RouteConfig,
    ledger: &Path,
    request: &DraftRequest,
    keys: &dyn ModelKeys,
    names: &NameGuard,
    http: &dyn ModelHttp,
) -> Result<Reply, ModelError> {
    reword_with(
        config,
        ledger,
        request,
        keys,
        names,
        http,
        &HostedConfig::current(),
    )
}
pub(crate) fn reword_with(
    config: &RouteConfig,
    ledger: &Path,
    request: &DraftRequest,
    keys: &dyn ModelKeys,
    names: &NameGuard,
    http: &dyn ModelHttp,
    hosted: &HostedConfig,
) -> Result<Reply, ModelError> {
    config.endpoint()?;
    let direct = serde_json::to_vec(&request_body(config, request)?)
        .map_err(|_| ModelError::InvalidRequest)?;
    // Before any key, budget or network: the exact shape, and no remembered name.
    check_draft(request, names)?;
    check_model(config, names)?;
    let (url, body, through) = match target(config, keys, hosted)? {
        Target::Direct(url) => (url, direct, false),
        Target::Hosted(base) => (
            format!("{base}{}", hosted::REWORD_PATH),
            hosted_reword_body(request)?,
            true,
        ),
    };
    complete_using(
        config,
        ledger,
        &url,
        &body,
        MANAGED_TAGS,
        keys,
        http,
        through,
    )
}

/// Rewording: one exchange, then the reply text and its token counts. `hosted`: the request
/// goes to ozzie.church (`Exchange::hosted`).
#[allow(clippy::too_many_arguments)]
fn complete_using(
    config: &RouteConfig,
    ledger: &Path,
    url: &str,
    body: &[u8],
    tags: (&str, &str),
    keys: &dyn ModelKeys,
    http: &dyn ModelHttp,
    hosted: bool,
) -> Result<Reply, ModelError> {
    let exchange = Exchange {
        config,
        usage: ledger,
        url,
        body,
        tags,
        keys,
        http,
        hosted,
    };
    let day = utc_day(crate::sunday_check::unix_ms());
    let value = exchange.send(Spend::Call { day }, || Ok::<(), ModelError>(()))?;
    let text = value["choices"][0]["message"]["content"]
        .as_str()
        .filter(|text| {
            let chars = text.chars().count();
            chars > 0 && chars <= MAX_REPLY_CHARS
        })
        .ok_or(ModelError::ProviderFailure)?;
    let (prompt_tokens, completion_tokens) = record_tokens(ledger, config.route, &value);
    Ok(Reply {
        text: text.to_owned(),
        prompt_tokens,
        completion_tokens,
    })
}

/// One checked request on its way to the route: key, call cap, one POST and the closed reason codes,
/// shared by every request kind (rewording, Ask and agent steps), so all of them spend from one
/// per-route cap. Callers have already checked the request and resolved its `Target`. The reply's
/// JSON is returned for the caller to read; it is never echoed in an error.
pub(crate) struct Exchange<'a> {
    pub config: &'a RouteConfig,
    /// The usage file (LEDGER_FILE).
    pub usage: &'a Path,
    pub url: &'a str,
    pub body: &'a [u8],
    pub tags: (&'a str, &'a str),
    pub keys: &'a dyn ModelKeys,
    pub http: &'a dyn ModelHttp,
    /// `Target::Hosted`: the device token instead of the route's key, no gateway reporting tags
    /// (ozzie.church sets its own), and ozzie.church's refusals (`hosted::refusal`).
    pub hosted: bool,
}
impl Exchange<'_> {
    /// The key, then the caps (looked at, not spent), then `before_send`, then the usage
    /// reservation (`spend`), then the one POST. Nothing is spent when the key is missing, a cap
    /// is already spent, or `before_send` refuses (an agent step's ledger reservation, review
    /// 2026-11-14 C11); only a cap spent in between by another call refuses after `before_send`
    /// ran, leaving what it recorded for the caller to close. Once reserved, a call stays spent,
    /// as a timeout's would.
    pub(crate) fn send<E: From<ModelError>>(
        &self,
        spend: Spend,
        before_send: impl FnOnce() -> Result<(), E>,
    ) -> Result<Value, E> {
        let key = if self.hosted {
            Some(hosted::device_token(self.keys)?)
        } else {
            key_for(self.config, self.keys)?
        };
        affordable(self.config, self.usage, spend, self.hosted)?;
        before_send()?;
        reserve(self.config, self.usage, spend, self.hosted)?;
        let tagged = [self.tags];
        let versioned = crate::own_key::route_headers(self.config);
        let headers: &[(&str, &str)] = if self.config.route == Route::Managed && !self.hosted {
            &tagged
        } else {
            &versioned
        };
        // ozzie.church takes the device token as a bearer token; a route's own key travels as its wire says.
        let header = if self.hosted {
            KeyHeader::Bearer
        } else {
            crate::own_key::key_header(self.config)
        };
        let key_text = key.as_ref().map(|k| (k.as_str(), header));
        let (mut status, mut bytes) = self.http.post(self.url, key_text, headers, self.body)?;
        // A model on this Mac whose app refuses the thinking setting is asked once more without it, within the same
        // call (local_ai.rs); that model is asked without it from then on.
        if self.config.route == Route::Local
            && crate::local_ai::refused_thinking_setting(status, &bytes)
            && let Some(body) = crate::local_ai::without_thinking_setting(
                &self.config.base_url,
                &self.config.model,
                self.body,
            )
        {
            (status, bytes) = self.http.post(self.url, key_text, headers, &body)?;
        }
        drop(key);
        // Only these fixed markers are looked for; no provider text is ever returned.
        let refused_model = |bytes: &[u8]| {
            let text = String::from_utf8_lossy(bytes);
            text.contains("RestrictedModelsError") || text.contains("no_providers_available")
        };
        let text = String::from_utf8_lossy(&bytes);
        let refused = match status {
            _ if self.hosted => hosted::refusal(status, &bytes),
            200 => None,
            // The same markers as the key check (own_key::out_of_credit; review F4).
            _ if crate::own_key::out_of_credit(status, &text) => Some(ModelError::NoCredit),
            // Google's per-day free limit: until tomorrow, not "try again in a minute" (review L11).
            429 if text.contains("RESOURCE_EXHAUSTED") && text.contains("PerDay") => {
                Some(ModelError::DailyLimit)
            }
            429 => Some(ModelError::RateLimited),
            _ if refused_model(&bytes) => Some(ModelError::ModelNotAllowed),
            401 | 403 => Some(ModelError::NotConfigured),
            400 | 422 => Some(ModelError::InvalidRequest),
            _ => Some(ModelError::ProviderFailure),
        };
        if let Some(error) = refused {
            return Err(error.into());
        }
        let mut value: Value =
            serde_json::from_slice(&bytes).map_err(|_| ModelError::ProviderFailure)?;
        // Claude's own Messages reply, read back as the Chat Completions reply every reader checks.
        if !self.hosted && crate::own_key::messages_wire(self.config) {
            value = crate::anthropic::from_messages(&value);
        }
        // Owner 2026-11-14: a route that requires zero data retention also requires AI Gateway's
        // confirmation of it in the reply; without it the reply is refused and none of it is read.
        // ozzie.church passes the gateway's reply through unchanged and refuses the same way, so
        // this holds in the open core too. The call went out, so it stays spent with its tokens.
        if self.config.zero_retention() && !retention_confirmed(&value) {
            record_tokens(self.usage, self.config.route, &value);
            return Err(ModelError::ProviderFailure.into());
        }
        Ok(value)
    }
}

/// Whether a reply confirms zero data retention: AI Gateway's provider metadata carries
/// `gateway.enabledZeroDataRetention`, true when the request went only to zero-retention providers
/// (Vercel docs, AI Gateway "Zero Data Retention"; live Chat Completions replies carry it at
/// `choices[0].message.provider_metadata.gateway`, seen 2026-11-14). Looked for at the top level
/// and on the first message, as `provider_metadata`, `providerMetadata` or bare `gateway`; every
/// place that has the field must say exactly `true`, and at least one must. Mirrors web/'s
/// `zeroRetention` (src/lib/hosted/gateway.ts).
pub(crate) fn retention_confirmed(value: &Value) -> bool {
    let message = &value["choices"][0]["message"];
    let mut seen = false;
    for at in [value, message] {
        for holder in [&at["provider_metadata"], &at["providerMetadata"], at] {
            if let Some(flag) = holder["gateway"].get("enabledZeroDataRetention") {
                if flag != &Value::Bool(true) {
                    return false;
                }
                seen = true;
            }
        }
    }
    seen
}

/// Adds a reply's reported token counts to the route's usage and returns them.
pub(crate) fn record_tokens(
    ledger: &Path,
    route: Route,
    value: &Value,
) -> (Option<u64>, Option<u64>) {
    let prompt_tokens = value["usage"]["prompt_tokens"].as_u64();
    let completion_tokens = value["usage"]["completion_tokens"].as_u64();
    // The call already counted; a failed token write must not hide the reply.
    let _ = update_ledger(ledger, |ledger| {
        let usage = ledger.usage(route);
        usage.prompt_tokens = usage
            .prompt_tokens
            .saturating_add(prompt_tokens.unwrap_or(0));
        usage.completion_tokens = usage
            .completion_tokens
            .saturating_add(completion_tokens.unwrap_or(0));
        Ok(())
    });
    (prompt_tokens, completion_tokens)
}

/// Saved route, or None when absent or not valid under the current rules.
pub fn load_config(dir: &Path) -> Option<RouteConfig> {
    let bytes = read_small(&dir.join(CONFIG_FILE)).ok()??;
    let config: RouteConfig = serde_json::from_slice(&bytes).ok()?;
    config.endpoint().ok()?;
    Some(config)
}
/// The saved route as the app may send on it: a model on this Mac only at Ollama's or LM Studio's own address on
/// 127.0.0.1, and only once "Check that it answers" passed (review L8). None otherwise, so nothing is sent.
pub fn usable_config(dir: &Path) -> Option<RouteConfig> {
    load_config(dir).filter(|config| {
        config.route != Route::Local
            || (config.checked_at_ms.is_some()
                && local_base_allowed(&config.base_url)
                && !crate::local_ai::cloud_name(&config.model))
    })
}
/// The two addresses a model on this Mac may have (local_ai.rs).
pub fn local_base_allowed(base: &str) -> bool {
    [crate::local_ai::OLLAMA, crate::local_ai::LM_STUDIO]
        .iter()
        .any(|origin| base == format!("{origin}/v1"))
}
/// Every choice of AI route made in this run of the app, counted per app data folder, in memory only (a check never
/// outlives the app): a route saved (by the page, or by a check that passed), "No AI for now", the church's keys
/// removed, Ozzie's AI signed out on this Mac. A check reads the count as it begins and switches the route only if it
/// is unchanged when it ends, so a check the person walked away from never undoes what they chose since (review M-2).
static ROUTE_CHOICES: Mutex<BTreeMap<PathBuf, u64>> = Mutex::new(BTreeMap::new());
/// One choice of route being made: every other choice waits until it is dropped, so a check's comparison and its save
/// are never split by another. Every write or removal of model.json that chooses a route goes through one.
pub(crate) struct RouteChoice(MutexGuard<'static, BTreeMap<PathBuf, u64>>);
pub(crate) fn route_choice() -> RouteChoice {
    RouteChoice(ROUTE_CHOICES.lock().unwrap_or_else(|e| e.into_inner()))
}
impl RouteChoice {
    /// How many choices of route `dir` has seen.
    pub(crate) fn generation(&self, dir: &Path) -> u64 {
        self.0.get(dir).copied().unwrap_or(0)
    }
    /// One more choice made in `dir`, whether or not what it wrote could be kept: the person chose since.
    pub(crate) fn made(&mut self, dir: &Path) {
        let count = self.0.entry(dir.to_path_buf()).or_default();
        *count = count.wrapping_add(1);
    }
    /// The route chosen: model.json written (`write_config`), and counted.
    pub(crate) fn save(
        &mut self,
        dir: &Path,
        config: RouteConfig,
        checked_at_ms: Option<u64>,
    ) -> Result<RouteConfig, ModelError> {
        self.made(dir);
        write_config(dir, config, checked_at_ms)
    }
    /// No route chosen: model.json removed, and counted.
    pub(crate) fn clear(&mut self, dir: &Path) -> Result<(), ModelError> {
        self.made(dir);
        match std::fs::remove_file(dir.join(CONFIG_FILE)) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => {
                Err(ModelError::ProviderFailure)
            }
            _ => Ok(()),
        }
    }
}
/// How many choices of AI route `dir` has seen in this run of the app. A check reads it as it begins.
pub fn route_generation(dir: &Path) -> u64 {
    route_choice().generation(dir)
}
/// A choice that ends what a check would switch to without choosing a route itself: the church's keys removed, Ozzie's
/// AI signed out on this Mac.
pub fn route_choice_made(dir: &Path) {
    route_choice().made(dir);
}
/// Writes model.json, keeping any owner-set caps and the monthly limit. Keys are never accepted here. A changed
/// base URL changes `key_account` for an own provider, so a key saved for one host is never sent to another. A local
/// model's check stays only while the route, address and model are the ones that were checked.
pub fn save_config(
    dir: &Path,
    route: Route,
    base_url: Option<&str>,
    model: Option<&str>,
) -> Result<RouteConfig, ModelError> {
    let config = RouteConfig::new(route, base_url, model)?;
    // A model Ollama sends to its own servers is never chosen as AI on this Mac (`local_ai::cloud_name`).
    if config.route == Route::Local && crate::local_ai::cloud_name(&config.model) {
        return Err(ModelError::NotOnThisMac);
    }
    route_choice().save(dir, config, None)
}
/// "Check that it answers" passed: the local route at this address and model, checked at `at_ms`, for a check that
/// began when `route_generation` was `began`. None, with nothing written, when another choice was made since.
pub fn save_local_checked(
    dir: &Path,
    base_url: &str,
    model: &str,
    at_ms: u64,
    began: u64,
) -> Result<Option<RouteConfig>, ModelError> {
    let config = RouteConfig::new(Route::Local, Some(base_url), Some(model))?;
    if crate::local_ai::cloud_name(model) {
        return Err(ModelError::NotOnThisMac);
    }
    let mut choice = route_choice();
    if choice.generation(dir) != began {
        return Ok(None);
    }
    choice.save(dir, config, Some(at_ms)).map(Some)
}
fn write_config(
    dir: &Path,
    mut config: RouteConfig,
    checked_at_ms: Option<u64>,
) -> Result<RouteConfig, ModelError> {
    if let Some(previous) = load_config(dir) {
        config.call_cap = previous.call_cap;
        config.agent_steps_per_day = previous.agent_steps_per_day;
        config.month_limit = previous.month_limit;
        let same = previous.route == config.route
            && previous.base_url == config.base_url
            && previous.model == config.model;
        if same && config.route == Route::Local {
            config.checked_at_ms = previous.checked_at_ms;
        }
    }
    if config.route == Route::Local && checked_at_ms.is_some() {
        config.checked_at_ms = checked_at_ms;
    }
    put_config(dir, &config)?;
    Ok(config)
}
fn put_config(dir: &Path, config: &RouteConfig) -> Result<(), ModelError> {
    let bytes = serde_json::to_vec_pretty(config).map_err(|_| ModelError::InvalidRequest)?;
    write_private(&dir.join(CONFIG_FILE), &bytes).map_err(|_| ModelError::ProviderFailure)
}
/// No route chosen ("Remove this key"): model.json is removed. The usage file stays, so this month's count holds.
pub fn clear_config(dir: &Path) -> Result<(), ModelError> {
    route_choice().clear(dir)
}
/// "Remove this model from this Mac": when the route chosen is a model on this Mac at Ollama's address and is one of
/// `models`, no route is chosen any more (a choice, counted). True when it was cleared; any other route stays.
pub fn clear_local_if(dir: &Path, models: &[String]) -> Result<bool, ModelError> {
    let mut choice = route_choice();
    let removed = load_config(dir).is_some_and(|config| {
        config.route == Route::Local
            && config.base_url == crate::local_ai::App::Ollama.base()
            && models.iter().any(|m| *m == config.model)
    });
    if removed {
        choice.clear(dir)?;
    }
    Ok(removed)
}
/// "No AI for now" (spec S6, from setup or Settings): no route is chosen, so no AI request goes anywhere. A model on
/// this Mac or Ozzie's AI is switched off as surely as an own key. Nothing else changes: the church's own key stays in
/// the Keychain until they choose "Remove my key from this Mac" (own_key.rs `remove_keys`), and Ozzie's AI's sign-in
/// on this Mac stays until its own Disconnect (`managed_disconnect`).
pub fn choose_no_ai(dir: &Path, keys: &dyn ModelKeys) -> Result<ModelStatus, ModelError> {
    clear_config(dir)?;
    Ok(status(dir, keys))
}
/// Settings' "Change the limit": the own-key route's AI requests a month, within MONTH_LIMITS.
pub fn set_month_limit(dir: &Path, limit: u64) -> Result<RouteConfig, ModelError> {
    if !MONTH_LIMITS.contains(&limit) {
        return Err(ModelError::InvalidRequest);
    }
    // Not a choice of route, but no check's save may land between this read and this write.
    let _choice = route_choice();
    let mut config = load_config(dir).ok_or(ModelError::NotConfigured)?;
    config.month_limit = limit;
    put_config(dir, &config)?;
    Ok(config)
}

#[derive(Serialize)]
pub struct ModelStatus {
    pub configured: bool,
    /// "managed" | "own" | "local" | "none"
    pub route: &'static str,
    pub label: String,
    /// What is missing, as a closed code the app can explain: "ready"; "no-route" (no usable
    /// model.json); "no-key" (nothing under `key_account`); "own-key-not-bound" (an own-provider
    /// key saved under the old account `own-provider`, which is bound to no host and never used:
    /// save it again under `key_account`); for the managed route, "not-connected" (this Mac isn't
    /// connected to Ozzie managed) or "reconnect" (ozzie.church refused this Mac's connection).
    pub setup: &'static str,
    /// The Keychain account (service KEYCHAIN_SERVICE) this route's key belongs under; None for a
    /// local model and for Ozzie managed, whose device token the app saves itself. Never a key.
    pub key_account: Option<String>,
    /// Ozzie managed on this Mac, whichever route is chosen: "not-connected", "connected" or
    /// "reconnect" (`hosted::attach`; `status` alone looks only when the managed route is chosen).
    pub managed: &'static str,
    /// The church's plan and usage on ozzie.church, when connected and known (`hosted::attach`).
    pub account: Option<hosted::Account>,
    /// The own route at a company Ozzie knows (own_key.rs presets): "openai", "anthropic" or "gemini".
    pub provider: Option<&'static str>,
    /// The own route's month: requests used, the limit, and the day it starts again.
    pub month: Option<MonthView>,
    /// The local route: when "Check that it answers" last passed (Unix ms); None until it has.
    pub checked_at_ms: Option<u64>,
    /// The local route is a catalogue model Ozzie no longer offers, or Ozzie's copy of one (providers.json `offered`:
    /// the small model, withdrawn 2026-11-18). It keeps working; the page says so (review L-4).
    pub not_offered: bool,
    /// The local route's app, by its exact address: "ollama" or "lm-studio"; None on every other route, and for an
    /// address that is neither (never used: `usable_config`).
    pub local_app: Option<&'static str>,
}
#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct MonthView {
    pub used: u64,
    pub limit: u64,
    /// `YYYY-MM-01`, UTC.
    pub resets_on: String,
}
pub fn status(dir: &Path, keys: &dyn ModelKeys) -> ModelStatus {
    status_for(dir, keys, cfg!(debug_assertions))
}
/// `debug`: a debug build, where the managed route may still go straight to AI Gateway with the
/// owner's key when this Mac has no device token.
pub(crate) fn status_for(dir: &Path, keys: &dyn ModelKeys, debug: bool) -> ModelStatus {
    status_at(dir, keys, debug, crate::sunday_check::unix_ms())
}
/// The own route's month as of `now_ms`, from the usage file (an unreadable one counts as spent).
fn month_view(dir: &Path, config: &RouteConfig, now_ms: u64) -> MonthView {
    let day = utc_day(now_ms);
    let month = crate::civil::month_of_day(day);
    let used = {
        let _lock = LEDGER.lock().unwrap_or_else(|e| e.into_inner());
        match read_ledger(&dir.join(LEDGER_FILE)) {
            Ok(mut ledger) => {
                let own = ledger.usage(Route::Own);
                if own.month == month {
                    own.month_calls
                } else {
                    0
                }
            }
            Err(_) => config.month_limit,
        }
    };
    MonthView {
        used,
        limit: config.month_limit,
        resets_on: crate::civil::next_month_start(day),
    }
}
pub(crate) fn status_at(dir: &Path, keys: &dyn ModelKeys, debug: bool, now_ms: u64) -> ModelStatus {
    let Some(config) = load_config(dir) else {
        return ModelStatus {
            configured: false,
            route: "none",
            label: "No AI model set up".into(),
            setup: "no-route",
            key_account: None,
            managed: "not-connected",
            account: None,
            provider: None,
            month: None,
            checked_at_ms: None,
            not_offered: false,
            local_app: None,
        };
    };
    let host = config.host().unwrap_or_default();
    if config.route == Route::Managed {
        let connected = hosted::connected(keys);
        // Debug builds only, and only without a device token: the owner's gateway key.
        let gateway = !connected && debug && key_for(&config, keys).is_ok();
        let label = if gateway {
            format!(
                "Ozzie managed AI straight to AI Gateway (developer build), zero data retention ({})",
                config.model
            )
        } else {
            "Ozzie managed AI through ozzie.church, zero data retention".to_owned()
        };
        return ModelStatus {
            configured: connected || gateway,
            route: config.route.name(),
            label,
            setup: if connected || gateway {
                "ready"
            } else {
                "not-connected"
            },
            key_account: gateway.then(|| MANAGED_ACCOUNT.to_owned()),
            managed: if connected {
                "connected"
            } else {
                "not-connected"
            },
            account: None,
            provider: None,
            month: None,
            checked_at_ms: None,
            not_offered: false,
            local_app: None,
        };
    }
    let has_key = key_for(&config, keys).is_ok();
    // Never "ready" for a local model before "Check that it answers" passed (spec S9).
    let checked = config.route != Route::Local || config.checked_at_ms.is_some();
    let month = (config.route == Route::Own).then(|| month_view(dir, &config, now_ms));
    let spent = month.as_ref().is_some_and(|m| m.used >= m.limit);
    // Presence only: a key under the old unbound account is looked at, never used.
    let unbound = || matches!(keys.key(LEGACY_OWN_ACCOUNT), Ok(Some(key)) if usable_key(&key));
    // A model Ollama sends to its own servers is never ready as AI on this Mac, however it was saved (by its name here;
    // its app is asked as well where the app reads the status: `local_ai::mark_elsewhere`).
    let elsewhere = config.route == Route::Local && crate::local_ai::cloud_name(&config.model);
    let setup = match (has_key, config.route) {
        _ if elsewhere => "not-on-this-mac",
        (true, _) if !checked => "not-checked",
        (true, _) if spent => "month-limit",
        (true, _) => "ready",
        (false, Route::Own) if unbound() => "own-key-not-bound",
        (false, _) => "no-key",
    };
    let provider = crate::own_key::preset_for(&config);
    let label = match (config.route, provider) {
        (Route::Own, Some(preset)) => format!("{}, with your key ({})", preset.name, config.model),
        (Route::Own, None) => format!("Your AI provider at {host} ({})", config.model),
        // Ozzie's set-up copy is named as the model it is a copy of: the same model, given room (local_models.rs).
        _ => format!(
            "AI model on this Mac ({})",
            crate::local_models::shown_name(&config.model)
        ),
    };
    ModelStatus {
        configured: has_key && checked && !elsewhere,
        route: config.route.name(),
        label,
        setup,
        key_account: config.key_account(),
        managed: "not-connected",
        account: None,
        provider: provider.map(|p| p.id.as_str()),
        month,
        checked_at_ms: config
            .checked_at_ms
            .filter(|_| config.route == Route::Local),
        not_offered: config.route == Route::Local
            && crate::local_models::no_longer_offered(&config.model),
        local_app: (config.route == Route::Local)
            .then(|| crate::local_ai::route_app(&config))
            .flatten()
            .map(|app| match app {
                crate::local_ai::App::Ollama => "ollama",
                crate::local_ai::App::LmStudio => "lm-studio",
            }),
    }
}

#[cfg(test)]
#[path = "model_tests.rs"]
mod tests;
