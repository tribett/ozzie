//! Renewing a saved sign-in before a read. On 0.1.9 and 0.2.0 every Sunday check failed from two
//! hours after Ozzie started, in one round trip: Planning Center's access token had run out, nothing
//! renewed it (only "Check saved connection" did), and the identity check sent it anyway. Fictional
//! tokens and organizations only; the Keychain, Planning Center and the clocks are fakes.
use super::*;
use crate::source::{Collection, SourceError, SourceHttp, SourcePage, SourceRequest, Target};
use crate::sunday_check::{self, Clock};
use std::collections::BTreeMap;
use std::sync::{
    atomic::{AtomicU64, AtomicUsize},
    mpsc,
};
use std::time::Duration;

const HOUR: u64 = 3_600_000;
const MINUTE: u64 = 60_000;
/// Planning Center's access tokens last two hours.
const LIFETIME_S: u64 = 7200;

/// One saved item, with every write kept in order. A read or a write fails while told to, as a
/// locked or refusing Keychain does.
#[derive(Default)]
struct Store {
    bytes: Mutex<Option<Vec<u8>>>,
    puts: Mutex<Vec<String>>,
    /// The next write panics while the controller holds its state, which poisons it.
    panic_put: AtomicBool,
    /// The next write says it started, then waits to be let go, then writes.
    put_gate: Mutex<Option<(mpsc::SyncSender<()>, mpsc::Receiver<()>)>>,
    refuse_get: Mutex<Option<StoreError>>,
    refuse_put: Mutex<Option<StoreError>>,
}
impl Store {
    fn saved(&self) -> Option<String> {
        self.bytes
            .lock()
            .unwrap()
            .as_ref()
            .map(|b| String::from_utf8(b.clone()).unwrap())
    }
    fn puts(&self) -> usize {
        self.puts.lock().unwrap().len()
    }
}
impl CredentialStore for Store {
    fn put(&self, _: &str, _: &str, value: &[u8]) -> Result<(), StoreError> {
        if let Some(error) = *self.refuse_put.lock().unwrap() {
            return Err(error);
        }
        if self.panic_put.swap(false, Ordering::SeqCst) {
            panic!("a fictional Keychain fault");
        }
        let gate = self.put_gate.lock().unwrap().take();
        if let Some((started, release)) = gate {
            started.send(()).unwrap();
            release.recv().unwrap();
        }
        let text = String::from_utf8(value.to_vec()).unwrap();
        self.puts.lock().unwrap().push(text);
        *self.bytes.lock().unwrap() = Some(value.to_vec());
        Ok(())
    }
    fn get(&self, _: &str, _: &str) -> Result<Option<Vec<u8>>, StoreError> {
        if let Some(error) = *self.refuse_get.lock().unwrap() {
            return Err(error);
        }
        Ok(self.bytes.lock().unwrap().clone())
    }
    fn delete(&self, _: &str, _: &str) -> Result<(), StoreError> {
        *self.bytes.lock().unwrap() = None;
        Ok(())
    }
}
fn record(access: &str, refresh: Option<&str>) -> Vec<u8> {
    let refresh = refresh.map_or("null".to_string(), |r| format!("\"{r}\""));
    format!(
        r#"{{"client_id":"fictional-client","organization":"1001","tokens":{{"access_token":"{access}","refresh_token":{refresh},"token_type":"bearer","expires_in":{LIFETIME_S}}}}}"#
    )
    .into_bytes()
}

