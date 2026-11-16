use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::Command;

/// The server script ozzie-share runs (`pnpm build:share`, git-ignored), so a build can't bundle
/// a helper without it or with an older copy: build:desktop and tauri's beforeBuildCommand build
/// it first, and the helper is rebuilt whenever it changes.
const SHARE_SCRIPT: &str = "../../../core/mcp/dist-share/ozzie-share.js";
/// The answers ozzie-shortcuts runs for Siri and Shortcuts (`pnpm build:shortcuts`, git-ignored),
/// held to the same rule.
const SHORTCUTS_SCRIPT: &str = "../../../core/mcp/dist-shortcuts/ozzie-shortcuts.js";
/// The answering both ozzie-shortcuts and Ozzie's Siri actions are built from.
const SHORTCUTS_ANSWER: &str = "helpers/shortcuts-answer.swift";

/// Ozzie's Siri actions (ADR 0007): an App Intents extension built with Xcode from this project
/// into this folder, which tauri.conf.json bundles as Contents/Extensions/OzzieIntents.appex.
const SIRI_ACTIONS_PROJECT: &str = "intents/OzzieIntents.xcodeproj";
const SIRI_ACTIONS: &str = "binaries/OzzieIntents.appex";
/// What the Siri actions are built from: a change to any of them builds them again.
const SIRI_ACTIONS_INPUTS: [&str; 7] = [
    SHORTCUTS_ANSWER,
    "helpers/siri-actions.swift",
    "helpers/siri-actions-extension.swift",
    "intents/Info.plist",
    "intents/OzzieIntents.xcodeproj/project.pbxproj",
    "Entitlements-intents.plist",
    SHORTCUTS_SCRIPT,
];

fn modified(path: &str) -> Option<std::time::SystemTime> {
    std::fs::metadata(path).and_then(|m| m.modified()).ok()
}

/// Ozzie's own Mac helpers (helpers/*.swift): the visitor-card reader (Apple Vision), the
/// on-device listener for spoken questions, the last check for other AI apps, the answers for Siri
/// and Shortcuts, and Apple Calendar (read-only). Built here, before tauri-build looks for them, as
/// `binaries/<name>-<target>`: tauri.conf.json bundles them beside Ozzie's program and signs them
/// with the app (hardened runtime and Entitlements.plist in a release). Rebuilt only when a Swift
/// source or a file linked into it changes, so the copies tauri-build watches settle after one
/// build.
fn helpers() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    let target = std::env::var("TARGET").expect("TARGET");
    let arch = match std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
        Ok("aarch64") => "arm64",
        Ok("x86_64") => "x86_64",
        other => panic!("no Mac helpers for {other:?}"),
    };
    let out = std::env::var("OUT_DIR").expect("OUT_DIR");
    std::fs::create_dir_all("binaries").expect("binaries folder");
    for (script, command) in [
        (SHARE_SCRIPT, "build:share"),
        (SHORTCUTS_SCRIPT, "build:shortcuts"),
    ] {
        if !Path::new(script).is_file() {
            panic!(
                "{script} is missing. Build it first from the repository root with \
                 `pnpm {command}` (`pnpm build:desktop` does this for you)."
            );
        }
        println!("cargo:rerun-if-changed={script}");
    }
    // Files linked into a helper as sections of __TEXT. The listener carries Ozzie's privacy
    // descriptions (Info.plist) in its own binary as well, so macOS can show why Ozzie asks when it
    // runs outside Ozzie.app (a development build). ozzie-share carries the read-only server script
    // (core/mcp/embedded.ts) that it runs in JavaScriptCore, so it is one self-contained file, and
    // ozzie-shortcuts the answers for Siri and Shortcuts (core/mcp/shortcuts-embedded.ts) likewise.
    for (name, sources, sections) in [
        (
            "ozzie-card-reader",
            &["helpers/card-reader.swift"][..],
            &[][..],
        ),
        // Apple Calendar, read-only; it carries the same privacy descriptions as the listener, for the same reason.
        (
            "ozzie-calendar",
            &["helpers/calendar.swift"][..],
            &[("__info_plist", "Info.plist")][..],
        ),
        (
            "ozzie-listen",
            &["helpers/listen.swift"][..],
            &[("__info_plist", "Info.plist")][..],
        ),
        (
            "ozzie-share",
            &["helpers/share.swift"][..],
            &[("__ozzie_server", SHARE_SCRIPT)][..],
        ),
        // Its answering is shared with Ozzie's Siri actions (siri_actions below).
        (
            "ozzie-shortcuts",
            &[SHORTCUTS_ANSWER, "helpers/shortcuts.swift"][..],
            &[("__ozzie_answers", SHORTCUTS_SCRIPT)][..],
        ),
    ] {
        for source in sources {
            println!("cargo:rerun-if-changed={source}");
        }
        let built = format!("binaries/{name}-{target}");
        let newest_input = sources
            .iter()
            .copied()
            .chain(sections.iter().map(|(_, file)| *file))
            .filter_map(modified)
            .max();
        if modified(&built).is_some_and(|b| newest_input.is_some_and(|i| b >= i)) {
            continue;
        }
        let mut swiftc = Command::new("/usr/bin/xcrun");
        swiftc.args([
            "--sdk",
            "macosx",
            "swiftc",
            "-O",
            "-target",
            &format!("{arch}-apple-macos14.0"),
            "-module-cache-path",
            &format!("{out}/swift-module-cache"),
            "-o",
            &built,
        ]);
        // A helper of several files has its entry point in one of them (@main), not top-level code.
        if sources.len() > 1 {
            swiftc.arg("-parse-as-library");
        }
        swiftc.args(sources);
        for (section, file) in sections {
            swiftc.args([
                "-Xlinker",
                "-sectcreate",
                "-Xlinker",
                "__TEXT",
                "-Xlinker",
                section,
                "-Xlinker",
                file,
            ]);
        }
        let status = swiftc
            .status()
            .expect("xcrun swiftc (Xcode Command Line Tools)");
        assert!(status.success(), "building {name} failed");
        assert!(Path::new(&built).is_file());
    }
    println!("cargo:rerun-if-changed=Info.plist");
    siri_actions(arch, &out);
}

