// What Siri and Shortcuts hear when they ask Ozzie (ADR 0006): "Let Siri and Shortcuts ask Ozzie" in Settings, off by
// default. A shortcut runs Ozzie's bundled helper (product/desktop/src-tauri/helpers/shortcuts.swift) with one question
// name and the helper prints what this file says, built in the Mac's own JavaScriptCore from shortcuts-embedded.ts.
//
// The answer comes only from the copy native keeps for Shortcuts beside the copy for other AI apps: the same
// placeholder-only shared check (snapshot.ts), checked before writing by the same native code (shared_check.rs: the
// closed grammar, every name this session has shown, background-check wording), holding the Sunday overview and
// nothing else, and read back with the same parseSharedCheck. What is said is built only from counts, dates and the
// fixed words below: never a label, so nothing that stands for a person, role, room or team is said, and never a
// background check (none reaches the overview, and a copy holding the wording is refused). Nothing here reads
// Planning Center, calls a model or reaches a network; the helper hands in the copy's text.
import { isoMillis } from "../src/harness/fixed.js";
import type { ToolEnvelope } from "../src/harness/contract.js";
import { LIVE_CHECK_VALID_MS } from "../src/sunday-capture.js";
import { parseSharedCheck } from "./snapshot.js";

/** The copy for Shortcuts in Ozzie's app data folder, and the marker present beside it while the switch is on (shortcuts_check.rs). */
export const SHORTCUTS_FILE = "shortcuts-check.json";
export const SHORTCUTS_ON_FILE = ".shortcuts-check.on";
/** The one shared tool whose result the copy holds. Mirrored natively (shortcuts_check.rs SHORTCUT_TOOLS). */
export const SHORTCUT_TOOLS = Object.freeze(["sunday.overview"] as const);
/** The questions a shortcut can ask, by the one word it passes to the helper. */
export const QUESTIONS = Object.freeze(["sunday"] as const);

export const OFF = "Asking Ozzie from Siri and Shortcuts is turned off in Ozzie's Settings.";
/** Said for no copy, a copy outside the format, or one holding anything but the overview: one text for all, so nothing is learned about which. */
export const NO_CHECK = "Ozzie has no saved check to answer from. Open Ozzie to check Sunday.";
export const UNKNOWN_QUESTION = "Ozzie answers only \"sunday\" here. The setup steps are in Ozzie's Settings, under Siri and Shortcuts.";

const SHORTCUT: ReadonlySet<string> = new Set(SHORTCUT_TOOLS);
/** The results the copy for Shortcuts holds, from the shared tools' results. */
export const shortcutsEnvelopes = (envelopes: readonly ToolEnvelope[]): ToolEnvelope[] => envelopes.filter(e => SHORTCUT.has(e.tool));

export interface AnswerInput {
  /** Whether the leader has the switch on: native's marker beside the copy is a regular file. */
  on: boolean;
  /** The copy's text, or null when there is none. Not read while the switch is off. */
  text: string | null;
  /** Now, in milliseconds since 1970. */
  nowMs: number;
  /** The Mac's time zone (IANA name), for "today at 9:14 AM". */
  timeZone: string;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const count = (v: unknown): number | null => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A day as year, month (1-12) and day, compared as a number of days since 1970. */
interface Day { y: number; m: number; d: number; weekday: number }
const dayNumber = (day: Day) => Date.UTC(day.y, day.m - 1, day.d) / 86_400_000;

/** A plan date ("2026-11-22") as a Day, or null. */
function planDay(text: unknown): Day | null {
  const match = typeof text === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/u.exec(text) : null;
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return { y, m, d, weekday: date.getUTCDay() };
}

/** An instant on this Mac's clock: its day and time of day, in `zone`, or in UTC (said so) when the zone isn't known. */
interface Local { day: Day; clock: string }
function local(instant: number, zone: string): Local {
  const at = new Date(instant);
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit", hourCycle: "h23", weekday: "long",
    }).formatToParts(at);
    const part = (type: string) => parts.find(p => p.type === type)?.value ?? "";
    const hour = Number(part("hour")) % 24;
    const day = { y: Number(part("year")), m: Number(part("month")), d: Number(part("day")), weekday: WEEKDAYS.indexOf(part("weekday")) };
    if ([day.y, day.m, day.d, hour].every(Number.isFinite) && day.weekday >= 0) return { day, clock: clock(hour, part("minute")) };
  } catch { /* not a zone this engine knows: UTC below */ }
  const day = { y: at.getUTCFullYear(), m: at.getUTCMonth() + 1, d: at.getUTCDate(), weekday: at.getUTCDay() };
  return { day, clock: `${clock(at.getUTCHours(), String(at.getUTCMinutes()).padStart(2, "0"))} UTC` };
}
const clock = (hour: number, minute: string) => `${hour % 12 || 12}:${minute} ${hour < 12 ? "AM" : "PM"}`;
const dayWords = (day: Day) => `${WEEKDAYS[day.weekday]}, ${MONTHS[day.m - 1]} ${day.d}`;

