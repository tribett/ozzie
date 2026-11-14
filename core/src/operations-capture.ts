// Maps the v2 operations reads of a Sunday capture (docs/build/sunday-capture-contract.md,
// "v2 operations reads") into the rooms / follow-ups evaluator (operations-findings, through
// evaluateOperationsSources) and the group-meeting check. Pure: no I/O, no model.
// Output carries ids and intervals only. Room, workflow and step names come back separately as
// `labels` and, like person names, are for display on this Mac only: never model input.
// Anything not fully read (turned off, refused, partial, failed, missing, outside the Sunday)
// is listed as not checked and never treated as clear. The church-local Sunday comes only from the
// church's own time zone (church-time.ts): without it, rooms and group meetings aren't checked.
import { churchZone, localDate, localDay, planDate } from "./church-time.js";
import { canonical } from "./operations-findings/rows.js";
import type { Interval, OperationsResult, PairResolution, RequiredScope, SourceScope, WorkflowCard } from "./operations-findings/index.js";
import { evaluateOperationsSources, type OperationsSources } from "./operations-source-integration.js";
import { isSourceInstant } from "./read-result.js";
import { isOperationsRead, LIVE_CHECK_VALID_MS, type RoomRuleSetting, type SundayCapture, type SundayRead, type SundayRules } from "./sunday-capture.js";

export interface OperationsOptions {
  /** The evaluation clock for a live check. A recording is always evaluated as of its completion. Default: completed_at. */
  now?: string;
}
/** Someone scheduled on this plan whose group meets while they serve. A schedule fact, "Worth a look". */
export interface GroupMeeting {
  person_id: string;
  serving: { position: string | null; status: "confirmed" | "pending"; interval: Interval }[];
  meetings: Interval[];
  /** Earliest read time of the Services and Groups reads this rests on. */
  checked_at: string;
}
export type OperationsPart = "rooms" | "follow-ups";
export interface SundayOperations {
  /** Rooms and follow-ups through the evaluator; null when nothing could be evaluated, or the check is out of date. */
  result: OperationsResult | null;
  /** Room, workflow and step names by the result's ids. LOCAL ONLY, like person names. */
  labels: Record<string, string>;
  group_meetings: GroupMeeting[];
  /** The "What I didn't check" lines for rooms, follow-ups and group meetings. */
  not_checked: string[];
  /** A live check older than LIVE_CHECK_VALID_MS: nothing about rooms, follow-ups or group meetings is shown. */
  stale: boolean;
  /**
   * The parts a "nothing found" line may name. Non-empty only when every part in this check was
   * fully read and evaluated (no unread or unevaluated part, nothing out of date) and nothing was
   * found or left uncertain; then it names exactly the parts that were checked.
   */
  clear: OperationsPart[];
  /** Earliest Planning Center read time behind rooms and follow-ups. Never a Church-rules or evaluation time. */
  checked_at: string | null;
}

type State = "ok" | "not-requested" | "denied" | "truncated" | "timeout" | "failed" | "missing" | "window";
const REASON: Record<Exclude<State, "ok">, string> = {
  "not-requested": "turned off in Settings", denied: "Planning Center didn't allow it", truncated: "only partly read",
  timeout: "took too long", failed: "couldn't be read", missing: "not read", window: "the read didn't cover this whole Sunday",
};
const COMPLETENESS: Record<State, SourceScope["completeness"]> = {
  ok: "complete", "not-requested": "unverified", denied: "denied", truncated: "partial", timeout: "unreadable", failed: "unreadable", missing: "unverified", window: "unverified",
};
const ERRORS: Record<State, SourceScope["errors"]> = {
  ok: [], "not-requested": ["unverified"], denied: ["denied"], truncated: ["partial"], timeout: ["provider-failure"], failed: ["provider-failure"], missing: ["unverified"], window: ["unverified"],
};
const TOO_MANY = "more than Ozzie checks at once, so none are shown";
const ZONE: Record<"missing" | "failed" | "unrecognized", string> = {
  missing: "The church's time zone wasn't part of this check",
  failed: "The church's time zone couldn't be read from Planning Center",
  unrecognized: "Planning Center's time zone for the church isn't one Ozzie recognizes",
};

interface Row { type?: unknown; id?: unknown; attributes?: Record<string, unknown>; relationships?: Record<string, { data?: unknown } | undefined> }
const asRows = (data: unknown): Row[] => (Array.isArray(data) ? data : data ? [data] : []).filter((r): r is Row => !!r && typeof r === "object");
const bodyRows = (reads: SundayRead[]) => reads.flatMap(r => r.body ? asRows(r.body.data) : []);
const includedRows = (reads: SundayRead[]) => reads.flatMap(r => r.body && Array.isArray(r.body.included) ? asRows(r.body.included) : []);
// Planning Center ids, kept short enough that every derived evaluator id stays within its 64 characters.
const isId = (v: unknown): v is string => typeof v === "string" && /^[1-9]\d{0,19}$/.test(v);
const rowId = (row: Row, type: string) => row.type === type && isId(row.id) ? row.id : null;
/**
 * undefined: no such link; null: explicitly empty; "" when the link isn't a usable id, or (with
 * `types`) links something else, e.g. a redacted `BookedEvent` where an `Event` is required.
 */
