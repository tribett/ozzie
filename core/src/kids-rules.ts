// Kids safety rules, as the church sets them in Church rules. Pure: no I/O, no clock, no model.
//
// 1. "At least N confirmed people at each service time" for each team the church marks as a kids
//    team (no team is assumed). It counts confirmed Planning Center Services assignments already
//    read; pending is never confirmed, and an unsent request is never called asked. Services has no
//    age, so this counts confirmed people, never "adults".
// 2. "A current background check before serving with kids": for people scheduled (confirmed or
//    pending) on a kids team, the People background-check read (`people_background_checks`). The
//    native read asks Planning Center for cleared checks only, so an unfinished or not-cleared check
//    never reaches Ozzie; a person reads as either having a current check on file or not. Nothing
//    about a check is shown beyond "no current background check on file" or "expires before Sunday".
//
// Findings carry person ids only; names resolve on this Mac at render time.
import { localDate } from "./church-time.js";
import type { ServingInterval } from "./coverage.js";
import type { Finding, SundayBrief } from "./sunday-brief.js";
import type { KidsTeamSetting, SundayCapture, SundayRead, SundayRules } from "./sunday-capture.js";

/** The People read behind rule 2 (native `Collection::PeopleBackgroundChecks`). Never a Services read. */
export const BACKGROUND_CHECKS = "people_background_checks";
export const KIDS_DEFAULT_MIN = 2;
export const KIDS_MAX_MIN = 10;
/** Kids teams kept, in the order marked: the native check reads background checks for at most this many teams. */
export const KIDS_MAX_TEAMS = 10;
/** Every "What I didn't check" line about background checks starts so; models never see them (forModels). */
export const BACKGROUND_LINE = "Background checks";
const SOURCE = "Planning Center People";

const isId = (v: unknown): v is string => typeof v === "string" && /^[1-9]\d{0,19}$/.test(v);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The kids teams the church set, valid entries only: a numeric team id, a whole count 1–10, one entry per team,
 * and its display name when one was kept. At most KIDS_MAX_TEAMS, in the order marked, so a Sunday check is never
 * refused for asking about too many.
 */
/** Cleared statuses: Planning Center's own check, or one the church entered by hand (`manual_clear`, seen live 2026-11-14). */
const CLEARED = new Set(["complete_clear", "manual_clear"]);
export function kidsTeams(rules: SundayRules): KidsTeamSetting[] {
  const seen = new Set<string>();
  return (Array.isArray(rules.kidsTeams) ? rules.kidsTeams as unknown[] : []).flatMap(r => {
    if (!r || typeof r !== "object") return [];
    const { team_id, min_confirmed, name } = r as Record<string, unknown>;
    if (!isId(team_id) || typeof min_confirmed !== "number" || !Number.isInteger(min_confirmed) || min_confirmed < 1 ||
      min_confirmed > KIDS_MAX_MIN || seen.has(team_id)) return [];
    seen.add(team_id);
    const label = typeof name === "string" ? name.replace(/\s+/gu, " ").trim().slice(0, 120) : "";
    return [{ team_id, min_confirmed, ...(label ? { name: label } : {}) }];
  }).slice(0, KIDS_MAX_TEAMS);
}
/**
 * Marks a team as a kids team needing `min` confirmed people at each time (clamped 1–10), or unmarks it (null).
 * `name` is the team's display name, kept so Church rules can list it after it leaves the Sunday checked. An
 * eleventh team isn't added.
 */
export function withKidsTeam(rules: SundayRules, team_id: string, min: number | null, name?: string): SundayRules {
  const marked = kidsTeams(rules), known = marked.find(t => t.team_id === team_id);
  const rest = marked.filter(t => t.team_id !== team_id);
  if (min !== null && !known && marked.length >= KIDS_MAX_TEAMS) return rules;
  const label = name ?? known?.name;
  const next = min === null || !isId(team_id) ? rest
    : [...rest, { team_id, min_confirmed: Math.max(1, Math.min(KIDS_MAX_MIN, Math.round(Number.isFinite(min) ? min : KIDS_DEFAULT_MIN))), ...(label ? { name: label } : {}) }];
  return { ...rules, kidsTeams: next };
}
export const withKidsBackgroundChecks = (rules: SundayRules, on: boolean): SundayRules => ({ ...rules, kidsBackgroundChecks: on });
/**
 * The brief as anything bound for a model sees it (agent tools, Ask, the shared check): background-check findings
 * and every "What I didn't check" line about background checks stay on this Mac (coordinator decision, review
 * M2/M3, 2026-11-14). Kids-team counts stay: they carry no more than placeholders and counts.
 */
