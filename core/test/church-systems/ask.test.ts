// Ask for a church on B1 Church or Breeze (core/src/church-systems/harness.ts, harness/tools.ts `source`): the same tools
// and the same placeholder rule as Planning Center's, over the system's own brief. Every result fits the closed grammar,
// names the system as its source, and holds no name; answers say the system's name; Breeze, which ties no team to a
// role, says it can't suggest who could help. Fictional captures and a scripted model only.
import { describe, expect, it } from "vitest";
import type { AgentStepReply, AgentStepRequest, ModelStep } from "../../src/harness/contract.js";
import { bundledSkills } from "../../src/harness/bundled-skills.js";
import { composeAnswer } from "../../src/harness/compose.js";
import { envelopeProblems } from "../../src/harness/fixed.js";
import { HarnessHost } from "../../src/harness/host.js";
import { Harness, ASK_SKILL } from "../../src/harness/index.js";
import { HarnessSession } from "../../src/harness/session.js";
import { HarnessTools, NO_TEAM, type HarnessData } from "../../src/harness/tools.js";
import { TsLoop } from "../../src/harness/ts-loop.js";
import { suggestedQuestions } from "../../src/ask.js";
import { buildSystemBrief } from "../../src/church-systems/brief.js";
import { systemHarnessCapture } from "../../src/church-systems/harness.js";
import { SYSTEMS, type SystemCapture } from "../../src/church-systems/types.js";
import { b1Capture, breezeCapture, breezeUntimedCapture, NOW } from "./fixtures.js";
import { allEnvelopes } from "../harness/fixtures.js";

const skills = await bundledSkills();
const RULES = { sundayLeads: [], checkInAfterSundaysInARow: 3, kidsTeams: [{ team_id: "GRP-worship", min_confirmed: 2 }] };
/** Ask's data for a church on another system, as App builds it. */
function dataFor(capture: SystemCapture, saved = false): HarnessData {
  const built = buildSystemBrief(capture, { confirmedZone: capture.church.time_zone }, NOW);
  if (!built.ok) throw new Error(built.reason);
  return { capture: systemHarnessCapture(capture, saved), brief: built.brief, operations: null, decisions: [], rules: RULES, attention: null,
    granted: ["services"], mode: saved ? "recording" : "live", connected: false, source: SYSTEMS[capture.system].name };
}
const breezeAnswers = () => breezeCapture({ assignments: [
  { id: "71001", position_id: "9627", person_id: "157801", status: "unconfirmed", asked: null },
  { id: "71002", position_id: "9628", person_id: "157802", status: "accepted", asked: null }] });
const strings = (v: unknown): string[] => typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(strings)
  : v && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => [k, ...strings(x)]) : [];