function link(row: Row, key: string, types?: readonly string[]): string | null | undefined {
  const rel = row.relationships?.[key];
  if (!rel || typeof rel !== "object" || !("data" in rel)) return undefined;
  if (rel.data === null) return null;
  const data = rel.data && typeof rel.data === "object" ? rel.data as { id?: unknown; type?: unknown } : {};
  if (types && !types.includes(data.type as string)) return "";
  return isId(data.id) ? data.id : "";
}
const EVENT = ["Event"], RESOURCE = ["Resource"], REQUEST = ["EventResourceRequest"], WORKFLOW = ["Workflow"], STEP = ["WorkflowStep"];
const links = (row: Row, key: string): string[] | null => {
  const d = row.relationships?.[key]?.data;
  return Array.isArray(d) ? d.map(x => (x as { id?: unknown } | null)?.id).filter(isId) : null;
};
const attr = (row: Row, key: string): unknown => row.attributes?.[key];
const instant = (v: unknown): string | null => isSourceInstant(v) && Number(v.slice(0, 4)) >= 2000 && Number(v.slice(0, 4)) <= 2100 ? v : null;
const nullish = (v: unknown) => v === null || v === undefined;
const ms = (s: string) => Date.parse(s);
const iso = (n: number) => new Date(n).toISOString();
const unique = <T>(xs: T[]) => [...new Set(xs)];
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const intersects = (a: Interval, b: Interval) => ms(a.starts_at) < ms(b.ends_at) && ms(b.starts_at) < ms(a.ends_at);
const covers = (w: SundayRead["window"], day: Interval) => !!w && !!instant(w.starts_at) && !!instant(w.ends_at) &&
  ms(w.starts_at) <= ms(day.starts_at) && ms(w.ends_at) >= ms(day.ends_at);
const answered = (r: SundayRead) => (r.outcome === "ok" || r.outcome === "truncated") && !!r.body;
const earliest = (reads: SundayRead[]) => reads.map(r => instant(r.checked_at)).filter((t): t is string => !!t).sort((a, b) => ms(a) - ms(b))[0] ?? null;

/** Every page complete; any refusal, failure, gap or a window that doesn't cover `day` is not. */
function stateOf(reads: SundayRead[], day: Interval | null = null): State {
  if (!reads.length) return "missing";
  const outcomes = reads.map(r => r.outcome);
  if (outcomes.every(o => o === "not-requested")) return "not-requested";
  if (outcomes.some(o => o === "denied" || o === "source_denied")) return "denied";
  if (outcomes.some(o => o === "timeout")) return "timeout";
  if (outcomes.some(o => o !== "ok" && o !== "truncated") || reads.some(r => !r.body)) return "failed";
  if (outcomes.some(o => o === "truncated")) return "truncated";
  if (day && reads.some(r => !covers(r.window, day))) return "window";
  return "ok";
}

// Display text from a source: control characters stripped, bounded, never empty.
const display = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const text = v.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim().slice(0, 120);
  return text || null;
};
/** Display name of a room, workflow or step: the capture's local labels, or (older recordings) the read body. */
function labelFor(capture: SundayCapture, kind: "room" | "workflow" | "step", id: string, row: Row | undefined): string | null {
  if (capture.labels) return Object.hasOwn(capture.labels, `${kind}:${id}`) ? display(capture.labels[`${kind}:${id}`]) : null;
  return row ? display(attr(row, "name")) : null;
}

/**
 * Stored room rules that make sense; anything else is ignored (no rule). Only "not shared" is a
 * rule: an `exclusive: false` entry (stored for "No rule set" by earlier versions) is no rule.
 */
export function roomRules(rules: SundayRules): RoomRuleSetting[] {
  const seen = new Set<string>();
  return (Array.isArray(rules.rooms) ? rules.rooms as unknown[] : []).flatMap(r => {
    if (!r || typeof r !== "object") return [];
    const { room_id, exclusive, setup_minutes } = r as Record<string, unknown>;
    if (!isId(room_id) || exclusive !== true || typeof setup_minutes !== "number" || !Number.isInteger(setup_minutes) ||
      setup_minutes < 0 || setup_minutes > 1440 || seen.has(room_id)) return [];
    seen.add(room_id);
    return [{ room_id, exclusive, setup_minutes }];
  });
}

/** Rooms Planning Center Calendar listed in this capture, for Church rules. Names are local only. */
export function captureRooms(capture: SundayCapture): { room_id: string; name: string | null }[] {
  const rows = bodyRows(capture.reads.filter(r => r.collection === "calendar_rooms"));
  return unique(rows.map(r => rowId(r, "Resource")).filter(isId))
    .map(id => ({ room_id: id, name: labelFor(capture, "room", id, rows.find(r => r.id === id)) }));
}