/// How Planning Center answers a renewal.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Answer {
    Renew,
    /// The refresh token was revoked or ran out: a 400 (`invalid_grant`).
    Refuse,
    /// This Mac is offline.
    Unreachable,
}
/// Planning Center, as far as signing in, renewing and the identity check go. Its own clock decides
/// when an access token has run out (two hours after it was issued), as Planning Center's does:
/// userinfo then refuses it (401). A renewal hands out a new access and refresh token and refuses
/// a refresh token already used.
struct Pco {
    clock: Arc<AtomicU64>,
    organization: Mutex<&'static str>,
    issued: Mutex<BTreeMap<String, u64>>,
    refresh_token: Mutex<String>,
    answer: Mutex<Answer>,
    renewals: AtomicUsize,
    identity: AtomicUsize,
    revoked: Mutex<Vec<String>>,
    /// The next renewal says it started, then waits to be let go.
    gate: Mutex<Option<(mpsc::SyncSender<()>, mpsc::Receiver<()>)>>,
    /// While set, every identity check fails this way, as `PcoProvider` reports it: out of reach
    /// (`TransportFailure`), a 5xx (`ProviderFailure`), a 401 (`AccessDenied`) or a reply it can't
    /// use (`InvalidJson`).
    identity_fails: Mutex<Option<UserInfoReason>>,
    /// The next identity check says it started, then waits to be let go.
    identity_gate: Mutex<Option<(mpsc::SyncSender<()>, mpsc::Receiver<()>)>>,
    /// A renewal answers without a new refresh token (the saved one goes on working).
    keeps_refresh_token: AtomicBool,
    /// A renewal answers with the saved refresh token again.
    hands_back_refresh_token: AtomicBool,
    /// While set, a revoke waits for one message before it is answered (a slow Planning Center).
    revoke_gate: Mutex<Option<mpsc::Receiver<()>>>,
    /// The `scope` a renewal says it granted (none: what was asked for).
    grants_scope: Mutex<Option<&'static str>>,
}
impl Pco {
    fn new(clock: Arc<AtomicU64>) -> Self {
        let pco = Self {
            clock,
            organization: Mutex::new("1001"),
            issued: Mutex::default(),
            refresh_token: Mutex::new("fictional-refresh-0".into()),
            answer: Mutex::new(Answer::Renew),
            renewals: AtomicUsize::new(0),
            identity: AtomicUsize::new(0),
            revoked: Mutex::default(),
            gate: Mutex::new(None),
            identity_fails: Mutex::new(None),
            identity_gate: Mutex::new(None),
            keeps_refresh_token: AtomicBool::new(false),
            hands_back_refresh_token: AtomicBool::new(false),
            revoke_gate: Mutex::new(None),
            grants_scope: Mutex::new(None),
        };
        pco.issue("fictional-access-0");
        pco
    }
    fn issue(&self, access: &str) {
        let now = self.clock.load(Ordering::SeqCst);
        self.issued.lock().unwrap().insert(access.into(), now);
    }
    fn accepts(&self, access: &str) -> bool {
        let now = self.clock.load(Ordering::SeqCst);
        self.issued
            .lock()
            .unwrap()
            .get(access)
            .is_some_and(|at| now < at + LIFETIME_S * 1000)
    }
    fn answer(&self, answer: Answer) {
        *self.answer.lock().unwrap() = answer;
    }
    fn renewals(&self) -> usize {
        self.renewals.load(Ordering::SeqCst)
    }
    fn identity(&self) -> usize {
        self.identity.load(Ordering::SeqCst)
    }
    /// Holds the next renewal: returns when it started, and the way to let it go.
    fn hold(&self) -> (mpsc::Receiver<()>, mpsc::SyncSender<()>) {
        let (started, on_start) = mpsc::sync_channel(1);
        let (release, on_release) = mpsc::sync_channel(1);
        *self.gate.lock().unwrap() = Some((started, on_release));
        (on_start, release)
    }
    /// Holds the next identity check the same way.
    fn hold_identity(&self) -> (mpsc::Receiver<()>, mpsc::SyncSender<()>) {
        let (started, on_start) = mpsc::sync_channel(1);
        let (release, on_release) = mpsc::sync_channel(1);
        *self.identity_gate.lock().unwrap() = Some((started, on_release));
        (on_start, release)
    }
    fn revoked(&self) -> Vec<String> {
        self.revoked.lock().unwrap().clone()
    }
    /// What was revoked once `n` revokes arrived (a dropped credential is signed out on a thread of
    /// its own), sorted; waits up to 5 s.
    fn revoked_soon(&self, n: usize) -> Vec<String> {
        let until = std::time::Instant::now() + Duration::from_secs(5);
        while self.revoked.lock().unwrap().len() < n && std::time::Instant::now() < until {
            std::thread::sleep(Duration::from_millis(5));
        }
        let mut revoked = self.revoked();
        revoked.sort();
        revoked
    }
}
impl Provider for Pco {
    fn exchange(&self, _: &str, _: &str, _: &str) -> Result<Tokens, AuthError> {
        // A sign-in that saved no refresh token.
        self.issue("fictional-access-signed-in");
        Ok(Tokens {
            access_token: "fictional-access-signed-in".into(),
            refresh_token: None,
            token_type: "bearer".into(),
            expires_in: LIFETIME_S,
        })
    }
    fn organization(&self, access: &str) -> Result<String, AuthError> {
        self.organization_detailed(access)
            .map_err(|failure| failure.error)
    }
    fn organization_detailed(&self, access: &str) -> Result<String, OrganizationFailure> {
        self.identity.fetch_add(1, Ordering::SeqCst);
        let gate = self.identity_gate.lock().unwrap().take();
        if let Some((started, release)) = gate {
            started.send(()).unwrap();
            release.recv().unwrap();
        }
        if let Some(reason) = self.identity_fails.lock().unwrap().clone() {
            let error = if reason == UserInfoReason::TransportFailure {
                AuthError::ProviderFailure
            } else {
                AuthError::OrganizationUnverified
            };
            return Err(OrganizationFailure {
                error,
                diagnostic: OrganizationDiagnostic::userinfo(reason),
                asked_to_wait: None,
            });
        }
        if !self.accepts(access) {
            return Err(OrganizationFailure {
                error: AuthError::OrganizationUnverified,
                diagnostic: OrganizationDiagnostic::userinfo(UserInfoReason::AccessDenied),
                asked_to_wait: None,
            });
        }
        Ok((*self.organization.lock().unwrap()).into())
    }
    fn refresh(&self, client: &str, refresh: &str) -> Result<Tokens, AuthError> {
        assert_eq!(client, "fictional-client");
        let gate = self.gate.lock().unwrap().take();
        if let Some((started, release)) = gate {
            started.send(()).unwrap();
            release.recv().unwrap();
        }
        let n = self.renewals.fetch_add(1, Ordering::SeqCst) + 1;
        match *self.answer.lock().unwrap() {
            Answer::Refuse => return Err(AuthError::InvalidToken),
            Answer::Unreachable => return Err(AuthError::ProviderFailure),
            Answer::Renew => {}
        }
        let mut current = self.refresh_token.lock().unwrap();
        if refresh != *current {
            return Err(AuthError::InvalidToken);
        }
        let access = format!("fictional-access-{n}");
        self.issue(&access);
        if self.keeps_refresh_token.load(Ordering::SeqCst) {
            return Ok(Tokens {
                access_token: access,
                refresh_token: None,
                token_type: "bearer".into(),
                expires_in: LIFETIME_S,
            });
        }
        if !self.hands_back_refresh_token.load(Ordering::SeqCst) {
            *current = format!("fictional-refresh-{n}");
        }
        Ok(Tokens {
            access_token: access,
            refresh_token: Some(current.clone()),
            token_type: "bearer".into(),
            expires_in: LIFETIME_S,
        })
    }
    fn refresh_grant(&self, client: &str, refresh: &str) -> Result<Grant, AuthError> {
        let tokens = self.refresh(client, refresh)?;
        let scope = self.grants_scope.lock().unwrap().map(str::to_owned);
        Ok(Grant { tokens, scope })
    }
    fn revoke(&self, _: &str, token: &str, _: &str) -> Result<(), AuthError> {
        let gate = self.revoke_gate.lock().unwrap().take();
        if let Some(release) = gate {
            release.recv().unwrap();
        }
        self.revoked.lock().unwrap().push(token.into());
        Ok(())
    }
}

