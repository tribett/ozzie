//! church_systems.rs on fixed fictional answers: a fake system, an in-memory Keychain, a fixed clock. No real
//! Keychain, network or clock. Every key here is built from parts at run time (no key-shaped text in any file).
use super::*;
use ozzie_church_systems::SystemCapture;
use ozzie_church_systems::http::Reply;
use ozzie_church_systems::run::Clock;
use ozzie_church_systems::zones::NoZones;
use ozzie_native_auth::credentials::StoreError;
use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;
use std::time::Duration;

/// 2026-11-17T15:00:00Z.
const NOW: i64 = 1_794_927_600_000;
const CHURCH: &str = "CHUfict01";

struct FixedClock(Mutex<Duration>);
impl FixedClock {
    fn new() -> FixedClock {
        FixedClock(Mutex::new(Duration::from_secs(1000)))
    }
}
impl Clock for FixedClock {
    fn elapsed(&self) -> Duration {
        *self.0.lock().unwrap()
    }
    fn unix_millis(&self) -> i64 {
        NOW + (self.elapsed() - Duration::from_secs(1000)).as_millis() as i64
    }
    fn sleep(&self, wait: Duration) {
        *self.0.lock().unwrap() += wait;
    }
}

/// Answers by `<host><path>`, or `<host><path>?<query>` when that is set; anything else is 404 `{}`.
#[derive(Default)]
struct FakeSystem {
    answers: HashMap<String, (u16, String)>,
    asked: Mutex<Vec<String>>,
}
impl FakeSystem {
    fn with(mut self, at: &str, status: u16, body: serde_json::Value) -> FakeSystem {
        self.answers
            .insert(at.to_owned(), (status, body.to_string()));
        self
    }
    fn asked(&self) -> Vec<String> {
        self.asked.lock().unwrap().clone()
    }
}
impl Http for FakeSystem {
    fn get(&self, request: &ozzie_church_systems::http::Get) -> Result<Reply, ReadError> {
        assert_eq!(request.method(), "GET");
        let url = request.url();
        let at = format!("{}{}", url.host_str().unwrap(), url.path());
        let full = format!("{at}?{}", url.query().unwrap_or_default());
        self.asked.lock().unwrap().push(full.clone());
        let found = self.answers.get(&full).or_else(|| self.answers.get(&at));
        Ok(match found {
            Some((status, body)) => Reply::new(*status, body.clone().into_bytes()),
            None => Reply::new(404, b"{}".to_vec()),
        })
    }
}

/// This Mac's Keychain, in memory.
#[derive(Default)]
struct MemoryStore(Mutex<BTreeMap<(String, String), Vec<u8>>>);
impl CredentialStore for MemoryStore {
    fn put(&self, workspace: &str, organization: &str, value: &[u8]) -> Result<(), StoreError> {
        self.0
            .lock()
            .unwrap()
            .insert((workspace.into(), organization.into()), value.to_vec());
        Ok(())
    }
    fn get(&self, workspace: &str, organization: &str) -> Result<Option<Vec<u8>>, StoreError> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .get(&(workspace.into(), organization.into()))
            .cloned())
    }
    fn delete(&self, workspace: &str, organization: &str) -> Result<(), StoreError> {
        self.0
            .lock()
            .unwrap()
            .remove(&(workspace.into(), organization.into()));
        Ok(())
    }
    fn accounts(&self) -> Result<Vec<(String, String)>, StoreError> {
        Ok(self.0.lock().unwrap().keys().cloned().collect())
    }
}
/// A Keychain that refuses, as a locked one does.
struct LockedStore;
impl CredentialStore for LockedStore {
    fn put(&self, _: &str, _: &str, _: &[u8]) -> Result<(), StoreError> {
        Err(StoreError::Locked)
    }
    fn get(&self, _: &str, _: &str) -> Result<Option<Vec<u8>>, StoreError> {
        Err(StoreError::Locked)
    }
    fn delete(&self, _: &str, _: &str) -> Result<(), StoreError> {
        Err(StoreError::Locked)
    }
}

fn b1_key_text() -> String {
    format!(
        "{}{}.{}",
        ["ca", "k_"].concat(),
        "c3".repeat(4),
        "9e".repeat(24)
    )
}
fn breeze_key_text() -> String {
    ["b7", "e4"].concat().repeat(8)
}
fn genesis_key_text() -> String {
    format!(
        "{}{}",
        ["gk_", "live_"].concat(),
        ["a3", "f9"].concat().repeat(8)
    )
}
fn id(text: &str) -> Id {
    Id::new(text).unwrap()
}

