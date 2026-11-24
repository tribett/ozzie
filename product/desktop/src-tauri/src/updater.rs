//! New versions of Ozzie (owner, 2026-11-15: a person who installed Ozzie learns inside Ozzie that a
//! newer version exists and updates with one click, safely). Everything runs here, in native code:
//!
//!  - the check: one plain GET of `latest.json` on the public GitHub release (FEED), through
//!    tauri-plugin-updater with Ozzie's fixed settings. Nothing about the church, the person or this
//!    Mac is added: no query, no extra header, no cookie. The plugin sends its own `User-Agent`
//!    (`tauri-plugin-updater/<its version>`) and `Accept: application/json`; GitHub answers with a
//!    redirect to its download host, which gets the same request. HTTPS only, no proxy;
//!  - when: shortly after launch (FIRST_CHECK_AFTER_MS) and then about once a day while Ozzie runs
//!    (CHECK_EVERY_MS), from the native timer's wakes (always_on.rs), unless the person turned
//!    "Check for new versions automatically" off; a failed automatic check is silent and tried again
//!    after RETRY_AFTER_MS. "Check for a new version" in Settings checks whatever the setting;
//!  - what may be offered: only a strictly newer, non-pre-release version (`is_newer`), from the
//!    release's own download address (`download_ok`). The plugin checks the archive against the public
//!    key in tauri.conf.json, and that the signed version is the one announced
//!    (`requireSignedVersion`), before anything is installed;
//!  - installing: only on the person's click ("Update Ozzie and reopen it", `update_install`). The
//!    archive is downloaded and checked, Ozzie waits for any task or responsibility run under way to
//!    finish (WAIT_FOR_TASKS), swaps the app in place, quits and reopens once this copy has exited
//!    (`reopen_after_exit`). The bundle identifier and signing team don't change, so the Keychain
//!    sign-in, the app data folder (Church rules, what Ozzie keeps an eye on, the task ledger) and
//!    the web view's storage carry over;
//!  - the page gets no plugin permission (capabilities/main.json): it calls these four commands and
//!    shows the state they return, in its own fixed words. Release notes from the release are
//!    never shown or passed on; the version is shown only once it parses as a version.
use crate::Ledger;
use ozzie_native_auth::ledger::TaskRow;
use ozzie_native_auth::sunday_check::unix_ms;
use semver::{BuildMetadata, Version};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Where the newest version is announced: an asset of the public repository's latest release.
pub const FEED: &str = "https://github.com/tribett/ozzie/releases/latest/download/latest.json";
/// The only place an announced archive may be downloaded from in a release build.
pub const DOWNLOAD_PREFIX: &str = "https://github.com/tribett/ozzie/releases/download/";
/// The archive's file name on the release (tools/release-mac.sh writes it from the final, stapled app).
pub const ARCHIVE_NAME: &str = "Ozzie.app.tar.gz";
/// The first automatic check comes this long after launch, once the app has settled.
pub const FIRST_CHECK_AFTER_MS: u64 = 90_000;
/// Then about once a day while Ozzie runs.
pub const CHECK_EVERY_MS: u64 = 24 * 3_600_000;
/// A failed automatic check is tried again after this long, without telling anyone.
pub const RETRY_AFTER_MS: u64 = 3 * 3_600_000;
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// After the click, Ozzie waits at most this long for a task under way to finish before it gives up.
pub const WAIT_FOR_TASKS: Duration = Duration::from_secs(10 * 60);
const WAIT_STEP: Duration = Duration::from_secs(2);
/// The person's setting and when Ozzie last checked, in the app data folder.
pub const PREFS_FILE: &str = "updates.json";
/// The event the page listens for; it carries the same view as `update_status`.
pub const EVENT: &str = "ozzie:update";

// ---- What may be offered ------------------------------------------------------------------------

