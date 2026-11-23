// Plain English for what Ozzie keeps an eye on: the plan a person confirms, when it checks, what it
// noticed, and why a run couldn't finish. Fixed local words only; nothing here comes from a model,
// Planning Center text or what someone typed. Product language rules (AGENTS.md): no "skill",
// "agent", "session", "log", "connector" or "harness"; Ozzie prepares and surfaces, people decide.
import {
  nearDeadlineTimes, TEMPLATES, type Lifetime, type Plan, type ReportPolicy, type Responsibility, type RunRow, type RunTrigger, type TemplateId,
} from "../../../core/src/harness/responsibilities.js";
import { describeChange } from "../../../core/src/sunday-changes.js";
import { kindWords } from "../../../core/src/finding-feedback.js";
import { SUNDAY_WORDS, type DayWords } from "../../../core/src/service-day.js";
import type { JobChurch, NoticedItem, SwitchQuestion } from "./responsibility-runner.js";
import { dayName, keepTitle, pageRef, SERVICES } from "./day-phrases.js";
import { promise } from "./promises.js";
import { readProblemText, systemWords, type OtherSystem } from "./church-system.js";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** "7:00 AM" for a church-local "07:00". */
export function clockText(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const hour = (h ?? 0) % 12 || 12;
  return `${hour}:${String(m ?? 0).padStart(2, "0")} ${(h ?? 0) < 12 ? "AM" : "PM"}`;
}
/** "Sunday, November 22" for a church-local date. */
export function dateText(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
}
/** An instant on this Mac's clock: "Sat 7:02 AM", or "7:02 AM" today. */
export function whenText(iso: string, now?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "an unknown time";
  const today = now ? new Date(now) : new Date();
  return d.toDateString() === today.toDateString()
    ? d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    : d.toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" });
}
const list = (items: string[]) => items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// The watched service is named by its real day (onboarding spec §5, decision 18): every sentence below that names it
// takes the day words (core service-day.ts), "Keep Wednesday covered", "as this weekend gets close". Template ids and the
// titles the store keeps are unchanged; a title is put in the day's words only when shown. Without day words (a caller
// that has none, a test), the Sunday words apply.

/** A template's title as shown: Keep Sunday covered is "Keep services covered" (renamed 2026-11-19; the store keeps its own title). */
export const templateTitle = (template: TemplateId): string =>
  template === "keep-sunday-covered" ? keepTitle() : TEMPLATES[template].title;
/** A job's title as shown: its template's in the day's words while it still has the template's own title. */
export const jobTitle = (r: Pick<Responsibility, "template" | "title">): string =>
  r.template && Object.hasOwn(TEMPLATES, r.template) && r.title === TEMPLATES[r.template].title ? templateTitle(r.template) : r.title;
/** The morning briefing's fuller brief, by the service's day, as its own heading says it (sunday-ready.tsx): "“Ready for Wednesday” brief". */
export const readyBriefName = (d: DayWords = SUNDAY_WORDS): string => `“Ready for ${dayName(d)}” brief`;

/**
 * What each one watches, in a sentence. `several`: more than one service is watched, and Keep services covered reads each.
 * `system`: a church on B1 Church or Breeze, where Ozzie checks no leads, and Breeze ties no number to most roles.
 */
export function watchesText(template: TemplateId, d: DayWords = SUNDAY_WORDS, several = false, system: OtherSystem | null = null): string {
  switch (template) {
    case "keep-sunday-covered": return system === "breeze" ? "Who has said yes, hasn't answered or said no on each role of the service Ozzie watches, and open roles where Breeze gives a number."
      : system === "b1" ? "Open roles, and who has accepted or declined, for the service Ozzie watches."
      : `Open roles, who has accepted or declined, and scheduled leads for ${several ? "each service" : "the service"} Ozzie watches.`;
    case "watch-room-bookings": return `Room bookings on ${dayName(d)} that overlap under your room rules.`;
    case "follow-ups-without-owner": return "Follow-ups in Planning Center People that are overdue with no one assigned.";
    case "group-night-clashes": return `Group meetings at the same time as someone is serving on ${dayName(d)}.`;
    case "morning-briefing": return `What still needs you before ${dayName(d)}, brought together each morning at the time you choose. Thursday's includes the full ${readyBriefName(d)}.`;
  }
}
/** The template picker's one line for each. */
export function purposeText(template: TemplateId, d: DayWords = SUNDAY_WORDS): string {
  switch (template) {
    case "keep-sunday-covered": return `Checks every day, more often as ${dayName(d)} gets close, and tells you when a role needs a decision.`;
    case "watch-room-bookings": return "Checks each week for room bookings that overlap.";
    case "follow-ups-without-owner": return "Checks each week for overdue follow-ups that no one owns.";
    case "group-night-clashes": return "Checks each week for group meetings that clash with serving.";
    case "morning-briefing": return `Prepares Today's briefing each weekday at 7:00 AM, or the time you choose, if this Mac is awake and Ozzie is running. Thursday's includes the full ${readyBriefName(d)}.`;
  }
}
/**
 * How the two things that look at the service differ, on Keeping watch: each says it on its own card, in short sentences,
 * under the same two names used everywhere (audit item 28, spec §6). Ozzie keeping an eye on the day (proactive.ts, its
 * card titled "Ozzie keeps an eye on {day}") is the steady look that runs by itself; Keep {day} covered (on_change,
 * near_deadline) is a job the leader starts, with its own plan, limits and end, and its card sits under the steady look's.
 */