export function forModels(brief: SundayBrief): SundayBrief {
  return { ...brief, findings: brief.findings.filter(f => f.kind !== "background-check"),
    not_checked: brief.not_checked.filter(line => !line.startsWith(BACKGROUND_LINE)),
    ...(brief.hidden ? { hidden: brief.hidden.filter(h => h.finding.kind !== "background-check") } : {}) };
}
/** Rule 2 applies once a kids team is set, unless the church turned it off. */
export const backgroundChecksOn = (rules: SundayRules) => kidsTeams(rules).length > 0 && rules.kidsBackgroundChecks !== false;
/** Team ids whose scheduled people the native check reads background checks for: none while rule 2 is off. */
export const backgroundCheckTeamIds = (rules: SundayRules) => backgroundChecksOn(rules) ? kidsTeams(rules).map(t => t.team_id) : [];

interface Row { type?: unknown; id?: unknown; attributes?: Record<string, unknown>; relationships?: Record<string, { data?: unknown } | undefined> }
const rows = (data: unknown): Row[] => (Array.isArray(data) ? data : data ? [data] : []).filter((r): r is Row => !!r && typeof r === "object");
const relIds = (row: Row, key: string): string[] => {
  const d = row.relationships?.[key]?.data;
  return (Array.isArray(d) ? d : d ? [d] : []).flatMap(x => isId((x as { id?: unknown })?.id) ? [(x as { id: string }).id] : []);
};
const statusOf = (v: unknown) => v === "C" || v === "Confirmed" ? "C" : v === "U" || v === "Unconfirmed" ? "U" : v === "D" || v === "Declined" ? "D" : "?";
const allOk = (reads: SundayRead[]) => reads.length > 0 && reads.every(r => r.outcome === "ok" && r.body);
const unique = (ids: string[]) => [...new Set(ids)].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface KidsContext {
  /** Each team's display name (its position names), from the coverage mapping. */
  teamNames: ReadonlyMap<string, string>;
  /** The church-local date of this Sunday (`planDate`), or null when it wasn't read. */
  sundayDate: string | null;
  /** The church's time zone, for the local date of a check time; null falls back to the UTC date. */
  zone: string | null;
}
export interface KidsResult { findings: Finding[]; not_checked: string[] }

