//! Private calendar links: the secret address of a Google, Outlook or iCloud calendar ("Secret address in iCal
//! format") that a leader pasted into Settings, so Today can show what is on it. Read-only: one GET, nothing else.
//!
//! The address is a secret (anyone holding it can read the calendar). It is kept only in this Mac's Keychain
//! (`KEYCHAIN_SERVICE`, one item per link), never in a settings file, never logged, never on a command line, and
//! never sent back to the page: the page sees a label and the host with the rest masked (`LinkView`). The list of
//! links beside it (`calendar-links.json` in the app's data folder) holds ids, labels and hosts only.
//!
//! The address is something a person pasted, so the fetch is guarded like any URL from outside:
//! - https only (`webcal://` and `webcals://` are read as https), port 443, no user name or password in it, and no
//!   other credentials sent (no cookies, no Authorization, no Referer);
//! - only a named host on the internet: no IP addresses, no `localhost`, `.local` or other local names, and the
//!   name must resolve to public addresses only (no loopback, private, link-local, carrier-grade NAT, multicast or
//!   reserved ranges). The client connects only to the addresses this check returned, so a second DNS answer can't
//!   point it somewhere else;
//! - at most three redirects, each to an address that passes the same checks; no system proxy;
//! - bounded: 5 s to connect, 10 s for any one wait on the server, and `TOTAL_LIMIT` (20 s) for the whole read,
//!   headers and body, however slowly the server sends; `MAX_CALENDAR_BYTES` at most;
//! - what comes back must be iCalendar text (`BEGIN:VCALENDAR` … `END:VCALENDAR`); text that isn't valid UTF-8 is
//!   unfolded first (a fold can split a character) and read with what can't be read marked, which the page says.
//!   The page parses it (core/src/calendar/ics.ts). Calendar text stays on this Mac and is never part of a model
//!   request.
use crate::credentials::{CredentialStore, StoreError};
use std::fs::OpenOptions;
use std::future::Future;
use std::io::{self, Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, ToSocketAddrs};
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};
use std::time::Duration;
use url::{Host, Url};

/// Keychain service for the addresses: account `["calendar-link", "<id>"]`, the address as the item's secret.
pub const KEYCHAIN_SERVICE: &str = "church.ozzie.calendar-links.v1";
const KEYCHAIN_WORKSPACE: &str = "calendar-link";
pub const MAX_LINKS: usize = 8;
pub const MAX_ADDRESS: usize = 2048;
pub const MAX_LABEL: usize = 60;
/// A year or two of a busy calendar is a few megabytes; a feed larger than this isn't read.
pub const MAX_CALENDAR_BYTES: usize = 8 * 1024 * 1024;
const MAX_REDIRECTS: usize = 3;
/** The whole read of one calendar, from connecting to the last byte. */
pub const TOTAL_LIMIT: Duration = Duration::from_secs(20);
/** Any one wait on the server: connecting, the headers, or the next piece of the body. */
const WAIT_LIMIT: Duration = Duration::from_secs(10);
const MAX_LIST_BYTES: u64 = 64 * 1024;

/// Why a link (a calendar's, or a published sheet's) couldn't be added or read. Closed codes: no address, host,
/// calendar text or sheet is ever in one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LinkError {
    /// Not a web address (or too long, or with spaces in it).
    NotAnAddress,
    /// Not https (or webcal, read as https).
    NotHttps,
    /// A user name or password written into the address.
    SignInInAddress,
    /// An IP address, a local name, another port, or a name that points at this Mac or a local network.
    NotOnTheInternet,
    /// The label is empty, too long or has control characters.
    NoLabel,
    TooMany,
    /// No link with that id.
    Unknown,
    /// The address isn't in the Keychain any more, or what is there now is for another host than the one listed.
    Missing,
    /// The list of links on this Mac can't be read (damaged, or saved by a newer Ozzie). Nothing is removed.
    ListUnreadable,
    Unreachable,
    Timeout,
    /// The calendar's website answered with something other than the calendar (401, 403, 404, …).
    Refused,
    /// A redirect to an address that fails the checks above, or too many redirects.
    MovedElsewhere,
    TooLarge,
    NotACalendar,
    /// A published sheet's link only (sheet_link.rs): a web page (often a sign-in page) instead of the sheet.
    WebPage,
    /// A published sheet's link only: a workbook (a ZIP or an older Office file), not text.
    Workbook,
    /// A published sheet's link only: a NUL byte without a UTF-16 byte-order mark, so not text.
    NotText,
    /// A published sheet's link only: something other than a sheet (a JSON object or array).
    NotASheet,
    Locked,
    Denied,
    Unavailable,
}
impl std::fmt::Display for LinkError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for LinkError {}
impl From<StoreError> for LinkError {
    fn from(error: StoreError) -> Self {
        match error {
            StoreError::Locked => Self::Locked,
            StoreError::Denied => Self::Denied,
            StoreError::Unavailable => Self::Unavailable,
        }
    }
}

