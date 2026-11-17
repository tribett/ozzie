//! "Lists & notes": spreadsheet files the leader adds from this Mac (CSV, TSV or plain text), and private links to
//! published sheets, shown only on this Mac as the church's own words. The leader chooses a file in Ozzie's own open panel; the page never names a path and
//! never gets one back (it sees the file's name). Each read opens the file again from where it is, as card photos are
//! opened (card_picker.rs `read_card_photo`): a regular file, not followed through a link, within the size limit, and
//! refused when it is a workbook rather than text. Nothing of a file's contents is kept here: its bytes go to the page,
//! which reads them in memory (core/src/sources/sheet.ts).
//!
//! What is kept is the list `church-sources.json` in the app's data folder (readable by this user only, replaced whole
//! through a partial file): each list's id, label, file name, path, the column that names a team or role, the columns
//! shown on a Sunday card, the leader's matches and when it was last read. Every text in it is one plain line (the same
//! rules as calendars.rs `plain`), and a list that falls outside that format in any way is refused whole as
//! "list-unreadable", so a damaged or newer list is never written over; "Forget all lists" is the way out. Matches
//! live here, never in Church rules, which are shared with a model.
//!
//! A list is never read from the user's Library folder (except iCloud Drive, apps' own folders in it included, and the
//! cloud drives macOS keeps there, where people keep their own documents), from a hidden file or folder (a name
//! starting with a dot), or from Ozzie's own data or cache folders, whether it was just chosen or named in a list on
//! this Mac that something else wrote (review S, L2): the place is checked as the path is written and again as macOS
//! names the file once it is open, so a folder link or a different case can't lead there, and the refused folders are
//! named the same way (review S2, E).
//!
//! A private link to a published sheet ("Add a list from a private link") is read and kept by core/native-auth
//! `sheet_link`: its address only in this Mac's Keychain (service `church.ozzie.source-links.v1`, under the link's id),
//! one guarded GET for each read (https on 443 to a public address only, at most three checked redirects, 20 s in
//! all), what comes back checked as a sheet. Here a link is a list like a file's, under the same id: the leader's
//! label, the host with the rest masked (`docs.google.com/•••`), the column choices, ticks and matches, and no path or
//! address. The address arrives once, from `church_link_add`, goes straight to the links' store and never comes back.
//! An address is never kept without a list here that names it: an add whose list can't be saved takes it out again,
//! removing a link takes it out first, and one left by a step that stopped halfway is removed when the lists are next
//! listed. A link is read only when the page asks (`church_link_read`), never by anything running in the background.
//!
//! Errors are closed codes, the same strings the page has words for (core/src/sources/words.ts): never a path, an
//! address, a file name or anything from a file or a sheet.
use ozzie_native_auth::calendar_link::{GuardedHttp, LinkError};
use ozzie_native_auth::credentials::MacKeychain;
use ozzie_native_auth::sheet_link::{self, Fetched, SheetFetch, SheetLinks, Url};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::Manager;

/// The list's file name in the app's data folder.
pub const LIST_FILE: &str = "church-sources.json";
/// Largest file read: the core's `MAX_SHEET_BYTES` (core/src/sources/sheet.ts), 2,097,152 bytes.
pub const MAX_SOURCE_BYTES: u64 = 2 * 1024 * 1024;
/// The list itself can't grow past this; a larger one is unreadable.
const MAX_LIST_BYTES: u64 = 16 * 1024 * 1024;
/// The core's limits (core/src/sources/types.ts and sheet.ts): lists, columns shown, characters in a label, a file
/// name as shown, a header, a cell (a matched value) and a position's name; matches are at most one per row.
pub const MAX_SOURCES: usize = 20;
/// Private links among them (core/src/sources/types.ts `MAX_LINKS`, and the links' store's own limit).
pub const MAX_LINKS: usize = 8;
pub const MAX_TICKED: usize = 8;
pub const MAX_LABEL: usize = 60;
pub const MAX_SHOWN: usize = 255;
pub const MAX_HEADER: usize = 120;
pub const MAX_CELL: usize = 500;
pub const MAX_NAME: usize = 120;
pub const MAX_MATCHES: usize = 2000;
/// Notes (core/src/sources/notes.ts): the largest file, sections attached at most, characters in a section's title.
pub const MAX_NOTES_BYTES: u64 = 1024 * 1024;
pub const MAX_ATTACHMENTS: usize = 50;
pub const MAX_TITLE: usize = 120;
/** Lines in notes (core/src/sources/notes.ts `MAX_NOTE_LINES`): no title can repeat more often than this. */
pub const MAX_NOTE_LINES: u32 = 20_000;
/// The kinds of finding a section of notes can be attached to (core/src/sources/types.ts `NOTE_FINDING_KINDS`): the
/// Sunday brief's own (core/src/sunday-brief.ts), less "worth-a-look", which says what Ozzie couldn't read.
pub const NOTE_FINDING_KINDS: [&str; 7] = [
    "needs-people",
    "pending",
    "streak",
    "lead-missing",
    "lead-unverified",
    "too-few-confirmed",
    "background-check",
];
const MAX_PATH_BYTES: usize = 4096;
/// What the panel offers, as Uniform Type Identifiers: comma- and tab-separated text, and plain text.
pub const SOURCE_TYPES: [&str; 3] = [
    "public.comma-separated-values-text",
    "public.tab-separated-values-text",
    "public.plain-text",
];
/// What the notes panel offers: plain text and Markdown, and PDF too, so a PDF chosen is refused in plain words
/// (save it as text) rather than not being there to choose.
pub const NOTES_TYPES: [&str; 3] = [
    "public.plain-text",
    "net.daringfireball.markdown",
    "com.adobe.pdf",
];

/// Closed codes only (core/src/sources/words.ts has the words for each); never a path or anything from a file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SourceError {
    /// The file isn't where it was chosen (moved, deleted, or a folder or other non-file put in its place).
    FileMissing,
    /// macOS doesn't let Ozzie read the file (its permissions, or the folder's privacy setting).
    NotAllowed,
    /// An alias (a symbolic link) of a file rather than the file itself, chosen or put in its place.
    NotTheFile,
    /// In the user's Library folder, a hidden file or folder, or Ozzie's own data or cache folders.
    PrivatePlace,
    /// The list on this Mac can't be read, or isn't in this version's format. Nothing is written over.
    ListUnreadable,
    /// Over `MAX_SOURCE_BYTES`.
    TooLarge,
    /// A ZIP (an .xlsx or .numbers file) or an older Office file, not text.
    Workbook,
    /// A NUL byte without a UTF-16 byte-order mark: not text.
    NotText,
    /// A PDF, by its name or how it starts: notes are read as plain text or Markdown only.
    Pdf,
    /// A section's title native code would keep another way (review V): that one pointer is refused.
    SectionTitle,
    /// A private link that isn't a web address (or is too long, or has spaces in it).
    NotAnAddress,
    /// A private link that isn't https.
    NotHttps,
    /// A private link with a user name or password written into it.
    SignInInAddress,
    /// A private link to an IP address, a local name or another port, or a name that points at this Mac or a local
    /// network.
    NotOnTheInternet,
    /// A private link's website couldn't be reached.
    Unreachable,
    /// A private link's website took longer than the limits.
    Timeout,
    /// A private link's website answered with something other than the sheet (401, 403, 404, …).
    Refused,
    /// A private link redirected somewhere Ozzie doesn't read, or too many times.
    MovedElsewhere,
    /// A private link gave back a web page (often a sign-in page), not the sheet.
    WebPage,
    /// A private link gave back something other than a sheet (JSON).
    NotASheet,
    /// Already `MAX_LINKS` private links.
    TooManyLinks,
    /// A private link already added for a list (an add the page stopped waiting for may have finished after all).
    LinkAlreadyAdded,
    /// A private link Ozzie no longer has: its address isn't in the Keychain (or is for another host), or the links'
    /// store doesn't name it. It can only be removed.
    LinkMissing,
    /// The links' own list beside the Keychain can't be read (damaged, or a newer Ozzie's). Nothing is removed.
    LinksUnreadable,
    /// This Mac's Keychain is locked.
    KeychainLocked,
    /// This Mac's Keychain didn't let Ozzie use it.
    KeychainDenied,
    /// "Forget all lists" forgot the lists, but the private links' addresses couldn't be removed from the Keychain yet:
    /// they are removed when the lists are next listed and the Keychain answers.
    LinksLeftInKeychain,
    /// Anything else: a panel already open, the panel or the list couldn't be used, a list that isn't there any more,
    /// a change that isn't one.
    Unavailable,
}
impl From<LinkError> for SourceError {
    fn from(error: LinkError) -> Self {
        match error {
            LinkError::NotAnAddress => Self::NotAnAddress,
            LinkError::NotHttps => Self::NotHttps,
            LinkError::SignInInAddress => Self::SignInInAddress,
            LinkError::NotOnTheInternet => Self::NotOnTheInternet,
            LinkError::Unreachable => Self::Unreachable,
            LinkError::Timeout => Self::Timeout,
            LinkError::Refused => Self::Refused,
            LinkError::MovedElsewhere => Self::MovedElsewhere,
            LinkError::WebPage => Self::WebPage,
            LinkError::NotASheet => Self::NotASheet,
            LinkError::TooLarge => Self::TooLarge,
            LinkError::Workbook => Self::Workbook,
            LinkError::NotText => Self::NotText,
            LinkError::TooMany => Self::TooManyLinks,
            LinkError::Unknown | LinkError::Missing => Self::LinkMissing,
            LinkError::ListUnreadable => Self::LinksUnreadable,
            LinkError::Locked => Self::KeychainLocked,
            LinkError::Denied => Self::KeychainDenied,
            // The label the store keeps is fixed (sheet_link::LABEL), and a sheet is never read as a calendar.
            LinkError::NoLabel | LinkError::NotACalendar | LinkError::Unavailable => {
                Self::Unavailable
            }
        }
    }
}

