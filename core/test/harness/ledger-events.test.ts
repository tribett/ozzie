// Runtime events in the native ledger's detail grammar (review 2026-11-14 A6): one translation, pinned for
// every event shape the loops produce, with a TS mirror of native `detail_ok`.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HARNESS_LIMITS, type AgentRuntime, type AgentStepReply, type AgentTask, type ModelStep, type RuntimeDeps, type TaskEvent, type ToolHost, type ToolResult,
} from "../../src/harness/contract.js";
import { FAILURE_CODES, ledgerDetail, ledgerDetailOk } from "../../src/harness/ledger-events.js";
import { PiLoop } from "../../src/harness/pi-loop.js";
import { TsLoop } from "../../src/harness/ts-loop.js";

describe("ledgerDetail", () => {
  it("translates each runtime shape to the native grammar", () => {
    const cases: [TaskEvent["type"], string, string | null][] = [
      ["admitted", "", ""], ["running", "", ""], ["verified", "", ""], ["cancelled", "", ""], ["cancelled", "cancelled", "cancelled"],
      ["model", "step 1", "1"], ["model", "step 6", "6"], ["model", "step 12 stop", "12 stop"], ["model", "step 3 tool_calls", "3 tool_calls"], ["model", "step 2 limit", "2 limit"],
      ["tool", "sunday.open_needs:complete", "sunday.open_needs complete"], ["tool", "rooms.conflicts:denied", "rooms.conflicts denied"],
      ["tool", "drafts.prepare_note:provider-failure", "drafts.prepare_note provider-failure"], ["tool", "planning_center.refresh:stale", "planning_center.refresh stale"],
      ["tool", "unknown:denied", "denied"], ["tool", "unverified", "unverified"],
      ...FAILURE_CODES.map(code => ["failed", code, code] as [TaskEvent["type"], string, string]),
    ];
    for (const [type, detail, expected] of cases) expect(ledgerDetail({ type, detail }), `${type} ${detail}`).toBe(expected);
  });

  it("never names a tool outside the allowlist, and gives null for anything the grammar can't hold", () => {
    expect(ledgerDetail({ type: "tool", detail: "riley.thornbury:denied" })).toBe("denied");
    for (const [type, detail] of [["model", "step 0"], ["model", "step 100"], ["model", "1"], ["model", "step 1 maybe"], ["tool", "sunday.open_needs:weird"],
      ["tool", "Riley Thornbury"], ["failed", "egress because Riley"], ["failed", "oops"], ["verified", "Riley"], ["admitted", "x"], ["cancelled", "stopped"]] as [TaskEvent["type"], string][]) {
      expect(ledgerDetail({ type, detail }), `${type} ${detail}`).toBeNull();
    }
    expect(ledgerDetailOk("tool", "sunday.open_needs complete")).toBe(true);
    expect(ledgerDetailOk("tool", "email.send denied")).toBe(false);
    expect(ledgerDetailOk("model", `1 ${"x".repeat(70)}`)).toBe(false);
  });

  it("holds a model step that ended because the AI's answer listed too many facts, as native records it, and only as a step", () => {
    // agent.rs `outcome`: TooManyFacts finishes its step as "too-many-facts", so What happened can say so (review L4).
    expect(ledgerDetailOk("model", "2 too-many-facts")).toBe(true);
    expect(ledgerDetail({ type: "model", detail: "step 2 too-many-facts" })).toBe("2 too-many-facts");
    // Never a task's failure code: the task still fails as fidelity.
    expect(ledgerDetailOk("failed", "too-many-facts")).toBe(false);
    expect(ledgerDetailOk("tool", "sunday.overview too-many-facts")).toBe(false);
  });
});

// ---- Every event the loops emit -----------------------------------------------------------------

