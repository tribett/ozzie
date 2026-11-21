//! "Let Ozzie make changes you confirm, one at a time" (core `change`; the write-back design).
//! The one change: add one person a Sunday check listed as able to help to an open role in Planning
//! Center, unconfirmed, with Planning Center's request waiting and not sent; and its undo.
//!
//! These six commands are the only way the page reaches it, and core decides everything:
//!
//! - `changes_status` and `changes_set`: the switch for the church in use (core `ChangeSwitch`, off
//!   by default, saved by organization id in the app's data folder).
//! - Planning Center only (owner decision 2026-11-21): while this Mac keeps a key for B1 Church or
//!   Breeze (the church plans its services there, and Ozzie only reads it), every command below
//!   refuses before the switch, a renewal, a turn or a read (`other_system_in_use`), whatever the
//!   page sends. A church on Genesis as its system has no Planning Center sign-in (switching to it
//!   disconnects Planning Center, which turns its switch off), so nothing is on there either.
//! - `change_prepare`: the page names an open role (its team and Planning Center's name for the
//!   position, as the check on screen read them) and one person; core checks them against the
//!   church's last live check, reads Planning Center again and returns what the confirmation shows.
//! - `change_confirm`: the leader's yes to that one prepared change, and, when the confirmation
//!   advised against it, their separate choice to go ahead despite that exact advice. The only caller
//!   of `Changes::carry_out`.
//! - `change_undo`: takes off again a row this session made, while it is still unconfirmed with the
//!   request unsent. The only caller of `Changes::undo`.
//! - `change_history`: the church's records for What happened (ids, codes and times only).
//!
//! Each change reads and writes through the session's connection with its sign-in renewed first when
//! needed (`renewed_auth`); core checks the church with Planning Center before it reads or writes. No
//! model route, agent step, task ledger, copy for other AI apps or Siri, notice, timer or
//! responsibility reaches this file (tests below), and nothing here prints, logs or keeps a name.
use ozzie_native_auth::{
    change::{
        BackgroundCheck, ChangeId, ChangeLog, ChangeRecord, ChangeSwitch, Changes, Confirmation,
        DespiteTheAdvice, Outcome, Proposed, Refusal, Undone,
    },
    oauth::numeric_id,
    sunday_check::SundayCapture,
};
use tauri::Manager;

/// The most records What happened asks for at once.
const MAX_HISTORY: usize = 200;

/// This session's changes (core `Changes`), held by the app; main.rs names it only by this name.
pub(crate) type ChangesState = Changes;
pub(crate) fn state() -> ChangesState {
    Changes::default()
}
/// At start: where every write's record is kept.
pub(crate) fn setup(app: &tauri::AppHandle) {
    if let Ok(dir) = app.path().app_data_dir() {
        app.state::<Changes>().keep_log(ChangeLog::at(&dir));
    }
}
/// A check the page now shows (live or a recording): only a live one can make a change.
pub(crate) fn checked(changes: &Changes, capture: &SundayCapture) {
    changes.remember(capture);
}
/// The church Ozzie used is left (Disconnect, or a switch to another church), whatever state its
/// sign-in was in: everything about its changes is dropped, and changes are turned off for it.
pub(crate) fn left(app: &tauri::AppHandle, changes: &Changes, organization: Option<&str>) {
    left_in(
        app.path().app_data_dir().ok().as_deref(),
        changes,
        organization,
    );
}
pub(crate) fn left_in(
    dir: Option<&std::path::Path>,
    changes: &Changes,
    organization: Option<&str>,
) {
    match (organization, dir) {
        (Some(organization), Some(dir)) => changes.left(&ChangeSwitch::at(dir), organization),
        _ => changes.forget(),
    }
}

