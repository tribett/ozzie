//! "Open in Mail" and "Open in Messages" on a drafted note: opens a new, unsent message in the
//! Mac's mail app (a `mailto:` address) or in Messages (an `sms:` address) holding the draft, for
//! the person to address, check and send themselves. Ozzie never sends anything. A `mailto:`
//! address opens in whichever email app the person set on this Mac (Apple Mail or another one),
//! and the reply names that app so the page never says "Mail" when it was something else.
//!
//! The page hands over only the draft's words (and a subject line, which no draft has yet), never
//! an address or a scheme: the address is built here, always starting `mailto:?` or `sms:&`, with
//! every character of the words percent-encoded, so nothing in a draft can make this open anything
//! else. No recipient is ever filled in: Ozzie reads no email address or phone number from
//! Planning Center, and nothing is looked up for this. The words are opened in this process
//! (NSWorkspace), never passed to another program's arguments, and are not kept or logged.
use std::fmt::Write as _;

/// A draft longer than this isn't handed over (none of Ozzie's notes come near it).
pub const MAX_DRAFT_CHARS: usize = 10_000;
pub const MAX_SUBJECT_CHARS: usize = 200;
/// The longest address handed to each app, once encoded. Messages gets a shorter one: a text
/// message isn't the place for a long letter.
pub const MAX_MAIL_URL_BYTES: usize = 32 * 1024;
pub const MAX_MESSAGES_URL_BYTES: usize = 8 * 1024;

/// The only two places a draft can be opened. Anything else from the page is refused when the
/// command's arguments are read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DraftApp {
    Mail,
    Messages,
}

/// What the page is told after an open: the name of the app that holds the new message (its
/// name on this Mac, like "Mail" or "Messages"), never the draft.
#[derive(Debug, PartialEq, Eq, serde::Serialize)]
pub struct DraftOpened {
    pub app: String,
}
impl DraftApp {
    /// Said when the app's own name can't be read.
    fn usual_name(self) -> &'static str {
        match self {
            DraftApp::Mail => "Mail",
            DraftApp::Messages => "Messages",
        }
    }
}
/// An app's file name (without `.app`) as the page may show it: one line of ordinary characters,
/// at most 64, or nothing.
pub fn shown_app_name(name: &str) -> Option<String> {
    let name = name.trim();
    let plain = !name.is_empty()
        && name.chars().count() <= 64
        && !name.chars().any(|c| {
            c.is_control()
                || matches!(c, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}')
        });
    plain.then(|| name.to_string())
}

/// Closed codes only; never the draft's words.
#[derive(Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DraftOpenError {
    /// Empty, or holding control characters a note never has.
    InvalidInput,
    TooLong,
    /// The Mac has no app for it, or the app didn't open.
    NotOpened,
    Unavailable,
}

/// Unreserved characters (RFC 3986) stay; every other byte of the UTF-8 text is percent-encoded,
/// so `&`, `?`, `#`, `%`, `+`, `=`, spaces, emoji and accented names all arrive as written.
fn encode(text: &str, newline: &str, out: &mut String) {
    let mut buf = [0u8; 4];
    for ch in text.chars() {
        if ch == '\n' {
            out.push_str(newline);
            continue;
        }
        for byte in ch.encode_utf8(&mut buf).bytes() {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
                out.push(char::from(byte));
            } else {
                let _ = write!(out, "%{byte:02X}");
            }
        }
    }
}

/// Words a person could have written: not blank, within the length, and no control characters
/// other than line breaks and tabs. Line breaks become `\n`.
fn plain(text: &str, max_chars: usize, line_breaks: bool) -> Result<String, DraftOpenError> {
    if text.trim().is_empty() {
        return Err(DraftOpenError::InvalidInput);
    }
    if text.chars().count() > max_chars {
        return Err(DraftOpenError::TooLong);
    }
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    if text
        .chars()
        .any(|c| c.is_control() && !(c == '\t' || (line_breaks && c == '\n')))
    {
        return Err(DraftOpenError::InvalidInput);
    }
    Ok(text)
}

