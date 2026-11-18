//! The church's own AI key, set up inside Ozzie (onboarding spec S8, lane N5).
//!
//! A church picks a company it has heard of (OpenAI, Anthropic, Google) or "another AI company" with an https
//! address. The key comes in natively (the clipboard read once, or Ozzie's own key window; `src-tauri`'s
//! `key_sheet.rs`), is held only in memory here (`KeyDesk`), is checked with one fixed request that carries no
//! church data, and is saved in the Keychain under `own-provider:{host}` only once that check says it works. The
//! page never sees it: it gets a closed verdict (`Verdict`) and, on "works", the model status.
//!
//! Each company's request rules (`providers.json`) shape every request Ozzie sends on that route (`shape`): newer
//! OpenAI models refuse `max_tokens` and any `temperature` but the default; Anthropic's compatibility layer refuses
//! a `temperature` below 1 on current Claude models; Gemini spends its answer on thinking unless told to think
//! little. "Another AI company" keeps the body Ozzie has always sent.
use crate::credentials::StoreError;
use crate::model::{
    self, ModelError, ModelHttp, ModelKeys, ModelStatus, Route, RouteConfig, host_key_of,
};
use crate::name_guard::NameGuard;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    path::Path,
    sync::{Mutex, OnceLock},
    time::Duration,
};
use zeroize::Zeroizing;

/// The companies and local models, as data (checked by own_key_tests.rs; live-checked before release).
pub const PROVIDERS_JSON: &str = include_str!("providers.json");
/// The check's one question: no church data, no name, nothing from the page.
pub const CHECK_PROMPT: &str = "Reply with the word OK.";
/// Output tokens the check allows. Only the answer's status is read, so a cut-off answer still says "works".
pub const CHECK_TOKENS: u32 = 16;
/// How long a key not yet saved is held in memory for "Check this key again".
pub const HOLD_FOR: Duration = Duration::from_secs(15 * 60);
/// Checks allowed in any hour (spec S8c).
pub const CHECKS_PER_HOUR: usize = 10;
/// How long one check waits for the company.
pub const CHECK_TIMEOUT: Duration = Duration::from_secs(20);
/// A key's plausible length once surrounding whitespace is trimmed.
const KEY_CHARS: std::ops::RangeInclusive<usize> = 20..=512;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Catalog {
    #[serde(rename = "_comment")]
    _comment: Vec<String>,
    pub checked_on: String,
    pub verified_live: bool,
    pub presets: Vec<Preset>,
    pub local: LocalModels,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Preset {
    pub id: String,
    /// Decision 19: a company is usable only after the owner's live test passed for it; only the owner sets this.
    pub verified_live: bool,
    pub name: String,
    pub company: String,
    pub tag: Option<String>,
    /// How requests are written: "chat-completions", or "anthropic-messages" (Anthropic's own API, anthropic.rs).
    pub wire: String,
    /// The `anthropic-version` header, for the Messages wire.
    pub api_version: Option<String>,
    pub base_url: String,
    pub model: String,
    /// What a key for this company may start with (OpenAI: any `sk-` key).
    pub key_prefixes: Vec<String>,
    /// Prefixes only this company's keys have: what `owner_of` uses to say a key is another company's
    /// (`wrong-kind`). A plain `sk-` is not here: OpenRouter, DeepSeek and many others use it too (review H1).
    pub owned_prefixes: Vec<String>,
    /// Whether a key must start with one of `key_prefixes` (Google's newer keys may not: research, 2026-11-17).
    /// Either way a key whose prefix names another company is `wrong-kind`.
    pub prefix_required: bool,
    /// `max_tokens` or `max_completion_tokens`.
    pub token_field: String,
    /// Whether Ozzie's `temperature` may be sent at all.
    pub temperature: bool,
    pub reasoning_effort: Option<String>,
    /// The reasoning setting for a request that offers tools, when different (Gemini: "medium", as Google advises
    /// for tool calling; a plain request keeps the model's default). Never "none" for Gemini 3.
    pub reasoning_effort_with_tools: Option<String>,
    /// Published list prices in US dollars per million tokens, for the page's own arithmetic.
    pub price_per_million: Prices,
    /// The smallest top-up, only where the company's own page states it.
    pub min_topup: Option<String>,
    /// Not given: the page works it out from the prices, or says nothing.
    pub typical_month: Option<String>,
    pub retention_line: String,
    pub free_plan: bool,
    /// The free plan's terms say not to send personal information to it, so Ozzie never suggests it for a church.
    pub free_plan_not_for_church_data: bool,
    /// What happens to what the app sends on the free plan, when there is one.
    pub free_plan_line: Option<String>,
    /// A step the key guide must say (Anthropic: choose a workspace, and when it expires).
    pub key_note: Option<String>,
    pub pages: Pages,
}
#[derive(Deserialize, Serialize, Clone, Copy)]
#[serde(deny_unknown_fields)]
pub struct Prices {
    pub input: f64,
    pub output: f64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Pages {
    #[serde(rename = "sign-in")]
    pub sign_in: String,
    pub billing: String,
    pub keys: String,
    pub settings: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LocalModels {
    pub small: LocalModel,
    pub medium: LocalModel,
    pub large: LocalModel,
    /// Sent with every request to a model on this Mac (`local_ai::think_less`): "none" asks it not to think before it
    /// answers, as Ollama and LM Studio both take on their Chat Completions endpoint.
    pub reasoning_effort: Option<String>,
    pub ollama_download: String,
    /// How each app is started when it is installed but not answering (LM Studio's server is started by hand).
    pub ollama_start: String,
    pub lm_studio_start: String,
}
#[derive(Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct LocalModel {
    pub id: String,
    pub size_bytes: u64,
    /// Ozzie offers to download and set it up. False: it stays known only so Ozzie's own copy, and the model when Ozzie
    /// downloaded it, can still be removed (qwen3:4b, 2026-11-18: it never finished a lookup question).
    pub offered: bool,
    /// Ozzie's check and a real Ask were run against it on a Mac. Only a tested model is ever recommended.
    pub tested: bool,
}

/// The catalog. `providers.json` is built in, and own_key_tests.rs proves it parses and keeps its rules.
pub fn catalog() -> &'static Catalog {
    static CATALOG: OnceLock<Catalog> = OnceLock::new();
    CATALOG.get_or_init(|| {
        serde_json::from_str(PROVIDERS_JSON).expect("providers.json is pinned by tests")
    })
}
pub fn preset(id: &str) -> Option<&'static Preset> {
    catalog().presets.iter().find(|p| p.id == id)
}
impl Preset {
    pub fn host(&self) -> Option<String> {
        host_key_of(&self.base_url)
    }
    /// The fixed page for one of the company's steps.
    pub fn page(&self, step: &str) -> Option<&str> {
        match step {
            "sign-in" => Some(&self.pages.sign_in),
            "billing" => Some(&self.pages.billing),
            "keys" => Some(&self.pages.keys),
            "settings" => Some(&self.pages.settings),
            _ => None,
        }
    }
}
/// The preset whose host an own route's base URL names: its request rules apply to every request on it.
pub fn preset_for(config: &RouteConfig) -> Option<&'static Preset> {
    if config.route != Route::Own {
        return None;
    }
    let host = host_key_of(&config.base_url)?;
    catalog()
        .presets
        .iter()
        .find(|p| p.host().as_deref() == Some(host.as_str()))
}
/// `open_help_page`'s closed words: `{company}-{step}`, and Ollama's download page.
pub fn help_page(page: &str) -> Option<&'static str> {
    if page == "ollama-download" {
        return Some(&catalog().local.ollama_download);
    }
    if let Some((_, url)) = crate::destinations::OZZIE_PAGES
        .iter()
        .find(|(word, _)| *word == page)
    {
        return Some(url);
    }
    let (company, step) = page.split_once('-')?;
    preset(company)?.page(step)
}

