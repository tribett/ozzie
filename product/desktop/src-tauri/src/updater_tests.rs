// Tests for updater.rs. The signature fixtures were made once with `tauri signer sign` and two
// throwaway test keys (only their public halves are here); none of this is Ozzie's release key.
use super::*;
use ozzie_native_auth::ledger::{RunState, TaskKind};
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::Arc;

/// Public half of throwaway test key A.
const TEST_KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDYxRUY0Q0I1MkM0MzZEREYKUldUZmJVTXN0VXp2WVhZanoxajBZQ0Z5TEdmaEJSc1ZMSFQ4RGlnRSt4ZGxPVmd5Z3ZjTHQ4L2QK";
/// Public half of throwaway test key B.
const OTHER_TEST_KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDVBM0VDMDgxNUVFMTE3NjMKUldSakYrRmVnY0ErV3F2d3ZLNzNYZWdXaytRTGxxYTVJbGI5SER3MWdnMWVrUVNwcWsvVjc1Z28K";
/// The "archive" every fixture signs.
const ARCHIVE: &[u8] = b"Fictional update archive for the updater tests. Not an app.\n";
/// ARCHIVE signed by key A for version 0.1.2.
const SIGNED_0_1_2: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVUZmJVTXN0VXp2WVVSenllVVYxejBiWHpFS1c0dWJ0UndVQmRhUW5RRDYydGdwN05wSmRzQXJCc2JnTktiNkpwYXdJc3BERkw3aUVFVFY5MDgyK296NWtUVk95OGxEekFBPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzk0NzY3NzU5CWZpbGU6YS0wMTIuYmluCXZlcnNpb246MC4xLjIKSnprUk94QnI3MW9OWCtTZVJWNXF4aXUzcklOdTdhc3ZUdVdVcFRjWWpjdVk0N1c0R0ZTZDczU0E5V2FIZzdoT1FHUUVVcXo0Rmc1bmtCUmtoUkhDQkE9PQo=";
/// ARCHIVE signed by key B (the wrong key) for version 0.1.2.
const OTHER_KEY_SIGNED_0_1_2: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVSakYrRmVnY0ErV28rOCthakgveFhva1M5Rlc1L0xNaVZlTHkrR0FWeFdhRnMxVDV4NCtqTnFhMGloYUlIMUcrWUR2TG1McnJlVWMyc2VyRUlUSHRWc1dCelhRSDhjQmdjPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzk0NzY3NzU5CWZpbGU6Yi0wMTIuYmluCXZlcnNpb246MC4xLjIKbThBYkNNYlBLY2E4ZERpM0VrZ3FmLzBHV0tCd1p5NnJhalArSUl3dXNha0F5S09zTUg2RkJqWWVGMzhLKy9DQUtLTnFLeG9Va2xjL3RVa0c5d2o1RFE9PQo=";
/// ARCHIVE signed by key A with no version bound to it.
const SIGNED_NO_VERSION: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVUZmJVTXN0VXp2WWExMU5HYVZsblFDNzN3cDlMNklkalFFYnYzcVg4MjB0eUgvbFpuTXJnWEhRQ2paV3FleHJPYk1MU3RKMndMSEJhYWdJV0gxY1JUWFZrNVEyUVB2L3dFPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzk0NzY3NzU5CWZpbGU6YS1ub3Zlci5iaW4KakFzYWV3TlEyaFFRZFIyTG1jWVdXZGtBSGszQmJacVhCU3N0NXM3L0RHVGpDZ0Zrd1R6cGdodWEveW5ReEhUSXpEZmRSY2FuMnE0VFZIdFMvSThJRFE9PQo=";
/// ARCHIVE signed by key A for version 0.1.0 (older than this build).
const SIGNED_0_1_0: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVUZmJVTXN0VXp2WWE0L2U3M2FOTXpjU2JtVlZqelhFR25Ga2NQWWRMeFhyYWN5dXpvZ081OVJyU2VzMm5ZUWdpMlJlSXVCSk9UOTlaUnZXNDVpVFNhU1BHeVdCK3hTeWdZPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzk0NzY3NzU5CWZpbGU6YS0wMTAuYmluCXZlcnNpb246MC4xLjAKVkJSUWp4TzBIWDlZb1pnUmloVFVSWlJ1aTYxMHMzaUI3dDNEZVBnVGRSUFlGRkI0djhNeUFGcGdpOEltZzVUOTlvZmk5RjZmeG43cS9hUk43ZGpWQWc9PQo=";

