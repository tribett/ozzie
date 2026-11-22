// The harness, wired (harness plan H2): tools over the last check, the broker-backed host, the
// skills, the instructions, verification and a replaceable loop (TsLoop or PiLoop). What the app
// uses to run Ask and the procedures as agent tasks.
//
// A person's question goes through the Ask placeholder boundary first (prepareAsk: this plan's
// positions become [Role N] labels before any name is looked for, then roster names become person
// labels while room, follow-up and imported event names are kept whole; contact details, written-out
// email addresses, religious requests, requests to contact people or change records, and ranking are
// refused), and then those place names become their labels too. Only that placeholder form
// becomes the task. Names follow the "capitalized only" rule (names.ts). Every task is checked again
// before the loop sees it: an ask whose question still holds a roster name, a position, room,
// follow-up or event name as typed, or a contact detail fails as "egress" before any model step.
// Ask tasks are only made by ask(); run() still checks any task it is handed.
import { buildAskContext, hasContactDetailStrict, MAX_SENT_QUESTION_CHARS, prepareAsk, REFUSALS, TEAM_MEMBER, type AskedQuestion } from "../ask.js";
import { fold } from "../draft-request.js";
import type { AgentRuntime, AgentTask, FailureCode, ModelStep, RunOptions, RuntimeDeps, Skill, TaskOutcome } from "./contract.js";
import { HarnessHost } from "./host.js";
import { instructionsFor } from "./instructions.js";
import { DEFAULT_NAME_MODE, nameOptions, namedIn, type NameMode } from "./names.js";
import { BRACKETED, HarnessSession, keptNames, restoreLabels } from "./session.js";
import { ASK_SKILL } from "./skills.js";
import { HarnessTools, type HarnessData } from "./tools.js";
import { verifier } from "./verify.js";

export type { HarnessData } from "./tools.js";
export type { NameMode } from "./names.js";
export { ASK_SKILL } from "./skills.js";
/** What happened: runtime events in the native ledger's grammar (review A6). */
export { ledgerDetail, ledgerDetailOk } from "./ledger-events.js";
/** The answer, written on this Mac from the facts the model chose (structured answers). */
export { composeAnswer, type ComposedAnswer } from "./compose.js";

export type AgentQuestion = { ok: true; question: string; asked: AskedQuestion } | { ok: false; refusal: string };

