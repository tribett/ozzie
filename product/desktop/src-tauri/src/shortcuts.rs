//! "Let Siri and Shortcuts ask Ozzie" (Settings, off by default; ADR 0006). The commands that turn
//! it on and off and keep the copy Ozzie's Siri actions and bundled helper answer from
//! (helpers/siri-actions.swift, ADR 0007; ozzie-shortcuts, helpers/shortcuts.swift; the copy is
//! core/native-auth shortcuts_check.rs), where that helper is, whether this Ozzie carries its Siri
//! actions, and Ozzie's pages opened from a shortcut or a Siri action by an `ozzie://` link.
//!
//! A link comes from outside Ozzie, so only its page is used: the link's text must be exactly
//! `ozzie://today` or `ozzie://sunday`, with or without one closing slash, and only while the
//! switch is on. Anything else is ignored whole, and nothing from a link is ever shown, asked or
//! sent. The page is kept here until the window takes it, so a link that starts Ozzie still opens
//! its page.
//!
//! macOS hands a link over only after tao has parsed it (`Url::parse` of NSURL's text), which
//! lowercases the scheme and drops an empty user part, an empty port, dot segments and white space
//! around it. Those spellings arrive as the plain link and can't be told from it here; the exact
//! text check is applied to what arrives (pinned by a test).
use crate::SessionNames;
use ozzie_native_auth::shared_check::ShareError;
use ozzie_native_auth::{shortcuts_check, sunday_check};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Emitter, Manager};

pub const SHORTCUTS_HELPER: &str = "ozzie-shortcuts";

/// Every link accepted, exactly as written, and the page it opens (App.tsx `Page`). The tests pin
/// the scheme to Info.plist's CFBundleURLSchemes and the pages to App.tsx and siri-shortcuts.ts.
const LINKS: [(&str, &str); 4] = [
    ("ozzie://today", "today"),
    ("ozzie://today/", "today"),
    ("ozzie://sunday", "sunday"),
    ("ozzie://sunday/", "sunday"),
];

/// The page a link's text names, when the text is exactly one of LINKS; None for anything else.
pub fn page_from_link(link: &str) -> Option<&'static str> {
    LINKS
        .iter()
        .find(|(exact, _)| *exact == link)
        .map(|(_, page)| *page)
}

/// "Go back to Ozzie" on the browser's page after a sign-in or Ozzie's AI's connect (onboarding spec S4). Accepted
/// whether or not Siri and Shortcuts is on; it only brings the window forward, names no page and carries nothing.
pub fn is_connected_link(link: &str) -> bool {
    matches!(link, "ozzie://connected" | "ozzie://connected/")
}

/// The page a link names, by the link's text as it arrives (`page_from_link`).
pub fn page_from_url(url: &tauri::Url) -> Option<&'static str> {
    page_from_link(url.as_str())
}

/// The page the last accepted link named, until the window takes it.
#[derive(Default)]
pub struct OpenedPage(Mutex<Option<&'static str>>);

/// A link opened Ozzie (macOS hands it over as an Apple event): while the switch is on, the page it
/// names is kept, the window brought forward and told to take it. Otherwise nothing happens.
pub fn on_run_event(app: &tauri::AppHandle, event: &tauri::RunEvent) {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    if let tauri::RunEvent::Opened { urls } = event {
        if urls.iter().any(|url| is_connected_link(url.as_str())) {
            crate::always_on::show_main(app);
        }
        let Some(page) = urls.iter().rev().find_map(page_from_url) else {
            return;
        };
        if !app
            .path()
            .app_data_dir()
            .is_ok_and(|dir| shortcuts_check::is_on(&dir))
        {
            return;
        }
        *app.state::<OpenedPage>()
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(page);
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
        let _ = app.emit("ozzie:open-page", ());
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    let _ = (app, event);
}

/// The page a link asked for, once; None when there is none.
#[tauri::command]
pub fn take_opened_page(opened: tauri::State<'_, OpenedPage>) -> Option<String> {
    opened
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take()
        .map(str::to_owned)
}

/// Runs one file operation on the copy in the app data folder, off the main thread.
async fn in_app_data<T: Send + 'static>(
    app: tauri::AppHandle,
    work: impl FnOnce(&Path) -> Result<T, ShareError> + Send + 'static,
) -> Result<T, ShareError> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|_| ShareError::Unavailable)?;
        work(&dir)
    })
    .await
    .map_err(|_| ShareError::Unavailable)?
}

