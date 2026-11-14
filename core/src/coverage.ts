export type Completeness = "complete" | "partial" | "stale" | "denied" | "unreadable" | "unverified";
export interface CoverageScope {
  scope_id: string; source: string; check_time: string; valid_until: string;
  completeness: Completeness;
}
export interface Observation<T> { scope_id: string; value: T }
export interface ServingInterval { starts_at: string; ends_at: string }
export interface ServingAssignment {
  assignment_id: string; status: "C" | "U" | "D" | "cancelled" | "unknown";
  notification: "sent" | "unsent" | "unknown";
  intervals: ServingInterval[]; time_semantics: "verified" | "unverified";
}
export interface LeadRequirement {
  mapping: "required" | "not-required" | "unknown";
  // Only IDs of assignments for the explicitly mapped Sunday lead role.
  assignment_ids: string[];
}
export interface CoverageCandidate {
  person_id: string;
  membership: Observation<boolean | null>;
  eligibility: Observation<boolean | null>;
  availability: Observation<"available" | "unavailable" | "unknown">;
  blockouts: Observation<ServingInterval[] | null>;
  assignments: Observation<ServingAssignment[]>;
}
export interface CoveragePosition {
  position_id: string; team_id: string;
  interval: ServingInterval | null;
  remaining_need: Observation<number | null>;
  lead: Observation<LeadRequirement>;
  assignments: Observation<ServingAssignment[]>;
  candidates: CoverageCandidate[];
}
export interface CoverageInput {
  evaluated_at: string;
  required_scope_ids: string[];
  scopes: CoverageScope[];
  positions: CoveragePosition[];
}
export interface CoverageIssue {
  code: string; scope_id: string | null; position_id: string | null;
  person_id: string | null; message: string;
}
export interface CandidateAssessment {
  person_id: string;
  disposition: "suggestion" | "possible-conflict" | "unverified" | "excluded";
  reasons: string[];
}
export interface PositionAssessment {
  position_id: string; team_id: string;
  remaining_need: number | null;
  lead: "not-required" | "confirmed" | "missing" | "unverified";
  pending_assignment_ids: string[];
  candidates: CandidateAssessment[];
}
export interface CoverageResult {
  evaluated_at: string; scopes: CoverageScope[];
  status: "checked-scope-clear" | "findings" | "unverified";
  positions: PositionAssessment[];
  issues: CoverageIssue[];
}

// Explicit offsets only. Date.parse alone accepts local timestamps and normalizes invalid dates.
function instant(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return NaN;
  const [, year, month, day, hour, minute, second, zone] = match;
  const days = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > days ||
      Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 ||
      (zone !== "Z" && (Number(zone!.slice(1, 3)) > 23 || Number(zone!.slice(4)) > 59))) return NaN;
  return Date.parse(value);
}

function interval(value: ServingInterval | null): [number, number] | null {
  if (!value) return null;
  const start = instant(value.starts_at), end = instant(value.ends_at);
  return Number.isFinite(start) && Number.isFinite(end) && start < end ? [start, end] : null;
}

function unresolvedResponse(assignment: ServingAssignment): boolean {
  return assignment.status === "unknown" || assignment.time_semantics !== "verified" ||
    !assignment.intervals.length;
}

function unresolvedAssignment(assignment: ServingAssignment): boolean {
  return unresolvedResponse(assignment) || assignment.intervals.some(t => !interval(t));
}

function duplicateAssignmentIds(assignments: ServingAssignment[]): Set<string> {
  const seen = new Set<string>(), duplicates = new Set<string>();
  for (const assignment of assignments) {
    if (seen.has(assignment.assignment_id)) duplicates.add(assignment.assignment_id);
    seen.add(assignment.assignment_id);
  }
  return duplicates;
}

function covers(assignment: ServingAssignment, target: [number, number]): boolean {
  // Sort a new bounds array, never the source records or candidate list.
  const times = assignment.intervals.map(t => interval(t)!).sort((a, b) => a[0] - b[0]);
  let coveredUntil = target[0];
  for (const [start, end] of times) {
    if (start > coveredUntil) return false;
    coveredUntil = Math.max(coveredUntil, end);
    if (coveredUntil >= target[1]) return true;
  }
  return false;
}

