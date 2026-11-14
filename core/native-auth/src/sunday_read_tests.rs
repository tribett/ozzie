use super::*;
use crate::sunday::SundayAuthority;
use std::sync::atomic::AtomicUsize;
#[derive(Default)]
struct Store {
    gets: AtomicUsize,
    puts: AtomicUsize,
    deletes: AtomicUsize,
    put_gate: Mutex<Option<Arc<Gate>>>,
    put_error: Mutex<Option<StoreError>>,
    bytes: Mutex<Option<Vec<u8>>>,
    script: Mutex<std::collections::VecDeque<Result<Option<Vec<u8>>, StoreError>>>,
    get_gate: Mutex<Option<(usize, Arc<Gate>)>>,
}
impl CredentialStore for Store {
    fn get(&self, _: &str, _: &str) -> Result<Option<Vec<u8>>, StoreError> {
        let n = self.gets.fetch_add(1, Ordering::SeqCst) + 1;
        let gate = self.get_gate.lock().unwrap().clone();
        if let Some((at, gate)) = gate
            && n == at
        {
            gate.wait();
        }
        if let Some(value) = self.script.lock().unwrap().pop_front() {
            return value;
        }
        Ok(self.bytes.lock().unwrap().clone())
    }
    fn put(&self, _: &str, _: &str, b: &[u8]) -> Result<(), StoreError> {
        self.puts.fetch_add(1, Ordering::SeqCst);
        *self.bytes.lock().unwrap() = Some(b.to_vec());
        let gate = self.put_gate.lock().unwrap().clone();
        if let Some(gate) = gate {
            gate.wait();
        }
        if let Some(error) = *self.put_error.lock().unwrap() {
            return Err(error);
        }
        Ok(())
    }
    fn delete(&self, _: &str, _: &str) -> Result<(), StoreError> {
        self.deletes.fetch_add(1, Ordering::SeqCst);
        *self.bytes.lock().unwrap() = None;
        Ok(())
    }
}
struct FakeProvider;
impl Provider for FakeProvider {
    fn exchange(&self, _: &str, _: &str, _: &str) -> Result<Tokens, AuthError> {
        Ok(Tokens {
            access_token: "fictional-access".into(),
            refresh_token: Some("fictional-refresh".into()),
            token_type: "bearer".into(),
            expires_in: 7200,
        })
    }
    fn organization(&self, _: &str) -> Result<String, AuthError> {
        Ok("1001".into())
    }
    fn refresh(&self, _: &str, _: &str) -> Result<Tokens, AuthError> {
        panic!("unexpected refresh")
    }
    fn revoke(&self, _: &str, _: &str, _: &str) -> Result<(), AuthError> {
        panic!("unexpected revoke")
    }
}
fn binding() -> Binding {
    Binding {
        workspace: "fictional-workspace".into(),
        organization: "1001".into(),
        client_id: "fictional-client".into(),
    }
}
#[test]
fn sunday_attachment_accepts_one_controller_and_refuses_replacement_before_store() {
    let a = Arc::new(SundayAuthority::new().unwrap());
    let store = Arc::new(Store::default());
    let auth = AuthController::new_with_sunday_authority(
        binding(),
        store.clone(),
        Arc::new(FakeProvider),
        Arc::new(|| 0),
        a.clone(),
    )
    .unwrap();
    assert_eq!(auth.status().unwrap().state, ConnectionState::Disconnected);
    assert_eq!(store.gets.load(Ordering::SeqCst), 1);
    assert_eq!(
        AuthController::new_with_sunday_authority(
            binding(),
            store.clone(),
            Arc::new(FakeProvider),
            Arc::new(|| 0),
            a
        )
        .err(),
        Some(AuthError::Busy)
    );
    assert_eq!(store.gets.load(Ordering::SeqCst), 1);
}

const REQUEST: &str = r#"{"version":1,"workspace":"fictional-workspace","organization":"1001","client_id":"fictional-client","service_type_id":"10","plan_id":"20","collection":"needed_positions","per_page":100,"offset":0}"#;
struct FakeHttp(AtomicUsize);
impl crate::source::SourceHttp for FakeHttp {
    fn read(
        &self,
        r: &crate::source::SourceRequest,
        access: &str,
    ) -> Result<crate::source::SourcePage, crate::source::SourceError> {
        assert_eq!(access, "fictional-access");
        self.0.fetch_add(1, Ordering::SeqCst);
        crate::source::project_page(
            r,
            br#"{"data":[],"meta":{"count":0,"total_count":0}}"#,
            &Default::default(),
        )
    }
}
fn connect(auth: &AuthController) {
    let url = url::Url::parse(&auth.begin().unwrap()).unwrap();
    let state = url
        .query_pairs()
        .find(|(k, _)| k == "state")
        .unwrap()
        .1
        .into_owned();
    auth.callback(&format!("{REDIRECT_URI}?code=fictional-code&state={state}"))
        .unwrap();
}
#[test]
fn sunday_verified_callback_authorizes_exactly_two_raw_gets_and_one_fake_page() {
    let a = Arc::new(SundayAuthority::new().unwrap());
    let store = Arc::new(Store::default());
    let auth = AuthController::new_with_sunday_authority(
        binding(),
        store.clone(),
        Arc::new(FakeProvider),
        Arc::new(|| 0),
        a.clone(),
    )
    .unwrap();
    connect(&auth);
    let r = crate::source::parse_request(REQUEST.as_bytes()).unwrap();
    let permit = crate::sunday_read::SundayPagePermit::fixture(a, &r);
    let http = FakeHttp(AtomicUsize::new(0));
    let before = store.gets.load(Ordering::SeqCst);
    let page = auth.read_sunday_page_using(permit, &r, &http).unwrap();
    assert_eq!(
        page.envelope()["body"],
        serde_json::json!({"data":[],"meta":{"count":0,"total_count":0}})
    );
    assert_eq!(store.gets.load(Ordering::SeqCst) - before, 2);
    assert_eq!(store.puts.load(Ordering::SeqCst), 1);
    assert_eq!(http.0.load(Ordering::SeqCst), 1);
}

