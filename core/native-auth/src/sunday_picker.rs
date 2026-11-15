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
    let request = SourceRequest::capture_at(
        auth.binding(),
        service_type_id,
        "",
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

#[cfg(test)]
#[path = "sunday_picker_tests.rs"]
mod tests;