/// A strictly newer, released version: never the same, an older one or a pre-release. Build metadata
/// (`+...`) doesn't make a version newer.
pub fn is_newer(current: &Version, offered: &Version) -> bool {
    let plain = |v: &Version| Version {
        build: BuildMetadata::EMPTY,
        ..v.clone()
    };
    offered.pre.is_empty() && plain(offered) > plain(current)
}
/// The version as the page may show it: a parsed version, short, in version characters only.
pub fn shown_version(version: &str) -> Option<String> {
    let parsed = Version::parse(version).ok()?;
    let text = parsed.to_string();
    (text.len() <= 32
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'+')))
    .then_some(text)
}
/// The archive must come from this release's own downloads, as `Ozzie.app.tar.gz`. A debug build
/// pointed at a stand-in feed on this Mac (`dev_feed`) may also download from that same address.
pub fn download_ok(url: &str, dev_feed: Option<&str>) -> bool {
    let from_release = url
        .strip_prefix(DOWNLOAD_PREFIX)
        .and_then(|rest| rest.strip_suffix(ARCHIVE_NAME))
        .and_then(|tag| tag.strip_suffix('/'))
        .is_some_and(|tag| {
            !tag.is_empty()
                && tag.len() <= 40
                && tag
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
        });
    let from_stand_in = dev_feed
        .and_then(|feed| feed.rsplit_once('/'))
        .is_some_and(|(base, _)| {
            url.strip_prefix(base)
                .is_some_and(|rest| rest.starts_with('/'))
        });
    (from_release || from_stand_in) && !url.contains("..") && !url.contains('@')
}

// ---- When to check ---------------------------------------------------------------------------------

/// What the automatic check needs to know.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Schedule {
    pub automatic: bool,
    pub launched_ms: u64,
    pub first_after_ms: u64,
    pub last_attempt_ms: Option<u64>,
    pub last_failed: bool,
    /// A check, download or reopen is already under way.
    pub working: bool,
}
/// Whether an automatic check is due now: shortly after launch, then a day after the last check (three
/// hours after one that failed). A clock set backwards makes it due rather than waiting days.
pub fn check_due(now_ms: u64, s: &Schedule) -> bool {
    if !s.automatic || s.working {
        return false;
    }
    match s.last_attempt_ms {
        None => now_ms >= s.launched_ms.saturating_add(s.first_after_ms),
        Some(last) => {
            let wait = if s.last_failed {
                RETRY_AFTER_MS
            } else {
                CHECK_EVERY_MS
            };
            now_ms < last || now_ms - last >= wait
        }
    }
}
/// Something is under way that a quit would interrupt: a task the ledger still has admitted or
/// running (every Sunday check, Ask question and procedure is one), or a responsibility run.
pub fn busy(tasks: &[TaskRow], run_under_way: bool) -> bool {
    run_under_way || tasks.iter().any(|task| !task.state.terminal())
}

// ---- Where this copy runs --------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Place {
    /// An app bundle Ozzie can replace in place.
    App,
    /// Not inside an app bundle (a developer build run from its build folder): never replaced.
    NotAnApp,
    /// macOS is running this copy from a temporary, read-only place because it was opened where it
    /// was downloaded: it must be moved to Applications first.
    MoveToApplications,
}
/// The app bundle that holds `exe` (`<bundle>.app/Contents/MacOS/<exe>`), if Ozzie may replace it.
pub fn bundle_of(exe: &Path) -> (Place, Option<PathBuf>) {
    let macos = exe.parent();
    let contents = macos.and_then(Path::parent);
    let bundle = contents.and_then(Path::parent);
    let named =
        |p: Option<&Path>, name: &str| p.and_then(Path::file_name).is_some_and(|n| n == name);
    let is_app = named(macos, "MacOS")
        && named(contents, "Contents")
        && bundle
            .and_then(Path::extension)
            .is_some_and(|ext| ext == "app");
    match bundle {
        Some(bundle) if is_app => {
            if bundle
                .components()
                .any(|c| c.as_os_str() == "AppTranslocation")
            {
                (Place::MoveToApplications, None)
            } else {
                (Place::App, Some(bundle.to_path_buf()))
            }
        }
        _ => (Place::NotAnApp, None),
    }
}

