//! AI on this Mac for the onboarding's AI screens (spec S9; contract N6): what Ollama or LM Studio has, opening the
//! app, "Check that it answers", and "Download and set up" with its progress, Stop and removal (core
//! `local_models`). Every request goes to 127.0.0.1 only (core `local_ai`).
use ozzie_native_auth::local_ai::{self, App, LocalCheck, LocalFind, NativeLocalHttp};
use ozzie_native_auth::local_models::{self, NativePull, Progress, Refusal, Removal};
use ozzie_native_auth::model::ModelError;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::Emitter;

/// What is on this Mac now: both apps, their models with sizes, the recommendation for this Mac's memory, and the
/// three models Ozzie can download and set up, with the free space where Ollama keeps models.
#[tauri::command]
pub async fn local_ai_find(tauri_app: tauri::AppHandle) -> Result<LocalFind, ModelError> {
    tauri::async_runtime::spawn_blocking(move || {
        let http = NativeLocalHttp::new(local_ai::FIND_WAIT)?;
        Ok(found_now(&tauri_app, &http))
    })
    .await
    .map_err(|_| ModelError::ProviderFailure)?
}
/// Finding, with the free space and what Ozzie downloaded itself, that record checked against Ollama's list (none when
/// the app's data folder can't be read).
fn found_now(tauri_app: &tauri::AppHandle, http: &NativeLocalHttp) -> LocalFind {
    let (memory, free) = (local_ai::memory_bytes(), local_models::ollama_free_bytes());
    let mut found = match crate::model_dir(tauri_app) {
        Ok(dir) => local_models::find(&dir, http, local_ai::installed_on_this_mac, memory, free),
        Err(_) => local_ai::find_with(
            http,
            local_ai::installed_on_this_mac,
            memory,
            free,
            &local_models::Kept::default(),
        ),
    };
    // An app on this Mac whose server isn't answering: is its own program running (still starting, or stuck)?
    for app in found.apps.iter_mut().filter(|a| a.installed && !a.running) {
        app.open = local_ai::app_running(app.app);
    }
    found
}

/// The one "Download and set up" at a time (contract N6): what it is doing now, or how the last one ended, and its
/// Stop. Held for as long as Ozzie runs, so a window closed and opened again can ask where it got to.
#[derive(Clone, Default)]
pub struct ModelJob {
    now: Arc<Mutex<Option<Progress>>>,
    cancel: Arc<AtomicBool>,
    busy: Arc<AtomicBool>,
}
/// The event the page hears each step and the bytes on (`Progress`: numbers and closed words only).
pub const MODEL_EVENT: &str = "ozzie:local-model";
impl ModelJob {
    fn tell(&self, app: &tauri::AppHandle, progress: &Progress) {
        self.keep(progress);
        let _ = app.emit(MODEL_EVENT, progress);
    }
    fn keep(&self, progress: &Progress) {
        *self.now.lock().unwrap_or_else(|e| e.into_inner()) = Some(progress.clone());
    }
}
/// Held by the job's thread: however the thread ends, the one-at-a-time slot is freed, so a panic can't leave every
/// later download refused as busy; and a thread that ends in a panic tells the page the job `failed`, so it isn't left
/// showing it at work (review L-4).
struct Release<'a> {
    job: &'a ModelJob,
    model: &'a str,
    tell: &'a dyn Fn(&Progress),
}
impl Drop for Release<'_> {
    fn drop(&mut self) {
        if std::thread::panicking() {
            let last = self.job.now.lock().unwrap_or_else(|e| e.into_inner()).clone();
            let mut ended = last
                .filter(|p| p.model == self.model)
                .unwrap_or_else(|| Progress::starting(self.model));
            if ended.end.is_none() {
                ended.end = Some(local_models::End::Failed);
                ended.check = None;
                self.job.keep(&ended);
                // Telling must not panic again while unwinding.
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| (self.tell)(&ended)));
            }
        }
        self.job.busy.store(false, Ordering::SeqCst);
    }
}
/// The job's own thread: `body` runs with the one-at-a-time slot held by a `Release`, however it ends (a panic
/// included), and its ending is told. The command takes the slot before it calls this (review L-3: the guard lives here,
/// where a test reaches it, not only in the command).
fn spawn_job(
    job: &ModelJob,
    id: String,
    tell: impl Fn(&Progress) + Send + 'static,
    body: impl FnOnce(&ModelJob, &str, &dyn Fn(&Progress)) -> Progress + Send + 'static,
) -> std::io::Result<std::thread::JoinHandle<()>> {
    let job = job.clone();
    std::thread::Builder::new()
        .name("ozzie-local-model".into())
        .spawn(move || {
            let _release = Release {
                job: &job,
                model: &id,
                tell: &tell,
            };
            let end = body(&job, &id, &tell);
            tell(&end);
        })
}
/// Refusals and endings the page reads as closed words.
fn refusal_word(refusal: Refusal) -> &'static str {
    match refusal {
        Refusal::NotInCatalogue => "not-in-catalogue",
        Refusal::NotOffered => "not-offered",
        Refusal::NotRunning => "not-running",
        Refusal::TooBig => "too-big",
        Refusal::NoRoom => "no-room",
        Refusal::Busy => "busy",
    }
}