use crate::{
    source::{SourceError, SourceHttp, SourcePage, SourceRequest},
    sunday::{RetireReason, SundayRefusal},
    sunday_read::{SundayPagePermit, SundayReadFailure},
};
use std::{sync::mpsc, thread::JoinHandle, time::Duration};

struct Gate {
    entered: mpsc::SyncSender<()>,
    release: Mutex<mpsc::Receiver<()>>,
}
impl Gate {
    fn wait(&self) {
        self.entered.send(()).unwrap();
        self.release.lock().unwrap().recv().unwrap();
    }
}
struct Job {
    release: Option<mpsc::SyncSender<()>>,
    worker: Option<JoinHandle<Result<SourcePage, SundayReadFailure>>>,
}
impl Job {
    fn finish(mut self) -> Result<SourcePage, SundayReadFailure> {
        self.release.take().unwrap().send(()).unwrap();
        self.worker.take().unwrap().join().unwrap()
    }
}
impl Drop for Job {
    fn drop(&mut self) {
        if let Some(release) = self.release.take() {
            let _ = release.send(());
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
#[derive(Default)]
struct ReadProvider {
    calls: AtomicUsize,
    exchange_gate: Mutex<Option<Arc<Gate>>>,
    refresh_gate: Mutex<Option<Arc<Gate>>>,
    gate: Mutex<Option<Arc<Gate>>>,
    failure: Mutex<Option<AuthError>>,
}
impl Provider for ReadProvider {
    fn exchange(&self, c: &str, code: &str, v: &str) -> Result<Tokens, AuthError> {
        let gate = self.exchange_gate.lock().unwrap().clone();
        if let Some(gate) = gate {
            gate.wait();
        }
        FakeProvider.exchange(c, code, v)
    }
    fn organization(&self, _: &str) -> Result<String, AuthError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let gate = self.gate.lock().unwrap().clone();
        if let Some(gate) = gate {
            gate.wait();
        }
        if let Some(error) = self.failure.lock().unwrap().clone() {
            return Err(error);
        }
        Ok("1001".into())
    }
    fn refresh(&self, _: &str, _: &str) -> Result<Tokens, AuthError> {
        let gate = self.refresh_gate.lock().unwrap().clone();
        if let Some(gate) = gate {
            gate.wait();
            return Err(AuthError::ProviderFailure);
        }
        panic!("no source refresh")
    }
    fn revoke(&self, _: &str, _: &str, _: &str) -> Result<(), AuthError> {
        panic!("no source revoke")
    }
}
struct ReadHttp {
    calls: Arc<AtomicUsize>,
    gate: Option<Arc<Gate>>,
    failure: Option<SourceError>,
}
impl SourceHttp for ReadHttp {
    fn read(&self, r: &SourceRequest, access: &str) -> Result<SourcePage, SourceError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if let Some(gate) = &self.gate {
            gate.wait();
        }
        if let Some(error) = self.failure {
            return Err(error);
        }
        FakeHttp(AtomicUsize::new(0)).read(r, access)
    }
}
fn rig() -> (
    Arc<AuthController>,
    Arc<SundayAuthority>,
    Arc<Store>,
    Arc<ReadProvider>,
    SourceRequest,
) {
    let a = Arc::new(SundayAuthority::new().unwrap());
    let s = Arc::new(Store::default());
    let p = Arc::new(ReadProvider::default());
    let auth = Arc::new(
        AuthController::new_with_sunday_authority(
            binding(),
            s.clone(),
            p.clone(),
            Arc::new(|| 0),
            a.clone(),
        )
        .unwrap(),
    );
    connect(&auth);
    p.calls.store(0, Ordering::SeqCst);
    let r = crate::source::parse_request(REQUEST.as_bytes()).unwrap();
    (auth, a, s, p, r)
}
#[test]
fn sunday_first_and_second_store_failures_preserve_source_facts_and_stop() {
    for get in [1, 2] {
        for (value, expected) in [
            (Ok(None), SourceError::MissingCredentials),
            (Err(StoreError::Locked), SourceError::Locked),
            (Err(StoreError::Denied), SourceError::Denied),
            (Err(StoreError::Unavailable), SourceError::StoreUnavailable),
        ] {
            let (auth, a, s, p, r) = rig();
            let bytes = s.bytes.lock().unwrap().clone();
            if get == 2 {
                s.script.lock().unwrap().push_back(Ok(bytes));
            }
            s.script.lock().unwrap().push_back(value);
            let permit = SundayPagePermit::fixture(a, &r);
            let http = FakeHttp(AtomicUsize::new(0));
            let before = s.gets.load(Ordering::SeqCst);
            assert_eq!(
                auth.read_sunday_page_using(permit, &r, &http).err(),
                Some(SundayReadFailure::Source(expected))
            );
            assert_eq!(s.gets.load(Ordering::SeqCst) - before, get);
            assert_eq!(p.calls.load(Ordering::SeqCst), 0);
            assert_eq!(http.0.load(Ordering::SeqCst), 0);
            assert_eq!(s.puts.load(Ordering::SeqCst), 1);
        }
    }
}
#[test]
fn sunday_exact_first_and_second_buffer_digest_rejects_semantically_equal_reserialization() {
    for get in [1, 2] {
        let (auth, a, s, p, r) = rig();
        let bytes = s.bytes.lock().unwrap().clone().unwrap();
        let mut drift = bytes.clone();
        drift.push(b' ');
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&bytes).unwrap(),
            serde_json::from_slice::<serde_json::Value>(&drift).unwrap()
        );
        if get == 2 {
            s.script.lock().unwrap().push_back(Ok(Some(bytes)));
        }
        s.script.lock().unwrap().push_back(Ok(Some(drift)));
        let permit = SundayPagePermit::fixture(a, &r);
        let http = FakeHttp(AtomicUsize::new(0));
        let before = s.gets.load(Ordering::SeqCst);
        assert_eq!(
            auth.read_sunday_page_using(permit, &r, &http).err(),
            Some(SundayReadFailure::Refused(SundayRefusal::ReceiptMismatch))
        );
        assert_eq!(s.gets.load(Ordering::SeqCst) - before, get);
        assert_eq!(p.calls.load(Ordering::SeqCst), 0);
        assert_eq!(http.0.load(Ordering::SeqCst), 0);
    }
}
#[test]
fn sunday_retire_or_explicit_cancel_during_each_blocked_primitive_discards_late_data_and_error() {
    for step in 0..4 {
        for cancel in [false, true] {
            for late_error in [false, true] {
                let (auth, a, s, p, r) = rig();
                let permit = SundayPagePermit::fixture(a.clone(), &r);
                let (et, er) = mpsc::sync_channel(1);
                let (rt, rr) = mpsc::sync_channel(1);
                let gate = Arc::new(Gate {
                    entered: et,
                    release: Mutex::new(rr),
                });
                if step < 2 {
                    let before = s.gets.load(Ordering::SeqCst);
                    *s.get_gate.lock().unwrap() = Some((before + step + 1, gate.clone()));
                    if late_error {
                        if step == 1 {
                            s.script
                                .lock()
                                .unwrap()
                                .push_back(Ok(s.bytes.lock().unwrap().clone()));
                        }
                        s.script.lock().unwrap().push_back(Err(StoreError::Denied));
                    }
                } else if step == 2 {
                    *p.gate.lock().unwrap() = Some(gate.clone());
                    if late_error {
                        *p.failure.lock().unwrap() = Some(AuthError::ProviderFailure);
                    }
                }
                let calls = Arc::new(AtomicUsize::new(0));
                let http = ReadHttp {
                    calls: calls.clone(),
                    gate: (step == 3).then_some(gate),
                    failure: late_error.then_some(SourceError::Denied),
                };
                let worker_auth = auth.clone();
                let worker = std::thread::spawn(move || {
                    worker_auth.read_sunday_page_using(permit, &r, &http)
                });
                let job = Job {
                    release: Some(rt),
                    worker: Some(worker),
                };
                er.recv_timeout(Duration::from_secs(3)).unwrap();
                if cancel {
                    auth.cancel();
                } else {
                    a.retire(RetireReason::AuthorityChanged).unwrap();
                }
                assert_eq!(calls.load(Ordering::SeqCst), usize::from(step == 3));
                if step < 2 {
                    assert_eq!(p.calls.load(Ordering::SeqCst), 0);
                }
                assert_eq!(
                    job.finish().err(),
                    Some(SundayReadFailure::Refused(if cancel {
                        SundayRefusal::Cancelled
                    } else {
                        SundayRefusal::Retired
                    }))
                );
                assert_eq!(s.puts.load(Ordering::SeqCst), 1);
            }
        }
    }
}
#[test]
fn sunday_wrong_scope_binding_foreign_permit_and_retirement_refuse_before_store() {
    for field in [
        "workspace",
        "organization",
        "client_id",
        "service_type_id",
        "plan_id",
        "collection",
        "per_page",
        "offset",
    ] {
        let (auth, a, s, _, r) = rig();
        let permit = SundayPagePermit::fixture(a, &r);
        let mut value: serde_json::Value = serde_json::from_str(REQUEST).unwrap();
        value[field] = match field {
            "organization" | "service_type_id" | "plan_id" => serde_json::json!("999"),
            "per_page" => serde_json::json!(50),
            "offset" => serde_json::json!(100),
            "collection" => serde_json::json!("team_members"),
            _ => serde_json::json!("other"),
        };
        let wrong = crate::source::parse_request(&serde_json::to_vec(&value).unwrap()).unwrap();
        let before = s.gets.load(Ordering::SeqCst);
        let http = FakeHttp(AtomicUsize::new(0));
        let expected = if ["workspace", "organization", "client_id"].contains(&field) {
            SundayRefusal::BindingMismatch
        } else {
            SundayRefusal::ScopeMismatch
        };
        assert_eq!(
            auth.read_sunday_page_using(permit, &wrong, &http).err(),
            Some(SundayReadFailure::Refused(expected))
        );
        assert_eq!(s.gets.load(Ordering::SeqCst), before);
        assert_eq!(http.0.load(Ordering::SeqCst), 0);
    }
    let (auth, a, s, _, r) = rig();
    let (_, foreign, _, _, _) = rig();
    let permit = SundayPagePermit::fixture(foreign, &r);
    let before = s.gets.load(Ordering::SeqCst);
    assert_eq!(
        auth.read_sunday_page_using(permit, &r, &FakeHttp(AtomicUsize::new(0)))
            .err(),
        Some(SundayReadFailure::Refused(
            SundayRefusal::ControllerMismatch
        ))
    );
    let permit = SundayPagePermit::fixture(a.clone(), &r);
    a.retire(RetireReason::AuthorityChanged).unwrap();
    assert_eq!(
        auth.read_sunday_page_using(permit, &r, &FakeHttp(AtomicUsize::new(0)))
            .err(),
        Some(SundayReadFailure::Refused(SundayRefusal::Retired))
    );
    assert_eq!(s.gets.load(Ordering::SeqCst), before);
}
#[test]
fn sunday_some_legacy_source_and_disconnect_refuse_without_native_client_or_credential_io() {
    let (auth, a, s, p, r) = rig();
    let before = s.gets.load(Ordering::SeqCst);
    assert_eq!(
        auth.read_source(&r, &AtomicBool::new(false)).err(),
        Some(SourceError::Busy)
    );
    assert_eq!(
        auth.read_source_using(&r, &AtomicBool::new(false), &FakeHttp(AtomicUsize::new(0)))
            .err(),
        Some(SourceError::Busy)
    );
    assert_eq!(auth.disconnect().err(), Some(AuthError::Busy));
    assert_ne!(a.word.load(Ordering::SeqCst) & crate::sunday::RETIRED, 0);
    assert_eq!(s.gets.load(Ordering::SeqCst), before);
    assert_eq!(p.calls.load(Ordering::SeqCst), 0);
    assert_eq!(s.puts.load(Ordering::SeqCst), 1);
}
#[test]
fn sunday_invalid_callback_does_not_retire_and_busy_mutation_retires_first() {
    let (auth, a, s, _, _) = rig();
    let before = a.word.load(Ordering::SeqCst);
    assert_eq!(
        auth.callback("invalid").err(),
        Some(AuthError::InvalidCallback)
    );
    assert_eq!(
        auth.callback(&format!("{REDIRECT_URI}?code=fictional&state=foreign"))
            .err(),
        Some(AuthError::StateMismatch)
    );
    assert_eq!(a.word.load(Ordering::SeqCst), before);
    let operation = auth.operation().unwrap();
    let gets = s.gets.load(Ordering::SeqCst);
    assert_eq!(auth.begin().err(), Some(AuthError::Busy));
    assert_ne!(a.word.load(Ordering::SeqCst) & crate::sunday::RETIRED, 0);
    assert_eq!(s.gets.load(Ordering::SeqCst), gets);
    drop(operation);
}

