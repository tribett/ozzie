import { describe, expect, it } from "vitest";
import { acceptModelReply, buildRewordRequest, fold, restoreDraft, templateDraft, type PlaceholderDraft } from "../src/draft-request.js";
import { buildSundayBrief } from "../src/sunday-brief.js";
import { nov22Capture, PEOPLE } from "../src/fictional-sunday.js";

const capture = nov22Capture();
const brief = buildSundayBrief(capture, { sundayLeads: [], checkInAfterSundaysInARow: 3 }, "2026-11-20T15:05:00Z");
const greeter = brief.findings[0]!;
const ctx = { finding: greeter, person_id: PEOPLE.riley };
const withRole = (name: string) => ({ ...ctx, finding: { ...greeter, position: { ...greeter.position!, name } } });
const wireOf = (r: { system: string; user: string }) => fold(r.system + "\n" + r.user);

// Rosters from the independent review's verified leak cases.
const hard: Record<string, string>[] = [
  { "1": "Mary-Kate Fictional" }, { "1": "Shannon O’Brien" }, { "1": "José Ñandú" }, { "1": "İlker Yılmaz" },
  { "1": "김민수" }, { "1": "王伟" }, { "1": "田中" }, { "1": "Sam Young", "2": "Jo Hall" }, { "1": "Maria de la Cruz" },
];

