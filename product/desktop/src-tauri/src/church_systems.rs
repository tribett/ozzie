//! A church's other system (core/church-systems: B1 Church, Breeze, and Genesis for "Also read"), read-only, through
//! the page (the church-systems design note, section 6).
//!
//! - A key is taken in without the web view: "Paste my key" reads this Mac's clipboard once; the other way is Ozzie's
//!   own key window, a secure field that names where the key goes (key_sheet.rs `window::ask_with`). The key goes
//!   from AppKit to one check (the system's own key read, at its own host only) and, if that works, to this Mac's
//!   Keychain (one service per system, the church's id as the account). The page gets a closed word and the church's
//!   id and name; never the key. A key that worked is cleared from the clipboard if it is still there.
//! - Every other command takes the system and the church's id and reads that church's key from the Keychain itself,
//!   so a key saved for one church is only ever sent to that church's own host.
//! - Every read is a GET of the system's closed list (core/church-systems http.rs `allowed`); nothing here changes
//!   anything in any system.
//!
//! Each command's work is a plain function over the HTTP client, clock, Keychain and zone data, so the tests run it on
//! fixed fictional answers (church_systems_tests.rs).
use crate::key_sheet::{clipboard, window};
use ozzie_church_systems::capture::{ChurchChoice, Id, System, ZoneName};
use ozzie_church_systems::http::{Http, NativeHttp, ReadError};
use ozzie_church_systems::keys::{self, Key, KeyError};
use ozzie_church_systems::run::{Clock, Pacer, SystemClock};
use ozzie_church_systems::zones::{SystemZones, ZoneOffsets};
use ozzie_church_systems::{b1, breeze, church_address, genesis};
use ozzie_native_auth::credentials::{CredentialStore, StoreError};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use zeroize::Zeroizing;

/// What every church-system command shares: one clock and one pacer, so a Breeze key check, its list of services
/// and its check made one after another keep one gap and one count between them (Breeze's own limit); and whether a
/// key is being taken in now (one at a time).
#[derive(Clone, Default)]
pub struct ChurchSystems(Arc<Shared>);
#[derive(Default)]
struct Shared {
    clock: SystemClock,
    pacer: Pacer,
    connecting: AtomicBool,
    keychain: KeychainWatch,
    let_go: LetGo,
}

/// The churches whose key was forgotten while Ozzie runs (a disconnect, a switch, another church connected in its place).
/// A check of one that ends afterwards isn't saved, so nothing with its volunteers' names is written after its saved
/// checks are deleted; connecting that church again takes it back. Saving and letting go hold one lock, so a save under
/// way finishes first and the deletion that follows the forget removes it.
#[derive(Default)]
pub(crate) struct LetGo(std::sync::Mutex<std::collections::BTreeSet<(String, String)>>);
impl LetGo {
    fn lock(&self) -> std::sync::MutexGuard<'_, std::collections::BTreeSet<(String, String)>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
    pub(crate) fn let_go(&self, system: System, church: &str) {
        self.lock()
            .insert((system.word().to_owned(), church.to_owned()));
    }
    pub(crate) fn taken_back(&self, system: System, church: &str) {
        self.lock()
            .remove(&(system.word().to_owned(), church.to_owned()));
    }
    /// Runs `save` unless the church was let go of; returns whether it ran.
    pub(crate) fn save_unless_let_go(
        &self,
        system: System,
        church: &str,
        save: impl FnOnce(),
    ) -> bool {
        let held = self.lock();
        if held.contains(&(system.word().to_owned(), church.to_owned())) {
            return false;
        }
        save();
        drop(held);
        true
    }
    /// Runs `work` (deleting saved checks) while no save can start.
    pub(crate) fn while_held<T>(&self, work: impl FnOnce() -> T) -> T {
        let _held = self.lock();
        work()
    }
}

