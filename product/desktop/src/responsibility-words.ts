// Plain English for what Ozzie keeps an eye on: the plan a person confirms, when it checks, what it
// noticed, and why a run couldn't finish. Fixed local words only; nothing here comes from a model,
// Planning Center text or what someone typed. Product language rules (AGENTS.md): no "skill",
// "agent", "session", "log", "connector" or "harness"; Ozzie prepares and surfaces, people decide.
import {
  nearDeadlineTimes, TEMPLATES, type Lifetime, type Plan, type ReportPolicy, type Responsibility, type RunRow, type RunTrigger, type TemplateId,
} from "../../../core/src/harness/responsibilities.js";
import { describeChange } from "../../../core/src/sunday-changes.js";
import type { NoticedItem } from "./responsibility-runner.js";

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

/** What each one watches, in a sentence. */
export const WATCHES: Readonly<Record<TemplateId, string>> = Object.freeze({
  "keep-sunday-covered": "Open roles, who has accepted or declined, and Sunday leads for the Sunday chosen in Settings.",
  "watch-room-bookings": "Room bookings on Sunday that overlap under your room rules.",
  "follow-ups-without-owner": "Follow-ups in Planning Center People that are overdue with no one assigned.",
  "group-night-clashes": "Group meetings at the same time as someone is serving on Sunday.",
  "morning-briefing": "What still needs you before Sunday, brought together at the time you choose each morning.",
});
/** The template picker's one line for each. */
export const PURPOSE: Readonly<Record<TemplateId, string>> = Object.freeze({
  "keep-sunday-covered": "Checks every day until Sunday and tells you when a role needs a decision.",
  "watch-room-bookings": "Checks each week for room bookings that overlap.",
  "follow-ups-without-owner": "Checks each week for overdue follow-ups that no one owns.",
  "group-night-clashes": "Checks each week for group meetings that clash with serving.",
  "morning-briefing": "Prepares Today's briefing each morning at the time you choose, if this Mac is awake and Ozzie is running.",
});
/** Every automatic check depends on this; said wherever a plan says when it checks. */
export const ONLY_WHILE = "Only while this Mac is awake and Ozzie is running.";
/** What the run checks, finishing "Ozzie couldn't check …". */
const SUBJECT: Readonly<Record<TemplateId, string>> = Object.freeze({
  "keep-sunday-covered": "Sunday", "watch-room-bookings": "room bookings", "follow-ups-without-owner": "follow-ups",
  "group-night-clashes": "group nights", "morning-briefing": "your morning briefing",
});

/** Which Planning Center areas it reads, with the organization. */
export function accountsText(template: TemplateId, organization: string): string {
  const areas = template === "watch-room-bookings" ? "Services and Calendar" : template === "follow-ups-without-owner" ? "Services and People"
    : template === "group-night-clashes" ? "Services and Groups" : "Services";
  return `Planning Center ${areas}${organization ? `, organization ${organization}` : ""}. Reads only.`;
}
/** The access a template needs that this connection hasn't granted, or null. */
export function missingAccess(template: TemplateId, granted: readonly string[]): string | null {
  if (!TEMPLATES[template].needs.includes("operations") || granted.includes("operations")) return null;
  const where = template === "watch-room-bookings" ? "Room bookings are in Planning Center Calendar"
    : template === "follow-ups-without-owner" ? "Follow-ups are in Planning Center People" : "Group meetings are in Planning Center Groups";
  return `${where}, which this connection doesn't include yet. Add rooms, follow-ups and group events under Settings first; Ozzie won't widen its access on its own.`;
}

function daysText(weekdays: readonly number[]): string {
  if (!weekdays.length) return "Every day";
  if (weekdays.length === 1) return `Every ${DAY_NAMES[weekdays[0]!]}`;
  return list(weekdays.map(d => `${DAY_NAMES[d]}s`));
}
/**
 * "Every day at 7:00 AM, and sooner when something changes. Also at 12:00 PM and 5:00 PM in the two days
 * before Sunday." The extra times are the ones its schedule will really use (core nearDeadlineTimes):
 * none on chosen weekdays, none for a plan that ends before it reaches them.
 */
export function scheduleText(plan: Pick<Plan, "template" | "schedule" | "lifetime">, at: { now: string; zone: string }): string {
  const base = `${daysText(plan.schedule.weekdays)} at ${clockText(plan.schedule.time)}${plan.schedule.on_change ? ", and sooner when something changes" : ""}.`;
  const extra = nearDeadlineTimes(plan, at.now, at.zone);
  return base + (extra.length ? ` Also at ${list(extra.map(clockText))} in the two days before Sunday.` : "");
}
export function lifetimeText(lifetime: Lifetime, template: TemplateId): string {
  if (lifetime.kind === "until") return `Until the end of ${dateText(lifetime.until)}. Then it stops on its own.`;
  return TEMPLATES[template].cadence === "weekly" ? "Weekly until you stop it." : "Every day until you stop it.";
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
    ? `${checks} Uses the AI at most ${plan.limits.ai_steps_per_day} times a day to write a short summary; names never reach it.`
    : `${checks} No AI model is set up, so Ozzie reports what Planning Center shows without a written summary.`;
}
export const STOP_TEXT = "Stop it any time in What runs automatically.";
export const NEVER_TEXT = "Ozzie only reads. It won't change Planning Center or contact anyone; you decide what happens next.";
export function assumedText(plan: Plan, assumed: readonly string[]): string | null {
  if (!assumed.includes("lifetime")) return null;
  return plan.lifetime.kind === "until"
    ? `You didn't say how long, so this ends after ${dateText(plan.lifetime.until)}. Change it if you meant every week.`
    : "You didn't say how long, so this runs until you stop it.";
}

