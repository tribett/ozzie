// Every service Ozzie watches, as one check for what counts across them (owner decision 2026-11-19): the sidebar's
// number, Today's card, Thursday's brief, the spoken briefing, Ask and the copy Siri and other AI apps read all count
// the same items the Services page shows. The first service's brief is kept as it is (its findings, keys and decisions
// unchanged, so a church with one service sees exactly what it saw before); each other service's findings join it under
// keys of their own, so two services' findings and decisions never meet. Rooms, follow-ups and group meetings stay the
// first service's (App passes its operations only). Pure: no clock, no I/O; name-free like the briefs it joins.
import type { SundayBrief } from "../../../core/src/sunday-brief.js";
import type { SundayCapture } from "../../../core/src/sunday-capture.js";
import type { SundayDecision } from "../../../core/src/sunday-decisions.js";
import type { HarnessData } from "../../../core/src/harness/tools.js";
import { SERVICES_PAGE, SERVICES_QUESTION, type DayWords } from "../../../core/src/service-day.js";
import { nameable, serviceKey } from "../../../core/src/service-names.js";

/** One other service watched, as its own check read it, with the leader's own decisions for it. */
export interface OtherPart { plan_id: string; brief: SundayBrief; decisions: readonly SundayDecision[] }

/** The key one of the other services' findings (and its decisions) goes by across services. */
export const partKey = (planId: string, key: string): string => JSON.stringify(["service", planId, key]);
/** The service and the key within it of a key partKey made; null for the first service's own keys. */
export function fromPartKey(key: string): { plan_id: string; key: string } | null {
  if (!key.startsWith('["service",')) return null;
  try {
    const v = JSON.parse(key) as unknown;
    return Array.isArray(v) && v.length === 3 && v[0] === "service" && typeof v[1] === "string" && typeof v[2] === "string" ? { plan_id: v[1], key: v[2] } : null;
  } catch { return null; }
}

const unique = (lines: readonly string[]) => [...new Set(lines)];

/**
 * The words for every service at once, where several are watched and one sentence speaks of them all (Thursday's brief,
 * the spoken briefing, Today): never the first service's day for another service's item.
 */
export const MANY_SERVICES: DayWords = Object.freeze({
  kind: "spread", weekday: null, day: "your services", Day: "Your services", page: SERVICES_PAGE, question: SERVICES_QUESTION, date: null,
  thisOne: "your services",
});
/**
 * Whether day words are those for every service at once (MANY_SERVICES, or a copy of it): a spread with no date. One plan
 * whose times fall on several days always has its dates (core service-day.ts dayWords), so it never reads as several.
 */
export const watchesSeveral = (d: DayWords | null | undefined): boolean => d?.kind === "spread" && d.date === null;

/** The leader's decisions across services: the first service's as they are, each other's under its own keys. The same list with none. */
export function mergeDecisions(main: readonly SundayDecision[], others: readonly Pick<OtherPart, "plan_id" | "decisions">[]): readonly SundayDecision[] {
  return others.length ? [...main, ...others.flatMap(o => o.decisions.map(d => ({ ...d, key: partKey(o.plan_id, d.key) })))] : main;
}

/**
 * The first service's brief and decisions with each other service's joined in. With no other service, the very same
 * objects. Counts add up: sundayShownCount of the result is the first service's count plus each other's (they carry no
 * rooms, follow-ups or group meetings of their own).
 */
export function mergeParts(main: { brief: SundayBrief; decisions: readonly SundayDecision[] }, others: readonly OtherPart[]): { brief: SundayBrief; decisions: readonly SundayDecision[] } {
  if (!others.length) return main;
  const findings = [...main.brief.findings], hidden = [...(main.brief.hidden ?? [])], positions = [...main.brief.positions];
  const decisions = mergeDecisions(main.decisions, others);
  let reads = main.brief.sources.reads;
  const failed = [...main.brief.sources.failed];
  const notChecked = [...main.brief.not_checked];
  let stale = main.brief.stale, checked = main.brief.checked_at;
  let status = main.brief.status;
  for (const o of others) {
    const b = o.brief;
    findings.push(...b.findings.map(f => ({ ...f, id: `${o.plan_id}:${f.id}`, key: partKey(o.plan_id, f.key) })));
    hidden.push(...(b.hidden ?? []).map(h => ({ ...h, finding: { ...h.finding, id: `${o.plan_id}:${h.finding.id}`, key: partKey(o.plan_id, h.finding.key) } })));
    positions.push(...b.positions);
    reads += b.sources.reads;
    failed.push(...b.sources.failed);
    notChecked.push(...b.not_checked);
    stale ||= b.stale;
    if (b.checked_at && (!checked || b.checked_at < checked)) checked = b.checked_at;
    if (status === "checked-scope-clear" && b.status !== "checked-scope-clear") status = b.status;
  }
  return {
    // The words for every service at once: no one service's day is said for all of them.
    brief: { ...main.brief, findings, positions, ...(hidden.length ? { hidden } : {}), sources: { reads, failed }, not_checked: unique(notChecked), stale, checked_at: checked, status,
      day: MANY_SERVICES },
    decisions,
  };
}

/**
 * With more than one service, each team's service by its own Planning Center name (teams belong to one service type in
 * Planning Center), so an answer written on this Mac can say "Greeter (Youth Night)". Undefined with one service, or when
 * no service has a name. Local only: never part of anything sent.
 */
