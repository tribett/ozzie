import { evaluateCoverage, type CoverageInput, type CoverageScope, type PositionAssessment, type CoveragePosition, type ServingAssignment, type ServingInterval } from "./coverage.js";

export interface SundayScope {
  workspace_id: string; service_type_id: string; plan_id: string; sunday: string;
}
export interface CoverageAccess { allowed: boolean; authorization_id: string; scope: SundayScope }
export type FindingKind = "remaining-need" | "required-lead" | "role-mapping";
export interface CoverageFacts {
  remaining_need: number | null;
  lead: "not-required" | "confirmed" | "missing" | "unverified";
  mapping: "required" | "not-required" | "unknown";
  interval: ServingInterval | null;
  assignments: { assignment_id: string; status: ServingAssignment["status"]; intervals: ServingInterval[] }[];
}
export interface ManualDisposition {
  choice: "intentional-exception" | "covered-outside-pco";
  reason: string; actor_id: string; recorded_at: string;
}
export interface CoverageFinding {
  id: string; team_id: string; position_id: string; kind: FindingKind;
  status: "attention" | "resolved-by-you" | "source-confirmed" | "worth-a-look";
  label: "Needs your attention" | "Resolved by you" | "Source-confirmed" | "Worth a look" | "Role requirement checked";
  facts: CoverageFacts; history: (ManualDisposition & { facts: CoverageFacts; evidence: CoverageFinding["evidence"] })[];
  evidence: { evaluated_at: string; scopes: CoverageScope[] } | null;
  change: { reasons: ChangeReason[]; before: CoverageFacts | null; after: CoverageFacts } | null;
}
type ChangeReason = "remaining-need-increased" | "assignment-declined" | "required-lead-coverage-lost" | "requirement-interval-changed" | "requirement-added";
interface RefreshRequest { request_id: string; generation: number; origin: "on-demand" | "automatic" }
export interface CoverageState {
  version: 1; scope: SundayScope; authorization_id: string;
  generation: number; pending: RefreshRequest | null; findings: CoverageFinding[];
  required_scope_ids: string[];
  source_clocks: { scope_id: string; check_time: string }[];
  checked_positions: { team_id: string; position_id: string; facts: CoverageFacts }[];
  verification: { status: "unverified" | "verified"; observed_at: string | null;
    last_successful_check_time: string | null; issues: { code: string; scope_id: string | null; position_id: string | null }[] };
}
type Scoped = { scope: SundayScope };
export type CoverageEvent = Scoped & (
  | ({ type: "refresh-requested" } & RefreshRequest)
  | { type: "refresh-cancelled"; request_id: string; generation: number }
  | { type: "observation-received"; request_id: string; generation: number; input: CoverageInput }
  | ({ type: "disposition-recorded"; finding_id: string } & ManualDisposition)
);
export type CoverageTransition =
  | { status: "applied"; code: "created" | "requested" | "observed" | "disposed" | "cancelled"; state: CoverageState }
  | { status: "ignored"; code: "obsolete"; state: CoverageState }
  | { status: "rejected"; code: "invalid" | "unauthorized"; state: null };
const sameScope = (a: SundayScope, b: SundayScope) =>
  a.workspace_id === b.workspace_id && a.service_type_id === b.service_type_id && a.plan_id === b.plan_id && a.sunday === b.sunday;
const rejected = (code: "invalid" | "unauthorized"): CoverageTransition => ({ status: "rejected", code, state: null });
const sourceLabel = (kind: FindingKind, facts: CoverageFacts): CoverageFinding["label"] =>
  kind === "role-mapping" || (kind === "required-lead" && facts.mapping === "not-required")
    ? "Role requirement checked" : "Source-confirmed";

// Closed JSON values keep untyped callers, accessors and undeclared payloads out of state.
// This is a local boundary, not authentication or protection from a hostile JS host.
type Check = (v: unknown) => boolean;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const shape = (fields: Record<string, Check>): Check => v => object(v) &&
  Object.keys(v).length === Object.keys(fields).length && Object.entries(fields).every(([k, check]) => check(v[k]));
