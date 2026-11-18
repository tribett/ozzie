// Plain English for what Ozzie did: the tools it used, how complete each read was, why a task
// stopped, where an answer came from, and the lines What happened shows. Fixed local words only;
// nothing here comes from a model, a provider or Planning Center text. Product language rules
// (AGENTS.md): no "skill", "agent", "session", "log", "connector" or "harness" on any user surface.
import type { FailureCode, Skill, TaskEvent, ToolEnvelope, ToolName } from "../../../core/src/harness/contract.js";
import { NATIVE_TOOL_ALLOWLIST } from "../../../core/src/harness/contract.js";
import { TEMPLATE_IDS, TEMPLATES, type RunTrigger, type TemplateId } from "../../../core/src/harness/responsibilities.js";
import type { SundayBrief } from "../../../core/src/sunday-brief.js";
import { REFUSALS } from "../../../core/src/ask.js";
import { alsoOnPage } from "../../../core/src/harness/compose.js";
import { SUNDAY_WORDS, type DayWords } from "../../../core/src/service-day.js";
import { dayName } from "./day-phrases.js";
import { templateTitle } from "./responsibility-words.js";
import { dailyLimitEnds, monthLimitText } from "./model.js";

// The watched service may meet on any day (onboarding spec §5, decision 18). Fixed sentences here that are shared by
// several screens, or that describe work recorded earlier (possibly about another week's service), say "the service" or
// "your service's page"; those that describe one job take the day words (`templateTitle`).
const SERVICE_PAGE = "your service's page";
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

