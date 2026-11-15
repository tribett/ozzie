//! Background-check wording, refused natively before any request to any model route and before the
//! copy shared with other AI apps is written (owner decision 2026-11-14: background-check facts stay on
//! this Mac, never sent to any model route or put in the shared copy, even as placeholders; review Q H2,
//! reviews B and B2). The page refuses such a question first (core/src/ask.ts); this is the second
//! refusal, for anything a page bug, a new caller or a later change lets through, and ozzie.church's
//! route is the third (web/src/lib/hosted/background.ts).
//!
//! One list: core/src/harness/fixed/background-wording.json, compiled in here, read by the page
//! (core/src/harness/background-wording.ts) and copied byte for byte to ozzie.church. The rule below is
//! the page's, written out again. What the tests show: this side reaches the page's verdict on every text
//! of the oracle corpus (on which the list refuses everything the page regex of v0.1.0 refused, apart
//! from Ozzie's one own sentence) and the page's words for every Unicode scalar value under each folding
//! (core/test/harness/background-wording-differential.json); the shared vectors run here too.
//!
//! A text that is exactly one of Ozzie's own sentences (the file's `ozzies_own`, carried whole by a
//! tool result) holds no wording. Otherwise it holds wording when any of three foldings does: the
//! file's `newer_unicode` characters mapped first (so neither side's Unicode data decides them), then
//! NFKC, then format, private-use and default-ignorable characters and the blank braille pattern
//! deleted (`Join`), as word breaks (`Split`), or as v0.1.0 read them (`V010`: deleted when it deleted
//! them, a word break otherwise), then accents removed and lower case. Words are runs of a-z and 0-9;
//! every other character separates them. A phrase is words in a row; each slot is one of its
//! alternatives exactly, or as a prefix when it ends in `*`. Not caught: letters of other scripts that
//! only look Latin, letter-spaced or digit-for-letter spellings, and paraphrases.
//!
//! Callers scan only what varies: the question, the note being reworded, fact lines, the model's own
//! words, tool arguments, and tool results one string at a time (`in_tool_result`, so a key and a
//! neighbouring value never join into a phrase and Ozzie's own sentence is set aside only as a whole
//! string). Ozzie's own words (system messages, tool specs, the procedure prompt and the rewording
//! choices) are pinned byte for byte by the same checks, and a test shows none of them holds the
//! wording apart from the two pinned sentences it names.
//!
//! A match returns only a fixed code (`ModelError::BackgroundCheck`, `AgentError::BackgroundCheck`,
//! `ShareError::Invalid`): no part of the matched text is logged, returned or recorded.
use crate::name_guard::{category, invisible};
use icu_normalizer::{ComposingNormalizerBorrowed, DecomposingNormalizerBorrowed};
use icu_properties::props::{GeneralCategory, GeneralCategoryGroup};
use serde::Deserialize;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::OnceLock;

/// background-wording.json: the one list.
pub const WORDING_FILE: &str = include_str!("../../src/harness/fixed/background-wording.json");

/// The three foldings (the file's `about`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Folding {
    /// Ignorable characters deleted, so one inside a word hides nothing.
    Join,
    /// Ignorable characters as word breaks, so an invisible blank between words hides nothing.
    Split,
    /// As v0.1.0's page read them: deleted when it deleted them, a word break otherwise.
    V010,
}
pub const FOLDINGS: [Folding; 3] = [Folding::Join, Folding::Split, Folding::V010];

struct Alternative {
    word: String,
    prefix: bool,
}
type Phrase = Vec<Vec<Alternative>>;
pub(crate) struct Compiled {
    phrases: Vec<Phrase>,
    own: Vec<String>,
    removed: HashSet<u32>,
    letters: HashMap<u32, String>,
}

fn plain_word(word: &str) -> bool {
    !word.is_empty()
        && word
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}
fn hex(text: &str) -> Option<u32> {
    let ok = (4..=6).contains(&text.len())
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'A'..=b'F').contains(&b));
    ok.then(|| u32::from_str_radix(text, 16).ok()).flatten()
}
/// One phrase: slots split on single spaces, alternatives on `|`, a prefix when it ends in `*`.
fn parse_phrase(text: &str) -> Option<Phrase> {
    text.split(' ')
        .map(|slot| {
            slot.split('|')
                .map(|alt| {
                    let (word, prefix) = match alt.strip_suffix('*') {
                        Some(word) => (word, true),
                        None => (alt, false),
                    };
                    plain_word(word).then(|| Alternative {
                        word: word.to_owned(),
                        prefix,
                    })
                })
                .collect::<Option<Vec<_>>>()
        })
        .collect()
}

