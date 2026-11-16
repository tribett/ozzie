//! "Add Ozzie to Claude" in Settings → Other AI apps: makes the small file Claude for Mac opens by
//! itself (a `.mcpb` file: a zip holding a manifest) and hands it to Claude, which then asks the
//! person whether to install it. Ozzie installs nothing in Claude: the person chooses there.
//!
//! The file holds no program. Its manifest names the helper inside this copy of Ozzie
//! (ozzie-share, found by share_helper.rs) run with no arguments, so what Claude starts is the
//! helper at that place: the one that came with this Ozzie. The page hands over nothing: the path, the manifest
//! and the file's place are all decided here. The manifest is native's own copy of
//! `claudeBundleManifest` in core/mcp/setup.ts; a test on each side holds both to one saved
//! example (core/test/mcp/fixtures/claude-bundle.json).
//!
//! Nothing is shared by this: the helper reads Ozzie's copy only while "Use Ozzie's last check in
//! other AI apps" is on, exactly as when it is set up by hand.
use std::io::Write as _;
use std::path::{Path, PathBuf};

use tauri::Manager;

use crate::share_helper;

/// Claude for Mac, by the name macOS knows it under.
pub const CLAUDE_BUNDLE_ID: &str = "com.anthropic.claudefordesktop";
pub const BUNDLE_FILE: &str = "Ozzie.mcpb";
pub const BUNDLE_NOTE: &str = "server/about.txt";
/// The folder inside Ozzie's cache folder that holds the file.
const BUNDLE_DIR: &str = "for-other-ai-apps";
/// Where macOS shows disk images and other disks (written in parts: the public export scan reads a
/// whole machine-style path as a leak).
const OTHER_DISKS: &str = concat!("/", "Volumes", "/");

/// Closed codes only.
#[derive(Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AddToClaudeError {
    /// This build has no helper.
    NoHelper,
    /// Ozzie runs from a temporary copy or a disk that can be ejected, or its path can't be
    /// written into the file as it is.
    MoveFirst,
    /// The file couldn't be saved.
    NotSaved,
    /// Claude isn't on this Mac, or it didn't open.
    NotOpened,
}

/// A helper path the file can carry as it is (the same rule as `usablePath` in setup.ts) and that
/// will still be there tomorrow (the same rule as `temporaryPath` in other-ai-apps-setup.tsx).
pub fn lasting_path(path: &str) -> bool {
    let usable = path.starts_with('/')
        && path.encode_utf16().count() <= 1024
        && !path
            .chars()
            .any(|c| c.is_control() || matches!(c, '\u{2028}' | '\u{2029}'))
        && !path.contains("${");
    let temporary = path.contains("/AppTranslocation/")
        || (path.starts_with(OTHER_DISKS) && path.contains(".app/Contents/MacOS/"));
    usable && !temporary
}

pub fn bundle_note(path: &str) -> String {
    format!(
        "This file holds no program. Claude starts the read-only helper inside Ozzie on this Mac:\n{path}\n"
    )
}

/// The manifest, equal to `claudeBundleManifest(path, version)` in core/mcp/setup.ts.
pub fn bundle_manifest(path: &str, version: &str) -> serde_json::Value {
    serde_json::json!({
        "manifest_version": "0.3",
        "name": "ozzie",
        "display_name": "Ozzie",
        "version": version,
        "description": "Read Ozzie's last Sunday check on this Mac. Read-only, with labels like [Person 1] instead of names.",
        "long_description": "Lets Claude read the last check Ozzie saved on this Mac, only while \"Use Ozzie's last check in other AI apps\" is on in Ozzie's Settings. People, roles and rooms appear as labels like [Person 1]; the names Ozzie read from Planning Center stay in Ozzie. It can't check Planning Center, change anything or send anything. It starts the helper inside Ozzie on this Mac, so if Ozzie moves or is removed, add it again from Ozzie's Settings.",
        "author": { "name": "Ozzie", "url": "https://ozzie.church" },
        "homepage": "https://ozzie.church",
        "server": {
            "type": "binary",
            "entry_point": BUNDLE_NOTE,
            "mcp_config": { "command": path, "args": [] }
        },
        "tools": [
            { "name": "sunday_readiness", "description": "Where the coming Sunday stands at Ozzie's last check, with labels instead of names." },
            { "name": "rooms_follow_ups_groups", "description": "Room bookings that overlap, follow-ups without an owner and group meetings at serving times, at Ozzie's last check." },
            { "name": "church_rules", "description": "The Church rules Ozzie checks against, in words." },
            { "name": "what_happened", "description": "What Ozzie ran recently and how it ended." }
        ],
        "compatibility": { "platforms": ["darwin"] },
        "license": "Apache-2.0"
    })
}

fn crc32(bytes: &[u8]) -> u32 {
    // The zip format's CRC-32 (reflected, polynomial 0xEDB88320).
    let mut crc = !0u32;
    for &byte in bytes {
        crc ^= u32::from(byte);
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xEDB8_8320 & (!(crc & 1)).wrapping_add(1));
        }
    }
    !crc
}

