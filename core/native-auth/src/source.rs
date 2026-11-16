//! Private REST fallback protocol. No credentials, arbitrary URLs or write operations cross it.
use crate::oauth::numeric_id;
use serde::{Deserialize, Serialize};

pub const MAX_INPUT: usize = 4096;
pub const MAX_OUTPUT: usize = 262_144;
pub const MAX_OFFSET: u64 = 10_000;
/// Services API version (also the only product the stdin protocol reaches).
pub const VERSION: &str = "2018-11-01";
/// Pinned per product; each matches the latest stable version's OpenAPI for every resource,
/// filter and include read here (docs/build/sunday-capture-contract.md, v2 operations reads).
pub const CALENDAR_VERSION: &str = "2022-07-07";
pub const PEOPLE_VERSION: &str = "2025-11-10";
pub const GROUPS_VERSION: &str = "2023-07-10";
/// Check-Ins and Registrations: each product's latest published version, checked against Planning
/// Center's own published API documentation and OpenAPI on 2026-11-15 for every resource, filter
/// and include read here.
pub const CHECK_INS_VERSION: &str = "2025-05-28";
pub const REGISTRATIONS_VERSION: &str = "2025-05-01";
pub const ORIGIN: &str = "https://api.planningcenteronline.com";

/// One Planning Center product: its path prefix and pinned `X-PCO-API-Version`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Product {
    Services,
    Calendar,
    People,
    Groups,
    CheckIns,
    Registrations,
}
impl Product {
    pub fn version(self) -> &'static str {
        match self {
            Self::Services => VERSION,
            Self::Calendar => CALENDAR_VERSION,
            Self::People => PEOPLE_VERSION,
            Self::Groups => GROUPS_VERSION,
            Self::CheckIns => CHECK_INS_VERSION,
            Self::Registrations => REGISTRATIONS_VERSION,
        }
    }
    fn prefix(self) -> &'static str {
        match self {
            Self::Services => "/services/v2",
            Self::Calendar => "/calendar/v2",
            Self::People => "/people/v2",
            Self::Groups => "/groups/v2",
            Self::CheckIns => "/check-ins/v2",
            Self::Registrations => "/registrations/v2",
        }
    }
    /// Whether a saved connection's granted set lets this product be read at all. Services is
    /// always granted; Calendar, People and Groups come together (operations); Check-Ins and
    /// Registrations are each their own opt-in. A product not granted is never requested.
    pub(crate) fn granted(self, scopes: crate::oauth::Scopes) -> bool {
        match self {
            Self::Services => true,
            Self::Calendar | Self::People | Self::Groups => scopes.operations(),
            Self::CheckIns => scopes.check_ins(),
            Self::Registrations => scopes.registrations(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SourceError {
    InvalidRequest,
    BindingMismatch,
    MissingCredentials,
    Locked,
    Denied,
    StoreUnavailable,
    InvalidCredentials,
    OrganizationUnverified,
    ProviderFailure,
    InvalidResponse,
    Oversized,
    Cancelled,
    Timeout,
    Busy,
    /// HTTP 429, with the provider's Retry-After seconds when given. Capture reads only.
    RateLimited(Option<u16>),
    /// HTTP 400/422: the provider refused this exact query. Capture reads only.
    Rejected,
    /// HTTP 404 from `groups_person_memberships` only: Groups has no profile for this Services
    /// person, so they are in no group. Internal: the check reads it as an empty page and it
    /// is never a recorded outcome. Every other 404 stays `ProviderFailure`.
    NotFound,
}
impl SourceError {
    pub fn reason(self) -> &'static str {
        match self {
            Self::InvalidRequest => "invalid-request",
            Self::BindingMismatch => "binding-mismatch",
            Self::MissingCredentials => "missing-credentials",
            Self::Locked => "locked",
            Self::Denied => "denied",
            Self::StoreUnavailable => "store-unavailable",
            Self::InvalidCredentials => "invalid-credentials",
            Self::OrganizationUnverified => "organization-unverified",
            Self::ProviderFailure => "provider-failure",
            Self::InvalidResponse => "invalid-response",
            Self::Oversized => "oversized",
            Self::Cancelled => "cancelled",
            Self::Timeout => "timeout",
            Self::Busy => "busy",
            Self::RateLimited(_) => "rate-limited",
            Self::Rejected => "rejected",
            Self::NotFound => "not-found",
        }
    }
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidRequest
            | Self::BindingMismatch
            | Self::Locked
            | Self::Denied
            | Self::OrganizationUnverified => "denied",
            Self::ProviderFailure
            | Self::InvalidResponse
            | Self::Oversized
            | Self::Timeout
            | Self::RateLimited(_)
            | Self::Rejected
            | Self::NotFound => "provider-failure",
            _ => "unverified",
        }
    }
    pub fn envelope(self) -> serde_json::Value {
        serde_json::json!({"version":1,"ok":false,"code":self.code(),"reason":self.reason()})
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Collection {
    NeededPositions,
    TeamMembers,
    PlanTimes,
    Plan,
    TeamPositionAssignments,
    TeamLeaders,
    PersonSchedules,
    /// Same read without `filter=all`; only used when the filtered read is refused.
    PersonSchedulesUnfiltered,
    PersonBlockouts,
    /// The Services Organization (`/services/v2`): the church's time zone only, which decides
    /// its local Sunday. Capture only.
    Organization,
    // v2 operations reads: capture only, never on the stdin protocol.
    CalendarRooms,
    CalendarResourceBookings,
    /// Calendar's own conflict records for one event of the Sunday's bookings.
    CalendarEventConflicts,
    PeopleWorkflows,
    PeopleWorkflowSteps,
    PeopleWorkflowReadyCards,
    PeopleWorkflowSnoozedCards,
    GroupsPersonMemberships,
    GroupsGroupEvents,
    /// One person's cleared People background checks (`filter=complete_clear`), for the kids
    /// rule "a current background check before serving with kids". Capture only, and only for
    /// people scheduled on a team the church marked as a kids team.
    PeopleBackgroundChecks,
    // Setup's Sunday picker (sunday_picker.rs): in-process only, never on the stdin protocol, and
    // never part of a Sunday capture. They come before a plan is chosen, so they name less of one.
    /// The church's Services service types (`/services/v2/service_types`), with no plan context.
    ServiceTypes,
    /// One service type's upcoming plans (`filter=future`), with no plan id.
    UpcomingPlans,
    // Church reads (People forms, Check-Ins, Registrations): capture only, never on the stdin
    // protocol. Each is read only when its product was granted (forms: People, and only once the
    // church turned forms on in Church rules). Counts and labels; never an answer, never a child.
    /// The church's People forms that aren't archived (`filter=not_archived`): names as labels.
    PeopleForms,
    /// One chosen form's submissions created in the recent window, with who submitted (a Person
    /// link and its name, local only). Never the submitted answers.
    PeopleFormSubmissions,
    /// The church's Check-Ins events that aren't archived (`filter=not_archived`).
    CheckInsEvents,
    /// One Check-Ins event's places to check in (rooms and folders): names as labels.
    CheckInsLocations,
    /// One Check-Ins event's periods overlapping the recent window, with their event times
    /// (`include=event_times`, start times only).
    CheckInsEventPeriods,
    /// One event time's per-room counts (`LocationEventTime`): regular, guest and volunteer
    /// check-ins as Planning Center counts them. No check-in, person or child is ever read.
    CheckInsLocationCounts,
    /// The church's Registrations signups that aren't archived (`filter=unarchived`).
    RegistrationsSignups,
    /// One open signup's active attendees (`filter=active`): whether each is active, canceled or
    /// waitlisted, and nothing else, so they can be counted. No name, person or registration.
    RegistrationsAttendees,
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Scope {
    ServiceType,
    Plan,
    Team,
    Person,
    Organization,
    /// A Calendar Event, from a booking's `event` link.
    Event,
    Workflow,
    Group,
    /// A Person read through Groups; kept apart from Services `person_id` scopes.
    GroupsPerson,
    /// A Person read through People (background checks); kept apart like `GroupsPerson`.
    PeoplePerson,
    /// A service type's plans, before one is chosen (`/service_types/{id}/plans`).
    ServiceTypePlans,
    /// A People Form (`/people/v2/forms/{id}`).
    Form,
    /// A Check-Ins Event (`/check-ins/v2/events/{id}`); kept apart from Calendar's `Event`.
    CheckInsEvent,
    /// A Check-Ins EventTime (`/check-ins/v2/event_times/{id}`).
    CheckInsEventTime,
    /// A Registrations Signup (`/registrations/v2/signups/{id}`).
    Signup,
}
impl Collection {
    /// Contract name recorded in a Sunday capture.
    pub fn label(self) -> &'static str {
        match self {
            Self::NeededPositions => "needed_positions",
            Self::TeamMembers => "team_members",
            Self::PlanTimes => "plan_times",
            Self::Plan => "plan",
            Self::TeamPositionAssignments => "team_position_assignments",
            Self::TeamLeaders => "team_leaders",
            Self::PersonSchedules | Self::PersonSchedulesUnfiltered => "person_schedules",
            Self::PersonBlockouts => "person_blockouts",
            Self::Organization => "organization",
            Self::CalendarRooms => "calendar_rooms",
            Self::CalendarResourceBookings => "calendar_resource_bookings",
            Self::CalendarEventConflicts => "calendar_conflicts",
            Self::PeopleWorkflows => "people_workflows",
            Self::PeopleWorkflowSteps => "people_workflow_steps",
            Self::PeopleWorkflowReadyCards => "people_workflow_ready_cards",
            Self::PeopleWorkflowSnoozedCards => "people_workflow_snoozed_cards",
            Self::GroupsPersonMemberships => "groups_person_memberships",
            Self::GroupsGroupEvents => "groups_group_events",
            Self::PeopleBackgroundChecks => "people_background_checks",
            Self::ServiceTypes => "service_types",
            Self::UpcomingPlans => "upcoming_plans",
            Self::PeopleForms => "people_forms",
            Self::PeopleFormSubmissions => "people_form_submissions",
            Self::CheckInsEvents => "checkins_events",
            Self::CheckInsLocations => "checkins_locations",
            Self::CheckInsEventPeriods => "checkins_event_periods",
            Self::CheckInsLocationCounts => "checkins_location_counts",
            Self::RegistrationsSignups => "registrations_signups",
            Self::RegistrationsAttendees => "registrations_attendees",
        }
    }
    pub fn product(self) -> Product {
        match self {
            Self::CalendarRooms | Self::CalendarResourceBookings | Self::CalendarEventConflicts => {
                Product::Calendar
            }
            Self::PeopleWorkflows
            | Self::PeopleWorkflowSteps
            | Self::PeopleWorkflowReadyCards
            | Self::PeopleWorkflowSnoozedCards
            | Self::PeopleBackgroundChecks
            | Self::PeopleForms
            | Self::PeopleFormSubmissions => Product::People,
            Self::GroupsPersonMemberships | Self::GroupsGroupEvents => Product::Groups,
            Self::CheckInsEvents
            | Self::CheckInsLocations
            | Self::CheckInsEventPeriods
            | Self::CheckInsLocationCounts => Product::CheckIns,
            Self::RegistrationsSignups | Self::RegistrationsAttendees => Product::Registrations,
            _ => Product::Services,
        }
    }
    /// The external stdin protocol stays limited to its original three closed schemas.
    fn protocol(self) -> bool {
        matches!(
            self,
            Self::NeededPositions | Self::TeamMembers | Self::PlanTimes
        )
    }
    fn scope(self) -> Scope {
        match self {
            Self::Plan => Scope::ServiceType,
            Self::NeededPositions | Self::TeamMembers | Self::PlanTimes => Scope::Plan,
            Self::TeamPositionAssignments | Self::TeamLeaders => Scope::Team,
            Self::PersonSchedules | Self::PersonSchedulesUnfiltered | Self::PersonBlockouts => {
                Scope::Person
            }
            Self::Organization
            | Self::CalendarRooms
            | Self::CalendarResourceBookings
            | Self::PeopleWorkflows => Scope::Organization,
            Self::CalendarEventConflicts => Scope::Event,
            Self::PeopleWorkflowSteps
            | Self::PeopleWorkflowReadyCards
            | Self::PeopleWorkflowSnoozedCards => Scope::Workflow,
            Self::GroupsGroupEvents => Scope::Group,
            Self::GroupsPersonMemberships => Scope::GroupsPerson,
            Self::PeopleBackgroundChecks => Scope::PeoplePerson,
            // `/services/v2/service_types`: the Services Organization is its parent.
            Self::ServiceTypes => Scope::Organization,
            Self::UpcomingPlans => Scope::ServiceTypePlans,
            Self::PeopleForms | Self::CheckInsEvents | Self::RegistrationsSignups => {
                Scope::Organization
            }
            Self::PeopleFormSubmissions => Scope::Form,
            Self::CheckInsLocations | Self::CheckInsEventPeriods => Scope::CheckInsEvent,
            Self::CheckInsLocationCounts => Scope::CheckInsEventTime,
            Self::RegistrationsAttendees => Scope::Signup,
        }
    }
    /// Which Sunday ids a request names: (service type, plan). Every Sunday read names both;
    /// the picker's reads come before a plan is chosen and must leave the rest empty.
    fn context(self) -> (bool, bool) {
        match self {
            Self::ServiceTypes => (false, false),
            Self::UpcomingPlans => (true, false),
            _ => (true, true),
        }
    }
    /// The breaker key for this read: its product and endpoint. Reads that differ only in a
    /// fixed filter (ready and snoozed cards; filtered and fallback schedules) share one. The
    /// plan and the organization have no path segment of their own, so their label stands in.
    pub(crate) fn endpoint(self) -> (Product, &'static str) {
        let path = self.path();
        (
            self.product(),
            if path.is_empty() { self.label() } else { path },
        )
    }
    /// The `labels` key prefix for rows whose free-text `name` this read keeps locally.
    pub(crate) fn label_prefix(self) -> Option<&'static str> {
        LABELLED
            .iter()
            .find(|(_, collection)| *collection == self)
            .map(|(prefix, _)| *prefix)
    }
    /// Reads bounded to the Sunday's time window (`where[ends_at][gt]`/`where[starts_at][lt]`).
    fn windowed(self) -> bool {
        matches!(
            self,
            Self::CalendarResourceBookings | Self::GroupsGroupEvents
        ) || self.recent()
    }
    /// Windowed reads bounded instead to the days before the check (`sunday_check::recent_window`):
    /// Check-Ins periods overlapping it, and form submissions created inside it.
    pub(crate) fn recent(self) -> bool {
        matches!(
            self,
            Self::CheckInsEventPeriods | Self::PeopleFormSubmissions
        )
    }
    fn paginated(self) -> bool {
        !matches!(self, Self::Plan | Self::Organization)
    }
    fn path(self) -> &'static str {
        match self {
            Self::NeededPositions => "needed_positions",
            Self::TeamMembers => "team_members",
            Self::PlanTimes => "plan_times",
            Self::Plan | Self::Organization => "",
            Self::TeamPositionAssignments => "person_team_position_assignments",
            Self::TeamLeaders => "team_leaders",
            Self::PersonSchedules | Self::PersonSchedulesUnfiltered => "schedules",
            Self::PersonBlockouts => "blockouts",
            Self::CalendarRooms => "resources",
            Self::CalendarResourceBookings => "resource_bookings",
            Self::CalendarEventConflicts => "conflicts",
            Self::PeopleWorkflows => "workflows",
            Self::PeopleWorkflowSteps => "steps",
            Self::PeopleWorkflowReadyCards | Self::PeopleWorkflowSnoozedCards => "cards",
            Self::GroupsPersonMemberships => "memberships",
            Self::GroupsGroupEvents => "events",
            Self::PeopleBackgroundChecks => "background_checks",
            Self::ServiceTypes => "service_types",
            Self::UpcomingPlans => "plans",
            Self::PeopleForms => "forms",
            Self::PeopleFormSubmissions => "form_submissions",
            Self::CheckInsEvents => "events",
            Self::CheckInsLocations => "locations",
            Self::CheckInsEventPeriods => "event_periods",
            Self::CheckInsLocationCounts => "location_event_times",
            Self::RegistrationsSignups => "signups",
            Self::RegistrationsAttendees => "attendees",
        }
    }
    fn resource(self) -> &'static str {
        match self {
            Self::NeededPositions => "NeededPosition",
            Self::TeamMembers => "PlanPerson",
            Self::PlanTimes => "PlanTime",
            Self::Plan => "Plan",
            Self::TeamPositionAssignments => "PersonTeamPositionAssignment",
            Self::TeamLeaders => "TeamLeader",
            Self::PersonSchedules | Self::PersonSchedulesUnfiltered => "Schedule",
            Self::PersonBlockouts => "Blockout",
            Self::Organization => "Organization",
            Self::CalendarRooms => "Resource",
            Self::CalendarResourceBookings => "ResourceBooking",
            Self::CalendarEventConflicts => "Conflict",
            Self::PeopleWorkflows => "Workflow",
            Self::PeopleWorkflowSteps => "WorkflowStep",
            Self::PeopleWorkflowReadyCards | Self::PeopleWorkflowSnoozedCards => "WorkflowCard",
            Self::GroupsPersonMemberships => "Membership",
            Self::GroupsGroupEvents => "Event",
            Self::PeopleBackgroundChecks => "BackgroundCheck",
            Self::ServiceTypes => "ServiceType",
            Self::UpcomingPlans => "Plan",
            Self::PeopleForms => "Form",
            Self::PeopleFormSubmissions => "FormSubmission",
            Self::CheckInsEvents => "Event",
            Self::CheckInsLocations => "Location",
            Self::CheckInsEventPeriods => "EventPeriod",
            Self::CheckInsLocationCounts => "LocationEventTime",
            Self::RegistrationsSignups => "Signup",
            Self::RegistrationsAttendees => "Attendee",
        }
    }
}
/// Reads whose rows carry a free-text display `name` (a room, follow-up workflow or step, a
/// service type, a form, a Check-Ins event or room, or a signup). Such names can name a person
/// ("Follow-up for ...", "Smith family baptism"), so they never stay in a body: the projection
/// moves each into the page's local `labels` as `<prefix>:<row id>`. A capture never reads
/// service types, so a recording can't hold a `service_type:` label.
pub(crate) const LABELLED: [(&str, Collection); 8] = [
    ("room", Collection::CalendarRooms),
    ("workflow", Collection::PeopleWorkflows),
    ("step", Collection::PeopleWorkflowSteps),
    ("service_type", Collection::ServiceTypes),
    ("form", Collection::PeopleForms),
    ("checkins_event", Collection::CheckInsEvents),
    ("checkins_location", Collection::CheckInsLocations),
    ("signup", Collection::RegistrationsSignups),
];
/// Longest label kept, in characters.
pub(crate) const LABEL_CHARS: usize = 120;
/// Local display form of a free-text name: control characters, line and paragraph separators
/// and bidirectional embedding/override/isolate characters become spaces, whitespace runs
/// collapse to one space, and anything past LABEL_CHARS characters is cut, ending in `…`.
/// Idempotent, so a recording's labels must already be in this form.
pub(crate) fn display_label(text: &str) -> String {
    let spaced: String = text
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}') {
                ' '
            } else {
                c
            }
        })
        .collect();
    let words: Vec<&str> = spaced.split_whitespace().collect();
    let joined = words.join(" ");
    if joined.chars().count() <= LABEL_CHARS {
        return joined;
    }
    let cut: String = joined.chars().take(LABEL_CHARS - 1).collect();
    format!("{}…", cut.trim_end())
}
/// The Sunday a windowed read covers, as canonical whole-second UTC instants
/// (`2026-11-21T10:00:00Z`). Half-open: rows ending after `starts_at` and starting before `ends_at`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Window {
    pub starts_at: String,
    pub ends_at: String,
}
impl Window {
    fn valid(&self) -> bool {
        let canonical = |s: &str| s.len() == 20 && s.ends_with('Z') && instant(&json!(s));
        canonical(&self.starts_at) && canonical(&self.ends_at) && self.starts_at < self.ends_at
    }
}
/// What a capture read is about beyond the plan: at most one id, plus the window for windowed
/// reads. Only `team_id`/`person_id` exist on the stdin protocol; the rest are capture only.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Target {
    pub(crate) team_id: Option<String>,
    pub(crate) person_id: Option<String>,
    pub(crate) event_id: Option<String>,
    pub(crate) workflow_id: Option<String>,
    pub(crate) group_id: Option<String>,
    pub(crate) groups_person_id: Option<String>,
    pub(crate) people_person_id: Option<String>,
    pub(crate) form_id: Option<String>,
    pub(crate) checkins_event_id: Option<String>,
    pub(crate) checkins_event_time_id: Option<String>,
    pub(crate) signup_id: Option<String>,
    pub(crate) window: Option<Window>,
}
impl Target {
    pub(crate) fn event(id: &str) -> Self {
        Self {
            event_id: Some(id.into()),
            ..Self::default()
        }
    }
    pub(crate) fn team(id: &str) -> Self {
        Self {
            team_id: Some(id.into()),
            ..Self::default()
        }
    }
    pub(crate) fn person(id: &str) -> Self {
        Self {
            person_id: Some(id.into()),
            ..Self::default()
        }
    }
    pub(crate) fn workflow(id: &str) -> Self {
        Self {
            workflow_id: Some(id.into()),
            ..Self::default()
        }
    }
    pub(crate) fn group(id: &str) -> Self {
        Self {
            group_id: Some(id.into()),
            ..Self::default()
        }
    }
    pub(crate) fn groups_person(id: &str) -> Self {
        Self {
            groups_person_id: Some(id.into()),
            ..Self::default()
        }
    }
    pub(crate) fn people_person(id: &str) -> Self {
        Self {
            people_person_id: Some(id.into()),
            ..Self::default()
        }
    }
    pub(crate) fn form(id: &str) -> Self {
        Self {
            form_id: Some(id.into()),
            ..Self::default()
        }
    }
    pub(crate) fn checkins_event(id: &str) -> Self {
        Self {
            checkins_event_id: Some(id.into()),
            ..Self::default()
        }
    }
    pub(crate) fn checkins_event_time(id: &str) -> Self {
        Self {
            checkins_event_time_id: Some(id.into()),
            ..Self::default()
        }
    }
    pub(crate) fn signup(id: &str) -> Self {
        Self {
            signup_id: Some(id.into()),
            ..Self::default()
        }
    }
    pub(crate) fn within(mut self, window: &Window) -> Self {
        self.window = Some(window.clone());
        self
    }
}
/// Which closed schema a request projects into. Deserialized (stdin protocol) requests are
/// always `Protocol`; `Capture` requests exist only in-process for the Sunday check, so
/// included Person names can never reach the protocol channel.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum Profile {
    #[default]
    Protocol,
    Capture,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SourceRequest {
    pub(crate) version: u8,
    pub(crate) workspace: String,
    pub(crate) organization: String,
    pub(crate) client_id: String,
    pub(crate) service_type_id: String,
    pub(crate) plan_id: String,
    pub(crate) collection: Collection,
    pub(crate) per_page: u16,
    pub(crate) offset: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) team_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) person_id: Option<String>,
    // Capture only: never read from or written to the stdin protocol.
    #[serde(skip)]
    pub(crate) event_id: Option<String>,
    #[serde(skip)]
    pub(crate) workflow_id: Option<String>,
    #[serde(skip)]
    pub(crate) group_id: Option<String>,
    #[serde(skip)]
    pub(crate) groups_person_id: Option<String>,
    #[serde(skip)]
    pub(crate) people_person_id: Option<String>,
    #[serde(skip)]
    pub(crate) form_id: Option<String>,
    #[serde(skip)]
    pub(crate) checkins_event_id: Option<String>,
    #[serde(skip)]
    pub(crate) checkins_event_time_id: Option<String>,
    #[serde(skip)]
    pub(crate) signup_id: Option<String>,
    #[serde(skip)]
    pub(crate) window: Option<Window>,
    #[serde(skip)]
    pub(crate) profile: Profile,
}
impl SourceRequest {
    /// Services capture read by team or person id (the original test-facing shape).
    #[cfg(test)]
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn capture(
        binding: &crate::oauth::Binding,
        service_type_id: &str,
        plan_id: &str,
        collection: Collection,
        team_id: Option<&str>,
        person_id: Option<&str>,
        per_page: u16,
        offset: u64,
    ) -> Result<Self, SourceError> {
        let target = Target {
            team_id: team_id.map(Into::into),
            person_id: person_id.map(Into::into),
            ..Target::default()
        };
        Self::capture_at(
            binding,
            service_type_id,
            plan_id,
            collection,
            &target,
            per_page,
            offset,
        )
    }
    /// In-process capture read with any target; `validate` decides which targets fit.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn capture_at(
        binding: &crate::oauth::Binding,
        service_type_id: &str,
        plan_id: &str,
        collection: Collection,
        target: &Target,
        per_page: u16,
        offset: u64,
    ) -> Result<Self, SourceError> {
        let request = Self {
            version: 1,
            workspace: binding.workspace.clone(),
            organization: binding.organization.clone(),
            client_id: binding.client_id.clone(),
            service_type_id: service_type_id.into(),
            plan_id: plan_id.into(),
            collection,
            per_page,
            offset,
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
            profile: Profile::Capture,
        };
        request.validate()?;
        Ok(request)
    }
    pub fn validate(&self) -> Result<(), SourceError> {
        let text = |s: &str, max, colon| {
            !s.is_empty()
                && s.len() <= max
                && s.bytes().all(|b| {
                    b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || (colon && b == b':')
                })
        };
        // Exactly the one id this collection's scope names, and no other.
        let ids = [
            (Scope::Team, &self.team_id),
            (Scope::Person, &self.person_id),
            (Scope::Event, &self.event_id),
            (Scope::Workflow, &self.workflow_id),
            (Scope::Group, &self.group_id),
            (Scope::GroupsPerson, &self.groups_person_id),
            (Scope::PeoplePerson, &self.people_person_id),
            (Scope::Form, &self.form_id),
            (Scope::CheckInsEvent, &self.checkins_event_id),
            (Scope::CheckInsEventTime, &self.checkins_event_time_id),
            (Scope::Signup, &self.signup_id),
        ];
        let scope = self.collection.scope();
        let scoped = ids.iter().all(|(owner, id)| {
            if *owner == scope {
                id.as_deref().is_some_and(numeric_id)
            } else {
                id.is_none()
            }
        });
        let windowed = match &self.window {
            Some(window) => self.collection.windowed() && window.valid(),
            None => !self.collection.windowed(),
        };
        // Each Sunday id the collection names is a valid id; one it doesn't name is empty.
        let (names_type, names_plan) = self.collection.context();
        let context = |id: &str, named: bool| if named { numeric_id(id) } else { id.is_empty() };
        if self.version != 1
            || !text(&self.workspace, 128, true)
            || !text(&self.client_id, 256, false)
            || !numeric_id(&self.organization)
            || !context(&self.service_type_id, names_type)
            || !context(&self.plan_id, names_plan)
            || !(1..=100).contains(&self.per_page)
            || self.offset > MAX_OFFSET
            || (self.profile == Profile::Protocol && !self.collection.protocol())
            || !scoped
            || !windowed
            || (!self.collection.paginated() && self.offset != 0)
        {
            return Err(SourceError::InvalidRequest);
        }
        Ok(())
    }
    /// Fixed, non-paging query parameters for this read, in URL order. Window values are
    /// validated canonical instants; nothing else in a query comes from outside this table.
    fn query(&self) -> Vec<(&'static str, String)> {
        let fixed = |pairs: &[(&'static str, &str)]| -> Vec<(&'static str, String)> {
            pairs.iter().map(|&(k, v)| (k, v.to_owned())).collect()
        };
        let (starts_at, ends_at) = self
            .window
            .as_ref()
            .map_or(("", ""), |w| (w.starts_at.as_str(), w.ends_at.as_str()));
        let window = [
            ("where[ends_at][gt]", starts_at),
            ("where[starts_at][lt]", ends_at),
            ("order", "starts_at"),
        ];
        match self.collection {
            Collection::TeamMembers if self.profile == Profile::Capture => {
                fixed(&[("include", "person")])
            }
            Collection::TeamPositionAssignments => fixed(&[("include", "person,team_position")]),
            Collection::TeamLeaders => fixed(&[("include", "people")]),
            Collection::PersonSchedules => fixed(&[("filter", "all"), ("include", "plan_times")]),
            Collection::PersonSchedulesUnfiltered => fixed(&[("include", "plan_times")]),
            Collection::CalendarRooms => fixed(&[("filter", "rooms")]),
            Collection::CalendarResourceBookings => {
                let mut query =
                    fixed(&[("filter", "rooms"), ("include", "event_resource_request")]);
                query.extend(fixed(&window));
                query
            }
            Collection::PeopleWorkflowReadyCards => fixed(&[("where[stage]", "ready")]),
            Collection::PeopleWorkflowSnoozedCards => fixed(&[("where[stage]", "snoozed")]),
            Collection::GroupsGroupEvents => fixed(&window),
            // Cleared checks only: an unfinished or not-cleared check never reaches this Mac.
            Collection::PeopleBackgroundChecks => fixed(&[("filter", "complete_clear")]),
            Collection::UpcomingPlans => fixed(&[("filter", "future"), ("order", "sort_date")]),
            Collection::PeopleForms | Collection::CheckInsEvents => {
                fixed(&[("filter", "not_archived")])
            }
            // Whom it's for: only the Person's name and whether they're a child ever travel.
            // Answers are never included.
            Collection::PeopleFormSubmissions => fixed(&[
                ("include", "person"),
                ("fields[Person]", "name,child"),
                ("where[created_at][gte]", starts_at),
                ("where[created_at][lt]", ends_at),
                ("order", "created_at"),
            ]),
            Collection::CheckInsEventPeriods => {
                let mut query = fixed(&[("include", "event_times")]);
                query.extend(fixed(&window));
                query
            }
            Collection::RegistrationsSignups => fixed(&[("filter", "unarchived")]),
            // Only what counting needs ever travels: never an attendee's name.
            Collection::RegistrationsAttendees => fixed(&[
                ("filter", "active"),
                ("fields[Attendee]", "active,canceled,waitlisted"),
            ]),
            // A count names its room only when the room is included (Planning Center's published
            // LocationEventTime renders no relationships); the included rooms are dropped unread.
            Collection::CheckInsLocationCounts => fixed(&[("include", "location")]),
            _ => Vec::new(),
        }
    }
    fn parent(&self) -> (&'static str, &str) {
        match self.collection.scope() {
            Scope::ServiceType => ("ServiceType", &self.service_type_id),
            Scope::Plan => ("Plan", &self.plan_id),
            Scope::Team => ("Team", self.team_id.as_deref().unwrap_or_default()),
            Scope::Person => ("Person", self.person_id.as_deref().unwrap_or_default()),
            Scope::Organization => ("Organization", &self.organization),
            Scope::Event => ("Event", self.event_id.as_deref().unwrap_or_default()),
            Scope::Workflow => ("Workflow", self.workflow_id.as_deref().unwrap_or_default()),
            Scope::Group => ("Group", self.group_id.as_deref().unwrap_or_default()),
            Scope::GroupsPerson => (
                "Person",
                self.groups_person_id.as_deref().unwrap_or_default(),
            ),
            Scope::PeoplePerson => (
                "Person",
                self.people_person_id.as_deref().unwrap_or_default(),
            ),
            Scope::ServiceTypePlans => ("ServiceType", &self.service_type_id),
            Scope::Form => ("Form", self.form_id.as_deref().unwrap_or_default()),
            Scope::CheckInsEvent => (
                "Event",
                self.checkins_event_id.as_deref().unwrap_or_default(),
            ),
            Scope::CheckInsEventTime => (
                "EventTime",
                self.checkins_event_time_id.as_deref().unwrap_or_default(),
            ),
            Scope::Signup => ("Signup", self.signup_id.as_deref().unwrap_or_default()),
        }
    }
    fn path(&self) -> String {
        let plan = format!(
            "/services/v2/service_types/{}/plans/{}",
            self.service_type_id, self.plan_id
        );
        let segment = self.collection.path();
        let prefix = self.collection.product().prefix();
        let under = |parent: &str, id: &Option<String>| {
            format!(
                "{prefix}/{parent}/{}/{segment}",
                id.as_deref().unwrap_or_default()
            )
        };
        match self.collection.scope() {
            Scope::ServiceType => plan,
            Scope::Plan => format!("{plan}/{segment}"),
            Scope::Team => under("teams", &self.team_id),
            Scope::Person => under("people", &self.person_id),
            // The Services Organization is the product root itself: `/services/v2`.
            Scope::Organization if segment.is_empty() => prefix.to_owned(),
            Scope::Organization => format!("{prefix}/{segment}"),
            Scope::Event => under("events", &self.event_id),
            Scope::Workflow => under("workflows", &self.workflow_id),
            Scope::Group => under("groups", &self.group_id),
            Scope::GroupsPerson => under("people", &self.groups_person_id),
            Scope::PeoplePerson => under("people", &self.people_person_id),
            Scope::ServiceTypePlans => {
                format!("{prefix}/service_types/{}/{segment}", self.service_type_id)
            }
            Scope::Form => under("forms", &self.form_id),
            Scope::CheckInsEvent => under("events", &self.checkins_event_id),
            Scope::CheckInsEventTime => under("event_times", &self.checkins_event_time_id),
            Scope::Signup => under("signups", &self.signup_id),
        }
    }
    pub fn url(&self) -> String {
        let path = self.path();
        if !self.collection.paginated() {
            return format!("{ORIGIN}{path}");
        }
        let mut query: Vec<String> = self
            .query()
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect();
        query.push(format!("per_page={}", self.per_page));
        query.push(format!("offset={}", self.offset));
        format!("{ORIGIN}{path}?{}", query.join("&"))
    }
    pub fn binding(&self) -> crate::oauth::Binding {
        crate::oauth::Binding {
            workspace: self.workspace.clone(),
            organization: self.organization.clone(),
            client_id: self.client_id.clone(),
        }
    }
}
pub fn parse_request(bytes: &[u8]) -> Result<SourceRequest, SourceError> {
    if bytes.len() > MAX_INPUT {
        return Err(SourceError::Oversized);
    }
    let request: SourceRequest =
        serde_json::from_slice(bytes).map_err(|_| SourceError::InvalidRequest)?;
    request.validate()?;
    Ok(request)
}

