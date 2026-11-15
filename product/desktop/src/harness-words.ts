// Plain English for what Ozzie did: the tools it used, how complete each read was, why a task
// stopped, where an answer came from, and the lines What happened shows. Fixed local words only;
// nothing here comes from a model, a provider or Planning Center text. Product language rules
// (AGENTS.md): no "skill", "agent", "session", "log", "connector" or "harness" on any user surface.
import type { FailureCode, Skill, TaskEvent, ToolEnvelope, ToolName } from "../../../core/src/harness/contract.js";
import { NATIVE_TOOL_ALLOWLIST } from "../../../core/src/harness/contract.js";
import type { SundayBrief } from "../../../core/src/sunday-brief.js";

/** One task as the native ledger lists it (ledger.rs TaskRow). Name-free by construction. */
export interface TaskEventRow { task_id: string; sequence: number; at: string; type: TaskEvent["type"]; detail: string }
export interface TaskRow {
  task_id: string; kind: "ask" | "skill" | "check"; skill_id: string; skill_hash: string;
  state: "proposed" | "admitted" | "running" | "verified" | "failed" | "cancelled";
  created_at: string; updated_at: string; failure: FailureCode | null; events: TaskEventRow[];
}

const ALLOWLIST: ReadonlySet<string> = new Set(NATIVE_TOOL_ALLOWLIST);
const COMPLETENESS: ReadonlySet<string> = new Set(["complete", "partial", "stale", "denied"]);
const FAILURES: ReadonlySet<string> = new Set<FailureCode>(["denied", "stale", "partial", "provider-failure", "unverified", "invalid-task", "limit",
  "timeout", "cancelled", "egress", "fidelity", "transport", "no-model", "interrupted"]);

/**
 * A runtime event detail in the native ledger grammar (ledger.rs `detail_ok`), or null when the event
 * isn't one the ledger takes. tool "sunday.open_needs:complete" → "sunday.open_needs complete"; a name
 * outside the allowlist ("unknown:denied") is never written, only its status ("denied"). model "step 2"
 * → "2", or "2 tool_calls" with an outcome. Lifecycle events carry no detail except a failure code.
 */
export function ledgerDetail(type: TaskEvent["type"], detail: string, outcome?: string | null): string | null {
  if (type === "tool") {
    const m = /^([a-z_.]+):([a-z-]+)$/u.exec(detail);
    if (!m) return null;
    const [, name, status] = m as unknown as [string, string, string];
    if (!COMPLETENESS.has(status) && !FAILURES.has(status)) return null;
    return ALLOWLIST.has(name) ? `${name} ${status}` : status;
  }
  if (type === "model") {
    const m = /^step ([1-9]\d?)$/u.exec(detail);
    if (!m) return null;
    return outcome && (["stop", "tool_calls", "length"].includes(outcome) || FAILURES.has(outcome)) ? `${m[1]} ${outcome}` : m[1]!;
  }
  if (type === "failed") return FAILURES.has(detail) ? detail : null;
  if (type === "cancelled") return "";
  return detail === "" ? "" : null;
}

// ---- Tools and statuses ------------------------------------------------------------------------

export const TOOL_PHRASES: Readonly<Record<ToolName, string>> = Object.freeze({
  "sunday.overview": "Looked at this Sunday's overview",
  "sunday.open_needs": "Looked at Sunday's open roles",
  "sunday.who_could_help": "Looked at who on the team could help",
  "sunday.pending_requests": "Looked at pending requests",
  "sunday.rule_checkins": "Looked at the check-ins your Church rules suggest",
  "sunday.not_checked": "Looked at what wasn't checked",
  "rooms.conflicts": "Looked at room bookings",
  "followups.unowned": "Looked at follow-ups without an owner",
  "groups.clashes": "Looked at group meetings",
  "today.attention": "Looked at the fictional email and calendar import",
  "rules.current": "Looked at your Church rules",
  "planning_center.refresh": "Checked Planning Center again",
  "drafts.prepare_note": "Prepared a draft note",
});
/** How complete one read was, or why it couldn't be used. */
export const STATUS_WORDS: Readonly<Record<string, string>> = Object.freeze({
  complete: "complete",
  partial: "part of this couldn't be read",
  stale: "from a saved check",
  denied: "not shared with Ozzie",
  "provider-failure": "couldn't be read just now",
  unverified: "couldn't be confirmed",
});

