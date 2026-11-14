// Shared fakes for the desktop harness tests: scripted models, a recording fake of the native
// ledger, and the fictional example as HarnessData. Fictional fixed data only; nothing native runs.
import type { AgentStepReply, AgentStepRequest, ModelStep } from "../../../core/src/harness/contract.js";
import { withFictionalOperations } from "../../../core/src/fictional-operations.js";
import { nov22Capture } from "../../../core/src/fictional-sunday.js";
import { buildHarnessData, StepFailure, type Invoke } from "../src/harness-bridge.js";
import type { TaskRow } from "../src/harness-words.js";

export const RULES = { sundayLeads: [], checkInAfterSundaysInARow: 3 };
export const fictionalData = () => buildHarnessData({
  capture: withFictionalOperations(nov22Capture()), fictional: true, rules: RULES, decisions: [], status: null, configured: false, now: "2026-11-20T15:05:00Z",
});

export type Turn = (request: AgentStepRequest) => AgentStepReply | Error | string;
export const answer = (content: string): AgentStepReply => ({ content, tool_calls: [], finish: "stop" });
export const calls = (...list: [string, Record<string, unknown>?][]): AgentStepReply =>
  ({ content: "", tool_calls: list.map(([name, args], i) => ({ id: `call_${i}`, name, arguments: JSON.stringify(args ?? {}) })), finish: "tool_calls" });
/** The newest result of one tool the model has seen. */
export const payloadOf = (r: AgentStepRequest, tool: string) => r.messages.flatMap(m => m.role === "tool" ? [JSON.parse(m.content) as { tool?: string; payload?: Record<string, unknown> }] : [])
  .filter(x => x.tool === tool).at(-1)?.payload;
/** Each step answers from the conversation so far; every request is kept exactly as sent. */
export function scripted(turns: Turn[]) {
  const requests: AgentStepRequest[] = [];
  const model: ModelStep = async request => {
    requests.push(structuredClone(request));
    const turn = turns[requests.length - 1];
    if (!turn) throw new StepFailure("transport");
    const reply = turn(request);
    if (reply instanceof Error || typeof reply === "string") throw reply;
    return reply;
  };
  return { model, requests };
}
type Person = { fact: string; person: string; status: string };
/** A final answer in the closed form (structured answers): the facts chosen, and a draft id for a draft. */
export const facts = (ids: string[], kind = "facts", draft?: string) => answer(JSON.stringify({ answer: kind, facts: ids, ...(draft ? { draft } : {}) }));
/** Who could cover Greeter: the who-could-help read, then the fact of the person with no overlap found. */
export const greeterTurns: Turn[] = [
  r => calls(["sunday.who_could_help", { role: r.messages[1]!.content.match(/\[Role \d+\]/u)![0] }]),
  r => {
    const p = payloadOf(r, "sunday.who_could_help") as { people: Person[] };
    return facts([p.people.find(x => x.status === "no overlap found")!.fact]);
  },
];
/** The same, then a draft note to that person, and the draft as the answer. */
export const draftTurns: Turn[] = [
  greeterTurns[0]!,
  r => { const p = payloadOf(r, "sunday.who_could_help") as { asked_for: { role: string }; people: Person[] }; return calls(["drafts.prepare_note", { person: p.people.find(x => x.status === "no overlap found")!.person, role: p.asked_for.role }]); },
  r => {
    const p = payloadOf(r, "sunday.who_could_help") as { people: Person[] };
    return facts([p.people.find(x => x.status === "no overlap found")!.fact], "draft", (payloadOf(r, "drafts.prepare_note") as { draft_id: string }).draft_id);
  },
];

/** The native side, faked: every call recorded; each command answers as `respond` says. */
export function fakeNative(respond: (command: string, args: Record<string, unknown>) => unknown = () => ({})) {
  const log: [string, Record<string, unknown>][] = [];
  const invoke: Invoke = async <T,>(command: string, args: Record<string, unknown> = {}) => { log.push([command, args]); return await respond(command, args) as T; };
  return { invoke, log };
}
export const taskIds = () => { let n = 0; return () => `00000000-0000-4000-8000-${(++n).toString(16).padStart(12, "0")}`; };

/** A ledger row as native lists it. */
export const row = (over: Partial<TaskRow> & Pick<TaskRow, "kind" | "state">): TaskRow => ({
  task_id: "00000000-0000-4000-8000-000000000001", skill_id: over.kind === "ask" ? "answer-from-what-was-read" : "sunday-ready", skill_hash: "a".repeat(64),
  created_at: "2026-11-20T21:42:00Z", updated_at: "2026-11-20T21:42:09Z", failure: null, events: [], ...over,
});
/** Plain text of rendered markup. */
export const text = (html: string) => html.replace(/<[^>]+>/g, " ").replaceAll("&#x27;", "'").replaceAll("&quot;", "\"").replaceAll("&amp;", "&").replace(/\s+/g, " ");
/** Words the product never shows people (AGENTS.md product language rules). */
export const HIDDEN_WORDS = /\b(?:skills?|agents?|agentic|harness(?:es)?|sessions?|logs?|logging|connectors?)\b/iu;
