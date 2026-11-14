import { describe, expect, it } from "vitest";
import {
  acceptAskReply, ASK_MAX_TOKENS, ASK_SYSTEM, AskSession, buildAskContext, containsNameWord, hasContactDetail, MAX_USER_CHARS, prepareAsk,
  REFUSALS, restoreAnswer, suggestedQuestions, type AskContext, type AskedQuestion,
} from "../src/ask.js";
import { containsName, fold } from "../src/draft-request.js";
import { buildSundayBrief, type SundayBrief } from "../src/sunday-brief.js";
import { LATER, nov22Capture, nov22LaterCapture, PEOPLE, SERVICE, TEAMS } from "../src/fictional-sunday.js";
import { decide } from "../src/sunday-decisions.js";
import { richContext } from "./ask-rich.js";
import { evaluateAttentionImport, type AttentionReport } from "../src/attention-import/index.js";
import { harborAttentionImport } from "../src/fictional-attention.js";

const capture = nov22Capture();
const rules = { sundayLeads: [], checkInAfterSundaysInARow: 3 };
const fictional = () => buildSundayBrief(capture, rules, capture.completed_at, true);
const live = () => buildSundayBrief(capture, rules, "2026-11-20T15:05:00Z");
const attention = evaluateAttentionImport(harborAttentionImport()) as AttentionReport;
const TZ = { timeZone: "America/New_York" };
const LABELS = /\[(?:Person \d+|Role \d+|Your name|a team member)\]/g;
const bare = (text: string) => text.replace(LABELS, " ");
const contextFor = (session: AskSession, brief: SundayBrief = fictional(), names: Record<string, string> = capture.names, organization = capture.organization) =>
  buildAskContext(session, { brief, names, organization, attention }, TZ)!;
function asked(question: string, session = new AskSession(), context = contextFor(session)): AskedQuestion {
  const prepared = prepareAsk(session, context, question);
  if (!prepared.ok) throw new Error(`refused: ${prepared.refusal}`);
  return prepared.asked;
}
const refusal = (question: string, session = new AskSession(), context = contextFor(session)) => {
  const prepared = prepareAsk(session, context, question);
  return prepared.ok ? null : prepared.refusal;
};
/** The draft-request test's leak check: 3+ letter parts anywhere, 2-letter parts as words. */
const leaks = (text: string, part: string) => {
  const t = fold(bare(text)), p = fold(part);
  return p.length >= 3 || /[\p{Script=Han}\p{Script=Hangul}]/u.test(p) ? t.includes(p) : new RegExp(`(?<!\\p{L})${p}(?!\\p{L})`, "u").test(t);
};
const hard: Record<string, string>[] = [
  { "1": "Mary-Kate Fictional" }, { "1": "Shannon O’Brien" }, { "1": "José Ñandú" }, { "1": "İlker Yılmaz" },
  { "1": "김민수" }, { "1": "王伟" }, { "1": "田中" }, { "1": "Sam Young", "2": "Jo Hall" }, { "1": "Maria de la Cruz" },
];
const parts = (names: Record<string, string>) => Object.values(names).flatMap(n => n.split(/[\s-]+/));
function synthetic(roles: string[], ids: string[]): SundayBrief {
  return {
    mode: "live", plan: { id: "1", title: "Riley's big Sunday", dates: "November 22, 2026", sort_date: "2026-11-22T09:30:00Z", date: "2026-11-22", starts_at: SERVICE.starts_at },
    time_zone: "America/New_York", checked_at: "2026-11-20T15:00:00Z", completed_at: "2026-11-20T15:00:10Z", status: "findings", stale: false, sources: { reads: 4, failed: [] },
    positions: [],
    findings: roles.map((name, i) => ({
      id: `need:${i}`, key: `need:${i}`, kind: "needs-people", tone: "decision", position: { id: String(i), team_id: String(i), name, interval: SERVICE }, remaining: 1,
      people: { suggestions: ids.map(person_id => ({ person_id, reasons: ["Recorded team membership, role eligibility and availability; no overlapping serving assignment in checked scope. Willingness is not established."] })), conflicts: [], unverified: [], left_out: [] },
      why: [`Planning Center reports 1 remaining request for ${name}.`],
    })),
    not_checked: [],
  };
}

