//! Text size (accessibility audit B1, WCAG 1.4.4 Resize Text): View › Bigger Text (Command-= or Command-+), Smaller
//! Text (Command-−) and Actual Size (Command-0) zoom the whole page in steps from 80% to 200%, natively, so the page
//! keeps no zoom grant of its own (capabilities/main.json grants no plugin command).
//!
//! The zoom is WKWebView's page zoom (`WebviewWindow::set_zoom`, wry `setPageZoom`), the same as Safari's Zoom In: it
//! changes how many screen points a CSS pixel takes, so the page's CSS width shrinks as the zoom grows. A 900-point
//! window at 125% lays out 720 CSS pixels wide and a 1280-point one at 175% lays out 731, so the narrow layout written
//! for under 760px (styles.css: the bar with Menu, Ask over the whole window, buttons that wrap) takes over on its own.
//!
//! The choice is kept in this Mac's app data folder as `text-size.json` (`{"version":1,"zoom":1.25}`, the same kind of
//! small versioned file as calendar-choice.json), and put back at the next launch and on every page load. Only a step
//! is ever asked for (the menu, or the page's Command-+ in text-size.ts); a size never comes from the page.
use std::path::Path;
use std::sync::Mutex;
use tauri::Manager;

/// The sizes, smallest to largest; 1.0 is Actual Size.
pub const STEPS: [f64; 8] = [0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0];
pub const ACTUAL: f64 = 1.0;
/// Where the choice is kept, in the app data folder.
pub const FILE: &str = "text-size.json";
/// The most a kept file can hold; anything longer is not one of Ozzie's and is ignored.
const MAX_FILE: u64 = 1024;

/// One step of the menu (or the page's Command-+).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Change {
    Bigger,
    Smaller,
    Actual,
}

/// The size after one step from `current`: the next step up or down, held at 80% and 200%. A size between steps (or one
/// that isn't a number) moves to the step beside it, so every result is one of STEPS.
pub fn step(current: f64, change: Change) -> f64 {
    let current = if current.is_finite() { current } else { ACTUAL };
    // A hair of room, so a size kept as 1.1000000001 still counts as 1.1.
    const NEAR: f64 = 1e-6;
    match change {
        Change::Actual => ACTUAL,
        Change::Bigger => STEPS
            .into_iter()
            .find(|s| *s > current + NEAR)
            .unwrap_or(STEPS[STEPS.len() - 1]),
        Change::Smaller => STEPS
            .into_iter()
            .rev()
            .find(|s| *s < current - NEAR)
            .unwrap_or(STEPS[0]),
    }
}

/// A kept size as Ozzie uses it: the nearest step when it is a number from 80% to 200%, otherwise Actual Size.
pub fn kept(zoom: f64) -> f64 {
    if !zoom.is_finite() || zoom < STEPS[0] - 1e-6 || zoom > STEPS[STEPS.len() - 1] + 1e-6 {
        return ACTUAL;
    }
    STEPS
        .into_iter()
        .min_by(|a, b| (a - zoom).abs().total_cmp(&(b - zoom).abs()))
        .unwrap_or(ACTUAL)
}

#[derive(serde::Serialize, serde::Deserialize)]
struct Kept {
    version: u32,
    zoom: f64,
}

/// The kept size, or Actual Size when there is none or it can't be read.
pub fn read(path: &Path) -> f64 {
    use std::io::Read;
    let mut bytes = Vec::new();
    let Ok(file) = std::fs::File::open(path) else {
        return ACTUAL;
    };
    if file.take(MAX_FILE + 1).read_to_end(&mut bytes).is_err() || bytes.len() as u64 > MAX_FILE {
        return ACTUAL;
    }
    match serde_json::from_slice::<Kept>(&bytes) {
        Ok(k) if k.version == 1 => kept(k.zoom),
        _ => ACTUAL,
    }
}

