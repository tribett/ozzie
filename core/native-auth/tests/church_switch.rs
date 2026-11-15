//! "Switch Ozzie to this church?": a sign-in bound to another organization changes nothing until
//! the person answers, and the answer signs out of exactly what the question named (independent
//! review R: M1, M2, L1, L2, N1). Fictional organizations, tokens and registrations only; the
//! store and Planning Center are in-memory fakes.
use ozzie_native_auth::connections::*;
use ozzie_native_auth::credentials::{CredentialStore, StoreError};
use ozzie_native_auth::in_use::{UseHistory, UsedChurch};
use ozzie_native_auth::oauth::*;
use std::collections::{BTreeMap, HashSet};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicU64, Ordering},
};
use std::thread;
use std::time::{Duration, Instant};

const APP: &str = "fictional-app-client";
const OWN: &str = "fictional-own-client";

/// Saved items by (workspace, organization), listed by attributes like the Keychain. Reads of an
/// organization named in `refuse` fail with that error, as a dismissed Keychain prompt would.
#[derive(Default)]
struct MemoryStore {
    items: Mutex<BTreeMap<(String, String), Vec<u8>>>,
    refuse: Mutex<Option<(String, StoreError)>>,
    /// put() for this organization takes this long (a slow Keychain write).
    slow_put: Mutex<Option<(String, Duration)>>,
    /// accounts() takes this long (an unlock prompt while listing).
    slow_list: Mutex<Option<Duration>>,
    /// accounts() succeeds but lists nothing (items skipped as needing a prompt).
    list_nothing: AtomicBool,
    /// delete() of this organization fails (Ozzie closing between a sign-out and its removal).
    refuse_delete: Mutex<Option<String>>,
    /// How many times accounts() listed the store.
    listings: AtomicU64,
}
impl MemoryStore {
    fn saved(&self) -> Vec<String> {
        self.items
            .lock()
            .unwrap()
            .keys()
            .map(|(_, o)| o.clone())
            .collect()
    }
    fn raw(&self, organization: &str) -> Option<String> {
        let items = self.items.lock().unwrap();
        let key = (format!("local:{organization}"), organization.to_string());
        items
            .get(&key)
            .map(|b| String::from_utf8(b.clone()).unwrap())
    }
    fn refuse(&self, organization: &str, error: StoreError) {
        *self.refuse.lock().unwrap() = Some((organization.into(), error));
    }
}
impl CredentialStore for MemoryStore {
    fn put(&self, w: &str, o: &str, value: &[u8]) -> Result<(), StoreError> {
        let slow = self.slow_put.lock().unwrap().clone();
        if let Some((slow, delay)) = slow
            && slow == o
        {
            thread::sleep(delay);
        }
        self.items
            .lock()
            .unwrap()
            .insert((w.into(), o.into()), value.to_vec());
        Ok(())
    }
    fn get(&self, w: &str, o: &str) -> Result<Option<Vec<u8>>, StoreError> {
        if let Some((refused, error)) = self.refuse.lock().unwrap().as_ref()
            && refused == o
        {
            return Err(*error);
        }
        Ok(self
            .items
            .lock()
            .unwrap()
            .get(&(w.into(), o.into()))
            .cloned())
    }
    fn delete(&self, w: &str, o: &str) -> Result<(), StoreError> {
        if self.refuse_delete.lock().unwrap().as_deref() == Some(o) {
            return Err(StoreError::Unavailable);
        }
        self.items.lock().unwrap().remove(&(w.into(), o.into()));
        Ok(())
    }
    fn accounts(&self) -> Result<Vec<(String, String)>, StoreError> {
        self.listings.fetch_add(1, Ordering::SeqCst);
        let slow = *self.slow_list.lock().unwrap();
        if let Some(delay) = slow {
            thread::sleep(delay);
        }
        if self.list_nothing.load(Ordering::SeqCst) {
            return Ok(Vec::new());
        }
        Ok(self.items.lock().unwrap().keys().cloned().collect())
    }
}
/// A store that can't list (the trait's default): only slots Ozzie already knows are found.
struct Unlisted(Arc<MemoryStore>);
impl CredentialStore for Unlisted {
    fn put(&self, w: &str, o: &str, v: &[u8]) -> Result<(), StoreError> {
        self.0.put(w, o, v)
    }
    fn get(&self, w: &str, o: &str) -> Result<Option<Vec<u8>>, StoreError> {
        self.0.get(w, o)
    }
    fn delete(&self, w: &str, o: &str) -> Result<(), StoreError> {
        self.0.delete(w, o)
    }
}

/// Planning Center for several fictional churches. A sign-in binds to `next`; every token names
/// its organization and a serial number (`fictional-access-1001-0`), so userinfo and refresh know
/// which church a token belongs to. Revocations are recorded as `client/token`.
#[derive(Default)]
struct Churches {
    next: Mutex<String>,
    minted: AtomicU64,
    revoked: Mutex<Vec<String>>,
    revoke_fails: AtomicBool,
    refresh_fails: AtomicBool,
    /// Refresh hands back the same credential instead of a new one.
    same_on_refresh: AtomicBool,
    /// Churches whose tokens Planning Center no longer accepts (revoked there, or expired).
    dead: Mutex<HashSet<String>>,
    /// Churches whose sign-out Planning Center refuses outright (a registration it no longer has).
    revoke_refused: Mutex<HashSet<String>>,
    revoke_delay: Mutex<Duration>,
}
fn org_of(token: &str) -> String {
    token.split('-').nth(2).unwrap_or_default().to_string()
}
impl Churches {
    fn signs_in_to(&self, organization: &str) {
        *self.next.lock().unwrap() = organization.into();
    }
    fn tokens(&self, organization: &str, n: u64) -> Tokens {
        Tokens {
            access_token: format!("fictional-access-{organization}-{n}"),
            refresh_token: Some(format!("fictional-refresh-{organization}-{n}")),
            token_type: "bearer".into(),
            expires_in: 7200,
        }
    }
    fn revoked(&self) -> Vec<String> {
        self.revoked.lock().unwrap().clone()
    }
}
impl Provider for Churches {
    fn exchange(&self, _: &str, _: &str, _: &str) -> Result<Tokens, AuthError> {
        let organization = self.next.lock().unwrap().clone();
        Ok(self.tokens(&organization, self.minted.fetch_add(1, Ordering::SeqCst)))
    }
    fn organization(&self, access: &str) -> Result<String, AuthError> {
        if self.dead.lock().unwrap().contains(&org_of(access)) {
            return Err(AuthError::InvalidToken);
        }
        Ok(org_of(access))
    }
    /// Userinfo names two of the fictional churches; 3003 and others have no stated name.
    fn organization_named(&self, access: &str) -> Result<NamedOrganization, OrganizationFailure> {
        let id = self
            .organization(access)
            .map_err(|error| OrganizationFailure {
                error,
                diagnostic: OrganizationDiagnostic::userinfo(UserInfoReason::Unclassified),
            })?;
        let name = match id.as_str() {
            "1001" => Some("Fictional Grace Church".to_string()),
            "2002" => Some("Fictional Hope Chapel".to_string()),
            _ => None,
        };
        Ok(NamedOrganization { id, name })
    }
    fn refresh(&self, _: &str, refresh: &str) -> Result<Tokens, AuthError> {
        if self.refresh_fails.load(Ordering::SeqCst) {
            return Err(AuthError::ProviderFailure);
        }
        if self.dead.lock().unwrap().contains(&org_of(refresh)) {
            return Err(AuthError::InvalidToken);
        }
        let mut parts = refresh.split('-').skip(2);
        let organization = parts.next().unwrap_or_default().to_string();
        let n = if self.same_on_refresh.load(Ordering::SeqCst) {
            parts.next().unwrap_or_default().parse().unwrap()
        } else {
            self.minted.fetch_add(1, Ordering::SeqCst)
        };
        Ok(self.tokens(&organization, n))
    }
    fn revoke(&self, client: &str, token: &str, _: &str) -> Result<(), AuthError> {
        let delay = *self.revoke_delay.lock().unwrap();
        thread::sleep(delay);
        self.revoked
            .lock()
            .unwrap()
            .push(format!("{client}/{token}"));
        if self.revoke_fails.load(Ordering::SeqCst) {
            return Err(AuthError::ProviderFailure);
        }
        if self.revoke_refused.lock().unwrap().contains(&org_of(token)) {
            return Err(AuthError::RevokeRefused);
        }
        Ok(())
    }
}