use serde_json::{Map, Value, json};
use std::{collections::BTreeMap, io::Read, time::Duration};
use zeroize::Zeroizing;

// serde_json::Value normally keeps the last duplicate key. Source contradictions
// must fail closed rather than disappear during minimization.
struct UniqueJson(Value);
impl<'de> Deserialize<'de> for UniqueJson {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = UniqueJson;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("JSON without duplicate keys")
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut input: A,
            ) -> Result<Self::Value, A::Error> {
                let mut map = Map::new();
                while let Some(key) = input.next_key::<String>()? {
                    if map.contains_key(&key) {
                        return Err(serde::de::Error::custom("duplicate key"));
                    }
                    map.insert(key, input.next_value::<UniqueJson>()?.0);
                }
                Ok(UniqueJson(Value::Object(map)))
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut input: A,
            ) -> Result<Self::Value, A::Error> {
                let mut values = Vec::new();
                while let Some(v) = input.next_element::<UniqueJson>()? {
                    values.push(v.0);
                }
                Ok(UniqueJson(Value::Array(values)))
            }
            fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<Self::Value, E> {
                Ok(UniqueJson(Value::String(v.into())))
            }
            fn visit_string<E: serde::de::Error>(self, v: String) -> Result<Self::Value, E> {
                Ok(UniqueJson(Value::String(v)))
            }
            fn visit_bool<E: serde::de::Error>(self, v: bool) -> Result<Self::Value, E> {
                Ok(UniqueJson(json!(v)))
            }
            fn visit_u64<E: serde::de::Error>(self, v: u64) -> Result<Self::Value, E> {
                Ok(UniqueJson(json!(v)))
            }
            fn visit_i64<E: serde::de::Error>(self, v: i64) -> Result<Self::Value, E> {
                Ok(UniqueJson(json!(v)))
            }
            fn visit_f64<E: serde::de::Error>(self, v: f64) -> Result<Self::Value, E> {
                Ok(UniqueJson(json!(v)))
            }
            fn visit_unit<E: serde::de::Error>(self) -> Result<Self::Value, E> {
                Ok(UniqueJson(Value::Null))
            }
        }
        deserializer.deserialize_any(Visitor)
    }
}

