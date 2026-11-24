// Kids teams for a church on B1 Church or Breeze: the same Church rule as Planning Center's first kids rule
// (core/src/kids-rules.ts), "at least N confirmed people at each service time" on what the church marks as serving with
// kids. Pure: no I/O, no clock, no model. Nothing new is read: only the roles and answers every check already reads.
//
// What the church marks, as each system really groups its roles:
// - B1 Church: a team, the B1 group each role draws its people from (`team_id`, B1's own group id), so a mark holds for
//   every plan.
// - Breeze: a role, by its name. Breeze ties no team to its roles, and a role's id is one event's own (`list_roles` reads
//   the roles of one event), so the role's name is what carries from one event to the next.
// What counts as confirmed: the answer each system calls accepted (B1 Church's "Accepted"; Breeze's accepted code). Not
// answered yet (B1's "Unconfirmed", Breeze's "no response") is never confirmed; an answer Ozzie couldn't read makes the
// count uncertain (Worth a look), never confirmed. Neither system says which of a plan's service times a person serves:
// the service is counted as the one time each check reads it as.
// Background checks: neither system shares them (facts.ts cannotSee), so this rule never checks them and says so.
// Findings carry person ids only; names resolve on this Mac at render time.
import type { ServingInterval } from "../coverage.js";
import { KIDS_DEFAULT_MIN, KIDS_MAX_MIN, KIDS_MAX_TEAMS } from "../kids-rules.js";
import type { DayWords } from "../service-day.js";
import type { Finding } from "../sunday-brief.js";
import type { SundayRules, SystemKidsSetting } from "../sunday-capture.js";
import { labelsOf, placeholderScope } from "./placeholders.js";
import { readsFor, SYSTEMS, type SystemCapture, type SystemId } from "./types.js";

/** What a church marks on each system: B1 Church's teams, Breeze's roles. Genesis shares no schedules, so nothing. */
export type KidsUnit = "team" | "role";
export const KIDS_UNIT: Readonly<Partial<Record<SystemId, KidsUnit>>> = Object.freeze({ b1: "team", breeze: "role" });

const ID = /^[A-Za-z0-9_-]{1,64}$/u;
const MAX_ROLE = 120;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const unique = (ids: readonly string[]) => [...new Set(ids)].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
const clean = (text: string) => text.normalize("NFKC").replace(/\s+/gu, " ").trim();

/**
 * B1 Church gives a plan's people per role, not per service time: said on a kids team's finding and on Church rules
 * (system-kids-rules.tsx), so "at each service time" is never read as a count per time there (privacy review L4).
 */
export const B1_ACROSS_THE_SERVICE = "B1 Church doesn't say which of a plan's service times each person serves, so Ozzie counts everyone who accepted across the service.";

/** A Breeze role's mark, from its name: the same for "Nursery", " nursery " and "NURSERY". Empty for no name. */
export const roleKey = (name: string): string => clean(name).toLowerCase().slice(0, MAX_ROLE);
/** Whether `id` is a mark this system can hold: a B1 group id, or a Breeze role's key. */
function validId(system: SystemId, id: unknown): id is string {
  if (typeof id !== "string") return false;
  if (KIDS_UNIT[system] === "team") return ID.test(id);
  if (KIDS_UNIT[system] === "role") return id.length > 0 && id.length <= MAX_ROLE && roleKey(id) === id;
  return false;
}
/**
 * The id a kids finding's position carries as its team, for a mark: B1 Church's own group id, so the team's roles and
 * the kids finding share it (as Planning Center's do); for a Breeze role, its key under `role:`, which no Breeze role's
 * own team ("?", no team) ever is.
 */
export const kidsTeamId = (system: SystemId, id: string): string => KIDS_UNIT[system] === "role" ? `role:${encodeURIComponent(id)}` : id;

