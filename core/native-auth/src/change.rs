//! Changes in Planning Center, one at a time, with a person's yes (the write-back design and the
//! owner's decisions of 2026-11-17). The one change: from a Sunday card's "who could help", add one person
//! to an open role on that Sunday's plan as unconfirmed, with Planning Center's request prepared and
//! not sent, so the leader presses Send in Planning Center. And its undo. The whole rule is here:
//!
//! 1. **A closed list of writes, beside the read list, never in it.** `Write` is every write Ozzie can
//!    send: `POST …/plans/{plan}/team_members` (status `U`, `prepare_notification: true`) and
//!    `DELETE …/plans/{plan}/team_members/{row}` of a row this session made. Ids are digits only, the
//!    body is built from typed fields, the host is Planning Center's fixed origin with the pinned
//!    Services version. source.rs stays GET-only (its own test); no other file builds a write.
//! 2. **Only from a live check, only someone it listed.** `remember` keeps, from a live check of the
//!    church in use (never a recording), each open role and who the check listed for it as able to
//!    help: holding that team position, not on the plan, with their blockouts and schedules read and
//!    none ruling them out. It keeps one such check for each service watched (owner decision
//!    2026-11-19, several services), by its service type, so a change on one service's plan never
//!    comes from another's check. `prepare` takes only ids (the plan, the open role and the person)
//!    and refuses anyone else. Ozzie never picks the person: the page sends the one a leader chose.
//! 3. **A fresh read before the card, and again just before writing.** `prepare` reads Planning Center
//!    again through the verified, GET-only source path (the church's identity first) and shows what it
//!    found; `carry_out` reads it all again and refuses unless it reads the same: the plan and its
//!    times, still that many open, the person on no row of the plan, still holding the position, not
//!    a child (People's own flag; unreadable is refused), no blockout or other plan then, the team not
//!    split by service time. Nothing is sent after any refusal.
//! 4. **Kids teams: a fact, and advice, never a block** (owner decision 2026-11-17). For a team the
//!    church marked as a kids team, the fresh read adds the person's background check, as Planning
//!    Center's record says it: current, none on file, pending, expired, ends by that Sunday, or
//!    couldn't be read. Anything but current is advised against, and then `carry_out` needs, besides
//!    the confirmation, the leader's separate choice to go ahead despite that exact advice
//!    (`DespiteTheAdvice`); the record says they did. A finished check that didn't clear is never
//!    asked for, so it never reaches this Mac.
//! 5. **Used once, briefly.** A prepared change lives only in native memory, holds no name, expires
//!    after `PREPARED_FOR`, and is dropped when used, when another is prepared, after a new check
//!    of its plan or a recording of its service is shown, after any write, and on `forget` (church
//!    switch, sign-out, quit).
//! 6. **One at a time, paced, with a deadline.** A change takes the connection's turn
//!    (`sunday_check::Turns`, `Reader::Change`) without waiting; at most `PER_MINUTE` writes a minute
//!    and `PER_DAY` a day for a church, and `LOOKS_PER_MINUTE` fresh reads a minute. If `DEADLINE`
//!    passes before the write is sent, nothing is sent.
//! 7. **Sent at most once, never retried; read back after any doubt.** Planning Center has no
//!    idempotency key. After no answer, a 5xx, or a 2xx without the row's id, the plan is read again:
//!    no row for the person is "nothing changed", one row in that role is "made after all", several
//!    are "several rows", and a row only elsewhere or a read that fails is "unknown": open the plan.
//! 8. **Undo removes exactly the row it made**, only while reading it again shows it unconfirmed with
//!    the request unsent, and only for a row this session made.
//! 9. **Off unless the church turned it on** (`ChangeSwitch`, read here, saved by organization id).
//! 10. **Nothing with a name.** Every reply, refusal and record holds ids, codes, times and Planning
//!     Center's own position name; the page puts names in on this Mac. No model, harness tool, MCP
//!     server, Siri action, notice or scheduled job reaches this module (change_tests.rs).
//!
//! How the person says yes: today the on-screen confirmation of the one exact change is the approval
//! (owner decision 2026-11-17, no Touch ID or Mac password for now). `Confirmation` is where a system
//! check would go: a second variant, made only by native code, asked for in `carry_out` and `undo`.
use crate::{
    oauth::{AuthController, VerifiedSource, numeric_id},
    source::{
        Collection, NativeSourceHttp, ORIGIN, Product, SourceError, SourceHttp, SourceRequest,
        Target, VERSION, instant_ms,
    },
    sunday_check::{Reader, SundayCapture, Turns, rfc3339, unix_ms},
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    io::Read as _,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::Duration,
};

/// How long a prepared change waits for the leader's yes.
pub const PREPARED_FOR: Duration = Duration::from_secs(5 * 60);
/// From the leader's yes to the write going out: past it, nothing is sent.
pub const DEADLINE: Duration = Duration::from_secs(20);
/// Writes one church may send in any minute, and in any 24 hours.
pub const PER_MINUTE: usize = 3;
pub const PER_DAY: usize = 20;
/// Fresh reads (each a handful of GETs) in any minute, so a page stuck in a loop can't wear out the
/// church's Planning Center allowance.
pub const LOOKS_PER_MINUTE: usize = 6;
/// Undos one session may send in any minute. Not counted against adding (`PER_MINUTE`, `PER_DAY`):
/// taking off a person Ozzie added is never held back by how many were added.
pub const UNDOS_PER_MINUTE: usize = 10;
/// How long reading the plan back may take after a write whose answer didn't come.
const READ_BACK: Duration = Duration::from_secs(15);
/// The longest a change holds the connection's turn (the sign-in is renewed before the turn is taken):
/// its reads until `DEADLINE`, plus an identity check already under way then (the sign-in client's
/// 15 s), the write (its client's 10 s), and the read back (`READ_BACK`, plus a page already under way,
/// the source client's 5 s). A Sunday check waits longer than this for the turn, so a change never
/// makes it record `busy`.
pub const LONGEST_TURN: Duration = Duration::from_secs(20 + 15 + 10 + 15 + 5);
const MINUTE_MS: u64 = 60_000;
const DAY_MS: u64 = 24 * 60 * 60_000;
const PAGES: usize = 3;
const PER_PAGE: u16 = 100;
const POSITION_CHARS: usize = 120;
const MAX_ANSWER: u64 = 65_536;
/// Background checks that cleared, as Planning Center reports them (`manual_clear`, for one the
/// church entered by hand, was seen live on 2026-11-14 and isn't in the documented list).
const CLEARED: [&str; 2] = ["complete_clear", "manual_clear"];
/// The reads of a check that isn't finished: `awaiting_applicant`, `report_processing` and
/// `needs_review` (People 2025-11-10). `expired_invitation`, `canceled` and `complete_not_clear` are
/// never asked for.
const PENDING: [Collection; 3] = [
    Collection::PendingChecksAwaitingApplicant,
    Collection::PendingChecksReportProcessing,
    Collection::PendingChecksNeedsReview,
];

// ---- The closed list of writes -------------------------------------------------------------------

/// Every write Ozzie can send to Planning Center. Built only here; never from text.
pub(crate) enum Write {
    /// Add one person to one team position on one plan, unconfirmed, the request prepared.
    PencilIn {
        service_type: String,
        plan: String,
        person: String,
        team: String,
        position: String,
    },
    /// Remove one row of a plan's people that this session made.
    Remove {
        service_type: String,
        plan: String,
        row: String,
    },
}
impl Write {
    fn plan_path(service_type: &str, plan: &str) -> String {
        format!("/services/v2/service_types/{service_type}/plans/{plan}/team_members")
    }
    pub(crate) fn valid(&self) -> bool {
        match self {
            Self::PencilIn {
                service_type,
                plan,
                person,
                team,
                position,
            } => {
                [service_type, plan, person, team]
                    .iter()
                    .all(|id| numeric_id(id))
                    && plain_position(position)
            }
            Self::Remove {
                service_type,
                plan,
                row,
            } => [service_type, plan, row].iter().all(|id| numeric_id(id)),
        }
    }
    pub(crate) fn method(&self) -> reqwest::Method {
        match self {
            Self::PencilIn { .. } => reqwest::Method::POST,
            Self::Remove { .. } => reqwest::Method::DELETE,
        }
    }
    pub(crate) fn url(&self) -> String {
        match self {
            Self::PencilIn {
                service_type, plan, ..
            } => format!("{ORIGIN}{}", Self::plan_path(service_type, plan)),
            Self::Remove {
                service_type,
                plan,
                row,
            } => format!("{ORIGIN}{}/{row}", Self::plan_path(service_type, plan)),
        }
    }
    /// The body, from typed fields: the five the design names and nothing else (no notes, no decline
    /// reason, no "responds to").
    pub(crate) fn body(&self) -> Option<Value> {
        match self {
            Self::PencilIn {
                person,
                team,
                position,
                ..
            } => Some(json!({"data": {"type": "PlanPerson", "attributes": {
                "person_id": person,
                "team_id": team,
                "team_position_name": position,
                "status": "U",
                "prepare_notification": true,
            }}})),
            Self::Remove { .. } => None,
        }
    }
}
/// Planning Center's own name for a position, as a check read it: one line of 1 to 120 characters,
/// already trimmed, with no control, line-separator, zero-width or direction character.
fn plain_position(text: &str) -> bool {
    !text.is_empty()
        && text.trim() == text
        && text.chars().count() <= POSITION_CHARS
        && !text.chars().any(|c| {
            c.is_control()
                || matches!(c, '\u{200B}'..='\u{200F}' | '\u{2028}'..='\u{202E}' | '\u{2060}'..='\u{2069}' | '\u{FEFF}')
        })
}