const oneOf = (...values: unknown[]): Check => v => values.includes(v);
const nullable = (check: Check): Check => v => v === null || check(v);
const list = (check: Check): Check => v => Array.isArray(v) && v.length <= 2000 && v.every(check);
const text = (max: number): Check => v => typeof v === "string" && v.length <= max && !!v.trim();
const identity: Check = v => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const integer: Check = v => Number.isSafeInteger(v) && (v as number) >= 0;
function calendarDate(v: unknown): boolean {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number);
  return y! >= 1000 && m! >= 1 && m! <= 12 && d! >= 1 && d! <= new Date(Date.UTC(y!, m!, 0)).getUTCDate();
}
function clock(v: unknown): boolean {
  if (typeof v !== "string") return false;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(v);
  return !!match && calendarDate(match[1]) && +match[2]! <= 23 && +match[3]! <= 59 && +match[4]! <= 59 &&
    (match[5] === "Z" || (+match[5]!.slice(1, 3) <= 23 && +match[5]!.slice(4) <= 59)) && Number.isFinite(Date.parse(v));
}
const scopeCheck = shape({ workspace_id: identity, service_type_id: identity, plan_id: identity,
  sunday: v => calendarDate(v) && new Date(`${v}T00:00:00Z`).getUTCDay() === 0 });
const accessCheck = shape({ allowed: v => typeof v === "boolean", authorization_id: identity, scope: scopeCheck });
const rawIntervalCheck = shape({ starts_at: text(64), ends_at: text(64) });
const intervalCheck = shape({ starts_at: clock, ends_at: clock });
const completenessCheck = oneOf("complete", "partial", "stale", "denied", "unreadable", "unverified");
const sourceScopeCheck = shape({ scope_id: identity, source: text(256), check_time: clock, valid_until: clock, completeness: completenessCheck });
const assignmentStatus = oneOf("C", "U", "D", "cancelled", "unknown");
const mappingCheck = oneOf("required", "not-required", "unknown");
const observedCheck = (value: Check) => shape({ scope_id: identity, value });
const assignmentCheck = shape({ assignment_id: identity, status: assignmentStatus, notification: oneOf("sent", "unsent", "unknown"),
  intervals: list(rawIntervalCheck), time_semantics: oneOf("verified", "unverified") });
const candidateCheck = shape({ person_id: identity, membership: observedCheck(oneOf(true, false, null)), eligibility: observedCheck(oneOf(true, false, null)),
  availability: observedCheck(oneOf("available", "unavailable", "unknown")), blockouts: observedCheck(nullable(list(rawIntervalCheck))),
  assignments: observedCheck(list(assignmentCheck)) });
const inputCheck = shape({ evaluated_at: clock, required_scope_ids: list(identity), scopes: list(sourceScopeCheck),
  positions: list(shape({ position_id: identity, team_id: identity, interval: nullable(rawIntervalCheck),
    remaining_need: observedCheck(nullable(v => typeof v === "number" && Number.isFinite(v))),
    lead: observedCheck(shape({ mapping: mappingCheck, assignment_ids: list(identity) })),
    assignments: observedCheck(list(assignmentCheck)), candidates: list(candidateCheck) })) });
const factsCheck = shape({ remaining_need: nullable(integer), lead: oneOf("not-required", "confirmed", "missing", "unverified"), mapping: mappingCheck,
  interval: nullable(intervalCheck), assignments: list(shape({ assignment_id: identity, status: assignmentStatus, intervals: list(intervalCheck) })) });
const evidenceCheck = nullable(shape({ evaluated_at: clock, scopes: list(sourceScopeCheck) }));
const dispositionFields = { choice: oneOf("intentional-exception", "covered-outside-pco"), reason: text(1000), actor_id: identity, recorded_at: clock };
const requestFields = { request_id: identity, generation: (v: unknown) => integer(v) && v !== 0 };
const requestCheck = shape({ ...requestFields, origin: oneOf("on-demand", "automatic") });
const findingCheck = shape({ id: text(1100), team_id: identity, position_id: identity, kind: oneOf("remaining-need", "required-lead", "role-mapping"),
  status: oneOf("attention", "resolved-by-you", "source-confirmed", "worth-a-look"),
  label: oneOf("Needs your attention", "Resolved by you", "Source-confirmed", "Worth a look", "Role requirement checked"), facts: factsCheck,
  history: list(shape({ ...dispositionFields, facts: factsCheck, evidence: evidenceCheck })), evidence: evidenceCheck,
  change: nullable(shape({ reasons: list(oneOf("remaining-need-increased", "assignment-declined", "required-lead-coverage-lost", "requirement-interval-changed", "requirement-added")),
    before: nullable(factsCheck), after: factsCheck })) });