const B1: &str = "api.churchapps.org";
fn b1_church() -> FakeSystem {
    FakeSystem::default()
        .with(
            &format!("{B1}/membership/churches/lookup?subDomain=cedarhollow"),
            200,
            serde_json::json!({"id": CHURCH, "name": "Cedar Hollow Fellowship", "subDomain": "cedarhollow"}),
        )
        .with(
            &format!("{B1}/membership/churches/{CHURCH}"),
            200,
            serde_json::json!({"id": CHURCH, "name": "Cedar Hollow Fellowship", "timeZone": null}),
        )
}
fn connect(
    system: System,
    address: Option<&str>,
    text: &str,
    http: &FakeSystem,
    store: &dyn CredentialStore,
) -> Connected {
    let address = match address_for(system, address) {
        Ok(address) => address,
        Err(word) => return Connected::failed(word),
    };
    connect_with(
        system,
        address.as_ref(),
        text,
        http,
        &FixedClock::new(),
        &Pacer::new(),
        store,
    )
}

#[test]
fn system_words_and_addresses() {
    assert_eq!(system_of("b1"), Ok(System::B1));
    assert_eq!(system_of("breeze"), Ok(System::Breeze));
    assert_eq!(system_of("genesis"), Ok(System::Genesis));
    for word in ["", "B1", "planning-center", "pco", "other"] {
        assert_eq!(system_of(word), Err("unknown-system"), "{word}");
    }
    assert_eq!(
        address_for(System::B1, Some("https://cedarhollow.b1.church/")),
        Ok(Some(id("cedarhollow")))
    );
    assert_eq!(
        address_for(System::Breeze, Some("cedarhollow.breezechms.com")),
        Ok(Some(id("cedarhollow")))
    );
    for text in [None, Some(""), Some("not an address"), Some("lookup")] {
        assert_eq!(address_for(System::B1, text), Err("address"), "{text:?}");
    }
    assert_eq!(address_for(System::Breeze, Some("www")), Err("address"));
    // Genesis's key names its church: an address is never needed or used.
    assert_eq!(address_for(System::Genesis, None), Ok(None));
    assert_eq!(address_for(System::Genesis, Some("anything")), Ok(None));
}

#[test]
fn the_key_window_names_where_the_key_goes() {
    let (title, info) = window_words(System::B1, Some(&id("cedarhollow")));
    assert_eq!(title, "Paste your B1 Church API key");
    assert_eq!(
        info,
        "Ozzie sends it only to api.churchapps.org, to read your church's B1 Church account. If it works, Ozzie keeps it in this Mac's Keychain. It is never shown again."
    );
    let (title, info) = window_words(System::Breeze, Some(&id("cedarhollow")));
    assert_eq!(title, "Paste your Breeze API key");
    assert!(info.starts_with(
        "Ozzie sends it only to cedarhollow.breezechms.com, to read your church's Breeze account."
    ));
    let (title, info) = window_words(System::Genesis, None);
    assert_eq!(title, "Paste your Genesis API key");
    assert!(info.starts_with("Ozzie sends it only to the address Genesis publishes for its API, to read your church's Genesis account."));
}

#[test]
fn a_b1_key_is_checked_at_the_churchs_address_then_saved_for_that_church() {
    let fake = b1_church();
    let store = MemoryStore::default();
    let done = connect(
        System::B1,
        Some("cedarhollow.b1.church"),
        &format!("  {}\n", b1_key_text()),
        &fake,
        &store,
    );
    assert_eq!(
        done,
        Connected {
            outcome: "works",
            church: Some(Church {
                id: CHURCH.into(),
                name: Some("Cedar Hollow Fellowship".into())
            })
        }
    );
    assert_eq!(
        fake.asked(),
        vec![
            format!("{B1}/membership/churches/lookup?subDomain=cedarhollow"),
            format!("{B1}/membership/churches/{CHURCH}?"),
        ]
    );
    // Saved under the church's id, trimmed, and readable back only as a B1 Church key.
    assert_eq!(
        store.get("local", CHURCH).unwrap().unwrap(),
        b1_key_text().into_bytes()
    );
    assert_eq!(
        saved_with(&|system| -> Box<dyn CredentialStore> {
            if system == System::B1 {
                Box::new(MemoryStore(Mutex::new(store.0.lock().unwrap().clone())))
            } else {
                Box::new(MemoryStore::default())
            }
        }),
        vec![Saved {
            system: "b1",
            church_id: CHURCH.into()
        }]
    );
    // Nothing of the key is in what the page gets.
    assert!(!format!("{done:?}").contains(&b1_key_text()));
}

