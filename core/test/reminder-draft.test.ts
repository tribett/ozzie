import { describe, expect, it } from "vitest";
import { buildSundayBrief } from "../src/sunday-brief.js";
import { nov22Capture, PEOPLE } from "../src/fictional-sunday.js";
import type { SundayCapture } from "../src/sunday-capture.js";
import { canRemind, reminderDraft, restoreReminder } from "../src/reminder-draft.js";

const rules = { sundayLeads: [], checkInAfterSundaysInARow: 3 };
const pendingIn = (capture: SundayCapture) => buildSundayBrief(capture, rules, capture.completed_at).findings.find(f => f.kind === "pending")!;
function sent(): SundayCapture {
  const capture = nov22Capture();
  const members = capture.reads.find(r => r.collection === "team_members")!.body!.data as { id: string; attributes: Record<string, unknown> }[];
  members.find(m => m.id === "403")!.attributes.notification_sent_at = "2026-11-18T12:00:00Z";
  return capture;
}

describe("a reminder for a request with no answer yet", () => {
  it("fits only a request Planning Center shows as sent", () => {
    expect(canRemind(pendingIn(nov22Capture()))).toBe(false);
    expect(canRemind(pendingIn(sent()))).toBe(true);
    expect(() => reminderDraft(pendingIn(nov22Capture()))).toThrow();
    for (const f of buildSundayBrief(sent(), rules, sent().completed_at).findings.filter(x => x.kind !== "pending")) expect(canRemind(f)).toBe(false);
  });

  it("is written in placeholder form, easy to say no to, and restored on this Mac only", () => {
    const f = pendingIn(sent());
    const draft = reminderDraft(f);
    expect(draft.text).toContain("Hi [Volunteer A],");
    expect(draft.text).toContain("[Role]");
    expect(draft.text).toContain("It's completely fine to say no.");
    expect(draft.text).not.toMatch(/Cameron|Larkspur/u);
    const names = nov22Capture().names;
    const restored = restoreReminder(draft, f, names, "Pat");
    expect(restored.startsWith(`Hi ${names[PEOPLE.lyricsPending]!.split(" ")[0]},`)).toBe(true);
    expect(restored).toContain("Lyrics");
    expect(restored).toContain("Thank you,\nPat");
    expect(restored).not.toContain("Larkspur");
    expect(restoreReminder(draft, f, {}, "")).toMatch(/^Hi there,[\s\S]*\[Your name\]$/u);
  });

  it("names the service's own time or date, whatever day it is, and never calls it Sunday otherwise (decision 18)", () => {
    const f = pendingIn(sent());
    const at = new Date(f.position!.interval!.starts_at).toLocaleString("en-US", { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
    expect(reminderDraft(f).text).toContain(`serve as [Role] on ${at}.`);
    // No service time read: the service's own date when it's known, otherwise the next service.
    const untimed = { ...f, position: { ...f.position!, interval: null } };
    expect(reminderDraft(untimed, "2026-11-25").text).toContain("serve as [Role] on Wednesday, November 25.");
    expect(reminderDraft(untimed, "2026-11-22").text).toContain("serve as [Role] on Sunday, November 22.");
    expect(reminderDraft(untimed).text).toContain("serve as [Role] at the next service.");
    for (const text of [reminderDraft(untimed, "2026-11-25").text, reminderDraft(untimed).text, reminderDraft(untimed, "not a date").text]) {
      expect(text).not.toMatch(/Sunday|this week/u);
    }
  });
});