/** Every position name of this plan: its scheduled positions, the findings, the lead rules and the people serving this Sunday. Local only. */
function positionNames(data: HarnessData): string[] {
  const out = new Set<string>();
  const add = (v: unknown) => { if (typeof v === "string" && v.trim()) out.add(v.trim()); };
  for (const p of data.brief?.positions ?? []) add(p.name);
  for (const f of data.brief?.findings ?? []) add(f.position?.name);
  for (const l of data.rules.sundayLeads) add(l.lead_position);
  for (const m of data.operations?.group_meetings ?? []) for (const s of m.serving) add(s.position);
  return [...out];
}
type Place = { kind: "room" | "workflow" | "step" | "event"; id: string; name: string };
/** Room, follow-up workflow and step names this check read, and the imported event titles. Local only. */
function placeNames(data: HarnessData): Place[] {
  const out = new Map<string, Place>();
  const labels = { ...(data.capture?.labels ?? {}), ...(data.operations?.labels ?? {}) };
  for (const [key, name] of Object.entries(labels)) {
    const m = /^(room|workflow|step):?(.+)$/u.exec(key);
    if (m && typeof name === "string" && name.trim()) out.set(`${m[1]}\u0000${m[2]}`, { kind: m[1] as Place["kind"], id: m[2]!, name: name.trim() });
  }
  for (const s of data.attention?.sources ?? []) if ("title" in s && s.title.trim()) out.set(`event\u0000${s.id}`, { kind: "event", id: s.id, name: s.title.trim() });
  return [...out.values()];
}
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
/** Whole phrases, any case, any run of spaces between words, never inside a word. `folded`: phrases in folded form, for folded text. */
const phrases = (list: readonly string[], folded = false) => list.length
  ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${[...list].sort((a, b) => b.length - a.length)
    .map(n => escape(folded ? fold(n) : n.normalize("NFKC")).replace(/\s+/gu, "\\s+")).join("|")})(?![\\p{L}\\p{N}])`, "giu")
  : null;
const key = (s: string) => s.normalize("NFKC").toLocaleLowerCase("en").replace(/\s+/gu, " ");

/**
 * Room, follow-up and event names still in the question become their labels (review B-S5). Existing labels
 * are left alone and a label never touches a letter; this only ever replaces words, so prepareAsk's refusals still hold.
 */
function labelPlaces(sent: string, session: HarnessSession, data: HarnessData): string {
  const places = placeNames(data);
  const re = phrases(places.map(p => p.name));
  if (!re) return sent;
  const byKey = new Map(places.map(p => [key(p.name), p]));
  return sent.split(/(\[[^\]\n]{0,80}\])/u).map((part, i) => i % 2 ? part : part.replace(re, (m: string, offset: number) => {
    const p = byKey.get(key(m));
    if (!p) return m;
    const label = session[p.kind](p.id);
    const before = part[offset - 1], after = part[offset + m.length];
    return `${before && /[\p{L}\p{N}]/u.test(before) ? " " : ""}${label}${after && /[\p{L}\p{N}]/u.test(after) ? " " : ""}`;
  })).join("");
}

/** The leader's typed question in placeholder form, through the same boundary as Ask. Refusals send nothing. */
export function prepareAgentQuestion(session: HarnessSession, data: HarnessData, typed: string, mode: NameMode = DEFAULT_NAME_MODE): AgentQuestion {
  const { brief, capture } = data;
  if (!brief || !capture) return { ok: false, refusal: REFUSALS.nothing };
  const context = buildAskContext(session.ask, {
    brief, names: capture.names, organization: capture.organization, decisions: data.decisions,
    attention: data.mode === "fictional" ? data.attention : null,
  });
  if (!context) return { ok: false, refusal: REFUSALS.nothing };
  // This plan's positions are labelled before any name is looked for (review B-S6), by name as Ask labels them.
  const roles = new Map(positionNames(data).map(name => [session.role(name), name]));
  // Room, follow-up and event names are kept whole while names are replaced, then labelled (review C5: "Thornbury Hall").
  const prepared = prepareAsk(session.ask, context, typed, { roles, protect: placeNames(data).map(p => p.name), ...nameOptions(mode) });
  if (!prepared.ok) return prepared;
  session.record(prepared.asked, capture.organization);
  return { ok: true, question: labelPlaces(prepared.asked.sent, session, data), asked: prepared.asked };
}

export interface HarnessOptions {
  workspace_id: string;
  data: HarnessData;
  skills: ReadonlyMap<string, Skill>;
  runtime: AgentRuntime;
  /** Production: the native `agent_step` command. Tests: a scripted model. */
  model: ModelStep;
  session?: HarnessSession;
  /** The Planning Center service types this workspace reads (HostOptions.serviceTypes). */
  serviceTypes?: readonly string[];
  /** How names are matched in questions and answers (names.ts). Defaults to the owner's "capitalized only" rule. */
  nameMode?: NameMode;
  /** This Mac's zone, for the times in an answer that say when Ozzie checked (session.ts CHECK_TIME). Defaults to this Mac's own. */
  macZone?: string;
  now?: () => string;
  newId?: () => string;
}
export type AskResult = { ok: false; refusal: string } | { ok: true; task: AgentTask; asked: AskedQuestion; outcome: TaskOutcome };

export class Harness {
  readonly session: HarnessSession;
  readonly tools: HarnessTools;
  readonly host: HarnessHost;
  readonly deps: RuntimeDeps;
  readonly nameMode: NameMode;
  readonly #workspace: string;
  readonly #skills: ReadonlyMap<string, Skill>;
  readonly #runtime: AgentRuntime;
  readonly #now: () => string;
  readonly #newId: () => string;
  readonly #macZone: string | undefined;

  constructor(options: HarnessOptions) {
    this.#workspace = options.workspace_id;
    this.#skills = options.skills;
    this.#runtime = options.runtime;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#newId = options.newId ?? (() => globalThis.crypto.randomUUID());
    this.nameMode = options.nameMode ?? DEFAULT_NAME_MODE;
    this.#macZone = options.macZone;
    this.session = options.session ?? new HarnessSession();
    this.tools = new HarnessTools(options.data, this.session, { now: this.#now });
    this.host = new HarnessHost({ workspace_id: options.workspace_id, tools: this.tools, skills: options.skills,
      ...(options.serviceTypes ? { serviceTypes: options.serviceTypes } : {}) });
    this.deps = Object.freeze({
      tools: this.host, model: options.model, instructions: instructionsFor(options.skills),
      verify: verifier, now: this.#now,
    });
  }

  get data(): HarnessData { return this.tools.data; }
  /** The app's newest check. */
  update(data: HarnessData): void { this.tools.update(data); }

  prepare(typed: string): AgentQuestion { return prepareAgentQuestion(this.session, this.tools.data, typed, this.nameMode); }
  #task(kind: AgentTask["kind"], skill_id: string, question?: string): AgentTask {
    return { id: this.#newId(), kind, skill_id, ...(question !== undefined ? { question } : {}), workspace_id: this.#workspace, created_at: this.#now() };
  }
  skillTask(skill_id: string): AgentTask { return this.#task("skill", skill_id); }

  /** Why a task can't be handed to the loop, or null. Unknown kinds are left to the loop, which fails them the same way. */
  check(task: AgentTask): FailureCode | null {
    if (task.workspace_id !== this.#workspace) return "invalid-task";
    if (task.kind === "ask") {
      if (task.skill_id !== ASK_SKILL || typeof task.question !== "string" || task.question.length > MAX_SENT_QUESTION_CHARS) return "invalid-task";
      const data = this.tools.data;
      const q = task.question;
      if (namedIn(q, data.capture?.names ?? {}, this.nameMode) || hasContactDetailStrict(q) || hasContactDetailStrict(q.normalize("NFKC"))) return "egress";
      // A position, room, follow-up or event name as typed (review B-S7), outside the labels.
      const unlabelled = q.replace(BRACKETED, " ");
      for (const re of [phrases(positionNames(data), true), phrases(placeNames(data).map(p => p.name), true)]) if (re && re.test(fold(unlabelled))) return "egress";
      for (const m of q.matchAll(BRACKETED)) if (!this.session.has(m[0]) && m[0] !== TEAM_MEMBER) return "invalid-task";
    }
    if (task.kind === "skill" && (task.skill_id === ASK_SKILL || !this.#skills.has(task.skill_id) || task.question !== undefined)) return "invalid-task";
    return null;
  }

  async run(task: AgentTask, options: RunOptions = {}): Promise<TaskOutcome> {
    const refused = this.check(task);
    if (refused) {
      const event = { task_id: task.id, sequence: 1, at: this.#now(), type: "failed" as const, detail: refused };
      try { options.onEvent?.(event); } catch { /* metadata only */ }
      return { status: "failed", code: refused, answer: null, evidence: [], events: [event] };
    }
    return this.#runtime.run(task, this.deps, options);
  }

  /** Ask Ozzie as an agent task. A refusal sends nothing and runs nothing. */
  async ask(typed: string, options: RunOptions = {}): Promise<AskResult> {
    const prepared = this.prepare(typed);
    if (!prepared.ok) return prepared;
    const task = this.#task("ask", ASK_SKILL, prepared.question);
    return { ok: true, task, asked: prepared.asked, outcome: await this.run(task, options) };
  }

  runSkill(skill_id: string, options: RunOptions = {}): Promise<TaskOutcome> { return this.run(this.skillTask(skill_id), options); }

  /**
   * On this Mac only: a verified answer's labels back to names and places, and its ISO times in plain words in the church's
   * zone; a time that says when Ozzie checked (session.ts CHECK_TIME) on this Mac's clock.
   */
  restore(text: string, options: { sender?: string; firstNames?: boolean } = {}): string {
    return this.#restore(text, this.tools.data.capture?.names ?? {}, options);
  }
  /**
   * As restore, but each person is kept as their id token (session.ts PERSON_TOKEN), never their name: the form a
   * write-up is kept in on this Mac, filled in with names only when shown (fillPeople).
   */
  keep(text: string): string { return this.#restore(text, keptNames(this.tools.data.capture?.names ?? {})); }
  #restore(text: string, names: Readonly<Record<string, string>>, options: { sender?: string; firstNames?: boolean } = {}): string {
    const { capture, operations, attention, brief, serviceOfTeam } = this.tools.data;
    const events = Object.fromEntries((attention?.sources ?? []).flatMap(s => "title" in s ? [[s.id, s.title]] : []));
    // Several services watched: a role is said with its service, by its team, or by its name when only one service has it.
    const roleService = serviceOfTeam ? (name: string, team?: string): string | null => {
      if (team !== undefined) return Object.hasOwn(serviceOfTeam, team) ? serviceOfTeam[team]! : null;
      const services = new Set((brief?.positions ?? []).filter(p => p.name.trim() === name && Object.hasOwn(serviceOfTeam, p.team_id)).map(p => serviceOfTeam[p.team_id]!));
      return services.size === 1 ? [...services][0]! : null;
    } : undefined;
    return restoreLabels(text, this.session, {
      ...(roleService ? { roleService } : {}),
      names, places: { ...(capture?.labels ?? {}), ...(operations?.labels ?? {}) }, events,
      ...(capture ? { organization: capture.organization } : {}), timeZone: brief?.time_zone ?? null, macZone: this.#macZone ?? null,
      ...(options.sender !== undefined ? { sender: options.sender } : {}), ...(options.firstNames ? { firstNames: true } : {}),
    });
  }
}