/** What each of the 13 read-only tools is, as one plain sentence (audit item 7). Never the tool's own name. */
export const TOOL_PHRASES: Readonly<Record<ToolName, string>> = Object.freeze({
  "sunday.overview": "Looked at the overview of the service",
  "sunday.open_needs": "Looked at the open roles for the service",
  "sunday.who_could_help": "Looked at who is on the team for an open role",
  "sunday.pending_requests": "Looked at requests still waiting for an answer",
  "sunday.rule_checkins": "Looked at the check-ins your Church rules suggest",
  "sunday.not_checked": "Looked at what the check couldn't read",
  "rooms.conflicts": "Looked at room bookings",
  "followups.unowned": "Looked at follow-ups without an owner",
  "groups.clashes": "Looked at group meetings on the service's day",
  "today.attention": "Looked at the fictional email and calendar import",
  "rules.current": "Looked at your Church rules",
  // Said from the record alone, so true whichever way the tool answered (review H, L2); a finished answer's own steps say
  // exactly what happened (outcomeSteps, from its results).
  "planning_center.refresh": "Looked at whether Planning Center needed reading again",
  "drafts.prepare_note": "Asked for a draft note",
});
/** How complete one read was, or why it couldn't be used. */
export const STATUS_WORDS: Readonly<Record<string, string>> = Object.freeze({
  complete: "all of it",
  partial: "part of it couldn't be read",
  stale: "from a check that is too old to treat as current",
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
/**
 * Why a check of the service stopped, where its code means something narrower than for other tasks (harness-bridge.ts
 * `checkFailure`): which church a sign-in belongs to, and a sign-in that was busy or a Mac's storage that was locked.
 */
export const CHECK_FAILURE_REASONS: Readonly<Partial<Record<FailureCode, string>>> = Object.freeze({
  // Out of reach, a 429 or a 5xx alike (review N, 8).
  "provider-failure": "Planning Center didn't answer just now",
  unverified: "Ozzie couldn't confirm which church its sign-in to Planning Center belongs to, so nothing was read",
  cancelled: "Ozzie's sign-in to Planning Center was busy with something else, or this Mac's credential storage was locked, so the check stopped",
});
const reasonFor = (kind: TaskRow["kind"], code: string | null | undefined) =>
  kind === "check" && code && Object.hasOwn(CHECK_FAILURE_REASONS, code) ? CHECK_FAILURE_REASONS[code as FailureCode]! : reason(code);

/** When Ozzie can't tell, what it can do instead (owner decision "Useful help when work cannot be completed"). */
export const CAN_DO_INSTEAD = "Ozzie can tell you what still needs a decision for the service it watches, who on a team could help with an open role, or prepare a note for you to copy. Ask “What can you do?” to see more.";

/** What the Ask panel says when a question couldn't be answered. "no-model" shows the set-up panel instead. */
export const ASK_FAILURES = Object.freeze({
  egress: "That question includes details Ozzie keeps on this Mac, so Ozzie stopped before sending them. Try asking again in other words, or ask about the role instead of the person.",
  fidelity: "Ozzie couldn't back that answer up with what it read, so it isn't shown. Try asking about one role or one thing at a time, or ask “What can you do?”",
  /**
   * After `fidelity`, when the AI is a model on this Mac (measured 2026-11-18, onboarding-native-contract.md "AI on this
   * Mac: Ask's own policy"): it misses more often than an AI company's (the same question asked again rarely passes, so
   * that isn't suggested); asking about one thing at a time, which the sentence before says, and a key are what help.
   */
  fidelityHere: "AI on this Mac misses more often than an AI company's. A key from an AI company, in Settings › AI help, gives steadier answers.",
  invalid: "Ozzie couldn't prepare that question in a safe form. Nothing was sent. Try different wording.",
  denied: "The AI asked to use something Ozzie doesn't allow, so Ozzie stopped. Nothing was sent or changed.",
  steps: "That needed more steps than Ozzie allows for one question. Try asking about one thing at a time.",
  today: "Ozzie has reached today's allowance for AI help, so it didn't ask the AI. Everything else still works, and it can ask again tomorrow.",
  /** The same, when the account says when the day's allowance comes back (`paused_until`, re-check Low). */
  todayUntil: (when: string) => `Ozzie has reached today's allowance for AI help, so it didn't ask the AI. Everything else still works, and it can ask again from ${when}.`,
  allowance: "Ozzie has reached its allowance for AI help on this Mac, so it didn't ask the AI. Everything else still works.",
  // Ozzie's AI refused with 402 allowance-paused: this month's answers are used (until the date the account gives), or
  // a pause for everyone. The daily ceiling and too many requests at once are 429 rate-limited (slowDown).
  paused: "Ozzie's AI is paused, so Ozzie didn't ask the AI: this month's answers are used, or Ozzie's AI is pausing for everyone for a while. It starts again by itself, and nothing extra is charged. Checks, lists, Church rules and briefings keep working.",
  // The account says when the pause ends (`paused_until`, on this Mac's clock: model.ts `pausedWhen`): that time, never "in a minute".
  pausedUntil: (when: string) => `Ozzie's AI is paused until ${when}, so Ozzie didn't ask the AI. Checks, lists, Church rules and briefings keep working.`,
  // The church's own key reached its monthly limit (native `month-limit`, contract N5): the limit's own paused sentence.
  monthLimit: monthLimitText,
  /** The church's own AI company says the account has no credit left (native no-credit, in normal use). */
  /** Gemini spent its whole answer thinking and said nothing (native thought-only, contract 14). */
  thoughtOnly: "Gemini used up its answer before saying anything, so there is no answer this time. Ask again, or choose another company in Settings › AI help.",
  noCredit: "The AI company says your account has no credit left, or has reached a spending limit, so Ozzie didn't ask the AI. Add credit or raise the limit on their billing page, then ask again. Checks, lists, Church rules and briefings keep working.",
  ledger: "Ozzie's record of its work isn't available, so it didn't ask the AI.",
  // Ozzie managed refused the question as holding a phone number or email address.
  contact: "That question looks like it holds a phone number or email address, so Ozzie managed didn't send it to the AI. Try asking again without it.",
  // Background-check wording stopped on this Mac or by ozzie.church (native `background-check`): the page's own refusal.
  background: REFUSALS.background,
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
    "Check the service Ozzie watches: open roles, pending requests, kids team counts and background checks, and anything that needs a decision.",
    "Show who on a team could help with an open role, in no particular order, with what the check found for each person.",
    "Prepare a note for you to read, copy and send yourself.",
    "Keep an eye on the service, room bookings, follow-ups and group meetings, and tell you when something changes.",
    "Give you a morning briefing on Today.",
    "Read visitor cards on this Mac, on the Visitor cards page.",
  ]),
  never: "Ozzie never sends messages, never changes anything in Planning Center, and never writes prayers, sermons or scripture. People decide and people go.",
  try: "You could ask “What still needs a decision?”, or say “Keep an eye on the service”.",
  first: `To start, connect Planning Center in Settings, or open the fictional example on ${SERVICE_PAGE}.`,
});
/** A question before anything was read: what to do next, never an error. */
export const ASK_START = `Ozzie hasn't read anything from Planning Center yet, so it can't answer that. Connect Planning Center in Settings, or check Planning Center on ${SERVICE_PAGE}. You can also open the fictional example there.`;
/** A question asked in the moment before Ozzie's procedures have loaded. */
export const ASK_LOADING = "Ozzie is still getting ready. Try again in a moment.";
/** Under an answer written on this Mac. */
export const LOCAL_NOTE = "Answered on this Mac without the AI. Nothing was sent.";
/** First, above an answer written here because the question mentions background checks (review B2 L-3). */
export const BACKGROUND_HERE = `Ozzie doesn't send questions with background-check or child-safety screening wording to the AI, so it answered this here from ${SERVICE_PAGE}.`;
/** "See how this works" for an answer written on this Mac. */
export const LOCAL_HOW = "Ozzie answered this on this Mac from its last check, without asking the AI. Nothing was sent to anyone, and nothing in Planning Center changed.";
/** "See how this works" when items were added to the AI's choice on this Mac. */
/** The heading the added items sit under, as the answer says it (core compose.ts), without its ending. */
const heading = (d: DayWords) => alsoOnPage(d).replace(/, needing a decision:$/u, "");
/** "See how this works" for items Ozzie added, naming the heading as the answer says it for this service's day (review H4). */
export const addedHow = (d: DayWords) => `Ozzie added the items under “${heading(d)}” itself, from the same check; the AI didn't choose them, and background checks never reach it.`;
export const ADDED_HOW = addedHow(SUNDAY_WORDS);
export const KEPT_STEP = "Looked at background checks, kept on this Mac";