/// Whether the leader has the switch on, as kept natively.
#[tauri::command]
pub async fn shortcuts_status(app: tauri::AppHandle) -> Result<bool, ShareError> {
    in_app_data(app, |dir| Ok(shortcuts_check::is_on(dir))).await
}
/// Turning it on. Nothing is written until the webview saves the check on screen.
#[tauri::command]
pub async fn start_shortcuts(app: tauri::AppHandle) -> Result<(), ShareError> {
    in_app_data(app, shortcuts_check::start).await
}
/// Turning it off: the marker, then the copy. `unavailable` when something couldn't be removed;
/// the next start of the app tries again, and the helper answers "turned off" without the marker.
#[tauri::command]
pub async fn stop_shortcuts(app: tauri::AppHandle) -> Result<(), ShareError> {
    in_app_data(app, shortcuts_check::stop).await
}
/// Nothing current to answer from: removes the copy; the switch stays on.
#[tauri::command]
pub async fn clear_shortcuts_check(app: tauri::AppHandle) -> Result<(), ShareError> {
    in_app_data(app, shortcuts_check::clear).await
}
/// Saves the Sunday overview from the webview (core/mcp/shortcuts.ts `shortcutsEnvelopes`) as the
/// copy, checked against every name this session has shown. `off` while the switch is off;
/// `invalid` leaves the last copy as it was. Never reads Planning Center.
#[tauri::command]
pub async fn save_shortcuts_check(
    names: tauri::State<'_, SessionNames>,
    app: tauri::AppHandle,
    envelopes: Vec<String>,
    copy_id: String,
) -> Result<(), ShareError> {
    let names = names.inner().snapshot();
    in_app_data(app, move |dir| {
        shortcuts_check::save(dir, &envelopes, &names, &copy_id, sunday_check::unix_ms())
    })
    .await
}

/// The helper beside `program`, as a real path (links resolved), when it is a file.
fn helper_beside(program: &Path) -> Option<PathBuf> {
    let path = program
        .parent()?
        .join(SHORTCUTS_HELPER)
        .canonicalize()
        .ok()?;
    path.is_file().then_some(path)
}
/// The real path of the helper bundled with this copy of Ozzie, for the setup steps in Settings,
/// or None when this build has none. Nothing is run here.
#[tauri::command]
pub fn shortcuts_helper_path() -> Option<String> {
    let program = std::env::current_exe().ok()?.canonicalize().ok()?;
    helper_beside(&program)?.into_os_string().into_string().ok()
}

/// Ozzie's Siri actions (ADR 0007, helpers/siri-actions.swift): the App Intents extension build.rs
/// builds and tauri.conf.json bundles at Contents/Extensions.
pub const SIRI_ACTIONS: &str = "OzzieIntents.appex";

