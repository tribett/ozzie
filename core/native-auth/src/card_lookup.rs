//! Visitor cards: looking up the name on one card in Planning Center People (owner decision
//! 2026-11-23). While a person checks visitor cards on this Mac, the page may ask whether someone
//! with the name on a card is already in the church's Planning Center, so the card can say so. The
//! decision's conditions are the whole rule here:
//!
//! 1. **Read-only, one allowlisted GET, least data.** Planning Center People's own name search,
//!    through the same verified, GET-only source path as every other read (source.rs
//!    `PeopleNameSearch`), after the same organization check:
//!
//!    `/people/v2/people?where[search_name]={name}&fields[Person]=name&per_page=5&offset=0`
//!
//!    One page of at most `MAX_PEOPLE` people, each with its id and display name only: no include,
//!    no email, phone, address, birthday, household or note, and its next link is never followed.
//!    More than `MAX_PEOPLE` people is said as `more`, with no one's name.
//! 2. **Only the card's name, only to Planning Center.** The page sends one name and the church the
//!    cards belong to; the name must be a plain name (`source::SearchName`) and the church the one
//!    Ozzie is connected to now (`church-changed` otherwise). What proves the church is Planning
//!    Center's identity check before every search (`verify_source`: the sign-in's token must belong
//!    to the church it is bound to), privacy review L6. A list whose `meta.parent` names another
//!    organization is refused too, but Planning Center may leave `meta.parent` out, so that is a
//!    second check, not the guarantee. It goes to the church's own Planning
//!    Center and nowhere else: never to an AI, never to ozzie.church. Nothing here logs, saves or
//!    records it: no file, no task ledger entry, no notice, no recording (a Sunday check never makes
//!    this read, and a recording that held one could not be loaded). `SearchName`'s and `Person`'s
//!    Debug forms withhold the name.
//! 3. **Only while cards are being checked, on this Mac.** Native code makes the read only when the
//!    page asks, one name at a time; the page asks only while a review of cards is open and on
//!    screen, and drops every answer with the cards (cards-page.tsx). Nothing here keeps a name or
//!    an answer between calls: `CardLookups` holds only when recent lookups went out and the cancel
//!    flags of the ones still under way. `cancel` stops them (the review was discarded or hidden).
//! 4. **People access, never asked for here.** It needs the People scope, which a leader grants with
//!    Calendar and Groups; a sign-in without it is `not-allowed`, the search is never sent, and no
//!    sign-in is started from here.
//! 5. **Never beside a check, briefly, paced.** The read takes the connection's turn the way setup's
//!    picker does (`Reader::Picker`: a Sunday check waits for it, a note or a change says Ozzie is
//!    reading Planning Center), waiting at most `TURN_WAIT`; a new kind of reader would change the
//!    one write's own module (change.rs), which this read leaves untouched. At most
//!    `LOOKUPS_PER_MINUTE` lookups a minute (`too-many-just-now`), and each read has `LOOKUP_DEADLINE`
//!    once the connection is in hand (`could-not-check` past it). Planning Center's own 429 is
//!    honoured: every lookup is `busy` until its Retry-After has passed (20 s when it names none, at
//!    most `LONGEST_WAIT`), and the page is told how long (`Refused`, privacy review L2). A change a
//!    person confirmed waits for a lookup that holds the turn (`let_finish`, desktop changes.rs), so it
//!    is never refused as if a check were running (review L3); it never waits for a check.
//! 6. **Nothing added, nothing combined.** A name match is never taken to be the same person: the
//!    page says it may be someone else. Nothing is written anywhere.
use crate::{
    oauth::{AuthController, numeric_id},
    source::{
        Collection, NAME_SEARCH_PAGE, NativeSourceHttp, Product, SearchName, SourceError,
        SourceHttp, SourceRequest, Target, display_label,
    },
    sunday_check::{Reader, Turn, Turns},
};
use serde_json::Value;
use std::{
    collections::{BTreeSet, VecDeque},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

/// The most people one lookup names; more than this is said as `more`.
pub const MAX_PEOPLE: usize = NAME_SEARCH_PAGE as usize;
/// Lookups that may go out in any one minute, so a page stuck in a loop can't wear out the church's
/// Planning Center allowance (each is an identity check and one page).
pub const LOOKUPS_PER_MINUTE: usize = 30;
/// How long a lookup waits for the connection's turn before it answers `busy`.
pub const TURN_WAIT: Duration = Duration::from_secs(2);
/// From the connection in hand to the answer: past this the read is cancelled (`could-not-check`).
pub const LOOKUP_DEADLINE: Duration = Duration::from_secs(10);
/// Lookups under way at once that `cancel` can reach; past it the oldest is cancelled.
const UNDER_WAY: usize = 4;
/// The longest Planning Center's Retry-After holds lookups back, and the wait when its 429 names none
/// (its rate limit's own period).
pub const LONGEST_WAIT: Duration = Duration::from_secs(300);
const WAIT_WITHOUT_RETRY_AFTER: u16 = 20;
/// How long a change a person confirmed waits for a lookup holding the connection's turn: a lookup
/// already cancelled still finishes the request it has in flight (Planning Center's identity check is
/// limited to 15 s, the GET to 5 s).
pub const CHANGE_WAITS: Duration = Duration::from_secs(20);
/// While a change goes ahead, new lookups are held back this long, so none takes the turn first.
const CHANGE_HOLDS_LOOKUPS: Duration = Duration::from_secs(3);
const MINUTE: Duration = Duration::from_secs(60);
const RETRY_EVERY: Duration = Duration::from_millis(25);

/// One person the search found: Planning Center's id and the name as Planning Center shows it (in
/// display form). Its Debug form withholds the name.
#[derive(Clone, PartialEq, Eq, serde::Serialize)]
pub struct Person {
    id: String,
    name: String,
}
impl std::fmt::Debug for Person {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("Person")
            .field(&self.id)
            .field(&"withheld")
            .finish()
    }
}
impl Person {
    pub fn id(&self) -> &str {
        &self.id
    }
}

