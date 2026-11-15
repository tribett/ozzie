// The harness in the desktop app (harness plan H4). Everything that joins the core harness
// (core/src/harness) to this app lives here:
//   - HarnessData from the app's own state (the check on screen, Church rules, decisions, the connection);
//   - the ModelStep over the native `agent_step` command, its closed error codes mapped to FailureCode;
//   - the ledger recorder: each task admitted, its tool events and terminal state recorded in the native
//     task ledger (name-free; the native grammar), without ever breaking or holding up the task itself;
//   - the runtime (PiLoop, the owner's choice; TsLoop only through a debug-only setting);
//   - Ask Ozzie as a harness task, shaped for the panel: refusal, plain failure, or a verified answer
//     restored on this Mac with where it came from and how Ozzie got there.
// Automatic and manual Sunday checks stay deterministic (no model) and are recorded as "check" tasks.
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { evaluateAttentionImport, type AttentionReport } from "../../../core/src/attention-import/index.js";
import { harborAttentionImport } from "../../../core/src/fictional-attention.js";
import { bundledSkills } from "../../../core/src/harness/bundled-skills.js";
import type { AgentRuntime, AgentStepReply, FailureCode, ModelStep, Skill, TaskEvent, TaskOutcome, ToolEnvelope } from "../../../core/src/harness/contract.js";
import { REFUSALS } from "../../../core/src/ask.js";
import {
  decisionsLeftOut, isDecisionQuestion, kidsAnswer, kidsQuestion, NOTHING_TO_DECIDE, openDecisions, type KidsQuestion, type LocalAnswer,
} from "../../../core/src/harness/compose.js";
import { kidsTeams } from "../../../core/src/kids-rules.js";
import { ASK_SKILL, composeAnswer, Harness, type HarnessData } from "../../../core/src/harness/index.js";
import { PiLoop } from "../../../core/src/harness/pi-loop.js";
import type { HarnessSession } from "../../../core/src/harness/session.js";
import { TsLoop } from "../../../core/src/harness/ts-loop.js";
import { sundayOperations, type SundayOperations } from "../../../core/src/operations-capture.js";
import { buildSundayBrief, type SundayBrief } from "../../../core/src/sunday-brief.js";
import type { SundayCapture, SundayRules } from "../../../core/src/sunday-capture.js";
import type { SundayDecision } from "../../../core/src/sunday-decisions.js";
import type { ConnectionStatus } from "./connection.js";
import {
  askFailureText, basedOnEvidence, CAN_DO_INSTEAD, evidenceGaps, ledgerDetail, localSteps, modelSteps, outcomeSteps, type CheckTrigger, type TaskRow,
} from "./harness-words.js";

export type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
const nativeInvoke: Invoke = (command, args) => tauriInvoke(command, args);

// ---- The model step ---------------------------------------------------------------------------------

/** agent_step's closed error vocabulary (agent.rs AgentError), as Tauri rejects with it: a bare string. */
export type AgentErrorCode = "egress" | "denied" | "limit" | "invalid-task" | "ledger-unavailable" | "not-configured" | "budget" | "daily-limit"
  | "rate-limited" | "provider-failure" | "invalid-request" | "model-not-allowed" | "invalid-answer" | "allowance-paused" | "contact-detail";
/** The FailureCodes a model step can end a task with (the loops keep exactly these from a step's error). */
export type StepCode = "egress" | "denied" | "limit" | "invalid-task" | "no-model" | "transport" | "fidelity";
/**
 * Each native code as the loop's FailureCode (review 2026-11-14 C9). The ledger being unavailable is "transport" and
 * a spent allowance (the route's call cap, today's agent steps, or the church's Ozzie managed allowance, which pauses
 * AI help) is "limit"; the Ask panel tells them apart by the native code itself (StepNotes), so each gets its own
 * plain message.
 */
