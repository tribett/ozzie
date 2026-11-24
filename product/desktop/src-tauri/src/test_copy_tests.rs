//! The test copy of Ozzie is a build variant that is off unless asked for: these hold the real app's identity, names
//! and paths to what they are, the test copy's to its own, and the release script to the real app.
use super::*;
use ozzie_church_systems::capture::System;
use ozzie_native_auth::variant::{
    REAL_APP_IDENTIFIER, REAL_SERVICES, TEST_COPY_APP_IDENTIFIER, TEST_COPY_KEYCHAIN_PREFIX,
};
use serde_json::{Value, json};

fn file(name: &str) -> String {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(name);
    std::fs::read_to_string(&path).unwrap_or_else(|_| panic!("{}", path.display()))
}
fn json_file(name: &str) -> Value {
    serde_json::from_str(&file(name)).unwrap()
}
/// RFC 7396 merge patch, as the tauri CLI applies `--config` over tauri.conf.json.
fn merge(base: &mut Value, patch: &Value) {
    match patch {
        Value::Object(fields) => {
            if !base.is_object() {
                *base = json!({});
            }
            let target = base.as_object_mut().unwrap();
            for (key, value) in fields {
                if value.is_null() {
                    target.remove(key);
                } else {
                    merge(target.entry(key.clone()).or_insert(Value::Null), value);
                }
            }
        }
        other => *base = other.clone(),
    }
}
/// Every Keychain service the app uses, as this build names them, in `REAL_SERVICES`' order.
fn app_services() -> Vec<&'static str> {
    let mut all = ozzie_native_auth::variant::this_builds_services().to_vec();
    for system in [System::B1, System::Breeze, System::Genesis] {
        all.push(ozzie_church_systems::keys::service(system));
    }
    all
}
/// `key`'s string in a plist written as Info.plist is (one `<key>` line, its `<string>` on the next).
fn plist_string(plist: &str, key: &str) -> Option<String> {
    let mut lines = plist
        .lines()
        .skip_while(|l| l.trim() != format!("<key>{key}</key>"));
    lines.next()?;
    let value = lines.next()?.trim();
    Some(
        value
            .strip_prefix("<string>")?
            .strip_suffix("</string>")?
            .to_owned(),
    )
}

#[test]
fn the_default_build_is_the_real_app_with_every_real_name() {
    if cfg!(feature = "test-copy") {
        return;
    }
    assert_eq!(
        ozzie_native_auth::variant::APP_IDENTIFIER,
        "church.ozzie.desktop"
    );
    assert_eq!(app_services(), REAL_SERVICES);
    assert_eq!(crate::always_on::LAUNCH_AGENT_LABEL, "church.ozzie.desktop");
    // What the release builds from: the real identity, name, title, updater, helpers, Siri actions, icon and links.
    let conf = json_file("tauri.conf.json");
    assert_eq!(conf["identifier"], json!(REAL_APP_IDENTIFIER));
    assert_eq!(conf["productName"], json!("Ozzie"));
    assert_eq!(
        conf["app"]["windows"][0]["title"],
        json!("Ozzie by FlockConnect")
    );
    assert_eq!(
        conf["plugins"]["updater"]["endpoints"],
        json!(["https://github.com/tribett/ozzie/releases/latest/download/latest.json"])
    );
    assert!(
        conf["bundle"]["externalBin"]
            .as_array()
            .unwrap()
            .iter()
            .all(|bin| bin.as_str().unwrap().starts_with("binaries/ozzie-"))
    );
    assert_eq!(
        conf["bundle"]["macOS"]["files"],
        json!({"Extensions/OzzieIntents.appex": "binaries/OzzieIntents.appex"})
    );
    assert_eq!(conf["bundle"]["icon"], json!(["icons/icon.png"]));
    assert!(conf["bundle"]["macOS"].get("infoPlist").is_none());
    assert!(file("Info.plist").contains("<string>ozzie</string>"));
    assert!(
        !file("tauri.conf.json").contains("test-copy")
            && !file("tauri.conf.json").contains(".test")
    );
}

