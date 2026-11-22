// The answer, written on this Mac (structured answers, review 2026-11-14 section C; build contract §5 and §8). The
// model only chose fact ids from the tool results (verify.ts); every sentence here is Ozzie's own: one fixed template
// per kind of fact, filled with the fact's labels, counts, ISO times and fixed words, so its numbers and times are the
// tool's own and nobody is described, ranked, called willing or said to have been contacted. People are shown in
// label order whatever order the model chose them in, which says nothing about anyone. A draft is only ever the
// drafting tool's own text. Labels and ISO times stay in placeholder form here; the app restores them on this Mac.
//
// Some answers are written here without the AI at all (release-app rehearsal, 2026-11-15; owner decisions "Useful help
// when work cannot be completed"): questions about kids teams and background checks (kidsAnswer), which the AI can't
// answer because background checks never reach it and a team's everyday name ("the nursery") is often no position name;
// and the open decisions a decision question's answer left out (decisionsLeftOut). Both run the same read-only tools on
// this Mac and add background checks from the brief itself, so nothing about one is ever in any request. Their names
// are looked up on this Mac with labels of their own (KeptNames), never minted in the session shared with the AI.
import { dayPage, DRAFT_ASK, mentionsBackgroundCheck } from "../ask.js";
import { fold } from "../draft-request.js";
import { BACKGROUND_CHECKS, BACKGROUND_LINE, backgroundChecksOn, forModels, kidsTeams } from "../kids-rules.js";
import { longDate, SUNDAY_WORDS, type DayWords } from "../service-day.js";
import { rosterNeedsYou, rosterSummary, type Finding, type RosterRole } from "../sunday-brief.js";
import { canRemind } from "../reminder-draft.js";
import { applyDecisions, type DecidedItem } from "../sunday-decisions.js";
import { namesACheck } from "./background-wording.js";
import type { ToolEnvelope } from "./contract.js";
import { parseAnswer, type AnswerKind } from "./fixed.js";
import { checkTime } from "./session.js";
import { FACT_LISTS, localIso, NO_TEAM, OVERVIEW_FOLLOW_UP, OVERVIEW_GROUP, OVERVIEW_ROOM, OVERVIEW_UNCONFIRMED, rowAt, type HarnessData, type HarnessTools, type RowSources, type Scope, type UnverifiedPart } from "./tools.js";
import { SYSTEMS } from "../church-systems/types.js";

export interface ComposedAnswer {
  kind: AnswerKind;
  /** Placeholder-form paragraphs, in the order shown. */
  paragraphs: string[];
  /** The drafting tool's own text, in placeholder form, or null. */
  draft: string | null;
  /** Puts in what only this Mac knows (`OnThisMac`), after the app's restore: `fill(harness.restore(p))`. */
  fill: (shown: string) => string;
}
/**
 * What an answer written on this Mac may look up there (HarnessTools): what a part of the check that couldn't be verified
 * is about. Absent for the copy for other AI apps (core/mcp/render.ts), which says only what its tool results hold.
 */
export interface OnThisMac { unverifiedPart(envelope: ToolEnvelope, row: Record<string, unknown>): UnverifiedPart | null }

type Row = Record<string, unknown>;
interface Fact { id: number; tool: string; list: string | null; row: Row; payload: Row; envelope: number }

/** Lists whose rows are each about one person: shown in label order. */
const PERSON_LISTS: ReadonlySet<string> = new Set(["people", "pending", "leads_not_accepted", "check_ins", "clashes"]);
export const NOT_FREE = "That doesn't mean they're free or willing; only they can say.";
export const NOT_RANKED = "People are listed in no particular order, not ranked.";
export const NOTHING_TO_DECIDE = "Nothing in this check needs a decision right now.";
/** The same, when every overview the answer read was for the services a question named (tools.ts `scope`). */
export const nothingToDecideAt = (where: string) => `Nothing at ${where} needs a decision right now.`;
/** Whether a paragraph, as shown, is NOTHING_TO_DECIDE or its scoped form (restored on this Mac). */
export const isNothingToDecide = (p: string): boolean => p === NOTHING_TO_DECIDE || (p.startsWith("Nothing at ") && p.endsWith(" needs a decision right now."));
export const DRAFT_INTRO = "Here is a draft for you to read, change and send yourself. Nothing has been sent.";
/**
 * An answer the facts don't cover, in Ozzie's voice: the tool is never a person, so never "I" (round 5; the model's own
 * instruction, ask.ts NOT_COVERED, is pinned natively and isn't shown). Then what the check does say, which may be a
 * limit ("Breeze doesn't tie a team to each role…"), so never "what Ozzie did read".
 */
export const CANT_TELL = "Ozzie can't tell from what it read.";
export const NOT_COVERED_MORE = "What the check does say:";
/** The Sunday page's tone for a finding the leader decided, until a later check reopens it (review Q L1). */
const RESOLVED = "Resolved by you";

const str = (v: unknown): string | null => typeof v === "string" ? v : null;
const num = (v: unknown): number | null => typeof v === "number" ? v : null;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const list = (items: readonly string[]) => items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)!}`;
const labels = (v: unknown) => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
const sentence = (s: string) => /[.!?]$/u.test(s) ? s : `${s}.`;
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** The services a scoped result is for (tools.ts `scope`): its `service` labels, in placeholder form; none when unscoped. */
const scopeOf = (p: Row | null | undefined): string[] => typeof p?.["service"] === "string" ? [p["service"]] : labels(p?.["service"]);
/** A church-local ISO time's date and clock ("2026-11-29T10:15-05:00" → 2026-11-29, "10:15 AM"). Null for a UTC time or
 *  anything else, which keeps its full form so the app's restore can say UTC when the church's zone isn't known. */
const LOCAL_TIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})[+-]\d{2}:\d{2}$/u;
const dayClock = (iso: string | null) => {
  const m = iso ? LOCAL_TIME.exec(iso) : null;
  return m ? { day: m[1]!, clock: `${+m[2]! % 12 || 12}:${m[3]!} ${+m[2]! < 12 ? "AM" : "PM"}` } : null;
};
/**
 * Whether a church-local date (YYYY-MM-DD) is the one date the answer's overview sentence already said above ("For Sunday,
 * November 22, …"), so a service time on it is said by its clock alone. NO_DAY: nothing was said, every time keeps its date.
 */
type SaidDay = (day: string) => boolean;
const NO_DAY: SaidDay = () => false;
/** A service time: its clock alone when its date was already said, else the full ISO time the app shows in plain words. */
const timeOf = (iso: string, said: SaidDay) => { const c = dayClock(iso); return c && said(c.day) ? c.clock : iso; };
/** " at <start>" for a service time, or nothing when it isn't known. */
const at = (time: unknown, said: SaidDay = NO_DAY) => {
  const t = (time as Row | null)?.["starts_at"];
  return typeof t === "string" && t !== "not known" ? ` at ${timeOf(t, said)}` : "";
};
/** The one date a span falls on, or null when it crosses midnight or isn't known. */
const dayOf = (time: unknown) => {
  const t = time as Row | null;
  const a = dayClock(str(t?.["starts_at"])), b = dayClock(str(t?.["ends_at"]));
  return a && b && a.day === b.day ? a.day : null;
};
/** A span: "on <date> from <start> to <end>" when it falls on one date, so the date is said once (and not again when
 *  it was `said`); otherwise both times in full. The app shows the date and full times in plain words. */
const fromTo = (time: unknown, said: SaidDay = NO_DAY) => {
  const t = time as Row | null;
  const a = str(t?.["starts_at"]), b = str(t?.["ends_at"]);
  if (!a || !b || a === "not known" || b === "not known") return "at a time that couldn't be read";
  const x = dayClock(a), y = dayClock(b);
  if (x && y && x.day === y.day) return `${said(x.day) ? "" : `on ${x.day} `}from ${x.clock} to ${y.clock}`;
  return `from ${a} to ${b}`;
};
const needs = (row: Row) => {
  const n = num(row["remaining"]);
  return n === null ? "still needs people; Planning Center's count couldn't be read" : `still needs ${n} more ${n === 1 ? "person" : "people"}, by Planning Center's count`;
};
/**
 * With more than one service watched, a role that still needs people at no time Ozzie could read says so, so its count
 * never reads as a second count for a role at a time said beside it (rehearsal of 0.5.2). The check couldn't place it at
 * one time: none is tied to it, several are, or one couldn't be read; in each, Ozzie can't tie it to one. Unchanged with
 * one service.
 */
const untimed = (row: Row, day: Day) => several(day) && at(row["time"]) === "" ? " Ozzie can't tie this role to one service time." : "";
const needsLine = (row: Row, said: SaidDay, day: Day) => `${str(row["role"]) ?? "A role"}${at(row["time"], said)} ${needs(row)}.${untimed(row, day)}`;
const decided = (row: Row, day: Day) => {
  const d = str(row["decision"]);
  if (!d) return "";
  return ` You decided: ${d === NOT_NEEDED ? `not needed ${forService(day)}` : d}.${row["changed_since_decision"] === true ? " A later check changed something, so it's worth a fresh look." : ""}`;
};
const leaders = (row: Row) => {
  const l = row["team_leaders"];
  if (Array.isArray(l)) return l.length ? ` Team leaders in Planning Center: ${list(labels(l))} (oversight of the team, not a serving assignment).` : "";
  return l === "none listed" ? " Planning Center lists no team leader." : l === "couldn't be read" ? " The team leaders couldn't be read." : "";
};
const request = (v: unknown) => v === "request sent, no answer yet" ? "Planning Center shows the request as sent, with no answer yet."
  : v === "request not sent yet" ? "The request hasn't been sent yet." : "Whether the request was sent isn't known.";
const reasons = (row: Row) => { const r = labels(row["reasons"]); return r.length ? `: ${r.join("; ")}` : ""; };
const differs = (row: Row) => row["status_differs_by_time"] === true ? " This differs between service times." : "";
/**
 * A time that says when Ozzie checked or read something: marked so the app says it on this Mac's clock, while every
 * service and role time stays on the church's (session.ts CHECK_TIME). Anything that isn't an ISO time is left as it is.
 */
const checkedAt = (iso: string) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/u.test(iso) ? checkTime(iso) : iso;
const worth = (n: unknown, what: string) => typeof n === "number" && n > 0 ? ` Worth a look: ${plural(n, what, `${what}s`)} couldn't be confirmed.` : "";

// The watched service in a sentence (onboarding spec §5.1, decision 18): its real day from the brief's day words
// ("this Wednesday", "this weekend"), or neutral words when they aren't known. Never a fixed "Sunday": a church may meet
// on Wednesday or Saturday night. `null`: composeAnswer's callers that don't pass the day words.
type Day = DayWords | null;
const oneDay = (d: Day) => d?.kind === "weekday" || d?.kind === "weekend";
/** More than one service watched: the day words of a spread with no date (desktop services-merge.ts MANY_SERVICES). A
 *  single plan over several days always has its dates. */
const several = (d: Day) => d?.kind === "spread" && !d.date;
/** After a verb: "serving this Wednesday", "reached that this weekend"; "at this service" otherwise. */
const atService = (d: Day) => d && oneDay(d) ? d.thisOne : "at this service";
/** After "needed" or a team: "this Wednesday", "this weekend"; "for these services", "for your service", "for this service" otherwise. */
const forService = (d: Day) => d && oneDay(d) ? d.thisOne : `for ${d?.thisOne ?? "this service"}`;
/** What a background check runs out before or on: "Wednesday", "this weekend", "these services". */
const dayName = (d: DayWords) => d.kind === "weekday" ? d.day : d.thisOne;
/** The tools' fixed value for a "not needed" decision (vocabulary.json, pinned with native and ozzie.church); said here in the service's own words. */
const NOT_NEEDED = "not needed this Sunday";
/** The overview's service, as its sentence names it: the day words' date ("Wednesday, November 25"; both dates of a
 *  weekend), else the plan's church-local date with its own weekday, else neutral words. Several services at once (day
 *  words of a spread with no date: desktop services-merge.ts MANY_SERVICES): "your services", and no date, so each item
 *  below says its own service's date. */
