// PiLoop: the pinned Pi agent driving one task through the frozen harness contract. Fictional fixed data
// only: a scripted ModelStep and a fake ToolHost. Nothing here reaches a provider or Planning Center.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HARNESS_LIMITS, NATIVE_TOOL_ALLOWLIST, type AgentStepReply, type AgentStepRequest, type AgentTask,
  type AgentToolCall, type ModelStep, type RuntimeDeps, type TaskEvent, type ToolEnvelope, type ToolHost,
  type ToolResult, type ToolSpec } from "../../src/harness/contract.js";
import { PiLoop } from "../../src/harness/pi-loop.js";

const NOW = "2026-11-15T09:00:00.000Z";
const SPEC = (name: string): ToolSpec => ({ name, description: `Fixed read: ${name}`,
  parameters: { type: "object", properties: {}, required: [], additionalProperties: false } });
const ENVELOPE = (tool: string, payload: unknown = { open: 1, role: "[Role 1]" }): ToolEnvelope =>
  ({ tool, source: "fixture", check_time: NOW, completeness: "complete", payload });
const ASK: AgentTask = { id: "task-1", kind: "ask", skill_id: "answer-from-what-was-read",
  question: "Which roles are still open for [Service 1]?", workspace_id: "ws-1", created_at: NOW };
const SKILL: AgentTask = { id: "task-2", kind: "skill", skill_id: "sunday-gaps", workspace_id: "ws-1", created_at: NOW };

const call = (id: string, name: string, args: unknown = {}): AgentToolCall =>
  ({ id, name, arguments: typeof args === "string" ? args : JSON.stringify(args) });
const tools = (...calls: AgentToolCall[]): AgentStepReply => ({ content: "", tool_calls: calls, finish: "tool_calls" });
const answer = (content: string): AgentStepReply => ({ content, tool_calls: [], finish: "stop" });

type Step = AgentStepReply | Error | { code: string } | ((request: AgentStepRequest, signal: AbortSignal) => Promise<AgentStepReply>);
function scripted(steps: Step[], fallback?: Step) {
  const requests: AgentStepRequest[] = [];
  const signals: AbortSignal[] = [];
  const model: ModelStep = async (request, signal) => {
    requests.push(structuredClone(request)); signals.push(signal);
    const step = steps[requests.length - 1] ?? fallback;
    if (!step) throw new Error("script exhausted");
    if (typeof step === "function") return step(request, signal);
    if (step instanceof Error || !("finish" in step)) throw step;
    return structuredClone(step);
  };
  return { model, requests, signals };
}

type Run = (args: Record<string, unknown>, signal: AbortSignal) => Promise<ToolResult> | ToolResult;
function host(admitted: string[], handlers: Record<string, Run> = {}) {
  const runs: Array<{ name: string; args: Record<string, unknown> }> = [];
  const signals: AbortSignal[] = [];
  const toolHost: ToolHost = {
    admitted: () => admitted.map(SPEC),
    run: async (_task, name, args, signal) => {
      runs.push({ name, args: structuredClone(args) }); signals.push(signal);
      if (!admitted.includes(name)) return { ok: false, error: "denied" };
      const handler = handlers[name];
      return handler ? handler(args, signal) : { ok: true, envelope: ENVELOPE(name) };
    },
  };
  return { toolHost, runs, signals };
}

function deps(model: ModelStep, toolHost: ToolHost, overrides: Partial<RuntimeDeps> = {}) {
  const verifyCalls: Array<{ answer: string; evidence: ToolEnvelope[] }> = [];
  const value: RuntimeDeps = {
    tools: toolHost, model,
    instructions: task => `Fixed policy. Procedure for ${task.skill_id}.`,
    verify: (text, evidence) => {
      verifyCalls.push({ answer: text, evidence: structuredClone(evidence) });
      return { ok: true, answer: text };
    },
    now: () => NOW,
    ...overrides,
  };
  return { deps: value, verifyCalls };
}