describe("placeholder boundary", () => {
  it("a request carries only placeholders, the role and the time — no roster name", () => {
    const req = buildRewordRequest(templateDraft(ctx, capture.names), "warmer", capture.names);
    for (const n of Object.values(capture.names).flatMap(n => n.split(" "))) expect(wireOf(req)).not.toContain(fold(n));
    expect(req.user).toContain("[Volunteer A]");
    expect(req.user).toContain("Greeter");
  });

  it("leader-typed text can never be sent, however it is shaped", () => {
    const forged = { text: "Hi Bob, can you help? [Volunteer A]", role: { sent: "Greeter", original: "Greeter" } } as PlaceholderDraft;
    expect(() => buildRewordRequest(forged, "shorter", capture.names)).toThrow(/Only Ozzie's own/);
    expect(() => buildRewordRequest(templateDraft(ctx, capture.names), "make it say hi to Bob" as never, capture.names)).toThrow(/offered rewording/);
  });

  it("a role that contains any roster name part is sent as [Role] and restored exactly", () => {
    for (const names of hard) {
      for (const part of Object.values(names).flatMap(n => n.split(/[\s-]+/))) {
        const role = `Setup ${part} Team`;
        const draft = templateDraft(withRole(role), names);
        expect(draft.role.sent).toBe("[Role]");
        const req = buildRewordRequest(draft, "casual", names);
        const word = new RegExp(`(?<!\\p{L})${fold(part)}(?!\\p{L})`, "u");
        expect(part.length >= 3 ? fold(req.user).includes(fold(part)) : word.test(fold(req.user))).toBe(false);
        expect(restoreDraft(draft, withRole(role), names, "Pat")).toContain(role);
      }
    }
    expect(templateDraft(withRole("Young Adults Hall Setup"), hard[7]!).role.sent).toBe("[Role]");
  });

  it("ordinary roles are not over-redacted", () => {
    expect(templateDraft(ctx, capture.names).role.sent).toBe("Greeter");
    for (const role of ["Room 12", "Parking Lot B", "Kids 4-5", "Grades 1, 2 & 3"]) expect(templateDraft(withRole(role), capture.names).role.sent, role).toBe(role);
  });

  it("a role that could read as contact details, or is too long for a note, is sent as [Role] and restored exactly", () => {
    // Ozzie managed refuses a reword with contact details (hosted review 2026-11-14, S5): "Rooms 101, 102 & 103" is nine
    // digits in short groups. A run of three digits, seven in all, or an @ (raw or NFKC) keeps the role on this Mac.
    for (const role of ["Rooms 101, 102 & 103", "Section 1100-1200", "Kids Grades 1, 2, 3, 4, 5, 6, 7", "Room １０１", "Help desk @ lobby", "Hall ﹫ east", "x".repeat(301)]) {
      const draft = templateDraft(withRole(role), capture.names);
      expect(draft.role.sent, role).toBe("[Role]");
      expect(buildRewordRequest(draft, "warmer", capture.names).user).not.toContain(role);
      expect(restoreDraft(draft, withRole(role), capture.names, "Pat")).toContain(role);
    }
  });

  it("never says this week or this Sunday: it names the service's own date, whenever it is", () => {
    const text = templateDraft(ctx, capture.names).text;
    expect(text).toContain(`for Greeter on ${new Date(greeter.position!.interval!.starts_at).toLocaleString("en-US", { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" })}.`);
    expect(text).toContain("Would you be able to help?");
    // No service time read: the Sunday's own date when it's known, otherwise just Sunday.
    const untimed = { ...ctx, finding: { ...greeter, position: { ...greeter.position!, interval: null } } };
    expect(templateDraft({ ...untimed, sunday: "2026-11-29" }, capture.names).text).toContain("for Greeter on Sunday, November 29.");
    expect(templateDraft(untimed, capture.names).text).toContain("for Greeter on Sunday.");
    for (const draft of [text, templateDraft(untimed, capture.names).text, templateDraft({ ...untimed, sunday: "2026-11-29" }, capture.names).text]) {
      expect(draft).not.toMatch(/this week|this Sunday/u);
    }
    // The date is no name and no placeholder: it goes for rewording like the time does.
    expect(buildRewordRequest(templateDraft({ ...untimed, sunday: "2026-11-29" }, capture.names), "warmer", capture.names).user).toContain("Sunday, November 29");
  });

  it("restores only its own three labels, using the trimmed first name", () => {
    const names = { [PEOPLE.riley]: "  Riley Fictional " };
    const out = restoreDraft(templateDraft(ctx, names), ctx, names, "Pat");
    expect(out.startsWith("Hi Riley,")).toBe(true);
    expect(out.endsWith("Thank you,\nPat")).toBe(true);
  });
});

describe("checking a model reply before it is shown", () => {
  const prev = () => templateDraft(ctx, capture.names);
  const ok = "Hi [Volunteer A]! We're one short for Greeter this Sunday. Could you help? No worries if not.\n\n[Your name]";
  it("accepts a reply that adds [Role] and restores it to the role name", () => {
    const reply = "Hi [Volunteer A], could you help as [Role] this Sunday? No pressure.\n\n[Your name]";
    expect(restoreDraft(acceptModelReply(reply, prev(), capture.names), ctx, capture.names, "Pat")).toContain("help as Greeter this Sunday");
  });
  it("accepts service times like 9:30 that look like chapter:verse", () => {
    const reply = "Hi [Volunteer A], we need one more Greeter on Sunday, November 22 at 9:30 AM. Could you help? No pressure.\n\n[Your name]";
    expect(() => acceptModelReply(reply, prev(), capture.names)).not.toThrow();
  });
  it("accepts a plain reworded note", () => {
    expect(restoreDraft(acceptModelReply(ok, prev(), capture.names), ctx, capture.names, "Pat")).toContain("Hi Riley!");
  });
  it.each([
    ["religious content", ok + " Praying for you!"],
    ["a verse reference", ok + " (John 3:16)"],
    ["a numbered-book reference", ok + " See 1 Cor 13:4."],
    ["a blessing", ok + " Blessings!"],
    ["a new placeholder", ok.replace("Could you help?", "[Person B] can't come. Could you help?")],
    ["a lost recipient", ok.replace("[Volunteer A]", "friend")],
    ["a label joined to letters", ok.replace("No worries if not.", "[Your name]-s note: no worries.")],
    ["a roster name", ok.replace("No worries", "Avery says no worries")],
    ["a name spelled with separators", ok.replace("No worries", "R.i.l.e.y and A v e r y say no worries")],
  ])("rejects %s", (_label, reply) => {
    expect(() => acceptModelReply(reply, prev(), capture.names)).toThrow(/current draft is unchanged/);
  });
});