/**
 * The marks one church set, valid entries only: an id its system can hold, a whole count 1–10, one entry per id, and its
 * display name when one was kept; at most KIDS_MAX_TEAMS, in the order marked. `church`: `<system>:<church id>`
 * (placeholders.ts `placeholderScope`), so a mark set for one church never applies to another.
 */
export function systemKidsMarks(rules: Pick<SundayRules, "systemKids"> | null | undefined, church: string): SystemKidsSetting[] {
  const system = church.slice(0, church.indexOf(":")) as SystemId;
  if (!KIDS_UNIT[system]) return [];
  const all = rules?.systemKids;
  const list: unknown = all && typeof all === "object" && Object.hasOwn(all, church) ? (all as Record<string, unknown>)[church] : null;
  const seen = new Set<string>();
  return (Array.isArray(list) ? list as unknown[] : []).flatMap(r => {
    if (!r || typeof r !== "object") return [];
    const { id, min_confirmed, name } = r as Record<string, unknown>;
    if (!validId(system, id) || typeof min_confirmed !== "number" || !Number.isInteger(min_confirmed) || min_confirmed < 1 ||
      min_confirmed > KIDS_MAX_MIN || seen.has(id)) return [];
    seen.add(id);
    const label = typeof name === "string" ? clean(name).slice(0, MAX_ROLE) : "";
    return [{ id, min_confirmed, ...(label ? { name: label } : {}) }];
  }).slice(0, KIDS_MAX_TEAMS);
}
/**
 * Marks `id` (a B1 group id, or a Breeze role's key) as serving with kids, needing `min` confirmed people (clamped 1–10),
 * or unmarks it (null), for one church only. `name` is its display name, kept so Church rules can list it after it leaves
 * the service checked. An eleventh isn't added. Every other church's marks, and every other rule, are left as they are.
 */
export function withSystemKids(rules: SundayRules, church: string, id: string, min: number | null, name?: string): SundayRules {
  const system = church.slice(0, church.indexOf(":")) as SystemId;
  if (!KIDS_UNIT[system] || !validId(system, id)) return rules;
  const marked = systemKidsMarks(rules, church), known = marked.find(t => t.id === id);
  const rest = marked.filter(t => t.id !== id);
  if (min !== null && !known && marked.length >= KIDS_MAX_TEAMS) return rules;
  const label = name !== undefined ? clean(name).slice(0, MAX_ROLE) : known?.name;
  const next = min === null ? rest
    : [...rest, { id, min_confirmed: Math.max(1, Math.min(KIDS_MAX_MIN, Math.round(Number.isFinite(min) ? min : KIDS_DEFAULT_MIN))), ...(label ? { name: label } : {}) }];
  const all: Record<string, SystemKidsSetting[]> = { ...(rules.systemKids ?? {}) };
  if (next.length) all[church] = next; else delete all[church];
  const others: SundayRules = { ...rules };
  delete others.systemKids;
  return Object.keys(all).length ? { ...others, systemKids: all } : others;
}

/** One team (B1 Church) or role (Breeze) a check offers to mark: its mark id, its name, and the roles it holds. */
export interface KidsChoice { id: string; name: string; roles: string[] }
/**
 * What a church can mark from one check, in the system's own order: B1 Church's teams (each named by B1's own group name,
 * else by its roles' names, as Planning Center's teams are), or Breeze's roles by name. A role with no team in B1 Church,
 * or no name in Breeze, can't be marked: it is left out.
 */
