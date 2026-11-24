//! Trusted host helper, not an agent subprocess tool. One bounded request per lifetime.
use ozzie_native_auth::{
    credentials::{CredentialStore, MacKeychain, StoreError},
    oauth::{AuthController, AuthError, system_clock},
    provider::{NativeHttp, PcoProvider},
    source::{MAX_INPUT, MAX_OUTPUT, SourceError, parse_request},
};
use std::{
    io::{self, BufRead, BufReader, Read, Write},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

// This mode can only deny: it never reads Keychain, accepts test secrets or enables network fallback.
struct AbsentStore;
impl CredentialStore for AbsentStore {
    fn get(&self, _: &str, _: &str) -> Result<Option<Vec<u8>>, StoreError> {
        Ok(None)
    }
    fn put(&self, _: &str, _: &str, _: &[u8]) -> Result<(), StoreError> {
        Err(StoreError::Unavailable)
    }
    fn delete(&self, _: &str, _: &str) -> Result<(), StoreError> {
        Err(StoreError::Unavailable)
    }
}
fn auth_error(e: AuthError) -> SourceError {
    match e {
        AuthError::Store(StoreError::Locked) => SourceError::Locked,
        AuthError::Store(StoreError::Denied) => SourceError::Denied,
        AuthError::Store(StoreError::Unavailable) => SourceError::StoreUnavailable,
        _ => SourceError::ProviderFailure,
    }
}
fn main() {
    // A panic must not print potentially sensitive provider/source values.
    std::panic::set_hook(Box::new(|_| {}));
    let args: Vec<_> = std::env::args().skip(1).collect();
    let no_credentials = args == ["--no-credentials"];
    if !args.is_empty() && !no_credentials {
        publish(SourceError::InvalidRequest.envelope());
        return;
    }
    let started = Instant::now();
    let cancel = Arc::new(AtomicBool::new(false));
    let (input_tx, input_rx) = mpsc::sync_channel(1);
    let input_cancel = cancel.clone();
    std::thread::spawn(move || {
        let mut input = BufReader::new(io::stdin());
        let mut bytes = Vec::new();
        let result = Read::take(&mut input, (MAX_INPUT + 1) as u64).read_until(b'\n', &mut bytes);
        let request = match result {
            Ok(_) if bytes.len() > MAX_INPUT => Err(SourceError::Oversized),
            Ok(_) if bytes.last() == Some(&b'\n') => parse_request(&bytes),
            _ => Err(SourceError::InvalidRequest),
        };
        if input_tx.send(request).is_err() {
            return;
        }
        // EOF or any subsequent input invalidates the operation. Only the documented cancel
        // line is meaningful; malformed follow-up cannot broaden a one-shot read.
        let mut next = [0u8; 1];
        let _ = input.read(&mut next);
        input_cancel.store(true, Ordering::SeqCst);
    });
    let request = match input_rx.recv_timeout(Duration::from_secs(8)) {
        Ok(Ok(request)) => request,
        Ok(Err(error)) => {
            publish(error.envelope());
            return;
        }
        Err(_) => {
            publish(SourceError::Timeout.envelope());
            return;
        }
    };
    let (tx, rx) = mpsc::sync_channel(1);
    let worker_cancel = cancel.clone();
    std::thread::spawn(move || {
        let result = (|| {
            if worker_cancel.load(Ordering::SeqCst) {
                return Err(SourceError::Cancelled);
            }
            let store: Arc<dyn CredentialStore> = if no_credentials {
                Arc::new(AbsentStore)
            } else {
                Arc::new(MacKeychain {
                    service: ozzie_native_auth::variant::PLANNING_CENTER_SERVICE.into(),
                })
            };
            let auth = AuthController::new(
                request.binding(),
                store,
                Arc::new(PcoProvider(NativeHttp::new().map_err(auth_error)?)),
                system_clock().map_err(auth_error)?,
            )
            .map_err(auth_error)?;
            auth.read_source(&request, &worker_cancel)
        })();
        let _ = tx.send(result);
    });
    let deadline = Duration::from_secs(8).saturating_sub(started.elapsed());
    let result = match rx.recv_timeout(deadline) {
        Ok(Ok(page)) => page.envelope(),
        Ok(Err(error)) => error.envelope(),
        Err(_) => SourceError::Timeout.envelope(),
    };
    // Late results cannot publish after EOF/cancel. Process exit terminates blocked workers;
    // the default SIGTERM behavior also terminates the process, without promising GET rollback.
    if cancel.load(Ordering::SeqCst) {
        publish(SourceError::Cancelled.envelope());
    } else {
        publish(result);
    }
}
fn publish(value: serde_json::Value) {
    let Ok(mut bytes) = serde_json::to_vec(&value) else {
        return;
    };
    if bytes.len() + 1 > MAX_OUTPUT {
        publish(SourceError::Oversized.envelope());
        return;
    }
    bytes.push(b'\n');
    let _ = io::stdout().lock().write_all(&bytes);
}
