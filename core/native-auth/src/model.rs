//! Model route for placeholder-only text: rewording a draft note, and Ask Ozzie questions
//! answered from a placeholder-only fact sheet.
//!
//! Open-source Ozzie lets a pastor use their own provider key or a local model; the managed
//! route goes through Vercel AI Gateway with zero data retention required on every request.
//! All three speak the OpenAI Chat Completions format.
//!
//! Apart from Planning Center's OAuth sign-in endpoints (token exchange, refresh, revoke), these
//! are the only non-GET requests Ozzie makes: one POST per call to the configured model
//! provider. They never go to Planning Center, share no client or credential with the Planning
//! Center paths, and carry only text that already passed a placeholder boundary in the webview
//! and passes the native checks here. Keys are read from the Keychain here and never leave this
//! module: not in errors, status or IPC.
use crate::credentials::{StoreError, classify_status};
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
pub const KEYCHAIN_SERVICE: &str = "church.ozzie.model.v1";
pub const CONFIG_FILE: &str = "model.json";
pub const LEDGER_FILE: &str = "model-usage.json";
pub const MAX_SYSTEM_CHARS: usize = 2000;
pub const MAX_USER_CHARS: usize = 4000;
pub const MAX_REPLY_CHARS: usize = 4000;
pub const MAX_TOKENS: u32 = 400;
/// Paid calls allowed until the owner raises `call_cap` in model.json.
pub const DEFAULT_CALL_CAP: u64 = 200;
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
    /// Keychain account under KEYCHAIN_SERVICE; a local model needs no key.
    pub fn account(self) -> Option<&'static str> {
        match self {
            Self::Managed => Some("vercel-ai-gateway"),
            Self::Own => Some("own-provider"),
            Self::Local => None,
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
}
fn default_cap() -> u64 {
    DEFAULT_CALL_CAP
}
impl RouteConfig {
    pub fn managed() -> Self {
        Self {
            route: Route::Managed,
            base_url: MANAGED_BASE.into(),
            model: MANAGED_MODEL.into(),
            call_cap: DEFAULT_CALL_CAP,
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
        };
        config.endpoint().map_err(|_| ModelError::InvalidRequest)?;
        Ok(config)
    }
    /// The one URL a request may go to: `{base}/chat/completions`.
    /// Managed is fixed; own must be https; local must be this Mac's loopback.
    pub fn endpoint(&self) -> Result<String, ModelError> {
        let refuse = Err(ModelError::NotConfigured);
        let base = self.base_url.as_str();
        let model_ok = (1..=128).contains(&self.model.len())
            && self
                .model
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._:/-".contains(&b));
        let Ok(url) = url::Url::parse(base) else {
            return refuse;
        };
        let clean = model_ok
            && self.call_cap <= 1_000_000
            && base.len() <= 256
            && !base.ends_with('/')
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
            && url.as_str().trim_end_matches('/') == base;
        // Never Planning Center, whatever the route.
        let planning_center = url.host_str().is_some_and(|host| {
            host == "planningcenteronline.com" || host.ends_with(".planningcenteronline.com")
        });
        let loopback = match url.host() {
            Some(url::Host::Ipv4(ip)) => ip == std::net::Ipv4Addr::LOCALHOST,
            Some(url::Host::Ipv6(ip)) => ip == std::net::Ipv6Addr::LOCALHOST,
            Some(url::Host::Domain(host)) => host == "localhost",
            None => false,
        };
        let allowed = match self.route {
            Route::Managed => base == MANAGED_BASE,
            Route::Own => url.scheme() == "https" && url.host().is_some(),
            Route::Local => matches!(url.scheme(), "http" | "https") && loopback,
        };
        if !clean || planning_center || !allowed {
            return refuse;
        }
        Ok(format!("{base}/chat/completions"))
    }
}

