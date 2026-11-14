use super::*;
use crate::sunday::{RETIRED, RetireReason, SundayAuthority, SundayRefusal};
use std::sync::atomic::AtomicUsize;

#[derive(Default)]
struct GateStore {
    bytes: Mutex<Option<Vec<u8>>>,
    gets: AtomicUsize,
    puts: AtomicUsize,
    deletes: AtomicUsize,
    put_gate: Mutex<Option<Arc<PutGate>>>,
    get_reply: Mutex<Option<Result<Option<Vec<u8>>, StoreError>>>,
    delete_error: Mutex<Option<StoreError>>,
}
impl CredentialStore for GateStore {
    fn get(&self, _: &str, _: &str) -> Result<Option<Vec<u8>>, StoreError> {
        self.gets.fetch_add(1, Ordering::SeqCst);
        if let Some(reply) = self.get_reply.lock().unwrap().take() {
            return reply;
        }
        Ok(self.bytes.lock().unwrap().clone())
    }
    fn put(&self, _: &str, _: &str, bytes: &[u8]) -> Result<(), StoreError> {
        self.puts.fetch_add(1, Ordering::SeqCst);
        *self.bytes.lock().unwrap() = Some(bytes.to_vec());
        let gate = self.put_gate.lock().unwrap().clone();
        if let Some(gate) = gate {
            gate.entered.send(()).unwrap();
            gate.release.lock().unwrap().recv().unwrap();
        }
        Ok(())
    }
    fn delete(&self, _: &str, _: &str) -> Result<(), StoreError> {
        self.deletes.fetch_add(1, Ordering::SeqCst);
        if let Some(error) = *self.delete_error.lock().unwrap() {
            return Err(error);
        }
        *self.bytes.lock().unwrap() = None;
        Ok(())
    }
}
#[derive(Default)]
struct GateProvider {
    exchanges: AtomicUsize,
    organizations: AtomicUsize,
}
impl Provider for GateProvider {
    fn exchange(&self, _: &str, _: &str, _: &str) -> Result<Tokens, AuthError> {
        self.exchanges.fetch_add(1, Ordering::SeqCst);
        Ok(Tokens {
            access_token: "fictional-gates-access".into(),
            refresh_token: Some("fictional-gates-refresh".into()),
            token_type: "bearer".into(),
            expires_in: 7200,
        })
    }
    fn organization(&self, _: &str) -> Result<String, AuthError> {
        self.organizations.fetch_add(1, Ordering::SeqCst);
        Ok("1001".into())
    }
    fn refresh(&self, _: &str, _: &str) -> Result<Tokens, AuthError> {
        panic!("gate test must not refresh")
    }
    fn revoke(&self, _: &str, _: &str, _: &str) -> Result<(), AuthError> {
        panic!("gate test must not revoke")
    }
}
fn binding() -> Binding {
    Binding {
        workspace: "fictional-workspace".into(),
        organization: "1001".into(),
        client_id: "fictional-client".into(),
    }
}
fn pending(auth: &AuthController) -> String {
    let url = url::Url::parse(&auth.begin().unwrap()).unwrap();
    let state = url
        .query_pairs()
        .find(|(k, _)| k == "state")
        .unwrap()
        .1
        .into_owned();
    format!("{REDIRECT_URI}?code=fictional-code&state={state}")
}
fn rig() -> (
    AuthController,
    Arc<SundayAuthority>,
    Arc<GateStore>,
    Arc<GateProvider>,
) {
    let a = Arc::new(SundayAuthority::new().unwrap());
    let s = Arc::new(GateStore::default());
    let p = Arc::new(GateProvider::default());
    let auth = AuthController::new_with_sunday_authority(
        binding(),
        s.clone(),
        p.clone(),
        Arc::new(|| 0),
        a.clone(),
    )
    .unwrap();
    let callback = pending(&auth);
    auth.callback(&callback).unwrap();
    (auth, a, s, p)
}
#[test]
fn sunday_gate_disconnect_retires_while_publication_is_held_without_io() {
    let (auth, a, s, p) = rig();
    let gets = s.gets.load(Ordering::SeqCst);
    let calls = p.organizations.load(Ordering::SeqCst);
    let held = a.publication().unwrap();
    assert_eq!(auth.disconnect().err(), Some(AuthError::Busy));
    assert_ne!(a.word.load(Ordering::SeqCst) & RETIRED, 0);
    drop(held);
    assert_eq!(s.gets.load(Ordering::SeqCst), gets);
    assert_eq!(p.organizations.load(Ordering::SeqCst), calls);
    assert_eq!(s.deletes.load(Ordering::SeqCst), 0);
}

