//! The church's own AI key, taken in without the web view (onboarding spec S8c; contract N5).
//!
//! "Paste my key" reads the Mac's clipboard once (`own_key_paste`); Ozzie's own key window takes it typed or pasted
//! into a secure field (`own_key_enter`). Either way the key goes from AppKit into core `own_key::KeyDesk`, held in
//! memory only, then to one check request and, if it works, the Keychain. The page gets a closed verdict and, on
//! "works", the model status; never the key. A key that works is cleared from the clipboard if it is still there.
use ozzie_native_auth::model::{
    self as model_route, KeychainKeys, ModelError, ModelStatus, NativeModelHttp,
};
use ozzie_native_auth::own_key::{self, Choice, KeyDesk, KeyVerdict, ProviderView, Verdict};
use std::sync::Arc;

/// The one key held between taking it in and the check that saves it (core `KeyDesk`).
#[derive(Clone, Default)]
pub struct Desk(Arc<KeyDesk>);

/// The company cards, in the spec's order, with no page address.
#[tauri::command]
pub fn own_key_providers() -> Vec<ProviderView> {
    own_key::providers()
}

/// Opens one of the fixed pages (a company's sign-in, billing, keys or settings page, or Ollama's download page)
/// in the browser. `page` is a closed word (`own_key::help_page`); nothing from the page becomes an address.
#[tauri::command]
pub async fn open_help_page(page: String) -> Result<(), &'static str> {
    let url = own_key::help_page(&page).ok_or("unknown-page")?;
    tauri::async_runtime::spawn_blocking(move || {
        let opened = std::process::Command::new("/usr/bin/open")
            .arg(url)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
        if opened.is_ok_and(|status| status.success()) {
            Ok(())
        } else {
            Err("browser-unavailable")
        }
    })
    .await
    .map_err(|_| "browser-unavailable")?
}

/// Holds a key for `choice` and starts its 15-minute timer: the desk zeroes it then even if nothing looks again
/// (review L4).
fn hold(desk: &Desk, text: String, choice: &Choice) {
    desk.0.hold_text(text, choice);
    let timer = desk.0.clone();
    std::thread::spawn(move || {
        std::thread::sleep(own_key::HOLD_FOR + std::time::Duration::from_secs(1));
        timer.forget_if_expired();
    });
}
/// After a key worked: the clipboard is cleared only if it holds exactly that key (review L3).
fn clear_clipboard_if_same(app: &tauri::AppHandle, desk: &Desk) {
    let desk = desk.0.clone();
    let _ = app.run_on_main_thread(move || clipboard::clear_if_same(&desk));
}
/// Checks the held key against `provider` (with `base_url` and `model` for "other") and saves it if it works.
fn check_held(
    app: &tauri::AppHandle,
    desk: &KeyDesk,
    names: &ozzie_native_auth::name_guard::NameGuard,
    choice: &Choice,
) -> Result<KeyVerdict, ModelError> {
    let dir = crate::model_dir(app)?;
    let http = NativeModelHttp::key_check()?;
    let mut verdict = desk.check(&dir, choice, names, &http, &KeychainKeys)?;
    // Google has changed its key format: a shape Ozzie doesn't know goes to Google only after a native yes.
    if verdict.verdict == Verdict::ConfirmUnknownShape {
        let (send, receive) = std::sync::mpsc::channel();
        app.run_on_main_thread(move || {
            let _ = send.send(window::confirm_shape());
        })
        .map_err(|_| ModelError::NotConfigured)?;
        verdict = if receive.recv().unwrap_or(false) {
            desk.check_shape_confirmed(&dir, choice, names, &http, &KeychainKeys)?
        } else {
            KeyVerdict::of(Verdict::Cancelled, choice.id())
        };
    }
    if verdict.verdict == Verdict::Works {
        // A new company's key: no signature from another route may follow it (review F7).
        ozzie_native_auth::agent::forget_all_signatures();
        // The status the page shows everywhere, with Ozzie's AI's row as `model_status` gives it.
        verdict.status = Some(crate::full_status(&dir));
    }
    Ok(verdict)
}

