//! Genesis ChMS, read-only, from the REST address Genesis publishes and nothing else. "Research" below means the
//! 2026-11-17 reading of Genesis's developer page and the public scripts that carry its API text, by section.
//!
//! Genesis's API has no volunteer scheduling (research 3), so a Genesis capture never has a service, positions,
//! assignments, team members or blockouts: it supplies the "also read" facts (groups, events with attendance counts,
//! forms with submission counts). No person's name is read: `names` stays empty.
//!
//! The address is a raw backend host that may change (research 1): it is one constant, `HOST`, under the fixed base
//! path `BASE`; a change is a new Ozzie version, never a typed address. The key starts `gk_live_` and is sent as a
//! Bearer token (research 2); a church can make it read-only per area, and Ozzie needs only Read on groups, events
//! and forms. Genesis allows 120 requests a minute per key (research 4): 600 ms apart, at most 20 a check.
//!
//! | read word | GET | gives |
//! |---|---|---|
//! | `genesis.me` | `/me` | the church this key belongs to (a 401 is `key-refused`) |
//! | `genesis.groups` | `/groups?limit=200&offset=0` | groups and their member counts when given |
//! | `genesis.events` | `/events?from=&to=` (limit 200) | events from yesterday for 4 weeks, with attendance counts |
//! | `genesis.forms` | `/forms?limit=200&offset=0` | forms |
//! | `genesis.form_submissions` | `/forms/<id>/submissions?limit=200&offset=0`, one per form | how many submissions each form has (only counted; nothing in one is kept) |
//!
//! Not read, and not recorded: `genesis.group_members` (facts need counts only) and `genesis.contacts` (no names).
//!
//! Response shapes, seen live 2026-11-17 on a demo church: every list is `{data: [...], limit, offset}`;
//! - `/me`: `{church: {id, name, slug}, scopes: [...]}`;
//! - groups: `id`, `name` and meeting details, with no member count (so `members` is null; `member_count` would be
//!   read if Genesis ever sends one);
//! - events: `id`, `title`, `start_date` (`YYYY-MM-DD`), `start_time` and `end_time` (`HH:MM:SS`), `end_date` (or
//!   null), `attendance_adults`, `attendance_children`, `attendance_students` (integers), and fields not read here;
//! - forms: `id`, `name`, and fields not read here.
//!
//! Genesis's event times are local wall-clock times with no zone, and its API names no zone anywhere (the church's
//! zone is a setting on Genesis's own site). So `check` takes the church's zone from the caller (one the person has
//! confirmed): with it, each event's start and end become instants there (`ZoneOffsets`); a time the zone skips or
//! repeats is never guessed (that event, or its end, is left out). Without a zone no event can be placed: none is
//! sent, and `genesis.events` is `truncated`. An event's attendance is its three counts added, when all three are
//! whole numbers; otherwise null.
//!
//! A wrong type makes the whole read `invalid-response`. A list with as many items as asked for (200) may have more:
//! `truncated`.
use crate::capture::{
    ChurchChoice, Date, Event, Form, Group, Id, Label, LabelKey, MAX_EVENTS, MAX_FORMS, MAX_GROUPS,
    Outcome, ReadWord, System, SystemCapture, ZoneName,
};
use crate::http::{Auth, Endpoint, Get, Http, Origin, QueryValue, ReadError, Segment};
use crate::keys::Key;
use crate::project::{
    BAD, Labelled, Row, capped, decoder, id_field, miss_error, object, optional_count,
    optional_text,
};
use crate::run::{Clock, Limits, Miss, Projected, Run};
use crate::zones::{LocalResult, ZoneOffsets};
use serde_json::Value;
use std::collections::BTreeSet;
use std::time::Duration;

/// The host of the REST address Genesis publishes (research 1).
pub const HOST: &str = "poxkspytrsaextyeurtg.supabase.co";
/// The fixed path every read starts with: `/functions/v1/public-api/v1`.
pub const BASE: [&str; 4] = ["functions", "v1", "public-api", "v1"];
/// 120 requests a minute (research 4).
pub const LIMITS: Limits = Limits {
    min_gap: Duration::from_millis(600),
    per_minute: None,
    max_requests: 20,
    budget: Duration::from_secs(60),
    breaker: 3,
};
/// Items asked for in one list read: the documented maximum (research 4).
pub const PAGE: &str = "200";
const PAGE_COUNT: usize = 200;
/// Days of events read, from yesterday (UTC).
pub const WINDOW_DAYS: i64 = 28;

