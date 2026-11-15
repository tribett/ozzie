//! A tiny fake of ozzie.church on 127.0.0.1 for tests (the hosted Ozzie API contract, v1): the
//! connect page, the device token exchange (S256, single-use codes), account status, agent steps, rewords and
//! revoke, with Bearer checks and `{"error":"<code>"}` refusals. It records every request so tests can see exactly
//! what this Mac sent. Plus an in-memory Keychain and a "browser" that follows the connect page's redirect. No
//! network beyond this Mac's loopback; fictional tokens only.
use super::{MANAGED_TOKEN_ACCOUNT, TokenStore};
use crate::credentials::StoreError;
use crate::model::ModelKeys;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    thread::JoinHandle,
    time::Duration,
};
use zeroize::Zeroizing;

/// Device tokens the fake hands out, in order: 43 base64url characters like the real 32 random bytes.
pub(crate) const FAKE_TOKENS: [&str; 3] = [
    "fictionalDeviceTokenCanary0aaaaaaaaaaaaaaaa",
    "fictionalDeviceTokenCanary1bbbbbbbbbbbbbbbb",
    "fictionalDeviceTokenCanary2cccccccccccccccc",
];

/// One request as the fake received it.
#[derive(Clone, Debug)]
pub(crate) struct Recorded {
    pub method: String,
    pub path: String,
    pub authorization: Option<String>,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}
