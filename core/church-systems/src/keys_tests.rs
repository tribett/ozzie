use super::*;
use crate::test_support::{MemoryStore, id, key_text};

#[test]
fn each_system_has_its_own_keychain_service() {
    assert_eq!(service(System::B1), "church.ozzie.church-system.b1.v1");
    for system in System::all() {
        assert_eq!(
            service(system),
            format!("church.ozzie.church-system.{}.v1", system.word())
        );
        assert_eq!(keychain(system).service, service(system));
    }
}

#[test]
fn a_key_is_saved_read_and_forgotten_under_the_church_id() {
    let store = MemoryStore::default();
    let church = id("CHUfict01");
    let key = Key::parse(System::B1, &format!("  {}\n", key_text())).unwrap();
    save(&store, System::B1, &church, &key).unwrap();
    assert_eq!(
        store.0.lock().unwrap().keys().cloned().collect::<Vec<_>>(),
        vec![("local".to_owned(), "CHUfict01".to_owned())]
    );
    let back = read(&store, System::B1, &church).unwrap().unwrap();
    assert_eq!(back.secret(), key_text());
    assert_eq!(saved(&store).unwrap(), vec![church.clone()]);
    assert!(read(&store, System::B1, &id("CHUother")).unwrap().is_none());
    forget(&store, &church).unwrap();
    assert!(read(&store, System::B1, &church).unwrap().is_none());
    forget(&store, &church).unwrap();
    assert!(saved(&store).unwrap().is_empty());
}

#[test]
fn a_key_of_the_wrong_shape_is_refused_without_repeating_it() {
    let good = key_text();
    let wrong = [
        String::new(),
        good[..60].to_owned(),
        format!("{good}0"),
        good.replacen("cak_", "cek_", 1),
        good.replacen('.', "-", 1),
        format!("{}g{}", &good[..20], &good[21..]),
        format!("{}é{}", &good[..20], &good[22..]),
        good.replace('9', " "),
    ];
    for text in wrong {
        let error = Key::parse(System::B1, &text).unwrap_err();
        assert_eq!(error, KeyError::Format);
        let shown = format!("{error:?} {}", serde_json::to_string(&error).unwrap());
        assert!(!shown.contains(&good[13..30]));
    }
}

#[test]
fn what_is_saved_must_still_be_a_key() {
    let store = MemoryStore::default();
    let church = id("CHUfict01");
    store.0.lock().unwrap().insert(
        (WORKSPACE.to_owned(), "CHUfict01".to_owned()),
        b"not a key".to_vec(),
    );
    assert_eq!(
        read(&store, System::B1, &church).unwrap_err(),
        KeyError::Format
    );
    store.0.lock().unwrap().insert(
        (WORKSPACE.to_owned(), "CHUfict01".to_owned()),
        vec![0xff, 0xfe, 0x00],
    );
    assert_eq!(
        read(&store, System::B1, &church).unwrap_err(),
        KeyError::Format
    );
}

#[test]
fn a_key_prints_nothing_of_itself() {
    let key = Key::parse(System::B1, &key_text()).unwrap();
    let shown = format!("{key:?} {:#?}", key);
    assert!(!shown.contains(&key_text()[4..12]));
    assert!(!shown.contains(&key_text()[13..]));
    assert_eq!(format!("{key:?}"), "Key { .. }");
}

#[test]
fn store_errors_keep_their_closed_words() {
    use ozzie_native_auth::credentials::StoreError;
    assert_eq!(KeyError::from(StoreError::Locked), KeyError::Locked);
    assert_eq!(KeyError::from(StoreError::Denied), KeyError::Denied);
    assert_eq!(
        KeyError::from(StoreError::Unavailable),
        KeyError::Unavailable
    );
    assert_eq!(
        serde_json::to_string(&KeyError::Unsupported).unwrap(),
        "\"unsupported\""
    );
}