export const EYE_ABOUT = "Runs by itself whenever Ozzie is open.";
/** Keep {day} covered's card on Keeping watch, under the steady look's card: what it is, and how the two work together. */
export const keepAbout = (d: DayWords = SUNDAY_WORDS): string =>
  `A job you started, with a plan, limits and an end you chose. It checks more often as ${dayName(d)} gets close, and sooner when the check above finds a change. It also prepares notes.`;
/** Offered under the steady look's card when Keep {day} covered isn't on. */
export const offerText = (d: DayWords = SUNDAY_WORDS): string =>
  `A job you start. You confirm a short plan first, with limits and an end you choose. It checks more often as ${dayName(d)} gets close, and sooner when the check above finds a change. It prepares notes and tells you when something needs a decision.`;
/** Keeping watch says this without opening anything: closing the window doesn't stop Ozzie, but quitting it or sleep does. */
export const QUIT_LINE = "Nothing runs after you quit Ozzie or while this Mac is asleep.";
/** Keeping watch's "See how this works", after what is running: how Ozzie keeps checking. QUIT_LINE stays outside it. */
export const WATCH_HOW: readonly string[] = Object.freeze([
  "Ozzie keeps checking while its window is closed. It stays as the small Ozzie picture at the top of your screen.",
  "If a check is missed because Ozzie was quit or this Mac was asleep, Ozzie catches up once when it can.",
]);
/** The same fold's line about jobs, where jobs are listed. */
export const oneOfEach = (): string =>
  `Ozzie runs one job of each kind at a time, such as one ${keepTitle()}. To change one, use Change on its card instead of setting up another.`;
/** Every automatic check depends on this; said wherever a plan says when it checks. */
export const ONLY_WHILE = "Only while this Mac is awake and Ozzie is running.";
/** What the run checks, finishing "Ozzie couldn't check …". */
const subject = (template: TemplateId) => template === "keep-sunday-covered" ? SERVICES
  : ({ "watch-room-bookings": "room bookings", "follow-ups-without-owner": "follow-ups", "group-night-clashes": "group nights", "morning-briefing": "your morning briefing" } as const)[template];

/** Which Planning Center areas it reads: "Planning Center Services and Calendar". */
export function areasText(template: TemplateId): string {
  const areas = template === "watch-room-bookings" ? "Services and Calendar" : template === "follow-ups-without-owner" ? "Services and People"
    : template === "group-night-clashes" ? "Services and Groups" : "Services";
  return `Planning Center ${areas}`;
}
/** Which Planning Center areas it reads, with the church by its name when known (never its organization number, spec §6). */
export function accountsText(template: TemplateId, church?: string | null): string {
  return `${areasText(template)}${church ? `, ${church}` : ""}. ${promise("readsShort", "A")}`;
}
/** The access a template needs that this connection hasn't granted, or null. */
export function missingAccess(template: TemplateId, granted: readonly string[]): string | null {
  if (!TEMPLATES[template].needs.includes("operations") || granted.includes("operations")) return null;
  const where = template === "watch-room-bookings" ? "Room bookings are in Planning Center Calendar"
    : template === "follow-ups-without-owner" ? "Follow-ups are in Planning Center People" : "Group meetings are in Planning Center Groups";
  return `${where}, which this connection doesn't include yet. Add rooms, follow-ups and group events under Settings first; Ozzie won't widen its access on its own.`;
}