/// Keychain calls under way, so the page can say when macOS is asking the person about one. A Keychain call takes a
/// moment; one that takes seconds is waiting on macOS's own question (whether Ozzie may use an item another program
/// made, or the Mac's password for a locked Keychain), and nothing can end that wait but the person's answer.
#[derive(Default)]
pub(crate) struct KeychainWatch(
    std::sync::Mutex<(u64, std::collections::BTreeMap<u64, std::time::Instant>)>,
);
impl KeychainWatch {
    /// A call starts: its own number, to end it by.
    fn begin(&self) -> u64 {
        let mut w = self.0.lock().unwrap_or_else(|e| e.into_inner());
        w.0 += 1;
        let call = w.0;
        w.1.insert(call, std::time::Instant::now());
        call
    }
    fn end(&self, call: u64) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .1
            .remove(&call);
    }
    /// How long the oldest Keychain call still under way has waited, in milliseconds; None when none is.
    pub(crate) fn waiting_ms(&self) -> Option<u64> {
        let w = self.0.lock().unwrap_or_else(|e| e.into_inner());
        w.1.values()
            .map(|since| since.elapsed().as_millis() as u64)
            .max()
    }
}
/// A Keychain store whose every call is watched (KeychainWatch); it reads and writes exactly as the store it wraps.
pub(crate) struct Watched<'a, S: CredentialStore> {
    pub(crate) store: S,
    pub(crate) watch: &'a KeychainWatch,
}
impl<S: CredentialStore> Watched<'_, S> {
    fn around<T>(&self, call: impl FnOnce(&S) -> T) -> T {
        struct Ends<'b>(&'b KeychainWatch, u64);
        impl Drop for Ends<'_> {
            fn drop(&mut self) {
                self.0.end(self.1);
            }
        }
        let _ends = Ends(self.watch, self.watch.begin());
        call(&self.store)
    }
}
impl<S: CredentialStore> CredentialStore for Watched<'_, S> {
    fn put(&self, workspace: &str, organization: &str, value: &[u8]) -> Result<(), StoreError> {
        self.around(|s| s.put(workspace, organization, value))
    }
    fn get(&self, workspace: &str, organization: &str) -> Result<Option<Vec<u8>>, StoreError> {
        self.around(|s| s.get(workspace, organization))
    }
    fn delete(&self, workspace: &str, organization: &str) -> Result<(), StoreError> {
        self.around(|s| s.delete(workspace, organization))
    }
    fn accounts(&self) -> Result<Vec<(String, String)>, StoreError> {
        self.around(|s| s.accounts())
    }
}

/// A church a key opens: its id in that system and its name, when the system gave one (shown on this Mac only).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Church {
    pub id: String,
    pub name: Option<String>,
}
impl From<ChurchChoice> for Church {
    fn from(choice: ChurchChoice) -> Self {
        Church {
            id: choice.id.as_str().to_owned(),
            name: choice.name.map(|n| n.as_str().to_owned()),
        }
    }
}
/// How taking in a key, or checking a saved one, ended: "works" with the church, or one closed word.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Connected {
    pub outcome: &'static str,
    pub church: Option<Church>,
}
impl Connected {
    fn failed(outcome: &'static str) -> Connected {
        Connected {
            outcome,
            church: None,
        }
    }
    fn works(church: ChurchChoice) -> Connected {
        Connected {
            outcome: "works",
            church: Some(church.into()),
        }
    }
}
/// A service to watch: a B1 Church plan or a Breeze event, by its own calendar day.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Choice {
    pub id: String,
    /// `YYYY-MM-DD`, the system's own calendar day.
    pub day: String,
    pub name: Option<String>,
    /// B1 Church: whether the plan is shared with its volunteers yet; null elsewhere or when it couldn't be read.
    pub shared: Option<bool>,
    /// Breeze: when it starts on the church's clock, `HH:MM`; null for an event with no time of day, and for B1 Church.
    pub time: Option<String>,
    /// Breeze: how many people are listed on it, read only for the events on the soonest day when several share it
    /// (breeze.rs `MAX_PICK_COUNTS`); null where not read, and for B1 Church.
    pub people: Option<u32>,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Choices {
    pub outcome: &'static str,
    pub choices: Vec<Choice>,
}
/// A check: "ok" with the capture's JSON (core/src/church-systems/types.ts checks it again), or one closed word.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Checked {
    pub outcome: &'static str,
    pub capture: Option<String>,
}
/// A key saved on this Mac, from the Keychain's item attributes only (no key is read).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Saved {
    pub system: &'static str,
    pub church_id: String,
}

