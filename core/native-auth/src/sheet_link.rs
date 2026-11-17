//! A private link to a published sheet ("Add a list from a private link" on Lists & notes): the address Google Sheets
//! gives for File › Share › Publish to web › Comma-separated values, or any https address that gives back CSV or
//! tab-separated text. https as written only: a calendar's `webcal://`, which a calendar link reads as https, is refused. Read-only: one GET, nothing else, through the calendar links' guarded client
//! (calendar_link.rs `GuardedHttp::get_body`): https on port 443 only, no user name or password in the address and no
//! cookies, Authorization or Referer sent; a public host name that resolves to public addresses only, the connection
//! pinned to the addresses that check returned; at most three redirects, each checked the same way; no system proxy;
//! 5 s to connect, 10 s for any one wait and 20 s for the whole read.
//!
//! The address is a secret (anyone holding it can read the sheet). It is kept the way a calendar link's is, by the
//! same store (calendar_link.rs `SavedLinks`): only in this Mac's Keychain (service `KEYCHAIN_SERVICE`, account
//! `["source-link", "<id>"]`), never in a file, a log, a command line or a reply. The list beside it (`LIST_FILE` in
//! the app's data folder) holds each link's id, the host and a fixed label (`LABEL`): the leader's own name for the
//! list is the church's words and stays with its matches in church-sources.json. The page sees the host with the rest
//! masked (`docs.google.com/•••`). At most 8 links (`calendar_link::MAX_LINKS`).
//!
//! What comes back must look like a sheet (`sheet`): at most `MAX_SHEET_BYTES`, read as it arrives; not a web page (an
//! unpublished sheet's address gives back a sign-in page), whether the site says so (Content-Type) or it starts like
//! one; not a workbook; no NUL byte unless it is UTF-16 with a byte-order mark; not JSON (review T, L1). The page reads the bytes as a sheet in memory (core/src/sources/sheet.ts), shows them on
//! this Mac only, and nothing here keeps them.
use crate::calendar_link::{GuardedHttp, LinkError, LinkFetch, SavedLinks};
use crate::credentials::CredentialStore;
use std::path::PathBuf;
use std::sync::Arc;
/// The address type a `SheetFetch` is given, so the app (and its tests' stand-ins) can name it.
pub use url::Url;

/// Keychain service for the addresses: account `["source-link", "<id>"]`, the address as the item's secret.
pub const KEYCHAIN_SERVICE: &str = "church.ozzie.source-links.v1";
pub const KEYCHAIN_WORKSPACE: &str = "source-link";
/// The list beside the Keychain, in the app's data folder.
pub const LIST_FILE: &str = "source-links.json";
/// Largest sheet read: the core's `MAX_SHEET_BYTES` (core/src/sources/sheet.ts), 2,097,152 bytes, as for a file.
pub const MAX_SHEET_BYTES: usize = 2 * 1024 * 1024;
/// The label every sheet link has in the list beside the Keychain (the leader's own name is kept elsewhere).
pub const LABEL: &str = "Church list";
/// The longest host a sheet's link may have: the page shows it whole with "/•••" after it, in at most 255 characters
/// (the desktop app's `MAX_SHOWN`), never cut (review T, C).
pub const MAX_HOST: usize = 251;
/// What a sheet's read asks for.
const ACCEPT: &str = "text/csv, text/tab-separated-values;q=0.9, text/plain;q=0.5, */*;q=0.1";

/// What a sheet's read gave back: the Content-Type the site said, when it said one, and the body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fetched {
    pub content_type: Option<String>,
    pub body: Vec<u8>,
}
/// Reads one published sheet, at most `MAX_SHEET_BYTES`. The real one is `GuardedHttp`; tests use a stand-in.
pub trait SheetFetch: Send + Sync {
    fn get(&self, url: &Url) -> Result<Fetched, LinkError>;
}
impl SheetFetch for GuardedHttp {
    fn get(&self, url: &Url) -> Result<Fetched, LinkError> {
        let (content_type, body) = self.get_typed(url, ACCEPT, MAX_SHEET_BYTES)?;
        Ok(Fetched { content_type, body })
    }
}

