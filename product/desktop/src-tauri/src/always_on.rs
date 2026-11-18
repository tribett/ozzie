//! Ozzie keeps working while its window is closed (owner, 2026-11-14: an always-on helper on the
//! leader's Mac). Everything that makes that so lives here, so main.rs only wires it in:
//!
//!  - a menu bar icon, a template image macOS tints ("Open Ozzie", "Pause everything" / "Resume
//!    everything", "Quit Ozzie");
//!  - closing the window hides it instead of quitting; the Dock icon or the menu brings it back;
//!  - quitting from Ozzie's menu ("Quit Ozzie" in the menu bar icon's menu or the app menu, whose Command-Q is
//!    that item: app_menu.rs) while checks are on or visitor cards are open asks first, in the window (audit items
//!    20 and 23, review P M1; `QuitGuard`); nothing holds any other exit, so logging out, restarting or shutting
//!    down the Mac, Quit from the Dock and a quit for an update never ask;
//!  - App Nap is kept from pausing Ozzie (an NSProcessInfo activity that still lets the Mac sleep),
//!    and the window's web view is configured not to throttle while hidden (tauri.conf.json
//!    `backgroundThrottling: "disabled"`, which needs macOS 14: the bundle's minimum system version);
//!  - a native timer thread wakes the (possibly hidden) page every TICK, sooner when the page says
//!    work is due (never sooner than MIN_DUE_LEAD, and never two due wakes within MIN_DUE_GAP), and
//!    notices when the Mac slept (more wall-clock time than awake time passed); on every wake it
//!    is also the task ledger's watchdog (`sweep_ledger`);
//!  - "Open Ozzie when I log in" (tauri-plugin-autostart, a Launch Agent labelled with the app's
//!    identifier, off unless the person turns it on); opened that way, the window stays hidden;
//!  - the responsibilities store and its commands (core/native-auth responsibilities.rs is the
//!    enforcement point), including the AI step a responsibility run may spend from its grant;
//!  - discreet notifications whose text is fixed here: never a name or a detail (and, while "A notice
//!    on your phone" is on, the same kind's fixed line to the leader's phone: phone_notice.rs).
use crate::{Ledger, SessionNames};
use ozzie_native_auth::agent::{self, AgentError, AgentStepReply};
use ozzie_native_auth::ledger::{StepView, TaskKind, Watchdog};
use ozzie_native_auth::model::{self as model_route, KeychainKeys};
use ozzie_native_auth::phone_notice::Line;
use ozzie_native_auth::responsibilities::{
    Grant, Listing, ResponsibilityError, ResponsibilityRow, ResponsibilityStore,
};
use ozzie_native_auth::sunday_check::unix_ms;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

/// How often the timer thread wakes the page when nothing is due sooner.
pub const TICK: Duration = Duration::from_secs(30);
/// Developer builds with OZZIE_DEV_FAST_SCHEDULE=1 only.
pub const FAST_TICK: Duration = Duration::from_secs(5);
/// A due time the page asks for is never sooner than this from when it asks...
pub const MIN_DUE_LEAD: Duration = Duration::from_secs(1);
/// ...and two wakes for due work are never closer than this, whatever the page asks: a page that
/// keeps asking for "now" costs at most one wake this often, never a busy loop.
pub const MIN_DUE_GAP: Duration = Duration::from_secs(5);
/// This much more wall-clock time than awake time between two wakes means the Mac slept.
pub const SLEPT_AFTER_MS: u64 = 60_000;

/// Debug builds only: OZZIE_DEV_FAST_SCHEDULE=1 (due times minutes apart, a shorter gap between runs).
fn fast_schedule() -> bool {
    cfg!(debug_assertions) && std::env::var("OZZIE_DEV_FAST_SCHEDULE").as_deref() == Ok("1")
}
/// Debug builds only: OZZIE_DEV_BACKGROUND_PROBE=<seconds> hides the window after it loads, keeps it
/// hidden that long, asks the page to report what ran meanwhile, then quits. See `probe`.
fn probe_seconds() -> Option<u64> {
    if !cfg!(debug_assertions) {
        return None;
    }
    std::env::var("OZZIE_DEV_BACKGROUND_PROBE")
        .ok()?
        .parse()
        .ok()
        .filter(|s| (10..=3_600).contains(s))
}

// ---- Sleep and due work ----------------------------------------------------------------------------

/// The Mac slept between two wakes when wall-clock time ran ahead of awake time (`Instant` on macOS
/// doesn't count sleep). A clock set backwards or a short gap is not sleep.
pub fn slept(wall_before_ms: u64, wall_now_ms: u64, awake: Duration) -> Option<u64> {
    let wall = wall_now_ms.checked_sub(wall_before_ms)?;
    let awake = u64::try_from(awake.as_millis()).unwrap_or(u64::MAX);
    wall.checked_sub(awake).filter(|gap| *gap >= SLEPT_AFTER_MS)
}
/// How long to wait before the next wake: the regular tick, or sooner when work is due.
pub fn wait_for(now_ms: u64, next_due_ms: Option<u64>, tick: Duration) -> Duration {
    match next_due_ms {
        Some(due) => tick.min(Duration::from_millis(due.saturating_sub(now_ms))),
        None => tick,
    }
}
/// What the page receives on every wake ("ozzie:tick").
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct TickEvent {
    pub at_ms: u64,
    /// The time the page asked to be woken for has come.
    pub due: bool,
    /// The Mac slept this long since the last wake ("ozzie:wake" is sent as well).
    pub slept_ms: Option<u64>,
}