const overviewWhen = (p: Row, day: Day) => {
  const scope = scopeOf(p);
  if (scope.length) return list(scope);
  if (day && several(day)) return day.thisOne;
  const date = str(p["sunday"]), planDay = date && /^\d{4}-\d{2}-\d{2}$/u.test(date) ? longDate(date) : null;
  return day?.date ?? (planDay && !planDay.startsWith("Invalid") ? planDay : "this service");
};
/**
 * The overview's counts in the Sunday page's words ("3 things need a decision and 2 are worth a look"), never a count of
 * none (owner's read of 0.3.2). With nothing to decide it says what this check found, as the counts it replaces did:
 * findings kept on this Mac, or reads that didn't complete, are said right after it.
 */
const overviewCounts = (d: number, w: number) => {
  const decide = `${d} ${d === 1 ? "thing needs" : "things need"} a decision`;
  return d && w ? `${decide} and ${w} ${w === 1 ? "is" : "are"} worth a look` : d ? decide
    : w ? `this check found nothing that needs a decision, and ${plural(w, "thing", "things")} worth a look`
      : "this check found nothing that needs a decision or is worth a look";
};

/** The overview's kind for a part of the check that couldn't be verified (tools.ts KIND, vocabulary.json). */
const UNVERIFIED = "part of the check couldn't be verified";
/** For one of the overview's rows: what this Mac knows about it (OnThisMac), and the labels that hold those words until `fill`. */
interface Here { part: UnverifiedPart | null; kept: KeptNames }
/**
 * A part of the check that couldn't be verified. Only facts about roles as the church system lists them, with every read
 * complete and current (sunday-brief.ts role_facts): said as the service's page says them, how many roles and each plain
 * reason, its role named on this Mac (polish 2026-11-21), never as reads that didn't complete. Other reasons of its own,
 * with every read of its own service complete: the page's own reasons, even when another service's reads didn't all
 * complete. Reads that didn't complete: how many, as before. Otherwise never a count of none (0.5.7 said "0 Planning
 * Center reads didn't complete"): that it is out of date, or only that part couldn't be verified.
 */
function unverified(row: Row, here: Here | null): string {
  const n = num(row["reads_not_completed"]) ?? 0, old = row["too_old_to_treat_as_current"] === true;
  const part = here?.part ?? null, keep = (s: string) => here!.kept.part(s);
  const at = part?.service ? `At ${keep(part.service)}, ` : "";
  const reasons = part?.reasons.length ? ` ${keep(part.reasons.map(sentence).join(" "))}` : "";
  if (part?.roles) {
    const roles = part.roles === 1 ? "one role" : `${part.roles} roles`;
    return `${at}${at ? roles : capital(roles)} couldn't be checked.${reasons}`;
  }
  if (reasons) return `${at}${at ? "part" : "Part"} of this check couldn't be verified.${reasons}`;
  if (n > 0) return `Part of this check couldn't be verified: ${plural(n, "Planning Center read", "Planning Center reads")} didn't complete.${old ? " The check is also too old to treat as current." : ""}`;
  if (old) return "Part of this check couldn't be verified: the check is too old to treat as current.";
  return `${at}${at ? "part" : "Part"} of this check couldn't be verified.`;
}

/** A finding in the overview or the open roles, by its kind. */
function finding(row: Row, said: SaidDay = NO_DAY, day: Day = null, here: Here | null = null): string | null {
  const role = str(row["role"]) ?? "A role", person = str(row["person"]) ?? "Someone";
  switch (row["kind"]) {
    case "needs people": return needsLine(row, said, day);
    case "no scheduled lead": return `${role}${at(row["time"], said)} has no scheduled lead, and your Church rules ask for one.`;
    case "lead couldn't be confirmed": return `${role}${at(row["time"], said)} has a scheduled lead, but their answer or serving time couldn't be confirmed.`;
    case "pending": return `${person} is pending for ${role}${at(row["time"], said)}. ${request(row["request"])} Pending is not the same as asked.`;
    case "check-in suggested": {
      const n = num(row["sundays_in_a_row"]);
      return `${person} is scheduled ${n === null ? "several" : n} weeks in a row. Your Church rules suggest a check-in, which is about care, not performance.`;
    }
    case "fewer confirmed than the church rules ask": {
      const c = num(row["confirmed"]) ?? 0, needed = num(row["needed"]), asked = num(row["asked_no_answer"]) ?? 0, unsent = num(row["request_not_sent"]) ?? 0;
      return `${role}${at(row["time"], said)} has ${c ? plural(c, "confirmed person", "confirmed people") : "no confirmed people"}${needed === null ? "" : `, and your Church rules ask for at least ${needed}`}.` +
        `${asked ? ` ${plural(asked, "more is", "more are")} asked with no answer yet.` : ""}${unsent ? ` ${plural(unsent, "more has", "more have")} a request not sent yet.` : ""}` +
        " Pending isn't counted, and Ozzie doesn't check ages.";
    }
    case "scheduled with a blockout at this time": {
      const serving = Array.isArray(row["serving"]) ? row["serving"] as Row[] : [];
      const times = new Set(serving.map(s => str((s["time"] as Row | null)?.["starts_at"]))).size;
      return `${person} is scheduled for ${list(serving.map(s => `${str(s["role"]) ?? "a role"} (${str(s["status"]) ?? "status not known"})${at(s["time"], said)}`)) || "a role"}` +
        ` and has a blockout in Planning Center at ${times > 1 ? "those times" : "that time"}. Planning Center still counts them, so ${serving.length > 1 ? "they aren't open spots" : "it isn't an open spot"}.`;
    }
    case UNVERIFIED: return unverified(row, here);
    // Rooms, follow-ups and group meetings in the overview (tools.ts #operationsShown), as their own tools say them.
    case OVERVIEW_ROOM: return `${str(row["room"]) ?? "A room"} has bookings that overlap ${fromTo(row["overlap"], said)}.`;
    case OVERVIEW_FOLLOW_UP: return followUp(row);
    case OVERVIEW_UNCONFIRMED: return "Some room or follow-up details couldn't be confirmed.";
    case OVERVIEW_GROUP: return groupMeets(row, said);
    default: return null;
  }
}
/** A follow-up with no owner, as followups.unowned and the overview give it. Its due time keeps its date: it isn't the service's. */
const followUp = (row: Row) => {
  const due = str(row["due"]);
  return `${str(row["workflow"]) ?? "A follow-up"}, step ${str(row["step"]) ?? "not known"}, ${due && due !== "not known" ? `was due ${due}` : "is overdue"} and has no owner.`;
};
/** Someone whose group meets while they serve, as groups.clashes and the overview give it. */
const groupMeets = (row: Row, said: SaidDay = NO_DAY) => {
  const person = str(row["person"]) ?? "Someone";
  const serving = (Array.isArray(row["serving"]) ? row["serving"] as Row[] : []).map(s => `${str(s["role"]) ?? "a role"} (${str(s["status"]) ?? "status not known"})${at(s["time"], said)}`);
  const meetings = (Array.isArray(row["group_meetings"]) ? row["group_meetings"] as Row[] : []).map(m => at(m["time"], said).trim()).filter(Boolean);
  return `${person} is scheduled for ${list(serving) || "a role"} while their group meets${meetings.length ? ` ${list(meetings)}` : " at the same time"}.`;
};
/** A finding the leader settled: their decision, and no later check changed it. Listed, never counted as open (tools.ts #overview). */
const settled = (row: Row) => typeof row["decision"] === "string" && row["changed_since_decision"] !== true;
const DECIDE = "Needs a decision", LOOK = "Worth a look";
/** One of the overview's rows in the Sunday page's tone: "Resolved by you" once the leader decided it, as the overview no longer counts it. */
const toneOfRow = (row: Row) => settled(row) ? RESOLVED : row["tone"] === "needs a decision" ? DECIDE : LOOK;
/** One of the overview's rows without its tone, which the answer says once for its group (composeAnswer). */
const overviewRow = (row: Row, day: Day, said: SaidDay = NO_DAY, here: Here | null = null) => { const text = finding(row, said, day, here); return text ? `${text}${decided(row, day)}` : null; };

/** The church systems other than Planning Center a Services tool's source may name (tools.ts HarnessData `source`). */
const OTHER_SYSTEMS: ReadonlySet<string> = new Set(Object.values(SYSTEMS).map(s => s.name));
/** The system an answer's Services facts came from, when it isn't Planning Center: every fact of one answer is one church's. */
const otherSystemOf = (evidence: readonly ToolEnvelope[]): string | null => evidence.find(e => OTHER_SYSTEMS.has(e.source))?.source ?? null;
/**
 * Ozzie's sentences say where Services facts come from as Planning Center; for a church on another system (`system`) the
 * same sentences name it instead ("by B1 Church's count", "B1 Church still counts them"). Planning Center's are unchanged.
 */
const inSystem = (text: string, system: string | null) => system ? text.replace(/Planning Center Services/gu, system).replace(/Planning Center/gu, system) : text;
/** A role no one can be listed for, because the system ties no team to its roles (Breeze). */
const noTeam = (role: string, system: string | null) => `${system ?? "This church system"} doesn't tie a team to each role, so Ozzie can't suggest who could help with ${role}.`;

/** The sentence for one fact: a row of one of a tool's FACT_LISTS, or the payload itself (`list` null). */
function sentenceFor(f: Fact, day: Day, said: SaidDay = NO_DAY, system: string | null = null, here: Here | null = null): string | null {
  const { tool, list: key, row, payload } = f;
  const role = str(row["role"]) ?? "this role", person = str(row["person"]) ?? "Someone";
  if (key === null) {
    if (tool === "sunday.who_could_help" && payload["people_listed"] === NO_TEAM) return noTeam(str((payload["asked_for"] as Row | null)?.["role"]) ?? "this role", system);
    return summary(tool, payload, day);
  }
  switch (`${tool} ${key}`) {
    case "sunday.overview findings": {
      const text = overviewRow(row, day, said, here);
      return text ? `${toneOfRow(row)}: ${text}` : null;
    }
    case "sunday.open_needs needs": {
      if (row["kind"] !== "needs people") { const text = finding(row, said, day); return text ? `${text}${notAccepted(row)}${leaders(row)}${decided(row, day)}` : null; }
      const confirmed = labels(row["confirmed"]);
      const p = (row["people_listed"] ?? {}) as Row;
      const counts = [[p["no_overlap_found"], "with no overlap found"], [p["possible_conflict"], "with a possible conflict"],
        [p["needs_confirmation"], "whose availability needs confirmation"], [p["left_out"], "left out"]]
        .flatMap(([n, what]) => typeof n === "number" && n > 0 ? [`${n} ${what as string}`] : []);
      const none = row["people_listed"] === NO_TEAM ? ` ${noTeam(role, system)}` : "";
      return `${finding(row, said, day)}${confirmed.length ? ` Already confirmed: ${list(confirmed)}.` : ""}${counts.length ? ` On the team: ${list(counts)}.` : ""}${none}${leaders(row)}${decided(row, day)}`;
    }
    case "sunday.who_could_help times": return needsLine(row, said, day);
    // One team's share of the tool's summary, when the role is in more than one service (byTeam).
    case `sunday.who_could_help ${TEAM}`: return `On the team for ${role}, the check listed ${plural(rowsOf({ payload } as ToolEnvelope, "people").filter(p => p["role"] === row["role"]).length, "person", "people")}.`;
    case "sunday.who_could_help people":
      switch (row["status"]) {
        case "no overlap found": return `${person} has no overlap found for ${role}.${differs(row)}`;
        case "availability needs confirmation": return `${person}'s availability for ${role} needs confirmation${reasons(row)}.${differs(row)}`;
        case "possible conflict": return `${person} has a possible conflict for ${role}${reasons(row)}.${differs(row)}`;
        case "left out": return `${person} was left out for ${role}${reasons(row)}.${differs(row)}`;
        default: return null;
      }
    case "sunday.pending_requests pending": return `${person} is pending for ${role}${at(row["time"], said)}. ${request(row["request"])}`;
    case "sunday.pending_requests leads_not_accepted": return `${person} is scheduled to lead ${role} but hasn't accepted.`;
    case "sunday.rule_checkins check_ins": {
      const n = num(row["sundays_in_a_row"]);
      return `${person} is scheduled ${n === null ? "several" : n} weeks in a row; a check-in is about care, not performance.`;
    }
    case "rooms.conflicts rooms": {
      const room = str(row["room"]) ?? "A room";
      // The overlap's date is said once; a booking on that same date doesn't say it again.
      const day = dayOf(row["overlap"]);
      const bookings = (Array.isArray(row["bookings"]) ? row["bookings"] as Row[] : []).map(b => `${fromTo(b["time"], d => d === day)} (${str(b["approval"]) ?? "approval not known"})`);
      const setup = num(row["setup_minutes"]);
      const rule = row["church_rule"] === "not shared" ? " Your Church rules say this room isn't shared." : " No room rule is set for it.";
      const worked = row["worked_out_in_planning_center"] === "not worked out" ? " Planning Center doesn't show it as worked out." : " Whether it was worked out couldn't be read.";
      // The Sunday page's own label: confirmed by a Church rule and Calendar's conflict record, or Worth a look.
      const tone = row["label"] === "Room use needs review" ? "Room use needs review" : "Worth a look";
      return `${tone}: ${room} has bookings that overlap ${fromTo(row["overlap"], said)}${bookings.length ? `; the bookings are ${list(bookings)}` : ""}${setup ? `, with ${setup} minutes of setup time` : ""}.${rule}${worked}`;
    }
    case "followups.unowned follow_ups": return followUp(row);
    case "groups.clashes clashes": return `Worth a look: ${groupMeets(row, said)}`;
    case "today.attention items": {
      const contacted = row["volunteers_contacted"] === "not contacted, according to the message" ? " The message says volunteers have not been contacted." : "";
      return `${row["label"] === "Needs a decision" ? "Needs a decision" : "Worth a look"}: ${str(row["event"]) ?? "An event"}${at({ starts_at: row["starts_at"] })}. ${sentence(capital(str(row["kind"]) ?? "something needs a look"))}${contacted}`;
    }
    default: return null;
  }
}
const notAccepted = (row: Row) => { const p = labels(row["scheduled_to_lead_not_accepted"]); return p.length ? ` Scheduled to lead but hasn't accepted: ${list(p)}.` : ""; };