/// What the page shows for each company card (no page addresses: native opens those).
#[derive(Serialize)]
pub struct ProviderView {
    pub id: &'static str,
    pub name: &'static str,
    pub company: &'static str,
    pub tag: Option<&'static str>,
    pub model: &'static str,
    pub price_per_million: Prices,
    pub min_topup: Option<&'static str>,
    pub typical_month: Option<&'static str>,
    pub retention_line: &'static str,
    pub free_plan: bool,
    pub free_plan_not_for_church_data: bool,
    pub free_plan_line: Option<&'static str>,
    pub key_note: Option<&'static str>,
    /// False until the owner's live test passed: the page shows nothing it can't use, and native refuses it anyway.
    pub verified_live: bool,
    pub checked_on: &'static str,
}
pub fn providers() -> Vec<ProviderView> {
    let catalog = catalog();
    catalog
        .presets
        .iter()
        .map(|p| ProviderView {
            id: &p.id,
            name: &p.name,
            company: &p.company,
            tag: p.tag.as_deref(),
            model: &p.model,
            price_per_million: p.price_per_million,
            min_topup: p.min_topup.as_deref(),
            typical_month: p.typical_month.as_deref(),
            retention_line: &p.retention_line,
            free_plan: p.free_plan,
            free_plan_not_for_church_data: p.free_plan_not_for_church_data,
            free_plan_line: p.free_plan_line.as_deref(),
            key_note: p.key_note.as_deref(),
            verified_live: p.verified_live,
            checked_on: &catalog.checked_on,
        })
        .collect()
}

