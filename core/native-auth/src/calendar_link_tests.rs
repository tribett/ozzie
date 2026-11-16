//! Private calendar links: where a request may go, what counts as a calendar, and how the address is kept (only in
//! the Keychain, never in the list beside it or anything the page sees). A stand-in Keychain and fetcher; the guarded
//! client itself is exercised against refused addresses only, so no test here reaches the network (the one live
//! read is ignored unless asked for). Fictional addresses only.
use super::*;
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};

const SECRET: &str = "https://calendar.google.com/calendar/ical/fictional%40example.org/private-0123456789abcdef/basic.ics";
const CALENDAR: &str = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:x\r\nSUMMARY:Choir\r\nDTSTART:20261117T150000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";

#[test]
fn a_pasted_address_must_be_https_on_the_internet_with_no_sign_in() {
    let ok = |raw: &str| normalize_address(raw).map(|u| u.to_string());
    assert_eq!(ok(SECRET).as_deref(), Ok(SECRET));
    assert_eq!(
        ok("  webcal://p01-caldav.icloud.com/published/2/fictional  ").as_deref(),
        Ok("https://p01-caldav.icloud.com/published/2/fictional")
    );
    assert_eq!(
        ok("WEBCALS://outlook.office365.com/owa/calendar/x/reachcalendar.ics").as_deref(),
        Ok("https://outlook.office365.com/owa/calendar/x/reachcalendar.ics")
    );
    // The fragment never leaves anyway; it isn't kept. https's own port is fine.
    assert_eq!(
        ok("https://calendar.google.com:443/a.ics#top").as_deref(),
        Ok("https://calendar.google.com/a.ics")
    );
    for (raw, why) in [
        ("http://calendar.google.com/a.ics", LinkError::NotHttps),
        ("ftp://calendar.google.com/a.ics", LinkError::NotHttps),
        ("file:///etc/passwd", LinkError::NotHttps),
        (
            "https://leader:pw12@calendar.google.com/a.ics",
            LinkError::SignInInAddress,
        ),
        (
            "https://leader@calendar.google.com/a.ics",
            LinkError::SignInInAddress,
        ),
        ("https://127.0.0.1/a.ics", LinkError::NotOnTheInternet),
        ("https://[::1]/a.ics", LinkError::NotOnTheInternet),
        ("https://10.0.0.5/a.ics", LinkError::NotOnTheInternet),
        ("https://93.184.216.34/a.ics", LinkError::NotOnTheInternet),
        // Other ways of writing 127.0.0.1, which a URL parser reads as that address.
        ("https://2130706433/a.ics", LinkError::NotOnTheInternet),
        ("https://0x7f.1/a.ics", LinkError::NotOnTheInternet),
        ("https://127.1/a.ics", LinkError::NotOnTheInternet),
        ("https://localhost/a.ics", LinkError::NotOnTheInternet),
        (
            "https://calendar.localhost/a.ics",
            LinkError::NotOnTheInternet,
        ),
        ("https://printer.local/a.ics", LinkError::NotOnTheInternet),
        ("https://office.lan/a.ics", LinkError::NotOnTheInternet),
        (
            "https://router.home.arpa/a.ics",
            LinkError::NotOnTheInternet,
        ),
        ("https://intranet/a.ics", LinkError::NotOnTheInternet),
        (
            "https://calendar.google.com:8443/a.ics",
            LinkError::NotOnTheInternet,
        ),
        ("", LinkError::NotAnAddress),
        ("calendar.google.com/a.ics", LinkError::NotAnAddress),
        (
            "https://calendar.google.com/a b.ics",
            LinkError::NotAnAddress,
        ),
        (
            "https://calendar.google.com/\u{7}.ics",
            LinkError::NotAnAddress,
        ),
    ] {
        assert_eq!(normalize_address(raw), Err(why), "{raw}");
    }
    let long = format!("https://calendar.google.com/{}", "a".repeat(MAX_ADDRESS));
    assert_eq!(normalize_address(&long), Err(LinkError::NotAnAddress));
}

