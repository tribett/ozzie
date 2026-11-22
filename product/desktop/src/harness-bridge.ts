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
  asksAboutChecksOrKids, asksAboutCoverage, canDoFor, chosenSources, decisionsLeftOut, isDecisionQuestion, isNothingToDecide, kidsAnswer, kidsQuestion, NOTHING_OPEN, nothingOpenAt, onPage, openDecisions,
  rosterAnswer, rosterNote, rosterQuestion, type KidsQuestion, type LocalAnswer,
} from "../../../core/src/harness/compose.js";
import { reminderDraft, restoreReminder } from "../../../core/src/reminder-draft.js";
import { isTimeZone } from "../../../core/src/church-time.js";
import { answerText, parseAnswer } from "../../../core/src/harness/fixed.js";
import { kidsTeams } from "../../../core/src/kids-rules.js";
import { ASK_SKILL, composeAnswer, Harness, type HarnessData } from "../../../core/src/harness/index.js";
import { PiLoop } from "../../../core/src/harness/pi-loop.js";
import type { HarnessSession } from "../../../core/src/harness/session.js";
import { TsLoop } from "../../../core/src/harness/ts-loop.js";
import { sundayOperations, type SundayOperations } from "../../../core/src/operations-capture.js";
import { SUNDAY_WORDS } from "../../../core/src/service-day.js";
import { buildSundayBrief, type Finding, type SundayBrief } from "../../../core/src/sunday-brief.js";
import type { SundayCapture, SundayRules } from "../../../core/src/sunday-capture.js";
import type { SundayDecision } from "../../../core/src/sunday-decisions.js";
import { SYSTEM_IDS, type CapturePart, type SystemCapture, type SystemId } from "../../../core/src/church-systems/types.js";
import { CAPTURE_PARTS, unreadParts } from "../../../core/src/church-systems/reads.js";
export { systemHarnessCapture } from "../../../core/src/church-systems/harness.js";
import { operationsGranted, type ConnectionStatus } from "./connection.js";
import {
  ASK_FAILURES, askFailureText, BACKGROUND_HERE, basedOnEvidence, canDoInstead, CHECK_FOUND, evidenceGaps, isTaskStart, ledgerDetail, localSteps, modelSteps, outcomeSteps, STATUS_WORDS, TASK_ENDS, TOOL_PHRASES,
  type CheckFound, type CheckTrigger, type TaskEnd, type TaskRow, type TaskStart,
} from "./harness-words.js";

export type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
const nativeInvoke: Invoke = (command, args) => tauriInvoke(command, args);

// ---- The model step ---------------------------------------------------------------------------------

/** agent_step's closed error vocabulary (agent.rs AgentError), as Tauri rejects with it: a bare string. */
export type AgentErrorCode = "egress" | "denied" | "limit" | "invalid-task" | "ledger-unavailable" | "not-configured" | "budget" | "daily-limit"
  | "rate-limited" | "provider-failure" | "invalid-request" | "model-not-allowed" | "invalid-answer" | "allowance-paused" | "contact-detail"
  | "background-check" | "month-limit" | "no-credit" | "thought-only" | "too-many-facts" | "invalid-arguments" | "not-on-this-mac" | "not-accepted";
/** The FailureCodes a model step can end a task with (the loops keep exactly these from a step's error). */
export type StepCode = "egress" | "denied" | "limit" | "invalid-task" | "no-model" | "transport" | "fidelity" | "invalid-arguments";
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
  // The answer form's one fault was choosing more than its facts (vocabulary.json `max_facts`): still an answer Ozzie
  // doesn't check, so "fidelity"; the Ask panel knows why from the native code (askOzzie: AI on this Mac writes a decision
  // question's answer itself, and anywhere else it says the true reason).
  "too-many-facts": "fidelity",
  // The model asked for a lookup with arguments the tool doesn't take (a `role` for the open roles): its own code, never
  // "egress", which says the question held details kept on this Mac.
  "invalid-arguments": "invalid-arguments",
  // Ozzie managed: the church's allowance on ozzie.church is spent, so AI help is paused (never retried).
  "allowance-paused": "limit",
  // The church's own AI company says its account has no credit left (model.rs NoCredit): nothing more is sent.
  "no-credit": "limit",
  // Gemini spent the step's whole answer thinking and said nothing (contract 14): a failure of this answer, not a limit.
  "thought-only": "transport",
  // Ozzie managed: ozzie.church refused the step as holding a phone number or email address; nothing went to the AI.
  "contact-detail": "egress",
  // Background-check wording in the step (owner decision 2026-11-14), found natively or by ozzie.church before anything
  // reached the AI. The ledger records only "egress"; the Ask panel shows the page's own refusal (askOzzie).
  "background-check": "egress",
  // The church's own key reached its monthly limit (contract N5): AI help is paused until next month, never retried.
  "month-limit": "limit",
  // AI on this Mac whose model runs elsewhere (Ollama's cloud models; native asks its app before every step): nothing was
  // sent, and the route can't be used, so the Ask panel shows its way to choose how Ozzie uses AI.
  "not-on-this-mac": "no-model",
  // Ozzie managed: ozzie.church's own check of the step turned it down (HTTP 400 invalid-request), so nothing reached the
  // AI. Ozzie's guard, never the network: "invalid-task" in the ledger, and the Ask panel says which (round 3).
  "not-accepted": "invalid-task",
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
const STEP_FAILURES: ReadonlySet<string> = new Set<StepCode>(["egress", "denied", "limit", "invalid-task", "no-model", "transport", "fidelity", "invalid-arguments"]);
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
  /**
   * Whether the fictional email-and-calendar import goes with the fictional example (the default). Off once the
   * leader's own calendar is on Today, which no longer shows it, so Ask neither answers from it nor points to it.
   */
  fictionalImport?: boolean;
  /** A church on B1 Church or Breeze: the system named as the source of every Services fact (HarnessData `source`). */
  source?: string;
  /** Several services watched: each team's service by its own name, for answers written on this Mac (HarnessData `serviceOfTeam`). */
  serviceOfTeam?: Readonly<Record<string, string>> | undefined;
  /** Several services watched: every watched service's own name and whether this check holds it (HarnessData `services`). */
  services?: HarnessData["services"] | undefined;
  /** Several services watched: each finding's service by the finding's id (HarnessData `serviceOfFinding`). */
  serviceOfFinding?: HarnessData["serviceOfFinding"] | undefined;
}
export const modeOf = (capture: SundayCapture | null, fictional: boolean): HarnessData["mode"] =>
  fictional ? "fictional" : capture?.kind === "recording" ? "recording" : "live";
