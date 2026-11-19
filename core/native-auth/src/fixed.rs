//! Ozzie's fixed texts, compiled into the binary so native code owns them: the bundled procedures
//! in core/skills/*.md, each with the sha-256 of its exact file (contract.ts `Skill.hash`, the
//! value core/src/harness/skills.ts computes with Web Crypto). The task ledger accepts only these
//! procedures, under these hashes, so nothing else can be filed as one.
//!
//! The frontmatter is read the way core/src/harness/skills.ts `parseSkill` reads it (`key: value`
//! lines between `---` fences, then the body, trimmed), for the id, title and tool list. A file
//! that doesn't parse is left out, and a test requires every bundled file to parse.
//!
//! Also compiled in: the shared fixed texts in core/src/harness/fixed/ (README.md there), the
//! single copy the webview reads too. The system message for a procedure, the tool specs and the
//! procedure prompt are pinned byte for byte (and pins.json, which holds their hashes, is recomputed
//! by a test), so agent.rs compares them rather than name-scanning Ozzie's own words; a tool
//! message must fit the closed grammar of vocabulary.json (`tool_message`), with its facts' ids, and
//! the model's final reply the closed answer grammar (`final_answer`): only a choice of those ids.
use crate::agent::ToolSpec;
use serde::Deserialize;
use serde_json::Value;
use sha2::Digest;
use std::collections::HashSet;
use std::sync::OnceLock;

/// The procedure every Ask question runs (core/src/harness/skills.ts ASK_SKILL).
pub const ASK_SKILL: &str = "answer-from-what-was-read";
/// The procedure the automatic check runs.
pub const CHECK_SKILL: &str = "sunday-ready";

/// core/skills/*.md, as shipped (core/src/harness/bundled-skills.ts SKILL_FILES).
pub const SKILL_FILES: [(&str, &str); 6] = [
    (
        "answer-from-what-was-read.md",
        include_str!("../../skills/answer-from-what-was-read.md"),
    ),
    (
        "follow-up-owners.md",
        include_str!("../../skills/follow-up-owners.md"),
    ),
    (
        "group-night.md",
        include_str!("../../skills/group-night.md"),
    ),
    ("room-check.md", include_str!("../../skills/room-check.md")),
    (
        "sunday-ready.md",
        include_str!("../../skills/sunday-ready.md"),
    ),
    (
        "who-could-help.md",
        include_str!("../../skills/who-could-help.md"),
    ),
];

/// One bundled procedure.
#[derive(Debug)]
pub struct BundledSkill {
    pub id: String,
    pub title: String,
    /// Tools the procedure may use, in file order.
    pub tools: Vec<String>,
    /// The procedure in plain words, trimmed, as parseSkill returns it.
    pub body: String,
    /// sha-256 of the whole file, lowercase hex.
    pub hash: String,
}

/// Lowercase hex sha-256 of the text's UTF-8 bytes.
pub fn sha256_hex(text: &str) -> String {
    sha2::Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The frontmatter fields and body of a skill file, or None if it has no frontmatter.
fn parse(text: &str) -> Option<(Vec<(String, String)>, String)> {
    let rest = text
        .strip_prefix("---\r\n")
        .or_else(|| text.strip_prefix("---\n"))?;
    // The first line that is `---` (then optional spaces or tabs) closes the frontmatter.
    let mut offset = 0;
    let mut close = None;
    for line in rest.split_inclusive('\n') {
        let bare = line.trim_end_matches(['\n', '\r']);
        if bare
            .strip_prefix("---")
            .is_some_and(|tail| tail.trim_matches([' ', '\t']).is_empty())
        {
            close = Some((offset, offset + line.len()));
            break;
        }
        offset += line.len();
    }
    let (end, body_start) = close?;
    let meta = rest[..end]
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| {
            let (key, value) = line.split_once(':')?;
            Some((key.to_owned(), value.trim().to_owned()))
        })
        .collect();
    Some((meta, rest[body_start..].trim().to_owned()))
}

fn load(file: &str, text: &str) -> Option<BundledSkill> {
    let (meta, body) = parse(text)?;
    let field = |key: &str| {
        meta.iter()
            .find(|(k, _)| k == key)
            .map(|(_, value)| value.clone())
    };
    let id = field("id")?;
    let tools = field("tools")?;
    let tools = tools
        .strip_prefix('[')
        .and_then(|t| t.strip_suffix(']'))
        .unwrap_or(&tools)
        .split(',')
        .map(str::trim)
        .filter(|tool| !tool.is_empty())
        .map(str::to_owned)
        .collect();
    (file == format!("{id}.md")).then(|| BundledSkill {
        title: field("title").unwrap_or_default(),
        id,
        tools,
        body,
        hash: sha256_hex(text),
    })
}

/// Every bundled procedure that parses, in file order.
pub fn skills() -> &'static [BundledSkill] {
    static SKILLS: OnceLock<Vec<BundledSkill>> = OnceLock::new();
    SKILLS.get_or_init(|| {
        SKILL_FILES
            .iter()
            .filter_map(|(file, text)| load(file, text))
            .collect()
    })
}

/// The bundled procedure with this id.
pub fn skill(id: &str) -> Option<&'static BundledSkill> {
    skills().iter().find(|skill| skill.id == id)
}

// ---- The fixed texts a model can receive (core/src/harness/fixed/, README.md there) -------------

/// policy.txt: Ozzie's policy, the first part of every system message.
pub const POLICY_FILE: &str = include_str!("../../src/harness/fixed/policy.txt");
/// tool-specs.json: the 13 tool specs, exactly as offered.
pub const TOOL_SPECS_FILE: &str = include_str!("../../src/harness/fixed/tool-specs.json");
/// vocabulary.json: the closed grammar of a tool result, the system message format and the
/// procedure prompt.
pub const VOCABULARY_FILE: &str = include_str!("../../src/harness/fixed/vocabulary.json");
/// common-words.txt: lower-case common English words for the "capitalized only" name rule.
pub const COMMON_WORDS_FILE: &str = include_str!("../../src/harness/fixed/common-words.txt");
/// policy-local.txt: the policy an Ask step to a model on this Mac carries instead of policy.txt (2026-11-18,
/// `local_ask_system`).
pub const LOCAL_POLICY_FILE: &str = include_str!("../../src/harness/fixed/policy-local.txt");

/// The policy: policy.txt with its final line break removed.
pub fn policy() -> &'static str {
    POLICY_FILE
        .strip_suffix("\r\n")
        .or_else(|| POLICY_FILE.strip_suffix('\n'))
        .unwrap_or(POLICY_FILE)
}

/// The local route's policy: policy-local.txt with its final line break removed.
pub fn local_policy() -> &'static str {
    LOCAL_POLICY_FILE
        .strip_suffix("\r\n")
        .or_else(|| LOCAL_POLICY_FILE.strip_suffix('\n'))
        .unwrap_or(LOCAL_POLICY_FILE)
}
/// AI on this Mac (measured 2026-11-18): the Ask
/// procedure's exact system message with the local route's own policy in place of the policy, and the procedure after
/// it unchanged; None for any other text. With policy.txt the answer check refused the medium model on three of Ozzie's
/// four suggested questions: two it answered at once without a lookup, copying the policy's example ids ("f4", "f3"),
/// and beside a draft it named an example fact no result held. This policy shows no example id and says which lookup
/// fits which question. Only `agent::step_body` uses it, on
/// the wire to a model on this Mac, after every check passed on the request as the webview sent it: Ozzie's pinned words
/// for Ozzie's pinned words.
pub fn local_ask_system(system: &str) -> Option<String> {
    let ask = system_text(skill(ASK_SKILL)?)?;
    let rest = ask.strip_prefix(policy())?;
    (system == ask).then(|| format!("{}{rest}", local_policy()))
}

