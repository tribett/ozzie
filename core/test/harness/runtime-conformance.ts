// Shared runtime conformance (harness contract §3: the loop is replaceable). Every AgentRuntime
// (PiLoop, TsLoop) must pass this exact suite: same conversation shape, limits, failure codes,
// cancellation and name-free events. Apply it with:
//   runtimeConformance("TsLoop", () => new TsLoop());
//   runtimeConformance("PiLoop", () => new PiLoop());
// Fictional fixed data only: a scripted ModelStep and a fake ToolHost; nothing reaches a provider.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HARNESS_LIMITS, NATIVE_TOOL_ALLOWLIST, type AgentRuntime, type AgentStepReply, type AgentStepRequest, type AgentTask, type AgentToolCall,
  type ModelStep, type RuntimeDeps, type TaskEvent, type TaskOutcome, type ToolEnvelope, type ToolHost, type ToolResult, type ToolSpec,
} from "../../src/harness/contract.js";
import { contextSize } from "../../src/harness/limits.js";

const NOW = "2026-11-20T15:00:00.000Z";
const SYSTEM = "Fixed policy.\n\nProcedure: fixture";
const PROCEDURE_PROMPT = "Run this procedure now. Answer only with the JSON object.";
const ASK: AgentTask = { id: "task-ask", kind: "ask", skill_id: "answer-from-what-was-read", question: "Who could help with [Role 1]?", workspace_id: "ws", created_at: NOW };
const SKILL: AgentTask = { id: "task-skill", kind: "skill", skill_id: "who-could-help", workspace_id: "ws", created_at: NOW };
const OPEN = "sunday.open_needs", WHO = "sunday.who_could_help", OVERVIEW = "sunday.overview";

const spec = (name: string): ToolSpec => ({ name, description: `Fixed read: ${name}`, parameters: { type: "object", properties: {}, required: [], additionalProperties: false } });
const envelope = (tool: string, payload: unknown = { role: "[Role 1]", remaining: 1 }): ToolEnvelope =>
  ({ tool, source: "Planning Center Services", check_time: NOW, completeness: "complete", payload });
const call = (id: string, name: string, args: unknown = {}): AgentToolCall => ({ id, name, arguments: typeof args === "string" ? args : JSON.stringify(args) });
const toolTurn = (...calls: AgentToolCall[]): AgentStepReply => ({ content: "", tool_calls: calls, finish: "tool_calls" });
const final = (content: string): AgentStepReply => ({ content, tool_calls: [], finish: "stop" });
const deferred = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 30; i++) await new Promise<void>(r => queueMicrotask(r)); };

type Step = AgentStepReply | unknown | ((request: AgentStepRequest, signal: AbortSignal) => Promise<unknown>);
/** A scripted model: replies in order; an Error or {code} is thrown; a function is called. */
function scripted(steps: Step[], fallback?: Step) {
  const requests: AgentStepRequest[] = [], signals: AbortSignal[] = [];
  const model: ModelStep = async (request, signal) => {
    requests.push(structuredClone(request)); signals.push(signal);
    const step = requests.length <= steps.length ? steps[requests.length - 1] : fallback;
    if (step === undefined) throw new Error("script exhausted");
    if (typeof step === "function") return (step as (r: AgentStepRequest, s: AbortSignal) => Promise<AgentStepReply>)(request, signal);
    if (step instanceof Error || (typeof step === "object" && step !== null && "code" in step && !("finish" in step))) throw step;
    return structuredClone(step) as AgentStepReply;
  };
  return { model, requests, signals };
}

type Handler = (args: Record<string, unknown>, signal: AbortSignal) => Promise<ToolResult> | ToolResult;
function host(admitted: string[], handlers: Record<string, Handler> = {}) {
  const runs: { name: string; args: Record<string, unknown> }[] = [], signals: AbortSignal[] = [];
  const tools: ToolHost = {
    admitted: () => admitted.map(spec),
    run: async (_task, name, args, signal) => {
      runs.push({ name, args: structuredClone(args) }); signals.push(signal);
      const h = handlers[name];
      return h ? h(args, signal) : { ok: true, envelope: envelope(name) };
    },
  };
  return { tools, runs, signals };
}