/** Monday to Friday, as a schedule says it. */
export const isWeekdays = (weekdays: readonly number[]) => weekdays.length === 5 && [1, 2, 3, 4, 5].every((d, i) => weekdays[i] === d);
export function daysText(weekdays: readonly number[]): string {
  if (!weekdays.length) return "Every day";
  if (isWeekdays(weekdays)) return "Weekdays";
  if (weekdays.length === 1) return `Every ${DAY_NAMES[weekdays[0]!]}`;
  return list(weekdays.map(d => `${DAY_NAMES[d]}s`));
}
/**
 * "Every day at 7:00 AM, and sooner when something changes. Also at 12:00 PM and 5:00 PM in the two days
 * before Sunday." The extra times are the ones its schedule will really use (core nearDeadlineTimes):
 * none on chosen weekdays, none for a plan that ends before it reaches them.
 */
export function scheduleText(plan: Pick<Plan, "template" | "schedule" | "lifetime">, at: { now: string; zone: string }, d: DayWords = SUNDAY_WORDS): string {
  const base = `${daysText(plan.schedule.weekdays)} at ${clockText(plan.schedule.time)}${plan.schedule.on_change ? ", and sooner when something changes" : ""}.`;
  const extra = nearDeadlineTimes(plan, at.now, at.zone);
  // The extra times fall in the two days before a Sunday (core nearDeadline); a service on another day hears the days by name.
  const sunday = d.kind === "weekday" && d.weekday === 0;
  return base + (extra.length ? ` Also at ${list(extra.map(clockText))} ${sunday ? "in the two days before Sunday" : "on Fridays and Saturdays"}.` : "");
}
/** `weekdays`: a daily one kept to chosen days (the morning briefing on weekdays) doesn't run every day. */
export function lifetimeText(lifetime: Lifetime, template: TemplateId, weekdays: readonly number[] = []): string {
  if (lifetime.kind === "until") return `Until the end of ${dateText(lifetime.until)}. Then it stops on its own.`;
  if (TEMPLATES[template].cadence === "weekly") return "Weekly until you stop it.";
  return weekdays.length ? `${daysText(weekdays)} until you stop it.` : "Every day until you stop it.";
}
/** A short lifetime label for choices: "After Sunday, November 22", "Until you stop it". */
export function lifetimeChoice(lifetime: Lifetime): string {
  return lifetime.kind === "until" ? `Until the end of ${dateText(lifetime.until)}` : "Until you stop it";
}
export const REPORT_CHOICES: Readonly<Record<ReportPolicy, string>> = Object.freeze({
  "decisions-only": "Only when something needs a decision",
  "every-check": "After every check",
});
export function reportText(plan: Pick<Plan, "template" | "report">): string {
  const privately = "A private notice on this Mac with no names or details; quiet hours hold it until they end.";
  if (plan.template === "morning-briefing") return `When your morning briefing is ready. ${privately}`;
  return `${REPORT_CHOICES[plan.report]}. ${privately}`;
}
export function limitsText(plan: Pick<Plan, "limits">, modelReady: boolean): string {
  const checks = `At most ${count(plan.limits.checks_per_day, "check", "checks")} a day.`;
  return modelReady
    ? `${checks} Uses the AI at most ${plan.limits.ai_steps_per_day} times a day to write a short summary; it sees labels, not the names Ozzie read.`
    : `${checks} No AI model is set up, so Ozzie reports what Planning Center shows without a written summary.`;
}
export const STOP_TEXT = "Stop it any time in Keeping watch.";
// A job only reads, whatever the church's switch for changes says: form A of the promise is exact for it.
export const NEVER_TEXT = `${promise("reads", "A")} It won't contact anyone; you decide what happens next.`;
export function assumedText(plan: Plan, assumed: readonly string[]): string | null {
  if (!assumed.includes("lifetime")) return null;
  return plan.lifetime.kind === "until"
    ? `You didn't say how long, so this ends after ${dateText(plan.lifetime.until)}. Change it if you meant every week.`
    : "You didn't say how long, so this runs until you stop it.";
}