/// A system word from the page.
pub(crate) fn system_of(word: &str) -> Result<System, &'static str> {
    System::all()
        .into_iter()
        .find(|s| s.word() == word)
        .ok_or("unknown-system")
}
/// A key problem as its closed word.
pub(crate) fn key_word(error: KeyError) -> &'static str {
    match error {
        KeyError::Format => "format",
        KeyError::OtherSystem => "other-system",
        KeyError::Unsupported => "unsupported",
        KeyError::Locked => "locked",
        KeyError::Denied => "denied",
        KeyError::Unavailable => "unavailable",
        KeyError::InTheWay => "in-the-way",
    }
}
/// The church's address for `system` (B1 Church, Breeze), or `address` when it can't be one. Genesis needs none.
pub(crate) fn address_for(system: System, text: Option<&str>) -> Result<Option<Id>, &'static str> {
    match system {
        System::Genesis => Ok(None),
        _ => text
            .and_then(|t| church_address(system, t))
            .map(Some)
            .ok_or("address"),
    }
}
/// Where a key for `system` at `address` goes, as the key window says it.
pub(crate) fn destination(system: System, address: Option<&Id>) -> String {
    match (system, address) {
        (System::B1, _) => b1::HOST.to_owned(),
        (System::Breeze, Some(church)) => format!("{}.{}", church.as_str(), breeze::SUFFIX),
        (System::Breeze, None) => format!("your church's {} address", breeze::SUFFIX),
        (System::Genesis, _) => "the address Genesis publishes for its API".to_owned(),
    }
}
/// The key window's title and words.
pub(crate) fn window_words(system: System, address: Option<&Id>) -> (String, String) {
    let name = system.display_name();
    (
        format!("Paste your {name} API key"),
        format!(
            "Ozzie sends it only to {}, to read your church's {name} account. If it works, Ozzie keeps it in this Mac's Keychain. It is never shown again.",
            destination(system, address)
        ),
    )
}

/// Takes in `text` as `system`'s key: checks it at the church (`address`, for B1 Church and Breeze) with the system's
/// own key read and, if that works, saves it for that church.
#[allow(clippy::too_many_arguments)]
pub(crate) fn connect_with(
    system: System,
    address: Option<&Id>,
    text: &str,
    http: &dyn Http,
    clock: &dyn Clock,
    pacer: &Pacer,
    store: &dyn CredentialStore,
) -> Connected {
    if text.trim().is_empty() {
        return Connected::failed("empty");
    }
    let key = match Key::parse(system, text) {
        Ok(key) => key,
        Err(error) => return Connected::failed(key_word(error)),
    };
    let church = match (system, address) {
        (System::B1, Some(address)) => b1::connect(http, clock, &key, address),
        (System::Breeze, Some(church)) => {
            breeze::verify_key(http, clock, &key, church, Some(pacer))
        }
        (System::Genesis, _) => genesis::verify_key(http, clock, &key),
        _ => return Connected::failed("address"),
    };
    let church = match church {
        Ok(church) => church,
        Err(error) => return Connected::failed(error.word()),
    };
    if let Err(error) = keys::save(store, system, &church.id, &key) {
        return Connected::failed(key_word(error));
    }
    Connected::works(church)
}

/// The key saved for `church` in `system`, or the closed word for why there isn't one Ozzie can use.
fn saved_key(
    system: System,
    church: &Id,
    store: &dyn CredentialStore,
) -> Result<Key, &'static str> {
    match keys::read(store, system, church) {
        Ok(Some(key)) => Ok(key),
        Ok(None) => Err("no-key"),
        Err(error) => Err(key_word(error)),
    }
}
fn church_id(text: &str) -> Result<Id, &'static str> {
    Id::new(text).ok_or("bad-id")
}

/// "Check the connection": the saved key, checked again with the system's own key read.
pub(crate) fn verify_with(
    system: System,
    church: &str,
    http: &dyn Http,
    clock: &dyn Clock,
    pacer: &Pacer,
    store: &dyn CredentialStore,
) -> Connected {
    let church = match church_id(church) {
        Ok(id) => id,
        Err(word) => return Connected::failed(word),
    };
    let key = match saved_key(system, &church, store) {
        Ok(key) => key,
        Err(word) => return Connected::failed(word),
    };
    let checked = match system {
        System::B1 => b1::verify_key(http, clock, &key, &church),
        System::Breeze => breeze::verify_key(http, clock, &key, &church, Some(pacer)),
        // Genesis's key names its church: one saved for this church must still name it.
        System::Genesis => genesis::verify_key(http, clock, &key).and_then(|found| {
            if found.id == church {
                Ok(found)
            } else {
                Err(ReadError::KeyRefused)
            }
        }),
    };
    match checked {
        Ok(found) => Connected::works(found),
        Err(error) => Connected::failed(error.word()),
    }
}