function deps(model: ModelStep, tools: ToolHost, over: Partial<RuntimeDeps> = {}) {
  const verified: { answer: string; evidence: ToolEnvelope[]; task: AgentTask }[] = [];
  const value: RuntimeDeps = {
    tools, model, instructions: () => SYSTEM, now: () => NOW,
    verify: (answer, evidence, task) => { verified.push({ answer, evidence: structuredClone(evidence), task }); return { ok: true, answer }; },
    ...over,
  };
  return { deps: value, verified };
}

const shape = (events: TaskEvent[]) => events.map(e => `${e.type}${e.detail ? ` ${e.detail}` : ""}`);
const VOCAB = new RegExp(`^(|step [1-9]|(?:${[...NATIVE_TOOL_ALLOWLIST, "unknown"].map(n => n.replace(".", "\\.")).join("|")}):(?:complete|partial|stale|denied|provider-failure|unverified)|invalid-task|limit|timeout|egress|fidelity|transport|no-model|stale|partial|provider-failure|unverified|denied)$`);
const failedWith = (outcome: TaskOutcome, code: string) => {
  expect(outcome.status).toBe("failed");
  expect(outcome.code).toBe(code);
  expect(outcome.answer).toBeNull();
  expect(outcome.events.at(-1)).toMatchObject({ type: "failed", detail: code });
};

