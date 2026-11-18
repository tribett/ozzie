// A reminder to someone whose request has no answer yet, for "Prepare a reminder" and a Church rule
// that says "Always prepare a reminder note". Same placeholder model as escalation-draft.ts: Ozzie
// writes [Volunteer A] / [Role] / [Your name] text here and names are put back on this Mac only.
// These notes are never offered for AI rewording (draft-request's boundary only accepts its own
// volunteer-request drafts), and nothing is ever sent: the person copies the note and sends it.
import { serviceOn } from "./draft-request.js";
import type { Finding } from "./sunday-brief.js";

export interface ReminderDraft { readonly text: string; readonly role: string }

/** A pending request Planning Center shows as sent. An unsent one needs sending in Planning Center, not a reminder. */
export const canRemind = (f: Finding) => f.kind === "pending" && f.notification === "sent" && Boolean(f.person_id) && Boolean(f.position);

/**
 * Ozzie's own wording, in placeholder form. `date`: the church-local date (YYYY-MM-DD) of the service checked, named when
 * the service time wasn't read; without either it says "at the next service", never a fixed Sunday (decision 18).
 */
export function reminderDraft(finding: Finding, date?: string | null): ReminderDraft {
  if (!canRemind(finding)) throw new Error("Ozzie can only prepare a reminder for a request Planning Center shows as sent.");
  return Object.freeze({
    role: finding.position!.name,
    text: [
      "Hi [Volunteer A],",
      `Just following up on the request to serve as [Role] ${serviceOn(finding, date)}. Planning Center still shows it waiting for your answer. Could you let me know either way when you get a chance? It's completely fine to say no.`,
      "Thank you,\n[Your name]",
    ].join("\n\n"),
  });
}

/** Local only: the person's first name, the exact role and the sender. */
export function restoreReminder(draft: ReminderDraft, finding: Finding, names: Record<string, string>, sender: string): string {
  const id = finding.person_id ?? "";
  const first = (Object.hasOwn(names, id) ? names[id] ?? "" : "").trim().split(/\s+/u)[0] || "there";
  return draft.text.split("[Volunteer A]").join(first).split("[Role]").join(draft.role).split("[Your name]").join(sender.trim() || "[Your name]");
}