/// "Download and set up" / "Set up": `model` must be one of the catalogue's three ids. Answers at once with the first
/// step, or refuses (`busy`, `not-running`, `too-big`, `no-room`, `not-in-catalogue`, `not-offered`); the rest happens on its own
/// thread, told by `ozzie:local-model`, and survives the window closing.
#[tauri::command]
pub async fn local_model_download(
    tauri_app: tauri::AppHandle,
    names: tauri::State<'_, crate::SessionNames>,
    job: tauri::State<'_, ModelJob>,
    model: String,
) -> Result<Progress, &'static str> {
    let id = local_models::entry(&model)
        .map(|(_, m)| m.id.clone())
        .ok_or(refusal_word(Refusal::NotInCatalogue))?;
    let job = job.inner().clone();
    if job.busy.swap(true, Ordering::SeqCst) {
        return Err(refusal_word(Refusal::Busy));
    }
    let names = names.inner().snapshot();
    let checked = {
        let (id, tauri_app) = (id.clone(), tauri_app.clone());
        tauri::async_runtime::spawn_blocking(move || {
            let dir = crate::model_dir(&tauri_app).map_err(|_| Refusal::NotRunning)?;
            let http = NativeLocalHttp::new(local_ai::ANSWER_WAIT).map_err(|_| Refusal::NotRunning)?;
            local_models::may_start(&found_now(&tauri_app, &http), &id)?;
            // The choice of AI as the person pressed: one made at any time since wins over this check (review M-2).
            let choices = ozzie_native_auth::model::route_generation(&dir);
            Ok((dir, http, choices))
        })
        .await
        .unwrap_or(Err(Refusal::NotRunning))
    };
    let (dir, http, choices) = match checked {
        Ok(ready) => ready,
        Err(refusal) => {
            job.busy.store(false, Ordering::SeqCst);
            return Err(refusal_word(refusal));
        }
    };
    job.cancel.store(false, Ordering::SeqCst);
    let first = Progress::starting(&id);
    job.tell(&tauri_app, &first);
    let worker = job.clone();
    let tell = move |progress: &Progress| worker.tell(&tauri_app, progress);
    let started = spawn_job(&job, id, tell, move |job, id, tell| {
        local_models::run(
            &local_models::Job {
                dir: &dir,
                id,
                names: &names,
                http: &http,
                pull: &NativePull,
                clock: &ozzie_native_auth::sunday_check::unix_ms,
                cancel: &job.cancel,
                choices,
                stall: local_models::STALL_WAIT,
            },
            &mut |progress| tell(progress),
        )
    });
    if started.is_err() {
        job.busy.store(false, Ordering::SeqCst);
        return Err(refusal_word(Refusal::NotRunning));
    }
    Ok(first)
}
/// Where the download and set-up got to, or how the last one ended; null when none has run since Ozzie opened.
#[tauri::command]
pub fn local_model_progress(job: tauri::State<'_, ModelJob>) -> Option<Progress> {
    job.now.lock().unwrap_or_else(|e| e.into_inner()).clone()
}
/// "Stop the download": the connection to Ollama closes within a second and the job ends `cancelled`. True when one
/// was under way.
#[tauri::command]
pub fn local_model_cancel(job: tauri::State<'_, ModelJob>) -> bool {
    let running = job.busy.load(Ordering::SeqCst);
    if running {
        job.cancel.store(true, Ordering::SeqCst);
    }
    running
}
/// "Remove this model from this Mac", after the page's confirm: Ozzie's copy, and the model only when Ozzie downloaded
/// it. Refused (`busy`) while a download runs; when AI on this Mac was that model, no AI is chosen (`route_cleared`).
#[tauri::command]
pub async fn local_model_remove(
    tauri_app: tauri::AppHandle,
    job: tauri::State<'_, ModelJob>,
    model: String,
) -> Result<Removal, &'static str> {
    let id = local_models::entry(&model)
        .map(|(_, m)| m.id.clone())
        .ok_or(refusal_word(Refusal::NotInCatalogue))?;
    let job = job.inner().clone();
    if job.busy.swap(true, Ordering::SeqCst) {
        return Err(refusal_word(Refusal::Busy));
    }
    let removed = tauri::async_runtime::spawn_blocking(move || {
        let dir = crate::model_dir(&tauri_app).map_err(|_| "failed")?;
        let http = NativeLocalHttp::new(local_models::SETUP_WAIT).map_err(|_| "failed")?;
        local_models::remove(&dir, &id, &http).map_err(|_| "failed")
    })
    .await
    .unwrap_or(Err("failed"));
    job.busy.store(false, Ordering::SeqCst);
    removed
}