#[test]
fn the_test_copy_has_its_own_name_for_every_keychain_service_and_none_is_real() {
    let names = app_services();
    assert_eq!(names.len(), REAL_SERVICES.len());
    for (name, real) in names.iter().zip(REAL_SERVICES) {
        let test = ozzie_native_auth::variant::test_copy_service(real).unwrap();
        assert!(!REAL_SERVICES.contains(&test.as_str()));
        assert_ne!(test, real);
        if ozzie_native_auth::variant::IS_TEST_COPY {
            assert_eq!(*name, test, "{real}");
            assert!(!REAL_SERVICES.contains(name));
        } else {
            assert_eq!(*name, real);
        }
    }
    if ozzie_native_auth::variant::IS_TEST_COPY {
        assert_eq!(
            ozzie_native_auth::variant::APP_IDENTIFIER,
            TEST_COPY_APP_IDENTIFIER
        );
        assert_eq!(
            crate::always_on::LAUNCH_AGENT_LABEL,
            TEST_COPY_APP_IDENTIFIER
        );
    }
}

#[test]
fn every_keychain_service_in_the_app_comes_from_the_variant() {
    // A Keychain name written out in the app would be the real app's in the test copy as well. Comments and tests don't
    // count (a test writes the names out to hold them), nor does variant_guard.rs, which names the test copy's
    // identifier for build.rs and is no part of the app.
    let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut bare = Vec::new();
    for entry in std::fs::read_dir(&src).unwrap() {
        let path = entry.unwrap().path();
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        if !name.ends_with(".rs") || name.ends_with("_tests.rs") || name == "variant_guard.rs" {
            continue;
        }
        let text = std::fs::read_to_string(&path).unwrap();
        // The app's own code: everything before the file's test module.
        let app = text
            .split("#[cfg(test)]\nmod tests")
            .next()
            .unwrap_or_default();
        for line in app.lines() {
            let code = line.split("//").next().unwrap_or("");
            if code.contains("\"church.ozzie.") && !code.contains("keychain_service!(") {
                bare.push(format!("{name}: {}", line.trim()));
            }
        }
    }
    assert!(bare.is_empty(), "{bare:#?}");
    // Every Keychain the app opens is named by a constant: never `MacKeychain { service: "…" }`.
    let needle = ["MacKeychain{", "service:\""].concat();
    let mut opened = 0;
    for entry in std::fs::read_dir(&src).unwrap() {
        let path = entry.unwrap().path();
        if path.to_string_lossy().ends_with("_tests.rs") {
            continue;
        }
        let text = std::fs::read_to_string(&path).unwrap();
        let squeezed: String = text.split_whitespace().collect();
        assert!(!squeezed.contains(&needle), "{}", path.display());
        opened += squeezed.matches("MacKeychain{service:").count();
    }
    // main.rs (Planning Center), calendars.rs, phone_notice.rs and church_sources.rs; church_systems.rs through keys.rs.
    assert_eq!(opened, 4);
}

#[test]
fn the_overlay_makes_the_test_copy_and_nothing_else() {
    let overlay = json_file("tauri.test-copy.conf.json");
    // Only these: who it is, its updater taken away, and what it bundles.
    let mut keys: Vec<&str> = overlay
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(keys, ["bundle", "identifier", "plugins", "productName"]);
    assert_eq!(overlay["identifier"], json!(TEST_COPY_APP_IDENTIFIER));
    assert_eq!(overlay["productName"], json!("Ozzie Test"));
    assert_eq!(overlay["plugins"], json!({"updater": null}));
    let mut merged = json_file("tauri.conf.json");
    merge(&mut merged, &overlay);
    assert_eq!(merged["identifier"], json!("church.ozzie.desktop.test"));
    assert_ne!(merged["identifier"], json!(REAL_APP_IDENTIFIER));
    assert!(merged["plugins"].get("updater").is_none());
    assert!(
        merged["bundle"]["macOS"].get("files").is_none(),
        "no Siri actions"
    );
    assert_eq!(
        merged["bundle"]["macOS"]["infoPlist"],
        json!("Info-test-copy.plist")
    );
    assert_eq!(
        merged["bundle"]["icon"],
        json!(["icons/icon-test-copy.png"])
    );
    assert_eq!(merged["bundle"]["createUpdaterArtifacts"], json!(false));
    // The same helpers as the real app, each built for the test copy into its own folder (build.rs TEST_COPY_HELPERS).
    let base = json_file("tauri.conf.json");
    let real: Vec<&str> = base["bundle"]["externalBin"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| b.as_str().unwrap())
        .collect();
    let test: Vec<&str> = merged["bundle"]["externalBin"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| b.as_str().unwrap())
        .collect();
    assert_eq!(
        test,
        real.iter()
            .map(|b| b.replacen("binaries/", "binaries/test-copy/", 1))
            .collect::<Vec<_>>()
    );
    assert!(file("build.rs").contains("const TEST_COPY_HELPERS: &str = \"binaries/test-copy\";"));
    // Everything else is the real app's own settings (window, security, minimum macOS, entitlements).
    for path in [
        &["app"][..],
        &["build"],
        &["version"],
        &["bundle", "macOS", "minimumSystemVersion"],
        &["bundle", "macOS", "entitlements"],
        &["bundle", "targets"],
    ] {
        let at = |v: &Value| path.iter().fold(v.clone(), |v, k| v[*k].clone());
        assert_eq!(at(&merged), at(&base), "{path:?}");
    }
    // The icon carries a badge, and is not the real one.
    assert_ne!(
        std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("icons/icon-test-copy.png")
        )
        .unwrap(),
        std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("icons/icon.png"))
            .unwrap()
    );
}

