//! Breeze ChMS, read-only, from the church's own `https://<subdomain>.breezechms.com` only. "Research" below means the
//! 2026-11-17 reading of Breeze's official API page (app.breezechms.com/api) and the wrappers it links, by section.
//!
//! Breeze makes changes through GET addresses too (research 4), so "GET only" is not enough here: `Read` holds only
//! the exact read paths below, each built from fixed words, and breeze_tests.rs proves no built address or query can
//! carry any of the write paths research 4 lists (that list lives in the tests, never in this file).
//!
//! The church's id is its subdomain (`ChurchHost`: lower-case letters, digits and `-`, 1 to 63, no `-` at either end).
//! The key goes in the `Api-Key` header (research 1). Breeze allows about 20 requests a minute (research 2), so a run
//! leaves 3.5 s between requests, makes at most 14, never more than 18 in a minute, and has 90 s (`LIMITS`). A key
//! check, the picker and a check can share one `Pacer`, so the gap holds between them too.
//!
//! A Sunday check (`check`) for one event instance reads, in this order:
//!
//! | read word | GET | gives |
//! |---|---|---|
//! | `breeze.account` | `/api/account/summary` | the church's name and `details.timezone`; a 401/403 here means the key doesn't open this church |
//! | `breeze.events` | `/api/events/list_event?instance_id=` then `/api/events?start=&end=` | the instance (the service), then the 4 weeks of events from its day |
//! | `breeze.roles` | `/api/volunteers/list_roles?instance_id=&show_quantity=1` | roles and the number wanted (`quantity`) |
//! | `breeze.volunteers` | `/api/volunteers/list?instance_id=` | who is scheduled, and their roles (`role_ids`) |
//! | `breeze.people` | `/api/people?details=0&limit=3000` | names (id and name only), kept for the scheduled people only |
//! | `breeze.attendance` | `/api/events/attendance/list?instance_id=&type=person` | how many people were checked in to the service by name, once it has ended (anonymous head counts aren't included: their shape is unconfirmed); nothing of a check-in is kept |
//! | `breeze.tags` | `/api/tags/list_tags` | tags, as groups; member counts would cost one read per tag, so they are null |
//! | `breeze.forms` | `/api/forms/list_forms` | forms |
//! | `breeze.form_entries` | `/api/forms/list_form_entries?form_id=` | how many entries each of the 5 newest forms has, one read a form; without `details=1` the entries come without their answers (research 3, Forms), and only the count is kept; other forms' counts are null |
//!
//! Blockouts: Breeze has none (research 5), so `blockouts` is always null. Teams: tags only, so no team members.
//! Breeze says its events lists may be up to 15 minutes behind its own site (research 3, Events).
//!
//! Breeze has two volunteer systems, and its API reads only the older one (seen live 2026-11-17): `volunteers/list`
//! and `list_roles` return what is entered on Breeze's older volunteers page (`/events/volunteers/<instance>`); roles
//! and volunteers entered in its newer scheduler (`/events/volunteers2/<instance>`, the one with "Volunteers Needed")
//! don't appear at all (empty lists, status 200), so they can't be told from an event with no roles. The older page has
//! no quantity: live roles come with `quantity` null, so `needed` is null.
//!
//! A volunteer on the event with no role (`role_ids` null) fills no role, but is still scheduled for this service and
//! must not be offered as free help: when they accepted or haven't answered, they are in `on_service`, with a name,
//! and have no assignment (one who declined isn't on it).
//!
//! Every answer is read through a closed projection (project.rs). Breeze sends ids and numbers as strings (research
//! 3); its rows carry more fields than the ones named here (the samples in research 3 list them), so fields not named
//! are ignored. Answers (`response`) are mapped through `ANSWER_CODES`, confirmed live: "0" no response, "1" declined,
//! "2" accepted.
//!
//! Times: Breeze writes `start_datetime` and `end_datetime` as `YYYY-MM-DD HH:MM:SS`, local wall-clock time in the
//! account's zone (`details.timezone`, an IANA name; both seen live 2026-11-17), and zero dates as
//! `0000-00-00 00:00:00`. With the account's zone, each local time becomes the instant it is there (`ZoneOffsets`,
//! this Mac's own zone data), written with its offset (`2026-11-22T09:00:00-06:00`), and the service's `day` is the
//! local day it starts on. A time the zone skips or repeats at a clock change is never guessed: that time is left out
//! (an event with no start isn't kept, the service is null) and `breeze.events` is `truncated`. Without a zone, or one
//! this Mac doesn't know, a local time makes `breeze.events` `invalid-response` and the service null. The picker
//! (`events`) needs only the day, which is read as written.
use crate::capture::{
    Assignment, ChurchChoice, Date, Event, Form, Group, Id, Label, LabelKey, MAX_ASSIGNMENTS,
    MAX_EVENTS, MAX_FORMS, MAX_GROUPS, MAX_ON_SERVICE, MAX_POSITIONS, Name, Outcome, Position,
    ReadWord, Service, Status, System, SystemCapture, Time, ZoneName,
};
use crate::http::{
    Auth, ChurchHost, Endpoint, Get, Http, Origin, QueryValue, ReadError, Reply, Segment,
};
use crate::keys::Key;
use crate::project::{
    BAD, Labelled, Row, capped, decoder, id_field, miss_error, object, optional_text, rows,
};
use crate::run::{Clock, Limits, Miss, Pacer, Projected, Run};
use crate::zones::{LocalResult, ZoneOffsets};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

/// Every Breeze church's address is `<subdomain>.` this.
pub const SUFFIX: &str = "breezechms.com";
/// 20 requests a minute (research 2; Breeze's support page: "Exceeding this will result in a temporary block"):
/// - 3.5 s apart (the wait Breeze's page suggests), so at most 18 starts fit in any 60 s (0, 3.5, …, 59.5 s), under 20;
///   `per_minute` holds 18 as a hard ceiling too, across runs that share a `Pacer`.
/// - At most 14 a check: account, instance, events, roles, volunteers, people, tags, forms (8), up to 5 forms' entry
///   counts and the attendance list (6). 14 requests take 13 × 3.5 s = 45.5 s of gaps, inside the 90 s budget; a key
///   check (1) and the picker (2) before it make 17, still within 18 in a minute. When several events share the soonest
///   day the picker counts who is on up to `MAX_PICK_COUNTS` of them (6 in all); the check then waits on the shared
///   `Pacer`, which never lets more than 18 start in any minute.
pub const LIMITS: Limits = Limits {
    min_gap: Duration::from_millis(3500),
    per_minute: Some(18),
    max_requests: 14,
    budget: Duration::from_secs(90),
    breaker: 3,
};

