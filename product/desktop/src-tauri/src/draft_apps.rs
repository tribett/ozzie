//! "Open in Mail" and "Open in Messages" on a drafted note: opens a new, unsent message in the
//! Mac's mail app (a `mailto:` address) or in Messages (an `sms:` address) holding the draft, for
//! the person to address, check and send themselves. Ozzie never sends anything. A `mailto:`
//! address opens in whichever email app the person set on this Mac (Apple Mail or another one),
//! and the reply names that app (`app_name_for`, from the bare scheme), or says "your email app" /
//! "your messages app" when its name can't be read, so the page never says "Mail" when it was
//! something else.
//!
//! The page hands over only the draft's words (and a subject line, which no draft has yet), never
//! an address or a scheme: the address is built here, always starting `mailto:?` or `sms:&`, with
//! every character of the words percent-encoded, so nothing in a draft can make this open anything
//! else. `open_draft` never fills in a recipient. The words are opened in this process
//! (NSWorkspace), never passed to another program's arguments, and are not kept or logged.
//!
//! `open_draft_to` (owner decisions, 2026-11-16 night) opens a note prepared for one person on the
//! Sunday page with that person in To. The page adds only which person, by the Planning Center id
//! the check it was shown holds. Core `contact` does the rest that touches the detail: it takes the
//! connection's turn (never beside a Sunday check), reads and checks the email address or mobile
//! number (one GET, for someone a check of the church in use showed, within its deadline), builds
//! the address from the draft's own and the reply. This file builds the draft's address as for
//! `open_draft`, hands core's `Address` to the one function that opens it (`open_url_to`, which
//! has Foundation read it back with exactly the recipients core says, and says nothing back but
//! whether it opened), names the app from the scheme alone (`app_name_for`, never handed the
//! address), and returns core's reply: whether To was filled in and, if not, a closed reason,
//! never the address or number, which is not kept, logged or put in any reply or error. Nothing
//! here keeps anything between calls (no static or shared cell), checked by its structure test.
use ozzie_native_auth::contact::{
    self, Address, AddressError, AppName, CheckedPeople, ContactKind, NoRecipient, NotOpened,
    Opened, Recipient,
};
use ozzie_native_auth::oauth::numeric_id;

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

/// What the page is told after `open_draft`: the app that holds the new message, named as
/// `open_draft_to` names it (the app this Mac opens a bare `mailto:` or `sms:` link with, like
/// "Mail" or "Microsoft Outlook", or "your email app" / "your messages app" when its name can't be
/// read), never the draft.
#[derive(Debug, PartialEq, Eq, serde::Serialize)]
pub struct DraftOpened {
    pub app: AppName,
}
/// The reply for a draft opened in `app`'s kind of app: the name `app_name_for` read, or the neutral
/// one.
fn opened_in(app: DraftApp, name: Option<AppName>) -> DraftOpened {
    DraftOpened {
        app: name.unwrap_or_else(|| AppName::neutral(app.contact())),
    }
}
impl DraftApp {
    /// What a note opened here is addressed with: Mail an email address, Messages a mobile number.
    fn contact(self) -> ContactKind {
        match self {
            DraftApp::Mail => ContactKind::Email,
            DraftApp::Messages => ContactKind::Mobile,
        }
    }
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
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
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
                out.push('%');
                out.push(char::from(HEX[usize::from(byte >> 4)]));
                out.push(char::from(HEX[usize::from(byte & 0x0F)]));
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

/// The address `open_draft_to` opens, made by core from the draft's own address (`unaddressed`, as
/// `draft_url` built it) and the read: the person in To, or nobody and why. Too long once addressed
/// is `too-long`, and nothing opens.
fn prepare(
    app: DraftApp,
    unaddressed: &str,
    read: Result<Recipient, NoRecipient>,
) -> Result<Address, DraftOpenError> {
    let max = match app {
        DraftApp::Mail => MAX_MAIL_URL_BYTES,
        DraftApp::Messages => MAX_MESSAGES_URL_BYTES,
    };
    contact::address(unaddressed, max, read).map_err(|error| match error {
        AddressError::TooLong => DraftOpenError::TooLong,
        AddressError::NotADraft => DraftOpenError::InvalidInput,
    })
}

/// The address as Foundation reads it, only when its scheme is still `mailto` or `sms`.
#[cfg(target_os = "macos")]
fn draft_ns_url(url: &str) -> Option<objc2::rc::Retained<objc2_foundation::NSURL>> {
    use objc2_foundation::{NSString, NSURL};
    let url = NSURL::URLWithString(&NSString::from_str(url))?;
    let scheme = url.scheme()?.to_string();
    (scheme == "mailto" || scheme == "sms").then_some(url)
}
/// Asks macOS to open the address with the app set for it: `Err` when there is none or it fails.
#[cfg(target_os = "macos")]
fn open_url(url: &str) -> Result<(), ()> {
    use objc2_app_kit::NSWorkspace;
    let url = draft_ns_url(url).ok_or(())?;
    if NSWorkspace::sharedWorkspace().openURL(&url) {
        Ok(())
    } else {
        Err(())
    }
}
#[cfg(not(target_os = "macos"))]
fn open_url(_url: &str) -> Result<(), ()> {
    Err(())
}
/// `draft_ns_url`, and only when Foundation's own reading of the whole address names exactly
/// `expected` recipients (core `contact::recipients`).
#[cfg(target_os = "macos")]
fn draft_ns_url_to(
    url: &str,
    expected: usize,
) -> Option<objc2::rc::Retained<objc2_foundation::NSURL>> {
    let read = draft_ns_url(url)?;
    let whole = read.absoluteString()?;
    (contact::recipients(&whole.to_string()) == Some(expected)).then_some(read)
}
/// The name of the app this Mac opens Mail's (`mailto:`) or Messages' (`sms:`) addresses with, from
/// the scheme alone: told only which, never handed a note's address (core `Address::open`), so the
/// name can't be made from it. `None` when there is no such app or its name isn't one plain line.
#[cfg(target_os = "macos")]
fn app_name_for(kind: ContactKind) -> Option<AppName> {
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::{NSString, NSURL};
    let scheme = match kind {
        ContactKind::Email => "mailto:",
        ContactKind::Mobile => "sms:",
    };
    let bare = NSURL::URLWithString(&NSString::from_str(scheme))?;
    let app = NSWorkspace::sharedWorkspace().URLForApplicationToOpenURL(&bare)?;
    let path = app.to_file_path()?;
    AppName::shown(path.file_stem()?.to_str()?)
}
#[cfg(not(target_os = "macos"))]
fn app_name_for(_kind: ContactKind) -> Option<AppName> {
    None
}
/// The one function `open_draft_to` hands core's `Address` to: opens it only as Foundation reads it
/// with `expected` recipients (one when addressed, none otherwise). It says nothing but whether it
/// opened; the app's name comes from `app_name_for`, which never sees the address.
#[cfg(target_os = "macos")]
fn open_url_to(url: &str, expected: usize) -> Result<(), NotOpened> {
    use objc2_app_kit::NSWorkspace;
    let url = draft_ns_url_to(url, expected).ok_or(NotOpened)?;
    if NSWorkspace::sharedWorkspace().openURL(&url) {
        Ok(())
    } else {
        Err(NotOpened)
    }
}
#[cfg(not(target_os = "macos"))]
fn open_url_to(_url: &str, _expected: usize) -> Result<(), NotOpened> {
    Err(NotOpened)
}

/// "Open in Mail" / "Open in Messages": opens the draft as a new, unsent message and says which
/// app it opened in, named as `open_draft_to` names it (`opened_in`).
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
            let _ = send.send(open_url(&url).map(|()| app_name_for(app.contact())));
        })
        .map_err(|_| DraftOpenError::Unavailable)?;
    let opened = tauri::async_runtime::spawn_blocking(move || receive.recv().unwrap_or(Err(())))
        .await
        .map_err(|_| DraftOpenError::Unavailable)?;
    match opened {
        Ok(name) => Ok(opened_in(app, name)),
        Err(()) => Err(DraftOpenError::NotOpened),
    }
}

