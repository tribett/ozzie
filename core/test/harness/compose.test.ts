// Structured answers (review 2026-11-14 section C): the model only chooses fact ids, and Ozzie writes the answer on
// this Mac from fixed sentences, in its own order, with drafts only ever the drafting tool's text. Fictional data.
import { describe, expect, it } from "vitest";
import type { AgentStepReply, AgentStepRequest, ModelStep, ToolEnvelope } from "../../src/harness/contract.js";
import { bundledSkills } from "../../src/harness/bundled-skills.js";
import {
  ALSO_ON_SUNDAY, alsoOnPage, backgroundSentence, BACKGROUND_OFF, BACKGROUND_ON_FILE, BACKGROUND_UNCONFIRMED, chosenSources, composeAnswer, DECISION_QUESTION, decisionsLeftOut, DRAFT_INTRO, isDecisionQuestion, KEPT_HERE,
  kidsAnswer, kidsQuestion, kidsWording, MEMBERS_UNREAD, NO_KIDS_TEAM, NOBODY_SCHEDULED, nobodyScheduled, NOTHING_OPEN, ON_SUNDAY, onPage, openDecisions, setAside, NOT_COVERED_MORE, CANT_TELL, NOT_FREE, NOT_RANKED, NOTHING_TO_DECIDE,
} from "../../src/harness/compose.js";
import { envelopeProblems } from "../../src/harness/fixed.js";
import { Harness } from "../../src/harness/index.js";
import { HarnessSession, restoreLabels, showTimes } from "../../src/harness/session.js";
import { HarnessTools, type HarnessData } from "../../src/harness/tools.js";
import { TsLoop } from "../../src/harness/ts-loop.js";
import { CHECKED, nov22Capture, TEAMS, withFictionalBackgroundChecks } from "../../src/fictional-sunday.js";
import type { SundayCapture, SundayRules } from "../../src/sunday-capture.js";
import { buildSundayBrief, sundayShownCount, type Finding } from "../../src/sunday-brief.js";
import { sundayOperations } from "../../src/operations-capture.js";
import { dayWords, SUNDAY_WORDS, UNKNOWN_WORDS, type DayWords } from "../../src/service-day.js";
import { wednesdayWithEverything } from "../fixtures/service-days/wednesday.js";
import type { CorrectionEntry } from "../../src/finding-feedback.js";
import { applyDecisions, decide } from "../../src/sunday-decisions.js";
import { allEnvelopes, crowded, FIXTURES, FRESH, harnessData, KIDS_RULES, LEAD_RULES, RULES } from "./fixtures.js";

const skills = await bundledSkills();
const signal = new AbortController().signal;
type Turn = (r: AgentStepRequest) => AgentStepReply;
const call = (name: string, args: Record<string, unknown> = {}): AgentStepReply => ({ content: "", tool_calls: [{ id: "c", name, arguments: JSON.stringify(args) }], finish: "tool_calls" });
const answer = (o: unknown): AgentStepReply => ({ content: JSON.stringify(o), tool_calls: [], finish: "stop" });
const results = (r: AgentStepRequest) => r.messages.flatMap(m => m.role === "tool" ? [JSON.parse(m.content) as { tool: string; payload: Record<string, unknown> }] : []);
const roleIn = (r: AgentStepRequest) => /\[Role \d+\]/u.exec(r.messages[1]!.content)![0];
type Person = { fact: string; person: string; status: string; role: string };

/** One question through the real harness with a scripted model; the answer composed and restored on this Mac. */
async function ask(question: string, turns: Turn[], data = harnessData()) {
  let n = 0;
  const model: ModelStep = async request => turns[n++]!(request);
  const h = new Harness({ workspace_id: "fictional", data, skills, runtime: new TsLoop(), model, now: () => FRESH, newId: () => "00000000-0000-4000-8000-0000000000aa" });
  const res = await h.ask(question);
  if (!res.ok) throw new Error(res.refusal);
  expect(res.outcome.status, `${question}: ${res.outcome.code}`).toBe("verified");
  const c = composeAnswer(res.outcome.answer!, res.outcome.evidence);
  return { ...c, restored: c.paragraphs.map(p => h.restore(p, { sender: "Pat" })), draftShown: c.draft ? h.restore(c.draft, { sender: "Pat", firstNames: true }) : null };
}

describe("who could help, as one line about the list (review K)", () => {
  it("says how many people the check listed, never in what order, counting those left out to fit", () => {
    // The app's card shows them alphabetically and Ask in person-id order: the line names neither.
    const envelope = (people: number, cut = 0): ToolEnvelope => ({
      tool: "sunday.who_could_help", source: "Planning Center Services", check_time: FRESH, completeness: cut ? "partial" : "complete",
      payload: {
        fact: "f1", asked_for: { role: "[Role 1]" },
        people: Array.from({ length: people }, (_, i) => ({ fact: `f${i + 2}`, role: "[Role 1]", person: `[Person ${i + 1}]`, status: "no overlap found" })),
        ...(cut ? { left_out_for_length: cut } : {}),
      },
    });
    const said = (e: ToolEnvelope) => composeAnswer(JSON.stringify({ answer: "facts", facts: ["f1"] }), [e]).paragraphs;
    expect(said(envelope(5))).toEqual(["On the team for [Role 1], the check listed 5 people."]);
    expect(said(envelope(1))).toEqual(["On the team for [Role 1], the check listed 1 person."]);
    // A copy cut to fit what the AI may read: the count is the check's, not the copy's.
    expect(said(envelope(38, 7))).toEqual(["On the team for [Role 1], the check listed 45 people."]);
  });
});

describe("the four suggested questions, answered from facts the model chose", () => {
  it("Who could cover Greeter? People in label order whatever order the model chose, and what no overlap doesn't mean", async () => {
    const out = await ask("Who could cover Greeter?", [
      r => call("sunday.who_could_help", { role: roleIn(r) }),
      // The model lists the people backwards and the role's time last: neither order is shown.
      r => { const p = results(r)[0]!.payload as { times: { fact: string }[]; people: Person[] }; return answer({ answer: "facts", facts: [...p.people.map(x => x.fact).reverse(), p.times[0]!.fact] }); },
    ]);
    expect(out.restored).toEqual([
      "Greeter at 9:30 AM on November 22 still needs 1 more person, by Planning Center's count.",
      "Riley Thornbury has no overlap found for Greeter.",
      "Casey Pemberly has a possible conflict for Greeter: pending elsewhere at this time.",
      "Drew Halvorsen's availability for Greeter needs confirmation: a blockout couldn't be checked.",
      "Sam Whitcombe was left out for Greeter: a blockout covers this time.",
      "Morgan Ellingsworth was left out for Greeter: confirmed elsewhere at this time.",
      NOT_FREE, NOT_RANKED,
    ]);
    expect(out.paragraphs[1]).toBe("[Person 1] has no overlap found for [Role 1].");
  });

  it("What still needs a decision this Sunday? The findings that need one, with Planning Center's own count", async () => {
    const out = await ask("What still needs a decision this Sunday?", [
      () => call("sunday.overview"),
      r => { const p = results(r)[0]!.payload as { findings: { fact: string; tone: string }[] }; return answer({ answer: "facts", facts: p.findings.filter(f => f.tone === "needs a decision").map(f => f.fact) }); },
    ]);
    // No overview sentence chosen: one label line says what the rows are, and each row keeps its date (owner's read of 0.3.2).
    expect(out.restored).toEqual([
      "Needs a decision:",
      "Greeter at 9:30 AM on November 22 still needs 1 more person, by Planning Center's count.",
      "Nursery at 9:30 AM on November 22 still needs 1 more person, by Planning Center's count.",
      // The room overlap a Church rule confirms and the follow-up with no owner, as the Sunday page counts them (live review 2026-11-18).
      "Sanctuary (fictional) has bookings that overlap on November 22 from 10:30 AM to 11:00 AM.",
      "Welcome follow-up (fictional), step Call a first-time guest, was due 5:27 PM on October 26 and has no owner.",
    ]);
  });

  it("Why is Greeter flagged? The open role as the check found it", async () => {
    const out = await ask("Why is Greeter flagged?", [
      () => call("sunday.open_needs"),
      r => { const p = results(r)[0]!.payload as { needs: { fact: string; role: string }[] }; return answer({ answer: "facts", facts: p.needs.filter(x => x.role === roleIn(r)).map(x => x.fact) }); },
    ]);
    expect(out.restored).toEqual(["Greeter at 9:30 AM on November 22 still needs 1 more person, by Planning Center's count. Already confirmed: Avery Brightwater. " +
      "On the team: 1 with no overlap found, 1 with a possible conflict, 1 whose availability needs confirmation and 2 left out. Planning Center lists no team leader."]);
  });

  it("Draft a note to someone who could cover Greeter: the drafting tool's own text, greeting by first name and signed by the sender", async () => {
    const out = await ask("Draft a note to someone who could cover Greeter", [
      r => call("sunday.who_could_help", { role: roleIn(r) }),
      r => { const x = (results(r)[0]!.payload as { people: Person[] }).people.find(y => y.status === "no overlap found")!; return call("drafts.prepare_note", { person: x.person, role: x.role }); },
      r => { const [help, draft] = results(r); return answer({ answer: "draft", draft: draft!.payload["draft_id"], facts: [(help!.payload as { people: Person[] }).people.find(y => y.status === "no overlap found")!.fact] }); },
    ]);
    expect(out.kind).toBe("draft");
    expect(out.restored).toEqual([DRAFT_INTRO, "Riley Thornbury has no overlap found for Greeter.", NOT_FREE]);
    expect(out.draftShown).toBe("Hi Riley,\n\nWe still need someone for Greeter at 9:30 AM on November 22. Would you be able to help?\n\n" +
      "It's completely fine to say no. Just let me know either way so we can plan.\n\nThank you,\nPat");
  });
});

// ---- The overview in plain words (owner's read of 0.3.2: "correct, but it reads like a machine printout") ------------

/** A time on one date, church-local, as the tools give it. */
const span = (day: string, from: string, to: string) => ({ starts_at: `${day}T${from}-05:00`, ends_at: `${day}T${to}-05:00` });
const SUN = "2026-11-22";
const needRow = (fact: string, role: string, time = span(SUN, "09:30", "10:30"), extra: Record<string, unknown> = {}) =>
  ({ fact, kind: "needs people", tone: "needs a decision", role, time, remaining: 1, ...extra });
