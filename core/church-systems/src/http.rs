//! The one way this crate talks to a church system: a GET built from closed parts, through a guarded client.
//!
//! A `Get` can only be made inside this crate, by a system module, from an `Endpoint`: a fixed https origin (a host
//! constant, or a church's own address under a fixed suffix, `ChurchHost`), path segments that are fixed words or
//! checked ids, query pairs whose names are fixed words, and one auth header (`Auth`: a saved key). No function here
//! takes an address, a method or a header name from a caller.
//!
//! `NativeHttp`, the real client: https only, no proxy, no redirects at all (a 3xx answer is `Refused`), no Referer,
//! 5 s to connect, 15 s for the whole request (less when the run's budget has less left), `Accept: application/json`,
//! user agent "Ozzie (https://ozzie.church)", the body read in pieces against the deadline and refused past
//! `MAX_BODY`. Reads are GET only; the source scan in http_tests.rs holds every file in this crate to that: no request
//! other than a GET exists, and the guard (`allowed`) lets no other method through.
//!
//! Errors are closed words (`ReadError`): no response text, address or key is ever in one.
use crate::capture::{Date, Id};
use crate::keys::Key;
use serde_json::{Map, Value};
use std::fmt;
use std::io::{self, Read};
use std::time::{Duration, Instant};
use url::Url;
use zeroize::Zeroizing;

pub const USER_AGENT: &str = "Ozzie (https://ozzie.church)";
/// The largest answer read: 2 MiB.
pub const MAX_BODY: usize = 2 * 1024 * 1024;
pub const CONNECT_LIMIT: Duration = Duration::from_secs(5);
/// One request, from connecting to the last byte.
pub const REQUEST_LIMIT: Duration = Duration::from_secs(15);
/// The longest wait a 429's Retry-After is taken to ask for.
pub const MAX_RETRY_AFTER: Duration = Duration::from_secs(60);

/// Why a read failed. Closed words (the capture's error outcomes).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadError {
    /// The system said this key doesn't open this church (or isn't a key at all).
    KeyRefused,
    /// Any other answer than the one asked for: a 401/403 where the key is known good, a 3xx, a 5xx, a 200 that
    /// carries an error.
    Refused,
    NotFound,
    /// A 429, with the wait it asked for when it said one in seconds (at most `MAX_RETRY_AFTER`).
    RateLimited(Option<Duration>),
    Timeout,
    Unreachable,
    TooLarge,
    /// Not JSON, a duplicate key, or a shape outside what the read expects.
    InvalidResponse,
    /// A zone the caller supplied (the one the person confirmed) that this Mac's zone data doesn't know, such as a
    /// name in the wrong case. Only a check returns it, before any request is sent; it is never a read's outcome.
    UnknownZone,
}
impl ReadError {
    pub fn word(self) -> &'static str {
        match self {
            ReadError::KeyRefused => "key-refused",
            ReadError::Refused => "refused",
            ReadError::NotFound => "not-found",
            ReadError::RateLimited(_) => "rate-limited",
            ReadError::Timeout => "timeout",
            ReadError::Unreachable => "unreachable",
            ReadError::TooLarge => "too-large",
            ReadError::InvalidResponse => "invalid-response",
            ReadError::UnknownZone => "bad-zone",
        }
    }
}
impl fmt::Display for ReadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.word())
    }
}
impl serde::Serialize for ReadError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.word())
    }
}
impl From<ReadError> for crate::capture::Outcome {
    fn from(error: ReadError) -> Self {
        use crate::capture::Outcome;
        match error {
            ReadError::KeyRefused => Outcome::KeyRefused,
            ReadError::Refused => Outcome::Refused,
            ReadError::NotFound => Outcome::NotFound,
            ReadError::RateLimited(_) => Outcome::RateLimited,
            ReadError::Timeout => Outcome::Timeout,
            ReadError::Unreachable => Outcome::Unreachable,
            ReadError::TooLarge => Outcome::TooLarge,
            ReadError::InvalidResponse => Outcome::InvalidResponse,
            // Never recorded: a check returns it before any read (see the variant).
            ReadError::UnknownZone => Outcome::Refused,
        }
    }
}

