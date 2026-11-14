// Browser-side half of check.mjs: runs PiLoop in a real page under the desktop app's CSP with a scripted
// ModelStep and a fake ToolHost (fictional data), and writes name-free results into #result.
import { PiLoop } from "../../../src/harness/pi-loop.js";
import type { AgentStepReply, AgentTask, ModelStep, RuntimeDeps, ToolHost, ToolSpec } from "../../../src/harness/contract.js";

const network: string[] = [];
const trapped = globalThis as unknown as Record<string, unknown>;
for (const key of ["fetch", "XMLHttpRequest", "WebSocket", "EventSource"]) {
  trapped[key] = function trap() { network.push(key); throw new Error("network attempted"); };
}
navigator.sendBeacon = () => { network.push("sendBeacon"); return false; };
const violations: string[] = [];
document.addEventListener("securitypolicyviolation", event => violations.push(`${event.effectiveDirective} ${event.blockedURI}`));

const NOW = "2026-11-15T09:00:00.000Z";
const spec = (name: string): ToolSpec => ({ name, description: `Fixed read: ${name}`,
  parameters: { type: "object", properties: {}, required: [], additionalProperties: false } });
const task: AgentTask = { id: "browser-1", kind: "ask", skill_id: "answer-from-what-was-read",
  question: "Which roles are still open for [Service 1]?", workspace_id: "ws-1", created_at: NOW };
const toolHost: ToolHost = {
  admitted: () => [spec("sunday.open_needs")],
  run: async (_task, name) => ({ ok: true, envelope: { tool: name, source: "fixture", check_time: NOW,
    completeness: "complete", payload: { open: 1, role: "[Role 1]" } } }),
};
const deps = (model: ModelStep): RuntimeDeps => ({ tools: toolHost, model, now: () => NOW,
  instructions: () => "Fixed policy.", verify: answer => ({ ok: true, answer }) });
const toolCall = (id: string, name: string): AgentStepReply =>
  ({ content: "", tool_calls: [{ id, name, arguments: "{}" }], finish: "tool_calls" });

async function main() {
  const loop = new PiLoop();
  const steps: AgentStepReply[] = [
    { content: "", tool_calls: [{ id: "c1", name: "sunday.open_needs", arguments: "{}" },
      { id: "c2", name: "shell.exec", arguments: "{}" }], finish: "tool_calls" },
    { content: "[Role 1] is open.", tool_calls: [], finish: "stop" },
  ];
  let seenTools: string[] = [];
  const verified = await loop.run(task, deps(async request => {
    seenTools = request.tools.map(t => t.name);
    return steps.shift()!;
  }));

  let n = 0;
  const limited = await loop.run(task, deps(async () => toolCall(`c${++n}`, "sunday.open_needs")));

  const controller = new AbortController();
  let modelSignal: AbortSignal | undefined;
  const cancelled = loop.run(task, deps((_request, signal) => {
    modelSignal = signal;
    queueMicrotask(() => controller.abort());
    return new Promise<AgentStepReply>(() => {});
  }), { signal: controller.signal });
  const cancelledOutcome = await cancelled;

  // The app's CSP has no 'unsafe-eval': prove it applied here, so Pi's validator ran on its no-eval path.
  let evalBlocked = false;
  try { new Function("return 1")(); } catch { evalBlocked = true; }
  await new Promise(resolve => setTimeout(resolve, 0)); // let queued violation events arrive

  return {
    evalBlocked,
    engine: navigator.userAgent.replace(/^.*?(HeadlessChrome\/[\d.]+|Chrome\/[\d.]+).*$/, "$1"),
    verified: { status: verified.status, answer: verified.answer, evidence: verified.evidence.length,
      events: verified.events.map(e => `${e.type}${e.detail ? ` ${e.detail}` : ""}`), tools: seenTools },
    limited: { status: limited.status, code: limited.code, modelSteps: n },
    cancelled: { status: cancelledOutcome.status, modelSignalAborted: modelSignal?.aborted ?? null },
    network,
    resources: performance.getEntriesByType("resource").map(entry => new URL(entry.name).pathname),
    violations,
  };
}

const out = document.getElementById("result")!;
main().then(result => { out.textContent = JSON.stringify(result); document.title = "done"; },
  (error: unknown) => { out.textContent = JSON.stringify({ error: String(error) }); document.title = "error"; });