const types = (events: TaskEvent[]) => events.map(e => `${e.type}${e.detail ? ` ${e.detail}` : ""}`);
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise<void>(resolve => queueMicrotask(resolve)); };
const VOCAB = new RegExp(`^(|step [1-9]|(${[...NATIVE_TOOL_ALLOWLIST, "unknown"].map(n => n.replace(".", "\\.")).join("|")}):` +
  "(complete|partial|stale|denied|provider-failure|unverified))$");

// No network from Pi itself: any attempt fails the test loudly.
const fetchSpy = vi.fn(() => { throw new Error("network attempted"); });
const xhrSpy = vi.fn(() => { throw new Error("network attempted"); });
beforeEach(() => {
  vi.stubGlobal("fetch", fetchSpy);
  vi.stubGlobal("XMLHttpRequest", xhrSpy);
  vi.stubGlobal("WebSocket", xhrSpy);
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(xhrSpy).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  fetchSpy.mockClear(); xhrSpy.mockClear();
  vi.useRealTimers();
});

describe("PiLoop — conversation shape (1)", () => {
  it("sends the instructions as system, the question as user, the admitted specs as tools, and max_tokens", async () => {
    const { model, requests } = scripted([tools(call("c1", "sunday.open_needs")), answer("[Role 1] is open.")]);
    const { toolHost } = host(["sunday.open_needs", "sunday.overview"]);
    const outcome = await new PiLoop().run(ASK, deps(model, toolHost).deps);
    expect(outcome.status).toBe("verified");
    const first = requests[0]!;
    expect(first.task_id).toBe("task-1");
    expect(first.messages).toEqual([
      { role: "system", content: "Fixed policy. Procedure for answer-from-what-was-read." },
      { role: "user", content: "Which roles are still open for [Service 1]?" },
    ]);
    expect(first.tools).toEqual([SPEC("sunday.open_needs"), SPEC("sunday.overview")]);
    expect(first.max_tokens).toBe(HARNESS_LIMITS.maxTokens);
  });

  it("uses the fixed procedure prompt for a skill task", async () => {
    const { model, requests } = scripted([answer("Nothing to flag.")]);
    await new PiLoop().run(SKILL, deps(model, host([]).toolHost).deps);
    expect(requests[0]!.messages[1]).toEqual({ role: "user", content: "Run this procedure now. Answer only with the JSON object." });
    expect(requests[0]!.tools).toEqual([]);
  });

  it("starts a fresh conversation for every task, even on the same runtime instance", async () => {
    const loop = new PiLoop();
    const a = scripted([tools(call("c1", "sunday.open_needs")), answer("one")]);
    const b = scripted([answer("two")]);
    const { toolHost } = host(["sunday.open_needs"]);
    await loop.run(ASK, deps(a.model, toolHost).deps);
    const second = await loop.run(SKILL, deps(b.model, toolHost).deps);
    expect(b.requests[0]!.messages).toHaveLength(2);
    expect(second.evidence).toEqual([]);
    expect(second.answer).toBe("two");
  });

  it("echoes the model's own call ids, names and raw arguments and returns envelopes as tool messages", async () => {
    const { model, requests } = scripted([tools(call("call_A", "sunday.open_needs", { service: "[Service 1]" })),
      answer("[Role 1] is open.")]);
    const { toolHost, runs } = host(["sunday.open_needs"]);
    await new PiLoop().run(ASK, deps(model, toolHost).deps);
    expect(runs).toEqual([{ name: "sunday.open_needs", args: { service: "[Service 1]" } }]);
    expect(requests[1]!.messages.slice(2)).toEqual([
      { role: "assistant", content: "", tool_calls: [call("call_A", "sunday.open_needs", { service: "[Service 1]" })] },
      { role: "tool", tool_call_id: "call_A", content: JSON.stringify(ENVELOPE("sunday.open_needs")) },
    ]);
  });
});

