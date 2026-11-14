// TsLoop: the plain TypeScript agent loop (harness contract §3), the fallback beside PiLoop. Both
// pass the same conformance suite (core/test/harness/runtime-conformance.ts). The loop owns none of
// the safety pieces: what it may call comes from ToolHost.admitted, the model is reached only
// through the injected ModelStep (the native egress step), and the answer is accepted only by
// deps.verify. It adds hard limits, cancellation and name-free events.
//
// One task, one fresh conversation: the system message is deps.instructions(task); the user
// message is the question (ask) or "Run this procedure now. Answer only with the JSON object." (skill). Each step sends the whole
// conversation. A reply with tool calls is a tool turn: every requested call counts toward the
// tool-call limit (denied ones too) and runs one at a time in call order; a reply without tool
// calls is the final answer. A reply naming a tool outside NATIVE_TOOL_ALLOWLIST runs nothing and
// fails the task as "denied", so that name never reaches a later request.
import {
  HARNESS_LIMITS, NATIVE_TOOL_ALLOWLIST, type AgentMessage, type AgentRuntime, type AgentStepReply, type AgentStepRequest, type AgentTask,
  type AgentToolCall, type Completeness, type FailureCode, type RunOptions, type RuntimeDeps, type TaskEvent, type TaskOutcome,
  type ToolEnvelope, type ToolError, type ToolResult, type ToolSpec,
} from "./contract.js";
import { contextSize } from "./limits.js";

const PROCEDURE_PROMPT = "Run this procedure now. Answer only with the JSON object.";
const DENIED = '{"error":"denied"}';
const ALLOWLIST: ReadonlySet<string> = new Set(NATIVE_TOOL_ALLOWLIST);
const MODEL_CODES: ReadonlySet<string> = new Set(["egress", "no-model", "limit", "denied", "invalid-task", "fidelity"]);
const TOOL_ERRORS: ReadonlySet<string> = new Set<ToolError>(["denied", "stale", "partial", "provider-failure", "unverified"]);
const COMPLETENESS: ReadonlySet<string> = new Set<Completeness>(["complete", "partial", "stale", "denied"]);
const FINISH: ReadonlySet<string> = new Set(["stop", "tool_calls", "length"]);

class Stop extends Error { constructor(readonly code: FailureCode) { super(code); } }

/** Events name only allowlisted tools; anything else the model invents is "unknown". */
const eventName = (name: string) => ALLOWLIST.has(name) ? name : "unknown";

function modelFailure(error: unknown): FailureCode {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && MODEL_CODES.has(code) ? code as FailureCode : "transport";
}