/// The wire for Anthropic's own Messages API (anthropic.rs).
pub const ANTHROPIC_MESSAGES: &str = "anthropic-messages";
/// The headers a request on this route carries beyond the key: `anthropic-version` on the Messages wire.
pub fn route_headers(config: &RouteConfig) -> Vec<(&'static str, &'static str)> {
    match preset_for(config) {
        Some(p) if p.wire == ANTHROPIC_MESSAGES => p
            .api_version
            .as_deref()
            .map(|v| vec![(crate::anthropic::VERSION_HEADER, v)])
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}
/// Whether replies on this route come in Anthropic's Messages form (read back by `anthropic::from_messages`).
pub fn messages_wire(config: &RouteConfig) -> bool {
    preset_for(config).is_some_and(|p| p.wire == ANTHROPIC_MESSAGES)
}
/// The header the route's key travels in, chosen with the wire: Anthropic's `x-api-key` on its Messages API, a bearer
/// token on every other route (review M1, 2026-11-18).
pub fn key_header(config: &RouteConfig) -> model::KeyHeader {
    if messages_wire(config) {
        model::KeyHeader::XApiKey
    } else {
        model::KeyHeader::Bearer
    }
}
/// Applies the route's company rules to a Chat Completions body Ozzie built (rewording, Ask, agent steps and the
/// key check). Only an own route at a preset's host is changed, and a model on this Mac gets this Mac's rule.
pub fn shape(config: &RouteConfig, body: &mut Value) {
    if config.route == Route::Local {
        crate::local_ai::think_less(&config.base_url, &config.model, body);
        return;
    }
    let Some(preset) = preset_for(config) else {
        return;
    };
    let Some(object) = body.as_object_mut() else {
        return;
    };
    if preset.token_field == "max_completion_tokens"
        && let Some(tokens) = object.remove("max_tokens")
    {
        object.insert("max_completion_tokens".into(), tokens);
    }
    if !preset.temperature {
        object.remove("temperature");
    }
    let tools = object
        .get("tools")
        .and_then(Value::as_array)
        .is_some_and(|tools| !tools.is_empty());
    let effort = match (&preset.reasoning_effort_with_tools, tools) {
        (Some(with_tools), true) => Some(with_tools),
        _ => preset.reasoning_effort.as_ref(),
    };
    if let Some(effort) = effort {
        object.insert("reasoning_effort".into(), json!(effort));
    }
    if preset.wire == ANTHROPIC_MESSAGES {
        *body = crate::anthropic::to_messages(body);
    }
}

/// Where a key is to be checked: a preset, or another company's own https address and model.
#[derive(Clone)]
pub enum Choice {
    Preset(&'static Preset),
    Other { base_url: String, model: String },
}
impl Choice {
    /// `provider` as the page names it; `base_url` and `model` only for "other".
    pub fn parse(
        provider: &str,
        base_url: Option<String>,
        model: Option<String>,
    ) -> Result<Self, ModelError> {
        match (provider, base_url, model) {
            ("other", Some(base_url), Some(model)) => Ok(Self::Other { base_url, model }),
            ("other", _, _) => Err(ModelError::InvalidRequest),
            (id, None, None) => preset(id)
                .map(Self::Preset)
                .ok_or(ModelError::InvalidRequest),
            _ => Err(ModelError::InvalidRequest),
        }
    }
    /// The company's id or "other": a fixed word, never text from the person or the clipboard (review N1).
    pub fn id(&self) -> &'static str {
        match self {
            Self::Preset(p) => &p.id,
            Self::Other { .. } => "other",
        }
    }
    /// The host a key for this choice goes to, as the check request's URL names it (the parsed URL's lowercase,
    /// punycoded host, with its port): what the native confirmation for another company shows. An address the
    /// route rules refuse (not https, a user name before the host, Planning Center, a query) has none.
    pub fn destination_host(&self) -> Result<String, ModelError> {
        let config = self.config()?;
        config.endpoint()?;
        host_key_of(&config.base_url).ok_or(ModelError::InvalidRequest)
    }
    /// What a held key is bound to: the company, or another company's exact address and model.
    fn bound(&self) -> Bound {
        match self {
            Self::Preset(p) => Bound::Preset(p.id.clone()),
            Self::Other { base_url, model } => Bound::Other {
                base_url: base_url.clone(),
                model: model.clone(),
            },
        }
    }
    /// The route this key would serve, under the same rules as `set_model_route` (https, never Planning Center).
    pub fn config(&self) -> Result<RouteConfig, ModelError> {
        let (base, model) = match self {
            Self::Preset(p) => (p.base_url.as_str(), p.model.as_str()),
            Self::Other { base_url, model } => (base_url.as_str(), model.as_str()),
        };
        RouteConfig::new(Route::Own, Some(base), Some(model))
    }
}

/// The closed verdicts of "Check this key" (spec S8c; contract N5).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Verdict {
    Works,
    Refused,
    NoCredit,
    Unreachable,
    WrongKind,
    NotAKey,
    ModelUnavailable,
    SlowDown,
    DailyLimit,
    NotSaved,
    Empty,
    Cancelled,
    TooManyChecks,
    /// The company answered in a way none of the others covers (an unexpected refusal of the request itself).
    Failed,
    /// Anthropic: the key isn't scoped to a workspace. Make a new key and choose a workspace for it.
    NeedsWorkspace,
    /// An administrator's key (OpenAI `sk-admin-`, Anthropic `sk-ant-admin`): it manages an organization and is never
    /// used to ask for answers. "That's an admin key. Make an ordinary key on the keys page."
    AdminKey,
    /// The company refused this Mac's region (OpenAI: country not supported; Google: location or free tier).
    Region,
    /// A restricted key without permission to ask for answers (OpenAI: "Missing scopes").
    RestrictedKey,
    /// The company answered that it is busy or failing (5xx, 529); not this Mac's connection.
    ProviderBusy,
    /// Google needs the project set up first (free-tier verification, or access denied to the project).
    NeedsProjectSetup,
    /// Google refused more than one credential at once (an `AQ.` key may be refused on this address).
    AuthConflict,
    /// Google: the key isn't a shape Ozzie knows; the app asks natively before sending it to Google.
    ConfirmUnknownShape,
    /// Google's free plan isn't offered in this country: billing has to be turned on for the project (review F2).
    NeedsBilling,
    /// OpenAI: the account must belong to an organization before its keys work (an account problem, not the key).
    NeedsOrganization,
    /// Not a key for any AI company: the shape of another service's secret (a GitHub or Slack token, a Stripe or AWS
    /// key, a JWT, a private key). Refused before it is sent anywhere (re-check NM2): "This doesn't look like a
    /// {company} key."
    NotAnAiKey,
    /// Decision 19: this company hasn't passed Ozzie's live test yet, so it can't be used (nothing was read or sent).
    NotVerifiedYet,
    /// Another company's address answered "not found" with no word about a model: the address is likely wrong, and
    /// the key wasn't checked (review M6).
    WrongAddress,
    /// Anthropic's sign-in or session token (`sk-ant-oat`, `sk-ant-sid`), from signing in to Claude: a whole token, but
    /// not a key for apps, and never sent (review L-3).
    SignInToken,
    /// The key works, but another choice of AI was made while it was checked (`model::route_generation`): Ozzie
    /// didn't switch to it and didn't keep it, so nothing stays on this Mac that the person didn't finish choosing
    /// (review M-2).
    ChoiceChanged,
    /// "Use the key already on this Mac": no key is kept for this company any more (removed in Keychain Access, say),
    /// so nothing was sent (2026-11-18).
    NoKeptKey,
}
#[derive(Serialize)]
pub struct KeyVerdict {
    pub verdict: Verdict,
    /// Always `Choice::id`: a fixed word (review N1).
    pub provider: &'static str,
    /// With `wrong-kind` and `admin-key`: the company the key's shape belongs to.
    pub looks_like: Option<&'static str>,
    /// On `works` only.
    pub status: Option<ModelStatus>,
}
impl KeyVerdict {
    pub fn of(verdict: Verdict, choice_id: &'static str) -> Self {
        Self {
            verdict,
            provider: choice_id,
            looks_like: None,
            status: None,
        }
    }
}

