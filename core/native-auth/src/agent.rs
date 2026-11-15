//! The agent loop's only path to a model: one `agent_step` (harness plan H3; the frozen interface is
//! `AgentStepRequest`/`AgentStepReply` in core/src/harness/contract.ts).
//!
//! The agent loop in the webview (Pi or plain TypeScript) is replaceable and owns none of the safety
//! pieces. Everything it wants to send is checked here first, once, before any key read, budget use
//! or network:
//!  - the task: admitted to the task ledger (ledger.rs) and running, with no step in flight and
//!    fewer than MAX_STEPS taken. Steps and tool calls are counted from the ledger's persisted
//!    model events, which only this module writes;
//!  - Ozzie's own words are pinned, not name-scanned (reviews 2026-11-14 A1 and B-S3; the shared
//!    texts in core/src/harness/fixed/, compiled in by fixed.rs): the system message is exactly
//!    the documented assembly for the task's bundled procedure (policy, "Procedure: ", title,
//!    body); every tool spec is exactly its tool-specs.json entry, for a tool in
//!    NATIVE_TOOL_ALLOWLIST (pinned to contract.ts by a test) and in that procedure, none twice;
//!    a procedure task's user message is exactly the procedure prompt ("Run this procedure now. Answer only with the JSON object.");
//!  - what varies is checked instead. An Ask task's user message is one question line under Ask's
//!    question rules (`question_ok`). Every tool message is `{"error":"<code>"}` or a tool envelope
//!    from the tool it answers that fits vocabulary.json's closed grammar (`fixed::tool_message`,
//!    A2): fixed keys and values, placeholder labels, ISO times, counts and sentences of fixed
//!    words, so no source text can ride along;
//!  - messages: the system message first, then exactly one user message, then each step's reply
//!    as an assistant message followed by tool messages answering its calls (review 2026-11-14
//!    C8). The k-th assistant message must be byte for byte the k-th reply this module returned
//!    for the task (its sha-256, `reply_hash`, is persisted in the ledger with the step), one for
//!    every reply, each after every earlier call was answered; so an assistant
//!    message can carry nothing the reply checks didn't already pass (a step that returned no
//!    reply has nothing to echo and no position). Every assistant tool call
//!    also names a tool offered in this request, carries an id this module minted for this task
//!    (`call_<step>_<n>`) and arguments that fit that tool's parameters (strings an enum value or a
//!    placeholder label); every tool message answers one earlier tool call, once. At most
//!    MAX_MESSAGES, and messages and tool specs together at most CONTEXT_CHARS serialized; a
//!    request over either is `limit` (C7: the loops count the same way, so they stop first);
//!  - the question, the model's own words (assistant text) and tool-call arguments pass the text
//!    checks: no hidden character (controls, format, private-use, Default_Ignorable_Code_Point, the
//!    blank braille pattern), no escape that spells a character (`\u`, `\x`, `&#`, a named entity
//!    such as `&shy;`, `%69`), no contact detail (`model::contact_detail_strict`, which also reads
//!    "pat [at] example [dot] org" and "555----123----4567") and no name this session has shown, on
//!    the text with labels removed, spaced, reduced to their tags and with other brackets deleted.
//!    The question and the model's words use the owner's "capitalized only" rule
//!    (`NameGuard::present_in_prose`); arguments the strict one (`present_as_word_strict`). Tool
//!    messages get the hidden-character, escape and contact checks raw, the name check on their
//!    label and time strings, and a check that their sentences of fixed words spell no run of two or
//!    more of a name's parts (`NameGuard::present_as_phrase`);
//!  - max_tokens at most 700; the model id holds no remembered name;
//!  - no background-check wording in anything that varies: the question, the model's words, tool
//!    arguments and tool results (background.rs, the page's own list; owner decision 2026-11-14:
//!    background-check facts never go to any model route, even as placeholders). Checked right after
//!    the sizes and refused as `background-check`, so the page shows its own refusal. Tool results are
//!    read one string at a time. A reply's own words that hold it are dropped when the reply arrives
//!    (`read_reply`), so they are never echoed and never refuse an ordinary task.
//!
//! A step then reads the route's key, looks at the same per-route call cap as rewording and Ask
//! and at the route's agent steps per UTC day (model.json `agent_steps_per_day`, local route
//! included), takes the step in the ledger, and only then spends from both, immediately before
//! the request is sent: a step refused for a missing key, a spent cap or by the ledger costs
//! nothing (C11); a cap another call spent in between is recorded as a `limit` step that never
//! reached the network. Managed requests (and own-provider requests to AI
//! Gateway's host) require zero data retention, and a reply on them without AI Gateway's
//! confirmation of it is refused as `provider-failure` (model.rs `Exchange::send`, owner
//! 2026-11-14); managed requests also disable hidden reasoning and
//! carry only the fixed agent tag; every route keeps model.rs's URL rules (managed fixed, own https
//! with its key bound to its host, local loopback, never Planning Center).
//!
//! Ozzie managed (hosted.rs): with a device token saved, the managed route's step goes to
//! ozzie.church's `/api/v1/agent-step` with the token, its body the exact request every check above
//! accepted plus `kind` ("ask" or "procedure"); ozzie.church writes the gateway request (zero data
//! retention, reasoning off) and answers in the gateway's reply shape, which `read_reply` reads here
//! as before. Only the address, the body's outer shape and the authorization change; a spent church
//! allowance is `allowance-paused`.
//!
//! A final reply (no tool calls) must be the closed answer form and nothing else (structured
//! answers, review 2026-11-14 section C; `fixed::final_answer`): a JSON object choosing fact ids
//! (and a draft id) that the tool results in this very request hold, so the model writes no prose
//! about anyone; anything else is `invalid-answer` and the reply is dropped. Ozzie writes the
//! sentences on the Mac (core/src/harness/compose.ts).
//!
//! Replies are checked the same way before the webview sees them: only tools offered in this
//! request (a call to any other is `denied` and the reply dropped), arguments that fit the offered
//! parameters and are at most 2000 characters, no more tool calls than the task has left of
//! MAX_TOOL_CALLS, content of at most 4000 characters, no name (under the "capitalized only" rule
//! for the text), contact detail or hidden character anywhere.
//! Tool-call ids are minted here (`call_<step>_<n>`) and their number persisted with the step's
//! outcome, so neither provider text nor free text travels in an id; the loop must echo them
//! unchanged. Tool names carry dots in the contract but
//! providers accept only `[A-Za-z0-9_-]`, so on the wire each `.` is `__` (no allowlisted name
//! contains `__`).
//!
//! Errors are a closed vocabulary (`AgentError`); nothing from a request, a reply or a key is ever
//! carried, and keys stay inside model.rs.
use crate::background::{self, background_wording};
use crate::fixed;
use crate::hosted::{self, HostedConfig};
use crate::ledger::{StepRefusal, StepView, TaskKind, TaskLedger, task_id_ok};
use crate::model::{
    self, Exchange, ModelError, ModelHttp, ModelKeys, NativeModelHttp, RouteConfig, Spend, Target,
};
use crate::name_guard::{self, NameGuard};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