pub const ME: ReadWord = ReadWord::new("genesis.me");
pub const GROUPS: ReadWord = ReadWord::new("genesis.groups");
/// In the page's closed list but never read (see the top of this file).
pub const GROUP_MEMBERS: ReadWord = ReadWord::new("genesis.group_members");
pub const EVENTS: ReadWord = ReadWord::new("genesis.events");
pub const FORMS: ReadWord = ReadWord::new("genesis.forms");
pub const FORM_SUBMISSIONS: ReadWord = ReadWord::new("genesis.form_submissions");
/// In the page's closed list but never read.
pub const CONTACTS: ReadWord = ReadWord::new("genesis.contacts");
/// Genesis's closed list of read words, in the page's order.
pub const WORDS: &[ReadWord] = &[
    ME,
    GROUPS,
    GROUP_MEMBERS,
    EVENTS,
    FORMS,
    FORM_SUBMISSIONS,
    CONTACTS,
];
/// A check's reads, in the order they are made.
pub const READS: &[ReadWord] = &[ME, GROUPS, EVENTS, FORMS, FORM_SUBMISSIONS];

/// Every GET this file can build. Nothing else can be asked of Genesis.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Read {
    /// `/me`.
    Me,
    /// `/groups?limit=200&offset=0`.
    Groups,
    /// `/events?from=&to=&limit=200&offset=0`, both days inclusive.
    Events { from: Date, to: Date },
    /// `/forms?limit=200&offset=0`.
    Forms,
    /// `/forms/<form>/submissions?limit=200&offset=0`.
    Submissions(Id),
}
impl Endpoint for Read {
    fn origin(&self) -> Origin {
        Origin::Fixed(HOST)
    }
    fn segments(&self) -> Vec<Segment> {
        let mut path: Vec<Segment> = BASE.iter().map(|part| Segment::Fixed(part)).collect();
        match self {
            Read::Me => path.push(Segment::Fixed("me")),
            Read::Groups => path.push(Segment::Fixed("groups")),
            Read::Events { .. } => path.push(Segment::Fixed("events")),
            Read::Forms => path.push(Segment::Fixed("forms")),
            Read::Submissions(form) => path.extend([
                Segment::Fixed("forms"),
                Segment::Id(form.clone()),
                Segment::Fixed("submissions"),
            ]),
        }
        path
    }
    fn query(&self) -> Vec<(&'static str, QueryValue)> {
        let page = || {
            vec![
                ("limit", QueryValue::Fixed(PAGE)),
                ("offset", QueryValue::Fixed("0")),
            ]
        };
        match self {
            Read::Me => Vec::new(),
            Read::Events { from, to } => {
                let mut query = vec![
                    ("from", QueryValue::Day(*from)),
                    ("to", QueryValue::Day(*to)),
                ];
                query.extend(page());
                query
            }
            Read::Groups | Read::Forms | Read::Submissions(_) => page(),
        }
    }
}

/// One of every read, for the guard's list of shapes (`shapes`); `kind` is exhaustive and the tests check every kind is
/// here.
pub(crate) fn samples() -> Vec<Read> {
    let day = Date::parse("2000-01-01").expect("a day");
    vec![
        Read::Me,
        Read::Groups,
        Read::Events { from: day, to: day },
        Read::Forms,
        Read::Submissions(Id::new("sample").expect("a checked id")),
    ]
}
#[cfg(test)]
pub(crate) fn kind(read: &Read) -> usize {
    match read {
        Read::Me => 0,
        Read::Groups => 1,
        Read::Events { .. } => 2,
        Read::Forms => 3,
        Read::Submissions(_) => 4,
    }
}
/// The shape of every read Genesis may be sent (http.rs `allowed`).
pub(crate) fn shapes() -> Vec<crate::http::Shape> {
    samples().iter().map(crate::http::Shape::of).collect()
}
/// A list's `data`, and whether it may have more than it holds: as many as asked for, as many as the `limit` it
/// echoes (a server may cut a page shorter than asked), or fewer than the `total` it states.
fn data(value: &Value) -> Result<(&[Value], bool), ReadError> {
    let row = object(value)?;
    let items = row.get("data").and_then(Value::as_array).ok_or(BAD)?;
    let held = items.len() as u64;
    let limit = optional_count(row, "limit")?;
    let total = optional_count(row, "total")?;
    let more = items.len() >= PAGE_COUNT
        || limit.is_some_and(|l| held >= u64::from(l))
        || total.is_some_and(|t| u64::from(t) > held);
    Ok((items, more))
}
/// Items with unique ids, each read by `item`.
fn items<T>(
    value: &Value,
    max: usize,
    item: impl Fn(&Row, Id) -> Result<T, ReadError>,
) -> Result<Projected<Vec<T>>, ReadError> {
    let (all, more) = data(value)?;
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for row in all {
        let row = object(row)?;
        let id = id_field(row, "id")?;
        if !seen.insert(id.clone()) {
            return Err(BAD);
        }
        out.push(item(row, id)?);
    }
    let (out, cut) = capped(out, max);
    Ok((out, cut || more))
}

