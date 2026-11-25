//! B1 Church (ChurchApps), read-only, from `https://api.churchapps.org` only. "Research" below means the 2026-11-17
//! reading of B1's open-source API code (the ChurchApps `Api` repository) and its developer docs, by section.
//!
//! The reads are a closed list (`Read`), every one a GET of a fixed path.
//! The key is an admin-made API key (`cak_...`), sent as `Authorization: Bearer <key>`.
//!
//! A Sunday check (`check`) reads, in this order, each at most once and paced by run.rs:
//!
//! | read word | GET | gives |
//! |---|---|---|
//! | `b1.church` | `/membership/churches/<church>` | the church's name and time zone; a 401 here means the key doesn't open this church |
//! | `b1.plans` | `/doing/plans/<plan>` | the plan's day (`serviceDate`, the service's `day`) and name |
//! | `b1.positions` | `/doing/positions/plan/<plan>` | roles, each with its wanted number (`count`) and team (`groupId`) |
//! | `b1.assignments` | `/doing/assignments/plan/<plan>` | who is scheduled, every answer, Declined included (the overview route leaves declines out), and whether each was sent the request (`notified`: `asked`) |
//! | `b1.group_members` | `/membership/groupmembers?groupIds=...` | who is on each role's team |
//! | `b1.times` | `/doing/times/plan/<plan>` | the service's times: those B1 types as a service (`serviceTimeType`), never a rehearsal or "other" time |
//! | `b1.blockouts` | `/doing/blockoutDates/upcoming` | blockout days still to come, church-wide, kept only for the people above |
//! | `b1.plans_day` | `/doing/plans/overview?startDate=&endDate=`, `/doing/plans/ids?ids=`, then `/doing/times/plans?planIds=` | other plans the day before to the day after with these people on them (accepted or unconfirmed), whether each is shared with its volunteers (a penciled-in plan makes nobody busy), and those plans' times: `busy` |
//! | `b1.people` | `/membership/people/names?ids=...` (100 at a time) | names, into `names` only |
//! | `b1.groups` | `/membership/groups` | groups, their member counts (a team's is its roster when that was read: `memberCount` counts people since removed too), and team names |
//! | `b1.events` | `/content/events/timeline` | upcoming one-off events of the groups the key's person belongs to |
//! | `b1.forms` | `/membership/forms` | forms, always `truncated`: with a read-only key B1 lists only the forms the key's maker has a permission on; submission counts need a write scope, so `submissions` is null and never read |
//!
//! B1's answers: a permission refusal is 401 with `{}` (sometimes `[]`); some errors are a 200 whose object has an
//! `error` (or `errors`) key, which is `refused`; a missing or bad key reaches the Doing reads as nobody and gets 200
//! `[]`, so every run starts with a read B1 refuses to a bad key, the church's own record (`b1.church`, and the
//! one read `verify_key` makes), and a 401 there is `key-refused`.
//!
//! Every answer is read through a closed projection: only the fields named below are read; a wrong type, an id that
//! fails `Id`, or a value outside what the field may be makes the whole read `invalid-response`. B1 answers with its
//! whole model objects (`churchId`, `notes`, `notified`, embedded `person` and `group` objects, `photo` and more), so
//! fields this file doesn't name are ignored on every B1 read.
//!
//! Times, as B1's server writes them (it runs in UTC and its database columns hold no zone):
//! - A time (`startTime`, `endTime`, an event's `start`, `end`) is a true instant, written `...T15:00:00.000Z`:
//!   accepted with `Z` or a numeric offset (`b1_time`). B1's "fake UTC" is only how it expands repeat rules, never
//!   how it writes a time.
//! - A day (`serviceDate`, `startDate`, `endDate`) is a calendar day written as that day's UTC midnight
//!   (`2026-11-22T00:00:00.000Z`): its first 10 characters, never converted (`b1_day`). Only UTC midnight or a bare
//!   `YYYY-MM-DD` is accepted, so a day shifted by a server in another zone is refused, not misread.
//! - The service is the plan's times that could be on its day in some zone (`SERVICE_WINDOW`). Without a time zone
//!   database this crate can't tell which local day a UTC instant falls on, so it takes them as the service only
//!   when they form one block: every one starts within `BLOCK` (6 hours) of the earliest. Otherwise (a rehearsal the
//!   evening before, or a Saturday and a Sunday service in one plan) it doesn't choose: the service starts at the
//!   earliest of them with no end, and `b1.times` is `truncated` (`project_service`). A plan time the window leaves
//!   out but within `NEAR_MS` (36 hours) of a kept one makes it `truncated` too (east of UTC, a Saturday evening time
//!   on a Sunday plan falls outside the window).
//! - The service's `day` is B1's own calendar day, sent only when the church's zone is known and can't be UTC+12 or
//!   more (`far_east`); otherwise it is null and the page names the day from the start time in the church's zone.
//! - `busy` carries each other assignment's answer (`accepted` or `unconfirmed`); any other status isn't busy.
//! - Blockouts use B1's own rule: a person is blocked for the plan when its first day <= the plan's day <= its last
//!   day. Each blockout is written as its UTC days, then moved, only where it meets the service, so that it covers the
//!   service exactly when that rule says so (`blockout_moments`).
//! - `/doing/blockoutDates/upcoming` returns only blockouts whose last day is after the moment of reading, comparing
//!   the day as its UTC midnight: from 00:00 UTC of the service's day (Saturday 18:00 in Chicago) a blockout that
//!   ends that day is no longer listed. A blockouts read made from then on is `truncated`, never `ok`.
//! - B1's admin site saves a plan's day as the UTC day of local noon, which is the day before for churches at UTC+12
//!   or more (New Zealand, Fiji, Tonga). For a church whose zone can be there (`far_east`), the times and blockouts
//!   reads are `truncated`.
//!
//! Answer words are matched exactly: `Accepted`, `Unconfirmed`, `Declined`; anything else is `unknown`.
use crate::capture::{
    Assignment, Blockout, Busy, BusyAnswer, Date, Event, Form, Group, Id, Label, LabelKey,
    MAX_ASSIGNMENTS, MAX_BLOCKOUTS, MAX_BUSY, MAX_EVENTS, MAX_FORMS, MAX_GROUPS, MAX_NAMES,
    MAX_POSITIONS, MAX_TEAM_MEMBERS, Name, Outcome, Position, ReadWord, Service, Status, System,
    SystemCapture, TeamMember, Time, ZoneName,
};
use crate::http::{Auth, Endpoint, Get, Http, Origin, QueryValue, ReadError, Reply, Segment};
use crate::keys::Key;
use crate::project::{
    BAD, Labelled, Row, capped, decoder, id_field, miss_error, object, optional_count, optional_id,
    optional_text, rows,
};
use crate::run::{Clock, Limits, Miss, Projected, Run};
use crate::zones::{LocalResult, ZoneOffsets};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

/// The only host B1 reads go to.
pub const HOST: &str = "api.churchapps.org";
/// B1 documents no rate limit: the shared defaults (4 a second, 40 a check, 60 s).
pub const LIMITS: Limits = crate::run::LIMITS;

pub const CHURCH: ReadWord = ReadWord::new("b1.church");
pub const PLANS: ReadWord = ReadWord::new("b1.plans");
/// Other plans around the service's day, for `busy`.
pub const PLANS_DAY: ReadWord = ReadWord::new("b1.plans_day");
pub const POSITIONS: ReadWord = ReadWord::new("b1.positions");
pub const ASSIGNMENTS: ReadWord = ReadWord::new("b1.assignments");
pub const GROUP_MEMBERS: ReadWord = ReadWord::new("b1.group_members");
pub const TIMES: ReadWord = ReadWord::new("b1.times");
pub const BLOCKOUTS: ReadWord = ReadWord::new("b1.blockouts");
pub const PEOPLE: ReadWord = ReadWord::new("b1.people");
pub const GROUPS: ReadWord = ReadWord::new("b1.groups");
pub const EVENTS: ReadWord = ReadWord::new("b1.events");
pub const FORMS: ReadWord = ReadWord::new("b1.forms");
/// In the page's closed list of B1 read words but never read: no cheap per-event attendance read exists, and
/// submission counts need a write scope. Not recorded either, so the page doesn't take
/// the events or forms that were read as unread.
pub const ATTENDANCE: ReadWord = ReadWord::new("b1.attendance");
pub const FORM_SUBMISSIONS: ReadWord = ReadWord::new("b1.form_submissions");
/// B1's closed list of read words, in the page's order.
pub const WORDS: &[ReadWord] = &[
    CHURCH,
    PLANS,
    PLANS_DAY,
    TIMES,
    POSITIONS,
    ASSIGNMENTS,
    GROUP_MEMBERS,
    BLOCKOUTS,
    GROUPS,
    EVENTS,
    ATTENDANCE,
    FORMS,
    FORM_SUBMISSIONS,
    PEOPLE,
];
/// A check's reads, in the order they are made.
pub const READS: &[ReadWord] = &[
    CHURCH,
    PLANS,
    POSITIONS,
    ASSIGNMENTS,
    GROUP_MEMBERS,
    TIMES,
    BLOCKOUTS,
    PLANS_DAY,
    PEOPLE,
    GROUPS,
    EVENTS,
    FORMS,
];
/// People asked about in one names read.
pub const NAMES_PER_READ: usize = 100;
/// Teams asked about in the one team members read; members of further teams aren't read (`truncated`).
pub const MAX_TEAMS: usize = 100;
pub const MAX_PLAN_CHOICES: usize = 100;
/// Other plans whose times are read for `busy`; people on more aren't all placed (`truncated`).
pub const MAX_OTHER_PLANS: usize = 50;
/// The service's times are one block when each starts within this of the earliest.
pub const BLOCK_MS: i64 = 6 * 3_600_000;
/// A plan time the window leaves out but this close to a kept one makes the times read `truncated`.
pub const NEAR_MS: i64 = 36 * 3_600_000;