export function runtimeConformance(label: string, make: () => AgentRuntime): void {
  describe(`${label} runtime conformance`, () => {
    afterEach(() => { vi.useRealTimers(); });

    describe("1. conversation", () => {
      it("sends the instructions as the one system message, the question as the user message, the admitted specs and max_tokens", async () => {
        const m = scripted([final("[Role 1] is open.")]);
        const h = host([OPEN, WHO]);
        await make().run(ASK, deps(m.model, h.tools).deps);
        expect(m.requests[0]).toEqual({ task_id: ASK.id, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: ASK.question }],
          tools: [spec(OPEN), spec(WHO)], max_tokens: HARNESS_LIMITS.maxTokens });
      });

      it("uses the fixed procedure prompt for a skill task", async () => {
        const m = scripted([final("Done reading.")]);
        await make().run(SKILL, deps(m.model, host([OPEN]).tools).deps);
        expect(m.requests[0]!.messages).toEqual([{ role: "system", content: SYSTEM }, { role: "user", content: PROCEDURE_PROMPT }]);
      });

      it("starts a fresh conversation for every task and keeps exactly one system message on every step", async () => {
        const runtime = make();
        const first = scripted([toolTurn(call("c1", OPEN)), final("One.")]);
        await runtime.run(SKILL, deps(first.model, host([OPEN]).tools).deps);
        for (const r of first.requests) expect(r.messages.filter(x => x.role === "system")).toEqual([{ role: "system", content: SYSTEM }]);
        expect(first.requests[1]!.messages[0]).toEqual({ role: "system", content: SYSTEM });
        const second = scripted([final("Two.")]);
        await runtime.run(ASK, deps(second.model, host([OPEN]).tools).deps);
        expect(second.requests[0]!.messages).toHaveLength(2);
      });
    });

    describe("2–3, 9. tool calls", () => {
      it("echoes the model's call verbatim, runs it with parsed arguments, and returns the envelope JSON as the tool message", async () => {
        const m = scripted([toolTurn(call("call-a", WHO, { role: "[Role 1]" })), final("[Role 1] has one opening.")]);
        const h = host([WHO]);
        const out = await make().run(ASK, deps(m.model, h.tools).deps);
        expect(h.runs).toEqual([{ name: WHO, args: { role: "[Role 1]" } }]);
        expect(m.requests[1]!.messages.slice(2)).toEqual([
          { role: "assistant", content: "", tool_calls: [{ id: "call-a", name: WHO, arguments: '{"role":"[Role 1]"}' }] },
          { role: "tool", tool_call_id: "call-a", content: JSON.stringify(envelope(WHO)) },
        ]);
        expect(out.evidence).toEqual([envelope(WHO)]);
      });

      it("never runs an allowlisted name that isn't admitted and tells the model it was denied", async () => {
        const m = scripted([toolTurn(call("c1", "rooms.conflicts"), call("c2", "groups.clashes"), call("c3", "planning_center.refresh")), final("Nothing to add.")]);
        const h = host([OPEN]);
        const out = await make().run(SKILL, deps(m.model, h.tools).deps);
        expect(h.runs).toEqual([]);
        expect(m.requests[1]!.messages.filter(x => x.role === "tool").map(x => "content" in x ? x.content : "")).toEqual(Array(3).fill('{"error":"denied"}'));
        expect(shape(out.events).filter(e => e.startsWith("tool"))).toEqual(["tool rooms.conflicts:denied", "tool groups.clashes:denied", "tool planning_center.refresh:denied"]);
        expect(out.status).toBe("verified");
      });

      it("stops at a tool name outside the allowlist: runs nothing in that reply, sends no later request, and never names it (review N5)", async () => {
        // Echoing it back would put the invented name in the next request, which native refuses as if a name had leaked.
        const m = scripted([toolTurn(call("c1", OPEN), call("c2", "riley.thornbury"), call("c3", "email.send")), final("never")]);
        const h = host([OPEN]);
        const out = await make().run(SKILL, deps(m.model, h.tools).deps);
        failedWith(out, "denied");
        expect(h.runs).toEqual([]);
        expect(m.requests).toHaveLength(1);
        expect(shape(out.events)).toEqual(["admitted", "running", "model step 1", "tool unknown:denied", "tool unknown:denied", "failed denied"]);
        expect(JSON.stringify(out)).not.toMatch(/riley|email/u);
      });

      it("denies arguments that aren't a JSON object", async () => {
        const m = scripted([toolTurn(call("c1", OPEN, "[1]"), call("c2", OPEN, "not json"), call("c3", OPEN, "null"), call("c4", OPEN, '"x"')), final("Nothing.")]);
        const h = host([OPEN]);
        const out = await make().run(SKILL, deps(m.model, h.tools).deps);
        expect(h.runs).toEqual([]);
        expect(shape(out.events).filter(e => e.startsWith("tool"))).toEqual(Array(4).fill(`tool ${OPEN}:denied`));
      });

      it("runs one step's calls one at a time, in call order, and keeps evidence in that order", async () => {
        const gate = deferred<ToolResult>();
        let secondStarted = false;
        const m = scripted([toolTurn(call("c1", OPEN), call("c2", OVERVIEW)), final("Both read.")]);
        const h = host([OPEN, OVERVIEW], { [OPEN]: () => gate.promise, [OVERVIEW]: () => { secondStarted = true; return { ok: true, envelope: envelope(OVERVIEW) }; } });
        const pending = make().run(SKILL, deps(m.model, h.tools).deps);
        await flush();
        expect(secondStarted).toBe(false);
        gate.resolve({ ok: true, envelope: envelope(OPEN) });
        const out = await pending;
        expect(h.runs.map(r => r.name)).toEqual([OPEN, OVERVIEW]);
        expect(out.evidence.map(e => e.tool)).toEqual([OPEN, OVERVIEW]);
      });

      it("sends a tool error as {error: code}, keeps it out of evidence, and treats unknown codes as provider-failure", async () => {
        const m = scripted([toolTurn(call("c1", OPEN), call("c2", OVERVIEW)), final("Couldn't read it.")]);
        const h = host([OPEN, OVERVIEW], { [OPEN]: () => ({ ok: false, error: "stale" }), [OVERVIEW]: () => ({ ok: false, error: "boom" } as unknown as ToolResult) });
        const out = await make().run(SKILL, deps(m.model, h.tools).deps);
        expect(m.requests[1]!.messages.filter(x => x.role === "tool").map(x => "content" in x ? x.content : "")).toEqual(['{"error":"stale"}', '{"error":"provider-failure"}']);
        expect(shape(out.events).filter(e => e.startsWith("tool"))).toEqual([`tool ${OPEN}:stale`, `tool ${OVERVIEW}:provider-failure`]);
        expect(out.evidence).toEqual([]);
      });

      it("treats a throwing or rejecting tool host as provider-failure and keeps going", async () => {
        const m = scripted([toolTurn(call("c1", OPEN), call("c2", OVERVIEW)), final("Still answering.")]);
        const h = host([OPEN, OVERVIEW]);
        const tools: ToolHost = { admitted: h.tools.admitted, run: (t, name) => name === OPEN ? (() => { throw new Error("sync"); })() : Promise.reject(new Error("async")) };
        const out = await make().run(SKILL, deps(m.model, tools).deps);
        expect(shape(out.events).filter(e => e.startsWith("tool"))).toEqual([`tool ${OPEN}:provider-failure`, `tool ${OVERVIEW}:provider-failure`]);
        expect(out.status).toBe("verified");
      });

      it("gives up on a tool after toolMs, aborts its signal, and keeps going", async () => {
        vi.useFakeTimers();
        const m = scripted([toolTurn(call("c1", OPEN)), final("It took too long.")]);
        const h = host([OPEN], { [OPEN]: () => new Promise<ToolResult>(() => {}) });
        const pending = make().run(SKILL, deps(m.model, h.tools).deps);
        await vi.advanceTimersByTimeAsync(HARNESS_LIMITS.toolMs);
        const out = await pending;
        expect(h.signals[0]!.aborted).toBe(true);
        expect(m.requests[1]!.messages.at(-1)).toEqual({ role: "tool", tool_call_id: "c1", content: '{"error":"provider-failure"}' });
        expect(out.status).toBe("verified");
      });

      it("treats an envelope that can't be serialized or has an unknown completeness as unverified", async () => {
        const m = scripted([toolTurn(call("c1", OPEN), call("c2", OVERVIEW)), final("Unclear.")]);
        const h = host([OPEN, OVERVIEW], {
          [OPEN]: () => ({ ok: true, envelope: { ...envelope(OPEN), payload: { n: 1n } } }),
          [OVERVIEW]: () => ({ ok: true, envelope: { ...envelope(OVERVIEW), completeness: "mostly" } as unknown as ToolEnvelope }),
        });
        const out = await make().run(SKILL, deps(m.model, h.tools).deps);
        expect(shape(out.events).filter(e => e.startsWith("tool"))).toEqual([`tool ${OPEN}:unverified`, `tool ${OVERVIEW}:unverified`]);
        expect(out.evidence).toEqual([]);
      });

      it("replaces an oversized envelope with {error: partial}, keeps one exactly at the limit, and evidence is the parsed copy of what was sent", async () => {
        const sized = (n: number) => { const base = JSON.stringify(envelope(OPEN, { text: "" })).length; return envelope(OPEN, { text: "a".repeat(n - base) }); };
        const exact = sized(HARNESS_LIMITS.envelopeChars), over = sized(HARNESS_LIMITS.envelopeChars + 1);
        expect(JSON.stringify(exact).length).toBe(HARNESS_LIMITS.envelopeChars);
        const m = scripted([toolTurn(call("c1", OPEN), call("c2", OPEN)), final("Read.")]);
        let n = 0;
        const h = host([OPEN], { [OPEN]: () => ({ ok: true, envelope: n++ === 0 ? over : exact }) });
        const out = await make().run(SKILL, deps(m.model, h.tools).deps);
        expect(m.requests[1]!.messages.filter(x => x.role === "tool").map(x => "content" in x ? x.content : "")).toEqual(['{"error":"partial"}', JSON.stringify(exact)]);
        expect(shape(out.events).filter(e => e.startsWith("tool"))).toEqual([`tool ${OPEN}:partial`, `tool ${OPEN}:complete`]);
        expect(out.evidence).toEqual([exact]);
        expect(out.evidence[0]).not.toBe(exact);
      });
    });

    describe("4. limits", () => {
      it("fails with limit when the model wants a seventh step", async () => {
        const m = scripted([], toolTurn(call("c", OPEN)));
        const out = await make().run(SKILL, deps(m.model, host([OPEN]).tools).deps);
        failedWith(out, "limit");
        expect(m.requests).toHaveLength(HARNESS_LIMITS.modelSteps);
        expect(shape(out.events).filter(e => e.startsWith("model"))).toHaveLength(HARNESS_LIMITS.modelSteps);
      });

      it("fails with limit when one reply asks for more tool calls than the task allows, running none of them", async () => {
        const calls = Array.from({ length: HARNESS_LIMITS.toolCalls + 1 }, (_, i) => call(`c${i}`, OPEN));
        const m = scripted([toolTurn(...calls)]);
        const h = host([OPEN]);
        failedWith(await make().run(SKILL, deps(m.model, h.tools).deps), "limit");
        expect(h.runs).toEqual([]);
      });

      it("counts tool calls across steps, denied ones included", async () => {
        const m = scripted([toolTurn(call("a", OPEN), call("b", OPEN), call("c", OPEN), call("d", "groups.clashes"), call("e", OPEN, "[]"), call("f", "rooms.conflicts")),
          toolTurn(...Array.from({ length: 5 }, (_, i) => call(`g${i}`, OPEN)))]);
        const h = host([OPEN]);
        failedWith(await make().run(SKILL, deps(m.model, h.tools).deps), "limit");
        expect(h.runs).toHaveLength(3);
      });

      it("allows exactly the tool call limit", async () => {
        const m = scripted([toolTurn(...Array.from({ length: HARNESS_LIMITS.toolCalls }, (_, i) => call(`c${i}`, OPEN))), final("Read all of it.")]);
        const h = host([OPEN]);
        expect((await make().run(SKILL, deps(m.model, h.tools).deps)).status).toBe("verified");
        expect(h.runs).toHaveLength(HARNESS_LIMITS.toolCalls);
      });

      it("fails with limit before a step whose messages exceed contextChars", async () => {
        const big = envelope(OPEN, { text: "a".repeat(HARNESS_LIMITS.envelopeChars - 200) });
        const m = scripted([toolTurn(...Array.from({ length: 7 }, (_, i) => call(`c${i}`, OPEN)))]);
        const out = await make().run(SKILL, deps(m.model, host([OPEN], { [OPEN]: () => ({ ok: true, envelope: big }) }).tools).deps);
        failedWith(out, "limit");
        expect(m.requests).toHaveLength(1);
      });

      it("counts the tool specs in the context size, in characters, as native agent_step does (review C7)", async () => {
        // One character per code point, as Rust's chars().count(): an astral emoji is one, not two.
        expect(contextSize({ messages: [{ role: "user", content: "\u{1F600}" }], tools: [] })).toBe(JSON.stringify([{ role: "user", content: "\u{1F600}" }]).length - 1 + "[]".length);
        // Seven results whose messages alone fit the ceiling, but not with the three specs offered beside them.
        const offered = [OPEN, WHO, OVERVIEW];
        const calls = Array.from({ length: 7 }, (_, i) => call(`c${i}`, OPEN));
        const messagesFor = (n: number) => [{ role: "system", content: SYSTEM }, { role: "user", content: PROCEDURE_PROMPT },
          { role: "assistant", content: "", tool_calls: calls },
          ...calls.map(c => ({ role: "tool", tool_call_id: c.id, content: JSON.stringify(envelope(OPEN, { text: "é".repeat(n) })) }))] as AgentStepRequest["messages"];
        const n = Math.floor((HARNESS_LIMITS.contextChars - contextSize({ messages: messagesFor(0), tools: [] })) / calls.length);
        expect(contextSize({ messages: messagesFor(n), tools: [] })).toBeLessThanOrEqual(HARNESS_LIMITS.contextChars);
        expect(contextSize({ messages: messagesFor(n), tools: offered.map(spec) })).toBeGreaterThan(HARNESS_LIMITS.contextChars);
        const m = scripted([toolTurn(...calls), final("never sent")]);
        const out = await make().run(SKILL, deps(m.model, host(offered, { [OPEN]: () => ({ ok: true, envelope: envelope(OPEN, { text: "é".repeat(n) }) }) }).tools).deps);
        failedWith(out, "limit");
        expect(m.requests).toHaveLength(1);
      });

      it("fails with limit when the reply was cut off at max_tokens, running none of its calls", async () => {
        failedWith(await make().run(SKILL, deps(scripted([{ content: "[Role 1] is", tool_calls: [], finish: "length" }]).model, host([OPEN]).tools).deps), "limit");
        const h = host([OPEN]);
        failedWith(await make().run(SKILL, deps(scripted([{ content: "", tool_calls: [call("c", OPEN)], finish: "length" }]).model, h.tools).deps), "limit");
        expect(h.runs).toEqual([]);
      });

      it("fails with timeout after runMs and aborts the model's signal", async () => {
        vi.useFakeTimers();
        const m = scripted([() => new Promise(() => {})]);
        const pending = make().run(SKILL, deps(m.model, host([OPEN]).tools).deps);
        await vi.advanceTimersByTimeAsync(HARNESS_LIMITS.runMs);
        failedWith(await pending, "timeout");
        expect(m.signals[0]!.aborted).toBe(true);
      });
    });

    describe("5. the final answer", () => {
      it("is verified against the evidence and verify's answer is returned", async () => {
        const m = scripted([toolTurn(call("c1", OPEN)), final("[Role 1] needs one more.")]);
        const d = deps(m.model, host([OPEN]).tools, { verify: () => ({ ok: true, answer: "VERIFIED" }) });
        const out = await make().run(ASK, d.deps);
        expect(out).toMatchObject({ status: "verified", code: null, answer: "VERIFIED", evidence: [envelope(OPEN)] });
        const seen = deps(scripted([toolTurn(call("c1", OPEN)), final("[Role 1] needs one more.")]).model, host([OPEN]).tools);
        await make().run(ASK, seen.deps);
        expect(seen.verified).toEqual([{ answer: "[Role 1] needs one more.", evidence: [envelope(OPEN)], task: ASK }]);
      });

      it("treats a reply with no tool calls as final, whatever its finish says", async () => {
        const out = await make().run(SKILL, deps(scripted([{ content: "All read.", tool_calls: [], finish: "tool_calls" }]).model, host([OPEN]).tools).deps);
        expect(out).toMatchObject({ status: "verified", answer: "All read." });
      });

      it("fails an empty or blank answer with fidelity without calling verify", async () => {
        for (const content of ["", "   \n "]) {
          const d = deps(scripted([final(content)]).model, host([OPEN]).tools);
          failedWith(await make().run(SKILL, d.deps), "fidelity");
          expect(d.verified).toEqual([]);
        }
      });

      it("fails with verify's code: egress stays egress, anything else is fidelity, and a throwing verify is fidelity", async () => {
        const cases: [RuntimeDeps["verify"], string][] = [
          [() => ({ ok: false, code: "egress" }), "egress"], [() => ({ ok: false, code: "fidelity" }), "fidelity"],
          [() => ({ ok: false, code: "limit" } as unknown as ReturnType<RuntimeDeps["verify"]>), "fidelity"], [() => { throw new Error("x"); }, "fidelity"],
        ];
        for (const [verify, code] of cases) failedWith(await make().run(SKILL, deps(scripted([final("Answer.")]).model, host([OPEN]).tools, { verify }).deps), code);
      });
    });

    describe("6. model failures", () => {
      it("keeps egress, no-model, limit, denied, invalid-task and fidelity codes from the model step and calls anything else transport (review C9; a reply native drops as not the answer form is fidelity)", async () => {
        const cases: [unknown, string][] = [[{ code: "egress" }, "egress"], [{ code: "no-model" }, "no-model"], [{ code: "limit" }, "limit"], [{ code: "denied" }, "denied"], [{ code: "invalid-task" }, "invalid-task"],
          [new Error("network"), "transport"], [{ code: "boom" }, "transport"], [Object.assign(new Error("x"), { code: "fidelity" }), "fidelity"]];
        for (const [thrown, code] of cases) {
          const model: ModelStep = () => Promise.reject(thrown);
          failedWith(await make().run(SKILL, deps(model, host([OPEN]).tools).deps), code);
        }
      });

      it("treats a malformed reply as transport", async () => {
        for (const reply of [null, "text", { content: 1, tool_calls: [], finish: "stop" }, { content: "x", tool_calls: "none", finish: "stop" },
          { content: "x", tool_calls: [], finish: "done" }, { content: "", tool_calls: [{ id: "c", name: OPEN }], finish: "tool_calls" }]) {
          const model: ModelStep = async () => reply as AgentStepReply;
          failedWith(await make().run(SKILL, deps(model, host([OPEN]).tools).deps), "transport");
        }
      });
    });

    describe("7. cancellation", () => {
      it("never calls the model when the signal is already aborted", async () => {
        const m = scripted([final("x")]);
        const controller = new AbortController();
        controller.abort();
        const out = await make().run(SKILL, deps(m.model, host([OPEN]).tools).deps, { signal: controller.signal });
        expect(out).toMatchObject({ status: "cancelled", code: "cancelled", answer: null });
        expect(shape(out.events)).toEqual(["admitted", "cancelled"]);
        expect(m.requests).toEqual([]);
      });

      it("returns at once when cancelled mid-step, aborts the model's signal, and ignores the late reply", async () => {
        const reply = deferred<AgentStepReply>();
        const m = scripted([() => reply.promise]);
        const h = host([OPEN]);
        const seen: TaskEvent[] = [];
        const controller = new AbortController();
        const pending = make().run(SKILL, deps(m.model, h.tools).deps, { signal: controller.signal, onEvent: e => seen.push(e) });
        await flush();
        controller.abort();
        const out = await pending;
        expect(out).toMatchObject({ status: "cancelled", code: "cancelled", answer: null });
        expect(m.signals[0]!.aborted).toBe(true);
        const count = seen.length;
        reply.resolve(toolTurn(call("late", OPEN)));
        await flush();
        expect(h.runs).toEqual([]);
        expect(seen).toHaveLength(count);
        expect(shape(out.events)).toEqual(["admitted", "running", "model step 1", "cancelled"]);
      });

      it("returns at once when cancelled during a tool, aborts the tool's signal, and ignores its late result", async () => {
        const result = deferred<ToolResult>();
        const m = scripted([toolTurn(call("c1", OPEN)), final("never")]);
        const h = host([OPEN], { [OPEN]: () => result.promise });
        const seen: TaskEvent[] = [];
        const controller = new AbortController();
        const pending = make().run(SKILL, deps(m.model, h.tools).deps, { signal: controller.signal, onEvent: e => seen.push(e) });
        await flush();
        expect(h.runs).toHaveLength(1);
        controller.abort();
        const out = await pending;
        expect(out).toMatchObject({ status: "cancelled", code: "cancelled", evidence: [] });
        expect(h.signals[0]!.aborted).toBe(true);
        const count = seen.length;
        result.resolve({ ok: true, envelope: envelope(OPEN) });
        await flush();
        expect(seen).toHaveLength(count);
        expect(m.requests).toHaveLength(1);
        expect(out.events.at(-1)).toMatchObject({ type: "cancelled", detail: "" });
      });
    });

    describe("invalid tasks", () => {
      it("fail as invalid-task with a single failed event and no model call when the task can't run", async () => {
        const noQuestion: AgentTask = { id: ASK.id, kind: "ask", skill_id: ASK.skill_id, workspace_id: ASK.workspace_id, created_at: ASK.created_at };
        for (const task of [noQuestion, { ...ASK, question: "   " }, { ...SKILL, kind: "chat" } as unknown as AgentTask]) {
          const m = scripted([final("x")]);
          const out = await make().run(task, deps(m.model, host([OPEN]).tools).deps);
          failedWith(out, "invalid-task");
          expect(shape(out.events)).toEqual(["failed invalid-task"]);
          expect(m.requests).toEqual([]);
        }
      });

      it("fail as invalid-task after admitted when the instructions or admitted tools can't be built", async () => {
        const broken: ToolHost = { admitted: () => { throw new Error("no skill"); }, run: async () => ({ ok: false, error: "denied" }) };
        for (const d of [deps(scripted([]).model, host([OPEN]).tools, { instructions: () => { throw new Error("no procedure"); } }).deps, deps(scripted([]).model, broken).deps]) {
          const out = await make().run(SKILL, d);
          failedWith(out, "invalid-task");
          expect(shape(out.events)).toEqual(["admitted", "failed invalid-task"]);
        }
      });
    });

    describe("8. events", () => {
      it("are name-free, in increasing sequence, the same through onEvent and the outcome, with one terminal event last", async () => {
        const seen: TaskEvent[] = [];
        const m = scripted([toolTurn(call("c1", WHO, { role: "[Role 1]" }), call("c2", "rooms.conflicts")), final("[Role 1] has no overlap found for [Person 1].")]);
        const out = await make().run(ASK, deps(m.model, host([WHO]).tools).deps, { onEvent: e => seen.push(e) });
        expect(shape(out.events)).toEqual(["admitted", "running", "model step 1", `tool ${WHO}:complete`, "tool rooms.conflicts:denied", "model step 2", "verified"]);
        expect(seen).toEqual(out.events);
        out.events.forEach((e, i) => expect(e).toEqual({ task_id: ASK.id, sequence: i + 1, at: NOW, type: e.type, detail: e.detail }));
        for (const e of out.events) expect(e.detail, e.detail).toMatch(VOCAB);
        expect(out.events.filter(e => ["verified", "failed", "cancelled"].includes(e.type))).toHaveLength(1);
      });

      it("keep running when an event observer throws", async () => {
        const out = await make().run(SKILL, deps(scripted([final("Fine.")]).model, host([OPEN]).tools).deps, { onEvent: () => { throw new Error("observer"); } });
        expect(out.status).toBe("verified");
      });

      it("give the failure code as the terminal detail and nothing for verified or cancelled", async () => {
        failedWith(await make().run(SKILL, deps(scripted([new Error("x")]).model, host([OPEN]).tools).deps), "transport");
        const ok = await make().run(SKILL, deps(scripted([final("Fine.")]).model, host([OPEN]).tools).deps);
        expect(ok.events.at(-1)).toMatchObject({ type: "verified", detail: "" });
      });
    });
  });
}