const stateCheck = shape({ version: oneOf(1), scope: scopeCheck, authorization_id: identity, generation: integer,
  pending: nullable(requestCheck), findings: list(findingCheck), required_scope_ids: list(identity),
  source_clocks: list(shape({ scope_id: identity, check_time: clock })),
  checked_positions: list(shape({ team_id: identity, position_id: identity, facts: factsCheck })),
  verification: shape({ status: oneOf("unverified", "verified"), observed_at: nullable(clock), last_successful_check_time: nullable(clock),
    issues: list(shape({ code: oneOf("scope-unverified", "observation-unverified", "positions-unverified", "lead-unverified", "candidate-unverified",
      "time-unverified", "need-unverified", "assignment-unverified", "position-missing", "position-duplicate", "requirement-interval-changed"),
    scope_id: nullable(identity), position_id: nullable(identity) })) }) });
function eventCheck(v: unknown): boolean {
  if (!object(v)) return false;
  const base = { type: oneOf(v.type), scope: scopeCheck };
  switch (v.type) {
    case "refresh-requested": return shape({ ...base, ...requestFields, origin: oneOf("on-demand", "automatic") })(v);
    case "refresh-cancelled": return shape({ ...base, ...requestFields })(v);
    case "observation-received": return shape({ ...base, ...requestFields, input: inputCheck })(v);
    case "disposition-recorded": return shape({ ...base, finding_id: text(1100), ...dispositionFields })(v);
    default: return false;
  }
}
function copyJson(v: unknown, depth = 0, seen = new Set<object>(), budget = { units: 0 }): unknown {
  budget.units += typeof v === "string" ? v.length : 1;
  if (budget.units > 1_048_576) throw new Error("invalid");
  if (v === null || typeof v === "boolean" || typeof v === "string" || (typeof v === "number" && Number.isFinite(v))) return v;
  if (!v || typeof v !== "object" || depth > 24 || seen.has(v)) throw new Error("invalid");
  if (Object.getPrototypeOf(v) !== (Array.isArray(v) ? Array.prototype : Object.prototype)) throw new Error("invalid");
  if (Array.isArray(v) && (v.length > 2000 || Object.keys(v).length !== v.length)) throw new Error("invalid");
  seen.add(v);
  const entries = Object.entries(Object.getOwnPropertyDescriptors(v));
  if (Reflect.ownKeys(v).length !== entries.length || entries.length > 2001) throw new Error("invalid");
  const out: Record<string, unknown> = {};
  const array: unknown[] = [];
  for (const [key, descriptor] of entries) {
    if (!Object.hasOwn(descriptor, "value") || key === "__proto__") throw new Error("invalid");
    if (Array.isArray(v) && key === "length") continue;
    if (Array.isArray(v) && !/^(0|[1-9]\d*)$/.test(key)) throw new Error("invalid");
    const value = copyJson(descriptor.value, depth + 1, seen, budget);
    if (Array.isArray(v)) array[Number(key)] = value;
    else out[key] = value;
  }
  seen.delete(v);
  return Array.isArray(v) ? array : out;
}
function checked<T>(v: unknown, check: Check): T {
  const copy = copyJson(v);
  if (JSON.stringify(copy).length > 1_048_576 || !check(copy)) throw new Error("invalid");
  return copy as T;
}
function stateInvariants(state: CoverageState): boolean {
  return (!state.pending || state.pending.generation === state.generation) &&
    new Set(state.findings.map(f => f.id)).size === state.findings.length &&
    state.findings.every(f => f.id === findingId(state.scope, f.team_id, f.position_id, f.kind) &&
      (f.status !== "resolved-by-you" || f.history.length > 0) && f.label === (
        f.status === "attention" ? "Needs your attention" : f.status === "resolved-by-you" ? "Resolved by you" :
        f.status === "worth-a-look" ? "Worth a look" : sourceLabel(f.kind, f.facts))) &&
    new Set(state.checked_positions.map(p => JSON.stringify([p.team_id, p.position_id]))).size === state.checked_positions.length &&
    new Set(state.source_clocks.map(s => s.scope_id)).size === state.source_clocks.length;
}
function sealed(result: CoverageTransition): CoverageTransition {
  if (result.state) {
    checked(result.state, stateCheck);
    if (!stateInvariants(result.state)) throw new Error("invalid");
    result.state.findings.sort((a, b) => a.id.localeCompare(b.id));
  }
  const freeze = (v: unknown): void => {
    if (!v || typeof v !== "object" || Object.isFrozen(v)) return;
    for (const value of Object.values(v)) freeze(value);
    Object.freeze(v);
  };
  freeze(result);
  return result;
}
const findingId = (scope: SundayScope, team: string, position: string, kind: FindingKind) =>
  JSON.stringify([scope.workspace_id, scope.service_type_id, scope.plan_id, scope.sunday, team, position, kind]);