// ---- Plain text, as calendars.rs makes it ------------------------------------------------------------------

/// Format characters that make text read as something else (calendars.rs `hidden`): the soft hyphen, the Arabic
/// letter mark, the Mongolian vowel separator, zero-width characters and marks, direction overrides and isolates,
/// invisible operators, the byte-order mark, interlinear annotation and tag characters.
fn hidden(c: char) -> bool {
    matches!(c as u32, 0xad | 0x61c | 0x180e | 0x200b..=0x200f | 0x202a..=0x202e | 0x2060..=0x2064
        | 0x2066..=0x206f | 0xfeff | 0xfff9..=0xfffb | 0xe0001 | 0xe0020..=0xe007f)
}
/// What a zero-width joiner or non-joiner may join (calendars.rs `joinable`).
fn joinable(c: char) -> bool {
    c.is_alphabetic()
        || matches!(c as u32, 0x300..=0x36f | 0x900..=0xdff | 0xfe00..=0xfe0f | 0x2300..=0x27bf | 0x2b00..=0x2bff
            | 0x1f000..=0x1faff)
}
/// Text as one plain line, at most `max` characters, exactly as calendars.rs `plain` makes it (with its own limit):
/// only the first `max * 8` characters are read; format characters out, the two joiners kept where they join;
/// controls and the two Unicode line breaks as spaces; runs of spaces as one, none at either end; then cut at `max`.
/// core/src/sources/text.ts `plainLine` is the page's copy, held to the same vectors.
pub(crate) fn plain(text: &str, max: usize) -> String {
    let chars: Vec<char> = text.chars().take(max.saturating_mul(8)).collect();
    let joins = |i: usize| {
        i > 0
            && chars.get(i - 1).is_some_and(|c| joinable(*c))
            && chars.get(i + 1).is_some_and(|c| joinable(*c))
    };
    let cleaned: String = chars
        .iter()
        .enumerate()
        .filter(|(i, c)| !hidden(**c) || (matches!(**c as u32, 0x200c | 0x200d) && joins(*i)))
        .map(|(_, c)| *c)
        .map(|c| {
            if c.is_control() || matches!(c as u32, 0x2028 | 0x2029) {
                ' '
            } else {
                c
            }
        })
        .collect();
    cleaned
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max)
        .collect()
}
/// Text already one plain line within `max`, and not empty.
fn is_plain(text: &str, max: usize) -> bool {
    !text.is_empty() && plain(text, max) == text
}
/// A list's id: `^[A-Za-z0-9_-]{1,64}$`.
pub(crate) fn valid_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
/// A Planning Center id, as the core checks one (core/src/sources/types.ts `TEAM_ID`): `^[1-9]\d{0,19}$`.
pub(crate) fn valid_team_id(id: &str) -> bool {
    (1..=20).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_digit()) && !id.starts_with('0')
}
/// When a list was last read, as native code writes it (sunday_check.rs `rfc3339`): `2026-11-20T15:05:00.000Z`.
fn valid_instant(text: &str) -> bool {
    let b = text.as_bytes();
    if b.len() != 24 || [4, 7, 10, 13, 16, 19, 23].map(|i| b[i]) != *b"--T::.Z" {
        return false;
    }
    let digits = [0..4, 5..7, 8..10, 11..13, 14..16, 17..19, 20..23];
    if !digits
        .iter()
        .all(|r| b[r.clone()].iter().all(u8::is_ascii_digit))
    {
        return false;
    }
    let num = |r: std::ops::Range<usize>| text[r].parse::<u32>().unwrap_or(u32::MAX);
    (1..=12).contains(&num(5..7))
        && (1..=31).contains(&num(8..10))
        && num(11..13) < 24
        && num(14..16) < 60
        && num(17..19) < 60
}

// ---- The list --------------------------------------------------------------------------------------------

/// A value in the chosen column, matched by the leader to a Planning Center team, or one position on it by name.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StoredMatch {
    pub value: String,
    pub team_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position_name: Option<String>,
}
/// A section of notes attached by the leader to a Planning Center team (by id) or to a kind of finding: exactly one.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StoredAttachment {
    /// The section's title as the page reads it (core/src/sources/notes.ts `sectionFor`).
    pub section: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finding_kind: Option<String>,
    /// Which section with this title, when titles repeat: 2 for the second and so on; the first leaves it out (review
    /// V, M1), as every pointer written before this did.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub occurrence: Option<u32>,
    /// How many sections had this title when the leader chose it (audit item 30), so the page can say the notes changed
    /// rather than follow a different section once that number changes. From 1, never below `occurrence`; a pointer
    /// written before this has none, which the page reads as unknown.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub of: Option<u32>,
}
/// One list as kept on this Mac. `path` never leaves native code.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Stored {
    pub id: String,
    /// "file": a spreadsheet file on this Mac; "link": a private link to a published sheet, its address only in the
    /// Keychain under this id (sheet_link.rs); "notes": the church's own notes, a plain text or Markdown file on this Mac.
    pub kind: String,
    pub label: String,
    /// The file's name, or the link's host with the rest masked, as the page shows it.
    pub shown: String,
    /// A file's place on this Mac; a link has none (a list written before links has one for every entry).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub column: Option<String>,
    pub ticked: Vec<String>,
    pub matches: Vec<StoredMatch>,
    /// Notes only: the sections attached (a list written before notes has none for every entry).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<StoredAttachment>,
    pub read_at: Option<String>,
}
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct ListFile {
    version: u32,
    sources: Vec<Stored>,
}