// ---- State -----------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    #[default]
    Idle,
    Checking,
    /// A newer version was found and can be installed with the person's click.
    Available,
    Downloading,
    /// Downloaded and checked; waiting for a task under way to finish before reopening.
    Waiting,
    Reopening,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Problem {
    /// "Check for a new version" didn't get an answer (automatic checks never report this).
    CheckFailed,
    /// The download, the check of it, or putting it in place failed; nothing was changed.
    InstallFailed,
    /// Something stayed under way for WAIT_FOR_TASKS, so Ozzie didn't reopen.
    StillBusy,
}
/// What the page shows. Fixed shapes only; the page words each of them itself.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateView {
    /// This copy's version.
    pub current: String,
    pub automatic: bool,
    /// When Ozzie last got an answer (ms since the epoch).
    pub last_checked_ms: Option<u64>,
    pub phase: Phase,
    /// A strictly newer version that can be installed now.
    pub available: Option<String>,
    pub problem: Option<Problem>,
    pub place: Place,
    /// Debug builds only (OZZIE_DEV_UPDATE_AUTOPILOT=1): the page installs as if clicked.
    pub autopilot: bool,
    /// Debug builds only (OZZIE_DEV_UPDATE_PROBE): the stand-in test, which never reads the Keychain.
    pub probe: bool,
}

#[derive(Default)]
struct Inner {
    phase: Phase,
    problem: Option<Problem>,
    found: Option<Update>,
    automatic: bool,
    last_checked_ms: Option<u64>,
    last_attempt_ms: Option<u64>,
    last_failed: bool,
    launched_ms: u64,
}
/// The updater's state, managed once for the app.
#[derive(Default)]
pub struct Updates {
    inner: Mutex<Inner>,
    prefs: OnceLock<PathBuf>,
}
#[derive(Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
struct Prefs {
    automatic: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_checked_ms: Option<u64>,
}
/// The saved setting; on (the default) when nothing readable is saved.
fn read_prefs(path: &Path) -> Prefs {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or(Prefs {
            automatic: true,
            last_checked_ms: None,
        })
}
/// Written whole to a private file and moved into place.
fn write_prefs(path: &Path, prefs: &Prefs) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let partial = path.with_extension("json.partial");
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&partial)?;
    file.write_all(&serde_json::to_vec(prefs).map_err(std::io::Error::other)?)?;
    file.sync_all()?;
    std::fs::rename(partial, path)
}

impl Updates {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
    fn view(&self, current: &str) -> UpdateView {
        let inner = self.lock();
        let available = inner
            .found
            .as_ref()
            .and_then(|update| shown_version(&update.version));
        UpdateView {
            current: current.to_owned(),
            automatic: inner.automatic,
            last_checked_ms: inner.last_checked_ms,
            phase: inner.phase,
            available,
            problem: inner.problem,
            place: here().0,
            autopilot: dev_flag("OZZIE_DEV_UPDATE_AUTOPILOT"),
            probe: probe_file().is_some(),
        }
    }
    fn save(&self) {
        let Some(path) = self.prefs.get() else {
            return;
        };
        let prefs = {
            let inner = self.lock();
            Prefs {
                automatic: inner.automatic,
                last_checked_ms: inner.last_checked_ms,
            }
        };
        // A setting that couldn't be saved holds until Ozzie quits; the next change tries again.
        let _ = write_prefs(path, &prefs);
    }
    fn schedule(inner: &Inner) -> Schedule {
        Schedule {
            automatic: inner.automatic,
            launched_ms: inner.launched_ms,
            first_after_ms: if dev_feed().is_some() {
                5_000
            } else {
                FIRST_CHECK_AFTER_MS
            },
            last_attempt_ms: inner.last_attempt_ms,
            last_failed: inner.last_failed,
            working: matches!(
                inner.phase,
                Phase::Checking | Phase::Downloading | Phase::Waiting | Phase::Reopening
            ),
        }
    }
}

fn current_version(app: &tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}
/// Where this copy runs. The test copy of Ozzie is never an app Ozzie may replace: it never updates itself, so a release
/// can never put the real app's identity in its place (docs/build/test-copy.md, private repository).
fn here() -> (Place, Option<PathBuf>) {
    if ozzie_native_auth::variant::IS_TEST_COPY {
        return (Place::NotAnApp, None);
    }
    match std::env::current_exe() {
        Ok(exe) => bundle_of(&exe),
        Err(_) => (Place::NotAnApp, None),
    }
}
fn emit(app: &tauri::AppHandle) {
    let view = app.state::<Updates>().view(&current_version(app));
    let _ = app.emit(EVENT, view);
}