#[derive(Deserialize)]
struct NewerUnicode {
    removed: Vec<String>,
    letters: BTreeMap<String, String>,
}
#[derive(Deserialize)]
struct WordingList {
    phrases: Vec<String>,
    ozzies_own: Vec<String>,
    newer_unicode: NewerUnicode,
}
/// A list file's phrases, Ozzie's own sentences and newer characters, or None when any part doesn't parse.
pub(crate) fn parse_list(file: &str) -> Option<Compiled> {
    let list: WordingList = serde_json::from_str(file).ok()?;
    if list.phrases.is_empty() || list.ozzies_own.iter().any(String::is_empty) {
        return None;
    }
    let phrases = list
        .phrases
        .iter()
        .map(|phrase| parse_phrase(phrase))
        .collect::<Option<Vec<_>>>()?;
    let removed = list
        .newer_unicode
        .removed
        .iter()
        .map(|h| hex(h))
        .collect::<Option<HashSet<_>>>()?;
    let letters = list
        .newer_unicode
        .letters
        .iter()
        .map(|(h, to)| plain_word(to).then(|| hex(h).map(|at| (at, to.clone())))?)
        .collect::<Option<HashMap<_, _>>>()?;
    Some(Compiled {
        phrases,
        own: list.ozzies_own,
        removed,
        letters,
    })
}
/// The compiled-in list; None only if the file failed to parse, which a test rules out.
fn compiled() -> Option<&'static Compiled> {
    static COMPILED: OnceLock<Option<Compiled>> = OnceLock::new();
    COMPILED.get_or_init(|| parse_list(WORDING_FILE)).as_ref()
}

/// Whether `c` is one of the list's newer characters: a hidden character wherever one is refused
/// (a question, a note, any text an agent step varies), since no one types them and each folding
/// reads them only one way (review B3 L-1; the page's `newerCharacter`). Every character is one if
/// the compiled-in list didn't parse.
pub(crate) fn newer(c: char) -> bool {
    compiled().is_none_or(|list| {
        list.removed.contains(&u32::from(c)) || list.letters.contains_key(&u32::from(c))
    })
}

fn mark(c: char) -> bool {
    GeneralCategoryGroup::Mark.contains(category(c))
}
/// What v0.1.0's fold deleted (draft-request.ts `fold`): format and private-use characters, the
/// combining grapheme joiner, variation selectors and tags.
fn deleted_in_v010(c: char) -> bool {
    matches!(
        category(c),
        GeneralCategory::Format | GeneralCategory::PrivateUse
    ) || matches!(c, '\u{34f}' | '\u{fe00}'..='\u{fe0f}' | '\u{e0000}'..='\u{e007f}')
}
/// Format, private-use and default-ignorable characters and the blank braille pattern.
fn ignorable(c: char) -> bool {
    deleted_in_v010(c) || invisible(c)
}
/// Letters that keep their stroke or ligature through NFD, spelled plainly (name_guard.rs).
fn plain_letter(c: char, out: &mut String) {
    match c {
        '\u{f8}' => out.push('o'),
        '\u{142}' => out.push('l'),
        '\u{111}' | '\u{f0}' => out.push('d'),
        '\u{127}' => out.push('h'),
        '\u{131}' => out.push('i'),
        '\u{df}' => out.push_str("ss"),
        '\u{e6}' => out.push_str("ae"),
        '\u{153}' => out.push_str("oe"),
        '\u{fe}' => out.push_str("th"),
        '\u{3c2}' => out.push('\u{3c3}'),
        c => out.push(c),
    }
}
fn fold_with(list: &Compiled, text: &str, folding: Folding) -> String {
    let mut mapped = String::with_capacity(text.len());
    for c in text.chars() {
        let at = c as u32;
        if let Some(letter) = list.letters.get(&at) {
            if folding == Folding::Join {
                mapped.push_str(letter);
            } else {
                mapped.push(' ');
            }
        } else if list.removed.contains(&at) {
            if folding != Folding::Join {
                mapped.push(' ');
            }
        } else {
            mapped.push(c);
        }
    }
    let compat = ComposingNormalizerBorrowed::new_nfkc().normalize(&mapped);
    let mut kept = String::with_capacity(compat.len());
    for c in compat.chars() {
        if !ignorable(c) {
            kept.push(c);
        } else if folding == Folding::Split
            || (folding == Folding::V010 && !deleted_in_v010(c) && !mark(c))
        {
            kept.push(' ');
        }
    }
    let lower = DecomposingNormalizerBorrowed::new_nfd()
        .normalize(&kept)
        .chars()
        .filter(|&c| !mark(c))
        .collect::<String>()
        .to_lowercase();
    let mut out = String::with_capacity(lower.len());
    for c in lower.chars() {
        plain_letter(c, &mut out);
    }
    out
}
/// One folding of a text, before it is split into words. Every text folds to nothing if the list
/// didn't parse (and `background_wording` then refuses it).
pub fn fold(text: &str, folding: Folding) -> String {
    compiled().map_or_else(String::new, |list| fold_with(list, text, folding))
}

fn split_words(folded: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut word = String::new();
    for c in folded.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            word.push(c);
        } else if !word.is_empty() {
            out.push(std::mem::take(&mut word));
        }
    }
    if !word.is_empty() {
        out.push(word);
    }
    out
}
/// The words of a text under one folding: runs of a-z and 0-9; everything else separates.
pub fn tokens(text: &str, folding: Folding) -> Vec<String> {
    split_words(&fold(text, folding))
}