fn switch(app: &tauri::AppHandle) -> Option<ChangeSwitch> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| ChangeSwitch::at(&dir))
}
/// The church in use, by the session's connection as it is (never renewed for this).
fn in_use(consumer: &crate::Consumer) -> Option<String> {
    crate::session_auth(consumer)
        .ok()
        .map(|auth| auth.bound_to().1.to_owned())
}
/// A church on B1 Church or Breeze uses this Mac (a key for one is saved): Planning Center is never
/// changed from here then (church_systems.rs `service_system_saved`, Keychain attributes only).
fn other_system_in_use() -> bool {
    crate::church_systems::service_system_saved()
}
/// The switch, when a change may go ahead: not while another system is the church's (`other_system`),
/// and only when changes are on for the church the session is bound to (`church`). Asked before
/// anything else: no renewal, no turn and no read happen otherwise.
fn gate(
    other_system: bool,
    church: Option<String>,
    switch: Option<ChangeSwitch>,
) -> Result<ChangeSwitch, Refusal> {
    if other_system {
        return Err(Refusal::OtherSystem);
    }
    match (church, switch) {
        (Some(organization), Some(switch)) if switch.is_on(&organization) => Ok(switch),
        _ => Err(Refusal::Off),
    }
}
fn gate_for_session(
    app: &tauri::AppHandle,
    consumer: &crate::Consumer,
) -> Result<ChangeSwitch, Refusal> {
    gate(
        other_system_in_use(),
        crate::bound_church(consumer),
        switch(app),
    )
}
/// The switch as `changes_status` says it: off while another system is the church's.
fn shown_on(other_system: bool, organization: Option<&str>, switch: Option<&ChangeSwitch>) -> bool {
    !other_system
        && match (organization, switch) {
            (Some(organization), Some(switch)) => switch.is_on(organization),
            _ => false,
        }
}
/// The leader's separate choice to go ahead despite the advice, from the page's own argument for it
/// and nothing else: absent or anything but a fact's name is no choice at all.
fn despite_from(text: Option<&str>) -> Option<DespiteTheAdvice> {
    text.and_then(BackgroundCheck::parse)
        .map(DespiteTheAdvice::about)
}

/// The switch as the page shows it: for the church in use, off when none is connected.
#[derive(serde::Serialize)]
pub(crate) struct SwitchView {
    organization: Option<String>,
    on: bool,
}
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum SwitchError {
    NotConnected,
    Unavailable,
    /// B1 Church or Breeze is the church's system on this Mac: it can't be turned on.
    OtherSystem,
}

#[tauri::command]
pub(crate) async fn changes_status(
    app: tauri::AppHandle,
    consumer: tauri::State<'_, crate::Consumer>,
) -> Result<SwitchView, SwitchError> {
    let consumer = consumer.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let organization = in_use(&consumer);
        let on = shown_on(
            other_system_in_use(),
            organization.as_deref(),
            switch(&app).as_ref(),
        );
        Ok(SwitchView { organization, on })
    })
    .await
    .map_err(|_| SwitchError::Unavailable)?
}

/// Turns changes on or off for the church in use, and for no other.
#[tauri::command]
pub(crate) async fn changes_set(
    app: tauri::AppHandle,
    consumer: tauri::State<'_, crate::Consumer>,
    changes: tauri::State<'_, Changes>,
    on: bool,
) -> Result<SwitchView, SwitchError> {
    let consumer = consumer.inner().clone();
    let changes = changes.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Turning it off is always allowed; on, never while another system is the church's.
        if on && other_system_in_use() {
            return Err(SwitchError::OtherSystem);
        }
        let organization = in_use(&consumer).ok_or(SwitchError::NotConnected)?;
        let switch = switch(&app).ok_or(SwitchError::Unavailable)?;
        // Off also drops anything waiting for a yes and the rows made (core `Changes::turn`).
        let on = changes
            .turn(&switch, &organization, on)
            .map_err(|_| SwitchError::Unavailable)?;
        Ok(SwitchView {
            on,
            organization: Some(organization),
        })
    })
    .await
    .map_err(|_| SwitchError::Unavailable)?
}

/// Prepares adding `person` to the open role `position` on `team` of `plan`, as the check on screen read
/// them, and reads Planning Center again for the confirmation. `kids_team_ids`: the teams the church
/// marked as kids teams (Church rules). The switch and the ids are checked before anything else.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub(crate) async fn change_prepare(
    app: tauri::AppHandle,
    consumer: tauri::State<'_, crate::Consumer>,
    checks: tauri::State<'_, crate::SundayChecks>,
    changes: tauri::State<'_, Changes>,
    plan: String,
    team: String,
    position: String,
    person: String,
    kids_team_ids: Option<Vec<String>>,
) -> Result<Proposed, Refusal> {
    let kids = kids_team_ids.unwrap_or_default();
    if !numeric_id(&plan)
        || !numeric_id(&team)
        || !numeric_id(&person)
        || kids.len() > 10
        || !kids.iter().all(|id| numeric_id(id))
    {
        return Err(Refusal::NotInThisCheck);
    }
    let consumer = consumer.inner().clone();
    let turns = checks.inner().clone();
    let changes = changes.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let switch = gate_for_session(&app, &consumer)?;
        changes.prepare(
            &switch,
            &turns,
            &plan,
            &team,
            &position,
            &person,
            &kids,
            || crate::renewed_auth(&consumer).ok().map(|(auth, _)| auth),
        )
    })
    .await
    .map_err(|_| Refusal::CouldNotCheck)?
}