fn valid_match(m: &StoredMatch) -> bool {
    is_plain(&m.value, MAX_CELL)
        && valid_team_id(&m.team_id)
        && m.position_name
            .as_deref()
            .is_none_or(|p| is_plain(p, MAX_NAME))
}
fn valid_path(path: &str) -> bool {
    path.len() <= MAX_PATH_BYTES && path.starts_with('/') && !path.contains('\0')
}
/// Whether no text comes twice.
fn unique<'a>(mut items: impl Iterator<Item = &'a str>) -> bool {
    let mut seen = std::collections::HashSet::new();
    items.all(|i| seen.insert(i))
}
/// Whether an id is a private link's (the links' store makes them: 16 lowercase hex characters).
fn link_id(id: &str) -> bool {
    ozzie_native_auth::calendar_link::valid_id(id)
}
/// How a link the links' store doesn't hold is listed: no host at all (review U, finding 2).
pub const LINK_NOT_HELD: &str = "\u{2022}\u{2022}\u{2022}";
/// How a link is shown: its host, which the links' store keeps for it, then "/•••" for the rest of the address.
const MASKED: &str = "/\u{2022}\u{2022}\u{2022}";
/// Whether `shown` is a link's host as the store shows it, whole: a public host name of at most
/// `sheet_link::MAX_HOST` characters, then `MASKED` (review T, L2).
fn link_shown(shown: &str) -> bool {
    shown.strip_suffix(MASKED).is_some_and(|host| {
        host.chars().count() <= sheet_link::MAX_HOST
            && ozzie_native_auth::calendar_link::public_name(host)
            && host == host.to_ascii_lowercase()
    })
}
/// Whether text is a section's title as a pointer keeps it: at most `MAX_TITLE` characters, one plain line once its
/// joiners are set aside. Whether a joiner stays depends on each runtime's Unicode data (`joinable`), so it is never
/// what makes the whole list unreadable (review V); a title that differs only there just finds no section.
fn title_like(title: &str) -> bool {
    let without: String = title
        .chars()
        .filter(|c| !matches!(c, '\u{200c}' | '\u{200d}'))
        .collect();
    !title.is_empty() && title.chars().count() <= MAX_TITLE && is_plain(&without, MAX_TITLE)
}
/// Whether a section is attached to exactly one thing: a team by a Planning Center id, or one of the closed kinds; and,
/// when it isn't the first with its title, which one it is.
fn valid_attachment(a: &StoredAttachment) -> bool {
    title_like(&a.section)
        && a.occurrence
            .is_none_or(|n| (2..=MAX_NOTE_LINES).contains(&n))
        && a.of
            .is_none_or(|n| (1..=MAX_NOTE_LINES).contains(&n) && a.occurrence.unwrap_or(1) <= n)
        && match (a.team_id.as_deref(), a.finding_kind.as_deref()) {
            (Some(team), None) => valid_team_id(team),
            (None, Some(kind)) => NOTE_FINDING_KINDS.contains(&kind),
            _ => false,
        }
}
/// What an attachment is attached to, as one key: the same section attached twice to one thing is once.
fn attachment_key(a: &StoredAttachment) -> String {
    format!(
        "{}\u{0}{:?}\u{0}{:?}\u{0}{}",
        a.section,
        a.team_id,
        a.finding_kind,
        a.occurrence.unwrap_or(1)
    )
}
/// Whether a kept list is in this version's format, every text already plain and within its limit: a file with its
/// place, a link with a link's id and no place, or notes with their place, their attachments and none of a list's
/// settings.
fn valid(s: &Stored) -> bool {
    let kind = match (s.kind.as_str(), s.path.as_deref()) {
        ("file", Some(path)) => valid_path(path) && s.attachments.is_empty(),
        ("link", None) => link_id(&s.id) && link_shown(&s.shown) && s.attachments.is_empty(),
        ("notes", Some(path)) => {
            valid_path(path)
                && s.column.is_none()
                && s.ticked.is_empty()
                && s.matches.is_empty()
                && s.attachments.len() <= MAX_ATTACHMENTS
                && s.attachments.iter().all(valid_attachment)
                && unique(
                    s.attachments
                        .iter()
                        .map(attachment_key)
                        .collect::<Vec<_>>()
                        .iter()
                        .map(String::as_str),
                )
        }
        _ => false,
    };
    valid_id(&s.id)
        && kind
        && is_plain(&s.label, MAX_LABEL)
        && is_plain(&s.shown, MAX_SHOWN)
        && s.column.as_deref().is_none_or(|c| is_plain(c, MAX_HEADER))
        && s.ticked.len() <= MAX_TICKED
        && s.ticked.iter().all(|t| is_plain(t, MAX_HEADER))
        && unique(s.ticked.iter().map(String::as_str))
        && s.matches.len() <= MAX_MATCHES
        && s.matches.iter().all(valid_match)
        && unique(s.matches.iter().map(|m| m.value.as_str()))
        && s.read_at.as_deref().is_none_or(valid_instant)
}

/// A list or notes as the page sees them (core/src/sources/types.ts `SheetSource`, `NotesSource`): no path.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(untagged)]
pub enum SourceView {
    Sheet(SheetView),
    Notes(NotesView),
}
impl SourceView {
    /// When it was last read, as kept.
    #[cfg(test)]
    pub fn read_at(&self) -> Option<&str> {
        match self {
            Self::Sheet(s) => s.read_at.as_deref(),
            Self::Notes(n) => n.read_at.as_deref(),
        }
    }
}
/// Notes as the page sees them: the file's name, the sections attached, when they were last read.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct NotesView {
    id: String,
    kind: &'static str,
    label: String,
    shown: String,
    attachments: Vec<StoredAttachment>,
    read_at: Option<String>,
}
/// A list as the page sees it: the matches as an object keyed by the value in the chosen column.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct SheetView {
    id: String,
    kind: &'static str,
    label: String,
    shown: String,
    column: Option<String>,
    ticked: Vec<String>,
    matches: MatchMap,
    read_at: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
struct MatchMap(Vec<StoredMatch>);
impl serde::Serialize for MatchMap {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        #[derive(serde::Serialize)]
        struct Target<'a> {
            team_id: &'a str,
            #[serde(skip_serializing_if = "Option::is_none")]
            position_name: Option<&'a str>,
        }
        let mut map = serializer.serialize_map(Some(self.0.len()))?;
        for m in &self.0 {
            map.serialize_entry(
                &m.value,
                &Target {
                    team_id: &m.team_id,
                    position_name: m.position_name.as_deref(),
                },
            )?;
        }
        map.end()
    }
}
impl From<&Stored> for SourceView {
    fn from(s: &Stored) -> Self {
        if s.kind == "notes" {
            return Self::Notes(NotesView {
                id: s.id.clone(),
                kind: "notes",
                label: s.label.clone(),
                shown: s.shown.clone(),
                attachments: s.attachments.clone(),
                read_at: s.read_at.clone(),
            });
        }
        Self::Sheet(SheetView {
            id: s.id.clone(),
            kind: if s.kind == "link" { "link" } else { "file" },
            label: s.label.clone(),
            shown: s.shown.clone(),
            column: s.column.clone(),
            ticked: s.ticked.clone(),
            matches: MatchMap(s.matches.clone()),
            read_at: s.read_at.clone(),
        })
    }
}
/// A section attached as the page sends it with `church_notes_set`.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttachmentInput {
    pub section: String,
    #[serde(default)]
    pub team_id: Option<String>,
    #[serde(default)]
    pub finding_kind: Option<String>,
    #[serde(default)]
    pub occurrence: Option<u32>,
    /// How many sections had this title when the leader chose it (audit item 30). Absent: unknown.
    #[serde(default)]
    pub of: Option<u32>,
}

/// A match as the page sends it with `church_source_set`.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MatchInput {
    pub value: String,
    pub team_id: String,
    #[serde(default)]
    pub position_name: Option<String>,
}
/// What the leader set on the Lists & notes page, whole: the label, the column that names a team or role, the columns
/// shown on a Sunday card and the matches.
#[derive(Debug, Clone)]
pub struct SourceChange {
    pub label: String,
    pub column: Option<String>,
    pub ticked: Vec<String>,
    pub matches: Vec<MatchInput>,
}
/// The change made plain and checked (`checked`).
struct Checked {
    label: String,
    column: Option<String>,
    ticked: Vec<String>,
    matches: Vec<StoredMatch>,
}
/// Text made plain within `max`, refused when nothing is left.
fn required(text: &str, max: usize) -> Result<String, SourceError> {
    Some(plain(text, max))
        .filter(|t| !t.is_empty())
        .ok_or(SourceError::Unavailable)
}
/// The change made plain and checked: every text one plain line within its limit and not empty, ids that are ids, at
/// most 8 columns shown and each once, every value matched once. Anything else refuses the whole change.
fn checked(change: SourceChange) -> Result<Checked, SourceError> {
    let bad = SourceError::Unavailable;
    let label = required(&change.label, MAX_LABEL)?;
    let column = change
        .column
        .map(|c| required(&c, MAX_HEADER))
        .transpose()?;
    if change.ticked.len() > MAX_TICKED || change.matches.len() > MAX_MATCHES {
        return Err(bad);
    }
    let mut ticked: Vec<String> = Vec::with_capacity(change.ticked.len());
    for t in change.ticked {
        let t = required(&t, MAX_HEADER)?;
        if ticked.contains(&t) {
            return Err(bad);
        }
        ticked.push(t);
    }
    let mut matches: Vec<StoredMatch> = Vec::with_capacity(change.matches.len());
    let mut seen = std::collections::HashSet::new();
    for m in change.matches {
        let value = required(&m.value, MAX_CELL)?;
        let position_name = m
            .position_name
            .map(|p| required(&p, MAX_NAME))
            .transpose()?;
        if !valid_team_id(&m.team_id) || !seen.insert(value.clone()) {
            return Err(bad);
        }
        matches.push(StoredMatch {
            value,
            team_id: m.team_id,
            position_name,
        });
    }
    Ok(Checked {
        label,
        column,
        ticked,
        matches,
    })
}