interface Context {
  capture: SundayCapture; evaluated_at: string; zone: string | null; day: Interval | null; window: Interval;
  binding: OperationsSources["binding"]; labels: Record<string, string>;
  reads: (collection: string) => SundayRead[];
}
interface Part {
  /** No reads of this part at all / every read turned off in Settings. */
  absent: boolean; off: boolean;
  /** Each evaluation for this part (rooms: one; follow-ups: one per workflow). */
  evaluations: { sources: OperationsSources; explained: Set<string> }[];
  lines: string[];
  /** The Planning Center reads behind this part that answered. */
  read: SundayRead[];
  /** Everything this part needs was read and fits one check; still subject to its evaluations. */
  complete: boolean;
}
const part = (p: Partial<Part>): Part => ({ absent: false, off: false, evaluations: [], lines: [], read: [], complete: false, ...p });

function sourceScope(ctx: Context, scope_id: string, source: SourceScope["source"], state: State, reads: SundayRead[], expected_count: number) {
  // Church rules aren't read from Planning Center: they hold as of the evaluation, and that time is never shown as a check time.
  const check_time = earliest(reads) ?? ctx.evaluated_at;
  const observation: SourceScope = {
    scope_id, binding: { ...ctx.binding }, window: { ...ctx.window }, source, check_time, valid_until: iso(ms(check_time) + LIVE_CHECK_VALID_MS),
    completeness: COMPLETENESS[state], enumeration_complete: state === "ok", expected_count, errors: [...ERRORS[state]],
  };
  return { observation, grant: state === "ok" ? "asserted" as const : state === "denied" ? "denied" as const : "unknown" as const };
}
const sources = (ctx: Context, required_scopes: RequiredScope[], scopes: OperationsSources["scopes"], rest: Partial<Pick<OperationsSources, "calendar" | "church_rules" | "workflow">>): OperationsSources => ({
  binding: { ...ctx.binding }, evaluated_at: ctx.evaluated_at, window: { ...ctx.window }, churchTimeZone: ctx.zone ?? "UTC", required_scopes, scopes,
  calendar: { bookings: [], requests: [], request_scopes: [], conflicts: [] }, church_rules: [], workflow: { cards: [] }, ...rest,
});