/// The preset whose prefix a key starts with, the longest prefix winning ("sk-ant-" is Anthropic's, not OpenAI's).
pub fn owner_of(key: &str) -> Option<&'static Preset> {
    catalog()
        .presets
        .iter()
        .filter_map(|p| {
            p.owned_prefixes
                .iter()
                .filter(|prefix| key.starts_with(prefix.as_str()))
                .map(|prefix| prefix.len())
                .max()
                .map(|len| (len, p))
        })
        .max_by_key(|(len, _)| *len)
        .map(|(_, p)| p)
}
fn digest(key: &str) -> [u8; 32] {
    use sha2::Digest;
    sha2::Sha256::digest(key.as_bytes()).into()
}
/// The key as it will be checked: surrounding whitespace (a copied line break) trimmed, then one pair of surrounding
/// quotes (straight or curly) a copy from a document can add, then whitespace again (review F6).
pub fn trimmed(key: &str) -> &str {
    let key = key.trim_matches(|c: char| c.is_whitespace());
    for (open, close) in [
        ('"', '"'),
        ('\'', '\''),
        ('\u{201c}', '\u{201d}'),
        ('\u{2018}', '\u{2019}'),
        ('`', '`'),
    ] {
        if let Some(inner) = key.strip_prefix(open).and_then(|k| k.strip_suffix(close)) {
            return inner.trim_matches(|c: char| c.is_whitespace());
        }
    }
    key
}
/// The markers of "this account has no credit" (or has hit its own spending limit), shared by the key check and
/// normal use so they can't drift apart (review F4).
pub fn out_of_credit(status: u16, text: &str) -> bool {
    const MARKERS: [&str; 9] = [
        "credit balance",
        "API usage limits",
        "insufficient_quota",
        "credit_balance_exhausted",
        "spend_limit_exceeded",
        "usage_limit_exceeded",
        "enforced_spend_limit_reached",
        "outstanding balance",
        "billing_error",
    ];
    status == 402 || (matches!(status, 400 | 403 | 429) && MARKERS.iter().any(|m| text.contains(m)))
}
/// Shape before anything is sent: one line of printable characters with no spaces, a plausible length, and, for a
/// preset, that company's prefix. A key whose prefix names a company Ozzie knows goes only to that company's host:
/// chosen for another company at any other address, it is `wrong-kind` and nothing is sent (security review,
/// 2026-11-17, finding 2).
pub fn shape_verdict(choice: &Choice, key: &str) -> Result<(), (Verdict, Option<&'static str>)> {
    if !KEY_CHARS.contains(&key.len()) || !key.bytes().all(|b| b.is_ascii_graphic()) {
        return Err((Verdict::NotAKey, None));
    }
    if foreign_secret(key) {
        return Err((Verdict::NotAnAiKey, None));
    }
    // Administrators' keys, and Anthropic's sign-in and session tokens, are never used to ask for answers (vendor docs
    // check, 2026-11-17), by whose key they are: on that company's card and through Another AI company at any address
    // (review L2). Another company's card says whose key it is instead (`wrong-kind`, below). An administrator's key
    // names its company, so the page sends the person to the right keys page (review L-3a); a sign-in token is said as
    // what it is, never as a key cut short (review L-3b).
    let owner = owner_of(key);
    let other_card =
        matches!(choice, Choice::Preset(chosen) if owner.is_some_and(|o| o.id != chosen.id));
    match owner.map(|o| o.id.as_str()) {
        _ if other_card => {}
        Some("openai") if key.starts_with("sk-admin-") => {
            return Err((Verdict::AdminKey, Some("openai")));
        }
        Some("anthropic") if key.starts_with("sk-ant-admin") => {
            return Err((Verdict::AdminKey, Some("anthropic")));
        }
        Some("anthropic") if key.starts_with("sk-ant-oat") || key.starts_with("sk-ant-sid") => {
            return Err((Verdict::SignInToken, None));
        }
        _ => {}
    }
    // A key another AI company Ozzie recognises (but doesn't offer) is never taken for a preset's (re-check Low 3).
    if let Choice::Preset(_) = choice
        && let Some((_, company)) = OTHER_AI_PREFIXES.iter().find(|(p, _)| key.starts_with(p))
    {
        return Err((Verdict::WrongKind, Some(company)));
    }
    let accepted = |chosen: &Preset| {
        !chosen.prefix_required
            || chosen
                .key_prefixes
                .iter()
                .any(|prefix| key.starts_with(prefix.as_str()))
    };
    match (choice, owner) {
        (Choice::Preset(chosen), Some(owner)) if owner.id == chosen.id => {
            if accepted(chosen) {
                Ok(())
            } else {
                Err((Verdict::NotAKey, None))
            }
        }
        (Choice::Preset(chosen), None) if accepted(chosen) => Ok(()),
        // Google has changed its key format: a shape it doesn't know is asked about natively, unless another
        // company's own prefix names it.
        // A Google key starts with a letter or digit; anything else isn't one (review F6).
        (Choice::Preset(chosen), None)
            if chosen.id == "gemini" && !key.starts_with(|c: char| c.is_ascii_alphanumeric()) =>
        {
            Err((Verdict::NotAKey, None))
        }
        (Choice::Preset(chosen), None) if chosen.id == "gemini" => {
            match catalog().presets.iter().find(|p| {
                p.id != chosen.id && p.key_prefixes.iter().any(|x| key.starts_with(x.as_str()))
            }) {
                Some(other) => Err((Verdict::WrongKind, Some(other.id.as_str()))),
                None => Err((Verdict::ConfirmUnknownShape, None)),
            }
        }
        (Choice::Preset(_), None) => Err((Verdict::NotAKey, None)),
        (Choice::Other { .. }, None) => Ok(()),
        // Another AI company at a company's own address takes that company's key shapes only, as its card does
        // (review L-2: any other `sk-ant-` token went to Anthropic's address before).
        (Choice::Other { base_url, .. }, Some(owner))
            if host_key_of(base_url).is_some() && host_key_of(base_url) == owner.host() =>
        {
            if accepted(owner) {
                Ok(())
            } else {
                Err((Verdict::NotAKey, None))
            }
        }
        (_, Some(owner)) => Err((Verdict::WrongKind, Some(owner.id.as_str()))),
    }
}
/// Whether a key may be taken in or checked for `choice` at all: a company Ozzie knows only once its live test
/// passed (decision 19); another company always (its host is confirmed natively instead).
pub fn usable(choice: &Choice) -> Result<(), Verdict> {
    match choice {
        Choice::Preset(p) if !p.verified_live => Err(Verdict::NotVerifiedYet),
        _ => Ok(()),
    }
}
/// Prefixes of AI companies Ozzie recognises but doesn't offer as a card: their keys go only through "Another AI
/// company", at their own address.
const OTHER_AI_PREFIXES: [(&str, &str); 3] =
    [("sk-or-", "openrouter"), ("xai-", "xai"), ("gsk_", "groq")];