/// The services to choose from: B1 Church's plans or Breeze's events, soonest first.
pub(crate) fn choices_with(
    system: System,
    church: &str,
    from: Option<&str>,
    http: &dyn Http,
    clock: &dyn Clock,
    pacer: &Pacer,
    store: &dyn CredentialStore,
) -> Choices {
    let none = |outcome| Choices {
        outcome,
        choices: Vec::new(),
    };
    if system == System::Genesis {
        return none("unsupported");
    }
    let church = match church_id(church) {
        Ok(id) => id,
        Err(word) => return none(word),
    };
    let key = match saved_key(system, &church, store) {
        Ok(key) => key,
        Err(word) => return none(word),
    };
    let listed = match system {
        System::B1 => b1::plans(http, clock, &key, &church).map(|plans| {
            plans
                .into_iter()
                .map(|p| Choice {
                    id: p.id.as_str().to_owned(),
                    day: p.service_date.to_string(),
                    name: p.name.map(|n| n.as_str().to_owned()),
                    shared: p.shared,
                    time: None,
                    people: None,
                })
                .collect()
        }),
        _ => breeze::events(
            http,
            clock,
            &key,
            &church,
            Some(pacer),
            from.and_then(ozzie_church_systems::capture::Date::parse),
        )
        .map(|events| {
            events
                .into_iter()
                .map(|e| Choice {
                    id: e.id.as_str().to_owned(),
                    day: e.day.to_string(),
                    name: e.name.map(|n| n.as_str().to_owned()),
                    shared: None,
                    time: e.time,
                    people: e.people,
                })
                .collect()
        }),
    };
    match listed {
        Ok(choices) => Choices {
            outcome: "ok",
            choices,
        },
        Err(error) => none(error.word()),
    }
}

/// One check of the watched service (B1 Church, Breeze) or of the "also read" facts (Genesis). `zone`: the church's
/// zone as the person confirmed it in Ozzie (B1 Church, Genesis), an IANA name. Every person name it read joins
/// `names`, the guard every request to a model passes (main.rs `SessionNames`), before the page sees the capture:
/// names never go to a model, from any system.
#[allow(clippy::too_many_arguments)]
pub(crate) fn check_with(
    system: System,
    church: &str,
    service: Option<&str>,
    zone: Option<&str>,
    http: &dyn Http,
    clock: &dyn Clock,
    pacer: &Pacer,
    store: &dyn CredentialStore,
    zones: &dyn ZoneOffsets,
    names: &crate::SessionNames,
) -> Checked {
    let failed = |outcome| Checked {
        outcome,
        capture: None,
    };
    let church = match church_id(church) {
        Ok(id) => id,
        Err(word) => return failed(word),
    };
    let zone = match zone.map(ZoneName::new) {
        None => None,
        Some(Some(zone)) => Some(zone),
        Some(None) => return failed("bad-zone"),
    };
    let service = match (system, service.map(Id::new)) {
        (System::Genesis, _) => None,
        (_, Some(Some(id))) => Some(id),
        _ => return failed("bad-id"),
    };
    let key = match saved_key(system, &church, store) {
        Ok(key) => key,
        Err(word) => return failed(word),
    };
    let read = match (system, &service) {
        (System::B1, Some(plan)) => {
            b1::check(http, clock, zones, &key, &church, plan, zone.as_ref())
        }
        (System::Breeze, Some(event)) => {
            breeze::check(http, clock, zones, &key, &church, event, Some(pacer))
        }
        (System::Genesis, _) => genesis::check(http, clock, zones, &key, &church, zone.as_ref()),
        _ => return failed("bad-id"),
    };
    if let Ok(capture) = &read {
        let read_names: Vec<String> = capture
            .names()
            .values()
            .map(|name| name.as_str().to_owned())
            .collect();
        names.remember_names(&read_names);
    }
    match read.map(|capture| capture.to_json()) {
        Ok(Ok(json)) => Checked {
            outcome: "ok",
            capture: Some(json),
        },
        Ok(Err(_)) => failed("invalid-response"),
        Err(error) => failed(error.word()),
    }
}

/// The key saved for `church` in `system`, forgotten. Forgetting one that isn't there is fine.
#[cfg(test)]
pub(crate) fn forget_with(
    system: System,
    church: &str,
    store_of: &dyn Fn(System) -> Box<dyn CredentialStore>,
) -> Result<(), &'static str> {
    forget_in(&*store_of(system), church)
}
/// The key saved for `church` in `store`, forgotten.
fn forget_in(store: &dyn CredentialStore, church: &str) -> Result<(), &'static str> {
    let church = church_id(church)?;
    keys::forget(store, &church).map_err(key_word)
}
/// Every church a key is saved for, per system, from item attributes only. A system whose Keychain items can't be
/// listed is left out.
pub(crate) fn saved_with(store_of: &dyn Fn(System) -> Box<dyn CredentialStore>) -> Vec<Saved> {
    System::all()
        .into_iter()
        .flat_map(|system| {
            keys::saved(&*store_of(system))
                .unwrap_or_default()
                .into_iter()
                .map(move |church| Saved {
                    system: system.word(),
                    church_id: church.as_str().to_owned(),
                })
        })
        .collect()
}

