//! The registry against the page's own lists in core/src/church-systems/types.ts (read as text, never changed here):
//! the closed read words (`READS`) and what each system supplies (`SYSTEMS`).
use super::*;
use std::collections::BTreeMap;

fn types_ts() -> String {
    let path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/church-systems/types.ts");
    std::fs::read_to_string(path).expect("core/src/church-systems/types.ts sits beside this crate")
}
/// The text between `start` and the next `end` after it.
fn between<'a>(text: &'a str, start: &str, end: &str) -> &'a str {
    let from = text
        .find(start)
        .unwrap_or_else(|| panic!("{start} in types.ts"))
        + start.len();
    let to = text[from..].find(end).unwrap() + from;
    &text[from..to]
}
/// Every `"<system>.<word>":` key in `READS`, by system, in the order written.
fn ts_words() -> BTreeMap<String, Vec<String>> {
    let text = types_ts();
    let block = between(&text, "export const READS", "\n});");
    let mut out: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for piece in block.split('"').collect::<Vec<_>>().windows(2) {
        let (word, after) = (piece[0], piece[1]);
        if after.starts_with(':') && word.contains('.') {
            let system = word.split('.').next().unwrap().to_owned();
            out.entry(system).or_default().push(word.to_owned());
        }
    }
    out
}

#[test]
fn every_systems_read_words_are_the_pages() {
    let ts = ts_words();
    assert_eq!(ts.len(), 3);
    for system in System::all() {
        let ours: Vec<String> = system
            .read_words()
            .iter()
            .map(|w| w.as_str().to_owned())
            .collect();
        assert_eq!(Some(&ours), ts.get(system.word()), "{}", system.word());
        for word in system.read_words() {
            assert!(word.as_str().starts_with(&format!("{}.", system.word())));
        }
    }
    // A check records only listed words, each once.
    for word in b1::READS {
        assert!(b1::WORDS.contains(word));
    }
}

#[test]
fn every_system_supplies_what_the_page_says() {
    let text = types_ts();
    let block = between(&text, "export const SYSTEMS", "\n});");
    for system in System::all() {
        let line = between(block, &format!("{}: Object.freeze({{", system.word()), "})");
        let flag = |name: &str| between(line, &format!("{name}: "), ",").trim() == "true";
        let supplies = system.supplies();
        assert_eq!(between(line, "name: \"", "\""), system.display_name());
        assert_eq!(
            flag("sundayCheck"),
            supplies.sunday_check,
            "{}",
            system.word()
        );
        assert_eq!(flag("blockouts"), supplies.blockouts, "{}", system.word());
        assert_eq!(
            flag("teamMembers"),
            supplies.team_members,
            "{}",
            system.word()
        );
        assert_eq!(flag("attendance"), supplies.attendance, "{}", system.word());
        assert_eq!(flag("busy"), supplies.busy, "{}", system.word());
        assert_eq!(flag("answers"), supplies.answers, "{}", system.word());
        assert_eq!(flag("asked"), supplies.asked, "{}", system.word());
        assert_eq!(
            flag("zoneMayBeDefault"),
            supplies.zone_may_be_default,
            "{}",
            system.word()
        );
        assert!(!supplies.background_checks);
    }
}

#[test]
fn the_registry_names_each_system_and_its_hosts() {
    assert_eq!(
        System::all().map(System::display_name),
        ["B1 Church", "Breeze", "Genesis"]
    );
    assert_eq!(System::B1.hosts(), Hosts::Fixed(&["api.churchapps.org"]));
    assert_eq!(
        System::Breeze.hosts(),
        Hosts::ChurchSubdomainOf("breezechms.com")
    );
    for system in System::all() {
        assert_eq!(serde_json::to_value(system).unwrap(), system.word());
    }
}

#[test]
fn each_system_says_what_it_cannot_supply() {
    use crate::Unread;
    for system in System::all() {
        assert!(
            system.cannot_supply().contains(&Unread::BackgroundChecks),
            "{}",
            system.word()
        );
    }
    let breeze = System::Breeze.cannot_supply();
    for gap in [
        Unread::NewerVolunteerScheduler,
        Unread::Blockouts,
        Unread::RoleTeams,
    ] {
        assert!(breeze.contains(&gap), "{gap:?}");
    }
    // Breeze's answer codes are confirmed (2026-11-17): no system lists them as unread now.
    assert!(
        System::all()
            .iter()
            .all(|s| !s.cannot_supply().contains(&Unread::AnswerCodes))
    );
    assert!(
        System::Genesis
            .cannot_supply()
            .contains(&Unread::VolunteerSchedules)
    );
    assert_eq!(
        serde_json::to_value(Unread::NewerVolunteerScheduler).unwrap(),
        "newer-volunteer-scheduler"
    );
}
