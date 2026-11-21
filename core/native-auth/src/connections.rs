//! The desktop app's one Planning Center connection: signing in (pasted IDs, or one click where
//! Planning Center names the organization), checking a saved sign-in, disconnecting, and switching
//! Ozzie to another church only after the person answers (owner decision 2026-11-15, "a confirmed
//! church switch that retires the old sign-in"; independent reviews R and S).
//!
//! Ozzie works with one church at a time. A sign-in that ends bound to another organization than
//! the saved one it replaced changes nothing about the earlier one: the new connection is held
//! aside, the earlier church stays current (`settle`), and the page asks "Switch Ozzie to this
//! church?". Only an answer to that question (`answer`) signs anything out, and what it signs out
//! is chosen here, from this Mac's saved sign-ins (listed by Keychain attributes, no secret read),
//! never from page arguments:
//!  - Switch: the new church's connection is checked with Planning Center first; then every other
//!    saved sign-in the question named is revoked at Planning Center and, only once that worked,
//!    deleted (`AuthController::retire_saved`).
//!  - Keep: the church that stays is checked with Planning Center first; then the new sign-in is
//!    revoked and deleted the same way. If either church can't be checked, nothing changes and the
//!    question stays (review S, M2).
//!
//! The answer arrives from the app's own page, as Disconnect does: the page is trusted to send it
//! only on the person's click. Native code decides what that click signs out of.
//!
//! A sign-in that was cancelled, expired, failed or whose hand-over was refused never reaches the
//! question, so it signs nothing out (review R, M1). A sign-in left saved that way, or by an
//! earlier version, isn't lost: the next time a saved sign-in is checked (`after_check`, as on
//! every launch) the others are listed and the same question is asked about them, so a question
//! still open when Ozzie quits is asked again on the next launch. What couldn't be signed out yet
//! stays saved and is reported per sign-in with its reason (`Unretired`), with a retry (`retry`);
//! one Planning Center refused outright can be removed from this Mac on request
//! (`remove_refused`). A church the person chose to leave can't be checked back into use. The
//! same organization signing in again (for more access) is never asked.
//!
//! Which church is in use is decided natively, from the church Ozzie last used (`in_use`, kept in
//! the app's data folder), never from which church the page's settings name: a check makes current
//! only that church (`prepare`), and the page's check of another church checks that one instead
//! (`prepare_check`). Any other saved sign-in, one Ozzie found or one from before, becomes current
//! only through a fresh browser sign-in and the person's answer (review S3, M1). A sign-in the
//! person abandons leaves Ozzie on the church it replaced (review S3, L2).
//!
//! The Connections lock only ever guards this module's own state: Keychain reads and writes,
//! Planning Center requests and waiting for a controller all happen outside it, so status polling
//! and reads never queue behind them (review S, L1).
use crate::callback::CallbackServer;
use crate::credentials::{CredentialStore, read_private};
use crate::in_use::{UseHistory, UsedChurch};
use crate::oauth::{
    AuthController, AuthError, Binding, ConnectionState, ConnectionStatus, NotRetired, Provider,
    RecordFingerprint, Retired, Scopes, numeric_id, remove_saved_record, saved_record_fingerprint,
    stored_scopes,
};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

pub type Clock = Arc<dyn Fn() -> u64 + Send + Sync>;
pub type Factory<T> = Box<dyn Fn() -> Result<T, AuthError> + Send + Sync>;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConnectionsError {
    RegistrationRequired,
    NativeUnavailable,
    Authentication(AuthError),
    /// Disconnect waited for an in-flight read and gave up: nothing was revoked or deleted.
    NotRevoked,
    /// Another church's sign-in waits for the person's answer: signing in, disconnecting and
    /// checking another church wait until then.
    SwitchPending,
    /// Nothing is waiting for that answer, or to be signed out (already answered, or a newer
    /// question is open).
    NoQuestion,
    /// The new church's sign-in couldn't be checked, so nothing changed.
    SwitchUnchecked(AuthError),
    /// The church Ozzie would keep couldn't be checked, so nothing changed.
    KeepUnchecked(AuthError),
    /// A church the person chose to leave isn't checked back into use.
    LeftChurch,
    /// A sign-in Ozzie found saved on this Mac is never switched to, or checked into use, as it
    /// is: the person signs in to that church instead (review S2, L3; review S3, M1).
    SignInInstead,
}
impl From<AuthError> for ConnectionsError {
    fn from(error: AuthError) -> Self {
        Self::Authentication(error)
    }
}