struct MeRecord {
    id: Id,
    name: Option<String>,
}
/// `/me` (research 3): "the church this key belongs to and its permissions", read as `church.id` and `church.name`
/// (UNCONFIRMED names; see the top of this file).
fn project_me(value: &Value) -> Result<MeRecord, ReadError> {
    let church = object(value)?.get("church").ok_or(BAD)?;
    let church = object(church)?;
    Ok(MeRecord {
        id: id_field(church, "id")?,
        name: optional_text(church, "name")?.map(str::to_owned),
    })
}
fn project_groups(value: &Value) -> Result<Projected<Labelled<Group>>, ReadError> {
    items(value, MAX_GROUPS, |row, id| {
        let group = Group {
            id,
            members: optional_count(row, "member_count")?,
        };
        Ok((group, optional_text(row, "name")?.map(str::to_owned)))
    })
}
/// The church's zone, with the zone data to place local times in it.
pub(crate) type Zone<'a> = Option<(&'a ZoneName, &'a dyn ZoneOffsets)>;
/// A day field: `YYYY-MM-DD`, or none when missing or null.
fn optional_day(row: &Row, key: &str) -> Result<Option<Date>, ReadError> {
    match row.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Date::parse(s).map(Some).ok_or(BAD),
        Some(_) => Err(BAD),
    }
}
/// A clock time field: `HH:MM:SS` (live), as seconds past midnight; none when missing or null.
fn optional_clock(row: &Row, key: &str) -> Result<Option<i64>, ReadError> {
    let text = match row.get(key) {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::String(s)) => s.as_str(),
        Some(_) => return Err(BAD),
    };
    let b = text.as_bytes();
    let ok = b.len() == 8
        && b[2] == b':'
        && b[5] == b':'
        && [0, 1, 3, 4, 6, 7].iter().all(|i| b[*i].is_ascii_digit());
    if !ok {
        return Err(BAD);
    }
    let n = |r: std::ops::Range<usize>| text[r].parse::<i64>().unwrap_or(99);
    let (h, m, s) = (n(0..2), n(3..5), n(6..8));
    if h > 23 || m > 59 || s > 59 {
        return Err(BAD);
    }
    Ok(Some(h * 3600 + m * 60 + s))
}
/// An event's attendance: adults, children and students added, when all three are whole numbers; otherwise null.
fn attendance(row: &Row) -> Result<Option<u32>, ReadError> {
    let parts = [
        optional_count(row, "attendance_adults")?,
        optional_count(row, "attendance_children")?,
        optional_count(row, "attendance_students")?,
    ];
    Ok(match parts {
        [Some(a), Some(c), Some(s)] => Some(a + c + s).filter(|n| *n <= crate::capture::MAX_COUNT),
        _ => None,
    })
}
/// Events (see the top of this file): each placed in the church's zone, or left out (`truncated`) when it can't be.
fn project_events(value: &Value, zone: Zone<'_>) -> Result<Projected<Labelled<Event>>, ReadError> {
    let (all, more) = data(value)?;
    let mut seen = BTreeSet::new();
    let mut list = Vec::new();
    let mut cut = false;
    for row in all {
        let row = object(row)?;
        let id = id_field(row, "id")?;
        if !seen.insert(id.clone()) {
            return Err(BAD);
        }
        let title = optional_text(row, "title")?.map(str::to_owned);
        let start_day = optional_day(row, "start_date")?.ok_or(BAD)?;
        let start_clock = optional_clock(row, "start_time")?;
        let end_day = optional_day(row, "end_date")?;
        let end_clock = optional_clock(row, "end_time")?;
        let attendance = attendance(row)?;
        let (Some((name, zones)), Some(start_clock)) = (zone, start_clock) else {
            // No zone to place it in, or no start time: it can't be placed.
            cut = true;
            continue;
        };
        let LocalResult::Single(starts_at) = zones.local_to_instant(name, start_day, start_clock)
        else {
            cut = true;
            continue;
        };
        let ends_at = match end_clock {
            None => None,
            Some(clock) => {
                match zones.local_to_instant(name, end_day.unwrap_or(start_day), clock) {
                    LocalResult::Single(end) if end.unix_millis() > starts_at.unix_millis() => {
                        Some(end)
                    }
                    // An end not after the start (with no `end_date` it most likely crosses midnight, but Ozzie
                    // doesn't guess the day), or one the zone skips or repeats: the event keeps its start, its end
                    // is left out, and the read says so.
                    _ => {
                        cut = true;
                        None
                    }
                }
            }
        };
        list.push((
            Event {
                id,
                starts_at,
                ends_at,
                attendance,
            },
            title,
        ));
    }
    // `truncated` means something was left out: an event that couldn't be placed, an end, or events past the cap or
    // the page. It says nothing about the attendance counts of the events that are in the capture: each event's count
    // comes in its own row, whole or null (review D, L4), so the page should judge a count by its own event, not by
    // this read's outcome.
    let (list, over) = capped(list, MAX_EVENTS);
    Ok((list, cut || over || more))
}
fn project_forms(value: &Value) -> Result<Projected<Labelled<Form>>, ReadError> {
    items(value, MAX_FORMS, |row, id| {
        let form = Form {
            id,
            submissions: None,
        };
        Ok((form, optional_text(row, "name")?.map(str::to_owned)))
    })
}
/// How many submissions a page holds: each must be an object with an id, and nothing else in one is read or kept.
/// A full page means at least that many (`truncated`).
fn project_submissions(value: &Value) -> Result<Projected<u32>, ReadError> {
    let (count, more) = items(value, PAGE_COUNT, |_, _| Ok(()))?;
    Ok((count.len() as u32, more))
}

