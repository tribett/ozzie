// Fictional rooms, follow-ups and group meetings for the Sunday example.
// `withFictionalOperations` appends Calendar, People and Groups reads shaped like the minimized
// v2 operations reads (docs/build/sunday-capture-contract.md) and like the fictional data staged in
// the Planning Center test organization: one room with six approved Nov 22 bookings, one
// follow-up workflow with an unowned overdue card, an owned late card and a snoozed card, and a
// group meeting at the same time as the pending lyrics assignment. Every id and name is invented
// or a test-account id; no real person or church is represented.
import { evaluateOperations, type OperationsInput, type SourceScope, type Target } from "./operations-findings/index.js";
import { operationsNotChecked, type SundayOperations } from "./operations-capture.js";
import { CHECKED, FICTIONAL_ZONE, PEOPLE } from "./fictional-sunday.js";
import { isOperationsRead, type SundayCapture, type SundayRead } from "./sunday-capture.js";

/** The fictional church is on Eastern time (its Services Organization read says so), so the example reads the same on any Mac. */
export const FICTIONAL_TIME_ZONE = FICTIONAL_ZONE;
export const FICTIONAL_ROOM = "887596";
export const FICTIONAL_WORKFLOW = "795989";
export const FICTIONAL_STEP = "2211636";
export const FICTIONAL_GROUP = "2879688";
export const FICTIONAL_CARDS = { unowned: "56356259", owned: "56356217", snoozed: "56356270" };
/** Window derived natively (window_for) from the plan's Nov 22 09:30Z sort_date: every UTC offset, and 24 hours either side. */
export const FICTIONAL_WINDOW = { starts_at: "2026-11-21T09:30:00Z", ends_at: "2026-11-23T12:00:00Z" };

const rel = (type: string, id: string | null) => ({ data: id === null ? null : { type, id } });
const page = (data: unknown[], extra: { included?: unknown[] } = {}) => ({ data, ...extra, meta: { count: data.length, total_count: data.length } });

// Staged events on room 887596, Nov 22 Eastern (UTC-5). Evening bookings cross the UTC date.
const BOOKINGS: [booking: string, event: string, starts_at: string, ends_at: string][] = [
  ["41000001", "23167823", "2026-11-22T14:00:00Z", "2026-11-22T16:00:00Z"], // Sunday service 09:00-11:00
  ["41000002", "23167837", "2026-11-22T15:45:00Z", "2026-11-22T16:15:00Z"], // Newcomers lunch setup 10:45-11:15
  ["41000003", "23167937", "2026-11-22T18:00:00Z", "2026-11-22T19:45:00Z"], // earlier control 13:00-14:45
  ["41000004", "23167940", "2026-11-22T21:00:00Z", "2026-11-22T21:30:00Z"], // later control 16:00-16:30
  ["41000005", "23167943", "2026-11-22T23:00:00Z", "2026-11-23T00:15:00Z"], // earlier control 18:00-19:15
  ["41000006", "23167945", "2026-11-23T01:00:00Z", "2026-11-23T01:30:00Z"], // later control 20:00-20:30
];
const card = (id: string, stage: "ready" | "snoozed", due: string, assignee: string | null, snooze_until: string | null) => ({
  type: "WorkflowCard", id,
  attributes: { stage, calculated_due_at: due, overdue: stage === "ready", snooze_until, completed_at: null, removed_at: null },
  relationships: { assignee: rel("Assignee", assignee), current_step: rel("WorkflowStep", FICTIONAL_STEP), workflow: rel("Workflow", FICTIONAL_WORKFLOW) },
});

