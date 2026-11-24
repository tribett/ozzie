//! Ozzie's macOS app menu (review P, M1): the framework's default menu, item for item, except its Quit, which ends
//! the app at once with no question. "Quit Ozzie" here has Command-Q and the same id as the menu bar icon's "Quit
//! Ozzie", so both go through always_on's `request_quit`: it asks first when visitor cards are open or checks are on.
//!
//! The View menu also has Bigger Text, Smaller Text and Actual Size (accessibility audit B1): their clicks go to
//! text_size.rs through the same one handler, which zooms the page natively.
//!
//! The Edit menu also has Find… (Command-K; owner decision 2026-11-24): its click shows the window and tells the page to
//! open Find in Ozzie (always_on.rs), which matches what the page already holds; nothing is read or sent for it.
//!
//! There is deliberately no terminate hook: logging out, restarting or shutting down this Mac, and Quit from the
//! Dock, end Ozzie without asking, so Ozzie never holds up the Mac.
//!
//! No crate imports: tests/app_menu.rs installs this same menu through `install`, as always_on::manage does, on the
//! main thread, where AppKit menus can be made, and reads back the menu AppKit uses for Command-Q.
use tauri::menu::{
    AboutMetadata, HELP_SUBMENU_ID, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu,
    WINDOW_SUBMENU_ID,
};
use tauri::{AppHandle, Builder, Runtime};

/// "Quit Ozzie", in this menu and in the menu bar icon's menu: one id, one handler (always_on `on_menu_event`).
pub const QUIT_ID: &str = "quit";
pub const QUIT_TEXT: &str = "Quit Ozzie";
/// Command-Q on a Mac.
pub const QUIT_KEYS: &str = "CmdOrCtrl+Q";

/// View › Bigger Text, Smaller Text and Actual Size: ids always_on sends to text_size.rs, words and keys as on a Mac.
pub const BIGGER_ID: &str = "text-bigger";
pub const BIGGER_TEXT: &str = "Bigger Text";
/// Command-= (the key that has + on it, without Shift). A menu item has one key: Command-+ itself (Shift held, or a +
/// key of its own) is heard by the page and asks for the same step (text-size.ts).
pub const BIGGER_KEYS: &str = "CmdOrCtrl+Equal";
pub const SMALLER_ID: &str = "text-smaller";
pub const SMALLER_TEXT: &str = "Smaller Text";
pub const SMALLER_KEYS: &str = "CmdOrCtrl+Minus";
pub const ACTUAL_ID: &str = "text-actual";
pub const ACTUAL_TEXT: &str = "Actual Size";
pub const ACTUAL_KEYS: &str = "CmdOrCtrl+0";

/// Edit › Find…: the id always_on turns into the page's `ozzie:find` event, its words and its key (Command-K, which the
/// page also hears itself: find-box.tsx).
pub const FIND_ID: &str = "find";
pub const FIND_TEXT: &str = "Find…";
pub const FIND_KEYS: &str = "CmdOrCtrl+K";

/// Installs the app menu in place of the framework's default (macOS) and `on_click` as the one handler for every
/// menu's clicks, this menu's and the menu bar icon's (Tauri gives each handler all of them, so there must be exactly
/// one). always_on::manage calls it once; nothing else in the app sets a menu or a menu handler (review F, L-7).
pub fn install<R: Runtime, F: Fn(&AppHandle<R>, MenuEvent) + Send + Sync + 'static>(
    builder: Builder<R>,
    on_click: F,
) -> Builder<R> {
    #[cfg(target_os = "macos")]
    let builder = builder.menu(build);
    builder.on_menu_event(on_click)
}

/// The app menu: Ozzie (About, Services, Hide, Hide Others, Show All, Quit Ozzie), File, Edit (the system's items, then
/// Find…), View (Bigger Text, Smaller Text, Actual Size, Full Screen), Window, Help.
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let info = app.package_info();
    let config = app.config();
    let about = AboutMetadata {
        name: Some(info.name.clone()),
        version: Some(info.version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config.bundle.publisher.clone().map(|p| vec![p]),
        ..Default::default()
    };
    let quit = MenuItem::with_id(app, QUIT_ID, QUIT_TEXT, true, Some(QUIT_KEYS))?;
    let ozzie = Submenu::with_items(
        app,
        info.name.clone(),
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(about))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[&PredefinedMenuItem::close_window(app, None)?],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, FIND_ID, FIND_TEXT, true, Some(FIND_KEYS))?,
        ],
    )?;
    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &MenuItem::with_id(app, BIGGER_ID, BIGGER_TEXT, true, Some(BIGGER_KEYS))?,
            &MenuItem::with_id(app, SMALLER_ID, SMALLER_TEXT, true, Some(SMALLER_KEYS))?,
            &MenuItem::with_id(app, ACTUAL_ID, ACTUAL_TEXT, true, Some(ACTUAL_KEYS))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;
    let window = Submenu::with_id_and_items(
        app,
        WINDOW_SUBMENU_ID,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;
    let help = Submenu::with_id_and_items(app, HELP_SUBMENU_ID, "Help", true, &[])?;
    Menu::with_items(app, &[&ozzie, &file, &edit, &view, &window, &help])
}