describe("Ask facts", () => {
  it("are codes, counts, times and labels only, pinned to what the native guard is tested with", () => {
    const context = contextFor(new AskSession());
    // Same text as core/native-auth/src/model_tests.rs FICTIONAL_FACTS.
    expect(context.facts).toBe([
      "S | X | 2026-11-20 10:00 | 26 | 0",
      "D | 2026-11-22",
      "F1 | N | [Role 1] | 2026-11-22 09:30-10:30 | 1",
      "F1 | s | [Person 1] | t",
      "F1 | c | [Person 2] | q",
      "F1 | v | [Person 3] | r",
      "F1 | x | [Person 4] | b",
      "F1 | x | [Person 5] | o",
      "F1 | y | [Person 6]",
      "F1 | L | -",
      "F2 | N | [Role 2] | 2026-11-22 09:30-10:30 | 1",
      "F2 | y | [Person 7]",
      "F2 | L | [Person 8]",
      "F3 | W | [Role 3] | 2026-11-22 09:30-10:30 | [Person 9] | n",
      "F4 | K | [Person 6] | 3",
      "E | X | 2026-11-19 09:00",
      "E1 | l | 2026-11-19 19:00 | n",
    ].join("\n"));
    for (const part of Object.values(capture.names).flatMap(n => n.split(" "))) expect(fold(context.facts)).not.toContain(fold(part));
    expect(context.people.get("[Person 1]")).toBe(PEOPLE.riley);
    expect([...context.roles]).toEqual([["[Role 1]", "Greeter"], ["[Role 2]", "Nursery"], ["[Role 3]", "Lyrics"]]);
    // Nursery's team leader is a placeholder like everyone else; Greeter's team lists none.
    expect(context.people.get("[Person 8]")).toBe(PEOPLE.nurseryLeader);
    expect(context.gaps).toEqual([]);
  });

  it("use every line kind in a fixed shape, pinned for the native grammar check", () => {
    const rich = richContext();
    // Same text as core/native-auth/src/model_tests.rs RICH_FACTS, which checks every line against fact_line_ok.
    expect(rich.facts).toBe([
      "S | L | 2026-11-20 10:00 | 26 | 1",
      "D | 2026-11-22",
      "F1 | N | [Role 1] | 2026-11-22 09:30-10:30 | 1",
      "F1 | v | [Person 1] | n",
      "F1 | v | [Person 2] | n,q",
      "F1 | v | [Person 3] | n,r",
      "F1 | x | [Person 4] | n,b",
      "F1 | x | [Person 5] | n,o",
      "F1 | y | [Person 6]",
      "F1 | L | ?",
      "F1 | H | o",
      "F2 | N | [Role 2] | 2026-11-22 09:30-10:30 | 1",
      "F2 | y | [Person 7]",
      "F2 | L | [Person 8]",
      "F3 | M | [Role 2] | 2026-11-22 09:30-10:30",
      "F3 | w | [Person 1]",
      "F3 | L | [Person 8]",
      "F4 | W | [Role 3] | 2026-11-22 09:30-10:30 | [Person 9] | n",
      "F5 | K | [Person 6] | 3",
      "F6 | G | 1 | -",
      "F7 | U | [Role 2] | 2026-11-22 09:30-10:30",
      "F7 | L | [Person 8]",
    ].join("\n"));
    expect([...rich.roles]).toEqual([["[Role 1]", "Greeters (9:30) & Hosts"], ["[Role 2]", "Nursery"], ["[Role 3]", "Prayer Team"]]);
    expect(rich.facts).not.toMatch(/Tom|husband|555|Riley|Prayer|Greeter|Nursery/);
  });

  it("date the Sunday from sort_date's own date part: Planning Center gives it as local wall-clock time, never an instant", () => {
    // An early service: read as a UTC instant, 00:30Z would be Saturday evening anywhere west of UTC.
    const early = nov22Capture();
    (early.reads.find(r => r.collection === "plan")!.body!.data as { attributes: { sort_date: string } }).attributes.sort_date = "2026-11-22T00:30:00Z";
    const brief = buildSundayBrief(early, rules, early.completed_at, true);
    for (const timeZone of ["America/Los_Angeles", "Pacific/Honolulu", "Asia/Tokyo"]) {
      const facts = buildAskContext(new AskSession(), { brief, names: early.names, organization: early.organization }, { timeZone })!.facts;
      expect(facts.split("\n")[1]).toBe("D | 2026-11-22");
    }
  });

  it("send every position name as [Role N], never verbatim, so a name the roster doesn't hold can't travel in one", () => {
    // Coordinator decision 2026-11-13 (review M3): "Pastor Dave's Class" names someone the roster may not hold.
    const roles = ["Greeter 555 123 4567", "Greeter ５５５-１２３４", "riley＠example.org", "Ushers\tDoors", "Coffee ☕", "x".repeat(81),
      "Greeter: riley@example.org", "Greeter 555/123/4567", "Greeter ٥٥٥١٢٣٤٥٦٧", "Pastor Dave's Class", "Kids - Dana Okafor's team",
      "Kids' Check-In (9:30)", "Sound/Tech #2", "Greeter"];
    const context = buildAskContext(new AskSession(), { brief: synthetic(roles, ["1"]), names: { "1": "Avery Fictional" }, organization: "9" }, TZ)!;
    expect([...context.roles.values()].sort()).toEqual([...roles].sort());
    for (const line of context.facts.split("\n").filter(l => / \| N \| /.test(l))) expect(line).toMatch(/^F\d+ \| N \| \[Role \d+\] \| /);
    expect(context.facts).not.toMatch(/555|５|＠|@|\t|☕|٥|Dave|Dana|Okafor|Kids|Sound|Greeter|Check/);
  });

  it("never carry the plan title, the brief's own wording or any source text", () => {
    const brief = fictional();
    const facts = contextFor(new AskSession(), brief).facts;
    expect(facts).not.toContain("Ozzie Demo");
    for (const why of brief.findings.flatMap(f => f.why)) expect(facts).not.toContain(why);
    expect(facts).not.toMatch(/Recorded|blockout|Possible conflict|orientation|Fellowship|plumbing|password/i);
  });

  it("include the fictional email import only beside the fictional Sunday example", () => {
    expect(contextFor(new AskSession(), fictional()).facts).toContain("E1 | l |");
    const real = contextFor(new AskSession(), live());
    expect(real.facts).not.toMatch(/^E/m);
    expect(real.facts.startsWith("S | L |")).toBe(true);
    expect(real.links.some(l => l.page === "today")).toBe(false);
  });

  it("keep each person's label for the whole session, per church", () => {
    const session = new AskSession();
    const first = contextFor(session), second = contextFor(session, live());
    expect([...second.people]).toEqual([...first.people]);
    // A person a question is about keeps the label they have in the facts.
    expect(asked("Is Riley free?", session, second).sent).toBe("Is [Person 1] free?");
    // Someone on the roster but not in the facts gets a new label, still never a name.
    const roster = { ...capture.names, "999": "Quinn Fictional" };
    const quinn = asked("Is Quinn around?", session, contextFor(session, live(), roster));
    expect(quinn.sent).toBe("Is [Person 10] around?");
    expect(quinn.people.get("[Person 10]")).toBe("999");
    expect(asked("Is Quinn around?", session, contextFor(session, fictional(), roster)).sent).toBe("Is [Person 10] around?");
    // Another church's person with the same id is a different person.
    const other = contextFor(session, fictional(), capture.names, "2002");
    expect(other.people.get("[Person 1]")).toBeUndefined();
  });

  it("send position names holding a roster name part, religious wording, brackets or a bar as [Role N], restored exactly", () => {
    for (const names of hard) {
      const roles = parts(names).map(p => `Setup ${p} Team`);
      const session = new AskSession();
      const context = buildAskContext(session, { brief: synthetic([...roles, "Greeter"], Object.keys(names)), names, organization: "9" }, TZ)!;
      for (const part of parts(names)) expect(leaks(context.facts, part), `${part} in ${context.facts}`).toBe(false);
      expect([...context.roles.values()].sort()).toEqual([...roles, "Greeter"].sort());
      const role = roles[0]!, label = [...context.roles].find(([, r]) => r === role)![0];
      const question = asked(`Who could cover ${role}?`, session, context);
      expect(question.sent).toBe(`Who could cover ${label}?`);
      expect(restoreAnswer(acceptAskReply(`${label} still needs one more.`, question), "").body).toBe(`${role} still needs one more.`);
    }
    const odd = ["Prayer Team", "Scripture Reading", "Ushers | Doors", "Greeter [A]", "Greeter ［A］", "Set​up", "Call 555-123-4567"];
    const oddSession = new AskSession();
    const context = buildAskContext(oddSession, { brief: synthetic(odd, ["1"]), names: { "1": "Avery Fictional" }, organization: "9" }, TZ)!;
    expect([...context.roles.values()].sort()).toEqual([...odd].sort());
    for (const role of odd) expect(context.facts).not.toContain(role);
    // A position name holding a phone number is still asked about as its label.
    expect(asked("Who could cover Call 555-123-4567?", oddSession, context).sent).toMatch(/^Who could cover \[Role \d+\]\?$/);
  });

  it("map every coverage reason to a code and never pass unknown reason text", () => {
    const brief = synthetic(["Greeter"], ["1"]);
    brief.findings[0]!.people!.suggestions[0]!.reasons = ["Something new the engine says about Riley.", "Recorded overlapping blockout."];
    const context = buildAskContext(new AskSession(), { brief, names: { "1": "Riley Fictional" }, organization: "9" }, TZ)!;
    expect(context.facts).toContain("F1 | s | [Person 1] | ?,b");
    expect(context.facts).not.toMatch(/Something|Riley/);
  });

  it("label failed reads, recordings and shortened facts as gaps (Worth a look)", () => {
    const failed = nov22Capture();
    failed.reads.find(r => r.collection === "person_blockouts")!.outcome = "provider_failure";
    const recording = { ...nov22Capture(), kind: "recording" as const };
    const gaps = (c: typeof failed) => contextFor(new AskSession(), buildSundayBrief(c, rules, "2026-11-20T15:05:00Z")).gaps;
    expect(gaps(failed).join(" ")).toContain("1 Planning Center read didn't complete.");
    expect(gaps(recording)).toContain("This is a saved recording, not a current check.");
    const crowd = Array.from({ length: 400 }, (_, i) => String(1000 + i));
    const big = synthetic(["Greeter"], []);
    big.findings[0]!.people!.left_out = crowd.map(person_id => ({ person_id, reasons: ["Recorded overlapping blockout."] }));
    const names = Object.fromEntries(crowd.map(id => [id, `Person${id} Fictional`]));
    const context = buildAskContext(new AskSession(), { brief: big, names, organization: "9" }, TZ)!;
    expect(context.facts.length).toBeLessThan(MAX_USER_CHARS - 600);
    expect(context.facts).toMatch(/\nZ \| \d+$/);
    expect(context.gaps).toContain("Some details were left out to keep the question short.");
  });

  it("carry a Sunday decision's choice and reopened state, never the reason a person typed", () => {
    const session = new AskSession();
    const brief = fictional();
    const greeter = brief.findings.find(f => f.kind === "needs-people" && f.position?.name === "Greeter")!;
    const nursery = brief.findings.find(f => f.kind === "needs-people" && f.position?.name === "Nursery")!;
    const typed = ["Riley Fictional's husband Tom Example will cover, call 555-0100", "Tom Example said yes", "Jordan's wife Dana is filling in"];
    const first = decide(greeter, "not-needed", typed[1]!, "2026-11-20T15:08:00Z");
    const decisions = [decide(greeter, "covered-outside", typed[0]!, "2026-11-20T15:10:00Z", first), decide(nursery, "covered-outside", typed[2]!, "2026-11-20T15:11:00Z")];
    expect(decisions[0]!.earlier[0]!.reason).toBe(typed[1]);
    const sources = { brief, names: capture.names, organization: capture.organization, attention, decisions };
    const context = buildAskContext(session, sources, TZ)!;
    expect(context.facts).toContain("F1 | H | o");
    expect(context.facts).toContain("F2 | H | o");
    // A later check that changed Nursery reopens that decision, and says so.
    const later = buildAskContext(session, { ...sources, brief: buildSundayBrief(nov22LaterCapture(), rules, LATER, true) }, TZ)!;
    expect(later.facts).toMatch(/^F\d \| H \| o \| r$/m);
    for (const c of [context, later]) {
      const { user } = asked("Is Greeter settled for Sunday?", session, c).request;
      for (const word of ["Tom", "husband", "Example", "Dana", "wife", "555", "said yes", "filling"]) expect(user, word).not.toContain(word);
      for (const reason of typed) expect(user).not.toContain(reason);
    }
  });

  it("list team leaders and pending leads as placeholders, and say when leaders couldn't be read", () => {
    const session = new AskSession();
    const withLead = buildSundayBrief(capture, { ...rules, sundayLeads: [{ team_id: TEAMS.nursery, lead_position: "Nursery Lead" }] }, capture.completed_at, true);
    const missing = withLead.findings.find(f => f.kind === "lead-missing")!;
    missing.pending_leads = [PEOPLE.riley];
    const context = contextFor(session, withLead), facts = context.facts.split("\n");
    const nurseryRole = [...context.roles].find(([, name]) => name === "Nursery")![0];
    const lead = facts.find(l => l.includes(` | M | ${nurseryRole} | `))!.split(" | ")[0];
    expect(facts).toContain(`${lead} | w | ${session.person(capture.organization, PEOPLE.riley)}`);
    expect(facts).toContain(`${lead} | L | ${session.person(capture.organization, PEOPLE.nurseryLeader)}`);
    const unread = nov22Capture();
    unread.reads.find(r => r.collection === "team_leaders" && r.team_id === TEAMS.nursery)!.outcome = "timeout";
    expect(contextFor(new AskSession(), buildSundayBrief(unread, rules, unread.completed_at, true)).facts).toContain("F2 | L | ?");
    const question = asked("Draft a note to the Nursery team leader");
    expect(question.draft).toBe(true);
    const answer = restoreAnswer(acceptAskReply("Here is a note for [Person 8].\nDraft note:\nHi [Person 8], Nursery still needs one more person this Sunday. Do you know who we could ask?\n\nThanks,\n[Your name]", question), "Pat");
    expect(answer.body).toBe("Here is a note for Jordan Ashdown.");
    expect(answer.draft).toContain("Hi Jordan, Nursery still needs");
  });

  it("call an old live check out as a gap", () => {
    const old = buildSundayBrief(capture, rules, "2026-11-20T17:00:00Z");
    expect(old.stale).toBe(true);
    const context = contextFor(new AskSession(), old);
    expect(context.gaps).toContain("This check is more than 30 minutes old, so it may not be current.");
    expect(context.facts).toMatch(/^F\d \| G \| 0 \| s$/m);
  });

  it("only facts built here can be asked about", () => {
    const forged = { ...contextFor(new AskSession()), facts: "S | L | Riley Fictional" } as AskContext;
    expect(() => prepareAsk(new AskSession(), forged, "Who is free?")).toThrow(/Only facts Ozzie built/);
    expect(buildAskContext(new AskSession(), { brief: null, names: {}, organization: "" })).toBeNull();
  });
});

