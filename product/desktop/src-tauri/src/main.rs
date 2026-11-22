#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use ozzie_native_auth::agent::{self, AgentError, AgentStepReply};
use ozzie_native_auth::contact::CheckedPeople;
use ozzie_native_auth::hosted::{self, Account, HostedConfig, ManagedError};
use ozzie_native_auth::ledger::{LedgerError, TaskLedger, TaskRow};
use ozzie_native_auth::model::{
    self as model_route, DraftRequest, KeychainKeys, ModelError, ModelStatus, Route,
};
use ozzie_native_auth::name_guard::NameGuard;
use ozzie_native_auth::shared_check::{self, ShareError};
use ozzie_native_auth::{
    callback::CallbackServer,
    connections::{Connections, ConnectionsError, Decision, Purpose, StatusView, SwitchAnswer},
    credentials::MacKeychain,
    in_use::UseFile,
    oauth::{AuthController, AuthError, ConnectionState, ConnectionStatus, Provider, Scopes},
    provider::{NativeHttp, PcoProvider},
    source::SourceError,
    sunday_check::{self, ReadNames, Reader, RecordingEntry, RecordingError, SundayCapture, Turn},
    sunday_picker::{self, Choices, PlanChoice, PlanNext, ServicePick, ServiceTypeChoice},
};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;
use tauri::{Emitter, Manager};