#[test]
fn a_breeze_key_is_refused_only_when_it_plainly_isnt_one() {
    let good = crate::test_support::breeze_key_text();
    assert!(Key::parse(System::Breeze, &good).is_ok());
    for bad in [
        String::new(),
        good[..15].to_owned(),
        format!("{good}.x"),
        good.replacen('e', " ", 1),
        "é".repeat(20),
        "x".repeat(129),
    ] {
        assert_eq!(
            Key::parse(System::Breeze, &bad).unwrap_err(),
            KeyError::Format
        );
    }
    // Another service's secret left on the clipboard is never sent to Breeze (review of 2026-11-19, M2).
    for start in [
        "sk-ant-api03-",
        "sk-or-v1-",
        "sk-proj-",
        "AIza",
        "ghp_",
        "github_pat_",
        "xoxb-",
        "cak_",
        "gk_live_",
        "pco_",
        "xapp-",
        "key-",
        "sbp_",
        "sb_secret_",
        "npm_",
        "lin_api_",
        "whsec_",
    ] {
        let text = format!("{start}{}", "Q".repeat(40));
        assert_eq!(
            Key::parse(System::Breeze, &text).unwrap_err(),
            KeyError::Format,
            "{start}"
        );
    }
    let store = MemoryStore::default();
    let key = Key::parse(System::Breeze, &good).unwrap();
    save(&store, System::Breeze, &id("cedarhollow"), &key).unwrap();
    assert_eq!(
        read(&store, System::Breeze, &id("cedarhollow"))
            .unwrap()
            .unwrap()
            .secret(),
        good
    );
    assert_eq!(
        keychain(System::Breeze).service,
        "church.ozzie.church-system.breeze.v1"
    );
}

#[test]
fn a_genesis_key_starts_gk_live() {
    let good = crate::test_support::genesis_key_text();
    assert!(Key::parse(System::Genesis, &good).is_ok());
    for bad in [
        good.replacen("live", "test", 1),
        good[..20].to_owned(),
        format!("{good}!"),
        good.replacen("gk_", "", 1),
        crate::test_support::key_text(),
    ] {
        assert_eq!(
            Key::parse(System::Genesis, &bad).unwrap_err(),
            KeyError::Format
        );
    }
}

/// The Genesis docs give the prefix only: any 16 or more letters, digits, `-` or `_` after it, the whole key at most
/// 512 characters.
#[test]
fn a_genesis_key_of_any_length_from_16_after_its_prefix_up_to_512_is_taken() {
    let prefix = ["gk_", "live_"].concat();
    let body = |n: usize| "aB3-_".repeat(n).chars().take(n).collect::<String>();
    for n in [16, 129, 300, 512 - prefix.len()] {
        assert!(
            Key::parse(System::Genesis, &format!("{prefix}{}", body(n))).is_ok(),
            "{n}"
        );
    }
    for n in [15, 512 - prefix.len() + 1] {
        assert_eq!(
            Key::parse(System::Genesis, &format!("{prefix}{}", body(n))).unwrap_err(),
            KeyError::Format,
            "{n}"
        );
    }
}

/// L7: a key is saved only in its own system's store, and a Genesis key isn't taken for a Breeze one.
#[test]
fn a_key_is_saved_only_for_its_own_system() {
    let store = MemoryStore::default();
    let genesis = crate::test_support::genesis_key();
    assert_eq!(
        save(&store, System::Breeze, &id("cedarhollow"), &genesis).unwrap_err(),
        KeyError::OtherSystem
    );
    assert!(store.0.lock().unwrap().is_empty());
    assert_eq!(
        Key::parse(System::Breeze, &crate::test_support::genesis_key_text()).unwrap_err(),
        KeyError::Format
    );
}