/// A request as it arrives over IPC, parsed by `parse_request` so a malformed one gets a closed code.
pub use serde_json::Value as Json;

/// Every tool name that may ever exist in v1 (contract.ts NATIVE_TOOL_ALLOWLIST, pinned by a test).
pub const NATIVE_TOOL_ALLOWLIST: [&str; 13] = [
    "sunday.overview",
    "sunday.open_needs",
    "sunday.who_could_help",
    "sunday.pending_requests",
    "sunday.rule_checkins",
    "sunday.not_checked",
    "rooms.conflicts",
    "followups.unowned",
    "groups.clashes",
    "today.attention",
    "rules.current",
    "planning_center.refresh",
    "drafts.prepare_note",
];
// HARNESS_LIMITS in contract.ts, pinned by a test.
/// Model calls per task.
pub const MAX_STEPS: u8 = 6;
/// Tool calls per task, across all its steps.
pub const MAX_TOOL_CALLS: usize = 10;
/// Output tokens per step.
pub const MAX_TOKENS: u32 = 700;
/// One tool result sent to the model.
pub const ENVELOPE_CHARS: usize = 6_000;
/// The whole conversation in one step, tool specs included, serialized.
pub const CONTEXT_CHARS: usize = 40_000;
// Native ceilings the contract leaves open. The tool specs are pinned to tool-specs.json, which a
// test keeps within the description and property ceilings.
pub const MAX_TOOLS: usize = NATIVE_TOOL_ALLOWLIST.len();
pub const MAX_MESSAGES: usize = 32;
pub const MAX_DESCRIPTION_CHARS: usize = 400;
pub const MAX_PROPERTIES: usize = 8;
pub const MAX_PROPERTY_DESCRIPTION_CHARS: usize = 200;
pub const MAX_USER_CHARS: usize = 8_000;
pub const MAX_ARGUMENT_CHARS: usize = 2_000;
/// Integer tool arguments stay within this magnitude (a count, a page), so no number can carry a
/// phone number.
pub const MAX_ARGUMENT_INTEGER: i64 = 100_000;
pub const MAX_REPLY_CHARS: usize = 4_000;
/// Fixed reporting tags for agent steps, as MANAGED_TAGS and ASK_TAGS are. Never `ai-reporting-user`.
pub const AGENT_TAGS: (&str, &str) = ("ai-reporting-tags", "app:ozzie,route:managed,feature:agent");
const TEMPERATURE: f64 = 0.2;
/// Label kinds the placeholder boundary writes as `[Kind N]` or `[Kind A]` (contract.ts ToolEnvelope:
/// "[Person 1], [Role 1], [Room 1] …"). Only the name check uses this list, to see past a label's
/// own word; bracketed text of any other shape is name-checked like the rest of the text.
const LABEL_KINDS: [&str; 14] = [
    "Person",
    "Role",
    "Room",
    "Team",
    "Group",
    "Event",
    "Leader",
    "Volunteer",
    "Service",
    "Location",
    "Resource",
    "Position",
    "Workflow",
    "Step",
];
const FIXED_LABELS: [&str; 3] = ["[Your name]", "[a team member]", "[Role]"];

/// The closed error vocabulary. Nothing from a request, a reply, a provider body or a key.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentError {
    /// Something crossing to or from the model failed a native check: its shape, a tool outside the
    /// allowlist, the task's procedure or this request, a size limit, a hidden character, a contact
    /// detail or a name this session has shown. Nothing was sent, or the reply was dropped.
    Egress,
    /// The reply called a tool this task wasn't offered: one outside the allowlist (the model
    /// invented it) or one its procedure doesn't use. The reply was dropped, so the name is never
    /// returned; the loop fails the task as `denied` (contract.ts FailureCode).
    Denied,
    /// This task has taken MAX_STEPS model steps (or its ledger events are full), its request is
    /// over MAX_MESSAGES or CONTEXT_CHARS, or a reply asked for more tool calls than the task has
    /// left.
    Limit,
    /// The task isn't in the task ledger, isn't running (admit it and move it to running first;
    /// a cancelled or finished task takes no more steps), or a step for it is already in flight.
    InvalidTask,
    /// The task ledger couldn't be opened or written; nothing was sent, or the reply was dropped
    /// because its step couldn't be recorded.
    LedgerUnavailable,
    NotConfigured,
    /// The route's paid call cap (model.json `call_cap`) is spent.
    Budget,
    /// Today's agent steps on this route (model.json `agent_steps_per_day`) are spent.
    DailyLimit,
    RateLimited,
    ProviderFailure,
    /// The provider refused the request as malformed (400/422).
    InvalidRequest,
    ModelNotAllowed,
    /// The model's final reply wasn't the closed answer form (prose, another key, a malformed
    /// id) or chose a fact or draft id no tool result in the request holds. The reply was dropped;
    /// the loop fails the task as `fidelity`.
    InvalidAnswer,
    /// Ozzie managed: the church's allowance on ozzie.church is spent; AI help is paused until it
    /// resets or the plan changes. Checks and briefings keep working.
    AllowancePaused,
    /// Ozzie managed: ozzie.church refused the step as holding a phone number or email address.
    /// Nothing went to the AI; the loop fails the task as `egress`.
    ContactDetail,
    /// Background-check wording in what varies (the question, the model's own words, tool arguments
    /// or tool results; background.rs, owner decision 2026-11-14), found here before any key, budget,
    /// step or network, or by ozzie.church before the AI. Nothing went to the AI; the loop fails the
    /// task as `egress`, the only thing the ledger records of it.
    BackgroundCheck,
}
impl From<ModelError> for AgentError {
    fn from(error: ModelError) -> Self {
        match error {
            ModelError::NotConfigured => Self::NotConfigured,
            ModelError::Budget => Self::Budget,
            ModelError::DailyLimit => Self::DailyLimit,
            ModelError::RateLimited => Self::RateLimited,
            ModelError::ProviderFailure => Self::ProviderFailure,
            ModelError::InvalidRequest => Self::InvalidRequest,
            ModelError::ModelNotAllowed => Self::ModelNotAllowed,
            ModelError::NamePresent => Self::Egress,
            ModelError::AllowancePaused => Self::AllowancePaused,
            ModelError::ContactDetail => Self::ContactDetail,
            ModelError::BackgroundCheck => Self::BackgroundCheck,
            // Rewording's alone; an agent step's hidden characters are refused as `egress`.
            ModelError::HiddenCharacter => Self::Egress,
            // ozzie.church counts the task's steps too: the same limit the ledger keeps here.
            ModelError::StepLimit => Self::Limit,
        }
    }
}
impl From<StepRefusal> for AgentError {
    fn from(refusal: StepRefusal) -> Self {
        match refusal {
            StepRefusal::Task => Self::InvalidTask,
            StepRefusal::Limit => Self::Limit,
            StepRefusal::Unavailable => Self::LedgerUnavailable,
        }
    }
}