/** "today at 10:00 AM", "yesterday at 10:00 AM" or "on Friday, November 20 at 10:00 AM", on this Mac's clock. */
function whenWords(checked: number, now: number, zone: string): string {
  const then = local(checked, zone), today = local(now, zone).day;
  const days = dayNumber(today) - dayNumber(then.day);
  return `${days === 0 ? "today" : days === 1 ? "yesterday" : `on ${dayWords(then.day)}`} at ${then.clock}`;
}

/** What the overview says that an answer uses: counts and kinds only. Labels are counted as distinct, never kept. */
interface Overview {
  mode: "live" | "recording" | "fictional";
  stale: boolean;
  /** Reads that didn't complete (also for a recording, whose completeness is always "stale"). */
  unread: boolean;
  /** Findings left out to fit the result's length: every count is then a least. */
  leftOut: boolean;
  sunday: Day | null;
  keptOnThisMac: boolean;
  /** Distinct roles that still need people, and their open spots (null when Planning Center's count isn't known for one). */
  roles: number;
  spots: number | null;
  /** Distinct teams with no scheduled lead (a fact), and with a lead whose answer or time couldn't be confirmed (worth a look). */
  leads: number;
  leadsUnsure: number;
  /** Distinct kids teams short of confirmed people: as a fact, and as worth a look (Ozzie couldn't place someone at a time). */
  kids: number;
  kidsUnsure: number;
  /** People pending (each once, however many roles), and their requests: sent with no answer yet, and not sent yet. */
  pendingPeople: number;
  sent: number;
  unsent: number;
  /** People scheduled with a blockout over their serving time (each once): worth a look, never an open spot. */
  blockedOut: number;
  handled: number;
  /**
   * Room overlaps a Church rule confirms and overdue follow-ups with no owner: the overview's rows for them (core
   * tools.ts #operationsShown), which need a decision on the Sunday page (review item 3). Counts only.
   */
  rooms: number;
  followUps: number;
}
const MODES: ReadonlySet<string> = new Set(["live", "recording", "fictional"]);
const UNSURE = "worth a look";

function overviewOf(envelope: ToolEnvelope): Overview | null {
  const p = envelope.payload;
  if (!record(p)) return null;
  const findings = p["findings"];
  if (typeof p["mode"] !== "string" || !MODES.has(p["mode"]) || !Array.isArray(findings) || !findings.every(record)) return null;
  // A finding the leader marked (covered outside Planning Center, not needed) is handled, unless a later check changed it.
  const handled = findings.filter(f => typeof f["decision"] === "string" && f["changed_since_decision"] !== true);
  const open = findings.filter(f => !handled.includes(f));
  const roles = (keep: (f: Record<string, unknown>) => boolean) => new Set(open.filter(keep).map(f => f["role"])).size;
  const needs = open.filter(f => f["kind"] === "needs people");
  const remaining = needs.map(f => count(f["remaining"]));
  const pending = open.filter(f => f["kind"] === "pending");
  const kids = (f: Record<string, unknown>) => f["kind"] === "fewer confirmed than the church rules ask";
  // A kids team short for certain at one time and unsure at another is the fact, said once (review K2 N1).
  const sureKids = new Set(open.filter(f => kids(f) && f["tone"] !== UNSURE).map(f => f["role"]));
  const unsureKids = new Set(open.filter(f => kids(f) && f["tone"] === UNSURE).map(f => f["role"]).filter(r => !sureKids.has(r)));
  // Someone pending for two roles is one person; a pending row without a person label counts on its own.
  const people = new Set(pending.map((f, i) => typeof f["person"] === "string" && f["person"].startsWith("[") ? f["person"] : `row ${i}`));
  const blocked = open.filter(f => f["kind"] === "scheduled with a blockout at this time");
  const blockedOut = new Set(blocked.map((f, i) => typeof f["person"] === "string" && f["person"].startsWith("[") ? f["person"] : `row ${i}`));
  const leftOut = (count(p["left_out_for_length"]) ?? 0) > 0;
  return {
    mode: p["mode"] as Overview["mode"],
    stale: envelope.completeness === "stale" || findings.some(f => f["too_old_to_treat_as_current"] === true),
    // "partial" also marks a result cut for length (tools.ts fit), which is said apart from reads that didn't complete.
    unread: (count(p["reads_not_completed"]) ?? 0) > 0 || (envelope.completeness === "partial" && !leftOut),
    leftOut,
    sunday: planDay(p["sunday"]),
    keptOnThisMac: typeof p["kept_on_this_mac"] === "string",
    roles: roles(f => f["kind"] === "needs people"),
    spots: remaining.every(n => n !== null) ? remaining.reduce<number>((a, n) => a + (n ?? 0), 0) : null,
    leads: roles(f => f["kind"] === "no scheduled lead"),
    leadsUnsure: roles(f => f["kind"] === "lead couldn't be confirmed"),
    kids: sureKids.size,
    kidsUnsure: unsureKids.size,
    pendingPeople: people.size,
    sent: pending.filter(f => f["request"] === "request sent, no answer yet").length,
    unsent: pending.filter(f => f["request"] === "request not sent yet").length,
    blockedOut: blockedOut.size,
    handled: handled.length,
    rooms: open.filter(f => f["kind"] === "room use needs review" && f["tone"] === "needs a decision").length,
    followUps: open.filter(f => f["kind"] === "needs an owner").length,
  };
}

