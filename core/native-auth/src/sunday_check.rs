//! Sunday readiness check: one bounded, sequential, GET-only read set for a plan
//! (docs/build/sunday-capture-contract.md), and its local cached recording.
//!
//! Partial truth only: every page attempted is recorded with its own outcome and check
//! time; a failed page never stops the rest, and nothing is filled in for it.
use crate::{
    oauth::{AuthController, Binding, VerifiedSource, numeric_id},
    source::{
        Collection, NativeSourceHttp, Product, SourceError, SourceHttp, SourceRequest, Target,
        Window,
    },
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    io::{self, Read, Write},
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

pub const MAX_TEAMS: usize = 10;
pub const MAX_PEOPLE: usize = 40;
pub const MAX_PAGES: usize = 3;
/// People workflows whose steps and cards are read (v2 operations reads).
pub const MAX_WORKFLOWS: usize = 10;
/// Groups whose Sunday events are read, from plan people's memberships.
pub const MAX_GROUPS: usize = 20;
/// Booked Calendar events whose conflict records are read.
pub const MAX_CONFLICT_EVENTS: usize = 20;
/// People scheduled on kids teams whose People background checks are read.
pub const MAX_BACKGROUND_PEOPLE: usize = MAX_PEOPLE;
/// People forms the church chose to watch (Church rules), whose recent submissions are read.
pub const MAX_FORMS: usize = 10;
/// Check-Ins events whose rooms and recent periods are read.
pub const MAX_CHECKINS_EVENTS: usize = 10;
/// Check-Ins event times (inside the recent window, latest first) whose room counts are read.
pub const MAX_CHECKINS_TIMES: usize = 20;
/// Open Registrations signups whose active attendees are counted.
pub const MAX_SIGNUPS: usize = 10;
/// Days before the check that Check-Ins and form submissions are read for: long enough that the
/// most recent Sunday is always inside, whichever day the check runs.
pub const RECENT_DAYS: u64 = 8;
const PER_PAGE: u16 = 100;
/// Whole-check budget. Reads not started in time are recorded as `timeout`, never dropped.
pub const BUDGET_MS: u64 = 180_000;
/// Requests left in the provider's rate window below which the check waits it out.
const RATE_RESERVE: u64 = 10;
/// Longest single wait, for rate headers or a 429's Retry-After.
pub const MAX_WAIT_MS: u64 = 20_000;
/// Consecutive provider failures after which no further requests are made.
pub const BREAKER_STRIKES: usize = 3;
const OK: &str = "ok";
const TRUNCATED: &str = "truncated";
/// What a `groups_person_memberships` 404 means (the person has no Groups profile).
const NOT_IN_GROUPS: &[u8] = br#"{"data":[],"meta":{"count":0,"total_count":0}}"#;
/// A Calendar, People or Groups read the saved connection never consented to (it was signed in
/// with Services only). Never attempted; it means "not checked", never "clear".
pub const NOT_REQUESTED: &str = "not-requested";
/// Every outcome a read can carry: `ok`, `truncated`, `not-requested`, or a source error reason.
const OUTCOMES: &[&str] = &[
    OK,
    TRUNCATED,
    NOT_REQUESTED,
    "invalid-request",
    "binding-mismatch",
    "missing-credentials",
    "locked",
    "denied",
    "store-unavailable",
    "invalid-credentials",
    "organization-unverified",
    "provider-failure",
    "invalid-response",
    "oversized",
    "cancelled",
    "timeout",
    "busy",
    "rate-limited",
    "rejected",
];

/// Intentionally not Debug: `names` and `labels` hold real display text and stay on this Mac.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SundayCapture {
    pub version: u8,
    pub kind: String,
    pub organization: String,
    pub service_type_id: String,
    pub plan_id: String,
    pub started_at: String,
    pub completed_at: String,
    pub reads: Vec<SundayRead>,
    /// Person id -> display name, only for people this capture refers to.
    /// Local display only; never model input.
    pub names: BTreeMap<String, String>,
    /// `room:<id>`, `workflow:<id>` or `step:<id>` -> that row's display name, for rows of this
    /// capture's `calendar_rooms`, `people_workflows` and `people_workflow_steps` reads. Free text
    /// that can name a person, so it is never in a body: single-line, at most 120 characters.
    /// Local display only; never model input. Absent when empty (and in older recordings).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub labels: BTreeMap<String, String>,
    /// The kids team ids this check was given (Church rules, background-check rule on). Background
    /// checks are read, and kept in a recording, only for people confirmed or pending on them.
    /// Absent when empty (and in older recordings).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub kids_teams: Vec<String>,
    /// The People forms this check was given to watch (Church rules), once the church turned forms
    /// on: the form list is read only then, and submissions only for these. Absent when forms are
    /// off (and in older recordings); empty when on with none chosen yet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forms: Option<Vec<String>>,
    /// The Check-Ins event the church chose in Church rules, when it chose one: only that event's
    /// rooms and times are read. Absent: every listed event, up to MAX_CHECKINS_EVENTS.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkins_event: Option<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SundayRead {
    pub collection: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub person_id: Option<String>,
    /// v2 operations reads carry their own ids, never `team_id`/`person_id`, so a Calendar,
    /// People or Groups outcome can never change a Services team or person scope.
    /// The Calendar Event whose conflicts were read (`calendar_conflicts`), from a booking.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    /// The Person whose group memberships were read (same id space as `person_id`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub groups_person_id: Option<String>,
    /// The Person whose People background checks were read (same id space as `person_id`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub people_person_id: Option<String>,
    /// The People form whose submissions were read (`people_form_submissions`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub form_id: Option<String>,
    /// The Check-Ins event whose rooms or periods were read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkins_event_id: Option<String>,
    /// The Check-Ins event time whose room counts were read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkins_event_time_id: Option<String>,
    /// The Registrations signup whose active attendees were counted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signup_id: Option<String>,
    /// The time window a windowed read asked for (the plan's Sunday, every UTC offset).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window: Option<Window>,
    pub offset: u64,
    pub checked_at: String,
    /// `ok`, `truncated` (a bound or paging gap left rows unread), or a source error reason.
    pub outcome: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<Value>,
    /// Only on person_schedules pages read without `filter=all` because Planning Center
    /// explicitly refused that filter (400/422): these hold its default, not all, schedules.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub fallback: bool,
}