/// The well-known shapes of other services' secrets (re-check NM2), so one pasted by mistake is never sent.
fn foreign_secret(key: &str) -> bool {
    const PREFIXES: [&str; 19] = [
        "ghp_",
        "gho_",
        "ghu_",
        "ghs_",
        "ghr_",
        "github_pat_",
        "sk_live_",
        "sk_test_",
        "rk_live_",
        "rk_test_",
        "pk_live_",
        "pk_test_",
        "xoxb-",
        "xoxp-",
        "xoxa-",
        "xoxr-",
        "xoxs-",
        "xapp-",
        "-----BEGIN",
    ];
    let aws = (key.starts_with("AKIA") || key.starts_with("ASIA"))
        && key.len() == 20
        && key
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit());
    let jwt = key.starts_with("eyJ") && key.matches('.').count() == 2;
    PREFIXES.iter().any(|p| key.starts_with(p)) || aws || jwt
}
/// Taking a key in for `choice`. For another company the person first confirms, natively, the host the key will
/// go to (`confirm` is shown `destination_host`); only once they accept is the clipboard or key window read
/// (`read`). A company Ozzie knows has a fixed host, so nothing is asked. An address the route rules refuse is
/// refused before anyone is asked. Declined: `cancelled`; nothing to read: `empty`.
pub fn take_in(
    choice: &Choice,
    confirm: impl FnOnce(&str) -> bool,
    read: impl FnOnce() -> Option<String>,
) -> Result<Result<String, Verdict>, ModelError> {
    let host = choice.destination_host()?;
    if let Err(verdict) = usable(choice) {
        return Ok(Err(verdict));
    }
    if matches!(choice, Choice::Other { .. }) && !confirm(&host) {
        return Ok(Err(Verdict::Cancelled));
    }
    Ok(read().ok_or(Verdict::Empty))
}

/// The check request: the route's model, one fixed question, a few tokens, shaped by the company's rules. No
/// church data and no zero-retention option (an own route at AI Gateway's host keeps it, as every request does).
pub fn check_body(config: &RouteConfig) -> Value {
    let mut body = json!({
        "model": config.model,
        "messages": [{"role": "user", "content": CHECK_PROMPT}],
        "max_tokens": CHECK_TOKENS,
        "temperature": 0.4,
    });
    if config.zero_retention() {
        body["providerOptions"] = json!({"gateway": {"zeroDataRetention": true}});
    }
    shape(config, &mut body);
    body
}

/// A company's answer to the check, by status and fixed markers only. Nothing of the body is kept or returned.
pub fn classify(choice: &Choice, answer: Result<(u16, &[u8]), ModelError>) -> Verdict {
    let Ok((status, body)) = answer else {
        return Verdict::Unreachable;
    };
    let text = String::from_utf8_lossy(body);
    let has = |marker: &str| text.contains(marker);
    let gemini = matches!(choice, Choice::Preset(p) if p.id == "gemini");
    let other = matches!(choice, Choice::Other { .. });
    match status {
        200..=299 => Verdict::Works,
        // A project or key without the model is not a bad key (vendor docs check, 2026-11-17).
        401 | 403 | 404 if has("model_not_found") || has("does not have access to model") => {
            Verdict::ModelUnavailable
        }
        401 | 403 if has("FREE_TIER_VERIFICATION_REQUIRED") || has("denied access") => {
            Verdict::NeedsProjectSetup
        }
        _ if out_of_credit(status, &text) => Verdict::NoCredit,
        400 if has("free tier is not available") => Verdict::NeedsBilling,
        401 | 403 if has("must be a member of an organization") => Verdict::NeedsOrganization,
        400 if has("Multiple authentication credentials") => Verdict::AuthConflict,
        400 | 403
            if has("unsupported_country")
                || has("Country, region, or territory not supported")
                || has("User location is not supported") =>
        {
            Verdict::Region
        }
        401 | 403 if has("Missing scopes") || has("insufficient permissions") => {
            Verdict::RestrictedKey
        }
        401 | 403 => Verdict::Refused,
        // Anthropic: a key not scoped to a workspace needs a header Ozzie doesn't send; a new key with a workspace mends it.
        400 if has("anthropic-workspace-id") || has("not scoped to a workspace") => {
            Verdict::NeedsWorkspace
        }
        400 if has("API_KEY_INVALID") || has("API key not valid") => Verdict::Refused,
        // Anthropic's credit and the church's own spending limit; Google's free tier closed in the church's country.
        400 | 404 if has("model_not_found") || has("does not exist") || has("not_found_error") => {
            Verdict::ModelUnavailable
        }
        404 if other => Verdict::WrongAddress,
        404 => Verdict::ModelUnavailable,
        // Google's free tier: only a per-day quota is "try again tomorrow"; a per-minute one is slow down (review L1).
        429 if gemini && has("RESOURCE_EXHAUSTED") && has("PerDay") => Verdict::DailyLimit,
        429 => Verdict::SlowDown,
        500..=599 => Verdict::ProviderBusy,
        _ => Verdict::Failed,
    }
}

/// Saving a key that passed. Keys are written only here, under `own-provider:{host}`.
pub trait KeyStore: ModelKeys {
    fn put_key(&self, account: &str, key: &str) -> Result<(), StoreError>;
    fn delete_key(&self, account: &str) -> Result<(), StoreError>;
    /// Every account saved under `model::KEYCHAIN_SERVICE`, from the items' attributes alone: no key is read, so
    /// nothing is decrypted. A store that can't list says so (`Unavailable`, the default), and callers fall back to
    /// the accounts they already know.
    fn accounts(&self) -> Result<Vec<String>, StoreError> {
        Err(StoreError::Unavailable)
    }
}
#[cfg(target_os = "macos")]
impl KeyStore for model::KeychainKeys {
    /// `kSecReturnAttributes` only, never `kSecReturnData`, as `credentials::MacKeychain::accounts` lists sign-ins: an
    /// item that would need the person to answer a prompt is skipped rather than asked about.
    fn accounts(&self) -> Result<Vec<String>, StoreError> {
        use security_framework::item::{ItemClass, ItemSearchOptions, Limit};
        let found = ItemSearchOptions::new()
            .class(ItemClass::generic_password())
            .service(model::KEYCHAIN_SERVICE)
            .load_attributes(true)
            .limit(Limit::All)
            .skip_authenticated_items(true)
            .search();
        let items = match found {
            Ok(items) => items,
            Err(error) if error.code() == -25300 => return Ok(Vec::new()),
            Err(error) => return Err(crate::credentials::classify_status(error.code())),
        };
        Ok(items
            .iter()
            .filter_map(|item| item.simplify_dict())
            .filter_map(|attributes| attributes.get("acct").cloned())
            .collect())
    }
    fn put_key(&self, account: &str, key: &str) -> Result<(), StoreError> {
        security_framework::passwords::set_generic_password(
            model::KEYCHAIN_SERVICE,
            account,
            key.as_bytes(),
        )
        .map_err(|error| crate::credentials::classify_status(error.code()))
    }
    fn delete_key(&self, account: &str) -> Result<(), StoreError> {
        match security_framework::passwords::delete_generic_password(
            model::KEYCHAIN_SERVICE,
            account,
        ) {
            Ok(()) => Ok(()),
            Err(error) if error.code() == -25300 => Ok(()),
            Err(error) => Err(crate::credentials::classify_status(error.code())),
        }
    }
}

