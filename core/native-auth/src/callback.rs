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
                                // Not this attempt's callback (wrong state, malformed): the fixed stray page.
                                respond(&mut stream, Outcome::Stray);
                            }
                        } else {
                            respond(
                                &mut stream,
                                match result {
                                    Ok(()) => Outcome::Connected,
                                    Err(AuthError::Denied) => Outcome::Denied,
                                    Err(AuthError::Cancelled) => Outcome::SignInUnfinished,
                                    Err(_) => Outcome::Failed,
                                },
                            );
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
    let target = read_loopback_get(stream, "127.0.0.1:42819", "/oauth/callback")
        .ok_or(AuthError::InvalidCallback)?;
    Ok(format!(
        "{}{}",
        &REDIRECT_URI[..REDIRECT_URI.len() - "/oauth/callback".len()],
        target.as_str()
    ))
}
/// One loopback request head, read within two seconds and 8 KiB: `GET <path>?… HTTP/1.1` with
/// exactly one Host header equal to `host`, no Origin, no Transfer-Encoding and no body. Returns
/// the request target (path and query); anything else is None. Shared by the Planning Center
/// receiver here and the Ozzie managed receiver (hosted.rs).
pub(crate) fn read_loopback_get(
    stream: &mut TcpStream,
    host: &str,
    path: &str,
) -> Option<zeroize::Zeroizing<String>> {
    let mut bytes = zeroize::Zeroizing::new(Vec::new());
    let mut byte = [0u8; 1];
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    while std::time::Instant::now() < deadline
        && bytes.len() < 8192
        && !bytes.ends_with(b"\r\n\r\n")
    {
        if stream.read(&mut byte).ok()? == 0 {
            return None;
        }
        bytes.push(byte[0]);
    }
    if !bytes.ends_with(b"\r\n\r\n") {
        return None;
    }
    let text = std::str::from_utf8(&bytes).ok()?;
    let mut lines = text.split("\r\n");
    let request = lines.next()?;
    let parts: Vec<_> = request.split(' ').collect();
    if parts.len() != 3
        || parts[0] != "GET"
        || parts[2] != "HTTP/1.1"
        || !parts[1]
            .strip_prefix(path)
            .is_some_and(|rest| rest.starts_with('?'))
    {
        return None;
    }
    let mut hosts = 0;
    for line in lines.filter(|line| !line.is_empty()) {
        let (name, value) = line.split_once(':')?;
        if name.eq_ignore_ascii_case("host") {
            hosts += 1;
            if value.trim() != host {
                return None;
            }
        }
        if name.eq_ignore_ascii_case("origin")
            || name.eq_ignore_ascii_case("transfer-encoding")
            || (name.eq_ignore_ascii_case("content-length") && value.trim() != "0")
        {
            return None;
        }
    }
    if hosts != 1 {
        return None;
    }
    Some(zeroize::Zeroizing::new(parts[1].to_owned()))
}
/// How a browser sign-in (Planning Center) or Ozzie's AI's connect ended, as the tab says it (onboarding spec S4,
/// S10b). Fixed words only: nothing from Planning Center, ozzie.church or the request is ever shown.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Connected,
    Denied,
    Failed,
    Busy,
    /// Ozzie's AI is on this Mac.
    AiOn,
    /// Ozzie's AI: nothing was paid (Stripe's back button, or cancelled on ozzie.church).
    PaymentCancelled,
    /// Ozzie's AI: connecting stopped for another reason.
    Cancelled,
    /// Ozzie's AI: something went wrong finishing the connect.
    AiFailed,
    /// Planning Center ended the sign-in with an error other than a refusal (review L2).
    SignInUnfinished,
    /// A request that isn't the attempt Ozzie is waiting for (another tab, an old address): answered and ignored.
    Stray,
}
/// The pages' one style: readable at 20 px, light and dark by the Mac's setting. Allowed by its hash in the
/// Content-Security-Policy (`page_csp`); the pages carry no script.
pub const PAGE_STYLE: &str = ":root{color-scheme:light dark}body{margin:0;padding:12vh 24px;font:20px/1.45 -apple-system,BlinkMacSystemFont,\"Helvetica Neue\",sans-serif;background:#fbfaf7;color:#1d1d1f}main{max-width:520px;margin:0 auto}h1{font-size:28px;line-height:1.2;margin:0 0 12px}a{display:inline-block;margin:20px 0 12px;padding:12px 22px;border-radius:10px;background:#1d5c4f;color:#fff;font-weight:600;text-decoration:none}small{display:block;font-size:15px;color:#5f5f64}@media (prefers-color-scheme:dark){body{background:#1c1c1e;color:#f2f2f7}a{background:#3f8f7d}small{color:#a1a1a6}}";
/// The link that brings Ozzie forward from the browser (always accepted; it carries nothing).
pub const BACK_TO_OZZIE: &str = "ozzie://connected";
/// (title, body, link shown, small print) for each outcome. The spec's exact words.
pub fn outcome_words(outcome: Outcome) -> (&'static str, &'static str, bool, Option<&'static str>) {
    const OPEN: &str = "If your browser asks whether to open Ozzie, choose Open.";
    match outcome {
        Outcome::Connected => (
            "Ozzie is connected",
            "You can close this tab. Go back to Ozzie to continue.",
            true,
            Some(OPEN),
        ),
        Outcome::Denied => (
            "You chose not to allow Ozzie",
            "Nothing was connected. You can close this tab.",
            true,
            None,
        ),
        Outcome::Failed => (
            "Ozzie couldn't finish connecting",
            "Planning Center said yes, but Ozzie couldn't finish. Go back to Ozzie and press Try again.",
            true,
            None,
        ),
        Outcome::Busy => (
            "Ozzie is busy for a moment",
            "Wait a few seconds, then reload this page.",
            false,
            None,
        ),
        Outcome::AiOn => (
            "Ozzie's AI is on",
            "You can close this tab. Go back to Ozzie to continue.",
            true,
            Some(OPEN),
        ),
        Outcome::PaymentCancelled => (
            "No payment was taken",
            "Nothing changed. You can close this tab, or go back to Ozzie to choose another way.",
            true,
            None,
        ),
        Outcome::AiFailed => (
            "Ozzie couldn't finish connecting",
            "Go back to Ozzie and press Try again. If you finished paying, Ozzie finds your plan without charging again.",
            true,
            None,
        ),
        Outcome::Cancelled => (
            "This Mac isn't connected to Ozzie's AI",
            "If you paid, Personal is on your account: go back to Ozzie and press Try again. You won't be charged again.",
            true,
            None,
        ),
        Outcome::SignInUnfinished => (
            "Planning Center didn't finish the sign-in",
            "Planning Center didn't finish the sign-in. Go back to Ozzie and press Try again.",
            true,
            None,
        ),
        Outcome::Stray => (
            "This page isn't from the sign-in Ozzie is waiting for",
            "Go back to Ozzie.",
            true,
            None,
        ),
    }
}
/// The whole page for an outcome: fixed text, the one style, a link back to Ozzie, no script.
pub fn outcome_page(outcome: Outcome) -> String {
    let (title, body, link, small) = outcome_words(outcome);
    let link = if link {
        format!("<a href=\"{BACK_TO_OZZIE}\">Go back to Ozzie</a>")
    } else {
        String::new()
    };
    let small = small
        .map(|s| format!("<small>{s}</small>"))
        .unwrap_or_default();
    format!(
        "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>{title}</title><style>{PAGE_STYLE}</style><main><h1>{title}</h1><p>{body}</p>{link}{small}</main></html>"
    )
}
/// Nothing may load, run or frame the page; only the one style, by its hash.
pub fn page_csp() -> String {
    use base64::Engine;
    use sha2::Digest;
    let hash = sha2::Sha256::digest(PAGE_STYLE.as_bytes());
    format!(
        "default-src 'none'; style-src 'sha256-{}'; frame-ancestors 'none'",
        base64::engine::general_purpose::STANDARD.encode(hash)
    )
}
fn respond(stream: &mut TcpStream, outcome: Outcome) {
    let status = match outcome {
        Outcome::Failed | Outcome::AiFailed | Outcome::Stray => "400 Bad Request",
        _ => "200 OK",
    };
    write_page(stream, status, &outcome_page(outcome));
}
/// A fixed page: no caching, no referrer, nothing loaded but its own style, never framed, connection closed.
pub(crate) fn write_page(stream: &mut TcpStream, status: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: {}\r\nConnection: close\r\n\r\n{body}",
        body.len(),
        page_csp()
    );
    let _ = stream.write_all(response.as_bytes());
}