/// "Open Ollama" / "Open LM Studio": `/usr/bin/open` with the app's exact path, Ollama with its own `hidden` argument
/// (`local_ai::open_args`), only when it is installed. The page then waits for its server itself.
#[tauri::command]
pub async fn local_ai_open(app: String) -> Result<(), &'static str> {
    let app = App::parse(&app).ok_or("unknown-app")?;
    let at = local_ai::installed_at(app).ok_or("not-installed")?;
    tauri::async_runtime::spawn_blocking(move || {
        let opened = std::process::Command::new("/usr/bin/open")
            .args(local_ai::open_args(app, &at))
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
        if opened.is_ok_and(|status| status.success()) {
            Ok(())
        } else {
            Err("not-installed")
        }
    })
    .await
    .map_err(|_| "not-installed")?
}

/// "Check that it answers": on `answers` the local route is saved with this app and model, checked now, and the
/// status comes back as `model_status` gives it.
#[tauri::command]
pub async fn local_ai_check(
    tauri_app: tauri::AppHandle,
    names: tauri::State<'_, crate::SessionNames>,
    app: String,
    model: String,
) -> Result<LocalCheck, ModelError> {
    let app = App::parse(&app).ok_or(ModelError::InvalidRequest)?;
    let names = names.inner().snapshot();
    tauri::async_runtime::spawn_blocking(move || {
        let dir = crate::model_dir(&tauri_app)?;
        let http = NativeLocalHttp::new(local_ai::ANSWER_WAIT)?;
        let mut checked = local_ai::check(
            &dir,
            app,
            &model,
            &names,
            &http,
            &ozzie_native_auth::sunday_check::unix_ms,
        )?;
        if checked.verdict == local_ai::Verdict::Answers {
            checked.status = Some(crate::full_status(&dir));
        }
        Ok(checked)
    })
    .await
    .map_err(|_| ModelError::ProviderFailure)?
}

/// Ozzie's window to the front again: after "Open Ollama", once Ollama answers, in case its app came in front. When
/// macOS keeps Ollama in front, `ask_to_front` opens Ozzie's own app.
#[tauri::command]
pub fn come_forward(app: tauri::AppHandle) {
    use tauri::Manager;
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_focus();
    }
    crate::always_on::ask_to_front(&app);
}

/// Ozzie's AI card (spec S6): open for sign-up, with the price and allowance in ozzie.church's own words, or
/// closed / unreachable (the card is disabled). Never cached, so a closed offer is never shown as open.
#[tauri::command]
pub async fn managed_offer() -> ozzie_native_auth::hosted::Offer {
    use ozzie_native_auth::hosted::{self, HostedConfig, Offer};
    tauri::async_runtime::spawn_blocking(|| hosted::offer(&HostedConfig::current()))
        .await
        .unwrap_or(Offer {
            open: false,
            plan: None,
            price_text: None,
            answers_text: None,
            reason: Some("unreachable"),
        })
}

