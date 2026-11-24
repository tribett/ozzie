// Ask on a church on B1 Church or Breeze with kids teams or roles marked (0.10.0): the overview carries the kids rule's
// counts as labels and numbers only, a kids question is answered on this Mac from that church's own marks, background
// checks are said plainly not to be read there, and nothing named reaches a model. Fictional data and a scripted model.
import { describe, expect, it } from "vitest";
import type { AgentStepReply, AgentStepRequest, ModelStep } from "../../src/harness/contract.js";
import { bundledSkills } from "../../src/harness/bundled-skills.js";
import { composeAnswer, kidsAnswer, kidsQuestion, noChecksFrom, noKidsMarked, rosterAnswer, rosterQuestion } from "../../src/harness/compose.js";
import { envelopeProblems } from "../../src/harness/fixed.js";
import { Harness } from "../../src/harness/index.js";
import { HarnessSession, restoreLabels } from "../../src/harness/session.js";
import { HarnessTools, type HarnessData } from "../../src/harness/tools.js";
import { TsLoop } from "../../src/harness/ts-loop.js";
import { buildSystemBrief } from "../../src/church-systems/brief.js";
import { systemHarnessCapture } from "../../src/church-systems/harness.js";
import { kidsMarked, withSystemKids } from "../../src/church-systems/kids.js";
import { SYSTEMS, type SystemCapture } from "../../src/church-systems/types.js";
import type { SundayRules } from "../../src/sunday-capture.js";
import { allEnvelopes } from "../harness/fixtures.js";
import { b1KidsCapture, breezeKidsCapture, breezeUntimedCapture, NOW } from "./fixtures.js";

const skills = await bundledSkills();
const NONE: SundayRules = { sundayLeads: [], checkInAfterSundaysInARow: 3 };
const signal = new AbortController().signal;

const b1Kids = () => b1KidsCapture(), breezeKids = () => breezeKidsCapture();
const B1_RULES = withSystemKids(NONE, "b1:CHU0000cedar", "GRP-kids", 2, "Kids Ministry");
const BREEZE_RULES = withSystemKids(NONE, "breeze:juniperstreet", "nursery", 2, "Nursery");

/** Ask's data for that church, as App builds it: its own brief, and its own marks for kids questions. */
function dataFor(capture: SystemCapture, rules: SundayRules): HarnessData {
  const built = buildSystemBrief(capture, { confirmedZone: capture.church.time_zone, ...(rules.systemKids ? { systemKids: rules.systemKids } : {}) }, NOW);
  if (!built.ok) throw new Error(built.reason);
  const kids = kidsMarked(capture, rules);
  return { capture: systemHarnessCapture(capture, false), brief: built.brief, operations: null, decisions: [], rules, attention: null,
    granted: ["services"], mode: "live", connected: false, source: SYSTEMS[capture.system].name, ...(kids.length ? { kids } : {}) };
}
const strings = (v: unknown): string[] => typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(strings)
  : v && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => [k, ...strings(x)]) : [];
/** A kids question answered on this Mac, restored as the panel shows it. */
async function here(typed: string, data: HarnessData) {
  const tools = new HarnessTools(data, new HarnessSession(), { now: () => NOW });
  const q = kidsQuestion(typed, data);
  if (!q) return null;
  const out = await kidsAnswer(tools, q, signal);
  const restore = (t: string) => restoreLabels(t, tools.session, { names: data.capture!.names, organization: data.capture!.organization, timeZone: data.brief!.time_zone });
  return { q, ...out, restored: out.paragraphs.map(t => out.fill(restore(t))) };
}

describe("Ask's tools with kids teams or roles marked on another system", () => {
  it("fit the closed grammar, name the system, and hold no name, role or team name", async () => {
    for (const [capture, rules] of [[b1Kids(), B1_RULES], [breezeKids(), BREEZE_RULES]] as const) {
      const name = SYSTEMS[capture.system].name;
      const envelopes = await allEnvelopes(dataFor(capture, rules));
      const secret = [...Object.values(capture.names), ...Object.values(capture.labels)];
      for (const e of envelopes) {
        expect(envelopeProblems(e), `${name} ${e.tool}`).toEqual([]);
        expect([name, "Church rules on this Mac"]).toContain(e.source);
        for (const s of strings(e.payload)) for (const word of secret) expect(s.includes(word), `${name} ${e.tool}: ${word}`).toBe(false);
      }
      const overview = envelopes.find(e => e.tool === "sunday.overview")!;
      const row = (overview.payload as { findings: Record<string, unknown>[] }).findings.find(f => f["kind"] === "fewer confirmed than the church rules ask")!;
      expect(row, name).toMatchObject({ tone: "needs a decision", confirmed: 1, needed: 2, ages: "confirmed people counted; ages not checked" });
      expect(String(row["role"])).toMatch(/^\[Role \d+\]$/u);
      // Breeze doesn't say whether a request was sent: neither count is known, never 0.
      if (capture.system === "breeze") expect(row).toMatchObject({ asked_no_answer: "not known", request_not_sent: "not known" });
      else expect(row).toMatchObject({ asked_no_answer: 1, request_not_sent: 1 });
    }
  });
});

