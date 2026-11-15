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
import { BACKGROUND_WORDING, DRAFT_ASK, NOT_COVERED } from "../ask.js";
import { fold } from "../draft-request.js";
import { BACKGROUND_CHECKS, BACKGROUND_LINE, backgroundChecksOn, forModels, kidsTeams } from "../kids-rules.js";
import type { Finding } from "../sunday-brief.js";
import { applyDecisions, type DecidedItem } from "../sunday-decisions.js";
import type { ToolEnvelope } from "./contract.js";
import { parseAnswer, type AnswerKind } from "./fixed.js";
import { FACT_LISTS, localIso, type HarnessData, type HarnessTools } from "./tools.js";

export interface ComposedAnswer {
  kind: AnswerKind;
  /** Placeholder-form paragraphs, in the order shown. */
  paragraphs: string[];
  /** The drafting tool's own text, in placeholder form, or null. */
  draft: string | null;
}

type Row = Record<string, unknown>;
interface Fact { id: number; tool: string; list: string | null; row: Row; payload: Row; envelope: number }

/** Lists whose rows are each about one person: shown in label order. */
const PERSON_LISTS: ReadonlySet<string> = new Set(["people", "pending", "leads_not_accepted", "check_ins", "clashes"]);
export const NOT_FREE = "That doesn't mean they're free or willing; only they can say.";
export const NOT_RANKED = "People are listed in no particular order, not ranked.";
export const NOTHING_TO_DECIDE = "Nothing in this check needs a decision right now.";
export const DRAFT_INTRO = "Here is a draft for you to read, change and send yourself. Nothing has been sent.";
export const NOT_COVERED_MORE = "Here is what Ozzie did read:";

const str = (v: unknown): string | null => typeof v === "string" ? v : null;
const num = (v: unknown): number | null => typeof v === "number" ? v : null;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const list = (items: readonly string[]) => items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)!}`;
const labels = (v: unknown) => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
const sentence = (s: string) => /[.!?]$/u.test(s) ? s : `${s}.`;
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** " at <start>" for a service time, or nothing when it isn't known. */
const at = (time: unknown) => { const t = (time as Row | null)?.["starts_at"]; return typeof t === "string" && t !== "not known" ? ` at ${t}` : ""; };
/** A church-local ISO time's date and clock ("2026-11-29T10:15-05:00" → 2026-11-29, "10:15 AM"). Null for a UTC time or
 *  anything else, which keeps its full form so the app's restore can say UTC when the church's zone isn't known. */
const LOCAL_TIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})[+-]\d{2}:\d{2}$/u;
const dayClock = (iso: string | null) => {
  const m = iso ? LOCAL_TIME.exec(iso) : null;
  return m ? { day: m[1]!, clock: `${+m[2]! % 12 || 12}:${m[3]!} ${+m[2]! < 12 ? "AM" : "PM"}` } : null;
};
/** The one date a span falls on, or null when it crosses midnight or isn't known. */
const dayOf = (time: unknown) => {
  const t = time as Row | null;
  const a = dayClock(str(t?.["starts_at"])), b = dayClock(str(t?.["ends_at"]));
  return a && b && a.day === b.day ? a.day : null;
};
/** A span: "on <date> from <start> to <end>" when it falls on one date, so the date is said once (and not again when
 *  `said` is that date); otherwise both times in full. The app shows the date and full times in plain words. */
const fromTo = (time: unknown, said: string | null = null) => {
  const t = time as Row | null;
  const a = str(t?.["starts_at"]), b = str(t?.["ends_at"]);
  if (!a || !b || a === "not known" || b === "not known") return "at a time that couldn't be read";
  const x = dayClock(a), y = dayClock(b);
  if (x && y && x.day === y.day) return `${x.day === said ? "" : `on ${x.day} `}from ${x.clock} to ${y.clock}`;
  return `from ${a} to ${b}`;
};
const needs = (row: Row) => {
  const n = num(row["remaining"]);
  return n === null ? "still needs people; Planning Center's count couldn't be read" : `still needs ${n} more ${n === 1 ? "person" : "people"}, by Planning Center's count`;
};
const decided = (row: Row) => {
  const d = str(row["decision"]);
  if (!d) return "";
  return ` You decided: ${d}.${row["changed_since_decision"] === true ? " A later check changed something, so it's worth a fresh look." : ""}`;
};
const leaders = (row: Row) => {
  const l = row["team_leaders"];
  if (Array.isArray(l)) return l.length ? ` Team leaders in Planning Center: ${list(labels(l))} (oversight of the team, not a Sunday assignment).` : "";
  return l === "none listed" ? " Planning Center lists no team leader." : l === "couldn't be read" ? " The team leaders couldn't be read." : "";
};
const request = (v: unknown) => v === "request sent, no answer yet" ? "Planning Center shows the request as sent, with no answer yet."
  : v === "request not sent yet" ? "The request hasn't been sent yet." : "Whether the request was sent isn't known.";