#[derive(Default)]
struct TimerState {
    next_due_ms: Option<u64>,
    /// When the last wake for due work happened (wall clock).
    last_due_ms: Option<u64>,
    stop: bool,
}
/// The timer thread's shared state: when the page wants to be woken next, and whether to stop.
pub struct Timer {
    state: Mutex<TimerState>,
    changed: Condvar,
    lead_ms: u64,
    gap_ms: u64,
}
impl Default for Timer {
    fn default() -> Self {
        Self::with_limits(MIN_DUE_LEAD, MIN_DUE_GAP)
    }
}
impl Timer {
    fn with_limits(lead: Duration, gap: Duration) -> Self {
        Self {
            state: Mutex::default(),
            changed: Condvar::new(),
            lead_ms: u64::try_from(lead.as_millis()).unwrap_or(u64::MAX),
            gap_ms: u64::try_from(gap.as_millis()).unwrap_or(u64::MAX),
        }
    }
    /// The page's next due time, never sooner than MIN_DUE_LEAD from now.
    fn set_next_due(&self, at_ms: Option<u64>) {
        let earliest = unix_ms().saturating_add(self.lead_ms);
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .next_due_ms = at_ms.map(|at| at.max(earliest));
        self.changed.notify_all();
    }
    /// When due work may wake the page: the page's time, but never within MIN_DUE_GAP of the last
    /// such wake (a clock set backwards counts that wake as now).
    fn due_at(&self, state: &TimerState, now_ms: u64) -> Option<u64> {
        let after_gap = state
            .last_due_ms
            .map_or(0, |last| last.min(now_ms).saturating_add(self.gap_ms));
        state.next_due_ms.map(|due| due.max(after_gap))
    }
    pub fn stop(&self) {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).stop = true;
        self.changed.notify_all();
    }
    /// Waits until the next wake. None when stopping.
    fn next(&self, tick: Duration) -> Option<TickEvent> {
        let (wall_before, awake_from) = (unix_ms(), Instant::now());
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            if state.stop {
                return None;
            }
            let now = unix_ms();
            let due_at = self.due_at(&state, now);
            let due = due_at.is_some_and(|d| now >= d);
            let waited = awake_from.elapsed();
            if due || waited >= tick || now.saturating_sub(wall_before) >= tick.as_millis() as u64 {
                if due {
                    // The page sets the next one after it has run what was due.
                    state.next_due_ms = None;
                    state.last_due_ms = Some(now);
                }
                return Some(TickEvent {
                    at_ms: now,
                    due,
                    slept_ms: slept(wall_before, now, waited),
                });
            }
            let wait = wait_for(now, due_at, tick.saturating_sub(waited));
            state = self
                .changed
                .wait_timeout(state, wait.max(Duration::from_millis(50)))
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
    }
}
/// The watchdog (build contract §2.4: independent of the worker it watches), on every wake before
/// the page hears of it: ledger tasks stuck past their ceiling are ended (`Watchdog::sweep`). It
/// runs on this thread, not in the page, because a page that reloaded or stopped is what leaves a
/// task running. It never stalls or ends this thread: a busy ledger skips the wake, and a panic is
/// contained so the next wake still comes. What happened reads the ledger every few seconds while
/// open, so it shows the change. Returns how many it ended; None when nothing was swept.
fn sweep_ledger(watchdog: &mut Watchdog, ledger: &Ledger) -> Option<usize> {
    let ledger = ledger.get().ok()?;
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| watchdog.sweep(&ledger)))
        .ok()
        .flatten()
}
fn spawn_timer(app: tauri::AppHandle, timer: Arc<Timer>, tick: Duration) {
    std::thread::spawn(move || {
        let mut watchdog = Watchdog::default();
        while let Some(event) = timer.next(tick) {
            sweep_ledger(&mut watchdog, &app.state::<Ledger>());
            // An automatic check for a new version of Ozzie, when one is due (updater.rs). Never waits.
            crate::updater::on_wake(&app, event.at_ms);
            if let Some(ms) = event.slept_ms {
                let _ = app.emit(
                    "ozzie:wake",
                    serde_json::json!({ "slept_ms": ms, "at_ms": event.at_ms }),
                );
            }
            let _ = app.emit("ozzie:tick", event);
        }
    });
}

// ---- App Nap ---------------------------------------------------------------------------------------

/// Keeps App Nap from pausing Ozzie's timers while its window is hidden. The Mac can still sleep
/// normally (missed checks are then caught up once, after it wakes). Held for the app's lifetime.
#[cfg(target_os = "macos")]
fn keep_checks_running() {
    use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};
    let activity = NSProcessInfo::processInfo().beginActivityWithOptions_reason(
        NSActivityOptions::UserInitiatedAllowingIdleSystemSleep,
        &NSString::from_str("Ozzie checks what you asked it to keep an eye on."),
    );
    // Ending the activity would let App Nap back in; it lasts until Ozzie quits.
    std::mem::forget(activity);
}
#[cfg(not(target_os = "macos"))]
fn keep_checks_running() {}

// ---- Window, menu bar and Dock ---------------------------------------------------------------------

pub const MENU_OPEN: &str = "Open Ozzie";
pub const MENU_PAUSE: &str = "Pause everything";
pub const MENU_RESUME: &str = "Resume everything";
pub const MENU_QUIT: &str = crate::app_menu::QUIT_TEXT;
/// The one notice the menu bar shows itself: "Pause everything" couldn't be changed (the list of
/// what Ozzie keeps an eye on couldn't be read or saved). Fixed, discreet, no details.
pub const PAUSE_FAILED: &str =
    "Ozzie couldn't change Pause everything just now. Open Ozzie to try again.";
/// The menu bar icon: a black-and-clear silhouette of Ozzie's icon that macOS tints to match the
/// menu bar (a template image), 44 pixels for the 22-point menu bar at 2x.
const TRAY_ICON: tauri::image::Image<'static> = tauri::include_image!("./icons/tray-template.png");
pub fn pause_label(paused: bool) -> &'static str {
    if paused { MENU_RESUME } else { MENU_PAUSE }
}

/// The menu item that pauses or resumes everything, so its words follow the store.
struct PauseItem(Mutex<Option<tauri::menu::MenuItem<tauri::Wry>>>);

pub(crate) fn show_main<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        let _ = app.emit("ozzie:shown", ());
    }
}
/// Back from the browser (a sign-in or Ozzie's AI's connect ended; onboarding spec S4): the window comes forward,
/// and the Dock icon bounces once in case macOS keeps the browser in front (cooperative activation, macOS 14+).
pub(crate) fn bring_forward<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    show_main(app);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.request_user_attention(Some(tauri::UserAttentionType::Informational));
    }
}
fn set_paused_everywhere<R: tauri::Runtime>(app: &tauri::AppHandle<R>, paused: bool) {
    if let Some(item) = app
        .state::<PauseItem>()
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
    {
        let _ = item.set_text(pause_label(paused));
    }
    let _ = app.emit("ozzie:paused", serde_json::json!({ "paused": paused }));
}
fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::TrayIconBuilder;
    let paused = app
        .state::<Responsibilities>()
        .get()
        .is_ok_and(|s| s.paused_all());
    let open = MenuItem::with_id(app, "open", MENU_OPEN, true, None::<&str>)?;
    let pause = MenuItem::with_id(app, "pause", pause_label(paused), true, None::<&str>)?;
    let quit = MenuItem::with_id(app, crate::app_menu::QUIT_ID, MENU_QUIT, true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[&open, &pause, &PredefinedMenuItem::separator(app)?, &quit],
    )?;
    *app.state::<PauseItem>()
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = Some(pause);
    TrayIconBuilder::with_id("ozzie")
        .tooltip("Ozzie")
        .icon(TRAY_ICON)
        .icon_as_template(true)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .build(app)?;
    Ok(())
}
/// What a menu item does: the menu bar icon's three, and the app menu's "Quit Ozzie" (Command-Q), which shares the
/// menu bar's id. Every other app menu item is the system's own (Hide, Copy, Close Window...) and never comes here.
#[derive(Debug, PartialEq, Eq)]
enum MenuAction {
    Open,
    Pause,
    Quit,
}
fn menu_action(id: &str) -> Option<MenuAction> {
    match id {
        "open" => Some(MenuAction::Open),
        "pause" => Some(MenuAction::Pause),
        crate::app_menu::QUIT_ID => Some(MenuAction::Quit),
        _ => None,
    }
}
/// Every menu's clicks, the menu bar icon's and the app menu's: Tauri gives one handler all of them, so there is
/// exactly one (installed by `manage` through app_menu::install), and a click never runs twice. Tests drive this very
/// function with Tauri's own MenuEvent on a mock app (review G, L-b).
fn on_menu_event<R: tauri::Runtime>(app: &tauri::AppHandle<R>, event: tauri::menu::MenuEvent) {
    match menu_action(event.id().as_ref()) {
        Some(MenuAction::Open) => show_main(app),
        Some(MenuAction::Pause) => toggle_pause_from_menu(app),
        Some(MenuAction::Quit) => request_quit(app),
        None => {}
    }
}
/// "Pause everything" / "Resume everything" from the menu bar. When the store can't be read or
/// written, nothing changes and a quiet fixed notice says so (never a silent no-op).
fn toggle_pause_from_menu(app: &tauri::AppHandle<impl tauri::Runtime>) {
    let changed = app
        .state::<Responsibilities>()
        .get()
        .and_then(|store| store.pause_all(!store.paused_all()));
    match changed {
        Ok(listing) => set_paused_everywhere(app, listing.paused_all),
        Err(_) => {
            use tauri_plugin_notification::NotificationExt;
            let _ = app
                .notification()
                .builder()
                .title(NOTICE_TITLE)
                .body(PAUSE_FAILED)
                .show();
        }
    }
}

