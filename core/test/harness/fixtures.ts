// Harness test data: the fictional Nov 22 Sunday with its fictional rooms, follow-ups and group
// meeting, and the fictional email import. Every name and id is invented.
import { evaluateAttentionImport, type AttentionReport } from "../../src/attention-import/index.js";
import { harborAttentionImport } from "../../src/fictional-attention.js";
import { FICTIONAL_ROOM, withFictionalOperations, withFictionalOperationsOff } from "../../src/fictional-operations.js";
import { CHECKED, nov22Capture, PEOPLE, TEAMS, withFictionalBackgroundChecks } from "../../src/fictional-sunday.js";
import { sundayOperations } from "../../src/operations-capture.js";
import { buildSundayBrief } from "../../src/sunday-brief.js";
import type { SundayCapture, SundayRules } from "../../src/sunday-capture.js";
import { decide, type SundayDecision } from "../../src/sunday-decisions.js";
import { NATIVE_TOOL_ALLOWLIST, type ToolEnvelope } from "../../src/harness/contract.js";
import { HarnessSession, LABEL_PATTERN } from "../../src/harness/session.js";
import { HarnessTools, TOOL_SPECS, type HarnessData } from "../../src/harness/tools.js";

export const RULES: SundayRules = {
  sundayLeads: [], checkInAfterSundaysInARow: 3, rooms: [{ room_id: FICTIONAL_ROOM, exclusive: true, setup_minutes: 15 }],
};
/** Also asks for a scheduled Nursery lead, which the fictional Sunday doesn't have. */
export const LEAD_RULES: SundayRules = { ...RULES, sundayLeads: [{ team_id: TEAMS.nursery, lead_position: "Nursery Lead" }] };
/** Nursery (two confirmed at each time) and Lyrics (one) marked as kids teams, with the background-check rule on. */
export const KIDS_RULES: SundayRules = { ...RULES, kidsTeams: [{ team_id: TEAMS.nursery, min_confirmed: 2 }, { team_id: TEAMS.lyrics, min_confirmed: 1 }] };
export const ATTENTION = evaluateAttentionImport(harborAttentionImport()) as AttentionReport;
/** Five minutes after the fictional check: a live check that is still current. */
export const FRESH = "2026-11-20T15:05:00Z";

export interface DataOptions {
  mode?: HarnessData["mode"];
  rules?: SundayRules;
  granted?: HarnessData["granted"];
  /** Operations reads as a Services-only connection records them (every one not requested). */
  operationsOff?: boolean;
  decisions?: SundayDecision[];
  capture?: SundayCapture;
  connected?: boolean;
  refresh?: HarnessData["refresh"];
  now?: string;
  /** Reads of these collections (the fictional operations reads included) end with this outcome instead. */
  outcomes?: Readonly<Record<string, string>>;
}

export function harnessData(options: DataOptions = {}): HarnessData {
  const base = options.capture ?? nov22Capture();
  const mode = options.mode ?? "fictional";
  const added = options.operationsOff ? withFictionalOperationsOff(base) : withFictionalOperations(base);
  const outcomes = options.outcomes ?? {};
  const withOps = { ...added, reads: added.reads.map(r => outcomes[r.collection] ? { ...r, outcome: outcomes[r.collection]! } as typeof r : r) };
  const capture: SundayCapture = { ...withOps, kind: mode === "recording" ? "recording" : "live" };
  const rules = options.rules ?? RULES;
  const now = options.now ?? (mode === "fictional" ? capture.completed_at : FRESH);
  const brief = buildSundayBrief(capture, rules, now, mode === "fictional");
  const operations = sundayOperations(capture, rules, mode === "fictional" ? {} : { now });
  return {
    capture, brief, operations, decisions: options.decisions ?? [], rules, attention: ATTENTION,
    granted: options.granted ?? ["services", "operations"], mode, connected: options.connected ?? false,
    ...(options.refresh ? { refresh: options.refresh } : {}),
  };
}

/**
 * A big church's Sunday, too long for one overview (HARNESS_LIMITS.envelopeChars): the fictional live check with `looks`
 * more check-ins suggested, then `needs` more roles that still need people, `settled` of them decided by the leader, all
 * listed before the fictional Sunday's own findings. A cut from the end of the list would leave decisions out first.
 */