fn respond_retry(stream: &mut TcpStream) {
    let body = outcome_page(Outcome::Busy);
    let response = format!(
        "HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nRetry-After: 1\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: {}\r\nConnection: close\r\n\r\n{body}",
        body.len(),
        page_csp()
    );
    let _ = stream.write_all(response.as_bytes());
}

#[cfg(test)]
mod page_tests {
    use super::*;

    const ALL: [Outcome; 10] = [
        Outcome::SignInUnfinished,
        Outcome::Stray,
        Outcome::Connected,
        Outcome::Denied,
        Outcome::Failed,
        Outcome::Busy,
        Outcome::AiOn,
        Outcome::PaymentCancelled,
        Outcome::Cancelled,
        Outcome::AiFailed,
    ];

    #[test]
    fn each_outcome_says_what_happened_in_the_specs_words_with_the_way_back() {
        let page = outcome_page(Outcome::Connected);
        assert!(page.contains("<h1>Ozzie is connected</h1><p>You can close this tab. Go back to Ozzie to continue.</p>"));
        // Review L2: Planning Center ended the sign-in some other way; a stray or old request.
        assert!(outcome_page(Outcome::SignInUnfinished).contains("<h1>Planning Center didn't finish the sign-in</h1><p>Planning Center didn't finish the sign-in. Go back to Ozzie and press Try again.</p>"));
        assert!(outcome_page(Outcome::Stray).contains(
            "<h1>This page isn't from the sign-in Ozzie is waiting for</h1><p>Go back to Ozzie.</p>"
        ));
        // Review M4: the person may have paid.
        assert!(outcome_page(Outcome::Cancelled).contains("<h1>This Mac isn't connected to Ozzie's AI</h1><p>If you paid, Personal is on your account: go back to Ozzie and press Try again. You won't be charged again.</p>"));
        for outcome in ALL {
            assert!(
                !outcome_page(outcome).contains("is back on your screen"),
                "{outcome:?}"
            );
        }
        assert!(page.contains(r#"<a href="ozzie://connected">Go back to Ozzie</a>"#));
        assert!(
            page.contains(
                "<small>If your browser asks whether to open Ozzie, choose Open.</small>"
            )
        );
        let page = outcome_page(Outcome::Denied);
        assert!(page.contains("<h1>You chose not to allow Ozzie</h1><p>Nothing was connected. You can close this tab.</p>"));
        let page = outcome_page(Outcome::Failed);
        assert!(page.contains("<h1>Ozzie couldn't finish connecting</h1><p>Planning Center said yes, but Ozzie couldn't finish. Go back to Ozzie and press Try again.</p>"));
        let page = outcome_page(Outcome::Busy);
        assert!(page.contains(
            "<h1>Ozzie is busy for a moment</h1><p>Wait a few seconds, then reload this page.</p>"
        ));
        assert!(
            !page.contains("<a "),
            "a busy page has nothing to go back to yet"
        );
        assert!(outcome_page(Outcome::AiOn).contains("<h1>Ozzie's AI is on</h1>"));
        assert!(outcome_page(Outcome::PaymentCancelled).contains("<h1>No payment was taken</h1>"));
        for outcome in ALL {
            let page = outcome_page(outcome);
            // Readable and fixed: one style, no script, nothing loaded, never a value from the request.
            assert!(page.starts_with("<!doctype html><html lang=\"en\"><meta charset=\"utf-8\">"));
            assert_eq!(page.matches("<style>").count(), 1);
            for refused in [
                "<script",
                "<img",
                "<link",
                "<iframe",
                "src=",
                "http://",
                "https://",
                "{",
                "javascript:",
            ] {
                let body = page.replace(PAGE_STYLE, "");
                assert!(!body.contains(refused), "{outcome:?}: {refused}");
            }
        }
    }

    #[test]
    fn the_csp_allows_exactly_the_pages_own_style_by_its_hash() {
        use base64::Engine;
        use sha2::Digest;
        let page = outcome_page(Outcome::Connected);
        let style = &page[page.find("<style>").unwrap() + 7..page.find("</style>").unwrap()];
        let hash = base64::engine::general_purpose::STANDARD
            .encode(sha2::Sha256::digest(style.as_bytes()));
        assert_eq!(
            page_csp(),
            format!("default-src 'none'; style-src 'sha256-{hash}'; frame-ancestors 'none'")
        );
        // Light and dark by the Mac's setting, 20 px text.
        assert!(
            PAGE_STYLE.contains("color-scheme:light dark")
                && PAGE_STYLE.contains("prefers-color-scheme:dark")
        );
        assert!(PAGE_STYLE.contains("font:20px/"));
        // The response carries it, with no caching, no referrer and no framing.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let reader = std::thread::spawn(move || {
            let mut stream = std::net::TcpStream::connect(address).unwrap();
            let mut text = String::new();
            std::io::Read::read_to_string(&mut stream, &mut text).unwrap();
            text
        });
        let (mut stream, _) = listener.accept().unwrap();
        respond(&mut stream, Outcome::Denied);
        drop(stream);
        let response = reader.join().unwrap();
        assert!(response.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(response.contains(&format!("Content-Security-Policy: {}\r\n", page_csp())));
        assert!(response.contains("Cache-Control: no-store\r\nReferrer-Policy: no-referrer\r\n"));
        assert!(response.ends_with("</main></html>"));
    }
}

#[cfg(test)]
mod stray_tests {
    use super::*;
    use std::io::{Read, Write};