pub const ACCOUNT: ReadWord = ReadWord::new("breeze.account");
pub const EVENTS: ReadWord = ReadWord::new("breeze.events");
pub const ROLES: ReadWord = ReadWord::new("breeze.roles");
pub const VOLUNTEERS: ReadWord = ReadWord::new("breeze.volunteers");
pub const TAGS: ReadWord = ReadWord::new("breeze.tags");
pub const ATTENDANCE: ReadWord = ReadWord::new("breeze.attendance");
pub const FORMS: ReadWord = ReadWord::new("breeze.forms");
pub const FORM_ENTRIES: ReadWord = ReadWord::new("breeze.form_entries");
pub const PEOPLE: ReadWord = ReadWord::new("breeze.people");
/// Breeze's closed list of read words, in the page's order.
pub const WORDS: &[ReadWord] = &[
    ACCOUNT,
    EVENTS,
    ROLES,
    VOLUNTEERS,
    TAGS,
    ATTENDANCE,
    FORMS,
    FORM_ENTRIES,
    PEOPLE,
];
/// A check's reads, in the order they are made.
pub const READS: &[ReadWord] = &[
    ACCOUNT,
    EVENTS,
    ROLES,
    VOLUNTEERS,
    PEOPLE,
    ATTENDANCE,
    TAGS,
    FORMS,
    FORM_ENTRIES,
];
/// The events list asks for one more than a capture keeps (`MAX_EVENTS` + 1; Breeze's docs allow up to 1000), so a
/// list Breeze cut there, or longer than the cap, is seen as cut. It also keeps the answer small whatever Breeze's
/// default is (its docs say both 500 and 0, "all").
pub const EVENTS_LIMIT: &str = "201";
/// Entry counts are read for at most this many forms, the most recently created, one request each.
pub const MAX_FORM_COUNTS: usize = 5;
/// The people list asks for at most this many (id and name only).
pub const PEOPLE_LIMIT: &str = "3000";
/// Days of events read for the picker and beside the service.
pub const WINDOW_DAYS: i64 = 28;
pub const MAX_EVENT_CHOICES: usize = 100;
/// When several events share the soonest day, how many of them have their volunteers counted at pick time, one read
/// each, so Ozzie can pick the one being staffed (round 4, live: it picked "Event Location limit" over "Breeze Sunday" at
/// 9:35 AM the same day). With the key check and the picker's two reads that is 7 requests; the check's own 14 follow,
/// paced by the shared `Pacer` (never more than 18 in a minute).
pub const MAX_PICK_COUNTS: usize = 4;

/// Every GET this file can build: exact read paths only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Read {
    /// `/api/account/summary` (research 3, Account).
    Account,
    /// `/api/events?start=&end=` (research 3, Events), both days inclusive.
    Events { start: Date, end: Date },
    /// `/api/events/list_event?instance_id=`.
    Event(Id),
    /// `/api/volunteers/list?instance_id=` (research 3, Volunteers).
    Volunteers(Id),
    /// `/api/volunteers/list_roles?instance_id=&show_quantity=1`.
    Roles(Id),
    /// `/api/people?details=0&limit=3000` (research 3, People): id and name only.
    People,
    /// `/api/tags/list_tags` (research 3, Tags).
    Tags,
    /// `/api/forms/list_forms` (research 3, Forms).
    Forms,
    /// `/api/forms/list_form_entries?form_id=` (research 3, Forms), without `details=1`: the entries come without their
    /// answers ("If set to 1, the entry responses will be returned as well"); only how many there are is kept.
    FormEntries(Id),
    /// `/api/events/attendance/list?instance_id=&type=person` (research 3, Check In): the people checked in to the
    /// instance; only how many is kept.
    Attendance(Id),
}
/// A read at one church's address.
pub(crate) struct At<'a> {
    pub(crate) host: &'a ChurchHost,
    pub(crate) read: &'a Read,
}
impl Endpoint for At<'_> {
    fn origin(&self) -> Origin {
        Origin::Church(self.host.clone())
    }
    fn segments(&self) -> Vec<Segment> {
        use Segment::Fixed as F;
        let mut path = vec![F("api")];
        path.extend(match self.read {
            Read::Account => vec![F("account"), F("summary")],
            Read::Events { .. } => vec![F("events")],
            Read::Event(_) => vec![F("events"), F("list_event")],
            Read::Volunteers(_) => vec![F("volunteers"), F("list")],
            Read::Roles(_) => vec![F("volunteers"), F("list_roles")],
            Read::People => vec![F("people")],
            Read::Tags => vec![F("tags"), F("list_tags")],
            Read::Forms => vec![F("forms"), F("list_forms")],
            Read::FormEntries(_) => vec![F("forms"), F("list_form_entries")],
            Read::Attendance(_) => vec![F("events"), F("attendance"), F("list")],
        });
        path
    }
    fn query(&self) -> Vec<(&'static str, QueryValue)> {
        let instance = |id: &Id| ("instance_id", QueryValue::Id(id.clone()));
        match self.read {
            Read::Events { start, end } => vec![
                ("start", QueryValue::Day(*start)),
                ("end", QueryValue::Day(*end)),
                ("limit", QueryValue::Fixed(EVENTS_LIMIT)),
            ],
            Read::FormEntries(id) => vec![("form_id", QueryValue::Id(id.clone()))],
            Read::Attendance(id) => vec![instance(id), ("type", QueryValue::Fixed("person"))],
            Read::Event(id) | Read::Volunteers(id) => vec![instance(id)],
            Read::Roles(id) => vec![instance(id), ("show_quantity", QueryValue::Fixed("1"))],
            Read::People => vec![
                ("details", QueryValue::Fixed("0")),
                ("limit", QueryValue::Fixed(PEOPLE_LIMIT)),
            ],
            Read::Account | Read::Tags | Read::Forms => Vec::new(),
        }
    }
}

