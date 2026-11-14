//! Native defense in depth for the never-list: real people's names never go to a model.
//!
//! The webview's placeholder boundary is the primary guard. This one runs in native code
//! before any model request, against the names of every capture this session has shown, so a
//! compromised or buggy webview still cannot send a remembered name. It mirrors
//! `fold`/`nameTerms`/`containsName` in core/src/draft-request.ts and `askNameTerms`/`hits` in
//! core/src/ask.ts; core/test/ask-parity.json holds vectors both sides run. Names live only in
//! memory: never persisted, logged or returned.
use icu_normalizer::{ComposingNormalizerBorrowed, DecomposingNormalizerBorrowed};
use icu_properties::{
    CodePointMapData,
    props::{GeneralCategory, GeneralCategoryGroup, Script},
};
use std::collections::BTreeSet;

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

/// Comparison form: compatibility-normalized; format, private-use, variation-selector and tag
/// characters removed; accents removed; apostrophes and dashes unified; lowercased; then stroked
/// letters and ligatures spelled plainly (ø → o, ß → ss) and final sigma unified.
pub fn fold(text: &str) -> String {
    let compat = ComposingNormalizerBorrowed::new_nfkc().normalize(text);
    let visible: String = compat
        .chars()
        .filter(|&c| {
            !matches!(c, '\u{34F}' | '\u{FE00}'..='\u{FE0F}' | '\u{E0000}'..='\u{E007F}')
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

/// Remembered name terms for this session. Deliberately not Debug, Serialize or persisted.
#[derive(Clone, Default)]
pub struct NameGuard {
    /// Rewording's terms (`present`).
    terms: BTreeSet<String>,
    /// Ask's terms (`present_as_word`): the same plus joined runs of parts.
    word_terms: BTreeSet<String>,
}
impl NameGuard {
    pub fn remember<'a>(&mut self, names: impl IntoIterator<Item = &'a String>) {
        for name in names {
            self.terms.extend(terms(name));
            self.word_terms.extend(word_terms(name));
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
    /// "Ri ley" still match (as in core/src/draft-request.ts `containsName`).
    pub fn present(&self, text: &str) -> bool {
        let text = fold(text);
        let compact: String = text.chars().filter(|&c| letter_or_number(c)).collect();
        self.terms.iter().any(|term| {
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

    /// Ask Ozzie only (model.rs `check_ask`); rewording keeps `present`. Mirrors `hits` in
    /// core/src/ask.ts (coordinator decisions 2026-11-13: substring matching refused ordinary
    /// words such as "same" for Sam). Whole words, where only a letter of a spaced script
    /// continues a word (`word_char`), with an optional plural or possessive "s" ("Riley's",
    /// "Rileys"); any occurrence for unspaced scripts; and names spelled out one letter at a time.
    /// A name split into two ordinary words ("Ri ley") or glued to other letters ("RileyTM",
    /// "Samwise") is deliberately not matched.
    pub fn present_as_word(&self, text: &str) -> bool {
        let text = fold(text);
        let word = |c: Option<char>| c.is_some_and(word_char);
        let whole = self.word_terms.iter().any(|term| {
            if unspaced(term) {
                return text.contains(term.as_str());
            }
            occurrences(&text, term).any(|at| {
                let before = text[..at].chars().next_back();
                let mut after = text[at + term.len()..].chars();
                let next = after.next();
                !word(before) && (!word(next) || (next == Some('s') && !word(after.next())))
            })
        });
        whole || self.spelled_out(&text)
    }

    /// Three or more one-character words in a row whose letters hold a term: with gaps of one or
    /// two of " .-_'·" for three-character terms ("S.a.m"), and of one to three of anything but
    /// letters, numbers and line breaks for longer ones ("R/i/l/e/y", "R, i, l, e, y").
    /// `folded` is already in comparison form.
    fn spelled_out(&self, folded: &str) -> bool {
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
        let narrow = |gap: &str| {
            (1..=2).contains(&gap.chars().count()) && gap.chars().all(|c| " .-_'\u{b7}".contains(c))
        };
        let wide = |gap: &str| {
            (1..=3).contains(&gap.chars().count())
                && gap.chars().all(|c| !letter_or_number(c) && !line_break(c))
        };
        let runs = |gap: &dyn Fn(&str) -> bool| {
            let mut found: Vec<String> = Vec::new();
            let mut i = 0;
            while i < tokens.len() {
                let mut j = i;
                while j + 1 < tokens.len()
                    && single(tokens[j])
                    && single(tokens[j + 1])
                    && gap(&folded[tokens[j].1..tokens[j + 1].0])
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
        let (narrow, wide) = (runs(&narrow), runs(&wide));
        self.word_terms.iter().any(|term| {
            let compact: String = term.chars().filter(|&c| letter_or_number(c)).collect();
            let length = compact.chars().count();
            if unspaced(&compact) || length < 3 {
                return false;
            }
            let runs = if length == 3 { &narrow } else { &wide };
            runs.iter().any(|letters| letters.contains(&compact))
        })
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
}