// ---- Where a request may go ---------------------------------------------------------------------------------

/// The address a leader pasted, as the https URL Ozzie will read, or why not. The fragment is dropped.
pub fn normalize_address(raw: &str) -> Result<Url, LinkError> {
    let text = raw.trim();
    if text.is_empty()
        || text.len() > MAX_ADDRESS
        || text.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err(LinkError::NotAnAddress);
    }
    let lower = text.to_ascii_lowercase();
    let text = if let Some(rest) = lower.strip_prefix("webcals://").map(|_| &text[10..]) {
        format!("https://{rest}")
    } else if let Some(rest) = lower.strip_prefix("webcal://").map(|_| &text[9..]) {
        format!("https://{rest}")
    } else {
        text.to_owned()
    };
    let mut url = Url::parse(&text).map_err(|_| LinkError::NotAnAddress)?;
    check_target(&url)?;
    url.set_fragment(None);
    if url.as_str().len() > MAX_ADDRESS {
        return Err(LinkError::NotAnAddress);
    }
    Ok(url)
}

/// Whether a request may go to `url`: https on port 443, a public host name, no sign-in written into it.
pub fn check_target(url: &Url) -> Result<(), LinkError> {
    if url.scheme() != "https" {
        return Err(LinkError::NotHttps);
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(LinkError::SignInInAddress);
    }
    // `port()` is None for https's own 443.
    if url.port().is_some() {
        return Err(LinkError::NotOnTheInternet);
    }
    match url.host() {
        Some(Host::Domain(name)) if public_name(name) => Ok(()),
        _ => Err(LinkError::NotOnTheInternet),
    }
}

/// Names that only mean something on this Mac or a local network.
const LOCAL_NAMES: [&str; 10] = [
    "localhost",
    "local",
    "localdomain",
    "internal",
    "intranet",
    "lan",
    "home",
    "corp",
    "private",
    "arpa",
];
/// A host name that could be on the internet: at least two labels, not an IP address written as a name, and not
/// one of the local names above (or under one).
pub fn public_name(name: &str) -> bool {
    let name = name.trim_end_matches('.').to_ascii_lowercase();
    if name.is_empty() || !name.contains('.') || name.parse::<IpAddr>().is_ok() {
        return false;
    }
    let last = name.rsplit('.').next().unwrap_or_default();
    // A numeric last label is how an IPv4 address in another notation looks; no public suffix is all digits.
    if last.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    !LOCAL_NAMES
        .iter()
        .any(|local| name == *local || name.ends_with(&format!(".{local}")))
}

fn public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(a == 0
        || a == 10
        || a == 127
        || (a == 100 && (64..128).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..32).contains(&b))
        || (a == 192 && b == 0 && (c == 0 || c == 2))
        || (a == 192 && b == 88 && c == 99)
        || (a == 192 && b == 168)
        || (a == 198 && (b == 18 || b == 19))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113)
        || a >= 224)
}
/// An address on the public internet: not loopback, private, link-local, carrier-grade NAT, documentation,
/// benchmarking, multicast, reserved or unspecified. IPv6 must be global unicast (2000::/3), less documentation
/// (2001:db8::/32, 3fff::/20), Teredo and other protocol assignments (2001::/23), 6to4 (2002::/16) and segment routing
/// (5f00::/16); an IPv4 address carried in IPv6 (mapped, or NAT64's 64:ff9b::/96) is judged as itself.
pub fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => public_v4(v4),
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return public_v4(v4);
            }
            let s = v6.segments();
            if s[0] == 0x64 && s[1] == 0xff9b && s[2..6] == [0, 0, 0, 0] {
                let [_, _, _, _, _, _, hi, lo] = s;
                return public_v4(Ipv4Addr::new(
                    (hi >> 8) as u8,
                    hi as u8,
                    (lo >> 8) as u8,
                    lo as u8,
                ));
            }
            (s[0] & 0xe000) == 0x2000
                && !(s[0] == 0x2001 && (s[1] == 0x0db8 || s[1] < 0x0200))
                && s[0] != 0x2002
                // Documentation (RFC 9637, 3fff::/20) and segment routing identifiers (RFC 9602, 5f00::/16).
                && !(s[0] == 0x3fff && s[1] < 0x1000)
                && s[0] != 0x5f00
        }
    }
}
/// The addresses a name resolved to, for connecting, only when every one of them is public: a name that points at
/// this Mac or a local network at all is refused.
pub fn public_addresses(found: &[IpAddr]) -> Result<Vec<SocketAddr>, LinkError> {
    if found.is_empty() {
        return Err(LinkError::Unreachable);
    }
    if !found.iter().all(|ip| public_ip(*ip)) {
        return Err(LinkError::NotOnTheInternet);
    }
    Ok(found.iter().map(|ip| SocketAddr::new(*ip, 443)).collect())
}