/// One of every read, for the guard's list of shapes (`shapes`); `kind` is exhaustive and the tests check every kind is
/// here.
pub(crate) fn samples() -> Vec<Read> {
    let id = || Id::new("1").expect("a checked id");
    let day = Date::parse("2000-01-01").expect("a day");
    vec![
        Read::Account,
        Read::Events {
            start: day,
            end: day,
        },
        Read::Event(id()),
        Read::Volunteers(id()),
        Read::Roles(id()),
        Read::People,
        Read::Tags,
        Read::Forms,
        Read::FormEntries(id()),
        Read::Attendance(id()),
    ]
}
#[cfg(test)]
pub(crate) fn kind(read: &Read) -> usize {
    match read {
        Read::Account => 0,
        Read::Events { .. } => 1,
        Read::Event(_) => 2,
        Read::Volunteers(_) => 3,
        Read::Roles(_) => 4,
        Read::People => 5,
        Read::Tags => 6,
        Read::Forms => 7,
        Read::FormEntries(_) => 8,
        Read::Attendance(_) => 9,
    }
}
/// The shape of every read Breeze may be sent (http.rs `allowed`): exact paths, and query values of fixed shapes.
pub(crate) fn shapes() -> Vec<crate::http::Shape> {
    let host = ChurchHost::new("sample", SUFFIX).expect("a label");
    samples()
        .iter()
        .map(|read| crate::http::Shape::of(&At { host: &host, read }))
        .collect()
}
/// A church's Breeze address from its id (the subdomain).
pub fn church_host(church: &Id) -> Option<ChurchHost> {
    let label = church.as_str();
    (!RESERVED.contains(&label) && !label.starts_with("xn--"))
        .then(|| ChurchHost::new(label, SUFFIX))
        .flatten()
}
/// Subdomains that are Breeze's own or a service's rather than a church's: a key is never sent to one. Punycode
/// labels (`xn--`) are refused too, so a look-alike address can't be typed in.
const RESERVED: &[&str] = &[
    "www",
    "api",
    "app",
    "apps",
    "status",
    "mail",
    "email",
    "smtp",
    "support",
    "help",
    "helpdesk",
    "admin",
    "secure",
    "blog",
    "docs",
    "developer",
    "developers",
    "cdn",
    "static",
    "assets",
    "login",
    "auth",
    "sso",
    "dev",
    "staging",
    "test",
    "demo",
    "trial",
    "billing",
    "pay",
    "give",
];

/// A number Breeze sends as a string of digits (research 3), or as a JSON number; at most `MAX_COUNT`.
fn optional_number(row: &Row, key: &str) -> Result<Option<u32>, ReadError> {
    let max = u64::from(crate::capture::MAX_COUNT);
    match row.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s.is_empty() => Ok(None),
        Some(Value::String(s)) if s.len() <= 6 && s.bytes().all(|b| b.is_ascii_digit()) => s
            .parse::<u64>()
            .ok()
            .filter(|n| *n <= max)
            .map(|n| Some(n as u32))
            .ok_or(BAD),
        Some(Value::Number(n)) => n
            .as_u64()
            .filter(|n| *n <= max)
            .map(|n| Some(n as u32))
            .ok_or(BAD),
        Some(_) => Err(BAD),
    }
}
/// The account's zone and the zone data to read Breeze's local times with; `None` when the account gives no zone.
type Zone<'a> = Option<(&'a ZoneName, &'a dyn ZoneOffsets)>;
/// A Breeze time, read.
enum Moment {
    /// A moment, and the local day it falls on.
    At(Time, Date),
    /// Missing, null or a zero date.
    Absent,
    /// A local time the zone skips or repeats (a clock change): never guessed. The day it is written on.
    Unplaceable(Date),
}
/// `YYYY-MM-DD HH:MM:SS`, Breeze's local wall-clock time: its day and seconds past midnight.
fn local_time(text: &str) -> Option<(Date, i64)> {
    let b = text.as_bytes();
    let ok = b.len() == 19
        && text.is_ascii()
        && b[10] == b' '
        && b[13] == b':'
        && b[16] == b':'
        && [11, 12, 14, 15, 17, 18]
            .iter()
            .all(|i| b[*i].is_ascii_digit());
    if !ok {
        return None;
    }
    let n = |r: std::ops::Range<usize>| text[r].parse::<i64>().ok();
    let (h, m, s) = (n(11..13)?, n(14..16)?, n(17..19)?);
    (h < 24 && m < 60 && s < 60).then_some(())?;
    Some((Date::parse(&text[..10])?, h * 3600 + m * 60 + s))
}
/// A Breeze time (`start_datetime`, `end_datetime`; live: `YYYY-MM-DD HH:MM:SS`, local to the account's zone).
/// - A zero date (`0000-00-00 ...`), missing or null: absent.
/// - A local time with the account's zone: the instant it is there (`ZoneOffsets`), written with its offset; a time
///   the zone skips or repeats is `Unplaceable`. Without a zone, or a zone this Mac doesn't know: refused (Ozzie
///   never guesses a zone).
/// - A time written with an offset: that moment.
fn moment(row: &Row, key: &str, zone: Zone<'_>) -> Result<Moment, ReadError> {
    let text = match row.get(key) {
        None | Some(Value::Null) => return Ok(Moment::Absent),
        Some(Value::String(s)) if s.starts_with("0000-00-00") => return Ok(Moment::Absent),
        Some(Value::String(s)) => s.as_str(),
        Some(_) => return Err(BAD),
    };
    if let Some(time) = Time::parse(text) {
        let day = match zone {
            Some((name, zones)) => zones.local_day(name, &time).ok_or(BAD)?,
            None => time.local_date(),
        };
        return Ok(Moment::At(time, day));
    }
    let (day, seconds) = local_time(text).ok_or(BAD)?;
    let (name, zones) = zone.ok_or(BAD)?;
    match zones.local_to_instant(name, day, seconds) {
        LocalResult::Single(time) => Ok(Moment::At(time, day)),
        LocalResult::Gap | LocalResult::Ambiguous(..) => Ok(Moment::Unplaceable(day)),
        LocalResult::Unknown => Err(BAD),
    }
}
/// The day a Breeze time falls on as written: `YYYY-MM-DD HH:MM:SS`, or an RFC 3339 time in its own offset.
pub fn written_day(text: &str) -> Option<Date> {
    if let Some(time) = Time::parse(text) {
        return Some(time.local_date());
    }
    let b = text.as_bytes();
    let clock_ok = b.len() == 19
        && b[10] == b' '
        && b[13] == b':'
        && b[16] == b':'
        && [11, 12, 14, 15, 17, 18]
            .iter()
            .all(|i| b[*i].is_ascii_digit());
    if clock_ok {
        Date::parse(&text[..10])
    } else {
        None
    }
}
/// What each Breeze `response` code means: "0" no response, "1" DECLINED, "2" ACCEPTED. Not the order of Breeze's own
/// menu (Accepted, Declined, No Response): seen live 2026-11-17 on Breeze's older volunteers page, by a controlled
/// change (a volunteer set to Accepted there went from "0" to "2"; one set to Declined read "1"). `rsvped_on` stayed a
/// zero date for answers set by an admin, so it says nothing about whether someone answered. Any other code is
/// `unknown`. Turning this off is `None` here, with `Supplies::answers` for Breeze (lib.rs) and the page's own
/// `answers` flag.
pub const ANSWER_CODES: Option<&[(&str, Status)]> = Some(&[
    ("0", Status::Unconfirmed),
    ("1", Status::Declined),
    ("2", Status::Accepted),
]);
/// A volunteer's answer, through `ANSWER_CODES`.
pub fn answer(response: &Value) -> Status {
    answer_with(ANSWER_CODES, response)
}
/// A volunteer's answer through `codes`: the code as Breeze sends it (a string, or a number), matched exactly; any
/// other code, or no table, is `unknown`.
pub fn answer_with(codes: Option<&[(&str, Status)]>, response: &Value) -> Status {
    let text = match response {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => return Status::Unknown,
    };
    codes
        .and_then(|codes| codes.iter().find(|(code, _)| *code == text))
        .map_or(Status::Unknown, |(_, status)| *status)
}