/// The Xcode that builds the Siri actions: DEVELOPER_DIR when it is set (and only it), otherwise
/// the one xcode-select chose, otherwise the usual /Applications/Xcode.app. App Intents' metadata
/// tool ships with Xcode only, not with the Command Line Tools.
fn xcode() -> Option<PathBuf> {
    let usable = |dir: PathBuf| {
        (dir.join("usr/bin/xcodebuild").is_file()
            && dir
                .join("Toolchains/XcodeDefault.xctoolchain/usr/bin/appintentsmetadataprocessor")
                .is_file())
        .then_some(dir)
    };
    if let Some(dir) = std::env::var_os("DEVELOPER_DIR").filter(|d| !d.is_empty()) {
        return usable(dir.into());
    }
    Command::new("/usr/bin/xcode-select")
        .arg("-p")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| usable(PathBuf::from(String::from_utf8_lossy(&o.stdout).trim())))
        .or_else(|| usable(PathBuf::from("/Applications/Xcode.app/Contents/Developer")))
}

/// Text a command prints, trimmed; None when it fails.
fn output(program: &str, args: &[&str]) -> Option<String> {
    Command::new(program)
        .args(args)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
}

/// Ozzie's Siri actions (ADR 0007): helpers/siri-actions.swift and the shared answering, built by
/// xcodebuild (which writes the Metadata.appintents folder Siri and Shortcuts find them by) into
/// SIRI_ACTIONS with this build's answers linked in (section __TEXT,__ozzie_answers), then signed
/// for this Mac with their sandbox entitlements (Entitlements-intents.plist). A release signs them
/// again with the Developer ID (tools/release-mac.sh).
///
/// Without Xcode they can't be built: any older copy is removed, so an app is never bundled with
/// Siri actions older than its answers, and a warning says so. `cargo build`, `cargo test` and
/// `tauri dev` still work; `tauri build` stops at the missing SIRI_ACTIONS (tauri.conf.json
/// bundle.macOS.files) rather than make an app without them.
fn siri_actions(arch: &str, out: &str) {
    for input in SIRI_ACTIONS_INPUTS {
        println!("cargo:rerun-if-changed={input}");
    }
    println!("cargo:rerun-if-env-changed=DEVELOPER_DIR");
    let Some(developer) = xcode() else {
        let _ = std::fs::remove_dir_all(SIRI_ACTIONS);
        println!(
            "cargo:warning=Ozzie's Siri actions (App Intents) were not built: they need Xcode, and none was found \
             (DEVELOPER_DIR, xcode-select, /Applications/Xcode.app). This build has no Siri actions, and `tauri build` \
             will stop at the missing {SIRI_ACTIONS}. Install Xcode or set DEVELOPER_DIR to its Contents/Developer folder."
        );
        return;
    };
    let version = std::env::var("CARGO_PKG_VERSION").expect("CARGO_PKG_VERSION");
    let binary = format!("{SIRI_ACTIONS}/Contents/MacOS/OzzieIntents");
    let plist = format!("{SIRI_ACTIONS}/Contents/Info.plist");
    // Signing writes this last, so it dates the whole copy.
    let signed = modified(&format!(
        "{SIRI_ACTIONS}/Contents/_CodeSignature/CodeResources"
    ));
    let newest_input = SIRI_ACTIONS_INPUTS.into_iter().filter_map(modified).max();
    let current = signed.is_some_and(|s| newest_input.is_some_and(|i| s >= i))
        && output(
            "/usr/bin/plutil",
            &[
                "-extract",
                "CFBundleShortVersionString",
                "raw",
                "-o",
                "-",
                &plist,
            ],
        )
        .as_deref()
            == Some(version.as_str())
        && output("/usr/bin/lipo", &["-archs", &binary]).as_deref() == Some(arch);
    if current {
        return;
    }
    let _ = std::fs::remove_dir_all(SIRI_ACTIONS);
    // The answers are linked in from a copy named by their content, so new answers change the link
    // command and Xcode links again even when no Swift file changed.
    let work = PathBuf::from(out).join("siri-actions");
    std::fs::create_dir_all(&work).expect("siri-actions build folder");
    let script = std::fs::read(SHORTCUTS_SCRIPT).expect("the answers script");
    let mut hasher = DefaultHasher::new();
    script.hash(&mut hasher);
    let answers = work.join(format!("answers-{:016x}.js", hasher.finish()));
    std::fs::write(&answers, &script).expect("copy of the answers script");
    let products = work.join("build/Release/OzzieIntents.appex");
    let _ = std::fs::remove_dir_all(&products);
    // Only what xcodebuild needs from the environment: none of cargo's or tauri's variables, which
    // Xcode would otherwise read as build settings.
    let mut xcodebuild = Command::new(developer.join("usr/bin/xcodebuild"));
    xcodebuild
        .env_clear()
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .env("DEVELOPER_DIR", &developer);
    for kept in ["HOME", "USER", "LOGNAME", "TMPDIR"] {
        if let Some(value) = std::env::var_os(kept) {
            xcodebuild.env(kept, value);
        }
    }
    let status = xcodebuild
        .args([
            "-project",
            SIRI_ACTIONS_PROJECT,
            "-target",
            "OzzieIntents",
            "-configuration",
            "Release",
            "-quiet",
            "build",
        ])
        .arg(format!("SYMROOT={}", work.join("build").display()))
        .arg(format!("OBJROOT={}", work.join("obj").display()))
        .arg(format!("ARCHS={arch}"))
        .arg("ONLY_ACTIVE_ARCH=NO")
        .arg(format!("MARKETING_VERSION={version}"))
        .arg(format!("CURRENT_PROJECT_VERSION={version}"))
        .arg(format!("OZZIE_ANSWERS_SCRIPT={}", answers.display()))
        .status()
        .expect("xcodebuild");
    assert!(
        status.success(),
        "building Ozzie's Siri actions failed (xcodebuild, {SIRI_ACTIONS_PROJECT})"
    );
    assert!(
        products
            .join("Contents/Resources/Metadata.appintents/extract.actionsdata")
            .is_file(),
        "Ozzie's Siri actions were built without their App Intents metadata"
    );
    let copied = Command::new("/usr/bin/ditto")
        .arg(&products)
        .arg(SIRI_ACTIONS)
        .status()
        .expect("ditto");
    assert!(copied.success(), "copying Ozzie's Siri actions failed");
    // Signed for this Mac (ad hoc) with the sandbox and its two files, so the app bundles a whole,
    // signed extension; the release signs it again with the Developer ID.
    let signed = Command::new("/usr/bin/codesign")
        .args([
            "--force",
            "--sign",
            "-",
            "--options",
            "runtime",
            "--entitlements",
            "Entitlements-intents.plist",
            SIRI_ACTIONS,
        ])
        .status()
        .expect("codesign");
    assert!(signed.success(), "signing Ozzie's Siri actions failed");
}

fn main() {
    helpers();
    tauri_build::build()
}