/// "Paste my key": the clipboard's text, read once and held natively for this company, then checked. For another
/// company a native question naming the host the key would go to comes first, and the clipboard is read only if
/// the person accepts (`own_key::take_in`; security review, 2026-11-17). `empty` when the clipboard holds no text,
/// `cancelled` when the question is declined. On "works" the clipboard is cleared if it still holds a key.
#[tauri::command]
pub async fn own_key_paste(
    app: tauri::AppHandle,
    desk: tauri::State<'_, Desk>,
    names: tauri::State<'_, crate::SessionNames>,
    provider: String,
    base_url: Option<String>,
    model: Option<String>,
) -> Result<KeyVerdict, ModelError> {
    let choice = Choice::parse(&provider, base_url, model)?;
    let desk = desk.inner().clone();
    let names = names.inner().snapshot();
    let (send, receive) = std::sync::mpsc::channel();
    let asking = choice.clone();
    app.run_on_main_thread(move || {
        let _ = send.send(own_key::take_in(&asking, window::confirm, clipboard::read));
    })
    .map_err(|_| ModelError::NotConfigured)?;
    tauri::async_runtime::spawn_blocking(move || {
        let text = match receive.recv().map_err(|_| ModelError::NotConfigured)?? {
            Ok(text) => text,
            Err(verdict) => return Ok(KeyVerdict::of(verdict, choice.id())),
        };
        hold(&desk, text, &choice);
        let verdict = check_held(&app, &desk.0, &names, &choice)?;
        if verdict.verdict == Verdict::Works {
            clear_clipboard_if_same(&app, &desk);
        }
        Ok(verdict)
    })
    .await
    .map_err(|_| ModelError::NotConfigured)?
}

/// Ozzie's own key window: "Paste your {company} key" (for another company, "Paste your key for {host}", naming
/// the host it will go to, so "Check this key" is the native confirmation), a secure field, "Check this key" and
/// "Cancel". The typed key is held natively for this company and checked; Cancel answers `cancelled`.
#[tauri::command]
pub async fn own_key_enter(
    app: tauri::AppHandle,
    desk: tauri::State<'_, Desk>,
    names: tauri::State<'_, crate::SessionNames>,
    provider: String,
    base_url: Option<String>,
    model: Option<String>,
) -> Result<KeyVerdict, ModelError> {
    let choice = Choice::parse(&provider, base_url, model)?;
    let host = choice.destination_host()?;
    // Decision 19: a company that hasn't passed the live test can't be used; nothing is shown or read.
    if let Err(verdict) = own_key::usable(&choice) {
        return Ok(KeyVerdict::of(verdict, choice.id()));
    }
    let title = match &choice {
        Choice::Preset(preset) => format!("Paste your {} key", preset.name),
        Choice::Other { .. } => format!("Paste your key for {host}"),
    };
    let desk = desk.inner().clone();
    let names = names.inner().snapshot();
    let (send, receive) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = send.send(window::ask(&title, &host));
    })
    .map_err(|_| ModelError::NotConfigured)?;
    tauri::async_runtime::spawn_blocking(move || {
        match receive.recv().map_err(|_| ModelError::NotConfigured)? {
            window::Answer::Cancelled => Ok(KeyVerdict::of(Verdict::Cancelled, choice.id())),
            window::Answer::Empty => Ok(KeyVerdict::of(Verdict::Empty, choice.id())),
            window::Answer::Key(text) => {
                hold(&desk, text, &choice);
                let verdict = check_held(&app, &desk.0, &names, &choice)?;
                if verdict.verdict == Verdict::Works {
                    clear_clipboard_if_same(&app, &desk);
                }
                Ok(verdict)
            }
        }
    })
    .await
    .map_err(|_| ModelError::NotConfigured)?
}

