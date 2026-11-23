//! Structure: in the desktop app only changes.rs reaches core `change`, only its confirm command makes
//! a change and only its undo command takes one off, and no model route, agent step, task ledger,
//! copy for other AI apps or Siri, notice, timer or responsibility can reach any of it.
use std::collections::{BTreeMap, BTreeSet};

/// Every path a file names outside its `tests` module, imports flattened (`use … as`, groups,
/// globs) and each later path put back to what it was imported as; every macro with its tokens; and
/// every method call with the function it is made in.
#[derive(Default)]
struct Named {
    within: Vec<String>,
    aliases: BTreeMap<String, String>,
    raw: Vec<(Option<String>, String)>,
    uses: Vec<String>,
    macros: Vec<(String, String)>,
    calls: Vec<(Option<String>, String)>,
}
impl Named {
    fn flatten(&mut self, tree: &syn::UseTree, prefix: &str) {
        match tree {
            syn::UseTree::Path(p) => self.flatten(&p.tree, &format!("{prefix}{}::", p.ident)),
            syn::UseTree::Name(n) => {
                let path = if n.ident == "self" {
                    prefix.trim_end_matches("::").to_owned()
                } else {
                    format!("{prefix}{}", n.ident)
                };
                let alias = path.rsplit("::").next().unwrap_or_default().to_owned();
                self.aliases.insert(alias, path.clone());
                self.uses.push(path);
            }
            syn::UseTree::Rename(r) => {
                let path = format!("{prefix}{}", r.ident);
                self.aliases.insert(r.rename.to_string(), path.clone());
                self.uses.push(path);
            }
            syn::UseTree::Glob(_) => self.uses.push(format!("{prefix}*")),
            syn::UseTree::Group(g) => g.items.iter().for_each(|t| self.flatten(t, prefix)),
        }
    }
    fn paths(&self) -> Vec<(Option<String>, String)> {
        let mut all: Vec<(Option<String>, String)> =
            self.uses.iter().map(|u| (None, u.clone())).collect();
        for (within, path) in &self.raw {
            let (first, rest) = path.split_once("::").unwrap_or((path, ""));
            let full = match self.aliases.get(first) {
                Some(original) if rest.is_empty() => original.clone(),
                Some(original) => format!("{original}::{rest}"),
                None => path.clone(),
            };
            all.push((within.clone(), full));
        }
        all
    }
}
impl<'a> syn::visit::Visit<'a> for Named {
    fn visit_item_mod(&mut self, m: &'a syn::ItemMod) {
        if m.ident != "tests" {
            syn::visit::visit_item_mod(self, m);
        }
    }
    fn visit_item_fn(&mut self, f: &'a syn::ItemFn) {
        self.within.push(f.sig.ident.to_string());
        syn::visit::visit_item_fn(self, f);
        self.within.pop();
    }
    fn visit_item_use(&mut self, u: &'a syn::ItemUse) {
        self.flatten(&u.tree, "");
    }
    fn visit_path(&mut self, p: &'a syn::Path) {
        let joined: Vec<String> = p.segments.iter().map(|s| s.ident.to_string()).collect();
        self.raw
            .push((self.within.last().cloned(), joined.join("::")));
        syn::visit::visit_path(self, p);
    }
    fn visit_macro(&mut self, m: &'a syn::Macro) {
        let name: Vec<String> = m
            .path
            .segments
            .iter()
            .map(|s| s.ident.to_string())
            .collect();
        self.macros.push((
            name.join("::"),
            m.tokens.to_string().split_whitespace().collect(),
        ));
        syn::visit::visit_macro(self, m);
    }
    fn visit_expr_method_call(&mut self, call: &'a syn::ExprMethodCall) {
        self.calls
            .push((self.within.last().cloned(), call.method.to_string()));
        syn::visit::visit_expr_method_call(self, call);
    }
}
fn named(source: &str) -> Named {
    use syn::visit::Visit as _;
    let mut named = Named::default();
    named.visit_file(&syn::parse_file(source).expect("parses"));
    named
}
fn reaches_change(path: &str) -> bool {
    let segments: Vec<&str> = path.split("::").collect();
    matches!(
        segments.as_slice(),
        ["ozzie_native_auth", "change", ..] | ["", "ozzie_native_auth", "change", ..]
    ) || segments == ["ozzie_native_auth", "*"]
}
fn sources() -> Vec<(String, String)> {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files: Vec<(String, String)> = std::fs::read_dir(&root)
        .unwrap()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|e| e == "rs"))
        .map(|path| {
            (
                path.file_name().unwrap().to_string_lossy().into_owned(),
                std::fs::read_to_string(&path).unwrap(),
            )
        })
        .collect();
    files.sort();
    files
}
/// The commands this file registers, in order.
const COMMANDS: [&str; 6] = [
    "changes_status",
    "changes_set",
    "change_prepare",
    "change_confirm",
    "change_undo",
    "change_history",
];