/** The steps of an answer written on this Mac: each read-only tool it read, and the background checks it kept here. */
export function localSteps(evidence: readonly ToolEnvelope[], keptHere: boolean): string[] {
  return [...evidence.map(e => `${TOOL_PHRASES[e.tool as ToolName] ?? "Looked at the last check"} — ${STATUS_WORDS[e.completeness] ?? "didn't finish"}`),
    ...(keptHere ? [KEPT_STEP] : [])];
}

/**
 * The Ask panel's message for a task's FailureCode, and the native code behind its failed step when there was one (review C9).
 * `pausedWhen`: when Ozzie's AI's account says its pause ends (model.ts `pausedWhen`), for a pause or a slow-down.
 */
export function askFailureText(code: FailureCode | null, native?: string, pausedWhen?: string | null): string {
  if (native === "ledger-unavailable") return ASK_FAILURES.ledger;
  if (native === "month-limit") return ASK_FAILURES.monthLimit();
  if (native === "no-credit") return ASK_FAILURES.noCredit;
  if (native === "thought-only") return ASK_FAILURES.thoughtOnly;
  // rate-limited is only "busy" now: the account's daily ceiling is daily-limit (native re-check NM1).
  if (pausedWhen && native === "allowance-paused") return ASK_FAILURES.pausedUntil(pausedWhen);
  if (native === "daily-limit") { const when = pausedWhen ?? dailyLimitEnds(); return when ? ASK_FAILURES.todayUntil(when) : ASK_FAILURES.today; }
  if (native === "budget") return ASK_FAILURES.allowance;
  if (native === "allowance-paused") return ASK_FAILURES.paused;
  if (native === "contact-detail") return ASK_FAILURES.contact;
  if (native === "background-check") return ASK_FAILURES.background;
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
        ? kind === "check" && name === "planning_center.refresh" ? "Read the service from Planning Center" : TOOL_PHRASES[name as ToolName]
        : "Tried something Ozzie doesn't allow";
      // Checking again isn't offered to a job's run (refused there): it was never done, so it never reads as done.
      if (kind !== "check" && name === "planning_center.refresh" && status === "denied") return "Didn't read Planning Center again: that isn't possible here";
      // A draft isn't a read: "all of it" would say nothing.
      if (name === "drafts.prepare_note" && status === "complete") return phrase;
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
    case "failed": return `Stopped: ${reasonFor(kind, detail)}`;
    case "cancelled": return "Stopped by you";
    default: return null;
  }
}