#[test]
fn sunday_no_receipt_poison_unknown_word_stale_revision_and_nonrunning_refuse_before_get() {
    for case in 0..6 {
        let (auth, a, s, _, r) = rig();
        let permit = SundayPagePermit::fixture(a.clone(), &r);
        match case {
            0 => a.fixture_clear_receipt(),
            1 => {
                a.word.fetch_or(crate::sunday::POISON, Ordering::SeqCst);
            }
            2 => {
                a.word.fetch_or(1 << 58, Ordering::SeqCst);
            }
            3 => {
                a.word.fetch_add(1, Ordering::SeqCst);
            }
            4 => {
                a.word.fetch_xor(3 << 47, Ordering::SeqCst);
            }
            _ => {
                a.word.fetch_or(crate::sunday::CANCEL, Ordering::SeqCst);
            }
        }
        let expected = [
            SundayRefusal::NotReady,
            SundayRefusal::Poisoned,
            SundayRefusal::InvalidWord,
            SundayRefusal::NotReady,
            SundayRefusal::NotReady,
            SundayRefusal::Cancelled,
        ][case];
        let before = s.gets.load(Ordering::SeqCst);
        assert_eq!(
            auth.read_sunday_page_using(permit, &r, &FakeHttp(AtomicUsize::new(0)))
                .err(),
            Some(SundayReadFailure::Refused(expected))
        );
        assert_eq!(s.gets.load(Ordering::SeqCst), before);
    }
}
#[test]
fn sunday_deadline_at_each_postboundary_discards_success_or_error_but_before_deadline_preserves_it()
{
    for step in 0..4 {
        for exact in [false, true] {
            for late_error in [false, true] {
                let (auth, a, s, p, r) = rig();
                let mut permit = SundayPagePermit::fixture(a, &r);
                let (clock, deadline) = permit.fixture_clock();
                let (et, er) = mpsc::sync_channel(1);
                let (rt, rr) = mpsc::sync_channel(1);
                let gate = Arc::new(Gate {
                    entered: et,
                    release: Mutex::new(rr),
                });
                if step < 2 {
                    *s.get_gate.lock().unwrap() =
                        Some((s.gets.load(Ordering::SeqCst) + step + 1, gate.clone()));
                    if late_error {
                        if step == 1 {
                            s.script
                                .lock()
                                .unwrap()
                                .push_back(Ok(s.bytes.lock().unwrap().clone()));
                        }
                        s.script.lock().unwrap().push_back(Err(StoreError::Denied));
                    }
                } else if step == 2 {
                    *p.gate.lock().unwrap() = Some(gate.clone());
                    if late_error {
                        *p.failure.lock().unwrap() = Some(AuthError::ProviderFailure);
                    }
                }
                let calls = Arc::new(AtomicUsize::new(0));
                let http = ReadHttp {
                    calls: calls.clone(),
                    gate: (step == 3).then_some(gate),
                    failure: late_error.then_some(SourceError::Denied),
                };
                let worker =
                    std::thread::spawn(move || auth.read_sunday_page_using(permit, &r, &http));
                let job = Job {
                    release: Some(rt),
                    worker: Some(worker),
                };
                er.recv_timeout(Duration::from_secs(3)).unwrap();
                *clock.lock().unwrap() = if exact {
                    deadline
                } else {
                    deadline - Duration::from_nanos(1)
                };
                let result = job.finish();
                if exact {
                    assert_eq!(
                        result.err(),
                        Some(SundayReadFailure::Refused(SundayRefusal::TimedOut))
                    );
                    assert_eq!(calls.load(Ordering::SeqCst), usize::from(step == 3));
                } else if late_error {
                    assert_eq!(
                        result.err(),
                        Some(SundayReadFailure::Source(if step == 2 {
                            SourceError::ProviderFailure
                        } else {
                            SourceError::Denied
                        }))
                    );
                } else {
                    assert!(result.is_ok());
                }
            }
        }
    }
}
#[test]
fn sunday_same_scope_other_controller_cannot_use_the_receipt_even_with_equal_generation() {
    for same_authority in [false, true] {
        let (auth, a, _, _, r) = rig();
        let (other, _, s, _, _) = rig();
        let mut other = Arc::try_unwrap(other).ok().unwrap();
        if same_authority {
            // Inject a foreign attachment into a real controller solely for this refusal test.
            other.sunday.as_mut().unwrap().0 = a.clone();
        }
        assert_eq!(
            auth.generation.load(Ordering::SeqCst),
            other.generation.load(Ordering::SeqCst)
        );
        let permit = SundayPagePermit::fixture(a, &r);
        let before = s.gets.load(Ordering::SeqCst);
        assert_eq!(
            other
                .read_sunday_page_using(permit, &r, &FakeHttp(AtomicUsize::new(0)))
                .err(),
            Some(SundayReadFailure::Refused(
                SundayRefusal::ControllerMismatch
            ))
        );
        assert_eq!(s.gets.load(Ordering::SeqCst), before);
    }
}