/// A church's own address under a system's fixed domain (Breeze: `<church>.breezechms.com`): one DNS label of
/// lower-case letters, digits and `-`, 1 to 63 long, not starting or ending with `-`, and the suffix constant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChurchHost {
    label: String,
    suffix: &'static str,
}
impl ChurchHost {
    pub(crate) fn new(label: &str, suffix: &'static str) -> Option<ChurchHost> {
        let b = label.as_bytes();
        let ok = !b.is_empty()
            && b.len() <= 63
            && b[0] != b'-'
            && b[b.len() - 1] != b'-'
            && b.iter()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-');
        ok.then(|| ChurchHost {
            label: label.to_owned(),
            suffix,
        })
    }
    fn host(&self) -> String {
        format!("{}.{}", self.label, self.suffix)
    }
    /// The church's own part of the address (Breeze: its subdomain, which is also its id).
    pub fn label(&self) -> &str {
        &self.label
    }
}
/// Where a read goes: always https on port 443.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Origin {
    /// A system's one API host, a constant in its module.
    Fixed(&'static str),
    Church(ChurchHost),
}
impl Origin {
    fn host(&self) -> String {
        match self {
            Origin::Fixed(host) => (*host).to_owned(),
            Origin::Church(church) => church.host(),
        }
    }
}
/// One part of a path: a fixed word or a checked id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Segment {
    Fixed(&'static str),
    Id(Id),
}
/// One query value: checked ids joined with `,`, a day, or a fixed word.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum QueryValue {
    /// One checked id.
    Id(Id),
    Ids(Vec<Id>),
    Day(Date),
    Fixed(&'static str),
}
impl QueryValue {
    fn text(&self) -> String {
        match self {
            QueryValue::Id(id) => id.as_str().to_owned(),
            QueryValue::Ids(ids) => ids.iter().map(Id::as_str).collect::<Vec<_>>().join(","),
            QueryValue::Day(day) => day.to_string(),
            QueryValue::Fixed(word) => (*word).to_owned(),
        }
    }
}
/// One part of an allowed path: a fixed word, or a slot for an id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Slot {
    Word(&'static str),
    Id,
}
/// What an allowed query value may be.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ValueShape {
    Id,
    Ids,
    Day,
    Fixed(&'static str),
}
/// The shape of one read: its path, and its query's names with the shape of each value. Made from a read itself
/// (`Shape::of`), so a system's list of shapes is its `Read` enum's, never a second list kept by hand.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Shape {
    path: Vec<Slot>,
    query: Vec<(&'static str, ValueShape)>,
}
impl Shape {
    pub(crate) fn of(endpoint: &impl Endpoint) -> Shape {
        let path = endpoint
            .segments()
            .into_iter()
            .map(|segment| match segment {
                Segment::Fixed(word) => Slot::Word(word),
                Segment::Id(_) => Slot::Id,
            })
            .collect();
        let query = endpoint
            .query()
            .into_iter()
            .map(|(name, value)| {
                let shape = match value {
                    QueryValue::Id(_) => ValueShape::Id,
                    QueryValue::Ids(_) => ValueShape::Ids,
                    QueryValue::Day(_) => ValueShape::Day,
                    QueryValue::Fixed(word) => ValueShape::Fixed(word),
                };
                (name, shape)
            })
            .collect();
        Shape { path, query }
    }
    /// Whether `url`'s path and query are this shape: every segment its word or a checked id, every query name the
    /// shape's (each once, none missing, none extra), every value of its shape.
    pub(crate) fn matches(&self, url: &Url, id_ok: fn(&str) -> bool) -> bool {
        let segments: Vec<&str> = url
            .path_segments()
            .map(Iterator::collect)
            .unwrap_or_default();
        let path_ok = segments.len() == self.path.len()
            && segments
                .iter()
                .zip(&self.path)
                .all(|(segment, slot)| match slot {
                    Slot::Word(word) => segment == word,
                    Slot::Id => id_ok(segment),
                });
        let pairs: Vec<(String, String)> = url
            .query_pairs()
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        let query_ok = pairs.len() == self.query.len()
            && self.query.iter().all(|(name, shape)| {
                let mut found = pairs.iter().filter(|(k, _)| k == name);
                match (found.next(), found.next()) {
                    (Some((_, value)), None) => match shape {
                        ValueShape::Id => Id::new(value).is_some(),
                        ValueShape::Ids => value.split(',').all(|v| Id::new(v).is_some()),
                        ValueShape::Day => Date::parse(value).is_some(),
                        ValueShape::Fixed(word) => value == word,
                    },
                    _ => false,
                }
            });
        path_ok && query_ok
    }
}
/// A system's closed list of reads: each variant names its origin, path and query from closed parts.
pub(crate) trait Endpoint {
    fn origin(&self) -> Origin;
    fn segments(&self) -> Vec<Segment>;
    fn query(&self) -> Vec<(&'static str, QueryValue)>;
}

/// The one auth header a read carries.
#[derive(Clone)]
pub(crate) enum Auth {
    /// `Authorization: Bearer <key>` (B1 Church, Genesis).
    Bearer(Key),
    /// `Api-Key: <key>` (Breeze, research breeze 1).
    ApiKey(Key),
}
impl Auth {
    fn header(&self) -> (&'static str, Zeroizing<String>) {
        match self {
            Auth::Bearer(key) => ("authorization", bearer(key.secret())),
            Auth::ApiKey(key) => ("api-key", Zeroizing::new(key.secret().to_owned())),
        }
    }
}
/// `Bearer <secret>`, built in one allocation of the right size, so no grown-out-of copy is left unzeroed.
fn bearer(secret: &str) -> Zeroizing<String> {
    let mut value = Zeroizing::new(String::with_capacity(7 + secret.len()));
    value.push_str("Bearer ");
    value.push_str(secret);
    value
}

/// One GET, built only by a system module from an `Endpoint` (see the top of this file). The address holds no
/// secret; the key is only in the auth header.
#[derive(Clone)]
pub struct Get {
    url: Url,
    auth: Auth,
    limit: Duration,
}
impl Get {
    pub(crate) fn new(endpoint: &impl Endpoint, auth: Auth) -> Get {
        let host = endpoint.origin().host();
        let mut url = Url::parse(&format!("https://{host}/")).expect("origins are checked hosts");
        {
            let mut path = url
                .path_segments_mut()
                .expect("an https address has a path");
            path.clear();
            for segment in endpoint.segments() {
                match segment {
                    Segment::Fixed(word) => path.push(word),
                    Segment::Id(id) => path.push(id.as_str()),
                };
            }
        }
        let query = endpoint.query();
        if !query.is_empty() {
            let mut pairs = url.query_pairs_mut();
            for (name, value) in &query {
                pairs.append_pair(name, &value.text());
            }
        }
        Get {
            url,
            auth,
            limit: REQUEST_LIMIT,
        }
    }
    /// The address read. It never holds a key.
    pub fn url(&self) -> &Url {
        &self.url
    }
    /// Always "GET": no other request can be made.
    pub fn method(&self) -> &'static str {
        "GET"
    }
    /// How long this one request may take: `REQUEST_LIMIT`, or less when the run has less left.
    pub fn limit(&self) -> Duration {
        self.limit
    }
    pub(crate) fn with_limit(mut self, limit: Duration) -> Get {
        self.limit = limit.min(REQUEST_LIMIT);
        self
    }
    /// The auth header's fixed name and its value. Only the HTTP layer and its tests read it.
    pub(crate) fn auth_header(&self) -> (&'static str, Zeroizing<String>) {
        self.auth.header()
    }
}
impl fmt::Debug for Get {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Get")
            .field("url", &self.url.as_str())
            .field("limit", &self.limit)
            .finish_non_exhaustive()
    }
}