/// What Planning Center answered a write: its status, the row it made (a POST) and who it says
/// scheduled it (`scheduled_by`, the signed-in person's id, seen live 2026-11-17), and nothing else.
pub(crate) struct Answer {
    pub(crate) status: u16,
    pub(crate) row: Option<String>,
    pub(crate) scheduled_by: Option<String>,
}
/// Why a write has no answer: it was never sent, or it may have been (no reply in time, the
/// connection lost): then only reading the plan again can tell.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Unsent {
    NotSent,
    NoAnswer,
}
pub(crate) type Sent = Result<Answer, Unsent>;
/// The network boundary for writes, injected in tests like `SourceHttp`.
pub(crate) trait ChangeHttp: Send + Sync {
    fn send(&self, write: &Write, access: &str) -> Sent;
}
pub(crate) struct NativeChangeHttp(reqwest::blocking::Client);
impl NativeChangeHttp {
    pub(crate) fn new() -> Result<Self, SourceError> {
        Ok(Self(
            reqwest::blocking::Client::builder()
                .https_only(true)
                .no_proxy()
                .retry(reqwest::retry::never())
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(2))
                .timeout(Duration::from_secs(10))
                .user_agent("Ozzie (https://ozzie.church)")
                .build()
                .map_err(|_| SourceError::ProviderFailure)?,
        ))
    }
    /// The one request a `Write` makes: its method, its URL, its JSON body, Services' pinned version.
    pub(crate) fn build(
        &self,
        write: &Write,
        access: &str,
    ) -> Result<reqwest::blocking::Request, Unsent> {
        if !write.valid() {
            return Err(Unsent::NotSent);
        }
        let mut request = self
            .0
            .request(write.method(), write.url())
            .bearer_auth(access)
            .header("Accept", "application/json")
            .header("X-PCO-API-Version", VERSION);
        if let Some(body) = write.body() {
            request = request
                .header("Content-Type", "application/json")
                .body(body.to_string());
        }
        request.build().map_err(|_| Unsent::NotSent)
    }
}
impl ChangeHttp for NativeChangeHttp {
    fn send(&self, write: &Write, access: &str) -> Sent {
        let built = self.build(write, access)?;
        let response = self.0.execute(built).map_err(|_| Unsent::NoAnswer)?;
        let status = response.status().as_u16();
        let mut bytes = Vec::new();
        let read = response.take(MAX_ANSWER).read_to_end(&mut bytes);
        let (row, scheduled_by) = match read {
            Ok(_) => made_row(&bytes),
            Err(_) => (None, None),
        };
        Ok(Answer {
            status,
            row,
            scheduled_by,
        })
    }
}
/// The id of the row a POST made and who Planning Center says scheduled it, when its answer is one
/// PlanPerson; nothing else is kept (its `name` and every other field are dropped unread).
fn made_row(bytes: &[u8]) -> (Option<String>, Option<String>) {
    let Ok(body) = serde_json::from_slice::<Value>(bytes) else {
        return (None, None);
    };
    let data = &body["data"];
    if data["type"] != "PlanPerson" {
        return (None, None);
    }
    let id = |value: &Value| {
        value
            .as_str()
            .filter(|id| numeric_id(id))
            .map(str::to_owned)
    };
    (
        id(&data["id"]),
        id(&data["relationships"]["scheduled_by"]["data"]["id"]),
    )
}

// ---- What the page is told -------------------------------------------------------------------------

/// A person's background check as Planning Center's record says it, read just now. Only for a kids
/// team; a fact about the record, never about the person.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BackgroundCheck {
    /// A cleared check Planning Center says is current, with no end date or one after that Sunday.
    Current,
    /// No cleared check on file, and none under way.
    NoneOnFile,
    /// A check that isn't finished yet (`awaiting_applicant`, `report_processing`, `needs_review`).
    Pending,
    /// Cleared checks on file, none of them current.
    Expired,
    /// The current cleared check ends on or before that Sunday (the church-local date of the plan).
    ExpiresByThatSunday,
    /// A read didn't answer, was cut short, or answered something that can't be placed.
    CouldNotRead,
}
impl BackgroundCheck {
    /// Every fact but `Current` is advised against.
    pub fn advised_against(self) -> bool {
        self != Self::Current
    }
}

/// The leader's separate, explicit choice to go ahead although Ozzie advised against it, for exactly
/// the background-check fact the confirmation showed. Not the confirmation itself: a change advised
/// against is never made with the confirmation alone.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DespiteTheAdvice(BackgroundCheck);
impl DespiteTheAdvice {
    pub fn about(fact: BackgroundCheck) -> Self {
        Self(fact)
    }
}
impl BackgroundCheck {
    /// A fact as the page names it back (`none-on-file`), or nothing.
    pub fn parse(text: &str) -> Option<Self> {
        serde_json::from_value(Value::String(text.to_owned())).ok()
    }
}

/// How the person said yes to the one exact change. Today: the on-screen confirmation.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Confirmation {
    OnScreen,
}

/// One prepared change, as the page names it back. Random; holds nothing.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(transparent)]
pub struct ChangeId(String);
impl ChangeId {
    fn new() -> Option<Self> {
        let mut random = [0u8; 16];
        getrandom::fill(&mut random).ok()?;
        Some(Self(random.iter().map(|b| format!("{b:02x}")).collect()))
    }
    /// A change id as the page sent it: 32 lowercase hex characters, or nothing.
    pub fn parse(text: &str) -> Option<Self> {
        (text.len() == 32 && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')))
            .then(|| Self(text.to_owned()))
    }
}

/// One service time of the plan, as Planning Center has it.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct ServiceTime {
    starts_at: String,
    ends_at: String,
}

/// What the confirmation shows, from the fresh read: ids, times, counts, Planning Center's own
/// position name and, for a kids team, the background-check fact and whether it is advised against.
/// The page puts the person's name in from what it already shows.
#[derive(Debug, PartialEq, Eq, serde::Serialize)]
pub struct Proposed {
    change: ChangeId,
    plan: String,
    team: String,
    person: String,
    position: String,
    sunday: String,
    times: Vec<ServiceTime>,
    still_needed: u64,
    kids_team: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    background_check: Option<BackgroundCheck>,
    /// The date the fact is about, when it has one: the end date that has passed (`Expired`), or the
    /// end date on or before that Sunday (`ExpiresByThatSunday`).
    #[serde(skip_serializing_if = "Option::is_none")]
    background_check_date: Option<String>,
    advised_against: bool,
    checked_at: String,
    expires_at: String,
}

/// Why nothing was sent. Closed codes; nothing about the person beyond what the code says.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Refusal {
    /// Changes aren't turned on for this church.
    Off,
    /// No live check of the church in use this session (a recording never makes a change).
    NoLiveCheck,
    /// The role isn't one this check showed as open.
    NotInThisCheck,
    /// The check didn't list this person for this role as able to help.
    NotListedToHelp,
    /// The role has no open place now.
    RoleNotOpen,
    /// The team is scheduled by service time; this version doesn't change those.
    SplitTeam,
    /// Planning Center lists the person as a child.
    Child,
    /// Planning Center lists the person as inactive (People `status`).
    Inactive,
    /// The person's People record doesn't say whether they are active.
    StatusUnknown,
    /// The sign-in doesn't include People, or People refused: "not a child" can't be confirmed.
    NoPeopleAccess,
    AlreadyOnPlan,
    NoLongerInThatPosition,
    BlockedOut,
    /// A repeating blockout: whether it covers that Sunday can't be told here.
    RepeatingBlockout,
    OtherPlanThen,
    PlanPassed,
    /// The fresh read just before writing differs from what the confirmation showed.
    ChangedSinceYouLooked,
    /// Planning Center has changed since the last check (an open role now has a new id, as after an
    /// undo, or a change was made since): check again before preparing a change.
    CheckAgain,
    /// The prepared change waited longer than `PREPARED_FOR`.
    Expired,
    /// No such prepared change: used, replaced, dropped or never made.
    UnknownChange,
    /// Advised against, and the separate choice to go ahead for that exact advice wasn't given.
    AdviceNotAcknowledged,
    /// A choice to go ahead despite advice that wasn't given.
    NothingToAcknowledge,
    BusyWithACheck,
    BusyWithAnotherChange,
    TooManyJustNow,
    TooManyToday,
    NotConnected,
    /// The sign-in in use is another church's than the check's.
    ChurchChanged,
    /// Planning Center refused a read (401 or 403).
    NotAllowed,
    /// A fresh read didn't finish, was cut short, or answered something that can't be placed.
    CouldNotCheck,
    /// `DEADLINE` passed before the write could be sent.
    DeadlinePassed,
    /// Undo: not a row this session made.
    NotOzziesChange,
    /// Undo: Planning Center has sent the request; Ozzie can't take that back.
    RequestAlreadySent,
    /// Undo: the person has answered (accepted or declined).
    PersonAnswered,
    /// The church plans its services in another system on this Mac (B1 Church or Breeze: a key for it is saved),
    /// which Ozzie only reads; Planning Center isn't changed from here then. Decided by the app before anything else.
    OtherSystem,
}

/// Whether reading the row back after Planning Center made it showed it as expected.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReadBack {
    /// Unconfirmed, the request prepared and not sent.
    AsExpected,
    /// The read back didn't answer, or showed it otherwise.
    NotSeen,
}

/// Which write a record is about: the change, or its undo.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Action {
    /// `POST …/team_members`: added unconfirmed, with Planning Center's request prepared and not sent.
    AddedUnconfirmed,
    /// `DELETE …/team_members/{row}`: a row this session made, taken off again.
    TookOff,
}
/// What came back from a write that went out (or may have).
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CameBack {
    /// Planning Center made the row.
    Made,
    /// No answer, then reading the plan again found the row.
    MadeAfterAll,
    /// Planning Center refused it (`status`): nothing changed.
    Refused,
    /// No answer, then reading the plan again found nothing changed.
    NothingChanged,
    /// No answer, and the plan couldn't be read again.
    Unknown,
    /// The row is gone.
    Removed,
    /// The row was gone already.
    AlreadyGone,
    /// No answer, then reading the plan again found the person on that role more than once.
    SeveralRows,
}