/** The sentence for a tool's own summary (the payload's fact). */
function summary(tool: string, p: Row, day: Day): string | null {
  const status = str(p["status"]);
  if (status === "not granted") {
    const what = tool === "rooms.conflicts" ? "Rooms" : tool === "followups.unowned" ? "Follow-ups" : "Group meetings";
    return `${what} aren't part of this Planning Center connection.`;
  }
  switch (tool) {
    case "sunday.overview": {
      const d = num(p["needs_a_decision"]) ?? 0, w = num(p["worth_a_look"]) ?? 0, failed = num(p["reads_not_completed"]) ?? 0;
      const mode = p["mode"] === "recording" ? " This is a saved copy of a check, not a current check." : p["mode"] === "fictional" ? " This is fictional example data." : "";
      // Background checks never reach the tools, so the counts above leave them out; said so, as the service's page counts
      // them, so the two counts never read as a contradiction and "nothing" never reads as an all clear (review of 0.3.2 wording).
      const kept = p["kept_on_this_mac"] === "some findings are shown only in Ozzie on this Mac" ? ` Some findings are shown only in Ozzie on this Mac${day ? `, on ${dayPage(day)},` : ""} and aren't counted here.` : "";
      return `For ${overviewWhen(p, day)}, ${overviewCounts(d, w)}.${failed ? ` ${plural(failed, "Planning Center read", "Planning Center reads")} didn't complete.` : ""}${kept}${mode}`;
    }
    case "sunday.open_needs": {
      const rows = Array.isArray(p["needs"]) ? p["needs"] as Row[] : [];
      const open = rows.filter(r => r["kind"] === "needs people").length, lead = rows.filter(r => r["kind"] === "no scheduled lead").length;
      // For the services a question named: said first (tools.ts `scope`).
      const scope = scopeOf(p), found = scope.length ? `At ${list(scope)}, this check found` : "This check found";
      if (!open && !lead) return `${found} no role that still needs people, and none without a scheduled lead.`;
      // A count of none isn't said (owner's read of 0.3.2): "and 0 with no scheduled lead" adds nothing.
      const people = `${plural(open, "role", "roles")} that still need${open === 1 ? "s" : ""} people`;
      return `${found} ${open && lead ? `${people} and ${lead} with no scheduled lead` : open ? people : `${plural(lead, "role", "roles")} with no scheduled lead`}.`;
    }
    case "sunday.who_could_help": {
      // For the services a question named, the role as its one team's own label, which restores with its service.
      const scope = scopeOf(p), own = teamsIn(p), at = scope.length ? ` at ${list(scope)}` : "";
      const role = (scope.length && own.length === 1 ? own[0] : null) ?? (scope.length ? str(p["role"]) : null) ?? str((p["asked_for"] as Row | null)?.["role"]) ?? "This role";
      if (p["open_need"] === "none in the last check") return `${role} has no open need${at} in the last check.`;
      // A church system's role whose need the check couldn't tell (tools.ts `#whoCouldHelp`, review of round 4, M1).
      if (p["open_need"] === "not known") return `The check couldn't tell whether ${role} needs anyone${at}, so Ozzie doesn't list anyone for it.`;
      // Everyone the check listed, those left out of a copy cut to fit included. No order is named: the app's card shows
      // them alphabetically and Ask in person-id order, each saying so beside the people it shows (review K).
      const n = (Array.isArray(p["people"]) ? p["people"].length : 0) + (num(p["left_out_for_length"]) ?? 0);
      // The role in more than one service, with people left out for length: which team they were on isn't known, so the
      // count is said once for every team (otherwise each team's own count is said with its lines, byTeam). The rows are
      // each team's, so someone on two of them is two rows: said so, never a count of people that may be too high.
      const teams = teamsIn(p);
      if (teams.length > 1) return `On the teams for ${list(teams)}, the check listed ${plural(n, "person", "people")}, counting anyone on more than one of these teams once for each team.`;
      return `On the team for ${role}, the check listed ${plural(n, "person", "people")}.`;
    }
    case "sunday.pending_requests": {
      const n = Array.isArray(p["pending"]) ? p["pending"].length : 0, m = Array.isArray(p["leads_not_accepted"]) ? p["leads_not_accepted"].length : 0;
      const scope = scopeOf(p);
      return `${scope.length ? `At ${list(scope)}, ` : ""}Planning Center shows ${plural(n, "pending request", "pending requests")} and ${plural(m, "scheduled lead", "scheduled leads")} who ${m === 1 ? "hasn't" : "haven't"} accepted. Pending means not accepted yet, which is not the same as asked.`;
    }
    case "sunday.rule_checkins": {
      const t = p["check_in_after_sundays_in_a_row"], n = Array.isArray(p["check_ins"]) ? p["check_ins"].length : 0;
      if (t === "off") return "Check-ins are turned off in your Church rules.";
      const scope = scopeOf(p);
      return `Your Church rules suggest a check-in after ${typeof t === "number" ? t : "several"} weeks in a row; ${plural(n, "person", "people")} reached that ${scope.length ? `at ${list(scope)}` : atService(day)}.`;
    }
    case "sunday.not_checked": {
      const reads = num(p["reads"]) ?? 0, failed = num(p["reads_not_completed"]) ?? 0;
      const lines = [...labels(p["services"]), ...labels(p["rooms_follow_ups_groups"])].map(sentence);
      // For the services a question named, said first (tools.ts `scope`).
      const scope = scopeOf(p), at = scope.length ? `At ${list(scope)}, ` : "";
      return [failed ? `${at}${at ? "of" : "Of"} ${reads} Planning Center reads, ${failed} didn't complete.` : `${at}${at ? "all" : "All"} ${reads} Planning Center reads completed.`,
        ...(p["too_old_to_treat_as_current"] === true ? ["This check is too old to treat as current."] : []), ...lines].join(" ");
    }
    case "rooms.conflicts": {
      const n = Array.isArray(p["rooms"]) ? p["rooms"].length : 0;
      const head = status === "room use needs review" ? `${plural(n, "room booking overlap", "room booking overlaps")} need${n === 1 ? "s" : ""} review.`
        : status === "no overlap found" ? "No room booking overlaps were found." : "Room bookings weren't fully checked, so this isn't the same as no overlap.";
      return `${head}${worth(p["worth_a_look"], "room detail")}`;
    }
    case "followups.unowned": {
      const n = Array.isArray(p["follow_ups"]) ? p["follow_ups"].length : 0;
      const head = status === "needs an owner" ? `${plural(n, "overdue follow-up has", "overdue follow-ups have")} no owner.`
        : status === "no unowned overdue follow-ups found" ? "No overdue follow-ups without an owner were found." : "Follow-ups weren't fully checked, so this isn't the same as none overdue.";
      return `${head}${worth(p["worth_a_look"], "follow-up detail")}`;
    }
    case "groups.clashes": {
      const n = Array.isArray(p["clashes"]) ? p["clashes"].length : 0;
      const serving = atService(day);
      return status === "group meets while serving" ? `${plural(n, `person serving ${serving} has`, `people serving ${serving} have`)} a group meeting at the same time.`
        : status === "no clash found" ? `No one serving ${serving} has a group meeting at the same time.` : "Group meetings weren't fully checked, so this isn't the same as no clash.";
    }
    case "today.attention": {
      const s = status === "needs a decision" ? "something needs a decision" : status === "worth a look" ? "something is worth a look" : "nothing needs attention";
      const gaps = num(p["gaps"]);
      // When it was imported: a time Ozzie read something, said on this Mac's clock (session.ts CHECK_TIME).
      return `In the fictional email and calendar import${str(p["imported_at"]) && p["imported_at"] !== "not known" ? ` from ${checkedAt(str(p["imported_at"])!)}` : ""}, ${s}.${gaps ? " Part of the import needs a closer look." : ""}`;
    }
    case "rules.current": {
      const t = p["check_in_after_sundays_in_a_row"];
      const leads = (Array.isArray(p["sunday_leads"]) ? p["sunday_leads"] as Row[] : []).flatMap(l => str(l["lead_role"]) ?? []);
      const rooms = (Array.isArray(p["rooms"]) ? p["rooms"] as Row[] : []).map(r => `${str(r["room"]) ?? "A room"} isn't shared${num(r["setup_minutes"]) ? `, with ${num(r["setup_minutes"])!} minutes of setup time` : ""}.`);
      // The lead rule as Church rules names it: "a scheduled Wednesday lead", or "a scheduled lead" (sunday-brief.ts dayLead).
      const lead = day?.kind === "weekday" ? `scheduled ${day.day} lead` : "scheduled lead";
      return [t === "off" ? "Your Church rules don't suggest check-ins." : `Your Church rules suggest a check-in after ${typeof t === "number" ? t : "several"} weeks in a row.`,
        leads.length ? `They ask for a ${lead} for ${list(leads)}.` : `They don't ask for a ${lead}.`, ...rooms].join(" ");
    }
    case "planning_center.refresh": {
      if (status !== "checked again") return "The last Planning Center check is current, so Ozzie didn't need to check again.";
      // Never "0 didn't complete" (0.5.7): reads that didn't complete are counted only when there are some.
      const reads = num(p["reads"]) ?? 0, failed = num(p["reads_not_completed"]) ?? 0;
      return failed ? `Ozzie checked Planning Center again: ${plural(reads, "read", "reads")}, ${failed} didn't complete.`
        : reads > 1 ? `Ozzie checked Planning Center again: all ${reads} reads completed.` : reads === 1 ? "Ozzie checked Planning Center again: its one read completed."
          : "Ozzie checked Planning Center again.";
    }
    case "drafts.prepare_note": return "No draft was prepared, because that person isn't listed for an open need of this role.";
    default: return null;
  }
}

const idNumber = (id: unknown) => typeof id === "string" ? Number(id.slice(1)) : NaN;
const labelNumber = (label: unknown) => typeof label === "string" ? Number(/\d+/u.exec(label)?.[0] ?? NaN) : NaN;