/// Intentionally not Debug: even minimized source data must not be logged.
pub struct SourcePage {
    headers: BTreeMap<String, String>,
    body: Value,
    /// Free-text row names moved out of `body` (see LABELLED). Local display only: never in the
    /// envelope, never model input.
    labels: BTreeMap<String, String>,
}
impl SourcePage {
    pub fn envelope(&self) -> Value {
        json!({"version":1,"ok":true,"status":200,"headers":self.headers,"body":self.body})
    }
    pub(crate) fn body(&self) -> &Value {
        &self.body
    }
    pub(crate) fn headers(&self) -> &BTreeMap<String, String> {
        &self.headers
    }
    pub(crate) fn labels(&self) -> &BTreeMap<String, String> {
        &self.labels
    }
}
fn nonnegative(v: &Value) -> bool {
    v.as_u64().is_some_and(|n| n <= 9_007_199_254_740_991)
}
const PROTOCOL_TYPES: &[&str] = &[
    "NeededPosition",
    "PlanPerson",
    "PlanTime",
    "Plan",
    "ServiceType",
    "Team",
    "Person",
    "TeamPosition",
];
const CAPTURE_TYPES: &[&str] = &[
    "NeededPosition",
    "PlanPerson",
    "PlanTime",
    "Plan",
    "ServiceType",
    "Team",
    "Person",
    "TeamPosition",
    "PersonTeamPositionAssignment",
    "TeamLeader",
    "Schedule",
    "Blockout",
    "Organization",
];
/// Row types of the v2 operations reads; each read also pins its own row type and, per
/// relationship key, the types that key may link to.
const OPERATIONS_TYPES: &[&str] = &[
    "Resource",
    "ResourceBooking",
    "Conflict",
    "Workflow",
    "WorkflowStep",
    "WorkflowCard",
    "Membership",
    "Event",
    "BackgroundCheck",
    "Form",
    "FormSubmission",
    "Location",
    "EventPeriod",
    "LocationEventTime",
    "Signup",
    "Attendee",
];
// Calendar 2026-06-22 (applies to every version): bookings may link redacted stubs in place of
// an event the user cannot see.
const EVENT: &[&str] = &["Event", "BookedEvent"];
const EVENT_INSTANCE: &[&str] = &["EventInstance", "BookedEventInstance"];
const RESOURCE: &[&str] = &["Resource"];
const WORKFLOW: &[&str] = &["Workflow"];
const GROUP: &[&str] = &["Group"];
const PERSON: &[&str] = &["Person"];
const FORM: &[&str] = &["Form"];
const LOCATION: &[&str] = &["Location"];
/// An included Check-Ins EventTime's documented links: its event and the period it belongs to.
const EVENT_TIME_LINKS: &[(&str, &[&str])] =
    &[("event", &["Event"]), ("event_period", &["EventPeriod"])];