/** Calendar, People and Groups reads for the Nov 22 example, all read at `checked_at`. */
export function fictionalOperationsReads(checked_at = CHECKED): SundayRead[] {
  const read = (collection: string, body: NonNullable<SundayRead["body"]>, extra: Partial<SundayRead> = {}): SundayRead =>
    ({ collection, offset: 0, checked_at, outcome: "ok", body, ...extra });
  const window = { ...FICTIONAL_WINDOW };
  const workflow = { workflow_id: FICTIONAL_WORKFLOW };
  return [
    read("calendar_rooms", page([{ type: "Resource", id: FICTIONAL_ROOM, attributes: { kind: "Room" } }])),
    read("calendar_resource_bookings", page(BOOKINGS.map(([id, event, starts_at, ends_at], i) => ({
      type: "ResourceBooking", id, attributes: { starts_at, ends_at, quantity: 1 },
      relationships: { resource: rel("Resource", FICTIONAL_ROOM), event: rel("Event", event), event_instance: rel("EventInstance", `6100000${i + 1}`),
        event_resource_request: rel("EventResourceRequest", `5200000${i + 1}`) },
    })), { included: BOOKINGS.map(([, event], i) => ({ type: "EventResourceRequest", id: `5200000${i + 1}`, attributes: { approval_status: "A" },
      relationships: { event: rel("Event", event), resource: rel("Resource", FICTIONAL_ROOM) } })) }), { window }),
    // Calendar's own conflict records, one read per booked event. The service and the lunch setup share an unresolved conflict.
    ...BOOKINGS.map(([, event]) => read("calendar_conflicts", page(event === "23167823" || event === "23167837"
      ? [{ type: "Conflict", id: "7010001", attributes: { resolved_at: null }, relationships: { resource: rel("Resource", FICTIONAL_ROOM), winner: { data: null } } }]
      : []), { event_id: event })),
    read("people_workflows", page([{ type: "Workflow", id: FICTIONAL_WORKFLOW, attributes: {} }])),
    read("people_workflow_steps", page([{ type: "WorkflowStep", id: FICTIONAL_STEP, attributes: { sequence: 1, expected_response_time_in_days: 3 },
      relationships: { workflow: rel("Workflow", FICTIONAL_WORKFLOW) } }]), workflow),
    read("people_workflow_ready_cards", page([
      card(FICTIONAL_CARDS.unowned, "ready", "2026-10-26T21:27:40Z", null, null),
      // Owned by the operator: late, but someone has it.
      card(FICTIONAL_CARDS.owned, "ready", "2026-10-26T21:20:43Z", "50001", null),
    ]), workflow),
    read("people_workflow_snoozed_cards", page([card(FICTIONAL_CARDS.snoozed, "snoozed", "2026-12-03T12:00:00Z", null, "2026-11-30T12:00:00Z")]), workflow),
    // Memberships for each person scheduled on the plan, in plan order.
    read("groups_person_memberships", page([]), { groups_person_id: PEOPLE.greeterConfirmed }),
    read("groups_person_memberships", page([]), { groups_person_id: PEOPLE.nurseryConfirmed }),
    read("groups_person_memberships", page([{ type: "Membership", id: "7100001", attributes: { role: "member" },
      relationships: { group: rel("Group", FICTIONAL_GROUP), person: rel("Person", PEOPLE.lyricsPending) } }]), { groups_person_id: PEOPLE.lyricsPending }),
    // The group meets 09:30-10:30 Eastern, the same time as the pending lyrics assignment.
    read("groups_group_events", page([{ type: "Event", id: "58119664", attributes: { starts_at: "2026-11-22T14:30:00Z", ends_at: "2026-11-22T15:30:00Z", canceled: false },
      relationships: { group: rel("Group", FICTIONAL_GROUP) } }]), { group_id: FICTIONAL_GROUP, window }),
  ];
}

/** Display names for the example's room, workflow and step. Local only, like person names. */
export const FICTIONAL_CAPTURE_LABELS: Record<string, string> = {
  [`room:${FICTIONAL_ROOM}`]: "Sanctuary (fictional)",
  [`workflow:${FICTIONAL_WORKFLOW}`]: "Welcome follow-up (fictional)",
  [`step:${FICTIONAL_STEP}`]: "Call a first-time guest",
};

/** The given fictional capture with the operations reads appended, as the native check appends them. */
export function withFictionalOperations(capture: SundayCapture): SundayCapture {
  const last = capture.reads.map(r => r.checked_at).sort().at(-1) ?? CHECKED;
  return { ...capture, reads: [...capture.reads, ...fictionalOperationsReads(last)], labels: { ...capture.labels, ...FICTIONAL_CAPTURE_LABELS } };
}

/** The same, as a connection signed in with Services only records it: every operations read `not-requested`, never attempted. */
export function withFictionalOperationsOff(capture: SundayCapture): SundayCapture {
  // Without consent no workflow or group ids are known, so only these reads exist.
  const unattempted = new Set(["people_workflow_steps", "people_workflow_ready_cards", "people_workflow_snoozed_cards", "groups_group_events", "calendar_conflicts"]);
  const reads = withFictionalOperations(capture).reads.filter(r => !unattempted.has(r.collection)).map(r => isOperationsRead(r)
    ? { collection: r.collection, offset: 0, checked_at: r.checked_at, outcome: "not-requested",
      ...(r.window ? { window: r.window } : {}), ...(r.groups_person_id ? { groups_person_id: r.groups_person_id } : {}) } : r);
  return { ...capture, reads };
}

