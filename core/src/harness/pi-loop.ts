// PiLoop: the pinned Pi agent (pi-agent-core 1.4.0) as an AgentRuntime (harness contract §3). Pi only drives
// the turn loop. Every model call goes through the injected ModelStep via a custom stream function, so Pi never
// picks a provider, reads a key or opens a connection; every tool call goes through ToolHost.run. What the model
// sees is rebuilt here from Pi's transcript on each step, so none of Pi's own error text reaches the model.
// Runs in the desktop webview bundle and under Node (no Node built-ins, no network, no eval required).
import { Agent, type AgentTool, type AgentToolResult, type StreamFn } from "@earendil-works/pi-agent-core";
import { Type, createAssistantMessageEventStream, type AssistantMessage, type ImageContent, type JsonObject,
  type Message, type Model, type TextContent, type ThinkingContent, type ToolCall } from "@earendil-works/pi-ai";
import { HARNESS_LIMITS, NATIVE_TOOL_ALLOWLIST, type AgentMessage as StepMessage, type AgentRuntime,
  type AgentStepReply, type AgentStepRequest, type AgentTask, type AgentToolCall, type Completeness,
  type FailureCode, type RunOptions, type RuntimeDeps, type TaskEvent, type TaskOutcome, type ToolEnvelope,
  type ToolError, type ToolResult } from "./contract.js";
import { contextSize } from "./limits.js";

const PROCEDURE_PROMPT = "Run this procedure now. Answer only with the JSON object.";
const DENIED_RESULT = '{"error":"denied"}';
/** Internal Pi tool that every call which must not run is routed to. Never offered to the model. */
const DENIED_TOOL = "ozzie.denied";
/** Pi validates arguments against this; the ToolHost is the real authority on arguments. */
const ANY_OBJECT = Type.Object({}, { additionalProperties: true });
/** Pi needs a model descriptor; it names no provider and is never used to reach one. */
const MODEL: Model<"ozzie-agent-step"> = { id: "agent_step", name: "agent_step", api: "ozzie-agent-step",
  provider: "ozzie", baseUrl: "", reasoning: false, input: ["text"], contextWindow: HARNESS_LIMITS.contextChars,
  maxTokens: HARNESS_LIMITS.maxTokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const ZERO_USAGE = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

const MODEL_CODES: ReadonlySet<string> = new Set(["egress", "no-model", "limit", "denied", "invalid-task", "fidelity", "invalid-arguments"]);
const TOOL_ERRORS: ReadonlySet<string> = new Set<ToolError>(["denied", "stale", "partial", "provider-failure", "unverified"]);
const COMPLETENESS: ReadonlySet<string> = new Set<Completeness>(["complete", "partial", "stale", "denied"]);
const ALLOWLIST: ReadonlySet<string> = new Set(NATIVE_TOOL_ALLOWLIST);
const FINISH: ReadonlySet<string> = new Set(["stop", "tool_calls", "length"]);

class Stop extends Error { constructor(readonly code: FailureCode) { super(code); } }

/** Fixed vocabulary for events: an allowlisted tool name or "unknown", never model-chosen text. */
const eventName = (name: string) => ALLOWLIST.has(name) ? name : "unknown";

function modelFailure(error: unknown): FailureCode {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && MODEL_CODES.has(code) ? code as FailureCode : "transport";
}

function objectArguments(raw: string): JsonObject | null {
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : null;
  } catch { return null; }
}

function readReply(value: unknown): AgentStepReply {
  const reply = value as Partial<AgentStepReply> | null;
  if (typeof reply !== "object" || reply === null || typeof reply.content !== "string" ||
    !Array.isArray(reply.tool_calls) || typeof reply.finish !== "string" || !FINISH.has(reply.finish)) throw new Stop("transport");
  for (const call of reply.tool_calls as unknown[]) {
    const c = call as Partial<AgentToolCall> | null;
    if (typeof c !== "object" || c === null || typeof c.id !== "string" || typeof c.name !== "string" ||
      typeof c.arguments !== "string") throw new Stop("transport");
  }
  return reply as AgentStepReply;
}

const textOf = (content: string | Array<TextContent | ImageContent | ThinkingContent | ToolCall>) =>
  typeof content === "string" ? content : content.flatMap(part => part.type === "text" ? [part.text] : []).join("");

/** What one tool result becomes for the model, for events, and for evidence. */
function settleTool(result: ToolResult | null): { content: string; detail: string; envelope: ToolEnvelope | null } {
  const failure = (code: string) => ({ content: JSON.stringify({ error: code }), detail: code, envelope: null });
  if (!result || typeof result !== "object") return failure("provider-failure");
  if (result.ok !== true) return failure(TOOL_ERRORS.has(result.error) ? result.error : "provider-failure");
  let serialized: string;
  try { serialized = JSON.stringify(result.envelope); } catch { return failure("unverified"); }
  if (typeof serialized !== "string" || !COMPLETENESS.has(result.envelope.completeness)) return failure("unverified");
  if (serialized.length > HARNESS_LIMITS.envelopeChars) return failure("partial");
  // Evidence is exactly what the model was sent, detached from the host's object.
  return { content: serialized, detail: result.envelope.completeness, envelope: JSON.parse(serialized) as ToolEnvelope };
}