/// A store that records the order of calls, and can refuse to remove what is there. Its items live in `inner`'s map.
#[derive(Default)]
struct Calls {
    seen: std::sync::Mutex<Vec<&'static str>>,
    refuse_delete: Option<StoreError>,
    inner: MemoryStore,
}
type Slot = (String, String);
fn slot(w: &str, o: &str) -> Slot {
    (w.to_owned(), o.to_owned())
}
impl CredentialStore for Calls {
    fn put(&self, w: &str, o: &str, v: &[u8]) -> Result<(), StoreError> {
        self.seen.lock().unwrap().push("put");
        self.inner.0.lock().unwrap().insert(slot(w, o), v.to_vec());
        Ok(())
    }
    fn get(&self, w: &str, o: &str) -> Result<Option<Vec<u8>>, StoreError> {
        self.seen.lock().unwrap().push("get");
        Ok(self.inner.0.lock().unwrap().get(&slot(w, o)).cloned())
    }
    fn delete(&self, w: &str, o: &str) -> Result<(), StoreError> {
        self.seen.lock().unwrap().push("delete");
        if let Some(error) = self.refuse_delete {
            return Err(error);
        }
        self.inner.0.lock().unwrap().remove(&slot(w, o));
        Ok(())
    }
}
/// What another program left saved for the church.
fn left_behind(store: &Calls) {
    store.inner.0.lock().unwrap().insert(
        slot("local", "CHUfict01"),
        b"left by another program".to_vec(),
    );
}

#[test]
fn saving_removes_what_was_there_then_adds_a_new_item_and_never_keeps_another_programs() {
    let church = id("CHUfict01");
    let key = Key::parse(System::B1, &key_text()).unwrap();
    // An item for the same church already there (another program's, as far as Ozzie can tell): removed, then added anew.
    let store = Calls::default();
    left_behind(&store);
    save(&store, System::B1, &church, &key).unwrap();
    assert_eq!(*store.seen.lock().unwrap(), vec!["delete", "put"]);
    assert_eq!(
        read(&store.inner, System::B1, &church)
            .unwrap()
            .unwrap()
            .secret(),
        key_text()
    );
    // When the old one can't be removed (macOS refused, or the Mac is locked), nothing is written over it.
    for refused in [StoreError::Denied, StoreError::Locked] {
        let store = Calls {
            refuse_delete: Some(refused),
            ..Calls::default()
        };
        left_behind(&store);
        let error = save(&store, System::B1, &church, &key).unwrap_err();
        assert_eq!(error, KeyError::from(refused));
        assert_eq!(*store.seen.lock().unwrap(), vec!["delete"]);
        assert_eq!(
            store
                .inner
                .0
                .lock()
                .unwrap()
                .get(&slot("local", "CHUfict01"))
                .cloned(),
            Some(b"left by another program".to_vec())
        );
    }
}

/// A store like the Mac's Keychain holding an item another program made: it lists it (attributes only), but refuses
/// to remove it until the person says yes when macOS asks (`allows_after_asking`), or always (`never`). Each call is
/// recorded; `asked` holds what the read macOS asks about answers.
struct Theirs {
    seen: std::sync::Mutex<Vec<&'static str>>,
    removal: StoreError,
    /// Once read (macOS asked and the person answered), whether removing is allowed.
    allows_after_asking: bool,
    asked: Result<(), StoreError>,
    lists: bool,
    read_once: std::sync::Mutex<bool>,
    inner: MemoryStore,
}
impl Theirs {
    fn new(
        removal: StoreError,
        allows_after_asking: bool,
        asked: Result<(), StoreError>,
        lists: bool,
    ) -> Self {
        let store = Theirs {
            seen: Default::default(),
            removal,
            allows_after_asking,
            asked,
            lists,
            read_once: Default::default(),
            inner: MemoryStore::default(),
        };
        store.inner.0.lock().unwrap().insert(
            slot("local", "perlandera"),
            b"left by another program".to_vec(),
        );
        store
    }
    fn calls(&self) -> Vec<&'static str> {
        self.seen.lock().unwrap().clone()
    }
    fn kept(&self) -> Option<Vec<u8>> {
        self.inner
            .0
            .lock()
            .unwrap()
            .get(&slot("local", "perlandera"))
            .cloned()
    }
}
impl CredentialStore for Theirs {
    fn put(&self, w: &str, o: &str, v: &[u8]) -> Result<(), StoreError> {
        self.seen.lock().unwrap().push("put");
        self.inner.0.lock().unwrap().insert(slot(w, o), v.to_vec());
        Ok(())
    }
    fn get(&self, w: &str, o: &str) -> Result<Option<Vec<u8>>, StoreError> {
        self.seen.lock().unwrap().push("get");
        self.asked?;
        *self.read_once.lock().unwrap() = true;
        Ok(self.inner.0.lock().unwrap().get(&slot(w, o)).cloned())
    }
    fn delete(&self, w: &str, o: &str) -> Result<(), StoreError> {
        self.seen.lock().unwrap().push("delete");
        if !(self.allows_after_asking && *self.read_once.lock().unwrap()) {
            return Err(self.removal);
        }
        self.inner.0.lock().unwrap().remove(&slot(w, o));
        Ok(())
    }
    fn accounts(&self) -> Result<Vec<(String, String)>, StoreError> {
        if self.lists {
            Ok(self.inner.0.lock().unwrap().keys().cloned().collect())
        } else {
            Err(StoreError::Unavailable)
        }
    }
}