struct Release(Option<mpsc::SyncSender<()>>);
impl Release {
    fn now(mut self) {
        if let Some(s) = self.0.take() {
            let _ = s.send(());
        }
    }
}
impl Drop for Release {
    fn drop(&mut self) {
        if let Some(s) = self.0.take() {
            let _ = s.send(());
        }
    }
}
#[test]
fn sunday_cancelled_put_compensates_without_installing_receipt_or_rearming() {
    let a = Arc::new(SundayAuthority::new().unwrap());
    let s = Arc::new(Store::default());
    let auth = Arc::new(
        AuthController::new_with_sunday_authority(
            binding(),
            s.clone(),
            Arc::new(FakeProvider),
            Arc::new(|| 0),
            a.clone(),
        )
        .unwrap(),
    );
    let u = url::Url::parse(&auth.begin().unwrap()).unwrap();
    let state = u
        .query_pairs()
        .find(|(k, _)| k == "state")
        .unwrap()
        .1
        .into_owned();
    let callback = format!("{REDIRECT_URI}?code=fictional-code&state={state}");
    let (et, er) = mpsc::sync_channel(1);
    let (rt, rr) = mpsc::sync_channel(1);
    *s.put_gate.lock().unwrap() = Some(Arc::new(Gate {
        entered: et,
        release: Mutex::new(rr),
    }));
    std::thread::scope(|scope| {
        let release = Release(Some(rt));
        let writer = scope.spawn(|| auth.callback(&callback));
        er.recv_timeout(Duration::from_secs(3)).unwrap();
        let canceller = scope.spawn(|| auth.cancel());
        let safety = std::time::Instant::now() + Duration::from_secs(3);
        while a.word.load(Ordering::SeqCst) & crate::sunday::CANCEL == 0 {
            assert!(
                std::time::Instant::now() < safety,
                "cancel latch did not arrive"
            );
            std::thread::yield_now();
        }
        assert_ne!(a.word.load(Ordering::SeqCst) & crate::sunday::RETIRED, 0);
        release.now();
        assert_eq!(writer.join().unwrap().err(), Some(AuthError::Cancelled));
        canceller.join().unwrap();
    });
    assert!(s.bytes.lock().unwrap().is_none());
    assert_eq!(s.deletes.load(Ordering::SeqCst), 1);
    // No permit fixture can be obtained: a cancelled put must not install a receipt.
    assert!(!a.fixture_has_receipt());
}
#[test]
fn sunday_callback_cannot_block_on_state_or_claim_while_oauth_is_busy() {
    let a = Arc::new(SundayAuthority::new().unwrap());
    let s = Arc::new(Store::default());
    let auth = AuthController::new_with_sunday_authority(
        binding(),
        s.clone(),
        Arc::new(FakeProvider),
        Arc::new(|| 0),
        a.clone(),
    )
    .unwrap();
    let u = url::Url::parse(&auth.begin().unwrap()).unwrap();
    let state = u
        .query_pairs()
        .find(|(k, _)| k == "state")
        .unwrap()
        .1
        .into_owned();
    let callback = format!("{REDIRECT_URI}?code=fictional-code&state={state}");
    let word = a.word.load(Ordering::SeqCst);
    let state_guard = auth.state.lock().unwrap();
    assert_eq!(auth.callback(&callback).err(), Some(AuthError::Busy));
    assert_eq!(a.word.load(Ordering::SeqCst), word);
    drop(state_guard);
    let operation = auth.operation().unwrap();
    assert_eq!(auth.callback(&callback).err(), Some(AuthError::Busy));
    assert_eq!(s.puts.load(Ordering::SeqCst), 0);
    assert!(auth.state.lock().unwrap().pending.is_some());
    drop(operation);
    auth.callback(&callback).unwrap();
    assert!(a.fixture_has_receipt());
    assert_eq!(
        auth.callback(&callback).err(),
        Some(AuthError::StateMismatch)
    );
}
#[test]
fn sunday_source_error_families_remain_original_source_facts_without_refresh_or_write() {
    for error in [
        SourceError::Denied,
        SourceError::ProviderFailure,
        SourceError::InvalidResponse,
        SourceError::Oversized,
        SourceError::Timeout,
    ] {
        let (auth, a, s, p, r) = rig();
        let permit = SundayPagePermit::fixture(a, &r);
        let http = ReadHttp {
            calls: Arc::new(AtomicUsize::new(0)),
            gate: None,
            failure: Some(error),
        };
        assert_eq!(
            auth.read_sunday_page_using(permit, &r, &http).err(),
            Some(SundayReadFailure::Source(error))
        );
        assert_eq!(s.gets.load(Ordering::SeqCst), 3);
        assert_eq!(p.calls.load(Ordering::SeqCst), 1);
        assert_eq!(s.puts.load(Ordering::SeqCst), 1);
        assert_eq!(s.deletes.load(Ordering::SeqCst), 0);
    }
}

