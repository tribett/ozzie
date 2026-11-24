//! The copy for Siri and Shortcuts over a temporary folder. Fictional names only (core/src/fictional-sunday.ts).
use super::*;
use crate::shared_check::{self, OTHER_AI_APPS, SHARED_FILE};
use serde_json::Value;
use std::path::{Path, PathBuf};

struct TempDir(PathBuf);
impl TempDir {
    fn new(label: &str) -> Self {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        Self(std::env::temp_dir().join(format!(
            "ozzie-shortcuts-{label}-{}-{nanos}",
            std::process::id()
        )))
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The overview the agent tools return for the fictional Sunday (core/mcp/snapshot.ts sharedEnvelopes).
const OVERVIEW: &str = r#"{"tool":"sunday.overview","source":"Planning Center Services","check_time":"2026-11-20T15:00:00Z","completeness":"complete","payload":{"fact":"f1","mode":"live","sunday":"2026-11-22","reads":26,"reads_not_completed":0,"needs_a_decision":2,"worth_a_look":1,"findings":[{"fact":"f2","kind":"needs people","tone":"needs a decision","role":"[Role 1]","time":{"starts_at":"2026-11-22T09:30-05:00","ends_at":"2026-11-22T10:30-05:00"},"remaining":1},{"fact":"f3","kind":"pending","tone":"worth a look","role":"[Role 3]","time":{"starts_at":"2026-11-22T09:30-05:00","ends_at":"2026-11-22T10:30-05:00"},"person":"[Person 1]","request":"request not sent yet"}]}}"#;
const RULES: &str = r#"{"tool":"rules.current","source":"Church rules on this Mac","check_time":"2026-11-20T15:00:00Z","completeness":"complete","payload":{"fact":"f20","check_in_after_sundays_in_a_row":3,"sunday_leads":[],"rooms":[{"room":"[Room 1]","rule":"not shared","setup_minutes":15}]}}"#;
const NOW: u64 = 1_795_000_000_000;
const COPY: &str = "B4K7Q2X9M3T8";

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
fn on(label: &str) -> TempDir {
    let dir = TempDir::new(label);
    start(&dir.0).unwrap();
    dir
}
fn copy(dir: &Path) -> PathBuf {
    dir.join(SHORTCUTS.file)
}

#[test]
fn names_and_tools_match_the_answers() {
    let ts =
        std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../mcp/shortcuts.ts"))
            .unwrap();
    assert!(ts.contains(&format!("SHORTCUTS_FILE = \"{}\"", SHORTCUTS.file)));
    assert!(ts.contains(&format!("SHORTCUTS_ON_FILE = \"{}\"", SHORTCUTS.on_file)));
    let list = ts
        .split("export const SHORTCUT_TOOLS = Object.freeze([")
        .nth(1)
        .and_then(|rest| rest.split("] as const)").next())
        .unwrap();
    let tools: Vec<&str> = list
        .split(',')
        .map(|s| s.trim().trim_matches('"'))
        .filter(|s| !s.is_empty())
        .collect();
    assert_eq!(tools, SHORTCUT_TOOLS);
    for tool in SHORTCUT_TOOLS {
        assert!(shared_check::SHARED_TOOLS.contains(&tool), "{tool}");
    }
    // Its own files, never the copy for other AI apps'.
    assert_ne!(SHORTCUTS.file, OTHER_AI_APPS.file);
    assert_ne!(SHORTCUTS.on_file, OTHER_AI_APPS.on_file);
    assert!(SHORTCUTS.on_file.starts_with('.') && !SHORTCUTS.file.contains('/'));
}

#[test]
fn writes_only_the_checked_overview_with_no_tasks_privately() {
    let dir = on("write");
    save(&dir.0, &owned(&[OVERVIEW]), &roster(), COPY, NOW).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&copy(&dir.0)), 0o600);
        assert_eq!(mode(&dir.0.join(SHORTCUTS.on_file)), 0o600);
    }
    let value: Value =
        serde_json::from_str(&std::fs::read_to_string(copy(&dir.0)).unwrap()).unwrap();
    assert_eq!(value["format"], shared_check::SHARED_FORMAT);
    assert_eq!(value["copy_id"], COPY);
    assert_eq!(value["checked_at"], "2026-11-20T15:00:00.000Z");
    assert_eq!(
        value["envelopes"],
        Value::Array(vec![serde_json::from_str(OVERVIEW).unwrap()])
    );
    assert_eq!(value["tasks"], Value::Array(vec![]));
    assert!(!dir.0.join(format!(".{}.partial", SHORTCUTS.file)).exists());
    // Writing it touches nothing of the copy for other AI apps.
    assert!(!dir.0.join(SHARED_FILE).exists());
    assert!(!shared_check::is_on(&dir.0));
}

