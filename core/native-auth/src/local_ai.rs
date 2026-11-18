//! AI on this Mac (onboarding spec S9, lane N6): finding Ollama or LM Studio, choosing a model, and checking that
//! it answers before Ozzie says it is in use.
//!
//! Only two addresses are ever asked, both this Mac's loopback: Ollama at `http://127.0.0.1:11434` and LM Studio at
//! `http://127.0.0.1:1234`. Finding is GETs only with a 1-second wait (`/api/version`, `/api/tags`, `/v1/models`);
//! the check is the same two GETs, two Chat Completions requests to the chosen app's own `/v1`, carrying only fixed
//! fictional text, and one GET for the room the app gave the model (`/api/ps`, `/api/v1/models`): when the second
//! answer misses the check word, to say why, and when it passes, to say whether a larger church's question would fit.
//! Each request waits only as long as its own wait, and the whole check ends within three minutes (`CHECK_WAIT`). No
//! key, no church data and no name ever goes; nothing leaves this Mac. A model is saved as the route only once it
//! answered, with when (`model::save_local_checked`), and only if no other choice of AI was made while it was checked.
//!
//! Every request to a model on this Mac asks it not to think first (providers.json `local.reasoning_effort`): a
//! thinking model otherwise spends its whole answer thinking (owner's live test, Ollama 0.40.16 and qwen3:8b,
//! 2026-11-18). An app that refuses the setting is asked once more without it, and that model is remembered.
use crate::model::{self, ModelError, ModelStatus, RouteConfig};
use crate::name_guard::NameGuard;
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    io::Read,
    path::Path,
    sync::Mutex,
    time::{Duration, Instant},
};

/// The only two places AI on this Mac is looked for.
pub const OLLAMA: &str = "http://127.0.0.1:11434";
pub const LM_STUDIO: &str = "http://127.0.0.1:1234";
/// How long finding waits for each app.
pub const FIND_WAIT: Duration = Duration::from_secs(1);
/// How long the check's first question (the one that needs a lookup) waits, counted from when the check began, and
/// the most one request to a model on this Mac waits in normal use (`model::request_wait`; an Ask's step waits no
/// longer than its task has left). Measured on a 16 GB Mac with qwen3:8b, thinking off: 27 to 47 seconds for a
/// ~3,900-token question nothing was cached for, a model just loaded included (2026-11-18). The too-slow verdict's
/// true sentence for it: "It didn't answer within two minutes".
pub const ANSWER_WAIT: Duration = Duration::from_secs(120);
/// How long the second question waits. It repeats the first up to its last line, so the app reuses what it just read
/// (0.9 seconds measured). Its sentence: "didn't answer the second within a minute".
pub const START_WAIT: Duration = Duration::from_secs(60);
/// The whole check, from pressing the button: the page's "This can take up to three minutes". Asking again without
/// the thinking setting shares its question's wait, and the room's GET gets only what is left (`room_wait`).
pub const CHECK_WAIT: Duration = ANSWER_WAIT.saturating_add(START_WAIT);
/// How long the GET for the room the app gave the model waits: the model has just answered, so the app is up.
pub const ROOM_WAIT: Duration = Duration::from_secs(3);
/// The room, in tokens, a model needs for a larger church's Ask: Ollama's "8k" (its default is 4k below 24 GB of
/// graphics memory). The check's ~3,900-token question was cut there while thinking was on; with thinking off it fits
/// 4k, so a check that passes with less room than this says so (`LocalCheck::small_room`).
pub const CONTEXT_NEEDED: u64 = 8192;
const MAX_BODY: u64 = 1_048_576;
/// Models listed per app, at most.
pub(crate) const MAX_MODELS: usize = 50;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum App {
    Ollama,
    LmStudio,
}
impl App {
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "ollama" => Some(Self::Ollama),
            "lm-studio" => Some(Self::LmStudio),
            _ => None,
        }
    }
    pub fn origin(self) -> &'static str {
        match self {
            Self::Ollama => OLLAMA,
            Self::LmStudio => LM_STUDIO,
        }
    }
    /// The model route's base for this app (OpenAI-style, both apps).
    pub fn base(self) -> String {
        format!("{}/v1", self.origin())
    }
    /// The app's bundle name, for `open -a` and for looking in the Applications folders.
    pub fn bundle(self) -> &'static str {
        match self {
            Self::Ollama => "Ollama",
            Self::LmStudio => "LM Studio",
        }
    }
}

