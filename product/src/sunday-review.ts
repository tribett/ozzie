import { evaluateCoverage, type CoverageInput, type CoverageResult, type Observation } from "../../core/src/coverage.js";
import { createCoverageState, transitionCoverage, type CoverageFinding, type CoverageState, type ManualDisposition } from "../../core/src/coverage-state.js";

export const ministries = [
  { id: "nursery", name: "Nursery" },
  { id: "welcome", name: "Welcome Team" },
  { id: "lyrics", name: "Lyrics" },
] as const;
export type MinistryId = typeof ministries[number]["id"];
export const exampleSunday = "2026-11-22";
export const exampleCheckTime = "2026-11-20T09:00:00Z";
export interface SundayOutline {
  ministryIds: MinistryId[];
  welcomeLeadRequired: boolean;
  partialExample: boolean;
  partialMinistry: MinistryId;
  schedule: "original" | "decline" | "filled";
}
export interface SundayReview {
  mode: "fictional";
  phase: "outline" | "review";
  outline: SundayOutline;
  result: CoverageResult | null;
  error: string | null;
  decisions: Partial<Record<MinistryId, CoverageState>>;
  revision: number;
}
export interface SundayFinding {
  id: string; ministry: string; title: string; description: string; rule: string;
  inputs: string[]; source: string; checkTime: string | null; uncertain: boolean;
  status: CoverageFinding["status"]; note: string | null; canRecordDecision: boolean;
  label: CoverageFinding["label"];
  change: string | null;
  lastSuccessfulCheckTime: string | null;
}
// Fixed walkthrough context only; this is not authentication or a source grant.
const exampleAccess = { allowed: true, authorization_id: "fictional-access", scope: {
  workspace_id: "fictional-workspace", service_type_id: "fictional-service",
  plan_id: "fictional-plan", sunday: exampleSunday,
} };
export function createSundayReview(): SundayReview {
  return { mode: "fictional", phase: "outline", outline: {
    ministryIds: ministries.map(m => m.id), welcomeLeadRequired: true, partialExample: false, partialMinistry: "lyrics", schedule: "original",
  }, result: null, error: null, decisions: {}, revision: 0 };
}
export function updateSundayOutline(state: SundayReview, patch: Partial<SundayOutline>): SundayReview {
  const outline = { ...state.outline, ...patch };
  const sourceChanged = (patch.schedule !== undefined && patch.schedule !== state.outline.schedule)
    || (patch.partialExample !== undefined && patch.partialExample !== state.outline.partialExample)
    || (patch.partialMinistry !== undefined && patch.partialMinistry !== state.outline.partialMinistry);
  const revision = sourceChanged ? state.revision + 1 : state.revision;
  return { ...state, revision, phase: "outline", outline: { ...outline, ministryIds: [...outline.ministryIds] }, result: null, error: null };
}
export function confirmSundayReview(state: SundayReview): SundayReview {
  const selected = state.outline.ministryIds;
  if (!["original", "decline", "filled"].includes(state.outline.schedule) || !validRevision(state.revision)
    || !ministries.some(m => m.id === state.outline.partialMinistry)) {
    return { ...state, phase: "outline", result: null, error: "The example needs to be restarted before it can be checked." };
  }
  if (!selected.length) return { ...state, phase: "outline", result: null, error: "Choose at least one ministry to check." };
  if (new Set(selected).size !== selected.length || selected.some(id => !ministries.some(m => m.id === id))) {
    return { ...state, phase: "outline", result: null, error: "Choose from the ministries in this example." };
  }
  const input = fictionalInput(state.outline, state.revision);
  const decisions = { ...state.decisions };
  for (const id of selected) {
    const previous = decisions[id] ?? createCoverageState(exampleAccess).state;
    if (!previous) return { ...state, error: "The example could not be checked." };
    const generation = previous.generation + 1, request_id = `example-${id}-${generation}`;
    const pending = transitionCoverage(previous, exampleAccess, { type: "refresh-requested", scope: exampleAccess.scope,
      request_id, generation, origin: "on-demand" }).state;
    if (!pending) return { ...state, error: "The example could not be checked." };
    const observed = transitionCoverage(pending, exampleAccess, { type: "observation-received", scope: exampleAccess.scope,
      request_id, generation, input: { ...input, positions: input.positions.filter(p => p.team_id === id),
        scopes: input.scopes.filter(s => s.scope_id === `example-${id}`), required_scope_ids: [`example-${id}`] } });
    if (observed.status !== "applied" || !observed.state) return { ...state, error: "The example could not be checked." };
    decisions[id] = observed.state;
  }
  return { ...state, phase: "review", result: evaluateCoverage(input), error: null, decisions };
}