const normalizeInterval = (v: ServingInterval): ServingInterval => ({
  starts_at: new Date(v.starts_at).toISOString(), ends_at: new Date(v.ends_at).toISOString(),
});
function factsFor(p: PositionAssessment, raw: CoveragePosition): CoverageFacts {
  return { remaining_need: p.remaining_need, lead: p.lead, mapping: raw.lead.value.mapping,
    interval: raw.interval && normalizeInterval(raw.interval),
    assignments: raw.assignments.value.map(a => ({ assignment_id: a.assignment_id, status: a.status,
      intervals: a.intervals.filter(t => clock(t.starts_at) && clock(t.ends_at))
        .map(normalizeInterval).sort((a, b) => a.starts_at.localeCompare(b.starts_at) || a.ends_at.localeCompare(b.ends_at)),
    })).sort((a, b) => a.assignment_id.localeCompare(b.assignment_id)) };
}
function updateFinding(state: CoverageState, p: PositionAssessment, kind: FindingKind, facts: CoverageFacts,
  evidence: CoverageFinding["evidence"], problem: boolean, clear: boolean): void {
  const id = findingId(state.scope, p.team_id, p.position_id, kind);
  let finding = state.findings.find(f => f.id === id);
  const before = finding?.facts ?? state.checked_positions.find(old => old.position_id === p.position_id && old.team_id === p.team_id)?.facts ?? null;
  const reasons: ChangeReason[] = [];
  if (problem && kind !== "role-mapping") {
    if (!before && state.checked_positions.length) reasons.push("requirement-added");
    if (before) {
      if (JSON.stringify(before.interval) !== JSON.stringify(facts.interval)) reasons.push("requirement-interval-changed");
      if (kind === "remaining-need") {
        if (facts.remaining_need! > before.remaining_need!) reasons.push("remaining-need-increased");
        if (before.assignments.some(old => (old.status === "C" || old.status === "U") && before.interval &&
            old.intervals.some(t => Date.parse(t.starts_at) < Date.parse(before.interval!.ends_at) && Date.parse(before.interval!.starts_at) < Date.parse(t.ends_at)) &&
            facts.assignments.some(next => next.assignment_id === old.assignment_id && (next.status === "D" || next.status === "cancelled"))))
          reasons.push("assignment-declined");
      }
      if (kind === "required-lead") {
        if (before.lead === "confirmed") reasons.push("required-lead-coverage-lost");
        else if (before.mapping !== "required") reasons.push("requirement-added");
      }
    }
  }
  if (!finding) {
    if (!problem) return;
    finding = { id, team_id: p.team_id, position_id: p.position_id, kind,
      status: kind === "role-mapping" ? "worth-a-look" : "attention",
      label: kind === "role-mapping" ? "Worth a look" : "Needs your attention", facts, history: [], evidence,
      change: reasons.length ? { reasons, before, after: facts } : null };
    state.findings.push(finding);
    return;
  }
  if (reasons.length) {
    finding.change = { reasons, before, after: facts };
    finding.status = "attention"; finding.label = "Needs your attention";
  }
  finding.facts = facts;
  finding.evidence = evidence;
  if (problem && kind === "role-mapping" && finding.status === "source-confirmed") {
    finding.status = "worth-a-look"; finding.label = "Worth a look";
  }
  if (clear) {
    finding.status = "source-confirmed";
    finding.label = sourceLabel(kind, facts);
  }
}