interface CallRecord {
  /** The model's call, echoed back verbatim in later steps. */
  modelCall: AgentToolCall;
  args: JsonObject | null;
  runnable: boolean;
  /** Tool message content the model gets for this call. */
  result: string;
}

export class PiLoop implements AgentRuntime {
  readonly name = "pi" as const;

  async run(task: AgentTask, deps: RuntimeDeps, options: RunOptions = {}): Promise<TaskOutcome> {
    const events: TaskEvent[] = [];
    const evidence: ToolEnvelope[] = [];
    const state: { outcome: TaskOutcome | null } = { outcome: null };
    let sequence = 0;
    const emit = (type: TaskEvent["type"], detail = "") => {
      const event: TaskEvent = { task_id: task.id, sequence: ++sequence, at: deps.now(), type, detail };
      events.push(event);
      try { options.onEvent?.(event); } catch { /* observers are metadata-only and cannot steer the run */ }
    };

    const prompt = task.kind === "ask" ? (typeof task.question === "string" && task.question.trim() ? task.question : null)
      : task.kind === "skill" ? PROCEDURE_PROMPT : null;
    if (prompt === null) {
      emit("failed", "invalid-task");
      return { status: "failed", code: "invalid-task", answer: null, evidence: [], events };
    }

    emit("admitted");
    const controller = new AbortController();
    let agent: Agent | undefined;
    const timer: { run?: ReturnType<typeof setTimeout> } = {};
    let settle = () => {};
    const settled = new Promise<void>(resolve => { settle = resolve; });
    const onAbort = () => finish("cancelled", "cancelled");
    /** Terminal exactly once: later replies, tool results and steps are ignored. */
    const finish = (status: TaskOutcome["status"], code: FailureCode | null, answer: string | null = null) => {
      if (state.outcome) return;
      state.outcome = { status, code, answer, evidence: evidence.slice(), events };
      emit(status, status === "failed" && code ? code : "");
      clearTimeout(timer.run);
      options.signal?.removeEventListener("abort", onAbort);
      controller.abort();
      agent?.abort();
      settle();
    };
    const live = () => state.outcome === null;

    if (options.signal?.aborted) { finish("cancelled", "cancelled"); return state.outcome!; }
    options.signal?.addEventListener("abort", onAbort, { once: true });

    let system: string;
    let specs: AgentStepRequest["tools"];
    try {
      system = deps.instructions(task);
      specs = deps.tools.admitted(task);
      if (typeof system !== "string" || !Array.isArray(specs)) throw new Error("setup");
    } catch {
      finish("failed", "invalid-task");
      return state.outcome!;
    }
    const admitted = new Set(specs.map(spec => spec.name));

    emit("running");
    timer.run = setTimeout(() => finish("failed", "timeout"), HARNESS_LIMITS.runMs);

    const calls = new Map<string, CallRecord>();
    let steps = 0;
    let toolCount = 0;
    const final: { answer: string | null } = { answer: null };

    /** The model's view of the conversation, rebuilt from Pi's transcript. */
    const toStepMessages = (messages: Message[]): StepMessage[] => {
      const out: StepMessage[] = [{ role: "system", content: system }];
      for (const message of messages) {
        // Pi's system messages carry its prompt and tool bookkeeping; the system text sent is ours alone.
        if (message.role === "system") continue;
        if (message.role === "user") out.push({ role: "user", content: textOf(message.content) });
        else if (message.role === "assistant") {
          const toolCalls = message.content.flatMap(part => part.type === "toolCall" ? [calls.get(part.id)] : [])
            .map(record => { if (!record) throw new Stop("transport"); return record.modelCall; });
          out.push(toolCalls.length ? { role: "assistant", content: textOf(message.content), tool_calls: toolCalls }
            : { role: "assistant", content: textOf(message.content) });
        } else {
          const record = calls.get(message.toolCallId);
          if (!record) throw new Stop("transport");
          out.push({ role: "tool", tool_call_id: record.modelCall.id, content: record.result });
        }
      }
      return out;
    };

    const streamFn: StreamFn = (_model, context) => {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = { role: "assistant", content: [], api: MODEL.api, provider: MODEL.provider,
        model: MODEL.id, usage: ZERO_USAGE(), stopReason: "stop", timestamp: Date.now() };
      void (async () => {
        try {
          if (!live()) throw new Stop("cancelled");
          if (steps >= HARNESS_LIMITS.modelSteps) throw new Stop("limit");
          const request: AgentStepRequest = { task_id: task.id, messages: toStepMessages(context.messages),
            tools: specs, max_tokens: HARNESS_LIMITS.maxTokens };
          if (contextSize(request) > HARNESS_LIMITS.contextChars) throw new Stop("limit");
          steps++;
          emit("model", `step ${steps}`);
          let raw: unknown;
          try { raw = await deps.model(request, controller.signal); } catch (error) { throw new Stop(modelFailure(error)); }
          if (!live()) throw new Stop("cancelled"); // a late reply is ignored
          const reply = readReply(raw);
          if (reply.finish === "length") throw new Stop("limit");
          if (reply.tool_calls.length > 0) {
            // A tool name outside the allowlist is never echoed back (review N5): native would refuse the next
            // request, which would read as a name stopped at egress. Nothing in this reply runs; the task stops.
            const invented = reply.tool_calls.filter(call => !ALLOWLIST.has(call.name));
            if (invented.length) { invented.forEach(() => emit("tool", "unknown:denied")); throw new Stop("denied"); }
            if (toolCount + reply.tool_calls.length > HARNESS_LIMITS.toolCalls) throw new Stop("limit");
            toolCount += reply.tool_calls.length;
            if (reply.content) message.content.push({ type: "text", text: reply.content });
            for (const call of reply.tool_calls) {
              const id = `call-${calls.size + 1}`;
              const args = objectArguments(call.arguments);
              const runnable = admitted.has(call.name) && args !== null;
              calls.set(id, { modelCall: { id: call.id, name: call.name, arguments: call.arguments }, args, runnable,
                result: DENIED_RESULT });
              message.content.push({ type: "toolCall", id, name: runnable ? call.name : DENIED_TOOL,
                arguments: runnable && args ? args : {} });
            }
            message.stopReason = "toolUse";
          } else {
            final.answer = reply.content;
            message.content.push({ type: "text", text: reply.content });
          }
          stream.push({ type: "start", partial: message });
          stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
        } catch (error) {
          const code = error instanceof Stop ? error.code : "transport";
          if (live()) finish("failed", code);
          message.content = []; message.stopReason = "error"; message.errorMessage = code;
          stream.push({ type: "error", reason: "error", error: message });
        } finally { stream.end(message); }
      })();
      return stream;
    };

    const ignored = (): AgentToolResult<Record<string, never>> =>
      ({ content: [{ type: "text", text: DENIED_RESULT }], details: {}, terminate: true });
    const execute = async (id: string): Promise<AgentToolResult<Record<string, never>>> => {
      const record = calls.get(id);
      if (!record || !live()) return ignored();
      const name = record.modelCall.name;
      if (!record.runnable || !record.args) {
        record.result = DENIED_RESULT;
        emit("tool", `${eventName(name)}:denied`);
        return { content: [{ type: "text", text: record.result }], details: {} };
      }
      const toolController = new AbortController();
      const abortTool = () => toolController.abort();
      controller.signal.addEventListener("abort", abortTool, { once: true });
      const toolTimer = setTimeout(abortTool, HARNESS_LIMITS.toolMs);
      const stopped = new Promise<null>(resolve => toolController.signal.addEventListener("abort", () => resolve(null), { once: true }));
      let result: ToolResult | null;
      try {
        const args = record.args;
        result = await Promise.race([Promise.resolve().then(() => deps.tools.run(task, name, args, toolController.signal)), stopped]);
      } catch { result = null; }
      finally { clearTimeout(toolTimer); controller.signal.removeEventListener("abort", abortTool); }
      if (!live()) return ignored(); // a late tool result is ignored
      const settledTool = settleTool(result);
      record.result = settledTool.content;
      if (settledTool.envelope) evidence.push(settledTool.envelope);
      emit("tool", `${eventName(name)}:${settledTool.detail}`);
      return { content: [{ type: "text", text: record.result }], details: {} };
    };
    const tool = (name: string, description: string): AgentTool<typeof ANY_OBJECT, Record<string, never>> =>
      ({ name, label: name, description, parameters: ANY_OBJECT, executionMode: "sequential", replay: "never",
        execute: toolCallId => execute(toolCallId) });
    const piTools = [tool(DENIED_TOOL, "Not available."),
      ...[...admitted].filter(name => name !== DENIED_TOOL).map(name => tool(name, specs.find(s => s.name === name)?.description ?? ""))];

    try {
      agent = new Agent({
        initialState: { model: MODEL, systemPrompt: system, tools: piTools, messages: [], thinkingLevel: "off" },
        streamFn, toolExecution: "sequential", identity: { attribution: null },
        finishTurn: () => live() ? undefined : { action: "end" },
      });
      await Promise.race([agent.prompt(prompt), settled]);
    } catch {
      finish("failed", "transport");
    }

    if (live()) {
      const finalAnswer = final.answer;
      if (finalAnswer === null) finish("failed", "transport");
      else if (!finalAnswer.trim()) finish("failed", "fidelity");
      else {
        let verdict: ReturnType<RuntimeDeps["verify"]>;
        try { verdict = deps.verify(finalAnswer, evidence.slice(), task); } catch { verdict = { ok: false, code: "fidelity" }; }
        if (verdict.ok && typeof verdict.answer === "string") finish("verified", null, verdict.answer);
        else finish("failed", !verdict.ok && verdict.code === "egress" ? "egress" : "fidelity");
      }
    }
    return state.outcome!;
  }
}