/// The name-free record of one write that went out, for What happened: what was sent (the action and
/// the ids), what came back (Planning Center's status, the row and the read back), who confirmed (the
/// signed-in person's Planning Center id, as Planning Center itself records it), how, and whether
/// the leader went ahead despite advice. With them, Planning Center's own name for the role and the
/// Sunday's church-local date, so What happened can say which role and which Sunday after a restart:
/// neither names a person. No name, nothing secret.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChangeRecord {
    action: Action,
    organization: String,
    service_type: String,
    plan: String,
    team: String,
    /// Planning Center's own name for the position, as the check read it ("Greeter").
    role: String,
    /// The Sunday, church-local ("2026-11-29").
    sunday: String,
    person: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    row: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    prepared_at: Option<String>,
    confirmed_at: String,
    sent_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    status: Option<u16>,
    came_back: CameBack,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    read_back: Option<ReadBack>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    confirmed_by: Option<String>,
    confirmation: Confirmation,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    despite_advice: Option<BackgroundCheck>,
}
impl ChangeRecord {
    /// Exactly what this module writes: digit ids and the check's own time spelling.
    fn valid(&self) -> bool {
        let time = |t: &str| crate::sunday_check::parse_rfc3339(t).is_some();
        [
            &self.organization,
            &self.service_type,
            &self.plan,
            &self.team,
            &self.person,
        ]
        .iter()
        .all(|id| numeric_id(id))
            && plain_position(&self.role)
            && plain_date(&self.sunday)
            && self.row.as_deref().is_none_or(numeric_id)
            && self.confirmed_by.as_deref().is_none_or(numeric_id)
            && self.prepared_at.as_deref().is_none_or(time)
            && time(&self.confirmed_at)
            && time(&self.sent_at)
    }
}

/// A church-local date as Planning Center spells it (`2026-11-29`), and a real one.
fn plain_date(text: &str) -> bool {
    text.len() == 10
        && crate::sunday_check::parse_rfc3339(&format!("{text}T00:00:00.000Z")).is_some()
}

// ---- What happened: the records kept on this Mac -----------------------------------------------

/// Every write's record, kept on this Mac (`changes-log.jsonl` in the app's data folder, file 0600):
/// the newest `KEEP_RECORDS`, one JSON object a line. Only this module writes it; the page reads it
/// for What happened through `list`. It is not the task ledger, so no copy for other AI apps or Siri
/// and no model request ever holds it.
pub struct ChangeLog {
    file: PathBuf,
}
const LOG_FILE: &str = "changes-log.jsonl";
pub const KEEP_RECORDS: usize = 500;
const MAX_LOG_BYTES: u64 = 4 * 1024 * 1024;
impl ChangeLog {
    pub fn at(dir: &Path) -> Self {
        Self {
            file: dir.join(LOG_FILE),
        }
    }
    fn read_all(&self) -> Vec<ChangeRecord> {
        let mut options = std::fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::custom_flags(&mut options, libc_nofollow());
        let Ok(file) = options.open(&self.file) else {
            return Vec::new();
        };
        if file
            .metadata()
            .is_ok_and(|meta| !meta.is_file() || meta.len() > MAX_LOG_BYTES)
        {
            return Vec::new();
        }
        let mut text = String::new();
        if file.take(MAX_LOG_BYTES).read_to_string(&mut text).is_err() {
            return Vec::new();
        }
        text.lines()
            .filter_map(|line| serde_json::from_str::<ChangeRecord>(line).ok())
            .filter(ChangeRecord::valid)
            .collect()
    }
    /// One church's records, newest first, at most `limit`.
    pub fn list(&self, organization: &str, limit: usize) -> Vec<ChangeRecord> {
        let mut records: Vec<ChangeRecord> = self
            .read_all()
            .into_iter()
            .filter(|record| record.organization == organization)
            .collect();
        records.reverse();
        records.truncate(limit);
        records
    }
    /// Adds one record, keeping the newest `KEEP_RECORDS`: written whole to a new file, then put in
    /// place.
    fn append(&self, record: &ChangeRecord) -> std::io::Result<()> {
        if !record.valid() {
            return Err(std::io::ErrorKind::InvalidInput.into());
        }
        let mut records = self.read_all();
        records.push(record.clone());
        let skip = records.len().saturating_sub(KEEP_RECORDS);
        let mut text = String::new();
        for record in records.iter().skip(skip) {
            text.push_str(
                &serde_json::to_string(record).map_err(|_| std::io::ErrorKind::InvalidData)?,
            );
            text.push('\n');
        }
        let dir = self.file.parent().ok_or(std::io::ErrorKind::InvalidInput)?;
        std::fs::create_dir_all(dir)?;
        let temporary = dir.join(format!("{LOG_FILE}.new"));
        let _ = std::fs::remove_file(&temporary);
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let mut file = options.open(&temporary)?;
        std::io::Write::write_all(&mut file, text.as_bytes())?;
        file.sync_all()?;
        std::fs::rename(&temporary, &self.file)
    }
}

/// What came of a confirmed change.
#[derive(Debug, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "result", rename_all = "kebab-case")]
pub enum Outcome {
    /// Planning Center made the row.
    Made { record: ChangeRecord },
    /// Planning Center didn't answer in time, and reading the plan again found the row.
    MadeAfterAll { record: ChangeRecord },
    /// Nothing was sent.
    NotMade { reason: Refusal },
    /// Planning Center refused the write; nothing changed. `NotAllowed` for 401 or 403.
    RefusedByPlanningCenter { status: u16, not_allowed: bool },
    /// Planning Center didn't answer in time, and reading the plan again found no row.
    NothingChanged,
    /// Planning Center didn't answer in time and the plan couldn't be read again.
    Unknown,
    /// Planning Center didn't answer in time, and reading the plan again found the person on that
    /// role more than once: which row is whose can't be told.
    SeveralRows,
}

/// What came of an undo.
#[derive(Debug, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "result", rename_all = "kebab-case")]
pub enum Undone {
    Removed,
    /// The row was already gone.
    AlreadyGone,
    NotRemoved {
        reason: Refusal,
    },
    RefusedByPlanningCenter {
        status: u16,
        not_allowed: bool,
    },
    Unknown,
}

// ---- The per-church switch ---------------------------------------------------------------------

/// "Let Ozzie make changes you approve, one at a time", for each church: off unless turned on for
/// that church, saved on this Mac by organization id (`changes.json` in the app's data folder).
/// Anything unreadable reads as off.
pub struct ChangeSwitch {
    file: PathBuf,
}
const SWITCH_FILE: &str = "changes.json";
const MAX_SWITCH_BYTES: u64 = 64 * 1024;
impl ChangeSwitch {
    pub fn at(dir: &Path) -> Self {
        Self {
            file: dir.join(SWITCH_FILE),
        }
    }
    fn on_list(&self) -> Option<BTreeSet<String>> {
        let mut options = std::fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::custom_flags(&mut options, libc_nofollow());
        let file = options.open(&self.file).ok()?;
        let meta = file.metadata().ok()?;
        if !meta.is_file() || meta.len() > MAX_SWITCH_BYTES {
            return None;
        }
        let mut bytes = Vec::new();
        file.take(MAX_SWITCH_BYTES).read_to_end(&mut bytes).ok()?;
        let value: Value = serde_json::from_slice(&bytes).ok()?;
        let object = value.as_object()?;
        if object.len() != 2 || value["version"] != 1 {
            return None;
        }
        let list = value["on"].as_array()?;
        let on: Option<BTreeSet<String>> = list
            .iter()
            .map(|id| id.as_str().filter(|id| numeric_id(id)).map(str::to_owned))
            .collect();
        on.filter(|on| on.len() == list.len())
    }
    /// Whether changes are on for this church. Off when the file is missing or unreadable.
    pub fn is_on(&self, organization: &str) -> bool {
        numeric_id(organization) && self.on_list().is_some_and(|on| on.contains(organization))
    }
    /// Turns changes on or off for one church, leaving the others as they were (an unreadable file
    /// is replaced by one naming only this church, when on).
    pub fn set(&self, organization: &str, on: bool) -> std::io::Result<()> {
        if !numeric_id(organization) {
            return Err(std::io::ErrorKind::InvalidInput.into());
        }
        let mut list = self.on_list().unwrap_or_default();
        if on {
            list.insert(organization.to_owned());
        } else {
            list.remove(organization);
        }
        let text = json!({"version": 1, "on": list}).to_string();
        let dir = self.file.parent().ok_or(std::io::ErrorKind::InvalidInput)?;
        std::fs::create_dir_all(dir)?;
        let temporary = dir.join(format!("{SWITCH_FILE}.new"));
        let _ = std::fs::remove_file(&temporary);
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let mut file = options.open(&temporary)?;
        std::io::Write::write_all(&mut file, text.as_bytes())?;
        file.sync_all()?;
        std::fs::rename(&temporary, &self.file)
    }
}
#[cfg(unix)]
fn libc_nofollow() -> i32 {
    // O_NOFOLLOW: macOS 0x0100, Linux 0o400000.
    if cfg!(target_os = "macos") {
        0x0100
    } else {
        0o400_000
    }
}

// ---- What a live check showed --------------------------------------------------------------------

/// One open role a live check showed (one needed position, by Planning Center's id for it), and who
/// it listed for it as able to help.
struct Role {
    needed: String,
    team: String,
    position: String,
    quantity: u64,
    split: bool,
    listed: BTreeSet<String>,
}
/// What `remember` keeps of the last live check of one service the church watches: ids, Planning
/// Center's position names and counts. No name, no body.
struct Seen {
    organization: String,
    service_type: String,
    plan: String,
    kids_teams: BTreeSet<String>,
    roles: Vec<Role>,
}

/// A change prepared for the leader's yes: native memory only, used once.
struct Prepared {
    id: ChangeId,
    ask: Ask,
    looked: Looked,
    prepared_at_ms: u64,
}
/// A row this session made and may remove again.
struct MadeRow {
    organization: String,
    service_type: String,
    plan: String,
    row: String,
    person: String,
    team: String,
    role: String,
    sunday: String,
}
#[derive(Default)]
struct State {
    /// The last live check of each service watched, by its service type: one plan each, all of one
    /// church.
    seen: BTreeMap<String, Seen>,
    prepared: Option<Prepared>,
    made: Vec<MadeRow>,
    log: Option<Arc<ChangeLog>>,
    /// When each write went out, per church (the last 24 hours).
    writes: BTreeMap<String, VecDeque<u64>>,
    /// When each fresh read started (the last minute).
    looks: VecDeque<u64>,
    /// When each undo went out (the last minute).
    undos: VecDeque<u64>,
}

