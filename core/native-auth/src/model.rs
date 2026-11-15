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
    io::{self, Read, Write},
    path::Path,
    sync::Mutex,
    time::Duration,
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
/// Paid calls allowed until the owner raises `call_cap` in model.json.
pub const DEFAULT_CALL_CAP: u64 = 200;
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
    /// Agent steps only: today's agent steps on this route (model.json `agent_steps_per_day`)
    /// are spent. Rewording and Ask never return it.
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
    fn paid(self) -> bool {
        self != Self::Local
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
}
fn default_cap() -> u64 {
    DEFAULT_CALL_CAP
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
    if model == MANAGED_MODEL || model == LOCAL_MODEL {
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
        Ok(format!("{base}/chat/completions"))
    }
}

/// Read-only key source. Provider keys are added outside the app (macOS `security`); nothing here
/// writes one. hosted.rs writes only Ozzie managed's device token (`hosted::TokenStore`).
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
    // No hidden character either, as a question may hold none (review B2 M-1); after the name check,
    // so a name split by an invisible character is still refused as a name. The page sends a position
    // name holding one as [Role], so only something else could put one here.
    if hidden_in_note(note) {
        return Err(ModelError::HiddenCharacter);
    }
    Ok(())
}

// ---- Ask Ozzie (build plan S4) --------------------------------------------------------------
//
// The second request kind: one leader question, answered from the placeholder-only fact sheet
// that core/src/ask.ts builds. The webview is the primary boundary; `check_ask` is defence in
// depth and runs before any key, budget or network:
//  - the system text is exactly ASK_SYSTEM (pinned to core/src/ask.ts by a test);
//  - the user text is fact lines in a closed grammar (`fact_line_ok`: fixed line kinds and codes,
//    and every field a label, a date/time shape, a small count or a code; people are [Person N]
//    and positions [Role N], never verbatim), then one "\nQ | " question line of at most
//    MAX_ASK_QUESTION_CHARS with no line break of any kind, control, format or private-use
//    character. Free text cannot follow a valid code;
//  - every square bracket is an Ask label ([Person N], [Role N], [Your name], [a team member])
//    that stands alone;
//  - no background-check wording anywhere in the user text, fact lines and question alike
//    (background.rs, owner decision 2026-11-14), checked first so it is refused as itself;
//  - no email address or phone number anywhere in the user text, raw or NFKC (`contact_detail`:
//    any decimal digits, groups separated by one to three of anything but letters, numbers and
//    line breaks, dates and times set aside; "x@y");
//  - no name this session has shown appears anywhere in the user text as a whole word (only a
//    letter of a spaced script continues a word, so digits and unspaced scripts are boundaries;
//    plus an optional plural/possessive "s"), as joined parts, spelled out letter by letter, or
//    inside unspaced-script text (NameGuard::present_as_word, the webview's rule since the
//    coordinator's 2026-11-13 decisions): the whole text with labels removed outright and
//    replaced by spaces, raw and NFKC. Rewording keeps the stricter substring guard (`present`).
// Replies are not checked here: the webview checks every reply (acceptAskReply) before showing it.
// The fixed system text is not name-checked: it is compared byte for byte, so it cannot carry one.
// Ask never goes to Planning Center and spends from the same per-route call cap as rewording.
pub const ASK_SYSTEM: &str = concat!(
    "You are Ozzie, church administration software. You prepare and explain; people decide and people go. ",
    "Answer the leader's question using only the fact lines in the message, which come from checks already made on this Mac. ",
    "If the facts don't fully answer it, begin with exactly: I can't tell from what I read. Then say what is missing. ",
    "Never invent people, availability or willingness. No overlap found does not mean someone is free or willing; only they can say. ",
    "Never rank, score, compare or label people, and keep people in the order given. ",
    "Refer to people and roles only by their bracketed labels, written exactly, such as [Person 1] or [Role 1]. Add no names and no other bracketed text. ",
    "You cannot send messages or change Planning Center, and nothing has been sent or changed. Never say otherwise. ",
    "No prayers, sermons, scripture, blessings or devotional content. ",
    "Write plain text without markdown, warm and short: under 120 words, and never show the codes. ",
    "Don't describe where the facts came from; the screen already shows the source and when it was read. ",
    "If asked to draft a note, write one short sentence, then a line that starts with exactly Draft note: followed by a short, kind note the leader can send themselves. Make it easy to say no, add no guilt or pressure, and sign it [Your name]. ",
    "Fact lines have fields separated by a vertical bar. Times are local, written YYYY-MM-DD HH:MM. ",
    "S is the Sunday check: its mode (L live check, R saved recording that is not current, X example data invented for a demonstration), when it was read, how many reads, and how many didn't complete. ",
    "D is the Sunday's date. F1, F2 and so on are findings. ",
    "N: a role still needs people; then the role, the service time and how many more. ",
    "M: the church rules ask for a scheduled Sunday lead for the role, and none is scheduled. ",
    "W: a person is pending for a role; then the role, the time, the person, and s (request sent, no answer yet) or n (request not sent yet). ",
    "K: a person is scheduled this many Sundays in a row; the church rules suggest a check-in, which is about care, not performance. ",
    "G: part of the check couldn't be verified; then how many reads didn't complete, and s if the check is too old to treat as current. ",
    "U: a Sunday lead is scheduled for the role, but their answer or serving time couldn't be confirmed. ",
    "A: a kids team has fewer confirmed people at a service time than the church rules ask; then the role, the time, how many are confirmed, how many the rules ask for, how many more are asked with no answer yet, how many more have a request not sent yet, and u if some confirmed people aren't placed at a time. Pending isn't counted, and ages aren't checked. ",
    "Lines under an N finding list people on that role's team; none means no one else on the team was found. ",
    "Each person line has s no overlap found, c possible conflict, v availability needs confirmation or x left out; then reasons: ",
    "t on the team with no overlap found, u an unanswered request elsewhere at this time, p penciled in elsewhere with the request not sent, q pending elsewhere at this time, o confirmed elsewhere at this time, b a blockout covers this time, r a blockout that can't be checked, a other schedules couldn't be read, e records say not on the team, not eligible or not available, n a detail couldn't be verified. ",
    "Other lines under a finding: y confirmed for that role already; w scheduled to lead but hasn't accepted; L a team leader Planning Center lists for that team, which is oversight, not a Sunday assignment (- none listed, ? couldn't be read). ",
    "H: the leader already decided this for this Sunday: o covered outside Planning Center, n not needed this Sunday, e no scheduled lead expected; then r if a later check changed something, so it needs a fresh look. Treat a decided finding without r as settled by the leader. ",
    "E is an example email and calendar import of invented records, and when it was imported. E1, E2 and so on are events that need a person's decision: l a message says the room is unavailable while the calendar still lists it, c a message says it is cancelled while the calendar still shows it, m messages disagree; then the start time, n if the message says volunteers have not been contacted or ? if unknown, and u if the import is uncertain. ",
    "Z: how many fact lines were left out for length. Q is the leader's question.",
);
/// Fixed reporting tags for Ask, as MANAGED_TAGS is for rewording. Never the `ai-reporting-user` header.
pub const ASK_TAGS: (&str, &str) = ("ai-reporting-tags", "app:ozzie,route:managed,feature:ask");
/// Separates the fact lines from the question; the last occurrence is the question.
pub const QUESTION_PREFIX: &str = "\nQ | ";
/// Bounds the fixed legend (compared byte for byte with ASK_SYSTEM anyway). 4000 until the kids-rule
/// A line (2026-11-14) took it to about 4330.
pub const MAX_ASK_SYSTEM_CHARS: usize = 4400;
pub const MAX_ASK_USER_CHARS: usize = 8000;
pub const MAX_ASK_QUESTION_CHARS: usize = 600;
pub const MAX_ASK_TOKENS: u32 = 600;
const MAX_FACT_LINE_CHARS: usize = 300;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AskRequest {
    pub system: String,
    pub user: String,
    pub max_tokens: u32,
}