/// Whether any Content-Type the site sent (`calendar_link::content_types` joins them with ", ") is a web page's:
/// text/html or application/xhtml+xml, with any parameters, in any case, quoted or not.
fn web_page_type(content_type: &str) -> bool {
    content_type.split(',').any(|one| {
        let media = one
            .split(';')
            .next()
            .unwrap_or_default()
            .trim()
            .trim_matches('"')
            .trim();
        media.eq_ignore_ascii_case("text/html")
            || media.eq_ignore_ascii_case("application/xhtml+xml")
    })
}
/// Format characters that make text read as something else, which church-added text drops wherever Ozzie shows it:
/// the soft hyphen, the Arabic letter mark, the Mongolian vowel separator, zero-width characters and marks, direction
/// overrides and isolates, invisible operators, the byte-order mark, interlinear annotation and tag characters. A copy
/// of core/src/sources/text.ts `hidden` (itself the desktop app's calendars.rs rule, which this crate cannot use),
/// held to it by core/test/fixtures/sources/hidden.json, which that side writes and sheet_link_tests.rs reads.
fn hidden(c: char) -> bool {
    matches!(c, '\u{ad}' | '\u{61c}' | '\u{180e}' | '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}'
        | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{206f}' | '\u{feff}' | '\u{fff9}'..='\u{fffb}' | '\u{e0001}'
        | '\u{e0020}'..='\u{e007f}')
}
/// What may come before a web page's first `<` and is skipped to find it: white space (a non-breaking space
/// included) and every hidden character (audit item 33: once only the byte-order mark, the zero-width space, the word
/// joiner and the zero-width joiners).
fn before_text(c: char) -> bool {
    c.is_whitespace() || hidden(c)
}
/// A body read as text from its start, however long what comes before its first character runs (review U, note 1;
/// the body is at most `MAX_SHEET_BYTES`): UTF-16 with its byte-order mark, else UTF-8, else (when what starts it
/// isn't UTF-8, such as a lone non-breaking space byte) one byte a character.
fn leading(body: &[u8]) -> Vec<char> {
    fn utf16(rest: &[u8], big: bool) -> Vec<char> {
        char::decode_utf16(rest.as_chunks::<2>().0.iter().map(|pair| {
            if big {
                u16::from_be_bytes(*pair)
            } else {
                u16::from_le_bytes(*pair)
            }
        }))
        .map(|c| c.unwrap_or(char::REPLACEMENT_CHARACTER))
        .collect()
    }
    match body {
        [0xff, 0xfe, rest @ ..] => utf16(rest, false),
        [0xfe, 0xff, rest @ ..] => utf16(rest, true),
        _ => {
            let text: Vec<char> = String::from_utf8_lossy(body).chars().collect();
            let first = text.iter().find(|c| !before_text(**c));
            if first == Some(&char::REPLACEMENT_CHARACTER) {
                body.iter().map(|b| char::from(*b)).collect()
            } else {
                text
            }
        }
    }
}
/// The first two characters after anything `before_text` skips.
fn opening(body: &[u8]) -> (Option<char>, Option<char>) {
    let mut chars = leading(body).into_iter().skip_while(|c| before_text(*c));
    (chars.next(), chars.next())
}
/// Whether the text starts as a web page does: `<` then `!` (a doctype or a comment), `?` (XML), `/` (a closing tag)
/// or a letter (a tag). So a sheet whose first cell starts like a tag (`<b>Name</b>`, `<none>`) is refused too, in
/// words that say so; one that starts with `<` and a number, `=` or a space (`<5`, `<=10`, `< 5`) is a sheet.
fn web_page(body: &[u8]) -> bool {
    matches!(opening(body), (Some('<'), Some(c)) if c == '!' || c == '?' || c == '/' || c.is_alphabetic())
}
/// Whether the text is JSON, an object or an array, whole: what a site gives with an error. Only text that parses whole
/// counts, so a one-column sheet whose first cell starts with `{` or `[` is still a sheet.
fn json(body: &[u8]) -> bool {
    matches!(opening(body), (Some('{' | '['), _))
        && serde_json::from_slice::<serde_json::Value>(
            body.strip_prefix(b"\xef\xbb\xbf").unwrap_or(body),
        )
        .is_ok_and(|v| v.is_object() || v.is_array())
}

/// What came back, as a sheet's bytes, or why not: the site saying it is a web page, then everything `sheet_bytes`
/// checks.
pub fn sheet(fetched: Fetched) -> Result<Vec<u8>, LinkError> {
    if fetched.content_type.as_deref().is_some_and(web_page_type) {
        return Err(LinkError::WebPage);
    }
    sheet_bytes(fetched.body)
}
/// A body as a sheet's bytes, or why not: over `MAX_SHEET_BYTES`; a ZIP (an .xlsx or .numbers file) or an older Office
/// file; a web page; a NUL byte without a UTF-16 byte-order mark (core/src/sources/text.ts `decodeText` refuses the
/// same); JSON.
pub fn sheet_bytes(body: Vec<u8>) -> Result<Vec<u8>, LinkError> {
    if body.len() > MAX_SHEET_BYTES {
        return Err(LinkError::TooLarge);
    }
    if body.starts_with(b"PK\x03\x04")
        || body.starts_with(b"PK\x05\x06")
        || body.starts_with(&[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
    {
        return Err(LinkError::Workbook);
    }
    if web_page(&body) {
        return Err(LinkError::WebPage);
    }
    let utf16 = body.starts_with(&[0xff, 0xfe]) || body.starts_with(&[0xfe, 0xff]);
    if !utf16 && body.contains(&0) {
        return Err(LinkError::NotText);
    }
    if json(&body) {
        return Err(LinkError::NotASheet);
    }
    Ok(body)
}

/// A sheet's read as the link store makes it: the guarded GET, then `sheet`.
struct Sheets(Arc<dyn SheetFetch>);
impl LinkFetch<Vec<u8>> for Sheets {
    fn fetch(&self, url: &Url) -> Result<Vec<u8>, LinkError> {
        sheet(self.0.get(url)?)
    }
}

/// The saved sheet links: addresses in `store` (the Keychain service `KEYCHAIN_SERVICE` in the app), the list beside
/// them at `list`, each read by `fetch` and checked as a sheet.
pub type SheetLinks = SavedLinks<Vec<u8>>;
pub fn sheet_links(
    store: Arc<dyn CredentialStore>,
    list: PathBuf,
    fetch: Arc<dyn SheetFetch>,
) -> SheetLinks {
    SavedLinks::with_fetch(store, list, Arc::new(Sheets(fetch)), KEYCHAIN_WORKSPACE)
        .https_only()
        .max_host(MAX_HOST)
}

#[cfg(test)]
#[path = "sheet_link_tests.rs"]
mod tests;