impl Recorded {
    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }
}
#[derive(Default)]
pub(crate) struct ServerState {
    /// One-time code -> its S256 challenge.
    pub codes: HashMap<String, String>,
    pub issued: usize,
    /// Tokens that authenticate.
    pub valid: Vec<String>,
    pub revoked: Vec<String>,
    pub requests: Vec<Recorded>,
    /// The `GET /api/v1/account` reply (plan, counts, period, warning).
    pub account: Value,
    /// Agent steps and rewords answer 402 allowance-paused.
    pub paused: bool,
    /// Queued agent-step and reword answers; a text reply when empty.
    pub replies: VecDeque<(u16, String)>,
    /// What the connect page saw.
    pub connect_query: Vec<(String, String)>,
}
pub(crate) struct FakeServer {
    pub base: String,
    pub state: Arc<Mutex<ServerState>>,
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}
/// The gateway's reply as ozzie.church passes it through, with AI Gateway's zero data retention
/// confirmation (model.rs `retention_confirmed`).
pub(crate) fn text_reply(text: &str) -> String {
    json!({"choices":[{"message":{"role":"assistant","content":text,"provider_metadata":{"gateway":{"enabledZeroDataRetention":true}}},"finish_reason":"stop"}],"usage":{"prompt_tokens":40,"completion_tokens":9}}).to_string()
}
fn s256(verifier: &str) -> String {
    use base64::Engine;
    use sha2::Digest;
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(sha2::Sha256::digest(verifier.as_bytes()))
}
impl FakeServer {
    pub fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let state = Arc::new(Mutex::new(ServerState {
            account: json!({"plan":"trial","allowance_steps":300,"used_steps":120,"period_ends":"2026-12-01T00:00:00.000Z","warning":null}),
            ..ServerState::default()
        }));
        let stop = Arc::new(AtomicBool::new(false));
        let (shared, halt) = (state.clone(), stop.clone());
        let worker = std::thread::spawn(move || {
            while !halt.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((stream, _)) => serve(stream, &shared),
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5))
                    }
                    Err(_) => break,
                }
            }
        });
        Self {
            base,
            state,
            stop,
            worker: Some(worker),
        }
    }
    pub fn requests(&self) -> Vec<Recorded> {
        self.state.lock().unwrap().requests.clone()
    }
    pub fn paths(&self) -> Vec<String> {
        self.requests()
            .iter()
            .map(|r| format!("{} {}", r.method, r.path.split('?').next().unwrap_or("")))
            .collect()
    }
    pub fn with(&self, change: impl FnOnce(&mut ServerState)) {
        change(&mut self.state.lock().unwrap());
    }
}
impl Drop for FakeServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
fn respond(stream: &mut TcpStream, status: &str, extra: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{extra}Connection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
}
fn serve(mut stream: TcpStream, state: &Mutex<ServerState>) {
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        match stream.read(&mut byte) {
            Ok(1) => head.push(byte[0]),
            _ => return,
        }
    }
    let text = String::from_utf8_lossy(&head).into_owned();
    let mut lines = text.split("\r\n");
    let mut first = lines.next().unwrap_or("").split(' ');
    let (method, path) = (
        first.next().unwrap_or("").to_owned(),
        first.next().unwrap_or("").to_owned(),
    );
    let headers: Vec<(String, String)> = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_owned()))
        .collect();
    let length = headers
        .iter()
        .find(|(k, _)| k == "content-length")
        .and_then(|(_, v)| v.parse::<usize>().ok())
        .unwrap_or(0);
    let mut body = vec![0u8; length];
    if stream.read_exact(&mut body).is_err() {
        return;
    }
    let authorization = headers
        .iter()
        .find(|(k, _)| k == "authorization")
        .map(|(_, v)| v.clone());
    let mut state = state.lock().unwrap();
    state.requests.push(Recorded {
        method: method.clone(),
        path: path.clone(),
        authorization: authorization.clone(),
        headers: headers.clone(),
        body: body.clone(),
    });
    let bearer = authorization
        .as_deref()
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::to_owned);
    let authed = bearer.as_ref().is_some_and(|t| state.valid.contains(t));
    let route = path.split('?').next().unwrap_or("").to_owned();
    let unauthorized = r#"{"error":"unauthorized"}"#;
    match (method.as_str(), route.as_str()) {
        ("GET", "/connect") => {
            let url = url::Url::parse(&format!("http://fake{path}")).unwrap();
            let query: Vec<(String, String)> = url.query_pairs().into_owned().collect();
            let get = |key: &str| query.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone());
            let (Some(port), Some(s), Some(challenge)) =
                (get("redirect_port"), get("state"), get("code_challenge"))
            else {
                return respond(
                    &mut stream,
                    "400 Bad Request",
                    "",
                    r#"{"error":"invalid-request"}"#,
                );
            };
            state.issued += 1;
            let code = format!("fictional-code-{}", state.issued);
            state.codes.insert(code.clone(), challenge);
            state.connect_query = query;
            let location = format!("http://127.0.0.1:{port}/ozzie/callback?code={code}&state={s}");
            respond(
                &mut stream,
                "302 Found",
                &format!("Location: {location}\r\n"),
                "",
            );
        }
        ("POST", "/api/v1/device/token") => {
            let request: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
            let code = request["code"].as_str().unwrap_or("").to_owned();
            let verifier = request["code_verifier"].as_str().unwrap_or("");
            // Single use: a code is gone once tried.
            match state.codes.remove(&code) {
                Some(challenge) if challenge == s256(verifier) => {
                    let token = FAKE_TOKENS[state.valid.len() + state.revoked.len()].to_owned();
                    state.valid.push(token.clone());
                    let reply = json!({"device_token": token, "account": {"plan":"trial","allowance_steps":300,"used_steps":0,"period_ends":"2026-12-01T00:00:00.000Z"}});
                    respond(&mut stream, "200 OK", "", &reply.to_string());
                }
                _ => respond(
                    &mut stream,
                    "400 Bad Request",
                    "",
                    r#"{"error":"invalid-code"}"#,
                ),
            }
        }
        ("GET", "/api/v1/account") if authed => {
            let reply = state.account.to_string();
            respond(&mut stream, "200 OK", "", &reply);
        }
        ("POST", "/api/v1/agent-step" | "/api/v1/reword") if authed => {
            if state.paused {
                return respond(
                    &mut stream,
                    "402 Payment Required",
                    "",
                    r#"{"error":"allowance-paused"}"#,
                );
            }
            let (status, reply) = state
                .replies
                .pop_front()
                .unwrap_or_else(|| (200, text_reply(r#"{"answer":"not-covered"}"#)));
            let line = match status {
                200 => "200 OK".to_owned(),
                other => format!("{other} Refused"),
            };
            respond(&mut stream, &line, "", &reply);
        }
        ("POST", "/api/v1/device/revoke") if authed => {
            let token = bearer.unwrap_or_default();
            state.valid.retain(|t| *t != token);
            state.revoked.push(token);
            respond(&mut stream, "200 OK", "", "{}");
        }
        (
            _,
            "/api/v1/account" | "/api/v1/agent-step" | "/api/v1/reword" | "/api/v1/device/revoke",
        ) => respond(&mut stream, "401 Unauthorized", "", unauthorized),
        _ => respond(&mut stream, "404 Not Found", "", r#"{"error":"not-found"}"#),
    }
}

/// The person's browser: opens the connect address, follows its redirect to the loopback callback, and returns
/// the status and text of the page Ozzie showed there.
pub(crate) fn browse(url: &str) -> (u16, String) {
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(60))
        .build()
        .unwrap();
    let response = client.get(url).send().unwrap();
    (
        response.status().as_u16(),
        response.text().unwrap_or_default(),
    )
}
/// A raw request to the loopback receiver, for requests a browser wouldn't make.
pub(crate) fn raw(port_host: &str, request: &str) -> String {
    let mut stream = TcpStream::connect(port_host).unwrap();
    stream.write_all(request.as_bytes()).unwrap();
    let mut answer = String::new();
    let _ = stream.read_to_string(&mut answer);
    answer
}

/// An in-memory Keychain under KEYCHAIN_SERVICE: accounts to values, with counted lookups.
#[derive(Default)]
pub(crate) struct MemoryKeys {
    pub items: Mutex<BTreeMap<String, String>>,
    pub lookups: AtomicUsize,
    /// Every account looked up, in order.
    pub looked: Mutex<Vec<String>>,
    pub refuse_writes: bool,
}
impl MemoryKeys {
    pub fn with(items: &[(&str, &str)]) -> Self {
        Self {
            items: Mutex::new(
                items
                    .iter()
                    .map(|(k, v)| (k.to_string(), v.to_string()))
                    .collect(),
            ),
            ..Self::default()
        }
    }
    pub fn token(&self) -> Option<String> {
        self.items
            .lock()
            .unwrap()
            .get(MANAGED_TOKEN_ACCOUNT)
            .cloned()
    }
}
impl ModelKeys for MemoryKeys {
    fn key(&self, account: &str) -> Result<Option<Zeroizing<String>>, StoreError> {
        self.lookups.fetch_add(1, Ordering::SeqCst);
        self.looked.lock().unwrap().push(account.to_owned());
        Ok(self
            .items
            .lock()
            .unwrap()
            .get(account)
            .map(|v| Zeroizing::new(v.clone())))
    }
}
impl TokenStore for MemoryKeys {
    fn put_token(&self, token: &str) -> Result<(), StoreError> {
        if self.refuse_writes {
            return Err(StoreError::Denied);
        }
        self.items
            .lock()
            .unwrap()
            .insert(MANAGED_TOKEN_ACCOUNT.into(), token.into());
        Ok(())
    }
    fn delete_token(&self) -> Result<(), StoreError> {
        if self.refuse_writes {
            return Err(StoreError::Denied);
        }
        self.items.lock().unwrap().remove(MANAGED_TOKEN_ACCOUNT);
        Ok(())
    }
}
