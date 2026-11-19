use super::*;
use std::collections::BTreeMap;

use crate::test_support::{Built, dev_tool_inputs, has_word, scan_requests, squeeze};

/// Every .rs file under a folder, by its path from that folder, read at test time.
fn read_tree(root: &std::path::Path) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let mut dirs = vec![root.to_path_buf()];
    while let Some(dir) = dirs.pop() {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                dirs.push(path);
            } else if path.extension().is_some_and(|e| e == "rs") {
                let name = path
                    .strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                out.insert(name, std::fs::read_to_string(&path).unwrap());
            }
        }
    }
    out
}
const DEV_PREFIX: &str = "church-systems-dev/";
/// Every .rs file under this crate's src, by its path from src. When the developer tool's crate sits beside this one
/// (core/church-systems-dev, left out of the public copy), its src too, as `church-systems-dev/<path>`.
fn sources() -> BTreeMap<String, String> {
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut out = read_tree(&manifest.join("src"));
    assert!(out.contains_key("http.rs") && out.contains_key("b1.rs"));
    let tool = manifest.join("../church-systems-dev/src");
    if tool.is_dir() {
        let tool = read_tree(&tool);
        assert!(tool.contains_key("main.rs") && tool.contains_key("dev.rs"));
        out.extend(
            tool.into_iter()
                .map(|(name, text)| (format!("{DEV_PREFIX}{name}"), text)),
        );
    }
    out
}

#[test]
fn the_developer_tool_takes_nothing_secret_from_the_command_line_or_the_environment() {
    let sources = sources();
    // `dev_support` is in this crate and always checked; the tool's own files when its crate is here.
    let support = &sources["dev_support.rs"];
    match (
        sources.get(&format!("{DEV_PREFIX}main.rs")),
        sources.get(&format!("{DEV_PREFIX}dev.rs")),
    ) {
        (Some(main), Some(dev)) => dev_tool_inputs(main, dev, support),
        _ => dev_tool_inputs("", "", support),
    }
}

/// Review D, L7: the developer tool is not part of the library. Nothing in the library names it, what it needs is only
/// in `dev_support` and `test_support`, both behind the `dev-tool` feature, and the manifest names no path but
/// native-auth's, so a copy without the tool's crate still builds.
#[test]
fn the_library_does_not_carry_the_developer_tool() {
    let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    assert!(!manifest_dir.join("src/bin").exists());
    let lib = &sources()["lib.rs"];
    let squeezed = squeeze(lib);
    assert!(!squeezed.contains("pubmoddev;") && !squeezed.contains("moddev;"));
    let gate = "#[cfg(feature=\"dev-tool\")]#[doc(hidden)]pubmod";
    assert!(squeezed.contains(&format!("{gate}dev_support;")), "{lib}");
    assert!(squeezed.contains(&format!("{gate}test_support;")), "{lib}");
    assert!(squeezed.contains("#[cfg(all(test,not(feature=\"dev-tool\")))]modtest_support;"));
    // Re-check, N5: the feature can't reach a release build (the tool is a debug build only).
    assert!(
        squeezed.contains("#[cfg(all(feature=\"dev-tool\",not(debug_assertions)))]compile_error!(")
    );
    // Re-check, N4: comments name the tool's real place.
    for (name, text) in [
        ("lib.rs", lib.as_str()),
        ("dev_support.rs", sources()["dev_support.rs"].as_str()),
    ] {
        assert!(!text.contains("src/bin"), "{name}");
    }
    let manifest = squeeze(&std::fs::read_to_string(manifest_dir.join("Cargo.toml")).unwrap());
    assert!(manifest.contains("[features]dev-tool=[]"), "{manifest}");
    assert!(
        !manifest.contains("default=") && !manifest.contains("[[bin]]"),
        "{manifest}"
    );
    assert_eq!(manifest.matches("path=").count(), 1, "{manifest}");
    assert!(manifest.contains("path=\"../native-auth\""), "{manifest}");
}

#[test]
fn the_identifier_check_finds_whole_words_only() {
    let word = ["Meth", "od"].concat();
    assert!(has_word(&format!("use x::{word} as V;"), &word));
    assert!(has_word(&format!("x::{word}::GET"), &word));
    assert!(!has_word(&format!("{word}s"), &word));
    assert!(!has_word(&format!("x.{}()", word.to_lowercase()), &word));
}

#[test]
fn the_only_request_this_crate_can_build_is_one_get_in_http_rs() {
    // The second line behind http.rs `allowed` (which checks every built request when it is sent): `scan_requests`
    // over every file of this crate and of the developer tool's crate when it's here. guard_tests.rs is the one file
    // left out: it builds wrong requests on purpose to prove `allowed` refuses them, and is compiled for tests only.
    let guard_tests = ["guard", "_tests.rs"].concat();
    let http = include_str!("http.rs");
    assert!(http.contains(&format!("#[path = \"{guard_tests}\"]")));
    let mut total = Built::default();
    for (name, text) in sources() {
        if name == guard_tests {
            continue;
        }
        let built = scan_requests(&name, &text);
        if name.starts_with(DEV_PREFIX) {
            assert_eq!(built, Built::default(), "{name}");
        }
        total.gets += built.gets;
        total.posts += built.posts;
        total.executes += built.executes;
    }
    assert_eq!(
        total,
        Built {
            gets: 1,
            posts: 0,
            executes: 1
        }
    );
}

