# Sunday capture contract (v1)

Status: build contract, 2026-11-13 (Claude Code lane). Defines the one object
that crosses from native Rust to the desktop webview for a Sunday readiness
check, and the identical object saved as the cached fallback recording.

## Flow

```
Tauri command check_sunday(binding, service_type_id, plan_id)
  -> AuthController::read_source (OAuth, org verification, GET-only allowlist)
  -> SundayCapture (this contract)          -> saved locally as a recording
  -> webview: capture -> CoverageInput -> evaluateCoverage -> Sunday view
```

The cached fallback is the same `SundayCapture` loaded from disk with
`kind: "recording"`. The UI must label it with its original capture time; it is
never presented as a current check.

## Allowlisted reads (Services 2018-11-01, all GET)

Verified against PCO's published OpenAPI for 2018-11-01 on 2026-11-13.

| collection | path | fixed query |
|---|---|---|
| `plan` | `/services/v2/service_types/{st}/plans/{plan}` | none |
| `plan_times` | `.../plans/{plan}/plan_times` | `per_page, offset` |
| `needed_positions` | `.../plans/{plan}/needed_positions` | `per_page, offset` |
| `team_members` | `.../plans/{plan}/team_members` | `include=person`, `per_page, offset` |
| `team_position_assignments` | `/services/v2/teams/{team}/person_team_position_assignments` | `include=person,team_position`, `per_page, offset` |
| `team_leaders` | `/services/v2/teams/{team}/team_leaders` | `include=people`, `per_page, offset` |
| `person_schedules` | `/services/v2/people/{person}/schedules` | `filter=all` (fallback: none), `include=plan_times`, `per_page, offset` |
| `person_blockouts` | `/services/v2/people/{person}/blockouts` | `per_page, offset` |
| `organization` | `/services/v2` (the Services Organization, one object) | none |

The `organization` read (added 2026-11-13, review fixes) comes last among the Services reads and
is made whatever the connection's consent: it is the church's own time zone, the only source of
its local Sunday (see "Church time zone" below).

People read for schedules/blockouts = Person ids from `team_members` (scheduled
on this plan, first) plus `team_position_assignments` (candidates), deduplicated.

Bounds: at most 10 teams, 40 people, 3 pages per collection instance. Any bound
hit marks that read `truncated` (never silently complete).

## Minimized attributes kept

- Plan: `dates`, `sort_date`, `title`, `series_title`. `sort_date` is the church's **local
  wall-clock time with a misleading `Z`** (verified live 2026-11-13: plan 92902197, a 9:30 AM
  Eastern service, returned `"sort_date":"2026-11-22T09:30:00Z"`). Its date part is the
  church-local Sunday and its time is local; it is never read as a UTC instant.
- Organization: `time_zone` only, and only when it has an IANA name's shape (`UTC`, or
  `Area/Location[/...]`, at most 64 bytes); the row's id must be the capture's organization.
  Anything else (a Rails-style "Eastern Time (US & Canada)", another organization) refuses the
  page (`invalid-response`). Name, owner, CCLI, secret and every other setting are dropped.
- PlanTime: `starts_at`, `ends_at`, `time_type`
- NeededPosition: `quantity`, `team_position_name`; rels `team`, `time`
- PlanPerson: `status`, `team_position_name`, `notification_sent_at`,
  `notification_prepared_at`, `prepare_notification`; rels `person`, `team`, `times`
- PersonTeamPositionAssignment: (none); rels `person`, `team_position`
- TeamLeader: (none); rels `people`, `team`
- Schedule: `status`, `team_position_name`, `sort_date`; rels `plan`, `team`, `times`
- Blockout: `starts_at`, `ends_at`, `repeat_frequency`
- Included TeamPosition: `name`; Team: `name`; PlanTime as above
- Included Person: `name` **only**, and only into `names` (below)

Never kept: emails, notes, decline reasons, photos, contact details, sender
names, free-text descriptions, tokens, raw headers other than rate/version.

## Shape

