//! The shared check over a temporary folder. Fictional names only (core/src/fictional-sunday.ts).
use super::*;
use crate::fixed::{self, CHECK_SKILL};
use crate::ledger::TaskLedger;
use std::path::PathBuf;

struct TempDir(PathBuf);
impl TempDir {
    fn new(label: &str) -> Self {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        Self(std::env::temp_dir().join(format!(
            "ozzie-shared-{label}-{}-{nanos}",
            std::process::id()
        )))
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// What the agent tools return for the fictional Sunday (core/mcp/snapshot.ts sharedEnvelopes).
const CHECKINS: &str = r#"{"tool":"sunday.rule_checkins","source":"Planning Center Services","check_time":"2026-11-20T15:00:00Z","completeness":"complete","payload":{"fact":"f11","check_in_after_sundays_in_a_row":3,"check_ins":[{"fact":"f12","person":"[Person 2]","sundays_in_a_row":3}],"check_in_means":"a schedule fact for a person to look at; about care, not performance"}}"#;
const RULES: &str = r#"{"tool":"rules.current","source":"Church rules on this Mac","check_time":"2026-11-20T15:00:00Z","completeness":"complete","payload":{"fact":"f20","check_in_after_sundays_in_a_row":3,"sunday_leads":[],"rooms":[{"room":"[Room 1]","rule":"not shared","setup_minutes":15}]}}"#;
const NOW: u64 = 1_795_000_000_000;
const COPY: &str = "B4K7Q2X9M3T8";

/// A folder with sharing turned on.
fn on(label: &str) -> TempDir {
    let dir = TempDir::new(label);
    start(&dir.0).unwrap();
    dir
}
fn partial(dir: &Path) -> PathBuf {
    dir.join(format!(".{SHARED_FILE}.partial"))
}

fn roster() -> NameGuard {
    let mut names = NameGuard::default();
    let fictional: Vec<String> = ["Avery Brightwater", "Blake Ashgrove", "Riley Thornbury"]
        .iter()
        .map(|n| n.to_string())
        .collect();
    names.remember(&fictional);
    names
}
fn owned(texts: &[&str]) -> Vec<String> {
    texts.iter().map(|t| t.to_string()).collect()
}

#[test]
fn shared_tools_match_the_server() {
    let ts =
        std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../mcp/snapshot.ts"))
            .unwrap();
    let list = ts
        .split("export const SHARED_TOOLS = Object.freeze([")
        .nth(1)
        .and_then(|rest| rest.split("] as const)").next())
        .unwrap();
    let names: Vec<&str> = list
        .split(',')
        .map(|s| s.trim().trim_matches('"'))
        .filter(|s| !s.is_empty())
        .collect();
    assert_eq!(names, SHARED_TOOLS);
    assert!(ts.contains(&format!("SHARED_FORMAT = \"{SHARED_FORMAT}\"")));
    assert!(ts.contains(&format!("SHARED_FILE = \"{SHARED_FILE}\"")));
    assert!(ts.contains("MAX_SHARED_TASKS = 20"));
    assert!(ts.contains("MAX_SHARED_BYTES = 256 * 1024"));
    assert!(ts.contains("COPY_ID = /^(?:[BCDFGHJKLMNPQRSTVWXZ][2-9]){6}$/u"));
    for tool in SHARED_TOOLS {
        assert!(
            crate::agent::NATIVE_TOOL_ALLOWLIST.contains(&tool),
            "{tool}"
        );
    }
}

#[test]
fn writes_checked_results_and_name_free_task_rows_privately() {
    let dir = on("write");
    let ledger = TaskLedger::open(&dir.0).unwrap();
    let id = "00000000-0000-4000-8000-000000000001";
    let hash = fixed::skill(CHECK_SKILL).unwrap().hash.clone();
    ledger.admit(id, "check", CHECK_SKILL, &hash).unwrap();
    ledger.transition(id, "running", None).unwrap();
    ledger
        .event(id, "tool", "sunday.overview complete")
        .unwrap();
    ledger.transition(id, "failed", Some("partial")).unwrap();

    share(
        &dir.0,
        &owned(&[CHECKINS, RULES]),
        &ledger.list(50),
        &roster(),
        COPY,
        NOW,
    )
    .unwrap();
    let path = dir.0.join(SHARED_FILE);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    assert!(!dir.0.join(format!(".{SHARED_FILE}.partial")).exists());
    let text = std::fs::read_to_string(&path).unwrap();
    let value: Value = serde_json::from_str(&text).unwrap();
    // The server checks keys as a set, so compare them sorted.
    let keys = |v: &Value| {
        let mut k: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
        k.sort();
        k
    };
    assert_eq!(
        keys(&value),
        [
            "checked_at",
            "copy_id",
            "envelopes",
            "format",
            "shared_at",
            "tasks"
        ]
    );
    assert_eq!(value["format"], SHARED_FORMAT);
    assert_eq!(value["copy_id"], COPY);
    assert_eq!(value["checked_at"], "2026-11-20T15:00:00.000Z");
    assert_eq!(value["shared_at"], rfc3339(NOW));
    assert_eq!(
        value["envelopes"][0],
        serde_json::from_str::<Value>(CHECKINS).unwrap()
    );
    assert_eq!(
        value["envelopes"][1],
        serde_json::from_str::<Value>(RULES).unwrap()
    );
    let task = &value["tasks"][0];
    assert_eq!(
        keys(task),
        [
            "created_at",
            "events",
            "failure",
            "kind",
            "skill_id",
            "state",
            "updated_at"
        ]
    );
    assert_eq!(task["kind"], "check");
    assert_eq!(task["skill_id"], CHECK_SKILL);
    assert_eq!(task["state"], "failed");
    assert_eq!(task["failure"], "partial");
    assert_eq!(keys(&task["events"][2]), ["at", "detail", "type"]);
    assert_eq!(task["events"][2]["detail"], "sunday.overview complete");
    // Neither the task id nor the procedure's hash is shared.
    assert!(!text.contains(id) && !text.contains(&hash));

    // Sharing again replaces the file whole; stopping removes it, twice is fine.
    share(&dir.0, &owned(&[RULES]), &[], &roster(), COPY, NOW + 1_000).unwrap();
    let again: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(again["envelopes"].as_array().unwrap().len(), 1);
    assert_eq!(again["tasks"], Value::Array(vec![]));
    stop(&dir.0).unwrap();
    assert!(!path.exists());
    stop(&dir.0).unwrap();
}

#[test]
fn the_check_time_is_the_facts_own_never_the_time_of_saving() {
    let dir = on("checked");
    // The earliest check time among the results, in any spelling the grammar allows.
    let checkins = CHECKINS.replacen("2026-11-20T15:00:00Z", "2026-11-20T14:59:30.500Z", 1);
    let rules = RULES.replacen("2026-11-20T15:00:00Z", "2026-11-20T09:59-05:00", 1);
    share(&dir.0, &[checkins, rules], &[], &roster(), COPY, NOW).unwrap();
    let value: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.0.join(SHARED_FILE)).unwrap()).unwrap();
    assert_eq!(value["checked_at"], "2026-11-20T14:59:00.000Z");
    assert_eq!(value["shared_at"], rfc3339(NOW));
    // Saving the same check again later moves only the save time.
    share(
        &dir.0,
        &owned(&[RULES]),
        &[],
        &roster(),
        COPY,
        NOW + 3_600_000,
    )
    .unwrap();
    let again: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.0.join(SHARED_FILE)).unwrap()).unwrap();
    assert_eq!(again["checked_at"], "2026-11-20T15:00:00.000Z");
    assert_eq!(again["shared_at"], rfc3339(NOW + 3_600_000));
    for (text, ms) in [
        ("2026-11-20T15:00Z", Some(1_795_186_800_000)),
        ("2026-11-20T15:00:00Z", Some(1_795_186_800_000)),
        ("2026-11-20T15:00:00.250Z", Some(1_795_186_800_250)),
        ("2026-11-20T10:00:00-05:00", Some(1_795_186_800_000)),
        ("2026-11-20T16:30+01:30", Some(1_795_186_800_000)),
        ("2026-11-20T15:00:00", None),
        ("2026-13-20T15:00:00Z", None),
        ("2026-11-20T15:00:00+24:00", None),
        ("soon", None),
    ] {
        assert_eq!(instant_ms(text), ms, "{text}");
    }
}