/** Why the store refused (responsibilities.rs ResponsibilityError), for a person. */
export function refusalText(code: string): string {
  switch (code) {
    case "full": return "Ozzie is already keeping an eye on as many things as it can. Stop one in Keeping watch first.";
    case "invalid": return "That plan isn't one Ozzie can run. Try Change it.";
    case "paused-all": return "Everything is paused. Resume everything in Keeping watch first.";
    case "paused": return "It's paused. Resume it first.";
    case "ended": case "expired": return "It has ended. Set up a new one if you still need it.";
    case "checks-limit": return "It has used today's checks. It will check again later, within its limits.";
    case "too-soon": case "busy": return "It just checked. Try again in a few minutes.";
    case "exists": return "Ozzie is already keeping an eye on this.";
    default: return "Ozzie's list of what it keeps an eye on couldn't be saved on this Mac.";
  }
}

const RUN_WHY: Readonly<Record<RunTrigger, string>> = Object.freeze({
  start: "when it started", scheduled: "on schedule", "catch-up": "catching up after a missed check", retry: "trying again after a problem",
  change: "because something changed", manual: "Check now",
});
/**
 * What one check found, each count with its own label: "2 things to decide and 1 worth a look". Things to
 * decide are the same count as Sunday's everywhere else; Worth a look is never added into it.
 */
export function foundText(item: Pick<NoticedItem, "template" | "decisions" | "looks" | "findings">): string {
  const parts: string[] = [];
  if (item.decisions) parts.push(count(item.decisions, "thing to decide", "things to decide"));
  // A group night clash is that template's Worth a look: counted once, by what it is.
  if (item.looks && item.template !== "group-night-clashes") parts.push(`${item.looks} worth a look`);
  if (item.findings?.rooms) parts.push(count(item.findings.rooms, "room booking overlap", "room booking overlaps"));
  if (item.findings?.rooms_uncertain) parts.push(`${count(item.findings.rooms_uncertain, "room booking overlap", "room booking overlaps")} worth a look`);
  if (item.findings?.follow_ups) parts.push(count(item.findings.follow_ups, "follow-up without an owner", "follow-ups without an owner"));
  if (item.findings?.groups) parts.push(count(item.findings.groups, "group meeting clash", "group meeting clashes"));
  return list(parts);
}
/** The run's own report, when Ozzie still has it: what it found, labeled. */
const reportOf = (run: RunRow, report?: NoticedItem | null) => report && report.run_id === run.run_id ? report : null;
/**
 * One run in Keeping watch. With the run's report, what it found is labeled the same way as
 * everywhere else; without it, the store's single number is called findings so it can't be read as
 * Sunday's things to decide.
 */
export function runText(run: RunRow, now?: string, report?: NoticedItem | null): string {
  const at = whenText(run.started_at, now);
  if (!run.outcome) return `${at}, ${RUN_WHY[run.trigger]}. Checking now…`;
  if (run.outcome === "interrupted") return `${at}, ${RUN_WHY[run.trigger]}. Stopped before it finished.`;
  if (run.outcome === "failed") return `${at}, ${RUN_WHY[run.trigger]}. Couldn't finish: ${problemText(run.code)}.`;
  const own = reportOf(run, report);
  const labeled = own ? foundText(own) : "";
  const found = labeled || (!own && run.noticed ? count(run.noticed, "finding", "findings") : own?.unnumbered ? "nothing new to tell you" : "nothing new needs a decision");
  return `${at}, ${RUN_WHY[run.trigger]}. Finished: ${found}${run.drafts ? `; ${count(run.drafts, "note", "notes")} ready to review` : ""}.`;
}
// ---- A job's write-up (audit item 6) -------------------------------------------------------------------

/** What a job's run checked, finishing "Ozzie checked … at 9:06 AM:". */
const checked = (template: TemplateId) => template === "keep-sunday-covered" ? SERVICES : template === "morning-briefing" ? `${SERVICES} for your briefing`
  : ({ "watch-room-bookings": "room bookings", "follow-ups-without-owner": "follow-ups", "group-night-clashes": "group nights" } as const)[template];
/** "at 9:06 AM" today on this Mac's clock, otherwise "on Sat at 7:02 AM". */
export function atText(iso: string, now?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "at an unknown time";
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === (now ? new Date(now) : new Date()).toDateString() ? `at ${time}` : `on ${d.toLocaleDateString("en-US", { weekday: "short" })} at ${time}`;
}
/** The first line of a job's write-up: "Ozzie checked Wednesday at 9:06 AM:". */
export const writeupHead = (item: Pick<NoticedItem, "template" | "at">, now?: string) => `Ozzie checked ${checked(item.template)} ${atText(item.at, now)}:`;
/**
 * Said quietly on a job's card when AI help is set up and its run has no write-up, so the card is never blank about it.
 * A run paused during its write-up says nothing (none is kept), and "off" is shown nowhere (review H, L15).
 */
