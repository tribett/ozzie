#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use ozzie_native_auth::agent::{self, AgentError, AgentStepReply};
use ozzie_native_auth::ledger::{LedgerError, TaskLedger, TaskRow};
use ozzie_native_auth::model::{
    self as model_route, AskRequest, DraftRequest, KeychainKeys, ModelError, ModelStatus, Route,
};
use ozzie_native_auth::name_guard::NameGuard;
use ozzie_native_auth::{
    callback::CallbackServer,
    credentials::MacKeychain,
    oauth::{AuthController, AuthError, Binding, ConnectionState, ConnectionStatus, Scopes},
    provider::{NativeHttp, PcoProvider},
    source::SourceError,
    sunday_check::{self, ReadNames, RecordingEntry, RecordingError, SundayCapture},
};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use tauri::Manager;

use ozzie_native_auth::lifetime;
// H6: keeps running with the window closed (menu bar, timer, App Nap, open at login, responsibilities).
mod always_on;
mod local_tools;
struct Session {
    auth: Arc<AuthController>,
    receiver: Option<CallbackServer>,
}
#[derive(Clone, Default)]
struct Consumer(Arc<Mutex<Option<Session>>>, Arc<lifetime::Lifetime>);
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
enum ConsumerError {
    RegistrationRequired,
    BrowserUnavailable,
    NativeUnavailable,
    Authentication(AuthError),
    /// No verified Planning Center connection in this session.
    NotConnected,
    /// The Sunday check did not finish; carries the sanitized source reason only.
    SundayCheck(&'static str),
    Recording(RecordingError),
    /// Disconnect waited for an in-flight read and gave up: access was not yet revoked
    /// and the saved connection was not deleted. The read itself was cancelled.
    NotRevoked,
}
impl From<AuthError> for ConsumerError {
    fn from(error: AuthError) -> Self {
        Self::Authentication(error)
    }
}
impl Consumer {
    fn stop(&self) {
        self.1.cancel();
        self.stop_current();
    }
    fn stop_current(&self) {
        if let Ok(mut current) = self.0.lock()
            && let Some(session) = current.as_mut()
        {
            session.auth.cancel();
            if let Some(mut receiver) = session.receiver.take() {
                receiver.stop();
            }
        }
    }
    fn prepare(
        &self,
        client: String,
        organization: String,
        registered: bool,
    ) -> Result<Arc<AuthController>, ConsumerError> {
        if !registered {
            return Err(ConsumerError::RegistrationRequired);
        }
        self.stop_current();
        let auth = Arc::new(AuthController::new(
            Binding {
                workspace: format!("local:{organization}"),
                organization,
                client_id: client,
            },
            Arc::new(MacKeychain {
                service: "church.ozzie.planning-center.v1".into(),
            }),
            Arc::new(PcoProvider(NativeHttp::new()?)),
            ozzie_native_auth::oauth::system_clock()?,
        )?);
        *self
            .0
            .lock()
            .map_err(|_| ConsumerError::NativeUnavailable)? = Some(Session {
            auth: auth.clone(),
            receiver: None,
        });
        Ok(auth)
    }
}
/// Every name this session has shown (live checks and loaded recordings), held only in memory
/// so the native model guard can refuse a request that carries one. Never saved or logged.
/// Capture `labels` (room, workflow and step names) are free text, not person names: matching
/// their words ("for", "new", "group") would refuse ordinary drafts, so they are kept out of
/// model input by the webview's placeholder boundary instead (contract: never model input).
#[derive(Clone, Default)]
struct SessionNames(Arc<Mutex<NameGuard>>);
impl SessionNames {
    fn remember(&self, capture: &SundayCapture) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remember(capture.names.values());
    }
    /// Every Person name a live check read, including those its capture's `names` pruned
    /// (leaders on no position, people past the bound). Guard-only: never returned or saved.
    fn remember_read(&self, read: &ReadNames) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remember(read.iter());
    }
    fn snapshot(&self) -> NameGuard {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}