/// "Payment received. Turning on Ozzie's AI…" (spec S10c): a fresh reading of the account, for the page's
/// five-second poll. `not-configured` when this Mac isn't connected or nothing could be read.
#[tauri::command]
pub async fn managed_account_now(
    app: tauri::AppHandle,
) -> Result<ozzie_native_auth::hosted::Account, ModelError> {
    use ozzie_native_auth::hosted::{self, AccountState, HostedConfig};
    use ozzie_native_auth::model::KeychainKeys;
    tauri::async_runtime::spawn_blocking(move || {
        let dir = crate::model_dir(&app)?;
        match hosted::account_now(
            &HostedConfig::current(),
            &KeychainKeys,
            &dir,
            ozzie_native_auth::sunday_check::unix_ms(),
        ) {
            AccountState::Known(account) => Ok(account),
            _ => Err(ModelError::NotConfigured),
        }
    })
    .await
    .map_err(|_| ModelError::ProviderFailure)?
}

/// Whether macOS lets Ozzie show notices. The notification plugin says "granted" on every Mac whatever System
/// Settings say, so Ozzie can't tell from here and says so: always `unknown` on this build, never a false "allowed".
#[tauri::command]
pub fn notification_permission() -> &'static str {
    "unknown"
}

/// "Open Notifications settings" (Check my setup's fix): System Settings' Notifications pane, a fixed address.
#[tauri::command]
pub async fn open_notification_settings() -> Result<(), &'static str> {
    tauri::async_runtime::spawn_blocking(|| {
        let opened = std::process::Command::new("/usr/bin/open")
            .arg("x-apple.systempreferences:com.apple.Notifications-Settings.extension")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
        if opened.is_ok_and(|status| status.success()) {
            Ok(())
        } else {
            Err("settings-unavailable")
        }
    })
    .await
    .map_err(|_| "settings-unavailable")?
}

