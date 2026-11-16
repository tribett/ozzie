//! The leader's own calendars on Today, read-only: Apple Calendar on this Mac through Ozzie's helper
//! (helpers/calendar.swift, `ozzie-calendar`), and private calendar links (core/native-auth calendar_link.rs).
//!
//! The helper runs like Ozzie's other helpers: beside Ozzie's program, under its own sandbox profile
//! (`CALENDAR_POLICY`: no network, no other programs) with an empty environment, its answer read over a pipe and
//! bounded in size and time. Everything it reports is checked again here and once more in the page
//! (core/src/calendar/events.ts). Nothing here asks macOS for permission except `calendar_apple_ask`, which the page
//! calls only from the person's "Let Ozzie read my calendar" click; macOS then asks once.
//!
//! Calendar text often holds people's names. It goes only to the page on this Mac, which shows it on Today and in
//! Settings; no command here writes it to disk or a log, and nothing that sends to a model or writes the copy for
//! other AI apps calls these commands (core/test/calendar/stays-on-this-mac.test.ts).
use crate::local_tools::{SANDBOX, helper, home, run_bounded, sandboxed_helper};
use ozzie_native_auth::calendar_link::{
    CalendarLinks, GuardedHttp, KEYCHAIN_SERVICE, LinkError, LinkView,
};
use ozzie_native_auth::credentials::MacKeychain;
use std::path::Path;
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tauri::Manager;

pub const CALENDAR_HELPER: &str = "ozzie-calendar";

/// Reading Apple Calendar. EventKit needs Calendar's own services and its store, so this starts from allow and takes
/// away what matters: no network (calendar text can't leave this Mac from here) and no other programs. File writes
/// stay allowed because EventKit's own framework code may keep its caches current while it reads; the helper itself
/// writes nothing (`the_helper_never_writes_and_never_reads_notes_or_people` checks its source).
pub const CALENDAR_POLICY: &str = r#"(version 1)
(allow default)
(deny network*)
(deny process-fork)
(deny process-exec)
(allow process-exec (literal (param "HELPER")))
"#;

const STATUS_LIMIT: Duration = Duration::from_secs(10);
/// macOS's question stays open until the person answers it.
const ASK_LIMIT: Duration = Duration::from_secs(300);
const READ_LIMIT: Duration = Duration::from_secs(30);
const MAX_STATUS: usize = 4096;
const MAX_CALENDARS_OUTPUT: usize = 256 * 1024;
const MAX_EVENTS_OUTPUT: usize = 2 * 1024 * 1024;
/// Same limits as the helper.
pub const MAX_CHOSEN: usize = 50;
const MAX_ID: usize = 256;
const MAX_TEXT: usize = 300;
const MAX_EVENTS: usize = 1000;
const MAX_LISTED: usize = 200;

/// What macOS has decided about calendar access, or that this copy of Ozzie can't read Apple Calendar here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AppleAccess {
    Full,
    NotDetermined,
    Denied,
    Restricted,
    WriteOnly,
    NotAvailable,
}
fn access(text: &str) -> Option<AppleAccess> {
    Some(match text {
        "full" => AppleAccess::Full,
        "not-determined" => AppleAccess::NotDetermined,
        "denied" => AppleAccess::Denied,
        "restricted" => AppleAccess::Restricted,
        "write-only" => AppleAccess::WriteOnly,
        _ => return None,
    })
}

#[derive(Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CalendarError {
    InvalidInput,
    NotAvailable,
    Failed,
    Timeout,
}

#[derive(Debug, PartialEq, Eq, serde::Serialize)]
pub struct AppleCalendar {
    pub id: String,
    pub title: String,
    pub account: Option<String>,
}
#[derive(Debug, PartialEq, Eq, serde::Serialize)]
pub struct AppleCalendars {
    pub access: AppleAccess,
    pub calendars: Vec<AppleCalendar>,
}
#[derive(Debug, PartialEq, Eq, serde::Serialize)]
pub struct AppleEvent {
    pub calendar: String,
    pub id: String,
    pub title: String,
    pub location: Option<String>,
    pub start: String,
    pub end: String,
    pub all_day: bool,
    pub status: String,
    pub free: bool,
}
#[derive(Debug, PartialEq, Eq, serde::Serialize)]
pub struct AppleEvents {
    pub access: AppleAccess,
    pub events: Vec<AppleEvent>,
    pub truncated: bool,
}