// ---- Fetching ---------------------------------------------------------------------------------------------

pub(crate) type LookupFn = fn(&str) -> io::Result<Vec<IpAddr>>;
fn system_lookup(host: &str) -> io::Result<Vec<IpAddr>> {
    Ok((host, 443).to_socket_addrs()?.map(|a| a.ip()).collect())
}

type LookupResult = Result<Vec<SocketAddr>, LinkError>;
/// A name lookup on its own thread, so the request's time limit still applies while the system resolves it.
struct ThreadLookup(Arc<Mutex<(Option<LookupResult>, Option<Waker>)>>);
impl ThreadLookup {
    fn start(host: String, lookup: LookupFn) -> Self {
        let shared: Arc<Mutex<(Option<LookupResult>, Option<Waker>)>> =
            Arc::new(Mutex::new((None, None)));
        let done = shared.clone();
        std::thread::spawn(move || {
            let result = if public_name(&host) {
                lookup(&host)
                    .map_err(|_| LinkError::Unreachable)
                    .and_then(|found| public_addresses(&found))
            } else {
                Err(LinkError::NotOnTheInternet)
            };
            let mut state = done.lock().unwrap_or_else(|e| e.into_inner());
            state.0 = Some(result);
            if let Some(waker) = state.1.take() {
                waker.wake();
            }
        });
        Self(shared)
    }
}
impl Future for ThreadLookup {
    type Output = Result<reqwest::dns::Addrs, Box<dyn std::error::Error + Send + Sync>>;
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        match state.0.take() {
            Some(Ok(addresses)) => Poll::Ready(Ok(Box::new(addresses.into_iter()))),
            Some(Err(error)) => Poll::Ready(Err(Box::new(error))),
            None => {
                state.1 = Some(cx.waker().clone());
                Poll::Pending
            }
        }
    }
}
/// Resolves names for the client, returning only public addresses (`public_addresses`).
struct PublicOnly(LookupFn);
impl reqwest::dns::Resolve for PublicOnly {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        Box::pin(ThreadLookup::start(name.as_str().to_owned(), self.0))
    }
}

/// Reads one calendar's text. The real one is `GuardedHttp`; tests use a stand-in.
pub trait CalendarFetch: Send + Sync {
    fn get(&self, url: &Url) -> Result<String, LinkError>;
}
/// Reads what a saved link points at, checked for what it must be: a calendar's text (`CalendarFetch`), or a
/// published sheet's bytes (sheet_link.rs).
pub trait LinkFetch<B>: Send + Sync {
    fn fetch(&self, url: &Url) -> Result<B, LinkError>;
}
/// A calendar fetch as a link store reads it.
struct Calendars(Arc<dyn CalendarFetch>);
impl LinkFetch<String> for Calendars {
    fn fetch(&self, url: &Url) -> Result<String, LinkError> {
        self.0.get(url)
    }
}