const STEP_CODES: Readonly<Record<AgentErrorCode, StepCode>> = Object.freeze({
  egress: "egress", denied: "denied", limit: "limit", budget: "limit", "daily-limit": "limit", "invalid-task": "invalid-task",
  "ledger-unavailable": "transport", "not-configured": "no-model", "model-not-allowed": "no-model",
  "rate-limited": "transport", "provider-failure": "transport", "invalid-request": "transport",
  // The model's final reply wasn't the closed answer form, or chose a fact the task never read (structured answers).
  "invalid-answer": "fidelity",
  // Ozzie managed: the church's allowance on ozzie.church is spent, so AI help is paused (never retried).
  "allowance-paused": "limit",
  // Ozzie managed: ozzie.church refused the step as holding a phone number or email address; nothing went to the AI.
  "contact-detail": "egress",
});
const nativeCode = (error: unknown): AgentErrorCode | null => {
  const raw = typeof error === "string" ? error : typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof raw === "string" && Object.hasOwn(STEP_CODES, raw) ? raw as AgentErrorCode : null;
};
/** A rejected agent_step as the loop's FailureCode. Anything unknown is "transport". */
export function stepFailure(error: unknown): StepCode {
  const code = nativeCode(error);
  return code ? STEP_CODES[code] : "transport";
}
const STEP_FAILURES: ReadonlySet<string> = new Set<StepCode>(["egress", "denied", "limit", "invalid-task", "no-model", "transport", "fidelity"]);
/** What a ModelStep threw: its own mapped code, or a native code mapped here. */
const thrownCode = (error: unknown) => {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && STEP_FAILURES.has(code) ? code : stepFailure(error);
};
/** What the ModelStep throws: an object with the mapped code (the loops read `.code`). */
export class StepFailure extends Error {
  constructor(readonly code: StepCode) { super(code); this.name = "StepFailure"; }
}

/**
 * The native code behind a task's failed step, kept for the Ask panel's message: the loop keeps only its
 * FailureCode, which can't tell a spent allowance from too many steps, or the record being unavailable from the
 * AI service. Name-free: a task id and a closed code. Read once.
 */