const followUpRow = (fact: string, due = "2026-10-26T17:27-04:00") => ({ fact, kind: "needs an owner", tone: "needs a decision", workflow: "[Workflow 1]", step: "[Step 1]", due });
const checkInRow = (fact: string, person = "[Person 2]") => ({ fact, kind: "check-in suggested", tone: "worth a look", person, sundays_in_a_row: 4 });
/** The overview as the tool gives it: its own fact f1, then its rows. */
const overviewOf = (d: number, w: number, findings: Record<string, unknown>[], over: Record<string, unknown> = {}): ToolEnvelope => ({
  tool: "sunday.overview", source: "Planning Center Services", check_time: "2026-11-19T08:53:00Z", completeness: "complete",
  payload: { fact: "f1", mode: "live", sunday: SUN, reads: 20, reads_not_completed: 0, needs_a_decision: d, worth_a_look: w, findings, ...over },
});
/** The open roles, numbered after the overview's rows (`first`), each needs-people row with its team as the tool gives it. */
const openNeedsOf = (first: number, rows: { role: string; kind?: string; time?: ReturnType<typeof span> }[], over: Record<string, unknown> = {}): ToolEnvelope => ({
  tool: "sunday.open_needs", source: "Planning Center Services", check_time: "2026-11-19T08:53:00Z", completeness: "complete",
  payload: { fact: `f${first}`, needs: rows.map((r, i) => ({ fact: `f${first + 1 + i}`, kind: r.kind ?? "needs people", role: r.role, time: r.time ?? span(SUN, "09:30", "10:30"),
    ...(r.kind && r.kind !== "needs people" ? {} : { remaining: 1, confirmed: [], people_listed: { no_overlap_found: 0, possible_conflict: 0, needs_confirmation: 0, left_out: 0 } }),
    team_leaders: "none listed" })), ...over },
});
const facts = (...ids: string[]) => JSON.stringify({ answer: "facts", facts: ids });
const sundayWords = dayWords({ sort_date: `${SUN}T09:30:00Z` }, null);