/**
 * What a finished task looked at, as plain steps: one per tool it used, with how complete each read was. With its
 * results (`evidence`, in call order), checking again and drafting say what really happened (review H, L2), and a saved
 * copy of a check is called one (L3).
 */
export function outcomeSteps(events: readonly TaskEvent[], evidence: readonly ToolEnvelope[] = [], mode?: "live" | "recording" | "fictional"): string[] {
  const results = [...evidence];
  return events.flatMap(e => {
    if (e.type !== "tool") return [];
    const detail = ledgerDetail(e.type, e.detail);
    let text = detail === null ? null : stepText(e.type, detail);
    const [name, status] = e.detail.split(":");
    // Its own result: the next one of that tool with that completeness (a refused call may or may not have one).
    const at = results.findIndex(r => r.tool === name && r.completeness === status);
    const found = at >= 0 ? results.splice(at, 1)[0]! : null;
    const payload = (found && status !== "denied" ? found.payload : null) as Record<string, unknown> | null;
    const how = STATUS_WORDS[status ?? ""] ?? "";
    if (name === "planning_center.refresh" && payload) {
      text = payload["status"] === "checked again" ? `Read Planning Center again — ${how}` : "Saw that the last check was recent enough";
    } else if (name === "drafts.prepare_note" && payload) {
      text = typeof payload["draft"] === "string" ? "Prepared a draft note" : "Asked for a draft note; none was prepared";
    }
    if (text && status === "stale" && mode === "recording") text = text.replace(STATUS_WORDS.stale!, "from a saved copy of a check");
    return text ? [text] : [];
  });
}
export const modelSteps = (events: readonly TaskEvent[]) => events.filter(e => e.type === "model").length;
/** How many times a recorded task asked the AI: native records each step twice, as reserved ("1") and finished ("1 stop"). */
export const askedInRecord = (row: Pick<TaskRow, "events">) => row.events.filter(e => e.type === "model" && /^[1-9]\d? \S/u.test(e.detail)).length;

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
    : brief.mode === "recording" ? `a saved copy of the Planning Center check at ${when(at)}`
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
    else if (mode === "recording") parts.push(`a saved copy of the Planning Center check at ${when(newest)}`);
    else parts.push(...pco.map(([source, t]) => `${source}, checked ${when(t)}`));
  }
  if (latest.has(IMPORT_SOURCE)) parts.push("the fictional email import");
  if (latest.has(RULES_SOURCE)) parts.push("your Church rules");
  return `Based on: ${parts.join("; ") || "what Ozzie read"}`;
}

/** What an answer's reads couldn't fully cover, as "Worth a look" lines. A saved copy of a check is already labelled as one. */
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

/** How a check of the service started, or that a question was answered on this Mac without the AI, kept on this Mac by task id. */
export type CheckTrigger = "automatic" | "manual" | "on-this-mac";
/**
 * How any task started, kept on this Mac by task id beside the ledger (which has no field for it): a Sunday check's
 * trigger, a question answered on this Mac, a job's run (`job:<template>:<trigger>`), or "Ask Ozzie to look at who could
 * help" from a Sunday card. Closed, name-free words only.
 */
