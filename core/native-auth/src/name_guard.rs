//! Native defence in depth for the never-list: real people's names never go to a model.
//!
//! The webview's placeholder boundary is the primary guard, and the closed grammars (Ask's fact
//! lines, the agent path's pinned texts and envelopes) come before this one. It runs in native code
//! before any model request, against the names of every capture this session has shown, so a
//! compromised or buggy webview has to get past it too. It finds names the way Ask's rules define
//! them: whole words after folding case, accents and compatibility forms, joined parts, names
//! spelled out a letter at a time, invisible characters (Default_Ignorable_Code_Point and the blank
//! braille pattern) removed, and Latin letters imitated by a small table of Cyrillic, Greek and
//! small-capital lookalikes. It is a guard against those disguises, not a proof that no name can
//! pass: a name split across fields or messages, or written in a way these rules don't model,
//! is not found here. It mirrors `fold`/`nameTerms`/`containsName` in core/src/draft-request.ts
//! and `askNameTerms`/`hits` in core/src/ask.ts; core/test/ask-parity.json holds vectors both
//! sides run (the lookalike and invisible-character rules are native-only so far; see the
//! `pendingNative` vectors there). The agent path's question and model output use the owner's
//! "capitalized only" rule (`present_in_prose`, core/src/harness/names.ts; vectors
//! `capitalizedCommonWords`); everything else stays strict. Names live only in memory: never
//! persisted, logged or returned.
use icu_normalizer::{ComposingNormalizerBorrowed, DecomposingNormalizerBorrowed};
use icu_properties::{
    CodePointMapData, CodePointSetData,
    props::{DefaultIgnorableCodePoint, GeneralCategory, GeneralCategoryGroup, Script},
};
use std::collections::{BTreeSet, HashMap, HashSet};

pub(crate) fn category(c: char) -> GeneralCategory {
    CodePointMapData::<GeneralCategory>::new().get(c)
}
fn letter(c: char) -> bool {
    GeneralCategoryGroup::Letter.contains(category(c))
}
pub(crate) fn letter_or_number(c: char) -> bool {
    letter(c) || GeneralCategoryGroup::Number.contains(category(c))
}
/// Any decimal digit, in any script ("٥", "५", fullwidth "５").
pub(crate) fn decimal_digit(c: char) -> bool {
    category(c) == GeneralCategory::DecimalNumber
}
/// Default_Ignorable_Code_Point (zero-width characters, joiners, Hangul fillers, variation
/// selectors, tags, soft hyphen) and the blank braille pattern U+2800: characters that show
/// nothing, so a name split by one still reads whole.
pub(crate) fn invisible(c: char) -> bool {
    c == '\u{2800}' || CodePointSetData::new::<DefaultIgnorableCodePoint>().contains(c)
}
/// Every line break Unicode or JavaScript recognizes.
pub(crate) fn line_break(c: char) -> bool {
    matches!(
        c,
        '\n' | '\r' | '\u{b}' | '\u{c}' | '\u{85}' | '\u{2028}' | '\u{2029}'
    )
}
/// A character of a script written without spaces between words: Han, Hangul, Hiragana,
/// Katakana, Thai (the webview's UNSPACED).
fn unspaced_char(c: char) -> bool {
    matches!(
        CodePointMapData::<Script>::new().get(c),
        Script::Han | Script::Hangul | Script::Hiragana | Script::Katakana | Script::Thai
    )
}
/// Scripts written without spaces between words, where any single character can be a name.
fn unspaced(text: &str) -> bool {
    text.chars().any(unspaced_char)
}
/// Only a letter of a spaced script continues a word (coordinator decision 2026-11-13): digits,
/// symbols, punctuation, spaces and letters of unspaced scripts are all word boundaries, so
/// "Riley2", "Rileyさん" and "คุณRiley" are found. Mirrors `wordChar` in core/src/ask.ts.
fn word_char(c: char) -> bool {
    letter(c) && !unspaced_char(c)
}

/// Letters that keep their stroke or ligature through NFD, spelled the way people type them
/// without it, and Greek final sigma unified with sigma. Mirrors PLAIN_LETTERS in draft-request.ts.
fn plain_letters(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
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
    out
}

/// Comparison form: compatibility-normalized; format, private-use and invisible characters
/// (`invisible`: variation selectors, tags, Hangul fillers and the like) removed; accents removed;
/// apostrophes and dashes unified; lowercased; then stroked letters and ligatures spelled plainly
/// (ø → o, ß → ss) and final sigma unified.
pub fn fold(text: &str) -> String {
    let compat = ComposingNormalizerBorrowed::new_nfkc().normalize(text);
    fold_compat(&compat)
}
fn fold_compat(compat: &str) -> String {
    let visible: String = compat
        .chars()
        .filter(|&c| {
            !invisible(c)
                && !matches!(
                    category(c),
                    GeneralCategory::Format | GeneralCategory::PrivateUse
                )
        })
        .collect();
    let decomposed = DecomposingNormalizerBorrowed::new_nfd().normalize(&visible);
    let lower = decomposed
        .chars()
        .filter(|&c| !GeneralCategoryGroup::Mark.contains(category(c)))
        .map(|c| match c {
            '\u{2018}' | '\u{2019}' | '\u{2BC}' | '\u{2B9}' | '`' | '\u{B4}' => '\'',
            '\u{2010}'..='\u{2015}' | '\u{2212}' => '-',
            c => c,
        })
        .collect::<String>()
        .to_lowercase();
    plain_letters(&lower)
}