/// Keeps the size (replaced whole, readable by this user only), as calendars.rs keeps its choice.
pub fn save(path: &Path, zoom: f64) -> std::io::Result<()> {
    use std::io::Write;
    let dir = path
        .parent()
        .ok_or_else(|| std::io::Error::other("no folder"))?;
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(dir)?;
    let text = serde_json::to_vec(&Kept {
        version: 1,
        zoom: kept(zoom),
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
}

/// The size in use this session.
pub struct TextSize(Mutex<f64>);
impl Default for TextSize {
    fn default() -> Self {
        Self(Mutex::new(ACTUAL))
    }
}
impl TextSize {
    pub fn get(&self) -> f64 {
        *self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
    /// Takes one step and returns the new size.
    fn take(&self, change: Change) -> f64 {
        let mut zoom = self.0.lock().unwrap_or_else(|e| e.into_inner());
        *zoom = step(*zoom, change);
        *zoom
    }
    fn set(&self, zoom: f64) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = kept(zoom);
    }
}

/// One step from the View menu or the page: the window takes the new size at once, and it is kept for next time. A
/// size that can't be kept still applies until Ozzie quits.
pub fn change<R: tauri::Runtime>(app: &tauri::AppHandle<R>, change: Change) {
    let Some(size) = app.try_state::<TextSize>() else {
        return;
    };
    let zoom = size.take(change);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_zoom(zoom);
    }
    if let Ok(dir) = app.path().app_data_dir() {
        let _ = save(&dir.join(FILE), zoom);
    }
}

/// At start: the kept size, put on the window.
pub fn setup<R: tauri::Runtime>(app: &tauri::App<R>) {
    let zoom = app
        .path()
        .app_data_dir()
        .map(|dir| read(&dir.join(FILE)))
        .unwrap_or(ACTUAL);
    if let Some(size) = app.try_state::<TextSize>() {
        size.set(zoom);
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_zoom(zoom);
    }
}

/// Every page load keeps the size in use (a reload never drops it).
pub fn on_page_load<R: tauri::Runtime>(webview: &tauri::Webview<R>) {
    if let Some(size) = webview.try_state::<TextSize>() {
        let _ = webview.set_zoom(size.get());
    }
}

/// The page's Command-+ (text-size.ts): one step, never a size.
#[tauri::command]
pub fn text_size_step(app: tauri::AppHandle, step: Change) {
    change(&app, step);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bigger_and_smaller_walk_the_steps_and_stop_at_80_and_200_percent() {
        let mut zoom = ACTUAL;
        let mut up = Vec::new();
        for _ in 0..7 {
            zoom = step(zoom, Change::Bigger);
            up.push(zoom);
        }
        assert_eq!(up, [1.1, 1.25, 1.5, 1.75, 2.0, 2.0, 2.0]);
        let mut down = Vec::new();
        for _ in 0..9 {
            zoom = step(zoom, Change::Smaller);
            down.push(zoom);
        }
        assert_eq!(down, [1.75, 1.5, 1.25, 1.1, 1.0, 0.9, 0.8, 0.8, 0.8]);
        assert_eq!(step(2.0, Change::Actual), ACTUAL);
        assert_eq!(step(0.8, Change::Actual), ACTUAL);
    }

    #[test]
    fn a_size_between_steps_or_not_a_number_moves_to_a_step() {
        assert_eq!(step(1.3, Change::Bigger), 1.5);
        assert_eq!(step(1.3, Change::Smaller), 1.25);
        // Kept as written by floating point, it still counts as its step.
        assert_eq!(step(1.100_000_000_1, Change::Bigger), 1.25);
        assert_eq!(step(1.099_999_999_9, Change::Smaller), 1.0);
        // Outside the range: the nearest end, then the steps.
        assert_eq!(step(5.0, Change::Bigger), 2.0);
        assert_eq!(step(5.0, Change::Smaller), 2.0);
        assert_eq!(step(0.1, Change::Bigger), 0.8);
        assert_eq!(step(0.1, Change::Smaller), 0.8);
        // Not a number: from Actual Size.
        assert_eq!(step(f64::NAN, Change::Bigger), 1.1);
        assert_eq!(step(f64::INFINITY, Change::Smaller), 0.9);
        for z in [0.0, 0.5, 0.85, 1.0, 1.2, 1.6, 1.9, 2.0, 3.0, -1.0] {
            for c in [Change::Bigger, Change::Smaller, Change::Actual] {
                assert!(STEPS.contains(&step(z, c)), "{z} {c:?}");
            }
        }
    }

    #[test]
    fn a_kept_size_is_a_step_from_80_to_200_percent_or_actual_size() {
        assert_eq!(kept(1.25), 1.25);
        assert_eq!(kept(1.26), 1.25);
        assert_eq!(kept(0.8), 0.8);
        assert_eq!(kept(2.0), 2.0);
        assert_eq!(kept(2.5), ACTUAL);
        assert_eq!(kept(0.5), ACTUAL);
        assert_eq!(kept(f64::NAN), ACTUAL);
        assert_eq!(kept(-1.5), ACTUAL);
    }

    #[test]
    fn the_choice_is_kept_in_its_own_small_file_and_anything_else_reads_as_actual_size() {
        let dir = std::env::temp_dir().join(format!(
            "ozzie-text-size-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join(FILE);
        // Nothing kept yet.
        assert_eq!(read(&path), ACTUAL);
        save(&path, 1.5).unwrap();
        assert_eq!(read(&path), 1.5);
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            r#"{"version":1,"zoom":1.5}"#
        );
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        assert!(!path.with_extension("partial").exists());
        // Replaced whole.
        save(&path, 0.9).unwrap();
        assert_eq!(read(&path), 0.9);
        // Another version, a size out of range, not JSON, or too long: Actual Size.
        for text in [
            r#"{"version":2,"zoom":1.5}"#.to_string(),
            r#"{"version":1,"zoom":9}"#.to_string(),
            r#"{"version":1}"#.to_string(),
            "not json".to_string(),
            format!(r#"{{"version":1,"zoom":1.5,"x":"{}"}}"#, "a".repeat(2000)),
        ] {
            std::fs::write(&path, &text).unwrap();
            assert_eq!(read(&path), ACTUAL, "{}", &text[..text.len().min(40)]);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_page_can_ask_for_a_step_by_name_only() {
        assert_eq!(
            serde_json::from_str::<Change>(r#""bigger""#).unwrap(),
            Change::Bigger
        );
        assert_eq!(
            serde_json::from_str::<Change>(r#""smaller""#).unwrap(),
            Change::Smaller
        );
        assert_eq!(
            serde_json::from_str::<Change>(r#""actual""#).unwrap(),
            Change::Actual
        );
        assert!(serde_json::from_str::<Change>("2.0").is_err());
        assert!(serde_json::from_str::<Change>(r#""huge""#).is_err());
    }

    #[test]
    fn a_step_on_a_mock_app_changes_the_size_in_use_and_without_the_state_does_nothing() {
        let app = tauri::test::mock_builder()
            .manage(TextSize::default())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::default())
            .build()
            .unwrap();
        let size = app.state::<TextSize>();
        assert_eq!(size.get(), ACTUAL);
        change(app.handle(), Change::Bigger);
        change(app.handle(), Change::Bigger);
        assert_eq!(size.get(), 1.25);
        change(app.handle(), Change::Actual);
        assert_eq!(size.get(), ACTUAL);
        // No state managed (never in the app; tests of other menus): nothing happens and nothing fails.
        let bare = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        change(bare.handle(), Change::Bigger);
    }
}