describe("PiLoop — denied calls (2)", () => {
  it("never runs a name that is not admitted and tells the model it was denied", async () => {
    const { model, requests } = scripted([tools(call("c1", "rooms.conflicts")), answer("done")]);
    const { toolHost, runs } = host(["sunday.open_needs"]);
    const outcome = await new PiLoop().run(ASK, deps(model, toolHost).deps);
    expect(runs).toEqual([]);
    expect(requests[1]!.messages.at(-1)).toEqual({ role: "tool", tool_call_id: "c1", content: '{"error":"denied"}' });
    expect(types(outcome.events)).toContain("tool rooms.conflicts:denied");
  });

  it("stops at a model-invented name, reports it as unknown and never echoes it to the model (review N5)", async () => {
    const { model, requests } = scripted([tools(call("c1", "Jane Doe's phone"), call("c2", "shell.exec")), answer("done")]);
    const { toolHost, runs } = host(["sunday.open_needs"]);
    const outcome = await new PiLoop().run(ASK, deps(model, toolHost).deps);
    expect(runs).toEqual([]);
    expect(outcome).toMatchObject({ status: "failed", code: "denied", answer: null });
    expect(types(outcome.events).filter(t => t.startsWith("tool"))).toEqual(["tool unknown:denied", "tool unknown:denied"]);
    expect(JSON.stringify(outcome.events)).not.toContain("Jane");
    expect(requests).toHaveLength(1);
  });

  it.each([["not json", "{oops"], ["an array", "[1]"], ["null", "null"], ["a string", '"x"'], ["a number", "3"]])(
    "denies an admitted tool whose arguments are %s", async (_label, raw) => {
      const { model, requests } = scripted([tools(call("c1", "sunday.open_needs", raw)), answer("done")]);
      const { toolHost, runs } = host(["sunday.open_needs"]);
      const outcome = await new PiLoop().run(ASK, deps(model, toolHost).deps);
      expect(runs).toEqual([]);
      expect(requests[1]!.messages.at(-1)).toEqual({ role: "tool", tool_call_id: "c1", content: '{"error":"denied"}' });
      expect(requests[1]!.messages.at(-2)).toEqual({ role: "assistant", content: "", tool_calls: [call("c1", "sunday.open_needs", raw)] });
      expect(types(outcome.events)).toContain("tool sunday.open_needs:denied");
    });
});