/// "Check my setup" (spec §4.3; contract): a closed verdict per row and a report of codes only.
#[derive(serde::Serialize, Debug, PartialEq, Eq)]
pub struct SetupCheck {
    /// "connected" | "sign-in-again" | "unreachable" | "not-connected"
    pub planning_center: &'static str,
    /// The church's name for the row, display only; never in `report`.
    pub church: Option<String>,
    pub checked_at_ms: Option<u64>,
    /// "watching" | "passed" | "waiting" | "none" | "unknown"
    pub service: &'static str,
    /// "ready" | "none" | "no-key" | "not-checked" | "not-on-this-mac" | "month-limit" | "paused" | "not-connected"
    /// | "reconnect"
    pub ai: &'static str,
    /// "managed" | "own" | "local" | "none"
    pub ai_route: &'static str,
    pub ai_provider: Option<&'static str>,
    /// "allowed" | "denied" | "not-asked" | "unknown"
    pub notices: &'static str,
    /// "on" | "off" | "unknown"
    pub start_with_mac: &'static str,
    pub report: String,
}
/// The facts a report is made from: codes, versions and counts only.
pub struct ReportFacts<'a> {
    pub version: &'a str,
    pub macos: &'a str,
    /// The page's chip word ("apple-m2-pro", "intel"), when it could be read (`chip_word`).
    pub chip: Option<String>,
    /// None when this Mac's memory couldn't be read: the line is left out, never "0".
    pub memory_gb: Option<u64>,
    pub local_ai_found: Option<bool>,
    pub scopes: Option<String>,
}
/// "Copy a report": plain text with each row's verdict as a fixed code word, under the page's own keys
/// (setup-report.ts FIELDS; review L5), so none is dropped there. Never a key, the church's name or number, a plan
/// title, a team or a person (spec P6), and never another company's typed address (it can name the church): only
/// "other" as the AI company.
pub fn report(check: &SetupCheck, facts: &ReportFacts) -> String {
    let code = |text: &str| -> String {
        text.chars()
            .filter(|c| c.is_ascii_alphanumeric() || "._-+:".contains(*c))
            .take(80)
            .collect()
    };
    let company = match (check.ai_route, check.ai_provider) {
        (_, Some(provider)) => provider,
        ("own", None) => "other",
        _ => "none",
    };
    let mut lines = vec![
        format!("app: {}", code(facts.version)),
        format!("macos: {}", code(facts.macos)),
    ];
    if let Some(chip) = &facts.chip {
        lines.push(format!("chip: {}", code(chip)));
    }
    if let Some(gb) = facts.memory_gb {
        lines.push(format!("memory-gb: {gb}"));
    }
    lines.extend([
        format!("planning-center: {}", check.planning_center),
        format!("service: {}", check.service),
        format!("ai: {}", check.ai),
        format!("ai-route: {}", check.ai_route),
        format!("ai-company: {company}"),
        format!(
            "local-ai: {}",
            match facts.local_ai_found {
                Some(true) => "yes",
                Some(false) => "no",
                None => "unknown",
            }
        ),
        format!("notices: {}", check.notices),
        format!("start-with-mac: {}", check.start_with_mac),
        format!(
            "scopes: {}",
            facts
                .scopes
                .as_deref()
                .map(code)
                .unwrap_or_else(|| "none".into())
        ),
    ]);
    lines.join("\n")
}
/// The page's chip word from `machdep.cpu.brand_string`: "Apple M2 Pro" is "apple-m2-pro", an Intel one "intel".
pub fn chip_word(brand: &str) -> Option<String> {
    let word = brand
        .trim()
        .to_ascii_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("-");
    if word.contains("intel") {
        return Some("intel".into());
    }
    let rest = word.strip_prefix("apple-m")?;
    let (number, tier) = rest
        .split_once('-')
        .map_or((rest, None), |(n, t)| (n, Some(t)));
    let ok = (1..=2).contains(&number.len())
        && number.bytes().all(|b| b.is_ascii_digit())
        && tier.is_none_or(|t| ["pro", "max", "ultra"].contains(&t));
    ok.then_some(word)
}
/// The watched service's row (review L7): "passed" only when the plan's own date is before every upcoming plan, so a
/// deleted plan, or one beyond the first twelve upcoming, is "unknown", never "passed".
pub fn service_row(
    upcoming: &[(String, String)],
    plan_id: &str,
    plan_date: Option<&str>,
) -> &'static str {
    if upcoming.is_empty() {
        return "waiting";
    }
    if upcoming.iter().any(|(id, _)| id == plan_id) {
        return "watching";
    }
    let first = upcoming
        .iter()
        .map(|(_, date)| date.get(..10).unwrap_or(""))
        .min()
        .unwrap_or("");
    match plan_date.filter(|d| d.len() == 10 && ozzie_native_auth::civil::day_of_text(d).is_some())
    {
        Some(date) if date < first => "passed",
        _ => "unknown",
    }
}
/// The AI row from the model status as `model_status` gives it.
fn ai_row(status: &ozzie_native_auth::model::ModelStatus) -> &'static str {
    let paused = status
        .account
        .as_ref()
        .is_some_and(|a| matches!(a.warning, Some(ozzie_native_auth::hosted::Warning::Paused)));
    match status.setup {
        "ready" if status.route == "managed" && paused => "paused",
        "ready" => "ready",
        "no-route" => "none",
        "no-key" | "own-key-not-bound" => "no-key",
        "not-checked" => "not-checked",
        // AI on this Mac whose model runs elsewhere (Ollama's cloud models): never used.
        "not-on-this-mac" => "not-on-this-mac",
        "month-limit" => "month-limit",
        "not-connected" => "not-connected",
        _ => "reconnect",
    }
}

