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
    sunday_picker::{self, Choices, PlanChoice, ServiceTypeChoice},
};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;
use tauri::Manager;

use ozzie_native_auth::lifetime;
// H6: keeps running with the window closed (menu bar, timer, App Nap, open at login, responsibilities).
mod always_on;
// The macOS app menu: the default one, with a "Quit Ozzie" (Command-Q) that asks first (review P, M1).
mod app_menu;
// The leader's own calendars on Today, read-only: Apple Calendar on this Mac and private calendar links.
mod calendars;
// Visitor cards: Ozzie's own images-only photo panel (no path ever comes from the page).
mod card_picker;
mod church_sources;
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
    fn snapshot(&self) -> NameGuard {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}
/// The Sunday check, setup's picker and a note opened with its person in To take turns on the one
/// Planning Center connection; core `sunday_check::Turns` holds the rule. A second check is refused
/// rather than interleaved. A check waits out a picker read or a note (each bounded, under
/// `CHECK_WAITS_FOR_PICKER`) so it never records `busy` gaps because of them; a picker read waits
/// for the others up to `sunday_picker::WAIT_FOR_CONTROLLER`, then answers `busy`; a note never
/// waits (draft_apps::open_draft_to).
type SundayChecks = sunday_check::Turns;
/// How long a check waits for the turn. A note's read holds it about 23 s at the very worst (its 8 s
/// deadline, then an identity check already under way, which the sign-in client limits to 15 s; a
/// page read is limited to 5 s; it never renews the sign-in), so a check outlasts it. A picker read
/// (up to 10 s waiting for the connection, then the identity check and one page) can take about this
/// long at the very worst; one that first renews the sign-in (`renewed_auth`: up to `RENEWAL_WAITS`
/// for a sign-in or Disconnect under way, then a token request and an identity check, each limited
/// to 15 s) can take longer, and a check waiting for it then answers `busy`.
const CHECK_WAITS_FOR_PICKER: Duration = Duration::from_secs(30);
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
    // A refused hand-over leaves the finder in place; its own status is reported.
    tauri::async_runtime::spawn_blocking(move || consumer.0.view().map_err(ConsumerError::from))
        .await
        .map_err(|_| ConsumerError::NativeUnavailable)?
}
/// `operations` (optional, default false) opts in to the Calendar, People and Groups scopes for
/// the Sunday check's operations reads; `check_ins` and `registrations` (optional, default false)
/// each opt in to that product's counts. Each Planning Center product scope permits read and
/// write in that product; Ozzie only issues GET source reads, and asks for Services alone unless
/// the person chooses more. `ConnectionStatus.scopes` reports what Planning Center actually
/// granted, read from its token response; a grant wider than asked fails as `scope-mismatch`
/// and saves nothing. A new sign-in revokes the saved credential it replaces. One that ends bound
/// to another church changes nothing about the earlier one until the person answers
/// (`answer_church_switch`); while that question is open, sign-ins wait (`switch-pending`).
#[tauri::command]
async fn connect_planning_center(
    consumer: tauri::State<'_, Consumer>,
    client_id: String,
    organization: String,
    registered: bool,
    operations: Option<bool>,
    check_ins: Option<bool>,
    registrations: Option<bool>,
) -> Result<ConnectionStatus, ConsumerError> {
    let consumer = consumer.inner().clone();
    let scopes = Scopes::asked(
        operations.unwrap_or(false),
        check_ins.unwrap_or(false),
        registrations.unwrap_or(false),
    );
    tauri::async_runtime::spawn_blocking(move || {
        sign_in(&consumer, scopes, |consumer| {
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
/// Keychain storage and read-only reads as `connect_planning_center`.
#[tauri::command]
async fn connect_planning_center_app(
    consumer: tauri::State<'_, Consumer>,
    operations: Option<bool>,
    check_ins: Option<bool>,
    registrations: Option<bool>,
) -> Result<ConnectionStatus, ConsumerError> {
    let consumer = consumer.inner().clone();
    let scopes = Scopes::asked(
        operations.unwrap_or(false),
        check_ins.unwrap_or(false),
        registrations.unwrap_or(false),
    );
    tauri::async_runtime::spawn_blocking(move || {
        sign_in(&consumer, scopes, |consumer| {
            Ok(consumer.0.prepare_finder()?)
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
/// Checks a saved sign-in (on launch, before a check, or "Check saved connection"). Only the church
/// Ozzie last used is checked into use: when Settings name another church, that one is checked
/// instead and the other reported as `declined` (core `Connections::prepare_check`). Once it checks
/// out, any other church's sign-in saved on this Mac is asked about; nothing is signed out here.
#[tauri::command]
async fn check_saved_connection(
    consumer: tauri::State<'_, Consumer>,
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
        Ok(consumer.0.view_of(status))
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
        Ok(consumer.0.disconnect()?)
    })
    .await
    .map_err(|_| ConsumerError::NativeUnavailable)?
}
/// The person's answer to "Switch Ozzie to this church?" (`question`: the question's native id).
/// `switch` checks the new church with Planning Center, then signs Ozzie out of every other saved
/// sign-in the question named (revoked first, deleted only once that worked); `stay` checks the
/// church that stays, then signs out of the new one. If either check fails nothing changes. The
/// page sends only the answer: which sign-ins are signed out is decided natively. Returns the
/// church now in use; the same answer sent again returns it again.
#[tauri::command]
async fn answer_church_switch(
    consumer: tauri::State<'_, Consumer>,
    decision: Decision,
    question: u64,
) -> Result<SwitchAnswer, ConsumerError> {
    let consumer = consumer.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (_transition, _) = consumer
            .1
            .enter()
            .ok_or(ConsumerError::Authentication(AuthError::Busy))?;
        Ok(consumer.0.answer(decision, question)?)
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
    let kids_team_ids = kids_team_ids.unwrap_or_default();
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
                },
                &AtomicBool::new(false),
            )
        })?
        .map_err(|error| ConsumerError::SundayCheck(error.reason()))?;
        names.remember(&capture);
        // Who "Open in Mail" or "Open in Messages" may put in To (draft_apps::open_draft_to).
        people.remember(&capture);
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
    app: tauri::AppHandle,
    organization: String,
    path_id: String,
) -> Result<SundayCapture, ConsumerError> {
    let names = names.inner().clone();
    let people = people.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let capture = sunday_check::load_recording(&recordings(&app)?, &organization, &path_id)
            .map_err(ConsumerError::Recording)?;
        names.remember(&capture);
        people.remember(&capture);
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
const SUNDAY_NOTICE_BODY: &str = "Sunday coverage needs attention. Open Ozzie to see details.";
/// The webview asks for the Sunday notice and passes no text. The capability grants none of the
/// notification plugin's own commands, so the webview cannot show any other notification text. While
/// "A notice on your phone" is on, its fixed line also goes to the leader's phone, after this one,
/// unless the page says it stays on this Mac (`local_only`: a notice only about a background check).
#[tauri::command]
fn notify_sunday_attention(
    app: tauri::AppHandle,
    local_only: Option<bool>,
) -> Result<(), &'static str> {
    use ozzie_native_auth::phone_notice::Line;
    use tauri_plugin_notification::NotificationExt;
    let shown = app
        .notification()
        .builder()
        .title(SUNDAY_NOTICE_TITLE)
        .body(SUNDAY_NOTICE_BODY)
        .show()
        .map_err(|_| "notification-unavailable");
    phone_notice::also_to_phone(&app, Line::SundayAttention, local_only);
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
        .manage(CheckedPeople::default())
        .manage(Ledger::default())
        .manage(ManagedConnect::default())
        .manage(local_tools::LocalTools::default())
        .manage(shortcuts::OpenedPage::default())
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
            updater::setup(app);
            phone_notice::setup(app);
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
            answer_church_switch,
            retry_church_sign_out,
            remove_refused_sign_ins,
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
            card_picker::choose_card_photos,
            draft_apps::open_draft,
            draft_apps::open_draft_to,
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
            updater::update_install
        ])
        .on_page_load(|window, _| always_on::on_page_load(window))
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

        /// Saved sign-ins by church.
        struct Store(Mutex<std::collections::BTreeMap<String, Vec<u8>>>);
        impl CredentialStore for Store {
            fn put(&self, _: &str, organization: &str, value: &[u8]) -> Result<(), StoreError> {
                self.0
                    .lock()
                    .unwrap()
                    .insert(organization.into(), value.to_vec());
                Ok(())
            }
            fn get(&self, _: &str, organization: &str) -> Result<Option<Vec<u8>>, StoreError> {
                Ok(self.0.lock().unwrap().get(organization).cloned())
            }
            fn delete(&self, _: &str, organization: &str) -> Result<(), StoreError> {
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
                Ok(())
            }
        }
        /// Ozzie started at 0 with a sign-in saved on this Mac and checked it, as on launch.
        fn launched() -> (Consumer, Arc<Pco>, Arc<AtomicU64>) {
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
            });
            let saved = |church: &str| {
                format!(
                    r#"{{"client_id":"fictional-client","organization":"{church}","tokens":{{"access_token":"fictional-access-0","refresh_token":"fictional-refresh-0","token_type":"bearer","expires_in":7200}}}}"#
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
                    Arc::new(Store(Mutex::new(store))),
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