fn v(text: &str) -> Version {
    Version::parse(text).unwrap()
}
fn conf() -> Value {
    serde_json::from_str(include_str!("../tauri.conf.json")).unwrap()
}

#[test]
fn only_strictly_newer_released_versions_are_offered() {
    let current = v("0.1.1");
    assert!(is_newer(&current, &v("0.1.2")));
    assert!(is_newer(&current, &v("0.2.0")));
    assert!(is_newer(&current, &v("1.0.0")));
    // The same version, an older one, a pre-release or build metadata alone is never an update.
    for not in [
        "0.1.1",
        "0.1.0",
        "0.0.9",
        "0.1.2-beta.1",
        "0.2.0-rc.1",
        "0.1.1+rebuild.2",
    ] {
        assert!(!is_newer(&current, &v(not)), "{not}");
    }
    assert!(is_newer(&v("0.2.0-beta.1"), &v("0.2.0")));
    assert!(is_newer(&current, &v("0.1.2+build.7")));
}

#[test]
fn versions_reach_the_page_only_once_they_parse() {
    assert_eq!(shown_version("0.1.2").as_deref(), Some("0.1.2"));
    assert_eq!(
        shown_version("1.2.3-beta.1+b7").as_deref(),
        Some("1.2.3-beta.1+b7")
    );
    for bad in [
        "",
        "v0.1.2",
        "0.1",
        "0.1.2 <b>",
        "Avery",
        &format!("0.1.2-{}", "a".repeat(40)),
    ] {
        assert_eq!(shown_version(bad), None, "{bad}");
    }
}

#[test]
fn archives_come_only_from_the_releases_own_downloads() {
    let release = "https://github.com/tribett/ozzie/releases/download/v0.1.2/Ozzie.app.tar.gz";
    assert!(download_ok(release, None));
    for bad in [
        "http://github.com/tribett/ozzie/releases/download/v0.1.2/Ozzie.app.tar.gz",
        "https://github.com/someone-else/ozzie/releases/download/v0.1.2/Ozzie.app.tar.gz",
        "https://github.com/tribett/ozzie/releases/download/v0.1.2/Other.app.tar.gz",
        "https://github.com/tribett/ozzie/releases/download/Ozzie.app.tar.gz",
        "https://github.com/tribett/ozzie/releases/download/v0.1.2/../x/Ozzie.app.tar.gz",
        "https://github.com/tribett/ozzie/releases/download/a/b/Ozzie.app.tar.gz",
        "https://evil.example/https://github.com/tribett/ozzie/releases/download/v0.1.2/Ozzie.app.tar.gz",
        "http://127.0.0.1:8080/v0.1.2/Ozzie.app.tar.gz",
    ] {
        assert!(!download_ok(bad, None), "{bad}");
    }
    // Debug builds' stand-in feed: its own address only.
    let feed = "http://127.0.0.1:8080/latest.json";
    assert!(download_ok(
        "http://127.0.0.1:8080/v0.1.2/Ozzie.app.tar.gz",
        Some(feed)
    ));
    assert!(!download_ok(
        "http://127.0.0.1:9090/v0.1.2/Ozzie.app.tar.gz",
        Some(feed)
    ));
    assert!(!download_ok("http://127.0.0.1:8080.evil/x", Some(feed)));
    assert!(download_ok(release, Some(feed)));
}

