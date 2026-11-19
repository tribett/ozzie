//! Getting Ollama itself, for AI on this Mac (spec S9c; contract N6 "Ozzie gets Ollama"; core `ollama_install`):
//! the one job at a time with its progress event and Stop, showing a checked app in Finder when Applications needs a
//! password, and what Ozzie did, for What happened and Settings. Nothing starts until the person presses "Download
//! Ollama and set it up"; nothing here asks for a password.
use ozzie_native_auth::local_ai::{self, App, NativeLocalHttp};
use ozzie_native_auth::ollama_install::{self as ollama, Done, End, Progress, Refusal};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};

/// The one job: what it is doing now, or how the last one ended, and its Stop. Held for as long as Ozzie runs, so a
/// window closed and opened again can ask where it got to. Quitting Ozzie ends the download with it, and the next
/// start removes what it left (`startup`).
#[derive(Clone, Default)]
pub struct OllamaJob {
    now: Arc<Mutex<Option<Progress>>>,
    cancel: Arc<AtomicBool>,
    busy: Arc<AtomicBool>,
}
/// The event the page hears each step and the bytes on (`Progress`: numbers and closed words only).
pub const OLLAMA_EVENT: &str = "ozzie:ollama-install";
impl OllamaJob {
    fn tell(&self, app: &tauri::AppHandle, progress: &Progress) {
        *self.now.lock().unwrap_or_else(|e| e.into_inner()) = Some(progress.clone());
        let _ = app.emit(OLLAMA_EVENT, progress);
    }
}
/// Held by the job's thread: however it ends, the one-at-a-time slot is freed, and a thread that ends in a panic tells
/// the page `failed` at the step it reached, so the page isn't left showing it at work.
struct Release<'a> {
    job: &'a OllamaJob,
    tell: &'a dyn Fn(&Progress),
}
impl Drop for Release<'_> {
    fn drop(&mut self) {
        if std::thread::panicking() {
            let last = self.job.now.lock().unwrap_or_else(|e| e.into_inner()).clone();
            let mut ended = last.unwrap_or_else(Progress::starting);
            if ended.end.is_none() {
                ended.end = Some(End::Failed);
                *self.job.now.lock().unwrap_or_else(|e| e.into_inner()) = Some(ended.clone());
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| (self.tell)(&ended)));
            }
        }
        self.job.busy.store(false, Ordering::SeqCst);
    }
}
/// The job's own thread: `body` runs with the slot held by a `Release`, however it ends, and its ending is told.
fn spawn_job(
    job: &OllamaJob,
    tell: impl Fn(&Progress) + Send + 'static,
    body: impl FnOnce(&OllamaJob, &dyn Fn(&Progress)) -> Progress + Send + 'static,
) -> std::io::Result<std::thread::JoinHandle<()>> {
    let job = job.clone();
    std::thread::Builder::new()
        .name("ozzie-ollama-install".into())
        .spawn(move || {
            let _release = Release { job: &job, tell: &tell };
            let end = body(&job, &tell);
            tell(&end);
        })
}
/// Refusals the page reads as closed words.
fn refusal_word(refusal: Refusal) -> &'static str {
    match refusal {
        Refusal::Busy => "busy",
        Refusal::TooSmall => "too-small",
        Refusal::AlreadyInstalled => "already-installed",
        Refusal::AlreadyRunning => "already-running",
        Refusal::Unavailable => "unavailable",
    }
}
/// Ozzie's caches folder, where the work happens.
fn caches(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_cache_dir().ok()
}