export const NO_WRITEUP: Readonly<Record<"off" | "spent" | "no-credit" | "run-limit" | "unverified" | "unavailable", string>> = Object.freeze({
  off: "No write-up this time: AI help is off. This card shows what Ozzie's own check of Planning Center found.",
  spent: "No write-up this time: AI help has reached its limit for now. This card shows what Ozzie's own check of Planning Center found.",
  // The AI company's account out of credit (native no-credit), never "ran past what one run may use" (review F5).
  "no-credit": "No write-up this time: the AI company says your account has no credit left, or has reached a spending limit. This card shows what Ozzie's own check of Planning Center found.",
  // One run's own step or size limit, not the allowance (review G).
  "run-limit": "No write-up this time: the AI's answer ran past what one run may use. This card shows what Ozzie's own check of Planning Center found.",
  unverified: "No write-up this time: the AI's answer didn't check out against what Ozzie read, so it isn't shown. This card shows what Ozzie's own check of Planning Center found.",
  unavailable: "No write-up this time: it couldn't be prepared. This card shows what Ozzie's own check of Planning Center found.",
});
/** "See how this works" under a write-up, after its steps. */
export const WRITEUP_HOW = "The AI saw labels such as [Person 1] and [Role 1], never the names Ozzie read; Ozzie put the names back on this Mac. The AI only chose which facts to show, and Ozzie wrote every sentence here. What this card counts, and any notice, came from Ozzie's own check, not from the AI. Nothing was sent to anyone, and nothing in Planning Center changed.";
/** The first step of a write-up's account: Ozzie's own check came first, with no AI. */
export const WRITEUP_CHECK = "Ozzie read Planning Center and worked out what it found itself, with no AI.";

/** The title of what the AI wrote for a report whose decisions are on the service's card: what was written, never the decisions again. */
export function preparedTitle(ready: { summary: string | null; draft: string | null }): string {
  return ready.summary && ready.draft ? `Ozzie wrote up where ${SERVICES} stand and drafted a note.`
    : ready.draft ? `Ozzie drafted a note for ${SERVICES}.` : `Ozzie wrote up where ${SERVICES} stand.`;
}
/** Why a run couldn't finish or couldn't start, finishing "Couldn't finish: …". Says only what is known. */
export function problemText(code: string | null | undefined): string {
  switch (code) {
    case "provider-failure": return "Planning Center didn't answer";
    case "denied": return "Planning Center access wasn't available";
    case "partial": return "part of it couldn't be read";
    // The store closes a run left open too long: Ozzie may have closed, or the check ran long.
    case "interrupted": return "it was cut off before it finished";
    case "timeout": return "it took too long";
    // Paused, or its check stopped because Ozzie's sign-in was busy or the Mac's storage was locked (checkFailure).
    case "cancelled": return "it was paused or stopped before it finished";
    case "unverified": return "Ozzie couldn't confirm which church its sign-in to Planning Center belongs to";
    case "limit": return "it reached its limit";
    case "unavailable": return "its list of what to keep an eye on couldn't be read on this Mac";
    case "invalid": return "its plan couldn't be used as saved; try Change";
    case "transport": case "no-model": return "the AI service didn't answer";
    case "invalid-arguments": return "the AI asked to look something up in a way Ozzie doesn't allow";
    // Ozzie's own check of a step (on this Mac, or Ozzie's AI's at ozzie.church: native `not-accepted`) turned it down.
    case "invalid-task": return "Ozzie's own check turned a step down before the AI saw it";
    default: return "something went wrong";
  }
}
/**
 * Its status on Keeping watch. `problem`: the newest thing it reported was that it couldn't
 * check (the store refused the run, so no run is listed). A run paused part-way isn't a problem.
 */
export function statusText(r: Responsibility, pausedAll: boolean, problem = false): { label: string; tone: "ok" | "muted" | "attn" } {
  if (r.status === "ended") return { label: "Ended", tone: "muted" };
  if (r.status === "paused") return { label: "Paused", tone: "muted" };
  if (pausedAll) return { label: "Paused with everything", tone: "muted" };
  const last = r.runs.find(x => x.outcome);
  if (last && last.outcome !== "ok" && last.code !== "cancelled") return { label: "Couldn't finish last time", tone: "attn" };
  if (problem) return { label: "Couldn't check last time", tone: "attn" };
  return { label: "Keeping an eye on it", tone: "ok" };
}