/// How finding and checking reach the two apps. Every URL is one of the two loopback origins (`loopback_only`).
pub trait LocalHttp {
    /// One GET, waiting at most `wait` for the whole answer.
    fn get(&self, url: &str, wait: Duration) -> Result<(u16, Vec<u8>), Failure>;
    /// One question, waiting at most `wait` for the whole answer.
    fn post(&self, url: &str, body: &[u8], wait: Duration) -> Result<(u16, Vec<u8>), Failure>;
    /// One DELETE with a body (Ollama's `/api/delete`, for "Remove this model from this Mac"), waiting at most `wait`.
    fn delete(&self, url: &str, body: &[u8], wait: Duration) -> Result<(u16, Vec<u8>), Failure>;
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failure {
    /// Nothing listening (the app isn't open), or the connection dropped.
    Unreachable,
    /// It is listening but didn't answer in time.
    Timeout,
}
/// A URL is one of the two apps' own addresses on this Mac, and nothing else.
pub fn loopback_only(url: &str) -> bool {
    [OLLAMA, LM_STUDIO].iter().any(|origin| {
        url.strip_prefix(origin)
            .is_some_and(|rest| rest.starts_with('/'))
    })
}
/// The real client: plain http to 127.0.0.1 only, no proxy, no redirects, no retries.
pub struct NativeLocalHttp(reqwest::blocking::Client);
impl NativeLocalHttp {
    /// `wait`: the longest any request through it may take; each request also gives its own, shorter or equal.
    pub fn new(wait: Duration) -> Result<Self, ModelError> {
        reqwest::blocking::Client::builder()
            .no_proxy()
            .retry(reqwest::retry::never())
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(FIND_WAIT)
            .timeout(wait)
            .user_agent("Ozzie (https://ozzie.church)")
            .build()
            .map(Self)
            .map_err(|_| ModelError::ProviderFailure)
    }
    fn send(request: reqwest::blocking::RequestBuilder) -> Result<(u16, Vec<u8>), Failure> {
        let response = request.send().map_err(|e| {
            if e.is_timeout() {
                Failure::Timeout
            } else {
                Failure::Unreachable
            }
        })?;
        let status = response.status().as_u16();
        let mut bytes = Vec::new();
        response
            .take(MAX_BODY + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| Failure::Timeout)?;
        if bytes.len() as u64 > MAX_BODY {
            return Err(Failure::Unreachable);
        }
        Ok((status, bytes))
    }
    /// A GET to an address already checked, waiting at most `wait`.
    fn get_within(&self, url: &str, wait: Duration) -> Result<(u16, Vec<u8>), Failure> {
        Self::send(
            self.0
                .get(url)
                .timeout(wait)
                .header("Accept", "application/json"),
        )
    }
    /// A question to an address already checked, waiting at most `wait`.
    fn post_within(
        &self,
        url: &str,
        body: &[u8],
        wait: Duration,
    ) -> Result<(u16, Vec<u8>), Failure> {
        Self::send(
            self.0
                .post(url)
                .timeout(wait)
                .header("Content-Type", "application/json")
                .body(body.to_vec()),
        )
    }
}
impl LocalHttp for NativeLocalHttp {
    fn get(&self, url: &str, wait: Duration) -> Result<(u16, Vec<u8>), Failure> {
        if !loopback_only(url) {
            return Err(Failure::Unreachable);
        }
        self.get_within(url, wait)
    }
    fn post(&self, url: &str, body: &[u8], wait: Duration) -> Result<(u16, Vec<u8>), Failure> {
        if !loopback_only(url) {
            return Err(Failure::Unreachable);
        }
        self.post_within(url, body, wait)
    }
    fn delete(&self, url: &str, body: &[u8], wait: Duration) -> Result<(u16, Vec<u8>), Failure> {
        if !loopback_only(url) {
            return Err(Failure::Unreachable);
        }
        Self::send(
            self.0
                .delete(url)
                .timeout(wait)
                .header("Content-Type", "application/json")
                .body(body.to_vec()),
        )
    }
}

/// Models on this Mac whose app refused the thinking setting this session, as (address, model): asked without it.
static NO_THINKING_SETTING: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());
fn thinking_setting_refused(base: &str, model: &str) -> bool {
    NO_THINKING_SETTING
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .any(|(b, m)| b == base && m == model)
}
/// This Mac's rule for one request (own_key.rs `shape`, and the check): don't think before answering, unless this
/// model's app refused that this session.
pub(crate) fn think_less(base: &str, model: &str, body: &mut Value) {
    let Some(effort) = &crate::own_key::catalog().local.reasoning_effort else {
        return;
    };
    if let Some(object) = body.as_object_mut()
        && !thinking_setting_refused(base, model)
    {
        object.insert("reasoning_effort".into(), json!(effort));
    }
}
/// An app refusing the thinking setting answers 400 in these words: Ollama 0.11.5 to 0.12.3 `think value "none" is
/// not supported for this model` (server/routes.go at v0.12.3), its `invalid reasoning value` for a value it doesn't
/// know (openai/openai.go), or an app naming the setting itself (`reasoning_effort`). Only these fixed phrases are
/// looked for, never a lone "think" or "reasoning", which a model's own name can hold (`phi4-reasoning … does not
/// support tools`, review L1). Model names hold no spaces.
pub(crate) fn refused_thinking_setting(status: u16, body: &[u8]) -> bool {
    const PHRASES: [&str; 4] = [
        "think value",
        "invalid reasoning",
        "reasoning_effort",
        "reasoning effort",
    ];
    let text = String::from_utf8_lossy(body).to_ascii_lowercase();
    status == 400 && PHRASES.iter().any(|phrase| text.contains(phrase))
}
/// The same request without the thinking setting, with this model remembered; None when it carried none.
pub(crate) fn without_thinking_setting(base: &str, model: &str, body: &[u8]) -> Option<Vec<u8>> {
    let mut value: Value = serde_json::from_slice(body).ok()?;
    value.as_object_mut()?.remove("reasoning_effort")?;
    let mut refused = NO_THINKING_SETTING
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if !refused.iter().any(|(b, m)| b == base && m == model) {
        refused.push((base.to_owned(), model.to_owned()));
    }
    serde_json::to_vec(&value).ok()
}