struct AccountRecord {
    name: Option<String>,
    zone: Option<ZoneName>,
}
/// `/api/account/summary` (research 3, Account): `id`, `name`, `subdomain`, `details.timezone`. The subdomain must be
/// the one asked.
fn project_account(
    value: &Value,
    host: &ChurchHost,
) -> Result<Projected<AccountRecord>, ReadError> {
    let row = object(value)?;
    id_field(row, "id")?;
    if optional_text(row, "subdomain")? != Some(host.label()) {
        return Err(BAD);
    }
    let name = optional_text(row, "name")?.map(str::to_owned);
    let zone_text = match row.get("details") {
        None | Some(Value::Null) => None,
        Some(Value::Object(details)) => optional_text(details, "timezone")?,
        Some(_) => return Err(BAD),
    };
    let zone = zone_text.and_then(ZoneName::new);
    // A zone Ozzie can't read as an IANA name is left out, and the read says so.
    let zone_dropped = zone_text.is_some() && zone.is_none();
    Ok((AccountRecord { name, zone }, zone_dropped))
}

/// One event instance row (research 3, Events; live shape 2026-11-17): `id` (the instance), `name`,
/// `start_datetime`, `end_datetime`. `event` is `None` when its start can't be placed; `cut` says a time was left out.
struct EventRow {
    id: Id,
    event: Option<Event>,
    day: Date,
    name: Option<String>,
    cut: bool,
}
fn event_row(row: &Row, zone: Zone<'_>) -> Result<EventRow, ReadError> {
    let id = id_field(row, "id")?;
    let name = optional_text(row, "name")?.map(str::to_owned);
    let (starts_at, day) = match moment(row, "start_datetime", zone)? {
        Moment::At(time, day) => (Some(time), day),
        Moment::Unplaceable(day) => (None, day),
        Moment::Absent => return Err(BAD),
    };
    let (ends_at, end_cut) = match moment(row, "end_datetime", zone)? {
        Moment::At(time, _) => (Some(time), false),
        Moment::Absent => (None, false),
        Moment::Unplaceable(_) => (None, true),
    };
    let Some(starts_at) = starts_at else {
        return Ok(EventRow {
            id,
            event: None,
            day,
            name,
            cut: true,
        });
    };
    if ends_at
        .as_ref()
        .is_some_and(|e| e.unix_millis() < starts_at.unix_millis())
    {
        return Err(BAD);
    }
    let event = Event {
        id: id.clone(),
        starts_at,
        ends_at,
        attendance: None,
    };
    Ok(EventRow {
        id,
        event: Some(event),
        day,
        name,
        cut: end_cut,
    })
}
/// The instance as the service: it must be the one asked, and end after it starts (or have no end). Its `day` is the
/// local day of its start when the account's zone placed it; a start that can't be placed leaves no service and
/// `cut` set.
struct InstanceRead {
    service: Option<Service>,
    day: Date,
    name: Option<String>,
    cut: bool,
}
fn project_instance(
    value: &Value,
    instance: &Id,
    zone: Zone<'_>,
) -> Result<InstanceRead, ReadError> {
    let row = event_row(object(value)?, zone)?;
    if &row.id != instance {
        return Err(BAD);
    }
    let service = match row.event {
        Some(event) => {
            if event
                .ends_at
                .as_ref()
                .is_some_and(|e| e.unix_millis() <= event.starts_at.unix_millis())
            {
                return Err(BAD);
            }
            Some(Service {
                id: event.id,
                day: zone.map(|_| row.day),
                starts_at: event.starts_at,
                ends_at: event.ends_at,
                shared: None,
            })
        }
        None => None,
    };
    Ok(InstanceRead {
        service,
        day: row.day,
        name: row.name,
        cut: row.cut,
    })
}
fn project_events(value: &Value, zone: Zone<'_>) -> Result<Projected<Labelled<Event>>, ReadError> {
    let mut list = Vec::new();
    let mut seen = BTreeSet::new();
    let mut cut = false;
    for row in rows(value)? {
        let row = event_row(object(row)?, zone)?;
        if !seen.insert(row.id.clone()) {
            return Err(BAD);
        }
        cut |= row.cut;
        if let Some(event) = row.event {
            list.push((event, row.name));
        }
    }
    let (list, over) = capped(list, MAX_EVENTS);
    Ok((list, cut || over))
}

struct RolesRead {
    list: Labelled<Position>,
    cut: bool,
}
/// `list_roles?show_quantity=1` (research 3, Volunteers): `id`, `name`, `quantity` (the number wanted).
fn project_roles(value: &Value) -> Result<Projected<RolesRead>, ReadError> {
    let mut list = Vec::new();
    let mut seen = BTreeSet::new();
    for row in rows(value)? {
        let row = object(row)?;
        let id = id_field(row, "id")?;
        if !seen.insert(id.clone()) {
            return Err(BAD);
        }
        let position = Position {
            id,
            team_id: None,
            needed: optional_number(row, "quantity")?,
        };
        list.push((position, optional_text(row, "name")?.map(str::to_owned)));
    }
    let (list, cut) = capped(list, MAX_POSITIONS);
    Ok((RolesRead { list, cut }, cut))
}

