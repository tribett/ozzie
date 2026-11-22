// A need the overview and the open roles both describe is said once (found in 0.5.8: "Greeter still needs 2 more
// people…" appeared under "Needs a decision" and again in full with the team-leader note). The longer sentence stands
// where the overview's row stood, under its tone. Fixed fictional data, clock pinned; written on this Mac only.
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => { throw new Error("NATIVE_CALL_FORBIDDEN"); }) }));
import { askOzzie } from "../src/harness-bridge.js";
import { askServices } from "../src/services-merge.js";
import { buildSundayBrief } from "../../../core/src/sunday-brief.js";
import { nov22Capture } from "../../../core/src/fictional-sunday.js";
import { bundledSkills } from "../../../core/src/harness/bundled-skills.js";
import { composeAnswer } from "../../../core/src/harness/compose.js";
import type { ToolEnvelope } from "../../../core/src/harness/contract.js";
import type { AgentStepReply, AgentStepRequest, ModelStep } from "../../../core/src/harness/contract.js";
import { Harness } from "../../../core/src/harness/index.js";
import type { HarnessData } from "../../../core/src/harness/tools.js";
import { TsLoop } from "../../../core/src/harness/ts-loop.js";

const skills = await bundledSkills();
const rules = { sundayLeads: [], checkInAfterSundaysInARow: 3 };
const call = (step: number, name: string): AgentStepReply => ({ content: "", tool_calls: [{ id: `call_${step}_0`, name, arguments: "{}" }], finish: "tool_calls" });
const results = (r: AgentStepRequest) => r.messages.flatMap(m => m.role === "tool" ? [JSON.parse(m.content) as { payload: Record<string, unknown> }] : []);
const factsOf = (p: Record<string, unknown>) => [p["fact"], ...["findings", "needs"].flatMap(k => Array.isArray(p[k]) ? (p[k] as { fact: string }[]).map(f => f.fact) : [])];
/** A scripted model: the overview, then the open roles, then every fact both gave. */
const model = (tools: readonly string[]): ModelStep => async r => {
  const got = results(r);
  if (got.length < tools.length) return call(got.length + 1, tools[got.length]!);
  return { content: JSON.stringify({ answer: "facts", facts: got.flatMap(g => factsOf(g.payload)).filter(Boolean) }), tool_calls: [], finish: "stop" };
};
async function ask(tools: readonly string[]) {
  const capture = nov22Capture(), brief = buildSundayBrief(capture, rules, capture.completed_at);
  const data: HarnessData = { operations: null, rules, attention: null, granted: ["services"], mode: "live", connected: true, capture, brief, decisions: [],
    ...askServices({ brief, name: "Weekend Service" }, []) };
  const harness = new Harness({ workspace_id: "fictional", data, skills, runtime: new TsLoop(), model: model(tools), now: () => capture.completed_at,
    newId: () => "00000000-0000-4000-8000-0000000000e1", macZone: "America/New_York" });
  const turn = await askOzzie(harness, "What still needs a decision?", { skills });
  if (turn.state !== "answered") throw new Error(JSON.stringify(turn));
  return turn.answer.body;
}
const count = (text: string, part: string) => text.split(part).length - 1;

describe("A need said by the overview and by the open roles", () => {
  it("is said once, in the longer words, under its tone", async () => {
    const alone = await ask(["sunday.overview"]), both = await ask(["sunday.overview", "sunday.open_needs"]);
    const needs = [...alone.matchAll(/^([A-Z].*?) still needs \d+ more (?:person|people)/gmu)].map(m => m[0]);
    expect(needs.length).toBeGreaterThan(0);
    for (const n of needs) expect(count(both, n), `${n}\n---\n${both}`).toBe(1);
    expect(both).toContain("Needs a decision");
    // Nothing the open roles add is lost, and it stands under its tone, before what is only worth a look.
    expect(count(both, "Team leaders in Planning Center: Jordan Ashdown")).toBe(1);
    expect(both.indexOf("Team leaders in Planning Center")).toBeGreaterThan(both.indexOf("Needs a decision"));
    expect(both.indexOf("Team leaders in Planning Center")).toBeLessThan(both.indexOf("Worth a look"));
  });
});

// The same, on fixed tool results in placeholder form (independent review of the first fix, 2026-11-22).
type R = Record<string, unknown>;
const env = (tool: string, payload: R, source = "Planning Center Services") => ({ tool, source, check_time: "2026-11-22T12:00:00Z", completeness: "complete", payload }) as unknown as ToolEnvelope;
const T = { starts_at: "2026-11-22T10:15-05:00", ends_at: "2026-11-22T11:30-05:00" }, UNTIMED = { starts_at: "not known" };
const need = (fact: string, time: R, extra: R = {}): R => ({ fact, kind: "needs people", role: "[Role 1]", time, remaining: 2, tone: "needs a decision", ...extra });
const overview = (fact: string, findings: R[]) => env("sunday.overview", { fact, mode: "live", sunday: "2026-11-22", reads: 5, reads_not_completed: 0,
  needs_a_decision: findings.filter(f => !f["decision"] || f["changed_since_decision"]).length, worth_a_look: 0, findings });