// Mirrors of contract.ts. Not Debug: they carry text that is never logged.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "role", rename_all = "lowercase", deny_unknown_fields)]
pub enum AgentMessage {
    System {
        content: String,
    },
    User {
        content: String,
    },
    Assistant {
        content: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        tool_calls: Vec<AgentToolCall>,
    },
    Tool {
        tool_call_id: String,
        content: String,
    },
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolProperty {
    #[serde(rename = "type")]
    pub kind: String,
    pub description: String,
    #[serde(rename = "enum", default, skip_serializing_if = "Option::is_none")]
    pub values: Option<Vec<String>>,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolParameters {
    #[serde(rename = "type")]
    pub kind: String,
    pub properties: BTreeMap<String, ToolProperty>,
    pub required: Vec<String>,
    #[serde(rename = "additionalProperties")]
    pub additional_properties: bool,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    pub parameters: ToolParameters,
}
/// Serialized only as the body ozzie.church takes (`hosted_step_body`): the contract's own shape.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentStepRequest {
    pub task_id: String,
    pub messages: Vec<AgentMessage>,
    pub tools: Vec<ToolSpec>,
    pub max_tokens: u32,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Finish {
    Stop,
    ToolCalls,
    Length,
}
#[derive(Clone, PartialEq, Eq, Serialize)]
pub struct AgentStepReply {
    pub content: String,
    pub tool_calls: Vec<AgentToolCall>,
    pub finish: Finish,
}

/// Parses an IPC request. Any shape the contract doesn't allow (an unknown field or role, a missing
/// field, a wrong type) is `egress`; serde's message, which can quote the input, is dropped.
pub fn parse_request(value: Json) -> Result<AgentStepRequest, AgentError> {
    serde_json::from_value(value).map_err(|_| AgentError::Egress)
}

fn chars_within(text: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&text.chars().count())
}
fn nfkc(text: &str) -> String {
    icu_normalizer::ComposingNormalizerBorrowed::new_nfkc()
        .normalize(text)
        .into_owned()
}
/// Line breaks other than `\n`, controls other than `\t`, format, private-use and surrogate
/// characters (Ask's question rule, `not_in_a_question`, with ordinary newlines and tabs allowed),
/// and every invisible character: Default_Ignorable_Code_Point (Hangul fillers U+115F, U+1160,
/// U+3164, U+FFA0, variation selectors, …) and the blank braille pattern U+2800; and the
/// background-check list's newer characters (`background::newer`, review B3 L-1).
fn hidden(c: char) -> bool {
    c != '\n'
        && c != '\t'
        && (model::not_in_a_question(c) || name_guard::invisible(c) || background::newer(c))
}
/// `\u…`, `\x…`, `&#…`, a named HTML entity (`&shy;`, `&nbsp;`) or a percent-escape (`%69`): text
/// a model could decode into characters the checks never saw.
fn spelled_escape(text: &str) -> bool {
    let bytes = text.as_bytes();
    let hex = |at: usize| bytes.get(at).is_some_and(u8::is_ascii_hexdigit);
    text.contains("&#")
        || text
            .match_indices('\\')
            .any(|(at, _)| matches!(bytes.get(at + 1), Some(b'u' | b'U' | b'x' | b'X')))
        || text
            .match_indices('%')
            .any(|(at, _)| hex(at + 1) && hex(at + 2))
        || text.match_indices('&').any(|(at, _)| {
            let name = bytes[at + 1..]
                .iter()
                .take_while(|b| b.is_ascii_alphanumeric())
                .count();
            (2..=31).contains(&name) && bytes.get(at + 1 + name) == Some(&b';')
        })
}
/// Contact details (`model::contact_detail_strict`), raw and NFKC.
fn contact(text: &str) -> bool {
    model::contact_detail_strict(text) || model::contact_detail_strict(&nfkc(text))
}
/// Byte length of the placeholder label at the start of `text`: a fixed label, or `[Kind N]`
/// (N is 1 to 9999 with no leading zero) or `[Kind A]` (one capital letter) for a kind in LABEL_KINDS.
fn label_len(text: &str) -> Option<usize> {
    if let Some(fixed) = FIXED_LABELS.iter().find(|fixed| text.starts_with(**fixed)) {
        return Some(fixed.len());
    }
    let rest = text.strip_prefix('[')?;
    let kind = LABEL_KINDS.iter().find(|kind| {
        rest.strip_prefix(**kind)
            .is_some_and(|r| r.starts_with(' '))
    })?;
    let tag = &rest[kind.len() + 1..];
    let digits = tag.bytes().take_while(u8::is_ascii_digit).count();
    let width = match tag.as_bytes() {
        [b'A'..=b'Z', b']', ..] => 1,
        _ if (1..=4).contains(&digits) && !tag.starts_with('0') => digits,
        _ => return None,
    };
    (tag.as_bytes().get(width) == Some(&b']')).then_some(1 + kind.len() + 1 + width + 1)
}
fn label_ranges(text: &str) -> Vec<(usize, usize)> {
    let mut found = Vec::new();
    let mut at = 0;
    while let Some(offset) = text[at..].find('[') {
        let start = at + offset;
        match label_len(&text[start..]) {
            Some(len) => {
                found.push((start, start + len));
                at = start + len;
            }
            None => at = start + 1,
        }
    }
    found
}
/// Every innermost `[`…`]`, whatever is inside, so a name can't be glued together through
/// bracketed text that isn't a known label ("Ri[x]ley").
fn bracket_ranges(text: &str) -> Vec<(usize, usize)> {
    let mut found = Vec::new();
    let mut open = None;
    for (at, c) in text.char_indices() {
        match c {
            '[' => open = Some(at),
            ']' => {
                if let Some(start) = open.take() {
                    found.push((start, at + 1));
                }
            }
            _ => {}
        }
    }
    found
}
/// The text with each known label reduced to its tag (the number or letter of `[Person 1]`,
/// nothing for a fixed label) and every other square bracket deleted with its contents kept, so a
/// name split by brackets ("R[i]ley", "[R]iley") or continued from a label's tag ("[Person
/// R]iley") reads whole, while a label's own word ("Person") is never read as a name.
fn unbracketed(text: &str, labels: &[(usize, usize)]) -> String {
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    for &(start, end) in labels {
        out.push_str(&text[last..start]);
        let label = &text[start..end];
        if !FIXED_LABELS.contains(&label)
            && let Some((_, tag)) = label[..label.len() - 1].rsplit_once(' ')
        {
            out.push_str(tag);
        }
        last = end;
    }
    out.push_str(&text[last..]);
    out.replace(['[', ']'], "")
}
/// Which name rule a text is held to.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Rule {
    /// Tool-call arguments and tool-message slots: `NameGuard::present_as_word_strict`.
    Strict,
    /// The question and the model's own words: `NameGuard::present_in_prose` ("capitalized only").
    Prose,
}
/// The name rule, raw and NFKC, on the text with labels removed outright and replaced by spaces
/// (as `check_ask` does), the same with every innermost bracketed run removed, and the text with
/// labels reduced to their tags and other brackets deleted (`unbracketed`). JSON's own brackets rule
/// out Ask's every-bracket-is-a-label grammar here, so bracketed text that isn't a known label stays
/// in the label variants and is checked like any other text ("[Riley 1]"), while the others see
/// through it ("Ri[x]ley").
fn named(text: &str, names: &NameGuard, rule: Rule) -> bool {
    let found = |text: &str| match rule {
        Rule::Strict => names.present_as_word_strict(text),
        Rule::Prose => names.present_in_prose(text),
    };
    let compat = nfkc(text);
    let forms: &[&str] = if compat == text {
        &[text]
    } else {
        &[text, compat.as_str()]
    };
    forms.iter().any(|form| {
        if !form.contains(['[', ']']) {
            return found(form);
        }
        let (labels, brackets) = (label_ranges(form), bracket_ranges(form));
        let mut variants = vec![
            model::strip_ask_labels(form, &labels, ""),
            model::strip_ask_labels(form, &labels, " "),
            model::strip_ask_labels(form, &brackets, ""),
            model::strip_ask_labels(form, &brackets, " "),
            unbracketed(form, &labels),
        ];
        variants.sort_unstable();
        variants.dedup();
        variants.iter().any(|variant| found(variant))
    })
}
fn json_strings<'a>(value: &'a Value, out: &mut Vec<&'a str>) {
    match value {
        Value::String(text) => out.push(text),
        Value::Array(items) => items.iter().for_each(|item| json_strings(item, out)),
        Value::Object(map) => map.iter().for_each(|(key, item)| {
            out.push(key);
            json_strings(item, out);
        }),
        _ => {}
    }
}
/// The text checks (see the module comment) under the strict name rule: tool-call arguments.
fn text_ok(text: &str, names: &NameGuard) -> bool {
    text_ok_at(text, names, Rule::Strict, 0)
}
/// The text checks under the "capitalized only" name rule: the question and the model's words.
fn prose_ok(text: &str, names: &NameGuard) -> bool {
    text_ok_at(text, names, Rule::Prose, 0)
}
fn text_ok_at(text: &str, names: &NameGuard, rule: Rule, depth: usize) -> bool {
    if text.chars().any(hidden) || spelled_escape(text) || contact(text) || named(text, names, rule)
    {
        return false;
    }
    // JSON text (tool results, arguments): every decoded key and string as well, since a model reads
    // through JSON escapes. Nesting deeper than this is refused rather than unpacked further.
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return true;
    };
    let mut strings = Vec::new();
    json_strings(&value, &mut strings);
    strings.is_empty()
        || (depth < 4
            && strings
                .iter()
                .all(|s| text_ok_at(s, names, rule, depth + 1)))
}
/// Byte length of a label a question may hold at the start of `text`: a vocabulary family's
/// `[<family> <n>]` (fixed.rs), `[a team member]` or `[Your name]`.
fn question_label_len(text: &str) -> Option<usize> {
    fixed::envelope_label_len(text).or_else(|| {
        ["[a team member]", "[Your name]"]
            .into_iter()
            .find(|fixed| text.starts_with(fixed))
            .map(str::len)
    })
}
/// Every square bracket in `text` belongs to a question label that stands alone (Ask's rule,
/// `model::ask_labels_standalone`), so no name can be glued on through one.
fn question_labels_ok(text: &str) -> bool {
    let mut labels = Vec::new();
    let mut at = 0;
    while let Some(offset) = text[at..].find(['[', ']']) {
        let start = at + offset;
        let Some(len) = question_label_len(&text[start..]) else {
            return false;
        };
        labels.push((start, start + len));
        at = start + len;
    }
    model::ask_labels_standalone(text, &labels)
}
/// A character no Ask question may hold: a line break, control, format, private-use or invisible
/// character, or one of the background-check list's newer characters (review B3 L-1). The page
/// refuses the same before anything is sent (core/src/ask.ts `hiddenInQuestion`).
pub(crate) fn hidden_in_question(text: &str) -> bool {
    text.chars()
        .any(|c| model::not_in_a_question(c) || name_guard::invisible(c) || background::newer(c))
}
/// An Ask task's user message: one question line under Ask's question rules (model.rs `check_ask`):
/// at most MAX_ASK_QUESTION_CHARS, no hidden character (`hidden_in_question`), every square
/// bracket a placeholder label standing alone (raw and NFKC), and the text checks under the
/// "capitalized only" name rule.
fn question_ok(text: &str, names: &NameGuard) -> bool {
    chars_within(text, 1, model::MAX_ASK_QUESTION_CHARS)
        && !hidden_in_question(text)
        && question_labels_ok(text)
        && question_labels_ok(&nfkc(text))
        && prose_ok(text, names)
}
/// A tool message that answers a call to `tool`: within ENVELOPE_CHARS, no hidden character,
/// escape or contact detail in its raw text, and `{"error":"<code>"}` or an envelope from that
/// tool that fits the closed grammar (`fixed::tool_message`), whose label and time strings name no
/// one and whose sentences of fixed words spell no run of a name's parts
/// (`NameGuard::present_as_phrase`, labels set aside as a break).
pub(crate) fn tool_message_ok(content: &str, tool: &str, names: &NameGuard) -> bool {
    if !chars_within(content, 1, ENVELOPE_CHARS)
        || content.chars().any(hidden)
        || spelled_escape(content)
        || contact(content)
    {
        return false;
    }
    match fixed::tool_message(content) {
        Some(fixed::ToolMessage::Error) => true,
        Some(fixed::ToolMessage::Envelope {
            tool: from,
            slots,
            sentences,
            ..
        }) => {
            // A label between two words breaks a phrase rather than joining it.
            let phrase = |text: &String| {
                names.present_as_phrase(&model::strip_ask_labels(text, &label_ranges(text), " 0 "))
            };
            from == tool
                && !slots.iter().any(|slot| named(slot, names, Rule::Strict))
                && !sentences.iter().any(phrase)
        }
        None => false,
    }
}
/// A JSON object of at most MAX_ARGUMENT_CHARS, no key repeated, that fits the tool's parameters:
/// only its properties and every required one, each of its declared type (a string: from the enum
/// when the property has one, otherwise a whole placeholder label, of the property's own family
/// when it is named for one, such as `role`; an integer within MAX_ARGUMENT_INTEGER; true or
/// false); no hidden character, escape or contact detail in its raw text, and every string value
/// passes `text_ok`.
fn arguments_ok(arguments: &str, parameters: &ToolParameters, names: &NameGuard) -> bool {
    if !chars_within(arguments, 2, MAX_ARGUMENT_CHARS) {
        return false;
    }
    let Some(Value::Object(map)) = fixed::parse_unique(arguments) else {
        return false;
    };
    let label_for = |key: &str, text: &str| {
        let family = fixed::vocabulary()
            .families
            .iter()
            .find(|family| family.eq_ignore_ascii_case(key));
        fixed::envelope_label_len(text) == Some(text.len())
            && family.is_none_or(|family| text[1..].starts_with(&format!("{family} ")))
    };
    let typed = map.iter().all(|(key, value)| {
        parameters.properties.get(key).is_some_and(|property| {
            match (property.kind.as_str(), value) {
                ("string", Value::String(text)) => match &property.values {
                    Some(values) => values.contains(text),
                    None => label_for(key, text),
                },
                ("integer", Value::Number(n)) => {
                    n.as_i64().is_some_and(|n| n.abs() <= MAX_ARGUMENT_INTEGER)
                }
                ("boolean", Value::Bool(_)) => true,
                _ => false,
            }
        })
    });
    // The keys are the spec's own property names, so only the raw text and the values are
    // checked: a member named Person or Role can't stop a call to a tool that takes one.
    typed
        && parameters.required.iter().all(|key| map.contains_key(key))
        && !arguments.chars().any(hidden)
        && !spelled_escape(arguments)
        && !contact(arguments)
        && map
            .values()
            .filter_map(Value::as_str)
            .all(|value| text_ok(value, names))
}
/// `call_<step>_<n>` as `read_reply` mints it (step 1-99, n 0-99, no leading zeros), as numbers.
fn call_id(id: &str) -> Option<(usize, usize)> {
    let number = |part: &str| {
        let ok = (1..=2).contains(&part.len())
            && part.bytes().all(|b| b.is_ascii_digit())
            && (part == "0" || !part.starts_with('0'));
        ok.then(|| part.parse::<usize>().ok()).flatten()
    };
    let (step, n) = id.strip_prefix("call_")?.split_once('_')?;
    let step = number(step).filter(|&s| s >= 1)?;
    Some((step, number(n)?))
}
/// An id this module minted for this task: its step finished and minted more than n calls.
fn minted_here(id: &str, minted: &[u8]) -> bool {
    call_id(id).is_some_and(|(step, n)| minted.get(step - 1).is_some_and(|&m| n < usize::from(m)))
}
fn allowlisted(name: &str) -> bool {
    NATIVE_TOOL_ALLOWLIST.contains(&name)
}
/// The sha-256 (lowercase hex) of a reply as the loop must echo it back: its content and tool
/// calls, serialized as one JSON array. Persisted in the ledger with the step (C8).
pub fn reply_hash(content: &str, tool_calls: &[AgentToolCall]) -> String {
    serde_json::to_string(&(content, tool_calls))
        .map_or_else(|_| String::new(), |text| fixed::sha256_hex(&text))
}
/// The provider-facing tool name: providers accept `[A-Za-z0-9_-]` only.
pub fn wire_name(name: &str) -> String {
    name.replace('.', "__")
}

