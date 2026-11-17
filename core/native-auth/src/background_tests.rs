//! The native background-check wording check against the shared vectors, the oracle corpus and the
//! per-character differential the page and ozzie.church run too, and against every fixed text Ozzie
//! sends a model. Fictional names only.
use super::*;
use crate::fixed;
use crate::model::{NOTE_PREFIX, REWORDINGS, SYSTEM};
use serde_json::Value;
use sha2::Digest;

#[derive(Deserialize)]
struct Vectors {
    #[serde(rename = "match")]
    holds: Vec<String>,
    refused_on_purpose: Vec<String>,
    pass: Vec<String>,
    known_misses: Vec<String>,
    hidden: Vec<String>,
    tool_match: Vec<String>,
    tool_pass: Vec<String>,
    tokens: Vec<(String, String, Vec<String>)>,
}
fn vectors() -> Vectors {
    serde_json::from_str(include_str!(
        "../../test/harness/background-wording-vectors.json"
    ))
    .unwrap()
}
fn folding(name: &str) -> Folding {
    match name {
        "join" => Folding::Join,
        "split" => Folding::Split,
        "v010" => Folding::V010,
        _ => panic!("{name}"),
    }
}
fn hex_digest(text: &str) -> String {
    sha2::Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
/// The two out-of-date sentences in Ozzie's pinned texts (the refresh tool's spec, the sunday-ready
/// procedure): pinned texts are compared byte for byte, never scanned, so these are set aside here, in
/// the test, and nowhere at run time.
const PINNED_OUT_OF_DATE: [&str; 2] = [
    "Use it at most once, and only when the last check is out of date.",
    "If the last check is out of date and Planning Center can be checked again, check again first.",
];
fn pinned_text(text: &str) -> String {
    PINNED_OUT_OF_DATE
        .iter()
        .fold(text.to_owned(), |rest, s| rest.replace(s, " "))
}

#[test]
fn the_list_is_the_one_file_the_page_reads_and_it_parses() {
    let list = compiled().expect("background-wording.json parses");
    assert!(list.phrases.len() > 20);
    assert_eq!(list.own.len(), 1);
    assert_eq!((list.removed.len(), list.letters.len()), (37, 7));
    let file: Value = serde_json::from_str(WORDING_FILE).unwrap();
    assert_eq!(
        file["phrases"].as_array().unwrap().len(),
        list.phrases.len()
    );
    let page = include_str!("../../src/harness/background-wording.ts");
    assert!(page.contains(r#"import wordingText from "./fixed/background-wording.json?raw";"#));
    let ask = include_str!("../../src/ask.ts");
    for line in [
        "export const mentionsBackgroundCheck = (typed: string) => backgroundWording(typed);",
        "if (mentionsBackgroundCheck(plain) || mentionsBackgroundCheck(typed)) return refuse(",
    ] {
        assert!(ask.contains(line), "{line}");
    }
}

#[test]
fn it_splits_text_into_the_same_words_as_the_page_under_each_folding() {
    for (text, name, expected) in vectors().tokens {
        assert_eq!(tokens(&text, folding(&name)), expected, "{text:?} {name}");
    }
}

#[test]
fn it_finds_the_wording_through_possessives_invisible_characters_and_newer_unicode() {
    let v = vectors();
    for text in v.holds.iter().chain(&v.refused_on_purpose) {
        assert!(background_wording(text), "{text:?}");
    }
}

#[test]
fn it_leaves_ordinary_sunday_words_alone_and_its_limits_stay_written_down() {
    let v = vectors();
    for text in v.pass.iter().chain(&v.known_misses) {
        assert!(!background_wording(text), "{text:?}");
    }
}

#[test]
fn a_question_whose_hidden_characters_spell_the_wording_past_every_folding_is_refused_whole() {
    // Each needs deleting at one point and a word break at another, which no folding does; the
    // question rule refuses it whole, as the page and ozzie.church do (review B3 L-1).
    let v = vectors();
    assert!(v.hidden.len() > 180);
    for text in &v.hidden {
        assert!(!background_wording(text), "{text:?}");
        assert!(crate::agent::hidden_in_question(text), "{text:?}");
    }
    // Every newer character, letters included, is one no question or note may hold.
    let list = compiled().unwrap();
    for &at in list.removed.iter().chain(list.letters.keys()) {
        let c = char::from_u32(at).unwrap();
        assert!(newer(c), "{at:X}");
        assert!(
            crate::agent::hidden_in_question(&format!("Who is on the Gre{c}eter team?")),
            "{at:X}"
        );
        assert!(
            crate::model::hidden_in_note(&format!(
                "Hi [Volunteer A], could you help as Gre{c}eter?"
            )),
            "{at:X}"
        );
    }
    for text in [
        "Who can cover Greeter?",
        "Caf\u{e9} crew",
        "Zo\u{eb} and \u{141}ukasz",
        "\u{65e5}\u{66dc}\u{65e5}\u{306e}\u{30c1}\u{30fc}\u{30e0}",
        "Coffee \u{2615} Team",
    ] {
        assert!(!crate::agent::hidden_in_question(text), "{text}");
        assert!(!text.chars().any(newer), "{text}");
    }
}

#[test]
fn tool_results_are_read_one_string_at_a_time() {
    let v = vectors();
    for text in &v.tool_match {
        assert!(in_tool_result(text), "{text}");
    }
    for text in &v.tool_pass {
        assert!(!in_tool_result(text), "{text}");
    }
    // Whole, the first would read "records check time".
    assert!(background_wording(&v.tool_pass[0]));
    // A lone surrogate escape is read as JavaScript reads it, not as text that isn't JSON (review B2 N-3).
    assert_eq!(
        json_strings(r#"{"a":"background\ncheck","b":"\ud800x"}"#).unwrap(),
        ["a", "background\ncheck", "b", "\u{fffd}x"]
    );
}

/// core/test/harness/background-wording-oracle.json and the corpus built from it (its `about`).
#[derive(Deserialize)]
struct Oracle {
    prefixes: Vec<String>,
    words: Vec<String>,
    suffixes: Vec<String>,
    subjects: Vec<String>,
    verbs: Vec<String>,
    tails: Vec<String>,
    separators: Vec<String>,
    sentences: Vec<String>,
    affixes: Vec<String>,
    rows: Vec<String>,
    allowlist: Vec<String>,
    digest: String,
}
fn oracle_corpus(o: &Oracle) -> Vec<String> {
    let mut generated = Vec::new();
    for p in &o.prefixes {
        for w in &o.words {
            for s in &o.suffixes {
                generated.push(format!("{p}{w}{s}"));
            }
        }
    }
    for p in &o.prefixes {
        for subject in &o.subjects {
            for verb in &o.verbs {
                for tail in &o.tails {
                    let verb = if verb.is_empty() {
                        String::new()
                    } else {
                        format!("{verb} ")
                    };
                    generated.push(format!("{p}{subject} {verb}{tail}"));
                }
            }
        }
    }
    let upper: Vec<String> = generated.iter().map(|t| t.to_uppercase()).collect();
    let mut separated = Vec::new();
    for j in &o.separators {
        for w in &o.words {
            separated.push(format!("{}{j}renewal", w.replace(' ', j)));
            separated.push(format!("{}{j}{}", &w[..1], &w[1..]));
        }
    }
    let mut embedded = Vec::new();
    for s in &o.sentences {
        for a in &o.affixes {
            embedded.push(format!("{a}{s}"));
            embedded.push(format!("{s}{a}"));
            embedded.push(format!("{a}{s}{a}"));
        }
    }
    generated
        .into_iter()
        .chain(upper)
        .chain(separated)
        .chain(embedded)
        .chain(o.rows.iter().cloned())
        .collect()
}

#[test]
fn it_reaches_the_pages_verdict_on_every_text_of_the_oracle_corpus() {
    // The page shows that its verdicts refuse everything its earlier regex refused, apart from the
    // allowlist; the same digest here means this side gives the same verdict on every text.
    let oracle: Oracle = serde_json::from_str(include_str!(
        "../../test/harness/background-wording-oracle.json"
    ))
    .unwrap();
    let corpus = oracle_corpus(&oracle);
    assert!(corpus.len() > 35_000);
    let lines: String = corpus
        .iter()
        .map(|t| format!("{} {t}\n", u8::from(background_wording(t))))
        .collect();
    assert_eq!(hex_digest(&lines), oracle.digest);
    assert_eq!(oracle.allowlist, compiled().unwrap().own);
}

#[derive(Deserialize)]
struct Differential {
    ranges: Vec<(u32, u32, u32)>,
    digest: String,
}

#[test]
fn it_splits_every_character_into_words_as_the_page_does_under_each_folding() {
    // Review B2 L-2: the same words for every scalar value in the ranges, under each folding, as the
    // page and ozzie.church, shown by one digest. Characters newer than the page's Unicode data are
    // mapped from the list first, so neither side's data decides them.
    let differential: Differential = serde_json::from_str(include_str!(
        "../../test/harness/background-wording-differential.json"
    ))
    .unwrap();
    let mut hash = sha2::Sha256::new();
    let mut count = 0;
    for (start, end, step) in differential.ranges {
        let mut at = start;
        while at <= end {
            if let Some(c) = char::from_u32(at) {
                let text = format!("a{c}b");
                let words: Vec<String> = FOLDINGS
                    .iter()
                    .map(|&f| tokens(&text, f).join(" "))
                    .collect();
                hash.update(format!("{at:X}:{}\n", words.join("/")).as_bytes());
                count += 1;
            }
            at += step;
        }
    }
    assert!(count > 200_000);
    let digest: String = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(digest, differential.digest);
}

#[test]
fn ozzies_own_sentence_is_set_aside_only_as_a_whole_string() {
    let operations = include_str!("../../src/operations-capture.ts");
    for sentence in &compiled().unwrap().own {
        assert!(
            operations.contains(&format!("\"{sentence}\"")),
            "{sentence}"
        );
        assert!(!background_wording(sentence), "{sentence}");
        for text in [
            sentence.to_lowercase(),
            format!(" {sentence}"),
            format!("{sentence} "),
            format!("police {sentence}"),
            format!("{sentence} Her check expired."),
        ] {
            assert!(background_wording(&text), "{text:?}");
        }
    }
    let skills: Vec<String> = fixed::skills()
        .iter()
        .map(|skill| fixed::system_text(skill).unwrap())
        .collect();
    for sentence in PINNED_OUT_OF_DATE {
        assert!(
            fixed::TOOL_SPECS_FILE.contains(sentence)
                || skills.iter().any(|s| s.contains(sentence)),
            "{sentence}"
        );
        assert!(background_wording(sentence), "{sentence}");
    }
}

#[test]
fn no_fixed_text_ozzie_sends_a_model_holds_the_wording() {
    assert!(!background_wording(fixed::policy()));
    assert!(fixed::skills().len() > 5);
    for skill in fixed::skills() {
        let system = fixed::system_text(skill).unwrap();
        assert!(!background_wording(&pinned_text(&system)), "{}", skill.id);
    }
    for spec in fixed::tool_specs() {
        let text = serde_json::to_string(spec).unwrap();
        assert!(!background_wording(&pinned_text(&text)), "{}", spec.name);
    }
    assert!(!background_wording(fixed::procedure_prompt()));
    let vocabulary: Value = serde_json::from_str(fixed::VOCABULARY_FILE).unwrap();
    for key in ["values", "sentence_words"] {
        for value in vocabulary[key].as_array().unwrap() {
            let value = value.as_str().unwrap();
            assert!(!background_wording(value), "{key}: {value}");
        }
    }
    for envelope in fixed::SAMPLE_ENVELOPES {
        assert!(!in_tool_result(envelope), "{envelope}");
    }
    assert!(!background_wording(SYSTEM));
    for choice in REWORDINGS {
        assert!(!background_wording(&format!("{choice}{NOTE_PREFIX}")));
    }
}

#[test]
fn a_list_that_does_not_parse_refuses_everything() {
    let newer = r#""newer_unicode":{"removed":[],"letters":{}}"#;
    for bad in [
        "".to_owned(),
        "{}".to_owned(),
        r#"{"phrases":["dbs"],"ozzies_own":[]}"#.to_owned(),
        format!(r#"{{"phrases":[],"ozzies_own":[],{newer}}}"#),
        format!(r#"{{"phrases":[""],"ozzies_own":[],{newer}}}"#),
        format!(r#"{{"phrases":["back  ground"],"ozzies_own":[],{newer}}}"#),
        format!(r#"{{"phrases":["*"],"ozzies_own":[],{newer}}}"#),
        format!(r#"{{"phrases":["Background"],"ozzies_own":[],{newer}}}"#),
        format!(r#"{{"phrases":["!this check"],"ozzies_own":[],{newer}}}"#),
        format!(r#"{{"phrases":["dbs's"],"ozzies_own":[],{newer}}}"#),
        format!(r#"{{"phrases":["check**"],"ozzies_own":[],{newer}}}"#),
        format!(r#"{{"phrases":["dbs"],"ozzies_own":[""],{newer}}}"#),
        r#"{"phrases":["dbs"],"ozzies_own":[],"newer_unicode":{"removed":["5c8"],"letters":{}}}"#
            .to_owned(),
        r#"{"phrases":["dbs"],"ozzies_own":[],"newer_unicode":{"removed":[],"letters":{"209D":"W"}}}"#
            .to_owned(),
    ] {
        assert!(parse_list(&bad).is_none(), "{bad}");
    }
    assert!(holds(None, "Who could cover Greeter?"));
    let one = parse_list(&format!(
        r#"{{"phrases":["check is out of date*"],"ozzies_own":["Our check is out of date."],{newer}}}"#
    ))
    .unwrap();
    assert!(holds(Some(&one), "the check is out of dated"));
    assert!(!holds(Some(&one), "Our check is out of date."));
    assert!(holds(Some(&one), "our check is out of date."));
    assert!(holds(Some(&one), "Our check is out of date. "));
    assert!(!holds(Some(&one), "Who could cover Greeter?"));
}