/// What the volunteers read gives: one assignment per volunteer and role, and the people on the service in no role.
struct VolunteersRead {
    assignments: Vec<Assignment>,
    on_service: Vec<Id>,
}
/// `volunteers/list` (research 3, Volunteers): `id`, `person_id`, `response`, `role_ids` (null or role id strings).
/// One assignment per volunteer and role, id `<volunteer>-<role>`. A volunteer with no role (`role_ids` null or empty)
/// is on the service in no role (`on_service`) only when their answer is accepted or no response yet, and they hold no
/// role on it elsewhere: one who declined said no, so they are left out (and nothing is missing); one whose answer code
/// Ozzie doesn't know may or may not be on it, so they are left out and the read is `truncated`. A role not in the
/// instance's roles is refused, unless roles were cut at the cap.
fn project_volunteers(
    value: &Value,
    roles: &RolesRead,
) -> Result<Projected<VolunteersRead>, ReadError> {
    let known: BTreeSet<&Id> = roles.list.iter().map(|(p, _)| &p.id).collect();
    let mut list = Vec::new();
    let mut seen = BTreeSet::new();
    let mut ids = BTreeSet::new();
    let mut roleless = BTreeSet::new();
    let mut cut = false;
    for row in rows(value)? {
        let row = object(row)?;
        let volunteer = id_field(row, "id")?;
        let person_id = id_field(row, "person_id")?;
        let status = answer(row.get("response").unwrap_or(&Value::Null));
        if !seen.insert(volunteer.clone()) {
            return Err(BAD);
        }
        let role_ids: Vec<Id> = match row.get("role_ids") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(ids)) => ids
                .iter()
                .map(|v| v.as_str().and_then(Id::new).ok_or(BAD))
                .collect::<Result<_, _>>()?,
            Some(_) => return Err(BAD),
        };
        if role_ids.is_empty() {
            match status {
                Status::Accepted | Status::Unconfirmed => {
                    roleless.insert(person_id.clone());
                }
                Status::Declined => {}
                Status::Unknown => cut = true,
            }
        }
        for role in role_ids.into_iter().collect::<BTreeSet<_>>() {
            if !known.contains(&role) {
                if roles.cut {
                    cut = true;
                    continue;
                }
                return Err(BAD);
            }
            let id = Id::new(&format!("{}-{}", volunteer.as_str(), role.as_str())).ok_or(BAD)?;
            // Two pairs that join to one id (ids with `-` in them) can't both be kept: refuse the read, not the capture.
            if !ids.insert(id.clone()) {
                return Err(BAD);
            }
            list.push(Assignment {
                id,
                position_id: role,
                person_id: person_id.clone(),
                status,
                asked: None,
            });
        }
    }
    // Who holds a role is judged on every assignment read, before the cap leaves some out.
    let with_role: BTreeSet<Id> = list.iter().map(|a| a.person_id.clone()).collect();
    let (assignments, over) = capped(list, MAX_ASSIGNMENTS);
    let free: Vec<Id> = roleless
        .into_iter()
        .filter(|p| !with_role.contains(p))
        .collect();
    let (on_service, too_many) = capped(free, MAX_ON_SERVICE);
    Ok((
        VolunteersRead {
            assignments,
            on_service,
        },
        cut || over || too_many,
    ))
}

/// `/api/people?details=0` (research 3, People): `id`, `first_name`, `last_name`. Kept for `wanted` only; when someone
/// wanted isn't in a full list (as many as asked for came back), the read is `truncated`.
fn project_people(
    value: &Value,
    wanted: &BTreeSet<Id>,
) -> Result<Projected<BTreeMap<Id, Name>>, ReadError> {
    let all = rows(value)?;
    let mut names = BTreeMap::new();
    for row in all {
        let row = object(row)?;
        let id = id_field(row, "id")?;
        let parts = [
            optional_text(row, "first_name")?,
            optional_text(row, "last_name")?,
        ];
        if !wanted.contains(&id) {
            continue;
        }
        let joined = parts.into_iter().flatten().collect::<Vec<_>>().join(" ");
        if let Some(name) = Name::new(&joined) {
            names.insert(id, name);
        }
    }
    // Someone scheduled whom the list doesn't name (a list cut at its limit, or a person Breeze no longer lists): the
    // names are partial.
    let missing = wanted.iter().any(|id| !names.contains_key(id));
    Ok((names, missing))
}

/// `list_tags` (research 3, Tags): `id`, `name`. Member counts aren't read.
fn project_tags(value: &Value) -> Result<Projected<Labelled<Group>>, ReadError> {
    let mut list = Vec::new();
    let mut seen = BTreeSet::new();
    for row in rows(value)? {
        let row = object(row)?;
        let id = id_field(row, "id")?;
        if !seen.insert(id.clone()) {
            return Err(BAD);
        }
        let name = optional_text(row, "name")?.map(str::to_owned);
        list.push((Group { id, members: None }, name));
    }
    Ok(capped(list, MAX_GROUPS))
}
/// A form from `list_forms`: the form, its name, when it was made (`created_on`, as written) and whether it is
/// archived, for choosing whose entries to count.
type FormRow = (Form, Option<String>, Option<String>, bool);
/// `list_forms` (research 3, Forms; live rows: `id`, `name`, `created_on`, `folder_id`, `is_archived`, `url_slug`):
/// `id`, `name`, `created_on`, and `is_archived` ("0" for a form in use).
fn project_forms(value: &Value) -> Result<Projected<Vec<FormRow>>, ReadError> {
    let mut list = Vec::new();
    let mut seen = BTreeSet::new();
    for row in rows(value)? {
        let row = object(row)?;
        let id = id_field(row, "id")?;
        if !seen.insert(id.clone()) {
            return Err(BAD);
        }
        let name = optional_text(row, "name")?.map(str::to_owned);
        let created = optional_text(row, "created_on")?.map(str::to_owned);
        let archived = match row.get("is_archived") {
            None | Some(Value::Null) => false,
            Some(Value::String(flag)) => flag != "0",
            Some(Value::Number(flag)) => flag.as_u64() != Some(0),
            Some(_) => return Err(BAD),
        };
        list.push((
            Form {
                id,
                submissions: None,
            },
            name,
            created,
            archived,
        ));
    }
    Ok(capped(list, MAX_FORMS))
}
/// How many entries a form has, from `list_form_entries` without `details`. Seen live (2026-11-17): an object keyed by
/// entry id, each value the entry (`id`, `oid`, `form_id`, `created_on`, `person_id`, `response`); the docs' sample
/// is an array of entries. Either is counted, each entry must be an object, and nothing of one is kept. An empty form
/// may answer `{}` or `[]`: 0.
fn count_entries_answer(value: &Value) -> Result<u32, ReadError> {
    let entries: Vec<&Value> = match value {
        Value::Object(by_id) => by_id.values().collect(),
        Value::Array(list) => list.iter().collect(),
        _ => return Err(BAD),
    };
    if entries.iter().any(|e| !e.is_object()) || entries.len() > crate::capture::MAX_COUNT as usize
    {
        return Err(BAD);
    }
    Ok(entries.len() as u32)
}
/// How many rows a list holds (an instance's check-ins): each must be an object, and nothing of them is kept.
fn count_rows(value: &Value) -> Result<u32, ReadError> {
    let all = rows(value)?;
    if all.iter().any(|row| !row.is_object()) || all.len() > crate::capture::MAX_COUNT as usize {
        return Err(BAD);
    }
    Ok(all.len() as u32)
}