/// Name parts worth matching: the full name, each piece split on non-letters/numbers, and the
/// joined form of each whitespace segment. Lengths count characters (JS counts UTF-16 units;
/// they differ only outside the Basic Multilingual Plane).
fn terms(full: &str) -> Vec<String> {
    let folded = fold(full);
    let folded = folded.trim();
    if folded.is_empty() {
        return Vec::new();
    }
    let pieces = folded
        .split(|c: char| !letter_or_number(c))
        .map(str::to_owned);
    let joined = folded
        .split(char::is_whitespace)
        .map(|segment| segment.chars().filter(|&c| letter_or_number(c)).collect());
    std::iter::once(folded.to_owned())
        .chain(pieces)
        .chain(joined)
        .filter(|term: &String| {
            let len = term.chars().count();
            len >= 2 || (len >= 1 && unspaced(term))
        })
        .collect()
}
/// Ask's terms: `terms`, plus every run of two or more consecutive whole parts joined
/// ("marykate", "delacruz" for "de la Cruz"). Mirrors `askNameTerms` in core/src/ask.ts.
fn word_terms(full: &str) -> Vec<String> {
    let mut all = terms(full);
    let folded = fold(full);
    let parts: Vec<String> = folded
        .trim()
        .split(char::is_whitespace)
        .map(|part| part.chars().filter(|&c| letter_or_number(c)).collect())
        .filter(|part: &String| !part.is_empty())
        .collect();
    for start in 0..parts.len() {
        for end in start + 2..=parts.len() {
            all.push(parts[start..end].concat());
        }
    }
    all
}
/// Byte offsets of every occurrence of `term` in `text`, overlapping ones included (as the
/// webview's indexOf loop finds them).
fn occurrences<'a>(text: &'a str, term: &'a str) -> impl Iterator<Item = usize> + 'a {
    let mut from = 0;
    std::iter::from_fn(move || {
        let at = from + text.get(from..)?.find(term)?;
        from = at + text[at..].chars().next().map_or(1, char::len_utf8);
        Some(at)
    })
}
/// Ask's whole-word rule for `term` found at byte `at` of `text`: no word character before it, and
/// none after it except an optional plural or possessive "s".
fn bounded(text: &str, at: usize, term: &str) -> bool {
    let word = |c: Option<char>| c.is_some_and(word_char);
    let before = text[..at].chars().next_back();
    let mut after = text[at + term.len()..].chars();
    let next = after.next();
    !word(before) && (!word(next) || (next == Some('s') && !word(after.next())))
}

/// The Latin letter a Cyrillic, Greek, small-capital or IPA letter imitates. A small hand-written
/// table in the spirit of UTS #39's confusables, not the whole of it. Capitals map to capitals, so
/// Greek capital eta (H) and small eta (n) stay apart until `fold` lowercases.
fn lookalike(c: char) -> Option<char> {
    Some(match c {
        // Cyrillic capitals: А В Е Ѕ І Ӏ Ј К М Н Һ О Р С Т У Ү Х Ԛ Ԝ Ѵ
        '\u{410}' => 'A',
        '\u{412}' => 'B',
        '\u{415}' => 'E',
        '\u{405}' => 'S',
        '\u{406}' | '\u{4c0}' => 'I',
        '\u{408}' => 'J',
        '\u{41a}' => 'K',
        '\u{41c}' => 'M',
        '\u{41d}' | '\u{4ba}' => 'H',
        '\u{41e}' => 'O',
        '\u{420}' => 'P',
        '\u{421}' => 'C',
        '\u{422}' => 'T',
        '\u{423}' | '\u{4ae}' => 'Y',
        '\u{425}' => 'X',
        '\u{51a}' => 'Q',
        '\u{51c}' => 'W',
        '\u{474}' => 'V',
        // Cyrillic small letters: а в ь г е к м н һ о п р с т у ү х ѕ і ӏ ј ԁ ԛ ԝ ѵ
        '\u{430}' => 'a',
        '\u{432}' | '\u{44c}' => 'b',
        '\u{433}' => 'r',
        '\u{435}' => 'e',
        '\u{43a}' => 'k',
        '\u{43c}' => 'm',
        '\u{43d}' | '\u{4bb}' => 'h',
        '\u{43e}' => 'o',
        '\u{43f}' => 'n',
        '\u{440}' => 'p',
        '\u{441}' => 'c',
        '\u{442}' => 't',
        '\u{443}' | '\u{4af}' => 'y',
        '\u{445}' => 'x',
        '\u{455}' => 's',
        '\u{456}' => 'i',
        '\u{4cf}' => 'l',
        '\u{458}' => 'j',
        '\u{501}' => 'd',
        '\u{51b}' => 'q',
        '\u{51d}' => 'w',
        '\u{475}' => 'v',
        // Greek capitals: Α Β Ε Ζ Η Ι Ϳ Κ Μ Ν Ο Ρ Τ Υ Χ
        '\u{391}' => 'A',
        '\u{392}' => 'B',
        '\u{395}' => 'E',
        '\u{396}' => 'Z',
        '\u{397}' => 'H',
        '\u{399}' => 'I',
        '\u{37f}' => 'J',
        '\u{39a}' => 'K',
        '\u{39c}' => 'M',
        '\u{39d}' => 'N',
        '\u{39f}' => 'O',
        '\u{3a1}' => 'P',
        '\u{3a4}' => 'T',
        '\u{3a5}' => 'Y',
        '\u{3a7}' => 'X',
        // Greek small letters: α γ ε η ι ϳ κ μ υ ν ο ρ τ χ ω
        '\u{3b1}' => 'a',
        '\u{3b3}' => 'y',
        '\u{3b5}' => 'e',
        '\u{3b7}' => 'n',
        '\u{3b9}' => 'i',
        '\u{3f3}' => 'j',
        '\u{3ba}' => 'k',
        '\u{3bc}' | '\u{3c5}' => 'u',
        '\u{3bd}' => 'v',
        '\u{3bf}' => 'o',
        '\u{3c1}' => 'p',
        '\u{3c4}' => 't',
        '\u{3c7}' => 'x',
        '\u{3c9}' => 'w',
        // Latin small capitals and IPA letters: ᴀ ɑ ʙ ᴄ ᴅ ᴇ ꜰ ɢ ɡ ʜ ɪ ɩ ᴊ ᴋ ʟ ᴍ ɴ ᴏ ᴘ ʀ ꜱ ᴛ ᴜ ᴠ ʋ ᴡ ʏ ᴢ
        '\u{1d00}' | '\u{251}' => 'a',
        '\u{299}' => 'b',
        '\u{1d04}' => 'c',
        '\u{1d05}' => 'd',
        '\u{1d07}' => 'e',
        '\u{a730}' => 'f',
        '\u{262}' | '\u{261}' => 'g',
        '\u{29c}' => 'h',
        '\u{26a}' | '\u{269}' => 'i',
        '\u{1d0a}' => 'j',
        '\u{1d0b}' => 'k',
        '\u{29f}' => 'l',
        '\u{1d0d}' => 'm',
        '\u{274}' => 'n',
        '\u{1d0f}' => 'o',
        '\u{1d18}' => 'p',
        '\u{280}' => 'r',
        '\u{a731}' => 's',
        '\u{1d1b}' => 't',
        '\u{1d1c}' => 'u',
        '\u{1d20}' | '\u{28b}' => 'v',
        '\u{1d21}' => 'w',
        '\u{28f}' => 'y',
        '\u{1d22}' => 'z',
        _ => return None,
    })
}
/// The comparison form with lookalike letters read as the Latin letters they imitate, or None
/// when the text has none (the common case, so the extra variant costs one scan).
fn lookalike_fold(text: &str) -> Option<String> {
    let compat = ComposingNormalizerBorrowed::new_nfkc().normalize(text);
    if !compat.chars().any(|c| lookalike(c).is_some()) {
        return None;
    }
    let latin: String = compat.chars().map(|c| lookalike(c).unwrap_or(c)).collect();
    Some(fold_compat(&latin))
}