export function crowded(looks = 50, needs = 12, settled = 3): HarnessData {
  const data = harnessData({ mode: "live" });
  const brief = data.brief!;
  const need = brief.findings.find(f => f.kind === "needs-people")!, streak = brief.findings.find(f => f.kind === "streak")!;
  const more = [
    ...Array.from({ length: looks }, (_, i) => ({ ...streak, id: `crowded-streak-${i}`, key: `crowded-streak-${i}`, person_id: `9${String(i).padStart(4, "0")}` })),
    ...Array.from({ length: needs }, (_, i) => ({ ...need, id: `crowded-need-${i}`, key: `crowded-need-${i}`, position: { ...need.position!, name: `Usher ${i + 1}` } })),
  ];
  const decisions = more.filter(f => f.kind === "needs-people").slice(0, settled).map(f => decide(f, "covered-outside", "Covered by the youth group", CHECKED));
  return { ...data, brief: { ...brief, findings: [...more, ...brief.findings] }, decisions };
}

/**
 * People already scheduled with blockouts in Planning Center: the confirmed greeter away all day, the pending lyrics
 * volunteer away from 10:00, and the confirmed nursery volunteer with a weekly blockout Ozzie can't place on a date.
 */
export function withScheduledBlockouts(capture: SundayCapture): SundayCapture {
  const blockout = (person: string, attributes: Record<string, unknown>) => {
    capture.reads.find(r => r.collection === "person_blockouts" && r.person_id === person)!.body =
      { data: [{ type: "Blockout", id: `b${person}`, attributes }], meta: { count: 1, total_count: 1 } };
  };
  blockout(PEOPLE.greeterConfirmed, { starts_at: "2026-11-22T05:00:00Z", ends_at: "2026-11-23T04:59:59Z", repeat_frequency: "no_repeat" });
  blockout(PEOPLE.lyricsPending, { starts_at: "2026-11-22T15:00:00Z", ends_at: "2026-11-22T18:00:00Z", repeat_frequency: "no_repeat" });
  blockout(PEOPLE.nurseryConfirmed, { starts_at: "2026-10-04T13:00:00Z", ends_at: "2026-10-04T17:00:00Z", repeat_frequency: "every_1_week" });
  return capture;
}

/** The fictional Sunday with every name, position name, plan title and place name replaced by a canary. */
export function canaryCapture(): SundayCapture {
  let text = JSON.stringify(nov22Capture());
  const swaps: [string, string][] = [["Greeter", "Canarygreet Desk"], ["Nursery", "Canarynurse Room"], ["Lyrics", "Canarylyric Slides"], ["Ozzie Demo — Main Sunday (fictional)", "Canary Plan Title"]];
  for (const [from, to] of swaps) text = text.split(from).join(to);
  const capture = JSON.parse(text) as SundayCapture;
  capture.names = Object.fromEntries(Object.keys(capture.names).map((id, i) => [id, `Canaryfirst${String.fromCharCode(97 + i)} Canarylast${String.fromCharCode(97 + i)}`]));
  return capture;
}
/** Every kind of check the tools must describe: modes, grants, decisions, failed reads and canaries. */
export const FIXTURES: [string, () => HarnessData][] = [
  ["fictional", () => harnessData()],
  ["lead rule and a decision", () => {
    const need = harnessData({ rules: LEAD_RULES }).brief!.findings.find(f => f.kind === "needs-people")!;
    return harnessData({ rules: LEAD_RULES, decisions: [decide(need, "covered-outside", "Avery's sister said yes, call 555-201-3344", CHECKED)] });
  }],
  ["live and connected", () => harnessData({ mode: "live", connected: true, refresh: async () => harnessData({ mode: "live", connected: true }) })],
  ["live, out of date", () => harnessData({ mode: "live", now: "2026-11-20T17:00:00Z" })],
  ["saved recording", () => harnessData({ mode: "recording" })],
  ["Services only", () => harnessData({ granted: ["services"] })],
  ["operations turned off", () => harnessData({ operationsOff: true })],
  ["a read that didn't complete", () => {
    const capture = nov22Capture();
    capture.reads = capture.reads.map(r => r.collection === "person_blockouts" && r.person_id === PEOPLE.drew ? { ...r, outcome: "timeout" } : r);
    return harnessData({ mode: "live", capture });
  }],
  ["canary names and positions", () => {
    const data = harnessData({ capture: canaryCapture() });
    return { ...data, capture: { ...data.capture!, labels: { "room:887596": "Canary Sanctuary", "workflow:795989": "Canary Welcome Flow", "step:2211636": "Canary Call Step" } } };
  }],
  ["team reads denied and schedules truncated", () => harnessData({ mode: "live", outcomes: { team_leaders: "denied", team_position_assignments: "denied", person_schedules: "truncated" } })],
  ["room bookings timed out", () => harnessData({ mode: "live", outcomes: { calendar_resource_bookings: "timeout" } })],
  ["room list and workflows failed", () => harnessData({ mode: "live", outcomes: { calendar_rooms: "failed", people_workflows: "failed", people_workflow_steps: "failed" } })],
  ["group reads denied", () => harnessData({ mode: "live", outcomes: { groups_person_memberships: "denied", groups_group_events: "denied" } })],
  ["someone scheduled with a blockout", () => harnessData({ mode: "live", capture: withScheduledBlockouts(nov22Capture()) })],
  ["kids teams and background checks", () => harnessData({ mode: "live", rules: KIDS_RULES, capture: withFictionalBackgroundChecks(nov22Capture()) })],
  ["kids teams, People not granted", () => harnessData({ mode: "live", rules: KIDS_RULES, capture: withFictionalBackgroundChecks(nov22Capture()),
    outcomes: { people_background_checks: "not-requested" } })],
  ["two services watched", () => twoServices(harnessData({ mode: "live" }))],
];