describe("PiLoop — tool results (3, 9)", () => {
  it("sends a tool error as {error:code} and keeps it out of evidence", async () => {
    const { model, requests } = scripted([tools(call("c1", "sunday.open_needs")), answer("done")]);
    const { toolHost } = host(["sunday.open_needs"], { "sunday.open_needs": () => ({ ok: false, error: "stale" }) });
    const { deps: d, verifyCalls } = deps(model, toolHost);
    const outcome = await new PiLoop().run(ASK, d);
    expect(requests[1]!.messages.at(-1)).toEqual({ role: "tool", tool_call_id: "c1", content: '{"error":"stale"}' });
    expect(types(outcome.events)).toContain("tool sunday.open_needs:stale");
    expect(verifyCalls[0]!.evidence).toEqual([]);
  });

  it("replaces an oversized envelope with {error:partial} and does not count it as evidence", async () => {
    const big = ENVELOPE("sunday.overview", { rows: "x".repeat(HARNESS_LIMITS.envelopeChars) });
    const { model, requests } = scripted([tools(call("c1", "sunday.overview"), call("c2", "sunday.open_needs")), answer("done")]);
    const { toolHost } = host(["sunday.overview", "sunday.open_needs"], { "sunday.overview": () => ({ ok: true, envelope: big }) });
    const { deps: d, verifyCalls } = deps(model, toolHost);
    const outcome = await new PiLoop().run(ASK, d);
    expect(requests[1]!.messages.slice(-2)).toEqual([
      { role: "tool", tool_call_id: "c1", content: '{"error":"partial"}' },
      { role: "tool", tool_call_id: "c2", content: JSON.stringify(ENVELOPE("sunday.open_needs")) },
    ]);
    expect(types(outcome.events).filter(t => t.startsWith("tool"))).toEqual(["tool sunday.overview:partial", "tool sunday.open_needs:complete"]);
    expect(verifyCalls[0]!.evidence).toEqual([ENVELOPE("sunday.open_needs")]);
    expect(outcome.evidence).toEqual([ENVELOPE("sunday.open_needs")]);
  });

  it("keeps an envelope exactly at the size limit", async () => {
    const base = JSON.stringify(ENVELOPE("sunday.overview", { rows: "" })).length;
    const exact = ENVELOPE("sunday.overview", { rows: "x".repeat(HARNESS_LIMITS.envelopeChars - base) });
    expect(JSON.stringify(exact)).toHaveLength(HARNESS_LIMITS.envelopeChars);
    const { model } = scripted([tools(call("c1", "sunday.overview")), answer("done")]);
    const { toolHost } = host(["sunday.overview"], { "sunday.overview": () => ({ ok: true, envelope: exact }) });
    const outcome = await new PiLoop().run(ASK, deps(model, toolHost).deps);
    expect(outcome.evidence).toEqual([exact]);
  });

  it("runs several calls from one step one at a time, in call order, and keeps evidence in that order", async () => {
    const order: string[] = [];
    let active = 0;
    const slow = (name: string): Run => async () => {
      active++; expect(active).toBe(1); order.push(`start ${name}`);
      await new Promise(resolve => setTimeout(resolve, name === "sunday.overview" ? 5 : 1));
      order.push(`end ${name}`); active--;
      return { ok: true, envelope: ENVELOPE(name) };
    };
    const { model } = scripted([tools(call("c1", "sunday.overview"), call("c2", "rooms.conflicts"), call("c3", "sunday.open_needs")),
      answer("done")]);
    const { toolHost } = host(["sunday.overview", "sunday.open_needs"], { "sunday.overview": slow("sunday.overview"),
      "sunday.open_needs": slow("sunday.open_needs") });
    const outcome = await new PiLoop().run(ASK, deps(model, toolHost).deps);
    expect(order).toEqual(["start sunday.overview", "end sunday.overview", "start sunday.open_needs", "end sunday.open_needs"]);
    expect(types(outcome.events).filter(t => t.startsWith("tool"))).toEqual(
      ["tool sunday.overview:complete", "tool rooms.conflicts:denied", "tool sunday.open_needs:complete"]);
    expect(outcome.evidence.map(e => e.tool)).toEqual(["sunday.overview", "sunday.open_needs"]);
  });

  it("treats a throwing tool host as a provider failure, not a crash", async () => {
    const { model, requests } = scripted([tools(call("c1", "sunday.open_needs")), answer("done")]);
    const { toolHost } = host(["sunday.open_needs"], { "sunday.open_needs": () => { throw new Error("boom with [Person 1]"); } });
    const outcome = await new PiLoop().run(ASK, deps(model, toolHost).deps);
    expect(requests[1]!.messages.at(-1)).toEqual({ role: "tool", tool_call_id: "c1", content: '{"error":"provider-failure"}' });
    expect(types(outcome.events)).toContain("tool sunday.open_needs:provider-failure");
    expect(outcome.status).toBe("verified");
  });

  it("gives up on a tool after toolMs and aborts its signal", async () => {
    vi.useFakeTimers();
    const { model, requests } = scripted([tools(call("c1", "sunday.open_needs")), answer("done")]);
    const { toolHost, signals } = host(["sunday.open_needs"], { "sunday.open_needs": () => new Promise<ToolResult>(() => {}) });
    const running = new PiLoop().run(ASK, deps(model, toolHost).deps);
    await vi.advanceTimersByTimeAsync(HARNESS_LIMITS.toolMs);
    const outcome = await running;
    expect(signals[0]!.aborted).toBe(true);
    expect(requests[1]!.messages.at(-1)).toEqual({ role: "tool", tool_call_id: "c1", content: '{"error":"provider-failure"}' });
    expect(outcome.status).toBe("verified");
  });
});