#[derive(serde::Deserialize)]
struct Raw {
    access: String,
    #[serde(default)]
    calendars: Vec<serde_json::Value>,
    #[serde(default)]
    events: Vec<serde_json::Value>,
    #[serde(default)]
    truncated: bool,
}

/// Format characters that make text read as something else: the soft hyphen, the Arabic letter mark, the Mongolian
/// vowel separator, zero-width characters and marks, direction overrides and isolates, invisible operators, the
/// byte-order mark, interlinear annotation and tag characters.
fn hidden(c: char) -> bool {
    matches!(c, '\u{ad}' | '\u{61c}' | '\u{180e}' | '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2060}'..='\u{2064}'
        | '\u{2066}'..='\u{206f}' | '\u{feff}' | '\u{fff9}'..='\u{fffb}' | '\u{e0001}' | '\u{e0020}'..='\u{e007f}')
}
/// What a zero-width joiner or non-joiner may join: letters, the marks and signs of Indic scripts, variation
/// selectors and emoji.
fn joinable(c: char) -> bool {
    c.is_alphabetic()
        || matches!(c, '\u{0300}'..='\u{036f}' | '\u{0900}'..='\u{0dff}' | '\u{fe00}'..='\u{fe0f}' | '\u{2300}'..='\u{27bf}'
            | '\u{2b00}'..='\u{2bff}' | '\u{1f000}'..='\u{1faff}')
}
/// Calendar text as kept: one plain line (format characters out, controls and line breaks as spaces, runs of spaces
/// as one), at most `MAX_TEXT` characters. The two joiners stay where they join letters or emoji (an emoji family, a
/// Persian word) and go anywhere else. The page cleans it again (core/src/calendar/ics.ts `plainText`).
fn plain(text: &str) -> String {
    let chars: Vec<char> = text.chars().take(MAX_TEXT * 8).collect();
    let joins = |i: usize| {
        i > 0
            && chars.get(i - 1).is_some_and(|c| joinable(*c))
            && chars.get(i + 1).is_some_and(|c| joinable(*c))
    };
    let cleaned: String = chars
        .iter()
        .enumerate()
        .filter(|(i, c)| !hidden(**c) || (matches!(c, '\u{200c}' | '\u{200d}') && joins(*i)))
        .map(|(_, c)| *c)
        .map(|c| {
            if c.is_control() || c == '\u{2028}' || c == '\u{2029}' {
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
        .take(MAX_TEXT)
        .collect()
}
fn id_ok(id: &str) -> bool {
    !id.is_empty() && id.len() <= MAX_ID && !id.chars().any(char::is_control)
}
fn digits(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit())
}
/// `YYYY-MM-DD`.
fn is_date(text: &str) -> bool {
    let parts: Vec<&str> = text.split('-').collect();
    text.len() == 10
        && parts.len() == 3
        && parts
            .iter()
            .zip([4, 2, 2])
            .all(|(p, n)| p.len() == n && digits(p))
}
/// `YYYY-MM-DDTHH:MM:SS` with optional milliseconds, in UTC (`Z`).
fn is_instant(text: &str) -> bool {
    let Some(body) = text.strip_suffix('Z') else {
        return false;
    };
    let (main, fraction) = body.split_once('.').unwrap_or((body, "0"));
    let Some((date, time)) = main.split_once('T') else {
        return false;
    };
    let clock: Vec<&str> = time.split(':').collect();
    is_date(date)
        && clock.len() == 3
        && clock.iter().all(|p| p.len() == 2 && digits(p))
        && fraction.len() <= 3
        && digits(fraction)
}

/// The helper's `status` or `ask` answer. Anything unreadable is "not available".
pub fn apple_status(out: &[u8]) -> AppleAccess {
    serde_json::from_slice::<Raw>(out.trim_ascii())
        .ok()
        .and_then(|raw| access(&raw.access))
        .unwrap_or(AppleAccess::NotAvailable)
}

/// The helper's `calendars` answer, checked: the list only with full access, malformed entries left out.
pub fn apple_calendars(out: &[u8]) -> Result<AppleCalendars, CalendarError> {
    let raw: Raw = serde_json::from_slice(out.trim_ascii()).map_err(|_| CalendarError::Failed)?;
    let access = access(&raw.access).ok_or(CalendarError::Failed)?;
    let calendars = if access == AppleAccess::Full {
        raw.calendars
            .iter()
            .take(MAX_LISTED)
            .filter_map(|c| {
                let id = c.get("id")?.as_str().filter(|id| id_ok(id))?;
                let title = c.get("title")?.as_str()?;
                Some(AppleCalendar {
                    id: id.to_owned(),
                    title: plain(title),
                    account: c.get("account").and_then(|a| a.as_str()).map(plain),
                })
            })
            .collect()
    } else {
        Vec::new()
    };
    Ok(AppleCalendars { access, calendars })
}

/// The helper's `events` answer, checked: events only with full access, each with ids, a known status, and times in
/// the form its kind needs (instants for timed events, dates for all-day ones); anything else is left out.
pub fn apple_events(out: &[u8]) -> Result<AppleEvents, CalendarError> {
    let raw: Raw = serde_json::from_slice(out.trim_ascii()).map_err(|_| CalendarError::Failed)?;
    let access = access(&raw.access).ok_or(CalendarError::Failed)?;
    if access != AppleAccess::Full {
        return Ok(AppleEvents {
            access,
            events: Vec::new(),
            truncated: false,
        });
    }
    let events = raw
        .events
        .iter()
        .take(MAX_EVENTS)
        .filter_map(|e| {
            let text = |key: &str| e.get(key).and_then(|v| v.as_str());
            let calendar = text("calendar").filter(|v| id_ok(v))?;
            let id = text("id").filter(|v| id_ok(v))?;
            let all_day = e.get("all_day")?.as_bool()?;
            let (start, end) = (text("start")?, text("end")?);
            let form = if all_day { is_date } else { is_instant };
            if !form(start) || !form(end) {
                return None;
            }
            let status =
                text("status").filter(|s| matches!(*s, "confirmed" | "tentative" | "cancelled"))?;
            Some(AppleEvent {
                calendar: calendar.to_owned(),
                id: id.to_owned(),
                title: plain(text("title")?),
                location: text("location").map(plain),
                start: start.to_owned(),
                end: end.to_owned(),
                all_day,
                status: status.to_owned(),
                free: e.get("free").and_then(|v| v.as_bool()).unwrap_or(false),
            })
        })
        .collect();
    Ok(AppleEvents {
        access,
        events,
        truncated: raw.truncated || raw.events.len() > MAX_EVENTS,
    })
}

/// What the helper reads from stdin for `events`: the chosen calendars and the days, checked first.
pub fn events_request(
    calendars: &[String],
    from: &str,
    to: &str,
) -> Result<Vec<u8>, CalendarError> {
    if calendars.len() > MAX_CHOSEN
        || !calendars.iter().all(|c| id_ok(c))
        || !is_instant(from)
        || !is_instant(to)
        || from >= to
    {
        return Err(CalendarError::InvalidInput);
    }
    serde_json::to_vec(&serde_json::json!({ "from": from, "to": to, "calendars": calendars }))
        .map_err(|_| CalendarError::Failed)
}

fn helper_command(helper: &Path, mode: &str) -> std::process::Command {
    sandboxed_helper(
        CALENDAR_POLICY,
        "en_US.UTF-8",
        &[("HELPER", helper)],
        helper,
        &[mode],
        home().as_deref(),
    )
}
fn run(mode: &str, input: Vec<u8>, limit: Duration, max: usize) -> Result<Vec<u8>, CalendarError> {
    let helper = helper(CALENDAR_HELPER)
        .filter(|_| Path::new(SANDBOX).is_file())
        .ok_or(CalendarError::NotAvailable)?;
    let never = || false;
    run_bounded(helper_command(&helper, mode), input, limit, max, &never).map_err(|e| match e {
        crate::local_tools::LocalToolError::Timeout => CalendarError::Timeout,
        crate::local_tools::LocalToolError::Unavailable => CalendarError::NotAvailable,
        _ => CalendarError::Failed,
    })
}
/// Runs `work` off the async runtime (the helper and the link reads block); None if it couldn't finish.
async fn blocking<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    tauri::async_runtime::spawn_blocking(work).await.ok()
}

/// What macOS has decided about calendar access. Never asks the person anything.
#[tauri::command]
pub async fn calendar_apple_status() -> AppleAccess {
    blocking(|| run("status", Vec::new(), STATUS_LIMIT, MAX_STATUS).map(|out| apple_status(&out)))
        .await
        .and_then(Result::ok)
        .unwrap_or(AppleAccess::NotAvailable)
}

/// "Let Ozzie read my calendar": macOS asks once if it never has; a "no" is respected.
#[tauri::command]
pub async fn calendar_apple_ask() -> AppleAccess {
    let asked =
        blocking(|| run("ask", Vec::new(), ASK_LIMIT, MAX_STATUS).map(|out| apple_status(&out)))
            .await
            .and_then(Result::ok);
    match asked {
        Some(access) => access,
        // macOS's question was left unanswered until the wait ran out (or the ask failed): report what macOS has
        // decided so far, which never asks, so the person can be asked again from their next click.
        None => calendar_apple_status().await,
    }
}

/// The calendars on this Mac, for the person to choose from.
#[tauri::command]
pub async fn calendar_apple_calendars() -> Result<AppleCalendars, CalendarError> {
    blocking(|| {
        run("calendars", Vec::new(), READ_LIMIT, MAX_CALENDARS_OUTPUT)
            .and_then(|out| apple_calendars(&out))
    })
    .await
    .unwrap_or(Err(CalendarError::Failed))
}

/// The chosen calendars' events between two instants (at most 15 days; the helper refuses more).
#[tauri::command]
pub async fn calendar_apple_events(
    app: tauri::AppHandle,
    from: String,
    to: String,
) -> Result<AppleEvents, CalendarError> {
    // Only the calendars the person chose, as kept here: the page can't ask for any others (review C, L8).
    let chosen = read_choice(&choice_path(&app)?);
    let input = events_request(&chosen, &from, &to)?;
    blocking(move || {
        run("events", input, READ_LIMIT, MAX_EVENTS_OUTPUT).and_then(|out| apple_events(&out))
    })
    .await
    .unwrap_or(Err(CalendarError::Failed))
}

/// Where the chosen Apple calendars are kept: their ids only, in the app's data folder.
fn choice_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, CalendarError> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join(CHOICE_FILE))
        .map_err(|_| CalendarError::Failed)
}
const CHOICE_FILE: &str = "calendar-choice.json";
#[derive(serde::Serialize, serde::Deserialize)]
struct Choice {
    version: u32,
    ids: Vec<String>,
}
/// The chosen calendar ids, or none when there's no choice or it can't be read (nothing is read then).
pub fn read_choice(path: &Path) -> Vec<String> {
    use std::io::Read;
    let mut bytes = Vec::new();
    let Ok(file) = std::fs::File::open(path) else {
        return Vec::new();
    };
    if file.take(64 * 1024 + 1).read_to_end(&mut bytes).is_err() || bytes.len() > 64 * 1024 {
        return Vec::new();
    }
    match serde_json::from_slice::<Choice>(&bytes) {
        Ok(choice)
            if choice.version == 1
                && choice.ids.len() <= MAX_CHOSEN
                && choice.ids.iter().all(|id| id_ok(id)) =>
        {
            let mut ids = choice.ids;
            ids.dedup();
            ids
        }
        _ => Vec::new(),
    }
}
/// Keeps the choice (replaced whole, readable by this user only). More than `MAX_CHOSEN`, or an id that isn't one, is
/// refused and the earlier choice stays.
pub fn save_choice(path: &Path, ids: &[String]) -> Result<Vec<String>, CalendarError> {
    use std::io::Write;
    let mut kept: Vec<String> = Vec::new();
    for id in ids {
        if !id_ok(id) {
            return Err(CalendarError::InvalidInput);
        }
        if !kept.contains(id) {
            kept.push(id.clone());
        }
    }
    if kept.len() > MAX_CHOSEN {
        return Err(CalendarError::InvalidInput);
    }
    let write = || -> std::io::Result<()> {
        let dir = path
            .parent()
            .ok_or_else(|| std::io::Error::other("no folder"))?;
        let mut builder = std::fs::DirBuilder::new();
        builder.recursive(true);
        std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
        builder.create(dir)?;
        let text = serde_json::to_vec(&Choice {
            version: 1,
            ids: kept.clone(),
        })
        .map_err(std::io::Error::other)?;
        let partial = path.with_extension("partial");
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
        if let Err(error) = written.and_then(|()| std::fs::rename(&partial, path)) {
            let _ = std::fs::remove_file(&partial);
            return Err(error);
        }
        Ok(())
    };
    write().map_err(|_| CalendarError::Failed)?;
    Ok(kept)
}