/// Weekday and month names (core/src/ask.ts CALENDAR_WORDS): under the prose rule a name only
/// beside another part of the same member's name.
const CALENDAR_WORDS: [&str; 19] = [
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
];
/// Words before which a following "'s" is a contraction ("it's", "let's"), never a possessive.
const S_CONTRACTED: [&str; 13] = [
    "it", "that", "what", "who", "there", "here", "he", "she", "let", "where", "how", "when", "why",
];
/// A part the prose rule reads only beside the rest of a member's name: a calendar word, or
/// "church" (Ozzie's own term "Church rules").
fn beside_only(part: &str) -> bool {
    CALENDAR_WORDS.contains(&part) || part == "church"
}
/// What may stand between two parts of one person's name, folded (core/src/ask.ts NEIGHBOUR_GAP).
fn neighbour_gap(gap: &str) -> bool {
    (1..=3).contains(&gap.chars().count())
        && gap.chars().all(|c| c.is_whitespace() || ",.'-".contains(c))
}
/// One word of a text as the prose rule reads it: folded, and whether its first letter is a
/// capital (Lu or Lt, after NFKC).
struct Word {
    folded: String,
    capital: bool,
}
/// The words of a text (runs of `word_char`, with the marks that follow a letter) and the folded
/// gaps around them: `gaps[i]` stands before `words[i]`, and `gaps[words.len()]` after the last.
/// Invisible and format characters are dropped first, as `fold` drops them, so they neither split
/// nor join a word here.
fn prose_words(text: &str) -> (Vec<Word>, Vec<String>) {
    let compat = ComposingNormalizerBorrowed::new_nfkc().normalize(text);
    let (mut words, mut gaps) = (Vec::new(), Vec::new());
    let (mut word, mut gap) = (String::new(), String::new());
    let flush = |word: &mut String, words: &mut Vec<Word>| {
        let capital = word.chars().next().is_some_and(|c| {
            matches!(
                category(c),
                GeneralCategory::UppercaseLetter | GeneralCategory::TitlecaseLetter
            )
        });
        words.push(Word {
            folded: fold_compat(word),
            capital,
        });
        word.clear();
    };
    for c in compat.chars() {
        if invisible(c)
            || matches!(
                category(c),
                GeneralCategory::Format | GeneralCategory::PrivateUse
            )
        {
            continue;
        }
        let mark = GeneralCategoryGroup::Mark.contains(category(c));
        if word_char(c) || (mark && !word.is_empty()) {
            if word.is_empty() {
                gaps.push(fold_compat(&std::mem::take(&mut gap)));
            }
            word.push(c);
        } else {
            if !word.is_empty() {
                flush(&mut word, &mut words);
            }
            gap.push(c);
        }
    }
    if !word.is_empty() {
        flush(&mut word, &mut words);
    }
    gaps.push(fold_compat(&gap));
    (words, gaps)
}
/// A contraction directly after `term` (the word at `at`, read without a plural "s"): an
/// apostrophe, then n't's t, ll, d, ve, re or m, or s after it, that, what … (core/src/ask.ts
/// `contracted`).
fn contracted(words: &[Word], gaps: &[String], at: usize, term: &str) -> bool {
    let Some(suffix) = words.get(at + 1).map(|w| w.folded.as_str()) else {
        return false;
    };
    gaps[at + 1] == "'"
        && (["ll", "d", "ve", "re", "m"].contains(&suffix)
            || (suffix == "t" && term.ends_with('n'))
            || (suffix == "s" && S_CONTRACTED.contains(&term)))
}

/// How far apart the letters of a spelled-out name may be.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Gaps {
    /// Ask's rule, shared with the webview: one or two of " .-_'·" for three-letter terms, one to
    /// three of anything but letters, numbers and line breaks for longer ones.
    Ask,
    /// The agent path, where text is free to span lines: up to four of " \t\r\n.-_'·/|*~+" for
    /// three-letter terms ("S -- a -- m"), and up to eight of anything but letters and numbers,
    /// line breaks included, for longer ones ("R\ni\nl\ne\ny").
    Wide,
}
impl Gaps {
    fn allows(self, gap: &str, term_len: usize) -> bool {
        let len = gap.chars().count();
        match (self, term_len) {
            (Self::Ask, 3) => {
                (1..=2).contains(&len) && gap.chars().all(|c| " .-_'\u{b7}".contains(c))
            }
            (Self::Ask, _) => {
                (1..=3).contains(&len)
                    && gap.chars().all(|c| !letter_or_number(c) && !line_break(c))
            }
            (Self::Wide, 3) => {
                (1..=4).contains(&len) && gap.chars().all(|c| " \t\r\n.-_'\u{b7}/|*~+".contains(c))
            }
            (Self::Wide, _) => (1..=8).contains(&len) && gap.chars().all(|c| !letter_or_number(c)),
        }
    }
}