/// The main window starts hidden (tauri.conf.json `"visible": false`). Opened at login, Ozzie stays in
/// the menu bar with it hidden; any other launch shows it once the page has loaded.
pub fn on_page_load(window: &tauri::Webview) {
    if shows_window_at_launch(std::env::args()) {
        let _ = window.window().show();
    }
}
pub fn shows_window_at_launch(mut args: impl Iterator<Item = String>) -> bool {
    !args.any(|arg| arg == AT_LOGIN)
}
/// The argument the login item starts Ozzie with.
pub const AT_LOGIN: &str = "--at-login";
/// The Launch Agent's label and file name (~/Library/LaunchAgents/church.ozzie.desktop.plist): the
/// app's own reverse-DNS identifier (tauri.conf.json `identifier`, pinned by a test).
pub const LAUNCH_AGENT_LABEL: &str = "church.ozzie.desktop";
/// Closing the window hides it; Ozzie keeps running in the menu bar. "Quit Ozzie" quits.
pub fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if let tauri::WindowEvent::CloseRequested { api, .. } = event
        && window.label() == "main"
    {
        api.prevent_close();
        let _ = window.hide();
    }
}
// ---- Asking before quitting (audit items 20 and 23) ----------------------------------------------------

/// What quitting would stop or lose, as the page last said it: how many visitor cards are open (a count only; their
/// words never leave the page) and whether the regular Sunday check or any job is on. Nothing else is told or kept.
#[derive(Default)]
pub struct QuitGuard {
    cards: AtomicU32,
    checks: AtomicBool,
    /// When the window last asked: a second quit while the question is open quits, so Ozzie never traps anyone.
    asked: Mutex<Option<Instant>>,
}
/// How long a question about quitting counts as open for a second quit to go ahead.
pub const ASKED_FOR: Duration = Duration::from_secs(60);
/// The most cards a count can say (the review holds at most 8; anything larger is the page's mistake).
const MAX_CARDS: u32 = 99;
impl QuitGuard {
    /// What to ask about, or None to quit at once: nothing would stop or be lost, or a quit was already asked about
    /// within ASKED_FOR (then the second quit goes ahead).
    pub fn ask(&self, now: Instant) -> Option<(u32, bool)> {
        let cards = self.cards.load(Ordering::SeqCst);
        let checks = self.checks.load(Ordering::SeqCst);
        if cards == 0 && !checks {
            return None;
        }
        let mut asked = self.asked.lock().unwrap_or_else(|e| e.into_inner());
        if asked.is_some_and(|at| now.duration_since(at) < ASKED_FOR) {
            return None;
        }
        *asked = Some(now);
        Some((cards, checks))
    }
    pub fn set(&self, cards: u32, checks: bool) {
        self.cards.store(cards.min(MAX_CARDS), Ordering::SeqCst);
        self.checks.store(checks, Ordering::SeqCst);
    }
    fn answered(&self) {
        *self.asked.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}
/// The window's question about quitting: counts only.
fn quit_asked(cards: u32, checks: bool) -> serde_json::Value {
    serde_json::json!({ "cards": cards, "checks": checks })
}
fn ask_in_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>, cards: u32, checks: bool) {
    show_main(app);
    let _ = app.emit("ozzie:quit-asked", quit_asked(cards, checks));
}
/// "Quit Ozzie" from the menu bar icon or the app menu (Command-Q): asks in the window first when that would stop
/// checks or lose cards.
fn request_quit<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    match app.state::<QuitGuard>().ask(Instant::now()) {
        Some((cards, checks)) => ask_in_window(app, cards, checks),
        None => app.exit(0),
    }
}
/// The page says what quitting would stop or lose: how many visitor cards are open, and whether checks are on.
#[tauri::command]
pub fn quit_guard_set(guard: tauri::State<'_, QuitGuard>, cards: u32, checks: bool) {
    guard.set(cards, checks);
}
/// The leader's "Quit Ozzie" (or "Quit and discard them") in the window's question: quits now.
#[tauri::command]
pub fn quit_now(app: tauri::AppHandle) {
    app.exit(0);
}
/// The leader's "Keep Ozzie running": the question is closed, so the next quit asks again.
#[tauri::command]
pub fn quit_kept(guard: tauri::State<'_, QuitGuard>) {
    guard.answered();
}

/// The Dock icon (or opening Ozzie again) brings the hidden window back. No exit is ever held here: the question is
/// asked before an exit starts (`request_quit`), so logging out, restarting or shutting down the Mac, Quit from the
/// Dock, an update and the debug probe all go ahead.
pub fn on_run_event(app: &tauri::AppHandle, event: &tauri::RunEvent) {
    #[cfg(target_os = "macos")]
    if let tauri::RunEvent::Reopen {
        has_visible_windows: false,
        ..
    } = event
    {
        show_main(app);
    }
    if matches!(
        event,
        tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
    ) {
        app.state::<Background>().timer.stop();
    }
}

// ---- State and setup -------------------------------------------------------------------------------

/// The responsibilities store in this Mac's app data folder, opened once at start.
#[derive(Default)]
pub struct Responsibilities(OnceLock<Option<Arc<ResponsibilityStore>>>);
impl Responsibilities {
    fn get(&self) -> Result<Arc<ResponsibilityStore>, ResponsibilityError> {
        self.0
            .get()
            .cloned()
            .flatten()
            .ok_or(ResponsibilityError::Unavailable)
    }
}
/// Whether a responsibility run is under way: updater.rs waits for it to end before reopening Ozzie.
pub fn run_under_way(app: &tauri::AppHandle) -> bool {
    app.state::<Responsibilities>()
        .get()
        .and_then(|store| store.list())
        .is_ok_and(|listing| listing.items.iter().any(|r| r.open_run.is_some()))
}
#[derive(Default)]
pub struct Background {
    timer: Arc<Timer>,
}
/// Everything managed here, for main.rs to add in one place.
pub fn manage(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    // The app menu replaces the framework's default, whose Quit would end Ozzie with no question (app_menu.rs).
    crate::app_menu::install(builder, on_menu_event)
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .macos_launcher(tauri_plugin_autostart::MacosLauncher::LaunchAgent)
                .args([AT_LOGIN])
                .app_name(LAUNCH_AGENT_LABEL)
                .build(),
        )
        .manage(Responsibilities::default())
        .manage(Background::default())
        .manage(PauseItem(Mutex::new(None)))
        .manage(QuitGuard::default())
}
/// At start: open the store, keep App Nap away, add the menu bar icon and start the timer thread.
pub fn setup(app: &mut tauri::App) -> tauri::Result<()> {
    let store = app
        .path()
        .app_data_dir()
        .ok()
        .map(|dir| Arc::new(ResponsibilityStore::open(&dir, fast_schedule())));
    let _ = app.state::<Responsibilities>().0.set(store);
    keep_checks_running();
    build_tray(app)?;
    let tick = if fast_schedule() { FAST_TICK } else { TICK };
    spawn_timer(
        app.handle().clone(),
        app.state::<Background>().timer.clone(),
        tick,
    );
    if let Some(seconds) = probe_seconds() {
        probe(app.handle().clone(), seconds);
    }
    Ok(())
}