/// Allowlisted tools the task's procedure may use, each once, each exactly its canonical spec in
/// tool-specs.json (pinned, so never name-scanned).
fn tools_ok(tools: &[ToolSpec], skill: &fixed::BundledSkill) -> bool {
    let mut seen = BTreeSet::new();
    tools.len() <= MAX_TOOLS
        && tools.iter().all(|tool| {
            allowlisted(&tool.name)
                && skill.tools.contains(&tool.name)
                && seen.insert(tool.name.as_str())
                && fixed::tool_spec(&tool.name) == Some(tool)
        })
}
/// What the messages of one task's request are checked against.
struct Expected<'a> {
    /// The exact system message for the task's procedure.
    system: &'a str,
    /// An Ask task (a question) or a procedure task (the procedure prompt).
    ask: bool,
    /// Tool calls each finished step minted (`StepView::minted`).
    minted: &'a [u8],
    /// Each finished step's reply hash (`StepView::replies`); empty for a step with no reply.
    replies: &'a [String],
}
/// Whether a request fits MAX_MESSAGES and CONTEXT_CHARS: messages and tool specs serialized, in
/// characters, as the loops count them (core/src/harness/limits.ts `contextSize`).
fn size_ok(messages: &[AgentMessage], tools: &[ToolSpec]) -> bool {
    let chars = |json: serde_json::Result<String>| json.ok().map(|text| text.chars().count());
    messages.len() <= MAX_MESSAGES
        && chars(serde_json::to_string(messages))
            .zip(chars(serde_json::to_string(tools)))
            .is_some_and(|(messages, tools)| messages + tools <= CONTEXT_CHARS)
}
fn messages_ok(
    messages: &[AgentMessage],
    tools: &[ToolSpec],
    expected: &Expected,
    names: &NameGuard,
) -> bool {
    if messages.len() < 2 || !matches!(messages[0], AgentMessage::System { .. }) {
        return false;
    }
    let offered = |name: &str| tools.iter().find(|tool| tool.name == name);
    // Tool-call id -> (answered yet, the tool it calls).
    let mut calls: BTreeMap<&str, (bool, &str)> = BTreeMap::new();
    let mut total_calls = 0;
    let mut replies = expected.replies.iter().filter(|hash| !hash.is_empty());
    let ok = messages
        .iter()
        .enumerate()
        .all(|(at, message)| match message {
            // Pinned: compared, never scanned.
            AgentMessage::System { content } => at == 0 && content == expected.system,
            // Exactly one user message, straight after the system message.
            AgentMessage::User { content } => {
                at == 1
                    && chars_within(content, 1, MAX_USER_CHARS)
                    && if expected.ask {
                        question_ok(content, names)
                    } else {
                        !fixed::procedure_prompt().is_empty()
                            && content == fixed::procedure_prompt()
                    }
            }
            // The next step's reply, byte for byte, once every earlier call was answered.
            AgentMessage::Assistant {
                content,
                tool_calls,
            } => {
                total_calls += tool_calls.len();
                at >= 2
                    && calls.values().all(|(answered, _)| *answered)
                    && replies
                        .next()
                        .is_some_and(|hash| *hash == reply_hash(content, tool_calls))
                    && (!content.is_empty() || !tool_calls.is_empty())
                    && total_calls <= MAX_TOOL_CALLS
                    && chars_within(content, 0, MAX_REPLY_CHARS)
                    && prose_ok(content, names)
                    && tool_calls.iter().all(|call| {
                        minted_here(&call.id, expected.minted)
                            && calls
                                .insert(call.id.as_str(), (false, call.name.as_str()))
                                .is_none()
                            && allowlisted(&call.name)
                            && offered(&call.name).is_some_and(|tool| {
                                arguments_ok(&call.arguments, &tool.parameters, names)
                            })
                    })
            }
            AgentMessage::Tool {
                tool_call_id,
                content,
            } => calls
                .get_mut(tool_call_id.as_str())
                .is_some_and(|(answered, tool)| {
                    !std::mem::replace(answered, true) && tool_message_ok(content, tool, names)
                }),
        });
    // Every reply echoed, and every call answered.
    ok && replies.next().is_none() && calls.values().all(|(answered, _)| *answered)
}
/// Whether anything that varies holds background-check wording (background.rs): the user message,
/// the model's own words and tool-call arguments, and every tool message, one string at a time. The
/// system message and the tool specs are Ozzie's own words, pinned byte for byte by `messages_ok` and
/// `tools_ok` in the same check (a request whose system message isn't the procedure's exact text is
/// refused as `egress`), so they are not scanned; a test shows none of them holds the wording. The
/// model's own words can only be here if a reply carried them, and `read_reply` drops those first
/// (review B M1), so an ordinary task is never refused for what the model wrote.
fn background_in(messages: &[AgentMessage]) -> bool {
    messages.iter().any(|message| match message {
        AgentMessage::System { .. } => false,
        AgentMessage::User { content } => background_wording(content),
        AgentMessage::Tool { content, .. } => background::in_tool_result(content),
        AgentMessage::Assistant {
            content,
            tool_calls,
        } => {
            background_wording(content)
                || tool_calls
                    .iter()
                    .any(|call| background_wording(&call.arguments))
        }
    })
}
/// Every native check on a request against the task as the ledger holds it (see the module
/// comment). Runs before any key, budget or network.
pub fn check_step(
    request: &AgentStepRequest,
    names: &NameGuard,
    task: &StepView,
) -> Result<(), AgentError> {
    let skill = fixed::skill(&task.skill_id).ok_or(AgentError::InvalidTask)?;
    let system = fixed::system_text(skill).ok_or(AgentError::Egress)?;
    // Sizes first, so the text checks never run over an oversized request (C7: `limit`).
    if !size_ok(&request.messages, &request.tools) {
        return Err(AgentError::Limit);
    }
    // Background-check wording before the other checks, so it is refused as itself wherever it is
    // (owner decision 2026-11-14), even in a request that would fail another check too.
    if background_in(&request.messages) {
        return Err(AgentError::BackgroundCheck);
    }
    let expected = Expected {
        system: &system,
        ask: task.kind == TaskKind::Ask,
        minted: &task.minted,
        replies: &task.replies,
    };
    let ok = task_id_ok(&request.task_id)
        && (1..=MAX_TOKENS).contains(&request.max_tokens)
        && tools_ok(&request.tools, skill)
        && messages_ok(&request.messages, &request.tools, &expected, names);
    if ok { Ok(()) } else { Err(AgentError::Egress) }
}