use ozzie_native_auth::lifetime;
// The onboarding's AI screens: AI on this Mac (and Check my setup, Ozzie's AI offer).
mod ai_setup;
// AI on this Mac: getting Ollama itself, when the person asks (core `ollama_install`).
mod ollama_setup;
// H6: keeps running with the window closed (menu bar, timer, App Nap, open at login, responsibilities).
mod always_on;
// The macOS app menu: the default one, with a "Quit Ozzie" (Command-Q) that asks first (review P, M1).
mod app_menu;
// The leader's own calendars on Today, read-only: Apple Calendar on this Mac and private calendar links.
mod calendars;
// Visitor cards: Ozzie's own images-only photo panel (no path ever comes from the page).
mod card_picker;
// The church's own AI key, taken in natively (clipboard or Ozzie's key window), checked, then kept in the Keychain.
mod church_sources;
// B1 Church, Breeze and Genesis, read-only: keys through the native key window, reads through core/church-systems.
mod church_systems;
mod key_sheet;
// "Let Ozzie make changes you confirm, one at a time": add one person to an open role in Planning
// Center, unconfirmed with the request waiting, after the leader's yes (core `change`). Off by default.
mod changes;
// "Open in Mail" / "Open in Messages" on drafts: a new, unsent message the person sends.
mod draft_apps;
mod local_tools;
// The small program another AI app starts to read Ozzie's shared check (helpers/share.swift).
mod share_bundle;
mod share_helper;
// "A notice on your phone": the Mac's fixed notices, also to the leader's phone through ntfy.sh.
mod phone_notice;
// "Open in Planning Center" on the Sunday page (audit item 25): a fixed Planning Center address and a digits-only id.
mod planning_center_pages;
// Siri and Shortcuts: the switch, the copy their helper answers from (helpers/shortcuts.swift), and
// the pages an ozzie:// link opens.
mod shortcuts;
// New versions of Ozzie from the public release, installed only on the person's click.
mod updater;
// View › Bigger Text, Smaller Text and Actual Size: the page's zoom, kept across launches (accessibility audit B1).
mod text_size;
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
/// This session's one Planning Center connection, and switching it to another church only after the
/// person answers (core `connections`), with the transition lock that takes sign-ins, checks,
/// answers and disconnects one at a time.
#[derive(Clone)]
struct Consumer(Arc<Connections>, Arc<lifetime::Lifetime>);
impl Default for Consumer {
    fn default() -> Self {
        Self(
            Arc::new(Connections::new(
                WORKSPACE_PREFIX,
                app_client_id().map(str::to_string),
                Arc::new(MacKeychain {
                    service: "church.ozzie.planning-center.v1".into(),
                }),
                Box::new(|| Ok(Arc::new(PcoProvider(NativeHttp::new()?)) as Arc<dyn Provider>)),
                Box::new(ozzie_native_auth::oauth::system_clock),
            )),
            Arc::default(),
        )
    }
}
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
    /// A read found the sign-in needed renewing and couldn't renew it, so nothing was read
    /// (`renewed_auth`); the sanitized source reason only, as core `renewal_error` gives it:
    /// `invalid-credentials` when only a new sign-in mends it, `provider-failure` when Planning Center
    /// didn't renew it just now (no answer, a 429 or a 5xx), a Keychain reason (`locked`, `denied`,
    /// `store-unavailable`), `busy` (a sign-in or Disconnect under way past the wait) or `cancelled`.
    SignInNotRenewed(&'static str),
    /// Setup's list of service types or upcoming plans wasn't read; the sanitized reason only.
    SundayChoices(&'static str),
    Recording(RecordingError),
    /// Disconnect waited for an in-flight read and gave up: access was not yet revoked
    /// and the saved connection was not deleted. The read itself was cancelled.
    NotRevoked,
    /// Another church's sign-in waits for the person's answer ("Switch Ozzie to this church?").
    SwitchPending,
    /// Nothing is waiting for an answer, or to be signed out (already answered).
    NoQuestion,
    /// The new church's sign-in couldn't be checked, so nothing changed.
    SwitchUnchecked(AuthError),
    /// The church Ozzie would keep couldn't be checked, so nothing changed.
    KeepUnchecked(AuthError),
    /// A church the person chose to leave isn't checked back into use.
    LeftChurch,
    /// A sign-in Ozzie found saved isn't switched to as it is; the person signs in instead.
    SignInInstead,
}
impl From<AuthError> for ConsumerError {
    fn from(error: AuthError) -> Self {
        Self::Authentication(error)
    }
}
impl From<ConnectionsError> for ConsumerError {
    fn from(error: ConnectionsError) -> Self {
        match error {
            ConnectionsError::RegistrationRequired => Self::RegistrationRequired,
            ConnectionsError::NativeUnavailable => Self::NativeUnavailable,
            ConnectionsError::Authentication(error) => Self::Authentication(error),
            ConnectionsError::NotRevoked => Self::NotRevoked,
            ConnectionsError::SwitchPending => Self::SwitchPending,
            ConnectionsError::NoQuestion => Self::NoQuestion,
            ConnectionsError::SwitchUnchecked(error) => Self::SwitchUnchecked(error),
            ConnectionsError::KeepUnchecked(error) => Self::KeepUnchecked(error),
            ConnectionsError::LeftChurch => Self::LeftChurch,
            ConnectionsError::SignInInstead => Self::SignInInstead,
        }
    }
}
impl Consumer {
    fn stop(&self) {
        self.1.cancel();
        self.0.stop_current();
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
    /// Every person name a church system's check read (church_systems.rs: B1 Church, Breeze, Genesis), as
    /// `remember` does for Planning Center's. Labels (roles, teams, groups, events) stay out, as for Planning Center.
    pub(crate) fn remember_names(&self, names: &[String]) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remember(names);
    }
    /// The watched services' own names while more than one is watched (`remember_watched_services`),
    /// replacing the last list. Guard-only: never returned or saved.
    fn set_services(&self, names: &[String]) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .set_services(names);
    }
    fn snapshot(&self) -> NameGuard {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}
/// At most this many watched services' names are held (the webview watches at most four).
const WATCHED_SERVICES: usize = 8;
/// A watched service's name is at most this many characters (the webview keeps 120).
const SERVICE_NAME_CHARS: usize = 200;
/// The services Ozzie watches, by their own Planning Center names, while more than one is (the
/// webview's App.tsx; owner request 2026-11-21): held in memory only so `agent_step` refuses a request
/// that still holds one (core native-auth name_guard.rs `service_named`), as the page itself does
/// before anything is sent. Never saved, logged or returned; an empty list (one service) clears them.
#[tauri::command]
fn remember_watched_services(session: tauri::State<'_, SessionNames>, names: Vec<String>) {
    let names: Vec<String> = names
        .into_iter()
        .take(WATCHED_SERVICES)
        .map(|name| name.chars().take(SERVICE_NAME_CHARS).collect())
        .collect();
    session.set_services(&names);
}
/// The Sunday check, setup's picker and a note opened with its person in To take turns on the one
/// Planning Center connection; core `sunday_check::Turns` holds the rule. A second check is refused
/// rather than interleaved. A check waits out a picker read or a note (each bounded, under
/// `CHECK_WAITS_FOR_PICKER`) so it never records `busy` gaps because of them; a picker read waits
/// for the others up to `sunday_picker::WAIT_FOR_CONTROLLER`, then answers `busy`; a note never
/// waits (draft_apps::open_draft_to).
type SundayChecks = sunday_check::Turns;
/// How long a check waits for the turn: longer than a change can hold it (core
/// `change::LONGEST_TURN`, 65 s; its sign-in is renewed before it takes the turn). A note's read holds
/// it about 23 s at the very worst (its 8 s
/// deadline, then an identity check already under way, which the sign-in client limits to 15 s; a
/// page read is limited to 5 s; it never renews the sign-in), so a check outlasts it. A picker read
/// (up to 10 s waiting for the connection, then the identity check and one page) can take about this
/// long at the very worst; one that first renews the sign-in (`renewed_auth`: up to `RENEWAL_WAITS`
/// for a sign-in or Disconnect under way, then a token request and an identity check, each limited
/// to 15 s) can take longer, and a check waiting for it then answers `busy`.
const CHECK_WAITS_FOR_PICKER: Duration = Duration::from_secs(75);
/// How long a renewal waits for a sign-in, a check of the saved sign-in, a church-switch answer or
/// Disconnect under way to finish before the read answers `busy` (`renewed_auth`).
const RENEWAL_WAITS: Duration = Duration::from_secs(10);
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
/// Async so a one-click hand-over's Keychain reads never run on the main thread. Carries the open
/// "Switch Ozzie to this church?" question and any sign-in still waiting to be signed out.
#[tauri::command]
async fn connection_status(
    consumer: tauri::State<'_, Consumer>,
    smoke: tauri::State<'_, Smoke>,
    sign_ins: tauri::State<'_, SignIns>,
    app: tauri::AppHandle,
) -> Result<Option<StatusView>, ConsumerError> {
    if smoke.enabled && !smoke.ready.swap(true, Ordering::SeqCst) {
        println!("native-lifecycle: React rendered and requested status over IPC");
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(500));
            app.exit(0);
        });
    }
    let consumer = consumer.inner().clone();
    let sign_ins = sign_ins.inner().clone();
    // A refused hand-over leaves the finder in place; its own status is reported.
    tauri::async_runtime::spawn_blocking(move || {
        let view = consumer.0.view().map_err(ConsumerError::from);
        // The page learns of a grant here: what the sign-in was for is settled with it (`SignIns::note`).
        sign_ins.note();
        view
    })
    .await
    .map_err(|_| ConsumerError::NativeUnavailable)?
}
/// `operations` (optional, default false) opts in to the Calendar, People and Groups scopes for
/// the Sunday check's operations reads; `check_ins` and `registrations` (optional, default false)
/// each opt in to that product's counts. Each Planning Center product scope permits read and
/// write in that product; Ozzie's reads are GET source reads (its only writes are change.rs's one
/// confirmed change and its undo), and it asks for Services alone unless the person chooses more. `ConnectionStatus.scopes` reports what Planning Center actually
/// granted, read from its token response; a grant wider than asked fails as `scope-mismatch`
/// and saves nothing. A new sign-in revokes the saved credential it replaces. One that ends bound
/// to another church changes nothing about the earlier one until the person answers
/// (`answer_church_switch`); while that question is open, sign-ins wait (`switch-pending`).
/// `purpose` (optional) says what the sign-in is for (`SignInFor`): only one started for the rooms,
/// follow-ups and group reads lets its grant turn their switch on (`set_operations_reads`).
/// `again` (optional, the organization signed in to, which it must name) makes it a sign-in again for that church: it
/// asks for what the church's saved sign-in holds now, in place of the three choices and `purpose` (`again_ask`).
// Tauri passes each IPC argument by name; grouping them would change what the webview sends.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
async fn connect_planning_center(
    consumer: tauri::State<'_, Consumer>,
    app: tauri::AppHandle,
    client_id: String,
    organization: String,
    registered: bool,
    operations: Option<bool>,
    check_ins: Option<bool>,
    registrations: Option<bool>,
    purpose: Option<SignInFor>,
    again: Option<String>,
) -> Result<ConnectionStatus, ConsumerError> {
    let consumer = consumer.inner().clone();
    let ask = match again {
        // A sign-in again is for the church these IDs sign in to, never another one's access.
        Some(church) if church != organization => {
            return Err(AuthError::InvalidConfiguration.into());
        }
        Some(church) => Ask::Again(church),
        None => Ask::Chosen(
            Scopes::asked(
                operations.unwrap_or(false),
                check_ins.unwrap_or(false),
                registrations.unwrap_or(false),
            ),
            purpose,
        ),
    };
    tauri::async_runtime::spawn_blocking(move || {
        sign_in(&consumer, &app, ask, |consumer| {
            Ok(consumer
                .0
                .prepare(client_id, organization, registered, Purpose::SignIn)?)
        })
    })
    .await
    .map_err(|_| ConsumerError::NativeUnavailable)?
}
/// One-click connect: Ozzie's built-in registration; Planning Center names the organization
/// after sign-in, and the connection is then bound to it (`Consumer::settle`). Same scopes,
/// Keychain storage and GET-only reads as `connect_planning_center`. `again` (optional) names the
/// church this is a sign-in again for (the church in use, or the one in "Sign in to {church}
/// instead"): it asks for what that church's saved sign-in holds now (`again_ask`). For a church
/// saved here other than the one in use it is bound to that church, with the same registration,
/// so Planning Center can't give that church's access to another one (`bound_again`).
#[tauri::command]
async fn connect_planning_center_app(
    consumer: tauri::State<'_, Consumer>,
    app: tauri::AppHandle,
    operations: Option<bool>,
    check_ins: Option<bool>,
    registrations: Option<bool>,
    purpose: Option<SignInFor>,
    again: Option<String>,
) -> Result<ConnectionStatus, ConsumerError> {
    let consumer = consumer.inner().clone();
    let ask = match again {
        Some(church) => Ask::Again(church),
        None => Ask::Chosen(
            Scopes::asked(
                operations.unwrap_or(false),
                check_ins.unwrap_or(false),
                registrations.unwrap_or(false),
            ),
            purpose,
        ),
    };
    tauri::async_runtime::spawn_blocking(move || {
        let bound = match &ask {
            Ask::Again(church) => {
                let held = consumer.0.held(church).is_some();
                let reads_on = app
                    .path()
                    .app_data_dir()
                    .ok()
                    .and_then(|dir| operations_reads_saved(&dir, church));
                (bound_again(church, consumer.0.church_in_use().as_deref(), held)
                    || widens_unsaved(held, reads_on))
                .then(|| church.clone())
            }
            Ask::Chosen(..) => None,
        };
        sign_in(&consumer, &app, ask, |consumer| match bound {
            Some(church) => Ok(consumer
                .0
                .prepare(String::new(), church, true, Purpose::SignIn)?),
            None => Ok(consumer.0.prepare_finder()?),
        })
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
/// loopback receiver finishes it, and the app polls `connection_status`. A watcher brings Ozzie
/// forward when the browser part ends (`watch_sign_in`).
fn sign_in(
    consumer: &Consumer,
    app: &tauri::AppHandle,
    ask: Ask,
    prepare: impl FnOnce(&Consumer) -> Result<Arc<AuthController>, ConsumerError>,
) -> Result<ConnectionStatus, ConsumerError> {
    {
        // Before this sign-in can add a grant, the church in use gets its rooms-and-groups answer (re-check NH1).
        decide_for_current_church(consumer, app);
        // Then what it asks for: a sign-in again reads that answer and what the church holds, before anything replaces it.
        let (scopes, purpose, church) = match ask {
            Ask::Chosen(scopes, purpose) => (scopes, purpose, None),
            Ask::Again(church) => {
                let (scopes, purpose) =
                    again_for(consumer, app.path().app_data_dir().ok().as_deref(), &church);
                (scopes, purpose, Some(church))
            }
        };
        let (_transition, generation) = consumer
            .1
            .enter()
            .ok_or(ConsumerError::Authentication(AuthError::Busy))?;
        let auth = prepare(consumer)?;
        // This sign-in replaced any earlier one: from now on, its purpose is the one a grant is judged by (for a sign-in
        // again, only when Planning Center granted it for that church).
        app.state::<SignIns>()
            .started(purpose, auth.clone(), church);
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
        consumer.0.attach_receiver(&auth, receiver)?;
        if !consumer.1.current(generation) {
            consumer.0.stop_current();
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
        watch_sign_in(app.clone(), auth.clone());
        auth.status().map_err(ConsumerError::from)
    }
}
/// How often the sign-in watcher looks, and for how long at most (the attempt's own five minutes, and a little).
const WATCH_EVERY: Duration = Duration::from_millis(250);
const WATCH_FOR: Duration = Duration::from_secs(5 * 60 + 15);
/// What the watcher does once a sign-in leaves the browser: bring Ozzie forward and say so when it connected, or
/// when Planning Center ended it (a refusal, a failure); nothing when it was cancelled or ran out of time on this
/// Mac, where the person already is. None while it is still waiting or being checked.
#[derive(Debug, PartialEq, Eq)]
enum SignInEnd {
    Connected,
    FromTheBrowser,
    HereOnThisMac,
}
/// `handed_over`: a one-click sign-in that connected and was handed over (`AuthController::handed_over`), whose own
/// status then reads cancelled. The page's status read can hand it over before the watcher looks (review L9).
fn sign_in_end(status: &ConnectionStatus, handed_over: bool) -> Option<SignInEnd> {
    if handed_over {
        return Some(SignInEnd::Connected);
    }
    match (&status.state, &status.problem) {
        (ConnectionState::Waiting | ConnectionState::Checking, _) => None,
        (ConnectionState::Connected, _) => Some(SignInEnd::Connected),
        (_, Some(AuthError::Cancelled | AuthError::Expired) | None) => {
            Some(SignInEnd::HereOnThisMac)
        }
        _ => Some(SignInEnd::FromTheBrowser),
    }
}
/// Onboarding spec S4: when the browser sign-in ends, Ozzie comes to the front by itself (when macOS keeps the browser
/// in front, Ozzie opens its own app, and the Dock bounces: `always_on::ask_to_front`), and the page hears
/// `ozzie:signed-in` on a connection.
fn watch_sign_in(app: tauri::AppHandle, auth: Arc<AuthController>) {
    std::thread::spawn(move || {
        let started = std::time::Instant::now();
        while started.elapsed() < WATCH_FOR {
            std::thread::sleep(WATCH_EVERY);
            // A busy controller (the code being exchanged) is looked at again next time.
            let Ok(status) = auth.status() else { continue };
            match sign_in_end(&status, auth.handed_over()) {
                None => continue,
                Some(SignInEnd::Connected) => {
                    always_on::bring_forward(&app);
                    let _ = app.emit("ozzie:signed-in", ());
                }
                Some(SignInEnd::FromTheBrowser) => always_on::bring_forward(&app),
                Some(SignInEnd::HereOnThisMac) => {}
            }
            return;
        }
    });
}
#[tauri::command]
async fn cancel_connection(consumer: tauri::State<'_, Consumer>) -> Result<(), ConsumerError> {
    let consumer = consumer.inner().clone();
    tauri::async_runtime::spawn_blocking(move || consumer.stop())
        .await
        .map_err(|_| ConsumerError::NativeUnavailable)
}
/// Checks a saved sign-in (on launch, before a check, or "Check saved connection"). Only the church
/// Ozzie last used is checked into use: when Settings name another church, that one is checked
/// instead and the other reported as `declined` (core `Connections::prepare_check`). Once it checks
/// out, any other church's sign-in saved on this Mac is asked about; nothing is signed out here.
#[tauri::command]
async fn check_saved_connection(
    consumer: tauri::State<'_, Consumer>,
    app: tauri::AppHandle,
    client_id: String,
    organization: String,
    registered: bool,
) -> Result<StatusView, ConsumerError> {
    let consumer = consumer.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (_transition, generation) = consumer
            .1
            .enter()
            .ok_or(ConsumerError::Authentication(AuthError::Busy))?;
        let auth = consumer
            .0
            .prepare_check(client_id, organization, registered)?;
        if !consumer.1.current(generation) {
            auth.cancel();
            return Err(AuthError::Cancelled.into());
        }
        let status = auth.refresh()?;
        consumer.0.after_check(&auth);
        // Launch: the church's rooms-and-groups answer is decided from the scopes it holds now, before any new grant.
        if status.state == ConnectionState::Connected
            && let Ok(dir) = app.path().app_data_dir()
        {
            decide_before_grant(
                &dir,
                &status.organization,
                status.scopes.is_some_and(|scopes| scopes.operations()),
                &app.state::<SignIns>(),
            );
        }
        Ok(consumer.0.view_of(status))
    })
    .await
    .map_err(|_| ConsumerError::NativeUnavailable)?
}
#[tauri::command]
async fn disconnect_planning_center(
    consumer: tauri::State<'_, Consumer>,
    changes: tauri::State<'_, changes::ChangesState>,
    app: tauri::AppHandle,
) -> Result<ConnectionStatus, ConsumerError> {
    let consumer = consumer.inner().clone();
    let changes = changes.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        disconnect_and_leave(&consumer, |left| changes::left(&app, &changes, left))
    })
    .await
    .map_err(|_| ConsumerError::NativeUnavailable)?
}
/// Disconnect, then, whatever it returned, `leave` the church being left: its changes are dropped and
/// turned off (`changes::left`). The person asked to leave it, so this holds when the revoke is out of
/// reach, the Keychain refuses a read or the delete, the wait for a read in flight ends `NotRevoked`,
/// or another sign-in step is under way (busy: the church is then read without the transition, as
/// status polls read it). Live test 2026-11-17: a refused Keychain delete left the switch on.
fn disconnect_and_leave(
    consumer: &Consumer,
    leave: impl FnOnce(Option<&str>),
) -> Result<ConnectionStatus, ConsumerError> {
    let Some((_transition, _)) = consumer.1.enter() else {
        leave(bound_church(consumer).as_deref());
        return Err(ConsumerError::Authentication(AuthError::Busy));
    };
    let left = bound_church(consumer);
    let result = consumer.0.disconnect().map_err(ConsumerError::from);
    leave(left.as_deref());
    result
}
/// The person's answer to "Switch Ozzie to this church?" (`question`: the question's native id).
/// `switch` checks the new church with Planning Center, then signs Ozzie out of every other saved
/// sign-in the question named (revoked first, deleted only once that worked); `stay` checks the
/// church that stays, then signs out of the new one. If either check fails nothing changes. The
/// page sends only the answer: which sign-ins are signed out is decided natively. Returns the
/// church now in use; the same answer sent again returns it again.
/// The church a switch puts in use gets its rooms-and-groups answer at once: off, unless it already has one, so a later
/// Sign in again or a relaunch can't record it on from a grant that wasn't for these reads (review 2026-11-18).
#[tauri::command]
async fn answer_church_switch(
    consumer: tauri::State<'_, Consumer>,
    changes: tauri::State<'_, changes::ChangesState>,
    app: tauri::AppHandle,
    decision: Decision,
    question: u64,
) -> Result<SwitchAnswer, ConsumerError> {
    let consumer = consumer.inner().clone();
    let changes = changes.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (_transition, _) = consumer
            .1
            .enter()
            .ok_or(ConsumerError::Authentication(AuthError::Busy))?;
        let before = bound_church(&consumer);
        let answer = consumer.0.answer(decision, question)?;
        let after = bound_church(&consumer);
        if decision == Decision::Switch
            && let Ok(dir) = app.path().app_data_dir()
        {
            decide_at_switch(&dir, &answer.organization);
        }
        // Another church in use: changes for the one left are dropped and turned off.
        if before != after {
            changes::left(&app, &changes, before.as_deref());
        }
        Ok(answer)
    })
    .await
    .map_err(|_| ConsumerError::NativeUnavailable)?
}
/// Tries again to sign out of the sign-ins the person already chose to leave, and nothing else.
#[tauri::command]
async fn retry_church_sign_out(
    consumer: tauri::State<'_, Consumer>,
) -> Result<StatusView, ConsumerError> {
    let consumer = consumer.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (_transition, _) = consumer
            .1
            .enter()
            .ok_or(ConsumerError::Authentication(AuthError::Busy))?;
        Ok(consumer.0.retry()?)
    })
    .await
    .map_err(|_| ConsumerError::NativeUnavailable)?
}
/// After Planning Center refused to sign Ozzie out of a sign-in the person chose to leave, removes
/// it from this Mac without a revoke, on the person's click. Only refused ones, chosen natively.
#[tauri::command]
async fn remove_refused_sign_ins(
    consumer: tauri::State<'_, Consumer>,
) -> Result<StatusView, ConsumerError> {
    let consumer = consumer.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (_transition, _) = consumer
            .1
            .enter()
            .ok_or(ConsumerError::Authentication(AuthError::Busy))?;
        Ok(consumer.0.remove_refused()?)
    })
    .await
    .map_err(|_| ConsumerError::NativeUnavailable)?
}
/// Read-only Sunday readiness check for one plan, using the connected session.
// Tauri passes each IPC argument by name; grouping them would change what the webview sends.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
async fn check_sunday(
    consumer: tauri::State<'_, Consumer>,
    checks: tauri::State<'_, SundayChecks>,
    names: tauri::State<'_, SessionNames>,
    people: tauri::State<'_, CheckedPeople>,
    changes: tauri::State<'_, changes::ChangesState>,
    app: tauri::AppHandle,
    service_type_id: String,
    plan_id: String,
    // Church rules: kids teams with the background-check rule on. Their scheduled people's cleared
    // People background checks are read; absent or empty, none are. Validated natively.
    kids_team_ids: Option<Vec<String>>,
    // Church rules: the People forms to watch, once forms are turned on (absent: off, no form is
    // read; empty: on, the list only). At most ten numeric ids, validated natively.
    form_ids: Option<Vec<String>>,
    // Church rules: the one Check-Ins event to read, when chosen. A numeric id, validated natively.
    checkins_event_id: Option<String>,
) -> Result<SundayCapture, ConsumerError> {
    let consumer = consumer.inner().clone();
    let checks = checks.inner().clone();
    let names = names.inner().clone();
    let people = people.inner().clone();
    let changes = changes.inner().clone();
    let kids_team_ids = kids_team_ids.unwrap_or_default();
    // Rooms, follow-ups and group events only while this church's Settings switch is on (first-run review H1).
    let operations = match (current_church(&consumer), app.path().app_data_dir()) {
        (Some((organization, _)), Ok(dir)) => switch_at_check(&dir, &organization),
        _ => false,
    };
    tauri::async_runtime::spawn_blocking(move || {
        let _turn = checks
            .take(Reader::Check, CHECK_WAITS_FOR_PICKER)
            .map_err(|error| ConsumerError::SundayCheck(error.reason()))?;
        // Disconnecting or quitting cancels the controller, which ends the check.
        let (capture, read) = read_renewing(&consumer, |auth| {
            sunday_check::check_sunday_with(
                auth,
                &service_type_id,
                &plan_id,
                &kids_team_ids,
                sunday_check::ChurchReads {
                    forms: form_ids.as_deref(),
                    checkins_event: checkins_event_id.as_deref(),
                    operations,
                },
                &AtomicBool::new(false),
            )
        })?
        .map_err(|error| ConsumerError::SundayCheck(error.reason()))?;
        names.remember(&capture);
        // Who "Open in Mail" or "Open in Messages" may put in To (draft_apps::open_draft_to).
        people.remember(&capture);
        // The open roles and who could help, for a change the leader confirms (changes.rs).
        changes::checked(&changes, &capture);
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
/// "Also check rooms, follow-ups and group events" (Settings): whether the check reads rooms and Calendar
/// conflicts, People follow-ups, and the scheduled people's group memberships and events. Kept per church in the app
/// data folder (`{"churches": {"<organization>": bool}}`), so a church switch never carries "on" over. A sign-in
/// that holds those scopes (allowing People to fill in To on a note) never turns it on (first-run review H1; re-check
/// NH1): each church's answer is decided and saved before any new grant can happen.
const OPERATIONS_FILE: &str = "operations-reads.json";
fn read_switches(dir: &std::path::Path) -> std::collections::BTreeMap<String, bool> {
    std::fs::read(dir.join(OPERATIONS_FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|value| {
            value["churches"].as_object().map(|churches| {
                churches
                    .iter()
                    .filter(|(org, _)| ozzie_native_auth::oauth::numeric_id(org))
                    .filter_map(|(org, on)| on.as_bool().map(|on| (org.clone(), on)))
                    .collect()
            })
        })
        .unwrap_or_default()
}
fn write_switches(
    dir: &std::path::Path,
    churches: &std::collections::BTreeMap<String, bool>,
) -> bool {
    std::fs::create_dir_all(dir).is_ok()
        && std::fs::write(
            dir.join(OPERATIONS_FILE),
            serde_json::json!({ "churches": churches }).to_string(),
        )
        .is_ok()
}
/// A church's saved answer, if decided.
fn operations_reads_saved(dir: &std::path::Path, organization: &str) -> Option<bool> {
    read_switches(dir).get(organization).copied()
}
/// Before any new grant (at launch's check of the saved sign-in, and before a sign-in opens the browser): a church
/// not yet decided gets the truthful start from the scopes it holds NOW, before the new grant, and from what granted
/// them. A sign-in Ozzie started this session and Planning Center granted for this church (`sign_ins`) may start it on
/// only when it was started for these reads; any other (the To line's People, Sign in again, Check-Ins) starts it off,
/// as a church first seen through a new sign-in is at a check (review 2026-11-18). Otherwise, as a church updating from
/// 0.2.x: its saved sign-in's scopes came from the Settings action (the only way to ask for them before the People
/// moment existed), so it stays on; Services alone is off. A lost file is decided again by the same rule.
fn decide_before_grant(
    dir: &std::path::Path,
    organization: &str,
    operations_held: bool,
    sign_ins: &SignIns,
) {
    let mut churches = read_switches(dir);
    if !churches.contains_key(organization) {
        let granted_here = sign_ins.granted_for(organization);
        let on = operations_held
            && granted_here.is_none_or(|purpose| purpose == Some(SignInFor::Operations));
        churches.insert(organization.to_owned(), on);
        write_switches(dir, &churches);
    }
}
/// A church a switch puts in use: off, saved so, unless it already has an answer (`answer_church_switch`).
fn decide_at_switch(dir: &std::path::Path, organization: &str) {
    switch_at_check(dir, organization);
}
/// At a check: the church's answer; a church never decided (first seen through a new sign-in, e.g. a church switch)
/// is off, saved so.
fn switch_at_check(dir: &std::path::Path, organization: &str) -> bool {
    let mut churches = read_switches(dir);
    if let Some(on) = churches.get(organization) {
        return *on;
    }
    churches.insert(organization.to_owned(), false);
    write_switches(dir, &churches);
    false
}
fn set_switch(dir: &std::path::Path, organization: &str, on: bool) -> bool {
    let mut churches = read_switches(dir);
    churches.insert(organization.to_owned(), on);
    write_switches(dir, &churches)
}
/// The church in use and whether its sign-in holds the Calendar, People and Groups scopes, when connected.
fn current_church(consumer: &Consumer) -> Option<(String, bool)> {
    let status = consumer.0.current()?.status().ok()?;
    (status.state == ConnectionState::Connected).then(|| {
        (
            status.organization,
            status.scopes.is_some_and(|scopes| scopes.operations()),
        )
    })
}
/// The church a sign-in decides before it can add a grant, and whether that may start its reads on: connected, from the
/// scopes this session verified; otherwise the church in use (`church_in_use`, never a sign-in still in the browser or
/// just cancelled for another church), when a sign-in is saved for it, as not held: a record this session hasn't
/// verified never starts them on (review 2026-11-19), and Sign in again now asks for what that record holds, so the
/// church is decided first. None with no church in use or nothing saved for it.
fn church_before_grant(consumer: &Consumer) -> Option<(String, bool)> {
    if let Some(connected) = current_church(consumer) {
        return Some(connected);
    }
    let organization = consumer.0.church_in_use()?;
    consumer.0.held(&organization)?;
    Some((organization, false))
}
/// Decides the church in use before a sign-in can add a grant, connected or not (review 2026-11-18, late: a sign-in
/// again after Planning Center stopped accepting the saved one asks for the access it holds, so it is decided first).
fn decide_for_current_church(consumer: &Consumer, app: &tauri::AppHandle) {
    if let (Some((organization, held)), Ok(dir)) =
        (church_before_grant(consumer), app.path().app_data_dir())
    {
        decide_before_grant(&dir, &organization, held, &app.state::<SignIns>());
    }
}
/// What a browser sign-in asks Planning Center for and what it is for: as the page chose, or, for a sign-in again for a
/// church (`again`), from what that church holds now (`again_for`).
enum Ask {
    Chosen(Scopes, Option<SignInFor>),
    Again(String),
}
/// A sign-in again for `church` (Settings' Connect again, Sign in again once Planning Center stopped accepting the
/// saved sign-in, first run's Connect for a church saved here, "Sign in to {church} instead"): the access its saved
/// sign-in holds and whether its reads are on, both read here, never from the page (`again_ask`).
fn again_for(
    consumer: &Consumer,
    dir: Option<&std::path::Path>,
    church: &str,
) -> (Scopes, Option<SignInFor>) {
    let reads_on = dir.and_then(|dir| operations_reads_saved(dir, church));
    again_ask(consumer.0.held(church), reads_on)
}
/// Whether a one-click sign-in again for `church` is bound to it: when a sign-in is saved for it and it isn't the church
/// in use ("Sign in to {church} instead"), so a browser still signed in to the church in use can't give that one this
/// church's access without a question (a grant for another church then fails, nothing saved; review 2026-11-19). For
/// the church in use it stays one click, so signing in to another church asks "Switch Ozzie to this church?" as before.
fn bound_again(church: &str, in_use: Option<&str>, saved: bool) -> bool {
    saved && in_use != Some(church)
}
/// Whether a sign-in again asks for more than Services with nothing saved for the church (`again_ask`: its rooms and
/// groups switch still on, after a switch to another church system and back, or a disconnect). It is then bound to that
/// church, so a browser signed in to another one can't give it Calendar, People and Groups unasked: Planning Center's
/// grant for another church fails and nothing is saved (release review 2026-11-19, M1).
fn widens_unsaved(held: bool, reads_on: Option<bool>) -> bool {
    !held && reads_on == Some(true)
}
/// What a sign-in again asks for: exactly the access the church's sign-in on this Mac holds now (Services, and Calendar,
/// People and Groups, Check-Ins and Registrations as each was granted), so Planning Center's page lists what the church
/// already allowed and allowing it drops nothing; never more (review 2026-11-18, late). It is for the rooms, follow-ups
/// and group reads (`purpose` "operations") only while their switch is on for that church and it holds the access;
/// held with the reads off or undecided it is for nothing, so its grant can't turn them on (`decide_before_grant`,
/// `reads_may_go_on`). Nothing saved (or unreadable: a switch to another church system and back, or a disconnect,
/// removed it): Calendar, People and Groups beside Services, for these reads, while their switch is still on for that
/// church, since it only ever went on with that access held (release review 2026-11-19: switching back from B1 Church
/// or Breeze otherwise dropped them); otherwise Services alone, for nothing. Check-Ins and Registrations aren't known
/// then, and Settings says they were lost.
fn again_ask(held: Option<Scopes>, reads_on: Option<bool>) -> (Scopes, Option<SignInFor>) {
    let held = held.unwrap_or(Scopes::asked(reads_on == Some(true), false, false));
    let purpose = (held.operations() && reads_on == Some(true)).then_some(SignInFor::Operations);
    (held, purpose)
}
/// What a browser sign-in was started for, as the page says (`connect_planning_center(_app)`'s `purpose`): the rooms,
/// follow-ups and group reads (Settings' "Also check rooms, follow-ups and group events", the offer after the first
/// check), or People for a note's To line. Absent: any other sign-in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
enum SignInFor {
    Operations,
    PeopleForTo,
}
/// The sign-in Ozzie started last, what it was for, and the church it was granted for once a status showed it connected.
/// Each new sign-in replaces it, as it replaces the sign-in itself (`Connections::prepare`, `prepare_finder`).
struct StartedSignIn {
    purpose: Option<SignInFor>,
    auth: Arc<AuthController>,
    granted: Option<String>,
    /// A sign-in again's church (`again`): its purpose holds only for a grant for that church.
    again: Option<String>,
}
#[derive(Clone, Default)]
struct SignIns(Arc<Mutex<Option<StartedSignIn>>>);
impl SignIns {
    fn started(
        &self,
        purpose: Option<SignInFor>,
        auth: Arc<AuthController>,
        again: Option<String>,
    ) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(StartedSignIn {
            purpose,
            auth,
            granted: None,
            again,
        });
    }
    /// Settles the church the last sign-in was granted for, once its status says it connected (or, for a one-click
    /// sign-in, that it was handed over), so a later check that retires its controller doesn't undo it.
    fn note(&self) {
        let mut last = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(started) = last.as_mut()
            && started.granted.is_none()
            && let Ok(status) = started.auth.status_or_busy()
            && (status.state == ConnectionState::Connected || started.auth.handed_over())
            && !status.organization.is_empty()
        {
            // A sign-in again whose one click Planning Center gave to another church is for nothing there: that
            // church's switch never let it be for the reads (review 2026-11-19).
            if started
                .again
                .as_deref()
                .is_some_and(|church| church != status.organization)
            {
                started.purpose = None;
            }
            started.granted = Some(status.organization);
        }
    }
    /// What the last sign-in was started for, when Planning Center granted it for `organization`; None when no sign-in
    /// this session was (the saved sign-in from an earlier launch, or one still in the browser).
    fn granted_for(&self, organization: &str) -> Option<Option<SignInFor>> {
        self.note();
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .filter(|s| s.granted.as_deref() == Some(organization))
            .map(|s| s.purpose)
    }
    /// Whether the last sign-in was started for the rooms, follow-ups and group reads and was granted for `organization`.
    fn asked_for_reads(&self, organization: &str) -> bool {
        self.note();
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .is_some_and(|s| {
                s.purpose == Some(SignInFor::Operations)
                    && s.granted.as_deref() == Some(organization)
            })
    }
}
/// Whether the switch may go on for the church in use (`church`: it and whether its connection holds Calendar, People
/// and Groups): only with that access held, and then on a person's own press (Settings' switch, the offer's button when
/// the access is already held), or after a sign-in started for these reads that Planning Center granted. Never after a
/// sign-in for a note's To line, whatever the page asks (review M1; first-run review H1).
fn reads_may_go_on(church: &(String, bool), pressed: bool, sign_ins: &SignIns) -> bool {
    church.1 && (pressed || sign_ins.asked_for_reads(&church.0))
}
/// Settings' "Also check rooms, follow-ups and group events" turns the reads on for the church in use; turning them
/// off stops them at the next check. `pressed`: a person pressed a button for it just now; absent or false, the page
/// asks after a sign-in. On is refused (`not-granted`) unless `reads_may_go_on`. `not-connected` with no church.
#[tauri::command]
fn set_operations_reads(
    app: tauri::AppHandle,
    consumer: tauri::State<'_, Consumer>,
    sign_ins: tauri::State<'_, SignIns>,
    on: bool,
    pressed: Option<bool>,
) -> Result<bool, &'static str> {
    let church = current_church(&consumer).ok_or("not-connected")?;
    if on && !reads_may_go_on(&church, pressed.unwrap_or(false), &sign_ins) {
        return Err("not-granted");
    }
    let organization = church.0;
    let dir = app.path().app_data_dir().map_err(|_| "unavailable")?;
    if set_switch(&dir, &organization, on) {
        Ok(on)
    } else {
        Err("unavailable")
    }
}
/// Whether the reads are on for the church in use, as the next check will use them (undecided: off). Never turns
/// anything on by itself.
#[tauri::command]
fn operations_reads(app: tauri::AppHandle, consumer: tauri::State<'_, Consumer>) -> bool {
    let Some((organization, _)) = current_church(&consumer) else {
        return false;
    };
    app.path()
        .app_data_dir()
        .ok()
        .and_then(|dir| operations_reads_saved(&dir, &organization))
        .unwrap_or(false)
}
/// The church the session's sign-in is bound to, whatever state that sign-in is in (stored and
/// unchecked, expired, failed or connected); for a one-click sign-in still under way, the church whose
/// connection it replaced (Disconnect revokes that one too: review X, L-c). Used where a church is
/// being left, so its changes are turned off even when its sign-in isn't connected.
fn bound_church(consumer: &Consumer) -> Option<String> {
    let (auth, finding) = consumer.0.settle().ok()??;
    if finding {
        return consumer.0.replaced_church();
    }
    let organization = auth.bound_to().1;
    (!organization.is_empty()).then(|| organization.to_owned())
}
/// This session's verified Planning Center connection, or NotConnected, as it is: never renewed here.
/// The Sunday check and setup's picker read through `read_renewing`, which renews a sign-in that needs
/// it first (`renewed_auth`). This is the To line's lookup
/// (draft_apps::open_draft_to): a renewal (up to about 30 s) would run before its 8-second limit
/// starts; a sign-in Planning Center no longer accepts makes it answer as it always has, and the note
/// opens with no one in To.
fn session_auth(consumer: &Consumer) -> Result<Arc<AuthController>, ConsumerError> {
    let (auth, finding) = consumer.0.settle()?.ok_or(ConsumerError::NotConnected)?;
    if finding {
        return Err(ConsumerError::NotConnected);
    }
    // Never waits for a Keychain write in progress: a controller mid-write isn't connected yet.
    if auth.status_or_busy()?.state != ConnectionState::Connected {
        return Err(ConsumerError::NotConnected);
    }
    Ok(auth)
}
/// The session's connection (`session_auth`) with its sign-in renewed first when it needs renewing,
/// and whether it renewed it just now. Planning Center's access tokens last
/// two hours, and only "Check saved connection" (on launch, or in Settings) renewed one, so from two
/// hours after Ozzie started every read failed (0.1.9, 0.2.0). Now a read whose sign-in needs
/// renewing renews it first, once, through that same renewal (core `AuthController::renew_if_due`),
/// holding the transition lock so no sign-in, check of the saved sign-in, church-switch answer or
/// Disconnect runs meanwhile; one of those already running is waited for up to `RENEWAL_WAITS`, then
/// this read is `busy`. A renewal that fails ends the read before anything is read.
fn renewed_auth(consumer: &Consumer) -> Result<(Arc<AuthController>, bool), ConsumerError> {
    renewed_auth_within(consumer, RENEWAL_WAITS)
}
fn renewed_auth_within(
    consumer: &Consumer,
    wait: Duration,
) -> Result<(Arc<AuthController>, bool), ConsumerError> {
    let auth = session_auth(consumer)?;
    if !auth.renewal_due() {
        return Ok((auth, false));
    }
    let church = auth.bound_to().1.to_owned();
    let not_renewed = |error: SourceError| ConsumerError::SignInNotRenewed(error.reason());
    let (_transition, generation) = consumer
        .1
        .enter_within(wait)
        .ok_or_else(|| not_renewed(SourceError::Busy))?;
    // Looked up again inside the lock: whatever held it (a check of the saved sign-in, a church-switch
    // answer, a new sign-in, Disconnect) may have replaced the session's controller meanwhile.
    let auth = session_auth(consumer)?;
    // The read was made for that church's Sunday (its plan ids are that church's): if the church in
    // use is another by now, it reads nothing (review N, 6).
    if auth.bound_to().1 != church {
        return Err(not_renewed(SourceError::Cancelled));
    }
    let renewed = auth.renew_if_due().map_err(not_renewed)?;
    // Cancelled or quitting meanwhile (`Consumer::stop`): nothing is read.
    if !consumer.1.current(generation) {
        return Err(not_renewed(SourceError::Cancelled));
    }
    Ok((auth, renewed))
}
/// One read on the session's connection (`renewed_auth`). When its identity check found that Planning
/// Center no longer accepts the sign-in's access token though Ozzie's clock gave it time left (that
/// clock doesn't count time this Mac spent asleep), and this read hadn't just renewed it, the sign-in is
/// renewed and the read made once more, once. Only the identity check, which reads nothing, came before.
fn read_renewing<T>(
    consumer: &Consumer,
    read: impl Fn(&AuthController) -> Result<T, SourceError>,
) -> Result<Result<T, SourceError>, ConsumerError> {
    let (auth, renewed) = renewed_auth(consumer)?;
    match read(&auth) {
        Err(SourceError::OrganizationUnverified) if !renewed && auth.renewal_due() => {
            let (again, _) = renewed_auth(consumer)?;
            // Once more for the same church only (review N, 6).
            if again.bound_to().1 != auth.bound_to().1 {
                return Err(ConsumerError::SignInNotRenewed(
                    SourceError::Cancelled.reason(),
                ));
            }
            Ok(read(&again))
        }
        result => Ok(result),
    }
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
        read_renewing(&consumer, |auth| {
            sunday_picker::service_types(auth, &AtomicBool::new(false))
        })?
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
        read_renewing(&consumer, |auth| {
            sunday_picker::upcoming_plans(auth, &service_type_id, &AtomicBool::new(false))
        })?
        .map_err(|error| ConsumerError::SundayChoices(error.reason()))
    })
    .await
    .map_err(|_| ConsumerError::NativeUnavailable)?
}
/// First run's "Which service should Ozzie watch?" (onboarding spec S5a): every service type with its next plan,
/// that plan's day and service times, and the church's time zone, soonest first. Read-only; nothing is saved.
#[tauri::command]
async fn pick_service(
    consumer: tauri::State<'_, Consumer>,
    checks: tauri::State<'_, SundayChecks>,
) -> Result<ServicePick, ConsumerError> {
    let consumer = consumer.inner().clone();
    let checks = checks.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _turn = picker_turn(&checks)?;
        read_renewing(&consumer, |auth| {
            sunday_picker::pick_service(auth, &AtomicBool::new(false))
        })?
        .map_err(|error| ConsumerError::SundayChoices(error.reason()))
    })
    .await
    .map_err(|_| ConsumerError::NativeUnavailable)?
}
/// Moving on by itself (spec §5.3): the same service type's first plan after `after_date` (`YYYY-MM-DD`, the
/// passed plan's local date), with its day and times; `null` while none is planned. Read-only.
#[tauri::command]
async fn next_plan(
    consumer: tauri::State<'_, Consumer>,
    checks: tauri::State<'_, SundayChecks>,
    service_type_id: String,
    after_date: String,
) -> Result<Option<PlanNext>, ConsumerError> {
    let consumer = consumer.inner().clone();
    let checks = checks.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _turn = picker_turn(&checks)?;
        read_renewing(&consumer, |auth| {
            sunday_picker::next_plan(auth, &service_type_id, &after_date, &AtomicBool::new(false))
        })?
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
    people: tauri::State<'_, CheckedPeople>,
    changes: tauri::State<'_, changes::ChangesState>,
    app: tauri::AppHandle,
    organization: String,
    path_id: String,
) -> Result<SundayCapture, ConsumerError> {
    let names = names.inner().clone();
    let people = people.inner().clone();
    let changes = changes.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let capture = sunday_check::load_recording(&recordings(&app)?, &organization, &path_id)
            .map_err(ConsumerError::Recording)?;
        names.remember(&capture);
        people.remember(&capture);
        // A recording never makes a change: the last live check's roles are dropped.
        changes::checked(&changes, &capture);
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
/// Removes this organization's saved recordings of the given plans only: a service the leader
/// stopped watching, with every plan of it Ozzie watched (watched-services.ts). Never automatic;
/// at most 32 plans, each a numeric id, or nothing is deleted.
#[tauri::command]
async fn delete_sunday_plan_recordings(
    app: tauri::AppHandle,
    organization: String,
    plan_ids: Vec<String>,
) -> Result<(), ConsumerError> {
    if plan_ids.len() > 32 {
        return Err(recording_io(std::io::ErrorKind::InvalidInput.into()));
    }
    tauri::async_runtime::spawn_blocking(move || {
        sunday_check::delete_plan_recordings(&recordings(&app)?, &organization, &plan_ids)
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
    // AI on this Mac: its app is asked, on this Mac only, whether the model still runs here (Ollama's cloud models never
    // do); one that doesn't is never ready (`not-on-this-mac`). Every question asks again before it goes.
    if status.route == "local"
        && let Ok(local) = ozzie_native_auth::local_ai::NativeLocalHttp::new(ozzie_native_auth::local_ai::SHOW_WAIT)
    {
        ozzie_native_auth::local_ai::mark_elsewhere(&mut status, model_route::load_config(dir).as_ref(), &local);
    }
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
    /// The waiting attempt's browser address, for "Open the page again" (review M3): the same attempt, not a new one.
    url: Arc<Mutex<Option<String>>>,
}
/// After a paid connect ends: come forward when the browser part ended (connected, payment cancelled, refused on
/// ozzie.church), never when nothing came back in time (`not-finished`, `expired`), when it was cancelled on this
/// Mac, or when it never reached the browser (review L6).
fn come_forward_after_paid(result: &Result<Account, ManagedError>, cancelled_here: bool) -> bool {
    !cancelled_here
        && !matches!(
            result,
            Err(ManagedError::NotFinished
                | ManagedError::Expired
                | ManagedError::Busy
                | ManagedError::Unavailable
                | ManagedError::BrowserUnavailable)
        )
}
/// Connects this Mac to Ozzie managed (hosted.rs): opens ozzie.church's sign-in in the browser, waits
/// up to five minutes for the loopback callback (an hour when it starts a plan), exchanges the
/// one-time code natively and keeps the device token in the Keychain. Returns the church's plan and
/// usage, never the token. `busy` while another connect waits.
#[tauri::command]
async fn managed_connect(
    managed: tauri::State<'_, ManagedConnect>,
    app: tauri::AppHandle,
    // "personal" starts that plan on the way (sign-in, then Stripe's page, one browser trip; an hour).
    plan: Option<String>,
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
        let attempt = hosted::ConnectAttempt::begin_for(&hosted, clock(), plan.as_deref())?;
        *managed.url.lock().unwrap_or_else(|e| e.into_inner()) = Some(attempt.url().to_owned());
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
        let connected = hosted::connect(
            &attempt,
            &hosted,
            &KeychainKeys,
            &managed.cancel,
            &*clock,
            &dir,
        );
        *managed.url.lock().unwrap_or_else(|e| e.into_inner()) = None;
        // Back from the browser by itself, as after a Planning Center sign-in (review L6 for when).
        if come_forward_after_paid(&connected, managed.cancel.load(Ordering::SeqCst)) {
            always_on::bring_forward(&app);
        }
        connected
    })
    .await
    .map_err(|_| ManagedError::Unavailable)?
}
/// "Open the page again" while a connect waits (spec S10b; review M3): the same attempt's address in the browser
/// again (same state, no new attempt), so it never races a new connect into `busy`. `no-attempt` when none waits.
#[tauri::command]
async fn managed_connect_reopen(
    managed: tauri::State<'_, ManagedConnect>,
) -> Result<(), &'static str> {
    let url = managed
        .url
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .ok_or("no-attempt")?;
    tauri::async_runtime::spawn_blocking(move || {
        let opened = std::process::Command::new("/usr/bin/open")
            .arg(&url)
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
    // The AI route changes: every Gemini signature goes (review F7).
    agent::forget_all_signatures();
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
        // A model on this Mac only at its app's own address and once checked (review L8).
        let config = model_route::usable_config(&dir).ok_or(ModelError::NotConfigured)?;
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
        let config = model_route::usable_config(&dir).ok_or(AgentError::NotConfigured)?;
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
    // While the app runs, the timer thread ends tasks past their ceiling (always_on::sweep_ledger).
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
    // A task that ends takes its Gemini signatures with it (review F7).
    if matches!(to.as_str(), "verified" | "failed" | "cancelled") {
        agent::forget_signatures(&task_id);
    }
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
    // The AI route changes: every Gemini signature goes (review F7).
    agent::forget_all_signatures();
    tauri::async_runtime::spawn_blocking(move || {
        let route = Route::parse(&route).ok_or(ModelError::InvalidRequest)?;
        // A model on this Mac only at Ollama's or LM Studio's own address on 127.0.0.1 (review L8).
        if route == Route::Local
            && base_url
                .as_deref()
                .is_some_and(|base| !model_route::local_base_allowed(base))
        {
            return Err(ModelError::InvalidRequest);
        }
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
    /// Debug builds only: the autopilot also opts in to Check-Ins (OZZIE_DEV_CHECK_INS=1; asks for consent).
    autopilot_check_ins: bool,
    /// Debug builds only: the autopilot also opts in to Registrations (OZZIE_DEV_REGISTRATIONS=1; asks for consent).
    autopilot_registrations: bool,
    /// Debug builds only: People forms for the autopilot's check (OZZIE_DEV_FORMS): "1" turns forms on with
    /// none chosen (the list only), or up to ten comma-separated form ids to watch.
    forms: String,
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
        autopilot_check_ins: get("OZZIE_DEV_CHECK_INS").as_deref() == Some("1"),
        autopilot_registrations: get("OZZIE_DEV_REGISTRATIONS").as_deref() == Some("1"),
        forms: get("OZZIE_DEV_FORMS")
            .filter(|v| {
                v == "1"
                    || (v.len() <= 400
                        && v.split(',').count() <= 10
                        && v.split(',').all(numeric_id))
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
/// The Sunday line, pinned by tests to phone_notice.rs `Line::SundayAttention` (the body now comes from the line).
// Read only by the tests; a test-only attribute here would hide the commands below from the tests that read this
// file as text.
#[allow(dead_code)]
const SUNDAY_NOTICE_BODY: &str = "Sunday coverage needs attention. Open Ozzie to see details.";
/// The webview asks for the coverage notice and passes no text: only the watched service's day as a closed word
/// (`day`: "sunday" … "saturday", "weekend" or "service"; absent: "service", so a non-Sunday service is never
/// called Sunday; onboarding spec §5.2). The capability grants none of the notification plugin's own commands, so
/// the webview cannot show any other notification text. While "A notice on your phone" is on, its fixed line also
/// goes to the leader's phone, after this one, unless the page says it stays on this Mac (`local_only`: a notice
/// only about a background check).
#[tauri::command]
fn notify_sunday_attention(
    app: tauri::AppHandle,
    local_only: Option<bool>,
    day: Option<String>,
) -> Result<(), &'static str> {
    use ozzie_native_auth::phone_notice::Line;
    use tauri_plugin_notification::NotificationExt;
    let line = Line::attention(day.as_deref().unwrap_or("service")).ok_or("invalid-day")?;
    let shown = app
        .notification()
        .builder()
        .title(SUNDAY_NOTICE_TITLE)
        .body(line.text())
        .show()
        .map_err(|_| "notification-unavailable");
    phone_notice::also_to_phone(&app, line, local_only);
    shown
}
fn main() {
    let smoke = std::env::args().any(|arg| arg == "--lifecycle-smoke");
    let consumer = Consumer::default();
    let cleanup = consumer.clone();
    let app = updater::manage(always_on::manage(tauri::Builder::default()))
        .plugin(tauri_plugin_notification::init())
        .manage(consumer)
        .manage(SundayChecks::default())
        .manage(SessionNames::default())
        .manage(ai_setup::ModelJob::default())
        .manage(ollama_setup::OllamaJob::default())
        .manage(CheckedPeople::default())
        .manage(changes::state())
        .manage(Ledger::default())
        .manage(ManagedConnect::default())
        .manage(SignIns::default())
        .manage(key_sheet::Desk::default())
        .manage(church_systems::ChurchSystems::default())
        .manage(local_tools::LocalTools::default())
        .manage(shortcuts::OpenedPage::default())
        .manage(text_size::TextSize::default())
        .manage(Smoke {
            enabled: smoke,
            ready: AtomicBool::new(false),
        })
        // At start, before any command can use it: open the task ledger and fail what an earlier
        // launch left admitted or running.
        .setup(|app| {
            let _ = app.state::<Ledger>().0.set(open_ledger(app.handle()));
            // Which church Ozzie uses, kept across launches before the page's first check: only
            // that church is checked into use (core `in_use`).
            if let Ok(dir) = app.path().app_data_dir() {
                app.state::<Consumer>()
                    .0
                    .keep_use_history(Arc::new(UseFile::new(dir.join("church-in-use.json"))));
            }
            // A shared copy left while sharing is off (a failed removal, a crash) is removed at
            // every start, with any half-written one; a failure here is tried again next start.
            if let Ok(dir) = app.path().app_data_dir() {
                let _ = shared_check::startup(&dir);
                // The copy for Siri and Shortcuts, by the same rule.
                let _ = ozzie_native_auth::shortcuts_check::startup(&dir);
            }
            // What a quit left of getting Ollama (a partial download, an unpacked copy) is removed at every start.
            ollama_setup::startup(app.handle());
            changes::setup(app.handle());
            updater::setup(app);
            phone_notice::setup(app);
            text_size::setup(app);
            always_on::setup(app)?;
            Ok(())
        })
        .on_window_event(always_on::on_window_event)
        .invoke_handler(tauri::generate_handler![
            remember_watched_services,
            connection_status,
            connect_planning_center,
            connect_planning_center_app,
            planning_center_app,
            cancel_connection,
            check_saved_connection,
            disconnect_planning_center,
            answer_church_switch,
            retry_church_sign_out,
            remove_refused_sign_ins,
            check_sunday,
            set_operations_reads,
            operations_reads,
            list_service_types,
            list_upcoming_plans,
            pick_service,
            next_plan,
            list_sunday_recordings,
            load_sunday_recording,
            delete_sunday_recordings,
            delete_sunday_plan_recordings,
            dev_defaults,
            dev_log,
            model_status,
            managed_connect,
            managed_connect_cancel,
            managed_connect_reopen,
            managed_disconnect,
            reword_draft,
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
            key_sheet::own_key_providers,
            key_sheet::open_help_page,
            key_sheet::own_key_paste,
            key_sheet::own_key_enter,
            key_sheet::own_key_check_again,
            key_sheet::own_key_use_kept,
            key_sheet::own_key_forget,
            key_sheet::own_key_remove,
            key_sheet::set_month_limit,
            key_sheet::set_no_ai,
            key_sheet::remove_own_key,
            key_sheet::own_key_saved,
            key_sheet::own_key_count,
            church_systems::church_system_connect,
            church_systems::church_system_verify,
            church_systems::church_system_choices,
            church_systems::church_system_check,
            church_systems::church_system_forget,
            church_systems::church_system_saved,
            church_systems::church_system_saved_checks,
            church_systems::church_system_load_check,
            church_systems::church_system_delete_checks,
            church_systems::church_system_keychain_wait,
            ai_setup::local_ai_find,
            ai_setup::local_ai_open,
            ai_setup::come_forward,
            ai_setup::local_ai_check,
            ai_setup::local_model_download,
            ai_setup::local_model_progress,
            ai_setup::local_model_cancel,
            ai_setup::local_model_remove,
            ollama_setup::ollama_install,
            ollama_setup::ollama_install_progress,
            ollama_setup::ollama_install_cancel,
            ollama_setup::ollama_reveal,
            ollama_setup::ollama_install_history,
            ai_setup::managed_offer,
            ai_setup::managed_account_now,
            ai_setup::notification_permission,
            ai_setup::open_notification_settings,
            ai_setup::setup_check,
            notify_sunday_attention,
            local_tools::speak_briefing,
            local_tools::stop_briefing,
            local_tools::prepare_card_reader,
            local_tools::read_card_text,
            local_tools::cancel_card_reading,
            card_picker::choose_card_photos,
            draft_apps::open_draft,
            draft_apps::open_draft_to,
            changes::changes_status,
            changes::changes_set,
            changes::change_prepare,
            changes::change_confirm,
            changes::change_undo,
            changes::change_history,
            planning_center_pages::open_in_planning_center,
            local_tools::voice_status_check,
            local_tools::listen_for_question,
            local_tools::stop_listening,
            local_tools::cancel_listening,
            share_helper::share_helper_path,
            share_bundle::add_to_claude,
            shortcuts::shortcuts_status,
            shortcuts::start_shortcuts,
            shortcuts::stop_shortcuts,
            shortcuts::clear_shortcuts_check,
            shortcuts::save_shortcuts_check,
            shortcuts::shortcuts_helper_path,
            shortcuts::siri_actions_bundled,
            shortcuts::take_opened_page,
            calendars::calendar_apple_status,
            calendars::calendar_apple_ask,
            calendars::calendar_apple_calendars,
            calendars::calendar_apple_events,
            calendars::calendar_apple_chosen,
            calendars::calendar_apple_choose,
            calendars::calendar_links,
            calendars::calendar_link_add,
            calendars::calendar_link_remove,
            calendars::calendar_link_read,
            calendars::calendar_links_forget_all,
            church_sources::church_sources,
            church_sources::church_source_choose_file,
            church_sources::church_source_read,
            church_sources::church_source_set,
            church_sources::church_source_remove,
            church_sources::church_sources_forget_all,
            church_sources::church_link_add,
            church_sources::church_link_read,
            church_sources::church_link_remove,
            church_sources::church_links_forget_all,
            church_sources::church_notes_choose_file,
            church_sources::church_notes_set,
            always_on::background_info,
            always_on::background_next_due,
            always_on::autostart_get,
            always_on::autostart_set,
            always_on::quit_guard_set,
            always_on::quit_now,
            always_on::quit_kept,
            always_on::notify_ozzie,
            phone_notice::phone_notice_status,
            phone_notice::phone_notice_on,
            phone_notice::phone_notice_new_channel,
            phone_notice::phone_notice_off,
            phone_notice::phone_notice_test,
            always_on::responsibility_list,
            always_on::responsibility_create,
            always_on::responsibility_edit,
            always_on::responsibility_pause,
            always_on::responsibility_resume,
            always_on::responsibility_stop,
            always_on::responsibility_pause_all,
            always_on::responsibility_run_begin,
            always_on::responsibility_run_end,
            always_on::responsibility_agent_step,
            updater::update_status,
            updater::update_check,
            updater::update_set_automatic,
            updater::update_install,
            text_size::text_size_step
        ])
        .on_page_load(|window, _| {
            text_size::on_page_load(window);
            always_on::on_page_load(window);
        })
        .build(tauri::generate_context!())
        .expect("native consumer failed to start");
    if smoke {
        println!("native-lifecycle: native window and event loop starting");
    }
    app.run(move |app, event| {
        always_on::on_run_event(app, &event);
        shortcuts::on_run_event(app, &event);
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
    use ozzie_native_auth::source::SourceError;
    use std::time::Instant;

    #[test]
    fn rooms_follow_ups_and_groups_are_decided_per_church_before_any_new_grant() {
        let dir = std::env::temp_dir().join(format!("ozzie-operations-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        // No file. At launch (or before a sign-in opens the browser) the church holds Services only: saved off.
        decide_before_grant(&dir, "1001", false, &SignIns::default());
        // People is then allowed from a note: the grant changes nothing saved, and the check reads none of them.
        assert!(!switch_at_check(&dir, "1001"));
        assert_eq!(operations_reads_saved(&dir, "1001"), Some(false));
        // An install that already held those scopes before this build (only Settings asked for them): kept on.
        decide_before_grant(&dir, "2002", true, &SignIns::default());
        assert!(switch_at_check(&dir, "2002"));
        // Once decided, a later look never changes it.
        decide_before_grant(&dir, "1001", true, &SignIns::default());
        assert!(!switch_at_check(&dir, "1001"));
        // A church switch: the new church was never decided before its grant, so it starts off, and "on" for
        // another church is never carried over.
        assert!(!switch_at_check(&dir, "3003"));
        assert_eq!(operations_reads_saved(&dir, "3003"), Some(false));
        assert!(switch_at_check(&dir, "2002"));
        // The Settings action turns it on for the church in use, and off again.
        assert!(set_switch(&dir, "1001", true));
        assert!(switch_at_check(&dir, "1001"));
        assert!(set_switch(&dir, "1001", false));
        assert!(!switch_at_check(&dir, "1001"));
        // The earlier one-switch file is not read as anyone's choice.
        std::fs::write(dir.join(OPERATIONS_FILE), r#"{"on":true}"#).unwrap();
        assert_eq!(operations_reads_saved(&dir, "2002"), None);
        assert!(!switch_at_check(&dir, "2002"));
        let _ = std::fs::remove_dir_all(&dir);
        // Where it is decided: before the browser opens for any sign-in, at launch's check of the saved sign-in,
        // and at the check only for a church never decided.
        let main = include_str!("main.rs")
            .split("#[cfg(test)]")
            .next()
            .unwrap();
        let sign_in = &main[main.find("fn sign_in(").unwrap()..];
        assert!(
            sign_in
                .find("decide_for_current_church(consumer, app);")
                .unwrap()
                < sign_in.find("/usr/bin/open").unwrap()
        );
        let launch = &main[main.find("async fn check_saved_connection(").unwrap()..];
        assert!(launch[..launch.find("\n}\n").unwrap()].contains("decide_before_grant("));
        assert!(main.contains(
            "checkins_event: checkins_event_id.as_deref(),\n                    operations,"
        ));
        assert!(!main.contains("operations_reads_on("));
    }

    #[test]
    fn after_paying_ozzie_comes_forward_only_when_the_browser_part_ended() {
        let account = Account {
            plan: "personal".into(),
            allowance_steps: 1500,
            used_steps: 0,
            period_ends: "2026-12-17".into(),
            warning: None,
            checked_at_ms: 0,
            offline: false,
            plan_reason: None,
            paused_until: None,
            answers_left: None,
        };
        assert!(come_forward_after_paid(&Ok(account), false));
        for e in [
            ManagedError::PaymentCancelled,
            ManagedError::Cancelled,
            ManagedError::Refused,
        ] {
            assert!(come_forward_after_paid(&Err(e), false), "{e:?}");
        }
        for e in [
            ManagedError::NotFinished,
            ManagedError::Expired,
            ManagedError::Busy,
            ManagedError::BrowserUnavailable,
        ] {
            assert!(!come_forward_after_paid(&Err(e), false), "{e:?}");
        }
        // Cancelled on this Mac: the person is already here.
        assert!(!come_forward_after_paid(
            &Err(ManagedError::Cancelled),
            true
        ));
        // "Open the page again" re-opens the waiting attempt and starts none.
        let main = include_str!("main.rs")
            .split("#[cfg(test)]")
            .next()
            .unwrap();
        let reopen = &main[main.find("async fn managed_connect_reopen(").unwrap()..];
        let reopen = &reopen[..reopen.find("\n}\n").unwrap()];
        assert!(reopen.contains(".url") && !reopen.contains("ConnectAttempt::begin"));
    }

    #[test]
    fn the_sign_in_watcher_brings_ozzie_forward_only_when_the_browser_part_ended() {
        let status = |state: ConnectionState, problem: Option<AuthError>| ConnectionStatus {
            state,
            organization: String::new(),
            checked_at_ms: None,
            source: "native",
            problem,
            organization_diagnostic: None,
            scopes: None,
            found: false,
            found_at_ms: None,
            organization_name: None,
        };
        let end = |state, problem| sign_in_end(&status(state, problem), false);
        assert_eq!(end(ConnectionState::Waiting, None), None);
        assert_eq!(end(ConnectionState::Checking, None), None);
        assert_eq!(
            end(ConnectionState::Connected, None),
            Some(SignInEnd::Connected)
        );
        // "You chose not to allow Ozzie", or Planning Center said yes and something failed: back to Ozzie.
        assert_eq!(
            end(ConnectionState::Cancelled, Some(AuthError::Denied)),
            Some(SignInEnd::FromTheBrowser)
        );
        assert_eq!(
            end(ConnectionState::Failed, Some(AuthError::ScopeMismatch)),
            Some(SignInEnd::FromTheBrowser)
        );
        assert_eq!(
            end(ConnectionState::Failed, Some(AuthError::ProviderFailure)),
            Some(SignInEnd::FromTheBrowser)
        );
        // Cancelled or out of time on this Mac: the person is already here.
        assert_eq!(
            end(ConnectionState::Cancelled, Some(AuthError::Cancelled)),
            Some(SignInEnd::HereOnThisMac)
        );
        assert_eq!(
            end(ConnectionState::Expired, Some(AuthError::Expired)),
            Some(SignInEnd::HereOnThisMac)
        );
        // A one-click sign-in the page's status read handed over before the watcher looked reads cancelled, yet it
        // connected: Ozzie comes forward and the page hears it (review L9: after "Let Ozzie read more in Planning
        // Center" and Allow, the browser stayed in front).
        assert_eq!(
            sign_in_end(&status(ConnectionState::Cancelled, None), true),
            Some(SignInEnd::Connected)
        );
        assert_eq!(
            sign_in_end(&status(ConnectionState::Cancelled, None), false),
            Some(SignInEnd::HereOnThisMac)
        );
        // It looks four times a second for the attempt's five minutes and a little more, never longer.
        assert_eq!(WATCH_EVERY, Duration::from_millis(250));
        assert!(WATCH_FOR > Duration::from_millis(ozzie_native_auth::oauth::ATTEMPT_LIFETIME_MS));
        assert!(WATCH_FOR < Duration::from_secs(6 * 60));
        // Both sign-ins start it.
        let main = include_str!("main.rs")
            .split("#[cfg(test)]")
            .next()
            .unwrap();
        assert_eq!(
            main.matches("watch_sign_in(app.clone(), auth.clone());")
                .count(),
            1
        );
        assert!(main.contains("match sign_in_end(&status, auth.handed_over()) {"));
        assert_eq!(main.matches("sign_in(&consumer, &app, ask,").count(), 2);
    }

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

    /// Renewing the sign-in before a read, through the app's own lookup and transition lock.
    /// Fictional tokens and organizations; the Keychain, Planning Center and the clock are fakes.
    mod renewal {
        use super::*;
        use ozzie_native_auth::credentials::{CredentialStore, StoreError};
        use ozzie_native_auth::oauth::{
            OrganizationDiagnostic, OrganizationFailure, Tokens, UserInfoReason,
        };
        use std::sync::atomic::{AtomicU64, AtomicUsize};

        const HOUR: u64 = 3_600_000;

        /// What the fakes refuse when told to: Planning Center's revoke, and the Keychain's read and
        /// delete (live test 2026-11-17: an item the release app doesn't own).
        #[derive(Default)]
        struct Refusals {
            revoke: AtomicBool,
            read: AtomicBool,
            delete: AtomicBool,
        }
        /// Saved sign-ins by church.
        struct Store(
            Mutex<std::collections::BTreeMap<String, Vec<u8>>>,
            Arc<Refusals>,
        );
        impl CredentialStore for Store {
            fn put(&self, _: &str, organization: &str, value: &[u8]) -> Result<(), StoreError> {
                self.0
                    .lock()
                    .unwrap()
                    .insert(organization.into(), value.to_vec());
                Ok(())
            }
            fn get(&self, _: &str, organization: &str) -> Result<Option<Vec<u8>>, StoreError> {
                if self.1.read.load(Ordering::SeqCst) {
                    return Err(StoreError::Denied);
                }
                Ok(self.0.lock().unwrap().get(organization).cloned())
            }
            fn delete(&self, _: &str, organization: &str) -> Result<(), StoreError> {
                if self.1.delete.load(Ordering::SeqCst) {
                    return Err(StoreError::Denied);
                }
                self.0.lock().unwrap().remove(organization);
                Ok(())
            }
        }
        /// Planning Center: access tokens that run out two hours after they were issued (userinfo
        /// then refuses them, 401), and renewals refused or out of reach when told to be.
        struct Pco {
            clock: Arc<AtomicU64>,
            issued: Mutex<Vec<(String, u64)>>,
            refuse: AtomicBool,
            unreachable: AtomicBool,
            renewals: AtomicUsize,
            identity: AtomicUsize,
            /// While set, a renewal is followed by this quit (`Consumer::stop`'s first step).
            quits: Mutex<Option<Arc<lifetime::Lifetime>>>,
            /// The church the signed-in person's userinfo names.
            church: Mutex<&'static str>,
            refusals: Arc<Refusals>,
        }
        impl Pco {
            fn accepts(&self, access: &str) -> bool {
                let now = self.clock.load(Ordering::SeqCst);
                self.issued
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|(token, at)| token == access && now < at + 2 * HOUR)
            }
            fn renewals(&self) -> usize {
                self.renewals.load(Ordering::SeqCst)
            }
        }
        impl Provider for Pco {
            fn exchange(&self, _: &str, _: &str, _: &str) -> Result<Tokens, AuthError> {
                panic!("no sign-in here")
            }
            fn organization(&self, access: &str) -> Result<String, AuthError> {
                self.organization_detailed(access).map_err(|f| f.error)
            }
            fn organization_detailed(&self, access: &str) -> Result<String, OrganizationFailure> {
                self.identity.fetch_add(1, Ordering::SeqCst);
                if self.accepts(access) {
                    return Ok((*self.church.lock().unwrap()).into());
                }
                Err(OrganizationFailure {
                    error: AuthError::OrganizationUnverified,
                    diagnostic: OrganizationDiagnostic::userinfo(UserInfoReason::AccessDenied),
                })
            }
            fn refresh(&self, _: &str, _: &str) -> Result<Tokens, AuthError> {
                let n = self.renewals.fetch_add(1, Ordering::SeqCst) + 1;
                if let Some(quit) = self.quits.lock().unwrap().as_ref() {
                    quit.cancel();
                }
                if self.refuse.load(Ordering::SeqCst) {
                    return Err(AuthError::InvalidToken);
                }
                if self.unreachable.load(Ordering::SeqCst) {
                    return Err(AuthError::ProviderFailure);
                }
                let access = format!("fictional-access-{n}");
                let now = self.clock.load(Ordering::SeqCst);
                self.issued.lock().unwrap().push((access.clone(), now));
                Ok(Tokens {
                    access_token: access,
                    refresh_token: Some(format!("fictional-refresh-{n}")),
                    token_type: "bearer".into(),
                    expires_in: 7200,
                })
            }
            fn revoke(&self, _: &str, _: &str, _: &str) -> Result<(), AuthError> {
                if self.refusals.revoke.load(Ordering::SeqCst) {
                    return Err(AuthError::ProviderFailure);
                }
                Ok(())
            }
        }
        /// Ozzie started at 0 with a sign-in saved on this Mac and checked it, as on launch.
        fn launched() -> (Consumer, Arc<Pco>, Arc<AtomicU64>) {
            launched_with("")
        }
        /// The same, with `extra` added to the saved sign-in's record (e.g. the scopes it holds).
        fn launched_with(extra: &str) -> (Consumer, Arc<Pco>, Arc<AtomicU64>) {
            let clock = Arc::new(AtomicU64::new(0));
            let pco = Arc::new(Pco {
                clock: clock.clone(),
                issued: Mutex::default(),
                refuse: AtomicBool::new(false),
                unreachable: AtomicBool::new(false),
                renewals: AtomicUsize::new(0),
                identity: AtomicUsize::new(0),
                quits: Mutex::new(None),
                church: Mutex::new("1001"),
                refusals: Arc::default(),
            });
            let saved = |church: &str| {
                format!(
                    r#"{{"client_id":"fictional-client","organization":"{church}","tokens":{{"access_token":"fictional-access-0","refresh_token":"fictional-refresh-0","token_type":"bearer","expires_in":7200}}{extra}}}"#
                )
                .into_bytes()
            };
            // A sign-in for another church is saved too, for a church switch.
            let store = std::collections::BTreeMap::from([
                ("1001".to_string(), saved("1001")),
                ("2002".to_string(), saved("2002")),
            ]);
            let (provider, now) = (pco.clone(), clock.clone());
            let consumer = Consumer(
                Arc::new(Connections::new(
                    WORKSPACE_PREFIX,
                    None,
                    Arc::new(Store(Mutex::new(store), pco.refusals.clone())),
                    Box::new(move || Ok(provider.clone() as Arc<dyn Provider>)),
                    Box::new(move || {
                        let now = now.clone();
                        Ok(Arc::new(move || now.load(Ordering::SeqCst))
                            as Arc<dyn Fn() -> u64 + Send + Sync>)
                    }),
                )),
                Arc::default(),
            );
            let auth = consumer
                .0
                .prepare_check("fictional-client".into(), "1001".into(), true)
                .unwrap();
            assert_eq!(auth.refresh().unwrap().state, ConnectionState::Connected);
            assert_eq!(pco.renewals(), 1);
            (consumer, pco, clock)
        }
        fn json(error: ConsumerError) -> String {
            serde_json::to_string(&error).unwrap()
        }
        /// The connection a check or a picker read gets (`read_renewing`'s lookup).
        fn connected_auth(consumer: &Consumer) -> Result<Arc<AuthController>, ConsumerError> {
            renewed_auth(consumer).map(|(auth, _)| auth)
        }

        /// Live, 2026-11-19: Connect again for the church already connected, Allow, connected, and Ozzie stayed behind
        /// the browser. The watcher can't have ended before the browser opened: it looks at the sign-in's own
        /// controller, a new one for every sign-in, which reads waiting from `begin_with` until its own callback,
        /// whatever the connection before it, the church's saved sign-in or the page's status reads meanwhile.
        #[test]
        fn a_sign_in_again_for_the_connected_church_is_watched_until_its_own_callback() {
            let (consumer, _, _) = launched();
            let before = consumer.0.current().unwrap();
            assert_eq!(before.status().unwrap().state, ConnectionState::Connected);
            // As `sign_in` does: `prepare`, then `begin_with`, then the watcher starts.
            let auth = consumer
                .0
                .prepare(
                    "fictional-client".into(),
                    "1001".into(),
                    true,
                    Purpose::SignIn,
                )
                .unwrap();
            assert!(!Arc::ptr_eq(&before, &auth));
            auth.begin_with(Scopes::default()).unwrap();
            assert_eq!(auth.status().unwrap().state, ConnectionState::Waiting);
            assert_eq!(
                sign_in_end(&auth.status().unwrap(), auth.handed_over()),
                None
            );
            // The page's status reads while the browser waits leave it waiting.
            for _ in 0..3 {
                let _ = consumer.0.view();
                assert_eq!(
                    sign_in_end(&auth.status().unwrap(), auth.handed_over()),
                    None
                );
            }
        }

        /// A People grant for a note's To line can't turn the reads on through a church switch (review 2026-11-18): the
        /// browser is signed in to another church, the To sheet's one-click grant finds it with Calendar, People and
        /// Groups, the person switches to it, then presses Sign in again or relaunches before any check. The switch saves
        /// the new church off, and the decision before a grant never records "on" from a sign-in started for anything but
        /// these reads. A church updating from 0.2.x keeps the earlier rule: no sign-in this session, its saved sign-in
        /// holds the scopes (only Settings asked for them then), so it starts on.
        #[test]
        fn a_people_grant_for_another_church_never_turns_the_reads_on_through_a_switch() {
            let dir = std::env::temp_dir()
                .join(format!("ozzie-operations-switch-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            // The church in use before: Services only, decided off before the To sheet's sign-in opened the browser.
            let (consumer, _, _) = launched_with(r#","scopes":"services-and-operations""#);
            let found = consumer.0.current().unwrap();
            let sign_ins = SignIns::default();
            decide_before_grant(&dir, "2002", false, &sign_ins);
            // The To sheet's grant, bound to the church the browser was signed in to ("1001" here), with the wide access.
            sign_ins.started(Some(SignInFor::PeopleForTo), found.clone(), None);
            assert_eq!(
                sign_ins.granted_for("1001"),
                Some(Some(SignInFor::PeopleForTo))
            );
            // "Switch Ozzie to this church?" answered switch: saved off at once.
            decide_at_switch(&dir, "1001");
            assert_eq!(operations_reads_saved(&dir, "1001"), Some(false));
            // Sign in again, or a relaunch, before any check: still off, and the check reads none of them.
            decide_before_grant(&dir, "1001", true, &sign_ins);
            decide_before_grant(&dir, "1001", true, &SignIns::default());
            assert!(!switch_at_check(&dir, "1001"));
            // A switch never changes a church that already has an answer.
            assert!(set_switch(&dir, "1001", true));
            decide_at_switch(&dir, "1001");
            assert!(switch_at_check(&dir, "1001"));
            // The decision before a grant on its own (the file lost after the switch): the church's grant this session was
            // the To line's People, so it starts off; so after Sign in again or Check-Ins (no purpose).
            let _ = std::fs::remove_dir_all(&dir);
            decide_before_grant(&dir, "1001", true, &sign_ins);
            assert_eq!(operations_reads_saved(&dir, "1001"), Some(false));
            let _ = std::fs::remove_dir_all(&dir);
            sign_ins.started(None, found.clone(), None);
            decide_before_grant(&dir, "1001", true, &sign_ins);
            assert_eq!(operations_reads_saved(&dir, "1001"), Some(false));
            // A sign-in started for these reads and granted for this church may start it on.
            let _ = std::fs::remove_dir_all(&dir);
            sign_ins.started(Some(SignInFor::Operations), found.clone(), None);
            decide_before_grant(&dir, "1001", true, &sign_ins);
            assert_eq!(operations_reads_saved(&dir, "1001"), Some(true));
            // Another church's grant says nothing about this one: the earlier rule, from the scopes its saved sign-in holds.
            assert_eq!(sign_ins.granted_for("2002"), None);
            // Updating from 0.2.x: no sign-in this session, the saved sign-in holds the scopes, so on, as before; one that
            // holds Services only starts off.
            let _ = std::fs::remove_dir_all(&dir);
            decide_before_grant(&dir, "1001", true, &SignIns::default());
            decide_before_grant(&dir, "2002", false, &SignIns::default());
            assert_eq!(
                (
                    operations_reads_saved(&dir, "1001"),
                    operations_reads_saved(&dir, "2002")
                ),
                (Some(true), Some(false))
            );
            let _ = std::fs::remove_dir_all(&dir);
            // Where: answering a switch decides the church now in use, once the answer is in; every decision before a
            // grant reads what this session's sign-ins were for.
            let main = include_str!("main.rs")
                .split("#[cfg(test)]")
                .next()
                .unwrap();
            let answer = &main[main.find("async fn answer_church_switch(").unwrap()..];
            let answer = &answer[..answer.find("\n}\n").unwrap()];
            assert!(
                answer.find(".answer(decision, question)").unwrap()
                    < answer.find("decide_at_switch(").unwrap()
            );
            let calls: Vec<usize> = main
                .match_indices("decide_before_grant(")
                .map(|(at, _)| at)
                .filter(|at| !main[..*at].ends_with("fn "))
                .collect();
            assert_eq!(calls.len(), 2);
            for at in calls {
                assert!(main[at..at + 240].contains("&app.state::<SignIns>()"));
            }
        }

        /// Native's own rule for rooms, follow-ups and group events (review M1): a People grant for a note's To line can
        /// never turn them on through the page's after-a-sign-in path, even when a sign-in that asked for them was in the
        /// browser first; a person's own press with the access held still can.
        #[test]
        fn rooms_follow_ups_and_groups_go_on_after_a_sign_in_only_when_it_asked_for_them() {
            let (consumer, _, _) = launched_with(r#","scopes":"services-and-operations""#);
            let church = current_church(&consumer).unwrap();
            assert_eq!(church, ("1001".to_owned(), true));
            let connected = consumer.0.current().unwrap();
            let sign_ins = SignIns::default();
            // No sign-in this session: only a press turns them on.
            assert!(!reads_may_go_on(&church, false, &sign_ins));
            assert!(reads_may_go_on(&church, true, &sign_ins));
            // The review's sequence: "Let Ozzie read more in Planning Center" starts a sign-in for these reads, left
            // in the browser; the To line's "Allow People access in my browser" replaces it, and Planning Center
            // grants that one. The page's after-a-sign-in call is refused.
            let left_waiting = Arc::new(
                AuthController::find_organization(
                    "fictional-client".into(),
                    WORKSPACE_PREFIX,
                    Arc::new(Store(Mutex::default(), Arc::default())),
                    Arc::new(NoProvider),
                    Arc::new(|| 0),
                )
                .unwrap(),
            );
            sign_ins.started(Some(SignInFor::Operations), left_waiting, None);
            assert!(!reads_may_go_on(&church, false, &sign_ins));
            sign_ins.started(Some(SignInFor::PeopleForTo), connected.clone(), None);
            sign_ins.note();
            assert!(!reads_may_go_on(&church, false, &sign_ins));
            // A sign-in with no stated purpose (Sign in again, Check-Ins or Registrations) is no ask either.
            sign_ins.started(None, connected.clone(), None);
            assert!(!reads_may_go_on(&church, false, &sign_ins));
            // Settings' switch, pressed with the access held, is allowed after any of them.
            assert!(reads_may_go_on(&church, true, &sign_ins));
            // A sign-in that asked for these reads and was granted them: the page's after-a-sign-in call is allowed,
            // for that church only.
            sign_ins.started(Some(SignInFor::Operations), connected.clone(), None);
            assert!(reads_may_go_on(&church, false, &sign_ins));
            assert!(!reads_may_go_on(
                &("2002".to_owned(), true),
                false,
                &sign_ins
            ));
            // Without the access held, nothing turns them on, not even a press.
            assert!(!reads_may_go_on(
                &("1001".to_owned(), false),
                true,
                &sign_ins
            ));
            assert!(!reads_may_go_on(
                &("1001".to_owned(), false),
                false,
                &sign_ins
            ));
            // The command itself asks this rule before it saves anything; off needs only a church in use.
            let main = include_str!("main.rs")
                .split("#[cfg(test)]")
                .next()
                .unwrap();
            let command = &main[main.find("fn set_operations_reads(").unwrap()..];
            let command = &command[..command.find("\n}\n").unwrap()];
            assert!(
                command
                    .find("if on && !reads_may_go_on(&church, pressed.unwrap_or(false), &sign_ins)")
                    .unwrap()
                    < command.find("set_switch(").unwrap()
            );
            // Every browser sign-in records what it was for before the browser opens.
            let sign_in = &main[main.find("fn sign_in(").unwrap()..];
            assert!(
                sign_in
                    .find(".started(purpose, auth.clone(), church);")
                    .unwrap()
                    < sign_in.find("/usr/bin/open").unwrap()
            );
        }
        /// A sign-in again asks for exactly what the church holds, and is for the rooms, follow-ups and group reads only
        /// while they are on (review 2026-11-18, late): Settings' Connect again asked for Services alone, so allowing it
        /// dropped Calendar, People and Groups, Check-Ins and Registrations while the switch still said on.
        #[test]
        fn a_sign_in_again_asks_for_what_the_church_holds_and_for_the_reads_only_while_on() {
            let every = [false, true];
            for operations in every {
                for check_ins in every {
                    for registrations in every {
                        let held = Scopes::asked(operations, check_ins, registrations);
                        for reads_on in [Some(true), Some(false), None] {
                            let (asked, purpose) = again_ask(Some(held), reads_on);
                            // Never more, never less.
                            assert_eq!(asked, held, "{held:?} {reads_on:?}");
                            // For the reads only with the access held and the switch on; never the To line's purpose.
                            assert_eq!(
                                purpose,
                                (operations && reads_on == Some(true))
                                    .then_some(SignInFor::Operations),
                                "{held:?} {reads_on:?}"
                            );
                        }
                    }
                }
            }
            // Nothing saved for the church (or unreadable): Services alone, for nothing, unless its switch is still on,
            // which it only went with Calendar, People and Groups held: then those again, for the reads (release review
            // 2026-11-19, a switch to another church system and back). Never Check-Ins or Registrations unknown here.
            for reads_on in [Some(false), None] {
                assert_eq!(again_ask(None, reads_on), (Scopes::Services, None));
            }
            assert_eq!(
                again_ask(None, Some(true)),
                (
                    Scopes::asked(true, false, false),
                    Some(SignInFor::Operations)
                )
            );

            // Read here, never from the page: what the church's saved sign-in holds and its own switch.
            let dir =
                std::env::temp_dir().join(format!("ozzie-sign-in-again-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            let wide = Scopes::asked(true, true, false);
            let (consumer, pco, clock) =
                launched_with(r#","scopes":"services-and-operations+check-ins""#);
            assert_eq!(again_for(&consumer, Some(&dir), "1001"), (wide, None));
            assert!(set_switch(&dir, "1001", false));
            assert_eq!(again_for(&consumer, Some(&dir), "1001"), (wide, None));
            assert!(set_switch(&dir, "1001", true));
            assert_eq!(
                again_for(&consumer, Some(&dir), "1001"),
                (wide, Some(SignInFor::Operations))
            );
            // Another church's switch says nothing about this one. A church with nothing saved asks for Services, and
            // for Calendar, People and Groups again while its own switch is still on (signed out, as a switch to another
            // church system does; release review 2026-11-19).
            assert!(set_switch(&dir, "3003", true));
            assert_eq!(
                again_for(&consumer, Some(&dir), "3003"),
                (
                    Scopes::asked(true, false, false),
                    Some(SignInFor::Operations)
                )
            );
            assert!(set_switch(&dir, "3003", false));
            assert_eq!(
                again_for(&consumer, Some(&dir), "3003"),
                (Scopes::Services, None)
            );
            assert_eq!(again_for(&consumer, None, "1001"), (wide, None));

            // Planning Center stopped accepting the saved sign-in: the record still says what it holds, so Sign in again
            // asks for that. The church in use is decided first, as before any sign-in; from a record this session never
            // verified it starts off, never on (review 2026-11-19), so the ask is for nothing until a press.
            struct LastUsed;
            impl ozzie_native_auth::in_use::UseHistory for LastUsed {
                fn load(&self) -> Option<ozzie_native_auth::in_use::UsedChurch> {
                    Some(ozzie_native_auth::in_use::UsedChurch {
                        organization: "1001".into(),
                        client_id: "fictional-client".into(),
                        leaving: Vec::new(),
                    })
                }
                fn save(&self, _: &ozzie_native_auth::in_use::UsedChurch) -> std::io::Result<()> {
                    Ok(())
                }
            }
            consumer.0.keep_use_history(Arc::new(LastUsed));
            let _ = std::fs::remove_dir_all(&dir);
            pco.refuse.store(true, Ordering::SeqCst);
            clock.store(2 * HOUR + 60_000, Ordering::SeqCst);
            assert!(read_renewing(&consumer, |_| Ok(())).is_err());
            assert_eq!(current_church(&consumer), None);
            let sign_ins = SignIns::default();
            let (church, held) = church_before_grant(&consumer).unwrap();
            assert_eq!((church.as_str(), held), ("1001", false));
            decide_before_grant(&dir, &church, held, &sign_ins);
            assert_eq!(operations_reads_saved(&dir, "1001"), Some(false));
            assert_eq!(again_for(&consumer, Some(&dir), "1001"), (wide, None));
            // A church whose reads are on keeps them, and its sign-in again is for them.
            assert!(set_switch(&dir, "1001", true));
            decide_before_grant(&dir, &church, held, &sign_ins);
            assert_eq!(
                again_for(&consumer, Some(&dir), "1001"),
                (wide, Some(SignInFor::Operations))
            );
            // Only the church in use is decided: never one a sign-in still in the browser is for (pasted IDs for 2002,
            // whose saved sign-in holds the access too).
            let _ = std::fs::remove_dir_all(&dir);
            let waiting = consumer
                .0
                .prepare(
                    "fictional-client".into(),
                    "2002".into(),
                    true,
                    Purpose::SignIn,
                )
                .unwrap();
            assert_eq!(waiting.bound_to().1, "2002");
            assert_eq!(consumer.0.held("2002"), Some(wide));
            assert_eq!(
                church_before_grant(&consumer),
                Some(("1001".to_owned(), false))
            );
            // Connected, from the scopes this session verified, as before.
            let (services, _, _) = launched_with("");
            assert_eq!(
                church_before_grant(&services),
                Some(("1001".to_owned(), false))
            );
            let (held_wide, _, _) = launched_with(r#","scopes":"services-and-operations""#);
            assert_eq!(
                church_before_grant(&held_wide),
                Some(("1001".to_owned(), true))
            );
            let _ = std::fs::remove_dir_all(&dir);

            // One click stays one click for the church in use, so signing in to another church still asks which church
            // Ozzie uses; "Sign in to {church} instead" for a church saved here is bound to it (review 2026-11-19).
            assert!(!bound_again("1001", Some("1001"), true));
            assert!(bound_again("2002", Some("1001"), true));
            assert!(bound_again("2002", None, true));
            assert!(!bound_again("2002", Some("1001"), false));
            // Asking for more than Services with nothing saved is bound to the church, even the one in use; Services
            // alone stays one click (release review 2026-11-19, M1).
            assert!(widens_unsaved(false, Some(true)));
            for (held, reads_on) in [
                (true, Some(true)),
                (false, Some(false)),
                (false, None),
                (true, None),
            ] {
                assert!(!widens_unsaved(held, reads_on), "{held} {reads_on:?}");
            }
            // Whenever `again_ask` widens with nothing saved, the sign-in is bound.
            for reads_on in [Some(true), Some(false), None] {
                assert_eq!(
                    again_ask(None, reads_on).0 != Scopes::Services,
                    widens_unsaved(false, reads_on)
                );
            }
            // A sign-in again whose one click Planning Center gave to another church is for nothing there.
            let elsewhere = SignIns::default();
            let connected = held_wide.0.current().unwrap();
            elsewhere.started(
                Some(SignInFor::Operations),
                connected.clone(),
                Some("2002".into()),
            );
            assert_eq!(elsewhere.granted_for("1001"), Some(None));
            assert!(!reads_may_go_on(
                &("1001".to_owned(), true),
                false,
                &elsewhere
            ));
            elsewhere.started(Some(SignInFor::Operations), connected, Some("1001".into()));
            assert_eq!(
                elsewhere.granted_for("1001"),
                Some(Some(SignInFor::Operations))
            );

            // Where: both commands turn `again` into this ask in place of the page's choices, the one with pasted IDs only
            // for the church those IDs sign in to; and every sign-in decides the church, then reads its ask, before the
            // purpose is recorded and the browser opens.
            let main = include_str!("main.rs")
                .split("#[cfg(test)]")
                .next()
                .unwrap();
            for command in [
                "async fn connect_planning_center(",
                "async fn connect_planning_center_app(",
            ] {
                let body = &main[main.find(command).unwrap()..];
                let body = &body[..body.find("\n}\n").unwrap()];
                assert!(body.contains("again: Option<String>,"));
                assert!(body.contains("Some(church) => Ask::Again(church),"));
                assert!(body.contains("sign_in(&consumer, &app, ask,"));
            }
            let app_command = &main[main.find("async fn connect_planning_center_app(").unwrap()..];
            let app_command = &app_command[..app_command.find("\n}\n").unwrap()];
            assert!(app_command.contains(
                "(bound_again(church, consumer.0.church_in_use().as_deref(), held)\n                    || widens_unsaved(held, reads_on))"
            ));
            assert!(
                app_command.contains(".prepare(String::new(), church, true, Purpose::SignIn)?")
            );
            let pasted = &main[main.find("async fn connect_planning_center(").unwrap()..];
            assert!(
                pasted
                    .find("Some(church) if church != organization => {")
                    .unwrap()
                    < pasted.find("Some(church) => Ask::Again(church),").unwrap()
            );
            let sign_in = &main[main.find("fn sign_in(").unwrap()..];
            let decided = sign_in
                .find("decide_for_current_church(consumer, app);")
                .unwrap();
            let again = sign_in
                .find("again_for(consumer, app.path().app_data_dir()")
                .unwrap();
            let prepared = sign_in.find("let auth = prepare(consumer)?;").unwrap();
            assert!(decided < again && again < prepared);
            assert!(
                prepared
                    < sign_in
                        .find(".started(purpose, auth.clone(), church);")
                        .unwrap()
            );
        }
        /// A Planning Center that is never reached.
        struct NoProvider;
        impl Provider for NoProvider {
            fn exchange(&self, _: &str, _: &str, _: &str) -> Result<Tokens, AuthError> {
                Err(AuthError::ProviderFailure)
            }
            fn organization(&self, _: &str) -> Result<String, AuthError> {
                Err(AuthError::ProviderFailure)
            }
            fn refresh(&self, _: &str, _: &str) -> Result<Tokens, AuthError> {
                Err(AuthError::ProviderFailure)
            }
            fn revoke(&self, _: &str, _: &str, _: &str) -> Result<(), AuthError> {
                Err(AuthError::ProviderFailure)
            }
        }

        #[test]
        fn a_read_two_hours_after_the_launch_renews_the_sign_in_once() {
            let (consumer, pco, clock) = launched();
            clock.store(2 * HOUR + 30 * 60_000, Ordering::SeqCst);
            let auth = connected_auth(&consumer).unwrap();
            assert_eq!(pco.renewals(), 2);
            assert!(!auth.renewal_due());
            // The renewal was on the session's own controller: nothing for the page to re-check.
            assert!(Arc::ptr_eq(&auth, &consumer.0.current().unwrap()));
            assert_eq!(auth.status().unwrap().state, ConnectionState::Connected);
            connected_auth(&consumer).unwrap();
            assert_eq!(pco.renewals(), 2);
        }

        #[test]
        fn a_read_within_the_sign_ins_life_renews_nothing() {
            let (consumer, pco, clock) = launched();
            for at in [0, HOUR, 2 * HOUR - 11 * 60_000] {
                clock.store(at, Ordering::SeqCst);
                connected_auth(&consumer).unwrap();
            }
            assert_eq!(pco.renewals(), 1);
        }

        #[test]
        fn a_refused_renewal_ends_the_read_before_anything_is_read() {
            let (consumer, pco, clock) = launched();
            pco.refuse.store(true, Ordering::SeqCst);
            clock.store(2 * HOUR + 60_000, Ordering::SeqCst);
            let identity = pco.identity.load(Ordering::SeqCst);
            let reads = AtomicUsize::new(0);
            let error = read_renewing(&consumer, |_| {
                reads.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
            .unwrap_err();
            // The page and the record of what happened read these words (sunday-source.ts).
            assert_eq!(
                json(error),
                r#"{"sign-in-not-renewed":"invalid-credentials"}"#
            );
            assert_eq!(reads.load(Ordering::SeqCst), 0);
            assert_eq!(pco.identity.load(Ordering::SeqCst), identity);
            assert_eq!(pco.renewals(), 2, "asked once");
            // The connection now says it failed, as after "Check saved connection".
            assert_eq!(
                json(connected_auth(&consumer).err().unwrap()),
                r#""not-connected""#
            );
            assert_eq!(pco.renewals(), 2);
        }

        #[test]
        fn planning_center_out_of_reach_says_so_and_the_next_read_renews() {
            let (consumer, pco, clock) = launched();
            pco.unreachable.store(true, Ordering::SeqCst);
            clock.store(2 * HOUR + 60_000, Ordering::SeqCst);
            assert_eq!(
                json(connected_auth(&consumer).err().unwrap()),
                r#"{"sign-in-not-renewed":"provider-failure"}"#
            );
            // Still connected, so automatic checks keep running and the next one tries again.
            let auth = consumer.0.current().unwrap();
            assert_eq!(auth.status().unwrap().state, ConnectionState::Connected);
            pco.unreachable.store(false, Ordering::SeqCst);
            connected_auth(&consumer).unwrap();
            assert_eq!(pco.renewals(), 3);
            assert!(!auth.renewal_due());
        }

        #[test]
        fn a_renewal_never_runs_beside_a_sign_in_a_check_of_the_saved_sign_in_or_disconnect() {
            let (consumer, pco, clock) = launched();
            clock.store(2 * HOUR + 60_000, Ordering::SeqCst);
            // One of those under way: the renewal waits for it, and renews once it has finished.
            let transition = consumer.1.enter().unwrap();
            std::thread::scope(|scope| {
                let reading = scope.spawn(|| connected_auth(&consumer).map(|_| ()));
                std::thread::sleep(Duration::from_millis(200));
                assert!(!reading.is_finished());
                assert_eq!(pco.renewals(), 1);
                drop(transition);
                assert!(reading.join().unwrap().is_ok());
            });
            assert_eq!(pco.renewals(), 2);
            // Still under way past the wait: busy, and nothing renewed.
            clock.store(4 * HOUR + 2 * 60_000, Ordering::SeqCst);
            let _transition = consumer.1.enter().unwrap();
            let started = std::time::Instant::now();
            assert_eq!(
                json(
                    renewed_auth_within(&consumer, Duration::from_millis(100))
                        .err()
                        .unwrap()
                ),
                r#"{"sign-in-not-renewed":"busy"}"#
            );
            assert!(started.elapsed() >= Duration::from_millis(100));
            assert_eq!(pco.renewals(), 2);
            const { assert!(RENEWAL_WAITS.as_secs() > 5) };
        }

        #[test]
        fn a_renewal_after_a_wait_uses_the_connection_that_is_current_then() {
            // Review M, L9 (mutation M12): "Check saved connection" ran while this read waited for it,
            // so the controller the read first found was replaced; the read uses the new one, already
            // renewed, and renews nothing itself.
            let (consumer, pco, clock) = launched();
            clock.store(2 * HOUR + 60_000, Ordering::SeqCst);
            let first = consumer.0.current().unwrap();
            let transition = consumer.1.enter().unwrap();
            std::thread::scope(|scope| {
                let reading = scope.spawn(|| connected_auth(&consumer).ok());
                std::thread::sleep(Duration::from_millis(200));
                assert!(!reading.is_finished());
                let checked = consumer
                    .0
                    .prepare_check("fictional-client".into(), "1001".into(), true)
                    .unwrap();
                checked.refresh().unwrap();
                drop(transition);
                let used = reading.join().unwrap().expect("the read goes ahead");
                assert!(Arc::ptr_eq(&used, &checked));
                assert!(!Arc::ptr_eq(&used, &first));
            });
            assert_eq!(
                pco.renewals(),
                2,
                "only the check of the saved sign-in renewed"
            );
        }

        /// While a read waits, the church in use becomes 2002, as "Switch Ozzie to this church?"
        /// answered does: a connection for 2002, checked.
        fn switch_to_another_church(consumer: &Consumer, pco: &Pco) -> Arc<AuthController> {
            *pco.church.lock().unwrap() = "2002";
            let other = consumer
                .0
                .prepare_check("fictional-client".into(), "2002".into(), true)
                .unwrap();
            assert_eq!(other.refresh().unwrap().organization, "2002");
            other
        }

        #[test]
        fn a_read_that_waited_through_a_church_switch_reads_nothing() {
            // Review N, 6: the read was made for 1001's Sunday; its plan ids are 1001's. When the
            // church in use is another by the time it may go ahead, it reads nothing.
            let (consumer, pco, clock) = launched();
            clock.store(2 * HOUR + 60_000, Ordering::SeqCst);
            let transition = consumer.1.enter().unwrap();
            std::thread::scope(|scope| {
                let reading = scope.spawn(|| connected_auth(&consumer).err().map(json));
                std::thread::sleep(Duration::from_millis(200));
                assert!(!reading.is_finished());
                switch_to_another_church(&consumer, &pco);
                drop(transition);
                assert_eq!(
                    reading.join().unwrap().as_deref(),
                    Some(r#"{"sign-in-not-renewed":"cancelled"}"#)
                );
            });
            // A switch during a read that Planning Center refused: no once-more read, on either
            // connection (the old one has stopped); the read's own failure stands.
            let (consumer, pco, clock) = launched();
            clock.store(30 * 60_000, Ordering::SeqCst);
            let reads = AtomicUsize::new(0);
            let result = read_renewing(&consumer, |_| {
                reads.fetch_add(1, Ordering::SeqCst);
                switch_to_another_church(&consumer, &pco);
                clock.store(3 * HOUR, Ordering::SeqCst);
                Err::<(), _>(SourceError::OrganizationUnverified)
            });
            assert_eq!(result.unwrap(), Err(SourceError::OrganizationUnverified));
            assert_eq!(reads.load(Ordering::SeqCst), 1);
        }

        #[test]
        fn a_quit_during_a_renewal_reads_nothing() {
            // Review M, L9 (mutation M7): Ozzie began to quit while the sign-in renewed.
            let (consumer, pco, clock) = launched();
            *pco.quits.lock().unwrap() = Some(consumer.1.clone());
            clock.store(2 * HOUR + 60_000, Ordering::SeqCst);
            let reads = AtomicUsize::new(0);
            let error = read_renewing(&consumer, |_| {
                reads.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
            .unwrap_err();
            assert_eq!(json(error), r#"{"sign-in-not-renewed":"cancelled"}"#);
            assert_eq!(reads.load(Ordering::SeqCst), 0);
        }

        #[test]
        fn the_to_line_never_renews_so_its_eight_seconds_hold() {
            // Review M, L1: "Open in Mail" or "Open in Messages" with a sign-in due for renewal makes
            // no token request; the To line answers as it does for a sign-in Planning Center refuses,
            // and the note opens with no one in To. Checks keep the sign-in renewed.
            let (consumer, pco, clock) = launched();
            clock.store(2 * HOUR + 60_000, Ordering::SeqCst);
            let started = std::time::Instant::now();
            let auth = session_auth(&consumer).unwrap();
            assert!(started.elapsed() < Duration::from_secs(1));
            assert!(auth.renewal_due());
            assert_eq!(pco.renewals(), 1);
            // The To line looks the connection up this way, and no other (draft_apps.rs).
            let draft = include_str!("draft_apps.rs");
            assert!(draft.contains("crate::session_auth(&consumer).ok()"));
            assert!(!draft.contains("connected_auth"));
        }

        #[test]
        fn a_read_planning_center_refused_is_renewed_and_made_once_more_once() {
            // Ozzie's clock said the sign-in had time left (this Mac slept); Planning Center refused it.
            // Here the read moves the clock on, as the identity check's refusal marks it in core.
            let refused = |clock: &AtomicU64| {
                clock.store(3 * HOUR, Ordering::SeqCst);
                Err::<(), _>(SourceError::OrganizationUnverified)
            };
            let (consumer, pco, clock) = launched();
            clock.store(30 * 60_000, Ordering::SeqCst);
            let reads = AtomicUsize::new(0);
            let result = read_renewing(&consumer, |_| {
                if reads.fetch_add(1, Ordering::SeqCst) == 0 {
                    return refused(&clock);
                }
                Ok(())
            });
            assert_eq!(result.unwrap(), Ok(()));
            assert_eq!((reads.load(Ordering::SeqCst), pco.renewals()), (2, 2));

            // Refused again after the renewal: not a third time.
            let (consumer, pco, clock) = launched();
            let reads = AtomicUsize::new(0);
            let result = read_renewing(&consumer, |_| {
                reads.fetch_add(1, Ordering::SeqCst);
                refused(&clock)
            });
            assert_eq!(result.unwrap(), Err(SourceError::OrganizationUnverified));
            assert_eq!((reads.load(Ordering::SeqCst), pco.renewals()), (2, 2));

            // Renewed just before the read: never renewed twice for one read.
            let (consumer, pco, clock) = launched();
            clock.store(2 * HOUR + 60_000, Ordering::SeqCst);
            let reads = AtomicUsize::new(0);
            let result = read_renewing(&consumer, |_| {
                reads.fetch_add(1, Ordering::SeqCst);
                refused(&clock)
            });
            assert_eq!(result.unwrap(), Err(SourceError::OrganizationUnverified));
            assert_eq!((reads.load(Ordering::SeqCst), pco.renewals()), (1, 2));

            // Any other failure is the read's own: never repeated.
            let (consumer, pco, clock) = launched();
            let reads = AtomicUsize::new(0);
            let result = read_renewing(&consumer, |_| {
                reads.fetch_add(1, Ordering::SeqCst);
                clock.store(3 * HOUR, Ordering::SeqCst);
                Err::<(), _>(SourceError::ProviderFailure)
            });
            assert_eq!(result.unwrap(), Err(SourceError::ProviderFailure));
            assert_eq!((reads.load(Ordering::SeqCst), pco.renewals()), (1, 1));
        }

        /// Live test 2026-11-17: Disconnect turns changes off for the church being left whatever it
        /// returned: when it works, when the revoke is out of reach, when the Keychain refuses the read
        /// or the delete, and when another sign-in step is under way.
        #[test]
        fn disconnect_turns_changes_off_for_the_church_whatever_it_returned() {
            use ozzie_native_auth::change::{ChangeSwitch, Changes};
            let dir = std::env::temp_dir().join(format!(
                "ozzie-disconnect-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            /// A case: its name, what the fakes refuse, and whether another step holds the transition.
            type Case = (&'static str, fn(&Refusals), bool);
            let cases: [Case; 5] = [
                ("works", |_| {}, false),
                (
                    "revoke out of reach",
                    |r| r.revoke.store(true, Ordering::SeqCst),
                    false,
                ),
                (
                    "Keychain read refused",
                    |r| r.read.store(true, Ordering::SeqCst),
                    false,
                ),
                (
                    "Keychain delete refused",
                    |r| r.delete.store(true, Ordering::SeqCst),
                    false,
                ),
                ("busy", |_| {}, true),
            ];
            for (case, refuse, busy) in cases {
                let (consumer, pco, _clock) = launched();
                let switch = ChangeSwitch::at(&dir);
                switch.set("1001", true).unwrap();
                switch.set("2002", true).unwrap();
                let changes = Changes::default();
                refuse(&pco.refusals);
                let held = busy.then(|| consumer.1.enter().unwrap());
                let result = disconnect_and_leave(&consumer, |left| {
                    changes::left_in(Some(&dir), &changes, left)
                });
                drop(held);
                assert!(!switch.is_on("1001"), "{case}: {result:?}");
                assert!(switch.is_on("2002"), "{case}: only the church left");
                if busy {
                    assert!(
                        matches!(result, Err(ConsumerError::Authentication(AuthError::Busy))),
                        "{case}: {result:?}"
                    );
                }
            }
            let _ = std::fs::remove_dir_all(&dir);
        }

        /// A consumer with a saved sign-in for church 1001, not yet checked (`app`: a one-click
        /// registration, for a finder).
        fn saved(app: Option<String>) -> (Consumer, Arc<Pco>, Arc<AtomicU64>) {
            let clock = Arc::new(AtomicU64::new(0));
            let pco = Arc::new(Pco {
                clock: clock.clone(),
                issued: Mutex::default(),
                refuse: AtomicBool::new(false),
                unreachable: AtomicBool::new(false),
                renewals: AtomicUsize::new(0),
                identity: AtomicUsize::new(0),
                quits: Mutex::new(None),
                church: Mutex::new("1001"),
                refusals: Arc::default(),
            });
            let saved = br#"{"client_id":"fictional-client","organization":"1001","tokens":{"access_token":"fictional-access-0","refresh_token":"fictional-refresh-0","token_type":"bearer","expires_in":7200}}"#;
            let store = std::collections::BTreeMap::from([("1001".to_string(), saved.to_vec())]);
            let (provider, now) = (pco.clone(), clock.clone());
            let consumer = Consumer(
                Arc::new(Connections::new(
                    WORKSPACE_PREFIX,
                    app,
                    Arc::new(Store(Mutex::new(store), pco.refusals.clone())),
                    Box::new(move || Ok(provider.clone() as Arc<dyn Provider>)),
                    Box::new(move || {
                        let now = now.clone();
                        Ok(Arc::new(move || now.load(Ordering::SeqCst))
                            as Arc<dyn Fn() -> u64 + Send + Sync>)
                    }),
                )),
                Arc::default(),
            );
            (consumer, pco, clock)
        }

        /// M2 and L-c (review S; review X, N3): the church being left is the sign-in's own in every
        /// state Disconnect is offered, not only a connected one, and a one-click sign-in under way
        /// leaves the church it replaced.
        #[test]
        fn the_church_left_is_known_in_every_sign_in_state() {
            let (consumer, _pco, _clock) = saved(None);
            assert_eq!(bound_church(&consumer), None, "nothing prepared yet");
            consumer
                .0
                .prepare_check("fictional-client".into(), "1001".into(), true)
                .unwrap();
            assert_eq!(
                bound_church(&consumer).as_deref(),
                Some("1001"),
                "stored, unchecked"
            );
            assert!(session_auth(&consumer).is_err());
            // The launch check can't reach Planning Center, or the renewal is refused.
            for refuse in [false, true] {
                let (consumer, pco, _clock) = saved(None);
                if refuse {
                    pco.refuse.store(true, Ordering::SeqCst);
                } else {
                    pco.unreachable.store(true, Ordering::SeqCst);
                }
                let auth = consumer
                    .0
                    .prepare_check("fictional-client".into(), "1001".into(), true)
                    .unwrap();
                let _ = auth.refresh();
                assert_ne!(
                    auth.status_or_busy().unwrap().state,
                    ConnectionState::Connected
                );
                assert_eq!(
                    bound_church(&consumer).as_deref(),
                    Some("1001"),
                    "refused {refuse}"
                );
            }
            // Connected, then the renewal three hours later is refused.
            let (consumer, pco, clock) = launched();
            pco.refuse.store(true, Ordering::SeqCst);
            clock.store(3 * HOUR, Ordering::SeqCst);
            let _ = renewed_auth(&consumer);
            assert!(session_auth(&consumer).is_err());
            assert_eq!(
                bound_church(&consumer).as_deref(),
                Some("1001"),
                "expired after use"
            );
            // A one-click sign-in under way from church 1001: the church it replaced.
            let (consumer, _pco, _clock) = saved(Some("fictional-app".into()));
            let auth = consumer
                .0
                .prepare_check("fictional-client".into(), "1001".into(), true)
                .unwrap();
            let _ = auth.refresh();
            consumer.0.prepare_finder().unwrap();
            assert_eq!(
                bound_church(&consumer).as_deref(),
                Some("1001"),
                "finder under way"
            );
        }
    }

    #[test]
    fn church_switch_errors_keep_the_names_the_page_reads() {
        let json =
            |error: ConnectionsError| serde_json::to_string(&ConsumerError::from(error)).unwrap();
        assert_eq!(json(ConnectionsError::SwitchPending), r#""switch-pending""#);
        assert_eq!(json(ConnectionsError::NoQuestion), r#""no-question""#);
        assert_eq!(
            json(ConnectionsError::SwitchUnchecked(
                AuthError::ProviderFailure
            )),
            r#"{"switch-unchecked":"provider-failure"}"#
        );
        assert_eq!(
            json(ConnectionsError::Authentication(AuthError::Busy)),
            r#"{"authentication":"busy"}"#
        );
        assert_eq!(
            json(ConnectionsError::RegistrationRequired),
            r#""registration-required""#
        );
        assert_eq!(json(ConnectionsError::NotRevoked), r#""not-revoked""#);
        assert_eq!(
            json(ConnectionsError::KeepUnchecked(AuthError::InvalidToken)),
            r#"{"keep-unchecked":"invalid-token"}"#
        );
        assert_eq!(json(ConnectionsError::LeftChurch), r#""left-church""#);
        assert_eq!(
            json(ConnectionsError::SignInInstead),
            r#""sign-in-instead""#
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
        let forms = |v: &'static str| {
            dev_defaults_from(move |key: &str| (key == "OZZIE_DEV_FORMS").then(|| v.to_string()))
                .forms
        };
        assert_eq!(forms("1"), "1");
        assert_eq!(forms("610"), "610");
        assert_eq!(forms("610,611"), "610,611");
        for bad in [
            "",
            "0",
            "on",
            "0610",
            "610,",
            "610;rm",
            "1,2,3,4,5,6,7,8,9,10,11",
        ] {
            assert_eq!(forms(bad), "", "{bad}");
        }
        let flag = |key: &'static str, v: &'static str| {
            let d = dev_defaults_from(move |k: &str| (k == key).then(|| v.to_string()));
            (d.autopilot_check_ins, d.autopilot_registrations)
        };
        assert_eq!(flag("OZZIE_DEV_CHECK_INS", "1"), (true, false));
        assert_eq!(flag("OZZIE_DEV_REGISTRATIONS", "1"), (false, true));
        assert_eq!(flag("OZZIE_DEV_CHECK_INS", "yes"), (false, false));
    }
}