/// Debug builds only: proves a hidden window keeps running scheduled work. Hides the window a few
/// seconds after start, keeps it hidden for `seconds`, then asks the page to report (name-free counts,
/// through dev_log) and quits.
fn probe(app: tauri::AppHandle, seconds: u64) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(5));
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.hide();
        }
        println!("background-probe: window hidden for {seconds}s");
        let _ = app.emit("ozzie:probe", serde_json::json!({ "phase": "hidden" }));
        std::thread::sleep(Duration::from_secs(seconds));
        let _ = app.emit("ozzie:probe", serde_json::json!({ "phase": "report" }));
        std::thread::sleep(Duration::from_secs(3));
        println!("background-probe: done");
        app.exit(0);
    });
}

// ---- Commands --------------------------------------------------------------------------------------

/// Debug-only settings the page needs: a fast schedule, the probe. Release builds: all off.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundInfo {
    fast_schedule: bool,
    probe: bool,
    tick_ms: u64,
}
#[tauri::command]
pub fn background_info() -> BackgroundInfo {
    let fast = fast_schedule();
    BackgroundInfo {
        fast_schedule: fast,
        probe: probe_seconds().is_some(),
        tick_ms: if fast { FAST_TICK } else { TICK }.as_millis() as u64,
    }
}
/// When the page next has work due (ms since the epoch), so the timer wakes it then; null for none.
#[tauri::command]
pub fn background_next_due(background: tauri::State<'_, Background>, at_ms: Option<u64>) {
    background.timer.set_next_due(at_ms);
}

/// Whether Ozzie opens when this person logs in to the Mac.
#[tauri::command]
pub fn autostart_get(app: tauri::AppHandle) -> Result<bool, &'static str> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch()
        .is_enabled()
        .map_err(|_| "autostart-unavailable")
}
/// Turns "Open Ozzie when I log in" on or off. Only ever on a person's choice.
///
/// The Launch Agent records the path of the binary that turned it on. Turned on from a developer
/// build (`target/debug/ozzie-desktop`), it starts THAT binary at login — not an installed Ozzie.app
/// — until it is turned off again or turned on from the installed app. A Launch Agent written by an
/// earlier build under the old label (~/Library/LaunchAgents/Ozzie.plist) is not removed by this one.
#[tauri::command]
pub fn autostart_set(app: tauri::AppHandle, enabled: bool) -> Result<bool, &'static str> {
    use tauri_plugin_autostart::ManagerExt;
    let launcher = app.autolaunch();
    let result = if enabled {
        launcher.enable()
    } else {
        launcher.disable()
    };
    result.map_err(|_| "autostart-unavailable")?;
    launcher.is_enabled().map_err(|_| "autostart-unavailable")
}