/// Planning Center's Services pages: an empty page for every read, refused (401) for an access
/// token that ran out, as Planning Center does.
struct Pages {
    pco: Arc<Pco>,
    seen: Mutex<Vec<String>>,
}
impl Pages {
    fn new(pco: &Arc<Pco>) -> Self {
        Self {
            pco: pco.clone(),
            seen: Mutex::default(),
        }
    }
    fn seen(&self) -> Vec<String> {
        self.seen.lock().unwrap().clone()
    }
}
impl SourceHttp for Pages {
    fn read(&self, request: &SourceRequest, access: &str) -> Result<SourcePage, SourceError> {
        self.seen.lock().unwrap().push(access.into());
        if !self.pco.accepts(access) {
            return Err(SourceError::Denied);
        }
        crate::source::project_page(request, br#"{"data":[]}"#, &BTreeMap::new())
    }
}
/// The check's own clock: Planning Center's time from the sign-in on 2026-11-13 at 12:00 UTC, and no
/// budget spent.
struct Ticks(Arc<AtomicU64>);
impl Clock for Ticks {
    fn now_ms(&self) -> u64 {
        1_794_571_200_000 + self.0.load(Ordering::SeqCst)
    }
    fn elapsed_ms(&self) -> u64 {
        0
    }
    fn sleep_ms(&self, _: u64, stop: &dyn Fn() -> bool) -> bool {
        stop()
    }
}

struct Fixture {
    auth: Arc<AuthController>,
    pco: Arc<Pco>,
    store: Arc<Store>,
    /// This Mac's clock, as Ozzie's controller reads it.
    mac: Arc<AtomicU64>,
    /// Planning Center's clock: the same time, unless this Mac slept (Ozzie's clock doesn't count
    /// sleep).
    pco_time: Arc<AtomicU64>,
}
impl Fixture {
    /// Both clocks `ms` after the sign-in was checked.
    fn at(&self, ms: u64) {
        self.mac.store(ms, Ordering::SeqCst);
        self.pco_time.store(ms, Ordering::SeqCst);
    }
    fn check(&self, pages: &Pages) -> Result<sunday_check::SundayCapture, SourceError> {
        sunday_check::run(
            &self.auth,
            "10",
            "20",
            &[],
            &AtomicBool::new(false),
            pages,
            &Ticks(self.pco_time.clone()),
        )
        .map(|(capture, _)| capture)
    }
    fn state(&self) -> ConnectionState {
        self.auth.status().unwrap().state
    }
}
fn fixture(saved: Option<Vec<u8>>) -> Fixture {
    let mac = Arc::new(AtomicU64::new(0));
    let pco_time = Arc::new(AtomicU64::new(0));
    let pco = Arc::new(Pco::new(pco_time.clone()));
    let store = Arc::new(Store::default());
    *store.bytes.lock().unwrap() = saved;
    let now = mac.clone();
    let auth = AuthController::new(
        Binding {
            workspace: "local:1001".into(),
            organization: "1001".into(),
            client_id: "fictional-client".into(),
        },
        store.clone(),
        pco.clone(),
        Arc::new(move || now.load(Ordering::SeqCst)),
    )
    .unwrap();
    Fixture {
        auth: Arc::new(auth),
        pco,
        store,
        mac,
        pco_time,
    }
}
/// Ozzie started at 0 with a sign-in saved on this Mac, and checked it ("Check saved connection" on
/// launch): renewal 1, so the access token in use is `fictional-access-1`.
fn launched() -> Fixture {
    let f = fixture(Some(record(
        "fictional-access-0",
        Some("fictional-refresh-0"),
    )));
    assert_eq!(f.auth.refresh().unwrap().state, ConnectionState::Connected);
    assert_eq!((f.pco.renewals(), f.store.puts()), (1, 1));
    f
}
/// A browser sign-in at 0 whose token response held no refresh token.
fn signed_in_without_a_refresh_token() -> Fixture {
    let f = fixture(None);
    let url = url::Url::parse(&f.auth.begin().unwrap()).unwrap();
    let (_, state) = url.query_pairs().find(|(k, _)| k == "state").unwrap();
    let status = f
        .auth
        .callback(&format!("{REDIRECT_URI}?code=fictional-code&state={state}"))
        .unwrap();
    assert_eq!(status.state, ConnectionState::Connected);
    f
}
fn reads_with(pages: &Pages, access: &str) -> bool {
    let seen = pages.seen();
    !seen.is_empty() && seen.iter().all(|a| a == access)
}

#[test]
fn a_check_two_hours_after_the_sign_in_renews_it_once_then_reads() {
    let f = launched();
    // The owner's record: fine every 30 minutes, then from two hours after the start every check
    // failed in a fraction of a second as `organization-unverified`.
    f.at(2 * HOUR + 30 * MINUTE);
    f.auth.renew_if_due().unwrap();
    let pages = Pages::new(&f.pco);
    let checked = f.check(&pages);
    assert!(checked.is_ok(), "the check failed: {:?}", checked.err());
    assert!(checked.unwrap().reads.iter().any(|r| r.outcome == "ok"));
    assert_eq!(
        f.pco.renewals(),
        2,
        "renewed once, after the launch's check"
    );
    assert!(reads_with(&pages, "fictional-access-2"));
    // The Keychain record is replaced exactly as "Check saved connection" replaces it: the new
    // tokens, nothing else.
    assert_eq!(f.store.puts(), 2);
    assert_eq!(
        f.store.saved().unwrap(),
        String::from_utf8(record("fictional-access-2", Some("fictional-refresh-2"))).unwrap()
    );
    assert_eq!(f.state(), ConnectionState::Connected);
    // Renewed for another two hours: the next check renews nothing.
    assert!(!f.auth.renewal_due());
    assert_eq!(f.auth.renew_if_due(), Ok(false));
    assert_eq!(f.pco.renewals(), 2);
}

#[test]
fn a_check_within_the_sign_ins_life_makes_no_renewal_call() {
    let f = launched();
    for at in [0, 30 * MINUTE, HOUR, HOUR + 49 * MINUTE] {
        f.at(at);
        assert!(!f.auth.renewal_due(), "{at}");
        assert_eq!(f.auth.renew_if_due(), Ok(false), "{at}");
        let pages = Pages::new(&f.pco);
        f.check(&pages).unwrap();
        assert!(reads_with(&pages, "fictional-access-1"), "{at}");
    }
    assert_eq!((f.pco.renewals(), f.store.puts()), (1, 1));
}

#[test]
fn a_sign_in_about_to_run_out_is_renewed_before_the_check_starts() {
    // Ten minutes before it runs out: longer than a whole check (sunday_check::BUDGET_MS).
    const { assert!(RENEW_BEFORE_MS > sunday_check::BUDGET_MS + 3 * sunday_check::MAX_WAIT_MS) };
    let f = launched();
    f.at(2 * HOUR - RENEW_BEFORE_MS);
    assert!(f.auth.renewal_due());
    assert_eq!(f.auth.renew_if_due(), Ok(true));
    let pages = Pages::new(&f.pco);
    f.check(&pages).unwrap();
    assert!(reads_with(&pages, "fictional-access-2"));
    assert_eq!(f.pco.renewals(), 2);
}

#[test]
fn a_refused_renewal_reads_nothing_and_needs_a_new_sign_in() {
    let f = launched();
    f.pco.answer(Answer::Refuse);
    f.at(2 * HOUR + MINUTE);
    let identity = f.pco.identity();
    assert_eq!(f.auth.renew_if_due(), Err(SourceError::InvalidCredentials));
    assert_eq!(f.pco.renewals(), 2, "asked once");
    // Nothing read, not even the identity check; the saved sign-in is left as it was.
    assert_eq!(f.pco.identity(), identity);
    assert_eq!(f.store.puts(), 1);
    // The connection says so, as "Check saved connection" would have.
    let status = f.auth.status().unwrap();
    assert_eq!(status.state, ConnectionState::Failed);
    assert_eq!(status.problem, Some(AuthError::InvalidToken));
    assert!(!f.auth.renewal_due());
}

#[test]
fn a_sign_in_without_a_refresh_token_is_not_renewed_and_reads_nothing() {
    let f = signed_in_without_a_refresh_token();
    let identity = f.pco.identity();
    f.at(2 * HOUR + MINUTE);
    assert!(f.auth.renewal_due());
    assert_eq!(f.auth.renew_if_due(), Err(SourceError::InvalidCredentials));
    assert_eq!(f.pco.renewals(), 0, "nothing to renew with");
    assert_eq!((f.pco.identity(), f.store.puts()), (identity, 1));
    assert_eq!(f.state(), ConnectionState::Failed);
}

#[test]
fn planning_center_out_of_reach_keeps_the_connection_and_the_next_read_tries_again() {
    let f = launched();
    let before = f.auth.status().unwrap();
    f.pco.answer(Answer::Unreachable);
    f.at(2 * HOUR + MINUTE);
    assert_eq!(f.auth.renew_if_due(), Err(SourceError::ProviderFailure));
    // Nothing shows the sign-in itself is bad: the connection is as it was, so automatic checks
    // keep running, and each tries the renewal again.
    let status = f.auth.status().unwrap();
    assert_eq!(status.state, ConnectionState::Connected);
    assert_eq!(status.scopes, before.scopes);
    assert_eq!(status.checked_at_ms, before.checked_at_ms);
    assert_eq!(status.problem, None);
    assert_eq!(f.store.puts(), 1);
    assert!(f.auth.renewal_due());
    f.pco.answer(Answer::Renew);
    assert_eq!(f.auth.renew_if_due(), Ok(true));
    let pages = Pages::new(&f.pco);
    f.check(&pages).unwrap();
    assert!(reads_with(&pages, "fictional-access-3"));
}

#[test]
fn disconnect_during_a_renewal_saves_nothing_and_signs_out() {
    let f = launched();
    f.at(2 * HOUR + MINUTE);
    let (started, release) = f.pco.hold();
    std::thread::scope(|scope| {
        let renewing = scope.spawn(|| f.auth.renew_if_due());
        started.recv_timeout(Duration::from_secs(5)).unwrap();
        let disconnecting = scope.spawn(|| f.auth.disconnect_within(Duration::from_secs(5)));
        // Disconnect stops the renewal first, then waits for it to finish before revoking.
        while !f.auth.is_cancelled() {
            std::thread::sleep(Duration::from_millis(5));
        }
        release.send(()).unwrap();
        assert_eq!(renewing.join().unwrap(), Err(SourceError::Cancelled));
        assert_eq!(
            disconnecting.join().unwrap().unwrap().state,
            ConnectionState::Disconnected
        );
    });
    // The renewed credential was never written, so it is signed out at Planning Center, held
    // nowhere (review M, L3); then the saved one is signed out and removed.
    assert_eq!(f.store.puts(), 1);
    assert_eq!(f.store.saved(), None);
    assert_eq!(
        f.pco.revoked_soon(2),
        ["fictional-refresh-1", "fictional-refresh-2"]
    );
    assert!(!f.auth.renewal_due());
}

#[test]
fn quit_or_a_church_switch_during_a_renewal_saves_nothing_and_signs_the_renewal_out() {
    // Quitting, Cancel and switching churches stop the controller (connections.rs `finish_stop`):
    // a cancel.
    let f = launched();
    let kept = f.store.saved();
    f.at(2 * HOUR + MINUTE);
    let (started, release) = f.pco.hold();
    std::thread::scope(|scope| {
        let renewing = scope.spawn(|| f.auth.renew_if_due());
        started.recv_timeout(Duration::from_secs(5)).unwrap();
        f.auth.cancel();
        release.send(()).unwrap();
        assert_eq!(renewing.join().unwrap(), Err(SourceError::Cancelled));
    });
    assert_eq!((f.store.puts(), f.store.saved()), (1, kept));
    assert_eq!(f.state(), ConnectionState::Cancelled);
    // Planning Center's answer is held nowhere, so it is signed out, best effort (review M, L3).
    assert_eq!(f.pco.revoked_soon(1), ["fictional-refresh-2"]);
    assert_eq!(f.auth.renew_if_due(), Ok(false));
    assert_eq!(f.pco.renewals(), 2);
}

#[test]
fn a_cancel_during_the_identity_check_of_a_renewal_kept_unconfirmed_writes_nothing() {
    // Review M, L9 (mutation M3): the renewed tokens kept when the identity check goes unanswered
    // (`keep_renewed`) are never written after a cancel.
    let f = launched();
    let kept = f.store.saved();
    f.at(2 * HOUR + MINUTE);
    *f.pco.identity_fails.lock().unwrap() = Some(UserInfoReason::TransportFailure);
    let (started, release) = f.pco.hold_identity();
    std::thread::scope(|scope| {
        let renewing = scope.spawn(|| f.auth.renew_if_due());
        started.recv_timeout(Duration::from_secs(5)).unwrap();
        f.auth.cancel();
        release.send(()).unwrap();
        assert_eq!(renewing.join().unwrap(), Err(SourceError::Cancelled));
    });
    assert_eq!((f.store.puts(), f.store.saved()), (1, kept));
    assert_eq!(f.pco.revoked_soon(1), ["fictional-refresh-2"]);
}

#[test]
fn a_cancelled_renewal_never_signs_out_the_sign_in_that_stays_saved() {
    // Planning Center renewed without a new refresh token, or handed the saved one back: the saved
    // one goes on working, so nothing is signed out. Revoking even the new access token alone may
    // revoke the grant it came from (RFC 7009 §2.1), the saved sign-in with it (review N, 2; the
    // second case kills mutation N12).
    for hands_back in [false, true] {
        let f = launched();
        if hands_back {
            f.pco.hands_back_refresh_token.store(true, Ordering::SeqCst);
        } else {
            f.pco.keeps_refresh_token.store(true, Ordering::SeqCst);
        }
        f.at(2 * HOUR + MINUTE);
        let (started, release) = f.pco.hold();
        std::thread::scope(|scope| {
            let renewing = scope.spawn(|| f.auth.renew_if_due());
            started.recv_timeout(Duration::from_secs(5)).unwrap();
            f.auth.cancel();
            release.send(()).unwrap();
            assert_eq!(renewing.join().unwrap(), Err(SourceError::Cancelled));
        });
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(f.pco.revoked(), Vec::<String>::new(), "{hands_back}");
        assert!(f.store.saved().unwrap().contains("fictional-refresh-1"));
    }
}

#[test]
fn a_cancel_during_the_write_of_a_renewal_kept_unconfirmed_keeps_it_and_signs_nothing_out() {
    // Review N, 1 (mutation N2): the cancel lands while `keep_renewed` writes. What it wrote is the
    // only sign-in that works now (the old refresh token is spent), so it stays saved and is never
    // signed out as if it had been dropped.
    let f = launched();
    f.at(2 * HOUR + MINUTE);
    *f.pco.identity_fails.lock().unwrap() = Some(UserInfoReason::TransportFailure);
    let (started, on_start) = mpsc::sync_channel(1);
    let (release, on_release) = mpsc::sync_channel(1);
    *f.store.put_gate.lock().unwrap() = Some((started, on_release));
    std::thread::scope(|scope| {
        let renewing = scope.spawn(|| f.auth.renew_if_due());
        on_start.recv_timeout(Duration::from_secs(5)).unwrap();
        let cancelling = scope.spawn(|| f.auth.cancel());
        while !f.auth.is_cancelled() {
            std::thread::sleep(Duration::from_millis(5));
        }
        release.send(()).unwrap();
        assert_eq!(renewing.join().unwrap(), Err(SourceError::Cancelled));
        cancelling.join().unwrap();
    });
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(f.pco.revoked(), Vec::<String>::new());
    assert_eq!(
        f.store.saved().unwrap(),
        String::from_utf8(record("fictional-access-2", Some("fictional-refresh-2"))).unwrap()
    );
}

#[test]
fn two_reads_at_once_renew_once() {
    let f = launched();
    f.at(2 * HOUR + MINUTE);
    let (started, release) = f.pco.hold();
    std::thread::scope(|scope| {
        let first = scope.spawn(|| f.auth.renew_if_due());
        started.recv_timeout(Duration::from_secs(5)).unwrap();
        let second = scope.spawn(|| f.auth.renew_if_due());
        std::thread::sleep(Duration::from_millis(100));
        assert!(!second.is_finished(), "the second waits for the first");
        release.send(()).unwrap();
        assert_eq!(first.join().unwrap(), Ok(true));
        assert_eq!(second.join().unwrap(), Ok(false));
    });
    assert_eq!((f.pco.renewals(), f.store.puts()), (2, 2));
    let pages = Pages::new(&f.pco);
    f.check(&pages).unwrap();
    assert!(reads_with(&pages, "fictional-access-2"));
}

#[test]
fn an_access_token_planning_center_refused_early_is_renewed_at_the_next_read() {
    // This Mac slept: Planning Center's two hours are over, but Ozzie's clock, which doesn't count
    // sleep, says 30 minutes.
    let f = launched();
    f.mac.store(30 * MINUTE, Ordering::SeqCst);
    f.pco_time.store(3 * HOUR, Ordering::SeqCst);
    assert!(!f.auth.renewal_due());
    let pages = Pages::new(&f.pco);
    assert_eq!(
        f.check(&pages).err(),
        Some(SourceError::OrganizationUnverified)
    );
    assert!(pages.seen().is_empty(), "nothing was read");
    // Planning Center said the token no longer works: the next read renews it first.
    assert!(f.auth.renewal_due());
    assert_eq!(f.auth.renew_if_due(), Ok(true));
    f.check(&pages).unwrap();
    assert!(reads_with(&pages, "fictional-access-2"));
    assert!(!f.auth.renewal_due());

    // The same for a single page read (setup's picker and the To line read through it).
    let f = launched();
    f.pco_time.store(3 * HOUR, Ordering::SeqCst);
    let request = SourceRequest::capture_at(
        f.auth.binding(),
        "10",
        "20",
        Collection::Plan,
        &Target::default(),
        100,
        0,
    )
    .unwrap();
    assert_eq!(
        f.auth
            .read_source_using(&request, &AtomicBool::new(false), &pages)
            .err(),
        Some(SourceError::OrganizationUnverified)
    );
    assert!(f.auth.renewal_due());
}

#[test]
fn another_organization_or_an_unanswered_identity_check_is_not_a_reason_to_renew() {
    let f = launched();
    *f.pco.organization.lock().unwrap() = "2002";
    let pages = Pages::new(&f.pco);
    assert_eq!(
        f.check(&pages).err(),
        Some(SourceError::OrganizationUnverified)
    );
    assert!(!f.auth.renewal_due());
    assert_eq!(f.pco.renewals(), 1);
}

#[test]
fn a_renewal_whose_identity_check_goes_unanswered_keeps_the_renewed_sign_in() {
    // Planning Center rotates refresh tokens: once it renewed, the saved refresh token no longer
    // works. Dropping the renewed tokens because one userinfo read went unanswered would leave an
    // unattended Ozzie needing a new sign-in at the next renewal.
    for reason in [
        UserInfoReason::TransportFailure,
        UserInfoReason::ProviderFailure,
    ] {
        let f = launched();
        let before = f.auth.status().unwrap();
        f.at(2 * HOUR + MINUTE);
        *f.pco.identity_fails.lock().unwrap() = Some(reason.clone());
        assert_eq!(f.auth.renew_if_due(), Ok(true), "{reason:?}");
        // Saved exactly as a checked renewal saves it, and the connection is as it was: its last
        // check time still the last time Planning Center confirmed the church.
        assert_eq!(f.store.puts(), 2);
        assert_eq!(
            f.store.saved().unwrap(),
            String::from_utf8(record("fictional-access-2", Some("fictional-refresh-2"))).unwrap()
        );
        let status = f.auth.status().unwrap();
        assert_eq!(status.state, ConnectionState::Connected);
        assert_eq!(status.checked_at_ms, before.checked_at_ms);
        assert_eq!(status.scopes, before.scopes);
        assert_eq!(
            (status.problem, status.organization_diagnostic),
            (None, None)
        );
        assert!(!f.auth.renewal_due());
        // Nothing is read with it until a read's own identity check confirms the church.
        let pages = Pages::new(&f.pco);
        assert!(f.check(&pages).is_err());
        assert!(pages.seen().is_empty());
        *f.pco.identity_fails.lock().unwrap() = None;
        f.check(&pages).unwrap();
        assert!(reads_with(&pages, "fictional-access-2"));
        // And two hours later it renews again from the kept refresh token.
        f.at(4 * HOUR + 2 * MINUTE);
        assert_eq!(f.auth.renew_if_due(), Ok(true));
        assert_eq!(f.pco.renewals(), 3);
        assert!(f.store.saved().unwrap().contains("fictional-refresh-3"));
    }
}

#[test]
fn a_renewal_naming_another_church_or_refused_at_its_identity_check_saves_nothing() {
    // Planning Center has already spent the old refresh token: only a new sign-in mends it ("Sign
    // in again in Settings", review N, 8).
    let f = launched();
    f.at(2 * HOUR + MINUTE);
    *f.pco.organization.lock().unwrap() = "2002";
    assert_eq!(f.auth.renew_if_due(), Err(SourceError::InvalidCredentials));
    assert_eq!(f.store.puts(), 1);
    let status = f.auth.status().unwrap();
    assert_eq!(status.state, ConnectionState::Failed);
    assert_eq!(
        status.organization_diagnostic,
        Some(OrganizationDiagnostic::mismatch())
    );
    // A reply that refuses the brand-new token, or that can't be read, says nothing about which
    // church it is either: as before, nothing is saved.
    for reason in [UserInfoReason::AccessDenied, UserInfoReason::InvalidJson] {
        let f = launched();
        f.at(2 * HOUR + MINUTE);
        *f.pco.identity_fails.lock().unwrap() = Some(reason.clone());
        assert_eq!(
            f.auth.renew_if_due(),
            Err(SourceError::InvalidCredentials),
            "{reason:?}"
        );
        assert_eq!(f.store.puts(), 1, "{reason:?}");
        assert_eq!(f.state(), ConnectionState::Failed, "{reason:?}");
    }
}

#[test]
fn check_saved_connection_still_saves_nothing_it_could_not_check() {
    // Only a renewal of a connection already confirmed keeps its tokens unconfirmed; a check of a
    // saved sign-in (launch, Settings) reports that it couldn't check, as before.
    let f = launched();
    *f.pco.identity_fails.lock().unwrap() = Some(UserInfoReason::TransportFailure);
    assert_eq!(f.auth.refresh().err(), Some(AuthError::ProviderFailure));
    assert_eq!(f.store.puts(), 1);
    assert_eq!(f.state(), ConnectionState::Failed);
}

#[test]
fn a_locked_keychain_before_planning_center_is_asked_keeps_the_connection_for_the_next_read() {
    // Review M, L4: reading the saved sign-in failed because the Keychain was locked; Planning
    // Center wasn't asked, nothing changed. The connection stays as it was, so automatic checks keep
    // running and retry once the Mac is unlocked.
    {
        let (error, reason) = (StoreError::Locked, SourceError::Locked);
        let f = launched();
        let before = f.auth.status().unwrap();
        f.at(2 * HOUR + MINUTE);
        *f.store.refuse_get.lock().unwrap() = Some(error);
        assert_eq!(f.auth.renew_if_due(), Err(reason));
        assert_eq!(f.pco.renewals(), 1, "Planning Center wasn't asked");
        let status = f.auth.status().unwrap();
        assert_eq!(status.state, ConnectionState::Connected, "{error:?}");
        assert_eq!(status.checked_at_ms, before.checked_at_ms);
        assert_eq!(status.scopes, before.scopes);
        assert_eq!(status.problem, None);
        assert!(f.auth.renewal_due());
        *f.store.refuse_get.lock().unwrap() = None;
        assert_eq!(f.auth.renew_if_due(), Ok(true));
    }
    // Review N, 4: a Keychain that refuses or isn't there doesn't come right by itself. The
    // connection says so (Settings shows why) instead of "Connected" while every check fails; the
    // leader acts.
    for (error, reason) in [
        (StoreError::Denied, SourceError::Denied),
        (StoreError::Unavailable, SourceError::StoreUnavailable),
    ] {
        let f = launched();
        f.at(2 * HOUR + MINUTE);
        *f.store.refuse_get.lock().unwrap() = Some(error);
        assert_eq!(f.auth.renew_if_due(), Err(reason));
        assert_eq!(f.pco.renewals(), 1, "Planning Center wasn't asked");
        let status = f.auth.status().unwrap();
        assert_eq!(status.state, ConnectionState::Failed, "{error:?}");
        assert_eq!(status.problem, Some(AuthError::Store(error)));
    }
    // Once Planning Center renewed it, a write the Keychain refuses leaves no saved sign-in that
    // works (the old refresh token is spent): the connection says so, and only a new sign-in
    // mends it (review N, 8).
    let f = launched();
    f.at(2 * HOUR + MINUTE);
    *f.store.refuse_put.lock().unwrap() = Some(StoreError::Locked);
    assert_eq!(f.auth.renew_if_due(), Err(SourceError::InvalidCredentials));
    assert_eq!(f.pco.renewals(), 2);
    assert_eq!(f.state(), ConnectionState::Failed);
}

#[test]
fn a_renewal_that_cannot_be_kept_for_any_other_reason_needs_a_new_sign_in() {
    // Review M, L5: `provider-failure` ("couldn't be reached … tries again") only when the renewal
    // itself went unanswered. A grant naming a scope set Ozzie never asks for is refused, as at a
    // sign-in; only a new sign-in helps.
    let f = launched();
    f.at(2 * HOUR + MINUTE);
    *f.pco.grants_scope.lock().unwrap() = Some("services registrations_write openid");
    assert_eq!(f.auth.renew_if_due(), Err(SourceError::InvalidCredentials));
    let status = f.auth.status().unwrap();
    assert_eq!(status.state, ConnectionState::Failed);
    assert_eq!(status.problem, Some(AuthError::ScopeMismatch));
    assert_eq!(f.store.puts(), 1);
    // A controller left broken by a fault (its state poisoned): a new sign-in or "Check saved
    // connection" makes a new one; trying this one again won't help.
    let f = launched();
    f.at(2 * HOUR + MINUTE);
    f.store.panic_put.store(true, Ordering::SeqCst);
    let auth = f.auth.clone();
    assert!(
        std::thread::spawn(move || auth.renew_if_due())
            .join()
            .is_err()
    );
    assert_eq!(f.auth.renew_if_due(), Err(SourceError::InvalidCredentials));
}

#[test]
fn a_read_whose_identity_check_planning_center_answers_with_an_error_is_out_of_reach() {
    // Review M, L5: a 5xx, a 429 or no answer at a read's identity check says nothing about which
    // church the sign-in belongs to: Planning Center couldn't be reached, and nothing is read.
    for reason in [
        UserInfoReason::TransportFailure,
        UserInfoReason::ProviderFailure,
    ] {
        let f = launched();
        *f.pco.identity_fails.lock().unwrap() = Some(reason.clone());
        let pages = Pages::new(&f.pco);
        assert_eq!(
            f.check(&pages).err(),
            Some(SourceError::ProviderFailure),
            "{reason:?}"
        );
        assert!(pages.seen().is_empty());
        assert!(!f.auth.renewal_due());
    }
    // A refusal or an answer naming no church is still the church unconfirmed.
    for reason in [
        UserInfoReason::InvalidJson,
        UserInfoReason::OrganizationIdMissing,
    ] {
        let f = launched();
        *f.pco.identity_fails.lock().unwrap() = Some(reason.clone());
        let pages = Pages::new(&f.pco);
        assert_eq!(
            f.check(&pages).err(),
            Some(SourceError::OrganizationUnverified),
            "{reason:?}"
        );
    }
}

#[test]
fn signing_out_a_dropped_renewal_holds_nothing_while_planning_center_answers() {
    // Review N, 3: the revoke goes out on its own; the stopped renewal returns at once, so a sign-in
    // or a check right after Cancel isn't held up for as long as Planning Center takes.
    let f = launched();
    f.at(2 * HOUR + MINUTE);
    let (release_revoke, revoke_waits) = mpsc::sync_channel(1);
    *f.pco.revoke_gate.lock().unwrap() = Some(revoke_waits);
    let (started, release) = f.pco.hold();
    std::thread::scope(|scope| {
        let renewing = scope.spawn(|| f.auth.renew_if_due());
        started.recv_timeout(Duration::from_secs(5)).unwrap();
        f.auth.cancel();
        release.send(()).unwrap();
        let begun = std::time::Instant::now();
        while !renewing.is_finished() && begun.elapsed() < Duration::from_secs(2) {
            std::thread::sleep(Duration::from_millis(5));
        }
        let returned = renewing.is_finished();
        let pending = f.pco.revoked().is_empty();
        release_revoke.send(()).unwrap();
        assert!(
            returned,
            "the stopped renewal waited for Planning Center's revoke"
        );
        assert!(pending, "the revoke was still under way when it returned");
        assert_eq!(renewing.join().unwrap(), Err(SourceError::Cancelled));
    });
    assert_eq!(f.pco.revoked_soon(1), ["fictional-refresh-2"]);
}