export function kidsChoices(capture: SystemCapture): KidsChoice[] {
  const unit = KIDS_UNIT[capture.system];
  if (!unit) return [];
  const labels = labelsOf(capture);
  const label = (key: string) => Object.hasOwn(labels, key) ? clean(labels[key]!) : "";
  const out = new Map<string, KidsChoice>();
  for (const p of capture.positions) {
    const role = label(`position:${p.id}`);
    const id = unit === "team" ? p.team_id : role ? roleKey(role) : null;
    if (!id || !validId(capture.system, id)) continue;
    const known = out.get(id);
    if (known) { if (role && !known.roles.includes(role)) known.roles.push(role); continue; }
    out.set(id, { id, name: unit === "team" ? label(`team:${id}`) : role, roles: role ? [role] : [] });
  }
  return [...out.values()].map(c => ({ ...c, name: c.name || c.roles.join(", ") || "A team without a name" }));
}
/** The positions of one check a mark covers: B1 Church, every role of the team; Breeze, every role of that name. */
function covered(capture: SystemCapture, id: string): string[] {
  const labels = labelsOf(capture);
  return capture.positions.filter(p => KIDS_UNIT[capture.system] === "team" ? p.team_id === id
    : Object.hasOwn(labels, `position:${p.id}`) && roleKey(labels[`position:${p.id}`]!) === id).map(p => p.id);
}

/**
 * What a church on B1 Church or Breeze marked, as a kids question on this Mac matches findings to it (harness compose.ts
 * kidsQuestion): each mark's finding team id (`kidsTeamId`) and name, and, for a Breeze role, the role's key, so the
 * role's own findings (which carry no team) are about it too. Local only, like every name a check read.
 */
export interface KidsMarked { team_id: string; name?: string; role?: string }
export function kidsMarked(capture: SystemCapture, rules: Pick<SundayRules, "systemKids"> | null | undefined): KidsMarked[] {
  const choices = new Map(kidsChoices(capture).map(c => [c.id, c.name]));
  return systemKidsMarks(rules, placeholderScope(capture)).map(m => {
    const name = choices.get(m.id) ?? m.name;
    return { team_id: kidsTeamId(capture.system, m.id), ...(name ? { name } : {}), ...(KIDS_UNIT[capture.system] === "role" ? { role: m.id } : {}) };
  });
}

export interface SystemKidsContext {
  /** The service's time as its findings say it: null for a service with no time of day, or one not known. */
  interval: ServingInterval | null;
  /** The service's words (coverage.ts `day`). */
  day: DayWords;
}
export interface SystemKidsResult { findings: Finding[]; not_checked: string[] }
/** The first line of What I didn't check when the counts weren't made: kids questions in Ask look for it (compose.ts). */
export const kidsUncounted = (unit: KidsUnit) => `Kids ${unit} counts weren't checked, because who is scheduled didn't fully load.`;

/**
 * The kids rule for one check of a church on B1 Church or Breeze, from the marks its Church rules keep for that church
 * (`rules.systemKids`): one finding for each mark with fewer people who accepted than the rule asks, and what wasn't
 * counted. The service is one time. Only from roles and answers read whole: from a read cut short, "no one accepted"
 * could be untrue. Nothing when nothing is marked.
 */