/// What a system answered: its status, the wait a 429 asked for, and (for a 200 only) the body.
pub struct Reply {
    status: u16,
    retry_after: Option<Duration>,
    body: Zeroizing<Vec<u8>>,
}
impl Reply {
    pub fn new(status: u16, body: Vec<u8>) -> Reply {
        Reply {
            status,
            retry_after: None,
            body: Zeroizing::new(body),
        }
    }
    /// A Retry-After header as sent: whole seconds only (an HTTP date is ignored), at most `MAX_RETRY_AFTER`.
    pub fn with_retry_after(mut self, header: &str) -> Reply {
        let seconds =
            (!header.is_empty() && header.len() <= 6 && header.bytes().all(|b| b.is_ascii_digit()))
                .then(|| header.parse::<u64>().ok())
                .flatten();
        self.retry_after = seconds.map(|s| Duration::from_secs(s).min(MAX_RETRY_AFTER));
        self
    }
    pub fn status(&self) -> u16 {
        self.status
    }
    pub fn retry_after(&self) -> Option<Duration> {
        self.retry_after
    }
    pub(crate) fn body(&self) -> &[u8] {
        &self.body
    }
}
impl fmt::Debug for Reply {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Reply")
            .field("status", &self.status)
            .field("bytes", &self.body.len())
            .finish()
    }
}