#[test]
fn checks_come_shortly_after_launch_then_daily_and_a_failure_is_tried_again_later() {
    let launched = 1_794_668_400_000;
    let s = Schedule {
        automatic: true,
        launched_ms: launched,
        first_after_ms: FIRST_CHECK_AFTER_MS,
        ..Schedule::default()
    };
    assert!(!check_due(launched, &s));
    assert!(!check_due(launched + FIRST_CHECK_AFTER_MS - 1, &s));
    assert!(check_due(launched + FIRST_CHECK_AFTER_MS, &s));
    let checked = launched + FIRST_CHECK_AFTER_MS;
    let after = Schedule {
        last_attempt_ms: Some(checked),
        ..s
    };
    assert!(!check_due(checked + CHECK_EVERY_MS - 1, &after));
    assert!(check_due(checked + CHECK_EVERY_MS, &after));
    // A failure is tried again after three hours, silently.
    let failed = Schedule {
        last_failed: true,
        ..after
    };
    assert!(!check_due(checked + RETRY_AFTER_MS - 1, &failed));
    assert!(check_due(checked + RETRY_AFTER_MS, &failed));
    // A clock set backwards checks again rather than waiting days.
    assert!(check_due(checked - 60_000, &after));
    // Turned off, or a check, download or reopen under way: never.
    assert!(!check_due(
        checked + 10 * CHECK_EVERY_MS,
        &Schedule {
            automatic: false,
            ..after
        }
    ));
    assert!(!check_due(
        checked + 10 * CHECK_EVERY_MS,
        &Schedule {
            working: true,
            ..after
        }
    ));
    assert_eq!(
        (FIRST_CHECK_AFTER_MS, CHECK_EVERY_MS, RETRY_AFTER_MS),
        (90_000, 86_400_000, 10_800_000)
    );
}

fn task(state: RunState) -> TaskRow {
    TaskRow {
        task_id: "00000000-0000-4000-8000-000000000001".into(),
        kind: TaskKind::Check,
        skill_id: "sunday-ready".into(),
        skill_hash: "a".repeat(64),
        state,
        created_at: "2026-11-20T21:42:00Z".into(),
        updated_at: "2026-11-20T21:42:09Z".into(),
        failure: None,
        events: Vec::new(),
    }
}

#[test]
fn a_task_or_a_responsibility_run_under_way_holds_the_reopen() {
    assert!(!busy(&[], false));
    for done in [RunState::Verified, RunState::Failed, RunState::Cancelled] {
        assert!(!busy(&[task(done)], false), "{done:?}");
    }
    for going in [RunState::Proposed, RunState::Admitted, RunState::Running] {
        assert!(
            busy(&[task(RunState::Verified), task(going)], false),
            "{going:?}"
        );
    }
    assert!(busy(&[], true));
    assert_eq!(WAIT_FOR_TASKS, Duration::from_secs(600));
}

#[test]
fn only_an_app_bundle_that_isnt_a_translocated_copy_is_replaced() {
    let (place, bundle) = bundle_of(Path::new(
        "/Applications/Ozzie.app/Contents/MacOS/ozzie-desktop",
    ));
    assert_eq!(place, Place::App);
    assert_eq!(
        bundle.as_deref(),
        Some(Path::new("/Applications/Ozzie.app"))
    );
    // A developer build run from its build folder: replacing "the folder above" would be wrong.
    assert_eq!(
        bundle_of(Path::new("/repo/target/debug/ozzie-desktop")),
        (Place::NotAnApp, None)
    );
    assert_eq!(
        bundle_of(Path::new("/x/Ozzie/Contents/MacOS/ozzie-desktop")),
        (Place::NotAnApp, None)
    );
    assert_eq!(
        bundle_of(Path::new("ozzie-desktop")),
        (Place::NotAnApp, None)
    );
    // macOS runs a copy opened where it was downloaded from a randomized read-only place.
    let translocated = "/var/T/AppTranslocation/1234/d/Ozzie.app/Contents/MacOS/ozzie-desktop";
    assert_eq!(
        bundle_of(Path::new(translocated)),
        (Place::MoveToApplications, None)
    );
}