#[test]
fn sunday_stored_unchecked_constructor_does_not_install_a_receipt() {
    let (_, _, initial, _, _) = rig();
    let bytes = initial.bytes.lock().unwrap().clone();
    let s = Arc::new(Store::default());
    *s.bytes.lock().unwrap() = bytes;
    let a = Arc::new(SundayAuthority::new().unwrap());
    let auth = AuthController::new_with_sunday_authority(
        binding(),
        s.clone(),
        Arc::new(FakeProvider),
        Arc::new(|| 0),
        a.clone(),
    )
    .unwrap();
    assert_eq!(
        auth.status().unwrap().state,
        ConnectionState::StoredUnchecked
    );
    assert!(!a.fixture_has_receipt());
    assert_eq!(s.gets.load(Ordering::SeqCst), 1);
    assert_eq!(s.puts.load(Ordering::SeqCst), 0);
}
#[test]
fn sunday_stale_valid_callback_cannot_save_or_arm_after_blocked_exchange() {
    let a = Arc::new(SundayAuthority::new().unwrap());
    let s = Arc::new(Store::default());
    let p = Arc::new(ReadProvider::default());
    let auth = Arc::new(
        AuthController::new_with_sunday_authority(
            binding(),
            s.clone(),
            p.clone(),
            Arc::new(|| 0),
            a.clone(),
        )
        .unwrap(),
    );
    let u = url::Url::parse(&auth.begin().unwrap()).unwrap();
    let state = u
        .query_pairs()
        .find(|(k, _)| k == "state")
        .unwrap()
        .1
        .into_owned();
    let callback = format!("{REDIRECT_URI}?code=fictional-code&state={state}");
    let (et, er) = mpsc::sync_channel(1);
    let (rt, rr) = mpsc::sync_channel(1);
    *p.exchange_gate.lock().unwrap() = Some(Arc::new(Gate {
        entered: et,
        release: Mutex::new(rr),
    }));
    std::thread::scope(|scope| {
        let release = Release(Some(rt));
        let writer = scope.spawn(|| auth.callback(&callback));
        er.recv_timeout(Duration::from_secs(3)).unwrap();
        a.retire(RetireReason::AuthorityChanged).unwrap();
        release.now();
        assert_eq!(writer.join().unwrap().err(), Some(AuthError::Cancelled));
    });
    assert_eq!(s.puts.load(Ordering::SeqCst), 0);
    assert_eq!(p.calls.load(Ordering::SeqCst), 0);
    assert!(!a.fixture_has_receipt());
}