fn phrase_at(phrase: &Phrase, tokens: &[String], at: usize) -> bool {
    at + phrase.len() <= tokens.len()
        && phrase.iter().enumerate().all(|(k, slot)| {
            let token = &tokens[at + k];
            slot.iter().any(|alt| {
                if alt.prefix {
                    token.starts_with(&alt.word)
                } else {
                    *token == alt.word
                }
            })
        })
}

/// Whether text holds background-check wording: under any of the three foldings, unless the whole
/// text is one of Ozzie's own sentences. Fails closed: if the compiled-in list didn't parse, every
/// text counts as holding it, so nothing is sent.
pub fn background_wording(text: &str) -> bool {
    holds(compiled(), text)
}
fn holds(list: Option<&Compiled>, text: &str) -> bool {
    let Some(list) = list else {
        return true;
    };
    if list.own.iter().any(|sentence| sentence == text) {
        return false;
    }
    FOLDINGS.iter().any(|&folding| {
        let tokens = split_words(&fold_with(list, text, folding));
        (0..tokens.len()).any(|at| {
            list.phrases
                .iter()
                .any(|phrase| phrase_at(phrase, &tokens, at))
        })
    })
}

/// One JSON string literal (quotes included), decoded; a lone surrogate escape becomes U+FFFD, which
/// separates words as the lone UTF-16 unit JavaScript decodes it to does.
fn decode_literal(literal: &str) -> Option<String> {
    let inner = literal.strip_prefix('"')?.strip_suffix('"')?;
    let mut out = String::with_capacity(inner.len());
    let mut chars = inner.chars();
    let hex4 = |chars: &mut std::str::Chars| -> Option<u32> {
        let digits: String = chars.by_ref().take(4).collect();
        (digits.len() == 4 && digits.bytes().all(|b| b.is_ascii_hexdigit()))
            .then(|| u32::from_str_radix(&digits, 16).ok())
            .flatten()
    };
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next()? {
            '"' => out.push('"'),
            '\\' => out.push('\\'),
            '/' => out.push('/'),
            'b' => out.push('\u{8}'),
            'f' => out.push('\u{c}'),
            'n' => out.push('\n'),
            'r' => out.push('\r'),
            't' => out.push('\t'),
            'u' => {
                let unit = hex4(&mut chars)?;
                if (0xd800..0xdc00).contains(&unit) {
                    let mut ahead = chars.clone();
                    let low = (ahead.next() == Some('\\') && ahead.next() == Some('u'))
                        .then(|| hex4(&mut ahead))
                        .flatten()
                        .filter(|low| (0xdc00..0xe000).contains(low));
                    match low {
                        Some(low) => {
                            chars = ahead;
                            out.push(char::from_u32(
                                0x10000 + ((unit - 0xd800) << 10) + (low - 0xdc00),
                            )?);
                        }
                        None => out.push('\u{fffd}'),
                    }
                } else {
                    out.push(char::from_u32(unit).unwrap_or('\u{fffd}'));
                }
            }
            _ => return None,
        }
    }
    Some(out)
}
/// Whether a text is JSON as JavaScript reads it: serde_json refuses a lone surrogate escape, which
/// JSON.parse accepts, so each is replaced with U+FFFD's escape before asking serde_json.
fn json_as_javascript_reads_it(text: &str) -> bool {
    if serde_json::from_str::<serde::de::IgnoredAny>(text).is_ok() {
        return true;
    }
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('u') => {
                let digits: String = chars.clone().take(4).collect();
                let surrogate = digits.len() == 4
                    && digits.bytes().all(|b| b.is_ascii_hexdigit())
                    && u32::from_str_radix(&digits, 16)
                        .is_ok_and(|unit| (0xd800..0xe000).contains(&unit));
                if surrogate {
                    chars.nth(3);
                    out.push_str("\\ufffd");
                } else {
                    out.push_str("\\u");
                }
            }
            Some(other) => {
                out.push('\\');
                out.push(other);
            }
            None => out.push('\\'),
        }
    }
    serde_json::from_str::<serde::de::IgnoredAny>(&out).is_ok()
}
/// Every string literal of a JSON text, keys and values alike, decoded, in order; None when the text
/// isn't JSON. Read literal by literal, so a repeated key's earlier value is read too.
fn json_strings(text: &str) -> Option<Vec<String>> {
    if !json_as_javascript_reads_it(text) {
        return None;
    }
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut at = 0;
    while let Some(start) = text[at..].find('"').map(|offset| at + offset) {
        let mut end = start + 1;
        while end < bytes.len() && bytes[end] != b'"' {
            end += if bytes[end] == b'\\' { 2 } else { 1 };
        }
        out.push(decode_literal(text.get(start..=end)?)?);
        at = end + 1;
    }
    Some(out)
}
/// Whether a tool result holds the wording: each of its strings on its own, so a key and a
/// neighbouring value never join into a phrase ("records", "check_time") and Ozzie's own sentence is
/// set aside only as a whole string; the whole text when it isn't JSON.
pub fn in_tool_result(text: &str) -> bool {
    match json_strings(text) {
        Some(strings) => strings.iter().any(|s| background_wording(s)),
        None => background_wording(text),
    }
}

#[cfg(test)]
#[path = "background_tests.rs"]
mod tests;