```ts
interface SundayCapture {
  version: 1;
  kind: "live" | "recording";
  organization: string; service_type_id: string; plan_id: string;
  started_at: string; completed_at: string;           // ISO, explicit offset
  reads: SundayRead[];
  names: Record<string, string>;                      // Person id -> display name. LOCAL ONLY.
  labels?: Record<string, string>;                    // v2: room/workflow/step display names. LOCAL ONLY.
}
interface SundayRead {
  collection: string; team_id?: string; person_id?: string; offset: number;
  checked_at: string;                                 // when this page was read
  outcome: "ok" | "truncated" | string;               // otherwise a SourceError code
  body?: { data: unknown[] | unknown; included?: unknown[]; meta?: { count?: number; total_count?: number } };
}
```

## Privacy rule (never-list)

`names` is display-only. Any function that builds model input takes a type that
has no `names` field and only placeholder labels (`Volunteer A`). Restoration
of names happens in the webview after the model returns. A test asserts no
`names` value appears in any model request body.

`names` keeps only the people a capture is about, but a check reads more (team
leaders on no position, candidates past the 40-person bound). The native name
guard must know those too, so `check_sunday` also returns every Person name it
read as a separate in-memory `ReadNames` list, which the app adds to its
session name guard. It is never serialized: not in the capture, a recording, an
IPC response or a log.

`labels` (v2, below) follows the same rule: display-only, never model input.
Room, workflow and step names are free text a church types, and can name a
person ("Follow-up for ..."), so they never sit inside a read's `body`.

## Implementation notes (native, 2026-11-13)

- Person display names come from PCO `full_name` (falling back to `name`);
  2018-11-01 Person has no `name` attribute.
- `person_schedules` falls back once to an unfiltered read if `filter=all`
  fails with `provider-failure`; those reads carry `fallback: true`.
- `outcome` is `ok`, `truncated`, or a SourceError reason: `timeout`, `denied`,
  `provider-failure`, `invalid-response`, `oversized`, `busy`,
  `invalid-credentials`, `missing-credentials`, `locked`, `store-unavailable`,
  `organization-unverified`, `binding-mismatch`, `invalid-request`. The
  internal `not-found` (a `groups_person_memberships` 404, below) is never an
  outcome; a recording holding it is refused.
- The check has a 180 s budget; unstarted reads are listed as `timeout`.
  Cancellation (disconnect/quit) aborts and saves nothing. When rate headers
  show 10 or fewer requests left, the check waits out the window (max 20 s).
- The legacy stdin reader (`ozzie-source-reader`) keeps its original three
  collections and schemas; capture-only profiles are crate-private and cannot
  be requested over that channel.
- Not yet verified live: next-link formats, `meta.parent` shapes, `filter=all`
  acceptance, TeamLeader relationship key, 429/400 shapes. Each page costs two
  provider requests (identity check + GET).

## v2 operations reads (Calendar, People workflows, Groups)