export class StepNotes {
  readonly #codes = new Map<string, AgentErrorCode>();
  record(taskId: string, error: unknown): void {
    const code = nativeCode(error);
    if (!code) return;
    this.#codes.set(taskId, code);
    for (const old of this.#codes.keys()) { if (this.#codes.size <= 64) break; this.#codes.delete(old); }
  }
  take(taskId: string): AgentErrorCode | undefined {
    const code = this.#codes.get(taskId);
    this.#codes.delete(taskId);
    return code;
  }
}
/** The app's notes, written by agentStep and read by askOzzie. */
export const stepNotes = new StepNotes();

/** The loop's only path to a model: native agent_step (allowlist, name guard, contact checks, caps, ZDR route). */
export function agentStep(invoke: Invoke = nativeInvoke, notes: StepNotes = stepNotes): ModelStep {
  return async (request, signal) => {
    if (signal.aborted) throw new StepFailure("transport");
    let stop = () => {};
    const aborted = new Promise<never>((_, reject) => {
      const onAbort = () => reject(new StepFailure("transport"));
      signal.addEventListener("abort", onAbort, { once: true });
      stop = () => signal.removeEventListener("abort", onAbort);
    });
    try {
      return await Promise.race([retryDenied(() => invoke<AgentStepReply>("agent_step", { request }), signal).catch(error => {
        notes.record(request.task_id, error);
        throw new StepFailure(stepFailure(error));
      }), aborted]);
    } finally { stop(); }
  };
}

/**
 * One more try when native drops a reply for calling a tool this task wasn't offered (`denied`). The dropped
 * reply never enters the conversation, so the same request is valid again; it is another step against the
 * task's limit. A second `denied` fails the task as before.
 */
export async function retryDenied<T>(call: () => Promise<T>, signal: AbortSignal): Promise<T> {
  try { return await call(); } catch (error) {
    if (stepFailure(error) !== "denied" || signal.aborted) throw error;
    return await call();
  }
}

// ---- What the harness reads -------------------------------------------------------------------------

/** The Sunday brief exactly as the app builds it (a fictional example is evaluated as of its own check). */
export const sundayBrief = (capture: SundayCapture, rules: SundayRules, now: string, fictional: boolean): SundayBrief =>
  buildSundayBrief(capture, rules, fictional ? capture.completed_at : now, fictional);
export const sundayOps = (capture: SundayCapture, rules: SundayRules, now: string, fictional: boolean): SundayOperations | null =>
  sundayOperations(capture, rules, fictional ? {} : { now });

let fictionalImport: AttentionReport | null | undefined;
const attentionImport = () => {
  if (fictionalImport === undefined) { const r = evaluateAttentionImport(harborAttentionImport()); fictionalImport = r.ok ? r : null; }
  return fictionalImport;
};
const OPERATIONS_READ = /^(?:calendar|people|groups)_/u;

export interface AppSnapshot {
  capture: SundayCapture | null;
  fictional: boolean;
  rules: SundayRules;
  decisions: readonly SundayDecision[];
  status: ConnectionStatus | null;
  /** A saved Planning Center registration and a chosen Sunday, so a fresh check can run. */
  configured: boolean;
  now: string;
  /** The app's own brief and operations for this capture, when it has built them already. */
  brief?: SundayBrief | null;
  operations?: SundayOperations | null;
}
export const modeOf = (capture: SundayCapture | null, fictional: boolean): HarnessData["mode"] =>
  fictional ? "fictional" : capture?.kind === "recording" ? "recording" : "live";
/**
 * What the connection was granted. The fictional example has everything; otherwise the scopes this
 * session verified, or (not yet verified) whether the check on screen itself read Calendar, People or Groups.
 */
export function grantedFor(capture: SundayCapture | null, fictional: boolean, status: ConnectionStatus | null): HarnessData["granted"] {
  if (fictional) return ["services", "operations"];
  if (status?.scopes) return status.scopes === "services-and-operations" ? ["services", "operations"] : ["services"];
  return capture?.reads.some(r => OPERATIONS_READ.test(r.collection) && r.outcome !== "not-requested") ? ["services", "operations"] : ["services"];
}

/** HarnessData for the app's current state. `refresh` (the native Sunday check) is offered only for a real, usable connection. */
export function buildHarnessData(s: AppSnapshot, refresh?: HarnessData["refresh"]): HarnessData {
  const { capture, fictional, rules, now } = s;
  const connected = !fictional && s.configured && (s.status?.state === "connected" || s.status?.state === "stored-unchecked");
  return {
    capture,
    brief: s.brief !== undefined ? s.brief : capture ? sundayBrief(capture, rules, now, fictional) : null,
    operations: s.operations !== undefined ? s.operations : capture ? sundayOps(capture, rules, now, fictional) : null,
    decisions: s.decisions, rules,
    attention: fictional && capture ? attentionImport() : null,
    granted: grantedFor(capture, fictional, s.status),
    mode: modeOf(capture, fictional),
    connected,
    ...(connected && refresh ? { refresh } : {}),
  };
}

// ---- Procedures and the runtime ----------------------------------------------------------------------

let shipped: Promise<ReadonlyMap<string, Skill>> | null = null;
/** The procedures that ship with Ozzie, checked and hashed once. */
export const procedures = (): Promise<ReadonlyMap<string, Skill>> => (shipped ??= bundledSkills());
/** The order procedures are listed in on Church rules. */
export const PROCEDURE_ORDER = ["sunday-ready", "who-could-help", "room-check", "follow-up-owners", "group-night", ASK_SKILL] as const;

export type LoopChoice = "pi" | "ts";
/** Pi is the owner's choice; the plain TypeScript loop stays for comparison in debug builds only. */
export const runtimeFor = (choice: LoopChoice): AgentRuntime => choice === "ts" ? new TsLoop() : new PiLoop();
const LOOP_KEY = "ozzie.dev.loop";
/** Debug-only: which loop answers. Read only when the app knows it is a debug build. */
export const devLoop = {
  get: (debug: boolean): LoopChoice => {
    if (!debug) return "pi";
    try { return typeof localStorage !== "undefined" && localStorage.getItem(LOOP_KEY) === "ts" ? "ts" : "pi"; } catch { return "pi"; }
  },
  set: (choice: LoopChoice) => { try { if (typeof localStorage !== "undefined") localStorage.setItem(LOOP_KEY, choice); } catch { /* per-device convenience only */ } },
};

export interface AppHarnessOptions {
  workspace_id: string;
  data: HarnessData;
  skills: ReadonlyMap<string, Skill>;
  session: HarnessSession;
  loop?: LoopChoice;
  recorder?: LedgerRecorder;
  /** Defaults to native agent_step. */
  step?: ModelStep;
}
/** One Harness for the app: the loop, native agent_step (through the recorder, so each task is running before its first step). */
export function createAppHarness(o: AppHarnessOptions): Harness {
  const step = o.step ?? agentStep();
  return new Harness({
    workspace_id: o.workspace_id, data: o.data, skills: o.skills, session: o.session,
    runtime: runtimeFor(o.loop ?? "pi"), model: o.recorder ? o.recorder.model(step) : step,
  });
}

// ---- The task ledger ----------------------------------------------------------------------------------

/** ledger_* commands' closed error vocabulary (ledger.rs LedgerError), rejected as a bare string. */
const LEDGER_ERRORS: ReadonlySet<string> = new Set(["invalid", "unknown-task", "transition", "full", "unavailable"]);
const ledgerCode = (error: unknown) => typeof error === "string" && LEDGER_ERRORS.has(error) ? error : "unknown";
const TERMINAL = new Set<TaskEvent["type"]>(["verified", "failed", "cancelled"]);
/** Waits for `work`, but never longer than `ms`. Never rejects. */
async function within(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([work.then(() => undefined, () => undefined), new Promise<void>(resolve => { timer = setTimeout(resolve, ms); })]);
  } finally { clearTimeout(timer); }
}