/// The guarded client described at the top of this file.
pub struct GuardedHttp(reqwest::blocking::Client);
impl GuardedHttp {
    pub fn new() -> Result<Self, LinkError> {
        Self::with_lookup(system_lookup)
    }
    pub(crate) fn with_lookup(lookup: LookupFn) -> Result<Self, LinkError> {
        let redirects = reqwest::redirect::Policy::custom(|attempt| {
            if redirect_allowed(attempt.previous().len(), attempt.url()) {
                attempt.follow()
            } else {
                attempt.error(LinkError::MovedElsewhere)
            }
        });
        Ok(Self(
            reqwest::blocking::Client::builder()
                .https_only(true)
                .no_proxy()
                .redirect(redirects)
                .referer(false)
                .dns_resolver(Arc::new(PublicOnly(lookup)))
                .connect_timeout(Duration::from_secs(5))
                .timeout(WAIT_LIMIT)
                .user_agent("Ozzie (https://ozzie.church)")
                .build()
                .map_err(|_| LinkError::Unavailable)?,
        ))
    }
}
/// The first of Ozzie's own errors in a chain (from the resolver or the redirect policy), if any.
fn own_error(error: &(dyn std::error::Error + 'static)) -> Option<LinkError> {
    let mut current = Some(error);
    while let Some(e) = current {
        if let Some(own) = e.downcast_ref::<LinkError>() {
            return Some(*own);
        }
        current = e.source();
    }
    None
}
fn classify(error: &reqwest::Error) -> LinkError {
    if let Some(own) = own_error(error) {
        own
    } else if error.is_timeout() {
        LinkError::Timeout
    } else if error.is_redirect() {
        LinkError::MovedElsewhere
    } else {
        LinkError::Unreachable
    }
}
/// Runs `work` on its own thread and gives up waiting after `limit`, so nothing a server does can hold the caller
/// longer. The work itself stops soon after: its reads check the same deadline.
pub fn within<T: Send + 'static>(
    limit: Duration,
    work: impl FnOnce() -> Result<T, LinkError> + Send + 'static,
) -> Result<T, LinkError> {
    let (sent, received) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = sent.send(work());
    });
    received
        .recv_timeout(limit)
        .unwrap_or(Err(LinkError::Timeout))
}
/// A body read in pieces until `deadline`, at most `MAX_CALENDAR_BYTES`. A server that sends a byte now and then
/// can't keep it going: the deadline is checked before every piece.
pub fn read_body(reader: impl Read, deadline: std::time::Instant) -> Result<Vec<u8>, LinkError> {
    read_body_up_to(reader, deadline, MAX_CALENDAR_BYTES)
}
/// `read_body` with its own limit: more than `max` bytes is refused as it arrives.
pub fn read_body_up_to(
    mut reader: impl Read,
    deadline: std::time::Instant,
    max: usize,
) -> Result<Vec<u8>, LinkError> {
    let mut body = Vec::new();
    let mut piece = vec![0u8; 64 * 1024];
    loop {
        if std::time::Instant::now() >= deadline {
            return Err(LinkError::Timeout);
        }
        let n = reader.read(&mut piece).map_err(|e| {
            if e.kind() == io::ErrorKind::TimedOut {
                LinkError::Timeout
            } else {
                LinkError::Unreachable
            }
        })?;
        if n == 0 {
            return Ok(body);
        }
        body.extend_from_slice(&piece[..n]);
        if body.len() > max {
            return Err(LinkError::TooLarge);
        }
    }
}
/// Whether a redirect may be followed: `previous` is how many addresses were already asked (the first included), so
/// three redirects are followed and a fourth is refused; each must pass `check_target`.
pub fn redirect_allowed(previous: usize, url: &Url) -> bool {
    previous <= MAX_REDIRECTS && check_target(url).is_ok()
}
/// What the calendar fetch asks for.
const CALENDAR_ACCEPT: &str = "text/calendar, text/plain;q=0.5, */*;q=0.1";
/// A 200 answer's Content-Type, as the site gave it (when it is text), and its body.
type Typed = (Option<String>, Vec<u8>);
fn fetch(
    client: &reqwest::blocking::Client,
    url: Url,
    accept: &'static str,
    max: usize,
    deadline: std::time::Instant,
) -> Result<Typed, LinkError> {
    let response = client
        .get(url)
        .header(reqwest::header::ACCEPT, accept)
        .send()
        .map_err(|e| classify(&e))?;
    if response.status().as_u16() != 200 {
        return Err(LinkError::Refused);
    }
    if response.content_length().is_some_and(|n| n > max as u64) {
        return Err(LinkError::TooLarge);
    }
    let content_type = content_types(response.headers());
    Ok((content_type, read_body_up_to(response, deadline, max)?))
}
/// Every Content-Type the site sent, in order, joined with ", " (review U, note 1): a site that sends two, or one that
/// isn't ASCII, is read as far as it goes (each byte that isn't ASCII as U+FFFD; a media type is ASCII). None when it
/// sent none.
pub fn content_types(headers: &reqwest::header::HeaderMap) -> Option<String> {
    let all: Vec<String> = headers
        .get_all(reqwest::header::CONTENT_TYPE)
        .iter()
        .map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned())
        .collect();
    (!all.is_empty()).then(|| all.join(", "))
}
impl GuardedHttp {
    /// One guarded GET of `url` (every guard at the top of this file), asking for `accept`: the body of a 200 answer,
    /// at most `max` bytes (`MAX_CALENDAR_BYTES` at most), or why not. What the body must be is the caller's to check.
    pub fn get_body(
        &self,
        url: &Url,
        accept: &'static str,
        max: usize,
    ) -> Result<Vec<u8>, LinkError> {
        self.get_typed(url, accept, max).map(|(_, body)| body)
    }
    /// `get_body` with every Content-Type the site gave (`content_types`): a published sheet's read uses them to refuse
    /// a web page (sheet_link.rs). The same GET, guards and limits.
    pub fn get_typed(
        &self,
        url: &Url,
        accept: &'static str,
        max: usize,
    ) -> Result<(Option<String>, Vec<u8>), LinkError> {
        check_target(url)?;
        let (client, url) = (self.0.clone(), url.clone());
        let max = max.min(MAX_CALENDAR_BYTES);
        let deadline = std::time::Instant::now() + TOTAL_LIMIT;
        within(TOTAL_LIMIT, move || {
            fetch(&client, url, accept, max, deadline)
        })
    }
}
impl CalendarFetch for GuardedHttp {
    fn get(&self, url: &Url) -> Result<String, LinkError> {
        calendar_text(self.get_body(url, CALENDAR_ACCEPT, MAX_CALENDAR_BYTES)?)
    }
}