#[test]
fn no_config_the_cli_reads_by_itself_can_turn_the_release_into_the_test_copy() {
    // The tauri CLI merges a platform file (tauri.macos.conf.json and kin) into every build on its own; the test copy's
    // overlay has another name, so only `--config` brings it in.
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    for name in [
        "tauri.macos.conf.json",
        "tauri.macos.conf.json5",
        "Tauri.macos.toml",
        "tauri.conf.json5",
        "Tauri.toml",
    ] {
        assert!(!dir.join(name).exists(), "{name}");
    }
    // The desktop's default features never include the test copy.
    let cargo = file("Cargo.toml");
    let default = cargo.lines().find(|l| l.starts_with("default = ")).unwrap();
    assert_eq!(default, "default = [\"custom-protocol\"]");
    assert!(cargo.contains(
        "test-copy = [\"ozzie-native-auth/test-copy\", \"ozzie-church-systems/test-copy\"]"
    ));
}

#[test]
fn the_release_script_can_only_build_the_real_app() {
    // The public copy has no tools/ (tools/public-export): there is no release script there to hold.
    let path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../tools/release-mac.sh");
    let Ok(release) = std::fs::read_to_string(path) else {
        return;
    };
    let code: String = release
        .lines()
        .filter(|l| !l.trim_start().starts_with('#'))
        .collect::<Vec<_>>()
        .join("\n");
    // No features, no extra config, nothing of the test copy's.
    for word in [
        "--features",
        "-F ",
        "--config",
        "test-copy",
        "TEST_COPY",
        "Ozzie Test",
    ] {
        assert!(!code.contains(word), "{word}");
    }
    assert!(code.contains("npx tauri build --bundles app)"));
    // Nothing from the shell can add settings to tauri.conf.json (tauri's build merges TAURI_CONFIG when set).
    let unset = code.find("unset TAURI_CONFIG").expect("TAURI_CONFIG unset");
    assert!(unset < code.find("npx tauri build").unwrap());
    // And it stops, before signing anything, unless the app it built is the real one.
    let guard = code
        .find("== real app, not the test copy")
        .expect("the release's own check");
    let sign = code.find("== helpers signed again").unwrap();
    assert!(guard < sign);
    for check in [
        "Print :CFBundleIdentifier",
        "church.ozzie.desktop",
        "Print :CFBundleName",
        "CFBundleURLSchemes:0",
        // No Keychain name of the test copy's in the app's own program, and no test copy data folder in a helper.
        "! grep -qaF \"church.ozzie.desktop.test/church.ozzie.\" \"$APP/Contents/MacOS/ozzie-desktop\"",
        "for helper in ozzie-calendar ozzie-card-reader ozzie-listen ozzie-share ozzie-shortcuts; do",
        "! grep -qaF \"church.ozzie.desktop.test\" \"$APP/Contents/MacOS/$helper\"",
    ] {
        assert!(code[guard..sign].contains(check), "{check}");
    }
}