/** Why a task stopped, finishing the sentence "Couldn't finish: …". */
export const FAILURE_REASONS: Readonly<Record<FailureCode, string>> = Object.freeze({
  denied: "Planning Center access wasn't available",
  stale: "what Ozzie had was out of date",
  partial: "part of it couldn't be read",
  "provider-failure": "Planning Center couldn't be reached",
  unverified: "something couldn't be confirmed",
  "invalid-task": "it wasn't in a form Ozzie can run",
  limit: "it reached a limit Ozzie sets on AI help",
  timeout: "it took too long",
  cancelled: "you stopped it",
  egress: "it would have sent details Ozzie keeps on this Mac",
  fidelity: "the answer couldn't be backed up by what Ozzie read",
  transport: "the AI service couldn't be reached",
  "no-model": "no AI model is set up",
  interrupted: "it was stopped before it finished",
});
const reason = (code: string | null | undefined) => (code && Object.hasOwn(FAILURE_REASONS, code) ? FAILURE_REASONS[code as FailureCode] : "something went wrong");

/** When Ozzie can't tell, what it can do instead (owner decision "Useful help when work cannot be completed"). */
export const CAN_DO_INSTEAD = "Ozzie can tell you what still needs a decision this Sunday, who on a team could help with an open role, or prepare a note for you to copy. Ask “What can you do?” to see more.";

/** What the Ask panel says when a question couldn't be answered. "no-model" shows the set-up panel instead. */
export const ASK_FAILURES = Object.freeze({
  egress: "That question includes details Ozzie keeps on this Mac, so Ozzie stopped before sending them. Try asking again in other words, or ask about the role instead of the person.",
  fidelity: "Ozzie couldn't back that answer up with what it read, so it isn't shown. Try asking about one role or one thing at a time, or ask “What can you do?”",
  invalid: "Ozzie couldn't prepare that question in a safe form. Nothing was sent. Try different wording.",
  denied: "The AI asked to use something Ozzie doesn't allow, so Ozzie stopped. Nothing was sent or changed.",
  steps: "That needed more steps than Ozzie allows for one question. Try asking about one thing at a time.",
  today: "Ozzie has reached today's allowance for AI help, so it didn't ask the AI. Everything else still works, and it can ask again tomorrow.",
  allowance: "Ozzie has reached its allowance for AI help on this Mac, so it didn't ask the AI. Everything else still works.",
  // Ozzie managed (model.ts PAUSED_TEXT, with what happened to this question).
  paused: "Your church's AI help is paused until the allowance resets or your church changes plan, so Ozzie didn't ask the AI. Checks, lists, Church rules and briefings keep working.",
  ledger: "Ozzie's record of its work isn't available, so it didn't ask the AI.",
  // Ozzie managed refused the question as holding a phone number or email address.
  contact: "That question looks like it holds a phone number or email address, so Ozzie managed didn't send it to the AI. Try asking again without it.",
  slowDown: "The AI service asked Ozzie to slow down. Try again in a minute.",
  unfinished: "Ozzie couldn't finish that just now.",
  cancelled: "You stopped this question. Ozzie won't show an answer for it.",
});
// ---- Answered on this Mac, without the AI (owner decisions "Useful before accounts are connected" and
// "Useful help when work cannot be completed", 2026-11-15) ----------------------------------------------------

/** What Ozzie can do here, for "What can you do?", "help" and the like. Fixed words; nothing is sent. */
export const HELP = Object.freeze({
  intro: "Here is what Ozzie can do for you, from what it reads in Planning Center:",
  can: Object.freeze([
    "Check Sunday: open roles, pending requests, kids team counts and background checks, and anything that needs a decision.",
    "Show who on a team could help with an open role, in no particular order, with what the check found for each person.",
    "Prepare a note for you to read, copy and send yourself.",
    "Keep an eye on Sunday, room bookings, follow-ups and group meetings, and tell you when something changes.",
    "Give you a morning briefing on Today.",
    "Read visitor cards on this Mac, on the Visitor cards page.",
  ]),
  never: "Ozzie never sends messages, never changes anything in Planning Center, and never writes prayers, sermons or scripture. People decide and people go.",
  try: "You could ask “What still needs a decision this Sunday?”, or say “Keep an eye on Sunday”.",
  first: "To start, connect Planning Center in Settings, or open the fictional example on the Sunday page.",
});
/** A question before anything was read: what to do next, never an error. */
export const ASK_START = "Ozzie hasn't read anything from Planning Center yet, so it can't answer that. Connect Planning Center in Settings, or check Planning Center on the Sunday page. You can also open the fictional example there.";
/** A question asked in the moment before Ozzie's procedures have loaded. */
export const ASK_LOADING = "Ozzie is still getting ready. Try again in a moment.";
/** Under an answer written on this Mac. */
export const LOCAL_NOTE = "Answered on this Mac without the AI. Nothing was sent.";
/** "See how this works" for an answer written on this Mac. */
export const LOCAL_HOW = "Ozzie answered this on this Mac from its last check, without asking the AI. Nothing was sent to anyone, and nothing in Planning Center changed.";
/** "See how this works" when items were added to the AI's choice on this Mac. */
export const ADDED_HOW = "Ozzie added the items under “Also on the Sunday page” itself, from the same check; the AI didn't choose them, and background checks never reach it.";
export const KEPT_STEP = "Looked at background checks, kept on this Mac";