describe("the question", () => {
  it("hides an answer using a word as a name only when the roster really has that name", () => {
    expect(containsName(ASK_SYSTEM, capture.names)).toBe(false);
    const reply = "In the fictional email import, an event needs a location decision.";
    expect(() => acceptAskReply(reply, asked("What needs a decision?"))).not.toThrow();
    const session = new AskSession(), names = { "1": "Riley Fictional" };
    const context = buildAskContext(session, { brief: synthetic(["Greeter"], ["1"]), names, organization: "9" }, TZ)!;
    expect(() => acceptAskReply(reply, asked("What needs a decision?", session, context))).toThrow(/name the AI was never given/);
  });

  it("is sent as the fixed system text, the facts and the placeholder-form question", () => {
    const session = new AskSession();
    const context = contextFor(session);
    const question = asked("Who could cover nursery?", session, context);
    expect(question.request).toEqual({ system: ASK_SYSTEM, user: `${context.facts}\nQ | Who could cover [Role 2]?`, max_tokens: ASK_MAX_TOKENS });
    expect(question.draft).toBe(false);
    for (const q of ["What still needs a decision this Sunday?", "Draft a note to the First Impressions team leader"]) expect(asked(q).sent).toBe(q);
    // Position names in the question become the labels the facts use.
    expect(asked("Why is Greeter flagged?").sent).toBe("Why is [Role 1] flagged?");
    expect(asked("Are the greeters covered, and nursery?").sent).toBe("Are the [Role 1] covered, and [Role 2]?");
    expect(asked("Draft a note to the Greeter team leader").draft).toBe(true);
  });

  it("replaces roster names however they are typed", () => {
    for (const [typed, sent] of [
      ["Is Riley free?", "Is [Person 1] free?"],
      ["is RILEY free", "is [Person 1] free"],
      ["Is Ríley free?", "Is [Person 1] free?"],
      ["Is Ｒｉｌｅｙ free?", "Is [Person 1] free?"],
      ["Is Ri​ley free?", "Is [Person 1] free?"],
      ["Is Riley Thornbury free?", "Is [Person 1] free?"],
      ["Thornbury, Riley: free?", "[Person 1]: free?"],
      ["What is Riley's other role?", "What is [Person 1]'s other role?"],
      ["Riley/Casey, either?", "[Person 1] / [Person 2], either?"],
      ["(Riley) maybe?", "([Person 1]) maybe?"],
      ["Are the Rileys around?", "Are the [Person 1] around?"],
      ["Can R.i.l.e.y help?", "Can [Person 1] help?"],
      ["Can R i l e y help?", "Can [Person 1] help?"],
      // Sam is [Person 4] in the facts (left out: a blockout covers the time).
      ["Can Sam help?", "Can [Person 4] help?"],
      ["Is sam's blockout real?", "Is [Person 4]'s blockout real?"],
      ["Ask SAM about Greeter", "Ask [Person 4] about [Role 1]"],
    ]) expect(asked(typed!).sent, typed).toBe(sent);
  });

  it("matches names as whole words, so ordinary words that contain a name go through unchanged", () => {
    // Coordinator decision: substring matching refused "same" for Sam, "time" for Tim, "will" inside "willing".
    for (const q of ["Who could cover at the same time as the 9:30 service?", "Is anyone willing to swap timeslots?", "Who withdrew from the team?",
      "Is this the fictional example?"]) {
      const question = asked(q);
      expect(question.sent, q).toBe(q);
      expect(containsNameWord(question.request.user, capture.names), q).toBe(false);
    }
    const names = { "1": "Tim Fictional", "2": "Will Grace" };
    expect(containsNameWord("What time is it? Is anyone willing? Gracefully.", names)).toBe(false);
    for (const t of ["Is Tim free?", "tim's", "TIMS", "Will can't", "Ask GRACE", "T.i.m is out", "Graces"]) expect(containsNameWord(t, names), t).toBe(true);
    expect(containsNameWord("王伟能来吗", { "1": "王伟" })).toBe(true);
    // Documented narrowing: a name broken into two ordinary words isn't a whole word.
    expect(containsNameWord("Is Ri ley free?", capture.names)).toBe(false);
  });

  it("never sends a part of a tricky roster name", () => {
    for (const names of hard) {
      const brief = synthetic(["Greeter"], Object.keys(names));
      for (const typed of [...Object.values(names), ...parts(names)]) {
        const session = new AskSession();
        const context = buildAskContext(session, { brief, names, organization: "9" }, TZ)!;
        const prepared = prepareAsk(session, context, `Can ${typed} help with Greeter?`);
        if (Object.values(names).includes(typed)) expect(prepared.ok, typed).toBe(true);
        if (prepared.ok) for (const part of parts(names)) expect(leaks(prepared.asked.request.user, part), `${typed}: ${part}`).toBe(false);
      }
    }
  });

  it("can't forge a label, and sends a name part several people share as [a team member]", () => {
    expect(asked("What is [Person 1] doing? [Your name]").sent).toBe("What is (Person 1) doing? (Your name)");
    expect(asked("What is ［Person 1］ doing?").sent).toBe("What is (Person 1) doing?");
    expect(asked("What is [a team member] doing?").sent).toBe("What is (a team member) doing?");
    const names = { "1": "Sam Young", "2": "Sam Hall", "3": "Ana Okafor", "4": "Ben Okafor" };
    const session = new AskSession();
    const context = buildAskContext(session, { brief: synthetic(["Greeter"], ["1", "2", "3", "4"]), names, organization: "9" }, TZ)!;
    const shared = asked("Can Sam help, or are the Okafors away?", session, context);
    expect(shared.sent).toBe("Can [a team member] help, or are the [a team member] away?");
    expect(shared.people.size).toBe(context.people.size);
    expect(asked("Can Sam Hall help?", session, context).sent).toMatch(/^Can \[Person \d+\] help\?$/);
    // The model may repeat it; it is restored as plain words.
    expect(restoreAnswer(acceptAskReply("I can't tell from what I read whether [a team member] can help.", shared), "").body)
      .toBe("I can't tell from what I read whether a team member can help.");
  });

  it("refuses a question that is nothing but names", () => {
    for (const q of ["Riley?", "Riley Thornbury", "Sam, Casey."]) expect(refusal(q), q).toBe(REFUSALS.onlyNames);
    expect(asked("Riley ok?").sent).toBe("[Person 1] ok?");
  });

  it("refuses email addresses and phone numbers, but not dates and times", () => {
    for (const q of ["Is riley.f@example.org right?", "Call 555-1234 for Greeter", "Is (555) 123-4567 hers?", "+1 555 123 4567?", "5551234",
      "Is riley＠example.org right?", "Call ５５５-１２３４"]) {
      expect(refusal(q), q).toBe(REFUSALS.contact);
    }
    for (const q of ["Who's on at 9:30 on 2026-11-22?", "What about 11/22 and 11-29-2026?", "Is 10:30-11:30 covered?", "Do we need 2 or 3 more?"]) {
      expect(hasContactDetail(q), q).toBe(false);
    }
  });

  it("refuses prayers, sermons, scripture and devotionals, sending or changing anything, and ranking people", () => {
    for (const q of ["Write a prayer for the volunteers", "Give me a verse for Sunday", "Draft a devotional for the team", "Pray for Riley",
      "Suggest a sermon idea", "What does John 3:16 say?", "Could you share a short blessing?"]) expect(refusal(q), q).toBe(REFUSALS.religious);
    for (const q of ["Send Riley a note", "Text Casey about Greeter", "Can you schedule Riley for Greeter?", "Please confirm Riley",
      "Draft a note and then send it to Riley", "Could you go ahead and update Planning Center?", "Ozzie, email the team", "Remove Casey from Usher"]) {
      expect(refusal(q), q).toBe(REFUSALS.send);
    }
    for (const q of ["Who is the most reliable volunteer?", "Rank the greeters", "Who's the best fit for Greeter?", "Who is at risk of burning out?"]) {
      expect(refusal(q), q).toBe(REFUSALS.rank);
    }
    for (const q of ["Who's on the prayer team?", "Is there a prayer team this Sunday?", "Should I send Riley a note?", "Who will text Casey?",
      "Draft a text to the Greeter team leader", "What happens if Riley says no?", "What's the best way to cover Greeter?"]) {
      expect(prepareAsk(new AskSession(), contextFor(new AskSession()), q).ok, q).toBe(true);
    }
  });

  it("every request that can be sent holds no roster name as a word anywhere in the message", () => {
    for (const q of ["Is Riley free?", "Who could cover nursery?", "Thornbury, Riley: free?", "Draft a note to Casey", "Can R.i.l.e.y help?"]) {
      const { user } = asked(q).request;
      expect(containsNameWord(user, capture.names), q).toBe(false);
      // These happen to pass the stricter rewording check too.
      expect(containsName(user.replace(LABELS, ""), capture.names) || containsName(bare(user), capture.names), q).toBe(false);
      expect(user.length).toBeLessThanOrEqual(MAX_USER_CHARS);
    }
  });

  it("refuses empty and overlong questions", () => {
    expect(refusal("   ")).toBe(REFUSALS.empty);
    expect(refusal("Who could cover Greeter? ".repeat(30))).toBe(REFUSALS.long);
  });
});