/** Every fact the evidence holds, by id, with where it sits. */
function factsIn(evidence: readonly ToolEnvelope[]): Map<string, Fact> {
  const out = new Map<string, Fact>();
  evidence.forEach((e, envelope) => {
    const payload = e.payload as Row | null;
    if (!payload || typeof payload !== "object") return;
    if (typeof payload["fact"] === "string") out.set(payload["fact"], { id: idNumber(payload["fact"]), tool: e.tool, list: null, row: payload, payload, envelope });
    for (const key of FACT_LISTS[e.tool as keyof typeof FACT_LISTS] ?? []) {
      const rows = payload[key];
      if (Array.isArray(rows)) for (const row of rows as Row[]) if (row && typeof row["fact"] === "string") out.set(row["fact"], { id: idNumber(row["fact"]), tool: e.tool, list: key, row, payload, envelope });
    }
  });
  return out;
}
/** Ozzie's order: the order the tools gave the facts in, with each list of people in label order. Never the model's. */
function ordered(facts: readonly Fact[]): Fact[] {
  const byId = [...facts].sort((a, b) => a.id - b.id);
  const group = (f: Fact) => f.list !== null && PERSON_LISTS.has(f.list) ? `${f.envelope}:${f.list}` : `#${f.id}`;
  const first = new Map<string, number>();
  for (const f of byId) if (!first.has(group(f))) first.set(group(f), f.id);
  return byId.sort((a, b) => first.get(group(a))! - first.get(group(b))! ||
    (labelNumber(a.row["person"]) || 0) - (labelNumber(b.row["person"]) || 0) || a.id - b.id);
}

/** The list name of one team's share of who could help's summary (byTeam); never a list any tool gives. */
const TEAM = "team";
/**
 * The role labels a who-could-help result is about, in its order: one, or with more than one service watched one per
 * team when the role is in more than one service (tools.ts #byTeam), each restored with its own service on this Mac.
 */
function teamsIn(p: Row): string[] {
  const rows = [...(Array.isArray(p["times"]) ? p["times"] as Row[] : []), ...(Array.isArray(p["people"]) ? p["people"] as Row[] : [])];
  return [...new Set(rows.flatMap(r => str(r["role"]) ?? []))];
}
/**
 * A who-could-help result about more than one team (one role in more than one service watched), said one team at a time:
 * that team's share of the summary ("On the team for Greeter (Youth Night), the check listed 3 people."), its times, then
 * its people, so every line about one service sits together. A summary with people left out for length stays one sentence
 * for every team, first (summary). Every other fact, and a result about one team, keeps Ozzie's order.
 */
function byTeam(chosen: readonly Fact[]): Fact[] {
  const out: Fact[] = [], done = new Set<number>();
  for (const f of chosen) {
    const teams = f.tool === "sunday.who_could_help" ? teamsIn(f.payload) : [];
    if (teams.length < 2) { out.push(f); continue; }
    if (done.has(f.envelope)) continue;
    done.add(f.envelope);
    const mine = chosen.filter(g => g.envelope === f.envelope), summary = mine.find(g => g.list === null);
    const shared = summary && (num(summary.payload["left_out_for_length"]) ?? 0) > 0;
    if (summary && shared) out.push(summary);
    for (const team of teams) {
      if (summary && !shared) out.push({ ...summary, list: TEAM, row: { role: team } });
      out.push(...mine.filter(g => g.list === "times" && g.row["role"] === team), ...mine.filter(g => g.list === "people" && g.row["role"] === team));
    }
    out.push(...mine.filter(g => g.list !== null && !teams.includes(str(g.row["role"]) ?? "")));
  }
  return out;
}

const isLead = (f: Fact) => f.tool === "sunday.overview" && f.list === null;
/**
 * The one date the overview's sentence names ("For Sunday, November 22, …"), so a time on it below can be said by its clock
 * alone. NO_DAY when no overview sentence is said, it names no single date (a weekend's two, "this service"), or two
 * overviews name different ones.
 */
function saidBy(leads: readonly Row[], day: Day): SaidDay {
  const whens = new Set(leads.map(p => overviewWhen(p, day)));
  const when = whens.size === 1 ? [...whens][0]! : null;
  return when ? (d: string) => longDate(d) === when : NO_DAY;
}
/**
 * Whether a fact is the open roles' own summary ("This check found 2 roles that still need people.") and the answer's
 * other lines already say every role it counts, in full (owner's read of 0.3.2): then it adds nothing and isn't said. It
 * is said whenever it adds a fact: a role it counts that no line says, or rows left out of it for length.
 */
function repeatsRows(f: Fact, chosen: readonly Fact[]): boolean {
  if (f.tool !== "sunday.open_needs" || f.list !== null || (num(f.payload["left_out_for_length"]) ?? 0) > 0) return false;
  const counted = rowsOf({ payload: f.payload } as ToolEnvelope, "needs").filter(r => r["kind"] === "needs people" || r["kind"] === "no scheduled lead");
  const said = new Set(chosen.filter(g => g !== f).flatMap(keysOf));
  return counted.length > 0 && counted.every(r => said.has(findingKey(str(r["kind"]), r)));
}
/**
 * The overview's rows an answer says, grouped as the Sunday page groups them (needs a decision, worth a look, then what the
 * leader resolved), each group under one short label line rather than a label on every row (owner's read of 0.3.2), in the
 * overview's order within each group. With the overview's sentence said above (`lead`), no label when that sentence
 * already says what every row is: it counts only decisions and every row needs one, or only worth a look and every row is.
 * `last`: nothing but the closing notes follows. Otherwise a line after the group (another tool's follow-up or pending
 * request, which has no tone of its own) would read as part of it, so each row keeps its own label, as it always did.
 */
function grouped(rows: readonly { tone: string; text: string }[], lead: Row | null, last: boolean): string[] {
  if (!last) return rows.map(r => `${r.tone}: ${r.text}`);
  const tones = [DECIDE, LOOK, RESOLVED].filter(t => rows.some(r => r.tone === t));
  const d = num(lead?.["needs_a_decision"]) ?? 0, w = num(lead?.["worth_a_look"]) ?? 0;
  const plain = lead !== null && tones.length === 1 && (tones[0] === DECIDE ? d > 0 && w === 0 : tones[0] === LOOK && d === 0 && w > 0);
  return tones.flatMap(t => [...(plain ? [] : [`${t}:`]), ...rows.filter(r => r.tone === t).map(r => r.text)]);
}

/**
 * Ozzie's lines for the chosen facts, in Ozzie's order, the notes said after them, and what puts in the words only this
 * Mac knows (`local`, held as labels of their own until then; nothing to put in without it).
 */
function composeLines(facts: readonly string[], evidence: readonly ToolEnvelope[], day: Day, local: OnThisMac | null = null): { lines: string[]; after: string[]; fill: (shown: string) => string } {
  const system = otherSystemOf(evidence);
  const all = factsIn(evidence);
  const picked = facts.flatMap(id => all.get(id) ?? []);
  const onMac = new KeptNames();
  const here = (f: Fact): Here | null => local && f.tool === "sunday.overview" && f.list === "findings" && f.row["kind"] === UNVERIFIED
    ? { part: local.unverifiedPart(evidence[f.envelope]!, f.row), kept: onMac } : null;
  // A room or follow-up chosen both from the overview and from its own tool is said once, in its own tool's fuller words.
  const ownRows = new Set(picked.filter(f => f.tool !== "sunday.overview" && f.list !== null).flatMap(keysOf));
  const chosen = byTeam(ordered(picked.filter(f => !(f.tool === "sunday.overview" && f.list === "findings"
    && (f.row["kind"] === OVERVIEW_ROOM || f.row["kind"] === OVERVIEW_FOLLOW_UP) && keysOf(f).some(k => ownRows.has(k))))));
  // Each fact's sentence as it was always written (`key`, with every date and each overview row's own tone), which decides
  // what is said once; what is shown can leave out what the answer already said.
  const rendered = chosen.flatMap(f => {
    if (repeatsRows(f, chosen)) return [];
    const key = sentenceFor(f, day, NO_DAY, system, here(f));
    return key ? [{ f, key }] : [];
  });
  // Two tools can describe the same need: a sentence said in full at the start of a longer one (or said twice) is
  // shown once, in the longer sentence's place. One team's time and count when the role is in more than one service
  // (byTeam) keeps its place among that team's lines instead, said in the open roles' fuller words, so every line about
  // one service still sits together.
  const fuller = new Map<number, number>();
  rendered.forEach((r, i) => {
    if (r.f.tool !== "sunday.who_could_help" || r.f.list !== "times" || teamsIn(r.f.payload).length < 2) return;
    const j = rendered.findIndex((o, k) => k !== i && o.f.tool === "sunday.open_needs" && o.key.startsWith(`${r.key} `));
    if (j >= 0 && ![...fuller.values()].includes(j)) fuller.set(i, j);
  });
  const moved = new Set(fuller.values());
  const kept = rendered.flatMap((r, i) => fuller.has(i) ? [rendered[fuller.get(i)!]!] : moved.has(i) ? []
    : rendered.some((o, j) => j !== i && (o.key === r.key ? j < i : o.key.startsWith(`${r.key} `))) ? [] : [r]);
  // The overview's own sentence, as shown: the date it names isn't said again by a time on it after it.
  const leads = new Map(kept.filter(r => isLead(r.f)).map(r => [r.f.envelope, r.f.payload]));
  const from = kept.findIndex(r => isLead(r.f)), onDay = saidBy([...leads.values()], day);
  const said = (i: number) => from >= 0 && i > from ? onDay : NO_DAY;
  // The overview's rows stand together where its first one stands, grouped by tone (grouped).
  const entries: ({ text: string } | { block: number })[] = [];
  const blocks = new Map<number, { tone: string; text: string }[]>();
  kept.forEach((r, i) => {
    if (r.f.tool === "sunday.overview" && r.f.list === "findings") {
      const text = overviewRow(r.f.row, day, said(i), here(r.f));
      if (!text) return;
      if (!blocks.has(r.f.envelope)) { blocks.set(r.f.envelope, []); entries.push({ block: r.f.envelope }); }
      blocks.get(r.f.envelope)!.push({ tone: toneOfRow(r.f.row), text });
      return;
    }
    const text = sentenceFor(r.f, day, said(i), system);
    if (text) entries.push({ text });
  });
  const lines = entries.flatMap((e, i) => "text" in e ? [e.text] : grouped(blocks.get(e.block)!, leads.get(e.block) ?? null, i === entries.length - 1))
    .map(line => inSystem(line, system));
  const people = rendered.filter(r => r.f.list !== null && PERSON_LISTS.has(r.f.list));
  const after = [
    ...(rendered.some(r => r.f.tool === "sunday.who_could_help" && r.f.row["status"] === "no overlap found") ? [NOT_FREE] : []),
    ...(people.length > 1 ? [NOT_RANKED] : []),
  ];
  return { lines, after, fill: onMac.fill };
}

/**
 * Every fact named, as an answer choosing them all would say them, without an answer's limit on how many: for the copy
 * shared with other AI apps (core/mcp/render.ts), which says every fact a tool result holds in one piece, so the overview's
 * rows are grouped once under its sentence. Placeholder form, and only what the results hold: nothing this Mac alone knows.
 */
export function composeFacts(facts: readonly string[], evidence: readonly ToolEnvelope[], day: DayWords | null = null): string[] {
  const { lines, after } = composeLines(facts, evidence, day);
  return lines.length ? [...lines, ...after] : [];
}

/**
 * The paragraphs for a verified answer (verify.ts), in placeholder form. A fact without a sentence is left out rather
 * than guessed at; an answer left with nothing to say says what wasn't covered. `day`: the watched service's day words
 * (the brief's `day`), so the answer names its real day and page; without them it uses the plan's date and neutral words,
 * never a fixed Sunday (decision 18). `local`: on this Mac, what it may look up there (OnThisMac), put in by `fill`.
 */