/// Sends one `Get`. The real one is `NativeHttp`; tests use a stand-in.
pub trait Http: Send + Sync {
    fn get(&self, request: &Get) -> Result<Reply, ReadError>;
}

/// A status as a closed word: 200 is none; 401/403 is `unauthorized` (the system module says whether that means the
/// key or only this read); 404 not found; 429 rate limited; anything else, redirects included, refused.
pub(crate) fn status_error(reply: &Reply, unauthorized: ReadError) -> Option<ReadError> {
    match reply.status {
        200 => None,
        401 | 403 => Some(unauthorized),
        404 => Some(ReadError::NotFound),
        429 => Some(ReadError::RateLimited(reply.retry_after)),
        _ => Some(ReadError::Refused),
    }
}

/// The real client described at the top of this file.
pub struct NativeHttp {
    client: reqwest::blocking::Client,
}
impl NativeHttp {
    pub fn new() -> Result<NativeHttp, ReadError> {
        let client = client_builder()
            .build()
            .map_err(|_| ReadError::Unreachable)?;
        Ok(NativeHttp { client })
    }
    /// Tests only: the real client, but every host resolves to this Mac's loopback address, where nothing answers. A
    /// request `allowed` lets through comes back `unreachable`; one it refuses comes back `refused`, before any
    /// connection. Nothing leaves the Mac.
    #[cfg(test)]
    pub(crate) fn loopback() -> NativeHttp {
        let client = client_builder()
            .dns_resolver(std::sync::Arc::new(Loopback))
            .build()
            .expect("the client builds");
        NativeHttp { client }
    }
    /// The one request shape this client sends: a bodiless GET of the built address, asking for JSON, with the
    /// read's one auth header (marked sensitive, so it is never printed).
    pub(crate) fn build(&self, request: &Get) -> Result<reqwest::blocking::Request, ReadError> {
        if request.url().scheme() != "https" {
            return Err(ReadError::Refused);
        }
        let (name, value) = request.auth_header();
        let mut value =
            reqwest::header::HeaderValue::from_str(&value).map_err(|_| ReadError::KeyRefused)?;
        value.set_sensitive(true);
        self.client
            .get(request.url().clone())
            .header(reqwest::header::ACCEPT, "application/json")
            .header(name, value)
            .build()
            .map_err(|_| ReadError::Unreachable)
    }
}
impl Http for NativeHttp {
    fn get(&self, request: &Get) -> Result<Reply, ReadError> {
        self.dispatch(self.build(request)?, request.limit())
    }
}
impl NativeHttp {
    /// The one way a built request leaves: `allowed` checks the request itself, then it is sent within `limit`. If
    /// the wait runs out, the sending thread is left to finish on its own (the request, auth header included, stays in
    /// its memory until the client's own 15 s timeout ends it).
    fn dispatch(
        &self,
        built: reqwest::blocking::Request,
        limit: Duration,
    ) -> Result<Reply, ReadError> {
        allowed(&built)?;
        let client = self.client.clone();
        let deadline = Instant::now() + limit;
        within(limit, move || send(&client, built, deadline))
    }
}
fn client_builder() -> reqwest::blocking::ClientBuilder {
    reqwest::blocking::Client::builder()
        .https_only(true)
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .referer(false)
        .connect_timeout(CONNECT_LIMIT)
        .timeout(REQUEST_LIMIT)
        .user_agent(USER_AGENT)
}
#[cfg(test)]
struct Loopback;
#[cfg(test)]
impl reqwest::dns::Resolve for Loopback {
    fn resolve(&self, _: reqwest::dns::Name) -> reqwest::dns::Resolving {
        Box::pin(async {
            let here = std::net::SocketAddr::from(([127, 0, 0, 1], 1));
            Ok(Box::new(std::iter::once(here)) as reqwest::dns::Addrs)
        })
    }
}
/// Which system a host is: one of the two fixed hosts, or a church's own Breeze address (the same check as
/// `breeze::church_host`: one label, not one of Breeze's own subdomains, not punycode).
fn system_of(host: &str) -> Option<crate::capture::System> {
    use crate::capture::System;
    match host {
        h if h == crate::b1::HOST => Some(System::B1),
        h if h == crate::genesis::HOST => Some(System::Genesis),
        h => h
            .strip_suffix(crate::breeze::SUFFIX)
            .and_then(|label| label.strip_suffix('.'))
            .and_then(Id::new)
            .and_then(|label| crate::breeze::church_host(&label))
            .map(|_| System::Breeze),
    }
}
/// What may be sent, checked on the built request, whatever built it (the read-only rule's last line, beside the
/// source scan in http_tests.rs):
/// - https, port 443, no user name, password or fragment, to one of the three systems' hosts;
/// - a GET with no body whose path and query are one of that system's reads (`Shape`, from its `Read` enum), carrying
///   `accept` and that system's one auth header (`api-key` for Breeze, `authorization` for the rest), and nothing
///   else.
///
/// No other method is let through: there is no POST, PUT, PATCH or DELETE of any kind.
pub(crate) fn allowed(built: &reqwest::blocking::Request) -> Result<(), ReadError> {
    use crate::capture::System;
    let url = built.url();
    let system = system_of(url.host_str().unwrap_or_default());
    if url.scheme() != "https"
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(ReadError::Refused);
    }
    let Some(system) = system else {
        return Err(ReadError::Refused);
    };
    let names: Vec<&str> = built.headers().keys().map(|k| k.as_str()).collect();
    let only = |allowed: &[&str]| names.iter().all(|n| allowed.contains(n));
    let has = |name: &str| built.headers().get_all(name).iter().count() == 1;
    let ok = match built.method().as_str() {
        "GET" => {
            let (auth, headers, shapes): (&str, &[&str], Vec<Shape>) = match system {
                System::B1 => (
                    "authorization",
                    &["accept", "authorization"],
                    crate::b1::shapes(),
                ),
                System::Breeze => ("api-key", &["accept", "api-key"], crate::breeze::shapes()),
                System::Genesis => (
                    "authorization",
                    &["accept", "authorization"],
                    crate::genesis::shapes(),
                ),
            };
            // B1's id slots also refuse B1's own route words, which would reach another route.
            let id_ok: fn(&str) -> bool = match system {
                System::B1 => crate::b1::path_word_ok,
                _ => |text| Id::new(text).is_some(),
            };
            built.body().is_none()
                && only(headers)
                && has("accept")
                && has(auth)
                && shapes.iter().any(|shape| shape.matches(url, id_ok))
        }
        _ => false,
    };
    if ok { Ok(()) } else { Err(ReadError::Refused) }
}
fn send(
    client: &reqwest::blocking::Client,
    built: reqwest::blocking::Request,
    deadline: Instant,
) -> Result<Reply, ReadError> {
    let response = client.execute(built).map_err(|e| {
        if e.is_timeout() {
            ReadError::Timeout
        } else {
            ReadError::Unreachable
        }
    })?;
    let status = response.status().as_u16();
    if status != 200 {
        // Nothing of a refusal's body is read or kept.
        let retry_after = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_owned();
        return Ok(Reply::new(status, Vec::new()).with_retry_after(&retry_after));
    }
    if response
        .content_length()
        .is_some_and(|n| n > MAX_BODY as u64)
    {
        return Err(ReadError::TooLarge);
    }
    Ok(Reply::new(
        200,
        read_body_up_to(response, deadline, MAX_BODY)?,
    ))
}

