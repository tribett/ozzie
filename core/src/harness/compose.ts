// The answer, written on this Mac (structured answers, review 2026-11-14 section C; build contract §5 and §8). The
// model only chose fact ids from the tool results (verify.ts); every sentence here is Ozzie's own: one fixed template
// per kind of fact, filled with the fact's labels, counts, ISO times and fixed words, so its numbers and times are the
// tool's own and nobody is described, ranked, called willing or said to have been contacted. People are shown in
// label order whatever order the model chose them in, which says nothing about anyone. A draft is only ever the
// drafting tool's own text. Labels and ISO times stay in placeholder form here; the app restores them on this Mac.
import { NOT_COVERED } from "../ask.js";
import type { ToolEnvelope } from "./contract.js";
import { parseAnswer, type AnswerKind } from "./fixed.js";
import { FACT_LISTS } from "./tools.js";

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
const fromTo = (time: unknown) => {
  const t = time as Row | null;
  const a = str(t?.["starts_at"]), b = str(t?.["ends_at"]);
  return a && b && a !== "not known" && b !== "not known" ? `from ${a} to ${b}` : "at a time that couldn't be read";
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
      const bookings = (Array.isArray(row["bookings"]) ? row["bookings"] as Row[] : []).map(b => `${fromTo(b["time"])} (${str(b["approval"]) ?? "approval not known"})`);
      const setup = num(row["setup_minutes"]);
      const rule = row["church_rule"] === "not shared" ? " Your Church rules say this room isn't shared." : " No room rule is set for it.";
      const worked = row["worked_out_in_planning_center"] === "not worked out" ? " Planning Center doesn't show it as worked out." : " Whether it was worked out couldn't be read.";
      return `Worth a look: ${room} has bookings that overlap ${fromTo(row["overlap"])}${bookings.length ? `; the bookings are ${list(bookings)}` : ""}${setup ? `, with ${setup} minutes of setup time` : ""}.${rule}${worked}`;
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
      return `For ${sunday && sunday !== "not known" ? `Sunday ${sunday}` : "this Sunday"}, this check found ${plural(d, "item", "items")} that need${d === 1 ? "s" : ""} a decision and ${w} worth a look.${failed ? ` ${plural(failed, "Planning Center read", "Planning Center reads")} didn't complete.` : ""}${mode}`;
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
  const lines = rendered.map(r => r.s);
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