/// The lists the leader added, kept in one file. One change at a time, so a read never undoes a change.
pub struct Sources {
    list: PathBuf,
    refused: Refused,
    lock: Mutex<()>,
    /// Held while a private link is added or forgotten (taken before `lock`, never while holding it), so tidying the
    /// links' addresses never takes one about to be listed here.
    adding: Mutex<()>,
}
impl Sources {
    pub fn new(list: PathBuf, refused: Refused) -> Self {
        Self {
            list,
            refused,
            lock: Mutex::new(()),
            adding: Mutex::new(()),
        }
    }
    fn adding(&self) -> std::sync::MutexGuard<'_, ()> {
        self.adding.lock().unwrap_or_else(|e| e.into_inner())
    }
    fn guard(&self) -> std::sync::MutexGuard<'_, ()> {
        self.lock.lock().unwrap_or_else(|e| e.into_inner())
    }
    /// The list: none when there's no file; `ListUnreadable` for a file that can't be read, is too large, or is not
    /// exactly this version's format (one bad entry refuses all of it).
    fn load(&self) -> Result<Vec<Stored>, SourceError> {
        let file = match std::fs::File::open(&self.list) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(_) => return Err(SourceError::ListUnreadable),
        };
        let mut bytes = Vec::new();
        if file
            .take(MAX_LIST_BYTES + 1)
            .read_to_end(&mut bytes)
            .is_err()
            || bytes.len() as u64 > MAX_LIST_BYTES
        {
            return Err(SourceError::ListUnreadable);
        }
        let list: ListFile =
            serde_json::from_slice(&bytes).map_err(|_| SourceError::ListUnreadable)?;
        let mut ids = std::collections::HashSet::new();
        if list.version != 1
            || list.sources.len() > MAX_SOURCES
            || list.sources.iter().filter(|s| s.kind == "link").count() > MAX_LINKS
            || !list
                .sources
                .iter()
                .all(|s| valid(s) && ids.insert(s.id.clone()))
        {
            return Err(SourceError::ListUnreadable);
        }
        Ok(list.sources)
    }
    /// Replaces the list whole (a partial file, renamed into place), readable by this user only, in a folder only
    /// this user can open.
    fn save(&self, sources: &[Stored]) -> Result<(), SourceError> {
        let write = || -> std::io::Result<()> {
            let dir = self
                .list
                .parent()
                .ok_or_else(|| std::io::Error::other("no folder"))?;
            let mut builder = std::fs::DirBuilder::new();
            builder.recursive(true);
            std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
            builder.create(dir)?;
            let text = serde_json::to_vec(&ListFile {
                version: 1,
                sources: sources.to_vec(),
            })
            .map_err(std::io::Error::other)?;
            if text.len() as u64 > MAX_LIST_BYTES {
                return Err(std::io::Error::other("too large"));
            }
            let partial = self.list.with_extension("partial");
            let _ = std::fs::remove_file(&partial);
            let mut options = std::fs::OpenOptions::new();
            std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
            let written = options
                .write(true)
                .create_new(true)
                .open(&partial)
                .and_then(|mut file| {
                    file.write_all(&text)?;
                    file.sync_all()
                });
            if let Err(error) = written.and_then(|()| std::fs::rename(&partial, &self.list)) {
                let _ = std::fs::remove_file(&partial);
                return Err(error);
            }
            Ok(())
        };
        write().map_err(|_| SourceError::Unavailable)
    }

    /// Every list, as the page sees it.
    pub fn list(&self) -> Result<Vec<SourceView>, SourceError> {
        let _held = self.guard();
        Ok(self.load()?.iter().map(SourceView::from).collect())
    }

    /// Every list, with each link's host as the links' store holds it for that link's id (review U, finding 2): this
    /// list names a link, the store says where it points, so the page never shows a host the store doesn't hold. A
    /// link the store doesn't list (or a store that can't be read) shows `LINK_NOT_HELD`; reading it then says the
    /// link is missing.
    pub fn list_with_links(
        &self,
        links: Option<&SheetLinks>,
    ) -> Result<Vec<SourceView>, SourceError> {
        let held = links.and_then(|l| l.list().ok()).unwrap_or_default();
        Ok(self
            .list()?
            .into_iter()
            .map(|view| match view {
                SourceView::Sheet(mut sheet) if sheet.kind == "link" => {
                    sheet.shown = held
                        .iter()
                        .find(|l| l.id == sheet.id && !l.unusable)
                        .map_or_else(|| LINK_NOT_HELD.to_owned(), |l| l.shown.clone());
                    SourceView::Sheet(sheet)
                }
                other => other,
            })
            .collect())
    }

    /// Adds the file the leader chose, once it reads as a file Ozzie can show (`read_source_file`); the same file
    /// chosen again is the list already there. Its label starts as the file's name without its extension.
    #[cfg(test)]
    pub fn add(
        &self,
        path: &Path,
        new_id: impl Fn() -> Result<String, SourceError>,
    ) -> Result<SourceView, SourceError> {
        self.add_kind(path, "file", new_id)
    }

    /// Adds the file the leader chose as a list ("file") or as notes ("notes"), once it reads as that kind's file
    /// (`read_source_file` at its limit); the same file chosen again as the same kind is the one already there. Its
    /// label starts as the file's name without its extension.
    pub fn add_kind(
        &self,
        path: &Path,
        kind: &str,
        new_id: impl Fn() -> Result<String, SourceError>,
    ) -> Result<SourceView, SourceError> {
        let (kind, max, unnamed) = match kind {
            "file" => ("file", MAX_SOURCE_BYTES, "Church list"),
            "notes" => ("notes", MAX_NOTES_BYTES, "Church notes"),
            _ => return Err(SourceError::Unavailable),
        };
        let text = path
            .to_str()
            .filter(|p| valid_path(p))
            .ok_or(SourceError::Unavailable)?;
        read_source_file(path, &self.refused, max)?;
        let _held = self.guard();
        let mut sources = self.load()?;
        if let Some(found) = sources
            .iter()
            .find(|s| s.kind == kind && s.path.as_deref() == Some(text))
        {
            return Ok(SourceView::from(found));
        }
        if sources.len() >= MAX_SOURCES {
            return Err(SourceError::Unavailable);
        }
        let name = |part: Option<&std::ffi::OsStr>, max: usize| {
            plain(&part.map(|p| p.to_string_lossy()).unwrap_or_default(), max)
        };
        let shown = Some(name(path.file_name(), MAX_SHOWN))
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "the chosen file".into());
        let label = Some(name(path.file_stem(), MAX_LABEL))
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| unnamed.into());
        let mut id = new_id()?;
        while sources.iter().any(|s| s.id == id) {
            id = new_id()?;
        }
        if !valid_id(&id) {
            return Err(SourceError::Unavailable);
        }
        let entry = Stored {
            id,
            kind: kind.into(),
            label,
            shown,
            path: Some(text.to_owned()),
            column: None,
            ticked: Vec::new(),
            matches: Vec::new(),
            attachments: Vec::new(),
            read_at: None,
        };
        sources.push(entry.clone());
        self.save(&sources)?;
        Ok(SourceView::from(&entry))
    }

    /// A list's or notes' file, read again from where it was chosen, at its kind's limit; when it reads, it remembers
    /// when (`now`). A link's list is read with `read_link`.
    pub fn read(&self, id: &str, now: impl Fn() -> String) -> Result<Vec<u8>, SourceError> {
        if !valid_id(id) {
            return Err(SourceError::Unavailable);
        }
        let (path, max) = {
            let _held = self.guard();
            let sources = self.load()?;
            sources
                .iter()
                .find(|s| s.id == id && (s.kind == "file" || s.kind == "notes"))
                .and_then(|s| {
                    let max = if s.kind == "notes" {
                        MAX_NOTES_BYTES
                    } else {
                        MAX_SOURCE_BYTES
                    };
                    s.path.clone().map(|p| (p, max))
                })
                .ok_or(SourceError::Unavailable)?
        };
        let bytes = read_source_file(Path::new(&path), &self.refused, max)?;
        let _held = self.guard();
        if let Ok(mut sources) = self.load()
            && let Some(entry) = sources
                .iter_mut()
                .find(|s| s.id == id && s.path.as_deref() == Some(path.as_str()))
        {
            entry.read_at = Some(now());
            // When it was read is a convenience: the bytes go back even if it couldn't be kept.
            let _ = self.save(&sources);
        }
        Ok(bytes)
    }

    /// What the leader set for a list, replaced whole once it is checked (`checked`).
    pub fn set(&self, id: &str, change: SourceChange) -> Result<SourceView, SourceError> {
        if !valid_id(id) {
            return Err(SourceError::Unavailable);
        }
        let Checked {
            label,
            column,
            ticked,
            matches,
        } = checked(change)?;
        let _held = self.guard();
        let mut sources = self.load()?;
        let entry = sources
            .iter_mut()
            .find(|s| s.id == id && (s.kind == "file" || s.kind == "link"))
            .ok_or(SourceError::Unavailable)?;
        entry.label = label;
        entry.column = column;
        entry.ticked = ticked;
        entry.matches = matches;
        let view = SourceView::from(&*entry);
        self.save(&sources)?;
        Ok(view)
    }

    /// What the leader set for notes, replaced whole once it is checked: the label and the sections attached, each to a
    /// Planning Center team by its id or to one of the closed kinds of finding (`NOTE_FINDING_KINDS`). Every text made
    /// plain; anything else (both or neither, a kind not in the list, a section twice, too many) refuses all of it.
    pub fn set_notes(
        &self,
        id: &str,
        label: &str,
        attachments: Vec<AttachmentInput>,
    ) -> Result<SourceView, SourceError> {
        let bad = SourceError::Unavailable;
        if !valid_id(id) || attachments.len() > MAX_ATTACHMENTS {
            return Err(bad);
        }
        let label = required(label, MAX_LABEL)?;
        let mut kept: Vec<StoredAttachment> = Vec::with_capacity(attachments.len());
        for a in attachments {
            // The title exactly as the page read it: one native code would keep another way is refused in its own words
            // (review V), never kept changed so that it matches nothing.
            if a.section.is_empty() {
                return Err(bad);
            }
            if plain(&a.section, MAX_TITLE) != a.section {
                return Err(SourceError::SectionTitle);
            }
            let occurrence = match a.occurrence {
                None | Some(1) => None,
                Some(n) if (2..=MAX_NOTE_LINES).contains(&n) => Some(n),
                Some(_) => return Err(bad),
            };
            let attachment = StoredAttachment {
                section: a.section,
                team_id: a.team_id,
                finding_kind: a.finding_kind,
                occurrence,
                of: a.of,
            };
            if !valid_attachment(&attachment)
                || kept
                    .iter()
                    .any(|k| attachment_key(k) == attachment_key(&attachment))
            {
                return Err(bad);
            }
            kept.push(attachment);
        }
        let _held = self.guard();
        let mut sources = self.load()?;
        let entry = sources
            .iter_mut()
            .find(|s| s.id == id && s.kind == "notes")
            .ok_or(bad)?;
        entry.label = label;
        entry.attachments = kept;
        let view = SourceView::from(&*entry);
        self.save(&sources)?;
        Ok(view)
    }

    /// Removes a list or notes from Ozzie; the file stays where it is. One that isn't there any more is already
    /// removed. A link's list is removed with `remove_link`, which forgets its address too.
    pub fn remove(&self, id: &str) -> Result<(), SourceError> {
        if !valid_id(id) {
            return Err(SourceError::Unavailable);
        }
        let _held = self.guard();
        let mut sources = self.load()?;
        if sources.iter().any(|s| s.id == id && s.kind == "link") {
            return Err(SourceError::Unavailable);
        }
        let before = sources.len();
        sources.retain(|s| s.id != id);
        if sources.len() == before {
            return Ok(());
        }
        self.save(&sources)
    }

    /// "Forget all lists": every private link's address and the links' own list go (`links`), then this list, whatever
    /// is in it (the way out when it can't be read). No file or sheet is touched. When the Keychain doesn't let the
    /// addresses go, this list still goes and the links' own list stays, so the addresses are removed when the lists
    /// are next listed or a link is next added and the Keychain answers (`prune_links`, `add_link`; review T, L7;
    /// review U, finding 3): `LinksLeftInKeychain` says so.
    pub fn forget_all(&self, links: &SheetLinks) -> Result<(), SourceError> {
        let _adding = self.adding();
        let addresses = links.forget_all();
        let _held = self.guard();
        let _ = std::fs::remove_file(self.list.with_extension("partial"));
        match std::fs::remove_file(&self.list) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(SourceError::Unavailable),
        }
        addresses.map_err(|_| SourceError::LinksLeftInKeychain)
    }
}