#[derive(Deserialize)]
struct SystemMessage {
    format: String,
}
#[derive(Deserialize)]
struct Ids {
    keys: std::collections::HashMap<String, String>,
}
#[derive(Deserialize)]
struct AnswerGrammar {
    kinds: Vec<String>,
    max_facts: usize,
}
#[derive(Deserialize)]
struct Labels {
    families: Vec<String>,
    your_name: String,
    your_name_keys: Vec<String>,
}
/// The parts of vocabulary.json native code reads. Its prose fields (`about`, `time_patterns`,
/// `sentence_characters`, …) describe rules written out here, and a test pins them.
#[derive(Deserialize)]
struct VocabularyFile {
    system_message: SystemMessage,
    procedure_prompt: String,
    tools: Vec<String>,
    sources: Vec<String>,
    completeness: Vec<String>,
    tool_errors: Vec<String>,
    labels: Labels,
    envelope_keys: Vec<String>,
    payload_keys: Vec<String>,
    values: Vec<String>,
    sentence_keys: Vec<String>,
    sentence_words: Vec<String>,
    ids: Ids,
    answer: AnswerGrammar,
}
/// vocabulary.json as sets. If the file couldn't be read every set is empty, so every tool
/// result, system message and procedure prompt is refused: fail closed.
#[derive(Default)]
pub struct Vocabulary {
    pub format: String,
    pub procedure_prompt: String,
    tools: HashSet<String>,
    sources: HashSet<String>,
    completeness: HashSet<String>,
    tool_errors: HashSet<String>,
    pub families: Vec<String>,
    your_name: String,
    your_name_keys: HashSet<String>,
    envelope_keys: Vec<String>,
    payload_keys: HashSet<String>,
    values: HashSet<String>,
    sentence_keys: HashSet<String>,
    sentence_words: HashSet<String>,
    /// Keys whose string is an id, and each one's prefix (`fact` → `f`, `draft_id` → `d`).
    id_prefixes: std::collections::HashMap<String, String>,
    answer_kinds: HashSet<String>,
    /// The most facts a final answer may choose (vocabulary.json `answer.max_facts`).
    pub max_facts: usize,
}
impl Vocabulary {
    fn parse(text: &str) -> Option<Self> {
        let file: VocabularyFile = serde_json::from_str(text).ok()?;
        let set = |list: Vec<String>| list.into_iter().collect::<HashSet<String>>();
        Some(Self {
            format: file.system_message.format,
            procedure_prompt: file.procedure_prompt,
            tools: set(file.tools),
            sources: set(file.sources),
            completeness: set(file.completeness),
            tool_errors: set(file.tool_errors),
            families: file.labels.families,
            your_name: file.labels.your_name,
            your_name_keys: set(file.labels.your_name_keys),
            envelope_keys: file.envelope_keys,
            payload_keys: set(file.payload_keys),
            values: set(file.values),
            sentence_keys: set(file.sentence_keys),
            sentence_words: set(file.sentence_words),
            id_prefixes: file.ids.keys,
            answer_kinds: set(file.answer.kinds),
            max_facts: file.answer.max_facts,
        })
    }
}
pub fn vocabulary() -> &'static Vocabulary {
    static VOCABULARY: OnceLock<Vocabulary> = OnceLock::new();
    VOCABULARY.get_or_init(|| Vocabulary::parse(VOCABULARY_FILE).unwrap_or_default())
}
/// The user message of a procedure task (vocabulary.json `procedure_prompt`).
pub fn procedure_prompt() -> &'static str {
    &vocabulary().procedure_prompt
}

/// The canonical tool specs (tool-specs.json); empty, refusing every spec, if it couldn't be read.
pub fn tool_specs() -> &'static [ToolSpec] {
    static SPECS: OnceLock<Vec<ToolSpec>> = OnceLock::new();
    SPECS.get_or_init(|| serde_json::from_str(TOOL_SPECS_FILE).unwrap_or_default())
}
pub fn tool_spec(name: &str) -> Option<&'static ToolSpec> {
    tool_specs().iter().find(|spec| spec.name == name)
}

/// The common words (common-words.txt), one per line, lower case.
pub fn common_words() -> &'static HashSet<String> {
    static WORDS: OnceLock<HashSet<String>> = OnceLock::new();
    WORDS.get_or_init(|| {
        COMMON_WORDS_FILE
            .lines()
            .map(str::trim)
            .filter(|word| !word.is_empty())
            .map(str::to_owned)
            .collect()
    })
}