fn keychain(system: System) -> Box<dyn CredentialStore> {
    Box::new(keys::keychain(system))
}

/// Clears the "busy" mark however a connect ends.
struct Connecting(Arc<Shared>);
impl Drop for Connecting {
    fn drop(&mut self) {
        self.0.connecting.store(false, Ordering::SeqCst);
    }
}

/// "Paste my key" (`how` "paste") or Ozzie's key window (`how` "enter") for `system` at `address` (B1 Church: the
/// church's B1 address; Breeze: its Breeze address; Genesis: none). See the top of this file.
#[tauri::command]
pub async fn church_system_connect(
    app: tauri::AppHandle,
    state: tauri::State<'_, ChurchSystems>,
    system: String,
    address: Option<String>,
    how: String,
) -> Result<Connected, &'static str> {
    let system = system_of(&system)?;
    let paste = match how.as_str() {
        "paste" => true,
        "enter" => false,
        _ => return Err("bad-request"),
    };
    // A wrong address is said before anything is asked or read.
    let address = match address_for(system, address.as_deref()) {
        Ok(address) => address,
        Err(word) => return Ok(Connected::failed(word)),
    };
    let shared = state.inner().0.clone();
    if shared.connecting.swap(true, Ordering::SeqCst) {
        return Ok(Connected::failed("busy"));
    }
    let busy = Connecting(shared.clone());
    let (send, receive) = std::sync::mpsc::channel::<Option<Zeroizing<String>>>();
    let (title, info) = window_words(system, address.as_ref());
    app.run_on_main_thread(move || {
        let text = if paste {
            clipboard::read().map(Zeroizing::new)
        } else {
            match window::ask_with(&title, &info) {
                window::Answer::Key(text) => Some(Zeroizing::new(text)),
                window::Answer::Empty => Some(Zeroizing::new(String::new())),
                window::Answer::Cancelled => None,
            }
        };
        let _ = send.send(text);
    })
    .map_err(|_| "bad-request")?;
    let worked = tauri::async_runtime::spawn_blocking(move || {
        let _busy = busy;
        let Ok(text) = receive.recv() else {
            return (Connected::failed("cancelled"), None);
        };
        let Some(text) = text else {
            return (
                Connected::failed(if paste { "empty" } else { "cancelled" }),
                None,
            );
        };
        let http = match NativeHttp::new() {
            Ok(http) => http,
            Err(error) => return (Connected::failed(error.word()), None),
        };
        let store = Watched {
            store: keys::keychain(system),
            watch: &shared.keychain,
        };
        let connected = connect_with(
            system,
            address.as_ref(),
            &text,
            &http,
            &shared.clock,
            &shared.pacer,
            &store,
        );
        // A church connected (again) is taken back: its checks are saved again.
        if let Some(church) = connected
            .church
            .as_ref()
            .filter(|_| connected.outcome == "works")
        {
            shared.let_go.taken_back(system, &church.id);
        }
        let kept = (connected.outcome == "works").then_some(text);
        (connected, kept)
    })
    .await
    .map_err(|_| "bad-request")?;
    let (connected, kept) = worked;
    // A key that worked is cleared from the clipboard if the clipboard still holds exactly that key.
    if let Some(text) = kept {
        let _ = app.run_on_main_thread(move || clipboard::clear_if_equal(&text));
    }
    Ok(connected)
}

/// "Check the connection": the key saved for `church_id`, checked again.
#[tauri::command]
pub async fn church_system_verify(
    state: tauri::State<'_, ChurchSystems>,
    system: String,
    church_id: String,
) -> Result<Connected, &'static str> {
    let system = system_of(&system)?;
    let shared = state.inner().0.clone();
    tauri::async_runtime::spawn_blocking(move || match NativeHttp::new() {
        Ok(http) => verify_with(
            system,
            &church_id,
            &http,
            &shared.clock,
            &shared.pacer,
            &Watched {
                store: keys::keychain(system),
                watch: &shared.keychain,
            },
        ),
        Err(error) => Connected::failed(error.word()),
    })
    .await
    .map_err(|_| "bad-request")
}

