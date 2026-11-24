//! "A notice on your phone" in Settings (core/native-auth phone_notice.rs; owner decision 2026-11-16).
//! Off unless the leader turns it on. While on, the app's two notice commands (always_on.rs
//! `notify_ozzie`, main.rs `notify_sunday_attention`) call `also_to_phone` after showing the Mac's
//! notice: the same kind's fixed line goes to ntfy.sh on its own thread, so it never holds up or fails
//! the Mac's notice, and it goes whether or not the Mac's own notifications show it. The page decides
//! when a notice is sent (quiet hours, the person's Church rules on notices, Pause everything) exactly
//! as before: uncertain findings (Worth a look) bring no notice unless the person chose "Always tell me
//! right away" for that kind. Nothing here adds a moment of its own, except the leader's "Send a test
//! notice".
//!
//! The page may say a notice stays on this Mac (`local_only`: one only about a background check). It
//! can only take the phone line away, never add one: without it, the phone line goes as before.
//!
//! Every command here takes nothing from the page but the app itself: no text, no channel, no host,
//! no address. The channel lives in this Mac's Keychain (KEYCHAIN_SERVICE) and comes back to the page
//! only to be shown with a Copy button. What became of the last phone notice (a closed code and its
//! time) is kept in memory natively and shown in Settings.
use ozzie_native_auth::credentials::MacKeychain;
use ozzie_native_auth::phone_notice::{
    KEYCHAIN_SERVICE, LastNotice, Line, NtfyHttp, Outcome, PhoneError, PhoneNotice, PhoneView,
    wall_clock,
};
use std::sync::{Arc, OnceLock};
use tauri::Manager;

/// The phone notice for this app's data folder, made once. The test copy of Ozzie has none: nothing it does ever
/// reaches a phone, its Keychain item is never read or made, and turning it on says it is unavailable.
fn phone(app: &tauri::AppHandle) -> Result<&'static PhoneNotice, PhoneError> {
    static PHONE: OnceLock<PhoneNotice> = OnceLock::new();
    if ozzie_native_auth::variant::IS_TEST_COPY {
        return Err(PhoneError::Unavailable);
    }
    if let Some(phone) = PHONE.get() {
        return Ok(phone);
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| PhoneError::Unavailable)?;
    Ok(PHONE.get_or_init(|| {
        PhoneNotice::new(
            dir,
            Arc::new(MacKeychain {
                service: KEYCHAIN_SERVICE.into(),
            }),
            Arc::new(NtfyHttp::default()),
        )
    }))
}

/// Whether a notice's line goes to the phone: always, unless the page said it stays on this Mac.
pub fn goes_to_phone(local_only: Option<bool>) -> bool {
    local_only != Some(true)
}

/// The same moment on the leader's phone, while that is on: `line`, on its own thread, one attempt,
/// unless the page said this notice stays on this Mac. Whatever happens there, the Mac's notice has
/// already been sent; what became of it is kept natively for Settings.
pub fn also_to_phone(app: &tauri::AppHandle, line: Line, local_only: Option<bool>) {
    if !goes_to_phone(local_only) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        if let Ok(phone) = phone(&app) {
            let _ = phone.send(line);
        }
    });
}

/// At start, before the page asks: while off, a channel left behind is forgotten.
pub fn setup(app: &tauri::App) {
    let handle = app.handle().clone();
    std::thread::spawn(move || {
        if let Ok(phone) = phone(&handle) {
            let _ = phone.startup();
        }
    });
}

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    tauri::async_runtime::spawn_blocking(work).await.ok()
}

/// Whether it's on, the channel to subscribe to, and what became of the last phone notice. Off reads
/// nothing from the Keychain.
#[tauri::command]
pub async fn phone_notice_status(app: tauri::AppHandle) -> PhoneView {
    blocking(move || phone(&app).map(PhoneNotice::status))
        .await
        .and_then(Result::ok)
        .unwrap_or(PhoneView {
            on: false,
            channel: None,
            last: None,
        })
}

/// Turning it on: Ozzie makes the channel itself.
#[tauri::command]
pub async fn phone_notice_on(app: tauri::AppHandle) -> Result<PhoneView, PhoneError> {
    blocking(move || phone(&app)?.turn_on())
        .await
        .unwrap_or(Err(PhoneError::Unavailable))
}

/// "Make a new channel": the old one gets nothing more.
#[tauri::command]
pub async fn phone_notice_new_channel(app: tauri::AppHandle) -> Result<PhoneView, PhoneError> {
    blocking(move || phone(&app)?.new_channel())
        .await
        .unwrap_or(Err(PhoneError::Unavailable))
}