export function composeAnswer(answer: string, evidence: readonly ToolEnvelope[], day: DayWords | null = null, local: OnThisMac | null = null): ComposedAnswer {
  const parsed = parseAnswer(answer);
  const as = (shown: string) => shown;
  if (!parsed) return { kind: "not-covered", paragraphs: [CANT_TELL], draft: null, fill: as };
  const { lines, after, fill } = composeLines(parsed.facts, evidence, day, local);
  let draft: string | null = null;
  if (parsed.draft) {
    const drafted = evidence.find(e => (e.payload as Row | null)?.["draft_id"] === parsed.draft);
    draft = str((drafted?.payload as Row | undefined)?.["draft"]);
  }
  switch (parsed.answer) {
    case "facts":
      return lines.length ? { kind: "facts", paragraphs: [...lines, ...after], draft: null, fill } : { kind: "not-covered", paragraphs: [CANT_TELL], draft: null, fill: as };
    case "not-covered":
      return { kind: "not-covered", paragraphs: [CANT_TELL, ...(lines.length ? [NOT_COVERED_MORE, ...lines, ...after] : [])], draft: null, fill };
    case "nothing-needs-a-decision": {
      // Every overview it read was for the services the question named: said for them, never for the whole check.
      const scopes = evidence.filter(e => e.tool === "sunday.overview").map(e => scopeOf(e.payload as Row));
      const where = scopes.length && scopes.every(x => x.length) ? list([...new Set(scopes.flat())]) : null;
      return { kind: "nothing-needs-a-decision", paragraphs: [where ? nothingToDecideAt(where) : NOTHING_TO_DECIDE, ...lines, ...after], draft: null, fill };
    }
    case "draft":
      return draft ? { kind: "draft", paragraphs: [DRAFT_INTRO, ...lines, ...after], draft, fill } : { kind: "not-covered", paragraphs: [CANT_TELL], draft: null, fill: as };
  }
}

/** The source each of the overview's room, follow-up and group-meeting rows comes from (tools.ts #operationsShown). */
const ROW_SOURCES: Readonly<Record<string, string>> = {
  [OVERVIEW_ROOM]: "Planning Center Calendar", [OVERVIEW_FOLLOW_UP]: "Planning Center People", [OVERVIEW_GROUP]: "Planning Center Groups",
};
/**
 * Where one of the overview's rows comes from beyond Planning Center Services: Calendar for a room, People for a
 * follow-up, Groups for a group meeting, and for the row about room or follow-up details that couldn't be confirmed, the
 * sources its open questions are about (`unconfirmed`). None for a Services row.
 */
export function overviewRowSources(row: Row, unconfirmed: readonly string[]): string[] {
  const kind = str(row["kind"]) ?? "";
  return kind === OVERVIEW_UNCONFIRMED ? [...unconfirmed] : ROW_SOURCES[kind] ? [ROW_SOURCES[kind]] : [];
}
/**
 * Where the overview's rooms, follow-ups and group meetings an answer chose come from (review item 5), at the operations
 * check's own read time and with each source's own completeness (`rows`, tools.ts rowSources; the overview's own when
 * unknown): the overview's source is Planning Center Services, so without these "Based on" wouldn't name the source of a
 * follow-up it says, and a Calendar read that didn't complete would go unsaid beside the room it left uncertain.
 */
export function chosenSources(answer: string, evidence: readonly ToolEnvelope[], rows: RowSources | null): Pick<ToolEnvelope, "source" | "check_time" | "completeness">[] {
  const all = factsIn(evidence), out: Pick<ToolEnvelope, "source" | "check_time" | "completeness">[] = [];
  const unconfirmed = rows?.unconfirmed ?? ["Planning Center Calendar", "Planning Center People"];
  for (const id of parseAnswer(answer)?.facts ?? []) {
    const f = all.get(id);
    if (!f || f.tool !== "sunday.overview" || f.list !== "findings") continue;
    const envelope = evidence[f.envelope]!;
    for (const source of overviewRowSources(f.row, unconfirmed)) {
      if (!out.some(s => s.source === source)) out.push({ source, check_time: rows?.check_time ?? envelope.check_time, completeness: rows?.completeness[source] ?? envelope.completeness });
    }
  }
  return out;
}

// ---- Answers written on this Mac, without the AI -------------------------------------------------------------------

/** Said with each finding Ozzie keeps on this Mac (background checks, review M2/M3): shown here, never in any AI request. */
export const KEPT_HERE = "Kept on this Mac; never sent to an AI.";
export const NO_KIDS_TEAM = "No kids team is marked in your Church rules, so Ozzie doesn't count confirmed people or check background checks for one. You can mark one in Church rules, under Kids teams.";
export const BACKGROUND_OFF = "The background-check rule is off in your Church rules, so Ozzie didn't check background checks.";
export const BACKGROUND_UNCONFIRMED = "This check couldn't confirm background checks for everyone scheduled on your kids teams.";
/** Said only when the check supports it exactly (review Q H1): see kidsAnswer. */
export const BACKGROUND_ON_FILE = "This check found no one confirmed or pending on your kids teams without a current background check in Planning Center People.";
/** Nobody on a kids team, in the service's words: "this Wednesday", "this weekend", "for these services". */
export const nobodyScheduled = (d: DayWords) => `No one is confirmed or pending on your kids teams ${forService(d)}, so there were no background checks to look at.`;
export const NOBODY_SCHEDULED = nobodyScheduled(SUNDAY_WORDS);
export const MEMBERS_UNREAD = "Background checks weren't checked, because who is scheduled didn't fully load.";
export const KIDS_MEMBERS_UNREAD = "Who is scheduled on your kids teams didn't fully load, so this isn't a full picture.";
export const WHICH_TEAM = "Ozzie couldn't tell which kids team you mean. Ask about a team by its name.";
/** Before the open decisions a decision question's answer left out, naming the service's page by its real day. */
export const alsoOnPage = (d: DayWords) => `Also on ${dayPage(d)}, needing a decision:`;
/** Before the open decisions, when they are the whole answer (a decision question that also names background checks). */
export const onPage = (d: DayWords) => `On ${dayPage(d)}, needing a decision:`;
/** The fictional Sunday's words, kept for the app's fixed text that names this heading (harness-words.ts). */
export const ALSO_ON_SUNDAY = alsoOnPage(SUNDAY_WORDS);
export const ON_SUNDAY = onPage(SUNDAY_WORDS);
export const NOTHING_OPEN = "This check found nothing open that needs a decision.";
/** The same for the services a question named, by their labels (placeholder form; review B, F5). */
export const nothingOpenAt = (labels: readonly string[]) => `This check found nothing open at ${list(labels)} that needs a decision.`;
/** Findings set aside with "This isn't right" or "Stop flagging this", in the service page's words: counted, never dropped. */
export const setAside = (n: number, what = "finding", d: DayWords = SUNDAY_WORDS) => n === 1
  ? `One ${what} is set aside by your Church rules, so it isn't listed here; it's on ${dayPage(d)}.`
  : `${n} ${what}s are set aside by your Church rules, so they aren't listed here; they're on ${dayPage(d)}.`;

/** What an answer written here holds, and what it was written from. */
export interface LocalAnswer {
  /** Paragraphs in the order shown: shared labels in placeholder form (the app restores them), and kept names as KeptNames labels. */
  paragraphs: string[];
  /** Puts kept names in, after the app's restore: `fill(harness.restore(p))`. */
  fill: (shown: string) => string;
  /** The read-only tool results it was written from, run on this Mac (never sent anywhere). */
  evidence: ToolEnvelope[];
  /** Its other sources and their check times: background checks kept on this Mac, and the Church rules. */
  sources: { source: string; check_time: string }[];
  /** "Worth a look" lines: the kids lines of What I didn't check, and why a background check couldn't be confirmed. */
  gaps: string[];
}

/**
 * Names for findings kept on this Mac (review Q L2): a label family of their own ("[Kept person 1]"), which the shared
 * session never issues and the app's restore leaves alone, filled in from the check's own names afterwards. So composing a
 * background-check answer never adds or reorders labels shared with the AI or with the copy for other AI apps.
 */