/// "Check this key again" (after adding credit) or "Use it with {company}" (after `wrong-kind`): the held key,
/// checked against `provider`. `empty` when none is held.
#[tauri::command]
pub async fn own_key_check_again(
    app: tauri::AppHandle,
    desk: tauri::State<'_, Desk>,
    names: tauri::State<'_, crate::SessionNames>,
    provider: String,
    base_url: Option<String>,
    model: Option<String>,
) -> Result<KeyVerdict, ModelError> {
    let choice = Choice::parse(&provider, base_url, model)?;
    if let Err(verdict) = own_key::usable(&choice) {
        return Ok(KeyVerdict::of(verdict, choice.id()));
    }
    let desk = desk.inner().clone();
    let names = names.inner().snapshot();
    tauri::async_runtime::spawn_blocking(move || check_held(&app, &desk.0, &names, &choice))
        .await
        .map_err(|_| ModelError::NotConfigured)?
}

/// "Use the key already on this Mac": the key kept in the Keychain for this company (one Ozzie knows) is held natively
/// and checked as a pasted key is; on "works" its route is chosen, unless another choice was made meanwhile. The key
/// never reaches the page. `no-kept-key` when none is kept for it any more.
#[tauri::command]
pub async fn own_key_use_kept(
    app: tauri::AppHandle,
    desk: tauri::State<'_, Desk>,
    names: tauri::State<'_, crate::SessionNames>,
    provider: String,
) -> Result<KeyVerdict, ModelError> {
    let choice = Choice::parse(&provider, None, None)?;
    if let Err(verdict) = own_key::usable(&choice) {
        return Ok(KeyVerdict::of(verdict, choice.id()));
    }
    let desk = desk.inner().clone();
    let names = names.inner().snapshot();
    tauri::async_runtime::spawn_blocking(move || {
        if !desk.0.hold_kept(&choice, &KeychainKeys)? {
            return Ok(KeyVerdict::of(Verdict::NoKeptKey, choice.id()));
        }
        // Its 15-minute timer, as for a key taken in (review L4); "Check this key again" checks it again meanwhile.
        let timer = desk.0.clone();
        std::thread::spawn(move || {
            std::thread::sleep(own_key::HOLD_FOR + std::time::Duration::from_secs(1));
            timer.forget_if_expired();
        });
        check_held(&app, &desk.0, &names, &choice)
    })
    .await
    .map_err(|_| ModelError::NotConfigured)?
}

/// The key screen closed: the held key, if any, is dropped.
#[tauri::command]
pub fn own_key_forget(desk: tauri::State<'_, Desk>) {
    desk.0.forget();
}

/// Settings' "Remove this key": deletes the own route's key from the Keychain and leaves no route chosen.
#[tauri::command]
pub async fn own_key_remove(app: tauri::AppHandle) -> Result<ModelStatus, ModelError> {
    tauri::async_runtime::spawn_blocking(move || {
        ozzie_native_auth::agent::forget_all_signatures();
        let dir = crate::model_dir(&app)?;
        own_key::remove(&dir, &KeychainKeys)?;
        Ok(crate::full_status(&dir))
    })
    .await
    .map_err(|_| ModelError::NotConfigured)?
}

/// Settings' "Change the limit": AI requests a month on the church's own key, 100 to 20,000.
#[tauri::command]
pub async fn set_month_limit(app: tauri::AppHandle, limit: u64) -> Result<ModelStatus, ModelError> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = crate::model_dir(&app)?;
        model_route::set_month_limit(&dir, limit)?;
        Ok(crate::full_status(&dir))
    })
    .await
    .map_err(|_| ModelError::NotConfigured)?
}