/// What a lookup found, as the page is told it.
#[derive(Debug, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "result", rename_all = "kebab-case")]
pub enum Found {
    /// One to `MAX_PEOPLE` people, in Planning Center's order (the page puts them in its own).
    People { people: Vec<Person> },
    /// No one in People has a name the search matched.
    NoOne,
    /// More than `MAX_PEOPLE` people: no one's name is kept.
    More,
}

/// Why nothing was looked up. Closed codes that carry nothing about the card or anyone.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum NotLookedUp {
    /// Not a plain name (`SearchName`), or the church isn't a Planning Center id.
    InvalidName,
    /// Planning Center isn't connected on this Mac now.
    NotConnected,
    /// The church Ozzie is connected to isn't the one the cards belong to.
    ChurchChanged,
    /// The sign-in doesn't include People, Planning Center refused the read (401 or 403), or this
    /// Mac's Keychain refused Ozzie its saved sign-in.
    NotAllowed,
    /// A Sunday check, setup's picker, a note's To line or a change was using the connection, or
    /// Planning Center asked Ozzie to wait (its 429) and that wait hasn't passed.
    Busy,
    /// `LOOKUPS_PER_MINUTE` lookups already went out in the minute before.
    TooManyJustNow,
    /// The read didn't finish (no connection, a locked Keychain, a timeout, the deadline, an error),
    /// or what came back wasn't a list of people with names.
    CouldNotCheck,
    /// The page stopped it (`cancel`): the cards were discarded or hidden.
    Cancelled,
}

/// Why a lookup wasn't made, as the page is told it: the reason and, for `busy` and
/// `too-many-just-now`, how many seconds until a lookup may go out again when that is known.
#[derive(Debug, PartialEq, Eq, serde::Serialize)]
pub struct Refused {
    reason: NotLookedUp,
    #[serde(skip_serializing_if = "Option::is_none")]
    wait_seconds: Option<u64>,
}
impl Refused {
    pub fn reason(&self) -> NotLookedUp {
        self.reason
    }
    pub fn wait_seconds(&self) -> Option<u64> {
        self.wait_seconds
    }
}