Status: build contract, 2026-11-13 (stream S1, `core/native-auth`). Additive to
v1: same `SundayCapture` (`version: 1`), same `reads` list, appended after every
Services read. Feeds `core/src/operations-findings` (room overlaps, unowned
overdue follow-ups) and the group-meeting overlap check. All GET; these reads
write nothing (Ozzie's one write is in "Reads for a change you confirm" below).

### Consent (least privilege)

Each Planning Center product scope permits both reading and writing in that
product. Every read is GET-only, enforced in its own HTTP layer
(`NativeSourceHttp::build`, the one request shape; a test builds every
collection and checks method GET, no body, the allowlisted URL and the pinned
version). Ozzie's only writes are the one change a person confirms and its undo
(`core/native-auth/src/change.rs`), each only with the church's switch on. The
scope is therefore not the safety boundary, and the default asks for the
least:

| scope set | OAuth `scope` | how |
|---|---|---|
| `services` (default) | `services openid` | `begin()`; IPC `connect_planning_center` without `operations` |
| `services-and-operations` (opt-in) | `services calendar people groups openid` | `begin_with(Scopes::ServicesAndOperations)`; IPC `connect_planning_center { operations: true }`; `ozzie-dev connect --operations` |

**Granted, not requested** (S1 fixes, 2026-11-13). The saved and reported set is
what Planning Center *granted*, read from the token response's non-secret
`scope` (RFC 6749 §5.1: omitted only when identical to the request, so an
absent `scope` means exactly what was asked):

- A grant naming any scope the sign-in did not ask for, or without `services`,
  fails the sign-in with `AuthError` **`scope-mismatch`** (IPC
  `{"authentication":"scope-mismatch"}`); nothing is saved and the refused
  credential is revoked (best effort).
- `services-and-operations` only when `calendar`, `people` and `groups` were
  all granted; a partial grant is saved and reported as `services` (its
  operations reads are then `not-requested`).
- Refresh keeps or narrows the saved set, never widens it: the response's
  `scope` is read against the full operations set (anything else, or no
  `services`, refuses the refresh with `scope-mismatch` and leaves the saved
  record untouched), and the saved set becomes the narrower of the two.
- A new sign-in that replaces a saved credential (any narrowing included)
  revokes the replaced one through the disconnect revoke request
  (`refresh_token`, else `access_token`), after the new one is saved and
  verified. Best effort: a failed revoke never fails the new sign-in, and a
  re-issued identical token is not revoked. (Desktop/`AuthController::new`
  path; the Sunday-authority custody path does no extra provider I/O.)

The granted set is saved with the connection (non-secret `"scopes"` field in
the token record; omitted for `services`, so default records are byte-for-byte
the v1 format) and reported as `ConnectionStatus.scopes` (`"services"` |
`"services-and-operations"`) once this session has verified the saved
connection (sign-in, or the refresh a restart runs: it reports the saved
granted set, narrowed by that refresh's `scope` if it says so); absent
otherwise. An unknown stored value refuses the record.

Without `services-and-operations`, every operations read below is recorded with
outcome **`not-requested`** and never attempted (the verified read path also
refuses those products). `not-requested` means "not checked", never "clear".
With it, Planning Center can still refuse a product (403, e.g. the person has
no Calendar permission): those reads are `denied`.

### Collections (exact GETs, pinned versions)

Versions are pinned per product via `X-PCO-API-Version`. For each one, the
OpenAPI document of the pinned version and of the latest stable version are
identical for every schema, filter, include and parent used here (diffed
2026-11-13 from `https://api.planningcenteronline.com/{product}/v2/open_api/{version}`),
and the pinned version is the one the Oct 23 staging reads used live.

| collection | product / version | path | fixed query (plus `per_page=100&offset=N`) | `meta.parent` |
|---|---|---|---|---|
| `calendar_rooms` | Calendar 2022-07-07 | `/calendar/v2/resources` | `filter=rooms` | Organization = capture org |
| `calendar_resource_bookings` | Calendar 2022-07-07 | `/calendar/v2/resource_bookings` | `filter=rooms&include=event_resource_request&where[ends_at][gt]={W0}&where[starts_at][lt]={W1}&order=starts_at` | Organization |
| `calendar_conflicts` | Calendar 2022-07-07 | `/calendar/v2/events/{event}/conflicts` | none | Event |
| `people_workflows` | People 2025-11-10 | `/people/v2/workflows` | none | Organization |
| `people_workflow_steps` | People 2025-11-10 | `/people/v2/workflows/{workflow}/steps` | none | Workflow |
| `people_workflow_ready_cards` | People 2025-11-10 | `/people/v2/workflows/{workflow}/cards` | `where[stage]=ready` | Workflow |
| `people_workflow_snoozed_cards` | People 2025-11-10 | `/people/v2/workflows/{workflow}/cards` | `where[stage]=snoozed` | Workflow |
| `groups_person_memberships` | Groups 2023-07-10 | `/groups/v2/people/{person}/memberships` | none | Person |
| `groups_group_events` | Groups 2023-07-10 | `/groups/v2/groups/{group}/events` | `where[ends_at][gt]={W0}&where[starts_at][lt]={W1}&order=starts_at` | Group |

Order: rooms, bookings, conflicts for each event the bookings link (type
`Event`, in booking order; redacted `BookedEvent` stubs are not read), workflows,
then per workflow steps, ready cards, snoozed cards; then memberships for each person **scheduled on this plan**
(team_members people inside the bounded people set, in plan order); then events
for each group from those memberships. Ids are numeric only; a `meta.parent`
that names anything else, or a next link that changes any fixed key or value
(including the window), rejects the page. Next links may percent-encode only
`[ ] : ,` (either hex case), as Rails writes them.

Planning Center may silently ignore a filter, and `meta.parent` may be absent,
so every row is checked for what its query promised; any row that fails
rejects the whole page (`invalid-response`):

| collection | each row must |
|---|---|
| `calendar_rooms` | have `kind` = `Room` |
| `calendar_resource_bookings` | overlap the window: `ends_at` > W0 and `starts_at` < W1 (offsets applied) |
| `calendar_conflicts` | link `resource` (a Conflict names no event of its own; `meta.parent`, when present, must be the requested Event) |
| `people_workflow_steps` | link `workflow` to exactly the requested workflow |
| `people_workflow_ready_cards` / `_snoozed_cards` | link `workflow` to the requested workflow, and have `stage` = `ready` / `snoozed` |
| `groups_person_memberships` | link `person` to exactly the requested person |
| `groups_group_events` | link `group` to the requested group, and overlap the window |

A missing or null link fails like a wrong one.

### Window `{W0}`/`{W1}`

From the plan read: Services returns `Plan.sort_date` in the organization's time
zone, so its date D is the church-local Sunday. **Verified live 2026-11-13**: the
trailing `Z` is that floating local time, not a UTC instant (9:30 AM Eastern reads
`2026-11-22T09:30:00Z`). The window was designed before that was known and still
covers both readings; it is a superset either way, and recordings must keep deriving
it exactly so, so it is unchanged:

- `[D-1 10:00Z, D+1 12:00Z)`: local midnight-to-midnight of D for every UTC
  offset from -12:00 to +14:00;
- when `sort_date` ends in `Z`, also `[T-24h, T+24h)`: if T is a true instant,
  the local day holding it lies within 24 hours either side, whatever the
  offset and service time (09:00 Sunday at UTC+10 is `2026-11-21T23:00:00Z`;
  that Sunday ends `2026-11-22T14:00:00Z`; the window ends
  `2026-11-22T23:00:00Z`). An explicit offset already names the local date, so
  it gets the band alone.

The window is the union (contiguous), rounded outward to whole seconds. Staged
plan (`sort_date` `2026-11-22T09:00:00Z`): `2026-11-21T09:00:00Z`..`2026-11-23T12:00:00Z`;
the Eastern evening bookings that cross the UTC date stay inside. (S1 fixes:
the end was D+1 12:00Z regardless; a flat D+1 14:00Z was considered and
rejected because it still misses early services east of UTC+9, e.g. 07:00 at
UTC+8 ends 16:00Z.) It is a deliberate superset with no time-zone
rules in Rust: the webview narrows it to the church-local day with the church's
time zone, and must treat any evaluation window not inside the recorded `window`
as unverified. Each windowed read records `window: {starts_at, ends_at}`
(canonical whole-second UTC); recordings refuse a windowed read whose window
is not the one derived from that capture's plan read. If the plan read did not
answer, windowed reads are not attempted and do not appear.

### Church time zone (webview, review fixes 2026-11-13)

The webview (`core/src/church-time.ts`) takes the church's zone only from this
capture's `organization` read: exactly one, `ok`, an `Organization` row whose id is
the capture's organization, and a `time_zone` this Mac's time-zone data accepts
(ECMA-402 canonicalizes some names: `Asia/Kolkata` reads back as `Asia/Calcutta`,
`Etc/UTC` as `UTC`; acceptance, not an identical read-back, is the test). There is
**no fallback to this Mac's zone**. Without the zone (no read, a failed read, or a
name it doesn't know) the day-window-dependent parts, room bookings and group
meetings, are listed as not checked; follow-ups, which aren't tied to a time, are
still evaluated. The church-local day is `[first instant of D, first instant of
D+1)` in that zone (where daylight saving skips midnight, as in Havana or Santiago,
the day starts after the gap). The same zone dates the Sunday everywhere: Ask's `D`
line is `sort_date`'s date part, and "What changed" uses the instant `sort_date`
names in the church zone (none without it).

Not yet verified live: the `time_zone` spelling Services returns (an IANA name is
expected; any other shape refuses the page, so rooms and group meetings are then
not checked), and the Services root's `meta`/`links` shape.

### Read identity (new `SundayRead` fields)

```ts
interface SundayRead {           // v1 fields unchanged
  event_id?: string;             // calendar_conflicts: the booked Calendar Event read
  workflow_id?: string;          // people_workflow_steps / _ready_cards / _snoozed_cards
  group_id?: string;             // groups_group_events
  groups_person_id?: string;     // groups_person_memberships (same id space as person_id)
  window?: { starts_at: string; ends_at: string };  // the two windowed reads
  outcome: "ok" | "truncated" | "not-requested" | string;
}
```

Operations reads never set `team_id` or `person_id`: the v1 coverage mapper
groups scopes by those keys, so a Calendar, People or Groups outcome can never
change a Services team or person scope.

### Minimized facts kept

- Resource (room): `kind` (required code, "Room"). Its `name` goes to `labels`.
- ResourceBooking: `starts_at`, `ends_at` (required, UTC), `quantity`; rels
  `resource` (Resource), `event` (Event | BookedEvent), `event_instance`
  (EventInstance | BookedEventInstance), `event_resource_request`
  (EventResourceRequest, kept only if present: not a documented booking link).
  Calendar 2026-06-22 notes that bookings may carry `BookedEvent*` stubs for
  events the user cannot see, in every version.
- Included EventResourceRequest: `approval_status` (code; OpenAPI: `A`
  approved, `P` pending, `R` rejected) and rels `event`, `resource` only. Join a
  booking to its request by `event_resource_request` if present, else by
  (`event`, `resource`); any ambiguity is unknown.
- Conflict (`calendar_conflicts`): `resolved_at` (null, absent or instant);
  rels `resource` (Resource, required) and `winner` (Event | BookedEvent, or
  null). Dropped: `note` (free text), `created_at`, `updated_at`,
  `resolved_by` (a Person), links; nothing is included. See "Calendar
  conflicts" below.
- Workflow: (no attributes; its `name` goes to `labels`). WorkflowStep:
  `sequence`, `expected_response_time_in_days`; rel `workflow` (its `name`
  goes to `labels`).
- WorkflowCard: `stage` (required code), `calculated_due_at`, `overdue`,
  `snooze_until`, `completed_at`, `removed_at` (each null or instant); rels
  `assignee` (Assignee | Person, **id only**; null = unassigned),
  `current_step` (WorkflowStep), `workflow`. The card's own `person` is
  dropped. Only `ready` and `snoozed` cards are read: other stages cannot make an
  unowned-overdue finding. Stage values are not enumerated in the OpenAPI.
- Membership: `role` (code); rels `group`, `person` (ids).
- Group Event: `starts_at`, `ends_at` (required), `canceled`; rel `group`.

Never kept: names of people (no Person include is requested; any included row
of an unrequested type is dropped unread), request notes, descriptions, event
names, locations, URLs, counts, emails. No operations read adds to `names`.

### Calendar conflicts (`calendar_conflicts`, opt-in operations scope only)

Why per event: the Calendar OpenAPI (2022-07-07, fetched 2026-11-13, SHA-256
`63b6e52c…f02798`; the Conflict schema, `/conflicts` and
`/events/{event_id}/conflicts` are byte-identical in 2026-06-22 and the latest
2026-10-19) describes a Conflict as "a conflict between two events caused by
overlapping event resource requests" with attributes `created_at`, `note`,
`resolved_at`, `updated_at` and relationships `resource`, `resolved_by`
(Person), `winner` (Event). It links **neither** of the two bookings nor event
instances, and has no times. The organization-wide `/conflicts` accepts only
`filter=unresolved|resolved|future` (no time filter), so it cannot be bounded
to the Sunday or tied to a pair. `/events/{event_id}/conflicts` (parent
`Event`; no filter; `order=resolved_at`; same includes) can: it is read for
each event the window's bookings link, so a conflict id listed under both
events of an overlapping pair names that pair.

Stored row (one `calendar_conflicts` read per booked event):

```json
{"collection":"calendar_conflicts","event_id":"230","offset":0,"checked_at":"…","outcome":"ok",
 "body":{"data":[{"id":"701","type":"Conflict",
   "attributes":{"resolved_at":null},
   "relationships":{"resource":{"data":{"id":"887","type":"Resource"}},
                    "winner":{"data":null}}}],
  "meta":{"total_count":1}}}
```

`attributes` may be `{}` and `winner` absent when Planning Center omits them.
Suggested `PairResolution` for an overlapping booking pair (event A, event B,
same resource R), not verified live:

- both A's and B's `calendar_conflicts` reads `ok` (not `truncated`) and
  exactly one conflict id appears in both with `resource` R:
  `resolved_at` null/absent -> `unresolved`; `resolved_at` set and `winner`
  A or B -> `resolved`; `resolved_at` set and no `winner` -> `shared`
  (Calendar's "allow both" is not described in the OpenAPI: treat as
  unverified);
- anything else (either read missing, failed, `truncated` or
  `not-requested`; no common id; several; a `BookedEvent` side) -> `unknown`.

Bounds: at most 20 booked events (`MAX_CONFLICT_EVENTS`); a bound hit marks the
bookings read `truncated`. Breaker endpoint `calendar/conflicts`. Recordings:
`event_id` must be an `Event` linked by a `calendar_resource_bookings` row of
the same capture. Not yet verified live: whether one conflict appears under
both events, how "allow both" sets `winner`, and whether redaction turns
`winner` into `BookedEvent` here.

### `labels` (local display names, S1 fixes)

```ts
interface SundayCapture {        // additive; absent when empty and in older recordings
  labels?: Record<string, string>;
}
// keys: "room:<Resource id>" | "workflow:<Workflow id>" | "step:<WorkflowStep id>"
// e.g. { "room:887": "Sanctuary", "workflow:795": "New guest follow-up", "step:2211": "Welcome" }
```

- Source: the `name` attribute of `calendar_rooms`, `people_workflows` and
  `people_workflow_steps` rows. The projection validates it (null or string),
  removes it from the row, and keeps it here; it is never in a `body`, never in
  the stdin protocol envelope.
- Display form: control characters (C0/C1, so newlines and tabs), U+2028/U+2029
  and bidirectional embedding/override/isolate characters (U+202A–U+202E,
  U+2066–U+2069) become spaces; whitespace runs collapse to one space and the
  ends are trimmed; longer than 120 characters is cut to 119 plus `…`. A name
  that is empty in this form gets no label. One page naming the same id two
  ways is refused (`invalid-response`); across pages the first is kept.
- **LOCAL ONLY, never model input** (same rule as `names`). The native name
  guard does not term-match labels (their words, e.g. "for", "new", would
  refuse ordinary drafts); the webview's placeholder boundary keeps them out.
- Each key's id must be a row of a read of its own collection in the same
  capture.

### Bounds and failures

- 3 pages x 100 per collection instance (as v1); at most 10 workflows
  (`MAX_WORKFLOWS`), 20 groups (`MAX_GROUPS`) and 20 booked events for
  conflicts (`MAX_CONFLICT_EVENTS`). A bound hit marks the read that supplied
  the ids (`people_workflows`, `groups_person_memberships`,
  `calendar_resource_bookings`) or the last page `truncated`. Group people
  reuse the v1 40-person bound.
- Breaker: a denial or query refusal (401/403/400/422) counts against its own
  product **endpoint** (product + path: ready and snoozed cards share
  `people/cards`, filtered and fallback schedules share `services/schedules`),
  and only a success of that same endpoint resets it (S1 fixes: a working
  steps read no longer resets refused card queries). So one product or endpoint
  without permission never silences another; transport, timeout, 5xx and 429
  failures still count against the provider as a whole and any success resets
  them. After 3 consecutive strikes the remaining reads under that breaker are
  recorded with the tripping reason, unrequested.
- **404 on memberships means "in no group"** (live, 2026-11-13, test
  organization): Groups answers `GET /groups/v2/people/{id}/memberships` with
  HTTP 404 (`{"errors":[{"status":"404","title":"Not Found",…}]}`) when the
  Services person has no Groups profile, and 200 with their memberships when
  they have one. For `groups_person_memberships` only, a 404 maps to the
  internal `SourceError::NotFound` (`status_error`, by status alone; the body
  is not read), and the check records that read as `ok` with the body
  `{"data":[],"meta":{"count":0,"total_count":0}}`: no strike, no retry, and it
  resets breakers like any answered read. That person then adds no groups, and
  the page counts their group meetings as checked (none), not as "couldn't be
  checked". Every other collection's 404 stays `provider-failure` and counts
  against the provider as before, and the stdin protocol never sees
  `not-found`. Not distinguished: a 404 for every plan person reads as nobody
  on the plan being in Groups.
- Same 180 s budget, rate-header pacing and Retry-After handling as v1.

### Recordings (S1 fixes)

On save and load, beyond re-projecting every body:

- `not-requested` is valid only on operations reads, and marks every
  operations read of a capture or none (it is the connection's consent).
- A `groups_person_memberships` 404 is stored as the `ok` empty read above
  and loads like any other; `not-found` is never a valid outcome.
- Child reads must take their id from their parent read: steps and cards from
  a `people_workflows` row, `groups_group_events` from a group linked by a
  `groups_person_memberships` row, `groups_person_memberships` from a person
  linked by a `team_members` row.
- `labels` keys, prefixes and display form are as above.
- A body holding a room, workflow or step `name` is **refused** (the
  re-projection no longer keeps it), not stripped. Older recordings without
  `labels` load unchanged when they hold no such names (every Services-only
  recording); a v2 operations recording made before this change holds them
  and is refused: record again.
- Not covered: recordings carry no integrity tag, so a local edit that keeps
  every rule above (e.g. flipping a card's `overdue`) still loads. They are
  0600 files in a 0700 app-data directory on the user's own Mac.

### Verified vs not yet verified

- Verified from the pinned OpenAPI: every path, `filter`/`include`/`order`
  enum value, `where[...]` key, attribute and relationship key above, each
  `meta.parent` type, and the `approval_status` values. Live (Oct 23 staging,
  same versions): `/calendar/v2/resource_bookings?include=event_resource_request,resource`,
  `/people/v2/workflows/{id}/cards` (stage `ready`/`snoozed`, assignee type
  `Assignee`), `/groups/v2/groups/{id}/events?where[starts_at][gte]=...&order=starts_at`.
  Live (2026-11-13, owner's browser, test organization):
  `/groups/v2/people/{id}/memberships` answers 200 with one membership for a
  person in a group and 404 for a Services person with no Groups profile (see
  "Bounds and failures").
- Not yet verified live: `filter=rooms` on bookings, `where[stage]`, the
  two-sided window filter, the memberships `meta.parent` shape, the booking
  `event_resource_request` link, Organization `meta.parent` id equal to the
  userinfo org id (PCO's published examples show one org id across products),
  next-link encoding, the Services Organization `time_zone` spelling, and
  whether the OAuth app registration must list the extra scopes before
  `services calendar people groups openid` is accepted.
- Verified live (2026-11-13, test organization): `Plan.sort_date` is local
  wall-clock time with a floating `Z` (plan 92902197, 9:30 AM Eastern:
  `2026-11-22T09:30:00Z`).

## Kids rules: People background checks (2026-11-14)

Church rules can mark teams as kids teams (no team is assumed). Two rules follow, both evaluated in the
webview (`core/src/kids-rules.ts`):

- **At least N confirmed people at each service time** (default 2, range 1–10): from `team_members`,
  `plan_times` and `needed_positions` already read. No new read. Pending is never confirmed; Services has no
  age, so this counts confirmed people, never adults.
- **A current background check before serving with kids**: one new read, below, only while that rule is on.

| Collection | Version | Path | Fixed query | Parent |
|---|---|---|---|---|
| `people_background_checks` | People 2025-11-10 | `/people/v2/people/{person}/background_checks` | `filter=complete_clear` | Person |

- **Who:** people on this plan whose `team_members` row is on a kids team, status C or U, in plan order, at most
  40 (anyone past that is listed as not checked). The webview passes the kids team ids (`check_sunday`'s
  optional `kids_team_ids`, at most 10 distinct numeric ids, validated natively; Church rules keep at most 10).
  None set: no read. Read last, after every other read. The capture records the list as `kids_teams` (absent
  when empty).
- **Consent:** the `people` scope of the opt-in operations consent. Without it each read is `not-requested`.
- **Identity:** `SundayRead.people_person_id` (same id space as `person_id`), never `person_id` or
  `groups_person_id`. Recordings refuse a background read for anyone not confirmed or pending on one of the
  capture's `kids_teams` on this plan.
- **Kept:** `status` (always `complete_clear`: kept to prove the filter held), `current`, `expires_on`
  (date or null), and the `person` link. Dropped: `note`, `report_url`, `completed_at`, `status_updated_at`,
  `created_by`, links, included rows. A page with any other status, another or no person, a non-date expiry,
  another row type, a different `meta.parent`, or a next link without the exact filter is refused whole.
- **Meaning:** a person has a current check when a row has `current: true` and no expiry (null) or one after the
  Sunday's date. A row without a `current` or `expires_on` field couldn't be read. Otherwise: "no current background check on file", or "expires before Sunday" (Worth a look
  when it expires on the Sunday itself). A failed, refused or partial read is listed as not checked, never as
  no check; when every read that answered is empty, each finding is Worth a look (the login may not see them).
- **Never to a model:** background-check findings and their "not checked" lines stay on this Mac: the agent
  tools, Ask, procedures and the shared check read the brief through `forModels` (`core/src/kids-rules.ts`),
  and the fixed vocabulary has no word for them. Kids-team counts may go, as placeholders and counts.
- Verified from the live published documentation (People 2025-11-10 OpenAPI and vertex): the path, the
  `filter` enum (including `complete_clear`), the attributes, `meta.parent` `Person`, the `people` OAuth
  scope. Not yet verified live: that People person ids equal Services person ids here (as they do for Groups),
  whether a login without background-check access gets 403 or an empty list, and the meaning of `current` and
  of a null `expires_on` in reads.

## Reads for a change you confirm (2026-11-17)

Not part of a capture or a recording, and never on the stdin protocol. When a leader asks to add someone to an
open role (`core/native-auth/src/change.rs`, off by default for each church), Ozzie reads Planning Center again,
just before the confirmation is shown and again just before the change is made, through the same verified,
GET-only path: the plan, its times, its needed positions, its people, the team's position assignments, the
person's blockouts and schedules (all already above), and these narrow People reads:

| Collection | Version | Path | Fixed query | Kept |
|---|---|---|---|---|
| `person_child` | People 2025-11-10 | `/people/v2/people/{person}` | `fields[Person]=child,status` | `child`, `status` |
| `people_background_checks` | People 2025-11-10 | `/people/v2/people/{person}/background_checks` | `filter=complete_clear` | as above |
| `pending_checks_awaiting_applicant` | People 2025-11-10 | `/people/v2/people/{person}/background_checks` | `filter=awaiting_applicant&fields[BackgroundCheck]=status,person` | `status`, `person` |
| `pending_checks_report_processing` | People 2025-11-10 | same | `filter=report_processing&fields[BackgroundCheck]=status,person` | `status`, `person` |
| `pending_checks_needs_review` | People 2025-11-10 | same | `filter=needs_review&fields[BackgroundCheck]=status,person` | `status`, `person` |

- `person_child` is read for every change: a person Planning Center lists as a child, or whose record doesn't
  say, is never added. The one extra field on that same request is the Person's `status` (`active` or
  `inactive`; security review S, L9): a person listed as inactive, or whose record leaves it out, empty or with
  another value, is never added. `inactivated_at` is not asked for. The values come from Planning Center's own
  published tool schema for People (a person's `status` filter, `active` / `inactive`); a live read hasn't
  confirmed them yet. Services' own `archived` flag on a person is not read: a person archived in Services but
  active in People isn't caught by this field. The background-check reads are made only for a team marked as a kids team in Church
  rules, even when the background-check rule is off; a finished check that didn't clear, a canceled one and an
  expired invitation are never asked for.
- What is read is used for that one change on this Mac and kept nowhere; nothing of it goes to a model, the
  copies for other AI apps or Siri, or a notice.