/// Turning it off: nothing more is sent, and the channel is forgotten.
#[tauri::command]
pub async fn phone_notice_off(app: tauri::AppHandle) -> Result<(), PhoneError> {
    blocking(move || phone(&app)?.turn_off())
        .await
        .unwrap_or(Err(PhoneError::Unavailable))
}

/// "Send a test notice": the fixed test line, once, and what ntfy.sh made of it and when (also kept
/// as the last phone notice).
#[tauri::command]
pub async fn phone_notice_test(app: tauri::AppHandle) -> LastNotice {
    let unavailable = || LastNotice {
        outcome: Outcome::Unavailable,
        at_ms: wall_clock(),
    };
    blocking(move || {
        phone(&app)
            .map(|phone| phone.send_noted(Line::Test))
            .unwrap_or_else(|_| unavailable())
    })
    .await
    .unwrap_or_else(unavailable)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A Rust file's code without its comments, so words in an explanation don't count. Only real
    /// comments go: `//` and `/* */` outside string and character literals, so the text after
    /// "https://" in a string is still code.
    fn code(source: &str) -> String {
        let chars: Vec<char> = source.chars().collect();
        let mut out = String::with_capacity(source.len());
        let mut i = 0;
        while i < chars.len() {
            let c = chars[i];
            let next = chars.get(i + 1).copied();
            if c == '/' && next == Some('/') {
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
                continue;
            }
            if c == '/' && next == Some('*') {
                let mut depth = 0;
                while i < chars.len() {
                    if chars[i] == '/' && chars.get(i + 1) == Some(&'*') {
                        depth += 1;
                        i += 2;
                    } else if chars[i] == '*' && chars.get(i + 1) == Some(&'/') {
                        depth -= 1;
                        i += 2;
                        if depth == 0 {
                            break;
                        }
                    } else {
                        if chars[i] == '\n' {
                            out.push('\n');
                        }
                        i += 1;
                    }
                }
                continue;
            }
            // A raw string: r"..." or r#"..."#, kept whole.
            let raw_start = c == 'r'
                && (i == 0 || !(chars[i - 1].is_alphanumeric() || chars[i - 1] == '_'))
                && matches!(next, Some('"') | Some('#'));
            if raw_start {
                let mut j = i + 1;
                let mut hashes = 0;
                while chars.get(j) == Some(&'#') {
                    hashes += 1;
                    j += 1;
                }
                if chars.get(j) == Some(&'"') {
                    let close: String = std::iter::once('"')
                        .chain(std::iter::repeat_n('#', hashes))
                        .collect();
                    let rest: String = chars[j + 1..].iter().collect();
                    let end = rest.find(&close).map_or(chars.len(), |at| {
                        j + 1 + rest[..at].chars().count() + close.chars().count()
                    });
                    out.extend(&chars[i..end]);
                    i = end;
                    continue;
                }
            }
            if c == '"' {
                out.push(c);
                i += 1;
                while i < chars.len() {
                    out.push(chars[i]);
                    if chars[i] == '\\' {
                        if let Some(escaped) = chars.get(i + 1) {
                            out.push(*escaped);
                        }
                        i += 2;
                        continue;
                    }
                    i += 1;
                    if chars[i - 1] == '"' {
                        break;
                    }
                }
                continue;
            }
            // A character literal ('"', '\'', '/'); a lifetime ('a) is left as it is.
            if c == '\'' {
                let literal = if next == Some('\\') {
                    (i + 3..chars.len().min(i + 12))
                        .find(|&k| chars[k] == '\'')
                        .map(|k| k + 1)
                } else if chars.get(i + 2) == Some(&'\'') {
                    Some(i + 3)
                } else {
                    None
                };
                if let Some(end) = literal {
                    out.extend(&chars[i..end]);
                    i = end;
                    continue;
                }
            }
            out.push(c);
            i += 1;
        }
        out
    }
    /// Each command function in `source` (before its tests): its name and its parameter list.
    fn commands(source: &str) -> Vec<(String, String)> {
        source
            .split("#[cfg(test)]")
            .next()
            .unwrap()
            .split("#[tauri::command]")
            .skip(1)
            .map(|rest| {
                let signature = rest.split('{').next().unwrap();
                let name = signature
                    .split("fn ")
                    .nth(1)
                    .unwrap()
                    .split('(')
                    .next()
                    .unwrap()
                    .trim()
                    .to_owned();
                let params = signature
                    .split_once('(')
                    .unwrap()
                    .1
                    .split_once(')')
                    .unwrap()
                    .0
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ")
                    .trim_end_matches(',')
                    .to_owned();
                (name, params)
            })
            .collect()
    }
    /// Every Rust file of the app (src-tauri/src and below), by its path under src.
    fn app_sources() -> Vec<(String, String)> {
        fn walk(dir: &std::path::Path, base: &std::path::Path, out: &mut Vec<(String, String)>) {
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    walk(&path, base, out);
                } else if path.extension().is_some_and(|e| e == "rs") {
                    let name = path
                        .strip_prefix(base)
                        .unwrap()
                        .to_string_lossy()
                        .into_owned();
                    out.push((name, std::fs::read_to_string(&path).unwrap()));
                }
            }
        }
        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut out = Vec::new();
        walk(&src, &src, &mut out);
        out.sort();
        out
    }

    #[test]
    fn comments_are_left_out_but_text_after_https_in_a_string_is_still_code() {
        let source = concat!(
            "let url = \"https://ntfy.sh/x\"; also_to_phone(&app); // also_to_phone( in a comment\n",
            "/// also_to_phone( in a doc comment\n",
            "//! also_to_phone( in a module comment\n",
            "/* also_to_phone( in a block */ let raw = r#\"// still \"code\" also_to_phone(\"#;\n",
            "let quote = '\"'; let slash = '/'; let tick = '\\''; fn f<'a>(x: &'a str) {} let s = \"\\\"// x\"; // gone\n",
        );
        let kept = code(source);
        assert_eq!(kept.matches("also_to_phone(").count(), 2, "{kept}");
        assert!(kept.contains("\"https://ntfy.sh/x\"; also_to_phone(&app);"));
        assert!(kept.contains("r#\"// still \"code\" also_to_phone(\"#"));
        assert!(kept.contains("let s = \"\\\"// x\";"));
        assert!(kept.contains("let tick = '\\''; fn f<'a>(x: &'a str) {}"));
        for gone in [
            "in a comment",
            "doc comment",
            "module comment",
            "in a block",
            "gone",
        ] {
            assert!(!kept.contains(gone), "{gone}");
        }
        assert_eq!(kept.lines().count(), source.lines().count());
    }

    #[test]
    fn the_page_can_pass_no_text_channel_host_or_address() {
        let found = commands(include_str!("phone_notice.rs"));
        assert_eq!(
            found
                .iter()
                .map(|(name, _)| name.as_str())
                .collect::<Vec<_>>(),
            [
                "phone_notice_status",
                "phone_notice_on",
                "phone_notice_new_channel",
                "phone_notice_off",
                "phone_notice_test"
            ]
        );
        for (name, params) in &found {
            assert_eq!(params, "app: tauri::AppHandle", "{name}");
        }
        // The two notice commands: one names a kind of a closed set, and each may only say "this Mac
        // only": a yes or no, never text.
        let notices = commands(include_str!("always_on.rs"));
        let notify = notices.iter().find(|(n, _)| n == "notify_ozzie").unwrap();
        assert_eq!(
            notify.1,
            "app: tauri::AppHandle, kind: String, local_only: Option<bool>"
        );
        let main = commands(include_str!("main.rs"));
        let sunday = main
            .iter()
            .find(|(n, _)| n == "notify_sunday_attention")
            .unwrap();
        // The coverage notice also names its day, a closed word mapped natively to one fixed line
        // (`Line::attention`), never shown as given.
        assert_eq!(
            sunday.1,
            "app: tauri::AppHandle, local_only: Option<bool>, day: Option<String>"
        );
        assert!(include_str!("main.rs").contains(
            "let line = Line::attention(day.as_deref().unwrap_or(\"service\")).ok_or(\"invalid-day\")?;"
        ));
        // Every command is registered, and nothing else in the app sends to a phone.
        let registered = include_str!("main.rs");
        for (name, _) in &found {
            assert!(
                registered.contains(&format!("phone_notice::{name},")),
                "{name}"
            );
        }
    }

    #[test]
    fn the_page_can_only_keep_a_notice_off_the_phone_never_add_one() {
        assert!(goes_to_phone(None));
        assert!(goes_to_phone(Some(false)));
        assert!(!goes_to_phone(Some(true)));
        // `also_to_phone` asks first, before anything else.
        let here = code(include_str!("phone_notice.rs"));
        let body = here
            .split("pub fn also_to_phone(")
            .nth(1)
            .unwrap()
            .split("\n}\n")
            .next()
            .unwrap();
        let ask = body.find("if !goes_to_phone(local_only) {\n        return;\n    }");
        assert!(ask.is_some_and(|at| at < body.find("thread::spawn").unwrap()));
    }

    #[test]
    fn the_phone_hears_only_the_mac_notices_and_the_test_notice() {
        // `also_to_phone` is called once in each notice command, after its Mac notice, with the page's
        // "this Mac only", and nowhere else in the app.
        let always_on = code(include_str!("always_on.rs"));
        let main = code(include_str!("main.rs"));
        for (source, command, call) in [
            (
                &always_on,
                "pub fn notify_ozzie(",
                "crate::phone_notice::also_to_phone(&app, line, local_only);",
            ),
            (
                &main,
                "fn notify_sunday_attention(",
                "phone_notice::also_to_phone(&app, line, local_only);",
            ),
        ] {
            let body = source
                .split(command)
                .nth(1)
                .unwrap()
                .split("\n}\n")
                .next()
                .unwrap();
            assert_eq!(body.matches("also_to_phone(").count(), 1, "{command}");
            assert!(body.contains(call), "{command}");
            assert!(
                body.find(".show()").unwrap() < body.find("also_to_phone(").unwrap(),
                "{command}: the Mac's notice first"
            );
        }
        // Every call in the app, found by reading every file whole (tests included): the two above.
        // This file's own tests name it in their strings, so only its code before them counts.
        let calls: Vec<(String, usize)> = app_sources()
            .into_iter()
            .map(|(name, source)| {
                let code = code(&source);
                let code = if name == "phone_notice.rs" {
                    code.split("#[cfg(test)]\nmod tests")
                        .next()
                        .unwrap()
                        .to_owned()
                } else {
                    code
                };
                (name, code.matches("also_to_phone(").count())
            })
            .filter(|(_, n)| *n > 0)
            .collect();
        assert_eq!(
            calls,
            [
                ("always_on.rs".to_owned(), 1),
                ("main.rs".to_owned(), 1),
                // Its own definition.
                ("phone_notice.rs".to_owned(), 1)
            ]
        );
        assert!(
            code(include_str!("phone_notice.rs"))
                .contains("pub fn also_to_phone(app: &tauri::AppHandle, line: Line, local_only")
        );
        // Only the test notice sends from this file, and only the test line.
        let here = code(include_str!("phone_notice.rs"));
        let here = here.split("mod tests").next().unwrap();
        assert_eq!(here.matches(".send").count(), 2);
        assert_eq!(here.matches(".send_noted(Line::Test)").count(), 1);
        assert_eq!(here.matches(".send(line)").count(), 1);
        // The menu bar's own notice (Pause everything couldn't change) answers a click on this Mac:
        // it isn't sent to the phone.
        let menu = always_on
            .split("fn toggle_pause_from_menu(")
            .nth(1)
            .unwrap()
            .split("\n}\n")
            .next()
            .unwrap();
        assert!(!menu.contains("also_to_phone"));
    }

    #[test]
    fn each_phone_line_is_the_mac_notice_of_the_same_kind() {
        for kind in [
            "briefing-ready",
            "needs-decision",
            "checked",
            "couldnt-check",
        ] {
            assert_eq!(
                Line::for_notice(kind).map(Line::text),
                crate::always_on::notice_body(kind),
                "{kind}"
            );
        }
        for other in ["", "Avery declined Greeter", "sunday-attention", "test"] {
            assert_eq!(Line::for_notice(other), None);
            assert_eq!(crate::always_on::notice_body(other), None);
        }
        assert_eq!(Line::SundayAttention.text(), crate::SUNDAY_NOTICE_BODY);
        assert_eq!(
            ozzie_native_auth::phone_notice::TITLE,
            crate::always_on::NOTICE_TITLE
        );
    }

    #[test]
    fn the_channel_is_never_logged_written_or_put_in_the_task_record() {
        let here = code(include_str!("phone_notice.rs"));
        let here = here.split("mod tests").next().unwrap();
        let core = code(include_str!(
            "../../../../core/native-auth/src/phone_notice.rs"
        ));
        let core = core.split("mod tests;").next().unwrap();
        for source in [here, core] {
            for refused in [
                "println!",
                "eprintln!",
                "dbg!",
                "log::",
                "tracing::",
                "Ledger",
                "ledger",
                "recording",
                "fs::write",
                "std::env::args",
                "Command::new",
                "emit(",
            ] {
                assert!(!source.contains(refused), "{refused}");
            }
        }
        // The only file the core writes is the empty marker.
        assert_eq!(core.matches(".open(").count(), 1);
        assert!(core.contains("options.open(dir.join(ON_FILE))?.sync_all()"));
        // What Settings is told about the last phone notice is a code and a time, never the channel.
        let last = core
            .split("pub struct LastNotice {")
            .nth(1)
            .unwrap()
            .split('}')
            .next()
            .unwrap();
        assert_eq!(
            last.split_whitespace().collect::<Vec<_>>().join(" "),
            "pub outcome: Outcome, pub at_ms: u64,"
        );
        // The channel is kept under its own Keychain service, nowhere else.
        // (In the test copy of Ozzie, with its prefix: native-auth variant.rs.)
        assert_eq!(
            KEYCHAIN_SERVICE,
            if ozzie_native_auth::variant::IS_TEST_COPY {
                "church.ozzie.desktop.test/church.ozzie.phone-notice.v1"
            } else {
                "church.ozzie.phone-notice.v1"
            }
        );
    }
}