#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct LocalModelView {
    pub id: String,
    pub size_bytes: Option<u64>,
    /// Small enough for this Mac's memory (unknown sizes count as fitting).
    pub fits: bool,
    pub recommended: bool,
}
#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct AppFound {
    pub app: App,
    pub installed: bool,
    /// Its server answered just now.
    pub running: bool,
    /// How to start it when it is installed but not answering (LM Studio's server is started by hand).
    pub start_hint: &'static str,
    pub models: Vec<LocalModelView>,
}
#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct LocalFind {
    /// None when this Mac's memory couldn't be read (never 0 GB; review L12).
    pub memory_gb: Option<u64>,
    /// "too-small" (no model Ozzie offers fits this Mac's memory: AI on this Mac needs 16 GB or more), "medium" (under
    /// 32 GB), "large", or "unknown" when the memory couldn't be read.
    pub advice: &'static str,
    /// The model Ozzie recommends for this Mac (`advice`); None when there is none to recommend.
    pub recommended: Option<String>,
    pub recommended_size_bytes: Option<u64>,
    /// Both apps, always: Ollama first. Ozzie's own set-up copies (local_models.rs) aren't among Ollama's models: they
    /// are the catalogue's rows.
    pub apps: Vec<AppFound>,
    /// Free space, in bytes, where Ollama keeps models, when Ozzie can tell (`local_models::ollama_free_bytes`).
    pub free_bytes: Option<u64>,
    /// The three models Ozzie can download and set up itself (providers.json `local`), as they stand on this Mac.
    pub catalogue: Vec<crate::local_models::CatalogueRow>,
}