describe("Ask's tools over a church on B1 Church or Breeze", () => {
  it("fit the closed grammar, name the system as the source, and hold no name, role name or church name", async () => {
    for (const capture of [b1Capture(), breezeAnswers()]) {
      const name = SYSTEMS[capture.system].name;
      const envelopes = await allEnvelopes(dataFor(capture));
      expect(envelopes.length, name).toBeGreaterThan(5);
      const secret = [...Object.values(capture.names), ...Object.values(capture.labels)];
      for (const e of envelopes) {
        expect(envelopeProblems(e), `${name} ${e.tool}`).toEqual([]);
        expect(envelopeProblems(JSON.parse(JSON.stringify(e))), `${name} ${e.tool}`).toEqual([]);
        expect([name, "Church rules on this Mac"]).toContain(e.source);
        for (const s of strings(e.payload)) for (const word of secret) expect(s.includes(word), `${name} ${e.tool}: ${word}`).toBe(false);
      }
      // Planning Center's own words (its count, its team leaders) are never part of another system's results.
      const all = JSON.stringify(envelopes);
      expect(all).not.toMatch(/team_leaders|remaining_means|Planning Center's own count/u);
      expect(all).not.toContain("some findings are shown only in Ozzie on this Mac");
    }
  });

  it("says Breeze lists no one for a role, and that it doesn't say whether a request was sent", async () => {
    const data = dataFor(breezeAnswers());
    const tools = new HarnessTools(data, new HarnessSession(), { now: () => NOW });
    const signal = new AbortController().signal;
    const needs = await tools.run("sunday.open_needs", {}, signal);
    const rows = (needs.payload as { needs: Record<string, unknown>[] }).needs;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row["people_listed"]).toBe(NO_TEAM);
    const role = rows[0]!["role"] as string;
    const who = await tools.run("sunday.who_could_help", { role }, signal);
    expect(who.payload).toMatchObject({ people_listed: NO_TEAM, people: [] });
    const said = composeAnswer(JSON.stringify({ answer: "facts", facts: [(who.payload as { fact: string }).fact] }), [who]).paragraphs;
    expect(said).toEqual([`Breeze doesn't tie a team to each role, so Ozzie can't suggest who could help with ${role}.`]);
    const pending = await tools.run("sunday.pending_requests", {}, signal);
    expect((pending.payload as { pending: Record<string, unknown>[] }).pending.map(p => p["request"])).toEqual(["not known"]);
    // Neither "Who could cover" nor a note to someone who could is offered for Breeze; B1 Church offers both.
    expect(suggestedQuestions(data.brief).some(q => /could cover/u.test(q))).toBe(false);
    expect(suggestedQuestions(dataFor(b1Capture()).brief).some(q => /^Who could cover /u.test(q))).toBe(true);
  });

  it("B1 Church: who could help is listed by label, and a request B1 Church says wasn't sent is said so", async () => {
    const data = dataFor(b1Capture());
    const tools = new HarnessTools(data, new HarnessSession(), { now: () => NOW });
    const signal = new AbortController().signal;
    const needs = await tools.run("sunday.open_needs", {}, signal);
    const greeter = (needs.payload as { needs: Record<string, unknown>[] }).needs.find(r => r["kind"] === "needs people" && typeof r["people_listed"] === "object")!;
    const who = await tools.run("sunday.who_could_help", { role: greeter["role"] as string }, signal);
    const people = (who.payload as { people: { person: string; status: string }[] }).people;
    expect(people.length).toBeGreaterThan(0);
    for (const p of people) expect(p.person).toMatch(/^\[Person \d+\]$/u);
    const pending = await tools.run("sunday.pending_requests", {}, signal);
    expect((pending.payload as { pending: Record<string, unknown>[] }).pending.map(p => p["request"])).toEqual(["request not sent yet"]);
  });

  it("doesn't offer check-ins, a Planning Center check again, or rooms, follow-ups and group meetings", () => {
    for (const capture of [b1Capture(), breezeAnswers()]) {
      const tools = new HarnessTools(dataFor(capture), new HarnessSession(), { now: () => NOW });
      const host = new HarnessHost({ workspace_id: "this-mac", tools, skills });
      const offered = host.admitted({ id: "t", kind: "ask", skill_id: ASK_SKILL, question: "x", workspace_id: "this-mac", created_at: NOW }).map(s => s.name);
      expect(offered).not.toContain("sunday.rule_checkins");
      expect(offered).not.toContain("planning_center.refresh");
      for (const t of ["rooms.conflicts", "followups.unowned", "groups.clashes"]) expect(offered).not.toContain(t);
      expect(offered).toContain("sunday.overview");
    }
  });
});

describe("a question about a B1 Church church, start to finish with a scripted model", () => {
  const call = (name: string, args: Record<string, unknown> = {}): AgentStepReply => ({ content: "", tool_calls: [{ id: "c", name, arguments: JSON.stringify(args) }], finish: "tool_calls" });
  const answer = (o: unknown): AgentStepReply => ({ content: JSON.stringify(o), tool_calls: [], finish: "stop" });
  type Turn = (r: AgentStepRequest) => AgentStepReply;
  async function ask(question: string, turns: Turn[], data: HarnessData) {
    let n = 0;
    const sent: AgentStepRequest[] = [];
    const model: ModelStep = async request => { sent.push(request); return turns[n++]!(request); };
    const h = new Harness({ workspace_id: "this-mac", data, skills, runtime: new TsLoop(), model, now: () => NOW, newId: () => "00000000-0000-4000-8000-0000000000bb" });
    const res = await h.ask(question);
    if (!res.ok) throw new Error(res.refusal);
    expect(res.outcome.status, `${question}: ${res.outcome.code}`).toBe("verified");
    const c = composeAnswer(res.outcome.answer!, res.outcome.evidence);
    return { sent, evidence: res.outcome.evidence, restored: c.paragraphs.map(p => h.restore(p)) };
  }

  it("What still needs a decision: the overview, in B1 Church's words, with names only once back on this Mac", async () => {
    const capture = b1Capture();
    const out = await ask("What still needs a decision this Sunday?", [
      () => call("sunday.overview"),
      r => {
        const tool = r.messages.find(m => m.role === "tool")!;
        const p = JSON.parse(tool.content) as { payload: { fact: string; findings: { fact: string }[] } };
        return answer({ answer: "facts", facts: [p.payload.fact, ...p.payload.findings.map(f => f.fact)] });
      },
    ], dataFor(capture));
    // Nothing that reached the model held a name, a role name or the church's name.
    const wire = JSON.stringify(out.sent);
    for (const word of [...Object.values(capture.names), ...Object.values(capture.labels)]) expect(wire.includes(word), word).toBe(false);
    expect(out.evidence.every(e => e.source === "B1 Church")).toBe(true);
    const text = out.restored.join("\n");
    expect(text).not.toContain("Planning Center");
    expect(text).toContain("by B1 Church's count");
    // Restored on this Mac: role names and people back in place of their labels.
    expect(text).toContain("Guitar");
    expect(text).toMatch(/Lark Fictional is pending for Greeter/u);
    expect(text).toContain("The request hasn't been sent yet.");
  });

  it("asking by a person's name sends their label, never the name", async () => {
    const capture = b1Capture();
    const out = await ask("Why is Lark Fictional flagged?", [
      () => call("sunday.pending_requests"),
      r => {
        const tool = r.messages.find(m => m.role === "tool")!;
        const p = JSON.parse(tool.content) as { payload: { pending: { fact: string }[] } };
        return answer({ answer: "facts", facts: p.payload.pending.map(x => x.fact) });
      },
    ], dataFor(capture));
    expect(JSON.stringify(out.sent)).not.toContain("Lark");
    expect(out.sent[0]!.messages.at(-1)!.content).toMatch(/\[Person \d+\]/u);
    expect(out.restored.join(" ")).toContain("Lark Fictional is pending for Greeter");
  });
});