fn connections(store: Arc<dyn CredentialStore>, pco: &Arc<Churches>) -> Arc<Connections> {
    let provider = pco.clone();
    Arc::new(Connections::new(
        "local:",
        Some(APP.into()),
        store,
        Box::new(move || Ok(provider.clone() as Arc<dyn Provider>)),
        Box::new(|| Ok(Arc::new(|| 1_000u64) as Clock)),
    ))
}
/// The same, on a clock the test moves.
fn connections_at(
    store: Arc<dyn CredentialStore>,
    pco: &Arc<Churches>,
    clock: Arc<AtomicU64>,
) -> Arc<Connections> {
    let provider = pco.clone();
    Arc::new(Connections::new(
        "local:",
        Some(APP.into()),
        store,
        Box::new(move || Ok(provider.clone() as Arc<dyn Provider>)),
        Box::new(move || {
            let clock = clock.clone();
            Ok(Arc::new(move || clock.load(Ordering::SeqCst)) as Clock)
        }),
    ))
}
/// Planning Center's consent page answered Allow: the callback the browser would bring back.
fn allow(auth: &AuthController) -> ConnectionStatus {
    let url = url::Url::parse(&auth.begin().unwrap()).unwrap();
    let state = url.query_pairs().find(|(k, _)| k == "state").unwrap().1;
    auth.callback(&format!("{REDIRECT_URI}?code=fictional-code&state={state}"))
        .unwrap()
}
/// One click, as far as Planning Center's answer; the app has not looked yet (`settle`).
fn one_click(c: &Connections, pco: &Churches, organization: &str) -> Arc<AuthController> {
    pco.signs_in_to(organization);
    let finder = c.prepare_finder().unwrap();
    allow(&finder);
    finder
}
fn pasted(c: &Connections, pco: &Churches, client: &str, organization: &str) {
    pco.signs_in_to(organization);
    allow(
        &c.prepare(client.into(), organization.into(), true, Purpose::SignIn)
            .unwrap(),
    );
}
/// "Check saved connection", or the check on every launch.
fn check(c: &Connections, client: &str, organization: &str) -> Arc<AuthController> {
    let auth = c
        .prepare(client.into(), organization.into(), true, Purpose::Check)
        .unwrap();
    assert_eq!(auth.refresh().unwrap().state, ConnectionState::Connected);
    c.after_check(&auth);
    auth
}
fn view(c: &Connections) -> StatusView {
    c.view().unwrap().unwrap()
}
fn current(c: &Connections) -> String {
    c.current().unwrap().bound_to().1.to_string()
}
/// Ozzie connected to 1001 with one click.
fn on_1001() -> (Arc<MemoryStore>, Arc<Churches>, Arc<Connections>) {
    let store = Arc::new(MemoryStore::default());
    let pco = Arc::new(Churches::default());
    let c = connections(store.clone(), &pco);
    one_click(&c, &pco, "1001");
    c.settle().unwrap();
    assert_eq!(view(&c).status.state, ConnectionState::Connected);
    assert!(view(&c).switch.is_none());
    (store, pco, c)
}
/// Connected to 1001, then a one-click sign-in Planning Center bound to 2002.
fn asked() -> (Arc<MemoryStore>, Arc<Churches>, Arc<Connections>) {
    let (store, pco, c) = on_1001();
    one_click(&c, &pco, "2002");
    c.settle().unwrap();
    (store, pco, c)
}
/// What a question asks, without its native id and the churches' names.
type Shape = (String, String, String, Vec<String>, bool);
fn question(to: &str, from: &str, others: &[&str], fresh: bool) -> Shape {
    (
        to.into(),
        from.into(),
        String::new(),
        others.iter().map(|o| o.to_string()).collect(),
        fresh,
    )
}
fn shape(question: &Option<Question>) -> Option<Shape> {
    question.as_ref().map(|q| {
        (
            q.to.clone(),
            q.from.clone(),
            q.from_client.clone(),
            q.others.clone(),
            q.fresh,
        )
    })
}
/// The person's answer to the question on screen.
fn answer(c: &Connections, decision: Decision) -> Result<SwitchAnswer, ConnectionsError> {
    let id = c.view().unwrap().unwrap().switch.map_or(0, |q| q.id);
    c.answer(decision, id)
}
/// What was left behind, per sign-in.
fn left(unretired: Option<Unretired>) -> Vec<(String, RetireFailure)> {
    unretired.map_or_else(Vec::new, |u| {
        u.left
            .into_iter()
            .map(|l| (l.organization, l.reason))
            .collect()
    })
}
#[test]
fn a_sign_in_to_another_church_changes_nothing_until_the_person_answers() {
    let (store, pco, c) = asked();
    let shown = view(&c);
    assert_eq!(
        shape(&shown.switch),
        Some(question("2002", "1001", &["1001"], true))
    );
    // Nothing was revoked or deleted, and the earlier church is still the current one: it needs
    // its usual check before anything reads, and the new church's connection isn't used at all.
    assert!(pco.revoked().is_empty());
    assert_eq!(store.saved(), ["1001", "2002"]);
    assert_eq!(current(&c), "1001");
    assert_eq!(shown.status.organization, "1001");
    assert_eq!(shown.status.state, ConnectionState::StoredUnchecked);
    assert_eq!(
        c.settle()
            .unwrap()
            .map(|(a, f)| (a.bound_to().1.to_string(), f)),
        Some(("1001".into(), false))
    );
    // The earlier church can be checked and read meanwhile; the question stays as it was.
    check(&c, "", "1001");
    assert_eq!(view(&c).status.state, ConnectionState::Connected);
    assert_eq!(view(&c).switch, shown.switch);
    // Signing in, disconnecting and checking the other church wait for the answer.
    for refused in [
        c.prepare("".into(), "2002".into(), true, Purpose::Check)
            .err(),
        c.prepare("".into(), "2002".into(), true, Purpose::SignIn)
            .err(),
        c.prepare("".into(), "1001".into(), true, Purpose::SignIn)
            .err(),
        c.prepare_finder().err(),
        c.disconnect().err(),
    ] {
        assert_eq!(refused, Some(ConnectionsError::SwitchPending));
    }
    assert!(pco.revoked().is_empty());
    assert_eq!(store.saved(), ["1001", "2002"]);
    let json = serde_json::to_string(&view(&c)).unwrap();
    let id = view(&c).switch.unwrap().id;
    assert!(json.contains(&format!(
        r#""switch":{{"id":{id},"to":"2002","to_name":"Fictional Hope Chapel","from":"1001","from_name":"Fictional Grace Church","from_client":"","others":["1001"],"fresh":true}}"#
    )));
    assert!(json.contains(
        r#""in_use":{"organization":"1001","client_id":"","name":"Fictional Grace Church"}"#
    ));
    assert!(!json.contains("fictional-access") && !json.contains("fictional-refresh"));
}

#[test]
fn switching_checks_the_new_church_then_signs_out_of_the_old_one() {
    let (store, pco, c) = asked();
    let answered = answer(&c, Decision::Switch).unwrap();
    assert_eq!(
        (answered.client_id.as_str(), answered.organization.as_str()),
        ("", "2002")
    );
    assert_eq!(answered.status.status.state, ConnectionState::Connected);
    assert_eq!(answered.status.status.organization, "2002");
    assert!(answered.status.switch.is_none() && answered.status.unretired.is_none());
    assert_eq!(current(&c), "2002");
    // Revoked at Planning Center as the registration it was issued to, then deleted.
    assert_eq!(pco.revoked(), [format!("{APP}/fictional-refresh-1001-0")]);
    assert_eq!(store.saved(), ["2002"]);
    assert_eq!(view(&c).status.organization, "2002");
    assert_eq!(
        answer(&c, Decision::Switch).err(),
        Some(ConnectionsError::NoQuestion)
    );
}

#[test]
fn staying_signs_out_of_the_new_sign_in_and_keeps_the_old_church() {
    let (store, pco, c) = asked();
    let answered = answer(&c, Decision::Stay).unwrap();
    assert_eq!(
        (answered.client_id.as_str(), answered.organization.as_str()),
        ("", "1001")
    );
    assert_eq!(pco.revoked(), [format!("{APP}/fictional-refresh-2002-1")]);
    assert_eq!(store.saved(), ["1001"]);
    // Kept as Keep's check refreshed it (serial 2).
    assert!(
        store
            .raw("1001")
            .unwrap()
            .contains("fictional-access-1001-2")
    );
    assert_eq!(current(&c), "1001");
    assert!(view(&c).switch.is_none() && view(&c).unretired.is_none());
    // Back to normal: the earlier church checks out and a new sign-in can start.
    check(&c, "", "1001");
    assert!(view(&c).switch.is_none());
    assert!(c.prepare_finder().is_ok());
}

#[test]
fn a_sign_in_cancelled_after_it_saved_signs_nothing_out_and_is_asked_about_later() {
    // Review R, M1: Cancel or Quit lands after the save but before the app took the sign-in over.
    let (store, pco, c) = on_1001();
    let finder = one_click(&c, &pco, "2002");
    c.stop_current();
    // Ozzie goes back to 1001, in use as before the sign-in (review S3, L2); 2002's sign-in is
    // never taken over.
    let (back, finding) = c.settle().unwrap().unwrap();
    assert!(!finding && finder.adopt_found().is_err());
    assert_eq!(back.bound_to().1, "1001");
    assert_eq!(
        view(&c).in_use.map(|u| u.organization),
        Some("1001".to_string())
    );
    assert!(view(&c).switch.is_none());
    assert!(pco.revoked().is_empty());
    assert_eq!(store.saved(), ["1001", "2002"]);
    // The sign-in it left isn't lost: the next check of the saved church lists and asks about it.
    check(&c, "", "1001");
    assert_eq!(
        shape(&view(&c).switch),
        Some(question("2002", "1001", &["1001"], false))
    );
    assert!(pco.revoked().is_empty());
    answer(&c, Decision::Stay).unwrap();
    assert_eq!(pco.revoked(), [format!("{APP}/fictional-refresh-2002-1")]);
    assert_eq!(store.saved(), ["1001"]);
}

#[test]
fn a_refused_hand_over_signs_nothing_out() {
    // Review R, M1: the hand-over is refused (here the saved record changed underneath it).
    let (store, pco, c) = on_1001();
    one_click(&c, &pco, "2002");
    store
        .put(
            "local:2002",
            "2002",
            br#"{"client_id":"someone-else","organization":"2002","tokens":{"access_token":"x","refresh_token":"y","token_type":"bearer","expires_in":7200}}"#,
        )
        .unwrap();
    assert!(c.settle().is_err());
    let shown = view(&c);
    assert!(shown.switch.is_none());
    assert_eq!(shown.status.organization, "2002", "the finder's own status");
    assert!(pco.revoked().is_empty());
    assert!(
        store
            .raw("1001")
            .unwrap()
            .contains("fictional-access-1001-0")
    );
}

#[test]
fn a_failed_revoke_keeps_the_old_sign_in_until_a_retry_works() {
    // Review R, L1: offline right after the answered. The item stays, nothing is lost, and Ozzie says so.
    let (store, pco, c) = asked();
    pco.revoke_fails.store(true, Ordering::SeqCst);
    let answered = answer(&c, Decision::Switch).unwrap();
    assert_eq!(answered.organization, "2002");
    let unretired = vec![("1001".to_string(), RetireFailure::RevokeFailed)];
    assert_eq!(left(answered.status.unretired), unretired);
    assert_eq!(store.saved(), ["1001", "2002"]);
    assert_eq!(pco.revoked(), [format!("{APP}/fictional-refresh-1001-0")]);
    // Already decided: a check of the church now in use doesn't ask about it again.
    check(&c, "", "2002");
    assert!(view(&c).switch.is_none());
    assert_eq!(left(view(&c).unretired), unretired);
    assert_eq!(left(c.retry().unwrap().unretired), unretired);
    pco.revoke_fails.store(false, Ordering::SeqCst);
    let after = c.retry().unwrap();
    assert!(after.unretired.is_none());
    assert_eq!(store.saved(), ["2002"]);
    assert_eq!(pco.revoked().len(), 3);
    assert_eq!(c.retry().err(), Some(ConnectionsError::NoQuestion));
}

#[test]
fn a_sign_in_left_after_a_failed_sign_out_is_asked_about_after_a_restart() {
    // Without the app's record of the church in use (an install that has none yet), what couldn't
    // be signed out is remembered only while Ozzie runs. After a restart the leftover isn't lost or
    // signed out on its own: the check on launch lists and asks about it. With the record, it is
    // reported as not signed out yet instead (s3_p18 below).
    let (store, pco, c) = asked();
    pco.revoke_fails.store(true, Ordering::SeqCst);
    answer(&c, Decision::Switch).unwrap();
    c.stop_current();
    drop(c);
    pco.revoke_fails.store(false, Ordering::SeqCst);
    let c = connections(store.clone(), &pco);
    check(&c, "", "2002");
    assert_eq!(
        shape(&view(&c).switch),
        Some(question("1001", "2002", &["2002"], false))
    );
    assert!(view(&c).unretired.is_none());
    assert_eq!(store.saved(), ["1001", "2002"]);
    answer(&c, Decision::Stay).unwrap();
    assert_eq!(store.saved(), ["2002"]);
}