// ---- Debug builds only -----------------------------------------------------------------------------

/// Debug builds only: a variable that is set to "1".
fn dev_flag(name: &str) -> bool {
    cfg!(debug_assertions) && std::env::var(name).as_deref() == Ok("1")
}
/// Debug builds only: OZZIE_DEV_UPDATE_FEED, a stand-in `latest.json` served on this Mac
/// (`http://127.0.0.1:<port>/...`). A release build always checks FEED, over HTTPS.
fn dev_feed() -> Option<String> {
    if !cfg!(debug_assertions) {
        return None;
    }
    let feed = std::env::var("OZZIE_DEV_UPDATE_FEED").ok()?;
    let rest = feed.strip_prefix("http://127.0.0.1:")?;
    let (port, path) = rest.split_once('/')?;
    (port.parse::<u16>().is_ok()
        && path.ends_with(".json")
        && path
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'-' | b'_' | b'.'))
        && !path.contains(".."))
    .then_some(feed)
}
/// Debug builds only: OZZIE_DEV_UPDATE_PROBE, a file the stand-in test reads what happened from.
fn probe_file() -> Option<PathBuf> {
    if !cfg!(debug_assertions) {
        return None;
    }
    std::env::var_os("OZZIE_DEV_UPDATE_PROBE")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
}
/// Debug builds only: one name-free line for the stand-in test.
fn probe(line: &str) {
    use std::io::Write;
    if let Some(path) = probe_file()
        && let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
    {
        let _ = writeln!(file, "{} {line}", unix_ms());
    }
}

// ---- Checking --------------------------------------------------------------------------------------

/// The plugin with Ozzie's fixed settings on top of tauri.conf.json `plugins.updater` (the public
/// key, `requireSignedVersion`): FEED as the one address (pinned here as well as in the config), only
/// strictly newer versions, a time limit, no proxy, and HTTPS only for the check, its redirect and
/// the download. `feed`: debug builds' stand-in only.
fn configured<R: tauri::Runtime>(
    app: &impl Manager<R>,
    feed: Option<&str>,
) -> Result<tauri_plugin_updater::UpdaterBuilder, ()> {
    let https_only = feed.is_none();
    let builder = app
        .updater_builder()
        .version_comparator(|current, release| is_newer(&current, &release.version))
        .timeout(CHECK_TIMEOUT)
        .no_proxy()
        .configure_client(move |client| client.https_only(https_only));
    builder
        .endpoints(vec![feed.unwrap_or(FEED).parse().map_err(|_| ())?])
        .map_err(|_| ())
}
/// One check. Ok(None) when nothing newer is offered.
async fn fetch(app: &tauri::AppHandle) -> Result<Option<Update>, ()> {
    let feed = dev_feed();
    let found = configured(app, feed.as_deref())?
        .build()
        .map_err(|_| ())?
        .check()
        .await
        .map_err(|_| ())?;
    match found {
        Some(update)
            if shown_version(&update.version).is_some()
                && download_ok(update.download_url.as_str(), feed.as_deref()) =>
        {
            Ok(Some(update))
        }
        // Announced, but not from this release's own downloads: treated as no answer.
        Some(_) => Err(()),
        None => Ok(None),
    }
}
/// A check, automatic or from "Check for a new version". Only one runs at a time, never during a
/// download or reopen. Automatic failures stay silent.
async fn check(app: tauri::AppHandle, manual: bool) {
    // The test copy never asks whether there is a new version (it has no updater at all).
    if ozzie_native_auth::variant::IS_TEST_COPY {
        return;
    }
    let updates = app.state::<Updates>();
    {
        let mut inner = updates.lock();
        if Updates::schedule(&inner).working {
            return;
        }
        inner.phase = Phase::Checking;
        if manual {
            inner.problem = None;
        }
    }
    emit(&app);
    let result = fetch(&app).await;
    let now = unix_ms();
    {
        let mut inner = updates.lock();
        inner.last_attempt_ms = Some(now);
        inner.last_failed = result.is_err();
        match result {
            Ok(found) => {
                inner.last_checked_ms = Some(now);
                probe(&match &found {
                    Some(update) => format!("check: available {}", update.version),
                    None => "check: none".to_owned(),
                });
                inner.phase = if found.is_some() {
                    Phase::Available
                } else {
                    Phase::Idle
                };
                inner.found = found;
                inner.problem = None;
            }
            Err(()) => {
                probe("check: failed");
                inner.phase = if inner.found.is_some() {
                    Phase::Available
                } else {
                    Phase::Idle
                };
                if manual {
                    inner.problem = Some(Problem::CheckFailed);
                }
            }
        }
    }
    updates.save();
    emit(&app);
}
/// On every wake of the native timer (always_on.rs): starts an automatic check when one is due. Never
/// waits: a busy state skips this wake.
pub fn on_wake(app: &tauri::AppHandle, now_ms: u64) {
    if ozzie_native_auth::variant::IS_TEST_COPY {
        return;
    }
    let Some(updates) = app.try_state::<Updates>() else {
        return;
    };
    let due = match updates.inner.try_lock() {
        Ok(inner) => check_due(now_ms, &Updates::schedule(&inner)),
        Err(_) => false,
    };
    if due {
        // Recorded now, so the next wake doesn't start a second one before this one begins.
        updates.lock().last_attempt_ms = Some(now_ms);
        tauri::async_runtime::spawn(check(app.clone(), false));
    }
}