/// The services to choose from (B1 Church plans, Breeze events).
#[tauri::command]
pub async fn church_system_choices(
    state: tauri::State<'_, ChurchSystems>,
    system: String,
    church_id: String,
    from: Option<String>,
) -> Result<Choices, &'static str> {
    let system = system_of(&system)?;
    let shared = state.inner().0.clone();
    tauri::async_runtime::spawn_blocking(move || match NativeHttp::new() {
        Ok(http) => choices_with(
            system,
            &church_id,
            from.as_deref(),
            &http,
            &shared.clock,
            &shared.pacer,
            &Watched {
                store: keys::keychain(system),
                watch: &shared.keychain,
            },
        ),
        Err(error) => Choices {
            outcome: error.word(),
            choices: Vec::new(),
        },
    })
    .await
    .map_err(|_| "bad-request")
}

/// One check: the watched service (B1 Church, Breeze), or Genesis's "also read" facts.
#[tauri::command]
pub async fn church_system_check(
    app: tauri::AppHandle,
    state: tauri::State<'_, ChurchSystems>,
    names: tauri::State<'_, crate::SessionNames>,
    system: String,
    church_id: String,
    service_id: Option<String>,
    zone: Option<String>,
) -> Result<Checked, &'static str> {
    let system = system_of(&system)?;
    let shared = state.inner().0.clone();
    let names = names.inner().clone();
    tauri::async_runtime::spawn_blocking(move || match NativeHttp::new() {
        Ok(http) => {
            let checked = check_with(
                system,
                &church_id,
                service_id.as_deref(),
                zone.as_deref(),
                &http,
                &shared.clock,
                &shared.pacer,
                &Watched {
                    store: keys::keychain(system),
                    watch: &shared.keychain,
                },
                &SystemZones,
                &names,
            );
            // Kept on this Mac for when the system can't be reached (best effort: the check itself is done), unless the
            // church was let go of while this check ran.
            if let (Some(json), Ok(dir)) = (&checked.capture, saved_dir(&app))
                && service_id.is_some()
            {
                shared.let_go.save_unless_let_go(system, &church_id, || {
                    let _ = save_check(&dir, json);
                });
            }
            checked
        }
        Err(error) => Checked {
            outcome: error.word(),
            capture: None,
        },
    })
    .await
    .map_err(|_| "bad-request")
}

/// Disconnect: the key saved for `church_id` is forgotten from this Mac's Keychain.
#[tauri::command]
pub async fn church_system_forget(
    state: tauri::State<'_, ChurchSystems>,
    system: String,
    church_id: String,
) -> Result<(), &'static str> {
    let system = system_of(&system)?;
    let shared = state.inner().0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let store = Watched {
            store: keys::keychain(system),
            watch: &shared.keychain,
        };
        let forgotten = forget_in(&store, &church_id);
        // Let go of: a check of it still under way isn't saved when it ends.
        if forgotten.is_ok() {
            shared.let_go.let_go(system, &church_id);
        }
        forgotten
    })
    .await
    .map_err(|_| "bad-request")?
}

/// Whether a church system's Keychain call is waiting on macOS: how long the oldest one under way has waited, in
/// milliseconds, or nothing when none is. The page says what macOS is asking once one has waited a few seconds.
#[tauri::command]
pub fn church_system_keychain_wait(state: tauri::State<'_, ChurchSystems>) -> Option<u64> {
    state.inner().0.keychain.waiting_ms()
}

/// The churches with a key saved on this Mac, per system (Keychain item attributes only).
#[tauri::command]
pub async fn church_system_saved() -> Result<Vec<Saved>, &'static str> {
    tauri::async_runtime::spawn_blocking(|| saved_with(&keychain))
        .await
        .map_err(|_| "bad-request")
}

// ---- Saved checks -----------------------------------------------------------------------------------------------
//
// Each check of a watched service (B1 Church, Breeze) is kept on this Mac, so the service can still be shown when the
// system can't be reached, as Planning Center's saved checks are (native-auth sunday_check.rs `save_recording`):
// `<app data>/church-system-checks/<system>.<church id>.<service id>.<finished unix ms>.json`, 0600 in 0700, the newest
// KEEP_SAVED per church and service. Ids hold no `.` (capture.rs `Id`), so a name splits one way. A saved check holds
// volunteers' names; it never leaves this Mac, and loading one adds its names to the guard on model requests, as a
// check does.

/// Newest saved checks kept per church and service.
pub(crate) const KEEP_SAVED: usize = 5;
#[cfg(target_os = "macos")]
const O_NOFOLLOW: i32 = 0x0100;
/// The largest saved check read back.
const MAX_SAVED_BYTES: u64 = 16 * 1024 * 1024;

