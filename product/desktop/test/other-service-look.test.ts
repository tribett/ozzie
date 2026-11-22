// "Ask Ozzie to look at who could help" on a second or later watched service's card (owner decision 2026-11-19, "Services,
// and more than one service"; gap 2 of the feature audit 2026-11-22). The first service's look is unchanged: every request
// it sends with one service and with two is byte for byte what it sent before this change (hashes recorded from the code
// before it, ab1ff74f, with this very scripted model). Another service's look reads that service's own check alone
// (harness-bridge otherServiceData), so it is about that service's role even when the first service has a role of the same
// name, at that service's own day and time, and no role's, person's or service's name is in anything a model receives.
// Fixed fictional data, clocks pinned; nothing native runs.
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => { throw new Error("NATIVE_CALL_FORBIDDEN"); }) }));
import { lookAtWhoCouldHelp, otherServiceData } from "../src/harness-bridge.js";
import { askServices, mergedNames, mergeParts, teamServices } from "../src/services-merge.js";
import { buildSundayBrief, type Finding, type SundayBrief } from "../../../core/src/sunday-brief.js";
import { nov22Capture } from "../../../core/src/fictional-sunday.js";
import type { SundayCapture } from "../../../core/src/sunday-capture.js";
import { decide, type SundayDecision } from "../../../core/src/sunday-decisions.js";
import { wednesdayCapture } from "../../../core/test/fixtures/service-days/wednesday.js";
import { bundledSkills } from "../../../core/src/harness/bundled-skills.js";
import type { AgentStepReply, AgentStepRequest, ModelStep } from "../../../core/src/harness/contract.js";
import { Harness } from "../../../core/src/harness/index.js";
import { HarnessSession } from "../../../core/src/harness/session.js";
import type { HarnessData } from "../../../core/src/harness/tools.js";
import { TsLoop } from "../../../core/src/harness/ts-loop.js";

const skills = await bundledSkills();
const rules = { sundayLeads: [], checkInAfterSundaysInARow: 3 };
const WEEKEND = "Weekend Service", YOUTH = "Ozzie Demo Youth Night (fictional)";
const TASK = "00000000-0000-4000-8000-0000000000e1";

interface Part { capture: SundayCapture; name: string }
const weekend = (): Part => ({ capture: nov22Capture(), name: WEEKEND });
/** The second service: the fictional plan on a Wednesday, of its own service type, with teams of its own and the same roles. */
const youth = (): Part => ({ capture: { ...JSON.parse(JSON.stringify(wednesdayCapture()).replace(/\b75933(5[024])\b/gu, "85933$1")) as SundayCapture,
  service_type_id: "1700", plan_id: "94000001" }, name: YOUTH });
const briefOf = (p: Part): SundayBrief => buildSundayBrief(p.capture, rules, p.capture.completed_at);
const greeter = (b: SundayBrief): Finding => b.findings.find(f => f.kind === "needs-people" && f.position?.name === "Greeter")!;

const base = { operations: null, rules, attention: null, granted: ["services"], mode: "live", connected: true } as const;
/** The data the first service's card reads, as App builds it: its own check, or with two, every service's joined in. */
function watched(main: Part, others: Part[] = []): HarnessData {
  const mainBrief = briefOf(main), otherBriefs = others.map(briefOf);
  const asked = askServices({ brief: mainBrief, name: main.name }, others.map((o, i) => ({ plan_id: o.capture.plan_id, brief: otherBriefs[i]!, name: o.name })));
  if (!others.length) return { ...base, capture: main.capture, brief: mainBrief, decisions: [], ...asked };
  const m = mergeParts({ brief: mainBrief, decisions: [] }, others.map((o, i) => ({ plan_id: o.capture.plan_id, brief: otherBriefs[i]!, decisions: [] })));
  const serviceOfTeam = teamServices({ brief: mainBrief, name: main.name }, others.map((o, i) => ({ brief: otherBriefs[i]!, name: o.name })))!;
  return { ...base, capture: mergedNames(main.capture, others.map(o => o.capture)), brief: m.brief, decisions: m.decisions, serviceOfTeam, ...asked };
}