#[test]
fn a_keychain_read_that_is_refused_keeps_the_sign_in_and_revokes_nothing() {
    // Review R, L1: a dismissed access prompt is never treated as "nothing to revoke".
    let (store, pco, c) = asked();
    store.refuse("1001", StoreError::Denied);
    let answered = answer(&c, Decision::Switch).unwrap();
    assert_eq!(
        left(answered.status.unretired),
        [("1001".to_string(), RetireFailure::Denied)]
    );
    assert!(pco.revoked().is_empty());
    assert_eq!(store.saved(), ["1001", "2002"]);
    *store.refuse.lock().unwrap() = None;
    assert!(c.retry().unwrap().unretired.is_none());
    assert_eq!(store.saved(), ["2002"]);

    // Keeping a church that can't be read: it can't be checked, so nothing changes and the
    // question stays (review S, M2).
    let (store, pco, c) = asked();
    store.refuse("1001", StoreError::Locked);
    assert_eq!(
        answer(&c, Decision::Stay).err(),
        Some(ConnectionsError::KeepUnchecked(AuthError::Store(
            StoreError::Locked
        )))
    );
    assert!(view(&c).switch.is_some());
    assert!(pco.revoked().is_empty());
    assert_eq!(store.saved(), ["1001", "2002"]);
}

#[test]
fn the_credential_just_saved_is_never_revoked() {
    // Review R, N1: the slot being left holds the very credential Ozzie keeps.
    let (store, pco, c) = asked();
    pco.same_on_refresh.store(true, Ordering::SeqCst);
    let kept = store.raw("2002").unwrap();
    store.put("local:1001", "1001", kept.as_bytes()).unwrap();
    answer(&c, Decision::Switch).unwrap();
    assert!(pco.revoked().is_empty());
    assert_eq!(store.saved(), ["2002"]);
    assert!(
        store
            .raw("2002")
            .unwrap()
            .contains("fictional-access-2002-1")
    );

    let (store, pco, c) = asked();
    pco.same_on_refresh.store(true, Ordering::SeqCst);
    let kept = store.raw("1001").unwrap();
    store.put("local:2002", "2002", kept.as_bytes()).unwrap();
    answer(&c, Decision::Stay).unwrap();
    assert!(pco.revoked().is_empty());
    assert_eq!(store.saved(), ["1001"]);
}

#[test]
fn the_page_cannot_choose_what_is_signed_out() {
    // Review R, L2: an answer carries only the decision (`Decision` has no organization in it);
    // what is signed out is the list the question showed, taken natively.
    let (store, pco, c) = asked();
    store
        .put("local:3003", "3003", store.raw("1001").unwrap().as_bytes())
        .unwrap();
    answer(&c, Decision::Switch).unwrap();
    assert_eq!(pco.revoked(), [format!("{APP}/fictional-refresh-1001-0")]);
    assert_eq!(store.saved(), ["2002", "3003"]);
    // A sign-in that appeared after the question was shown isn't signed out; it's asked about.
    check(&c, "", "2002");
    assert_eq!(
        shape(&view(&c).switch),
        Some(question("3003", "2002", &["2002"], false))
    );

    // A page that checks an organization other than the church in use (here one with nothing
    // saved) can't make it current, or the church a switch signs out of: the check is refused and
    // the page's check checks the church in use instead (review S3, M1). A sign-in to 2002 then
    // asks before Ozzie stops using 1001, rather than asking about 1001 as a sign-in it found.
    let (store, pco, c) = on_1001();
    assert_eq!(
        c.prepare("".into(), "4004".into(), true, Purpose::Check)
            .err(),
        Some(ConnectionsError::SignInInstead)
    );
    let checked = c.prepare_check("".into(), "4004".into(), true).unwrap();
    assert_eq!(checked.bound_to().1, "1001");
    assert_eq!(view(&c).declined.as_deref(), Some("4004"));
    one_click(&c, &pco, "2002");
    c.settle().unwrap();
    assert_eq!(current(&c), "1001");
    assert_eq!(
        shape(&view(&c).switch),
        Some(question("2002", "1001", &["1001"], true))
    );
    assert!(view(&c).declined.is_none());
    assert!(pco.revoked().is_empty());
    assert_eq!(store.saved(), ["1001", "2002"]);
}

#[test]
fn an_open_question_is_asked_again_after_ozzie_quits() {
    let (store, pco, c) = asked();
    // Quit: the app stops its connection; nothing is signed out.
    c.stop_current();
    drop(c);
    assert!(pco.revoked().is_empty());
    assert_eq!(store.saved(), ["1001", "2002"]);
    // Next launch: the church in Settings (still 1001) is checked, and the question comes back.
    let c = connections(store.clone(), &pco);
    assert!(c.view().unwrap().is_none());
    check(&c, "", "1001");
    assert_eq!(
        shape(&view(&c).switch),
        Some(question("2002", "1001", &["1001"], false))
    );
    assert_eq!(current(&c), "1001");
    // A sign-in found saved is never switched to as it is (review S2, L3): the person signs in
    // to that church again instead, and nothing is signed out meanwhile.
    assert_eq!(
        answer(&c, Decision::Switch).err(),
        Some(ConnectionsError::SignInInstead)
    );
    let closed = answer(&c, Decision::SignIn).unwrap();
    assert_eq!(closed.organization, "1001");
    assert!(view(&c).switch.is_none());
    assert!(pco.revoked().is_empty());
    assert_eq!(store.saved(), ["1001", "2002"]);
    // That browser sign-in replaces (and revokes) the found 2002 sign-in, then asks as usual.
    one_click(&c, &pco, "2002");
    c.settle().unwrap();
    assert_eq!(pco.revoked(), [format!("{APP}/fictional-refresh-2002-1")]);
    assert_eq!(
        shape(&view(&c).switch),
        Some(question("2002", "1001", &["1001"], true))
    );
    let answered = answer(&c, Decision::Switch).unwrap();
    assert_eq!(
        (answered.client_id.as_str(), answered.organization.as_str()),
        ("", "2002")
    );
    assert_eq!(answered.status.status.state, ConnectionState::Connected);
    // 1001's credential as the launch check refreshed it (serial 2, after 2002's serial 1).
    assert!(
        pco.revoked()
            .contains(&format!("{APP}/fictional-refresh-1001-2"))
    );
    assert_eq!(store.saved(), ["2002"]);
}

#[test]
fn a_new_church_that_cannot_be_checked_changes_nothing() {
    let (store, pco, c) = asked();
    pco.refresh_fails.store(true, Ordering::SeqCst);
    assert_eq!(
        answer(&c, Decision::Switch).err(),
        Some(ConnectionsError::SwitchUnchecked(
            AuthError::ProviderFailure
        ))
    );
    assert_eq!(
        shape(&view(&c).switch),
        Some(question("2002", "1001", &["1001"], true))
    );
    assert_eq!(current(&c), "1001");
    assert!(pco.revoked().is_empty());
    assert_eq!(store.saved(), ["1001", "2002"]);
    pco.refresh_fails.store(false, Ordering::SeqCst);
    assert_eq!(answer(&c, Decision::Switch).unwrap().organization, "2002");
}

#[test]
fn the_same_church_signing_in_again_is_never_asked() {
    // As before this change: the saved connection is replaced and the one it replaced revoked.
    let (store, pco, c) = on_1001();
    one_click(&c, &pco, "1001");
    c.settle().unwrap();
    assert!(view(&c).switch.is_none());
    assert!(view(&c).status.found);
    assert_eq!(pco.revoked(), [format!("{APP}/fictional-refresh-1001-0")]);
    assert_eq!(store.saved(), ["1001"]);
    // Not even with another church's sign-in left on this Mac: that waits for the next check.
    store
        .put("local:3003", "3003", store.raw("1001").unwrap().as_bytes())
        .unwrap();
    one_click(&c, &pco, "1001");
    c.settle().unwrap();
    assert!(view(&c).switch.is_none());
    pasted(&c, &pco, OWN, "1001");
    c.settle().unwrap();
    assert!(view(&c).switch.is_none());
    assert_eq!(store.saved(), ["1001", "3003"]);
}

#[test]
fn pasted_ids_for_another_church_are_asked_about_too() {
    let (store, pco, c) = on_1001();
    pasted(&c, &pco, OWN, "2002");
    c.settle().unwrap();
    assert_eq!(
        shape(&view(&c).switch),
        Some(question("2002", "1001", &["1001"], true))
    );
    assert_eq!(current(&c), "1001");
    let answered = answer(&c, Decision::Switch).unwrap();
    assert_eq!(
        (answered.client_id.as_str(), answered.organization.as_str()),
        (OWN, "2002")
    );
    assert_eq!(pco.revoked(), [format!("{APP}/fictional-refresh-1001-0")]);
    assert_eq!(store.saved(), ["2002"]);

    // Staying revokes the new sign-in as the registration typed under Advanced.
    let (store, pco, c) = on_1001();
    pasted(&c, &pco, OWN, "2002");
    c.settle().unwrap();
    let answered = answer(&c, Decision::Stay).unwrap();
    assert_eq!(
        (answered.client_id.as_str(), answered.organization.as_str()),
        ("", "1001")
    );
    assert_eq!(pco.revoked(), [format!("{OWN}/fictional-refresh-2002-1")]);
    assert_eq!(store.saved(), ["1001"]);

    // A church in use under its own registration keeps it in the question, for the page's settings.
    let store = Arc::new(MemoryStore::default());
    let pco = Arc::new(Churches::default());
    let c = connections(store.clone(), &pco);
    pasted(&c, &pco, OWN, "1001");
    c.settle().unwrap();
    one_click(&c, &pco, "2002");
    c.settle().unwrap();
    assert_eq!(
        view(&c).switch.map(|q| q.from_client),
        Some(OWN.to_string())
    );
}

#[test]
fn sign_ins_left_from_before_are_asked_about_when_no_church_was_in_use() {
    let (store, pco, c) = on_1001();
    drop(c);
    let c = connections(store.clone(), &pco);
    one_click(&c, &pco, "2002");
    c.settle().unwrap();
    assert_eq!(current(&c), "2002");
    assert_eq!(view(&c).status.state, ConnectionState::Connected);
    assert_eq!(
        shape(&view(&c).switch),
        Some(question("1001", "2002", &["2002"], false))
    );
    assert!(pco.revoked().is_empty());
    // Keeping 2002 signs out of the one left from before.
    let answered = answer(&c, Decision::Stay).unwrap();
    assert_eq!(answered.organization, "2002");
    assert_eq!(pco.revoked(), [format!("{APP}/fictional-refresh-1001-0")]);
    assert_eq!(store.saved(), ["2002"]);
}