/// Every GET this file can build. Nothing else can be asked of B1.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Read {
    /// `/membership/churches/<id>`.
    Church(Id),
    /// `/doing/plans/ids?ids=<ids>`: these plans (for whether each is shared with its volunteers, `prepared`).
    PlansByIds(Vec<Id>),
    /// `/doing/plans/<id>`.
    Plan(Id),
    /// `/doing/plans/overview?startDate=&endDate=`: every plan's positions and live (accepted or unconfirmed)
    /// assignments in the days, both inclusive.
    Overview { start: Date, end: Date },
    /// `/doing/positions/plan/<plan>`.
    Positions(Id),
    /// `/doing/assignments/plan/<plan>`.
    Assignments(Id),
    /// `/doing/times/plan/<plan>`.
    Times(Id),
    /// `/doing/times/plans?planIds=<ids>`: several plans' times.
    PlanTimes(Vec<Id>),
    /// `/doing/blockoutDates/upcoming`.
    Blockouts,
    /// `/membership/groupmembers?groupIds=<ids>`.
    TeamMembers(Vec<Id>),
    /// `/membership/people/names?ids=<ids>`.
    Names(Vec<Id>),
    /// `/membership/groups`.
    Groups,
    /// `/content/events/timeline`: upcoming events of the groups the key's own person belongs to (and repeating ones
    /// whatever their dates). It can't see other groups' events: an event on a group calendar the key's person isn't in
    /// is never returned, so an empty answer is all this route sees, not an event left out (seen live 2026-11-17: a
    /// one-meeting event on a group calendar came back as an empty list). Reading every group's events would need
    /// one read per group (`/content/events/group/<id>`), not made here.
    Events,
    /// `/membership/forms`.
    Forms,
    /// `/membership/churches/lookup?subDomain=<church>`: which church a B1 address (`<church>.b1.church`, the only way
    /// B1's own Settings page shows a church) belongs to, its id and name, or `{}` when none (B1's anonymous
    /// `getBySubDomain`). Read once, when a church connects (`connect`).
    Lookup(Id),
}
impl Endpoint for Read {
    fn origin(&self) -> Origin {
        Origin::Fixed(HOST)
    }
    fn segments(&self) -> Vec<Segment> {
        use Segment::Fixed as F;
        let id = |id: &Id| Segment::Id(id.clone());
        match self {
            Read::Church(church) => vec![F("membership"), F("churches"), id(church)],
            Read::PlansByIds(_) => vec![F("doing"), F("plans"), F("ids")],
            Read::Plan(plan) => vec![F("doing"), F("plans"), id(plan)],
            Read::Overview { .. } => vec![F("doing"), F("plans"), F("overview")],
            Read::Positions(plan) => vec![F("doing"), F("positions"), F("plan"), id(plan)],
            Read::Assignments(plan) => vec![F("doing"), F("assignments"), F("plan"), id(plan)],
            Read::Times(plan) => vec![F("doing"), F("times"), F("plan"), id(plan)],
            Read::PlanTimes(_) => vec![F("doing"), F("times"), F("plans")],
            Read::Blockouts => vec![F("doing"), F("blockoutDates"), F("upcoming")],
            Read::TeamMembers(_) => vec![F("membership"), F("groupmembers")],
            Read::Names(_) => vec![F("membership"), F("people"), F("names")],
            Read::Groups => vec![F("membership"), F("groups")],
            Read::Events => vec![F("content"), F("events"), F("timeline")],
            Read::Forms => vec![F("membership"), F("forms")],
            Read::Lookup(_) => vec![F("membership"), F("churches"), F("lookup")],
        }
    }
    fn query(&self) -> Vec<(&'static str, QueryValue)> {
        match self {
            Read::TeamMembers(teams) => vec![("groupIds", QueryValue::Ids(teams.clone()))],
            Read::Names(people) => vec![("ids", QueryValue::Ids(people.clone()))],
            Read::Overview { start, end } => vec![
                ("startDate", QueryValue::Day(*start)),
                ("endDate", QueryValue::Day(*end)),
            ],
            Read::PlanTimes(plans) => vec![("planIds", QueryValue::Ids(plans.clone()))],
            Read::PlansByIds(plans) => vec![("ids", QueryValue::Ids(plans.clone()))],
            Read::Lookup(church) => vec![("subDomain", QueryValue::Id(church.clone()))],
            _ => Vec::new(),
        }
    }
}

/// Words B1 uses as fixed route names beside an `/:id` route. Express matches routes without regard to case, so an
/// id that is one of these, in any case, would reach another route: such an id is refused before anything is sent (by
/// the builder, `path_id_ok`, and by the guard, `path_word_ok`). Derived for every path with an id slot:
/// - `/membership/churches/:id`: `all`, `search`, `lookup` (declared before `/:id`, an anonymous lookup), and the
///   write routes `deleteAbandoned`, `byIds`, `add`, `select`;
/// - `/doing/plans/:id`: `ids`, `types`, `presenter`, `overview`, `confirmationWorkflows`, `textRange`, `public`,
///   `signup`, and the write routes `autofill`, `notifyRange`, `copy`;
/// - `/doing/positions/plan/:id`, `/doing/assignments/plan/:id`: `ids`; `/doing/times/plan/:id`: none (its sibling
///   `/doing/times/plans` is another path);
/// - and, for safety, the other route words of the same controllers (`my`, `upcoming`, `all`, `accept`, `decline`,
///   `respond`, the people routes' `search`, `names`, `basic`, `list`, `recent`, `household`, `attendance`,
///   `demographics`, `directory`, and `timeline`).
const ROUTE_WORDS: &[&str] = &[
    "lookup",
    // The church routes' other words (all write routes, so no GET reaches them; refused all the same).
    "deleteabandoned",
    "byids",
    "add",
    "select",
    "ids",
    "overview",
    "presenter",
    "types",
    "public",
    "signup",
    "confirmationworkflows",
    "textrange",
    "my",
    "upcoming",
    "all",
    "plan",
    "plans",
    "monthcounts",
    "autofill",
    "notifyrange",
    "copy",
    "accept",
    "decline",
    "issuerequests",
    "respond",
    "search",
    "names",
    "basic",
    "list",
    "recent",
    "household",
    "attendance",
    "demographics",
    "directory",
    "timeline",
];
fn path_id_ok(id: &Id) -> bool {
    path_word_ok(id.as_str())
}
/// A path segment that may stand where an id goes: a checked id that isn't one of `ROUTE_WORDS`, in any case.
pub(crate) fn path_word_ok(text: &str) -> bool {
    Id::new(text).is_some()
        && !ROUTE_WORDS
            .iter()
            .any(|word| text.eq_ignore_ascii_case(word))
}
/// One of every read, for the guard's list of shapes (`shapes`). `kind` is exhaustive, and the tests check every kind
/// is here, so a read can't be added without the guard knowing its shape.
pub(crate) fn samples() -> Vec<Read> {
    let id = || Id::new("sample").expect("a checked id");
    let day = Date::parse("2000-01-01").expect("a day");
    vec![
        Read::Church(id()),
        Read::PlansByIds(vec![id()]),
        Read::Plan(id()),
        Read::Overview {
            start: day,
            end: day,
        },
        Read::Positions(id()),
        Read::Assignments(id()),
        Read::Times(id()),
        Read::PlanTimes(vec![id()]),
        Read::Blockouts,
        Read::TeamMembers(vec![id()]),
        Read::Names(vec![id()]),
        Read::Groups,
        Read::Events,
        Read::Forms,
        Read::Lookup(id()),
    ]
}
#[cfg(test)]
pub(crate) fn kind(read: &Read) -> usize {
    match read {
        Read::Church(_) => 0,
        Read::PlansByIds(_) => 1,
        Read::Plan(_) => 2,
        Read::Overview { .. } => 3,
        Read::Positions(_) => 4,
        Read::Assignments(_) => 5,
        Read::Times(_) => 6,
        Read::PlanTimes(_) => 7,
        Read::Blockouts => 8,
        Read::TeamMembers(_) => 9,
        Read::Names(_) => 10,
        Read::Groups => 11,
        Read::Events => 12,
        Read::Forms => 13,
        Read::Lookup(_) => 14,
    }
}
/// The shape of every read B1 may be sent (http.rs `allowed`).
pub(crate) fn shapes() -> Vec<crate::http::Shape> {
    samples().iter().map(crate::http::Shape::of).collect()
}