pub(crate) trait Clock {
    /// Wall clock in Unix milliseconds, for timestamps people see.
    fn now_ms(&self) -> u64;
    /// Monotonic milliseconds, for the budget.
    fn elapsed_ms(&self) -> u64;
    /// Sleeps up to `ms`, waking early once `stop` holds. True when stopped early.
    fn sleep_ms(&self, ms: u64, stop: &dyn Fn() -> bool) -> bool;
}
struct SystemClock(Instant);
impl Clock for SystemClock {
    fn now_ms(&self) -> u64 {
        unix_ms()
    }
    fn elapsed_ms(&self) -> u64 {
        self.0.elapsed().as_millis() as u64
    }
    fn sleep_ms(&self, ms: u64, stop: &dyn Fn() -> bool) -> bool {
        let until = Instant::now() + Duration::from_millis(ms);
        loop {
            if stop() {
                return true;
            }
            let left = until.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return false;
            }
            std::thread::sleep(left.min(Duration::from_millis(100)));
        }
    }
}
pub fn unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}
/// RFC 3339 UTC with milliseconds, e.g. `2026-11-22T09:00:00.000Z`.
pub fn rfc3339(ms: u64) -> String {
    let secs = ms / 1000;
    let (days, rem) = ((secs / 86_400) as i64, secs % 86_400);
    // Civil date from days since 1970-01-01 (proleptic Gregorian).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60,
        ms % 1000
    )
}
/// Inverse of [`rfc3339`] for exactly that spelling; anything else is refused.
pub(crate) fn parse_rfc3339(text: &str) -> Option<u64> {
    let b = text.as_bytes();
    if b.len() != 24 || [4, 7, 10, 13, 16, 19, 23].map(|i| b[i]) != *b"--T::.Z" {
        return None;
    }
    let num = |from: usize, to: usize| -> Option<i64> {
        let part = &text[from..to];
        part.bytes()
            .all(|c| c.is_ascii_digit())
            .then(|| part.parse().ok())
            .flatten()
    };
    let (y, m, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (h, mi, s, ms) = (num(11, 13)?, num(14, 16)?, num(17, 19)?, num(20, 23)?);
    // Days since 1970-01-01 (proleptic Gregorian).
    let (y2, m2) = if m <= 2 { (y - 1, m + 9) } else { (y, m - 3) };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let doy = (153 * m2 + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let total = (((days * 24 + h) * 60 + mi) * 60 + s) * 1000 + ms;
    let total = u64::try_from(total).ok()?;
    // Round-trip rejects out-of-range fields such as month 13 or 25:00.
    (rfc3339(total) == text).then_some(total)
}

/// Every Person display name a check read, including those `names` then prunes (a team leader
/// on no position, a candidate past MAX_PEOPLE). Guard-only: held in memory for the native name
/// guard, so a pruned name typed into a draft is still refused. Never part of the capture, a
/// recording, an IPC response or a log; deliberately not Debug, Clone or Serialize.
pub struct ReadNames(Vec<String>);
impl ReadNames {
    pub fn iter(&self) -> impl Iterator<Item = &String> {
        self.0.iter()
    }
}

/// Runs the contract's read set through the controller's verified, GET-only source path.
/// `Err` for invalid ids, an unavailable HTTP client, a failed organization check, or
/// cancellation; individual source failures are recorded per read inside the capture.
/// The capture's `names` keep only the people it is about; `ReadNames` holds every name read,
/// for the name guard only. `kids_teams` are the Services team ids the church marked as kids
/// teams with the background-check rule on (Church rules); empty means no background-check read.
pub fn check_sunday(
    auth: &AuthController,
    service_type_id: &str,
    plan_id: &str,
    kids_teams: &[String],
    cancelled: &AtomicBool,
) -> Result<(SundayCapture, ReadNames), SourceError> {
    check_sunday_with(
        auth,
        service_type_id,
        plan_id,
        kids_teams,
        // The reading code's own entries: everything the sign-in allows, as before. The app passes its switch.
        ChurchReads {
            operations: true,
            ..ChurchReads::default()
        },
        cancelled,
    )
}
/// What the church chose for the church reads (Church rules). `forms`: `None` while forms are off
/// (no form is read), `Some` once on (the form list is read, and submissions only for these ids).
/// `checkins_event`: the one Check-Ins event to read, when chosen; otherwise every listed event,
/// bounded. Check-Ins and Registrations are read only when their own product was granted.
#[derive(Clone, Copy, Default)]
pub struct ChurchReads<'a> {
    pub forms: Option<&'a [String]>,
    pub checkins_event: Option<&'a str>,
    /// Rooms and Calendar conflicts, People follow-ups (workflows, steps, cards) and the scheduled people's group
    /// memberships and events: read only when the leader turned them on in Settings ("Also check rooms, follow-ups
    /// and group events"), never just because the sign-in holds those scopes (first-run review H1: allowing People
    /// to fill in To must not start them). Off by default.
    pub operations: bool,
}
impl ChurchReads<'_> {
    fn valid(&self) -> bool {
        self.forms.is_none_or(forms_valid) && self.checkins_event.is_none_or(numeric_id)
    }
}
/// `check_sunday`, plus the church reads the church chose (`ChurchReads`).
pub fn check_sunday_with(
    auth: &AuthController,
    service_type_id: &str,
    plan_id: &str,
    kids_teams: &[String],
    church: ChurchReads<'_>,
    cancelled: &AtomicBool,
) -> Result<(SundayCapture, ReadNames), SourceError> {
    if !numeric_id(service_type_id)
        || !numeric_id(plan_id)
        || !kids_teams_valid(kids_teams)
        || !church.valid()
    {
        return Err(SourceError::InvalidRequest);
    }
    let http = NativeSourceHttp::new()?;
    run_with_church(
        auth,
        service_type_id,
        plan_id,
        kids_teams,
        church,
        cancelled,
        &http,
        &SystemClock(Instant::now()),
    )
}
/// At most MAX_TEAMS distinct numeric team ids.
fn kids_teams_valid(kids_teams: &[String]) -> bool {
    distinct_ids(kids_teams, MAX_TEAMS)
}
/// At most MAX_FORMS distinct numeric form ids.
fn forms_valid(forms: &[String]) -> bool {
    distinct_ids(forms, MAX_FORMS)
}
fn distinct_ids(ids: &[String], max: usize) -> bool {
    let distinct: BTreeSet<&str> = ids.iter().map(String::as_str).collect();
    ids.len() <= max && distinct.len() == ids.len() && ids.iter().all(|id| numeric_id(id))
}

/// Ordered, de-duplicated ids with a hard cap.
struct Bounded {
    ids: Vec<String>,
    max: usize,
}
impl Bounded {
    fn new(max: usize) -> Self {
        Self {
            ids: Vec::new(),
            max,
        }
    }
    /// False when a new id did not fit.
    fn add(&mut self, id: &str) -> bool {
        if self.ids.iter().any(|known| known == id) {
            return true;
        }
        if self.ids.len() >= self.max {
            return false;
        }
        self.ids.push(id.into());
        true
    }
}

