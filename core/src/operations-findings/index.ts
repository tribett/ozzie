import { canonical, checkRows } from "./rows.js";
import { validate } from "./validate.js";
import { checkScopes } from "./scopes.js";
import type { IssueCode, OperationsInput, OperationsResult, RoomFinding } from "./types.js";
export type * from "./types.js";
const ms = (s: string) => Date.parse(s);
const iso = (n: number) => new Date(n).toISOString();
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Pure evaluation of local normalized observations. No source read or model payload. */
export function evaluateOperations(input: OperationsInput): OperationsResult {
  const invalid = validate(input);
  if (invalid) return { status: "unverified", binding: null, evaluated_at: null, window: null, churchTimeZone: null,
    findings: [], uncertainties: [{ code: invalid, scope_id: null, subject_id: null, label: "Worth a look" }], unchecked_scope_ids: [], checked_scopes: [] };
  const result: OperationsResult = { status: "checked-scope-clear", binding: input.binding, evaluated_at: input.evaluated_at,
    window: input.window, churchTimeZone: input.churchTimeZone, findings: [], uncertainties: [], unchecked_scope_ids: [], checked_scopes: [] };
  const report = (code: IssueCode, scope_id: string | null, subject_id: string | null) => {
    result.uncertainties.push({ code, scope_id, subject_id, label: "Worth a look" });
  };
  const scopes = checkScopes(input, report);
  input = checkRows(input, scopes, report);
  const checked_scopes = scopes.evidence.filter(s => scopes.usable.has(s.scope_id)).sort((a, b) => compare(a.scope_id, b.scope_id));
  result.checked_scopes = checked_scopes;
  for (const r of input.required_scopes.filter(r => r.kind === "room-rule" && r.target.kind === "room")) {
    const rule = input.room_rules.find(rule => r.target.kind === "room" && rule.resource_id === r.target.resource_id && scopes.matches(rule.scope_id, "room-rule", r.target));
    if (!rule || rule.exclusive === null || rule.additional_setup_minutes === null) report("unknown-rule", r.scope_id, r.target.kind === "room" ? r.target.resource_id : null);
  }
  for (const b of input.bookings) if (b.status !== "cancelled" && b.status !== "declined" && (!b.interval || b.status === "unknown")) report("unknown-booking", b.scope_id, b.booking_id);
  const bookings = [...input.bookings.filter(b => b.status !== "cancelled" && b.status !== "declined")].sort((a, b) => compare(a.resource_id, b.resource_id) || compare(a.booking_id, b.booking_id));
  for (let i = 0; i < bookings.length; i++) for (let j = i + 1; j < bookings.length; j++) {
    const a = bookings[i]!, b = bookings[j]!;
    if (a.resource_id !== b.resource_id || !a.interval || !b.interval) continue;
    const target = { kind: "room" as const, resource_id: a.resource_id };
    if (!scopes.matches(a.scope_id, "bookings", target) || !scopes.matches(b.scope_id, "bookings", target)) continue;
    const rule = input.room_rules.find(r => r.resource_id === a.resource_id && scopes.matches(r.scope_id, "room-rule", target)) ?? null;
    const additional = rule?.additional_setup_minutes ?? 0;
    let start = Math.max(ms(a.interval.starts_at) - additional * 60000, ms(b.interval.starts_at) - additional * 60000);
    const end = Math.min(ms(a.interval.ends_at), ms(b.interval.ends_at));
    if (start >= end || end <= ms(input.window.starts_at) || start >= ms(input.window.ends_at)) continue;
    const resolutions = input.resolutions.filter(r => r.resource_id === a.resource_id && scopes.matches(r.scope_id, "room-resolutions", target) && r.booking_ids.includes(a.booking_id) && r.booking_ids.includes(b.booking_id));
    resolutions.sort((a, b) => compare(canonical(a), canonical(b)));
    const resolutionAt = (intervalStart: number) => {
      const intersecting = resolutions.filter(r => ms(r.interval.starts_at) < end && ms(r.interval.ends_at) > intervalStart);
      return new Set(intersecting.map(r => r.state)).size === 1 ? intersecting.find(r => ms(r.interval.starts_at) <= intervalStart && ms(r.interval.ends_at) >= end) ?? null : null;
    };
    let resolution = resolutionAt(start);
    if (resolution?.state === "shared" || resolution?.state === "resolved") continue;
    const confirmed = rule?.exclusive === true && rule.additional_setup_minutes !== null && resolution?.state === "unresolved" && a.status !== "unknown" && b.status !== "unknown";
    if (!confirmed) {
      if (!rule || rule.exclusive !== true || rule.additional_setup_minutes === null)
        report("unknown-rule", input.required_scopes.find(s => s.kind === "room-rule" && s.target.kind === "room" && s.target.resource_id === a.resource_id)?.scope_id ?? null, a.resource_id);
      if (resolution?.state !== "unresolved")
        report("unknown-resolution", input.required_scopes.find(s => s.kind === "room-resolutions" && s.target.kind === "room" && s.target.resource_id === a.resource_id)?.scope_id ?? null, a.resource_id);
      start = Math.max(ms(a.interval.starts_at), ms(b.interval.starts_at));
      if (start >= end || end <= ms(input.window.starts_at) || start >= ms(input.window.ends_at)) continue;
      resolution = resolutionAt(start);
      if (resolution?.state === "shared" || resolution?.state === "resolved") continue;
    }
    const buffer = confirmed ? additional : 0;
    const finding: RoomFinding = { kind: "room-overlap", finding_id: JSON.stringify([input.binding.workspace_id, input.binding.organization_id, input.binding.access_epoch, "room", a.resource_id, a.booking_id, b.booking_id]),
      label: confirmed ? "Room use needs review" : "Worth a look", certainty: confirmed ? "confirmed" : "uncertain", resource_id: a.resource_id,
      bookings: [a, b].map(x => ({ booking_id: x.booking_id, status: x.status, original: x.interval!,
        effective: { starts_at: iso(ms(x.interval!.starts_at) - buffer * 60000), ends_at: iso(ms(x.interval!.ends_at)) } })),
      overlap: { starts_at: iso(start), ends_at: iso(end) }, additional_setup_minutes: buffer,
      rule, resolution, evidence: checked_scopes.filter(s => s.target.kind === "room" && s.target.resource_id === a.resource_id),
      next_action: "Review these room bookings in your church tools." };
    result.findings.push(finding);
  }
  for (const card of input.cards) {
    const target = { kind: "step" as const, workflow_id: card.workflow_id, step_id: card.step_id };
    const facts = [[card.scope_id, "cards"], [card.lifecycle.scope_id, "card-state"], [card.assignment.scope_id, "assignments"], [card.due.scope_id, "due"], [card.snooze.scope_id, "snooze"]] as const;
    if (!facts.every(([id, kind]) => scopes.matches(id, kind, target))) continue;
    const subject = JSON.stringify([card.workflow_id, card.step_id, card.card_id]);
    if (card.lifecycle.value.state === "unknown" || card.lifecycle.value.readiness === "unknown" || card.lifecycle.value.current_step_id !== card.step_id ||
      card.assignment.value === "unknown" || card.due.value === null || card.snooze.value.state === "unknown" ||
      (card.snooze.value.state === "unsnoozed" && card.snooze.value.until !== null) || (card.snooze.value.state === "snoozed" && card.snooze.value.until === null)) {
      report("unknown-card", card.scope_id, subject); continue;
    }
    if (card.snooze.value.state === "snoozed" && ms(card.snooze.value.until!) <= ms(input.evaluated_at)) {
      report("snooze-recheck", card.snooze.scope_id, subject); continue;
    }
    if (card.lifecycle.value.state !== "active" || card.lifecycle.value.readiness !== "ready" || card.lifecycle.value.current_step_id !== card.step_id ||
      card.assignment.value !== "unassigned" || !card.due.value || ms(card.due.value) >= ms(input.evaluated_at) || card.snooze.value.state !== "unsnoozed" || card.snooze.value.until !== null) continue;
    result.findings.push({ kind: "unowned-overdue", finding_id: JSON.stringify([input.binding.workspace_id, input.binding.organization_id, input.binding.access_epoch, "follow-up", card.workflow_id, card.step_id, card.card_id]),
      certainty: "confirmed", label: "Follow-up needs an owner", workflow_id: card.workflow_id, step_id: card.step_id, card_id: card.card_id,
      due_at: card.due.value, lifecycle: card.lifecycle.value, assignment: "unassigned", snooze: card.snooze.value,
      evidence: checked_scopes.filter(s => s.target.kind === "step" && s.target.workflow_id === card.workflow_id && s.target.step_id === card.step_id),
      next_action: "Choose who will handle this follow-up in your church tools." });
  }
  result.findings.sort((a, b) => compare(a.finding_id, b.finding_id));
  result.uncertainties = [...new Map(result.uncertainties.map(u => [canonical(u), u])).values()].sort((a, b) => compare(canonical(a), canonical(b)));
  if (result.findings.length > 2144 || result.uncertainties.length > 4096) return { status: "unverified", binding: null, evaluated_at: null, window: null, churchTimeZone: null,
    findings: [], uncertainties: [{ code: "limit-exceeded", scope_id: null, subject_id: null, label: "Worth a look" }], unchecked_scope_ids: [], checked_scopes: [] };
  result.unchecked_scope_ids = [...scopes.unchecked].sort(compare);
  result.status = result.uncertainties.length ? "unverified" : result.findings.length ? "findings" : "checked-scope-clear";
  return copy(result);
}