#[test]
fn only_this_file_reaches_a_change_and_only_main_registers_it() {
    let files = sources();
    for name in [
        "always_on.rs",
        "shortcuts.rs",
        "phone_notice.rs",
        "share_bundle.rs",
        "local_tools.rs",
        "main.rs",
    ] {
        assert!(files.iter().any(|(n, _)| n == name), "{name}");
    }
    let mut reaching = Vec::new();
    for (file, source) in &files {
        if file == "changes_tests.rs" {
            continue;
        }
        let found = named(source);
        if found.paths().iter().any(|(_, p)| reaches_change(p))
            || found
                .macros
                .iter()
                .any(|(_, tokens)| tokens.contains("ozzie_native_auth::change"))
        {
            reaching.push(file.clone());
        }
        if file != "changes.rs" && file != "main.rs" {
            // Nothing else names this file, its commands or what core holds for a change.
            for (_, path) in found.paths() {
                assert!(
                    !path.split("::").any(|s| s == "changes"),
                    "{file} reaches {path}"
                );
            }
            for token in [
                "carry_out",
                "change_confirm",
                "change_prepare",
                "change_undo",
                "changes_set",
                "ChangeSwitch",
                "DespiteTheAdvice",
                "ChangesState",
            ] {
                assert!(!source.contains(token), "{file} names {token}");
            }
        }
    }
    assert_eq!(reaching, ["changes.rs"]);

    // main.rs: holds the state, sets the log up, tells it of each check and of a church left, and
    // registers exactly the six commands; nothing else of this file.
    let main = named(include_str!("main.rs"));
    let mut from_here: BTreeSet<String> = main
        .paths()
        .into_iter()
        .map(|(_, p)| p)
        // A path into this file (`changes::…`); the local `changes` handle is not one.
        .filter(|p| p.starts_with("changes::"))
        .collect();
    let handler = main
        .macros
        .iter()
        .find(|(name, _)| name == "tauri::generate_handler")
        .map(|(_, tokens)| tokens.clone())
        .expect("main.rs registers its commands");
    let registered: Vec<&str> = handler
        .split(',')
        .filter_map(|c| c.strip_prefix("changes::"))
        .collect();
    assert_eq!(registered, COMMANDS);
    for command in COMMANDS {
        from_here.insert(format!("changes::{command}"));
    }
    assert_eq!(
        from_here,
        BTreeSet::from(
            [
                "changes::ChangesState",
                "changes::checked",
                "changes::left",
                "changes::setup",
                "changes::state",
                "changes::changes_status",
                "changes::changes_set",
                "changes::change_prepare",
                "changes::change_confirm",
                "changes::change_undo",
                "changes::change_history",
            ]
            .map(str::to_owned)
        )
    );
    // Told of every check shown (live or a recording), and of a church left on Disconnect or a switch.
    let source = include_str!("main.rs");
    assert_eq!(
        source
            .matches("changes::checked(&changes, &capture);")
            .count(),
        2
    );
    assert_eq!(source.matches("changes::left(").count(), 2);
}