describe("PiLoop — limits (4)", () => {
  it("fails with limit when the model keeps calling one tool per step forever", async () => {
    let n = 0;
    const { model, requests } = scripted([], async () => tools(call(`c${++n}`, "sunday.open_needs")));
    const { toolHost, runs } = host(["sunday.open_needs"]);
    const outcome = await new PiLoop().run(ASK, deps(model, toolHost).deps);
    expect(outcome).toMatchObject({ status: "failed", code: "limit", answer: null });
    expect(requests).toHaveLength(HARNESS_LIMITS.modelSteps);
    expect(runs).toHaveLength(HARNESS_LIMITS.modelSteps);
    expect(types(outcome.events).at(-1)).toBe("failed limit");
  });

  it("fails with limit when one step asks for more tool calls than the task allows, running none of them", async () => {
    const many = Array.from({ length: HARNESS_LIMITS.toolCalls + 1 }, (_, i) => call(`c${i}`, "sunday.open_needs"));
    const { model } = scripted([tools(...many)]);
    const { toolHost, runs } = host(["sunday.open_needs"]);
    const outcome = await new PiLoop().run(ASK, deps(model, toolHost).deps);
    expect(outcome).toMatchObject({ status: "failed", code: "limit" });
    expect(runs).toEqual([]);
  });

  it("counts tool calls across steps, denied ones included", async () => {
    const { model, requests } = scripted([
      tools(...Array.from({ length: 6 }, (_, i) => call(`a${i}`, "sunday.open_needs"))),
      tools(...Array.from({ length: 4 }, (_, i) => call(`b${i}`, "rooms.conflicts"))),
      tools(call("c0", "sunday.open_needs")),
    ]);
    const { toolHost, runs } = host(["sunday.open_needs"]);
    const outcome = await new PiLoop().run(ASK, deps(model, toolHost).deps);
    expect(outcome).toMatchObject({ status: "failed", code: "limit" });
    expect(requests).toHaveLength(3);
    expect(runs).toHaveLength(6);
  });

  it("fails with limit before a step whose conversation exceeds contextChars", async () => {
    const chunk = ENVELOPE("sunday.overview", { rows: "x".repeat(HARNESS_LIMITS.envelopeChars - 200) });
    const { model, requests } = scripted([tools(...Array.from({ length: 8 }, (_, i) => call(`c${i}`, "sunday.overview")))]);
    const { toolHost, runs } = host(["sunday.overview"], { "sunday.overview": () => ({ ok: true, envelope: chunk }) });
    const outcome = await new PiLoop().run(ASK, deps(model, toolHost).deps);
    expect(runs).toHaveLength(8);
    expect(requests).toHaveLength(1);
    expect(outcome).toMatchObject({ status: "failed", code: "limit" });
  });

  it("fails with limit when the model's output was cut off at max_tokens", async () => {
    const { model } = scripted([{ content: "[Role 1] is", tool_calls: [], finish: "length" }]);
    const outcome = await new PiLoop().run(ASK, deps(model, host([]).toolHost).deps);
    expect(outcome).toMatchObject({ status: "failed", code: "limit", answer: null });
  });

  it("fails with timeout after runMs and aborts the model's signal", async () => {
    vi.useFakeTimers();
    const { model, signals } = scripted([() => new Promise<AgentStepReply>(() => {})]);
    const running = new PiLoop().run(ASK, deps(model, host([]).toolHost).deps);
    await vi.advanceTimersByTimeAsync(HARNESS_LIMITS.runMs);
    const outcome = await running;
    expect(outcome).toMatchObject({ status: "failed", code: "timeout", answer: null });
    expect(signals[0]!.aborted).toBe(true);
    expect(types(outcome.events).at(-1)).toBe("failed timeout");
  });
});