/// Reads one event instance from Breeze for the church whose subdomain is `church`: the reads at the top of this
/// file, paced and limited by `LIMITS`, each recorded. The capture has passed `SystemCapture::valid`. An error only
/// when nothing can be read at all: the key isn't a Breeze key, or `church` can't be a subdomain.
pub fn check(
    http: &dyn Http,
    clock: &dyn Clock,
    zones: &dyn ZoneOffsets,
    key: &Key,
    church: &Id,
    instance: &Id,
    pacer: Option<&Pacer>,
) -> Result<SystemCapture, ReadError> {
    check_with(http, clock, zones, key, church, instance, pacer, LIMITS)
}
#[allow(clippy::too_many_arguments)]
pub(crate) fn check_with(
    http: &dyn Http,
    clock: &dyn Clock,
    zones: &dyn ZoneOffsets,
    key: &Key,
    church: &Id,
    instance: &Id,
    pacer: Option<&Pacer>,
    limits: Limits,
) -> Result<SystemCapture, ReadError> {
    if key.system() != System::Breeze {
        return Err(ReadError::KeyRefused);
    }
    let host = church_host(church).ok_or(ReadError::NotFound)?;
    let auth = Auth::ApiKey(key.clone());
    let get = |read: Read| {
        Get::new(
            &At {
                host: &host,
                read: &read,
            },
            auth.clone(),
        )
    };
    let key_gate = decoder(ReadError::KeyRefused);
    let blocked = decoder(ReadError::Refused);
    let mut run = Run::paced(http, clock, limits, pacer);
    let mut capture = SystemCapture::empty(System::Breeze, church.clone(), run.started_at());

    if let Some(account) = run.read(ACCOUNT, get(Read::Account), &key_gate, |v| {
        project_account(v, &host)
    }) {
        capture.church.time_zone = account.zone;
        if let Some(name) = account.name {
            capture.label(LabelKey::Church, &name);
        }
    }
    // The instance, then the events from its day, recorded as one read. Both parts are kept only when both are read;
    // when the run stops before the second, the service is kept and the read is `truncated`.
    let mut service = None;
    let mut events = Vec::new();
    // The account's zone that this Mac doesn't know is never the capture's zone: nothing is placed with it, and the
    // check runs as with no zone.
    if capture
        .church
        .time_zone
        .as_ref()
        .is_some_and(|name| !crate::zones::known(zones, name, clock))
    {
        capture.church.time_zone = None;
    }
    let zone_name = capture.church.time_zone.clone();
    let zone: Zone<'_> = zone_name.as_ref().map(|name| (name, zones));
    let instance_read = run
        .send(
            get(Read::Event(instance.clone())),
            refusal(run.answered(), &blocked, &key_gate),
        )
        .and_then(|v| project_instance(&v, instance, zone).map_err(Miss::Failed));
    let events_outcome = match instance_read {
        Ok(found) => {
            let start = found.day;
            let window = Date::from_days(start.days() + WINDOW_DAYS - 1)
                .ok_or(Miss::Failed(BAD))
                .and_then(|end| {
                    run.send(
                        get(Read::Events { start, end }),
                        refusal(run.answered(), &blocked, &key_gate),
                    )
                })
                .and_then(|v| project_events(&v, zone).map_err(Miss::Failed));
            let outcome = match window {
                Ok((list, cut)) => {
                    events = list;
                    if cut || found.cut {
                        Outcome::Truncated
                    } else {
                        Outcome::Ok
                    }
                }
                Err(Miss::NotSent(_)) => Outcome::Truncated,
                Err(miss) => miss.outcome(),
            };
            if !outcome.is_failure() {
                if found.service.is_some()
                    && let Some(name) = found.name
                {
                    capture.label(LabelKey::Service, &name);
                }
                service = found.service;
            }
            outcome
        }
        Err(miss) => miss.outcome(),
    };
    run.record(EVENTS, events_outcome);

    let roles = run.read(
        ROLES,
        get(Read::Roles(instance.clone())),
        refusal(run.answered(), &blocked, &key_gate),
        project_roles,
    );
    let volunteers = match &roles {
        Some(roles) => run.read(
            VOLUNTEERS,
            get(Read::Volunteers(instance.clone())),
            refusal(run.answered(), &blocked, &key_gate),
            |v| project_volunteers(v, roles),
        ),
        None => {
            run.skip(VOLUNTEERS);
            None
        }
    };
    let people: BTreeSet<Id> = volunteers
        .iter()
        .flat_map(|v| {
            v.assignments
                .iter()
                .map(|a| &a.person_id)
                .chain(&v.on_service)
        })
        .cloned()
        .collect();
    let names = if people.is_empty() {
        // Nobody scheduled (the volunteers read said so): no names to read, and none missing.
        if volunteers.is_some() {
            run.record(PEOPLE, Outcome::Ok);
            Some(BTreeMap::new())
        } else {
            run.skip(PEOPLE);
            None
        }
    } else {
        run.read(
            PEOPLE,
            get(Read::People),
            refusal(run.answered(), &blocked, &key_gate),
            |v| project_people(v, &people),
        )
    };
    let names = names.unwrap_or_default();
    // Everyone on the service in no role has a name in the capture: one the people list didn't name can't be kept, so
    // they are left out and the volunteers read says something was.
    let mut on_service = Vec::new();
    if let Some(volunteers) = &volunteers {
        on_service = volunteers
            .on_service
            .iter()
            .filter(|p| names.contains_key(*p))
            .cloned()
            .collect();
        if on_service.len() < volunteers.on_service.len() {
            run.amend(VOLUNTEERS, Outcome::Ok, Outcome::Truncated);
        }
    }
    // Attendance: how many people were checked in to the service by name (`type=person`; Breeze's anonymous head
    // counts are another type whose shape its docs don't show, so they aren't included). Read only once the service
    // has ended, its end known and passed (an all-day event ends at its end time): before that the count is still
    // growing, and a 0 would read as nobody came. Only when the service is among the events kept.
    let ended = service.as_ref().is_some_and(|s| {
        s.ends_at
            .as_ref()
            .is_some_and(|end| end.unix_millis() <= clock.unix_millis())
    });
    let attendance = if ended && events.iter().any(|(e, _)| &e.id == instance) {
        run.read(
            ATTENDANCE,
            get(Read::Attendance(instance.clone())),
            refusal(run.answered(), &blocked, &key_gate),
            |v| count_rows(v).map(|n| (n, false)),
        )
    } else {
        run.skip(ATTENDANCE);
        None
    };
    let tags = run.read(
        TAGS,
        get(Read::Tags),
        refusal(run.answered(), &blocked, &key_gate),
        project_tags,
    );
    let forms = run.read(
        FORMS,
        get(Read::Forms),
        refusal(run.answered(), &blocked, &key_gate),
        project_forms,
    );
    let counts = match &forms {
        Some(forms) => {
            let (counts, outcome) = count_entries(&mut run, forms, &get, (&blocked, &key_gate));
            run.record(FORM_ENTRIES, outcome);
            counts
        }
        None => {
            run.skip(FORM_ENTRIES);
            BTreeMap::new()
        }
    };

    if let Some(roles) = roles {
        for (position, name) in roles.list {
            if let Some(name) = name {
                capture.label(LabelKey::Position(position.id.clone()), &name);
            }
            capture.positions.push(position);
        }
    }
    capture.assignments = volunteers.map(|v| v.assignments).unwrap_or_default();
    capture.on_service = on_service;
    capture.service = service;
    capture.names = names;
    for (mut event, name) in events {
        if let Some(name) = name {
            capture.label(LabelKey::Event(event.id.clone()), &name);
        }
        if &event.id == instance {
            event.attendance = attendance;
        }
        capture.events.push(event);
    }
    for (group, name) in tags.unwrap_or_default() {
        if let Some(name) = name {
            capture.label(LabelKey::Group(group.id.clone()), &name);
        }
        capture.groups.push(group);
    }
    for (mut form, name, _, _) in forms.unwrap_or_default() {
        if let Some(name) = name {
            capture.label(LabelKey::Form(form.id.clone()), &name);
        }
        form.submissions = counts.get(&form.id).copied();
        capture.forms.push(form);
    }
    let (reads, completed_at) = run.finish();
    capture.reads = reads;
    capture.completed_at = completed_at;
    capture.valid().map_err(|_| ReadError::InvalidResponse)?;
    Ok(capture)
}

