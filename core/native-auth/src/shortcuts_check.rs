//! The copy Siri and Shortcuts answer from ("Let Siri and Shortcuts ask Ozzie" in Settings, off by
//! default; ADR 0006). Ozzie's bundled helper (ozzie-shortcuts, core/mcp/shortcuts.ts) reads it
//! when a shortcut asks, and says only counts, dates and fixed words from it.
//!
//! It is the copy for other AI apps made smaller, not a second boundary: the webview hands in the
//! Sunday overview from the same read-only agent tools, and `shared_check::share_at` checks it
//! exactly as it checks that copy (the closed grammar, every name this session has shown, contact
//! details, background-check wording) before writing it in its own Place, with no ledger rows.
//! Anything but one overview is refused here first. Its own marker keeps whether it's on, so its
//! switch, its copy and their clean-up never touch the copy for other AI apps. Nothing here reads
//! Planning Center or reaches a network.
//!
//! A church on B1 Church or Breeze keeps the same copy of its own check (`save_of`), with the
//! system part shared_check.rs describes; Planning Center's is byte for byte as before. A church
//! on Genesis, which shares no volunteer schedules, has no check to keep: its copy is GENESIS_COPY,
//! fixed here and holding no fact, so Siri and Shortcuts can say that rather than that there is no
//! saved check yet (`save_genesis`). A reader older than 0.10.0 refuses it and says there's no check.
use crate::name_guard::NameGuard;
use crate::shared_check::{self, Place, ShareError, SharedSystem};
use serde_json::Value;
use std::path::Path;

/// core/mcp/shortcuts.ts SHORTCUTS_FILE and SHORTCUTS_ON_FILE, pinned by a test.
pub const SHORTCUTS: Place = Place {
    file: "shortcuts-check.json",
    on_file: ".shortcuts-check.on",
};
/// core/mcp/shortcuts.ts SHORTCUT_TOOLS: the one shared tool whose result the copy holds.
pub const SHORTCUT_TOOLS: [&str; 1] = ["sunday.overview"];

/// Checks and writes the copy: exactly one result, from a SHORTCUT_TOOLS tool, checked by
/// `shared_check` like every shared result. Refused while the switch is off; a refused copy leaves
/// the last one as it was.
pub fn save(
    dir: &Path,
    envelopes: &[String],
    names: &NameGuard,
    copy_id: &str,
    now_ms: u64,
) -> Result<(), ShareError> {
    save_of(dir, envelopes, names, copy_id, None, now_ms)
}

/// `save` for a church on `system` (None: Planning Center, exactly as `save`).
pub fn save_of(
    dir: &Path,
    envelopes: &[String],
    names: &NameGuard,
    copy_id: &str,
    system: Option<SharedSystem>,
    now_ms: u64,
) -> Result<(), ShareError> {
    let [only] = envelopes else {
        return Err(ShareError::Invalid);
    };
    let tool = serde_json::from_str::<Value>(only)
        .ok()
        .and_then(|v| v.get("tool").and_then(Value::as_str).map(str::to_owned));
    if !tool.is_some_and(|t| SHORTCUT_TOOLS.contains(&t.as_str())) {
        return Err(ShareError::Invalid);
    }
    shared_check::share_system_at(
        SHORTCUTS,
        dir,
        envelopes,
        &[],
        names,
        copy_id,
        system,
        now_ms,
    )
}

/// The whole copy for a church on Genesis (core/mcp/shortcuts.ts GENESIS_COPY, pinned by a test).
pub const GENESIS_COPY: &[u8] = br#"{"format":"ozzie-shared-check-2","system":"genesis"}"#;

/// Keeps GENESIS_COPY as the copy: the webview hands in nothing. Refused while the switch is off.
pub fn save_genesis(dir: &Path) -> Result<(), ShareError> {
    shared_check::write_fixed_at(SHORTCUTS, dir, GENESIS_COPY)
}

/// Whether the leader has the switch on.
pub fn is_on(dir: &Path) -> bool {
    shared_check::is_on_at(SHORTCUTS, dir)
}
/// Turning it on. Nothing is written until the webview saves the check on screen.
pub fn start(dir: &Path) -> Result<(), ShareError> {
    shared_check::start_at(SHORTCUTS, dir)
}
/// Turning it off: the marker, then the copy, so the helper answers only that it's turned off.
pub fn stop(dir: &Path) -> Result<(), ShareError> {
    shared_check::stop_at(SHORTCUTS, dir)
}
/// Nothing current to answer from: the copy goes, the switch stays on.
pub fn clear(dir: &Path) -> Result<(), ShareError> {
    shared_check::clear_at(SHORTCUTS, dir)
}
/// At every start of the app: a half-written copy goes, and while off the copy too.
pub fn startup(dir: &Path) -> Result<(), ShareError> {
    shared_check::startup_at(SHORTCUTS, dir)
}

#[cfg(test)]
#[path = "shortcuts_check_tests.rs"]
mod tests;