/// Included EventResourceRequest: approval status and what it links, nothing else.
const RESOURCE_REQUEST: Schema = &[("approval_status", true, Fact::Code)];
const RESOURCE_REQUEST_LINKS: &[(&str, &[&str])] = &[("event", EVENT), ("resource", RESOURCE)];
fn identity(v: &Value, types: &[&str]) -> Result<Value, SourceError> {
    let id = v
        .get("id")
        .and_then(Value::as_str)
        .ok_or(SourceError::InvalidResponse)?;
    let kind = v
        .get("type")
        .and_then(Value::as_str)
        .ok_or(SourceError::InvalidResponse)?;
    if !numeric_id(id) || !types.contains(&kind) {
        return Err(SourceError::InvalidResponse);
    }
    Ok(json!({"id":id,"type":kind}))
}
fn date(value: &str) -> bool {
    if value.len() != 10 || &value[4..5] != "-" || &value[7..8] != "-" {
        return false;
    }
    let y = value[..4].parse::<u32>().unwrap_or(0);
    let m = value[5..7].parse::<u32>().unwrap_or(0);
    let d = value[8..].parse::<u32>().unwrap_or(0);
    let max = match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if y.is_multiple_of(4) && (!y.is_multiple_of(100) || y.is_multiple_of(400)) {
                29
            } else {
                28
            }
        }
        _ => 0,
    };
    value
        .bytes()
        .enumerate()
        .all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit())
        && y > 0
        && d > 0
        && d <= max
}
pub(crate) fn instant(v: &Value) -> bool {
    let Some(s) = v.as_str() else {
        return false;
    };
    if !s.is_ascii() || !(20..=29).contains(&s.len()) || !date(&s[..10]) || &s[10..11] != "T" {
        return false;
    }
    if &s[13..14] != ":" || &s[16..17] != ":" {
        return false;
    }
    for (part, max) in [(&s[11..13], 23), (&s[14..16], 59), (&s[17..19], 59)] {
        if !part.bytes().all(|b| b.is_ascii_digit()) || part.parse::<u8>().unwrap_or(255) > max {
            return false;
        }
    }
    let tail = &s[19..];
    let zone = if let Some(fraction) = tail.strip_prefix('.') {
        let len = fraction.bytes().take_while(u8::is_ascii_digit).count();
        if !(1..=3).contains(&len) {
            return false;
        }
        &fraction[len..]
    } else {
        tail
    };
    zone == "Z"
        || (zone.len() == 6
            && b"+-".contains(&zone.as_bytes()[0])
            && &zone[3..4] == ":"
            && zone[1..3].parse::<u8>().is_ok_and(|n| n <= 23)
            && zone[4..].parse::<u8>().is_ok_and(|n| n <= 59))
}
/// Unix milliseconds of an `instant`, its offset applied. `None` for anything `instant` refuses
/// and for offsets whose components are not plain digits.
pub(crate) fn instant_ms(text: &str) -> Option<i64> {
    if !instant(&Value::String(text.into())) {
        return None;
    }
    let digits = |part: &str| -> Option<i64> {
        part.bytes()
            .all(|b| b.is_ascii_digit())
            .then(|| part.parse().ok())
            .flatten()
    };
    let (y, m, d) = (
        digits(&text[..4])?,
        digits(&text[5..7])?,
        digits(&text[8..10])?,
    );
    let (h, mi, s) = (
        digits(&text[11..13])?,
        digits(&text[14..16])?,
        digits(&text[17..19])?,
    );
    let (ms, zone) = match text[19..].strip_prefix('.') {
        Some(fraction) => {
            let len = fraction.bytes().take_while(u8::is_ascii_digit).count();
            let scale = 10_i64.pow(3 - len as u32);
            (digits(&fraction[..len])? * scale, &fraction[len..])
        }
        None => (0, &text[19..]),
    };
    let offset = match zone {
        "Z" => 0,
        _ => {
            let sign = if zone.starts_with('-') { -1 } else { 1 };
            sign * (digits(&zone[1..3])? * 60 + digits(&zone[4..])?) * 60_000
        }
    };
    // Days since 1970-01-01 (proleptic Gregorian).
    let (y, m) = if m <= 2 { (y - 1, m + 9) } else { (y, m - 3) };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + (153 * m + 2) / 5 + d - 1;
    let days = era * 146_097 + doe - 719_468;
    Some((((days * 24 + h) * 60 + mi) * 60 + s) * 1000 + ms - offset)
}
fn notification_instant(v: &Value) -> bool {
    // Integer parsing accepts a leading plus; notification offset components must be digits.
    instant(v)
        && v.as_str().is_some_and(|s| {
            s.ends_with('Z')
                || s[s.len() - 5..]
                    .bytes()
                    .enumerate()
                    .all(|(i, b)| i == 2 || b.is_ascii_digit())
        })
}
fn page_link(request: &SourceRequest, value: &Value) -> Result<Value, SourceError> {
    if value.is_null() {
        return Ok(Value::Null);
    }
    let text = value
        .as_str()
        .filter(|s| s.len() <= 512)
        .ok_or(SourceError::InvalidResponse)?;
    let url = url::Url::parse(text).map_err(|_| SourceError::InvalidResponse)?;
    if !request.collection.paginated()
        || url.origin().ascii_serialization() != ORIGIN
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(SourceError::InvalidResponse);
    }
    let query = text
        .strip_prefix(&format!("{ORIGIN}{}?", request.path()))
        .ok_or(SourceError::InvalidResponse)?;
    // Raw segments, not decoded pairs: percent-encoded keys/values and alternate spellings fail.
    // The one tolerated encoding is of `[ ] : ,` inside a fixed key or value (see `spelled`).
    let fixed = request.query();
    let mut seen = vec![false; fixed.len()];
    let mut page = None;
    let mut offset = None;
    for part in query.split('&') {
        let (key, value) = part.split_once('=').ok_or(SourceError::InvalidResponse)?;
        let number = || -> Result<u64, SourceError> {
            let n = value
                .parse::<u64>()
                .map_err(|_| SourceError::InvalidResponse)?;
            if value.is_empty()
                || !value.bytes().all(|b| b.is_ascii_digit())
                || n.to_string() != value
            {
                return Err(SourceError::InvalidResponse);
            }
            Ok(n)
        };
        match key {
            "per_page" if page.is_none() && number()? == u64::from(request.per_page) => {
                page = Some(())
            }
            "offset" if offset.is_none() => {
                let n = number()?;
                if n > MAX_OFFSET {
                    return Err(SourceError::InvalidResponse);
                }
                offset = Some(n);
            }
            _ => {
                let index = fixed
                    .iter()
                    .position(|(k, v)| spelled(key, k) && spelled(value, v))
                    .filter(|&i| !seen[i])
                    .ok_or(SourceError::InvalidResponse)?;
                seen[index] = true;
            }
        }
    }
    if page.is_none() || offset.is_none() || seen.contains(&false) {
        return Err(SourceError::InvalidResponse);
    }
    Ok(Value::String(text.into()))
}
/// True when `raw` spells `expected` exactly, except that each `[ ] : ,` may instead appear
/// percent-encoded (either hex case), as Rails writes them into next links. Encoding of any
/// other character, double encoding and alternate spellings all fail.
fn spelled(raw: &str, expected: &str) -> bool {
    let mut raw = raw.as_bytes();
    for &b in expected.as_bytes() {
        if raw.first() == Some(&b) {
            raw = &raw[1..];
        } else if b"[]:,".contains(&b)
            && raw.len() >= 3
            && raw[0] == b'%'
            && raw[1..3].eq_ignore_ascii_case(format!("{b:02X}").as_bytes())
        {
            raw = &raw[3..];
        } else {
            return false;
        }
    }
    raw.is_empty()
}
fn headers(input: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    input
        .iter()
        .filter_map(|(k, v)| {
            let key = k.to_ascii_lowercase();
            let good = v.is_ascii()
                && match key.as_str() {
                    "x-pco-api-version" => date(v),
                    "x-pco-api-request-rate-limit"
                    | "x-pco-api-request-rate-count"
                    | "retry-after" => {
                        !v.is_empty() && v.len() <= 9 && v.bytes().all(|b| b.is_ascii_digit())
                    }
                    "x-pco-api-request-rate-period" => {
                        v.strip_suffix(" seconds").is_some_and(|s| {
                            !s.is_empty() && s.len() <= 9 && s.bytes().all(|b| b.is_ascii_digit())
                        })
                    }
                    _ => false,
                };
            good.then(|| (key, v.clone()))
        })
        .collect()
}
#[derive(Clone, Copy)]
enum Fact {
    Count,
    Status,
    Instant,
    /// Null or an instant (due, snooze and lifecycle times that are often unset).
    MaybeInstant,
    /// Null or a calendar date, `YYYY-MM-DD` (a background check's `expires_on`).
    MaybeDate,
    /// Null or a count (a signup's `maximum_capacity`: null when it has no overall limit).
    MaybeCount,
    NotificationInstant,
    Flag,
    TimeType,
    /// Null or bounded display text (titles, position names).
    Text,
    /// Null or a free-text name that never stays in a body: `display_label` bounds it.
    Label,
    /// Short source status code whose values the provider does not enumerate.
    Code,
    /// Null or an IANA time zone name's shape (`UTC`, or `Area/Location[/...]`). Whether this
    /// Mac knows the zone is the webview's check.
    Zone,
    Repeat,
}
impl Fact {
    fn valid(self, v: &Value) -> bool {
        match self {
            Self::Count => nonnegative(v),
            Self::Status => v.as_str().is_some_and(|s| {
                ["C", "U", "D", "Confirmed", "Unconfirmed", "Declined"].contains(&s)
            }),
            Self::Instant => instant(v),
            Self::MaybeInstant => v.is_null() || instant(v),
            Self::MaybeDate => v.is_null() || v.as_str().is_some_and(date),
            Self::MaybeCount => v.is_null() || nonnegative(v),
            Self::NotificationInstant => v.is_null() || notification_instant(v),
            Self::Flag => v.is_boolean(),
            Self::TimeType => v
                .as_str()
                .is_some_and(|s| ["service", "rehearsal", "other"].contains(&s)),
            Self::Text => v.is_null() || v.as_str().is_some_and(|s| s.len() <= 512),
            Self::Label => v.is_null() || v.is_string(),
            Self::Code => v.as_str().is_some_and(|s| {
                (1..=32).contains(&s.len())
                    && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
            }),
            Self::Zone => v.is_null() || v.as_str().is_some_and(zone_name),
            Self::Repeat => {
                v.is_null()
                    || v.as_str().is_some_and(|s| {
                        s == "no_repeat"
                            || s.strip_prefix("every_").is_some_and(|n| {
                                (1..=2).contains(&n.len()) && n.bytes().all(|b| b.is_ascii_digit())
                            })
                    })
            }
        }
    }
}
/// `UTC`, or `Area/Location[/...]` in IANA's characters: what a time zone name can look like,
/// at most 64 bytes. Free text (a Rails-style "Eastern Time (US & Canada)") is refused.
pub(crate) fn zone_name(s: &str) -> bool {
    let mut parts = s.split('/');
    let area = parts.next().unwrap_or_default();
    let rest: Vec<&str> = parts.collect();
    s.len() <= 64
        && (s == "UTC"
            || (!area.is_empty()
                && area.bytes().all(|b| b.is_ascii_alphabetic() || b == b'_')
                && !rest.is_empty()
                && rest.iter().all(|part| {
                    !part.is_empty()
                        && part
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b"_+-".contains(&b))
                })))
}
/// (attribute, required, fact). Anything not listed is dropped.
type Schema = &'static [(&'static str, bool, Fact)];
const PLAN_TIME: Schema = &[
    ("starts_at", true, Fact::Instant),
    ("ends_at", true, Fact::Instant),
    ("time_type", false, Fact::TimeType),
];
const NOTIFICATIONS: [(&str, bool, Fact); 3] = [
    ("notification_sent_at", false, Fact::NotificationInstant),
    ("notification_prepared_at", false, Fact::NotificationInstant),
    ("prepare_notification", false, Fact::Flag),
];
impl SourceRequest {
    fn types(&self) -> &'static [&'static str] {
        match self.profile {
            Profile::Protocol => PROTOCOL_TYPES,
            Profile::Capture if self.collection.product() != Product::Services => OPERATIONS_TYPES,
            Profile::Capture => CAPTURE_TYPES,
        }
    }
    /// Types one kept relationship may link to. Services reads keep their original rule (any
    /// type of the read's profile); operations reads name the exact targets per key.
    fn relationship_types(&self, key: &str) -> &'static [&'static str] {
        match (self.collection, key) {
            (Collection::UpcomingPlans, _) => &["ServiceType"],
            (Collection::CalendarResourceBookings, "event") => EVENT,
            (Collection::CalendarResourceBookings, "event_instance") => EVENT_INSTANCE,
            (Collection::CalendarResourceBookings, "resource") => RESOURCE,
            (Collection::CalendarResourceBookings, "event_resource_request") => {
                &["EventResourceRequest"]
            }
            // Planning Center types the link `Assignee`; the include returned `Person` in staging.
            (Collection::PeopleWorkflowReadyCards | Collection::PeopleWorkflowSnoozedCards, k) => {
                match k {
                    "assignee" => &["Assignee", "Person"],
                    "current_step" => &["WorkflowStep"],
                    _ => WORKFLOW,
                }
            }
            // The resource both events requested, and the event that won it once resolved
            // (redacted to a `BookedEvent` stub when the user cannot see that event).
            (Collection::CalendarEventConflicts, "resource") => RESOURCE,
            (Collection::CalendarEventConflicts, _) => EVENT,
            (Collection::PeopleWorkflowSteps, _) => WORKFLOW,
            (Collection::GroupsPersonMemberships, "person") => PERSON,
            (Collection::PeopleBackgroundChecks, _) => PERSON,
            (Collection::PeopleFormSubmissions, "form") => FORM,
            (Collection::PeopleFormSubmissions, _) => PERSON,
            (Collection::CheckInsEventPeriods, _) => &["Event"],
            (Collection::CheckInsLocationCounts, "event_time") => &["EventTime"],
            (Collection::CheckInsLocationCounts, _) => LOCATION,
            (Collection::GroupsPersonMemberships | Collection::GroupsGroupEvents, _) => GROUP,
            _ => self.types(),
        }
    }
    fn attributes(&self) -> Schema {
        let capture = self.profile == Profile::Capture;
        match self.collection {
            Collection::NeededPositions if capture => &[
                ("quantity", true, Fact::Count),
                ("team_position_name", false, Fact::Text),
            ],
            Collection::NeededPositions => &[("quantity", true, Fact::Count)],
            Collection::TeamMembers if capture => &[
                ("status", true, Fact::Status),
                ("team_position_name", false, Fact::Text),
                NOTIFICATIONS[0],
                NOTIFICATIONS[1],
                NOTIFICATIONS[2],
            ],
            Collection::TeamMembers => &[
                ("status", true, Fact::Status),
                NOTIFICATIONS[0],
                NOTIFICATIONS[1],
                NOTIFICATIONS[2],
            ],
            Collection::PlanTimes => PLAN_TIME,
            Collection::Plan => &[
                ("dates", false, Fact::Text),
                ("sort_date", true, Fact::Instant),
                ("title", false, Fact::Text),
                ("series_title", false, Fact::Text),
            ],
            Collection::TeamPositionAssignments | Collection::TeamLeaders => &[],
            Collection::PersonSchedules | Collection::PersonSchedulesUnfiltered => &[
                ("status", true, Fact::Code),
                ("team_position_name", false, Fact::Text),
                ("sort_date", true, Fact::Instant),
            ],
            Collection::PersonBlockouts => &[
                ("starts_at", true, Fact::Instant),
                ("ends_at", true, Fact::Instant),
                ("repeat_frequency", false, Fact::Repeat),
            ],
            // Only the time zone: name, owner, CCLI, secret and every other setting are dropped.
            Collection::Organization => &[("time_zone", false, Fact::Zone)],
            // Room, workflow and step `name`s are validated here, then moved out of the body
            // into the page's local labels (`take_label`).
            Collection::CalendarRooms => {
                &[("kind", true, Fact::Code), ("name", false, Fact::Label)]
            }
            Collection::CalendarResourceBookings => &[
                ("starts_at", true, Fact::Instant),
                ("ends_at", true, Fact::Instant),
                ("quantity", false, Fact::Count),
            ],
            // Resolved state only: `note` (free text), timestamps and `resolved_by` are dropped.
            Collection::CalendarEventConflicts => &[("resolved_at", false, Fact::MaybeInstant)],
            Collection::PeopleWorkflows => &[("name", false, Fact::Label)],
            Collection::PeopleWorkflowSteps => &[
                ("name", false, Fact::Label),
                ("sequence", false, Fact::Count),
                ("expected_response_time_in_days", false, Fact::Count),
            ],
            Collection::PeopleWorkflowReadyCards | Collection::PeopleWorkflowSnoozedCards => &[
                ("stage", true, Fact::Code),
                ("calculated_due_at", false, Fact::MaybeInstant),
                ("overdue", false, Fact::Flag),
                ("snooze_until", false, Fact::MaybeInstant),
                ("completed_at", false, Fact::MaybeInstant),
                ("removed_at", false, Fact::MaybeInstant),
            ],
            Collection::GroupsPersonMemberships => &[("role", false, Fact::Code)],
            Collection::GroupsGroupEvents => &[
                ("starts_at", true, Fact::Instant),
                ("ends_at", true, Fact::Instant),
                ("canceled", false, Fact::Flag),
            ],
            // Whether a cleared check is current and when it expires. `note`, `report_url`,
            // `completed_at`, `status_updated_at` and `created_by` are dropped; `status` is kept
            // only to prove the filter held (`confirm`), so it is always `complete_clear`.
            Collection::PeopleBackgroundChecks => &[
                ("status", true, Fact::Code),
                ("current", false, Fact::Flag),
                ("expires_on", false, Fact::MaybeDate),
            ],
            // A service type's `name` becomes a local label; whether it is archived or deleted
            // decides if it is offered. Permissions, sequence and every other setting are dropped.
            Collection::ServiceTypes => &[
                ("name", false, Fact::Label),
                ("archived_at", false, Fact::MaybeInstant),
                ("deleted_at", false, Fact::MaybeInstant),
            ],
            // The plan facts the Sunday check's own plan read keeps; an undated plan isn't offered.
            Collection::UpcomingPlans => &[
                ("dates", false, Fact::Text),
                ("sort_date", false, Fact::MaybeInstant),
                ("title", false, Fact::Text),
                ("series_title", false, Fact::Text),
            ],
            // A form's `name` becomes a local label; `archived` proves the filter held. The
            // description, public link, counts and every setting are dropped.
            Collection::PeopleForms => &[
                ("name", false, Fact::Label),
                ("active", false, Fact::Flag),
                ("archived", false, Fact::Flag),
            ],
            // When it was submitted, nothing else: verification state, answers and selected
            // options are never kept (and never asked for).
            Collection::PeopleFormSubmissions => &[("created_at", true, Fact::Instant)],
            // An event's `name` becomes a local label; `archived_at` proves the filter held.
            Collection::CheckInsEvents => &[
                ("name", false, Fact::Label),
                ("archived_at", false, Fact::MaybeInstant),
            ],
            // A location's `name` becomes a local label; `kind` tells a room from a folder. Ages,
            // grades, gender, questions and ratios are dropped.
            Collection::CheckInsLocations => {
                &[("name", false, Fact::Label), ("kind", false, Fact::Code)]
            }
            // The period's own interval only: its note and totals are dropped.
            Collection::CheckInsEventPeriods => &[
                ("starts_at", true, Fact::Instant),
                ("ends_at", true, Fact::Instant),
            ],
            // The three counts Check-Ins keeps for one room at one event time.
            Collection::CheckInsLocationCounts => &[
                ("regular_count", true, Fact::Count),
                ("guest_count", true, Fact::Count),
                ("volunteer_count", true, Fact::Count),
            ],
            // A signup's `name` becomes a local label. When registration opens and closes, whether
            // it is closed, and its overall limit; the description, links and logo are dropped.
            Collection::RegistrationsSignups => &[
                ("name", false, Fact::Label),
                ("archived", false, Fact::Flag),
                ("closed", false, Fact::Flag),
                ("open_at", false, Fact::MaybeInstant),
                ("close_at", false, Fact::MaybeInstant),
                ("maximum_capacity", false, Fact::MaybeCount),
            ],
            // Only what proves the attendee counts as registered; never a name or a time.
            Collection::RegistrationsAttendees => &[
                ("active", true, Fact::Flag),
                ("canceled", false, Fact::Flag),
                ("waitlisted", false, Fact::Flag),
            ],
        }
    }
    fn relationships(&self) -> &'static [&'static str] {
        let capture = self.profile == Profile::Capture;
        match self.collection {
            Collection::NeededPositions if capture => &["team", "time"],
            Collection::NeededPositions => &["plan", "service_type", "team", "time"],
            Collection::TeamMembers if capture => &["person", "team", "times"],
            Collection::TeamMembers => &[
                "plan",
                "service_type",
                "team",
                "person",
                "times",
                "service_times",
                "declined_plan_times",
            ],
            Collection::PlanTimes if capture => &[],
            Collection::PlanTimes => &[
                "plan",
                "service_type",
                "assigned_teams",
                "assigned_positions",
            ],
            Collection::Plan | Collection::PersonBlockouts | Collection::Organization => &[],
            Collection::TeamPositionAssignments => &["person", "team_position"],
            // The include is `people`; PCO documents the to-one link as `person`. Keep either.
            Collection::TeamLeaders => &["people", "person", "team"],
            Collection::PersonSchedules | Collection::PersonSchedulesUnfiltered => {
                &["plan", "team", "times"]
            }
            Collection::CalendarRooms | Collection::PeopleWorkflows => &[],
            // `event_resource_request` is not a documented booking link; kept only if present.
            Collection::CalendarResourceBookings => &[
                "event",
                "event_instance",
                "resource",
                "event_resource_request",
            ],
            // `resolved_by` (a Person) is not needed and is dropped.
            Collection::CalendarEventConflicts => &["resource", "winner"],
            Collection::PeopleWorkflowSteps => &["workflow"],
            // The card's own person is not needed and is dropped; the assignee keeps its id only.
            Collection::PeopleWorkflowReadyCards | Collection::PeopleWorkflowSnoozedCards => {
                &["assignee", "current_step", "workflow"]
            }
            Collection::GroupsPersonMemberships => &["group", "person"],
            Collection::GroupsGroupEvents => &["group"],
            // Who the check is for; `created_by` (whoever entered it) is dropped.
            Collection::PeopleBackgroundChecks => &["person"],
            Collection::ServiceTypes => &[],
            // Kept only to confirm each plan is the requested service type's.
            Collection::UpcomingPlans => &["service_type"],
            Collection::PeopleForms | Collection::CheckInsEvents => &[],
            Collection::RegistrationsSignups => &[],
            // The form (to confirm it) and who submitted; the answers' links are dropped.
            Collection::PeopleFormSubmissions => &["form", "person"],
            // Planning Center renders only a room's `parent` (its folder), which isn't needed: the
            // room's event is the one the request named, confirmed by `meta.parent` when present.
            Collection::CheckInsLocations => &[],
            // A period renders its `event`; its times are placed by their own `event_period`.
            Collection::CheckInsEventPeriods => &["event"],
            // The count's room is the included link. Its event time is the one the request named;
            // a rendered `event_time` link is kept so it can be checked against it.
            Collection::CheckInsLocationCounts => &["location", "event_time"],
            // An attendee's person, registration, emergency contact and option are all dropped.
            Collection::RegistrationsAttendees => &[],
        }
    }
    /// Included resource types this read asked for. Protocol reads never keep `included`.
    fn included(&self) -> &'static [&'static str] {
        if self.profile != Profile::Capture {
            return &[];
        }
        match self.collection {
            Collection::TeamMembers | Collection::TeamLeaders => &["Person"],
            Collection::TeamPositionAssignments => &["Person", "TeamPosition"],
            Collection::PersonSchedules | Collection::PersonSchedulesUnfiltered => &["PlanTime"],
            Collection::CalendarResourceBookings => &["EventResourceRequest"],
            Collection::CheckInsEventPeriods => &["EventTime"],
            Collection::PeopleFormSubmissions => &["Person"],
            _ => &[],
        }
    }
}
fn select(schema: Schema, attrs: Option<&Map<String, Value>>) -> Result<Value, SourceError> {
    let mut selected = Map::new();
    for &(key, required, fact) in schema {
        match attrs.and_then(|a| a.get(key)) {
            Some(v) if fact.valid(v) => {
                selected.insert(key.into(), v.clone());
            }
            Some(_) => return Err(SourceError::InvalidResponse),
            None if required => return Err(SourceError::InvalidResponse),
            None => {}
        }
    }
    Ok(Value::Object(selected))
}
/// Moves a labelled read's `name` out of the projected row into `labels`, in display form.
/// The same id named two different ways on one page is a contradiction and rejects it.
fn take_label(
    request: &SourceRequest,
    row: &mut Value,
    labels: &mut BTreeMap<String, String>,
) -> Result<(), SourceError> {
    let Some(prefix) = request.collection.label_prefix() else {
        return Ok(());
    };
    let name = row["attributes"]
        .as_object_mut()
        .and_then(|attributes| attributes.remove("name"));
    let Some(Value::String(name)) = name else {
        return Ok(());
    };
    let label = display_label(&name);
    if label.is_empty() {
        return Ok(());
    }
    let key = format!("{prefix}:{}", row["id"].as_str().unwrap_or_default());
    if labels.get(&key).is_some_and(|known| *known != label) {
        return Err(SourceError::InvalidResponse);
    }
    labels.insert(key, label);
    Ok(())
}
/// What a parent, filter or window promised, checked on every projected row: Planning Center
/// may ignore a filter it does not apply, and `meta.parent` may be absent. A row without a link
/// to exactly the requested workflow, group or person, of another stage, a resource that is
/// not a room, a windowed row that does not overlap the window, or a conflict without its
/// resource rejects the page.
fn confirm(request: &SourceRequest, row: &Value) -> Result<(), SourceError> {
    let parent = |key: &str, id: &Option<String>| {
        let link = &row["relationships"][key]["data"];
        id.is_some() && link.is_object() && link["id"].as_str() == id.as_deref()
    };
    let attribute = |key: &str| row["attributes"][key].as_str();
    let inside = || {
        let at = |text: Option<&str>| text.and_then(instant_ms);
        match (
            request.window.as_ref(),
            at(attribute("starts_at")),
            at(attribute("ends_at")),
        ) {
            (Some(window), Some(starts), Some(ends)) => {
                at(Some(&window.starts_at)).is_some_and(|from| ends > from)
                    && at(Some(&window.ends_at)).is_some_and(|until| starts < until)
            }
            _ => false,
        }
    };
    let flag = |key: &str| row["attributes"][key].as_bool();
    // Inside the recent window `[starts_at, ends_at)`, by the row's own creation time.
    let created_inside = || {
        let at = |text: Option<&str>| text.and_then(instant_ms);
        match (request.window.as_ref(), at(attribute("created_at"))) {
            (Some(window), Some(created)) => {
                at(Some(&window.starts_at)).is_some_and(|from| created >= from)
                    && at(Some(&window.ends_at)).is_some_and(|until| created < until)
            }
            _ => false,
        }
    };
    let kept = match request.collection {
        // This organization's own settings, never another's.
        Collection::Organization => row["id"].as_str() == Some(request.organization.as_str()),
        Collection::CalendarRooms => attribute("kind") == Some("Room"),
        Collection::CalendarResourceBookings => inside(),
        // A conflict names no event of its own (only the requested parent's meta and the
        // winner), so its resource link is what ties it to a booking: it must be there.
        Collection::CalendarEventConflicts => row["relationships"]["resource"]["data"].is_object(),
        Collection::PeopleWorkflowSteps => parent("workflow", &request.workflow_id),
        Collection::PeopleWorkflowReadyCards => {
            parent("workflow", &request.workflow_id) && attribute("stage") == Some("ready")
        }
        Collection::PeopleWorkflowSnoozedCards => {
            parent("workflow", &request.workflow_id) && attribute("stage") == Some("snoozed")
        }
        Collection::GroupsPersonMemberships => parent("person", &request.groups_person_id),
        Collection::GroupsGroupEvents => parent("group", &request.group_id) && inside(),
        // Exactly the requested person, and only a cleared check: Planning Center ignoring the
        // filter would otherwise hand this Mac a check's other outcome. A check the church entered
        // by hand comes back `manual_clear` for the `complete_clear` filter (seen live 2026-11-14;
        // not in Planning Center's documented status list), so both cleared statuses count.
        Collection::PeopleBackgroundChecks => {
            parent("person", &request.people_person_id)
                && matches!(attribute("status"), Some("complete_clear" | "manual_clear"))
        }
        // A plan of another service type isn't one the person can choose here.
        Collection::UpcomingPlans => parent("service_type", &Some(request.service_type_id.clone())),
        // An archived form, event or signup is never read as current: a filter Planning Center
        // ignored would otherwise hand this Mac one.
        Collection::PeopleForms | Collection::RegistrationsSignups => {
            flag("archived") != Some(true)
        }
        Collection::CheckInsEvents => row["attributes"]["archived_at"].is_null(),
        // Exactly the chosen form, and only submissions created inside the window.
        Collection::PeopleFormSubmissions => parent("form", &request.form_id) && created_inside(),
        Collection::CheckInsEventPeriods => parent("event", &request.checkins_event_id) && inside(),
        // A count that doesn't name its room can't be placed: the page is refused, never guessed.
        // One whose own `event_time` link names another time than the request is refused too.
        Collection::CheckInsLocationCounts => {
            let time = &row["relationships"]["event_time"]["data"];
            row["relationships"]["location"]["data"].is_object()
                && (time.is_null()
                    || time["id"].as_str() == request.checkins_event_time_id.as_deref())
        }
        // Only an active attendee is counted as registered: a filter Planning Center ignored
        // would otherwise count a canceled or waitlisted one.
        Collection::RegistrationsAttendees => {
            flag("active") == Some(true)
                && flag("canceled") != Some(true)
                && flag("waitlisted") != Some(true)
        }
        _ => true,
    };
    if kept {
        Ok(())
    } else {
        Err(SourceError::InvalidResponse)
    }
}
fn project_row(
    request: &SourceRequest,
    row: &Value,
    labels: &mut BTreeMap<String, String>,
) -> Result<Value, SourceError> {
    let mut result = project_fields(request, row)?;
    confirm(request, &result)?;
    take_label(request, &mut result, labels)?;
    Ok(result)
}
fn project_fields(request: &SourceRequest, row: &Value) -> Result<Value, SourceError> {
    let mut result = identity(row, request.types())?;
    if result["type"] != request.collection.resource() {
        return Err(SourceError::InvalidResponse);
    }
    let schema = request.attributes();
    let attrs = match row.get("attributes") {
        Some(a) => Some(a.as_object().ok_or(SourceError::InvalidResponse)?),
        // Protocol rows always required attributes; capture rows only when facts are kept.
        None if request.profile == Profile::Protocol || !schema.is_empty() => {
            return Err(SourceError::InvalidResponse);
        }
        None => None,
    };
    result["attributes"] = select(schema, attrs)?;
    let keys = request.relationships();
    if let Some(rels) = row.get("relationships") {
        let rels = rels.as_object().ok_or(SourceError::InvalidResponse)?;
        let output = project_links(
            rels,
            keys.iter()
                .map(|&key| (key, request.relationship_types(key))),
        )?;
        if request.profile == Profile::Protocol || !keys.is_empty() {
            result["relationships"] = Value::Object(output);
        }
    }
    Ok(result)
}
/// Kept relationship keys only, each as bare identities of a type that key may link to.
fn project_links<'a>(
    rels: &Map<String, Value>,
    keys: impl IntoIterator<Item = (&'a str, &'static [&'static str])>,
) -> Result<Map<String, Value>, SourceError> {
    let mut output = Map::new();
    for (key, types) in keys {
        if let Some(rel) = rels.get(key) {
            let value = rel
                .as_object()
                .and_then(|r| r.get("data"))
                .ok_or(SourceError::InvalidResponse)?;
            let value = if value.is_null() {
                Value::Null
            } else if let Some(array) = value.as_array() {
                if array.len() > 100 {
                    return Err(SourceError::Oversized);
                }
                Value::Array(
                    array
                        .iter()
                        .map(|v| identity(v, types))
                        .collect::<Result<Vec<_>, _>>()?,
                )
            } else {
                identity(value, types)?
            };
            output.insert(key.into(), json!({"data":value}));
        }
    }
    Ok(output)
}
/// Included rows keep identity plus one closed fact set; links are dropped, and relationships
/// too except a request's event and resource (how a booking's approval is joined).
fn project_included(
    request: &SourceRequest,
    row: &Value,
    kind: &str,
) -> Result<Value, SourceError> {
    let mut result = identity(row, &[kind])?;
    let attrs = row
        .get("attributes")
        .and_then(Value::as_object)
        .ok_or(SourceError::InvalidResponse)?;
    if kind == "EventResourceRequest" {
        result["attributes"] = select(RESOURCE_REQUEST, Some(attrs))?;
        if let Some(rels) = row.get("relationships") {
            let rels = rels.as_object().ok_or(SourceError::InvalidResponse)?;
            result["relationships"] =
                Value::Object(project_links(rels, RESOURCE_REQUEST_LINKS.iter().copied())?);
        }
        return Ok(result);
    }
    if kind == "EventTime" {
        // When the time starts, and the event and period it belongs to; its name and totals are
        // dropped. A time of another event than the one requested refuses the page.
        result["attributes"] = select(&[("starts_at", true, Fact::Instant)], Some(attrs))?;
        if let Some(rels) = row.get("relationships") {
            let rels = rels.as_object().ok_or(SourceError::InvalidResponse)?;
            let links = project_links(rels, EVENT_TIME_LINKS.iter().copied())?;
            if let Some(event) = links.get("event")
                && event["data"]["id"].as_str() != request.checkins_event_id.as_deref()
            {
                return Err(SourceError::InvalidResponse);
            }
            result["relationships"] = Value::Object(links);
        }
        return Ok(result);
    }
    result["attributes"] = match kind {
        // A form submission's person can be a child (a form that allows submitting for household
        // members): a name is kept only for someone Planning Center says, exactly, isn't a child.
        // A child's name, or the name of someone it doesn't say, is never kept.
        // `child: false` is kept as the proof the check stores beside every linked person.
        "Person" if request.collection == Collection::PeopleFormSubmissions => {
            match (
                attrs.get("child"),
                attrs.get("name").and_then(Value::as_str),
            ) {
                (Some(Value::Bool(false)), Some(name)) if name.len() <= 256 => {
                    json!({"child":false,"name":name})
                }
                (Some(Value::Bool(false)), None) => json!({"child":false}),
                _ => json!({}),
            }
        }
        // Services names a person `full_name`. Only the display name survives, as `name`.
        "Person" => {
            let name = attrs
                .get("full_name")
                .or_else(|| attrs.get("name"))
                .and_then(Value::as_str)
                .filter(|s| s.len() <= 256)
                .ok_or(SourceError::InvalidResponse)?;
            json!({"name":name})
        }
        "TeamPosition" => {
            let name = attrs
                .get("name")
                .and_then(Value::as_str)
                .filter(|s| s.len() <= 256)
                .ok_or(SourceError::InvalidResponse)?;
            json!({"name":name})
        }
        _ => select(PLAN_TIME, Some(attrs))?,
    };
    Ok(result)
}
/// Minimize without repairing counts, absent fields, duplicates or conflicting linkage.
/// Invalid shapes reject the page; no discarded row can turn it into a complete empty result.
pub fn project_page(
    request: &SourceRequest,
    bytes: &[u8],
    response_headers: &BTreeMap<String, String>,
) -> Result<SourcePage, SourceError> {
    request.validate()?;
    if bytes.len() > MAX_OUTPUT {
        return Err(SourceError::Oversized);
    }
    let raw = serde_json::from_slice::<UniqueJson>(bytes)
        .map_err(|_| SourceError::InvalidResponse)?
        .0;
    if !raw.is_object() || raw.get("errors").is_some() {
        return Err(SourceError::InvalidResponse);
    }
    let mut labels = BTreeMap::new();
    let data = match raw.get("data") {
        Some(row) if !request.collection.paginated() && row.is_object() => {
            project_row(request, row, &mut labels)?
        }
        Some(Value::Array(rows)) if request.collection.paginated() => {
            if rows.len() > 100 {
                return Err(SourceError::Oversized);
            }
            Value::Array(
                rows.iter()
                    .map(|row| project_row(request, row, &mut labels))
                    .collect::<Result<Vec<_>, _>>()?,
            )
        }
        _ => return Err(SourceError::InvalidResponse),
    };
    let mut body = json!({"data":data});
    let wanted = request.included();
    if !wanted.is_empty()
        && let Some(included) = raw.get("included")
    {
        let rows = included.as_array().ok_or(SourceError::InvalidResponse)?;
        if rows.len() > 500 {
            return Err(SourceError::Oversized);
        }
        let mut seen = std::collections::BTreeSet::new();
        let mut output = Vec::new();
        for row in rows {
            let kind = row
                .get("type")
                .and_then(Value::as_str)
                .ok_or(SourceError::InvalidResponse)?;
            // Unrequested resource types are dropped unread, never interpreted.
            let Some(kind) = wanted.iter().find(|&&k| k == kind) else {
                continue;
            };
            let projected = project_included(request, row, kind)?;
            if !seen.insert((projected["type"].to_string(), projected["id"].to_string())) {
                return Err(SourceError::InvalidResponse);
            }
            output.push(projected);
        }
        body["included"] = Value::Array(output);
    }
    if let Some(meta) = raw.get("meta") {
        let meta = meta.as_object().ok_or(SourceError::InvalidResponse)?;
        let mut output = Map::new();
        for key in ["count", "total_count"] {
            if let Some(v) = meta.get(key) {
                if !nonnegative(v) {
                    return Err(SourceError::InvalidResponse);
                }
                output.insert(key.into(), v.clone());
            }
        }
        // Reader does not interpret parent/offset hints. Reject contradictions instead of hiding them.
        let (kind, id) = request.parent();
        if let Some(parent) = meta.get("parent")
            && (parent.get("type") != Some(&json!(kind)) || parent.get("id") != Some(&json!(id)))
        {
            return Err(SourceError::InvalidResponse);
        }
        if let Some(next) = meta.get("next")
            && !next.is_null()
        {
            let offset = next
                .get("offset")
                .or_else(|| next.is_number().then_some(next))
                .and_then(Value::as_u64)
                .ok_or(SourceError::InvalidResponse)?;
            let link = raw
                .get("links")
                .and_then(|l| l.get("next"))
                .ok_or(SourceError::InvalidResponse)?;
            let link = page_link(request, link)?;
            if link
                .as_str()
                .and_then(|s| url::Url::parse(s).ok())
                .and_then(|u| {
                    u.query_pairs()
                        .find(|(k, _)| k == "offset")
                        .map(|(_, v)| v.into_owned())
                })
                != Some(offset.to_string())
            {
                return Err(SourceError::InvalidResponse);
            }
        }
        body["meta"] = Value::Object(output);
    }
    if let Some(links) = raw.get("links") {
        let links = links.as_object().ok_or(SourceError::InvalidResponse)?;
        let mut output = Map::new();
        if let Some(next) = links.get("next") {
            output.insert("next".into(), page_link(request, next)?);
        }
        body["links"] = Value::Object(output);
    }
    let page = SourcePage {
        headers: headers(response_headers),
        body,
        labels,
    };
    if serde_json::to_vec(&page.envelope())
        .map_err(|_| SourceError::InvalidResponse)?
        .len()
        + 1
        > MAX_OUTPUT
    {
        return Err(SourceError::Oversized);
    }
    Ok(page)
}

// Crate-private injection at the network boundary: no public bearer callback exists.
pub(crate) trait SourceHttp {
    fn read(&self, request: &SourceRequest, access: &str) -> Result<SourcePage, SourceError>;
}
pub(crate) struct NativeSourceHttp(reqwest::blocking::Client);
impl NativeSourceHttp {
    pub(crate) fn new() -> Result<Self, SourceError> {
        Ok(Self(
            reqwest::blocking::Client::builder()
                .https_only(true)
                .no_proxy()
                .retry(reqwest::retry::never())
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(2))
                .timeout(Duration::from_secs(5))
                .user_agent("Ozzie (https://ozzie.church)")
                .build()
                .map_err(|_| SourceError::ProviderFailure)?,
        ))
    }
}
/// Closed status vocabulary. The stdin protocol keeps its original denied/provider-failure
/// pair, so its envelope never changes; only in-process capture reads see 429 and 400/422,
/// and only `groups_person_memberships` (capture-only) sees 404 as `NotFound`.
pub(crate) fn status_error(
    request: &SourceRequest,
    status: u16,
    retry_after: Option<&str>,
) -> Option<SourceError> {
    let capture = request.profile == Profile::Capture;
    match status {
        200 => None,
        401 | 403 => Some(SourceError::Denied),
        429 if capture => Some(SourceError::RateLimited(retry_after.and_then(|v| {
            (!v.is_empty() && v.len() <= 5 && v.bytes().all(|b| b.is_ascii_digit()))
                .then(|| v.parse().ok())
                .flatten()
        }))),
        400 | 422 if capture => Some(SourceError::Rejected),
        // Live, 2026-11-13: Groups answers 404 for a Services person with no Groups profile.
        404 if capture && request.collection == Collection::GroupsPersonMemberships => {
            Some(SourceError::NotFound)
        }
        _ => Some(SourceError::ProviderFailure),
    }
}
impl NativeSourceHttp {
    /// The one request shape this client can send: a GET of the validated, allowlisted URL with
    /// the product's pinned version. OAuth product scopes permit writes in Planning Center; this
    /// is where Ozzie's read-only rule is enforced, so no other method is ever built here.
    pub(crate) fn build(
        &self,
        request: &SourceRequest,
        access: &str,
    ) -> Result<reqwest::blocking::Request, SourceError> {
        request.validate()?;
        self.0
            .get(request.url())
            .bearer_auth(access)
            .header("Accept", "application/json")
            .header("X-PCO-API-Version", request.collection.product().version())
            .build()
            .map_err(|_| SourceError::InvalidRequest)
    }
}
impl SourceHttp for NativeSourceHttp {
    fn read(&self, request: &SourceRequest, access: &str) -> Result<SourcePage, SourceError> {
        let built = self.build(request, access)?;
        let response = self
            .0
            .execute(built)
            .map_err(|_| SourceError::ProviderFailure)?;
        let retry_after = response
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok());
        if let Some(error) = status_error(request, response.status().as_u16(), retry_after) {
            return Err(error);
        }
        let response_headers = response
            .headers()
            .iter()
            .filter_map(|(k, v)| {
                v.to_str()
                    .ok()
                    .map(|v| (k.as_str().to_owned(), v.to_owned()))
            })
            .collect();
        let mut bytes = Zeroizing::new(Vec::new());
        response
            .take((MAX_OUTPUT + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| SourceError::ProviderFailure)?;
        let page = project_page(request, &bytes, &response_headers);
        #[cfg(debug_assertions)]
        if page.is_err() && std::env::var("OZZIE_DEV_SHAPES").as_deref() == Ok("1") {
            debug_shape(request, &bytes);
        }
        page
    }
}