/// Checks one key and, only if it works, saves it and chooses the route. `key` is already trimmed. The model id
/// of another company is name-checked as `set_model_route` checks it. Not counted against the monthly limit.
pub fn check_and_save(
    dir: &Path,
    choice: &Choice,
    key: &str,
    names: &NameGuard,
    http: &dyn ModelHttp,
    store: &dyn KeyStore,
) -> Result<KeyVerdict, ModelError> {
    check_and_save_with(dir, choice, key, names, http, store, false)
}
/// `check_and_save`, once the person said yes natively to sending a key of a shape Ozzie doesn't know to Google.
fn check_and_save_with(
    dir: &Path,
    choice: &Choice,
    key: &str,
    names: &NameGuard,
    http: &dyn ModelHttp,
    store: &dyn KeyStore,
    shape_confirmed: bool,
) -> Result<KeyVerdict, ModelError> {
    // One pair of surrounding quotes and whitespace off, before every shape rule and the send (review F6).
    let key = trimmed(key);
    // A choice of AI made from here on wins over this check's result (review M-2).
    let began = model::route_generation(dir);
    // Decision 19 here too, so no caller can skip it (re-check A2b).
    if let Err(verdict) = usable(choice) {
        return Ok(KeyVerdict::of(verdict, choice.id()));
    }
    let config = choice.config()?;
    if !model::model_free_of_names(&config.model, names) {
        return Err(ModelError::NamePresent);
    }
    if let Err((verdict, looks_like)) = shape_verdict(choice, key)
        && !(shape_confirmed && verdict == Verdict::ConfirmUnknownShape)
    {
        return Ok(KeyVerdict {
            looks_like,
            ..KeyVerdict::of(verdict, choice.id())
        });
    }
    let url = config.endpoint()?;
    let body = serde_json::to_vec(&check_body(&config)).map_err(|_| ModelError::InvalidRequest)?;
    let headers = route_headers(&config);
    let answer = http.post(&url, Some((key, key_header(&config))), &headers, &body);
    let verdict = classify(
        choice,
        answer
            .as_ref()
            .map(|(s, b)| (*s, b.as_slice()))
            .map_err(|e| *e),
    );
    drop(answer);
    if verdict != Verdict::Works {
        return Ok(KeyVerdict::of(verdict, choice.id()));
    }
    let account = config.key_account().ok_or(ModelError::InvalidRequest)?;
    // Keeping the key and choosing its route are one choice: no other choice can land between them.
    let mut chosen = model::route_choice();
    if chosen.generation(dir) != began {
        // The person chose something else meanwhile. The key isn't kept: it would only be a key they never finished
        // choosing, left for them to find and remove.
        return Ok(KeyVerdict::of(Verdict::ChoiceChanged, choice.id()));
    }
    if store.put_key(&account, key).is_err() {
        return Ok(KeyVerdict::of(Verdict::NotSaved, choice.id()));
    }
    // So "Remove my key from this Mac" finds it later, whatever route is chosen by then. The host only.
    if let Some(host) = host_key_of(&config.base_url) {
        record_host(dir, &host);
    }
    chosen.save(dir, config, None)?;
    drop(chosen);
    Ok(KeyVerdict {
        status: Some(model::status(dir, store)),
        ..KeyVerdict::of(Verdict::Works, choice.id())
    })
}