/// A zip of plain files, stored without compression: each a regular file readable by everyone,
/// dated 1980-01-01 so the same input always gives the same bytes. Names are plain relative
/// paths; `None` for anything else or a file too large for the format used here.
pub fn stored_zip(files: &[(&str, &[u8])]) -> Option<Vec<u8>> {
    const DOS_DATE: u16 = 0x0021; // 1980-01-01
    const VERSION: u16 = 20;
    const UTF8_NAMES: u16 = 0x0800;
    let mut out = Vec::new();
    let mut central = Vec::new();
    for (name, data) in files {
        let plain = !name.is_empty()
            && name.len() <= 255
            && !name.starts_with('/')
            && !name.contains('\\')
            && name
                .split('/')
                .all(|part| !part.is_empty() && part != "." && part != "..")
            && !name.chars().any(char::is_control);
        if !plain || data.len() > 16 * 1024 * 1024 {
            return None;
        }
        let offset = u32::try_from(out.len()).ok()?;
        let size = u32::try_from(data.len()).ok()?;
        let name_len = u16::try_from(name.len()).ok()?;
        let crc = crc32(data);
        out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        for field in [VERSION, UTF8_NAMES, 0, 0, DOS_DATE] {
            out.extend_from_slice(&field.to_le_bytes());
        }
        for field in [crc, size, size] {
            out.extend_from_slice(&field.to_le_bytes());
        }
        out.extend_from_slice(&name_len.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(data);

        central.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        // Made on Unix (3), so the mode below is read.
        for field in [(3u16 << 8) | VERSION, VERSION, UTF8_NAMES, 0, 0, DOS_DATE] {
            central.extend_from_slice(&field.to_le_bytes());
        }
        for field in [crc, size, size] {
            central.extend_from_slice(&field.to_le_bytes());
        }
        for field in [name_len, 0, 0, 0, 0] {
            central.extend_from_slice(&field.to_le_bytes());
        }
        // A regular file, rw-r--r--.
        central.extend_from_slice(&(0o100_644u32 << 16).to_le_bytes());
        central.extend_from_slice(&offset.to_le_bytes());
        central.extend_from_slice(name.as_bytes());
    }
    let count = u16::try_from(files.len()).ok()?;
    let central_offset = u32::try_from(out.len()).ok()?;
    let central_size = u32::try_from(central.len()).ok()?;
    out.extend_from_slice(&central);
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    for field in [0u16, 0, count, count] {
        out.extend_from_slice(&field.to_le_bytes());
    }
    out.extend_from_slice(&central_size.to_le_bytes());
    out.extend_from_slice(&central_offset.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    Some(out)
}

/// The whole file for the helper at `path`, or `None` when the path can't be carried.
pub fn bundle_bytes(path: &str, version: &str) -> Option<Vec<u8>> {
    if !lasting_path(path) {
        return None;
    }
    let manifest = serde_json::to_vec_pretty(&bundle_manifest(path, version)).ok()?;
    let note = bundle_note(path);
    stored_zip(&[("manifest.json", &manifest), (BUNDLE_NOTE, note.as_bytes())])
}

/// Saves the file in `dir` (made if needed, for this person only): written beside its place and
/// renamed over it, so Claude never opens half a file. A link or anything else that isn't a
/// folder where this folder should be is refused (folders above it are Ozzie's own cache folder,
/// taken as macOS gives it).
pub fn save_bundle(dir: &Path, bytes: &[u8]) -> Result<PathBuf, AddToClaudeError> {
    use std::os::unix::fs::{DirBuilderExt as _, OpenOptionsExt as _};
    let _ = std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir);
    let is_dir = std::fs::symlink_metadata(dir).is_ok_and(|meta| meta.is_dir());
    if !is_dir {
        return Err(AddToClaudeError::NotSaved);
    }
    let file = dir.join(BUNDLE_FILE);
    // One name per save, so two saves at once can't take each other's half-written file.
    static SAVES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let turn = SAVES.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let aside = dir.join(format!(".{BUNDLE_FILE}.{}.{turn}", std::process::id()));
    let _ = std::fs::remove_file(&aside);
    let written = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o644)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&aside)
        .and_then(|mut out| {
            out.write_all(bytes)?;
            out.sync_all()
        })
        .and_then(|()| std::fs::rename(&aside, &file));
    if written.is_err() {
        let _ = std::fs::remove_file(&aside);
        return Err(AddToClaudeError::NotSaved);
    }
    Ok(file)
}

/// What is run to hand the file to Claude: macOS's own `open`, for Claude only, with this file.
pub fn open_arguments(file: &Path) -> [std::ffi::OsString; 3] {
    [
        "-b".into(),
        CLAUDE_BUNDLE_ID.into(),
        file.as_os_str().to_owned(),
    ]
}

/// "Add Ozzie to Claude": makes the file for this copy of Ozzie and opens it in Claude.
#[tauri::command]
pub async fn add_to_claude(handle: tauri::AppHandle) -> Result<(), AddToClaudeError> {
    let path = share_helper::share_helper_path().ok_or(AddToClaudeError::NoHelper)?;
    let version = handle.package_info().version.to_string();
    let bytes = bundle_bytes(&path, &version).ok_or(AddToClaudeError::MoveFirst)?;
    let dir = handle
        .path()
        .app_cache_dir()
        .map_err(|_| AddToClaudeError::NotSaved)?
        .join(BUNDLE_DIR);
    tauri::async_runtime::spawn_blocking(move || {
        // One at a time: a second press waits for the first to hand its file over.
        static ONE_AT_A_TIME: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _turn = ONE_AT_A_TIME
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let file = save_bundle(&dir, &bytes)?;
        let opened = std::process::Command::new("/usr/bin/open")
            .args(open_arguments(&file))
            .env_clear()
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
        if opened.is_ok_and(|status| status.success()) {
            Ok(())
        } else {
            Err(AddToClaudeError::NotOpened)
        }
    })
    .await
    .map_err(|_| AddToClaudeError::NotOpened)?
}

#[cfg(test)]
#[path = "share_bundle_tests.rs"]
mod tests;