/// One saved check, from its file name alone (its content is checked when it is loaded).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct SavedCheck {
    pub path_id: String,
    pub service_id: String,
    pub completed_at: String,
}
struct SavedName {
    system: System,
    church: Id,
    service: Id,
    completed_ms: i64,
}
fn saved_name(file: &str) -> Option<SavedName> {
    let mut parts = file.strip_suffix(".json")?.split('.');
    let (system, church, service, ms) =
        (parts.next()?, parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some()
        || ms.is_empty()
        || ms.len() > 15
        || !ms.bytes().all(|b| b.is_ascii_digit())
        || ms.starts_with('0')
    {
        return None;
    }
    Some(SavedName {
        system: system_of(system).ok()?,
        church: Id::new(church)?,
        service: Id::new(service)?,
        completed_ms: ms.parse().ok()?,
    })
}
fn private_dir(dir: &std::path::Path) -> std::io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(dir)?;
    #[cfg(unix)]
    std::fs::set_permissions(dir, std::os::unix::fs::PermissionsExt::from_mode(0o700))?;
    Ok(())
}
/// Keeps a finished check of a watched service (`json`: the capture as a check returned it), and only the newest
/// KEEP_SAVED of that church and service. A capture with no service (Genesis) isn't kept.
pub(crate) fn save_check(dir: &std::path::Path, json: &str) -> std::io::Result<String> {
    use std::io::Write;
    let invalid = || std::io::Error::from(std::io::ErrorKind::InvalidData);
    let capture =
        ozzie_church_systems::SystemCapture::from_json(json.as_bytes()).map_err(|_| invalid())?;
    let service = capture.service().ok_or_else(invalid)?;
    if capture.system() == System::Genesis || json.len() as u64 > MAX_SAVED_BYTES {
        return Err(invalid());
    }
    let church = &capture.church().id;
    let completed = capture.completed_at().unix_millis();
    if completed <= 0 {
        return Err(invalid());
    }
    let name = format!(
        "{}.{}.{}.{completed}.json",
        capture.system().word(),
        church.as_str(),
        service.id.as_str()
    );
    private_dir(dir)?;
    // Written aside then renamed, so a listed check is never half-written.
    let partial = dir.join(format!(".{name}.partial"));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let written = options.open(&partial).and_then(|mut file| {
        file.write_all(json.as_bytes())?;
        file.sync_all()
    });
    if let Err(error) = written.and_then(|()| std::fs::rename(&partial, dir.join(&name))) {
        let _ = std::fs::remove_file(&partial);
        return Err(error);
    }
    let mut same: Vec<(i64, String)> = std::fs::read_dir(dir)?
        .flatten()
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter_map(|file| {
            let n = saved_name(&file)?;
            (n.system == capture.system() && &n.church == church && n.service == service.id)
                .then_some((n.completed_ms, file))
        })
        .collect();
    same.sort_by(|a, b| b.cmp(a));
    for (_, old) in same.into_iter().skip(KEEP_SAVED) {
        let _ = std::fs::remove_file(dir.join(old));
    }
    Ok(name)
}
/// One church's saved checks, newest first. A missing directory is an empty list.
pub(crate) fn list_checks(
    dir: &std::path::Path,
    system: System,
    church: &str,
) -> Result<Vec<SavedCheck>, &'static str> {
    let church = church_id(church)?;
    let entries = match std::fs::read_dir(dir) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err("unavailable"),
        Ok(entries) => entries,
    };
    let mut listed: Vec<(i64, SavedCheck)> = entries
        .flatten()
        .filter_map(|entry| {
            let file = entry.file_name().into_string().ok()?;
            let n = saved_name(&file).filter(|n| n.system == system && n.church == church)?;
            std::fs::symlink_metadata(entry.path())
                .is_ok_and(|meta| meta.file_type().is_file() && meta.len() <= MAX_SAVED_BYTES)
                .then(|| {
                    let at = ozzie_church_systems::capture::Time::from_unix_millis(n.completed_ms)
                        .map(|t| t.as_str().to_owned());
                    at.map(|completed_at| {
                        (
                            n.completed_ms,
                            SavedCheck {
                                path_id: file,
                                service_id: n.service.as_str().to_owned(),
                                completed_at,
                            },
                        )
                    })
                })
                .flatten()
        })
        .collect();
    listed.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.path_id.cmp(&a.1.path_id)));
    Ok(listed.into_iter().map(|(_, check)| check).collect())
}
/// A saved check of `church`, read back and checked again: it must be that church's, of the service and time its name
/// says, and a whole capture. Its names join the guard on model requests before the page sees it.
pub(crate) fn load_check(
    dir: &std::path::Path,
    system: System,
    church: &str,
    path_id: &str,
    names: &crate::SessionNames,
) -> Checked {
    use std::io::Read;
    let failed = |outcome| Checked {
        outcome,
        capture: None,
    };
    let Ok(church) = church_id(church) else {
        return failed("bad-id");
    };
    let Some(name) = saved_name(path_id).filter(|n| n.system == system && n.church == church)
    else {
        return failed("bad-id");
    };
    let path = dir.join(path_id);
    if !std::fs::symlink_metadata(&path)
        .is_ok_and(|meta| meta.file_type().is_file() && meta.len() <= MAX_SAVED_BYTES)
    {
        return failed("not-found");
    }
    let mut bytes = Vec::new();
    // A link put in place of the file after the look above is never followed (as native-auth's load_recording).
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(target_os = "macos")]
    std::os::unix::fs::OpenOptionsExt::custom_flags(&mut options, O_NOFOLLOW);
    let read = options
        .open(&path)
        .and_then(|file| file.take(MAX_SAVED_BYTES + 1).read_to_end(&mut bytes));
    if read.is_err() || bytes.len() as u64 > MAX_SAVED_BYTES {
        return failed("not-found");
    }
    let Ok(capture) = ozzie_church_systems::SystemCapture::from_json(&bytes) else {
        return failed("invalid-response");
    };
    if capture.system() != system
        || capture.church().id != church
        || capture.service().map(|s| &s.id) != Some(&name.service)
        || capture.completed_at().unix_millis() != name.completed_ms
    {
        return failed("invalid-response");
    }
    let read_names: Vec<String> = capture
        .names()
        .values()
        .map(|n| n.as_str().to_owned())
        .collect();
    names.remember_names(&read_names);
    match capture.to_json() {
        Ok(json) => Checked {
            outcome: "ok",
            capture: Some(json),
        },
        Err(_) => failed("invalid-response"),
    }
}
/// Removes every saved check of `church` (and any unfinished save). Returns how many.
pub(crate) fn delete_checks(
    dir: &std::path::Path,
    system: System,
    church: &str,
) -> Result<usize, &'static str> {
    let church = church_id(church)?;
    let entries = match std::fs::read_dir(dir) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(_) => return Err("unavailable"),
        Ok(entries) => entries,
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let Ok(file) = entry.file_name().into_string() else {
            continue;
        };
        let bare = file
            .strip_prefix('.')
            .and_then(|f| f.strip_suffix(".partial"))
            .unwrap_or(&file);
        if saved_name(bare).is_some_and(|n| n.system == system && n.church == church) {
            std::fs::remove_file(entry.path()).map_err(|_| "unavailable")?;
            removed += 1;
        }
    }
    Ok(removed)
}
fn saved_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, &'static str> {
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("church-system-checks"))
        .map_err(|_| "unavailable")
}