export type TaskStart = CheckTrigger | `job:${TemplateId}:${RunTrigger}` | "who-could-help";
/** How a verified answer ended, kept the same way: which closed answer form it took. Never its facts or words. */
export type TaskEnd = "facts" | "not-covered" | "nothing-needs-a-decision" | "draft";
export const TASK_ENDS: readonly TaskEnd[] = ["facts", "not-covered", "nothing-needs-a-decision", "draft"];
const RUN_TRIGGERS: readonly RunTrigger[] = ["start", "scheduled", "catch-up", "retry", "change", "manual"];
/** Whether text is a TaskStart (what the local store accepts back). */
export function isTaskStart(value: unknown): value is TaskStart {
  if (value === "automatic" || value === "manual" || value === "on-this-mac" || value === "who-could-help") return true;
  const m = typeof value === "string" ? /^job:([a-z-]+):([a-z-]+)$/u.exec(value) : null;
  return Boolean(m && (TEMPLATE_IDS as readonly string[]).includes(m[1]!) && (RUN_TRIGGERS as readonly string[]).includes(m[2]!));
}
const clockText = (iso: string, now: Date) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "an unknown time";
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay ? d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : d.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};
const things = (n: number) => `${n} ${n === 1 ? "thing" : "things"} looked at`;
/** A procedure's own title (core/skills, pinned) as shown: "Sunday ready" names the service's day. */
export const procedureTitle = (title: string | undefined, d: DayWords) =>
  title === "Sunday ready" && !(d.kind === "weekday" && d.weekday === 0) ? `Ready for ${dayName(d)}` : title;

/** One line per task, e.g. "Answered a question · checked · 3 things looked at · 9:42 PM". */
export function taskLine(row: TaskRow, options: { procedures?: ReadonlyMap<string, Skill> | null; trigger?: TaskStart; now?: Date; day?: DayWords } = {}): string {
  const now = options.now ?? new Date();
  const d = options.day ?? SUNDAY_WORDS;
  const tools = row.events.filter(e => e.type === "tool");
  const at = clockText(row.created_at, now);
  let title: string, outcome: string | null;
  if (row.kind === "check") {
    // Said without the day: an older check may have been of another week's service.
    title = options.trigger === "manual" ? "Planning Center check you started" : options.trigger === "automatic" ? "Planning Center check, on schedule" : "Planning Center check";
    outcome = row.state === "verified" ? (tools.some(e => !e.detail.endsWith(" complete") && e.detail !== "complete") ? "part of it couldn't be read" : null) : null;
  } else {
    // A job's run is named by the job; anything else by its procedure.
    const template = options.trigger?.startsWith("job:") ? options.trigger.split(":")[1] as TemplateId : undefined;
    const job = template && Object.hasOwn(TEMPLATES, template) ? templateTitle(template, d) : undefined;
    const procedure = row.kind === "skill" ? job ?? procedureTitle(options.procedures?.get(row.skill_id)?.title, d) ?? "A check Ozzie ran" : null;
    title = row.kind === "ask" ? row.state === "verified" ? options.trigger === "on-this-mac" ? "Answered on this Mac" : "Answered a question" : "A question" : procedure!;
    outcome = row.state === "verified" ? `checked · ${things(tools.length)}` : null;
  }
  if (row.state === "failed") outcome = `Couldn't finish: ${reasonFor(row.kind, row.failure)}`;
  if (row.state === "cancelled") outcome = "You stopped it";
  if (row.state === "admitted" || row.state === "running" || row.state === "proposed") outcome = "Still running";
  return [title, outcome, at].filter(Boolean).join(" · ");
}

/**
 * One task as a short account (audit item 7): what started it, what Ozzie looked at (each read in plain words, with how
 * much of it could be read), whether and how often it asked the AI, and how it ended. From the ledger's name-free events
 * and the start and end kept beside it on this Mac; no question, answer or source text, no tool's own name.
 */