describe("the overview in plain words (owner's read of 0.3.2)", () => {
  it("the answer the owner read in 0.3.2: the count without a zero, rows without the date said above or a label on each, no count the rows already say", () => {
    // Two roles that still need people and a follow-up with no owner; nothing worth a look. The AI chose the overview's
    // sentence, its three rows, and the open roles' own count, as Ozzie's AI did on Nov 19.
    const evidence = [overviewOf(3, 0, [needRow("f2", "[Role 1]"), needRow("f3", "[Role 2]"), followUpRow("f4")]),
      openNeedsOf(5, [{ role: "[Role 1]" }, { role: "[Role 2]" }])];
    for (const e of evidence) expect(envelopeProblems(e)).toEqual([]);
    const expected = [
      "For Sunday, November 22, 3 things need a decision.",
      "[Role 1] at 9:30 AM still needs 1 more person, by Planning Center's count.",
      "[Role 2] at 9:30 AM still needs 1 more person, by Planning Center's count.",
      // Its due date isn't the service's, so it keeps it.
      "[Workflow 1], step [Step 1], was due 2026-10-26T17:27-04:00 and has no owner.",
    ];
    expect(composeAnswer(facts("f1", "f2", "f3", "f4", "f5"), evidence, sundayWords).paragraphs).toEqual(expected);
    // Without the day words (a write-up, the copy for other AI apps): the plan's own date, the same words.
    expect(composeAnswer(facts("f1", "f2", "f3", "f4", "f5"), evidence).paragraphs).toEqual(expected);
    // Restored on this Mac: names, and the follow-up's due time in plain words.
    expect(showTimes(expected[3]!, "America/New_York")).toBe("[Workflow 1], step [Step 1], was due 5:27 PM on October 26 and has no owner.");
  });

  it("never says a count of none: the Sunday page's words for its counts, and what this check found when nothing needs a decision", () => {
    const lead = (d: number, w: number, failed = 0) => composeAnswer(facts("f1"), [overviewOf(d, w, [], { reads_not_completed: failed })]).paragraphs[0];
    expect(lead(3, 0)).toBe("For Sunday, November 22, 3 things need a decision.");
    expect(lead(1, 0)).toBe("For Sunday, November 22, 1 thing needs a decision.");
    expect(lead(3, 2)).toBe("For Sunday, November 22, 3 things need a decision and 2 are worth a look.");
    expect(lead(1, 1)).toBe("For Sunday, November 22, 1 thing needs a decision and 1 is worth a look.");
    expect(lead(0, 2)).toBe("For Sunday, November 22, this check found nothing that needs a decision, and 2 things worth a look.");
    expect(lead(0, 1)).toBe("For Sunday, November 22, this check found nothing that needs a decision, and 1 thing worth a look.");
    expect(lead(0, 0)).toBe("For Sunday, November 22, this check found nothing that needs a decision or is worth a look.");
    // Reads that didn't complete are still said right after it, never folded into an all clear.
    expect(lead(0, 0, 2)).toBe("For Sunday, November 22, this check found nothing that needs a decision or is worth a look. 2 Planning Center reads didn't complete.");
    // The open roles' own count, the same way.
    const count = (rows: { role: string; kind?: string }[]) => composeAnswer(facts("f1"), [openNeedsOf(1, rows)]).paragraphs[0];
    expect(count([{ role: "[Role 1]" }, { role: "[Role 2]" }])).toBe("This check found 2 roles that still need people.");
    expect(count([{ role: "[Role 1]" }])).toBe("This check found 1 role that still needs people.");
    expect(count([{ role: "[Role 1]" }, { role: "[Role 2]", kind: "no scheduled lead" }])).toBe("This check found 1 role that still needs people and 1 with no scheduled lead.");
    expect(count([{ role: "[Role 1]", kind: "no scheduled lead" }, { role: "[Role 2]", kind: "no scheduled lead" }])).toBe("This check found 2 roles with no scheduled lead.");
    expect(count([{ role: "[Role 1]", kind: "lead couldn't be confirmed" }])).toBe("This check found no role that still needs people, and none without a scheduled lead.");
    expect(count([])).toBe("This check found no role that still needs people, and none without a scheduled lead.");
    for (const said of [lead(3, 0), lead(0, 2), lead(0, 0), count([{ role: "[Role 1]" }])]) expect(said).not.toMatch(/\b0\b/u);
  });

  it("says the date once: a row on the date the overview's sentence names says its clock alone; any other date, a UTC time, a row before it, a weekend's, keep theirs", () => {
    const rows = [needRow("f2", "[Role 1]"), needRow("f3", "[Role 2]", span("2026-11-21", "17:00", "18:00")), needRow("f4", "[Role 3]", { starts_at: "2026-11-22T14:30Z", ends_at: "2026-11-22T15:30Z" }),
      { fact: "f5", kind: "room use needs review", tone: "needs a decision", room: "[Room 1]", overlap: span(SUN, "10:30", "11:00") }, followUpRow("f6", "2026-11-22T08:00-05:00")];
    const overview = overviewOf(5, 0, rows);
    expect(envelopeProblems(overview)).toEqual([]);
    expect(composeAnswer(facts("f1", "f2", "f3", "f4", "f5", "f6"), [overview], sundayWords).paragraphs).toEqual([
      "For Sunday, November 22, 5 things need a decision.",
      "[Role 1] at 9:30 AM still needs 1 more person, by Planning Center's count.",
      "[Role 2] at 2026-11-21T17:00-05:00 still needs 1 more person, by Planning Center's count.",
      "[Role 3] at 2026-11-22T14:30Z still needs 1 more person, by Planning Center's count.",
      "[Room 1] has bookings that overlap from 10:30 AM to 11:00 AM.",
      "[Workflow 1], step [Step 1], was due 2026-11-22T08:00-05:00 and has no owner.",
    ]);
    // Without the overview's sentence, every row keeps its date.
    expect(composeAnswer(facts("f2", "f5"), [overview], sundayWords).paragraphs).toEqual(["Needs a decision:",
      "[Role 1] at 2026-11-22T09:30-05:00 still needs 1 more person, by Planning Center's count.", "[Room 1] has bookings that overlap on 2026-11-22 from 10:30 AM to 11:00 AM."]);
    // A weekend's sentence names two dates: no row's date goes without saying.
    const weekend = dayWords({ sort_date: "2026-11-21T17:00:00Z", times: ["2026-11-21T22:00:00Z", "2026-11-22T14:30:00Z"] }, "America/New_York");
    expect(composeAnswer(facts("f1", "f2"), [overview], weekend).paragraphs).toEqual([
      "For Saturday, November 21 and Sunday, November 22, 5 things need a decision.", "[Role 1] at 2026-11-22T09:30-05:00 still needs 1 more person, by Planning Center's count."]);
    // A fact the answer gives before the overview's sentence keeps its date; one after it doesn't.
    const before = openNeedsOf(1, [{ role: "[Role 1]" }]);
    const after = overviewOf(1, 0, [needRow("f4", "[Role 2]")], { fact: "f3" });
    expect(composeAnswer(facts("f2", "f3", "f4"), [before, after], sundayWords).paragraphs).toEqual([
      "[Role 1] at 2026-11-22T09:30-05:00 still needs 1 more person, by Planning Center's count. Planning Center lists no team leader.",
      "For Sunday, November 22, 1 thing needs a decision.", "[Role 2] at 9:30 AM still needs 1 more person, by Planning Center's count."]);
  });

  it("groups the rows as the Sunday page does, one label line per group, and none when the sentence above already says what every row is", () => {
    const settled = { ...needRow("f5", "[Role 3]"), decision: "covered outside Planning Center" };
    const rows = [needRow("f2", "[Role 1]"), checkInRow("f3"), needRow("f4", "[Role 2]"), settled];
    // Both kinds, and one the leader resolved: needs a decision, worth a look, then resolved, each in the overview's order.
    expect(composeAnswer(facts("f1", "f2", "f3", "f4", "f5"), [overviewOf(2, 1, rows)]).paragraphs).toEqual([
      "For Sunday, November 22, 2 things need a decision and 1 is worth a look.",
      "Needs a decision:", "[Role 1] at 9:30 AM still needs 1 more person, by Planning Center's count.", "[Role 2] at 9:30 AM still needs 1 more person, by Planning Center's count.",
      "Worth a look:", "[Person 2] is scheduled 4 weeks in a row. Your Church rules suggest a check-in, which is about care, not performance.",
      "Resolved by you:", "[Role 3] at 9:30 AM still needs 1 more person, by Planning Center's count. You decided: covered outside Planning Center.",
    ]);
    // Only decisions, under a sentence that counts only decisions: no label.
    expect(composeAnswer(facts("f1", "f2", "f4"), [overviewOf(2, 0, rows)]).paragraphs.slice(1)).toEqual([
      "[Role 1] at 9:30 AM still needs 1 more person, by Planning Center's count.", "[Role 2] at 9:30 AM still needs 1 more person, by Planning Center's count."]);
    // Only decisions, under a sentence that also counts what is worth a look: the label says which these are.
    expect(composeAnswer(facts("f1", "f2", "f4"), [overviewOf(2, 1, rows)]).paragraphs[1]).toBe("Needs a decision:");
    // Only worth a look, under a sentence that counts only that: no label.
    expect(composeAnswer(facts("f1", "f3"), [overviewOf(0, 1, rows)]).paragraphs).toEqual([
      "For Sunday, November 22, this check found nothing that needs a decision, and 1 thing worth a look.",
      "[Person 2] is scheduled 4 weeks in a row. Your Church rules suggest a check-in, which is about care, not performance."]);
    // A resolved row is never unlabelled, even alone.
    expect(composeAnswer(facts("f1", "f5"), [overviewOf(2, 0, rows)]).paragraphs.slice(1, 2)).toEqual(["Resolved by you:"]);
    // No sentence above: each group under its label.
    expect(composeAnswer(facts("f2", "f3"), [overviewOf(2, 1, rows)]).paragraphs.filter(p => p.endsWith(":"))).toEqual(["Needs a decision:", "Worth a look:"]);
    // No row is ever said with its own label.
    for (const p of composeAnswer(facts("f1", "f2", "f3", "f4", "f5"), [overviewOf(2, 1, rows)]).paragraphs) expect(p).not.toMatch(/^(?:Needs a decision|Worth a look|Resolved by you): \S/u);
  });

  it("a line from another tool after the overview's rows never reads as one of its group: then each row keeps its own label (review of this change)", () => {
    const rows = [needRow("f2", "[Role 1]"), checkInRow("f3")];
    const overview = overviewOf(2, 1, rows);
    // A follow-up from its own tool (it needs a decision) after the rows: under "Worth a look:" it would read as worth a look.
    const followUps: ToolEnvelope = { tool: "followups.unowned", source: "Planning Center People", check_time: "2026-11-19T08:53:00Z", completeness: "complete",
      payload: { fact: "f4", status: "needs an owner", worth_a_look: 0, follow_ups: [{ fact: "f5", workflow: "[Workflow 1]", step: "[Step 1]", due: "2026-10-26T17:27-04:00" }] } };
    expect(envelopeProblems(followUps)).toEqual([]);
    expect(composeAnswer(facts("f1", "f2", "f3", "f5"), [overview, followUps]).paragraphs).toEqual([
      "For Sunday, November 22, 2 things need a decision and 1 is worth a look.",
      "Needs a decision: [Role 1] at 9:30 AM still needs 1 more person, by Planning Center's count.",
      "Worth a look: [Person 2] is scheduled 4 weeks in a row. Your Church rules suggest a check-in, which is about care, not performance.",
      "[Workflow 1], step [Step 1], was due 2026-10-26T17:27-04:00 and has no owner."]);
    // A pending request (worth a look on the Sunday page) after decision rows that need no label: each row says its label.
    const pending: ToolEnvelope = { tool: "sunday.pending_requests", source: "Planning Center Services", check_time: "2026-11-19T08:53:00Z", completeness: "complete",
      payload: { fact: "f4", pending: [{ fact: "f5", role: "[Role 3]", time: span(SUN, "09:30", "10:30"), person: "[Person 1]", request: "request not sent yet" }], leads_not_accepted: [] } };
    expect(envelopeProblems(pending)).toEqual([]);
    expect(composeAnswer(facts("f1", "f2", "f5"), [overviewOf(1, 0, rows), pending]).paragraphs).toEqual([
      "For Sunday, November 22, 1 thing needs a decision.",
      "Needs a decision: [Role 1] at 9:30 AM still needs 1 more person, by Planning Center's count.",
      "[Person 1] is pending for [Role 3] at 9:30 AM. The request hasn't been sent yet."]);
    // Only the closing notes after it: grouped.
    expect(composeAnswer(facts("f1", "f2"), [overviewOf(1, 0, rows)]).paragraphs).toEqual([
      "For Sunday, November 22, 1 thing needs a decision.", "[Role 1] at 9:30 AM still needs 1 more person, by Planning Center's count."]);
  });

  it("the date is left out only after the overview's sentence as shown: one dropped as a repeat of a fuller one doesn't count (review of this change)", () => {
    // Two overviews in one answer (a check in between): the first sentence is the start of the second's, so only the second is
    // shown, after the first's rows. Those rows come before any date is said, so they keep theirs, and their own label.
    const first = overviewOf(2, 0, [needRow("f2", "[Role 1]"), needRow("f3", "[Role 2]")]);
    const second = overviewOf(2, 0, [needRow("f5", "[Role 3]"), needRow("f6", "[Role 4]")], { fact: "f4", reads_not_completed: 1 });
    expect(composeAnswer(facts("f1", "f2", "f3", "f4", "f6"), [first, second]).paragraphs).toEqual([
      "Needs a decision: [Role 1] at 2026-11-22T09:30-05:00 still needs 1 more person, by Planning Center's count.",
      "Needs a decision: [Role 2] at 2026-11-22T09:30-05:00 still needs 1 more person, by Planning Center's count.",
      "For Sunday, November 22, 2 things need a decision. 1 Planning Center read didn't complete.",
      "[Role 4] at 9:30 AM still needs 1 more person, by Planning Center's count."]);
  });

  it("an overview cut for length keeps its full totals; the open roles' count is said whenever it says more than the rows", () => {
    // Five of the overview's rows were left out to fit: its sentence still says the check's own totals.
    const cut: ToolEnvelope = { ...overviewOf(7, 4, [needRow("f2", "[Role 1]"), needRow("f3", "[Role 2]")], { left_out_for_length: 5 }), completeness: "partial" };
    expect(composeAnswer(facts("f1", "f2", "f3"), [cut]).paragraphs).toEqual([
      "For Sunday, November 22, 7 things need a decision and 4 are worth a look.", "Needs a decision:",
      "[Role 1] at 9:30 AM still needs 1 more person, by Planning Center's count.", "[Role 2] at 9:30 AM still needs 1 more person, by Planning Center's count."]);
    const overview = overviewOf(2, 0, [needRow("f2", "[Role 1]"), needRow("f3", "[Role 2]")]);
    const count = (open: ToolEnvelope, ...ids: string[]) => composeAnswer(facts(...ids), [overview, open]).paragraphs.filter(p => p.startsWith("This check found"));
    // Every role it counts is said above it: it adds nothing.
    expect(count(openNeedsOf(4, [{ role: "[Role 1]" }, { role: "[Role 2]" }]), "f1", "f2", "f3", "f4")).toEqual([]);
    // Said in the open roles' own fuller rows, the same.
    expect(count(openNeedsOf(4, [{ role: "[Role 1]" }, { role: "[Role 2]" }]), "f4", "f5", "f6")).toEqual([]);
    // A role it counts that no line says: it adds a fact, so it's said.
    expect(count(openNeedsOf(4, [{ role: "[Role 1]" }, { role: "[Role 2]" }]), "f1", "f2", "f4")).toEqual(["This check found 2 roles that still need people."]);
    // Its own rows cut for length: said, whatever the rows above say.
    expect(count(openNeedsOf(4, [{ role: "[Role 1]" }, { role: "[Role 2]" }], { left_out_for_length: 3 }), "f1", "f2", "f3", "f4")).toEqual(["This check found 2 roles that still need people."]);
    // A role with no scheduled lead counts too.
    expect(count(openNeedsOf(4, [{ role: "[Role 1]" }, { role: "[Role 4]", kind: "no scheduled lead" }]), "f1", "f2", "f4")).toEqual(["This check found 1 role that still needs people and 1 with no scheduled lead."]);
  });
});