/// Lock-screen privacy: every notice Ozzie shows for a responsibility. Fixed here; never names or details.
pub const NOTICE_TITLE: &str = "Ozzie";
pub fn notice_body(kind: &str) -> Option<&'static str> {
    Some(match kind {
        "briefing-ready" => "Your morning briefing is ready.",
        "needs-decision" => {
            "Something Ozzie is keeping an eye on needs a decision. Open Ozzie to see it."
        }
        "checked" => "Ozzie finished a check you asked for. Open Ozzie to see what it found.",
        "couldnt-check" => "Ozzie couldn't finish a check. Open Ozzie to see what happened.",
        _ => return None,
    })
}
/// The page names which fixed notice to show and passes no text. While "A notice on your phone" is on,
/// the same kind's fixed line also goes to the leader's phone (phone_notice.rs), after this one, unless
/// the page says it stays on this Mac (`local_only`: a notice only about a background check).
#[tauri::command]
pub fn notify_ozzie(
    app: tauri::AppHandle,
    kind: String,
    local_only: Option<bool>,
) -> Result<(), &'static str> {
    use tauri_plugin_notification::NotificationExt;
    let body = notice_body(&kind).ok_or("invalid")?;
    let shown = app
        .notification()
        .builder()
        .title(NOTICE_TITLE)
        .body(body)
        .show()
        .map_err(|_| "notification-unavailable");
    if let Some(line) = Line::for_notice(&kind) {
        crate::phone_notice::also_to_phone(&app, line, local_only);
    }
    shown
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, ResponsibilityError> + Send + 'static,
) -> Result<T, ResponsibilityError> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| ResponsibilityError::Unavailable)?
}
#[tauri::command]
pub async fn responsibility_list(
    store: tauri::State<'_, Responsibilities>,
) -> Result<Listing, ResponsibilityError> {
    let store = store.get()?;
    blocking(move || store.list()).await
}
/// A new responsibility from a plan the person just confirmed ("Looks good — start it").
#[tauri::command]
pub async fn responsibility_create(
    store: tauri::State<'_, Responsibilities>,
    plan: serde_json::Value,
) -> Result<ResponsibilityRow, ResponsibilityError> {
    let store = store.get()?;
    blocking(move || store.create(plan)).await
}
#[tauri::command]
pub async fn responsibility_edit(
    store: tauri::State<'_, Responsibilities>,
    id: String,
    plan: serde_json::Value,
) -> Result<ResponsibilityRow, ResponsibilityError> {
    let store = store.get()?;
    blocking(move || store.edit(&id, plan)).await
}
#[tauri::command]
pub async fn responsibility_pause(
    store: tauri::State<'_, Responsibilities>,
    id: String,
) -> Result<ResponsibilityRow, ResponsibilityError> {
    let store = store.get()?;
    blocking(move || store.pause(&id)).await
}
#[tauri::command]
pub async fn responsibility_resume(
    store: tauri::State<'_, Responsibilities>,
    id: String,
) -> Result<ResponsibilityRow, ResponsibilityError> {
    let store = store.get()?;
    blocking(move || store.resume(&id)).await
}
#[tauri::command]
pub async fn responsibility_stop(
    store: tauri::State<'_, Responsibilities>,
    id: String,
) -> Result<ResponsibilityRow, ResponsibilityError> {
    let store = store.get()?;
    blocking(move || store.stop(&id)).await
}
/// "Pause everything" from the page; the menu bar item follows.
#[tauri::command]
pub async fn responsibility_pause_all(
    store: tauri::State<'_, Responsibilities>,
    app: tauri::AppHandle,
    paused: bool,
) -> Result<Listing, ResponsibilityError> {
    let store = store.get()?;
    let listing = blocking(move || store.pause_all(paused)).await?;
    set_paused_everywhere(&app, listing.paused_all);
    Ok(listing)
}
/// The enforcement point: a grant for one run, or why not.
#[tauri::command]
pub async fn responsibility_run_begin(
    store: tauri::State<'_, Responsibilities>,
    id: String,
    trigger: String,
) -> Result<Grant, ResponsibilityError> {
    let store = store.get()?;
    blocking(move || store.run_begin(&id, &trigger)).await
}
#[tauri::command]
pub async fn responsibility_run_end(
    store: tauri::State<'_, Responsibilities>,
    id: String,
    run_id: String,
    outcome: String,
    code: Option<String>,
    noticed: u32,
    drafts: u32,
) -> Result<ResponsibilityRow, ResponsibilityError> {
    let store = store.get()?;
    blocking(move || store.run_end(&id, &run_id, &outcome, code.as_deref(), noticed, drafts)).await
}
/// What must hold before a responsibility run's grant pays for an AI step, in order: the ledger task
/// is a running procedure (not a question), the step could be sent now (`config`, `step_route`: an
/// AI route set up and, on a model on this Mac, time left in the task's run; nothing is spent on a
/// step that could never be sent), and then the store pays — only for the run's own template's
/// procedure, within its grant and the template's day, and never while it or everything is paused.
pub fn pay_for_step<C>(
    store: &ResponsibilityStore,
    run_id: &str,
    view: &StepView,
    config: impl FnOnce() -> Result<C, AgentError>,
) -> Result<C, AgentError> {
    if view.kind != TaskKind::Skill {
        return Err(AgentError::InvalidTask);
    }
    let config = config()?;
    store
        .take_ai_step(run_id, &view.skill_id)
        .map_err(|error| match error {
            ResponsibilityError::Invalid => AgentError::InvalidTask,
            _ => AgentError::Limit,
        })?;
    Ok(config)
}
/// The route a job's step goes on, once it could be sent now: an AI route set up (`not-configured`
/// otherwise) and, on a model on this Mac, time left in the task's run (`agent::time_left`:
/// `provider-failure` with none). Asked before the grant pays, so a step agent_step would refuse
/// for lack of time spends nothing (review L-1).
fn step_route(
    dir: &std::path::Path,
    ledger: &ozzie_native_auth::ledger::TaskLedger,
    task_id: &str,
) -> Result<model_route::RouteConfig, AgentError> {
    let config = model_route::usable_config(dir).ok_or(AgentError::NotConfigured)?;
    agent::time_left(&config, ledger, task_id)?;
    Ok(config)
}
/// One AI step of a responsibility run: the request passes every agent_step check first, then
/// `pay_for_step` (refused as `invalid-task` for another task's procedure, `not-configured` or, on a
/// model on this Mac with no time left, `provider-failure` before anything is spent, `limit` past the
/// grant or while paused), then it goes through agent_step itself (the same route, keys, name guard,
/// per-task cap and paid call cap as any task).
#[tauri::command]
pub async fn responsibility_agent_step(
    names: tauri::State<'_, SessionNames>,
    ledger: tauri::State<'_, Ledger>,
    store: tauri::State<'_, Responsibilities>,
    app: tauri::AppHandle,
    run_id: String,
    request: agent::Json,
) -> Result<AgentStepReply, AgentError> {
    let names = names.inner().snapshot();
    let ledger = ledger.get().map_err(|_| AgentError::LedgerUnavailable)?;
    let store = store.get().map_err(|_| AgentError::Limit)?;
    tauri::async_runtime::spawn_blocking(move || {
        let request = agent::parse_request(request)?;
        // Every agent_step check against the task as the ledger holds it, before the grant pays.
        let view = ledger.step_view(&request.task_id)?;
        agent::check_step(&request, &names, &view)?;
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|_| AgentError::NotConfigured)?;
        let config = pay_for_step(&store, &run_id, &view, || {
            step_route(&dir, &ledger, &request.task_id)
        })?;
        agent::agent_step(
            &config,
            &dir.join(model_route::LEDGER_FILE),
            &request,
            &KeychainKeys,
            &names,
            &ledger,
        )
    })
    .await
    .map_err(|_| AgentError::ProviderFailure)?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quitting_asks_only_when_checks_are_on_or_cards_are_open_and_never_traps_anyone() {
        let guard = QuitGuard::default();
        let t0 = Instant::now();
        // Nothing would stop or be lost: quit at once.
        assert_eq!(guard.ask(t0), None);
        guard.set(2, false);
        assert_eq!(guard.ask(t0), Some((2, false)));
        // A second quit while the question is open goes ahead.
        assert_eq!(guard.ask(t0 + Duration::from_secs(5)), None);
        // After "Keep Ozzie running", the next quit asks again.
        guard.answered();
        guard.set(0, true);
        assert_eq!(guard.ask(t0 + Duration::from_secs(6)), Some((0, true)));
        // A question left open longer than ASKED_FOR is asked again.
        assert_eq!(
            guard.ask(t0 + Duration::from_secs(6) + ASKED_FOR),
            Some((0, true))
        );
        // A count past the review's own limit is held to the most it can say.
        guard.set(u32::MAX, true);
        guard.answered();
        assert_eq!(guard.ask(t0), Some((MAX_CARDS, true)));
    }

    /// Review F L-7, review G L-b: the installed handler itself, given Tauri's own MenuEvent, on a mock app with the main
    /// window, the question's guard and a responsibilities store of its own. A handler that ignores clicks fails here.
    #[test]
    fn a_menu_click_reaches_what_it_names_and_quit_asks_through_the_guard() {
        use tauri::Listener;
        // The responsibilities store Pause everything changes, in a folder of its own.
        let dir = std::env::temp_dir().join(format!(
            "ozzie-always-on-menu-{}-{}",
            std::process::id(),
            unix_ms()
        ));
        let store = Responsibilities::default();
        let _ = store
            .0
            .set(Some(Arc::new(ResponsibilityStore::open(&dir, false))));
        let app = tauri::test::mock_builder()
            .manage(QuitGuard::default())
            .manage(store)
            .manage(PauseItem(Mutex::new(None)))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::default())
            .build()
            .unwrap();
        let heard = Arc::new(Mutex::new(Vec::<(&'static str, String)>::new()));
        for name in ["ozzie:quit-asked", "ozzie:shown", "ozzie:paused"] {
            let heard = heard.clone();
            app.listen(name, move |e| {
                heard.lock().unwrap().push((name, e.payload().to_string()))
            });
        }
        let handle = app.handle();
        // A click, as Tauri hands it to the installed handler.
        let click = |id: &str| {
            on_menu_event(
                handle,
                tauri::menu::MenuEvent {
                    id: tauri::menu::MenuId::new(id),
                },
            )
        };
        let said = |heard: &Arc<Mutex<Vec<(&'static str, String)>>>| {
            heard.lock().unwrap().drain(..).collect::<Vec<_>>()
        };

        // "Quit Ozzie" (the menu bar's, or the app menu's Command-Q) with cards open: the window is shown and asked.
        app.state::<QuitGuard>().set(2, true);
        click(crate::app_menu::QUIT_ID);
        assert_eq!(
            said(&heard),
            vec![
                ("ozzie:shown", "null".to_string()),
                (
                    "ozzie:quit-asked",
                    r#"{"cards":2,"checks":true}"#.to_string()
                )
            ]
        );
        // The question is open, so the next Quit within ASKED_FOR goes ahead: the click was asked about once.
        assert_eq!(app.state::<QuitGuard>().ask(Instant::now()), None);
        app.state::<QuitGuard>().answered();
        // "Open Ozzie" shows the window; "Pause everything" pauses; anything else does nothing.
        click("open");
        assert_eq!(said(&heard), vec![("ozzie:shown", "null".to_string())]);
        click("pause");
        assert_eq!(
            said(&heard),
            vec![("ozzie:paused", r#"{"paused":true}"#.to_string())]
        );
        let paused_all = |app: &tauri::App<tauri::test::MockRuntime>| {
            app.state::<Responsibilities>().get().unwrap().paused_all()
        };
        assert!(paused_all(&app));
        click("pause");
        assert_eq!(
            said(&heard),
            vec![("ozzie:paused", r#"{"paused":false}"#.to_string())]
        );
        click("not-ours");
        assert_eq!(said(&heard), vec![]);
        assert!(!paused_all(&app));
        assert_eq!(
            app.state::<QuitGuard>().ask(Instant::now()),
            Some((2, true))
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Review F, L-7: the app installs its own menu and its one click handler, exactly once, and nothing else in the app
    /// sets a menu or a menu handler. Read as Rust reads it (syn), since the menu can only be built on the main thread
    /// and `manage` builds the real app; tests/app_menu.rs builds `app_menu::install` itself and reads AppKit's menu.
    #[test]
    fn manage_installs_the_app_menu_and_its_one_click_handler_and_nothing_else_does() {
        use syn::visit::Visit;
        #[derive(Default)]
        struct Calls {
            /// `path(args)` calls, as "path(arg, arg)" with whitespace removed.
            fns: Vec<String>,
            /// Method calls by name, with their arguments.
            methods: Vec<(String, String)>,
        }
        impl<'a> Visit<'a> for Calls {
            fn visit_expr_call(&mut self, c: &'a syn::ExprCall) {
                if let syn::Expr::Path(p) = &*c.func {
                    let path = p
                        .path
                        .segments
                        .iter()
                        .map(|s| s.ident.to_string())
                        .collect::<Vec<_>>()
                        .join("::");
                    let args = c.args.iter().map(arg).collect::<Vec<_>>().join(",");
                    self.fns.push(format!("{path}({args})"));
                }
                syn::visit::visit_expr_call(self, c);
            }
            fn visit_expr_method_call(&mut self, m: &'a syn::ExprMethodCall) {
                let args = m.args.iter().map(arg).collect::<Vec<_>>().join(",");
                self.methods.push((m.method.to_string(), args));
                syn::visit::visit_expr_method_call(self, m);
            }
        }
        fn arg(e: &syn::Expr) -> String {
            match e {
                syn::Expr::Path(p) => p
                    .path
                    .segments
                    .iter()
                    .map(|s| s.ident.to_string())
                    .collect::<Vec<_>>()
                    .join("::"),
                syn::Expr::Closure(_) => "closure".into(),
                syn::Expr::Reference(r) => format!("&{}", arg(&r.expr)),
                _ => "expr".into(),
            }
        }
        let read = |file: &str| {
            let source = std::fs::read_to_string(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("src")
                    .join(file),
            )
            .unwrap();
            syn::parse_file(&source).unwrap()
        };
        let calls_in = |items: &[syn::Item], skip_tests: bool| {
            let mut calls = Calls::default();
            for item in items {
                if skip_tests
                    && let syn::Item::Mod(m) = item
                    && m.ident == "tests"
                {
                    continue;
                }
                calls.visit_item(item);
            }
            calls
        };
        // `manage` installs both, once, through the one function the integration test builds.
        let always = read("always_on.rs");
        let manage = always
            .items
            .iter()
            .find_map(|i| match i {
                syn::Item::Fn(f) if f.sig.ident == "manage" => Some(syn::Item::Fn(f.clone())),
                _ => None,
            })
            .unwrap();
        let in_manage = calls_in(std::slice::from_ref(&manage), false);
        assert_eq!(
            in_manage
                .fns
                .iter()
                .filter(|c| c.starts_with("crate::app_menu::install("))
                .collect::<Vec<_>>(),
            vec!["crate::app_menu::install(builder,on_menu_event)"]
        );
        // main.rs builds the app through `manage`, once.
        let main = calls_in(&read("main.rs").items, true);
        assert_eq!(
            main.fns
                .iter()
                .filter(|c| c.starts_with("always_on::manage("))
                .count(),
            1
        );
        // `install` sets the built menu and the given handler, once each.
        let menu = read("app_menu.rs");
        let in_install = calls_in(&menu.items, false);
        assert_eq!(
            in_install
                .methods
                .iter()
                .filter(|(m, _)| m == "on_menu_event")
                .collect::<Vec<_>>(),
            vec![&("on_menu_event".to_string(), "on_click".to_string())]
        );
        assert_eq!(
            in_install
                .methods
                .iter()
                .filter(|(m, _)| m == "menu")
                .collect::<Vec<_>>(),
            vec![&("menu".to_string(), "build".to_string())]
        );
        // Nowhere else in the app: no other menu, menu handler or tray handler, and no default menu.
        for entry in
            std::fs::read_dir(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src")).unwrap()
        {
            let file = entry.unwrap().path();
            let name = file.file_name().unwrap().to_str().unwrap().to_string();
            if !name.ends_with(".rs") || name == "app_menu.rs" {
                continue;
            }
            let calls = calls_in(&read(&name).items, true);
            for (method, args) in &calls.methods {
                assert!(
                    !matches!(
                        method.as_str(),
                        "on_menu_event"
                            | "on_tray_icon_event"
                            | "set_menu"
                            | "enable_macos_default_menu"
                    ),
                    "{name} calls {method}({args})"
                );
                // The menu bar icon's own menu is the one other `menu(..)`: its items, never a handler.
                assert!(
                    method != "menu" || args == "&menu",
                    "{name} calls menu({args})"
                );
            }
            assert!(
                !calls.fns.iter().any(|c| c.starts_with("Menu::default(")),
                "{name} builds the default menu"
            );
        }
    }

    #[test]
    fn every_quit_ozzie_goes_through_the_question_and_it_carries_counts_only() {
        // The menu bar icon's "Quit Ozzie" and the app menu's (Command-Q: tests/app_menu.rs) share one id, and that
        // id asks first.
        assert_eq!(
            menu_action(crate::app_menu::QUIT_ID),
            Some(MenuAction::Quit)
        );
        assert_eq!(menu_action("open"), Some(MenuAction::Open));
        assert_eq!(menu_action("pause"), Some(MenuAction::Pause));
        // The system's own items (Hide, Copy, Close Window...) and anything unknown do nothing here.
        assert_eq!(menu_action("terminate"), None);
        assert_eq!(menu_action(""), None);
        assert_eq!(
            quit_asked(3, true),
            serde_json::json!({ "cards": 3, "checks": true })
        );
    }

    #[test]
    fn nothing_holds_an_exit_so_logging_out_restarting_shutting_down_and_the_docks_quit_go_ahead() {
        // Tauri's ExitRequested can't be made outside Tauri, so this reads every source file of the app instead: none
        // prevents an exit. The question is asked before an exit starts, never by holding one.
        let needle = concat!("prevent", "_exit");
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut read = 0;
        for entry in std::fs::read_dir(dir).unwrap() {
            let file = entry.unwrap().path();
            if file.extension().is_some_and(|e| e == "rs") {
                let source = std::fs::read_to_string(&file).unwrap();
                assert!(!source.contains(needle), "{} holds an exit", file.display());
                read += 1;
            }
        }
        assert!(read >= 10);
    }

    #[test]
    fn sleep_is_wall_clock_time_the_mac_was_not_awake() {
        let t = 1_794_668_400_000;
        assert_eq!(slept(t, t + 30_000, Duration::from_secs(30)), None);
        assert_eq!(slept(t, t + 89_000, Duration::from_secs(30)), None);
        assert_eq!(
            slept(t, t + 2 * 3_600_000, Duration::from_secs(30)),
            Some(2 * 3_600_000 - 30_000)
        );
        // A clock set backwards, or awake time ahead of the clock, is not sleep.
        assert_eq!(slept(t, t - 5_000, Duration::from_secs(30)), None);
        assert_eq!(slept(t, t + 10_000, Duration::from_secs(30)), None);
    }

    #[test]
    fn the_timer_wakes_at_the_tick_or_sooner_when_work_is_due() {
        let now = 1_794_668_400_000;
        assert_eq!(wait_for(now, None, TICK), TICK);
        assert_eq!(
            wait_for(now, Some(now + 4_000), TICK),
            Duration::from_secs(4)
        );
        assert_eq!(wait_for(now, Some(now + 90_000), TICK), TICK);
        assert_eq!(wait_for(now, Some(now - 1), TICK), Duration::ZERO);
    }

    #[test]
    fn a_due_time_wakes_the_timer_once_and_a_stop_ends_it() {
        let timer = Arc::new(Timer::with_limits(Duration::ZERO, Duration::ZERO));
        timer.set_next_due(Some(unix_ms()));
        let event = timer.next(Duration::from_secs(60)).unwrap();
        assert!(event.due);
        assert_eq!(event.slept_ms, None);
        // The page sets the next due time itself; until then only the tick wakes it.
        let started = Instant::now();
        let event = timer.next(Duration::from_millis(200)).unwrap();
        assert!(!event.due);
        assert!(started.elapsed() >= Duration::from_millis(150));
        let stopping = timer.clone();
        let waiter = std::thread::spawn(move || stopping.next(Duration::from_secs(60)));
        std::thread::sleep(Duration::from_millis(50));
        timer.stop();
        assert_eq!(waiter.join().unwrap(), None);
    }

    /// The page's side as the review's probe found it: after every wake it asks to be woken "now"
    /// again (744k wakes in 200 ms before the clamp). Returns how many due wakes `run_for` allowed.
    fn wakes_for_a_page_asking_for_now(timer: &Timer, run_for: Duration) -> usize {
        let started = Instant::now();
        let mut wakes = 0;
        timer.set_next_due(Some(unix_ms()));
        while started.elapsed() < run_for {
            let left = run_for.saturating_sub(started.elapsed());
            let event = timer.next(left.max(Duration::from_millis(1))).unwrap();
            if event.due {
                wakes += 1;
            }
            timer.set_next_due(Some(unix_ms()));
        }
        wakes
    }

    #[test]
    fn a_page_that_keeps_asking_for_now_wakes_the_timer_a_bounded_number_of_times() {
        // Production limits: nothing in the first second, then at most one wake every five seconds.
        assert_eq!(
            wakes_for_a_page_asking_for_now(&Timer::default(), Duration::from_millis(600)),
            0
        );
        // The same rule with shorter limits: a bounded number of wakes, never a loop.
        let short = Timer::with_limits(Duration::from_millis(20), Duration::from_millis(100));
        let wakes = wakes_for_a_page_asking_for_now(&short, Duration::from_secs(1));
        assert!((1..=11).contains(&wakes), "{wakes} wakes in a second");
        // A due time already past is moved to the lead, never left in the past.
        let timer = Timer::default();
        let before = unix_ms();
        timer.set_next_due(Some(before - 60_000));
        let due = timer.state.lock().unwrap().next_due_ms.unwrap();
        assert!(due >= before + 1_000, "{due} vs {before}");
        // A clock set backwards doesn't hold due work back past the gap.
        let state = TimerState {
            next_due_ms: Some(before),
            last_due_ms: Some(before + 3_600_000),
            stop: false,
        };
        assert_eq!(timer.due_at(&state, before), Some(before + 5_000));
    }

    fn store_with_a_run(label: &str) -> (std::path::PathBuf, ResponsibilityStore, String) {
        let dir = std::env::temp_dir().join(format!(
            "ozzie-always-on-{label}-{}-{}",
            std::process::id(),
            unix_ms()
        ));
        let store = ResponsibilityStore::open(&dir, false);
        let row = store
            .create(serde_json::json!({
                "template": "watch-room-bookings",
                "schedule": { "time": "09:00", "weekdays": [4], "on_change": false },
                "report": "decisions-only",
                "lifetime": { "kind": "until-stopped" },
                "limits": { "checks_per_day": 3, "ai_steps_per_day": 6 },
                "zone": "America/New_York"
            }))
            .unwrap();
        let grant = store.run_begin(&row.id, "start").unwrap();
        (dir, store, grant.run_id)
    }
    fn steps_taken(store: &ResponsibilityStore) -> u8 {
        store.list().unwrap().items[0]
            .open_run
            .as_ref()
            .unwrap()
            .ai_steps
    }
    fn view(kind: TaskKind, skill_id: &str) -> StepView {
        StepView {
            kind,
            skill_id: skill_id.into(),
            steps: 0,
            minted: Vec::new(),
            replies: Vec::new(),
        }
    }

    #[test]
    fn a_runs_grant_pays_only_for_its_own_procedure_and_only_once_a_route_is_set_up() {
        let (dir, store, run) = store_with_a_run("pay");
        let config = || Ok("route");
        // No AI route: refused before anything is spent.
        assert_eq!(
            pay_for_step(&store, &run, &view(TaskKind::Skill, "room-check"), || {
                Err::<&str, _>(AgentError::NotConfigured)
            })
            .err(),
            Some(AgentError::NotConfigured)
        );
        // Another procedure's task, or a question, can't spend this run's grant.
        for other in [
            view(TaskKind::Skill, "sunday-ready"),
            view(TaskKind::Ask, "room-check"),
        ] {
            assert_eq!(
                pay_for_step(&store, &run, &other, config).err(),
                Some(AgentError::InvalidTask)
            );
        }
        assert_eq!(steps_taken(&store), 0);
        assert_eq!(
            pay_for_step(&store, &run, &view(TaskKind::Skill, "room-check"), config),
            Ok("route")
        );
        assert_eq!(steps_taken(&store), 1);
        // Paused: nothing more is spent.
        store.pause_all(true).unwrap();
        assert_eq!(
            pay_for_step(&store, &run, &view(TaskKind::Skill, "room-check"), config).err(),
            Some(AgentError::Limit)
        );
        assert_eq!(steps_taken(&store), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn review_l1_a_step_with_no_time_left_is_refused_before_the_grant_pays() {
        use ozzie_native_auth::ledger::TaskLedger;
        let (dir, store, run) = store_with_a_run("time-left");
        let room = view(TaskKind::Skill, "room-check");
        // The route can't be used now (a model on this Mac whose task's time is gone): nothing is spent.
        assert_eq!(
            pay_for_step(&store, &run, &room, || Err::<&str, _>(
                AgentError::ProviderFailure
            ))
            .err(),
            Some(AgentError::ProviderFailure)
        );
        assert_eq!(steps_taken(&store), 0);
        // What the job's step asks before paying: a route set up, and for a model on this Mac its task's time left
        // (`agent::time_left`, which refuses a task with none, or one not running).
        let models = dir.join("models");
        std::fs::create_dir_all(&models).unwrap();
        let ledger = TaskLedger::open(&dir.join("ledger")).unwrap();
        let task = "0f8c2a4e-7b1d-4c3a-9e5f-1a2b3c4d5e6f";
        assert_eq!(
            step_route(&models, &ledger, task).err(),
            Some(AgentError::NotConfigured)
        );
        model_route::save_local_checked(
            &models,
            "http://127.0.0.1:11434/v1",
            "qwen3:8b",
            1,
            model_route::route_generation(&models),
        )
        .unwrap();
        assert_eq!(
            pay_for_step(&store, &run, &room, || step_route(&models, &ledger, task)).err(),
            Some(AgentError::InvalidTask)
        );
        assert_eq!(steps_taken(&store), 0);
        // An AI company's route keeps no task time: it pays as before.
        model_route::save_config(
            &models,
            model_route::Route::Own,
            Some("https://api.example.invalid/v1"),
            Some("vendor/model-1"),
        )
        .unwrap();
        assert!(pay_for_step(&store, &run, &room, || step_route(&models, &ledger, task)).is_ok());
        assert_eq!(steps_taken(&store), 1);
        // The job's step pays only through `step_route`.
        let source = include_str!("always_on.rs");
        let command = &source[source
            .find("pub async fn responsibility_agent_step(")
            .unwrap()..];
        let command = &command[..command.find("#[cfg(test)]").unwrap()];
        assert!(command.contains("pay_for_step(&store, &run_id, &view, || {\n            step_route(&dir, &ledger, &request.task_id)"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn every_wake_ends_ledger_tasks_stuck_past_their_ceiling_and_survives_a_panic() {
        use ozzie_native_auth::fixed::{self, ASK_SKILL};
        use ozzie_native_auth::ledger::{
            FailureCode, LEDGER_FILE, RunState, STALE_AFTER_MS, TaskLedger,
        };
        use std::sync::atomic::{AtomicU64, Ordering};
        let awake = Arc::new(AtomicU64::new(0));
        let read = awake.clone();
        let mut watchdog = Watchdog::with_clock(move || read.load(Ordering::SeqCst));
        // Start-up couldn't open the ledger: nothing to sweep.
        assert_eq!(sweep_ledger(&mut watchdog, &Ledger::default()), None);
        let dir = std::env::temp_dir().join(format!(
            "ozzie-always-on-sweep-{}-{}",
            std::process::id(),
            unix_ms()
        ));
        let (stale, fresh) = (
            "00000000-0000-4000-8000-000000000001",
            "00000000-0000-4000-8000-000000000002",
        );
        let hash = &fixed::skill(ASK_SKILL).unwrap().hash;
        TaskLedger::open(&dir)
            .unwrap()
            .admit(stale, "ask", ASK_SKILL, hash)
            .unwrap();
        // As if the page that admitted it reloaded more than the ceiling ago.
        let file = dir.join(LEDGER_FILE);
        let mut record: serde_json::Value =
            serde_json::from_str(std::fs::read_to_string(&file).unwrap().trim()).unwrap();
        for field in ["/created_ms", "/updated_ms", "/events/0/at_ms"] {
            let ms = record.pointer_mut(field).unwrap();
            *ms = (ms.as_u64().unwrap() - STALE_AFTER_MS - 60_000).into();
        }
        std::fs::write(&file, format!("{record}\n")).unwrap();
        let opened = Arc::new(TaskLedger::open(&dir).unwrap());
        opened.admit(fresh, "ask", ASK_SKILL, hash).unwrap();
        let ledger = Ledger::default();
        ledger.0.set(Some(opened.clone())).ok().unwrap();
        // A panic during a wake is contained, and the ledger and the next wake still work.
        let mut broken = Watchdog::with_clock(|| panic!("a fictional fault"));
        assert_eq!(sweep_ledger(&mut broken, &ledger), None);
        assert_eq!(sweep_ledger(&mut broken, &ledger), None);
        // Past the ceiling by the wall clock, but not yet seen stuck for it while awake.
        assert_eq!(sweep_ledger(&mut watchdog, &ledger), Some(0));
        awake.store(STALE_AFTER_MS, Ordering::SeqCst);
        assert_eq!(sweep_ledger(&mut watchdog, &ledger), Some(1));
        let state = |id: &str| {
            let row = opened
                .list(10)
                .into_iter()
                .find(|r| r.task_id == id)
                .unwrap();
            (row.state, row.failure)
        };
        assert_eq!(
            state(stale),
            (RunState::Failed, Some(FailureCode::Interrupted))
        );
        assert_eq!(state(fresh), (RunState::Admitted, None));
        assert_eq!(sweep_ledger(&mut watchdog, &ledger), Some(0));
        drop((ledger, opened));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn opened_at_login_the_window_stays_hidden_otherwise_it_shows() {
        let args = |list: &[&str]| {
            list.iter()
                .map(|s| s.to_string())
                .collect::<Vec<_>>()
                .into_iter()
        };
        assert!(shows_window_at_launch(args(&["ozzie-desktop"])));
        assert!(!shows_window_at_launch(args(&["ozzie-desktop", AT_LOGIN])));
        // The window starts hidden, so only on_page_load shows it; the login item passes AT_LOGIN.
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(
            conf["app"]["windows"][0]["visible"],
            serde_json::json!(false)
        );
        assert_eq!(
            conf["app"]["windows"][0]["label"],
            serde_json::json!("main")
        );
        // The Launch Agent is labelled with the app's own identifier.
        assert_eq!(conf["identifier"], serde_json::json!(LAUNCH_AGENT_LABEL));
        // A web view that keeps running while hidden needs macOS 14.
        assert_eq!(
            conf["app"]["windows"][0]["backgroundThrottling"],
            serde_json::json!("disabled")
        );
        assert_eq!(
            conf["bundle"]["macOS"]["minimumSystemVersion"],
            serde_json::json!("14.0")
        );
    }

    #[test]
    fn the_menu_bar_icon_is_a_template_image() {
        assert_eq!((TRAY_ICON.width(), TRAY_ICON.height()), (44, 44));
        let icon = TRAY_ICON;
        let pixels = icon.rgba().chunks(4);
        assert!(pixels.clone().all(|p| p[..3] == [0, 0, 0]), "black only");
        assert!(pixels.clone().any(|p| p[3] == 255) && pixels.clone().any(|p| p[3] == 0));
    }

    #[test]
    fn notices_are_fixed_and_discreet() {
        assert!(PAUSE_FAILED.starts_with("Ozzie") && PAUSE_FAILED.ends_with('.'));
        assert_eq!(NOTICE_TITLE, "Ozzie");
        assert_eq!(
            notice_body("briefing-ready"),
            Some("Your morning briefing is ready.")
        );
        for kind in ["needs-decision", "checked", "couldnt-check"] {
            let body = notice_body(kind).unwrap();
            assert!(body.starts_with("Ozzie") || body.starts_with("Something"));
            assert!(body.ends_with('.'));
        }
        assert_eq!(notice_body("Avery declined Greeter"), None);
        assert_eq!(notice_body(""), None);
    }

    #[test]
    fn the_menu_bar_words_follow_pause_everything() {
        assert_eq!(pause_label(false), "Pause everything");
        assert_eq!(pause_label(true), "Resume everything");
        assert_eq!((MENU_OPEN, MENU_QUIT), ("Open Ozzie", "Quit Ozzie"));
    }

    #[test]
    fn developer_settings_are_off_unless_asked_for() {
        // Tests don't set these; a release build ignores them entirely.
        if std::env::var("OZZIE_DEV_FAST_SCHEDULE").is_err() {
            assert!(!background_info().fast_schedule);
            assert_eq!(background_info().tick_ms, 30_000);
        }
        if std::env::var("OZZIE_DEV_BACKGROUND_PROBE").is_err() {
            assert!(!background_info().probe);
        }
    }
}