/// The system message for a procedure: vocabulary.json `system_message.format`
/// ("{policy}\n\nProcedure: {title}\n{body}"), each placeholder replaced once, left to right, and
/// never read again (a "{body}" inside a procedure is text). None if the format can't be read.
pub fn system_text(skill: &BundledSkill) -> Option<String> {
    let format = &vocabulary().format;
    if format.is_empty() {
        return None;
    }
    let mut out = String::with_capacity(format.len() + POLICY_FILE.len() + skill.body.len());
    let mut rest = format.as_str();
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let tail = &rest[open..];
        let part = [
            ("{policy}", policy()),
            ("{title}", skill.title.as_str()),
            ("{body}", skill.body.as_str()),
        ]
        .into_iter()
        .find(|(token, _)| tail.starts_with(token));
        match part {
            Some((token, text)) => {
                out.push_str(text);
                rest = &tail[token.len()..];
            }
            None => {
                out.push('{');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    Some(out)
}

// ---- The closed grammar of a tool message (README.md "Tool messages") ---------------------------

/// Containers nested inside a payload, at most: the deepest tool result today (a room booking's
/// time inside a booking inside a room) is six.
pub const MAX_PAYLOAD_DEPTH: usize = 8;
/// Counts in a tool result stay below seven digits (the contact rule refuses seven or more in a
/// row anyway).
pub const MAX_COUNT: u64 = 999_999;

/// A JSON value read with every object's keys unique, so nothing can hide behind a repeated key
/// (a reader keeps only one of them; the model may read the other).
pub struct Unique(pub Value);
impl<'de> Deserialize<'de> for Unique {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        use serde::de::{Error, MapAccess, SeqAccess, Visitor};
        struct Strict;
        impl<'de> Visitor<'de> for Strict {
            type Value = Unique;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("JSON")
            }
            fn visit_bool<E: Error>(self, v: bool) -> Result<Unique, E> {
                Ok(Unique(Value::Bool(v)))
            }
            fn visit_i64<E: Error>(self, v: i64) -> Result<Unique, E> {
                Ok(Unique(Value::from(v)))
            }
            fn visit_u64<E: Error>(self, v: u64) -> Result<Unique, E> {
                Ok(Unique(Value::from(v)))
            }
            fn visit_f64<E: Error>(self, v: f64) -> Result<Unique, E> {
                Ok(Unique(Value::from(v)))
            }
            fn visit_str<E: Error>(self, v: &str) -> Result<Unique, E> {
                Ok(Unique(Value::String(v.to_owned())))
            }
            fn visit_unit<E: Error>(self) -> Result<Unique, E> {
                Ok(Unique(Value::Null))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Unique, A::Error> {
                let mut items = Vec::new();
                while let Some(Unique(item)) = seq.next_element()? {
                    items.push(item);
                }
                Ok(Unique(Value::Array(items)))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Unique, A::Error> {
                let mut object = serde_json::Map::new();
                while let Some(key) = map.next_key::<String>()? {
                    let Unique(value) = map.next_value()?;
                    if object.insert(key, value).is_some() {
                        return Err(A::Error::custom("repeated key"));
                    }
                }
                Ok(Unique(Value::Object(object)))
            }
        }
        deserializer.deserialize_any(Strict)
    }
}
/// JSON text with no repeated key anywhere.
pub fn parse_unique(text: &str) -> Option<Value> {
    serde_json::from_str::<Unique>(text)
        .ok()
        .map(|Unique(value)| value)
}

fn digits(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit())
}
fn number(text: &str) -> u32 {
    text.parse().unwrap_or(u32::MAX)
}
/// YYYY-MM-DD, a real calendar date.
fn date_ok(text: &str) -> bool {
    let b = text.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    let (year, month, day) = (&text[..4], &text[5..7], &text[8..]);
    if !digits(year) || !digits(month) || !digits(day) {
        return false;
    }
    let (y, m, d) = (number(year), number(month), number(day));
    let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
    let days = match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    (1..=days).contains(&d)
}
/// HH:MM with hours below 24 and minutes below 60.
fn clock_ok(text: &str) -> bool {
    let b = text.as_bytes();
    b.len() == 5
        && b[2] == b':'
        && digits(&text[..2])
        && digits(&text[3..])
        && number(&text[..2]) < 24
        && number(&text[3..]) < 60
}
/// Byte length of an ISO 8601 date-time at the start of `text` (README: `YYYY-MM-DDTHH:MM`,
/// optional `:SS` and `.sss`, then `Z` or `±HH:MM`), a real date and time, or None.
fn datetime_len(text: &str) -> Option<usize> {
    let b = text.as_bytes();
    if b.len() < 17 || !date_ok(text.get(..10)?) || b[10] != b'T' || !clock_ok(text.get(11..16)?) {
        return None;
    }
    let mut at = 16;
    if b.get(at) == Some(&b':') {
        let seconds = text.get(at + 1..at + 3)?;
        if !digits(seconds) || number(seconds) >= 60 {
            return None;
        }
        at += 3;
        if b.get(at) == Some(&b'.') {
            if !digits(text.get(at + 1..at + 4)?) {
                return None;
            }
            at += 4;
        }
    }
    match b.get(at) {
        Some(b'Z') => Some(at + 1),
        Some(b'+' | b'-') => clock_ok(text.get(at + 1..at + 6)?).then_some(at + 6),
        _ => None,
    }
}
/// An ISO 8601 date-time or date, the whole string.
pub fn iso_time(text: &str) -> bool {
    datetime_len(text) == Some(text.len()) || date_ok(text)
}
/// Byte length of a placeholder label of a vocabulary family at the start of `text`:
/// `[<family> <n>]`, n from 1 to 9999 with no leading zero.
pub fn envelope_label_len(text: &str) -> Option<usize> {
    let rest = text.strip_prefix('[')?;
    let family = vocabulary().families.iter().find(|family| {
        rest.strip_prefix(family.as_str())
            .is_some_and(|r| r.starts_with(' '))
    })?;
    let tag = &rest[family.len() + 1..];
    let n = tag.bytes().take_while(u8::is_ascii_digit).count();
    let ok = (1..=4).contains(&n) && !tag.starts_with('0') && tag.as_bytes().get(n) == Some(&b']');
    ok.then_some(1 + family.len() + 1 + n + 1)
}
fn whole_label(text: &str) -> bool {
    envelope_label_len(text) == Some(text.len())
}
/// A sentence of fixed words (README): labels, `[Your name]` where allowed and ISO times set
/// aside, then only `[A-Za-z0-9 \n.,;:?!'()-]`, and every word (ASCII letters with inner
/// apostrophes) in `sentence_words`, compared in lower case. Digit runs are counts.
fn sentence_ok(text: &str, your_name: bool) -> bool {
    let vocabulary = vocabulary();
    let mut rest = String::with_capacity(text.len());
    let mut at = 0;
    while at < text.len() {
        let tail = &text[at..];
        let skip = envelope_label_len(tail)
            .or_else(|| {
                let fits = your_name
                    && !vocabulary.your_name.is_empty()
                    && tail.starts_with(vocabulary.your_name.as_str());
                fits.then_some(vocabulary.your_name.len())
            })
            .or_else(|| {
                // A date, then optionally the rest of a date-time (as TIME_IN_TEXT in fixed.ts:
                // shapes only, as the webview sets them aside).
                let b = tail.as_bytes();
                let date_shape = b.len() >= 10
                    && b[..4].iter().all(u8::is_ascii_digit)
                    && b[4] == b'-'
                    && b[5..7].iter().all(u8::is_ascii_digit)
                    && b[7] == b'-'
                    && b[8..10].iter().all(u8::is_ascii_digit);
                date_shape.then(|| time_shape_len(tail))
            });
        match skip {
            Some(len) => {
                rest.push(' ');
                at += len;
            }
            None => {
                let c = tail.chars().next().unwrap_or(' ');
                rest.push(c);
                at += c.len_utf8();
            }
        }
    }
    let allowed = |c: char| c.is_ascii_alphanumeric() || " \n.,;:?!'()-".contains(c);
    if !rest.chars().all(allowed) {
        return false;
    }
    // Words: runs of ASCII letters with inner apostrophes.
    let bytes = rest.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if !bytes[i].is_ascii_alphabetic() {
            i += 1;
            continue;
        }
        let start = i;
        loop {
            while i < bytes.len() && bytes[i].is_ascii_alphabetic() {
                i += 1;
            }
            if i + 1 < bytes.len() && bytes[i] == b'\'' && bytes[i + 1].is_ascii_alphabetic() {
                i += 1;
                continue;
            }
            break;
        }
        if !vocabulary
            .sentence_words
            .contains(&rest[start..i].to_ascii_lowercase())
        {
            return false;
        }
    }
    true
}
/// Byte length of `\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{3})?)?(?:Z|[+-]\d{2}:\d{2}))?`
/// at the start of `text`, which already starts with the date's shape.
fn time_shape_len(text: &str) -> usize {
    let b = text.as_bytes();
    let d = |range: std::ops::Range<usize>| {
        b.get(range)
            .is_some_and(|s| s.iter().all(u8::is_ascii_digit))
    };
    if !(b.get(10) == Some(&b'T') && d(11..13) && b.get(13) == Some(&b':') && d(14..16)) {
        return 10;
    }
    let mut at = 16;
    if b.get(at) == Some(&b':') && d(at + 1..at + 3) {
        let mut next = at + 3;
        if b.get(next) == Some(&b'.') && d(next + 1..next + 4) {
            next += 4;
        }
        at = next;
    }
    match b.get(at) {
        Some(b'Z') => at + 1,
        Some(b'+' | b'-')
            if d(at + 1..at + 3) && b.get(at + 3) == Some(&b':') && d(at + 4..at + 6) =>
        {
            at + 6
        }
        _ => 10,
    }
}