/// The exact Chat Completions body for one question. Managed requests always require zero data
/// retention and disable hidden reasoning, as for rewording.
pub fn ask_body(config: &RouteConfig, request: &AskRequest) -> Result<Value, ModelError> {
    let system = request.system.chars().count();
    let user = request.user.chars().count();
    if system == 0
        || system > MAX_ASK_SYSTEM_CHARS
        || user == 0
        || user > MAX_ASK_USER_CHARS
        || request.max_tokens == 0
    {
        return Err(ModelError::InvalidRequest);
    }
    let mut body = json!({
        "model": config.model,
        "messages": [
            {"role": "system", "content": request.system},
            {"role": "user", "content": request.user},
        ],
        "max_tokens": request.max_tokens.min(MAX_ASK_TOKENS),
        "temperature": 0.2,
    });
    if config.zero_retention() {
        body["providerOptions"] = json!({"gateway": {"zeroDataRetention": true}});
    }
    if config.route == Route::Managed {
        body["reasoning"] = json!({"enabled": false});
    }
    Ok(body)
}

/// Byte length of the Ask label at the start of `text`: `[Person N]` or `[Role N]` (N is 1 to
/// 9999 with no leading zero), `[Your name]`, or `[a team member]` (a name part several people share).
fn ask_label_len(text: &str) -> Option<usize> {
    for fixed in ["[Your name]", "[a team member]"] {
        if text.starts_with(fixed) {
            return Some(fixed.len());
        }
    }
    let rest = text
        .strip_prefix("[Person ")
        .or_else(|| text.strip_prefix("[Role "))?;
    let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
    let ok = (1..=4).contains(&digits)
        && !rest.starts_with('0')
        && rest.as_bytes().get(digits) == Some(&b']');
    ok.then(|| text.len() - rest.len() + digits + 1)
}
/// Byte ranges of the Ask labels in `text`, or None if any square bracket is not part of one.
fn ask_labels(text: &str) -> Option<Vec<(usize, usize)>> {
    let mut found = Vec::new();
    let mut at = 0;
    while let Some(offset) = text[at..].find(['[', ']']) {
        let start = at + offset;
        let end = start + ask_label_len(&text[start..])?;
        found.push((start, end));
        at = end;
    }
    Some(found)
}
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