// ---- Installing ------------------------------------------------------------------------------------

fn under_way(app: &tauri::AppHandle) -> bool {
    let tasks = app
        .state::<Ledger>()
        .get()
        .map(|ledger| ledger.list(50))
        .unwrap_or_default();
    busy(&tasks, crate::always_on::run_under_way(app))
}
/// Back to "available" with a problem; nothing was changed.
fn give_up(app: &tauri::AppHandle, problem: Problem) {
    {
        let updates = app.state::<Updates>();
        let mut inner = updates.lock();
        inner.phase = if inner.found.is_some() {
            Phase::Available
        } else {
            Phase::Idle
        };
        inner.problem = Some(problem);
    }
    emit(app);
}
/// Downloads and checks the archive, waits for anything under way, puts the new version in place,
/// then quits and reopens. Each step's failure leaves this copy as it was.
async fn install(app: tauri::AppHandle, update: Update, bundle: PathBuf) {
    let mut update = update;
    update.timeout = Some(DOWNLOAD_TIMEOUT);
    // The plugin checks the bytes against the public key and the announced version before returning them.
    let bytes = match update.download(|_, _| {}, || {}).await {
        Ok(bytes) => bytes,
        Err(_) => {
            probe("install: refused (download or check failed)");
            return give_up(&app, Problem::InstallFailed);
        }
    };
    probe("install: downloaded and checked");
    // Blocking work from here on (waiting, the swap, an administrator prompt if macOS asks for one),
    // off the async threads.
    let worker = app.clone();
    let finished = tauri::async_runtime::spawn_blocking(move || {
        put_in_place(&worker, &update, &bytes, &bundle)
    })
    .await;
    // Ok: it quit, or it already said on the page why it stopped. A panic there changed nothing.
    if finished.is_err() {
        give_up(&app, Problem::InstallFailed);
    }
}
/// Waits for anything under way, swaps the bundle, schedules the reopen and quits. Returns false
/// (after saying why on the page) when it stopped before changing anything.
fn put_in_place(app: &tauri::AppHandle, update: &Update, bytes: &[u8], bundle: &Path) -> bool {
    let mut waited = Duration::ZERO;
    while under_way(app) {
        if waited == Duration::ZERO {
            app.state::<Updates>().inner().lock().phase = Phase::Waiting;
            emit(app);
        }
        if waited >= WAIT_FOR_TASKS {
            probe("install: still busy");
            give_up(app, Problem::StillBusy);
            return false;
        }
        std::thread::sleep(WAIT_STEP);
        waited += WAIT_STEP;
    }
    app.state::<Updates>().inner().lock().phase = Phase::Reopening;
    emit(app);
    // `install` checks the bytes once more before it swaps the bundle.
    if update.install(bytes).is_err() {
        probe("install: refused (couldn't put the new version in place)");
        give_up(app, Problem::InstallFailed);
        return false;
    }
    probe("install: in place, reopening");
    if reopen_after_exit(bundle).is_err() {
        // The new version is in place; it opens the next time Ozzie is opened.
        probe("install: couldn't schedule the reopen");
    }
    app.exit(0);
    true
}
/// Waits (at most 30 seconds) for this copy to exit, so the new one never starts beside it and finds
/// the task ledger held, then opens the bundle through Launch Services with no arguments, so the
/// window shows. Debug builds pass their OZZIE_DEV_UPDATE_* settings on, for the stand-in test.
const REOPEN_SCRIPT: &str = r#"pid="$1"; shift; i=0
while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 300 ]; do sleep 0.1; i=$((i+1)); done
exec /usr/bin/open "$@""#;
fn reopen_after_exit(bundle: &Path) -> std::io::Result<()> {
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    let mut command = Command::new("/bin/sh");
    command
        .arg("-c")
        .arg(REOPEN_SCRIPT)
        .arg("ozzie-reopen")
        .arg(std::process::id().to_string());
    if cfg!(debug_assertions) {
        for (name, value) in std::env::vars().filter(|(n, _)| n.starts_with("OZZIE_DEV_UPDATE_")) {
            command.arg("--env").arg(format!("{name}={value}"));
        }
    }
    command
        .arg(bundle)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .map(|_| ())
}