#[test]
fn only_public_addresses_count_as_on_the_internet() {
    let ip = |s: &str| s.parse::<IpAddr>().unwrap();
    for public in [
        "8.8.8.8",
        "17.253.144.10",
        "142.250.80.46",
        "100.63.255.255",
        "100.128.0.1",
        "172.15.255.255",
        "172.32.0.1",
        "2606:4700:4700::1111",
        "2a00:1450:4009:81d::200e",
        "3fff:1000::1",
        "64:ff9b::808:808",
        "::ffff:8.8.8.8",
    ] {
        assert!(public_ip(ip(public)), "{public}");
    }
    for private in [
        "0.0.0.0",
        "0.1.2.3",
        "10.1.2.3",
        "100.64.0.1",
        "100.127.255.254",
        "127.0.0.1",
        "127.255.255.255",
        "169.254.169.254",
        "172.16.0.1",
        "172.31.255.255",
        "192.0.0.8",
        "192.0.2.1",
        "192.88.99.1",
        "192.168.1.1",
        "198.18.0.1",
        "198.19.255.255",
        "198.51.100.7",
        "203.0.113.9",
        "224.0.0.251",
        "239.255.255.250",
        "240.0.0.1",
        "255.255.255.255",
        "::",
        "::1",
        "fe80::1",
        "fc00::1",
        "fd12:3456::1",
        "fec0::1",
        "ff02::fb",
        "::ffff:10.0.0.1",
        "::ffff:127.0.0.1",
        "::ffff:169.254.169.254",
        "64:ff9b::a00:1",
        "64:ff9b::7f00:1",
        "2001:db8::1",
        "2001::1",
        "2002:7f00:1::1",
        "3fff::1",
        "3fff:fff:ffff::1",
        "5f00::1",
        "100::1",
        "::7f00:1",
    ] {
        assert!(!public_ip(ip(private)), "{private}");
    }
}

#[test]
fn a_name_pointing_at_this_mac_or_the_local_network_at_all_is_refused() {
    let ips = |list: &[&str]| {
        list.iter()
            .map(|s| s.parse::<IpAddr>().unwrap())
            .collect::<Vec<_>>()
    };
    assert_eq!(
        public_addresses(&ips(&["8.8.8.8", "2606:4700:4700::1111"])),
        Ok(vec![
            "8.8.8.8:443".parse().unwrap(),
            "[2606:4700:4700::1111]:443".parse().unwrap()
        ])
    );
    assert_eq!(
        public_addresses(&ips(&["8.8.8.8", "127.0.0.1"])),
        Err(LinkError::NotOnTheInternet)
    );
    assert_eq!(public_addresses(&[]), Err(LinkError::Unreachable));
    for name in [
        "calendar.google.com",
        "p01-caldav.icloud.com",
        "outlook.office365.com",
        "calendar.google.com.",
    ] {
        assert!(public_name(name), "{name}");
    }
    for name in [
        "localhost",
        "LOCALHOST.",
        "nas.local",
        "x.internal",
        "box.home",
        "intranet",
        "1.2.3.4",
        "foo.123",
        "",
        ".",
    ] {
        assert!(!public_name(name), "{name}");
    }
}

fn refusing_lookup(_: &str) -> io::Result<Vec<IpAddr>> {
    Ok(vec!["127.0.0.1".parse().unwrap()])
}
fn private_lookup(_: &str) -> io::Result<Vec<IpAddr>> {
    Ok(vec![
        "192.168.1.20".parse().unwrap(),
        "8.8.8.8".parse().unwrap(),
    ])
}

#[test]
fn the_guarded_client_refuses_before_connecting() {
    let client = GuardedHttp::new().unwrap();
    for (raw, why) in [
        ("http://calendar.google.com/a.ics", LinkError::NotHttps),
        ("https://localhost/a.ics", LinkError::NotOnTheInternet),
        ("https://127.0.0.1/a.ics", LinkError::NotOnTheInternet),
        ("https://[::1]:8443/a.ics", LinkError::NotOnTheInternet),
        (
            "https://leader:pw@calendar.google.com/a.ics",
            LinkError::SignInInAddress,
        ),
    ] {
        assert_eq!(client.get(&Url::parse(raw).unwrap()), Err(why), "{raw}");
    }
}

#[test]
fn the_client_connects_only_where_the_public_only_resolver_allows() {
    // A public-looking name whose DNS answer is this Mac, or partly the local network: the resolver wired into the
    // client refuses it, so nothing connects (and no real DNS or network is used here).
    let url = Url::parse("https://calendar.fictional-church.example/a.ics").unwrap();
    for lookup in [refusing_lookup as LookupFn, private_lookup] {
        let client = GuardedHttp::with_lookup(lookup).unwrap();
        assert_eq!(client.get(&url), Err(LinkError::NotOnTheInternet));
    }
}