function roomsPart(ctx: Context, rules: RoomRuleSetting[]): Part {
  const roomReads = ctx.reads("calendar_rooms"), bookingReads = ctx.reads("calendar_resource_bookings"), conflictReads = ctx.reads("calendar_conflicts");
  const all = [...roomReads, ...bookingReads];
  if (!all.length) return part({ absent: true });
  if (all.every(r => r.outcome === "not-requested")) return part({ off: true });
  const read = [...roomReads, ...bookingReads, ...conflictReads].filter(answered);
  // Without the church's zone there is no church-local Sunday to check (the caller says so).
  if (!ctx.zone) return part({ read });
  const { day } = ctx;
  // Only resources in Calendar's room list are rooms; without that list, no booking can be placed.
  const roomState = stateOf(roomReads);
  let state: State = day ? stateOf(bookingReads, day) : "missing";
  const lines = [...(roomState === "ok" ? [] : [`Room list: ${REASON[roomState]}.`]), ...(state === "ok" ? [] : [`Room bookings: ${REASON[state]}.`])];
  if (roomState !== "ok") return part({ lines: unique([...lines, ...(state === "ok" ? ["Room bookings: not checked without the room list."] : [])]), read });
  const roomRows = bodyRows(roomReads);
  const inventory = new Set(roomRows.map(r => rowId(r, "Resource")).filter(isId));
  // Bookings of a listed room on the church-local Sunday. Identical repeats collapse; conflicting ones make the read unusable.
  const byId = new Map<string, { id: string; room: string; interval: Interval; row: Row } | null>();
  for (const row of day ? bodyRows(bookingReads) : []) {
    const id = rowId(row, "ResourceBooking"), room = link(row, "resource", RESOURCE);
    const starts_at = instant(attr(row, "starts_at")), ends_at = instant(attr(row, "ends_at"));
    if (!id || !isId(room) || !starts_at || !ends_at || ms(starts_at) >= ms(ends_at)) { if (state === "ok") state = "failed"; continue; }
    if (!inventory.has(room)) continue;
    const booking = { id, room, interval: { starts_at, ends_at }, row };
    if (!intersects(booking.interval, day!)) continue;
    const seen = byId.get(id);
    if (seen === undefined) byId.set(id, booking);
    else if (seen === null || canonical(seen.row) !== canonical(row)) { byId.set(id, null); if (state === "ok") state = "failed"; }
  }
  if (state !== "ok" && !lines.some(l => l.startsWith("Room bookings:"))) lines.push(`Room bookings: ${REASON[state]}.`);
  const bookings = [...byId.values()].filter(b => b !== null);
  // Only rooms with a booking that Sunday are evaluated; the full list stays for Church rules.
  const rooms = unique(bookings.map(b => b.room));
  for (const id of rooms) {
    const label = labelFor(ctx.capture, "room", id, roomRows.find(r => r.id === id));
    if (label) ctx.labels[`room${id}`] = label;
  }
  if (!rooms.length) return part({ lines, read, complete: state === "ok" });
  if (rooms.length * 3 > 128 || bookings.length > 64) return part({ lines: [...lines, `Room bookings: ${TOO_MANY}.`], read });
  // Approval: the booking's own request link, else the one request for its (event, room). Anything else is unknown.
  const requests = new Map<string, Row | null>();
  for (const row of includedRows(bookingReads)) {
    const id = rowId(row, "EventResourceRequest");
    if (!id) continue;
    const seen = requests.get(id);
    requests.set(id, seen === undefined || (seen && canonical(seen) === canonical(row)) ? row : null);
  }
  const approval = (b: { room: string; row: Row }): "requested" | "approved" | "declined" | "unknown" | null => {
    const direct = link(b.row, "event_resource_request", REQUEST), event = link(b.row, "event", EVENT);
    const matches = direct !== undefined ? (direct && requests.has(direct) ? [requests.get(direct)] : [])
      : isId(event) ? [...requests.values()].filter(r => r && link(r, "event", EVENT) === event && link(r, "resource", RESOURCE) === b.room) : [];
    if (matches.length !== 1 || !matches[0]) return null;
    const code = attr(matches[0], "approval_status");
    return code === "A" ? "approved" : code === "P" ? "requested" : code === "R" ? "declined" : "unknown";
  };
  // Calendar conflict records, read once per event the Sunday's bookings link. The same conflict id listed under exactly
  // two events names that pair. Contradictory copies of one conflict make it unusable (null).
  const conflicts = new Map<string, { resource: string | null | undefined; resolved_at: string | null; winner: string | null | undefined; events: Set<string>; row: Row } | null>();
  for (const read of conflictReads) {
    if (read.outcome !== "ok" || !read.body || !isId(read.event_id)) continue;
    for (const row of asRows(read.body.data)) {
      const id = rowId(row, "Conflict");
      if (!id) continue;
      const resolved = attr(row, "resolved_at");
      const entry = { resource: link(row, "resource", RESOURCE), resolved_at: instant(resolved) ?? null, winner: link(row, "winner", EVENT), events: new Set([read.event_id!]), row };
      if (resolved !== undefined && resolved !== null && !instant(resolved)) { conflicts.set(id, null); continue; }
      const seen = conflicts.get(id);
      if (seen === undefined) conflicts.set(id, entry);
      else if (seen && seen.resource === entry.resource && seen.resolved_at === entry.resolved_at && seen.winner === entry.winner) seen.events.add(read.event_id!);
      else conflicts.set(id, null);
    }
  }
  let pairsUnread = false;
  const explained = new Set<string>();
  const required: RequiredScope[] = [], scopes: OperationsSources["scopes"] = [], requestScopes: OperationsSources["scopes"] = [];
  const calendar: OperationsSources["calendar"] = { bookings: [], requests: [], request_scopes: requestScopes, conflicts: [] };
  const church_rules: OperationsSources["church_rules"] = [];
  for (const room of rooms) {
    const R = `room${room}`, target = { kind: "room" as const, resource_id: R };
    const mine = bookings.filter(b => b.room === room);
    const rule = rules.find(r => r.room_id === room);
    required.push({ scope_id: `${R}-bookings`, kind: "bookings", target }, { scope_id: `${R}-rule`, kind: "room-rule", target },
      { scope_id: `${R}-pairs`, kind: "room-resolutions", target });
    let joined = 0;
    const status = new Map<string, ReturnType<typeof approval>>();
    for (const b of mine) {
      calendar.bookings.push({ scope_id: `${R}-bookings`, resource_id: R, booking_id: `booking${b.id}`, interval: b.interval, lifecycle: "present",
        // The booking's own times are the room's booked time in Planning Center; the church's setup time is added by the evaluator.
        setup_coverage: "asserted" });
      const s = approval(b);
      status.set(b.id, s);
      if (s) { calendar.requests.push({ resource_id: R, booking_id: `booking${b.id}`, status: s }); joined++; }
    }
    scopes.push(sourceScope(ctx, `${R}-bookings`, "normalized-calendar", state, bookingReads, mine.length));
    requestScopes.push(sourceScope(ctx, `${R}-bookings`, "normalized-calendar", state, bookingReads, joined));
    scopes.push(sourceScope(ctx, `${R}-rule`, "church-rule", "ok", [], rule ? 1 : 0));
    if (rule) church_rules.push({ scope_id: `${R}-rule`, resource_id: R, rule_id: `rule${room}`, exclusive: rule.exclusive, additional_setup_minutes: rule.setup_minutes });
    // Whether two overlapping bookings were worked out comes from Calendar's own conflict records, read per event.
    // A pair is only described when both events' conflict reads completed; nothing is assumed either way.
    const pad = (rule?.setup_minutes ?? 0) * 60_000;
    const pairReads: SundayRead[] = [];
    let pairState: State = "ok", pairs = 0;
    for (let i = 0; i < mine.length; i++) for (let j = i + 1; j < mine.length; j++) {
      const a = mine[i]!, b = mine[j]!;
      if (!(ms(a.interval.starts_at) - pad < ms(b.interval.ends_at) && ms(b.interval.starts_at) - pad < ms(a.interval.ends_at))) continue;
      // A Calendar conflict is between two different events the user can see; anything else can't name this pair.
      const ea = link(a.row, "event", EVENT), eb = link(b.row, "event", EVENT);
      const named = isId(ea) && isId(eb) && ea !== eb;
      let resolution: PairResolution["state"] = "unknown";
      if (named) {
        const ra = conflictReads.filter(r => r.event_id === ea), rb = conflictReads.filter(r => r.event_id === eb);
        pairReads.push(...ra, ...rb);
        // Both events' own conflict reads must have answered in full; either one missing is "not read".
        const st = stateOf(ra) === "ok" ? stateOf(rb) : stateOf(ra);
        if (st !== "ok") { if (pairState === "ok") pairState = st; continue; }
        const shared = [...conflicts.values()].filter(c => c && c.resource === room && c.events.size === 2 && c.events.has(ea) && c.events.has(eb));
        const c = shared.length === 1 ? shared[0]! : null;
        // Resolved with a winner settles the overlap only when the other booking's request was declined.
        // Resolved with no winner, or any other shape, is not something Ozzie can read: unknown, never hidden.
        const loser = c?.winner === ea ? b : c?.winner === eb ? a : null;
        resolution = !c ? "unknown" : c.resolved_at === null ? "unresolved" : loser && status.get(loser.id) === "declined" ? "resolved" : "unknown";
      }
      // From the earliest start (setup time included) to the latest end, so a confirmed overlap with setup still finds it.
      const starts = Math.min(ms(a.interval.starts_at), ms(b.interval.starts_at)) - pad;
      calendar.conflicts.push({ scope_id: `${R}-pairs`, resource_id: R, booking_ids: [`booking${a.id}`, `booking${b.id}`],
        interval: { starts_at: iso(starts), ends_at: iso(Math.max(ms(a.interval.ends_at), ms(b.interval.ends_at))) }, state: resolution });
      pairs++;
    }
    // The pairs come from the bookings read; their conflict reads only add to it.
    scopes.push(sourceScope(ctx, `${R}-pairs`, "normalized-calendar", pairState, [...bookingReads, ...pairReads], pairs));
    if (pairState !== "ok") { explained.add(`${R}-pairs`); pairsUnread = true; }
    if (state !== "ok") explained.add(`${R}-bookings`);
  }
  if (calendar.conflicts.length > 512) return part({ lines: [...lines, `Room bookings: ${TOO_MANY}.`], read });
  if (pairsUnread) lines.push("Whether overlapping room bookings were already worked out in Planning Center couldn't be read.");
  return part({ lines, read, complete: !lines.length,
    evaluations: [{ sources: sources(ctx, required, scopes, { calendar, church_rules }), explained }] });
}