/// A church's saved checks, newest first. Works without the system.
#[tauri::command]
pub async fn church_system_saved_checks(
    app: tauri::AppHandle,
    system: String,
    church_id: String,
) -> Result<Vec<SavedCheck>, &'static str> {
    let system = system_of(&system)?;
    tauri::async_runtime::spawn_blocking(move || list_checks(&saved_dir(&app)?, system, &church_id))
        .await
        .map_err(|_| "bad-request")?
}
/// One saved check of a church, as a check gives it. Works without the system: it is the fallback when it can't be reached.
#[tauri::command]
pub async fn church_system_load_check(
    app: tauri::AppHandle,
    names: tauri::State<'_, crate::SessionNames>,
    system: String,
    church_id: String,
    path_id: String,
) -> Result<Checked, &'static str> {
    let system = system_of(&system)?;
    let names = names.inner().clone();
    tauri::async_runtime::spawn_blocking(move || match saved_dir(&app) {
        Ok(dir) => load_check(&dir, system, &church_id, &path_id, &names),
        Err(word) => Checked {
            outcome: word,
            capture: None,
        },
    })
    .await
    .map_err(|_| "bad-request")
}
/// Removes a church's saved checks from this Mac (Settings, a disconnect, a switch). Never automatic otherwise.
#[tauri::command]
pub async fn church_system_delete_checks(
    app: tauri::AppHandle,
    state: tauri::State<'_, ChurchSystems>,
    system: String,
    church_id: String,
) -> Result<usize, &'static str> {
    let system = system_of(&system)?;
    let shared = state.inner().0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        shared
            .let_go
            .while_held(|| delete_checks(&saved_dir(&app)?, system, &church_id))
    })
    .await
    .map_err(|_| "bad-request")?
}

#[cfg(test)]
#[path = "church_systems_tests.rs"]
mod tests;