// The closed fact-line grammar core/src/ask.ts `buildAskContext` emits. Every field has a fixed
// shape, so nothing free can follow a valid code: the only free text in a request is the
// question line. People and positions are always labels.
fn all_digits(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit())
}
/// A small count: 1 to 5 ASCII digits.
fn count_ok(text: &str) -> bool {
    text.len() <= 5 && all_digits(text)
}
fn hm_ok(text: &str) -> bool {
    text.len() == 5 && all_digits(&text[..2]) && &text[2..3] == ":" && all_digits(&text[3..])
}
/// YYYY-MM-DD
fn date_ok(text: &str) -> bool {
    text.is_ascii()
        && text.len() == 10
        && all_digits(&text[..4])
        && &text[4..5] == "-"
        && all_digits(&text[5..7])
        && &text[7..8] == "-"
        && all_digits(&text[8..])
}
/// YYYY-MM-DD HH:MM, or "-" when unknown.
fn stamp_ok(text: &str) -> bool {
    text == "-"
        || (text.is_ascii()
            && text.len() == 16
            && date_ok(&text[..10])
            && &text[10..11] == " "
            && hm_ok(&text[11..]))
}
/// A service time: "YYYY-MM-DD HH:MM-HH:MM", "YYYY-MM-DD HH:MM/YYYY-MM-DD HH:MM", or "-".
fn span_ok(text: &str) -> bool {
    let stamp = |t: &str| t != "-" && stamp_ok(t);
    text == "-"
        || (text.is_ascii()
            && ((text.len() == 22
                && stamp(&text[..16])
                && &text[16..17] == "-"
                && hm_ok(&text[17..]))
                || (text.len() == 33
                    && stamp(&text[..16])
                    && &text[16..17] == "/"
                    && stamp(&text[17..]))))
}
/// Exactly one `[Person N]` label (team leaders are labelled people too).
fn person_ok(text: &str) -> bool {
    text.starts_with("[Person ") && ask_label_len(text) == Some(text.len())
}
/// Exactly one `[Role N]` label, or "-" when the finding has no position. A position name is
/// never sent verbatim (coordinator decision 2026-11-13: it can hold a name the roster doesn't,
/// such as "Pastor Dave's Class"); core/src/ask.ts labels every one.
fn role_ok(text: &str) -> bool {
    text == "-" || (text.starts_with("[Role ") && ask_label_len(text) == Some(text.len()))
}
/// Coverage reason codes, comma separated.
fn reasons_ok(text: &str) -> bool {
    text.len() <= 40
        && text.split(',').all(|code| {
            matches!(
                code,
                "t" | "u" | "p" | "q" | "o" | "b" | "r" | "a" | "e" | "n" | "?"
            )
        })
}
/// A finding number or import event number: 1 to 9999, no leading zero.
fn numbered(code: &str, prefix: char) -> bool {
    code.strip_prefix(prefix)
        .is_some_and(|n| n.len() <= 4 && all_digits(n) && !n.starts_with('0'))
}
fn finding_fields(fields: &[&str]) -> bool {
    let someone = |t: &str| person_ok(t) || t == "-";
    match fields {
        ["N", role, when, need] => {
            role_ok(role) && span_ok(when) && (count_ok(need) || *need == "?")
        }
        ["s" | "c" | "v" | "x", who, reasons] => person_ok(who) && reasons_ok(reasons),
        ["y" | "w", who] => person_ok(who),
        ["L", who] => person_ok(who) || matches!(*who, "-" | "?"),
        ["M" | "U", role, when] => role_ok(role) && span_ok(when),
        ["W", role, when, who, "s" | "n"] => role_ok(role) && span_ok(when) && someone(who),
        ["K", who, sundays] => someone(who) && (count_ok(sundays) || *sundays == "?"),
        ["G", failed, "s" | "-"] => count_ok(failed),
        // Kids rules: counts for a team. Background checks never reach a model (no B line).
        ["A", role, when, confirmed, needed, asked, unsent]
        | ["A", role, when, confirmed, needed, asked, unsent, "u"] => {
            role_ok(role)
                && span_ok(when)
                && count_ok(confirmed)
                && (count_ok(needed) || *needed == "?")
                && count_ok(asked)
                && count_ok(unsent)
        }
        ["H", "o" | "n" | "e"] | ["H", "o" | "n" | "e", "r"] => true,
        _ => false,
    }
}
/// One fact line, field by field. See the legend in ASK_SYSTEM.
fn fact_line_ok(line: &str) -> bool {
    if line.chars().count() > MAX_FACT_LINE_CHARS {
        return false;
    }
    let fields: Vec<&str> = line.split(" | ").collect();
    match fields.as_slice() {
        ["S", "L" | "R" | "X", at, reads, failed] => {
            stamp_ok(at) && count_ok(reads) && count_ok(failed)
        }
        ["D", date] => date_ok(date),
        ["Z", dropped] => count_ok(dropped),
        ["E", "X", at] => stamp_ok(at),
        [code, "l" | "c" | "m", at, "n" | "?"] | [code, "l" | "c" | "m", at, "n" | "?", "u"]
            if numbered(code, 'E') =>
        {
            stamp_ok(at)
        }
        [code, rest @ ..] if numbered(code, 'F') => finding_fields(rest),
        _ => false,
    }
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

/// Native defence in depth behind the webview's Ask boundary (see the section comment above).
pub fn check_ask(request: &AskRequest, names: &NameGuard) -> Result<(), ModelError> {
    if request.system != ASK_SYSTEM {
        return Err(ModelError::InvalidRequest);
    }
    let user = request.user.as_str();
    let (facts, question) = user
        .rsplit_once(QUESTION_PREFIX)
        .ok_or(ModelError::InvalidRequest)?;
    // The system text is pinned above; everything else varies.
    if background_wording(user) {
        return Err(ModelError::BackgroundCheck);
    }
    let question_chars = question.chars().count();
    let nfkc = |text: &str| {
        icu_normalizer::ComposingNormalizerBorrowed::new_nfkc()
            .normalize(text)
            .into_owned()
    };
    // Compatibility forms (fullwidth digits, @ and brackets) count too, as for rewording.
    let compat = nfkc(user);
    if facts.is_empty()
        || !facts.split('\n').all(fact_line_ok)
        || question_chars == 0
        || question_chars > MAX_ASK_QUESTION_CHARS
        || question.chars().any(not_in_a_question)
        // The whole user text, every fact line included, raw and NFKC.
        || contact_detail_strict(user)
        || contact_detail_strict(&compat)
    {
        return Err(ModelError::InvalidRequest);
    }
    let (Some(raw), Some(compat_labels)) = (ask_labels(user), ask_labels(&compat)) else {
        return Err(ModelError::InvalidRequest);
    };
    if !ask_labels_standalone(user, &raw) || !ask_labels_standalone(&compat, &compat_labels) {
        return Err(ModelError::InvalidRequest);
    }
    // The whole user text, facts and question alike, with labels removed and spaced. Whole-word
    // rule (NameGuard::present_as_word), as the webview applies it; rewording stays on `present`.
    if [
        strip_ask_labels(user, &raw, ""),
        strip_ask_labels(user, &raw, " "),
        strip_ask_labels(&compat, &compat_labels, ""),
        strip_ask_labels(&compat, &compat_labels, " "),
    ]
    .iter()
    .any(|text| names.present_as_word(text))
    {
        return Err(ModelError::NamePresent);
    }
    Ok(())
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
}
/// What one call reserves in the usage file before it is sent.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Spend {
    /// Rewording or Ask: one call against the route's paid call cap.
    Call,
    /// An agent step: one call, and one of the route's agent steps for this UTC day.
    AgentStep { day: u64 },
}
/// Days since 1970-01-01, UTC.
pub(crate) fn utc_day(unix_ms: u64) -> u64 {
    unix_ms / DAY_MS
}
/// One call's spend against the route's usage: refused when a cap is spent. Through ozzie.church
/// (`hosted`) the lifetime `call_cap` doesn't apply: the account's monthly allowance and its honest
/// pause are the limit there (owner, 2026-10-26 / 2026-11-14). The daily agent-step cap still does.
fn spend_on(
    config: &RouteConfig,
    ledger: &mut Ledger,
    spend: Spend,
    hosted: bool,
) -> Result<(), ModelError> {
    let route = config.route;
    let usage = ledger.usage(route);
    if route.paid() && !hosted && usage.calls >= config.call_cap {
        return Err(ModelError::Budget);
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

// Separate client from every Planning Center client: its own builder, no shared state.
pub(crate) trait ModelHttp {
    fn post(
        &self,
        url: &str,
        key: Option<&str>,
        headers: &[(&str, &str)],
        body: &[u8],
    ) -> Result<(u16, Zeroizing<Vec<u8>>), ModelError>;
    /// A GET with the key as a bearer token: only Ozzie managed's account status (hosted.rs) uses it.
    fn get(&self, url: &str, key: Option<&str>) -> Result<(u16, Zeroizing<Vec<u8>>), ModelError> {
        let _ = (url, key);
        Err(ModelError::ProviderFailure)
    }
}
pub(crate) struct NativeModelHttp(reqwest::blocking::Client);
impl NativeModelHttp {
    pub(crate) fn new(route: Route) -> Result<Self, ModelError> {
        // Plain http is only ever reachable for a validated loopback local model.
        Self::build(route != Route::Local, Duration::from_secs(45))
    }
    /// The client for a request on `route`: the managed route's may reach a debug build's 127.0.0.1
    /// server for Ozzie managed (`HostedConfig::https_only`); every other route's is `new`'s.
    pub(crate) fn for_route(route: Route, hosted: &HostedConfig) -> Result<Self, ModelError> {
        if route == Route::Managed {
            Self::build(hosted.https_only(), Duration::from_secs(45))
        } else {
            Self::new(route)
        }
    }
    /// Ozzie managed's connect, account and revoke requests.
    pub(crate) fn hosted(hosted: &HostedConfig, timeout: Duration) -> Result<Self, ModelError> {
        Self::build(hosted.https_only(), timeout)
    }
    fn build(https_only: bool, timeout: Duration) -> Result<Self, ModelError> {
        Ok(Self(
            reqwest::blocking::Client::builder()
                .https_only(https_only)
                .no_proxy()
                .retry(reqwest::retry::never())
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(5))
                .timeout(timeout)
                .user_agent("Ozzie (https://ozzie.church)")
                .build()
                .map_err(|_| ModelError::ProviderFailure)?,
        ))
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
        key: Option<&str>,
        headers: &[(&str, &str)],
        body: &[u8],
    ) -> Result<(u16, Zeroizing<Vec<u8>>), ModelError> {
        let mut request = self
            .0
            .post(url)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json")
            .body(body.to_vec());
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        if let Some(key) = key {
            request = request.bearer_auth(key);
        }
        let response = request.send().map_err(|_| ModelError::ProviderFailure)?;
        Self::read(response)
    }
    fn get(&self, url: &str, key: Option<&str>) -> Result<(u16, Zeroizing<Vec<u8>>), ModelError> {
        let mut request = self.0.get(url).header("Accept", "application/json");
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
    let http = NativeModelHttp::for_route(config.route, &hosted)?;
    reword_with(config, ledger, request, keys, names, &http, &hosted)
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

/// Answers one Ask Ozzie question through the configured route.
pub fn ask(
    config: &RouteConfig,
    ledger: &Path,
    request: &AskRequest,
    keys: &dyn ModelKeys,
    names: &NameGuard,
) -> Result<Reply, ModelError> {
    // Everything that can refuse without a client does so first.
    let hosted = HostedConfig::current();
    config.endpoint()?;
    ask_body(config, request)?;
    check_ask(request, names)?;
    check_model(config, names)?;
    ask_route_ok(config, &hosted)?;
    let http = NativeModelHttp::new(config.route)?;
    ask_with(config, ledger, request, keys, names, &http, &hosted)
}
/// The fact-sheet Ask is the debug autopilot's comparison path: ozzie.church has no endpoint for it,
/// so on the managed route it is a debug build's direct gateway path only.
fn ask_route_ok(config: &RouteConfig, hosted: &HostedConfig) -> Result<(), ModelError> {
    if config.route == Route::Managed && !hosted.debug {
        return Err(ModelError::NotConfigured);
    }
    Ok(())
}
/// The current build's `HostedConfig`; tests choose one with the `_with` form.
#[cfg(test)]
pub(crate) fn ask_using(
    config: &RouteConfig,
    ledger: &Path,
    request: &AskRequest,
    keys: &dyn ModelKeys,
    names: &NameGuard,
    http: &dyn ModelHttp,
) -> Result<Reply, ModelError> {
    ask_with(
        config,
        ledger,
        request,
        keys,
        names,
        http,
        &HostedConfig::current(),
    )
}
pub(crate) fn ask_with(
    config: &RouteConfig,
    ledger: &Path,
    request: &AskRequest,
    keys: &dyn ModelKeys,
    names: &NameGuard,
    http: &dyn ModelHttp,
    hosted: &HostedConfig,
) -> Result<Reply, ModelError> {
    let url = config.endpoint()?;
    let body =
        serde_json::to_vec(&ask_body(config, request)?).map_err(|_| ModelError::InvalidRequest)?;
    // Before any key, budget or network: the Ask shape, and no remembered name anywhere.
    check_ask(request, names)?;
    check_model(config, names)?;
    ask_route_ok(config, hosted)?;
    complete_using(config, ledger, &url, &body, ASK_TAGS, keys, http, false)
}

/// Reword and Ask: one exchange, then the reply text and its token counts. `hosted`: the request
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
    let value = exchange.send(Spend::Call, || Ok::<(), ModelError>(()))?;
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
        let headers: &[(&str, &str)] = if self.config.route == Route::Managed && !self.hosted {
            &tagged
        } else {
            &[]
        };
        let key_text = key.as_ref().map(|k| k.as_str());
        let (status, bytes) = self.http.post(self.url, key_text, headers, self.body)?;
        drop(key);
        // Only these fixed markers are looked for; no provider text is ever returned.
        let refused_model = |bytes: &[u8]| {
            let text = String::from_utf8_lossy(bytes);
            text.contains("RestrictedModelsError") || text.contains("no_providers_available")
        };
        let refused = match status {
            _ if self.hosted => hosted::refusal(status, &bytes),
            200 => None,
            429 => Some(ModelError::RateLimited),
            _ if refused_model(&bytes) => Some(ModelError::ModelNotAllowed),
            401 | 403 => Some(ModelError::NotConfigured),
            400 | 422 => Some(ModelError::InvalidRequest),
            _ => Some(ModelError::ProviderFailure),
        };
        if let Some(error) = refused {
            return Err(error.into());
        }
        let value: Value =
            serde_json::from_slice(&bytes).map_err(|_| ModelError::ProviderFailure)?;
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
/// Writes model.json, keeping any owner-set caps. Keys are never accepted here. A changed base URL
/// changes `key_account` for an own provider, so a key saved for one host is never sent to another.
pub fn save_config(
    dir: &Path,
    route: Route,
    base_url: Option<&str>,
    model: Option<&str>,
) -> Result<RouteConfig, ModelError> {
    let mut config = RouteConfig::new(route, base_url, model)?;
    if let Some(previous) = load_config(dir) {
        config.call_cap = previous.call_cap;
        config.agent_steps_per_day = previous.agent_steps_per_day;
    }
    let bytes = serde_json::to_vec_pretty(&config).map_err(|_| ModelError::InvalidRequest)?;
    write_private(&dir.join(CONFIG_FILE), &bytes).map_err(|_| ModelError::ProviderFailure)?;
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
}
pub fn status(dir: &Path, keys: &dyn ModelKeys) -> ModelStatus {
    status_for(dir, keys, cfg!(debug_assertions))
}
/// `debug`: a debug build, where the managed route may still go straight to AI Gateway with the
/// owner's key when this Mac has no device token.
pub(crate) fn status_for(dir: &Path, keys: &dyn ModelKeys, debug: bool) -> ModelStatus {
    let Some(config) = load_config(dir) else {
        return ModelStatus {
            configured: false,
            route: "none",
            label: "No AI model set up".into(),
            setup: "no-route",
            key_account: None,
            managed: "not-connected",
            account: None,
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
        };
    }
    let configured = key_for(&config, keys).is_ok();
    // Presence only: a key under the old unbound account is looked at, never used.
    let unbound = || matches!(keys.key(LEGACY_OWN_ACCOUNT), Ok(Some(key)) if usable_key(&key));
    let setup = match (configured, config.route) {
        (true, _) => "ready",
        (false, Route::Own) if unbound() => "own-key-not-bound",
        (false, _) => "no-key",
    };
    let label = match config.route {
        Route::Own => format!("Your AI provider at {host} ({})", config.model),
        _ => format!("AI model on this Mac ({})", config.model),
    };
    ModelStatus {
        configured,
        route: config.route.name(),
        label,
        setup,
        key_account: config.key_account(),
        managed: "not-connected",
        account: None,
    }
}

#[cfg(test)]
#[path = "model_tests.rs"]
mod tests;