function cardOf(row: Row, from: "ready" | "snoozed", ids: { scope: string; workflow: string; step: string; card: string }, now: string): WorkflowCard {
  const stage = attr(row, "stage"), removed = attr(row, "removed_at"), completed = attr(row, "completed_at"), until = attr(row, "snooze_until");
  const state = instant(removed) ? "removed" : instant(completed) ? "completed" : stage === from && nullish(removed) && nullish(completed) ? "active" : "unknown";
  const assignee = link(row, "assignee", ["Assignee", "Person"]);
  const snoozedUntil = instant(until);
  const snooze: WorkflowCard["snooze"]["value"] = stage !== from ? { state: "unknown", until: null }
    : from === "snoozed" ? (snoozedUntil ? { state: "snoozed", until: snoozedUntil } : { state: "unknown", until: null })
      : nullish(until) || (snoozedUntil && ms(snoozedUntil) <= ms(now)) ? { state: "unsnoozed", until: null } : { state: "unknown", until: null };
  return {
    scope_id: `${ids.scope}-cards`, workflow_id: ids.workflow, step_id: ids.step, card_id: ids.card,
    lifecycle: { scope_id: `${ids.scope}-state`, value: { state, readiness: stage !== from ? "unknown" : from === "ready" ? "ready" : "not-ready", current_step_id: ids.step } },
    assignment: { scope_id: `${ids.scope}-owner`, value: assignee === undefined || assignee === "" ? "unknown" : assignee === null ? "unassigned" : "assigned" },
    due: { scope_id: `${ids.scope}-due`, value: instant(attr(row, "calculated_due_at")) },
    snooze: { scope_id: `${ids.scope}-snooze`, value: snooze },
  };
}