describe("a kids question on another system, answered on this Mac", () => {
  it("B1 Church: is about the church's own kids team, with its finding in the page's words", async () => {
    const a = (await here("Are the kids teams covered?", dataFor(b1Kids(), B1_RULES)))!;
    expect(a.q).toMatchObject({ teams: ["GRP-kids"], marked: true });
    expect(a.restored).toEqual([
      "Needs a decision: Kids Ministry at this service has 1 confirmed person, and your Church rules ask for at least 2. 1 more is asked with no answer yet. 1 more has a request not sent yet. Pending isn't counted, and Ozzie doesn't check ages.",
      // The team's own role cards come with it, in B1 Church's name.
      "Worth a look: Moss Fictional is pending for Nursery at 9:00 AM on November 22. B1 Church shows the request as sent, with no answer yet. Pending is not the same as asked.",
      "Worth a look: Fern Fictional is pending for Nursery at 9:00 AM on November 22. The request hasn't been sent yet. Pending is not the same as asked.",
    ]);
    expect(a.restored.join(" ")).not.toMatch(/Planning Center|background/u);
  });

  it("B1 Church: says plainly that background checks aren't read there, and nothing else", async () => {
    const a = (await here("Do our nursery volunteers have background checks?", dataFor(b1Kids(), B1_RULES)))!;
    expect(a.restored).toEqual([noChecksFrom("B1 Church", "team")]);
    expect(noChecksFrom("B1 Church", "team")).toBe("Ozzie can't read background checks from B1 Church, so it doesn't check them for your kids teams.");
  });

  it("with nothing marked, says so in the system's own terms, never offering background checks", async () => {
    const a = (await here("Are the kids covered?", dataFor(b1Kids(), NONE)))!;
    expect(a.restored).toEqual([noKidsMarked("team")]);
    const breeze = (await here("Are the kids covered?", dataFor(breezeKids(), NONE)))!;
    expect(breeze.restored).toEqual(["No kids role is marked in your Church rules, so Ozzie doesn't count confirmed people for one. You can mark one in Church rules, under Kids roles."]);
  });

  it("Breeze: a role marked by name is found, its findings with it, and nothing is said as asked or not sent", async () => {
    const a = (await here("Is the nursery covered?", dataFor(breezeKids(), BREEZE_RULES)))!;
    expect(a.q).toMatchObject({ teams: ["role:nursery"], marked: true });
    expect(a.restored[0]).toBe("Needs a decision: Nursery at 10:30 AM on November 22 has 1 confirmed person, and your Church rules ask for at least 2. Pending isn't counted, and Ozzie doesn't check ages.");
    // Ash's own card (hasn't answered) is on the role too.
    expect(a.restored.join(" ")).toMatch(/Ash Fictional/u);
    expect(a.restored.join(" ")).not.toMatch(/asked with no answer|not sent/u);
  });

  it("Breeze, with no number for any role: what needs a decision leads with the kids role falling short", async () => {
    const rules = withSystemKids(NONE, "breeze:perlandera", "greeter", 1, "Greeter");
    const data = dataFor(breezeUntimedCapture(), rules);
    const q = rosterQuestion("What still needs a decision?", data)!;
    expect(q).toEqual({ kind: "decision", roles: [] });
    const tools = new HarnessTools(data, new HarnessSession(), { now: () => NOW });
    const out = await rosterAnswer(tools, { kind: q.kind as "decision", roles: q.roles }, signal);
    const shown = out.paragraphs.map(p => restoreLabels(p, tools.session, { names: data.capture!.names, organization: data.capture!.organization, timeZone: data.brief!.time_zone }));
    expect(shown[0]).toBe("Needs a decision: Greeter at this service has no confirmed people, and your Church rules ask for at least 1. Pending isn't counted, and Ozzie doesn't check ages.");
    expect(shown[1]).toBe("Ozzie can't say whether anything else needs a decision this Sunday: Breeze doesn't share how many people each role needs.");
    // Without a kids role marked, exactly as before.
    const plain = dataFor(breezeUntimedCapture(), NONE);
    const before = await rosterAnswer(new HarnessTools(plain, new HarnessSession(), { now: () => NOW }), { kind: "decision", roles: [] }, signal);
    expect(before.paragraphs[0]).toBe("Ozzie can't say whether anything needs a decision this Sunday: Breeze doesn't share how many people each role needs.");
  });
});

describe("a question about a B1 Church church with a kids team, start to finish with a scripted model", () => {
  const call = (name: string): AgentStepReply => ({ content: "", tool_calls: [{ id: "c", name, arguments: "{}" }], finish: "tool_calls" });
  const answer = (o: unknown): AgentStepReply => ({ content: JSON.stringify(o), tool_calls: [], finish: "stop" });
  it("What still needs a decision: the kids team's count goes as a label and numbers, and names come back only here", async () => {
    const capture = b1Kids();
    const sent: AgentStepRequest[] = [];
    const turns: ((r: AgentStepRequest) => AgentStepReply)[] = [
      () => call("sunday.overview"),
      r => {
        const p = JSON.parse(r.messages.find(m => m.role === "tool")!.content) as { payload: { fact: string; findings: { fact: string }[] } };
        return answer({ answer: "facts", facts: [p.payload.fact, ...p.payload.findings.map(f => f.fact)] });
      },
    ];
    let n = 0;
    const model: ModelStep = async request => { sent.push(structuredClone(request)); return turns[n++]!(request); };
    const h = new Harness({ workspace_id: "this-mac", data: dataFor(capture, B1_RULES), skills, runtime: new TsLoop(), model, now: () => NOW,
      newId: () => "00000000-0000-4000-8000-0000000000cc" });
    const res = await h.ask("What still needs a decision this Sunday?");
    if (!res.ok) throw new Error(res.refusal);
    expect(res.outcome.status).toBe("verified");
    const wire = JSON.stringify(sent);
    for (const word of [...Object.values(capture.names), ...Object.values(capture.labels)]) expect(wire.includes(word), word).toBe(false);
    const text = composeAnswer(res.outcome.answer!, res.outcome.evidence).paragraphs.map(p => h.restore(p)).join("\n");
    expect(text).toContain("Kids Ministry at this service has 1 confirmed person, and your Church rules ask for at least 2.");
    expect(text).not.toContain("Planning Center");
  });
});