export interface Account { started: string; looked: string[]; ai: string; ended: string }
const JOB_WHY: Readonly<Record<RunTrigger, string>> = Object.freeze({
  start: "when you started it", scheduled: "on schedule", "catch-up": "to catch up on a check it missed", retry: "to try again after a problem",
  change: "because something changed", manual: "when you chose Check now",
});
const timesText = (n: number) => n === 1 ? "once" : n === 2 ? "twice" : `${n} times`;
/** "Keep Wednesday covered ran on schedule, at 9:00 AM." */
export const jobStarted = (template: TemplateId, trigger: RunTrigger, at: string, d: DayWords = SUNDAY_WORDS) => `${templateTitle(template, d)} ran ${JOB_WHY[trigger]}, at ${at}.`;
/** "Ozzie asked the AI twice." with what the AI does, or that no AI was used and why. */
export function aiText(kind: TaskRow["kind"], start: TaskStart | undefined, asked: number, verified: boolean, unanswered = false): string {
  if (kind === "check") return "No AI was used: this was Ozzie's own check of Planning Center.";
  if (start === "on-this-mac") return "No AI was used: Ozzie answered this on this Mac from its last check.";
  // A step reserved but never finished was sent for, with no answer back (review G).
  if (!asked) return unanswered ? "Ozzie got no answer from the AI." : "Ozzie didn't reach the AI.";
  return `Ozzie asked the AI ${timesText(asked)}.${verified ? " The AI answered with a list of facts, which Ozzie checked against what it had read before writing anything." : ""}`;
}
export function taskAccount(row: TaskRow, options: { start?: TaskStart | undefined; end?: TaskEnd | undefined; procedures?: ReadonlyMap<string, Skill> | null; now?: Date;
  day?: DayWords } = {}): Account {
  const now = options.now ?? new Date();
  const d = options.day ?? SUNDAY_WORDS;
  const at = clockText(row.created_at, now);
  const { start, end } = options;
  const job = start?.startsWith("job:") ? start.split(":") as [string, TemplateId, RunTrigger] : null;
  let started: string;
  if (row.kind === "check") {
    started = start === "manual" ? `You asked Ozzie to check Planning Center at ${at}.` : start === "automatic" ? `Ozzie checked Planning Center on schedule at ${at}.` : `Ozzie checked Planning Center at ${at}.`;
  } else if (row.kind === "ask") started = `You asked a question at ${at}.`;
  else if (job) started = jobStarted(job[1], job[2], at, d);
  else if (start === "who-could-help") started = `You asked Ozzie to look at who could help with a role, at ${at}.`;
  else started = `${procedureTitle(options.procedures?.get(row.skill_id)?.title, d) ?? "A check Ozzie runs"} ran at ${at}.`;
  const looked = row.events.flatMap(e => e.type === "tool" ? [stepText("tool", e.detail, row.kind)!] : []);
  const asked = askedInRecord(row);
  const tools = row.events.filter(e => e.type === "tool");
  let ended: string;
  switch (row.state) {
    case "verified":
      if (row.kind === "check") ended = tools.some(e => !e.detail.endsWith(" complete") && e.detail !== "complete") ? "Finished, though part of the check couldn't be read." : "Finished.";
      // Its card shows what the AI found next to the full list, never a draft, and says when the AI didn't ask for this
      // role's list of people (review H, M3; review G, N3, N4). The record names no role, so a call for another role's list
      // counts as a call here, and this ending then says nothing about whose list it was (review K, L1).
      else if (start === "who-could-help") {
        const looked = tools.some(e => /^sunday\.who_could_help (?:complete|partial|stale)$/u.test(e.detail));
        ended = end === "not-covered" ? "The AI couldn't tell more than the list showed, and Ozzie said so."
          : end === "draft" ? "Finished. The AI asked for a note, which isn't prepared from this card."
            : looked ? "Finished. Ozzie showed what the AI found beside the list from its own check."
              : "Finished. The AI didn't ask for this role's list of people; Ozzie showed what it said about the role.";
      }
      else if (end === "nothing-needs-a-decision") ended = "Nothing needed a decision.";
      else if (end === "not-covered") ended = "What Ozzie read didn't answer it, and the answer said so.";
      else if (end === "draft") ended = "Answered with a draft note for you to read and send yourself.";
      else ended = row.kind === "ask" ? "Answered." : job ? "Finished. Ozzie wrote up the facts the AI chose, and the write-up is with this job." : "Finished. Ozzie wrote up the facts the AI chose.";
      break;
    case "failed":
      ended = row.failure === "fidelity" ? "The AI's answer didn't check out against what Ozzie read, so nothing was shown."
        : row.failure === "limit" ? "Stopped at its limit." : `Couldn't finish: ${reasonFor(row.kind, row.failure)}.`;
      break;
    // Pausing or stopping a job, or stopping a question: a person did it either way (review H, L12).
    case "cancelled": ended = "Stopped by you."; break;
    default: ended = "Still running.";
  }
  return { started, looked, ai: aiText(row.kind, start, asked, row.state === "verified", row.events.some(e => e.type === "model")), ended };
}
