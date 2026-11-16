//! The file "Add Ozzie to Claude" makes: its manifest equal to the TypeScript's saved example, a
//! zip macOS's own unzip reads back byte for byte, a helper path that is carried as it is or not
//! at all, a save that never follows a link, and an open that names only Claude and the file.
use super::*;

const HELPER: &str = "/Applications/Ozzie.app/Contents/MacOS/ozzie-share";
const SAVED: &str = include_str!("../../../../core/test/mcp/fixtures/claude-bundle.json");

fn scratch(name: &str) -> PathBuf {
    let dir =
        std::env::temp_dir().join(format!("ozzie-share-bundle-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn the_manifest_is_the_typescript_one() {
    let saved: serde_json::Value = serde_json::from_str(SAVED).unwrap();
    assert_eq!(bundle_manifest(HELPER, "0.0.0"), saved);
    // Only the helper, with no arguments; nothing for Claude to ask the person for.
    let manifest = bundle_manifest(HELPER, "0.1.6");
    assert_eq!(
        manifest["server"],
        serde_json::json!({ "type": "binary", "entry_point": BUNDLE_NOTE, "mcp_config": { "command": HELPER, "args": [] } })
    );
    assert_eq!(manifest["version"], "0.1.6");
    assert!(manifest.get("user_config").is_none());
}

#[test]
fn the_note_and_file_names_are_the_typescript_ones() {
    let setup = include_str!("../../../../core/mcp/setup.ts");
    assert!(setup.contains(&format!("CLAUDE_BUNDLE_FILE = \"{BUNDLE_FILE}\"")));
    assert!(setup.contains(&format!("CLAUDE_BUNDLE_NOTE = \"{BUNDLE_NOTE}\"")));
    assert!(setup.contains("This file holds no program. Claude starts the read-only helper inside Ozzie on this Mac:\\n${path}\\n"));
    assert_eq!(
        bundle_note(HELPER),
        format!(
            "This file holds no program. Claude starts the read-only helper inside Ozzie on this Mac:\n{HELPER}\n"
        )
    );
}

#[test]
fn a_path_is_carried_as_it_is_or_not_at_all() {
    let odd = "/Applications/Church's \"Tools\" é/Ozzie.app/Contents/MacOS/ozzie-share";
    for good in [
        HELPER,
        odd,
        concat!(
            "/",
            "Users",
            "/Shared/Applications/Ozzie.app/Contents/MacOS/ozzie-share"
        ),
    ] {
        assert!(lasting_path(good), "{good}");
        assert!(bundle_bytes(good, "0.1.6").is_some());
    }
    assert_eq!(
        bundle_manifest(odd, "1")["server"]["mcp_config"]["command"],
        odd
    );
    let long = format!("/{}", "a".repeat(1024));
    for bad in [
        "",
        "ozzie-share",
        "./ozzie-share",
        "/a\nb",
        "/a\u{0}b",
        "/a\u{2028}b",
        "/a/${__dirname}/b",
        "/a\u{85}b",
        "/a\u{9b}b",
        long.as_str(),
        "/private/var/folders/x/T/AppTranslocation/1234/d/Ozzie.app/Contents/MacOS/ozzie-share",
        concat!(
            "/",
            "Volumes",
            "/Ozzie/Ozzie.app/Contents/MacOS/ozzie-share"
        ),
    ] {
        assert!(!lasting_path(bad), "{bad:?}");
        assert_eq!(bundle_bytes(bad, "0.1.6"), None);
    }
    // A development build on another disk isn't an app on a disk image.
    assert!(lasting_path(concat!(
        "/",
        "Volumes",
        "/Work/ozzie/target/debug/ozzie-share"
    )));
}

#[test]
fn the_zip_checksum_is_the_standard_one() {
    assert_eq!(crc32(b""), 0);
    assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
}

#[test]
fn the_zip_refuses_names_that_arent_plain_relative_paths() {
    for bad in ["", "/a", "a/../b", "..", "a//b", "a\\b", "a\nb", "./a"] {
        assert_eq!(stored_zip(&[(bad, b"x")]), None, "{bad:?}");
    }
    assert!(stored_zip(&[("a/b.txt", b"x")]).is_some());
}

#[test]
fn the_same_input_gives_the_same_file() {
    assert_eq!(bundle_bytes(HELPER, "0.1.6"), bundle_bytes(HELPER, "0.1.6"));
    assert_ne!(bundle_bytes(HELPER, "0.1.6"), bundle_bytes(HELPER, "0.1.7"));
}

#[cfg(target_os = "macos")]
#[test]
fn macos_unzip_reads_back_exactly_the_manifest_and_the_note() {
    let dir = scratch("unzip");
    let odd = "/Applications/Church's \"Tools\" é/Ozzie.app/Contents/MacOS/ozzie-share";
    let file = save_bundle(&dir.join("made"), &bundle_bytes(odd, "0.1.6").unwrap()).unwrap();
    assert_eq!(file, dir.join("made").join(BUNDLE_FILE));
    let test = std::process::Command::new("/usr/bin/unzip")
        .arg("-tq")
        .arg(&file)
        .output()
        .unwrap();
    assert!(
        test.status.success(),
        "{}",
        String::from_utf8_lossy(&test.stdout)
    );
    let out = dir.join("out");
    let unzip = std::process::Command::new("/usr/bin/unzip")
        .arg("-q")
        .arg(&file)
        .arg("-d")
        .arg(&out)
        .status()
        .unwrap();
    assert!(unzip.success());
    let mut names: Vec<_> = walk(&out);
    names.sort();
    assert_eq!(names, ["manifest.json", BUNDLE_NOTE]);
    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(out.join("manifest.json")).unwrap()).unwrap();
    assert_eq!(manifest, bundle_manifest(odd, "0.1.6"));
    assert_eq!(
        std::fs::read_to_string(out.join(BUNDLE_NOTE)).unwrap(),
        bundle_note(odd)
    );
    // Plain files, nothing that can be run.
    use std::os::unix::fs::PermissionsExt as _;
    for name in names {
        let mode = std::fs::metadata(out.join(&name))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o111, 0, "{name}");
    }
    std::fs::remove_dir_all(&dir).unwrap();
}