/// Reads Genesis's "also read" facts for `church` with `key`: the reads at the top of this file, paced and limited by
/// `LIMITS`, each recorded. The capture has passed `SystemCapture::valid`.
/// `zone` is the church's own zone, from the caller (Genesis's API names none); without it no event is placed.
pub fn check(
    http: &dyn Http,
    clock: &dyn Clock,
    zones: &dyn ZoneOffsets,
    key: &Key,
    church: &Id,
    zone: Option<&ZoneName>,
) -> Result<SystemCapture, ReadError> {
    check_with(http, clock, zones, key, church, zone, LIMITS)
}
pub(crate) fn check_with(
    http: &dyn Http,
    clock: &dyn Clock,
    zones: &dyn ZoneOffsets,
    key: &Key,
    church: &Id,
    zone: Option<&ZoneName>,
    limits: Limits,
) -> Result<SystemCapture, ReadError> {
    if key.system() != System::Genesis {
        return Err(ReadError::KeyRefused);
    }
    // A zone this Mac's zone data doesn't know (a name in the wrong case: CoreFoundation reads names exactly) can't
    // place an event, so the check isn't made with it, and nothing is sent.
    if zone.is_some_and(|zone| !crate::zones::known(zones, zone, clock)) {
        return Err(ReadError::UnknownZone);
    }
    let auth = Auth::Bearer(key.clone());
    let get = |read: Read| Get::new(&read, auth.clone());
    let key_gate = decoder(ReadError::KeyRefused);
    let gated = decoder(ReadError::Refused);
    let mut run = Run::new(http, clock, limits);
    let mut capture = SystemCapture::empty(System::Genesis, church.clone(), run.started_at());
    // The zone the caller gives is the church's own, confirmed by the person: the page names days with it.
    capture.church.time_zone = zone.cloned();

    // The church the key belongs to must be this one; another is a key for another church.
    let me = run.send(get(Read::Me), &key_gate).and_then(|v| {
        let me = project_me(&v).map_err(Miss::Failed)?;
        if &me.id == church {
            Ok(me)
        } else {
            Err(Miss::Failed(ReadError::KeyRefused))
        }
    });
    match me {
        Ok(me) => {
            if let Some(name) = me.name {
                capture.label(LabelKey::Church, &name);
            }
            run.record(ME, Outcome::Ok);
        }
        Err(miss) => {
            // Nothing proves the key belongs to this church: nothing else is read under it.
            run.record(ME, miss.outcome());
            for word in &READS[1..] {
                run.skip(*word);
            }
            let (reads, completed_at) = run.finish();
            capture.reads = reads;
            capture.completed_at = completed_at;
            capture.valid().map_err(|_| ReadError::InvalidResponse)?;
            return Ok(capture);
        }
    }
    let groups = run.read(GROUPS, get(Read::Groups), &gated, project_groups);
    let from = Date::from_days(clock.unix_millis().div_euclid(86_400_000) - 1).ok_or(BAD)?;
    let to = Date::from_days(from.days() + WINDOW_DAYS).ok_or(BAD)?;
    let placed: Zone<'_> = zone.map(|name| (name, zones));
    let events = run.read(EVENTS, get(Read::Events { from, to }), &gated, |v| {
        project_events(v, placed)
    });
    let forms = run.read(FORMS, get(Read::Forms), &gated, project_forms);
    let read_forms = forms.is_some();
    let mut forms = forms.unwrap_or_default();
    if forms.is_empty() {
        // No forms read: nothing to count. No forms at all: nothing to count, and nothing missing.
        if read_forms {
            run.record(FORM_SUBMISSIONS, Outcome::Ok);
        } else {
            run.skip(FORM_SUBMISSIONS);
        }
    } else {
        let outcome = count_submissions(&mut run, &get, &gated, &mut forms);
        run.record(FORM_SUBMISSIONS, outcome);
    }

    for (group, name) in groups.unwrap_or_default() {
        if let Some(name) = name {
            capture.label(LabelKey::Group(group.id.clone()), &name);
        }
        capture.groups.push(group);
    }
    for (event, name) in events.unwrap_or_default() {
        if let Some(name) = name {
            capture.label(LabelKey::Event(event.id.clone()), &name);
        }
        capture.events.push(event);
    }
    for (form, name) in forms {
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

/// Each form's submission count, one read a form while the run allows. A failure leaves every count null. Forms the
/// run stopped before keep null and the read is `truncated` (or, when none was counted, says why it stopped); a form
/// with a full page has at least that many, also `truncated`. The submissions envelope is `{data, limit, offset}` with
/// no `total` (seen live 2026-11-17), so a count comes only from the rows on the page.
fn count_submissions(
    run: &mut Run<'_>,
    get: &dyn Fn(Read) -> Get,
    decode: &dyn Fn(&crate::http::Reply) -> Result<Value, ReadError>,
    forms: &mut Labelled<Form>,
) -> Outcome {
    let mut outcome = Outcome::Ok;
    let mut counted_any = false;
    for index in 0..forms.len() {
        let counted = run
            .send(get(Read::Submissions(forms[index].0.id.clone())), decode)
            .and_then(|v| project_submissions(&v).map_err(Miss::Failed));
        match counted {
            Ok((count, more)) => {
                forms[index].0.submissions = Some(count);
                counted_any = true;
                if more {
                    outcome = Outcome::Truncated;
                }
            }
            Err(Miss::NotSent(why)) => return if counted_any { Outcome::Truncated } else { why },
            Err(Miss::Failed(error)) => {
                for (form, _) in forms.iter_mut() {
                    form.submissions = None;
                }
                return error.into();
            }
        }
    }
    outcome
}

/// Checks `key` with `/me` and gives the church it belongs to. A refusal is `key-refused`.
pub fn verify_key(
    http: &dyn Http,
    clock: &dyn Clock,
    key: &Key,
) -> Result<ChurchChoice, ReadError> {
    if key.system() != System::Genesis {
        return Err(ReadError::KeyRefused);
    }
    let mut run = Run::new(http, clock, LIMITS);
    let value = run
        .send(
            Get::new(&Read::Me, Auth::Bearer(key.clone())),
            &decoder(ReadError::KeyRefused),
        )
        .map_err(miss_error)?;
    let me = project_me(&value)?;
    Ok(ChurchChoice {
        id: me.id,
        name: me.name.as_deref().and_then(Label::new),
    })
}

#[cfg(test)]
#[path = "genesis_tests.rs"]
pub(crate) mod tests;