const GB: u64 = 1_073_741_824;
/// The advice for this Mac's memory and the model recommended (spec S9's table; the models are data in providers.json).
/// Only a model Ozzie offers, that fits, and that was tested (`tested`) is ever recommended, so a download that would
/// fail is never suggested. No offered model fits: "too-small" (an 8 GB Mac: the small model, the only one that fits
/// there, never finished a lookup question, 2026-11-18). From 32 GB the large one fits too, but it isn't tested.
pub fn advice(memory_bytes: u64) -> (&'static str, Option<&'static crate::own_key::LocalModel>) {
    let local = &crate::own_key::catalog().local;
    let gb = memory_bytes.div_ceil(GB);
    if gb == 0 {
        return ("unknown", None);
    }
    let usable = |m: &&'static crate::own_key::LocalModel| m.offered && fits(Some(m.size_bytes), memory_bytes);
    if ![&local.small, &local.medium, &local.large].iter().any(usable) {
        return ("too-small", None);
    }
    // The largest tested model that is offered and fits.
    let recommended = [&local.large, &local.medium, &local.small]
        .into_iter()
        .find(|m| m.tested && usable(m));
    (if gb >= 32 { "large" } else { "medium" }, recommended)
}
/// A model fits when it is at most half this Mac's memory (unknown memory: not judged).
pub(crate) fn fits(size: Option<u64>, memory_bytes: u64) -> bool {
    memory_bytes == 0 || size.is_none_or(|size| size <= memory_bytes / 2)
}
/// Ollama names a model's default tag `latest`: "llama3.2" and "llama3.2:latest" are one model.
pub(crate) fn same_model(a: &str, b: &str) -> bool {
    let full = |id: &str| {
        if id.contains(':') {
            id.to_owned()
        } else {
            format!("{id}:latest")
        }
    };
    full(a) == full(b)
}
/// A model id an app lists, kept only if it keeps the model id rules every route keeps.
fn model_id(id: &str) -> Option<String> {
    let probe = RouteConfig::new(model::Route::Local, Some(&App::Ollama.base()), Some(id));
    probe.ok().map(|_| id.to_owned())
}
/// The models an app lists right now, or None when it isn't answering.
pub(crate) fn listed(app: App, http: &dyn LocalHttp) -> Option<Vec<(String, Option<u64>)>> {
    let (path, rows, id, size) = match app {
        App::Ollama => {
            // Ollama answers its version first; the models come from its tags.
            let (status, _) = http.get(&format!("{OLLAMA}/api/version"), FIND_WAIT).ok()?;
            if status != 200 {
                return None;
            }
            ("/api/tags", "models", "name", Some("size"))
        }
        App::LmStudio => ("/v1/models", "data", "id", None),
    };
    let (status, body) = http
        .get(&format!("{}{path}", app.origin()), FIND_WAIT)
        .ok()?;
    if status != 200 {
        return None;
    }
    let value: Value = serde_json::from_slice(&body).ok()?;
    Some(
        value[rows]
            .as_array()
            .map_or(&[][..], Vec::as_slice)
            .iter()
            .filter_map(|row| {
                let id = model_id(row[id].as_str()?)?;
                Some((id, size.and_then(|key| row[key].as_u64())))
            })
            .take(MAX_MODELS)
            .collect(),
    )
}