function followUpsPart(ctx: Context): Part {
  const workflowReads = ctx.reads("people_workflows");
  const all = ["people_workflows", "people_workflow_steps", "people_workflow_ready_cards", "people_workflow_snoozed_cards"].flatMap(ctx.reads);
  if (!all.length) return part({ absent: true });
  if (all.every(r => r.outcome === "not-requested")) return part({ off: true });
  const workflowState = stateOf(workflowReads);
  const lines = workflowState === "ok" ? [] : [`Follow-up workflows: ${REASON[workflowState]}.`];
  const workflowRows = bodyRows(workflowReads);
  const unread = new Map<string, number>();
  let capped = 0;
  const evaluations: Part["evaluations"] = [];
  const kinds = [["cards", "cards"], ["card-state", "state"], ["assignments", "owner"], ["due", "due"], ["snooze", "snooze"]] as const;
  // Each workflow is checked on its own, so one too large to check leaves only itself unchecked.
  for (const w of unique(workflowRows.map(r => rowId(r, "Workflow")).filter(isId))) {
    const label = labelFor(ctx.capture, "workflow", w, workflowRows.find(r => r.id === w));
    if (label) ctx.labels[`workflow${w}`] = label;
    const of = (collection: string) => ctx.reads(collection).filter(r => r.workflow_id === w);
    const steps = of("people_workflow_steps"), ready = of("people_workflow_ready_cards"), snoozed = of("people_workflow_snoozed_cards");
    let state: State = ready.length && snoozed.length ? stateOf([...ready, ...snoozed]) : "missing";
    const stepRows = stateOf(steps) === "ok" ? bodyRows(steps).filter(r => { const wf = link(r, "workflow", WORKFLOW); return wf === undefined || wf === w; }) : [];
    const inventory = stepRows.map(r => rowId(r, "WorkflowStep")).filter(isId);
    for (const id of inventory) {
      const name = labelFor(ctx.capture, "step", id, stepRows.find(r => r.id === id));
      if (name) ctx.labels[`step${id}`] = name;
    }
    const cards: { step: string; card: WorkflowCard }[] = [];
    for (const [from, rows] of [["ready", bodyRows(ready)], ["snoozed", bodyRows(snoozed)]] as const) for (const row of rows) {
      const id = rowId(row, "WorkflowCard"), step = link(row, "current_step", STEP), wf = link(row, "workflow", WORKFLOW);
      // A card that can't be placed on a step of this workflow can't be evaluated: the workflow isn't fully read.
      if (!id || !isId(step) || (wf !== undefined && wf !== w)) { if (state === "ok") state = "failed"; continue; }
      cards.push({ step, card: cardOf(row, from, { scope: `w${w}-s${step}`, workflow: `workflow${w}`, step: `step${step}`, card: `card${id}` }, ctx.evaluated_at) });
      if (!ctx.labels[`step${step}`] && ctx.capture.labels) { const name = labelFor(ctx.capture, "step", step, undefined); if (name) ctx.labels[`step${step}`] = name; }
    }
    if (state !== "ok") unread.set(REASON[state], (unread.get(REASON[state]) ?? 0) + 1);
    // Steps without cards only add evidence; drop them first if the evaluator's bounds would be exceeded.
    let targets = unique([...inventory, ...cards.map(c => c.step)]);
    if (targets.length * 5 > 128) targets = targets.filter(step => cards.some(c => c.step === step));
    if (targets.length * 5 > 128 || cards.length > 128) { capped++; continue; }
    if (!targets.length) continue;
    const reads = [...ready, ...snoozed];
    const explained = new Set<string>();
    const required: RequiredScope[] = [], scopes: OperationsSources["scopes"] = [];
    for (const step of targets) {
      const target = { kind: "step" as const, workflow_id: `workflow${w}`, step_id: `step${step}` };
      const count = cards.filter(c => c.step === step).length;
      for (const [kind, suffix] of kinds) {
        const scope_id = `w${w}-s${step}-${suffix}`;
        required.push({ scope_id, kind, target });
        scopes.push(sourceScope(ctx, scope_id, "normalized-workflow", state, reads, count));
        if (state !== "ok") explained.add(scope_id);
      }
    }
    evaluations.push({ sources: sources(ctx, required, scopes, { workflow: { cards: cards.map(c => c.card) } }), explained });
  }
  for (const [reason, n] of unread) lines.push(`Follow-ups in ${plural(n, "workflow")}: ${reason}.`);
  if (capped) lines.push(`Follow-ups in ${plural(capped, "workflow")}: ${TOO_MANY}.`);
  return part({ lines, evaluations, read: all.filter(answered), complete: !lines.length });
}