/// The hosts Ozzie saved a church's own key for, in the app data folder: hosts only, never a key.
pub const OWN_KEY_HOSTS_FILE: &str = "own-key-hosts.json";
const MAX_HOSTS: usize = 20;
fn host_text_ok(host: &str) -> bool {
    (1..=253).contains(&host.len())
        && host
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b".:-".contains(&b))
}
fn recorded_hosts(dir: &Path) -> Vec<String> {
    model::read_small(&dir.join(OWN_KEY_HOSTS_FILE))
        .ok()
        .flatten()
        .and_then(|bytes| serde_json::from_slice::<Vec<String>>(&bytes).ok())
        .unwrap_or_default()
        .into_iter()
        .filter(|host| host_text_ok(host))
        .take(MAX_HOSTS)
        .collect()
}
fn record_host(dir: &Path, host: &str) {
    let mut hosts = recorded_hosts(dir);
    if !host_text_ok(host) || hosts.iter().any(|h| h == host) {
        return;
    }
    hosts.push(host.to_owned());
    hosts.truncate(MAX_HOSTS);
    if let Ok(bytes) = serde_json::to_vec(&hosts) {
        // A list that can't be kept only means a later removal checks the companies' own hosts and the route's.
        let _ = model::write_private(&dir.join(OWN_KEY_HOSTS_FILE), &bytes);
    }
}
/// The companies a key of the church's own is kept for on this Mac, one closed id per host Ozzie saved a key for, in
/// the order saved: "openai", "anthropic" or "gemini", or "other" for any other host. So "Remove my key from this Mac"
/// can name every key `remove_keys` deletes. A read of Ozzie's own list of hosts only: the Keychain isn't touched, and
/// nothing here is ever a key or any part of one. A key saved the old way, with Terminal, isn't on that list (it is
/// still removed).
pub fn saved_companies(dir: &Path) -> Vec<&'static str> {
    recorded_hosts(dir)
        .iter()
        .map(|host| {
            catalog()
                .presets
                .iter()
                .find(|p| p.host().as_deref() == Some(host.as_str()))
                .map_or("other", |p| p.id.as_str())
        })
        .collect()
}
/// Whether a Keychain account under `model::KEYCHAIN_SERVICE` holds a key of the church's own: `own-provider:{host}`,
/// or the old unbound `own-provider`. Ozzie's AI's sign-in and its key never do.
fn own_key_account(account: &str) -> bool {
    account == model::LEGACY_OWN_ACCOUNT
        || account
            .strip_prefix(model::OWN_ACCOUNT_PREFIX)
            .is_some_and(|host| !host.is_empty())
}
/// The accounts "Remove my key from this Mac" deletes when they hold a key: the hosts Ozzie saved keys for, the three
/// companies' hosts, the chosen own route's host (a key saved with Terminal), the old unbound account, and every other
/// key of the church's own the Keychain lists (`listed`): one added by hand for a host Ozzie no longer knows of once
/// another route, or none, is chosen (review L-4).
fn own_key_accounts(dir: &Path, config: Option<&RouteConfig>, listed: &[String]) -> Vec<String> {
    let own_host = config
        .filter(|c| c.route == Route::Own)
        .and_then(|c| host_key_of(&c.base_url));
    let mut accounts: Vec<String> = recorded_hosts(dir)
        .into_iter()
        .chain(catalog().presets.iter().filter_map(Preset::host))
        .chain(own_host)
        .map(|host| format!("{}{host}", model::OWN_ACCOUNT_PREFIX))
        .chain(std::iter::once(model::LEGACY_OWN_ACCOUNT.to_owned()))
        .chain(listed.iter().filter(|a| own_key_account(a)).cloned())
        .collect();
    accounts.sort();
    accounts.dedup();
    accounts
}
/// How many keys of the church's own "Remove my key from this Mac" would delete now, counted from the Keychain's item
/// attributes alone (`KeyStore::accounts`): no key is read. None when the Keychain can't list them; the page then keeps
/// offering the removal.
pub fn kept_key_count(dir: &Path, store: &dyn KeyStore) -> Option<usize> {
    let listed = store.accounts().ok()?;
    let config = model::load_config(dir);
    Some(
        own_key_accounts(dir, config.as_ref(), &listed)
            .iter()
            .filter(|account| listed.contains(account))
            .count(),
    )
}
/// "Remove my key from this Mac": what happened, in a closed word, and the status afterwards.
#[derive(Serialize)]
pub struct KeyRemoval {
    /// "removed": at least one key was deleted and none refused; "none": there was no key; "refused": this Mac's
    /// Keychain didn't let Ozzie delete one (the route is left as it was).
    pub removed: &'static str,
    pub status: ModelStatus,
}
/// Deletes every own key Ozzie knows of on this Mac (`own_key_accounts`: the same accounts `kept_key_count` counts).
/// An own route ends with its key; a model on this Mac or Ozzie's AI stays chosen. Ozzie's AI's sign-in on this Mac is
/// never touched here. Removing keys is a choice of AI: a key check under way when it happens doesn't keep its key or
/// switch to it afterwards (review M-2).
pub fn remove_keys(dir: &Path, store: &dyn KeyStore) -> KeyRemoval {
    let mut chosen = model::route_choice();
    chosen.made(dir);
    let config = model::load_config(dir);
    let listed = store.accounts().ok();
    let accounts = own_key_accounts(dir, config.as_ref(), listed.as_deref().unwrap_or_default());
    let (mut deleted, mut refused) = (false, false);
    for account in &accounts {
        // Presence from the Keychain's list when it gave one (no key read); otherwise the value is read and dropped
        // (zeroed) at once.
        let present = match &listed {
            Some(listed) => listed.contains(account),
            None => matches!(store.key(account), Ok(Some(_))),
        };
        if !present {
            continue;
        }
        match store.delete_key(account) {
            Ok(()) => deleted = true,
            Err(_) => refused = true,
        }
    }
    if !refused {
        if config.as_ref().is_some_and(|c| c.route == Route::Own) {
            let _ = chosen.clear(dir);
        }
        let _ = std::fs::remove_file(dir.join(OWN_KEY_HOSTS_FILE));
    }
    drop(chosen);
    KeyRemoval {
        removed: match (refused, deleted) {
            (true, _) => "refused",
            (false, true) => "removed",
            (false, false) => "none",
        },
        status: model::status(dir, store),
    }
}
/// "Remove this key" (kept for the page's earlier wiring): `remove_keys`, answering with the status only, or
/// `not-configured` when the Keychain refused.
pub fn remove(dir: &Path, store: &dyn KeyStore) -> Result<ModelStatus, ModelError> {
    let removal = remove_keys(dir, store);
    if removal.removed == "refused" {
        return Err(ModelError::NotConfigured);
    }
    Ok(removal.status)
}