struct Check<'a> {
    auth: &'a AuthController,
    verified: VerifiedSource,
    /// `ChurchReads::operations`: the rooms, follow-ups and group reads are made only when on.
    operations: bool,
    service_type_id: &'a str,
    plan_id: &'a str,
    cancelled: &'a AtomicBool,
    http: &'a dyn SourceHttp,
    clock: &'a dyn Clock,
    reads: Vec<SundayRead>,
    names: BTreeMap<String, String>,
    /// Every included Person name, before `names` is pruned; for the name guard only.
    read_names: BTreeSet<String>,
    labels: BTreeMap<String, String>,
    /// Reads Planning Center explicitly refused (400/422), the only fallback trigger.
    refused: BTreeSet<usize>,
    /// Consecutive failures per breaker. A denial or query refusal (401/403/400/422) is a fact
    /// about one product endpoint, so it counts against that endpoint (`Some`) and only that
    /// endpoint's success resets it; anything else (transport, timeout, 5xx, 429) counts against
    /// the provider as a whole (`None`), and any success resets it.
    strikes: BTreeMap<Option<(Product, &'static str)>, usize>,
    /// Once set, remaining reads under that breaker are recorded with this reason, unrequested.
    tripped: BTreeMap<Option<(Product, &'static str)>, &'static str>,
}
impl Check<'_> {
    fn ended(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst) || self.auth.source_ended(&self.verified)
    }
    /// A cancellable wait; cancellation ends the whole check.
    fn wait(&self, ms: u64) -> Result<(), SourceError> {
        if self.ended() || self.clock.sleep_ms(ms, &|| self.ended()) {
            return Err(SourceError::Cancelled);
        }
        Ok(())
    }
    fn fetch(
        &self,
        collection: Collection,
        target: &Target,
        offset: u64,
    ) -> Result<crate::source::SourcePage, SourceError> {
        let request = SourceRequest::capture_at(
            self.auth.binding(),
            self.service_type_id,
            self.plan_id,
            collection,
            target,
            PER_PAGE,
            offset,
        )?;
        match self
            .auth
            .read_verified_using(&self.verified, &request, self.cancelled, self.http)
        {
            // Groups has no profile for this Services person: in no group, a complete answer.
            // Read as the empty page it means, so it is `ok`, strikes nothing and is not retried.
            Err(SourceError::NotFound) if collection == Collection::GroupsPersonMemberships => {
                crate::source::project_page(&request, NOT_IN_GROUPS, &BTreeMap::new())
            }
            // Anywhere else a 404 is the provider failure it always was.
            Err(SourceError::NotFound) => Err(SourceError::ProviderFailure),
            result => result,
        }
    }
    fn read(
        &mut self,
        collection: Collection,
        target: &Target,
        offset: u64,
        fallback: bool,
    ) -> Result<(usize, Option<u64>), SourceError> {
        let mut record = SundayRead {
            collection: collection.label().into(),
            team_id: target.team_id.clone(),
            person_id: target.person_id.clone(),
            event_id: target.event_id.clone(),
            workflow_id: target.workflow_id.clone(),
            group_id: target.group_id.clone(),
            groups_person_id: target.groups_person_id.clone(),
            people_person_id: target.people_person_id.clone(),
            form_id: target.form_id.clone(),
            checkins_event_id: target.checkins_event_id.clone(),
            checkins_event_time_id: target.checkins_event_time_id.clone(),
            signup_id: target.signup_id.clone(),
            window: target.window.clone(),
            offset,
            checked_at: String::new(),
            outcome: SourceError::Timeout.reason().into(),
            body: None,
            fallback,
        };
        let mut next = None;
        let mut headers = None;
        let mut refused = false;
        let endpoint = Some(collection.endpoint());
        let tripped = self
            .tripped
            .get(&None)
            .or_else(|| self.tripped.get(&endpoint))
            .copied();
        if !collection.product().granted(self.verified.scopes())
            || (operations_read(collection) && !self.operations)
        {
            record.outcome = NOT_REQUESTED.into();
        } else if let Some(reason) = tripped {
            record.outcome = reason.into();
        } else if self.clock.elapsed_ms() < BUDGET_MS {
            let mut result = self.fetch(collection, target, offset);
            // Honor one Retry-After (bounded, cancellable), then record whatever comes back.
            if let Err(SourceError::RateLimited(after)) = result {
                self.wait(after.map_or(MAX_WAIT_MS, |s| (u64::from(s) * 1000).min(MAX_WAIT_MS)))?;
                result = self.fetch(collection, target, offset);
            }
            match result {
                // A cancelled check is not a check: no partial capture is returned or saved.
                Err(SourceError::Cancelled) => return Err(SourceError::Cancelled),
                Err(error) => {
                    record.outcome = error.reason().into();
                    refused = error == SourceError::Rejected;
                    // Malformed pages are content facts, not a failing provider.
                    if !matches!(error, SourceError::InvalidResponse | SourceError::Oversized) {
                        let breaker =
                            if matches!(error, SourceError::Denied | SourceError::Rejected) {
                                endpoint
                            } else {
                                None
                            };
                        let strikes = self.strikes.entry(breaker).or_default();
                        *strikes += 1;
                        if *strikes >= BREAKER_STRIKES {
                            self.tripped.entry(breaker).or_insert(error.reason());
                        }
                    }
                }
                Ok(page) => {
                    // Another endpoint's success says nothing about this one's refusals.
                    self.strikes.remove(&None);
                    self.strikes.remove(&endpoint);
                    next = next_offset(page.body());
                    for (key, label) in page.labels() {
                        self.labels
                            .entry(key.clone())
                            .or_insert_with(|| label.clone());
                    }
                    record.body = Some(self.keep(collection, page.body()));
                    record.outcome = OK.into();
                    headers = Some(page.headers().clone());
                }
            }
        }
        record.checked_at = rfc3339(self.clock.now_ms());
        self.reads.push(record);
        let index = self.reads.len() - 1;
        if refused {
            self.refused.insert(index);
        }
        if let Some(headers) = headers {
            self.pace(&headers)?;
        }
        Ok((index, next))
    }
    /// Up to MAX_PAGES pages. Pages must tile the collection exactly: a next offset that is
    /// not this page's end, a third page with more, or rows short of total_count all mark the
    /// last read `truncated`.
    fn pages(
        &mut self,
        collection: Collection,
        target: &Target,
        fallback: bool,
    ) -> Result<Vec<usize>, SourceError> {
        let mut indices = Vec::new();
        let mut offset = 0;
        loop {
            let (index, next) = self.read(collection, target, offset, fallback)?;
            indices.push(index);
            let Some(body) = &self.reads[index].body else {
                break;
            };
            // `plan` is a single object: no rows to tile.
            let rows = body["data"].as_array().map(|rows| rows.len() as u64);
            let end = rows.map(|rows| offset + rows);
            let total = body["meta"]["total_count"].as_u64();
            let gap = match (next, end) {
                (Some(next), Some(end)) => {
                    next != end || next <= offset || indices.len() >= MAX_PAGES
                }
                (Some(_), None) => true,
                (None, Some(end)) => total.is_some_and(|total| end < total),
                (None, None) => false,
            };
            if gap {
                self.reads[index].outcome = TRUNCATED.into();
            }
            match next {
                Some(next) if !gap => offset = next,
                _ => break,
            }
        }
        Ok(indices)
    }
    fn schedules(&mut self, person: &str) -> Result<(), SourceError> {
        let target = Target::person(person);
        let first = self.pages(Collection::PersonSchedules, &target, false)?;
        // Contract fallback, only after Planning Center explicitly refused `filter=all`.
        if first.len() == 1 && self.refused.contains(&first[0]) {
            self.pages(Collection::PersonSchedulesUnfiltered, &target, true)?;
        }
        Ok(())
    }
    /// Stored body: links consumed, included Person rows moved into `names`.
    /// A form submission whose person kept no name on this page (a child, or someone Planning
    /// Center didn't say isn't a child) keeps no person link either: it is counted, never named,
    /// and its person id isn't stored.
    fn keep(&mut self, collection: Collection, body: &Value) -> Value {
        let mut body = body.clone();
        let mut named_here = BTreeSet::new();
        if let Some(map) = body.as_object_mut() {
            map.remove("links");
            if let Some(Value::Array(rows)) = map.remove("included") {
                let mut kept = Vec::new();
                for row in rows {
                    if row["type"] == "Person" {
                        if let (Some(id), Some(name)) =
                            (row["id"].as_str(), row["attributes"]["name"].as_str())
                        {
                            self.read_names.insert(name.into());
                            self.names.entry(id.into()).or_insert_with(|| name.into());
                            named_here.insert(id.to_owned());
                            // A form submission's named person keeps, in the body, only Planning
                            // Center's proof that they aren't a child: recordings are checked by it.
                            if collection == Collection::PeopleFormSubmissions
                                && row["attributes"]["child"] == Value::Bool(false)
                            {
                                kept.push(serde_json::json!({"id":id,"type":"Person","attributes":{"child":false}}));
                            }
                        }
                    } else {
                        kept.push(row);
                    }
                }
                if !kept.is_empty() {
                    map.insert("included".into(), Value::Array(kept));
                }
            }
        }
        if collection == Collection::PeopleFormSubmissions {
            for row in body["data"].as_array_mut().into_iter().flatten() {
                let person = row["relationships"]["person"]["data"]["id"]
                    .as_str()
                    .map(str::to_owned);
                if !person.is_some_and(|id| named_here.contains(&id))
                    && let Some(links) = row["relationships"].as_object_mut()
                {
                    links.remove("person");
                }
            }
        }
        body
    }
    /// Related ids (`rel` of `kind`) from one read's rows, in row order.
    fn related(&self, index: usize, rel: &str, kind: &str) -> Vec<String> {
        related_ids(&self.reads[index], rel, kind)
            .into_iter()
            .map(str::to_owned)
            .collect()
    }
    /// Adds related ids to a bounded set; a read whose ids did not all fit is `truncated`.
    fn gather(&mut self, index: usize, rel: &str, kind: &str, set: &mut Bounded) {
        let ids = self.related(index, rel, kind);
        self.bound(index, ids, set);
    }
    /// Adds a read's own row ids (e.g. workflows) to a bounded set, like `gather`.
    fn gather_rows(&mut self, index: usize, set: &mut Bounded) {
        let ids = row_ids(&self.reads[index])
            .into_iter()
            .map(str::to_owned)
            .collect();
        self.bound(index, ids, set);
    }
    fn bound(&mut self, index: usize, ids: Vec<String>, set: &mut Bounded) {
        let mut dropped = false;
        for id in ids {
            dropped |= !set.add(&id);
        }
        if dropped && self.reads[index].outcome == OK {
            self.reads[index].outcome = TRUNCATED.into();
        }
    }
    fn pace(&self, headers: &BTreeMap<String, String>) -> Result<(), SourceError> {
        let number = |key: &str| headers.get(key).and_then(|v| v.parse::<u64>().ok());
        if let (Some(limit), Some(count)) = (
            number("x-pco-api-request-rate-limit"),
            number("x-pco-api-request-rate-count"),
        ) && count.saturating_add(RATE_RESERVE) >= limit
        {
            let period = headers
                .get("x-pco-api-request-rate-period")
                .and_then(|v| v.strip_suffix(" seconds"))
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(20);
            self.wait(period.saturating_mul(1000).min(MAX_WAIT_MS))?;
        }
        Ok(())
    }
}
/// Related ids (`rel` of `kind`) from one read's stored rows, in row order.
fn related_ids<'a>(read: &'a SundayRead, rel: &str, kind: &str) -> Vec<&'a str> {
    let Some(body) = &read.body else {
        return Vec::new();
    };
    let mut ids = Vec::new();
    for row in body["data"].as_array().into_iter().flatten() {
        let data = &row["relationships"][rel]["data"];
        let targets: Vec<&Value> = match data {
            Value::Array(items) => items.iter().collect(),
            Value::Object(_) => vec![data],
            _ => Vec::new(),
        };
        for target in targets {
            if target["type"] == kind
                && let Some(id) = target["id"].as_str()
            {
                ids.push(id);
            }
        }
    }
    ids
}
/// A read's own row ids, in row order.
fn row_ids(read: &SundayRead) -> Vec<&str> {
    read.body
        .as_ref()
        .and_then(|body| body["data"].as_array())
        .into_iter()
        .flatten()
        .filter_map(|row| row["id"].as_str())
        .collect()
}
fn next_offset(body: &Value) -> Option<u64> {
    // Already validated by the projection: exact path, fixed query and paging only.
    let link = url::Url::parse(body["links"]["next"].as_str()?).ok()?;
    link.query_pairs()
        .find(|(key, _)| key == "offset")
        .and_then(|(_, value)| value.parse().ok())
}
const HOUR_MS: u64 = 3_600_000;
/// The plan's local day as a fetch window, with no time-zone rules here; the webview narrows it
/// with the church's time zone. Services documents `Plan.sort_date` as returned in the
/// organization's own time zone, so its date D is the church-local day, which lies inside
/// [D 00:00Z - 14h, D+1 00:00Z + 12h) for every UTC offset from -12:00 to +14:00. Not verified
/// live is whether a trailing `Z` there is that floating local time or a true UTC instant T. If
/// it is T, the local day holding T lies within 24 hours either side of it whatever the offset
/// (UTC+10's 09:00 Sunday is 23:00Z Saturday: that Sunday ends at 14:00Z), so a `Z` sort_date
/// also covers [T - 24h, T + 24h). An explicit offset already names the local date.
pub(crate) fn window_for(sort_date: &str) -> Option<Window> {
    let instant = crate::source::instant_ms(sort_date)?;
    let midnight = parse_rfc3339(&format!("{}T00:00:00.000Z", &sort_date[..10]))?;
    let mut starts = midnight.checked_sub(14 * HOUR_MS)?;
    let mut ends = midnight + 36 * HOUR_MS;
    if sort_date.ends_with('Z') {
        let instant = u64::try_from(instant).ok()?;
        starts = starts.min(instant.checked_sub(24 * HOUR_MS)?);
        ends = ends.max(instant + 24 * HOUR_MS);
    }
    // Whole seconds, rounded outward.
    let second = |ms: u64| format!("{}Z", &rfc3339(ms)[..19]);
    Some(Window {
        starts_at: second(starts),
        ends_at: second(ends.div_ceil(1000) * 1000),
    })
}
/// The window every windowed read of a capture must carry: the plan read's, if it answered.
fn plan_window(reads: &[SundayRead]) -> Option<Window> {
    let plan = reads
        .iter()
        .find(|r| r.collection == Collection::Plan.label())?;
    window_for(plan.body.as_ref()?["data"]["attributes"]["sort_date"].as_str()?)
}