fn wire_message(message: &AgentMessage) -> Value {
    match message {
        AgentMessage::System { content } => json!({"role": "system", "content": content}),
        AgentMessage::User { content } => json!({"role": "user", "content": content}),
        AgentMessage::Assistant {
            content,
            tool_calls,
        } if tool_calls.is_empty() => json!({"role": "assistant", "content": content}),
        AgentMessage::Assistant {
            content,
            tool_calls,
        } => {
            let calls: Vec<Value> = tool_calls
                .iter()
                .map(|call| {
                    json!({
                        "id": call.id,
                        "type": "function",
                        "function": {"name": wire_name(&call.name), "arguments": call.arguments},
                    })
                })
                .collect();
            // Chat Completions takes null content beside tool calls; some upstreams refuse "".
            let content = if content.is_empty() {
                Value::Null
            } else {
                json!(content)
            };
            json!({"role": "assistant", "content": content, "tool_calls": calls})
        }
        AgentMessage::Tool {
            tool_call_id,
            content,
        } => json!({"role": "tool", "tool_call_id": tool_call_id, "content": content}),
    }
}
/// The exact Chat Completions body for one checked step. Zero data retention is required whenever
/// the route needs it (`RouteConfig::zero_retention`); managed requests also disable hidden
/// reasoning, as for rewording and Ask. `parallel_tool_calls` is left at the provider default
/// (allowed) rather than sent: AI Gateway documents only `tools` and `tool_choice`. With no tools
/// offered, neither is sent.
pub fn step_body(config: &RouteConfig, request: &AgentStepRequest) -> Value {
    let messages: Vec<Value> = request.messages.iter().map(wire_message).collect();
    let mut body = json!({
        "model": config.model,
        "messages": messages,
        "max_tokens": request.max_tokens,
        "temperature": TEMPERATURE,
    });
    if !request.tools.is_empty() {
        let tools: Vec<Value> = request
            .tools
            .iter()
            .map(|tool| {
                json!({
                    "type": "function",
                    "function": {
                        "name": wire_name(&tool.name),
                        "description": tool.description,
                        "parameters": tool.parameters,
                    },
                })
            })
            .collect();
        body["tools"] = Value::Array(tools);
        body["tool_choice"] = json!("auto");
    }
    if config.zero_retention() {
        body["providerOptions"] = json!({"gateway": {"zeroDataRetention": true}});
    }
    if config.route == model::Route::Managed {
        body["reasoning"] = json!({"enabled": false});
    }
    body
}

