// Ozzie harness contract (frozen 2026-11-13 before any implementation).
// Build contract §2–4: the agent loop is replaceable and owns none of the safety pieces. Tools are typed,
// read-only and fixed; their payloads are placeholder-only; the model is reached only through the native
// egress step (name guard, zero data retention, call cap). Change this file only with a recorded decision.
import type { Completeness, ToolError } from "../broker.js";
import type { RunState } from "../ledger.js";

export type { Completeness, ToolError, RunState };

/** Hard ceilings for one agent task, enforced by the runtime and again natively where noted. */
export const HARNESS_LIMITS = Object.freeze({
  /** Model calls per task (native also caps per-task and per-day). */
  modelSteps: 6,
  /** Tool calls per task, across all steps. */
  toolCalls: 10,
  /** Wall clock for one task. */
  runMs: 90_000,
  /** One tool's wall clock (a Planning Center refresh may take a few seconds). */
  toolMs: 20_000,
  /** Output tokens per model step. */
  maxTokens: 700,
  /** Serialized size of one tool envelope sent to the model. */
  envelopeChars: 6_000,
  /** Serialized size of the whole conversation sent in one step. */
  contextChars: 40_000,
});

// ---------------------------------------------------------------------------------------------
// Tools (build contract §4: one tool contract)

/** JSON Schema subset accepted for tool parameters: an object with fixed, typed properties. */
export interface ToolParameters {
  type: "object";
  properties: Record<string, { type: "string" | "integer" | "boolean"; description: string; enum?: string[] }>;
  required: string[];
  additionalProperties: false;
}

export interface ToolSpec {
  /** Lower-case dotted name, e.g. "sunday.open_needs". Must be in NATIVE_TOOL_ALLOWLIST. */
  name: string;
  /** Plain description the model sees. No instructions from source data ever appear here. */
  description: string;
  parameters: ToolParameters;
}

/**
 * The one result shape every tool returns (build contract §4). `payload` contains ONLY placeholder
 * labels ([Person 1], [Role 1], [Room 1] …), counts, dates and fixed vocabulary — never a name read
 * from a source, contact details, or free text copied from a source.
 */
export interface ToolEnvelope {
  tool: string;
  source: string;
  check_time: string;
  completeness: Completeness;
  payload: unknown;
}

export type ToolResult = { ok: true; envelope: ToolEnvelope } | { ok: false; error: ToolError };

/**
 * Every tool name that may ever exist in v1. The native egress step refuses any tool spec or tool call
 * outside this list, so a changed prompt or skill can't widen what the model is offered. There is no
 * write, send, browse, shell, file or network tool, and none may be added without a recorded decision.
 */
export const NATIVE_TOOL_ALLOWLIST = Object.freeze([
  "sunday.overview",
  "sunday.open_needs",
  "sunday.who_could_help",
  "sunday.pending_requests",
  "sunday.rule_checkins",
  "sunday.not_checked",
  "rooms.conflicts",
  "followups.unowned",
  "groups.clashes",
  "today.attention",
  "rules.current",
  "planning_center.refresh",
  "drafts.prepare_note",
] as const);
export type ToolName = (typeof NATIVE_TOOL_ALLOWLIST)[number];

// ---------------------------------------------------------------------------------------------
// Skills (owner decisions: reusable procedures in plain language, "See how this works")

/**
 * A skill is a plain-language procedure stored in core/skills/<id>.md with frontmatter. Installing or
 * loading a skill never grants access: a skill can only use tools that are both in its `tools` list and
 * admitted by the broker for the workspace's granted scopes.
 */
export interface Skill {
  id: string;
  title: string;
  /** One sentence, shown to people. */
  purpose: string;
  /** Tools this skill may use (subset of NATIVE_TOOL_ALLOWLIST). */
  tools: ToolName[];
  /** Planning Center areas it needs: "services" always; "operations" for rooms/follow-ups/groups. */
  needs: Array<"services" | "operations">;
  /** When it runs: on a person's request, and/or as part of the automatic check. */
  runs: Array<"on-request" | "automatic">;
  /** The procedure, in plain language. Shown verbatim under "See how this works". */
  body: string;
  /** sha-256 of the file, so What happened can say which version ran. */
  hash: string;
}

// ---------------------------------------------------------------------------------------------
// Tasks, ledger, events (build contract §2.4 and §3)

export interface AgentTask {
  id: string;
  kind: "ask" | "skill";
  /** For kind "skill": which procedure. For "ask": the general "answer-from-what-was-read" skill. */
  skill_id: string;
  /** For kind "ask": the person's question after the placeholder boundary accepted it. */
  question?: string;
  workspace_id: string;
  created_at: string;
}

/** Name-free metadata only: what ran, which tools, which outcome. Never text from a source or a person. */
export interface TaskEvent {
  task_id: string;
  sequence: number;
  at: string;
  type: "admitted" | "running" | "tool" | "model" | "verified" | "failed" | "cancelled";
  /** For "tool": tool name and completeness, or the error code. For "model": step number. */
  detail: string;
}

export type FailureCode = ToolError | "invalid-task" | "limit" | "timeout" | "cancelled" | "egress"
  | "fidelity" | "transport" | "no-model" | "interrupted";

export interface TaskOutcome {
  status: "verified" | "failed" | "cancelled";
  code: FailureCode | null;
  /** Placeholder-form answer that passed verification (§8). Restored to names only on this Mac, at display. */
  answer: string | null;
  /** Envelopes the answer was verified against, in call order. */
  evidence: ToolEnvelope[];
  events: TaskEvent[];
}

// ---------------------------------------------------------------------------------------------
// Model step (the only path to a model; implemented natively as the `agent_step` command)

export interface AgentToolCall { id: string; name: string; arguments: string }
export type AgentMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: AgentToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface AgentStepRequest {
  task_id: string;
  messages: AgentMessage[];
  tools: ToolSpec[];
  max_tokens: number;
}

export interface AgentStepReply {
  content: string;
  tool_calls: AgentToolCall[];
  finish: "stop" | "tool_calls" | "length";
}

/** Injected into every runtime. Production: Tauri `agent_step`. Tests: a scripted fixture. */
export type ModelStep = (request: AgentStepRequest, signal: AbortSignal) => Promise<AgentStepReply>;

// ---------------------------------------------------------------------------------------------
// Runtime interface (build contract §3: replaceable loop — Pi or plain TypeScript)

export interface ToolHost {
  /** Specs the broker admits for this task (skill tools ∩ granted scopes ∩ allowlist). */
  admitted(task: AgentTask): ToolSpec[];
  /** Runs one admitted tool. Denies anything not admitted for this task. */
  run(task: AgentTask, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult>;
}

export interface RuntimeDeps {
  tools: ToolHost;
  model: ModelStep;
  /** System text for the task: fixed policy + the skill body. Built by the harness, not the loop. */
  instructions(task: AgentTask): string;
  /** Final-answer verification (§8): placeholder-leak scan and support by evidence. */
  verify(answer: string, evidence: ToolEnvelope[], task: AgentTask): { ok: true; answer: string } | { ok: false; code: "fidelity" | "egress" };
  now(): string;
}

export interface RunOptions { signal?: AbortSignal; onEvent?: (event: TaskEvent) => void }

export interface AgentRuntime {
  readonly name: "pi" | "ts";
  run(task: AgentTask, deps: RuntimeDeps, options?: RunOptions): Promise<TaskOutcome>;
}