#[test]
fn the_setting_is_on_unless_turned_off_and_is_kept_privately() {
    use std::os::unix::fs::PermissionsExt;
    let dir = std::env::temp_dir().join(format!(
        "ozzie-updates-{}-{}",
        std::process::id(),
        unix_ms()
    ));
    let path = dir.join(PREFS_FILE);
    assert!(read_prefs(&path).automatic, "nothing saved: on");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(&path, b"not json").unwrap();
    assert!(read_prefs(&path).automatic, "unreadable: on");
    let off = Prefs {
        automatic: false,
        last_checked_ms: Some(1_794_668_400_000),
    };
    write_prefs(&path, &off).unwrap();
    assert_eq!(read_prefs(&path), off);
    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        r#"{"automatic":false,"last_checked_ms":1794668400000}"#
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn the_release_configuration_checks_github_over_https_with_the_signed_version_required() {
    let conf = conf();
    let updater = conf["plugins"]["updater"].as_object().unwrap();
    assert_eq!(updater["endpoints"], json!([FEED]));
    assert_eq!(updater["requireSignedVersion"], json!(true));
    // Nothing that weakens the check: no plain HTTP, no bad certificates, no downgrades.
    let mut keys: Vec<&str> = updater.keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(keys, ["endpoints", "pubkey", "requireSignedVersion"]);
    // The public key is a minisign public key, and not one of the test keys.
    let pubkey = updater["pubkey"].as_str().unwrap();
    let decoded =
        String::from_utf8(base64_decode(pubkey).expect("the public key is base64")).unwrap();
    assert!(
        decoded.starts_with("untrusted comment: minisign public key: "),
        "{decoded}"
    );
    assert!(pubkey != TEST_KEY && pubkey != OTHER_TEST_KEY);
    // tauri's own updater archives aren't used: the release script makes one from the final, stapled app.
    assert!(conf["bundle"].get("createUpdaterArtifacts").is_none());
    assert!(
        FEED.starts_with("https://") && FEED.ends_with("/releases/latest/download/latest.json")
    );
    assert!(FEED.contains("/tribett/ozzie/") && DOWNLOAD_PREFIX.contains("/tribett/ozzie/"));
}
/// Standard base64, for reading the configured public key in a test.
fn base64_decode(text: &str) -> Option<Vec<u8>> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::new();
    let (mut acc, mut bits) = (0u32, 0u32);
    for b in text.trim_end_matches('=').bytes() {
        acc = (acc << 6) | ALPHABET.iter().position(|&c| c == b)? as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}

#[test]
fn the_page_gets_no_updater_permission() {
    let caps: Value = serde_json::from_str(include_str!("../capabilities/main.json")).unwrap();
    assert_eq!(
        caps["permissions"],
        json!(["core:event:allow-listen", "core:event:allow-unlisten"])
    );
    assert!(!include_str!("../capabilities/main.json").contains("updater"));
}

#[test]
fn this_build_has_one_version_everywhere_it_is_declared() {
    // Cargo.toml, tauri.conf.json and Cargo.lock must agree, whatever the release is (this named 0.1.1 and went
    // red, unnoticed, when 0.1.2 was declared).
    let version = env!("CARGO_PKG_VERSION");
    assert_eq!(conf()["version"], json!(version));
    let lock = include_str!("../Cargo.lock");
    assert!(lock.contains(&format!(
        "name = \"ozzie-desktop\"\nversion = \"{version}\""
    )));
}

#[test]
fn the_reopen_waits_for_this_copy_to_exit_and_opens_with_no_arguments() {
    // Same script, with `echo` standing in for `open`: it runs only once the process is gone.
    let script = REOPEN_SCRIPT.replace("/usr/bin/open", "/bin/echo");
    let mut child = std::process::Command::new("/bin/sleep")
        .arg("1")
        .spawn()
        .unwrap();
    let pid = child.id().to_string();
    // Reaped as soon as it exits, as launchd reaps a quitting Ozzie (a zombie still answers `kill -0`).
    let reaper = std::thread::spawn(move || child.wait());
    let started = std::time::Instant::now();
    let out = std::process::Command::new("/bin/sh")
        .arg("-c")
        .arg(&script)
        .arg("ozzie-reopen")
        .arg(&pid)
        .arg("/Applications/Ozzie.app")
        .output()
        .unwrap();
    let _ = reaper.join();
    // After the process ended, well before the script's own 30-second limit.
    let waited = started.elapsed();
    assert!(
        waited >= Duration::from_millis(800) && waited < Duration::from_secs(5),
        "{waited:?}"
    );
    assert_eq!(
        String::from_utf8_lossy(&out.stdout),
        "/Applications/Ozzie.app\n"
    );
    // Never `open -n` (a second copy beside this one), never this launch's own arguments (a copy
    // opened at login would stay hidden after the click).
    assert!(!REOPEN_SCRIPT.contains("-n") && REOPEN_SCRIPT.contains("exec /usr/bin/open \"$@\""));
}

// ---- The plugin's own checks, through Ozzie's settings, against a stand-in on this Mac ----------------

/// A mock app with tauri.conf.json's updater settings, `pubkey` in place of the release key.
fn mock_app(pubkey: &str, current: &str) -> tauri::App<tauri::test::MockRuntime> {
    let mut updater = conf()["plugins"]["updater"].clone();
    updater["pubkey"] = pubkey.into();
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    context
        .config_mut()
        .plugins
        .0
        .insert("updater".into(), updater);
    context.package_info_mut().version = v(current);
    tauri::test::mock_builder()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .build(context)
        .unwrap()
}
/// A one-thread HTTP stand-in: answers each path with its bytes, records each request's head.
struct StandIn {
    port: u16,
    heads: Arc<Mutex<Vec<String>>>,
}
fn stand_in(routes: impl Fn(u16) -> Vec<(String, Vec<u8>)> + Send + 'static) -> StandIn {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let heads = Arc::new(Mutex::new(Vec::new()));
    let seen = heads.clone();
    let routes = routes(port);
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            let mut head = Vec::new();
            let mut chunk = [0u8; 1024];
            while !head.windows(4).any(|w| w == b"\r\n\r\n") {
                match stream.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => head.extend_from_slice(&chunk[..n]),
                }
            }
            let head = String::from_utf8_lossy(&head).into_owned();
            let path = head
                .split_whitespace()
                .nth(1)
                .unwrap_or_default()
                .to_owned();
            seen.lock().unwrap().push(head);
            let reply = match routes.iter().find(|(p, _)| *p == path) {
                Some((_, body)) => [
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    )
                    .into_bytes(),
                    body.clone(),
                ]
                .concat(),
                None => b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    .to_vec(),
            };
            let _ = stream.write_all(&reply);
        }
    });
    StandIn { port, heads }
}
/// A release announcement as tools/release-mac.sh writes it, for this Mac's platform.
fn announcement(port: u16, version: &str, signature: &str) -> Vec<u8> {
    let platform = tauri_plugin_updater::target().unwrap();
    serde_json::to_vec(&json!({
        "version": version,
        "notes": "Fictional notes, never shown.",
        "pub_date": "2026-11-20T12:00:00Z",
        "platforms": { platform: {
            "signature": signature,
            "url": format!("http://127.0.0.1:{port}/v{version}/{ARCHIVE_NAME}"),
        } },
    }))
    .unwrap()
}
#[derive(Debug, PartialEq, Eq)]
enum Outcome {
    NotOffered,
    Installable,
    /// The plugin's check of the archive failed: not this key, or not these bytes.
    RefusedSignature,
    /// Signed for another version than the one announced.
    RefusedVersion,
    /// Signed without a version, which tauri.conf.json requires.
    RefusedNoVersion,
}
/// Checks the stand-in with Ozzie's settings as this build (0.1.1) and downloads what it offers.
fn try_update(
    version: &str,
    signature: &'static str,
    served: &'static [u8],
    pubkey: &str,
) -> (Outcome, Vec<String>) {
    let version = version.to_owned();
    let stand = stand_in(move |port| {
        vec![
            (
                "/latest.json".into(),
                announcement(port, &version, signature),
            ),
            (format!("/v{version}/{ARCHIVE_NAME}"), served.to_vec()),
        ]
    });
    let app = mock_app(pubkey, "0.1.1");
    let feed = format!("http://127.0.0.1:{}/latest.json", stand.port);
    let outcome = tauri::async_runtime::block_on(async {
        let updater = configured(&app, Some(&feed)).unwrap().build().unwrap();
        match updater.check().await.expect("the stand-in answers") {
            None => Outcome::NotOffered,
            Some(update) => match update.download(|_, _| {}, || {}).await {
                Ok(bytes) if bytes == served && update.verify(&bytes).is_ok() => {
                    Outcome::Installable
                }
                Ok(_) => panic!("the download returned other bytes"),
                Err(tauri_plugin_updater::Error::Minisign(_)) => Outcome::RefusedSignature,
                Err(tauri_plugin_updater::Error::SignedVersionMismatch { .. }) => {
                    Outcome::RefusedVersion
                }
                Err(tauri_plugin_updater::Error::MissingSignedVersion) => Outcome::RefusedNoVersion,
                Err(other) => panic!("refused for another reason: {other}"),
            },
        }
    });
    let heads = stand.heads.lock().unwrap().clone();
    (outcome, heads)
}