#[test]
fn sunday_page_and_aggregate_deadlines_refuse_before_operation_or_get() {
    for (admission, page) in [(30, 1), (10, 9)] {
        let (auth, a, s, _, r) = rig();
        let mut permit = SundayPagePermit::fixture(a, &r);
        permit.fixture_ages(Duration::from_secs(admission), Duration::from_secs(page));
        let before = s.gets.load(Ordering::SeqCst);
        assert_eq!(
            auth.read_sunday_page_using(permit, &r, &FakeHttp(AtomicUsize::new(0)))
                .err(),
            Some(SundayReadFailure::Refused(SundayRefusal::TimedOut))
        );
        assert_eq!(s.gets.load(Ordering::SeqCst), before);
        assert!(!auth.busy.load(Ordering::SeqCst));
    }
}

#[test]
fn sunday_refresh_postchecks_discard_late_store_and_provider_errors() {
    for store_step in [true, false] {
        let (auth, a, s, p, _) = rig();
        let (et, er) = mpsc::sync_channel(1);
        let (rt, rr) = mpsc::sync_channel(1);
        let gate = Arc::new(Gate {
            entered: et,
            release: Mutex::new(rr),
        });
        if store_step {
            *s.get_gate.lock().unwrap() = Some((s.gets.load(Ordering::SeqCst) + 1, gate));
            s.script.lock().unwrap().push_back(Err(StoreError::Denied));
        } else {
            *p.refresh_gate.lock().unwrap() = Some(gate);
        }
        std::thread::scope(|scope| {
            let release = Release(Some(rt));
            let worker = scope.spawn(|| auth.refresh());
            er.recv_timeout(Duration::from_secs(3)).unwrap();
            a.retire(RetireReason::AuthorityChanged).unwrap();
            release.now();
            assert_eq!(worker.join().unwrap().err(), Some(AuthError::Cancelled));
        });
        assert_eq!(s.puts.load(Ordering::SeqCst), 1);
        assert_eq!(s.deletes.load(Ordering::SeqCst), 0);
    }
}