const NOW = "2026-11-20T15:00:00.000Z";
const SKILL: AgentTask = { id: "t", kind: "skill", skill_id: "who-could-help", workspace_id: "w", created_at: NOW };
const OPEN = "sunday.open_needs", OVERVIEW = "sunday.overview";
const spec = (name: string) => ({ name, description: name, parameters: { type: "object" as const, properties: {}, required: [], additionalProperties: false as const } });
const call = (id: string, name: string, args = "{}") => ({ id, name, arguments: args });
const turn = (...calls: ReturnType<typeof call>[]): AgentStepReply => ({ content: "", tool_calls: calls, finish: "tool_calls" });
const final = (content: string): AgentStepReply => ({ content, tool_calls: [], finish: "stop" });
const envelope = (tool: string) => ({ tool, source: "Planning Center Services", check_time: NOW, completeness: "complete" as const, payload: { remaining: 1 } });
function deps(replies: (AgentStepReply | Error | { code: string } | (() => Promise<AgentStepReply>))[], results: Record<string, ToolResult> = {}, over: Partial<RuntimeDeps> = {}): RuntimeDeps {
  let i = 0;
  const model: ModelStep = async () => { const r = replies[i++]; if (typeof r === "function") return r(); if (!r || r instanceof Error || !("finish" in r)) throw r ?? new Error("done"); return r; };
  const tools: ToolHost = { admitted: () => [spec(OPEN), spec(OVERVIEW)], run: async (_t, name) => results[name] ?? { ok: true, envelope: envelope(name) } };
  return { tools, model, instructions: () => "Fixed policy.", verify: answer => ({ ok: true, answer }), now: () => NOW, ...over };
}
afterEach(() => { vi.useRealTimers(); });

describe("every event both loops emit fits the native ledger grammar once translated", () => {
  for (const make of [() => new TsLoop(), () => new PiLoop()] as (() => AgentRuntime)[]) {
    it(make().name, async () => {
      const runs: Promise<TaskEvent[]>[] = [];
      const run = (d: RuntimeDeps, task: AgentTask = SKILL, signal?: AbortSignal) => runs.push(make().run(task, d, signal ? { signal } : {}).then(o => o.events));
      run(deps([turn(call("a", OPEN), call("b", OVERVIEW), call("c", "rooms.conflicts"), call("d", OPEN, "[1]")), final("Done.")],
        { [OVERVIEW]: { ok: false, error: "stale" } }));
      for (const error of ["partial", "provider-failure", "unverified", "denied"] as const) run(deps([turn(call("a", OPEN)), final("Done.")], { [OPEN]: { ok: false, error } }));
      run(deps([turn(call("a", OPEN), call("b", "email.send"))]));                                 // N5: unknown:denied, failed denied
      run(deps([], {}, {}));                                                                          // transport
      for (const code of ["egress", "no-model", "limit"]) run(deps([{ code }]));
      run(deps([final("x")], {}, { verify: () => ({ ok: false, code: "fidelity" }) }));
      run(deps([final("x")], {}, { verify: () => ({ ok: false, code: "egress" }) }));
      run(deps([{ content: "x", tool_calls: [], finish: "length" }]));
      run(deps(Array.from({ length: HARNESS_LIMITS.modelSteps + 1 }, (_, i) => turn(call(`c${i}`, OPEN)))));
      run(deps([turn(...Array.from({ length: HARNESS_LIMITS.toolCalls + 1 }, (_, i) => call(`c${i}`, OPEN)))]));
      run(deps([final("x")]), { ...SKILL, kind: "ask" } as AgentTask);                             // invalid-task (no question)
      run(deps([final("x")], {}, { instructions: () => { throw new Error("no procedure"); } }));
      const stopped = new AbortController(); stopped.abort();
      run(deps([final("x")]), SKILL, stopped.signal);                                                 // cancelled before any step
      const cancelling = new AbortController();
      run(deps([() => new Promise(() => {})]), SKILL, cancelling.signal);
      setTimeout(() => cancelling.abort(), 5);
      const all = (await Promise.all(runs)).flat();
      vi.useFakeTimers();
      const slow = make().run(SKILL, deps([() => new Promise(() => {})]));                             // timeout
      await vi.advanceTimersByTimeAsync(HARNESS_LIMITS.runMs);
      all.push(...(await slow).events);

      const shapes = new Set(all.map(e => `${e.type}|${e.detail}`));
      for (const e of all) expect(ledgerDetail(e), `${e.type} ${e.detail}`).not.toBeNull();
      for (const s of ["model|step 1", `tool|${OPEN}:complete`, `tool|${OVERVIEW}:stale`, "tool|rooms.conflicts:denied", `tool|${OPEN}:denied`, "tool|unknown:denied",
        "failed|denied", "failed|transport", "failed|egress", "failed|no-model", "failed|limit", "failed|fidelity", "failed|invalid-task", "failed|timeout",
        "cancelled|", "verified|", "admitted|", "running|"]) expect(shapes, s).toContain(s);
    }, 30_000);
  }
});