#[test]
fn the_test_copy_plist_keeps_the_privacy_words_and_has_no_links() {
    let real = file("Info.plist");
    let test = file("Info-test-copy.plist");
    for key in [
        "NSCalendarsFullAccessUsageDescription",
        "NSMicrophoneUsageDescription",
        "NSSpeechRecognitionUsageDescription",
    ] {
        assert_eq!(plist_string(&test, key), plist_string(&real, key), "{key}");
        assert!(plist_string(&real, key).is_some());
    }
    // An empty list of links and of other names, whichever way the CLI combines it with Info.plist.
    assert!(test.contains("<key>CFBundleURLTypes</key>\n\t<array/>"));
    // (The other names' key is written in parts: draft_apps.rs's scan refuses its word outside that file.)
    let other_names = ["<key>INAlternativeApp", "Names</key>\n\t<array/>"].concat();
    assert!(test.contains(&other_names));
    assert!(
        !test.contains("<string>ozzie</string>") && !test.contains("church.ozzie.desktop.pages")
    );
}

#[test]
fn the_test_copys_helpers_read_its_own_data_folder_and_the_real_ones_the_real_one() {
    // Each data-folder path in a helper is written twice: the test copy's under `#if OZZIE_TEST_COPY`, the real app's
    // under `#else`. Never one for both.
    for helper in ["helpers/share.swift", "helpers/shortcuts-answer.swift"] {
        let text = file(helper);
        let start = text.find("#if OZZIE_TEST_COPY").expect(helper);
        let middle = text[start..].find("#else").unwrap() + start;
        let end = text[middle..].find("#endif").unwrap() + middle;
        let test = &text[start..middle];
        let real = &text[middle..end];
        assert!(
            test.contains(&format!(
                "Library/Application Support/{TEST_COPY_APP_IDENTIFIER}"
            )),
            "{helper}"
        );
        assert!(
            !test.contains("Application Support/church.ozzie.desktop/")
                && !test.contains("church.ozzie.desktop\")")
        );
        assert!(
            real.contains(&format!(
                "Library/Application Support/{REAL_APP_IDENTIFIER}"
            )),
            "{helper}"
        );
        assert!(!real.contains(TEST_COPY_APP_IDENTIFIER));
        assert_eq!(text.matches("Application Support/").count(), 2, "{helper}");
    }
    let build = file("build.rs");
    assert!(build.contains("swiftc.args([\"-D\", \"OZZIE_TEST_COPY\"]);"));
    // The Siri actions keep the real app's paths and are never built for the test copy.
    assert!(
        file("Entitlements-intents.plist")
            .contains("/Library/Application Support/church.ozzie.desktop/")
    );
    assert!(!file("Entitlements-intents.plist").contains(TEST_COPY_APP_IDENTIFIER));
}

#[test]
fn the_page_marker_is_fixed_and_carries_only_the_prefix() {
    let script = init_script();
    assert_eq!(
        script,
        "Object.defineProperty(window, \"__OZZIE_TEST_COPY__\", { value: Object.freeze({ keychainPrefix: \"church.ozzie.desktop.test/\" }), writable: false, configurable: false, enumerable: false });"
    );
    assert!(script.contains(TEST_COPY_KEYCHAIN_PREFIX));
    assert_eq!(PAGE_MARKER, "__OZZIE_TEST_COPY__");
    assert_eq!(WINDOW_TITLE, "Ozzie TEST COPY");
}

#[test]
fn what_the_test_copy_never_does_is_stopped_where_it_starts() {
    // Each of these returns before anything else when this build is the test copy.
    let guard = "if ozzie_native_auth::variant::IS_TEST_COPY {";
    let starts = |source: &str, function: &str| {
        let text = file(source);
        let at = text
            .find(function)
            .unwrap_or_else(|| panic!("{source}: {function}"));
        let body = &text[at..];
        let open = body.find('{').unwrap();
        let first = body[open + 1..].trim_start();
        // Skipping a `use` line or a comment, the guard comes first.
        let first = first
            .lines()
            .map(str::trim)
            .find(|l| !l.starts_with("use ") && !l.starts_with("//") && !l.starts_with("static "))
            .unwrap();
        assert_eq!(first, guard, "{source}: {function}");
    };
    // No Planning Center sign-in: nothing listens on the real app's redirect, no browser opens.
    starts("src/main.rs", "fn sign_in(");
    starts("src/main.rs", "fn app_client_id(");
    // No updater.
    starts("src/updater.rs", "fn here(");
    starts(
        "src/updater.rs",
        "async fn check(app: tauri::AppHandle, manual: bool)",
    );
    starts("src/updater.rs", "pub fn on_wake(");
    starts("src/updater.rs", "pub fn manage(");
    // No notice to a phone.
    starts("src/phone_notice.rs", "fn phone(app: &tauri::AppHandle)");
    // No login item.
    starts("src/always_on.rs", "pub fn autostart_get(");
    starts("src/always_on.rs", "pub fn autostart_set(");
    // No "Add Ozzie to Claude".
    starts("src/share_bundle.rs", "pub async fn add_to_claude(");
    // The login item's plugin is never added to the test copy, and the saved test key is only for it.
    assert!(file("src/always_on.rs").contains(
        "let builder = if ozzie_native_auth::variant::IS_TEST_COPY {\n        builder\n    } else {"
    ));
    assert!(
        file("src/church_systems.rs")
            .contains("\"saved\" if ozzie_native_auth::variant::IS_TEST_COPY => {")
    );
    // The test copy's own pieces are added only in the test copy.
    let this = file("src/test_copy.rs");
    assert_eq!(this.matches("if !variant::IS_TEST_COPY {").count(), 2);
}