/// What is on this Mac now. `installed` says whether each app is in an Applications folder.
pub fn find(http: &dyn LocalHttp, installed: impl Fn(App) -> bool, memory_bytes: u64) -> LocalFind {
    find_with(
        http,
        installed,
        memory_bytes,
        None,
        &crate::local_models::Kept::default(),
    )
}
/// `find`, with the free space where Ollama keeps models and what Ozzie downloaded itself (`local-models.json`), so
/// the catalogue's rows can say whether each model would fit on the disk and which Ozzie may remove.
pub fn find_with(
    http: &dyn LocalHttp,
    installed: impl Fn(App) -> bool,
    memory_bytes: u64,
    free_bytes: Option<u64>,
    kept: &crate::local_models::Kept,
) -> LocalFind {
    find_reading(http, installed, memory_bytes, free_bytes, |_| kept.clone())
}
/// `find_with`, the record of what Ozzie downloaded read from Ollama's list as it was just given (None: Ollama isn't
/// answering): `local_models::find` checks the record against it (review L-2).
pub(crate) fn find_reading(
    http: &dyn LocalHttp,
    installed: impl Fn(App) -> bool,
    memory_bytes: u64,
    free_bytes: Option<u64>,
    kept: impl FnOnce(Option<&[(String, Option<u64>)]>) -> crate::local_models::Kept,
) -> LocalFind {
    let (advice, recommended) = advice(memory_bytes);
    let mut ollama_listed = None;
    let apps = [App::Ollama, App::LmStudio]
        .into_iter()
        .map(|app| {
            let mut models = listed(app, http);
            if app == App::Ollama {
                ollama_listed = models.clone();
                // Ozzie's own copies are shown as the catalogue's rows, never as a model the person brought.
                if let Some(models) = models.as_mut() {
                    models.retain(|(id, _)| !crate::local_models::is_setup_name(id));
                }
            }
            let local = &crate::own_key::catalog().local;
            AppFound {
                start_hint: match app {
                    App::Ollama => &local.ollama_start,
                    App::LmStudio => &local.lm_studio_start,
                },
                app,
                installed: installed(app) || models.is_some(),
                running: models.is_some(),
                models: models
                    .unwrap_or_default()
                    .into_iter()
                    .map(|(id, size)| LocalModelView {
                        recommended: recommended.is_some_and(|r| same_model(&id, &r.id)),
                        fits: fits(size, memory_bytes),
                        id,
                        size_bytes: size,
                    })
                    .collect(),
            }
        })
        .collect();
    let kept = kept(ollama_listed.as_deref());
    LocalFind {
        memory_gb: (memory_bytes > 0).then(|| memory_bytes.div_ceil(GB)),
        advice,
        recommended: recommended.map(|r| r.id.clone()),
        recommended_size_bytes: recommended.map(|r| r.size_bytes),
        apps,
        free_bytes,
        catalogue: crate::local_models::catalogue(
            ollama_listed.as_deref(),
            memory_bytes,
            free_bytes,
            &kept,
        ),
    }
}
/// This Mac's memory (`sysctl -n hw.memsize`), or 0 when it can't be read.
pub fn memory_bytes() -> u64 {
    std::process::Command::new("/usr/sbin/sysctl")
        .args(["-n", "hw.memsize"])
        .output()
        .ok()
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .and_then(|text| text.trim().parse().ok())
        .unwrap_or(0)
}
/// Whether an app is in /Applications or the person's own Applications folder.
pub fn installed_on_this_mac(app: App) -> bool {
    let name = format!("{}.app", app.bundle());
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
    std::iter::once(Path::new("/Applications").join(&name))
        .chain(home.map(|h| h.join("Applications").join(&name)))
        .any(|path| path.is_dir())
}

/// The closed verdicts of "Check that it answers" (spec S9).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Verdict {
    Answers,
    NoTools,
    /// It missed the check word though the app gave it room for the whole question.
    LostStart,
    /// The app gave the model too little room for the whole question (or says it is too long, or doesn't say).
    SmallContext,
    /// It ran out of tokens thinking and said nothing.
    ThinksTooLong,
    /// Asked for the check word, it used the lookup instead, so whether it read the whole question is unknown.
    LookupInstead,
    TooSlow,
    Stopped,
    NotFound,
    /// It answers, but another choice of AI was made while it was checked (`model::route_generation`): Ozzie didn't
    /// switch to it, so the person's later choice stands (review M-2).
    ChoiceChanged,
}
#[derive(Serialize)]
pub struct LocalCheck {
    pub verdict: Verdict,
    /// How long the answer with lookups took, in whole seconds (on `answers`, and when it answered at all).
    pub seconds: Option<u64>,
    /// On `answers` only: the route now chosen (filled in by the app, as `model_status` gives it).
    pub status: Option<ModelStatus>,
    /// On `answers` only: the app says it gave the model less room than `CONTEXT_NEEDED`. The check's question fit, but
    /// a larger church's would be cut without a word, so the page says how to give it more (B-2). False when the app
    /// doesn't say.
    pub small_room: bool,
}

