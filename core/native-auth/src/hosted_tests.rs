//! Ozzie managed on this Mac against the fake ozzie.church (hosted_fake.rs) over real loopback HTTP: connecting
//! through the browser and the loopback callback, plan and usage, disconnecting, and the device token kept out of
//! every error, status, page and file. Fictional tokens only.
use super::fake::{FAKE_TOKENS, FakeServer, MemoryKeys, browse, raw};
use super::*;
use crate::model::{Route, save_config, status_for};
use serde_json::{Value, json};

const NOW: u64 = 1_795_000_000_000;

struct TempDir(std::path::PathBuf);
impl TempDir {
    fn new(label: &str) -> Self {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "ozzie-hosted-{label}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
    fn cached(&self) -> Option<String> {
        std::fs::read_to_string(self.0.join(ACCOUNT_FILE)).ok()
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
/// A debug build pointed at the fake.
fn local(server: &FakeServer) -> HostedConfig {
    let hosted = HostedConfig::from_env(true, Some(&server.base));
    assert_eq!(hosted.base, server.base);
    hosted
}
fn native(hosted: &HostedConfig) -> NativeModelHttp {
    NativeModelHttp::hosted(hosted, Duration::from_secs(10)).unwrap()
}
fn s256(verifier: &str) -> String {
    use base64::Engine;
    use sha2::Digest;
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(sha2::Sha256::digest(verifier.as_bytes()))
}
fn connected_keys(token: &str) -> MemoryKeys {
    MemoryKeys::with(&[(MANAGED_TOKEN_ACCOUNT, token)])
}
/// A GET the loopback receiver reads like a browser's.
fn get(host: &str, target: &str) -> String {
    raw(
        host,
        &format!("GET {target} HTTP/1.1\r\nHost: {host}\r\n\r\n"),
    )
}
fn no_token_in(text: &str) {
    assert!(!text.contains("fictionalDeviceToken"), "{text}");
}

#[test]
fn release_builds_always_use_ozzie_church_and_debug_overrides_are_checked() {
    for env in [
        None,
        Some("http://127.0.0.1:3000"),
        Some("https://preview.example.invalid"),
    ] {
        let release = HostedConfig::from_env(false, env);
        assert_eq!(release.base, HOSTED_BASE);
        assert!(release.https_only() && !release.debug);
    }
    for (env, base) in [
        ("http://127.0.0.1:3000", "http://127.0.0.1:3000"),
        ("http://127.0.0.1:3000/", "http://127.0.0.1:3000"),
        (
            "https://preview.example.invalid",
            "https://preview.example.invalid",
        ),
        (
            "https://preview.example.invalid:8443/",
            "https://preview.example.invalid:8443",
        ),
    ] {
        assert_eq!(HostedConfig::from_env(true, Some(env)).base, base, "{env}");
    }
    assert!(!HostedConfig::from_env(true, Some("http://127.0.0.1:3000")).https_only());
    assert!(HostedConfig::from_env(true, Some("https://preview.example.invalid")).https_only());
    for refused in [
        "http://localhost:3000",
        "http://192.168.1.20:3000",
        "http://[::1]:3000",
        "http://preview.example.invalid",
        "https://api.planningcenteronline.com",
        "https://people.churchcenter.com.",
        "https://user:pw@preview.example.invalid",
        "https://preview.example.invalid/api",
        "https://preview.example.invalid?x=1",
        "https://preview.example.invalid#x",
        "ftp://preview.example.invalid",
        "",
        "not an address",
    ] {
        assert_eq!(
            HostedConfig::from_env(true, Some(refused)).base,
            HOSTED_BASE,
            "{refused}"
        );
    }
    assert_eq!(
        HostedConfig::from_env(true, None).url(AGENT_STEP_PATH),
        "https://ozzie.church/api/v1/agent-step"
    );
}

#[test]
fn connecting_runs_the_browser_flow_and_keeps_the_token_only_in_the_keychain() {
    let server = FakeServer::start();
    let hosted = local(&server);
    let dir = TempDir::new("connect");
    let keys = MemoryKeys::default();
    let attempt = ConnectAttempt::begin(&hosted, NOW).unwrap();
    // The browser address carries the contract's four parameters and nothing else.
    assert!(
        attempt
            .url()
            .starts_with(&format!("{}/connect?", server.base))
    );
    let url = url::Url::parse(attempt.url()).unwrap();
    let query: Vec<(String, String)> = url.query_pairs().into_owned().collect();
    let names: Vec<&str> = query.iter().map(|(k, _)| k.as_str()).collect();
    assert_eq!(
        names,
        ["redirect_port", "state", "code_challenge", "device_label"]
    );
    assert_eq!(format!("127.0.0.1:{}", query[0].1), attempt.host);
    assert_eq!(query[1].1, attempt.state);
    assert_eq!(query[2].1, s256(&attempt.verifier));
    assert_eq!(query[3].1, DEVICE_LABEL);
    assert_eq!((attempt.state.len(), attempt.verifier.len()), (43, 43));
    assert_ne!(attempt.state, *attempt.verifier);
    assert_eq!(attempt.expires_ms, NOW + 300_000);
    let browser = std::thread::spawn({
        let url = attempt.url().to_owned();
        move || browse(&url)
    });
    let account = connect_using(
        &attempt,
        &hosted,
        &keys,
        &native(&hosted),
        &AtomicBool::new(false),
        &|| NOW,
        &dir.0,
    )
    .unwrap();
    let (status, page) = browser.join().unwrap();
    assert_eq!(status, 200);
    // The tab says so in the spec's words, with the way back to Ozzie (onboarding spec S10b).
    assert!(page.contains("<h1>Ozzie's AI is on</h1>"));
    // Review L2: Ozzie can't know the window came forward, so the tab says to go back.
    assert!(page.contains("You can close this tab. Go back to Ozzie to continue."));
    assert!(page.contains(r#"<a href="ozzie://connected">Go back to Ozzie</a>"#));
    assert_eq!(keys.token().as_deref(), Some(FAKE_TOKENS[0]));
    assert_eq!(
        account,
        Account {
            plan: "trial".into(),
            allowance_steps: 300,
            used_steps: 0,
            period_ends: "2026-12-01T00:00:00.000Z".into(),
            warning: None,
            checked_at_ms: NOW,
            offline: false,
            plan_reason: None,
            paused_until: None,
            answers_left: None,
        }
    );
    // The exchange sent the one-time code and the verifier, and no authorization.
    let exchange = server
        .requests()
        .into_iter()
        .find(|r| r.path == TOKEN_PATH)
        .unwrap();
    assert_eq!(exchange.method, "POST");
    assert_eq!(
        exchange.json(),
        json!({"code": "fictional-code-1", "code_verifier": attempt.verifier.as_str()})
    );
    assert_eq!(exchange.authorization, None);
    assert_eq!(
        server.state.lock().unwrap().connect_query[3],
        ("device_label".to_owned(), DEVICE_LABEL.to_owned())
    );
    // The token is nowhere but the Keychain: not in the account, the saved reading or the page.
    let cached = dir.cached().unwrap();
    for text in [serde_json::to_string(&account).unwrap(), cached, page] {
        no_token_in(&text);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(dir.0.join(ACCOUNT_FILE))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    // The one-time code was single use.
    assert!(server.state.lock().unwrap().codes.is_empty());
}

#[test]
fn the_receiver_answers_and_ignores_anything_but_this_attempts_callback() {
    let server = FakeServer::start();
    let hosted = local(&server);
    let dir = TempDir::new("receiver");
    let keys = MemoryKeys::default();
    let attempt = ConnectAttempt::begin(&hosted, NOW).unwrap();
    let (host, state, url) = (
        attempt.host.clone(),
        attempt.state.clone(),
        attempt.url().to_owned(),
    );
    let poker = std::thread::spawn(move || {
        let answers = vec![
            get(
                &host,
                "/ozzie/callback?code=fictional-code-9&state=not-this-attempts",
            ),
            get(&host, "/ozzie/callback?code=fictional-code-9"),
            raw(
                &host,
                &format!(
                    "GET /ozzie/callback?code=fictional-code-9&state={state} HTTP/1.1\r\nHost: localhost:1\r\n\r\n"
                ),
            ),
            raw(
                &host,
                &format!(
                    "GET /ozzie/callback?code=fictional-code-9&state={state} HTTP/1.1\r\nHost: {host}\r\nOrigin: https://example.invalid\r\n\r\n"
                ),
            ),
            get(
                &host,
                &format!("/oauth/callback?code=fictional-code-9&state={state}"),
            ),
            get(
                &host,
                &format!("/ozzie/callback?code=a&code=b&state={state}"),
            ),
            raw(
                &host,
                &format!(
                    "POST /ozzie/callback?code=fictional-code-9&state={state} HTTP/1.1\r\nHost: {host}\r\nContent-Length: 0\r\n\r\n"
                ),
            ),
        ];
        (answers, browse(&url))
    });
    connect_using(
        &attempt,
        &hosted,
        &keys,
        &native(&hosted),
        &AtomicBool::new(false),
        &|| NOW,
        &dir.0,
    )
    .unwrap();
    let (answers, (status, page)) = poker.join().unwrap();
    for answer in &answers {
        assert!(answer.starts_with("HTTP/1.1 400 Bad Request"), "{answer}");
        // Review M7/L2: a request that isn't this attempt's gets the fixed stray page exactly; nothing reflected.
        let body = &answer[answer.find("\r\n\r\n").unwrap() + 4..];
        assert_eq!(
            body,
            crate::callback::outcome_page(crate::callback::Outcome::Stray)
        );
        assert!(
            answer.contains("Cache-Control: no-store") && answer.contains("frame-ancestors 'none'")
        );
    }
    assert_eq!(status, 200, "{page}");
    assert_eq!(keys.token().as_deref(), Some(FAKE_TOKENS[0]));
    // None of the ignored requests reached ozzie.church.
    assert_eq!(
        server.paths(),
        ["GET /connect", format!("POST {TOKEN_PATH}").as_str()]
    );
}

#[test]
fn connecting_ends_when_cancelled_declined_refused_or_after_five_minutes() {
    let server = FakeServer::start();
    let hosted = local(&server);
    let dir = TempDir::new("ends");
    let keys = MemoryKeys::default();
    let http = native(&hosted);
    // Cancelled here before the browser came back.
    let attempt = ConnectAttempt::begin(&hosted, NOW).unwrap();
    assert_eq!(
        connect_using(
            &attempt,
            &hosted,
            &keys,
            &http,
            &AtomicBool::new(true),
            &|| NOW,
            &dir.0
        )
        .err(),
        Some(ManagedError::Cancelled)
    );
    // Five minutes passed.
    let attempt = ConnectAttempt::begin(&hosted, NOW).unwrap();
    assert_eq!(
        connect_using(
            &attempt,
            &hosted,
            &keys,
            &http,
            &AtomicBool::new(false),
            &|| NOW + CONNECT_LIFETIME_MS,
            &dir.0
        )
        .err(),
        Some(ManagedError::Expired)
    );
    // Declined on ozzie.church: an error with this attempt's state.
    let attempt = ConnectAttempt::begin(&hosted, NOW).unwrap();
    let declined = std::thread::spawn({
        let (host, state) = (attempt.host.clone(), attempt.state.clone());
        move || {
            get(
                &host,
                &format!("/ozzie/callback?error=access_denied&state={state}"),
            )
        }
    });
    assert_eq!(
        connect_using(
            &attempt,
            &hosted,
            &keys,
            &http,
            &AtomicBool::new(false),
            &|| NOW,
            &dir.0
        )
        .err(),
        Some(ManagedError::Cancelled)
    );
    assert!(
        declined
            .join()
            .unwrap()
            .contains("<h1>This Mac isn't connected to Ozzie's AI</h1><p>If you paid, Personal is on your account: go back to Ozzie and press Try again. You won't be charged again.</p>")
    );
    // A malformed code with the right state ends it without asking ozzie.church.
    let attempt = ConnectAttempt::begin(&hosted, NOW).unwrap();
    let malformed = std::thread::spawn({
        let (host, state) = (attempt.host.clone(), attempt.state.clone());
        move || {
            get(
                &host,
                &format!("/ozzie/callback?code=has%20space&state={state}"),
            )
        }
    });
    assert_eq!(
        connect_using(
            &attempt,
            &hosted,
            &keys,
            &http,
            &AtomicBool::new(false),
            &|| NOW,
            &dir.0
        )
        .err(),
        Some(ManagedError::Refused)
    );
    assert!(malformed.join().unwrap().starts_with("HTTP/1.1 400"));
    assert!(server.requests().is_empty());
    // A code ozzie.church refuses (never issued, or used already).
    let attempt = ConnectAttempt::begin(&hosted, NOW).unwrap();
    let refused = std::thread::spawn({
        let (host, state) = (attempt.host.clone(), attempt.state.clone());
        move || {
            get(
                &host,
                &format!("/ozzie/callback?code=fictional-code-404&state={state}"),
            )
        }
    });
    assert_eq!(
        connect_using(
            &attempt,
            &hosted,
            &keys,
            &http,
            &AtomicBool::new(false),
            &|| NOW,
            &dir.0
        )
        .err(),
        Some(ManagedError::Refused)
    );
    assert!(
        refused
            .join()
            .unwrap()
            .contains("<h1>Ozzie couldn't finish connecting</h1>")
    );
    // Nothing was saved by any of them.
    assert_eq!(keys.token(), None);
    assert_eq!(dir.cached(), None);
}

#[test]
fn connecting_again_revokes_the_token_it_replaces_and_a_keychain_failure_keeps_nothing() {
    let server = FakeServer::start();
    let hosted = local(&server);
    let dir = TempDir::new("again");
    let keys = MemoryKeys::default();
    let http = native(&hosted);
    let connect = |keys: &MemoryKeys| {
        let attempt = ConnectAttempt::begin(&hosted, NOW).unwrap();
        let browser = std::thread::spawn({
            let url = attempt.url().to_owned();
            move || browse(&url)
        });
        let result = connect_using(
            &attempt,
            &hosted,
            keys,
            &http,
            &AtomicBool::new(false),
            &|| NOW,
            &dir.0,
        );
        let (_, page) = browser.join().unwrap();
        (result, page)
    };
    connect(&keys).0.unwrap();
    connect(&keys).0.unwrap();
    assert_eq!(keys.token().as_deref(), Some(FAKE_TOKENS[1]));
    let state = server.state.lock().unwrap();
    assert_eq!(state.revoked, [FAKE_TOKENS[0]]);
    assert_eq!(state.valid, [FAKE_TOKENS[1]]);
    let revoke = state
        .requests
        .iter()
        .find(|r| r.path == REVOKE_PATH)
        .unwrap();
    assert_eq!(
        revoke.authorization.as_deref(),
        Some(format!("Bearer {}", FAKE_TOKENS[0]).as_str())
    );
    drop(state);
    // The Keychain refuses the new token: it is revoked, and the page and the error say nothing about it.
    let refusing = MemoryKeys {
        refuse_writes: true,
        ..MemoryKeys::default()
    };
    let (result, page) = connect(&refusing);
    assert_eq!(result.err(), Some(ManagedError::Keychain));
    assert!(page.contains("<h1>Ozzie couldn't finish connecting</h1>"));
    assert_eq!(refusing.token(), None);
    assert_eq!(
        server.state.lock().unwrap().revoked,
        [FAKE_TOKENS[0], FAKE_TOKENS[2]]
    );
    no_token_in(&serde_json::to_string(&ManagedError::Keychain).unwrap());
}

#[test]
fn plan_and_usage_are_read_at_most_once_a_minute_and_the_last_reading_is_kept_offline() {
    let server = FakeServer::start();
    let hosted = local(&server);
    let dir = TempDir::new("account");
    let http = native(&hosted);
    server.with(|s| s.valid = vec![FAKE_TOKENS[0].into()]);
    // Not connected: nothing is asked.
    assert_eq!(
        account_using(&hosted, &MemoryKeys::default(), &http, &dir.0, NOW),
        AccountState::NotConnected
    );
    assert!(server.requests().is_empty());
    let keys = connected_keys(FAKE_TOKENS[0]);
    let first = Account {
        plan: "trial".into(),
        allowance_steps: 300,
        used_steps: 120,
        period_ends: "2026-12-01T00:00:00.000Z".into(),
        warning: None,
        checked_at_ms: NOW,
        offline: false,
        plan_reason: None,
        paused_until: None,
        answers_left: None,
    };
    assert_eq!(
        account_using(&hosted, &keys, &http, &dir.0, NOW),
        AccountState::Known(first.clone())
    );
    let requests = server.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(
        (requests[0].method.as_str(), requests[0].path.as_str()),
        ("GET", ACCOUNT_PATH)
    );
    assert_eq!(
        requests[0].authorization.as_deref(),
        Some(format!("Bearer {}", FAKE_TOKENS[0]).as_str())
    );
    // Within the minute: the saved reading, no request.
    assert_eq!(
        account_using(&hosted, &keys, &http, &dir.0, NOW + ACCOUNT_CACHE_MS - 1),
        AccountState::Known(first.clone())
    );
    assert_eq!(server.requests().len(), 1);
    // A clock that went back doesn't keep a reading forever.
    server.with(|s| s.account["used_steps"] = json!(240));
    server.with(|s| s.account["warning"] = json!("three-quarters"));
    let AccountState::Known(back) = account_using(&hosted, &keys, &http, &dir.0, NOW - 1) else {
        panic!("a reading");
    };
    assert_eq!(
        (back.used_steps, back.warning),
        (240, Some(Warning::ThreeQuarters))
    );
    // After the minute: asked again.
    let later = NOW + ACCOUNT_CACHE_MS;
    let AccountState::Known(second) = account_using(&hosted, &keys, &http, &dir.0, later) else {
        panic!("a reading");
    };
    assert_eq!(
        (second.used_steps, second.checked_at_ms, second.offline),
        (240, later, false)
    );
    assert_eq!(server.requests().len(), 3);
    // ozzie.church unreachable: the last reading, marked offline, with when it was read.
    drop(server);
    let AccountState::Known(offline) =
        account_using(&hosted, &keys, &http, &dir.0, later + 600_000)
    else {
        panic!("the last reading");
    };
    assert_eq!(
        offline,
        Account {
            offline: true,
            ..second.clone()
        }
    );
    // Nothing read before and nothing reachable: unknown.
    let fresh = TempDir::new("account-unknown");
    assert_eq!(
        account_using(&hosted, &keys, &http, &fresh.0, NOW),
        AccountState::Unknown
    );
    no_token_in(&dir.cached().unwrap());
}

#[test]
fn a_refused_token_asks_to_connect_again_and_attach_says_so() {
    let server = FakeServer::start();
    let hosted = local(&server);
    let dir = TempDir::new("reconnect");
    let http = native(&hosted);
    // A reading from before, then ozzie.church refuses the token (revoked on the account page).
    server.with(|s| s.valid = vec![FAKE_TOKENS[0].into()]);
    let keys = connected_keys(FAKE_TOKENS[0]);
    let AccountState::Known(account) = account_using(&hosted, &keys, &http, &dir.0, NOW) else {
        panic!("a reading");
    };
    server.with(|s| s.valid.clear());
    assert_eq!(
        account_using(&hosted, &keys, &http, &dir.0, NOW + ACCOUNT_CACHE_MS),
        AccountState::Reconnect
    );
    assert_eq!(dir.cached(), None);
    // On the managed route the app then says to connect again instead of "ready".
    save_config(&dir.0, Route::Managed, None, None).unwrap();
    let mut status = status_for(&dir.0, &keys, false);
    assert_eq!(
        (status.configured, status.setup, status.managed),
        (true, "ready", "connected")
    );
    attach(&mut status, AccountState::Reconnect);
    assert_eq!(
        (status.configured, status.setup, status.managed),
        (false, "reconnect", "reconnect")
    );
    assert!(status.account.is_none());
    let mut known = status_for(&dir.0, &keys, false);
    attach(&mut known, AccountState::Known(account.clone()));
    assert_eq!(
        (known.configured, known.managed, known.account.clone()),
        (true, "connected", Some(account))
    );
    no_token_in(&serde_json::to_string(&known).unwrap());
    // On another route only the managed row changes (a local model that answered its check).
    crate::model::save_local_checked(
        &dir.0,
        crate::model::LOCAL_BASE,
        crate::model::LOCAL_MODEL,
        1,
        crate::model::route_generation(&dir.0),
    )
    .unwrap();
    let mut local_status = status_for(&dir.0, &keys, false);
    attach(&mut local_status, AccountState::Reconnect);
    assert_eq!(
        (
            local_status.configured,
            local_status.setup,
            local_status.managed
        ),
        (true, "ready", "reconnect")
    );
    let mut none = status_for(&dir.0, &MemoryKeys::default(), false);
    attach(&mut none, AccountState::NotConnected);
    assert_eq!(none.managed, "not-connected");
}

#[test]
fn only_checked_plan_and_usage_fields_are_kept() {
    let server = FakeServer::start();
    let hosted = local(&server);
    let http = native(&hosted);
    server.with(|s| s.valid = vec![FAKE_TOKENS[0].into()]);
    let keys = connected_keys(FAKE_TOKENS[0]);
    let good = json!({"plan":"small-church","allowance_steps":300,"used_steps":290,"period_ends":"2026-12-01","warning":"nine-tenths"});
    let with = |field: &str, value: Value| {
        let mut account = good.clone();
        account[field] = value;
        account
    };
    let mut without_used = good.clone();
    without_used.as_object_mut().unwrap().remove("used_steps");
    for bad in [
        with("plan", json!("Small Church")),
        with("plan", json!("")),
        with("plan", json!("-trial")),
        with("plan", json!("a".repeat(33))),
        with("plan", json!(7)),
        with("allowance_steps", json!(100_000_001)),
        with("used_steps", json!(-1)),
        with("period_ends", json!("2026-13-01")),
        with("period_ends", json!("December 1")),
        with("period_ends", json!("2026-12-01T00:00:00Z <b>")),
        with("period_ends", json!("2026-12-01 00:00")),
        with("warning", json!("half")),
        with("warning", json!(3)),
        without_used,
        json!("not an object"),
    ] {
        let dir = TempDir::new("fields");
        server.with(|s| s.account = bad.clone());
        assert_eq!(
            account_using(&hosted, &keys, &http, &dir.0, NOW),
            AccountState::Unknown,
            "{bad}"
        );
        assert_eq!(dir.cached(), None);
    }
    // Fields ozzie.church may add later are never kept or shown.
    let dir = TempDir::new("fields-extra");
    server.with(|s| s.account = with("email", json!("pat@example.invalid")));
    let AccountState::Known(account) = account_using(&hosted, &keys, &http, &dir.0, NOW) else {
        panic!("a reading");
    };
    assert_eq!(
        (account.plan.as_str(), account.warning),
        ("small-church", Some(Warning::NineTenths))
    );
    let shown = serde_json::to_string(&account).unwrap();
    assert!(!shown.contains("email") && !dir.cached().unwrap().contains("email"));
    // A saved reading that was tampered with is not used.
    std::fs::write(
        dir.0.join(ACCOUNT_FILE),
        shown.replace("small-church", "Pastor Dave"),
    )
    .unwrap();
    assert_eq!(read_cache(&dir.0), None);
}

#[test]
fn the_token_reply_warning_comes_from_the_counts_and_warnings_are_a_closed_set() {
    assert_eq!(Warning::for_counts(0, 300), None);
    assert_eq!(Warning::for_counts(224, 300), None);
    assert_eq!(Warning::for_counts(225, 300), Some(Warning::ThreeQuarters));
    assert_eq!(Warning::for_counts(270, 300), Some(Warning::NineTenths));
    assert_eq!(Warning::for_counts(300, 300), Some(Warning::Paused));
    assert_eq!(Warning::for_counts(0, 0), Some(Warning::Paused));
    assert_eq!(
        Warning::for_counts(u64::MAX, u64::MAX - 1),
        Some(Warning::Paused)
    );
    let codes: Vec<String> = [Warning::ThreeQuarters, Warning::NineTenths, Warning::Paused]
        .iter()
        .map(|w| serde_json::to_string(w).unwrap())
        .collect();
    assert_eq!(
        codes,
        ["\"three-quarters\"", "\"nine-tenths\"", "\"paused\""]
    );
}

#[test]
fn disconnecting_revokes_then_deletes_the_token_even_when_ozzie_church_is_unreachable() {
    let server = FakeServer::start();
    let hosted = local(&server);
    let dir = TempDir::new("disconnect");
    let http = native(&hosted);
    server.with(|s| s.valid = vec![FAKE_TOKENS[0].into()]);
    let keys = connected_keys(FAKE_TOKENS[0]);
    assert!(matches!(
        account_using(&hosted, &keys, &http, &dir.0, NOW),
        AccountState::Known(_)
    ));
    assert!(dir.cached().is_some());
    let choices = crate::model::route_generation(&dir.0);
    disconnect_using(&hosted, &keys, &http, &dir.0).unwrap();
    assert_eq!(keys.token(), None);
    assert_eq!(dir.cached(), None);
    // Signing out is a choice of AI: a check under way then doesn't switch the AI when it finishes (review M-2).
    assert_ne!(crate::model::route_generation(&dir.0), choices);
    let state = server.state.lock().unwrap();
    assert_eq!(state.revoked, [FAKE_TOKENS[0]]);
    let revoke = state
        .requests
        .iter()
        .find(|r| r.path == REVOKE_PATH)
        .unwrap();
    assert_eq!(
        revoke.authorization.as_deref(),
        Some(format!("Bearer {}", FAKE_TOKENS[0]).as_str())
    );
    drop(state);
    // Unreachable: the token is still deleted from this Mac.
    drop(server);
    let keys = connected_keys(FAKE_TOKENS[1]);
    disconnect_using(&hosted, &keys, &http, &dir.0).unwrap();
    assert_eq!(keys.token(), None);
    // The Keychain refuses: said plainly, never with the token.
    let refusing = MemoryKeys {
        refuse_writes: true,
        ..connected_keys(FAKE_TOKENS[2])
    };
    assert_eq!(
        disconnect_using(&hosted, &refusing, &http, &dir.0).err(),
        Some(ManagedError::Keychain)
    );
}

#[test]
fn ozzie_church_refusals_and_connect_errors_are_closed_vocabularies() {
    use ModelError::*;
    assert_eq!(refusal(200, b"{}"), None);
    assert_eq!(
        refusal(402, br#"{"error":"allowance-paused"}"#),
        Some(AllowancePaused)
    );
    assert_eq!(
        refusal(402, br#"{"error":"something-else"}"#),
        Some(ProviderFailure)
    );
    assert_eq!(refusal(402, b"allowance-paused"), Some(ProviderFailure));
    assert_eq!(
        refusal(401, br#"{"error":"unauthorized"}"#),
        Some(NotConfigured)
    );
    for status in [400, 403, 404, 422, 429, 500, 502, 503] {
        assert_eq!(
            refusal(status, br#"{"error":"allowance-paused"}"#),
            Some(ProviderFailure),
            "{status}"
        );
    }
    // The codes the Mac can explain each get their own error (review of 2026-11-14), only with
    // their own status; anything else stays provider-failure.
    assert_eq!(
        refusal(429, br#"{"error":"rate-limited"}"#),
        Some(RateLimited)
    );
    assert_eq!(refusal(429, br#"{"error":"step-limit"}"#), Some(StepLimit));
    assert_eq!(
        refusal(400, br#"{"error":"contact-detail"}"#),
        Some(ContactDetail)
    );
    // ozzie.church found background-check wording before the AI (web/ background.ts).
    assert_eq!(
        refusal(400, br#"{"error":"background-check"}"#),
        Some(BackgroundCheck)
    );
    assert_eq!(
        refusal(400, br#"{"error":"hidden-character"}"#),
        Some(HiddenCharacter)
    );
    assert_eq!(
        refusal(429, br#"{"error":"hidden-character"}"#),
        Some(ProviderFailure)
    );
    for status in [402, 403, 429, 502] {
        assert_eq!(
            refusal(status, br#"{"error":"background-check"}"#),
            Some(ProviderFailure),
            "{status}"
        );
    }
    assert_eq!(
        serde_json::to_string(&BackgroundCheck).unwrap(),
        "\"background-check\""
    );
    assert_eq!(
        serde_json::to_string(&crate::agent::AgentError::from(BackgroundCheck)).unwrap(),
        "\"background-check\""
    );
    assert_eq!(
        refusal(400, br#"{"error":"invalid-request"}"#),
        Some(ProviderFailure)
    );
    assert_eq!(
        refusal(400, br#"{"error":"step-limit"}"#),
        Some(ProviderFailure)
    );
    assert_eq!(
        refusal(429, br#"{"error":"contact-detail"}"#),
        Some(ProviderFailure)
    );
    assert_eq!(refusal(429, b"step-limit"), Some(ProviderFailure));
    // ozzie.church refused AI Gateway's reply for lacking the zero data retention confirmation
    // (web/ errors.ts): the generic failure, as for any other upstream problem.
    assert_eq!(
        refusal(502, br#"{"error":"retention-unconfirmed"}"#),
        Some(ProviderFailure)
    );
    assert_eq!(
        serde_json::to_string(&AllowancePaused).unwrap(),
        "\"allowance-paused\""
    );
    assert_eq!(
        serde_json::to_string(&ContactDetail).unwrap(),
        "\"contact-detail\""
    );
    assert_eq!(serde_json::to_string(&StepLimit).unwrap(), "\"step-limit\"");
    assert!(matches!(
        crate::agent::AgentError::from(StepLimit),
        crate::agent::AgentError::Limit
    ));
    assert_eq!(
        serde_json::to_string(&crate::agent::AgentError::from(ContactDetail)).unwrap(),
        "\"contact-detail\""
    );
    let codes: Vec<String> = [
        ManagedError::Busy,
        ManagedError::Unavailable,
        ManagedError::BrowserUnavailable,
        ManagedError::Cancelled,
        ManagedError::Expired,
        ManagedError::Refused,
        ManagedError::ProviderFailure,
        ManagedError::Keychain,
    ]
    .iter()
    .map(|e| serde_json::to_string(e).unwrap())
    .collect();
    assert_eq!(
        codes,
        [
            "\"busy\"",
            "\"unavailable\"",
            "\"browser-unavailable\"",
            "\"cancelled\"",
            "\"expired\"",
            "\"refused\"",
            "\"provider-failure\"",
            "\"keychain\""
        ]
    );
    // Tokens: base64url, 32 to 256 characters.
    assert!(token_ok(FAKE_TOKENS[0]));
    for bad in [
        "short",
        "has space aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        &"a".repeat(257),
        "padded=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ] {
        assert!(!token_ok(bad), "{bad}");
    }
    assert!(!connected(&connected_keys("short")));
}

// ---- Ozzie's AI, paid in one browser trip (onboarding spec S10, lane N7) -----------------------------------------

#[test]
fn a_paid_connect_names_the_plan_waits_an_hour_and_knows_no_payment_was_taken() {
    let server = FakeServer::start();
    let hosted = local(&server);
    let dir = TempDir::new("paid");
    let keys = MemoryKeys::default();
    let attempt = ConnectAttempt::begin_for(&hosted, NOW, Some("personal")).unwrap();
    let url = url::Url::parse(attempt.url()).unwrap();
    let names: Vec<String> = url.query_pairs().map(|(k, _)| k.into_owned()).collect();
    assert_eq!(
        names,
        [
            "redirect_port",
            "state",
            "code_challenge",
            "device_label",
            "plan"
        ]
    );
    assert!(attempt.url().ends_with("&plan=personal"));
    assert_eq!(attempt.expires_ms, NOW + 60 * 60_000);
    // A connect without a plan still waits five minutes, as a Planning Center sign-in does.
    assert_eq!(
        ConnectAttempt::begin(&hosted, NOW).unwrap().expires_ms,
        NOW + 5 * 60_000
    );
    // Only a plan on sale may be asked for.
    for plan in ["team", "church", "leader", "", "personal&x=1"] {
        assert_eq!(
            ConnectAttempt::begin_for(&hosted, NOW, Some(plan)).err(),
            Some(ManagedError::Unavailable),
            "{plan}"
        );
    }
    // Stripe's back button: ozzie.church sends the browser back with error=payment_cancelled.
    let back = std::thread::spawn({
        let (host, state) = (attempt.host.clone(), attempt.state.clone());
        move || {
            get(
                &host,
                &format!("/ozzie/callback?error=payment_cancelled&state={state}"),
            )
        }
    });
    assert_eq!(
        connect_using(
            &attempt,
            &hosted,
            &keys,
            &native(&hosted),
            &AtomicBool::new(false),
            &|| NOW,
            &dir.0
        )
        .err(),
        Some(ManagedError::PaymentCancelled)
    );
    let page = back.join().unwrap();
    assert!(page.contains("<h1>No payment was taken</h1>"));
    assert!(keys.token().is_none());
    assert_eq!(
        serde_json::to_string(&ManagedError::PaymentCancelled).unwrap(),
        r#""payment-cancelled""#
    );
    // Website change 02a4df66: after paying, the person presses "Connect this Mac" before any callback comes,
    // and a plan not yet applied sends them to the account page with no callback at all. The listener waits the
    // whole hour for a slow payer (a first payment that failed, then a second), then ends as a closed "not-finished":
    // try again re-opens the connect step (the site shows "Connect this Mac" without charging an account that already
    // has the plan).
    let attempt = ConnectAttempt::begin_for(&hosted, NOW, Some("personal")).unwrap();
    assert_eq!(
        connect_using(
            &attempt,
            &hosted,
            &keys,
            &native(&hosted),
            &AtomicBool::new(false),
            &|| NOW + PAID_CONNECT_LIFETIME_MS,
            &dir.0
        )
        .err(),
        Some(ManagedError::NotFinished)
    );
    assert_eq!(
        serde_json::to_string(&ManagedError::NotFinished).unwrap(),
        r#""not-finished""#
    );
    // A slow payer is still heard at minute 31, just after the first Stripe page lapsed (review L8: the case this
    // comment named is tested, not only said), and at minute 59.
    let early = ConnectAttempt::begin_for(&hosted, NOW, Some("personal")).unwrap();
    let heard = std::thread::spawn({
        let (host, state) = (early.host.clone(), early.state.clone());
        move || {
            get(
                &host,
                &format!("/ozzie/callback?error=payment_cancelled&state={state}"),
            )
        }
    });
    assert_eq!(
        connect_using(
            &early,
            &hosted,
            &keys,
            &native(&hosted),
            &AtomicBool::new(false),
            &|| NOW + 31 * 60_000,
            &dir.0
        )
        .err(),
        Some(ManagedError::PaymentCancelled)
    );
    heard.join().unwrap();
    let attempt = ConnectAttempt::begin_for(&hosted, NOW, Some("personal")).unwrap();
    let late = std::thread::spawn({
        let (host, state) = (attempt.host.clone(), attempt.state.clone());
        move || {
            get(
                &host,
                &format!("/ozzie/callback?error=payment_cancelled&state={state}"),
            )
        }
    });
    assert_eq!(
        connect_using(
            &attempt,
            &hosted,
            &keys,
            &native(&hosted),
            &AtomicBool::new(false),
            &|| NOW + 59 * 60_000,
            &dir.0
        )
        .err(),
        Some(ManagedError::PaymentCancelled)
    );
    late.join().unwrap();
    // The receiver listens on 127.0.0.1 at a port the site accepts (1024-65535), path /ozzie/callback only.
    let port: u16 = attempt
        .host
        .strip_prefix("127.0.0.1:")
        .unwrap()
        .parse()
        .unwrap();
    assert!(port >= 1024);
    // A connect without a plan keeps Planning Center's five minutes and its plain "expired".
    let attempt = ConnectAttempt::begin(&hosted, NOW).unwrap();
    assert_eq!(
        connect_using(
            &attempt,
            &hosted,
            &keys,
            &native(&hosted),
            &AtomicBool::new(false),
            &|| NOW + CONNECT_LIFETIME_MS,
            &dir.0
        )
        .err(),
        Some(ManagedError::Expired)
    );
    assert_eq!(PAID_CONNECT_LIFETIME_MS, 3_600_000, "a paid connect waits an hour");
    assert_eq!(
        CONNECT_LIFETIME_MS, 300_000,
        "Planning Center's sign-in keeps five minutes"
    );
}

/// ozzie.church's GETs answered from a list: (path, status, body).
struct Answers(Vec<(&'static str, u16, &'static str)>);
impl ModelHttp for Answers {
    fn post(
        &self,
        _: &str,
        _: Option<(&str, crate::model::KeyHeader)>,
        _: &[(&str, &str)],
        _: &[u8],
    ) -> Result<(u16, Zeroizing<Vec<u8>>), ModelError> {
        panic!("reading the offer or the account posts nothing")
    }
    fn get(&self, url: &str, _: Option<&str>) -> Result<(u16, Zeroizing<Vec<u8>>), ModelError> {
        self.0
            .iter()
            .find(|(path, _, _)| url.ends_with(path))
            .map(|(_, status, body)| (*status, Zeroizing::new(body.as_bytes().to_vec())))
            .ok_or(ModelError::ProviderFailure)
    }
}

#[test]
fn the_offer_is_shown_only_as_ozzie_church_gives_it_and_closed_otherwise() {
    let hosted = HostedConfig::from_env(false, None);
    let open = r#"{"open":true,"plan":"personal","price_text":"$19 a month","answers_text":"About 400 answers a month","extra":"ignored"}"#;
    let offer = offer_using(&hosted, &Answers(vec![(OFFER_PATH, 200, open)]));
    assert_eq!(
        serde_json::to_string(&offer).unwrap(),
        r#"{"open":true,"plan":"personal","price_text":"$19 a month","answers_text":"About 400 answers a month","reason":null}"#
    );
    let closed = |body: &'static str| offer_using(&hosted, &Answers(vec![(OFFER_PATH, 200, body)]));
    for body in [
        r#"{"open":false}"#,
        r#"{"open":true,"plan":"team","price_text":"$59 a month","answers_text":"About 2000 answers"}"#,
        r#"{"open":true,"plan":"personal","price_text":"<b>$19</b>","answers_text":"About 400 answers a month"}"#,
        r#"{"open":true,"plan":"personal","price_text":"$19 a month, see https://evil.example","answers_text":"x"}"#,
        r#"{"open":true,"plan":"personal","price_text":"","answers_text":"About 400 answers a month"}"#,
        r#"{"open":true,"plan":"personal"}"#,
        "not json",
    ] {
        assert_eq!(
            (closed(body).open, closed(body).reason),
            (false, Some("closed")),
            "{body}"
        );
    }
    for answers in [vec![(OFFER_PATH, 503, "")], vec![]] {
        let offer = offer_using(&hosted, &Answers(answers));
        assert_eq!(
            (offer.open, offer.reason, offer.price_text),
            (false, Some("unreachable"), None)
        );
    }
}

#[test]
fn why_there_is_no_plan_is_one_of_a_few_words_and_a_fresh_reading_skips_the_minute() {
    let hosted = HostedConfig::from_env(false, None);
    let dir = TempDir::new("reason");
    let token = Zeroizing::new(FAKE_TOKENS[0].to_owned());
    let body = |reason: &str| -> &'static str {
        Box::leak(format!(r#"{{"plan":"none","allowance_steps":0,"used_steps":0,"period_ends":"2026-12-17","plan_reason":"{reason}"}}"#).into_boxed_str())
    };
    for (sent, kept) in [
        ("payment-failed", Some("payment-failed")),
        ("cancelled", Some("cancelled")),
        ("none", Some("none")),
        ("card declined at <bank>", None),
    ] {
        let http = Answers(vec![(ACCOUNT_PATH, 200, body(sent))]);
        let AccountState::Known(account) =
            account_reading(&hosted, &token, &http, &dir.0, NOW, false)
        else {
            panic!("{sent}");
        };
        assert_eq!(account.plan_reason.as_deref(), kept, "{sent}");
    }
    // A reading from a second ago: the regular status uses it; the poll after paying asks again.
    let paid = Answers(vec![(
        ACCOUNT_PATH,
        200,
        r#"{"plan":"personal","allowance_steps":1500,"used_steps":0,"period_ends":"2026-12-17"}"#,
    )]);
    let AccountState::Known(cached) =
        account_reading(&hosted, &token, &paid, &dir.0, NOW + 1_000, true)
    else {
        panic!("cached");
    };
    assert_eq!(cached.plan, "none");
    let AccountState::Known(fresh) =
        account_reading(&hosted, &token, &paid, &dir.0, NOW + 1_000, false)
    else {
        panic!("fresh");
    };
    assert_eq!((fresh.plan.as_str(), fresh.plan_reason), ("personal", None));
}

// ---- Re-check NM1: why ozzie.church asked Ozzie to wait, and until when -------------------------------------------

#[test]
fn review_nm1_a_daily_ceiling_is_its_own_code_and_the_account_says_until_when() {
    let refused = |body: &str| refusal(429, body.as_bytes());
    assert_eq!(
        refused(
            r#"{"error":"rate-limited","reason":"daily-limit","paused_until":"2026-11-18T00:00:00.000Z"}"#
        ),
        Some(ModelError::DailyLimit)
    );
    assert_eq!(
        refused(r#"{"error":"rate-limited","reason":"busy"}"#),
        Some(ModelError::RateLimited)
    );
    assert_eq!(
        refused(r#"{"error":"rate-limited"}"#),
        Some(ModelError::RateLimited)
    );
    assert_eq!(
        refused(r#"{"error":"rate-limited","reason":"something new"}"#),
        Some(ModelError::RateLimited)
    );
    // The account carries when the pause ends and the answers left, checked; anything else is dropped.
    let hosted = HostedConfig::from_env(false, None);
    let dir = TempDir::new("paused-until");
    let token = Zeroizing::new(FAKE_TOKENS[0].to_owned());
    let read = |body: &'static str| {
        let AccountState::Known(account) = account_reading(
            &hosted,
            &token,
            &Answers(vec![(ACCOUNT_PATH, 200, body)]),
            &dir.0,
            NOW,
            false,
        ) else {
            panic!("{body}")
        };
        account
    };
    let paused = read(
        r#"{"plan":"personal","allowance_steps":1500,"used_steps":1500,"period_ends":"2026-12-17","paused_until":"2026-12-17T00:00:00.000Z","answers_left":0}"#,
    );
    assert_eq!(
        (paused.paused_until.as_deref(), paused.answers_left),
        (Some("2026-12-17T00:00:00.000Z"), Some(0))
    );
    let odd = read(
        r#"{"plan":"personal","allowance_steps":1500,"used_steps":10,"period_ends":"2026-12-17","paused_until":"tomorrow <b>","answers_left":99999999999}"#,
    );
    assert_eq!((odd.paused_until, odd.answers_left), (None, None));
    let none = read(
        r#"{"plan":"personal","allowance_steps":1500,"used_steps":10,"period_ends":"2026-12-17"}"#,
    );
    assert_eq!((none.paused_until, none.answers_left), (None, None));
}