// ---- Private links to published sheets ------------------------------------------------------------------------------

impl Sources {
    /// "Add a list from a private link": the links' store checks the address and reads it once (it must give back a
    /// sheet) before keeping it in the Keychain; this list then gets the link's id, the leader's label and the host
    /// masked, read when it was added. Nothing is read for a list this one can't take (full, or unreadable), and an
    /// add whose list can't be saved here takes the kept address out again. The sheet's bytes go back to the page with
    /// the new list, so adding is one read.
    pub fn add_link(
        &self,
        links: &SheetLinks,
        label: &str,
        address: &str,
        now: impl Fn() -> String,
    ) -> Result<(SourceView, Vec<u8>), SourceError> {
        let label = required(label, MAX_LABEL)?;
        let room = |sources: &[Stored]| {
            if sources.iter().filter(|s| s.kind == "link").count() >= MAX_LINKS {
                Err(SourceError::TooManyLinks)
            } else if sources.len() >= MAX_SOURCES {
                Err(SourceError::Unavailable)
            } else {
                Ok(())
            }
        };
        let _adding = self.adding();
        let named = {
            let _held = self.guard();
            let sources = self.load()?;
            room(&sources)?;
            sources
                .into_iter()
                .filter(|s| s.kind == "link")
                .map(|s| s.id)
                .collect::<Vec<_>>()
        };
        // Addresses no list here names (left by a forget the Keychain refused, or an add that stopped halfway) go first,
        // so they never count toward the links' limit (review U, finding 3).
        Self::remove_unnamed(links, &named);
        // Already saved for a list here (review T, B): compared inside the store, which gives back an id only.
        if links
            .saved_id(address)?
            .is_some_and(|id| named.contains(&id))
        {
            return Err(SourceError::LinkAlreadyAdded);
        }
        let (link, sheet) = links.add(sheet_link::LABEL, address)?;
        let kept = (|| {
            let _held = self.guard();
            let mut sources = self.load()?;
            room(&sources)?;
            let entry = Stored {
                id: link.id.clone(),
                kind: "link".into(),
                label,
                shown: link.shown.clone(),
                path: None,
                column: None,
                ticked: Vec::new(),
                matches: Vec::new(),
                attachments: Vec::new(),
                read_at: Some(now()),
            };
            if !valid(&entry) || sources.iter().any(|s| s.id == entry.id) {
                return Err(SourceError::Unavailable);
            }
            sources.push(entry.clone());
            self.save(&sources)?;
            Ok(SourceView::from(&entry))
        })();
        match kept {
            Ok(view) => Ok((view, sheet)),
            Err(error) => {
                // The links' store never keeps a link no list here names.
                let _ = links.remove(&link.id);
                Err(error)
            }
        }
    }