#[test]
fn sunday_late_failed_put_cannot_publish_a_provider_or_store_outcome_over_retirement() {
    let a = Arc::new(SundayAuthority::new().unwrap());
    let s = Arc::new(Store::default());
    let auth = AuthController::new_with_sunday_authority(
        binding(),
        s.clone(),
        Arc::new(FakeProvider),
        Arc::new(|| 0),
        a.clone(),
    )
    .unwrap();
    let u = url::Url::parse(&auth.begin().unwrap()).unwrap();
    let state = u
        .query_pairs()
        .find(|(k, _)| k == "state")
        .unwrap()
        .1
        .into_owned();
    let callback = format!("{REDIRECT_URI}?code=fictional-code&state={state}");
    let (et, er) = mpsc::sync_channel(1);
    let (rt, rr) = mpsc::sync_channel(1);
    *s.put_gate.lock().unwrap() = Some(Arc::new(Gate {
        entered: et,
        release: Mutex::new(rr),
    }));
    *s.put_error.lock().unwrap() = Some(StoreError::Denied);
    std::thread::scope(|scope| {
        let release = Release(Some(rt));
        let worker = scope.spawn(|| auth.callback(&callback));
        er.recv_timeout(Duration::from_secs(3)).unwrap();
        a.retire(RetireReason::AuthorityChanged).unwrap();
        release.now();
        assert_eq!(worker.join().unwrap().err(), Some(AuthError::Cancelled));
    });
    assert!(!a.fixture_has_receipt());
    assert_eq!(s.deletes.load(Ordering::SeqCst), 0);
}