/// RFC 5545 §3.1 unfolding on bytes: a line break followed by a space or tab is removed with it. A producer may fold
/// in the middle of a character, so text that isn't valid UTF-8 is unfolded before it is read.
fn unfold_bytes(body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(body.len());
    let mut i = 0;
    while i < body.len() {
        let fold = match body[i..] {
            [b'\r', b'\n', b' ' | b'\t', ..] => 3,
            [b'\n', b' ' | b'\t', ..] => 2,
            _ => 0,
        };
        if fold > 0 {
            i += fold;
        } else {
            out.push(body[i]);
            i += 1;
        }
    }
    out
}
/// What came back, as calendar text: bounded, and starting and ending as iCalendar does. Text that isn't valid UTF-8
/// is unfolded and read with what can't be read as U+FFFD, which the page says, rather than refused whole.
pub fn calendar_text(body: Vec<u8>) -> Result<String, LinkError> {
    if body.len() > MAX_CALENDAR_BYTES {
        return Err(LinkError::TooLarge);
    }
    let text = match String::from_utf8(body) {
        Ok(text) => text,
        Err(error) => String::from_utf8_lossy(&unfold_bytes(error.as_bytes())).into_owned(),
    };
    let start = text.trim_start_matches('\u{feff}').trim_start();
    let end = text.trim_end();
    let begins = start
        .get(..15)
        .is_some_and(|s| s.eq_ignore_ascii_case("BEGIN:VCALENDAR"));
    let ends = end.len() >= 13
        && end
            .get(end.len() - 13..)
            .is_some_and(|s| s.eq_ignore_ascii_case("END:VCALENDAR"));
    if begins && ends {
        Ok(text)
    } else {
        Err(LinkError::NotACalendar)
    }
}

// ---- The links ----------------------------------------------------------------------------------------------

/// One saved link as the list beside the Keychain keeps it: no address.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
struct Entry {
    id: String,
    label: String,
    host: String,
}
/// The list as written: entries this Ozzie can't use (from a newer one, say) are kept exactly as they are.
#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
struct List {
    version: u32,
    links: Vec<serde_json::Value>,
}
/// The list as read: the links Ozzie can use, the entries it keeps but can't use, and whether every entry was usable.
struct Loaded {
    entries: Vec<Entry>,
    others: Vec<serde_json::Value>,
}

/// A link as the page sees it: its label and where it is, never the address.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct LinkView {
    pub id: String,
    pub label: String,
    /// The host with the rest of the address masked: `calendar.google.com/•••`.
    pub shown: String,
    /// Its address is no longer in the Keychain (removed outside Ozzie); it can only be removed.
    pub missing: bool,
    /// An entry this version of Ozzie can't use (from a newer one, or damaged): shown so it can be removed, never read.
    pub unusable: bool,
}
/// How an entry this version can't use is named to the page: its place among those entries.
const UNUSABLE: &str = "unusable-";
impl From<&Entry> for LinkView {
    fn from(e: &Entry) -> Self {
        Self {
            id: e.id.clone(),
            label: e.label.clone(),
            shown: format!("{}/\u{2022}\u{2022}\u{2022}", e.host),
            missing: false,
            unusable: false,
        }
    }
}