/// The body ozzie.church's `/api/v1/agent-step` takes: the exact request the checks accepted, in the
/// contract's shape (contract.ts AgentStepRequest; dotted tool names), plus `kind`: "ask" for an Ask
/// task, "procedure" for any other.
pub fn hosted_step_body(request: &AgentStepRequest, kind: TaskKind) -> Option<Vec<u8>> {
    let mut body = serde_json::to_value(request).ok()?;
    body["kind"] = json!(if kind == TaskKind::Ask {
        "ask"
    } else {
        "procedure"
    });
    serde_json::to_vec(&body).ok()
}

/// The provider's reply as the contract's AgentStepReply, or a closed code. A malformed reply is
/// `provider-failure`; one that fails a check is `egress`; more tool calls than the task has left
/// (`calls_left`) is `limit`. A truncated reply ("length") keeps its checked text and drops any
/// tool calls, whose arguments may be cut off.
fn read_reply(
    value: &Value,
    request: &AgentStepRequest,
    step: u8,
    calls_left: usize,
    names: &NameGuard,
) -> Result<AgentStepReply, AgentError> {
    let malformed = AgentError::ProviderFailure;
    let choice = &value["choices"][0];
    let message = choice
        .get("message")
        .filter(|m| m.is_object())
        .ok_or(malformed)?;
    let content = match message.get("content") {
        None | Some(Value::Null) => "",
        Some(Value::String(text)) => text.as_str(),
        Some(_) => return Err(malformed),
    };
    let calls: &[Value] = match message.get("tool_calls") {
        None | Some(Value::Null) => &[],
        Some(Value::Array(calls)) => calls,
        Some(_) => return Err(malformed),
    };
    let reason = match choice.get("finish_reason") {
        None | Some(Value::Null) => None,
        Some(Value::String(reason)) => Some(reason.as_str()),
        Some(_) => return Err(malformed),
    };
    if !chars_within(content, 0, MAX_REPLY_CHARS) || !prose_ok(content, names) {
        return Err(AgentError::Egress);
    }
    // The model's own words with background-check wording ("The check is out of date, so I'll read
    // Planning Center again.") are never kept, so no later request echoes them and no ordinary task is
    // refused for them (owner decision 2026-11-14; review B M1): beside tool calls they are dropped and
    // the calls go on; a reply of words alone is no answer Ozzie can use (`invalid-answer`). ozzie.church
    // digests the reply the same way (web gatewayReplyDigest), so the echo still binds.
    let wording = background_wording(content);
    match reason {
        Some("length") if wording => return Err(AgentError::InvalidAnswer),
        Some("length") => {
            return Ok(AgentStepReply {
                content: content.to_owned(),
                tool_calls: Vec::new(),
                finish: Finish::Length,
            });
        }
        None
        | Some(
            "stop" | "tool_calls" | "function_call" | "tool_use" | "end_turn" | "stop_sequence",
        ) => {}
        Some(_) => return Err(malformed),
    }
    if calls.len() > MAX_TOOL_CALLS {
        return Err(AgentError::Egress);
    }
    if calls.len() > calls_left {
        return Err(AgentError::Limit);
    }
    let mut tool_calls = Vec::with_capacity(calls.len());
    for (index, call) in calls.iter().enumerate() {
        let function = &call["function"];
        let (Some(wire), Some(arguments)) =
            (function["name"].as_str(), function["arguments"].as_str())
        else {
            return Err(malformed);
        };
        if call.get("type").is_some_and(|kind| kind != "function") {
            return Err(AgentError::Egress);
        }
        // Only a tool offered in this request, matched by its exact wire name. Any other (an
        // invented name, or a tool this task wasn't offered) is `denied`: the reply is dropped, so
        // the name never reaches the webview or a later request (review N5).
        let tool = request
            .tools
            .iter()
            .find(|tool| wire_name(&tool.name) == wire)
            .ok_or(AgentError::Denied)?;
        let arguments = if arguments.is_empty() {
            "{}"
        } else {
            arguments
        };
        if !arguments_ok(arguments, &tool.parameters, names) {
            return Err(AgentError::Egress);
        }
        tool_calls.push(AgentToolCall {
            id: format!("call_{step}_{index}"),
            name: tool.name.clone(),
            arguments: arguments.to_owned(),
        });
    }
    let content = if wording && !tool_calls.is_empty() {
        ""
    } else {
        content
    };
    if content.is_empty() && tool_calls.is_empty() {
        return Err(malformed);
    }
    if tool_calls.is_empty() && !answer_ok(content, request) {
        return Err(AgentError::InvalidAnswer);
    }
    let finish = if tool_calls.is_empty() {
        Finish::Stop
    } else {
        Finish::ToolCalls
    };
    Ok(AgentStepReply {
        content: content.to_owned(),
        tool_calls,
        finish,
    })
}