export function teamServices(main: { brief: SundayBrief; name: string | null }, others: readonly { brief: SundayBrief; name: string | null }[]): Record<string, string> | undefined {
  if (!others.length) return undefined;
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const part of [main, ...others]) if (part.name?.trim()) for (const p of part.brief.positions) out[p.team_id] ??= part.name.trim();
  return Object.keys(out).length ? out : undefined;
}

/**
 * The check Ask and the copies for Siri and other AI apps read with it: the first service's capture, with the names of
 * everyone the other services' checks named (on this Mac only, as every name is), so a name in a question about another
 * service is replaced before anything is sent, and its people are said by name here.
 */
export function mergedNames(main: SundayCapture, others: readonly SundayCapture[]): SundayCapture {
  if (!others.length) return main;
  const names: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const c of [...others, main]) for (const [id, name] of Object.entries(c.names)) names[id] = name;
  return { ...main, names };
}

/**
 * With more than one service watched (owner request 2026-11-21): what Ask needs so a question can name a service without
 * that name reaching a model (core ask.ts PrepareOptions `services`, harness tools.ts `scope`): every watched service by
 * its own Planning Center name and whether this check holds it (`unread`: the others watched, not read yet), the first
 * service first (its check holds the rooms, follow-ups and group meetings), each read one with its own reads, failed reads,
 * staleness and what it didn't check (review B, F3 and F7), and each finding's service by its id in the merged brief
 * (mergeParts: the first service's ids as they are, each other's as `<plan>:<id>`), set-aside findings included. Undefined
 * with one service watched, so that church reads exactly as before. Local only: never part of anything sent.
 */
export function askServices(main: { brief: SundayBrief; name: string | null }, others: readonly { plan_id: string; brief: SundayBrief; name: string | null }[],
  unread: readonly (string | null)[] = []): { services: NonNullable<HarnessData["services"]>[number][]; serviceOfFinding: Record<string, string> } | undefined {
  if (!others.length && !unread.length) return undefined;
  const sources = (b: SundayBrief) => ({ checked_at: b.checked_at, reads: b.sources.reads, failed: b.sources.failed.length, stale: !!b.stale, not_checked: [...b.not_checked] });
  const services = [
    ...[main, ...others].map((p, i) => ({ name: p.name?.trim() ?? "", read: true, ...(i === 0 ? { first: true } : {}), ...sources(p.brief) })),
    ...unread.map(n => ({ name: n?.trim() ?? "", read: false })),
  ].filter(s => s.name);
  if (services.length < 2) return undefined;
  const serviceOfFinding: Record<string, string> = Object.create(null) as Record<string, string>;
  const findings = (b: SundayBrief) => [...b.findings, ...(b.hidden ?? []).map(h => h.finding)];
  const own = main.name?.trim();
  if (own) for (const f of findings(main.brief)) serviceOfFinding[f.id] = own;
  for (const o of others) {
    const name = o.name?.trim();
    if (name) for (const f of findings(o.brief)) serviceOfFinding[`${o.plan_id}:${f.id}`] = name;
  }
  return { services, serviceOfFinding };
}

/** A weekday or month, whole or short, one or many; a clock time's "am"/"pm"; "service(s)". Not a name of its own. */
const DAY_OR_TIME = /^(?:(?:mon|tues?|wed(?:nes)?|thur?s?|fri|sat(?:ur)?|sun)(?:days?)?|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|am|pm|services?)$/u;
/**
 * With more than one service's check joined (mergeParts): each finding's service by its id in the merged brief, for the
 * lines that speak of every service at once about a part of the check with no role to say its service with (Thursday's
 * brief and the spoken briefing on Today: "At Youth Night, one role couldn't be checked, …"), as Ask says it. Only a name a
 * person would recognise as that one service, as Ask's suggested questions name one: it has a word and isn't a weekday or
 * month alone (core service-names.ts `nameable`), and no other watched service's name reads the same (`serviceKey`, the
 * ones not read yet included); otherwise none, and the line reads as before. Undefined with one service read, so that
 * church reads exactly as before. Local only: never part of anything sent.
 */
export function findingServices(main: { brief: SundayBrief; name: string | null }, others: readonly { plan_id: string; brief: SundayBrief; name: string | null }[],
  unread: readonly (string | null)[] = []): Record<string, string> | undefined {
  if (!others.length) return undefined;
  const asked = askServices(main, others, unread);
  if (!asked) return undefined;
  const keys = asked.services.map(s => serviceKey(s.name));
  // "At Wednesdays, …" and "At 9:00 AM, …" read wrongly, most of all about a role tied to no time (review of 0.5.11): a
  // name needs a word of its own besides days, months, clock times and "service"; one with a comma or an ending full
  // stop would break the sentence. Any of these: the line reads as before.
  const own = (name: string) => name.toLowerCase().split(/[^\p{L}]+/u).some(w => w.length > 1 && !DAY_OR_TIME.test(w));
  const recognised = (name: string) => nameable(name) && own(name) && !/,|[.!?]\s*$/u.test(name) && keys.filter(k => k === serviceKey(name)).length === 1;
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [id, name] of Object.entries(asked.serviceOfFinding)) if (recognised(name)) out[id] = name;
  return Object.keys(out).length ? out : undefined;
}