/// Ask's terms, arranged so a text is read once rather than once per term.
#[derive(Clone, Default)]
struct Terms {
    all: BTreeSet<String>,
    /// Terms that start with a word character, by that leading run of word characters: a whole-word
    /// match can only start where the text's own run of word characters is the same (or the same
    /// with a plural "s").
    by_lead: HashMap<String, Vec<String>>,
    /// Terms of unspaced scripts, found anywhere.
    unspaced: Vec<String>,
    /// Terms that start with anything else, checked occurrence by occurrence.
    rest: Vec<String>,
    /// Letters-and-numbers forms of spaced terms of three or more characters, for names spelled
    /// out one letter at a time.
    spelled: BTreeSet<String>,
}
impl Terms {
    fn insert(&mut self, term: String) {
        if !self.all.insert(term.clone()) {
            return;
        }
        let compact: String = term.chars().filter(|&c| letter_or_number(c)).collect();
        if !unspaced(&compact) && compact.chars().count() >= 3 {
            self.spelled.insert(compact);
        }
        if unspaced(&term) {
            self.unspaced.push(term);
            return;
        }
        let lead: String = term.chars().take_while(|&c| word_char(c)).collect();
        if lead.is_empty() {
            self.rest.push(term);
        } else {
            self.by_lead.entry(lead).or_default().push(term);
        }
    }
    /// Any term as a whole word (or anywhere, for unspaced scripts). `text` is in comparison form.
    fn whole_word(&self, text: &str) -> bool {
        self.whole_word_where(text, &|_| true)
    }
    /// `whole_word` over the terms `keep` accepts.
    fn whole_word_where(&self, text: &str, keep: &dyn Fn(&str) -> bool) -> bool {
        if self
            .unspaced
            .iter()
            .any(|term| keep(term) && text.contains(term.as_str()))
            || self
                .rest
                .iter()
                .any(|term| keep(term) && occurrences(text, term).any(|at| bounded(text, at, term)))
        {
            return true;
        }
        let mut previous: Option<char> = None;
        for (at, c) in text.char_indices() {
            let starts = word_char(c) && !previous.is_some_and(word_char);
            previous = Some(c);
            if !starts {
                continue;
            }
            let end = text[at..]
                .char_indices()
                .find(|&(_, c)| !word_char(c))
                .map_or(text.len(), |(i, _)| at + i);
            let lead = &text[at..end];
            let hit = std::iter::once(lead)
                .chain(lead.strip_suffix('s'))
                .filter_map(|key| self.by_lead.get(key))
                .flatten()
                .any(|term| {
                    keep(term) && text[at..].starts_with(term.as_str()) && bounded(text, at, term)
                });
            if hit {
                return true;
            }
        }
        false
    }
    /// Three or more one-character words in a row, separated by gaps `gaps` allows, whose letters
    /// hold a term. `folded` is already in comparison form.
    fn spelled_out(&self, folded: &str, gaps: Gaps) -> bool {
        let mut tokens: Vec<(usize, usize)> = Vec::new();
        let mut start = None;
        for (at, c) in folded.char_indices() {
            if letter_or_number(c) {
                start.get_or_insert(at);
            } else if let Some(begin) = start.take() {
                tokens.push((begin, at));
            }
        }
        if let Some(begin) = start {
            tokens.push((begin, folded.len()));
        }
        let single = |(a, b): (usize, usize)| folded[a..b].chars().count() == 1;
        if !tokens.windows(3).any(|w| w.iter().all(|&t| single(t))) {
            return false;
        }
        let runs = |term_len: usize| {
            let mut found: Vec<String> = Vec::new();
            let mut i = 0;
            while i < tokens.len() {
                let mut j = i;
                while j + 1 < tokens.len()
                    && single(tokens[j])
                    && single(tokens[j + 1])
                    && gaps.allows(&folded[tokens[j].1..tokens[j + 1].0], term_len)
                {
                    j += 1;
                }
                if j - i >= 2 {
                    found.push(tokens[i..=j].iter().map(|&(a, b)| &folded[a..b]).collect());
                }
                i = j + 1;
            }
            found
        };
        let (three, longer) = (runs(3), runs(4));
        self.spelled.iter().any(|compact| {
            let runs = if compact.chars().count() == 3 {
                &three
            } else {
                &longer
            };
            runs.iter()
                .any(|letters| letters.contains(compact.as_str()))
        })
    }
    fn found(&self, folded: &str, gaps: Gaps) -> bool {
        self.whole_word(folded) || self.spelled_out(folded, gaps)
    }
}

/// Rewording's rule (`present`) over one term set. `text` is in comparison form.
fn reword_hit(text: &str, terms: &BTreeSet<String>) -> bool {
    let compact: String = text.chars().filter(|&c| letter_or_number(c)).collect();
    terms.iter().any(|term| {
        let long = unspaced(term) || term.chars().count() >= 4;
        if long && compact.contains(term.as_str()) {
            return true;
        }
        if unspaced(term) || term.chars().count() >= 3 {
            return text.contains(term.as_str());
        }
        text.match_indices(term.as_str()).any(|(at, _)| {
            let before = text[..at].chars().next_back();
            let after = text[at + term.len()..].chars().next();
            !before.is_some_and(letter) && !after.is_some_and(letter)
        })
    })
}

