//! Lists the leader adds from this Mac, as native code keeps and reads them: a file read only when it is a regular
//! file of text within 2 MB (links, folders, packages and pipes refused, as card photos are), a list file readable by
//! this user only and refused whole when damaged, a change from the page made plain and checked whole, and the file's
//! path in no reply. Fictional files only, in a scratch folder removed afterwards.
//!
//! Private links to published sheets through the links' real store (core/native-auth sheet_link.rs) with a stand-in
//! Keychain and a stand-in for the guarded GET: no network and no real Keychain. Fictional addresses only.
use super::*;
use ozzie_native_auth::credentials::{CredentialStore, StoreError};

/// A folder of fictional test files, removed afterwards.
struct Scratch(PathBuf);
impl Scratch {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "ozzie-church-sources-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
    fn file(&self, name: &str, bytes: &[u8]) -> PathBuf {
        let path = self.0.join(name);
        std::fs::write(&path, bytes).unwrap();
        path
    }
    /// The list kept in a data folder of its own inside the scratch folder.
    fn sources(&self) -> Sources {
        Sources::new(self.0.join("data").join(LIST_FILE), self.refused())
    }
    /// The scratch folder as the home folder, with its own Library folder, and Ozzie's data and cache folders in it.
    fn refused(&self) -> Refused {
        Refused::for_this_mac(&self.0, [self.0.join("data"), self.0.join("caches")])
    }
    fn read(&self, path: &Path) -> Result<Vec<u8>, SourceError> {
        read_source_file(path, &self.refused(), MAX_SOURCE_BYTES)
    }
    fn list_path(&self) -> PathBuf {
        self.0.join("data").join(LIST_FILE)
    }
    /// The private links' store as the app makes it (sheet_link.rs), with a stand-in Keychain and fetch, its list
    /// beside this one in the data folder.
    fn links(&self, keychain: &Arc<Keychain>, fetch: &Arc<Fetch>) -> SheetLinks {
        sheet_link::sheet_links(keychain.clone(), self.links_path(), fetch.clone())
    }
    fn links_path(&self) -> PathBuf {
        self.0.join("data").join(sheet_link::LIST_FILE)
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A stand-in for this Mac's Keychain: items by (workspace, id); `refusing` makes every call fail as macOS can.
#[derive(Default)]
struct Keychain {
    items: Mutex<std::collections::BTreeMap<(String, String), Vec<u8>>>,
    refusing: Mutex<Option<StoreError>>,
}
impl Keychain {
    fn items(&self) -> Vec<((String, String), Vec<u8>)> {
        self.items
            .lock()
            .unwrap()
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }
    fn refuse(&self, error: Option<StoreError>) {
        *self.refusing.lock().unwrap() = error;
    }
    fn check(&self) -> Result<(), StoreError> {
        self.refusing.lock().unwrap().map_or(Ok(()), Err)
    }
}
impl CredentialStore for Keychain {
    fn put(&self, workspace: &str, id: &str, value: &[u8]) -> Result<(), StoreError> {
        self.check()?;
        self.items
            .lock()
            .unwrap()
            .insert((workspace.into(), id.into()), value.to_vec());
        Ok(())
    }
    fn get(&self, workspace: &str, id: &str) -> Result<Option<Vec<u8>>, StoreError> {
        self.check()?;
        Ok(self
            .items
            .lock()
            .unwrap()
            .get(&(workspace.into(), id.into()))
            .cloned())
    }
    fn delete(&self, workspace: &str, id: &str) -> Result<(), StoreError> {
        self.check()?;
        self.items
            .lock()
            .unwrap()
            .remove(&(workspace.into(), id.into()));
        Ok(())
    }
    fn accounts(&self) -> Result<Vec<(String, String)>, StoreError> {
        self.check()?;
        Ok(self.items.lock().unwrap().keys().cloned().collect())
    }
}
/// What the stand-in fetch gives back for an address.
type Answer = Box<dyn Fn(&Url) -> Result<Vec<u8>, LinkError> + Send>;
/// A stand-in for the guarded GET: what it gives back for each address asked, and every address asked. No network.
struct Fetch {
    answer: Mutex<Answer>,
    asked: Mutex<Vec<String>>,
}
impl Fetch {
    fn answering(answer: Result<&[u8], LinkError>) -> Arc<Self> {
        let answer = answer.map(<[u8]>::to_vec);
        Arc::new(Self {
            answer: Mutex::new(Box::new(move |_| answer.clone())),
            asked: Mutex::default(),
        })
    }
    fn set(&self, answer: Result<&[u8], LinkError>) {
        let answer = answer.map(<[u8]>::to_vec);
        self.with(move |_| answer.clone());
    }
    fn with(&self, answer: impl Fn(&Url) -> Result<Vec<u8>, LinkError> + Send + 'static) {
        *self.answer.lock().unwrap() = Box::new(answer);
    }
    fn asked(&self) -> Vec<String> {
        self.asked.lock().unwrap().clone()
    }
}
impl SheetFetch for Fetch {
    fn get(&self, url: &Url) -> Result<Fetched, LinkError> {
        self.asked.lock().unwrap().push(url.to_string());
        let body = (self.answer.lock().unwrap())(url)?;
        Ok(Fetched {
            content_type: Some("text/csv; charset=utf-8".into()),
            body,
        })
    }
}

/// A published sheet's private address (fictional): anyone holding it can read the sheet, so no part of it after the
/// host may show anywhere but the Keychain.
const ADDRESS: &str =
    "https://sheets.fictional-church.example/d/e/2PACX-QZXSECRET0123456789/pub?gid=0&output=csv";
const ADDRESS_PARTS: [&str; 4] = ["2PACX-QZXSECRET0123456789", "/d/e/", "gid=0", "output=csv"];
const HOST_SHOWN: &str = "sheets.fictional-church.example/\u{2022}\u{2022}\u{2022}";
fn holds_address(text: &str) -> bool {
    text.contains(ADDRESS) || ADDRESS_PARTS.iter().any(|p| text.contains(p))
}
/// The Keychain's items for sheet links: (id, address).
fn kept_addresses(keychain: &Keychain) -> Vec<(String, String)> {
    keychain
        .items()
        .into_iter()
        .filter(|((workspace, _), _)| workspace == sheet_link::KEYCHAIN_WORKSPACE)
        .map(|((_, id), value)| (id, String::from_utf8(value).unwrap()))
        .collect()
}
/// Everything a reply, a refusal or a debug form could hold, as text.
fn shown<T: serde::Serialize + std::fmt::Debug>(value: &T) -> String {
    format!(
        "{} {value:?}",
        serde_json::to_string(value).unwrap_or_default()
    )
}

const CSV: &[u8] = b"Name,Team,Door\r\nAvery Brightwater,Greeter,East door\r\nBlake Ashgrove,Nursery,West door\r\n";
const NOW: &str = "2026-11-20T15:05:00.000Z";
fn ids() -> impl Fn() -> Result<String, SourceError> {
    let n = std::cell::Cell::new(0u32);
    move || {
        n.set(n.get() + 1);
        Ok(format!("src-{}", n.get()))
    }
}
fn ch(code: u32) -> char {
    char::from_u32(code).unwrap()
}
fn change(label: &str) -> SourceChange {
    SourceChange {
        label: label.into(),
        column: Some("Team".into()),
        ticked: vec!["Name".into(), "Door".into()],
        matches: vec![
            MatchInput {
                value: "Greeter".into(),
                team_id: "7593350".into(),
                position_name: Some("Greeter".into()),
            },
            MatchInput {
                value: "Nursery".into(),
                team_id: "7593352".into(),
                position_name: None,
            },
        ],
    }
}

#[test]
fn a_text_file_is_read_whatever_its_name_and_utf16_may_hold_nul_bytes() {
    let dir = Scratch::new("read");
    assert_eq!(dir.read(&dir.file("keys.csv", CSV)), Ok(CSV.to_vec()));
    assert_eq!(dir.read(&dir.file("keys", CSV)), Ok(CSV.to_vec()));
    assert_eq!(dir.read(&dir.file("empty.csv", b"")), Ok(Vec::new()));
    // UTF-16 has a NUL in every ASCII letter; with its byte-order mark it is text.
    let mut le = vec![0xff, 0xfe];
    le.extend("Name,Team\r\n".encode_utf16().flat_map(u16::to_le_bytes));
    assert_eq!(dir.read(&dir.file("le.csv", &le)), Ok(le.clone()));
    let mut be = vec![0xfe, 0xff];
    be.extend("Name,Team\r\n".encode_utf16().flat_map(u16::to_be_bytes));
    assert_eq!(dir.read(&dir.file("be.csv", &be)), Ok(be.clone()));
}

#[test]
fn a_workbook_or_anything_with_a_nul_byte_is_refused_even_named_csv() {
    let dir = Scratch::new("refused");
    for (name, bytes, error) in [
        // An .xlsx or .numbers file is a ZIP; an empty ZIP starts with its end record.
        (
            "people.csv",
            b"PK\x03\x04\x14\x00\x06\x00".to_vec(),
            SourceError::Workbook,
        ),
        (
            "empty-zip.csv",
            b"PK\x05\x06\x00\x00\x00\x00".to_vec(),
            SourceError::Workbook,
        ),
        // An older Excel file (.xls).
        (
            "old.csv",
            vec![0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0],
            SourceError::Workbook,
        ),
        (
            "binary.csv",
            b"Name,Team\n\x00\x01\x02".to_vec(),
            SourceError::NotText,
        ),
        (
            "utf8-bom-nul.csv",
            b"\xef\xbb\xbfName\x00".to_vec(),
            SourceError::NotText,
        ),
    ] {
        assert_eq!(dir.read(&dir.file(name, &bytes)), Err(error), "{name}");
    }
}

#[test]
fn links_folders_packages_and_pipes_are_never_read() {
    let dir = Scratch::new("special");
    let real = dir.file("keys.csv", CSV);
    let link = dir.0.join("link.csv");
    std::os::unix::fs::symlink(&real, &link).unwrap();
    // An alias of the file says so (review S, L4), rather than that the file is gone.
    assert_eq!(dir.read(&link), Err(SourceError::NotTheFile));
    // A package looks like one file in the panel but is a folder.
    let package = dir.0.join("Keys.numbers");
    std::fs::create_dir(&package).unwrap();
    assert_eq!(dir.read(&package), Err(SourceError::FileMissing));
    let pipe = dir.0.join("pipe.csv");
    let made = std::process::Command::new("/usr/bin/mkfifo")
        .arg(&pipe)
        .status()
        .unwrap();
    assert!(made.success());
    // Refused without ever waiting for a writer.
    assert_eq!(dir.read(&pipe), Err(SourceError::FileMissing));
    assert_eq!(
        dir.read(&dir.0.join("missing.csv")),
        Err(SourceError::FileMissing)
    );
}

#[test]
fn a_file_over_2_mb_is_refused_before_it_is_read() {
    let dir = Scratch::new("large");
    assert_eq!(MAX_SOURCE_BYTES, 2_097_152);
    let mut limit = CSV.to_vec();
    limit.resize(MAX_SOURCE_BYTES as usize, b'a');
    assert_eq!(
        dir.read(&dir.file("limit.csv", &limit)).map(|b| b.len()),
        Ok(limit.len())
    );
    limit.push(b'a');
    assert_eq!(
        dir.read(&dir.file("over.csv", &limit)),
        Err(SourceError::TooLarge)
    );
}

#[test]
fn adding_a_file_keeps_its_name_and_path_on_this_mac_and_the_page_never_sees_the_path() {
    let dir = Scratch::new("add");
    let path = dir.file("Key holders (2026).csv", CSV);
    let sources = dir.sources();
    let added = sources.add(&path, ids()).unwrap();
    let json = serde_json::to_value(&added).unwrap();
    assert_eq!(
        json,
        serde_json::json!({ "id": "src-1", "kind": "file", "label": "Key holders (2026)", "shown": "Key holders (2026).csv",
            "column": null, "ticked": [], "matches": {}, "read_at": null })
    );
    // Choosing the same file again is the list already there.
    assert_eq!(sources.add(&path, ids()).unwrap(), added);
    // Every reply the page can get: the list, a change, a read; and every refusal.
    let set = sources.set("src-1", change("Key holders")).unwrap();
    let read = sources.read("src-1", || NOW.into()).unwrap();
    assert_eq!(read, CSV);
    let listed = sources.list().unwrap();
    let errors = [
        SourceError::FileMissing,
        SourceError::NotAllowed,
        SourceError::NotTheFile,
        SourceError::PrivatePlace,
        SourceError::ListUnreadable,
        SourceError::TooLarge,
        SourceError::Workbook,
        SourceError::NotText,
        SourceError::Unavailable,
    ];
    let replies = serde_json::to_string(&(&added, &set, &listed, &errors)).unwrap();
    let folder = dir.0.to_string_lossy().into_owned();
    for secret in [
        &*path.to_string_lossy(),
        folder.as_str(),
        "ozzie-church-sources-add",
    ] {
        assert!(!replies.contains(secret), "{secret}");
        assert!(!String::from_utf8_lossy(&read).contains(secret));
    }
    // The path is kept natively, in the list file only.
    let kept = std::fs::read_to_string(dir.list_path()).unwrap();
    assert!(kept.contains(&*path.to_string_lossy()));
    assert_eq!(listed[0].read_at(), Some(NOW));
    let as_page = serde_json::to_value(&listed).unwrap();
    assert_eq!(
        as_page[0]["matches"],
        serde_json::json!({ "Greeter": { "team_id": "7593350", "position_name": "Greeter" }, "Nursery": { "team_id": "7593352" } })
    );
    assert_eq!(as_page[0]["ticked"], serde_json::json!(["Name", "Door"]));
}

#[test]
fn a_workbook_or_a_link_is_refused_when_chosen_and_nothing_is_added() {
    let dir = Scratch::new("add-refused");
    let sources = dir.sources();
    let book = dir.file("people.csv", b"PK\x03\x04rest");
    assert_eq!(sources.add(&book, ids()), Err(SourceError::Workbook));
    let link = dir.0.join("link.csv");
    std::os::unix::fs::symlink(dir.file("keys.csv", CSV), &link).unwrap();
    assert_eq!(sources.add(&link, ids()), Err(SourceError::NotTheFile));
    assert_eq!(sources.list(), Ok(Vec::new()));
    assert!(!dir.list_path().exists());
}

#[test]
fn at_most_20_lists_each_with_its_own_id() {
    let dir = Scratch::new("many");
    let sources = dir.sources();
    let next = ids();
    for n in 0..MAX_SOURCES {
        sources
            .add(&dir.file(&format!("list-{n}.csv"), CSV), &next)
            .unwrap();
    }
    assert_eq!(
        sources.add(&dir.file("one-more.csv", CSV), &next),
        Err(SourceError::Unavailable)
    );
    let listed = serde_json::to_value(sources.list().unwrap()).unwrap();
    let mut seen: Vec<&str> = listed
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["id"].as_str().unwrap())
        .collect();
    seen.dedup();
    assert_eq!(seen.len(), MAX_SOURCES);
    // A random id is 16 hex characters, and an id that collides is drawn again.
    let id = random_id().unwrap();
    assert!(id.len() == 16 && id.bytes().all(|b| b.is_ascii_hexdigit()));
    let other = Scratch::new("collide");
    let s = other.sources();
    s.add(&other.file("a.csv", CSV), || Ok("same".into()))
        .unwrap();
    let draws = std::cell::Cell::new(0);
    let added = s
        .add(&other.file("b.csv", CSV), || {
            draws.set(draws.get() + 1);
            Ok(if draws.get() == 1 {
                "same".into()
            } else {
                "fresh".into()
            })
        })
        .unwrap();
    assert_eq!(serde_json::to_value(added).unwrap()["id"], "fresh");
}

#[test]
fn the_list_is_readable_by_this_user_only_and_replaced_whole() {
    use std::os::unix::fs::PermissionsExt;
    let dir = Scratch::new("mode");
    let sources = dir.sources();
    sources.add(&dir.file("keys.csv", CSV), ids()).unwrap();
    let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(&dir.list_path()), 0o600);
    assert_eq!(mode(dir.list_path().parent().unwrap()), 0o700);
    sources.set("src-1", change("Key holders")).unwrap();
    assert_eq!(mode(&dir.list_path()), 0o600);
    assert!(!dir.list_path().with_extension("partial").exists());
    let kept: serde_json::Value =
        serde_json::from_slice(&std::fs::read(dir.list_path()).unwrap()).unwrap();
    assert_eq!(kept["version"], 1);
    assert_eq!(kept["sources"][0]["label"], "Key holders");
}