#[test]
fn a_copy_id_only_in_its_shape() {
    for good in [COPY, "Z9Z9Z9Z9Z9Z9", "B2C3D4F5G6H7"] {
        assert!(copy_id_ok(good), "{good}");
    }
    for bad in [
        "",
        "Avery",
        "b4k7q2x9m3t8",
        "5552013344AB",
        "A4K7Q2X9M3T8",
        "B4K7Q2X9M3T1",
        "B4K7Q2X9M3T8B4",
        "B4K7Q2X9M3",
        "B4K7Q2X9M3T８",
    ] {
        assert!(!copy_id_ok(bad), "{bad}");
        let dir = on("copy");
        assert_eq!(
            share(&dir.0, &owned(&[RULES]), &[], &roster(), bad, NOW),
            Err(ShareError::Invalid),
            "{bad}"
        );
        assert!(!dir.0.join(SHARED_FILE).exists(), "{bad}");
    }
}

#[test]
fn nothing_is_written_while_sharing_is_off_and_turning_it_off_removes_every_copy() {
    let dir = TempDir::new("off");
    assert!(!is_on(&dir.0));
    assert_eq!(
        share(&dir.0, &owned(&[RULES]), &[], &roster(), COPY, NOW),
        Err(ShareError::Off)
    );
    assert!(!dir.0.join(SHARED_FILE).exists());

    start(&dir.0).unwrap();
    assert!(is_on(&dir.0));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(dir.0.join(ON_FILE))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    share(&dir.0, &owned(&[RULES]), &[], &roster(), COPY, NOW).unwrap();
    std::fs::write(partial(&dir.0), b"half").unwrap();
    stop(&dir.0).unwrap();
    assert!(!is_on(&dir.0));
    assert!(!dir.0.join(SHARED_FILE).exists());
    assert!(!partial(&dir.0).exists());
    // A share asked for after off writes nothing.
    assert_eq!(
        share(&dir.0, &owned(&[RULES]), &[], &roster(), COPY, NOW),
        Err(ShareError::Off)
    );
    assert!(!dir.0.join(SHARED_FILE).exists());
    // The marker is never a link.
    #[cfg(unix)]
    {
        std::fs::write(dir.0.join("elsewhere"), b"").unwrap();
        std::os::unix::fs::symlink(dir.0.join("elsewhere"), dir.0.join(ON_FILE)).unwrap();
        assert!(!is_on(&dir.0));
    }
}