/// "Download Ollama and set it up": answers at once with the first step, or refuses (`busy`, `too-small`,
/// `already-installed`, `already-running`, `unavailable`); the rest happens on its own thread, told by
/// `ozzie:ollama-install`, and survives the window closing. Never on a Mac too small for every model Ozzie offers, never
/// over an Ollama that is installed or running (native looks again here, whatever the page showed).
#[tauri::command]
pub async fn ollama_install(app: tauri::AppHandle, job: tauri::State<'_, OllamaJob>) -> Result<Progress, &'static str> {
    let job = job.inner().clone();
    if job.busy.swap(true, Ordering::SeqCst) {
        return Err(refusal_word(Refusal::Busy));
    }
    let ready = {
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let caches = caches(&app).ok_or(Refusal::Unavailable)?;
            let data = crate::model_dir(&app).map_err(|_| Refusal::Unavailable)?;
            let http = NativeLocalHttp::new(local_ai::FIND_WAIT).map_err(|_| Refusal::Unavailable)?;
            let found = local_ai::find(&http, local_ai::installed_on_this_mac, local_ai::memory_bytes());
            ollama::may_start(&found)?;
            Ok((caches, data))
        })
        .await
        .unwrap_or(Err(Refusal::Unavailable))
    };
    let (caches, data) = match ready {
        Ok(ready) => ready,
        Err(refusal) => {
            job.busy.store(false, Ordering::SeqCst);
            return Err(refusal_word(refusal));
        }
    };
    job.cancel.store(false, Ordering::SeqCst);
    let first = Progress::starting();
    job.tell(&app, &first);
    let worker = job.clone();
    let tell = move |progress: &Progress| worker.tell(&app, progress);
    let started = spawn_job(&job, tell, move |job, tell| {
        let mut failed = Progress::starting();
        failed.end = Some(End::Failed);
        let (Some(fetch), Ok(http)) = (ollama::NativeFetch::new(), NativeLocalHttp::new(local_ai::FIND_WAIT)) else {
            return failed;
        };
        ollama::run(
            &ollama::Job {
                caches: &caches,
                data: &data,
                destination: Path::new(ollama::DESTINATION),
                policy: &ollama::Policy::official(),
                fetch: &fetch,
                unpack: &ollama::Unzip,
                verifier: &ollama::MacVerifier::OLLAMA,
                opener: &ollama::OpenApp,
                http: &http,
                free: &ozzie_native_auth::local_models::free_bytes_at,
                cancel: &job.cancel,
                clock: &ozzie_native_auth::sunday_check::unix_ms,
                waits: ollama::Waits::REAL,
            },
            &mut |progress| tell(progress),
        )
    });
    if started.is_err() {
        job.busy.store(false, Ordering::SeqCst);
        return Err(refusal_word(Refusal::Unavailable));
    }
    Ok(first)
}
/// Where getting Ollama got to, or how the last one ended; null when none has run since Ozzie opened.
#[tauri::command]
pub fn ollama_install_progress(job: tauri::State<'_, OllamaJob>) -> Option<Progress> {
    job.now.lock().unwrap_or_else(|e| e.into_inner()).clone()
}
/// "Stop the download": heard within a second; the partial file is deleted and nothing is installed. True when a job
/// was under way. Once the download is done (checking and installing take seconds), Stop isn't offered.
#[tauri::command]
pub fn ollama_install_cancel(job: tauri::State<'_, OllamaJob>) -> bool {
    let running = job.busy.load(Ordering::SeqCst);
    if running {
        job.cancel.store(true, Ordering::SeqCst);
    }
    running
}
/// "Show Ollama in Finder", after Applications needed a password: the checked app Ozzie kept in its own folder is
/// checked again and shown in Finder (`open -R` with that path), for the person to drag into Applications. Refused
/// `not-there` when none is kept, or when it no longer passes the check (it is then deleted).
#[tauri::command]
pub async fn ollama_reveal(app: tauri::AppHandle, job: tauri::State<'_, OllamaJob>) -> Result<(), &'static str> {
    // The slot is held while the kept app is checked and shown, so no job can replace it meanwhile (review, 2026-11-19).
    let job = job.inner().clone();
    if job.busy.swap(true, Ordering::SeqCst) {
        return Err("busy");
    }
    let shown = tauri::async_runtime::spawn_blocking(move || {
        let kept = ollama::kept_app(&caches(&app).ok_or("not-there")?);
        let is_dir = std::fs::symlink_metadata(&kept).is_ok_and(|m| m.file_type().is_dir());
        if !is_dir {
            return Err("not-there");
        }
        if ollama::Verifier::verify(&ollama::MacVerifier::OLLAMA, &kept).is_err() {
            let _ = std::fs::remove_dir_all(&kept);
            return Err("not-there");
        }
        let shown = std::process::Command::new("/usr/bin/open")
            .arg("-R")
            .arg(&kept)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
        if shown.is_ok_and(|s| s.success()) { Ok(()) } else { Err("finder-unavailable") }
    })
    .await
    .unwrap_or(Err("not-there"));
    job.busy.store(false, Ordering::SeqCst);
    shown
}
/// What Ozzie did, for What happened (each ending's time and closed word, newest last) and Settings (`installed_at_ms`:
/// when Ozzie installed the Ollama that is in Applications now; null when it didn't, or the person removed it).
#[derive(serde::Serialize)]
pub struct History {
    pub done: Vec<Done>,
    pub installed_at_ms: Option<u64>,
}
#[tauri::command]
pub async fn ollama_install_history(app: tauri::AppHandle) -> Result<History, &'static str> {
    tauri::async_runtime::spawn_blocking(move || {
        let data = crate::model_dir(&app).map_err(|_| "unavailable")?;
        Ok(History {
            done: ollama::history(&data),
            installed_at_ms: ollama::installed_by_ozzie(&data, Path::new(ollama::DESTINATION)),
        })
    })
    .await
    .map_err(|_| "unavailable")?
}
/// At every start: what a job left when Ozzie quit mid-way is removed (once it has been still for `CLEAN_SETTLED`, in
/// case unzip or spctl is still finishing there); the checked app kept for dragging stays until the next job, or until
/// Ollama is in an Applications folder (the person dragged it there).
/// It holds the one-at-a-time slot while it cleans, so a job pressed at that very moment is refused as busy instead of
/// having its new work folder removed under it.
pub fn startup(app: &tauri::AppHandle) {
    let Some(caches) = caches(app) else {
        return;
    };
    let job = app.state::<OllamaJob>().inner().clone();
    if job.busy.swap(true, Ordering::SeqCst) {
        return;
    }
    let cleaning = std::thread::Builder::new().name("ozzie-ollama-clean".into()).spawn({
        let job = job.clone();
        move || {
            ollama::clean(&caches, local_ai::installed_on_this_mac(App::Ollama), ollama::CLEAN_SETTLED);
            job.busy.store(false, Ordering::SeqCst);
        }
    });
    if cleaning.is_err() {
        job.busy.store(false, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_job_thread_that_panics_frees_the_slot_and_says_it_failed() {
        let job = OllamaJob::default();
        assert!(!job.busy.swap(true, Ordering::SeqCst));
        let told = Arc::new(Mutex::new(Vec::<Progress>::new()));
        let heard = told.clone();
        let thread = spawn_job(&job, move |p: &Progress| heard.lock().unwrap().push(p.clone()), |job, tell| {
            let mut at = Progress::starting();
            at.phase = ollama::Phase::Downloading;
            *job.now.lock().unwrap() = Some(at.clone());
            tell(&at);
            panic!("a fault inside the job")
        })
        .unwrap();
        assert!(thread.join().is_err());
        assert!(!job.busy.swap(true, Ordering::SeqCst), "the next press was refused as busy");
        let last = told.lock().unwrap().last().cloned().unwrap();
        assert_eq!((last.phase, last.end), (ollama::Phase::Downloading, Some(End::Failed)));
        job.busy.store(false, Ordering::SeqCst);
    }

    #[test]
    fn every_refusal_is_the_cores_own_closed_word_and_the_event_is_the_pages() {
        for refusal in [Refusal::Busy, Refusal::TooSmall, Refusal::AlreadyInstalled, Refusal::AlreadyRunning, Refusal::Unavailable] {
            assert_eq!(serde_json::to_value(refusal).unwrap(), refusal_word(refusal), "{refusal:?}");
        }
        let page = include_str!("../../src/onboarding-bridge.ts");
        assert!(page.contains(&format!("\"{OLLAMA_EVENT}\"")));
        // The reveal's own refusals are in the page's list too.
        for word in ["not-there", "finder-unavailable", "busy"] {
            assert!(page.contains(&format!("\"{word}\"")), "{word}");
        }
    }

    #[test]
    fn the_app_installs_only_into_applications_with_the_pinned_policy_and_the_real_verifier() {
        let code = include_str!("ollama_setup.rs").split("#[cfg(test)]").next().unwrap();
        assert_eq!(code.matches("ollama::run(").count(), 1);
        for wired in [
            "destination: Path::new(ollama::DESTINATION)",
            "policy: &ollama::Policy::official()",
            "verifier: &ollama::MacVerifier::OLLAMA",
            "waits: ollama::Waits::REAL",
        ] {
            assert!(code.contains(wired), "{wired}");
        }
        assert_eq!(ollama::DESTINATION, "/Applications");
        for never in ["sudo", "osascript", "AuthorizationExecute", "administrator privileges", "for_loopback_tests"] {
            assert!(!code.contains(never), "{never}");
        }
    }
}
