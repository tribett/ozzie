// Round 3, live finding A: on B1 Church, Ask's second step through Ozzie's AI failed every time as "the AI service
// couldn't be reached". The second step is the first to carry tool results, and ozzie.church checks each against its own
// copy of vocabulary.json (web/src/lib/hosted/envelope.ts `toolMessageOk`, requests.ts `checkAgentStep`). A copy from
// before the church systems were added doesn't list "B1 Church" as a source, so the step is refused (400
// invalid-request), which the Mac now says as Ozzie's AI not accepting it (native `not-accepted`), never the network.
// This runs the real Ask, with a scripted model, through ozzie.church's own request check, as the deployed site would.
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { AgentStepReply, AgentStepRequest, ModelStep } from "../../src/harness/contract.js";
import { bundledSkills } from "../../src/harness/bundled-skills.js";
import { Harness } from "../../src/harness/index.js";
import type { HarnessData } from "../../src/harness/tools.js";
import { TsLoop } from "../../src/harness/ts-loop.js";
import { buildSystemBrief } from "../../src/church-systems/brief.js";
import { systemHarnessCapture } from "../../src/church-systems/harness.js";
import { SYSTEMS, type SystemCapture } from "../../src/church-systems/types.js";
import { b1Capture, breezeCapture, NOW } from "./fixtures.js";
import { existsSync, readFileSync } from "node:fs";

const skills = await bundledSkills();
const VOCABULARY = "../../../web/src/lib/hosted/fixed/vocabulary.json";
// ozzie.church's own code, loaded at run time only (it is type-checked with web/, under its own settings).
const REQUESTS = "../../../web/src/lib/hosted/requests.js";
// ozzie.church's code isn't part of the public repository: there, this file is skipped.
const SITE = existsSync(new URL(VOCABULARY, import.meta.url));
const vocabulary = (SITE ? JSON.parse(readFileSync(new URL(VOCABULARY, import.meta.url), "utf8")) : { sources: [], values: [] }) as { sources: string[]; values: string[] };
type CheckAgentStep = (body: unknown) => { ok: boolean; error?: string };
function dataFor(capture: SystemCapture): HarnessData {
  const built = buildSystemBrief(capture, { confirmedZone: capture.church.time_zone }, NOW);
  if (!built.ok) throw new Error(built.reason);
  return { capture: systemHarnessCapture(capture, false), brief: built.brief, operations: null, decisions: [], rules: { sundayLeads: [], checkInAfterSundaysInARow: 3 },
    attention: null, granted: ["services"], mode: "live", connected: false, source: SYSTEMS[capture.system].name };
}
/** The second step's request (the first that carries tool results), as the Mac sends it to ozzie.church. */
async function secondStep(question: string, data: HarnessData, calls: (r: AgentStepRequest) => { name: string; arguments: string }[]): Promise<Record<string, unknown>> {
  const sent: AgentStepRequest[] = [];
  const model: ModelStep = async request => {
    sent.push(request);
    // Native gives each call its id `call_<step>_<n>` (agent.rs); the scripted model does the same.
    if (sent.length === 1) return { content: "", tool_calls: calls(request).map((c, n) => ({ id: `call_1_${n}`, ...c })), finish: "tool_calls" } satisfies AgentStepReply;
    return { content: JSON.stringify({ answer: "not-covered" }), tool_calls: [], finish: "stop" };
  };
  const h = new Harness({ workspace_id: "this-mac", data, skills, runtime: new TsLoop(), model, now: () => NOW, newId: () => "0f8b8f3e-2f4c-4a51-9c1d-3b7a2e6d5c11" });
  const res = await h.ask(question);
  if (!res.ok) throw new Error(res.refusal);
  expect(sent).toHaveLength(2);
  const step = sent[1]!;
  return { task_id: step.task_id, messages: step.messages, tools: step.tools, max_tokens: step.max_tokens, kind: "ask" };
}
const overview = () => [{ name: "sunday.overview", arguments: "{}" }, { name: "sunday.open_needs", arguments: "{}" }, { name: "sunday.pending_requests", arguments: "{}" }];
const check = async () => ((await import(/* @vite-ignore */ REQUESTS)) as { checkAgentStep: CheckAgentStep }).checkAgentStep;
afterEach(() => { vi.doUnmock(VOCABULARY); vi.resetModules(); });

describe.skipIf(!SITE)("Ask about a church on B1 Church or Breeze, through ozzie.church's own request check", () => {
  it("is accepted by the site's current copy of the vocabulary: every tool result fits, the system named as its source", async () => {
    const checkAgentStep = await check();
    for (const capture of [b1Capture(), breezeCapture({ assignments: [
      { id: "71001", position_id: "9627", person_id: "157801", status: "unconfirmed", asked: null },
      { id: "71002", position_id: "9628", person_id: "157802", status: "accepted", asked: null }] })]) {
      const body = await secondStep("What still needs a decision this Sunday?", dataFor(capture), overview);
      const results = (body.messages as { role: string; content: string }[]).filter(m => m.role === "tool").map(m => JSON.parse(m.content) as { source: string });
      expect(results.length).toBe(3);
      expect(results.every(r => r.source === SYSTEMS[capture.system].name)).toBe(true);
      expect(checkAgentStep(body), capture.system).toMatchObject({ ok: true });
    }
    // Who could cover a role, Breeze's no-team answer included.
    const breeze = dataFor(breezeCapture({ assignments: [{ id: "71001", position_id: "9627", person_id: "157801", status: "unconfirmed", asked: null }] }));
    const body = await secondStep("Who could cover Teacher?", breeze, r => [{ name: "sunday.who_could_help", arguments: JSON.stringify({ role: /\[Role \d+\]/u.exec(r.messages[1]!.content)![0] }) }]);
    expect(JSON.stringify(body)).toContain("no team is tied to roles in this church system");
    expect(checkAgentStep(body)).toMatchObject({ ok: true });
  });

  it("was refused by a copy from before the church systems were added: the live failure, reproduced", async () => {
    // The site's copy as it was before 84207da9 added the three names to its sources (and 74ca8ff1 the no-team value).
    const before = { ...vocabulary, sources: vocabulary.sources.filter(s => !["B1 Church", "Breeze", "Genesis"].includes(s)),
      values: vocabulary.values.filter(v => v !== "no team is tied to roles in this church system") };
    vi.resetModules();
    vi.doMock(VOCABULARY, () => ({ default: before }));
    const checkAgentStep = await check();
    const b1 = await secondStep("What still needs a decision this Sunday?", dataFor(b1Capture()), overview);
    expect(checkAgentStep(b1)).toEqual({ ok: false, error: "invalid-request" });
    // The same step with Planning Center as the source passes that same old copy: only the source's name was new.
    const asPlanningCenter = JSON.parse(JSON.stringify(b1).replaceAll('\\"source\\":\\"B1 Church\\"', '\\"source\\":\\"Planning Center Services\\"')) as Record<string, unknown>;
    expect(JSON.stringify(asPlanningCenter)).not.toContain("B1 Church");
    expect(checkAgentStep(asPlanningCenter)).toMatchObject({ ok: true });
  });
});