type Row = { fact: string };
const reply = (o: unknown): AgentStepReply => ({ content: JSON.stringify(o), tool_calls: [], finish: "stop" });
const call = (step: number, name: string, args: Record<string, unknown> = {}): AgentStepReply =>
  ({ content: "", tool_calls: [{ id: `call_${step}_0`, name, arguments: JSON.stringify(args) }], finish: "tool_calls" });
const payload = (r: AgentStepRequest, tool: string) => r.messages.flatMap(m => m.role === "tool" ? [JSON.parse(m.content) as { tool: string; payload: Record<string, unknown> }] : [])
  .filter(x => x.tool === tool).at(-1)?.payload;
/** Open roles, then the first one's people; then every person it listed and the role's time. */
function scripted(sent: AgentStepRequest[]): ModelStep {
  return async r => {
    sent.push(structuredClone(r));
    const needs = payload(r, "sunday.open_needs"), help = payload(r, "sunday.who_could_help");
    if (!needs) return call(sent.length, "sunday.open_needs");
    if (!help) return call(sent.length, "sunday.who_could_help", { role: (needs["needs"] as { role: string }[])[0]!.role });
    return reply({ answer: "facts", facts: [...(help["people"] as Row[]).map(p => p.fact), (help["times"] as Row[])[0]!.fact] });
  };
}
const hash = (sent: readonly AgentStepRequest[]) => createHash("sha256").update(JSON.stringify(sent)).digest("hex");
/** One look from a card, as App runs it (lookAtWhoCouldHelp over a harness for the data given), every request kept. */
async function look(data: HarnessData, finding: Finding, session = new HarnessSession()) {
  const sent: AgentStepRequest[] = [];
  const turn = await lookAtWhoCouldHelp(d => new Harness({ workspace_id: "fictional", data: d, skills, session, runtime: new TsLoop(), model: scripted(sent),
    now: () => d.capture!.completed_at, newId: () => TASK, macZone: "America/New_York" }), data, finding, { skills });
  if (turn.state !== "answered") throw new Error(JSON.stringify(turn));
  return { turn, sent };
}

// Recorded from the code before this change (ab1ff74f) with this scripted model: every request of the first service's look.
// With two services it sent the very same requests as with one (the look reads only its card's finding, labelled alike).
const PINS = {
  one: "6b08f29c9785ac60872afed5345e71fad44d3d8a9fa99474728bc841ab7cd79f",
  firstOfTwo: "6b08f29c9785ac60872afed5345e71fad44d3d8a9fa99474728bc841ab7cd79f",
} as const;

describe("the first service's look is unchanged", () => {
  it("with one service and with two, every request is byte for byte what it was before", async () => {
    const one = watched(weekend());
    expect(hash((await look(one, greeter(one.brief!))).sent)).toBe(PINS.one);
    const two = watched(weekend(), [youth()]);
    // The first service's own finding, as its card holds it: its id is unchanged in the joined check.
    const first = greeter(briefOf(weekend()));
    expect(two.brief!.findings.some(f => f.id === first.id)).toBe(true);
    expect(hash((await look(two, first)).sent)).toBe(PINS.firstOfTwo);
  });
});