/// The Apple calendars the person chose. None until they choose.
#[tauri::command]
pub fn calendar_apple_chosen(app: tauri::AppHandle) -> Vec<String> {
    choice_path(&app)
        .map(|path| read_choice(&path))
        .unwrap_or_default()
}

/// The person's choice of Apple calendars, from Settings › Calendars. An empty choice reads nothing.
#[tauri::command]
pub fn calendar_apple_choose(
    app: tauri::AppHandle,
    ids: Vec<String>,
) -> Result<Vec<String>, CalendarError> {
    save_choice(&choice_path(&app)?, &ids)
}

/// The private links, kept for the life of the app: addresses in the Keychain, the list in the app's data folder.
fn links(app: &tauri::AppHandle) -> Result<&'static CalendarLinks, LinkError> {
    static LINKS: OnceLock<CalendarLinks> = OnceLock::new();
    if let Some(links) = LINKS.get() {
        return Ok(links);
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| LinkError::Unavailable)?;
    let fetch = GuardedHttp::new()?;
    Ok(LINKS.get_or_init(|| {
        CalendarLinks::new(
            Arc::new(MacKeychain {
                service: KEYCHAIN_SERVICE.into(),
            }),
            dir.join("calendar-links.json"),
            Arc::new(fetch),
        )
    }))
}