/// An optional reference that, when present, must be `expected` (a row of a plan's read naming another plan).
fn same_or_absent(row: &Row, key: &str, expected: &Id) -> Result<(), ReadError> {
    match optional_id(row, key)? {
        Some(id) if &id != expected => Err(BAD),
        _ => Ok(()),
    }
}
/// A day as B1 may write a `date` column (see the top of this file).
pub fn b1_day(text: &str) -> Option<Date> {
    if let Some(day) = Date::parse(text) {
        return Some(day);
    }
    match text.get(10..) {
        Some("T00:00:00Z" | "T00:00:00.000Z") => Date::parse(&text[..10]),
        _ => None,
    }
}
fn day_field(row: &Row, key: &str) -> Result<Date, ReadError> {
    row.get(key)
        .and_then(Value::as_str)
        .and_then(b1_day)
        .ok_or(BAD)
}
/// A time as B1 writes a `datetime` column: a true instant, `Z` or a numeric offset (see the top of this file).
pub fn b1_time(text: &str) -> Option<Time> {
    Time::parse(text)
}
/// The times that could be on the plan's day in some zone: local offsets run from UTC-12 to UTC+14, so from 14 hours
/// before the day's UTC midnight to 12 hours after the next one.
pub const SERVICE_WINDOW: (i64, i64) = (-14 * 3_600_000, 36 * 3_600_000);
const DAY_MS: i64 = 86_400_000;
fn midnight_ms(day: Date) -> i64 {
    day.days() * DAY_MS
}
fn optional_time(row: &Row, key: &str) -> Result<Option<Time>, ReadError> {
    match row.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => b1_time(s).map(Some).ok_or(BAD),
        Some(_) => Err(BAD),
    }
}
/// An answer word, matched exactly.
pub fn status(word: &str) -> Status {
    match word {
        "Accepted" => Status::Accepted,
        "Unconfirmed" => Status::Unconfirmed,
        "Declined" => Status::Declined,
        _ => Status::Unknown,
    }
}

struct ChurchRecord {
    name: Option<String>,
    zone: Option<ZoneName>,
}
/// `Church`: `id`, `name`, `timeZone`. Every church has a zone, but for many it is a backfilled `America/New_York` no
/// one chose, so the page must confirm it with the person once before relying on it. A time zone Ozzie can't read as an IANA name is left out and
/// the read is `truncated`.
fn project_church(value: &Value, church: &Id) -> Result<Projected<ChurchRecord>, ReadError> {
    let row = object(value)?;
    if &id_field(row, "id")? != church {
        return Err(BAD);
    }
    let name = optional_text(row, "name")?.map(str::to_owned);
    let zone_text = optional_text(row, "timeZone")?;
    let zone = zone_text.and_then(ZoneName::new);
    Ok((
        ChurchRecord {
            name,
            zone: zone.clone(),
        },
        zone_text.is_some() && zone.is_none(),
    ))
}

struct PlanRecord {
    day: Date,
    name: Option<String>,
    /// Whether the plan is shared with its volunteers yet (`plan_shared`).
    shared: Option<bool>,
}
/// Whether a plan is shared with its volunteers, from its `prepared` (B1's server reads the `bit(1)` column as a
/// boolean, a null one as false): false or null is shared, true is not yet (penciled in). No `prepared` field at all,
/// or anything else, can't be told (`None`).
fn plan_shared(row: &Row) -> Option<bool> {
    match row.get("prepared")? {
        Value::Null | Value::Bool(false) => Some(true),
        Value::Bool(true) => Some(false),
        _ => None,
    }
}
/// `Plan` (research 3.2): `id`, `name`, `serviceDate`.
fn project_plan(value: &Value, plan: &Id) -> Result<Projected<PlanRecord>, ReadError> {
    let row = object(value)?;
    if &id_field(row, "id")? != plan {
        return Err(BAD);
    }
    let day = day_field(row, "serviceDate")?;
    let name = optional_text(row, "name")?.map(str::to_owned);
    let shared = plan_shared(row);
    Ok((PlanRecord { day, name, shared }, false))
}

struct PositionsRead {
    list: Vec<(Position, Option<String>)>,
    cut: bool,
}
/// `Position` (research 3.2): `id`, `planId`, `name`, `count` (the wanted number; null stays null), `groupId` (the
/// team).
fn project_positions(value: &Value, plan: &Id) -> Result<Projected<PositionsRead>, ReadError> {
    let mut list = Vec::new();
    let mut seen = BTreeSet::new();
    for row in rows(value)? {
        let row = object(row)?;
        let id = id_field(row, "id")?;
        same_or_absent(row, "planId", plan)?;
        if !seen.insert(id.clone()) {
            return Err(BAD);
        }
        let position = Position {
            id,
            team_id: optional_id(row, "groupId")?,
            needed: optional_count(row, "count")?,
        };
        list.push((position, optional_text(row, "name")?.map(str::to_owned)));
    }
    let (list, cut) = capped(list, MAX_POSITIONS);
    Ok((PositionsRead { list, cut }, cut))
}

/// `Assignment` (research 3.2): `id`, `positionId`, `personId`, `status`, and `planId` from the join. A missing or
/// null status is `unknown`. An assignment to a position not in the plan's positions is refused, unless positions
/// were cut at the cap, when it is left out with them.
/// Whether the person was sent the request, from the assignment's `notified` (a datetime B1 sets when it notifies
/// them: B1Admin's notify, autofill, or the confirmation workflow). A time is `true`; null or empty is `false` (B1Admin
/// counts `!notified` as not notified); a missing field, or anything that isn't a time, is `None`.
fn asked(notified: Option<&Value>) -> Option<bool> {
    match notified? {
        Value::Null => Some(false),
        Value::String(text) if text.is_empty() => Some(false),
        Value::String(text) => Time::parse(text).map(|_| true),
        _ => None,
    }
}
fn project_assignments(
    value: &Value,
    plan: &Id,
    positions: &PositionsRead,
) -> Result<Projected<Vec<Assignment>>, ReadError> {
    let known: BTreeSet<&Id> = positions.list.iter().map(|(p, _)| &p.id).collect();
    let mut list = Vec::new();
    let mut seen = BTreeSet::new();
    let mut cut = false;
    for row in rows(value)? {
        let row = object(row)?;
        let id = id_field(row, "id")?;
        same_or_absent(row, "planId", plan)?;
        let position_id = id_field(row, "positionId")?;
        let person_id = id_field(row, "personId")?;
        let status = match row.get("status") {
            None | Some(Value::Null) => Status::Unknown,
            Some(Value::String(word)) => status(word),
            Some(_) => return Err(BAD),
        };
        let asked = asked(row.get("notified"));
        if !seen.insert(id.clone()) {
            return Err(BAD);
        }
        if !known.contains(&position_id) {
            if positions.cut {
                cut = true;
                continue;
            }
            return Err(BAD);
        }
        list.push(Assignment {
            id,
            position_id,
            person_id,
            status,
            asked,
        });
    }
    let (list, over) = capped(list, MAX_ASSIGNMENTS);
    Ok((list, cut || over))
}

/// `GroupMember` (research 4.3): `groupId`, `personId`; the embedded `person` and `group` are ignored. Every row must
/// be for a team asked about.
fn project_team_members(
    value: &Value,
    teams: &[Id],
) -> Result<Projected<Vec<TeamMember>>, ReadError> {
    let mut members = BTreeSet::new();
    for row in rows(value)? {
        let row = object(row)?;
        let team_id = id_field(row, "groupId")?;
        if !teams.contains(&team_id) {
            return Err(BAD);
        }
        members.insert(TeamMember {
            team_id,
            person_id: id_field(row, "personId")?,
        });
    }
    Ok(capped(members.into_iter().collect(), MAX_TEAM_MEMBERS))
}