/** Pure local values only. Access must come from the host's current authorization. */
export function createCoverageState(access: CoverageAccess): CoverageTransition {
  try { access = checked(access, accessCheck); } catch { return rejected("invalid"); }
  if (!access.allowed) return rejected("unauthorized");
  return sealed({ status: "applied", code: "created", state: { version: 1, scope: { ...access.scope },
    authorization_id: access.authorization_id, generation: 0, pending: null, findings: [], required_scope_ids: [], source_clocks: [], checked_positions: [],
    verification: { status: "unverified", observed_at: null, last_successful_check_time: null, issues: [] } } });
}

/** The authorized current state is the ONLY output that contains private reasons. */
export function transitionCoverage(previous: CoverageState, access: CoverageAccess, event: CoverageEvent): CoverageTransition {
  try {
    access = checked(access, accessCheck);
    if (!access.allowed) return rejected("unauthorized");
    // Inspect only data descriptors for scope/authorization before touching private history.
    const oldScope = checked<SundayScope>(Object.getOwnPropertyDescriptor(previous, "scope")?.value, scopeCheck);
    const oldAuthorization = Object.getOwnPropertyDescriptor(previous, "authorization_id")?.value;
    const eventScope = checked<SundayScope>(Object.getOwnPropertyDescriptor(event, "scope")?.value, scopeCheck);
    if (oldAuthorization !== access.authorization_id || !sameScope(oldScope, access.scope) || !sameScope(eventScope, access.scope))
      return rejected("unauthorized");
    previous = checked(previous, stateCheck);
    if (!stateInvariants(previous)) return rejected("invalid");
    event = checked(event, eventCheck);
    return sealed(applyTransition(previous, access, event));
  } catch { return rejected("invalid"); }
}
function applyTransition(previous: CoverageState, access: CoverageAccess, event: CoverageEvent): CoverageTransition {
  if (!access.allowed || access.authorization_id !== previous.authorization_id || !sameScope(previous.scope, access.scope) ||
      !sameScope(event.scope, access.scope)) return rejected("unauthorized");
  const state = structuredClone(previous);
  if (event.type === "refresh-requested") {
    if (event.generation <= state.generation) return { status: "ignored", code: "obsolete", state };
    state.generation = event.generation;
    state.pending = { request_id: event.request_id, generation: event.generation, origin: event.origin };
    return { status: "applied", code: "requested", state };
  }
  if (event.type === "disposition-recorded") {
    const finding = state.findings.find(f => f.id === event.finding_id);
    if (!finding || !event.reason.trim() || finding.kind === "role-mapping" ||
        !["attention", "resolved-by-you"].includes(finding.status)) return rejected("invalid");
    finding.status = "resolved-by-you";
    finding.label = "Resolved by you";
    finding.history.push({ choice: event.choice, reason: event.reason, actor_id: event.actor_id, recorded_at: event.recorded_at,
      facts: finding.facts, evidence: finding.evidence });
    state.pending = null;
    return { status: "applied", code: "disposed", state };
  }
  if (!state.pending || event.generation !== state.pending.generation || event.request_id !== state.pending.request_id)
    return { status: "ignored", code: "obsolete", state };
  if (event.type === "observation-received" && (
      (state.verification.observed_at !== null && Date.parse(event.input.evaluated_at) < Date.parse(state.verification.observed_at)) ||
      state.source_clocks.some(old => event.input.scopes.some(next => next.scope_id === old.scope_id && Date.parse(next.check_time) < Date.parse(old.check_time)))))
    return { status: "ignored", code: "obsolete", state };
  state.pending = null;
  if (event.type === "refresh-cancelled") return { status: "applied", code: "cancelled", state };
  const result = evaluateCoverage(event.input);
  const issues = result.issues.map(({ code, scope_id, position_id }) => ({ code, scope_id, position_id }));
  const positionKeys = new Set<string>();
  for (const p of result.positions) {
    const key = JSON.stringify([p.team_id, p.position_id]);
    if (positionKeys.has(key)) issues.push({ code: "position-duplicate", scope_id: null, position_id: p.position_id });
    positionKeys.add(key);
  }
  for (const id of state.required_scope_ids) if (!event.input.required_scope_ids.includes(id))
    issues.push({ code: "scope-unverified", scope_id: id, position_id: null });
  for (const finding of [...state.findings, ...state.checked_positions]) if (!result.positions.some(p => p.position_id === finding.position_id && p.team_id === finding.team_id))
    issues.push({ code: "position-missing", scope_id: null, position_id: finding.position_id });
  for (const finding of state.findings.filter(f => !issues.length && f.kind !== "role-mapping")) {
    const p = result.positions.find(p => p.position_id === finding.position_id && p.team_id === finding.team_id);
    const raw = event.input.positions.find(p => p.position_id === finding.position_id && p.team_id === finding.team_id);
    if (p && raw && ((finding.kind === "remaining-need" && p.remaining_need === 0) ||
        (finding.kind === "required-lead" && p.lead === "confirmed")) &&
        JSON.stringify(finding.facts.interval) !== JSON.stringify(raw.interval && normalizeInterval(raw.interval)))
      issues.push({ code: "requirement-interval-changed", scope_id: null, position_id: finding.position_id });
  }
  state.required_scope_ids = [...new Set([...state.required_scope_ids, ...event.input.required_scope_ids])].sort();
  state.verification.observed_at = result.evaluated_at;
  state.verification.issues = [...new Map(issues.map(i => [JSON.stringify(i), i])).entries()]
    .sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
  state.verification.status = issues.length ? "unverified" : "verified";
  if (issues.length) {
    // Missing mapping is uncertainty, never evidence that confirmed leadership was lost.
    for (const p of result.positions) {
      const raw = event.input.positions.find(v => v.position_id === p.position_id && v.team_id === p.team_id)!;
      if (raw.lead.value.mapping === "unknown" && issues.every(i => i.code === "lead-unverified"))
        updateFinding(state, p, "role-mapping", factsFor(p, raw), null, true, false);
    }
    return { status: "applied", code: "observed", state };
  }
  const scopes = result.scopes.filter(s => state.required_scope_ids.includes(s.scope_id)).sort((a, b) => a.scope_id.localeCompare(b.scope_id));
  state.source_clocks = scopes.map(({ scope_id, check_time }) => ({ scope_id, check_time }));
  state.verification.last_successful_check_time = scopes.reduce((oldest, s) =>
    Date.parse(s.check_time) < Date.parse(oldest) ? s.check_time : oldest, scopes[0]!.check_time);
  for (const p of result.positions) {
    const evidence = { evaluated_at: result.evaluated_at, scopes };
    const facts = factsFor(p, event.input.positions.find(v => v.position_id === p.position_id && v.team_id === p.team_id)!);
    updateFinding(state, p, "remaining-need", facts, evidence, p.remaining_need! > 0, p.remaining_need === 0);
    updateFinding(state, p, "required-lead", facts, evidence, p.lead === "missing", p.lead === "confirmed" || p.lead === "not-required");
    updateFinding(state, p, "role-mapping", facts, evidence, false, true);
  }
  state.findings.sort((a, b) => a.id.localeCompare(b.id));
  state.checked_positions = result.positions.map(p => ({ team_id: p.team_id, position_id: p.position_id,
    facts: factsFor(p, event.input.positions.find(v => v.position_id === p.position_id && v.team_id === p.team_id)!) }))
    .sort((a, b) => a.team_id.localeCompare(b.team_id) || a.position_id.localeCompare(b.position_id));
  return { status: "applied", code: "observed", state };
}