/// Runs `work` on its own thread and stops waiting after `limit`, so nothing a server does holds the caller longer.
/// The work itself stops soon after: its reads check the same deadline.
pub fn within<T: Send + 'static>(
    limit: Duration,
    work: impl FnOnce() -> Result<T, ReadError> + Send + 'static,
) -> Result<T, ReadError> {
    let (sent, received) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = sent.send(work());
    });
    received
        .recv_timeout(limit)
        .unwrap_or(Err(ReadError::Timeout))
}
/// A body read in pieces until `deadline`, refused as soon as it passes `max` bytes. A server that sends a byte now
/// and then can't keep it going: the deadline is checked before every piece.
pub fn read_body_up_to(
    mut reader: impl Read,
    deadline: Instant,
    max: usize,
) -> Result<Vec<u8>, ReadError> {
    let mut body = Zeroizing::new(Vec::new());
    let mut piece = Zeroizing::new(vec![0u8; 64 * 1024]);
    loop {
        if Instant::now() >= deadline {
            return Err(ReadError::Timeout);
        }
        let n = reader.read(&mut piece).map_err(|e| {
            if e.kind() == io::ErrorKind::TimedOut {
                ReadError::Timeout
            } else {
                ReadError::Unreachable
            }
        })?;
        if n == 0 {
            return Ok(std::mem::take(&mut *body));
        }
        // Grown by hand so the buffer it outgrows is zeroed, not just freed.
        let needed = body.len() + n;
        if needed > body.capacity() {
            let room = needed.max((body.capacity() * 2).min(max + 1));
            let mut bigger = Zeroizing::new(Vec::with_capacity(room));
            bigger.extend_from_slice(&body);
            body = bigger;
        }
        body.extend_from_slice(&piece[..n]);
        if body.len() > max {
            return Err(ReadError::TooLarge);
        }
    }
}