export function recordSundayDecision(state: SundayReview, findingId: string, choice: ManualDisposition["choice"], reason: string): SundayReview {
  if (!validRevision(state.revision)) return { ...state, error: "The example needs a fresh check before recording a decision." };
  if (!sundayFindings(state).some(f => f.id === findingId && f.canRecordDecision)) {
    return { ...state, error: "Only an open Sunday serving need can have a decision recorded." };
  }
  const id = state.outline.ministryIds.find(id => state.decisions[id]?.findings.some(f => f.id === findingId));
  if (!id || !state.decisions[id]) return { ...state, error: "This Sunday item could not be found." };
  const result = transitionCoverage(state.decisions[id]!, exampleAccess, { type: "disposition-recorded", scope: exampleAccess.scope,
    finding_id: findingId, choice, reason, actor_id: "fictional-user", recorded_at: exampleClock(state.revision, 30_000) });
  if (!result.state) return { ...state, error: "Enter a short reason for this Sunday decision (up to 1,000 characters)." };
  return { ...state, decisions: { ...state.decisions, [id]: result.state }, error: null };
}

/** Presentation of the accepted evaluator's fixed-example result; no provider I/O. */
export function sundayFindings(state: SundayReview): SundayFinding[] {
  if (state.phase !== "review" || !state.result) return [];
  const findings: SundayFinding[] = [];
  for (const position of state.result.positions) {
    const ministry = ministries.find(m => m.id === position.team_id)?.name ?? "Selected ministry";
    const source = state.result.scopes.find(s => s.scope_id === `example-${position.team_id}`);
    const operational = state.decisions[position.team_id as MinistryId];
    const common = { ministry, source: source?.source ?? "Source unavailable", checkTime: source?.check_time ?? null,
      status: "attention" as CoverageFinding["status"], label: "Needs your attention" as CoverageFinding["label"],
      note: null as string | null, canRecordDecision: false, change: null as string | null,
      lastSuccessfulCheckTime: operational?.verification.last_successful_check_time ?? null };
    if (!source || source.completeness !== "complete") {
      findings.push({ ...common, id: `${position.position_id}-unverified`, title: `${ministry} could not be checked`,
        status: "worth-a-look", label: "Worth a look",
        note: operational?.findings.find(f => f.position_id === position.position_id && f.history.length > 0)?.history.at(-1)?.reason ?? null,
        description: "No coverage count is available for this scope. The other checked ministries stay visible.",
        rule: "Missing source information must stay visible.", inputs: ["The example source is unavailable.", "No empty count was inferred."], uncertain: true });
      continue;
    }
    const decision = state.decisions[position.team_id as MinistryId]?.findings.find(f => f.position_id === position.position_id && f.kind === "remaining-need");
    if ((position.remaining_need !== null && position.remaining_need > 0) || decision?.status === "source-confirmed") findings.push({ ...common,
      id: decision?.id ?? `${position.position_id}-need`, ...decisionFields(decision),
      title: position.remaining_need ? `${ministry} still needs ${position.remaining_need === 1 ? "one person" : `${position.remaining_need} people`}`
        : `${ministry}'s previous serving need is no longer open.`,
      description: position.remaining_need ? "A serving request is still open for the checked Sunday interval."
        : "The example records zero remaining requests for this interval. This does not establish who filled a role.", rule: "Remaining serving requests need a decision.",
      inputs: [`Recorded remaining need: ${position.remaining_need}.`, "Confirmed assignments are not subtracted from this count again."], uncertain: false });
    const leadDecision = state.decisions[position.team_id as MinistryId]?.findings.find(f => f.position_id === position.position_id && f.kind === "required-lead");
    if (position.lead === "missing" || (leadDecision?.status === "source-confirmed" && leadDecision.history.length > 0)) findings.push({ ...common,
      id: leadDecision?.id ?? `${position.position_id}-lead`, ...decisionFields(leadDecision),
      title: position.lead === "missing" ? `No Sunday lead assignment found for ${ministry}` : `${ministry} lead requirement checked`,
      description: position.lead === "missing" ? "No confirmed lead assignment covers the checked interval. Is that expected?"
        : "This example no longer requires a scheduled Sunday lead. No person's assignment has been confirmed.",
      rule: state.outline.welcomeLeadRequired ? "A Sunday lead is required for the Welcome Team." : "A Sunday lead is not required for the Welcome Team in this example.",
      inputs: [state.outline.welcomeLeadRequired ? "This example church rule requires a scheduled Sunday lead." : "The Sunday lead requirement was removed.",
        "Confirmed assignments covering 9:15–10:45 a.m. Eastern: none."], uncertain: false });
    if (position.pending_assignment_ids.length) findings.push({ ...common, id: `${position.position_id}-pending`,
      title: `${ministry} has ${position.pending_assignment_ids.length === 1 ? "one unanswered assignment" : `${position.pending_assignment_ids.length} unanswered assignments`}`,
      description: "The scheduling record has not been sent. It does not confirm coverage.", rule: "An unanswered assignment is not confirmed coverage.",
      inputs: [`Unanswered scheduling records: ${position.pending_assignment_ids.length}.`, "Invitation sent: no."], uncertain: false });
  }
  return findings;
}