/// One plan time as read: its start and end.
type Span = (Time, Option<Time>);
/// `Time`: `id`, `planId`, `startTime`, `endTime`. Every row is checked. The service is the plan's times that could be
/// on its `day` (`SERVICE_WINDOW`; a rehearsal days before isn't the service), when they form one block (each starts
/// within `BLOCK_MS` of the earliest): from the earliest start to the latest end, the end null when any has none. When
/// they don't, which is the service can't be told without the church's zone, so the service starts at the earliest
/// with no end and the read is `truncated`. No such time: no service. The service's `day` is always the plan's.
/// Every `Time` row of the plan, checked: start, and end when it has one (which must be after the start).
/// A plan's times as B1 types them (`serviceTimeType`, NOT NULL, default "service"; B1Admin offers `service`,
/// `rehearsal` and `other`): the service's own, and the rest. `cut` when a time was left out: one with no start (B1's
/// server tolerates them), or one of a type B1 doesn't name (not taken as the service). A time with no type, or an
/// empty one, is a service, as B1 reads it itself (its signup deadline takes `serviceTimeType || "service"`).
struct PlanTimes {
    service: Vec<Span>,
    other: Vec<Span>,
    cut: bool,
}
fn plan_times(value: &Value, plan: &Id) -> Result<PlanTimes, ReadError> {
    let mut times = PlanTimes {
        service: Vec::new(),
        other: Vec::new(),
        cut: false,
    };
    for row in rows(value)? {
        let row = object(row)?;
        id_field(row, "id")?;
        same_or_absent(row, "planId", plan)?;
        let Some(start) = optional_time(row, "startTime")? else {
            times.cut = true;
            continue;
        };
        let end = optional_time(row, "endTime")?;
        if end
            .as_ref()
            .is_some_and(|e| e.unix_millis() <= start.unix_millis())
        {
            return Err(BAD);
        }
        match optional_text(row, "serviceTimeType")? {
            None | Some("service") => times.service.push((start, end)),
            Some("rehearsal") | Some("other") => times.other.push((start, end)),
            Some(_) => {
                times.cut = true;
                times.other.push((start, end));
            }
        }
    }
    Ok(times)
}
/// The service from a plan's times: its service-typed times (`plan_times`), zoned or not. A plan with no
/// service-typed time falls back to every time, and the read is `truncated`.
fn project_times(
    value: &Value,
    plan: &Id,
    day: Date,
    zone: Option<(&ZoneName, &dyn ZoneOffsets)>,
) -> Result<Projected<Option<Service>>, ReadError> {
    let times = plan_times(value, plan)?;
    let (spans, fallback) = if times.service.is_empty() {
        let all: Vec<Span> = times.other.to_vec();
        let fallback = !all.is_empty();
        (all, fallback)
    } else {
        (times.service.clone(), false)
    };
    let (service, cut) = match zone {
        Some(zone) => project_service_zoned(&spans, plan, day, zone),
        None => project_service(&spans, plan, day),
    };
    Ok((service, cut || fallback || times.cut))
}
fn service_of(plan: &Id, day: Option<Date>, spans: &[Span]) -> Option<Service> {
    let starts_at = spans
        .iter()
        .map(|(s, _)| s)
        .min_by_key(|s| s.unix_millis())?
        .clone();
    let ends_at = if spans.iter().all(|(_, e)| e.is_some()) {
        spans
            .iter()
            .filter_map(|(_, e)| e.as_ref())
            .max_by_key(|e| e.unix_millis())
            .cloned()
    } else {
        None
    };
    Some(Service {
        id: plan.clone(),
        day,
        starts_at,
        ends_at,
        shared: None,
        times: start_times(spans),
    })
}
/// How many separate start times these are (`Service::times`): two times that start together count once.
fn start_times(spans: &[Span]) -> Option<u32> {
    let starts: std::collections::BTreeSet<i64> = spans.iter().map(|(s, _)| s.unix_millis()).collect();
    u32::try_from(starts.len().min(crate::capture::MAX_SERVICE_TIMES)).ok()
}
/// The plan's real local day, from the day B1 stores. B1's admin site saves a plan's day as the UTC date of local noon
/// on the real day (it sends noon in the browser's zone and keeps the date part in UTC). So the real day is whichever
/// of the stored day and the day after has its local noon, in the church's zone, on the stored date: the stored day
/// for every zone from UTC-12 to UTC+11 (Chicago, Honolulu, Kolkata, Sydney), the day after from UTC+12 on in summer
/// time and from UTC+13 always (Auckland in summer, Tonga, Kiritimati). `None` when neither is (a zone this Mac doesn't
/// know, the clocks-back weekend, or a plan saved some other way), and `None` when both are: on New Zealand's
/// clocks-forward weekend, noon on Saturday (NZST) and noon on Sunday (NZDT) are both on Saturday's UTC date, so the
/// real day can't be told.
pub fn real_day(stored: Date, zone: &ZoneName, zones: &dyn ZoneOffsets) -> Option<Date> {
    let noon_on = |day: Date| match zones.local_to_instant(zone, day, 12 * 3600) {
        LocalResult::Single(noon) => Date::from_days(noon.unix_millis().div_euclid(DAY_MS)),
        _ => None,
    };
    let mut days = [Some(stored), stored.next_day()]
        .into_iter()
        .flatten()
        .filter(|day| noon_on(*day) == Some(stored));
    match (days.next(), days.next()) {
        (Some(day), None) => Some(day),
        _ => None,
    }
}
/// With the church's zone: the service is the times that start on the plan's real local day (`real_day`), in the
/// church's own time, and its `day` is that day; a time on any other day is not part of it. When no time starts on
/// that day, or the real day can't be told, which time is the service can't be said: the zone-less rule
/// (`project_service`) picks one, the day is null and the read is `truncated`.
fn project_service_zoned(
    spans: &[Span],
    plan: &Id,
    day: Date,
    (zone, zones): (&ZoneName, &dyn ZoneOffsets),
) -> Projected<Option<Service>> {
    if spans.is_empty() {
        return (None, false);
    }
    if let Some(real) = real_day(day, zone, zones) {
        let on: Vec<Span> = spans
            .iter()
            .filter(|(start, _)| zones.local_day(zone, start) == Some(real))
            .cloned()
            .collect();
        if !on.is_empty() {
            return (service_of(plan, Some(real), &on), false);
        }
    }
    let (service, _) = project_service(spans, plan, day);
    (service, true)
}
/// Without a zone this Mac knows: the service's times by B1's stored day and the window rules below. It names no day
/// (`day` null): with no zone, B1's stored day can't be trusted to be the real one.
fn project_service(spans: &[Span], plan: &Id, day: Date) -> Projected<Option<Service>> {
    let mut candidates: Vec<Span> = Vec::new();
    let mut left_out: Vec<i64> = Vec::new();
    for (start, end) in spans {
        let from = midnight_ms(day);
        let at = start.unix_millis();
        if at >= from + SERVICE_WINDOW.0 && at < from + SERVICE_WINDOW.1 {
            candidates.push((start.clone(), end.clone()));
        } else {
            left_out.push(at);
        }
    }
    candidates.sort_by_key(|(s, _)| s.unix_millis());
    let Some((first, _)) = candidates.first().cloned() else {
        return (None, false);
    };
    let one_block = candidates
        .iter()
        .all(|(s, _)| s.unix_millis() - first.unix_millis() <= BLOCK_MS);
    // A time left out by the window but near the ones kept may be part of the service in the church's own zone (east
    // of UTC, a Saturday evening time on a Sunday plan): the read can't say it isn't.
    let near_left_out = left_out.iter().any(|at| {
        candidates
            .iter()
            .any(|(s, _)| (s.unix_millis() - at).abs() <= NEAR_MS)
    });
    let ends_at = if one_block && candidates.iter().all(|(_, e)| e.is_some()) {
        candidates
            .iter()
            .filter_map(|(_, e)| e.as_ref())
            .max_by_key(|e| e.unix_millis())
            .cloned()
    } else {
        None
    };
    let times = start_times(&candidates);
    (
        Some(Service {
            id: plan.clone(),
            day: None,
            starts_at: first,
            ends_at,
            shared: None,
            times,
        }),
        !one_block || near_left_out,
    )
}