describe("Ask over a Breeze service with no number needed and no time of day (round 4)", () => {
  const data = () => dataFor(breezeUntimedCapture());
  it("never says a role has no open need, says Breeze ties no team to roles, and gives no time of day", async () => {
    const tools = new HarnessTools(data(), new HarnessSession(), { now: () => NOW });
    const signal = new AbortController().signal;
    const pending = await tools.run("sunday.pending_requests", {}, signal);
    const rows = (pending.payload as { pending: Record<string, unknown>[] }).pending;
    expect(rows).toHaveLength(1);
    // The service has no time of day: no 12:00 AM is ever sent, only that the time isn't known.
    expect(rows[0]!["time"]).toBe("not known");
    expect(JSON.stringify(pending)).not.toMatch(/T00:00/u);
    const role = rows[0]!["role"] as string;
    const who = await tools.run("sunday.who_could_help", { role }, signal);
    expect(who.payload).toMatchObject({ people_listed: NO_TEAM, people: [] });
    expect(JSON.stringify(who.payload)).not.toContain("none in the last check");
    const said = composeAnswer(JSON.stringify({ answer: "facts", facts: [(who.payload as { fact: string }).fact] }), [who]).paragraphs;
    expect(said).toEqual([`Breeze doesn't tie a team to each role, so Ozzie can't suggest who could help with ${role}.`]);
    // Every result still fits the closed grammar the site checks.
    for (const e of await allEnvelopes(data())) expect(envelopeProblems(e), e.tool).toEqual([]);
  });
});

describe("Ask never says a church system's role has no open need when the check couldn't tell (review of round 4, M1)", () => {
  const signal = new AbortController().signal;
  it("Breeze, with who is scheduled not read whole: no team is tied to its roles, as for an open need", async () => {
    const capture = breezeUntimedCapture({ reads: breezeUntimedCapture().reads.map(r => r.read === "breeze.volunteers" ? { ...r, outcome: "timeout" as const } : r) });
    const session = new HarnessSession();
    const tools = new HarnessTools(dataFor(capture), session, { now: () => NOW });
    const who = await tools.run("sunday.who_could_help", { role: session.role("Greeter") }, signal);
    expect(who.payload).toMatchObject({ people_listed: NO_TEAM, people: [] });
    expect(envelopeProblems(who)).toEqual([]);
  });

  it("B1 Church, a role whose count B1 didn't give: the check couldn't tell, in words the site already knows", async () => {
    const capture = b1Capture({ positions: b1Capture().positions.map(p => p.id === "POS-guitar" ? { ...p, needed: null } : p) });
    const session = new HarnessSession();
    const tools = new HarnessTools(dataFor(capture), session, { now: () => NOW });
    const role = session.role("Guitar");
    const who = await tools.run("sunday.who_could_help", { role }, signal);
    expect(who.payload).toMatchObject({ open_need: "not known", people: [] });
    expect(envelopeProblems(who)).toEqual([]);
    const said = composeAnswer(JSON.stringify({ answer: "facts", facts: [(who.payload as { fact: string }).fact] }), [who]).paragraphs;
    expect(said).toEqual([`The check couldn't tell whether ${role} needs anyone, so Ozzie doesn't list anyone for it.`]);
    // A role whose need is known and met still says so.
    const vocals = await tools.run("sunday.who_could_help", { role: session.role("Greeter") }, signal);
    expect(JSON.stringify(vocals.payload)).not.toContain("not known");
  });
});