describe("PiLoop — final answer and verification (5)", () => {
  it("verifies the final content against the evidence and returns verify's answer", async () => {
    const { model } = scripted([tools(call("c1", "sunday.open_needs")), answer("[Role 1] is open.")]);
    const { toolHost } = host(["sunday.open_needs"]);
    const { deps: d, verifyCalls } = deps(model, toolHost, {
      verify: (text, evidence) => { verifyCalls.push({ answer: text, evidence }); return { ok: true, answer: `${text} (checked)` }; },
    });
    const outcome = await new PiLoop().run(ASK, d);
    expect(verifyCalls).toEqual([{ answer: "[Role 1] is open.", evidence: [ENVELOPE("sunday.open_needs")] }]);
    expect(outcome).toEqual({ status: "verified", code: null, answer: "[Role 1] is open. (checked)",
      evidence: [ENVELOPE("sunday.open_needs")], events: outcome.events });
    expect(types(outcome.events)).toEqual(["admitted", "running", "model step 1", "tool sunday.open_needs:complete",
      "model step 2", "verified"]);
  });

  it.each(["fidelity", "egress"] as const)("fails with verify's code %s", async code => {
    const { model } = scripted([answer("Jane Doe is open.")]);
    const outcome = await new PiLoop().run(ASK, deps(model, host([]).toolHost, { verify: () => ({ ok: false, code }) }).deps);
    expect(outcome).toMatchObject({ status: "failed", code, answer: null });
    expect(types(outcome.events).at(-1)).toBe(`failed ${code}`);
  });

  it.each(["", "   \n"])("fails with fidelity on empty final content %j without calling verify", async content => {
    const { model } = scripted([answer(content)]);
    const { deps: d, verifyCalls } = deps(model, host([]).toolHost);
    const outcome = await new PiLoop().run(ASK, d);
    expect(outcome).toMatchObject({ status: "failed", code: "fidelity", answer: null });
    expect(verifyCalls).toEqual([]);
  });

  it("fails with fidelity when verify itself throws", async () => {
    const { model } = scripted([answer("done")]);
    const outcome = await new PiLoop().run(ASK, deps(model, host([]).toolHost, { verify: () => { throw new Error("x"); } }).deps);
    expect(outcome).toMatchObject({ status: "failed", code: "fidelity" });
  });
});

describe("PiLoop — model failures (6)", () => {
  it.each([
    [{ code: "egress" }, "egress"],
    [Object.assign(new Error("refused"), { code: "no-model" }), "no-model"],
    [{ code: "limit" }, "limit"],
    [new Error("socket hang up"), "transport"],
    [{ code: "something-else" }, "transport"],
    [{ code: 7 }, "transport"],
  ] as const)("maps a thrown %o to %s", async (thrown, code) => {
    const { model } = scripted([thrown as Step]);
    const outcome = await new PiLoop().run(ASK, deps(model, host([]).toolHost).deps);
    expect(outcome).toMatchObject({ status: "failed", code, answer: null });
    expect(types(outcome.events)).toEqual(["admitted", "running", "model step 1", `failed ${code}`]);
  });

  it("fails with egress on the second step after evidence was already gathered", async () => {
    const { model } = scripted([tools(call("c1", "sunday.open_needs")), { code: "egress" }]);
    const outcome = await new PiLoop().run(ASK, deps(model, host(["sunday.open_needs"]).toolHost).deps);
    expect(outcome).toMatchObject({ status: "failed", code: "egress", answer: null });
  });

  it("treats a malformed reply as a transport failure", async () => {
    const { model } = scripted([{ content: 3, tool_calls: "x", finish: "stop" } as unknown as AgentStepReply]);
    const outcome = await new PiLoop().run(ASK, deps(model, host([]).toolHost).deps);
    expect(outcome).toMatchObject({ status: "failed", code: "transport" });
  });
});

