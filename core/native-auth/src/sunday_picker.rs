//! Choosing the Sunday in setup: the church's Services service types, then one type's upcoming
//! plans, so a person picks a plan instead of typing its ids. Read-only: each list is one GET
//! through the same verified, allowlisted source path as the Sunday check (`source.rs`), after the
//! same organization check:
//!
//!   `/services/v2/service_types?per_page=100&offset=0`
//!   `/services/v2/service_types/{id}/plans?filter=future&order=sort_date&per_page=12&offset=0`
//!
//! Nothing is saved; the webview stores only the two ids the person chose, as typing them did.
//! Service type names and plan titles are display text for this Mac, never model input.
//!
//! First run (onboarding spec S5a, decision 18) asks once for everything it needs to pick the service itself
//! (`pick_service`): the service types, each type's upcoming plans, the next plan's service times
//! (`.../plans/{id}/plan_times`) and the church's time zone (`/services/v2`, its time zone only). After a plan has
//! passed, `next_plan` finds that same service type's next plan (spec §5.3). Same allow-listed GETs, nothing saved.
use crate::{
    oauth::AuthController,
    source::{Collection, NativeSourceHttp, SourceError, SourceHttp, SourceRequest, Target},
};
use serde::Serialize;
use serde_json::Value;
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

/// Service types read at once; a church with more is told the list stops there.
pub const SERVICE_TYPES: u16 = 100;
/// Upcoming plans offered for one service type, soonest first.
pub const UPCOMING: u16 = 12;
/// Service types whose plans `pick_service` reads; any past these are listed as not read (`more`).
pub const PICK_TYPES: usize = 20;
/// Service times read for one plan.
pub const PLAN_TIMES: u16 = 25;
/// How long a picker read waits for the connection to finish something else (another picker
/// read, a status refresh) before it answers `busy`.
pub const WAIT_FOR_CONTROLLER: Duration = Duration::from_secs(10);
const RETRY_EVERY: Duration = Duration::from_millis(25);

/// `attempt` again while the controller answers `Busy`, until `limit` or a cancel. The controller
/// refuses before any credential or network use, so a retry repeats nothing that was sent.
fn waiting<T>(
    limit: Duration,
    cancelled: &AtomicBool,
    mut attempt: impl FnMut() -> Result<T, SourceError>,
) -> Result<T, SourceError> {
    let started = Instant::now();
    loop {
        match attempt() {
            Err(SourceError::Busy) if started.elapsed() < limit => {
                if cancelled.load(Ordering::SeqCst) {
                    return Err(SourceError::Cancelled);
                }
                std::thread::sleep(RETRY_EVERY);
            }
            result => return result,
        }
    }
}

/// Intentionally not Debug: names are display text for this Mac only.
#[derive(Serialize)]
pub struct ServiceTypeChoice {
    pub id: String,
    /// Planning Center's name for it, in local display form; absent when it has none.
    pub name: Option<String>,
}
/// Intentionally not Debug: titles are display text for this Mac only.
#[derive(Serialize)]
pub struct PlanChoice {
    pub id: String,
    /// Planning Center's local wall-clock `sort_date` (its `Z` is not UTC).
    pub sort_date: String,
    pub dates: Option<String>,
    pub title: Option<String>,
    pub series_title: Option<String>,
}
#[derive(Serialize)]
pub struct Choices<T> {
    pub items: Vec<T>,
    /// Planning Center has more than this one page held.
    pub more: bool,
}

pub fn service_types(
    auth: &AuthController,
    cancelled: &AtomicBool,
) -> Result<Choices<ServiceTypeChoice>, SourceError> {
    service_types_using(auth, cancelled, &NativeSourceHttp::new()?)
}
pub fn upcoming_plans(
    auth: &AuthController,
    service_type_id: &str,
    cancelled: &AtomicBool,
) -> Result<Choices<PlanChoice>, SourceError> {
    upcoming_plans_using(auth, service_type_id, cancelled, &NativeSourceHttp::new()?)
}

/// One page of `collection`, verified against this controller's organization first. Waits up to
/// `WAIT_FOR_CONTROLLER` while the connection finishes something else.
fn read(
    auth: &AuthController,
    service_type_id: &str,
    collection: Collection,
    per_page: u16,
    cancelled: &AtomicBool,
    http: &dyn SourceHttp,
) -> Result<crate::source::SourcePage, SourceError> {
    read_at(
        auth,
        service_type_id,
        "",
        collection,
        per_page,
        cancelled,
        http,
    )
}
/// `read` naming a plan too (its service times, or the church's time zone read in a plan's context).
fn read_at(
    auth: &AuthController,
    service_type_id: &str,
    plan_id: &str,
    collection: Collection,
    per_page: u16,
    cancelled: &AtomicBool,
    http: &dyn SourceHttp,
) -> Result<crate::source::SourcePage, SourceError> {
    let request = SourceRequest::capture_at(
        auth.binding(),
        service_type_id,
        plan_id,
        collection,
        &Target::default(),
        per_page,
        0,
    )?;
    waiting(WAIT_FOR_CONTROLLER, cancelled, || {
        auth.read_source_using(&request, cancelled, http)
    })
}
fn rows(body: &Value) -> &[Value] {
    body["data"].as_array().map_or(&[], Vec::as_slice)
}
fn text(row: &Value, key: &str) -> Option<String> {
    row["attributes"][key].as_str().map(str::to_owned)
}
/// A next link (already checked against the request) or a total beyond this page.
fn more(body: &Value) -> bool {
    body["links"]["next"].is_string()
        || body["meta"]["total_count"]
            .as_u64()
            .is_some_and(|total| total > rows(body).len() as u64)
}