/** The steps of an answer written on this Mac: each read-only tool it read, and the background checks it kept here. */
export function localSteps(evidence: readonly ToolEnvelope[], keptHere: boolean): string[] {
  return [...evidence.map(e => `${TOOL_PHRASES[e.tool as ToolName] ?? "Looked at the last check"} — ${STATUS_WORDS[e.completeness] ?? "didn't finish"}`),
    ...(keptHere ? [KEPT_STEP] : [])];
}

/** The Ask panel's message for a task's FailureCode, and the native code behind its failed step when there was one (review C9). */
export function askFailureText(code: FailureCode | null, native?: string): string {
  if (native === "ledger-unavailable") return ASK_FAILURES.ledger;
  if (native === "daily-limit") return ASK_FAILURES.today;
  if (native === "budget") return ASK_FAILURES.allowance;
  if (native === "allowance-paused") return ASK_FAILURES.paused;
  if (native === "contact-detail") return ASK_FAILURES.contact;
  if (native === "rate-limited") return ASK_FAILURES.slowDown;
  if (code === "egress") return ASK_FAILURES.egress;
  if (code === "fidelity") return ASK_FAILURES.fidelity;
  if (code === "invalid-task") return ASK_FAILURES.invalid;
  if (code === "denied") return ASK_FAILURES.denied;
  if (code === "limit") return ASK_FAILURES.steps;
  if (code === "cancelled") return ASK_FAILURES.cancelled;
  return ASK_FAILURES.unfinished;
}

// ---- Steps ---------------------------------------------------------------------------------------

/** One ledger event (native grammar) in plain words, or null for bookkeeping people don't need to see. */
export function stepText(type: TaskEvent["type"], detail: string, kind: TaskRow["kind"] = "ask"): string | null {
  switch (type) {
    case "tool": {
      const [first, second] = detail.split(" ");
      const name = second === undefined ? null : first!;
      const status = second ?? first ?? "";
      const phrase = name && ALLOWLIST.has(name)
        ? kind === "check" && name === "planning_center.refresh" ? "Read this Sunday from Planning Center" : TOOL_PHRASES[name as ToolName]
        : "Tried something Ozzie doesn't allow";
      const words = STATUS_WORDS[status] ?? (FAILURES.has(status) ? reason(status) : "didn't finish");
      return `${phrase} — ${words}`;
    }
    case "model": {
      const [n, outcome] = detail.split(" ");
      const asked = `Asked the AI (step ${n})`;
      if (!outcome) return asked;
      if (outcome === "stop") return `${asked}; it chose the facts for the answer`;
      if (outcome === "tool_calls") return `${asked}; it asked to look something up`;
      if (outcome === "length") return `${asked}; its reply ran too long`;
      return `${asked}; ${reason(outcome)}`;
    }
    case "verified": return kind === "check" ? "Finished the check" : "Checked the facts it chose against what was read";
    case "failed": return `Stopped: ${reason(detail)}`;
    case "cancelled": return "Stopped by you";
    default: return null;
  }
}

/** A finished task's runtime events as plain steps (tools and the final check of the answer). */
export function outcomeSteps(events: readonly TaskEvent[]): string[] {
  return events.flatMap(e => {
    if (e.type !== "tool" && e.type !== "verified") return [];
    const detail = ledgerDetail(e.type, e.detail);
    const text = detail === null ? null : stepText(e.type, detail);
    return text ? [text] : [];
  });
}
export const modelSteps = (events: readonly TaskEvent[]) => events.filter(e => e.type === "model").length;

// ---- Where an answer came from ---------------------------------------------------------------------

const when = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "an unknown time" : d.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};
const PLANNING_CENTER = /^Planning Center /u;
const RULES_SOURCE = "Church rules on this Mac";
const IMPORT_SOURCE = "Fictional email and calendar import";