#[test]
fn clearing_removes_the_copy_and_keeps_sharing_on() {
    let dir = on("clear");
    share(&dir.0, &owned(&[RULES]), &[], &roster(), COPY, NOW).unwrap();
    std::fs::write(partial(&dir.0), b"half").unwrap();
    clear(&dir.0).unwrap();
    assert!(!dir.0.join(SHARED_FILE).exists());
    assert!(!partial(&dir.0).exists());
    assert!(is_on(&dir.0));
    clear(&dir.0).unwrap();
}

#[test]
fn each_start_removes_a_half_written_copy_and_while_off_the_copy_too() {
    // Off, with a copy left behind (a failed removal, a crash): both go.
    let dir = TempDir::new("startup-off");
    std::fs::create_dir_all(&dir.0).unwrap();
    std::fs::write(dir.0.join(SHARED_FILE), b"{}").unwrap();
    std::fs::write(partial(&dir.0), b"half").unwrap();
    startup(&dir.0).unwrap();
    assert!(!dir.0.join(SHARED_FILE).exists());
    assert!(!partial(&dir.0).exists());
    // No folder yet: nothing to do.
    startup(&TempDir::new("startup-none").0).unwrap();
    // On: the copy stays until the app decides what's current; the half-written one goes.
    let dir = on("startup-on");
    share(&dir.0, &owned(&[RULES]), &[], &roster(), COPY, NOW).unwrap();
    std::fs::write(partial(&dir.0), b"half").unwrap();
    startup(&dir.0).unwrap();
    assert!(dir.0.join(SHARED_FILE).exists());
    assert!(!partial(&dir.0).exists());
}