#[test]
fn a_build_is_wholly_the_real_app_or_wholly_the_test_copy() {
    use super::variant_guard::{TEST_COPY_IDENTIFIER, identifier_in_use, switches_agree};
    let base = file("tauri.conf.json");
    let overlay = file("tauri.test-copy.conf.json");
    assert_eq!(TEST_COPY_IDENTIFIER, TEST_COPY_APP_IDENTIFIER);
    // tauri.conf.json alone is the real app; with the overlay (as the CLI hands it to the build, in TAURI_CONFIG) the
    // test copy; TAURI_CONFIG without an identifier keeps tauri.conf.json's.
    assert_eq!(identifier_in_use(&base, None).unwrap(), REAL_APP_IDENTIFIER);
    assert_eq!(
        identifier_in_use(&base, Some(&overlay)).unwrap(),
        TEST_COPY_APP_IDENTIFIER
    );
    assert_eq!(
        identifier_in_use(&base, Some(r#"{"productName": "Ozzie"}"#)).unwrap(),
        REAL_APP_IDENTIFIER
    );
    // Anything that isn't a config naming an identifier is never taken as either copy.
    for bad in [
        "",
        "not json",
        "[]",
        r#"{"identifier": null}"#,
        r#"{"identifier": 7}"#,
    ] {
        assert!(identifier_in_use(&base, Some(bad)).is_err(), "{bad}");
    }
    assert!(identifier_in_use("{}", None).is_err());
    // Both switches on, or both off.
    assert_eq!(switches_agree(false, REAL_APP_IDENTIFIER), Ok(()));
    assert_eq!(switches_agree(true, TEST_COPY_APP_IDENTIFIER), Ok(()));
    // The feature without the overlay would keep the real app's data folder and web storage; the overlay without the
    // feature, the real app's Keychain names and its Planning Center sign-in.
    let feature_alone = switches_agree(true, REAL_APP_IDENTIFIER).unwrap_err();
    assert!(
        feature_alone.contains("tauri.test-copy.conf.json"),
        "{feature_alone}"
    );
    let overlay_alone = switches_agree(false, TEST_COPY_APP_IDENTIFIER).unwrap_err();
    assert!(
        overlay_alone.contains("--features test-copy"),
        "{overlay_alone}"
    );
    assert!(switches_agree(true, "church.ozzie.desktop.other").is_err());
    // build.rs checks it first, from tauri.conf.json and TAURI_CONFIG as tauri's own build reads them, and fails the build.
    let build = file("build.rs");
    let main = &build[build.find("fn main() {").unwrap()..];
    assert!(main.starts_with("fn main() {\n    variant_agrees();\n    helpers();"));
    assert!(build.contains("#[path = \"src/variant_guard.rs\"]\nmod variant_guard;"));
    let agrees = &build[build.find("fn variant_agrees() {").unwrap()..];
    for line in [
        "println!(\"cargo:rerun-if-env-changed=TAURI_CONFIG\");",
        "std::fs::read_to_string(\"tauri.conf.json\")",
        "std::env::var(\"TAURI_CONFIG\").ok()",
        "variant_guard::switches_agree(test_copy(), &identifier)",
    ] {
        assert!(agrees.contains(line), "{line}");
    }
}

#[test]
fn the_app_stops_before_any_keychain_or_file_unless_its_identifier_is_this_builds() {
    use ozzie_native_auth::variant::{APP_IDENTIFIER, IS_TEST_COPY};
    assert!(crate::identity_agrees(APP_IDENTIFIER));
    assert_eq!(crate::identity_agrees(REAL_APP_IDENTIFIER), !IS_TEST_COPY);
    assert_eq!(
        crate::identity_agrees(TEST_COPY_APP_IDENTIFIER),
        IS_TEST_COPY
    );
    assert!(!crate::identity_agrees("church.ozzie.desktop.other"));
    assert!(!crate::identity_agrees(""));
    // main() reads the identifier the build was made with first, and leaves before the Planning Center sign-ins are
    // opened (the first Keychain store) or anything else is set up.
    let main = file("src/main.rs");
    let body = &main[main.find("\nfn main() {").unwrap()..];
    assert!(body.starts_with(
        "\nfn main() {\n    let context = tauri::generate_context!();\n    if !identity_agrees(&context.config().identifier) {"
    ));
    let leave = body.find("std::process::exit(").unwrap();
    assert!(leave < body.find("Consumer::default()").unwrap());
    assert!(leave < body.find("tauri::Builder::default()").unwrap());
    assert!(body.contains(".build(context)"));
    assert_eq!(main.matches("tauri::generate_context!()").count(), 1);
}

#[test]
fn the_test_copy_is_signed_with_the_hardened_runtime_and_the_releases_entitlements() {
    // An app that macOS lets read the test keys without asking must not take code injected into it: every signature the
    // build script makes has the hardened runtime, with the release's own entitlements for each part (tools/release-mac.sh).
    // The public copy has no tools/.
    let path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../tools/build-test-copy.sh");
    let Ok(script) = std::fs::read_to_string(path) else {
        return;
    };
    let signs: Vec<&str> = script
        .lines()
        .map(str::trim)
        .filter(|l| l.starts_with("codesign --force"))
        .collect();
    assert_eq!(signs.len(), 4, "{signs:#?}");
    assert!(
        signs.iter().all(|l| l.contains("--options runtime")),
        "{signs:#?}"
    );
    assert!(script.contains(
        "for helper in ozzie-card-reader ozzie-share ozzie-shortcuts; do\n  codesign --force --options runtime --sign \"$SIGN\" --identifier \"$helper\""
    ));
    for (part, entitlements) in [
        ("--identifier \"$helper\"", None),
        (
            "--identifier ozzie-listen",
            Some("Entitlements-listen.plist"),
        ),
        (
            "--identifier ozzie-calendar",
            Some("Entitlements-calendar.plist"),
        ),
        ("--identifier \"$TEST_ID\"", Some("Entitlements.plist")),
    ] {
        let line = signs
            .iter()
            .find(|l| l.contains(part))
            .unwrap_or_else(|| panic!("{part}"));
        match entitlements {
            Some(file) => assert!(
                line.contains(&format!("--entitlements \"$TAURI/{file}\"")),
                "{line}"
            ),
            None => assert!(!line.contains("--entitlements"), "{line}"),
        }
    }
    // Each copy-to-test makes a new item that only the developer tool may read, so the doc says macOS asks again.
    let doc = "../../../docs/build/test-copy.md"; // in the private repository
    let doc = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(doc);
    let doc = std::fs::read_to_string(doc).unwrap();
    assert!(doc.contains("every `copy-to-test`"));
}

#[test]
fn what_the_public_copy_lacks_is_named_as_the_private_repositorys() {
    // docs/build/test-copy.md and tools/ are in the private repository only (tools/public-export): a public file that
    // names them says where they are, on the same line or the next.
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    // (This file names them on purpose, to look for them.)
    let mut files: Vec<std::path::PathBuf> = std::fs::read_dir(dir.join("src"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| !p.ends_with("test_copy_tests.rs"))
        .collect();
    files.extend(["build.rs", "Cargo.toml"].map(|f| dir.join(f)));
    files.push(dir.join("../../../core/native-auth/src/variant.rs"));
    let mut unnamed = Vec::new();
    for path in files {
        let text = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        for (at, line) in lines.iter().enumerate() {
            let names = ["docs/build/test-copy.md", "tools/build-test-copy.sh"]
                .iter()
                .any(|p| line.contains(p));
            let said = line.contains("private repository")
                || lines
                    .get(at + 1)
                    .is_some_and(|l| l.contains("private repository"));
            if names && !said {
                unnamed.push(format!("{}: {}", path.display(), line.trim()));
            }
        }
    }
    assert!(unnamed.is_empty(), "{unnamed:#?}");
}