/// This session's lookups: when the recent ones went out, the cancel flags of those still under way,
/// how many hold the connection's turn, and until when Planning Center (or a change going ahead) asked
/// lookups to wait. Times, flags and counts only, held in memory: never a name or an answer.
#[derive(Clone, Default)]
pub struct CardLookups(Arc<Mutex<Session>>);
#[derive(Default)]
struct Session {
    reads: VecDeque<Instant>,
    under_way: Vec<Arc<AtomicBool>>,
    holding: usize,
    wait_until: Option<Instant>,
}
/// The connection's turn as a lookup holds it: counted while held, so a change can wait for it.
struct Holding {
    lookups: CardLookups,
    turn: Option<Turn>,
}
impl Drop for Holding {
    fn drop(&mut self) {
        // The turn first, then the count: a change that sees none held finds the turn free.
        drop(self.turn.take());
        let mut session = self.lookups.0.lock().unwrap_or_else(|e| e.into_inner());
        session.holding = session.holding.saturating_sub(1);
    }
}
/// A lookup's place among those under way: its cancel flag, let go when the lookup ends.
struct UnderWay {
    lookups: CardLookups,
    flag: Arc<AtomicBool>,
}
impl Drop for UnderWay {
    fn drop(&mut self) {
        let mut session = self.lookups.0.lock().unwrap_or_else(|e| e.into_inner());
        session.under_way.retain(|flag| !Arc::ptr_eq(flag, &self.flag));
    }
}
impl CardLookups {
    /// Stops every lookup under way: each answers `cancelled`, and one whose read already went out
    /// is dropped when it comes back.
    pub fn cancel(&self) {
        let mut session = self.0.lock().unwrap_or_else(|e| e.into_inner());
        for flag in session.under_way.drain(..) {
            flag.store(true, Ordering::SeqCst);
        }
    }
    fn begin(&self) -> UnderWay {
        let flag = Arc::new(AtomicBool::new(false));
        let mut session = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if session.under_way.len() >= UNDER_WAY {
            session.under_way.remove(0).store(true, Ordering::SeqCst);
        }
        session.under_way.push(flag.clone());
        UnderWay {
            lookups: self.clone(),
            flag,
        }
    }
    fn hold(&self, turn: Turn) -> Holding {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).holding += 1;
        Holding {
            lookups: self.clone(),
            turn: Some(turn),
        }
    }
    /// Whether a lookup holds the connection's turn now.
    pub fn holding(&self) -> bool {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).holding > 0
    }
    /// For a change a person confirmed (desktop changes.rs): holds new lookups back for a moment and
    /// waits, at most `longest`, until no lookup holds the connection's turn. A check holding it is
    /// never waited for: then this returns at once.
    pub fn let_finish(&self, longest: Duration) {
        let started = Instant::now();
        self.hold_back(started + CHANGE_HOLDS_LOOKUPS);
        while self.holding() && started.elapsed() < longest {
            std::thread::sleep(RETRY_EVERY);
        }
    }
    /// Planning Center asked Ozzie to wait (its 429): `seconds` from its Retry-After, or
    /// `WAIT_WITHOUT_RETRY_AFTER` when it named none, at most `LONGEST_WAIT`, from `now`.
    pub(crate) fn wait_for(&self, seconds: Option<u16>, now: Instant) {
        let asked = Duration::from_secs(seconds.unwrap_or(WAIT_WITHOUT_RETRY_AFTER).into());
        self.hold_back(now + asked.min(LONGEST_WAIT));
    }
    fn hold_back(&self, until: Instant) {
        let mut session = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if session.wait_until.is_none_or(|at| at < until) {
            session.wait_until = Some(until);
        }
    }
    /// Tests: as if the wait had passed at `now`.
    #[cfg(test)]
    pub(crate) fn waited_until(&self, now: Instant) {
        let mut session = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if session.wait_until.is_some_and(|at| at > now) {
            session.wait_until = Some(now);
        }
    }
    /// How long until a lookup may go out: Planning Center's (or a change's) wait still running.
    fn wait_left(&self, now: Instant) -> Option<Duration> {
        let session = self.0.lock().unwrap_or_else(|e| e.into_inner());
        session
            .wait_until
            .map(|at| at.saturating_duration_since(now))
            .filter(|left| !left.is_zero())
    }
    /// The page's reply for `reason`: with the seconds left to wait when lookups are held back, or,
    /// for `too-many-just-now`, until the oldest lookup in the last minute leaves it.
    pub fn refused(&self, reason: NotLookedUp) -> Refused {
        let now = Instant::now();
        let held = self.wait_left(now);
        let paced = (reason == NotLookedUp::TooManyJustNow)
            .then(|| {
                let session = self.0.lock().unwrap_or_else(|e| e.into_inner());
                session
                    .reads
                    .front()
                    .map(|&at| (at + MINUTE).saturating_duration_since(now))
            })
            .flatten();
        let wait = match reason {
            NotLookedUp::Busy | NotLookedUp::TooManyJustNow => held.max(paced),
            _ => None,
        };
        Refused {
            reason,
            wait_seconds: wait.map(|left| left.as_millis().div_ceil(1000) as u64),
        }
    }
    /// Counts one lookup at `now` if fewer than `LOOKUPS_PER_MINUTE` went out in the minute before.
    fn pace(&self, now: Instant) -> bool {
        let mut session = self.0.lock().unwrap_or_else(|e| e.into_inner());
        while session
            .reads
            .front()
            .is_some_and(|&at| now.saturating_duration_since(at) >= MINUTE)
        {
            session.reads.pop_front();
        }
        if session.reads.len() >= LOOKUPS_PER_MINUTE {
            return false;
        }
        session.reads.push_back(now);
        true
    }
}