/// Zones whose offset can be UTC+12 or more, where B1's admin site saves a plan's day as the day before.
pub fn far_east(zone: Option<&ZoneName>) -> bool {
    const ZONES: &[&str] = &[
        "Pacific/Auckland",
        "Pacific/Chatham",
        "Pacific/Fiji",
        "Pacific/Tongatapu",
        "Pacific/Apia",
        "Pacific/Kiritimati",
        "Pacific/Fakaofo",
        "Pacific/Kanton",
        "Pacific/Enderbury",
        "Pacific/Tarawa",
        "Pacific/Majuro",
        "Pacific/Kwajalein",
        "Pacific/Funafuti",
        "Pacific/Wake",
        "Pacific/Wallis",
        "Pacific/Nauru",
        "Pacific/Norfolk",
        "Asia/Kamchatka",
        "Asia/Anadyr",
        "Antarctica/McMurdo",
        "Antarctica/South_Pole",
        "NZ",
        "NZ-CHAT",
        "Kwajalein",
        "Etc/GMT-12",
        "Etc/GMT-13",
        "Etc/GMT-14",
    ];
    zone.is_some_and(|z| ZONES.contains(&z.as_str()))
}

/// One blockout's moments for `service` on the plan's `day` (see the top of this file): its UTC days, from midnight
/// on its first day to midnight after its last; then, if it includes the plan's day, widened to cover the service, and
/// if it doesn't, cut back so it doesn't meet the service.
pub fn blockout_moments(
    first: Date,
    last: Date,
    day: Date,
    service: &Service,
) -> Option<(Time, Time)> {
    let mut start = midnight_ms(first);
    let mut end = midnight_ms(last) + DAY_MS;
    let s_start = service.starts_at.unix_millis();
    // A service with no end is taken as a moment long.
    let s_end = service
        .ends_at
        .as_ref()
        .map_or(s_start + 1000, Time::unix_millis);
    if first <= day && day <= last {
        start = start.min(s_start);
        end = end.max(s_end);
    } else if last < day && end > s_start {
        end = s_start;
    } else if first > day && start < s_end {
        start = s_end;
    }
    if end <= start {
        // A blockout wholly inside the service's span but not on its day: kept just after the service.
        start = s_end;
        end = s_end + 1000;
    }
    Some((Time::from_unix_millis(start)?, Time::from_unix_millis(end)?))
}

/// `BlockoutDate`: `personId`, `startDate`, `endDate`, both days, inclusive. Kept only for `people`, as moments for
/// the service (`blockout_moments`). `cut` says the list itself may be missing some (see the top of this file).
fn project_blockouts(
    value: &Value,
    people: &BTreeSet<Id>,
    day: Date,
    service: &Service,
    cut: bool,
) -> Result<Projected<Vec<Blockout>>, ReadError> {
    let mut list = Vec::new();
    for row in rows(value)? {
        let row = object(row)?;
        let person_id = id_field(row, "personId")?;
        let (first, last) = (day_field(row, "startDate")?, day_field(row, "endDate")?);
        if last < first {
            return Err(BAD);
        }
        if !people.contains(&person_id) {
            continue;
        }
        let (starts_at, ends_at) = blockout_moments(first, last, day, service).ok_or(BAD)?;
        list.push(Blockout {
            person_id,
            starts_at,
            ends_at,
        });
    }
    let (list, over) = capped(list, MAX_BLOCKOUTS);
    Ok((list, over || cut))
}

/// With the church's zone: each blockout from local midnight on its first day to local midnight after its last, in
/// the church's own time. A midnight the zone skips or repeats is never guessed: that blockout is left out and the read
/// is `truncated`. Kept only for `people`; `cut` says the list itself may be missing some.
fn project_blockouts_zoned(
    value: &Value,
    people: &BTreeSet<Id>,
    (zone, zones): (&ZoneName, &dyn ZoneOffsets),
    cut: bool,
) -> Result<Projected<Vec<Blockout>>, ReadError> {
    let mut list = Vec::new();
    let mut left_out = false;
    for row in rows(value)? {
        let row = object(row)?;
        let person_id = id_field(row, "personId")?;
        let (first, last) = (day_field(row, "startDate")?, day_field(row, "endDate")?);
        if last < first {
            return Err(BAD);
        }
        if !people.contains(&person_id) {
            continue;
        }
        let after = last.next_day().ok_or(BAD)?;
        match (
            zones.local_midnight(zone, first),
            zones.local_midnight(zone, after),
        ) {
            (LocalResult::Single(starts_at), LocalResult::Single(ends_at)) => list.push(Blockout {
                person_id,
                starts_at,
                ends_at,
            }),
            _ => left_out = true,
        }
    }
    let (list, over) = capped(list, MAX_BLOCKOUTS);
    Ok((list, over || cut || left_out))
}

/// One live assignment on another plan, from the overview: (plan, person).
type OtherPlan = (Id, Id, BusyAnswer);
/// `/doing/plans/overview` rows: `planId`, `serviceDate`, `personId` (null for a position nobody holds), `status`
/// (only Accepted or Unconfirmed reach this route). Kept: rows for another plan than `plan` naming one of `people`,
/// with their answer; any other status (Declined, none, a word never seen) isn't busy and is left out.
fn project_overview(
    value: &Value,
    plan: &Id,
    people: &BTreeSet<Id>,
) -> Result<Vec<OtherPlan>, ReadError> {
    let mut out = BTreeSet::new();
    for row in rows(value)? {
        let row = object(row)?;
        let other = id_field(row, "planId")?;
        day_field(row, "serviceDate")?;
        let person = optional_id(row, "personId")?;
        let answer = match optional_text(row, "status")? {
            Some("Accepted") => Some(BusyAnswer::Accepted),
            Some("Unconfirmed") => Some(BusyAnswer::Unconfirmed),
            _ => None,
        };
        if let (Some(person), Some(answer)) = (person, answer)
            && &other != plan
            && people.contains(&person)
        {
            out.insert((other, person, answer));
        }
    }
    Ok(out.into_iter().collect())
}
/// `/doing/plans/ids` rows: `id` (one asked about) and `prepared`. Gives whether each plan answered is shared with
/// its volunteers (`plan_shared`); a plan the answer leaves out isn't in it.
fn project_shared(value: &Value, asked: &[Id]) -> Result<BTreeMap<Id, Option<bool>>, ReadError> {
    let mut shared = BTreeMap::new();
    for row in rows(value)? {
        let row = object(row)?;
        let id = id_field(row, "id")?;
        if !asked.contains(&id) {
            return Err(BAD);
        }
        shared.insert(id, plan_shared(row));
    }
    Ok(shared)
}
/// `/doing/times/plans` rows: `id`, `planId` (one asked about), `startTime`, `endTime`, by plan.
/// A time with no start (B1's server tolerates one) is left out, and the answer says one was (`true`).
fn project_plan_times(
    value: &Value,
    asked: &[Id],
) -> Result<(BTreeMap<Id, Vec<Span>>, bool), ReadError> {
    let mut out: BTreeMap<Id, Vec<Span>> = BTreeMap::new();
    let mut left_out = false;
    for row in rows(value)? {
        let row = object(row)?;
        id_field(row, "id")?;
        let plan = id_field(row, "planId")?;
        if !asked.contains(&plan) {
            return Err(BAD);
        }
        let Some(start) = optional_time(row, "startTime")? else {
            left_out = true;
            continue;
        };
        let end = optional_time(row, "endTime")?;
        if end
            .as_ref()
            .is_some_and(|e| e.unix_millis() <= start.unix_millis())
        {
            return Err(BAD);
        }
        out.entry(plan).or_default().push((start, end));
    }
    Ok((out, left_out))
}
/// `busy`: each person's other live assignments the day before to the day after the service's `day`, on plans shared
/// with their volunteers, placed at their plan's times. Recorded as `b1.plans_day`, one read of up to three requests. A plan whose times can't all be placed
/// (none, or one with no end), or more other plans than `MAX_OTHER_PLANS`, makes it `truncated`; a failure keeps
/// nothing (`busy` null).
fn read_busy(
    run: &mut Run<'_>,
    get: &dyn Fn(Read) -> Get,
    decode: &dyn Fn(&Reply) -> Result<Value, ReadError>,
    plan: &Id,
    day: Date,
    people: &BTreeSet<Id>,
) -> Option<Vec<Busy>> {
    let (Some(start), Some(end)) = (
        Date::from_days(day.days() - 1),
        Date::from_days(day.days() + 1),
    ) else {
        run.skip(PLANS_DAY);
        return None;
    };
    let others = run
        .send(get(Read::Overview { start, end }), decode)
        .and_then(|v| project_overview(&v, plan, people).map_err(Miss::Failed));
    let others = match others {
        Ok(others) => others,
        Err(miss) => {
            run.record(PLANS_DAY, miss.outcome());
            return None;
        }
    };
    if others.is_empty() {
        run.record(PLANS_DAY, Outcome::Ok);
        return Some(Vec::new());
    }
    let plans: Vec<Id> = others
        .iter()
        .map(|(p, _, _)| p.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let (asked, mut cut) = capped(plans, MAX_OTHER_PLANS);
    // Plans not yet shared with their volunteers make nobody busy. Whether they are, B1 gives per plan; when it can't
    // be read, every plan is kept and `busy` is `truncated`.
    let prepared = run
        .send(get(Read::PlansByIds(asked.clone())), decode)
        .and_then(|v| project_shared(&v, &asked).map_err(Miss::Failed));
    let asked: Vec<Id> = match prepared {
        // A plan not yet shared makes nobody busy; one whose answer can't tell is kept, and `busy` says so.
        Ok(shared) => asked
            .into_iter()
            .filter(|p| match shared.get(p).copied().flatten() {
                Some(shared) => shared,
                None => {
                    cut = true;
                    true
                }
            })
            .collect(),
        Err(Miss::Failed(error @ (ReadError::KeyRefused | ReadError::RateLimited(_)))) => {
            run.record(PLANS_DAY, error.into());
            return None;
        }
        Err(_) => {
            cut = true;
            asked
        }
    };
    if asked.is_empty() {
        run.record(
            PLANS_DAY,
            if cut { Outcome::Truncated } else { Outcome::Ok },
        );
        return Some(Vec::new());
    }
    let times = run
        .send(get(Read::PlanTimes(asked.clone())), decode)
        .and_then(|v| project_plan_times(&v, &asked).map_err(Miss::Failed));
    let times = match times {
        Ok((times, left_out)) => {
            cut |= left_out;
            times
        }
        Err(miss) => {
            run.record(PLANS_DAY, miss.outcome());
            return None;
        }
    };
    let mut busy = BTreeSet::new();
    for (other, person, answer) in &others {
        if !asked.contains(other) {
            continue;
        }
        let spans = times.get(other).map(Vec::as_slice).unwrap_or_default();
        if spans.is_empty() {
            cut = true;
        }
        for (starts_at, ends_at) in spans {
            match ends_at {
                Some(ends_at) => {
                    busy.insert(Busy {
                        person_id: person.clone(),
                        starts_at: starts_at.clone(),
                        ends_at: ends_at.clone(),
                        answer: *answer,
                    });
                }
                None => cut = true,
            }
        }
    }
    let (busy, over) = capped(busy.into_iter().collect(), MAX_BUSY);
    let outcome = if cut || over {
        Outcome::Truncated
    } else {
        Outcome::Ok
    };
    run.record(PLANS_DAY, outcome);
    Some(busy)
}

/// `/people/names` rows: `id`, and `name` with `display`, `first`, `last`. Every row must be someone
/// asked about, once. The name is `display`, or `first` and `last` when there is no display name. Gives the names and
/// everyone the answer had a row for.
/// The names found, and everyone the answer had a row for.
type NamesRead = (Vec<(Id, Name)>, Vec<Id>);
fn project_names(value: &Value, asked: &[Id]) -> Result<NamesRead, ReadError> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for row in rows(value)? {
        let row = object(row)?;
        let id = id_field(row, "id")?;
        if !asked.contains(&id) || !seen.insert(id.clone()) {
            return Err(BAD);
        }
        let text = match row.get("name") {
            None | Some(Value::Null) => None,
            Some(Value::Object(name)) => match optional_text(name, "display")? {
                Some(display) => Some(display.to_owned()),
                None => {
                    let parts = [optional_text(name, "first")?, optional_text(name, "last")?];
                    let joined = parts.into_iter().flatten().collect::<Vec<_>>().join(" ");
                    (!joined.is_empty()).then_some(joined)
                }
            },
            Some(_) => return Err(BAD),
        };
        if let Some(name) = text.as_deref().and_then(Name::new) {
            out.push((id, name));
        }
    }
    Ok((out, seen.into_iter().collect()))
}