/// v2 operations reads, after every Services read: rooms, their bookings in the plan's window
/// and Calendar's conflict records for each booked event, follow-up workflow steps and
/// ready/snoozed cards, and the group meetings of people on this plan. Without a plan date,
/// windowed reads (and the conflicts that follow bookings) are not attempted and do not appear.
/// The reads `ChurchReads::operations` turns on: rooms and their bookings and conflicts, People follow-ups, and the
/// scheduled people's group memberships and events. Background checks and forms have their own switches.
fn operations_read(collection: Collection) -> bool {
    matches!(
        collection,
        Collection::CalendarRooms
            | Collection::CalendarResourceBookings
            | Collection::CalendarEventConflicts
            | Collection::PeopleWorkflows
            | Collection::PeopleWorkflowSteps
            | Collection::PeopleWorkflowReadyCards
            | Collection::PeopleWorkflowSnoozedCards
            | Collection::GroupsPersonMemberships
            | Collection::GroupsGroupEvents
    )
}
fn operations(
    check: &mut Check<'_>,
    people: &Bounded,
    on_plan: &BTreeSet<String>,
) -> Result<(), SourceError> {
    let window = plan_window(&check.reads);
    let org = Target::default();
    check.pages(Collection::CalendarRooms, &org, false)?;
    if let Some(window) = &window {
        // Calendar's own conflict records for each event booked in the window, in booking
        // order. Redacted `BookedEvent` stubs name events this person cannot see: not read.
        let mut events = Bounded::new(MAX_CONFLICT_EVENTS);
        for index in check.pages(
            Collection::CalendarResourceBookings,
            &org.clone().within(window),
            false,
        )? {
            check.gather(index, "event", "Event", &mut events);
        }
        for event in &events.ids {
            check.pages(
                Collection::CalendarEventConflicts,
                &Target::event(event),
                false,
            )?;
        }
    }
    let mut workflows = Bounded::new(MAX_WORKFLOWS);
    for index in check.pages(Collection::PeopleWorkflows, &org, false)? {
        check.gather_rows(index, &mut workflows);
    }
    for workflow in &workflows.ids {
        let target = Target::workflow(workflow);
        check.pages(Collection::PeopleWorkflowSteps, &target, false)?;
        check.pages(Collection::PeopleWorkflowReadyCards, &target, false)?;
        check.pages(Collection::PeopleWorkflowSnoozedCards, &target, false)?;
    }
    // Only people scheduled on this plan whose own reads were planned, in plan order.
    let mut groups = Bounded::new(MAX_GROUPS);
    for person in people.ids.iter().filter(|p| on_plan.contains(*p)) {
        let target = Target::groups_person(person);
        for index in check.pages(Collection::GroupsPersonMemberships, &target, false)? {
            check.gather(index, "group", "Group", &mut groups);
        }
    }
    if let Some(window) = &window {
        for group in &groups.ids {
            let target = Target::group(group).within(window);
            check.pages(Collection::GroupsGroupEvents, &target, false)?;
        }
    }
    Ok(())
}

/// People confirmed or pending on one of `kids_teams`, from a `team_members` read, in row order.
fn scheduled_on<'a>(read: &'a SundayRead, kids_teams: &[String]) -> Vec<&'a str> {
    let Some(body) = &read.body else {
        return Vec::new();
    };
    body["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|row| {
            matches!(
                row["attributes"]["status"].as_str(),
                Some("C" | "U" | "Confirmed" | "Unconfirmed")
            ) && row["relationships"]["team"]["data"]["id"]
                .as_str()
                .is_some_and(|team| kids_teams.iter().any(|kids| kids == team))
        })
        .filter_map(|row| row["relationships"]["person"]["data"]["id"].as_str())
        .collect()
}
/// People background checks, last: for each person confirmed or pending on this plan on a team
/// the church marked as a kids team, in plan order and bounded, their cleared checks only.
/// Nobody else's checks are read, and nothing is read without a kids team.
fn background_checks(
    check: &mut Check<'_>,
    members: &[usize],
    kids_teams: &[String],
) -> Result<(), SourceError> {
    if kids_teams.is_empty() {
        return Ok(());
    }
    let mut people = Bounded::new(MAX_BACKGROUND_PEOPLE);
    for &index in members {
        for person in scheduled_on(&check.reads[index], kids_teams) {
            // Past the bound, a person's checks are simply not read: the webview names them
            // as not checked. The plan's own team_members read is never marked truncated.
            people.add(person);
        }
    }
    for person in &people.ids {
        check.pages(
            Collection::PeopleBackgroundChecks,
            &Target::people_person(person),
            false,
        )?;
    }
    Ok(())
}