/// The address that opens `body` as a new, unsent message with no recipient.
/// Mail: `mailto:?subject=…&body=…`, line breaks as CRLF (RFC 6068). Messages: `sms:&body=…`,
/// the form Apple's Messages reads a body from when no number is given.
pub fn draft_url(
    app: DraftApp,
    body: &str,
    subject: Option<&str>,
) -> Result<String, DraftOpenError> {
    let body = plain(body, MAX_DRAFT_CHARS, true)?;
    let mut url = String::new();
    match app {
        DraftApp::Mail => {
            url.push_str("mailto:?");
            if let Some(subject) = subject {
                url.push_str("subject=");
                encode(&plain(subject, MAX_SUBJECT_CHARS, false)?, "", &mut url);
                url.push('&');
            }
            url.push_str("body=");
            encode(&body, "%0D%0A", &mut url);
        }
        DraftApp::Messages => {
            // A text message has no subject line; one is refused rather than dropped.
            if subject.is_some() {
                return Err(DraftOpenError::InvalidInput);
            }
            url.push_str("sms:&body=");
            encode(&body, "%0A", &mut url);
        }
    }
    let max = match app {
        DraftApp::Mail => MAX_MAIL_URL_BYTES,
        DraftApp::Messages => MAX_MESSAGES_URL_BYTES,
    };
    if url.len() > max {
        return Err(DraftOpenError::TooLong);
    }
    Ok(url)
}

/// The address as Foundation reads it, only when its scheme is still `mailto` or `sms`.
#[cfg(target_os = "macos")]
fn draft_ns_url(url: &str) -> Option<objc2::rc::Retained<objc2_foundation::NSURL>> {
    use objc2_foundation::{NSString, NSURL};
    let url = NSURL::URLWithString(&NSString::from_str(url))?;
    let scheme = url.scheme()?.to_string();
    (scheme == "mailto" || scheme == "sms").then_some(url)
}
/// The app this Mac opens the address with, if any (`None`), with its file name when that reads
/// cleanly.
#[cfg(target_os = "macos")]
fn handler_for(url: &objc2_foundation::NSURL) -> Option<Option<String>> {
    use objc2_app_kit::NSWorkspace;
    let app = NSWorkspace::sharedWorkspace().URLForApplicationToOpenURL(url)?;
    Some(
        app.to_file_path()
            .and_then(|path| path.file_stem()?.to_str().and_then(shown_app_name)),
    )
}
/// Asks macOS to open the address with the app set for it: `Err` when there is none or it fails,
/// otherwise that app's name when it reads cleanly.
#[cfg(target_os = "macos")]
fn open_url(url: &str) -> Result<Option<String>, ()> {
    use objc2_app_kit::NSWorkspace;
    let url = draft_ns_url(url).ok_or(())?;
    let name = handler_for(&url).ok_or(())?;
    if NSWorkspace::sharedWorkspace().openURL(&url) {
        Ok(name)
    } else {
        Err(())
    }
}
#[cfg(not(target_os = "macos"))]
fn open_url(_url: &str) -> Result<Option<String>, ()> {
    Err(())
}

