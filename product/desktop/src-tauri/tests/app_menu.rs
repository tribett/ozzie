//! Review P, M1: Command-Q must ask. This installs Ozzie's app menu the way the app does (`app_menu::install`, whose
//! builder `menu` makes it AppKit's main menu) and reads that main menu back from AppKit, the menu AppKit matches Command-Q against:
//! Command-Q belongs to "Quit Ozzie", whose click is a menu event with the id always_on routes to `request_quit` (the
//! question), and no item anywhere ends the app directly (`terminate:`, the framework default's Quit).
//!
//! AppKit menus can only be made on the main thread and the test harness runs tests on other threads, so this file
//! has its own main (Cargo.toml: `harness = false`) and fails by panicking.
#[path = "../src/app_menu.rs"]
mod app_menu;

#[cfg(target_os = "macos")]
fn main() {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSEventModifierFlags, NSMenu};
    use tauri::menu::MenuItemKind;

    struct Item {
        title: String,
        action: String,
        key: String,
        command: bool,
    }
    fn appkit_items(menu: &NSMenu, out: &mut Vec<Item>) {
        for i in 0..menu.numberOfItems() {
            let Some(item) = menu.itemAtIndex(i) else {
                continue;
            };
            out.push(Item {
                title: item.title().to_string(),
                action: item
                    .action()
                    .map(|s| s.name().to_string_lossy().into_owned())
                    .unwrap_or_default(),
                key: item.keyEquivalent().to_string(),
                command: item
                    .keyEquivalentModifierMask()
                    .contains(NSEventModifierFlags::Command),
            });
            if let Some(sub) = item.submenu() {
                appkit_items(&sub, out);
            }
        }
    }
    fn own_items<R: tauri::Runtime>(items: Vec<MenuItemKind<R>>, out: &mut Vec<(String, String)>) {
        for item in items {
            match item {
                MenuItemKind::Submenu(sub) => own_items(sub.items().unwrap(), out),
                MenuItemKind::MenuItem(own) => {
                    out.push((own.id().as_ref().to_owned(), own.text().unwrap()))
                }
                MenuItemKind::Check(own) => {
                    out.push((own.id().as_ref().to_owned(), own.text().unwrap()))
                }
                MenuItemKind::Icon(own) => {
                    out.push((own.id().as_ref().to_owned(), own.text().unwrap()))
                }
                MenuItemKind::Predefined(_) => {}
            }
        }
    }

    // Installed the way always_on::manage installs it (a syn test there pins that it does, once).
    let app = app_menu::install(tauri::test::mock_builder(), |_, _| {})
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("the app builds with Ozzie's menu");

    // Ozzie's own items: "Quit Ozzie", with the id always_on sends to the question, Edit's Find… (owner decision
    // 2026-11-24), with the id always_on sends to the page, and View's three text size items (accessibility audit B1),
    // with the ids always_on sends to text_size.rs.
    let mut own = Vec::new();
    own_items(app.menu().expect("the app menu").items().unwrap(), &mut own);
    assert_eq!(
        own,
        vec![
            (app_menu::QUIT_ID.to_owned(), app_menu::QUIT_TEXT.to_owned()),
            (app_menu::FIND_ID.to_owned(), app_menu::FIND_TEXT.to_owned()),
            (
                app_menu::BIGGER_ID.to_owned(),
                app_menu::BIGGER_TEXT.to_owned()
            ),
            (
                app_menu::SMALLER_ID.to_owned(),
                app_menu::SMALLER_TEXT.to_owned()
            ),
            (
                app_menu::ACTUAL_ID.to_owned(),
                app_menu::ACTUAL_TEXT.to_owned()
            ),
        ]
    );

    // What AppKit holds as the main menu.
    let mtm = MainThreadMarker::new().expect("main thread");
    let main_menu = NSApplication::sharedApplication(mtm)
        .mainMenu()
        .expect("the builder made it AppKit's main menu");
    let mut items = Vec::new();
    appkit_items(&main_menu, &mut items);

    // Nothing ends the app without the question.
    let ends: Vec<&str> = items
        .iter()
        .filter(|i| i.action == "terminate:")
        .map(|i| i.title.as_str())
        .collect();
    assert!(ends.is_empty(), "items that quit at once: {ends:?}");
    // Command-Q is "Quit Ozzie" and nothing else, and its click is a menu event (muda's custom action), not a quit.
    let command_q: Vec<&Item> = items
        .iter()
        .filter(|i| i.command && i.key.eq_ignore_ascii_case("q"))
        .collect();
    assert_eq!(command_q.len(), 1, "one item has Command-Q");
    assert_eq!(command_q[0].title, app_menu::QUIT_TEXT);
    assert_eq!(command_q[0].action, "customAction:");
    // Bigger Text is Command-=, Smaller Text Command-minus and Actual Size Command-0, each a menu event and the only
    // item with its key (Command-+ is the page's: text-size.ts).
    // Find… is Command-K the same way.
    for (title, key) in [
        (app_menu::BIGGER_TEXT, "="),
        (app_menu::SMALLER_TEXT, "-"),
        (app_menu::ACTUAL_TEXT, "0"),
        (app_menu::FIND_TEXT, "k"),
    ] {
        let with_key: Vec<&Item> = items.iter().filter(|i| i.command && i.key == key).collect();
        assert_eq!(with_key.len(), 1, "one item has Command-{key}");
        assert_eq!(with_key[0].title, title);
        assert_eq!(with_key[0].action, "customAction:");
    }
    // The rest of the default menu is still there.
    for action in [
        "hide:",
        "hideOtherApplications:",
        "unhideAllApplications:",
        "undo:",
        "redo:",
        "cut:",
        "copy:",
        "paste:",
        "selectAll:",
        "toggleFullScreen:",
        "performMiniaturize:",
        "performZoom:",
        "performClose:",
    ] {
        assert!(
            items.iter().any(|i| i.action == action),
            "the app menu keeps {action}"
        );
    }
    println!(
        "app menu: {} items; Command-Q is \"{}\"; nothing quits at once",
        items.len(),
        app_menu::QUIT_TEXT
    );
}

#[cfg(not(target_os = "macos"))]
fn main() {}