/// The days before a check that Check-Ins and form submissions are read for, from the check's own
/// start: `[start - RECENT_DAYS days, start)`, as whole-second UTC instants with the start rounded
/// up. A recording's reads must carry exactly the window its `started_at` gives.
pub(crate) fn recent_window(started_ms: u64) -> Option<Window> {
    let until = started_ms.div_ceil(1000) * 1000;
    let from = until.checked_sub(RECENT_DAYS * 24 * HOUR_MS)?;
    let second = |ms: u64| format!("{}Z", &rfc3339(ms)[..19]);
    Some(Window {
        starts_at: second(from),
        ends_at: second(until),
    })
}
/// Event times one `checkins_event_periods` read placed inside `window`: included EventTime rows
/// (with `include=event_times`) whose own `event_period` is a period on this page and whose event,
/// when stated, is the read's, as (start ms, id). Planning Center's published EventPeriod renders
/// no link to its times, so the time's own link is what places it. A time that can't be placed,
/// or that starts outside the window, is left out.
fn recent_event_times<'a>(read: &'a SundayRead, window: &Window) -> Vec<(i64, &'a str)> {
    let Some(body) = &read.body else {
        return Vec::new();
    };
    let (Some(from), Some(until)) = (
        crate::source::instant_ms(&window.starts_at),
        crate::source::instant_ms(&window.ends_at),
    ) else {
        return Vec::new();
    };
    let periods: BTreeSet<&str> = row_ids(read).into_iter().collect();
    let mut times: Vec<(i64, &str)> = body["included"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|row| row["type"] == "EventTime")
        .filter(|row| {
            row["relationships"]["event_period"]["data"]["id"]
                .as_str()
                .is_some_and(|period| periods.contains(period))
        })
        .filter(|row| {
            let event = &row["relationships"]["event"]["data"];
            event.is_null() || event["id"].as_str() == read.checkins_event_id.as_deref()
        })
        .filter_map(|row| {
            let at = row["attributes"]["starts_at"]
                .as_str()
                .and_then(crate::source::instant_ms)?;
            Some((at, row["id"].as_str()?))
        })
        .filter(|&(at, _)| from <= at && at < until)
        .collect();
    times.sort_unstable();
    times.dedup();
    times
}
/// Signups a `registrations_signups` read lists as open (`closed: false`), in row order: only these
/// have attendees worth counting. One whose `closed` is missing is not read.
fn open_signups(read: &SundayRead) -> Vec<&str> {
    read.body
        .as_ref()
        .and_then(|body| body["data"].as_array())
        .into_iter()
        .flatten()
        .filter(|row| row["attributes"]["closed"] == Value::Bool(false))
        .filter_map(|row| row["id"].as_str())
        .collect()
}
/// People forms, once the church turned them on: the list of forms that aren't archived, then
/// for each chosen form that list holds, in the order chosen, its submissions created inside the
/// recent window, with who submitted. A form not in the list is not read (the webview says so).
fn people_forms(
    check: &mut Check<'_>,
    forms: &[String],
    window: &Window,
) -> Result<(), SourceError> {
    let mut listed = BTreeSet::new();
    for index in check.pages(Collection::PeopleForms, &Target::default(), false)? {
        listed.extend(row_ids(&check.reads[index]).into_iter().map(str::to_owned));
    }
    for form in forms.iter().filter(|form| listed.contains(*form)) {
        let target = Target::form(form).within(window);
        check.pages(Collection::PeopleFormSubmissions, &target, false)?;
    }
    Ok(())
}
/// Check-Ins, only when granted: the events that aren't archived (bounded), each event's rooms
/// and its periods overlapping the recent window, then for the latest event times that started
/// inside it (bounded across every event) the per-room counts. Counts only: no check-in, person or
/// child is read.
fn check_ins(
    check: &mut Check<'_>,
    window: &Window,
    chosen: Option<&str>,
) -> Result<(), SourceError> {
    let mut events = Bounded::new(MAX_CHECKINS_EVENTS);
    for index in check.pages(Collection::CheckInsEvents, &Target::default(), false)? {
        match chosen {
            // The church chose one event: only it is read, and only if Check-Ins lists it.
            Some(chosen) => {
                if row_ids(&check.reads[index]).contains(&chosen) {
                    events.add(chosen);
                }
            }
            None => check.gather_rows(index, &mut events),
        }
    }
    let mut candidates: Vec<(i64, String, usize)> = Vec::new();
    for event in &events.ids {
        let target = Target::checkins_event(event);
        check.pages(Collection::CheckInsLocations, &target, false)?;
        let periods = target.within(window);
        for index in check.pages(Collection::CheckInsEventPeriods, &periods, false)? {
            for (at, time) in recent_event_times(&check.reads[index], window) {
                candidates.push((at, time.to_owned(), index));
            }
        }
    }
    // Latest first, so a bound leaves out the oldest times, never last Sunday's.
    candidates.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    let mut times = Bounded::new(MAX_CHECKINS_TIMES);
    for (_, time, index) in candidates {
        if !times.add(&time) && check.reads[index].outcome == OK {
            check.reads[index].outcome = TRUNCATED.into();
        }
    }
    for time in &times.ids {
        let target = Target::checkins_event_time(time);
        check.pages(Collection::CheckInsLocationCounts, &target, false)?;
    }
    Ok(())
}
/// Registrations, only when granted: the signups that aren't archived, then each open one's
/// active attendees (bounded), so they can be counted. No attendee's name or person is read.
fn registrations(check: &mut Check<'_>) -> Result<(), SourceError> {
    let mut signups = Bounded::new(MAX_SIGNUPS);
    for index in check.pages(Collection::RegistrationsSignups, &Target::default(), false)? {
        let open = open_signups(&check.reads[index])
            .into_iter()
            .map(str::to_owned)
            .collect();
        check.bound(index, open, &mut signups);
    }
    for signup in &signups.ids {
        check.pages(
            Collection::RegistrationsAttendees,
            &Target::signup(signup),
            false,
        )?;
    }
    Ok(())
}

/// The check without People forms, as every test before forms existed runs it.
#[cfg(test)]
pub(crate) fn run(
    auth: &AuthController,
    service_type_id: &str,
    plan_id: &str,
    kids_teams: &[String],
    cancelled: &AtomicBool,
    http: &dyn SourceHttp,
    clock: &dyn Clock,
) -> Result<(SundayCapture, ReadNames), SourceError> {
    run_with_church(
        auth,
        service_type_id,
        plan_id,
        kids_teams,
        // The reading code's own entries: everything the sign-in allows, as before. The app passes its switch.
        ChurchReads {
            operations: true,
            ..ChurchReads::default()
        },
        cancelled,
        http,
        clock,
    )
}
#[allow(clippy::too_many_arguments)]
pub(crate) fn run_with_church(
    auth: &AuthController,
    service_type_id: &str,
    plan_id: &str,
    kids_teams: &[String],
    church: ChurchReads<'_>,
    cancelled: &AtomicBool,
    http: &dyn SourceHttp,
    clock: &dyn Clock,
) -> Result<(SundayCapture, ReadNames), SourceError> {
    if !numeric_id(service_type_id)
        || !numeric_id(plan_id)
        || !kids_teams_valid(kids_teams)
        || !church.valid()
    {
        return Err(SourceError::InvalidRequest);
    }
    let started_ms = clock.now_ms();
    let started_at = rfc3339(started_ms);
    let recent = recent_window(started_ms).ok_or(SourceError::InvalidRequest)?;
    // One organization check for the whole check; every page stays pinned to it.
    let verified = auth.verify_source(cancelled)?;
    let mut check = Check {
        auth,
        verified,
        operations: church.operations,
        service_type_id,
        plan_id,
        cancelled,
        http,
        clock,
        reads: Vec::new(),
        names: BTreeMap::new(),
        read_names: BTreeSet::new(),
        labels: BTreeMap::new(),
        refused: BTreeSet::new(),
        strikes: BTreeMap::new(),
        tripped: BTreeMap::new(),
    };
    let plan = Target::default();
    check.pages(Collection::Plan, &plan, false)?;
    check.pages(Collection::PlanTimes, &plan, false)?;
    let needs = check.pages(Collection::NeededPositions, &plan, false)?;
    let members = check.pages(Collection::TeamMembers, &plan, false)?;
    let mut teams = Bounded::new(MAX_TEAMS);
    for &index in needs.iter().chain(&members) {
        check.gather(index, "team", "Team", &mut teams);
    }
    // People already scheduled on this plan come first, then candidates from assignments.
    let mut people = Bounded::new(MAX_PEOPLE);
    for &index in &members {
        check.gather(index, "person", "Person", &mut people);
    }
    let mut assignments = Vec::new();
    for team in teams.ids.clone() {
        let target = Target::team(&team);
        assignments.extend(check.pages(Collection::TeamPositionAssignments, &target, false)?);
        check.pages(Collection::TeamLeaders, &target, false)?;
    }
    for &index in &assignments {
        check.gather(index, "person", "Person", &mut people);
    }
    for person in people.ids.clone() {
        check.schedules(&person)?;
        check.pages(Collection::PersonBlockouts, &Target::person(&person), false)?;
    }
    // The church's own time zone, which decides its local Sunday for rooms and group meetings.
    // A Services read like the rest, so it is made whatever the connection's consent.
    check.pages(Collection::Organization, &plan, false)?;
    let mut on_plan: BTreeSet<String> = BTreeSet::new();
    for &index in &members {
        on_plan.extend(check.related(index, "person", "Person"));
    }
    operations(&mut check, &people, &on_plan)?;
    background_checks(&mut check, &members, kids_teams)?;
    // Church reads last: forms once the church turned them on; Check-Ins and Registrations only
    // when the saved connection was granted that product (otherwise nothing is recorded for it).
    if let Some(forms) = church.forms {
        people_forms(&mut check, forms, &recent)?;
    }
    if check.verified.scopes().check_ins() {
        check_ins(&mut check, &recent, church.checkins_event)?;
    }
    if check.verified.scopes().registrations() {
        registrations(&mut check)?;
    }
    // Names only for people this capture is about: everyone on the plan, the bounded set of
    // people whose own schedules and blockouts were planned, and who submitted a chosen form in
    // the recent window. Nobody else's name is kept.
    let mut named: BTreeSet<String> = people.ids.into_iter().collect();
    named.extend(on_plan);
    for read in check
        .reads
        .iter()
        .filter(|r| r.collection == Collection::PeopleFormSubmissions.label())
    {
        named.extend(
            related_ids(read, "person", "Person")
                .into_iter()
                .map(str::to_owned),
        );
    }
    // The guard still learns the pruned ones: a name read is a name that must not reach a model.
    check.names.retain(|id, _| named.contains(id));
    let capture = SundayCapture {
        version: 1,
        kind: "live".into(),
        organization: auth.binding().organization.clone(),
        service_type_id: service_type_id.into(),
        plan_id: plan_id.into(),
        started_at,
        completed_at: rfc3339(clock.now_ms()),
        reads: check.reads,
        names: check.names,
        // Every label names a row of a stored body: only answered pages supply them.
        labels: check.labels,
        kids_teams: kids_teams.to_vec(),
        forms: church.forms.map(<[String]>::to_vec),
        checkins_event: church.checkins_event.map(str::to_owned),
    };
    Ok((capture, ReadNames(check.read_names.into_iter().collect())))
}