/// Debug builds only, with OZZIE_DEV_SHAPES=1: when Ozzie refuses a page, print its structure to the developer's
/// terminal — keys, value kinds, digits as 9 and string lengths, never a value (only `type` and `status` codes).
#[cfg(debug_assertions)]
fn debug_shape(request: &SourceRequest, bytes: &[u8]) {
    fn shape(key: &str, v: &Value) -> Value {
        match v {
            Value::Object(m) => {
                Value::Object(m.iter().map(|(k, v)| (k.clone(), shape(k, v))).collect())
            }
            Value::Array(a) => Value::Array(a.iter().take(3).map(|v| shape(key, v)).collect()),
            Value::String(text) if key == "type" || key == "status" => Value::String(
                text.chars()
                    .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
                    .take(40)
                    .collect(),
            ),
            Value::String(text)
                if text
                    .chars()
                    .all(|c| c.is_ascii_digit() || "-:.TZ+".contains(c)) =>
            {
                Value::String(
                    text.chars()
                        .map(|c| if c.is_ascii_digit() { '9' } else { c })
                        .collect(),
                )
            }
            Value::String(text) => Value::String(format!("<text {}>", text.chars().count())),
            Value::Number(_) => Value::String("<number>".into()),
            other => other.clone(),
        }
    }
    let outline = serde_json::from_slice::<Value>(bytes).map(|v| shape("", &v).to_string());
    eprintln!(
        "dev-shape: {} {}",
        request.collection.label(),
        outline
            .unwrap_or_else(|_| "<not json>".into())
            .chars()
            .take(3000)
            .collect::<String>()
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        credentials::{CredentialStore, StoreError},
        oauth::{AuthController, AuthError, Provider, Tokens},
    };
    use std::sync::{Arc, Mutex, atomic::AtomicBool};
    const REQUEST: &str = r#"{"version":1,"workspace":"fictional-workspace","organization":"1001","client_id":"fictional-client","service_type_id":"10","plan_id":"20","collection":"needed_positions","per_page":100,"offset":0}"#;
    struct Store(Mutex<Option<Vec<u8>>>);
    impl CredentialStore for Store {
        fn put(&self, _: &str, _: &str, value: &[u8]) -> Result<(), StoreError> {
            *self.0.lock().unwrap() = Some(value.into());
            Ok(())
        }
        fn get(&self, _: &str, _: &str) -> Result<Option<Vec<u8>>, StoreError> {
            Ok(self.0.lock().unwrap().clone())
        }
        fn delete(&self, _: &str, _: &str) -> Result<(), StoreError> {
            panic!("source read must not delete")
        }
    }
    struct IdentityProvider;
    impl Provider for IdentityProvider {
        fn organization(&self, access: &str) -> Result<String, AuthError> {
            assert_eq!(access, "fictional-native-secret-canary");
            Ok("1001".into())
        }
        fn exchange(&self, _: &str, _: &str, _: &str) -> Result<Tokens, AuthError> {
            panic!("no acquisition")
        }
        fn refresh(&self, _: &str, _: &str) -> Result<Tokens, AuthError> {
            panic!("no refresh")
        }
        fn revoke(&self, _: &str, _: &str, _: &str) -> Result<(), AuthError> {
            panic!("no revoke")
        }
    }
    struct FakeHttp;
    impl SourceHttp for FakeHttp {
        fn read(&self, request: &SourceRequest, access: &str) -> Result<SourcePage, SourceError> {
            assert_eq!(access, "fictional-native-secret-canary");
            project_page(request,br#"{"data":[{"id":"30","type":"NeededPosition","attributes":{"quantity":2,"name":"Fictional Name Canary","notes":"care-canary"}}],"meta":{"count":1,"total_count":1}}"#,&Default::default())
        }
    }
    fn controller() -> AuthController {
        AuthController::new(parse_request(REQUEST.as_bytes()).unwrap().binding(),Arc::new(Store(Mutex::new(Some(br#"{"client_id":"fictional-client","organization":"1001","tokens":{"access_token":"fictional-native-secret-canary","refresh_token":null,"token_type":"bearer","expires_in":7200}}"#.to_vec())))),Arc::new(IdentityProvider),Arc::new(||0)).unwrap()
    }
    struct EndingHttp<'a> {
        auth: &'a AuthController,
        error: Option<SourceError>,
    }
    impl SourceHttp for EndingHttp<'_> {
        fn read(&self, request: &SourceRequest, _: &str) -> Result<SourcePage, SourceError> {
            self.auth.cancel();
            if let Some(error) = self.error {
                Err(error)
            } else {
                project_page(
                    request,
                    br#"{"data":[],"meta":{"count":0,"total_count":0}}"#,
                    &Default::default(),
                )
            }
        }
    }
    #[test]
    fn epoch_cancellation_during_source_read_wins_over_late_success_and_failure() {
        let request = parse_request(REQUEST.as_bytes()).unwrap();
        for error in [
            None,
            Some(SourceError::ProviderFailure),
            Some(SourceError::Denied),
        ] {
            let auth = controller();
            let http = EndingHttp { auth: &auth, error };
            assert_eq!(
                auth.read_source_using(&request, &AtomicBool::new(false), &http)
                    .err(),
                Some(SourceError::Cancelled)
            );
        }
    }
    struct FailureHttp(SourceError);
    impl SourceHttp for FailureHttp {
        fn read(&self, _: &SourceRequest, _: &str) -> Result<SourcePage, SourceError> {
            Err(self.0)
        }
    }
    #[test]
    fn verified_credential_source_denial_and_provider_failure_keep_sanitized_outcomes() {
        let request = parse_request(REQUEST.as_bytes()).unwrap();
        for error in [
            SourceError::Denied,
            SourceError::ProviderFailure,
            SourceError::InvalidResponse,
            SourceError::Oversized,
        ] {
            let auth = controller();
            assert_eq!(
                auth.read_source_using(&request, &AtomicBool::new(false), &FailureHttp(error))
                    .err(),
                Some(error)
            );
        }
    }

    #[test]
    fn native_read_verifies_stored_binding_and_identity_then_returns_only_minimized_data() {
        let auth = controller();
        let request = parse_request(REQUEST.as_bytes()).unwrap();
        let page = auth
            .read_source_using(&request, &AtomicBool::new(false), &FakeHttp)
            .unwrap();
        assert_eq!(
            page.envelope()["body"]["data"][0]["attributes"],
            json!({"quantity":2})
        );
        let wire = page.envelope().to_string();
        for s in [
            "fictional-native-secret-canary",
            "Fictional Name Canary",
            "care-canary",
        ] {
            assert!(!wire.contains(s));
        }
        let mut wrong = request.clone();
        wrong.client_id = "other-client".into();
        assert_eq!(
            auth.read_source_using(&wrong, &AtomicBool::new(false), &FakeHttp)
                .err(),
            Some(SourceError::BindingMismatch)
        );
        auth.cancel();
        assert_eq!(
            auth.read_source_using(&request, &AtomicBool::new(false), &FakeHttp)
                .err(),
            Some(SourceError::Cancelled)
        );
        assert_eq!(
            controller()
                .read_source_using(&request, &AtomicBool::new(true), &FakeHttp)
                .err(),
            Some(SourceError::Cancelled)
        );
    }
}

#[cfg(test)]
#[path = "source_capture_tests.rs"]
mod capture_tests;

#[cfg(test)]
#[path = "source_operations_tests.rs"]
mod operations_tests;