#[test]
fn a_damaged_or_newer_list_is_refused_whole_and_never_written_over() {
    let dir = Scratch::new("damaged");
    let file = dir.file("keys.csv", CSV);
    let good = || {
        serde_json::json!({ "id": "src-1", "kind": "file", "label": "Key holders", "shown": "keys.csv", "path": file.to_string_lossy(),
            "column": "Team", "ticked": ["Name"], "matches": [{ "value": "Greeter", "team_id": "7593350" }], "read_at": NOW })
    };
    let with = |key: &str, value: serde_json::Value| {
        let mut entry = good();
        entry[key] = value;
        serde_json::json!({ "version": 1, "sources": [entry] }).to_string()
    };
    let bidi = format!("Key{}holders", ch(0x202e));
    let mut cases: Vec<String> = vec![
        "not json".into(),
        "{}".into(),
        serde_json::json!({ "version": 2, "sources": [good()] }).to_string(),
        serde_json::json!({ "version": 1, "sources": [good()], "extra": true }).to_string(),
        serde_json::json!({ "version": 1, "sources": [good(), good()] }).to_string(),
        serde_json::json!({ "version": 1, "sources": (0..=MAX_SOURCES).map(|n| {
            let mut entry = good();
            entry["id"] = format!("s{n}").into();
            entry
        }).collect::<Vec<_>>() })
        .to_string(),
        with("id", "a/b".into()),
        with("kind", "link".into()),
        with("label", "".into()),
        with("label", "Key  holders".into()),
        with("label", bidi.into()),
        with("label", "x".repeat(MAX_LABEL + 1).into()),
        with("shown", "".into()),
        with("path", "relative/keys.csv".into()),
        with("column", "".into()),
        with("ticked", serde_json::json!(["Name", "Name"])),
        with(
            "ticked",
            serde_json::json!(["A", "B", "C", "D", "E", "F", "G", "H", "I"]),
        ),
        with(
            "matches",
            serde_json::json!([{ "value": "Greeter", "team_id": "0" }]),
        ),
        with(
            "matches",
            serde_json::json!([{ "value": "Greeter", "team_id": "team" }]),
        ),
        with(
            "matches",
            serde_json::json!([{ "value": "Greeter", "team_id": "1" }, { "value": "Greeter", "team_id": "2" }]),
        ),
        with(
            "matches",
            serde_json::json!([{ "value": "Greeter", "team_id": "1", "position_name": "" }]),
        ),
        with(
            "matches",
            serde_json::json!([{ "value": "Greeter", "team_id": "1", "position_id": "position:1" }]),
        ),
        with(
            "matches",
            serde_json::json!({ "Greeter": { "team_id": "1" } }),
        ),
        with("read_at", "yesterday".into()),
        with("read_at", "2026-13-45T25:00:00.000Z".into()),
    ];
    let mut extra = good();
    extra["secret"] = "x".into();
    cases.push(serde_json::json!({ "version": 1, "sources": [extra] }).to_string());
    std::fs::create_dir_all(dir.list_path().parent().unwrap()).unwrap();
    // The good list reads, so each case below is refused for its own fault.
    std::fs::write(
        dir.list_path(),
        serde_json::json!({ "version": 1, "sources": [good()] }).to_string(),
    )
    .unwrap();
    assert_eq!(dir.sources().list().map(|l| l.len()), Ok(1));
    for text in cases {
        std::fs::write(dir.list_path(), &text).unwrap();
        let sources = dir.sources();
        assert_eq!(sources.list(), Err(SourceError::ListUnreadable), "{text}");
        assert_eq!(
            sources.add(&file, ids()),
            Err(SourceError::ListUnreadable),
            "{text}"
        );
        assert_eq!(
            sources.set("src-1", change("Keys")),
            Err(SourceError::ListUnreadable),
            "{text}"
        );
        assert_eq!(
            sources.read("src-1", || NOW.into()),
            Err(SourceError::ListUnreadable),
            "{text}"
        );
        assert_eq!(
            sources.remove("src-1"),
            Err(SourceError::ListUnreadable),
            "{text}"
        );
        // Nothing was written over.
        assert_eq!(std::fs::read_to_string(dir.list_path()).unwrap(), text);
    }
    // Too large to be a list.
    std::fs::write(dir.list_path(), vec![b' '; MAX_LIST_BYTES as usize + 1]).unwrap();
    assert_eq!(dir.sources().list(), Err(SourceError::ListUnreadable));
    // "Forget all lists" is the way out.
    let links = dir.links(&Arc::new(Keychain::default()), &Fetch::answering(Ok(CSV)));
    assert_eq!(dir.sources().forget_all(&links), Ok(()));
    assert_eq!(dir.sources().list(), Ok(Vec::new()));
    assert_eq!(dir.sources().forget_all(&links), Ok(()));
}