/// "Open in Mail" / "Open in Messages": opens the draft as a new, unsent message and says which
/// app it opened in.
#[tauri::command]
pub async fn open_draft(
    handle: tauri::AppHandle,
    app: DraftApp,
    body: String,
    subject: Option<String>,
) -> Result<DraftOpened, DraftOpenError> {
    let url = draft_url(app, &body, subject.as_deref())?;
    drop(body);
    let (send, receive) = std::sync::mpsc::channel();
    handle
        .run_on_main_thread(move || {
            let _ = send.send(open_url(&url));
        })
        .map_err(|_| DraftOpenError::Unavailable)?;
    let opened = tauri::async_runtime::spawn_blocking(move || receive.recv().unwrap_or(Err(())))
        .await
        .map_err(|_| DraftOpenError::Unavailable)?;
    match opened {
        Ok(name) => Ok(DraftOpened {
            app: name.unwrap_or_else(|| app.usual_name().to_string()),
        }),
        Err(()) => Err(DraftOpenError::NotOpened),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Decodes a percent-encoded value, failing on anything not encoded the way `encode` does.
    fn decode(value: &str) -> String {
        let bytes = value.as_bytes();
        let mut out = Vec::new();
        let mut at = 0;
        while at < bytes.len() {
            if bytes[at] == b'%' {
                let hex = std::str::from_utf8(&bytes[at + 1..at + 3]).unwrap();
                assert_eq!(hex, hex.to_uppercase());
                out.push(u8::from_str_radix(hex, 16).unwrap());
                at += 3;
            } else {
                let b = bytes[at];
                assert!(b.is_ascii_alphanumeric() || b"-._~".contains(&b), "{value}");
                out.push(b);
                at += 1;
            }
        }
        String::from_utf8(out).unwrap()
    }
    /// Fictional note with every character that needs care in an address.
    const NOTE: &str =
        "Hi Zoë & José,\n\nCould you cover nursery? 9:30 #2 — 100% thanks 🙏 a+b=c\n\nPat";

    #[test]
    fn mail_opens_a_new_message_with_the_draft_and_no_recipient() {
        let url = draft_url(DraftApp::Mail, NOTE, None).unwrap();
        let body = url.strip_prefix("mailto:?body=").unwrap();
        assert!(!body.contains(['&', '?', '#', '=', '+', ' ', '\n', '@', ':']));
        assert_eq!(decode(body), NOTE.replace('\n', "\r\n"));
        assert!(url.contains("Zo%C3%AB%20%26%20Jos%C3%A9"));
        assert!(url.contains("%F0%9F%99%8F"));
        assert!(url.contains("%0D%0A%0D%0ACould"));
    }

    #[test]
    fn messages_opens_a_new_message_with_the_draft_and_no_recipient() {
        let url = draft_url(DraftApp::Messages, NOTE, None).unwrap();
        let body = url.strip_prefix("sms:&body=").unwrap();
        assert_eq!(decode(body), NOTE);
        assert!(url.contains("%0A%0ACould"));
    }

    #[test]
    fn a_subject_goes_to_mail_only_and_on_one_line() {
        let url = draft_url(DraftApp::Mail, "Hi", Some("Sunday & nursery?")).unwrap();
        assert_eq!(url, "mailto:?subject=Sunday%20%26%20nursery%3F&body=Hi");
        assert_eq!(
            draft_url(DraftApp::Mail, "Hi", Some("Two\nlines")),
            Err(DraftOpenError::InvalidInput)
        );
        assert_eq!(
            draft_url(DraftApp::Messages, "Hi", Some("Sunday")),
            Err(DraftOpenError::InvalidInput)
        );
    }

    #[test]
    fn only_a_mailto_or_sms_address_can_ever_be_built() {
        // Words that look like addresses or try to end the body stay words inside it.
        for words in [
            "file:///etc/hosts",
            "javascript:alert(1)",
            "x&to=someone@example.invalid&cc=other@example.invalid",
            "?body=other#frag",
            "https://example.invalid/%0A",
            "\u{202E}gnp.exe",
        ] {
            for app in [DraftApp::Mail, DraftApp::Messages] {
                let url = draft_url(app, words, None).unwrap();
                let (prefix, body) = match app {
                    DraftApp::Mail => ("mailto:?body=", url.strip_prefix("mailto:?body=")),
                    DraftApp::Messages => ("sms:&body=", url.strip_prefix("sms:&body=")),
                };
                let body = body.unwrap_or_else(|| panic!("{url} must start {prefix}"));
                assert_eq!(decode(body), words);
            }
        }
    }

    #[test]
    fn line_breaks_of_any_kind_arrive_as_line_breaks() {
        let url = draft_url(DraftApp::Messages, "a\r\nb\rc\nd", None).unwrap();
        assert_eq!(url, "sms:&body=a%0Ab%0Ac%0Ad");
        let url = draft_url(DraftApp::Mail, "a\r\nb", None).unwrap();
        assert_eq!(url, "mailto:?body=a%0D%0Ab");
        assert_eq!(
            draft_url(DraftApp::Mail, "a\tb", None).unwrap(),
            "mailto:?body=a%09b"
        );
    }

    #[test]
    fn blank_or_control_characters_are_refused() {
        for words in [
            "",
            "   \n\t",
            "Hi\0there",
            "Hi\u{7}",
            "Hi\u{1b}[31m",
            "Hi\u{85}",
        ] {
            for app in [DraftApp::Mail, DraftApp::Messages] {
                assert_eq!(
                    draft_url(app, words, None),
                    Err(DraftOpenError::InvalidInput),
                    "{words:?}"
                );
            }
        }
    }

    #[test]
    fn a_draft_too_long_to_hand_over_is_refused_not_cut() {
        assert_eq!(
            draft_url(DraftApp::Mail, &"a".repeat(MAX_DRAFT_CHARS + 1), None),
            Err(DraftOpenError::TooLong)
        );
        // Plain letters: the length decides.
        let mail = draft_url(DraftApp::Mail, &"a".repeat(MAX_DRAFT_CHARS), None).unwrap();
        assert!(mail.len() <= MAX_MAIL_URL_BYTES);
        let fits = MAX_MESSAGES_URL_BYTES - "sms:&body=".len();
        assert!(draft_url(DraftApp::Messages, &"a".repeat(fits), None).is_ok());
        assert_eq!(
            draft_url(DraftApp::Messages, &"a".repeat(fits + 1), None),
            Err(DraftOpenError::TooLong)
        );
        // Encoded size counts: 3,000 emoji are 36,000 encoded bytes, too long for either app.
        let emoji = "🙏".repeat(3_000);
        assert_eq!(
            draft_url(DraftApp::Mail, &emoji, None),
            Err(DraftOpenError::TooLong)
        );
        assert_eq!(
            draft_url(DraftApp::Messages, &emoji, None),
            Err(DraftOpenError::TooLong)
        );
        assert_eq!(
            draft_url(
                DraftApp::Mail,
                "Hi",
                Some(&"s".repeat(MAX_SUBJECT_CHARS + 1))
            ),
            Err(DraftOpenError::TooLong)
        );
    }

    /// Foundation reads every address built here, scheme unchanged, whatever the words; nothing is
    /// opened. Anything else never gets as far as NSWorkspace.
    #[cfg(target_os = "macos")]
    #[test]
    fn foundation_reads_the_address_as_mailto_or_sms() {
        for words in [
            NOTE,
            "file:///etc/hosts",
            "x&to=someone@example.invalid",
            "🙏",
        ] {
            for (app, scheme) in [(DraftApp::Mail, "mailto"), (DraftApp::Messages, "sms")] {
                let url = draft_ns_url(&draft_url(app, words, None).unwrap()).unwrap();
                assert_eq!(url.scheme().unwrap().to_string(), scheme);
            }
        }
        for other in [
            "file:///etc/hosts",
            "https://example.invalid",
            "x-apple.systempreferences:",
        ] {
            assert!(draft_ns_url(other).is_none(), "{other}");
        }
    }

    /// Looked up only, nothing opened: every Mac has an app for both addresses, and its name is
    /// what the page will say.
    #[cfg(target_os = "macos")]
    #[test]
    fn this_mac_names_the_app_each_address_opens_in() {
        for app in [DraftApp::Mail, DraftApp::Messages] {
            let url = draft_ns_url(&draft_url(app, "Hi", None).unwrap()).unwrap();
            let name = handler_for(&url).expect("an app for the address");
            assert!(name.is_some_and(|n| shown_app_name(&n) == Some(n.clone())));
        }
    }

    #[test]
    fn only_a_plain_app_name_is_shown() {
        assert_eq!(shown_app_name("Mail"), Some("Mail".into()));
        assert_eq!(
            shown_app_name(" Zoho Mail - Desktop "),
            Some("Zoho Mail - Desktop".into())
        );
        for odd in [
            "",
            "  ",
            "Mail\nSent",
            "Mail\u{202E}liaM",
            "\u{200B}",
            &"a".repeat(65),
        ] {
            assert_eq!(shown_app_name(odd), None, "{odd:?}");
        }
        assert_eq!(
            serde_json::to_string(&DraftOpened { app: "Mail".into() }).unwrap(),
            r#"{"app":"Mail"}"#
        );
        assert_eq!(DraftApp::Mail.usual_name(), "Mail");
        assert_eq!(DraftApp::Messages.usual_name(), "Messages");
    }

    #[test]
    fn the_page_can_name_only_mail_or_messages() {
        let app = |s: &str| serde_json::from_str::<DraftApp>(s);
        assert_eq!(app("\"mail\"").unwrap(), DraftApp::Mail);
        assert_eq!(app("\"messages\"").unwrap(), DraftApp::Messages);
        for other in [
            "\"Mail\"",
            "\"mailto:\"",
            "\"sms\"",
            "\"file\"",
            "\"https\"",
            "1",
            "null",
        ] {
            assert!(app(other).is_err(), "{other}");
        }
        let codes = [
            DraftOpenError::InvalidInput,
            DraftOpenError::TooLong,
            DraftOpenError::NotOpened,
            DraftOpenError::Unavailable,
        ]
        .map(|e| serde_json::to_string(&e).unwrap());
        assert_eq!(
            codes,
            [
                "\"invalid-input\"",
                "\"too-long\"",
                "\"not-opened\"",
                "\"unavailable\""
            ]
        );
    }
}