class KeptNames {
  readonly #shown: string[] = [];
  #label(kind: string, shown: string) {
    let n = this.#shown.indexOf(shown);
    if (n < 0) { this.#shown.push(shown); n = this.#shown.length - 1; }
    return `[Kept ${kind} ${n + 1}]`;
  }
  person(data: HarnessData, id: string | undefined) { return this.#label("person", (id && data.capture?.names[id]?.trim()) || "a team member"); }
  role(name: string | undefined) { return this.#label("role", name?.trim() || "a kids team"); }
  /** Words only this Mac knows, said as they are: a part of the check's plain reasons, a service's name (OnThisMac). */
  part(text: string) { return this.#label("part", text); }
  readonly fill = (text: string) => text.replace(/\[Kept (?:person|role|part) ([1-9]\d{0,3})\]/gu, (whole, n: string) => this.#shown[+n - 1] ?? whole);
}

type Kind = Finding["kind"];
const NEED_KINDS: ReadonlySet<Kind> = new Set<Kind>(["needs-people", "lead-missing", "lead-unverified"]);
const RULES_SOURCE = "Church rules on this Mac";
const PEOPLE_SOURCE = "Planning Center People";
const toneOf = (f: Finding) => f.tone === "decision" ? "Needs a decision" : "Worth a look";
/** The Sunday page's tone, with a leader's decision: "Resolved by you" until a later check reopens it (review Q L1). */
const toneWith = (f: Finding, decided: ReadonlyMap<string, DecidedItem>) => {
  const d = decided.get(f.id);
  return d?.decision && d.state !== "reopened" ? RESOLVED : toneOf(f);
};
const rowsOf = (e: ToolEnvelope | null, key: string): Row[] => { const v = (e?.payload as Row | undefined)?.[key]; return Array.isArray(v) ? v as Row[] : []; };
const factOf = (e: ToolEnvelope, list: string | null, row: Row): Fact => ({ id: idNumber(row["fact"]), tool: e.tool, list, row, payload: e.payload as Row, envelope: 0 });
let localRuns = 0;
/** Each answer written here numbers its facts afresh, as a task does, so ids never run past the grammar's four digits. */
const localTask = () => `local-${++localRuns}`;
/** The read-only tools on this Mac; a tool that can't read gives nothing, as it would give the AI nothing. */
function reader(tools: HarnessTools, signal: AbortSignal, scope: Scope = []) {
  const task = localTask();
  return async (name: string, args: Record<string, unknown> = {}): Promise<ToolEnvelope | null> => {
    try { return await tools.run(name, args, signal, task, scope); } catch { return null; }
  };
}
/** The watched service's day words; a brief built by hand (a test) has none, and gets the Sunday words (sunday-brief.ts). */
const serviceDay = (data: HarnessData): DayWords => data.brief?.day ?? SUNDAY_WORDS;
/** Sources once each, in the order first given. */
const once = (list: { source: string; check_time: string }[]) => list.filter((s, i) => list.findIndex(o => o.source === s.source && o.check_time === s.check_time) === i);

/**
 * A background-check finding in the Sunday page's words, in placeholder form, with its source and check time and that
 * it stays on this Mac. Never part of any tool result or request (forModels); the app restores it here.
 */
export function backgroundSentence(f: Finding, person: string, role: string, zone: string | null, tone: string | null = toneOf(f), day: DayWords = SUNDAY_WORDS,
  said: SaidDay = NO_DAY): string {
  const what = f.check === "expires-before-sunday" ? `${person}'s background check on file expires before ${dayName(day)}.`
    : f.check === "expires-on-sunday" ? `${person}'s background check on file expires on ${dayName(day)}.` : `${person} has no current background check on file.`;
  const start = localIso(f.position?.interval?.starts_at, zone), checked = localIso(f.checked_at, zone);
  const look = f.tone === "look" && f.check === "none-current"
    ? " Planning Center showed no current background checks for anyone on your kids teams; your Planning Center login may not be able to see them." : "";
  // `tone` null: under a heading that already says it ("On the Sunday page, needing a decision:").
  return `${tone ? `${tone}: ` : ""}${what} Scheduled for ${role}${start ? ` at ${timeOf(start, said)}` : ` ${atService(day)}`}. Your Church rules ask for a current background check before serving with kids.${look}` +
    ` From ${f.source ?? PEOPLE_SOURCE}${checked ? `, checked ${checkedAt(checked)}` : ""}. ${KEPT_HERE}`;
}
/** A background-check finding's sentence with kept names, and its source. */
function kept(data: HarnessData, names: KeptNames, f: Finding, tone: string | null, said: SaidDay = NO_DAY): { text: string; source: { source: string; check_time: string } } {
  return {
    text: backgroundSentence(f, names.person(data, f.person_id), names.role(f.position?.name), data.brief?.time_zone ?? null, tone, serviceDay(data), said),
    source: { source: f.source ?? PEOPLE_SOURCE, check_time: f.checked_at ?? data.brief?.checked_at ?? "" },
  };
}

// Kids questions are read on folded text: case, accents and apostrophes don't matter.
const KIDS_WORDS = /(?<![\p{L}\p{N}])(?:nurser(?:y|ies)|kids?|children|childrens|child|childcare|toddlers?|preschool(?:ers)?|infants?|babies)(?![\p{L}\p{N}])/u;
const WHO_WORDS = /(?<![\p{L}\p{N}])(?:who|cover|covering|fill|substitute|sub|available)(?![\p{L}\p{N}])/u;
/** About the whole Sunday, whatever team it also names ("Is everything ready …, including the kids?"): never kids-only (review Q M2). */
const WHOLE_SUNDAY = /(?<![\p{L}\p{N}])(?:everything|anything|everyone|everybody|whole|overall|including|as\s+well|all\s+(?:the\s+)?(?:roles|teams|positions|set|good|ready|covered)|are\s+we|is\s+sunday)(?![\p{L}\p{N}])/u;
/** A decision question; about the whole Sunday unless it names a kids team. */
const DECISION_WORDS = /(?<![\p{L}\p{N}])(?:decisions?|decide|attention|outstanding|open\s+items?|to-?dos?|left\s+to\s+(?:do|decide)|what(?:'s|\s+is)\s+(?:left|open))(?![\p{L}\p{N}])/u;
/** Words in a team name that don't say which team it is (review Q M2: "Next Gen", "First Steps", "Small group teacher"). */
const GENERIC_WORDS: ReadonlySet<string> = new Set(["volunteer", "volunteers", "team", "teams", "lead", "leader", "leaders", "helper", "helpers", "worker", "workers",
  "crew", "staff", "ministry", "room", "rooms", "the", "and", "for", "with", "sunday", "service", "kids", "kid", "children", "childrens", "child", "position", "role",
  "host", "hosts", "check", "checks", "all", "our", "who", "any", "first", "next", "main", "early", "late", "little", "big", "new", "ready", "morning", "evening",
  "group", "groups", "small", "large", "class", "classes", "time", "church", "care"]);
const stem = (w: string) => w.replace(/ies$/u, "y").replace(/s$/u, "");
const teamWords = (text: string) => [...new Set(fold(text).split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 3 && !GENERIC_WORDS.has(w)).map(stem))];
/** Whether a question's own words are about kids or background checks (and not a request for a note): those are answered
 *  on this Mac, so they need no AI model. kidsQuestion then decides which teams, from what the check read. */
export const kidsWording = (typed: string) => { const text = fold(typed); return !DRAFT_ASK.test(text) && (KIDS_WORDS.test(text) || mentionsBackgroundCheck(typed)); };
/**
 * For text the background-check list stopped: whether it names a check (namesACheck) or kids, so the Sunday page's
 * background checks, or that no kids team is marked, answer it (review B3 L-2). Otherwise it holds only wording that
 * also names other things ("the Safe Sanctuaries team", "a sex offender policy") and gets the plain refusal, with
 * nothing beside it that could read as an answer (reviews B2 L-3, B3 N-2). Never decides what is sent.
 */
export const asksAboutChecksOrKids = (typed: string) => namesACheck(typed) || KIDS_WORDS.test(fold(typed));

export interface KidsQuestion {
  /** The teams asked about: kids teams in the order the Church rules mark them, or, with none marked, the teams named. */
  teams: string[];
  /** Whether the Church rules mark any kids team. */
  marked: boolean;
  /** A kids team was named, by its name ("the nursery" for "Nursery volunteer"). */
  named: boolean;
  /** Asked about background checks: only those are answered. */
  background: boolean;
  /** Asked who could help: the people on each open role's team are listed too. */
  who: boolean;
  /** About the whole Sunday; only ever returned with background checks, which then get the Sunday page's open decisions. */
  whole: boolean;
}
/**
 * Whether a question is about kids teams or background checks, answered here (kidsAnswer), and which teams: a kids team
 * named by its name (every distinctive word of it, or two of them; the Church rules' own name for the team when kept), or
 * every kids team for "kids", "children" or background-check wording. Left to Ask: a request for a note, a question that
 * also names another team, and a whole-Sunday question (review Q M2), unless it names background checks.
 */
export function kidsQuestion(typed: string, data: HarnessData): KidsQuestion | null {
  const brief = data.brief;
  if (!brief) return null;
  const text = fold(typed);
  if (DRAFT_ASK.test(text)) return null;
  const kids = KIDS_WORDS.test(text), background = mentionsBackgroundCheck(typed), who = WHO_WORDS.test(text);
  const marked = kidsTeams(data.rules), kidsIds = marked.map(t => t.team_id);
  const asked = new Set(teamWords(typed));
  const names = new Map<string, string[][]>();
  const add = (team: string | undefined, name: string | undefined) => {
    if (!team || !name) return;
    const list = names.get(team) ?? [];
    for (const one of name.split(/,\s+/u)) { const w = teamWords(one); if (w.length) list.push(w); }
    names.set(team, list);
  };
  for (const t of marked) if (t.name) add(t.team_id, t.name);
  const ruled = new Set(marked.filter(t => t.name).map(t => t.team_id));
  for (const p of brief.positions) if (!ruled.has(p.team_id)) add(p.team_id, p.name);
  for (const f of brief.findings) if (f.position && !ruled.has(f.position.team_id)) add(f.position.team_id, f.position.name);
  const matches = (words: string[]) => words.every(w => asked.has(w)) || words.filter(w => asked.has(w)).length >= 2;
  const named = [...names].filter(([, list]) => list.some(matches)).map(([team]) => team);
  const namedKids = kidsIds.filter(t => named.includes(t));
  const whole = WHOLE_SUNDAY.test(text) || (!namedKids.length && DECISION_WORDS.test(text));
  if (!marked.length) {
    // No kids team marked: only teams whose own names are kids words ("Nursery volunteer"), and never a mixed question.
    if (!kids && !background) return null;
    const kidsLike = named.filter(t => (names.get(t) ?? []).some(words => words.some(w => KIDS_WORDS.test(w))));
    if (!background && (whole || named.some(t => !kidsLike.includes(t)))) return null;
    return { teams: kidsLike, marked: false, named: kidsLike.length > 0, background, who, whole };
  }
  if (!background && (whole || named.some(t => !kidsIds.includes(t)))) return null;
  const teams = namedKids.length ? namedKids : kids || background ? kidsIds : [];
  return teams.length ? { teams, marked: true, named: namedKids.length > 0, background, who, whole } : null;
}

/** What the check read about who is scheduled on these teams, for what it may say about background checks (review Q H1). */
function scheduledOn(data: HarnessData, teams: ReadonlySet<string>) {
  const reads = data.capture?.reads ?? [];
  const full = (collection: string) => { const r = reads.filter(x => x.collection === collection); return r.length > 0 && r.every(x => x.outcome === "ok" && x.body); };
  const people = new Set<string>();
  for (const r of reads) {
    if (r.collection !== "team_members" || !r.body) continue;
    const rows = Array.isArray(r.body.data) ? r.body.data : [r.body.data];
    for (const row of rows as Row[]) {
      const rel = row?.["relationships"] as Record<string, { data?: { id?: unknown } | null } | undefined> | undefined;
      const status = (row?.["attributes"] as Row | undefined)?.["status"];
      const team = rel?.["team"]?.data?.id, person = rel?.["person"]?.data?.id;
      if (row?.["type"] === "PlanPerson" && typeof team === "string" && teams.has(team) && typeof person === "string" && ["C", "U", "Confirmed", "Unconfirmed"].includes(String(status))) people.add(person);
    }
  }
  const checks = reads.filter(x => x.collection === BACKGROUND_CHECKS);
  return {
    read: full("team_members") && full("plan_times"), scheduled: people.size,
    checked: checks.length > 0 && checks.every(x => x.outcome !== "not-requested"),
    checkedAt: checks.filter(x => x.outcome !== "not-requested").map(x => x.checked_at).sort()[0] ?? null,
  };
}

/**
 * A kids question, answered on this Mac without the AI: every finding on the teams asked about, in the brief's order and
 * the Sunday page's tone ("Resolved by you" after a leader's decision), from the same read-only tools the AI reads (open
 * roles with who is confirmed, the team and its leaders; kids counts), and each background check from the brief itself,
 * with its source, check time and that it stays on this Mac. Asked who could help, each open role's team follows its
 * role, in label order. Asked about background checks, only those. What was set aside in Church rules is counted, what
 * wasn't checked is Worth a look, and "no one … without a current background check" is said only when the check
 * supports it exactly (review Q H1). Never blank (review Q M3).
 */
export async function kidsAnswer(tools: HarnessTools, q: KidsQuestion, signal: AbortSignal): Promise<LocalAnswer> {
  const names = new KeptNames();
  const out: LocalAnswer = { paragraphs: [], fill: names.fill, evidence: [], sources: [], gaps: [] };
  const data = tools.data, { brief, rules, decisions } = data;
  if (!brief) return out;
  const day = serviceDay(data);
  const read = reader(tools, signal);
  const run = async (name: string, args: Record<string, unknown> = {}) => { const e = await read(name, args); if (e) out.evidence.push(e); return e; };
  const background = q.background, teams = new Set(q.teams);
  const sources: { source: string; check_time: string }[] = [];
  const rulesSource = { source: RULES_SOURCE, check_time: brief.checked_at ?? brief.completed_at };
  const finish = () => {
    if (!out.paragraphs.length) out.paragraphs.push(q.marked ? WHICH_TEAM : NO_KIDS_TEAM);
    out.sources = once([...sources, rulesSource]);
    return out;
  };
  const coverage = scheduledOn(data, teams);
  out.gaps = brief.not_checked.filter(l => l.startsWith(BACKGROUND_LINE) || (!background && /kids team/iu.test(l)));
  if (!coverage.read && q.marked) {
    const line = background ? MEMBERS_UNREAD : KIDS_MEMBERS_UNREAD;
    if (!out.gaps.some(l => /didn't fully load/u.test(l))) out.gaps.push(line);
  }
  // With no kids team marked, a status or background question says so; who could cover a named role doesn't need it.
  if (!q.marked) { if (background || !q.who || !q.teams.length) out.paragraphs.push(NO_KIDS_TEAM); if (background) return finish(); }
  else if (background && !backgroundChecksOn(rules)) { out.paragraphs.push(BACKGROUND_OFF); return finish(); }
  const decisionsBy = new Map(applyDecisions(brief, decisions).items.map(i => [i.finding.id, i]));
  const onTeams = (f: Finding) => !!f.position && teams.has(f.position.team_id) && (!background || f.kind === "background-check");
  const mine = brief.findings.filter(onTeams);
  const hidden = (brief.hidden ?? []).map(h => h.finding).filter(onTeams);
  // Services findings, as the tools describe them: rows follow the brief as models see it (forModels), in its order.
  // A background question reads what wasn't checked, so how complete and current the check is reaches the answer.
  const shared = forModels(brief).findings, needs = shared.filter(f => NEED_KINDS.has(f.kind));
  const overview = background ? await run("sunday.not_checked") : await run("sunday.overview");
  const openNeeds = mine.some(f => NEED_KINDS.has(f.kind)) ? await run("sunday.open_needs") : null;
  // Each finding's own row, by its place in the tool's list even when rows were left out for length (tools.ts rowAt).
  const overviewRow = (i: number) => background ? undefined : rowAt(overview, "findings", i), needRow = (i: number) => rowAt(openNeeds, "needs", i);
  for (const f of mine) {
    const tone = toneWith(f, decisionsBy);
    if (f.kind === "background-check") {
      const k = kept(data, names, f, tone);
      out.paragraphs.push(k.text);
      sources.push(k.source);
      continue;
    }
    if (NEED_KINDS.has(f.kind)) {
      const row = needRow(needs.findIndex(x => x.id === f.id));
      const text = row && openNeeds ? sentenceFor(factOf(openNeeds, "needs", row), day) : null;
      if (text) out.paragraphs.push(`${tone}: ${text}`);
      const role = row ? str(row["role"]) : null;
      if (q.who && f.kind === "needs-people" && role) {
        const help = await run("sunday.who_could_help", { role });
        const people = rowsOf(help, "people");
        if (help && !people.length) out.paragraphs.push(`The check found no one else on the team for ${role}.`);
        for (const p of ordered(people.map(r => factOf(help!, "people", r)))) { const s = sentenceFor(p, day); if (s) out.paragraphs.push(s); }
        if (people.some(r => r["status"] === "no overlap found")) out.paragraphs.push(NOT_FREE);
        if (people.length > 1) out.paragraphs.push(NOT_RANKED);
      }
      continue;
    }
    const row = overviewRow(shared.findIndex(x => x.id === f.id));
    const text = row ? finding(row) : null;
    if (text) out.paragraphs.push(`${tone}: ${text}${decided(row!, day)}`);
  }
  if (hidden.length) out.paragraphs.push(setAside(hidden.length, background ? "background check" : "finding", day));
  if (!mine.length && !hidden.length) {
    const label = (team: string) => kidsTeams(rules).find(t => t.team_id === team)?.name ?? brief.findings.find(f => f.position?.team_id === team)?.position?.name
      ?? brief.positions.find(p => p.team_id === team)?.name;
    const one = q.teams.length === 1 ? label(q.teams[0]!) : undefined;
    const where = one ? names.role(one) : q.marked ? "your kids teams" : null;
    if (background) {
      // Only when who is scheduled was read, someone is, every background check was read, and the check is complete and current.
      const current = overview?.completeness === "complete" && !brief.stale && data.mode !== "recording";
      out.paragraphs.push(!coverage.read ? BACKGROUND_UNCONFIRMED : !coverage.scheduled ? nobodyScheduled(day)
        : coverage.checked && current && !out.gaps.length ? BACKGROUND_ON_FILE : BACKGROUND_UNCONFIRMED);
      if (coverage.checkedAt) sources.push({ source: PEOPLE_SOURCE, check_time: coverage.checkedAt });
    } else if (where) out.paragraphs.push(`This check found nothing for ${where} that needs a decision or is worth a look.`);
  }
  return finish();
}

/** Any day a church meets on (decision 18): "Is Wednesday covered?" is as much a decision question as Sunday's. */
const WEEKDAYS = "sunday|monday|tuesday|wednesday|thursday|friday|saturday";
/** Questions about what still needs a decision or attention for the service (review Q L4: also problems, issues, "are we good"). */
export const DECISION_QUESTION = new RegExp("(?<![\\p{L}\\p{N}])(?:decisions?|decide|attention|outstanding|open\\s+items?|to-?dos?|left\\s+to\\s+(?:do|decide|sort\\s+out)" +
  "|what(?:'s|\\s+is)\\s+(?:left|open|missing|wrong)|(?:is|are)\\s+(?:we|everything|things|it|this\\s+weekend|(?:my|our|your|the|all\\s+(?:my|our|the))\\s+services?|" + WEEKDAYS + ")\\s+(?:all\\s+)?(?:ready|set|covered|good|ok|okay)" +
  "|(?:" + WEEKDAYS + ")\\s+ready|ready\\s+for\\s+(?:" + WEEKDAYS + "|this\\s+weekend)|problems?|issues?|concerns?" +
  "|anything\\s+(?:else\\s+)?(?:i|we)\\s+(?:should|need\\s+to|must|ought\\s+to)\\s+(?:know|look\\s+at|do|deal\\s+with|worry\\s+about|handle))(?![\\p{L}\\p{N}])", "iu");
export const isDecisionQuestion = (typed: string) => DECISION_QUESTION.test(fold(typed));

// What a chosen fact says, so an item the answer already gave isn't added again: one key per finding, room overlap or
// follow-up, from the labels and times the tools gave (the same session's, so the same item has the same key).
const startOf = (time: unknown) => str((time as Row | null)?.["starts_at"]) ?? "-";
const findingKey = (kind: string | null, r: Row) => `f|${kind ?? "-"}|${str(r["role"]) ?? "-"}|${str(r["person"]) ?? "-"}|${startOf(r["time"])}`;
const roomKey = (r: Row) => `r|${str(r["room"]) ?? "-"}|${startOf(r["overlap"])}`;
const followUpKey = (r: Row) => `w|${str(r["workflow"]) ?? "-"}|${str(r["step"]) ?? "-"}`;
function keysOf(f: Fact): string[] {
  const r = f.row;
  // A tool's own summary of rooms or follow-ups says how many need attention, which counts as saying them.
  if (f.list === null) return f.tool === "rooms.conflicts" ? rowsOf({ payload: f.payload } as ToolEnvelope, "rooms").map(roomKey)
    : f.tool === "followups.unowned" ? rowsOf({ payload: f.payload } as ToolEnvelope, "follow_ups").map(followUpKey) : [];
  switch (`${f.tool} ${f.list}`) {
    // The overview's rooms and follow-ups are the same items their own tools give, keyed the same way.
    case "sunday.overview findings": return [r["kind"] === OVERVIEW_ROOM ? roomKey(r) : r["kind"] === OVERVIEW_FOLLOW_UP ? followUpKey(r) : findingKey(str(r["kind"]), r)];
    case "sunday.open_needs needs": return [findingKey(str(r["kind"]), r)];
    case "sunday.who_could_help times": return [findingKey("needs people", r)];
    case "sunday.pending_requests pending": return [findingKey("pending", r)];
    case "rooms.conflicts rooms": return [roomKey(r)];
    case "followups.unowned follow_ups": return [followUpKey(r)];
    default: return [];
  }
}

/**
 * The decisions the Sunday page shows as open that an answer left out, written here (no silent omission): findings that
 * need a decision and weren't settled by the leader, background checks (which never reach the AI, so never its answer),
 * room overlaps confirmed by a Church rule, and follow-ups without an owner; then how many findings Church rules set
 * aside. Empty when the answer said them all and nothing is set aside. `scope`: the services the question named (tools.ts):
 * only their decisions, from an overview read for them; rooms and follow-ups belong to no one service and aren't added.
 */
export async function decisionsLeftOut(tools: HarnessTools, answer: string, evidence: readonly ToolEnvelope[], signal: AbortSignal,
  framing?: { head: string; none: string | null }, scope: Scope = []): Promise<LocalAnswer> {
  const names = new KeptNames();
  const out: LocalAnswer = { paragraphs: [], fill: names.fill, evidence: [], sources: [], gaps: [] };
  const data = tools.data, { brief, decisions } = data;
  if (!brief) return out;
  const day = serviceDay(data);
  const { head, none } = framing ?? { head: alsoOnPage(day), none: null };
  const all = factsIn(evidence), said = new Set<string>();
  const chosen = (parseAnswer(answer)?.facts ?? []).flatMap(id => all.get(id) ?? []);
  for (const f of chosen) for (const k of keysOf(f)) said.add(k);
  // The answer above said the overview's date ("For Sunday, November 22, …"): a time on it here is said by its clock alone.
  const onDay = saidBy(chosen.filter(isLead).map(f => f.payload), day);
  const read = reader(tools, signal, scope);
  const overview = await read("sunday.overview");
  // Rooms and follow-ups are the first service's, as its page shows them (tools.ts opsInScope).
  const ops = tools.opsInScope(scope);
  const rooms = ops ? await read("rooms.conflicts") : null, followUps = ops ? await read("followups.unowned") : null;
  out.evidence = [overview, rooms, followUps].filter((e): e is ToolEnvelope => e !== null);
  const settled = new Set(applyDecisions(brief, decisions).items.filter(i => i.decision && i.state !== "reopened").map(i => i.finding.id));
  // Each finding's own row, by its place in the overview even when rows were left out for length (tools.ts rowAt).
  const shared = forModels(brief).findings.filter(f => tools.inScope(f, scope));
  const items: string[] = [], sources: { source: string; check_time: string }[] = [];
  // Every item here needs a decision, and the heading says so: no item says it again (owner's read of 0.3.2).
  for (const f of brief.findings) {
    if (f.tone !== "decision" || settled.has(f.id) || !tools.inScope(f, scope)) continue;
    if (f.kind === "background-check") { const k = kept(data, names, f, null, onDay); items.push(k.text); sources.push(k.source); continue; }
    const row = rowAt(overview, "findings", shared.findIndex(x => x.id === f.id));
    if (!row || !overview || said.has(findingKey(str(row["kind"]), row))) continue;
    const text = overviewRow(row, day, onDay);
    // A church on another system: its own name where the sentence says where the facts are (inSystem).
    if (text) items.push(inSystem(text, data.source ?? null));
  }
  for (const row of rowsOf(rooms, "rooms")) {
    if (row["label"] !== "Room use needs review" || said.has(roomKey(row))) continue;
    const text = sentenceFor(factOf(rooms!, "rooms", row), day, onDay);
    if (text) items.push(text);
  }
  for (const row of rowsOf(followUps, "follow_ups")) {
    if (said.has(followUpKey(row))) continue;
    const text = sentenceFor(factOf(followUps!, "follow_ups", row), day);
    if (text) items.push(text);
  }
  const aside = (brief.hidden ?? []).filter(h => tools.inScope(h.finding, scope)).length;
  out.paragraphs = [...(items.length ? [head, ...items] : none ? [none] : []), ...(aside ? [setAside(aside, "finding", day)] : [])];
  out.sources = once(sources);
  return out;
}

/**
 * Every open decision the Sunday page shows, written here without the AI: for a decision question that also names
 * background checks, which may never be sent (review Q H2, M2). Background-check lines of What I didn't check are Worth a look.
 */
export async function openDecisions(tools: HarnessTools, signal: AbortSignal): Promise<LocalAnswer> {
  const out = await decisionsLeftOut(tools, '{"answer":"not-covered"}', [], signal, { head: onPage(serviceDay(tools.data)), none: NOTHING_OPEN });
  out.gaps = (tools.data.brief?.not_checked ?? []).filter(l => l.startsWith(BACKGROUND_LINE) || /kids team/iu.test(l));
  return out;
}

// ---- A church system that ties no team to its roles (Breeze): who is on each role, answered on this Mac (round 5) ----

/**
 * What Ozzie can do instead, for a church system that ties no team to its roles (Breeze): only what works there, never
 * "who on a team could help" (round 5). Planning Center and B1 Church keep harness-words.ts CAN_DO_INSTEAD.
 */
export const canDoWith = (system: string) =>
  `With ${system}, Ozzie can tell you who is scheduled, who hasn't answered yet and why something is flagged, or prepare a note for you to copy. Ask “What can you do?” to see more.`;
/** A question about who is on the service's roles, on a church system that ties no team to them. */
export interface RosterQuestion { kind: "who-could-help" | "scheduled" | "not-answered" | "declined" | "note" | "decision"; roles: string[] }
/** The system's name when it ties no team to its roles (Breeze), from what it is, never from what one check read. */
const teamless = (data: HarnessData): string | null => {
  const info = data.source ? Object.values(SYSTEMS).find(s => s.name === data.source) : undefined;
  return info && !info.teamMembers ? info.name : null;
};
/** The system's info, when `data` is a church system's check that ties no team to its roles and lists who is on each. */
const noTeams = (data: HarnessData) => {
  const name = teamless(data);
  return name && data.brief?.roster ? { name, roster: data.brief.roster } : null;
};
const WORD = (word: string) => new RegExp(`(?<![\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?![\\p{L}\\p{N}])`, "u");
const NOT_ANSWERED = /(?:has|have|did|do)n'?t\s+(?:yet\s+)?(?:answered|replied|responded|confirmed|answer|reply|respond|confirm)|(?:has|have|did)\s+not\s+(?:yet\s+)?(?:answered|replied|responded|confirmed|answer|reply|respond|confirm)|no\s+answer|not\s+(?:answered|confirmed)|pending|waiting/u;
const DECLINED = /\bsaid\s+no\b|\bdeclined\b|\bturned\s+(?:it\s+)?down\b|\bcan'?t\s+(?:make\s+it|come|serve)\b/u;
/**
 * Is a role covered, full, short or filled: a question about coverage, as decision questions are (review of round 5, H1).
 * "Full" only as a role being full ("Is Greeter full?", "full yet"), never "the full service" (release review L2).
 */
const COVERAGE = /\b(?:covered|enough|filled|short|staffed|need(?:s|ed)?\s+(?:more|anyone|someone|people))\b|\bfull\b(?!\s+(?![Yy]et\b|[Nn]ow\b|[Uu]p\b|[Aa]lready\b|[Ff]or\b|[Tt]his\b|[Oo]n\b)\p{L})/u;
/**
 * Who could help with, who is scheduled for, who hasn't answered or said no for the service's roles, whether it is
 * covered, or a note to someone who hasn't answered: on a church system that ties no team to its roles (Breeze), each
 * is answered here from who is on each role (round 5: "Who could cover Greeter?" led with a limit, then said what Ozzie
 * "did read" when it hadn't, then offered what Breeze can't do). Null for anything else, and for Planning Center and
 * B1 Church. A role named only inside a longer role name ("Greeter" in "Lead Greeter") counts as the longer one; named on
 * its own as well ("Greeter and Lead Greeter"), it counts too (release review L1).
 */
export function rosterQuestion(typed: string, data: HarnessData): RosterQuestion | null {
  const sys = noTeams(data);
  if (!sys) return null;
  const text = fold(typed);
  const matched = sys.roster.roles.map(r => r.name.trim()).filter(n => n && WORD(fold(n)).test(text));
  const roles = [...new Set(matched.filter(n => {
    const outer = matched.filter(m => m !== n && fold(m).includes(fold(n)));
    if (!outer.length) return true;
    const rest = outer.reduce((t, m) => t.replace(new RegExp(WORD(fold(m)).source, "gu"), " "), text);
    return WORD(fold(n)).test(rest);
  }))];
  const waitingFirst = sys.roster.roles.flatMap(r => r.waiting).map(id => fold((data.capture?.names[id] ?? "").trim().split(/\s+/u)[0] ?? "")).filter(n => n.length > 1);
  // A note to someone who hasn't answered: said so, or named; never any reminder at all (review of round 5, M4).
  if (/\b(?:draft|write|prepare)\b/u.test(text) && /\b(?:note|message|reminder)\b/u.test(text) && (NOT_ANSWERED.test(text) || waitingFirst.some(n => WORD(n).test(text)))) {
    return { kind: "note", roles };
  }
  if (/\bwho\b/u.test(text) && /\b(?:cover|covering|help|fill|step in|sub|substitute|replace|available)\b/u.test(text)) return { kind: "who-could-help", roles };
  if (/\bwho\b/u.test(text) && NOT_ANSWERED.test(text)) return { kind: "not-answered", roles };
  if (/\bwho\b/u.test(text) && DECLINED.test(text)) return { kind: "declined", roles };
  // "What still needs a decision?", "Is Greeter covered?", "Do we have enough ushers?": never "nothing needs a decision"
  // where the system shares no number for those roles (round 5); what is known instead.
  const asked = roles.length ? sys.roster.roles.filter(r => roles.includes(r.name.trim())) : sys.roster.roles;
  if ((isDecisionQuestion(typed) || COVERAGE.test(text)) && asked.length && asked.every(r => r.needed === null)) return { kind: "decision", roles };
  if (/\bwho(?:'s|\s+is|\s+are)?\b/u.test(text) && /\b(?:scheduled|serving|volunteering|coming|on the schedule|signed up|listed|on)\b/u.test(text)) return { kind: "scheduled", roles };
  return null;
}
/** A question about whether the service or a role is covered: decision questions and coverage words. */
export const asksAboutCoverage = (typed: string) => isDecisionQuestion(typed) || COVERAGE.test(fold(typed));
const andLabels = (items: readonly string[]) => items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)!}`;
/** Answers a roster question here, in placeholder form (the app restores the labels on this Mac); nothing is sent. */
export async function rosterAnswer(tools: HarnessTools, q: { kind: Exclude<RosterQuestion["kind"], "note">; roles: string[] }, signal: AbortSignal): Promise<LocalAnswer> {
  const sys = noTeams(tools.data)!;
  const brief = tools.data.brief!;
  const read = reader(tools, signal);
  const evidence: ToolEnvelope[] = [];
  const run = async (name: string, args: Record<string, unknown> = {}) => { const e = await read(name, args); if (e) evidence.push(e); };
  const org = tools.data.capture?.organization ?? "";
  const person = (id: string) => tools.session.person(org, id);
  const role = (name: string) => tools.session.role(name);
  const named = q.roles.length > 0;
  const roles = named ? sys.roster.roles.filter(r => q.roles.includes(r.name.trim())) : sys.roster.roles;
  const onRole = (r: RosterRole): string => {
    const parts = [
      r.yes.length ? `${andLabels(r.yes.map(person))} said yes` : "",
      r.waiting.length ? `${andLabels(r.waiting.map(person))} ${r.waiting.length === 1 ? "hasn't" : "haven't"} answered yet` : "",
      r.unknown.length ? `Ozzie couldn't read ${andLabels(r.unknown.map(person))}'s answer` : "",
      r.declined.length ? `${andLabels(r.declined.map(person))} said no` : "",
    ].filter(Boolean);
    return parts.length ? `${parts.join("; ")}.` : "nobody is listed on it yet.";
  };
  // How many more a role needs, where the system gave a number (review of round 5, M1): the check's own count.
  const stillNeeds = (r: RosterRole): string | null => {
    const left = r.needed === null ? null : brief.positions.find(p => p.name.trim() === r.name.trim() && p.remaining !== null)?.remaining ?? null;
    return left ? `${role(r.name)} still needs ${left === 1 ? "1 more person" : `${left} more people`}, by ${sys.name}'s numbers.` : null;
  };
  // The limit, only for roles with no number, and named where only some have none (review of round 5, M1).
  const unnumbered = (list: readonly RosterRole[]) => list.filter(r => r.needed === null);
  const limitFor = (list: readonly RosterRole[]): string | null => {
    const none = unnumbered(list);
    if (!none.length) return null;
    return none.length === sys.roster.roles.length
      ? `${sys.name} doesn't share how many people each role needs, so Ozzie can't say whether a role is full.`
      : `${sys.name} doesn't share how many people ${andLabels(none.map(r => role(r.name)))} ${none.length === 1 ? "needs" : "need"}, so Ozzie can't say whether ${none.length === 1 ? "it is" : "they are"} full.`;
  };
  const paragraphs: string[] = [];
  let deadEnd = false;
  switch (q.kind) {
    case "who-could-help":
      // The plain answer first, then what Ozzie does know that helps: who is on the role now, and what it still needs.
      for (const r of named ? roles : []) await run("sunday.who_could_help", { role: role(r.name) });
      paragraphs.push(named ? roles.map(r => noTeam(role(r.name), sys.name)).join(" ")
        : `${sys.name} doesn't tie a team to each role, so Ozzie can't suggest who could help.`);
      if (named) for (const r of roles) paragraphs.push([`On ${role(r.name)} now: ${onRole(r)}`, stillNeeds(r)].filter(Boolean).join(" "));
      else paragraphs.push(rosterSummary(sys.roster));
      deadEnd = true;
      break;
    case "scheduled": {
      paragraphs.push(named ? roles.map(r => `${role(r.name)}: ${onRole(r)}`).join("\n") : rosterSummary(sys.roster));
      if (!named) {
        paragraphs.push(sys.roster.roles.map(r => `${role(r.name)}: ${onRole(r)}`).join("\n"));
        if (sys.roster.no_role.length) paragraphs.push(`On the service with no role: ${andLabels(sys.roster.no_role.map(person))}.`);
      }
      const limit = limitFor(roles);
      if (limit) paragraphs.push(limit);
      break;
    }
    case "decision": {
      const day = serviceDay(tools.data);
      paragraphs.push(named
        ? `Ozzie can't say whether ${andLabels(roles.map(r => role(r.name)))} ${roles.length === 1 ? "is" : "are"} full: ${sys.name} doesn't share how many people ${roles.length === 1 ? "it needs" : "they need"}.`
        : `Ozzie can't say whether anything needs a decision ${day.thisOne}: ${sys.name} doesn't share how many people each role needs.`);
      if (named) paragraphs.push(roles.map(r => `${role(r.name)}: ${onRole(r)}`).join("\n"));
      else {
        paragraphs.push(rosterSummary(sys.roster));
        const look = rosterNeedsYou(sys.roster).map(r => `${role(r.name)}: ${r.waiting.length ? onRole({ ...r, yes: [], declined: [], unknown: [] }) : r.declined.length
          ? `${andLabels(r.declined.map(person))} said no, and nobody else on it has said yes.` : "nobody is listed on it yet."}`);
        if (look.length) paragraphs.push(look.join("\n"));
      }
      break;
    }
    case "not-answered": {
      const waiting = roles.flatMap(r => r.waiting.map(id => `${person(id)} hasn't answered for ${role(r.name)}.`));
      paragraphs.push(waiting.length ? waiting.join("\n") : named ? `Everyone listed on ${andLabels(roles.map(r => role(r.name)))} has answered.` : "Everyone listed has answered.");
      if (waiting.length) paragraphs.push(`${sys.name} doesn't say whether the request was sent.`);
      break;
    }
    case "declined": {
      const no = roles.flatMap(r => r.declined.map(id => `${person(id)} said no for ${role(r.name)}.`));
      paragraphs.push(no.length ? no.join("\n") : named ? `Nobody listed on ${andLabels(roles.map(r => role(r.name)))} said no.` : "Nobody listed said no.");
      break;
    }
  }
  // Where the facts came from, for "Based on": the check's own answers.
  await run("sunday.pending_requests");
  // What Ozzie can do instead, only where the answer is that it can't (review of round 5, L4).
  if (deadEnd) paragraphs.push(canDoWith(sys.name));
  return { paragraphs, fill: shown => shown, evidence, sources: [], gaps: [] };
}

/**
 * What Ozzie can do instead for the church system `data` reads, when it ties no team to its roles (from what the
 * system is, so a check that couldn't read who is on each role still gets it; review of round 5, L5); null otherwise.
 */
export const canDoFor = (data: HarnessData): string | null => { const name = teamless(data); return name ? canDoWith(name) : null; };

/**
 * A note to someone who hasn't answered, on a church system that ties no team to its roles (round 5): the pending
 * finding it is for, when the question names exactly one (by role, or by a waiting person's first name, or the only
 * one), with what Ozzie says around it; else what to ask instead. The note itself is written on this Mac
 * (reminder-draft.ts), never by the AI.
 */
export async function rosterNote(tools: HarnessTools, q: RosterQuestion, typed: string, signal: AbortSignal): Promise<{ local: LocalAnswer; finding: Finding | null }> {
  const sys = noTeams(tools.data)!;
  const brief = tools.data.brief!;
  const names = tools.data.capture?.names ?? {};
  const read = reader(tools, signal);
  const evidence: ToolEnvelope[] = [];
  const pending = await read("sunday.pending_requests");
  if (pending) evidence.push(pending);
  const org = tools.data.capture?.organization ?? "";
  const person = (id: string) => tools.session.person(org, id);
  const role = (name: string) => tools.session.role(name);
  const text = fold(typed);
  const first = (id: string) => fold((names[id] ?? "").trim().split(/\s+/u)[0] ?? "");
  const waiting = brief.findings.filter(f => f.kind === "pending" && f.person_id && f.position && canRemind(f));
  const byRole = q.roles.length ? waiting.filter(f => q.roles.includes(f.position!.name.trim())) : waiting;
  const byName = byRole.filter(f => first(f.person_id!).length > 1 && WORD(first(f.person_id!)).test(text));
  const chosen = byName.length ? byName : byRole;
  const local = (paragraphs: string[]): LocalAnswer => ({ paragraphs, fill: shown => shown, evidence, sources: [], gaps: [] });
  if (chosen.length === 1) {
    const f = chosen[0]!;
    return { finding: f, local: local([DRAFT_INTRO, `${person(f.person_id!)} hasn't answered for ${role(f.position!.name)}. ${sys.name} doesn't say whether the request was sent.`]) };
  }
  if (!chosen.length) {
    return { finding: null, local: local([q.roles.length ? `Nobody listed on ${andLabels(q.roles.map(role))} is waiting to answer.` : "Nobody listed is waiting to answer.", canDoWith(sys.name)]) };
  }
  // One person waiting on several roles is one person, asked about one role at a time (review of round 5, L2).
  if (new Set(chosen.map(f => f.person_id)).size === 1) {
    return { finding: null, local: local([`${person(chosen[0]!.person_id!)} hasn't answered for ${andLabels(chosen.map(f => role(f.position!.name)))}. Ask for a note about one role at a time.`]) };
  }
  return { finding: null, local: local([`More than one person hasn't answered: ${andLabels(chosen.map(f => `${person(f.person_id!)} for ${role(f.position!.name)}`))}. Ask for a note about one role at a time.`]) };
}