/// One Sunday check at a time; a second request is refused rather than interleaved.
#[derive(Clone, Default)]
struct SundayChecks(Arc<AtomicBool>);
struct Running(Arc<AtomicBool>);
impl Drop for Running {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}
/// Cached fallback recordings live only in this Mac's app data directory.
fn recordings(app: &tauri::AppHandle) -> Result<std::path::PathBuf, ConsumerError> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("recordings"))
        .map_err(|_| ConsumerError::Recording(RecordingError::Unavailable))
}
struct Smoke {
    enabled: bool,
    ready: AtomicBool,
}
#[tauri::command]
fn connection_status(
    consumer: tauri::State<'_, Consumer>,
    smoke: tauri::State<'_, Smoke>,
    app: tauri::AppHandle,
) -> Result<Option<ConnectionStatus>, ConsumerError> {
    if smoke.enabled && !smoke.ready.swap(true, Ordering::SeqCst) {
        println!("native-lifecycle: React rendered and requested status over IPC");
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(500));
            app.exit(0);
        });
    }
    let current = consumer
        .0
        .lock()
        .map_err(|_| ConsumerError::NativeUnavailable)?;
    current
        .as_ref()
        .map(|s| s.auth.status().map_err(ConsumerError::from))
        .transpose()
}
/// `operations` (optional, default false) opts in to the Calendar, People and Groups scopes for
/// the Sunday check's operations reads. Each Planning Center product scope permits read and
/// write in that product; Ozzie only issues GET source reads, and asks for Services alone unless
/// the person chooses more. `ConnectionStatus.scopes` reports what Planning Center actually
/// granted, read from its token response; a grant wider than asked fails as `scope-mismatch`
/// and saves nothing. A new sign-in revokes the saved credential it replaces.
#[tauri::command]
async fn connect_planning_center(
    consumer: tauri::State<'_, Consumer>,
    client_id: String,
    organization: String,
    registered: bool,
    operations: Option<bool>,
) -> Result<ConnectionStatus, ConsumerError> {
    let consumer = consumer.inner().clone();
    let scopes = if operations.unwrap_or(false) {
        Scopes::ServicesAndOperations
    } else {
        Scopes::Services
    };
    tauri::async_runtime::spawn_blocking(move || {
        let (_transition, generation) = consumer
            .1
            .enter()
            .ok_or(ConsumerError::Authentication(AuthError::Busy))?;
        let auth = consumer.prepare(client_id, organization, registered)?;
        let url = auth.begin_with(scopes)?;
        if !consumer.1.current(generation) {
            auth.cancel();
            return Err(AuthError::Cancelled.into());
        }
        let receiver = match CallbackServer::start(auth.clone()) {
            Ok(receiver) => receiver,
            Err(error) => {
                auth.cancel();
                return Err(error.into());
            }
        };
        consumer
            .0
            .lock()
            .map_err(|_| ConsumerError::NativeUnavailable)?
            .as_mut()
            .ok_or(ConsumerError::NativeUnavailable)?
            .receiver = Some(receiver);
        if !consumer.1.current(generation) {
            consumer.stop_current();
            return Err(AuthError::Cancelled.into());
        }
        // This is an allowlisted authorization URL containing challenge/state only.
        // Callback codes and credential values are never passed to a process.
        let opened = std::process::Command::new("/usr/bin/open")
            .arg(&url)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
        if !opened.is_ok_and(|status| status.success()) {
            consumer.stop();
            return Err(ConsumerError::BrowserUnavailable);
        }
        auth.status().map_err(ConsumerError::from)
    })
    .await
    .map_err(|_| ConsumerError::NativeUnavailable)?
}
#[tauri::command]
async fn cancel_connection(consumer: tauri::State<'_, Consumer>) -> Result<(), ConsumerError> {
    let consumer = consumer.inner().clone();
    tauri::async_runtime::spawn_blocking(move || consumer.stop())
        .await
        .map_err(|_| ConsumerError::NativeUnavailable)
}
#[tauri::command]
async fn check_saved_connection(
    consumer: tauri::State<'_, Consumer>,
    client_id: String,
    organization: String,
    registered: bool,
) -> Result<ConnectionStatus, ConsumerError> {
    let consumer = consumer.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (_transition, generation) = consumer
            .1
            .enter()
            .ok_or(ConsumerError::Authentication(AuthError::Busy))?;
        let auth = consumer.prepare(client_id, organization, registered)?;
        if !consumer.1.current(generation) {
            auth.cancel();
            return Err(AuthError::Cancelled.into());
        }
        auth.refresh().map_err(ConsumerError::from)
    })
    .await
    .map_err(|_| ConsumerError::NativeUnavailable)?
}
#[tauri::command]
async fn disconnect_planning_center(
    consumer: tauri::State<'_, Consumer>,
) -> Result<ConnectionStatus, ConsumerError> {
    let consumer = consumer.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (_transition, _) = consumer
            .1
            .enter()
            .ok_or(ConsumerError::Authentication(AuthError::Busy))?;
        consumer.stop_current();
        let auth = consumer
            .0
            .lock()
            .map_err(|_| ConsumerError::NativeUnavailable)?
            .as_ref()
            .map(|s| s.auth.clone())
            .ok_or(ConsumerError::NativeUnavailable)?;
        match auth.disconnect() {
            Err(AuthError::Busy) => Err(ConsumerError::NotRevoked),
            result => result.map_err(ConsumerError::from),
        }
    })
    .await
    .map_err(|_| ConsumerError::NativeUnavailable)?
}
/// Read-only Sunday readiness check for one plan, using the connected session.
#[tauri::command]
async fn check_sunday(
    consumer: tauri::State<'_, Consumer>,
    checks: tauri::State<'_, SundayChecks>,
    names: tauri::State<'_, SessionNames>,
    app: tauri::AppHandle,
    service_type_id: String,
    plan_id: String,
) -> Result<SundayCapture, ConsumerError> {
    let consumer = consumer.inner().clone();
    let checks = checks.inner().clone();
    let names = names.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        checks
            .0
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| ConsumerError::SundayCheck(SourceError::Busy.reason()))?;
        let _running = Running(checks.0.clone());
        let auth = consumer
            .0
            .lock()
            .map_err(|_| ConsumerError::NativeUnavailable)?
            .as_ref()
            .map(|s| s.auth.clone())
            .ok_or(ConsumerError::NotConnected)?;
        if auth.status()?.state != ConnectionState::Connected {
            return Err(ConsumerError::NotConnected);
        }
        // Disconnecting or quitting cancels the controller, which ends the check.
        let (capture, read) =
            sunday_check::check_sunday(&auth, &service_type_id, &plan_id, &AtomicBool::new(false))
                .map_err(|error| ConsumerError::SundayCheck(error.reason()))?;
        names.remember(&capture);
        // The guard also learns names the capture pruned; `read` itself is dropped here.
        names.remember_read(&read);
        drop(read);
        // A failed save never hides a finished check; list_sunday_recordings shows what was kept.
        if let Ok(dir) = recordings(&app) {
            let _ = sunday_check::save_recording(&dir, &capture);
        }
        Ok(capture)
    })
    .await
    .map_err(|_| ConsumerError::NativeUnavailable)?
}
fn recording_io(error: std::io::Error) -> ConsumerError {
    ConsumerError::Recording(if error.kind() == std::io::ErrorKind::InvalidInput {
        RecordingError::InvalidName
    } else {
        RecordingError::Unavailable
    })
}
/// One organization's saved recordings, newest first. Works without a live session.
#[tauri::command]
async fn list_sunday_recordings(
    app: tauri::AppHandle,
    organization: String,
) -> Result<Vec<RecordingEntry>, ConsumerError> {
    tauri::async_runtime::spawn_blocking(move || {
        sunday_check::list_recordings(&recordings(&app)?, &organization).map_err(recording_io)
    })
    .await
    .map_err(|_| ConsumerError::NativeUnavailable)?
}
/// A saved capture for this organization, always labeled `recording`; the UI shows its
/// original check time. Works without a live session: it is the offline fallback.
#[tauri::command]
async fn load_sunday_recording(
    names: tauri::State<'_, SessionNames>,
    app: tauri::AppHandle,
    organization: String,
    path_id: String,
) -> Result<SundayCapture, ConsumerError> {
    let names = names.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let capture = sunday_check::load_recording(&recordings(&app)?, &organization, &path_id)
            .map_err(ConsumerError::Recording)?;
        names.remember(&capture);
        Ok(capture)
    })
    .await
    .map_err(|_| ConsumerError::NativeUnavailable)?
}
/// Removes this organization's saved recordings from this Mac. Never automatic.
#[tauri::command]
async fn delete_sunday_recordings(
    app: tauri::AppHandle,
    organization: String,
) -> Result<(), ConsumerError> {
    tauri::async_runtime::spawn_blocking(move || {
        sunday_check::delete_recordings(&recordings(&app)?, &organization)
            .map(|_| ())
            .map_err(recording_io)
    })
    .await
    .map_err(|_| ConsumerError::NativeUnavailable)?
}
/// Model route settings and the usage ledger live in this Mac's app data directory.
fn model_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, ModelError> {
    app.path()
        .app_data_dir()
        .map_err(|_| ModelError::NotConfigured)
}
/// Which model route is set up. Keys are only checked for presence, never returned.
#[tauri::command]
async fn model_status(app: tauri::AppHandle) -> Result<ModelStatus, ModelError> {
    tauri::async_runtime::spawn_blocking(move || {
        Ok(model_route::status(&model_dir(&app)?, &KeychainKeys))
    })
    .await
    .map_err(|_| ModelError::ProviderFailure)?
}
/// Rewords one placeholder-only draft. The request already passed the placeholder boundary
/// in the webview; this is the app's only non-GET request and it never goes to Planning Center.
#[tauri::command]
async fn reword_draft(
    names: tauri::State<'_, SessionNames>,
    app: tauri::AppHandle,
    request: DraftRequest,
) -> Result<String, ModelError> {
    // A copy, so a long model call never holds the lock a Sunday check needs.
    let names = names.inner().snapshot();
    tauri::async_runtime::spawn_blocking(move || {
        let dir = model_dir(&app)?;
        let config = model_route::load_config(&dir).ok_or(ModelError::NotConfigured)?;
        model_route::reword(
            &config,
            &dir.join(model_route::LEDGER_FILE),
            &request,
            &KeychainKeys,
            &names,
        )
        .map(|reply| reply.text)
    })
    .await
    .map_err(|_| ModelError::ProviderFailure)?
}
/// Answers one Ask Ozzie question from a placeholder-only fact sheet (core/src/ask.ts). The
/// webview already replaced every name it knows; `ask` checks the whole request again against
/// every name this session has shown, before any key, budget or network. Never goes to Planning
/// Center. Returns the model's raw reply, which the webview checks before showing anything.
#[tauri::command]
async fn ask_ozzie(
    names: tauri::State<'_, SessionNames>,
    app: tauri::AppHandle,
    request: AskRequest,
) -> Result<String, ModelError> {
    // A copy, so a long model call never holds the lock a Sunday check needs.
    let names = names.inner().snapshot();
    tauri::async_runtime::spawn_blocking(move || {
        let dir = model_dir(&app)?;
        let config = model_route::load_config(&dir).ok_or(ModelError::NotConfigured)?;
        model_route::ask(
            &config,
            &dir.join(model_route::LEDGER_FILE),
            &request,
            &KeychainKeys,
            &names,
        )
        .map(|reply| reply.text)
    })
    .await
    .map_err(|_| ModelError::ProviderFailure)?
}
/// One step of an agent task (core/src/harness/contract.ts `ModelStep`): the agent loop's only path
/// to a model. The task must already be in the task ledger and running (`ledger_admit`, then
/// `ledger_transition` to running); otherwise `invalid-task`, and `ledger-unavailable` when the
/// ledger couldn't be opened. `request` is an AgentStepRequest; agent.rs parses and checks all of it
/// (allowlisted tools of the task's procedure, shape, sizes, call ids minted for this task, and no
/// name this session has shown or contact detail in anything sent) before any key, budget or
/// network, then sends it on the same route, keys and call cap as Ask, within the route's agent
/// steps per day (`daily-limit`). The step and its outcome are recorded in the ledger natively; the
/// webview records tool events only. Never goes to Planning Center. The reply is checked the same
/// way before it is returned.
#[tauri::command]
async fn agent_step(
    ledger: tauri::State<'_, Ledger>,
    names: tauri::State<'_, SessionNames>,
    app: tauri::AppHandle,
    request: agent::Json,
) -> Result<AgentStepReply, AgentError> {
    let ledger = ledger.get().map_err(|_| AgentError::LedgerUnavailable)?;
    // A copy, so a long model call never holds the lock a Sunday check needs.
    let names = names.inner().snapshot();
    tauri::async_runtime::spawn_blocking(move || {
        let request = agent::parse_request(request)?;
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|_| AgentError::NotConfigured)?;
        let config = model_route::load_config(&dir).ok_or(AgentError::NotConfigured)?;
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
/// The task ledger in this Mac's app data folder, set once at start after recovery. Until then, or
/// when it couldn't be opened (or another copy of Ozzie holds it), the ledger commands answer
/// `unavailable` and the app keeps its deterministic Sunday path; nothing is admitted before recovery.
#[derive(Default)]
struct Ledger(std::sync::OnceLock<Option<Arc<TaskLedger>>>);
impl Ledger {
    fn get(&self) -> Result<Arc<TaskLedger>, LedgerError> {
        self.0
            .get()
            .cloned()
            .flatten()
            .ok_or(LedgerError::Unavailable)
    }
}
fn open_ledger(app: &tauri::AppHandle) -> Option<Arc<TaskLedger>> {
    let ledger = TaskLedger::open(&app.path().app_data_dir().ok()?).ok()?;
    // The host is the watchdog: a task still admitted or running belonged to an earlier launch.
    ledger.recover().ok()?;
    Some(Arc::new(ledger))
}
/// Records a new agent task as admitted. Name-free fields only: `skill_id` must be a bundled
/// procedure paired with `kind` (ask: answer-from-what-was-read; check: sunday-ready; skill: any
/// other) and `skill_hash` the sha-256 of its bundled file, else `invalid`. The id is then one of a
/// few fixed words, so it is never name-scanned.
#[tauri::command]
async fn ledger_admit(
    ledger: tauri::State<'_, Ledger>,
    task_id: String,
    kind: String,
    skill_id: String,
    skill_hash: String,
) -> Result<TaskRow, LedgerError> {
    let ledger = ledger.get()?;
    tauri::async_runtime::spawn_blocking(move || {
        ledger.admit(&task_id, &kind, &skill_id, &skill_hash)
    })
    .await
    .map_err(|_| LedgerError::Unavailable)?
}
/// Moves a task to running, verified, failed (with a failure code) or cancelled.
#[tauri::command]
async fn ledger_transition(
    ledger: tauri::State<'_, Ledger>,
    task_id: String,
    to: String,
    code: Option<String>,
) -> Result<TaskRow, LedgerError> {
    let ledger = ledger.get()?;
    tauri::async_runtime::spawn_blocking(move || ledger.transition(&task_id, &to, code.as_deref()))
        .await
        .map_err(|_| LedgerError::Unavailable)?
}
/// Adds a name-free tool event to an admitted or running task. Model events are recorded natively
/// by `agent_step`; `kind` "model" is `invalid` here.
#[tauri::command]
async fn ledger_event(
    ledger: tauri::State<'_, Ledger>,
    task_id: String,
    kind: String,
    detail: String,
) -> Result<TaskRow, LedgerError> {
    let ledger = ledger.get()?;
    tauri::async_runtime::spawn_blocking(move || ledger.event(&task_id, &kind, &detail))
        .await
        .map_err(|_| LedgerError::Unavailable)?
}
/// Recent tasks for What happened, newest first (default 50, at most the 500 kept).
#[tauri::command]
async fn ledger_list(
    ledger: tauri::State<'_, Ledger>,
    limit: Option<u32>,
) -> Result<Vec<TaskRow>, LedgerError> {
    let ledger = ledger.get()?;
    let limit = limit.map_or(50, |n| n as usize);
    tauri::async_runtime::spawn_blocking(move || ledger.list(limit))
        .await
        .map_err(|_| LedgerError::Unavailable)
}
/// Chooses the route. Never accepts a key: keys go into the Keychain outside this IPC, and an own
/// provider's key is read only from the account bound to the base URL's host (`ModelStatus`
/// `key_account`), so changing the URL here can't send a saved key anywhere else. A model id
/// holding a name this session has shown is `name-present`.
#[tauri::command]
async fn set_model_route(
    names: tauri::State<'_, SessionNames>,
    app: tauri::AppHandle,
    route: String,
    base_url: Option<String>,
    model: Option<String>,
) -> Result<ModelStatus, ModelError> {
    let names = names.inner().snapshot();
    tauri::async_runtime::spawn_blocking(move || {
        let route = Route::parse(&route).ok_or(ModelError::InvalidRequest)?;
        if model
            .as_deref()
            .is_some_and(|model| !model_route::model_free_of_names(model, &names))
        {
            return Err(ModelError::NamePresent);
        }
        let dir = model_dir(&app)?;
        model_route::save_config(&dir, route, base_url.as_deref(), model.as_deref())?;
        Ok(model_route::status(&dir, &KeychainKeys))
    })
    .await
    .map_err(|_| ModelError::ProviderFailure)?
}
/// Developer prefill for empty settings. Empty strings in release builds.
#[derive(Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DevDefaults {
    client_id: String,
    organization: String,
    service_type_id: String,
    plan_id: String,
    /// Debug builds only: run the live flow automatically and report each step with `dev_log`.
    autopilot: bool,
    /// Debug builds only: the autopilot also opts in to rooms, follow-ups and group events (asks for consent).
    autopilot_operations: bool,
}
/// Validated values only; anything missing or malformed is an empty string.
#[cfg(any(debug_assertions, test))]
fn dev_defaults_from(get: impl Fn(&str) -> Option<String>) -> DevDefaults {
    use ozzie_native_auth::oauth::numeric_id;
    let id = |key: &str| get(key).filter(|v| numeric_id(v)).unwrap_or_default();
    DevDefaults {
        client_id: get("OZZIE_PCO_CLIENT_ID")
            .filter(|v| {
                !v.is_empty()
                    && v.len() <= 256
                    && v.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            })
            .unwrap_or_default(),
        organization: id("OZZIE_PCO_ORG"),
        service_type_id: id("OZZIE_PCO_SERVICE_TYPE"),
        plan_id: id("OZZIE_PCO_PLAN"),
        autopilot: get("OZZIE_DEV_AUTOPILOT").as_deref() == Some("1"),
        autopilot_operations: get("OZZIE_DEV_OPERATIONS").as_deref() == Some("1"),
    }
}
/// Debug builds only: one name-free autopilot line to the developer's terminal. Release: no-op.
#[tauri::command]
fn dev_log(line: String) {
    #[cfg(debug_assertions)]
    {
        let clean: String = line
            .chars()
            .take(400)
            .map(|c| if c.is_control() { ' ' } else { c })
            .collect();
        println!("autopilot: {clean}");
    }
    #[cfg(not(debug_assertions))]
    let _ = line;
}
#[tauri::command]
fn dev_defaults() -> DevDefaults {
    #[cfg(debug_assertions)]
    return dev_defaults_from(|key| std::env::var(key).ok());
    #[cfg(not(debug_assertions))]
    DevDefaults::default()
}
/// Lock-screen privacy: the only notice Ozzie shows. Fixed here, never names or details.
const SUNDAY_NOTICE_TITLE: &str = "Ozzie";
const SUNDAY_NOTICE_BODY: &str = "Sunday coverage needs attention. Open Ozzie to see details.";
/// The webview asks for the Sunday notice and passes no text. The capability grants none of the
/// notification plugin's own commands, so the webview cannot show any other notification text.
#[tauri::command]
fn notify_sunday_attention(app: tauri::AppHandle) -> Result<(), &'static str> {
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title(SUNDAY_NOTICE_TITLE)
        .body(SUNDAY_NOTICE_BODY)
        .show()
        .map_err(|_| "notification-unavailable")
}
fn main() {
    let smoke = std::env::args().any(|arg| arg == "--lifecycle-smoke");
    let consumer = Consumer::default();
    let cleanup = consumer.clone();
    let app = always_on::manage(tauri::Builder::default())
        .plugin(tauri_plugin_notification::init())
        .manage(consumer)
        .manage(SundayChecks::default())
        .manage(SessionNames::default())
        .manage(Ledger::default())
        .manage(local_tools::LocalTools::default())
        .manage(Smoke {
            enabled: smoke,
            ready: AtomicBool::new(false),
        })
        // At start, before any command can use it: open the task ledger and fail what an earlier
        // launch left admitted or running.
        .setup(|app| {
            let _ = app.state::<Ledger>().0.set(open_ledger(app.handle()));
            always_on::setup(app)?;
            Ok(())
        })
        .on_window_event(always_on::on_window_event)
        .invoke_handler(tauri::generate_handler![
            connection_status,
            connect_planning_center,
            cancel_connection,
            check_saved_connection,
            disconnect_planning_center,
            check_sunday,
            list_sunday_recordings,
            load_sunday_recording,
            delete_sunday_recordings,
            dev_defaults,
            dev_log,
            model_status,
            reword_draft,
            ask_ozzie,
            agent_step,
            ledger_admit,
            ledger_transition,
            ledger_event,
            ledger_list,
            set_model_route,
            notify_sunday_attention,
            local_tools::speak_briefing,
            local_tools::stop_briefing,
            local_tools::read_card_text,
            local_tools::cancel_card_reading,
            always_on::background_info,
            always_on::background_next_due,
            always_on::autostart_get,
            always_on::autostart_set,
            always_on::notify_ozzie,
            always_on::responsibility_list,
            always_on::responsibility_create,
            always_on::responsibility_edit,
            always_on::responsibility_pause,
            always_on::responsibility_resume,
            always_on::responsibility_stop,
            always_on::responsibility_pause_all,
            always_on::responsibility_run_begin,
            always_on::responsibility_run_end,
            always_on::responsibility_agent_step
        ])
        .on_page_load(|window, _| always_on::on_page_load(window))
        .build(tauri::generate_context!())
        .expect("native consumer failed to start");
    if smoke {
        println!("native-lifecycle: native window and event loop starting");
    }
    app.run(move |app, event| {
        always_on::on_run_event(app, &event);
        if matches!(
            event,
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
        ) {
            cleanup.stop();
            app.state::<local_tools::LocalTools>().stop();
            if smoke {
                println!("native-lifecycle: stopped; callback work cancelled and joined");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sunday_notice_is_fixed_and_discreet() {
        assert_eq!(SUNDAY_NOTICE_TITLE, "Ozzie");
        assert_eq!(
            SUNDAY_NOTICE_BODY,
            "Sunday coverage needs attention. Open Ozzie to see details."
        );
    }

    #[test]
    fn the_ledger_is_unavailable_until_start_up_opens_and_recovers_it() {
        let ledger = Ledger::default();
        assert_eq!(ledger.get().err(), Some(LedgerError::Unavailable));
        // Start-up couldn't open it (no app data folder, or another copy of Ozzie holds it).
        ledger.0.set(None).ok().unwrap();
        assert_eq!(ledger.get().err(), Some(LedgerError::Unavailable));
    }

    #[test]
    fn dev_defaults_keep_only_validated_values() {
        let env = |pairs: &'static [(&'static str, &'static str)]| {
            move |key: &str| {
                pairs
                    .iter()
                    .find(|(k, _)| *k == key)
                    .map(|(_, v)| v.to_string())
            }
        };
        let fields = |d: DevDefaults| [d.client_id, d.organization, d.service_type_id, d.plan_id];
        let full = dev_defaults_from(env(&[
            ("OZZIE_PCO_CLIENT_ID", "fictional0client-id_1"),
            ("OZZIE_PCO_ORG", "513367"),
            ("OZZIE_PCO_SERVICE_TYPE", "1694698"),
            ("OZZIE_PCO_PLAN", "92902197"),
        ]));
        assert_eq!(
            fields(full),
            ["fictional0client-id_1", "513367", "1694698", "92902197"]
        );
        let bad = dev_defaults_from(env(&[
            ("OZZIE_PCO_CLIENT_ID", "has space"),
            ("OZZIE_PCO_ORG", "0513367"),
            ("OZZIE_PCO_SERVICE_TYPE", "1694698/../1"),
            ("OZZIE_PCO_PLAN", ""),
        ]));
        assert_eq!(fields(bad), ["", "", "", ""]);
        assert_eq!(fields(dev_defaults_from(|_| None)), ["", "", "", ""]);
    }
}