function groupsPart(ctx: Context): { meetings: GroupMeeting[]; lines: string[]; off: boolean; absent: boolean } {
  const memberships = ctx.reads("groups_person_memberships"), events = ctx.reads("groups_group_events");
  if (![...memberships, ...events].length) return { meetings: [], lines: [], off: false, absent: true };
  if ([...memberships, ...events].every(r => r.outcome === "not-requested")) return { meetings: [], lines: [], off: true, absent: false };
  // Without the church's zone there is no church-local Sunday to check (the caller says so).
  if (!ctx.zone) return { meetings: [], lines: [], off: false, absent: false };
  const { day } = ctx;
  const serviceReads = (collection: string) => ctx.capture.reads.filter(r => r.collection === collection && r.outcome === "ok");
  const times = new Map<string, Interval>();
  for (const row of bodyRows(serviceReads("plan_times"))) {
    const id = rowId(row, "PlanTime"), starts_at = instant(attr(row, "starts_at")), ends_at = instant(attr(row, "ends_at"));
    if (id && starts_at && ends_at && ms(starts_at) < ms(ends_at)) times.set(id, { starts_at, ends_at });
  }
  const problems = new Map<string, Set<string>>();
  const problem = (reason: string, person: string) => problems.set(reason, (problems.get(reason) ?? new Set()).add(person));
  // People confirmed or pending on this plan, with their serving times on the church-local Sunday.
  const serving = new Map<string, GroupMeeting["serving"]>();
  for (const row of bodyRows(serviceReads("team_members"))) {
    const person = link(row, "person"), status = attr(row, "status");
    const confirmed = status === "C" || status === "Confirmed", pending = status === "U" || status === "Unconfirmed";
    if (row.type !== "PlanPerson" || !isId(person) || (!confirmed && !pending)) continue;
    const ids = links(row, "times");
    const intervals = ids?.map(id => times.get(id)) ?? [];
    if (!ids?.length || intervals.some(i => !i) || !day) { problem(day ? "their serving time couldn't be confirmed" : REASON.missing, person); continue; }
    const today = (intervals as Interval[]).filter(i => intersects(i, day));
    if (!today.length) continue;
    const position = typeof attr(row, "team_position_name") === "string" ? attr(row, "team_position_name") as string : null;
    serving.set(person, [...(serving.get(person) ?? []), ...today.map(interval => ({ position, status: confirmed ? "confirmed" as const : "pending" as const, interval }))]);
  }
  const meetings: GroupMeeting[] = [];
  for (const [person, assignments] of serving) {
    const mine = memberships.filter(r => r.groups_person_id === person);
    // A memberships read that came back refused, partial or failed is named by the brief
    // ("Groups for N people: ..."); one never made is named here.
    if (stateOf(mine) === "missing") problem(REASON.missing, person);
    const groups = unique(bodyRows(mine).filter(r => { const who = link(r, "person"); return r.type === "Membership" && (who === undefined || who === person); })
      .map(r => link(r, "group")).filter(isId));
    const found: Interval[] = [], used: SundayRead[] = [...mine];
    for (const group of groups) {
      const reads = events.filter(r => r.group_id === group);
      used.push(...reads);
      const eventState = stateOf(reads, day);
      if (eventState !== "ok") problem(REASON[eventState], person);
      for (const row of bodyRows(reads)) {
        const starts_at = instant(attr(row, "starts_at")), ends_at = instant(attr(row, "ends_at")), owner = link(row, "group");
        if (row.type !== "Event" || !starts_at || !ends_at || ms(starts_at) >= ms(ends_at) || attr(row, "canceled") === true || (owner !== undefined && owner !== group)) continue;
        const meeting = { starts_at, ends_at };
        if (assignments.some(a => intersects(a.interval, meeting)) && !found.some(f => f.starts_at === starts_at && f.ends_at === ends_at)) found.push(meeting);
      }
    }
    if (!found.length) continue;
    meetings.push({ person_id: person, serving: assignments.filter(a => found.some(m => intersects(a.interval, m))),
      meetings: found.sort((a, b) => ms(a.starts_at) - ms(b.starts_at)), checked_at: earliest([...used, ...serviceReads("team_members"), ...serviceReads("plan_times")]) ?? ctx.evaluated_at });
  }
  const lines = [...problems].map(([reason, people]) => `Group meetings for ${plural(people.size, "person", "people")}: ${reason}.`);
  return { meetings: meetings.sort((a, b) => a.person_id < b.person_id ? -1 : 1), lines, off: false, absent: false };
}

function merge(results: OperationsResult[]): OperationsResult | null {
  if (!results.length) return null;
  const valid = results.filter(r => r.binding);
  if (!valid.length) return results[0]!;
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  const findings = results.flatMap(r => r.findings).sort((a, b) => compare(a.finding_id, b.finding_id));
  const uncertainties = [...new Map(results.flatMap(r => r.uncertainties).map(u => [canonical(u), u])).values()].sort((a, b) => compare(canonical(a), canonical(b)));
  return { ...valid[0]!, findings, uncertainties,
    status: uncertainties.length ? "unverified" : findings.length ? "findings" : "checked-scope-clear",
    unchecked_scope_ids: results.flatMap(r => r.unchecked_scope_ids).sort(compare),
    checked_scopes: results.flatMap(r => r.checked_scopes).sort((a, b) => compare(a.scope_id, b.scope_id)) };
}