/**
 * Two services watched (owner request 2026-11-21): the Lyrics team is a second service's, every other team the first's,
 * with canary service names, so the tools' reads for one service (HarnessTools.run `scope`) are read over a fixture too.
 */
export function twoServices(data: HarnessData): HarnessData {
  const first = "Canary Weekend Service", second = "Canary Youth Night";
  const serviceOfTeam = Object.fromEntries((data.brief?.positions ?? []).map(p => [p.team_id, p.team_id === TEAMS.lyrics ? second : first]));
  return { ...data, serviceOfTeam, services: [{ name: first, read: true, first: true }, { name: second, read: true }] };
}
/** The tools a service-scoped task reads for its services only (tools.ts `scope`). */
const SCOPED = ["sunday.overview", "sunday.open_needs", "sunday.pending_requests", "sunday.rule_checkins"] as const;

/** Every envelope every tool returns over one fixture, with every role and person label as arguments. */
export async function allEnvelopes(data: HarnessData): Promise<ToolEnvelope[]> {
  const tools = new HarnessTools(data, new HarnessSession(), { now: () => FRESH });
  const signal = new AbortController().signal;
  const out: ToolEnvelope[] = [];
  const attempt = async (name: string, args: Record<string, unknown> = {}) => { try { out.push(await tools.run(name, args, signal)); } catch { /* a refused read sends only {"error":code} */ } };
  for (const name of NATIVE_TOOL_ALLOWLIST) if (TOOL_SPECS[name].parameters.required.length === 0) await attempt(name);
  const labels = () => [...new Set(JSON.stringify(out).match(LABEL_PATTERN) ?? [])];
  for (const role of labels().filter(l => l.startsWith("[Role "))) {
    await attempt("sunday.who_could_help", { role });
    for (const person of labels().filter(l => l.startsWith("[Person "))) await attempt("drafts.prepare_note", { person, role });
  }
  // With more than one service watched, every scoped read for each one.
  for (const { name } of data.services ?? []) {
    const scoped = async (tool: string, args: Record<string, unknown> = {}) => { try { out.push(await tools.run(tool, args, signal, "", [name])); } catch { /* as above */ } };
    for (const tool of SCOPED) await scoped(tool);
    for (const role of labels().filter(l => l.startsWith("[Role "))) {
      await scoped("sunday.who_could_help", { role });
      for (const person of labels().filter(l => l.startsWith("[Person "))) await scoped("drafts.prepare_note", { person, role });
    }
  }
  return out;
}

/** Every source string that must never reach a model: names, position names, plan title, place names, typed reasons, imported text. */
export function sourceStrings(data: HarnessData): string[] {
  const out = new Set<string>();
  const capture = data.capture!;
  for (const name of Object.values(capture.names)) out.add(name);
  for (const s of data.services ?? []) out.add(s.name);
  for (const label of Object.values(capture.labels ?? {})) out.add(label);
  for (const label of Object.values(data.operations?.labels ?? {})) out.add(label);
  if (data.brief?.plan.title) out.add(data.brief.plan.title);
  for (const f of data.brief?.findings ?? []) {
    if (f.position?.name) out.add(f.position.name);
    for (const line of f.why) out.add(line);
  }
  for (const p of data.brief?.positions ?? []) out.add(p.name);
  for (const d of data.decisions) out.add(d.reason);
  for (const s of data.attention?.sources ?? []) {
    if ("body" in s) { out.add(s.body); out.add(s.subject); } else { out.add(s.title); out.add(s.location); }
  }
  for (const f of data.attention?.findings ?? []) for (const e of f.evidence) out.add(e.anchor.quote);
  return [...out].filter(s => s.trim().length >= 3);
}