const capital = (line: string) => line.charAt(0).toUpperCase() + line.slice(1);

/**
 * The facts, in the present tense for a current check or the past tense for an older one or a recording. What Ozzie
 * itself marks worth a look is said as "Worth a look", never as a fact (never-list 8); when findings were left out for
 * length every count is "at least". Who is pending is said in the Sunday page's words (sunday-page.tsx "pending").
 */
function factLines(o: Overview, past: boolean): string[] {
  const day = o.sunday ? dayWords(o.sunday) : "the chosen Sunday";
  const n = (k: number, one: string, many?: string) => `${o.leftOut ? "at least " : ""}${plural(k, one, many)}`;
  /** The verb for a count, present or past: "has"/"have"/"had". */
  const verb = (k: number, one: string, many: string, then: string) => past ? then : k === 1 ? one : many;
  const lines: string[] = [];
  if (!o.roles) {
    const need = past ? "still needed" : "still need";
    lines.push(o.leftOut ? `None of the roles Ozzie could count for ${day} ${need} people.` : capital(`no roles for ${day} ${need} people.`));
  } else if (o.spots !== null && o.spots > 0) lines.push(capital(`${day} ${past ? "had" : "has"} ${n(o.spots, "open spot")} across ${n(o.roles, "role")}.`));
  else lines.push(capital(`${day} ${past ? "had" : "has"} ${n(o.roles, "role")} that ${verb(o.roles, "still needs", "still need", "still needed")} people.`));
  if (o.leads) lines.push(capital(`${n(o.leads, "team")} ${verb(o.leads, "doesn't", "don't", "didn't")} have a confirmed lead.`));
  if (o.kids) lines.push(capital(`${n(o.kids, "kids team")} ${verb(o.kids, "has", "have", "had")} fewer confirmed people than your Church rules ask.`));
  if (o.pendingPeople) {
    const who = `${n(o.pendingPeople, "person", "people")} ${past ? (o.pendingPeople === 1 ? "was" : "were") : (o.pendingPeople === 1 ? "is" : "are")} pending`;
    const the = (k: number) => k === 1 ? "the request" : "the requests";
    const shows = past ? "Planning Center showed" : "Planning Center shows";
    const notSent = (k: number) => past ? "hadn't been sent yet" : k === 1 ? "hasn't been sent yet" : "haven't been sent yet";
    if (o.sent && o.unsent) {
      lines.push(capital(`${who}: ${n(o.sent, "request")} ${past ? "had been" : o.sent === 1 ? "was" : "were"} sent with no answer yet, and ${shows} ${n(o.unsent, "request")} ${notSent(o.unsent)}.`));
    } else if (o.sent) {
      lines.push(capital(`${who}: ${the(o.sent)} ${past ? "had been" : o.sent === 1 ? "was" : "were"} sent and ${past ? "there was" : "there's"} no answer yet.`));
    } else if (o.unsent) lines.push(capital(`${who}, and ${shows} ${the(o.unsent)} ${notSent(o.unsent)}.`));
    else lines.push(capital(`${who}.`));
  }
  // What else on the Sunday page needs a decision, as counts, so an answer is never short of the page's own count.
  if (o.rooms || o.followUps) {
    const what = [...(o.rooms ? [n(o.rooms, "room booking overlap")] : []), ...(o.followUps ? [`${n(o.followUps, "overdue follow-up")} with no owner`] : [])];
    lines.push(capital(`${what.join(" and ")} ${verb(o.rooms + o.followUps, "needs", "need", "needed")} a decision.`));
  }
  if (o.blockedOut) lines.push(`Worth a look: ${n(o.blockedOut, "person", "people")} scheduled ${verb(o.blockedOut, "has", "have", "had")} a blockout in Planning Center at their serving time.`);
  if (o.kidsUnsure) lines.push(`Worth a look: ${n(o.kidsUnsure, "kids team")} may ${past ? "have had" : "have"} fewer confirmed people than your Church rules ask.`);
  if (o.leadsUnsure) lines.push(`Worth a look: ${n(o.leadsUnsure, "team")} ${verb(o.leadsUnsure, "has", "have", "had")} a lead scheduled whose answer or serving time couldn't be confirmed.`);
  if (o.handled) lines.push(`You marked ${o.leftOut ? "at least " : ""}${o.handled} as handled yourself.`);
  if (o.keptOnThisMac) lines.push("Some findings are shown only in Ozzie.");
  if (o.unread) lines.push("Worth a look: part of the check couldn't be read, so this may be incomplete.");
  if (o.leftOut) lines.push("Worth a look: the list was too long to say in full, so there may be more than this.");
  return lines;
}