#[test]
fn switching_signs_out_of_every_other_saved_sign_in_it_named() {
    let (store, pco, c) = on_1001();
    store
        .put("local:3003", "3003", br#"{"client_id":"fictional-app-client","organization":"3003","tokens":{"access_token":"fictional-access-3003-9","refresh_token":"fictional-refresh-3003-9","token_type":"bearer","expires_in":7200}}"#)
        .unwrap();
    one_click(&c, &pco, "2002");
    c.settle().unwrap();
    assert_eq!(
        shape(&view(&c).switch),
        Some(question("2002", "1001", &["1001", "3003"], true))
    );
    answer(&c, Decision::Switch).unwrap();
    assert_eq!(
        pco.revoked(),
        [
            format!("{APP}/fictional-refresh-1001-0"),
            format!("{APP}/fictional-refresh-3003-9")
        ]
    );
    assert_eq!(store.saved(), ["2002"]);
}

#[test]
fn a_store_that_cannot_list_still_asks_about_the_church_it_replaced() {
    let store = Arc::new(MemoryStore::default());
    let pco = Arc::new(Churches::default());
    let c = connections(Arc::new(Unlisted(store.clone())), &pco);
    one_click(&c, &pco, "1001");
    c.settle().unwrap();
    one_click(&c, &pco, "2002");
    c.settle().unwrap();
    assert_eq!(
        shape(&view(&c).switch),
        Some(question("2002", "1001", &["1001"], true))
    );
    answer(&c, Decision::Switch).unwrap();
    assert_eq!(store.saved(), ["2002"]);
}

#[test]
fn signing_in_again_under_another_registration_revokes_the_one_it_replaces() {
    // Review R, L2c: the same church, saved with Ozzie's own registration, signed in again with
    // IDs typed under Advanced. The replaced credential is revoked as the registration it was
    // issued to instead of being overwritten unrevoked.
    let (store, pco, c) = on_1001();
    pasted(&c, &pco, OWN, "1001");
    c.settle().unwrap();
    assert_eq!(pco.revoked(), [format!("{APP}/fictional-refresh-1001-0")]);
    assert!(store.raw("1001").unwrap().contains(OWN));
}

#[test]
fn disconnecting_works_as_before_when_nothing_is_asked() {
    let (store, pco, c) = on_1001();
    assert_eq!(c.disconnect().unwrap().state, ConnectionState::Disconnected);
    assert_eq!(pco.revoked(), [format!("{APP}/fictional-refresh-1001-0")]);
    assert!(store.saved().is_empty());
    // A one-click sign-in that saved but wasn't taken over yet: it and the church before it go.
    let (store, pco, c) = on_1001();
    one_click(&c, &pco, "2002");
    assert_eq!(c.disconnect().unwrap().state, ConnectionState::Disconnected);
    assert_eq!(
        pco.revoked(),
        [
            format!("{APP}/fictional-refresh-2002-1"),
            format!("{APP}/fictional-refresh-1001-0")
        ]
    );
    assert!(store.saved().is_empty());
    assert!(view(&c).switch.is_none());
}

#[test]
fn retiring_never_touches_the_kept_slot_or_a_finder() {
    let (store, pco, c) = on_1001();
    let kept = c.current().unwrap();
    let retire = |auth: &AuthController, prefix: &str, organization: &str| {
        auth.retire_saved(prefix, organization, None)
            .map_err(|failed| failed.error)
    };
    assert_eq!(
        retire(&kept, "local:", "1001"),
        Err(AuthError::InvalidConfiguration)
    );
    assert_eq!(
        retire(&kept, "local:", "01"),
        Err(AuthError::InvalidConfiguration)
    );
    assert_eq!(
        retire(&kept, "", "2002"),
        Err(AuthError::InvalidConfiguration)
    );
    // Nothing saved there: nothing to do.
    assert_eq!(retire(&kept, "local:", "2002"), Ok(Retired::Done));
    let finder = one_click(&c, &pco, "2002");
    assert_eq!(
        retire(&finder, "local:", "1001"),
        Err(AuthError::InvalidConfiguration)
    );
    // Bytes that aren't a connection at all are removed without a revoke.
    store
        .put("local:3003", "3003", b"not a connection")
        .unwrap();
    c.settle().unwrap();
    let kept = c.current().unwrap();
    assert_eq!(retire(&kept, "local:", "3003"), Ok(Retired::Done));
    assert!(store.raw("3003").is_none());
    assert!(pco.revoked().is_empty());
}

// ---- Independent review S, probes p1 to p7, as tests of what must happen instead. ----

/// Whether a check of `organization` works right now (a fresh controller, refreshed).
fn usable(c: &Connections, organization: &str) -> bool {
    c.prepare("".into(), organization.into(), true, Purpose::Check)
        .ok()
        .is_some_and(|auth| {
            auth.refresh()
                .is_ok_and(|s| s.state == ConnectionState::Connected)
        })
}
fn callback_for(auth: &AuthController) -> String {
    let url = url::Url::parse(&auth.begin().unwrap()).unwrap();
    let state = url.query_pairs().find(|(k, _)| k == "state").unwrap().1;
    format!("{REDIRECT_URI}?code=fictional-code&state={state}")
}

#[test]
fn s_p1_keep_checks_the_church_it_keeps_before_signing_out_of_the_new_one() {
    let (store, pco, c) = asked();
    pco.dead.lock().unwrap().insert("1001".into());
    assert_eq!(
        answer(&c, Decision::Stay).err(),
        Some(ConnectionsError::KeepUnchecked(AuthError::InvalidToken)),
        "1001 can't be verified"
    );
    assert!(view(&c).switch.is_some(), "the question stays open");
    assert_eq!(store.saved(), ["1001", "2002"], "nothing signed out");
    assert!(pco.revoked().is_empty());
    // Switching still works, so the person isn't stuck.
    assert_eq!(answer(&c, Decision::Switch).unwrap().organization, "2002");
}

#[test]
fn keep_with_planning_center_unreachable_changes_nothing_until_it_can_check() {
    let (store, pco, c) = asked();
    pco.refresh_fails.store(true, Ordering::SeqCst);
    assert_eq!(
        answer(&c, Decision::Stay).err(),
        Some(ConnectionsError::KeepUnchecked(AuthError::ProviderFailure))
    );
    assert!(view(&c).switch.is_some());
    assert_eq!(store.saved(), ["1001", "2002"]);
    pco.refresh_fails.store(false, Ordering::SeqCst);
    let kept = answer(&c, Decision::Stay).unwrap();
    assert_eq!(kept.organization, "1001");
    // The church that stays was checked: it is connected, not just saved.
    assert_eq!(kept.status.status.state, ConnectionState::Connected);
    assert_eq!(store.saved(), ["1001"]);
}

#[test]
fn s_p6_each_leftover_keeps_its_own_reason_and_a_refused_one_can_be_removed() {
    let (store, pco, c) = on_1001();
    store
        .put(
            "local:3003",
            "3003",
            br#"{"client_id":"fictional-app-client","organization":"3003","tokens":{"access_token":"fictional-access-3003-9","refresh_token":"fictional-refresh-3003-9","token_type":"bearer","expires_in":7200}}"#,
        )
        .unwrap();
    one_click(&c, &pco, "2002");
    c.settle().unwrap();
    store.refuse("1001", StoreError::Denied);
    pco.revoke_refused.lock().unwrap().insert("3003".into());
    let switched = answer(&c, Decision::Switch).unwrap();
    assert_eq!(
        left(switched.status.unretired),
        [
            ("1001".to_string(), RetireFailure::Denied),
            ("3003".to_string(), RetireFailure::Refused)
        ]
    );
    // Removing what Planning Center refused touches only that one, without a revoke.
    let revoked = pco.revoked().len();
    let after = c.remove_refused().unwrap();
    assert_eq!(
        left(after.unretired),
        [("1001".to_string(), RetireFailure::Denied)]
    );
    assert_eq!(store.saved(), ["1001", "2002"]);
    assert_eq!(pco.revoked().len(), revoked);
    // The other one still waits for the Mac to allow access; then a retry signs out of it.
    *store.refuse.lock().unwrap() = None;
    assert!(c.retry().unwrap().unretired.is_none());
    assert_eq!(store.saved(), ["2002"]);
}

#[test]
fn the_question_names_both_churches_as_planning_center_stated_them() {
    let (store, _pco, c) = asked();
    let asked = view(&c).switch.unwrap();
    assert_eq!(asked.to_name.as_deref(), Some("Fictional Hope Chapel"));
    assert_eq!(asked.from_name.as_deref(), Some("Fictional Grace Church"));
    // Kept with the saved connection, from the userinfo read the sign-in already made.
    assert!(
        store
            .raw("2002")
            .unwrap()
            .contains(r#""organization_name":"Fictional Hope Chapel""#)
    );
    assert_eq!(
        view(&c).status.organization_name.as_deref(),
        Some("Fictional Grace Church")
    );
    let switched = answer(&c, Decision::Switch).unwrap();
    assert_eq!(
        switched.status.in_use.map(|u| u.name),
        Some(Some("Fictional Hope Chapel".to_string()))
    );
    // A record saved before names were kept has none until its next check.
    store
        .put(
            "local:3003",
            "3003",
            br#"{"client_id":"fictional-app-client","organization":"3003","tokens":{"access_token":"fictional-access-3003-9","refresh_token":"fictional-refresh-3003-9","token_type":"bearer","expires_in":7200}}"#,
        )
        .unwrap();
    check(&c, "", "2002");
    let later = view(&c).switch.unwrap();
    assert_eq!((later.to.as_str(), later.to_name), ("3003", None));
}

#[test]
fn church_names_are_display_text_only() {
    assert_eq!(
        church_name("  Grace\u{202E} Church\n"),
        Some("Grace Church".into())
    );
    assert_eq!(church_name("\u{200B}\u{0007} "), None);
    assert_eq!(church_name(&"x".repeat(300)).unwrap().chars().count(), 120);
}

#[test]
fn an_answer_names_its_question_and_the_same_answer_twice_is_harmless() {
    let (store, _pco, c) = asked();
    let id = view(&c).switch.unwrap().id;
    // An answer to another question (a stale page) changes nothing.
    assert_eq!(
        c.answer(Decision::Switch, id + 1).err(),
        Some(ConnectionsError::NoQuestion)
    );
    assert_eq!(store.saved(), ["1001", "2002"]);
    let first = c.answer(Decision::Switch, id).unwrap();
    // The same answer again (a response lost to a reload, a second click) reports today's state.
    let again = c.answer(Decision::Switch, id).unwrap();
    assert_eq!(
        (first.organization.as_str(), again.organization.as_str()),
        ("2002", "2002")
    );
    // A different answer to a question already answered does nothing.
    assert_eq!(
        c.answer(Decision::Stay, id).err(),
        Some(ConnectionsError::NoQuestion)
    );
    assert_eq!(store.saved(), ["2002"]);
}

#[test]
fn the_page_learns_the_church_in_use_and_can_order_what_it_reads() {
    let (_store, pco, c) = on_1001();
    let before = view(&c);
    assert_eq!(
        before.in_use.map(|u| (u.organization, u.client_id)),
        Some(("1001".into(), String::new()))
    );
    one_click(&c, &pco, "2002");
    c.settle().unwrap();
    let asking = view(&c);
    assert!(asking.revision > before.revision);
    // While asking, the church in use is still 1001.
    assert_eq!(asking.in_use.map(|u| u.organization), Some("1001".into()));
    let switched = answer(&c, Decision::Switch).unwrap();
    assert!(switched.status.revision > asking.revision);
    assert_eq!(
        switched.status.in_use.map(|u| u.organization),
        Some("2002".into())
    );
}
#[test]
fn a_sign_in_saved_from_before_under_another_registration_is_never_switched_to() {
    // Review S, L7: an item some other program put under Ozzie's service name.
    let (store, pco, c) = on_1001();
    store
        .put(
            "local:3003",
            "3003",
            br#"{"client_id":"someone-elses-client","organization":"3003","tokens":{"access_token":"fictional-access-3003-9","refresh_token":"fictional-refresh-3003-9","token_type":"bearer","expires_in":7200}}"#,
        )
        .unwrap();
    check(&c, "", "1001");
    assert_eq!(view(&c).switch.map(|q| q.to), Some("3003".into()));
    assert_eq!(
        answer(&c, Decision::Switch).err(),
        Some(ConnectionsError::SignInInstead)
    );
    assert_eq!(current(&c), "1001");
    // Keeping 1001 signs out of it, as the registration it names.
    answer(&c, Decision::Stay).unwrap();
    assert_eq!(
        pco.revoked().last().map(String::as_str),
        Some("someone-elses-client/fictional-refresh-3003-9")
    );
    assert_eq!(store.saved(), ["1001"]);
}

#[test]
fn a_pasted_sign_in_cancelled_after_its_write_puts_back_what_it_replaced() {
    // Review S, L2: the same church signed in again with typed IDs, cancelled mid-write.
    let (store, pco, c) = on_1001();
    *store.slow_put.lock().unwrap() = Some(("1001".into(), Duration::from_millis(600)));
    pco.signs_in_to("1001");
    let pasting = c
        .prepare(OWN.into(), "1001".into(), true, Purpose::SignIn)
        .unwrap();
    let callback = callback_for(&pasting);
    let signing = thread::spawn(move || pasting.callback(&callback));
    thread::sleep(Duration::from_millis(200));
    c.stop_current();
    assert!(signing.join().unwrap().is_err());
    *store.slow_put.lock().unwrap() = None;
    // The connection it replaced is back, and the new credential, which nothing holds, is revoked.
    assert!(
        store
            .raw("1001")
            .unwrap()
            .contains("fictional-access-1001-0")
    );
    assert_eq!(pco.revoked(), [format!("{OWN}/fictional-refresh-1001-1")]);
    assert!(usable(&c, "1001"));
}

#[test]
fn status_polls_keep_answering_while_an_answer_signs_out() {
    let (store, pco, c) = asked();
    *pco.revoke_delay.lock().unwrap() = Duration::from_millis(800);
    let id = view(&c).switch.unwrap().id;
    let answering = {
        let c = c.clone();
        thread::spawn(move || c.answer(Decision::Switch, id))
    };
    let mut slowest = Duration::ZERO;
    let mut seen = Vec::new();
    while !answering.is_finished() {
        let started = Instant::now();
        let shown = view(&c);
        slowest = slowest.max(started.elapsed());
        seen.push((
            shown.revision,
            shown.switch.is_some(),
            shown.status.organization,
        ));
        thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(answering.join().unwrap().unwrap().organization, "2002");
    assert!(
        slowest < Duration::from_millis(200),
        "a poll waited {slowest:?}"
    );
    // Each poll saw one consistent state: still asking on 1001, or switched to 2002 with no
    // question; and revisions only grow.
    for (_, asking, organization) in &seen {
        assert_eq!(*asking, organization == "1001", "{seen:?}");
    }
    assert!(seen.windows(2).all(|w| w[0].0 <= w[1].0));
    assert_eq!(store.saved(), ["2002"]);
}

#[test]
fn a_settle_racing_a_check_never_signs_anything_out() {
    // A one-click sign-in for 2002 finishes while a check of 1001 starts: whichever wins, nothing
    // is revoked, both sign-ins stay saved, and 1001 stays in use.
    for round in 0..40u64 {
        let (store, pco, c) = on_1001();
        one_click(&c, &pco, "2002");
        let polling = {
            let c = c.clone();
            thread::spawn(move || {
                for _ in 0..20 {
                    let _ = c.view();
                }
            })
        };
        thread::sleep(Duration::from_micros(round * 37 % 400));
        let checked = c.prepare("".into(), "1001".into(), true, Purpose::Check);
        polling.join().unwrap();
        if let Ok(auth) = checked {
            let _ = auth.refresh();
            c.after_check(&auth);
        }
        let shown = view(&c);
        assert!(pco.revoked().is_empty(), "round {round}");
        assert_eq!(store.saved(), ["1001", "2002"], "round {round}");
        assert_eq!(shown.status.organization, "1001", "round {round}");
        assert_eq!(
            shown.switch.map(|q| (q.to, q.from)),
            Some(("2002".into(), "1001".into())),
            "round {round}: asked either way"
        );
    }
}

#[test]
fn listing_accepts_only_ozzies_own_account_shape() {
    use ozzie_native_auth::credentials::own_account;
    assert_eq!(
        own_account(r#"["local:1001","1001"]"#),
        Some(("local:1001".into(), "1001".into()))
    );
    for other in [
        r#"[ "local:1001", "1001" ]"#,
        r#"["local:1001","1001","x"]"#,
        r#"{"0":"local:1001"}"#,
        r#"["","1001"]"#,
        r#"["local:1001",1001]"#,
        "local:1001",
    ] {
        assert_eq!(own_account(other), None, "{other}");
    }
}

#[test]
fn s_p2_a_cancel_during_a_keychain_write_never_holds_up_status_or_reads() {
    let (store, pco, c) = on_1001();
    *store.slow_put.lock().unwrap() = Some(("1001".into(), Duration::from_millis(1200)));
    *pco.revoke_delay.lock().unwrap() = Duration::from_millis(1500);
    pco.signs_in_to("1001");
    let finder = c.prepare_finder().unwrap();
    let callback = callback_for(&finder);
    let signing = {
        let finder = finder.clone();
        thread::spawn(move || finder.callback(&callback))
    };
    thread::sleep(Duration::from_millis(300)); // inside the finder's Keychain write
    let stopping = {
        let c = c.clone();
        thread::spawn(move || c.stop_current())
    };
    thread::sleep(Duration::from_millis(200));
    let started = Instant::now();
    let _ = c.view();
    let _ = c.settle();
    let waited = started.elapsed();
    stopping.join().unwrap();
    assert!(signing.join().unwrap().is_err());
    assert!(
        waited < Duration::from_millis(300),
        "status and reads waited {waited:?}"
    );
}

#[test]
fn s_p3_listing_saved_sign_ins_never_holds_up_status() {
    let (store, _pco, c) = on_1001();
    *store.slow_list.lock().unwrap() = Some(Duration::from_millis(1500));
    let checking = {
        let c = c.clone();
        thread::spawn(move || {
            let auth = c
                .prepare("".into(), "1001".into(), true, Purpose::Check)
                .unwrap();
            auth.refresh().unwrap();
            c.after_check(&auth);
        })
    };
    thread::sleep(Duration::from_millis(300));
    let started = Instant::now();
    let _ = c.view();
    let waited = started.elapsed();
    checking.join().unwrap();
    assert!(
        waited < Duration::from_millis(300),
        "status waited {waited:?}"
    );
}

#[test]
fn s_p4_a_new_one_click_sign_in_never_revokes_an_unfinished_one_for_the_same_church() {
    let (store, pco, c) = on_1001();
    one_click(&c, &pco, "1001"); // saved 1001-1 (and revoked 1001-0, which it replaced)
    c.stop_current(); // stopped before the app took it over
    let _next = c.prepare_finder().unwrap(); // "Connect Planning Center" again
    c.stop_current(); // and that one is abandoned
    assert_eq!(store.saved(), ["1001"]);
    assert_eq!(pco.revoked(), [format!("{APP}/fictional-refresh-1001-0")]);
    assert!(usable(&c, "1001"), "1001's newest credential still works");
}

#[test]
fn s_p5_a_cancel_during_a_checks_keychain_write_keeps_the_fresh_credential() {
    let (store, pco, c) = asked();
    *store.slow_put.lock().unwrap() = Some(("1001".into(), Duration::from_millis(1000)));
    let checking = {
        let c = c.clone();
        thread::spawn(move || {
            c.prepare("".into(), "1001".into(), true, Purpose::Check)
                .unwrap()
                .refresh()
                .map(|_| ())
        })
    };
    thread::sleep(Duration::from_millis(300));
    c.stop_current();
    let _ = checking.join().unwrap();
    *store.slow_put.lock().unwrap() = None;
    assert_eq!(store.saved(), ["1001", "2002"], "1001's item is kept");
    assert!(pco.revoked().is_empty());
    assert!(view(&c).switch.is_some(), "the question is still open");
    assert!(
        usable(&c, "1001"),
        "the credential Planning Center just issued is the one saved"
    );
}

#[test]
fn s_p7_a_church_the_person_chose_to_leave_cannot_become_current_through_a_check() {
    let (_store, pco, c) = asked();
    pco.revoke_refused.lock().unwrap().insert("1001".into());
    assert_eq!(answer(&c, Decision::Switch).unwrap().organization, "2002");
    assert!(
        c.prepare("".into(), "1001".into(), true, Purpose::Check)
            .is_err()
    );
    assert_eq!(current(&c), "2002");
    assert!(view(&c).switch.is_none());
}

// ---- Independent review S2, probes p8 to p13 and the v0.1.0 upgrade, as tests. ----

/// The record saved for `organization` now, as JSON text (fictional tokens only).
fn record_of(store: &MemoryStore, organization: &str) -> String {
    store.raw(organization).unwrap_or_default()
}

#[test]
fn s2_p8a_a_retry_never_acts_on_a_church_signed_in_to_again() {
    // 1001 is left behind (offline), then signed in to again while it is still listed.
    let (store, pco, c) = asked();
    pco.revoke_fails.store(true, Ordering::SeqCst);
    answer(&c, Decision::Switch).unwrap();
    assert_eq!(
        left(view(&c).unretired),
        [("1001".to_string(), RetireFailure::RevokeFailed)]
    );
    pco.revoke_fails.store(false, Ordering::SeqCst);
    one_click(&c, &pco, "1001");
    c.settle().unwrap();
    let fresh = record_of(&store, "1001");
    // The new sign-in replaced (and revoked) what was left behind: nothing about 1001 is left.
    assert_eq!(
        view(&c).switch.map(|q| (q.to, q.fresh)),
        Some(("1001".into(), true))
    );
    assert!(view(&c).unretired.is_none());
    // And while a question is open, neither left-behind action runs at all.
    assert_eq!(c.retry().err(), Some(ConnectionsError::SwitchPending));
    assert_eq!(
        c.remove_refused().err(),
        Some(ConnectionsError::SwitchPending)
    );
    assert_eq!(record_of(&store, "1001"), fresh);
    // Switch still works with the fresh sign-in.
    assert_eq!(answer(&c, Decision::Switch).unwrap().organization, "1001");
}

#[test]
fn s2_p8b_removing_a_refused_sign_in_never_touches_a_newer_one_or_leaks_it() {
    let (store, pco, c) = asked();
    pco.revoke_refused.lock().unwrap().insert("1001".into());
    answer(&c, Decision::Switch).unwrap();
    pco.revoke_refused.lock().unwrap().clear();
    one_click(&c, &pco, "1001");
    c.settle().unwrap();
    assert_eq!(
        c.remove_refused().err(),
        Some(ConnectionsError::SwitchPending)
    );
    assert!(
        store.saved().contains(&"1001".to_string()),
        "the fresh sign-in is kept"
    );
    // Keep 2002: the fresh 1001 sign-in is signed out properly (revoked, then deleted).
    let fresh_token = record_of(&store, "1001")
        .split("\"refresh_token\":\"")
        .nth(1)
        .and_then(|rest| rest.split('"').next())
        .unwrap()
        .to_string();
    answer(&c, Decision::Stay).unwrap();
    assert!(pco.revoked().iter().any(|r| r.ends_with(&fresh_token)));
    assert_eq!(store.saved(), ["2002"]);
}

#[test]
fn s2_left_behind_actions_act_only_on_the_record_that_was_left_behind() {
    // Without any question: the slot is overwritten after the sign-out failed (another sign-in
    // saved there by other means). A retry and a removal leave the newer record alone.
    let (store, pco, c) = asked();
    pco.revoke_fails.store(true, Ordering::SeqCst);
    answer(&c, Decision::Switch).unwrap();
    let newer = br#"{"client_id":"fictional-app-client","organization":"1001","tokens":{"access_token":"fictional-access-1001-77","refresh_token":"fictional-refresh-1001-77","token_type":"bearer","expires_in":7200}}"#;
    store.put("local:1001", "1001", newer).unwrap();
    pco.revoke_fails.store(false, Ordering::SeqCst);
    let revoked = pco.revoked().len();
    assert!(
        c.retry().unwrap().unretired.is_none(),
        "no longer that sign-in: let go"
    );
    assert_eq!(record_of(&store, "1001").as_bytes(), newer);
    assert_eq!(pco.revoked().len(), revoked);
    // The same for "Remove … anyway" after a refusal.
    let (store, pco, c) = asked();
    pco.revoke_refused.lock().unwrap().insert("1001".into());
    answer(&c, Decision::Switch).unwrap();
    assert_eq!(
        left(view(&c).unretired),
        [("1001".to_string(), RetireFailure::Refused)]
    );
    assert_eq!(
        view(&c).unretired.unwrap().left[0].ozzie_registration,
        Some(true)
    );
    store.put("local:1001", "1001", newer).unwrap();
    assert!(c.remove_refused().unwrap().unretired.is_none());
    assert_eq!(record_of(&store, "1001").as_bytes(), newer);
    // And when the slot still holds the refused record, it is removed (without a revoke).
    let (store, pco, c) = asked();
    pco.revoke_refused.lock().unwrap().insert("1001".into());
    answer(&c, Decision::Switch).unwrap();
    let revoked = pco.revoked().len();
    assert!(c.remove_refused().unwrap().unretired.is_none());
    assert_eq!(store.saved(), ["2002"]);
    assert_eq!(pco.revoked().len(), revoked);
}

#[test]
fn s2_p9_church_names_follow_the_shared_rule() {
    // core/test/church-name-parity.json: the page's test runs the same cases.
    #[derive(serde::Deserialize)]
    struct Case {
        label: String,
        input: String,
        expected: Option<String>,
    }
    #[derive(serde::Deserialize)]
    struct Cases {
        cases: Vec<Case>,
    }
    let cases: Cases =
        serde_json::from_str(include_str!("../../test/church-name-parity.json")).unwrap();
    assert!(cases.cases.len() >= 20);
    for case in cases.cases {
        assert_eq!(church_name(&case.input), case.expected, "{}", case.label);
        if let Some(name) = &case.expected {
            assert_eq!(
                church_name(name).as_ref(),
                Some(name),
                "{} again",
                case.label
            );
        }
    }
}

#[test]
fn s2_p10_a_planted_sign_in_with_ozzies_own_registration_is_never_switched_to() {
    // Review S2, L3: anyone can mint a sign-in with Ozzie's public registration.
    let (store, pco, c) = on_1001();
    store
        .put(
            "local:6006",
            "6006",
            br#"{"client_id":"fictional-app-client","organization":"6006","tokens":{"access_token":"fictional-access-6006-50","refresh_token":"fictional-refresh-6006-50","token_type":"bearer","expires_in":7200}}"#,
        )
        .unwrap();
    check(&c, "", "1001");
    let found = view(&c).switch.unwrap();
    assert_eq!((found.to.as_str(), found.fresh), ("6006", false));
    assert_eq!(
        answer(&c, Decision::Switch).err(),
        Some(ConnectionsError::SignInInstead)
    );
    assert_eq!(current(&c), "1001");
    assert!(pco.revoked().is_empty());
    // "Sign in to … instead" closes the question and signs out of nothing.
    assert_eq!(
        c.answer(Decision::SignIn, found.id).unwrap().organization,
        "1001"
    );
    assert_eq!(store.saved(), ["1001", "6006"]);
    // Asked again at the next check; Keep signs out of it.
    check(&c, "", "1001");
    answer(&c, Decision::Stay).unwrap();
    assert_eq!(store.saved(), ["1001"]);
    assert_eq!(
        pco.revoked().last().map(String::as_str),
        Some("fictional-app-client/fictional-refresh-6006-50")
    );
    // "Sign in instead" isn't an answer to a sign-in just made.
    let (_store, _pco, c) = asked();
    assert_eq!(
        answer(&c, Decision::SignIn).err(),
        Some(ConnectionsError::NoQuestion)
    );
    assert!(view(&c).switch.is_some());
}

#[test]
fn s2_p13_a_listing_that_leaves_out_the_church_in_use_still_asks() {
    let (store, pco, c) = on_1001();
    store.list_nothing.store(true, Ordering::SeqCst);
    one_click(&c, &pco, "2002");
    c.settle().unwrap();
    assert_eq!(
        shape(&view(&c).switch),
        Some(question("2002", "1001", &["1001"], true))
    );
    assert_eq!(current(&c), "1001");
    assert!(pco.revoked().is_empty());
}

#[test]
fn v010_upgrade_a_saved_sign_in_from_v010_keeps_working_and_reads_back_in_v010() {
    // A record exactly as v0.1.0 writes it (no church name), for the church in Settings.
    let store = Arc::new(MemoryStore::default());
    let pco = Arc::new(Churches::default());
    store
        .put(
            "local:1001",
            "1001",
            br#"{"client_id":"fictional-app-client","organization":"1001","tokens":{"access_token":"fictional-access-1001-0","refresh_token":"fictional-refresh-1001-0","token_type":"bearer","expires_in":7200}}"#,
        )
        .unwrap();
    pco.minted.store(1, Ordering::SeqCst);
    let c = connections(store.clone(), &pco);
    // First launch: the launch check of the church in Settings works and asks nothing.
    check(&c, "", "1001");
    let shown = view(&c);
    assert!(shown.switch.is_none() && shown.unretired.is_none());
    assert_eq!(
        shown.in_use.map(|u| (u.organization, u.client_id)),
        Some(("1001".into(), String::new()))
    );
    assert!(pco.revoked().is_empty());
    assert_eq!(store.saved(), ["1001"]);
    // The record now carries the church's name, and still reads as v0.1.0 reads it.
    #[derive(serde::Deserialize)]
    struct V010Tokens {
        access_token: String,
        refresh_token: Option<String>,
        token_type: String,
        expires_in: u64,
    }
    #[derive(serde::Deserialize)]
    struct V010Record {
        client_id: String,
        organization: String,
        tokens: V010Tokens,
    }
    let now = record_of(&store, "1001");
    assert!(now.contains(r#""organization_name":"Fictional Grace Church""#));
    let old: V010Record = serde_json::from_str(&now).unwrap();
    assert_eq!(
        (old.client_id.as_str(), old.organization.as_str()),
        (APP, "1001")
    );
    assert!(
        old.tokens
            .access_token
            .starts_with("fictional-access-1001-")
    );
    assert!(old.tokens.refresh_token.is_some());
    assert_eq!(
        (old.tokens.token_type.as_str(), old.tokens.expires_in),
        ("bearer", 7200)
    );
}

// ---------- review S3 ----------

/// A sign-in some other program put under Ozzie's service name (fictional tokens), saved with
/// `client`.
fn plant(store: &MemoryStore, organization: &str, client: &str, n: u64) {
    let record = format!(
        r#"{{"client_id":"{client}","organization":"{organization}","tokens":{{"access_token":"fictional-access-{organization}-{n}","refresh_token":"fictional-refresh-{organization}-{n}","token_type":"bearer","expires_in":7200}}}}"#
    );
    store
        .put(
            &format!("local:{organization}"),
            organization,
            record.as_bytes(),
        )
        .unwrap();
}
/// Connected to 1001, a sign-in for 6006 planted with `client`, asked about as found, and the
/// person chose "Sign in to 6006 instead".
fn signing_in_instead(client: &str) -> (Arc<MemoryStore>, Arc<Churches>, Arc<Connections>) {
    let (store, pco, c) = on_1001();
    plant(&store, "6006", client, 50);
    check(&c, "", "1001");
    assert_eq!(
        shape(&view(&c).switch),
        Some(question("6006", "1001", &["1001"], false))
    );
    assert_eq!(answer(&c, Decision::SignIn).unwrap().organization, "1001");
    assert!(view(&c).switch.is_none());
    (store, pco, c)
}

#[test]
fn s3_p14_a_found_sign_in_is_never_checked_into_use() {
    // Review S3, M1: after "Sign in to 6006 instead", a check of 6006 (Settings naming it, "Check
    // saved connection", the next launch) is refused: only a fresh sign-in replaces it.
    for client in [APP, OWN] {
        let (store, pco, c) = signing_in_instead(client);
        let own = if client == APP { "" } else { OWN };
        assert_eq!(
            c.prepare(own.into(), "6006".into(), true, Purpose::Check)
                .err(),
            Some(ConnectionsError::SignInInstead)
        );
        assert_eq!(current(&c), "1001");
        // The person's own church is never the "found" one, and nothing is signed out.
        check(&c, "", "1001");
        assert_eq!(
            shape(&view(&c).switch),
            Some(question("6006", "1001", &["1001"], false))
        );
        assert!(pco.revoked().is_empty());
        assert_eq!(store.saved(), ["1001", "6006"]);
    }
}

#[test]
fn s3_p22_an_abandoned_sign_in_leaves_ozzie_on_the_church_it_used() {
    // Review S3, L2: "Sign in to 6006 instead" started a sign-in the person then cancelled (or
    // closed the browser on). Ozzie goes back to 1001, in use, as the answer said it would.
    let (_store, pco, c) = signing_in_instead(APP);
    pco.signs_in_to("6006");
    let _finder = c.prepare_finder().unwrap();
    assert!(
        view(&c).in_use.is_none(),
        "nothing reads while a sign-in runs"
    );
    c.stop_current();
    let shown = view(&c);
    assert_eq!(
        shown.in_use.map(|u| u.organization),
        Some("1001".to_string())
    );
    assert_eq!(current(&c), "1001");
    assert!(usable(&c, "1001"));
    // The same with the church's own registration (typed IDs).
    let (_store, pco, c) = on_1001();
    pco.signs_in_to("6006");
    let _pasting = c
        .prepare(OWN.into(), "6006".into(), true, Purpose::SignIn)
        .unwrap();
    c.stop_current();
    assert_eq!(
        view(&c).in_use.map(|u| u.organization),
        Some("1001".to_string())
    );
}

#[test]
fn s3_p22_a_sign_in_left_to_expire_leaves_ozzie_on_the_church_it_used() {
    let clock = Arc::new(AtomicU64::new(1_000));
    let store = Arc::new(MemoryStore::default());
    let pco = Arc::new(Churches::default());
    let c = connections_at(store.clone(), &pco, clock.clone());
    one_click(&c, &pco, "1001");
    c.settle().unwrap();
    let finder = c.prepare_finder().unwrap();
    finder.begin().unwrap();
    clock.store(1_000 + ATTEMPT_LIFETIME_MS, Ordering::SeqCst);
    let shown = view(&c);
    assert_eq!(
        shown.in_use.map(|u| u.organization),
        Some("1001".to_string())
    );
    assert!(usable(&c, "1001"));
    assert_eq!(store.saved(), ["1001"]);
}

/// The app's record of the church in use, in memory and shared across "launches" of a test: every
/// write, with how many sign-outs Planning Center had seen when it was made.
#[derive(Default)]
struct Remembered {
    last: Mutex<Option<UsedChurch>>,
    saves: Mutex<Vec<(UsedChurch, usize)>>,
    pco: Mutex<Option<Arc<Churches>>>,
    /// Writes fail (a full disk, a folder Ozzie may no longer write).
    fail: AtomicBool,
}
impl UseHistory for Remembered {
    fn load(&self) -> Option<UsedChurch> {
        self.last.lock().unwrap().clone()
    }
    fn save(&self, used: &UsedChurch) -> std::io::Result<()> {
        if self.fail.load(Ordering::SeqCst) {
            return Err(std::io::Error::other("no space left"));
        }
        let revoked = self
            .pco
            .lock()
            .unwrap()
            .as_ref()
            .map_or(0, |pco| pco.revoked().len());
        self.saves.lock().unwrap().push((used.clone(), revoked));
        *self.last.lock().unwrap() = Some(used.clone());
        Ok(())
    }
}
fn used(organization: &str, leaving: &[&str]) -> UsedChurch {
    UsedChurch {
        organization: organization.into(),
        client_id: String::new(),
        leaving: leaving.iter().map(|o| o.to_string()).collect(),
    }
}
/// Ozzie launched with its record of the church in use (the app's data folder).
fn launched(
    store: &Arc<MemoryStore>,
    pco: &Arc<Churches>,
    history: &Arc<Remembered>,
) -> Arc<Connections> {
    let c = connections(store.clone(), pco);
    c.keep_use_history(history.clone());
    c
}
/// Connected to 1001 with one click, remembered.
fn remembered_1001() -> (
    Arc<MemoryStore>,
    Arc<Churches>,
    Arc<Remembered>,
    Arc<Connections>,
) {
    let store = Arc::new(MemoryStore::default());
    let pco = Arc::new(Churches::default());
    let history = Arc::new(Remembered::default());
    *history.pco.lock().unwrap() = Some(pco.clone());
    let c = launched(&store, &pco, &history);
    one_click(&c, &pco, "1001");
    c.settle().unwrap();
    assert_eq!(history.load(), Some(used("1001", &[])));
    (store, pco, history, c)
}
/// The page's check, as the launch, a Sunday check or "Check saved connection" sends it.
fn page_check(c: &Connections, client: &str, organization: &str) -> Arc<AuthController> {
    let auth = c
        .prepare_check(client.into(), organization.into(), true)
        .unwrap();
    assert_eq!(auth.refresh().unwrap().state, ConnectionState::Connected);
    c.after_check(&auth);
    auth
}

#[test]
fn s3_ids_typed_for_another_church_then_a_relaunch_never_make_its_sign_in_current() {
    // Review S3, M1: Settings name 6006 (typed under Advanced with the church's own registration,
    // or edited) and Ozzie quits; 6006 has a sign-in saved from before. The launch check checks
    // 1001, the church Ozzie last used, and asks about 6006 as found; nothing is signed out.
    let (store, pco, history, c) = remembered_1001();
    plant(&store, "6006", OWN, 50);
    drop(c);
    let c = launched(&store, &pco, &history);
    assert_eq!(
        c.prepare(OWN.into(), "6006".into(), true, Purpose::Check)
            .err(),
        Some(ConnectionsError::SignInInstead)
    );
    let checked = page_check(&c, OWN, "6006");
    assert_eq!(checked.bound_to().1, "1001");
    let shown = view(&c);
    assert_eq!(
        shown.in_use.map(|u| u.organization),
        Some("1001".to_string())
    );
    assert_eq!(shown.declined.as_deref(), Some("6006"));
    assert_eq!(
        shape(&shown.switch),
        Some(question("6006", "1001", &["1001"], false))
    );
    assert!(pco.revoked().is_empty());
    assert_eq!(store.saved(), ["1001", "6006"]);
    // The same within one launch: Settings edited to a planted church, "Check saved connection".
    let (store, pco, _history, c) = remembered_1001();
    plant(&store, "6006", APP, 51);
    let checked = page_check(&c, "", "6006");
    assert_eq!(checked.bound_to().1, "1001");
    assert_eq!(current(&c), "1001");
    assert_eq!(
        shape(&view(&c).switch),
        Some(question("6006", "1001", &["1001"], false))
    );
    // Keep, the main choice, signs out of the planted one and never of 1001.
    answer(&c, Decision::Stay).unwrap();
    assert_eq!(pco.revoked(), [format!("{APP}/fictional-refresh-6006-51")]);
    assert_eq!(store.saved(), ["1001"]);
}

#[test]
fn s3_a_sign_in_before_any_check_asks_before_ozzie_stops_using_the_church_it_last_used() {
    // Review S3, M1 (the role flip): a launch whose check didn't run, then a one-click sign-in
    // that binds to 2002. 1001, the church Ozzie last used, is kept and asked about as the church
    // in use (Switch or Keep), never as a sign-in Ozzie found whose main button signs it out.
    let (store, pco, history, c) = remembered_1001();
    drop(c);
    let c = launched(&store, &pco, &history);
    one_click(&c, &pco, "2002");
    c.settle().unwrap();
    assert_eq!(current(&c), "1001");
    assert_eq!(
        shape(&view(&c).switch),
        Some(question("2002", "1001", &["1001"], true))
    );
    assert_eq!(history.load(), Some(used("1001", &[])));
    let answered = answer(&c, Decision::Switch).unwrap();
    assert_eq!(answered.organization, "2002");
    assert_eq!(history.load(), Some(used("2002", &[])));
    assert_eq!(store.saved(), ["2002"]);
}

#[test]
fn s3_a_switch_is_recorded_before_anything_is_signed_out() {
    // Review S3, L1: the church switched to is written down before the first sign-out, with the
    // churches being left, so Ozzie closing partway never leaves the next launch on the old one.
    let (store, pco, history, c) = remembered_1001();
    one_click(&c, &pco, "2002");
    c.settle().unwrap();
    answer(&c, Decision::Switch).unwrap();
    let saves = history.saves.lock().unwrap().clone();
    let first = saves
        .iter()
        .position(|(u, _)| u.organization == "2002")
        .unwrap();
    assert_eq!(saves[first], (used("2002", &["1001"]), 0));
    assert_eq!(saves.last().unwrap().0, used("2002", &[]));
    assert_eq!(store.saved(), ["2002"]);
}

#[test]
fn s3_p18_closing_between_a_sign_out_and_its_removal_is_finished_at_the_next_launch() {
    // Review S3, L1a: Planning Center accepted the sign-out of 1001 but its removal from this Mac
    // didn't happen before Ozzie closed. The next launch uses 2002 whatever Settings name, and
    // reports 1001 as not signed out yet, never as a sign-in Ozzie found.
    let (store, pco, history, c) = remembered_1001();
    one_click(&c, &pco, "2002");
    c.settle().unwrap();
    *store.refuse_delete.lock().unwrap() = Some("1001".into());
    answer(&c, Decision::Switch).unwrap();
    assert_eq!(history.load(), Some(used("2002", &["1001"])));
    drop(c);
    *store.refuse_delete.lock().unwrap() = None;
    let c = launched(&store, &pco, &history);
    // The page never heard back, so its Settings still name 1001.
    let checked = page_check(&c, "", "1001");
    assert_eq!(checked.bound_to().1, "2002");
    let shown = view(&c);
    assert!(shown.switch.is_none(), "1001 isn't asked about as found");
    assert!(shown.declined.is_none(), "1001 was left, not declined");
    assert_eq!(
        left(shown.unretired),
        [("1001".to_string(), RetireFailure::Unfinished)]
    );
    assert_eq!(
        shown.in_use.map(|u| u.organization),
        Some("2002".to_string())
    );
    // Trying again finishes it.
    assert!(c.retry().unwrap().unretired.is_none());
    assert_eq!(store.saved(), ["2002"]);
    assert_eq!(history.load(), Some(used("2002", &[])));
}

#[test]
fn s3_p19_an_answer_that_never_reached_native_code_leaves_the_church_in_use() {
    // Review S3, L1a: Ozzie quit right after the click, before the answer arrived. Nothing was
    // signed out; 1001 is still the church in use (not "found"), and 2002 is asked about.
    let (store, pco, history, c) = remembered_1001();
    one_click(&c, &pco, "2002");
    c.settle().unwrap();
    drop(c);
    let c = launched(&store, &pco, &history);
    page_check(&c, "", "1001");
    assert_eq!(current(&c), "1001");
    assert_eq!(
        shape(&view(&c).switch),
        Some(question("2002", "1001", &["1001"], false))
    );
    assert!(pco.revoked().is_empty());
    assert_eq!(store.saved(), ["1001", "2002"]);
}

#[test]
fn s3_p20_a_church_whose_sign_in_is_gone_falls_back_to_the_one_in_use_and_says_so() {
    // Review S3, L1c: Settings name 2002 but its sign-in is gone. 1001's working sign-in is used,
    // and the page is told 2002 needs a new sign-in, rather than leaving Ozzie not connected.
    let (store, pco, history, c) = remembered_1001();
    one_click(&c, &pco, "2002");
    c.settle().unwrap();
    drop(c);
    store.delete("local:2002", "2002").unwrap();
    let c = launched(&store, &pco, &history);
    let checked = page_check(&c, "", "2002");
    assert_eq!(checked.bound_to().1, "1001");
    let shown = view(&c);
    assert_eq!(shown.status.state, ConnectionState::Connected);
    assert_eq!(shown.declined.as_deref(), Some("2002"));
    assert!(shown.switch.is_none());
    assert_eq!(store.saved(), ["1001"]);
    // With the church Ozzie last used gone too, the record no longer decides: the church Settings
    // name is checked as before Ozzie kept it, and the page is told why (review S4, L3).
    store.delete("local:1001", "1001").unwrap();
    plant(&store, "6006", APP, 52);
    let c = launched(&store, &pco, &history);
    page_check(&c, "", "6006");
    let shown = view(&c);
    assert_eq!(current(&c), "6006");
    assert_eq!(shown.missing.as_deref(), Some("1001"));
    assert!(shown.declined.is_none());
    assert_eq!(history.load(), Some(used("6006", &[])));
}

#[test]
fn s3_upgrading_from_v010_checks_the_church_in_settings_and_remembers_it() {
    // No record yet (v0.1.0 kept none): the church in Settings is checked as before, and is the
    // church Ozzie uses from then on.
    let store = Arc::new(MemoryStore::default());
    let pco = Arc::new(Churches::default());
    let history = Arc::new(Remembered::default());
    plant(&store, "513367", APP, 7);
    let c = launched(&store, &pco, &history);
    page_check(&c, "", "513367");
    assert_eq!(current(&c), "513367");
    assert!(view(&c).switch.is_none() && view(&c).declined.is_none());
    assert_eq!(history.load(), Some(used("513367", &[])));
    assert!(pco.revoked().is_empty());
}

#[test]
fn s3_the_page_reads_unfinished_and_declined_by_these_names() {
    assert_eq!(
        serde_json::to_string(&RetireFailure::Unfinished).unwrap(),
        r#""unfinished""#
    );
    let (store, pco, history, c) = remembered_1001();
    drop(c);
    let c = launched(&store, &pco, &history);
    page_check(&c, "", "2002");
    let shown = serde_json::to_value(view(&c)).unwrap();
    assert_eq!(shown["declined"], "2002");
    page_check(&c, "", "1001");
    let shown = serde_json::to_value(view(&c)).unwrap();
    assert!(shown.get("declined").is_none());
}

// ---------- review S4 ----------

#[test]
fn s4_s12_why_a_sign_in_failed_stays_on_screen_while_the_church_in_use_stays() {
    // Review S4, M1: typed IDs for 3003, but Planning Center bound the sign-in to 2002. 1001 stays
    // in use, and the next status still says why the sign-in failed.
    let (_store, pco, c) = on_1001();
    pco.signs_in_to("2002");
    let auth = c
        .prepare(OWN.into(), "3003".into(), true, Purpose::SignIn)
        .unwrap();
    assert!(auth.callback(&callback_for(&auth)).is_err());
    assert_eq!(auth.status().unwrap().state, ConnectionState::Failed);
    let shown = serde_json::to_value(view(&c)).unwrap();
    assert_eq!(shown["in_use"]["organization"], "1001");
    let text = shown.to_string();
    assert!(text.contains(r#""organization-unverified""#), "{text}");
    assert!(text.contains(r#""organization_diagnostic""#), "{text}");
    let shown = view(&c);
    assert_eq!(shown.status.state, ConnectionState::StoredUnchecked);
    let attempt = shown.last_attempt.unwrap();
    assert_eq!(attempt.state, ConnectionState::Failed);
    assert_eq!(attempt.problem, Some(AuthError::OrganizationUnverified));
    assert!(attempt.organization_diagnostic.is_some());
    assert!(attempt.scopes.is_none() && attempt.checked_at_ms.is_none());
}

/// How the last sign-in ended, and the church in use, from the page's next status poll.
fn attempt_of(c: &Connections) -> (Option<ConnectionState>, String) {
    let shown = view(c);
    (
        shown.last_attempt.map(|a| a.state),
        shown.in_use.map(|u| u.organization).unwrap_or_default(),
    )
}

#[test]
fn s4_every_way_into_a_sign_in_keeps_why_it_ended_while_the_church_in_use_stays() {
    // Review S4, M1. "Sign in again" (one click), cancelled on this Mac.
    let (_store, pco, c) = on_1001();
    pco.signs_in_to("1001");
    c.prepare_finder().unwrap().begin().unwrap();
    c.stop_current();
    assert_eq!(
        attempt_of(&c),
        (Some(ConnectionState::Cancelled), "1001".to_string())
    );
    // "Also check rooms, follow-ups and group events": Deny at Planning Center.
    let (_store, _pco, c) = on_1001();
    let finder = c.prepare_finder().unwrap();
    let url = url::Url::parse(&finder.begin_with(Scopes::ServicesAndOperations).unwrap()).unwrap();
    let state = url.query_pairs().find(|(k, _)| k == "state").unwrap().1;
    assert!(
        finder
            .callback(&format!("{REDIRECT_URI}?error=access_denied&state={state}"))
            .is_err()
    );
    assert_eq!(
        attempt_of(&c),
        (Some(ConnectionState::Cancelled), "1001".to_string())
    );
    // IDs typed under Advanced, bound to another organization: s4_s12 above.
    // "Sign in to 6006 instead", left to expire in the browser.
    let clock = Arc::new(AtomicU64::new(1_000));
    let store = Arc::new(MemoryStore::default());
    let pco = Arc::new(Churches::default());
    let c = connections_at(store.clone(), &pco, clock.clone());
    one_click(&c, &pco, "1001");
    c.settle().unwrap();
    plant(&store, "6006", APP, 50);
    check(&c, "", "1001");
    answer(&c, Decision::SignIn).unwrap();
    pco.signs_in_to("6006");
    c.prepare_finder().unwrap().begin().unwrap();
    clock.store(1_000 + ATTEMPT_LIFETIME_MS, Ordering::SeqCst);
    assert_eq!(
        attempt_of(&c),
        (Some(ConnectionState::Expired), "1001".to_string())
    );
}

#[test]
fn s4_why_a_sign_in_ended_clears_when_the_next_sign_in_or_check_starts() {
    let (_store, pco, c) = on_1001();
    c.prepare_finder().unwrap();
    c.stop_current();
    assert!(view(&c).last_attempt.is_some());
    check(&c, "", "1001");
    assert!(view(&c).last_attempt.is_none());
    c.prepare_finder().unwrap();
    c.stop_current();
    assert!(view(&c).last_attempt.is_some());
    pco.signs_in_to("1001");
    let _signing = c.prepare_finder().unwrap();
    assert!(view(&c).last_attempt.is_none());
    // Nothing is kept when there was no church to go back to: the sign-in's own status says it.
    let store = Arc::new(MemoryStore::default());
    let c = connections(store, &pco);
    c.prepare_finder().unwrap();
    c.stop_current();
    let shown = view(&c);
    assert_eq!(shown.status.state, ConnectionState::Cancelled);
    assert!(shown.last_attempt.is_none() && shown.in_use.is_none());
}

#[test]
fn s4_s6_a_record_naming_a_church_whose_sign_in_is_gone_never_refuses_every_check() {
    // Review S4, L3: the record names 1001, whose sign-in is gone; only 2002 is saved and
    // Settings name it. The check of 2002 runs as it did before the record existed.
    let store = Arc::new(MemoryStore::default());
    let pco = Arc::new(Churches::default());
    let history = Arc::new(Remembered::default());
    *history.last.lock().unwrap() = Some(used("1001", &[]));
    plant(&store, "2002", APP, 1);
    let c = launched(&store, &pco, &history);
    page_check(&c, "", "2002");
    assert_eq!(current(&c), "2002");
    assert_eq!(view(&c).missing.as_deref(), Some("1001"));
    assert_eq!(history.load(), Some(used("2002", &[])));
    // Remembered from then on: the next launch says nothing more.
    let c = launched(&store, &pco, &history);
    page_check(&c, "", "2002");
    assert!(view(&c).missing.is_none());
}

#[test]
fn s4_s7_a_record_that_cannot_be_rewritten_never_refuses_the_church_switched_to() {
    // Review S4, L3: the record can't be written after a switch (disk full, permissions): it
    // still names 1001, which the switch signed out of. Every later launch checks 2002.
    let (store, pco, history, c) = remembered_1001();
    history.fail.store(true, Ordering::SeqCst);
    one_click(&c, &pco, "2002");
    c.settle().unwrap();
    answer(&c, Decision::Switch).unwrap();
    assert_eq!(store.saved(), ["2002"]);
    assert_eq!(history.load(), Some(used("1001", &[])));
    for _ in 0..2 {
        let c = launched(&store, &pco, &history);
        page_check(&c, "", "2002");
        assert_eq!(current(&c), "2002");
        assert_eq!(view(&c).missing.as_deref(), Some("1001"));
    }
}

#[test]
fn s4_s10_status_polls_after_an_abandoned_sign_in_list_the_keychain_once() {
    // Review S4, L4: the church the abandoned sign-in replaced has no saved sign-in, so it can't
    // be put back; polls then stop asking the Keychain.
    let (store, _pco, c) = on_1001();
    store.delete("local:1001", "1001").unwrap();
    let _finder = c.prepare_finder().unwrap();
    c.stop_current();
    let before = store.listings.load(Ordering::SeqCst);
    for _ in 0..10 {
        let _ = c.view();
    }
    assert!(
        store.listings.load(Ordering::SeqCst) - before <= 1,
        "{} listings",
        store.listings.load(Ordering::SeqCst) - before
    );
}

#[test]
fn s4_a_sign_in_stopped_before_it_says_so_itself_is_reported_as_cancelled() {
    // A poll that lands between Cancel interrupting the sign-in and marking it cancelled: the
    // sign-in is reported as cancelled, never as still waiting.
    let (_store, pco, c) = on_1001();
    pco.signs_in_to("1001");
    let finder = c.prepare_finder().unwrap();
    finder.begin().unwrap();
    finder.interrupt();
    assert_eq!(finder.status().unwrap().state, ConnectionState::Waiting);
    assert_eq!(
        attempt_of(&c),
        (Some(ConnectionState::Cancelled), "1001".to_string())
    );
}