const reasons = (row: Row) => { const r = labels(row["reasons"]); return r.length ? `: ${r.join("; ")}` : ""; };
const differs = (row: Row) => row["status_differs_by_time"] === true ? " This differs between service times." : "";
const worth = (n: unknown, what: string) => typeof n === "number" && n > 0 ? ` Worth a look: ${plural(n, what, `${what}s`)} couldn't be confirmed.` : "";

/** A finding in the overview or the open roles, by its kind. */
function finding(row: Row): string | null {
  const role = str(row["role"]) ?? "A role", person = str(row["person"]) ?? "Someone";
  switch (row["kind"]) {
    case "needs people": return `${role}${at(row["time"])} ${needs(row)}.`;
    case "no scheduled lead": return `${role}${at(row["time"])} has no scheduled lead, and your Church rules ask for one.`;
    case "lead couldn't be confirmed": return `${role}${at(row["time"])} has a scheduled lead, but their answer or serving time couldn't be confirmed.`;
    case "pending": return `${person} is pending for ${role}${at(row["time"])}. ${request(row["request"])} Pending is not the same as asked.`;
    case "check-in suggested": {
      const n = num(row["sundays_in_a_row"]);
      return `${person} is scheduled ${n === null ? "several" : n} Sundays in a row. Your Church rules suggest a check-in, which is about care, not performance.`;
    }
    case "fewer confirmed than the church rules ask": {
      const c = num(row["confirmed"]) ?? 0, needed = num(row["needed"]), asked = num(row["asked_no_answer"]) ?? 0, unsent = num(row["request_not_sent"]) ?? 0;
      return `${role}${at(row["time"])} has ${plural(c, "confirmed person", "confirmed people")}${needed === null ? "" : `, and your Church rules ask for at least ${needed}`}.` +
        `${asked ? ` ${plural(asked, "more is", "more are")} asked with no answer yet.` : ""}${unsent ? ` ${plural(unsent, "more has", "more have")} a request not sent yet.` : ""}` +
        " Pending isn't counted, and Ozzie doesn't check ages.";
    }
    case "part of the check couldn't be verified": {
      const n = num(row["reads_not_completed"]) ?? 0;
      return `Part of this check couldn't be verified: ${plural(n, "Planning Center read", "Planning Center reads")} didn't complete.${row["too_old_to_treat_as_current"] === true ? " The check is also too old to treat as current." : ""}`;
    }
    default: return null;
  }
}

