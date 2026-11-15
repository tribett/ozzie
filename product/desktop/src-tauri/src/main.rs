#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use ozzie_native_auth::agent::{self, AgentError, AgentStepReply};
use ozzie_native_auth::hosted::{self, Account, HostedConfig, ManagedError};
use ozzie_native_auth::ledger::{LedgerError, TaskLedger, TaskRow};
use ozzie_native_auth::model::{
    self as model_route, AskRequest, DraftRequest, KeychainKeys, ModelError, ModelStatus, Route,
};
use ozzie_native_auth::name_guard::NameGuard;
use ozzie_native_auth::shared_check::{self, ShareError};
use ozzie_native_auth::{
    callback::CallbackServer,
    credentials::MacKeychain,
    oauth::{AuthController, AuthError, Binding, ConnectionState, ConnectionStatus, Scopes},
    provider::{NativeHttp, PcoProvider},
    source::SourceError,
    sunday_check::{self, ReadNames, RecordingEntry, RecordingError, SundayCapture},
    sunday_picker::{self, Choices, PlanChoice, ServiceTypeChoice},
};
use std::sync::{
    Arc, Condvar, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::time::{Duration, Instant};
use tauri::Manager;

use ozzie_native_auth::lifetime;
// H6: keeps running with the window closed (menu bar, timer, App Nap, open at login, responsibilities).
mod always_on;
mod local_tools;
struct Session {
    auth: Arc<AuthController>,
    receiver: Option<CallbackServer>,
    /// A one-click sign-in still waiting to hand over to a bound connection (`Consumer::settle`).
    finding: bool,
    /// The (registration, organization) of the bound connection: this session's own, or for a
    /// finder the one it replaced, so Disconnect can still revoke it if the sign-in never finishes.
    bound: Option<(String, String)>,
}
/// Where saved connections live in this Mac's Keychain, per organization: `local:<organization>`.
const WORKSPACE_PREFIX: &str = "local:";
/// Ozzie's own Public (PKCE) Planning Center registration, "Ozzie for Mac", built in at compile
/// time from `OZZIE_PCO_APP_CLIENT_ID` (tools/release-mac.sh). A public client ID, not a secret;
/// kept out of git so a self-built copy uses its own registration under Advanced.
fn app_client_id() -> Option<&'static str> {
    option_env!("OZZIE_PCO_APP_CLIENT_ID").filter(|id| {
        !id.is_empty()
            && id.len() <= 256
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    })
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
    /// Setup's list of service types or upcoming plans wasn't read; the sanitized reason only.
    SundayChoices(&'static str),
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
    /// An empty `client` means Ozzie's built-in registration, which is registered by definition.
    fn prepare(
        &self,
        client: String,
        organization: String,
        registered: bool,
    ) -> Result<Arc<AuthController>, ConsumerError> {
        let client = if client.is_empty() {
            app_client_id()
                .ok_or(ConsumerError::RegistrationRequired)?
                .to_string()
        } else if registered {
            client
        } else {
            return Err(ConsumerError::RegistrationRequired);
        };
        self.stop_current();
        let bound = Some((client.clone(), organization.clone()));
        let auth = Arc::new(AuthController::new(
            Binding {
                workspace: format!("{WORKSPACE_PREFIX}{organization}"),
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
            finding: false,
            bound,
        });
        Ok(auth)
    }
    /// One click: Ozzie's built-in registration, and the organization Planning Center names.
    fn prepare_finder(&self) -> Result<Arc<AuthController>, ConsumerError> {
        let client = app_client_id().ok_or(ConsumerError::RegistrationRequired)?;
        let (bound, orphan) = {
            let current = self
                .0
                .lock()
                .map_err(|_| ConsumerError::NativeUnavailable)?;
            let bound = current.as_ref().and_then(|s| s.bound.clone());
            // An earlier one-click sign-in that saved but was never handed over.
            let orphan = current
                .as_ref()
                .filter(|s| s.finding)
                .map(|s| s.auth.clone());
            (bound, orphan)
        };
        self.stop_current();
        if let Some(orphan) = orphan
            && orphan
                .status()
                .is_ok_and(|status| !status.organization.is_empty())
        {
            orphan.disconnect()?;
        }
        let auth = Arc::new(AuthController::find_organization(
            client.to_string(),
            WORKSPACE_PREFIX,
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
            finding: true,
            bound,
        });
        Ok(auth)
    }
    /// Once a one-click sign-in has saved a connection, swaps in the ordinary controller bound to
    /// the organization Planning Center named. A refused hand-over leaves the finder in place, so
    /// nothing reads; the person signs in again.
    /// Returns the session's controller after any hand-over, under the same lock, and whether it
    /// is still a finder (never to be used for reads).
    fn settle(&self) -> Result<Option<(Arc<AuthController>, bool)>, ConsumerError> {
        let mut current = self
            .0
            .lock()
            .map_err(|_| ConsumerError::NativeUnavailable)?;
        let Some(session) = current.as_mut() else {
            return Ok(None);
        };
        if !session.finding || session.auth.status()?.state != ConnectionState::Connected {
            return Ok(Some((session.auth.clone(), session.finding)));
        }
        let bound = session.auth.adopt_found()?;
        let status = bound.status()?;
        // The receiver ends itself after the callback it accepted; this only joins it.
        if let Some(mut receiver) = session.receiver.take() {
            receiver.stop();
        }
        *session = Session {
            auth: Arc::new(bound),
            receiver: None,
            finding: false,
            bound: app_client_id().map(|client| (client.to_string(), status.organization)),
        };
        Ok(Some((session.auth.clone(), false)))
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
/// The Sunday check and setup's picker share one Planning Center connection, so they take turns:
/// one check or one picker read at a time. A second check is refused rather than interleaved. A
/// check waits out a picker read (one page, bounded by `CHECK_WAITS_FOR_PICKER`) so it never
/// records `busy` gaps because setup was listing plans; a picker read waits for a running check up
/// to `sunday_picker::WAIT_FOR_CONTROLLER`, then answers `busy`.
#[derive(Clone, Default)]
struct SundayChecks(Arc<(Mutex<Option<Reader>>, Condvar)>);
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Reader {
    Check,
    Picker,
}
/// Longer than a picker read can take: its own wait for the connection plus the identity check
/// and one page, each under the native five-second timeout.
const CHECK_WAITS_FOR_PICKER: Duration = Duration::from_secs(30);
/// A held turn; dropping it lets the next reader in.
struct Turn(SundayChecks);
impl Drop for Turn {
    fn drop(&mut self) {
        let (held, freed) = &*(self.0).0;
        *held.lock().unwrap_or_else(|e| e.into_inner()) = None;
        freed.notify_all();
    }
}
impl SundayChecks {
    fn take(&self, reader: Reader, wait: Duration) -> Result<Turn, SourceError> {
        let (held, freed) = &*self.0;
        let deadline = Instant::now() + wait;
        let mut current = held.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            match *current {
                None => {
                    *current = Some(reader);
                    return Ok(Turn(self.clone()));
                }
                Some(Reader::Check) if reader == Reader::Check => return Err(SourceError::Busy),
                Some(_) => {
                    let left = deadline.saturating_duration_since(Instant::now());
                    if left.is_zero() {
                        return Err(SourceError::Busy);
                    }
                    current = freed
                        .wait_timeout(current, left)
                        .unwrap_or_else(|e| e.into_inner())
                        .0;
                }
            }
        }
    }
}
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
/// Async so a one-click hand-over's Keychain reads never run on the main thread.
#[tauri::command]
async fn connection_status(
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
    let consumer = consumer.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // A refused hand-over leaves the finder in place; its own status is reported.
        let auth = match consumer.settle() {
            Ok(auth) => auth.map(|(auth, _)| auth),
            Err(_) => consumer
                .0
                .lock()
                .map_err(|_| ConsumerError::NativeUnavailable)?
                .as_ref()
                .map(|s| s.auth.clone()),
        };
        auth.map(|a| a.status().map_err(ConsumerError::from))
            .transpose()
    })
    .await
    .map_err(|_| ConsumerError::NativeUnavailable)?
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
        sign_in(&consumer, scopes, |consumer| {
            consumer.prepare(client_id, organization, registered)
        })
    })
    .await
    .map_err(|_| ConsumerError::NativeUnavailable)?
}
/// One-click connect: Ozzie's built-in registration; Planning Center names the organization
/// after sign-in, and the connection is then bound to it (`Consumer::settle`). Same scopes,
/// Keychain storage and read-only reads as `connect_planning_center`.
#[tauri::command]
async fn connect_planning_center_app(
    consumer: tauri::State<'_, Consumer>,
    operations: Option<bool>,
) -> Result<ConnectionStatus, ConsumerError> {
    let consumer = consumer.inner().clone();
    let scopes = if operations.unwrap_or(false) {
        Scopes::ServicesAndOperations
    } else {
        Scopes::Services
    };
    tauri::async_runtime::spawn_blocking(move || {
        sign_in(&consumer, scopes, Consumer::prepare_finder)
    })
    .await
    .map_err(|_| ConsumerError::NativeUnavailable)?
}
/// Whether this build has Ozzie's own registration built in (one-click connect).
#[tauri::command]
fn planning_center_app() -> bool {
    app_client_id().is_some()
}
/// Starts a browser sign-in on the controller `prepare` makes and waits for nothing: the
/// loopback receiver finishes it, and the app polls `connection_status`.
fn sign_in(
    consumer: &Consumer,
    scopes: Scopes,
    prepare: impl FnOnce(&Consumer) -> Result<Arc<AuthController>, ConsumerError>,
) -> Result<ConnectionStatus, ConsumerError> {
    {
        let (_transition, generation) = consumer
            .1
            .enter()
            .ok_or(ConsumerError::Authentication(AuthError::Busy))?;
        let auth = prepare(consumer)?;
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
    }
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
        let (auth, finding, bound) = consumer
            .0
            .lock()
            .map_err(|_| ConsumerError::NativeUnavailable)?
            .as_ref()
            .map(|s| (s.auth.clone(), s.finding, s.bound.clone()))
            .ok_or(ConsumerError::NativeUnavailable)?;
        let revoke = |auth: &AuthController| match auth.disconnect() {
            Err(AuthError::Busy) => Err(ConsumerError::NotRevoked),
            result => result.map_err(ConsumerError::from),
        };
        let status = revoke(&auth)?;
        // A one-click sign-in that never finished: also revoke the connection it replaced.
        match (finding, bound) {
            (true, Some((client, organization))) => {
                revoke(&*consumer.prepare(client, organization, true)?)
            }
            _ => Ok(status),
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
    // Church rules: kids teams with the background-check rule on. Their scheduled people's cleared
    // People background checks are read; absent or empty, none are. Validated natively.
    kids_team_ids: Option<Vec<String>>,
) -> Result<SundayCapture, ConsumerError> {
    let consumer = consumer.inner().clone();
    let checks = checks.inner().clone();
    let names = names.inner().clone();
    let kids_team_ids = kids_team_ids.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        let _turn = checks
            .take(Reader::Check, CHECK_WAITS_FOR_PICKER)
            .map_err(|error| ConsumerError::SundayCheck(error.reason()))?;
        let auth = connected_auth(&consumer)?;
        // Disconnecting or quitting cancels the controller, which ends the check.
        let (capture, read) = sunday_check::check_sunday(
            &auth,
            &service_type_id,
            &plan_id,
            &kids_team_ids,
            &AtomicBool::new(false),
        )
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
/// This session's verified Planning Center connection, or NotConnected.
fn connected_auth(consumer: &Consumer) -> Result<Arc<AuthController>, ConsumerError> {
    let (auth, finding) = consumer.settle()?.ok_or(ConsumerError::NotConnected)?;
    if finding {
        return Err(ConsumerError::NotConnected);
    }
    if auth.status()?.state != ConnectionState::Connected {
        return Err(ConsumerError::NotConnected);
    }
    Ok(auth)
}
/// A picker read's turn on the connection, shared with the Sunday check (see `SundayChecks`).
fn picker_turn(checks: &SundayChecks) -> Result<Turn, ConsumerError> {
    checks
        .take(Reader::Picker, sunday_picker::WAIT_FOR_CONTROLLER)
        .map_err(|error| ConsumerError::SundayChoices(error.reason()))
}
/// Setup's Sunday picker: the connected church's service types. One read-only page; nothing
/// is saved. Disconnecting cancels the controller, which ends the read.
#[tauri::command]
async fn list_service_types(
    consumer: tauri::State<'_, Consumer>,
    checks: tauri::State<'_, SundayChecks>,
) -> Result<Choices<ServiceTypeChoice>, ConsumerError> {
    let consumer = consumer.inner().clone();
    let checks = checks.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _turn = picker_turn(&checks)?;
        let auth = connected_auth(&consumer)?;
        sunday_picker::service_types(&auth, &AtomicBool::new(false))
            .map_err(|error| ConsumerError::SundayChoices(error.reason()))
    })
    .await
    .map_err(|_| ConsumerError::NativeUnavailable)?
}
/// Setup's Sunday picker: one service type's upcoming plans, soonest first. Read-only.
#[tauri::command]
async fn list_upcoming_plans(
    consumer: tauri::State<'_, Consumer>,
    checks: tauri::State<'_, SundayChecks>,
    service_type_id: String,
) -> Result<Choices<PlanChoice>, ConsumerError> {
    let consumer = consumer.inner().clone();
    let checks = checks.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _turn = picker_turn(&checks)?;
        let auth = connected_auth(&consumer)?;
        sunday_picker::upcoming_plans(&auth, &service_type_id, &AtomicBool::new(false))
            .map_err(|error| ConsumerError::SundayChoices(error.reason()))
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
/// The model route's status with Ozzie managed added: whether this Mac is connected, and the church's
/// plan and usage, read from ozzie.church at most once a minute (offline: the last reading and when).
/// Keys and the device token are only checked for presence, never returned.
fn full_status(dir: &std::path::Path) -> ModelStatus {
    let mut status = model_route::status(dir, &KeychainKeys);
    let hosted = HostedConfig::current();
    let account = hosted::account(&hosted, &KeychainKeys, dir, sunday_check::unix_ms());
    hosted::attach(&mut status, account);
    status
}
/// Which model route is set up, and Ozzie managed's plan and usage when this Mac is connected.
#[tauri::command]
async fn model_status(app: tauri::AppHandle) -> Result<ModelStatus, ModelError> {
    tauri::async_runtime::spawn_blocking(move || Ok(full_status(&model_dir(&app)?)))
        .await
        .map_err(|_| ModelError::ProviderFailure)?
}
/// One Ozzie managed connect at a time; Cancel, Disconnect and quitting stop the one waiting.
#[derive(Clone, Default)]
struct ManagedConnect {
    busy: Arc<AtomicBool>,
    cancel: Arc<AtomicBool>,
}
/// Connects this Mac to Ozzie managed (hosted.rs): opens ozzie.church's sign-in in the browser, waits
/// up to five minutes for the loopback callback, exchanges the one-time code natively and keeps the
/// device token in the Keychain. Returns the church's plan and usage, never the token. `busy` while
/// another connect waits.
#[tauri::command]
async fn managed_connect(
    managed: tauri::State<'_, ManagedConnect>,
    app: tauri::AppHandle,
) -> Result<Account, ManagedError> {
    let managed = managed.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        managed
            .busy
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| ManagedError::Busy)?;
        let _running = Running(managed.busy.clone());
        managed.cancel.store(false, Ordering::SeqCst);
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|_| ManagedError::Unavailable)?;
        let hosted = HostedConfig::current();
        let clock =
            ozzie_native_auth::oauth::system_clock().map_err(|_| ManagedError::Unavailable)?;
        let attempt = hosted::ConnectAttempt::begin(&hosted, clock())?;
        // ozzie.church's connect address with a challenge, a state, the loopback port and a fixed
        // label only. The one-time code and the device token are never passed to a process.
        let opened = std::process::Command::new("/usr/bin/open")
            .arg(attempt.url())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
        if !opened.is_ok_and(|status| status.success()) {
            return Err(ManagedError::BrowserUnavailable);
        }
        hosted::connect(
            &attempt,
            &hosted,
            &KeychainKeys,
            &managed.cancel,
            &*clock,
            &dir,
        )
    })
    .await
    .map_err(|_| ManagedError::Unavailable)?
}
/// Stops a connect that is waiting for the browser.
#[tauri::command]
fn managed_connect_cancel(managed: tauri::State<'_, ManagedConnect>) {
    managed.cancel.store(true, Ordering::SeqCst);
}
/// Disconnects this Mac from Ozzie managed: tells ozzie.church to revoke its device token (best
/// effort), then deletes the token from the Keychain. Returns the model status afterwards.
#[tauri::command]
async fn managed_disconnect(
    managed: tauri::State<'_, ManagedConnect>,
    app: tauri::AppHandle,
) -> Result<ModelStatus, ManagedError> {
    managed.cancel.store(true, Ordering::SeqCst);
    tauri::async_runtime::spawn_blocking(move || {
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|_| ManagedError::Unavailable)?;
        hosted::disconnect(&HostedConfig::current(), &KeychainKeys, &dir)?;
        Ok(full_status(&dir))
    })
    .await
    .map_err(|_| ManagedError::Unavailable)?
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
/// "Use Ozzie's last check in other AI apps" (Settings; off by default). `envelopes` are the shared
/// tools' results from the webview (core/mcp/snapshot.ts) and `copy_id` the random id of the
/// labels they use. shared_check.rs checks each result as agent_step checks a tool message, against
/// every name this session has shown, adds the task ledger's newest name-free rows (none when the
/// ledger is unavailable) and writes `shared-check.json` in the app data folder for Ozzie's
/// read-only server (core/mcp), with the facts' own check time. `off` while sharing is off;
/// `invalid` leaves the last file as it was. Never reads Planning Center.
#[tauri::command]
async fn share_last_check(
    ledger: tauri::State<'_, Ledger>,
    names: tauri::State<'_, SessionNames>,
    app: tauri::AppHandle,
    envelopes: Vec<String>,
    copy_id: String,
) -> Result<(), ShareError> {
    let tasks = ledger
        .get()
        .map(|l| l.list(shared_check::MAX_TASKS))
        .unwrap_or_default();
    let names = names.inner().snapshot();
    in_app_data(app, move |dir| {
        shared_check::share(
            dir,
            &envelopes,
            &tasks,
            &names,
            &copy_id,
            sunday_check::unix_ms(),
        )
    })
    .await
}
/// Runs one shared-check file operation in the app data folder, off the main thread.
async fn in_app_data<T: Send + 'static>(
    app: tauri::AppHandle,
    work: impl FnOnce(&std::path::Path) -> Result<T, ShareError> + Send + 'static,
) -> Result<T, ShareError> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|_| ShareError::Unavailable)?;
        work(&dir)
    })
    .await
    .map_err(|_| ShareError::Unavailable)?
}
/// Whether the leader has sharing on, as kept natively (shared_check.rs `is_on`).
#[tauri::command]
async fn sharing_check_status(app: tauri::AppHandle) -> Result<bool, ShareError> {
    in_app_data(app, |dir| Ok(shared_check::is_on(dir))).await
}
/// Turning sharing on. Nothing is shared until the webview shares the check on screen.
#[tauri::command]
async fn start_sharing_check(app: tauri::AppHandle) -> Result<(), ShareError> {
    in_app_data(app, shared_check::start).await
}
/// Turning sharing off: no more shares, and the shared file (and any half-written one) removed so
/// other AI apps have nothing to read. `unavailable` when something couldn't be removed; the next
/// start of the app tries again.
#[tauri::command]
async fn stop_sharing_check(app: tauri::AppHandle) -> Result<(), ShareError> {
    in_app_data(app, shared_check::stop).await
}
/// Nothing current to share (no check on screen, another church's, Planning Center disconnected,
/// recordings deleted, a refused share): removes the shared file. Sharing stays on.
#[tauri::command]
async fn clear_shared_check(app: tauri::AppHandle) -> Result<(), ShareError> {
    in_app_data(app, shared_check::clear).await
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
        Ok(full_status(&dir))
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
    /// Debug builds only: the autopilot signs in with one-click connect (OZZIE_DEV_ONE_CLICK=1).
    autopilot_one_click: bool,
    /// Debug builds only: `team_id:min` pairs the autopilot marks as kids teams (OZZIE_DEV_KIDS_TEAMS, e.g. "7593352:2").
    kids_teams: String,
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
        autopilot_one_click: get("OZZIE_DEV_ONE_CLICK").as_deref() == Some("1"),
        kids_teams: get("OZZIE_DEV_KIDS_TEAMS")
            .filter(|v| {
                v.len() <= 200
                    && v.split(',').all(|pair| {
                        pair.split_once(':').is_some_and(|(team, min)| {
                            numeric_id(team)
                                && matches!(min.parse::<u8>(), Ok(1..=10))
                                && !min.starts_with('0')
                        })
                    })
            })
            .unwrap_or_default(),
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
        .manage(ManagedConnect::default())
        .manage(local_tools::LocalTools::default())
        .manage(Smoke {
            enabled: smoke,
            ready: AtomicBool::new(false),
        })
        // At start, before any command can use it: open the task ledger and fail what an earlier
        // launch left admitted or running.
        .setup(|app| {
            let _ = app.state::<Ledger>().0.set(open_ledger(app.handle()));
            // A shared copy left while sharing is off (a failed removal, a crash) is removed at
            // every start, with any half-written one; a failure here is tried again next start.
            if let Ok(dir) = app.path().app_data_dir() {
                let _ = shared_check::startup(&dir);
            }
            always_on::setup(app)?;
            Ok(())
        })
        .on_window_event(always_on::on_window_event)
        .invoke_handler(tauri::generate_handler![
            connection_status,
            connect_planning_center,
            connect_planning_center_app,
            planning_center_app,
            cancel_connection,
            check_saved_connection,
            disconnect_planning_center,
            check_sunday,
            list_service_types,
            list_upcoming_plans,
            list_sunday_recordings,
            load_sunday_recording,
            delete_sunday_recordings,
            dev_defaults,
            dev_log,
            model_status,
            managed_connect,
            managed_connect_cancel,
            managed_disconnect,
            reword_draft,
            ask_ozzie,
            agent_step,
            ledger_admit,
            ledger_transition,
            ledger_event,
            ledger_list,
            share_last_check,
            sharing_check_status,
            start_sharing_check,
            stop_sharing_check,
            clear_shared_check,
            set_model_route,
            notify_sunday_attention,
            local_tools::speak_briefing,
            local_tools::stop_briefing,
            local_tools::prepare_card_reader,
            local_tools::read_card_text,
            local_tools::cancel_card_reading,
            local_tools::voice_status_check,
            local_tools::listen_for_question,
            local_tools::stop_listening,
            local_tools::cancel_listening,
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
            app.state::<ManagedConnect>()
                .cancel
                .store(true, Ordering::SeqCst);
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
    fn a_check_waits_out_a_picker_read_and_never_runs_beside_another_check() {
        let checks = SundayChecks::default();
        let long = Duration::from_secs(5);
        // Setup is listing plans when a scheduled check starts: the check waits, then runs.
        let picker = checks.take(Reader::Picker, long).unwrap();
        std::thread::scope(|scope| {
            let check = scope.spawn(|| checks.take(Reader::Check, CHECK_WAITS_FOR_PICKER));
            std::thread::sleep(Duration::from_millis(100));
            assert!(!check.is_finished(), "the check waits for the picker read");
            drop(picker);
            let running = check.join().unwrap().expect("the check runs, not busy");
            // A second check is refused at once rather than interleaved.
            let started = Instant::now();
            assert_eq!(
                checks.take(Reader::Check, long).err(),
                Some(SourceError::Busy)
            );
            assert!(started.elapsed() < Duration::from_millis(50));
            // A picker read waits for the check up to its bound, then answers busy.
            let started = Instant::now();
            assert_eq!(
                checks
                    .take(Reader::Picker, Duration::from_millis(100))
                    .err(),
                Some(SourceError::Busy)
            );
            assert!(started.elapsed() >= Duration::from_millis(100));
            let picker = scope.spawn(|| checks.take(Reader::Picker, long));
            std::thread::sleep(Duration::from_millis(50));
            assert!(!picker.is_finished());
            drop(running);
            let reading = picker
                .join()
                .unwrap()
                .expect("the picker reads after the check");
            // Picker reads take turns with each other too.
            let next = scope.spawn(|| checks.take(Reader::Picker, long).is_ok());
            std::thread::sleep(Duration::from_millis(50));
            assert!(!next.is_finished());
            drop(reading);
            assert!(next.join().unwrap());
        });
        assert!(checks.take(Reader::Check, long).is_ok());
        assert_eq!(sunday_picker::WAIT_FOR_CONTROLLER, Duration::from_secs(10));
        assert!(CHECK_WAITS_FOR_PICKER > sunday_picker::WAIT_FOR_CONTROLLER * 2);
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
        let kids = |v: &'static str| {
            dev_defaults_from(move |key: &str| {
                (key == "OZZIE_DEV_KIDS_TEAMS").then(|| v.to_string())
            })
            .kids_teams
        };
        assert_eq!(kids("7593352:2"), "7593352:2");
        assert_eq!(kids("7593352:2,6938634:1"), "7593352:2,6938634:1");
        for bad in [
            "7593352",
            "7593352:0",
            "7593352:11",
            "7593352:02",
            "0759:2",
            "7593352:2,",
            "x:2",
            "7593352:2;rm",
        ] {
            assert_eq!(kids(bad), "", "{bad}");
        }
    }
}
