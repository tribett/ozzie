// Structured answers (review 2026-11-14 section C): the model only chooses fact ids, and Ozzie writes the answer on
// this Mac from fixed sentences, in its own order, with drafts only ever the drafting tool's text. Fictional data.
import { describe, expect, it } from "vitest";
import type { AgentStepReply, AgentStepRequest, ModelStep, ToolEnvelope } from "../../src/harness/contract.js";
import { bundledSkills } from "../../src/harness/bundled-skills.js";
import { composeAnswer, DRAFT_INTRO, NOT_COVERED_MORE, NOT_FREE, NOT_RANKED, NOTHING_TO_DECIDE } from "../../src/harness/compose.js";
import { envelopeProblems } from "../../src/harness/fixed.js";
import { Harness } from "../../src/harness/index.js";
import { HarnessSession } from "../../src/harness/session.js";
import { HarnessTools } from "../../src/harness/tools.js";
import { TsLoop } from "../../src/harness/ts-loop.js";
import { NOT_COVERED } from "../../src/ask.js";
import { allEnvelopes, FIXTURES, FRESH, harnessData, LEAD_RULES } from "./fixtures.js";

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
    expect(out.restored).toEqual([
      "Needs a decision: Greeter at 9:30 AM on November 22 still needs 1 more person, by Planning Center's count.",
      "Needs a decision: Nursery at 9:30 AM on November 22 still needs 1 more person, by Planning Center's count.",
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

describe("fixed framing for each kind of answer", () => {
  const help = async () => {
    const t = new HarnessTools(harnessData(), new HarnessSession(), { now: () => FRESH });
    const open = await t.run("sunday.open_needs", {}, signal, "x");
    const role = ((open.payload as { needs: { role: string }[] }).needs[0]!).role;
    return [open, await t.run("sunday.who_could_help", { role }, signal, "x"), await t.run("sunday.overview", {}, signal, "x")];
  };
  it("not covered: the fixed opening, then any facts read", async () => {
    const evidence = await help();
    expect(composeAnswer('{"answer":"not-covered"}', evidence).paragraphs).toEqual([NOT_COVERED]);
    const some = composeAnswer('{"answer":"not-covered","facts":["f1"]}', evidence);
    expect(some.paragraphs[0]).toBe(NOT_COVERED);
    expect(some.paragraphs[1]).toBe(NOT_COVERED_MORE);
    expect(some.paragraphs[2]).toMatch(/^This check found 2 roles that still need people and 0 with no scheduled lead\.$/u);
  });
  it("nothing needs a decision: the fixed sentence, then any facts", () => {
    const overview: ToolEnvelope = { tool: "sunday.overview", source: "Planning Center Services", check_time: "2026-11-20T15:00:00Z", completeness: "complete",
      payload: { fact: "f1", mode: "live", sunday: "2026-11-22", reads: 20, reads_not_completed: 0, needs_a_decision: 0, worth_a_look: 1,
        findings: [{ fact: "f2", kind: "check-in suggested", tone: "worth a look", person: "[Person 2]", sundays_in_a_row: 4 }] } };
    expect(composeAnswer('{"answer":"nothing-needs-a-decision","facts":["f2"]}', [overview]).paragraphs).toEqual([NOTHING_TO_DECIDE,
      "Worth a look: [Person 2] is scheduled 4 Sundays in a row. Your Church rules suggest a check-in, which is about care, not performance."]);
  });
  it("a draft is only the drafting tool's text (C1): a draft id with no draft, or another tool's, shows no draft", async () => {
    const evidence = await help();
    expect(composeAnswer('{"answer":"draft","draft":"d1"}', evidence)).toEqual({ kind: "not-covered", paragraphs: [NOT_COVERED], draft: null });
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