use std::{sync::mpsc, thread::JoinHandle, time::Duration};
struct PutGate {
    entered: mpsc::SyncSender<()>,
    release: Mutex<mpsc::Receiver<()>>,
}
struct GateJob {
    release: Option<mpsc::SyncSender<()>>,
    worker: Option<JoinHandle<Result<ConnectionStatus, AuthError>>>,
}
impl GateJob {
    fn finish(mut self) -> Result<ConnectionStatus, AuthError> {
        self.release.take().unwrap().send(()).unwrap();
        self.worker.take().unwrap().join().unwrap()
    }
}
impl Drop for GateJob {
    fn drop(&mut self) {
        if let Some(release) = self.release.take() {
            let _ = release.send(());
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
fn held_save(auth: AuthController, store: &GateStore) -> (GateJob, mpsc::Receiver<()>) {
    let callback = pending(&auth);
    let (entered, observed) = mpsc::sync_channel(1);
    let (release, wait) = mpsc::sync_channel(1);
    *store.put_gate.lock().unwrap() = Some(Arc::new(PutGate {
        entered,
        release: Mutex::new(wait),
    }));
    let worker = std::thread::spawn(move || auth.callback(&callback));
    (
        GateJob {
            release: Some(release),
            worker: Some(worker),
        },
        observed,
    )
}
#[test]
fn sunday_gate_saved_but_unpublished_contention_is_truthfully_unchecked() {
    let (auth, a, s, _) = rig();
    let auth = Arc::new(auth);
    let callback = pending(&auth);
    let (entered, observed) = mpsc::sync_channel(1);
    let (release, wait) = mpsc::sync_channel(1);
    *s.put_gate.lock().unwrap() = Some(Arc::new(PutGate {
        entered,
        release: Mutex::new(wait),
    }));
    let writer = auth.clone();
    let job = GateJob {
        release: Some(release),
        worker: Some(std::thread::spawn(move || writer.callback(&callback))),
    };
    observed.recv_timeout(Duration::from_secs(3)).unwrap();
    let held = a.publication().unwrap();
    assert_eq!(job.finish().err(), Some(AuthError::Cancelled));
    drop(held);
    assert_eq!(s.deletes.load(Ordering::SeqCst), 0);
    assert!(s.bytes.lock().unwrap().is_some());
    let status = auth.status().unwrap();
    assert_eq!(status.state, ConnectionState::StoredUnchecked);
    assert_eq!(status.checked_at_ms, None);
    assert_ne!(a.word.load(Ordering::SeqCst) & RETIRED, 0);
}

#[test]
fn sunday_gate_retired_save_compares_exact_raw_bytes_before_compensation() {
    for case in 0..8 {
        let (auth, a, s, _) = rig();
        let before = s.gets.load(Ordering::SeqCst);
        let (job, observed) = held_save(auth, &s);
        observed.recv_timeout(Duration::from_secs(3)).unwrap();
        let saved = s.bytes.lock().unwrap().clone().unwrap();
        match case {
            1 => {
                let mut drift = saved.clone();
                drift.push(b' ');
                assert_eq!(
                    serde_json::from_slice::<serde_json::Value>(&saved).unwrap(),
                    serde_json::from_slice::<serde_json::Value>(&drift).unwrap()
                );
                *s.bytes.lock().unwrap() = Some(drift);
            }
            2 => *s.bytes.lock().unwrap() = Some(b"fictional-newer-record".to_vec()),
            3 => *s.bytes.lock().unwrap() = None,
            4 => *s.get_reply.lock().unwrap() = Some(Err(StoreError::Locked)),
            5 => *s.get_reply.lock().unwrap() = Some(Err(StoreError::Denied)),
            6 => *s.get_reply.lock().unwrap() = Some(Err(StoreError::Unavailable)),
            7 => *s.delete_error.lock().unwrap() = Some(StoreError::Denied),
            _ => {}
        }
        let target = s.bytes.lock().unwrap().clone();
        a.retire(RetireReason::AuthorityChanged).unwrap();
        assert_eq!(job.finish().err(), Some(AuthError::Cancelled));
        assert_eq!(s.gets.load(Ordering::SeqCst), before + 1);
        assert_eq!(
            s.deletes.load(Ordering::SeqCst),
            usize::from(case == 0 || case == 7)
        );
        assert_eq!(
            *s.bytes.lock().unwrap(),
            if case == 0 { None } else { target }
        );
        assert_ne!(a.word.load(Ordering::SeqCst) & RETIRED, 0);
    }
}

#[test]
fn sunday_gate_matching_expired_callback_is_consumed_without_exchange() {
    let a = Arc::new(SundayAuthority::new().unwrap());
    let s = Arc::new(GateStore::default());
    let p = Arc::new(GateProvider::default());
    let clock = Arc::new(AtomicU64::new(0));
    let c = clock.clone();
    let auth = AuthController::new_with_sunday_authority(
        binding(),
        s.clone(),
        p.clone(),
        Arc::new(move || c.load(Ordering::SeqCst)),
        a.clone(),
    )
    .unwrap();
    let callback = pending(&auth);
    clock.store(ATTEMPT_LIFETIME_MS, Ordering::SeqCst);
    let before = a.word.load(Ordering::SeqCst);
    assert_eq!(
        auth.callback(&callback.replace("state=", "state=foreign"))
            .err(),
        Some(AuthError::StateMismatch)
    );
    assert_eq!(a.word.load(Ordering::SeqCst), before);
    let operation = auth.operation().unwrap();
    assert_eq!(auth.callback(&callback).err(), Some(AuthError::Busy));
    assert!(auth.state.try_lock().unwrap().pending.is_some());
    drop(operation);
    assert_eq!(auth.callback(&callback).err(), Some(AuthError::Expired));
    assert_eq!(
        auth.callback(&callback).err(),
        Some(AuthError::StateMismatch)
    );
    assert!(auth.state.try_lock().unwrap().pending.is_none());
    assert_eq!(auth.status().unwrap().state, ConnectionState::Expired);
    assert_eq!(p.exchanges.load(Ordering::SeqCst), 0);
    assert_eq!(s.puts.load(Ordering::SeqCst), 0);
}

use crate::callback::CallbackHandler;
#[test]
fn sunday_gate_some_receiver_retries_busy_then_accepts_once() {
    let (auth, _, _, p) = rig();
    let callback = pending(&auth);
    let handler: &dyn CallbackHandler = &auth;
    let operation = auth.operation().unwrap();
    let error = handler.accept(&callback).unwrap_err();
    assert_eq!(error, AuthError::Busy);
    assert!(handler.retry_after(&error));
    assert!(auth.state.try_lock().unwrap().pending.is_some());
    drop(operation);
    handler.accept(&callback).unwrap();
    assert_eq!(
        handler.accept(&callback).err(),
        Some(AuthError::StateMismatch)
    );
    assert!(!handler.waiting());
    assert_eq!(p.exchanges.load(Ordering::SeqCst), 2);
}
#[test]
fn sunday_gate_some_receiver_waiting_is_nonblocking_during_state_contention() {
    let (auth, _, _, _) = rig();
    let _callback = pending(&auth);
    std::thread::scope(|scope| {
        let state = auth.state.lock().unwrap();
        let (sent, received) = mpsc::sync_channel(1);
        let auth_ref = &auth;
        let worker = scope.spawn(move || {
            sent.send(CallbackHandler::waiting(auth_ref)).unwrap();
        });
        let result = received.recv_timeout(Duration::from_secs(3));
        drop(state);
        worker.join().unwrap();
        assert_eq!(result, Ok(true));
    });
    let state = auth.state.lock().unwrap();
    assert_eq!(
        auth.callback("invalid").err(),
        Some(AuthError::InvalidCallback)
    );
    assert!(CallbackHandler::retry_after(&auth, &AuthError::Busy));
    drop(state);
}
#[test]
fn sunday_gate_default_handler_and_none_keep_historical_retry_policy() {
    struct Legacy;
    impl CallbackHandler for Legacy {
        fn waiting(&self) -> bool {
            true
        }
        fn accept(&self, _: &str) -> Result<(), AuthError> {
            Ok(())
        }
        fn cancel(&self) {}
    }
    let none = AuthController::new(
        binding(),
        Arc::new(GateStore::default()),
        Arc::new(GateProvider::default()),
        Arc::new(|| 0),
    )
    .unwrap();
    for error in [
        AuthError::StateMismatch,
        AuthError::InvalidCallback,
        AuthError::Busy,
        AuthError::Expired,
        AuthError::Cancelled,
        AuthError::ProviderFailure,
    ] {
        let expected = matches!(error, AuthError::StateMismatch | AuthError::InvalidCallback);
        assert_eq!(CallbackHandler::retry_after(&Legacy, &error), expected);
        assert_eq!(CallbackHandler::retry_after(&none, &error), expected);
    }
}

#[test]
fn sunday_gate_foreign_and_withdrawn_scope_never_retires_a_newer_attachment() {
    let a = SundayAuthority::new().unwrap();
    let old = a.attach().unwrap();
    a.withdraw(&old);
    let current = a.attach().unwrap();
    let foreign = SundayAuthority::new().unwrap();
    let foreign_scope = foreign.attach().unwrap();
    assert_eq!(
        a.word.load(Ordering::SeqCst),
        foreign.word.load(Ordering::SeqCst)
    );
    let before = a.word.load(Ordering::SeqCst);
    let held = a.publication().unwrap();
    for scope in [&old, &foreign_scope] {
        assert_eq!(
            a.retire_controller(scope, RetireReason::AuthorityChanged)
                .err(),
            Some(SundayRefusal::ControllerMismatch)
        );
        assert_eq!(a.word.load(Ordering::SeqCst), before);
    }
    drop(held);
    a.retire_controller(&current, RetireReason::AuthorityChanged)
        .unwrap();
}
#[test]
fn sunday_gate_equal_binding_foreign_controller_cancel_cannot_broaden() {
    let (_, a, _, _) = rig();
    let (mut other, _, s, p) = rig();
    other.sunday.as_mut().unwrap().0 = a.clone();
    let before = a.word.load(Ordering::SeqCst);
    let gets = s.gets.load(Ordering::SeqCst);
    let organizations = p.organizations.load(Ordering::SeqCst);
    let held = a.publication().unwrap();
    assert_eq!(other.disconnect().err(), Some(AuthError::Busy));
    other.cancel();
    assert_eq!(a.word.load(Ordering::SeqCst), before);
    drop(held);
    assert_eq!(s.gets.load(Ordering::SeqCst), gets);
    assert_eq!(p.organizations.load(Ordering::SeqCst), organizations);
    assert_eq!(s.deletes.load(Ordering::SeqCst), 0);
}
#[test]
fn sunday_gate_cancel_latches_legacy_and_word_before_state_even_on_overflow() {
    for overflow in [false, true] {
        let (auth, a, _, _) = rig();
        if overflow {
            a.word.store(RETIRED | crate::sunday::REV, Ordering::SeqCst);
        }
        let generation = auth.generation.load(Ordering::SeqCst);
        std::thread::scope(|scope| {
            let state = auth.state.lock().unwrap();
            let held = a.publication().unwrap();
            let worker = scope.spawn(|| auth.cancel());
            let until = std::time::Instant::now() + Duration::from_secs(3);
            while a.word.load(Ordering::SeqCst) & crate::sunday::CANCEL == 0
                && std::time::Instant::now() < until
            {
                std::thread::yield_now();
            }
            // Capture the observations while State is held, then release and join BEFORE assertions.
            let word = a.word.load(Ordering::SeqCst);
            while auth.generation.load(Ordering::SeqCst) == generation
                && std::time::Instant::now() < until
            {
                std::thread::yield_now();
            }
            let legacy = auth.cancelled.load(Ordering::SeqCst);
            let next_generation = auth.generation.load(Ordering::SeqCst);
            drop(held);
            drop(state);
            worker.join().unwrap();
            assert_ne!(word & crate::sunday::CANCEL, 0);
            assert_ne!(word & RETIRED, 0);
            assert!(legacy);
            assert_eq!(next_generation, generation + 1);
            if overflow {
                assert_ne!(word & crate::sunday::POISON, 0);
            }
        });
    }
}
#[test]
fn sunday_gate_preput_contention_retires_and_refuses_without_io() {
    let (auth, a, s, p) = rig();
    let callback = pending(&auth);
    let puts = s.puts.load(Ordering::SeqCst);
    let calls = p.exchanges.load(Ordering::SeqCst);
    let held = a.publication().unwrap();
    assert_eq!(auth.callback(&callback).err(), Some(AuthError::Busy));
    assert_ne!(a.word.load(Ordering::SeqCst) & RETIRED, 0);
    assert_eq!(s.puts.load(Ordering::SeqCst), puts);
    assert_eq!(p.exchanges.load(Ordering::SeqCst), calls);
    assert_eq!(s.deletes.load(Ordering::SeqCst), 0);
    drop(held);
}
#[test]
fn sunday_gate_constructor_failure_withdraws_only_own_scope_and_allows_retry() {
    let a = Arc::new(SundayAuthority::new().unwrap());
    let s = Arc::new(GateStore::default());
    *s.get_reply.lock().unwrap() = Some(Err(StoreError::Denied));
    let build = || {
        AuthController::new_with_sunday_authority(
            binding(),
            s.clone(),
            Arc::new(GateProvider::default()),
            Arc::new(|| 0),
            a.clone(),
        )
    };
    assert_eq!(build().err(), Some(AuthError::Store(StoreError::Denied)));
    let auth = build().unwrap();
    assert_eq!(auth.status().unwrap().state, ConnectionState::Disconnected);
    assert_eq!(s.gets.load(Ordering::SeqCst), 2);
    assert_eq!(build().err(), Some(AuthError::Busy));
    assert_eq!(s.gets.load(Ordering::SeqCst), 2);
    assert!(!a.fixture_has_receipt());
}
struct NoPage;
impl crate::source::SourceHttp for NoPage {
    fn read(
        &self,
        _: &crate::source::SourceRequest,
        _: &str,
    ) -> Result<crate::source::SourcePage, crate::source::SourceError> {
        panic!("retired/cancelled receipt must not reach source");
    }
}
fn request() -> crate::source::SourceRequest {
    crate::source::parse_request(br#"{"version":1,"workspace":"fictional-workspace","organization":"1001","client_id":"fictional-client","service_type_id":"10","plan_id":"20","collection":"needed_positions","per_page":100,"offset":0}"#).unwrap()
}
#[test]
fn sunday_gate_failed_arm_restores_target_receipt_but_never_a_page_grant() {
    let (auth, a, s, _) = rig();
    let previous = a.fixture_receipt();
    let controller = &auth.sunday.as_ref().unwrap().1;
    let tag = a
        .retire_controller(controller, RetireReason::AuthorityChanged)
        .unwrap();
    a.fixture_refuse_arm();
    assert_eq!(
        a.publish(
            controller,
            &tag,
            VerifiedCredentialReceipt::new(
                controller,
                ("fictional-workspace", "1001", "fictional-client"),
                b"fictional-unpublished"
            )
        )
        .err(),
        Some(SundayRefusal::Retired)
    );
    assert!(previous.same_cell(&a.fixture_receipt()));
    assert_ne!(a.word.load(Ordering::SeqCst) & RETIRED, 0);
    let r = request();
    let permit = crate::sunday_read::SundayPagePermit::fixture(a.clone(), &r);
    let gets = s.gets.load(Ordering::SeqCst);
    assert_eq!(
        auth.read_sunday_page_using(permit, &r, &NoPage).err(),
        Some(crate::sunday_read::SundayReadFailure::Refused(
            SundayRefusal::Retired
        ))
    );
    assert_eq!(s.gets.load(Ordering::SeqCst), gets);
}
#[test]
fn sunday_gate_prepare_save_arm_preserve_sticky_attempt_cause_and_cancel() {
    let (auth, a, s, _) = rig();
    let sticky = (126 << 40) | (10 << 47) | (5 << 51) | crate::sunday::CANCEL;
    a.word.store(RETIRED | sticky | 17, Ordering::SeqCst);
    let callback = pending(&auth);
    assert_eq!(
        a.word.load(Ordering::SeqCst) & !crate::sunday::REV & !RETIRED,
        sticky
    );
    auth.callback(&callback).unwrap();
    assert_eq!(
        a.word.load(Ordering::SeqCst) & !crate::sunday::REV & !RETIRED,
        sticky
    );
    let r = request();
    let permit = crate::sunday_read::SundayPagePermit::fixture(a.clone(), &r);
    let gets = s.gets.load(Ordering::SeqCst);
    assert_eq!(
        auth.read_sunday_page_using(permit, &r, &NoPage).err(),
        Some(crate::sunday_read::SundayReadFailure::Refused(
            SundayRefusal::Cancelled
        ))
    );
    assert_eq!(s.gets.load(Ordering::SeqCst), gets);
}

fn root_review_clock_auth() -> (
    Arc<AuthController>,
    Arc<SundayAuthority>,
    Arc<GateStore>,
    Arc<AtomicU64>,
) {
    let authority = Arc::new(SundayAuthority::new().unwrap());
    let store = Arc::new(GateStore::default());
    let clock = Arc::new(AtomicU64::new(0));
    let read_clock = clock.clone();
    let auth = AuthController::new_with_sunday_authority(
        binding(),
        store.clone(),
        Arc::new(GateProvider::default()),
        Arc::new(move || read_clock.load(Ordering::SeqCst)),
        authority.clone(),
    )
    .unwrap();
    (Arc::new(auth), authority, store, clock)
}
fn root_review_permanent_refusal(word: u64) {
    let (auth, authority, store, _) = root_review_clock_auth();
    let callback = pending(&auth);
    authority.word.store(word, Ordering::SeqCst);
    let result = auth.callback(&callback);
    assert_eq!(result.err(), Some(AuthError::Cancelled));
    assert!(!CallbackHandler::retry_after(
        auth.as_ref(),
        &AuthError::Cancelled
    ));
    assert_eq!(store.puts.load(Ordering::SeqCst), 0);
}
#[test]
fn sunday_gate_root_review_exhausted_refusal_is_not_retryable_busy() {
    root_review_permanent_refusal(RETIRED | crate::sunday::REV);
}
#[test]
fn sunday_gate_root_review_poisoned_refusal_is_not_retryable_busy() {
    root_review_permanent_refusal(RETIRED | crate::sunday::POISON);
}
#[test]
fn sunday_gate_root_review_invalid_word_is_not_retryable_busy() {
    root_review_permanent_refusal(1 << 63);
}
#[test]
fn sunday_gate_root_review_silent_expiry_consumes_pending_and_stops_waiting() {
    let (auth, _, store, clock) = root_review_clock_auth();
    let callback = pending(&auth);
    clock.store(ATTEMPT_LIFETIME_MS - 1, Ordering::SeqCst);
    assert!(CallbackHandler::waiting(auth.as_ref()));
    clock.store(ATTEMPT_LIFETIME_MS, Ordering::SeqCst);
    assert!(!CallbackHandler::waiting(auth.as_ref()));
    assert!(auth.state.try_lock().unwrap().pending.is_none());
    assert_eq!(auth.status().unwrap().state, ConnectionState::Expired);
    assert_eq!(
        auth.callback(&callback).err(),
        Some(AuthError::StateMismatch)
    );
    assert_eq!(store.puts.load(Ordering::SeqCst), 0);
}
#[test]
fn sunday_gate_root_review_contended_withdraw_allows_retry_but_never_stale_retire() {
    let authority = SundayAuthority::new().unwrap();
    let failed = authority.attach().unwrap();
    let held = authority.publication().unwrap();
    authority.withdraw(&failed);
    drop(held);
    let replacement = authority
        .attach()
        .expect("failed constructor must relinquish even under contention");
    let before = authority.word.load(Ordering::SeqCst);
    assert_eq!(
        authority
            .retire_controller(&failed, RetireReason::AuthorityChanged)
            .err(),
        Some(SundayRefusal::ControllerMismatch)
    );
    assert_eq!(authority.word.load(Ordering::SeqCst), before);
    authority
        .retire_controller(&replacement, RetireReason::AuthorityChanged)
        .unwrap();
    assert_eq!(
        authority.attach().err(),
        Some(SundayRefusal::ControllerMismatch)
    );
}
#[test]
fn sunday_gate_root_review_expired_after_put_retains_unchecked_record_without_delete() {
    let (auth, authority, store, clock) = root_review_clock_auth();
    let callback = pending(&auth);
    let (entered, observed) = mpsc::sync_channel(1);
    let (release, wait) = mpsc::sync_channel(1);
    *store.put_gate.lock().unwrap() = Some(Arc::new(PutGate {
        entered,
        release: Mutex::new(wait),
    }));
    let writer = auth.clone();
    let job = GateJob {
        release: Some(release),
        worker: Some(std::thread::spawn(move || writer.callback(&callback))),
    };
    observed.recv_timeout(Duration::from_secs(3)).unwrap();
    clock.store(ATTEMPT_LIFETIME_MS, Ordering::SeqCst);
    assert_eq!(job.finish().err(), Some(AuthError::Expired));
    assert!(store.bytes.lock().unwrap().is_some());
    assert_eq!(store.deletes.load(Ordering::SeqCst), 0);
    let status = auth.status().unwrap();
    assert_eq!(status.state, ConnectionState::StoredUnchecked);
    assert_eq!(status.checked_at_ms, None);
    assert_eq!(status.problem, Some(AuthError::Expired));
    assert_ne!(authority.word.load(Ordering::SeqCst) & RETIRED, 0);
}

fn root_review_clock_lock_rig() -> (Arc<AuthController>, Arc<AtomicBool>, Arc<AtomicBool>) {
    let holder = Arc::new(Mutex::new(None::<std::sync::Weak<AuthController>>));
    let observed = Arc::new(AtomicBool::new(false));
    let unlocked = Arc::new(AtomicBool::new(false));
    let h = holder.clone();
    let called = observed.clone();
    let free = unlocked.clone();
    let auth = Arc::new(
        AuthController::new_with_sunday_authority(
            binding(),
            Arc::new(GateStore::default()),
            Arc::new(GateProvider::default()),
            Arc::new(move || {
                if let Some(auth) = h.lock().unwrap().as_ref().and_then(|weak| weak.upgrade()) {
                    called.store(true, Ordering::SeqCst);
                    free.store(auth.state.try_lock().is_ok(), Ordering::SeqCst);
                }
                0
            }),
            Arc::new(SundayAuthority::new().unwrap()),
        )
        .unwrap(),
    );
    *holder.lock().unwrap() = Some(Arc::downgrade(&auth));
    let _callback = pending(&auth);
    observed.store(false, Ordering::SeqCst);
    unlocked.store(false, Ordering::SeqCst);
    (auth, observed, unlocked)
}
#[test]
fn sunday_gate_root_review_expiry_clock_runs_outside_state_guard() {
    let (auth, called, unlocked) = root_review_clock_lock_rig();
    assert!(CallbackHandler::waiting(auth.as_ref()));
    assert!(called.load(Ordering::SeqCst));
    assert!(unlocked.load(Ordering::SeqCst));
}
#[test]
fn sunday_gate_root_review_contended_waiting_never_calls_clock() {
    let (auth, called, _) = root_review_clock_lock_rig();
    let state = auth.state.lock().unwrap();
    assert!(CallbackHandler::waiting(auth.as_ref()));
    assert!(!called.load(Ordering::SeqCst));
    drop(state);
}
#[test]
fn sunday_gate_root_review_actual_constructor_failure_releases_contended_reservation() {
    struct FailOnce {
        first: AtomicBool,
        entered: mpsc::SyncSender<()>,
        release: Mutex<mpsc::Receiver<()>>,
    }
    impl CredentialStore for FailOnce {
        fn get(&self, _: &str, _: &str) -> Result<Option<Vec<u8>>, StoreError> {
            if self.first.swap(false, Ordering::SeqCst) {
                self.entered.send(()).unwrap();
                self.release.lock().unwrap().recv().unwrap();
                Err(StoreError::Denied)
            } else {
                Ok(None)
            }
        }
        fn put(&self, _: &str, _: &str, _: &[u8]) -> Result<(), StoreError> {
            panic!("constructor must not put")
        }
        fn delete(&self, _: &str, _: &str) -> Result<(), StoreError> {
            panic!("constructor must not delete")
        }
    }
    let authority = Arc::new(SundayAuthority::new().unwrap());
    let (entered, observed) = mpsc::sync_channel(1);
    let (release, wait) = mpsc::sync_channel(1);
    let store = Arc::new(FailOnce {
        first: AtomicBool::new(true),
        entered,
        release: Mutex::new(wait),
    });
    let (done, finished) = mpsc::sync_channel(1);
    let a = authority.clone();
    let s = store.clone();
    let mut job = GateJob {
        release: Some(release),
        worker: Some(std::thread::spawn(move || {
            let result = AuthController::new_with_sunday_authority(
                binding(),
                s,
                Arc::new(GateProvider::default()),
                Arc::new(|| 0),
                a,
            )
            .and_then(|auth| auth.status());
            let _ = done.send(result.clone());
            result
        })),
    };
    observed.recv_timeout(Duration::from_secs(3)).unwrap();
    let held = authority.publication().unwrap();
    job.release.take().unwrap().send(()).unwrap();
    let outcome = finished.recv_timeout(Duration::from_secs(3));
    drop(held);
    job.worker.take().unwrap().join().unwrap().unwrap_err();
    assert_eq!(
        outcome.unwrap().err(),
        Some(AuthError::Store(StoreError::Denied))
    );
    let auth = AuthController::new_with_sunday_authority(
        binding(),
        store.clone(),
        Arc::new(GateProvider::default()),
        Arc::new(|| 0),
        authority.clone(),
    )
    .expect("real failed constructor must allow retry");
    drop(auth);
    assert_eq!(
        AuthController::new_with_sunday_authority(
            binding(),
            store,
            Arc::new(GateProvider::default()),
            Arc::new(|| 0),
            authority,
        )
        .err(),
        Some(AuthError::Busy),
        "a successful controller is never replaceable even after drop"
    );
}

#[test]
fn sunday_gate_root_review_poisoned_publication_is_permanent_not_contention() {
    let (auth, authority, _, _) = root_review_clock_auth();
    let callback = pending(&auth);
    let a = authority.clone();
    let poisoned = std::thread::spawn(move || {
        let _held = a.publication().unwrap();
        panic!("fictional publication poison control");
    });
    assert!(poisoned.join().is_err());
    assert_eq!(authority.publication().err(), Some(SundayRefusal::Poisoned));
    assert_eq!(auth.callback(&callback).err(), Some(AuthError::Cancelled));
    assert!(!CallbackHandler::retry_after(
        auth.as_ref(),
        &AuthError::Cancelled
    ));
}

struct TruthStore {
    bytes: Mutex<Option<Vec<u8>>>,
    put_gate: Mutex<Option<Arc<PutGate>>>,
    clock: Arc<AtomicU64>,
    deletes: AtomicUsize,
}
impl CredentialStore for TruthStore {
    fn get(&self, _: &str, _: &str) -> Result<Option<Vec<u8>>, StoreError> {
        Ok(self.bytes.lock().unwrap().clone())
    }
    fn put(&self, _: &str, _: &str, bytes: &[u8]) -> Result<(), StoreError> {
        *self.bytes.lock().unwrap() = Some(bytes.to_vec());
        let gate = self.put_gate.lock().unwrap().clone();
        if let Some(gate) = gate {
            gate.entered.send(()).unwrap();
            gate.release.lock().unwrap().recv().unwrap();
        }
        Ok(())
    }
    fn delete(&self, _: &str, _: &str) -> Result<(), StoreError> {
        self.deletes.fetch_add(1, Ordering::SeqCst);
        *self.bytes.lock().unwrap() = None;
        self.clock.store(ATTEMPT_LIFETIME_MS, Ordering::SeqCst);
        Ok(())
    }
}

#[test]
fn sunday_gate_truth_permanent_refusal_closes_only_matching_pending_without_cancel_bits() {
    for word in [
        RETIRED | crate::sunday::POISON,
        RETIRED | crate::sunday::REV,
        1u64 << 63,
    ] {
        let (auth, authority, store, _) = root_review_clock_auth();
        let callback = pending(&auth);
        authority.word.store(word, Ordering::SeqCst);
        assert_eq!(auth.callback(&callback).err(), Some(AuthError::Cancelled));
        assert!(auth.state.try_lock().unwrap().pending.is_none());
        assert!(!CallbackHandler::waiting(auth.as_ref()));
        let status = auth.status().unwrap();
        assert_eq!(status.state, ConnectionState::Cancelled);
        assert_eq!(status.problem, Some(AuthError::Cancelled));
        assert_eq!(status.checked_at_ms, None);
        assert_eq!(status.organization_diagnostic, None);
        assert_eq!(store.puts.load(Ordering::SeqCst), 0);
        assert_eq!(store.deletes.load(Ordering::SeqCst), 0);
        assert_eq!(
            authority.word.load(Ordering::SeqCst) & crate::sunday::CANCEL,
            0
        );
        assert_eq!((authority.word.load(Ordering::SeqCst) >> 51) & 15, 0);
        assert_eq!(
            auth.callback(&callback).err(),
            Some(AuthError::StateMismatch)
        );
    }
}

fn root_truth_compensation(expire_before_release: bool) {
    let clock = Arc::new(AtomicU64::new(0));
    let store = Arc::new(TruthStore {
        bytes: Mutex::new(None),
        put_gate: Mutex::new(None),
        clock: clock.clone(),
        deletes: AtomicUsize::new(0),
    });
    let authority = Arc::new(SundayAuthority::new().unwrap());
    let read_clock = clock.clone();
    let auth = Arc::new(
        AuthController::new_with_sunday_authority(
            binding(),
            store.clone(),
            Arc::new(GateProvider::default()),
            Arc::new(move || read_clock.load(Ordering::SeqCst)),
            authority.clone(),
        )
        .unwrap(),
    );
    let callback = pending(&auth);
    let (entered, observed) = mpsc::sync_channel(1);
    let (release, wait) = mpsc::sync_channel(1);
    *store.put_gate.lock().unwrap() = Some(Arc::new(PutGate {
        entered,
        release: Mutex::new(wait),
    }));
    let writer = auth.clone();
    let job = GateJob {
        release: Some(release),
        worker: Some(std::thread::spawn(move || writer.callback(&callback))),
    };
    observed.recv_timeout(Duration::from_secs(3)).unwrap();
    authority.retire(RetireReason::AuthorityChanged).unwrap();
    if expire_before_release {
        clock.store(ATTEMPT_LIFETIME_MS, Ordering::SeqCst);
    }
    let result = job.finish();
    let status = auth.status().unwrap();
    assert_eq!(result.err(), Some(AuthError::Cancelled));
    assert_eq!(store.deletes.load(Ordering::SeqCst), 1);
    assert!(store.bytes.lock().unwrap().is_none());
    assert!(auth.state.try_lock().unwrap().unchecked_save.is_none());
    assert_eq!(status.state, ConnectionState::Cancelled);
    assert_eq!(status.problem, Some(AuthError::Cancelled));
    assert_eq!(status.checked_at_ms, None);
}
#[test]
fn sunday_gate_truth_retirement_wins_over_simultaneous_expiry_for_exact_cleanup() {
    root_truth_compensation(true);
}
#[test]
fn sunday_gate_truth_confirmed_delete_clears_unchecked_even_when_delete_crosses_expiry() {
    root_truth_compensation(false);
}

// Independent boundary pins added after both 8644 readers relinquished.
fn sunday_truth_held_put(
    auth: &Arc<AuthController>,
    store: &GateStore,
    callback: String,
) -> (GateJob, mpsc::Receiver<()>) {
    let (entered, observed) = mpsc::sync_channel(1);
    let (release, wait) = mpsc::sync_channel(1);
    *store.put_gate.lock().unwrap() = Some(Arc::new(PutGate {
        entered,
        release: Mutex::new(wait),
    }));
    let writer = auth.clone();
    (
        GateJob {
            release: Some(release),
            worker: Some(std::thread::spawn(move || writer.callback(&callback))),
        },
        observed,
    )
}

#[test]
fn sunday_truth_expired_and_poisoned_is_not_retirement_evidence() {
    let (auth, authority, store, clock) = root_review_clock_auth();
    let callback = pending(&auth);
    let (job, observed) = sunday_truth_held_put(&auth, &store, callback);
    observed.recv_timeout(Duration::from_secs(3)).unwrap();
    authority
        .word
        .fetch_or(crate::sunday::POISON, Ordering::SeqCst);
    clock.store(ATTEMPT_LIFETIME_MS, Ordering::SeqCst);
    let result = job.finish();
    let status = auth.status().unwrap();
    println!(
        "PROBE expired+poison result={:?} deletes={} bytes_kept={} state={:?} problem={:?}",
        result.as_ref().err(),
        store.deletes.load(Ordering::SeqCst),
        store.bytes.lock().unwrap().is_some(),
        status.state,
        status.problem
    );
    assert_eq!(result.err(), Some(AuthError::Expired));
    assert_eq!(store.deletes.load(Ordering::SeqCst), 0);
    assert!(store.bytes.lock().unwrap().is_some());
    assert_eq!(status.state, ConnectionState::StoredUnchecked);
    assert!(auth.state.try_lock().unwrap().unchecked_save.is_some());
    assert_eq!(status.problem, Some(AuthError::Expired));
}

#[test]
fn sunday_truth_retired_and_expired_with_newer_bytes_never_deletes_and_keeps_marker() {
    let (auth, authority, store, clock) = root_review_clock_auth();
    let callback = pending(&auth);
    let (job, observed) = sunday_truth_held_put(&auth, &store, callback);
    observed.recv_timeout(Duration::from_secs(3)).unwrap();
    *store.bytes.lock().unwrap() = Some(b"fictional-newer-record".to_vec());
    authority.retire(RetireReason::AuthorityChanged).unwrap();
    clock.store(ATTEMPT_LIFETIME_MS, Ordering::SeqCst);
    let result = job.finish();
    let status = auth.status().unwrap();
    println!(
        "PROBE retired+expired+mismatch result={:?} deletes={} bytes_newer_kept={} state={:?} problem={:?}",
        result.as_ref().err(),
        store.deletes.load(Ordering::SeqCst),
        store.bytes.lock().unwrap().as_deref() == Some(b"fictional-newer-record".as_slice()),
        status.state,
        status.problem
    );
    assert_eq!(result.err(), Some(AuthError::Cancelled));
    assert_eq!(store.deletes.load(Ordering::SeqCst), 0);
    assert_eq!(
        store.bytes.lock().unwrap().as_deref(),
        Some(b"fictional-newer-record".as_slice())
    );
    assert_eq!(status.state, ConnectionState::StoredUnchecked);
    assert!(auth.state.try_lock().unwrap().unchecked_save.is_some());
}

#[test]
fn sunday_truth_failed_delete_after_retirement_keeps_unchecked_marker() {
    let (auth, authority, store, _) = root_review_clock_auth();
    let callback = pending(&auth);
    let (job, observed) = sunday_truth_held_put(&auth, &store, callback);
    observed.recv_timeout(Duration::from_secs(3)).unwrap();
    *store.delete_error.lock().unwrap() = Some(StoreError::Denied);
    authority.retire(RetireReason::AuthorityChanged).unwrap();
    let result = job.finish();
    let status = auth.status().unwrap();
    println!(
        "PROBE failed-delete result={:?} deletes={} bytes_kept={} state={:?} problem={:?}",
        result.as_ref().err(),
        store.deletes.load(Ordering::SeqCst),
        store.bytes.lock().unwrap().is_some(),
        status.state,
        status.problem
    );
    assert_eq!(result.err(), Some(AuthError::Cancelled));
    assert_eq!(store.deletes.load(Ordering::SeqCst), 1);
    assert!(store.bytes.lock().unwrap().is_some());
    assert_eq!(status.state, ConnectionState::StoredUnchecked);
    assert!(auth.state.try_lock().unwrap().unchecked_save.is_some());
}

struct PoisonOnDeleteStore {
    inner: GateStore,
    authority: Mutex<Option<Arc<SundayAuthority>>>,
}
impl CredentialStore for PoisonOnDeleteStore {
    fn get(&self, a: &str, b: &str) -> Result<Option<Vec<u8>>, StoreError> {
        self.inner.get(a, b)
    }
    fn put(&self, a: &str, b: &str, bytes: &[u8]) -> Result<(), StoreError> {
        self.inner.put(a, b, bytes)
    }
    fn delete(&self, a: &str, b: &str) -> Result<(), StoreError> {
        let result = self.inner.delete(a, b);
        if let Some(authority) = self.authority.lock().unwrap().as_ref() {
            authority
                .word
                .fetch_or(crate::sunday::POISON, Ordering::SeqCst);
        }
        result
    }
}

#[test]
fn sunday_truth_confirmed_delete_clears_marker_even_if_poison_arrives_during_delete() {
    let authority = Arc::new(SundayAuthority::new().unwrap());
    let store = Arc::new(PoisonOnDeleteStore {
        inner: GateStore::default(),
        authority: Mutex::new(None),
    });
    let auth = Arc::new(
        AuthController::new_with_sunday_authority(
            binding(),
            store.clone(),
            Arc::new(GateProvider::default()),
            Arc::new(|| 0),
            authority.clone(),
        )
        .unwrap(),
    );
    let callback = pending(&auth);
    let (job, observed) = sunday_truth_held_put(&auth, &store.inner, callback);
    observed.recv_timeout(Duration::from_secs(3)).unwrap();
    authority.retire(RetireReason::AuthorityChanged).unwrap();
    *store.authority.lock().unwrap() = Some(authority.clone());
    let result = job.finish();
    let status = auth.status().unwrap();
    println!(
        "PROBE poison-during-delete result={:?} deletes={} bytes_kept={} marker={:?} state={:?} problem={:?}",
        result.as_ref().err(),
        store.inner.deletes.load(Ordering::SeqCst),
        store.inner.bytes.lock().unwrap().is_some(),
        auth.state.try_lock().unwrap().unchecked_save,
        status.state,
        status.problem
    );
    assert_eq!(result.err(), Some(AuthError::Cancelled));
    assert_eq!(store.inner.deletes.load(Ordering::SeqCst), 1);
    assert!(store.inner.bytes.lock().unwrap().is_none());
    assert!(auth.state.try_lock().unwrap().unchecked_save.is_none());
    assert_eq!(status.state, ConnectionState::Cancelled);
}
struct TruthRetiringProvider {
    authority: Arc<SundayAuthority>,
    clock: Arc<AtomicU64>,
}
impl Provider for TruthRetiringProvider {
    fn exchange(&self, _: &str, _: &str, _: &str) -> Result<Tokens, AuthError> {
        self.authority
            .retire(RetireReason::AuthorityChanged)
            .unwrap();
        self.clock.store(ATTEMPT_LIFETIME_MS, Ordering::SeqCst);
        Ok(Tokens {
            access_token: "fictional-probe-access".into(),
            refresh_token: Some("fictional-probe-refresh".into()),
            token_type: "bearer".into(),
            expires_in: 7200,
        })
    }
    fn organization(&self, _: &str) -> Result<String, AuthError> {
        Ok("1001".into())
    }
    fn refresh(&self, _: &str, _: &str) -> Result<Tokens, AuthError> {
        panic!("probe must not refresh")
    }
    fn revoke(&self, _: &str, _: &str, _: &str) -> Result<(), AuthError> {
        panic!("probe must not revoke")
    }
}
#[test]
fn sunday_truth_p2_retired_and_expired_after_exchange() {
    let authority = Arc::new(SundayAuthority::new().unwrap());
    let clock = Arc::new(AtomicU64::new(0));
    let store = Arc::new(GateStore::default());
    let c = clock.clone();
    let auth = AuthController::new_with_sunday_authority(
        binding(),
        store.clone(),
        Arc::new(TruthRetiringProvider {
            authority: authority.clone(),
            clock: clock.clone(),
        }),
        Arc::new(move || c.load(Ordering::SeqCst)),
        authority.clone(),
    )
    .unwrap();
    let callback = pending(&auth);
    let result = auth.callback(&callback);
    let status = auth.status().unwrap();
    assert_eq!(result.err(), Some(AuthError::Cancelled));
    assert_eq!(store.puts.load(Ordering::SeqCst), 0);
    assert_eq!(store.deletes.load(Ordering::SeqCst), 0);
    assert_eq!(status.state, ConnectionState::Cancelled);
    assert_eq!(status.problem, Some(AuthError::Cancelled));
}
