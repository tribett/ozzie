//! A private link to a published sheet: what counts as a sheet (not a sign-in page, not too large, not binary), the
//! guarded client refusing before it connects, and the address kept only in the Keychain, never in the list beside
//! it, anything the page sees, an error or a debug form. A stand-in Keychain and fetcher; the guarded client is
//! exercised against refused addresses only, so no test here reaches the network (the one live read is ignored unless
//! asked for, with an address given in the environment). Fictional addresses only.
use super::*;
use crate::calendar_link::{LinkView, MAX_LINKS, read_body_up_to, redirect_allowed, within};
use crate::credentials::StoreError;
use std::collections::HashMap;
use std::io::{self, Read};
use std::net::IpAddr;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

/// A published sheet's address: the secret part is what follows the host.
const SECRET: &str = "https://docs.google.com/spreadsheets/d/e/2PACX-fictional0123456789abcdef/pub?gid=0&single=true&output=csv";
const SECRET_PARTS: [&str; 3] = [
    "2PACX-fictional0123456789abcdef",
    "spreadsheets/d/e",
    "output=csv",
];
const CSV: &[u8] = b"Name,Team,Door\r\nAvery Brightwater,Greeter,East door\r\n";

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
/// What the guarded GET would give back, as the stand-in's answer: the body, and the Content-Type the site said.
struct Fetch {
    answer: Mutex<Result<Vec<u8>, LinkError>>,
    content_type: Mutex<Option<String>>,
    asked: Mutex<Vec<String>>,
    calls: AtomicUsize,
}
impl Fetch {
    fn answering(answer: Result<&[u8], LinkError>) -> Arc<Self> {
        Arc::new(Self {
            answer: Mutex::new(answer.map(<[u8]>::to_vec)),
            content_type: Mutex::default(),
            asked: Mutex::default(),
            calls: AtomicUsize::new(0),
        })
    }
    fn set(&self, answer: Result<&[u8], LinkError>) {
        *self.answer.lock().unwrap() = answer.map(<[u8]>::to_vec);
    }
    fn typed(&self, content_type: Option<&str>) {
        *self.content_type.lock().unwrap() = content_type.map(str::to_owned);
    }
}
impl SheetFetch for Fetch {
    fn get(&self, url: &Url) -> Result<Fetched, LinkError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.asked.lock().unwrap().push(url.to_string());
        let body = self.answer.lock().unwrap().clone()?;
        Ok(Fetched {
            content_type: self.content_type.lock().unwrap().clone(),
            body,
        })
    }
}
struct Folder(PathBuf);
impl Folder {
    fn new(name: &str) -> Self {
        let dir =
            std::env::temp_dir().join(format!("ozzie-sheet-links-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        Self(dir)
    }
    fn list(&self) -> PathBuf {
        self.0.join(LIST_FILE)
    }
}
impl Drop for Folder {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn links(folder: &Folder, keychain: &Arc<Keychain>, fetch: &Arc<Fetch>) -> SheetLinks {
    sheet_links(keychain.clone(), folder.list(), fetch.clone())
}
/// Every way the address could show: as written, and each secret part of it.
fn holds_secret(text: &str) -> bool {
    text.contains(SECRET) || SECRET_PARTS.iter().any(|p| text.contains(p))
}
fn utf16(text: &str, big: bool) -> Vec<u8> {
    let mut out = if big {
        vec![0xfe, 0xff]
    } else {
        vec![0xff, 0xfe]
    };
    for unit in text.encode_utf16() {
        out.extend(if big {
            unit.to_be_bytes()
        } else {
            unit.to_le_bytes()
        });
    }
    out
}

#[test]
fn a_published_sheet_is_read_once_then_its_address_kept_only_in_the_keychain() {
    let folder = Folder::new("add");
    let keychain = Arc::new(Keychain::default());
    let fetch = Fetch::answering(Ok(CSV));
    let store = links(&folder, &keychain, &fetch);
    let (view, bytes) = store.add(LABEL, &format!("  {SECRET}  ")).unwrap();
    assert_eq!(bytes, CSV);
    assert_eq!(view.label, LABEL);
    assert_eq!(view.shown, "docs.google.com/\u{2022}\u{2022}\u{2022}");
    // Read once, before anything was kept, at the address as written.
    assert_eq!(*fetch.asked.lock().unwrap(), vec![SECRET.to_owned()]);
    assert_eq!(
        keychain.items(),
        vec![(
            (KEYCHAIN_WORKSPACE.to_owned(), view.id.clone()),
            SECRET.as_bytes().to_vec()
        )]
    );
    // Read again from the Keychain's address.
    assert_eq!(store.read(&view.id), Ok(CSV.to_vec()));
    assert_eq!(fetch.calls.load(Ordering::SeqCst), 2);
    // The list beside it, what the page sees, and the debug forms hold no part of the address but its host.
    let list = std::fs::read_to_string(folder.list()).unwrap();
    let page = serde_json::to_string(&store.list().unwrap()).unwrap();
    for shown in [
        &list,
        &page,
        &format!("{view:?}"),
        &format!("{:?}", store.list()),
    ] {
        assert!(!holds_secret(shown), "{shown}");
    }
    assert!(
        list.contains("\"host\":\"docs.google.com\"") && list.contains("\"label\":\"Church list\"")
    );
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

#[test]
fn a_sign_in_page_is_refused_as_a_web_page_and_nothing_is_kept() {
    for page in [
        b"<!DOCTYPE html><html><head><title>Sign in</title>".to_vec(),
        b"\r\n\t  <!doctype HTML>".to_vec(),
        b"<HTML lang=\"en\"><body>Sign in".to_vec(),
        b"\xef\xbb\xbf\n<html>".to_vec(),
        utf16("\u{feff} <!DocType html>", false),
        utf16("<html>", true),
    ] {
        assert_eq!(
            sheet_bytes(page.clone()),
            Err(LinkError::WebPage),
            "{page:?}"
        );
        let folder = Folder::new("web-page");
        let keychain = Arc::new(Keychain::default());
        let fetch = Fetch::answering(Ok(&page));
        let store = links(&folder, &keychain, &fetch);
        assert_eq!(
            store.add(LABEL, SECRET).map(|_| ()),
            Err(LinkError::WebPage)
        );
        assert!(keychain.items().is_empty());
        assert_eq!(store.list().unwrap(), Vec::<LinkView>::new());
    }
    // A sheet that only mentions a page further in is a sheet.
    assert!(sheet_bytes(b"Name,Notes\nAvery,<html> in a cell\n".to_vec()).is_ok());
}

/// Review T, L1: a web page is refused when the site says so (Content-Type text/html or application/xhtml+xml, with any
/// parameters, in any case) or when it starts like one: after any white space, a byte-order mark or a non-breaking
/// space, `<` then `!` (a doctype or a comment), `?` (XML) or a letter (a tag). A sheet whose first cell starts with `<`
/// then something else is still a sheet.
#[test]
fn a_web_page_is_refused_by_its_content_type_or_by_how_it_starts() {
    let read = |content_type: Option<&str>, body: &[u8]| {
        sheet(Fetched {
            content_type: content_type.map(str::to_owned),
            body: body.to_vec(),
        })
    };
    for content_type in [
        "text/html",
        "text/html; charset=utf-8",
        "TEXT/HTML",
        " text/html ;q=1",
        "application/xhtml+xml",
        "Application/XHTML+XML; charset=UTF-8",
    ] {
        assert_eq!(
            read(Some(content_type), CSV),
            Err(LinkError::WebPage),
            "{content_type}"
        );
    }
    for content_type in [
        None,
        Some("text/csv"),
        Some("text/plain; charset=utf-8"),
        Some("application/octet-stream"),
        Some("text/html-sandboxed"),
    ] {
        assert_eq!(
            read(content_type, CSV),
            Ok(CSV.to_vec()),
            "{content_type:?}"
        );
    }
    let nbsp_latin = [b"\xa0".as_slice(), b"<!DOCTYPE html>"].concat();
    let bom_nbsp = [
        b"\xef\xbb\xbf\xc2\xa0\xc2\xa0".as_slice(),
        b"<!DOCTYPE html>",
    ]
    .concat();
    for page in [
        b"<!-- served by a sign-in page -->\n<html>".to_vec(),
        b"<?xml version=\"1.0\"?><html xmlns=\"http://www.w3.org/1999/xhtml\">".to_vec(),
        b"<head><title>Sign in</title></head>".to_vec(),
        b"\n<body>".to_vec(),
        b"<script>location.href='/x'</script>".to_vec(),
        b"<meta http-equiv=\"refresh\" content=\"0\">".to_vec(),
        b"<b>Name</b>,Team\n".to_vec(),
        "\u{a0}<!DOCTYPE html>".as_bytes().to_vec(),
        nbsp_latin,
        bom_nbsp,
        utf16("\u{a0}<head>", false),
    ] {
        assert_eq!(read(None, &page), Err(LinkError::WebPage), "{page:?}");
    }
    for sheet_text in [
        "<3 cups,Team\nCoffee,Greeter\n",
        "< 5 years,Team\nNursery,Nursery\n",
        "<=5,Team\n",
        "Name,Notes\n<html>,in the first column of a row\n",
        "\u{a0}Name,Team\n",
    ] {
        assert_eq!(
            read(None, sheet_text.as_bytes()),
            Ok(sheet_text.as_bytes().to_vec()),
            "{sheet_text:?}"
        );
    }
    // Through the store: the site's word that it is a web page refuses the add, and nothing is kept.
    let folder = Folder::new("content-type");
    let keychain = Arc::new(Keychain::default());
    let fetch = Fetch::answering(Ok(CSV));
    fetch.typed(Some("text/html; charset=utf-8"));
    let store = links(&folder, &keychain, &fetch);
    assert_eq!(
        store.add(LABEL, SECRET).map(|_| ()),
        Err(LinkError::WebPage)
    );
    assert!(keychain.items().is_empty());
    fetch.typed(Some("text/csv"));
    assert!(store.add(LABEL, SECRET).is_ok());
}

/// Review T, L1: a JSON object or array (an error a site gives with status 200, say) is not a sheet. Only text that
/// parses whole as JSON is refused, so a one-column sheet whose first cell starts with `{` or `[` is still a sheet.
#[test]
fn json_is_not_a_sheet_but_a_one_column_sheet_starting_with_a_bracket_is() {
    for json in [
        "{\"error\":\"not published\",\"code\":401}",
        "  [1, 2, 3]",
        "\u{feff}[{\"name\":\"Avery\"}]",
        "{\n  \"rows\": []\n}\n",
    ] {
        assert_eq!(
            sheet(Fetched {
                content_type: None,
                body: json.as_bytes().to_vec()
            }),
            Err(LinkError::NotASheet),
            "{json:?}"
        );
    }
    for one_column in [
        "[Volunteers]\nAvery\nBlake\n",
        "{Name}\nAvery\n",
        "[x]",
        "[1, 2]\n[3, 4]\n",
        "{}\nnot json after\n",
    ] {
        assert_eq!(
            sheet(Fetched {
                content_type: None,
                body: one_column.as_bytes().to_vec()
            }),
            Ok(one_column.as_bytes().to_vec()),
            "{one_column:?}"
        );
    }
}

/// Review T, C: a host too long to show whole on the page is refused before anything is read, not cut.
#[test]
fn a_host_too_long_to_show_whole_is_refused_before_reading() {
    let folder = Folder::new("long-host");
    let keychain = Arc::new(Keychain::default());
    let fetch = Fetch::answering(Ok(CSV));
    let store = links(&folder, &keychain, &fetch);
    // A host of exactly `n` characters: labels of at most 60 in front of a fictional name.
    let host = |n: usize| {
        let mut host = String::from("fictional-church.example");
        while host.len() < n {
            let room = n - host.len();
            host = if room >= 2 {
                format!("{}.{host}", "a".repeat((room - 1).min(60)))
            } else {
                format!("b{host}")
            };
        }
        host
    };
    let (fits, over) = (host(MAX_HOST), host(MAX_HOST + 1));
    assert_eq!((fits.len(), over.len()), (MAX_HOST, MAX_HOST + 1));
    assert_eq!(
        store
            .add(LABEL, &format!("https://{over}/pub.csv"))
            .map(|_| ()),
        Err(LinkError::NotAnAddress)
    );
    assert_eq!(fetch.calls.load(Ordering::SeqCst), 0);
    let (view, _) = store
        .add(LABEL, &format!("https://{fits}/pub.csv"))
        .unwrap();
    assert_eq!(view.shown, format!("{fits}/\u{2022}\u{2022}\u{2022}"));
    assert_eq!(MAX_HOST + "/\u{2022}\u{2022}\u{2022}".chars().count(), 255);
}

/// Review T, B: whether an address is already saved, found inside the store by comparing it with each saved address
/// as Ozzie reads them; only the link's id comes back, never an address.
#[test]
fn an_address_already_saved_is_found_by_its_id_only() {
    let folder = Folder::new("saved-id");
    let keychain = Arc::new(Keychain::default());
    let fetch = Fetch::answering(Ok(CSV));
    let store = links(&folder, &keychain, &fetch);
    assert_eq!(store.saved_id(SECRET), Ok(None));
    let (view, _) = store.add(LABEL, SECRET).unwrap();
    let asked = fetch.calls.load(Ordering::SeqCst);
    for same in [
        SECRET.to_owned(),
        format!("  {SECRET}\n"),
        format!("{SECRET}#gid=0"),
        SECRET.replace("docs.google.com", "DOCS.google.com"),
    ] {
        assert_eq!(store.saved_id(&same), Ok(Some(view.id.clone())), "{same}");
    }
    for other in [
        SECRET.replace("gid=0", "gid=1"),
        "https://sheets.fictional-church.example/pub.csv".to_owned(),
        "not an address".to_owned(),
    ] {
        assert_eq!(store.saved_id(&other), Ok(None), "{other}");
    }
    // Nothing is read to compare.
    assert_eq!(fetch.calls.load(Ordering::SeqCst), asked);
}

#[test]
fn over_2_mb_a_workbook_or_binary_is_refused_and_utf16_may_hold_nul_bytes() {
    assert_eq!(MAX_SHEET_BYTES, 2_097_152);
    let mut limit = CSV.to_vec();
    limit.resize(MAX_SHEET_BYTES, b'a');
    assert_eq!(
        sheet_bytes(limit.clone()).map(|b| b.len()),
        Ok(MAX_SHEET_BYTES)
    );
    limit.push(b'a');
    assert_eq!(sheet_bytes(limit), Err(LinkError::TooLarge));
    // Refused as it arrives, at the sheet's own limit, not the calendar's.
    let far = Instant::now() + Duration::from_secs(60);
    assert_eq!(
        read_body_up_to(
            io::repeat(b'x').take(MAX_SHEET_BYTES as u64 + 1),
            far,
            MAX_SHEET_BYTES
        ),
        Err(LinkError::TooLarge)
    );
    assert_eq!(
        read_body_up_to(
            io::repeat(b'x').take(MAX_SHEET_BYTES as u64),
            far,
            MAX_SHEET_BYTES
        )
        .map(|b| b.len()),
        Ok(MAX_SHEET_BYTES)
    );
    for (bytes, why) in [
        (b"PK\x03\x04\x14\x00".to_vec(), LinkError::Workbook),
        (b"PK\x05\x06\x00\x00".to_vec(), LinkError::Workbook),
        (
            vec![0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0],
            LinkError::Workbook,
        ),
        (b"Name,Team\n\x00\x01".to_vec(), LinkError::NotText),
        (b"\xef\xbb\xbfName\x00".to_vec(), LinkError::NotText),
    ] {
        assert_eq!(sheet_bytes(bytes), Err(why));
    }
    for text in [utf16("Name,Team\r\n", false), utf16("Name,Team\r\n", true)] {
        assert_eq!(sheet_bytes(text.clone()), Ok(text));
    }
    assert_eq!(sheet_bytes(Vec::new()), Ok(Vec::new()));
    // An oversize answer through the store keeps nothing.
    let folder = Folder::new("large");
    let keychain = Arc::new(Keychain::default());
    let fetch = Fetch::answering(Err(LinkError::TooLarge));
    assert_eq!(
        links(&folder, &keychain, &fetch)
            .add(LABEL, SECRET)
            .map(|_| ()),
        Err(LinkError::TooLarge)
    );
    assert!(keychain.items().is_empty());
}

fn private_lookup(_: &str) -> io::Result<Vec<IpAddr>> {
    Ok(vec!["10.0.0.7".parse().unwrap()])
}
fn loopback_lookup(_: &str) -> io::Result<Vec<IpAddr>> {
    Ok(vec![
        "127.0.0.1".parse().unwrap(),
        "8.8.8.8".parse().unwrap(),
    ])
}

#[test]
fn the_guarded_client_refuses_a_non_https_or_local_address_before_connecting() {
    // The real client, given addresses it must refuse before any request (no network is used).
    let client = GuardedHttp::new().unwrap();
    for (raw, why) in [
        (
            "http://docs.google.com/spreadsheets/d/e/x/pub?output=csv",
            LinkError::NotHttps,
        ),
        ("ftp://docs.google.com/x.csv", LinkError::NotHttps),
        ("https://192.168.1.10/x.csv", LinkError::NotOnTheInternet),
        ("https://localhost/x.csv", LinkError::NotOnTheInternet),
        (
            "https://docs.google.com:8443/x.csv",
            LinkError::NotOnTheInternet,
        ),
        (
            "https://office:pw@docs.google.com/x.csv",
            LinkError::SignInInAddress,
        ),
    ] {
        assert_eq!(
            SheetFetch::get(&client, &Url::parse(raw).unwrap()),
            Err(why),
            "{raw}"
        );
    }
    // A public-looking name whose DNS answer is a local address, or partly this Mac: the resolver wired into the
    // client refuses it, so nothing connects.
    let url = Url::parse("https://sheets.fictional-church.example/pub.csv").unwrap();
    for lookup in [
        private_lookup as crate::calendar_link::LookupFn,
        loopback_lookup,
    ] {
        let client = GuardedHttp::with_lookup(lookup).unwrap();
        assert_eq!(
            SheetFetch::get(&client, &url),
            Err(LinkError::NotOnTheInternet)
        );
    }
    // Through the store, a non-https address is refused before any read and nothing is kept.
    let folder = Folder::new("not-https");
    let keychain = Arc::new(Keychain::default());
    let fetch = Fetch::answering(Ok(CSV));
    let store = links(&folder, &keychain, &fetch);
    for (raw, why) in [
        (
            "http://docs.google.com/spreadsheets/d/e/x/pub?output=csv",
            LinkError::NotHttps,
        ),
        ("https://10.1.2.3/x.csv", LinkError::NotOnTheInternet),
        ("https://intranet/x.csv", LinkError::NotOnTheInternet),
        ("docs.google.com/x.csv", LinkError::NotAnAddress),
    ] {
        assert_eq!(store.add(LABEL, raw).map(|_| ()), Err(why), "{raw}");
    }
    assert_eq!(fetch.calls.load(Ordering::SeqCst), 0);
    assert!(keychain.items().is_empty());
}

#[test]
fn a_redirect_to_a_private_address_is_refused() {
    // The redirect rule the client follows (the same one as a calendar link's): each of three redirects must pass the
    // same checks, and a fourth is refused.
    let published =
        Url::parse("https://docs.google.com/spreadsheets/d/e/x/pub?output=csv").unwrap();
    let served = Url::parse("https://doc-0s-1c-sheets.googleusercontent.com/pub/x").unwrap();
    assert!(redirect_allowed(1, &served) && redirect_allowed(3, &published));
    assert!(!redirect_allowed(4, &served));
    for private in [
        "https://192.168.1.10/pub.csv",
        "https://10.0.0.7/pub.csv",
        "https://169.254.169.254/latest/meta-data",
        "https://[fd12::1]/pub.csv",
        "https://localhost/pub.csv",
        "https://printer.local/pub.csv",
        "http://docs.google.com/pub.csv",
        "https://docs.google.com:444/pub.csv",
    ] {
        assert!(
            !redirect_allowed(1, &Url::parse(private).unwrap()),
            "{private}"
        );
    }
    // A redirect the client refuses reaches the store as moved-elsewhere, and nothing is kept; a saved link whose
    // read is now redirected somewhere private keeps its address and says so.
    let folder = Folder::new("redirect");
    let keychain = Arc::new(Keychain::default());
    let fetch = Fetch::answering(Err(LinkError::MovedElsewhere));
    let store = links(&folder, &keychain, &fetch);
    assert_eq!(
        store.add(LABEL, SECRET).map(|_| ()),
        Err(LinkError::MovedElsewhere)
    );
    assert!(keychain.items().is_empty());
    fetch.set(Ok(CSV));
    let (view, _) = store.add(LABEL, SECRET).unwrap();
    fetch.set(Err(LinkError::MovedElsewhere));
    assert_eq!(store.read(&view.id), Err(LinkError::MovedElsewhere));
    assert_eq!(keychain.items().len(), 1);
    // An address changed outside Ozzie to somewhere local is checked again before reading.
    keychain
        .put(
            KEYCHAIN_WORKSPACE,
            &view.id,
            b"https://192.168.1.10/pub.csv",
        )
        .unwrap();
    let before = fetch.calls.load(Ordering::SeqCst);
    assert_eq!(store.read(&view.id), Err(LinkError::NotOnTheInternet));
    assert_eq!(fetch.calls.load(Ordering::SeqCst), before);
}

/// A sheet's link is read as written: https only. A calendar's `webcal://` (which a calendar link reads as https) or any
/// other scheme is refused before anything is read, in any case; a calendar link keeps reading webcal as https.
#[test]
fn a_sheet_link_is_https_only_and_never_rewritten_from_webcal() {
    let folder = Folder::new("https-only");
    let keychain = Arc::new(Keychain::default());
    let fetch = Fetch::answering(Ok(CSV));
    let store = links(&folder, &keychain, &fetch);
    let rest = SECRET.trim_start_matches("https://");
    for scheme in [
        "webcal://",
        "webcals://",
        "WEBCAL://",
        "http://",
        "feed://",
        "ftp://",
    ] {
        let address = format!("{scheme}{rest}");
        assert_eq!(
            store.add(LABEL, &address).map(|_| ()),
            Err(LinkError::NotHttps),
            "{address}"
        );
    }
    assert_eq!(fetch.calls.load(Ordering::SeqCst), 0);
    assert!(keychain.items().is_empty());
    // https in any case, with white space around it, is the address as written.
    let (view, _) = store.add(LABEL, &format!("  HTTPS://{rest}\n")).unwrap();
    assert_eq!(*fetch.asked.lock().unwrap(), vec![SECRET.to_owned()]);
    assert_eq!(view.shown, "docs.google.com/\u{2022}\u{2022}\u{2022}");
    // A calendar link still reads webcal:// as https (calendar_link_tests.rs holds it too).
    assert_eq!(
        crate::calendar_link::normalize_address(&format!("webcal://{rest}"))
            .map(|u| u.scheme().to_owned()),
        Ok("https".to_owned())
    );
}

/// An address put in the Keychain outside Ozzie, under a saved link's account, for another host: never read under that
/// link (the page says "Read from docs.google.com"), and nothing is asked of either host. The same sheet's address as
/// Google writes it in another case, or with the name's final dot, is still that link's.
#[test]
fn an_address_swapped_for_another_host_in_the_keychain_is_not_read() {
    let folder = Folder::new("swapped");
    let keychain = Arc::new(Keychain::default());
    let fetch = Fetch::answering(Ok(CSV));
    let store = links(&folder, &keychain, &fetch);
    let (view, _) = store.add(LABEL, SECRET).unwrap();
    let before = fetch.calls.load(Ordering::SeqCst);
    for swapped in [
        "https://sheets.fictional-church.example/pub.csv",
        "https://docs.google.com.fictional-church.example/pub.csv",
        "https://google.com/spreadsheets/d/e/x/pub?output=csv",
    ] {
        keychain
            .put(KEYCHAIN_WORKSPACE, &view.id, swapped.as_bytes())
            .unwrap();
        assert_eq!(store.read(&view.id), Err(LinkError::Missing), "{swapped}");
        assert!(!format!("{:?}", store.read(&view.id)).contains("fictional-church"));
    }
    assert_eq!(fetch.calls.load(Ordering::SeqCst), before);
    for same in [
        SECRET.replace("docs.google.com", "DOCS.Google.com"),
        SECRET.replace("docs.google.com", "docs.google.com."),
    ] {
        keychain
            .put(KEYCHAIN_WORKSPACE, &view.id, same.as_bytes())
            .unwrap();
        assert_eq!(store.read(&view.id), Ok(CSV.to_vec()), "{same}");
    }
}

#[test]
fn a_slow_server_cant_hold_a_read_open() {
    struct Drip;
    impl Read for Drip {
        fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
            std::thread::sleep(Duration::from_millis(20));
            out[0] = b'x';
            Ok(1)
        }
    }
    let started = Instant::now();
    assert_eq!(
        read_body_up_to(Drip, started + Duration::from_millis(200), MAX_SHEET_BYTES),
        Err(LinkError::Timeout)
    );
    assert!(started.elapsed() < Duration::from_millis(600));
    // A read that never finishes: the caller has its answer at the limit.
    let started = Instant::now();
    let answer = within(Duration::from_millis(150), || {
        std::thread::sleep(Duration::from_secs(3));
        Ok(Vec::<u8>::new())
    });
    assert_eq!(answer, Err(LinkError::Timeout));
    assert!(started.elapsed() < Duration::from_millis(1_000));
    // Through the store, a timeout keeps nothing.
    let folder = Folder::new("slow");
    let keychain = Arc::new(Keychain::default());
    let fetch = Fetch::answering(Err(LinkError::Timeout));
    assert_eq!(
        links(&folder, &keychain, &fetch)
            .add(LABEL, SECRET)
            .map(|_| ()),
        Err(LinkError::Timeout)
    );
    assert!(keychain.items().is_empty());
}

#[test]
fn the_address_is_in_no_reply_error_list_or_debug_output() {
    let folder = Folder::new("secret");
    let keychain = Arc::new(Keychain::default());
    let fetch = Fetch::answering(Ok(CSV));
    let store = links(&folder, &keychain, &fetch);
    let (view, _) = store.add(LABEL, SECRET).unwrap();
    let mut seen: Vec<String> = vec![
        serde_json::to_string(&view).unwrap(),
        format!("{view:?}"),
        serde_json::to_string(&store.list().unwrap()).unwrap(),
        format!("{:?}", store.list()),
        std::fs::read_to_string(folder.list()).unwrap(),
    ];
    // Every refusal the store or the fetch can give, as the page gets it and as a debug form.
    for answer in [
        LinkError::WebPage,
        LinkError::NotText,
        LinkError::Workbook,
        LinkError::TooLarge,
        LinkError::Refused,
        LinkError::MovedElsewhere,
        LinkError::Timeout,
        LinkError::Unreachable,
        LinkError::NotOnTheInternet,
    ] {
        fetch.set(Err(answer));
        let read = store.read(&view.id);
        let added = store.add(LABEL, SECRET).map(|_| ());
        seen.extend([
            format!("{read:?}"),
            format!("{added:?}"),
            serde_json::to_string(&read.err()).unwrap(),
        ]);
        seen.push(answer.to_string());
    }
    for refused in [
        "http://docs.google.com/x",
        "https://office:pw@docs.google.com/x",
    ] {
        seen.push(format!("{:?}", store.add(LABEL, refused)));
    }
    for text in &seen {
        assert!(!holds_secret(text), "{text}");
    }
    // Only the Keychain holds it.
    assert_eq!(keychain.items().len(), 1);
    assert_eq!(keychain.items()[0].1, SECRET.as_bytes());
}

#[test]
fn at_most_eight_links_and_forgetting_touches_only_sheet_links() {
    let folder = Folder::new("many");
    let keychain = Arc::new(Keychain::default());
    let fetch = Fetch::answering(Ok(CSV));
    let store = links(&folder, &keychain, &fetch);
    assert_eq!(MAX_LINKS, 8);
    let mut ids = Vec::new();
    for _ in 0..MAX_LINKS {
        ids.push(store.add(LABEL, SECRET).unwrap().0.id);
    }
    assert_eq!(
        store.add(LABEL, SECRET).map(|_| ()),
        Err(LinkError::TooMany)
    );
    // Removing takes the address out of the Keychain, then the entry.
    store.remove(&ids[0]).unwrap();
    assert_eq!(store.list().unwrap().len(), MAX_LINKS - 1);
    assert_eq!(keychain.items().len(), MAX_LINKS - 1);
    // Something else's item in the same store is not a sheet link's to touch.
    keychain
        .put("calendar-link", "00000000000000aa", b"kept")
        .unwrap();
    store.forget_all().unwrap();
    assert!(!folder.list().exists());
    let left: Vec<String> = keychain
        .items()
        .into_iter()
        .map(|((w, o), _)| format!("{w}/{o}"))
        .collect();
    assert_eq!(left, vec!["calendar-link/00000000000000aa".to_owned()]);
}

#[test]
fn the_keychain_service_and_list_are_the_sheet_links_own() {
    // The real app's name, with the test copy's prefix in the test copy of Ozzie (variant.rs).
    assert_eq!(
        KEYCHAIN_SERVICE,
        if crate::variant::IS_TEST_COPY {
            "church.ozzie.desktop.test/church.ozzie.source-links.v1"
        } else {
            "church.ozzie.source-links.v1"
        }
    );
    assert_ne!(KEYCHAIN_SERVICE, crate::calendar_link::KEYCHAIN_SERVICE);
    assert_eq!(LIST_FILE, "source-links.json");
    assert_eq!(KEYCHAIN_WORKSPACE, "source-link");
}

/// A sheet's text stays on this Mac: no module that sends anything to a model (every route, the agent steps, Ozzie
/// managed, regular jobs) or writes the copy for other AI apps refers to sheet links at all.
#[test]
fn no_model_route_or_shared_copy_refers_to_sheet_links() {
    for (name, source) in [
        ("model.rs", include_str!("model.rs")),
        ("agent.rs", include_str!("agent.rs")),
        ("hosted.rs", include_str!("hosted.rs")),
        ("responsibilities.rs", include_str!("responsibilities.rs")),
        ("shared_check.rs", include_str!("shared_check.rs")),
        ("shortcuts_check.rs", include_str!("shortcuts_check.rs")),
        ("phone_notice.rs", include_str!("phone_notice.rs")),
        ("background.rs", include_str!("background.rs")),
        ("name_guard.rs", include_str!("name_guard.rs")),
    ] {
        assert!(
            !source.contains("sheet_link")
                && !source.contains("SheetLinks")
                && !source.contains("SheetFetch"),
            "{name} refers to sheet links"
        );
    }
}

/// One real read of a published sheet whose address is given in `OZZIE_LIVE_SHEET_URL` (a public, fictional sheet),
/// to see the guarded client work through TLS and Google's redirects:
/// `OZZIE_LIVE_SHEET_URL=… cargo test -- --ignored live_published_sheet`. Needs the network.
#[test]
#[ignore]
fn live_published_sheet() {
    let address = std::env::var("OZZIE_LIVE_SHEET_URL").expect("OZZIE_LIVE_SHEET_URL");
    let url = crate::calendar_link::normalize_address(&address).unwrap();
    let client = GuardedHttp::new().unwrap();
    let bytes = sheet(SheetFetch::get(&client, &url).unwrap()).unwrap();
    assert!(!bytes.is_empty() && bytes.len() <= MAX_SHEET_BYTES);
}

/// Review U, note 1: how a web page is told, at its edges. Every Content-Type the site sends counts, in a list too, and
/// one that isn't ASCII is read as far as it goes (its media type is plain ASCII); white space and invisible
/// characters before the first `<` are skipped however long they run within the bounded body; a closing tag first is a
/// page's too. A first cell that starts like a tag (`<b>Name</b>`, `<none>`) is still refused, and the sentence says
/// so; one that starts with `<` and a number or `=` is a sheet.
#[test]
fn a_web_page_is_told_at_its_edges() {
    let read = |content_type: Option<&str>, body: &[u8]| {
        sheet(Fetched {
            content_type: content_type.map(str::to_owned),
            body: body.to_vec(),
        })
    };
    for content_type in [
        "text/plain, text/html",
        "\"text/html\"",
        "text/csv, application/xhtml+xml; q=1",
    ] {
        assert_eq!(
            read(Some(content_type), CSV),
            Err(LinkError::WebPage),
            "{content_type}"
        );
    }
    // Every header, in order, and one that isn't ASCII, as the client gives them.
    let mut headers = reqwest::header::HeaderMap::new();
    headers.append(reqwest::header::CONTENT_TYPE, "text/plain".parse().unwrap());
    headers.append(reqwest::header::CONTENT_TYPE, "text/html".parse().unwrap());
    assert_eq!(
        crate::calendar_link::content_types(&headers).as_deref(),
        Some("text/plain, text/html")
    );
    let mut odd = reqwest::header::HeaderMap::new();
    odd.append(
        reqwest::header::CONTENT_TYPE,
        reqwest::header::HeaderValue::from_bytes(b"text/html; title=\xe9").unwrap(),
    );
    let said = crate::calendar_link::content_types(&odd);
    assert_eq!(
        read(said.as_deref(), CSV),
        Err(LinkError::WebPage),
        "{said:?}"
    );
    assert_eq!(
        crate::calendar_link::content_types(&reqwest::header::HeaderMap::new()),
        None
    );
    // Bodies.
    let far = |skip: &[u8], page: &[u8]| [skip.repeat(1500).as_slice(), page].concat();
    for page in [
        far(b" ", b"<!DOCTYPE html><html><body>Sign in</body></html>"),
        far(b"\n", b"<html><body>Sign in</body></html>"),
        far(b"\r\n\t", b"<html>"),
        "\u{200b}<html><body>Sign in</body></html>"
            .as_bytes()
            .to_vec(),
        "\u{2060}<html><body>Sign in</body></html>"
            .as_bytes()
            .to_vec(),
        "\u{feff}\u{a0}\u{200b}<!doctype html><p>x"
            .as_bytes()
            .to_vec(),
        utf16(&format!("{}<html>", " ".repeat(600)), false),
        b"</div><p>Sign in</p>".to_vec(),
        b"<b>Name</b>,Team\nAvery,Greeter\n".to_vec(),
        b"<none>,Team\n".to_vec(),
    ] {
        assert_eq!(
            read(None, &page),
            Err(LinkError::WebPage),
            "{:?}",
            String::from_utf8_lossy(&page[page.len().saturating_sub(40)..])
        );
    }
    for sheet_text in [
        "<1 year,Nursery\n",
        "<5,Toddlers\n",
        "<=10,Kids\n",
        "< 5,Toddlers\n",
        "\u{200b}Name,Team\n",
    ] {
        assert_eq!(
            read(None, sheet_text.as_bytes()),
            Ok(sheet_text.as_bytes().to_vec()),
            "{sheet_text:?}"
        );
    }
}

/// Audit item 33: every character church-added text treats as hidden is skipped before deciding whether a body starts
/// like a web page, not only the byte-order mark, the zero-width space, the joiners and the word joiner. A sheet that
/// starts with one of them and then its header is still a sheet.
#[test]
fn every_hidden_character_before_a_web_page_is_skipped() {
    let read = |body: &[u8]| {
        sheet(Fetched {
            content_type: None,
            body: body.to_vec(),
        })
    };
    // The soft hyphen, the Mongolian vowel separator, an invisible operator, the two direction marks, and a run of them
    // mixed with white space and tag characters.
    let mixed = "\u{ad}\u{200e} \u{180e}\u{2061}\u{200f}\u{202e}\u{2066}\u{fff9}\u{e0001}\u{e0041}\u{61c}\u{a0}";
    for skip in [
        "\u{ad}",
        "\u{180e}",
        "\u{2061}",
        "\u{200e}",
        "\u{200f}",
        "\u{2064}",
        "\u{206f}",
        "\u{fffb}",
        "\u{e007f}",
        mixed,
    ] {
        for page in ["<html><body>Sign in</body></html>", "<!doctype html><p>x"] {
            let text = format!("{skip}{page}");
            for body in [
                text.as_bytes().to_vec(),
                utf16(&text, false),
                utf16(&text, true),
            ] {
                assert_eq!(
                    read(&body),
                    Err(LinkError::WebPage),
                    "{}",
                    text.escape_unicode()
                );
            }
        }
        let sheet_text = format!("{skip}Team,Name\nGreeter,Avery Brightwater\n");
        assert_eq!(
            read(sheet_text.as_bytes()),
            Ok(sheet_text.as_bytes().to_vec()),
            "{}",
            sheet_text.escape_unicode()
        );
    }
    // A lone soft-hyphen byte (windows-1252 or Latin-1, not UTF-8) before a page is read one byte a character and skipped.
    assert_eq!(
        read(&[b"\xad\xad".as_slice(), b"<html>"].concat()),
        Err(LinkError::WebPage)
    );
}

/// The hidden characters are core/src/sources/text.ts `hidden`'s, exactly: that file's rule is written out as ranges to
/// core/test/fixtures/sources/hidden.json (core/test/sources/hidden.test.ts), and every character is checked against
/// them here, so a change to either copy shows up as a failure on one side.
#[test]
fn the_hidden_characters_are_the_pages_own() {
    let ranges: Vec<(u32, u32)> =
        serde_json::from_str(include_str!("../../test/fixtures/sources/hidden.json")).unwrap();
    assert!(ranges.len() >= 10);
    let listed = |c: char| {
        ranges
            .iter()
            .any(|&(from, to)| (from..=to).contains(&u32::from(c)))
    };
    let differ: Vec<String> = (0..=u32::from(char::MAX))
        .filter_map(char::from_u32)
        .filter(|&c| hidden(c) != listed(c))
        .map(|c| c.escape_unicode().to_string())
        .collect();
    assert!(differ.is_empty(), "{differ:?}");
    for c in [
        '\u{feff}', '\u{200b}', '\u{200c}', '\u{200d}', '\u{2060}', '\u{ad}', '\u{200e}',
    ] {
        assert!(before_text(c), "{}", c.escape_unicode());
    }
    assert!(before_text(' ') && before_text('\u{a0}') && !before_text('<') && !before_text('N'));
}