/// A final reply in the closed answer form whose every id is one a tool message in this request
/// holds (fact ids under `fact`, draft ids under `draft_id`, never under `asked_for`).
fn answer_ok(content: &str, request: &AgentStepRequest) -> bool {
    let Some(answer) = fixed::final_answer(content) else {
        debug_answer_shape(content, None);
        return false;
    };
    let mut known = BTreeSet::new();
    for message in &request.messages {
        if let AgentMessage::Tool { content, .. } = message
            && let Some(fixed::ToolMessage::Envelope { ids, .. }) = fixed::tool_message(content)
        {
            known.extend(ids);
        }
    }
    let ok = answer
        .facts
        .iter()
        .chain(answer.draft.as_ref())
        .all(|id| known.contains(id));
    if !ok {
        let unknown: Vec<&str> = answer
            .facts
            .iter()
            .chain(answer.draft.as_ref())
            .filter(|id| !known.contains(*id))
            .map(String::as_str)
            .collect();
        debug_answer_shape(content, Some((&unknown, known.len())));
    }
    ok
}

/// Debug builds only: why a final answer was refused, as a name-free shape — never its text. Keys are
/// reported only when they are short lower-case words; ids are the harness's own `f<n>`/`d<n>` labels.
fn debug_answer_shape(content: &str, unknown: Option<(&[&str], usize)>) {
    if !cfg!(debug_assertions) {
        return;
    }
    let trimmed = content.trim();
    let word = |k: &str| k.len() <= 20 && k.chars().all(|c| c.is_ascii_lowercase() || c == '_');
    match unknown {
        Some((ids, known)) => {
            let ids: Vec<&str> = ids
                .iter()
                .copied()
                .filter(|id| id.len() <= 6 && id.chars().all(|c| c.is_ascii_alphanumeric()))
                .collect();
            eprintln!("autopilot: agent-answer refused=unknown-id ids={ids:?} known={known}");
        }
        None => {
            let keys: Vec<String> = serde_json::from_str::<Value>(
                trimmed.trim_matches('`').trim_start_matches("json").trim(),
            )
            .ok()
            .and_then(|v| {
                v.as_object().map(|o| {
                    o.keys()
                        .map(|k| if word(k) { k.clone() } else { "other".into() })
                        .collect()
                })
            })
            .unwrap_or_default();
            eprintln!(
                "autopilot: agent-answer refused=grammar chars={} json_object={} fence={} keys={keys:?}",
                trimmed.chars().count(),
                trimmed.starts_with('{'),
                trimmed.starts_with("```"),
            );
        }
    }
}