describe("checking an answer before it is shown", () => {
  const greeter = () => asked("Who could cover Greeter?");
  it("restores labels to names on this Mac", () => {
    const answer = restoreAnswer(acceptAskReply("[Person 1] has no overlap found for Greeter. [Person 2] has a possible conflict at the same time.", greeter()), "Pat");
    expect(answer.body).toBe("Riley Thornbury has no overlap found for Greeter. Casey Pemberly has a possible conflict at the same time.");
    expect(answer.draft).toBeNull();
    expect(answer.links.map(l => l.finding?.position?.name)).toEqual(["Greeter"]);
  });
  it("splits out a drafted note, restored with first names and the sender", () => {
    const question = asked("Draft a note to Riley about Greeter");
    expect(question.sent).toBe("Draft a note to [Person 1] about [Role 1]");
    const reply = "Here's a short note you could send.\n**Draft note:**\nHi [Person 1], we still need one more Greeter this Sunday. Could you help? It's fine to say no.\n\nThanks,\n[Your name]";
    const answer = restoreAnswer(acceptAskReply(reply, question), "Pat");
    expect(answer.body).toBe("Here's a short note you could send.");
    expect(answer.draft).toBe("Hi Riley, we still need one more Greeter this Sunday. Could you help? It's fine to say no.\n\nThanks,\nPat");
    expect(restoreAnswer(acceptAskReply(reply, question), " ").draft).toContain("Thanks,\n[Your name]");
    // A draft question answered without the marker is still shown as a draft.
    const whole = restoreAnswer(acceptAskReply("Hi [Person 1], could you help as Greeter?", question), "Pat");
    expect([whole.body, whole.draft]).toEqual(["", "Hi Riley, could you help as Greeter?"]);
  });
  it("notices when the facts don't cover the question", () => {
    expect(restoreAnswer(acceptAskReply("I can’t tell from what I read. The facts don't list team leaders.", greeter()), "").notCovered).toBe(true);
    expect(restoreAnswer(acceptAskReply("[Person 1] has no overlap found.", greeter()), "").notCovered).toBe(false);
  });
  it("accepts ordinary wording that only resembles a name or a claim", () => {
    for (const reply of ["Planning Center records that the request was sent; there's no answer yet.", "Nothing has been sent or changed.",
      "[Person 2] is pending elsewhere at the same time, at 9:30.", "I can't send messages, but I can draft one.", "[Person 7] has been scheduled 3 Sundays in a row."]) {
      expect(() => acceptAskReply(reply, greeter()), reply).not.toThrow();
    }
  });
  it.each([
    ["an unknown label", "[Person 99] could help.", /didn't ask about/],
    ["a bracketed name", "[Bob] could help.", /didn't ask about/],
    ["a role label never issued", "[Role 9] could help.", /didn't ask about/],
    ["a label glued to letters", "Ri[Person 1]ley could help.", /placeholders separate/],
    ["religious content", "[Person 1] could help. Praying for you!", /religious/],
    ["a verse reference", "[Person 1] could help (John 3:16).", /religious/],
    ["a claim of sending", "I've sent [Person 1] a note.", /sent or changed/],
    ["a claim of scheduling", "I scheduled [Person 1] for Greeter.", /sent or changed/],
    ["an offer to send", "I'll text [Person 1] now.", /sent or changed/],
    ["a claim about Planning Center", "Ozzie has updated Planning Center.", /sent or changed/],
    ["a draft announcing a change", "Draft note:\nHi [Person 1], you've been added to Greeter.", /sent or changed/],
    ["ranking", "[Person 1] is the best fit.", /ranked or scored/],
    ["a percentage", "[Person 1] is 80% likely to say yes.", /ranked or scored/],
    ["a roster name", "Avery could help too.", /name the AI was never given/],
    ["a disguised roster name", "AVÉRY could help too.", /name the AI was never given/],
    ["a possessive roster name", "Avery's free.", /name the AI was never given/],
    ["nothing", "   ", /wasn't usable/],
    ["far too much", "[Person 1] ".repeat(300), /wasn't usable/],
  ])("rejects %s", (_label, reply, problem) => {
    expect(() => acceptAskReply(reply, greeter())).toThrow(problem);
  });
  it("never checks or restores anything it didn't prepare", () => {
    const forged = { ...greeter() } as AskedQuestion;
    expect(() => acceptAskReply("[Person 1] could help.", forged)).toThrow(/Unknown question/);
    expect(() => restoreAnswer({ text: "[Person 1]", asked: greeter() }, "")).toThrow(/checked answer/);
  });
});

describe("suggested questions", () => {
  it("fit what was read and pass the boundary as asked", () => {
    const chips = suggestedQuestions(fictional());
    expect(chips).toEqual(["Who could cover Greeter?", "What still needs a decision this Sunday?", "Why is Greeter flagged?", "Draft a note to someone who could cover Greeter"]);
    for (const chip of chips) expect(prepareAsk(new AskSession(), contextFor(new AskSession()), chip).ok, chip).toBe(true);
    expect(suggestedQuestions(null)).toEqual([]);
  });
  it("send odd position names as the same [Role N] label the facts use (review L4)", () => {
    for (const role of ["Samwise  Room", "Kids  (Riley’s group)", "Ri ley Kids", "Thornbury\tKids", "Pastor Dave's Class", "Greeter 555/123/4567"]) {
      const brief = synthetic([role], ["n1"]);
      const session = new AskSession();
      const context = buildAskContext(session, { brief, names: { n1: "Sam Whitcombe", n2: "Riley Thornbury" }, organization: "1" }, TZ)!;
      const label = [...context.roles].find(([, name]) => name === role)![0];
      for (const chip of suggestedQuestions(brief)) {
        const { sent } = asked(chip, session, context);
        if (chip.includes("still needs a decision")) continue;
        expect(sent, chip).toContain(label);
        for (const word of role.match(/[\p{L}\p{N}]{3,}/gu)!) expect(fold(bare(sent)), `${chip}: ${word}`).not.toContain(fold(word));
      }
    }
  });
});

describe("review regressions (coordinator decisions 2026-11-13)", () => {
  const sent = (question: string, names: Record<string, string> = capture.names) => {
    const session = new AskSession();
    return asked(question, session, contextFor(session, fictional(), names));
  };
  it("finds a name touching an unspaced script, a digit or a symbol (H1, L3)", () => {
    for (const [typed, out] of [
      ["Rileyさんは日曜日に来られますか？", "[Person 1] さんは日曜日に来られますか?"],
      ["Riley Thornburyさんは日曜日に来られますか？", "[Person 1] さんは日曜日に来られますか?"],
      ["Riley的时间有冲突吗?", "[Person 1] 的时间有冲突吗?"],
      ["Riley님 이번 주 가능해요?", "[Person 1] 님 이번 주 가능해요?"],
      ["คุณRiley ว่างไหม", "คุณ [Person 1] ว่างไหม"],
      ["Is Riley2 free?", "Is [Person 1] 2 free?"],
      ["Is Riley² free?", "Is [Person 1] 2 free?"],
      // A symbol that becomes letters stays its own word: "Riley™" is sent as "[Person 1] TM".
      ["Is Riley™ free?", "Is [Person 1] TM free?"],
      ["Is Rıley free?", "Is [Person 1] free?"],
    ]) expect(sent(typed!).sent, typed).toBe(out);
    expect(sent("Is Rileyʹs slot open?").sent).toMatch(/^Is \[Person 1\] ʹs slot open\?$/);
    // Documented: letters glued to a name are part of the word, as typed.
    expect(containsNameWord("Is RileyTM free?", capture.names)).toBe(false);
  });
  it("finds names spelled out with wider gaps, for four letters or more (L2)", () => {
    for (const typed of ["Is R/i/l/e/y free?", "Is R, i, l, e, y free?", "Is R*i*l*e*y free?", "Is R . i . l . e . y free?"]) {
      expect(sent(typed).sent, typed).toBe("Is [Person 1] free?");
    }
    // Three-letter terms keep the narrow gaps, so lists like "T, i, m" aren't names.
    expect(containsNameWord("T, i, m", { "1": "Tim Fictional" })).toBe(false);
    expect(containsNameWord("T.i.m", { "1": "Tim Fictional" })).toBe(true);
  });
  it("finds stroked letters, ligatures and joined parts of a name (L1, L6)", () => {
    const roster = { ...capture.names, x1: "Søren Bjørnstad", x2: "Łukasz Nowak", x3: "Mary Kate Strauß", x4: "Maria de la Cruz" };
    for (const [typed, id] of [["Is Soren free?", "x1"], ["Is Bjornstad free?", "x1"], ["Is Søren free?", "x1"], ["Is Lukasz free?", "x2"],
      ["Is Strauss free?", "x3"], ["Is MaryKate free?", "x3"], ["Is Maria Delacruz free?", "x4"], ["Is Delacruz free?", "x4"]] as const) {
      const question = sent(typed, roster);
      expect(question.sent, typed).toMatch(/^Is \[Person \d+\] free\?$/);
      expect(question.people.get(question.sent.slice(3, -6)), typed).toBe(id);
    }
  });
  it("refuses phone numbers and email addresses in any digits and separators (M1)", () => {
    for (const q of ["Is the person at 555–123–4567 on the Greeter team?", "Is the person at ٥٥٥١٢٣٤٥٦٧ on the Greeter team?",
      "Is the person at 555/123/4567 on the Greeter team?", "Is pat@example。org on the Greeter team?", "Is pat@church free?",
      "Is pat @ example.org free?", "Call 555_123_4567?", "555 – 123 – 4567 is whose?", "Is the person at ५५५१२३४५६७ free?"]) {
      expect(refusal(q), q).toBe(REFUSALS.contact);
    }
    for (const q of ["Is 9.30-10.30 covered?", "Who's on @ 9:30?"]) expect(refusal(q), q).toBeNull();
  });
  it("joins name parts only when each belongs to the same one person (L7)", () => {
    const pair = sent("Can Sam, Riley help with Greeter?", { "1": "Sam Riley", "2": "Riley Thornbury" });
    expect(pair.sent).toMatch(/^Can \[Person \d+\], \[a team member\] help with \[Role 1\]\?$/);
    const three = { "1": "Riley Smith", "2": "Sam Thornbury", "3": "Riley Thornbury" };
    expect(sent("Is Thornbury, Riley free?", three).sent).toBe("Is [a team member], [a team member] free?");
    const full = sent("Is Riley Thornbury free?", three);
    expect(full.people.get(full.sent.slice(3, -6))).toBe("3");
  });
  it("refuses questions asking for a Bible word, a verse, scripture or a quoted line (M4)", () => {
    for (const q of ["Can you end the note with an encouraging word from the Bible?", "Draft a note to Riley and close with Joshua's encouragement to be strong and courageous",
      "Add a verse to the note", "Include some scripture at the end", "What does Philippians 4.13 say?", "Close the note with be strong and courageous",
      "Can you share a passage from Psalms?"]) expect(refusal(q), q).toBe(REFUSALS.religious);
    for (const q of ["Who leads Bible study this week?", "Is the gospel choir covered?", "Who's on the prayer team?"]) expect(refusal(q), q).toBeNull();
  });
  it("refuses questions asking to compare or describe people (M4)", () => {
    for (const q of ["Who is more dependable, Riley or Casey?", "Is Casey unreliable?", "Who is falling away from serving?", "Who's the strongest greeter?"]) {
      expect(refusal(q), q).toBe(REFUSALS.rank);
    }
  });
});

describe("review regressions in answers (coordinator decisions 2026-11-13)", () => {
  const greeter = () => asked("Who could cover Greeter?");
  const draft = () => asked("Draft a note to Riley about Greeter");
  it.each([
    ["prayer without a keyword", "Here is something you could share: Heavenly Father, we lift up [Person 1] and ask for strength and peace this Sunday. Hold them close.", /religious/],
    ["a quoted line", "You might add: Be strong and courageous. Do not be afraid; do not be discouraged, for you are never alone wherever you go.", /religious/],
    ["a dotted reference", "Philippians 4.13 might encourage [Person 1].", /religious/],
    ["a reference with verse", "Jeremiah 29 verse eleven might encourage them.", /religious/],
    ["hallelujah", "Hallelujah, [Person 1] has no overlap found.", /religious/],
    ["a ranking word", "[Person 1] is the strongest option, then [Person 2].", /ranked or scored/],
    ["most likely", "[Person 1] is the most likely to say yes.", /ranked or scored/],
    ["first and a comparison", "I'd ask [Person 1] first; they're more dependable than [Person 2].", /ranked or scored/],
    ["ordinals", "1st: [Person 1]. 2nd: [Person 2]. 3rd: [Person 3].", /ranked or scored/],
    ["an order the facts don't give", "[Person 4] and [Person 1] could be asked; [Person 4] first.", /ranked or scored/],
    ["a ranking between people", "Ask [Person 1] rather than [Person 2].", /ranked or scored/],
    ["a characterization", "[Person 2] has been unreliable lately and seems to be falling away.", /described a person/],
    ["let someone know", "I've let [Person 1] know you need help.", /sent or changed/],
    ["asked", "I asked [Person 1] and they can help.", /sent or changed/],
    ["a passive send", "Message sent to [Person 1].", /sent or changed/],
    ["a note that has gone", "Your note has been sent.", /sent or changed/],
    ["called", "I called [Person 1] this morning.", /sent or changed/],
    ["took care of it", "Done. I took care of it and [Person 1] is now on the schedule.", /sent or changed/],
  ])("rejects %s", (_label, reply, problem) => {
    expect(() => acceptAskReply(reply, greeter())).toThrow(problem);
  });
  it("rejects a draft that tells someone they were added", () => {
    for (const reply of ["Here you go.\nDraft note: Hi [Person 1], I've added you to the [Role 1] schedule for Sunday. Thanks! [Your name]",
      "Here you go.\nDraft note: Hi [Person 1], I added you to the [Role 1] schedule for Sunday. Thanks! [Your name]"]) {
      expect(() => acceptAskReply(reply, draft()), reply).toThrow(/sent or changed/);
    }
  });
  it("accepts ordinary wording near these checks", () => {
    for (const reply of ["[Person 1] and [Person 2] are both on the team; only they can say if they're free.",
      "Draft note: Hi [Person 1], I'm reaching out to see if you could help with [Role 1] this Sunday. It's completely fine to say no. [Your name]",
      "I've added a short draft below.", "[Person 9]'s request was sent; there's no answer yet.", "Let me know if you'd like a shorter note.",
      "[Person 6] has been scheduled 3 Sundays in a row; a check-in is about care.", "[Role 1] still needs one more, at 9:30 on Sunday."]) {
      expect(() => acceptAskReply(reply, greeter()), reply).not.toThrow();
    }
  });
  it("accepts labels wrapped in markdown emphasis and restores them (L7)", () => {
    const answer = restoreAnswer(acceptAskReply("**[Person 1]** has no overlap found for _[Role 1]_.", greeter()), "Pat");
    expect(answer.body).toBe("Riley Thornbury has no overlap found for Greeter.");
    expect(() => acceptAskReply("**[Person 1] has no overlap found.", greeter())).toThrow(/placeholders separate/);
  });
  it("restores someone it has no name for as a team member, and never greets 'someone' (L7)", () => {
    const names = Object.fromEntries(Object.entries(capture.names).filter(([id]) => id !== PEOPLE.riley));
    const session = new AskSession();
    const question = asked("Draft a note to the Greeter team", session, contextFor(session, fictional(), names));
    const answer = restoreAnswer(acceptAskReply("[Person 1] has no overlap found.\nDraft note: Hi [Person 1], could you help with [Role 1] this Sunday? It's fine to say no. [Your name]", question), "Pat");
    expect(answer.body).toBe("a team member has no overlap found.");
    expect(answer.draft).toBe("Hi there, could you help with Greeter this Sunday? It's fine to say no. Pat");
    const shared = { "1": "Sam Young", "2": "Sam Hall" };
    const sharedSession = new AskSession();
    const sam = asked("Draft a note to Sam about Greeter", sharedSession, contextFor(sharedSession, fictional(), shared));
    expect(sam.sent).toBe("Draft a note to [a team member] about [Role 1]");
    expect(restoreAnswer(acceptAskReply("Draft note: Hi [a team member], could you help? [Your name]", sam), "Pat").draft).toBe("Hi there, could you help? Pat");
  });
});