describe("fixed framing for each kind of answer", () => {
  const help = async () => {
    const t = new HarnessTools(harnessData(), new HarnessSession(), { now: () => FRESH });
    const open = await t.run("sunday.open_needs", {}, signal, "x");
    const role = ((open.payload as { needs: { role: string }[] }).needs[0]!).role;
    return [open, await t.run("sunday.who_could_help", { role }, signal, "x"), await t.run("sunday.overview", {}, signal, "x")];
  };
  it("not covered: the fixed opening, then any facts read", async () => {
    const evidence = await help();
    // Ozzie's voice, never "I" (round 5).
    expect(CANT_TELL).toBe("Ozzie can't tell from what it read.");
    expect(composeAnswer('{"answer":"not-covered"}', evidence).paragraphs).toEqual([CANT_TELL]);
    const some = composeAnswer('{"answer":"not-covered","facts":["f1"]}', evidence);
    expect(some.paragraphs[0]).toBe(CANT_TELL);
    expect(NOT_COVERED_MORE).toBe("What the check does say:");
    expect(some.paragraphs[1]).toBe(NOT_COVERED_MORE);
    // A count of none isn't said (owner's read of 0.3.2): no "and 0 with no scheduled lead".
    expect(some.paragraphs[2]).toBe("This check found 2 roles that still need people.");
  });
  it("nothing needs a decision: the fixed sentence, then any facts", () => {
    const overview: ToolEnvelope = { tool: "sunday.overview", source: "Planning Center Services", check_time: "2026-11-20T15:00:00Z", completeness: "complete",
      payload: { fact: "f1", mode: "live", sunday: "2026-11-22", reads: 20, reads_not_completed: 0, needs_a_decision: 0, worth_a_look: 1,
        findings: [{ fact: "f2", kind: "check-in suggested", tone: "worth a look", person: "[Person 2]", sundays_in_a_row: 4 }] } };
    expect(composeAnswer('{"answer":"nothing-needs-a-decision","facts":["f2"]}', [overview]).paragraphs).toEqual([NOTHING_TO_DECIDE,
      "Worth a look:", "[Person 2] is scheduled 4 weeks in a row. Your Church rules suggest a check-in, which is about care, not performance."]);
    // With the overview's sentence, which already says the one thing is worth a look: no label.
    expect(composeAnswer('{"answer":"nothing-needs-a-decision","facts":["f1","f2"]}', [overview]).paragraphs).toEqual([NOTHING_TO_DECIDE,
      "For Sunday, November 22, this check found nothing that needs a decision, and 1 thing worth a look.",
      "[Person 2] is scheduled 4 weeks in a row. Your Church rules suggest a check-in, which is about care, not performance."]);
  });
  it("someone scheduled with a blockout: Worth a look, each role with Planning Center's own status and time, never an open role", async () => {
    const overview: ToolEnvelope = { tool: "sunday.overview", source: "Planning Center Services", check_time: "2026-11-20T15:00:00Z", completeness: "complete",
      payload: { fact: "f1", mode: "live", sunday: "2026-11-22", reads: 20, reads_not_completed: 0, needs_a_decision: 0, worth_a_look: 2, findings: [
        { fact: "f2", kind: "scheduled with a blockout at this time", tone: "worth a look", person: "[Person 1]",
          serving: [{ role: "[Role 1]", status: "confirmed", time: { starts_at: "2026-11-22T09:30-05:00", ends_at: "2026-11-22T10:30-05:00" } }] },
        { fact: "f3", kind: "scheduled with a blockout at this time", tone: "worth a look", person: "[Person 2]",
          serving: [{ role: "[Role 1]", status: "confirmed", time: { starts_at: "2026-11-22T09:30-05:00", ends_at: "2026-11-22T10:30-05:00" } },
            { role: "[Role 2]", status: "pending", time: { starts_at: "2026-11-22T11:00-05:00", ends_at: "2026-11-22T12:00-05:00" } }] },
      ] } };
    expect(envelopeProblems(overview)).toEqual([]);
    expect(composeAnswer('{"answer":"facts","facts":["f2","f3"]}', [overview]).paragraphs).toEqual([
      "Worth a look:",
      "[Person 1] is scheduled for [Role 1] (confirmed) at 2026-11-22T09:30-05:00 and has a blockout in Planning Center at that time. Planning Center still counts them, so it isn't an open spot.",
      "[Person 2] is scheduled for [Role 1] (confirmed) at 2026-11-22T09:30-05:00 and [Role 2] (pending) at 2026-11-22T11:00-05:00 and has a blockout in Planning Center at those times. Planning Center still counts them, so they aren't open spots.",
    ]);
  });
  it("a draft is only the drafting tool's text (C1): a draft id with no draft, or another tool's, shows no draft", async () => {
    const evidence = await help();
    expect(composeAnswer('{"answer":"draft","draft":"d1"}', evidence)).toEqual({ kind: "not-covered", paragraphs: [CANT_TELL], draft: null });
  });
  it("each person's sentence takes the person from the fact itself (C3), so a label can't be moved onto another person's fact", async () => {
    const evidence = await help();
    const people = (evidence[1]!.payload as { people: Person[] }).people;
    for (const p of people) {
      const [line] = composeAnswer(JSON.stringify({ answer: "facts", facts: [p.fact] }), evidence).paragraphs;
      expect(line!.startsWith(p.person), p.fact).toBe(true);
      expect(line).toContain(p.status === "left out" ? "was left out" : p.status === "no overlap found" ? "has no overlap found" : p.status === "possible conflict" ? "possible conflict" : "needs confirmation");
    }
  });
  it("numbers and times are the facts' own (C2): the remaining count and the start time, never another number in the evidence", async () => {
    const evidence = await help();
    const times = (evidence[1]!.payload as { times: { fact: string; remaining: number; time: { starts_at: string } }[] }).times[0]!;
    const [line] = composeAnswer(JSON.stringify({ answer: "facts", facts: [times.fact] }), evidence).paragraphs;
    expect(line).toBe(`${(evidence[1]!.payload as { asked_for: { role: string } }).asked_for.role} at ${times.time.starts_at} still needs ${times.remaining} more person, by Planning Center's count.`);
  });
});

describe("every fact every tool gives has a sentence", () => {
  it("over every fixture, with no fact left out and no label or time altered", async () => {
    let facts = 0;
    for (const [name, make] of [...FIXTURES, ["lead rule", () => harnessData({ rules: LEAD_RULES })] as const]) {
      const evidence = await allEnvelopes(make());
      for (const e of evidence) expect(envelopeProblems(e), `${name} ${e.tool}`).toEqual([]);
      const ids = [...new Set(evidence.flatMap(e => [...JSON.stringify(e.payload).matchAll(/"fact":"(f\d+)"/gu)].map(m => m[1]!)))];
      for (const id of ids) {
        const composed = composeAnswer(JSON.stringify({ answer: "facts", facts: [id] }), evidence);
        expect(composed.kind, `${name} ${id}`).toBe("facts");
        // Every label and ISO time in a sentence is one the evidence holds.
        const text = composed.paragraphs.join(" ");
        for (const label of text.match(/\[[^\]]*\]/gu) ?? []) expect(JSON.stringify(evidence), `${name} ${id} ${label}`).toContain(label);
        for (const time of text.match(/\d{4}-\d{2}-\d{2}(?:T[\d:+-]+)?/gu) ?? []) expect(JSON.stringify(evidence), `${name} ${id} ${time}`).toContain(time);
        facts++;
      }
    }
    expect(facts).toBeGreaterThan(200);
  });
});

describe("a sentence two tools both give is said once", () => {
  it("drops a need repeated at the start of a fuller sentence, and an exact repeat", () => {
    const evidence = [
      { tool: "sunday.open_needs", payload: { needs: [{ fact: "f1", kind: "needs people", role: "[Role 1]", time: { starts_at: "[Time 1]" }, remaining: 1, confirmed: ["[Person 1]"] }] } },
      { tool: "sunday.who_could_help", payload: { times: [{ fact: "f2", role: "[Role 1]", time: { starts_at: "[Time 1]" }, remaining: 1 }, { fact: "f3", role: "[Role 1]", time: { starts_at: "[Time 1]" }, remaining: 1 }] } },
    ] as unknown as ToolEnvelope[];
    const c = composeAnswer('{"answer":"facts","facts":["f1","f2","f3"]}', evidence);
    expect(c.paragraphs).toEqual(["[Role 1] at [Time 1] still needs 1 more person, by Planning Center's count. Already confirmed: [Person 1]."]);
  });
});


// ---- Release-app rehearsal, Nov 15: kids teams, open decisions and room wording -----------------------------------

/** The kids rules on the test organization's shape: the nursery's one position is "Nursery volunteer", as in the release app. */
const nurseryVolunteer = (): SundayCapture =>
  JSON.parse(JSON.stringify(withFictionalBackgroundChecks(nov22Capture())).split("\"Nursery\"").join("\"Nursery volunteer\"")) as SundayCapture;
const kidsData = (rules = KIDS_RULES) => harnessData({ mode: "live", rules, capture: nurseryVolunteer() });
/** Every background check read and current, none expiring: the only check that may say "no one … without one". */
function allCleared(): SundayCapture {
  const c = withFictionalBackgroundChecks(nov22Capture());
  c.reads = c.reads.map(r => r.collection === "people_background_checks" ? { ...r, body: { data: [{ type: "BackgroundCheck", id: `9${r.people_person_id}`,
    attributes: { status: "complete_clear", current: true, expires_on: null }, relationships: { person: { data: { type: "Person", id: r.people_person_id } } } }] } } : r);
  return c;
}
/** The brief with these findings set aside by Church rules ("This isn't right"), as buildSundayBrief moves them. */
function setAsideIn(data: HarnessData, pick: (f: Finding) => boolean): HarnessData {
  const brief = data.brief!;
  return { ...data, brief: { ...brief, findings: brief.findings.filter(f => !pick(f)),
    hidden: brief.findings.filter(pick).map(finding => ({ finding, entry: { type: "correction" } as unknown as CorrectionEntry })) } };
}
/** One answer written on this Mac, restored as the panel shows it. */
async function local(typed: string, data = kidsData()) {
  const tools = new HarnessTools(data, new HarnessSession(), { now: () => FRESH });
  const q = kidsQuestion(typed, data);
  if (!q) return null;
  const out = await kidsAnswer(tools, q, signal);
  const restore = (t: string) => restoreLabels(t, tools.session, { names: data.capture!.names, organization: data.capture!.organization, timeZone: data.brief!.time_zone });
  return { ...out, restored: out.paragraphs.map(t => out.fill(restore(t))), tools };
}

describe("why “Is the nursery ready for Sunday?” wasn't answered in the release app", () => {
  it("reached the model with no label for the nursery and without the background check, so no fact it could choose answered it", async () => {
    const requests: AgentStepRequest[] = [];
    const model: ModelStep = async r => {
      requests.push(structuredClone(r));
      return requests.length === 1 ? call("sunday.overview") : { content: "I can't tell which of these roles is the nursery.", tool_calls: [], finish: "stop" };
    };
    const h = new Harness({ workspace_id: "w", data: kidsData(), skills, runtime: new TsLoop(), model, now: () => FRESH });
    const res = await h.ask("Is the nursery ready for Sunday?");
    if (!res.ok) throw new Error(res.refusal);
    // The position is "Nursery volunteer", so "nursery" alone is no position name and gets no [Role N] label.
    expect(res.task.question).toBe("Is the nursery ready for Sunday?");
    const seen = JSON.stringify(requests.map(r => r.messages));
    expect(seen).toContain("[Role 2]");
    expect(seen).not.toMatch(/background/iu);
    expect(seen).toContain("some findings are shown only in Ozzie on this Mac");
    // Any reply outside the closed answer form is "fidelity": "Ozzie couldn't back that answer up with what it read".
    expect(res.outcome).toMatchObject({ status: "failed", code: "fidelity" });
  });
});