#[test]
fn each_way_a_connect_can_end_is_one_closed_word_and_nothing_is_saved() {
    let key = b1_key_text();
    let cases: Vec<(&str, FakeSystem, Option<&str>, String)> = vec![
        ("empty", b1_church(), Some("cedarhollow"), "   ".into()),
        (
            "format",
            b1_church(),
            Some("cedarhollow"),
            "not-a-key".into(),
        ),
        // Another system's key is not a B1 key.
        (
            "format",
            b1_church(),
            Some("cedarhollow"),
            breeze_key_text(),
        ),
        ("address", b1_church(), Some("cedar hollow"), key.clone()),
        ("address", b1_church(), None, key.clone()),
        (
            "not-found",
            FakeSystem::default().with(
                &format!("{B1}/membership/churches/lookup"),
                200,
                serde_json::json!({}),
            ),
            Some("nosuchchurch"),
            key.clone(),
        ),
        (
            "key-refused",
            b1_church().with(
                &format!("{B1}/membership/churches/{CHURCH}"),
                401,
                serde_json::json!({}),
            ),
            Some("cedarhollow"),
            key.clone(),
        ),
        (
            "refused",
            FakeSystem::default().with(
                &format!("{B1}/membership/churches/lookup"),
                500,
                serde_json::json!({"error": "x"}),
            ),
            Some("cedarhollow"),
            key.clone(),
        ),
        (
            "rate-limited",
            FakeSystem::default().with(
                &format!("{B1}/membership/churches/lookup"),
                429,
                serde_json::json!({}),
            ),
            Some("cedarhollow"),
            key.clone(),
        ),
        (
            "invalid-response",
            FakeSystem::default().with(
                &format!("{B1}/membership/churches/lookup"),
                200,
                serde_json::json!({"id": "lookup"}),
            ),
            Some("cedarhollow"),
            key.clone(),
        ),
    ];
    for (word, fake, address, text) in cases {
        let store = MemoryStore::default();
        let done = connect(System::B1, address, &text, &fake, &store);
        assert_eq!(done, Connected::failed(word), "{word}");
        assert!(store.0.lock().unwrap().is_empty(), "{word}");
    }
    // A Keychain that won't keep it: its word, after the check worked.
    assert_eq!(
        connect(
            System::B1,
            Some("cedarhollow"),
            &key,
            &b1_church(),
            &LockedStore
        ),
        Connected::failed("locked")
    );
}

#[test]
fn a_breeze_key_is_checked_at_the_churchs_own_breeze_address() {
    let host = "cedarhollow.breezechms.com";
    let fake = FakeSystem::default().with(
        &format!("{host}/api/account/summary"),
        200,
        serde_json::json!({"id": "1234", "name": "Cedar Hollow Fellowship", "subdomain": "cedarhollow",
            "details": {"timezone": "America/Chicago"}}),
    );
    let store = MemoryStore::default();
    let done = connect(
        System::Breeze,
        Some("https://cedarhollow.breezechms.com/dashboard"),
        &breeze_key_text(),
        &fake,
        &store,
    );
    assert_eq!(done.outcome, "works");
    assert_eq!(done.church.unwrap().id, "cedarhollow");
    assert_eq!(fake.asked(), vec![format!("{host}/api/account/summary?")]);
    assert!(store.get("local", "cedarhollow").unwrap().is_some());
    // The wrong key: Breeze refuses the account read.
    let refused = FakeSystem::default().with(
        &format!("{host}/api/account/summary"),
        401,
        serde_json::json!({}),
    );
    assert_eq!(
        connect(
            System::Breeze,
            Some("cedarhollow"),
            &breeze_key_text(),
            &refused,
            &MemoryStore::default()
        ),
        Connected::failed("key-refused")
    );
}

#[test]
fn a_genesis_key_names_its_own_church() {
    let me = "poxkspytrsaextyeurtg.supabase.co/functions/v1/public-api/v1/me";
    let fake = FakeSystem::default().with(
        me,
        200,
        serde_json::json!({"church": {"id": "CHGfict", "name": "Cedar Hollow Fellowship"}}),
    );
    let store = MemoryStore::default();
    let done = connect(System::Genesis, None, &genesis_key_text(), &fake, &store);
    assert_eq!(done.outcome, "works");
    assert_eq!(done.church.unwrap().id, "CHGfict");
    // Checking it again: the saved key must still name the same church.
    let clock = FixedClock::new();
    assert_eq!(
        verify_with(
            System::Genesis,
            "CHGfict",
            &fake,
            &clock,
            &Pacer::new(),
            &store
        )
        .outcome,
        "works"
    );
    store
        .put("local", "CHGother", genesis_key_text().as_bytes())
        .unwrap();
    assert_eq!(
        verify_with(
            System::Genesis,
            "CHGother",
            &fake,
            &clock,
            &Pacer::new(),
            &store
        ),
        Connected::failed("key-refused")
    );
}

#[test]
fn checking_a_saved_key_again() {
    let store = MemoryStore::default();
    let clock = FixedClock::new();
    let pacer = Pacer::new();
    // None saved.
    assert_eq!(
        verify_with(System::B1, CHURCH, &b1_church(), &clock, &pacer, &store),
        Connected::failed("no-key")
    );
    assert_eq!(
        verify_with(
            System::B1,
            "not an id",
            &b1_church(),
            &clock,
            &pacer,
            &store
        ),
        Connected::failed("bad-id")
    );
    store
        .put("local", CHURCH, b1_key_text().as_bytes())
        .unwrap();
    let done = verify_with(System::B1, CHURCH, &b1_church(), &clock, &pacer, &store);
    assert_eq!(done.outcome, "works");
    assert_eq!(
        done.church.unwrap().name.as_deref(),
        Some("Cedar Hollow Fellowship")
    );
    // The key no longer opens the church.
    let refused = FakeSystem::default().with(
        &format!("{B1}/membership/churches/{CHURCH}"),
        403,
        serde_json::json!({}),
    );
    assert_eq!(
        verify_with(System::B1, CHURCH, &refused, &clock, &pacer, &store),
        Connected::failed("key-refused")
    );
    // What is saved isn't shaped like a B1 key any more.
    store.put("local", CHURCH, b"garbage").unwrap();
    assert_eq!(
        verify_with(System::B1, CHURCH, &b1_church(), &clock, &pacer, &store),
        Connected::failed("format")
    );
    assert_eq!(
        verify_with(
            System::B1,
            CHURCH,
            &b1_church(),
            &clock,
            &pacer,
            &LockedStore
        ),
        Connected::failed("locked")
    );
}