export interface RecorderOptions {
  invoke?: Invoke;
  /** Debug builds: one name-free line per ledger problem. Never question, answer or source text. */
  log?: (line: string) => void;
  /** Off by default: native agent_step records each model step itself. */
  recordModelEvents?: boolean;
  /** How long a model step waits for its task to be admitted and running. The task is never held longer. */
  readyMs?: number;
  /** A bundled procedure's hash. Defaults to the shipped procedures. */
  hashFor?: (skillId: string) => Promise<string | undefined>;
  newId?: () => string;
  /** Where "automatic" or "manual" is kept for each Sunday check (per-device convenience). */
  triggers?: TriggerStore;
}

/** One task in the ledger. Every native call is queued in event order; any failure is swallowed (and logged). */
class Recording {
  id: string | null = null;
  #queue: Promise<void> = Promise.resolve();
  #admitted = false;
  #running = false;
  #terminal = false;
  #skip = false;
  #full = false;
  #ready: () => void = () => {};
  readonly ready: Promise<void> = new Promise(resolve => { this.#ready = resolve; });
  readonly #models: { settle: (outcome: string | null) => void; outcome: Promise<string | null> }[] = [];
  constructor(
    readonly kind: TaskRow["kind"], readonly skillId: string, readonly hash: Promise<string | undefined>,
    readonly owner: LedgerRecorder,
  ) {}

  #call(op: string, command: string, args: Record<string, unknown>): Promise<boolean> {
    return this.owner.invoke(command, args).then(() => true, error => {
      const code = ledgerCode(error);
      if (op === "event" && code === "full") this.#full = true;
      this.owner.log(`ledger: ${op} ${code}`);
      return false;
    });
  }
  #then(work: () => Promise<unknown>): void { this.#queue = this.#queue.then(work).then(() => undefined, () => undefined); }
  #admit(): void {
    if (this.#admitted) return;
    this.#admitted = true;
    this.#then(async () => {
      const skillHash = await this.hash.catch(() => undefined);
      if (!skillHash || !this.id) { this.#skip = true; this.owner.log("ledger: admit no-procedure"); return; }
      this.#skip = !await this.#call("admit", "ledger_admit", { taskId: this.id, kind: this.kind, skillId: this.skillId, skillHash });
    });
  }
  #transition(to: string, code: string | null): void {
    this.#then(async () => { if (!this.#skip) await this.#call("transition", "ledger_transition", { taskId: this.id, to, code }); });
  }
  #toRunning(): void {
    if (this.#running) return;
    this.#running = true;
    this.#transition("running", null);
  }

  /** The runtime's events, as they happen. Never throws and never waits. */
  onEvent(event: TaskEvent): void {
    try {
      if (this.#terminal) return;
      if (!this.id) { this.id = event.task_id; this.owner.track(this); }
      if (event.task_id !== this.id) return;
      switch (event.type) {
        case "admitted": this.#admit(); return;
        case "running":
          this.#admit(); this.#toRunning();
          this.#then(async () => this.#ready());
          return;
        case "tool": {
          const detail = ledgerDetail("tool", event.detail);
          if (detail === null) return;
          this.#then(async () => { if (!this.#skip && !this.#full) await this.#call("event", "ledger_event", { taskId: this.id, kind: "tool", detail }); });
          return;
        }
        case "model": {
          if (!this.owner.recordModelEvents) return;
          let settle: (outcome: string | null) => void = () => {};
          const outcome = new Promise<string | null>(resolve => { settle = resolve; });
          this.#models.push({ settle, outcome });
          this.#then(async () => {
            const detail = ledgerDetail("model", event.detail, await outcome);
            if (detail !== null && !this.#skip && !this.#full) await this.#call("event", "ledger_event", { taskId: this.id, kind: "model", detail });
          });
          return;
        }
        default: {
          if (!TERMINAL.has(event.type)) return;
          this.#terminal = true;
          const code = event.type === "failed" ? ledgerDetail("failed", event.detail) ?? "transport" : null;
          // A model step still waiting ends with the task.
          for (const m of this.#models) m.settle(event.type === "cancelled" ? "cancelled" : code);
          this.#admit();
          // The ledger moves admitted → running → verified | failed, or straight to cancelled.
          if (event.type !== "cancelled") this.#toRunning();
          this.#transition(event.type, event.type === "cancelled" ? null : code);
          // Nothing waits on a finished task, even while its ledger calls are still queued.
          this.#ready();
          this.owner.untrack(this);
        }
      }
    } catch { /* metadata only: recording never steers or stops the task */ }
  }
  /** A model step's outcome (finish reason, or the step's FailureCode). */
  settleModel(outcome: string | null): void { this.#models.shift()?.settle(outcome); }
  /** Settles when every queued ledger call for this task has finished (or failed). */
  done(): Promise<void> { return this.#queue; }
}

/** Ledger calls from the app, best effort. A failed or slow ledger never breaks or blocks the person's task. */
export class LedgerRecorder {
  readonly #invoke: Invoke;
  readonly #log: (line: string) => void;
  readonly #readyMs: number;
  readonly #hashFor: (skillId: string) => Promise<string | undefined>;
  readonly #newId: () => string;
  readonly #triggers: TriggerStore | null;
  readonly recordModelEvents: boolean;
  readonly #active = new Map<string, Recording>();
  readonly #pending = new Set<Promise<void>>();

  constructor(options: RecorderOptions = {}) {
    this.#invoke = options.invoke ?? nativeInvoke;
    this.#log = options.log ?? (() => {});
    this.#readyMs = options.readyMs ?? 3_000;
    this.#hashFor = options.hashFor ?? (async id => (await procedures()).get(id)?.hash);
    this.#newId = options.newId ?? (() => globalThis.crypto.randomUUID());
    this.#triggers = options.triggers ?? null;
    this.recordModelEvents = options.recordModelEvents ?? false;
  }
  invoke(command: string, args: Record<string, unknown>): Promise<unknown> {
    try { return Promise.resolve(this.#invoke(command, args)); } catch (error) { return Promise.reject(error); }
  }
  log(line: string): void { try { this.#log(line); } catch { /* debug lines only */ } }
  track(recording: Recording): void { if (recording.id) this.#active.set(recording.id, recording); }
  untrack(recording: Recording): void { if (recording.id && this.#active.get(recording.id) === recording) this.#active.delete(recording.id); }

  /** An observer for one harness task: pass `onEvent` to harness.ask / runSkill. */
  task(kind: "ask" | "skill" | "check", skillId: string): { onEvent: (event: TaskEvent) => void; done: () => Promise<void> } {
    const recording = new Recording(kind, skillId, this.#hashFor(skillId).catch(() => undefined), this);
    // Counted from the first event: a refused question never starts a task and is never waited for.
    let settled: (() => void) | null = null;
    let finished: Promise<void> | null = null;
    const onEvent = (event: TaskEvent) => {
      if (!finished) { finished = new Promise<void>(resolve => { settled = resolve; }); this.#pending.add(finished); }
      recording.onEvent(event);
      const mine = finished;
      if (TERMINAL.has(event.type)) void recording.done().then(() => { this.#pending.delete(mine); settled?.(); });
    };
    return { onEvent, done: () => recording.done() };
  }

  /**
   * The ModelStep, after this task is admitted and running in the ledger (native agent_step requires it),
   * waiting at most `readyMs`. The step's outcome is kept for the model event when those are recorded here.
   */
  model(step: ModelStep): ModelStep {
    return async (request, signal) => {
      const recording = this.#active.get(request.task_id);
      if (recording) await within(recording.ready, this.#readyMs);
      try {
        const reply = await step(request, signal);
        recording?.settleModel(typeof reply?.finish === "string" ? reply.finish : null);
        return reply;
      } catch (error) {
        recording?.settleModel(thrownCode(error));
        throw error;
      }
    };
  }

  /**
   * One deterministic Sunday check as a "check" task under the Sunday ready procedure, with one tool
   * event for the Planning Center read. No model is involved. The check runs at once and is never held
   * up by the ledger; its own result or error is returned unchanged.
   */
  async check(work: () => Promise<SundayCapture>, trigger: CheckTrigger = "automatic"): Promise<SundayCapture> {
    const id = this.#newId();
    const observer = this.task("check", "sunday-ready");
    let sequence = 0;
    const emit = (type: TaskEvent["type"], detail = "") => observer.onEvent({ task_id: id, sequence: ++sequence, at: new Date().toISOString(), type, detail });
    try { this.#triggers?.set(id, trigger); } catch { /* per-device convenience only */ }
    emit("admitted");
    emit("running");
    try {
      const capture = await work();
      const partial = capture.reads.some(r => r.outcome !== "ok" && r.outcome !== "not-requested");
      emit("tool", `planning_center.refresh:${partial ? "partial" : "complete"}`);
      emit("verified");
      return capture;
    } catch (error) {
      emit("failed", checkFailure(error));
      throw error;
    }
  }

  /**
   * A question answered on this Mac without the AI (review Q L3), as an "ask" task under the Ask procedure: admitted,
   * running, one tool event per read, verified, and kept as "on-this-mac" so What happened says where it was answered.
   * Name-free like every task; no model step. Best effort, like every ledger call.
   */
  answeredHere(evidence: readonly ToolEnvelope[]): void {
    const id = this.#newId();
    const observer = this.task("ask", ASK_SKILL);
    let sequence = 0;
    const emit = (type: TaskEvent["type"], detail = "") => observer.onEvent({ task_id: id, sequence: ++sequence, at: new Date().toISOString(), type, detail });
    try { this.#triggers?.set(id, "on-this-mac"); } catch { /* per-device convenience only */ }
    emit("admitted");
    emit("running");
    for (const e of evidence) emit("tool", `${e.tool}:${e.completeness}`);
    emit("verified");
  }

  /** Recent tasks, newest first; null when the ledger isn't available. */
  async list(limit = 50): Promise<TaskRow[] | null> {
    try {
      const rows = await this.#invoke<TaskRow[]>("ledger_list", { limit });
      return Array.isArray(rows) ? rows : null;
    } catch (error) {
      this.log(`ledger: list ${ledgerCode(error)}`);
      return null;
    }
  }
  /** Settles when every task recorded so far has finished writing, or after `ms` if the ledger is stuck. */
  async idle(ms = 5_000): Promise<void> { await within(Promise.all([...this.#pending]), ms); }
}

/** A failed Sunday check as a FailureCode. Fixed codes only; native text is never kept. */
export function checkFailure(error: unknown): FailureCode {
  const known = JSON.stringify(error) ?? "";
  if (/not-connected|missing-credentials|invalid-credentials|denied/u.test(known)) return "denied";
  return "provider-failure";
}

/** "automatic" or "manual" by check task id, kept on this Mac only (the ledger has no field for it). */
export interface TriggerStore { get(id: string): CheckTrigger | undefined; set(id: string, trigger: CheckTrigger): void }
const TRIGGERS_KEY = "ozzie.ledger.checks.v1";
const TRIGGERS_KEPT = 200;
export function localTriggers(store: { getItem(k: string): string | null; setItem(k: string, v: string): void } | null = typeof localStorage === "undefined" ? null : localStorage): TriggerStore {
  const read = (): [string, CheckTrigger][] => {
    try {
      const raw = JSON.parse(store?.getItem(TRIGGERS_KEY) ?? "[]") as unknown;
      return Array.isArray(raw) ? raw.filter((e): e is [string, CheckTrigger] => Array.isArray(e) && typeof e[0] === "string" && (e[1] === "automatic" || e[1] === "manual" || e[1] === "on-this-mac")) : [];
    } catch { return []; }
  };
  return {
    get: id => read().find(([k]) => k === id)?.[1],
    set: (id, trigger) => { try { store?.setItem(TRIGGERS_KEY, JSON.stringify([[id, trigger], ...read().filter(([k]) => k !== id)].slice(0, TRIGGERS_KEPT))); } catch { /* per-device convenience only */ } },
  };
}

let debugLines = false;
/** Debug builds only: ledger problems go to the developer's terminal (dev_log is a no-op in release builds too). */
export const enableDebugLines = () => { debugLines = true; };
let desktop: LedgerRecorder | null = null;
/** The app's one recorder. */
export function desktopRecorder(): LedgerRecorder {
  return desktop ??= new LedgerRecorder({
    triggers: localTriggers(),
    log: line => { if (debugLines) void nativeInvoke("dev_log", { line }).catch(() => undefined); },
  });
}

// ---- Ask Ozzie as a harness task ------------------------------------------------------------------------

export interface ShownAnswer {
  /** Restored on this Mac. */
  body: string;
  /** A drafted note, restored with first names. Shown as "Draft only. Nothing has been sent." */
  draft: string | null;
  notCovered: boolean;
  basedOn: string;
  /** "Worth a look" lines: reads that weren't complete. */
  gaps: string[];
  /** The procedure Ozzie followed, verbatim. */
  procedure: { title: string; body: string } | null;
  /** The steps it took, in plain words. */
  steps: string[];
  /** How many times the AI was asked. */
  aiSteps: number;
  /** Where to look next. */
  page: "sunday" | "today";
  /** Written on this Mac without the AI (kids teams and background checks): nothing was sent. */
  local?: boolean;
  /** Open decisions the AI's answer left out were added on this Mac, under "Also on the Sunday page". */
  added?: boolean;
}
export type AskTurn =
  | { state: "refused"; text: string }
  | { state: "no-model" }
  | { state: "problem"; code: FailureCode | null; text: string }
  | { state: "cancelled"; text: string }
  | { state: "answered"; answer: ShownAnswer };

/**
 * A verified outcome, written on this Mac: Ozzie's own sentence for each fact the AI chose (core compose.ts), in
 * Ozzie's order, then names and times restored here. A draft is only ever the drafting tool's own text, restored with
 * first names. The same for Ask and for a responsibility's prepared summary.
 */
export function shownAnswer(harness: Harness, outcome: TaskOutcome, procedure: Skill | undefined, sender: string): ShownAnswer {
  const composed = composeAnswer(outcome.answer ?? "", outcome.evidence);
  const mode = harness.data.mode;
  return {
    body: composed.paragraphs.map(p => harness.restore(p, { sender })).join("\n\n"),
    draft: composed.draft ? harness.restore(composed.draft, { sender, firstNames: true }) : null,
    notCovered: composed.kind === "not-covered" || outcome.evidence.length === 0,
    basedOn: basedOnEvidence(outcome.evidence, mode),
    gaps: evidenceGaps(outcome.evidence, mode),
    procedure: procedure ? { title: procedure.title, body: procedure.body } : null,
    steps: outcomeSteps(outcome.events),
    aiSteps: modelSteps(outcome.events),
    page: outcome.evidence.some((e: ToolEnvelope) => e.tool === "today.attention") ? "today" : "sunday",
  };
}

/** Background checks on every kids team: for a note about one, which is never drafted with AI help (review Q H2). */
const backgroundOnly = (data: HarnessData): KidsQuestion => {
  const teams = kidsTeams(data.rules).map(t => t.team_id);
  return { teams, marked: teams.length > 0, named: false, background: true, who: false, whole: false };
};

/** An answer written on this Mac without the AI (core compose.ts kidsAnswer), restored here; `first` is fixed wording shown above it. */
export function localAnswer(harness: Harness, local: LocalAnswer, first: string[] = []): ShownAnswer {
  const mode = harness.data.mode;
  return {
    body: [...first, ...local.paragraphs.map(p => local.fill(harness.restore(p)))].join("\n\n"),
    draft: null, notCovered: false,
    basedOn: basedOnEvidence([...local.evidence, ...local.sources], mode),
    gaps: [...evidenceGaps(local.evidence, mode), ...local.gaps],
    procedure: null,
    steps: localSteps(local.evidence, local.sources.some(s => s.source === "Planning Center People")),
    aiSteps: 0, page: "sunday", local: true,
  };
}

/**
 * One question: refused before anything is sent; a question about kids teams or background checks answered on this Mac
 * without the AI (background checks never reach it); or run as a task and shaped for the panel, with any open decisions
 * a decision question's answer left out added here, and what Ozzie can do instead when it can't tell.
 */
export async function askOzzie(harness: Harness, typed: string, options: {
  signal?: AbortSignal; recorder?: LedgerRecorder | null; skills: ReadonlyMap<string, Skill>; sender?: string;
  /** Where agentStep kept the native code of a failed step. Defaults to the app's. */
  notes?: StepNotes;
}): Promise<AskTurn> {
  const signal = options.signal ?? new AbortController().signal;
  const here = async (work: () => Promise<LocalAnswer>, first: string[] = []): Promise<AskTurn> => {
    const local = await work();
    if (signal.aborted) return { state: "cancelled", text: askFailureText("cancelled") };
    options.recorder?.answeredHere(local.evidence);
    return { state: "answered", answer: localAnswer(harness, local, first) };
  };
  // The same refusals first, so nothing is answered here that couldn't be asked.
  const prepared = harness.prepare(typed);
  if (!prepared.ok) {
    // A question naming a background check is never prepared for the AI (review Q H2): it is answered here instead.
    if (prepared.refusal === REFUSALS.backgroundNote) return here(() => kidsAnswer(harness.tools, backgroundOnly(harness.data), signal), [REFUSALS.backgroundNote]);
    if (prepared.refusal === REFUSALS.background) {
      const q = kidsQuestion(typed, harness.data);
      if (q && !q.whole) return here(() => kidsAnswer(harness.tools, q, signal));
      return here(() => openDecisions(harness.tools, signal));
    }
    return { state: "refused", text: prepared.refusal };
  }
  const kids = kidsQuestion(typed, harness.data);
  if (kids) return here(() => kidsAnswer(harness.tools, kids, signal));
  const observer = options.recorder?.task("ask", ASK_SKILL);
  const result = await harness.ask(typed, { ...(options.signal ? { signal: options.signal } : {}), ...(observer ? { onEvent: observer.onEvent } : {}) });
  if (!result.ok) return { state: "refused", text: result.refusal };
  const { outcome } = result;
  const native = (options.notes ?? stepNotes).take(result.task.id);
  if (outcome.status === "verified" && outcome.answer) {
    const shown = shownAnswer(harness, outcome, options.skills.get(ASK_SKILL), options.sender ?? "");
    // No silent omission: the open decisions the answer left out, in fixed words, with their sources.
    const left = isDecisionQuestion(typed) && !signal.aborted ? await decisionsLeftOut(harness.tools, outcome.answer, outcome.evidence, signal) : null;
    const added = left !== null && left.paragraphs.length > 0;
    // "Nothing in this check needs a decision" counts only what the AI read; it is never said above decisions added here.
    const own = shown.body.split("\n\n").filter(p => p && !(added && p === NOTHING_TO_DECIDE));
    const body = [...own, ...(added ? left.paragraphs.map(p => left.fill(harness.restore(p))) : []), ...(shown.notCovered && !added ? [CAN_DO_INSTEAD] : [])].join("\n\n");
    const mode = harness.data.mode;
    return { state: "answered", answer: {
      ...shown, body,
      ...(added ? {
        added: true, basedOn: basedOnEvidence([...outcome.evidence, ...left.evidence, ...left.sources], mode),
        gaps: [...new Set([...shown.gaps, ...evidenceGaps(left.evidence, mode)])],
        // What Ozzie read on this Mac for them, after the AI's own steps, each once.
        steps: [...new Set([...shown.steps, ...localSteps(left.evidence, left.sources.some(s => s.source === "Planning Center People"))])],
      } : {}),
    } };
  }
  if (outcome.status === "cancelled") return { state: "cancelled", text: askFailureText("cancelled") };
  if (outcome.code === "no-model") return { state: "no-model" };
  return { state: "problem", code: outcome.code, text: askFailureText(outcome.code, native) };
}