pub(crate) fn service_types_using(
    auth: &AuthController,
    cancelled: &AtomicBool,
    http: &dyn SourceHttp,
) -> Result<Choices<ServiceTypeChoice>, SourceError> {
    let page = read(
        auth,
        "",
        Collection::ServiceTypes,
        SERVICE_TYPES,
        cancelled,
        http,
    )?;
    let body = page.body();
    let items = rows(body)
        .iter()
        // An archived or deleted service type has no Sunday to choose.
        .filter(|row| {
            row["attributes"]["archived_at"].is_null() && row["attributes"]["deleted_at"].is_null()
        })
        .filter_map(|row| row["id"].as_str())
        .map(|id| ServiceTypeChoice {
            id: id.into(),
            name: page.labels().get(&format!("service_type:{id}")).cloned(),
        })
        .collect();
    Ok(Choices {
        items,
        more: more(body),
    })
}

pub(crate) fn upcoming_plans_using(
    auth: &AuthController,
    service_type_id: &str,
    cancelled: &AtomicBool,
    http: &dyn SourceHttp,
) -> Result<Choices<PlanChoice>, SourceError> {
    let page = read(
        auth,
        service_type_id,
        Collection::UpcomingPlans,
        UPCOMING,
        cancelled,
        http,
    )?;
    let body = page.body();
    let mut items: Vec<PlanChoice> = rows(body)
        .iter()
        .filter_map(|row| {
            Some(PlanChoice {
                id: row["id"].as_str()?.into(),
                // An undated plan has no Sunday to check.
                sort_date: text(row, "sort_date")?,
                dates: text(row, "dates"),
                title: text(row, "title"),
                series_title: text(row, "series_title"),
            })
        })
        .collect();
    // Soonest first even if the order wasn't applied; same-day plans keep Planning Center's order.
    items.sort_by(|a, b| a.sort_date.cmp(&b.sort_date));
    Ok(Choices {
        items,
        more: more(body),
    })
}

/// A service type's next plan, with what the page needs to say its real day (decision 18).
/// Intentionally not Debug: titles are display text for this Mac only.
#[derive(Serialize)]
pub struct PlanNext {
    pub id: String,
    /// Planning Center's local wall-clock `sort_date` (its `Z` is not UTC).
    pub sort_date: String,
    /// The local date of `sort_date`, `YYYY-MM-DD`.
    pub date: String,
    /// The weekday of `date`: "monday" … "sunday".
    pub weekday: &'static str,
    pub dates: Option<String>,
    pub title: Option<String>,
    pub series_title: Option<String>,
    /// The UTC starts of the plan's service times (rehearsals and other times left out), soonest first.
    pub times: Vec<String>,
    /// False when the times couldn't be read: the page uses `sort_date`'s time.
    pub times_read: bool,
}
/// Intentionally not Debug: names are display text for this Mac only.
#[derive(Serialize)]
pub struct ServiceChoice {
    pub id: String,
    pub name: Option<String>,
    /// None: no upcoming plan (or its plans weren't read: see `problem`).
    pub next: Option<PlanNext>,
    /// This type's plans weren't read: the sanitized reason only.
    pub problem: Option<&'static str>,
}
#[derive(Serialize)]
pub struct ServicePick {
    /// Soonest next plan first (ties in Planning Center's order), then the types with nothing planned.
    pub services: Vec<ServiceChoice>,
    /// The church's time zone (Services), for the page's day words; None if it couldn't be read.
    pub time_zone: Option<String>,
    /// More service types than were read.
    pub more: bool,
}

pub fn pick_service(
    auth: &AuthController,
    cancelled: &AtomicBool,
) -> Result<ServicePick, SourceError> {
    pick_service_using(auth, cancelled, &NativeSourceHttp::new()?)
}
pub fn next_plan(
    auth: &AuthController,
    service_type_id: &str,
    after_date: &str,
    cancelled: &AtomicBool,
) -> Result<Option<PlanNext>, SourceError> {
    next_plan_using(
        auth,
        service_type_id,
        after_date,
        cancelled,
        &NativeSourceHttp::new()?,
    )
}