#[test]
fn the_plugin_accepts_a_genuine_archive_and_refuses_tampered_wrong_key_and_mismatched_ones() {
    let (genuine, heads) = try_update("0.1.2", SIGNED_0_1_2, ARCHIVE, TEST_KEY);
    assert_eq!(genuine, Outcome::Installable);
    // Exactly what left: a plain GET of the announcement, then of the archive. No query, no cookie, no
    // identifier; only the plugin's fixed user agent, an Accept header and the host.
    assert_eq!(heads.len(), 2, "{heads:?}");
    for (head, (path, accept)) in heads.iter().zip([
        ("/latest.json", "application/json"),
        ("/v0.1.2/Ozzie.app.tar.gz", "application/octet-stream"),
    ]) {
        let mut lines = head.split("\r\n").filter(|l| !l.is_empty());
        assert_eq!(lines.next(), Some(format!("GET {path} HTTP/1.1").as_str()));
        let mut names: Vec<String> = Vec::new();
        for line in lines {
            let (name, value) = line.split_once(": ").unwrap();
            let name = name.to_ascii_lowercase();
            match name.as_str() {
                "user-agent" => assert_eq!(value, "tauri-plugin-updater/2.14.1"),
                "accept" => assert_eq!(value, accept),
                "host" => assert!(value.starts_with("127.0.0.1:")),
                other => panic!("unexpected header {other}"),
            }
            names.push(name);
        }
        names.sort();
        assert_eq!(names, ["accept", "host", "user-agent"]);
    }
    // One byte changed in the archive.
    const TAMPERED: &[u8] = b"Fictional update archive for the updater tests. Not an app!\n";
    assert_eq!(
        try_update("0.1.2", SIGNED_0_1_2, TAMPERED, TEST_KEY).0,
        Outcome::RefusedSignature
    );
    // Signed with a key Ozzie doesn't trust.
    assert_eq!(
        try_update("0.1.2", OTHER_KEY_SIGNED_0_1_2, ARCHIVE, TEST_KEY).0,
        Outcome::RefusedSignature
    );
    // A genuine archive under a higher announced version than it was signed for (a downgrade in disguise).
    assert_eq!(
        try_update("0.1.3", SIGNED_0_1_2, ARCHIVE, TEST_KEY).0,
        Outcome::RefusedVersion
    );
    // Signed without a version: refused because tauri.conf.json requires the signed version.
    assert_eq!(
        try_update("0.1.2", SIGNED_NO_VERSION, ARCHIVE, TEST_KEY).0,
        Outcome::RefusedNoVersion
    );
    // The release key in tauri.conf.json doesn't accept a test-key signature.
    let release_key = conf()["plugins"]["updater"]["pubkey"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        try_update("0.1.2", SIGNED_0_1_2, ARCHIVE, &release_key).0,
        Outcome::RefusedSignature
    );
    // Older, the same, or a pre-release: never offered, so never downloaded.
    for (version, signature) in [
        ("0.1.0", SIGNED_0_1_0),
        ("0.1.1", SIGNED_0_1_2),
        ("0.1.2-beta.1", SIGNED_0_1_2),
    ] {
        let (outcome, heads) = try_update(version, signature, ARCHIVE, TEST_KEY);
        assert_eq!(outcome, Outcome::NotOffered, "{version}");
        assert_eq!(
            heads.len(),
            1,
            "only the announcement was read for {version}"
        );
    }
}