#[test]
fn statuses_map_to_closed_words_and_redirects_are_refused() {
    let reply = |status| Reply::new(status, b"{}".to_vec());
    assert_eq!(status_error(&reply(200), ReadError::KeyRefused), None);
    assert_eq!(
        status_error(&reply(401), ReadError::KeyRefused),
        Some(ReadError::KeyRefused)
    );
    assert_eq!(
        status_error(&reply(403), ReadError::Refused),
        Some(ReadError::Refused)
    );
    assert_eq!(
        status_error(&reply(404), ReadError::KeyRefused),
        Some(ReadError::NotFound)
    );
    for status in [201, 204, 301, 302, 303, 307, 308, 400, 422, 500, 502, 503] {
        assert_eq!(
            status_error(&reply(status), ReadError::KeyRefused),
            Some(ReadError::Refused),
            "{status}"
        );
    }
    let limited = Reply::new(429, Vec::new()).with_retry_after("3600");
    assert_eq!(
        status_error(&limited, ReadError::Refused),
        Some(ReadError::RateLimited(Some(MAX_RETRY_AFTER)))
    );
    for (header, wait) in [
        ("5", Some(5)),
        ("60", Some(60)),
        ("61", Some(60)),
        ("999999", Some(60)),
        ("9999999", None),
        ("", None),
        ("-1", None),
        ("1.5", None),
        ("Wed, 21 Oct 2026 07:28:00 GMT", None),
    ] {
        let reply = Reply::new(429, Vec::new()).with_retry_after(header);
        assert_eq!(
            reply.retry_after(),
            wait.map(Duration::from_secs),
            "{header}"
        );
    }
}

/// A reader that gives `total` bytes, `step` at a time.
struct Bytes {
    left: usize,
    step: usize,
}
impl Read for Bytes {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.left.min(self.step).min(buf.len());
        buf[..n].fill(b' ');
        self.left -= n;
        Ok(n)
    }
}

#[test]
fn the_body_is_capped_and_read_against_the_deadline() {
    let later = Instant::now() + Duration::from_secs(30);
    assert_eq!(
        read_body_up_to(
            Bytes {
                left: MAX_BODY,
                step: 7000
            },
            later,
            MAX_BODY
        )
        .unwrap()
        .len(),
        MAX_BODY
    );
    assert_eq!(
        read_body_up_to(
            Bytes {
                left: MAX_BODY + 1,
                step: 7000
            },
            later,
            MAX_BODY
        )
        .unwrap_err(),
        ReadError::TooLarge
    );
    assert_eq!(
        read_body_up_to(
            Bytes {
                left: 10 * MAX_BODY,
                step: 64 * 1024
            },
            later,
            MAX_BODY
        )
        .unwrap_err(),
        ReadError::TooLarge
    );
    assert_eq!(
        read_body_up_to(Bytes { left: 10, step: 1 }, Instant::now(), MAX_BODY).unwrap_err(),
        ReadError::Timeout
    );
    // Work that outlasts its limit is given up on.
    let slow = within(Duration::from_millis(20), || {
        std::thread::sleep(Duration::from_millis(500));
        Ok(())
    });
    assert_eq!(slow.unwrap_err(), ReadError::Timeout);
}

#[test]
fn json_with_a_duplicate_key_anywhere_is_refused() {
    assert!(parse_json(br#"{"a":1,"b":[{"c":2}]}"#).is_ok());
    for text in [
        r#"{"a":1,"a":1}"#,
        r#"[{"id":"x","id":"y"}]"#,
        r#"{"a":{"b":{"c":1,"c":2}}}"#,
        "",
        "{",
        "[1,]",
        "not json",
    ] {
        assert_eq!(
            parse_json(text.as_bytes()).unwrap_err(),
            ReadError::InvalidResponse,
            "{text}"
        );
    }
}

#[test]
fn a_church_host_is_one_lower_case_label_under_a_fixed_domain() {
    let host = ChurchHost::new("cedarhollow", "breezechms.com").unwrap();
    assert_eq!(Origin::Church(host).host(), "cedarhollow.breezechms.com");
    for label in [
        "",
        "-cedar",
        "cedar-",
        "Cedar",
        "cedar.evil.com",
        "cedar/x",
        "cedar@x",
        "ced ar",
        &"a".repeat(64),
    ] {
        assert!(
            ChurchHost::new(label, "breezechms.com").is_none(),
            "{label}"
        );
    }
}

#[test]
fn a_reply_and_a_get_print_nothing_of_their_contents() {
    let reply = Reply::new(200, br#"[{"name":"Fictional Person"}]"#.to_vec());
    assert!(!format!("{reply:?}").contains("Fictional"));
    let get = Get::new(
        &crate::b1::Read::Groups,
        Auth::Bearer(crate::test_support::key()),
    );
    assert!(!format!("{get:?}").contains(&crate::test_support::key_text()));
    assert_eq!(get.limit(), REQUEST_LIMIT);
    assert_eq!(
        get.clone().with_limit(Duration::from_secs(99)).limit(),
        REQUEST_LIMIT
    );
    assert_eq!(
        get.with_limit(Duration::from_secs(2)).limit(),
        Duration::from_secs(2)
    );
}