// ---- What Ozzie noticed -------------------------------------------------------------------------------

const AT_TIME = (iso: string, now?: string) => whenText(iso, now);
/**
 * An item's own system words (B1 Church, Breeze): Ozzie's sentences that name Planning Center only as where the facts are,
 * said in the name of the system its check read, whatever the church uses now. Planning Center's items: unchanged.
 */
export const itemSay = (item: Pick<NoticedItem, "system">): ((text: string) => string) => item.system ? systemWords(item.system).say : (text: string) => text;
/** Where a system shares no number needed for any role (Breeze): the limit, said where "covered" would be. */
export const unnumberedText = (system: OtherSystem, d: DayWords = SUNDAY_WORDS): string =>
  `${systemWords(system).name} doesn't share how many people each role needs, so Ozzie can't say whether ${d.thisOne} is covered.`;
/** The headline of one "Ozzie noticed" item. Names come only from `names`, resolved on this Mac. `d`: the watched service's day words. */
export function noticedTitle(item: NoticedItem, now?: string, d: DayWords = SUNDAY_WORDS): string {
  const said = noticedPlain(item, now, d);
  if (!item.system) return said;
  // Breeze shares no number needed for any role: never "nothing needs a decision", and the limit is said (round 5); a
  // briefing other than Thursday's (whose full brief says it) says it too.
  const limit = item.unnumbered && (item.kind === "found" || item.kind === "clear" || (item.kind === "briefing" && !item.sunday_ready)) ? ` ${unnumberedText(item.system, d)}` : "";
  return `${itemSay(item)(said)}${limit}`;
}
function noticedPlain(item: NoticedItem, now: string | undefined, d: DayWords): string {
  const title = templateTitle(item.template);
  const system = item.system ? systemWords(item.system).name : null;
  switch (item.kind) {
    case "found": {
      const parts: string[] = [];
      if (item.decisions) parts.push(`${count(item.decisions, "thing needs", "things need")} a decision`);
      if (item.findings?.rooms) parts.push(`${count(item.findings.rooms, "room booking overlap needs", "room booking overlaps need")} review`);
      if (item.findings?.follow_ups) parts.push(`${count(item.findings.follow_ups, "follow-up is", "follow-ups are")} overdue with no owner`);
      if (item.findings?.groups) parts.push(`${count(item.findings.groups, "group meeting clashes", "group meetings clash")} with serving`);
      // An overlap no room rule confirms is Worth a look, as the Sunday page labels it.
      if (item.findings?.rooms_uncertain) parts.push(`${count(item.findings.rooms_uncertain, "room booking overlap is", "room booking overlaps are")} worth a look`);
      if (item.looks && !parts.length) parts.push(`${count(item.looks, "thing is", "things are")} worth a look`);
      return `${title}: ${parts.length ? list(parts) : "something changed"}.`;
    }
    case "clear": return item.unnumbered ? `${title}: checked at ${AT_TIME(item.at, now)}. Nothing new to tell you.`
      : `${title}: checked at ${AT_TIME(item.at, now)}. Nothing new needs a decision.`;
    case "briefing": {
      const n = item.overnight_count ?? 0;
      const kept = (item.kept ?? []).reduce((sum, k) => sum + k.count, 0);
      return `Your morning briefing is ready.${item.sunday_ready ? ` Today it includes the full ${readyBriefName(d)}.` : ""}${n
        ? ` ${n === 1 ? "One thing" : `${n} things`} came up overnight; ${n === 1 ? "it's" : "they're"} marked Overnight.` : ""}${kept
        ? ` It includes ${kept === 1 ? "one thing" : `${kept} things`} your Church rules keep for the briefing.` : ""}`;
    }
    case "couldnt-check": {
      const at = AT_TIME(item.scheduled_for ?? item.at, now);
      const why = item.code === "denied" && item.access ? "this connection doesn't include what it needs" : problemText(item.code);
      const next = item.retry_at ? ` It will try again at ${AT_TIME(item.retry_at, now)}.` : item.access ? " Add access under Settings, then it can check." : " It will try again at its next scheduled time.";
      // A B1 Church or Breeze read that didn't finish says why in that system's own words (church-system.ts readProblemText).
      const read = item.system && item.read ? readProblemText(item.system, item.read) : null;
      if (read) return `Ozzie couldn't check ${subject(item.template)} at ${at}. ${read}${next}`;
      if (system && item.no_roles) return `Ozzie couldn't check ${subject(item.template)} at ${at} — ${system} lists no roles for the service Ozzie watches.${next}`;
      return `Ozzie couldn't check ${subject(item.template)} at ${at} — ${why}.${next}`;
    }
    case "missed": {
      const at = AT_TIME(item.scheduled_for!, now), ran = AT_TIME(item.ran_at ?? item.at, now);
      const others = item.missed_count && item.missed_count > 1 ? ` and ${count(item.missed_count - 1, "other time", "other times")}` : "";
      // The last times before a dated end: no check followed.
      if (item.before_end) switch (item.missed_reason) {
        case "asleep": return `Your Mac was asleep at ${at}${others}, and ${title} ended before Ozzie could check again.`;
        case "closed": return `Ozzie wasn't running at ${at}${others}, and ${title} ended before it could check again.`;
        case "waiting": return system ? `${system} couldn't be checked yet at ${at}${others}, and ${title} ended before Ozzie could check.`
          : `Planning Center wasn't connected at ${at}${others}, and ${title} ended before Ozzie could check.`;
        default: return `Ozzie couldn't check at ${at}${others}, and ${title} ended before it could check again.`;
      }
      switch (item.missed_reason) {
        case "asleep": return `Your Mac was asleep at ${at}${others}, so Ozzie checked at ${ran} instead.`;
        case "closed": return `Ozzie wasn't running at ${at}${others}, so it checked at ${ran} instead.`;
        case "waiting": return system ? `${system} couldn't be checked yet at ${at}${others}, so Ozzie checked at ${ran} instead.`
          : `Planning Center wasn't connected at ${at}${others}, so Ozzie checked at ${ran} instead.`;
        default: return `Ozzie couldn't check at ${at}${others}, so it checked at ${ran} instead.`;
      }
    }
    case "limit": return `${title} has used its checks for now. It will check again later, within its limits.`;
    // "As planned" only when it didn't miss any of its checks on the way.
    case "ended": return item.until
      ? `${title} ended after ${dateText(item.until)}${item.missed_count ? "" : ", as planned"}. Anything still open is on ${pageRef()}.`
      : `${title} has ended.`;
  }
}
/**
 * The morning briefing's "Kept for your briefing" lines: each kind the person's Church rules keep for it, with
 * how many its check showed ("Open roles: 2"). Kinds and counts only; no names.
 */