// Cached fallback recordings, bound to one organization:
// `<app data>/recordings/sunday-<organization>-<plan>-<completed unix ms>.json`, 0600 in 0700.
pub const MAX_RECORDING_BYTES: u64 = 64 * 1024 * 1024;
/// Newest recordings kept per organization and plan.
pub const KEEP_RECORDINGS: usize = 5;
#[cfg(target_os = "macos")]
const O_NOFOLLOW: i32 = 0x0100;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RecordingError {
    /// Not a recording name for this organization (or not an organization id at all).
    InvalidName,
    Unavailable,
}
#[derive(Serialize)]
pub struct RecordingEntry {
    pub path_id: String,
    pub organization: String,
    pub plan_id: String,
    pub completed_at: String,
}
struct RecordingName<'a> {
    organization: &'a str,
    plan: &'a str,
    completed_ms: u64,
}
/// Bare file names only: `sunday-<organization>-<plan>-<unix ms>.json`.
fn recording_name(name: &str) -> Option<RecordingName<'_>> {
    let mut parts = name
        .strip_prefix("sunday-")?
        .strip_suffix(".json")?
        .split('-');
    let (organization, plan, ms) = (parts.next()?, parts.next()?, parts.next()?);
    let valid = parts.next().is_none()
        && numeric_id(organization)
        && numeric_id(plan)
        && (1..=20).contains(&ms.len())
        && ms.bytes().all(|b| b.is_ascii_digit());
    valid.then_some(RecordingName {
        organization,
        plan,
        completed_ms: ms.parse().ok()?,
    })
}
/// Reads must agree with each other the way the check makes them. Child reads take their id
/// from their parent read: steps and cards from a `people_workflows` row, group events from a
/// `groups_person_memberships` group, memberships from a `team_members` person, form submissions
/// from a listed form the check was given, Check-Ins rooms and periods from a listed event, room
/// counts from an event time a period read placed inside the recent window, attendees from an
/// open signup. `not-requested` is the saved connection's consent, so it marks every Calendar,
/// People and Groups read of a capture or none, and never a Services, Check-Ins or Registrations
/// read (those are only made when granted). Each label names a row of the read its prefix
/// belongs to.
fn consistent(capture: &SundayCapture) -> bool {
    let of = |collection: Collection| {
        capture
            .reads
            .iter()
            .filter(move |r| r.collection == collection.label())
    };
    let workflows: BTreeSet<&str> = of(Collection::PeopleWorkflows).flat_map(row_ids).collect();
    let groups: BTreeSet<&str> = of(Collection::GroupsPersonMemberships)
        .flat_map(|r| related_ids(r, "group", "Group"))
        .collect();
    let kids_people: BTreeSet<&str> = of(Collection::TeamMembers)
        .flat_map(|r| scheduled_on(r, &capture.kids_teams))
        .collect();
    let on_plan: BTreeSet<&str> = of(Collection::TeamMembers)
        .flat_map(|r| related_ids(r, "person", "Person"))
        .collect();
    let booked: BTreeSet<&str> = of(Collection::CalendarResourceBookings)
        .flat_map(|r| related_ids(r, "event", "Event"))
        .collect();
    let given: BTreeSet<&str> = capture.forms.iter().flatten().map(String::as_str).collect();
    let forms: BTreeSet<&str> = of(Collection::PeopleForms)
        .flat_map(row_ids)
        .filter(|id| given.contains(id))
        .collect();
    let checkins_events: BTreeSet<&str> =
        of(Collection::CheckInsEvents).flat_map(row_ids).collect();
    let recent = parse_rfc3339(&capture.started_at).and_then(recent_window);
    let event_times: BTreeSet<&str> = recent
        .as_ref()
        .map(|window| {
            of(Collection::CheckInsEventPeriods)
                .flat_map(|r| recent_event_times(r, window))
                .map(|(_, id)| id)
                .collect()
        })
        .unwrap_or_default();
    let signups: BTreeSet<&str> = of(Collection::RegistrationsSignups)
        .flat_map(open_signups)
        .collect();
    let from = |id: &Option<String>, set: &BTreeSet<&str>| {
        id.as_deref().is_some_and(|id| set.contains(id))
    };
    let provenance = capture
        .reads
        .iter()
        .all(|read| match read.collection.as_str() {
            "people_workflow_steps"
            | "people_workflow_ready_cards"
            | "people_workflow_snoozed_cards" => from(&read.workflow_id, &workflows),
            "groups_group_events" => from(&read.group_id, &groups),
            "calendar_conflicts" => from(&read.event_id, &booked),
            "groups_person_memberships" => from(&read.groups_person_id, &on_plan),
            // Only someone confirmed or pending on a kids team this check was given.
            "people_background_checks" => from(&read.people_person_id, &kids_people),
            // The form list only once the church turned forms on; submissions only for a form
            // the check was given that the list held.
            "people_forms" => capture.forms.is_some(),
            "people_form_submissions" => from(&read.form_id, &forms),
            "checkins_locations" | "checkins_event_periods" => {
                from(&read.checkins_event_id, &checkins_events)
                    && capture
                        .checkins_event
                        .as_ref()
                        .is_none_or(|chosen| read.checkins_event_id.as_ref() == Some(chosen))
            }
            "checkins_location_counts" => from(&read.checkins_event_time_id, &event_times),
            "registrations_attendees" => from(&read.signup_id, &signups),
            _ => true,
        });
    let operations: Vec<&SundayRead> = capture
        .reads
        .iter()
        .filter(|r| {
            collection_of(r).is_some_and(|c| {
                matches!(
                    c.product(),
                    Product::Calendar | Product::People | Product::Groups
                )
            })
        })
        .collect();
    let not_requested = operations
        .iter()
        .filter(|r| r.outcome == NOT_REQUESTED)
        .count();
    let consent = not_requested == 0 || not_requested == operations.len();
    let labels = capture.labels.iter().all(|(key, label)| {
        let Some((prefix, id)) = key.split_once(':') else {
            return false;
        };
        let Some((_, collection)) = crate::source::LABELLED.iter().find(|(p, _)| *p == prefix)
        else {
            return false;
        };
        numeric_id(id)
            && !label.is_empty()
            && crate::source::display_label(label) == *label
            && of(*collection).any(|read| row_ids(read).contains(&id))
    });
    provenance && consent && labels
}
/// The collection a recorded read names; `fallback` only ever marks unfiltered schedules.
fn collection_of(read: &SundayRead) -> Option<Collection> {
    Some(match (read.collection.as_str(), read.fallback) {
        ("plan", false) => Collection::Plan,
        ("plan_times", false) => Collection::PlanTimes,
        ("needed_positions", false) => Collection::NeededPositions,
        ("team_members", false) => Collection::TeamMembers,
        ("team_position_assignments", false) => Collection::TeamPositionAssignments,
        ("team_leaders", false) => Collection::TeamLeaders,
        ("person_schedules", false) => Collection::PersonSchedules,
        ("person_schedules", true) => Collection::PersonSchedulesUnfiltered,
        ("person_blockouts", false) => Collection::PersonBlockouts,
        ("organization", false) => Collection::Organization,
        ("calendar_rooms", false) => Collection::CalendarRooms,
        ("calendar_resource_bookings", false) => Collection::CalendarResourceBookings,
        ("calendar_conflicts", false) => Collection::CalendarEventConflicts,
        ("people_workflows", false) => Collection::PeopleWorkflows,
        ("people_workflow_steps", false) => Collection::PeopleWorkflowSteps,
        ("people_workflow_ready_cards", false) => Collection::PeopleWorkflowReadyCards,
        ("people_workflow_snoozed_cards", false) => Collection::PeopleWorkflowSnoozedCards,
        ("groups_person_memberships", false) => Collection::GroupsPersonMemberships,
        ("groups_group_events", false) => Collection::GroupsGroupEvents,
        ("people_background_checks", false) => Collection::PeopleBackgroundChecks,
        ("people_forms", false) => Collection::PeopleForms,
        ("people_form_submissions", false) => Collection::PeopleFormSubmissions,
        ("checkins_events", false) => Collection::CheckInsEvents,
        ("checkins_locations", false) => Collection::CheckInsLocations,
        ("checkins_event_periods", false) => Collection::CheckInsEventPeriods,
        ("checkins_location_counts", false) => Collection::CheckInsLocationCounts,
        ("registrations_signups", false) => Collection::RegistrationsSignups,
        ("registrations_attendees", false) => Collection::RegistrationsAttendees,
        _ => return None,
    })
}
/// A capture is only stored or offered if every body is exactly what the closed
/// per-collection projection would produce: no extra facts, no Person rows, no links, and no
/// free-text room, workflow or step names (those live only in `labels`).
fn valid_capture(capture: &SundayCapture) -> bool {
    let binding = Binding {
        workspace: format!("local:{}", capture.organization),
        organization: capture.organization.clone(),
        client_id: "recording".into(),
    };
    capture.version == 1
        && ["live", "recording"].contains(&capture.kind.as_str())
        && numeric_id(&capture.organization)
        && numeric_id(&capture.service_type_id)
        && numeric_id(&capture.plan_id)
        && parse_rfc3339(&capture.started_at).is_some()
        && parse_rfc3339(&capture.completed_at).is_some()
        && capture
            .names
            .iter()
            .all(|(id, name)| numeric_id(id) && name.len() <= 256)
        && capture
            .reads
            .iter()
            .all(|read| valid_read(capture, &binding, read))
        // Windowed reads follow the plan read's own date, never another Sunday; Check-Ins periods
        // and form submissions follow the check's own start, never another week.
        && {
            let window = plan_window(&capture.reads);
            let recent = parse_rfc3339(&capture.started_at).and_then(recent_window);
            capture.reads.iter().all(|read| {
                if collection_of(read).is_some_and(Collection::recent) {
                    read.window.is_some() && read.window == recent
                } else {
                    read.window.is_none() || read.window == window
                }
            })
        }
        && kids_teams_valid(&capture.kids_teams)
        && capture.forms.as_deref().is_none_or(forms_valid)
        && capture.checkins_event.as_deref().is_none_or(numeric_id)
        && consistent(capture)
}
fn valid_read(capture: &SundayCapture, binding: &Binding, read: &SundayRead) -> bool {
    let Some(collection) = collection_of(read) else {
        return false;
    };
    // Only a Calendar, People or Groups read can lack consent: Services is always requested, and
    // Check-Ins and Registrations are only read once granted.
    if read.outcome == NOT_REQUESTED
        && !matches!(
            collection.product(),
            Product::Calendar | Product::People | Product::Groups
        )
    {
        return false;
    }
    let target = Target {
        team_id: read.team_id.clone(),
        person_id: read.person_id.clone(),
        event_id: read.event_id.clone(),
        workflow_id: read.workflow_id.clone(),
        group_id: read.group_id.clone(),
        groups_person_id: read.groups_person_id.clone(),
        people_person_id: read.people_person_id.clone(),
        form_id: read.form_id.clone(),
        checkins_event_id: read.checkins_event_id.clone(),
        checkins_event_time_id: read.checkins_event_time_id.clone(),
        signup_id: read.signup_id.clone(),
        window: read.window.clone(),
    };
    let Ok(request) = SourceRequest::capture_at(
        binding,
        &capture.service_type_id,
        &capture.plan_id,
        collection,
        &target,
        PER_PAGE,
        read.offset,
    ) else {
        return false;
    };
    let answered = read.outcome == OK || read.outcome == TRUNCATED;
    if parse_rfc3339(&read.checked_at).is_none()
        || !OUTCOMES.contains(&read.outcome.as_str())
        || answered != read.body.is_some()
    {
        return false;
    }
    let Some(body) = &read.body else {
        return true;
    };
    // Stored bodies never keep links (consumed) or Person rows (moved to `names`), except a form
    // submission's proof that its linked person isn't a child, which carries nothing else.
    let proof = |row: &Value| {
        collection == Collection::PeopleFormSubmissions
            && row["attributes"] == serde_json::json!({"child":false})
    };
    if !body.as_object().is_some_and(|map| {
        map.keys()
            .all(|k| ["data", "included", "meta"].contains(&k.as_str()))
    }) || body["included"].as_array().is_some_and(|rows| {
        rows.iter()
            .any(|row| row["type"] == "Person" && !proof(row))
    }) {
        return false;
    }
    // Every person a submission links has that proof in the same body: a recording made before the
    // proof existed, or one a child's link was put back into, can't load.
    if collection == Collection::PeopleFormSubmissions {
        let proven: BTreeSet<&str> = body["included"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|row| row["type"] == "Person")
            .filter_map(|row| row["id"].as_str())
            .collect();
        if related_ids(read, "person", "Person")
            .iter()
            .any(|id| !proven.contains(id))
        {
            return false;
        }
    }
    serde_json::to_vec(body)
        .ok()
        .and_then(|bytes| crate::source::project_page(&request, &bytes, &BTreeMap::new()).ok())
        .is_some_and(|page| page.body() == body)
}
fn private_dir(dir: &Path) -> io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(dir)?;
    // An existing directory may predate this rule; tighten it too.
    #[cfg(unix)]
    std::fs::set_permissions(dir, std::os::unix::fs::PermissionsExt::from_mode(0o700))?;
    Ok(())
}
/// Saves a finished capture and keeps only the newest KEEP_RECORDINGS for its org and plan.
pub fn save_recording(dir: &Path, capture: &SundayCapture) -> io::Result<String> {
    let completed = parse_rfc3339(&capture.completed_at).ok_or(io::ErrorKind::InvalidData)?;
    if !valid_capture(capture) {
        return Err(io::ErrorKind::InvalidData.into());
    }
    let name = format!(
        "sunday-{}-{}-{completed}.json",
        capture.organization, capture.plan_id
    );
    let bytes = serde_json::to_vec(capture).map_err(io::Error::other)?;
    if bytes.len() as u64 > MAX_RECORDING_BYTES {
        return Err(io::ErrorKind::InvalidData.into());
    }
    private_dir(dir)?;
    // Written aside then renamed, so a listed recording is never half-written.
    let partial = dir.join(format!(".{name}.partial"));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let written = options.open(&partial).and_then(|mut file| {
        file.write_all(&bytes)?;
        file.sync_all()
    });
    if let Err(error) = written.and_then(|()| std::fs::rename(&partial, dir.join(&name))) {
        let _ = std::fs::remove_file(&partial);
        return Err(error);
    }
    let mut same: Vec<(u64, String)> = std::fs::read_dir(dir)?
        .flatten()
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter_map(|file| {
            let parsed = recording_name(&file)?;
            (parsed.organization == capture.organization && parsed.plan == capture.plan_id)
                .then(|| (parsed.completed_ms, file.clone()))
        })
        .collect();
    same.sort_by(|a, b| b.cmp(a));
    for (_, old) in same.into_iter().skip(KEEP_RECORDINGS) {
        let _ = std::fs::remove_file(dir.join(old));
    }
    Ok(name)
}
/// One organization's saved capture, always labeled `recording` so it is never shown as a
/// current check. Usable without a live session: it is the offline fallback.
pub fn load_recording(
    dir: &Path,
    organization: &str,
    path_id: &str,
) -> Result<SundayCapture, RecordingError> {
    let name = recording_name(path_id)
        .filter(|name| numeric_id(organization) && name.organization == organization)
        .ok_or(RecordingError::InvalidName)?;
    let path = dir.join(path_id);
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(target_os = "macos")]
    std::os::unix::fs::OpenOptionsExt::custom_flags(&mut options, O_NOFOLLOW);
    #[cfg(not(target_os = "macos"))]
    if !std::fs::symlink_metadata(&path).is_ok_and(|meta| meta.file_type().is_file()) {
        return Err(RecordingError::Unavailable);
    }
    let file = options
        .open(&path)
        .map_err(|_| RecordingError::Unavailable)?;
    let meta = file.metadata().map_err(|_| RecordingError::Unavailable)?;
    if !meta.is_file() || meta.len() > MAX_RECORDING_BYTES {
        return Err(RecordingError::Unavailable);
    }
    let mut bytes = Vec::new();
    file.take(MAX_RECORDING_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| RecordingError::Unavailable)?;
    if bytes.len() as u64 > MAX_RECORDING_BYTES {
        return Err(RecordingError::Unavailable);
    }
    let mut capture: SundayCapture =
        serde_json::from_slice(&bytes).map_err(|_| RecordingError::Unavailable)?;
    if capture.organization != organization
        || capture.plan_id != name.plan
        || parse_rfc3339(&capture.completed_at) != Some(name.completed_ms)
        || !valid_capture(&capture)
    {
        return Err(RecordingError::Unavailable);
    }
    capture.kind = "recording".into();
    Ok(capture)
}
/// One organization's recordings, newest first, from file names alone (content is checked
/// on load). A missing directory is an empty list.
pub fn list_recordings(dir: &Path, organization: &str) -> io::Result<Vec<RecordingEntry>> {
    if !numeric_id(organization) {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let entries = match std::fs::read_dir(dir) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        result => result?,
    };
    let mut listed = Vec::new();
    for entry in entries.flatten() {
        let Ok(file) = entry.file_name().into_string() else {
            continue;
        };
        let Some(name) = recording_name(&file).filter(|n| n.organization == organization) else {
            continue;
        };
        if !std::fs::symlink_metadata(entry.path())
            .is_ok_and(|meta| meta.file_type().is_file() && meta.len() <= MAX_RECORDING_BYTES)
        {
            continue;
        }
        listed.push((
            name.completed_ms,
            RecordingEntry {
                organization: organization.into(),
                plan_id: name.plan.into(),
                completed_at: rfc3339(name.completed_ms),
                path_id: file,
            },
        ));
    }
    listed.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.path_id.cmp(&a.1.path_id)));
    Ok(listed.into_iter().map(|(_, entry)| entry).collect())
}
/// Removes every saved recording (and unfinished save) for one organization.
pub fn delete_recordings(dir: &Path, organization: &str) -> io::Result<usize> {
    if !numeric_id(organization) {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let entries = match std::fs::read_dir(dir) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(0),
        result => result?,
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let Ok(file) = entry.file_name().into_string() else {
            continue;
        };
        let bare = file
            .strip_prefix('.')
            .and_then(|f| f.strip_suffix(".partial"))
            .unwrap_or(&file);
        if recording_name(bare).is_some_and(|n| n.organization == organization) {
            std::fs::remove_file(entry.path())?;
            removed += 1;
        }
    }
    Ok(removed)
}