/// A link just added, and the calendar text it read, so Today can show it at once.
#[derive(serde::Serialize)]
pub struct AddedLink {
    link: LinkView,
    text: String,
}

#[tauri::command]
pub async fn calendar_links(app: tauri::AppHandle) -> Result<Vec<LinkView>, LinkError> {
    blocking(move || links(&app)?.list())
        .await
        .unwrap_or(Err(LinkError::Unavailable))
}

/// Adds a private link. The address arrives here once and goes only to the Keychain; the page gets it back masked.
#[tauri::command]
pub async fn calendar_link_add(
    app: tauri::AppHandle,
    label: String,
    address: String,
) -> Result<AddedLink, LinkError> {
    blocking(move || {
        let (link, text) = links(&app)?.add(&label, &address)?;
        Ok(AddedLink { link, text })
    })
    .await
    .unwrap_or(Err(LinkError::Unavailable))
}

/// "Stop reading this calendar": the address leaves the Keychain; the calendar itself doesn't change.
#[tauri::command]
pub async fn calendar_link_remove(app: tauri::AppHandle, id: String) -> Result<(), LinkError> {
    blocking(move || links(&app)?.remove(&id))
        .await
        .unwrap_or(Err(LinkError::Unavailable))
}

/// "Forget all private calendar links", after the person confirms: every saved address and the list go, and Ozzie
/// starts with none. Offered when the list can't be read (review C2, N1).
#[tauri::command]
pub async fn calendar_links_forget_all(app: tauri::AppHandle) -> Result<(), LinkError> {
    blocking(move || links(&app)?.forget_all())
        .await
        .unwrap_or(Err(LinkError::Unavailable))
}