/// `Group`: `id`, `name`, `memberCount` (null when B1 doesn't give it).
fn project_groups(value: &Value) -> Result<Projected<Labelled<Group>>, ReadError> {
    let mut list = Vec::new();
    let mut seen = BTreeSet::new();
    for row in rows(value)? {
        let row = object(row)?;
        let id = id_field(row, "id")?;
        if !seen.insert(id.clone()) {
            return Err(BAD);
        }
        let group = Group {
            id,
            members: optional_count(row, "memberCount")?,
        };
        list.push((group, optional_text(row, "name")?.map(str::to_owned)));
    }
    Ok(capped(list, MAX_GROUPS))
}

/// `Event`: `id`, `title`, `start`, `end`, `recurrenceRule`. B1 has no per-event attendance
/// on this read, so it is null. A repeating event (a repeat rule, which an event made through B1's recurring form keeps
/// even when it meets once) is left out: Ozzie takes only the one-off events B1 returns, never B1's own expansion of a
/// rule (times 3.2). That is by design and said plainly (facts.ts `cannotSee`), so it leaves the read `ok`; only more
/// events than MAX_EVENTS make it `truncated` (round 3: a church with a weekly event had every check marked partial).
fn project_events(value: &Value) -> Result<Projected<Labelled<Event>>, ReadError> {
    let mut list = Vec::new();
    let mut seen = BTreeSet::new();
    for row in rows(value)? {
        let row = object(row)?;
        let id = id_field(row, "id")?;
        if !seen.insert(id.clone()) {
            return Err(BAD);
        }
        if optional_text(row, "recurrenceRule")?.is_some() {
            continue;
        }
        let starts_at = optional_time(row, "start")?.ok_or(BAD)?;
        let ends_at = optional_time(row, "end")?;
        if ends_at
            .as_ref()
            .is_some_and(|e| e.unix_millis() < starts_at.unix_millis())
        {
            return Err(BAD);
        }
        let event = Event {
            id,
            starts_at,
            ends_at,
            attendance: None,
        };
        list.push((event, optional_text(row, "title")?.map(str::to_owned)));
    }
    let (list, cut) = capped(list, MAX_EVENTS);
    // Repeating events left out are no read cut short (above).
    Ok((list, cut))
}

/// `Form`: `id`, `name`. Submission counts are never read (they need a write scope).
fn project_forms(value: &Value) -> Result<Projected<Labelled<Form>>, ReadError> {
    let mut list = Vec::new();
    let mut seen = BTreeSet::new();
    for row in rows(value)? {
        let row = object(row)?;
        let id = id_field(row, "id")?;
        if !seen.insert(id.clone()) {
            return Err(BAD);
        }
        let form = Form {
            id,
            submissions: None,
        };
        list.push((form, optional_text(row, "name")?.map(str::to_owned)));
    }
    Ok(capped(list, MAX_FORMS))
}