/// tools/release-mac.sh runs this against its output, with the release key from tauri.conf.json:
/// `latest.json` names this version, the platforms this build supports and the release's own
/// download address, and `Ozzie.app.tar.gz` passes the plugin's own check for that version.
#[test]
#[ignore = "run by tools/release-mac.sh against the release output"]
fn release_archive_matches_the_public_key() {
    let dir = PathBuf::from(std::env::var_os("OZZIE_UPDATE_DIR").expect("OZZIE_UPDATE_DIR"));
    let version = std::env::var("OZZIE_UPDATE_VERSION").expect("OZZIE_UPDATE_VERSION");
    let platforms = std::env::var("OZZIE_UPDATE_PLATFORMS").expect("OZZIE_UPDATE_PLATFORMS");
    let latest: Value =
        serde_json::from_slice(&std::fs::read(dir.join("latest.json")).unwrap()).unwrap();
    assert_eq!(latest["version"], json!(version));
    assert_eq!(
        version,
        env!("CARGO_PKG_VERSION"),
        "latest.json is for this build's version"
    );
    let listed = latest["platforms"].as_object().expect("platforms");
    let mut keys: Vec<&str> = listed.keys().map(String::as_str).collect();
    keys.sort_unstable();
    let mut expected: Vec<&str> = platforms.split(',').collect();
    expected.sort_unstable();
    assert_eq!(keys, expected);
    for entry in listed.values() {
        let url = entry["url"].as_str().unwrap();
        assert_eq!(url, format!("{DOWNLOAD_PREFIX}v{version}/{ARCHIVE_NAME}"));
        assert!(download_ok(url, None));
    }
    let pubkey = conf()["plugins"]["updater"]["pubkey"]
        .as_str()
        .unwrap()
        .to_owned();
    let app = mock_app(&pubkey, "0.0.0");
    let updater = configured(&app, None).unwrap().build().unwrap();
    let update = updater
        .restore_update(latest)
        .expect("latest.json parses, with a valid pub_date")
        .expect("offered to an older copy");
    assert_eq!(update.version, version);
    let bytes = std::fs::read(dir.join(ARCHIVE_NAME)).unwrap();
    update
        .verify(&bytes)
        .expect("the archive matches the public key in tauri.conf.json and its signed version");
    println!(
        "updater-release-check: {ARCHIVE_NAME} {version} verified against the tauri.conf.json key for {platforms}"
    );
}