/// The source client a lookup uses, made only once a read will go out.
pub(crate) type MakeHttp =
    Box<dyn FnOnce() -> Result<Arc<dyn SourceHttp + Send + Sync>, SourceError> + Send>;

/// Looks up `name` in the People of `church`: the name checked first, then the connection's turn
/// (waiting at most `TURN_WAIT`), then `connect` for this session's connection, then the one GET
/// above, after the organization check, within `LOOKUP_DEADLINE`. Or nothing read at all, and why.
pub fn look_up(
    lookups: &CardLookups,
    turns: &Turns,
    church: &str,
    name: &str,
    connect: impl FnOnce() -> Option<Arc<AuthController>>,
) -> Result<Found, Refused> {
    let http: MakeHttp = Box::new(|| {
        NativeSourceHttp::new().map(|http| Arc::new(http) as Arc<dyn SourceHttp + Send + Sync>)
    });
    look_up_with(lookups, turns, church, name, connect, http, LOOKUP_DEADLINE)
        .map_err(|reason| lookups.refused(reason))
}

pub(crate) fn look_up_with(
    lookups: &CardLookups,
    turns: &Turns,
    church: &str,
    name: &str,
    connect: impl FnOnce() -> Option<Arc<AuthController>>,
    http: MakeHttp,
    limit: Duration,
) -> Result<Found, NotLookedUp> {
    let search = SearchName::new(name)
        .filter(|_| numeric_id(church))
        .ok_or(NotLookedUp::InvalidName)?;
    // Planning Center asked Ozzie to wait, or a change is going ahead: nothing, not even the turn.
    if lookups.wait_left(Instant::now()).is_some() {
        return Err(NotLookedUp::Busy);
    }
    let under_way = lookups.begin();
    let turn = lookups.hold(
        turns
            .take(Reader::Picker, TURN_WAIT)
            .map_err(|_| NotLookedUp::Busy)?,
    );
    if under_way.flag.load(Ordering::SeqCst) {
        return Err(NotLookedUp::Cancelled);
    }
    let auth = connect().ok_or(NotLookedUp::NotConnected)?;
    // Only the church the cards belong to, and nothing read otherwise.
    if auth.binding().organization != church {
        return Err(NotLookedUp::ChurchChanged);
    }
    // A sign-in this session verified without People: known without the Keychain or the network.
    if auth
        .status_or_busy()
        .ok()
        .and_then(|status| status.scopes)
        .is_some_and(|scopes| !Product::People.granted(scopes))
    {
        return Err(NotLookedUp::NotAllowed);
    }
    if under_way.flag.load(Ordering::SeqCst) {
        return Err(NotLookedUp::Cancelled);
    }
    if !lookups.pace(Instant::now()) {
        return Err(NotLookedUp::TooManyJustNow);
    }
    let request = SourceRequest::capture_at(
        auth.binding(),
        "",
        "",
        Collection::PeopleNameSearch,
        &Target::name_search(search),
        NAME_SEARCH_PAGE,
        0,
    )
    .map_err(|_| NotLookedUp::CouldNotCheck)?;
    let started = Instant::now();
    let cancelled = under_way.flag.clone();
    let paced = lookups.clone();
    let (send, receive) = mpsc::channel();
    std::thread::Builder::new()
        .name("ozzie-card-name".into())
        .spawn(move || {
            // The turn is held while the connection is in use, past the deadline too.
            let _turn = turn;
            let result = http()
                .map_err(|_| NotLookedUp::CouldNotCheck)
                .and_then(|http| read_one(&auth, &request, &cancelled, http.as_ref(), &paced));
            // Past the deadline or once cancelled nobody listens, and the answer is dropped here.
            let _ = send.send(result);
        })
        .map_err(|_| NotLookedUp::CouldNotCheck)?;
    let result = match receive.recv_timeout(limit.saturating_sub(started.elapsed())) {
        Ok(result) => result,
        Err(_) => {
            under_way.flag.store(true, Ordering::SeqCst);
            return Err(NotLookedUp::CouldNotCheck);
        }
    };
    // Cancelled while it was read: whatever came back is dropped.
    if under_way.flag.load(Ordering::SeqCst) {
        return Err(NotLookedUp::Cancelled);
    }
    result
}