/// This session's changes: each watched service's last live check's open roles, the one prepared
/// change, the rows made.
#[derive(Clone)]
pub struct Changes {
    state: Arc<Mutex<State>>,
    now_ms: Arc<dyn Fn() -> u64 + Send + Sync>,
}
impl Default for Changes {
    fn default() -> Self {
        Self::with_clock(Arc::new(unix_ms))
    }
}

/// The source client a change's reads use and the client its write uses, made once they will be.
pub(crate) type MakeClients = Box<
    dyn FnOnce() -> Result<(Arc<dyn SourceHttp + Send + Sync>, Arc<dyn ChangeHttp>), SourceError>
        + Send,
>;
fn native_clients() -> MakeClients {
    Box::new(|| {
        Ok((
            Arc::new(NativeSourceHttp::new()?) as Arc<dyn SourceHttp + Send + Sync>,
            Arc::new(NativeChangeHttp::new()?) as Arc<dyn ChangeHttp>,
        ))
    })
}

impl Changes {
    pub(crate) fn with_clock(now_ms: Arc<dyn Fn() -> u64 + Send + Sync>) -> Self {
        Self {
            state: Arc::new(Mutex::new(State::default())),
            now_ms,
        }
    }
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Keeps what a check shows for changes, for its service (one check per service type): from a
    /// live check, its open roles and who it listed for each; from a recording, nothing, and that
    /// service's last live check no longer stands. A change prepared on that service's plan is
    /// dropped (one for another service's plan stays: carrying it out reads everything again), and a
    /// check of another church drops everything of the last one: its checks, the prepared change and
    /// the rows made.
    pub fn remember(&self, capture: &SundayCapture) {
        let seen = (capture.kind == "live").then(|| seen(capture)).flatten();
        let mut state = self.lock();
        let other_church = state
            .seen
            .values()
            .any(|known| known.organization != capture.organization)
            || state
                .made
                .iter()
                .any(|made| made.organization != capture.organization)
            || state
                .prepared
                .as_ref()
                .is_some_and(|prepared| prepared.ask.organization != capture.organization);
        if other_church {
            state.seen.clear();
            state.made.clear();
            state.prepared = None;
        }
        if state.prepared.as_ref().is_some_and(|prepared| {
            prepared.ask.service_type == capture.service_type_id
                || prepared.ask.plan == capture.plan_id
        }) {
            state.prepared = None;
        }
        state.seen.remove(&capture.service_type_id);
        state.seen.retain(|_, known| known.plan != capture.plan_id);
        if let Some(seen) = seen {
            state.seen.insert(seen.service_type.clone(), seen);
        }
    }
    /// Drops everything: on a church switch, sign-out and quit.
    pub fn forget(&self) {
        let mut state = self.lock();
        state.seen.clear();
        state.prepared = None;
        state.made.clear();
    }
    /// The church Ozzie used is left (Disconnect, or a switch to another church), whatever state its
    /// sign-in was in: everything about its changes is dropped and changes are turned off for it.
    pub fn left(&self, switch: &ChangeSwitch, organization: &str) {
        self.forget();
        let _ = switch.set(organization, false);
    }
    /// Turns changes on or off for one church; off also drops anything waiting for a yes and the rows
    /// made (nothing more can be made or taken off until it is on again). Whether it is on afterwards.
    pub fn turn(
        &self,
        switch: &ChangeSwitch,
        organization: &str,
        on: bool,
    ) -> std::io::Result<bool> {
        switch.set(organization, on)?;
        if !on {
            self.forget();
        }
        Ok(switch.is_on(organization))
    }
    /// Where every write's record is kept (set once at start).
    pub fn keep_log(&self, records: ChangeLog) {
        self.lock().log = Some(Arc::new(records));
    }
    /// Keeps one write's record, and drops the check of the plan it was made on: Planning Center
    /// changed, so the next change there starts from a new check (an undo gives the open role a new
    /// id, seen live). Another service's plan keeps its check. Any change waiting for a yes is dropped.
    fn wrote(&self, record: Option<ChangeRecord>) {
        let kept = {
            let mut state = self.lock();
            match &record {
                Some(record) => state.seen.retain(|_, known| known.plan != record.plan),
                None => state.seen.clear(),
            }
            state.prepared = None;
            state.log.clone()
        };
        if let (Some(records), Some(record)) = (kept, record) {
            let _ = records.append(&record);
        }
    }

    /// Prepares adding `person` to the open role `position` on `team` (as the church's last live check
    /// read it: the team's id and Planning Center's own name for the position) and reads Planning
    /// Center again for the confirmation. `kids_teams`: the teams the church marked as kids teams
    /// (Church rules), joined to the check's own.
    #[allow(clippy::too_many_arguments)]
    pub fn prepare(
        &self,
        switch: &ChangeSwitch,
        turns: &Turns,
        plan: &str,
        team: &str,
        position: &str,
        person: &str,
        kids_teams: &[String],
        connect: impl FnOnce() -> Option<Arc<AuthController>>,
    ) -> Result<Proposed, Refusal> {
        self.prepare_with(
            switch,
            turns,
            plan,
            team,
            position,
            person,
            kids_teams,
            connect,
            native_clients(),
            DEADLINE,
        )
    }
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn prepare_with(
        &self,
        switch: &ChangeSwitch,
        turns: &Turns,
        plan: &str,
        team: &str,
        position: &str,
        person: &str,
        kids_teams: &[String],
        connect: impl FnOnce() -> Option<Arc<AuthController>>,
        clients: MakeClients,
        limit: Duration,
    ) -> Result<Proposed, Refusal> {
        if !numeric_id(plan)
            || !numeric_id(team)
            || !plain_position(position)
            || !numeric_id(person)
        {
            return Err(Refusal::NotInThisCheck);
        }
        // What the check showed, decided before anything else: no renewal, no turn, no read.
        let (ask, quantity) = {
            let state = self.lock();
            if state.seen.is_empty() {
                return Err(Refusal::NoLiveCheck);
            }
            // The page's plan is one a live check read now, of a service watched: another (an older
            // check on screen, a service's plan from before it moved on) is never changed.
            let seen = state
                .seen
                .values()
                .find(|seen| seen.plan == plan)
                .ok_or(Refusal::CheckAgain)?;
            // Exactly one open role by that team and Planning Center's name for it.
            let mut roles = seen
                .roles
                .iter()
                .filter(|role| role.team == team && role.position == position);
            let (Some(role), None) = (roles.next(), roles.next()) else {
                return Err(Refusal::NotInThisCheck);
            };
            let kids_team = seen.kids_teams.contains(&role.team) || kids_teams.contains(&role.team);
            (
                Ask {
                    organization: seen.organization.clone(),
                    service_type: seen.service_type.clone(),
                    plan: seen.plan.clone(),
                    team: role.team.clone(),
                    position: role.position.clone(),
                    needed: role.needed.clone(),
                    person: person.to_owned(),
                    kids_team,
                },
                (role.split, role.quantity, role.listed.contains(person)),
            )
        };
        if !switch.is_on(&ask.organization) {
            return Err(Refusal::Off);
        }
        match quantity {
            (true, ..) => return Err(Refusal::SplitTeam),
            (_, 0, _) => return Err(Refusal::RoleNotOpen),
            (.., false) => return Err(Refusal::NotListedToHelp),
            _ => {}
        }
        // The connection (renewed when it needs it) before the turn, so a renewal never holds it.
        let auth = connect().ok_or(Refusal::NotConnected)?;
        if auth.binding().organization != ask.organization {
            return Err(Refusal::ChurchChanged);
        }
        let _turn = take_turn(turns)?;
        self.pace_look()?;
        let (source, _) = clients().map_err(|_| Refusal::CouldNotCheck)?;
        let watch = Watch::start(limit)?;
        let verified = verify(&auth, &watch)?;
        let looked = look(
            &auth,
            &verified,
            &ask,
            &watch,
            source.as_ref(),
            (self.now_ms)(),
        )?;
        let id = ChangeId::new().ok_or(Refusal::CouldNotCheck)?;
        let now = (self.now_ms)();
        let proposed = Proposed {
            change: id.clone(),
            plan: ask.plan.clone(),
            team: ask.team.clone(),
            person: ask.person.clone(),
            position: ask.position.clone(),
            sunday: looked.sunday.clone(),
            times: looked.times.clone(),
            still_needed: looked.still_needed,
            kids_team: ask.kids_team,
            background_check: looked.background,
            background_check_date: looked.background_date.clone(),
            advised_against: looked
                .background
                .is_some_and(BackgroundCheck::advised_against),
            checked_at: rfc3339(now),
            expires_at: rfc3339(now + PREPARED_FOR.as_millis() as u64),
        };
        let mut state = self.lock();
        // A check of this service or a church switch while reading made this one stale.
        if state
            .seen
            .get(&ask.service_type)
            .is_none_or(|seen| seen.organization != ask.organization || seen.plan != ask.plan)
        {
            return Err(Refusal::ChangedSinceYouLooked);
        }
        state.prepared = Some(Prepared {
            id,
            ask,
            looked,
            prepared_at_ms: now,
        });
        Ok(proposed)
    }

