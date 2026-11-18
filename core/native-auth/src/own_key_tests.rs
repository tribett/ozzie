//! The church's own key over a fake company and a fake Keychain: each company's recorded answers give each
//! verdict, the request rules each company needs, and the key never leaving native code. Fictional keys only.
use super::*;
use crate::agent;
use crate::model::DraftRequest;
use std::collections::BTreeMap;

// Fictional keys, written in parts so no line of this file looks like a real key to the export scan.
const OPENAI_KEY: &str = concat!("sk-", "proj-fictional0canary0key0openai0000");
const ANTHROPIC_KEY: &str = concat!("sk-", "ant-api03-fictional0canary0key0anthropic");
const GEMINI_KEY: &str = concat!("AI", "zaFictional0Canary0Key0Gemini000000");
const OTHER_KEY: &str = "fictional0canary0key0for0another0company";

struct TempDir(std::path::PathBuf);
impl TempDir {
    fn new(label: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "ozzie-own-key-{label}-{}-{}",
            std::process::id(),
            crate::sunday_check::unix_ms()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The Keychain: saved keys by account, or refusing every save (or every removal, or every listing).
#[derive(Default)]
struct FakeStore {
    keys: Mutex<BTreeMap<String, String>>,
    refuse: bool,
    refuse_delete: bool,
    unlistable: bool,
}
impl ModelKeys for FakeStore {
    fn key(&self, account: &str) -> Result<Option<Zeroizing<String>>, StoreError> {
        Ok(self
            .keys
            .lock()
            .unwrap()
            .get(account)
            .map(|k| Zeroizing::new(k.clone())))
    }
}
impl KeyStore for FakeStore {
    fn put_key(&self, account: &str, key: &str) -> Result<(), StoreError> {
        if self.refuse {
            return Err(StoreError::Locked);
        }
        self.keys.lock().unwrap().insert(account.into(), key.into());
        Ok(())
    }
    fn delete_key(&self, account: &str) -> Result<(), StoreError> {
        if self.refuse_delete {
            return Err(StoreError::Locked);
        }
        self.keys.lock().unwrap().remove(account);
        Ok(())
    }
    fn accounts(&self) -> Result<Vec<String>, StoreError> {
        if self.unlistable {
            return Err(StoreError::Unavailable);
        }
        Ok(self.keys.lock().unwrap().keys().cloned().collect())
    }
}

/// A company that answers each check with the next recorded answer (or a plain 200).
#[derive(Default)]
struct Company {
    sent: Mutex<Vec<(String, Option<String>, Value)>>,
    headers: Mutex<Vec<Vec<(String, String)>>>,
    /// The header each key travelled in.
    key_headers: Mutex<Vec<Option<model::KeyHeader>>>,
    answers: Mutex<Vec<Result<(u16, String), ModelError>>>,
}
impl Company {
    fn answering(answer: Result<(u16, &str), ModelError>) -> Self {
        let company = Self::default();
        company
            .answers
            .lock()
            .unwrap()
            .push(answer.map(|(s, b)| (s, b.to_string())));
        company
    }
    fn count(&self) -> usize {
        self.sent.lock().unwrap().len()
    }
}
impl ModelHttp for Company {
    fn post(
        &self,
        url: &str,
        key: Option<(&str, model::KeyHeader)>,
        headers: &[(&str, &str)],
        body: &[u8],
    ) -> Result<(u16, Zeroizing<Vec<u8>>), ModelError> {
        assert!(!url.contains('?'), "no query string is ever sent: {url}");
        self.key_headers
            .lock()
            .unwrap()
            .push(key.map(|(_, header)| header));
        let key = key.map(|(key, _)| key);
        self.headers.lock().unwrap().push(
            headers
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
        );
        self.sent.lock().unwrap().push((
            url.into(),
            key.map(Into::into),
            serde_json::from_slice(body).unwrap(),
        ));
        let mut answers = self.answers.lock().unwrap();
        let answer = if answers.is_empty() {
            Ok((
                200,
                r#"{"choices":[{"message":{"content":"OK"}}]}"#.to_string(),
            ))
        } else {
            answers.remove(0)
        };
        answer.map(|(s, b)| (s, Zeroizing::new(b.into_bytes())))
    }
}

// The companies as they will be once the owner's live test passed (decision 19 refuses them before that; its own
// test uses the catalog as it is).
fn openai() -> Choice {
    verified("openai")
}
fn anthropic() -> Choice {
    verified("anthropic")
}
fn gemini() -> Choice {
    verified("gemini")
}
fn other() -> Choice {
    Choice::parse(
        "other",
        Some("https://api.example.invalid/v1".into()),
        Some("fictional-model-1".into()),
    )
    .unwrap()
}
fn names() -> NameGuard {
    let mut guard = NameGuard::default();
    guard.remember(["Riley Thornbury".to_string()].iter());
    guard
}

#[test]
fn the_catalog_lists_the_three_companies_in_the_specs_order_with_their_rules() {
    let catalog = catalog();
    let ids: Vec<&str> = catalog.presets.iter().map(|p| p.id.as_str()).collect();
    assert_eq!(ids, ["openai", "anthropic", "gemini"]);
    assert_eq!(preset("openai").unwrap().tag.as_deref(), Some("easiest"));
    assert!(catalog.presets[1..].iter().all(|p| p.tag.is_none()));
    assert!(crate::civil::day_of_text(&catalog.checked_on).is_some());
    // Checked live by the owner with real keys from all three companies, 2026-11-18 (spec 10.3).
    assert!(catalog.verified_live);
    for p in &catalog.presets {
        let config = RouteConfig::new(Route::Own, Some(&p.base_url), Some(&p.model)).unwrap();
        // Claude through Anthropic's own Messages API; the others through Chat Completions.
        let path = if p.wire == ANTHROPIC_MESSAGES {
            "messages"
        } else {
            "chat/completions"
        };
        assert_eq!(config.endpoint().unwrap(), format!("{}/{path}", p.base_url));
        assert!(["max_tokens", "max_completion_tokens"].contains(&p.token_field.as_str()));
        assert!(!p.key_prefixes.is_empty() && p.key_prefixes.iter().all(|k| k.len() >= 3));
        for step in ["sign-in", "billing", "keys", "settings"] {
            assert!(
                p.page(step).unwrap().starts_with("https://"),
                "{} {step}",
                p.id
            );
            assert_eq!(help_page(&format!("{}-{step}", p.id)), p.page(step));
        }
        // Every company the page shows says what it keeps.
        assert!(p.retention_line.ends_with('.') && p.retention_line.len() < 300);
    }
    assert!(preset("gemini").unwrap().free_plan);
    assert_eq!(
        help_page("ollama-download"),
        Some(catalog.local.ollama_download.as_str())
    );
    assert!(
        catalog
            .local
            .ollama_download
            .starts_with("https://ollama.com/")
    );
    for bad in [
        "openai",
        "openai-",
        "openai-delete",
        "other-keys",
        "ollama",
        "",
        "gemini-keys-x",
    ] {
        assert_eq!(help_page(bad), None, "{bad}");
    }
    let local = &catalog.local;
    assert!(
        local.small.size_bytes < local.medium.size_bytes
            && local.medium.size_bytes < local.large.size_bytes
    );
    // The page's cards carry no page address.
    let cards = serde_json::to_string(&providers()).unwrap();
    assert!(!cards.contains("https://"));
    assert!(cards.contains(r#""id":"openai","name":"ChatGPT","company":"OpenAI","tag":"easiest""#));
}

#[test]
fn each_company_gets_the_request_rules_its_current_models_accept() {
    let draft = DraftRequest {
        system: model::SYSTEM.into(),
        user: format!(
            "Make it warmer.{}Hi [Volunteer A], can you help?",
            model::NOTE_PREFIX
        ),
        max_tokens: 120,
    };
    let body = |config: &RouteConfig| model::request_body(config, &draft).unwrap();
    let preset_config = |id: &str| openai_like(id);
    // OpenAI (gpt-6-luna): max_completion_tokens, no temperature, and reasoning "none", the only effort with which
    // Chat Completions allows function calling on it (provider research, 2026-11-17).
    let b = body(&preset_config("openai"));
    assert_eq!(b["model"], "gpt-6-luna");
    assert_eq!(b["max_completion_tokens"], 120);
    assert!(b.get("max_tokens").is_none() && b.get("temperature").is_none());
    assert_eq!(b["reasoning_effort"], "none");
    // Anthropic: its own Messages API (anthropic.rs): system lifted out, thinking off, no temperature.
    let b = body(&preset_config("anthropic"));
    assert_eq!(b["model"], "claude-haiku-5-5");
    assert_eq!(b["max_tokens"], 120);
    assert_eq!(b["system"], model::SYSTEM);
    assert_eq!(b["thinking"], json!({"type": "disabled"}));
    assert_eq!(b["messages"].as_array().unwrap().len(), 1);
    assert!(b.get("temperature").is_none() && b.get("reasoning_effort").is_none());
    // Gemini (gemini-3.5-flash-lite): temperature is deprecated there and will be refused, so none; its default
    // thinking (minimal) stands, as its reasoning mapping isn't documented for this model.
    let b = body(&preset_config("gemini"));
    assert_eq!(b["model"], "gemini-3.5-flash-lite");
    assert_eq!(b["max_tokens"], 120);
    assert!(b.get("temperature").is_none() && b.get("reasoning_effort").is_none());
    // Another company, a local model and Ozzie's AI keep the body Ozzie has always sent, except that a model on this
    // Mac is asked not to think first (providers.json `local.reasoning_effort`; live test, 2026-11-18).
    for (config, effort) in [
        (other().config().unwrap(), None),
        (
            RouteConfig::new(Route::Local, None, None).unwrap(),
            Some("none"),
        ),
        (RouteConfig::managed(), None),
    ] {
        let b = body(&config);
        assert_eq!(
            (b["max_tokens"].clone(), b["temperature"].clone()),
            (json!(120), json!(0.4))
        );
        assert_eq!(b.get("reasoning_effort").and_then(Value::as_str), effort);
        assert!(b.get("max_completion_tokens").is_none());
    }
    // An agent step on the same route gets the same rules.
    let Ok(request) = agent::parse_request(json!({
        "task_id": "ask-1", "max_tokens": 600, "tools": [],
        "messages": [{"role": "system", "content": "Answer from the facts."}, {"role": "user", "content": "Is [Role] covered?"}],
    })) else {
        panic!("a request in the contract's shape");
    };
    let step = agent::step_body(&preset_config("openai"), &request);
    assert_eq!(step["max_completion_tokens"], 600);
    assert!(step.get("temperature").is_none() && step.get("max_tokens").is_none());
    let step = agent::step_body(&preset_config("anthropic"), &request);
    assert_eq!(
        (step["max_tokens"].clone(), step.get("temperature")),
        (json!(600), None)
    );
    assert_eq!(step["thinking"], json!({"type": "disabled"}));
    let step = agent::step_body(&other().config().unwrap(), &request);
    assert_eq!(
        (step["max_tokens"].clone(), step["temperature"].is_number()),
        (json!(600), true)
    );
    // The rules follow the host, so a company's own address typed under "Another AI company" gets them too.
    let typed = RouteConfig::new(
        Route::Own,
        Some("https://api.openai.com/v1"),
        Some("gpt-5-nano"),
    )
    .unwrap();
    assert_eq!(preset_for(&typed).map(|p| p.id.as_str()), Some("openai"));
}
fn openai_like(id: &str) -> RouteConfig {
    match Choice::parse(id, None, None).unwrap() {
        choice @ Choice::Preset(_) => choice.config().unwrap(),
        Choice::Other { .. } => unreachable!(),
    }
}

#[test]
fn a_keys_shape_is_checked_before_anything_is_sent_and_another_companys_key_is_named() {
    assert_eq!(owner_of(OPENAI_KEY).unwrap().id, "openai");
    assert_eq!(
        owner_of(ANTHROPIC_KEY).unwrap().id,
        "anthropic",
        "the longest prefix wins"
    );
    assert_eq!(owner_of(GEMINI_KEY).unwrap().id, "gemini");
    assert!(owner_of(OTHER_KEY).is_none());
    assert_eq!(shape_verdict(&openai(), OPENAI_KEY), Ok(()));
    assert_eq!(
        shape_verdict(&openai(), ANTHROPIC_KEY),
        Err((Verdict::WrongKind, Some("anthropic")))
    );
    assert_eq!(
        shape_verdict(&anthropic(), OPENAI_KEY),
        Err((Verdict::WrongKind, Some("openai")))
    );
    assert_eq!(
        shape_verdict(&gemini(), ANTHROPIC_KEY),
        Err((Verdict::WrongKind, Some("anthropic")))
    );
    assert_eq!(
        shape_verdict(&openai(), OTHER_KEY),
        Err((Verdict::NotAKey, None))
    );
    // Another company takes any whole key, but never a known company's key (security review, finding 2).
    assert_eq!(shape_verdict(&other(), OTHER_KEY), Ok(()));
    assert_eq!(
        shape_verdict(&other(), OPENAI_KEY),
        Err((Verdict::WrongKind, Some("openai")))
    );
    for bad in [
        "sk-short",
        "sk-proj-has a space in the middle0000",
        "sk-proj-two\nlines0000000000000",
        "",
        "sk-proj-émoji0000000000000000",
    ] {
        assert_eq!(
            shape_verdict(&openai(), bad).unwrap_err().0,
            Verdict::NotAKey,
            "{bad:?}"
        );
    }
    assert_eq!(trimmed(&format!("  {OPENAI_KEY}\n")), OPENAI_KEY);
}

#[test]
fn each_companys_recorded_answers_give_each_verdict() {
    let ok = |c: &Choice, status: u16, body: &str| classify(c, Ok((status, body.as_bytes())));
    // OpenAI.
    let c = openai();
    assert_eq!(ok(&c, 200, "{}"), Verdict::Works);
    assert_eq!(
        ok(
            &c,
            401,
            r#"{"error":{"message":"Incorrect API key provided: sk-proj-****.","type":"invalid_request_error","code":"invalid_api_key"}}"#
        ),
        Verdict::Refused
    );
    assert_eq!(
        ok(
            &c,
            429,
            r#"{"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota","code":"insufficient_quota"}}"#
        ),
        Verdict::NoCredit
    );
    assert_eq!(
        ok(
            &c,
            429,
            r#"{"error":{"message":"Rate limit reached for requests","type":"requests","code":"rate_limit_exceeded"}}"#
        ),
        Verdict::SlowDown
    );
    assert_eq!(
        ok(
            &c,
            404,
            r#"{"error":{"message":"The model `gpt-5-mini` does not exist or you do not have access to it.","code":"model_not_found"}}"#
        ),
        Verdict::ModelUnavailable
    );
    assert_eq!(
        ok(
            &c,
            400,
            r#"{"error":{"message":"Unsupported parameter: 'max_tokens'","code":"unsupported_parameter"}}"#
        ),
        Verdict::Failed
    );
    // Anthropic.
    let c = anthropic();
    assert_eq!(
        ok(
            &c,
            401,
            r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#
        ),
        Verdict::Refused
    );
    assert_eq!(
        ok(
            &c,
            400,
            r#"{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}"#
        ),
        Verdict::NoCredit
    );
    assert_eq!(
        ok(
            &c,
            404,
            r#"{"type":"error","error":{"type":"not_found_error","message":"model: claude-haiku-5-5"}}"#
        ),
        Verdict::ModelUnavailable
    );
    assert_eq!(
        ok(
            &c,
            429,
            r#"{"type":"error","error":{"type":"rate_limit_error","message":"Number of requests has exceeded your rate limit"}}"#
        ),
        Verdict::SlowDown
    );
    assert_eq!(
        ok(
            &c,
            529,
            r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#
        ),
        Verdict::ProviderBusy
    );
    // Google.
    let c = gemini();
    assert_eq!(
        ok(
            &c,
            400,
            r#"[{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}]"#
        ),
        Verdict::Refused
    );
    assert_eq!(
        ok(
            &c,
            429,
            r#"[{"error":{"code":429,"message":"You exceeded your current quota.","status":"RESOURCE_EXHAUSTED"}}]"#
        ),
        // No per-day quota id: slow down, not "try again tomorrow" (review L1; the per-day case has its own test).
        Verdict::SlowDown
    );
    assert_eq!(
        ok(
            &c,
            403,
            r#"[{"error":{"code":403,"status":"PERMISSION_DENIED"}}]"#
        ),
        Verdict::Refused
    );
    // Any company: no answer at all, or a server error.
    for c in [openai(), anthropic(), gemini(), other()] {
        assert_eq!(
            classify(&c, Err(ModelError::ProviderFailure)),
            Verdict::Unreachable
        );
        assert_eq!(ok(&c, 503, "upstream connect error"), Verdict::ProviderBusy);
        assert_eq!(ok(&c, 402, "{}"), Verdict::NoCredit);
        assert_eq!(ok(&c, 302, ""), Verdict::Failed);
    }
    // Another company's 429 is never read as Google's daily limit.
    assert_eq!(ok(&other(), 429, "RESOURCE_EXHAUSTED"), Verdict::SlowDown);
}

#[test]
fn a_key_that_works_is_saved_for_its_host_and_chosen_and_nothing_else_is_ever_saved() {
    let dir = TempDir::new("works");
    let store = FakeStore::default();
    let company = Company::default();
    let verdict =
        check_and_save(&dir.0, &openai(), OPENAI_KEY, &names(), &company, &store).unwrap();
    assert_eq!(verdict.verdict, Verdict::Works);
    // One fixed request with no church data, the key only as the bearer token, the company's rules applied.
    let sent = company.sent.lock().unwrap();
    let (url, key, body) = &sent[0];
    assert_eq!(url, "https://api.openai.com/v1/chat/completions");
    assert_eq!(key.as_deref(), Some(OPENAI_KEY));
    assert_eq!(
        body,
        &json!({"model": "gpt-6-luna", "messages": [{"role": "user", "content": CHECK_PROMPT}],
                "max_completion_tokens": CHECK_TOKENS, "reasoning_effort": "none"})
    );
    drop(sent);
    assert_eq!(
        store
            .keys
            .lock()
            .unwrap()
            .get("own-provider:api.openai.com")
            .map(String::as_str),
        Some(OPENAI_KEY)
    );
    let config = model::load_config(&dir.0).unwrap();
    assert_eq!(
        (
            config.route,
            config.base_url.as_str(),
            config.model.as_str()
        ),
        (Route::Own, "https://api.openai.com/v1", "gpt-6-luna")
    );
    let status = verdict.status.as_ref().unwrap();
    assert_eq!(
        (status.setup, status.provider, status.configured),
        ("ready", Some("openai"), true)
    );
    assert_eq!(status.month.as_ref().unwrap().limit, 1_000);
    // The key is in no reply the page gets.
    let reply = serde_json::to_string(&verdict).unwrap();
    assert!(!reply.contains(OPENAI_KEY) && !reply.contains("fictional0canary"));
    assert!(
        reply.starts_with(r#"{"verdict":"works","provider":"openai","looks_like":null,"status":{"#)
    );

    // Every other verdict saves nothing and chooses nothing.
    for (choice, key, answer) in [
        (anthropic(), ANTHROPIC_KEY, Ok((401, "{}"))),
        (
            anthropic(),
            ANTHROPIC_KEY,
            Ok((400, "Your credit balance is too low")),
        ),
        (gemini(), GEMINI_KEY, Err(ModelError::ProviderFailure)),
        (gemini(), GEMINI_KEY, Ok((429, "RESOURCE_EXHAUSTED"))),
    ] {
        let dir = TempDir::new("refused");
        let store = FakeStore::default();
        let company = Company::answering(answer);
        let verdict = check_and_save(&dir.0, &choice, key, &names(), &company, &store).unwrap();
        assert_ne!(verdict.verdict, Verdict::Works);
        assert!(verdict.status.is_none());
        assert!(store.keys.lock().unwrap().is_empty());
        assert!(model::load_config(&dir.0).is_none());
        assert!(!serde_json::to_string(&verdict).unwrap().contains(key));
    }

    // A key of another shape: nothing is sent at all.
    let company = Company::default();
    let verdict =
        check_and_save(&dir.0, &gemini(), ANTHROPIC_KEY, &names(), &company, &store).unwrap();
    assert_eq!(
        (verdict.verdict, verdict.looks_like),
        (Verdict::WrongKind, Some("anthropic"))
    );
    assert_eq!(company.count(), 0);
    assert_eq!(
        serde_json::to_string(&verdict).unwrap(),
        r#"{"verdict":"wrong-kind","provider":"gemini","looks_like":"anthropic","status":null}"#
    );

    // It works, but the Keychain refused it: not saved, not chosen.
    let dir = TempDir::new("locked");
    let store = FakeStore {
        refuse: true,
        ..FakeStore::default()
    };
    let verdict = check_and_save(
        &dir.0,
        &anthropic(),
        ANTHROPIC_KEY,
        &names(),
        &Company::default(),
        &store,
    )
    .unwrap();
    assert_eq!(verdict.verdict, Verdict::NotSaved);
    assert!(model::load_config(&dir.0).is_none());
}

#[test]
fn another_company_keeps_todays_rules_https_only_never_planning_center_and_no_name_in_its_model() {
    let dir = TempDir::new("other");
    let store = FakeStore::default();
    let company = Company::default();
    let verdict = check_and_save(&dir.0, &other(), OTHER_KEY, &names(), &company, &store).unwrap();
    assert_eq!(verdict.verdict, Verdict::Works);
    assert_eq!(company.sent.lock().unwrap()[0].2["temperature"], 0.4);
    assert!(
        store
            .keys
            .lock()
            .unwrap()
            .contains_key("own-provider:api.example.invalid")
    );
    assert_eq!(verdict.status.unwrap().provider, None);
    for (base, model) in [
        ("http://api.example.invalid/v1", "fictional-model-1"),
        (
            "https://api.planningcenteronline.com/v1",
            "fictional-model-1",
        ),
        ("https://people.churchcenter.com/v1", "fictional-model-1"),
    ] {
        let choice = Choice::parse("other", Some(base.into()), Some(model.into())).unwrap();
        assert!(
            check_and_save(&dir.0, &choice, OTHER_KEY, &names(), &company, &store).is_err(),
            "{base}"
        );
    }
    let named = Choice::parse(
        "other",
        Some("https://api.example.invalid/v1".into()),
        Some("riley-thornbury-7b".into()),
    )
    .unwrap();
    assert_eq!(
        check_and_save(&dir.0, &named, OTHER_KEY, &names(), &company, &store).err(),
        Some(ModelError::NamePresent)
    );
    assert_eq!(company.count(), 1);
    // The page names a company, or "other" with its address and model; nothing else.
    for (provider, base, model) in [
        ("openai", Some("https://api.openai.com/v1"), None),
        ("other", None, Some("m")),
        ("mistral", None, None),
        ("", None, None),
    ] {
        assert!(
            Choice::parse(provider, base.map(Into::into), model.map(Into::into)).is_err(),
            "{provider}"
        );
    }
}

#[test]
fn the_desk_holds_one_key_checks_it_ten_times_an_hour_and_forgets_it_once_saved() {
    let dir = TempDir::new("desk");
    let store = FakeStore::default();
    let desk = KeyDesk::default();
    let company = Company::default();
    assert_eq!(
        desk.check(&dir.0, &openai(), &names(), &company, &store)
            .unwrap()
            .verdict,
        Verdict::Empty
    );
    desk.hold(Zeroizing::new(ANTHROPIC_KEY.into()), &openai());
    // Wrong kind, then "Use it with Claude" checks the same held key on Anthropic.
    assert_eq!(
        desk.check(&dir.0, &openai(), &names(), &company, &store)
            .unwrap()
            .verdict,
        Verdict::WrongKind
    );
    assert_eq!(
        desk.check(&dir.0, &anthropic(), &names(), &company, &store)
            .unwrap()
            .verdict,
        Verdict::Works
    );
    assert!(desk.held().is_none(), "a saved key is no longer held");
    desk.hold(Zeroizing::new(OPENAI_KEY.into()), &openai());
    let refused = Company::default();
    for _ in 0..20 {
        refused.answers.lock().unwrap().push(Ok((401, "{}".into())));
    }
    let verdicts: Vec<Verdict> = (0..10)
        .map(|_| {
            desk.check(&dir.0, &openai(), &names(), &refused, &store)
                .unwrap()
                .verdict
        })
        .collect();
    // Two checks went before; eight more refused; then the hour's ten are spent and nothing is sent.
    assert_eq!(verdicts[..8], [Verdict::Refused; 8]);
    assert_eq!(verdicts[8..], [Verdict::TooManyChecks; 2]);
    assert_eq!(refused.count(), 8);
    assert!(
        desk.held().is_some(),
        "a refused key stays held for another try"
    );
    desk.forget();
    assert!(desk.held().is_none());
}

#[test]
fn removing_the_key_deletes_it_and_leaves_no_route() {
    let dir = TempDir::new("remove");
    let store = FakeStore::default();
    check_and_save(
        &dir.0,
        &gemini(),
        GEMINI_KEY,
        &names(),
        &Company::default(),
        &store,
    )
    .unwrap();
    assert_eq!(model::status(&dir.0, &store).route, "own");
    let status = remove(&dir.0, &store).unwrap();
    assert_eq!((status.route, status.setup), ("none", "no-route"));
    assert!(store.keys.lock().unwrap().is_empty());
}

// ---- A held key goes only where it was taken in for (security review, 2026-11-17) -------------------------------

fn other_at(base: &str, model: &str) -> Choice {
    Choice::parse("other", Some(base.into()), Some(model.into())).unwrap()
}
fn hosts(company: &Company) -> Vec<String> {
    company
        .sent
        .lock()
        .unwrap()
        .iter()
        .map(|(url, _, _)| url::Url::parse(url).unwrap().host_str().unwrap().to_owned())
        .collect()
}

#[test]
fn a_key_held_for_one_company_is_never_sent_to_another_host() {
    let dir = TempDir::new("bound");
    let store = FakeStore::default();
    let desk = KeyDesk::default();
    let company = Company::default();
    desk.hold(Zeroizing::new(OPENAI_KEY.into()), &openai());
    for elsewhere in [
        anthropic(),
        gemini(),
        other(),
        other_at("https://api.openai.com/v1", "gpt-5-mini"),
    ] {
        assert_eq!(
            desk.check(&dir.0, &elsewhere, &names(), &company, &store)
                .err(),
            Some(ModelError::InvalidRequest),
            "{}",
            elsewhere.id()
        );
    }
    assert_eq!(company.count(), 0, "nothing was sent anywhere");
    // Where it was taken in for, it goes.
    let verdict = desk
        .check(&dir.0, &openai(), &names(), &company, &store)
        .unwrap();
    assert_eq!(verdict.verdict, Verdict::Works);
    assert_eq!(hosts(&company), ["api.openai.com"]);
}

#[test]
fn a_key_taken_in_for_another_company_keeps_its_exact_address_and_model() {
    let dir = TempDir::new("other-bound");
    let store = FakeStore::default();
    let desk = KeyDesk::default();
    let company = Company::default();
    let first = other_at("https://api.example.invalid/v1", "fictional-model-1");
    desk.hold(Zeroizing::new(OTHER_KEY.into()), &first);
    for changed in [
        other_at("https://api.example.invalid/v2", "fictional-model-1"),
        other_at("https://evil.example/v1", "fictional-model-1"),
        other_at("https://api.example.invalid:8443/v1", "fictional-model-1"),
        other_at("https://api.example.invalid/v1", "fictional-model-2"),
        openai(),
    ] {
        assert_eq!(
            desk.check(&dir.0, &changed, &names(), &company, &store)
                .err(),
            Some(ModelError::InvalidRequest)
        );
    }
    assert_eq!(company.count(), 0);
    assert_eq!(
        desk.check(&dir.0, &first, &names(), &company, &store)
            .unwrap()
            .verdict,
        Verdict::Works
    );
    assert_eq!(hosts(&company), ["api.example.invalid"]);
}

#[test]
fn the_wrong_kind_handoff_goes_only_to_the_company_the_keys_own_prefix_names() {
    let dir = TempDir::new("handoff");
    let store = FakeStore::default();
    let desk = KeyDesk::default();
    let company = Company::default();
    desk.hold(Zeroizing::new(ANTHROPIC_KEY.into()), &openai());
    let verdict = desk
        .check(&dir.0, &openai(), &names(), &company, &store)
        .unwrap();
    assert_eq!(
        (verdict.verdict, verdict.looks_like),
        (Verdict::WrongKind, Some("anthropic"))
    );
    // Not to Google, not to another company: only Anthropic, which the key's prefix names.
    for elsewhere in [gemini(), other()] {
        assert_eq!(
            desk.check(&dir.0, &elsewhere, &names(), &company, &store)
                .err(),
            Some(ModelError::InvalidRequest)
        );
    }
    assert_eq!(company.count(), 0);
    assert_eq!(
        desk.check(&dir.0, &anthropic(), &names(), &company, &store)
            .unwrap()
            .verdict,
        Verdict::Works
    );
    assert_eq!(hosts(&company), ["api.anthropic.com"]);
}

#[test]
fn a_known_companys_key_is_never_sent_to_another_companys_address() {
    let dir = TempDir::new("other-prefix");
    let store = FakeStore::default();
    let company = Company::default();
    for (key, owner) in [
        (OPENAI_KEY, "openai"),
        (ANTHROPIC_KEY, "anthropic"),
        (GEMINI_KEY, "gemini"),
    ] {
        let verdict = check_and_save(&dir.0, &other(), key, &names(), &company, &store).unwrap();
        assert_eq!(
            (verdict.verdict, verdict.looks_like),
            (Verdict::WrongKind, Some(owner))
        );
    }
    assert_eq!(company.count(), 0);
    assert!(store.keys.lock().unwrap().is_empty());
    // Typed at the company's own address, it may go there.
    let own_address = other_at("https://api.openai.com/v1", "gpt-5-nano");
    assert_eq!(
        check_and_save(&dir.0, &own_address, OPENAI_KEY, &names(), &company, &store)
            .unwrap()
            .verdict,
        Verdict::Works
    );
    assert_eq!(hosts(&company), ["api.openai.com"]);
}

#[test]
fn another_company_is_confirmed_by_the_host_it_will_reach_before_the_key_is_even_read() {
    // Declined: the clipboard (or window) is never read, so nothing is held or sent.
    let read = std::cell::Cell::new(false);
    let mut shown = None;
    let taken = take_in(
        &other(),
        |host| {
            shown = Some(host.to_owned());
            false
        },
        || {
            read.set(true);
            Some(OTHER_KEY.into())
        },
    )
    .unwrap();
    assert_eq!(taken.err(), Some(Verdict::Cancelled));
    assert!(!read.get());
    assert_eq!(shown.as_deref(), Some("api.example.invalid"));
    // Accepted: then it is read.
    let taken = take_in(&other(), |_| true, || Some(OTHER_KEY.into())).unwrap();
    assert_eq!(taken.ok().as_deref(), Some(OTHER_KEY));
    // A company Ozzie knows (once its live test passed) has a fixed address: no question, the clipboard read at once.
    let asked = std::cell::Cell::new(false);
    let taken = take_in(
        &verified("openai"),
        |_| {
            asked.set(true);
            true
        },
        || Some(OPENAI_KEY.into()),
    )
    .unwrap();
    assert!(!asked.get() && taken.is_ok());
    assert_eq!(
        take_in(&verified("openai"), |_| true, || None)
            .unwrap()
            .err(),
        Some(Verdict::Empty)
    );
    // The host shown is the host the check reaches: the parsed URL's own host, port included. An address must be
    // written exactly as the URL reads it (lowercase, punycode, no trailing dot), so look-alike letters show as
    // punycode or are refused; one hiding a host in a user name, or not https, is refused before anything.
    for (base, host) in [
        (
            "https://api.example.invalid:8443/v1",
            "api.example.invalid:8443",
        ),
        ("https://xn--pi-6kc.openai.com/v1", "xn--pi-6kc.openai.com"),
    ] {
        let choice = other_at(base, "fictional-model-1");
        assert_eq!(choice.destination_host().unwrap(), host);
        let dir = TempDir::new("host");
        let company = Company::default();
        check_and_save(
            &dir.0,
            &choice,
            OTHER_KEY,
            &names(),
            &company,
            &FakeStore::default(),
        )
        .unwrap();
        let sent = url::Url::parse(&company.sent.lock().unwrap()[0].0).unwrap();
        assert_eq!(model::host_key_of(sent.as_str()).unwrap(), host);
        assert!(host.is_ascii());
    }
    for base in [
        "https://\u{0430}pi.openai.com/v1",
        "https://API.Example.Invalid./v1",
        "https://api.openai.com@evil.example/v1",
        "https://user:pw@api.example.invalid/v1",
        "http://api.example.invalid/v1",
        "http://127.0.0.1:11434/v1",
        "https://api.example.invalid/v1?x=1",
        "https://api.planningcenteronline.com/v1",
    ] {
        let choice = other_at(base, "fictional-model-1");
        let asked = std::cell::Cell::new(false);
        assert!(
            take_in(
                &choice,
                |_| {
                    asked.set(true);
                    true
                },
                || Some(OTHER_KEY.into())
            )
            .is_err(),
            "{base}"
        );
        assert!(!asked.get(), "{base}: refused before anyone is asked");
    }
}

#[test]
fn who_may_read_the_clipboard_hold_a_key_send_it_or_save_it_is_pinned() {
    let core = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let app = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../product/desktop/src-tauri/src");
    let sources = |dir: &std::path::Path| -> Vec<(String, String)> {
        let mut found: Vec<(String, String)> = std::fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|x| x == "rs"))
            .filter(|p| {
                !p.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .ends_with("_tests.rs")
            })
            .map(|p| {
                (
                    p.file_name().unwrap().to_string_lossy().into_owned(),
                    std::fs::read_to_string(&p).unwrap(),
                )
            })
            .collect();
        found.sort();
        found
    };
    let using = |dir: &std::path::Path, needle: &str| -> Vec<String> {
        sources(dir)
            .into_iter()
            .filter(|(_, text)| text.contains(needle))
            .map(|(name, _)| name)
            .collect()
    };
    // The clipboard: only the key window's module, in the app.
    assert_eq!(using(&app, "NSPasteboard"), ["key_sheet.rs"]);
    assert!(using(&core, "NSPasteboard").is_empty());
    // A key is saved by own_key.rs alone; held by its desk, which only the key window's module uses.
    assert_eq!(using(&core, "put_key("), ["own_key.rs"]);
    assert_eq!(using(&app, "put_key("), Vec::<String>::new());
    assert_eq!(using(&app, "KeyDesk"), ["key_sheet.rs"]);
    assert_eq!(using(&app, "hold_text("), ["key_sheet.rs"]);
    // The desk hands a held key to no one: no public way to read it back.
    let own = std::fs::read_to_string(core.join("own_key.rs")).unwrap();
    assert!(!own.contains("pub fn held("));
    // Every model client refuses redirects, so a key is never re-sent to where a company points.
    let model = std::fs::read_to_string(core.join("model.rs")).unwrap();
    assert_eq!(model.matches("Client::builder()").count(), 1);
    assert!(model.contains(".redirect(reqwest::redirect::Policy::none())"));
    // No key words in what the desk, the verdicts or an error can print.
    for text in [
        &own,
        &std::fs::read_to_string(app.join("key_sheet.rs")).unwrap(),
    ] {
        for printing in [
            "println!",
            "eprintln!",
            "dbg!",
            "log::",
            "tracing::",
            "panic!(\"{",
        ] {
            assert!(!text.contains(printing), "{printing}");
        }
    }
    // The desk and what it holds can't be printed: no Debug.
    assert!(
        own.contains("\npub struct KeyDesk {")
            && !own.contains("#[derive(Debug)]\npub struct KeyDesk")
    );
    assert!(own.contains("\nstruct Held {") && !own.contains("derive(Debug)]\nstruct Held"));
}

// ---- Settings: "No AI for now", "Remove my key from this Mac", Ozzie's own pages (page lane follow-ups) ---------

#[test]
fn ozzies_account_and_terms_pages_are_fixed_addresses_on_ozzie_church() {
    assert_eq!(
        help_page("ozzie-account"),
        Some("https://ozzie.church/account")
    );
    assert_eq!(help_page("ozzie-terms"), Some("https://ozzie.church/terms"));
    for other in [
        "ozzie-",
        "ozzie-billing",
        "ozzie-account/../admin",
        "ozzie-Account",
        "ozzie-terms?x=1",
    ] {
        assert_eq!(help_page(other), None, "{other}");
    }
    for page in ["ozzie-account", "ozzie-terms"] {
        assert_eq!(
            model::host_key_of(help_page(page).unwrap()).as_deref(),
            Some(crate::destinations::OZZIE_HOST)
        );
    }
}

#[test]
fn no_ai_for_now_switches_any_route_off_and_keeps_the_churchs_key() {
    let store = FakeStore::default();
    // Ozzie's AI, a model on this Mac, or the church's own key: each is switched off.
    for choose in [0, 1, 2] {
        let dir = TempDir::new("no-ai");
        match choose {
            0 => {
                model::save_config(&dir.0, Route::Managed, None, None).unwrap();
            }
            1 => {
                model::save_local_checked(
                    &dir.0,
                    model::LOCAL_BASE,
                    model::LOCAL_MODEL,
                    1,
                    model::route_generation(&dir.0),
                )
                .unwrap();
            }
            _ => {
                check_and_save(
                    &dir.0,
                    &openai(),
                    OPENAI_KEY,
                    &names(),
                    &Company::default(),
                    &store,
                )
                .unwrap();
            }
        }
        let status = model::choose_no_ai(&dir.0, &store).unwrap();
        assert_eq!(
            (status.route, status.setup, status.configured),
            ("none", "no-route", false)
        );
        assert!(model::load_config(&dir.0).is_none());
    }
    // The church's key stays on this Mac until they choose to remove it.
    assert_eq!(
        store
            .keys
            .lock()
            .unwrap()
            .get("own-provider:api.openai.com")
            .map(String::as_str),
        Some(OPENAI_KEY)
    );
    // Nothing chosen already: still none, nothing fails.
    let dir = TempDir::new("no-ai-twice");
    assert_eq!(model::choose_no_ai(&dir.0, &store).unwrap().route, "none");
}

#[test]
fn remove_my_key_deletes_every_key_ozzie_saved_says_so_and_ends_only_an_own_route() {
    // Two keys saved through Ozzie (one for another company), then "No AI for now": both are still found and removed.
    let dir = TempDir::new("remove-all");
    let store = FakeStore::default();
    check_and_save(
        &dir.0,
        &other(),
        OTHER_KEY,
        &names(),
        &Company::default(),
        &store,
    )
    .unwrap();
    check_and_save(
        &dir.0,
        &anthropic(),
        ANTHROPIC_KEY,
        &names(),
        &Company::default(),
        &store,
    )
    .unwrap();
    model::choose_no_ai(&dir.0, &store).unwrap();
    // One saved the old way, with Terminal, under the unbound account.
    store.keys.lock().unwrap().insert(
        model::LEGACY_OWN_ACCOUNT.into(),
        "fictional-legacy-key-canary".into(),
    );
    let removal = remove_keys(&dir.0, &store);
    assert_eq!(removal.removed, "removed");
    assert!(
        store.keys.lock().unwrap().is_empty(),
        "{:?}",
        store.keys.lock().unwrap().keys().collect::<Vec<_>>()
    );
    assert!(!serde_json::to_string(&removal).unwrap().contains("canary"));
    assert!(
        serde_json::to_string(&removal)
            .unwrap()
            .starts_with(r#"{"removed":"removed","status":{"#)
    );
    // Nothing left: it says so.
    assert_eq!(remove_keys(&dir.0, &store).removed, "none");
    // A model on this Mac stays chosen when the key goes; an own route ends with its key.
    let dir = TempDir::new("remove-keeps-local");
    check_and_save(
        &dir.0,
        &gemini(),
        GEMINI_KEY,
        &names(),
        &Company::default(),
        &store,
    )
    .unwrap();
    model::save_local_checked(
        &dir.0,
        model::LOCAL_BASE,
        model::LOCAL_MODEL,
        1,
        model::route_generation(&dir.0),
    )
    .unwrap();
    assert_eq!(remove_keys(&dir.0, &store).status.route, "local");
    let dir = TempDir::new("remove-ends-own");
    check_and_save(
        &dir.0,
        &gemini(),
        GEMINI_KEY,
        &names(),
        &Company::default(),
        &store,
    )
    .unwrap();
    let removal = remove_keys(&dir.0, &store);
    assert_eq!((removal.removed, removal.status.route), ("removed", "none"));
    // The Keychain refused: says so, and the route stays as it was.
    let dir = TempDir::new("remove-refused");
    let locked = FakeStore {
        refuse_delete: true,
        ..FakeStore::default()
    };
    check_and_save(
        &dir.0,
        &openai(),
        OPENAI_KEY,
        &names(),
        &Company::default(),
        &locked,
    )
    .unwrap();
    let removal = remove_keys(&dir.0, &locked);
    assert_eq!((removal.removed, removal.status.route), ("refused", "own"));
    // The list of hosts Ozzie saved keys for holds hosts only, never a key.
    let hosts = std::fs::read_to_string(dir.0.join(OWN_KEY_HOSTS_FILE)).unwrap();
    assert_eq!(hosts, r#"["api.openai.com"]"#);
}

#[test]
fn the_companies_with_a_saved_key_are_closed_ids_from_the_list_of_hosts_never_a_key() {
    // Live, 2026-11-18: three companies' keys were kept and "Remove my key from this Mac" named only one. The page
    // learns which companies first: one closed id per key Ozzie saved, in the order saved.
    let dir = TempDir::new("saved-companies");
    let store = FakeStore::default();
    assert!(saved_companies(&dir.0).is_empty());
    for (choice, key) in [
        (openai(), OPENAI_KEY),
        (anthropic(), ANTHROPIC_KEY),
        (gemini(), GEMINI_KEY),
        (other(), OTHER_KEY),
    ] {
        check_and_save(&dir.0, &choice, key, &names(), &Company::default(), &store).unwrap();
    }
    // The same key saved again is still one key.
    check_and_save(
        &dir.0,
        &openai(),
        OPENAI_KEY,
        &names(),
        &Company::default(),
        &store,
    )
    .unwrap();
    assert_eq!(
        saved_companies(&dir.0),
        ["openai", "anthropic", "gemini", "other"]
    );
    let said = serde_json::to_string(&saved_companies(&dir.0)).unwrap();
    for word in ["canary", "fictional", "sk-", "AIza", "example"] {
        assert!(!said.contains(word), "{word} in {said}");
    }
    // A list that isn't only hosts never comes back as text: anything not a company's host is "other".
    std::fs::write(
        dir.0.join(OWN_KEY_HOSTS_FILE),
        format!(r#"["{}","api.anthropic.com"]"#, OTHER_KEY),
    )
    .unwrap();
    assert_eq!(saved_companies(&dir.0), ["other", "anthropic"]);
    // After "Remove my key from this Mac", none.
    assert_eq!(remove_keys(&dir.0, &store).removed, "removed");
    assert!(saved_companies(&dir.0).is_empty());
}

// ---- The provider research of 2026-11-17: current models, verdicts, Google's keys, Claude's own API ------------

#[test]
fn the_catalog_carries_only_what_the_companies_own_pages_say() {
    let catalog = catalog();
    assert!(catalog.verified_live, "the owner's live test, 2026-11-18");
    let [openai, anthropic, gemini] = [
        preset("openai").unwrap(),
        preset("anthropic").unwrap(),
        preset("gemini").unwrap(),
    ];
    assert_eq!(
        [
            openai.model.as_str(),
            anthropic.model.as_str(),
            gemini.model.as_str()
        ],
        ["gpt-6-luna", "claude-haiku-5-5", "gemini-3.5-flash-lite"]
    );
    // Claude through its own Messages API; the others through Chat Completions.
    assert_eq!(
        [
            openai.wire.as_str(),
            anthropic.wire.as_str(),
            gemini.wire.as_str()
        ],
        ["chat-completions", "anthropic-messages", "chat-completions"]
    );
    assert_eq!(
        openai_like("anthropic").endpoint().unwrap(),
        "https://api.anthropic.com/v1/messages"
    );
    assert_eq!(
        openai_like("gemini").endpoint().unwrap(),
        "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
    );
    assert_eq!(anthropic.api_version.as_deref(), Some("2023-06-01"));
    // A smallest top-up only where the company's page says it: Google's $5. Not OpenAI's (seen only in a search
    // excerpt), not Anthropic's (not published).
    assert_eq!(
        [
            openai.min_topup.as_deref(),
            anthropic.min_topup.as_deref(),
            gemini.min_topup.as_deref()
        ],
        [Some("$5"), None, Some("$5")]
    );
    // No made-up "typical month": prices per million tokens, as published, for the page to work from.
    assert!(catalog.presets.iter().all(|p| p.typical_month.is_none()));
    assert_eq!(
        (
            openai.price_per_million.input,
            openai.price_per_million.output
        ),
        (0.10, 0.50)
    );
    assert_eq!(
        (
            anthropic.price_per_million.input,
            anthropic.price_per_million.output
        ),
        (0.10, 0.50)
    );
    assert_eq!(
        (
            gemini.price_per_million.input,
            gemini.price_per_million.output
        ),
        (0.30, 2.50)
    );
    // Google's free plan exists, but its terms say not to send personal information to it: Ozzie won't suggest it.
    assert!(!openai.free_plan && !anthropic.free_plan && gemini.free_plan);
    assert!(gemini.free_plan_not_for_church_data && !openai.free_plan_not_for_church_data);
    assert_eq!(
        gemini.free_plan_line.as_deref(),
        Some(
            "On the free plan, Google may use what the app sends to improve its products, and people at Google may read it. Google says not to send sensitive or personal information on the free plan."
        )
    );
    // The retention sentences, as the research verified them.
    assert_eq!(
        openai.retention_line,
        "OpenAI doesn't train its models on what apps send through a key unless you choose to share it, and keeps it for up to 30 days to watch for abuse, longer only if the law requires it or to protect its services."
    );
    assert_eq!(
        anthropic.retention_line,
        "Anthropic doesn't use what apps send through a key to train its models by default, and deletes it within 30 days unless it is flagged for a policy violation or the law requires longer."
    );
    assert_eq!(
        gemini.retention_line,
        "On the paid plan, Google doesn't use what the app sends to improve its products, and keeps it for a limited time to watch for misuse."
    );
    // Claude's console moved, and a key needs a workspace: the guide says so.
    assert_eq!(
        anthropic.pages.keys,
        "https://platform.claude.com/settings/keys"
    );
    assert_eq!(
        anthropic.pages.billing,
        "https://platform.claude.com/settings/billing"
    );
    assert!(
        anthropic
            .key_note
            .as_deref()
            .unwrap()
            .contains("choose a workspace")
    );
    assert_eq!(
        openai.pages.billing,
        "https://platform.openai.com/settings/organization/billing"
    );
    assert_eq!(gemini.pages.keys, "https://aistudio.google.com/apikey");
    assert_eq!(gemini.pages.billing, "https://aistudio.google.com/billing");
    // What the page's cards get.
    let cards = serde_json::to_string(&providers()).unwrap();
    for field in [
        "\"min_topup\":null",
        "\"price_per_million\":{\"input\":0.1,\"output\":0.5}",
        "\"free_plan_not_for_church_data\":true",
        "\"key_note\":\"When you create the key",
    ] {
        assert!(cards.contains(field), "{field}");
    }
}

#[test]
fn googles_new_keys_are_let_through_to_the_check_and_other_companies_keys_never_reach_google() {
    let new_style = "AQ.Fictional0Canary0Key0Gemini0000000";
    assert_eq!(shape_verdict(&gemini(), new_style), Ok(()));
    assert_eq!(shape_verdict(&gemini(), GEMINI_KEY), Ok(()));
    assert_eq!(
        shape_verdict(&gemini(), OPENAI_KEY),
        Err((Verdict::WrongKind, Some("openai")))
    );
    assert_eq!(
        shape_verdict(&gemini(), ANTHROPIC_KEY),
        Err((Verdict::WrongKind, Some("anthropic")))
    );
    // OpenAI and Anthropic keys keep their prefixes.
    assert_eq!(
        shape_verdict(&openai(), new_style),
        Err((Verdict::NotAKey, None))
    );
    assert_eq!(
        shape_verdict(&anthropic(), new_style),
        Err((Verdict::NotAKey, None))
    );
    // A Google key in the key, but with a space, is still not a key.
    assert_eq!(
        shape_verdict(&gemini(), "AQ.has a space 000000000000000")
            .unwrap_err()
            .0,
        Verdict::NotAKey
    );
}

#[test]
fn the_researched_refusals_give_their_verdicts() {
    let ok = |c: &Choice, status: u16, body: &str| classify(c, Ok((status, body.as_bytes())));
    // OpenAI: credit and spending limits are 429s told apart by their code, never "slow down".
    for code in [
        "credit_balance_exhausted",
        "organization_spend_limit_exceeded",
        "project_spend_limit_exceeded",
        "organization_usage_limit_exceeded",
    ] {
        let body = format!(
            r#"{{"error":{{"message":"Your organization has no prepaid credits remaining.","type":"insufficient_quota","code":"{code}"}}}}"#
        );
        assert_eq!(ok(&openai(), 429, &body), Verdict::NoCredit, "{code}");
    }
    assert_eq!(
        ok(
            &openai(),
            429,
            r#"{"error":{"type":"rate_limit_error","code":"slow_down"}}"#
        ),
        Verdict::SlowDown
    );
    // Anthropic, natively.
    assert_eq!(
        ok(
            &anthropic(),
            401,
            r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#
        ),
        Verdict::Refused
    );
    assert_eq!(
        ok(
            &anthropic(),
            402,
            r#"{"type":"error","error":{"type":"billing_error","message":"There is an issue with your billing."}}"#
        ),
        Verdict::NoCredit
    );
    assert_eq!(
        ok(
            &anthropic(),
            429,
            r#"{"type":"error","error":{"type":"rate_limit_error","message":"You have reached your API usage limits.","details":{"error_code":"enforced_spend_limit_reached"}}}"#
        ),
        Verdict::NoCredit
    );
    assert_eq!(
        ok(
            &anthropic(),
            400,
            r#"{"type":"error","error":{"type":"invalid_request_error","message":"You have reached your specified API usage limits. You will regain access on 2026-12-01."}}"#
        ),
        Verdict::NoCredit
    );
    assert_eq!(
        ok(
            &anthropic(),
            400,
            r#"{"type":"error","error":{"type":"invalid_request_error","message":"This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header."}}"#
        ),
        Verdict::NeedsWorkspace
    );
    assert_eq!(
        serde_json::to_string(&Verdict::NeedsWorkspace).unwrap(),
        r#""needs-workspace""#
    );
    // Google.
    assert_eq!(
        ok(
            &gemini(),
            400,
            r#"{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}"#
        ),
        Verdict::Refused
    );
    assert_eq!(
        ok(
            &gemini(),
            402,
            r#"{"error":{"code":402,"message":"Your Prepay credit balance is depleted.","status":"RESOURCE_EXHAUSTED"}}"#
        ),
        Verdict::NoCredit
    );
    assert_eq!(
        ok(
            &gemini(),
            400,
            r#"{"error":{"code":400,"message":"Gemini API free tier is not available in your country. Please enable billing on your project in Google AI Studio.","status":"FAILED_PRECONDITION"}}"#
        ),
        Verdict::NeedsBilling
    );
}

#[test]
fn a_claude_key_is_checked_and_used_through_anthropics_own_api() {
    let dir = TempDir::new("claude-native");
    let store = FakeStore::default();
    let company = Company::answering(Ok((
        200,
        r#"{"type":"message","role":"assistant","content":[{"type":"text","text":"OK"}],"stop_reason":"end_turn","usage":{"input_tokens":12,"output_tokens":2}}"#,
    )));
    let verdict = check_and_save(
        &dir.0,
        &anthropic(),
        ANTHROPIC_KEY,
        &names(),
        &company,
        &store,
    )
    .unwrap();
    assert_eq!(verdict.verdict, Verdict::Works);
    let (url, key, body) = company.sent.lock().unwrap()[0].clone();
    assert_eq!(url, "https://api.anthropic.com/v1/messages");
    assert_eq!(key.as_deref(), Some(ANTHROPIC_KEY));
    assert_eq!(
        body,
        json!({"model": "claude-haiku-5-5", "max_tokens": CHECK_TOKENS, "messages": [{"role": "user", "content": CHECK_PROMPT}], "thinking": {"type": "disabled"}})
    );
    assert_eq!(
        company.headers.lock().unwrap()[0],
        [("anthropic-version".to_string(), "2023-06-01".to_string())]
    );
    // The key travels in Anthropic's own header, chosen with the wire (review M1).
    assert_eq!(
        *company.key_headers.lock().unwrap(),
        [Some(model::KeyHeader::XApiKey)]
    );
    // Rewording on that route: the same checks, the request in Messages form, and the reply read back as text.
    let config = model::load_config(&dir.0).unwrap();
    let reply = Company::answering(Ok((
        200,
        r#"{"type":"message","content":[{"type":"text","text":"Hi [Volunteer A], would you be free to help?"}],"stop_reason":"end_turn","usage":{"input_tokens":60,"output_tokens":12}}"#,
    )));
    let draft = DraftRequest {
        system: model::SYSTEM.into(),
        user: format!(
            "Make it warmer.{}Hi [Volunteer A], can you help?",
            model::NOTE_PREFIX
        ),
        max_tokens: 120,
    };
    let said = model::reword_using(
        &config,
        &dir.0.join(model::LEDGER_FILE),
        &draft,
        &store,
        &names(),
        &reply,
    )
    .ok()
    .unwrap();
    assert_eq!(said.text, "Hi [Volunteer A], would you be free to help?");
    assert_eq!(
        (said.prompt_tokens, said.completion_tokens),
        (Some(60), Some(12))
    );
    assert_eq!(
        reply.sent.lock().unwrap()[0].0,
        "https://api.anthropic.com/v1/messages"
    );
    assert_eq!(
        reply.headers.lock().unwrap()[0],
        [("anthropic-version".to_string(), "2023-06-01".to_string())]
    );
    assert_eq!(
        *reply.key_headers.lock().unwrap(),
        [Some(model::KeyHeader::XApiKey)]
    );
    // A name in the note is still refused before anything is sent.
    let named = DraftRequest {
        user: format!(
            "Make it warmer.{}Hi [Volunteer A], Riley Thornbury says hello.",
            model::NOTE_PREFIX
        ),
        ..draft
    };
    let refused = Company::default();
    assert_eq!(
        model::reword_using(
            &config,
            &dir.0.join(model::LEDGER_FILE),
            &named,
            &store,
            &names(),
            &refused
        )
        .err(),
        Some(ModelError::NamePresent)
    );
    assert_eq!(refused.count(), 0);
}

// ---- Independent review, 2026-11-17: the four probes as tests, and H1's split of prefixes --------------------------

#[test]
fn review_h1_an_openrouter_key_is_checked_at_openrouter_and_never_handed_to_openai() {
    let key = concat!("sk-", "or-v1-0000fictional0probe0key0for0openrouter0000");
    let router = other_at("https://openrouter.ai/api/v1", "deepseek/deepseek-chat");
    let dir = TempDir::new("openrouter");
    let store = FakeStore::default();
    let desk = KeyDesk::default();
    let company = Company::default();
    // A plain sk- key is no company's own: it goes where the person confirmed, and nowhere else.
    assert_eq!(owner_of(key).map(|p| p.id.as_str()), None);
    desk.hold(Zeroizing::new(key.into()), &router);
    assert_eq!(
        desk.check(&dir.0, &router, &names(), &company, &store)
            .unwrap()
            .verdict,
        Verdict::Works
    );
    assert_eq!(hosts(&company), ["openrouter.ai"]);
    // Even if the page asks for OpenAI afterwards, a key taken in for another company is never re-bound.
    let refused = Company::default();
    desk.hold(Zeroizing::new(key.into()), &router);
    assert_eq!(
        desk.check(&dir.0, &openai(), &names(), &refused, &store)
            .err(),
        Some(ModelError::InvalidRequest)
    );
    assert_eq!(refused.count(), 0);
    // Offered to OpenAI's card, it is named OpenRouter's (re-check Low 3), with no handoff.
    assert_eq!(
        shape_verdict(&openai(), key),
        Err((Verdict::WrongKind, Some("openrouter")))
    );
    // OpenAI's own and Anthropic's own prefixes still name their company.
    assert_eq!(
        shape_verdict(&openai(), ANTHROPIC_KEY),
        Err((Verdict::WrongKind, Some("anthropic")))
    );
    assert_eq!(
        shape_verdict(&router, OPENAI_KEY),
        Err((Verdict::WrongKind, Some("openai")))
    );
    // And a known company's key taken in for another company is wrong-kind there, with no handoff to that company.
    let held = KeyDesk::default();
    held.hold(Zeroizing::new(ANTHROPIC_KEY.into()), &router);
    let first = held
        .check(&dir.0, &router, &names(), &refused, &store)
        .unwrap();
    assert_eq!(
        (first.verdict, first.looks_like),
        (Verdict::WrongKind, Some("anthropic"))
    );
    assert_eq!(
        held.check(&dir.0, &anthropic(), &names(), &refused, &store)
            .err(),
        Some(ModelError::InvalidRequest)
    );
    assert_eq!(refused.count(), 0);
}

#[test]
fn review_m6_a_404_at_another_companys_address_is_a_wrong_address_not_a_working_key() {
    let wrong = other_at("https://api.example.invalid/api", "fictional-model-1");
    assert_eq!(
        classify(&wrong, Ok((404, &b"<html>404 Not Found</html>"[..]))),
        Verdict::WrongAddress
    );
    assert_eq!(
        serde_json::to_string(&Verdict::WrongAddress).unwrap(),
        r#""wrong-address""#
    );
    // With a model marker it is still the model; at a company Ozzie knows, a 404 is the model.
    assert_eq!(
        classify(
            &wrong,
            Ok((404, &br#"{"error":{"code":"model_not_found"}}"#[..]))
        ),
        Verdict::ModelUnavailable
    );
    assert_eq!(
        classify(&openai(), Ok((404, &b"Not Found"[..]))),
        Verdict::ModelUnavailable
    );
}

#[test]
fn review_l1_a_per_minute_gemini_limit_is_slow_down_and_only_a_per_day_one_is_tomorrow() {
    let minute = br#"[{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","details":[{"violations":[{"quotaId":"GenerateRequestsPerMinutePerProjectPerModel-FreeTier"}]}]}}]"#;
    let day = br#"[{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","details":[{"violations":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}]}}]"#;
    assert_eq!(
        classify(&gemini(), Ok((429, &minute[..]))),
        Verdict::SlowDown
    );
    assert_eq!(
        classify(&gemini(), Ok((429, &day[..]))),
        Verdict::DailyLimit
    );
    assert_eq!(
        classify(
            &gemini(),
            Ok((429, &br#"{"status":"RESOURCE_EXHAUSTED"}"#[..]))
        ),
        Verdict::SlowDown
    );
}

#[test]
fn review_m7_l4_a_held_key_is_forgotten_after_fifteen_minutes_by_the_clock_and_by_the_timer() {
    let now = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(1_000));
    let clock = {
        let now = now.clone();
        std::sync::Arc::new(move || now.load(std::sync::atomic::Ordering::SeqCst))
    };
    let desk = KeyDesk::with_clock(clock);
    let dir = TempDir::new("expiry");
    let store = FakeStore::default();
    let company = Company::default();
    desk.hold(Zeroizing::new(OPENAI_KEY.into()), &openai());
    // Fourteen minutes on: still held. The timer's sweep then finds it not yet expired.
    now.fetch_add(14 * 60_000, std::sync::atomic::Ordering::SeqCst);
    desk.forget_if_expired();
    assert!(desk.held().is_some());
    // Fifteen and a bit: the sweep zeroes it, and a check finds nothing to send.
    now.fetch_add(60_001, std::sync::atomic::Ordering::SeqCst);
    desk.forget_if_expired();
    assert!(desk.held().is_none());
    assert_eq!(
        desk.check(&dir.0, &openai(), &names(), &company, &store)
            .unwrap()
            .verdict,
        Verdict::Empty
    );
    assert_eq!(company.count(), 0);
    assert_eq!(HOLD_FOR, std::time::Duration::from_secs(15 * 60));
}

#[test]
fn review_m7_the_key_window_and_the_clipboard_are_pinned_where_a_key_could_leak() {
    let app = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../product/desktop/src-tauri/src/key_sheet.rs"),
    )
    .unwrap();
    let code = app.split("#[cfg(test)]").next().unwrap();
    // Verdicts reach the page only through the closed constructor: the app never builds one or writes its words.
    assert!(
        !code.contains("KeyVerdict {")
            && !code.contains(".provider =")
            && !code.contains(".looks_like =")
    );
    // The only status it sets is the one `model_status` gives.
    for (at, _) in code.match_indices(".status = ") {
        let rest = &code[at + ".status = ".len()..];
        assert!(
            rest.starts_with("Some(crate::full_status(&dir));")
                || rest.starts_with("crate::full_status(&dir);")
        );
    }
    // The clipboard is read only through take_in, so another company's host is asked about first.
    assert_eq!(
        code.matches("own_key::take_in(&asking, window::confirm, clipboard::read)")
            .count(),
        1
    );
    assert_eq!(code.matches("clipboard::read").count(), 1);
    // The key window, "Check this key again" and "Use the key already on this Mac" ask decision 19 first, before the
    // window opens or the Keychain is read (re-check A2b; 2026-11-18).
    assert_eq!(code.matches("own_key::usable(&choice)").count(), 3);
    let enter = &code[code.find("pub async fn own_key_enter(").unwrap()..];
    assert!(enter.find("own_key::usable(&choice)").unwrap() < enter.find("window::ask(").unwrap());
    let kept = &code[code.find("pub async fn own_key_use_kept(").unwrap()..];
    assert!(kept.find("own_key::usable(&choice)").unwrap() < kept.find(".hold_kept(").unwrap());
    // A kept key is read only onto the desk, for its own company, and checked through the same path as a pasted one.
    assert_eq!(code.matches(".hold_kept(").count(), 1);
    assert!(kept[..kept.find("\n}\n").unwrap()].contains("check_held(&app, &desk.0, &names, &choice)"));
    // It is cleared only when it still holds exactly the key that worked.
    assert!(code.contains("clipboard::clear_if_same"));
    assert!(!code.contains("still_a_key"));
    // Nothing on the path prints, and no assertion message or panic can carry a value.
    let core = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let app_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../product/desktop/src-tauri/src");
    for path in [
        core.join("model.rs"),
        core.join("local_ai.rs"),
        core.join("local_models.rs"),
        core.join("hosted.rs"),
        core.join("own_key.rs"),
        core.join("anthropic.rs"),
        app_dir.join("key_sheet.rs"),
        app_dir.join("ai_setup.rs"),
    ] {
        let text = std::fs::read_to_string(&path).unwrap();
        let code = text.split("#[cfg(test)]").next().unwrap();
        for printing in [
            "println!",
            "eprintln!",
            "print!(",
            "dbg!",
            "log::",
            "tracing::",
            "panic!(\"{",
            "expect(&format",
        ] {
            assert!(!code.contains(printing), "{}: {printing}", path.display());
        }
    }
}

/// A company as it was before the owner's live test passed for it (or as a new one is until its own test).
fn unverified(id: &str) -> Choice {
    let mut raw: serde_json::Value = serde_json::from_str(PROVIDERS_JSON).unwrap();
    let preset = raw["presets"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|p| p["id"] == id)
        .unwrap();
    preset["verified_live"] = json!(false);
    let preset: Preset = serde_json::from_value(preset.clone()).unwrap();
    Choice::Preset(Box::leak(Box::new(preset)))
}

#[test]
fn review_h3_a_company_is_usable_only_after_its_live_test_and_another_company_always_is() {
    // All three passed the owner's live test with real keys on 2026-11-18, so all three ship usable.
    assert!(catalog().presets.iter().all(|p| p.verified_live));
    let cards = serde_json::to_string(&providers()).unwrap();
    assert_eq!(cards.matches("\"verified_live\":true").count(), 3);
    for id in ["openai", "anthropic", "gemini"] {
        assert_eq!(usable(&Choice::Preset(preset(id).unwrap())), Ok(()));
    }
    // A company whose own flag is off is refused everywhere, as each was until its test.
    for choice in [
        unverified("openai"),
        unverified("anthropic"),
        unverified("gemini"),
    ] {
        assert_eq!(usable(&choice), Err(Verdict::NotVerifiedYet));
        // The check itself refuses it too, whoever calls it: nothing is sent.
        let company = Company::default();
        let checked = check_and_save(
            &TempDir::new("unverified").0,
            &choice,
            OPENAI_KEY,
            &names(),
            &company,
            &FakeStore::default(),
        )
        .unwrap();
        assert_eq!(checked.verdict, Verdict::NotVerifiedYet);
        assert_eq!(company.count(), 0);
        // Refused before the clipboard or the key window is read.
        let read = std::cell::Cell::new(false);
        let taken = take_in(
            &choice,
            |_| true,
            || {
                read.set(true);
                Some(OPENAI_KEY.into())
            },
        )
        .unwrap();
        assert_eq!(taken.err(), Some(Verdict::NotVerifiedYet));
        assert!(!read.get());
    }
    assert_eq!(
        serde_json::to_string(&Verdict::NotVerifiedYet).unwrap(),
        r#""not-verified-yet""#
    );
    assert_eq!(usable(&other()), Ok(()));
}

#[test]
fn review_l3_the_clipboard_is_cleared_only_when_it_holds_exactly_the_key_that_worked() {
    let dir = TempDir::new("clipboard");
    let desk = KeyDesk::default();
    desk.hold_text(format!("  {OTHER_KEY}\n"), &other());
    assert!(
        !desk.is_the_key_that_worked(OTHER_KEY),
        "nothing has worked yet"
    );
    desk.check(
        &dir.0,
        &other(),
        &names(),
        &Company::default(),
        &FakeStore::default(),
    )
    .unwrap();
    // Something else copied since: kept. The key itself (as copied, with its line break): cleared, once.
    assert!(!desk.is_the_key_that_worked("a church's own note"));
    assert!(!desk.is_the_key_that_worked(&format!("{OTHER_KEY}x")));
    assert!(desk.is_the_key_that_worked(&format!("{OTHER_KEY}\n")));
    assert!(!desk.is_the_key_that_worked(OTHER_KEY), "only once");
}

// ---- Re-check, 2026-11-17: NM2 and Low 3 ---------------------------------------------------------------------------

#[test]
fn review_nm2_another_services_secret_is_refused_before_it_goes_anywhere() {
    let secrets = [
        concat!("gh", "p_", "fictional0canary0token0000000000000000"),
        concat!("github", "_pat_", "11fictional0canary0token00000000"),
        concat!("sk", "_live_", "fictional0canary0stripe0key000000"),
        concat!("rk", "_test_", "fictional0canary0stripe0key000000"),
        concat!("xox", "b-", "000000000000-fictional0canary0slack"),
        concat!("AKIA", "FICTIONALCANARY0"),
        concat!(
            "eyJ",
            "hbGciOiJIUzI1NiJ9.eyJzdWIiOiJmaWN0aW9uYWwifQ.c2lnbmF0dXJlLWNhbmFyeQ"
        ),
        concat!("-----", "BEGIN-PRIVATE-KEY-----fictional0canary"),
    ];
    for secret in secrets {
        for choice in [openai(), anthropic(), gemini(), other()] {
            let company = Company::default();
            let verdict = check_and_save(
                &TempDir::new("foreign").0,
                &choice,
                secret,
                &names(),
                &company,
                &FakeStore::default(),
            )
            .unwrap();
            assert_eq!(
                verdict.verdict,
                Verdict::NotAnAiKey,
                "{secret} for {}",
                choice.id()
            );
            assert_eq!(company.count(), 0);
        }
    }
    assert_eq!(
        serde_json::to_string(&Verdict::NotAnAiKey).unwrap(),
        r#""not-an-ai-key""#
    );
    // Google takes only its own prefixes now: AIza and the new-style AQ.
    assert!(preset("gemini").unwrap().prefix_required);
    assert_eq!(
        shape_verdict(&gemini(), "AQ.Fictional0Canary0Key0Gemini0000000"),
        Ok(())
    );
    assert_eq!(
        shape_verdict(&gemini(), "password-like-fictional-canary-0000"),
        Err((Verdict::ConfirmUnknownShape, None))
    );
    assert_eq!(
        shape_verdict(
            &gemini(),
            concat!("sk-", "or-v1-0000fictional0canary0key0000")
        ),
        Err((Verdict::WrongKind, Some("openrouter")))
    );
}

#[test]
fn review_low3_an_openrouter_key_is_never_taken_as_an_openai_one() {
    let key = concat!("sk-", "or-v1-0000fictional0canary0key0for0openrouter");
    assert_eq!(
        shape_verdict(&openai(), key),
        Err((Verdict::WrongKind, Some("openrouter")))
    );
    // At another company's address (OpenRouter's own), it goes there as before.
    assert_eq!(
        shape_verdict(&other_at("https://openrouter.ai/api/v1", "m"), key),
        Ok(())
    );
}

#[test]
fn review_n1_n5_the_verdicts_provider_is_never_text_and_nothing_on_the_key_path_asserts_with_a_value()
 {
    // `provider` is a fixed word: the company id or "other" (`Choice::id` is &'static str).
    let id: &'static str = openai().id();
    assert_eq!(KeyVerdict::of(Verdict::Empty, id).provider, "openai");
    let core = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let app = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../product/desktop/src-tauri/src");
    for path in [
        core.join("own_key.rs"),
        core.join("model.rs"),
        core.join("anthropic.rs"),
        core.join("local_ai.rs"),
        app.join("key_sheet.rs"),
    ] {
        let text = std::fs::read_to_string(&path).unwrap();
        let code = text.split("#[cfg(test)]").next().unwrap();
        for banned in ["debug_assert!", "debug_assert_eq!", "debug_assert_ne!"] {
            assert!(!code.contains(banned), "{}: {banned}", path.display());
        }
    }
}

// ---- Vendor docs check, 2026-11-17: admin keys, new verdicts, Google's unknown shapes, providers.json ---------------

#[test]
fn vendor_check_admin_and_oauth_keys_are_refused_before_anything_is_sent() {
    let company = Company::default();
    for (choice, key, verdict) in [
        (
            openai(),
            concat!("sk-", "admin-fictional0canary0key0000000000"),
            Verdict::AdminKey,
        ),
        (
            anthropic(),
            concat!("sk-", "ant-admin01-fictional0canary0key00000"),
            Verdict::AdminKey,
        ),
        // A sign-in token, said as what it is (review L-3b, 2026-11-18).
        (
            anthropic(),
            concat!("sk-", "ant-oat01-fictional0canary0key0000000"),
            Verdict::SignInToken,
        ),
        (
            anthropic(),
            concat!("sk-", "ant-other-fictional0canary0key000000"),
            Verdict::NotAKey,
        ),
    ] {
        let checked = check_and_save(
            &TempDir::new("admin").0,
            &choice,
            key,
            &names(),
            &company,
            &FakeStore::default(),
        )
        .unwrap();
        assert_eq!(checked.verdict, verdict, "{key}");
    }
    assert_eq!(company.count(), 0);
    assert_eq!(
        serde_json::to_string(&Verdict::AdminKey).unwrap(),
        r#""admin-key""#
    );
    // An ordinary Anthropic key still goes.
    assert_eq!(shape_verdict(&anthropic(), ANTHROPIC_KEY), Ok(()));
}

/// Review L2 and L3 (2026-11-18): an Anthropic or OpenAI administrator's key, and Anthropic's sign-in and session
/// tokens, are refused by whose key they are, not only on that company's card: "Another AI company" pointed at the
/// company's own address (or anywhere else) refuses them too, and nothing is sent.
#[test]
fn review_l2_l3_admin_keys_and_sign_in_tokens_are_refused_whichever_way_they_come() {
    let admin = concat!("sk-", "ant-admin01-fictional0canary0key00000");
    let oauth = concat!("sk-", "ant-oat01-fictional0canary0key0000000");
    let session = concat!("sk-", "ant-sid01-fictional0canary0key0000000");
    let openai_admin = concat!("sk-", "admin-fictional0canary0key0000000000");
    let at_anthropic = other_at("https://api.anthropic.com/v1", "claude-haiku-5-5");
    let at_openai = other_at("https://api.openai.com/v1", "gpt-5-mini");
    let company = Company::default();
    for (choice, key, verdict) in [
        // The company's own card, as before, and the session token now named (L3); both sign-in tokens said as what
        // they are (review L-3b, 2026-11-18).
        (anthropic(), admin, Verdict::AdminKey),
        (anthropic(), oauth, Verdict::SignInToken),
        (anthropic(), session, Verdict::SignInToken),
        (openai(), openai_admin, Verdict::AdminKey),
        // Another AI company at the company's own address (L2): sent before this review.
        (at_anthropic.clone(), admin, Verdict::AdminKey),
        (at_anthropic.clone(), oauth, Verdict::SignInToken),
        (at_anthropic.clone(), session, Verdict::SignInToken),
        (at_openai.clone(), openai_admin, Verdict::AdminKey),
        // Another AI company anywhere else.
        (other(), admin, Verdict::AdminKey),
        (other(), openai_admin, Verdict::AdminKey),
    ] {
        let checked = check_and_save(
            &TempDir::new("admin-anywhere").0,
            &choice,
            key,
            &names(),
            &company,
            &FakeStore::default(),
        )
        .unwrap();
        assert_eq!(checked.verdict, verdict, "{} {key}", choice.id());
    }
    assert_eq!(company.count(), 0, "nothing was sent");
    // Another company's card still says whose key it is, so the person can take it there.
    assert_eq!(
        shape_verdict(&gemini(), admin),
        Err((Verdict::WrongKind, Some("anthropic")))
    );
    assert_eq!(
        shape_verdict(&anthropic(), openai_admin),
        Err((Verdict::WrongKind, Some("openai")))
    );
    // An ordinary key at the company's own address still goes, by either way.
    assert_eq!(shape_verdict(&at_anthropic, ANTHROPIC_KEY), Ok(()));
    assert_eq!(shape_verdict(&at_openai, OPENAI_KEY), Ok(()));
}

#[test]
fn vendor_check_a_google_key_of_an_unknown_shape_is_sent_only_after_a_native_yes() {
    let odd = "Fictional0Canary0Google0Key0NewShape000";
    assert_eq!(
        shape_verdict(&gemini(), odd),
        Err((Verdict::ConfirmUnknownShape, None))
    );
    assert_eq!(
        serde_json::to_string(&Verdict::ConfirmUnknownShape).unwrap(),
        r#""confirm-unknown-shape""#
    );
    // Without the yes, nothing is sent and the key stays held for the question; with it, the check goes to Google.
    let dir = TempDir::new("odd-shape");
    let desk = KeyDesk::default();
    let company = Company::default();
    desk.hold(Zeroizing::new(odd.into()), &gemini());
    assert_eq!(
        desk.check(&dir.0, &gemini(), &names(), &company, &FakeStore::default())
            .unwrap()
            .verdict,
        Verdict::ConfirmUnknownShape
    );
    assert_eq!(company.count(), 0);
    assert_eq!(
        desk.check_shape_confirmed(&dir.0, &gemini(), &names(), &company, &FakeStore::default())
            .unwrap()
            .verdict,
        Verdict::Works
    );
    assert_eq!(hosts(&company), ["generativelanguage.googleapis.com"]);
    // Known shapes never ask; other companies' prefixes and other services' secrets are still refused outright.
    assert_eq!(shape_verdict(&gemini(), GEMINI_KEY), Ok(()));
    assert_eq!(
        shape_verdict(&gemini(), "sk-plainfictional0canary0key000000"),
        Err((Verdict::WrongKind, Some("openai")))
    );
    assert_eq!(
        shape_verdict(
            &gemini(),
            concat!("gh", "p_", "fictional0canary0token0000000000")
        ),
        Err((Verdict::NotAnAiKey, None))
    );
    // The yes is only for Google: another company's card never asks.
    assert_eq!(shape_verdict(&openai(), odd), Err((Verdict::NotAKey, None)));
}

#[test]
fn vendor_check_the_documented_refusals_give_their_own_verdicts() {
    let ok = |c: &Choice, status: u16, body: &str| classify(c, Ok((status, body.as_bytes())));
    // A project without the model is not a bad key, even as a 403.
    assert_eq!(
        ok(
            &openai(),
            403,
            r#"{"error":{"message":"Project does not have access to model `gpt-6-luna`","code":"model_not_found"}}"#
        ),
        Verdict::ModelUnavailable
    );
    assert_eq!(
        ok(
            &openai(),
            403,
            r#"{"error":{"code":"unsupported_country_region_territory","message":"Country, region, or territory not supported"}}"#
        ),
        Verdict::Region
    );
    assert_eq!(
        ok(
            &openai(),
            401,
            r#"{"error":{"message":"You have insufficient permissions for this operation. Missing scopes: model.request."}}"#
        ),
        Verdict::RestrictedKey
    );
    assert_eq!(
        ok(
            &openai(),
            503,
            r#"{"error":{"type":"service_unavailable_error","code":"server_is_overloaded"}}"#
        ),
        Verdict::ProviderBusy
    );
    assert_eq!(
        ok(
            &anthropic(),
            529,
            r#"{"type":"error","error":{"type":"overloaded_error"}}"#
        ),
        Verdict::ProviderBusy
    );
    assert_eq!(
        classify(&openai(), Err(ModelError::ProviderFailure)),
        Verdict::Unreachable
    );
    assert_eq!(
        ok(
            &anthropic(),
            400,
            r#"{"type":"error","error":{"type":"invalid_request_error","message":"You have reached your specified workspace API usage limits."}}"#
        ),
        Verdict::NoCredit
    );
    assert_eq!(
        ok(
            &gemini(),
            403,
            r#"{"error":{"code":403,"status":"PERMISSION_DENIED","details":[{"reason":"FREE_TIER_VERIFICATION_REQUIRED"}]}}"#
        ),
        Verdict::NeedsProjectSetup
    );
    assert_eq!(
        ok(
            &gemini(),
            403,
            r#"{"error":{"code":403,"message":"Your project has been denied access. Please contact support."}}"#
        ),
        Verdict::NeedsProjectSetup
    );
    assert_eq!(
        ok(
            &gemini(),
            403,
            r#"{"error":{"code":403,"message":"Your project has an outstanding balance."}}"#
        ),
        Verdict::NoCredit
    );
    assert_eq!(
        ok(
            &gemini(),
            400,
            r#"{"error":{"code":400,"message":"Multiple authentication credentials received. Please pass only one."}}"#
        ),
        Verdict::AuthConflict
    );
    assert_eq!(
        ok(
            &gemini(),
            400,
            r#"{"error":{"code":400,"message":"User location is not supported for the API use.","status":"FAILED_PRECONDITION"}}"#
        ),
        Verdict::Region
    );
    assert_eq!(
        ok(
            &gemini(),
            400,
            r#"{"error":{"code":400,"message":"Gemini API free tier is not available in your country. Please enable billing on your project in Google AI Studio.","status":"FAILED_PRECONDITION"}}"#
        ),
        Verdict::NeedsBilling
    );
    assert_eq!(
        ok(
            &gemini(),
            400,
            r#"{"error":{"code":400,"status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}"#
        ),
        Verdict::Refused
    );
    for (verdict, word) in [
        (Verdict::Region, "region"),
        (Verdict::RestrictedKey, "restricted-key"),
        (Verdict::ProviderBusy, "provider-busy"),
        (Verdict::NeedsProjectSetup, "needs-project-setup"),
        (Verdict::AuthConflict, "auth-conflict"),
    ] {
        assert_eq!(
            serde_json::to_string(&verdict).unwrap(),
            format!("\"{word}\"")
        );
    }
}

#[test]
fn vendor_check_providers_json_says_what_the_docs_say() {
    let [openai, anthropic, gemini] = [
        preset("openai").unwrap(),
        preset("anthropic").unwrap(),
        preset("gemini").unwrap(),
    ];
    assert_eq!(openai.min_topup.as_deref(), Some("$5"));
    assert_eq!(
        openai.retention_line,
        "OpenAI doesn't train its models on what apps send through a key unless you choose to share it, and keeps it for up to 30 days to watch for abuse, longer only if the law requires it or to protect its services."
    );
    assert_eq!(
        anthropic.retention_line,
        "Anthropic doesn't use what apps send through a key to train its models by default, and deletes it within 30 days unless it is flagged for a policy violation or the law requires longer."
    );
    assert_eq!(
        anthropic.key_prefixes,
        ["sk-ant-api", "sk-ant-usr", "sk-ant-svc"]
    );
    assert_eq!(anthropic.owned_prefixes, ["sk-ant-"]);
    assert_eq!(
        anthropic.key_note.as_deref(),
        Some(
            "When you create the key, choose a workspace for it, and choose Never for when it expires (if Never isn't offered, pick the longest time) unless your church's policy says otherwise."
        )
    );
    assert_eq!(
        (
            anthropic.pages.sign_in.as_str(),
            anthropic.pages.settings.as_str()
        ),
        (
            "https://platform.claude.com/",
            "https://platform.claude.com/settings/workspaces"
        )
    );
    // Gemini: no reasoning setting on a plain request; "medium" when tools are offered (Google: avoids stopping tool
    // calls early). Never "none": reasoning can't be turned off on Gemini 3.
    assert_eq!(
        (
            gemini.reasoning_effort.as_deref(),
            gemini.reasoning_effort_with_tools.as_deref()
        ),
        (None, None)
    );
    assert!(
        catalog()
            .presets
            .iter()
            .all(|p| p.reasoning_effort.as_deref() != Some("none") || p.id == "openai")
    );
}

// ---- review-fix3 (independent review, 2026-11-17): shape and classify tables -----------------------------------
fn rf3_body(len: usize, seed: u8) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    (0..len)
        .map(|i| CHARS[(i * 7 + usize::from(seed)) % CHARS.len()] as char)
        .collect()
}
fn rf3_alnum(len: usize) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    (0..len)
        .map(|i| CHARS[(i * 11 + 3) % CHARS.len()] as char)
        .collect()
}
#[test]
fn review_fix3_shape_table() {
    let proj = format!("{}{}", concat!("sk-", "proj-"), rf3_body(156, 1));
    let ant = format!("{}{}AA", concat!("sk-", "ant-api03-"), rf3_body(93, 2));
    let aiza = format!("{}{}", concat!("AI", "za"), rf3_body(35, 3));
    let rows: Vec<(&str, String)> = vec![
        ("openai sk-proj (164)", proj.clone()),
        (
            "openai sk-svcacct",
            format!("{}{}", concat!("sk-", "svcacct-"), rf3_body(150, 4)),
        ),
        ("openai legacy sk- (51)", format!("sk-{}", rf3_alnum(48))),
        (
            "openai sk-admin",
            format!("{}{}", concat!("sk-", "admin-"), rf3_body(150, 5)),
        ),
        ("anthropic sk-ant-api03 (108)", ant.clone()),
        (
            "anthropic sk-ant-api01",
            format!("{}{}", concat!("sk-", "ant-api01-"), rf3_body(90, 6)),
        ),
        (
            "anthropic sk-ant-admin01",
            format!("{}{}", concat!("sk-", "ant-admin01-"), rf3_body(90, 7)),
        ),
        (
            "anthropic sk-ant-oat01",
            format!("{}{}", concat!("sk-", "ant-oat01-"), rf3_body(90, 8)),
        ),
        (
            "anthropic sk-ant-sid01",
            format!("{}{}", concat!("sk-", "ant-sid01-"), rf3_body(90, 9)),
        ),
        ("google AIza (39)", aiza.clone()),
        ("google AQ. (53)", format!("AQ.{}", rf3_body(50, 10))),
        ("google aiza lower", format!("aiza{}", rf3_body(35, 11))),
        (
            "openrouter sk-or-v1",
            format!("{}{}", concat!("sk-", "or-v1-"), rf3_alnum(64)),
        ),
        (
            "deepseek-like sk-hex32",
            format!("sk-{}", "0123456789abcdef0123456789abcdef"),
        ),
        ("xai-", format!("xai-{}", rf3_alnum(80))),
        ("groq gsk_", format!("gsk_{}", rf3_alnum(52))),
        (
            "github ghp_",
            format!("{}{}", concat!("gh", "p_"), rf3_alnum(36)),
        ),
        (
            "github_pat_",
            format!("{}{}", concat!("github", "_pat_"), rf3_body(82, 12)),
        ),
        (
            "stripe sk_live_",
            format!("{}{}", concat!("sk_", "live_"), rf3_alnum(99)),
        ),
        (
            "stripe rk_live_",
            format!("{}{}", concat!("rk_", "live_"), rf3_alnum(99)),
        ),
        (
            "slack xoxb-",
            format!("{}{}", concat!("xo", "xb-"), rf3_body(50, 13)),
        ),
        (
            "aws AKIA (20)",
            format!("{}{}", concat!("AK", "IA"), "ABCDEFGHIJKLMNOP"),
        ),
        (
            "jwt eyJ",
            format!("eyJ{}.{}.{}", rf3_alnum(30), rf3_alnum(40), rf3_alnum(20)),
        ),
        (
            "pem -----BEGIN (no space)",
            format!("-----BEGIN{}", rf3_alnum(40)),
        ),
        (
            "pco-like 64 hex",
            "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6".to_owned(),
        ),
        ("19 chars", "sk-".to_owned() + &rf3_alnum(16)),
        ("20 chars sk-", "sk-".to_owned() + &rf3_alnum(17)),
        ("512 chars sk-", "sk-".to_owned() + &rf3_alnum(509)),
        ("513 chars sk-", "sk-".to_owned() + &rf3_alnum(510)),
        ("proj with trailing \\n (raw)", format!("{proj}\n")),
        (
            "proj with spaces+\\n (trimmed)",
            trimmed(&format!("  {proj}\r\n")).to_owned(),
        ),
        (
            "proj wrapped mid-line",
            format!("{}\n{}", &proj[..80], &proj[80..]),
        ),
        ("proj in double quotes", format!("\"{proj}\"")),
        ("proj in single quotes", format!("'{proj}'")),
        ("Bearer proj", format!("Bearer {proj}")),
        ("proj with Cyrillic a", proj.replacen('A', "\u{0430}", 1)),
        (
            "proj with NBSP after (trimmed)",
            trimmed(&format!("{proj}\u{00a0}")).to_owned(),
        ),
        ("ant with zero-width space", format!("{ant}\u{200b}")),
        ("AIza in quotes", format!("\"{aiza}\"")),
    ];
    let choices = [
        ("openai", Choice::Preset(preset("openai").unwrap())),
        ("anthropic", Choice::Preset(preset("anthropic").unwrap())),
        ("gemini", Choice::Preset(preset("gemini").unwrap())),
        (
            "other@api.example.invalid",
            Choice::Other {
                base_url: "https://api.example.invalid/v1".into(),
                model: "m".into(),
            },
        ),
    ];
    let show = |r: Result<(), (Verdict, Option<&'static str>)>| match r {
        Ok(()) => "OK".to_owned(),
        Err((v, Some(o))) => format!("{v:?}({o})"),
        Err((v, None)) => format!("{v:?}"),
    };
    let mut out = String::from("| key | len | openai | anthropic | gemini | other |\n");
    for (label, key) in &rows {
        out.push_str(&format!("| {label} | {} |", key.len()));
        for (_, choice) in &choices {
            out.push_str(&format!(" {} |", show(shape_verdict(choice, key))));
        }
        out.push('\n');
    }
    std::fs::write(
        std::env::temp_dir().join("ozzie-review-fix3-shape-table.md"),
        &out,
    )
    .unwrap();
    // The three documented shapes pass on their own card.
    assert_eq!(shape_verdict(&choices[0].1, &proj), Ok(()));
    assert_eq!(shape_verdict(&choices[1].1, &ant), Ok(()));
    assert_eq!(shape_verdict(&choices[2].1, &aiza), Ok(()));
}

#[test]
fn review_fix3_classify_table() {
    let o = Choice::Preset(preset("openai").unwrap());
    let a = Choice::Preset(preset("anthropic").unwrap());
    let g = Choice::Preset(preset("gemini").unwrap());
    let x = Choice::Other {
        base_url: "https://api.example.invalid/v1".into(),
        model: "m".into(),
    };
    let gerr = |code: u16, status: &str, message: &str, extra: &str| {
        format!(
            r#"[{{"error":{{"code":{code},"message":"{message}","status":"{status}","details":[{extra}]}}}}]"#
        )
    };
    let oerr = |message: &str, kind: &str, code: &str| {
        format!(
            r#"{{"error":{{"message":"{message}","type":"{kind}","param":null,"code":"{code}"}}}}"#
        )
    };
    let aerr = |kind: &str, message: &str| {
        format!(r#"{{"type":"error","error":{{"type":"{kind}","message":"{message}"}}}}"#)
    };
    let rows: Vec<(&str, &Choice, u16, String)> = vec![
        ("O 401 incorrect key", &o, 401, oerr("Incorrect API key provided: sk-proj-****abcd. You can find your API key at https://platform.openai.com/account/api-keys.", "invalid_request_error", "invalid_api_key")),
        ("O 401 no organization", &o, 401, oerr("You must be a member of an organization to use the API. Please contact us through our help center at help.openai.com.", "invalid_request_error", "no_organization")),
        ("O 403 unsupported country", &o, 403, oerr("Country, region, or territory not supported", "request_forbidden", "unsupported_country_region_territory")),
        ("O 404 model_not_found", &o, 404, oerr("The model `gpt-6-luna` does not exist or you do not have access to it.", "invalid_request_error", "model_not_found")),
        ("O 403 project no model", &o, 403, oerr("Project `proj_abc` does not have access to model `gpt-6-luna`", "invalid_request_error", "model_not_found")),
        ("O 401 restricted key", &o, 401, oerr("You have insufficient permissions for this operation. Missing scopes: model.request. Check that you have the correct role in your organization (Reader, Writer, Owner) and project (Member, Owner), and if you're using a restricted API key, that it has the necessary scopes.", "invalid_request_error", "")),
        ("O 429 insufficient_quota", &o, 429, oerr("You exceeded your current quota, please check your plan and billing details.", "insufficient_quota", "insufficient_quota")),
        ("O 429 credit_balance_exhausted", &o, 429, oerr("Your credit balance is exhausted.", "insufficient_quota", "credit_balance_exhausted")),
        ("O 429 org spend limit", &o, 429, oerr("Organization spend limit exceeded.", "insufficient_quota", "organization_spend_limit_exceeded")),
        ("O 429 project spend limit", &o, 429, oerr("Project spend limit exceeded.", "insufficient_quota", "project_spend_limit_exceeded")),
        ("O 429 org usage limit", &o, 429, oerr("Usage limit exceeded.", "insufficient_quota", "organization_usage_limit_exceeded")),
        ("O 429 rate limit", &o, 429, oerr("Rate limit reached for gpt-6-luna in organization org-x on requests per min (RPM): Limit 3, Used 3.", "requests", "rate_limit_exceeded")),
        ("O 429 slow_down", &o, 429, oerr("Please slow down.", "requests", "slow_down")),
        ("O 500 server_error", &o, 500, oerr("The server had an error while processing your request.", "server_error", "")),
        ("O 503 overloaded", &o, 503, oerr("The engine is currently overloaded, please try again later.", "server_error", "server_is_overloaded")),
        ("O 400 bad param", &o, 400, oerr("Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.", "invalid_request_error", "unsupported_parameter")),
        ("A 401 authentication_error", &a, 401, aerr("authentication_error", "invalid x-api-key")),
        ("A 403 permission_error", &a, 403, aerr("permission_error", "Your API key does not have permission to use the specified resource.")),
        ("A 400 credit balance", &a, 400, aerr("invalid_request_error", "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.")),
        ("A 402 billing_error", &a, 402, aerr("billing_error", "There is an issue with your billing or payment information.")),
        ("A 400 usage limits", &a, 400, aerr("invalid_request_error", "You have reached your specified API usage limits. You will regain access on 2026-12-01 at 00:00 UTC.")),
        ("A 400 workspace usage limits", &a, 400, aerr("invalid_request_error", "You have reached your specified workspace API usage limits. You will regain access on 2026-12-01 at 00:00 UTC.")),
        ("A 429 enforced spend limit", &a, 429, r#"{"type":"error","error":{"type":"rate_limit_error","message":"Spend limit reached.","details":{"error_code":"enforced_spend_limit_reached"}}}"#.to_owned()),
        ("A 429 ramp limit", &a, 429, r#"{"type":"error","error":{"type":"rate_limit_error","message":"Ramp limit.","details":{"error_code":"ramp_limit_exceeded"}}}"#.to_owned()),
        ("A 429 plain rate limit", &a, 429, aerr("rate_limit_error", "Number of request tokens has exceeded your per-minute rate limit")),
        ("A 404 not_found_error", &a, 404, aerr("not_found_error", "model: claude-haiku-5-5")),
        ("A 413 request_too_large", &a, 413, aerr("request_too_large", "Request exceeds the maximum allowed number of bytes.")),
        ("A 500 api_error", &a, 500, aerr("api_error", "Internal server error")),
        ("A 504 timeout_error", &a, 504, aerr("timeout_error", "Request timed out")),
        ("A 529 overloaded_error", &a, 529, aerr("overloaded_error", "Overloaded")),
        ("A 400 thinking cannot be disabled", &a, 400, aerr("invalid_request_error", "thinking: cannot be disabled at this effort")),
        ("A 400 guessed workspace marker", &a, 400, aerr("invalid_request_error", "anthropic-workspace-id header is required")),
        ("G 400 API_KEY_INVALID", &g, 400, gerr(400, "INVALID_ARGUMENT", "API key not valid. Please pass a valid API key.", r#"{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"API_KEY_INVALID","domain":"googleapis.com"}"#)),
        ("G 400 key expired", &g, 400, gerr(400, "INVALID_ARGUMENT", "API key expired. Please renew the API key.", r#"{"reason":"API_KEY_INVALID"}"#)),
        ("G 402 prepay depleted", &g, 402, gerr(402, "RESOURCE_EXHAUSTED", "Prepay credit balance is depleted.", "")),
        ("G 400 free tier not in country", &g, 400, gerr(400, "FAILED_PRECONDITION", "Gemini API free tier is not available in your country. Please enable billing on your project in Google AI Studio.", "")),
        ("G 400 user location", &g, 400, gerr(400, "FAILED_PRECONDITION", "User location is not supported for the API use.", "")),
        ("G 403 FREE_TIER_VERIFICATION_REQUIRED", &g, 403, gerr(403, "PERMISSION_DENIED", "Verification required.", r#"{"reason":"FREE_TIER_VERIFICATION_REQUIRED"}"#)),
        ("G 403 denied access", &g, 403, gerr(403, "PERMISSION_DENIED", "Your project has been denied access. Please contact support.", "")),
        ("G 403 outstanding balance", &g, 403, gerr(403, "PERMISSION_DENIED", "Your project has an outstanding balance.", "")),
        ("G 403 unregistered callers", &g, 403, gerr(403, "PERMISSION_DENIED", "Method doesn't allow unregistered callers (callers without established identity). Please use API Key or other form of API consumer identity to call this API.", "")),
        ("G 403 API_KEY_SERVICE_BLOCKED", &g, 403, gerr(403, "PERMISSION_DENIED", "Requests to this API generativelanguage.googleapis.com method google.ai.generativelanguage.v1beta.GenerativeService.GenerateContent are blocked.", r#"{"reason":"API_KEY_SERVICE_BLOCKED"}"#)),
        ("G 401 UNAUTHENTICATED (oauth)", &g, 401, gerr(401, "UNAUTHENTICATED", "Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential.", r#"{"reason":"ACCESS_TOKEN_TYPE_UNSUPPORTED"}"#)),
        ("G 429 PerDay", &g, 429, gerr(429, "RESOURCE_EXHAUSTED", "You exceeded your current quota, please check your plan and billing details.", r#"{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}"#)),
        ("G 429 PerMinute", &g, 429, gerr(429, "RESOURCE_EXHAUSTED", "You exceeded your current quota, please check your plan and billing details.", r#"{"quotaId":"GenerateRequestsPerMinutePerProjectPerModel-FreeTier"}"#)),
        ("G 429 limit 0 PerDay", &g, 429, gerr(429, "RESOURCE_EXHAUSTED", "Quota exceeded for metric: generate_content_free_tier_requests, limit: 0", r#"{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier","quotaValue":"0"}"#)),
        ("G 404 model not found", &g, 404, gerr(404, "NOT_FOUND", "models/gemini-3.5-flash-lite is not found for API version v1beta.", "")),
        ("G 503 UNAVAILABLE", &g, 503, gerr(503, "UNAVAILABLE", "The model is overloaded. Please try again later.", "")),
        ("G 400 multiple credentials", &g, 400, gerr(400, "INVALID_ARGUMENT", "Multiple authentication credentials received. Please only send one.", "")),
        ("G 400 missing thought_signature", &g, 400, gerr(400, "INVALID_ARGUMENT", "Function call is missing a thought_signature in functionCall parts.", "")),
        ("X 404 no model word", &x, 404, "Not Found".to_owned()),
        ("X 401", &x, 401, "{}".to_owned()),
        ("X 429 insufficient_quota", &x, 429, oerr("q", "insufficient_quota", "insufficient_quota")),
    ];
    let mut out = String::from("| case | status | verdict |\n");
    for (label, choice, status, body) in &rows {
        let v = classify(choice, Ok((*status, body.as_bytes())));
        out.push_str(&format!("| {label} | {status} | {v:?} |\n"));
    }
    out.push_str(&format!(
        "| no answer (network) | - | {:?} |\n",
        classify(&o, Err(ModelError::ProviderFailure))
    ));
    std::fs::write(
        std::env::temp_dir().join("ozzie-review-fix3-classify-table.md"),
        &out,
    )
    .unwrap();
}

// ---- Review fix3, asserting the tables (2026-11-17) ------------------------------------------------------------------

#[test]
fn review_fix3_the_shape_table_asserted() {
    let quoted = format!("\"{OPENAI_KEY}\"");
    let curly = format!("\u{201c}{ANTHROPIC_KEY}\u{201d}");
    let xai = concat!("xai-", "fictional0canary0key0000000000000000");
    let groq = concat!("gsk_", "fictional0canary0key0000000000000000");
    // Quotes from a document are taken off before every rule, and the key sent is the unquoted one.
    assert_eq!(trimmed(&quoted), OPENAI_KEY);
    assert_eq!(trimmed(&curly), ANTHROPIC_KEY);
    let company = Company::default();
    let verdict = check_and_save(
        &TempDir::new("quoted").0,
        &openai(),
        &quoted,
        &names(),
        &company,
        &FakeStore::default(),
    )
    .unwrap();
    assert_eq!(verdict.verdict, Verdict::Works);
    assert_eq!(
        company.sent.lock().unwrap()[0].1.as_deref(),
        Some(OPENAI_KEY)
    );
    // Other AI companies' keys are named, never the Google question.
    for (key, owner) in [(xai, "xai"), (groq, "groq")] {
        for choice in [openai(), anthropic(), gemini()] {
            assert_eq!(
                shape_verdict(&choice, key),
                Err((Verdict::WrongKind, Some(owner))),
                "{key} {}",
                choice.id()
            );
        }
    }
    // A quoted secret of another service is still refused before the Google question.
    assert_eq!(
        shape_verdict(
            &gemini(),
            trimmed(&format!(
                "\"{}\"",
                concat!("gh", "p_", "fictional0canary0token000000000")
            ))
        ),
        Err((Verdict::NotAnAiKey, None))
    );
    // On Google's card, text that doesn't start with a letter or digit isn't a key.
    for odd in [
        "-fictional0canary0key0000000000000",
        "_fictional0canary0key0000000000000",
        ".fictional0canary0key0000000000000",
    ] {
        assert_eq!(
            shape_verdict(&gemini(), odd),
            Err((Verdict::NotAKey, None)),
            "{odd}"
        );
    }
}

#[test]
fn review_fix3_needs_billing_and_needs_organization_are_their_own_words() {
    let ok = |c: &Choice, status: u16, body: &str| classify(c, Ok((status, body.as_bytes())));
    assert_eq!(
        ok(
            &gemini(),
            400,
            r#"{"error":{"message":"Gemini API free tier is not available in your country. Please enable billing on your project in Google AI Studio.","status":"FAILED_PRECONDITION"}}"#
        ),
        Verdict::NeedsBilling
    );
    assert_eq!(
        ok(
            &gemini(),
            400,
            r#"{"error":{"message":"User location is not supported for the API use.","status":"FAILED_PRECONDITION"}}"#
        ),
        Verdict::Region
    );
    assert_eq!(
        ok(
            &openai(),
            401,
            r#"{"error":{"message":"You must be a member of an organization to use the API.","code":"no_organization"}}"#
        ),
        Verdict::NeedsOrganization
    );
    assert_eq!(
        serde_json::to_string(&Verdict::NeedsBilling).unwrap(),
        r#""needs-billing""#
    );
    assert_eq!(
        serde_json::to_string(&Verdict::NeedsOrganization).unwrap(),
        r#""needs-organization""#
    );
}

#[test]
fn review_fix3_l4_one_unknown_shape_attempt_counts_as_one_check() {
    let dir = TempDir::new("one-count");
    let desk = KeyDesk::default();
    let company = Company::default();
    let odd = "Fictional0Canary0Google0Key0NewShape000";
    for _ in 0..5 {
        desk.hold(Zeroizing::new(odd.into()), &gemini());
        assert_eq!(
            desk.check(&dir.0, &gemini(), &names(), &company, &FakeStore::default())
                .unwrap()
                .verdict,
            Verdict::ConfirmUnknownShape
        );
        assert_eq!(
            desk.check_shape_confirmed(
                &dir.0,
                &gemini(),
                &names(),
                &company,
                &FakeStore::default()
            )
            .unwrap()
            .verdict,
            Verdict::Works
        );
    }
    // Five attempts, each one check: five more are allowed this hour, then none.
    desk.hold(Zeroizing::new(odd.into()), &gemini());
    let left: Vec<Verdict> = (0..6)
        .map(|_| {
            desk.check(&dir.0, &gemini(), &names(), &company, &FakeStore::default())
                .unwrap()
                .verdict
        })
        .collect();
    assert_eq!(left[..5], [Verdict::ConfirmUnknownShape; 5]);
    assert_eq!(left[5], Verdict::TooManyChecks);
    // The last question's yes finishes that counted attempt; a yes with no question waiting is an ordinary check.
    let ok = |d: &KeyDesk| {
        d.check_shape_confirmed(&dir.0, &gemini(), &names(), &company, &FakeStore::default())
            .unwrap()
            .verdict
    };
    assert_eq!(ok(&desk), Verdict::Works);
    desk.hold(Zeroizing::new(odd.into()), &gemini());
    assert_eq!(ok(&desk), Verdict::TooManyChecks);
}

/// The Console's personal and service keys (`sk-ant-usr-`, `sk-ant-svc-`) are ordinary keys: the owner's own key
/// was the first kind and was turned away as "not a whole key" (live test, 2026-11-18).
#[test]
fn anthropic_personal_and_service_keys_are_taken() {
    let anthropic = catalog()
        .presets
        .iter()
        .find(|p| p.id == "anthropic")
        .unwrap();
    let openai = catalog().presets.iter().find(|p| p.id == "openai").unwrap();
    for prefix in [
        concat!("sk-", "ant-usr-"),
        concat!("sk-", "ant-svc-"),
        concat!("sk-", "ant-api03-"),
    ] {
        let key = format!("{prefix}{}", "a".repeat(106 - prefix.len()));
        assert_eq!(
            shape_verdict(&Choice::Preset(anthropic), &key),
            Ok(()),
            "{prefix}"
        );
        assert_eq!(
            shape_verdict(&Choice::Preset(openai), &key),
            Err((Verdict::WrongKind, Some("anthropic"))),
            "{prefix}"
        );
    }
}

/// A company as shipped: each passed the owner's live test on 2026-11-18.
fn verified(id: &str) -> Choice {
    Choice::Preset(preset(id).unwrap())
}

// ---- A check the person walked away from never switches the AI when it finishes (review M-2, 2026-11-18) ------------

/// A company that answers only after `meanwhile` ran: what the person did on another screen while the key was checked.
struct AnswersAfter<'a, F: Fn()> {
    company: &'a Company,
    meanwhile: F,
}
impl<F: Fn()> ModelHttp for AnswersAfter<'_, F> {
    fn post(
        &self,
        url: &str,
        key: Option<(&str, model::KeyHeader)>,
        headers: &[(&str, &str)],
        body: &[u8],
    ) -> Result<(u16, Zeroizing<Vec<u8>>), ModelError> {
        (self.meanwhile)();
        self.company.post(url, key, headers, body)
    }
}

#[test]
fn review_m2_a_key_check_overtaken_by_another_choice_neither_switches_the_ai_nor_keeps_the_key() {
    let names = names();
    // A Claude key check starts; meanwhile the person presses Change, chooses AI on this Mac, and its check passes (as
    // a passing check ends: `local_ai::check`, begun after this one).
    let dir = TempDir::new("overtaken-by-local");
    let store = FakeStore::default();
    let company = Company::default();
    let local_passes = AnswersAfter {
        company: &company,
        meanwhile: || {
            let began = model::route_generation(&dir.0);
            let saved =
                model::save_local_checked(&dir.0, model::LOCAL_BASE, model::LOCAL_MODEL, 7, began);
            assert!(
                saved.unwrap().is_some(),
                "the later check is the person's choice"
            );
        },
    };
    let said = check_and_save(
        &dir.0,
        &anthropic(),
        ANTHROPIC_KEY,
        &names,
        &local_passes,
        &store,
    )
    .unwrap();
    assert_eq!(said.verdict, Verdict::ChoiceChanged);
    assert_eq!(company.count(), 1, "the key was checked");
    assert!(said.status.is_none() && said.looks_like.is_none());
    // The last choice stands: AI on this Mac, nothing leaves it.
    let route = model::load_config(&dir.0).unwrap();
    assert_eq!(
        (route.route, route.base_url.as_str(), route.checked_at_ms),
        (Route::Local, model::LOCAL_BASE, Some(7))
    );
    // Nothing is kept that the person didn't finish choosing: no key, no host to remove later.
    assert!(store.keys.lock().unwrap().is_empty());
    assert!(saved_companies(&dir.0).is_empty());
    assert_eq!(kept_key_count(&dir.0, &store), Some(0));

    // "No AI for now" while a key is checked: no AI is chosen afterwards either.
    let dir = TempDir::new("overtaken-by-none");
    let store = FakeStore::default();
    let company = Company::default();
    let no_ai = AnswersAfter {
        company: &company,
        meanwhile: || {
            model::choose_no_ai(&dir.0, &store).unwrap();
        },
    };
    let said = check_and_save(&dir.0, &openai(), OPENAI_KEY, &names, &no_ai, &store).unwrap();
    assert_eq!(said.verdict, Verdict::ChoiceChanged);
    assert!(model::load_config(&dir.0).is_none());
    assert!(store.keys.lock().unwrap().is_empty());

    // "Remove my key from this Mac" and signing out of Ozzie's AI are choices too.
    for removal in [true, false] {
        let dir = TempDir::new("overtaken-by-removal");
        let store = FakeStore::default();
        let company = Company::default();
        let removed = AnswersAfter {
            company: &company,
            meanwhile: || {
                if removal {
                    remove_keys(&dir.0, &store);
                } else {
                    model::route_choice_made(&dir.0);
                }
            },
        };
        let said = check_and_save(&dir.0, &gemini(), GEMINI_KEY, &names, &removed, &store).unwrap();
        assert_eq!(said.verdict, Verdict::ChoiceChanged, "removal {removal}");
        assert!(model::load_config(&dir.0).is_none());
        assert!(store.keys.lock().unwrap().is_empty());
    }

    // A held key whose check was overtaken isn't held for "Check this key again" either.
    let dir = TempDir::new("overtaken-held");
    let store = FakeStore::default();
    let company = Company::default();
    let desk = KeyDesk::default();
    desk.hold(Zeroizing::new(ANTHROPIC_KEY.to_owned()), &anthropic());
    let no_ai = AnswersAfter {
        company: &company,
        meanwhile: || {
            model::choose_no_ai(&dir.0, &store).unwrap();
        },
    };
    let said = desk
        .check(&dir.0, &anthropic(), &names, &no_ai, &store)
        .unwrap();
    assert_eq!(said.verdict, Verdict::ChoiceChanged);
    assert!(desk.held().is_none());

    // A failed check overtaken says what it found, and changes nothing either way.
    let dir = TempDir::new("overtaken-refused");
    model::save_local_checked(
        &dir.0,
        model::LOCAL_BASE,
        model::LOCAL_MODEL,
        3,
        model::route_generation(&dir.0),
    )
    .unwrap();
    let company = Company::answering(Ok((401, "invalid x-api-key")));
    let no_ai = AnswersAfter {
        company: &company,
        meanwhile: || {
            model::choose_no_ai(&dir.0, &store).unwrap();
        },
    };
    let said = check_and_save(&dir.0, &anthropic(), ANTHROPIC_KEY, &names, &no_ai, &store).unwrap();
    assert_eq!(said.verdict, Verdict::Refused);
    assert!(model::load_config(&dir.0).is_none());

    // Nothing chosen meanwhile: the key works, is kept and chosen, as before.
    let dir = TempDir::new("not-overtaken");
    let store = FakeStore::default();
    let company = Company::default();
    let said = check_and_save(
        &dir.0,
        &anthropic(),
        ANTHROPIC_KEY,
        &names,
        &company,
        &store,
    )
    .unwrap();
    assert_eq!(said.verdict, Verdict::Works);
    assert_eq!(model::load_config(&dir.0).unwrap().route, Route::Own);
    assert_eq!(store.keys.lock().unwrap().len(), 1);
    // The page reads this word.
    assert_eq!(
        serde_json::to_string(&Verdict::ChoiceChanged).unwrap(),
        r#""choice-changed""#
    );
}

/// A Keychain whose keys can't be read, only listed: the count must never read one (review L-4).
struct NoKeyReads<'a>(&'a FakeStore);
impl ModelKeys for NoKeyReads<'_> {
    fn key(&self, account: &str) -> Result<Option<Zeroizing<String>>, StoreError> {
        panic!("a key was read for {account}");
    }
}
impl KeyStore for NoKeyReads<'_> {
    fn put_key(&self, account: &str, key: &str) -> Result<(), StoreError> {
        self.0.put_key(account, key)
    }
    fn delete_key(&self, account: &str) -> Result<(), StoreError> {
        self.0.delete_key(account)
    }
    fn accounts(&self) -> Result<Vec<String>, StoreError> {
        self.0.accounts()
    }
}

#[test]
fn review_l4_the_count_of_kept_keys_reads_no_key_and_agrees_with_what_removal_deletes() {
    let names = names();
    let dir = TempDir::new("kept-count");
    let store = FakeStore::default();
    assert_eq!(kept_key_count(&dir.0, &NoKeyReads(&store)), Some(0));
    // Two companies' keys saved through Ozzie...
    for (choice, key) in [(openai(), OPENAI_KEY), (anthropic(), ANTHROPIC_KEY)] {
        let said =
            check_and_save(&dir.0, &choice, key, &names, &Company::default(), &store).unwrap();
        assert_eq!(said.verdict, Verdict::Works);
    }
    // ...one added by hand for another company's address while that was the route, then No AI for now: Ozzie's own
    // list of hosts never had it, and no route names it any more.
    model::save_config(
        &dir.0,
        Route::Own,
        Some("https://api.example.invalid/v1"),
        Some("fictional-model-1"),
    )
    .unwrap();
    store
        .put_key("own-provider:api.example.invalid", OTHER_KEY)
        .unwrap();
    model::choose_no_ai(&dir.0, &store).unwrap();
    // Ozzie's AI's sign-in and its key share the Keychain's service and are never counted or removed here.
    for account in [model::MANAGED_ACCOUNT, crate::hosted::MANAGED_TOKEN_ACCOUNT] {
        store.put_key(account, "fictional-sign-in-canary").unwrap();
    }
    assert_eq!(kept_key_count(&dir.0, &NoKeyReads(&store)), Some(3));
    // Removal deletes exactly what was counted, the hand-added key included, without reading any of them.
    let removal = remove_keys(&dir.0, &NoKeyReads(&store));
    assert_eq!(removal.removed, "removed");
    let left: Vec<String> = store.keys.lock().unwrap().keys().cloned().collect();
    let mut sign_in = vec![
        model::MANAGED_ACCOUNT.to_owned(),
        crate::hosted::MANAGED_TOKEN_ACCOUNT.to_owned(),
    ];
    sign_in.sort();
    assert_eq!(left, sign_in);
    assert_eq!(kept_key_count(&dir.0, &NoKeyReads(&store)), Some(0));
    // A Keychain that can't list: the count is unknown (the page keeps offering removal), and removal still finds the
    // keys Ozzie knows of by reading them, as before.
    let unlistable = FakeStore {
        unlistable: true,
        ..FakeStore::default()
    };
    unlistable
        .put_key("own-provider:api.openai.com", OPENAI_KEY)
        .unwrap();
    assert_eq!(kept_key_count(&dir.0, &unlistable), None);
    assert_eq!(remove_keys(&dir.0, &unlistable).removed, "removed");
    assert!(unlistable.keys.lock().unwrap().is_empty());
}

/// Review L-2 and L-3 (2026-11-18): Another AI company at a company's own address takes only that company's key shapes;
/// an administrator's key says whose it is; Anthropic's sign-in tokens are named as what they are. Every legitimate
/// key keeps the verdict it had on every card and address (fictional keys, written in parts).
#[test]
fn review_l2_l3_another_ai_company_at_a_companys_address_takes_its_keys_only_and_refusals_say_the_truth()
 {
    let body = |n: usize| rf3_body(n, 21);
    let legacy = format!("sk-{}", rf3_alnum(48));
    let legit: Vec<(&str, String, Option<&str>)> = vec![
        (
            "openai sk-proj",
            format!("{}{}", concat!("sk-", "proj-"), body(150)),
            Some("openai"),
        ),
        (
            "openai sk-svcacct",
            format!("{}{}", concat!("sk-", "svcacct-"), body(150)),
            Some("openai"),
        ),
        ("openai legacy sk-", legacy.clone(), None),
        (
            "anthropic sk-ant-api03",
            format!("{}{}", concat!("sk-", "ant-api03-"), body(93)),
            Some("anthropic"),
        ),
        (
            "anthropic sk-ant-usr",
            format!("{}{}", concat!("sk-", "ant-usr01-"), body(90)),
            Some("anthropic"),
        ),
        (
            "anthropic sk-ant-svc",
            format!("{}{}", concat!("sk-", "ant-svc01-"), body(90)),
            Some("anthropic"),
        ),
        (
            "google AIza",
            format!("{}{}", concat!("AI", "za"), body(35)),
            Some("gemini"),
        ),
        ("google AQ.", format!("AQ.{}", body(50)), None),
        (
            "openrouter sk-or-v1",
            format!("{}{}", concat!("sk-", "or-v1-"), rf3_alnum(64)),
            None,
        ),
        ("xai-", format!("xai-{}", rf3_alnum(80)), None),
        ("groq gsk_", format!("gsk_{}", rf3_alnum(52)), None),
        (
            "deepseek-like sk-hex",
            format!("sk-{}", "0123456789abcdef0123456789abcdef"),
            None,
        ),
        ("plain", OTHER_KEY.to_owned(), None),
    ];
    let at_openai = other_at("https://api.openai.com/v1", "gpt-5-mini");
    let at_anthropic = other_at("https://api.anthropic.com/v1", "claude-haiku-5-5");
    let at_google = other_at(
        "https://generativelanguage.googleapis.com/v1beta/openai",
        "gemini-3-flash",
    );
    for (label, key, owner) in &legit {
        // Another AI company somewhere else: a key no company owns goes; one a company owns goes only to that company.
        let elsewhere = shape_verdict(&other(), key);
        match owner {
            None => assert_eq!(elsewhere, Ok(()), "{label}"),
            Some(owner) => assert_eq!(
                elsewhere,
                Err((Verdict::WrongKind, Some(*owner))),
                "{label}"
            ),
        }
        // Another AI company at its own company's address, and that company's card: it goes.
        if let Some(owner) = owner {
            let at = match *owner {
                "openai" => &at_openai,
                "anthropic" => &at_anthropic,
                _ => &at_google,
            };
            assert_eq!(
                shape_verdict(at, key),
                Ok(()),
                "{label} at its company's address"
            );
            assert_eq!(
                shape_verdict(&verified(owner), key),
                Ok(()),
                "{label} on its card"
            );
        }
        // A key no company owns, at any of the three addresses: as it always was, the company answers for it.
        if owner.is_none() {
            for at in [&at_openai, &at_anthropic, &at_google] {
                assert_eq!(shape_verdict(at, key), Ok(()), "{label}");
            }
        }
    }
    // The cards' own answers for keys without an owner, unchanged.
    assert_eq!(shape_verdict(&openai(), &legacy), Ok(()));
    assert_eq!(
        shape_verdict(&gemini(), &format!("AQ.{}", body(50))),
        Ok(())
    );

    // L-2: at Anthropic's address, an `sk-ant-` token that isn't one of its key shapes isn't a key, and isn't sent.
    let not_a_key = format!("{}{}", concat!("sk-", "ant-other-"), body(60));
    assert_eq!(
        shape_verdict(&at_anthropic, &not_a_key),
        Err((Verdict::NotAKey, None))
    );
    assert_eq!(
        shape_verdict(&anthropic(), &not_a_key),
        Err((Verdict::NotAKey, None))
    );

    // L-3a: an administrator's key says whose it is, so the page can name the right company's keys page.
    let openai_admin = format!("{}{}", concat!("sk-", "admin-"), body(60));
    let anthropic_admin = format!("{}{}", concat!("sk-", "ant-admin01-"), body(60));
    for at in [other(), at_openai.clone(), openai()] {
        assert_eq!(
            shape_verdict(&at, &openai_admin),
            Err((Verdict::AdminKey, Some("openai"))),
            "{}",
            at.id()
        );
    }
    for at in [other(), at_anthropic.clone(), anthropic()] {
        assert_eq!(
            shape_verdict(&at, &anthropic_admin),
            Err((Verdict::AdminKey, Some("anthropic"))),
            "{}",
            at.id()
        );
    }
    // L-3b: Anthropic's sign-in tokens are whole tokens, not cut-off keys: said as what they are.
    for token in [
        format!("{}{}", concat!("sk-", "ant-oat01-"), body(80)),
        format!("{}{}", concat!("sk-", "ant-sid01-"), body(80)),
    ] {
        for at in [anthropic(), at_anthropic.clone(), other()] {
            assert_eq!(
                shape_verdict(&at, &token),
                Err((Verdict::SignInToken, None)),
                "{}",
                at.id()
            );
        }
        // Another company's card still says whose it is.
        assert_eq!(
            shape_verdict(&openai(), &token),
            Err((Verdict::WrongKind, Some("anthropic")))
        );
    }
    // The verdict comes back with the company, and nothing is sent.
    let company = Company::default();
    let checked = check_and_save(
        &TempDir::new("admin-whose").0,
        &other(),
        &openai_admin,
        &names(),
        &company,
        &FakeStore::default(),
    )
    .unwrap();
    assert_eq!(
        (checked.verdict, checked.looks_like),
        (Verdict::AdminKey, Some("openai"))
    );
    assert_eq!(company.count(), 0);
    assert_eq!(
        serde_json::to_string(&Verdict::SignInToken).unwrap(),
        r#""sign-in-token""#
    );
}

/// Review L-6 (2026-11-18): the key check sends every company but Anthropic its key as a bearer token, so a check
/// hard-wired to Anthropic's header can't pass for the others.
#[test]
fn review_l6_the_key_check_sends_the_key_as_a_bearer_token_except_to_anthropic() {
    for (choice, key, header) in [
        (openai(), OPENAI_KEY, model::KeyHeader::Bearer),
        (gemini(), GEMINI_KEY, model::KeyHeader::Bearer),
        (other(), OTHER_KEY, model::KeyHeader::Bearer),
        (anthropic(), ANTHROPIC_KEY, model::KeyHeader::XApiKey),
    ] {
        let company = Company::default();
        let said = check_and_save(
            &TempDir::new("key-header").0,
            &choice,
            key,
            &names(),
            &company,
            &FakeStore::default(),
        )
        .unwrap();
        assert_eq!(said.verdict, Verdict::Works, "{}", choice.id());
        assert_eq!(
            *company.key_headers.lock().unwrap(),
            [Some(header)],
            "{}",
            choice.id()
        );
    }
}

/// The variants of a verdict enum in this crate's source, as the page reads them (`kebab-case`).
fn verdict_words(source: &str, start: &str) -> Vec<String> {
    let body = &source[source.find(start).unwrap_or_else(|| panic!("{start}")) + start.len()..];
    let body = &body[..body.find("\n}").unwrap()];
    body.lines()
        .map(str::trim)
        .filter(|line| !line.starts_with("//") && line.ends_with(','))
        .map(|line| {
            let name = line.trim_end_matches(',');
            assert!(name.chars().all(|c| c.is_ascii_alphanumeric()), "{name}");
            let mut word = String::new();
            for (i, c) in name.chars().enumerate() {
                if c.is_ascii_uppercase() && i > 0 {
                    word.push('-');
                }
                word.push(c.to_ascii_lowercase());
            }
            word
        })
        .collect()
}
/// The quoted words of one closed list in the page's source.
fn page_list(source: &str, start: &str, end: &str) -> Vec<String> {
    let from = source.find(start).unwrap_or_else(|| panic!("{start}")) + start.len();
    let list = &source[from..];
    let list = &list[..list.find(end).unwrap_or_else(|| panic!("{end}"))];
    list.split('"')
        .skip(1)
        .step_by(2)
        .map(str::to_owned)
        .collect()
}

/// Review L-6 (2026-11-18): every verdict native can give for a key check or a check on this Mac is in the page's
/// closed list, so none is ever shown as "Ozzie couldn't check" (`unavailable`). Read at run time from the page's
/// own source, which sits beside this crate.
#[test]
fn review_l6_every_verdict_native_gives_is_in_the_pages_closed_lists() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../product/desktop/src/onboarding-bridge.ts");
    let page = std::fs::read_to_string(&path)
        .expect("product/desktop/src/onboarding-bridge.ts, the page's side of these verdicts");
    for (native, list) in [
        (
            verdict_words(include_str!("own_key.rs"), "pub enum Verdict {"),
            page_list(&page, "const KEY_VERDICTS: readonly KeyVerdict[] = [", "];"),
        ),
        (
            verdict_words(include_str!("local_ai.rs"), "pub enum Verdict {"),
            page_list(&page, "const LOCAL_VERDICTS = [", "] as const;"),
        ),
    ] {
        assert!(native.len() >= 9, "{native:?}");
        for word in &native {
            assert!(
                list.contains(word),
                "the page's closed list is missing {word}"
            );
        }
        // And the page names no verdict native doesn't give.
        for word in &list {
            assert!(native.contains(word), "native gives no {word}");
        }
    }
    // The words as serde writes them.
    assert_eq!(
        serde_json::to_string(&Verdict::NotAnAiKey).unwrap(),
        r#""not-an-ai-key""#
    );
    assert_eq!(
        serde_json::to_string(&crate::local_ai::Verdict::ThinksTooLong).unwrap(),
        r#""thinks-too-long""#
    );
}

// ---- "Use the key already on this Mac" (live in the release app, 2026-11-18) ----------------------------------------

#[test]
fn a_key_kept_on_this_mac_is_used_again_natively_and_never_reaches_the_page() {
    let names = names();
    let dir = TempDir::new("kept-key");
    let store = FakeStore::default();
    // OpenAI's key worked earlier and is kept; then No AI for now was chosen.
    check_and_save(&dir.0, &openai(), OPENAI_KEY, &names, &Company::default(), &store).unwrap();
    model::choose_no_ai(&dir.0, &store).unwrap();
    assert!(model::load_config(&dir.0).is_none());
    assert_eq!(saved_companies(&dir.0), ["openai"]);
    // The kept key is read natively onto the desk and checked as a pasted key is: OpenAI is the AI again.
    let desk = KeyDesk::default();
    assert_eq!(desk.hold_kept(&openai(), &store), Ok(true));
    let company = Company::default();
    let said = desk.check(&dir.0, &openai(), &names, &company, &store).unwrap();
    assert_eq!(said.verdict, Verdict::Works);
    assert_eq!(company.sent.lock().unwrap()[0].1.as_deref(), Some(OPENAI_KEY));
    assert!(company.sent.lock().unwrap()[0].0.starts_with("https://api.openai.com/"));
    assert_eq!(model::load_config(&dir.0).unwrap().route, Route::Own);
    let page = serde_json::to_string(&said).unwrap();
    assert!(!page.contains("fictional0canary"), "{page}");
    // It no longer works: the company's own refusal, and the key stays kept for the person to replace or remove.
    model::choose_no_ai(&dir.0, &store).unwrap();
    let desk = KeyDesk::default();
    assert_eq!(desk.hold_kept(&openai(), &store), Ok(true));
    let refused = Company::answering(Ok((401, r#"{"error":{"code":"invalid_api_key"}}"#)));
    assert_eq!(desk.check(&dir.0, &openai(), &names, &refused, &store).unwrap().verdict, Verdict::Refused);
    assert_eq!(store.keys.lock().unwrap().len(), 1);
    assert!(model::load_config(&dir.0).is_none());
    // Chosen something else while it was checked: nothing switches, and the kept key is still kept (it was before).
    let desk = KeyDesk::default();
    desk.hold_kept(&openai(), &store).unwrap();
    let company = Company::default();
    let meanwhile = AnswersAfter { company: &company, meanwhile: || model::route_choice_made(&dir.0) };
    assert_eq!(desk.check(&dir.0, &openai(), &names, &meanwhile, &store).unwrap().verdict, Verdict::ChoiceChanged);
    assert!(model::load_config(&dir.0).is_none());
    assert_eq!(store.keys.lock().unwrap().len(), 1);
    // No key kept for Anthropic: nothing is held, so nothing can be sent.
    let desk = KeyDesk::default();
    assert_eq!(desk.hold_kept(&anthropic(), &store), Ok(false));
    assert!(desk.held().is_none());
    // Another AI company has no such button: refused, nothing read.
    assert_eq!(desk.hold_kept(&other(), &NoKeyReads(&store)), Err(ModelError::InvalidRequest));
    // The page reads this word when the key is gone (removed in Keychain Access, say).
    assert_eq!(serde_json::to_string(&Verdict::NoKeptKey).unwrap(), r#""no-kept-key""#);
}