/// A link id as Ozzie makes them: 16 lowercase hex characters.
pub fn valid_id(id: &str) -> bool {
    id.len() == 16 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}
/// The label as kept: trimmed, 1 to `MAX_LABEL` characters, no control characters.
pub fn clean_label(label: &str) -> Result<String, LinkError> {
    let label = label.trim();
    let count = label.chars().count();
    if count == 0 || count > MAX_LABEL || label.chars().any(char::is_control) {
        return Err(LinkError::NoLabel);
    }
    Ok(label.to_owned())
}

/// Saved private links: addresses in the Keychain, the list beside them in the app's data folder. Calendar links
/// (`CalendarLinks`) and published sheets' links (sheet_link.rs) are each one of these, with their own Keychain
/// service, list and fetch, and the same guards.
pub struct SavedLinks<B> {
    store: Arc<dyn CredentialStore>,
    list: PathBuf,
    fetch: Arc<dyn LinkFetch<B>>,
    /// The first part of every Keychain account an address is kept under (`["<workspace>", "<id>"]`).
    workspace: &'static str,
    /// Whether an address must be https as written (a published sheet's), rather than a calendar's `webcal://` read as
    /// https.
    https_only: bool,
    /// The longest host an address may have (a published sheet's is shown whole on the page, never cut).
    max_host: usize,
    /// Adding, removing and listing one at a time, so the list and the Keychain agree.
    lock: Mutex<()>,
}
/// The private calendar links.
pub type CalendarLinks = SavedLinks<String>;
impl SavedLinks<String> {
    /// The calendar links: each address under `["calendar-link", "<id>"]` in the store's Keychain service, read as
    /// calendar text.
    pub fn new(
        store: Arc<dyn CredentialStore>,
        list: PathBuf,
        fetch: Arc<dyn CalendarFetch>,
    ) -> Self {
        Self::with_fetch(store, list, Arc::new(Calendars(fetch)), KEYCHAIN_WORKSPACE)
    }
}
impl<B> SavedLinks<B> {
    /// Links read by `fetch`, their addresses kept under `workspace` in `store`'s Keychain service and listed in `list`.
    pub fn with_fetch(
        store: Arc<dyn CredentialStore>,
        list: PathBuf,
        fetch: Arc<dyn LinkFetch<B>>,
        workspace: &'static str,
    ) -> Self {
        Self {
            store,
            list,
            fetch,
            workspace,
            https_only: false,
            max_host: usize::MAX,
            lock: Mutex::new(()),
        }
    }
    /// The same links, each address added only when its host has at most `max` characters.
    pub fn max_host(mut self, max: usize) -> Self {
        self.max_host = max;
        self
    }
    /// The same links, each address added only when it is https as written: nothing is read from a `webcal://` (or any
    /// other) address rewritten to https.
    pub fn https_only(mut self) -> Self {
        self.https_only = true;
        self
    }
    fn guard(&self) -> std::sync::MutexGuard<'_, ()> {
        self.lock.lock().unwrap_or_else(|e| e.into_inner())
    }
    /// The list beside the Keychain. No file is no links. A file that can't be read, isn't a version 1 list or is too
    /// large is `ListUnreadable`: nothing is removed or written over because of it (review C, L1).
    fn load(&self) -> Result<Loaded, LinkError> {
        let mut bytes = Vec::new();
        let file = match std::fs::File::open(&self.list) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(Loaded {
                    entries: Vec::new(),
                    others: Vec::new(),
                });
            }
            Err(_) => return Err(LinkError::ListUnreadable),
        };
        if file
            .take(MAX_LIST_BYTES + 1)
            .read_to_end(&mut bytes)
            .is_err()
            || bytes.len() as u64 > MAX_LIST_BYTES
        {
            return Err(LinkError::ListUnreadable);
        }
        let list = serde_json::from_slice::<List>(&bytes).map_err(|_| LinkError::ListUnreadable)?;
        if list.version != 1 {
            return Err(LinkError::ListUnreadable);
        }
        let mut seen = std::collections::HashSet::new();
        let (mut entries, mut others) = (Vec::new(), Vec::new());
        for value in list.links {
            match serde_json::from_value::<Entry>(value.clone()) {
                Ok(e)
                    if valid_id(&e.id)
                        && clean_label(&e.label).is_ok_and(|l| l == e.label)
                        && public_name(&e.host)
                        && entries.len() < MAX_LINKS
                        && seen.insert(e.id.clone()) =>
                {
                    entries.push(e)
                }
                _ => others.push(value),
            }
        }
        Ok(Loaded { entries, others })
    }
    /// Replaces the list whole (a partial file, renamed into place), readable by this user only, keeping the entries
    /// this Ozzie can't use exactly as they were.
    fn save(&self, links: &[Entry], others: &[serde_json::Value]) -> Result<(), LinkError> {
        let write = || -> io::Result<()> {
            let dir = self
                .list
                .parent()
                .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "no folder"))?;
            let mut builder = std::fs::DirBuilder::new();
            builder.recursive(true);
            #[cfg(unix)]
            std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
            builder.create(dir)?;
            let mut all = links
                .iter()
                .map(serde_json::to_value)
                .collect::<Result<Vec<_>, _>>()
                .map_err(io::Error::other)?;
            all.extend(others.iter().cloned());
            let text = serde_json::to_vec(&List {
                version: 1,
                links: all,
            })
            .map_err(io::Error::other)?;
            let partial = self.list.with_extension("partial");
            let _ = std::fs::remove_file(&partial);
            let mut options = OpenOptions::new();
            #[cfg(unix)]
            std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
            let written = options
                .write(true)
                .create_new(true)
                .open(&partial)
                .and_then(|mut file| {
                    file.write_all(&text)?;
                    file.sync_all()
                });
            if let Err(error) = written.and_then(|()| std::fs::rename(&partial, &self.list)) {
                let _ = std::fs::remove_file(&partial);
                return Err(error);
            }
            Ok(())
        };
        write().map_err(|_| LinkError::Unavailable)
    }

    /// The saved links. A Keychain item no link names any more (left by a removal that stopped halfway) is deleted,
    /// so an address is never kept without a way to see and remove it, but only after a list read cleanly with every
    /// entry usable: an unreadable list, or one with entries from a newer Ozzie, removes nothing.
    pub fn list(&self) -> Result<Vec<LinkView>, LinkError> {
        let _held = self.guard();
        let Loaded {
            entries: links,
            others,
        } = self.load()?;
        let saved = self.store.accounts().ok();
        if let (Some(saved), true) = (&saved, others.is_empty()) {
            for (workspace, id) in saved {
                if workspace == self.workspace && !links.iter().any(|e| &e.id == id) {
                    let _ = self.store.delete(self.workspace, id);
                }
            }
        }
        let usable = links.iter().map(|e| LinkView {
            missing: saved
                .as_ref()
                .is_some_and(|s| !s.iter().any(|(w, id)| w == self.workspace && *id == e.id)),
            ..LinkView::from(e)
        });
        // Entries this version can't use are listed too, each with a way to remove it (review C2, N1).
        let unusable = (0..others.len()).map(|n| LinkView {
            id: format!("{UNUSABLE}{n}"),
            label: String::new(),
            shown: String::new(),
            missing: false,
            unusable: true,
        });
        Ok(usable.chain(unusable).collect())
    }

    /// Adds a link: checks the address, reads it once (it must give back what `fetch` accepts: a calendar, a sheet),
    /// then keeps the address in the Keychain and the label in the list. Returns the link and what it read.
    pub fn add(&self, label: &str, address: &str) -> Result<(LinkView, B), LinkError> {
        let label = clean_label(label)?;
        let url = normalize_address(address)?;
        // A web address, but read as https only because it was rewritten from webcal.
        if self.https_only
            && !address
                .trim()
                .get(..8)
                .is_some_and(|scheme| scheme.eq_ignore_ascii_case("https://"))
        {
            return Err(LinkError::NotHttps);
        }
        let host = match url.host() {
            Some(Host::Domain(name)) => name.trim_end_matches('.').to_ascii_lowercase(),
            _ => return Err(LinkError::NotOnTheInternet),
        };
        if host.chars().count() > self.max_host {
            return Err(LinkError::NotAnAddress);
        }
        if self.guard_count()? >= MAX_LINKS {
            return Err(LinkError::TooMany);
        }
        // Read before keeping anything: a wrong address is refused without being saved.
        let text = self.fetch.fetch(&url)?;
        let _held = self.guard();
        let Loaded {
            entries: mut links,
            others,
        } = self.load()?;
        if links.len() >= MAX_LINKS {
            return Err(LinkError::TooMany);
        }
        let mut random = [0u8; 8];
        getrandom::fill(&mut random).map_err(|_| LinkError::Unavailable)?;
        let id: String = random.iter().map(|b| format!("{b:02x}")).collect();
        self.store
            .put(self.workspace, &id, url.as_str().as_bytes())?;
        let entry = Entry { id, label, host };
        links.push(entry.clone());
        if let Err(error) = self.save(&links, &others) {
            // Never keep an address the list doesn't name.
            let _ = self.store.delete(self.workspace, &entry.id);
            return Err(error);
        }
        Ok((LinkView::from(&entry), text))
    }
    fn guard_count(&self) -> Result<usize, LinkError> {
        let _held = self.guard();
        Ok(self.load()?.entries.len())
    }

    /// Removes a link: its address from the Keychain first, then its entry. Nothing on the calendar changes.
    pub fn remove(&self, id: &str) -> Result<(), LinkError> {
        if let Some(n) = id.strip_prefix(UNUSABLE) {
            return self.remove_unusable(n.parse().map_err(|_| LinkError::Unknown)?);
        }
        if !valid_id(id) {
            return Err(LinkError::Unknown);
        }
        let _held = self.guard();
        let Loaded {
            entries: links,
            others,
        } = self.load()?;
        if !links.iter().any(|e| e.id == id) {
            return Err(LinkError::Unknown);
        }
        self.store.delete(self.workspace, id)?;
        let kept: Vec<Entry> = links.into_iter().filter(|e| e.id != id).collect();
        self.save(&kept, &others)
    }

    /// Removes the `n`th entry this version can't use, and the address saved for it when it names one no usable link
    /// also names.
    fn remove_unusable(&self, n: usize) -> Result<(), LinkError> {
        let _held = self.guard();
        let Loaded {
            entries: links,
            mut others,
        } = self.load()?;
        if n >= others.len() {
            return Err(LinkError::Unknown);
        }
        let gone = others.remove(n);
        if let Some(id) = gone.get("id").and_then(|v| v.as_str())
            && valid_id(id)
            && !links.iter().any(|e| e.id == id)
        {
            self.store.delete(self.workspace, id)?;
        }
        self.save(&links, &others)
    }

    /// "Forget all private calendar links": every address in this Keychain service is deleted, then the list, and Ozzie
    /// starts with none. The way out when the list can't be read (review C2, N1); only after the person confirms it.
    pub fn forget_all(&self) -> Result<(), LinkError> {
        let _held = self.guard();
        for (workspace, id) in self.store.accounts()? {
            if workspace == self.workspace {
                self.store.delete(self.workspace, &id)?;
            }
        }
        let _ = std::fs::remove_file(self.list.with_extension("partial"));
        match std::fs::remove_file(&self.list) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(LinkError::Unavailable),
        }
    }

    /// The id of the saved link whose address is `address` as Ozzie reads it (made plain the same way, so white space
    /// around it, a fragment or the case of the host don't count), or none. Only the id comes back, never an address;
    /// nothing is read from the internet to compare.
    pub fn saved_id(&self, address: &str) -> Result<Option<String>, LinkError> {
        let Ok(url) = normalize_address(address) else {
            return Ok(None);
        };
        let _held = self.guard();
        for entry in self.load()?.entries {
            let Some(secret) =
                crate::credentials::read_private(&*self.store, self.workspace, &entry.id)?
            else {
                continue;
            };
            let saved = std::str::from_utf8(&secret)
                .ok()
                .and_then(|text| normalize_address(text).ok());
            if saved.is_some_and(|saved| saved == url) {
                return Ok(Some(entry.id));
            }
        }
        Ok(None)
    }

    /// Reads a saved link: the address from the Keychain, checked again, then one guarded GET. An address there for
    /// another host than the one listed (put in the Keychain outside Ozzie) is not this link's: it is never read under
    /// this link's label and host (`Missing`).
    pub fn read(&self, id: &str) -> Result<B, LinkError> {
        if !valid_id(id) {
            return Err(LinkError::Unknown);
        }
        let url = {
            let _held = self.guard();
            let host = self
                .load()?
                .entries
                .into_iter()
                .find(|e| e.id == id)
                .ok_or(LinkError::Unknown)?
                .host;
            let secret = crate::credentials::read_private(&*self.store, self.workspace, id)?
                .ok_or(LinkError::Missing)?;
            let text = std::str::from_utf8(&secret).map_err(|_| LinkError::Missing)?;
            let url = normalize_address(text)?;
            let named = url
                .host_str()
                .map(|h| h.trim_end_matches('.').to_ascii_lowercase());
            if named.as_deref() != Some(host.as_str()) {
                return Err(LinkError::Missing);
            }
            url
        };
        self.fetch.fetch(&url)
    }
}

#[cfg(test)]
#[path = "calendar_link_tests.rs"]
mod tests;