    /// A link's sheet, read again: one guarded GET at the Keychain's address, checked again first. When it reads, the
    /// list remembers when (`now`). A file's list is read with `read`.
    pub fn read_link(
        &self,
        links: &SheetLinks,
        id: &str,
        now: impl Fn() -> String,
    ) -> Result<Vec<u8>, SourceError> {
        let listed = |sources: &[Stored]| sources.iter().any(|s| s.id == id && s.kind == "link");
        if !link_id(id) {
            return Err(SourceError::Unavailable);
        }
        let shown = {
            let _held = self.guard();
            let sources = self.load()?;
            if !listed(&sources) {
                return Err(SourceError::Unavailable);
            }
            sources
                .into_iter()
                .find(|s| s.id == id)
                .map(|s| s.shown)
                .unwrap_or_default()
        };
        // The host shown here must be the one the links' store has for this id: a list changed outside Ozzie is never
        // read under another host's name (review T, L2).
        if !links.list()?.iter().any(|l| l.id == id && l.shown == shown) {
            return Err(SourceError::LinkMissing);
        }
        let bytes = links.read(id)?;
        let _held = self.guard();
        if let Ok(mut sources) = self.load()
            && let Some(entry) = sources.iter_mut().find(|s| s.id == id && s.kind == "link")
        {
            entry.read_at = Some(now());
            // When it was read is a convenience: the bytes go back even if it couldn't be kept.
            let _ = self.save(&sources);
        }
        Ok(bytes)
    }

    /// "Remove this list" for a link: its address leaves the Keychain first, then its entry beside it, then its list
    /// here. Only while this list can be read, so an address never goes without the list that names it going too. The
    /// sheet itself doesn't change.
    pub fn remove_link(&self, links: &SheetLinks, id: &str) -> Result<(), SourceError> {
        if !link_id(id) {
            return Err(SourceError::Unavailable);
        }
        {
            let _held = self.guard();
            if self.load()?.iter().any(|s| s.id == id && s.kind != "link") {
                return Err(SourceError::Unavailable);
            }
        }
        match links.remove(id) {
            Ok(()) => {}
            // The links' store doesn't name it (a removal that stopped halfway): listing there removes any address
            // it still keeps for a link it doesn't name.
            Err(LinkError::Unknown) => {
                let _ = links.list();
            }
            Err(error) => return Err(error.into()),
        }
        let _held = self.guard();
        let mut sources = self.load()?;
        let before = sources.len();
        sources.retain(|s| !(s.id == id && s.kind == "link"));
        if sources.len() == before {
            return Ok(());
        }
        self.save(&sources)
    }

    /// "Forget all private links": every address in the sheet links' Keychain service and the links' own list go (the
    /// way out when that list can't be read), then each link's list here, when this list can be read ("Forget all
    /// lists" is the way out when it can't). Files' lists stay.
    pub fn forget_links(&self, links: &SheetLinks) -> Result<(), SourceError> {
        let _adding = self.adding();
        links.forget_all()?;
        let _held = self.guard();
        if let Ok(mut sources) = self.load() {
            let before = sources.len();
            sources.retain(|s| s.kind != "link");
            if sources.len() != before {
                self.save(&sources)?;
            }
        }
        Ok(())
    }

    /// Removes any address the links' store keeps for a link no list here names (left by an add or a removal that
    /// stopped halfway, or a list here put back from an older copy), so an address is never kept without a way to see
    /// and remove it. Only when both lists read cleanly, and never while a link is being added or forgotten.
    pub fn prune_links(&self, links: &SheetLinks) {
        let Ok(_adding) = self.adding.try_lock() else {
            return;
        };
        let named: Vec<String> = {
            let _held = self.guard();
            match self.load() {
                Ok(sources) => sources
                    .into_iter()
                    .filter(|s| s.kind == "link")
                    .map(|s| s.id)
                    .collect(),
                Err(_) => return,
            }
        };
        Self::remove_unnamed(links, &named);
    }

    /// Removes each address the links' store keeps for a link `named` doesn't hold; nothing when the store can't be read.
    fn remove_unnamed(links: &SheetLinks, named: &[String]) {
        let Ok(saved) = links.list() else {
            return;
        };
        for link in saved
            .iter()
            .filter(|l| !l.unusable && !named.contains(&l.id))
        {
            let _ = links.remove(&link.id);
        }
    }
}

// ---- Where a list may be read from ------------------------------------------------------------------------------

/// The folders a list is never read from (the user's Library folder, Ozzie's own data and cache folders), less the
/// folders inside them where people keep their own documents: iCloud Drive itself, each app's Documents folder in
/// iCloud (where Numbers and TextEdit save), and the cloud drives macOS shows in Finder, which live in the Library
/// folder. Apps' private iCloud containers (Mail's, text input's) stay refused (review U, note 2). Any hidden file or
/// folder is refused everywhere. Each is kept as macOS names an open file (`folder_name`) and compared without regard to
/// case, as this Mac's disks usually are.
pub struct Refused {
    folders: Vec<PathBuf>,
    /// Inside the folders, read anywhere under these: iCloud Drive and the cloud drives.
    documents: Vec<PathBuf>,
    /// iCloud's apps' containers: inside one, only its Documents folder is read.
    containers: PathBuf,
}
/// A folder as macOS names an open file in it (`F_GETPATH` on the folder, opened read-only; review S2, E): links on the
/// way followed, each name as it is on disk, and a folder given in the data volume's form (`/System/Volumes/Data/…`)
/// under its usual name, as an opened file's path is. A folder that isn't there yet is named as `canonicalize` names
/// it, or as written.
fn folder_name(folder: &Path) -> PathBuf {
    std::fs::File::open(folder)
        .ok()
        .and_then(|opened| opened_at(&opened, folder))
        .or_else(|| std::fs::canonicalize(folder).ok())
        .unwrap_or_else(|| folder.to_path_buf())
}
impl Refused {
    /// The Library folder in `home` and Ozzie's own folders, with iCloud Drive, apps' Documents folders in iCloud and
    /// the other cloud drives left readable (review S2, finding 2; review U, note 2). Only `home` and Ozzie's own folders
    /// are opened to name them: the Library folder, iCloud Drive and the cloud drives are named from the home folder, so
    /// naming them never asks macOS for a protected folder.
    pub fn for_this_mac(home: &Path, own: impl IntoIterator<Item = PathBuf>) -> Self {
        let library = folder_name(home).join("Library");
        let containers = library.join("Mobile Documents");
        let documents = [
            containers.join("com~apple~CloudDocs"),
            library.join("CloudStorage"),
        ];
        Self {
            folders: std::iter::once(library)
                .chain(own.into_iter().map(|f| folder_name(&f)))
                .map(|f| folded(&f))
                .collect(),
            documents: documents.iter().map(|d| folded(d)).collect(),
            containers: folded(&containers),
        }
    }
    /// Whether a folded path is in a place people keep their own documents: iCloud Drive, a cloud drive, or an app's
    /// Documents folder in iCloud (`Mobile Documents/<app>/Documents/…`).
    fn documents(&self, path: &Path) -> bool {
        self.documents.iter().any(|d| path.starts_with(d))
            || path.strip_prefix(&self.containers).is_ok_and(|inside| {
                let mut parts = inside.components();
                matches!(
                    (parts.next(), parts.next(), parts.next()),
                    (Some(Component::Normal(_)), Some(Component::Normal(folder)), Some(_)) if folder == "documents"
                )
            })
    }
    /// Whether `path` is somewhere a list is never read from: with any part of it hidden (or a step back up, which a
    /// chosen path never has), or under one of the folders and not in one of the document folders inside them.
    pub fn covers(&self, path: &Path) -> bool {
        path.components().any(|c| match c {
            Component::Normal(name) => name.as_encoded_bytes().first() == Some(&b'.'),
            Component::ParentDir | Component::CurDir => true,
            Component::RootDir | Component::Prefix(_) => false,
        }) || {
            let path = folded(path);
            self.folders.iter().any(|f| path.starts_with(f)) && !self.documents(&path)
        }
    }
}
/// A path in lower case, for comparing places on a disk that ignores case.
fn folded(path: &Path) -> PathBuf {
    PathBuf::from(path.to_string_lossy().to_lowercase())
}
/// Where an open file is, as macOS names it (`F_GETPATH`): links in its folders followed, each name as it is on disk.
#[cfg(target_os = "macos")]
fn opened_at(file: &std::fs::File, _: &Path) -> Option<PathBuf> {
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::io::AsRawFd;
    let mut name = vec![0u8; libc::PATH_MAX as usize + 1];
    // SAFETY: F_GETPATH writes the open file's path, NUL-terminated and at most PATH_MAX bytes, into `name`, which is
    // larger than that and lives until the call returns.
    let found = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETPATH, name.as_mut_ptr()) };
    let end = name.iter().position(|b| *b == 0)?;
    (found != -1 && end > 0).then(|| PathBuf::from(std::ffi::OsStr::from_bytes(&name[..end])))
}
#[cfg(not(target_os = "macos"))]
fn opened_at(_: &std::fs::File, path: &Path) -> Option<PathBuf> {
    std::fs::canonicalize(path).ok()
}