    /// Makes the prepared change `id` after the person's yes: reads everything again, refuses unless it
    /// reads as the confirmation showed, then sends the one write once. `despite`: the leader's
    /// separate choice to go ahead despite the advice the confirmation showed, needed exactly then.
    pub fn carry_out(
        &self,
        switch: &ChangeSwitch,
        turns: &Turns,
        id: &ChangeId,
        confirmation: Confirmation,
        despite: Option<DespiteTheAdvice>,
        connect: impl FnOnce() -> Option<Arc<AuthController>>,
    ) -> Outcome {
        self.carry_out_with(
            switch,
            turns,
            id,
            confirmation,
            despite,
            connect,
            native_clients(),
            DEADLINE,
        )
    }
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn carry_out_with(
        &self,
        switch: &ChangeSwitch,
        turns: &Turns,
        id: &ChangeId,
        confirmation: Confirmation,
        despite: Option<DespiteTheAdvice>,
        connect: impl FnOnce() -> Option<Arc<AuthController>>,
        clients: MakeClients,
        limit: Duration,
    ) -> Outcome {
        let refused = |reason| Outcome::NotMade { reason };
        let confirmed_at = (self.now_ms)();
        // Used once: taken out now, whatever follows.
        let prepared = {
            let mut state = self.lock();
            match state.prepared.take() {
                Some(prepared) if prepared.id == *id => prepared,
                other => {
                    state.prepared = other;
                    return refused(Refusal::UnknownChange);
                }
            }
        };
        if confirmed_at >= prepared.prepared_at_ms + PREPARED_FOR.as_millis() as u64 {
            return refused(Refusal::Expired);
        }
        let shown = prepared.looked.background;
        match (shown.filter(|fact| fact.advised_against()), despite) {
            (Some(fact), Some(DespiteTheAdvice(chosen))) if chosen == fact => {}
            (Some(_), _) => return refused(Refusal::AdviceNotAcknowledged),
            (None, Some(_)) => return refused(Refusal::NothingToAcknowledge),
            (None, None) => {}
        }
        let ask = prepared.ask;
        if !switch.is_on(&ask.organization) {
            return refused(Refusal::Off);
        }
        // The connection (renewed when it needs it) before the turn, so a renewal never holds it.
        let Some(auth) = connect() else {
            return refused(Refusal::NotConnected);
        };
        if auth.binding().organization != ask.organization {
            return refused(Refusal::ChurchChanged);
        }
        let turn = match take_turn(turns) {
            Ok(turn) => turn,
            Err(reason) => return refused(reason),
        };
        if let Err(reason) = self.pace_write(&ask.organization, false) {
            return refused(reason);
        }
        let Ok((source, change)) = clients() else {
            return refused(Refusal::CouldNotCheck);
        };
        let watch = match Watch::start(limit) {
            Ok(watch) => watch,
            Err(reason) => return refused(reason),
        };
        let verified = match verify(&auth, &watch) {
            Ok(verified) => verified,
            Err(reason) => return refused(reason),
        };
        match look(
            &auth,
            &verified,
            &ask,
            &watch,
            source.as_ref(),
            (self.now_ms)(),
        ) {
            Ok(looked) if looked == prepared.looked => {}
            Ok(_) => return refused(Refusal::ChangedSinceYouLooked),
            Err(reason) => return refused(reason),
        }
        let write = Write::PencilIn {
            service_type: ask.service_type.clone(),
            plan: ask.plan.clone(),
            person: ask.person.clone(),
            team: ask.team.clone(),
            position: ask.position.clone(),
        };
        if watch.fired() {
            return refused(Refusal::DeadlinePassed);
        }
        let sent_at = (self.now_ms)();
        let sent = match auth.change_verified_using(
            &verified,
            &write,
            &watch.cancelled,
            change.as_ref(),
        ) {
            Ok(sent) => sent,
            Err(_) if watch.fired() => return refused(Refusal::DeadlinePassed),
            Err(SourceError::Cancelled) => return refused(Refusal::NotConnected),
            Err(_) => return refused(Refusal::CouldNotCheck),
        };
        if !matches!(sent, Err(Unsent::NotSent)) {
            // Counted once it may have gone out, whatever came back.
            let _ = self.pace_write(&ask.organization, true);
        }
        let confirmed_by = sent
            .as_ref()
            .ok()
            .and_then(|answer| answer.scheduled_by.clone());
        let record = |row: Option<String>,
                      status: Option<u16>,
                      came_back: CameBack,
                      read_back: Option<ReadBack>| ChangeRecord {
            action: Action::AddedUnconfirmed,
            organization: ask.organization.clone(),
            service_type: ask.service_type.clone(),
            plan: ask.plan.clone(),
            team: ask.team.clone(),
            role: ask.position.clone(),
            sunday: prepared.looked.sunday.clone(),
            person: ask.person.clone(),
            row,
            prepared_at: Some(rfc3339(prepared.prepared_at_ms)),
            confirmed_at: rfc3339(confirmed_at),
            sent_at: rfc3339(sent_at),
            status,
            came_back,
            read_back,
            confirmed_by: confirmed_by.clone(),
            confirmation,
            despite_advice: despite.map(|DespiteTheAdvice(fact)| fact),
        };
        // The deadline no longer applies: reading back has its own bound.
        drop(watch);
        let (outcome, kept) = match sent {
            Err(Unsent::NotSent) => (refused(Refusal::CouldNotCheck), None),
            Ok(Answer {
                status: status @ 200..=299,
                row: Some(row),
                ..
            }) => {
                let read_back = match self.read_back(&auth, &verified, &ask, source.as_ref()) {
                    Some(rows) if rows.iter().any(|r| r.id == row && r.as_expected()) => {
                        ReadBack::AsExpected
                    }
                    _ => ReadBack::NotSeen,
                };
                let record = record(Some(row), Some(status), CameBack::Made, Some(read_back));
                (
                    Outcome::Made {
                        record: record.clone(),
                    },
                    Some(record),
                )
            }
            // Refused before anything was made: no permission, a request it didn't accept, or too many.
            Ok(Answer { status, .. }) if (400..500).contains(&status) => (
                Outcome::RefusedByPlanningCenter {
                    status,
                    not_allowed: matches!(status, 401 | 403),
                },
                Some(record(None, Some(status), CameBack::Refused, None)),
            ),
            // No answer, a 5xx, or a success without the row's id: only the plan can tell.
            other => {
                let status = other.as_ref().ok().map(|answer| answer.status);
                // "Nothing changed" only when the person is on no row of the plan, as the fresh read
                // just before the write showed. Ozzie's is a row on that team in that position, the
                // names compared as Planning Center returns them; a row elsewhere leaves it unknown.
                let unknown = || {
                    (
                        Outcome::Unknown,
                        Some(record(None, status, CameBack::Unknown, None)),
                    )
                };
                match self.read_back(&auth, &verified, &ask, source.as_ref()) {
                    None => unknown(),
                    Some(rows) if rows.is_empty() => (
                        Outcome::NothingChanged,
                        Some(record(None, status, CameBack::NothingChanged, None)),
                    ),
                    Some(rows) => {
                        let exact: Vec<&PlanRow> = rows
                            .iter()
                            .filter(|row| row.team == ask.team && row.position == ask.position)
                            .collect();
                        match exact.as_slice() {
                            // On the plan, but not in that role: whether Ozzie's write made a row
                            // can't be told.
                            [] => unknown(),
                            [one] => {
                                let read_back = if one.as_expected() {
                                    ReadBack::AsExpected
                                } else {
                                    ReadBack::NotSeen
                                };
                                let record = record(
                                    Some(one.id.clone()),
                                    status,
                                    CameBack::MadeAfterAll,
                                    Some(read_back),
                                );
                                (
                                    Outcome::MadeAfterAll {
                                        record: record.clone(),
                                    },
                                    Some(record),
                                )
                            }
                            _ => (
                                Outcome::SeveralRows,
                                Some(record(None, status, CameBack::SeveralRows, None)),
                            ),
                        }
                    }
                }
            }
        };
        if let Outcome::Made { record } | Outcome::MadeAfterAll { record } = &outcome
            && let Some(row) = &record.row
        {
            self.lock().made.push(MadeRow {
                organization: record.organization.clone(),
                service_type: record.service_type.clone(),
                plan: record.plan.clone(),
                row: row.clone(),
                person: record.person.clone(),
                team: record.team.clone(),
                role: record.role.clone(),
                sunday: record.sunday.clone(),
            });
        }
        if kept.is_some() {
            self.wrote(kept);
        }
        drop(turn);
        outcome
    }