function objectArguments(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

/** The reply exactly as the contract types it, or "transport". */
function readReply(value: unknown): AgentStepReply {
  const reply = value as Partial<AgentStepReply> | null;
  if (typeof reply !== "object" || reply === null || typeof reply.content !== "string" || !Array.isArray(reply.tool_calls) ||
    typeof reply.finish !== "string" || !FINISH.has(reply.finish)) throw new Stop("transport");
  for (const c of reply.tool_calls as Partial<AgentToolCall>[]) {
    if (typeof c !== "object" || c === null || typeof c.id !== "string" || typeof c.name !== "string" || typeof c.arguments !== "string") throw new Stop("transport");
  }
  return reply as AgentStepReply;
}

/** What one tool result becomes for the model, for its event, and for evidence (the parsed copy of exactly what was sent). */
function settleTool(result: ToolResult | null): { content: string; detail: string; envelope: ToolEnvelope | null } {
  const failure = (code: string) => ({ content: JSON.stringify({ error: code }), detail: code, envelope: null });
  if (!result || typeof result !== "object") return failure("provider-failure");
  if (result.ok !== true) return failure(TOOL_ERRORS.has(result.error) ? result.error : "provider-failure");
  let serialized: string;
  try { serialized = JSON.stringify(result.envelope); } catch { return failure("unverified"); }
  if (typeof serialized !== "string" || !COMPLETENESS.has(result.envelope?.completeness)) return failure("unverified");
  if (serialized.length > HARNESS_LIMITS.envelopeChars) return failure("partial");
  return { content: serialized, detail: result.envelope.completeness, envelope: JSON.parse(serialized) as ToolEnvelope };
}

export class TsLoop implements AgentRuntime {
  readonly name = "ts" as const;

  async run(task: AgentTask, deps: RuntimeDeps, options: RunOptions = {}): Promise<TaskOutcome> {
    const events: TaskEvent[] = [];
    const evidence: ToolEnvelope[] = [];
    let sequence = 0;
    let outcome: TaskOutcome | null = null;
    const emit = (type: TaskEvent["type"], detail = "") => {
      const event: TaskEvent = { task_id: task.id, sequence: ++sequence, at: deps.now(), type, detail };
      events.push(event);
      try { options.onEvent?.(event); } catch { /* observers see metadata only and can't steer the run */ }
    };

    const prompt = task.kind === "ask" ? (typeof task.question === "string" && task.question.trim() ? task.question : null)
      : task.kind === "skill" ? PROCEDURE_PROMPT : null;
    if (prompt === null) {
      emit("failed", "invalid-task");
      return { status: "failed", code: "invalid-task", answer: null, evidence: [], events };
    }

    emit("admitted");
    const controller = new AbortController();
    const timer: { run?: ReturnType<typeof setTimeout> } = {};
    let settle = () => {};
    const settled = new Promise<null>(resolve => { settle = () => resolve(null); });
    const onAbort = () => finish("cancelled", "cancelled");
    /** Terminal exactly once; later replies and tool results are ignored and emit nothing. */
    const finish = (status: TaskOutcome["status"], code: FailureCode | null, answer: string | null = null) => {
      if (outcome) return;
      outcome = { status, code, answer, evidence: evidence.slice(), events };
      emit(status, status === "failed" && code ? code : "");
      clearTimeout(timer.run);
      options.signal?.removeEventListener("abort", onAbort);
      controller.abort();
      settle();
    };
    const live = () => outcome === null;
    const done = () => outcome!;

    if (options.signal?.aborted) { finish("cancelled", "cancelled"); return done(); }
    options.signal?.addEventListener("abort", onAbort, { once: true });

    let system: string;
    let specs: ToolSpec[];
    try {
      system = deps.instructions(task);
      specs = deps.tools.admitted(task);
      if (typeof system !== "string" || !Array.isArray(specs)) throw new Error("setup");
    } catch {
      finish("failed", "invalid-task");
      return done();
    }
    const admitted = new Set(specs.map(s => s.name));

    emit("running");
    timer.run = setTimeout(() => finish("failed", "timeout"), HARNESS_LIMITS.runMs);

    const messages: AgentMessage[] = [{ role: "system", content: system }, { role: "user", content: prompt }];
    let steps = 0, toolCount = 0;
    try {
      for (;;) {
        if (!live()) return done();
        if (steps >= HARNESS_LIMITS.modelSteps) throw new Stop("limit");
        const request: AgentStepRequest = { task_id: task.id, messages: structuredClone(messages), tools: specs, max_tokens: HARNESS_LIMITS.maxTokens };
        if (contextSize(request) > HARNESS_LIMITS.contextChars) throw new Stop("limit");
        steps++;
        emit("model", `step ${steps}`);
        let raw: unknown;
        try {
          raw = await Promise.race([Promise.resolve().then(() => deps.model(request, controller.signal)), settled]);
        } catch (error) { throw new Stop(modelFailure(error)); }
        if (!live()) return done(); // a late reply is ignored
        const reply = readReply(raw);
        if (reply.finish === "length") throw new Stop("limit");

        if (reply.tool_calls.length === 0) {
          if (!reply.content.trim()) throw new Stop("fidelity");
          let verdict: ReturnType<RuntimeDeps["verify"]>;
          try { verdict = deps.verify(reply.content, evidence.slice(), task); } catch { verdict = { ok: false, code: "fidelity" }; }
          if (verdict.ok && typeof verdict.answer === "string") finish("verified", null, verdict.answer);
          else finish("failed", !verdict.ok && verdict.code === "egress" ? "egress" : "fidelity");
          return done();
        }

        // A tool name outside the allowlist is never echoed back: the next request would carry it and native
        // refuses that request, which would read as a name stopped at egress (review N5). The task stops here.
        const invented = reply.tool_calls.filter(c => !ALLOWLIST.has(c.name));
        if (invented.length) { invented.forEach(() => emit("tool", "unknown:denied")); throw new Stop("denied"); }
        if (toolCount + reply.tool_calls.length > HARNESS_LIMITS.toolCalls) throw new Stop("limit");
        toolCount += reply.tool_calls.length;
        messages.push({ role: "assistant", content: reply.content, tool_calls: reply.tool_calls.map(c => ({ id: c.id, name: c.name, arguments: c.arguments })) });
        for (const c of reply.tool_calls) {
          const args = objectArguments(c.arguments);
          if (!admitted.has(c.name) || args === null) {
            emit("tool", `${eventName(c.name)}:denied`);
            messages.push({ role: "tool", tool_call_id: c.id, content: DENIED });
            continue;
          }
          const result = await this.#runTool(task, deps, c.name, args, controller.signal);
          if (!live()) return done(); // a late tool result is ignored
          const settledTool = settleTool(result);
          if (settledTool.envelope) evidence.push(settledTool.envelope);
          emit("tool", `${eventName(c.name)}:${settledTool.detail}`);
          messages.push({ role: "tool", tool_call_id: c.id, content: settledTool.content });
        }
      }
    } catch (error) {
      if (live()) finish("failed", error instanceof Stop ? error.code : "transport");
      return done();
    }
  }

  /** One tool, bounded by toolMs and the task: a throw, a timeout or an abort resolves to null (provider-failure, or ignored once the task is over). */
  async #runTool(task: AgentTask, deps: RuntimeDeps, name: string, args: Record<string, unknown>, taskSignal: AbortSignal): Promise<ToolResult | null> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    taskSignal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, HARNESS_LIMITS.toolMs);
    const stopped = new Promise<null>(resolve => controller.signal.addEventListener("abort", () => resolve(null), { once: true }));
    try {
      return await Promise.race([Promise.resolve().then(() => deps.tools.run(task, name, args, controller.signal)), stopped]);
    } catch { return null; } finally {
      clearTimeout(timer);
      taskSignal.removeEventListener("abort", abort);
    }
  }
}