#[test]
fn the_plans_to_choose_from() {
    let store = MemoryStore::default();
    let clock = FixedClock::new();
    let pacer = Pacer::new();
    assert_eq!(
        choices_with(
            System::B1,
            CHURCH,
            None,
            &b1_church(),
            &clock,
            &pacer,
            &store
        )
        .outcome,
        "no-key"
    );
    assert_eq!(
        choices_with(
            System::Genesis,
            "CHGfict",
            None,
            &b1_church(),
            &clock,
            &pacer,
            &store
        )
        .outcome,
        "unsupported"
    );
    store
        .put("local", CHURCH, b1_key_text().as_bytes())
        .unwrap();
    let fake = b1_church()
        .with(
            &format!("{B1}/doing/plans/overview"),
            200,
            serde_json::json!([
                {"planId": "PLAfict02", "serviceDate": "2026-11-29T00:00:00.000Z", "planName": "Advent One"},
                {"planId": "PLAfict01", "serviceDate": "2026-11-22T00:00:00.000Z", "planName": "Sunday Morning"},
            ]),
        )
        .with(
            &format!("{B1}/doing/plans/ids"),
            200,
            serde_json::json!([{"id": "PLAfict01", "prepared": false}, {"id": "PLAfict02", "prepared": true}]),
        );
    let listed = choices_with(System::B1, CHURCH, None, &fake, &clock, &pacer, &store);
    assert_eq!(listed.outcome, "ok");
    assert_eq!(
        listed.choices,
        vec![
            Choice {
                id: "PLAfict01".into(),
                day: "2026-11-22".into(),
                name: Some("Sunday Morning".into()),
                shared: Some(true),
                time: None,
                people: None,
            },
            Choice {
                id: "PLAfict02".into(),
                day: "2026-11-29".into(),
                name: Some("Advent One".into()),
                shared: Some(false),
                time: None,
                people: None,
            },
        ]
    );
}

#[test]
fn a_check_gives_the_captures_json_or_one_word() {
    let store = MemoryStore::default();
    let clock = FixedClock::new();
    let pacer = Pacer::new();
    let names = crate::SessionNames::default();
    let check = |service: Option<&str>,
                 zone: Option<&str>,
                 fake: &FakeSystem,
                 store: &dyn CredentialStore| {
        check_with(
            System::B1,
            CHURCH,
            service,
            zone,
            fake,
            &clock,
            &pacer,
            store,
            &NoZones,
            &names,
        )
    };
    assert_eq!(
        check(Some("PLAfict01"), None, &b1_church(), &store).outcome,
        "no-key"
    );
    assert_eq!(check(None, None, &b1_church(), &store).outcome, "bad-id");
    assert_eq!(
        check(Some("PLA 1"), None, &b1_church(), &store).outcome,
        "bad-id"
    );
    assert_eq!(
        check(Some("PLAfict01"), Some("not a zone"), &b1_church(), &store).outcome,
        "bad-zone"
    );
    store
        .put("local", CHURCH, b1_key_text().as_bytes())
        .unwrap();
    // A zone this Mac's zone data doesn't know (here, none) is refused before anything is sent.
    let fake = b1_church();
    assert_eq!(
        check(Some("PLAfict01"), Some("America/Chicago"), &fake, &store).outcome,
        "bad-zone"
    );
    assert!(fake.asked().is_empty());
    // The church's record reads; every other read of the plan fails (404): still a whole capture, each read recorded.
    let fake = b1_church();
    let done = check(Some("PLAfict01"), None, &fake, &store);
    assert_eq!(done.outcome, "ok");
    let capture = SystemCapture::from_json(done.capture.unwrap().as_bytes()).unwrap();
    assert_eq!(capture.system(), System::B1);
    assert_eq!(capture.church().id.as_str(), CHURCH);
    assert!(
        capture
            .reads()
            .iter()
            .any(|r| r.read.as_str() == "b1.plans")
    );
    assert!(fake.asked().iter().all(|a| a.starts_with(B1)));
    // A key the church no longer accepts.
    let refused = FakeSystem::default().with(
        &format!("{B1}/membership/churches/{CHURCH}"),
        401,
        serde_json::json!({}),
    );
    let done = check(Some("PLAfict01"), None, &refused, &store);
    assert_eq!(done.outcome, "ok");
    let capture = SystemCapture::from_json(done.capture.unwrap().as_bytes()).unwrap();
    assert_eq!(
        capture.reads()[0].outcome,
        ozzie_church_systems::capture::Outcome::KeyRefused
    );
}