/// Remembered name terms for this session. Deliberately not Debug, Serialize or persisted.
#[derive(Clone, Default)]
pub struct NameGuard {
    /// Rewording's terms (`present`).
    terms: BTreeSet<String>,
    /// The same with lookalike letters read as Latin.
    lookalike_terms: BTreeSet<String>,
    /// Ask's terms (`present_as_word`): the same plus joined runs of parts.
    word_terms: Terms,
    /// Ask's terms with lookalike letters read as Latin.
    lookalike_word_terms: Terms,
    /// Every run of two or more consecutive parts of a name, one space between (`present_as_phrase`).
    phrases: Terms,
    /// For each calendar word or "church" among a name's parts, every other part of that name
    /// (`present_in_prose`).
    neighbours: HashMap<String, HashSet<String>>,
}
/// The comparison form as words: each run of letters and numbers, one space between.
fn words(folded: &str) -> String {
    folded
        .split(|c: char| !letter_or_number(c))
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}
impl NameGuard {
    pub fn remember<'a>(&mut self, names: impl IntoIterator<Item = &'a String>) {
        let latin = |term: &String| lookalike_fold(term).unwrap_or_else(|| term.clone());
        for name in names {
            for term in terms(name) {
                self.lookalike_terms.insert(latin(&term));
                self.terms.insert(term);
            }
            for term in word_terms(name) {
                self.lookalike_word_terms.insert(latin(&term));
                self.word_terms.insert(term);
            }
            let parts = words(&fold(name));
            let parts: Vec<&str> = parts.split(' ').filter(|p| !p.is_empty()).collect();
            for start in 0..parts.len() {
                for end in start + 2..=parts.len() {
                    self.phrases.insert(parts[start..end].join(" "));
                }
            }
            for part in parts.iter().filter(|part| beside_only(part)) {
                let near = self.neighbours.entry((*part).to_owned()).or_default();
                near.extend(
                    parts
                        .iter()
                        .filter(|other| other != &part)
                        .map(|o| (*o).to_owned()),
                );
            }
        }
    }
    pub fn len(&self) -> usize {
        self.terms.len()
    }
    pub fn is_empty(&self) -> bool {
        self.terms.is_empty()
    }
    /// Deliberately broad: substring match for unspaced scripts and 3+ character parts;
    /// letter-only boundaries for 2-character parts. A letters-and-numbers-only copy of the
    /// text is also searched for 4+ character and unspaced-script parts, so "R.i.l.e.y" or
    /// "Ri ley" still match (as in core/src/draft-request.ts `containsName`). Lookalike letters
    /// are read as Latin too (native only).
    pub fn present(&self, text: &str) -> bool {
        reword_hit(&fold(text), &self.terms)
            || lookalike_fold(text).is_some_and(|latin| reword_hit(&latin, &self.lookalike_terms))
    }

    /// Ask Ozzie (model.rs `check_ask`); rewording keeps `present`. Mirrors `hits` in
    /// core/src/ask.ts (coordinator decisions 2026-11-13: substring matching refused ordinary
    /// words such as "same" for Sam). Whole words, where only a letter of a spaced script
    /// continues a word (`word_char`), with an optional plural or possessive "s" ("Riley's",
    /// "Rileys"); any occurrence for unspaced scripts; and names spelled out one letter at a time:
    /// with gaps of one or two of " .-_'·" for three-character terms ("S.a.m"), and of one to three
    /// of anything but letters, numbers and line breaks for longer ones ("R/i/l/e/y", "R, i, l, e,
    /// y"). A name split into two ordinary words ("Ri ley") or glued to other letters ("RileyTM",
    /// "Samwise") is deliberately not matched. Native only so far: the same again with lookalike
    /// letters read as Latin ("Rіley" with a Cyrillic і, "ʀɪʟᴇʏ").
    pub fn present_as_word(&self, text: &str) -> bool {
        self.find(text, Gaps::Ask)
    }

    /// The agent path (agent.rs), where text spans lines freely: `present_as_word`, with names
    /// spelled out across wider gaps too (`Gaps::Wide`: tabs, line breaks, slashes, runs of spaces,
    /// " -- "). Stricter than the webview's Ask rule, by design.
    pub fn present_as_word_strict(&self, text: &str) -> bool {
        self.find(text, Gaps::Wide)
    }

    /// The agent path's question and the model's own output (owner decision 2026-11-14,
    /// "capitalized only", refined by the coordinator the same day within it; core/src/harness/
    /// names.ts, core/src/ask.ts `proseHit` and core/test/ask-parity.json `capitalizedCommonWords`):
    /// `present_as_word_strict`, except for one-word terms that are calendar words or common words
    /// (core/src/harness/fixed/common-words.txt: will, grace, hope …). A weekday or month name,
    /// and "church" followed by "rules" (Ozzie's own term), counts only beside another part of the
    /// same member's name, in any case: "this Sunday" and "Your Church rules" name no one; "June
    /// Carter" and "Adeyemi, Sunday" do. Any other common word counts only where its first letter
    /// is written as a capital, a capital at the start of a sentence included, and never with a
    /// contraction directly after it: "Who will cover" and "Don't" name no one; "Will can't" names
    /// Will. Terms of two or more words, joined parts, spelled-out names, unspaced scripts and
    /// lookalike disguises stay strict. Ask itself, rewording, tool arguments and the ledger keep
    /// the strict rules.
    pub fn present_in_prose(&self, text: &str) -> bool {
        self.find_capitalized(text, Gaps::Wide, crate::fixed::common_words())
    }

    /// Sentences a tool result assembles from fixed words (fixed.rs `tool_message`): any run of two or
    /// more consecutive parts of one name, in any case and across any separators ("way, long" for a
    /// member Way Long), since fixed words can spell such a run. A single word is not checked here:
    /// every word of such a sentence is fixed vocabulary, and reading one as a name would bring back
    /// the collisions pinning removed (a member surnamed Center against "Planning Center", Long
    /// against "took too long").
    pub fn present_as_phrase(&self, text: &str) -> bool {
        self.phrases.whole_word(&words(&fold(text)))
    }

    fn find_capitalized(&self, text: &str, gaps: Gaps, common: &HashSet<String>) -> bool {
        let folded = fold(text);
        self.word_terms.whole_word_where(&folded, &|term| {
            !common.contains(term) && !beside_only(term)
        }) || self.prose_word(text, common)
            || self.word_terms.spelled_out(&folded, gaps)
            || lookalike_fold(text)
                .is_some_and(|latin| self.lookalike_word_terms.found(&latin, gaps))
    }

    /// The one-word terms `find_capitalized` leaves to the prose rule, word by word.
    fn prose_word(&self, text: &str, common: &HashSet<String>) -> bool {
        let (words, gaps) = prose_words(text);
        let beside = |at: usize, gap: usize| {
            words
                .get(at)
                .filter(|_| neighbour_gap(&gaps[gap]))
                .map(|w| w.folded.as_str())
        };
        words.iter().enumerate().any(|(at, word)| {
            let before = at.checked_sub(1).and_then(|b| beside(b, at));
            let after = beside(at + 1, at + 1);
            let plain = std::iter::once((word.folded.as_str(), false));
            let plural = word.folded.strip_suffix('s').map(|stem| (stem, true));
            plain.chain(plural).any(|(term, plural)| {
                if !self.word_terms.all.contains(term)
                    || !(common.contains(term) || beside_only(term))
                {
                    return false;
                }
                if CALENDAR_WORDS.contains(&term) || (term == "church" && after == Some("rules")) {
                    return self.neighbours.get(term).is_some_and(|near| {
                        before.is_some_and(|b| near.contains(b))
                            || after.is_some_and(|a| near.contains(a))
                    });
                }
                !common.contains(term)
                    || (word.capital && (plural || !contracted(&words, &gaps, at, term)))
            })
        })
    }

    fn find(&self, text: &str, gaps: Gaps) -> bool {
        self.word_terms.found(&fold(text), gaps)
            || lookalike_fold(text)
                .is_some_and(|latin| self.lookalike_word_terms.found(&latin, gaps))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Produced by core/src/draft-request.ts `fold` and `nameTerms` (Node 22, ICU 77).
    const PARITY: &[(&str, &str, &[&str])] = &[
        (
            "Jos\u{e9} \u{d1}\u{fa}\u{f1}ez",
            "jose nunez",
            &["jose", "jose nunez", "nunez"],
        ),
        ("\u{ff2a}\u{ff2f}\u{ff33}\u{c9}", "jose", &["jose"]),
        ("Zo\u{eb}\u{200b}Ann", "zoeann", &["zoeann"]),
        (
            "O\u{2019}Neil-Smith",
            "o'neil-smith",
            &["neil", "o'neil-smith", "oneilsmith", "smith"],
        ),
        (
            "Mary\u{2013}Kate",
            "mary-kate",
            &["kate", "mary", "mary-kate", "marykate"],
        ),
        (
            "\u{ff21}\u{ff56}\u{ff45}\u{ff52}\u{ff59} \u{fb01}nch",
            "avery finch",
            &["avery", "avery finch", "finch"],
        ),
        ("\u{e000}Pri\u{e0041}vate", "private", &["private"]),
        ("\u{c4}\u{308}str\u{f6}m", "astrom", &["astrom"]),
        ("\u{ff2a}o\u{fe0f}e", "joe", &["joe"]),
        (
            "\u{674e} \u{5c0f}\u{9f8d}",
            "\u{674e} \u{5c0f}\u{9f8d}",
            &["\u{5c0f}\u{9f8d}", "\u{674e}", "\u{674e} \u{5c0f}\u{9f8d}"],
        ),
        (
            "\u{ae40}\u{bbfc}\u{c900}",
            "\u{1100}\u{1175}\u{11b7}\u{1106}\u{1175}\u{11ab}\u{110c}\u{116e}\u{11ab}",
            &["\u{1100}\u{1175}\u{11b7}\u{1106}\u{1175}\u{11ab}\u{110c}\u{116e}\u{11ab}"],
        ),
        ("\u{130}stanbul", "istanbul", &["istanbul"]),
        // Final sigma is unified with sigma (coordinator decision 2026-11-13).
        (
            "\u{3a3}\u{39f}\u{3a6}\u{39f}\u{3a3}",
            "\u{3c3}\u{3bf}\u{3c6}\u{3bf}\u{3c3}",
            &["\u{3c3}\u{3bf}\u{3c6}\u{3bf}\u{3c3}"],
        ),
        (
            "Jean-Luc D\u{b4}Arcy",
            "jean-luc d arcy",
            &["arcy", "jean", "jean-luc d arcy", "jeanluc", "luc"],
        ),
        ("Al Li", "al li", &["al", "al li", "li"]),
    ];

    #[test]
    fn fold_and_terms_match_the_webview_boundary() {
        for (input, folded, expected) in PARITY {
            assert_eq!(fold(input), *folded, "{input:?}");
            let got: BTreeSet<String> = terms(input).into_iter().collect();
            let expected: BTreeSet<String> = expected.iter().map(|t| t.to_string()).collect();
            assert_eq!(got, expected, "{input:?}");
        }
    }

    /// core/test/ask-parity.json, which core/test/ask-parity.test.ts runs against the webview.
    #[derive(serde::Deserialize)]
    struct Parity {
        fold: Vec<(String, String)>,
        terms: Vec<ParityTerms>,
        roster: Vec<String>,
        names: Split,
    }
    #[derive(serde::Deserialize)]
    struct ParityTerms {
        name: String,
        reword: Vec<String>,
        ask: Vec<String>,
    }
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Split {
        found: Vec<String>,
        not_found: Vec<String>,
    }
    fn parity() -> Parity {
        let mut value: serde_json::Value =
            serde_json::from_str(include_str!("../../test/ask-parity.json")).unwrap();
        for key in ["about", "contact", "questionLines"] {
            value.as_object_mut().unwrap().remove(key);
        }
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn the_shared_parity_vectors_fold_and_make_terms_as_the_webview_does() {
        let parity = parity();
        for (input, folded) in &parity.fold {
            assert_eq!(fold(input), *folded, "{input:?}");
        }
        for case in &parity.terms {
            let reword: BTreeSet<String> = terms(&case.name).into_iter().collect();
            let ask: BTreeSet<String> = word_terms(&case.name).into_iter().collect();
            assert_eq!(
                reword,
                case.reword.iter().cloned().collect(),
                "{:?}",
                case.name
            );
            assert_eq!(ask, case.ask.iter().cloned().collect(), "{:?}", case.name);
        }
    }

    #[test]
    fn the_shared_parity_vectors_find_names_as_the_webview_does() {
        let parity = parity();
        let mut guard = NameGuard::default();
        guard.remember(&parity.roster);
        for text in &parity.names.found {
            assert!(guard.present_as_word(text), "{text:?}");
        }
        for text in &parity.names.not_found {
            assert!(!guard.present_as_word(text), "{text:?}");
        }
        assert!(parity.names.found.len() >= 40 && parity.names.not_found.len() >= 10);
    }

    #[test]
    fn names_spelled_with_separators_are_found_in_a_letters_and_numbers_copy() {
        let mut guard = NameGuard::default();
        guard.remember(&[
            "Riley Fictional".to_string(),
            "Sam Li".to_string(),
            "小龍".to_string(),
        ]);
        for text in [
            "R.i.l.e.y",
            "R i l e y",
            "Ri-ley",
            "r_i_l_e_y",
            "R\u{200b}i l\u{2019}e-y",
            "F-i-c-t-i-o-n-a-l",
            "小 龍",
        ] {
            assert!(guard.present(text), "{text:?}");
        }
        // Short parts keep their stricter rules; the compact copy is only for 4+ characters.
        for text in ["S a m", "s.a.m", "a l i", "mail it"] {
            assert!(!guard.present(text), "{text:?}");
        }
    }

    #[test]
    fn remembered_names_are_found_through_case_accents_and_disguises() {
        let mut guard = NameGuard::default();
        guard.remember(&[
            "Avery Fictional".to_string(),
            "José Ñúñez".to_string(),
            "Al Li".to_string(),
            "小龍".to_string(),
        ]);
        for text in [
            "Hi AVERY, can you help?",
            "Thanks, avéry",
            "Ａｖｅｒｙ",
            "A\u{200b}very",
            "jose",
            "JOSÉ ÑÚÑEZ",
            "nunez family",
            "fictionally speaking",
            "ask Al first",
            "AL.",
            "li",
            "小龍さん",
        ] {
            assert!(guard.present(text), "{text:?}");
        }
        for text in [
            "Hi [Volunteer A], could you help this Sunday?",
            "always",
            "alive",
            "lily",
            "",
        ] {
            assert!(!guard.present(text), "{text:?}");
        }
        assert!(NameGuard::default().is_empty());
        assert!(!NameGuard::default().present("anything at all"));
    }

    #[test]
    fn rewording_keeps_its_substring_rule_with_stroked_letters_folded() {
        // Rewording's rule is unchanged; only fold spells stroked letters plainly, so more is caught.
        let mut guard = NameGuard::default();
        guard.remember(&[
            "Søren Bjørnstad".to_string(),
            "Mary Kate Strauß".to_string(),
        ]);
        for text in ["Hi Soren", "BJORNSTAD", "sorensen", "Strauss", "S.o.r.e.n"] {
            assert!(guard.present(text), "{text:?}");
        }
        // Joined runs are Ask's terms only, so rewording's term set is exactly as before.
        assert_eq!(guard.len(), 7);
        assert!(!guard.present("Mark Kat"));
    }

    #[test]
    fn ask_matches_whole_words_while_rewording_stays_strict() {
        // The same vectors as core/test/ask.test.ts ("matches names as whole words ...").
        let mut guard = NameGuard::default();
        guard.remember(&["Tim Fictional".to_string(), "Will Grace".to_string()]);
        assert!(!guard.present_as_word("What time is it? Is anyone willing? Gracefully."));
        for text in [
            "Is Tim free?",
            "tim's",
            "TIMS",
            "Will can't",
            "Ask GRACE",
            "T.i.m is out",
            "Graces",
            "Ask T\u{200b}im",
            "\u{ff34}\u{ff49}\u{ff4d}?",
            // Digits and unspaced scripts are boundaries (coordinator decision 2026-11-13).
            "Tim2",
            "Tim\u{3055}\u{3093}",
        ] {
            assert!(guard.present_as_word(text), "{text:?}");
        }
        // Rewording keeps substring matching: "time" still refuses there.
        assert!(guard.present("What time is it?"));
        let mut sam = NameGuard::default();
        sam.remember(&["Sam Whitcombe".to_string(), "\u{738b}\u{4f1f}".to_string()]);
        assert!(!sam.present_as_word("Who could cover at the same time as the 9:30 service?"));
        assert!(sam.present("Who could cover at the same time as the 9:30 service?"));
        for text in [
            "Can Sam help?",
            "sam's",
            "SAM",
            "S.a.m",
            "S a m",
            "Whitcombes",
            "\u{738b}\u{4f1f}\u{80fd}\u{6765}\u{5417}",
        ] {
            assert!(sam.present_as_word(text), "{text:?}");
        }
        // Documented narrowing: split into two ordinary words, or glued inside another word.
        for text in ["Sa m", "Samwise", "awesome", "a b c d", "S, a, m"] {
            assert!(!sam.present_as_word(text), "{text:?}");
        }
        assert!(!NameGuard::default().present_as_word("anything"));
    }

    #[test]
    fn overlapping_occurrences_are_all_checked() {
        let mut guard = NameGuard::default();
        guard.remember(&["A-A".to_string()]);
        // The first "a-a" is glued to "x"; the overlapping second one stands alone.
        assert!(guard.present_as_word("xa-a-a"));
    }

    /// The rule `Terms::whole_word` implements, term by term over every occurrence, as the guard
    /// read it before the index.
    fn whole_word_by_scan(text: &str, terms: &BTreeSet<String>) -> bool {
        terms.iter().any(|term| {
            if unspaced(term) {
                return text.contains(term.as_str());
            }
            occurrences(text, term).any(|at| bounded(text, at, term))
        })
    }

    #[test]
    fn the_indexed_search_finds_exactly_what_a_scan_of_every_term_finds() {
        let parity = parity();
        let mut roster = parity.roster.clone();
        roster.extend(
            [
                "A-A",
                "O\u{2019}Neil-Smith",
                "Jean-Luc D\u{b4}Arcy",
                "Al Li",
                "2Pac Fictional",
                "\u{674e} \u{5c0f}\u{9f8d}",
            ]
            .map(str::to_owned),
        );
        let mut guard = NameGuard::default();
        guard.remember(&roster);
        let mut texts: Vec<String> = parity.names.found.clone();
        texts.extend(parity.names.not_found.clone());
        texts.extend(
            [
                "xa-a-a",
                "a-a",
                "Rileys and Riley's",
                "o'neil-smith's",
                "jean-luc d'arcy",
                "ask al first",
                "alli",
                "2pac",
                "x2pac",
                "\u{674e}\u{5c0f}\u{9f8d}\u{3055}\u{3093}",
                "",
                "s",
                "rileyss",
            ]
            .map(str::to_owned),
        );
        for text in &texts {
            let folded = fold(text);
            assert_eq!(
                guard.word_terms.whole_word(&folded),
                whole_word_by_scan(&folded, &guard.word_terms.all),
                "{text:?}"
            );
        }
    }

    /// core/test/ask-parity.json `capitalizedCommonWords`, which core/test/harness/names.test.ts
    /// runs against the webview's rule.
    #[test]
    fn capitalized_common_words_match_the_webview_rule() {
        let all: serde_json::Value =
            serde_json::from_str(include_str!("../../test/ask-parity.json")).unwrap();
        let list = |path: &str| -> Vec<String> {
            serde_json::from_value(all.pointer(path).unwrap().clone()).unwrap()
        };
        let mut guard = NameGuard::default();
        guard.remember(&list("/capitalizedCommonWords/roster"));
        let found = list("/capitalizedCommonWords/found");
        let not_found = list("/capitalizedCommonWords/notFound");
        assert!(found.len() >= 20 && not_found.len() >= 10);
        for text in &found {
            assert!(guard.present_in_prose(text), "{text:?}");
        }
        for text in &not_found {
            assert!(!guard.present_in_prose(text), "{text:?}");
            // The strict rules still find them.
            assert!(guard.present_as_word(text), "{text:?}");
        }
        // Disguises stay strict: lookalike letters, spelled out, invisible characters folded away.
        for text in [
            "who w\u{456}ll cover",
            "w-i-l-l is free",
            "Who Wi\u{200b}ll cover",
            "\u{ff37}ill",
        ] {
            assert!(guard.present_in_prose(text), "{text:?}");
        }
        assert!(!guard.present_in_prose("who wi\u{200b}ll cover"));
        assert!(crate::fixed::common_words().contains("will"));
    }

    #[test]
    fn phrases_are_runs_of_two_or_more_parts_of_one_name_in_any_case_or_spacing() {
        let mut guard = NameGuard::default();
        guard.remember(&[
            "Way Long".to_string(),
            "Grace Center".to_string(),
            "Mary Kate Strau\u{df}".to_string(),
            "Hope".to_string(),
        ]);
        for text in [
            "way long",
            "Way, Long",
            "WAY\nLONG",
            "way - long",
            "mary kate",
            "Kate Strauss",
            "MARY KATE STRAUSS",
            "the way longs",
        ] {
            assert!(guard.present_as_phrase(text), "{text:?}");
        }
        for text in [
            "took too long",
            "Planning Center",
            "a long way",
            "way 0 long",
            "hope",
            "Mary Strauss",
            "waylong",
        ] {
            assert!(!guard.present_as_phrase(text), "{text:?}");
        }
    }

    /// core/test/ask-parity.json `pendingNative`: native-only so far.
    #[test]
    fn lookalike_letters_and_invisible_characters_do_not_hide_a_name() {
        let all: serde_json::Value =
            serde_json::from_str(include_str!("../../test/ask-parity.json")).unwrap();
        let list = |path: &str| -> Vec<String> {
            serde_json::from_value(all.pointer(path).unwrap().clone()).unwrap()
        };
        let mut guard = NameGuard::default();
        guard.remember(&list("/roster"));
        for text in list("/pendingNative/names/found") {
            assert!(guard.present_as_word(&text), "{text:?}");
            assert!(guard.present_as_word_strict(&text), "{text:?}");
        }
        for text in list("/pendingNative/names/notFound") {
            assert!(!guard.present_as_word(&text), "{text:?}");
            assert!(!guard.present_as_word_strict(&text), "{text:?}");
        }
        // Rewording's broader rule reads them too.
        assert!(guard.present("Hi R\u{456}ley"));
        assert!(guard.present("Hi Ri\u{3164}ley"));
        // A name written in Greek or Cyrillic is still found as itself.
        assert!(guard.present_as_word("\u{39d}\u{3b9}\u{3ba}\u{3bf}\u{3c2}?"));
        // The Hangul fillers fold away; ordinary Hangul doesn't.
        assert_eq!(fold("a\u{3164}b\u{115f}c\u{ffa0}d\u{2800}e"), "abcde");
        assert_eq!(fold("\u{ae40}"), "\u{1100}\u{1175}\u{11b7}");
    }

    #[test]
    fn the_agent_rule_also_reads_names_spelled_out_across_wider_gaps() {
        let mut guard = NameGuard::default();
        guard.remember(&["Riley Thornbury".to_string(), "Sam Whitcombe".to_string()]);
        for text in [
            "R\ni\nl\ne\ny",
            "R\ti\tl\te\ty",
            "R....i....l....e....y",
            "R  /  i  /  l  /  e  /  y",
            "R -- i -- l -- e -- y",
            "S -- a -- m",
            "S\ta\tm",
            "S\na\nm",
            "S / a / m",
        ] {
            assert!(guard.present_as_word_strict(text), "{text:?}");
        }
        // Ask's own rule is unchanged (these are in the webview's notFound vectors or beside them).
        for text in ["R\ni\nl\ne\ny", "R....i....l....e....y", "S -- a -- m"] {
            assert!(!guard.present_as_word(text), "{text:?}");
        }
        // Still whole letters only: ordinary words, a list of letters, gaps past eight.
        for text in [
            "Is Ri ley free?",
            "Samwise",
            "a b c d",
            "S, a, m",
            "R.........i.........l.........e.........y",
            "Plan A, B or C",
        ] {
            assert!(!guard.present_as_word_strict(text), "{text:?}");
        }
    }
}