#[test]
fn only_bounded_utf8_icalendar_text_is_a_calendar() {
    assert_eq!(
        calendar_text(CALENDAR.as_bytes().to_vec()).as_deref(),
        Ok(CALENDAR)
    );
    let bom = format!("\u{feff}\r\n{CALENDAR}\r\n\r\n");
    assert!(calendar_text(bom.into_bytes()).is_ok());
    assert!(calendar_text(b"begin:vcalendar\nend:vcalendar".to_vec()).is_ok());
    for bad in [
        b"<!doctype html><html><body>Sign in</body></html>".to_vec(),
        b"BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\n".to_vec(),
        b"BEGIN:VCAL".to_vec(),
        b"".to_vec(),
        [b"<html>".to_vec(), vec![0xff, 0xfe], b"</html>".to_vec()].concat(),
    ] {
        assert_eq!(calendar_text(bad), Err(LinkError::NotACalendar));
    }
    let huge = [
        b"BEGIN:VCALENDAR\r\n".to_vec(),
        vec![b'x'; MAX_CALENDAR_BYTES],
        b"\r\nEND:VCALENDAR".to_vec(),
    ]
    .concat();
    assert_eq!(calendar_text(huge), Err(LinkError::TooLarge));
}

#[test]
fn errors_are_closed_codes_without_any_address() {
    assert_eq!(
        serde_json::to_string(&LinkError::NotOnTheInternet).unwrap(),
        "\"not-on-the-internet\""
    );
    assert_eq!(
        serde_json::to_string(&LinkError::SignInInAddress).unwrap(),
        "\"sign-in-in-address\""
    );
    assert_eq!(LinkError::from(StoreError::Locked), LinkError::Locked);
}

// ---- The links, with a stand-in Keychain and fetcher -----------------------------------------------------------