/// The general pasteboard, on the main thread only.
mod clipboard {
    /// Its text, if it holds text. Never logged or echoed.
    #[cfg(target_os = "macos")]
    pub fn read() -> Option<String> {
        use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};
        let board = NSPasteboard::generalPasteboard();
        // SAFETY: NSPasteboardTypeString is AppKit's constant for plain text, valid for the process's life.
        let text = board.stringForType(unsafe { NSPasteboardTypeString })?;
        let text = text.to_string();
        (!text.trim().is_empty()).then_some(text)
    }
    #[cfg(not(target_os = "macos"))]
    pub fn read() -> Option<String> {
        None
    }
    /// After a key worked: the clipboard is emptied only if it holds exactly that key (the desk compares digests);
    /// anything else the person copied since is theirs to keep.
    #[cfg(target_os = "macos")]
    pub fn clear_if_same(desk: &ozzie_native_auth::own_key::KeyDesk) {
        use objc2_app_kit::NSPasteboard;
        if let Some(text) = read()
            && desk.is_the_key_that_worked(&text)
        {
            NSPasteboard::generalPasteboard().clearContents();
        }
    }
    #[cfg(not(target_os = "macos"))]
    pub fn clear_if_same(_: &ozzie_native_auth::own_key::KeyDesk) {}
}

/// Ozzie's own key window: a modal alert with a secure field, on the main thread.
mod window {
    pub enum Answer {
        Key(String),
        Empty,
        Cancelled,
    }
    /// Another company: "Send your key to {host}?" before the clipboard is read. True only on "Send it".
    #[cfg(target_os = "macos")]
    pub fn confirm(host: &str) -> bool {
        use objc2_app_kit::{NSAlert, NSAlertFirstButtonReturn};
        use objc2_foundation::{MainThreadMarker, NSString};
        let Some(mtm) = MainThreadMarker::new() else {
            return false;
        };
        let alert = NSAlert::new(mtm);
        alert.setMessageText(&NSString::from_str(&format!("Send your key to {host}?")));
        alert.setInformativeText(&NSString::from_str(&format!(
            "Ozzie will read the key you copied and send it only to {host}, to check it. Choose Send it to {host} only if that is your AI company's address."
        )));
        alert.addButtonWithTitle(&NSString::from_str(&format!("Send it to {host}")));
        alert.addButtonWithTitle(&NSString::from_str("Don't send it"));
        alert.runModal() == NSAlertFirstButtonReturn
    }
    #[cfg(not(target_os = "macos"))]
    pub fn confirm(_: &str) -> bool {
        false
    }
    /// Google, a key of a shape Ozzie doesn't know: asked before it is sent. True only on "Send it to Google".
    #[cfg(target_os = "macos")]
    pub fn confirm_shape() -> bool {
        use objc2_app_kit::{NSAlert, NSAlertFirstButtonReturn};
        use objc2_foundation::{MainThreadMarker, NSString};
        let Some(mtm) = MainThreadMarker::new() else {
            return false;
        };
        let alert = NSAlert::new(mtm);
        alert.setMessageText(&NSString::from_str(
            "This doesn't look like the Google keys Ozzie knows. Send it to Google to check?",
        ));
        alert.setInformativeText(&NSString::from_str(
            "Google has changed how its keys look. Ozzie sends it only to Google, in one short request to check it.",
        ));
        alert.addButtonWithTitle(&NSString::from_str("Send it to Google"));
        alert.addButtonWithTitle(&NSString::from_str("Don't send it"));
        alert.runModal() == NSAlertFirstButtonReturn
    }
    #[cfg(not(target_os = "macos"))]
    pub fn confirm_shape() -> bool {
        false
    }
    #[cfg(target_os = "macos")]
    pub fn ask(title: &str, host: &str) -> Answer {
        use objc2::MainThreadOnly;
        use objc2_app_kit::{NSAlert, NSAlertFirstButtonReturn, NSSecureTextField};
        use objc2_foundation::{MainThreadMarker, NSPoint, NSRect, NSSize, NSString};
        let Some(mtm) = MainThreadMarker::new() else {
            return Answer::Cancelled;
        };
        let alert = NSAlert::new(mtm);
        alert.setMessageText(&NSString::from_str(title));
        alert.setInformativeText(&NSString::from_str(&format!(
            "Ozzie sends it only to {host}: once now to check it, then with each AI request. If it works, Ozzie keeps it in this Mac's Keychain. It is never shown again."
        )));
        alert.addButtonWithTitle(&NSString::from_str("Check this key"));
        alert.addButtonWithTitle(&NSString::from_str("Cancel"));
        let field = NSSecureTextField::initWithFrame(
            NSSecureTextField::alloc(mtm),
            NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(360.0, 24.0)),
        );
        field.setPlaceholderString(Some(&NSString::from_str("Paste the key here")));
        alert.setAccessoryView(Some(&field));
        alert.window().setInitialFirstResponder(Some(&field));
        let answer = alert.runModal();
        let text = field.stringValue().to_string();
        // The field's own copy goes as the window closes.
        field.setStringValue(&NSString::from_str(""));
        if answer != NSAlertFirstButtonReturn {
            return Answer::Cancelled;
        }
        if text.trim().is_empty() {
            Answer::Empty
        } else {
            Answer::Key(text)
        }
    }
    #[cfg(not(target_os = "macos"))]
    pub fn ask(_: &str, _: &str) -> Answer {
        Answer::Cancelled
    }
}