describe("PiLoop — cancellation (7)", () => {
  it("cancels promptly mid-step, ignores the late reply and runs nothing more", async () => {
    let release: (reply: AgentStepReply) => void = () => {};
    const { model, requests, signals } = scripted([() => new Promise<AgentStepReply>(resolve => { release = resolve; })]);
    const { toolHost, runs } = host(["sunday.open_needs"]);
    const controller = new AbortController();
    const seen: TaskEvent[] = [];
    const running = new PiLoop().run(ASK, deps(model, toolHost).deps, { signal: controller.signal, onEvent: e => seen.push(e) });
    await flush();
    expect(requests).toHaveLength(1);
    controller.abort();
    const outcome = await running; // resolves without the model ever replying
    expect(outcome).toMatchObject({ status: "cancelled", code: "cancelled", answer: null, evidence: [] });
    expect(signals[0]!.aborted).toBe(true);
    release(tools(call("c1", "sunday.open_needs")));
    await flush();
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(runs).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(types(seen)).toEqual(["admitted", "running", "model step 1", "cancelled"]);
    expect(outcome.events).toEqual(seen);
  });

  it("cancels during a tool run, aborts the tool's signal and ignores its late result", async () => {
    let release: (result: ToolResult) => void = () => {};
    const { model, requests } = scripted([tools(call("c1", "sunday.open_needs"), call("c2", "sunday.open_needs")), answer("x")]);
    const { toolHost, runs, signals } = host(["sunday.open_needs"],
      { "sunday.open_needs": () => new Promise<ToolResult>(resolve => { release = resolve; }) });
    const controller = new AbortController();
    const running = new PiLoop().run(ASK, deps(model, toolHost).deps, { signal: controller.signal });
    await flush();
    expect(runs).toHaveLength(1);
    controller.abort();
    const outcome = await running;
    expect(signals[0]!.aborted).toBe(true);
    release({ ok: true, envelope: ENVELOPE("sunday.open_needs") });
    await flush();
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(outcome).toMatchObject({ status: "cancelled", evidence: [] });
    expect(runs).toHaveLength(1);
    expect(requests).toHaveLength(1);
    expect(types(outcome.events)).toEqual(["admitted", "running", "model step 1", "cancelled"]);
  });

  it("does not call the model when the signal is already aborted", async () => {
    const { model, requests } = scripted([answer("x")]);
    const controller = new AbortController(); controller.abort();
    const outcome = await new PiLoop().run(ASK, deps(model, host([]).toolHost).deps, { signal: controller.signal });
    expect(outcome).toMatchObject({ status: "cancelled", code: "cancelled" });
    expect(requests).toEqual([]);
    expect(types(outcome.events)).toEqual(["admitted", "cancelled"]);
  });

  it("stays cancelled if verify would have run after the abort", async () => {
    const controller = new AbortController();
    const { model } = scripted([async () => { controller.abort(); return answer("done"); }]);
    const { deps: d, verifyCalls } = deps(model, host([]).toolHost);
    const outcome = await new PiLoop().run(ASK, d, { signal: controller.signal });
    expect(outcome.status).toBe("cancelled");
    expect(verifyCalls).toEqual([]);
  });
});

describe("PiLoop — events (8) and task validation", () => {
  it("emits name-free events with increasing sequence through onEvent and the outcome", async () => {
    const seen: TaskEvent[] = [];
    const { model } = scripted([tools(call("c1", "sunday.open_needs"), call("c2", "rooms.conflicts")),
      tools(call("c3", "sunday.overview", "nope")), answer("[Role 1] is open.")]);
    const { toolHost } = host(["sunday.open_needs", "sunday.overview"], { "sunday.open_needs": () => ({ ok: false, error: "stale" }) });
    const outcome = await new PiLoop().run(ASK, deps(model, toolHost).deps, { onEvent: e => seen.push(e) });
    expect(outcome.events).toEqual(seen);
    expect(seen.map(e => e.sequence)).toEqual(seen.map((_, i) => i + 1));
    expect(seen.every(e => e.task_id === "task-1" && e.at === NOW)).toBe(true);
    expect(types(seen)).toEqual(["admitted", "running", "model step 1", "tool sunday.open_needs:stale",
      "tool rooms.conflicts:denied", "model step 2", "tool sunday.overview:denied", "model step 3", "verified"]);
    for (const event of seen) expect(event.detail).toMatch(VOCAB);
  });

  it("keeps running when an event observer throws", async () => {
    const { model } = scripted([answer("done")]);
    const outcome = await new PiLoop().run(ASK, deps(model, host([]).toolHost).deps, { onEvent: () => { throw new Error("ui"); } });
    expect(outcome.status).toBe("verified");
  });

  it.each([
    ["an ask without a question", { ...ASK, question: undefined }],
    ["an ask with an empty question", { ...ASK, question: "  " }],
    ["an unknown kind", { ...ASK, kind: "write" }],
  ])("rejects %s without calling the model", async (_label, task) => {
    const { model, requests } = scripted([answer("x")]);
    const outcome = await new PiLoop().run(task as AgentTask, deps(model, host([]).toolHost).deps);
    expect(outcome).toMatchObject({ status: "failed", code: "invalid-task", answer: null });
    expect(requests).toEqual([]);
    expect(types(outcome.events)).toEqual(["failed invalid-task"]);
  });

  it("is named pi", () => {
    expect(new PiLoop().name).toBe("pi");
  });
});