/** Why the store refused (responsibilities.rs ResponsibilityError), for a person. */
export function refusalText(code: string): string {
  switch (code) {
    case "full": return "Ozzie is already keeping an eye on as many things as it can. Stop one in What runs automatically first.";
    case "invalid": return "That plan isn't one Ozzie can run. Try Change it.";
    case "paused-all": return "Everything is paused. Resume everything in What runs automatically first.";
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
/** One run in What runs automatically. */
export function runText(run: RunRow, now?: string): string {
  const at = whenText(run.started_at, now);
  if (!run.outcome) return `${at}, ${RUN_WHY[run.trigger]}. Checking now…`;
  if (run.outcome === "interrupted") return `${at}, ${RUN_WHY[run.trigger]}. Stopped before it finished.`;
  if (run.outcome === "failed") return `${at}, ${RUN_WHY[run.trigger]}. Couldn't finish: ${problemText(run.code)}.`;
  const found = run.noticed ? `${count(run.noticed, "thing needs", "things need")} you` : "nothing new needs a decision";
  return `${at}, ${RUN_WHY[run.trigger]}. Finished: ${found}${run.drafts ? `; ${count(run.drafts, "note", "notes")} ready to review` : ""}.`;
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
    case "cancelled": return "it was paused before it finished";
    case "limit": return "it reached its limit";
    case "unavailable": return "its list of what to keep an eye on couldn't be read on this Mac";
    case "invalid": return "its plan couldn't be used as saved; try Change";
    case "transport": case "no-model": return "the AI service didn't answer";
    default: return "something went wrong";
  }
}
/**
 * Its status on What runs automatically. `problem`: the newest thing it reported was that it couldn't
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
/** The headline of one "Ozzie noticed" item. Names come only from `names`, resolved on this Mac. */
export function noticedTitle(item: NoticedItem, now?: string): string {
  const title = TEMPLATES[item.template].title;
  switch (item.kind) {
    case "found": {
      const parts: string[] = [];
      if (item.decisions) parts.push(`${count(item.decisions, "thing needs", "things need")} a decision`);
      if (item.findings?.rooms) parts.push(`${count(item.findings.rooms, "room booking overlap needs", "room booking overlaps need")} review`);
      if (item.findings?.follow_ups) parts.push(`${count(item.findings.follow_ups, "follow-up is", "follow-ups are")} overdue with no owner`);
      if (item.findings?.groups) parts.push(`${count(item.findings.groups, "group meeting clashes", "group meetings clash")} with serving`);
      if (item.looks && !parts.length) parts.push(`${count(item.looks, "thing is", "things are")} worth a look`);
      return `${title}: ${parts.length ? list(parts) : "something changed"}.`;
    }
    case "clear": return `${title}: checked at ${AT_TIME(item.at, now)}. Nothing new needs a decision.`;
    case "briefing": return "Your morning briefing is ready.";
    case "couldnt-check": {
      const at = AT_TIME(item.scheduled_for ?? item.at, now);
      const why = item.code === "denied" && item.access ? "this connection doesn't include what it needs" : problemText(item.code);
      const next = item.retry_at ? ` It will try again at ${AT_TIME(item.retry_at, now)}.` : item.access ? " Add access under Settings, then it can check." : " It will try again at its next scheduled time.";
      return `Ozzie couldn't check ${SUBJECT[item.template]} at ${at} — ${why}.${next}`;
    }
    case "missed": {
      const at = AT_TIME(item.scheduled_for!, now), ran = AT_TIME(item.ran_at ?? item.at, now);
      const others = item.missed_count && item.missed_count > 1 ? ` and ${count(item.missed_count - 1, "other time", "other times")}` : "";
      // The last times before a dated end: no check followed.
      if (item.before_end) switch (item.missed_reason) {
        case "asleep": return `Your Mac was asleep at ${at}${others}, and ${title} ended before Ozzie could check again.`;
        case "closed": return `Ozzie wasn't running at ${at}${others}, and ${title} ended before it could check again.`;
        case "waiting": return `Planning Center wasn't connected at ${at}${others}, and ${title} ended before Ozzie could check.`;
        default: return `Ozzie couldn't check at ${at}${others}, and ${title} ended before it could check again.`;
      }
      switch (item.missed_reason) {
        case "asleep": return `Your Mac was asleep at ${at}${others}, so Ozzie checked at ${ran} instead.`;
        case "closed": return `Ozzie wasn't running at ${at}${others}, so it checked at ${ran} instead.`;
        case "waiting": return `Planning Center wasn't connected at ${at}${others}, so Ozzie checked at ${ran} instead.`;
        default: return `Ozzie couldn't check at ${at}${others}, so it checked at ${ran} instead.`;
      }
    }
    case "limit": return `${title} has used its checks for now. It will check again later, within its limits.`;
    // "As planned" only when it didn't miss any of its checks on the way.
    case "ended": return item.until
      ? `${title} ended after ${dateText(item.until)}${item.missed_count ? "" : ", as planned"}. Anything still open is on the Sunday page.`
      : `${title} has ended.`;
  }
}
/** What changed since the last run, one sentence each, names resolved locally. */
export function noticedChanges(item: NoticedItem, names: Readonly<Record<string, string>>): string[] {
  return (item.changes ?? []).filter(c => c.effect === "worse").slice(0, 5).map(c => describeChange(c, id => names[id]));
}
export function noticedBadge(item: NoticedItem): { label: string; tone: "attn" | "look" | "ok" | "muted" } {
  switch (item.kind) {
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
  unavailable: "The Mac didn't show the notice", none: null,
});