/// "No AI for now" (from setup or Settings): no AI route is chosen, so no AI request goes anywhere, whether the
/// route was a model on this Mac, Ozzie's AI or the church's own key. The church's key stays in the Keychain (only
/// `remove_own_key` deletes it) and Ozzie's AI's sign-in on this Mac stays (only `managed_disconnect` ends it).
#[tauri::command]
pub async fn set_no_ai(app: tauri::AppHandle) -> Result<ModelStatus, ModelError> {
    tauri::async_runtime::spawn_blocking(move || {
        ozzie_native_auth::agent::forget_all_signatures();
        let dir = crate::model_dir(&app)?;
        model_route::choose_no_ai(&dir, &KeychainKeys)?;
        Ok(crate::full_status(&dir))
    })
    .await
    .map_err(|_| ModelError::NotConfigured)?
}

/// Which companies a key of the church's own is kept for on this Mac (`own_key::saved_companies`: one closed id per
/// key Ozzie saved), so "Remove my key from this Mac" can say every key it removes. Reads Ozzie's own list of hosts
/// only: never the Keychain, never a key or any part of one.
#[tauri::command]
pub async fn own_key_saved(app: tauri::AppHandle) -> Result<Vec<&'static str>, ModelError> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = crate::model_dir(&app)?;
        Ok(own_key::saved_companies(&dir))
    })
    .await
    .map_err(|_| ModelError::NotConfigured)?
}

/// How many keys of the church's own "Remove my key from this Mac" would delete now (`own_key::kept_key_count`): from
/// the Keychain's list of Ozzie's entries alone, never a key or any part of one. None when the Keychain can't list
/// them; the page then keeps offering the removal (review L-4).
#[tauri::command]
pub async fn own_key_count(app: tauri::AppHandle) -> Result<Option<usize>, ModelError> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = crate::model_dir(&app)?;
        Ok(own_key::kept_key_count(&dir, &KeychainKeys))
    })
    .await
    .map_err(|_| ModelError::NotConfigured)?
}

/// "Remove my key from this Mac": deletes every key of the church's own Ozzie knows of on this Mac and says so
/// (`removed`: "removed" | "none" | "refused"), with the status afterwards. An own route ends with its key.
#[tauri::command]
pub async fn remove_own_key(app: tauri::AppHandle) -> Result<own_key::KeyRemoval, ModelError> {
    tauri::async_runtime::spawn_blocking(move || {
        ozzie_native_auth::agent::forget_all_signatures();
        let dir = crate::model_dir(&app)?;
        let mut removal = own_key::remove_keys(&dir, &KeychainKeys);
        removal.status = crate::full_status(&dir);
        Ok(removal)
    })
    .await
    .map_err(|_| ModelError::NotConfigured)?
}