    /// Removes a row this session made, only while reading it again shows it unconfirmed with the
    /// request unsent.
    pub fn undo(
        &self,
        switch: &ChangeSwitch,
        turns: &Turns,
        row: &str,
        confirmation: Confirmation,
        connect: impl FnOnce() -> Option<Arc<AuthController>>,
    ) -> Undone {
        self.undo_with(
            switch,
            turns,
            row,
            confirmation,
            connect,
            native_clients(),
            DEADLINE,
        )
    }
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn undo_with(
        &self,
        switch: &ChangeSwitch,
        turns: &Turns,
        row: &str,
        confirmation: Confirmation,
        connect: impl FnOnce() -> Option<Arc<AuthController>>,
        clients: MakeClients,
        limit: Duration,
    ) -> Undone {
        let refused = |reason| Undone::NotRemoved { reason };
        let confirmed_at = (self.now_ms)();
        // Only a row this session made, decided before anything else: no renewal, no turn, no read.
        let made = {
            let state = self.lock();
            state.made.iter().find(|made| made.row == row).map(|made| {
                (
                    Ask {
                        organization: made.organization.clone(),
                        service_type: made.service_type.clone(),
                        plan: made.plan.clone(),
                        team: made.team.clone(),
                        position: made.role.clone(),
                        needed: String::new(),
                        person: made.person.clone(),
                        kids_team: false,
                    },
                    made.sunday.clone(),
                )
            })
        };
        let Some((ask, sunday)) = made else {
            return refused(Refusal::NotOzziesChange);
        };
        let organization = ask.organization.clone();
        if !switch.is_on(&organization) {
            return refused(Refusal::Off);
        }
        let Some(auth) = connect() else {
            return refused(Refusal::NotConnected);
        };
        if auth.binding().organization != organization {
            return refused(Refusal::NotOzziesChange);
        }
        let turn = match take_turn(turns) {
            Ok(turn) => turn,
            Err(reason) => return refused(reason),
        };
        if let Err(reason) = self.pace_undo(false) {
            return refused(reason);
        }
        let Ok((source, change)) = clients() else {
            return refused(Refusal::CouldNotCheck);
        };
        let watch = match Watch::start(limit) {
            Ok(watch) => watch,
            Err(reason) => return refused(reason),
        };
        let verified = match verify(&auth, &watch) {
            Ok(verified) => verified,
            Err(reason) => return refused(reason),
        };
        let reading = Reading {
            auth: &auth,
            verified: &verified,
            ask: &ask,
            cancelled: &watch.cancelled,
            http: source.as_ref(),
        };
        let rows = match reading.plan_rows() {
            Ok(rows) => rows,
            Err(error) => return refused(watch.reason(error)),
        };
        let forget = |this: &Self| this.lock().made.retain(|made| made.row != row);
        let Some(current) = rows.iter().find(|r| r.id == row) else {
            forget(self);
            return Undone::AlreadyGone;
        };
        if current.person != ask.person
            || current.team != ask.team
            || current.position != ask.position
        {
            return refused(Refusal::NotOzziesChange);
        }
        if current.sent {
            return refused(Refusal::RequestAlreadySent);
        }
        if current.status != "U" {
            return refused(Refusal::PersonAnswered);
        }
        if watch.fired() {
            return refused(Refusal::DeadlinePassed);
        }
        let write = Write::Remove {
            service_type: ask.service_type.clone(),
            plan: ask.plan.clone(),
            row: row.to_owned(),
        };
        let sent_at = (self.now_ms)();
        let sent = match auth.change_verified_using(
            &verified,
            &write,
            &watch.cancelled,
            change.as_ref(),
        ) {
            Ok(sent) => sent,
            Err(_) if watch.fired() => return refused(Refusal::DeadlinePassed),
            Err(_) => return refused(Refusal::CouldNotCheck),
        };
        if !matches!(sent, Err(Unsent::NotSent)) {
            let _ = self.pace_undo(true);
        }
        drop(watch);
        let status = sent.as_ref().ok().map(|answer| answer.status);
        let undone = match sent {
            Err(Unsent::NotSent) => refused(Refusal::CouldNotCheck),
            Ok(Answer { status: 404, .. }) => Undone::AlreadyGone,
            Ok(Answer { status, .. }) if (400..500).contains(&status) => {
                Undone::RefusedByPlanningCenter {
                    status,
                    not_allowed: matches!(status, 401 | 403),
                }
            }
            _ => match self.read_back(&auth, &verified, &ask, source.as_ref()) {
                Some(rows) if rows.iter().all(|r| r.id != row) => Undone::Removed,
                _ => Undone::Unknown,
            },
        };
        let came_back = match &undone {
            Undone::Removed => Some(CameBack::Removed),
            Undone::AlreadyGone => Some(CameBack::AlreadyGone),
            Undone::RefusedByPlanningCenter { .. } => Some(CameBack::Refused),
            Undone::Unknown => Some(CameBack::Unknown),
            Undone::NotRemoved { .. } => None,
        };
        if matches!(undone, Undone::Removed | Undone::AlreadyGone) {
            forget(self);
        }
        if let Some(came_back) = came_back {
            self.wrote(Some(ChangeRecord {
                action: Action::TookOff,
                organization: ask.organization.clone(),
                service_type: ask.service_type.clone(),
                plan: ask.plan.clone(),
                team: ask.team.clone(),
                role: ask.position.clone(),
                sunday,
                person: ask.person.clone(),
                row: Some(row.to_owned()),
                prepared_at: None,
                confirmed_at: rfc3339(confirmed_at),
                sent_at: rfc3339(sent_at),
                status,
                came_back,
                read_back: None,
                // The delete's answer doesn't name the account; the add's scheduler isn't repeated.
                confirmed_by: None,
                confirmation,
                despite_advice: None,
            }));
        }
        drop(turn);
        undone
    }

    /// The person's rows on the plan, read with a fresh bound after a write; `None` if that fails.
    fn read_back(
        &self,
        auth: &AuthController,
        verified: &VerifiedSource,
        ask: &Ask,
        http: &dyn SourceHttp,
    ) -> Option<Vec<PlanRow>> {
        let watch = Watch::start(READ_BACK).ok()?;
        let reading = Reading {
            auth,
            verified,
            ask,
            cancelled: &watch.cancelled,
            http,
        };
        let rows = reading.plan_rows().ok()?;
        // Every row for that person, whatever its team or position: the callers decide which is
        // Ozzie's (review X, L-a), so a row elsewhere on the plan is never read as "not there".
        Some(
            rows.into_iter()
                .filter(|row| row.person == ask.person)
                .collect(),
        )
    }

    fn pace_look(&self) -> Result<(), Refusal> {
        let now = (self.now_ms)();
        let mut state = self.lock();
        while state
            .looks
            .front()
            .is_some_and(|&at| now.saturating_sub(at) >= MINUTE_MS)
        {
            state.looks.pop_front();
        }
        if state.looks.len() >= LOOKS_PER_MINUTE {
            return Err(Refusal::TooManyJustNow);
        }
        state.looks.push_back(now);
        Ok(())
    }
    /// Whether one more undo fits its own pace; `count` records it as sent.
    fn pace_undo(&self, count: bool) -> Result<(), Refusal> {
        let now = (self.now_ms)();
        let mut state = self.lock();
        while state
            .undos
            .front()
            .is_some_and(|&at| now.saturating_sub(at) >= MINUTE_MS)
        {
            state.undos.pop_front();
        }
        if count {
            state.undos.push_back(now);
            return Ok(());
        }
        if state.undos.len() >= UNDOS_PER_MINUTE {
            return Err(Refusal::TooManyJustNow);
        }
        Ok(())
    }
    /// Whether one more write fits this church's pace; `count` records it as sent.
    fn pace_write(&self, organization: &str, count: bool) -> Result<(), Refusal> {
        let now = (self.now_ms)();
        let mut state = self.lock();
        let sent = state.writes.entry(organization.to_owned()).or_default();
        while sent
            .front()
            .is_some_and(|&at| now.saturating_sub(at) >= DAY_MS)
        {
            sent.pop_front();
        }
        if count {
            sent.push_back(now);
            return Ok(());
        }
        if sent.len() >= PER_DAY {
            return Err(Refusal::TooManyToday);
        }
        if sent
            .iter()
            .filter(|&&at| now.saturating_sub(at) < MINUTE_MS)
            .count()
            >= PER_MINUTE
        {
            return Err(Refusal::TooManyJustNow);
        }
        Ok(())
    }
}

fn take_turn(turns: &Turns) -> Result<crate::sunday_check::Turn, Refusal> {
    turns
        .take_now(Reader::Change)
        .map_err(|holder| match holder {
            Reader::Change => Refusal::BusyWithAnotherChange,
            Reader::Check | Reader::Picker | Reader::Note => Refusal::BusyWithACheck,
        })
}

/// A deadline: past `limit`, `cancelled` is set and every read and the write stop at their next
/// boundary. Dropping it stops the timer.
struct Watch {
    cancelled: AtomicBoolArc,
    fired: AtomicBoolArc,
    _stop: mpsc::Sender<()>,
}
type AtomicBoolArc = Arc<AtomicBool>;
impl Watch {
    fn start(limit: Duration) -> Result<Self, Refusal> {
        let cancelled = Arc::new(AtomicBool::new(false));
        let fired = Arc::new(AtomicBool::new(false));
        let (stop, wait) = mpsc::channel::<()>();
        let (flag, mark) = (cancelled.clone(), fired.clone());
        std::thread::Builder::new()
            .name("ozzie-change-deadline".into())
            .spawn(move || {
                if let Err(mpsc::RecvTimeoutError::Timeout) = wait.recv_timeout(limit) {
                    mark.store(true, Ordering::SeqCst);
                    flag.store(true, Ordering::SeqCst);
                }
            })
            .map_err(|_| Refusal::CouldNotCheck)?;
        Ok(Self {
            cancelled,
            fired,
            _stop: stop,
        })
    }
    fn fired(&self) -> bool {
        self.fired.load(Ordering::SeqCst)
    }
    /// A read's error, as a refusal.
    fn reason(&self, error: SourceError) -> Refusal {
        if self.fired() {
            return Refusal::DeadlinePassed;
        }
        match error {
            SourceError::Denied => Refusal::NotAllowed,
            SourceError::Cancelled
            | SourceError::MissingCredentials
            | SourceError::InvalidCredentials
            | SourceError::BindingMismatch => Refusal::NotConnected,
            SourceError::OrganizationUnverified => Refusal::ChurchChanged,
            SourceError::Busy => Refusal::BusyWithACheck,
            _ => Refusal::CouldNotCheck,
        }
    }
}

/// The church's identity, from Planning Center, under the deadline; and People, without which "not a
/// child" can't be confirmed.
fn verify(auth: &AuthController, watch: &Watch) -> Result<VerifiedSource, Refusal> {
    let verified = auth
        .verify_source(&watch.cancelled)
        .map_err(|error| watch.reason(error))?;
    if !Product::People.granted(verified.scopes()) {
        return Err(Refusal::NoPeopleAccess);
    }
    Ok(verified)
}

// ---- The fresh read ----------------------------------------------------------------------------

/// The one change being looked at, by ids and Planning Center's position name.
struct Ask {
    organization: String,
    service_type: String,
    plan: String,
    team: String,
    position: String,
    /// The open role's needed-position id in the check the change was prepared from.
    needed: String,
    person: String,
    kids_team: bool,
}
/// What the confirmation showed, compared again just before writing.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Looked {
    sunday: String,
    times: Vec<ServiceTime>,
    still_needed: u64,
    background: Option<BackgroundCheck>,
    background_date: Option<String>,
}
/// One row of the plan's people, as a read shows it.
struct PlanRow {
    id: String,
    person: String,
    team: String,
    position: String,
    status: String,
    sent: bool,
    prepared: bool,
}
impl PlanRow {
    fn as_expected(&self) -> bool {
        self.status == "U" && !self.sent && self.prepared
    }
}