/// Read-only key source. Keys are added outside the app (macOS `security`) or by a later
/// Settings flow; nothing here writes one.
pub trait ModelKeys: Send + Sync {
    fn key(&self, account: &str) -> Result<Option<Zeroizing<String>>, StoreError>;
}
/// Keychain items under KEYCHAIN_SERVICE with plain account names, e.g.
/// `security add-generic-password -s church.ozzie.model.v1 -a vercel-ai-gateway -w`.
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
fn key_for(route: Route, keys: &dyn ModelKeys) -> Result<Option<Zeroizing<String>>, ModelError> {
    let Some(account) = route.account() else {
        return Ok(None);
    };
    match keys.key(account) {
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
    if config.route == Route::Managed {
        body["providerOptions"] = json!({"gateway": {"zeroDataRetention": true}});
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
/// Native defense in depth behind the webview's placeholder boundary: the exact request
/// shape the app produces, and no name this session has shown.
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
pub const MAX_ASK_SYSTEM_CHARS: usize = 4000;
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
    if config.route == Route::Managed {
        body["providerOptions"] = json!({"gateway": {"zeroDataRetention": true}});
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
fn ask_labels_standalone(text: &str, labels: &[(usize, usize)]) -> bool {
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
fn strip_ask_labels(text: &str, labels: &[(usize, usize)], with: &str) -> String {
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
/// 7+ digits once dates (2026-11-22, 11/22/2026) and times (9:30, 10:30-11:30, 9.30) are set
/// aside. A dotted time only counts when the dots don't run on, so "06.12.34.56.78" is a phone.
fn phone_like(groups: &[DigitGroup]) -> bool {
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
            if total >= 7 {
                return true;
            }
            total = 0;
            i += if date { 3 } else { 2 };
            continue;
        }
        total += a.digits;
        i += 1;
    }
    total >= 7
}
/// An email address, or 7+ digits (any decimal digits) whose groups are separated by one to
/// three of anything but letters, numbers and line breaks.
pub fn contact_detail(text: &str) -> bool {
    use crate::name_guard::{decimal_digit, letter_or_number, line_break};
    let chars: Vec<char> = text.chars().collect();
    if (0..chars.len()).any(|at| chars[at] == '@' && email_at(&chars, at)) {
        return true;
    }
    let mut groups: Vec<DigitGroup> = Vec::new();
    let (mut digits, mut gap) = (0usize, String::new());
    for c in chars.into_iter().chain(std::iter::once('\n')) {
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
        if !letter_or_number(c) && !line_break(c) && gap.chars().count() < 3 {
            gap.push(c);
        } else {
            if phone_like(&groups) {
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
/// for any reader that splits on it.
fn not_in_a_question(c: char) -> bool {
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
        || contact_detail(user)
        || contact_detail(&compat)
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
fn read_small(path: &Path) -> io::Result<Option<Vec<u8>>> {
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
fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
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
fn update_ledger(
    path: &Path,
    change: impl FnOnce(&mut Ledger) -> Result<(), ModelError>,
) -> Result<(), ModelError> {
    let _lock = LEDGER.lock().unwrap_or_else(|e| e.into_inner());
    // An unreadable ledger cannot prove the cap holds: refuse rather than reset it.
    let mut ledger = match read_small(path) {
        Ok(None) => Ledger::default(),
        Ok(Some(bytes)) => serde_json::from_slice(&bytes).map_err(|_| ModelError::Budget)?,
        Err(_) => return Err(ModelError::Budget),
    };
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
}
struct NativeModelHttp(reqwest::blocking::Client);
impl NativeModelHttp {
    fn new(route: Route) -> Result<Self, ModelError> {
        Ok(Self(
            reqwest::blocking::Client::builder()
                // Plain http is only ever reachable for a validated loopback local model.
                .https_only(route != Route::Local)
                .no_proxy()
                .retry(reqwest::retry::never())
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(5))
                .timeout(Duration::from_secs(45))
                .user_agent("Ozzie (https://ozzie.church)")
                .build()
                .map_err(|_| ModelError::ProviderFailure)?,
        ))
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

/// Rewords one placeholder-only draft through the configured route.
pub fn reword(
    config: &RouteConfig,
    ledger: &Path,
    request: &DraftRequest,
    keys: &dyn ModelKeys,
    names: &NameGuard,
) -> Result<Reply, ModelError> {
    // Everything that can refuse without a client does so first.
    config.endpoint()?;
    request_body(config, request)?;
    check_draft(request, names)?;
    let http = NativeModelHttp::new(config.route)?;
    reword_using(config, ledger, request, keys, names, &http)
}
pub(crate) fn reword_using(
    config: &RouteConfig,
    ledger: &Path,
    request: &DraftRequest,
    keys: &dyn ModelKeys,
    names: &NameGuard,
    http: &dyn ModelHttp,
) -> Result<Reply, ModelError> {
    let url = config.endpoint()?;
    let body = serde_json::to_vec(&request_body(config, request)?)
        .map_err(|_| ModelError::InvalidRequest)?;
    // Before any key, budget or network: the exact shape, and no remembered name.
    check_draft(request, names)?;
    complete_using(config, ledger, &url, &body, MANAGED_TAGS, keys, http)
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
    config.endpoint()?;
    ask_body(config, request)?;
    check_ask(request, names)?;
    let http = NativeModelHttp::new(config.route)?;
    ask_using(config, ledger, request, keys, names, &http)
}
pub(crate) fn ask_using(
    config: &RouteConfig,
    ledger: &Path,
    request: &AskRequest,
    keys: &dyn ModelKeys,
    names: &NameGuard,
    http: &dyn ModelHttp,
) -> Result<Reply, ModelError> {
    let url = config.endpoint()?;
    let body =
        serde_json::to_vec(&ask_body(config, request)?).map_err(|_| ModelError::InvalidRequest)?;
    // Before any key, budget or network: the Ask shape, and no remembered name anywhere.
    check_ask(request, names)?;
    complete_using(config, ledger, &url, &body, ASK_TAGS, keys, http)
}

/// Key, call cap, one POST and the closed reason codes, shared by every request kind, so Ask and
/// rewording spend from one per-route cap. Callers have already checked the request.
fn complete_using(
    config: &RouteConfig,
    ledger: &Path,
    url: &str,
    body: &[u8],
    tags: (&str, &str),
    keys: &dyn ModelKeys,
    http: &dyn ModelHttp,
) -> Result<Reply, ModelError> {
    let key = key_for(config.route, keys)?;
    let route = config.route;
    update_ledger(ledger, |ledger| {
        let usage = ledger.usage(route);
        if route.paid() && usage.calls >= config.call_cap {
            return Err(ModelError::Budget);
        }
        usage.calls += 1;
        Ok(())
    })?;
    let tagged = [tags];
    let headers: &[(&str, &str)] = if route == Route::Managed {
        &tagged
    } else {
        &[]
    };
    let (status, bytes) = http.post(url, key.as_ref().map(|k| k.as_str()), headers, body)?;
    drop(key);
    // Only these fixed markers are looked for; no provider text is ever returned.
    let refused_model = |bytes: &[u8]| {
        let text = String::from_utf8_lossy(bytes);
        text.contains("RestrictedModelsError") || text.contains("no_providers_available")
    };
    match status {
        200 => {}
        429 => return Err(ModelError::RateLimited),
        _ if refused_model(&bytes) => return Err(ModelError::ModelNotAllowed),
        401 | 403 => return Err(ModelError::NotConfigured),
        400 | 422 => return Err(ModelError::InvalidRequest),
        _ => return Err(ModelError::ProviderFailure),
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| ModelError::ProviderFailure)?;
    let text = value["choices"][0]["message"]["content"]
        .as_str()
        .filter(|text| {
            let chars = text.chars().count();
            chars > 0 && chars <= MAX_REPLY_CHARS
        })
        .ok_or(ModelError::ProviderFailure)?;
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
    Ok(Reply {
        text: text.to_owned(),
        prompt_tokens,
        completion_tokens,
    })
}

/// Saved route, or None when absent or not valid under the current rules.
pub fn load_config(dir: &Path) -> Option<RouteConfig> {
    let bytes = read_small(&dir.join(CONFIG_FILE)).ok()??;
    let config: RouteConfig = serde_json::from_slice(&bytes).ok()?;
    config.endpoint().ok()?;
    Some(config)
}
/// Writes model.json, keeping any owner-set call cap. Keys are never accepted here.
pub fn save_config(
    dir: &Path,
    route: Route,
    base_url: Option<&str>,
    model: Option<&str>,
) -> Result<RouteConfig, ModelError> {
    let mut config = RouteConfig::new(route, base_url, model)?;
    if let Some(previous) = load_config(dir) {
        config.call_cap = previous.call_cap;
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
}
pub fn status(dir: &Path, keys: &dyn ModelKeys) -> ModelStatus {
    let Some(config) = load_config(dir) else {
        return ModelStatus {
            configured: false,
            route: "none",
            label: "No AI model set up".into(),
        };
    };
    let configured = key_for(config.route, keys).is_ok();
    let host = url::Url::parse(&config.base_url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned))
        .unwrap_or_default();
    let label = match config.route {
        Route::Managed => format!("Ozzie managed AI, zero data retention ({})", config.model),
        Route::Own => format!("Your AI provider at {host} ({})", config.model),
        Route::Local => format!("AI model on this Mac ({})", config.model),
    };
    ModelStatus {
        configured,
        route: config.route.name(),
        label,
    }
}

#[cfg(test)]
#[path = "model_tests.rs"]
mod tests;