/// What a 401 or 403 means on a Breeze read. Breeze's docs name no status for a refused key, and for going over 20
/// requests a minute promise only "a temporary block" (its support page), naming no status either. So the first read
/// answered tells a bad key apart, as well as Ozzie can: before any answer, a refusal is taken as the key not opening
/// this church (`key-refused`, which stops the run). After one, the key is known to work, and a refusal is just that
/// read refused (`refused`): it may be Breeze's block or something this account can't use, which Ozzie can't tell, so
/// it says no more than that, and the run goes on (the breaker still stops it after three failures in a row). Only a
/// 429 is `rate-limited`.
type Decode = dyn Fn(&Reply) -> Result<Value, ReadError>;
fn refusal<'d>(answered: bool, refused: &'d Decode, key_gate: &'d Decode) -> &'d Decode {
    if answered { refused } else { key_gate }
}
/// Entry counts for the `MAX_FORM_COUNTS` most recently made forms in use (by `created_on`, a form without one last),
/// one request each and counts only. An archived form (`is_archived` other than "0") isn't counted: Breeze's list
/// holds active forms unless asked for archived ones, so one marked archived is left out of the five, its count null. A failed request leaves every count null and the read takes its outcome; when the run
/// stops part way, the counts read are kept and the read says why it stopped (round 3: never `truncated`, which the page
/// takes as "more forms than Ozzie counts", by design). More forms than are counted make it `truncated`: their counts
/// stay null.
fn count_entries(
    run: &mut Run<'_>,
    forms: &[FormRow],
    get: &dyn Fn(Read) -> Get,
    (blocked, key_gate): (&Decode, &Decode),
) -> (BTreeMap<Id, u32>, Outcome) {
    let mut newest: Vec<&FormRow> = forms
        .iter()
        .filter(|(_, _, _, archived)| !archived)
        .collect();
    newest.sort_by(|a, b| {
        b.2.is_some()
            .cmp(&a.2.is_some())
            .then(b.2.cmp(&a.2))
            .then(a.0.id.cmp(&b.0.id))
    });
    newest.truncate(MAX_FORM_COUNTS);
    let mut counts = BTreeMap::new();
    for (form, _, _, _) in newest.iter().copied() {
        let read = run
            .send(
                get(Read::FormEntries(form.id.clone())),
                refusal(run.answered(), blocked, key_gate),
            )
            .and_then(|v| count_entries_answer(&v).map_err(Miss::Failed));
        match read {
            Ok(n) => {
                counts.insert(form.id.clone(), n);
            }
            Err(Miss::Failed(error)) => return (BTreeMap::new(), error.into()),
            Err(Miss::NotSent(outcome)) => return (counts, outcome),
        }
    }
    let outcome = if forms.len() > counts.len() {
        Outcome::Truncated
    } else {
        Outcome::Ok
    };
    (counts, outcome)
}

