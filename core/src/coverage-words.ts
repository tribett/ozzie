// Plain words for the coverage engine's open questions, as "Why I flagged this" shows them on the Services page.
// The engine's own `message` stays as it is: the harness's tools match on it (tools.ts, ask.ts) and never show it.
// These lines are for the page only and never go to a model. Pure.
import type { CoverageIssue } from "./coverage.js";

/** One line a pastor can act on, naming the role when there is one; `system` is "Planning Center", "B1 Church"… */
export function plainIssue(issue: Pick<CoverageIssue, "code" | "message" | "position_id">, role: string | null, system: string): string {
  const which = role ? `${role}` : "A role";
  const its = role ? `${role}'s` : "a role's";
  switch (issue.code) {
    case "time-unverified":
      return `${which} isn't tied to a service time in ${system}, so Ozzie can't tell when it serves. Set the role's time in ${system} to have it checked.`;
    case "need-unverified":
      return `${system} didn't say how many people ${role ?? "a role"} needs, so Ozzie doesn't count it as full.`;
    case "assignment-unverified":
      return issue.message.startsWith("Duplicate")
        ? `${system} listed the same person on ${role ?? "a role"} more than once, so Ozzie couldn't count ${role ? "it" : "that role"}.`
        : `Ozzie couldn't tell from ${system} who said yes for ${role ?? "a role"}, or when they serve.`;
    case "positions-unverified":
      return `${system} listed no roles for this service, so there was nothing to check.`;
    case "scope-unverified":
      return `Part of what ${system} sent was missing, repeated or out of date, so Ozzie didn't rely on it.`;
    default:
      return `Ozzie couldn't confirm part of ${its} information in ${system}.`;
  }
}

/** The page's lines for a set of open questions: one per distinct line, in the engine's order. */
export function plainIssues(issues: readonly Pick<CoverageIssue, "code" | "message" | "position_id">[], roleOf: (id: string) => string | null,
  system: string): string[] {
  return [...new Set(issues.map(i => plainIssue(i, i.position_id ? roleOf(i.position_id) : null, system)))];
}

/** The open questions that are facts about one role as the system lists it: its time, its number, who answered. */
const ROLE_FACTS: ReadonlySet<string> = new Set(["time-unverified", "need-unverified", "assignment-unverified"]);
/**
 * When every open question is a fact about a role as the system lists it (each names its role), how many roles and their
 * plain lines, so the page can say "One role couldn't be checked." with the reason under it, instead of implying a read
 * that failed. Null when any question is about the check as a whole, or there is none. The brief adds this only when no
 * read failed and the check isn't out of date.
 */
export function roleFacts(issues: readonly Pick<CoverageIssue, "code" | "message" | "position_id">[], roleOf: (id: string) => string | null,
  system: string): { roles: number; reasons: string[] } | null {
  if (!issues.length || !issues.every(i => i.position_id && ROLE_FACTS.has(i.code))) return null;
  return { roles: new Set(issues.map(i => i.position_id)).size, reasons: plainIssues(issues, roleOf, system) };
}