#[test]
fn every_name_a_check_read_joins_the_guard_on_model_requests() {
    let store = MemoryStore::default();
    store
        .put("local", CHURCH, b1_key_text().as_bytes())
        .unwrap();
    let plan = "PLAfict01";
    let fake = b1_church()
        .with(
            &format!("{B1}/doing/positions/plan/{plan}"),
            200,
            serde_json::json!([{"id": "POSvocals", "planId": plan, "name": "Vocals", "count": 1, "groupId": null}]),
        )
        .with(
            &format!("{B1}/doing/assignments/plan/{plan}"),
            200,
            serde_json::json!([{"id": "ASSone", "planId": plan, "positionId": "POSvocals", "personId": "PERavery",
                "status": "Accepted", "notified": null}]),
        )
        .with(
            &format!("{B1}/membership/people/names"),
            200,
            serde_json::json!([{"id": "PERavery", "name": {"display": "Avery Quillfeather"}}]),
        );
    let names = crate::SessionNames::default();
    assert!(!names.snapshot().present("Quillfeather"));
    let done = check_with(
        System::B1,
        CHURCH,
        Some(plan),
        None,
        &fake,
        &FixedClock::new(),
        &Pacer::new(),
        &store,
        &NoZones,
        &names,
    );
    assert_eq!(done.outcome, "ok");
    let capture = SystemCapture::from_json(done.capture.unwrap().as_bytes()).unwrap();
    assert_eq!(capture.names().len(), 1);
    // The person's name is held by the guard; the role's name (a label) is not.
    let guard = names.snapshot();
    assert!(guard.present("Avery Quillfeather"));
    assert!(guard.present("Quillfeather"));
    assert!(!guard.present("Vocals"));
    // A check that failed before anything was read adds nothing.
    let names = crate::SessionNames::default();
    let _ = check_with(
        System::B1,
        CHURCH,
        Some(plan),
        None,
        &fake,
        &FixedClock::new(),
        &Pacer::new(),
        &MemoryStore::default(),
        &NoZones,
        &names,
    );
    assert!(names.snapshot().is_empty());
}

#[test]
fn forgetting_a_key() {
    let store = std::sync::Arc::new(MemoryStore::default());
    store
        .put("local", CHURCH, b1_key_text().as_bytes())
        .unwrap();
    let shared = store.clone();
    let store_of =
        move |_: System| -> Box<dyn CredentialStore> { Box::new(Shared(shared.clone())) };
    assert_eq!(
        forget_with(System::B1, "not an id", &store_of),
        Err("bad-id")
    );
    assert_eq!(forget_with(System::B1, CHURCH, &store_of), Ok(()));
    assert!(store.0.lock().unwrap().is_empty());
    // Forgetting one that isn't there is fine; a locked Keychain says so.
    assert_eq!(forget_with(System::B1, CHURCH, &store_of), Ok(()));
    assert_eq!(
        forget_with(System::B1, CHURCH, &|_| Box::new(LockedStore)),
        Err("locked")
    );
}
/// One in-memory store behind several boxes.
struct Shared(std::sync::Arc<MemoryStore>);
impl CredentialStore for Shared {
    fn put(&self, w: &str, o: &str, v: &[u8]) -> Result<(), StoreError> {
        self.0.put(w, o, v)
    }
    fn get(&self, w: &str, o: &str) -> Result<Option<Vec<u8>>, StoreError> {
        self.0.get(w, o)
    }
    fn delete(&self, w: &str, o: &str) -> Result<(), StoreError> {
        self.0.delete(w, o)
    }
    fn accounts(&self) -> Result<Vec<(String, String)>, StoreError> {
        self.0.accounts()
    }
}