/// Whether the app whose program is `program` (Contents/MacOS/…) carries the Siri actions.
fn siri_actions_beside(program: &Path) -> bool {
    program
        .parent()
        .and_then(Path::parent)
        .map(|contents| {
            contents
                .join("Extensions")
                .join(SIRI_ACTIONS)
                .join("Contents/MacOS/OzzieIntents")
        })
        .is_some_and(|binary| binary.is_file())
}
/// Whether this copy of Ozzie carries its Siri actions, so Settings offers them first. A
/// development build run outside Ozzie.app has none. Nothing is run here.
#[tauri::command]
pub fn siri_actions_bundled() -> bool {
    std::env::current_exe()
        .and_then(|p| p.canonicalize())
        .is_ok_and(|program| siri_actions_beside(&program))
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_way_back_from_the_browser_is_always_accepted_names_no_page_and_carries_nothing() {
        use super::{is_connected_link, page_from_link};
        assert!(is_connected_link("ozzie://connected"));
        assert!(is_connected_link("ozzie://connected/"));
        // It opens no page, so nothing it carries could choose one.
        assert_eq!(page_from_link("ozzie://connected"), None);
        for other in [
            "ozzie://connected?church=1001",
            "ozzie://connected#today",
            "ozzie://connected/sunday",
            "ozzie://user@connected",
            "ozzie://Connected",
            "ozzie://connected:8080",
            "https://connected",
            "ozzie://today",
        ] {
            assert!(!is_connected_link(other), "{other}");
        }
        // Accepted before the Siri and Shortcuts switch is looked at.
        let source = include_str!("shortcuts.rs");
        let accepted = source
            .find("if urls.iter().any(|url| is_connected_link(url.as_str()))")
            .unwrap();
        let switch = source.find("shortcuts_check::is_on(&dir)").unwrap();
        assert!(accepted < switch);
        // The browser page links here.
        assert_eq!(
            ozzie_native_auth::callback::BACK_TO_OZZIE,
            "ozzie://connected"
        );
    }

    use super::*;

    /// Info.plist CFBundleURLSchemes.
    const URL_SCHEME: &str = "ozzie";
    /// The pages a link can open, by the one word after `ozzie://`.
    const PAGES: [&str; 2] = ["today", "sunday"];

    fn page(text: &str) -> Option<&'static str> {
        page_from_url(&tauri::Url::parse(text).ok()?)
    }

    /// Spellings refused by their exact text (review K L4).
    const REFUSED: [&str; 34] = [
        "ozzie://settings",
        "ozzie://connection",
        "ozzie://Sunday",
        "OZZIE://sunday",
        "Ozzie://today",
        "ozzie://sunday/extra",
        "ozzie://sunday//",
        "ozzie://sunday?",
        "ozzie://sunday?ask=who%20is%20free",
        "ozzie://sunday#",
        "ozzie://sunday#today",
        "ozzie://@sunday",
        "ozzie://:@sunday",
        "ozzie://user@sunday",
        "ozzie://user:secret@sunday",
        "ozzie://sunday:",
        "ozzie://sunday:8080",
        "ozzie://sunday/.",
        "ozzie://sunday/..",
        "ozzie://sunday/%2e",
        "ozzie://sun%64ay",
        "ozzie://sunday%20",
        " ozzie://sunday",
        "ozzie://sunday ",
        "ozzie://sunday\n",
        "\tozzie://sunday",
        "ozzie:sunday",
        "ozzie:///sunday",
        "ozzie://",
        "ozzie://sundays",
        "ozzie://xn--sunday",
        "https://sunday",
        "file:///sunday",
        "ozzies://sunday",
    ];

    #[test]
    fn a_link_is_one_of_the_exact_spellings_and_nothing_else() {
        assert_eq!(page_from_link("ozzie://sunday"), Some("sunday"));
        assert_eq!(page_from_link("ozzie://sunday/"), Some("sunday"));
        assert_eq!(page_from_link("ozzie://today"), Some("today"));
        assert_eq!(page_from_link("ozzie://today/"), Some("today"));
        for refused in REFUSED {
            assert_eq!(page_from_link(refused), None, "{refused:?}");
        }
        // Every page a link opens is one of PAGES, and every page has both spellings.
        for (link, page) in LINKS {
            assert!(
                PAGES.contains(&page)
                    && (link == format!("{URL_SCHEME}://{page}")
                        || link == format!("{URL_SCHEME}://{page}/")),
                "{link}"
            );
        }
        assert_eq!(LINKS.len(), 2 * PAGES.len());
    }

    #[test]
    fn a_link_that_arrives_parsed_is_held_to_its_exact_text() {
        assert_eq!(page("ozzie://sunday"), Some("sunday"));
        assert_eq!(page("ozzie://today/"), Some("today"));
        // What parsing keeps as written is refused by its text.
        for refused in [
            "ozzie://settings",
            "ozzie://Sunday",
            "ozzie://sunday/extra",
            "ozzie://sunday//",
            "ozzie://sunday?",
            "ozzie://sunday#",
            "ozzie://user@sunday",
            "ozzie://sunday:8080",
            "ozzie://sun%64ay",
            "ozzie:sunday",
            "ozzie:///sunday",
            "https://sunday",
        ] {
            assert_eq!(page(refused), None, "{refused:?}");
        }
        // The limit, pinned: macOS hands a link to Ozzie only after tao has parsed it (url crate),
        // which lowercases the scheme and drops an empty user part, an empty port, dot segments
        // and surrounding white space. These spellings arrive as the plain link, and nothing of
        // what was dropped exists by then; the exact text check above is all that can be applied.
        for normalized in [
            "OZZIE://sunday",
            "ozzie://@sunday",
            "ozzie://:@sunday",
            "ozzie://sunday:",
            " ozzie://sunday",
            "ozzie://sunday\n",
        ] {
            assert_eq!(
                tauri::Url::parse(normalized).unwrap().as_str(),
                "ozzie://sunday",
                "{normalized:?}"
            );
        }
        for normalized in [
            "ozzie://sunday/.",
            "ozzie://sunday/..",
            "ozzie://sunday/%2e",
        ] {
            assert_eq!(
                tauri::Url::parse(normalized).unwrap().as_str(),
                "ozzie://sunday/",
                "{normalized:?}"
            );
        }
    }

    #[test]
    fn the_scheme_and_pages_match_the_app() {
        let plist = include_str!("../Info.plist");
        assert!(plist.contains(&format!("<string>{URL_SCHEME}</string>")));
        let app = include_str!("../../src/App.tsx");
        let pages = app
            .split("type Page = ")
            .nth(1)
            .and_then(|rest| rest.split(';').next())
            .unwrap();
        for page in PAGES {
            assert!(pages.contains(&format!("\"{page}\"")), "{page}");
        }
        let words = include_str!("../../src/siri-shortcuts.ts");
        assert!(words.contains(&format!(
            "OPENABLE_PAGES = Object.freeze([{}] as const)",
            PAGES.map(|p| format!("\"{p}\"")).join(", ")
        )));
    }

    #[test]
    fn the_siri_actions_open_only_these_links_and_are_bundled_where_this_looks() {
        // Every ozzie:// link the Siri actions open is one this file accepts.
        let actions = include_str!("../helpers/siri-actions.swift");
        let opened: Vec<&str> = actions
            .split("\"ozzie://")
            .skip(1)
            .map(|rest| rest.split('"').next().unwrap())
            .collect();
        assert_eq!(opened, ["today", "sunday"]);
        for page in opened {
            assert_eq!(
                page_from_link(&format!("{URL_SCHEME}://{page}")),
                Some(page)
            );
        }
        // tauri.conf.json bundles them where siri_actions_bundled looks.
        let config = include_str!("../tauri.conf.json");
        assert!(config.contains(&format!(
            "\"Extensions/{SIRI_ACTIONS}\": \"binaries/{SIRI_ACTIONS}\""
        )));
    }

    #[test]
    fn finds_siri_actions_only_inside_the_app() {
        let dir = std::env::temp_dir().join(format!("ozzie-siri-actions-{}", std::process::id()));
        let contents = dir.join("Ozzie.app/Contents");
        let program = contents.join("MacOS/ozzie-desktop");
        std::fs::create_dir_all(program.parent().unwrap()).unwrap();
        std::fs::write(&program, b"").unwrap();
        assert!(!siri_actions_beside(&program));
        let binary = contents
            .join("Extensions")
            .join(SIRI_ACTIONS)
            .join("Contents/MacOS/OzzieIntents");
        std::fs::create_dir_all(&binary).unwrap();
        assert!(!siri_actions_beside(&program), "a folder isn't the program");
        std::fs::remove_dir(&binary).unwrap();
        std::fs::write(&binary, b"").unwrap();
        assert!(siri_actions_beside(&program));
        assert!(!siri_actions_beside(Path::new("ozzie-desktop")));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn finds_only_a_real_helper_beside_the_program() {
        let dir =
            std::env::temp_dir().join(format!("ozzie-shortcuts-helper-{}", std::process::id()));
        let app = dir.join("Ozzie.app/Contents/MacOS");
        std::fs::create_dir_all(&app).unwrap();
        let program = app.join("ozzie-desktop");
        std::fs::write(&program, b"").unwrap();
        assert_eq!(helper_beside(&program), None);
        std::fs::create_dir(app.join(SHORTCUTS_HELPER)).unwrap();
        assert_eq!(helper_beside(&program), None);
        std::fs::remove_dir(app.join(SHORTCUTS_HELPER)).unwrap();
        std::fs::write(app.join(SHORTCUTS_HELPER), b"").unwrap();
        let real = dir.canonicalize().unwrap().join("Ozzie.app/Contents/MacOS");
        assert_eq!(helper_beside(&program), Some(real.join(SHORTCUTS_HELPER)));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