#[test]
fn only_the_confirm_command_makes_a_change_and_only_undo_takes_one_off() {
    let source = include_str!("changes.rs");
    let source = &source[..source.find("#[cfg(test)]\n#[path").unwrap()];
    let here = named(source);
    let within = |method: &str| -> BTreeSet<Option<String>> {
        here.calls
            .iter()
            .filter(|(_, m)| m == method)
            .map(|(w, _)| w.clone())
            .collect()
    };
    assert_eq!(
        within("carry_out"),
        BTreeSet::from([Some("change_confirm".to_owned())])
    );
    assert_eq!(
        within("undo"),
        BTreeSet::from([Some("change_undo".to_owned())])
    );
    assert_eq!(
        within("prepare"),
        BTreeSet::from([Some("change_prepare".to_owned())])
    );
    // The leader's yes is made only by the two commands a person's click reaches; the separate choice
    // to go ahead despite advice only by the confirm command, from its own argument.
    let made = |name: &str| -> BTreeSet<Option<String>> {
        here.paths()
            .into_iter()
            .filter(|(_, p)| p.ends_with(name))
            .map(|(w, _)| w)
            .collect()
    };
    assert_eq!(
        made("Confirmation::OnScreen"),
        BTreeSet::from([
            Some("change_confirm".to_owned()),
            Some("change_undo".to_owned())
        ])
    );
    // Made only by `despite_from`, from the confirm command's own argument, and only there.
    assert_eq!(
        made("DespiteTheAdvice::about"),
        BTreeSet::from([Some("despite_from".to_owned())])
    );
    assert_eq!(
        made("despite_from"),
        BTreeSet::from([Some("change_confirm".to_owned())])
    );
    // Every change reads and writes through the session's connection renewed first; the connection as
    // it is serves only to name the church in use.
    assert_eq!(
        made("crate::renewed_auth"),
        BTreeSet::from([
            Some("change_prepare".to_owned()),
            Some("change_confirm".to_owned()),
            Some("change_undo".to_owned())
        ])
    );
    assert_eq!(
        made("crate::session_auth"),
        BTreeSet::from([Some("in_use".to_owned())])
    );
    // Nothing of a model, the agent, the task ledger, Ozzie managed, the copies for other AI apps or
    // Siri, notices, the timer or responsibilities; no file of its own but core's, no process, output
    // or log.
    for (_, path) in here.paths() {
        for banned in [
            "model",
            "agent",
            "ledger",
            "hosted",
            "shared_check",
            "shortcuts",
            "phone_notice",
            "name_guard",
            "notification",
            "always_on",
            "responsibilit",
            "background",
            "Emitter",
            "process",
            "env",
            "net",
            "fs",
            "io",
        ] {
            assert!(
                !path
                    .split("::")
                    .any(|s| s == banned || (banned == "responsibilit" && s.starts_with(banned))),
                "changes.rs reaches {path}"
            );
        }
        if let Some(rest) = path.strip_prefix("ozzie_native_auth::") {
            // And the card lookups' state, only to wait for one holding the connection's turn and to keep
            // lookups off it until the change is done (privacy reviews L3, L-b; card_names.rs checks that
            // nothing else of it is used here).
            assert!(
                rest.starts_with("change::")
                    || rest == "oauth::numeric_id"
                    || rest == "sunday_check::SundayCapture"
                    || rest == "card_lookup::CHANGE_WAITS"
                    || rest == "card_lookup::CardLookups"
                    || rest == "card_lookup::ChangePending",
                "changes.rs reaches {path}"
            );
        }
        if let Some(rest) = path.strip_prefix("crate::") {
            assert!(
                [
                    "Consumer",
                    "SundayChecks",
                    "session_auth",
                    "renewed_auth",
                    "bound_church",
                    // Whether B1 Church or Breeze is the church's system: the Keychain's attributes only.
                    "church_systems::service_system_saved"
                ]
                .contains(&rest),
                "changes.rs reaches {path}"
            );
        }
    }
    for (name, tokens) in &here.macros {
        let short = name.rsplit("::").next().unwrap_or_default();
        assert!(
            ![
                "print",
                "println",
                "eprint",
                "eprintln",
                "dbg",
                "write",
                "writeln",
                "panic",
                "assert",
                "assert_eq",
                "unreachable",
                "todo",
                "unimplemented",
                "emit"
            ]
            .contains(&short),
            "changes.rs uses {name}!"
        );
        assert!(!tokens.contains(":?"), "changes.rs formats a value");
    }
    for (within, method) in &here.calls {
        assert!(
            ![
                "unwrap",
                "expect",
                "unwrap_err",
                "expect_err",
                "emit",
                "emit_to"
            ]
            .contains(&method.as_str()),
            "changes.rs calls {method} in {within:?}"
        );
    }
    assert!(!source.contains("unsafe"));
    // The six commands are this file's and no others.
    let commands: Vec<String> = syn::parse_file(source)
        .unwrap()
        .items
        .iter()
        .filter_map(|item| match item {
            syn::Item::Fn(f)
                if f.attrs
                    .iter()
                    .any(|a| a.path().segments.iter().any(|s| s.ident == "command")) =>
            {
                Some(f.sig.ident.to_string())
            }
            _ => None,
        })
        .collect();
    assert_eq!(commands, COMMANDS);
    // The reader catches what plain text would miss.
    let hidden = named("use ozzie_native_auth::change as c;\nfn f() { c::Changes::default(); }");
    assert!(hidden.paths().iter().any(|(_, p)| reaches_change(p)));
}