#[test]
fn sunday_busy_read_refuses_as_a_local_fact_before_any_credential_or_http_primitive() {
    let (auth, a, s, p, r) = rig();
    let permit = SundayPagePermit::fixture(a, &r);
    let operation = auth.operation().unwrap();
    let before = s.gets.load(Ordering::SeqCst);
    let http = FakeHttp(AtomicUsize::new(0));
    assert_eq!(
        auth.read_sunday_page_using(permit, &r, &http).err(),
        Some(SundayReadFailure::Refused(SundayRefusal::Busy))
    );
    assert_eq!(s.gets.load(Ordering::SeqCst), before);
    assert_eq!(p.calls.load(Ordering::SeqCst), 0);
    assert_eq!(http.0.load(Ordering::SeqCst), 0);
    drop(operation);
}

#[test]
fn sunday_receipt_cell_credential_revision_and_arm_drift_refuse_before_get() {
    for case in 0..3 {
        let (auth, a, s, _, r) = rig();
        let permit = SundayPagePermit::fixture(a.clone(), &r);
        a.fixture_receipt_identity_drift(case);
        let before = s.gets.load(Ordering::SeqCst);
        assert_eq!(
            auth.read_sunday_page_using(permit, &r, &FakeHttp(AtomicUsize::new(0)))
                .err(),
            Some(SundayReadFailure::Refused(SundayRefusal::ReceiptMismatch))
        );
        assert_eq!(s.gets.load(Ordering::SeqCst), before);
    }
}
#[test]
fn sunday_failed_constructor_withdraws_only_its_current_reservation() {
    let a = Arc::new(SundayAuthority::new().unwrap());
    let s = Arc::new(Store::default());
    s.script.lock().unwrap().push_back(Err(StoreError::Denied));
    assert_eq!(
        AuthController::new_with_sunday_authority(
            binding(),
            s.clone(),
            Arc::new(FakeProvider),
            Arc::new(|| 0),
            a.clone(),
        )
        .err(),
        Some(AuthError::Store(StoreError::Denied))
    );
    let auth = AuthController::new_with_sunday_authority(
        binding(),
        s.clone(),
        Arc::new(FakeProvider),
        Arc::new(|| 0),
        a.clone(),
    )
    .unwrap();
    assert_eq!(auth.status().unwrap().state, ConnectionState::Disconnected);
    assert_eq!(s.gets.load(Ordering::SeqCst), 2);
    assert!(!a.fixture_has_receipt());
}

#[test]
fn root_cancel_contention_latches_both_domains_and_generation() {
    let (auth, authority, store, provider, _) = rig();
    let generation = auth.generation.load(Ordering::SeqCst);
    let puts = store.puts.load(Ordering::SeqCst);
    let calls = provider.calls.load(Ordering::SeqCst);
    let held = authority.publication().unwrap();
    auth.cancel();
    let word = authority.word.load(Ordering::SeqCst);
    let native = word & (crate::sunday::CANCEL | crate::sunday::RETIRED)
        == crate::sunday::CANCEL | crate::sunday::RETIRED;
    let legacy = auth.cancelled.load(Ordering::SeqCst);
    let advanced = auth.generation.load(Ordering::SeqCst) == generation + 1;
    drop(held);
    assert_eq!((native, legacy, advanced), (true, true, true));
    assert_eq!(store.puts.load(Ordering::SeqCst), puts);
    assert_eq!(provider.calls.load(Ordering::SeqCst), calls);
}

#[test]
fn root_cancel_contention_removes_pending_callback_without_save() {
    let authority = Arc::new(SundayAuthority::new().unwrap());
    let store = Arc::new(Store::default());
    let auth = AuthController::new_with_sunday_authority(
        binding(),
        store.clone(),
        Arc::new(FakeProvider),
        Arc::new(|| 0),
        authority.clone(),
    )
    .unwrap();
    let begin = url::Url::parse(&auth.begin().unwrap()).unwrap();
    let state = begin
        .query_pairs()
        .find(|(key, _)| key == "state")
        .unwrap()
        .1
        .into_owned();
    let callback = format!("{REDIRECT_URI}?code=fictional-root-code&state={state}");
    let held = authority.publication().unwrap();
    auth.cancel();
    drop(held);
    assert_eq!(
        auth.callback(&callback).err(),
        Some(AuthError::StateMismatch)
    );
    assert_eq!(store.puts.load(Ordering::SeqCst), 0);
    assert!(!authority.fixture_has_receipt());
}

#[test]
fn root_cancel_revision_exhaustion_still_sets_legacy_cancellation() {
    let (auth, authority, _, _, _) = rig();
    authority.word.store(
        crate::sunday::RETIRED | crate::sunday::REV,
        Ordering::SeqCst,
    );
    let generation = auth.generation.load(Ordering::SeqCst);
    auth.cancel();
    let word = authority.word.load(Ordering::SeqCst);
    assert!(word & crate::sunday::CANCEL != 0);
    assert!(word & crate::sunday::POISON != 0);
    assert!(auth.cancelled.load(Ordering::SeqCst));
    assert_eq!(auth.generation.load(Ordering::SeqCst), generation + 1);
}