export function keptLines(item: Pick<NoticedItem, "kind" | "kept">): string[] {
  if (item.kind !== "briefing") return [];
  return (item.kept ?? []).filter(k => k.count > 0).map(k => { const words = kindWords(k.kind); return `${words.charAt(0).toUpperCase()}${words.slice(1)}: ${k.count}`; });
}
const WEEK_MS = 7 * 86_400_000;
/**
 * The briefing's weekly line about regular jobs (owner decision, October 26: quiet success, loud problems),
 * from each job's run history over the seven days before `now`. When every check finished: "3 regular jobs
 * ran this week. All finished." Otherwise the line says how many jobs couldn't finish every check, and each
 * such job gets its own plain sentence. A run paused part-way isn't a problem, and one still running isn't
 * counted yet. Nothing ran this week: nothing to say (null). Job titles are fixed; no names.
 */
export function weekRollup(jobs: readonly (Pick<Responsibility, "title" | "runs"> & Partial<Pick<Responsibility, "template">>)[], now: string): { line: string | null; problems: string[] } {
  const since = Date.parse(now) - WEEK_MS;
  const ran = jobs.map(j => ({ title: j.template ? jobTitle({ template: j.template, title: j.title }) : j.title, runs: j.runs.filter(r => r.outcome !== null && Date.parse(r.started_at) > since && Date.parse(r.started_at) <= Date.parse(now)) }))
    .filter(j => j.runs.length > 0);
  if (!ran.length) return { line: null, problems: [] };
  const problems = ran.map(j => ({ title: j.title, total: j.runs.length, failed: j.runs.filter(r => r.outcome !== "ok" && r.code !== "cancelled").length }))
    .filter(j => j.failed > 0);
  const head = `${count(ran.length, "regular job", "regular jobs")} ran this week.`;
  if (!problems.length) return { line: `${head} All finished.`, problems: [] };
  return {
    line: `${head} ${problems.length} couldn't finish every check.`,
    problems: problems.map(j => `${j.title} couldn't finish ${j.failed} of ${count(j.total, "check", "checks")} this week.`),
  };
}
// ---- A job confirmed for another church (owner decision 2026-11-22) -----------------------------------------------