struct Reading<'a> {
    auth: &'a AuthController,
    verified: &'a VerifiedSource,
    ask: &'a Ask,
    cancelled: &'a AtomicBool,
    http: &'a dyn SourceHttp,
}
impl Reading<'_> {
    /// Every page of one read (at most `PAGES`): `Truncated` past that.
    fn bodies(&self, collection: Collection, target: &Target) -> Result<Vec<Value>, SourceError> {
        // A person's own People record and their unfinished checks belong to no plan.
        let (service_type, plan) =
            if matches!(collection, Collection::PersonChild) || PENDING.contains(&collection) {
                ("", "")
            } else {
                (self.ask.service_type.as_str(), self.ask.plan.as_str())
            };
        let paged = !matches!(collection, Collection::Plan | Collection::PersonChild);
        let mut bodies = Vec::new();
        let mut offset = 0;
        for _ in 0..PAGES {
            let request = SourceRequest::capture_at(
                self.auth.binding(),
                service_type,
                plan,
                collection,
                target,
                if paged { PER_PAGE } else { 1 },
                offset,
            )?;
            let page = self.auth.read_verified_using(
                self.verified,
                &request,
                self.cancelled,
                self.http,
            )?;
            let body = page.body().clone();
            let next = next_offset(&body);
            bodies.push(body);
            match next {
                Some(next) if paged && next > offset => offset = next,
                Some(_) => return Err(SourceError::InvalidResponse),
                None => return Ok(bodies),
            }
        }
        Err(SourceError::Oversized)
    }
    fn plan_rows(&self) -> Result<Vec<PlanRow>, SourceError> {
        let bodies = self.bodies(Collection::TeamMembers, &Target::default())?;
        rows(&bodies)
            .map(|row| {
                let a = &row["attributes"];
                Ok(PlanRow {
                    id: id_of(row).ok_or(SourceError::InvalidResponse)?,
                    person: link(row, "person").ok_or(SourceError::InvalidResponse)?,
                    team: link(row, "team").unwrap_or_default(),
                    position: a["team_position_name"]
                        .as_str()
                        .unwrap_or_default()
                        .to_owned(),
                    status: a["status"].as_str().unwrap_or_default().to_owned(),
                    sent: !a["notification_sent_at"].is_null(),
                    prepared: !a["notification_prepared_at"].is_null()
                        || a["prepare_notification"] == true,
                })
            })
            .collect()
    }
}

/// Reads everything a change depends on, just now, through the verified GET-only path.
fn look(
    auth: &AuthController,
    verified: &VerifiedSource,
    ask: &Ask,
    watch: &Watch,
    http: &dyn SourceHttp,
    now_ms: u64,
) -> Result<Looked, Refusal> {
    let reading = Reading {
        auth,
        verified,
        ask,
        cancelled: &watch.cancelled,
        http,
    };
    let read = |collection, target: &Target| {
        reading
            .bodies(collection, target)
            .map_err(|error| watch.reason(error))
    };
    // The plan, still ahead, and its times.
    let plan = read(Collection::Plan, &Target::default())?;
    let sort_date = plan
        .first()
        .and_then(|body| body["data"]["attributes"]["sort_date"].as_str())
        .ok_or(Refusal::CouldNotCheck)?;
    let sunday = sort_date
        .get(..10)
        .ok_or(Refusal::CouldNotCheck)?
        .to_owned();
    let times = read(Collection::PlanTimes, &Target::default())?;
    let now = now_ms as i64;
    let mut shown = Vec::new();
    let mut spans = Vec::new();
    let mut service_ahead = false;
    for row in rows(&times) {
        let (starts_at, ends_at) = (
            row["attributes"]["starts_at"].as_str(),
            row["attributes"]["ends_at"].as_str(),
        );
        let span = span(starts_at, ends_at).ok_or(Refusal::CouldNotCheck)?;
        // A service (or a time of no stated kind) still to start; a rehearsal already over
        // matters for nothing below.
        let service = row["attributes"]["time_type"]
            .as_str()
            .is_none_or(|kind| kind == "service");
        service_ahead |= service && span.0 > now;
        if span.1 > now {
            spans.push(span);
        }
        shown.push(ServiceTime {
            starts_at: starts_at.unwrap_or_default().to_owned(),
            ends_at: ends_at.unwrap_or_default().to_owned(),
        });
    }
    shown.sort_by(|a, b| a.starts_at.cmp(&b.starts_at));
    if shown.is_empty() {
        return Err(Refusal::CouldNotCheck);
    }
    if !service_ahead {
        return Err(Refusal::PlanPassed);
    }
    // The role: still open, and the team scheduled by plan.
    let needed = read(Collection::NeededPositions, &Target::default())?;
    let mut still_needed = 0;
    let mut same_role = false;
    for row in rows(&needed) {
        if link(row, "team").as_deref() != Some(&ask.team) {
            continue;
        }
        if !row["relationships"]["time"]["data"].is_null() {
            return Err(Refusal::SplitTeam);
        }
        if row["attributes"]["team_position_name"].as_str() == Some(&ask.position) {
            still_needed += row["attributes"]["quantity"]
                .as_u64()
                .ok_or(Refusal::CouldNotCheck)?;
            same_role |= id_of(row).as_deref() == Some(&ask.needed);
        }
    }
    if still_needed == 0 {
        return Err(Refusal::RoleNotOpen);
    }
    // Open, but under another id than the check had: Planning Center changed since (an undo gives
    // the role a new id). Never reuse the old one: check again.
    if !same_role {
        return Err(Refusal::CheckAgain);
    }
    // The person: on no row of this plan, still holding the position.
    if reading
        .plan_rows()
        .map_err(|error| watch.reason(error))?
        .iter()
        .any(|row| row.person == ask.person)
    {
        return Err(Refusal::AlreadyOnPlan);
    }
    let assignments = read(
        Collection::TeamPositionAssignments,
        &Target::team(&ask.team),
    )?;
    let positions: BTreeMap<String, String> = included(&assignments)
        .filter(|row| row["type"] == "TeamPosition")
        .filter_map(|row| Some((id_of(row)?, row["attributes"]["name"].as_str()?.to_owned())))
        .collect();
    let holds = rows(&assignments).any(|row| {
        link(row, "person").as_deref() == Some(&ask.person)
            && link(row, "team_position")
                .and_then(|position| positions.get(&position))
                .is_some_and(|name| *name == ask.position)
    });
    if !holds {
        return Err(Refusal::NoLongerInThatPosition);
    }
    // Never a child, and never someone whose record doesn't say.
    let child = reading
        .bodies(Collection::PersonChild, &Target::people_person(&ask.person))
        .map_err(|error| match watch.reason(error) {
            Refusal::NotAllowed => Refusal::NoPeopleAccess,
            other => other,
        })?;
    let record = child.first().map(|body| &body["data"]);
    let Some(record) = record.filter(|record| id_of(record).as_deref() == Some(&ask.person)) else {
        return Err(Refusal::CouldNotCheck);
    };
    match record["attributes"]["child"] {
        Value::Bool(false) => {}
        Value::Bool(true) => return Err(Refusal::Child),
        _ => return Err(Refusal::CouldNotCheck),
    }
    // Never someone Planning Center lists as inactive, and never someone whose record doesn't say.
    match record["attributes"]["status"].as_str() {
        Some("active") => {}
        Some("inactive") => return Err(Refusal::Inactive),
        _ => return Err(Refusal::StatusUnknown),
    }
    // No blockout and no other plan then.
    let blockouts = read(Collection::PersonBlockouts, &Target::person(&ask.person))?;
    for row in rows(&blockouts) {
        let a = &row["attributes"];
        if a["repeat_frequency"]
            .as_str()
            .is_some_and(|repeat| repeat != "no_repeat")
        {
            return Err(Refusal::RepeatingBlockout);
        }
        let blocked =
            span(a["starts_at"].as_str(), a["ends_at"].as_str()).ok_or(Refusal::CouldNotCheck)?;
        if spans.iter().any(|time| overlaps(*time, blocked)) {
            return Err(Refusal::BlockedOut);
        }
    }
    let schedules = match reading.bodies(Collection::PersonSchedules, &Target::person(&ask.person))
    {
        Err(SourceError::Rejected) => read(
            Collection::PersonSchedulesUnfiltered,
            &Target::person(&ask.person),
        )?,
        other => other.map_err(|error| watch.reason(error))?,
    };
    let plan_times: BTreeMap<String, (i64, i64)> = included(&schedules)
        .filter(|row| row["type"] == "PlanTime")
        .filter_map(|row| {
            let a = &row["attributes"];
            Some((
                id_of(row)?,
                span(a["starts_at"].as_str(), a["ends_at"].as_str())?,
            ))
        })
        .collect();
    for row in rows(&schedules) {
        if link(row, "plan").as_deref() == Some(&ask.plan) {
            return Err(Refusal::AlreadyOnPlan);
        }
        if row["attributes"]["status"] == "D" {
            continue;
        }
        let own: Vec<Option<&(i64, i64)>> = links(row, "times")
            .iter()
            .map(|time| plan_times.get(time))
            .collect();
        if own.is_empty() || own.iter().any(Option::is_none) {
            // Times that can't be placed matter only on that Sunday.
            if row["attributes"]["sort_date"]
                .as_str()
                .is_none_or(|date| date.get(..10) == Some(&sunday))
            {
                return Err(Refusal::CouldNotCheck);
            }
            continue;
        }
        if own
            .iter()
            .flatten()
            .any(|other| spans.iter().any(|time| overlaps(*time, **other)))
        {
            return Err(Refusal::OtherPlanThen);
        }
    }
    // A kids team: the background check, as a fact. Its reads failing is a fact too, never a refusal.
    // Today as the earliest calendar date anywhere (UTC-12): a date before it has passed everywhere.
    let today = rfc3339(now_ms.saturating_sub(12 * 60 * 60_000));
    let today = today.get(..10).unwrap_or_default();
    let (background, background_date) = if ask.kids_team {
        let (fact, date) = background_check(&reading, &ask.person, &sunday, today);
        (Some(fact), date)
    } else {
        (None, None)
    };
    // A read the deadline stopped is "couldn't be read" above; the change itself goes no further.
    if watch.fired() {
        return Err(Refusal::DeadlinePassed);
    }
    Ok(Looked {
        sunday,
        times: shown,
        still_needed,
        background,
        background_date,
    })
}