/// Round 4, live on Breeze: the developer tool's item for the church was there, macOS refused to remove it without
/// showing anything, and the page said "unlock this Mac", which could never help. Each way that ends, told apart.
#[test]
fn an_older_key_another_program_saved_is_told_apart_from_a_locked_mac() {
    let church = id("perlandera");
    let key = Key::parse(System::Breeze, &"k".repeat(40)).unwrap();
    // macOS asks (Ozzie reads the old item once), the person allows it, and the removal goes through: Ozzie's own item.
    for removal in [StoreError::Unavailable, StoreError::Locked] {
        let store = Theirs::new(removal, true, Ok(()), true);
        save(&store, System::Breeze, &church, &key).unwrap();
        assert_eq!(
            store.calls(),
            vec!["delete", "get", "delete", "put"],
            "{removal:?}"
        );
        assert_eq!(store.kept(), Some("k".repeat(40).into_bytes()));
    }
    // Still refused after asking (macOS never lets a non-owner remove it): in the way, and nothing is written over it.
    for removal in [StoreError::Unavailable, StoreError::Locked] {
        let store = Theirs::new(removal, false, Ok(()), true);
        assert_eq!(
            save(&store, System::Breeze, &church, &key).unwrap_err(),
            KeyError::InTheWay
        );
        assert_eq!(store.calls(), vec!["delete", "get", "delete"]);
        assert_eq!(store.kept(), Some(b"left by another program".to_vec()));
    }
    // The person said no when macOS asked, or the read failed some other way: in the way, never retried.
    for answer in [StoreError::Denied, StoreError::Unavailable] {
        let store = Theirs::new(StoreError::Unavailable, true, Err(answer), true);
        assert_eq!(
            save(&store, System::Breeze, &church, &key).unwrap_err(),
            KeyError::InTheWay
        );
        assert_eq!(store.calls(), vec!["delete", "get"]);
        assert_eq!(store.kept(), Some(b"left by another program".to_vec()));
    }
    // The person chose Deny when macOS asked about the removal itself: their answer, never asked again.
    let store = Theirs::new(StoreError::Denied, true, Ok(()), true);
    assert_eq!(
        save(&store, System::Breeze, &church, &key).unwrap_err(),
        KeyError::Denied
    );
    assert_eq!(store.calls(), vec!["delete"]);
    // The Keychain stayed locked when Ozzie read it (macOS couldn't ask): locked, as the Mac's own state.
    let store = Theirs::new(StoreError::Locked, true, Err(StoreError::Locked), true);
    assert_eq!(
        save(&store, System::Breeze, &church, &key).unwrap_err(),
        KeyError::Locked
    );
    // Nothing listed for the church (or a store that can't list): the refusal's own word, nothing read.
    for removal in [
        StoreError::Locked,
        StoreError::Unavailable,
        StoreError::Denied,
    ] {
        let store = Theirs::new(removal, true, Ok(()), false);
        assert_eq!(
            save(&store, System::Breeze, &church, &key).unwrap_err(),
            KeyError::from(removal)
        );
        assert_eq!(store.calls(), vec!["delete"]);
    }
    // The closed word never carries the key.
    let shown = serde_json::to_string(&KeyError::InTheWay).unwrap();
    assert_eq!(shown, "\"in-the-way\"");
}