const systemName = (c: Pick<JobChurch, "system">) => c.system === "planning-center" ? "Planning Center" : systemWords(c.system).name;
/** "Harbor on Planning Center"; "your church on Planning Center" when its name isn't known. */
const churchOn = (c: JobChurch, unknown: string) => `${c.name ?? unknown} on ${systemName(c)}`;
/**
 * The one question about a job after the Mac switched church, in plain words naming both churches and systems, with
 * buttons that name the effect (AGENTS.md), what each does said before either is pressed, and what the status line says
 * after each. Fixed local words around the churches' own names; no person's name.
 */
export function switchQuestionText(q: Pick<SwitchQuestion, "template" | "title" | "from" | "to" | "waiting">): {
  title: string; body: string; keep: string; stop: string; kept: string; stopped: string;
} {
  const job = jobTitle(q);
  const here = q.to.name ?? "this church";
  return {
    title: `${job} was set up for ${churchOn(q.from, "your church")}. Keep it for ${churchOn(q.to, "the church you use now")}?`,
    body: `Until you answer, it's paused: it checks nothing and tells you nothing. If you keep it, its first check of ${here} only learns what is there now and tells you nothing about it; after that it tells you what changes. If you stop it, it ends, as Stop does.${q.waiting ? ` ${here} isn't connected right now: if you keep it, its first check waits until it is.` : ""}`,
    keep: `Yes, keep it for ${here}`,
    stop: "No, stop it",
    kept: `${job} keeps an eye on ${here} now.`,
    stopped: `${job} is stopped.`,
  };
}

/** A job this Mac keeps for another church, not shown here (RunnerView `held`): why, in one line. */
export const heldText = (h: { template: TemplateId; title: string; church: JobChurch }): string =>
  `${jobTitle(h)} was set up for ${churchOn(h.church, "your church")}: it waits until Ozzie uses that church again. Stop it to set one up here instead.`;
/** A job whose last two checks came back from another church or service (RunnerView `stalled`): why it waits. */
export const STALLED_TEXT = "Waiting: its last two checks came back from another church or service than the one it was set up for, so it uses no checks until Ozzie's own check reads that one again.";

/** What changed since the last run, one sentence each, names resolved locally, the service named by its real day. */
export function noticedChanges(item: NoticedItem, names: Readonly<Record<string, string>>, d: DayWords = SUNDAY_WORDS): string[] {
  // A B1 Church or Breeze item's changes name that system as where the facts are (core sunday-changes.ts `source`).
  const source = item.system ? [systemWords(item.system).name] as const : [] as const;
  return (item.changes ?? []).filter(c => c.effect === "worse").slice(0, 5).map(c => describeChange(c, id => names[id], d, ...source));
}
export function noticedBadge(item: NoticedItem): { label: string; tone: "attn" | "look" | "ok" | "muted" } {
  switch (item.kind) {
    // Only what needs a decision on the service's page does here: a confirmed room overlap, never an uncertain one.
    case "found": return item.decisions || item.findings?.rooms || item.findings?.follow_ups ? { label: "Needs a decision", tone: "attn" } : { label: "Worth a look", tone: "look" };
    case "briefing": return { label: "Ready", tone: "ok" };
    case "clear": return { label: "Checked", tone: "ok" };
    case "couldnt-check": return { label: "Couldn't finish", tone: "attn" };
    case "missed": return { label: "Checked late", tone: "look" };
    default: return { label: "Note", tone: "muted" };
  }
}
export const NOTICE_WORDS: Readonly<Record<NonNullable<NoticedItem["notice"]>, string | null>> = Object.freeze({
  sent: "Notice sent", held: "Notice waiting for quiet hours to end", "sent-later": "Notice sent after quiet hours", "in-app": "Seen in Ozzie",
  unavailable: "The Mac didn't show the notice", briefing: "Kept for your briefing, as your Church rules say", "in-briefing": "Brought into your morning briefing",
  none: null,
});
