//! AI on this Mac over a fake Ollama and LM Studio: each row of the spec's S9 table, the memory table, and the
//! check's verdicts. Fictional models only; nothing here opens a socket.
use super::*;
use std::sync::Mutex;
use std::time::Duration;

/// One recorded answer: a status and body, or a failure.
type Answer = Result<(u16, String), Failure>;
/// The two apps as they answer: each URL's (status, body), or a failure; anything else is unreachable.
#[derive(Default)]
struct Mac {
    answers: Vec<(String, Answer)>,
    posts: Mutex<Vec<(String, Value)>>,
    /// How long each post was allowed to wait, in order.
    waits: Mutex<Vec<Duration>>,
    /// How long each GET was allowed to wait, with its address, in order.
    get_waits: Mutex<Vec<(String, Duration)>>,
    /// How long the first post takes to answer (real time).
    first_post_takes: Duration,
    /// What the person does on another screen while the first question waits for its answer.
    while_first_post: Option<Box<dyn Fn()>>,
    asked: Mutex<Vec<String>>,
}
impl Mac {
    fn with(mut self, url: &str, answer: Result<(u16, &str), Failure>) -> Self {
        self.answers
            .push((url.into(), answer.map(|(s, b)| (s, b.to_string()))));
        self
    }
    fn answer(&self, url: &str) -> Result<(u16, Vec<u8>), Failure> {
        assert!(loopback_only(url), "{url}");
        self.asked.lock().unwrap().push(url.into());
        let position = self.answers.iter().position(|(u, _)| u == url);
        match position {
            Some(at) => self.answers[at].1.clone().map(|(s, b)| (s, b.into_bytes())),
            None => Err(Failure::Unreachable),
        }
    }
}
impl LocalHttp for Mac {
    fn get(&self, url: &str, wait: Duration) -> Result<(u16, Vec<u8>), Failure> {
        assert!(!url.contains('?'), "no query string is ever sent: {url}");
        self.get_waits.lock().unwrap().push((url.into(), wait));
        self.answer(url)
    }
    fn post(&self, url: &str, body: &[u8], wait: Duration) -> Result<(u16, Vec<u8>), Failure> {
        self.waits.lock().unwrap().push(wait);
        self.posts
            .lock()
            .unwrap()
            .push((url.into(), serde_json::from_slice(body).unwrap()));
        let n = self.posts.lock().unwrap().len();
        if n == 1 {
            std::thread::sleep(self.first_post_takes);
            if let Some(meanwhile) = &self.while_first_post {
                meanwhile();
            }
        }
        // Posts are answered in order from entries keyed "POST 1", "POST 2", …
        let key = format!("POST {n}");
        let position = self.answers.iter().position(|(u, _)| *u == key);
        match position {
            Some(at) => self.answers[at].1.clone().map(|(s, b)| (s, b.into_bytes())),
            None => Err(Failure::Unreachable),
        }
    }
    fn delete(&self, url: &str, _: &[u8], _: Duration) -> Result<(u16, Vec<u8>), Failure> {
        panic!("finding and checking never delete: {url}")
    }
}
const GIB: u64 = 1_073_741_824;
fn ollama_running(models: &str) -> Mac {
    Mac::default()
        .with(
            "http://127.0.0.1:11434/api/version",
            Ok((200, r#"{"version":"0.12.0"}"#)),
        )
        .with("http://127.0.0.1:11434/api/tags", Ok((200, models)))
}
const TWO_MODELS: &str = r#"{"models":[{"name":"qwen3:8b","size":5225388164,"digest":"secret-canary"},{"name":"gpt-oss:20b","size":13780173839}]}"#;

#[test]
fn only_the_two_apps_on_this_macs_loopback_are_ever_asked() {
    assert!(loopback_only("http://127.0.0.1:11434/api/tags"));
    assert!(loopback_only("http://127.0.0.1:1234/v1/models"));
    for url in [
        "http://127.0.0.1:11434",
        "http://127.0.0.1:114340/api/tags",
        "http://127.0.0.1:1234@evil.example/v1",
        "http://localhost:11434/api/tags",
        "http://127.0.0.1:8080/api/tags",
        "https://ollama.com/api/tags",
        "http://192.168.1.10:11434/api/tags",
    ] {
        assert!(!loopback_only(url), "{url}");
    }
    let http = NativeLocalHttp::new(FIND_WAIT).unwrap();
    assert_eq!(
        http.get("https://ozzie.church/", FIND_WAIT).err(),
        Some(Failure::Unreachable)
    );
    assert_eq!(
        http.post(
            "http://127.0.0.1:8080/v1/chat/completions",
            b"{}",
            ANSWER_WAIT
        )
        .err(),
        Some(Failure::Unreachable)
    );
    // Finding is GETs only: nothing is posted to find what's there.
    let mac = ollama_running(TWO_MODELS);
    find(&mac, |_| false, 16 * GIB);
    assert!(mac.posts.lock().unwrap().is_empty());
    assert!(
        mac.asked
            .lock()
            .unwrap()
            .iter()
            .all(|url| loopback_only(url))
    );
}

#[test]
fn each_row_of_what_ozzie_can_find_on_this_mac() {
    // Ollama running with models: listed with sizes, the recommended one marked, the too-big one marked.
    let found = find(&ollama_running(TWO_MODELS), |_| false, 16 * GIB);
    let ollama = &found.apps[0];
    assert_eq!(
        (ollama.app, ollama.installed, ollama.running),
        (App::Ollama, true, true)
    );
    assert_eq!(
        ollama.models,
        [
            LocalModelView {
                id: "qwen3:8b".into(),
                size_bytes: Some(5_225_388_164),
                fits: true,
                recommended: true
            },
            LocalModelView {
                id: "gpt-oss:20b".into(),
                size_bytes: Some(13_780_173_839),
                fits: false,
                recommended: false
            },
        ]
    );
    assert!(
        !serde_json::to_string(&found)
            .unwrap()
            .contains("secret-canary")
    );
    // LM Studio's server on: its models, no sizes.
    let mac = Mac::default().with(
        "http://127.0.0.1:1234/v1/models",
        Ok((200, r#"{"data":[{"id":"qwen3-8b","object":"model"}]}"#)),
    );
    let found = find(&mac, |_| false, 32 * GIB);
    assert_eq!(
        (found.apps[1].running, found.apps[1].models.len()),
        (true, 1)
    );
    assert_eq!(found.apps[1].models[0].size_bytes, None);
    assert!(!found.apps[0].running && !found.apps[0].installed);
    // Installed but not open (Ollama), or its server off (LM Studio): installed, not running, nothing listed.
    let found = find(&Mac::default(), |_| true, 16 * GIB);
    for app in &found.apps {
        assert_eq!(
            (app.installed, app.running, app.models.len()),
            (true, false, 0)
        );
    }
    // Running with no models.
    let found = find(&ollama_running(r#"{"models":[]}"#), |_| false, 16 * GIB);
    assert_eq!(
        (found.apps[0].running, found.apps[0].models.len()),
        (true, 0)
    );
    // Nothing at all: never "in use" for something that isn't answering.
    let found = find(&Mac::default(), |_| false, 16 * GIB);
    assert!(
        found
            .apps
            .iter()
            .all(|a| !a.installed && !a.running && a.models.is_empty())
    );
    // An app answering something else is not running; a model id outside the rules isn't listed.
    let mac = ollama_running(r#"{"models":[{"name":"bad name with spaces"},{"name":"llama3.2"}]}"#);
    assert_eq!(find(&mac, |_| false, 16 * GIB).apps[0].models.len(), 1);
    let mac = Mac::default().with("http://127.0.0.1:11434/api/version", Ok((404, "")));
    assert!(!find(&mac, |_| false, 16 * GIB).apps[0].running);
}

#[test]
fn the_macs_memory_decides_the_recommendation() {
    let local = &crate::own_key::catalog().local;
    // The catalogue's three (provider research, 2026-11-17), as offered and tested on 2026-11-18: qwen3:4b never finished a
    // lookup question in Ozzie's check (0 of 18, at 200 to 1,500 tokens, thinking off and on), so it isn't offered;
    // gpt-oss:20b couldn't be run on the 16 GB test Mac, so it is offered where it fits but not recommended.
    assert_eq!(
        [&local.small, &local.medium, &local.large].map(|m| (m.id.as_str(), m.offered, m.tested)),
        [("qwen3:4b", false, true), ("qwen3:8b", true, true), ("gpt-oss:20b", true, false)]
    );
    // 8 GB: only the small model fits, and it isn't offered: AI on this Mac needs 16 GB or more, and nothing is
    // recommended, so no download that would fail is ever suggested. From 16 GB the medium one; from 32 GB the large one
    // fits too but the tested medium one stays the recommendation.
    for (gb, advice_word, model) in [
        (4, "too-small", None),
        (8, "too-small", None),
        (16, "medium", Some(&local.medium)),
        (24, "medium", Some(&local.medium)),
        (32, "large", Some(&local.medium)),
        (64, "large", Some(&local.medium)),
    ] {
        let found = find(&Mac::default(), |_| false, gb * GIB);
        assert_eq!(
            (found.memory_gb.unwrap(), found.advice, found.recommended.as_deref()),
            (gb, advice_word, model.map(|m| m.id.as_str())),
            "{gb}"
        );
        assert_eq!(found.recommended_size_bytes, model.map(|m| m.size_bytes), "{gb}");
        // Each catalogue row says whether Ozzie offers it; only the recommended one is marked.
        let rows: Vec<(bool, bool)> = found.catalogue.iter().map(|r| (r.offered, r.recommended)).collect();
        assert_eq!(rows.iter().map(|r| r.0).collect::<Vec<_>>(), [false, true, true]);
        assert_eq!(rows.iter().filter(|r| r.1).count(), usize::from(model.is_some()), "{gb}");
    }
    // A model the person brought is never "recommended" on a Mac too small for what Ozzie offers.
    let mac = ollama_running(r#"{"models":[{"name":"qwen3:4b","size":2500000000}]}"#);
    let found = find(&mac, |_| true, 8 * GIB);
    assert!(found.apps[0].models.iter().all(|m| !m.recommended));
    // And downloading it through Ozzie is refused, whatever the Mac.
    let found = crate::local_models::find(&Dir::new("offer").0, &ollama_running(TWO_MODELS), |_| true, 64 * GIB, Some(100_000_000_000));
    assert_eq!(crate::local_models::may_start(&found, "qwen3:4b"), Err(crate::local_models::Refusal::NotOffered));
    assert_eq!(crate::local_models::may_start(&found, "gpt-oss:20b"), Ok(()));
}

struct Dir(std::path::PathBuf);
impl Dir {
    fn new(label: &str) -> Self {
        // A counter too: tests running in parallel within the same millisecond must not share (and delete) one folder.
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "ozzie-local-ai-{label}-{}-{}-{}",
            std::process::id(),
            crate::sunday_check::unix_ms(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
}
impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
const CALLED: &str = r#"{"choices":[{"message":{"role":"assistant","content":"","tool_calls":[{"id":"c1","type":"function","function":{"name":"sunday_open_needs","arguments":"{}"}}]}}]}"#;
const PROSE: &str =
    r#"{"choices":[{"message":{"role":"assistant","content":"Greeter needs one more."}}]}"#;
fn said(word: &str) -> String {
    format!(r#"{{"choices":[{{"message":{{"role":"assistant","content":"{word}"}}}}]}}"#)
}
fn run(mac: &Mac, model: &str) -> (Verdict, Option<u64>, Option<model::RouteConfig>) {
    run_at(App::Ollama, mac, model)
}
fn run_at(app: App, mac: &Mac, model: &str) -> (Verdict, Option<u64>, Option<model::RouteConfig>) {
    let dir = Dir::new("check");
    let ticks = std::cell::Cell::new(0u64);
    let clock = || {
        ticks.set(ticks.get() + 14_000);
        1_763_400_000_000 + ticks.get()
    };
    let checked = check(&dir.0, app, model, &NameGuard::default(), mac, &clock).unwrap();
    (checked.verdict, checked.seconds, model::load_config(&dir.0))
}
/// An Ask step as the page sends it, with one lookup offered.
fn ask_step() -> crate::agent::AgentStepRequest {
    let request = crate::agent::parse_request(serde_json::json!({
        "task_id": "ask-think", "max_tokens": 700,
        "tools": [{"name": "sunday.open_needs", "description": "Lists the roles that still need people.",
            "parameters": {"type": "object", "properties": {}, "required": [], "additionalProperties": false}}],
        "messages": [{"role": "system", "content": "Answer from the facts."}, {"role": "user", "content": "Is [Role] covered?"}],
    }));
    let Ok(request) = request else {
        panic!("a request in the contract's shape")
    };
    request
}
fn local_at(app: App, model: &str) -> model::RouteConfig {
    model::RouteConfig::new(model::Route::Local, Some(&app.base()), Some(model)).unwrap()
}
/// What Ollama's `/api/ps` says about the one model it has loaded.
fn loaded(name: &str, room: u64) -> String {
    format!(
        r#"{{"models":[{{"name":"{name}","model":"{name}","size_vram":5684246609,"context_length":{room}}}]}}"#
    )
}

#[test]
fn check_that_it_answers_gives_each_verdict_and_saves_only_an_answer() {
    let answers = said("HARBOR");
    // It answers, uses the lookup and still sees the start: saved, checked, and how long it took.
    let mac = ollama_running(TWO_MODELS)
        .with("POST 1", Ok((200, CALLED)))
        .with("POST 2", Ok((200, &answers)));
    let (verdict, seconds, saved) = run(&mac, "qwen3:8b");
    assert_eq!((verdict, seconds), (Verdict::Answers, Some(14)));
    let saved = saved.unwrap();
    // The two listing GETs wait as finding does; once the word came back, the room is asked about with its own short
    // wait (B-2: here the app doesn't say, so nothing more is said).
    let gets = mac.get_waits.lock().unwrap().clone();
    assert_eq!(
        gets[..2],
        [
            ("http://127.0.0.1:11434/api/version".to_string(), FIND_WAIT),
            ("http://127.0.0.1:11434/api/tags".to_string(), FIND_WAIT),
        ]
    );
    assert_eq!(gets.len(), 3);
    assert_eq!(gets[2].0, "http://127.0.0.1:11434/api/ps");
    assert!(gets[2].1 <= ROOM_WAIT);
    assert_eq!(
        (saved.route, saved.base_url.as_str(), saved.model.as_str()),
        (model::Route::Local, "http://127.0.0.1:11434/v1", "qwen3:8b")
    );
    assert!(saved.checked_at_ms.is_some());
    let posts = mac.posts.lock().unwrap();
    assert_eq!(posts.len(), 2);
    assert!(
        posts
            .iter()
            .all(|(url, _)| url == "http://127.0.0.1:11434/v1/chat/completions")
    );
    // Ollama's OpenAI-style endpoint takes max_tokens and no tool_choice (its own documentation).
    for (_, body) in posts.iter() {
        assert!(body.get("tool_choice").is_none() && body.get("max_completion_tokens").is_none());
    }
    // The question that needs the lookup: the room a real Ask step has, so the check fails a model only for what would
    // fail it in use: qwen3:8b with thinking on needed 138 to 227 tokens for the lookup and was cut off once in three at
    // the old 200 (2026-11-18).
    assert_eq!(posts[0].1["max_tokens"], 700);
    assert_eq!(CHECK_TOKENS, crate::agent::MAX_TOKENS);
    // The second asks for one word (qwen3:8b used 4 tokens thinking off, 90 thinking on): its room fits that with
    // margin and, at 12 tokens a second, ends well inside its minute, so a model that thinks aloud on a slower Mac is
    // cut off and called thinks-too-long rather than too slow (review L-6).
    assert_eq!(posts[1].1["max_tokens"], 400);
    assert_eq!(WORD_TOKENS, 400);
    assert!(u64::from(WORD_TOKENS) / 12 < START_WAIT.as_secs() * 3 / 5);
    assert!(u64::from(CHECK_TOKENS) / 12 > START_WAIT.as_secs() * 9 / 10);
    // The long question starts with the check word, and carries only fictional stand-ins.
    let question = posts[1].1["messages"][1]["content"].as_str().unwrap();
    assert!(question.starts_with("Check word: HARBOR."));
    assert!(question.len() > 10_000);
    assert_eq!(
        posts[0].1["tools"][0]["function"]["name"],
        "sunday_open_needs"
    );
    drop(posts);
    // It answers in prose instead of using the lookup, or Ollama says the model has no tools.
    for answer in [
        Ok((200, PROSE)),
        Ok((400, r#"{"error":"llama2 does not support tools"}"#)),
    ] {
        let mac = ollama_running(TWO_MODELS).with("POST 1", answer);
        let (verdict, _, saved) = run(&mac, "qwen3:8b");
        assert_eq!(verdict, Verdict::NoTools);
        assert!(saved.is_none());
    }
    // It lost the start of the long question though Ollama gave it room for all of it.
    let mac = ollama_running(TWO_MODELS)
        .with("POST 1", Ok((200, CALLED)))
        .with("POST 2", Ok((200, &said("Greeter"))))
        .with(
            "http://127.0.0.1:11434/api/ps",
            Ok((200, &loaded("qwen3:8b", 8192))),
        );
    assert_eq!(run(&mac, "qwen3:8b").0, Verdict::LostStart);
    // No answer within the wait; Ollama stopped answering.
    let mac = ollama_running(TWO_MODELS).with("POST 1", Err(Failure::Timeout));
    assert_eq!(run(&mac, "qwen3:8b").0, Verdict::TooSlow);
    let mac = ollama_running(TWO_MODELS).with("POST 1", Err(Failure::Unreachable));
    assert_eq!(run(&mac, "qwen3:8b").0, Verdict::Stopped);
    // Ollama isn't open at all, or the model isn't one it lists: nothing is sent.
    let mac = Mac::default();
    assert_eq!(run(&mac, "qwen3:8b").0, Verdict::Stopped);
    let mac = ollama_running(TWO_MODELS);
    assert_eq!(run(&mac, "mistral:7b").0, Verdict::NotFound);
    assert!(mac.posts.lock().unwrap().is_empty());
    // A model id holding a name this session has shown is refused before anything is asked.
    let mut names = NameGuard::default();
    names.remember(["Riley Thornbury".to_string()].iter());
    let dir = Dir::new("named");
    let mac = ollama_running(r#"{"models":[{"name":"riley-thornbury:7b"}]}"#);
    assert_eq!(
        check(
            &dir.0,
            App::Ollama,
            "riley-thornbury:7b",
            &names,
            &mac,
            &|| 0
        )
        .err(),
        Some(ModelError::NamePresent)
    );
    assert!(mac.asked.lock().unwrap().is_empty());
    // The page reads these words.
    assert_eq!(
        serde_json::to_string(&Verdict::LostStart).unwrap(),
        r#""lost-start""#
    );
    assert_eq!(
        serde_json::to_string(&App::LmStudio).unwrap(),
        r#""lm-studio""#
    );
    assert_eq!(
        (
            App::parse("ollama"),
            App::parse("lm-studio"),
            App::parse("Ollama")
        ),
        (Some(App::Ollama), Some(App::LmStudio), None)
    );
}

#[test]
fn each_app_says_how_it_is_started_and_lm_studios_server_is_started_by_hand() {
    let found = find(&Mac::default(), |_| true, 16 * GIB);
    assert!(found.apps[0].start_hint.contains("Open Ollama"));
    assert!(
        found.apps[1].start_hint.contains("Start server"),
        "{}",
        found.apps[1].start_hint
    );
}

#[test]
fn an_agent_step_to_a_model_on_this_mac_sends_no_tool_choice() {
    let request = crate::agent::parse_request(serde_json::json!({
        "task_id": "ask-1", "max_tokens": 600, "tools": [],
        "messages": [{"role": "system", "content": "Answer from the facts."}, {"role": "user", "content": "Is [Role] covered?"}],
    }));
    let Ok(request) = request else {
        panic!("a request in the contract's shape")
    };
    let local = model::RouteConfig::new(model::Route::Local, None, None).unwrap();
    let step = crate::agent::step_body(&local, &request);
    assert!(step.get("tool_choice").is_none());
    assert_eq!(step["max_tokens"], 600);
    // With tools too: tool_choice is sent only off this Mac.
    let agent = include_str!("agent.rs");
    assert!(agent.contains(
        "if config.route != model::Route::Local {\n            body[\"tool_choice\"] = json!(\"auto\");"
    ));
}

#[test]
fn review_l12_m7_unknown_memory_is_never_zero_and_the_check_ends_within_three_minutes() {
    let found = find(&Mac::default(), |_| false, 0);
    assert_eq!((found.memory_gb, found.advice), (None, "unknown"));
    // Unknown memory: nothing is recommended (the rows are still offered: unknown memory isn't judged).
    assert_eq!((found.recommended.as_deref(), found.recommended_size_bytes), (None, None));
    assert!(
        !serde_json::to_string(&found)
            .unwrap()
            .contains("\"memory_gb\":0")
    );
    // The page's "This can take up to three minutes". A refused thinking setting comes back at once, before the model
    // runs, so asking again without it adds no real wait.
    assert_eq!(ANSWER_WAIT + START_WAIT, Duration::from_secs(180));
    // One client, one redirect policy, and it follows none.
    let code = include_str!("local_ai.rs")
        .split("#[cfg(test)]")
        .next()
        .unwrap();
    assert_eq!(code.matches(".redirect(").count(), 1);
    assert!(code.contains(".redirect(reqwest::redirect::Policy::none())"));
    let model = include_str!("model.rs")
        .split("#[cfg(test)]")
        .next()
        .unwrap();
    assert_eq!(model.matches(".redirect(").count(), 1);
    assert!(model.contains(".redirect(reqwest::redirect::Policy::none())"));
}

#[test]
fn review_l8_a_model_on_this_mac_is_used_only_at_its_two_addresses_and_only_once_checked() {
    let dir = Dir::new("usable");
    model::save_config(&dir.0, model::Route::Local, None, None).unwrap();
    assert!(
        model::usable_config(&dir.0).is_none(),
        "chosen, not checked: nothing is sent"
    );
    model::save_local_checked(
        &dir.0,
        &App::LmStudio.base(),
        "qwen3-8b",
        1,
        model::route_generation(&dir.0),
    )
    .unwrap();
    assert!(model::usable_config(&dir.0).is_some());
    model::save_local_checked(
        &dir.0,
        "http://127.0.0.1:8080/v1",
        "qwen3-8b",
        1,
        model::route_generation(&dir.0),
    )
    .unwrap();
    assert!(
        model::usable_config(&dir.0).is_none(),
        "another port on this Mac isn't one of the two apps"
    );
    assert!(
        model::local_base_allowed("http://127.0.0.1:11434/v1")
            && model::local_base_allowed("http://127.0.0.1:1234/v1")
    );
    for base in [
        "http://localhost:11434/v1",
        "http://127.0.0.1:11434",
        "https://127.0.0.1:1234/v1",
        "http://127.0.0.1:1234/v1/",
    ] {
        assert!(!model::local_base_allowed(base), "{base}");
    }
    model::save_config(
        &dir.0,
        model::Route::Own,
        Some("https://api.example.invalid/v1"),
        Some("m"),
    )
    .unwrap();
    assert!(
        model::usable_config(&dir.0).is_some(),
        "other routes are as they were"
    );
}

// ---- Live test with Ollama 0.40.16 and qwen3:8b, 2026-11-18: thinking, context length, waits ---------------------

/// For a live check by hand: prints the exact two bodies the check sends Ollama for `OZZIE_LIVE_MODEL` (default
/// qwen3:8b), one JSON line each after a marker, to send with curl. Fictional text only; nothing is sent here.
/// `cargo test --lib live_check_bodies -- --ignored --nocapture`
#[test]
#[ignore = "prints the check's bodies for a live check by hand"]
fn live_check_bodies() {
    let model = std::env::var("OZZIE_LIVE_MODEL").unwrap_or_else(|_| "qwen3:8b".into());
    let (lookup, start) = check_bodies(App::Ollama, &model);
    println!("LOOKUP {}", serde_json::to_string(&lookup).unwrap());
    println!("START {}", serde_json::to_string(&start).unwrap());
}

#[test]
fn every_request_to_a_model_on_this_mac_asks_it_not_to_think_first() {
    // providers.json's rule for this Mac (Ollama's docs: "none" requests no thinking; GPT-OSS, which can't stop
    // thinking, uses its lowest level). qwen3:8b spent all 200 of the check's tokens thinking without it.
    assert_eq!(
        crate::own_key::catalog().local.reasoning_effort.as_deref(),
        Some("none")
    );
    for app in [App::Ollama, App::LmStudio] {
        let (lookup, start) = check_bodies(app, "qwen3:8b");
        assert_eq!(lookup["reasoning_effort"], "none");
        assert_eq!(start["reasoning_effort"], "none");
        // Rewording and every Ask step on the local route, at either app.
        let local = local_at(app, "qwen3:8b");
        let reword = model::request_body(
            &local,
            &model::DraftRequest {
                system: "Word it kindly.".into(),
                user: "Note: [Volunteer A], can you serve?".into(),
                max_tokens: 100,
            },
        )
        .unwrap();
        assert_eq!(reword["reasoning_effort"], "none");
        let step = crate::agent::step_body(&local, &ask_step());
        assert_eq!(step["reasoning_effort"], "none");
        assert!(step.get("tool_choice").is_none());
    }
    // The check sends it too.
    let mac = ollama_running(TWO_MODELS)
        .with("POST 1", Ok((200, CALLED)))
        .with("POST 2", Ok((200, &said("HARBOR"))));
    assert_eq!(run(&mac, "qwen3:8b").0, Verdict::Answers);
    for (_, body) in mac.posts.lock().unwrap().iter() {
        assert_eq!(body["reasoning_effort"], "none");
    }
    // The managed route keeps its own setting and never this one.
    let managed = crate::agent::step_body(&model::RouteConfig::managed(), &ask_step());
    assert!(managed.get("reasoning_effort").is_none());
}

#[test]
fn the_second_question_repeats_the_first_up_to_its_last_line_so_the_app_reuses_what_it_read() {
    // Measured: without the lookup offered, the second question re-read all ~3,800 tokens (27 s); with it, the app
    // reused 3,893 of 3,926 tokens and answered in 0.9 s.
    let (lookup, start) = check_bodies(App::Ollama, "qwen3:8b");
    assert_eq!(lookup["tools"], start["tools"]);
    assert_eq!(lookup["messages"][0], start["messages"][0]);
    let first = lookup["messages"][1]["content"].as_str().unwrap();
    let second = start["messages"][1]["content"].as_str().unwrap();
    let shared = first
        .bytes()
        .zip(second.bytes())
        .take_while(|(a, b)| a == b)
        .count();
    assert!(shared > 10_000, "{shared}");
    assert!(first.len() - shared < 200 && second.len() - shared < 200);
    // The lookup stays offered (the app's reuse depends on it), so the question says not to use it (review M2).
    assert!(second.ends_with("Do not use a tool; reply with the word only."));
    // Room to think briefly before one word, for a model that can't stop thinking, and an end well inside the second
    // question's minute on a slower Mac (review L-6); the first question keeps a real Ask step's room.
    assert_eq!(start["max_tokens"], WORD_TOKENS);
    assert_eq!(lookup["max_tokens"], CHECK_TOKENS);
    assert!(WORD_TOKENS >= 4 * 90);
}

#[test]
fn the_first_question_waits_two_minutes_and_the_second_one_minute() {
    let mac = ollama_running(TWO_MODELS)
        .with("POST 1", Ok((200, CALLED)))
        .with("POST 2", Ok((200, &said("HARBOR"))));
    assert_eq!(run(&mac, "qwen3:8b").0, Verdict::Answers);
    // The first question's two minutes count from when the check began (finding the model included), so "It didn't
    // answer within two minutes" is true from the moment the person pressed the button.
    let waits = mac.waits.lock().unwrap().clone();
    assert_eq!(waits.len(), 2);
    assert!(
        waits[0] <= ANSWER_WAIT && waits[0] > ANSWER_WAIT - Duration::from_secs(1),
        "{waits:?}"
    );
    assert_eq!(waits[1], START_WAIT);
    assert_eq!((ANSWER_WAIT.as_secs(), START_WAIT.as_secs()), (120, 60));
    // A model on this Mac gets the first question's wait in normal use too: an Ask's first step reads a new
    // question (measured up to 47 s for ~3,800 tokens). Other routes keep 45 seconds.
    assert_eq!(model::request_wait(model::Route::Local), ANSWER_WAIT);
    for route in [model::Route::Own, model::Route::Managed] {
        assert_eq!(model::request_wait(route), Duration::from_secs(45));
    }
}

#[test]
fn an_app_that_refuses_the_thinking_setting_is_asked_again_without_it_and_remembered() {
    // Ollama 0.11.5 to 0.12.3 refused "none" in these words (its source at v0.12.3); later versions say "invalid
    // reasoning value". The model id is this test's own: the memory lasts the session.
    let models = r#"{"models":[{"name":"older-think:8b"},{"name":"qwen3:8b"}]}"#;
    let refused = r#"{"error":{"message":"think value \"none\" is not supported for this model","type":"invalid_request_error"}}"#;
    let mac = ollama_running(models)
        .with("POST 1", Ok((400, refused)))
        .with("POST 2", Ok((200, CALLED)))
        .with("POST 3", Ok((200, &said("HARBOR"))));
    assert_eq!(run(&mac, "older-think:8b").0, Verdict::Answers);
    let posts = mac.posts.lock().unwrap();
    assert_eq!(posts.len(), 3);
    assert_eq!(posts[0].1["reasoning_effort"], "none");
    assert_eq!(posts[0].1["messages"], posts[1].1["messages"]);
    assert!(
        posts[1..]
            .iter()
            .all(|(_, body)| body.get("reasoning_effort").is_none())
    );
    drop(posts);
    // The retry shares the question's wait: it gets what is left of it, never a wait of its own.
    let waits = mac.waits.lock().unwrap().clone();
    assert!(waits[1] <= waits[0] && waits[0] <= ANSWER_WAIT, "{waits:?}");
    assert_eq!(waits[2], START_WAIT);
    // Remembered for that model at that app: rewording and Ask send it no more; another model, or the same name at
    // the other app, still gets it.
    let step = |app, model| crate::agent::step_body(&local_at(app, model), &ask_step());
    assert!(
        step(App::Ollama, "older-think:8b")
            .get("reasoning_effort")
            .is_none()
    );
    assert_eq!(step(App::Ollama, "qwen3:8b")["reasoning_effort"], "none");
    assert_eq!(
        step(App::LmStudio, "older-think:8b")["reasoning_effort"],
        "none"
    );
    // A refusal of something else is not retried: Ollama's "does not support tools" stays no-tools.
    let mac = ollama_running(TWO_MODELS).with(
        "POST 1",
        Ok((
            400,
            r#"{"error":"registry.ollama.ai/library/qwen3:8b does not support tools"}"#,
        )),
    );
    assert_eq!(run(&mac, "qwen3:8b").0, Verdict::NoTools);
    assert_eq!(mac.posts.lock().unwrap().len(), 1);
}

#[test]
fn an_answer_spent_thinking_is_not_called_unable_to_use_lookups() {
    // What qwen3:8b sent back live with thinking on: no words, the thinking apart, cut off at the token limit.
    let thought = r#"{"choices":[{"index":0,"message":{"role":"assistant","content":"","reasoning":"Okay, the user wants to know which roles still need people. Let me"},"finish_reason":"length"}],"usage":{"prompt_tokens":3923,"completion_tokens":200}}"#;
    // An app that leaves the thinking in the words.
    let inline = r#"{"choices":[{"message":{"role":"assistant","content":"<think>\nOkay, the user wants"},"finish_reason":"length"}]}"#;
    for reply in [thought, inline] {
        let mac = ollama_running(TWO_MODELS).with("POST 1", Ok((200, reply)));
        let (verdict, seconds, saved) = run(&mac, "qwen3:8b");
        assert_eq!((verdict, seconds), (Verdict::ThinksTooLong, Some(14)));
        assert!(saved.is_none());
        // The second question cut off the same way is not a lost start either.
        let mac = ollama_running(TWO_MODELS)
            .with("POST 1", Ok((200, CALLED)))
            .with("POST 2", Ok((200, reply)));
        assert_eq!(run(&mac, "qwen3:8b").0, Verdict::ThinksTooLong);
    }
    // What qwen3:4b sent back live with thinking off (2026-11-18): its thinking aloud in its words, cut off at the limit.
    // A cut-off proves nothing about the lookups, whatever the words: it never finished (owner's live test, the Small
    // model said "can't use Ozzie's lookups" twice, untrue).
    let aloud = r#"{"choices":[{"message":{"role":"assistant","content":"Okay, the user is asking which roles still need people. Let me look at the facts. Fact 1 says"},"finish_reason":"length"}],"usage":{"prompt_tokens":3912,"completion_tokens":200}}"#;
    let prose = r#"{"choices":[{"message":{"role":"assistant","content":"The roles that still need people are"},"finish_reason":"length"}]}"#;
    for reply in [aloud, prose] {
        let mac = ollama_running(TWO_MODELS).with("POST 1", Ok((200, reply)));
        assert_eq!(run(&mac, "qwen3:8b").0, Verdict::ThinksTooLong);
    }
    // Finished in words without the lookup it was asked to use: it ignored the tools.
    let finished = r#"{"choices":[{"message":{"role":"assistant","content":"The roles that still need people are Role 1 and Role 2."},"finish_reason":"stop"}]}"#;
    let mac = ollama_running(TWO_MODELS).with("POST 1", Ok((200, finished)));
    assert_eq!(run(&mac, "qwen3:8b").0, Verdict::NoTools);
    assert_eq!(
        serde_json::to_string(&Verdict::ThinksTooLong).unwrap(),
        r#""thinks-too-long""#
    );
}

#[test]
fn a_lost_start_names_the_apps_context_length_unless_the_app_gave_the_model_room() {
    let missed = said("Greeter");
    // Ollama's `/api/ps` says how much room it gave the loaded model: 4,096 tokens is its default under 24 GB of
    // graphics memory, and the check's question (~3,900 tokens) didn't fit. Unknown room counts as too little.
    for (room, expected) in [
        (Some(4096), Verdict::SmallContext),
        (Some(8191), Verdict::SmallContext),
        (Some(8192), Verdict::LostStart),
        (Some(40960), Verdict::LostStart),
        (None, Verdict::SmallContext),
    ] {
        let mut mac = ollama_running(TWO_MODELS)
            .with("POST 1", Ok((200, CALLED)))
            .with("POST 2", Ok((200, &missed)));
        if let Some(room) = room {
            let ps = loaded("qwen3:8b", room);
            mac = mac.with("http://127.0.0.1:11434/api/ps", Ok((200, &ps)));
        }
        let (verdict, seconds, saved) = run(&mac, "qwen3:8b");
        assert_eq!((verdict, seconds), (expected, Some(14)), "{room:?}");
        assert!(saved.is_none());
    }
    // Ollama names a model's default tag `latest`; another loaded model's room says nothing about this one.
    let ps = loaded("llama3.2:latest", 8192);
    let mac = ollama_running(r#"{"models":[{"name":"llama3.2"}]}"#)
        .with("POST 1", Ok((200, CALLED)))
        .with("POST 2", Ok((200, &missed)))
        .with("http://127.0.0.1:11434/api/ps", Ok((200, &ps)));
    assert_eq!(run(&mac, "llama3.2").0, Verdict::LostStart);
    let mac = ollama_running(TWO_MODELS)
        .with("POST 1", Ok((200, CALLED)))
        .with("POST 2", Ok((200, &missed)))
        .with("http://127.0.0.1:11434/api/ps", Ok((200, &ps)));
    assert_eq!(run(&mac, "qwen3:8b").0, Verdict::SmallContext);
    // LM Studio says it per loaded copy of a model (`/api/v1/models`).
    let lm = |room: u64| {
        format!(
            r#"{{"models":[{{"type":"llm","key":"qwen/qwen3-8b","loaded_instances":[{{"id":"qwen/qwen3-8b","config":{{"context_length":{room}}}}}],"max_context_length":40960}}]}}"#
        )
    };
    for (room, expected) in [(4096, Verdict::SmallContext), (16384, Verdict::LostStart)] {
        let models = lm(room);
        let mac = Mac::default()
            .with(
                "http://127.0.0.1:1234/v1/models",
                Ok((200, r#"{"data":[{"id":"qwen/qwen3-8b","object":"model"}]}"#)),
            )
            .with("POST 1", Ok((200, CALLED)))
            .with("POST 2", Ok((200, &missed)))
            .with("http://127.0.0.1:1234/api/v1/models", Ok((200, &models)));
        assert_eq!(
            run_at(App::LmStudio, &mac, "qwen/qwen3-8b").0,
            expected,
            "{room}"
        );
    }
    // An app that refuses a question longer than the model's room says so (LM Studio's reported words): that is
    // the room, on either question, not "can't use lookups" and not "stopped".
    let refused = r#"{"error":"Trying to keep the first 4121 tokens when context the overflows. However, the model is loaded with context length of only 4096 tokens, which is not enough. Try to load the model with a larger context length, or provide a shorter input"}"#;
    for status in [400, 500] {
        let mac = ollama_running(TWO_MODELS).with("POST 1", Ok((status, refused)));
        assert_eq!(run(&mac, "qwen3:8b").0, Verdict::SmallContext);
        let mac = ollama_running(TWO_MODELS)
            .with("POST 1", Ok((200, CALLED)))
            .with("POST 2", Ok((status, refused)));
        assert_eq!(run(&mac, "qwen3:8b").0, Verdict::SmallContext);
    }
    assert_eq!(CONTEXT_NEEDED, 8192);
    assert_eq!(
        serde_json::to_string(&Verdict::SmallContext).unwrap(),
        r#""small-context""#
    );
}

// ---- Review of 2026-11-18: the second answer a lookup (M2), the thinking refusal's words (L1), every wait (L4) ------

#[test]
fn review_m2_a_lookup_instead_of_the_check_word_is_said_as_that_not_as_room() {
    // The second question offers the lookup (so the app reuses what it read) and qwen3 may call it instead of
    // answering: that says nothing about the room, so the room isn't asked about, and nothing is saved.
    let mac = ollama_running(TWO_MODELS)
        .with("POST 1", Ok((200, CALLED)))
        .with("POST 2", Ok((200, CALLED)))
        .with(
            "http://127.0.0.1:11434/api/ps",
            Ok((200, &loaded("qwen3:8b", 4096))),
        );
    let (verdict, seconds, saved) = run(&mac, "qwen3:8b");
    assert_eq!((verdict, seconds), (Verdict::LookupInstead, Some(14)));
    assert!(saved.is_none());
    assert!(
        !mac.asked
            .lock()
            .unwrap()
            .iter()
            .any(|url| url.ends_with("/api/ps"))
    );
    // Words beside the lookup that still miss the word: the same.
    let both = r#"{"choices":[{"message":{"role":"assistant","content":"Let me look.","tool_calls":[{"id":"c2","type":"function","function":{"name":"sunday_open_needs","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}"#;
    let mac = ollama_running(TWO_MODELS)
        .with("POST 1", Ok((200, CALLED)))
        .with("POST 2", Ok((200, both)));
    assert_eq!(run(&mac, "qwen3:8b").0, Verdict::LookupInstead);
    // The word with a lookup beside it still answers.
    let worded = r#"{"choices":[{"message":{"role":"assistant","content":"HARBOR","tool_calls":[{"id":"c2","type":"function","function":{"name":"sunday_open_needs","arguments":"{}"}}]}}]}"#;
    let mac = ollama_running(TWO_MODELS)
        .with("POST 1", Ok((200, CALLED)))
        .with("POST 2", Ok((200, worded)));
    assert_eq!(run(&mac, "qwen3:8b").0, Verdict::Answers);
    assert_eq!(
        serde_json::to_string(&Verdict::LookupInstead).unwrap(),
        r#""lookup-instead""#
    );
}

#[test]
fn review_l1_only_the_apps_own_refusal_of_the_setting_is_asked_again_never_a_models_name() {
    for (status, body, refused) in [
        // Ollama 0.11.5 to 0.12.3 (server/routes.go at v0.12.3), and its unknown-value refusal (openai/openai.go).
        (
            400,
            r#"{"error":{"message":"think value \"none\" is not supported for this model","type":"invalid_request_error"}}"#,
            true,
        ),
        (
            400,
            r#"{"error":{"message":"invalid reasoning value: 'none' (must be \"high\", \"medium\", \"low\", or \"none\")"}}"#,
            true,
        ),
        // An app naming the setting it refuses.
        (
            400,
            r#"{"error":"Unrecognized request argument supplied: reasoning_effort"}"#,
            true,
        ),
        (
            400,
            r#"{"error":"This model does not support reasoning effort"}"#,
            true,
        ),
        // A model whose own name holds "reasoning" or "think", refused for something else.
        (
            400,
            r#"{"error":"registry.ollama.ai/library/phi4-reasoning:latest does not support tools"}"#,
            false,
        ),
        (
            400,
            r#"{"error":"\"deepseek-r1-think:8b\" does not support tools"}"#,
            false,
        ),
        (
            400,
            r#"{"error":"model 'qwen3-thinking-2507' not found"}"#,
            false,
        ),
        (
            404,
            r#"{"error":"model \"phi4-reasoning\" not found, try pulling it first"}"#,
            false,
        ),
        // Not a refusal of the request at all.
        (
            500,
            r#"{"error":"think value \"none\" is not supported for this model"}"#,
            false,
        ),
    ] {
        assert_eq!(
            refused_thinking_setting(status, body.as_bytes()),
            refused,
            "{status} {body}"
        );
    }
    // In the check: a model named for reasoning, refused for having no tools, is asked once and never remembered as
    // refusing the setting.
    let models = r#"{"models":[{"name":"phi4-reasoning:14b"}]}"#;
    let mac = ollama_running(models).with(
        "POST 1",
        Ok((
            400,
            r#"{"error":"registry.ollama.ai/library/phi4-reasoning:14b does not support tools"}"#,
        )),
    );
    assert_eq!(run(&mac, "phi4-reasoning:14b").0, Verdict::NoTools);
    assert_eq!(mac.posts.lock().unwrap().len(), 1);
    assert_eq!(
        crate::agent::step_body(&local_at(App::Ollama, "phi4-reasoning:14b"), &ask_step())["reasoning_effort"],
        "none"
    );
}

#[test]
fn review_l4_every_get_waits_briefly_and_the_whole_check_stays_within_three_minutes() {
    // The room is asked about with a short wait of its own: the model just answered, so the app is up.
    let mac = ollama_running(TWO_MODELS)
        .with("POST 1", Ok((200, CALLED)))
        .with("POST 2", Ok((200, &said("Greeter"))))
        .with(
            "http://127.0.0.1:11434/api/ps",
            Ok((200, &loaded("qwen3:8b", 4096))),
        );
    assert_eq!(run(&mac, "qwen3:8b").0, Verdict::SmallContext);
    let gets = mac.get_waits.lock().unwrap().clone();
    assert_eq!(gets.len(), 3);
    assert!(
        gets[..2].iter().all(|(_, wait)| *wait == FIND_WAIT),
        "{gets:?}"
    );
    assert_eq!(gets[2].0, "http://127.0.0.1:11434/api/ps");
    assert!(gets[2].1 <= ROOM_WAIT, "{gets:?}");
    assert!(FIND_WAIT <= Duration::from_secs(1) && ROOM_WAIT <= Duration::from_secs(5));
    // Finding waits the same.
    let mac = ollama_running(TWO_MODELS);
    find(&mac, |_| false, 16 * GIB);
    assert!(
        mac.get_waits
            .lock()
            .unwrap()
            .iter()
            .all(|(_, wait)| *wait == FIND_WAIT)
    );
    // The room's GET gets only what is left of the three minutes, and none once they are spent: the room then
    // counts as unknown (`small-context`, whose sentence covers an app that doesn't say).
    assert_eq!(CHECK_WAIT, ANSWER_WAIT + START_WAIT);
    assert_eq!(room_wait(Duration::ZERO), Some(ROOM_WAIT));
    assert_eq!(
        room_wait(CHECK_WAIT - Duration::from_secs(1)),
        Some(Duration::from_secs(1))
    );
    assert_eq!(room_wait(CHECK_WAIT), None);
    assert_eq!(room_wait(CHECK_WAIT + Duration::from_secs(9)), None);
    // A retry shares its question's wait: a first try that took a while leaves the second only the rest.
    let models = r#"{"models":[{"name":"older-slow:8b"}]}"#;
    let refused = r#"{"error":{"message":"think value \"none\" is not supported for this model"}}"#;
    let mut mac = ollama_running(models)
        .with("POST 1", Ok((400, refused)))
        .with("POST 2", Ok((200, CALLED)))
        .with("POST 3", Ok((200, &said("HARBOR"))));
    mac.first_post_takes = Duration::from_millis(150);
    assert_eq!(run(&mac, "older-slow:8b").0, Verdict::Answers);
    let waits = mac.waits.lock().unwrap().clone();
    assert!(
        waits[1] + Duration::from_millis(150) <= waits[0],
        "{waits:?}"
    );
}

/// The real client over a loopback listener: each request gives up at its own wait, never the client's longer one.
#[test]
fn review_l4_the_real_client_keeps_each_requests_own_wait() {
    let http = NativeLocalHttp::new(ANSWER_WAIT).unwrap();
    for post in [false, true] {
        let silent = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = silent.local_addr().unwrap().port();
        let hold = std::thread::spawn(move || {
            let held = silent.accept();
            std::thread::sleep(Duration::from_millis(2_500));
            drop(held);
        });
        let url = format!("http://127.0.0.1:{port}/api/ps");
        let began = std::time::Instant::now();
        let answer = if post {
            http.post_within(&url, b"{}", Duration::from_millis(300))
        } else {
            http.get_within(&url, Duration::from_millis(300))
        };
        assert_eq!(answer.err(), Some(Failure::Timeout), "post {post}");
        assert!(
            began.elapsed() < Duration::from_millis(1_500),
            "post {post}: {:?}",
            began.elapsed()
        );
        hold.join().unwrap();
    }
    // Only the two apps' own addresses are ever asked, whichever wait.
    assert_eq!(
        http.get("http://127.0.0.1:8080/api/ps", FIND_WAIT).err(),
        Some(Failure::Unreachable)
    );
}

// ---- A check the person walked away from never switches the AI when it finishes (review M-2, 2026-11-18) ------------

/// An AI company that answers every key check "works", and a Keychain in memory: a key check that passes.
struct KeyWorks;
impl model::ModelHttp for KeyWorks {
    fn post(
        &self,
        _: &str,
        _: Option<(&str, model::KeyHeader)>,
        _: &[(&str, &str)],
        _: &[u8],
    ) -> Result<(u16, zeroize::Zeroizing<Vec<u8>>), ModelError> {
        Ok((200, zeroize::Zeroizing::new(br#"{"choices":[]}"#.to_vec())))
    }
}
#[derive(Default)]
struct Keychain(Mutex<std::collections::BTreeMap<String, String>>);
impl model::ModelKeys for Keychain {
    fn key(
        &self,
        account: &str,
    ) -> Result<Option<zeroize::Zeroizing<String>>, crate::credentials::StoreError> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .get(account)
            .cloned()
            .map(zeroize::Zeroizing::new))
    }
}
impl crate::own_key::KeyStore for Keychain {
    fn put_key(&self, account: &str, key: &str) -> Result<(), crate::credentials::StoreError> {
        self.0.lock().unwrap().insert(account.into(), key.into());
        Ok(())
    }
    fn delete_key(&self, account: &str) -> Result<(), crate::credentials::StoreError> {
        self.0.lock().unwrap().remove(account);
        Ok(())
    }
}

#[test]
fn review_m2_a_check_on_this_mac_overtaken_by_another_choice_leaves_that_choice_in_place() {
    // Fictional, written in parts so no line here looks like a real key.
    let key = concat!("sk-", "proj-fictional0canary0key0local0order00");
    let answers = said("HARBOR");
    // "Check that it answers" starts; meanwhile the person goes back, chooses OpenAI, and the key works.
    let dir = Dir::new("overtaken-by-key");
    let keychain = std::sync::Arc::new(Keychain::default());
    let mut mac = ollama_running(TWO_MODELS)
        .with("POST 1", Ok((200, CALLED)))
        .with("POST 2", Ok((200, &answers)));
    let openai = crate::own_key::Choice::Preset(crate::own_key::preset("openai").unwrap());
    let (at, kept) = (dir.0.clone(), keychain.clone());
    mac.while_first_post = Some(Box::new(move || {
        let said = crate::own_key::check_and_save(
            &at,
            &openai,
            key,
            &NameGuard::default(),
            &KeyWorks,
            &*kept,
        )
        .unwrap();
        assert_eq!(said.verdict, crate::own_key::Verdict::Works);
    }));
    let checked = check(
        &dir.0,
        App::Ollama,
        "qwen3:8b",
        &NameGuard::default(),
        &mac,
        &|| 1,
    )
    .unwrap();
    // It answered, but Ozzie didn't switch to it: OpenAI, chosen last, stays.
    assert_eq!(checked.verdict, Verdict::ChoiceChanged);
    assert!(checked.status.is_none());
    assert_eq!(mac.posts.lock().unwrap().len(), 2, "the whole check ran");
    let route = model::load_config(&dir.0).unwrap();
    assert_eq!(route.route, model::Route::Own);
    assert_eq!(keychain.0.lock().unwrap().len(), 1);
    drop(mac);

    // "No AI for now" while it is checked: no AI is chosen afterwards.
    let dir = Dir::new("overtaken-by-none");
    let mut mac = ollama_running(TWO_MODELS)
        .with("POST 1", Ok((200, CALLED)))
        .with("POST 2", Ok((200, &answers)));
    let at = dir.0.clone();
    mac.while_first_post = Some(Box::new(move || {
        model::choose_no_ai(&at, &Keychain::default()).unwrap();
    }));
    let checked = check(
        &dir.0,
        App::Ollama,
        "qwen3:8b",
        &NameGuard::default(),
        &mac,
        &|| 1,
    )
    .unwrap();
    assert_eq!(checked.verdict, Verdict::ChoiceChanged);
    assert!(model::load_config(&dir.0).is_none());
    drop(mac);

    // Nothing chosen meanwhile: it answers and is chosen, as before.
    let mac = ollama_running(TWO_MODELS)
        .with("POST 1", Ok((200, CALLED)))
        .with("POST 2", Ok((200, &answers)));
    let (verdict, _, saved) = run(&mac, "qwen3:8b");
    assert_eq!(verdict, Verdict::Answers);
    assert_eq!(saved.unwrap().route, model::Route::Local);
    // The page reads this word.
    assert_eq!(
        serde_json::to_string(&Verdict::ChoiceChanged).unwrap(),
        r#""choice-changed""#
    );
}

// ---- A check that passed on a small window says how to give it room (B-2, 2026-11-18) ------------------------------

#[test]
fn b2_a_check_that_passed_where_the_app_gave_little_room_keeps_its_success_and_says_so() {
    // With thinking off, the check's ~3,900-token question fits Ollama's default 4,096 tokens, so the check passes
    // there; a larger church's question wouldn't fit, and the app would cut it silently.
    let answers = said("HARBOR");
    for (room, small) in [
        (Some(4096), true),
        (Some(8191), true),
        (Some(8192), false),
        (Some(32768), false),
        (None, false),
    ] {
        let mut mac = ollama_running(TWO_MODELS)
            .with("POST 1", Ok((200, CALLED)))
            .with("POST 2", Ok((200, &answers)));
        let ps = room.map(|room| loaded("qwen3:8b", room));
        if let Some(ps) = &ps {
            mac = mac.with("http://127.0.0.1:11434/api/ps", Ok((200, ps)));
        }
        let dir = Dir::new("small-room");
        let checked = check(
            &dir.0,
            App::Ollama,
            "qwen3:8b",
            &NameGuard::default(),
            &mac,
            &|| 1,
        )
        .unwrap();
        // The success and the saved route stand either way.
        assert_eq!(
            (checked.verdict, checked.small_room),
            (Verdict::Answers, small),
            "{room:?}"
        );
        assert!(model::usable_config(&dir.0).is_some());
        // One short GET for the room, within the check's three minutes; nothing posted for it.
        let gets = mac.get_waits.lock().unwrap().clone();
        assert_eq!(gets.len(), 3, "{gets:?}");
        assert_eq!(gets[2].0, "http://127.0.0.1:11434/api/ps");
        assert!(gets[2].1 <= ROOM_WAIT);
        assert_eq!(mac.posts.lock().unwrap().len(), 2);
    }
    // LM Studio says it per loaded copy of the model.
    let models = r#"{"models":[{"type":"llm","key":"qwen/qwen3-8b","loaded_instances":[{"id":"qwen/qwen3-8b","config":{"context_length":4096}}],"max_context_length":40960}]}"#;
    let mac = Mac::default()
        .with(
            "http://127.0.0.1:1234/v1/models",
            Ok((200, r#"{"data":[{"id":"qwen/qwen3-8b","object":"model"}]}"#)),
        )
        .with("POST 1", Ok((200, CALLED)))
        .with("POST 2", Ok((200, &answers)))
        .with("http://127.0.0.1:1234/api/v1/models", Ok((200, models)));
    let dir = Dir::new("small-room-lm");
    let checked = check(
        &dir.0,
        App::LmStudio,
        "qwen/qwen3-8b",
        &NameGuard::default(),
        &mac,
        &|| 1,
    )
    .unwrap();
    assert_eq!(
        (checked.verdict, checked.small_room),
        (Verdict::Answers, true)
    );
    // The page reads it as `small_room`, true only on `answers`.
    let said = serde_json::to_value(&checked).unwrap();
    assert_eq!(said["small_room"], true);
    // Past the three minutes there is no time to ask: unknown, and nothing more is said.
    assert_eq!(room_wait(CHECK_WAIT), None);
}