/// Check my setup: Planning Center (the saved sign-in as checked, and one read of the watched service's upcoming
/// plans when it is chosen), AI (as `model_status` says), notices and starting with the Mac, and the report.
#[tauri::command]
pub async fn setup_check(
    app: tauri::AppHandle,
    consumer: tauri::State<'_, crate::Consumer>,
    checks: tauri::State<'_, crate::SundayChecks>,
    service_type_id: Option<String>,
    plan_id: Option<String>,
    // The watched plan's local date (`YYYY-MM-DD`), so "passed" is said only when it is true (review L7).
    plan_date: Option<String>,
) -> Result<SetupCheck, &'static str> {
    use ozzie_native_auth::oauth::{AuthError, ConnectionState};
    let consumer = consumer.inner().clone();
    let checks = checks.inner().clone();
    let start_with_mac = match crate::always_on::autostart_get(app.clone()) {
        Ok(true) => "on",
        Ok(false) => "off",
        Err(_) => "unknown",
    };
    tauri::async_runtime::spawn_blocking(move || {
        let status = consumer.0.current().and_then(|auth| auth.status().ok());
        let (mut planning_center, church, checked_at_ms, scopes) = match &status {
            Some(s) if s.state == ConnectionState::Connected => (
                "connected",
                s.organization_name.clone(),
                s.checked_at_ms,
                s.scopes.map(|scopes| scopes.label()),
            ),
            Some(s) if s.problem == Some(AuthError::ProviderFailure) => {
                ("unreachable", None, None, None)
            }
            Some(s)
                if matches!(
                    s.problem,
                    Some(AuthError::InvalidToken | AuthError::OrganizationUnverified)
                ) =>
            {
                ("sign-in-again", None, None, None)
            }
            _ => ("not-connected", None, None, None),
        };
        let service = match (service_type_id, plan_id, planning_center) {
            (Some(service_type), Some(plan), "connected") => {
                let read = crate::picker_turn(&checks).and_then(|_turn| {
                    crate::read_renewing(&consumer, |auth| {
                        ozzie_native_auth::sunday_picker::upcoming_plans(
                            auth,
                            &service_type,
                            &std::sync::atomic::AtomicBool::new(false),
                        )
                    })
                });
                match read {
                    Ok(Ok(plans)) => {
                        let upcoming: Vec<(String, String)> = plans
                            .items
                            .into_iter()
                            .map(|p| (p.id, p.sort_date))
                            .collect();
                        service_row(&upcoming, &plan, plan_date.as_deref())
                    }
                    Ok(Err(ozzie_native_auth::source::SourceError::ProviderFailure)) => {
                        planning_center = "unreachable";
                        "unknown"
                    }
                    _ => "unknown",
                }
            }
            (Some(_), Some(_), _) => "unknown",
            _ => "none",
        };
        let dir = crate::model_dir(&app).map_err(|_| "unavailable")?;
        let model = crate::full_status(&dir);
        let memory = local_ai::memory_bytes();
        let found = NativeLocalHttp::new(local_ai::FIND_WAIT)
            .ok()
            .map(|http| local_ai::find(&http, local_ai::installed_on_this_mac, memory))
            .map(|found| found.apps.iter().any(|a| a.running));
        let brand = std::process::Command::new("/usr/sbin/sysctl")
            .args(["-n", "machdep.cpu.brand_string"])
            .output()
            .ok()
            .and_then(|out| String::from_utf8(out.stdout).ok())
            .unwrap_or_default();
        let mut check = SetupCheck {
            planning_center,
            church,
            checked_at_ms,
            service,
            ai: ai_row(&model),
            ai_route: model.route,
            ai_provider: model.provider,
            notices: notification_permission(),
            start_with_mac,
            report: String::new(),
        };
        let macos = std::process::Command::new("/usr/bin/sw_vers")
            .arg("-productVersion")
            .output()
            .ok()
            .and_then(|out| String::from_utf8(out.stdout).ok())
            .unwrap_or_default();
        check.report = report(
            &check,
            &ReportFacts {
                version: env!("CARGO_PKG_VERSION"),
                macos: macos.trim(),
                chip: chip_word(&brand),
                memory_gb: (memory > 0).then(|| memory.div_ceil(1_073_741_824)),
                local_ai_found: found,
                scopes,
            },
        );
        Ok(check)
    })
    .await
    .map_err(|_| "unavailable")?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_setup_report_carries_codes_only_never_a_church_a_key_a_plan_or_a_person() {
        let check = SetupCheck {
            planning_center: "connected",
            church: Some("Riley Thornbury's Fictional Church 513367".into()),
            checked_at_ms: Some(1_763_400_000_000),
            service: "watching",
            ai: "ready",
            ai_route: "own",
            ai_provider: None,
            notices: "unknown",
            start_with_mac: "on",
            report: String::new(),
        };
        let text = report(
            &check,
            &ReportFacts {
                version: "0.2.1",
                macos: "26.1",
                chip: chip_word("Apple M2 Pro"),
                memory_gb: Some(16),
                local_ai_found: Some(true),
                scopes: Some("services+check-ins".into()),
            },
        );
        assert_eq!(
            text,
            "app: 0.2.1\nmacos: 26.1\nchip: apple-m2-pro\nmemory-gb: 16\nplanning-center: connected\nservice: watching\nai: ready\nai-route: own\nai-company: other\nlocal-ai: yes\nnotices: unknown\nstart-with-mac: on\nscopes: services+check-ins"
        );
        for absent in [
            "Riley",
            "Thornbury",
            "Fictional Church",
            "513367",
            "1763400000000",
        ] {
            assert!(!text.contains(absent), "{absent}");
        }
        // The report has no field for a plan, a team, a person or a key: built from codes, never from the page.
        let source = include_str!("ai_setup.rs");
        let builder =
            &source[source.find("pub fn report(").unwrap()..source.find("/// The AI row").unwrap()];
        for field in ["church", "plan_id", "service_type", "title", "names", "key"] {
            assert!(!builder.contains(&format!("check.{field}")), "{field}");
        }
    }

    #[test]
    fn review_l5_l7_the_report_uses_the_pages_keys_and_passed_is_said_only_when_true() {
        // Another company's typed address never reaches the report (it can name the church).
        let source = include_str!("ai_setup.rs")
            .split("#[cfg(test)]")
            .next()
            .unwrap();
        assert!(!source.contains("ai-host") && !source.contains("host_key_of"));
        for (brand, word) in [
            ("Apple M1", Some("apple-m1")),
            ("Apple M3 Max", Some("apple-m3-max")),
            ("Intel(R) Core(TM) i7-8700B CPU @ 3.20GHz", Some("intel")),
            ("", None),
            ("Apple M2 Turbo", None),
        ] {
            assert_eq!(chip_word(brand).as_deref(), word, "{brand}");
        }
        let upcoming = vec![
            ("93000003".to_string(), "2026-11-25T18:30:00Z".to_string()),
            ("93000004".to_string(), "2026-12-02T18:30:00Z".to_string()),
        ];
        assert_eq!(service_row(&upcoming, "93000003", None), "watching");
        assert_eq!(
            service_row(&upcoming, "93000001", Some("2026-11-18")),
            "passed"
        );
        // Deleted, or beyond the twelve upcoming read, or no date given: not known to have passed.
        assert_eq!(
            service_row(&upcoming, "93000009", Some("2026-12-30")),
            "unknown"
        );
        assert_eq!(service_row(&upcoming, "93000001", None), "unknown");
        assert_eq!(
            service_row(&upcoming, "93000001", Some("Nov 18")),
            "unknown"
        );
        assert_eq!(service_row(&[], "93000001", Some("2026-11-18")), "waiting");
    }

    #[test]
    fn ai_on_this_mac_whose_model_runs_elsewhere_is_its_own_row_never_reconnect() {
        // A saved choice naming one of Ollama's cloud models (2026-11-19): the status says so, and Check my setup's row
        // says it in its own word, never Ozzie's AI's "reconnect".
        let dir = std::env::temp_dir().join(format!("ozzie-ai-row-{}-{}", std::process::id(), ozzie_native_auth::sunday_check::unix_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let saved = serde_json::json!({"route": "local", "base_url": "http://127.0.0.1:11434/v1", "model": "gpt-oss:120b-cloud", "checked_at_ms": 1});
        std::fs::write(dir.join("model.json"), saved.to_string()).unwrap();
        let status = ozzie_native_auth::model::status(&dir, &ozzie_native_auth::model::KeychainKeys);
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!((status.route, status.setup, status.configured), ("local", "not-on-this-mac", false));
        assert_eq!(ai_row(&status), "not-on-this-mac");
        let page = include_str!("../../src/onboarding-bridge.ts");
        assert!(page.contains(r#""not-on-this-mac", "month-limit", "paused", "not-connected", "reconnect"] as const) ?? "unknown""#));
    }

    #[test]
    fn notices_are_never_reported_allowed_from_a_constant() {
        assert_eq!(notification_permission(), "unknown");
    }

    #[test]
    fn review_l4_a_job_thread_that_panics_frees_the_slot_and_says_it_failed() {
        let job = ModelJob::default();
        job.busy.store(true, Ordering::SeqCst);
        let told: Mutex<Vec<Progress>> = Mutex::new(Vec::new());
        let ended = std::thread::scope(|scope| {
            scope
                .spawn(|| {
                    let tell = |p: &Progress| told.lock().unwrap().push(p.clone());
                    let _release = Release { job: &job, model: "qwen3:8b", tell: &tell };
                    let mut working = Progress::starting("qwen3:8b");
                    working.phase = local_models::Phase::Downloading;
                    job.keep(&working);
                    panic!("a fault inside the job");
                })
                .join()
        });
        assert!(ended.is_err());
        // The next download isn't refused as busy, and the page hears that this one failed where it was.
        assert!(!job.busy.load(Ordering::SeqCst));
        let last = job.now.lock().unwrap().clone().unwrap();
        assert_eq!((last.phase, last.end), (local_models::Phase::Downloading, Some(local_models::End::Failed)));
        assert_eq!(told.lock().unwrap().last().unwrap().end, Some(local_models::End::Failed));
        // A job that ends as it should frees the slot too, and tells nothing more than its own ending.
        job.busy.store(true, Ordering::SeqCst);
        let told: Mutex<Vec<Progress>> = Mutex::new(Vec::new());
        std::thread::scope(|scope| {
            scope.spawn(|| {
                let tell = |p: &Progress| told.lock().unwrap().push(p.clone());
                let _release = Release { job: &job, model: "qwen3:8b", tell: &tell };
            });
        });
        assert!(!job.busy.load(Ordering::SeqCst));
        assert!(told.lock().unwrap().is_empty());
    }

    #[test]
    fn review_l3_the_job_thread_itself_frees_the_slot_when_its_body_panics() {
        // The thread the command starts (`spawn_job`), not a guard built by hand: a body that panics still frees the
        // slot, so a second download isn't refused as busy, and the page hears the first one failed.
        let job = ModelJob::default();
        assert!(!job.busy.swap(true, Ordering::SeqCst));
        let told = Arc::new(Mutex::new(Vec::<Progress>::new()));
        let heard = told.clone();
        let thread = spawn_job(
            &job,
            "qwen3:8b".into(),
            move |p: &Progress| heard.lock().unwrap().push(p.clone()),
            |_, _, _| panic!("a fault inside the job"),
        )
        .unwrap();
        assert!(thread.join().is_err());
        assert!(!job.busy.swap(true, Ordering::SeqCst), "the second download was refused as busy");
        assert_eq!(told.lock().unwrap().last().unwrap().end, Some(local_models::End::Failed));
        // A body that ends tells its ending and frees the slot too.
        let told = Arc::new(Mutex::new(Vec::<Progress>::new()));
        let heard = told.clone();
        spawn_job(
            &job,
            "qwen3:8b".into(),
            move |p: &Progress| heard.lock().unwrap().push(p.clone()),
            |_, id, _| {
                let mut done = Progress::starting(id);
                done.end = Some(local_models::End::Done);
                done
            },
        )
        .unwrap()
        .join()
        .unwrap();
        assert!(!job.busy.load(Ordering::SeqCst));
        assert_eq!(told.lock().unwrap().last().unwrap().end, Some(local_models::End::Done));
    }

    #[test]
    fn a_download_refused_says_the_cores_own_closed_word() {
        for refusal in [
            Refusal::NotInCatalogue,
            Refusal::NotOffered,
            Refusal::NotRunning,
            Refusal::TooBig,
            Refusal::NoRoom,
            Refusal::Busy,
        ] {
            assert_eq!(
                serde_json::to_value(refusal).unwrap(),
                refusal_word(refusal),
                "{refusal:?}"
            );
        }
        // The event the page listens on, and the page's own copy of its name.
        let page = include_str!("../../src/onboarding-bridge.ts");
        assert!(page.contains(&format!("\"{MODEL_EVENT}\"")));
    }
}