#[test]
fn refuses_anything_but_one_overview_and_keeps_the_last_copy() {
    let dir = on("refuse");
    save(&dir.0, &owned(&[OVERVIEW]), &roster(), COPY, NOW).unwrap();
    let before = std::fs::read(copy(&dir.0)).unwrap();
    let background = OVERVIEW.replacen(
        r#""findings":["#,
        r#""findings":[{"fact":"f9","kind":"background check","tone":"needs a decision","role":"[Role 1]","person":"[Person 1]","status":"no current background check on file"},"#,
        1,
    );
    let cases: Vec<(&str, Vec<String>)> = vec![
        ("nothing", vec![]),
        ("another shared tool", owned(&[RULES])),
        ("the overview and another", owned(&[OVERVIEW, RULES])),
        ("the overview twice", owned(&[OVERVIEW, OVERVIEW])),
        ("not JSON", owned(&["{"])),
        (
            "a name in place of a label",
            vec![OVERVIEW.replacen("[Role 1]", "Avery Brightwater", 1)],
        ),
        (
            "a phone number",
            vec![OVERVIEW.replacen("request not sent yet", "555-201-3344", 1)],
        ),
        ("a background check", vec![background]),
        (
            "a key outside the vocabulary",
            vec![OVERVIEW.replacen(
                r#""kind":"pending""#,
                r#""kind":"pending","note":"The check is out of date.""#,
                1,
            )],
        ),
    ];
    for (label, envelopes) in cases {
        assert_eq!(
            save(&dir.0, &envelopes, &roster(), COPY, NOW + 1),
            Err(ShareError::Invalid),
            "{label}"
        );
        assert_eq!(std::fs::read(copy(&dir.0)).unwrap(), before, "{label}");
    }
    assert_eq!(
        save(&dir.0, &owned(&[OVERVIEW]), &roster(), "Avery", NOW),
        Err(ShareError::Invalid)
    );
}

#[test]
fn nothing_is_written_while_off_and_turning_it_off_removes_the_copy() {
    let dir = TempDir::new("off");
    assert!(!is_on(&dir.0));
    assert_eq!(
        save(&dir.0, &owned(&[OVERVIEW]), &roster(), COPY, NOW),
        Err(ShareError::Off)
    );
    assert!(!copy(&dir.0).exists());
    start(&dir.0).unwrap();
    assert!(is_on(&dir.0));
    save(&dir.0, &owned(&[OVERVIEW]), &roster(), COPY, NOW).unwrap();
    std::fs::write(dir.0.join(format!(".{}.partial", SHORTCUTS.file)), b"half").unwrap();
    stop(&dir.0).unwrap();
    assert!(!is_on(&dir.0));
    assert!(!copy(&dir.0).exists());
    assert!(!dir.0.join(format!(".{}.partial", SHORTCUTS.file)).exists());
    stop(&dir.0).unwrap();
    // The marker is never a link.
    #[cfg(unix)]
    {
        std::fs::write(dir.0.join("elsewhere"), b"").unwrap();
        std::os::unix::fs::symlink(dir.0.join("elsewhere"), dir.0.join(SHORTCUTS.on_file)).unwrap();
        assert!(!is_on(&dir.0));
    }
}

#[test]
fn the_two_switches_and_their_copies_are_independent() {
    let dir = on("both");
    shared_check::start(&dir.0).unwrap();
    save(&dir.0, &owned(&[OVERVIEW]), &roster(), COPY, NOW).unwrap();
    shared_check::share(&dir.0, &owned(&[RULES]), &[], &roster(), COPY, NOW).unwrap();
    // Turning other AI apps off leaves Siri and Shortcuts as they were, and the other way round.
    shared_check::stop(&dir.0).unwrap();
    assert!(is_on(&dir.0) && copy(&dir.0).exists());
    assert!(!dir.0.join(SHARED_FILE).exists());
    shared_check::start(&dir.0).unwrap();
    shared_check::share(&dir.0, &owned(&[RULES]), &[], &roster(), COPY, NOW).unwrap();
    stop(&dir.0).unwrap();
    assert!(!is_on(&dir.0) && !copy(&dir.0).exists());
    assert!(shared_check::is_on(&dir.0) && dir.0.join(SHARED_FILE).exists());
    // Clearing one leaves the other.
    start(&dir.0).unwrap();
    save(&dir.0, &owned(&[OVERVIEW]), &roster(), COPY, NOW).unwrap();
    shared_check::clear(&dir.0).unwrap();
    assert!(copy(&dir.0).exists());
    clear(&dir.0).unwrap();
    assert!(!copy(&dir.0).exists() && is_on(&dir.0));
}