const open = (fact: string, time: R, leader: string, extra: R = {}): R => ({ fact, kind: "needs people", role: "[Role 1]", time, remaining: 2, confirmed: [],
  people_listed: { no_overlap_found: 1, possible_conflict: 0, needs_confirmation: 0, left_out: 0 }, team_leaders: [leader], ...extra });
const openNeeds = (fact: string, needs: R[], source?: string) => env("sunday.open_needs", { fact, needs }, source);
const say = (evidence: ToolEnvelope[], facts: string[]) => composeAnswer(JSON.stringify({ answer: "facts", facts }), evidence).paragraphs;
const NEEDS = "[Role 1] at 10:15 AM still needs 2 more people", BARE = "[Role 1] still needs 2 more people";
const SETTLED = { decision: "not needed this Sunday", changed_since_decision: false }, REOPENED = { decision: "not needed this Sunday", changed_since_decision: true };

describe("A need said by two tools, on fixed results", () => {
  it("the open roles read first: said once, after the overview's sentence, with its time and not its date again", () => {
    const p = say([openNeeds("f1", [open("f2", T, "[Person 9]")]), overview("f3", [need("f4", T)])], ["f1", "f2", "f3", "f4"]);
    expect(count(p.join("\n"), NEEDS)).toBe(1);
    expect(p.join("\n")).not.toContain("2026-11-22T");
    expect(p.at(-1)).toContain("Team leaders in Planning Center: [Person 9]");
  });
  it("a need the person settled: once, under Resolved by you, with their decision", () => {
    const p = say([overview("f1", [need("f2", T, SETTLED)]), openNeeds("f3", [open("f4", T, "[Person 9]", SETTLED)])], ["f1", "f2", "f3", "f4"]).join("\n");
    expect(count(p, NEEDS)).toBe(1);
    expect(count(p, "You decided: not needed")).toBe(1);
    expect(p).toContain("Resolved by you");
    expect(p).toContain("[Person 9]");
  });
  it("a need reopened by a later check: once, with the fresh-look words", () => {
    const p = say([overview("f1", [need("f2", T, REOPENED)]), openNeeds("f3", [open("f4", T, "[Person 9]", REOPENED)])], ["f1", "f2", "f3", "f4"]).join("\n");
    expect(count(p, NEEDS)).toBe(1);
    expect(count(p, "A later check changed something")).toBe(1);
  });
  it("another church system, both tools in the very same words: once", () => {
    const row = { fact: "f4", kind: "needs people", role: "[Role 1]", time: T, remaining: 2, confirmed: [], people_listed: { no_overlap_found: 0, possible_conflict: 0, needs_confirmation: 0, left_out: 0 } };
    const p = say([env("sunday.overview", { fact: "f1", mode: "live", sunday: "2026-11-22", reads: 5, reads_not_completed: 0, needs_a_decision: 1, worth_a_look: 0, findings: [need("f2", T)] }, "B1 Church"),
      openNeeds("f3", [row], "B1 Church")], ["f1", "f2", "f3", "f4"]).join("\n");
    expect(count(p, NEEDS)).toBe(1);
  });
  it("two needs of one role name, one settled and one open: each keeps its own team leader and decision", () => {
    const p = say([overview("f1", [need("f2", UNTIMED, SETTLED), need("f3", UNTIMED)]),
      openNeeds("f4", [open("f5", UNTIMED, "[Person 7]", SETTLED), open("f6", UNTIMED, "[Person 8]")])], ["f1", "f2", "f3", "f4", "f5", "f6"]);
    expect(count(p.join("\n"), BARE)).toBe(2);
    expect(p.find(x => x.includes("[Person 7]"))).toContain("You decided: not needed");
    expect(p.find(x => x.includes("[Person 8]"))).not.toContain("You decided");
  });
  it("two needs of one role name, one reopened and one open: nothing the open roles said is lost", () => {
    const p = say([overview("f1", [need("f2", UNTIMED), need("f3", UNTIMED, REOPENED)]),
      openNeeds("f4", [open("f5", UNTIMED, "[Person 8]"), open("f6", UNTIMED, "[Person 7]", REOPENED)])], ["f1", "f2", "f3", "f4", "f5", "f6"]).join("\n");
    expect(count(p, "[Person 8]")).toBe(1);
    expect(count(p, "[Person 7]")).toBe(1);
    expect(count(p, BARE)).toBe(2);
  });
});