/// What the page asks while another church's sign-in is saved on this Mac. Organization IDs,
/// churches' names as Planning Center stated them, and a public client ID only; never a credential.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Question {
    /// Native: an answer names the question it answers, so a stale page can't answer a newer one.
    pub id: u64,
    /// The church the question offers to switch to: the sign-in just finished (`fresh`), or one
    /// found saved on this Mac from before.
    pub to: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to_name: Option<String>,
    /// The church Ozzie is using now; it stays current until the person switches.
    pub from: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_name: Option<String>,
    /// The registration `from` is saved with: empty for Ozzie's own, else the public client ID
    /// typed under Advanced, so the page's settings can keep showing the church in use.
    pub from_client: String,
    /// Every saved sign-in that switching signs Ozzie out of (`from` among them), sorted.
    pub others: Vec<String>,
    pub fresh: bool,
}
/// Why a sign-in the person chose to leave is still saved.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RetireFailure {
    /// Planning Center couldn't be reached, or didn't answer clearly: trying again may work.
    RevokeFailed,
    /// Planning Center refused (a registration it no longer has): trying again won't help.
    Refused,
    Locked,
    Denied,
    Unavailable,
    /// Ozzie closed before it finished signing out of it; found again at this launch (review S3,
    /// L1).
    Unfinished,
}
impl From<&AuthError> for RetireFailure {
    fn from(error: &AuthError) -> Self {
        use crate::credentials::StoreError;
        match error {
            AuthError::RevokeRefused => Self::Refused,
            AuthError::Store(StoreError::Locked) => Self::Locked,
            AuthError::Store(StoreError::Denied) => Self::Denied,
            AuthError::Store(StoreError::Unavailable) => Self::Unavailable,
            _ => Self::RevokeFailed,
        }
    }
}
/// One sign-in the person chose to leave that is still saved on this Mac, and why.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct LeftBehind {
    pub organization: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub reason: RetireFailure,
    /// Whether it was saved with Ozzie's own registration ("Ozzie for Mac" in Planning Center),
    /// when its record could be read: where the person would remove it there.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ozzie_registration: Option<bool>,
    /// Native only: the record it is about. A retry or removal acts only while the slot still
    /// holds it, never on a newer sign-in saved there since (review S2, M2).
    #[serde(skip)]
    pub record: Option<RecordFingerprint>,
}
/// Sign-ins the person chose to leave that are still saved on this Mac, each with its own reason.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Unretired {
    pub left: Vec<LeftBehind>,
}
/// The church Ozzie uses now, natively: the page's settings follow it after an answer.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct InUse {
    pub organization: String,
    /// Empty for Ozzie's own registration, else the public client ID typed under Advanced.
    pub client_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Decision {
    /// Switch Ozzie to the question's `to`, signing out of every one of its `others`. Only for a
    /// sign-in the person just made (`fresh`).
    Switch,
    /// Keep Ozzie on `from`, signing out of `to`.
    Stay,
    /// For a sign-in Ozzie found saved (not `fresh`): close the question without signing out of
    /// anything, so the person can sign in to `to` in the browser instead; that sign-in replaces
    /// (and revokes) the found one and asks again before Ozzie stops using `from`.
    SignIn,
}
/// A connection status with what waits for the person, for the page.
#[derive(Debug, Clone, serde::Serialize)]
pub struct StatusView {
    #[serde(flatten)]
    pub status: ConnectionStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub switch: Option<Question>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unretired: Option<Unretired>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub in_use: Option<InUse>,
    /// Native: grows with every change to the church in use, the question or what is left behind,
    /// so the page can ignore a status read before an answer that arrives after it (review S, L5).
    pub revision: u64,
    /// The church the page's last check asked for, which Ozzie doesn't use without a fresh
    /// sign-in: the church Ozzie last used was checked instead (review S3, M1 and L1).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub declined: Option<String>,
    /// How the last sign-in ended when it didn't connect (cancelled, expired, failed and why) while
    /// the church it replaced went back into use; kept until the next sign-in or check starts
    /// (review S4, M1). The same page-facing status a sign-in reports; no credential.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_attempt: Option<ConnectionStatus>,
    /// The church Ozzie last used, whose sign-in is no longer saved on this Mac: the church the
    /// check asked for was checked instead, as before Ozzie kept that record (review S4, L3).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub missing: Option<String>,
}
/// After an answer: the church Ozzie now uses, for the page's settings (`client_id` empty for
/// Ozzie's own registration).
#[derive(Debug, Clone, serde::Serialize)]
pub struct SwitchAnswer {
    pub status: StatusView,
    pub client_id: String,
    pub organization: String,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Purpose {
    /// A browser sign-in with pasted IDs.
    SignIn,
    /// Checking a saved sign-in (on launch, before a check, or "Check saved connection").
    Check,
}

struct Session {
    auth: Arc<AuthController>,
    receiver: Option<CallbackServer>,
    /// A one-click sign-in still waiting to hand over to a bound connection (`settle`).
    finding: bool,
    /// The (registration, organization) of the bound connection: this session's own, or for a
    /// finder the one it replaced, so Disconnect can still revoke it if the sign-in never finishes.
    bound: Option<(String, String)>,
    /// A pasted-ID sign-in not yet seen connected (`settle` decides once it is).
    signing: bool,
    /// For a sign-in session: the connection it replaced, which stays current if the sign-in
    /// binds to another church whose question is still open.
    previous: Option<Previous>,
    /// A sign-in that ended without connecting whose earlier church couldn't be put back: settled
    /// as it is, so status polls stop asking the Keychain (review S4, L4).
    abandoned: bool,
}
struct Previous {
    auth: Arc<AuthController>,
    bound: (String, String),
}
impl Session {
    fn bound(auth: Arc<AuthController>, bound: (String, String)) -> Self {
        Self {
            auth,
            receiver: None,
            finding: false,
            bound: Some(bound),
            signing: false,
            previous: None,
            abandoned: false,
        }
    }
    /// What a new sign-in replaces: this connection, or, if this was itself a sign-in that never
    /// finished, the connection before it.
    fn into_previous(self) -> Option<Previous> {
        if self.finding || self.signing {
            return self.previous;
        }
        self.bound.map(|bound| Previous {
            auth: self.auth,
            bound,
        })
    }
}
struct Pending {
    question: Question,
    /// The new sign-in's connection, held aside (fresh questions only).
    new: Option<Arc<AuthController>>,
}
#[derive(Default)]
struct State {
    session: Option<Session>,
    switch: Option<Pending>,
    unretired: Vec<LeftBehind>,
    /// Churches' names as Planning Center stated them this run, by organization.
    names: HashMap<String, String>,
    revision: u64,
    questions: u64,
    /// The last answer carried out, so the same answer sent again gets today's state.
    answered: Option<(u64, Decision)>,
    /// The church Ozzie uses, or last used before this launch's check: the only saved sign-in a
    /// check may make current (review S3, M1). Mirrored in the use history.
    used: Option<UsedChurch>,
    /// Churches Ozzie was still signing out of when it last closed, until this launch's first
    /// check reports them as left behind (`after_check`).
    unfinished: Vec<String>,
    /// The church the last check asked for and was not allowed (`prepare_check`).
    declined: Option<String>,
    /// How the last abandoned sign-in ended, while the church it replaced is back in use.
    last_attempt: Option<ConnectionStatus>,
    /// The church Ozzie last used, found without a saved sign-in by the last check.
    missing: Option<String>,
}
impl State {
    fn changed(&mut self) {
        self.revision += 1;
    }
    fn left(&self, organization: &str) -> bool {
        self.unretired
            .iter()
            .any(|left| left.organization == organization)
    }
    fn name(&self, organization: &str) -> Option<String> {
        self.names.get(organization).cloned()
    }
    fn learn(&mut self, status: &ConnectionStatus) {
        if let Some(name) = &status.organization_name
            && numeric_id(&status.organization)
        {
            self.names.insert(status.organization.clone(), name.clone());
        }
    }
}
/// A controller stopped in a lock hold (`halt`), to be cancelled and its receiver joined after.
type Stopped = Option<(Arc<AuthController>, Option<CallbackServer>)>;

pub struct Connections {
    state: Mutex<State>,
    /// Where saved connections live, per organization: `prefix` + organization.
    prefix: &'static str,
    /// Ozzie's own Public registration, when built in (one-click connect).
    app_client: Option<String>,
    store: Arc<dyn CredentialStore>,
    provider: Factory<Arc<dyn Provider>>,
    clock: Factory<Clock>,
    /// Where the church in use is kept across launches (the app's data folder), once the app set it.
    history: OnceLock<Arc<dyn UseHistory>>,
    /// Writes to the history are taken one at a time, each with the state as its turn comes.
    history_writes: Mutex<()>,
}
impl Connections {
    pub fn new(
        prefix: &'static str,
        app_client: Option<String>,
        store: Arc<dyn CredentialStore>,
        provider: Factory<Arc<dyn Provider>>,
        clock: Factory<Clock>,
    ) -> Self {
        Self {
            state: Mutex::default(),
            prefix,
            app_client,
            store,
            provider,
            clock,
            history: OnceLock::new(),
            history_writes: Mutex::new(()),
        }
    }
    /// Remembers which church Ozzie uses across launches. Set once, at start, before any check:
    /// the church last used is read back here.
    pub fn keep_use_history(&self, history: Arc<dyn UseHistory>) {
        let loaded = history.load();
        if self.history.set(history).is_err() {
            return;
        }
        if let (Some(used), Ok(mut state)) = (loaded, self.lock())
            && state.used.is_none()
        {
            state.unfinished = used.leaving.clone();
            state.used = Some(UsedChurch {
                leaving: Vec::new(),
                ..used
            });
        }
    }
    /// The church in use as a session's (registration, organization) names it.
    fn use_of(&self, bound: &(String, String)) -> UsedChurch {
        UsedChurch {
            organization: bound.1.clone(),
            client_id: self.public(&bound.0),
            leaving: Vec::new(),
        }
    }
    /// Writes the church in use to the history, with every church still being signed out of
    /// (left behind, unfinished from before, and `leaving`). Never with the Connections lock held.
    fn persist(&self, leaving: &[String]) {
        let Some(history) = self.history.get() else {
            return;
        };
        let Ok(_turn) = self.history_writes.lock() else {
            return;
        };
        let used = {
            let Ok(state) = self.lock() else {
                return;
            };
            let Some(used) = state.used.clone() else {
                return;
            };
            let mut out: Vec<String> = state
                .unretired
                .iter()
                .map(|left| left.organization.clone())
                .chain(state.unfinished.iter().cloned())
                .chain(leaving.iter().cloned())
                .filter(|o| *o != used.organization && numeric_id(o))
                .collect();
            out.sort();
            out.dedup();
            UsedChurch {
                leaving: out,
                ..used
            }
        };
        // A failed write keeps the earlier record; this run goes on from memory.
        let _ = history.save(&used);
    }
    fn lock(&self) -> Result<MutexGuard<'_, State>, ConnectionsError> {
        self.state
            .lock()
            .map_err(|_| ConnectionsError::NativeUnavailable)
    }
    fn controller(
        &self,
        client: String,
        organization: String,
    ) -> Result<AuthController, AuthError> {
        AuthController::new(
            Binding {
                workspace: format!("{}{organization}", self.prefix),
                organization,
                client_id: client,
            },
            self.store.clone(),
            (self.provider)()?,
            (self.clock)()?,
        )
    }
    /// The registration as the page keeps it: empty for Ozzie's own.
    fn public(&self, client: &str) -> String {
        if self.app_client.as_deref() == Some(client) {
            String::new()
        } else {
            client.to_string()
        }
    }
    /// The organizations with a saved sign-in on this Mac, sorted: the Keychain's listing by
    /// attributes (exactly Ozzie's own slot shape, `prefix` + a plain organization number), plus
    /// every one of `known` (the churches involved right now) that is saved there or can't be
    /// read. A listing that leaves out the church in use therefore can't let another church
    /// become current without a question (fail closed; review S2, L4). Never called with the
    /// Connections lock held.
    fn saved(&self, known: &[&str]) -> Vec<String> {
        let mut saved: Vec<String> = self
            .store
            .accounts()
            .map(|accounts| {
                accounts
                    .into_iter()
                    .filter(|(workspace, organization)| {
                        numeric_id(organization)
                            && *workspace == format!("{}{organization}", self.prefix)
                    })
                    .map(|(_, organization)| organization)
                    .collect()
            })
            .unwrap_or_default();
        saved.extend(
            known
                .iter()
                .filter(|organization| {
                    numeric_id(organization)
                        && !saved.iter().any(|s| s == *organization)
                        && !matches!(
                            crate::credentials::read_private(
                                self.store.as_ref(),
                                &format!("{}{organization}", self.prefix),
                                organization,
                            ),
                            Ok(None)
                        )
                })
                .map(|organization| organization.to_string())
                .collect::<Vec<_>>(),
        );
        saved.sort();
        saved.dedup();
        saved
    }
    /// `status` with what waits for the person, the church in use, and the revision.
    fn decorate(&self, status: ConnectionStatus) -> StatusView {
        let Ok(mut state) = self.lock() else {
            return StatusView {
                status,
                switch: None,
                unretired: None,
                in_use: None,
                revision: 0,
                declined: None,
                last_attempt: None,
                missing: None,
            };
        };
        state.learn(&status);
        let in_use = state
            .session
            .as_ref()
            .filter(|s| !s.finding && !s.signing)
            .and_then(|s| s.bound.clone())
            .filter(|(_, organization)| {
                *organization == status.organization
                    && matches!(
                        status.state,
                        ConnectionState::Connected | ConnectionState::StoredUnchecked
                    )
            })
            .map(|(client, organization)| InUse {
                client_id: self.public(&client),
                name: state.name(&organization),
                organization,
            });
        StatusView {
            switch: state.switch.as_ref().map(|p| p.question.clone()),
            unretired: (!state.unretired.is_empty()).then(|| Unretired {
                left: state.unretired.clone(),
            }),
            in_use,
            revision: state.revision,
            declined: state.declined.clone(),
            last_attempt: state.last_attempt.clone(),
            missing: state.missing.clone(),
            status,
        }
    }
    pub fn view_of(&self, status: ConnectionStatus) -> StatusView {
        self.decorate(status)
    }
    /// The church Ozzie uses, or used last before this launch's check (`used`), connected or not: the one church a
    /// sign-in decides before it can add a grant, and the one a sign-in again stays one click for (the app's `again`).
    pub fn church_in_use(&self) -> Option<String> {
        self.lock()
            .ok()?
            .used
            .as_ref()
            .map(|used| used.organization.clone())
    }
    /// What the sign-in saved on this Mac for `organization` was granted, from its record's non-secret set; None when
    /// none is saved or it can't be read. Nothing secret leaves here, and the lock isn't held for the Keychain read. A
    /// sign-in again for that church asks Planning Center for exactly this (the app's `again`), so it neither drops
    /// access the church has nor asks for more (review 2026-11-18, late).
    pub fn held(&self, organization: &str) -> Option<Scopes> {
        if !numeric_id(organization) {
            return None;
        }
        let bytes = read_private(
            self.store.as_ref(),
            &format!("{}{organization}", self.prefix),
            organization,
        )
        .ok()??;
        stored_scopes(&bytes)
    }
    /// The session's controller as installed now, without handing over.
    pub fn current(&self) -> Option<Arc<AuthController>> {
        self.lock()
            .ok()?
            .session
            .as_ref()
            .map(|session| session.auth.clone())
    }
    /// The current status for the page after any hand-over, with what waits for the person. A
    /// refused hand-over leaves the finder in place; its own status is reported. Never waits for a
    /// Keychain write in progress (`status_or_busy`).
    pub fn view(&self) -> Result<Option<StatusView>, ConnectionsError> {
        let auth = match self.settle() {
            Ok(auth) => auth.map(|(auth, _)| auth),
            Err(_) => self.current(),
        };
        auth.map(|auth| Ok(self.decorate(auth.status_or_busy()?)))
            .transpose()
    }
    /// Stops the current controller in the caller's lock hold without waiting for it: interrupted
    /// atomically, so a sign-in it was running can no longer finish into a question afterwards.
    /// The caller cancels it fully and joins its receiver after unlocking (`finish_stop`).
    fn halt(state: &mut State) -> Stopped {
        let session = state.session.as_mut()?;
        session.auth.interrupt();
        Some((session.auth.clone(), session.receiver.take()))
    }
    fn finish_stop(stopped: Stopped) {
        if let Some((auth, receiver)) = stopped {
            auth.cancel();
            if let Some(mut receiver) = receiver {
                receiver.stop();
            }
        }
    }
    /// Cancels the current controller and stops its browser receiver; nothing waits under the
    /// lock (review R, N4; review S, L1).
    pub fn stop_current(&self) {
        let stopped = self
            .state
            .lock()
            .ok()
            .and_then(|mut state| Self::halt(&mut state));
        Self::finish_stop(stopped);
    }
    /// Keeps a sign-in's browser receiver with its session, unless the session changed meanwhile.
    pub fn attach_receiver(
        &self,
        auth: &Arc<AuthController>,
        receiver: CallbackServer,
    ) -> Result<(), ConnectionsError> {
        let mut state = self.lock()?;
        match state.session.as_mut() {
            Some(session) if Arc::ptr_eq(&session.auth, auth) => {
                session.receiver = Some(receiver);
                Ok(())
            }
            _ => {
                drop(state);
                drop(receiver);
                Err(AuthError::Cancelled.into())
            }
        }
    }
    /// A bound controller for pasted IDs or a saved sign-in. An empty `client` means Ozzie's own
    /// registration, which is registered by definition. While a question is open, only a check of
    /// the church Ozzie still uses is allowed; a church the person chose to leave is never checked
    /// back into use (review S, L4). A check makes current only the church Ozzie last used: any
    /// other saved sign-in waits for a fresh sign-in (`SignInInstead`; review S3, M1). Whether
    /// anything is open, and what the new session replaces, is decided in the same lock hold that
    /// installs it (review R, L2b).
    pub fn prepare(
        &self,
        client: String,
        organization: String,
        registered: bool,
        purpose: Purpose,
    ) -> Result<Arc<AuthController>, ConnectionsError> {
        self.prepare_as(client, organization, registered, purpose, true)
    }
    /// The page's check of a saved sign-in (on launch, before a Sunday check, "Check saved
    /// connection"): the church asked for when Ozzie may use it. Otherwise, while the church Ozzie
    /// last used is still saved, that church is checked instead and the one asked for is reported
    /// as `declined`, so settings naming another church never make its sign-in current (review
    /// S3, M1 and L1).
    pub fn prepare_check(
        &self,
        client: String,
        organization: String,
        registered: bool,
    ) -> Result<Arc<AuthController>, ConnectionsError> {
        match self.prepare(client, organization.clone(), registered, Purpose::Check) {
            Err(ConnectionsError::SignInInstead) => {}
            other => return other,
        }
        let used = self
            .lock()?
            .used
            .clone()
            .ok_or(ConnectionsError::SignInInstead)?;
        if !self
            .saved(&[&used.organization])
            .contains(&used.organization)
        {
            return Err(ConnectionsError::SignInInstead);
        }
        let auth = self.prepare(used.client_id, used.organization, true, Purpose::Check)?;
        let mut state = self.lock()?;
        // A church the person chose to leave is reported as left behind, not as declined.
        let leaving = state.left(&organization) || state.unfinished.contains(&organization);
        if !leaving
            && numeric_id(&organization)
            && state
                .session
                .as_ref()
                .is_some_and(|s| Arc::ptr_eq(&s.auth, &auth))
        {
            state.declined = Some(organization);
            state.changed();
        }
        Ok(auth)
    }
    /// `prepare`, with `history` false only for Disconnect's own revoke of the connection a
    /// one-click sign-in replaced.
    fn prepare_as(
        &self,
        client: String,
        organization: String,
        registered: bool,
        purpose: Purpose,
        history: bool,
    ) -> Result<Arc<AuthController>, ConnectionsError> {
        let client = if client.is_empty() {
            self.app_client
                .clone()
                .ok_or(ConnectionsError::RegistrationRequired)?
        } else if registered {
            client
        } else {
            return Err(ConnectionsError::RegistrationRequired);
        };
        // A check of another church is refused only while the church Ozzie last used still has a
        // saved sign-in. When that is gone, the church asked for is checked as before Ozzie kept
        // the record, and the page is told (`missing`; review S4, L3). Listed outside the lock.
        let gone = if purpose == Purpose::Check && history {
            let used = self.lock()?.used.as_ref().map(|u| u.organization.clone());
            used.filter(|u| *u != organization && !self.saved(&[u]).contains(u))
        } else {
            None
        };
        let refused = |state: &State| {
            if purpose == Purpose::Check && state.left(&organization) {
                return Some(ConnectionsError::LeftChurch);
            }
            if state.switch.as_ref().is_some_and(|pending| {
                purpose == Purpose::SignIn || pending.question.from != organization
            }) {
                return Some(ConnectionsError::SwitchPending);
            }
            // Only the church Ozzie last used is checked into use (review S3, M1).
            (purpose == Purpose::Check
                && history
                && state.used.as_ref().is_some_and(|used| {
                    used.organization != organization
                        && gone.as_deref() != Some(used.organization.as_str())
                }))
            .then_some(ConnectionsError::SignInInstead)
        };
        let stopped = {
            let mut state = self.lock()?;
            if let Some(error) = refused(&state) {
                return Err(error);
            }
            Self::halt(&mut state)
        };
        Self::finish_stop(stopped);
        let auth = Arc::new(self.controller(client.clone(), organization.clone())?);
        let mut state = self.lock()?;
        if let Some(error) = refused(&state) {
            drop(state);
            auth.cancel();
            return Err(error);
        }
        let old = state.session.take();
        let previous = match purpose {
            Purpose::SignIn => old.and_then(Session::into_previous),
            Purpose::Check => None,
        };
        state.session = Some(Session {
            auth: auth.clone(),
            receiver: None,
            finding: false,
            bound: Some((client, organization)),
            signing: purpose == Purpose::SignIn,
            previous,
            abandoned: false,
        });
        state.declined = None;
        state.last_attempt = None;
        state.missing = gone;
        state.changed();
        Ok(auth)
    }
    /// One click: Ozzie's built-in registration, and the organization Planning Center names. An
    /// earlier one-click sign-in that saved but was never taken over is left as it is: its sign-in
    /// stays saved and is asked about at the next check, or it is that same church's newest
    /// credential (review S, L3).
    pub fn prepare_finder(&self) -> Result<Arc<AuthController>, ConnectionsError> {
        let client = self
            .app_client
            .clone()
            .ok_or(ConnectionsError::RegistrationRequired)?;
        let stopped = {
            let mut state = self.lock()?;
            if state.switch.is_some() {
                return Err(ConnectionsError::SwitchPending);
            }
            Self::halt(&mut state)
        };
        Self::finish_stop(stopped);
        let auth = Arc::new(AuthController::find_organization(
            client,
            self.prefix,
            self.store.clone(),
            (self.provider)()?,
            (self.clock)()?,
        )?);
        let mut state = self.lock()?;
        if state.switch.is_some() {
            drop(state);
            auth.cancel();
            return Err(ConnectionsError::SwitchPending);
        }
        let previous = state.session.take().and_then(Session::into_previous);
        state.session = Some(Session {
            auth: auth.clone(),
            receiver: None,
            finding: true,
            bound: previous.as_ref().map(|p| p.bound.clone()),
            signing: false,
            previous,
            abandoned: false,
        });
        state.declined = None;
        state.last_attempt = None;
        state.missing = None;
        state.changed();
        Ok(auth)
    }
    /// Returns the session's controller after any hand-over, and whether it is still a finder
    /// (never to be used for reads). Once a sign-in has connected, decides whether Ozzie asks
    /// first (`finished`). A refused hand-over leaves the finder in place, so nothing reads; the
    /// person signs in again. The hand-over's Keychain reads and the listing run outside the
    /// lock; the result is installed only if the session is still the one looked at.
    /// For a one-click sign-in still under way: the church whose connection it replaced, which
    /// Disconnect also revokes (none for any other session, or a finder that replaced nothing).
    pub fn replaced_church(&self) -> Option<String> {
        let state = self.lock().ok()?;
        let session = state.session.as_ref().filter(|s| s.finding)?;
        session
            .bound
            .as_ref()
            .map(|(_, organization)| organization.clone())
            .filter(|organization| !organization.is_empty())
    }
    pub fn settle(&self) -> Result<Option<(Arc<AuthController>, bool)>, ConnectionsError> {
        let (auth, finding, previous) = {
            let state = self.lock()?;
            let Some(session) = state.session.as_ref() else {
                return Ok(None);
            };
            if !(session.finding || session.signing) || session.abandoned {
                return Ok(Some((session.auth.clone(), session.finding)));
            }
            (
                session.auth.clone(),
                session.finding,
                self.prior(&state, session),
            )
        };
        let attempt = auth.status_or_busy()?;
        let state = attempt.state.clone();
        if auth.is_cancelled()
            || matches!(
                state,
                ConnectionState::Cancelled | ConnectionState::Expired | ConnectionState::Failed
            )
        {
            return self.abandoned(&auth, finding, previous, attempt);
        }
        if state != ConnectionState::Connected {
            return Ok(Some((auth, finding)));
        }
        let new = if finding {
            Arc::new(auth.adopt_found()?)
        } else {
            auth.clone()
        };
        let organization = new.bound_to().1.to_string();
        let earlier = previous.as_ref().map(|(_, o)| o.as_str()).unwrap_or("");
        let saved = self.saved(&[&organization, earlier]);
        let restore = previous
            .clone()
            .filter(|(_, o)| *o != organization && saved.contains(o))
            .and_then(|(client, o)| self.controller(client, o).ok().map(Arc::new));
        let new_status = new.status_or_busy()?;
        let restored_status = restore.as_ref().and_then(|r| r.status_or_busy().ok());
        let mut state = self.lock()?;
        let still = state
            .session
            .as_ref()
            .is_some_and(|s| Arc::ptr_eq(&s.auth, &auth) && (s.finding || s.signing));
        if !still {
            // Replaced meanwhile (a check, a new sign-in, a disconnect): what this sign-in saved
            // stays saved and is asked about at the next check.
            return Ok(state.session.as_ref().map(|s| (s.auth.clone(), s.finding)));
        }
        let Some(mut old) = state.session.take() else {
            return Err(ConnectionsError::NativeUnavailable);
        };
        let ended = old.receiver.take();
        state.learn(&new_status);
        if let Some(status) = &restored_status {
            state.learn(status);
        }
        let installed = self.finished(
            &mut state,
            new,
            previous,
            old.previous.map(|p| p.auth),
            &saved,
            restore,
        );
        drop(state);
        self.persist(&[]);
        // The receiver ended itself after the callback it accepted; joined outside the lock.
        if let Some(mut receiver) = ended {
            receiver.stop();
        }
        Ok(Some((installed, false)))
    }
    /// The church a sign-in session replaced: its previous connection, or when there was none
    /// (nothing checked yet this launch), the church Ozzie last used, so a sign-in to another
    /// church asks before Ozzie stops using it (review S3, M1). Never a church the person left.
    fn prior(&self, state: &State, session: &Session) -> Option<(String, String)> {
        session
            .previous
            .as_ref()
            .map(|p| p.bound.clone())
            .or_else(|| {
                let used = state.used.as_ref()?;
                let client = if used.client_id.is_empty() {
                    self.app_client.clone()?
                } else {
                    used.client_id.clone()
                };
                Some((client, used.organization.clone()))
            })
            .filter(|(_, organization)| !state.left(organization))
    }
    /// A sign-in that ended without connecting (cancelled, expired, failed, or stopped before it
    /// was taken over) leaves Ozzie on the church it replaced, in use as before, while that
    /// church's sign-in is still saved (review S3, L2), and how it ended stays on the status
    /// (`last_attempt`; review S4, M1). Otherwise its own status is reported, and later polls
    /// return at once (review S4, L4).
    fn abandoned(
        &self,
        auth: &Arc<AuthController>,
        finding: bool,
        prior: Option<(String, String)>,
        mut attempt: ConnectionStatus,
    ) -> Result<Option<(Arc<AuthController>, bool)>, ConnectionsError> {
        let restore = prior
            .filter(|(_, o)| self.saved(&[o]).contains(o))
            .and_then(|(client, organization)| {
                self.controller(client.clone(), organization.clone())
                    .ok()
                    .map(|restored| (Arc::new(restored), client, organization))
            });
        let Some((restored, client, organization)) = restore else {
            if let Ok(mut state) = self.lock()
                && let Some(session) = state
                    .session
                    .as_mut()
                    .filter(|s| Arc::ptr_eq(&s.auth, auth))
            {
                session.abandoned = true;
            }
            return Ok(Some((auth.clone(), finding)));
        };
        // Stopped before it said so itself (interrupted, not yet cancelled): it was cancelled.
        if !matches!(
            attempt.state,
            ConnectionState::Cancelled | ConnectionState::Expired | ConnectionState::Failed
        ) {
            attempt.state = ConnectionState::Cancelled;
            attempt.problem = None;
            attempt.organization_diagnostic = None;
        }
        attempt.checked_at_ms = None;
        attempt.scopes = None;
        let mut state = self.lock()?;
        let still = state
            .session
            .as_ref()
            .is_some_and(|s| Arc::ptr_eq(&s.auth, auth) && (s.finding || s.signing));
        if !still {
            return Ok(state.session.as_ref().map(|s| (s.auth.clone(), s.finding)));
        }
        let ended = state.session.take().and_then(|mut s| s.receiver.take());
        state.session = Some(Session::bound(restored.clone(), (client, organization)));
        state.last_attempt = Some(attempt);
        state.changed();
        drop(state);
        // Status polls never wait (review S, L1): the abandoned controller is interrupted without
        // taking its lock (a Keychain write may still hold it), and its browser receiver, if one
        // is still listening, is stopped and joined off this thread.
        auth.interrupt();
        if let Some(mut receiver) = ended {
            std::thread::spawn(move || receiver.stop());
        }
        Ok(Some((restored, false)))
    }
    /// A sign-in connected `new`, which replaced `previous` (the church in use before it, or the
    /// church Ozzie last used; `prior`). If that is another church whose sign-in is still saved, it
    /// stays current (`restored`, built before the lock, else the halted `previous_auth`) and `new`
    /// is held aside for the question. Otherwise `new` is current, becomes the church Ozzie uses,
    /// and any other saved sign-ins are asked about. The same church is never asked.
    fn finished(
        &self,
        state: &mut State,
        new: Arc<AuthController>,
        previous: Option<(String, String)>,
        previous_auth: Option<Arc<AuthController>>,
        saved: &[String],
        restored: Option<Arc<AuthController>>,
    ) -> Arc<AuthController> {
        let (client, organization) = {
            let (client, organization) = new.bound_to();
            (client.to_string(), organization.to_string())
        };
        // Signed in to again: this sign-in's save replaced (and revoked) the credential that was
        // left behind there, so nothing about it is left to retry or remove (review S2, M2).
        state
            .unretired
            .retain(|left| left.organization != organization);
        state.unfinished.retain(|o| *o != organization);
        state.declined = None;
        let extras: Vec<String> = saved
            .iter()
            .filter(|o| **o != organization && !state.left(o))
            .cloned()
            .collect();
        let same = previous.as_ref().is_some_and(|p| p.1 == organization);
        state.changed();
        match (previous, restored.or(previous_auth)) {
            (Some(previous), Some(restored)) if !same && extras.contains(&previous.1) => {
                let (from_client, from) = previous.clone();
                state.session = Some(Session::bound(restored.clone(), previous));
                state.questions += 1;
                state.switch = Some(Pending {
                    question: Question {
                        id: state.questions,
                        to_name: state.name(&organization),
                        to: organization,
                        from_name: state.name(&from),
                        from,
                        from_client: self.public(&from_client),
                        others: extras,
                        fresh: true,
                    },
                    new: Some(new),
                });
                restored
            }
            _ => {
                state.session = Some(Session::bound(
                    new.clone(),
                    (client.clone(), organization.clone()),
                ));
                state.used = Some(self.use_of(&(client.clone(), organization.clone())));
                if !same && let Some(to) = extras.first() {
                    state.questions += 1;
                    state.switch = Some(Pending {
                        question: Question {
                            id: state.questions,
                            to: to.clone(),
                            to_name: state.name(to),
                            from_name: state.name(&organization),
                            from_client: self.public(&client),
                            others: saved.iter().filter(|o| *o != to).cloned().collect(),
                            from: organization,
                            fresh: false,
                        },
                        new: None,
                    });
                }
                new
            }
        }
    }
    /// After a saved sign-in checked out connected: it is the church Ozzie uses, remembered across
    /// launches. Any other saved sign-in on this Mac is asked about (one left from an earlier
    /// version, a cancelled sign-in, or a question still open when Ozzie quit), except one Ozzie
    /// was still signing out of when it last closed: that is reported as left behind, tied to the
    /// record found now (review S3, L1). Nothing is signed out here; Keychain reads run outside the
    /// lock.
    pub fn after_check(&self, auth: &Arc<AuthController>) {
        let Ok(status) = auth.status_or_busy() else {
            return;
        };
        if status.state != ConnectionState::Connected {
            return;
        }
        let looking = |state: &State| {
            state
                .session
                .as_ref()
                .is_some_and(|s| Arc::ptr_eq(&s.auth, auth) && !s.finding)
                && state.switch.is_none()
        };
        if !self.lock().is_ok_and(|state| looking(&state)) {
            return;
        }
        let (client, organization) = {
            let (client, organization) = auth.bound_to();
            (client.to_string(), organization.to_string())
        };
        let unfinished = {
            let Ok(mut state) = self.lock() else {
                return;
            };
            if !looking(&state) {
                return;
            }
            state.used = Some(self.use_of(&(client.clone(), organization.clone())));
            state.unfinished.clone()
        };
        self.persist(&[]);
        let saved = self.saved(&[&organization]);
        let records: Vec<(String, Result<Option<RecordFingerprint>, AuthError>)> = unfinished
            .iter()
            .filter(|o| **o != organization && saved.contains(o))
            .map(|o| {
                (
                    o.clone(),
                    saved_record_fingerprint(self.store.as_ref(), self.prefix, o),
                )
            })
            .collect();
        let Ok(mut state) = self.lock() else {
            return;
        };
        state.learn(&status);
        if !looking(&state) {
            return;
        }
        if !unfinished.is_empty() {
            state.unfinished.retain(|o| !unfinished.contains(o));
            for (left, record) in records {
                let (reason, record) = match record {
                    Ok(None) => continue,
                    Ok(Some(record)) => (RetireFailure::Unfinished, Some(record)),
                    Err(error) => (RetireFailure::from(&error), None),
                };
                if state.left(&left) {
                    continue;
                }
                let name = state.name(&left);
                state.unretired.push(LeftBehind {
                    organization: left,
                    name,
                    reason,
                    ozzie_registration: None,
                    record,
                });
            }
            state
                .unretired
                .sort_by(|a, b| a.organization.cmp(&b.organization));
            state.changed();
        }
        let Some(to) = saved
            .iter()
            .find(|o| **o != organization && !state.left(o))
            .cloned()
        else {
            return;
        };
        state.questions += 1;
        state.switch = Some(Pending {
            question: Question {
                id: state.questions,
                to_name: state.name(&to),
                from_name: state.name(&organization),
                from_client: self.public(&client),
                others: saved.iter().filter(|o| **o != to).cloned().collect(),
                to,
                from: organization,
                fresh: false,
            },
            new: None,
        });
        state.changed();
    }
    /// The person's answer to the open question `question` (its native `id`). Run inside the
    /// app's transition lock, so no sign-in, check or disconnect runs meanwhile. The same answer
    /// sent again after it was carried out (a lost response, a second click) gets today's state;
    /// any other answer to a question no longer open is `NoQuestion`. A sign-in Ozzie found saved
    /// (not `fresh`) is never switched to as it is: the answers are Keep, or `SignIn` to sign in
    /// to that church instead (review S2, L3).
    pub fn answer(
        &self,
        decision: Decision,
        question: u64,
    ) -> Result<SwitchAnswer, ConnectionsError> {
        let (asked, new, bound) = {
            let state = self.lock()?;
            let Some(pending) = state.switch.as_ref() else {
                drop(state);
                return self.answered_again(decision, question);
            };
            if pending.question.id != question {
                return Err(ConnectionsError::NoQuestion);
            }
            let session = state
                .session
                .as_ref()
                .filter(|s| !s.finding && !s.signing)
                .ok_or(ConnectionsError::NativeUnavailable)?;
            let bound = session
                .bound
                .clone()
                .ok_or(ConnectionsError::NativeUnavailable)?;
            (pending.question.clone(), pending.new.clone(), bound)
        };
        if bound.1 != asked.from {
            return Err(ConnectionsError::NativeUnavailable);
        }
        match (decision, new) {
            (Decision::Switch, Some(new)) if asked.fresh => self.switch_to(asked, new),
            (Decision::Switch, _) => Err(ConnectionsError::SignInInstead),
            (Decision::Stay, new) => self.stay(asked, new, bound),
            (Decision::SignIn, _) if !asked.fresh => self.sign_in_instead(asked),
            (Decision::SignIn, _) => Err(ConnectionsError::NoQuestion),
        }
    }
    fn answered_again(
        &self,
        decision: Decision,
        question: u64,
    ) -> Result<SwitchAnswer, ConnectionsError> {
        let (auth, bound) = {
            let state = self.lock()?;
            if state.answered != Some((question, decision)) {
                return Err(ConnectionsError::NoQuestion);
            }
            let session = state
                .session
                .as_ref()
                .filter(|s| !s.finding && !s.signing)
                .ok_or(ConnectionsError::NoQuestion)?;
            (
                session.auth.clone(),
                session.bound.clone().ok_or(ConnectionsError::NoQuestion)?,
            )
        };
        Ok(SwitchAnswer {
            status: self.decorate(auth.status_or_busy()?),
            client_id: self.public(&bound.0),
            organization: bound.1,
        })
    }
    /// Installs `kept` as the church in use for answered question `asked`, if that question is
    /// still the open one; returns the session it replaced.
    fn commit(
        &self,
        asked: &Question,
        decision: Decision,
        kept: &Arc<AuthController>,
        bound: (String, String),
    ) -> Result<Option<Session>, ConnectionsError> {
        let mut state = self.lock()?;
        if state.switch.as_ref().map(|p| &p.question) != Some(asked) {
            return Err(ConnectionsError::NoQuestion);
        }
        state.switch = None;
        state.answered = Some((asked.id, decision));
        if let Ok(status) = kept.status_or_busy() {
            state.learn(&status);
        }
        state.used = Some(self.use_of(&bound));
        state.declined = None;
        state.changed();
        Ok(state.session.replace(Session::bound(kept.clone(), bound)))
    }
    fn switch_to(
        &self,
        asked: Question,
        new: Arc<AuthController>,
    ) -> Result<SwitchAnswer, ConnectionsError> {
        // The new church's connection is checked with Planning Center now, before anything is
        // signed out; if that fails, nothing changes and the question stays.
        let unchecked = ConnectionsError::SwitchUnchecked;
        let checked = new.refresh().map_err(unchecked)?;
        if checked.state != ConnectionState::Connected || checked.organization != asked.to {
            return Err(unchecked(AuthError::OrganizationUnverified));
        }
        let (client, organization) = {
            let (client, organization) = new.bound_to();
            (client.to_string(), organization.to_string())
        };
        let old = self.commit(
            &asked,
            Decision::Switch,
            &new,
            (client.clone(), organization.clone()),
        )?;
        // Recorded before anything is signed out: if Ozzie closes partway, the next launch uses
        // this church and reports the others as not signed out yet (review S3, L1).
        self.persist(&asked.others);
        // Reads of the church left behind stop before its sign-in is revoked.
        Self::finish_stop(old.map(|mut old| (old.auth.clone(), old.receiver.take())));
        let leaving: Vec<(String, Option<RecordFingerprint>)> =
            asked.others.iter().map(|o| (o.clone(), None)).collect();
        self.retire_all(&new, &leaving);
        Ok(SwitchAnswer {
            status: self.decorate(new.status_or_busy()?),
            client_id: self.public(&client),
            organization,
        })
    }
    fn stay(
        &self,
        asked: Question,
        new: Option<Arc<AuthController>>,
        bound: (String, String),
    ) -> Result<SwitchAnswer, ConnectionsError> {
        // The church that stays is checked with Planning Center first, as a switch checks the new
        // one: if it no longer works, signing out of the other would leave nothing usable, so
        // nothing changes and the question stays (review S, M2).
        let unchecked = ConnectionsError::KeepUnchecked;
        let kept = Arc::new(
            self.controller(bound.0.clone(), bound.1.clone())
                .map_err(unchecked)?,
        );
        let checked = kept.refresh().map_err(unchecked)?;
        if checked.state != ConnectionState::Connected || checked.organization != asked.from {
            return Err(unchecked(AuthError::OrganizationUnverified));
        }
        let old = self.commit(&asked, Decision::Stay, &kept, bound.clone())?;
        self.persist(std::slice::from_ref(&asked.to));
        Self::finish_stop(old.map(|mut old| (old.auth.clone(), old.receiver.take())));
        if let Some(new) = new {
            new.cancel();
        }
        self.retire_all(&kept, &[(asked.to.clone(), None)]);
        Ok(SwitchAnswer {
            status: self.decorate(kept.status_or_busy()?),
            client_id: self.public(&bound.0),
            organization: bound.1,
        })
    }
    /// "Sign in to X instead": closes a question about a sign-in Ozzie found saved, signing out
    /// of nothing and keeping the church in use. The page then starts an ordinary browser sign-in;
    /// if that binds to X, its save replaces (and revokes) the found sign-in, and a fresh question
    /// asks before Ozzie stops using the church in use. Until then the found sign-in stays saved
    /// and is asked about again at the next check.
    fn sign_in_instead(&self, asked: Question) -> Result<SwitchAnswer, ConnectionsError> {
        let (auth, bound) = {
            let mut state = self.lock()?;
            if state.switch.as_ref().map(|p| &p.question) != Some(&asked) {
                return Err(ConnectionsError::NoQuestion);
            }
            state.switch = None;
            state.answered = Some((asked.id, Decision::SignIn));
            state.changed();
            let session = state
                .session
                .as_ref()
                .ok_or(ConnectionsError::NativeUnavailable)?;
            (
                session.auth.clone(),
                session
                    .bound
                    .clone()
                    .ok_or(ConnectionsError::NativeUnavailable)?,
            )
        };
        Ok(SwitchAnswer {
            status: self.decorate(auth.status_or_busy()?),
            client_id: self.public(&bound.0),
            organization: bound.1,
        })
    }
    /// Signs out of each of `targets` except `keep`'s own (outside the lock), each only while its
    /// slot holds the record given (when one is), and records, per sign-in, what is still saved,
    /// why, and which record it is. A slot that holds another record by now is no longer this
    /// sign-in's and is let go untouched.
    fn retire_all(&self, keep: &AuthController, targets: &[(String, Option<RecordFingerprint>)]) {
        let kept = keep.bound_to().1.to_string();
        let results: Vec<(
            String,
            Option<RecordFingerprint>,
            Result<Retired, NotRetired>,
        )> = targets
            .iter()
            .filter(|(o, _)| *o != kept)
            .map(|(o, record)| {
                (
                    o.clone(),
                    *record,
                    keep.retire_saved(self.prefix, o, *record),
                )
            })
            .collect();
        if let Ok(mut state) = self.lock() {
            state.unretired.retain(|left| {
                !targets.iter().any(|(o, _)| *o == left.organization) && left.organization != kept
            });
            for (organization, record, result) in results {
                if let Err(failed) = result {
                    let name = state.name(&organization);
                    state.unretired.push(LeftBehind {
                        organization,
                        name,
                        reason: RetireFailure::from(&failed.error),
                        ozzie_registration: failed
                            .client
                            .map(|client| self.app_client.as_deref() == Some(client.as_str())),
                        record: failed.record.or(record),
                    });
                }
            }
            state
                .unretired
                .sort_by(|a, b| a.organization.cmp(&b.organization));
            state.changed();
        }
        self.persist(&[]);
    }
    /// The current church's controller, for retrying or removing what was left behind. Refused
    /// while a question is open: an answer may be about one of those very sign-ins, and the
    /// buttons are hidden meanwhile (review S2, M2).
    fn keeper(&self) -> Result<(Arc<AuthController>, Vec<LeftBehind>), ConnectionsError> {
        let state = self.lock()?;
        if state.switch.is_some() {
            return Err(ConnectionsError::SwitchPending);
        }
        if state.unretired.is_empty() {
            return Err(ConnectionsError::NoQuestion);
        }
        let session = state
            .session
            .as_ref()
            .filter(|s| !s.finding && !s.signing)
            .ok_or(ConnectionsError::Authentication(AuthError::Busy))?;
        Ok((session.auth.clone(), state.unretired.clone()))
    }
    /// Tries again to sign out of what the person already chose to leave, each only while its
    /// slot still holds the sign-in that was left behind; nothing else.
    pub fn retry(&self) -> Result<StatusView, ConnectionsError> {
        let (keep, left) = self.keeper()?;
        let targets: Vec<(String, Option<RecordFingerprint>)> = left
            .into_iter()
            .map(|l| (l.organization, l.record))
            .collect();
        self.retire_all(&keep, &targets);
        Ok(self.decorate(keep.status_or_busy()?))
    }
    /// After Planning Center refused to sign Ozzie out of a sign-in the person chose to leave (a
    /// registration it no longer has), removes that sign-in from this Mac without a revoke, on
    /// the person's request: it may stay active at Planning Center until it expires or is
    /// disconnected there. Only refused sign-ins, each only while its slot still holds the very
    /// record that was refused; never the church in use.
    pub fn remove_refused(&self) -> Result<StatusView, ConnectionsError> {
        let (keep, left) = self.keeper()?;
        let kept = keep.bound_to().1.to_string();
        let settled: Vec<String> = left
            .into_iter()
            .filter(|l| l.reason == RetireFailure::Refused && l.organization != kept)
            .filter_map(|l| {
                let record = l.record?;
                remove_saved_record(self.store.as_ref(), self.prefix, &l.organization, record)
                    .ok()
                    .map(|_| l.organization)
            })
            .collect();
        let mut state = self.lock()?;
        state
            .unretired
            .retain(|left| !settled.contains(&left.organization));
        state.changed();
        drop(state);
        self.persist(&[]);
        Ok(self.decorate(keep.status_or_busy()?))
    }
    /// Revokes and deletes the current connection (and, for a one-click sign-in that never
    /// finished, the one it replaced). Waits while a question is open: answering it decides which
    /// church stays.
    pub fn disconnect(&self) -> Result<ConnectionStatus, ConnectionsError> {
        // Checked and stopped in one hold: a sign-in finishing meanwhile can't open a question
        // whose earlier church this would then revoke.
        let (stopped, finding, bound) = {
            let mut state = self.lock()?;
            if state.switch.is_some() {
                return Err(ConnectionsError::SwitchPending);
            }
            let (finding, bound) = state
                .session
                .as_ref()
                .map(|s| (s.finding, s.bound.clone()))
                .ok_or(ConnectionsError::NativeUnavailable)?;
            state.changed();
            (Self::halt(&mut state), finding, bound)
        };
        let auth = stopped
            .as_ref()
            .map(|(auth, _)| auth.clone())
            .ok_or(ConnectionsError::NativeUnavailable)?;
        Self::finish_stop(stopped);
        let revoke = |auth: &AuthController| match auth.disconnect() {
            Err(AuthError::Busy) => Err(ConnectionsError::NotRevoked),
            result => result.map_err(ConnectionsError::from),
        };
        let status = revoke(&auth)?;
        // A one-click sign-in that never finished: also revoke the connection it replaced.
        match (finding, bound) {
            (true, Some((client, organization))) => {
                revoke(&*self.prepare_as(client, organization, true, Purpose::Check, false)?)
            }
            _ => Ok(status),
        }
    }
}