/** Pure fixed-observation evaluation; no provider, model, clock or I/O. */
export function evaluateCoverage(input: CoverageInput): CoverageResult {
  const issues: CoverageIssue[] = [];
  const report = (code: string, message: string, scope_id: string | null = null, position_id: string | null = null, person_id: string | null = null) =>
    issues.push({ code, message, scope_id, position_id, person_id });
  const now = instant(input.evaluated_at);
  const usableScopes = new Set<string>();
  if (!input.positions.length) report("positions-unverified", "Some coverage couldn't be verified: no positions were supplied.");
  if (!input.required_scope_ids.length || !Number.isFinite(now)) report("scope-unverified", "Some coverage couldn't be verified: missing scope or evaluation clock.");
  for (const id of new Set(input.required_scope_ids)) {
    const matches = input.scopes.filter(s => s.scope_id === id);
    const scope = matches[0];
    if (matches.length === 1 && scope && scope.source.trim() && scope.completeness === "complete" &&
        instant(scope.check_time) <= now && now <= instant(scope.valid_until)) usableScopes.add(id);
    else report("scope-unverified", "Some coverage couldn't be verified: missing, duplicate, incomplete or out-of-date scope.", id);
  }
  const usable = <T>(observation: Observation<T>, position_id: string): boolean => {
    if (usableScopes.has(observation.scope_id)) return true;
    report("observation-unverified", "Some coverage couldn't be verified for this observation.", observation.scope_id, position_id);
    return false;
  };
  const assessLead = (position: CoveragePosition): PositionAssessment["lead"] => {
    if (!usable(position.lead, position.position_id) || position.lead.value.mapping === "unknown") {
      report("lead-unverified", "Worth a look: confirm whether a scheduled Sunday lead is required.", position.lead.scope_id, position.position_id);
      return "unverified";
    }
    if (position.lead.value.mapping === "not-required") return "not-required";
    const target = interval(position.interval);
    if (!target || !usable(position.assignments, position.position_id)) {
      report("lead-unverified", "Worth a look: scheduled lead times couldn't be verified.", position.assignments.scope_id, position.position_id);
      return "unverified";
    }
    const mapped = position.assignments.value.filter(a => position.lead.value.assignment_ids.includes(a.assignment_id));
    const unresolved = position.lead.value.assignment_ids.some(id => !mapped.some(a => a.assignment_id === id)) ||
      duplicateAssignmentIds(mapped).size > 0 || mapped.some(unresolvedAssignment);
    if (unresolved) {
      report("lead-unverified", "Worth a look: scheduled lead responses or times couldn't be verified.", position.assignments.scope_id, position.position_id);
      return "unverified";
    }
    return mapped.some(a => a.status === "C" && covers(a, target)) ? "confirmed" : "missing";
  };
  const assessCandidate = (person: CoverageCandidate, position: CoveragePosition): CandidateAssessment => {
    const reasons: string[] = [];
    let excluded = false, unknown = false, possible = false;
    const target = interval(position.interval);
    if (!target) { unknown = true; reasons.push("Required serving interval couldn't be verified."); }
    if (!input.required_scope_ids.length || usableScopes.size !== new Set(input.required_scope_ids).size) {
      unknown = true; reasons.push("Required related scope couldn't be verified.");
    }
    const check = <T>(fact: Observation<T>, accepted: T, rejected: T, label: string) => {
      if (!usable(fact, position.position_id) || (fact.value !== accepted && fact.value !== rejected)) {
        unknown = true; reasons.push(label + " couldn't be verified.");
      } else if (fact.value === rejected) {
        excluded = true; reasons.push(label + " excludes this suggestion.");
      }
    };
    check(person.membership, true, false, "Team membership");
    check(person.eligibility, true, false, "Required role eligibility");
    check(person.availability, "available", "unavailable", "Recorded availability");
    if (!usable(person.blockouts, position.position_id) || person.blockouts.value === null) {
      unknown = true; reasons.push("Blockouts couldn't be verified.");
    } else {
      for (const blockout of person.blockouts.value) {
        const bounds = interval(blockout);
        if (!bounds || !target) {
          unknown = true; reasons.push("Blockout times couldn't be verified.");
        } else if (bounds[0] < target[1] && target[0] < bounds[1]) {
          excluded = true; reasons.push("Recorded overlapping blockout.");
        }
      }
    }
    if (!usable(person.assignments, position.position_id)) {
      unknown = true; reasons.push("Serving assignments couldn't be verified.");
    } else {
      const duplicates = duplicateAssignmentIds(person.assignments.value);
      if (duplicates.size) { unknown = true; reasons.push("Duplicate serving assignment identities couldn't be verified."); }
      for (const assignment of person.assignments.value) {
        if (duplicates.has(assignment.assignment_id)) continue;
        if (assignment.status === "D" || assignment.status === "cancelled") continue;
        if (unresolvedResponse(assignment)) {
          unknown = true; reasons.push("Serving response or time semantics couldn't be verified.");
          continue;
        }
        for (const time of assignment.intervals) {
          const bounds = interval(time);
          if (!bounds || !target) {
            unknown = true; reasons.push("Serving times couldn't be verified.");
          } else if (bounds[0] < target[1] && target[0] < bounds[1]) {
            if (assignment.status === "C") {
              excluded = true; reasons.push("Confirmed overlapping serving assignment.");
            } else {
              possible = true;
              reasons.push(assignment.notification === "sent"
                ? "Possible conflict: source records an unanswered sent request."
                : assignment.notification === "unsent"
                  ? "Possible conflict: unconfirmed scheduling record; invitation not sent."
                  : "Possible conflict: unconfirmed scheduling record; sending couldn't be verified.");
            }
          }
        }
      }
    }
    if (unknown) report("candidate-unverified", "Worth a look: " + reasons.join(" "), null, position.position_id, person.person_id);
    return {
      person_id: person.person_id, disposition: excluded ? "excluded" : unknown ? "unverified" : possible ? "possible-conflict" : "suggestion",
      reasons: reasons.length ? reasons : ["Recorded team membership, role eligibility and availability; no overlapping serving assignment in checked scope. Willingness is not established."],
    };
  };
  const positions: PositionAssessment[] = input.positions.map(position => {
    if (!interval(position.interval)) report("time-unverified", "Some coverage couldn't be verified: required serving interval is missing or ambiguous.", null, position.position_id);
    const quantity = position.remaining_need.value;
    const validNeed = usable(position.remaining_need, position.position_id) && quantity !== null && Number.isSafeInteger(quantity) && quantity >= 0;
    if (!validNeed) report("need-unverified", "Remaining need couldn't be verified; no zero is inferred.", position.remaining_need.scope_id, position.position_id);
    if (usable(position.assignments, position.position_id) && duplicateAssignmentIds(position.assignments.value).size) {
      report("assignment-unverified", "Duplicate serving assignment identities couldn't be verified.", position.assignments.scope_id, position.position_id);
    }
    if (usable(position.assignments, position.position_id) && position.assignments.value.some(a =>
      a.status === "unknown" || ((a.status === "C" || a.status === "U") && unresolvedAssignment(a)))) {
      report("assignment-unverified", "Serving responses or time semantics couldn't be verified.", position.assignments.scope_id, position.position_id);
    }
    return {
      position_id: position.position_id, team_id: position.team_id,
      remaining_need: validNeed ? quantity : null,
      lead: assessLead(position),
      pending_assignment_ids: usable(position.assignments, position.position_id) ? position.assignments.value.filter(a => a.status === "U").map(a => a.assignment_id) : [],
      candidates: position.candidates.map(c => assessCandidate(c, position)),
    };
  });
  return {
    evaluated_at: input.evaluated_at, scopes: input.scopes.map(scope => ({ ...scope })),
    status: issues.length ? "unverified" : positions.some(p => (p.remaining_need ?? 0) > 0 || p.pending_assignment_ids.length || p.lead === "missing" || p.candidates.some(c => c.disposition === "possible-conflict")) ? "findings" : "checked-scope-clear",
    positions, issues,
  };
}