/// What a tool message is, once it fits the grammar.
#[derive(Debug, PartialEq, Eq)]
pub enum ToolMessage {
    /// `{"error":"<code>"}` with a code from `tool_errors`.
    Error,
    /// A tool envelope from this tool. `slots` are its label and time strings, and `sentences`
    /// the sentences assembled from fixed words: the only strings that aren't one fixed value.
    /// `ids` are its fact and draft ids, leaving out anything under `asked_for`.
    Envelope {
        tool: String,
        slots: Vec<String>,
        sentences: Vec<String>,
        ids: Vec<String>,
    },
}
/// The strings of an envelope that aren't one fixed value, gathered while its grammar is checked.
#[derive(Default)]
struct Varying {
    slots: Vec<String>,
    sentences: Vec<String>,
    ids: Vec<String>,
}
/// An id with this prefix: the prefix, then 1 to 9999 with no leading zero (`f3`, `d1`).
fn id_ok(prefix: &str, text: &str) -> bool {
    text.strip_prefix(prefix)
        .is_some_and(|n| (1..=4).contains(&n.len()) && digits(n) && !n.starts_with('0'))
}
/// A tool message under the closed grammar (README.md "Tool messages"; core/src/harness/fixed.ts
/// `envelopeProblems` is the reference, with any well-formed label allowed), or None. Stricter
/// than the reference: no object key may repeat, counts stay at most MAX_COUNT, containers nest at
/// most MAX_PAYLOAD_DEPTH inside the payload, and a time must be a real date and clock.
pub fn tool_message(text: &str) -> Option<ToolMessage> {
    let vocabulary = vocabulary();
    let Value::Object(object) = parse_unique(text)? else {
        return None;
    };
    if object.len() == 1 {
        let code = object.get("error")?.as_str()?;
        return vocabulary
            .tool_errors
            .contains(code)
            .then_some(ToolMessage::Error);
    }
    let field = |key: &str| object.get(key).and_then(Value::as_str);
    let keys_ok = object.len() == vocabulary.envelope_keys.len()
        && vocabulary
            .envelope_keys
            .iter()
            .all(|key| object.contains_key(key));
    let tool = field("tool").filter(|tool| vocabulary.tools.contains(*tool))?;
    let fields_ok = keys_ok
        && field("source").is_some_and(|source| vocabulary.sources.contains(source))
        && field("completeness").is_some_and(|c| vocabulary.completeness.contains(c))
        && field("check_time").is_some_and(|time| datetime_len(time) == Some(time.len()));
    let payload @ Value::Object(_) = object.get("payload")? else {
        return None;
    };
    let mut varying = Varying::default();
    (fields_ok && value_ok(payload, None, 0, &mut varying, true)).then(|| ToolMessage::Envelope {
        tool: tool.to_owned(),
        slots: varying.slots,
        sentences: varying.sentences,
        ids: varying.ids,
    })
}
/// One value under `key`; `collect` is false under `asked_for`, whose ids (none today) never count.
fn value_ok(
    value: &Value,
    key: Option<&str>,
    depth: usize,
    varying: &mut Varying,
    collect: bool,
) -> bool {
    let vocabulary = vocabulary();
    // Under an id key, an id and nothing else.
    if let Some(prefix) = key.and_then(|key| vocabulary.id_prefixes.get(key)) {
        return match value {
            Value::String(text) if id_ok(prefix, text) => {
                if collect {
                    varying.ids.push(text.clone());
                }
                true
            }
            _ => false,
        };
    }
    match value {
        Value::String(text) => {
            if vocabulary.values.contains(text) {
                return true;
            }
            if iso_time(text) || whole_label(text) {
                varying.slots.push(text.clone());
                return true;
            }
            let sentence = key.is_some_and(|key| {
                vocabulary.sentence_keys.contains(key)
                    && sentence_ok(text, vocabulary.your_name_keys.contains(key))
            });
            if sentence {
                varying.sentences.push(text.clone());
            }
            sentence
        }
        Value::Number(n) => n.as_u64().is_some_and(|n| n <= MAX_COUNT),
        Value::Bool(_) => true,
        Value::Null => false,
        Value::Array(items) => {
            depth < MAX_PAYLOAD_DEPTH
                && items
                    .iter()
                    .all(|item| value_ok(item, key, depth + 1, varying, collect))
        }
        Value::Object(map) => {
            depth < MAX_PAYLOAD_DEPTH
                && map.iter().all(|(k, v)| {
                    vocabulary.payload_keys.contains(k)
                        && value_ok(v, Some(k), depth + 1, varying, collect && k != "asked_for")
                })
        }
    }
}

// ---- The model's final answer (vocabulary.json "answer"; core/src/harness/fixed.ts parseAnswer) ---

/// A final answer that fits the closed grammar.
#[derive(Debug, PartialEq, Eq)]
pub struct FinalAnswer {
    pub kind: String,
    pub facts: Vec<String>,
    pub draft: Option<String>,
}
/// A string or a list of strings: the only values the answer object holds.
enum AnswerValue {
    One(String),
    List(Vec<String>),
}
/// The answer object, read by a scanner that accepts only what the grammar allows (fixed.ts
/// `scanAnswer`): `{`, pairs of a key and a string or a list of strings, `}`, with JSON whitespace
/// between tokens; every string plain (`[a-z0-9_-]` between double quotes, no escape) and no key
/// repeated. None when anything else is there.
fn scan_answer(text: &str) -> Option<Vec<(String, AnswerValue)>> {
    let b = text.as_bytes();
    let mut i = 0;
    let ws = |i: &mut usize| {
        while *i < b.len() && matches!(b[*i], b' ' | b'\t' | b'\n' | b'\r') {
            *i += 1;
        }
    };
    let string = |i: &mut usize| -> Option<String> {
        if b.get(*i) != Some(&b'"') {
            return None;
        }
        let start = *i + 1;
        let mut end = start;
        while end < b.len() && matches!(b[end], b'a'..=b'z' | b'0'..=b'9' | b'_' | b'-') {
            end += 1;
        }
        if b.get(end) != Some(&b'"') {
            return None;
        }
        *i = end + 1;
        Some(text[start..end].to_owned())
    };
    let mut out: Vec<(String, AnswerValue)> = Vec::new();
    ws(&mut i);
    if b.get(i) != Some(&b'{') {
        return None;
    }
    i += 1;
    ws(&mut i);
    if b.get(i) == Some(&b'}') {
        i += 1;
    } else {
        loop {
            ws(&mut i);
            let key = string(&mut i)?;
            if out.iter().any(|(k, _)| *k == key) {
                return None;
            }
            ws(&mut i);
            if b.get(i) != Some(&b':') {
                return None;
            }
            i += 1;
            ws(&mut i);
            let value = if b.get(i) == Some(&b'[') {
                i += 1;
                ws(&mut i);
                let mut list = Vec::new();
                if b.get(i) == Some(&b']') {
                    i += 1;
                } else {
                    loop {
                        ws(&mut i);
                        list.push(string(&mut i)?);
                        ws(&mut i);
                        let c = b.get(i).copied();
                        i += 1;
                        match c {
                            Some(b']') => break,
                            Some(b',') => {}
                            _ => return None,
                        }
                    }
                }
                AnswerValue::List(list)
            } else {
                AnswerValue::One(string(&mut i)?)
            };
            out.push((key, value));
            ws(&mut i);
            let c = b.get(i).copied();
            i += 1;
            match c {
                Some(b'}') => break,
                Some(b',') => {}
                _ => return None,
            }
        }
    }
    ws(&mut i);
    (i == b.len()).then_some(out)
}
/// The model's final reply under the closed grammar, or None (fixed.ts `parseAnswer`, the
/// reference): whitespace around it and one optional code fence (a first line of ``` or ```json,
/// a last line of ```); then exactly an object with "answer" (a kind), "facts" (distinct fact ids,
/// at most max_facts; required and non-empty for "facts") and "draft" (a draft id; required for
/// "draft" and allowed only there). No prose, no other key, no repeated key.
pub fn final_answer(text: &str) -> Option<FinalAnswer> {
    final_answer_within(text, vocabulary().max_facts)
}
/// `final_answer` with no limit on how many facts: only for telling an answer whose one fault is
/// choosing more than max_facts (agent.rs `answer_refusal`, `too-many-facts`) from any other. Never
/// an answer Ozzie uses.
pub fn final_answer_uncapped(text: &str) -> Option<FinalAnswer> {
    final_answer_within(text, usize::MAX)
}
fn final_answer_within(text: &str, max_facts: usize) -> Option<FinalAnswer> {
    let vocabulary = vocabulary();
    let trim = |s: &str| s.trim_matches([' ', '\t', '\n', '\r']).to_owned();
    let mut body = trim(text);
    if body.starts_with("```") {
        let lines: Vec<&str> = body.split('\n').collect();
        let first = lines[0].trim_end_matches([' ', '\t', '\r']);
        let last = lines[lines.len() - 1].trim_matches([' ', '\t', '\r']);
        if lines.len() < 3 || !matches!(first, "```" | "```json") || last != "```" {
            return None;
        }
        body = trim(&lines[1..lines.len() - 1].join("\n"));
    }
    let pairs = scan_answer(&body)?;
    let (mut kind, mut facts, mut draft) = (None, None, None);
    for (key, value) in pairs {
        match (key.as_str(), value) {
            ("answer", AnswerValue::One(k)) => kind = Some(k),
            ("facts", AnswerValue::List(list)) => facts = Some(list),
            ("draft", AnswerValue::One(d)) => draft = Some(d),
            _ => return None,
        }
    }
    let kind = kind.filter(|k| vocabulary.answer_kinds.contains(k))?;
    let fact_prefix = vocabulary.id_prefixes.get("fact")?;
    let draft_prefix = vocabulary.id_prefixes.get("draft_id")?;
    let facts = facts.unwrap_or_default();
    let distinct: HashSet<&String> = facts.iter().collect();
    let facts_ok = facts.len() <= max_facts
        && distinct.len() == facts.len()
        && facts.iter().all(|f| id_ok(fact_prefix, f))
        && (kind != "facts" || !facts.is_empty());
    let draft_ok = (kind == "draft") == draft.is_some()
        && draft.as_deref().is_none_or(|d| id_ok(draft_prefix, d));
    (facts_ok && draft_ok).then_some(FinalAnswer { kind, facts, draft })
}