/// A plan with a usable local date, before its times are read.
fn dated(plan: PlanChoice) -> Option<(u64, PlanNext)> {
    let day = crate::civil::day_of_text(&plan.sort_date)?;
    Some((
        day,
        PlanNext {
            date: plan.sort_date[..10].to_owned(),
            weekday: crate::civil::weekday(day),
            id: plan.id,
            sort_date: plan.sort_date,
            dates: plan.dates,
            title: plan.title,
            series_title: plan.series_title,
            times: Vec::new(),
            times_read: false,
        },
    ))
}
/// A plan's service times: `time_type` "service" (or none given); rehearsals and other times are left out.
fn with_times(
    auth: &AuthController,
    service_type_id: &str,
    mut plan: PlanNext,
    cancelled: &AtomicBool,
    http: &dyn SourceHttp,
) -> Result<PlanNext, SourceError> {
    match read_at(
        auth,
        service_type_id,
        &plan.id,
        Collection::PlanTimes,
        PLAN_TIMES,
        cancelled,
        http,
    ) {
        Ok(page) => {
            let mut times: Vec<String> = rows(page.body())
                .iter()
                .filter(|row| {
                    let kind = &row["attributes"]["time_type"];
                    kind.is_null() || kind.as_str() == Some("service")
                })
                .filter_map(|row| row["attributes"]["starts_at"].as_str().map(str::to_owned))
                .collect();
            times.sort();
            times.dedup();
            plan.times = times;
            plan.times_read = true;
            Ok(plan)
        }
        // Quitting or disconnecting ends the whole read; any other failure only loses the times.
        Err(SourceError::Cancelled) => Err(SourceError::Cancelled),
        Err(_) => Ok(plan),
    }
}
/// The church's time zone, read in one plan's context (Services' organization: its time zone only).
fn time_zone(
    auth: &AuthController,
    service_type_id: &str,
    plan_id: &str,
    cancelled: &AtomicBool,
    http: &dyn SourceHttp,
) -> Option<String> {
    let page = read_at(
        auth,
        service_type_id,
        plan_id,
        Collection::Organization,
        1,
        cancelled,
        http,
    )
    .ok()?;
    let body = page.body();
    let data = if body["data"].is_array() {
        &body["data"][0]
    } else {
        &body["data"]
    };
    data["attributes"]["time_zone"].as_str().map(str::to_owned)
}
/// The first upcoming plan in `plans` (soonest first) whose local date is after `after` (a day count), if any.
fn first_after(plans: Vec<PlanChoice>, after: Option<u64>) -> Option<PlanNext> {
    plans
        .into_iter()
        .filter_map(dated)
        .find(|(day, _)| after.is_none_or(|after| *day > after))
        .map(|(_, plan)| plan)
}

pub(crate) fn pick_service_using(
    auth: &AuthController,
    cancelled: &AtomicBool,
    http: &dyn SourceHttp,
) -> Result<ServicePick, SourceError> {
    let types = service_types_using(auth, cancelled, http)?;
    let more = types.more || types.items.len() > PICK_TYPES;
    let mut planned: Vec<(u64, String, ServiceChoice)> = Vec::new();
    let mut unplanned: Vec<ServiceChoice> = Vec::new();
    for (at, service) in types.items.into_iter().enumerate() {
        let mut choice = ServiceChoice {
            id: service.id,
            name: service.name,
            next: None,
            problem: None,
        };
        if at >= PICK_TYPES {
            choice.problem = Some("not-read");
            unplanned.push(choice);
            continue;
        }
        match upcoming_plans_using(auth, &choice.id, cancelled, http) {
            Ok(plans) => {
                if let Some(next) = first_after(plans.items, None) {
                    let next = with_times(auth, &choice.id, next, cancelled, http)?;
                    let day = crate::civil::day_of_text(&next.sort_date).unwrap_or(u64::MAX);
                    let key = next.sort_date.clone();
                    choice.next = Some(next);
                    planned.push((day, key, choice));
                    continue;
                }
                unplanned.push(choice);
            }
            Err(SourceError::Cancelled) => return Err(SourceError::Cancelled),
            Err(error) => {
                choice.problem = Some(error.reason());
                unplanned.push(choice);
            }
        }
    }
    // Soonest first; a stable sort keeps Planning Center's order for ties.
    planned.sort_by(|a, b| (a.0, &a.1).cmp(&(b.0, &b.1)));
    let time_zone = planned.first().and_then(|(_, _, first)| {
        let plan = first.next.as_ref()?;
        time_zone(auth, &first.id, &plan.id, cancelled, http)
    });
    let services = planned
        .into_iter()
        .map(|(_, _, choice)| choice)
        .chain(unplanned)
        .collect();
    Ok(ServicePick {
        services,
        time_zone,
        more,
    })
}

pub(crate) fn next_plan_using(
    auth: &AuthController,
    service_type_id: &str,
    after_date: &str,
    cancelled: &AtomicBool,
    http: &dyn SourceHttp,
) -> Result<Option<PlanNext>, SourceError> {
    let after = (after_date.len() == 10)
        .then(|| crate::civil::day_of_text(after_date))
        .flatten()
        .ok_or(SourceError::InvalidRequest)?;
    let plans = upcoming_plans_using(auth, service_type_id, cancelled, http)?;
    first_after(plans.items, Some(after))
        .map(|next| with_times(auth, service_type_id, next, cancelled, http))
        .transpose()
}

#[cfg(test)]
#[path = "sunday_picker_tests.rs"]
mod tests;