/** The sentence for one fact: a row of one of a tool's FACT_LISTS, or the payload itself (`list` null). */
function sentenceFor(f: Fact): string | null {
  const { tool, list: key, row, payload } = f;
  const role = str(row["role"]) ?? "this role", person = str(row["person"]) ?? "Someone";
  if (key === null) return summary(tool, payload);
  switch (`${tool} ${key}`) {
    case "sunday.overview findings": {
      const text = finding(row);
      if (!text) return null;
      return `${row["tone"] === "needs a decision" ? "Needs a decision" : "Worth a look"}: ${text}${decided(row)}`;
    }
    case "sunday.open_needs needs": {
      if (row["kind"] !== "needs people") { const text = finding(row); return text ? `${text}${notAccepted(row)}${leaders(row)}${decided(row)}` : null; }
      const confirmed = labels(row["confirmed"]);
      const p = (row["people_listed"] ?? {}) as Row;
      const counts = [[p["no_overlap_found"], "with no overlap found"], [p["possible_conflict"], "with a possible conflict"],
        [p["needs_confirmation"], "whose availability needs confirmation"], [p["left_out"], "left out"]]
        .flatMap(([n, what]) => typeof n === "number" && n > 0 ? [`${n} ${what as string}`] : []);
      return `${finding(row)}${confirmed.length ? ` Already confirmed: ${list(confirmed)}.` : ""}${counts.length ? ` On the team: ${list(counts)}.` : ""}${leaders(row)}${decided(row)}`;
    }
    case "sunday.who_could_help times": return `${role}${at(row["time"])} ${needs(row)}.`;
    case "sunday.who_could_help people":
      switch (row["status"]) {
        case "no overlap found": return `${person} has no overlap found for ${role}.${differs(row)}`;
        case "availability needs confirmation": return `${person}'s availability for ${role} needs confirmation${reasons(row)}.${differs(row)}`;
        case "possible conflict": return `${person} has a possible conflict for ${role}${reasons(row)}.${differs(row)}`;
        case "left out": return `${person} was left out for ${role}${reasons(row)}.${differs(row)}`;
        default: return null;
      }
    case "sunday.pending_requests pending": return `${person} is pending for ${role}${at(row["time"])}. ${request(row["request"])}`;
    case "sunday.pending_requests leads_not_accepted": return `${person} is scheduled to lead ${role} but hasn't accepted.`;
    case "sunday.rule_checkins check_ins": {
      const n = num(row["sundays_in_a_row"]);
      return `${person} is scheduled ${n === null ? "several" : n} Sundays in a row; a check-in is about care, not performance.`;
    }
    case "rooms.conflicts rooms": {
      const room = str(row["room"]) ?? "A room";
      // The overlap's date is said once; a booking on that same date doesn't say it again.
      const day = dayOf(row["overlap"]);
      const bookings = (Array.isArray(row["bookings"]) ? row["bookings"] as Row[] : []).map(b => `${fromTo(b["time"], day)} (${str(b["approval"]) ?? "approval not known"})`);
      const setup = num(row["setup_minutes"]);
      const rule = row["church_rule"] === "not shared" ? " Your Church rules say this room isn't shared." : " No room rule is set for it.";
      const worked = row["worked_out_in_planning_center"] === "not worked out" ? " Planning Center doesn't show it as worked out." : " Whether it was worked out couldn't be read.";
      // The Sunday page's own label: confirmed by a Church rule and Calendar's conflict record, or Worth a look.
      const tone = row["label"] === "Room use needs review" ? "Room use needs review" : "Worth a look";
      return `${tone}: ${room} has bookings that overlap ${fromTo(row["overlap"])}${bookings.length ? `; the bookings are ${list(bookings)}` : ""}${setup ? `, with ${setup} minutes of setup time` : ""}.${rule}${worked}`;
    }
    case "followups.unowned follow_ups": {
      const due = str(row["due"]);
      return `${str(row["workflow"]) ?? "A follow-up"}, step ${str(row["step"]) ?? "not known"}, ${due && due !== "not known" ? `was due ${due}` : "is overdue"} and has no owner.`;
    }
    case "groups.clashes clashes": {
      const serving = (Array.isArray(row["serving"]) ? row["serving"] as Row[] : []).map(s => `${str(s["role"]) ?? "a role"} (${str(s["status"]) ?? "status not known"})${at(s["time"])}`);
      const meetings = (Array.isArray(row["group_meetings"]) ? row["group_meetings"] as Row[] : []).map(m => at(m["time"]).trim()).filter(Boolean);
      return `Worth a look: ${person} is scheduled for ${list(serving) || "a role"} while their group meets${meetings.length ? ` ${list(meetings)}` : " at the same time"}.`;
    }
    case "today.attention items": {
      const contacted = row["volunteers_contacted"] === "not contacted, according to the message" ? " The message says volunteers have not been contacted." : "";
      return `${row["label"] === "Needs a decision" ? "Needs a decision" : "Worth a look"}: ${str(row["event"]) ?? "An event"}${at({ starts_at: row["starts_at"] })}. ${sentence(capital(str(row["kind"]) ?? "something needs a look"))}${contacted}`;
    }
    default: return null;
  }
}
const notAccepted = (row: Row) => { const p = labels(row["scheduled_to_lead_not_accepted"]); return p.length ? ` Scheduled to lead but hasn't accepted: ${list(p)}.` : ""; };