/// Reads one Sunday's plan from B1 for `church` with `key`: the reads at the top of this file, paced and limited by
/// run.rs, each recorded with its outcome. The capture has passed `SystemCapture::valid`. An error only when nothing
/// can be read at all: the key isn't a B1 key, or an id can't be a B1 plan or church.
///
/// `zone` is the church's zone as the person confirmed it in Ozzie, when they have: it is used over B1's own.
pub fn check(
    http: &dyn Http,
    clock: &dyn Clock,
    zones: &dyn ZoneOffsets,
    key: &Key,
    church: &Id,
    plan: &Id,
    zone: Option<&ZoneName>,
) -> Result<SystemCapture, ReadError> {
    check_with(http, clock, zones, key, church, plan, zone, LIMITS)
}
#[allow(clippy::too_many_arguments)]
pub(crate) fn check_with(
    http: &dyn Http,
    clock: &dyn Clock,
    zones: &dyn ZoneOffsets,
    key: &Key,
    church: &Id,
    plan: &Id,
    supplied_zone: Option<&ZoneName>,
    limits: Limits,
) -> Result<SystemCapture, ReadError> {
    if key.system() != System::B1 {
        return Err(ReadError::KeyRefused);
    }
    if !path_id_ok(church) || !path_id_ok(plan) {
        return Err(ReadError::NotFound);
    }
    // A supplied zone this Mac's zone data doesn't know (a name in the wrong case: CoreFoundation reads names exactly)
    // can't place anything, so the check isn't made with it, and nothing is sent.
    if supplied_zone.is_some_and(|zone| !crate::zones::known(zones, zone, clock)) {
        return Err(ReadError::UnknownZone);
    }
    let auth = Auth::Bearer(key.clone());
    let get = |read: Read| Get::new(&read, auth.clone());
    let key_gate = decoder(ReadError::KeyRefused);
    let gated = decoder(ReadError::Refused);
    let mut run = Run::new(http, clock, limits);
    let mut capture = SystemCapture::empty(System::B1, church.clone(), run.started_at());

    // The church: its name and zone, and the proof that the key opens it.
    if let Some(record) = run.read(CHURCH, get(Read::Church(church.clone())), &key_gate, |v| {
        project_church(v, church)
    }) {
        capture.church.time_zone = record.zone;
        if let Some(name) = record.name {
            capture.label(LabelKey::Church, &name);
        }
    }
    // A zone the caller supplies, the one the person confirmed in Ozzie, overrides B1's own: B1's is often missing (a
    // new church has none) or a default B1 filled in (`America/New_York`). It is then used for everything that
    // depends on the zone below, and is the capture's zone. With neither, nothing is guessed: the zone-free rules run.
    if let Some(zone) = supplied_zone {
        capture.church.time_zone = Some(zone.clone());
    }
    let plan_record = run.read(PLANS, get(Read::Plan(plan.clone())), &gated, |v| {
        project_plan(v, plan)
    });
    let positions = run.read(POSITIONS, get(Read::Positions(plan.clone())), &gated, |v| {
        project_positions(v, plan)
    });
    let assignments = match &positions {
        Some(positions) => run.read(
            ASSIGNMENTS,
            get(Read::Assignments(plan.clone())),
            &gated,
            |v| project_assignments(v, plan, positions),
        ),
        None => {
            run.skip(ASSIGNMENTS);
            None
        }
    };
    let teams: Vec<Id> = positions
        .iter()
        .flat_map(|p| p.list.iter().filter_map(|(p, _)| p.team_id.clone()))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    // Teams whose whole roster was read: their size is the roster's (see where groups go into the capture).
    let mut rostered: BTreeSet<Id> = BTreeSet::new();
    let team_members = if teams.is_empty() {
        // No role has a team: nothing to read, and nothing missing.
        if positions.is_some() {
            run.record(GROUP_MEMBERS, Outcome::Ok);
            Some(Vec::new())
        } else {
            run.skip(GROUP_MEMBERS);
            None
        }
    } else {
        let (asked, cut) = capped(teams, MAX_TEAMS);
        run.read(
            GROUP_MEMBERS,
            get(Read::TeamMembers(asked.clone())),
            &gated,
            |v| {
                project_team_members(v, &asked).map(|(members, over)| {
                    if !(cut || over) {
                        rostered = asked.iter().cloned().collect();
                    }
                    (members, cut || over)
                })
            },
        )
    };
    // A plan's day may be the day before for churches at UTC+12 or more: their times and blockouts can't be placed.
    // B1's day is sent only when the church's zone is one this Mac knows (otherwise the page says "your service").
    //
    // With a zone this Mac knows, none of that is needed: times and blockout days are placed in the church's own local
    // time (`project_service_zoned`, `project_blockouts_zoned`).
    let zone_name = capture.church.time_zone.clone();
    let zone: Option<(&ZoneName, &dyn ZoneOffsets)> = zone_name
        .as_ref()
        .filter(|name| {
            zones
                .offset_seconds(name, clock.unix_millis().div_euclid(1000))
                .is_some()
        })
        .map(|name| (name, zones));
    // B1's own zone that this Mac doesn't know is never the capture's zone: nothing was placed with it, so the page
    // mustn't name days with it, and the check runs as with no zone (no day). Its name still says when B1's day may be
    // early (`far_east`): that only marks the times and blockouts as not whole, it places nothing.
    let shifted = zone.is_none() && far_east(capture.church.time_zone.as_ref());
    if zone.is_none() {
        capture.church.time_zone = None;
    }
    let mut ambiguous = false;
    let service = match &plan_record {
        Some(record) => run
            .read(TIMES, get(Read::Times(plan.clone())), &gated, |v| {
                let read = project_times(v, plan, record.day, zone);
                read.map(|(service, cut)| {
                    ambiguous = cut;
                    (service, cut || shifted)
                })
            })
            .flatten(),
        None => {
            run.skip(TIMES);
            None
        }
    };
    let people: BTreeSet<Id> = assignments
        .iter()
        .flatten()
        .map(|a| a.person_id.clone())
        .chain(team_members.iter().flatten().map(|m| m.person_id.clone()))
        .collect();
    let placed = service.as_ref().zip(plan_record.as_ref().map(|r| r.day));
    let blockouts = match placed {
        Some((service, day)) => run.read(BLOCKOUTS, get(Read::Blockouts), &gated, |v| {
            // From 00:00 UTC of the plan's day, B1 no longer lists a blockout ending that day (top of this file). The
            // clock is read after the answer, so the answer can't be newer than the moment compared.
            // The day that matters is the service's own local day when it is known.
            let late = clock.unix_millis() >= midnight_ms(service.day.unwrap_or(day));
            match zone {
                Some(zone) => project_blockouts_zoned(v, &people, zone, late || ambiguous),
                None => project_blockouts(v, &people, day, service, late || ambiguous || shifted),
            }
        }),
        None => {
            run.skip(BLOCKOUTS);
            None
        }
    };
    // Everyone the capture is about is known once assignments and team members are both read.
    let people_known = assignments.is_some() && team_members.is_some();
    let busy = match &plan_record {
        Some(record) if !people.is_empty() => {
            read_busy(&mut run, &get, &gated, plan, record.day, &people)
        }
        Some(_) if people_known => {
            run.record(PLANS_DAY, Outcome::Ok);
            Some(Vec::new())
        }
        _ => {
            run.skip(PLANS_DAY);
            None
        }
    };
    let names = if people.is_empty() && people_known {
        run.record(PEOPLE, Outcome::Ok);
        BTreeMap::new()
    } else {
        read_names(&mut run, &get, &gated, &people)
    };
    let groups = run.read(GROUPS, get(Read::Groups), &gated, project_groups);
    let events = run.read(EVENTS, get(Read::Events), &gated, project_events);
    // With a read-only key B1 lists only the forms the key's maker has a permission on (every form needs Forms Admin,
    // which no read scope carries), and nothing in the answer says which list it is: never `ok`.
    let forms = run.read(FORMS, get(Read::Forms), &gated, |v| {
        project_forms(v).map(|(list, _)| (list, true))
    });

    // What was read, into the capture.
    if let Some(positions) = positions {
        for (position, name) in positions.list {
            if let Some(name) = name {
                capture.label(LabelKey::Position(position.id.clone()), &name);
            }
            capture.positions.push(position);
        }
    }
    capture.assignments = assignments.unwrap_or_default();
    capture.team_members = team_members.unwrap_or_default();
    if service.is_some()
        && let Some(name) = plan_record.as_ref().and_then(|r| r.name.as_deref())
    {
        capture.label(LabelKey::Service, name);
    }
    capture.service = service.map(|mut service| {
        service.shared = plan_record.as_ref().and_then(|r| r.shared);
        service
    });
    capture.blockouts = blockouts;
    capture.busy = busy;
    capture.names = names;
    let teams: BTreeSet<Id> = capture
        .positions
        .iter()
        .filter_map(|p| p.team_id.clone())
        .collect();
    for (mut group, name) in groups.unwrap_or_default() {
        // A team's size is its roster when the whole roster was read: B1's `memberCount` counts every member row,
        // people since removed included, while the roster leaves them out. (A key whose maker can't view group
        // members, but is in every team, also gets a roster without children under 13: still what the key can see.)
        if rostered.contains(&group.id) {
            let size = capture
                .team_members
                .iter()
                .filter(|m| m.team_id == group.id)
                .map(|m| &m.person_id)
                .collect::<BTreeSet<_>>()
                .len();
            group.members = Some(size as u32);
        }
        if let Some(name) = name {
            if teams.contains(&group.id) {
                capture.label(LabelKey::Team(group.id.clone()), &name);
            }
            capture.label(LabelKey::Group(group.id.clone()), &name);
        }
        capture.groups.push(group);
    }
    for (event, title) in events.unwrap_or_default() {
        if let Some(title) = title {
            capture.label(LabelKey::Event(event.id.clone()), &title);
        }
        capture.events.push(event);
    }
    for (form, name) in forms.unwrap_or_default() {
        if let Some(name) = name {
            capture.label(LabelKey::Form(form.id.clone()), &name);
        }
        capture.forms.push(form);
    }
    let (reads, completed_at) = run.finish();
    capture.reads = reads;
    capture.completed_at = completed_at;
    capture.valid().map_err(|_| ReadError::InvalidResponse)?;
    Ok(capture)
}