/// Where a held key may go: the company it was taken in for, or another company's exact address and model.
#[derive(Clone, PartialEq, Eq)]
enum Bound {
    Preset(String),
    Other { base_url: String, model: String },
}
/// A held key and where it was taken in for. Not Debug: never printed.
struct Held {
    key: Zeroizing<String>,
    bound: Bound,
    /// When it was taken in, by the desk's clock (Unix ms).
    at_ms: u64,
}
/// The desk's clock in Unix milliseconds: this Mac's, or a test's.
pub type Clock = std::sync::Arc<dyn Fn() -> u64 + Send + Sync>;
/// The one key held in memory between "Paste my key" and the check that saves it, and the hourly check count.
/// Never serialized, never logged; zeroed when replaced, taken, forgotten or past `HOLD_FOR`. A held key is bound
/// to what it was taken in for (security review, 2026-11-17, finding 1): it is checked only there, or, after
/// `wrong-kind`, only with the company its own prefix names. Nothing reads it back out.
pub struct KeyDesk {
    held: Mutex<Option<Held>>,
    /// The SHA-256 of the last key that worked, until the clipboard is compared with it once (review L3).
    worked: Mutex<Option<[u8; 32]>>,
    /// When each check of the last hour was made (Unix ms).
    checks: Mutex<Vec<u64>>,
    /// A key of an unknown shape is waiting for the native yes: its check was already counted (review L4).
    shape_question: std::sync::atomic::AtomicBool,
    clock: Clock,
}
impl Default for KeyDesk {
    fn default() -> Self {
        Self::with_clock(std::sync::Arc::new(crate::sunday_check::unix_ms))
    }
}
impl KeyDesk {
    pub fn with_clock(clock: Clock) -> Self {
        Self {
            held: Mutex::new(None),
            worked: Mutex::new(None),
            checks: Mutex::new(Vec::new()),
            shape_question: std::sync::atomic::AtomicBool::new(false),
            clock,
        }
    }
    /// The app's 15-minute timer (and any look at the desk) zeroes a key held longer than HOLD_FOR (review L4).
    pub fn forget_if_expired(&self) {
        let now = (self.clock)();
        let mut held = self.held.lock().unwrap_or_else(|e| e.into_inner());
        if held
            .as_ref()
            .is_some_and(|h| now.saturating_sub(h.at_ms) > HOLD_FOR.as_millis() as u64)
        {
            *held = None;
        }
    }
    /// Holds text as it came from the clipboard or the key window for `choice`: trimmed, then held, zeroed when
    /// it goes.
    pub fn hold_text(&self, text: String, choice: &Choice) {
        let text = Zeroizing::new(text);
        self.hold(Zeroizing::new(trimmed(&text).to_owned()), choice);
    }
    /// Holds a key (already trimmed) for `choice`, replacing any other.
    pub fn hold(&self, key: Zeroizing<String>, choice: &Choice) {
        *self.held.lock().unwrap_or_else(|e| e.into_inner()) = Some(Held {
            key,
            bound: choice.bound(),
            at_ms: (self.clock)(),
        });
    }
    /// A copy of the held key for `choice`, if one is held, not too old, and may go there: where it was taken in
    /// for, or the company its own prefix names (the wrong-kind handoff, which then binds it there).
    /// `Err` when a key is held but bound elsewhere.
    fn held_for(&self, choice: &Choice) -> Result<Option<Zeroizing<String>>, ModelError> {
        let mut held = self.held.lock().unwrap_or_else(|e| e.into_inner());
        let now = (self.clock)();
        if held
            .as_ref()
            .is_some_and(|h| now.saturating_sub(h.at_ms) > HOLD_FOR.as_millis() as u64)
        {
            *held = None;
        }
        let Some(h) = held.as_mut() else {
            return Ok(None);
        };
        let wanted = choice.bound();
        if h.bound != wanted {
            // The wrong-kind handoff only between companies Ozzie knows: a key taken in for another company was
            // confirmed for that host alone, and is never re-bound without a fresh native question (review H1).
            let handoff = matches!(h.bound, Bound::Preset(_))
                && matches!(choice, Choice::Preset(p) if owner_of(&h.key).is_some_and(|o| o.id == p.id));
            if !handoff {
                return Err(ModelError::InvalidRequest);
            }
            h.bound = wanted;
        }
        Ok(Some(h.key.clone()))
    }
    /// Whether a key is held (tests only; nothing reads it back out).
    #[cfg(test)]
    fn held(&self) -> Option<()> {
        self.held
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(|_| ())
    }
    /// Whether clipboard text is exactly the key that just worked (surrounding whitespace aside), compared by digest
    /// and answered once: only then does the app clear the clipboard, never anything else copied since (review L3).
    pub fn is_the_key_that_worked(&self, text: &str) -> bool {
        let mut worked = self.worked.lock().unwrap_or_else(|e| e.into_inner());
        let same = worked.is_some_and(|d| d == digest(trimmed(text)));
        if same {
            *worked = None;
        }
        same
    }
    pub fn forget(&self) {
        *self.held.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
    /// "Use the key already on this Mac" (live in the release app, 2026-11-18): the key kept for a company Ozzie knows
    /// is read from the Keychain natively and held for that company, to be checked as a pasted key is (`check`): it
    /// goes only to that company, a choice made meanwhile wins, and nothing of it reaches the page. False, with nothing
    /// held, when no key is kept for it. Another AI company is refused: its key is found by the host the person types.
    pub fn hold_kept(&self, choice: &Choice, store: &dyn ModelKeys) -> Result<bool, ModelError> {
        if !matches!(choice, Choice::Preset(_)) {
            return Err(ModelError::InvalidRequest);
        }
        let account = choice.config()?.key_account().ok_or(ModelError::InvalidRequest)?;
        match store.key(&account) {
            Ok(Some(key)) if !trimmed(&key).is_empty() => {
                self.hold(Zeroizing::new(trimmed(&key).to_owned()), choice);
                Ok(true)
            }
            Ok(_) => Ok(false),
            Err(_) => Err(ModelError::NotConfigured),
        }
    }
    /// Counts a check, or refuses it when this hour's are spent.
    pub fn allow_check(&self) -> bool {
        let mut checks = self.checks.lock().unwrap_or_else(|e| e.into_inner());
        let now = (self.clock)();
        checks.retain(|at| now.saturating_sub(*at) < 3_600_000);
        if checks.len() >= CHECKS_PER_HOUR {
            return false;
        }
        checks.push(now);
        true
    }
    /// One check of the held key against `choice`: `empty` with none held, `too-many-checks` past the hour's ten,
    /// `invalid-request` (nothing sent) when the key is bound elsewhere. A key that works is saved and forgotten.
    /// After the native yes for a key of an unknown shape (Google only): checks the held key as `check` does.
    pub fn check_shape_confirmed(
        &self,
        dir: &Path,
        choice: &Choice,
        names: &NameGuard,
        http: &dyn ModelHttp,
        store: &dyn KeyStore,
    ) -> Result<KeyVerdict, ModelError> {
        self.check_with(dir, choice, names, http, store, true)
    }
    pub fn check(
        &self,
        dir: &Path,
        choice: &Choice,
        names: &NameGuard,
        http: &dyn ModelHttp,
        store: &dyn KeyStore,
    ) -> Result<KeyVerdict, ModelError> {
        self.check_with(dir, choice, names, http, store, false)
    }
    fn check_with(
        &self,
        dir: &Path,
        choice: &Choice,
        names: &NameGuard,
        http: &dyn ModelHttp,
        store: &dyn KeyStore,
        shape_confirmed: bool,
    ) -> Result<KeyVerdict, ModelError> {
        let Some(key) = self.held_for(choice)? else {
            return Ok(KeyVerdict::of(Verdict::Empty, choice.id()));
        };
        // The yes to the native question finishes the attempt already counted; anything else counts as one check.
        let answering = shape_confirmed
            && self
                .shape_question
                .swap(false, std::sync::atomic::Ordering::SeqCst);
        if !answering && !self.allow_check() {
            return Ok(KeyVerdict::of(Verdict::TooManyChecks, choice.id()));
        }
        let verdict = check_and_save_with(dir, choice, &key, names, http, store, answering)?;
        self.shape_question.store(
            verdict.verdict == Verdict::ConfirmUnknownShape,
            std::sync::atomic::Ordering::SeqCst,
        );
        if verdict.verdict == Verdict::Works {
            *self.worked.lock().unwrap_or_else(|e| e.into_inner()) = Some(digest(&key));
            self.forget();
        }
        // Another choice was made while it was checked: the key isn't held for later either.
        if verdict.verdict == Verdict::ChoiceChanged {
            self.forget();
        }
        Ok(verdict)
    }
}

#[cfg(test)]
#[path = "own_key_tests.rs"]
mod tests;