// Normalized engine fixture: a confirmed room overlap (with a recorded unresolved pair) that the
// current reads can't produce, kept to render the confirmed wording. Design assumptions only.
const binding = { workspace_id: "fictional", organization_id: "1001", access_epoch: "example" };
const window = { starts_at: "2026-11-22T00:00:00-05:00", ends_at: "2026-11-23T00:00:00-05:00" };
const hall: Target = { kind: "room", resource_id: "hall" };
const call: Target = { kind: "step", workflow_id: "welcome", step_id: "call" };
const scope = (scope_id: string, expected_count: number, source: SourceScope["source"]): SourceScope => ({
  scope_id, binding: { ...binding }, window: { ...window }, source, check_time: CHECKED, valid_until: "2026-11-21T15:00:00Z",
  completeness: "complete", enumeration_complete: true, expected_count, errors: [],
});

/** Display labels for the ids above. Local only, like person names. */
export const FICTIONAL_OPERATION_LABELS: Record<string, string> = {
  hall: "Fellowship Hall", service: "Overflow seating for the 9:30 service", lunch: "Newcomers lunch",
  welcome: "Welcome follow-up", call: "Call a first-time guest",
};

export function fictionalOperationsInput(): OperationsInput {
  return {
    binding: { ...binding }, evaluated_at: CHECKED, window: { ...window }, churchTimeZone: "America/New_York",
    required_scopes: [
      { scope_id: "hall-bookings", kind: "bookings", target: hall }, { scope_id: "hall-rule", kind: "room-rule", target: hall },
      { scope_id: "hall-pairs", kind: "room-resolutions", target: hall },
      { scope_id: "cards", kind: "cards", target: call }, { scope_id: "card-state", kind: "card-state", target: call },
      { scope_id: "owners", kind: "assignments", target: call }, { scope_id: "due", kind: "due", target: call },
      { scope_id: "snooze", kind: "snooze", target: call },
    ],
    scopes: [
      scope("hall-bookings", 2, "normalized-calendar"), scope("hall-rule", 1, "church-rule"), scope("hall-pairs", 1, "normalized-calendar"),
      ...["cards", "card-state", "owners", "due", "snooze"].map(id => scope(id, 1, "normalized-workflow")),
    ],
    bookings: [
      { scope_id: "hall-bookings", resource_id: "hall", booking_id: "service", status: "approved", interval: { starts_at: "2026-11-22T09:00:00-05:00", ends_at: "2026-11-22T11:00:00-05:00" } },
      { scope_id: "hall-bookings", resource_id: "hall", booking_id: "lunch", status: "approved", interval: { starts_at: "2026-11-22T10:45:00-05:00", ends_at: "2026-11-22T12:15:00-05:00" } },
    ],
    room_rules: [{ scope_id: "hall-rule", resource_id: "hall", rule_id: "hall-exclusive", exclusive: true, additional_setup_minutes: 30 }],
    resolutions: [{ scope_id: "hall-pairs", resource_id: "hall", booking_ids: ["service", "lunch"], interval: { starts_at: "2026-11-22T09:00:00-05:00", ends_at: "2026-11-22T12:15:00-05:00" }, state: "unresolved" }],
    cards: [{
      scope_id: "cards", workflow_id: "welcome", step_id: "call", card_id: "guest1",
      lifecycle: { scope_id: "card-state", value: { state: "active", readiness: "ready", current_step_id: "call" } },
      assignment: { scope_id: "owners", value: "unassigned" }, due: { scope_id: "due", value: "2026-11-19T17:00:00Z" },
      snooze: { scope_id: "snooze", value: { state: "unsnoozed", until: null } },
    }],
  };
}

/** The normalized fixture through the real evaluator, in the shape the Sunday page takes. */
export function fictionalOperations(): SundayOperations & { result: NonNullable<SundayOperations["result"]> } {
  const result = evaluateOperations(fictionalOperationsInput());
  return { result, labels: { ...FICTIONAL_OPERATION_LABELS }, group_meetings: [], not_checked: operationsNotChecked(result), stale: false, clear: [], checked_at: CHECKED };
}
