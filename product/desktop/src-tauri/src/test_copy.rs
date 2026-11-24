//! The test copy of Ozzie (owner decision 2026-11-24): a build variant, never a fork, for clicking through B1 Church,
//! Breeze and the example church without touching the real app or its sign-ins. One switch at build time turns it on:
//! this crate's `test-copy` feature together with tauri.test-copy.conf.json (its own identifier, name, icon, Info.plist
//! and helpers; no updater, no Siri actions). Both are off unless asked for, and only together (src/variant_guard.rs);
//! tools/release-mac.sh (private repository) passes neither.
//!
//! What differs in the test copy, and where:
//! - its bundle identifier, so its own app data, caches and web view storage (tauri.test-copy.conf.json); its helpers
//!   read their copies from that data folder (build.rs, `OZZIE_TEST_COPY` in helpers/*.swift);
//! - every Keychain service name, with the test copy's prefix (native-auth variant.rs);
//! - no Planning Center sign-in (main.rs `sign_in`): the redirect Planning Center knows is the real app's own;
//! - no updater (updater.rs), no notice to a phone (phone_notice.rs), no login item (always_on.rs), no ozzie:// links
//!   (Info-test-copy.plist), no "Add Ozzie to Claude" (share_bundle.rs);
//! - a "TEST COPY" banner on every page and its own window title, so a screenshot can't pass for the real app.
use ozzie_native_auth::variant;

// The desktop's feature and native-auth's always agree: a build is wholly the real app or wholly the test copy.
const _: () = assert!(cfg!(feature = "test-copy") == variant::IS_TEST_COPY);

/// The test copy's window title.
pub const WINDOW_TITLE: &str = "Ozzie TEST COPY";
/// The name of the page's marker (product/desktop/src/build-variant.ts).
pub const PAGE_MARKER: &str = "__OZZIE_TEST_COPY__";

/// The script the test copy runs before any of the page's own: a fixed marker, which nothing can change, saying this is
/// the test copy and which prefix its Keychain names carry, so the page shows its banner and names the right Keychain
/// items. The real app never adds it.
pub fn init_script() -> String {
    let prefix = serde_json::to_string(variant::TEST_COPY_KEYCHAIN_PREFIX).unwrap_or_default();
    format!(
        "Object.defineProperty(window, \"{PAGE_MARKER}\", {{ value: Object.freeze({{ keychainPrefix: {prefix} }}), \
         writable: false, configurable: false, enumerable: false }});"
    )
}

/// In the test copy only: the page's marker. The real app's builder is returned as it came.
pub fn manage(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    if !variant::IS_TEST_COPY {
        return builder;
    }
    builder.plugin(
        tauri::plugin::Builder::<tauri::Wry>::new("ozzie-test-copy")
            .js_init_script(init_script())
            .build(),
    )
}
/// In the test copy only: its own window title.
pub fn setup(app: &tauri::App) {
    use tauri::Manager;
    if !variant::IS_TEST_COPY {
        return;
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title(WINDOW_TITLE);
    }
}

// Whether the test-copy feature and the Tauri config agree: build.rs fails a build where they don't, with this file.
#[cfg(test)]
#[path = "variant_guard.rs"]
mod variant_guard;

#[cfg(test)]
#[path = "test_copy_tests.rs"]
mod tests;