/** "Based on: …" before any question: the check on screen. */
export function basedOnBrief(brief: SundayBrief): string {
  const at = brief.checked_at ?? brief.completed_at;
  const sunday = brief.mode === "fictional" ? `fictional example data as of ${when(at)}`
    : brief.mode === "recording" ? `a saved recording of the Planning Center check at ${when(at)}`
      : `Planning Center check at ${when(at)}`;
  return `Based on: ${sunday}${brief.mode === "fictional" ? ", plus the fictional email import" : ""}`;
}

/** "Based on: …" for one verified answer: each source it read, with its check time, newest first per source. */
export function basedOnEvidence(evidence: readonly Pick<ToolEnvelope, "source" | "check_time">[], mode: "live" | "recording" | "fictional"): string {
  if (!evidence.length) return "Based on: nothing Ozzie read";
  const latest = new Map<string, string>();
  for (const e of evidence) {
    const prior = latest.get(e.source);
    if (!prior || e.check_time > prior) latest.set(e.source, e.check_time);
  }
  const parts: string[] = [];
  const pco = [...latest].filter(([s]) => PLANNING_CENTER.test(s));
  if (pco.length) {
    const newest = pco.map(([, t]) => t).sort().at(-1)!;
    if (mode === "fictional") parts.push(`fictional example data as of ${when(newest)}`);
    else if (mode === "recording") parts.push(`a saved recording of the Planning Center check at ${when(newest)}`);
    else parts.push(...pco.map(([source, t]) => `${source}, checked ${when(t)}`));
  }
  if (latest.has(IMPORT_SOURCE)) parts.push("the fictional email import");
  if (latest.has(RULES_SOURCE)) parts.push("your Church rules");
  return `Based on: ${parts.join("; ") || "what Ozzie read"}`;
}

/** What an answer's reads couldn't fully cover, as "Worth a look" lines. A saved recording is already labelled as one. */
export function evidenceGaps(evidence: readonly ToolEnvelope[], mode: "live" | "recording" | "fictional"): string[] {
  const out = new Set<string>();
  for (const e of evidence) {
    const what = PLANNING_CENTER.test(e.source) ? e.source : e.source === IMPORT_SOURCE ? "The fictional email import" : "Part of this";
    if (e.completeness === "partial") out.add(`${what}: part of this couldn't be read.`);
    if (e.completeness === "stale" && mode !== "recording") out.add(`${what}: from a check that's too old to treat as current.`);
    if (e.completeness === "denied") out.add(`${what}: not shared with Ozzie.`);
  }
  return [...out];
}

// ---- What happened ------------------------------------------------------------------------------------

/** How a Sunday check started, or that a question was answered on this Mac without the AI, kept on this Mac by task id. */
export type CheckTrigger = "automatic" | "manual" | "on-this-mac";
const clockText = (iso: string, now: Date) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "an unknown time";
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay ? d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : d.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};
const things = (n: number) => `${n} ${n === 1 ? "thing" : "things"} looked at`;

/** One line per task, e.g. "Answered a question · checked · 3 things looked at · 9:42 PM". */
export function taskLine(row: TaskRow, options: { procedures?: ReadonlyMap<string, Skill> | null; trigger?: CheckTrigger; now?: Date } = {}): string {
  const now = options.now ?? new Date();
  const tools = row.events.filter(e => e.type === "tool");
  const at = clockText(row.created_at, now);
  let title: string, outcome: string | null;
  if (row.kind === "check") {
    title = options.trigger === "manual" ? "Sunday check you started" : options.trigger === "automatic" ? "Automatic Sunday check" : "Sunday check";
    outcome = row.state === "verified" ? (tools.some(e => !e.detail.endsWith(" complete") && e.detail !== "complete") ? "part of this couldn't be read" : null) : null;
  } else {
    const procedure = row.kind === "skill" ? options.procedures?.get(row.skill_id)?.title ?? "A check Ozzie ran" : null;
    title = row.kind === "ask" ? row.state === "verified" ? options.trigger === "on-this-mac" ? "Answered on this Mac" : "Answered a question" : "A question" : procedure!;
    outcome = row.state === "verified" ? `checked · ${things(tools.length)}` : null;
  }
  if (row.state === "failed") outcome = `Couldn't finish: ${reason(row.failure)}`;
  if (row.state === "cancelled") outcome = "You stopped it";
  if (row.state === "admitted" || row.state === "running" || row.state === "proposed") outcome = "Still running";
  return [title, outcome, at].filter(Boolean).join(" · ");
}

/** A task's steps in plain words, in order. */
export function taskSteps(row: TaskRow): string[] {
  return row.events.flatMap(e => {
    const text = stepText(e.type, e.detail, row.kind);
    return text ? [text] : [];
  });
}