/// "Open in Mail" / "Open in Messages" on a note prepared for one person on the Sunday page: opens
/// it as a new, unsent message with that person in To when Planning Center has one usable email
/// address (or mobile number) for them, otherwise with no one in To, and says which and why. The
/// page sends the app, the words and the person's Planning Center id from the check it shows; the
/// words and the id are checked before anything is read. Core `contact` takes the connection's turn
/// (a running Sunday check or picker means nothing is read), reads within its deadline and builds
/// the address and the reply; the address or number stays in this process and is never part of the
/// reply or an error. Errors are those of `open_draft`: nothing was opened.
#[tauri::command]
pub(crate) async fn open_draft_to(
    handle: tauri::AppHandle,
    consumer: tauri::State<'_, crate::Consumer>,
    checks: tauri::State<'_, crate::SundayChecks>,
    checked: tauri::State<'_, CheckedPeople>,
    app: DraftApp,
    body: String,
    person: String,
) -> Result<Opened, DraftOpenError> {
    let unaddressed = draft_url(app, &body, None)?;
    drop(body);
    if !numeric_id(&person) {
        return Err(DraftOpenError::InvalidInput);
    }
    let consumer = consumer.inner().clone();
    let turns = checks.inner().clone();
    let checked = checked.inner().clone();
    let address = tauri::async_runtime::spawn_blocking(move || {
        let read = contact::read_recipient(&checked, &turns, &person, app.contact(), || {
            crate::connected_auth(&consumer).ok()
        });
        prepare(app, &unaddressed, read)
    })
    .await
    .map_err(|_| DraftOpenError::Unavailable)??;
    let (send, receive) = std::sync::mpsc::channel();
    handle
        .run_on_main_thread(move || {
            let _ = send.send(address.open(open_url_to, app_name_for));
        })
        .map_err(|_| DraftOpenError::Unavailable)?;
    tauri::async_runtime::spawn_blocking(move || receive.recv().unwrap_or(Err(NotOpened)))
        .await
        .map_err(|_| DraftOpenError::Unavailable)?
        .map_err(|NotOpened| DraftOpenError::NotOpened)
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

    /// Looked up only, nothing opened: every Mac has an app for both addresses, and `open_draft`
    /// says the name `open_draft_to` would, looked up from the bare scheme.
    #[cfg(target_os = "macos")]
    #[test]
    fn this_mac_names_the_app_each_address_opens_in() {
        for app in [DraftApp::Mail, DraftApp::Messages] {
            assert!(draft_ns_url(&draft_url(app, "Hi", None).unwrap()).is_some());
            let name = app_name_for(app.contact()).expect("an app with a plain name");
            assert_eq!(opened_in(app, Some(name.clone())).app, name);
        }
    }

    /// Review G, L-c: `open_draft` says the app's own name, any printable characters, and when it
    /// can't be read, "your email app" or "your messages app", never "Mail" for another app.
    #[test]
    fn open_draft_says_the_apps_own_name_or_a_neutral_one() {
        let reply = |app, name: Option<&str>| {
            serde_json::to_string(&opened_in(app, name.and_then(AppName::shown))).unwrap()
        };
        assert_eq!(reply(DraftApp::Mail, Some("Mail")), r#"{"app":"Mail"}"#);
        assert_eq!(
            reply(DraftApp::Mail, Some(" Spike Email - Mail & Team Chat ")),
            r#"{"app":"Spike Email - Mail & Team Chat"}"#
        );
        assert_eq!(
            reply(DraftApp::Messages, Some("Messages")),
            r#"{"app":"Messages"}"#
        );
        for unreadable in [
            None,
            Some(""),
            Some("Mail\nSent"),
            Some("Mail\u{202E}liaM"),
            Some("\u{200B}"),
        ] {
            assert_eq!(
                reply(DraftApp::Mail, unreadable),
                r#"{"app":"your email app"}"#,
                "{unreadable:?}"
            );
            assert_eq!(
                reply(DraftApp::Messages, unreadable),
                r#"{"app":"your messages app"}"#
            );
        }
        let long = "a".repeat(65);
        assert_eq!(
            reply(DraftApp::Mail, Some(&long)),
            r#"{"app":"your email app"}"#
        );
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
    // ---- open_draft_to: the person in To -------------------------------------------------------

    /// Riley Example, fictional; a reserved domain and a 555-01xx number.
    const ADDRESS: &str = "riley.example@example.org";
    const NUMBER: &str = "+1 (312) 555-0101";
    /// Each fragment of the address and the number that must never be in a reply.
    const FRAGMENTS: &[&str] = &["riley", "example", ".org", "@", "%40", "312", "555", "0101"];
    fn mail_to(address: &str) -> Recipient {
        Recipient::email(address).unwrap()
    }
    fn text_to(number: &str) -> Recipient {
        Recipient::mobile(number).unwrap()
    }
    std::thread_local! {
        /// What the stand-in opener was handed, on this test's own thread.
        static HANDED: std::cell::RefCell<Vec<(String, usize)>> = const { std::cell::RefCell::new(Vec::new()) };
    }
    /// Stands in for `open_url_to`: records what it was handed and opens nothing.
    fn stand_in(url: &str, recipients: usize) -> Result<(), NotOpened> {
        HANDED.with(|handed| handed.borrow_mut().push((url.to_owned(), recipients)));
        Ok(())
    }
    /// Stands in for `app_name_for`: this Mac's email and messages app are both "Mail" here.
    fn stand_in_name(_: ContactKind) -> Option<AppName> {
        AppName::shown("Mail")
    }
    fn handed() -> Vec<(String, usize)> {
        HANDED.with(|handed| handed.borrow_mut().drain(..).collect())
    }
    /// What `open_draft_to` does once the read is done, with the stand-in opener: the draft's own
    /// address, core's address from it, opened, and core's reply.
    fn open_to(
        app: DraftApp,
        words: &str,
        read: Result<Recipient, NoRecipient>,
    ) -> Result<Opened, DraftOpenError> {
        let address = prepare(app, &draft_url(app, words, None)?, read)?;
        address
            .open(stand_in, stand_in_name)
            .map_err(|NotOpened| DraftOpenError::NotOpened)
    }

    #[test]
    fn an_addressed_note_names_exactly_its_one_recipient() {
        handed();
        open_to(DraftApp::Mail, NOTE, Ok(mail_to(ADDRESS))).unwrap();
        let unaddressed = draft_url(DraftApp::Mail, NOTE, None).unwrap();
        assert_eq!(
            handed(),
            [(
                format!("mailto:{ADDRESS}{}", &unaddressed["mailto:".len()..]),
                1
            )]
        );
        open_to(DraftApp::Messages, NOTE, Ok(text_to(NUMBER))).unwrap();
        let unaddressed = draft_url(DraftApp::Messages, NOTE, None).unwrap();
        assert_eq!(
            handed(),
            [(
                format!("sms:+13125550101{}", &unaddressed["sms:".len()..]),
                1
            )]
        );
        // An address's other characters are percent-encoded (RFC 6068); `+` stays as it is.
        open_to(
            DraftApp::Mail,
            "Hi",
            Ok(mail_to("o'riley+sunday@example.org")),
        )
        .unwrap();
        assert_eq!(
            handed(),
            [("mailto:o%27riley+sunday@example.org?body=Hi".to_owned(), 1)]
        );
        // Words that look like recipients stay words inside the body.
        for words in [
            "x&to=other@example.org&cc=other@example.org",
            "?cc=other@example.org",
            "\r\nBcc: other@example.org",
        ] {
            open_to(DraftApp::Mail, words, Ok(mail_to(ADDRESS))).unwrap();
            open_to(DraftApp::Messages, words, Ok(text_to(NUMBER))).unwrap();
            for (url, recipients) in handed() {
                assert_eq!(contact::recipients(&url), Some(1), "{words:?}");
                assert_eq!(recipients, 1);
            }
        }
        // A note that fits only without the recipient is too long, never cut, and opens nothing.
        let fits = "a".repeat(MAX_MESSAGES_URL_BYTES - "sms:&body=".len());
        assert!(draft_url(DraftApp::Messages, &fits, None).is_ok());
        assert_eq!(
            open_to(DraftApp::Messages, &fits, Ok(text_to(NUMBER))).err(),
            Some(DraftOpenError::TooLong)
        );
        // Words refused for `open_draft` are refused here too.
        assert_eq!(
            open_to(DraftApp::Mail, "Hi\0", Ok(mail_to(ADDRESS))).err(),
            Some(DraftOpenError::InvalidInput)
        );
        assert!(handed().is_empty());
    }

    #[test]
    fn without_a_recipient_the_note_opens_unaddressed_and_says_why() {
        handed();
        let unaddressed = draft_url(DraftApp::Mail, NOTE, None).unwrap();
        let opened = open_to(DraftApp::Mail, NOTE, Err(NoRecipient::BusyWithACheck)).unwrap();
        assert_eq!(handed(), [(unaddressed.clone(), 0)]);
        assert_eq!(
            serde_json::to_string(&opened).unwrap(),
            r#"{"app":"Mail","result":"opened-without-recipient","reason":"busy-with-a-check"}"#
        );
        // A recipient of the other kind: unaddressed, could-not-read.
        let opened = open_to(DraftApp::Mail, NOTE, Ok(text_to(NUMBER))).unwrap();
        assert_eq!(handed(), [(unaddressed, 0)]);
        assert!(
            serde_json::to_string(&opened)
                .unwrap()
                .contains("could-not-read")
        );
        // Only the draft's own address is ever handed to core.
        assert_eq!(
            prepare(
                DraftApp::Mail,
                "mailto:other@example.org?body=x",
                Err(NoRecipient::Child)
            )
            .err(),
            Some(DraftOpenError::InvalidInput)
        );
    }

    /// Review Y, L1: the whole reply `open_draft_to` gives, for every result in both apps, holds no
    /// fragment of the address or number, though the opener was handed the address.
    #[test]
    fn every_reply_of_open_draft_to_holds_no_fragment_of_the_detail() {
        let reasons = [
            NoRecipient::NoneOnFile,
            NoRecipient::NotAllowed,
            NoRecipient::CouldNotRead,
            NoRecipient::MoreThanOne,
            NoRecipient::Child,
            NoRecipient::NotInThisCheck,
            NoRecipient::BusyWithACheck,
            NoRecipient::BusyWithAnotherNote,
            NoRecipient::TooManyJustNow,
        ];
        handed();
        for app in [DraftApp::Mail, DraftApp::Messages] {
            let read = || match app {
                DraftApp::Mail => Ok(mail_to(ADDRESS)),
                DraftApp::Messages => Ok(text_to(NUMBER)),
            };
            let mut replies = vec![open_to(app, NOTE, read()).unwrap()];
            let to = handed();
            assert!(
                to[0].0.contains("riley.example@example.org") || to[0].0.contains("+13125550101")
            );
            for reason in reasons {
                replies.push(open_to(app, NOTE, Err(reason)).unwrap());
            }
            assert!(handed().iter().all(|(_, recipients)| *recipients == 0));
            for reply in replies {
                let text = serde_json::to_string(&reply).unwrap();
                let shown = format!("{text} {reply:?}");
                for fragment in FRAGMENTS {
                    assert!(!shown.contains(fragment), "{shown}");
                }
            }
        }
        let shown = format!("{:?} {:?}", mail_to(ADDRESS), text_to(NUMBER));
        for fragment in FRAGMENTS {
            assert!(!shown.contains(fragment), "{shown}");
        }
    }

    /// Reads an address back the way `open_url_to` does, without opening it.
    #[cfg(target_os = "macos")]
    fn read_back(url: &str, recipients: usize) -> Result<(), NotOpened> {
        let read = draft_ns_url_to(url, recipients).ok_or(NotOpened)?;
        assert!(draft_ns_url_to(url, 1 - recipients).is_none());
        let scheme = read.scheme().unwrap().to_string();
        assert!(scheme == "mailto" || scheme == "sms");
        Ok(())
    }
    /// Looked up only, nothing opened: this Mac names the app it opens each kind of address with,
    /// from the scheme alone, and the reply says that name.
    #[cfg(target_os = "macos")]
    #[test]
    fn this_mac_names_the_app_from_the_scheme_alone() {
        for (kind, app) in [
            (ContactKind::Email, DraftApp::Mail),
            (ContactKind::Mobile, DraftApp::Messages),
        ] {
            let name = app_name_for(kind).expect("an app for the address, with a plain name");
            let opened = prepare(
                app,
                &draft_url(app, "Hi", None).unwrap(),
                Err(NoRecipient::Child),
            )
            .unwrap()
            .open(read_back, app_name_for)
            .unwrap();
            let reply = serde_json::to_string(&opened).unwrap();
            assert!(
                reply.starts_with(&format!(
                    "{{\"app\":{}",
                    serde_json::to_string(&name).unwrap()
                )),
                "{reply}"
            );
        }
    }
    /// Foundation reads every note core addresses as one `mailto` or `sms` address naming exactly
    /// its one recipient, whatever the words, and an unaddressed note as naming none; this Mac names
    /// the app for each. Nothing is opened.
    #[cfg(target_os = "macos")]
    #[test]
    fn foundation_reads_an_addressed_note_with_exactly_one_recipient() {
        for words in [
            NOTE,
            "x&to=someone@example.invalid",
            "🙏",
            "\r\nBcc: other@example.org",
        ] {
            for address in [
                ADDRESS,
                "o'riley+sunday@example.org",
                "a/b=c!x@sub.example.org",
            ] {
                let opened = prepare(
                    DraftApp::Mail,
                    &draft_url(DraftApp::Mail, words, None).unwrap(),
                    Ok(mail_to(address)),
                )
                .unwrap()
                .open(read_back, app_name_for);
                assert!(opened.is_ok(), "{address}");
            }
            for number in [NUMBER, "312.555.0101", "+44 555 0101"] {
                let opened = prepare(
                    DraftApp::Messages,
                    &draft_url(DraftApp::Messages, words, None).unwrap(),
                    Ok(text_to(number)),
                )
                .unwrap()
                .open(read_back, app_name_for);
                assert!(opened.is_ok(), "{number}");
            }
            for app in [DraftApp::Mail, DraftApp::Messages] {
                let opened = prepare(
                    app,
                    &draft_url(app, words, None).unwrap(),
                    Err(NoRecipient::NoneOnFile),
                )
                .unwrap()
                .open(read_back, app_name_for)
                .unwrap();
                assert!(
                    serde_json::to_string(&opened)
                        .unwrap()
                        .contains("none-on-file")
                );
            }
        }
        for other in [
            "mailto:a@example.org,b@example.org?body=x",
            "mailto:a@example.org?cc=b@example.org&body=x",
            "sms:+13125550101,+13125550102&body=x",
            "file:///etc/hosts",
            "https://example.invalid/?body=x",
        ] {
            assert!(
                draft_ns_url_to(other, 1).is_none() && draft_ns_url_to(other, 0).is_none(),
                "{other}"
            );
        }
    }

    /// Every path a file names outside its `tests` module, as Rust reads it: each `use` flattened to
    /// the path it names (groups opened, `self` and `as` followed), every other path with its first
    /// segment put back to the path it was imported from, each macro's name and tokens, each method
    /// call with its arguments, and the function each is in.
    #[derive(Default)]
    struct Named {
        within: Vec<String>,
        aliases: std::collections::BTreeMap<String, String>,
        uses: Vec<String>,
        raw: Vec<(Option<String>, String)>,
        macros: Vec<(String, String)>,
        calls: Vec<(Option<String>, String, Vec<String>)>,
        commands: Vec<String>,
        /// Every `static` item, anywhere outside the tests.
        statics: Vec<String>,
        /// Every `unsafe` block, function, impl or trait.
        unsafes: usize,
        /// Each function's parameters, as the last segment of each parameter's type.
        inputs: Vec<(String, Vec<String>)>,
    }
    impl Named {
        fn flatten(&mut self, tree: &syn::UseTree, prefix: &str) {
            let original = |name: &str| {
                if name == "self" {
                    prefix.trim_end_matches("::").to_owned()
                } else {
                    format!("{prefix}{name}")
                }
            };
            match tree {
                syn::UseTree::Path(p) => self.flatten(&p.tree, &format!("{prefix}{}::", p.ident)),
                syn::UseTree::Name(n) => {
                    let path = original(&n.ident.to_string());
                    let alias = path.rsplit("::").next().unwrap_or_default().to_owned();
                    self.aliases.insert(alias, path.clone());
                    self.uses.push(path);
                }
                syn::UseTree::Rename(r) => {
                    let path = original(&r.ident.to_string());
                    self.aliases.insert(r.rename.to_string(), path.clone());
                    self.uses.push(path);
                }
                syn::UseTree::Glob(_) => self.uses.push(format!("{prefix}*")),
                syn::UseTree::Group(g) => g.items.iter().for_each(|t| self.flatten(t, prefix)),
            }
        }
        fn full(&self, path: &str) -> String {
            let (first, rest) = path.split_once("::").unwrap_or((path, ""));
            match self.aliases.get(first) {
                Some(original) if rest.is_empty() => original.clone(),
                Some(original) => format!("{original}::{rest}"),
                None => path.to_owned(),
            }
        }
        fn paths(&self) -> Vec<(Option<String>, String)> {
            let mut all: Vec<(Option<String>, String)> =
                self.uses.iter().map(|u| (None, u.clone())).collect();
            all.extend(
                self.raw
                    .iter()
                    .map(|(within, path)| (within.clone(), self.full(path))),
            );
            all
        }
    }
    fn joined(path: &syn::Path) -> String {
        path.segments
            .iter()
            .map(|s| s.ident.to_string())
            .collect::<Vec<_>>()
            .join("::")
    }
    impl<'a> syn::visit::Visit<'a> for Named {
        fn visit_item_mod(&mut self, m: &'a syn::ItemMod) {
            if m.ident != "tests" {
                syn::visit::visit_item_mod(self, m);
            }
        }
        fn visit_item_fn(&mut self, f: &'a syn::ItemFn) {
            if f.attrs.iter().any(|a| joined(a.path()) == "tauri::command") {
                self.commands.push(f.sig.ident.to_string());
            }
            if f.sig.unsafety.is_some() {
                self.unsafes += 1;
            }
            let inputs = f
                .sig
                .inputs
                .iter()
                .map(|input| match input {
                    syn::FnArg::Typed(t) => match &*t.ty {
                        syn::Type::Path(p) => p
                            .path
                            .segments
                            .last()
                            .map(|s| s.ident.to_string())
                            .unwrap_or_default(),
                        syn::Type::Reference(_) => "&".into(),
                        _ => "?".into(),
                    },
                    syn::FnArg::Receiver(_) => "self".into(),
                })
                .collect();
            self.inputs.push((f.sig.ident.to_string(), inputs));
            self.within.push(f.sig.ident.to_string());
            syn::visit::visit_item_fn(self, f);
            self.within.pop();
        }
        fn visit_item_use(&mut self, u: &'a syn::ItemUse) {
            let prefix = if u.leading_colon.is_some() { "::" } else { "" };
            self.flatten(&u.tree, prefix);
        }
        fn visit_item_static(&mut self, item: &'a syn::ItemStatic) {
            self.statics.push(item.ident.to_string());
            syn::visit::visit_item_static(self, item);
        }
        fn visit_expr_unsafe(&mut self, e: &'a syn::ExprUnsafe) {
            self.unsafes += 1;
            syn::visit::visit_expr_unsafe(self, e);
        }
        fn visit_item_impl(&mut self, i: &'a syn::ItemImpl) {
            if i.unsafety.is_some() {
                self.unsafes += 1;
            }
            syn::visit::visit_item_impl(self, i);
        }
        fn visit_item_trait(&mut self, t: &'a syn::ItemTrait) {
            if t.unsafety.is_some() {
                self.unsafes += 1;
            }
            syn::visit::visit_item_trait(self, t);
        }
        fn visit_path(&mut self, p: &'a syn::Path) {
            self.raw.push((self.within.last().cloned(), joined(p)));
            syn::visit::visit_path(self, p);
        }
        fn visit_macro(&mut self, m: &'a syn::Macro) {
            self.macros.push((
                joined(&m.path),
                m.tokens.to_string().split_whitespace().collect(),
            ));
            syn::visit::visit_macro(self, m);
        }
        fn visit_expr_method_call(&mut self, call: &'a syn::ExprMethodCall) {
            let args = call
                .args
                .iter()
                .map(|a| match a {
                    syn::Expr::Path(p) => joined(&p.path),
                    _ => "<expression>".into(),
                })
                .collect();
            self.calls
                .push((self.within.last().cloned(), call.method.to_string(), args));
            syn::visit::visit_expr_method_call(self, call);
        }
    }
    fn named(source: &str) -> Named {
        use syn::visit::Visit as _;
        let mut named = Named::default();
        named.visit_file(&syn::parse_file(source).expect("parses"));
        named
    }
    /// Whether a full path reaches core's `contact` module.
    fn reaches_contact(path: &str) -> bool {
        path.starts_with("ozzie_native_auth::contact")
            || path.starts_with("::ozzie_native_auth::contact")
    }

    /// Structure (review Y, L1): in the desktop app only this file and main.rs reach core `contact`,
    /// however it is imported (`use … as`, groups, globs). main.rs only keeps who a check showed
    /// (`CheckedPeople`) and registers exactly this file's two commands. Here, the two commands are
    /// the only ones; only `open_draft_to` reads, once, through `contact::read_recipient`, and hands
    /// core's address only to `open_url_to`; the app's name is made only from the app's own file
    /// name; and nothing that writes, prints, logs, formats a value, reaches a model, the task
    /// ledger, a notice, the copy for other AI apps or Siri, a file or another program is named.
    #[test]
    fn only_the_draft_command_reaches_the_contact_read() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut reaching = Vec::new();
        for entry in std::fs::read_dir(&root).unwrap().flatten() {
            let path = entry.path();
            if path.extension().is_none_or(|e| e != "rs") {
                continue;
            }
            let file = path.file_name().unwrap().to_string_lossy().into_owned();
            let source = std::fs::read_to_string(&path).unwrap();
            let found = named(&source);
            if found.paths().iter().any(|(_, p)| reaches_contact(p))
                || found.macros.iter().any(|(_, m)| m.contains("contact::"))
            {
                reaching.push(file.clone());
            }
            if file != "draft_apps.rs" && file != "main.rs" {
                assert!(
                    !found
                        .paths()
                        .iter()
                        .any(|(_, p)| p.split("::").any(|s| s == "draft_apps"))
                        && !found.macros.iter().any(|(_, m)| m.contains("draft_apps")),
                    "{file} reaches draft_apps"
                );
                assert!(
                    !found
                        .macros
                        .iter()
                        .any(|(_, m)| m.contains("open_draft_to"))
                        && !found
                            .paths()
                            .iter()
                            .any(|(_, p)| p.ends_with("open_draft_to")),
                    "{file} names open_draft_to"
                );
                for token in [
                    "CheckedPeople",
                    "read_recipient",
                    "NoRecipient",
                    "Recipient",
                    "ContactKind",
                    "AppName",
                ] {
                    assert!(!source.contains(token), "{file} names {token}");
                }
            }
        }
        reaching.sort();
        assert_eq!(reaching, ["draft_apps.rs", "main.rs"]);

        // main.rs: keeps who each check showed; registers exactly this file's two commands.
        let main = std::fs::read_to_string(root.join("main.rs")).unwrap();
        let in_main = named(&main);
        let from_contact: Vec<String> = in_main
            .paths()
            .into_iter()
            .filter(|(_, p)| reaches_contact(p))
            .map(|(_, p)| p)
            .collect();
        assert!(
            from_contact.iter().all(|p| {
                let kept = "ozzie_native_auth::contact::CheckedPeople";
                p == kept
                    || p.strip_prefix(kept)
                        .is_some_and(|rest| rest.starts_with("::"))
            }),
            "{from_contact:?}"
        );
        let handler = in_main
            .macros
            .iter()
            .find(|(name, _)| name == "tauri::generate_handler")
            .map(|(_, tokens)| tokens.clone())
            .expect("main.rs registers its commands");
        let ours: Vec<&str> = handler
            .split(',')
            .filter(|c| c.starts_with("draft_apps::"))
            .collect();
        assert_eq!(
            ours,
            ["draft_apps::open_draft", "draft_apps::open_draft_to"]
        );
        // Review F, L-3: main.rs reads nothing else of this file, under any path or in any macro.
        let mut from_here: Vec<String> = in_main
            .paths()
            .into_iter()
            .filter(|(_, p)| p.split("::").any(|s| s == "draft_apps"))
            .map(|(_, p)| p)
            .collect();
        for (_, tokens) in &in_main.macros {
            for (at, _) in tokens.match_indices("draft_apps::") {
                let rest = &tokens[at..];
                let end = rest
                    .char_indices()
                    .skip("draft_apps::".len())
                    .find(|(_, c)| !(c.is_ascii_alphanumeric() || *c == '_'))
                    .map_or(rest.len(), |(i, _)| i);
                from_here.push(rest[..end].to_owned());
            }
        }
        from_here.sort();
        from_here.dedup();
        assert_eq!(
            from_here,
            ["draft_apps::open_draft", "draft_apps::open_draft_to"]
        );
        assert_eq!(main.matches("people.remember(&capture);").count(), 2);
        for token in [
            "read_recipient",
            "Recipient",
            "ContactKind",
            "AppName",
            "Address",
            "url_part",
        ] {
            assert!(!main.contains(token), "main.rs names {token}");
        }

        // This file.
        let here = named(include_str!("draft_apps.rs"));
        assert_eq!(here.commands, ["open_draft", "open_draft_to"]);
        // Review F, L-3: nothing here can keep anything between calls (no static, no thread-local,
        // no lazy or shared cell, no lock, no atomic, nothing leaked, no unsafe), and the app's name
        // is looked up by a function that is told only Mail or Messages.
        assert_eq!(here.statics, Vec::<String>::new());
        assert_eq!(here.unsafes, 0);
        for (name, _) in &here.macros {
            assert!(
                !name.ends_with("thread_local") && !name.ends_with("lazy_static"),
                "draft_apps.rs uses {name}!"
            );
        }
        for (_, path) in here.paths() {
            for segment in path.split("::") {
                assert!(
                    ![
                        "OnceLock",
                        "LazyLock",
                        "OnceCell",
                        "Lazy",
                        "Mutex",
                        "RwLock",
                        "Cell",
                        "RefCell",
                        "UnsafeCell",
                        "leak",
                        "static"
                    ]
                    .contains(&segment)
                        && !segment.starts_with("Atomic"),
                    "draft_apps.rs keeps state through {path}"
                );
            }
        }
        let named_by: Vec<&Vec<String>> = here
            .inputs
            .iter()
            .filter(|(name, _)| name == "app_name_for")
            .map(|(_, inputs)| inputs)
            .collect();
        assert!(!named_by.is_empty());
        for inputs in named_by {
            assert_eq!(inputs, &["ContactKind"]);
        }
        for (within, path) in here.paths() {
            if let Some(rest) = path.strip_prefix("ozzie_native_auth::") {
                assert!(
                    rest.starts_with("contact") || rest == "oauth::numeric_id",
                    "draft_apps.rs reaches {path}"
                );
            }
            if let Some(rest) = path.strip_prefix("crate::") {
                assert!(
                    ["Consumer", "SundayChecks", "connected_auth"].contains(&rest),
                    "draft_apps.rs reaches {path}"
                );
            }
            if path.ends_with("::read_recipient") {
                assert_eq!(within.as_deref(), Some("open_draft_to"), "{path}");
            }
            if path.contains("Recipient::email") || path.contains("Recipient::mobile") {
                panic!("draft_apps.rs makes a recipient outside its tests: {path}");
            }
            if path.ends_with("AppName::shown") {
                assert_eq!(within.as_deref(), Some("app_name_for"), "{path}");
            }
            if path.ends_with("AppName::neutral") {
                assert_eq!(within.as_deref(), Some("opened_in"), "{path}");
            }
            for segment in [
                "fs", "io", "env", "process", "net", "os", "Command", "reqwest", "log", "Emitter",
                "Write", "stderr", "stdout",
            ] {
                assert!(
                    !path.split("::").any(|s| s == segment),
                    "draft_apps.rs reaches {path}"
                );
            }
            for banned in [
                "super::",
                "tauri_plugin",
                "model",
                "agent",
                "ledger",
                "hosted",
                "shared_check",
                "shortcuts",
                "phone_notice",
                "name_guard",
                "notification",
            ] {
                assert!(!path.contains(banned), "draft_apps.rs names {path}");
            }
        }
        let read_calls: Vec<_> = here
            .paths()
            .into_iter()
            .filter(|(_, p)| p.ends_with("::read_recipient"))
            .collect();
        assert_eq!(read_calls.len(), 1, "called once, inside open_draft_to");
        for (name, tokens) in &here.macros {
            assert!(
                ![
                    "write",
                    "writeln",
                    "print",
                    "println",
                    "eprint",
                    "eprintln",
                    "dbg",
                    "format_args"
                ]
                .contains(&name.as_str()),
                "draft_apps.rs uses {name}!"
            );
            assert!(
                !tokens.contains(":?"),
                "draft_apps.rs formats a value: {name}!({tokens})"
            );
            for banned in ["emit", "notification", "log::"] {
                assert!(!tokens.contains(banned), "draft_apps.rs: {name}!({tokens})");
            }
        }
        // Review G, L-a: no panic or failed-assertion message can carry a value here.
        for (name, tokens) in &here.macros {
            let name = name.rsplit("::").next().unwrap_or_default();
            assert!(
                ![
                    "panic",
                    "assert",
                    "assert_eq",
                    "assert_ne",
                    "debug_assert_eq",
                    "debug_assert_ne",
                    "unreachable",
                    "todo",
                    "unimplemented",
                ]
                .contains(&name)
                    && !(name == "debug_assert" && tokens.contains(',')),
                "draft_apps.rs uses {name}!"
            );
        }
        for (within, method, _) in &here.calls {
            assert!(
                ![
                    "expect",
                    "unwrap",
                    "expect_err",
                    "unwrap_err",
                    "unwrap_unchecked"
                ]
                .contains(&method.as_str()),
                "draft_apps.rs calls {method} in {within:?}"
            );
        }
        // Review G, L-a: of the Objective-C runtime, only the three classes this file needs, and only
        // what it calls on them: no other class (process-wide state such as `NSProcessInfo`, the
        // pasteboard, user defaults), no message sent by hand.
        for (name, _) in &here.macros {
            let name = name.rsplit("::").next().unwrap_or_default();
            assert!(
                ![
                    "msg_send",
                    "msg_send_id",
                    "class",
                    "sel",
                    "extern_class",
                    "extern_methods",
                    "define_class"
                ]
                .contains(&name),
                "draft_apps.rs uses {name}!"
            );
        }
        let mut objc: Vec<String> = here
            .paths()
            .into_iter()
            .map(|(_, p)| p)
            .filter(|p| p.starts_with("objc2"))
            .collect();
        objc.sort();
        objc.dedup();
        assert_eq!(
            objc,
            [
                "objc2::rc::Retained",
                "objc2_app_kit::NSWorkspace",
                "objc2_app_kit::NSWorkspace::sharedWorkspace",
                "objc2_foundation::NSString",
                "objc2_foundation::NSString::from_str",
                "objc2_foundation::NSURL",
                "objc2_foundation::NSURL::URLWithString",
            ]
        );
        // Every method called outside the tests, pinned: a new one (a setter of process-wide state,
        // say) fails here and needs its own review.
        let mut methods: Vec<&str> = here.calls.iter().map(|(_, m, _)| m.as_str()).collect();
        methods.sort_unstable();
        methods.dedup();
        assert_eq!(
            methods,
            [
                "URLForApplicationToOpenURL",
                "absoluteString",
                "any",
                "as_deref",
                "bytes",
                "chars",
                "clone",
                "contact",
                "count",
                "encode_utf8",
                "file_stem",
                "inner",
                "is_ascii_alphanumeric",
                "is_control",
                "is_empty",
                "is_some",
                "len",
                "map",
                "map_err",
                "ok",
                "ok_or",
                "open",
                "openURL",
                "push",
                "push_str",
                "recv",
                "replace",
                "run_on_main_thread",
                "scheme",
                "send",
                "then_some",
                "to_file_path",
                "to_str",
                "to_string",
                "trim",
                "unwrap_or",
                "unwrap_or_else",
            ]
        );
        // Core's address goes to the opener and nowhere else.
        let opens: Vec<_> = here
            .calls
            .iter()
            .filter(|(_, method, _)| method == "open")
            .collect();
        assert_eq!(opens.len(), 1);
        assert_eq!(
            (opens[0].0.as_deref(), opens[0].2.as_slice()),
            (
                Some("open_draft_to"),
                ["open_url_to".to_owned(), "app_name_for".to_owned()].as_slice()
            )
        );
        // Within `open_draft_to` the page's `person` is checked as an id before anything is read.
        let source = include_str!("draft_apps.rs");
        let command = &source[source.find("pub(crate) async fn open_draft_to").unwrap()..];
        let checked = command.find("if !numeric_id(&person)").unwrap();
        let read = command.find("contact::read_recipient").unwrap();
        assert!(checked < read);
        // The reader catches what plain text would miss.
        let hidden = named(
            "use ozzie_native_auth::contact::read_recipient as fetch;\nfn peek() { fetch(); }",
        );
        assert!(hidden.paths().contains(&(
            Some("peek".into()),
            "ozzie_native_auth::contact::read_recipient".into()
        )));
    }
}