/// The verified GET itself, stopped by `cancelled` at the controller's every boundary.
fn read_one(
    auth: &AuthController,
    request: &SourceRequest,
    cancelled: &AtomicBool,
    http: &dyn SourceHttp,
    lookups: &CardLookups,
) -> Result<Found, NotLookedUp> {
    let refused = |error: SourceError| {
        // Planning Center asked Ozzie to wait: every lookup waits that long (review L2).
        if let SourceError::RateLimited(seconds) = error {
            lookups.wait_for(seconds, Instant::now());
        }
        refused(error)
    };
    let verified = waiting(cancelled, || auth.verify_source(cancelled)).map_err(refused)?;
    // A sign-in without People is never asked to search it; no new sign-in is started either.
    if !Product::People.granted(verified.scopes()) {
        return Err(NotLookedUp::NotAllowed);
    }
    let page = waiting(cancelled, || {
        auth.read_verified_using(&verified, request, cancelled, http)
    })
    .map_err(refused)?;
    found(page.body())
}

/// Planning Center's refusal (401 or 403) or the Keychain's is `not-allowed`; its 429 is `busy`
/// (with its wait, `CardLookups::wait_for`); a cancel is `cancelled`; every other failure is
/// `could-not-check`.
fn refused(error: SourceError) -> NotLookedUp {
    match error {
        SourceError::Denied => NotLookedUp::NotAllowed,
        SourceError::RateLimited(_) => NotLookedUp::Busy,
        SourceError::Cancelled => NotLookedUp::Cancelled,
        _ => NotLookedUp::CouldNotCheck,
    }
}

/// `attempt` again while the controller answers `Busy` (a status refresh holding it), until the
/// lookup is cancelled or `LOOKUP_DEADLINE`. The controller refuses before any credential or
/// network use, so nothing is sent twice.
fn waiting<T>(
    cancelled: &AtomicBool,
    mut attempt: impl FnMut() -> Result<T, SourceError>,
) -> Result<T, SourceError> {
    let started = Instant::now();
    loop {
        match attempt() {
            Err(SourceError::Busy) if started.elapsed() < LOOKUP_DEADLINE => {
                if cancelled.load(Ordering::SeqCst) {
                    return Err(SourceError::Cancelled);
                }
                std::thread::sleep(RETRY_EVERY);
            }
            result => return result,
        }
    }
}

/// What a projected name search says, by the rules above: the people and their names (in display
/// form), no one, or more than `MAX_PEOPLE`. A page that contradicts itself (more rows than
/// `MAX_PEOPLE`, a person twice, a row without a usable name, a total below the rows, or a short page
/// that says more exist) is `could-not-check`, never guessed.
pub(crate) fn found(body: &Value) -> Result<Found, NotLookedUp> {
    let rows = body["data"]
        .as_array()
        .ok_or(NotLookedUp::CouldNotCheck)?;
    if rows.len() > MAX_PEOPLE {
        return Err(NotLookedUp::CouldNotCheck);
    }
    let mut seen = BTreeSet::new();
    let mut people = Vec::with_capacity(rows.len());
    for row in rows {
        let id = row["id"]
            .as_str()
            .filter(|id| numeric_id(id) && row["type"] == "Person")
            .ok_or(NotLookedUp::CouldNotCheck)?;
        if !seen.insert(id) {
            return Err(NotLookedUp::CouldNotCheck);
        }
        let name = row["attributes"]["name"]
            .as_str()
            .map(display_label)
            .filter(|name| !name.is_empty())
            .ok_or(NotLookedUp::CouldNotCheck)?;
        people.push(Person {
            id: id.to_owned(),
            name,
        });
    }
    let total = match &body["meta"]["total_count"] {
        Value::Null => None,
        total => Some(
            total
                .as_u64()
                .and_then(|n| usize::try_from(n).ok())
                .ok_or(NotLookedUp::CouldNotCheck)?,
        ),
    };
    match total {
        Some(total) if total < people.len() => Err(NotLookedUp::CouldNotCheck),
        // A full page and more beyond it: nobody's name is kept.
        Some(total) if total > people.len() && people.len() == MAX_PEOPLE => Ok(Found::More),
        Some(total) if total > people.len() => Err(NotLookedUp::CouldNotCheck),
        // A full page with no total can't say whether there are more.
        None if people.len() == MAX_PEOPLE => Err(NotLookedUp::CouldNotCheck),
        _ if people.is_empty() => Ok(Found::NoOne),
        _ => Ok(Found::People { people }),
    }
}

#[cfg(test)]
#[path = "card_lookup_tests.rs"]
mod tests;