#[derive(Default)]
struct Keychain(Mutex<HashMap<(String, String), Vec<u8>>>);
impl Keychain {
    fn items(&self) -> Vec<((String, String), Vec<u8>)> {
        let mut items: Vec<_> = self
            .0
            .lock()
            .unwrap()
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        items.sort();
        items
    }
}
impl CredentialStore for Keychain {
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
struct Fetch {
    answer: Mutex<Result<String, LinkError>>,
    asked: Mutex<Vec<String>>,
    calls: AtomicUsize,
}
impl Fetch {
    fn answering(answer: Result<&str, LinkError>) -> Arc<Self> {
        Arc::new(Self {
            answer: Mutex::new(answer.map(str::to_owned)),
            asked: Mutex::default(),
            calls: AtomicUsize::new(0),
        })
    }
}
impl CalendarFetch for Fetch {
    fn get(&self, url: &Url) -> Result<String, LinkError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.asked.lock().unwrap().push(url.to_string());
        self.answer.lock().unwrap().clone()
    }
}
struct Folder(PathBuf);
impl Folder {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "ozzie-calendar-links-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        Self(dir)
    }
    fn list(&self) -> PathBuf {
        self.0.join("calendar-links.json")
    }
}
impl Drop for Folder {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn links(folder: &Folder, keychain: &Arc<Keychain>, fetch: &Arc<Fetch>) -> CalendarLinks {
    CalendarLinks::new(keychain.clone(), folder.list(), fetch.clone())
}

#[test]
fn adding_reads_once_then_keeps_the_address_only_in_the_keychain() {
    let folder = Folder::new("add");
    let keychain = Arc::new(Keychain::default());
    let fetch = Fetch::answering(Ok(CALENDAR));
    let store = links(&folder, &keychain, &fetch);
    let (view, text) = store
        .add("  Church office  ", &format!("webcal{}", &SECRET[5..]))
        .unwrap();
    assert_eq!(text, CALENDAR);
    assert_eq!(view.label, "Church office");
    assert_eq!(view.shown, "calendar.google.com/\u{2022}\u{2022}\u{2022}");
    assert!(valid_id(&view.id) && !view.missing);
    // Read as https, once, before anything was kept.
    assert_eq!(*fetch.asked.lock().unwrap(), vec![SECRET.to_owned()]);
    assert_eq!(
        keychain.items(),
        vec![(
            (KEYCHAIN_WORKSPACE.to_owned(), view.id.clone()),
            SECRET.as_bytes().to_vec()
        )]
    );
    // The list beside it, what the page sees, and the error and debug forms hold no part of the secret path.
    let list = std::fs::read_to_string(folder.list()).unwrap();
    let page = serde_json::to_string(&store.list().unwrap()).unwrap();
    for shown in [&list, &page, &format!("{view:?}")] {
        assert!(
            !shown.contains("private-0123456789abcdef")
                && !shown.contains("fictional%40example.org")
                && !shown.contains("ical/"),
            "{shown}"
        );
    }
    assert!(
        list.contains("\"label\":\"Church office\"")
            && list.contains("\"host\":\"calendar.google.com\"")
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(folder.list())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}

#[test]
fn a_wrong_or_unreadable_address_is_never_kept() {
    let folder = Folder::new("wrong");
    let keychain = Arc::new(Keychain::default());
    for answer in [
        Err(LinkError::NotACalendar),
        Err(LinkError::Refused),
        Err(LinkError::NotOnTheInternet),
    ] {
        let fetch = Fetch::answering(answer);
        assert_eq!(
            links(&folder, &keychain, &fetch)
                .add("Office", SECRET)
                .map(|_| ()),
            answer.map(|_| ())
        );
    }
    // Refused before any request at all.
    let fetch = Fetch::answering(Ok(CALENDAR));
    let store = links(&folder, &keychain, &fetch);
    assert_eq!(
        store
            .add("Office", "http://calendar.google.com/a.ics")
            .map(|_| ()),
        Err(LinkError::NotHttps)
    );
    assert_eq!(
        store.add("Office", "https://192.168.1.4/a.ics").map(|_| ()),
        Err(LinkError::NotOnTheInternet)
    );
    assert_eq!(store.add("", SECRET).map(|_| ()), Err(LinkError::NoLabel));
    assert_eq!(
        store.add(&"x".repeat(MAX_LABEL + 1), SECRET).map(|_| ()),
        Err(LinkError::NoLabel)
    );
    assert_eq!(
        store.add("Line\nbreak", SECRET).map(|_| ()),
        Err(LinkError::NoLabel)
    );
    assert_eq!(fetch.calls.load(Ordering::SeqCst), 0);
    assert!(keychain.items().is_empty());
    assert_eq!(store.list().unwrap(), vec![]);
}

#[test]
fn at_most_eight_links() {
    let folder = Folder::new("many");
    let keychain = Arc::new(Keychain::default());
    let fetch = Fetch::answering(Ok(CALENDAR));
    let store = links(&folder, &keychain, &fetch);
    for i in 0..MAX_LINKS {
        store.add(&format!("Calendar {i}"), SECRET).unwrap();
    }
    assert_eq!(
        store.add("One more", SECRET).map(|_| ()),
        Err(LinkError::TooMany)
    );
    assert_eq!(store.list().unwrap().len(), MAX_LINKS);
    assert_eq!(keychain.items().len(), MAX_LINKS);
}

#[test]
fn reading_uses_the_keychain_address_and_says_when_it_is_gone() {
    let folder = Folder::new("read");
    let keychain = Arc::new(Keychain::default());
    let fetch = Fetch::answering(Ok(CALENDAR));
    let store = links(&folder, &keychain, &fetch);
    let (view, _) = store.add("Office", SECRET).unwrap();
    assert_eq!(store.read(&view.id).as_deref(), Ok(CALENDAR));
    assert_eq!(
        fetch.asked.lock().unwrap().last().map(String::as_str),
        Some(SECRET)
    );
    assert_eq!(store.read("0000000000000000"), Err(LinkError::Unknown));
    assert_eq!(store.read("../../etc/passwd"), Err(LinkError::Unknown));
    // An address changed outside Ozzie to somewhere local is checked again before reading.
    keychain
        .put(KEYCHAIN_WORKSPACE, &view.id, b"https://localhost/x.ics")
        .unwrap();
    assert_eq!(store.read(&view.id), Err(LinkError::NotOnTheInternet));
    keychain.delete(KEYCHAIN_WORKSPACE, &view.id).unwrap();
    assert_eq!(store.read(&view.id), Err(LinkError::Missing));
    assert!(store.list().unwrap()[0].missing);
}

#[test]
fn removing_forgets_the_address_and_the_entry() {
    let folder = Folder::new("remove");
    let keychain = Arc::new(Keychain::default());
    let fetch = Fetch::answering(Ok(CALENDAR));
    let store = links(&folder, &keychain, &fetch);
    let (first, _) = store.add("Office", SECRET).unwrap();
    let (second, _) = store.add("Home", SECRET).unwrap();
    store.remove(&first.id).unwrap();
    assert_eq!(
        store
            .list()
            .unwrap()
            .iter()
            .map(|l| l.label.as_str())
            .collect::<Vec<_>>(),
        vec!["Home"]
    );
    assert_eq!(keychain.items().len(), 1);
    assert_eq!(keychain.items()[0].0.1, second.id);
    assert_eq!(store.remove(&first.id), Err(LinkError::Unknown));
    assert_eq!(store.remove("nope"), Err(LinkError::Unknown));
}

#[test]
fn an_address_no_link_names_is_deleted_and_never_kept_without_its_entry() {
    let folder = Folder::new("orphan");
    let keychain = Arc::new(Keychain::default());
    let fetch = Fetch::answering(Ok(CALENDAR));
    let store = links(&folder, &keychain, &fetch);
    let (kept, _) = store.add("Office", SECRET).unwrap();
    // Left by a removal that stopped halfway; another service's items are not Ozzie's to touch.
    keychain
        .put(KEYCHAIN_WORKSPACE, "00000000000000aa", SECRET.as_bytes())
        .unwrap();
    keychain.put("something-else", "x", b"kept").unwrap();
    assert_eq!(store.list().unwrap().len(), 1);
    let left: Vec<String> = keychain
        .items()
        .into_iter()
        .map(|((w, o), _)| format!("{w}/{o}"))
        .collect();
    assert_eq!(
        left,
        vec![
            format!("{KEYCHAIN_WORKSPACE}/{}", kept.id),
            "something-else/x".to_owned()
        ]
    );

    // The list can't be written (a folder sits where its new copy is made): the address just put in the Keychain
    // is taken out again.
    let blocked = Folder::new("blocked");
    std::fs::create_dir_all(blocked.0.join("calendar-links.partial")).unwrap();
    let keychain = Arc::new(Keychain::default());
    let store = CalendarLinks::new(keychain.clone(), blocked.list(), fetch.clone());
    assert_eq!(
        store.add("Office", SECRET).map(|_| ()),
        Err(LinkError::Unavailable)
    );
    assert!(keychain.items().is_empty());
}

/// Review C, L1: a list Ozzie can't read (damaged, or written by a newer Ozzie after a downgrade) removes nothing
/// from the Keychain and isn't written over; entries it can't use are kept as they are and stop any pruning.
#[test]
fn a_list_that_cant_be_read_removes_nothing() {
    let folder = Folder::new("damaged");
    let keychain = Arc::new(Keychain::default());
    let fetch = Fetch::answering(Ok(CALENDAR));
    let store = links(&folder, &keychain, &fetch);
    let (kept, _) = store.add("Office", SECRET).unwrap();
    let saved = keychain.items();
    for text in [
        "not json",
        "{\"version\":2,\"links\":[]}",
        "{\"version\":1}",
    ] {
        std::fs::write(folder.list(), text).unwrap();
        assert_eq!(store.list(), Err(LinkError::ListUnreadable), "{text}");
        assert_eq!(
            store.add("Home", SECRET).map(|_| ()),
            Err(LinkError::ListUnreadable),
            "{text}"
        );
        assert_eq!(
            store.remove(&kept.id),
            Err(LinkError::ListUnreadable),
            "{text}"
        );
        assert_eq!(
            store.read(&kept.id),
            Err(LinkError::ListUnreadable),
            "{text}"
        );
        assert_eq!(keychain.items(), saved, "{text}");
        assert_eq!(std::fs::read_to_string(folder.list()).unwrap(), text);
    }
    // A list from a newer Ozzie with one entry this one can use and two it can't: the usable one is listed, nothing
    // is pruned (not even an address no entry names), and adding keeps the other entries exactly as they were.
    let newer = format!(
        "{{\"version\":1,\"links\":[{{\"id\":\"{}\",\"label\":\"Office\",\"host\":\"calendar.google.com\"}},{{\"id\":\"BAD\",\"label\":\"x\",\"host\":\"calendar.google.com\"}},{{\"kind\":\"from-a-newer-ozzie\"}}]}}",
        kept.id
    );
    std::fs::write(folder.list(), &newer).unwrap();
    keychain
        .put(
            KEYCHAIN_WORKSPACE,
            "00000000000000bb",
            b"https://calendar.google.com/x",
        )
        .unwrap();
    // The usable link by its label, and the two entries this version can't use as such (so they can be removed).
    assert_eq!(
        store
            .list()
            .unwrap()
            .iter()
            .map(|l| (l.label.as_str(), l.unusable))
            .collect::<Vec<_>>(),
        vec![("Office", false), ("", true), ("", true)]
    );
    assert_eq!(keychain.items().len(), 2);
    store.add("Home", SECRET).unwrap();
    let written = std::fs::read_to_string(folder.list()).unwrap();
    assert!(
        written.contains("\"id\":\"BAD\"") && written.contains("from-a-newer-ozzie"),
        "{written}"
    );
}

/// Review C, M1: the 20 s covers the whole read. A server that sends a byte now and then can't keep it going, and
/// nothing the server does holds the caller past the limit.
#[test]
fn a_slow_server_cant_hold_a_read_open() {
    struct Drip(std::time::Duration);
    impl Read for Drip {
        fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
            std::thread::sleep(self.0);
            out[0] = b'x';
            Ok(1)
        }
    }
    let started = std::time::Instant::now();
    let deadline = started + std::time::Duration::from_millis(200);
    assert_eq!(
        read_body(Drip(std::time::Duration::from_millis(20)), deadline),
        Err(LinkError::Timeout)
    );
    assert!(started.elapsed() < std::time::Duration::from_millis(600));
    // A whole read that doesn't finish: the caller has its answer at the limit.
    let started = std::time::Instant::now();
    let answer = within(std::time::Duration::from_millis(150), || {
        std::thread::sleep(std::time::Duration::from_secs(3));
        Ok(())
    });
    assert_eq!(answer, Err(LinkError::Timeout));
    assert!(started.elapsed() < std::time::Duration::from_millis(1_000));
    assert_eq!(within(std::time::Duration::from_secs(5), || Ok(7)), Ok(7));
    // Too much is refused as it arrives.
    let far = std::time::Instant::now() + std::time::Duration::from_secs(60);
    assert_eq!(
        read_body(io::repeat(b'x').take(MAX_CALENDAR_BYTES as u64 + 10), far),
        Err(LinkError::TooLarge)
    );
    assert_eq!(
        read_body(&b"BEGIN:VCALENDAR"[..], far),
        Ok(b"BEGIN:VCALENDAR".to_vec())
    );
}

/// Review C, L4: three redirects are followed and a fourth isn't; each must pass the same checks.
#[test]
fn three_redirects_each_checked() {
    let ok = Url::parse("https://calendar.google.com/a.ics").unwrap();
    for previous in 1..=3 {
        assert!(redirect_allowed(previous, &ok), "{previous}");
    }
    assert!(!redirect_allowed(4, &ok));
    for bad in [
        "http://calendar.google.com/a.ics",
        "https://127.0.0.1/a.ics",
        "https://calendar.google.com:8443/a.ics",
    ] {
        assert!(!redirect_allowed(1, &Url::parse(bad).unwrap()), "{bad}");
    }
}

/// Review C, L10: a feed that isn't valid UTF-8 is read, not refused whole: a fold in the middle of a character is
/// undone first, and what still can't be read becomes U+FFFD, which the page says.
#[test]
fn a_feed_with_unreadable_bytes_is_read_with_them_marked() {
    let split = [
        b"BEGIN:VCALENDAR\r\nSUMMARY:Caf".to_vec(),
        vec![0xc3],
        b"\r\n ".to_vec(),
        vec![0xa9],
        b"\r\nEND:VCALENDAR\r\n".to_vec(),
    ]
    .concat();
    assert_eq!(
        calendar_text(split).unwrap(),
        "BEGIN:VCALENDAR\r\nSUMMARY:Caf\u{e9}\r\nEND:VCALENDAR\r\n"
    );
    let stray = [
        b"BEGIN:VCALENDAR\r\nSUMMARY:A".to_vec(),
        vec![0xff],
        b"B\r\nEND:VCALENDAR".to_vec(),
    ]
    .concat();
    assert_eq!(
        calendar_text(stray).unwrap(),
        "BEGIN:VCALENDAR\r\nSUMMARY:A\u{fffd}B\r\nEND:VCALENDAR"
    );
}

/// One real read of a public, non-secret calendar (Google's US holidays), to see the guarded client work through
/// TLS and any redirects: `cargo test -- --ignored live_public_calendar`. Needs the network.
#[test]
#[ignore]
fn live_public_calendar() {
    let client = GuardedHttp::new().unwrap();
    let url = Url::parse("https://calendar.google.com/calendar/ical/en.usa%23holiday%40group.v.calendar.google.com/public/basic.ics").unwrap();
    let text = client.get(&url).unwrap();
    assert!(text.trim_start().starts_with("BEGIN:VCALENDAR"));
}

/// Calendar text stays on this Mac: no module that sends anything to a model (every route, the agent steps, Ozzie
/// managed, regular jobs) or writes the copy for other AI apps refers to calendar links at all.
#[test]
fn no_model_route_or_shared_copy_refers_to_calendar_links() {
    for (name, source) in [
        ("model.rs", include_str!("model.rs")),
        ("agent.rs", include_str!("agent.rs")),
        ("hosted.rs", include_str!("hosted.rs")),
        ("responsibilities.rs", include_str!("responsibilities.rs")),
        ("shared_check.rs", include_str!("shared_check.rs")),
        ("name_guard.rs", include_str!("name_guard.rs")),
    ] {
        assert!(
            !source.contains("calendar_link")
                && !source.contains("CalendarLinks")
                && !source.contains("CalendarFetch"),
            "{name} refers to calendar links"
        );
    }
}

/// Review C2, N1: an entry this version can't use is listed so it can be removed (with the address saved for it), and
/// a list that can't be read at all can be forgotten whole: every address in this Keychain service, then the list.
#[test]
fn unusable_entries_and_unreadable_lists_can_be_cleared() {
    let folder = Folder::new("clear");
    let keychain = Arc::new(Keychain::default());
    let fetch = Fetch::answering(Ok(CALENDAR));
    let store = links(&folder, &keychain, &fetch);
    let (kept, _) = store.add("Office", SECRET).unwrap();
    let newer = format!(
        "{{\"version\":1,\"links\":[{{\"id\":\"{}\",\"label\":\"Office\",\"host\":\"calendar.google.com\"}},{{\"id\":\"00000000000000cc\",\"label\":\"x\",\"host\":\"localhost\"}},{{\"kind\":\"from-a-newer-ozzie\"}}]}}",
        kept.id
    );
    std::fs::write(folder.list(), &newer).unwrap();
    keychain
        .put(
            KEYCHAIN_WORKSPACE,
            "00000000000000cc",
            b"https://calendar.google.com/y",
        )
        .unwrap();
    let listed = store.list().unwrap();
    assert_eq!(
        listed
            .iter()
            .map(|l| (l.id.as_str(), l.unusable))
            .collect::<Vec<_>>(),
        vec![
            (kept.id.as_str(), false),
            ("unusable-0", true),
            ("unusable-1", true)
        ]
    );
    assert!(listed[1].label.is_empty() && listed[1].shown.is_empty());
    // Removing the first unusable entry takes its address out of the Keychain too; the usable link stays.
    store.remove("unusable-0").unwrap();
    assert_eq!(keychain.items().len(), 1);
    assert_eq!(
        store
            .list()
            .unwrap()
            .iter()
            .map(|l| l.unusable)
            .collect::<Vec<_>>(),
        vec![false, true]
    );
    store.remove("unusable-0").unwrap();
    assert_eq!(store.list().unwrap().len(), 1);
    assert_eq!(store.remove("unusable-9"), Err(LinkError::Unknown));
    assert_eq!(store.remove("unusable-x"), Err(LinkError::Unknown));

    // A list that can't be read: forgetting all deletes every address of this service and the list, and starts empty.
    store.add("Home", SECRET).unwrap();
    keychain.put("something-else", "x", b"kept").unwrap();
    std::fs::write(folder.list(), "{\"version\":2}").unwrap();
    assert_eq!(store.list(), Err(LinkError::ListUnreadable));
    store.forget_all().unwrap();
    assert!(!folder.list().exists());
    let left: Vec<String> = keychain
        .items()
        .into_iter()
        .map(|((w, o), _)| format!("{w}/{o}"))
        .collect();
    assert_eq!(left, vec!["something-else/x".to_owned()]);
    assert_eq!(store.list().unwrap(), vec![]);
    store.add("Office again", SECRET).unwrap();
    assert_eq!(store.list().unwrap().len(), 1);
}