/// The leader's yes to the one prepared change `change`. `despite_advice`: their separate choice to go
/// ahead although the confirmation advised against it, naming the fact it showed; anything else in
/// it is no choice at all.
#[tauri::command]
pub(crate) async fn change_confirm(
    app: tauri::AppHandle,
    consumer: tauri::State<'_, crate::Consumer>,
    checks: tauri::State<'_, crate::SundayChecks>,
    changes: tauri::State<'_, Changes>,
    change: String,
    despite_advice: Option<String>,
) -> Result<Outcome, Refusal> {
    let Some(id) = ChangeId::parse(&change) else {
        return Ok(Outcome::NotMade {
            reason: Refusal::UnknownChange,
        });
    };
    let despite = despite_from(despite_advice.as_deref());
    let consumer = consumer.inner().clone();
    let turns = checks.inner().clone();
    let changes = changes.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let switch = match gate_for_session(&app, &consumer) {
            Ok(switch) => switch,
            Err(reason) => return Outcome::NotMade { reason },
        };
        changes.carry_out(
            &switch,
            &turns,
            &id,
            Confirmation::OnScreen,
            despite,
            || crate::renewed_auth(&consumer).ok().map(|(auth, _)| auth),
        )
    })
    .await
    .map_err(|_| Refusal::CouldNotCheck)
}

/// Takes off again a row this session made (`row`, from that change's record).
#[tauri::command]
pub(crate) async fn change_undo(
    app: tauri::AppHandle,
    consumer: tauri::State<'_, crate::Consumer>,
    checks: tauri::State<'_, crate::SundayChecks>,
    changes: tauri::State<'_, Changes>,
    row: String,
) -> Result<Undone, Refusal> {
    if !numeric_id(&row) {
        return Ok(Undone::NotRemoved {
            reason: Refusal::NotOzziesChange,
        });
    }
    let consumer = consumer.inner().clone();
    let turns = checks.inner().clone();
    let changes = changes.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let switch = match gate_for_session(&app, &consumer) {
            Ok(switch) => switch,
            Err(reason) => return Undone::NotRemoved { reason },
        };
        changes.undo(&switch, &turns, &row, Confirmation::OnScreen, || {
            crate::renewed_auth(&consumer).ok().map(|(auth, _)| auth)
        })
    })
    .await
    .map_err(|_| Refusal::CouldNotCheck)
}

/// The records for What happened of the church the sign-in is bound to, newest first: ids, codes and
/// times only. That church whatever state its sign-in is in (renewing, failed, expired, unchecked), so
/// the list never looks empty only because Planning Center isn't connected just now (review Y, M-Y1);
/// `NotConnected` when there is no church at all, never an empty list.
#[tauri::command]
pub(crate) async fn change_history(
    app: tauri::AppHandle,
    consumer: tauri::State<'_, crate::Consumer>,
    limit: Option<u32>,
) -> Result<Vec<ChangeRecord>, SwitchError> {
    let consumer = consumer.inner().clone();
    let limit = limit.map_or(50, |n| n as usize).min(MAX_HISTORY);
    tauri::async_runtime::spawn_blocking(move || {
        history_in(
            app.path().app_data_dir().ok().as_deref(),
            crate::bound_church(&consumer).as_deref(),
            limit,
        )
    })
    .await
    .map_err(|_| SwitchError::Unavailable)?
}
fn history_in(
    dir: Option<&std::path::Path>,
    organization: Option<&str>,
    limit: usize,
) -> Result<Vec<ChangeRecord>, SwitchError> {
    let organization = organization.ok_or(SwitchError::NotConnected)?;
    let dir = dir.ok_or(SwitchError::Unavailable)?;
    Ok(ChangeLog::at(dir).list(organization, limit))
}

#[cfg(test)]
#[path = "changes_tests.rs"]
mod tests;