/// A fresh, private directory for one test's saved checks.
fn saved_dir_for(test: &str) -> std::path::PathBuf {
    let dir =
        std::env::temp_dir().join(format!("ozzie-system-checks-{test}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}
/// A B1 Church check of `plan` with one named person, finished at the clock's time.
fn one_check(plan: &str, clock: &FixedClock, names: &crate::SessionNames) -> String {
    let store = MemoryStore::default();
    store
        .put("local", CHURCH, b1_key_text().as_bytes())
        .unwrap();
    let fake = b1_church()
        .with(
            &format!("{B1}/doing/plans/{plan}"),
            200,
            serde_json::json!({"id": plan, "name": "Sunday Gathering", "serviceDate": "2026-11-22T00:00:00.000Z"}),
        )
        .with(
            &format!("{B1}/doing/times/plan/{plan}"),
            200,
            serde_json::json!([{"id": "TIMone", "planId": plan, "serviceTimeType": "service",
                "startTime": "2026-11-22T15:00:00.000Z", "endTime": "2026-11-22T16:15:00.000Z"}]),
        )
        .with(
            &format!("{B1}/doing/positions/plan/{plan}"),
            200,
            serde_json::json!([{"id": "POSvocals", "planId": plan, "name": "Vocals", "count": 1, "groupId": null}]),
        )
        .with(
            &format!("{B1}/doing/assignments/plan/{plan}"),
            200,
            serde_json::json!([{"id": "ASSone", "planId": plan, "positionId": "POSvocals", "personId": "PERavery",
                "status": "Accepted", "notified": null}]),
        )
        .with(
            &format!("{B1}/membership/people/names"),
            200,
            serde_json::json!([{"id": "PERavery", "name": {"display": "Avery Quillfeather"}}]),
        );
    let done = check_with(
        System::B1,
        CHURCH,
        Some(plan),
        None,
        &fake,
        clock,
        &Pacer::new(),
        &store,
        &NoZones,
        names,
    );
    assert_eq!(done.outcome, "ok");
    done.capture.unwrap()
}

#[test]
fn a_check_is_saved_listed_and_read_back_on_this_mac_only_for_its_church() {
    let dir = saved_dir_for("saved");
    let clock = FixedClock::new();
    let names = crate::SessionNames::default();
    let first = one_check("PLAfict01", &clock, &names);
    let name = save_check(&dir, &first).unwrap();
    assert!(name.starts_with(&format!("b1.{CHURCH}.PLAfict01.")));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(dir.join(&name))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    let listed = list_checks(&dir, System::B1, CHURCH).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].path_id, name);
    assert_eq!(listed[0].service_id, "PLAfict01");
    // To the second, as the capture says when it finished.
    let finished = SystemCapture::from_json(first.as_bytes())
        .unwrap()
        .completed_at()
        .as_str()
        .to_owned();
    assert_eq!(listed[0].completed_at, finished);
    // Another church, another system: nothing listed, nothing loaded.
    assert!(
        list_checks(&dir, System::B1, "CHUother")
            .unwrap()
            .is_empty()
    );
    assert!(
        list_checks(&dir, System::Breeze, CHURCH)
            .unwrap()
            .is_empty()
    );
    assert_eq!(list_checks(&dir, System::B1, "not an id"), Err("bad-id"));
    // Read back: the same capture, and its names join the guard on model requests.
    let fresh = crate::SessionNames::default();
    let loaded = load_check(&dir, System::B1, CHURCH, &name, &fresh);
    assert_eq!(loaded.outcome, "ok");
    assert_eq!(
        SystemCapture::from_json(loaded.capture.unwrap().as_bytes()).unwrap(),
        SystemCapture::from_json(first.as_bytes()).unwrap()
    );
    assert!(fresh.snapshot().present("Avery Quillfeather"));
    for (system, church, path) in [
        (System::B1, "CHUother", name.as_str()),
        (System::Breeze, CHURCH, name.as_str()),
        (System::B1, CHURCH, "../outside.json"),
        (System::B1, CHURCH, "b1.CHUfict01.PLAfict01.0123.json"),
    ] {
        assert_eq!(
            load_check(&dir, system, church, path, &crate::SessionNames::default()).outcome,
            "bad-id",
            "{path}"
        );
    }
    // A file whose content isn't what its name says (another service) is refused, and adds no names.
    let moved = name.replace("PLAfict01", "PLAfict02");
    std::fs::copy(dir.join(&name), dir.join(&moved)).unwrap();
    let guard = crate::SessionNames::default();
    assert_eq!(
        load_check(&dir, System::B1, CHURCH, &moved, &guard).outcome,
        "invalid-response"
    );
    assert!(guard.snapshot().is_empty());
    // Damaged content too.
    std::fs::write(dir.join(&moved), b"{\"version\":1}").unwrap();
    assert_eq!(
        load_check(&dir, System::B1, CHURCH, &moved, &guard).outcome,
        "invalid-response"
    );
    std::fs::remove_file(dir.join(&moved)).unwrap();
    // A link in place of a saved check is never followed.
    #[cfg(unix)]
    {
        let link = name.replace("PLAfict01", "PLAfict03");
        std::os::unix::fs::symlink(dir.join(&name), dir.join(&link)).unwrap();
        assert!(
            list_checks(&dir, System::B1, CHURCH)
                .unwrap()
                .iter()
                .all(|c| c.path_id != link)
        );
        assert_eq!(
            load_check(
                &dir,
                System::B1,
                CHURCH,
                &link,
                &crate::SessionNames::default()
            )
            .outcome,
            "not-found"
        );
        std::fs::remove_file(dir.join(&link)).unwrap();
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_newest_five_of_each_service_are_kept_and_deleting_removes_one_churchs() {
    let dir = saved_dir_for("keep");
    let clock = FixedClock::new();
    let names = crate::SessionNames::default();
    let mut saved = Vec::new();
    for _ in 0..7 {
        saved.push(save_check(&dir, &one_check("PLAfict01", &clock, &names)).unwrap());
        clock.sleep(Duration::from_secs(60));
    }
    save_check(&dir, &one_check("PLAfict02", &clock, &names)).unwrap();
    let listed = list_checks(&dir, System::B1, CHURCH).unwrap();
    assert_eq!(listed[0].service_id, "PLAfict02");
    // Newest first: the five newest of the first service; the two oldest are gone.
    let kept: Vec<&str> = listed[1..].iter().map(|c| c.path_id.as_str()).collect();
    let newest: Vec<&str> = saved
        .iter()
        .rev()
        .take(KEEP_SAVED)
        .map(String::as_str)
        .collect();
    assert_eq!(kept, newest);
    assert!(!dir.join(&saved[0]).exists() && !dir.join(&saved[1]).exists());
    // Another church's saved check stays when this church's are removed.
    let other = std::fs::read_to_string(dir.join(&listed[0].path_id))
        .unwrap()
        .replace(CHURCH, "CHUother");
    save_check(&dir, &other).unwrap();
    assert_eq!(delete_checks(&dir, System::B1, CHURCH), Ok(KEEP_SAVED + 1));
    assert!(list_checks(&dir, System::B1, CHURCH).unwrap().is_empty());
    assert_eq!(list_checks(&dir, System::B1, "CHUother").unwrap().len(), 1);
    assert_eq!(delete_checks(&dir, System::B1, "not an id"), Err("bad-id"));
    let _ = std::fs::remove_dir_all(&dir);
    // Nothing saved yet: an empty list, and nothing to delete.
    assert!(list_checks(&dir, System::B1, CHURCH).unwrap().is_empty());
    assert_eq!(delete_checks(&dir, System::B1, CHURCH), Ok(0));
}

#[test]
fn a_check_with_no_service_or_a_damaged_one_is_not_saved() {
    let dir = saved_dir_for("unsaved");
    assert!(save_check(&dir, "{}").is_err());
    let clock = FixedClock::new();
    let json = one_check("PLAfict01", &clock, &crate::SessionNames::default());
    let mut value: serde_json::Value = serde_json::from_str(&json).unwrap();
    value["service"] = serde_json::Value::Null;
    assert!(save_check(&dir, &value.to_string()).is_err());
    assert!(list_checks(&dir, System::B1, CHURCH).unwrap().is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}

/// A store whose reads wait until the test lets them go, as a Keychain read waits while macOS asks the person.
struct Waits {
    inner: MemoryStore,
    go: Mutex<std::sync::mpsc::Receiver<()>>,
}
impl CredentialStore for Waits {
    fn put(&self, w: &str, o: &str, v: &[u8]) -> Result<(), StoreError> {
        self.inner.put(w, o, v)
    }
    fn get(&self, w: &str, o: &str) -> Result<Option<Vec<u8>>, StoreError> {
        let _ = self.go.lock().unwrap().recv();
        self.inner.get(w, o)
    }
    fn delete(&self, w: &str, o: &str) -> Result<(), StoreError> {
        self.inner.delete(w, o)
    }
}

#[test]
fn a_keychain_call_waiting_on_macos_is_known_while_it_waits_and_forgotten_once_it_ends() {
    let watch = KeychainWatch::default();
    assert_eq!(watch.waiting_ms(), None);
    let (send, receive) = std::sync::mpsc::channel();
    let store = Waits {
        inner: MemoryStore::default(),
        go: Mutex::new(receive),
    };
    store
        .inner
        .put("local", CHURCH, b1_key_text().as_bytes())
        .unwrap();
    let watched = Watched {
        store,
        watch: &watch,
    };
    std::thread::scope(|scope| {
        let reading = scope.spawn(|| keys::read(&watched, System::B1, &id(CHURCH)));
        // While the read waits (as for macOS's question), the page can know a Keychain call is under way.
        while watch.waiting_ms().is_none() {
            std::thread::yield_now();
        }
        std::thread::sleep(Duration::from_millis(20));
        assert!(watch.waiting_ms().unwrap() >= 20);
        send.send(()).unwrap();
        assert!(reading.join().unwrap().unwrap().is_some());
    });
    assert_eq!(watch.waiting_ms(), None);
    // A call that ends with a refusal (Deny chosen) ends the wait too, and says why in one closed word.
    struct Refuses;
    impl CredentialStore for Refuses {
        fn put(&self, _: &str, _: &str, _: &[u8]) -> Result<(), StoreError> {
            Err(StoreError::Denied)
        }
        fn get(&self, _: &str, _: &str) -> Result<Option<Vec<u8>>, StoreError> {
            Err(StoreError::Denied)
        }
        fn delete(&self, _: &str, _: &str) -> Result<(), StoreError> {
            Err(StoreError::Denied)
        }
    }
    let refused = Watched {
        store: Refuses,
        watch: &watch,
    };
    let choices = choices_with(
        System::B1,
        CHURCH,
        None,
        &b1_church(),
        &FixedClock::new(),
        &Pacer::new(),
        &refused,
    );
    assert_eq!(choices.outcome, "denied");
    assert_eq!(watch.waiting_ms(), None);
}

#[test]
fn connecting_again_replaces_what_was_saved_for_that_church_rather_than_writing_into_it() {
    #[derive(Default)]
    struct Order(MemoryStore, Mutex<Vec<&'static str>>);
    impl CredentialStore for Order {
        fn put(&self, w: &str, o: &str, v: &[u8]) -> Result<(), StoreError> {
            self.1.lock().unwrap().push("put");
            self.0.put(w, o, v)
        }
        fn get(&self, w: &str, o: &str) -> Result<Option<Vec<u8>>, StoreError> {
            self.0.get(w, o)
        }
        fn delete(&self, w: &str, o: &str) -> Result<(), StoreError> {
            self.1.lock().unwrap().push("delete");
            self.0.delete(w, o)
        }
    }
    let store = Order::default();
    let done = connect(
        System::B1,
        Some("cedarhollow"),
        &b1_key_text(),
        &b1_church(),
        &store,
    );
    assert_eq!(done.outcome, "works");
    assert_eq!(*store.1.lock().unwrap(), vec!["delete", "put"]);
}

#[test]
fn a_check_of_a_church_let_go_of_is_not_saved_until_it_is_connected_again() {
    let let_go = LetGo::default();
    let mut saved = 0;
    assert!(let_go.save_unless_let_go(System::B1, CHURCH, || saved += 1));
    // Disconnected (or switched away from, or replaced): a check that ends afterwards writes nothing.
    let_go.let_go(System::B1, CHURCH);
    assert!(!let_go.save_unless_let_go(System::B1, CHURCH, || saved += 1));
    // Another church, or the same id in another system, is unaffected.
    assert!(let_go.save_unless_let_go(System::B1, "CHUother", || saved += 1));
    assert!(let_go.save_unless_let_go(System::Breeze, CHURCH, || saved += 1));
    // Connected again: saved again.
    let_go.taken_back(System::B1, CHURCH);
    assert!(let_go.save_unless_let_go(System::B1, CHURCH, || saved += 1));
    assert_eq!(saved, 4);
    // Deleting saved checks holds the same lock as a save.
    assert_eq!(let_go.while_held(|| 7), 7);
}

#[test]
fn the_keychain_wait_is_the_oldest_call_still_under_way() {
    let watch = KeychainWatch::default();
    let first = watch.begin();
    std::thread::sleep(Duration::from_millis(30));
    let second = watch.begin();
    // The first ends: what is left is the second's own wait, not the time since the first began.
    watch.end(first);
    assert!(watch.waiting_ms().unwrap() < 30);
    watch.end(second);
    assert_eq!(watch.waiting_ms(), None);
    // Ending a call twice, or one never begun, changes nothing.
    watch.end(second);
    watch.end(99);
    assert_eq!(watch.waiting_ms(), None);
}

/// Round 4, live on Breeze: the developer tool's item for the church was in the way and macOS refused to remove it
/// without showing anything. B1 Church and Breeze connect through the same save, so both say `in-the-way` (never
/// "locked"), keep nothing over it, and connect at once when the person's yes lets the removal through.
#[test]
fn an_older_key_another_program_saved_is_named_in_the_way_on_b1_and_breeze() {
    /// Lists its items like the Keychain, and removes only after the item was read (macOS asked) when `yes`.
    struct Theirs(MemoryStore, bool, Mutex<bool>);
    impl CredentialStore for Theirs {
        fn put(&self, w: &str, o: &str, v: &[u8]) -> Result<(), StoreError> {
            self.0.put(w, o, v)
        }
        fn get(&self, w: &str, o: &str) -> Result<Option<Vec<u8>>, StoreError> {
            *self.2.lock().unwrap() = true;
            self.0.get(w, o)
        }
        fn delete(&self, w: &str, o: &str) -> Result<(), StoreError> {
            if self.1 && *self.2.lock().unwrap() {
                self.0.delete(w, o)
            } else {
                Err(StoreError::Unavailable)
            }
        }
        fn accounts(&self) -> Result<Vec<(String, String)>, StoreError> {
            self.0.accounts()
        }
    }
    let theirs = |church: &str, yes: bool| {
        let store = Theirs(MemoryStore::default(), yes, Mutex::new(false));
        store
            .0
            .put("local", church, b"left by the developer tool")
            .unwrap();
        store
    };
    let host = "cedarhollow.breezechms.com";
    let breeze = || {
        FakeSystem::default().with(
            &format!("{host}/api/account/summary"),
            200,
            serde_json::json!({"id": "1234", "name": "Cedar Hollow Fellowship", "subdomain": "cedarhollow",
                "details": {"timezone": "America/Chicago"}}),
        )
    };
    for (system, text, http, church) in [
        (System::B1, b1_key_text(), b1_church(), CHURCH),
        (System::Breeze, breeze_key_text(), breeze(), "cedarhollow"),
    ] {
        let store = theirs(church, false);
        let done = connect(system, Some("cedarhollow"), &text, &http, &store);
        assert_eq!(done, Connected::failed("in-the-way"), "{system:?}");
        assert_eq!(
            store.0.get("local", church).unwrap(),
            Some(b"left by the developer tool".to_vec())
        );
        let store = theirs(church, true);
        let done = connect(system, Some("cedarhollow"), &text, &http, &store);
        assert_eq!(done.outcome, "works", "{system:?}");
        assert_eq!(
            store.0.get("local", church).unwrap(),
            Some(text.clone().into_bytes())
        );
    }
}
