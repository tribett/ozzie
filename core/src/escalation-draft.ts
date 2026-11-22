// A note to the team's leader when nobody on the team qualifies, or when a Church rule asks for
// a scheduled lead and none is scheduled. Same placeholder model as draft-request.ts:
// Ozzie writes [Leader A] / [Role] / [Your name] text here and names are put back on this Mac only.
// These notes are never offered for AI rewording (draft-request's boundary only accepts its own
// volunteer-request drafts), and nothing is ever sent: the person copies the note and sends it.
import type { Finding } from "./sunday-brief.js";
import { serviceOn } from "./draft-request.js";

/**
 * `sunday`: the church-local date (YYYY-MM-DD) of the service checked, on whatever day it is, named when the service time
 * wasn't read. `zone`: the church's time zone, so the service time is on the church's clock (serviceOn).
 */
export interface EscalationContext { finding: Finding; leader_id: string; sunday?: string | null; zone?: string | null }
export interface EscalationDraft { readonly kind: "no-one-clear" | "lead-missing"; readonly text: string; readonly role: string }

/** Nobody on the team is clear (no suggestion and no possible conflict), or a required lead is missing, and Planning Center lists a leader. */
export function canEscalate(finding: Finding): boolean {
  if (!finding.leaders?.length || !finding.position) return false;
  if (finding.kind === "lead-missing") return true;
  return finding.kind === "needs-people" && !!finding.people && finding.people.suggestions.length + finding.people.conflicts.length === 0;
}

/** Ozzie's own wording, in placeholder form. Only to a leader Planning Center lists for this team. */
export function escalationDraft(ctx: EscalationContext): EscalationDraft {
  const { finding } = ctx;
  // The service's own date, never "this week" or "this Sunday": the note may go out weeks before it.
  const on = serviceOn(finding, ctx.sunday, ctx.zone);
  if (!canEscalate(finding) || !finding.leaders!.includes(ctx.leader_id)) throw new Error("Ozzie can only prepare this note for a leader Planning Center lists for this team.");
  const role = finding.position!.name;
  if (finding.kind === "lead-missing") return Object.freeze({
    kind: "lead-missing" as const, role,
    text: [
      "Hi [Leader A],",
      `I don't see anyone scheduled to lead the [Role] team ${on} in Planning Center. Is that expected, or should we find someone?`,
      "Thank you,\n[Your name]",
    ].join("\n\n"),
  });
  const n = finding.remaining ?? 1;
  return Object.freeze({
    kind: "no-one-clear" as const, role,
    text: [
      "Hi [Leader A],",
      `[Role] ${on} still needs ${n === 1 ? "one more person" : `${n} more people`}. I checked the team in Planning Center and couldn't find anyone else on the team who is clear for that time.`,
      "Could you help me think of who to ask, or let me know if it's covered another way?",
      "Thank you,\n[Your name]",
    ].join("\n\n"),
  });
}

/** Local only: the leader's first name, the exact role and the sender. */
export function restoreEscalation(draft: EscalationDraft, ctx: EscalationContext, names: Record<string, string>, sender: string): string {
  const first = (Object.hasOwn(names, ctx.leader_id) ? names[ctx.leader_id] ?? "" : "").trim().split(/\s+/)[0] || "there";
  return draft.text.split("[Leader A]").join(first).split("[Role]").join(draft.role).split("[Your name]").join(sender.trim() || "[Your name]");
}