#[test]
fn each_start_removes_a_copy_left_while_off() {
    let dir = TempDir::new("startup");
    std::fs::create_dir_all(&dir.0).unwrap();
    std::fs::write(copy(&dir.0), b"{}").unwrap();
    std::fs::write(dir.0.join(format!(".{}.partial", SHORTCUTS.file)), b"half").unwrap();
    startup(&dir.0).unwrap();
    assert!(!copy(&dir.0).exists());
    assert!(!dir.0.join(format!(".{}.partial", SHORTCUTS.file)).exists());
    let dir = on("startup-on");
    save(&dir.0, &owned(&[OVERVIEW]), &roster(), COPY, NOW).unwrap();
    startup(&dir.0).unwrap();
    assert!(copy(&dir.0).exists());
}

#[test]
fn a_church_on_another_system_keeps_its_overview_with_its_system() {
    use crate::shared_check::{RoleNumbers, SharedSystem, SystemId};
    let breeze = SharedSystem {
        id: SystemId::Breeze,
        role_numbers: RoleNumbers::Unshared,
    };
    // Breeze with no number for any role: no role counted as needing people (shared_check.rs `numbers_fit`).
    let overview = r#"{"tool":"sunday.overview","source":"Breeze","check_time":"2026-11-20T15:00:00Z","completeness":"complete","payload":{"fact":"f1","mode":"live","sunday":"2026-11-22","reads":5,"reads_not_completed":0,"needs_a_decision":0,"worth_a_look":1,"findings":[{"fact":"f2","kind":"pending","tone":"worth a look","role":"[Role 1]","time":"not known","person":"[Person 1]","request":"not known"}]}}"#.to_owned();
    let dir = on("system");
    save_of(
        &dir.0,
        &[overview.clone()],
        &roster(),
        COPY,
        Some(breeze),
        NOW,
    )
    .unwrap();
    let value: Value =
        serde_json::from_str(&std::fs::read_to_string(copy(&dir.0)).unwrap()).unwrap();
    assert_eq!(value["system"], "breeze");
    assert_eq!(value["role_numbers"], "none");
    assert_eq!(value["tasks"], Value::Array(vec![]));
    // Only the overview, and only as the system it names; Planning Center's as before, with no system.
    for (envelopes, system) in [
        (vec![overview.clone()], None),
        (owned(&[OVERVIEW]), Some(breeze)),
        (vec![overview.clone(), RULES.to_owned()], Some(breeze)),
        (owned(&[RULES]), Some(breeze)),
        (
            vec![OVERVIEW.replacen("Planning Center Services", "Breeze", 1)],
            Some(breeze),
        ),
        (
            vec![overview.replacen("[Person 1]", "Avery Brightwater", 1)],
            Some(breeze),
        ),
    ] {
        let before = std::fs::read(copy(&dir.0)).unwrap();
        assert_eq!(
            save_of(&dir.0, &envelopes, &roster(), COPY, system, NOW + 1),
            Err(ShareError::Invalid)
        );
        assert_eq!(std::fs::read(copy(&dir.0)).unwrap(), before);
    }
    save(&dir.0, &owned(&[OVERVIEW]), &roster(), COPY, NOW).unwrap();
    let value: Value =
        serde_json::from_str(&std::fs::read_to_string(copy(&dir.0)).unwrap()).unwrap();
    assert!(value.get("system").is_none() && value.get("role_numbers").is_none());
}

#[test]
fn a_church_on_genesis_keeps_only_the_fixed_line_and_only_while_on() {
    let ts =
        std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../mcp/shortcuts.ts"))
            .unwrap();
    let fixed = std::str::from_utf8(GENESIS_COPY).unwrap();
    assert!(ts.contains(&format!("GENESIS_COPY = '{fixed}'")));
    // It holds no fact: no copy id, no time, no result.
    let value: Value = serde_json::from_slice(GENESIS_COPY).unwrap();
    assert_eq!(value.as_object().unwrap().len(), 2);
    let dir = on("genesis");
    save(&dir.0, &owned(&[OVERVIEW]), &roster(), COPY, NOW).unwrap();
    save_genesis(&dir.0).unwrap();
    assert_eq!(std::fs::read(copy(&dir.0)).unwrap(), GENESIS_COPY);
    // The copy for other AI apps is never touched.
    assert!(!dir.0.join(SHARED_FILE).exists());
    stop(&dir.0).unwrap();
    assert_eq!(save_genesis(&dir.0), Err(ShareError::Off));
    assert!(!copy(&dir.0).exists());
}