/** Rooms, follow-ups and group meetings for this Sunday; null when the capture has no operations reads at all. */
export function sundayOperations(capture: SundayCapture, rules: SundayRules, options: OperationsOptions = {}): SundayOperations | null {
  if (!capture.reads.some(isOperationsRead)) return null;
  const empty = { result: null, labels: {}, group_meetings: [], stale: false, clear: [], checked_at: null };
  const evaluated_at = capture.kind === "recording" ? capture.completed_at : options.now ?? capture.completed_at;
  if (!instant(evaluated_at)) return { ...empty, not_checked: ["Rooms, follow-ups and group meetings couldn't be checked, so nothing about them is shown."] };
  // The church's own zone decides its local Sunday: Services' plan sort_date is local wall-clock time, so its date is that Sunday.
  const church = churchZone(capture);
  const zone = church.zone;
  const plan = asRows(capture.reads.find(r => r.collection === "plan" && r.outcome === "ok")?.body?.data)[0];
  const date = planDate(plan ? attr(plan, "sort_date") : undefined);
  const day = zone && date ? localDay(date, zone) : null;
  // Follow-ups aren't tied to a time; without the Sunday they're evaluated over a day of the check (UTC when the zone is unknown).
  const anyZone = zone ?? "UTC";
  const ctx: Context = {
    capture, evaluated_at, zone, day,
    window: day ?? localDay(date ?? localDate(evaluated_at, anyZone), anyZone) ?? { starts_at: evaluated_at, ends_at: iso(ms(evaluated_at) + 86_400_000) },
    binding: { workspace_id: "ozzie", organization_id: String(capture.organization), access_epoch: (String(capture.started_at).replace(/[^0-9A-Za-z]/g, "") || "capture").slice(0, 64) },
    labels: {},
    reads: collection => capture.reads.filter(r => r.collection === collection),
  };
  const rooms = roomsPart(ctx, roomRules(rules));
  const followUps = followUpsPart(ctx);
  const groups = groupsPart(ctx);
  const opsTimes = capture.reads.filter(r => isOperationsRead(r) && r.outcome !== "not-requested");
  const first = earliest(opsTimes);
  const stale = capture.kind === "live" && !!first && ms(evaluated_at) >= ms(first) + LIVE_CHECK_VALID_MS;

  const lines: string[] = [];
  if (rooms.off && followUps.off) lines.push("Rooms and follow-ups weren't checked. Turn this on in Settings.");
  else if (rooms.off) lines.push("Room bookings weren't checked. Turn this on in Settings.");
  else if (followUps.off) lines.push("Follow-ups weren't checked. Turn this on in Settings.");
  if (groups.off) lines.push(rooms.off || followUps.off ? "Group meetings weren't checked either." : "Group meetings weren't checked. Turn this on in Settings.");
  if (rooms.absent && !rooms.off) lines.push("Room bookings weren't part of this check.");
  if (followUps.absent && !followUps.off) lines.push("Follow-ups weren't part of this check.");
  // An out-of-date check shows its out-of-date state only: no results, no meetings, nothing clear.
  if (stale) return { ...empty, stale, not_checked: unique([...lines, "Rooms, follow-ups and group meetings: this check is out of date, so they aren't shown."]) };
  const needZone = [...(!rooms.off && !rooms.absent ? ["room bookings"] : []), ...(!groups.off && !groups.absent ? ["group meetings"] : [])];
  if (church.problem && needZone.length) lines.push(`${ZONE[church.problem]}, so ${needZone.join(" and ")} weren't checked.`);

  const results: OperationsResult[] = [];
  const checked: OperationsPart[] = [];
  let unexplained = 0, complete = true;
  for (const [name, key, p] of [["Rooms", "rooms", rooms], ["Follow-ups", "follow-ups", followUps]] as const) {
    if (p.off || p.absent) continue;
    lines.push(...p.lines);
    let done = p.complete;
    for (const { sources: s, explained } of p.evaluations) {
      const result = evaluateOperationsSources(s);
      results.push(result);
      if (!result.binding) { lines.push(`${name} couldn't be checked, so nothing about them is shown.`); done = false; continue; }
      unexplained += result.unchecked_scope_ids.filter(id => !explained.has(id)).length;
      if (result.unchecked_scope_ids.length) done = false;
    }
    if (done) checked.push(key); else complete = false;
  }
  if (unexplained) lines.push(`${unexplained} ${unexplained === 1 ? "part" : "parts"} of the room and follow-up check couldn't be read.`);
  lines.push(...groups.lines);
  const result = merge(results);
  const found = !!result && (result.findings.length > 0 || result.uncertainties.length > 0);
  return {
    result, labels: ctx.labels, group_meetings: groups.meetings, not_checked: unique(lines), stale: false,
    clear: complete && !found ? checked : [], checked_at: earliest([...rooms.read, ...followUps.read]),
  };
}

/** Rooms and follow-ups for this Sunday, or null when the capture has none of their reads. */
export function operationsFromCapture(capture: SundayCapture, rules: SundayRules, options: OperationsOptions = {}): OperationsResult | null {
  return sundayOperations(capture, rules, options)?.result ?? null;
}

/** The "What I didn't check" lines for an evaluated result alone. Never an all-clear for something unread. */
export function operationsNotChecked(result: OperationsResult | null): string[] {
  if (!result) return ["Room bookings and follow-ups weren't part of this check."];
  if (!result.binding) return ["Rooms and follow-ups couldn't be checked, so nothing about them is shown."];
  const n = result.unchecked_scope_ids.length;
  return n ? [`${n} ${n === 1 ? "part" : "parts"} of the room and follow-up check couldn't be read.`] : [];
}