describe("kids teams and background checks, answered on this Mac without the AI", () => {
  it("recognises questions about a kids team, kids in general or background checks, and leaves the rest and drafts to Ask", () => {
    const data = kidsData();
    const teams = (typed: string) => kidsQuestion(typed, data)?.teams ?? null;
    expect(teams("Is the nursery ready for Sunday?")).toEqual([TEAMS.nursery]);
    expect(teams("How are the Nursery volunteers looking?")).toEqual([TEAMS.nursery]);
    expect(teams("Are the kids teams covered?")).toEqual([TEAMS.nursery, TEAMS.lyrics]);
    expect(teams("Any background check problems?")).toEqual([TEAMS.nursery, TEAMS.lyrics]);
    expect(kidsQuestion("Does everyone in the nursery have a background-check?", data)).toMatchObject({ teams: [TEAMS.nursery], background: true });
    expect(kidsQuestion("Who could cover the nursery?", data)).toMatchObject({ teams: [TEAMS.nursery], who: true });
    for (const typed of ["Who could cover Greeter?", "What still needs a decision this Sunday?", "Is the room double booked?", "Draft a note to someone who could cover the nursery",
      "Who could cover Greeter or the nursery?"]) expect(kidsQuestion(typed, data), typed).toBeNull();
    // Without kids rules a kids word still answers here, for the teams it names; any other question goes to Ask.
    expect(kidsQuestion("Is the nursery ready?", kidsData(RULES))).toMatchObject({ teams: [TEAMS.nursery], marked: false });
    expect(kidsQuestion("Is Greeter ready?", kidsData(RULES))).toBeNull();
  });

  it("Is the nursery ready for Sunday? Every Nursery item the Sunday page shows, the background check from local data, kept on this Mac", async () => {
    const out = (await local("Is the nursery ready for Sunday?"))!;
    expect(out.restored).toEqual([
      "Needs a decision: Nursery volunteer at 9:30 AM on November 22 still needs 1 more person, by Planning Center's count. Already confirmed: Blake Ashgrove. " +
        "Team leaders in Planning Center: Jordan Ashdown (oversight of the team, not a serving assignment).",
      "Needs a decision: Nursery volunteer at 9:30 AM on November 22 has 1 confirmed person, and your Church rules ask for at least 2. Pending isn't counted, and Ozzie doesn't check ages.",
      "Needs a decision: Blake Ashgrove has no current background check on file. Scheduled for Nursery volunteer at 9:30 AM on November 22. " +
        `Your Church rules ask for a current background check before serving with kids. From Planning Center People, checked 10:00 AM on November 20. ${KEPT_HERE}`,
    ]);
    expect(out.restored.join(" ")).not.toMatch(/Lyrics|Cameron|Greeter/u);
    // Where it came from: Services for the Sunday, People for the background check, and the Church rules that ask for both.
    expect(out.evidence.map(e => e.tool)).toEqual(["sunday.overview", "sunday.open_needs"]);
    expect(out.sources.map(s => s.source)).toEqual(["Planning Center People", "Church rules on this Mac"]);
    expect(out.gaps).toEqual([]);
  });

  it("Any background check problems? Only background checks, across the kids teams", async () => {
    const out = (await local("Any background check problems?"))!;
    expect(out.restored).toEqual([
      expect.stringMatching(/^Needs a decision: Blake Ashgrove has no current background check on file\. Scheduled for Nursery volunteer at 9:30 AM on November 22\./u),
      expect.stringMatching(/^Needs a decision: Cameron Larkspur's background check on file expires before Sunday\. Scheduled for Lyrics at 9:30 AM on November 22\..* Kept on this Mac; never sent to an AI\.$/u),
    ]);
  });

  it("Who could cover the nursery? The open role and the people on its team, in label order, with what no overlap doesn't mean", async () => {
    const out = (await local("Who could cover the nursery?"))!;
    expect(out.restored).toEqual([
      expect.stringMatching(/^Needs a decision: Nursery volunteer at 9:30 AM on November 22 still needs 1 more person/u),
      "The check found no one else on the team for Nursery volunteer.",
      expect.stringMatching(/^Needs a decision: Nursery volunteer at 9:30 AM on November 22 has 1 confirmed person/u),
      expect.stringMatching(/^Needs a decision: Blake Ashgrove has no current background check on file\..* Kept on this Mac; never sent to an AI\.$/u),
    ]);
    expect(out.evidence.map(e => e.tool)).toEqual(["sunday.overview", "sunday.open_needs", "sunday.who_could_help"]);
    // A kids team with people on it: each one in label order (labels follow the order the tools first met people, which
    // says nothing about anyone), never ranked, and what no overlap doesn't mean.
    const greeters = (await local("Who could cover the greeters?", harnessData({ mode: "live", rules: { ...RULES, kidsTeams: [{ team_id: TEAMS.greeter, min_confirmed: 1 }] } })))!;
    expect(greeters.restored).toEqual([
      expect.stringMatching(/^Needs a decision: Greeter at 9:30 AM on November 22 still needs 1 more person/u),
      "Riley Thornbury has no overlap found for Greeter.",
      "Sam Whitcombe was left out for Greeter: a blockout covers this time.",
      "Morgan Ellingsworth was left out for Greeter: confirmed elsewhere at this time.",
      "Casey Pemberly has a possible conflict for Greeter: pending elsewhere at this time.",
      "Drew Halvorsen's availability for Greeter needs confirmation: a blockout couldn't be checked.",
      NOT_FREE, NOT_RANKED,
    ]);
  });

  it("says plainly when nothing was found, what it didn't check, and when no kids team is marked", async () => {
    // Nothing on the kids team: said, never left blank, with what wasn't counted as Worth a look.
    const quiet = harnessData({ mode: "live", rules: { ...RULES, kidsTeams: [{ team_id: "7599999", min_confirmed: 2 }] } });
    const clear = (await local("Are the kids teams ready?", quiet))!;
    expect(clear.restored).toEqual(["This check found nothing for your kids teams that needs a decision or is worth a look."]);
    expect(clear.gaps).toEqual(["1 kids team isn't on this Sunday's plan, so it wasn't counted."]);
    // Background checks that weren't part of the check are Worth a look, never "on file".
    const unread = harnessData({ mode: "live", rules: KIDS_RULES });
    const lines = (await local("Do the kids teams have background checks?", unread))!;
    expect(lines.restored).toEqual([BACKGROUND_UNCONFIRMED]);
    expect(lines.gaps).toEqual(["Background checks weren't part of this check. Check Planning Center again to include them."]);
    // Every background check read and none flagged: only then is "on file" said.
    const onFile = (await local("Any background check problems?", harnessData({ mode: "live", rules: KIDS_RULES, capture: allCleared() })))!;
    expect(onFile.restored).toEqual([BACKGROUND_ON_FILE]);
    // The rule turned off: said so.
    const off = (await local("Any background check problems?", kidsData({ ...KIDS_RULES, kidsBackgroundChecks: false })))!;
    expect(off.restored).toEqual([BACKGROUND_OFF]);
    // No kids team marked: said so, with what the check found for the team named.
    const none = (await local("Is the nursery ready?", kidsData(RULES)))!;
    expect(none.restored[0]).toBe(NO_KIDS_TEAM);
    expect(none.sources.map(s => s.source)).toEqual(["Church rules on this Mac"]);
    expect(kidsWording("Is the nursery ready?") && kidsWording("Any background-check problems?") && !kidsWording("Draft a note for the nursery") && !kidsWording("Is Greeter ready?")).toBe(true);
    expect(none.restored[1]).toMatch(/^Needs a decision: Nursery volunteer at 9:30 AM on November 22 still needs 1 more person/u);
    expect(none.restored.join(" ")).not.toMatch(/background check on file/u);
    // Who could cover it doesn't need that line.
    expect((await local("Who could cover the nursery?", kidsData(RULES)))!.restored[0]).toMatch(/^Needs a decision: Nursery volunteer at 9:30 AM/u);
  });
});

describe("a decision question: open decisions the answer left out are added on this Mac", () => {
  it("an overview cut for length: every open decision on the page, each said as its own finding, none mistaken for another (review item 6)", async () => {
    const data = crowded();
    const tools = new HarnessTools(data, new HarnessSession(), { now: () => FRESH });
    const shown = sundayShownCount(applyDecisions(data.brief!, data.decisions), data.operations);
    const listed = (await openDecisions(tools, signal)).paragraphs;
    expect(listed[0]).toBe(onPage(SUNDAY_WORDS));
    const items = listed.slice(1);
    expect(items).toHaveLength(shown.decisions);
    // The roles in the page's order, then the room and the follow-up from their own tools. The heading says they need a
    // decision, so no item says it again (owner's read of 0.3.2); nothing above names the date, so each time keeps it.
    const roles = items.filter(t => /^\[Role \d+\] /u.test(t));
    expect(roles).toHaveLength(shown.decisions - 2);
    for (const t of items) expect(t).not.toMatch(/^Needs a decision/u);
    for (const t of roles) expect(t).toMatch(/^\[Role \d+\] at 2026-11-22T\d\d:\d\d-05:00 still needs 1 more person, by Planning Center's count\.$/u);
    const usher = (n: number) => { const target = tools.session.target(/\[Role \d+\]/u.exec(roles[n]!)![0]); return target?.kind === "role" ? target.name : null; };
    // The three the leader settled are left out; the rest in order, then the fictional Sunday's own two roles.
    expect(roles.map((_, i) => usher(i))).toEqual([...Array.from({ length: 9 }, (_, i) => `Usher ${i + 4}`), "Greeter", "Nursery"]);
    expect(items.slice(-2)).toEqual([expect.stringMatching(/^Room use needs review: /u), expect.stringMatching(/ has no owner\.$/u)]);
  });

  it("What still needs a decision this Sunday? The answer's own items, then the background checks, the follow-up and the room overlap it left out", async () => {
    const data = kidsData();
    // As Ozzie's AI answered live (2026-11-18): the roles and kids teams that need a decision, not the room or the follow-up.
    const model: ModelStep = async r => r.messages.length < 3 ? call("sunday.overview")
      : answer({ answer: "facts", facts: (results(r)[0]!.payload as { findings: { fact: string; tone: string; kind: string }[] }).findings
        .filter(f => f.tone === "needs a decision" && f.kind !== "room use needs review" && f.kind !== "needs an owner").map(f => f.fact) });
    const h = new Harness({ workspace_id: "w", data, skills, runtime: new TsLoop(), model, now: () => FRESH });
    const res = await h.ask("What still needs a decision this Sunday?");
    if (!res.ok) throw new Error(res.refusal);
    expect(DECISION_QUESTION.test("What still needs a decision this Sunday?")).toBe(true);
    const left = await decisionsLeftOut(h.tools, res.outcome.answer!, res.outcome.evidence, signal);
    const shown = left.paragraphs.map(p => left.fill(h.restore(p)));
    expect(shown[0]).toBe(ALSO_ON_SUNDAY);
    // Under a heading that says they need a decision, none says it again (owner's read of 0.3.2). The answer above didn't
    // say the date, so every time here keeps it.
    expect(shown.slice(1)).toEqual([
      expect.stringMatching(/^Blake Ashgrove has no current background check on file\. Scheduled for Nursery volunteer at 9:30 AM on November 22\..* Kept on this Mac; never sent to an AI\.$/u),
      expect.stringMatching(/^Cameron Larkspur's background check on file expires before Sunday\..* Kept on this Mac; never sent to an AI\.$/u),
      expect.stringMatching(/^Room use needs review: Sanctuary \(fictional\) has bookings that overlap on November 22 from /u),
      "Welcome follow-up (fictional), step Call a first-time guest, was due 5:27 PM on October 26 and has no owner.",
    ]);
    expect(left.evidence.map(e => e.tool)).toEqual(["sunday.overview", "rooms.conflicts", "followups.unowned"]);
    expect(left.sources.map(s => s.source)).toEqual(["Planning Center People"]);
  });

  it("says a room or follow-up once when an answer chose it from the overview and from its own tool, in its own tool's fuller words (review 2026-11-18)", async () => {
    const data = harnessData({ mode: "live" });
    const tools = new HarnessTools(data, new HarnessSession(), { now: () => FRESH });
    const evidence = [await tools.run("sunday.overview", {}, signal, "t"), await tools.run("rooms.conflicts", {}, signal, "t"), await tools.run("followups.unowned", {}, signal, "t")];
    const rows = (e: ToolEnvelope, list: string) => ((e.payload as Record<string, unknown>)[list] as { fact: string; kind?: string }[]);
    const overviewOps = rows(evidence[0]!, "findings").filter(r => r.kind === "room use needs review" || r.kind === "needs an owner").map(r => r.fact);
    const own = [...rows(evidence[1]!, "rooms"), ...rows(evidence[2]!, "follow_ups")].map(r => r.fact);
    expect([overviewOps.length, own.length]).toEqual([2, 2]);
    const said = composeAnswer(JSON.stringify({ answer: "facts", facts: [...overviewOps, ...own] }), evidence).paragraphs;
    expect(said).toEqual([
      expect.stringMatching(/^Room use needs review: \[Room 1\] has bookings that overlap .* Planning Center doesn't show it as worked out\.$/u),
      "[Workflow 1], step [Step 1], was due 2026-10-26T17:27-04:00 and has no owner.",
    ]);
    // Only the overview's: said in its own words, under one label line.
    expect(composeAnswer(JSON.stringify({ answer: "facts", facts: overviewOps }), evidence).paragraphs).toEqual([
      "Needs a decision:", expect.stringMatching(/^\[Room 1\] has bookings that overlap on 2026-11-22 from /u), "[Workflow 1], step [Step 1], was due 2026-10-26T17:27-04:00 and has no owner."]);
  });

  it("the overview says the Sunday page's count, each room, follow-up and group meeting in its tone, and a settled decision as Resolved by you (live review 2026-11-18)", async () => {
    const greeter = harnessData().brief!.findings.find(f => f.kind === "needs-people")!;
    const data = harnessData({ mode: "live", decisions: [decide(greeter, "covered-outside", "A parent is covering", CHECKED)] });
    const tools = new HarnessTools(data, new HarnessSession(), { now: () => FRESH });
    const overview = await tools.run("sunday.overview", {}, signal, "t");
    const p = overview.payload as { fact: string; findings: { fact: string; kind: string }[] };
    const every = JSON.stringify({ answer: "facts", facts: [p.fact, ...p.findings.map(f => f.fact)] });
    const shown = sundayShownCount(applyDecisions(data.brief!, data.decisions), data.operations);
    expect(shown).toMatchObject({ decisions: 3, looks: 3 });
    // Grouped as the Sunday page groups them, each group under one label line, in the overview's order within it; the date
    // the first sentence names isn't said again, and the follow-up keeps its own due date (owner's read of 0.3.2).
    expect(composeAnswer(every, [overview]).paragraphs.map(t => showTimes(t, data.brief!.time_zone))).toEqual([
      "For Sunday, November 22, 3 things need a decision and 3 are worth a look.",
      "Needs a decision:",
      "[Role 2] at 9:30 AM still needs 1 more person, by Planning Center's count.",
      "[Room 1] has bookings that overlap from 10:30 AM to 11:00 AM.",
      "[Workflow 1], step [Step 1], was due 5:27 PM on October 26 and has no owner.",
      "Worth a look:",
      "[Person 1] is pending for [Role 3] at 9:30 AM. The request hasn't been sent yet. Pending is not the same as asked.",
      "[Person 2] is scheduled 3 weeks in a row. Your Church rules suggest a check-in, which is about care, not performance.",
      "[Person 1] is scheduled for [Role 3] (pending) at 9:30 AM while their group meets at 9:30 AM.",
      "Resolved by you:",
      "[Role 1] at 9:30 AM still needs 1 more person, by Planning Center's count. You decided: covered outside Planning Center.",
    ]);
    // Said once: a decision question's answer that chose them gets nothing added for them.
    expect((await decisionsLeftOut(tools, every, [overview], signal)).paragraphs).toEqual([]);
    // "Based on" names where the room, follow-up and group meeting came from, not only the overview's Services.
    expect(chosenSources(every, [overview], tools.rowSources())).toEqual(["Planning Center Calendar", "Planning Center People", "Planning Center Groups"]
      .map(source => ({ source, check_time: tools.rowSources()!.check_time, completeness: "complete" })));
    expect(chosenSources(JSON.stringify({ answer: "facts", facts: [p.fact] }), [overview], null)).toEqual([]);
    // Without a Church room rule: the overlap is worth a look, with one line for what couldn't be confirmed.
    const unruled = new HarnessTools(harnessData({ mode: "live", rules: { ...RULES, rooms: [] } }), new HarnessSession(), { now: () => FRESH });
    const o2 = await unruled.run("sunday.overview", {}, signal, "t");
    const rows = (o2.payload as { findings: { fact: string; kind: string }[] }).findings.filter(f => f.kind === "room use needs review" || f.kind === "a detail couldn't be verified");
    expect(composeAnswer(JSON.stringify({ answer: "facts", facts: rows.map(r => r.fact) }), [o2]).paragraphs).toEqual([
      "Worth a look:", "[Room 1] has bookings that overlap on 2026-11-22 from 10:45 AM to 11:00 AM.", "Some room or follow-up details couldn't be confirmed."]);
  });

  it("adds nothing the answer already said, and nothing a leader already decided", async () => {
    const data = kidsData();
    const tools = new HarnessTools(data, new HarnessSession(), { now: () => FRESH });
    const evidence = [await tools.run("sunday.overview", {}, signal, "t"), await tools.run("rooms.conflicts", {}, signal, "t"), await tools.run("followups.unowned", {}, signal, "t")];
    const ids = evidence.flatMap(e => [...JSON.stringify(e.payload).matchAll(/"fact":"(f\d+)"/gu)].map(m => m[1]!));
    const all = await decisionsLeftOut(tools, JSON.stringify({ answer: "facts", facts: ids.slice(0, 24) }), evidence, signal);
    // Only the background checks: they never reach an answer the AI chose.
    expect(all.paragraphs.slice(1).every(p => p.endsWith(KEPT_HERE))).toBe(true);
    expect(all.paragraphs).toHaveLength(3);
    // A tool's own summary of rooms or follow-ups counts as saying them.
    const summaries = evidence.slice(1).map(e => (e.payload as { fact: string }).fact);
    const counted = await decisionsLeftOut(tools, JSON.stringify({ answer: "facts", facts: summaries }), evidence, signal);
    expect(counted.paragraphs.join(" ")).not.toMatch(/\[Room \d+\] has bookings|has no owner/u);
    // A decided finding is settled: never listed again unless a later check reopened it.
    const greeter = data.brief!.findings.find(f => f.kind === "needs-people")!;
    const decidedData = { ...data, decisions: [decide(greeter, "covered-outside", "A parent is covering", CHECKED)] };
    const decidedTools = new HarnessTools(decidedData, new HarnessSession(), { now: () => FRESH });
    const left = await decisionsLeftOut(decidedTools, '{"answer":"not-covered"}', [], signal);
    const decided = left.paragraphs.map(p => left.fill(restoreLabels(p, decidedTools.session, { names: data.capture!.names, timeZone: data.brief!.time_zone })));
    expect(decided.filter(p => /still needs 1 more person/u.test(p))).toEqual([expect.stringMatching(/^Nursery volunteer at 9:30 AM on November 22 still/u)]);
    expect(decided.join(" ")).not.toContain("Greeter");
  });
});

describe("room overlaps in the Sunday page's tone, the date said once", () => {
  const rooms = (row: Record<string, unknown>): ToolEnvelope[] => [{ tool: "rooms.conflicts", source: "Planning Center Calendar", check_time: "2026-11-20T15:00:00Z", completeness: "complete",
    payload: { fact: "f1", status: "room use needs review", worth_a_look: 0, rooms: [{ fact: "f2", room: "[Room 1]", setup_minutes: 30, church_rule: "not shared", worked_out_in_planning_center: "not worked out", ...row }] } }];
  const sentence = (row: Record<string, unknown>) => composeAnswer('{"answer":"facts","facts":["f2"]}', rooms(row)).paragraphs[0];
  const on = (a: string, b: string) => ({ starts_at: a, ends_at: b });
  it("says a one-day overlap's date once, and the bookings' too when they fall on it", () => {
    const shown = showTimes(sentence({ label: "Room use needs review", overlap: on("2026-11-29T10:15-05:00", "2026-11-29T11:00-05:00"),
      bookings: [{ time: on("2026-11-29T09:00-05:00", "2026-11-29T11:00-05:00"), approval: "approved" }, { time: on("2026-11-29T10:45-05:00", "2026-11-29T11:15-05:00"), approval: "approved" }] })!, "America/New_York");
    expect(shown).toBe("Room use needs review: [Room 1] has bookings that overlap on November 29 from 10:15 AM to 11:00 AM; the bookings are from 9:00 AM to 11:00 AM (approved) " +
      "and from 10:45 AM to 11:15 AM (approved), with 30 minutes of setup time. Your Church rules say this room isn't shared. Planning Center doesn't show it as worked out.");
  });
  it("keeps each date when they differ, and Worth a look for an overlap the Church rules can't confirm", () => {
    const shown = showTimes(sentence({ label: "Worth a look", church_rule: "no rule set", overlap: on("2026-11-29T23:30-05:00", "2026-11-30T00:30-05:00"),
      bookings: [{ time: on("2026-11-29T23:00-05:00", "2026-11-30T01:00-05:00"), approval: "approved" }, { time: on("2026-11-29T21:00-05:00", "2026-11-29T23:45-05:00"), approval: "pending" }] })!, "America/New_York");
    expect(shown).toBe("Worth a look: [Room 1] has bookings that overlap from 11:30 PM on November 29 to 12:30 AM on November 30; the bookings are from 11:00 PM on November 29 to 1:00 AM on November 30 (approved) " +
      "and on November 29 from 9:00 PM to 11:45 PM (pending), with 30 minutes of setup time. No room rule is set for it. Planning Center doesn't show it as worked out.");
  });
});

describe("review Q: never an implied all clear, never blank, decided and set-aside items said, labels kept apart", () => {
  it("says no one is without a current background check only when the check supports it exactly (H1)", async () => {
    const ask = async (data: HarnessData) => (await local("Any background check problems?", data))!;
    // The one case that may say it: who is scheduled read, someone scheduled, every check read, complete and current.
    expect((await ask(harnessData({ mode: "live", rules: KIDS_RULES, capture: allCleared() }))).restored).toEqual([BACKGROUND_ON_FILE]);
    // Who is scheduled didn't load.
    const unloaded = allCleared();
    unloaded.reads = unloaded.reads.map(r => r.collection === "team_members" ? { ...r, outcome: "denied", body: null } as unknown as typeof r : r);
    const a = await ask(harnessData({ mode: "live", rules: KIDS_RULES, capture: unloaded }));
    expect(a.restored).toEqual([BACKGROUND_UNCONFIRMED]);
    expect(a.gaps).toContain(MEMBERS_UNREAD);
    // A finding set aside with "This isn't right": counted, never read as "no one".
    const both = await ask(setAsideIn(kidsData(), f => f.kind === "background-check"));
    expect(both.restored).toEqual([setAside(2, "background check")]);
    expect(setAside(2, "background check")).toBe("2 background checks are set aside by your Church rules, so they aren't listed here; they're on the Sunday page.");
    const one = await ask(setAsideIn(kidsData(), f => f.kind === "background-check" && f.position?.team_id === TEAMS.nursery));
    expect(one.restored).toEqual([expect.stringMatching(/^Needs a decision: Cameron Larkspur's background check/u),
      "One background check is set aside by your Church rules, so it isn't listed here; it's on the Sunday page."]);
    // An out-of-date check, and a saved recording, aren't current.
    const stale = await ask(harnessData({ mode: "live", rules: KIDS_RULES, capture: allCleared(), now: "2026-11-20T17:00:00Z" }));
    expect(stale.restored).toEqual([BACKGROUND_UNCONFIRMED]);
    expect(stale.evidence.map(e => [e.tool, e.completeness])).toEqual([["sunday.not_checked", "stale"]]);
    expect((await ask(harnessData({ mode: "recording", rules: KIDS_RULES, capture: allCleared() }))).restored).toEqual([BACKGROUND_UNCONFIRMED]);
    // Nobody confirmed or pending on a kids team: said as that, never as "everyone has one".
    expect((await ask(harnessData({ mode: "live", rules: { ...RULES, kidsTeams: [{ team_id: "7599999", min_confirmed: 2 }] }, capture: allCleared() }))).restored)
      .toEqual([NOBODY_SCHEDULED]);
    // A readiness answer about a team whose findings are all set aside says so, never "nothing found".
    const quiet = (await local("Is the nursery ready?", setAsideIn(kidsData(), f => f.position?.team_id === TEAMS.nursery)))!;
    expect(quiet.restored).toEqual([setAside(3)]);
    expect(quiet.restored.join(" ")).not.toMatch(/found nothing/u);
  });

  it("answers here only what is about a kids team or background checks; a whole-Sunday question goes to Ask (M2)", () => {
    const named = (name: string) => kidsData({ ...RULES, kidsTeams: [{ team_id: TEAMS.nursery, min_confirmed: 2, name }] });
    expect(kidsQuestion("Is everything ready for next Sunday?", named("Next Gen"))).toBeNull();
    expect(kidsQuestion("Is Next Gen ready?", named("Next Gen"))).toMatchObject({ teams: [TEAMS.nursery], named: true });
    expect(kidsQuestion("What still needs a decision at the first service?", named("First Steps"))).toBeNull();
    expect(kidsQuestion("Is First Steps covered?", named("First Steps"))).toMatchObject({ named: true });
    for (const typed of ["Is everything ready for Sunday, including the kids?", "What still needs a decision this Sunday?", "Are we ready, kids included?",
      "Is everything ready for the nursery and Greeter?"]) expect(kidsQuestion(typed, kidsData()), typed).toBeNull();
    // A decision question about a kids team by name stays local; one that names background checks gets the whole Sunday.
    expect(kidsQuestion("What still needs a decision for the nursery?", kidsData())).toMatchObject({ teams: [TEAMS.nursery], named: true, whole: false });
    expect(kidsQuestion("What still needs a decision this Sunday? Any background check issues?", kidsData())).toMatchObject({ background: true, whole: true, named: false });
  });

  it("never answers with nothing, and points to Church rules when no kids team is marked (M3)", async () => {
    for (const [typed, data] of [["Who could help with the kids?", kidsData(RULES)], ["Who can sub for children's church?", kidsData(RULES)],
      ["Is anyone available for childcare?", kidsData(RULES)], ["Any background check problems?", kidsData(RULES)], ["Who could help with the kids?", kidsData()],
      ["Is anyone available for childcare?", kidsData()]] as const) {
      const out = (await local(typed, data))!;
      expect(out.paragraphs.length, typed).toBeGreaterThan(0);
    }
    expect((await local("Who could help with the kids?", kidsData(RULES)))!.restored).toEqual([NO_KIDS_TEAM]);
    expect(NO_KIDS_TEAM).toContain("Church rules, under Kids teams");
  });

  it("words a role the leader resolved as resolved, unless a later check reopened it (L1)", async () => {
    const data = kidsData();
    const need = data.brief!.findings.find(f => f.kind === "needs-people" && f.position?.team_id === TEAMS.nursery)!;
    const out = (await local("Is the nursery ready?", { ...data, decisions: [decide(need, "covered-outside", "A parent is covering", CHECKED)] }))!;
    expect(out.restored[0]).toMatch(/^Resolved by you: Nursery volunteer at 9:30 AM on November 22 still needs 1 more person.* You decided: covered outside Planning Center\.$/u);
    expect(out.restored[1]).toMatch(/^Needs a decision: Nursery volunteer at 9:30 AM on November 22 has 1 confirmed person/u);
  });

  it("composes background checks with names looked up here, never minting labels shared with the AI or other AI apps (L2)", async () => {
    const data = kidsData(), session = new HarnessSession();
    const out = await kidsAnswer(new HarnessTools(data, session, { now: () => FRESH }), kidsQuestion("Any background check problems?", data)!, signal);
    expect(session.has("[Person 1]")).toBe(false);
    expect(out.paragraphs.join(" ")).not.toMatch(/\[(?:Person|Role) \d+\]/u);
    expect(out.paragraphs.join(" ")).toMatch(/\[Kept person 1\]/u);
    // The decisions addition mints exactly the labels its own tool reads do, in the same order.
    const a = new HarnessSession(), b = new HarnessSession();
    await decisionsLeftOut(new HarnessTools(data, a, { now: () => FRESH }), '{"answer":"not-covered"}', [], signal);
    const tb = new HarnessTools(data, b, { now: () => FRESH });
    for (const t of ["sunday.overview", "rooms.conflicts", "followups.unowned"]) await tb.run(t, {}, signal, "x");
    for (let n = 1; n <= 20; n++) for (const f of ["Person", "Role"]) expect(a.target(`[${f} ${n}]`), `${f} ${n}`).toEqual(b.target(`[${f} ${n}]`));
  });

  it("knows more ways of asking what needs a decision (L4)", () => {
    for (const q of ["What still needs a decision this Sunday?", "Any problems this Sunday?", "Anything I should know about Sunday?", "Are we good for Sunday?", "Is Sunday covered?",
      "What's open for Sunday?", "Anything I need to deal with this weekend?", "What needs my attention?", "Is everything set for Sunday?", "Any issues?"]) expect(isDecisionQuestion(q), q).toBe(true);
    for (const q of ["Who could cover Greeter?", "When is the youth retreat?", "Draft a note to Riley"]) expect(isDecisionQuestion(q), q).toBe(false);
    // A church that meets on another day asks about its own day (decision 18).
    for (const q of ["Is Wednesday covered?", "Are we ready for Saturday?", "Wednesday ready?", "Is this weekend covered?"]) expect(isDecisionQuestion(q), q).toBe(true);
  });

  it("lists every open decision here when a decision question names background checks, and says when nothing is open (H2, M2)", async () => {
    const data = kidsData(), tools = new HarnessTools(data, new HarnessSession(), { now: () => FRESH });
    const out = await openDecisions(tools, signal);
    const shown = out.paragraphs.map(p => out.fill(restoreLabels(p, tools.session, { names: data.capture!.names, timeZone: data.brief!.time_zone })));
    expect(shown[0]).toBe(ON_SUNDAY);
    // The heading says each needs a decision, so none says it again (owner's read of 0.3.2); a room keeps the page's own label.
    const kind = (p: string) => p.endsWith(KEPT_HERE) ? "background check" : p.startsWith("Room use needs review: ") ? "room"
      : p.endsWith(" has no owner.") ? "follow-up" : /^[A-Z][\w ]+ at 9:30 AM on November 22 (?:still needs 1 more person|has (?:no|\d+) confirmed (?:person|people))/u.test(p) ? "decision" : p;
    expect(shown.slice(1).map(kind)).toEqual(["decision", "decision", "decision", "decision", "background check", "background check", "room", "follow-up"]);
    // Every role filled and no rooms or follow-ups read: nothing open, said plainly (with its gaps, never as all clear).
    const capture = nov22Capture();
    capture.reads = capture.reads.map(r => r.collection === "needed_positions" ? { ...r, body: { ...r.body!, data: [] } } : r);
    const empty = harnessData({ mode: "live", capture, operationsOff: true });
    const none = await openDecisions(new HarnessTools(empty, new HarnessSession(), { now: () => FRESH }), signal);
    expect(none.paragraphs[0]).toBe(NOTHING_OPEN);
  });
});

// ---- Decision 18 (onboarding spec §5.1): a Wednesday church's answers never call its service Sunday -----------------

/** The fictional church moved to Wednesday, November 25: its rooms, follow-ups, group meeting and background checks too. */
const WEDNESDAY_RULES: SundayRules = { ...KIDS_RULES, sundayLeads: LEAD_RULES.sundayLeads };
function wednesdayData(rules: SundayRules = WEDNESDAY_RULES, capture: SundayCapture = wednesdayWithEverything()): HarnessData {
  const live: SundayCapture = { ...capture, kind: "live" };
  return { capture: live, brief: buildSundayBrief(live, rules, FRESH), operations: sundayOperations(live, rules, { now: FRESH }), decisions: [], rules,
    attention: null, granted: ["services", "operations"], mode: "live", connected: false };
}
/** With the Wednesday Nursery need marked not needed, so a decision is said back. */
function wednesdayDecided(): HarnessData {
  const data = wednesdayData();
  const nursery = data.brief!.findings.find(f => f.kind === "needs-people" && f.position?.team_id === TEAMS.nursery)!;
  return { ...data, decisions: [decide(nursery, "not-needed", "Only two babies registered", CHECKED)] };
}
const shownBy = (tools: HarnessTools, data: HarnessData) => (t: string) =>
  showTimes(restoreLabels(t, tools.session, { names: data.capture!.names, organization: data.capture!.organization, timeZone: data.brief!.time_zone }), data.brief!.time_zone);

describe("a Wednesday church's answers never say Sunday (decision 18)", () => {
  it("every fact every tool gives, with the day words and without them", async () => {
    const data = wednesdayDecided();
    expect(data.brief!.day).toMatchObject({ kind: "weekday", day: "Wednesday", date: "Wednesday, November 25" });
    const evidence = await allEnvelopes(data);
    const ids = [...new Set(evidence.flatMap(e => [...JSON.stringify(e.payload).matchAll(/"fact":"(f\d+)"/gu)].map(m => m[1]!)))];
    expect(ids.length).toBeGreaterThan(30);
    const said = (day: DayWords | null) => ids.flatMap(id => composeAnswer(JSON.stringify({ answer: "facts", facts: [id] }), evidence, day).paragraphs);
    const withDay = said(data.brief!.day!), without = said(null);
    for (const line of [...withDay, ...without]) expect(line).not.toMatch(/Sunday/u);
    // The real day and date, the page by its real name, and the Church rules' own words.
    // The Wednesday page's own counts (7 to decide, 4 worth a look), less the two background checks kept on this Mac; the
    // Nursery need marked not needed is settled, so it isn't counted (live review 2026-11-18).
    const view = applyDecisions(data.brief!, data.decisions);
    expect(sundayShownCount(view, data.operations)).toMatchObject({ decisions: 7, looks: 4 });
    expect(view.items.filter(i => i.state !== "resolved" && i.finding.kind === "background-check").map(i => i.finding.tone)).toEqual(["decision", "decision"]);
    // The page counts 7 and 4: the two kept on this Mac are said not to be counted here, so the counts never read as a contradiction.
    expect(withDay).toContain("For Wednesday, November 25, 5 things need a decision and 4 are worth a look. Some findings are shown only in Ozzie on this Mac, on the Wednesday page, and aren't counted here.");
    expect(withDay.join(" ")).toContain("You decided: not needed this Wednesday.");
    expect(withDay.join(" ")).toMatch(/is scheduled \d+ weeks in a row/u);
    expect(withDay.join(" ")).toContain("They ask for a scheduled Wednesday lead for [Role");
    expect(withDay.join(" ")).toMatch(/1 person serving this Wednesday has a group meeting at the same time\./u);
    expect(withDay.join(" ")).toContain("(oversight of the team, not a serving assignment)");
    // Without them (what composeAnswer's callers pass today): the plan's own date, and neutral words otherwise.
    expect(without).toContain("For Wednesday, November 25, 5 things need a decision and 4 are worth a look. Some findings are shown only in Ozzie on this Mac and aren't counted here.");
    expect(without.join(" ")).toContain("You decided: not needed for this service.");
    expect(without.join(" ")).toContain("They ask for a scheduled lead for [Role");
    expect(without.join(" ")).toMatch(/1 person serving at this service has a group meeting at the same time\./u);
  });

  it("answers written on this Mac: kids teams, background checks, open decisions, what's set aside and nobody scheduled", async () => {
    const lines: string[] = [];
    const run = async (data: HarnessData, work: (tools: HarnessTools) => Promise<{ paragraphs: string[]; fill: (s: string) => string }>) => {
      const tools = new HarnessTools(data, new HarnessSession(), { now: () => FRESH });
      const out = await work(tools);
      const shown = out.paragraphs.map(p => out.fill(shownBy(tools, data)(p)));
      lines.push(...shown);
      return shown;
    };
    const data = wednesdayDecided();
    for (const typed of ["Is the nursery ready?", "Any background check problems?", "Who could cover the nursery?"]) {
      expect((await run(data, t => kidsAnswer(t, kidsQuestion(typed, data)!, signal))).length, typed).toBeGreaterThan(0);
    }
    const checks = await run(data, t => kidsAnswer(t, kidsQuestion("Any background check problems?", data)!, signal));
    expect(checks.join(" ")).toMatch(/background check on file expires before Wednesday\./u);
    expect((await run(data, t => decisionsLeftOut(t, '{"answer":"not-covered"}', [], signal)))[0]).toBe("Also on the Wednesday page, needing a decision:");
    expect((await run(data, t => openDecisions(t, signal)))[0]).toBe("On the Wednesday page, needing a decision:");
    const aside = await run(setAsideIn(data, f => f.kind === "background-check"), t => kidsAnswer(t, kidsQuestion("Any background check problems?", data)!, signal));
    expect(aside).toEqual(["2 background checks are set aside by your Church rules, so they aren't listed here; they're on the Wednesday page."]);
    const nobody = wednesdayData({ ...RULES, kidsTeams: [{ team_id: "7599999", min_confirmed: 2 }] });
    const quiet = await run(nobody, t => kidsAnswer(t, kidsQuestion("Any background check problems?", nobody)!, signal));
    expect(quiet).toEqual(["No one is confirmed or pending on your kids teams this Wednesday, so there were no background checks to look at."]);
    // An untimed background check says the day, never a fixed Sunday.
    const finding = data.brief!.findings.find(f => f.kind === "background-check")!;
    expect(backgroundSentence({ ...finding, position: { ...finding.position!, interval: null } }, "[Kept person 1]", "[Kept role 1]", null, "Needs a decision", data.brief!.day!))
      .toMatch(/Scheduled for \[Kept role 1\] this Wednesday\./u);
    for (const line of lines) expect(line).not.toMatch(/Sunday/u);
  });

  it("the fictional church is a Sunday, and keeps its own words", async () => {
    const data = kidsData();
    expect(data.brief!.day).toMatchObject({ day: "Sunday" });
    const tools = new HarnessTools(data, new HarnessSession(), { now: () => FRESH });
    const overview = await tools.run("sunday.overview", {}, signal, "t");
    const head = composeAnswer(JSON.stringify({ answer: "facts", facts: [(overview.payload as { fact: string }).fact] }), [overview], data.brief!.day!).paragraphs[0];
    expect(head).toMatch(/^For Sunday, November 22, \d+ things need a decision .* on the Sunday page, and aren't counted here\.$/u);
    expect([ALSO_ON_SUNDAY, ON_SUNDAY, NOBODY_SCHEDULED]).toEqual([alsoOnPage(SUNDAY_WORDS), onPage(SUNDAY_WORDS), nobodyScheduled(SUNDAY_WORDS)]);
    expect(NOBODY_SCHEDULED).toBe("No one is confirmed or pending on your kids teams this Sunday, so there were no background checks to look at.");
    expect(setAside(1, "finding", data.brief!.day!)).toBe("One finding is set aside by your Church rules, so it isn't listed here; it's on the Sunday page.");
  });

  it("a weekend, or a day not known, gets its own words, never a fixed Sunday", () => {
    const weekend = dayWords({ sort_date: "2026-11-21T17:00:00Z", times: ["2026-11-21T23:00:00Z", "2026-11-22T15:00:00Z"] }, "America/Chicago");
    expect(alsoOnPage(weekend)).toBe("Also on the “This weekend” page, needing a decision:");
    expect(nobodyScheduled(weekend)).toBe("No one is confirmed or pending on your kids teams this weekend, so there were no background checks to look at.");
    expect(nobodyScheduled(UNKNOWN_WORDS)).toBe("No one is confirmed or pending on your kids teams for your service, so there were no background checks to look at.");
    expect(setAside(2, "finding", UNKNOWN_WORDS)).toBe("2 findings are set aside by your Church rules, so they aren't listed here; they're on the “Your service” page.");
  });
});
