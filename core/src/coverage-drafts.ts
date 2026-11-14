import { evaluateCoverage, type ServingInterval } from "./coverage.js";
import type { SundayScope } from "./coverage-state.js";
import type { DraftRequest, DraftReviewResult, DraftReviewState, DraftOutline, DraftSelection, DraftFacts, DraftDifference, DraftSource, DraftAccess, DraftFreshness } from "./coverage-draft-types.js";
export type * from "./coverage-draft-types.js";

const normalizedInterval = (v: ServingInterval) => ({
  starts_at: new Date(v.starts_at).toISOString(), ends_at: new Date(v.ends_at).toISOString(),
});
function formattedInterval(v: ServingInterval, zone: string): string {
  const format = (at: string) => {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "longOffset" }).formatToParts(new Date(at));
    const part = (name: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === name)!.value;
    const milliseconds = new Date(at).getUTCMilliseconds();
    const fraction = milliseconds ? `.${String(milliseconds).padStart(3, "0")}` : "";
    return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}:${part("second")}${fraction} ${part("timeZoneName")}`;
  };
  return `${format(v.starts_at)} – ${format(v.ends_at)} (${zone})`;
}
function outline(request: DraftRequest, position_id: string, selection: DraftSelection): DraftOutline {
  const { source, access } = request;
  const result = evaluateCoverage({ ...source.input, evaluated_at: access.now });
  const raw = source.input.positions.find(p => p.position_id === position_id);
  const p = result.positions.find(p => p.position_id === position_id);
  const label = source.labels.find(p => p.position_id === position_id);
  const usable = (scope_id: string): boolean => source.input.required_scope_ids.includes(scope_id) &&
    result.scopes.some(s => s.scope_id === scope_id && s.completeness === "complete" && Date.parse(s.check_time) <= Date.parse(access.now) &&
      Date.parse(s.valid_until) >= Date.parse(access.now));
  const referenced = new Set(source.input.required_scope_ids);
  if (label) { referenced.add(label.ministry.scope_id); referenced.add(label.role.scope_id); }
  for (const candidate of raw?.candidates ?? []) {
    for (const fact of [candidate.membership, candidate.eligibility, candidate.availability, candidate.blockouts, candidate.assignments]) referenced.add(fact.scope_id);
  }
  const unchecked = [...referenced].filter(id => !usable(id)).sort();
  if (!label || !usable(label.ministry.scope_id) || !usable(label.role.scope_id)) result.issues.push({
    code: "labels-unverified", scope_id: null, position_id, person_id: null,
    message: "Some coverage couldn't be verified: source-backed ministry or role labels are missing or unchecked.",
  });
  if (!raw) result.issues.push({ code: "position-missing", scope_id: null, position_id, person_id: null,
    message: "Some coverage couldn't be verified: the selected position is absent from this observation." });
  if (Date.parse(source.input.evaluated_at) > Date.parse(access.now)) result.issues.push({
    code: "evaluation-unverified", scope_id: null, position_id, person_id: null,
    message: "Some coverage couldn't be verified: the source evaluation is later than the current check.",
  });
  const targetInterval = raw?.interval && validInterval(raw.interval) ? normalizedInterval(raw.interval) : null;
  const candidates = (p?.candidates ?? []).map(c => ({ ...c,
    ...source.identities.find(i => i.person_id === c.person_id)!,
    observation: raw!.candidates.find(i => i.person_id === c.person_id)!,
  })).sort((a, b) => a.display_name.localeCompare(b.display_name, "en-US") || a.person_id.localeCompare(b.person_id, "en-US"));
  const recipients: DraftFacts["recipients"] = selection.person_ids.flatMap<DraftFacts["recipients"][number]>(id => {
    if (selection.purpose === "escalation") {
      const leader = source.leaders.find(l => l.person_id === id && l.team_id === p?.team_id);
      const identity = source.identities.find(i => i.person_id === id);
      if (!leader || !identity) return [];
      const qualified = leaderQualified(request, position_id, id);
      return [{ ...identity, disposition: qualified ? "leader" : "unverified", membership: null, eligibility: leader.authority.value,
        availability: null, blockouts: null, assignments: [], reasons: [qualified
          ? "Ministry leadership is an explicit source observation; Sunday presence is not established."
          : "Ministry leadership couldn't be verified for this selection."] }];
    }
    const c = candidates.find(c => c.person_id === id);
    if (!c) return [];
    return [{ person_id: id, display_name: c.display_name, disposition: c.disposition,
      membership: c.observation.membership.value, eligibility: c.observation.eligibility.value,
      availability: c.observation.availability.value, blockouts: canonicalIntervals(c.observation.blockouts.value?.filter(v => relevant(v, targetInterval)) ?? null),
      assignments: c.observation.assignments.value.filter(a => a.status !== "D" && a.status !== "cancelled" &&
        (a.time_semantics !== "verified" || !a.intervals.length || a.intervals.some(v => relevant(v, targetInterval))))
        .map(a => ({ ...a, intervals: canonicalIntervals(a.intervals)! }))
        .sort((a, b) => a.assignment_id.localeCompare(b.assignment_id, "en-US")), reasons: [...c.reasons].sort() }];
  });
  recipients.sort((a, b) => a.display_name.localeCompare(b.display_name, "en-US") || a.person_id.localeCompare(b.person_id, "en-US"));
  if (recipients.length !== selection.person_ids.length) result.issues.push({
    code: "recipient-missing", scope_id: null, position_id, person_id: null,
    message: "Some coverage couldn't be verified: a selected recipient is absent from the current source evidence.",
  });
  const verified = !!raw && !!label && !!targetInterval && source.input.required_scope_ids.length > 0 && !unchecked.length &&
    Date.parse(source.input.evaluated_at) <= Date.parse(access.now) && usable(label.ministry.scope_id) && usable(label.role.scope_id) &&
    !result.issues.some(i => i.code !== "candidate-unverified");
  return {
    facts: { target: { position_id, team_id: p?.team_id ?? "", sunday: source.scope.sunday,
      ministry: label?.ministry.value ?? "", role: label?.role.value ?? "", interval: targetInterval,
      church_timezone: source.church_timezone, formatted_interval: targetInterval && formattedInterval(targetInterval, source.church_timezone),
      remaining_need: p?.remaining_need ?? null }, recipients, purpose: selection.purpose },
    candidates, evidence: { evaluated_at: access.now, scopes: result.scopes, required_scope_ids: source.input.required_scope_ids, issues: result.issues },
    rules: ["Recorded membership, required role eligibility and affirmative availability are required.",
      "Confirmed overlaps exclude; unanswered overlaps remain possible conflicts.", "Willingness is not established."],
    unchecked_scope_ids: unchecked, verification: verified ? "verified" : "unverified",
  };
}
function validInterval(v: ServingInterval): boolean {
  return clock(v.starts_at) && clock(v.ends_at) && Date.parse(v.starts_at) < Date.parse(v.ends_at);
}
// Relevance here is ONLY for draft differences. Candidate eligibility is always evaluateCoverage's decision.
function relevant(v: ServingInterval, target: ServingInterval | null): boolean {
  return !validInterval(v) || !target || Date.parse(v.starts_at) < Date.parse(target.ends_at) && Date.parse(target.starts_at) < Date.parse(v.ends_at);
}
function canonicalIntervals(values: ServingInterval[] | null): ServingInterval[] | null {
  return values && values.map(v => validInterval(v) ? normalizedInterval(v) : { ...v })
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at) || a.ends_at.localeCompare(b.ends_at));
}
function observedFreshness(source: DraftSource, now: string, previous?: DraftFreshness): DraftFreshness {
  const times = new Map(previous?.scope_check_times.map(s => [s.scope_id, s.check_time]));
  for (const scope of source.input.scopes) {
    const prior = times.get(scope.scope_id);
    if (!prior || Date.parse(scope.check_time) > Date.parse(prior)) times.set(scope.scope_id, scope.check_time);
  }
  const required = [...new Set([...(previous?.required_scope_ids ?? []), ...source.input.required_scope_ids])].sort();
  if (times.size > 64 || required.length > 64) throw new Error("invalid");
  return {
    evaluated_at: previous && Date.parse(previous.evaluated_at) >= Date.parse(now) ? previous.evaluated_at : now,
    required_scope_ids: required,
    scope_check_times: [...times.keys()].sort().map(scope_id => ({ scope_id, check_time: times.get(scope_id)! })),
  };
}
/** Pure local review. It prepares values only; no provider/model/clipboard/write effects. */
function transition(previous: DraftReviewState | null, request: DraftRequest): DraftReviewResult {
  const event = request.event;
  if (event.type === "start") {
    const selection: DraftSelection = { purpose: "invitation", person_ids: [] };
    return { status: "applied", code: "started", state: {
      version: 1, scope: request.source.scope, authorization_id: request.access.authorization_id,
      position_id: event.position_id, selection,
      current: outline(request, event.position_id, selection), source: request.source,
      freshness: observedFreshness(request.source, request.access.now), draft: null, differences: [],
    } };
  }
  if (!previous) return { status: "rejected", code: "invalid", state: null };
  if (event.type === "cancel") return { status: "applied", code: "cancelled", state: null };
  const state = structuredClone(previous);
  const oldScopes = previous.freshness.scope_check_times;
  const regressed = Date.parse(request.access.now) < Date.parse(previous.freshness.evaluated_at) ||
    previous.freshness.required_scope_ids.some(id => !request.source.input.required_scope_ids.includes(id)) ||
    oldScopes.some(old => !request.source.input.scopes.some(next => next.scope_id === old.scope_id && Date.parse(next.check_time) >= Date.parse(old.check_time)));
  state.source = regressed ? previous.source : request.source;
  state.freshness = observedFreshness(request.source, request.access.now, previous.freshness);
  state.current = outline(request, state.position_id, state.selection);
  if (regressed) {
    state.current.verification = "unverified";
    state.current.evidence.issues.push({ code: "source-regressed", scope_id: null, position_id: state.position_id,
      person_id: null, message: "Some coverage couldn't be verified: required evidence is missing or older than the prior check." });
  }
  const refreshDifferences = () => { state.differences = state.draft ? differences(state.draft.reviewed_facts, state.current.facts) : []; };
  refreshDifferences();
  const unverified = (code: Extract<DraftReviewResult, { status: "unverified" }>["code"]): DraftReviewResult => ({ status: "unverified", code, state });
  if (event.type === "refresh") return state.current.verification === "verified"
    ? { status: "applied", code: "refreshed", state } : unverified("source-unverified");
  if (event.type === "edit") {
    if (!state.draft) return unverified("draft-missing");
    state.draft.plaintext = event.plaintext;
    // Editing remains possible while evidence is missing; it cannot reverify that evidence.
    if (state.current.verification === "verified" && previous.current.verification === "verified" &&
        equal(previous.current.facts, state.current.facts) && recipientsQualified(state, request)) state.draft.reviewed_facts = state.current.facts;
    refreshDifferences();
    return { status: "applied", code: "edited", state };
  }
  if (event.type === "select") {
    const review = outline(request, state.position_id, { purpose: "invitation", person_ids: [] });
    if (event.purpose === "escalation") {
      if (review.candidates.some(c => selectable(c.disposition)) || !event.person_ids.length || event.person_ids.some(id => !leaderQualified(request, state.position_id, id)))
        return unverified("leader-unverified");
    } else if (event.person_ids.some(id => !review.candidates.some(c => c.person_id === id && selectable(c.disposition))))
      return unverified("recipient-unverified");
    state.selection = { purpose: event.purpose, person_ids: event.person_ids };
    state.current = outline(request, state.position_id, state.selection);
    if (regressed) state.current.verification = "unverified";
    refreshDifferences();
    return { status: "applied", code: "selected", state };
  }
  if (state.current.verification !== "verified" || !(state.current.facts.target.remaining_need! > 0)) return unverified("source-unverified");
  if (!recipientsQualified(state, request)) return unverified(state.selection.purpose === "escalation" ? "leader-unverified" : "recipient-unverified");
  if ((event.type === "prepare" || event.type === "review-changes") &&
      (!equal(previous.current.facts, state.current.facts) || previous.current.verification !== "verified")) return unverified("draft-stale");
  if (event.type === "prepare") {
    const f = state.current.facts;
    if (state.draft) state.draft.reviewed_facts = f;
    else state.draft = { plaintext: f.purpose === "escalation"
      ? `Hello ${f.recipients.map(p => p.display_name).join(", ")},\n\n${f.target.ministry} still has ${f.target.remaining_need} remaining need for ${f.target.role} on Sunday ${f.target.sunday}.\nServing interval: ${f.target.formatted_interval}.\nNo qualifying member was established in the checked scope. Please review the coverage need and the checked constraints.`
      : `Hello ${f.recipients.map(p => p.display_name).join(", ")},\n\nWould you be willing to serve with ${f.target.ministry} as ${f.target.role} for Sunday ${f.target.sunday}?\nServing interval: ${f.target.formatted_interval}.\n\nPlease let me know. This invitation does not confirm availability or willingness.`,
      original_facts: f, reviewed_facts: f, original_evidence: state.current.evidence };
    refreshDifferences();
    return { status: "applied", code: "prepared", state };
  }
  if (!state.draft) return unverified("draft-missing");
  if (event.type === "review-changes") {
    state.draft.reviewed_facts = state.current.facts;
    refreshDifferences();
    return { status: "applied", code: "reviewed", state };
  }
  if (state.differences.length) return unverified("draft-stale");
  return { status: "copy-prepared", plaintext: state.draft.plaintext,
    recipients: state.current.facts.recipients.map(({ person_id, display_name }) => ({ person_id, display_name })), state };
}
const selectable = (disposition: string) => disposition === "suggestion" || disposition === "possible-conflict";
function recipientsQualified(state: DraftReviewState, request: DraftRequest): boolean {
  return state.selection.person_ids.length > 0 && state.current.facts.recipients.length === state.selection.person_ids.length &&
    (state.selection.purpose === "invitation" ? state.current.facts.recipients.every(p => selectable(p.disposition))
      : !state.current.candidates.some(c => selectable(c.disposition)) && state.selection.person_ids.every(id => leaderQualified(request, state.position_id, id)));
}
function leaderQualified(request: DraftRequest, position_id: string, person_id: string): boolean {
  const { source, access } = request;
  const position = source.input.positions.find(p => p.position_id === position_id);
  const leader = source.leaders.find(l => l.person_id === person_id && l.team_id === position?.team_id);
  return !!leader && access.leader_ids.includes(person_id) && leader.authority.value === true &&
    source.input.required_scope_ids.includes(leader.authority.scope_id) && source.input.scopes.some(s =>
      s.scope_id === leader.authority.scope_id && s.completeness === "complete" && Date.parse(s.check_time) <= Date.parse(access.now) &&
      Date.parse(access.now) <= Date.parse(s.valid_until));
}

// Closed JSON validation is deliberately local: it grants no authentication and performs no I/O.
type Check = (value: unknown) => boolean;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const shape = (fields: Record<string, Check>): Check => v => record(v) && Object.keys(v).length === Object.keys(fields).length &&
  Object.entries(fields).every(([k, check]) => Object.hasOwn(v, k) && check(v[k]));
const oneOf = (...values: unknown[]): Check => v => values.includes(v);
const nullable = (check: Check): Check => v => v === null || check(v);
const array = (check: Check, max = 2000): Check => v => Array.isArray(v) && v.length <= max && v.every(check);
const id: Check = v => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const string = (max: number): Check => v => typeof v === "string" && v.length <= max;
const labelText = (max: number): Check => v => string(max)(v) && !!(v as string).trim() && !/[\u0000-\u001f\u007f]/.test(v as string);
function calendar(v: unknown): boolean {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number);
  return y! >= 1000 && m! >= 1 && m! <= 12 && d! >= 1 && d! <= new Date(Date.UTC(y!, m!, 0)).getUTCDate();
}
function clock(v: unknown): boolean {
  if (typeof v !== "string") return false;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(v);
  return !!match && calendar(match[1]) && +match[2]! <= 23 && +match[3]! <= 59 && +match[4]! <= 59 &&
    (match[5] === "Z" || (+match[5]!.slice(1, 3) <= 23 && +match[5]!.slice(4) <= 59)) && Number.isFinite(Date.parse(v));
}
const scopeCheck = shape({ workspace_id: id, service_type_id: id, plan_id: id,
  sunday: v => calendar(v) && new Date(`${v}T00:00:00Z`).getUTCDay() === 0 });
const intervalCheck = shape({ starts_at: string(64), ends_at: string(64) });
const bool = oneOf(true, false, null);
const observation = (check: Check) => shape({ scope_id: id, value: check });
const assignmentCheck = shape({ assignment_id: id, status: oneOf("C", "U", "D", "cancelled", "unknown"),
  notification: oneOf("sent", "unsent", "unknown"), intervals: array(intervalCheck), time_semantics: oneOf("verified", "unverified") });
const candidateCheck = shape({ person_id: id, membership: observation(bool), eligibility: observation(bool),
  availability: observation(oneOf("available", "unavailable", "unknown")), blockouts: observation(nullable(array(intervalCheck))),
  assignments: observation(array(assignmentCheck)) });
const scopeEvidenceCheck = shape({ scope_id: id, source: labelText(256), check_time: clock, valid_until: clock,
  completeness: oneOf("complete", "partial", "stale", "denied", "unreadable", "unverified") });
const inputCheck = shape({ evaluated_at: clock, required_scope_ids: array(id, 64), scopes: array(scopeEvidenceCheck, 64),
  positions: array(shape({ position_id: id, team_id: id, interval: nullable(intervalCheck),
    remaining_need: observation(nullable(v => typeof v === "number" && Number.isFinite(v))),
    lead: observation(shape({ mapping: oneOf("required", "not-required", "unknown"), assignment_ids: array(id) })),
    assignments: observation(array(assignmentCheck)), candidates: array(candidateCheck, 200) }), 100) });
function zoneCheck(v: unknown): boolean {
  if (typeof v !== "string" || v.length > 128 || (v !== "UTC" && !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+$/.test(v))) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: v }).format(0); return true; } catch { return false; }
}
const sourceCheck = shape({ scope: scopeCheck, input: inputCheck, church_timezone: zoneCheck,
  identities: array(shape({ person_id: id, display_name: labelText(200) }), 200),
  labels: array(shape({ position_id: id, ministry: observation(labelText(256)), role: observation(labelText(256)) }), 100),
  leaders: array(shape({ person_id: id, team_id: id, authority: observation(bool) }), 200) });
const accessCheck = shape({ allowed: oneOf(true, false), authorization_id: id, scope: scopeCheck, now: clock,
  person_ids: array(id, 200), position_ids: array(id, 100), leader_ids: array(id, 200) });
const selectionCheck = shape({ purpose: oneOf("invitation", "escalation"), person_ids: array(id, 20) });
function eventCheck(v: unknown): boolean {
  if (!record(v)) return false;
  const base = { type: oneOf(v.type) };
  if (v.type === "start") return shape({ ...base, position_id: id })(v);
  if (v.type === "select") return shape({ ...base, purpose: oneOf("invitation", "escalation"), person_ids: array(id, 20) })(v);
  if (v.type === "edit") return shape({ ...base, plaintext: string(8000) })(v);
  return ["prepare", "refresh", "review-changes", "prepare-copy", "cancel"].includes(v.type as string) && shape(base)(v);
}
const requestCheck = shape({ access: accessCheck, source: sourceCheck, event: eventCheck });
const factsFields: Record<keyof DraftFacts, Check> = { target: shape({ position_id: id, team_id: string(128), sunday: calendar,
  ministry: string(256), role: string(256), interval: nullable(intervalCheck), church_timezone: zoneCheck,
  formatted_interval: nullable(string(512)), remaining_need: nullable(v => Number.isSafeInteger(v) && (v as number) >= 0) }),
  recipients: array(shape({ person_id: id, display_name: labelText(200), disposition: oneOf("suggestion", "possible-conflict", "unverified", "excluded", "leader"),
    membership: bool, eligibility: bool, availability: oneOf("available", "unavailable", "unknown", null),
    blockouts: nullable(array(intervalCheck)), assignments: array(assignmentCheck), reasons: array(string(8000)) }), 20), purpose: oneOf("invitation", "escalation") };
const factsCheck = shape(factsFields);
const issueCheck = shape({ code: labelText(128), scope_id: nullable(id), position_id: nullable(id), person_id: nullable(id), message: string(16000) });
const evidenceCheck = shape({ evaluated_at: clock, scopes: array(scopeEvidenceCheck, 64), required_scope_ids: array(id, 64), issues: array(issueCheck) });
const outlineCheck = shape({ facts: factsCheck,
  candidates: array(shape({ person_id: id, display_name: labelText(200), disposition: oneOf("suggestion", "possible-conflict", "unverified", "excluded"),
    reasons: array(string(8000)), observation: candidateCheck }), 200), evidence: evidenceCheck,
  rules: array(string(256)), unchecked_scope_ids: array(id, 64), verification: oneOf("verified", "unverified") });
const draftCheck = shape({ plaintext: string(8000), original_facts: factsCheck, reviewed_facts: factsCheck, original_evidence: evidenceCheck });
const differenceCheck: Check = v => record(v) && ["target", "recipients", "purpose"].includes(v.field as string) &&
  shape({ field: oneOf(v.field), before: factsFields[v.field as keyof DraftFacts], after: factsFields[v.field as keyof DraftFacts] })(v);
const freshnessCheck = shape({ evaluated_at: clock, required_scope_ids: array(id, 64),
  scope_check_times: array(shape({ scope_id: id, check_time: clock }), 64) });
const stateCheck = shape({ version: oneOf(1), scope: scopeCheck, authorization_id: id, position_id: id, selection: selectionCheck,
  current: outlineCheck, source: sourceCheck, freshness: freshnessCheck, draft: nullable(draftCheck), differences: array(differenceCheck, 3) });
const unique = (values: string[]) => new Set(values).size === values.length;
const sameScope = (a: SundayScope, b: SundayScope) =>
  a.workspace_id === b.workspace_id && a.service_type_id === b.service_type_id && a.plan_id === b.plan_id && a.sunday === b.sunday;
function sourceInvariants(source: DraftSource): boolean {
  const { input, identities, labels, leaders } = source;
  const ids = identities.map(p => p.person_id);
  return unique(ids) && unique(input.positions.map(p => p.position_id)) && unique(input.scopes.map(s => s.scope_id)) &&
    unique(input.required_scope_ids) && unique(labels.map(p => p.position_id)) && unique(leaders.map(p => p.person_id)) &&
    input.positions.every(p => unique(p.candidates.map(c => c.person_id)) && p.candidates.every(c => ids.includes(c.person_id))) &&
    labels.every(l => input.positions.some(p => p.position_id === l.position_id)) && leaders.every(l => ids.includes(l.person_id));
}
function authorized(source: DraftSource, access: DraftAccess): boolean {
  return source.identities.every(p => access.person_ids.includes(p.person_id)) &&
    source.input.positions.every(p => access.position_ids.includes(p.position_id));
}
function copyJson(value: unknown, depth = 0, seen = new Set<object>(), budget = { units: 0 }): unknown {
  budget.units += typeof value === "string" ? value.length : 1;
  if (budget.units > 1_048_576) throw new Error("invalid");
  if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
  if (!value || typeof value !== "object" || depth > 24 || seen.has(value)) throw new Error("invalid");
  const isArray = Array.isArray(value);
  if (Object.getPrototypeOf(value) !== (isArray ? Array.prototype : Object.prototype)) throw new Error("invalid");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const entries = Object.entries(descriptors);
  if (Reflect.ownKeys(value).length !== entries.length || entries.length > 2001) throw new Error("invalid");
  if (isArray && (value.length > 2000 || entries.length !== value.length + 1)) throw new Error("invalid");
  seen.add(value);
  const out: Record<string, unknown> = {}, values: unknown[] = [];
  for (const [key, descriptor] of entries) {
    budget.units += key.length;
    if (!Object.hasOwn(descriptor, "value") || key === "__proto__") throw new Error("invalid");
    if (isArray && key === "length") continue;
    if (isArray && !/^(0|[1-9]\d*)$/.test(key)) throw new Error("invalid");
    const next = copyJson(descriptor.value, depth + 1, seen, budget);
    if (isArray) values[Number(key)] = next; else out[key] = next;
  }
  seen.delete(value);
  return isArray ? values : out;
}
function checked<T>(value: unknown, check: Check): T {
  const copy = copyJson(value);
  if (new TextEncoder().encode(JSON.stringify(copy)).length > 1_048_576 || !check(copy)) throw new Error("invalid");
  return copy as T;
}
function seal(result: DraftReviewResult): DraftReviewResult {
  const copy = checked<DraftReviewResult>(result, () => true);
  if ("state" in copy && copy.state && (!stateCheck(copy.state) || !stateInvariants(copy.state))) throw new Error("invalid");
  const freeze = (v: unknown): void => {
    if (!v || typeof v !== "object") return;
    Object.values(v).forEach(freeze);
    Object.freeze(v);
  };
  freeze(copy);
  return copy;
}

/** Each operation requires CURRENT trusted host authority and source binding. No value authenticates itself. */
export function reviewCoverageDraft(previous: DraftReviewState | null, request: DraftRequest): DraftReviewResult {
  try {
    request = checked<DraftRequest>(request, requestCheck);
    if (request.event.type === "select" && (!unique(request.event.person_ids) ||
        request.event.person_ids.some(id => !request.source.identities.some(p => p.person_id === id))))
      return seal({ status: "rejected", code: "invalid", state: null });
    if (!sourceInvariants(request.source) || !unique(request.access.person_ids) || !unique(request.access.position_ids) ||
        !unique(request.access.leader_ids)) return seal({ status: "rejected", code: "invalid", state: null });
    if (!request.access.allowed || !authorized(request.source, request.access)) return seal({ status: "rejected", code: "unauthorized", state: null });
    if (!sameScope(request.access.scope, request.source.scope)) return seal({ status: "rejected", code: "scope-mismatch", state: null });
    if (request.event.type === "start") {
      if (!request.source.input.positions.some(p => p.position_id === (request.event as { position_id: string }).position_id))
        return seal({ status: "rejected", code: "invalid", state: null });
      return seal(transition(null, request));
    }
    previous = checked<DraftReviewState>(previous, stateCheck);
    if (!sourceInvariants(previous.source) || !stateInvariants(previous)) return seal({ status: "rejected", code: "invalid", state: null });
    if (!sameScope(previous.scope, request.access.scope) || !sameScope(previous.scope, previous.source.scope))
      return seal({ status: "rejected", code: "scope-mismatch", state: null });
    if (previous.authorization_id !== request.access.authorization_id || !authorized(previous.source, request.access) ||
        [previous.current.facts, previous.draft?.original_facts, previous.draft?.reviewed_facts].some(f => f &&
          (!request.access.position_ids.includes(f.target.position_id) || f.recipients.some(p => !request.access.person_ids.includes(p.person_id)))) ||
        previous.current.candidates.some(p => !request.access.person_ids.includes(p.person_id)))
      return seal({ status: "rejected", code: "unauthorized", state: null });
    return seal(transition(previous, request));
  } catch {
    return Object.freeze({ status: "rejected", code: "invalid", state: null });
  }
}

function equal(a: unknown, b: unknown): boolean {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : record(v)
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}
function differences(before: DraftFacts, after: DraftFacts): DraftDifference[] {
  const out: DraftDifference[] = [];
  if (!equal(before.target, after.target)) out.push({ field: "target", before: before.target, after: after.target });
  if (!equal(before.recipients, after.recipients)) out.push({ field: "recipients", before: before.recipients, after: after.recipients });
  if (before.purpose !== after.purpose) out.push({ field: "purpose", before: before.purpose, after: after.purpose });
  return out;
}

function stateInvariants(state: DraftReviewState): boolean {
  const snapshots = [state.current.facts, state.draft?.original_facts, state.draft?.reviewed_facts];
  const freshness = state.freshness;
  return unique(freshness.required_scope_ids) && unique(freshness.scope_check_times.map(s => s.scope_id)) &&
    Date.parse(freshness.evaluated_at) >= Date.parse(state.current.evidence.evaluated_at) &&
    [...state.source.input.required_scope_ids, ...state.current.evidence.required_scope_ids]
      .every(id => freshness.required_scope_ids.includes(id)) &&
    [...state.source.input.scopes, ...state.current.evidence.scopes].every(scope =>
      freshness.scope_check_times.some(s => s.scope_id === scope.scope_id && Date.parse(s.check_time) >= Date.parse(scope.check_time))) &&
    unique(state.selection.person_ids) && snapshots.every(f => !f ||
    f.target.position_id === state.position_id && f.target.sunday === state.scope.sunday && unique(f.recipients.map(p => p.person_id))) &&
    state.current.facts.purpose === state.selection.purpose && state.current.facts.recipients.every(p => state.selection.person_ids.includes(p.person_id)) &&
    unique(state.current.candidates.map(c => c.person_id)) && state.current.candidates.every(c => c.person_id === c.observation.person_id) &&
    equal(state.differences, state.draft ? differences(state.draft.reviewed_facts, state.current.facts) : []);
}
