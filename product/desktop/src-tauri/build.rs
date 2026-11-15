use std::path::Path;
use std::process::Command;

/// The server script ozzie-share runs (`pnpm build:share`, git-ignored), so a build can't bundle
/// a helper without it or with an older copy: build:desktop and tauri's beforeBuildCommand build
/// it first, and the helper is rebuilt whenever it changes.
const SHARE_SCRIPT: &str = "../../../core/mcp/dist-share/ozzie-share.js";

/// Ozzie's own Mac helpers (helpers/*.swift): the visitor-card reader (Apple Vision), the
/// on-device listener for spoken questions, and the last check for other AI apps. Built here,
/// before tauri-build looks for them, as `binaries/<name>-<target>`: tauri.conf.json bundles them
/// beside Ozzie's program and signs them with the app (hardened runtime and Entitlements.plist in a
/// release). Rebuilt only when a Swift source or a file linked into it changes, so the copies
/// tauri-build watches settle after one build.
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
    if !Path::new(SHARE_SCRIPT).is_file() {
        panic!(
            "{SHARE_SCRIPT} is missing. Build it first from the repository root with \
             `pnpm build:share` (`pnpm build:desktop` does this for you)."
        );
    }
    println!("cargo:rerun-if-changed={SHARE_SCRIPT}");
    // Files linked into a helper as sections of __TEXT. The listener carries Ozzie's privacy
    // descriptions (Info.plist) in its own binary as well, so macOS can show why Ozzie asks when it
    // runs outside Ozzie.app (a development build). ozzie-share carries the read-only server script
    // (core/mcp/embedded.ts) that it runs in JavaScriptCore, so it is one self-contained file.
    for (name, source, sections) in [
        ("ozzie-card-reader", "helpers/card-reader.swift", &[][..]),
        (
            "ozzie-listen",
            "helpers/listen.swift",
            &[("__info_plist", "Info.plist")][..],
        ),
        (
            "ozzie-share",
            "helpers/share.swift",
            &[("__ozzie_server", SHARE_SCRIPT)][..],
        ),
    ] {
        println!("cargo:rerun-if-changed={source}");
        let built = format!("binaries/{name}-{target}");
        let modified = |path: &str| std::fs::metadata(path).and_then(|m| m.modified()).ok();
        let newest_input = std::iter::once(source)
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
            source,
        ]);
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
}

fn main() {
    helpers();
    tauri_build::build()
}