/// The check word at the very start of the long question: a model that drops the start can't repeat it.
pub const CHECK_WORD: &str = "HARBOR";
const CHECK_SYSTEM: &str = "You help a church volunteer coordinator. Use the tools you are given to look facts up. Answer in one short sentence.";
/// A fictional church's service, at the size of a real Ask's fact sheet, with no real name or detail.
fn fact_sheet() -> String {
    let mut sheet = format!(
        "Check word: {CHECK_WORD}. Remember it.\n\nFacts about the fictional example church's service on Sunday, November 22, at 9:00 and 11:00 AM.\n"
    );
    for n in 1..=60 {
        sheet.push_str(&format!(
            "Fact {n}: Team [Team {t}] has role [Role {n}] at the {time} service; [Volunteer {v}] is scheduled and said yes; one more person is needed only if the church rule for [Role {n}] says two.\n",
            t = n % 6 + 1,
            time = if n % 2 == 0 { "9:00 AM" } else { "11:00 AM" },
            v = n % 26 + 1,
        ));
    }
    sheet
}
/// One lookup, as Ozzie's Ask offers them.
fn tools() -> Value {
    json!([{
        "type": "function",
        "function": {
            "name": "sunday_open_needs",
            "description": "Lists the roles at the service that still need people.",
            "parameters": {"type": "object", "properties": {}, "additionalProperties": false},
        },
    }])
}
/// The room each check question leaves for the answer: the room a real Ask step has (`agent::MAX_TOKENS`), so the check
/// fails a model only for what would fail it in use. 200 was too little for a model that thinks: qwen3:8b with thinking
/// on reached the lookup in 138 to 227 tokens and was cut off once in three at 200, and GPT-OSS can't stop thinking
/// (measured with the exact bodies, 2026-11-18). A model that thinks aloud without end is still cut off: `thinks-too-long`.
pub const CHECK_TOKENS: u32 = crate::agent::MAX_TOKENS;
/// The room the second question leaves: it asks for one word, which qwen3:8b gave in 4 tokens thinking off and 90
/// thinking on (exact bodies, 2026-11-18), so a model that thinks first still has room. At 12 tokens a second this is
/// about 33 seconds, inside `START_WAIT`, so a model that thinks aloud without end on a slower Mac is cut off here and
/// called `thinks-too-long`, not too slow; the room of a real Ask step (`CHECK_TOKENS`) took about 58 (review L-6).
pub const WORD_TOKENS: u32 = 400;
/// The two check requests to this app: the question that needs a lookup, then the start-of-question test. The second
/// repeats the first up to its last line, lookup offered included, so the app reuses what it read for the first; its
/// last line asks for the word without the lookup (review M2). The first leaves `CHECK_TOKENS`, the second `WORD_TOKENS`.
pub fn check_bodies(app: App, model: &str) -> (Value, Value) {
    let sheet = fact_sheet();
    let mut lookup = json!({
        "model": model,
        "messages": [
            {"role": "system", "content": CHECK_SYSTEM},
            {"role": "user", "content": format!("{sheet}\nQuestion: which roles still need people? Use the sunday_open_needs tool to find out.")},
        ],
        "tools": tools(),
        "max_tokens": CHECK_TOKENS,
        "temperature": 0.2,
        "stream": false,
    });
    let mut start = json!({
        "model": model,
        "messages": [
            {"role": "system", "content": CHECK_SYSTEM},
            {"role": "user", "content": format!("{sheet}\nQuestion: what is the check word given at the very start of this message? Do not use a tool; reply with the word only.")},
        ],
        "tools": tools(),
        "max_tokens": WORD_TOKENS,
        "temperature": 0.0,
        "stream": false,
    });
    think_less(&app.base(), model, &mut lookup);
    think_less(&app.base(), model, &mut start);
    (lookup, start)
}
fn failed(failure: Failure) -> Verdict {
    match failure {
        Failure::Timeout => Verdict::TooSlow,
        Failure::Unreachable => Verdict::Stopped,
    }
}
/// It asked for a lookup.
fn called_lookup(value: &Value) -> bool {
    value["choices"][0]["message"]["tool_calls"]
        .as_array()
        .is_some_and(|calls| !calls.is_empty())
}
/// How long the GET for the room may wait, `elapsed` into the check: what is left of `CHECK_WAIT`, at most
/// `ROOM_WAIT`; none once the three minutes are spent.
pub(crate) fn room_wait(elapsed: Duration) -> Option<Duration> {
    let left = CHECK_WAIT.saturating_sub(elapsed);
    (!left.is_zero()).then(|| left.min(ROOM_WAIT))
}
/// Cut off at the token limit before it finished: it spent its answer thinking, in its reasoning or aloud in its words
/// ("Okay, the user is asking which roles…", qwen3:4b with thinking off, measured 2026-11-18), so whether it can use
/// the lookups is unknown. Never `no-tools`, which is only a refusal of the tools or a finished answer without them.
fn cut_off(value: &Value) -> bool {
    value["choices"][0]["finish_reason"] == "length"
}
/// An app refusing a question longer than the model's room names it: LM Studio's reported "loaded with context
/// length of only 4096 tokens, which is not enough", llama.cpp's `n_ctx`. Only these fixed words are looked for.
fn refused_as_too_long(body: &[u8]) -> bool {
    let text = String::from_utf8_lossy(body).to_ascii_lowercase();
    text.contains("context length") || text.contains("n_ctx")
}
/// The room, in tokens, the app gave this model when it loaded it, when it says: Ollama's `/api/ps`
/// `context_length`, LM Studio's `/api/v1/models` `loaded_instances[].config.context_length`.
fn loaded_room(app: App, model: &str, http: &dyn LocalHttp, wait: Duration) -> Option<u64> {
    let path = match app {
        App::Ollama => "/api/ps",
        App::LmStudio => "/api/v1/models",
    };
    let (status, body) = http.get(&format!("{}{path}", app.origin()), wait).ok()?;
    if status != 200 {
        return None;
    }
    let value: Value = serde_json::from_slice(&body).ok()?;
    value["models"]
        .as_array()?
        .iter()
        .find_map(|row| match app {
            App::Ollama => [&row["name"], &row["model"]]
                .iter()
                .any(|id| id.as_str().is_some_and(|id| same_model(id, model)))
                .then(|| row["context_length"].as_u64())
                .flatten(),
            App::LmStudio => row["loaded_instances"]
                .as_array()?
                .iter()
                .find(|copy| copy["id"] == model || row["key"] == model)
                .and_then(|copy| copy["config"]["context_length"].as_u64()),
        })
}
/// "Check that it answers": the model must be one the app lists now, must call a lookup when asked to, and must
/// still see the start of a long question. Only on `answers` is the route saved (with `at_ms`).
pub fn check(
    dir: &Path,
    app: App,
    model_id: &str,
    names: &NameGuard,
    http: &dyn LocalHttp,
    clock: &dyn Fn() -> u64,
) -> Result<LocalCheck, ModelError> {
    check_since(
        dir,
        app,
        model_id,
        names,
        http,
        clock,
        model::route_generation(dir),
    )
}
/// The check, for a press that came earlier: `choices` is `model::route_generation` when the person pressed the button
/// ("Download and set up" reads it before the download, which can take many minutes), so a choice of AI made at any
/// time since wins over this check's result (review M-2).
pub fn check_since(
    dir: &Path,
    app: App,
    model_id: &str,
    names: &NameGuard,
    http: &dyn LocalHttp,
    clock: &dyn Fn() -> u64,
    choices: u64,
) -> Result<LocalCheck, ModelError> {
    let verdict = |verdict, seconds| LocalCheck {
        verdict,
        seconds,
        status: None,
        small_room: false,
    };
    RouteConfig::new(model::Route::Local, Some(&app.base()), Some(model_id))?;
    if !model::model_free_of_names(model_id, names) {
        return Err(ModelError::NamePresent);
    }
    // Every wait below counts from here, when the check began (`CHECK_WAIT`). A choice of AI made since `choices` was
    // read wins over this check's result (review M-2).
    let started = Instant::now();
    let Some(models) = listed(app, http) else {
        return Ok(verdict(Verdict::Stopped, None));
    };
    if !models.iter().any(|(id, _)| id == model_id) {
        return Ok(verdict(Verdict::NotFound, None));
    }
    let url = format!("{}/chat/completions", app.base());
    let base = app.base();
    // One question; asked once more without the thinking setting if the app refuses it, within the same wait.
    let ask = |body: &Value, wait: Duration| {
        if wait.is_zero() {
            return Err(Failure::Timeout);
        }
        let until = Instant::now() + wait;
        let bytes = serde_json::to_vec(body).unwrap_or_default();
        let answer = http.post(&url, &bytes, wait)?;
        match refused_thinking_setting(answer.0, &answer.1)
            .then(|| without_thinking_setting(&base, model_id, &bytes))
            .flatten()
        {
            Some(again) => match until.saturating_duration_since(Instant::now()) {
                left if left.is_zero() => Err(Failure::Timeout),
                left => http.post(&url, &again, left),
            },
            None => Ok(answer),
        }
    };
    let (lookup, _) = check_bodies(app, model_id);
    let began = clock();
    // The first question's two minutes count from the button, finding the model included.
    let answer = match ask(&lookup, ANSWER_WAIT.saturating_sub(started.elapsed())) {
        Ok(answer) => answer,
        Err(failure) => return Ok(verdict(failed(failure), None)),
    };
    let seconds = Some(clock().saturating_sub(began).div_ceil(1000));
    let value: Value = serde_json::from_slice(&answer.1).unwrap_or(Value::Null);
    // Ollama refuses tools for a model without them (400 "does not support tools"); others finish in prose without the
    // lookup. Either is `no-tools`; an answer cut off before it finished is not (2026-11-18).
    let called = called_lookup(&value);
    match answer.0 {
        200 if called => {}
        200 if cut_off(&value) => return Ok(verdict(Verdict::ThinksTooLong, seconds)),
        200 => return Ok(verdict(Verdict::NoTools, seconds)),
        _ if refused_as_too_long(&answer.1) => {
            return Ok(verdict(Verdict::SmallContext, seconds));
        }
        400 => return Ok(verdict(Verdict::NoTools, seconds)),
        404 => return Ok(verdict(Verdict::NotFound, seconds)),
        _ => return Ok(verdict(Verdict::Stopped, seconds)),
    }
    // Built now, so a thinking setting the app refused for the first question stays off.
    let (_, start) = check_bodies(app, model_id);
    let answer = match ask(&start, START_WAIT) {
        Ok(answer) => answer,
        Err(failure) => return Ok(verdict(failed(failure), seconds)),
    };
    let value: Value = serde_json::from_slice(&answer.1).unwrap_or(Value::Null);
    let said = value["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("");
    if answer.0 != 200 {
        let refused = refused_as_too_long(&answer.1);
        return Ok(verdict(
            if refused {
                Verdict::SmallContext
            } else {
                Verdict::Stopped
            },
            seconds,
        ));
    }
    if !said.to_ascii_uppercase().contains(CHECK_WORD) {
        // A lookup instead of the word says nothing about the room (review M2).
        if called_lookup(&value) {
            return Ok(verdict(Verdict::LookupInstead, seconds));
        }
        if cut_off(&value) {
            return Ok(verdict(Verdict::ThinksTooLong, seconds));
        }
        // Too little room for the whole question is the likely cause unless the app says the model had enough.
        let room =
            room_wait(started.elapsed()).and_then(|wait| loaded_room(app, model_id, http, wait));
        let lost = if room.is_some_and(|room| room >= CONTEXT_NEEDED) {
            Verdict::LostStart
        } else {
            Verdict::SmallContext
        };
        return Ok(verdict(lost, seconds));
    }
    // It passed. The question fit, but if the app gave the model less room than a larger church's question needs, that
    // one would be cut without a word: one short GET for the room, within the three minutes (B-2).
    let room = room_wait(started.elapsed()).and_then(|wait| loaded_room(app, model_id, http, wait));
    if model::save_local_checked(dir, &app.base(), model_id, clock(), choices)?.is_none() {
        return Ok(verdict(Verdict::ChoiceChanged, seconds));
    }
    // The caller adds the status as `model_status` gives it.
    Ok(LocalCheck {
        small_room: room.is_some_and(|room| room < CONTEXT_NEEDED),
        ..verdict(Verdict::Answers, seconds)
    })
}

#[cfg(test)]
#[path = "local_ai_tests.rs"]
mod tests;