/**
 * What the connection was granted. The fictional example has everything; otherwise the scopes this
 * session verified, or (not yet verified) whether the check on screen itself read Calendar, People or Groups.
 */
export function grantedFor(capture: SundayCapture | null, fictional: boolean, status: ConnectionStatus | null): HarnessData["granted"] {
  if (fictional) return ["services", "operations"];
  if (status?.scopes) return operationsGranted(status) ? ["services", "operations"] : ["services"];
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
    attention: fictional && capture && s.fictionalImport !== false ? attentionImport() : null,
    granted: grantedFor(capture, fictional, s.status),
    mode: modeOf(capture, fictional),
    connected,
    ...(connected && refresh ? { refresh } : {}),
    ...(s.source ? { source: s.source } : {}),
    ...(s.serviceOfTeam ? { serviceOfTeam: s.serviceOfTeam } : {}),
    ...(s.services ? { services: s.services } : {}),
    ...(s.serviceOfFinding ? { serviceOfFinding: s.serviceOfFinding } : {}),
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

  /**
   * An observer for one harness task: pass `onEvent` to harness.ask / runSkill. `start`: how it started (a job's run, or
   * who could help from a Sunday card), kept on this Mac beside the ledger for What happened.
   */
  task(kind: "ask" | "skill" | "check", skillId: string, start?: TaskStart): { onEvent: (event: TaskEvent) => void; done: () => Promise<void> } {
    const recording = new Recording(kind, skillId, this.#hashFor(skillId).catch(() => undefined), this);
    // Counted from the first event: a refused question never starts a task and is never waited for.
    let settled: (() => void) | null = null;
    let finished: Promise<void> | null = null;
    const onEvent = (event: TaskEvent) => {
      if (!finished) {
        finished = new Promise<void>(resolve => { settled = resolve; }); this.#pending.add(finished);
        if (start) this.started(event.task_id, start);
      }
      recording.onEvent(event);
      const mine = finished;
      if (TERMINAL.has(event.type)) void recording.done().then(() => { this.#pending.delete(mine); settled?.(); });
    };
    return { onEvent, done: () => recording.done() };
  }
  /** How a task started, kept on this Mac by its id (closed words; never fails the task). */
  started(taskId: string, start: TaskStart): void { try { this.#triggers?.set(taskId, start); } catch { /* per-device convenience only */ } }
  /** Which closed form a verified answer took, kept the same way. */
  ended(taskId: string, end: TaskEnd): void { try { if ((TASK_ENDS as readonly string[]).includes(end)) this.#triggers?.setEnd(taskId, end); } catch { /* per-device convenience only */ } }
  /** What a finished check found (closed words), kept the same way for What happened. */
  checked(taskId: string, found: CheckFound): void { try { if ((CHECK_FOUND as readonly string[]).includes(found)) this.#triggers?.setFound?.(taskId, found); } catch { /* per-device convenience only */ } }

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
   * up by the ledger; its own result or error is returned unchanged. `onTask` is told its task id first, so
   * what the check found can be kept beside it (proactive.ts).
   */
  check(work: () => Promise<SundayCapture>, trigger: CheckTrigger = "automatic", onTask?: (taskId: string) => void, serviceTypeId?: string): Promise<SundayCapture> {
    return this.#checkTask(work, "planning_center.refresh", checkFailure, trigger, id => {
      // Which service it read, so What happened folds each service's quiet checks apart (several services watched).
      if (serviceTypeId) try { this.#triggers?.setService?.(id, serviceTypeId); } catch { /* per-device convenience only */ }
      onTask?.(id);
    });
  }
  /**
   * One check of a church on B1 Church or Breeze, as a "check" task the same way. The ledger names no tool for its read
   * (its event is only how complete the read was); which system it read is kept beside it on this Mac, so What happened
   * names it.
   */
  checkSystem(work: () => Promise<SystemCapture>, system: SystemId, trigger: CheckTrigger = "automatic", onTask?: (taskId: string) => void): Promise<SystemCapture> {
    let task = "";
    return this.#checkTask(work, "church_system.refresh", systemCheckFailure, trigger, id => {
      task = id;
      try { this.#triggers?.setSource?.(id, system); } catch { /* per-device convenience only */ }
      onTask?.(id);
    }, capture => {
      // Partial only for what didn't read in full, never a read the system cuts short by design (reads.ts); which parts,
      // in closed words, is kept beside the task so What happened can say them.
      const parts = unreadParts(capture);
      try { if (parts.length) this.#triggers?.setParts?.(task, parts); } catch { /* per-device convenience only */ }
      return parts.length > 0;
    });
  }
  async #checkTask<C extends { reads: readonly { outcome: string }[] }>(work: () => Promise<C>, tool: string, failure: (error: unknown) => FailureCode,
    trigger: CheckTrigger, onTask?: (taskId: string) => void,
    partialOf: (capture: C) => boolean = capture => capture.reads.some(r => r.outcome !== "ok" && r.outcome !== "not-requested")): Promise<C> {
    const id = this.#newId();
    try { onTask?.(id); } catch { /* per-device convenience only: never fails the check */ }
    const observer = this.task("check", "sunday-ready");
    let sequence = 0;
    const emit = (type: TaskEvent["type"], detail = "") => observer.onEvent({ task_id: id, sequence: ++sequence, at: new Date().toISOString(), type, detail });
    this.started(id, trigger);
    emit("admitted");
    emit("running");
    try {
      const capture = await work();
      const partial = partialOf(capture);
      emit("tool", `${tool}:${partial ? "partial" : "complete"}`);
      emit("verified");
      return capture;
    } catch (error) {
      emit("failed", failure(error));
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
    this.started(id, "on-this-mac");
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

/**
 * A failed Sunday check as a FailureCode, true to its cause wherever the code is shown (What happened, a job's card, the
 * copy for other AI apps). Fixed codes only; native text is never kept.
 *  - `unverified`: Ozzie couldn't confirm which church the sign-in belongs to (native `organization-unverified`).
 *  - `cancelled`: it stopped because Ozzie's sign-in was busy (another read, a sign-in, a church switch, Disconnect) or this
 *    Mac's credential storage was locked.
 *  - `denied`: no sign-in Ozzie could use: none connected, one that couldn't be renewed (refused, or nothing to renew with),
 *    or the Mac refused or couldn't give it.
 *  - `provider-failure`: Planning Center out of reach, and anything else.
 */
/**
 * Why a check of a church on B1 Church or Breeze failed, by native's closed word (proactive.ts SystemReadFailure): its key
 * missing or refused is `denied`, the Keychain locked or another check under way `cancelled`, anything else
 * `provider-failure`.
 */
export function systemCheckFailure(error: unknown): FailureCode {
  const outcome = error instanceof Error && "outcome" in error ? String((error as { outcome: unknown }).outcome) : typeof error === "string" ? error : "";
  if (/^(?:no-key|key-refused|refused|bad-key)$/u.test(outcome)) return "denied";
  if (/^(?:busy|locked|cancelled)$/u.test(outcome)) return "cancelled";
  return "provider-failure";
}
export function checkFailure(error: unknown): FailureCode {
  const known = JSON.stringify(error) ?? "";
  if (known.includes("organization-unverified")) return "unverified";
  if (/"(?:busy|cancelled|locked)"/u.test(known)) return "cancelled";
  if (/not-connected|missing-credentials|invalid-credentials|invalid-token|denied|store-unavailable|"unavailable"/u.test(known)) return "denied";
  return "provider-failure";
}

/**
 * How each task started ("automatic", "manual", a job's run …), which closed form a verified answer took, and what a check
 * found, by task id, kept on this Mac only (the ledger has no field for any of them). Closed words only: never a
 * question, answer or name.
 */
export interface TriggerStore {
  get(id: string): TaskStart | undefined;
  set(id: string, trigger: TaskStart): void;
  end(id: string): TaskEnd | undefined;
  setEnd(id: string, end: TaskEnd): void;
  found?(id: string): CheckFound | undefined;
  setFound?(id: string, found: CheckFound): void;
  /** The system a check read, when it isn't Planning Center (a church on B1 Church or Breeze). */
  source?(id: string): SystemId | undefined;
  setSource?(id: string, system: SystemId): void;
  /** The parts such a check didn't read in full (reads.ts closed words), when there were any. */
  parts?(id: string): CapturePart[] | undefined;
  setParts?(id: string, parts: readonly CapturePart[]): void;
  /** The Planning Center service type a check read (an id only), so What happened folds each service's quiet checks apart. */
  service?(id: string): string | undefined;
  setService?(id: string, serviceTypeId: string): void;
}
const TRIGGERS_KEY = "ozzie.ledger.checks.v1";
const TRIGGERS_KEPT = 200;
/**
 * What each check found, under its own key: an earlier Ozzie reading the list above drops any entry with a word it
 * doesn't know, start and all, so these never go there.
 */
const FOUND_LIST = "ozzie.ledger.found.v1";
/** Which system each of a church system's checks read, under its own key for the same reason. */
const SOURCE_LIST = "ozzie.ledger.systems.v1";
/** The parts a church system's check didn't read in full, the same way (closed words only). */
const PARTS_LIST = "ozzie.ledger.system-parts.v1";
/** Which Planning Center service type each check read (ids only), under its own key for the same reason. */
const SERVICE_LIST = "ozzie.ledger.services.v1";
type Kept = [string, TaskStart | null, TaskEnd?];
export function localTriggers(store: { getItem(k: string): string | null; setItem(k: string, v: string): void } | null = typeof localStorage === "undefined" ? null : localStorage):
  Required<TriggerStore> {
  const read = (): Kept[] => {
    try {
      const raw = JSON.parse(store?.getItem(TRIGGERS_KEY) ?? "[]") as unknown;
      return Array.isArray(raw) ? raw.filter((e): e is Kept => Array.isArray(e) && typeof e[0] === "string" && (e[1] === null || isTaskStart(e[1]))
        && (e[2] === undefined || (TASK_ENDS as readonly unknown[]).includes(e[2]))) : [];
    } catch { return []; }
  };
  const write = (id: string, change: (e: Kept) => Kept) => {
    try {
      const all = read();
      const next = change(all.find(([k]) => k === id) ?? [id, null]);
      store?.setItem(TRIGGERS_KEY, JSON.stringify([next, ...all.filter(([k]) => k !== id)].slice(0, TRIGGERS_KEPT)));
    } catch { /* per-device convenience only */ }
  };
  return {
    get: id => read().find(([k]) => k === id)?.[1] ?? undefined,
    // Closed words only, on write as on read (review H, L10).
    set: (id, trigger) => { if (isTaskStart(trigger)) write(id, e => e[2] ? [id, trigger, e[2]] : [id, trigger]); },
    end: id => read().find(([k]) => k === id)?.[2],
    setEnd: (id, end) => { if ((TASK_ENDS as readonly unknown[]).includes(end)) write(id, e => [id, e[1], end]); },
    found: id => readFound().find(([k]) => k === id)?.[1],
    setFound: (id, found) => {
      if (!(CHECK_FOUND as readonly unknown[]).includes(found)) return;
      try { store?.setItem(FOUND_LIST, JSON.stringify([[id, found], ...readFound().filter(([k]) => k !== id)].slice(0, TRIGGERS_KEPT))); } catch { /* per-device convenience only */ }
    },
    parts: id => readParts().find(([k]) => k === id)?.[1],
    setParts: (id, parts) => {
      const kept = parts.filter(p => (CAPTURE_PARTS as readonly string[]).includes(p));
      if (!kept.length) return;
      try { store?.setItem(PARTS_LIST, JSON.stringify([[id, kept], ...readParts().filter(([k]) => k !== id)].slice(0, TRIGGERS_KEPT))); } catch { /* per-device convenience only */ }
    },
    service: id => readService().find(([k]) => k === id)?.[1],
    setService: (id, serviceTypeId) => {
      if (!/^[1-9]\d{0,31}$/u.test(serviceTypeId)) return;
      try { store?.setItem(SERVICE_LIST, JSON.stringify([[id, serviceTypeId], ...readService().filter(([k]) => k !== id)].slice(0, TRIGGERS_KEPT))); } catch { /* per-device convenience only */ }
    },
    source: id => readSource().find(([k]) => k === id)?.[1],
    setSource: (id, system) => {
      if (!(SYSTEM_IDS as readonly unknown[]).includes(system)) return;
      try { store?.setItem(SOURCE_LIST, JSON.stringify([[id, system], ...readSource().filter(([k]) => k !== id)].slice(0, TRIGGERS_KEPT))); } catch { /* per-device convenience only */ }
    },
  };
  function readParts(): [string, CapturePart[]][] {
    try {
      const raw = JSON.parse(store?.getItem(PARTS_LIST) ?? "[]") as unknown;
      return Array.isArray(raw) ? raw.filter((e): e is [string, CapturePart[]] => Array.isArray(e) && e.length === 2 && typeof e[0] === "string"
        && Array.isArray(e[1]) && e[1].length > 0 && e[1].every(p => (CAPTURE_PARTS as readonly unknown[]).includes(p))) : [];
    } catch { return []; }
  }
  function readService(): [string, string][] {
    try {
      const raw = JSON.parse(store?.getItem(SERVICE_LIST) ?? "[]") as unknown;
      return Array.isArray(raw) ? raw.filter((e): e is [string, string] => Array.isArray(e) && e.length === 2 && typeof e[0] === "string"
        && typeof e[1] === "string" && /^[1-9]\d{0,31}$/u.test(e[1])) : [];
    } catch { return []; }
  }
  function readSource(): [string, SystemId][] {
    try {
      const raw = JSON.parse(store?.getItem(SOURCE_LIST) ?? "[]") as unknown;
      return Array.isArray(raw) ? raw.filter((e): e is [string, SystemId] => Array.isArray(e) && e.length === 2 && typeof e[0] === "string"
        && (SYSTEM_IDS as readonly unknown[]).includes(e[1])) : [];
    } catch { return []; }
  }
  function readFound(): [string, CheckFound][] {
    try {
      const raw = JSON.parse(store?.getItem(FOUND_LIST) ?? "[]") as unknown;
      return Array.isArray(raw) ? raw.filter((e): e is [string, CheckFound] => Array.isArray(e) && e.length === 2 && typeof e[0] === "string"
        && (CHECK_FOUND as readonly unknown[]).includes(e[1])) : [];
    } catch { return []; }
  }
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
  /** What it looked at, in plain words: one line per read, with how much of it could be read. */
  steps: string[];
  /** How many times the AI was asked. */
  aiSteps: number;
  /** Which closed form the verified answer took (absent for one written on this Mac). */
  end?: TaskEnd;
  /** Where to look next. */
  page: "sunday" | "today";
  /** Written on this Mac without the AI (kids teams and background checks): nothing was sent. */
  local?: boolean;
  /** Open decisions the AI's answer left out were added on this Mac, under "Also on the Sunday page". */
  added?: boolean;
  /**
   * Written by Ozzie itself from the overview the task read, because the AI's answer chose more facts than Ozzie checks in
   * one answer (`overviewAnswer`): the AI was asked, but none of this is its choice.
   */
  composedHere?: boolean;
  /** Who could help, from a Sunday card: what the AI's look adds to the fixed list (the people are always the finding's own). */
  look?: Look;
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
/**
 * The sources of the overview's rooms, follow-ups and group meetings the answer chose, at the operations check's time and
 * each with its own completeness (review item 5): named under "Based on", and said under Worth a look when that source's
 * reads didn't all complete.
 */
const rowSources = (harness: Harness, outcome: TaskOutcome) => chosenSources(outcome.answer ?? "", outcome.evidence, harness.tools.rowSources());

/**
 * Said under an answer that read the service of a church system that shares no number needed for any role (Breeze):
 * Ozzie can't say whether a role is full, so "nothing needs a decision" is never the whole answer (review of round 4,
 * M5). Ozzie's own words on this Mac, never a tool result: the sentence isn't in the shared vocabulary.
 */
export function systemGaps(data: HarnessData, evidence: readonly Pick<ToolEnvelope, "source">[]): string[] {
  const roles = data.brief?.roster?.roles ?? [];
  if (!data.source || !roles.length || !roles.every(r => r.needed === null)) return [];
  return evidence.some(e => e.source === data.source)
    ? [`${data.source} doesn't share how many people each role needs, so Ozzie can't say whether a role is full.`] : [];
}
export function shownAnswer(harness: Harness, outcome: TaskOutcome, procedure: Skill | undefined, sender: string): ShownAnswer {
  // The watched service's own day words, so an answer names Wednesday and "the Wednesday page" (review H4). What only this
  // Mac knows (a part of the check's plain reasons) is put in after the restore.
  const composed = composeAnswer(outcome.answer ?? "", outcome.evidence, harness.data.brief?.day ?? null, harness.tools);
  const mode = harness.data.mode;
  return {
    body: composed.paragraphs.map(p => composed.fill(harness.restore(p, { sender }))).join("\n\n"),
    draft: composed.draft ? harness.restore(composed.draft, { sender, firstNames: true }) : null,
    notCovered: composed.kind === "not-covered" || outcome.evidence.length === 0,
    basedOn: basedOnEvidence([...outcome.evidence, ...rowSources(harness, outcome)], mode),
    gaps: evidenceGaps([...outcome.evidence, ...rowSources(harness, outcome)], mode),
    procedure: procedure ? { title: procedure.title, body: procedure.body } : null,
    steps: outcomeSteps(outcome.events, outcome.evidence, mode),
    aiSteps: modelSteps(outcome.events),
    end: composed.kind,
    page: outcome.evidence.some((e: ToolEnvelope) => e.tool === "today.attention") ? "today" : "sunday",
  };
}

/**
 * A job's verified run as its write-up is kept on this Mac (responsibility-runner.ts WriteUp): Ozzie's own sentence for
 * each fact the AI chose, in Ozzie's order, with each person kept as their id token rather than their name
 * (Harness.keep), where the facts came from and when, what wasn't complete, and what it looked at.
 */
export function keptWriteup(harness: Harness, outcome: TaskOutcome): { lines: string[]; based_on: string; gaps: string[]; steps: string[] } {
  const composed = composeAnswer(outcome.answer ?? "", outcome.evidence, harness.data.brief?.day ?? null, harness.tools);
  const mode = harness.data.mode;
  return {
    lines: composed.paragraphs.map(p => composed.fill(harness.keep(p))), based_on: basedOnEvidence([...outcome.evidence, ...rowSources(harness, outcome)], mode),
    gaps: evidenceGaps([...outcome.evidence, ...rowSources(harness, outcome)], mode), steps: outcomeSteps(outcome.events, outcome.evidence, mode),
  };
}

// ---- "Ask Ozzie to look at who could help" (audit item 9) -----------------------------------------------------------

/** The procedure a Sunday card's "Ask Ozzie to look at who could help" runs. */
export const WHO_COULD_HELP = "who-could-help";
/** The closed labels of the Sunday card's own list (sunday-page.tsx PeopleList), in its order, by the tools' status words. */
export const PEOPLE_LABELS = Object.freeze({
  "no overlap found": "No overlap found", "possible conflict": "Possible conflict", "availability needs confirmation": "Availability needs confirmation", "left out": "Left out",
} as const);
export type PeopleLabel = (typeof PEOPLE_LABELS)[keyof typeof PEOPLE_LABELS];
/**
 * What the AI's look at who could help adds to the fixed list (review G, M-1, N3, N4): Ozzie's lines for facts it chose
 * about the role, nothing, that it couldn't tell, or that it asked for a note. `looked`: it asked for this role's list of
 * people (the tool answered with them; a call for another role lists no one here, so it isn't this). `shortened`: how many people its copy of the list left out to fit what the AI may read.
 * The people the card shows are never from here: they are the finding's own, as the fixed list shows them.
 */
export type LookKind = "lines" | "nothing" | "not-covered" | "draft";
export interface Look { kind: LookKind; looked: boolean; shortened: number }
/** Said under the people on the AI's card (review H, M3: never a pick, never a ranking). "Here": those left out are folded (review K, L2). */
export const LOOK_NOTE = "Everyone the check listed is here, grouped as on the list above and alphabetical within each group; the order within a group says nothing about anyone, and whether someone is willing is theirs to say.";
/** Never "the same list": the AI's copy may be shortened, and the card says so beside this (review K, L4). */
export const LOOK_NOTHING = "The AI looked at the list of people and had nothing to add.";
/** `looked` false: the AI may still have asked for another role's list, which lists no one here (review K, L1). */
export const LOOK_NOT_LOOKED = "The AI didn't look at this role's list of people and had nothing to add.";
export const LOOK_NOT_COVERED = "The AI couldn't tell more than the list above shows.";
export const LOOK_DRAFT = "The AI asked for a note, which isn't prepared here. Use Prepare a note on a person's row above.";
/** The AI's copy of a big team's list is cut to fit what it may read (core tools.ts fit); the card's list never is. */
export const lookShortened = (n: number) => `The AI looked at a shortened list: it wasn't given ${n === 1 ? "1 of the people" : `${n} of the people`} Ozzie's check listed.`;

/**
 * What the procedure reads for one open role: the check as it is, with only the card's own finding in the brief (review
 * H, M2: the same role at another service time is another card), so the procedure (which looks at "the roles that still
 * need people") looks at that role at that time and no other. Deterministic code chooses what is read; the AI only
 * chooses among it. Nothing else changes.
 */
export function oneRole(data: HarnessData, finding: Finding): HarnessData {
  return { ...data, brief: data.brief ? { ...data.brief, findings: data.brief.findings.filter(f => f.id === finding.id) } : null };
}

/**
 * What the who-could-help procedure reads on a second or later watched service's card (owner decision 2026-11-19): that
 * service's own check, brief and decisions alone, as a church watching only that service would have them, never the
 * check every service is joined in (services-merge.ts). So the look is about that service's role even when another
 * service has a role of the same name with the same people (each service type's teams are its own, and ids can repeat
 * across plans), its times and day are that service's, its reads, check time and completeness are that service's own, and
 * nothing of another service, its name included, is read: a request for it is built exactly as for a church with one
 * service. No rooms, follow-ups or group meetings (that card's service has none shown), and nothing to check again from
 * here (the procedure lists no such step; a check of every service is Check now's). lookAtWhoCouldHelp then keeps the
 * card's own finding (oneRole), as for the first service, whose look is unchanged.
 */
export function otherServiceData(part: { capture: SundayCapture; brief: SundayBrief; decisions: readonly SundayDecision[] },
  app: Pick<AppSnapshot, "rules" | "status" | "configured" | "now">): HarnessData {
  return buildHarnessData({ capture: part.capture, fictional: false, rules: app.rules, decisions: part.decisions, status: app.status, configured: app.configured,
    now: app.now, brief: part.brief, operations: null, fictionalImport: false });
}

/**
 * The who-could-help procedure, run through the harness for one open role at one time (`make` builds the app's harness
 * over the data it is given). The card never presents some people as the AI's pick (review H, M3): it lists everyone the
 * check listed for that finding, as the fixed list shows them (alphabetical within the same closed labels), and marks
 * no one; what the AI adds is Ozzie's own lines for the facts it chose about the role. An answer that isn't a list of
 * facts says one plain line (L4). No draft is ever shown here: the procedure drafts only when asked, and nobody asks
 * from this card, so a draft the AI asked for is dropped (the pinned procedure is unchanged). Failures are this card's
 * own words (L11).
 */
export async function lookAtWhoCouldHelp(make: (data: HarnessData) => Harness, data: HarnessData, finding: Finding, options: {
  signal?: AbortSignal; recorder?: LedgerRecorder | null; skills: ReadonlyMap<string, Skill>; sender?: string; notes?: StepNotes;
}): Promise<AskTurn> {
  const h = make(oneRole(data, finding));
  const observer = options.recorder?.task("skill", WHO_COULD_HELP, "who-could-help");
  const outcome = await h.runSkill(WHO_COULD_HELP, { ...(options.signal ? { signal: options.signal } : {}), ...(observer ? { onEvent: observer.onEvent } : {}) });
  const task = outcome.events[0]?.task_id ?? "";
  (options.notes ?? stepNotes).take(task);
  if (outcome.status === "cancelled") return { state: "cancelled", text: LOOK_STOPPED };
  const parsed = outcome.status === "verified" && outcome.answer ? parseAnswer(outcome.answer) : null;
  if (!parsed) return outcome.code === "no-model" ? { state: "no-model" } : { state: "problem", code: outcome.code, text: LOOK_FAILED };
  const shown = shownAnswer(h, outcome, options.skills.get(WHO_COULD_HELP), options.sender ?? "");
  if (shown.end) options.recorder?.ended(task, shown.end);
  // The tool's answers: whether the AI asked for this role's list of people, and the newest one that listed them (review G,
  // M3g) for how much its copy was cut. The people the card shows come from the finding, never from these (M-1).
  type Listed = { fact?: string }[];
  const peopleIn = (e: ToolEnvelope) => (((e.payload as { people?: unknown } | null)?.people ?? []) as Listed);
  const cutIn = (e: ToolEnvelope) => Number((e.payload as { left_out_for_length?: unknown } | null)?.left_out_for_length) || 0;
  const results = outcome.evidence.filter(e => e.tool === "sunday.who_could_help");
  const listed = [...results].reverse().find(e => peopleIn(e).length > 0);
  const look: Look = { kind: "nothing", looked: Boolean(listed), shortened: listed ? cutIn(listed) : 0 };
  // What the AI adds: Ozzie's lines for the facts it chose about the role, never about one person.
  const personFacts = new Set(results.flatMap(e => peopleIn(e).flatMap(p => p.fact ? [p.fact] : [])));
  const roleFacts = parsed.facts.filter(id => !personFacts.has(id));
  const own = parsed.answer === "facts" && roleFacts.length ? composeAnswer(answerText({ ...parsed, facts: roleFacts }), outcome.evidence, h.data.brief?.day ?? null, h.tools) : null;
  const lines = own ? own.paragraphs.map(p => own.fill(h.restore(p))) : [];
  look.kind = parsed.answer === "draft" ? "draft" : parsed.answer === "not-covered" ? "not-covered" : lines.length ? "lines" : "nothing";
  // A list cut to fit isn't a read that couldn't be finished: the card says it was shortened instead (review G, M-1).
  const cut = results.filter(e => cutIn(e) > 0 && e.completeness === "partial").length;
  const whole = outcome.evidence.map(e => e.tool === "sunday.who_could_help" && cutIn(e) > 0 && e.completeness === "partial" ? { ...e, completeness: "complete" as const } : e);
  const partialSteps = outcome.events.filter(e => e.type === "tool" && e.detail === "sunday.who_could_help:partial").length;
  const steps = shown.steps
    // A note the AI asked for is said once, in the card's own line (N4); the drafting step isn't repeated.
    .filter(t => !/draft note/u.test(t))
    .map(t => cut > 0 && cut === partialSteps && t === `${TOOL_PHRASES["sunday.who_could_help"]} — ${STATUS_WORDS.partial}` ? `${TOOL_PHRASES["sunday.who_could_help"]} — a shortened list` : t);
  return { state: "answered", answer: { ...shown, draft: null, steps, gaps: evidenceGaps(whole, h.data.mode), body: lines.join("\n\n"), look } };
}
export const LOOK_FAILED = "Ozzie couldn't finish looking at who could help. The list above is unchanged.";
export const LOOK_STOPPED = "You stopped Ozzie looking at who could help. The list above is unchanged.";

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
 * A decision question's answer written by Ozzie itself, after the AI's answer chose more facts than Ozzie checks in one
 * answer (native `too-many-facts`): the newest overview the task read, said as an answer choosing only its summary fact
 * would be (its counts), then every open decision on the service's page in the page's own order (`decisionsLeftOut`:
 * findings that need a decision, background checks kept on this Mac, room overlaps and follow-ups without an owner),
 * written here from the same check. Deterministic, never the AI's ids, never ranking anyone. Null when the task read no
 * overview. `scope`: the services the question named (Harness.scope): only their decisions.
 */
export async function overviewAnswer(harness: Harness, outcome: TaskOutcome, signal: AbortSignal, scope: readonly string[] = []): Promise<{ answer: ShownAnswer; evidence: ToolEnvelope[] } | null> {
  const overview = [...outcome.evidence].reverse().find(e => e.tool === "sunday.overview");
  const fact = (overview?.payload as { fact?: unknown } | null | undefined)?.fact;
  if (!overview || typeof fact !== "string") return null;
  const day = harness.data.brief?.day ?? null;
  const summary = answerText({ answer: "facts", facts: [fact], draft: null });
  const counts = composeAnswer(summary, [overview], day).paragraphs;
  // Nothing open is said for the services the question named, never for the whole check (review B, F5).
  const left = await decisionsLeftOut(harness.tools, summary, [overview], signal,
    { head: onPage(day ?? SUNDAY_WORDS), none: scope.length ? nothingOpenAt(scope.map(s => harness.session.service(s))) : NOTHING_OPEN }, scope);
  const mode = harness.data.mode;
  const evidence = [overview, ...left.evidence];
  return { evidence: left.evidence, answer: {
    body: [...counts.map(p => harness.restore(p)), ...left.paragraphs.map(p => left.fill(harness.restore(p)))].join("\n\n"),
    draft: null, notCovered: false,
    basedOn: basedOnEvidence([...evidence, ...left.sources], mode),
    gaps: [...new Set([...evidenceGaps(evidence, mode), ...systemGaps(harness.data, evidence)])],
    procedure: null,
    // What the AI's task looked at, then what Ozzie read on this Mac to write the answer, each once.
    steps: [...new Set([...outcomeSteps(outcome.events, outcome.evidence, mode), ...localSteps(left.evidence, left.sources.some(s => s.source === "Planning Center People"))])],
    aiSteps: modelSteps(outcome.events),
    page: "sunday",
    composedHere: true,
  } };
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
  /** When Ozzie's AI's pause ends, from its account (model.ts `pausedWhen`): said instead of "try again in a minute". */
  pausedWhen?: string | null;
  /** The AI is a model on this Mac (model status `route` "local"): an answer that couldn't be backed up says so plainly. */
  local?: boolean;
}): Promise<AskTurn> {
  const signal = options.signal ?? new AbortController().signal;
  const here = async (work: () => Promise<LocalAnswer>, first: string[] = []): Promise<AskTurn> => {
    const local = await work();
    if (signal.aborted) return { state: "cancelled", text: askFailureText("cancelled") };
    options.recorder?.answeredHere(local.evidence);
    return { state: "answered", answer: localAnswer(harness, local, first) };
  };
  /**
   * A question or note stopped by the background-check wording list (owner decision 2026-11-14): answered here from the
   * Sunday page under a first line that says why (review B2 L-3), with the kids-team note when no kids team is marked,
   * since that is why there are no background checks to show (review B3 L-2). Wording that also names other things and
   * nothing about checks or kids ("Who is on the Safe Sanctuaries team?") gets the plain refusal and what to do instead,
   * with nothing beside it that could read as an answer (reviews B2 L-3, B3 N-2); so does anything with nothing to show.
   * Nothing is sent either way.
   */
  const keptHere = async (work: () => Promise<LocalAnswer>, first: string, alone: string): Promise<AskTurn> => {
    if (!asksAboutChecksOrKids(typed)) return { state: "refused", text: alone };
    const local = await work();
    if (signal.aborted) return { state: "cancelled", text: askFailureText("cancelled") };
    if (!local.paragraphs.length) return { state: "refused", text: alone };
    options.recorder?.answeredHere(local.evidence);
    return { state: "answered", answer: localAnswer(harness, local, [first]) };
  };
  // The same refusals first, so nothing is answered here that couldn't be asked.
  const prepared = harness.prepare(typed);
  if (!prepared.ok) {
    // A question naming a background check is never prepared for the AI (review Q H2): it is answered here instead, and
    // the answer says so first.
    if (prepared.refusal === REFUSALS.backgroundNote) {
      return keptHere(() => kidsAnswer(harness.tools, backgroundOnly(harness.data), signal), REFUSALS.backgroundNote, REFUSALS.backgroundNoteAlone);
    }
    if (prepared.refusal === REFUSALS.background) {
      const q = kidsQuestion(typed, harness.data);
      if (q && !q.whole) return keptHere(() => kidsAnswer(harness.tools, q, signal), BACKGROUND_HERE, REFUSALS.background);
      return keptHere(() => openDecisions(harness.tools, signal), BACKGROUND_HERE, REFUSALS.background);
    }
    return { state: "refused", text: prepared.refusal };
  }
  // On a church system that ties no team to its roles (Breeze), who could help, who is scheduled, who hasn't answered,
  // and a note to someone who hasn't: answered here from who is on each role, nothing sent (round 5). Before the kids
  // answer: Breeze has no teams to mark as kids teams, so that answer would be a dead end there (review of round 5, L6).
  // A question naming a watched service goes to the AI with that service's label, whose lookups keep to it: the answers
  // written here without the AI don't (review A, L4).
  const named = prepared.asked.services.size > 0;
  const roster = named ? null : rosterQuestion(typed, harness.data);
  if (roster?.kind === "note") {
    const note = await rosterNote(harness.tools, roster, typed, signal);
    if (signal.aborted) return { state: "cancelled", text: askFailureText("cancelled") };
    options.recorder?.answeredHere(note.local.evidence);
    const shown = localAnswer(harness, note.local);
    const brief = harness.data.brief;
    return { state: "answered", answer: note.finding && brief
      ? { ...shown, draft: restoreReminder(reminderDraft(note.finding, brief.plan.date, brief.time_zone && isTimeZone(brief.time_zone) ? brief.time_zone : null), note.finding, harness.data.capture?.names ?? {}, options.sender ?? "") }
      : shown };
  }
  if (roster) { const asked = { kind: roster.kind, roles: roster.roles }; return here(() => rosterAnswer(harness.tools, asked, signal)); }
  const kids = named ? null : kidsQuestion(typed, harness.data);
  if (kids) return here(() => kidsAnswer(harness.tools, kids, signal));
  const observer = options.recorder?.task("ask", ASK_SKILL);
  const result = await harness.ask(typed, { ...(options.signal ? { signal: options.signal } : {}), ...(observer ? { onEvent: observer.onEvent } : {}) });
  if (!result.ok) return { state: "refused", text: result.refusal };
  const { outcome } = result;
  const native = (options.notes ?? stepNotes).take(result.task.id);
  if (outcome.status === "verified" && outcome.answer) {
    const shown = shownAnswer(harness, outcome, options.skills.get(ASK_SKILL), options.sender ?? "");
    if (shown.end) options.recorder?.ended(result.task.id, shown.end);
    // No silent omission: the open decisions the answer left out, in fixed words, with their sources.
    // A question naming a watched service: only that service's decisions (its task's scope, tools.ts).
    const left = isDecisionQuestion(typed) && !signal.aborted ? await decisionsLeftOut(harness.tools, outcome.answer, outcome.evidence, signal, undefined, harness.scope(result.task)) : null;
    const added = left !== null && left.paragraphs.length > 0;
    // "Nothing in this check needs a decision" counts only what the AI read; it is never said above decisions added here.
    const own = shown.body.split("\n\n").filter(p => p && !(added && isNothingToDecide(p)));
    // What Ozzie can do instead, for the system the church uses: never what it just said it can't (round 5); "the services
    // it watches" while more than one is.
    const body = [...own, ...(added ? left.paragraphs.map(p => left.fill(harness.restore(p))) : []), ...(shown.notCovered && !added ? [canDoFor(harness.data) ?? canDoInstead(harness.data.brief?.day)] : [])].join("\n\n");
    const mode = harness.data.mode;
    // How many people a role needs is said under an answer about coverage, and under any answer that says nothing needs
    // a decision (round 5: it led a "who could cover" one; review of round 5, H1: never "nothing needs a decision" alone).
    const coverage = asksAboutCoverage(typed) || own.some(isNothingToDecide) ? systemGaps(harness.data, outcome.evidence) : [];
    return { state: "answered", answer: {
      ...shown, body, ...(coverage.length ? { gaps: [...new Set([...shown.gaps, ...coverage])] } : {}),
      ...(added ? {
        added: true, basedOn: basedOnEvidence([...outcome.evidence, ...rowSources(harness, outcome), ...left.evidence, ...left.sources], mode),
        gaps: [...new Set([...shown.gaps, ...evidenceGaps(left.evidence, mode), ...coverage])],
        // What Ozzie read on this Mac for them, after the AI's own steps, each once.
        steps: [...new Set([...shown.steps, ...localSteps(left.evidence, left.sources.some(s => s.source === "Planning Center People"))])],
      } : {}),
    } };
  }
  if (outcome.status === "cancelled") return { state: "cancelled", text: askFailureText("cancelled") };
  // AI on this Mac chose more facts than an answer holds for a decision question (measured 2026-11-18: a larger church's
  // overview, 27 ids): Ozzie writes the answer itself from the overview the task read, and says so. Only then.
  if (options.local && native === "too-many-facts" && outcome.code === "fidelity" && isDecisionQuestion(typed)) {
    const own = await overviewAnswer(harness, outcome, signal, harness.scope(result.task));
    if (signal.aborted) return { state: "cancelled", text: askFailureText("cancelled") };
    if (own) {
      options.recorder?.answeredHere(own.evidence);
      return { state: "answered", answer: own.answer };
    }
  }
  // The second (native) or third (ozzie.church) refusal of background-check wording: the page's own words, as a refusal.
  if (native === "background-check") return { state: "refused", text: askFailureText(outcome.code, native) };
  if (outcome.code === "no-model") return { state: "no-model" };
  const text = askFailureText(outcome.code, native, options.pausedWhen ?? null);
  // AI on this Mac misses more often than an AI company's (measured 2026-11-18): it says so, and what helps.
  return { state: "problem", code: outcome.code, text: options.local && (text === ASK_FAILURES.fidelity || text === ASK_FAILURES.tooMany) ? `${text} ${ASK_FAILURES.fidelityHere}` : text };
}