/** A check time later than this Mac's clock by more than this can't be trusted to say how current the check is. */
const CLOCK_ALLOWANCE_MS = 5 * 60 * 1000;

function sundayAnswer(text: string | null, nowMs: number, zone: string): string {
  const check = text === null ? null : parseSharedCheck(text);
  if (!check || check.tasks.length || check.envelopes.length !== 1 || check.envelopes[0]!.tool !== "sunday.overview") return NO_CHECK;
  const checkedMs = isoMillis(check.checked_at);
  const o = overviewOf(check.envelopes[0]!);
  if (checkedMs === null || !o) return NO_CHECK;
  const checked = `Checked in Planning Center ${whenWords(checkedMs, nowMs, zone)}.`;
  // The example was never read from Planning Center, so no check time is said for it (review K2 N2).
  if (o.mode === "fictional") return ["This is Ozzie's fictional example, not a real church; no check of Planning Center is behind it.", ...factLines(o, false)].join(" ");
  // A clock that was fast when the check ran, or has since been put back: how old the check is can't be known.
  if (checkedMs > nowMs + CLOCK_ALLOWANCE_MS) {
    return `The time on Ozzie's last check is later than this Mac's clock, so Ozzie can't tell how current it is. ${checked} Open Ozzie to check again.`;
  }
  const today = local(nowMs, zone).day;
  if (o.sunday && dayNumber(o.sunday) < dayNumber(today)) {
    return `Ozzie's last check was for ${dayWords(o.sunday)}, which has passed. ${checked} Open Ozzie to check the next Sunday.`;
  }
  if (o.mode === "recording") return ["This is from a saved copy of a check, not a live look at Planning Center.", ...factLines(o, true), checked].join(" ");
  if (o.stale) {
    return `Ozzie's last look at Planning Center is too old to say how ${o.sunday ? dayWords(o.sunday) : "the chosen Sunday"} stands. ${checked} Open Ozzie to check again.`;
  }
  // Ozzie treats a live check as current for LIVE_CHECK_VALID_MS; after that its facts are said as they were.
  if (nowMs > checkedMs + LIVE_CHECK_VALID_MS) {
    const [first = "", ...rest] = factLines(o, true);
    const lead = `When Ozzie last checked, ${/^(?:No|None|The|At) /u.test(first) ? first.charAt(0).toLowerCase() + first.slice(1) : first}`;
    return [lead, ...rest, checked, "Things may have changed since then; open Ozzie to see the latest."].join(" ");
  }
  return [...factLines(o, false), checked].join(" ");
}

/** What Ozzie says to `question` (one of QUESTIONS), from the copy for Shortcuts. */
export function shortcutsAnswer(question: string, input: AnswerInput): string {
  if (!(QUESTIONS as readonly string[]).includes(question)) return UNKNOWN_QUESTION;
  if (!input.on) return OFF;
  return sundayAnswer(input.text, input.nowMs, input.timeZone);
}