function decisionFields(finding: CoverageFinding | undefined): Pick<SundayFinding, "status" | "label" | "note" | "canRecordDecision" | "change"> {
  const changes: string[] = [];
  if (finding?.change?.reasons.includes("remaining-need-increased")) changes.push(
    `Remaining need changed from ${finding.change.before?.remaining_need ?? "unverified"} to ${finding.change.after.remaining_need ?? "unverified"}.`);
  if (finding?.change?.reasons.includes("assignment-declined")) {
    const after = finding.change.after.assignments.find(next => ["D", "cancelled"].includes(next.status)
      && finding.change?.before?.assignments.some(old => old.assignment_id === next.assignment_id && ["C", "U"].includes(old.status)));
    const before = finding.change.before?.assignments.find(old => old.assignment_id === after?.assignment_id);
    const labels = { C: "confirmed", U: "unanswered", D: "declined", cancelled: "cancelled", unknown: "unverified" };
    if (before && after) changes.push(`An example assignment changed from ${labels[before.status]} to ${labels[after.status]}.`);
  }
  if (finding?.change?.reasons.includes("requirement-added")) changes.push("A Sunday requirement was added.");
  return { status: finding?.status ?? "attention", label: finding?.label ?? "Needs your attention",
    note: finding?.history.at(-1)?.reason ?? null,
    canRecordDecision: finding?.status === "attention" || finding?.status === "resolved-by-you", change: changes.join(" ") || null };
}
const validRevision = (revision: number) => Number.isSafeInteger(revision) && revision >= 0 && revision <= 20;
const exampleClock = (revision: number, offset = 0) => new Date(Date.parse(exampleCheckTime) + revision * 60_000 + offset).toISOString().replace(".000Z", "Z");

/** Designed observations, never provider records or a same-data live fallback. */
function fictionalInput(outline: SundayOutline, revision: number): CoverageInput {
  const interval = { starts_at: "2026-11-22T14:15:00Z", ends_at: "2026-11-22T15:45:00Z" };
  const scopes = outline.ministryIds.map(id => ({ scope_id: `example-${id}`,
    source: `Fictional Services fixture: ${ministries.find(m => m.id === id)!.name}`,
    check_time: exampleClock(revision), valid_until: "2026-11-20T10:00:00Z",
    completeness: outline.partialExample && id === outline.partialMinistry ? "denied" as const : "complete" as const }));
  return {
    evaluated_at: exampleClock(revision), required_scope_ids: scopes.map(s => s.scope_id), scopes,
    positions: outline.ministryIds.map(id => {
      const observed = <T>(value: T): Observation<T> => ({ scope_id: `example-${id}`, value });
      return {
        position_id: `${id}-position`, team_id: id, interval: { ...interval },
        remaining_need: observed(id === "nursery" ? outline.schedule === "filled" ? 0 : outline.schedule === "decline" ? 2 : 1 : 0),
        lead: observed({ mapping: id === "welcome" && outline.welcomeLeadRequired ? "required" as const : "not-required" as const, assignment_ids: [] }),
        assignments: observed(id === "welcome" ? [] : [{ assignment_id: `${id}-assignment`,
          status: id === "nursery" ? outline.schedule === "decline" ? "D" as const : "C" as const : "U" as const,
          notification: id === "nursery" ? "sent" as const : "unsent" as const,
          intervals: [{ ...interval }], time_semantics: "verified" as const }]),
        candidates: [],
      };
    }),
  };
}