/// Deletes one organization's recordings of the given plans only (a service no longer watched, with
/// the plans Ozzie watched of it), and their unfinished `.partial` files; the organization's other
/// plans keep theirs. Every plan must be a numeric id: anything else deletes nothing.
pub fn delete_plan_recordings(
    dir: &Path,
    organization: &str,
    plans: &[String],
) -> io::Result<usize> {
    if !numeric_id(organization) || plans.is_empty() || plans.iter().any(|p| !numeric_id(p)) {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let entries = match std::fs::read_dir(dir) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(0),
        result => result?,
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let Ok(file) = entry.file_name().into_string() else {
            continue;
        };
        let bare = file
            .strip_prefix('.')
            .and_then(|f| f.strip_suffix(".partial"))
            .unwrap_or(&file);
        if recording_name(bare)
            .is_some_and(|n| n.organization == organization && plans.iter().any(|p| p == n.plan))
        {
            std::fs::remove_file(entry.path())?;
            removed += 1;
        }
    }
    Ok(removed)
}

/// The Sunday check, setup's picker, filling in To on a note (contact.rs) and a change a person
/// approved (change.rs) share one Planning Center connection, so they take turns: one reader at a
/// time, the whole time it uses the connection. A second check, note or change is refused at once
/// rather than queued. A check waits out a picker read, a note or a change (each bounded; a change
/// at most `change::LONGEST_TURN`, which the desktop app's check waits longer than) so it never
/// records `busy` gaps because of them; a picker read waits for the others up to its own bound and
/// can answer busy; a note or a change never waits, and says it couldn't go ahead instead. With nobody else reading, a turn is taken at once and nothing about the
/// reader changes. (Moved from the desktop app's main.rs, so the rule lives in core.)
#[derive(Clone, Default)]
pub struct Turns(std::sync::Arc<(std::sync::Mutex<Option<Reader>>, std::sync::Condvar)>);
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reader {
    Check,
    Picker,
    /// Filling in To on a note: one person's email address or mobile number (contact.rs).
    Note,
    /// A change a person approved: its fresh reads and its one write (change.rs).
    Change,
}
/// A held turn; dropping it lets the next reader in.
pub struct Turn(Turns);
impl Drop for Turn {
    fn drop(&mut self) {
        let (held, freed) = &*(self.0).0;
        *held.lock().unwrap_or_else(|e| e.into_inner()) = None;
        freed.notify_all();
    }
}
impl Turns {
    /// The turn for `reader`, waiting up to `wait` for whoever holds it; `Busy` past that, and at
    /// once for a second check or a second note.
    pub fn take(&self, reader: Reader, wait: Duration) -> Result<Turn, SourceError> {
        let (held, freed) = &*self.0;
        let deadline = Instant::now() + wait;
        let mut current = held.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            match *current {
                None => {
                    *current = Some(reader);
                    return Ok(Turn(self.clone()));
                }
                Some(holder) if holder == reader && reader != Reader::Picker => {
                    return Err(SourceError::Busy);
                }
                Some(_) => {
                    let left = deadline.saturating_duration_since(Instant::now());
                    if left.is_zero() {
                        return Err(SourceError::Busy);
                    }
                    current = freed
                        .wait_timeout(current, left)
                        .unwrap_or_else(|e| e.into_inner())
                        .0;
                }
            }
        }
    }
    /// The turn for `reader` only if nobody holds it now; otherwise who does. Never waits.
    pub fn take_now(&self, reader: Reader) -> Result<Turn, Reader> {
        let mut current = self.0.0.lock().unwrap_or_else(|e| e.into_inner());
        match *current {
            None => {
                *current = Some(reader);
                Ok(Turn(self.clone()))
            }
            Some(holder) => Err(holder),
        }
    }
}

#[cfg(test)]
#[path = "sunday_check_tests.rs"]
mod tests;