#[test]
fn a_change_from_the_page_is_made_plain_and_checked_whole() {
    let dir = Scratch::new("set");
    let sources = dir.sources();
    sources.add(&dir.file("keys.csv", CSV), ids()).unwrap();
    // Plain: format characters out, line breaks and runs of spaces as one space, cut at each limit.
    let messy = SourceChange {
        label: format!("  Key{}\nholders{} ", ch(0x202e), ch(0x200b)),
        column: Some(format!("Te{}am", ch(0xfeff))),
        ticked: vec!["Na\tme".into(), "x".repeat(200)],
        matches: vec![MatchInput {
            value: format!("Door{}greeters", ch(0x2028)),
            team_id: "7593350".into(),
            position_name: Some(format!("{}Door greeter", ch(0x202d))),
        }],
    };
    let view = serde_json::to_value(sources.set("src-1", messy).unwrap()).unwrap();
    assert_eq!(view["label"], "Key holders");
    assert_eq!(view["column"], "Team");
    assert_eq!(
        view["ticked"],
        serde_json::json!(["Na me", "x".repeat(MAX_HEADER)])
    );
    assert_eq!(
        view["matches"],
        serde_json::json!({ "Door greeters": { "team_id": "7593350", "position_name": "Door greeter" } })
    );
    let refused: Vec<(&str, SourceChange)> = vec![
        (
            "an empty label",
            SourceChange {
                label: format!(" {} ", ch(0x200b)),
                ..change("")
            },
        ),
        (
            "an empty column",
            SourceChange {
                column: Some("  ".into()),
                ..change("Keys")
            },
        ),
        (
            "nine columns",
            SourceChange {
                ticked: (0..9).map(|n| format!("C{n}")).collect(),
                ..change("Keys")
            },
        ),
        (
            "a column twice",
            SourceChange {
                ticked: vec!["Name".into(), " Name".into()],
                ..change("Keys")
            },
        ),
        (
            "an empty column shown",
            SourceChange {
                ticked: vec!["".into()],
                ..change("Keys")
            },
        ),
        (
            "a team id that isn't one",
            SourceChange {
                matches: vec![MatchInput {
                    value: "Greeter".into(),
                    team_id: "0123".into(),
                    position_name: None,
                }],
                ..change("Keys")
            },
        ),
        (
            "a team id with a space",
            SourceChange {
                matches: vec![MatchInput {
                    value: "Greeter".into(),
                    team_id: " 123".into(),
                    position_name: None,
                }],
                ..change("Keys")
            },
        ),
        (
            "an empty value",
            SourceChange {
                matches: vec![MatchInput {
                    value: ch(0x200b).to_string(),
                    team_id: "123".into(),
                    position_name: None,
                }],
                ..change("Keys")
            },
        ),
        (
            "an empty position",
            SourceChange {
                matches: vec![MatchInput {
                    value: "Greeter".into(),
                    team_id: "123".into(),
                    position_name: Some(" ".into()),
                }],
                ..change("Keys")
            },
        ),
        (
            "a value twice",
            SourceChange {
                matches: vec![
                    MatchInput {
                        value: "Greeter".into(),
                        team_id: "1".into(),
                        position_name: None,
                    },
                    MatchInput {
                        value: "Greeter ".into(),
                        team_id: "2".into(),
                        position_name: None,
                    },
                ],
                ..change("Keys")
            },
        ),
        (
            "too many matches",
            SourceChange {
                matches: (0..=MAX_MATCHES)
                    .map(|n| MatchInput {
                        value: format!("v{n}"),
                        team_id: "1".into(),
                        position_name: None,
                    })
                    .collect(),
                ..change("Keys")
            },
        ),
    ];
    let before = std::fs::read_to_string(dir.list_path()).unwrap();
    for (what, bad) in refused {
        assert_eq!(
            sources.set("src-1", bad),
            Err(SourceError::Unavailable),
            "{what}"
        );
    }
    // Refused whole: the list is as it was.
    assert_eq!(std::fs::read_to_string(dir.list_path()).unwrap(), before);
    // An id that isn't one, or a list that isn't there.
    for id in ["", "../keys", "src 1", &"x".repeat(65), "src-9"] {
        assert_eq!(
            sources.set(id, change("Keys")),
            Err(SourceError::Unavailable),
            "{id}"
        );
        assert_eq!(
            sources.read(id, || NOW.into()),
            Err(SourceError::Unavailable),
            "{id}"
        );
    }
    // A match keeps the page's own key form exactly, even a value named like a built-in property.
    let proto = SourceChange {
        matches: vec![MatchInput {
            value: "__proto__".into(),
            team_id: "9".into(),
            position_name: None,
        }],
        ..change("Keys")
    };
    let view = serde_json::to_string(&sources.set("src-1", proto).unwrap()).unwrap();
    assert!(
        view.contains(r#""matches":{"__proto__":{"team_id":"9"}}"#),
        "{view}"
    );
    // Unknown fields from the page are refused before anything is set.
    assert!(
        serde_json::from_value::<MatchInput>(
            serde_json::json!({ "value": "x", "team_id": "1", "path": "/etc" })
        )
        .is_err()
    );
}

#[test]
fn a_moved_or_replaced_file_reads_as_file_missing_and_the_list_stays() {
    let dir = Scratch::new("moved");
    let sources = dir.sources();
    let path = dir.file("keys.csv", CSV);
    sources.add(&path, ids()).unwrap();
    std::fs::rename(&path, dir.0.join("elsewhere.csv")).unwrap();
    assert_eq!(
        sources.read("src-1", || NOW.into()),
        Err(SourceError::FileMissing)
    );
    // A link put where it was is not followed, and says so.
    std::os::unix::fs::symlink(dir.0.join("elsewhere.csv"), &path).unwrap();
    assert_eq!(
        sources.read("src-1", || NOW.into()),
        Err(SourceError::NotTheFile)
    );
    std::fs::remove_file(&path).unwrap();
    std::fs::create_dir(&path).unwrap();
    assert_eq!(
        sources.read("src-1", || NOW.into()),
        Err(SourceError::FileMissing)
    );
    // Still listed, never read, until the leader removes it.
    let listed = serde_json::to_value(sources.list().unwrap()).unwrap();
    assert_eq!(listed[0]["read_at"], serde_json::Value::Null);
    assert_eq!(sources.remove("src-1"), Ok(()));
    assert_eq!(sources.remove("src-1"), Ok(()));
    assert_eq!(sources.list(), Ok(Vec::new()));
    // The file itself is never touched by removing or forgetting.
    assert!(dir.0.join("elsewhere.csv").exists());
}

/// Review S, L2: never the Library folder (iCloud Drive and the cloud drives aside), a hidden file or folder, or
/// Ozzie's own folders, whether chosen or named by a list something else wrote, and however the path leads there.
#[test]
fn private_places_are_never_read_whether_chosen_or_in_a_planted_list() {
    let dir = Scratch::new("places");
    let made = |parts: &[&str]| {
        let folder = parts.iter().fold(dir.0.clone(), |p, part| p.join(part));
        std::fs::create_dir_all(&folder).unwrap();
        folder.join("keys.csv")
    };
    let write = |path: &PathBuf| {
        std::fs::write(path, CSV).unwrap();
        path.clone()
    };
    let refused = [
        write(&made(&["Library", "Application Support", "Some App"])),
        write(&made(&["Library", "Mail"])),
        write(&made(&["data"])),
        write(&made(&["caches", "church.ozzie.desktop"])),
        write(&made(&[".ssh"])),
        write(&made(&["Documents", ".hidden"])),
        write(&made(&["Documents"]).with_file_name(".keys.csv")),
        // Hidden in iCloud Drive is still hidden, in its own folder or an app's.
        write(&made(&[
            "Library",
            "Mobile Documents",
            "com~apple~CloudDocs",
            ".Trash",
        ])),
        write(&made(&[
            "Library",
            "Mobile Documents",
            "com~apple~Numbers",
            ".Documents",
        ])),
        write(&made(&["Library", "Mobile Documents", ".Trash"])),
        // Beside iCloud Drive in the Library folder, not in it.
        write(&made(&["Library", "Mobile Documents Backup"])),
        // Review U, note 2: apps' private containers in iCloud, and an app's container outside its Documents folder.
        write(&made(&["Library", "Mobile Documents", "com~apple~mail"])),
        write(&made(&[
            "Library",
            "Mobile Documents",
            "com~apple~TextInput",
            "Data",
        ])),
        write(&made(&["Library", "Mobile Documents", "com~apple~Numbers"])),
        write(&made(&["Library", "Mobile Documents"])),
    ];
    // The same places by another way: a step back up, another case, and a link to the folder on the way.
    let mut other_ways = vec![
        dir.0
            .join("Documents")
            .join("..")
            .join("Library")
            .join("Mail")
            .join("keys.csv"),
        dir.0.join("LIBRARY").join("Mail").join("keys.csv"),
    ];
    std::os::unix::fs::symlink(
        dir.0.join("Library"),
        dir.0.join("Documents").join("shortcut"),
    )
    .unwrap();
    other_ways.push(
        dir.0
            .join("Documents")
            .join("shortcut")
            .join("Mail")
            .join("keys.csv"),
    );
    let readable = [
        write(&made(&["Documents"])),
        write(&made(&[
            "Library",
            "Mobile Documents",
            "com~apple~CloudDocs",
            "Church",
        ])),
        // Review S2, finding 2: an app's own folder in iCloud Drive (Numbers exports there by default).
        write(&made(&[
            "Library",
            "Mobile Documents",
            "com~apple~Numbers",
            "Documents",
        ])),
        write(&made(&[
            "Library",
            "Mobile Documents",
            "com~apple~TextEdit",
            "Documents",
            "Church",
        ])),
        write(&made(&[
            "Library",
            "CloudStorage",
            "GoogleDrive-office",
            "Shared drives",
        ])),
    ];
    for path in refused.iter().chain(&other_ways) {
        // The link and the other case reach a real file; the step back up is refused as written.
        assert_eq!(
            dir.read(path),
            Err(SourceError::PrivatePlace),
            "{}",
            path.display()
        );
        assert_eq!(
            dir.sources().add(path, ids()),
            Err(SourceError::PrivatePlace),
            "{}",
            path.display()
        );
    }
    for path in &readable {
        assert_eq!(dir.read(path), Ok(CSV.to_vec()), "{}", path.display());
    }
    assert!(!dir.list_path().exists());
    // A list written by something else that names those places: each is refused every time it would be read.
    let entries: Vec<serde_json::Value> = refused
        .iter()
        .chain(&other_ways)
        .enumerate()
        .map(|(n, path)| {
            serde_json::json!({ "id": format!("p{n}"), "kind": "file", "label": "Key holders", "shown": "keys.csv",
                "path": path.to_string_lossy(), "column": null, "ticked": [], "matches": [], "read_at": null })
        })
        .collect();
    std::fs::create_dir_all(dir.list_path().parent().unwrap()).unwrap();
    std::fs::write(
        dir.list_path(),
        serde_json::json!({ "version": 1, "sources": entries }).to_string(),
    )
    .unwrap();
    let sources = dir.sources();
    for n in 0..entries.len() {
        assert_eq!(
            sources.read(&format!("p{n}"), || NOW.into()),
            Err(SourceError::PrivatePlace),
            "p{n}"
        );
    }
    // Ozzie's own list, named by a list, is refused too.
    assert_eq!(dir.read(&dir.list_path()), Err(SourceError::PrivatePlace));
}

/// Review S, L4: a file macOS won't let Ozzie read says so, rather than that it was moved.
#[test]
fn a_file_ozzie_may_not_read_says_so() {
    use std::os::unix::fs::PermissionsExt;
    let dir = Scratch::new("not-allowed");
    let path = dir.file("keys.csv", CSV);
    let sources = dir.sources();
    sources.add(&path, ids()).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
    // Run as an administrator's root this would read anyway; the test means an ordinary account.
    if std::fs::File::open(&path).is_err() {
        assert_eq!(dir.read(&path), Err(SourceError::NotAllowed));
        assert_eq!(
            sources.read("src-1", || NOW.into()),
            Err(SourceError::NotAllowed)
        );
        let other = dir.file("other.csv", CSV);
        std::fs::set_permissions(&other, std::fs::Permissions::from_mode(0o000)).unwrap();
        assert_eq!(sources.add(&other, ids()), Err(SourceError::NotAllowed));
    }
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(sources.read("src-1", || NOW.into()), Ok(CSV.to_vec()));
}

#[test]
fn plain_follows_the_calendar_rules() {
    assert_eq!(plain("  Door \n greeters\t", 120), "Door greeters");
    assert_eq!(
        plain(
            &format!("Key{}{} holders{}", ch(0x202e), ch(0x2066), ch(0xe0041)),
            120
        ),
        "Key holders"
    );
    assert_eq!(
        plain(&format!("a{}b{}c", ch(0x2028), ch(0x85)), 120),
        "a b c"
    );
    // A joiner stays between letters or emoji, and goes anywhere else.
    let family = format!("{}{}{}", ch(0x1f468), ch(0x200d), ch(0x1f469));
    assert_eq!(plain(&family, 120), family);
    assert_eq!(plain(&format!("{}x", ch(0x200d)), 120), "x");
    let persian = format!("{}{}{}", ch(0x645), ch(0x200c), ch(0x6cc));
    assert_eq!(plain(&persian, 120), persian);
    // Cut at the limit, reading at most eight times as far.
    assert_eq!(plain(&"ab ".repeat(100), 5), "ab ab");
    assert_eq!(plain(&format!("{}x", " ".repeat(80)), 10), "");
    assert!(is_plain("Key holders", 60) && !is_plain("", 60) && !is_plain("Key  holders", 60));
}

#[test]
fn ids_and_times_are_checked_exactly() {
    for id in ["src-1", "a", "A_b-9", &"x".repeat(64)] {
        assert!(valid_id(id), "{id}");
    }
    for id in ["", "a b", "a/b", "é", &"x".repeat(65)] {
        assert!(!valid_id(id), "{id}");
    }
    for id in ["1", "7593350", &"9".repeat(20)] {
        assert!(valid_team_id(id), "{id}");
    }
    for id in ["", "0", "012", "1a", " 1", &"9".repeat(21)] {
        assert!(!valid_team_id(id), "{id}");
    }
    assert!(valid_instant(NOW));
    use ozzie_native_auth::sunday_check::{rfc3339, unix_ms};
    assert!(valid_instant(&rfc3339(unix_ms())));
    for t in [
        "2026-11-20T15:05:00Z",
        "2026-11-20 15:05:00.000Z",
        "2026-00-20T15:05:00.000Z",
        "2026-11-20T24:05:00.000Z",
        "x",
    ] {
        assert!(!valid_instant(t), "{t}");
    }
}

#[test]
fn one_panel_at_a_time() {
    let first = Picking::begin().unwrap();
    assert!(matches!(Picking::begin(), Err(SourceError::Unavailable)));
    drop(first);
    assert!(Picking::begin().is_ok());
}

#[test]
fn refusals_are_the_closed_codes_the_page_has_words_for() {
    let codes = [
        SourceError::FileMissing,
        SourceError::NotAllowed,
        SourceError::NotTheFile,
        SourceError::PrivatePlace,
        SourceError::ListUnreadable,
        SourceError::TooLarge,
        SourceError::Workbook,
        SourceError::NotText,
        SourceError::Pdf,
        SourceError::SectionTitle,
        SourceError::NotAnAddress,
        SourceError::NotHttps,
        SourceError::SignInInAddress,
        SourceError::NotOnTheInternet,
        SourceError::Unreachable,
        SourceError::Timeout,
        SourceError::Refused,
        SourceError::MovedElsewhere,
        SourceError::WebPage,
        SourceError::NotASheet,
        SourceError::TooManyLinks,
        SourceError::LinkAlreadyAdded,
        SourceError::LinkMissing,
        SourceError::LinksUnreadable,
        SourceError::KeychainLocked,
        SourceError::KeychainDenied,
        SourceError::LinksLeftInKeychain,
        SourceError::Unavailable,
    ]
    .map(|e| serde_json::to_string(&e).unwrap());
    assert_eq!(
        codes,
        [
            "\"file-missing\"",
            "\"not-allowed\"",
            "\"not-the-file\"",
            "\"private-place\"",
            "\"list-unreadable\"",
            "\"too-large\"",
            "\"workbook\"",
            "\"not-text\"",
            "\"pdf\"",
            "\"section-title\"",
            "\"not-an-address\"",
            "\"not-https\"",
            "\"sign-in-in-address\"",
            "\"not-on-the-internet\"",
            "\"unreachable\"",
            "\"timeout\"",
            "\"refused\"",
            "\"moved-elsewhere\"",
            "\"web-page\"",
            "\"not-a-sheet\"",
            "\"too-many-links\"",
            "\"link-already-added\"",
            "\"link-missing\"",
            "\"links-unreadable\"",
            "\"keychain-locked\"",
            "\"keychain-denied\"",
            "\"links-left-in-keychain\"",
            "\"unavailable\"",
        ]
    );
    // Each is one the page has a sentence for (core/src/sources/words.ts and sheet.ts).
    let words = include_str!("../../../../core/src/sources/words.ts");
    let sheet = include_str!("../../../../core/src/sources/sheet.ts");
    for code in codes {
        let code = code.trim_matches('"');
        let named =
            words.contains(&format!("\"{code}\"")) || sheet.contains(&format!("\"{code}\""));
        assert!(named, "{code}");
    }
    assert!(sheet.contains("export const MAX_SHEET_BYTES = 2 * 1024 * 1024;"));
}

/// On this Mac, without showing anything: the three types exist as UTType and the open panel takes them.
#[cfg(target_os = "macos")]
#[test]
fn the_panel_types_resolve_on_this_mac() {
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2::{msg_send, sel};
    use objc2_foundation::NSString;
    let types = panel_types(&SOURCE_TYPES).unwrap();
    assert_eq!(types.count(), 3);
    let identifiers: Vec<String> = types
        .iter()
        .map(|t: objc2::rc::Retained<AnyObject>| {
            // SAFETY: -[UTType identifier] returns an NSString.
            let id: objc2::rc::Retained<NSString> = unsafe { msg_send![&*t, identifier] };
            id.to_string()
        })
        .collect();
    assert_eq!(identifiers, SOURCE_TYPES);
    let panel = AnyClass::get(c"NSOpenPanel").unwrap();
    assert!(
        panel
            .instance_method(sel!(setAllowedContentTypes:))
            .is_some()
    );
}

// ---- Private links to published sheets ------------------------------------------------------------------------------

/// What `church_link_add` and the read after it give back, and where the address goes: one GET at the address as
/// pasted, the address into the Keychain only, the list here with the leader's label and the host masked.
#[test]
fn a_link_is_read_once_when_added_and_its_address_kept_only_in_the_keychain() {
    let dir = Scratch::new("link-add");
    let keychain = Arc::new(Keychain::default());
    let fetch = Fetch::answering(Ok(CSV));
    let links = dir.links(&keychain, &fetch);
    let sources = dir.sources();
    sources.add(&dir.file("keys.csv", CSV), ids()).unwrap();
    let (view, sheet) = sources
        .add_link(
            &links,
            " Snack\u{200b} rota ",
            &format!("  {ADDRESS}\n"),
            || NOW.into(),
        )
        .unwrap();
    assert_eq!(sheet, CSV);
    assert_eq!(fetch.asked(), vec![ADDRESS.to_owned()]);
    let json = serde_json::to_value(&view).unwrap();
    let id = json["id"].as_str().unwrap().to_owned();
    assert!(id.len() == 16 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')));
    assert_eq!(
        json,
        serde_json::json!({ "id": id, "kind": "link", "label": "Snack rota", "shown": HOST_SHOWN,
            "column": null, "ticked": [], "matches": {}, "read_at": NOW })
    );
    // The address is in the Keychain under the link's id, and nowhere else on disk.
    assert_eq!(
        kept_addresses(&keychain),
        vec![(id.clone(), ADDRESS.to_owned())]
    );
    for file in [dir.list_path(), dir.links_path()] {
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(!holds_address(&text), "{text}");
    }
    let kept: serde_json::Value =
        serde_json::from_slice(&std::fs::read(dir.list_path()).unwrap()).unwrap();
    assert_eq!(
        kept["sources"][1],
        serde_json::json!({ "id": id, "kind": "link", "label": "Snack rota", "shown": HOST_SHOWN,
            "column": null, "ticked": [], "matches": [], "read_at": NOW })
    );
    // Read again: one more GET, at the Keychain's address; the list remembers when.
    let later = "2026-11-20T16:10:00.000Z";
    assert_eq!(
        sources.read_link(&links, &id, || later.into()),
        Ok(CSV.to_vec())
    );
    assert_eq!(fetch.asked(), vec![ADDRESS.to_owned(), ADDRESS.to_owned()]);
    let listed = serde_json::to_value(sources.list().unwrap()).unwrap();
    assert_eq!(listed[0]["kind"], "file");
    assert_eq!(listed[1]["kind"], "link");
    assert_eq!(listed[1]["read_at"], later);
    // The file's and the link's reads are their own: neither command reads the other kind.
    assert_eq!(
        sources.read(&id, || NOW.into()),
        Err(SourceError::Unavailable)
    );
    assert_eq!(
        sources.read_link(&links, "src-1", || NOW.into()),
        Err(SourceError::Unavailable)
    );
    assert_eq!(fetch.asked().len(), 2);
}

/// After the read, a link's list is a list like a file's: named, a column chosen, columns ticked, values matched,
/// all kept here; removed only through its own command, which also forgets the address.
#[test]
fn a_link_list_is_set_like_a_file_list_and_removed_with_its_address() {
    let dir = Scratch::new("link-set");
    let keychain = Arc::new(Keychain::default());
    let fetch = Fetch::answering(Ok(CSV));
    let links = dir.links(&keychain, &fetch);
    let sources = dir.sources();
    let (view, _) = sources
        .add_link(&links, "Snack rota", ADDRESS, || NOW.into())
        .unwrap();
    let id = serde_json::to_value(&view).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let set = serde_json::to_value(sources.set(&id, change("Key holders")).unwrap()).unwrap();
    assert_eq!(set["kind"], "link");
    assert_eq!(set["shown"], HOST_SHOWN);
    assert_eq!(
        set["matches"],
        serde_json::json!({ "Greeter": { "team_id": "7593350", "position_name": "Greeter" }, "Nursery": { "team_id": "7593352" } })
    );
    assert_eq!(set["ticked"], serde_json::json!(["Name", "Door"]));
    // The file command doesn't remove a link (it would leave the address behind).
    assert_eq!(sources.remove(&id), Err(SourceError::Unavailable));
    assert_eq!(sources.list().unwrap().len(), 1);
    // The link's own: the Keychain item first, then the link's entry beside it, then the list here.
    assert_eq!(sources.remove_link(&links, &id), Ok(()));
    assert!(kept_addresses(&keychain).is_empty());
    assert_eq!(links.list(), Ok(Vec::new()));
    assert_eq!(sources.list(), Ok(Vec::new()));
    // Already gone is already removed; an id that isn't a link's never reaches the Keychain.
    assert_eq!(sources.remove_link(&links, &id), Ok(()));
    for bad in ["", "src-1", "../x", "ABCDEF0123456789", &"a".repeat(17)] {
        assert_eq!(
            sources.remove_link(&links, bad),
            Err(SourceError::Unavailable),
            "{bad}"
        );
        assert_eq!(
            sources.read_link(&links, bad, || NOW.into()),
            Err(SourceError::Unavailable),
            "{bad}"
        );
    }
    assert_eq!(fetch.asked().len(), 1);
}

/// Every reply the page can get for a link and every refusal, as the page gets it and as a debug form, and both
/// lists on disk: no part of the address after its host.
#[test]
fn the_address_is_in_no_reply_refusal_list_file_or_debug_form() {
    let dir = Scratch::new("link-secret");
    let keychain = Arc::new(Keychain::default());
    let fetch = Fetch::answering(Ok(CSV));
    let links = dir.links(&keychain, &fetch);
    let sources = dir.sources();
    let added = sources.add_link(&links, "Snack rota", ADDRESS, || NOW.into());
    let id = added.as_ref().unwrap().0.clone();
    let id = serde_json::to_value(&id).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let mut seen = vec![
        shown(&added.as_ref().map(|(v, _)| v)),
        shown(&sources.list()),
        shown(&sources.set(&id, change("Snack rota"))),
        shown(&links.list()),
        std::fs::read_to_string(dir.list_path()).unwrap(),
        std::fs::read_to_string(dir.links_path()).unwrap(),
    ];
    for answer in [
        LinkError::WebPage,
        LinkError::Workbook,
        LinkError::NotText,
        LinkError::TooLarge,
        LinkError::Refused,
        LinkError::MovedElsewhere,
        LinkError::Timeout,
        LinkError::Unreachable,
        LinkError::NotOnTheInternet,
        LinkError::Unavailable,
    ] {
        fetch.set(Err(answer));
        seen.push(shown(&sources.read_link(&links, &id, || NOW.into())));
        seen.push(shown(
            &sources.add_link(&links, "Again", ADDRESS, || NOW.into()),
        ));
    }
    for refused in [
        "http://sheets.fictional-church.example/d/e/2PACX-QZXSECRET0123456789/pub?gid=0&output=csv",
        "https://office:pw@sheets.fictional-church.example/d/e/2PACX-QZXSECRET0123456789/pub?gid=0&output=csv",
        "https://10.0.0.7/d/e/2PACX-QZXSECRET0123456789/pub?gid=0&output=csv",
        "sheets.fictional-church.example/d/e/2PACX-QZXSECRET0123456789/pub?gid=0&output=csv",
    ] {
        seen.push(shown(
            &sources.add_link(&links, "Again", refused, || NOW.into()),
        ));
    }
    keychain.refuse(Some(StoreError::Locked));
    seen.push(shown(&sources.read_link(&links, &id, || NOW.into())));
    seen.push(shown(&sources.remove_link(&links, &id)));
    keychain.refuse(None);
    for text in &seen {
        assert!(!holds_address(text), "{text}");
    }
    // Only the Keychain holds it, once.
    assert_eq!(kept_addresses(&keychain), vec![(id, ADDRESS.to_owned())]);
}

/// The guarded read's refusals, and the Keychain's, as the closed codes the page has words for; a refused add keeps
/// nothing, and a refused read keeps the link.
#[test]
fn each_refusal_is_its_own_code_and_a_refused_add_keeps_nothing() {
    let dir = Scratch::new("link-codes");
    let keychain = Arc::new(Keychain::default());
    let fetch = Fetch::answering(Ok(CSV));
    let links = dir.links(&keychain, &fetch);
    let sources = dir.sources();
    for (answer, code) in [
        (LinkError::WebPage, SourceError::WebPage),
        (LinkError::NotASheet, SourceError::NotASheet),
        (LinkError::Workbook, SourceError::Workbook),
        (LinkError::NotText, SourceError::NotText),
        (LinkError::TooLarge, SourceError::TooLarge),
        (LinkError::Refused, SourceError::Refused),
        (LinkError::MovedElsewhere, SourceError::MovedElsewhere),
        (LinkError::Timeout, SourceError::Timeout),
        (LinkError::Unreachable, SourceError::Unreachable),
        (LinkError::NotOnTheInternet, SourceError::NotOnTheInternet),
    ] {
        fetch.set(Err(answer));
        assert_eq!(
            sources
                .add_link(&links, "Snack rota", ADDRESS, || NOW.into())
                .map(|_| ()),
            Err(code),
            "{answer:?}"
        );
    }
    assert!(keychain.items().is_empty());
    assert_eq!(sources.list(), Ok(Vec::new()));
    // Refused before any read: not an address, not https, a sign-in in it, a local place.
    let asked = fetch.asked().len();
    for (address, code) in [
        ("not a link", SourceError::NotAnAddress),
        ("", SourceError::NotAnAddress),
        (
            "http://sheets.fictional-church.example/pub.csv",
            SourceError::NotHttps,
        ),
        (
            "ftp://sheets.fictional-church.example/pub.csv",
            SourceError::NotHttps,
        ),
        // A calendar's scheme, which a calendar link reads as https: a sheet's link is https as written.
        (
            "webcal://sheets.fictional-church.example/pub.csv",
            SourceError::NotHttps,
        ),
        (
            "https://office:pw@sheets.fictional-church.example/pub.csv",
            SourceError::SignInInAddress,
        ),
        (
            "https://192.168.1.10/pub.csv",
            SourceError::NotOnTheInternet,
        ),
        ("https://localhost/pub.csv", SourceError::NotOnTheInternet),
        (
            "https://sheets.fictional-church.example:8443/pub.csv",
            SourceError::NotOnTheInternet,
        ),
    ] {
        assert_eq!(
            sources
                .add_link(&links, "Snack rota", address, || NOW.into())
                .map(|_| ()),
            Err(code),
            "{address}"
        );
    }
    // A label that is nothing once made plain is refused before anything is read.
    assert_eq!(
        sources
            .add_link(&links, " \u{200b} ", ADDRESS, || NOW.into())
            .map(|_| ()),
        Err(SourceError::Unavailable)
    );
    assert_eq!(fetch.asked().len(), asked);
    // The Keychain refusing to keep the address: nothing is added.
    fetch.set(Ok(CSV));
    for (refusal, code) in [
        (StoreError::Locked, SourceError::KeychainLocked),
        (StoreError::Denied, SourceError::KeychainDenied),
        (StoreError::Unavailable, SourceError::Unavailable),
    ] {
        keychain.refuse(Some(refusal));
        assert_eq!(
            sources
                .add_link(&links, "Snack rota", ADDRESS, || NOW.into())
                .map(|_| ()),
            Err(code),
            "{refusal:?}"
        );
        keychain.refuse(None);
    }
    assert!(keychain.items().is_empty());
    assert_eq!(sources.list(), Ok(Vec::new()));
    // A saved link whose read is refused stays, and says why; the Keychain refusing says so too.
    let (view, _) = sources
        .add_link(&links, "Snack rota", ADDRESS, || NOW.into())
        .unwrap();
    let id = serde_json::to_value(&view).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    fetch.set(Err(LinkError::WebPage));
    assert_eq!(
        sources.read_link(&links, &id, || "2026-11-20T16:00:00.000Z".into()),
        Err(SourceError::WebPage)
    );
    keychain.refuse(Some(StoreError::Locked));
    assert_eq!(
        sources.read_link(&links, &id, || NOW.into()),
        Err(SourceError::KeychainLocked)
    );
    assert_eq!(
        sources.remove_link(&links, &id),
        Err(SourceError::KeychainLocked)
    );
    keychain.refuse(None);
    // Still listed, still last read when it was added.
    let listed = serde_json::to_value(sources.list().unwrap()).unwrap();
    assert_eq!(listed[0]["read_at"], NOW);
    assert_eq!(kept_addresses(&keychain).len(), 1);
}

/// At most 8 links, and 20 lists in all; nothing is read for a link that couldn't be kept.
#[test]
fn at_most_8_links_and_nothing_is_read_for_one_more() {
    let dir = Scratch::new("link-many");
    let keychain = Arc::new(Keychain::default());
    let fetch = Fetch::answering(Ok(CSV));
    let links = dir.links(&keychain, &fetch);
    let sources = dir.sources();
    assert_eq!(MAX_LINKS, 8);
    assert_eq!(MAX_LINKS, ozzie_native_auth::calendar_link::MAX_LINKS);
    for n in 0..MAX_LINKS {
        sources
            .add_link(
                &links,
                &format!("List {n}"),
                &format!("{ADDRESS}&list={n}"),
                || NOW.into(),
            )
            .unwrap();
    }
    assert_eq!(fetch.asked().len(), MAX_LINKS);
    assert_eq!(
        sources
            .add_link(&links, "One more", ADDRESS, || NOW.into())
            .map(|_| ()),
        Err(SourceError::TooManyLinks)
    );
    assert_eq!(fetch.asked().len(), MAX_LINKS);
    assert_eq!(kept_addresses(&keychain).len(), MAX_LINKS);
    // Files fill the rest of the 20; then a link is refused before it is read, like a file.
    let next = ids();
    for n in MAX_LINKS..MAX_SOURCES {
        sources
            .add(&dir.file(&format!("list-{n}.csv"), CSV), &next)
            .unwrap();
    }
    let first = serde_json::to_value(sources.list().unwrap()).unwrap()[0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    sources.remove_link(&links, &first).unwrap();
    sources.add(&dir.file("one-more.csv", CSV), &next).unwrap();
    assert_eq!(
        sources
            .add_link(&links, "One more", ADDRESS, || NOW.into())
            .map(|_| ()),
        Err(SourceError::Unavailable)
    );
    assert_eq!(fetch.asked().len(), MAX_LINKS);
    assert_eq!(kept_addresses(&keychain).len(), MAX_LINKS - 1);
}

/// "Forget all private links" and "Forget all lists": every sheet link's address leaves the Keychain (and nothing
/// else in it does), and the files themselves are untouched.
#[test]
fn forgetting_deletes_every_link_address_from_the_keychain() {
    let dir = Scratch::new("link-forget");
    let keychain = Arc::new(Keychain::default());
    let fetch = Fetch::answering(Ok(CSV));
    let links = dir.links(&keychain, &fetch);
    let sources = dir.sources();
    let file = dir.file("keys.csv", CSV);
    sources.add(&file, ids()).unwrap();
    for n in 0..3 {
        sources
            .add_link(
                &links,
                &format!("List {n}"),
                &format!("{ADDRESS}&list={n}"),
                || NOW.into(),
            )
            .unwrap();
    }
    keychain
        .put("calendar-link", "00000000000000aa", b"not a sheet link's")
        .unwrap();
    assert_eq!(kept_addresses(&keychain).len(), 3);
    // Links only: the file's list stays.
    assert_eq!(sources.forget_links(&links), Ok(()));
    assert!(kept_addresses(&keychain).is_empty());
    assert!(!dir.links_path().exists());
    let listed = serde_json::to_value(sources.list().unwrap()).unwrap();
    assert_eq!(listed.as_array().unwrap().len(), 1);
    assert_eq!(listed[0]["kind"], "file");
    // Everything.
    sources
        .add_link(&links, "Again", ADDRESS, || NOW.into())
        .unwrap();
    assert_eq!(sources.forget_all(&links), Ok(()));
    assert!(kept_addresses(&keychain).is_empty());
    assert!(!dir.list_path().exists() && !dir.links_path().exists());
    assert_eq!(sources.list(), Ok(Vec::new()));
    assert!(file.exists());
    assert_eq!(keychain.items().len(), 1, "the calendar's item is not ours");
    // "Forget all private links" with a Keychain that refuses: nothing is forgotten, and it says so.
    sources
        .add_link(&links, "Again", ADDRESS, || NOW.into())
        .unwrap();
    keychain.refuse(Some(StoreError::Locked));
    assert_eq!(
        sources.forget_links(&links),
        Err(SourceError::KeychainLocked)
    );
    keychain.refuse(None);
    assert_eq!(sources.list().unwrap().len(), 1);
    assert_eq!(kept_addresses(&keychain).len(), 1);
    // Review T, L7: "Forget all lists", the way out of an unreadable list, works with a Keychain that refuses: the
    // lists go, the links' own list stays so their addresses are removed once the Keychain answers, and it says so.
    std::fs::write(dir.list_path(), "damaged").unwrap();
    keychain.refuse(Some(StoreError::Locked));
    assert_eq!(
        sources.forget_all(&links),
        Err(SourceError::LinksLeftInKeychain)
    );
    assert!(!dir.list_path().exists() && dir.links_path().exists());
    assert_eq!(sources.list(), Ok(Vec::new()));
    sources.prune_links(&links);
    assert_eq!(kept_addresses(&keychain).len(), 1);
    keychain.refuse(None);
    sources.prune_links(&links);
    assert!(kept_addresses(&keychain).is_empty());
    assert_eq!(links.list(), Ok(Vec::new()));
}

/// A list on this Mac with links in it is still version 1: an older list (files only, as stage 1 wrote it) reads as
/// it was; a link entry outside the format refuses the whole list, which is never written over.
#[test]
fn a_damaged_list_with_links_is_refused_whole_and_an_older_list_still_reads() {
    let dir = Scratch::new("link-damaged");
    let keychain = Arc::new(Keychain::default());
    let fetch = Fetch::answering(Ok(CSV));
    let links = dir.links(&keychain, &fetch);
    let file = dir.file("keys.csv", CSV);
    std::fs::create_dir_all(dir.list_path().parent().unwrap()).unwrap();
    // As stage 1 wrote it.
    let older = format!(
        r#"{{"version":1,"sources":[{{"id":"src-1","kind":"file","label":"Key holders","shown":"keys.csv","path":{},"column":"Team","ticked":["Name"],"matches":[{{"value":"Greeter","team_id":"7593350"}}],"read_at":"{NOW}"}}]}}"#,
        serde_json::to_string(&file.to_string_lossy()).unwrap()
    );
    std::fs::write(dir.list_path(), &older).unwrap();
    let sources = dir.sources();
    assert_eq!(sources.list().unwrap().len(), 1);
    assert_eq!(sources.read("src-1", || NOW.into()), Ok(CSV.to_vec()));
    // Kept with a link beside it, the file's entry is written as it was.
    sources
        .add_link(&links, "Snack rota", ADDRESS, || NOW.into())
        .unwrap();
    let kept: serde_json::Value =
        serde_json::from_slice(&std::fs::read(dir.list_path()).unwrap()).unwrap();
    assert_eq!(kept["sources"][0]["path"], file.to_string_lossy().as_ref());
    assert!(kept["sources"][1].get("path").is_none());
    let link_id = kept["sources"][1]["id"].as_str().unwrap().to_owned();
    let good = |over: &[(&str, serde_json::Value)]| {
        let mut entry = kept["sources"][1].clone();
        for (key, value) in over {
            entry[*key] = value.clone();
        }
        entry
    };
    let list = |entries: Vec<serde_json::Value>| {
        serde_json::json!({ "version": 1, "sources": entries }).to_string()
    };
    let cases = [
        list(vec![good(&[(
            "path",
            file.to_string_lossy().as_ref().into(),
        )])]),
        list(vec![good(&[("id", "src-2".into())])]),
        list(vec![good(&[("id", "ABCDEF0123456789".into())])]),
        list(vec![good(&[("id", "0123456789abcdef0".into())])]),
        list(vec![good(&[("kind", "notes".into())])]),
        list(vec![good(&[("kind", "web".into())])]),
        list(vec![good(&[("shown", "".into())])]),
        list(vec![good(&[("address", ADDRESS.into())])]),
        list(
            (0..=MAX_LINKS)
                .map(|n| good(&[("id", format!("{n:016x}").into())]))
                .collect(),
        ),
    ];
    for text in cases {
        std::fs::write(dir.list_path(), &text).unwrap();
        let sources = dir.sources();
        assert_eq!(sources.list(), Err(SourceError::ListUnreadable), "{text}");
        assert_eq!(
            sources.read_link(&links, &link_id, || NOW.into()),
            Err(SourceError::ListUnreadable)
        );
        assert_eq!(
            sources
                .add_link(&links, "Again", ADDRESS, || NOW.into())
                .map(|_| ()),
            Err(SourceError::ListUnreadable)
        );
        assert_eq!(
            sources.remove_link(&links, &link_id),
            Err(SourceError::ListUnreadable)
        );
        assert_eq!(std::fs::read_to_string(dir.list_path()).unwrap(), text);
    }
    // Nothing was read for a list that couldn't take it, and the link's address is still kept: the list here can't
    // be read, so nothing beside it is tidied.
    assert_eq!(fetch.asked().len(), 1);
    dir.sources().prune_links(&links);
    assert_eq!(kept_addresses(&keychain).len(), 1);
    // "Forget all lists" is the way out, and takes the address with it.
    assert_eq!(dir.sources().forget_all(&links), Ok(()));
    assert!(kept_addresses(&keychain).is_empty());
}

/// The links' own list beside the Keychain can't be read: a link says so and nothing is read or removed;
/// "Forget all private links" is the way out and leaves the files' lists.
#[test]
fn a_damaged_link_list_says_so_and_forgetting_the_links_is_the_way_out() {
    let dir = Scratch::new("link-store-damaged");
    let keychain = Arc::new(Keychain::default());
    let fetch = Fetch::answering(Ok(CSV));
    let links = dir.links(&keychain, &fetch);
    let sources = dir.sources();
    sources.add(&dir.file("keys.csv", CSV), ids()).unwrap();
    let (view, _) = sources
        .add_link(&links, "Snack rota", ADDRESS, || NOW.into())
        .unwrap();
    let id = serde_json::to_value(&view).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    std::fs::write(dir.links_path(), "not json").unwrap();
    assert_eq!(
        sources.read_link(&links, &id, || NOW.into()),
        Err(SourceError::LinksUnreadable)
    );
    assert_eq!(
        sources
            .add_link(&links, "Again", ADDRESS, || NOW.into())
            .map(|_| ()),
        Err(SourceError::LinksUnreadable)
    );
    assert_eq!(
        sources.remove_link(&links, &id),
        Err(SourceError::LinksUnreadable)
    );
    sources.prune_links(&links);
    assert_eq!(fetch.asked().len(), 1);
    assert_eq!(kept_addresses(&keychain).len(), 1);
    assert_eq!(
        std::fs::read_to_string(dir.links_path()).unwrap(),
        "not json"
    );
    // The lists here still list, the link among them.
    assert_eq!(sources.list().unwrap().len(), 2);
    assert_eq!(sources.forget_links(&links), Ok(()));
    assert!(kept_addresses(&keychain).is_empty());
    let listed = serde_json::to_value(sources.list().unwrap()).unwrap();
    assert_eq!(listed.as_array().unwrap().len(), 1);
    assert_eq!(listed[0]["kind"], "file");
}

/// Between adding a link and reading it, its address in the Keychain can change outside Ozzie, its item can go, or
/// its entry beside the Keychain can: each read checks again, and none reads anywhere the page doesn't show.
#[test]
fn a_link_swapped_between_add_and_read_is_checked_again() {
    let dir = Scratch::new("link-swap");
    let keychain = Arc::new(Keychain::default());
    let fetch = Fetch::answering(Ok(CSV));
    let links = dir.links(&keychain, &fetch);
    let sources = dir.sources();
    let (view, _) = sources
        .add_link(&links, "Snack rota", ADDRESS, || NOW.into())
        .unwrap();
    let id = serde_json::to_value(&view).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let put = |address: &str| {
        keychain
            .put(sheet_link::KEYCHAIN_WORKSPACE, &id, address.as_bytes())
            .unwrap()
    };
    for (swapped, code) in [
        // Somewhere local: refused as it would be when added.
        (
            "https://192.168.1.10/d/e/2PACX-QZXSWAPPED/pub?output=csv",
            SourceError::NotOnTheInternet,
        ),
        (
            "http://sheets.fictional-church.example/d/e/2PACX-QZXSWAPPED/pub",
            SourceError::NotHttps,
        ),
        // Another host than the one the page shows: not this link's address.
        (
            "https://elsewhere.fictional-church.example/d/e/2PACX-QZXSWAPPED/pub?output=csv",
            SourceError::LinkMissing,
        ),
        ("not an address", SourceError::NotAnAddress),
    ] {
        put(swapped);
        let read = sources.read_link(&links, &id, || NOW.into());
        assert_eq!(read, Err(code), "{swapped}");
        assert!(!shown(&read).contains("QZXSWAPPED"));
    }
    assert_eq!(fetch.asked(), vec![ADDRESS.to_owned()]);
    // The same host, as it was added: read.
    put(ADDRESS);
    assert_eq!(
        sources.read_link(&links, &id, || NOW.into()),
        Ok(CSV.to_vec())
    );
    // The Keychain item gone, or the entry beside it gone (a removal that stopped halfway): the link says it is
    // missing, and removing it still works.
    keychain
        .delete(sheet_link::KEYCHAIN_WORKSPACE, &id)
        .unwrap();
    assert_eq!(
        sources.read_link(&links, &id, || NOW.into()),
        Err(SourceError::LinkMissing)
    );
    put(ADDRESS);
    std::fs::write(dir.links_path(), r#"{"version":1,"links":[]}"#).unwrap();
    assert_eq!(
        sources.read_link(&links, &id, || NOW.into()),
        Err(SourceError::LinkMissing)
    );
    assert_eq!(fetch.asked().len(), 2);
    // Its address went already: listing the store (to compare the host shown) removes an address no entry names.
    assert!(kept_addresses(&keychain).is_empty());
    assert_eq!(sources.remove_link(&links, &id), Ok(()));
    assert_eq!(sources.list(), Ok(Vec::new()));
    // A read under way when the link is removed keeps no "read at" for it, and leaves no entry behind.
    let (view, _) = sources
        .add_link(&links, "Snack rota", ADDRESS, || NOW.into())
        .unwrap();
    let id = serde_json::to_value(&view).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let list_path = dir.list_path();
    fetch.with(move |_| {
        std::fs::write(&list_path, r#"{"version":1,"sources":[]}"#).unwrap();
        Ok(CSV.to_vec())
    });
    assert_eq!(
        sources.read_link(&links, &id, || NOW.into()),
        Ok(CSV.to_vec())
    );
    assert_eq!(sources.list(), Ok(Vec::new()));
}

/// An add whose list here changes or can't be saved during its read keeps no address: the address goes from the
/// Keychain again. And an address kept for no list here (an add or a removal that stopped halfway) is removed when
/// the lists are next listed, but never while a link is being added.
#[test]
fn an_address_is_never_kept_without_a_list_that_names_it() {
    let dir = Scratch::new("link-orphan");
    let keychain = Arc::new(Keychain::default());
    let fetch = Fetch::answering(Ok(CSV));
    let links = dir.links(&keychain, &fetch);
    let sources = dir.sources();
    sources.add(&dir.file("keys.csv", CSV), ids()).unwrap();
    let list_path = dir.list_path();
    fetch.with(move |_| {
        std::fs::write(&list_path, "damaged while the link was read").unwrap();
        Ok(CSV.to_vec())
    });
    assert_eq!(
        sources
            .add_link(&links, "Snack rota", ADDRESS, || NOW.into())
            .map(|_| ()),
        Err(SourceError::ListUnreadable)
    );
    assert!(kept_addresses(&keychain).is_empty());
    assert_eq!(links.list(), Ok(Vec::new()));
    // An address the links' store kept with no list here naming it (an add here also removes such addresses first:
    // addresses_left_by_a_refused_forget_never_count_toward_8).
    std::fs::remove_file(dir.list_path()).unwrap();
    fetch.set(Ok(CSV));
    let (named, _) = sources
        .add_link(&links, "Snack rota", ADDRESS, || NOW.into())
        .unwrap();
    let named = serde_json::to_value(&named).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let (orphan, _) = links
        .add(sheet_link::LABEL, &format!("{ADDRESS}&list=orphan"))
        .unwrap();
    assert_eq!(kept_addresses(&keychain).len(), 2);
    // Not while a link is being added.
    {
        let _adding = sources.adding.lock().unwrap();
        sources.prune_links(&links);
        assert_eq!(kept_addresses(&keychain).len(), 2);
    }
    sources.prune_links(&links);
    assert_eq!(
        kept_addresses(&keychain)
            .into_iter()
            .map(|(id, _)| id)
            .collect::<Vec<_>>(),
        vec![named.clone()]
    );
    assert!(links.list().unwrap().iter().all(|l| l.id != orphan.id));
    assert_eq!(
        sources.read_link(&links, &named, || NOW.into()),
        Ok(CSV.to_vec())
    );
}

/// Nothing in this file writes to a log or the console, and the address the page sends is only ever handed on to the
/// links' store.
#[test]
fn nothing_here_logs_and_the_address_goes_only_to_the_store() {
    let source = include_str!("church_sources.rs");
    let code: String = source
        .lines()
        .filter(|l| !l.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");
    for call in [
        "println!",
        "eprintln!",
        "print!",
        "eprint!",
        "dbg!",
        "log::",
        "tracing::",
        "NSLog",
    ] {
        assert!(!code.contains(call), "church_sources.rs uses {call}");
    }
    // The command takes the address and passes it straight to add_link, which hands it to the store's add.
    let command = source
        .split("pub async fn church_link_add(")
        .nth(1)
        .unwrap()
        .split("\n}\n")
        .next()
        .unwrap();
    assert_eq!(command.matches("address").count(), 2, "{command}");
    let add = source
        .split("pub fn add_link(")
        .nth(1)
        .unwrap()
        .split("\n    }\n")
        .next()
        .unwrap();
    // The parameter, the store's own comparison with what is saved, and the store's add.
    assert_eq!(add.matches("address").count(), 3, "{add}");
    assert!(
        add.contains(".saved_id(address)?")
            && add.contains("links.add(sheet_link::LABEL, address)")
    );
}

/// Review S2, E: the folders a list is never read from are named as macOS names an open file (F_GETPATH), so a home
/// folder given in the data volume's form (`/System/Volumes/Data/…`, the same folder by another name) changes nothing.
/// Only the home folder and Ozzie's own folders are opened to name them; the Library folder, iCloud Drive and the cloud
/// drives are named from the home folder, never opened.
#[cfg(target_os = "macos")]
#[test]
fn the_refused_folders_are_named_as_an_open_file_is() {
    let dir = Scratch::new("named");
    let mail = dir.0.join("Library").join("Mail");
    std::fs::create_dir_all(&mail).unwrap();
    let file = mail.join("keys.csv");
    std::fs::write(&file, CSV).unwrap();
    let own = dir.0.join("data");
    std::fs::create_dir_all(&own).unwrap();
    let mine = own.join("keys.csv");
    std::fs::write(&mine, CSV).unwrap();
    let icloud = dir
        .0
        .join("Library")
        .join("Mobile Documents")
        .join("com~apple~Numbers")
        .join("Documents");
    std::fs::create_dir_all(&icloud).unwrap();
    std::fs::write(icloud.join("keys.csv"), CSV).unwrap();
    // The data volume's name for the same folders, built in parts.
    let data = Path::new("/").join("System").join("Volumes").join("Data");
    let canonical = std::fs::canonicalize(&dir.0).unwrap();
    let home = data.join(canonical.strip_prefix("/").unwrap());
    if !home.exists() {
        eprintln!("skipped: no data volume form of {}", canonical.display());
        return;
    }
    for (what, refused) in [
        ("as written", Refused::for_this_mac(&dir.0, [own.clone()])),
        (
            "in the data volume's form",
            Refused::for_this_mac(&home, [home.join("data")]),
        ),
    ] {
        assert_eq!(
            read_source_file(&file, &refused, MAX_SOURCE_BYTES),
            Err(SourceError::PrivatePlace),
            "{what}"
        );
        assert_eq!(
            read_source_file(&mine, &refused, MAX_SOURCE_BYTES),
            Err(SourceError::PrivatePlace),
            "{what}"
        );
        assert_eq!(
            read_source_file(&icloud.join("keys.csv"), &refused, MAX_SOURCE_BYTES),
            Ok(CSV.to_vec()),
            "{what}"
        );
        assert_eq!(
            read_source_file(&dir.file("keys.csv", CSV), &refused, MAX_SOURCE_BYTES),
            Ok(CSV.to_vec()),
            "{what}"
        );
    }
}

/// Review T, L2: a link's list shows the host the links' store has for that id, as "<host>/•••" exactly: a list here
/// whose host was changed outside Ozzie is never read under it, and one not in that form is not this version's.
#[test]
fn a_link_shows_only_the_host_its_store_has_for_it() {
    let dir = Scratch::new("link-shown");
    let keychain = Arc::new(Keychain::default());
    let fetch = Fetch::answering(Ok(CSV));
    let links = dir.links(&keychain, &fetch);
    let sources = dir.sources();
    let (view, _) = sources
        .add_link(&links, "Snack rota", ADDRESS, || NOW.into())
        .unwrap();
    let id = serde_json::to_value(&view).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let kept = std::fs::read_to_string(dir.list_path()).unwrap();
    assert!(kept.contains(&format!("\"shown\":\"{HOST_SHOWN}\"")));
    // Another host, in the right form: listed, but never read under it.
    let elsewhere = "elsewhere.fictional-church.example/\u{2022}\u{2022}\u{2022}";
    std::fs::write(dir.list_path(), kept.replace(HOST_SHOWN, elsewhere)).unwrap();
    assert_eq!(sources.list().unwrap().len(), 1);
    assert_eq!(
        sources.read_link(&links, &id, || NOW.into()),
        Err(SourceError::LinkMissing)
    );
    assert_eq!(fetch.asked().len(), 1);
    // Not in that form at all: the list isn't this version's.
    for shown in [
        "sheets.fictional-church.example",
        "sheets.fictional-church.example/x",
        "/\u{2022}\u{2022}\u{2022}",
        "localhost/\u{2022}\u{2022}\u{2022}",
        "Key holders",
    ] {
        std::fs::write(dir.list_path(), kept.replace(HOST_SHOWN, shown)).unwrap();
        assert_eq!(sources.list(), Err(SourceError::ListUnreadable), "{shown}");
    }
    std::fs::write(dir.list_path(), &kept).unwrap();
    assert_eq!(
        sources.read_link(&links, &id, || NOW.into()),
        Ok(CSV.to_vec())
    );
}

/// Review T, B: an address already saved for a list is refused, compared inside the links' store (only an id comes
/// back), before anything is read: an add that outlasted the page's wait and saved after the page gave up can't be
/// added twice by trying again.
#[test]
fn a_link_already_added_is_refused_before_reading() {
    let dir = Scratch::new("link-twice");
    let keychain = Arc::new(Keychain::default());
    let fetch = Fetch::answering(Ok(CSV));
    let links = dir.links(&keychain, &fetch);
    let sources = dir.sources();
    sources
        .add_link(&links, "Snack rota", ADDRESS, || NOW.into())
        .unwrap();
    for again in [
        ADDRESS.to_owned(),
        format!("  {ADDRESS}  "),
        format!("{ADDRESS}#top"),
    ] {
        let added = sources.add_link(&links, "Snack rota again", &again, || NOW.into());
        assert_eq!(
            added.map(|_| ()),
            Err(SourceError::LinkAlreadyAdded),
            "{again}"
        );
    }
    assert_eq!(fetch.asked().len(), 1);
    assert_eq!(kept_addresses(&keychain).len(), 1);
    assert_eq!(sources.list().unwrap().len(), 1);
    // An address kept for no list here (an add that stopped halfway) doesn't stop it being added for one.
    std::fs::write(dir.list_path(), r#"{"version":1,"sources":[]}"#).unwrap();
    assert!(
        sources
            .add_link(&links, "Snack rota", ADDRESS, || NOW.into())
            .is_ok()
    );
}

/// Review T, D: church_sources.rs reaches only the native modules it uses today (the links' guarded client and store,
/// the Keychain, the sheet links, the time helpers) and no other module of this app, sends no event and starts no
/// program. Review U, finding 4: read with `syn` as Rust reads it, so a crate under another name, a grouped import or
/// a path written with spaces is seen; inside a macro, its tokens are checked without their spacing. A check on this
/// file's code, not a sandbox.
#[test]
fn church_sources_reaches_only_its_own_modules() {
    use syn::visit::Visit;
    /// Every path the file names, as Rust reads it: each `use` flattened (groups opened, `self` kept), every path in
    /// code and types, and each macro's tokens with the white space taken out.
    #[derive(Default)]
    struct Named {
        used: Vec<String>,
        paths: Vec<String>,
        renames: Vec<String>,
        globs: Vec<String>,
        macros: Vec<String>,
        other: Vec<String>,
    }
    fn flatten(tree: &syn::UseTree, prefix: &str, out: &mut Named) {
        match tree {
            syn::UseTree::Path(p) => flatten(&p.tree, &format!("{prefix}{}::", p.ident), out),
            syn::UseTree::Name(n) => out.used.push(format!("{prefix}{}", n.ident)),
            syn::UseTree::Rename(r) => out
                .renames
                .push(format!("{prefix}{} as {}", r.ident, r.rename)),
            syn::UseTree::Glob(_) => out.globs.push(format!("{prefix}*")),
            syn::UseTree::Group(g) => g.items.iter().for_each(|t| flatten(t, prefix, out)),
        }
    }
    impl<'a> Visit<'a> for Named {
        fn visit_item_use(&mut self, u: &'a syn::ItemUse) {
            flatten(
                &u.tree,
                if u.leading_colon.is_some() { "::" } else { "" },
                self,
            );
        }
        fn visit_path(&mut self, p: &'a syn::Path) {
            let joined: Vec<String> = p.segments.iter().map(|s| s.ident.to_string()).collect();
            self.paths.push(joined.join("::"));
            syn::visit::visit_path(self, p);
        }
        fn visit_macro(&mut self, m: &'a syn::Macro) {
            self.macros
                .push(m.tokens.to_string().split_whitespace().collect());
            syn::visit::visit_macro(self, m);
        }
        fn visit_item_extern_crate(&mut self, e: &'a syn::ItemExternCrate) {
            self.other.push(format!("extern crate {}", e.ident));
        }
        fn visit_item_mod(&mut self, m: &'a syn::ItemMod) {
            if m.ident != "tests" || m.content.is_some() {
                self.other.push(format!("mod {}", m.ident));
            }
            syn::visit::visit_item_mod(self, m);
        }
    }
    let file =
        syn::parse_file(include_str!("church_sources.rs")).expect("church_sources.rs parses");
    let mut named = Named::default();
    named.visit_file(&file);
    // No renamed import (a crate or module under another name), no glob, no other crate or module brought in.
    assert_eq!(named.renames, Vec::<String>::new());
    assert_eq!(named.globs, Vec::<String>::new());
    assert_eq!(named.other, Vec::<String>::new());
    // Every import comes from the standard library, this app's own shared crate, Tauri, serde or the Objective-C
    // bindings for the open panel.
    for used in &named.used {
        let root = used.split("::").next().unwrap_or_default();
        assert!(
            [
                "std",
                "ozzie_native_auth",
                "tauri",
                "serde",
                "objc2",
                "objc2_foundation",
                "objc2_app_kit"
            ]
            .contains(&root),
            "church_sources.rs imports {used}"
        );
    }
    // The shared crate: only these modules, and of three of them only these names.
    let everything: Vec<&String> = named
        .used
        .iter()
        .chain(&named.paths)
        .chain(&named.macros)
        .collect();
    let mut reached: Vec<&str> = everything
        .iter()
        .flat_map(|p| {
            p.match_indices("ozzie_native_auth::")
                .map(move |(at, _)| &p[at + "ozzie_native_auth::".len()..])
        })
        .map(|rest| rest.split("::").next().unwrap_or_default())
        .collect();
    reached.sort_unstable();
    reached.dedup();
    assert_eq!(
        reached,
        ["calendar_link", "credentials", "sheet_link", "sunday_check"]
    );
    for (module, allowed) in [
        (
            "calendar_link",
            &["GuardedHttp", "LinkError", "valid_id", "public_name"][..],
        ),
        ("credentials", &["MacKeychain"][..]),
        ("sunday_check", &["rfc3339", "unix_ms"][..]),
    ] {
        for p in &everything {
            for (at, _) in p.match_indices(&format!("ozzie_native_auth::{module}::")) {
                let name = p[at + "ozzie_native_auth::".len() + module.len() + 2..]
                    .split("::")
                    .next()
                    .unwrap_or_default();
                assert!(allowed.contains(&name), "{module}::{name}");
            }
        }
    }
    // Nothing that sends or starts anything, under any path or inside any macro: no other module of this app, no
    // program, no network, no events or notices, no plugin, no NSWorkspace (which opens other apps).
    for p in &everything {
        let p = p.as_str();
        for banned in [
            "crate::",
            "super::",
            "std::process",
            "std::net",
            "std::os::unix::net",
            "process::Command",
            "TcpStream",
            "UdpSocket",
            "reqwest",
            "Emitter",
            "emit",
            "notification",
            "tauri_plugin",
            "NSWorkspace",
        ] {
            assert!(!p.contains(banned), "church_sources.rs uses {banned}: {p}");
        }
        assert!(
            !p.starts_with("Command") && !p.starts_with("::"),
            "church_sources.rs names {p}"
        );
    }
}

// ---- The church's own notes (stage 3) -------------------------------------------------------------------------

const NOTES: &[u8] =
    b"# Child safety policy\nTwo adults in every room.\n\n# Snow days\nWe text by 6 AM.\n";

/// A notes file is read as a list's file is (the same places refused, no link followed, the same file after opening),
/// at most 1 MB; a PDF, a Word or Pages file (a ZIP) and anything with a NUL byte are refused, each in its own words.
#[test]
fn notes_are_read_up_to_1_mb_and_a_pdf_or_word_file_is_refused() {
    let dir = Scratch::new("notes-read");
    let refused = dir.refused();
    let read = |path: &Path| read_source_file(path, &refused, MAX_NOTES_BYTES);
    assert_eq!(MAX_NOTES_BYTES, 1_048_576);
    assert_eq!(read(&dir.file("policy.md", NOTES)), Ok(NOTES.to_vec()));
    assert_eq!(read(&dir.file("policy.txt", NOTES)), Ok(NOTES.to_vec()));
    let mut limit = NOTES.to_vec();
    limit.resize(MAX_NOTES_BYTES as usize, b'a');
    assert_eq!(
        read(&dir.file("limit.md", &limit)).map(|b| b.len()),
        Ok(limit.len())
    );
    limit.push(b'a');
    assert_eq!(
        read(&dir.file("over.md", &limit)),
        Err(SourceError::TooLarge)
    );
    // A PDF, by its name before anything is read, or by how it starts; a Word file is a ZIP.
    let big_pdf = dir.file("Policy.PDF", &vec![b' '; MAX_NOTES_BYTES as usize * 3]);
    assert_eq!(read(&big_pdf), Err(SourceError::Pdf));
    assert_eq!(
        read(&dir.file("policy.txt.pdf", b"%PDF-1.7\n")),
        Err(SourceError::Pdf)
    );
    assert_eq!(
        read(&dir.file("renamed.txt", b"%PDF-1.4\n%\xe2\xe3")),
        Err(SourceError::Pdf)
    );
    assert_eq!(
        read(&dir.file("policy.docx", b"PK\x03\x04\x14\x00")),
        Err(SourceError::Workbook)
    );
    assert_eq!(
        read(&dir.file("binary.txt", b"Notes\x00")),
        Err(SourceError::NotText)
    );
    // A list's file is read at its own limit, and a PDF named as one is refused the same way.
    let mut sheet = CSV.to_vec();
    sheet.resize(MAX_NOTES_BYTES as usize + 10, b'a');
    let sheet = dir.file("big.csv", &sheet);
    assert!(read_source_file(&sheet, &refused, MAX_SOURCE_BYTES).is_ok());
    assert_eq!(read(&sheet), Err(SourceError::TooLarge));
    // The same places as a list's file.
    let hidden = dir.0.join(".notes");
    std::fs::create_dir_all(&hidden).unwrap();
    std::fs::write(hidden.join("policy.md"), NOTES).unwrap();
    assert_eq!(
        read(&hidden.join("policy.md")),
        Err(SourceError::PrivatePlace)
    );
}

/// Adding notes keeps them as their own kind, apart from lists: the file's name shown, never its path; the same file
/// added as a list and as notes is two entries. Read again like a list's file, removed and forgotten the same way.
#[test]
fn notes_are_their_own_kind_and_the_page_never_sees_the_path() {
    let dir = Scratch::new("notes-add");
    let sources = dir.sources();
    let path = dir.file("Child safety (2026).md", NOTES);
    let added = sources.add_kind(&path, "notes", ids()).unwrap();
    assert_eq!(
        serde_json::to_value(&added).unwrap(),
        serde_json::json!({ "id": "src-1", "kind": "notes", "label": "Child safety (2026)", "shown": "Child safety (2026).md",
            "attachments": [], "read_at": null })
    );
    // The same file again is the notes already there; as a list it is a list of its own.
    assert_eq!(sources.add_kind(&path, "notes", ids()).unwrap(), added);
    let listed = sources
        .add_kind(&path, "file", || Ok("src-2".into()))
        .unwrap();
    assert_eq!(serde_json::to_value(&listed).unwrap()["kind"], "file");
    assert_eq!(sources.read("src-1", || NOW.into()), Ok(NOTES.to_vec()));
    let all = serde_json::to_string(&sources.list().unwrap()).unwrap();
    assert!(
        !all.contains(&*path.to_string_lossy()) && !all.contains("ozzie-church-sources-notes-add")
    );
    let kept: serde_json::Value =
        serde_json::from_slice(&std::fs::read(dir.list_path()).unwrap()).unwrap();
    assert_eq!(kept["sources"][0]["kind"], "notes");
    assert_eq!(kept["sources"][0]["read_at"], NOW);
    assert!(kept["sources"][0].get("attachments").is_none());
    // A list's settings are not notes', and notes' are not a list's.
    assert_eq!(
        sources.set("src-1", change("Policy")),
        Err(SourceError::Unavailable)
    );
    assert_eq!(
        sources.set_notes("src-2", "Keys", vec![]),
        Err(SourceError::Unavailable)
    );
    // Removed like a list; the file stays where it is.
    assert_eq!(sources.remove("src-1"), Ok(()));
    assert_eq!(sources.list().unwrap().len(), 1);
    assert!(path.exists());
    // Refused when chosen, nothing added.
    let pdf = dir.file("policy.pdf", b"%PDF-1.7");
    assert_eq!(
        sources.add_kind(&pdf, "notes", ids()),
        Err(SourceError::Pdf)
    );
    assert_eq!(
        sources.add_kind(&path, "web", ids()),
        Err(SourceError::Unavailable)
    );
    assert_eq!(sources.list().unwrap().len(), 1);
}

fn attach(section: &str, team: Option<&str>, kind: Option<&str>) -> AttachmentInput {
    AttachmentInput {
        section: section.into(),
        team_id: team.map(str::to_owned),
        finding_kind: kind.map(str::to_owned),
        occurrence: None,
        of: None,
    }
}
fn of(mut a: AttachmentInput, of: u32) -> AttachmentInput {
    a.of = Some(of);
    a
}
fn nth(mut a: AttachmentInput, occurrence: u32) -> AttachmentInput {
    a.occurrence = Some(occurrence);
    a
}

/// A section is attached to a Planning Center team (by id) or to one of the closed kinds of finding, only as the
/// leader sets it: every change made plain and checked whole, anything else refusing all of it.
#[test]
fn notes_attachments_are_checked_whole() {
    let dir = Scratch::new("notes-set");
    let sources = dir.sources();
    sources
        .add_kind(&dir.file("policy.md", NOTES), "notes", ids())
        .unwrap();
    let view = sources
        .set_notes(
            "src-1",
            format!("  Child{} safety ", ch(0x200b)).as_str(),
            vec![
                attach("Child safety policy", Some("7593352"), None),
                attach("Snow days", None, Some("needs-people")),
                attach("Snow days", None, Some("background-check")),
            ],
        )
        .unwrap();
    assert_eq!(
        serde_json::to_value(&view).unwrap(),
        serde_json::json!({ "id": "src-1", "kind": "notes", "label": "Child safety", "shown": "policy.md",
            "attachments": [{ "section": "Child safety policy", "team_id": "7593352" }, { "section": "Snow days", "finding_kind": "needs-people" },
                { "section": "Snow days", "finding_kind": "background-check" }], "read_at": null })
    );
    let before = std::fs::read_to_string(dir.list_path()).unwrap();
    let too_many: Vec<AttachmentInput> = (0..=MAX_ATTACHMENTS)
        .map(|n| attach(&format!("Section {n}"), Some("1"), None))
        .collect();
    for (what, attachments) in [
        (
            "both a team and a kind",
            vec![attach("Snow days", Some("1"), Some("pending"))],
        ),
        ("neither", vec![attach("Snow days", None, None)]),
        (
            "a kind that isn't one",
            vec![attach("Snow days", None, Some("room-overlap"))],
        ),
        (
            "a kind in another case",
            vec![attach("Snow days", None, Some("Pending"))],
        ),
        (
            "a team id that isn't one",
            vec![attach("Snow days", Some("0"), None)],
        ),
        ("an empty section", vec![attach("", Some("1"), None)]),
        (
            "the same twice",
            vec![
                attach("Snow days", Some("1"), None),
                attach("Snow days", Some("1"), None),
            ],
        ),
        ("too many", too_many),
    ] {
        assert_eq!(
            sources.set_notes("src-1", "Policy", attachments),
            Err(SourceError::Unavailable),
            "{what}"
        );
    }
    assert_eq!(
        sources.set_notes("src-1", " ", vec![]),
        Err(SourceError::Unavailable)
    );
    // A title the page couldn't have made is refused as a title, never tidied into another (review V).
    assert_eq!(
        sources.set_notes(
            "src-1",
            "Policy",
            vec![attach(
                &format!("Child safety{} policy", ch(0x202e)),
                Some("1"),
                None
            )]
        ),
        Err(SourceError::SectionTitle)
    );
    assert_eq!(std::fs::read_to_string(dir.list_path()).unwrap(), before);
    // The closed kinds are the Sunday brief's own (core/src/sunday-brief.ts), less the one about what wasn't read.
    assert_eq!(
        NOTE_FINDING_KINDS,
        [
            "needs-people",
            "pending",
            "streak",
            "lead-missing",
            "lead-unverified",
            "too-few-confirmed",
            "background-check"
        ]
    );
    assert!(
        serde_json::from_value::<AttachmentInput>(
            serde_json::json!({ "section": "x", "team_id": "1", "path": "/etc" })
        )
        .is_err()
    );
}

/// A list on this Mac with notes in it is still version 1, read whole: notes outside their format refuse it, and a
/// list written before notes (or before links) reads as it was.
#[test]
fn a_damaged_list_with_notes_is_refused_whole() {
    let dir = Scratch::new("notes-damaged");
    let file = dir.file("policy.md", NOTES);
    let good = || {
        serde_json::json!({ "id": "n1", "kind": "notes", "label": "Policy", "shown": "policy.md", "path": file.to_string_lossy(),
            "column": null, "ticked": [], "matches": [], "attachments": [{ "section": "Snow days", "finding_kind": "pending" }], "read_at": null })
    };
    let list = |entry: serde_json::Value| {
        serde_json::json!({ "version": 1, "sources": [entry] }).to_string()
    };
    std::fs::create_dir_all(dir.list_path().parent().unwrap()).unwrap();
    std::fs::write(dir.list_path(), list(good())).unwrap();
    assert_eq!(dir.sources().list().unwrap().len(), 1);
    let with = |key: &str, value: serde_json::Value| {
        let mut entry = good();
        entry[key] = value;
        list(entry)
    };
    let sheet_with_attachment = {
        let mut entry = good();
        entry["kind"] = "file".into();
        entry
    };
    for text in [
        with("column", "Team".into()),
        with("ticked", serde_json::json!(["Name"])),
        with(
            "matches",
            serde_json::json!([{ "value": "x", "team_id": "1" }]),
        ),
        with("path", serde_json::Value::Null),
        with(
            "attachments",
            serde_json::json!([{ "section": "Snow days", "finding_kind": "room-overlap" }]),
        ),
        with(
            "attachments",
            serde_json::json!([{ "section": "Snow days", "team_id": "1", "finding_kind": "pending" }]),
        ),
        with(
            "attachments",
            serde_json::json!([{ "section": "", "team_id": "1" }]),
        ),
        with(
            "attachments",
            serde_json::json!({ "Snow days": { "team_id": "1" } }),
        ),
        list(sheet_with_attachment),
    ] {
        std::fs::write(dir.list_path(), &text).unwrap();
        assert_eq!(
            dir.sources().list(),
            Err(SourceError::ListUnreadable),
            "{text}"
        );
        assert_eq!(std::fs::read_to_string(dir.list_path()).unwrap(), text);
    }
}

/// On this Mac, without showing anything: the notes panel's types exist as UTType.
#[cfg(target_os = "macos")]
#[test]
fn the_notes_panel_types_resolve_on_this_mac() {
    let types = panel_types(&NOTES_TYPES).unwrap();
    assert_eq!(types.count(), NOTES_TYPES.len());
    assert_eq!(
        NOTES_TYPES,
        [
            "public.plain-text",
            "net.daringfireball.markdown",
            "com.adobe.pdf"
        ]
    );
}

/// Review V's open question: the page makes a section's title with its own copy of the plain-line rule, which reads
/// the joiner rule from its runtime's Unicode data; native code checks the same title with Rust's. Titles generated by
/// core/test/sources/titles.test.ts from a seeded mix (joiners between letters of many scripts, recent Unicode letters,
/// marks, emoji, hidden characters, cuts at the limit): each must be one native code keeps exactly as it is.
#[test]
fn every_title_the_page_makes_is_one_native_code_keeps() {
    let titles: Vec<String> = serde_json::from_str(include_str!(
        "../../../../core/test/fixtures/sources/titles.json"
    ))
    .unwrap();
    assert!(titles.len() > 1200);
    let differ: Vec<String> = titles
        .iter()
        .filter(|t| plain(t, MAX_TITLE) != **t)
        .map(|t| {
            format!(
                "{} -> {}",
                t.escape_unicode(),
                plain(t, MAX_TITLE).escape_unicode()
            )
        })
        .collect();
    assert!(
        differ.is_empty(),
        "{} of {} differ; first: {:?}",
        differ.len(),
        titles.len(),
        differ.first()
    );
}

/// Review V, M1: when titles repeat, a pointer keeps which section with that title it means (2 for the second; the first
/// leaves it out, as every pointer written before this did).
#[test]
fn a_pointer_keeps_which_occurrence_of_a_repeated_title() {
    let dir = Scratch::new("notes-occurrence");
    let sources = dir.sources();
    sources
        .add_kind(&dir.file("policy.md", NOTES), "notes", ids())
        .unwrap();
    let view = sources
        .set_notes(
            "src-1",
            "Policy",
            vec![
                attach("Who to call", Some("1"), None),
                nth(attach("Who to call", Some("1"), None), 2),
                nth(attach("Who to call", None, Some("pending")), 1),
            ],
        )
        .unwrap();
    assert_eq!(
        serde_json::to_value(&view).unwrap()["attachments"],
        serde_json::json!([{ "section": "Who to call", "team_id": "1" }, { "section": "Who to call", "team_id": "1", "occurrence": 2 },
            { "section": "Who to call", "finding_kind": "pending" }])
    );
    let before = std::fs::read_to_string(dir.list_path()).unwrap();
    for bad in [0, MAX_NOTE_LINES + 1] {
        assert_eq!(
            sources.set_notes(
                "src-1",
                "Policy",
                vec![nth(attach("Who to call", Some("1"), None), bad)]
            ),
            Err(SourceError::Unavailable),
            "{bad}"
        );
    }
    // The first said twice is one pointer twice.
    assert_eq!(
        sources.set_notes(
            "src-1",
            "Policy",
            vec![
                attach("Keys", Some("1"), None),
                nth(attach("Keys", Some("1"), None), 1)
            ]
        ),
        Err(SourceError::Unavailable)
    );
    assert_eq!(std::fs::read_to_string(dir.list_path()).unwrap(), before);
    // As kept: 1 is never written (the first leaves it out), and a list that says so isn't this version's.
    let kept: serde_json::Value = serde_json::from_str(&before).unwrap();
    assert!(
        kept["sources"][0]["attachments"][2]
            .get("occurrence")
            .is_none()
    );
    for written in ["1", "0", "\"2\"", "2.5"] {
        std::fs::write(
            dir.list_path(),
            before.replace("\"occurrence\":2", &format!("\"occurrence\":{written}")),
        )
        .unwrap();
        assert_eq!(
            dir.sources().list(),
            Err(SourceError::ListUnreadable),
            "{written}"
        );
    }
}

/// Audit item 30: a pointer keeps how many sections had its title when the leader chose it, so the page can say the notes
/// changed instead of following a different section. Checked natively: a whole number from 1 to MAX_NOTE_LINES, never
/// below the occurrence it names; a pointer written before has none, read as "unknown", and is kept as it was.
#[test]
fn a_pointer_keeps_how_many_sections_shared_its_title() {
    let dir = Scratch::new("notes-of");
    let sources = dir.sources();
    sources
        .add_kind(&dir.file("policy.md", NOTES), "notes", ids())
        .unwrap();
    let view = sources
        .set_notes(
            "src-1",
            "Policy",
            vec![
                of(attach("Who to call", Some("1"), None), 1),
                of(nth(attach("Who to call", None, Some("pending")), 2), 3),
                attach("Keys", Some("1"), None),
            ],
        )
        .unwrap();
    assert_eq!(
        serde_json::to_value(&view).unwrap()["attachments"],
        serde_json::json!([{ "section": "Who to call", "team_id": "1", "of": 1 },
            { "section": "Who to call", "finding_kind": "pending", "occurrence": 2, "of": 3 }, { "section": "Keys", "team_id": "1" }])
    );
    // Kept as given, and read back the same after Ozzie starts again.
    assert_eq!(
        serde_json::to_value(&dir.sources().list().unwrap()[0]).unwrap()["attachments"],
        serde_json::to_value(&view).unwrap()["attachments"]
    );
    let before = std::fs::read_to_string(dir.list_path()).unwrap();
    for (bad, why) in [
        (of(attach("Keys", Some("1"), None), 0), "none"),
        (
            of(attach("Keys", Some("1"), None), MAX_NOTE_LINES + 1),
            "too many",
        ),
        (
            of(nth(attach("Keys", Some("1"), None), 3), 2),
            "fewer than its occurrence",
        ),
    ] {
        assert_eq!(
            sources.set_notes("src-1", "Policy", vec![bad]),
            Err(SourceError::Unavailable),
            "{why}"
        );
    }
    assert_eq!(std::fs::read_to_string(dir.list_path()).unwrap(), before);
    // A kept list that says otherwise isn't this version's.
    for written in ["0", "\"3\"", "1.5", "-1"] {
        std::fs::write(
            dir.list_path(),
            before.replace("\"of\":3", &format!("\"of\":{written}")),
        )
        .unwrap();
        assert_eq!(
            dir.sources().list(),
            Err(SourceError::ListUnreadable),
            "{written}"
        );
    }
    std::fs::write(dir.list_path(), before.replace("\"of\":3", "\"of\":1")).unwrap();
    assert_eq!(
        dir.sources().list(),
        Err(SourceError::ListUnreadable),
        "an occurrence past its count"
    );
}

/// Review V's open question, failing soft: whether a joiner stays in a title depends on each runtime's Unicode data, so
/// a pointer's title is checked with its joiners set aside when the list is read (one that differs there only never
/// makes the whole list unreadable), and a pointer native code would keep with another title is refused on its own,
/// in its own words, rather than kept so that it silently matches nothing.
#[test]
fn a_title_read_two_ways_refuses_that_pointer_never_the_list() {
    let dir = Scratch::new("notes-joiners");
    let file = dir.file("policy.md", NOTES);
    let zwj = ch(0x200d);
    let list = serde_json::json!({ "version": 1, "sources": [{ "id": "n1", "kind": "notes", "label": "Policy", "shown": "policy.md",
        "path": file.to_string_lossy(), "column": null, "ticked": [], "matches": [],
        "attachments": [{ "section": format!("Snow{zwj} days"), "team_id": "1" }, { "section": format!("Keys{zwj}"), "finding_kind": "pending" }],
        "read_at": null }] })
    .to_string();
    std::fs::create_dir_all(dir.list_path().parent().unwrap()).unwrap();
    std::fs::write(dir.list_path(), &list).unwrap();
    let sources = dir.sources();
    assert_eq!(sources.list().unwrap().len(), 1);
    // Choosing such a title now: refused in its own words, and nothing is written.
    for section in [
        format!("Snow{zwj} days"),
        format!("Keys{zwj}"),
        "Snow  days".to_owned(),
        " Snow days".to_owned(),
    ] {
        assert_eq!(
            sources.set_notes("n1", "Policy", vec![attach(&section, Some("1"), None)]),
            Err(SourceError::SectionTitle),
            "{}",
            section.escape_unicode()
        );
    }
    assert_eq!(std::fs::read_to_string(dir.list_path()).unwrap(), list);
    // Outside a title's form in any other way, the list is still refused whole.
    for section in [
        format!("Snow{} days", ch(0x202e)),
        "x".repeat(MAX_TITLE + 1),
        String::new(),
    ] {
        std::fs::write(
            dir.list_path(),
            list.replace(&format!("Snow{zwj} days"), &section),
        )
        .unwrap();
        assert_eq!(
            dir.sources().list(),
            Err(SourceError::ListUnreadable),
            "{}",
            section.escape_unicode()
        );
    }
}

/// Review U, finding 2: a link's host as listed comes from the links' store for that id, never from this list alone, so
/// the page never shows a host the store doesn't hold; a link the store doesn't list shows no host at all.
#[test]
fn a_link_is_listed_with_the_host_its_store_holds() {
    let dir = Scratch::new("link-listed-host");
    let keychain = Arc::new(Keychain::default());
    let fetch = Fetch::answering(Ok(CSV));
    let links = dir.links(&keychain, &fetch);
    let sources = dir.sources();
    sources
        .add_link(&links, "Snack rota", ADDRESS, || NOW.into())
        .unwrap();
    let shown = |links: Option<&SheetLinks>| {
        serde_json::to_value(sources.list_with_links(links).unwrap()).unwrap()[0]["shown"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    assert_eq!(shown(Some(&links)), HOST_SHOWN);
    // This list changed outside Ozzie to another host in the right form: the store's host is listed.
    let kept = std::fs::read_to_string(dir.list_path()).unwrap();
    let elsewhere = "elsewhere.fictional-church.example/\u{2022}\u{2022}\u{2022}";
    std::fs::write(dir.list_path(), kept.replace(HOST_SHOWN, elsewhere)).unwrap();
    assert_eq!(shown(Some(&links)), HOST_SHOWN);
    // The store doesn't list it (or can't be read, or there is no store): no host.
    std::fs::remove_file(dir.links_path()).unwrap();
    assert_eq!(shown(Some(&links)), LINK_NOT_HELD);
    assert_eq!(shown(None), LINK_NOT_HELD);
    std::fs::write(dir.links_path(), "damaged").unwrap();
    assert_eq!(shown(Some(&links)), LINK_NOT_HELD);
}

/// Review U, finding 3: addresses left in the Keychain by a refused forget never count toward the 8 links; the next
/// add removes those no list here names before it counts.
#[test]
fn addresses_left_by_a_refused_forget_never_count_toward_8() {
    let dir = Scratch::new("link-left-count");
    let keychain = Arc::new(Keychain::default());
    let fetch = Fetch::answering(Ok(CSV));
    let links = dir.links(&keychain, &fetch);
    let sources = dir.sources();
    for n in 0..MAX_LINKS {
        sources
            .add_link(
                &links,
                &format!("List {n}"),
                &format!("{ADDRESS}&list={n}"),
                || NOW.into(),
            )
            .unwrap();
    }
    keychain.refuse(Some(StoreError::Locked));
    assert_eq!(
        sources.forget_all(&links),
        Err(SourceError::LinksLeftInKeychain)
    );
    keychain.refuse(None);
    assert_eq!(kept_addresses(&keychain).len(), MAX_LINKS);
    // No listing in between: the add itself makes room.
    assert!(
        sources
            .add_link(&links, "Again", ADDRESS, || NOW.into())
            .is_ok()
    );
    assert_eq!(kept_addresses(&keychain).len(), 1);
    assert_eq!(links.list().unwrap().len(), 1);
}