// ---- Reading a chosen file ----------------------------------------------------------------------------------

/// One chosen file's bytes, as `read_card_photo` reads a photo: a regular file (not a link, folder, package, pipe or
/// device), opened without following a link and without waiting on a pipe, the same file after it is opened as before,
/// at most `max` bytes (`MAX_SOURCE_BYTES` for a list, `MAX_NOTES_BYTES` for notes), and nowhere `refused` covers, as
/// written or as macOS names it once open. A PDF (by its name, or how it starts) is refused as one, a ZIP (a Word,
/// Pages, .xlsx or .numbers file) or older Office file is a workbook, and a NUL byte without a UTF-16 byte-order mark
/// is not text (the page's own check, core/src/sources/text.ts `decodeText`, is the same).
pub fn read_source_file(path: &Path, refused: &Refused, max: u64) -> Result<Vec<u8>, SourceError> {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    if refused.covers(path) {
        return Err(SourceError::PrivatePlace);
    }
    // A PDF by its name says so before anything is read, whatever its size.
    if path
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("pdf"))
    {
        return Err(SourceError::Pdf);
    }
    let gone = |error: std::io::Error| match error.kind() {
        std::io::ErrorKind::NotFound => SourceError::FileMissing,
        std::io::ErrorKind::PermissionDenied => SourceError::NotAllowed,
        // O_NOFOLLOW on a link put in its place.
        _ if error.raw_os_error() == Some(libc::ELOOP) => SourceError::NotTheFile,
        _ => SourceError::Unavailable,
    };
    let before = std::fs::symlink_metadata(path).map_err(gone)?;
    if before.file_type().is_symlink() {
        return Err(SourceError::NotTheFile);
    }
    if !before.file_type().is_file() {
        return Err(SourceError::FileMissing);
    }
    if before.len() > max {
        return Err(SourceError::TooLarge);
    }
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(gone)?;
    let opened = file.metadata().map_err(|_| SourceError::Unavailable)?;
    if !opened.file_type().is_file() || opened.dev() != before.dev() || opened.ino() != before.ino()
    {
        return Err(SourceError::Unavailable);
    }
    // Where the file really is: a link to a folder on the way, or another case, can't lead somewhere refused.
    if opened_at(&file, path).is_none_or(|at| refused.covers(&at)) {
        return Err(SourceError::PrivatePlace);
    }
    if opened.len() > max {
        return Err(SourceError::TooLarge);
    }
    let mut bytes = Vec::with_capacity(opened.len() as usize);
    file.take(max + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| SourceError::Unavailable)?;
    if bytes.len() as u64 > max {
        return Err(SourceError::TooLarge);
    }
    if bytes.starts_with(b"%PDF-") {
        return Err(SourceError::Pdf);
    }
    if bytes.starts_with(b"PK\x03\x04")
        || bytes.starts_with(b"PK\x05\x06")
        || bytes.starts_with(&[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
    {
        return Err(SourceError::Workbook);
    }
    let utf16 = bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]);
    if !utf16 && bytes.contains(&0) {
        return Err(SourceError::NotText);
    }
    Ok(bytes)
}

/// A new list's id: 16 hex characters from this Mac's random source.
fn random_id() -> Result<String, SourceError> {
    let mut random = [0u8; 8];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut random))
        .map_err(|_| SourceError::Unavailable)?;
    Ok(random.iter().map(|b| format!("{b:02x}")).collect())
}

// ---- The panel ------------------------------------------------------------------------------------------------

/// A panel's types as UTType objects (as card_picker.rs makes them).
#[cfg(target_os = "macos")]
fn panel_types(
    identifiers: &[&str],
) -> Result<objc2::rc::Retained<objc2_foundation::NSArray<objc2::runtime::AnyObject>>, SourceError>
{
    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2_foundation::{NSArray, NSString};
    let ut_type = AnyClass::get(c"UTType").ok_or(SourceError::Unavailable)?;
    let mut types: Vec<Retained<AnyObject>> = Vec::with_capacity(identifiers.len());
    for identifier in identifiers {
        let identifier = NSString::from_str(identifier);
        // SAFETY: +[UTType typeWithIdentifier:] takes an NSString and returns a UTType or nil.
        let found: Option<Retained<AnyObject>> =
            unsafe { msg_send![ut_type, typeWithIdentifier: &*identifier] };
        types.push(found.ok_or(SourceError::Unavailable)?);
    }
    Ok(NSArray::from_retained_slice(&types))
}

/// What a panel offers and says: a list's (CSV, TSV or plain text) or notes' (plain text or Markdown, and a PDF so it
/// can be refused in plain words).
struct PanelWords {
    types: &'static [&'static str],
    title: &'static str,
    message: &'static str,
    prompt: &'static str,
}
const LIST_PANEL: PanelWords = PanelWords {
    types: &SOURCE_TYPES,
    title: "Add a list from this Mac",
    message: "Choose a spreadsheet saved as CSV or tab-separated text, up to 2 MB. Ozzie reads it on this Mac and changes nothing in it.",
    prompt: "Add this list",
};
const NOTES_PANEL: PanelWords = PanelWords {
    types: &NOTES_TYPES,
    title: "Add notes from this Mac",
    message: "Choose your church's notes saved as plain text or Markdown, up to 1 MB. Ozzie reads them on this Mac and changes nothing in them.",
    prompt: "Add these notes",
};
/// The open panel, on the main thread: one file of the kinds `words` offers. `Ok(None)` when the person cancels.
#[cfg(target_os = "macos")]
fn run_panel(words: &PanelWords) -> Result<Option<PathBuf>, SourceError> {
    use objc2::msg_send;
    use objc2_app_kit::{NSModalResponseOK, NSOpenPanel};
    use objc2_foundation::{MainThreadMarker, NSString};
    let mtm = MainThreadMarker::new().ok_or(SourceError::Unavailable)?;
    let types = panel_types(words.types)?;
    let panel = NSOpenPanel::openPanel(mtm);
    panel.setCanChooseFiles(true);
    panel.setCanChooseDirectories(false);
    panel.setAllowsMultipleSelection(false);
    panel.setTreatsFilePackagesAsDirectories(false);
    panel.setCanCreateDirectories(false);
    panel.setShowsHiddenFiles(false);
    panel.setResolvesAliases(true);
    // SAFETY: -[NSSavePanel setAllowedContentTypes:] takes an NSArray of UTType, which `types` is.
    let _: () = unsafe { msg_send![&*panel, setAllowedContentTypes: &*types] };
    panel.setTitle(Some(&NSString::from_str(words.title)));
    panel.setMessage(Some(&NSString::from_str(words.message)));
    panel.setPrompt(Some(&NSString::from_str(words.prompt)));
    if panel.runModal() != NSModalResponseOK {
        return Ok(None);
    }
    let url = panel.URL().ok_or(SourceError::Unavailable)?;
    if !url.isFileURL() {
        return Err(SourceError::Unavailable);
    }
    url.to_file_path().map(Some).ok_or(SourceError::Unavailable)
}
#[cfg(not(target_os = "macos"))]
fn run_panel(_: &PanelWords) -> Result<Option<PathBuf>, SourceError> {
    Err(SourceError::Unavailable)
}

/// One panel at a time.
static PICKING: AtomicBool = AtomicBool::new(false);
struct Picking;
impl Picking {
    fn begin() -> Result<Self, SourceError> {
        PICKING
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map(|_| Self)
            .map_err(|_| SourceError::Unavailable)
    }
}
impl Drop for Picking {
    fn drop(&mut self) {
        PICKING.store(false, Ordering::SeqCst);
    }
}

// ---- Commands ----------------------------------------------------------------------------------------------------