/// The person's background check as Planning Center's record says it, for that Sunday, and the date
/// the fact is about when it has one. `today`: the earliest calendar date anywhere (UTC-12), so a
/// date before it has passed everywhere. A check Planning Center still marks current whose end date has
/// passed is expired, said with that date (review S, M3).
fn background_check(
    reading: &Reading<'_>,
    person: &str,
    sunday: &str,
    today: &str,
) -> (BackgroundCheck, Option<String>) {
    let target = Target::people_person(person);
    let Ok(cleared) = reading.bodies(Collection::PeopleBackgroundChecks, &target) else {
        return (BackgroundCheck::CouldNotRead, None);
    };
    let mut pending = false;
    for collection in PENDING {
        match reading.bodies(collection, &target) {
            Ok(bodies) => pending |= rows(&bodies).next().is_some(),
            Err(_) => return (BackgroundCheck::CouldNotRead, None),
        }
    }
    let cleared: Vec<&Value> = rows(&cleared)
        .filter(|row| {
            row["attributes"]["status"]
                .as_str()
                .is_some_and(|status| CLEARED.contains(&status))
        })
        .collect();
    // A cleared check without its `current` or `expires_on` can't be placed.
    if cleared.iter().any(|row| {
        let a = &row["attributes"];
        !a["current"].is_boolean() || a.get("expires_on").is_none()
    }) {
        return (BackgroundCheck::CouldNotRead, None);
    }
    let ends = |row: &Value| row["attributes"]["expires_on"].as_str().map(str::to_owned);
    // Marked current, and its end date (if any) not yet passed.
    let current: Vec<&Value> = cleared
        .iter()
        .copied()
        .filter(|row| row["attributes"]["current"] == true)
        .filter(|row| ends(row).is_none_or(|date| date.as_str() >= today))
        .collect();
    if current
        .iter()
        .any(|row| ends(row).is_none_or(|date| date.as_str() > sunday))
    {
        return (BackgroundCheck::Current, None);
    }
    if let Some(latest) = current.iter().filter_map(|row| ends(row)).max() {
        return (BackgroundCheck::ExpiresByThatSunday, Some(latest));
    }
    if pending {
        return (BackgroundCheck::Pending, None);
    }
    if cleared.is_empty() {
        return (BackgroundCheck::NoneOnFile, None);
    }
    // Cleared checks, none current: the latest end date that has passed, when there is one;
    // otherwise Planning Center marks them not current for another reason.
    let ended = cleared
        .iter()
        .filter_map(|row| ends(row))
        .filter(|date| date.as_str() < today)
        .max();
    (BackgroundCheck::Expired, ended)
}

// ---- Reading a capture and a page ------------------------------------------------------------------

fn rows(bodies: &[Value]) -> impl Iterator<Item = &Value> {
    bodies
        .iter()
        .flat_map(|body| body["data"].as_array().into_iter().flatten())
}
fn included(bodies: &[Value]) -> impl Iterator<Item = &Value> {
    bodies
        .iter()
        .flat_map(|body| body["included"].as_array().into_iter().flatten())
}
fn id_of(row: &Value) -> Option<String> {
    row["id"]
        .as_str()
        .filter(|id| numeric_id(id))
        .map(str::to_owned)
}
fn link(row: &Value, key: &str) -> Option<String> {
    id_of(&row["relationships"][key]["data"])
}
fn links(row: &Value, key: &str) -> Vec<String> {
    row["relationships"][key]["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(id_of)
        .collect()
}
fn span(starts_at: Option<&str>, ends_at: Option<&str>) -> Option<(i64, i64)> {
    let (starts, ends) = (instant_ms(starts_at?)?, instant_ms(ends_at?)?);
    (starts < ends).then_some((starts, ends))
}
fn overlaps(a: (i64, i64), b: (i64, i64)) -> bool {
    a.0 < b.1 && b.0 < a.1
}
fn next_offset(body: &Value) -> Option<u64> {
    // Already validated by the projection: exact path, fixed query and paging only.
    let link = url::Url::parse(body["links"]["next"].as_str()?).ok()?;
    link.query_pairs()
        .find(|(key, _)| key == "offset")
        .and_then(|(_, value)| value.parse().ok())
}

/// What a live check showed for changes: each open role and who it listed for it.
fn seen(capture: &SundayCapture) -> Option<Seen> {
    if !numeric_id(&capture.organization)
        || !numeric_id(&capture.service_type_id)
        || !numeric_id(&capture.plan_id)
    {
        return None;
    }
    // Only reads that answered whole count; anything else lists no one.
    let whole = |collection: Collection| {
        capture
            .reads
            .iter()
            .filter(move |read| read.collection == collection.label() && !read.fallback)
    };
    let complete = |collection: Collection| {
        let reads: Vec<_> = whole(collection).collect();
        (!reads.is_empty()
            && reads
                .iter()
                .all(|read| read.outcome == "ok" && read.body.is_some()))
        .then(|| {
            reads
                .iter()
                .filter_map(|read| read.body.clone())
                .collect::<Vec<Value>>()
        })
    };
    let times: Vec<(i64, i64)> = complete(Collection::PlanTimes)
        .map(|bodies| {
            rows(&bodies)
                .filter_map(|row| {
                    span(
                        row["attributes"]["starts_at"].as_str(),
                        row["attributes"]["ends_at"].as_str(),
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    let members = complete(Collection::TeamMembers);
    let on_plan: Option<BTreeSet<String>> = members
        .as_ref()
        .map(|bodies| rows(bodies).filter_map(|row| link(row, "person")).collect());
    let needed = complete(Collection::NeededPositions)?;
    let mut roles = Vec::new();
    for row in rows(&needed) {
        let (Some(id), Some(team), Some(position), Some(quantity)) = (
            id_of(row),
            link(row, "team"),
            row["attributes"]["team_position_name"].as_str(),
            row["attributes"]["quantity"].as_u64(),
        ) else {
            continue;
        };
        if !plain_position(position) {
            continue;
        }
        let split = rows(&needed).any(|other| {
            link(other, "team").as_deref() == Some(&team)
                && !other["relationships"]["time"]["data"].is_null()
        });
        let listed = match (&on_plan, times.is_empty()) {
            (Some(on_plan), false) => listed(capture, &team, position, on_plan, &times),
            _ => BTreeSet::new(),
        };
        roles.push(Role {
            needed: id,
            team,
            position: position.to_owned(),
            quantity,
            split,
            listed,
        });
    }
    Some(Seen {
        organization: capture.organization.clone(),
        service_type: capture.service_type_id.clone(),
        plan: capture.plan_id.clone(),
        kids_teams: capture
            .kids_teams
            .iter()
            .filter(|id| numeric_id(id))
            .cloned()
            .collect(),
        roles,
    })
}
/// Who the check listed for one role as able to help: holding that position on that team (by
/// Planning Center's own name for it), on no row of the plan, with their blockouts and schedules read
/// whole, and no blockout or confirmed serving overlapping the plan's times. Someone the check left
/// out, or didn't read, isn't listed.
fn listed(
    capture: &SundayCapture,
    team: &str,
    position: &str,
    on_plan: &BTreeSet<String>,
    times: &[(i64, i64)],
) -> BTreeSet<String> {
    let reads = |collection: Collection| {
        capture
            .reads
            .iter()
            .filter(move |read| read.collection == collection.label())
    };
    let assignments: Vec<&crate::sunday_check::SundayRead> =
        reads(Collection::TeamPositionAssignments)
            .filter(|read| read.team_id.as_deref() == Some(team))
            .collect();
    if assignments.is_empty()
        || assignments
            .iter()
            .any(|read| read.outcome != "ok" || read.body.is_none())
    {
        return BTreeSet::new();
    }
    let bodies: Vec<Value> = assignments.iter().filter_map(|r| r.body.clone()).collect();
    let named: BTreeSet<String> = included(&bodies)
        .filter(|row| row["type"] == "TeamPosition" && row["attributes"]["name"] == position)
        .filter_map(id_of)
        .collect();
    let holders: BTreeSet<String> = rows(&bodies)
        .filter(|row| link(row, "team_position").is_some_and(|p| named.contains(&p)))
        .filter_map(|row| link(row, "person"))
        .filter(|person| !on_plan.contains(person))
        .collect();
    holders
        .into_iter()
        .filter(|person| {
            let own = |collection: Collection| {
                let mine: Vec<_> = reads(collection)
                    .filter(|read| read.person_id.as_deref() == Some(person.as_str()))
                    .collect();
                (!mine.is_empty() && mine.iter().all(|read| read.outcome == "ok")).then(|| {
                    mine.iter()
                        .filter_map(|read| read.body.clone())
                        .collect::<Vec<_>>()
                })
            };
            let (Some(blockouts), Some(schedules)) = (
                own(Collection::PersonBlockouts),
                own(Collection::PersonSchedules),
            ) else {
                return false;
            };
            let blocked = rows(&blockouts).any(|row| {
                let a = &row["attributes"];
                span(a["starts_at"].as_str(), a["ends_at"].as_str())
                    .is_some_and(|b| times.iter().any(|t| overlaps(*t, b)))
            });
            let plan_times: BTreeMap<String, (i64, i64)> = included(&schedules)
                .filter_map(|row| {
                    let a = &row["attributes"];
                    Some((
                        id_of(row)?,
                        span(a["starts_at"].as_str(), a["ends_at"].as_str())?,
                    ))
                })
                .collect();
            let confirmed_then = rows(&schedules).any(|row| {
                row["attributes"]["status"] == "C"
                    && links(row, "times").iter().any(|time| {
                        plan_times
                            .get(time)
                            .is_some_and(|span| times.iter().any(|t| overlaps(*t, *span)))
                    })
            });
            !blocked && !confirmed_then
        })
        .collect()
}

#[cfg(test)]
#[path = "change_tests.rs"]
mod tests;