#[cfg(unix)]
#[test]
fn a_copy_that_cant_be_removed_is_reported_and_sharing_stays_on_to_turn_off_again() {
    use std::os::unix::fs::PermissionsExt;
    let dir = on("stuck");
    share(&dir.0, &owned(&[RULES]), &[], &roster(), COPY, NOW).unwrap();
    std::fs::set_permissions(&dir.0, std::fs::Permissions::from_mode(0o500)).unwrap();
    let stopped = stop(&dir.0);
    let cleared = clear(&dir.0);
    std::fs::set_permissions(&dir.0, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(stopped, Err(ShareError::Unavailable));
    assert_eq!(cleared, Err(ShareError::Unavailable));
    assert!(dir.0.join(SHARED_FILE).exists());
    // Still on (the marker couldn't go either), so the leader is asked to turn it off again.
    assert!(is_on(&dir.0));
    stop(&dir.0).unwrap();
    assert!(!dir.0.join(SHARED_FILE).exists());
}

#[test]
fn refuses_anything_but_one_checked_result_per_shared_tool() {
    let names = roster();
    let with = |from: &str, to: &str| RULES.replacen(from, to, 1);
    let cases: Vec<(&str, Vec<String>)> = vec![
        ("nothing", vec![]),
        ("the same tool twice", owned(&[RULES, RULES])),
        ("too many", (0..10).map(|_| RULES.to_owned()).collect()),
        ("an error result", owned(&[r#"{"error":"denied"}"#])),
        ("not JSON", owned(&["{"])),
        (
            "a tool that is never shared",
            vec![with("rules.current", "today.attention")],
        ),
        (
            "who could help",
            vec![with("rules.current", "sunday.who_could_help")],
        ),
        (
            "a name in place of a label",
            vec![with("[Room 1]", "Avery Brightwater")],
        ),
        (
            "a name in a label's brackets",
            vec![with("[Room 1]", "[Avery 1]")],
        ),
        ("a phone number", vec![with("not shared", "555-201-3344")]),
        (
            "an email address",
            vec![with("not shared", "avery@example.org")],
        ),
        (
            "a key outside the vocabulary",
            vec![with("\"sunday_leads\"", "\"names\"")],
        ),
        (
            "a hidden character",
            vec![with("not shared", "not\u{200b} shared")],
        ),
        ("an escape", vec![with("not shared", "not\\u0020shared")]),
    ];
    for (label, envelopes) in cases {
        assert_eq!(
            checked_envelopes(&envelopes, &names),
            Err(ShareError::Invalid),
            "{label}"
        );
        let dir = on("refuse");
        assert_eq!(
            share(&dir.0, &envelopes, &[], &names, COPY, NOW),
            Err(ShareError::Invalid),
            "{label}"
        );
        assert!(!dir.0.join(SHARED_FILE).exists(), "{label}");
    }
    assert!(checked_envelopes(&owned(&[CHECKINS, RULES]), &names).is_ok());
}

#[test]
fn a_refused_share_leaves_the_last_file_as_it_was() {
    let dir = on("keep");
    share(&dir.0, &owned(&[RULES]), &[], &roster(), COPY, NOW).unwrap();
    let before = std::fs::read(dir.0.join(SHARED_FILE)).unwrap();
    let bad = RULES.replacen("[Room 1]", "Riley Thornbury", 1);
    assert_eq!(
        share(&dir.0, &[bad], &[], &roster(), COPY, NOW + 1),
        Err(ShareError::Invalid)
    );
    assert_eq!(std::fs::read(dir.0.join(SHARED_FILE)).unwrap(), before);
}

/// The overview of a Sunday with kids rules, as the agent tools return it: kids-team counts as placeholders, and
/// the fixed line that some findings stay in Ozzie. Background checks never appear (core/src/kids-rules.ts forModels).
const KIDS_OVERVIEW: &str = r#"{"tool":"sunday.overview","source":"Planning Center Services","check_time":"2026-11-20T15:00:00Z","completeness":"complete","payload":{"fact":"f1","mode":"live","sunday":"2026-11-22","reads":26,"reads_not_completed":0,"needs_a_decision":1,"worth_a_look":0,"kept_on_this_mac":"some findings are shown only in Ozzie on this Mac","findings":[{"fact":"f2","kind":"fewer confirmed than the church rules ask","tone":"needs a decision","role":"[Role 1]","time":{"starts_at":"2026-11-22T09:30-05:00","ends_at":"2026-11-22T10:30-05:00"},"confirmed":1,"needed":2,"asked_no_answer":0,"request_not_sent":0,"ages":"confirmed people counted; ages not checked"}]}}"#;

#[test]
fn kids_counts_are_shared_as_placeholders_and_a_background_check_never_is() {
    let names = roster();
    assert!(checked_envelopes(&owned(&[KIDS_OVERVIEW]), &names).is_ok());
    let row = r#"{"fact":"f3","kind":"background check","tone":"needs a decision","role":"[Role 1]","person":"[Person 1]","status":"no current background check on file"}"#;
    let with_row = KIDS_OVERVIEW.replacen(r#""findings":["#, &format!(r#""findings":[{row},"#), 1);
    for (label, envelope) in [
        ("a background-check row", with_row),
        (
            "a background-check status",
            KIDS_OVERVIEW.replacen(
                "confirmed people counted; ages not checked",
                "no current background check on file",
                1,
            ),
        ),
        (
            "a not-checked line about background checks",
            r#"{"tool":"sunday.not_checked","source":"Planning Center Services","check_time":"2026-11-20T15:00:00Z","completeness":"complete","payload":{"fact":"f1","reads":26,"reads_not_completed":0,"too_old_to_treat_as_current":false,"services":["Background checks for 1 person: couldn't be read."],"rooms_follow_ups_groups":[]}}"#.to_string(),
        ),
    ] {
        assert_eq!(
            checked_envelopes(&[envelope], &names),
            Err(ShareError::Invalid),
            "{label}"
        );
    }
}

/// A not-checked result holding `line` among what wasn't checked.
fn not_checked_with(line: &str) -> String {
    format!(
        r#"{{"tool":"sunday.not_checked","source":"Planning Center Services","check_time":"2026-11-20T15:00:00Z","completeness":"complete","payload":{{"fact":"f1","reads":26,"reads_not_completed":0,"too_old_to_treat_as_current":true,"services":[],"rooms_follow_ups_groups":["{line}"]}}}}"#
    )
}

#[test]
fn background_check_wording_the_grammar_could_form_is_never_written_to_the_shared_copy() {
    // Review B L3 (owner decision 2026-11-14: "never in the copy shared with other AI apps"). Fixed
    // words alone can still spell "the check is out of date" or "records check": the grammar lets
    // them through, the wording check refuses the share whole, and nothing is written.
    let names = roster();
    for line in ["The check is out of date.", "Some records check out."] {
        let envelope = not_checked_with(line);
        assert!(
            tool_message_ok(&envelope, "sunday.not_checked", &names),
            "{line}: only the wording check refuses it"
        );
        assert_eq!(
            checked_envelopes(std::slice::from_ref(&envelope), &names),
            Err(ShareError::Invalid),
            "{line}"
        );
        let dir = on("share-background");
        assert_eq!(
            share(&dir.0, &[envelope], &[], &names, COPY, NOW),
            Err(ShareError::Invalid)
        );
        assert!(!dir.0.join(SHARED_FILE).exists(), "{line}");
    }
    // Ozzie's own out-of-date line, exactly as it writes it, is shared as before.
    let own = not_checked_with(
        "Rooms, follow-ups and group meetings: this check is out of date, so they aren't shown.",
    );
    assert!(checked_envelopes(&[own], &names).is_ok());
}

/// A Planning Center church's copy, byte for byte as 0.9.1 wrote it (c1e12bb6), before a church on B1 Church or Breeze
/// could be shared: no system part, the same keys in the same order, every result as written.
#[test]
fn a_planning_center_copy_is_byte_for_byte_as_before() {
    let dir = on("pin");
    let ledger = TaskLedger::open(&dir.0).unwrap();
    let id = "00000000-0000-4000-8000-000000000009";
    let hash = fixed::skill(CHECK_SKILL).unwrap().hash.clone();
    ledger.admit(id, "check", CHECK_SKILL, &hash).unwrap();
    ledger.transition(id, "running", None).unwrap();
    ledger
        .event(id, "tool", "planning_center.refresh complete")
        .unwrap();
    let tasks: Vec<TaskRow> = ledger
        .list(50)
        .into_iter()
        .map(|mut t| {
            // Times fixed, so the bytes don't follow the clock the test runs at.
            t.created_at = "2026-11-20T15:00:00.000Z".into();
            t.updated_at = "2026-11-20T15:00:04.000Z".into();
            for e in &mut t.events {
                e.at = "2026-11-20T15:00:02.000Z".into();
            }
            t
        })
        .collect();
    let bytes = shared_bytes(&owned(&[CHECKINS, RULES]), &tasks, &roster(), COPY, NOW).unwrap();
    assert_eq!(String::from_utf8(bytes).unwrap(), PLANNING_CENTER_COPY);
}
const PLANNING_CENTER_COPY: &str = concat!(
    r#"{"format":"ozzie-shared-check-2","copy_id":"B4K7Q2X9M3T8","checked_at":"2026-11-20T15:00:00.000Z","shared_at":"2026-11-18T11:06:40.000Z","envelopes":[{"check_time":"2026-11-20T15:00:00Z","completeness"#,
    r#"":"complete","payload":{"check_in_after_sundays_in_a_row":3,"check_in_means":"a schedule fact for a person to look at; about care, not performance","check_ins":[{"fact":"f12","person":"[Person 2]","sundays_in_a_row":3}],"fact":"f11"},"source":"Planning Center Services","tool":"sunday.rule_checkins"},{"check_time":"2026-11-20T15:00:00Z","completeness":"complete","payload":{"check_in_after_sundays_i"#,
    r#"n_a_row":3,"fact":"f20","rooms":[{"room":"[Room 1]","rule":"not shared","setup_minutes":15}],"sunday_leads":[]},"source":"Church rules on this Mac","tool":"rules.current"}],"tasks":[{"kind":"check","skill_id":"sunday-ready","state":"running","created_at":"2026-11-20T15:00:00.000Z","updated_at":"2026-11-20T15:00:04.000Z","failure":null,"events":[{"type":"admitted","detail":"","at":"2026-11-20T15:00"#,
    r#":02.000Z"},{"type":"running","detail":"","at":"2026-11-20T15:00:02.000Z"},{"type":"tool","detail":"planning_center.refresh complete","at":"2026-11-20T15:00:02.000Z"}]}]}"#,
);

/// The overview of a church on B1 Church, as the agent tools return it over that system's check (core/test/church-systems
/// fixtures.ts `b1Capture`): the system as the source, labels only.
const B1_OVERVIEW: &str = r#"{"tool":"sunday.overview","source":"B1 Church","check_time":"2026-11-20T15:00:00Z","completeness":"complete","payload":{"fact":"f1","mode":"live","sunday":"2026-11-22","reads":9,"reads_not_completed":0,"needs_a_decision":1,"worth_a_look":1,"findings":[{"fact":"f2","kind":"needs people","tone":"needs a decision","role":"[Role 1]","time":{"starts_at":"2026-11-22T09:00-06:00","ends_at":"2026-11-22T10:30-06:00"},"remaining":1},{"fact":"f3","kind":"pending","tone":"worth a look","role":"[Role 1]","time":{"starts_at":"2026-11-22T09:00-06:00","ends_at":"2026-11-22T10:30-06:00"},"person":"[Person 1]","request":"request not sent yet"}]}}"#;
/** A Breeze church's overview where Breeze gave no number for any role: no role is counted as needing people. */
const BREEZE_OVERVIEW: &str = r#"{"tool":"sunday.overview","source":"Breeze","check_time":"2026-11-20T15:00:00Z","completeness":"complete","payload":{"fact":"f1","mode":"live","sunday":"2026-11-22","reads":5,"reads_not_completed":0,"needs_a_decision":0,"worth_a_look":1,"findings":[{"fact":"f2","kind":"pending","tone":"worth a look","role":"[Role 1]","time":"not known","person":"[Person 1]","request":"not known"}]}}"#;
const B1: SharedSystem = SharedSystem {
    id: SystemId::B1,
    role_numbers: RoleNumbers::Every,
};
const BREEZE_NONE: SharedSystem = SharedSystem {
    id: SystemId::Breeze,
    role_numbers: RoleNumbers::Unshared,
};

#[test]
fn the_system_part_matches_the_server() {
    let ts =
        std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../mcp/snapshot.ts"))
            .unwrap();
    assert!(ts.contains(
        r#"SHARED_SYSTEMS = Object.freeze({ b1: "B1 Church", breeze: "Breeze" } as const)"#
    ));
    assert!(ts.contains(r#"ROLE_NUMBERS = Object.freeze(["all", "some", "none"] as const)"#));
    assert!(ts.contains(
        r#"OTHER_SOURCES: ReadonlySet<string> = new Set(["B1 Church", "Breeze", "Genesis"])"#
    ));
    for (system, id) in [(SystemId::B1, "b1"), (SystemId::Breeze, "breeze")] {
        assert_eq!(serde_json::to_value(system).unwrap(), id);
        assert!(ts.contains(&format!("{id}: \"{}\"", system.source())));
    }
    for (numbers, word) in [
        (RoleNumbers::Every, "all"),
        (RoleNumbers::Partly, "some"),
        (RoleNumbers::Unshared, "none"),
    ] {
        assert_eq!(serde_json::to_value(numbers).unwrap(), word);
    }
}

#[test]
fn the_system_part_is_read_from_the_page_only_in_its_closed_words() {
    let read = |text: &str| serde_json::from_str::<SharedSystem>(text);
    assert_eq!(read(r#"{"id":"b1","role_numbers":"all"}"#).unwrap(), B1);
    assert_eq!(
        read(r#"{"id":"breeze","role_numbers":"none"}"#).unwrap(),
        BREEZE_NONE
    );
    for bad in [
        r#"{"id":"genesis","role_numbers":"all"}"#,
        r#"{"id":"planning-center","role_numbers":"all"}"#,
        r#"{"id":"B1","role_numbers":"all"}"#,
        r#"{"id":"b1","role_numbers":"most"}"#,
        r#"{"id":"b1"}"#,
        r#"{"id":"b1","role_numbers":"all","church":"Cedar Hollow Fellowship"}"#,
        r#""b1""#,
    ] {
        assert!(read(bad).is_err(), "{bad}");
    }
}

#[test]
fn a_church_on_another_system_is_shared_with_its_system_and_no_name() {
    let dir = on("system");
    share_of(
        &dir.0,
        &owned(&[B1_OVERVIEW, RULES]),
        &[],
        &roster(),
        COPY,
        Some(B1),
        NOW,
    )
    .unwrap();
    let text = std::fs::read_to_string(dir.0.join(SHARED_FILE)).unwrap();
    // The system part comes straight after the format, so a reader can tell the copy's church system first.
    assert!(text.starts_with(
        r#"{"format":"ozzie-shared-check-2","system":"b1","role_numbers":"all","copy_id":"B4K7Q2X9M3T8","checked_at":"#
    ));
    let value: Value = serde_json::from_str(&text).unwrap();
    let mut keys: Vec<&String> = value.as_object().unwrap().keys().collect();
    keys.sort();
    assert_eq!(
        keys,
        [
            "checked_at",
            "copy_id",
            "envelopes",
            "format",
            "role_numbers",
            "shared_at",
            "system",
            "tasks"
        ]
    );
    assert_eq!(value["envelopes"][0]["source"], "B1 Church");
    // Breeze, with no number shared for any role.
    share_of(
        &dir.0,
        &owned(&[BREEZE_OVERVIEW]),
        &[],
        &roster(),
        COPY,
        Some(BREEZE_NONE),
        NOW,
    )
    .unwrap();
    let value: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.0.join(SHARED_FILE)).unwrap()).unwrap();
    assert_eq!(
        (&value["system"], &value["role_numbers"]),
        (&Value::from("breeze"), &Value::from("none"))
    );
    // Off: nothing is written for another system either.
    stop(&dir.0).unwrap();
    assert_eq!(
        share_of(
            &dir.0,
            &owned(&[B1_OVERVIEW]),
            &[],
            &roster(),
            COPY,
            Some(B1),
            NOW
        ),
        Err(ShareError::Off)
    );
    assert!(!dir.0.join(SHARED_FILE).exists());
}

#[test]
fn a_check_is_never_shared_as_another_systems_and_names_are_refused_for_every_system() {
    let names = roster();
    let pc_overview = B1_OVERVIEW.replacen("B1 Church", "Planning Center Services", 1);
    let breeze = B1_OVERVIEW.replacen("B1 Church", "Breeze", 1);
    let genesis = B1_OVERVIEW.replacen("B1 Church", "Genesis", 1);
    let named = B1_OVERVIEW.replacen("[Person 1]", "Riley Thornbury", 1);
    let cases: Vec<(&str, Vec<String>, Option<SharedSystem>)> = vec![
        (
            "B1 Church's check as Planning Center's",
            owned(&[B1_OVERVIEW]),
            None,
        ),
        (
            "Breeze's check as Planning Center's",
            vec![breeze.clone()],
            None,
        ),
        (
            "a Genesis source as Planning Center's",
            vec![genesis.clone()],
            None,
        ),
        ("Breeze's check as B1 Church's", vec![breeze], Some(B1)),
        (
            "Planning Center's check as B1 Church's",
            vec![pc_overview],
            Some(B1),
        ),
        ("a Genesis source as B1 Church's", vec![genesis], Some(B1)),
        (
            "only the Church rules as B1 Church's",
            owned(&[RULES]),
            Some(B1),
        ),
        (
            "B1 Church's check beside Planning Center's",
            owned(&[B1_OVERVIEW, CHECKINS]),
            Some(B1),
        ),
        ("a name in B1 Church's check", vec![named], Some(B1)),
    ];
    for (label, envelopes, system) in cases {
        let dir = on("other");
        assert_eq!(
            share_of(&dir.0, &envelopes, &[], &names, COPY, system, NOW),
            Err(ShareError::Invalid),
            "{label}"
        );
        assert!(!dir.0.join(SHARED_FILE).exists(), "{label}");
    }
    // Planning Center's own results are still shared with no system, as before.
    let dir = on("pc");
    share_of(
        &dir.0,
        &owned(&[CHECKINS, RULES]),
        &[],
        &names,
        COPY,
        None,
        NOW,
    )
    .unwrap();
    assert_eq!(
        std::fs::read(dir.0.join(SHARED_FILE)).unwrap(),
        shared_bytes(&owned(&[CHECKINS, RULES]), &[], &names, COPY, NOW).unwrap()
    );
}

/// Native doesn't take the page's word for whether the system numbered its roles (privacy review L3): a role counted as
/// needing people with a number means not "none", and one whose number is "not known" means not "all".
#[test]
fn role_numbers_must_fit_the_rows_native_checks() {
    let names = roster();
    let partly = |id| SharedSystem {
        id,
        role_numbers: RoleNumbers::Partly,
    };
    let unknown = B1_OVERVIEW.replacen(r#""remaining":1"#, r#""remaining":"not known""#, 1);
    let needs = r#"{"tool":"sunday.open_needs","source":"B1 Church","check_time":"2026-11-20T15:00:00Z","completeness":"complete","payload":{"fact":"f6","needs":[{"fact":"f7","kind":"needs people","role":"[Role 1]","time":{"starts_at":"2026-11-22T09:00-06:00","ends_at":"2026-11-22T10:30-06:00"},"remaining":"not known","confirmed":[],"people_listed":{"no_overlap_found":0,"possible_conflict":0,"needs_confirmation":0,"left_out":0}}]}}"#;
    let b1_none = SharedSystem {
        id: SystemId::B1,
        role_numbers: RoleNumbers::Unshared,
    };
    let breeze_all = SharedSystem {
        id: SystemId::Breeze,
        role_numbers: RoleNumbers::Every,
    };
    let refused: Vec<(&str, Vec<String>, SharedSystem)> = vec![
        (
            "a counted role with none numbered",
            owned(&[B1_OVERVIEW]),
            b1_none,
        ),
        (
            "an uncounted role with all numbered",
            vec![unknown.clone()],
            B1,
        ),
        (
            "an uncounted role in the open roles with all numbered",
            vec![B1_OVERVIEW.to_owned(), needs.to_owned()],
            B1,
        ),
    ];
    for (label, envelopes, system) in refused {
        let dir = on("numbers");
        assert_eq!(
            share_of(&dir.0, &envelopes, &[], &names, COPY, Some(system), NOW),
            Err(ShareError::Invalid),
            "{label}"
        );
        assert!(!dir.0.join(SHARED_FILE).exists(), "{label}");
    }
    // What fits: as the page works it out.
    for (envelopes, system) in [
        (owned(&[B1_OVERVIEW]), B1),
        (vec![unknown], partly(SystemId::B1)),
        (owned(&[B1_OVERVIEW]), partly(SystemId::B1)),
        (
            vec![B1_OVERVIEW.to_owned(), needs.to_owned()],
            partly(SystemId::B1),
        ),
        (owned(&[BREEZE_OVERVIEW]), BREEZE_NONE),
        (owned(&[BREEZE_OVERVIEW]), breeze_all),
    ] {
        let dir = on("numbers-ok");
        share_of(&dir.0, &envelopes, &[], &names, COPY, Some(system), NOW).unwrap();
    }
}