/// One tool result per tool, as core/src/harness/tools.ts writes them over its test fixtures
/// (core/test/harness/fixtures.ts `allEnvelopes`, JSON.stringify output), for the grammar tests.
#[cfg(test)]
pub(crate) const SAMPLE_ENVELOPES: [&str; 13] = [
    r#"{"tool":"sunday.overview","source":"Planning Center Services","check_time":"2026-11-20T15:00:00Z","completeness":"complete","payload":{"fact":"f1","mode":"fictional","sunday":"2026-11-22","reads":26,"reads_not_completed":0,"needs_a_decision":2,"worth_a_look":3,"findings":[{"fact":"f2","kind":"needs people","tone":"needs a decision","role":"[Role 1]","time":{"starts_at":"2026-11-22T09:30-05:00","ends_at":"2026-11-22T10:30-05:00"},"remaining":1,"decision":"covered outside Planning Center","changed_since_decision":false},{"fact":"f3","kind":"needs people","tone":"needs a decision","role":"[Role 2]","time":{"starts_at":"2026-11-22T09:30-05:00","ends_at":"2026-11-22T10:30-05:00"},"remaining":1},{"fact":"f4","kind":"no scheduled lead","tone":"worth a look","role":"[Role 2]","time":{"starts_at":"2026-11-22T09:30-05:00","ends_at":"2026-11-22T10:30-05:00"}},{"fact":"f5","kind":"pending","tone":"worth a look","role":"[Role 3]","time":{"starts_at":"2026-11-22T09:30-05:00","ends_at":"2026-11-22T10:30-05:00"},"person":"[Person 1]","request":"request not sent yet"},{"fact":"f6","kind":"check-in suggested","tone":"worth a look","person":"[Person 2]","sundays_in_a_row":3}]}}"#,
    r#"{"tool":"sunday.open_needs","source":"Planning Center Services","check_time":"2026-11-20T15:00:00Z","completeness":"complete","payload":{"fact":"f7","needs":[{"fact":"f8","kind":"needs people","role":"[Role 1]","time":{"starts_at":"2026-11-22T09:30-05:00","ends_at":"2026-11-22T10:30-05:00"},"remaining":1,"confirmed":["[Person 2]"],"people_listed":{"no_overlap_found":1,"possible_conflict":1,"needs_confirmation":1,"left_out":2},"team_leaders":"none listed","decision":"covered outside Planning Center","changed_since_decision":false},{"fact":"f9","kind":"needs people","role":"[Role 2]","time":{"starts_at":"2026-11-22T09:30-05:00","ends_at":"2026-11-22T10:30-05:00"},"remaining":1,"confirmed":["[Person 3]"],"people_listed":{"no_overlap_found":0,"possible_conflict":0,"needs_confirmation":0,"left_out":0},"team_leaders":["[Person 4]"]},{"fact":"f10","kind":"no scheduled lead","role":"[Role 2]","time":{"starts_at":"2026-11-22T09:30-05:00","ends_at":"2026-11-22T10:30-05:00"},"scheduled_to_lead_not_accepted":[],"team_leaders":["[Person 4]"]}],"remaining_means":"Planning Center's own count of open requests; people who accepted or are pending are already counted","team_leaders_means":"oversight of the team, not a Sunday assignment"}}"#,
    r#"{"tool":"sunday.pending_requests","source":"Planning Center Services","check_time":"2026-11-20T15:00:00Z","completeness":"complete","payload":{"fact":"f9","pending":[{"fact":"f10","role":"[Role 3]","time":{"starts_at":"2026-11-22T09:30-05:00","ends_at":"2026-11-22T10:30-05:00"},"person":"[Person 1]","request":"request not sent yet"}],"leads_not_accepted":[],"pending_means":"not accepted yet; pending is not the same as asked"}}"#,
    r#"{"tool":"sunday.rule_checkins","source":"Planning Center Services","check_time":"2026-11-20T15:00:00Z","completeness":"complete","payload":{"fact":"f11","check_in_after_sundays_in_a_row":3,"check_ins":[{"fact":"f12","person":"[Person 2]","sundays_in_a_row":3}],"check_in_means":"a schedule fact for a person to look at; about care, not performance"}}"#,
    r#"{"tool":"sunday.not_checked","source":"Planning Center Services","check_time":"2026-11-20T15:00:00Z","completeness":"partial","payload":{"fact":"f12","reads":26,"reads_not_completed":14,"too_old_to_treat_as_current":false,"services":["Whether someone is willing to serve isn't something Planning Center records.","Team members for 3 teams: Planning Center didn't allow it.","Team leaders for 3 teams: Planning Center didn't allow it.","Other schedules for 8 people: only partly read.","Some Planning Center reads didn't complete; see What happened."],"rooms_follow_ups_groups":[]}}"#,
    r#"{"tool":"rooms.conflicts","source":"Planning Center Calendar","check_time":"2026-11-20T15:00:00Z","completeness":"complete","payload":{"fact":"f14","status":"room use needs review","rooms":[{"fact":"f15","room":"[Room 1]","label":"Room use needs review","overlap":{"starts_at":"2026-11-22T10:30-05:00","ends_at":"2026-11-22T11:00-05:00"},"bookings":[{"time":{"starts_at":"2026-11-22T09:00-05:00","ends_at":"2026-11-22T11:00-05:00"},"approval":"approved"},{"time":{"starts_at":"2026-11-22T10:45-05:00","ends_at":"2026-11-22T11:15-05:00"},"approval":"approved"}],"setup_minutes":15,"church_rule":"not shared","worked_out_in_planning_center":"not worked out"}],"worth_a_look":0}}"#,
    r#"{"tool":"followups.unowned","source":"Planning Center People","check_time":"2026-11-20T15:00:00Z","completeness":"complete","payload":{"fact":"f16","status":"needs an owner","follow_ups":[{"fact":"f17","workflow":"[Workflow 1]","step":"[Step 1]","due":"2026-10-26T17:27-04:00","label":"Follow-up needs an owner"}],"worth_a_look":0}}"#,
    r#"{"tool":"groups.clashes","source":"Planning Center Groups","check_time":"2026-11-20T15:00:00Z","completeness":"complete","payload":{"fact":"f18","status":"group meets while serving","clashes":[{"fact":"f19","person":"[Person 1]","serving":[{"role":"[Role 3]","status":"pending","time":{"starts_at":"2026-11-22T09:30-05:00","ends_at":"2026-11-22T10:30-05:00"}}],"group_meetings":[{"time":{"starts_at":"2026-11-22T09:30-05:00","ends_at":"2026-11-22T10:30-05:00"}}],"label":"Worth a look"}]}}"#,
    r#"{"tool":"today.attention","source":"Fictional email and calendar import","check_time":"2026-11-19T14:00:00Z","completeness":"complete","payload":{"fact":"f20","import":"invented example records","imported_at":"2026-11-19T09:00-05:00","status":"needs a decision","items":[{"fact":"f21","event":"[Event 1]","kind":"a message says the room is unavailable while the calendar still lists it","starts_at":"2026-11-19T19:00-05:00","volunteers_contacted":"not contacted, according to the message","label":"Needs a decision"}],"gaps":0}}"#,
    r#"{"tool":"rules.current","source":"Church rules on this Mac","check_time":"2026-11-20T15:00:00Z","completeness":"complete","payload":{"fact":"f24","check_in_after_sundays_in_a_row":3,"sunday_leads":[{"lead_role":"[Role 4]"}],"rooms":[{"room":"[Room 1]","rule":"not shared","setup_minutes":15}]}}"#,
    r#"{"tool":"sunday.who_could_help","source":"Planning Center Services","check_time":"2026-11-20T15:00:00Z","completeness":"partial","payload":{"fact":"f20","asked_for":{"role":"[Role 1]"},"times":[{"fact":"f21","role":"[Role 1]","time":{"starts_at":"2026-11-22T09:30-05:00","ends_at":"2026-11-22T10:30-05:00"},"remaining":1}],"people":[{"fact":"f22","role":"[Role 1]","person":"[Person 4]","status":"availability needs confirmation","reasons":["a detail couldn't be verified","a blockout couldn't be checked","other schedules couldn't be read"]},{"fact":"f23","role":"[Role 1]","person":"[Person 5]","status":"availability needs confirmation","reasons":["a detail couldn't be verified","a blockout couldn't be checked","other schedules couldn't be read"]},{"fact":"f24","role":"[Role 1]","person":"[Person 6]","status":"availability needs confirmation","reasons":["a detail couldn't be verified","a blockout couldn't be checked","other schedules couldn't be read"]},{"fact":"f25","role":"[Role 1]","person":"[Person 7]","status":"availability needs confirmation","reasons":["a detail couldn't be verified","a blockout couldn't be checked","other schedules couldn't be read"]},{"fact":"f26","role":"[Role 1]","person":"[Person 8]","status":"availability needs confirmation","reasons":["a detail couldn't be verified","a blockout couldn't be checked","other schedules couldn't be read"]}],"order":"in no particular order, not ranked","willingness":"not recorded; no overlap found doesn't mean free or willing, only the person can say"}}"#,
    r#"{"tool":"drafts.prepare_note","source":"Planning Center Services","check_time":"2026-11-20T15:00:00Z","completeness":"complete","payload":{"draft_id":"d5","asked_for":{"person":"[Person 9]","role":"[Role 1]"},"draft":"Hi [Person 9],\n\nWe still need someone for [Role 1] at 2026-11-22T09:30-05:00. Would you be able to help?\n\nIt's completely fine to say no. Just let me know either way so we can plan.\n\nThank you,\n[Your name]","status":"draft only; nothing has been sent","listed_for_role":"availability needs confirmation"}}"#,
    r#"{"tool":"planning_center.refresh","source":"Planning Center Services","check_time":"2026-11-20T15:00:00Z","completeness":"complete","payload":{"fact":"f21","status":"not needed; the last check is current","mode":"live","reads":26,"reads_not_completed":0}}"#,
];

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::NATIVE_TOOL_ALLOWLIST;

    #[test]
    fn every_bundled_file_parses_under_its_own_name_with_allowlisted_tools() {
        assert_eq!(skills().len(), SKILL_FILES.len());
        for skill in skills() {
            assert!(
                !skill.title.is_empty() && !skill.body.is_empty(),
                "{}",
                skill.id
            );
            assert!(!skill.body.starts_with("---"), "{}", skill.id);
            assert!(!skill.tools.is_empty(), "{}", skill.id);
            for tool in &skill.tools {
                assert!(NATIVE_TOOL_ALLOWLIST.contains(&tool.as_str()), "{tool}");
            }
            assert_eq!(skill.hash.len(), 64);
        }
        assert!(skill(ASK_SKILL).is_some() && skill(CHECK_SKILL).is_some());
        assert!(skill("sunday-check").is_none());
    }

    #[test]
    fn the_bundled_files_are_the_files_on_disk_and_the_typescript_list() {
        // Read at run time beside this crate: the compiled-in copy is the shipped file, byte for byte.
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../skills");
        let mut on_disk: Vec<String> = std::fs::read_dir(&dir)
            .expect("core/skills sits beside this crate")
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".md"))
            .collect();
        on_disk.sort();
        let ours: Vec<&str> = SKILL_FILES.iter().map(|(file, _)| *file).collect();
        assert_eq!(on_disk, ours);
        for (file, text) in SKILL_FILES {
            assert_eq!(
                std::fs::read_to_string(dir.join(file)).unwrap(),
                text,
                "{file}"
            );
        }
        let bundled = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../src/harness/bundled-skills.ts"),
        )
        .expect("core/src/harness/bundled-skills.ts sits beside this crate");
        for (file, _) in SKILL_FILES {
            assert!(bundled.contains(&format!("path: \"{file}\"")), "{file}");
        }
    }

    #[test]
    fn hashes_are_sha256_of_the_exact_file_and_the_body_is_trimmed_after_the_fences() {
        // A known vector, then the frontmatter reader on a file shaped like parseSkill's input.
        assert_eq!(
            sha256_hex("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        let text = "---\r\nid: x-y\ntitle:  A title \ntools: [a.b, c.d]\n---  \n\n  Body line.\n\n";
        let skill = load("x-y.md", text).unwrap();
        assert_eq!(
            (skill.id.as_str(), skill.title.as_str(), skill.body.as_str()),
            ("x-y", "A title", "Body line.")
        );
        assert_eq!(skill.tools, ["a.b", "c.d"]);
        assert_eq!(skill.hash, sha256_hex(text));
        assert!(load("other.md", text).is_none());
        assert!(load("x-y.md", "id: x-y\n").is_none());
    }

    fn fixed_file(name: &str) -> String {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../src/harness/fixed")
            .join(name);
        std::fs::read_to_string(&path).expect("core/src/harness/fixed sits beside this crate")
    }

    #[test]
    fn the_compiled_in_fixed_texts_are_the_files_on_disk() {
        for (name, compiled) in [
            ("policy.txt", POLICY_FILE),
            ("tool-specs.json", TOOL_SPECS_FILE),
            ("vocabulary.json", VOCABULARY_FILE),
            ("common-words.txt", COMMON_WORDS_FILE),
            ("policy-local.txt", LOCAL_POLICY_FILE),
        ] {
            assert_eq!(fixed_file(name), compiled, "{name}");
        }
        assert_eq!(format!("{}\n", policy()), POLICY_FILE);
        assert!(!policy().ends_with('\n'));
        assert_eq!(
            procedure_prompt(),
            "Run this procedure now. Answer only with the JSON object."
        );
        assert!(common_words().len() > 1000);
        assert!(
            common_words()
                .iter()
                .all(|w| !w.is_empty() && *w == w.to_lowercase())
        );
        // Every canonical spec, in allowlist order.
        let names: Vec<&str> = tool_specs().iter().map(|spec| spec.name.as_str()).collect();
        assert_eq!(names, NATIVE_TOOL_ALLOWLIST);
    }

    /// pins.json, recomputed from the files: a changed procedure, policy or format fails here first.
    #[test]
    fn pins_json_holds_the_hash_of_each_procedure_file_and_its_exact_system_message() {
        let pins: Value = serde_json::from_str(&fixed_file("pins.json")).unwrap();
        let procedures = pins["procedures"].as_object().unwrap();
        let mut ids: Vec<&str> = procedures.keys().map(String::as_str).collect();
        ids.sort_unstable();
        let mut ours: Vec<&str> = skills().iter().map(|s| s.id.as_str()).collect();
        ours.sort_unstable();
        assert_eq!(ids, ours);
        for skill in skills() {
            let pin = &procedures[&skill.id];
            assert_eq!(pin["file"], format!("core/skills/{}.md", skill.id));
            assert_eq!(pin["file_sha256"], skill.hash, "{}", skill.id);
            let system = system_text(skill).unwrap();
            assert_eq!(pin["system_sha256"], sha256_hex(&system), "{}", skill.id);
            assert_eq!(
                system,
                format!("{}\n\nProcedure: {}\n{}", policy(), skill.title, skill.body)
            );
        }
        // policy-local.txt, pinned the same way: the file, and the Ask system message it makes (`local_ask_system`),
        // the one a model on this Mac receives. Never a procedure's pin.
        let local = &pins["local_policy"];
        assert_eq!(local["file"], "core/src/harness/fixed/policy-local.txt");
        assert_eq!(local["procedure"], ASK_SKILL);
        assert_eq!(local["file_sha256"], sha256_hex(LOCAL_POLICY_FILE));
        let ask = system_text(skill(ASK_SKILL).unwrap()).unwrap();
        assert_eq!(
            local["system_sha256"],
            sha256_hex(&local_ask_system(&ask).unwrap())
        );
        assert!(
            !procedures
                .values()
                .any(|pin| pin["system_sha256"] == local["system_sha256"])
        );
        // A placeholder inside a procedure is text, never replaced again.
        let odd = BundledSkill {
            id: "x".into(),
            title: "{body} $&".into(),
            tools: Vec::new(),
            body: "{policy} $1".into(),
            hash: String::new(),
        };
        assert_eq!(
            system_text(&odd).unwrap(),
            format!("{}\n\nProcedure: {{body}} $&\n{{policy}} $1", policy())
        );
    }

    /// The prose in vocabulary.json describes rules written out in this file; if it changes, so
    /// must they.
    #[test]
    fn the_rules_vocabulary_json_describes_in_words_are_the_ones_written_here() {
        let v: Value = serde_json::from_str(VOCABULARY_FILE).unwrap();
        assert_eq!(
            v["system_message"]["format"],
            "{policy}\n\nProcedure: {title}\n{body}"
        );
        assert_eq!(
            v["sentence_characters"],
            "ASCII letters and digits, space, line feed, and . , ; : ? ! ' ( ) -"
        );
        assert_eq!(
            v["time_patterns"]["datetime"],
            "YYYY-MM-DDTHH:MM, optionally :SS and .sss, then Z or +HH:MM or -HH:MM"
        );
        assert_eq!(v["time_patterns"]["date"], "YYYY-MM-DD");
        assert_eq!(
            v["labels"]["pattern"],
            "[<family> <n>], n from 1 to 9999 with no leading zero"
        );
        assert_eq!(
            v["envelope_keys"],
            serde_json::json!(["tool", "source", "check_time", "completeness", "payload"])
        );
        assert_eq!(
            v["tool_error_message"],
            "{\"error\":\"<one of tool_errors>\"}"
        );
        assert_eq!(v["tools"], serde_json::json!(NATIVE_TOOL_ALLOWLIST));
        assert_eq!(vocabulary().tools.len(), 13);
    }

    #[test]
    fn every_tool_result_the_harness_writes_fits_the_closed_grammar() {
        let mut tools = HashSet::new();
        for text in SAMPLE_ENVELOPES {
            let Some(ToolMessage::Envelope { tool, slots, .. }) = tool_message(text) else {
                panic!("{text}");
            };
            if tool == "sunday.who_could_help" {
                assert!(slots.iter().any(|slot| slot == "[Person 4]"));
            }
            tools.insert(tool);
        }
        assert_eq!(tools.len(), NATIVE_TOOL_ALLOWLIST.len());
        for error in [
            "denied",
            "stale",
            "partial",
            "provider-failure",
            "unverified",
        ] {
            assert_eq!(
                tool_message(&format!("{{\"error\":\"{error}\"}}")),
                Some(ToolMessage::Error)
            );
        }
    }

    /// Someone scheduled with a blockout over their serving time (fixture matrix C30-C37), as tools.ts writes the
    /// overview over core/test/harness/fixtures.ts `withScheduledBlockouts`: its kind word comes from vocabulary.json.
    #[test]
    fn a_scheduled_blockout_in_the_overview_fits_the_closed_grammar() {
        let text = r#"{"tool":"sunday.overview","source":"Planning Center Services","check_time":"2026-11-20T15:00:00Z","completeness":"complete","payload":{"fact":"f1","mode":"live","sunday":"2026-11-22","reads":26,"reads_not_completed":0,"needs_a_decision":2,"worth_a_look":4,"findings":[{"fact":"f5","kind":"scheduled with a blockout at this time","tone":"worth a look","person":"[Person 2]","serving":[{"role":"[Role 1]","status":"confirmed","time":{"starts_at":"2026-11-22T09:30-05:00","ends_at":"2026-11-22T10:30-05:00"}}]},{"fact":"f6","kind":"scheduled with a blockout at this time","tone":"worth a look","person":"[Person 1]","serving":[{"role":"[Role 3]","status":"pending","time":{"starts_at":"2026-11-22T09:30-05:00","ends_at":"2026-11-22T10:30-05:00"}}]}]}}"#;
        let Some(ToolMessage::Envelope { slots, .. }) = tool_message(text) else {
            panic!("{text}");
        };
        for label in ["[Person 1]", "[Person 2]", "[Role 1]", "[Role 3]"] {
            assert!(slots.iter().any(|slot| slot == label), "{label}");
        }
        // A kind word, or a status, outside vocabulary.json is refused.
        assert_eq!(tool_message(&text.replace("at this time", "today")), None);
        assert_eq!(
            tool_message(&text.replace("\"confirmed\"", "\"away\"")),
            None
        );
    }

    #[test]
    fn anything_outside_the_closed_grammar_is_refused() {
        let base: Value = serde_json::from_str(SAMPLE_ENVELOPES[1]).unwrap();
        assert_eq!(base["tool"], "sunday.open_needs");
        let edited = |change: &dyn Fn(&mut Value)| {
            let mut value = base.clone();
            change(&mut value);
            value.to_string()
        };
        let need = |key: &str, v: Value| {
            let key = key.to_owned();
            edited(&move |e: &mut Value| e["payload"]["needs"][0][&key] = v.clone())
        };
        let cases: Vec<(&str, String)> = vec![
            (
                "extra envelope key",
                edited(&|e| e["note"] = Value::from("x")),
            ),
            (
                "missing payload",
                edited(&|e| {
                    e.as_object_mut().unwrap().remove("payload");
                }),
            ),
            (
                "array payload",
                edited(&|e| e["payload"] = serde_json::json!([])),
            ),
            (
                "unknown tool",
                edited(&|e| e["tool"] = Value::from("shell.run")),
            ),
            (
                "free-text source",
                edited(&|e| e["source"] = Value::from("Riley's phone")),
            ),
            (
                "unknown completeness",
                edited(&|e| e["completeness"] = Value::from("mostly")),
            ),
            (
                "date-only check time",
                edited(&|e| e["check_time"] = Value::from("2026-11-20")),
            ),
            (
                "impossible check time",
                edited(&|e| e["check_time"] = Value::from("2026-02-30T10:00Z")),
            ),
            (
                "check time past midnight",
                edited(&|e| e["check_time"] = Value::from("2026-11-20T24:00Z")),
            ),
            (
                "payload key outside the vocabulary",
                need("note", Value::from("fine")),
            ),
            ("free text", need("kind", Value::from("Riley Thornbury"))),
            (
                "free text near a value",
                need("kind", Value::from("needs people ")),
            ),
            (
                "a sentence outside a sentence key",
                need("kind", Value::from("We still need someone.")),
            ),
            (
                "label of an unknown family",
                need("role", Value::from("[Group 1]")),
            ),
            (
                "label with a leading zero",
                need("role", Value::from("[Role 01]")),
            ),
            ("label with a name", need("role", Value::from("[Riley 1]"))),
            ("null", need("remaining", Value::Null)),
            ("negative count", need("remaining", Value::from(-1))),
            ("fractional count", need("remaining", Value::from(1.5))),
            (
                "seven-digit count",
                need("remaining", Value::from(5_551_234)),
            ),
            (
                "deep nesting",
                need(
                    "confirmed",
                    serde_json::json!([[[[[[[[["[Person 1]"]]]]]]]]]),
                ),
            ),
            (
                "impossible date",
                need(
                    "time",
                    serde_json::json!({"starts_at": "2026-02-30T09:30-05:00"}),
                ),
            ),
            ("not error code", r#"{"error":"Riley called"}"#.to_owned()),
            (
                "error with more",
                r#"{"error":"denied","why":"x"}"#.to_owned(),
            ),
            ("not json", "Riley".to_owned()),
            ("a list", "[]".to_owned()),
        ];
        for (why, text) in &cases {
            assert_eq!(tool_message(text), None, "{why}");
        }
        // A repeated key: a reader keeps one value, a model may read the other.
        let repeated = SAMPLE_ENVELOPES[1].replacen(
            "\"tool\":\"sunday.open_needs\"",
            "\"tool\":\"Riley Thornbury\",\"tool\":\"sunday.open_needs\"",
            1,
        );
        assert!(serde_json::from_str::<Value>(&repeated).is_ok());
        assert_eq!(tool_message(&repeated), None);
        // Nesting up to MAX_PAYLOAD_DEPTH is fine: the payload, the needs list, a need and five lists.
        let deep = need("confirmed", serde_json::json!([[[[["[Person 1]"]]]]]));
        assert!(tool_message(&deep).is_some());
    }

    #[test]
    fn sentences_hold_only_fixed_words_labels_times_and_counts() {
        let draft: Value = serde_json::from_str(SAMPLE_ENVELOPES[11]).unwrap();
        assert_eq!(draft["tool"], "drafts.prepare_note");
        let with_draft = |text: &str| {
            let mut value = draft.clone();
            value["payload"]["draft"] = Value::from(text);
            value.to_string()
        };
        for text in [
            "Hi [Person 9], would you be able to help for [Role 1] on 2026-11-22T09:30-05:00? Thank you, [Your name]",
            "We still need someone for [Role 1] on 2026-11-22.",
            "Just let me know either way.\n\nThank you,\n[Your name]",
            "",
        ] {
            assert!(tool_message(&with_draft(text)).is_some(), "{text:?}");
        }
        for text in [
            "Hi Riley, would you be able to help?",
            "Hi [Person 9], call 555 1234.",
            "We still need someone for Greeter.",
            "Hi [Person 9] \u{2014} thanks",
            "Hi [Person 9]; see [Room 1]] now",
            "Hi [Group 1]",
            "Thanks <b>",
            "pat@example",
        ] {
            assert_eq!(tool_message(&with_draft(text)), None, "{text:?}");
        }
        // [Your name] only under a draft.
        let mut services: Value = serde_json::from_str(SAMPLE_ENVELOPES[0]).unwrap();
        services["payload"]["services"] = Value::from("Thank you, [Your name]");
        assert_eq!(tool_message(&services.to_string()), None);
        services["payload"]["services"] = Value::from("[Role 1] still need 2 more people");
        assert!(tool_message(&services.to_string()).is_some());
    }

    #[test]
    fn iso_times_are_the_readme_shapes_and_real_dates() {
        for text in [
            "2026-11-22",
            "2024-02-29",
            "2026-11-22T09:30Z",
            "2026-11-22T09:30-05:00",
            "2026-11-22T09:30:15+14:00",
            "2026-11-22T09:30:15.123Z",
        ] {
            assert!(iso_time(text), "{text}");
        }
        for text in [
            "2026-02-29",
            "2026-11-31",
            "2026-13-01",
            "2026-11-22T09:30",
            "2026-11-22T24:00Z",
            "2026-11-22T09:60Z",
            "2026-11-22T09:30:15.12Z",
            "2026-11-22T09:30+24:00",
            "2026-11-22 09:30Z",
            "２０２６-11-22",
            "2026-11-22T09:30Zx",
        ] {
            assert!(!iso_time(text), "{text}");
        }
    }
}