#[cfg(target_os = "macos")]
fn walk(root: &Path) -> Vec<String> {
    let mut found = Vec::new();
    let mut todo = vec![root.to_path_buf()];
    while let Some(dir) = todo.pop() {
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                todo.push(path);
            } else {
                found.push(
                    path.strip_prefix(root)
                        .unwrap()
                        .to_str()
                        .unwrap()
                        .to_string(),
                );
            }
        }
    }
    found
}

#[test]
fn saving_replaces_the_last_file_and_never_follows_a_link() {
    use std::os::unix::fs::PermissionsExt as _;
    let dir = scratch("save");
    let made = dir.join("made");
    let first = save_bundle(&made, b"one").unwrap();
    assert_eq!(std::fs::read(&first).unwrap(), b"one");
    assert_eq!(
        std::fs::metadata(&made).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert_eq!(
        std::fs::metadata(&first).unwrap().permissions().mode() & 0o777,
        0o644
    );
    save_bundle(&made, b"two").unwrap();
    assert_eq!(std::fs::read(&first).unwrap(), b"two");
    // Nothing but the file is left in the folder.
    let left: Vec<_> = std::fs::read_dir(&made)
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(left, [std::ffi::OsString::from(BUNDLE_FILE)]);

    // A link where the folder should be: refused, and nothing written where it points.
    let elsewhere = dir.join("elsewhere");
    std::fs::create_dir(&elsewhere).unwrap();
    let linked = dir.join("linked");
    std::os::unix::fs::symlink(&elsewhere, &linked).unwrap();
    assert_eq!(save_bundle(&linked, b"x"), Err(AddToClaudeError::NotSaved));
    assert_eq!(std::fs::read_dir(&elsewhere).unwrap().count(), 0);

    // A link where the file is: replaced by the file itself; what it pointed at is untouched.
    let target = dir.join("target.txt");
    std::fs::write(&target, b"kept").unwrap();
    std::fs::remove_file(&first).unwrap();
    std::os::unix::fs::symlink(&target, &first).unwrap();
    save_bundle(&made, b"three").unwrap();
    assert_eq!(std::fs::read(&target).unwrap(), b"kept");
    assert!(std::fs::symlink_metadata(&first).unwrap().is_file());
    assert_eq!(std::fs::read(&first).unwrap(), b"three");

    // Many saves at once: every one lands whole (review L L2).
    let busy = dir.join("busy");
    let big = vec![7u8; 1 << 20];
    std::thread::scope(|scope| {
        for _ in 0..4 {
            scope.spawn(|| {
                for _ in 0..10 {
                    let saved = save_bundle(&busy, &big).unwrap();
                    assert_eq!(std::fs::read(saved).unwrap().len(), big.len());
                }
            });
        }
    });
    let left: Vec<_> = std::fs::read_dir(&busy)
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(left, [std::ffi::OsString::from(BUNDLE_FILE)]);

    // A file where the folder should be.
    let plain = dir.join("plain");
    std::fs::write(&plain, b"").unwrap();
    assert_eq!(save_bundle(&plain, b"x"), Err(AddToClaudeError::NotSaved));
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn only_claude_is_asked_to_open_only_the_file() {
    let file = Path::new("/tmp/x/Ozzie.mcpb");
    assert_eq!(
        open_arguments(file),
        ["-b", CLAUDE_BUNDLE_ID, "/tmp/x/Ozzie.mcpb"].map(std::ffi::OsString::from)
    );
    assert_eq!(CLAUDE_BUNDLE_ID, "com.anthropic.claudefordesktop");
    // The command takes nothing from the page.
    let source = include_str!("share_bundle.rs");
    assert!(source.contains(
        "pub async fn add_to_claude(handle: tauri::AppHandle) -> Result<(), AddToClaudeError>"
    ));
    assert_eq!(source.matches("Command::new(").count(), 1);
    assert!(source.contains("Command::new(\"/usr/bin/open\")"));
}

#[test]
fn the_codes_are_plain_words() {
    for (error, code) in [
        (AddToClaudeError::NoHelper, "\"no-helper\""),
        (AddToClaudeError::MoveFirst, "\"move-first\""),
        (AddToClaudeError::NotSaved, "\"not-saved\""),
        (AddToClaudeError::NotOpened, "\"not-opened\""),
    ] {
        assert_eq!(serde_json::to_string(&error).unwrap(), code);
    }
}