/// Reads one link's calendar text (one guarded GET).
#[tauri::command]
pub async fn calendar_link_read(app: tauri::AppHandle, id: String) -> Result<String, LinkError> {
    blocking(move || links(&app)?.read(&id))
        .await
        .unwrap_or(Err(LinkError::Unavailable))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SOURCE: &str = include_str!("../helpers/calendar.swift");

    /// The helper's code with its comments taken out, so words in its explanation don't count.
    fn code() -> String {
        SOURCE
            .lines()
            .map(|line| line.split("//").next().unwrap_or_default())
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn the_helper_never_writes_and_never_reads_notes_or_people() {
        let code = code();
        // No EventKit call that creates, changes or deletes anything, no reminders, no write-only access.
        for call in [
            "save",
            "remove",
            "commit",
            "reset",
            "refreshSourcesIfNecessary",
            "Reminder",
            "requestWriteOnlyAccess",
            "requestAccess(",
            "notes",
            "attendees",
            "organizer",
            "alarm",
            "URLSession",
            "NSURL",
            "FileManager",
            "createFile",
            "write(to",
            "NSLog",
            "print(",
            "os_log",
            "Logger",
        ] {
            assert!(
                !code.contains(call),
                "the calendar helper contains `{call}`"
            );
        }
        // It asks for full access only from `ask`, and never reads every calendar by passing none.
        assert_eq!(code.matches("requestFullAccessToEvents").count(), 1);
        assert!(code.contains("calendars: chosen)") && !code.contains("calendars: nil"));
        assert!(code.contains("guard !chosen.isEmpty"));
    }

    /// Review C, L6: calendar and account names, titles and places are one plain line, natively too.
    #[test]
    fn calendar_text_is_made_plain_here_too() {
        assert_eq!(
            plain("Board\u{202e}gnitee\u{202c} \n meeting\u{200b}\u{7}"),
            "Boardgnitee meeting"
        );
        assert_eq!(
            plain("A\u{e0041}\u{e0042}B\u{180e}C\u{ad}D\u{2066}E\u{2069}\u{feff}"),
            "ABCDE"
        );
        assert_eq!(plain(&"x".repeat(MAX_TEXT * 3)).chars().count(), MAX_TEXT);
        let list = apple_calendars(
            "{\"access\":\"full\",\"calendars\":[{\"id\":\"A1\",\"title\":\"Church\\u202e staff\",\"account\":\"\\u2066pastor@fictional.example\\u2069\"}]}".as_bytes(),
        )
        .unwrap();
        assert_eq!(list.calendars[0].title, "Church staff");
        assert_eq!(
            list.calendars[0].account.as_deref(),
            Some("pastor@fictional.example")
        );
    }

    /// Review C2: the joiners stay inside an emoji family, an emoji with its variation, a Persian word and a Hindi
    /// conjunct; anywhere else they go, with every other format character.
    #[test]
    fn joiners_stay_where_they_join() {
        let family = "\u{1f468}\u{200d}\u{1f469}\u{200d}\u{1f467}";
        let heart = "\u{2764}\u{fe0f}\u{200d}\u{1f525}";
        let persian = "\u{645}\u{6cc}\u{200c}\u{62e}\u{648}\u{627}\u{647}\u{645}";
        let hindi = "\u{915}\u{94d}\u{200d}\u{937}";
        let text = format!("{family} picnic {heart} {persian} {hindi}\u{200d} \u{200c}x\u{202e}");
        assert_eq!(
            plain(&text),
            format!("{family} picnic {heart} {persian} {hindi} x")
        );
    }

    /// Review C, L8: which Apple calendars are read is kept here, not only in the page.
    #[test]
    fn the_chosen_calendars_are_kept_natively_and_checked() {
        let dir =
            std::env::temp_dir().join(format!("ozzie-calendar-choice-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join(CHOICE_FILE);
        assert_eq!(read_choice(&path), Vec::<String>::new());
        assert_eq!(
            save_choice(&path, &["A1".into(), "B2".into(), "A1".into()]),
            Ok(vec!["A1".to_owned(), "B2".to_owned()])
        );
        assert_eq!(read_choice(&path), vec!["A1".to_owned(), "B2".to_owned()]);
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let many: Vec<String> = (0..=MAX_CHOSEN).map(|i| format!("C{i}")).collect();
        assert_eq!(save_choice(&path, &many), Err(CalendarError::InvalidInput));
        assert_eq!(
            save_choice(&path, &["A\n1".into()]),
            Err(CalendarError::InvalidInput)
        );
        assert_eq!(read_choice(&path), vec!["A1".to_owned(), "B2".to_owned()]);
        for damaged in [
            "not json",
            "{\"version\":2,\"ids\":[\"A1\"]}",
            "{\"version\":1,\"ids\":[\"\"]}",
        ] {
            std::fs::write(&path, damaged).unwrap();
            assert_eq!(read_choice(&path), Vec::<String>::new(), "{damaged}");
        }
        assert_eq!(save_choice(&path, &[]), Ok(vec![]));
        assert_eq!(read_choice(&path), Vec::<String>::new());
        // The events command reads what is kept here; the page passes only the days.
        let source = include_str!("calendars.rs");
        let command = source
            .split("pub async fn calendar_apple_events(")
            .nth(1)
            .unwrap()
            .split("\n}\n")
            .next()
            .unwrap();
        assert!(command.contains("read_choice(") && !command.contains("calendars: Vec<String>"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reading_apple_calendar_has_no_network_and_no_other_programs() {
        let rules: Vec<&str> = CALENDAR_POLICY.lines().map(str::trim).collect();
        assert_eq!(
            rules,
            vec![
                "(version 1)",
                "(allow default)",
                "(deny network*)",
                "(deny process-fork)",
                "(deny process-exec)",
                "(allow process-exec (literal (param \"HELPER\")))",
            ]
        );
    }

    #[test]
    fn access_answers_are_read_and_anything_else_is_not_available() {
        for (answer, expected) in [
            ("full", AppleAccess::Full),
            ("not-determined", AppleAccess::NotDetermined),
            ("denied", AppleAccess::Denied),
            ("restricted", AppleAccess::Restricted),
            ("write-only", AppleAccess::WriteOnly),
            ("authorized", AppleAccess::NotAvailable),
        ] {
            assert_eq!(
                apple_status(format!("{{\"access\":\"{answer}\"}}\n").as_bytes()),
                expected
            );
        }
        assert_eq!(apple_status(b"not json"), AppleAccess::NotAvailable);
        assert_eq!(apple_status(b""), AppleAccess::NotAvailable);
    }

    #[test]
    fn the_calendar_list_is_only_kept_with_full_access_and_bounded() {
        let long = "x".repeat(MAX_TEXT + 50);
        let out = format!(
            r#"{{"access":"full","calendars":[{{"id":"A1","title":"Church","account":"iCloud"}},{{"id":"","title":"No id"}},{{"id":"B2","title":"{long}"}},{{"title":"Missing id"}}]}}"#
        );
        let list = apple_calendars(out.as_bytes()).unwrap();
        assert_eq!(list.access, AppleAccess::Full);
        assert_eq!(list.calendars.len(), 2);
        assert_eq!(
            list.calendars[0],
            AppleCalendar {
                id: "A1".into(),
                title: "Church".into(),
                account: Some("iCloud".into())
            }
        );
        assert_eq!(list.calendars[1].title.chars().count(), MAX_TEXT);
        let denied =
            apple_calendars(br#"{"access":"denied","calendars":[{"id":"A1","title":"x"}]}"#)
                .unwrap();
        assert_eq!(
            denied,
            AppleCalendars {
                access: AppleAccess::Denied,
                calendars: vec![]
            }
        );
        assert_eq!(apple_calendars(b"<html>"), Err(CalendarError::Failed));
        assert_eq!(
            apple_calendars(br#"{"access":"sure"}"#),
            Err(CalendarError::Failed)
        );
    }

    #[test]
    fn events_are_checked_and_malformed_ones_left_out() {
        let out = br#"{"access":"full","truncated":false,"events":[
            {"calendar":"A1","id":"E1","title":"Staff meeting","location":"Office","start":"2026-11-17T15:00:00Z","end":"2026-11-17T16:00:00Z","all_day":false,"status":"confirmed","free":false},
            {"calendar":"A1","id":"E2","title":"Thanksgiving","start":"2026-11-26","end":"2026-11-27","all_day":true,"status":"confirmed","free":true},
            {"calendar":"A1","id":"E3","title":"Date where an instant belongs","start":"2026-11-17","end":"2026-11-17","all_day":false,"status":"confirmed"},
            {"calendar":"A1","id":"E4","title":"Odd status","start":"2026-11-17T15:00:00Z","end":"2026-11-17T16:00:00Z","all_day":false,"status":"maybe"},
            {"calendar":"","id":"E5","title":"No calendar","start":"2026-11-17T15:00:00Z","end":"2026-11-17T16:00:00Z","all_day":false,"status":"confirmed"},
            {"calendar":"A1","id":"E6","title":"Local time","start":"2026-11-17T15:00:00+01:00","end":"2026-11-17T16:00:00Z","all_day":false,"status":"confirmed"}
        ]}"#;
        let read = apple_events(out).unwrap();
        assert_eq!(
            read.events
                .iter()
                .map(|e| e.id.as_str())
                .collect::<Vec<_>>(),
            vec!["E1", "E2"]
        );
        assert_eq!(read.events[0].location.as_deref(), Some("Office"));
        assert!(read.events[1].all_day && read.events[1].free);
        let none =
            apple_events(br#"{"access":"not-determined","events":[{"calendar":"A1"}]}"#).unwrap();
        assert_eq!(
            none,
            AppleEvents {
                access: AppleAccess::NotDetermined,
                events: vec![],
                truncated: false
            }
        );
    }

    #[test]
    fn the_events_request_is_checked_before_the_helper_runs() {
        let ok = events_request(
            &["A1".into()],
            "2026-11-16T05:00:00Z",
            "2026-11-24T05:00:00.000Z",
        )
        .unwrap();
        let sent: serde_json::Value = serde_json::from_slice(&ok).unwrap();
        assert_eq!(
            sent,
            serde_json::json!({ "from": "2026-11-16T05:00:00Z", "to": "2026-11-24T05:00:00.000Z", "calendars": ["A1"] })
        );
        let many: Vec<String> = (0..=MAX_CHOSEN).map(|i| format!("C{i}")).collect();
        for (calendars, from, to) in [
            (many, "2026-11-16T05:00:00Z", "2026-11-24T05:00:00Z"),
            (
                vec!["A\n1".into()],
                "2026-11-16T05:00:00Z",
                "2026-11-24T05:00:00Z",
            ),
            (vec!["A1".into()], "2026-11-16", "2026-11-24T05:00:00Z"),
            (
                vec!["A1".into()],
                "2026-11-24T05:00:00Z",
                "2026-11-16T05:00:00Z",
            ),
            (
                vec!["A1".into()],
                "2026-11-16T05:00:00+00:00",
                "2026-11-24T05:00:00Z",
            ),
        ] {
            assert_eq!(
                events_request(&calendars, from, to),
                Err(CalendarError::InvalidInput)
            );
        }
    }

    /// The helper build.rs made for this target, run under CALENDAR_POLICY as Ozzie runs it: `status` and an events
    /// read report what macOS has decided without asking anything (this test never runs `ask`). It opens this Mac's
    /// real calendar store when access was given, so it runs only when asked:
    /// `cargo test -- --ignored the_helper_answers_under_its_sandbox_without_asking` (review C, L9).
    #[test]
    #[ignore]
    fn the_helper_answers_under_its_sandbox_without_asking() {
        let triple = if cfg!(target_arch = "aarch64") {
            "aarch64-apple-darwin"
        } else {
            "x86_64-apple-darwin"
        };
        let built = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join(format!("binaries/{CALENDAR_HELPER}-{triple}"));
        let Ok(built) = built.canonicalize() else {
            eprintln!("skipped: {CALENDAR_HELPER} isn't built for {triple}");
            return;
        };
        let never = || false;
        let status = run_bounded(
            helper_command(&built, "status"),
            Vec::new(),
            STATUS_LIMIT,
            MAX_STATUS,
            &never,
        )
        .unwrap();
        assert_ne!(
            apple_status(&status),
            AppleAccess::NotAvailable,
            "{}",
            String::from_utf8_lossy(&status)
        );
        let input = events_request(
            &["A1".into()],
            "2026-11-16T05:00:00Z",
            "2026-11-24T05:00:00Z",
        )
        .unwrap();
        let events = run_bounded(
            helper_command(&built, "events"),
            input,
            READ_LIMIT,
            MAX_EVENTS_OUTPUT,
            &never,
        )
        .unwrap();
        assert!(apple_events(&events).is_ok());
        // More than 15 days is refused by the helper itself.
        let wide = events_request(
            &["A1".into()],
            "2026-11-16T05:00:00Z",
            "2026-12-24T05:00:00Z",
        )
        .unwrap();
        assert!(
            run_bounded(
                helper_command(&built, "events"),
                wide,
                READ_LIMIT,
                MAX_EVENTS_OUTPUT,
                &never
            )
            .is_err()
        );
    }
}