// ---- Setup and commands ----------------------------------------------------------------------------

/// The updater plugin (configured in tauri.conf.json `plugins.updater`) and this module's state. The test copy of Ozzie
/// has no updater plugin (and no `plugins.updater` in tauri.test-copy.conf.json): only the state the page reads.
pub fn manage(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    if ozzie_native_auth::variant::IS_TEST_COPY {
        return builder.manage(Updates::default());
    }
    builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Updates::default())
}
/// At start: the saved setting, and the launch time the first automatic check counts from.
pub fn setup(app: &tauri::App) {
    let updates = app.state::<Updates>();
    let prefs = app
        .path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join(PREFS_FILE));
    let saved = prefs.as_deref().map(read_prefs).unwrap_or(Prefs {
        automatic: true,
        last_checked_ms: None,
    });
    if let Some(path) = prefs {
        let _ = updates.prefs.set(path);
    }
    {
        let mut inner = updates.lock();
        inner.automatic = saved.automatic;
        inner.last_checked_ms = saved.last_checked_ms;
        inner.launched_ms = unix_ms();
    }
    probe(&format!(
        "launched {} pid={} automatic={} ledger={}",
        app.package_info().version,
        std::process::id(),
        saved.automatic,
        if app.state::<Ledger>().get().is_ok() {
            "open"
        } else {
            "unavailable"
        }
    ));
}

#[tauri::command]
pub fn update_status(app: tauri::AppHandle) -> UpdateView {
    app.state::<Updates>().view(&current_version(&app))
}
/// "Check for a new version": checks now, whatever the automatic setting.
#[tauri::command]
pub async fn update_check(app: tauri::AppHandle) -> Result<UpdateView, ()> {
    check(app.clone(), true).await;
    Ok(update_status(app))
}
/// "Check for new versions automatically", on or off. A check from Settings stays possible.
#[tauri::command]
pub fn update_set_automatic(app: tauri::AppHandle, on: bool) -> UpdateView {
    let updates = app.state::<Updates>();
    updates.lock().automatic = on;
    updates.save();
    emit(&app);
    update_status(app)
}
/// "Update Ozzie and reopen it": the only way anything is installed. Does nothing unless a newer
/// version was found and this copy is an app bundle Ozzie can replace. Returns at once; the page
/// follows the steps through `ozzie:update`.
#[tauri::command]
pub fn update_install(app: tauri::AppHandle) -> UpdateView {
    let (place, bundle) = here();
    let updates = app.state::<Updates>();
    let started = {
        let mut inner = updates.lock();
        match (&inner.found, inner.phase, place, bundle) {
            (Some(update), Phase::Available, Place::App, Some(bundle)) => {
                let update = update.clone();
                inner.phase = Phase::Downloading;
                inner.problem = None;
                Some((update, bundle))
            }
            _ => None,
        }
    };
    if let Some((update, bundle)) = started {
        tauri::async_runtime::spawn(install(app.clone(), update, bundle));
        emit(&app);
    }
    update_status(app)
}

#[cfg(test)]
#[path = "updater_tests.rs"]
mod tests;