/// The names of `people`, `NAMES_PER_READ` at a time, recorded as one read. Any part that fails leaves no names; a
/// run that stops part way keeps what it read and is `truncated`.
fn read_names(
    run: &mut Run<'_>,
    get: &dyn Fn(Read) -> Get,
    decode: &dyn Fn(&Reply) -> Result<Value, ReadError>,
    people: &BTreeSet<Id>,
) -> BTreeMap<Id, Name> {
    let mut names = BTreeMap::new();
    if people.is_empty() {
        run.skip(PEOPLE);
        return names;
    }
    let people: Vec<Id> = people.iter().cloned().collect();
    let mut outcome = crate::capture::Outcome::Ok;
    let mut returned = BTreeSet::new();
    for chunk in people.chunks(NAMES_PER_READ) {
        let result = run
            .send(get(Read::Names(chunk.to_vec())), decode)
            .and_then(|v| project_names(&v, chunk).map_err(Miss::Failed));
        match result {
            Ok((found, rows)) => {
                names.extend(found);
                returned.extend(rows);
            }
            Err(Miss::NotSent(not_sent)) if names.is_empty() => {
                outcome = not_sent;
                break;
            }
            Err(Miss::NotSent(_)) => {
                outcome = crate::capture::Outcome::Truncated;
                break;
            }
            Err(Miss::Failed(error)) => {
                names.clear();
                outcome = error.into();
                break;
            }
        }
    }
    // Someone asked about whom B1 didn't return: the names are partial.
    if outcome == Outcome::Ok && people.iter().any(|p| !returned.contains(p)) {
        outcome = Outcome::Truncated;
    }
    if names.len() > MAX_NAMES {
        names = names.into_iter().take(MAX_NAMES).collect();
        outcome = crate::capture::Outcome::Truncated;
    }
    run.record(PEOPLE, outcome);
    names
}

pub use crate::capture::ChurchChoice;
/// Checks `key` against the church it is saved for, with the church's own record (`/membership/churches/<church>`,
/// the read every check starts with, proven live): ok when the record is this church's, `key-refused` on a 401 or
/// 403 (B1 refuses another church's record, and a bad key, that way), `invalid-response` for any other answer.
pub fn verify_key(
    http: &dyn Http,
    clock: &dyn Clock,
    key: &Key,
    church: &Id,
) -> Result<ChurchChoice, ReadError> {
    if key.system() != System::B1 {
        return Err(ReadError::KeyRefused);
    }
    if !path_id_ok(church) {
        return Err(ReadError::NotFound);
    }
    let mut run = Run::new(http, clock, LIMITS);
    let value = run
        .send(
            Get::new(&Read::Church(church.clone()), Auth::Bearer(key.clone())),
            &decoder(ReadError::KeyRefused),
        )
        .map_err(miss_error)?;
    let (record, _) = project_church(&value, church)?;
    Ok(ChurchChoice {
        id: church.clone(),
        name: record.name.as_deref().and_then(Label::new),
    })
}

/// The church a B1 address names, from the lookup's answer: `{id, name, subDomain, ...}`, or `{}` when B1 has no
/// church or church website at that address (`not-found`). The id must be one a church read can be sent for.
fn project_lookup(value: &Value) -> Result<(Id, Option<String>), ReadError> {
    let row = object(value)?;
    if !row.contains_key("id") {
        return Err(ReadError::NotFound);
    }
    let id = id_field(row, "id")?;
    if !path_id_ok(&id) {
        return Err(BAD);
    }
    Ok((id, optional_text(row, "name")?.map(str::to_owned)))
}

/// Connects a church by its B1 address and a key: which church `address` (the part before `.b1.church`, checked by
/// `crate::church_address`) is, then that church's own record with `key`, as `verify_key` reads it. `not-found` when
/// B1 has no church at that address; `key-refused` when the key doesn't open that church (a bad key, or another
/// church's: B1 answers both with 401).
///
/// The lookup is one of B1's anonymous routes, but the guard (http.rs `allowed`) lets a B1 read out only with its one
/// auth header, so it carries the key like every other read: to the same host, `api.churchapps.org`.
pub fn connect(
    http: &dyn Http,
    clock: &dyn Clock,
    key: &Key,
    address: &Id,
) -> Result<ChurchChoice, ReadError> {
    if key.system() != System::B1 {
        return Err(ReadError::KeyRefused);
    }
    let auth = Auth::Bearer(key.clone());
    let mut run = Run::new(http, clock, LIMITS);
    let value = run
        .send(
            Get::new(&Read::Lookup(address.clone()), auth.clone()),
            &decoder(ReadError::Refused),
        )
        .map_err(miss_error)?;
    let (church, looked_up) = project_lookup(&value)?;
    let value = run
        .send(
            Get::new(&Read::Church(church.clone()), auth),
            &decoder(ReadError::KeyRefused),
        )
        .map_err(miss_error)?;
    let (record, _) = project_church(&value, &church)?;
    Ok(ChurchChoice {
        name: record.name.or(looked_up).as_deref().and_then(Label::new),
        id: church,
    })
}

/// A plan to choose for a check.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct PlanChoice {
    pub id: Id,
    pub service_date: Date,
    pub name: Option<Label>,
    /// Whether B1 has shared the plan with its volunteers (`prepared` false); `false` while it is penciled in
    /// (`prepared` true: B1 keeps it from members until it is published); `None` when that couldn't be read.
    pub shared: Option<bool>,
}
/// Days of plans the picker offers, from yesterday.
pub const PICKER_DAYS: i64 = 56;
/// The church's plans from yesterday (UTC; a day's slack because the church's own zone isn't known) for
/// `PICKER_DAYS`, soonest first, at most `MAX_PLAN_CHOICES`, each saying whether it is shared with its volunteers.
///
/// Read by date, not as every plan the church ever made (with their notes): `/doing/plans/overview` for the days (one
/// row a position, so a plan with no positions isn't listed; there is nothing to check on one), then whether each is
/// shared (`/doing/plans/ids`). The church read comes first, so a bad key is `key-refused` and an empty list after it
/// is a real empty list (B1 answers a bad key's plan read with 200 `[]`, research 2.3).
pub fn plans(
    http: &dyn Http,
    clock: &dyn Clock,
    key: &Key,
    church: &Id,
) -> Result<Vec<PlanChoice>, ReadError> {
    if key.system() != System::B1 {
        return Err(ReadError::KeyRefused);
    }
    if !path_id_ok(church) {
        return Err(ReadError::NotFound);
    }
    let auth = Auth::Bearer(key.clone());
    let mut run = Run::new(http, clock, LIMITS);
    let value = run
        .send(
            Get::new(&Read::Church(church.clone()), auth.clone()),
            &decoder(ReadError::KeyRefused),
        )
        .map_err(miss_error)?;
    project_church(&value, church)?;
    let start = Date::from_days(clock.unix_millis().div_euclid(86_400_000) - 1).ok_or(BAD)?;
    let end = Date::from_days(start.days() + PICKER_DAYS).ok_or(BAD)?;
    let value = run
        .send(
            Get::new(&Read::Overview { start, end }, auth.clone()),
            &decoder(ReadError::Refused),
        )
        .map_err(miss_error)?;
    let mut found: BTreeMap<Id, (Date, Option<Label>)> = BTreeMap::new();
    for row in rows(&value)? {
        let row = object(row)?;
        let id = id_field(row, "planId")?;
        let service_date = day_field(row, "serviceDate")?;
        let name = optional_text(row, "planName")?.and_then(Label::new);
        let entry = found.entry(id).or_insert((service_date, None));
        if entry.0 != service_date {
            return Err(BAD);
        }
        if entry.1.is_none() {
            entry.1 = name;
        }
    }
    let mut choices: Vec<PlanChoice> = found
        .into_iter()
        .filter(|(_, (day, _))| *day >= start && *day <= end)
        .map(|(id, (service_date, name))| PlanChoice {
            id,
            service_date,
            name,
            shared: None,
        })
        .collect();
    choices.sort_by(|a, b| (a.service_date, &a.id).cmp(&(b.service_date, &b.id)));
    choices.truncate(MAX_PLAN_CHOICES);
    if !choices.is_empty() {
        let ids: Vec<Id> = choices.iter().map(|c| c.id.clone()).collect();
        let prepared = run
            .send(
                Get::new(&Read::PlansByIds(ids.clone()), auth),
                &decoder(ReadError::Refused),
            )
            .and_then(|v| project_shared(&v, &ids).map_err(Miss::Failed));
        // Whether each is shared couldn't be read: the plans are still offered, with nothing said either way. A plan
        // the answer leaves out, or whose answer can't tell, says nothing either way too.
        if let Ok(shared) = prepared {
            for choice in &mut choices {
                choice.shared = shared.get(&choice.id).copied().flatten();
            }
        }
    }
    Ok(choices)
}
#[cfg(test)]
#[path = "b1_tests.rs"]
mod tests;