/** The sentence for a tool's own summary (the payload's fact). */
function summary(tool: string, p: Row): string | null {
  const status = str(p["status"]);
  if (status === "not granted") {
    const what = tool === "rooms.conflicts" ? "Rooms" : tool === "followups.unowned" ? "Follow-ups" : "Group meetings";
    return `${what} aren't part of this Planning Center connection.`;
  }
  switch (tool) {
    case "sunday.overview": {
      const sunday = str(p["sunday"]);
      const d = num(p["needs_a_decision"]) ?? 0, w = num(p["worth_a_look"]) ?? 0, failed = num(p["reads_not_completed"]) ?? 0;
      const mode = p["mode"] === "recording" ? " This is a saved recording, not a current check." : p["mode"] === "fictional" ? " This is fictional example data." : "";
      const kept = p["kept_on_this_mac"] === "some findings are shown only in Ozzie on this Mac" ? " Some findings are shown only in Ozzie on this Mac, on the Sunday page." : "";
      return `For ${sunday && sunday !== "not known" ? `Sunday ${sunday}` : "this Sunday"}, this check found ${plural(d, "item", "items")} that need${d === 1 ? "s" : ""} a decision and ${w} worth a look.${failed ? ` ${plural(failed, "Planning Center read", "Planning Center reads")} didn't complete.` : ""}${kept}${mode}`;
    }
    case "sunday.open_needs": {
      const rows = Array.isArray(p["needs"]) ? p["needs"] as Row[] : [];
      const open = rows.filter(r => r["kind"] === "needs people").length, lead = rows.filter(r => r["kind"] === "no scheduled lead").length;
      if (!open && !lead && !rows.length) return "This check found no role that still needs people, and none without a scheduled lead.";
      return `This check found ${plural(open, "role", "roles")} that still need${open === 1 ? "s" : ""} people and ${lead} with no scheduled lead.`;
    }
    case "sunday.who_could_help": {
      const role = str((p["asked_for"] as Row | null)?.["role"]) ?? "This role";
      if (p["open_need"] === "none in the last check") return `${role} has no open need in the last check.`;
      const n = Array.isArray(p["people"]) ? p["people"].length : 0;
      return `On the team for ${role}, the check listed ${plural(n, "person", "people")}, in no particular order.`;
    }
    case "sunday.pending_requests": {
      const n = Array.isArray(p["pending"]) ? p["pending"].length : 0, m = Array.isArray(p["leads_not_accepted"]) ? p["leads_not_accepted"].length : 0;
      return `Planning Center shows ${plural(n, "pending request", "pending requests")} and ${plural(m, "scheduled lead", "scheduled leads")} who ${m === 1 ? "hasn't" : "haven't"} accepted. Pending means not accepted yet, which is not the same as asked.`;
    }
    case "sunday.rule_checkins": {
      const t = p["check_in_after_sundays_in_a_row"], n = Array.isArray(p["check_ins"]) ? p["check_ins"].length : 0;
      if (t === "off") return "Check-ins are turned off in your Church rules.";
      return `Your Church rules suggest a check-in after ${typeof t === "number" ? t : "several"} Sundays in a row; ${plural(n, "person", "people")} reached that this Sunday.`;
    }
    case "sunday.not_checked": {
      const reads = num(p["reads"]) ?? 0, failed = num(p["reads_not_completed"]) ?? 0;
      const lines = [...labels(p["services"]), ...labels(p["rooms_follow_ups_groups"])].map(sentence);
      return [failed ? `Of ${reads} Planning Center reads, ${failed} didn't complete.` : `All ${reads} Planning Center reads completed.`,
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
      return status === "group meets while serving" ? `${plural(n, "person serving this Sunday has", "people serving this Sunday have")} a group meeting at the same time.`
        : status === "no clash found" ? "No one serving this Sunday has a group meeting at the same time." : "Group meetings weren't fully checked, so this isn't the same as no clash.";
    }
    case "today.attention": {
      const s = status === "needs a decision" ? "something needs a decision" : status === "worth a look" ? "something is worth a look" : "nothing needs attention";
      const gaps = num(p["gaps"]);
      return `In the fictional email and calendar import${str(p["imported_at"]) && p["imported_at"] !== "not known" ? ` from ${str(p["imported_at"])!}` : ""}, ${s}.${gaps ? " Part of the import needs a closer look." : ""}`;
    }
    case "rules.current": {
      const t = p["check_in_after_sundays_in_a_row"];
      const leads = (Array.isArray(p["sunday_leads"]) ? p["sunday_leads"] as Row[] : []).flatMap(l => str(l["lead_role"]) ?? []);
      const rooms = (Array.isArray(p["rooms"]) ? p["rooms"] as Row[] : []).map(r => `${str(r["room"]) ?? "A room"} isn't shared${num(r["setup_minutes"]) ? `, with ${num(r["setup_minutes"])!} minutes of setup time` : ""}.`);
      return [t === "off" ? "Your Church rules don't suggest check-ins." : `Your Church rules suggest a check-in after ${typeof t === "number" ? t : "several"} Sundays in a row.`,
        leads.length ? `They ask for a scheduled Sunday lead for ${list(leads)}.` : "They don't ask for a scheduled Sunday lead.", ...rooms].join(" ");
    }
    case "planning_center.refresh":
      return status === "checked again" ? `Ozzie checked Planning Center again: ${plural(num(p["reads"]) ?? 0, "read", "reads")}, ${num(p["reads_not_completed"]) ?? 0} didn't complete.`
        : "The last Planning Center check is current, so Ozzie didn't need to check again.";
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

/**
 * The paragraphs for a verified answer (verify.ts), in placeholder form. A fact without a sentence is left out rather
 * than guessed at; an answer left with nothing to say says what wasn't covered.
 */
export function composeAnswer(answer: string, evidence: readonly ToolEnvelope[]): ComposedAnswer {
  const parsed = parseAnswer(answer);
  if (!parsed) return { kind: "not-covered", paragraphs: [NOT_COVERED], draft: null };
  const all = factsIn(evidence);
  const chosen = ordered(parsed.facts.flatMap(id => all.get(id) ?? []));
  const rendered = chosen.flatMap(f => { const s = sentenceFor(f); return s ? [{ f, s }] : []; });
  // Two tools can describe the same need: a sentence said in full at the start of a longer one (or said twice) is
  // shown once, in the longer sentence's place.
  const lines = rendered.map(r => r.s).filter((s, i, all) => !all.some((o, j) => j !== i && (o === s ? j < i : o.startsWith(`${s} `))));
  const people = rendered.filter(r => r.f.list !== null && PERSON_LISTS.has(r.f.list));
  const after = [
    ...(rendered.some(r => r.f.tool === "sunday.who_could_help" && r.f.row["status"] === "no overlap found") ? [NOT_FREE] : []),
    ...(people.length > 1 ? [NOT_RANKED] : []),
  ];
  let draft: string | null = null;
  if (parsed.draft) {
    const drafted = evidence.find(e => (e.payload as Row | null)?.["draft_id"] === parsed.draft);
    draft = str((drafted?.payload as Row | undefined)?.["draft"]);
  }
  switch (parsed.answer) {
    case "facts":
      return lines.length ? { kind: "facts", paragraphs: [...lines, ...after], draft: null } : { kind: "not-covered", paragraphs: [NOT_COVERED], draft: null };
    case "not-covered":
      return { kind: "not-covered", paragraphs: [NOT_COVERED, ...(lines.length ? [NOT_COVERED_MORE, ...lines, ...after] : [])], draft: null };
    case "nothing-needs-a-decision":
      return { kind: "nothing-needs-a-decision", paragraphs: [NOTHING_TO_DECIDE, ...lines, ...after], draft: null };
    case "draft":
      return draft ? { kind: "draft", paragraphs: [DRAFT_INTRO, ...lines, ...after], draft } : { kind: "not-covered", paragraphs: [NOT_COVERED], draft: null };
  }
}

// ---- Answers written on this Mac, without the AI -------------------------------------------------------------------

/** Said with each finding Ozzie keeps on this Mac (background checks, review M2/M3): shown here, never in any AI request. */
export const KEPT_HERE = "Kept on this Mac; never sent to an AI.";
export const NO_KIDS_TEAM = "No kids team is marked in your Church rules, so Ozzie doesn't count confirmed people or check background checks for one. You can mark one in Church rules, under Kids teams.";
export const BACKGROUND_OFF = "The background-check rule is off in your Church rules, so Ozzie didn't check background checks.";
export const BACKGROUND_UNCONFIRMED = "This check couldn't confirm background checks for everyone scheduled on your kids teams.";
/** Said only when the check supports it exactly (review Q H1): see kidsAnswer. */
export const BACKGROUND_ON_FILE = "This check found no one confirmed or pending on your kids teams without a current background check in Planning Center People.";
export const NOBODY_SCHEDULED = "No one is confirmed or pending on your kids teams this Sunday, so there were no background checks to look at.";
export const MEMBERS_UNREAD = "Background checks weren't checked, because who is scheduled didn't fully load.";
export const KIDS_MEMBERS_UNREAD = "Who is scheduled on your kids teams didn't fully load, so this isn't a full picture.";
export const WHICH_TEAM = "Ozzie couldn't tell which kids team you mean. Ask about a team by its name.";
/** Before the open decisions a decision question's answer left out. */
export const ALSO_ON_SUNDAY = "Also on the Sunday page, needing a decision:";
/** Before the open decisions, when they are the whole answer (a decision question that also names background checks). */
export const ON_SUNDAY = "On the Sunday page, needing a decision:";
export const NOTHING_OPEN = "This check found nothing open that needs a decision.";
const RESOLVED = "Resolved by you";
/** Findings set aside with "This isn't right" or "Stop flagging this", in the Sunday page's words: counted, never dropped. */
export const setAside = (n: number, what = "finding") => n === 1
  ? `One ${what} is set aside by your Church rules, so it isn't listed here; it's on the Sunday page.`
  : `${n} ${what}s are set aside by your Church rules, so they aren't listed here; they're on the Sunday page.`;

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
  readonly fill = (text: string) => text.replace(/\[Kept (?:person|role) ([1-9]\d{0,3})\]/gu, (whole, n: string) => this.#shown[+n - 1] ?? whole);
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
function reader(tools: HarnessTools, signal: AbortSignal) {
  const task = localTask();
  return async (name: string, args: Record<string, unknown> = {}): Promise<ToolEnvelope | null> => {
    try { return await tools.run(name, args, signal, task); } catch { return null; }
  };
}
/** Sources once each, in the order first given. */
const once = (list: { source: string; check_time: string }[]) => list.filter((s, i) => list.findIndex(o => o.source === s.source && o.check_time === s.check_time) === i);

/**
 * A background-check finding in the Sunday page's words, in placeholder form, with its source and check time and that
 * it stays on this Mac. Never part of any tool result or request (forModels); the app restores it here.
 */
export function backgroundSentence(f: Finding, person: string, role: string, zone: string | null, tone = toneOf(f)): string {
  const what = f.check === "expires-before-sunday" ? `${person}'s background check on file expires before Sunday.`
    : f.check === "expires-on-sunday" ? `${person}'s background check on file expires on Sunday.` : `${person} has no current background check on file.`;
  const start = localIso(f.position?.interval?.starts_at, zone), checked = localIso(f.checked_at, zone);
  const look = f.tone === "look" && f.check === "none-current"
    ? " Planning Center showed no current background checks for anyone on your kids teams; your Planning Center login may not be able to see them." : "";
  return `${tone}: ${what} Scheduled for ${role}${start ? ` at ${start}` : " this Sunday"}. Your Church rules ask for a current background check before serving with kids.${look}` +
    ` From ${f.source ?? PEOPLE_SOURCE}${checked ? `, checked ${checked}` : ""}. ${KEPT_HERE}`;
}
/** A background-check finding's sentence with kept names, and its source. */
function kept(data: HarnessData, names: KeptNames, f: Finding, tone: string): { text: string; source: { source: string; check_time: string } } {
  return {
    text: backgroundSentence(f, names.person(data, f.person_id), names.role(f.position?.name), data.brief?.time_zone ?? null, tone),
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
export const kidsWording = (typed: string) => { const text = fold(typed); return !DRAFT_ASK.test(text) && (KIDS_WORDS.test(text) || BACKGROUND_WORDING.test(text)); };

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
  const kids = KIDS_WORDS.test(text), background = BACKGROUND_WORDING.test(text), who = WHO_WORDS.test(text);
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
  const overviewRows = background ? [] : rowsOf(overview, "findings"), needRows = rowsOf(openNeeds, "needs");
  for (const f of mine) {
    const tone = toneWith(f, decisionsBy);
    if (f.kind === "background-check") {
      const k = kept(data, names, f, tone);
      out.paragraphs.push(k.text);
      sources.push(k.source);
      continue;
    }
    if (NEED_KINDS.has(f.kind)) {
      const row = needRows[needs.findIndex(x => x.id === f.id)];
      const text = row && openNeeds ? sentenceFor(factOf(openNeeds, "needs", row)) : null;
      if (text) out.paragraphs.push(`${tone}: ${text}`);
      const role = row ? str(row["role"]) : null;
      if (q.who && f.kind === "needs-people" && role) {
        const help = await run("sunday.who_could_help", { role });
        const people = rowsOf(help, "people");
        if (help && !people.length) out.paragraphs.push(`The check found no one else on the team for ${role}.`);
        for (const p of ordered(people.map(r => factOf(help!, "people", r)))) { const s = sentenceFor(p); if (s) out.paragraphs.push(s); }
        if (people.some(r => r["status"] === "no overlap found")) out.paragraphs.push(NOT_FREE);
        if (people.length > 1) out.paragraphs.push(NOT_RANKED);
      }
      continue;
    }
    const row = overviewRows[shared.findIndex(x => x.id === f.id)];
    const text = row ? finding(row) : null;
    if (text) out.paragraphs.push(`${tone}: ${text}${decided(row!)}`);
  }
  if (hidden.length) out.paragraphs.push(setAside(hidden.length, background ? "background check" : "finding"));
  if (!mine.length && !hidden.length) {
    const label = (team: string) => kidsTeams(rules).find(t => t.team_id === team)?.name ?? brief.findings.find(f => f.position?.team_id === team)?.position?.name
      ?? brief.positions.find(p => p.team_id === team)?.name;
    const one = q.teams.length === 1 ? label(q.teams[0]!) : undefined;
    const where = one ? names.role(one) : q.marked ? "your kids teams" : null;
    if (background) {
      // Only when who is scheduled was read, someone is, every background check was read, and the check is complete and current.
      const current = overview?.completeness === "complete" && !brief.stale && data.mode !== "recording";
      out.paragraphs.push(!coverage.read ? BACKGROUND_UNCONFIRMED : !coverage.scheduled ? NOBODY_SCHEDULED
        : coverage.checked && current && !out.gaps.length ? BACKGROUND_ON_FILE : BACKGROUND_UNCONFIRMED);
      if (coverage.checkedAt) sources.push({ source: PEOPLE_SOURCE, check_time: coverage.checkedAt });
    } else if (where) out.paragraphs.push(`This check found nothing for ${where} that needs a decision or is worth a look.`);
  }
  return finish();
}

/** Questions about what still needs a decision or attention this Sunday (review Q L4: also problems, issues, "are we good"). */
export const DECISION_QUESTION = new RegExp("(?<![\\p{L}\\p{N}])(?:decisions?|decide|attention|outstanding|open\\s+items?|to-?dos?|left\\s+to\\s+(?:do|decide|sort\\s+out)" +
  "|what(?:'s|\\s+is)\\s+(?:left|open|missing|wrong)|(?:is|are)\\s+(?:we|sunday|everything|things|it)\\s+(?:all\\s+)?(?:ready|set|covered|good|ok|okay)" +
  "|sunday\\s+ready|ready\\s+for\\s+sunday|problems?|issues?|concerns?" +
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
    case "sunday.overview findings": case "sunday.open_needs needs": return [findingKey(str(r["kind"]), r)];
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
 * aside. Empty when the answer said them all and nothing is set aside.
 */
export async function decisionsLeftOut(tools: HarnessTools, answer: string, evidence: readonly ToolEnvelope[], signal: AbortSignal,
  framing: { head: string; none: string | null } = { head: ALSO_ON_SUNDAY, none: null }): Promise<LocalAnswer> {
  const names = new KeptNames();
  const out: LocalAnswer = { paragraphs: [], fill: names.fill, evidence: [], sources: [], gaps: [] };
  const data = tools.data, { brief, decisions } = data;
  if (!brief) return out;
  const all = factsIn(evidence), said = new Set<string>();
  for (const id of parseAnswer(answer)?.facts ?? []) for (const k of all.has(id) ? keysOf(all.get(id)!) : []) said.add(k);
  const read = reader(tools, signal);
  const overview = await read("sunday.overview"), rooms = await read("rooms.conflicts"), followUps = await read("followups.unowned");
  out.evidence = [overview, rooms, followUps].filter((e): e is ToolEnvelope => e !== null);
  const settled = new Set(applyDecisions(brief, decisions).items.filter(i => i.decision && i.state !== "reopened").map(i => i.finding.id));
  const shared = forModels(brief).findings, rows = rowsOf(overview, "findings");
  const items: string[] = [], sources: { source: string; check_time: string }[] = [];
  for (const f of brief.findings) {
    if (f.tone !== "decision" || settled.has(f.id)) continue;
    if (f.kind === "background-check") { const k = kept(data, names, f, toneOf(f)); items.push(k.text); sources.push(k.source); continue; }
    const row = rows[shared.findIndex(x => x.id === f.id)];
    if (!row || !overview || said.has(findingKey(str(row["kind"]), row))) continue;
    const text = sentenceFor(factOf(overview, "findings", row));
    if (text) items.push(text);
  }
  for (const row of rowsOf(rooms, "rooms")) {
    if (row["label"] !== "Room use needs review" || said.has(roomKey(row))) continue;
    const text = sentenceFor(factOf(rooms!, "rooms", row));
    if (text) items.push(text);
  }
  for (const row of rowsOf(followUps, "follow_ups")) {
    if (said.has(followUpKey(row))) continue;
    const text = sentenceFor(factOf(followUps!, "follow_ups", row));
    if (text) items.push(text);
  }
  const aside = brief.hidden?.length ?? 0;
  out.paragraphs = [...(items.length ? [framing.head, ...items] : framing.none ? [framing.none] : []), ...(aside ? [setAside(aside)] : [])];
  out.sources = once(sources);
  return out;
}

/**
 * Every open decision the Sunday page shows, written here without the AI: for a decision question that also names
 * background checks, which may never be sent (review Q H2, M2). Background-check lines of What I didn't check are Worth a look.
 */
export async function openDecisions(tools: HarnessTools, signal: AbortSignal): Promise<LocalAnswer> {
  const out = await decisionsLeftOut(tools, '{"answer":"not-covered"}', [], signal, { head: ON_SUNDAY, none: NOTHING_OPEN });
  out.gaps = (tools.data.brief?.not_checked ?? []).filter(l => l.startsWith(BACKGROUND_LINE) || /kids team/iu.test(l));
  return out;
}