describe("another service's look reads that service's own check alone (otherServiceData)", () => {
  /** What Youth Night's card hands the look, as App builds it: its own check, brief and decisions. */
  const youthLook = (decisions: readonly SundayDecision[] = []) => {
    const y = youth(), b = briefOf(y);
    return { data: otherServiceData({ capture: y.capture, brief: b, decisions }, { rules, status: null, configured: true, now: y.capture.completed_at }), finding: greeter(b), brief: b };
  };
  /** No position's name, no person's name, and no service's or plan's name in anything a model received. */
  function nothingNamed(sent: readonly AgentStepRequest[]) {
    const all = JSON.stringify(sent);
    const roles = [...briefOf(weekend()).positions, ...briefOf(youth()).positions].map(p => p.name.trim());
    expect(roles).toContain("Greeter");
    for (const role of roles) expect(all, role).not.toContain(role);
    for (const name of [...Object.values(weekend().capture.names), ...Object.values(youth().capture.names)]) for (const word of name.split(/\s+/u)) expect(all, word).not.toContain(word);
    for (const named of [WEEKEND, YOUTH, "Youth Night", "Ozzie Demo — Main Sunday (fictional)", "Youth Night (fictional)"]) expect(all, named).not.toContain(named);
  }

  it("holds that service's check, brief and decisions only: no other service, no service names, no rooms, nothing to check again", () => {
    const { data, brief } = youthLook();
    expect(data.capture!.plan_id).toBe("94000001");
    expect(data.brief).toBe(brief);
    expect(data.operations).toBeNull();
    expect(data.mode).toBe("live");
    expect(data.refresh).toBeUndefined();
    for (const k of ["services", "serviceOfTeam", "serviceOfFinding", "source"] as const) expect(data[k], k).toBeUndefined();
    // None of the first service's teams: its Greeter is another team's role of the same name.
    expect(data.brief!.findings.flatMap(f => f.position ? [f.position.team_id] : [])).not.toContain(greeter(briefOf(weekend())).position!.team_id);
    expect(greeter(brief).position!.team_id).not.toBe(greeter(briefOf(weekend())).position!.team_id);
  });

  it("is about that service's Greeter on its own day, though the first service has a Greeter with the same people, and names nothing", async () => {
    const { data, finding } = youthLook();
    const { turn, sent } = await look(data, finding);
    // The procedure read one open role: this service's Greeter, at its own time on Wednesday, November 25.
    const needs = payload(sent[1]!, "sunday.open_needs")!["needs"] as { time: { starts_at: string } }[];
    expect(needs).toHaveLength(1);
    expect(needs[0]!.time.starts_at).toMatch(/^2026-11-25T09:30/u);
    const help = payload(sent[2]!, "sunday.who_could_help")!;
    expect((help["times"] as { time: unknown }[]).map(t => t.time)).toEqual([needs[0]!.time]);
    expect(JSON.stringify(sent)).not.toContain("2026-11-22");
    expect(turn.answer.body).toMatch(/^Greeter at 9:30 AM on November 25 still needs 1 more person/u);
    nothingNamed(sent);
  });

  it("after the first service's look in the same session, as App runs both, is still about its own role and names nothing", async () => {
    const session = new HarnessSession();
    const two = watched(weekend(), [youth()]);
    const first = await look(two, greeter(briefOf(weekend())), session);
    expect(first.turn.answer.body).toMatch(/on November 22/u);
    const { data, finding } = youthLook();
    const { turn, sent } = await look(data, finding, session);
    expect(turn.answer.body).toMatch(/^Greeter at 9:30 AM on November 25 still needs 1 more person/u);
    expect(JSON.stringify(sent)).not.toContain("2026-11-22");
    nothingNamed([...first.sent, ...sent]);
  });

  it("reads that service's own decisions, never the first service's under the same key", async () => {
    // The leader marked Youth Night's Greeter covered outside Planning Center; the first service's Greeter is undecided.
    const { finding } = youthLook();
    const decided = decide(finding, "covered-outside", "A parent is covering", "2026-11-20T15:10:00Z");
    const { data } = youthLook([decided]);
    const { sent } = await look(data, finding);
    const needs = payload(sent[1]!, "sunday.open_needs")!["needs"] as { decision?: string }[];
    expect(needs[0]!.decision).toBeDefined();
    // The same look with no decision for it says none, whatever the first service holds.
    const { sent: plain } = await look(youthLook().data, finding);
    expect((payload(plain[1]!, "sunday.open_needs")!["needs"] as { decision?: string }[])[0]!.decision).toBeUndefined();
  });
});
