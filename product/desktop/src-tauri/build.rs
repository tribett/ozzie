use std::path::Path;
use std::process::Command;

/// Ozzie's own Mac helpers (helpers/*.swift): the visitor-card reader (Apple Vision) and the
/// on-device listener for spoken questions. Built here, before tauri-build looks for them, as
/// `binaries/<name>-<target>`: tauri.conf.json bundles them beside Ozzie's program and signs them
/// with the app (hardened runtime and Entitlements.plist in a release). Rebuilt only when a Swift
/// source or Info.plist changes, so the copies tauri-build watches settle after one build.
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
    // The listener carries Ozzie's privacy descriptions (Info.plist) in its own binary as well, so
    // macOS can show why Ozzie asks when it runs outside Ozzie.app (a development build).
    for (name, source, plist) in [
        ("ozzie-card-reader", "helpers/card-reader.swift", false),
        ("ozzie-listen", "helpers/listen.swift", true),
    ] {
        println!("cargo:rerun-if-changed={source}");
        let built = format!("binaries/{name}-{target}");
        let modified = |path: &str| std::fs::metadata(path).and_then(|m| m.modified()).ok();
        let newest_input = [Some(source), plist.then_some("Info.plist")]
            .into_iter()
            .flatten()
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
        if plist {
            swiftc.args([
                "-Xlinker",
                "-sectcreate",
                "-Xlinker",
                "__TEXT",
                "-Xlinker",
                "__info_plist",
                "-Xlinker",
                "Info.plist",
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