/// What the ledger records as a step's outcome: the finish, or the failure code it fits.
fn outcome(reply: &Result<AgentStepReply, AgentError>) -> &'static str {
    match reply {
        Ok(reply) => match reply.finish {
            Finish::Stop => "stop",
            Finish::ToolCalls => "tool_calls",
            Finish::Length => "length",
        },
        Err(AgentError::Egress | AgentError::ContactDetail | AgentError::BackgroundCheck) => {
            "egress"
        }
        Err(AgentError::Denied) => "denied",
        Err(
            AgentError::Limit
            | AgentError::Budget
            | AgentError::DailyLimit
            | AgentError::AllowancePaused,
        ) => "limit",
        Err(AgentError::ProviderFailure) => "provider-failure",
        Err(AgentError::InvalidAnswer) => "fidelity",
        Err(AgentError::NotConfigured | AgentError::ModelNotAllowed) => "no-model",
        Err(_) => "transport",
    }
}

/// Everything one step runs against.
pub(crate) struct StepEnv<'a> {
    pub config: &'a RouteConfig,
    /// model.rs's usage file (LEDGER_FILE).
    pub usage: &'a Path,
    pub keys: &'a dyn ModelKeys,
    pub names: &'a NameGuard,
    pub ledger: &'a TaskLedger,
    /// The UTC day the per-day cap counts (`model::utc_day`).
    pub day: u64,
    /// Where Ozzie managed is reached in this build (`HostedConfig::current`).
    pub hosted: &'a HostedConfig,
}
/// A request that passed every check, ready to send.
struct Checked {
    url: String,
    body: Vec<u8>,
    calls_left: usize,
    /// To ozzie.church with the device token (`Target::Hosted`).
    hosted: bool,
}
impl StepEnv<'_> {
    /// Every refusal that needs no key, budget, client or network, in one pass. Only once the
    /// request passed every check is the Keychain looked at, for whether a device token is saved
    /// (`model::target`), which decides the address and the body's outer shape.
    fn check(&self, request: &AgentStepRequest) -> Result<Checked, AgentError> {
        self.config.endpoint()?;
        model::check_model(self.config, self.names)?;
        if !task_id_ok(&request.task_id) {
            return Err(AgentError::Egress);
        }
        let task = self.ledger.step_view(&request.task_id)?;
        check_step(request, self.names, &task)?;
        // Only now, with the request checked: whether the managed route goes through ozzie.church.
        let (url, body, hosted) = match model::target(self.config, self.keys, self.hosted)? {
            Target::Direct(direct) => {
                let body = serde_json::to_vec(&step_body(self.config, request))
                    .map_err(|_| AgentError::Egress)?;
                (direct, body, false)
            }
            Target::Hosted(base) => {
                let body = hosted_step_body(request, task.kind).ok_or(AgentError::Egress)?;
                (format!("{base}{}", hosted::AGENT_STEP_PATH), body, true)
            }
        };
        let minted: usize = task.minted.iter().map(|&n| usize::from(n)).sum();
        Ok(Checked {
            url,
            body,
            calls_left: MAX_TOOL_CALLS.saturating_sub(minted),
            hosted,
        })
    }
    /// The key, the step taken in the ledger, the caps, the request, then the reply checked and
    /// the step closed with its outcome, minted calls and reply hash. A reply whose step can't be
    /// recorded is dropped.
    fn send(
        &self,
        request: &AgentStepRequest,
        checked: Checked,
        http: &dyn ModelHttp,
    ) -> Result<AgentStepReply, AgentError> {
        let exchange = Exchange {
            config: self.config,
            usage: self.usage,
            url: &checked.url,
            body: &checked.body,
            tags: AGENT_TAGS,
            keys: self.keys,
            http,
            hosted: checked.hosted,
        };
        let mut taken = None;
        let sent = exchange.send(Spend::AgentStep { day: self.day }, || {
            taken = Some(self.ledger.reserve_step(&request.task_id)?);
            Ok::<(), AgentError>(())
        });
        let Some(step) = taken else {
            // Refused before the network and before the ledger (no key, the task no longer
            // running): no request was sent, no step was taken and nothing was spent.
            return Err(sent.err().unwrap_or(AgentError::ProviderFailure));
        };
        let reply = sent.and_then(|value| {
            // The call counted and its tokens were spent, whether or not the reply passes.
            model::record_tokens(self.usage, self.config.route, &value);
            read_reply(&value, request, step, checked.calls_left, self.names)
        });
        let minted = reply
            .as_ref()
            .map_or(0, |reply| reply.tool_calls.len() as u8);
        let hash = reply.as_ref().map_or_else(
            |_| String::new(),
            |reply| reply_hash(&reply.content, &reply.tool_calls),
        );
        self.ledger
            .finish_step(&request.task_id, step, outcome(&reply), minted, &hash)?;
        reply
    }
}

/// One agent step through the configured route, for a task the ledger holds as running. `usage`
/// is model.rs's usage file (LEDGER_FILE).
pub fn agent_step(
    config: &RouteConfig,
    usage: &Path,
    request: &AgentStepRequest,
    keys: &dyn ModelKeys,
    names: &NameGuard,
    ledger: &TaskLedger,
) -> Result<AgentStepReply, AgentError> {
    let hosted = HostedConfig::current();
    let env = StepEnv {
        config,
        usage,
        keys,
        names,
        ledger,
        day: model::utc_day(crate::sunday_check::unix_ms()),
        hosted: &hosted,
    };
    // Everything that can refuse without a client does so first, once.
    let checked = env.check(request)?;
    let http = NativeModelHttp::for_route(config.route, &hosted)?;
    env.send(request, checked, &http)
}
#[cfg(test)]
pub(crate) fn agent_step_using(
    env: &StepEnv,
    request: &AgentStepRequest,
    http: &dyn ModelHttp,
) -> Result<AgentStepReply, AgentError> {
    let checked = env.check(request)?;
    env.send(request, checked, http)
}

#[cfg(test)]
#[path = "agent_tests.rs"]
mod tests;