export function kidsFindings(capture: SundayCapture, rules: SundayRules, ctx: KidsContext): KidsResult {
  const teams = kidsTeams(rules);
  if (!teams.length) return { findings: [], not_checked: [] };
  const memberReads = capture.reads.filter(r => r.collection === "team_members");
  const timeReads = capture.reads.filter(r => r.collection === "plan_times");
  const members = memberReads.filter(r => r.body).flatMap(r => rows(r.body!.data)).filter(m => m.type === "PlanPerson");
  const needs = capture.reads.filter(r => r.collection === "needed_positions" && r.body).flatMap(r => rows(r.body!.data));
  const times = new Map<string, ServingInterval>();
  for (const t of timeReads.filter(r => r.body).flatMap(r => rows(r.body!.data))) {
    const starts_at = t.attributes?.starts_at, ends_at = t.attributes?.ends_at, type = t.attributes?.time_type;
    if (t.type === "PlanTime" && isId(t.id) && typeof starts_at === "string" && typeof ends_at === "string" && (type === undefined || type === "service")) {
      times.set(t.id, { starts_at, ends_at });
    }
  }
  const teamOf = (row: Row) => relIds(row, "team")[0];
  const findings: Finding[] = [];
  const not_checked: string[] = [];
  const onPlan = teams.filter(t => members.some(m => teamOf(m) === t.team_id) || needs.some(n => teamOf(n) === t.team_id));
  const offPlan = teams.length - onPlan.length;

  // Rule 1: confirmed people at each service time, only when who is scheduled and the times were fully read.
  const counted = allOk(memberReads) && allOk(timeReads);
  if (onPlan.length && !counted) not_checked.push("Kids team counts weren't checked, because who is scheduled didn't fully load.");
  if (offPlan && counted) not_checked.push(`${plural(offPlan, "kids team")} ${offPlan === 1 ? "isn't" : "aren't"} on this Sunday's plan, so ${offPlan === 1 ? "it wasn't" : "they weren't"} counted.`);
  for (const team of counted ? onPlan : []) {
    const name = ctx.teamNames.get(team.team_id) ?? "A kids team";
    const own = members.filter(m => teamOf(m) === team.team_id);
    // Times this team serves: from its open positions and its people, service times only, in time order.
    const ids = new Set([...needs.filter(n => teamOf(n) === team.team_id).flatMap(n => relIds(n, "time")), ...own.flatMap(m => relIds(m, "times"))]);
    const served = [...ids].filter(id => times.has(id)).sort((a, b) => times.get(a)!.starts_at.localeCompare(times.get(b)!.starts_at));
    const placed = (m: Row) => relIds(m, "times").some(id => times.has(id));
    const unplaced = unique(own.filter(m => statusOf(m.attributes?.status) === "C" && !placed(m)).flatMap(m => relIds(m, "person")));
    const at = (time: string | null) => own.filter(m => time === null || relIds(m, "times").includes(time));
    const slots: (string | null)[] = served.length ? served : [null];
    for (const time of slots) {
      const here = at(time);
      const people = (status: string, sent?: boolean) => unique(here.filter(m => statusOf(m.attributes?.status) === status &&
        (sent === undefined || Boolean(m.attributes?.notification_sent_at) === sent)).flatMap(m => relIds(m, "person")));
      const confirmed = people("C");
      if (confirmed.length >= team.min_confirmed) continue;
      // Confirmed people Planning Center doesn't place at a time might serve this one: then it's uncertain, not a fact.
      const maybe = time === null ? [] : unplaced.filter(p => !confirmed.includes(p));
      const uncertain = confirmed.length + maybe.length >= team.min_confirmed;
      const asked = people("U", true), not_sent = people("U", false).filter(p => !asked.includes(p));
      const interval = time === null ? null : times.get(time)!;
      findings.push({
        id: `kids:${team.team_id}:${time ?? "sunday"}`, key: JSON.stringify(["too-few-confirmed", team.team_id, interval?.starts_at ?? null]),
        kind: "too-few-confirmed", tone: uncertain ? "look" : "decision",
        position: { id: `kids:${team.team_id}`, team_id: team.team_id, name, interval },
        needed: team.min_confirmed, confirmed, asked, not_sent,
        why: [
          `Your Church rules ask for at least ${team.min_confirmed} confirmed people on this kids team at each service time.`,
          `Planning Center shows ${confirmed.length} confirmed for ${interval ? "this service time" : "this Sunday"}.`,
          ...(asked.length || not_sent.length ? [`Pending isn't counted as confirmed: ${[
            ...(asked.length ? [`${asked.length} asked with no answer yet`] : []), ...(not_sent.length ? [`${not_sent.length} not sent yet`] : [])].join(", ")}.`] : []),
          ...(uncertain ? [`Planning Center doesn't show which service time ${plural(maybe.length, "confirmed person", "confirmed people")} ${maybe.length === 1 ? "serves" : "serve"}, so Ozzie can't count them for this time.`] : []),
          "Ozzie counts confirmed people on the team; it doesn't check ages.",
        ],
      });
    }
  }

  // Rule 2: a current background check for everyone confirmed or pending on a kids team.
  if (!backgroundChecksOn(rules)) return { findings, not_checked };
  const kidsIds = new Set(teams.map(t => t.team_id));
  const scheduled = new Map<string, Row>();
  for (const m of members) {
    const person = relIds(m, "person")[0];
    if (person && kidsIds.has(teamOf(m) ?? "") && ["C", "U"].includes(statusOf(m.attributes?.status)) && !scheduled.has(person)) scheduled.set(person, m);
  }
  if (!scheduled.size) return { findings, not_checked };
  const reads = capture.reads.filter(r => r.collection === BACKGROUND_CHECKS);
  if (!reads.length) return { findings, not_checked: [...not_checked, "Background checks weren't part of this check. Check Planning Center again to include them."] };
  if (reads.every(r => r.outcome === "not-requested")) return { findings, not_checked: [...not_checked,
    "Background checks weren't checked: this Planning Center connection doesn't include People. Reconnect with Calendar, People and Groups in Settings to check them."] };

  type Outcome = { person: string; state: "on-file" | "none-current" | "expires-before-sunday" | "expires-on-sunday" | "no-date"; checked_at: string; rows: number };
  const gaps = new Map<string, Set<string>>();
  const gap = (text: string, person: string) => gaps.set(text, (gaps.get(text) ?? new Set()).add(person));
  const results: Outcome[] = [];
  for (const person of scheduled.keys()) {
    const own = reads.filter(r => r.people_person_id === person);
    if (!own.length) { gap("weren't part of this check", person); continue; }
    const failed = own.find(r => (r.outcome !== "ok" && r.outcome !== "truncated") || !r.body);
    if (failed) { gap(failed.outcome === "denied" ? "denied" : failed.outcome === "timeout" ? "took too long" : "couldn't be read", person); continue; }
    const checked_at = own.map(r => r.checked_at).sort()[0]!;
    const cleared = own.flatMap(r => rows(r.body!.data)).filter(c => c.type === "BackgroundCheck" && CLEARED.has(c.attributes?.status as string) &&
      relIds(c, "person")[0] === person);
    // A cleared check without its `current` or `expires_on` field can't be placed: never on file, never "no check".
    const unreadable = cleared.some(c => !Object.hasOwn(c.attributes ?? {}, "current") || !Object.hasOwn(c.attributes ?? {}, "expires_on"));
    const expiries = cleared.filter(c => c.attributes?.current === true && Object.hasOwn(c.attributes, "expires_on")).map(c => c.attributes!.expires_on);
    const partial = own.some(r => r.outcome === "truncated");
    let state: Outcome["state"];
    if (expiries.some(e => e === null)) state = "on-file";
    else {
      const latest = expiries.filter((e): e is string => typeof e === "string" && DATE.test(e)).sort().at(-1);
      const today = ctx.zone ? localDate(checked_at, ctx.zone) : checked_at.slice(0, 10);
      if (!latest || latest < today) state = "none-current";
      else if (!ctx.sundayDate) state = "no-date";
      else state = latest > ctx.sundayDate ? "on-file" : latest === ctx.sundayDate ? "expires-on-sunday" : "expires-before-sunday";
    }
    // A partly read list proves a current check it shows, never the lack of one.
    if (partial && state !== "on-file") { gap("only partly read", person); continue; }
    if (unreadable && state !== "on-file") { gap("couldn't be read", person); continue; }
    results.push({ person, state, checked_at, rows: own.reduce((n, r) => n + rows(r.body!.data).length, 0) });
  }
  // No cleared check visible in any read that answered can also mean this login can't see background checks,
  // whatever happened to the other reads (they are listed as not checked).
  const nothingVisible = results.length > 0 && results.every(r => r.rows === 0);
  for (const r of results) {
    if (r.state === "on-file") continue;
    if (r.state === "no-date") { gap("expiry couldn't be compared with Sunday's date", r.person); continue; }
    const m = scheduled.get(r.person)!;
    const team = teamOf(m)!;
    const time = relIds(m, "times").find(id => times.has(id));
    const look = r.state === "expires-on-sunday" || nothingVisible;
    findings.push({
      id: `background-check:${r.person}`, key: JSON.stringify(["background-check", r.person]), kind: "background-check", tone: look ? "look" : "decision",
      person_id: r.person, check: r.state, source: SOURCE, checked_at: r.checked_at,
      position: { id: `kids:${team}`, team_id: team, name: ctx.teamNames.get(team) ?? "A kids team", interval: time ? times.get(time)! : null },
      why: [
        "Your Church rules ask for a current background check before anyone serves on a kids team.",
        r.state === "none-current" ? "Planning Center People shows no current background check on file for this person."
          : r.state === "expires-before-sunday" ? "Planning Center People shows the background check on file expires before this Sunday."
            : "Planning Center People shows the background check on file expires on the day of this service, so it may not count that day.",
        ...(nothingVisible ? ["Planning Center People showed no current background checks for anyone on your kids teams. That can mean none are on file, or that your Planning Center login can't see them."] : []),
        "Ozzie never shows a background check's details, and it only sees checks your Planning Center login can see.",
      ],
    });
  }
  const GAP_TEXT: Record<string, (n: number) => string> = {
    "weren't part of this check": n => `Background checks for ${plural(n, "person", "people")} weren't part of this check.`,
    denied: n => `Background checks for ${plural(n, "person", "people")}: Planning Center didn't allow it. Your Planning Center login might not be able to see background checks.`,
    "expiry couldn't be compared with Sunday's date": n => `Background checks for ${plural(n, "person", "people")}: the expiry date couldn't be compared with Sunday's date.`,
  };
  for (const [text, people] of gaps) not_checked.push((GAP_TEXT[text] ?? (n => `Background checks for ${plural(n, "person", "people")}: ${text}.`))(people.size));
  return { findings, not_checked };
}