/// JSON with every object's keys unique. serde_json keeps the last of two equal keys; a system's answer that says two
/// things about one field is refused instead.
struct NoDuplicates(Value);
impl<'de> serde::Deserialize<'de> for NoDuplicates {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = NoDuplicates;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("JSON whose objects have unique keys")
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut input: A,
            ) -> Result<NoDuplicates, A::Error> {
                let mut map = Map::new();
                while let Some(key) = input.next_key::<String>()? {
                    if map.contains_key(&key) {
                        return Err(serde::de::Error::custom("duplicate key"));
                    }
                    let value = input.next_value::<NoDuplicates>()?.0;
                    map.insert(key, value);
                }
                Ok(NoDuplicates(Value::Object(map)))
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut input: A,
            ) -> Result<NoDuplicates, A::Error> {
                let mut values = Vec::new();
                while let Some(v) = input.next_element::<NoDuplicates>()? {
                    values.push(v.0);
                }
                Ok(NoDuplicates(Value::Array(values)))
            }
            fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<NoDuplicates, E> {
                Ok(NoDuplicates(Value::String(v.to_owned())))
            }
            fn visit_string<E: serde::de::Error>(self, v: String) -> Result<NoDuplicates, E> {
                Ok(NoDuplicates(Value::String(v)))
            }
            fn visit_bool<E: serde::de::Error>(self, v: bool) -> Result<NoDuplicates, E> {
                Ok(NoDuplicates(Value::Bool(v)))
            }
            fn visit_u64<E: serde::de::Error>(self, v: u64) -> Result<NoDuplicates, E> {
                Ok(NoDuplicates(Value::from(v)))
            }
            fn visit_i64<E: serde::de::Error>(self, v: i64) -> Result<NoDuplicates, E> {
                Ok(NoDuplicates(Value::from(v)))
            }
            fn visit_f64<E: serde::de::Error>(self, v: f64) -> Result<NoDuplicates, E> {
                Ok(NoDuplicates(Value::from(v)))
            }
            fn visit_unit<E: serde::de::Error>(self) -> Result<NoDuplicates, E> {
                Ok(NoDuplicates(Value::Null))
            }
        }
        deserializer.deserialize_any(Visitor)
    }
}
/// A body as JSON, or `InvalidResponse`: not JSON, or a key twice in one object.
pub(crate) fn parse_json(bytes: &[u8]) -> Result<Value, ReadError> {
    serde_json::from_slice::<NoDuplicates>(bytes)
        .map(|v| v.0)
        .map_err(|_| ReadError::InvalidResponse)
}

#[cfg(test)]
#[path = "guard_tests.rs"]
mod guard_tests;
#[cfg(test)]
#[path = "http_tests.rs"]
mod tests;
