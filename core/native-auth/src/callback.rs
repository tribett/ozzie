use crate::oauth::{AuthController, AuthError, REDIRECT_URI, SundayReceiverDecision};
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread::{self, JoinHandle},
    time::Duration,
};

/// An attempt-only loopback receiver. It never serves the app or exposes a
/// credential operation, and accepts only the registered host/path and GET.
pub struct CallbackServer {
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}
/// A native-only callback consumer. The receiver retains its fixed address,
/// parser and lifetime; implementations never return credentials to callers.
pub trait CallbackHandler: Send + Sync {
    fn waiting(&self) -> bool;
    fn accept(&self, callback: &str) -> Result<(), AuthError>;
    fn cancel(&self);
    /// Native receiver control only; the default preserves historical handlers.
    fn retry_after(&self, error: &AuthError) -> bool {
        matches!(error, AuthError::StateMismatch | AuthError::InvalidCallback)
    }
}
impl CallbackHandler for AuthController {
    fn waiting(&self) -> bool {
        self.callback_waiting().unwrap_or(false)
    }
    fn accept(&self, callback: &str) -> Result<(), AuthError> {
        self.callback(callback).map(|_| ())
    }
    fn cancel(&self) {
        AuthController::cancel(self);
    }
    fn retry_after(&self, error: &AuthError) -> bool {
        matches!(
            self.sunday_receiver_decision(&Err(error.clone())),
            SundayReceiverDecision::Retry
        )
    }
}
impl CallbackServer {
    pub fn start(auth: Arc<AuthController>) -> Result<Self, AuthError> {
        Self::start_handler(auth)
    }
    pub fn start_handler(auth: Arc<dyn CallbackHandler>) -> Result<Self, AuthError> {
        let listener =
            TcpListener::bind("127.0.0.1:42819").map_err(|_| AuthError::InvalidConfiguration)?;
        listener
            .set_nonblocking(true)
            .map_err(|_| AuthError::ProviderFailure)?;
        let stop = Arc::new(AtomicBool::new(false));
        let stop_worker = stop.clone();
        let worker = thread::spawn(move || {
            while !stop_worker.load(Ordering::SeqCst) {
                if !auth.waiting() {
                    break;
                }
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        // macOS hands out accepted sockets that inherit the listener's
                        // nonblocking mode; the browser's request may not have arrived yet.
                        if stream.set_nonblocking(false).is_err() {
                            continue;
                        }
                        let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                        let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
                        let callback = read_callback(&mut stream);
                        if stop_worker.load(Ordering::SeqCst) {
                            break;
                        }
                        let result = callback.and_then(|callback| auth.accept(&callback));
                        if result
                            .as_ref()
                            .err()
                            .is_some_and(|error| auth.retry_after(error))
                        {
                            if matches!(result, Err(AuthError::Busy)) {
                                respond_retry(&mut stream);
                            } else {
                                respond(&mut stream, false);
                            }
                        } else {
                            respond(&mut stream, result.is_ok());
                            break;
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(25))
                    }
                    Err(_) => {
                        auth.cancel();
                        break;
                    }
                }
            }
        });
        Ok(Self {
            stop,
            worker: Some(worker),
        })
    }
    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
impl Drop for CallbackServer {
    fn drop(&mut self) {
        self.stop();
    }
}
fn read_callback(stream: &mut TcpStream) -> Result<String, AuthError> {
    let mut bytes = zeroize::Zeroizing::new(Vec::new());
    let mut byte = [0u8; 1];
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    while std::time::Instant::now() < deadline
        && bytes.len() < 8192
        && !bytes.ends_with(b"\r\n\r\n")
    {
        if stream
            .read(&mut byte)
            .map_err(|_| AuthError::InvalidCallback)?
            == 0
        {
            return Err(AuthError::InvalidCallback);
        }
        bytes.push(byte[0]);
    }
    if !bytes.ends_with(b"\r\n\r\n") {
        return Err(AuthError::InvalidCallback);
    }
    let text = std::str::from_utf8(&bytes).map_err(|_| AuthError::InvalidCallback)?;
    let mut lines = text.split("\r\n");
    let request = lines.next().ok_or(AuthError::InvalidCallback)?;
    let parts: Vec<_> = request.split(' ').collect();
    if parts.len() != 3
        || parts[0] != "GET"
        || parts[2] != "HTTP/1.1"
        || !parts[1].starts_with("/oauth/callback?")
    {
        return Err(AuthError::InvalidCallback);
    }
    let mut hosts = 0;
    for line in lines.filter(|line| !line.is_empty()) {
        let (name, value) = line.split_once(':').ok_or(AuthError::InvalidCallback)?;
        if name.eq_ignore_ascii_case("host") {
            hosts += 1;
            if value.trim() != "127.0.0.1:42819" {
                return Err(AuthError::InvalidCallback);
            }
        }
        if name.eq_ignore_ascii_case("origin")
            || name.eq_ignore_ascii_case("transfer-encoding")
            || (name.eq_ignore_ascii_case("content-length") && value.trim() != "0")
        {
            return Err(AuthError::InvalidCallback);
        }
    }
    if hosts != 1 {
        return Err(AuthError::InvalidCallback);
    }
    Ok(format!(
        "{}{}",
        &REDIRECT_URI[..REDIRECT_URI.len() - "/oauth/callback".len()],
        parts[1]
    ))
}
fn respond(stream: &mut TcpStream, success: bool) {
    let (status, body) = if success {
        (
            "200 OK",
            "<!doctype html><title>Ozzie</title><p>Connection checked. Return to Ozzie.</p>",
        )
    } else {
        (
            "400 Bad Request",
            "<!doctype html><title>Ozzie</title><p>This connection could not be checked. Return to Ozzie.</p>",
        )
    };
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: default-src 'none'; frame-ancestors 'none'\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
}

fn respond_retry(stream: &mut TcpStream) {
    let body = "<!doctype html><title>Ozzie</title><p>The connection check is busy. Try again shortly.</p>";
    let response = format!(
        "HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nRetry-After: 1\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: default-src 'none'; frame-ancestors 'none'\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
}
