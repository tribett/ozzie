//! Where Ozzie's helper for other AI apps is on this Mac (ozzie-share, helpers/share.swift), so
//! Settings can show the setup text for "Use Ozzie's last check in other AI apps". The helper is
//! bundled beside Ozzie's own program (Ozzie.app/Contents/MacOS in the app, target/<profile> in a
//! development build) and found the same way local_tools.rs finds its helpers. This only looks:
//! nothing is run, written or shared here, and the other AI app starts the helper itself.
use std::path::{Path, PathBuf};

pub const SHARE_HELPER: &str = "ozzie-share";

/// The helper beside `program`, as a real path (links resolved), when it is a file.
fn helper_beside(program: &Path) -> Option<PathBuf> {
    let path = program.parent()?.join(SHARE_HELPER).canonicalize().ok()?;
    path.is_file().then_some(path)
}

/// The real path of the helper bundled with this copy of Ozzie, or None when this build has none
/// (or its path isn't plain text).
#[tauri::command]
pub fn share_helper_path() -> Option<String> {
    let program = std::env::current_exe().ok()?.canonicalize().ok()?;
    helper_beside(&program)?.into_os_string().into_string().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_only_a_real_helper_beside_the_program() {
        let dir = std::env::temp_dir().join(format!("ozzie-share-helper-{}", std::process::id()));
        let app = dir.join("Ozzie.app/Contents/MacOS");
        std::fs::create_dir_all(&app).unwrap();
        let program = app.join("ozzie-desktop");
        std::fs::write(&program, b"").unwrap();
        let real = dir.canonicalize().unwrap().join("Ozzie.app/Contents/MacOS");
        // None until the helper is there, and a folder in its place doesn't count.
        assert_eq!(helper_beside(&program), None);
        std::fs::create_dir(app.join(SHARE_HELPER)).unwrap();
        assert_eq!(helper_beside(&program), None);
        std::fs::remove_dir(app.join(SHARE_HELPER)).unwrap();
        std::fs::write(app.join(SHARE_HELPER), b"").unwrap();
        assert_eq!(helper_beside(&program), Some(real.join(SHARE_HELPER)));
        // Reached through a link, it is still the helper's own path.
        let link = dir.join("linked");
        std::os::unix::fs::symlink(&app, &link).unwrap();
        assert_eq!(
            helper_beside(&link.join("ozzie-desktop")),
            Some(real.join(SHARE_HELPER))
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