export function systemKidsFindings(capture: SystemCapture, rules: Pick<SundayRules, "systemKids"> | null | undefined, ctx: SystemKidsContext): SystemKidsResult {
  const unit = KIDS_UNIT[capture.system];
  const marks = systemKidsMarks(rules, placeholderScope(capture));
  if (!unit || !marks.length) return { findings: [], not_checked: [] };
  const name = SYSTEMS[capture.system].name;
  const d = ctx.day;
  const whole = (part: "positions" | "assignments") => readsFor(capture.system, part).every(w => {
    const reads = capture.reads.filter(r => r.read === w);
    return reads.length > 0 && reads.every(r => r.outcome === "ok");
  });
  if (!whole("positions") || !whole("assignments")) return { findings: [], not_checked: [kidsUncounted(unit)] };
  const choices = new Map(kidsChoices(capture).map(c => [c.id, c.name]));
  const onPlan = marks.filter(m => covered(capture, m.id).length > 0);
  const offPlan = marks.length - onPlan.length;
  const not_checked = offPlan ? [`${plural(offPlan, `kids ${unit}`)} ${offPlan === 1 ? "isn't" : "aren't"} on ${unit === "team" ? `${d.thisOne}'s plan` : `${d.thisOne}'s event`} in ${name}, so ${offPlan === 1 ? "it wasn't" : "they weren't"} counted.`] : [];
  const findings: Finding[] = [];
  const inRole = new Set(capture.assignments.map(a => a.person_id));
  const noRole = new Set(capture.on_service.filter(p => !inRole.has(p))).size;
  for (const mark of onPlan) {
    const roles = new Set(covered(capture, mark.id));
    const here = capture.assignments.filter(a => roles.has(a.position_id));
    // Each person once: someone who accepted on one of the team's roles is confirmed, whatever they answered on another.
    const confirmed = unique(here.filter(a => a.status === "accepted").map(a => a.person_id));
    if (confirmed.length >= mark.min_confirmed) continue;
    const yet = (status: "unconfirmed" | "unknown") => here.filter(a => a.status === status && !confirmed.includes(a.person_id));
    const waiting = yet("unconfirmed");
    const asked = unique(waiting.filter(a => a.asked === true).map(a => a.person_id));
    const not_sent = unique(waiting.filter(a => a.asked === false).map(a => a.person_id)).filter(p => !asked.includes(p));
    const unknownSent = unique(waiting.filter(a => a.asked === null).map(a => a.person_id)).filter(p => !asked.includes(p) && !not_sent.includes(p));
    // Someone whose answer Ozzie couldn't read may have accepted: then the count is uncertain, not a fact.
    const maybe = unique(yet("unknown").map(a => a.person_id)).filter(p => !asked.includes(p) && !not_sent.includes(p) && !unknownSent.includes(p));
    const uncertain = maybe.length > 0 && confirmed.length + maybe.length >= mark.min_confirmed;
    const label = choices.get(mark.id) ?? mark.name ?? (unit === "team" ? "A kids team" : "A kids role");
    const team_id = kidsTeamId(capture.system, mark.id);
    const pending = [
      ...(asked.length ? [`${asked.length} asked with no answer yet`] : []), ...(not_sent.length ? [`${not_sent.length} not sent yet`] : []),
      ...(unknownSent.length ? [`${unknownSent.length} ${unknownSent.length === 1 ? "hasn't" : "haven't"} answered, and ${name} doesn't say whether the request was sent`] : []),
    ];
    findings.push({
      id: `kids:${team_id}:${ctx.interval?.starts_at ?? "service"}`, key: JSON.stringify(["too-few-confirmed", team_id, ctx.interval?.starts_at ?? null]),
      kind: "too-few-confirmed", tone: uncertain ? "look" : "decision",
      position: { id: `kids:${team_id}`, team_id, name: label, interval: ctx.interval },
      needed: mark.min_confirmed, confirmed, asked, not_sent, ...(unknownSent.length ? { waiting: unknownSent } : {}),
      why: [
        `Your Church rules ask for at least ${mark.min_confirmed} confirmed people on this kids ${unit} at each ${capture.system === "b1" ? "service" : "service time"}.`,
        ...(capture.system === "b1" ? [B1_ACROSS_THE_SERVICE] : []),
        `${name} shows ${confirmed.length === 0 ? "no one" : plural(confirmed.length, "person", "people")} who accepted for ${ctx.interval ? "this service time" : d.thisOne}, and Ozzie counts accepted as confirmed.`,
        ...(pending.length ? [`Not answered yet isn't counted as confirmed: ${pending.join(", ")}.`] : []),
        ...(maybe.length ? [`${name} gave an answer Ozzie couldn't read for ${plural(maybe.length, "person", "people")} on this ${unit}, so Ozzie can't count them.`] : []),
        // Someone on the service in no role (Breeze) may be helping here, but nothing says so: said, never counted.
        ...(noRole ? [`${name} lists ${plural(noRole, "person", "people")} on the service with no role; Ozzie doesn't count them on this ${unit}.`] : []),
        `Ozzie counts confirmed people on the ${unit}; it doesn't check ages.`,
      ],
    });
  }
  return { findings, not_checked };
}