/// The lists, kept for the life of the app, in the app's data folder; never read from the user's Library folder (iCloud
/// Drive, apps' folders in it included, and the other cloud drives aside) or Ozzie's own folders.
fn sources(app: &tauri::AppHandle) -> Result<&'static Sources, SourceError> {
    static SOURCES: OnceLock<Sources> = OnceLock::new();
    if let Some(sources) = SOURCES.get() {
        return Ok(sources);
    }
    let paths = app.path();
    let unavailable = |_| SourceError::Unavailable;
    let dir = paths.app_data_dir().map_err(unavailable)?;
    let refused = Refused::for_this_mac(
        &paths.home_dir().map_err(unavailable)?,
        [
            dir.clone(),
            paths.app_cache_dir().map_err(unavailable)?,
            paths.app_local_data_dir().map_err(unavailable)?,
            paths.app_config_dir().map_err(unavailable)?,
            paths.app_log_dir().map_err(unavailable)?,
        ],
    );
    Ok(SOURCES.get_or_init(|| Sources::new(dir.join(LIST_FILE), refused)))
}
/// Stands in for the guarded client when this Mac can't make one: every read says so, and removing and forgetting
/// still work.
struct NoClient;
impl SheetFetch for NoClient {
    fn get(&self, _: &Url) -> Result<Fetched, LinkError> {
        Err(LinkError::Unavailable)
    }
}
/// The private links to published sheets, kept for the life of the app: addresses in this Mac's Keychain (service
/// `church.ozzie.source-links.v1`), their own list beside this one in the app's data folder, read by the guarded
/// client.
fn links(app: &tauri::AppHandle) -> Result<&'static SheetLinks, SourceError> {
    static LINKS: OnceLock<SheetLinks> = OnceLock::new();
    if let Some(links) = LINKS.get() {
        return Ok(links);
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| SourceError::Unavailable)?;
    let fetch: Arc<dyn SheetFetch> = match GuardedHttp::new() {
        Ok(client) => Arc::new(client),
        Err(_) => Arc::new(NoClient),
    };
    Ok(LINKS.get_or_init(|| {
        sheet_link::sheet_links(
            Arc::new(MacKeychain {
                service: sheet_link::KEYCHAIN_SERVICE.into(),
            }),
            dir.join(sheet_link::LIST_FILE),
            fetch,
        )
    }))
}
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, SourceError> + Send + 'static,
) -> Result<T, SourceError> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .unwrap_or(Err(SourceError::Unavailable))
}

/// The lists the leader added, with no path or address. An address kept for a link no list names is removed first.
#[tauri::command]
pub async fn church_sources(app: tauri::AppHandle) -> Result<Vec<SourceView>, SourceError> {
    blocking(move || {
        let sources = sources(&app)?;
        let links = links(&app).ok();
        if let Some(links) = links {
            sources.prune_links(links);
        }
        sources.list_with_links(links)
    })
    .await
}

/// "Add a list from this Mac": Ozzie's own panel, then the chosen file checked and added. The new list (with no path),
/// or nothing when the person cancels.
#[tauri::command]
pub async fn church_source_choose_file(
    app: tauri::AppHandle,
) -> Result<Option<SourceView>, SourceError> {
    choose(app, &LIST_PANEL, "file").await
}
/// Ozzie's own panel for `kind`, then the chosen file checked and added; nothing when the person cancels.
async fn choose(
    app: tauri::AppHandle,
    words: &'static PanelWords,
    kind: &'static str,
) -> Result<Option<SourceView>, SourceError> {
    let _picking = Picking::begin()?;
    let (send, receive) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = send.send(run_panel(words));
    })
    .map_err(|_| SourceError::Unavailable)?;
    blocking(move || {
        let Some(path) = receive.recv().map_err(|_| SourceError::Unavailable)?? else {
            return Ok(None);
        };
        sources(&app)?.add_kind(&path, kind, random_id).map(Some)
    })
    .await
}

/// A list's file, read again from where it was chosen, as one binary reply (the page reads it in memory).
#[tauri::command]
pub async fn church_source_read(
    app: tauri::AppHandle,
    id: String,
) -> Result<tauri::ipc::Response, SourceError> {
    let now = || {
        use ozzie_native_auth::sunday_check::{rfc3339, unix_ms};
        rfc3339(unix_ms())
    };
    let bytes = blocking(move || sources(&app)?.read(&id, now)).await?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// What the leader set on the Lists & notes page for one list: its label, the column that names a team or role, the
/// columns shown on a Sunday card (at most 8) and the matches. Every field is made plain and checked here.
#[tauri::command]
pub async fn church_source_set(
    app: tauri::AppHandle,
    id: String,
    label: String,
    column: Option<String>,
    ticked: Vec<String>,
    matches: Vec<MatchInput>,
) -> Result<SourceView, SourceError> {
    let change = SourceChange {
        label,
        column,
        ticked,
        matches,
    };
    blocking(move || sources(&app)?.set(&id, change)).await
}

/// Removes a list from Ozzie (its file stays where it is).
#[tauri::command]
pub async fn church_source_remove(app: tauri::AppHandle, id: String) -> Result<(), SourceError> {
    blocking(move || sources(&app)?.remove(&id)).await
}

/// "Forget all lists", after the person confirms: the private links' addresses go from the Keychain too.
#[tauri::command]
pub async fn church_sources_forget_all(app: tauri::AppHandle) -> Result<(), SourceError> {
    blocking(move || sources(&app)?.forget_all(links(&app)?)).await
}

/// A link just added: its list as the page sees it (the host masked) and the sheet the add read, so the page shows it
/// without reading it a second time.
#[derive(serde::Serialize)]
pub struct LinkAdded {
    source: SourceView,
    sheet: Vec<u8>,
}

/// "Add a list from a private link": the address arrives here once and goes only to the links' store, which reads it
/// once and keeps it in the Keychain; the page gets the new list back with the host masked.
#[tauri::command]
pub async fn church_link_add(
    app: tauri::AppHandle,
    label: String,
    address: String,
) -> Result<LinkAdded, SourceError> {
    let now = || {
        use ozzie_native_auth::sunday_check::{rfc3339, unix_ms};
        rfc3339(unix_ms())
    };
    blocking(move || {
        let (source, sheet) = sources(&app)?.add_link(links(&app)?, &label, &address, now)?;
        Ok(LinkAdded { source, sheet })
    })
    .await
}

/// A link's sheet, read again (one guarded GET), as one binary reply the page reads in memory.
#[tauri::command]
pub async fn church_link_read(
    app: tauri::AppHandle,
    id: String,
) -> Result<tauri::ipc::Response, SourceError> {
    let now = || {
        use ozzie_native_auth::sunday_check::{rfc3339, unix_ms};
        rfc3339(unix_ms())
    };
    let bytes = blocking(move || sources(&app)?.read_link(links(&app)?, &id, now)).await?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// "Remove this list" for a link: its address leaves the Keychain; the sheet itself doesn't change.
#[tauri::command]
pub async fn church_link_remove(app: tauri::AppHandle, id: String) -> Result<(), SourceError> {
    blocking(move || sources(&app)?.remove_link(links(&app)?, &id)).await
}

/// "Forget all private links", after the person confirms: the way out when the links' own list can't be read.
#[tauri::command]
pub async fn church_links_forget_all(app: tauri::AppHandle) -> Result<(), SourceError> {
    blocking(move || sources(&app)?.forget_links(links(&app)?)).await
}

/// "Add notes from this Mac": Ozzie's own panel (plain text or Markdown), then the chosen file checked and added as
/// notes, read again from where it is like a list's file (`church_source_read`). Nothing when the person cancels.
#[tauri::command]
pub async fn church_notes_choose_file(
    app: tauri::AppHandle,
) -> Result<Option<SourceView>, SourceError> {
    choose(app, &NOTES_PANEL, "notes").await
}

/// What the leader set for notes: their label and the sections attached to a team or a kind of finding, checked whole.
#[tauri::command]
pub async fn church_notes_set(
    app: tauri::AppHandle,
    id: String,
    label: String,
    attachments: Vec<AttachmentInput>,
) -> Result<SourceView, SourceError> {
    blocking(move || sources(&app)?.set_notes(&id, &label, attachments)).await
}

#[cfg(test)]
#[path = "church_sources_tests.rs"]
mod tests;