// ---- Review S (security), 2026-11-17: the commands' own behaviour ------------------------------------

use ozzie_native_auth::change::{BackgroundCheck, ChangeSwitch, Changes, DespiteTheAdvice};

struct Scratch(std::path::PathBuf);
impl Scratch {
    fn new(name: &str) -> Self {
        let tag = format!(
            "{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let dir = std::env::temp_dir().join(format!("ozzie-changes-{name}-{tag}"));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// D3: the go-ahead despite advice comes only from the page's own argument for it, never by default.
#[test]
fn the_go_ahead_despite_advice_is_never_made_up() {
    assert_eq!(super::despite_from(None), None);
    for text in [
        "",
        "yes",
        "true",
        "None-On-File",
        "current ",
        "none_on_file",
    ] {
        assert_eq!(super::despite_from(Some(text)), None, "{text:?}");
    }
    assert_eq!(
        super::despite_from(Some("none-on-file")),
        Some(DespiteTheAdvice::about(BackgroundCheck::NoneOnFile))
    );
}

/// D4 and M2: leaving a church turns changes off for that church (and only that one), whatever state
/// its sign-in was in; with no church named, everything waiting is still dropped.
#[test]
fn leaving_a_church_turns_its_changes_off() {
    let dir = Scratch::new("left");
    let switch = ChangeSwitch::at(&dir.0);
    switch.set("1001", true).unwrap();
    switch.set("1002", true).unwrap();
    let changes = Changes::default();
    super::left_in(Some(&dir.0), &changes, Some("1001"));
    assert!(!switch.is_on("1001"));
    assert!(switch.is_on("1002"));
    super::left_in(Some(&dir.0), &changes, None);
    assert!(switch.is_on("1002"));
    super::left_in(None, &changes, Some("1002"));
    assert!(switch.is_on("1002"));
    // main.rs takes the church left from the sign-in's binding, whatever its state, never only a
    // connected one (`session_auth`).
    let main = include_str!("main.rs");
    let command = &main[main.find("async fn disconnect_planning_center").unwrap()..];
    let command = &command[..command.find("\n}\n").unwrap()];
    assert!(
        command.contains(
            "disconnect_and_leave(&consumer, |left| changes::left(&app, &changes, left))"
        )
    );
    // The church is read from the binding (main.rs tests every state, and every way Disconnect fails).
    let disconnect = &main[main.find("fn disconnect_and_leave").unwrap()..];
    let disconnect = &disconnect[..disconnect.find("\n}\n").unwrap()];
    assert!(disconnect.contains("let left = bound_church(consumer);"));
    assert!(!disconnect.contains("session_auth"));
    let switch_answer = &main[main.find("async fn answer_church_switch").unwrap()..];
    let switch_answer = &switch_answer[..switch_answer.find("\n}\n").unwrap()];
    assert!(switch_answer.contains("let before = bound_church(&consumer);"));
    assert!(switch_answer.contains("let after = bound_church(&consumer);"));
    assert!(!switch_answer.contains("session_auth"));
    let bound = &main[main.find("fn bound_church").unwrap()..];
    let bound = &bound[..bound.find("\n}\n").unwrap()];
    assert!(!bound.contains("ConnectionState") && !bound.contains("status"));
}

/// D6 and L5: turning changes off goes through core's `turn` (which drops what waits; core tests it),
/// and every command that could renew, take the turn or read asks the switch for the session's church
/// first.
#[test]
fn the_switch_is_asked_first_and_turning_it_off_goes_through_core() {
    let source = include_str!("changes.rs");
    let body = |name: &str| {
        let at = source.find(&format!("async fn {name}(")).unwrap();
        let rest = &source[at..];
        rest[..rest.find("\n}\n").unwrap()].to_owned()
    };
    assert!(body("changes_set").contains(".turn(&switch, &organization, on)"));
    assert!(!body("changes_set").contains(".set(&organization"));
    for (command, call) in [
        ("change_prepare", "changes.prepare("),
        ("change_confirm", "changes.carry_out("),
        ("change_undo", "changes.undo("),
    ] {
        let text = body(command);
        let asked = text.find("gate_for_session(&app, &consumer)").unwrap();
        assert!(asked < text.find(call).unwrap(), "{command}");
        assert!(asked < text.find("renewed_auth").unwrap(), "{command}");
    }
    // The gate asks whether another system is the church's (the Keychain's attributes), then the switch.
    let gate = &source[source.find("fn gate_for_session(").unwrap()..];
    let gate = &gate[..gate.find("\n}\n").unwrap()];
    assert!(gate.contains("other_system_in_use()"));
    assert!(gate.contains("crate::bound_church(consumer)"));
    // Status says off, and the switch can't be turned on, while another system is the church's.
    assert!(body("changes_status").contains("other_system_in_use()"));
    let set = body("changes_set");
    assert!(set.find("if on && other_system_in_use()").unwrap() < set.find(".turn(").unwrap());
}

// ---- Planning Center only (owner decision 2026-11-21) ------------------------------------------------

/// A church on B1 Church or Breeze (a key for one saved on this Mac) never gets a change in Planning Center,
/// whatever the page sends and whatever the switch file says: the gate refuses first, the switch shows off, and
/// it can't be turned on. With no other system, the switch decides as before.
#[test]
fn another_church_system_refuses_every_change_before_the_switch() {
    let dir = Scratch::new("other-system");
    let switch = ozzie_native_auth::change::ChangeSwitch::at(&dir.0);
    switch.set("1001", true).unwrap();
    let church = || Some("1001".to_owned());
    let at = || Some(ozzie_native_auth::change::ChangeSwitch::at(&dir.0));
    assert!(matches!(
        super::gate(true, church(), at()),
        Err(ozzie_native_auth::change::Refusal::OtherSystem)
    ));
    assert!(super::gate(false, church(), at()).is_ok());
    assert!(matches!(
        super::gate(false, None, at()),
        Err(ozzie_native_auth::change::Refusal::Off)
    ));
    assert!(matches!(
        super::gate(false, Some("2002".to_owned()), at()),
        Err(ozzie_native_auth::change::Refusal::Off)
    ));
    assert!(!super::shown_on(true, Some("1001"), Some(&switch)));
    assert!(super::shown_on(false, Some("1001"), Some(&switch)));
    assert!(!super::shown_on(false, None, Some(&switch)));
}

/// Which keys count as another system: B1 Church or Breeze (never Genesis, which can be "also read" beside
/// Planning Center), from the Keychain's attributes; a listing that fails counts as one saved.
#[test]
fn a_b1_or_breeze_key_counts_as_another_system_and_a_failed_listing_too() {
    use ozzie_church_systems::capture::System;
    use ozzie_native_auth::credentials::{CredentialStore, StoreError};
    struct Listed(Result<Vec<(String, String)>, StoreError>);
    impl CredentialStore for Listed {
        fn put(&self, _: &str, _: &str, _: &[u8]) -> Result<(), StoreError> {
            Err(StoreError::Unavailable)
        }
        fn get(&self, _: &str, _: &str) -> Result<Option<Vec<u8>>, StoreError> {
            Err(StoreError::Unavailable)
        }
        fn delete(&self, _: &str, _: &str) -> Result<(), StoreError> {
            Err(StoreError::Unavailable)
        }
        fn accounts(&self) -> Result<Vec<(String, String)>, StoreError> {
            match &self.0 {
                Ok(list) => Ok(list.clone()),
                Err(_) => Err(StoreError::Unavailable),
            }
        }
    }
    let workspace = ozzie_church_systems::keys::WORKSPACE.to_owned();
    let key = |church: &str| Ok(vec![(workspace.clone(), church.to_owned())]);
    let none = || Ok(Vec::new());
    let saved = |lists: &dyn Fn(System) -> Result<Vec<(String, String)>, StoreError>| {
        crate::church_systems::service_system_saved_in(&|system| {
            Box::new(Listed(lists(system))) as Box<dyn CredentialStore>
        })
    };
    assert!(!saved(&|_| none()));
    assert!(saved(&|system| if system == System::B1 {
        key("8001")
    } else {
        none()
    }));
    assert!(saved(&|system| if system == System::Breeze {
        key("acme")
    } else {
        none()
    }));
    // Genesis alone ("also read" beside Planning Center) isn't another system for changes.
    assert!(!saved(&|system| if system == System::Genesis {
        key("9001")
    } else {
        none()
    }));
    // Ozzie can't tell: a change never goes ahead on a guess.
    assert!(saved(&|system| if system == System::Breeze {
        Err(StoreError::Unavailable)
    } else {
        none()
    }));
}

/// L6: a Sunday check waits longer for the turn than a change can hold it.
#[test]
fn a_check_outwaits_a_change() {
    assert!(crate::CHECK_WAITS_FOR_PICKER > ozzie_native_auth::change::LONGEST_TURN);
}

// ---- Review Y (final re-check), 2026-11-17 -----------------------------------------------------------

/// M-Y1: What happened's list is the bound church's whatever state its sign-in is in (`bound_church`, which
/// main.rs's renewal tests cover in every state), and with no church it is an error, never an empty list.
#[test]
fn what_happened_lists_the_bound_church_and_never_an_empty_list_for_no_church() {
    let dir = Scratch::new("history");
    assert!(matches!(
        super::history_in(Some(&dir.0), None, 50),
        Err(super::SwitchError::NotConnected)
    ));
    assert!(matches!(
        super::history_in(None, Some("1001"), 50),
        Err(super::SwitchError::Unavailable)
    ));
    assert_eq!(
        super::history_in(Some(&dir.0), Some("1001"), 50)
            .unwrap()
            .len(),
        0
    );
    let source = include_str!("changes.rs");
    let at = source.find("async fn change_history(").unwrap();
    let body = &source[at..];
    let body = &body[..body.find("\n}\n").unwrap()];
    assert!(body.contains("crate::bound_church(&consumer)"));
    assert!(!body.contains("in_use(") && !body.contains("session_auth"));
}