    /// A sign-in that is waiting and refuses every callback as not its own.
    struct Waiting(std::sync::atomic::AtomicBool);
    impl CallbackHandler for Waiting {
        fn waiting(&self) -> bool {
            !self.0.load(std::sync::atomic::Ordering::SeqCst)
        }
        fn accept(&self, _: &str) -> Result<(), AuthError> {
            Err(AuthError::StateMismatch)
        }
        fn cancel(&self) {
            self.0.store(true, std::sync::atomic::Ordering::SeqCst);
        }
        fn retry_after(&self, _: &AuthError) -> bool {
            true
        }
    }

    #[test]
    fn review_n6_the_loopback_answers_a_stray_request_with_the_fixed_page_and_echoes_nothing() {
        let handler = Arc::new(Waiting(std::sync::atomic::AtomicBool::new(false)));
        let Ok(mut server) = CallbackServer::start_handler(handler.clone()) else {
            // Another test holds the fixed port; tests/oauth.rs covers the receiver there.
            return;
        };
        let mut stream = std::net::TcpStream::connect("127.0.0.1:42819").unwrap();
        stream
            .write_all(b"GET /oauth/callback?state=fictional-echo-canary&code=x HTTP/1.1\r\nHost: 127.0.0.1:42819\r\n\r\n")
            .unwrap();
        let mut answer = String::new();
        let _ = stream.read_to_string(&mut answer);
        handler.cancel();
        server.stop();
        let body = &answer[answer.find("\r\n\r\n").unwrap() + 4..];
        assert_eq!(body, outcome_page(Outcome::Stray));
        assert!(!answer.contains("fictional-echo-canary"));
    }
}