/// Checks `key` at the church's address with the account read (a refusal is `key-refused`; an answer for another
/// subdomain is `invalid-response`), and gives the church.
pub fn verify_key(
    http: &dyn Http,
    clock: &dyn Clock,
    key: &Key,
    church: &Id,
    pacer: Option<&Pacer>,
) -> Result<ChurchChoice, ReadError> {
    if key.system() != System::Breeze {
        return Err(ReadError::KeyRefused);
    }
    let host = church_host(church).ok_or(ReadError::NotFound)?;
    let mut run = Run::paced(http, clock, LIMITS, pacer);
    let value = run
        .send(
            Get::new(
                &At {
                    host: &host,
                    read: &Read::Account,
                },
                Auth::ApiKey(key.clone()),
            ),
            &decoder(ReadError::KeyRefused),
        )
        .map_err(miss_error)?;
    let (account, _) = project_account(&value, &host)?;
    Ok(ChurchChoice {
        id: church.clone(),
        name: account.name.as_deref().and_then(Label::new),
    })
}

/// An event instance to choose for a check.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct EventChoice {
    pub id: Id,
    /// The day it starts, as Breeze writes it.
    pub day: Date,
    pub name: Option<Label>,
    /// When it starts on the church's clock, as Breeze writes it (`HH:MM`); None for an event with no time of day, which
    /// Breeze writes as midnight (round 4).
    pub time: Option<String>,
    /// How many people are listed on it, not counting anyone who said no: read only for the events on the soonest day
    /// (on or after `from`) when several share it (`MAX_PICK_COUNTS`); None where not read. A count only, no one's id.
    pub people: Option<u32>,
}
/// The start of a Breeze time as written, `HH:MM` on the church's clock; None for midnight (no time of day) or a time
/// that isn't written one of the two ways Breeze writes them.
fn written_clock(text: &str) -> Option<String> {
    let b = text.as_bytes();
    let shaped = b.len() >= 19
        && (b[10] == b' ' || b[10] == b'T')
        && b[13] == b':'
        && b[16] == b':'
        && [11, 12, 14, 15, 17, 18]
            .iter()
            .all(|i| b[*i].is_ascii_digit());
    let clock = text.get(11..16)?;
    (shaped && written_day(text).is_some() && text.get(11..19) != Some("00:00:00"))
        .then(|| clock.to_owned())
}
/// How many people a volunteers list holds, not counting anyone who said no (`ANSWER_CODES`). Counts only.
fn count_volunteers(value: &Value) -> Result<u32, ReadError> {
    let mut people = BTreeSet::new();
    for row in rows(value)? {
        let row = object(row)?;
        let person = id_field(row, "person_id")?;
        if answer(row.get("response").unwrap_or(&Value::Null)) != Status::Declined {
            people.insert(person);
        }
    }
    u32::try_from(people.len()).map_err(|_| BAD)
}
/// The church's event instances from yesterday (UTC; a day's slack, the church's zone may be behind) for
/// `WINDOW_DAYS`, soonest first (by day, then start time, an event with no time of day last), at most
/// `MAX_EVENT_CHOICES`. The account read comes first, so a bad key is `key-refused` before any list is trusted. Only
/// the day and the clock as written are needed here, so local times are fine. When several events share the soonest
/// day on or after `from` (the page's today), up to `MAX_PICK_COUNTS` of them have their volunteers counted; a count
/// that can't be read stays None and never fails the list. Without `from` nothing is counted.
pub fn events(
    http: &dyn Http,
    clock: &dyn Clock,
    key: &Key,
    church: &Id,
    pacer: Option<&Pacer>,
    from: Option<Date>,
) -> Result<Vec<EventChoice>, ReadError> {
    if key.system() != System::Breeze {
        return Err(ReadError::KeyRefused);
    }
    let host = church_host(church).ok_or(ReadError::NotFound)?;
    let auth = Auth::ApiKey(key.clone());
    let mut run = Run::paced(http, clock, LIMITS, pacer);
    let value = run
        .send(
            Get::new(
                &At {
                    host: &host,
                    read: &Read::Account,
                },
                auth.clone(),
            ),
            &decoder(ReadError::KeyRefused),
        )
        .map_err(miss_error)?;
    project_account(&value, &host)?;
    let start = Date::from_days(clock.unix_millis().div_euclid(86_400_000) - 1).ok_or(BAD)?;
    let end = Date::from_days(start.days() + WINDOW_DAYS).ok_or(BAD)?;
    let value = run
        .send(
            Get::new(
                &At {
                    host: &host,
                    read: &Read::Events { start, end },
                },
                auth.clone(),
            ),
            // After the account was read, a refusal is this read refused (see `refusal`).
            &decoder(ReadError::Refused),
        )
        .map_err(miss_error)?;
    let mut choices = Vec::new();
    for row in rows(&value)? {
        let row = object(row)?;
        let id = id_field(row, "id")?;
        let start = row
            .get("start_datetime")
            .and_then(Value::as_str)
            .ok_or(BAD)?;
        let day = written_day(start).ok_or(BAD)?;
        let name = optional_text(row, "name")?.and_then(Label::new);
        choices.push(EventChoice {
            id,
            day,
            name,
            time: written_clock(start),
            people: None,
        });
    }
    choices.sort_by(|a, b| {
        (a.day, a.time.is_none(), &a.time, &a.id).cmp(&(b.day, b.time.is_none(), &b.time, &b.id))
    });
    choices.truncate(MAX_EVENT_CHOICES);
    // Counted only for a caller that picks from them (`from` given): moving on and Settings' list never read them (review
    // of round 4, M4).
    let soonest = from.and_then(|from| choices.iter().map(|c| c.day).find(|day| *day >= from));
    let same: Vec<usize> = choices
        .iter()
        .enumerate()
        .filter(|(_, c)| Some(c.day) == soonest)
        .map(|(i, _)| i)
        .collect();
    if same.len() > 1 {
        for i in same.into_iter().take(MAX_PICK_COUNTS) {
            let counted = run
                .send(
                    Get::new(
                        &At {
                            host: &host,
                            read: &Read::Volunteers(choices[i].id.clone()),
                        },
                        auth.clone(),
                    ),
                    &decoder(ReadError::Refused),
                )
                .map_err(miss_error)
                .and_then(|v| count_volunteers(&v));
            match counted {
                Ok(n) => choices[i].people = Some(n),
                // Out of time or requests, or refused: the rest stay uncounted; the list stands.
                Err(_) => break,
            }
        }
    }
    Ok(choices)
}

#[cfg(test)]
#[path = "breeze_tests.rs"]
pub(crate) mod tests;
