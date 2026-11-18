// Agent tools (build contract §4, harness plan H2): one typed, read-only implementation per name
// in NATIVE_TOOL_ALLOWLIST, over what the last Sunday check already read. Deterministic code
// chose every read; these tools only describe its results.
//
// Every payload is placeholder-only: people, positions, rooms, follow-up workflows and steps, and
// imported events are labels from the session ([Person 1], [Role 1], [Room 1] …); the rest is
// counts, ISO 8601 times in the church's own zone, and fixed words from fixed/vocabulary.json. Never a
// name, a position or room name, a plan title, a note or reason a person typed, an email, a phone
// number, or any other text from a source. A last check over the result fails closed as "unverified":
// every key and string must fit the vocabulary's closed grammar (fixed.ts envelopeProblems), every
// label must be one this session issued, and no contact detail may appear. Fixed words are never
// name-scanned, so a member named Church or Worth can't break Ozzie's own wording (review B-S3).
//
// Facts carry ids (structured answers, review 2026-11-14 section C): every payload states one fact at its top (the
// tool's own summary) under "fact", and every row of the lists in FACT_LISTS states one more, each "f<n>", numbered
// in order within one task; a prepared draft has "draft_id" "d<n>" instead. The model's final answer is only a choice
// of these ids (fixed.ts parseAnswer); Ozzie writes the sentences for them on this Mac (compose.ts).
//
// Nothing here writes anywhere. `planning_center.refresh` runs the injected native Sunday check
// (GET-only reads) when the last check is out of date or a recording; `drafts.prepare_note` returns
// a draft that a person reviews and sends, only to someone listed for a role that still needs people.
import { hasContactDetail } from "../ask.js";
import { ToolFailure } from "../broker.js";
import type { AttentionReport } from "../attention-import/index.js";
import { roomRules, type SundayOperations } from "../operations-capture.js";
import type { BriefPerson, Finding, SundayBrief } from "../sunday-brief.js";
import { LIVE_CHECK_VALID_MS, type SundayCapture, type SundayRules } from "../sunday-capture.js";
import { backgroundChecksOn, forModels } from "../kids-rules.js";
import { applyDecisions, type DecidedItem, type DecisionChoice, type SundayDecision } from "../sunday-decisions.js";
import { HARNESS_LIMITS, NATIVE_TOOL_ALLOWLIST, type Completeness, type ToolEnvelope, type ToolName, type ToolSpec } from "./contract.js";
import { envelopeProblems, isIsoTime, sentenceFits, TOOL_SPEC_LIST } from "./fixed.js";
import { HarnessSession, kindOf, YOUR_NAME, type LabelKind } from "./session.js";

/** What the tools read. Built by the app from its last check; names and place names stay on this Mac. */
export interface HarnessData {
  /** The last Sunday check. Only ids, counts and times are read from it; `names` and `labels` stay on this Mac. */
  capture: SundayCapture | null;
  /** buildSundayBrief(capture, rules, …) for the same check. */
  brief: SundayBrief | null;
  /** sundayOperations(capture, rules, …) for the same check; null when it had no Calendar, People or Groups reads. */
  operations: SundayOperations | null;
  /** The leader's Sunday decisions. Only the choice and whether a later check changed something are used, never the typed reason. */
  decisions: readonly SundayDecision[];
  rules: SundayRules;
  /** Today's fictional email and calendar import. Only used beside the fictional example. */
  attention: AttentionReport | null;
  /** What the Planning Center connection was granted. "operations" is Calendar, People and Groups. */
  granted: readonly ("services" | "operations")[];
  mode: "live" | "recording" | "fictional";
  /** A Planning Center connection is saved and usable, so a fresh check can run. */
  connected: boolean;
  /** The native Sunday check (read-only). Resolves to the data for the new check. */
  refresh?: (signal: AbortSignal) => Promise<HarnessData>;
}
export interface HarnessToolsOptions { now?: () => string }

// ---- Specs ---------------------------------------------------------------------------------------

/** What the model is offered: fixed/tool-specs.json, the one copy native also reads. No source text ever appears in it. */
export const TOOL_SPECS: Readonly<Record<ToolName, ToolSpec>> = Object.freeze(Object.fromEntries(TOOL_SPEC_LIST.map(s => [s.name, s])) as Record<ToolName, ToolSpec>);
const ALLOWED: ReadonlySet<string> = new Set(NATIVE_TOOL_ALLOWLIST);
export const isToolName = (name: string): name is ToolName => ALLOWED.has(name);
/** Tools that read Calendar, People and Groups: only when the connection was granted them. */
export const OPERATIONS_TOOLS: ReadonlySet<ToolName> = new Set(["rooms.conflicts", "followups.unowned", "groups.clashes"]);
/** Which label family each label parameter takes. */
const LABEL_PARAMS: Record<string, LabelKind> = { role: "role", person: "person" };
/** The lists whose rows each state one fact, by tool. The composer (compose.ts) has a sentence for every row of each. */
export const FACT_LISTS: Readonly<Partial<Record<ToolName, readonly string[]>>> = Object.freeze({
  "sunday.overview": ["findings"],
  "sunday.open_needs": ["needs"],
  "sunday.who_could_help": ["times", "people"],
  "sunday.pending_requests": ["pending", "leads_not_accepted"],
  "sunday.rule_checkins": ["check_ins"],
  "rooms.conflicts": ["rooms"],
  "followups.unowned": ["follow_ups"],
  "groups.clashes": ["clashes"],
  "today.attention": ["items"],
});
/** Fact and draft numbers handed out so far in one task. */
interface Numbering { fact: number; draft: number }
/** Tasks whose numbering is kept; the oldest is forgotten first. */
const KEEP_NUMBERING = 64;

/** Arguments exactly as the spec declares them, and every label one this session issued. Null when they don't fit. */
export function checkArguments(spec: ToolSpec, args: unknown, session: HarnessSession): Record<string, string | number | boolean> | null {
  if (typeof args !== "object" || args === null || Array.isArray(args) || ![Object.prototype, null].includes(Object.getPrototypeOf(args))) return null;
  const entries = Object.entries(args as Record<string, unknown>);
  const { properties, required } = spec.parameters;
  if (entries.some(([k]) => !Object.hasOwn(properties, k)) || required.some(k => !Object.hasOwn(args, k))) return null;
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of entries) {
    const p = properties[key]!;
    const ok = p.type === "integer" ? Number.isSafeInteger(value) : typeof value === p.type;
    if (!ok || (p.enum && !p.enum.includes(value as string))) return null;
    const family = LABEL_PARAMS[key];
    if (family && (typeof value !== "string" || kindOf(value) !== family || !session.has(value))) return null;
    out[key] = value as string | number | boolean;
  }
  return out;
}

// ---- Fixed words ------------------------------------------------------------------------------------

/** ISO 8601 to the minute in the church's own zone ("2026-11-22T09:30-05:00"); UTC when the zone is unknown. */
export function localIso(instant: string | null | undefined, zone: string | null | undefined): string | null {
  const date = instant ? new Date(instant) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  if (zone) {
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "longOffset",
      }).formatToParts(date);
      const part = (type: string) => parts.find(p => p.type === type)?.value ?? "";
      const offset = part("timeZoneName").replace(/^GMT/, "");
      return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}${!offset || offset === "+00:00" ? "Z" : offset}`;
    } catch { /* not a zone this runtime knows: UTC below */ }
  }
  return `${date.toISOString().slice(0, 16)}Z`;
}
const NOT_KNOWN = "not known";
const span = (interval: { starts_at: string; ends_at: string } | null | undefined, zone: string | null | undefined) =>
  interval ? { starts_at: localIso(interval.starts_at, zone) ?? NOT_KNOWN, ends_at: localIso(interval.ends_at, zone) ?? NOT_KNOWN } : NOT_KNOWN;
/** A check time exactly as an ISO 8601 instant (review N2): anything else is unverified, never passed along. */
const STRICT_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/u;
function checkTime(value: string | null | undefined): string {
  const ms = typeof value === "string" && STRICT_INSTANT.test(value) ? Date.parse(value) : NaN;
  if (Number.isNaN(ms)) throw new ToolFailure("unverified");
  return new Date(ms).toISOString().replace(/\.000Z$/u, "Z");
}

// Coverage reasons (core/src/coverage.ts) as fixed words, the same mapping as Ask's one-letter codes.
const REASONS: [RegExp, string][] = [
  [/^Recorded team membership/, "on the team with no overlap found"],
  [/^Possible conflict: source records an unanswered sent request\./, "an unanswered request elsewhere at this time"],
  [/^Possible conflict: unconfirmed scheduling record; invitation not sent\./, "penciled in elsewhere, request not sent"],
  [/^Possible conflict: unconfirmed scheduling record; sending couldn't be verified\./, "pending elsewhere at this time"],
  [/^Confirmed overlapping serving assignment\./, "confirmed elsewhere at this time"],
  [/^Recorded overlapping blockout\./, "a blockout covers this time"],
  [/^Blockout(?:s| times) couldn't be verified\./, "a blockout couldn't be checked"],
  [/^(?:Serving assignments|Duplicate serving assignment identities|Serving response or time semantics|Serving times) couldn't be verified\./, "other schedules couldn't be read"],
  [/ excludes this suggestion\.$/, "records say not on the team, not eligible or not available"],
  [/ couldn't be verified\.$/, "a detail couldn't be verified"],
];
const reasonWords = (reasons: readonly string[]) => [...new Set(reasons.map(r => REASONS.find(([re]) => re.test(r))?.[1] ?? "a reason Ozzie can't describe"))];
/** What the check found for a person on a role's team, least cautious first (review B-S2: merging keeps the most cautious). */
const STATUS = ["no overlap found", "availability needs confirmation", "possible conflict", "left out"] as const;
type Status = (typeof STATUS)[number];
const cautious = (a: Status, b: Status): Status => STATUS.indexOf(a) >= STATUS.indexOf(b) ? a : b;
/** Background checks never reach these tools (forModels, review M2/M3): there is no word for one here. */
const KIND: Record<Exclude<Finding["kind"], "background-check">, string> = {
  "needs-people": "needs people", "lead-missing": "no scheduled lead", "lead-unverified": "lead couldn't be confirmed",
  pending: "pending", streak: "check-in suggested", "worth-a-look": "part of the check couldn't be verified",
  "too-few-confirmed": "fewer confirmed than the church rules ask", blockout: "scheduled with a blockout at this time",
};
/** A finding's kind in fixed words. A background check never gets here (forModels); if one did, the tool fails closed. */
const kindWord = (kind: Finding["kind"]): string => {
  if (kind === "background-check") throw new ToolFailure("denied");
  return KIND[kind];
};
/** Said in the overview whenever the background-check rule is on, whatever it found: those findings stay on this Mac. */
const KEPT_ON_THIS_MAC = "some findings are shown only in Ozzie on this Mac";
const CHOICE: Record<DecisionChoice, string> = {
  "covered-outside": "covered outside Planning Center", "not-needed": "not needed this Sunday", "lead-expected": "no scheduled lead expected",
};
const UNDESCRIBED = "a part of the check Ozzie can't describe";
const AGES = "confirmed people counted; ages not checked";
const byLabel = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });
const byId = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });

// ---- Running ----------------------------------------------------------------------------------------

interface Result { completeness: Completeness; check_time: string; source: string; payload: Record<string, unknown>; list?: string }
interface Listed { id: string; person: string; status: Status; reasons?: string[] }
const SERVICES = "Planning Center Services";

export class HarnessTools {
  #data: HarnessData;
  readonly session: HarnessSession;
  readonly #now: () => string;
  readonly #numbering = new Map<string, Numbering>();
  constructor(data: HarnessData, session: HarnessSession = new HarnessSession(), options: HarnessToolsOptions = {}) {
    this.#data = data;
    this.session = session;
    this.#now = options.now ?? (() => new Date().toISOString());
  }
  get data(): HarnessData { return this.#data; }
  /** The app's newest check (after its own refresh, or a person opening another Sunday). */
  update(data: HarnessData): void { this.#data = data; }

  /**
   * Runs one tool for a task (`task`: its id, so fact ids are unique within it). Throws ToolFailure: "denied" for an
   * unknown tool or arguments that don't fit, "unverified" when there's nothing to read.
   */
  async run(name: string, args: Record<string, unknown>, signal: AbortSignal, task = ""): Promise<ToolEnvelope> {
    if (!isToolName(name)) throw new ToolFailure("denied");
    const checked = checkArguments(TOOL_SPECS[name], args, this.session);
    if (!checked) throw new ToolFailure("denied");
    if (signal.aborted) throw new ToolFailure("unverified");
    let result: Result;
    if (name === "planning_center.refresh") result = await this.#refresh(signal);
    else result = this.#read(name, checked);
    return this.#seal(name, fit(numbered(name, result, this.#numberingFor(task))));
  }
  #numberingFor(task: string): Numbering {
    let n = this.#numbering.get(task);
    if (!n) {
      n = { fact: 0, draft: 0 };
      this.#numbering.set(task, n);
      for (const old of this.#numbering.keys()) { if (this.#numbering.size <= KEEP_NUMBERING) break; this.#numbering.delete(old); }
    }
    return n;
  }

  #read(name: Exclude<ToolName, "planning_center.refresh">, args: Record<string, string | number | boolean>): Result {
    switch (name) {
      case "sunday.overview": return this.#overview();
      case "sunday.open_needs": return this.#openNeeds();
      case "sunday.who_could_help": return this.#whoCouldHelp(String(args["role"]));
      case "sunday.pending_requests": return this.#pending();
      case "sunday.rule_checkins": return this.#checkins();
      case "sunday.not_checked": return this.#notChecked();
      case "rooms.conflicts": return this.#rooms();
      case "followups.unowned": return this.#followUps();
      case "groups.clashes": return this.#groups();
      case "today.attention": return this.#attention();
      case "rules.current": return this.#rules();
      case "drafts.prepare_note": return this.#draft(String(args["person"]), String(args["role"]));
    }
  }

  /** The fail-closed last look at what leaves this function (header): the closed grammar, this session's labels, no contact detail. */
  #seal(tool: ToolName, r: Result): ToolEnvelope {
    const envelope: ToolEnvelope = { tool, source: r.source, check_time: r.check_time, completeness: r.completeness, payload: r.payload };
    if (envelopeProblems(envelope, label => this.session.has(label)).length) throw new ToolFailure("unverified");
    const text = stringsOf(envelope).join("\n");
    if (hasContactDetail(text) || hasContactDetail(text.normalize("NFKC"))) throw new ToolFailure("unverified");
    return envelope;
  }

  // -- shared views of the check --

  #services(): { brief: SundayBrief; capture: SundayCapture; org: string; zone: string | null } {
    const { brief, capture } = this.#data;
    if (!brief || !capture || !brief.checked_at) throw new ToolFailure("unverified");
    // Every tool reads the brief as models may see it: background checks stay on this Mac (review M2/M3).
    return { brief: forModels(brief), capture, org: capture.organization, zone: brief.time_zone };
  }
  #stale(checkedAt: string | null): boolean {
    const { mode, brief } = this.#data;
    if (mode === "recording") return true;
    if (mode !== "live") return false;
    return !!brief?.stale || (checkedAt !== null && Date.parse(this.#now()) > Date.parse(checkedAt) + LIVE_CHECK_VALID_MS);
  }
  #servicesResult(payload: Record<string, unknown>, list?: string): Result {
    const { brief } = this.#services();
    const completeness: Completeness = this.#stale(brief.checked_at) ? "stale" : brief.sources.failed.length ? "partial" : "complete";
    return { source: SERVICES, check_time: checkTime(brief.checked_at), completeness, payload, ...(list ? { list } : {}) };
  }
  #person(id: string | undefined): string { return id ? this.session.person(this.#services().org, id) : NOT_KNOWN; }
  /** A position's label: by name, or by (team, name) when another team of this plan has a position of the same name (B-S2). */
  #roleOf(name: string | undefined, team?: string): string {
    const n = name?.trim();
    if (!n) return NOT_KNOWN;
    if (team === undefined) return this.session.role(n);
    const teams = new Set((this.#data.brief?.positions ?? []).filter(p => p.name.trim() === n).map(p => p.team_id));
    return teams.size > 1 ? this.session.role(n, team) : this.session.role(n);
  }
  #role(f: Pick<Finding, "position">): string { return this.#roleOf(f.position?.name, f.position?.team_id); }
  /** The needs-people findings a role label stands for: its name, and its team when it has one. */
  #needsFor(role: string): Finding[] {
    const target = this.session.target(role);
    if (target?.kind !== "role") return [];
    return this.#services().brief.findings.filter(f => f.kind === "needs-people" && f.position?.name.trim() === target.name &&
      (target.team === undefined || f.position.team_id === target.team));
  }
  #decided(): Map<string, DecidedItem> {
    const { brief } = this.#services();
    return new Map(applyDecisions(brief, this.#data.decisions).items.map(i => [i.finding.id, i]));
  }
  #decision(item: DecidedItem | undefined): Record<string, unknown> {
    return item?.decision ? { decision: CHOICE[item.decision.choice], changed_since_decision: item.state === "reopened" } : {};
  }
  #leaders(f: Finding): string | string[] {
    if (!f.leaders) return "couldn't be read";
    if (!f.leaders.length) return "none listed";
    return [...new Set(f.leaders)].sort(byId).map(id => this.#person(id));
  }
  /** Everyone the check listed for one needs-people finding, in person-id order. */
  #listed(f: Finding): Listed[] {
    const p = f.people;
    if (!p) return [];
    const rows: Omit<Listed, "person">[] = [
      ...p.suggestions.map(x => ({ id: x.person_id, status: "no overlap found" as const })),
      ...p.unverified.map(x => ({ id: x.person_id, status: "availability needs confirmation" as const, reasons: reasonWords(x.reasons) })),
      ...p.conflicts.map(x => ({ id: x.person_id, status: "possible conflict" as const, reasons: reasonWords(x.reasons) })),
      ...p.left_out.map((x: BriefPerson) => ({ id: x.person_id, status: "left out" as const, reasons: reasonWords(x.reasons) })),
    ];
    return rows.sort((a, b) => byId(a.id, b.id)).map(r => ({ ...r, person: this.#person(r.id) }));
  }
  /**
   * People across the findings a role label stands for, one row each in person-id order, which says nothing
   * about anyone (review N4: label numbers follow the order Ask first met people, so they are not used).
   * A person listed for more than one time keeps the most cautious status and every reason (B-S2).
   */
  #people(findings: readonly Finding[]): Record<string, unknown>[] {
    const merged = new Map<string, { id: string; person: string; status: Status; reasons: Set<string>; statuses: Set<Status> }>();
    for (const row of findings.flatMap(f => this.#listed(f))) {
      const seen = merged.get(row.id);
      if (!seen) merged.set(row.id, { id: row.id, person: row.person, status: row.status, reasons: new Set(row.reasons ?? []), statuses: new Set([row.status]) });
      else { seen.status = cautious(seen.status, row.status); seen.statuses.add(row.status); for (const r of row.reasons ?? []) seen.reasons.add(r); }
    }
    return [...merged.values()].sort((a, b) => byId(a.id, b.id)).map(m => ({
      person: m.person, status: m.status, ...(m.reasons.size ? { reasons: [...m.reasons] } : {}), ...(m.statuses.size > 1 ? { status_differs_by_time: true } : {}),
    }));
  }

  // -- Services tools --

  #overview(): Result {
    const { brief, zone } = this.#services();
    const decided = this.#decided();
    const findings = brief.findings.map(f => {
      const base: Record<string, unknown> = { kind: kindWord(f.kind), tone: f.tone === "decision" ? "needs a decision" : "worth a look" };
      switch (f.kind) {
        case "needs-people": Object.assign(base, { role: this.#role(f), time: span(f.position?.interval, zone), remaining: f.remaining ?? NOT_KNOWN }); break;
        case "lead-missing": case "lead-unverified": Object.assign(base, { role: this.#role(f), time: span(f.position?.interval, zone) }); break;
        case "pending": Object.assign(base, { role: this.#role(f), time: span(f.position?.interval, zone), person: this.#person(f.person_id),
          request: f.notification === "sent" ? "request sent, no answer yet" : "request not sent yet" }); break;
        case "streak": Object.assign(base, { person: this.#person(f.person_id), sundays_in_a_row: f.sundays ?? NOT_KNOWN }); break;
        case "worth-a-look": Object.assign(base, { reads_not_completed: brief.sources.failed.length, too_old_to_treat_as_current: !!f.stale }); break;
        // Counts only: who is confirmed or pending stays on this Mac.
        case "too-few-confirmed": Object.assign(base, { role: this.#role(f), time: span(f.position?.interval, zone), confirmed: f.confirmed?.length ?? 0,
          needed: f.needed ?? NOT_KNOWN, asked_no_answer: f.asked?.length ?? 0, request_not_sent: f.not_sent?.length ?? 0, ages: AGES }); break;
        // Each role as Planning Center still counts the person on it (as groups.clashes): never an open role.
        case "blockout": Object.assign(base, { person: this.#person(f.person_id),
          serving: (f.serving ?? []).map(s => ({ role: this.#roleOf(s.name, s.team_id), status: s.status, time: span(s.interval, zone) })) }); break;
      }
      return { ...base, ...this.#decision(decided.get(f.id)) };
    });
    return this.#servicesResult({
      mode: this.#data.mode, sunday: brief.plan.date ?? NOT_KNOWN, reads: brief.sources.reads, reads_not_completed: brief.sources.failed.length,
      needs_a_decision: brief.findings.filter(f => f.tone === "decision").length, worth_a_look: brief.findings.filter(f => f.tone === "look").length,
      ...(backgroundChecksOn(this.#data.rules) ? { kept_on_this_mac: KEPT_ON_THIS_MAC } : {}),
      findings,
    }, "findings");
  }

  #openNeeds(): Result {
    const { brief, zone } = this.#services();
    const decided = this.#decided();
    const needs = brief.findings.flatMap((f): Record<string, unknown>[] => {
      if (f.kind === "needs-people") {
        const p = f.people;
        return [{
          kind: kindWord(f.kind), role: this.#role(f), time: span(f.position?.interval, zone), remaining: f.remaining ?? NOT_KNOWN,
          confirmed: [...new Set(f.confirmed ?? [])].sort(byId).map(id => this.#person(id)),
          people_listed: { no_overlap_found: p?.suggestions.length ?? 0, possible_conflict: p?.conflicts.length ?? 0,
            needs_confirmation: p?.unverified.length ?? 0, left_out: p?.left_out.length ?? 0 },
          team_leaders: this.#leaders(f), ...this.#decision(decided.get(f.id)),
        }];
      }
      if (f.kind === "lead-missing" || f.kind === "lead-unverified") {
        return [{
          kind: kindWord(f.kind), role: this.#role(f), time: span(f.position?.interval, zone),
          ...(f.kind === "lead-missing" ? { scheduled_to_lead_not_accepted: [...new Set(f.pending_leads ?? [])].sort(byId).map(id => this.#person(id)) } : {}),
          team_leaders: this.#leaders(f), ...this.#decision(decided.get(f.id)),
        }];
      }
      return [];
    });
    return this.#servicesResult({
      needs, remaining_means: "Planning Center's own count of open requests; people who accepted or are pending are already counted",
      team_leaders_means: "oversight of the team, not a Sunday assignment",
    }, "needs");
  }

  /** The asked-for role is echoed under `asked_for`, which never counts as evidence (verify.ts, review B-S1). */
  #whoCouldHelp(role: string): Result {
    const { zone } = this.#services();
    const findings = this.#needsFor(role);
    if (!findings.length) return this.#servicesResult({ asked_for: { role }, open_need: "none in the last check", people: [] });
    return this.#servicesResult({
      asked_for: { role }, times: findings.map(f => ({ role, time: span(f.position?.interval, zone), remaining: f.remaining ?? NOT_KNOWN })),
      people: this.#people(findings).map(p => ({ role, ...p })),
      order: "in no particular order, not ranked", willingness: "not recorded; no overlap found doesn't mean free or willing, only the person can say",
    }, "people");
  }

  #pending(): Result {
    const { brief, zone } = this.#services();
    const pending = brief.findings.filter(f => f.kind === "pending").map(f => ({
      role: this.#role(f), time: span(f.position?.interval, zone), person: this.#person(f.person_id),
      request: f.notification === "sent" ? "request sent, no answer yet" : "request not sent yet",
    }));
    const leads = brief.findings.filter(f => f.kind === "lead-missing").flatMap(f => [...new Set(f.pending_leads ?? [])].sort(byId)
      .map(id => ({ role: this.#role(f), person: this.#person(id), status: "scheduled to lead, hasn't accepted" })));
    return this.#servicesResult({ pending, leads_not_accepted: leads, pending_means: "not accepted yet; pending is not the same as asked" }, "pending");
  }

  #checkins(): Result {
    const { brief } = this.#services();
    const threshold = this.#data.rules.checkInAfterSundaysInARow;
    const check_ins = brief.findings.filter(f => f.kind === "streak").map(f => ({ person: this.#person(f.person_id), sundays_in_a_row: f.sundays ?? NOT_KNOWN }));
    return this.#servicesResult({
      check_in_after_sundays_in_a_row: threshold > 0 ? threshold : "off", check_ins,
      check_in_means: "a schedule fact for a person to look at; about care, not performance",
    }, "check_ins");
  }

  #notChecked(): Result {
    const { brief } = this.#services();
    const ops = this.#data.operations;
    // Ozzie's own sentences (fixed templates with counts); one that isn't made only of fixed words is never passed along.
    const fixed = (lines: readonly string[]) => [...new Set(lines.map(l => sentenceFits(l) ? l : UNDESCRIBED))];
    return this.#servicesResult({
      reads: brief.sources.reads, reads_not_completed: brief.sources.failed.length, too_old_to_treat_as_current: this.#stale(brief.checked_at),
      services: fixed(brief.not_checked),
      rooms_follow_ups_groups: !this.#data.granted.includes("operations") ? ["Rooms, follow-ups and group meetings are not part of this connection."]
        : ops ? fixed(ops.not_checked) : ["Rooms, follow-ups and group meetings weren't part of this check."],
    });
  }

  // -- Calendar, People and Groups --

  /** Not granted: "denied" and nothing else. Anything unread, uncertain or out of date is never "complete". */
  #operations(source: string): { ops: SundayOperations | null; completeness: Completeness; zone: string | null; result: (payload: Record<string, unknown>, list?: string) => Result } {
    const { brief } = this.#services();
    const ops = this.#data.operations;
    const zone = ops?.result?.churchTimeZone ?? brief.time_zone;
    const check_time = checkTime(ops?.checked_at ?? brief.checked_at);
    const granted = this.#data.granted.includes("operations");
    const completeness: Completeness = !granted ? "denied"
      : this.#stale(check_time) || ops?.stale ? "stale"
        : !ops || !ops.result || ops.not_checked.length || ops.result.unchecked_scope_ids.length || ops.result.uncertainties.length ? "partial" : "complete";
    return {
      ops: granted ? ops : null, completeness, zone,
      result: (payload, list) => ({ source, check_time, completeness, payload: granted ? payload : { status: "not granted" }, ...(list ? { list } : {}) }),
    };
  }

  #rooms(): Result {
    const { ops, zone, result } = this.#operations("Planning Center Calendar");
    const findings = ops?.result?.findings.flatMap(f => f.kind === "room-overlap" ? [f] : []) ?? [];
    const worth = ops?.result?.uncertainties.filter(u => /^room/.test(u.scope_id ?? "") || /^room/.test(u.subject_id ?? "")).length ?? 0;
    const rooms = findings.map(f => ({
      room: this.session.room(f.resource_id.replace(/^room/, "")), label: f.label, overlap: span(f.overlap, zone),
      bookings: f.bookings.map(b => ({ time: span(b.original, zone), approval: b.status })),
      setup_minutes: f.additional_setup_minutes, church_rule: f.rule?.exclusive ? "not shared" : "no rule set",
      worked_out_in_planning_center: f.resolution?.state === "unresolved" ? "not worked out" : "couldn't be read",
    }));
    const status = rooms.length ? "room use needs review" : ops?.clear.includes("rooms") ? "no overlap found" : "not fully checked";
    return result({ status, rooms, worth_a_look: worth }, "rooms");
  }

  #followUps(): Result {
    const { ops, zone, result } = this.#operations("Planning Center People");
    const findings = ops?.result?.findings.flatMap(f => f.kind === "unowned-overdue" ? [f] : []) ?? [];
    const worth = ops?.result?.uncertainties.filter(u => /^w\d/.test(u.scope_id ?? "")).length ?? 0;
    const follow_ups = findings.map(f => ({
      workflow: this.session.workflow(f.workflow_id.replace(/^workflow/, "")), step: this.session.step(f.step_id.replace(/^step/, "")),
      due: localIso(f.due_at, zone) ?? NOT_KNOWN, label: f.label,
    }));
    const status = follow_ups.length ? "needs an owner" : ops?.clear.includes("follow-ups") ? "no unowned overdue follow-ups found" : "not fully checked";
    return result({ status, follow_ups, worth_a_look: worth }, "follow_ups");
  }

  #groups(): Result {
    const { ops, completeness, zone, result } = this.#operations("Planning Center Groups");
    const meetings = [...(ops?.group_meetings ?? [])].sort((a, b) => byId(a.person_id, b.person_id));
    const clashes = meetings.map(m => ({
      person: this.#person(m.person_id),
      serving: m.serving.map(s => ({ role: this.#roleOf(s.position ?? undefined), status: s.status, time: span(s.interval, zone) })),
      group_meetings: m.meetings.map(i => ({ time: span(i, zone) })), label: "Worth a look",
    })).sort((a, b) => byLabel(a.person, b.person));
    const status = clashes.length ? "group meets while serving" : completeness === "complete" ? "no clash found" : "not fully checked";
    return result({ status, clashes }, "clashes");
  }

  // -- Today, rules, refresh, drafts --

  #attention(): Result {
    const report = this.#data.attention;
    // A fictional import never sits beside real church data (as Ask).
    if (this.#data.mode !== "fictional" || !report?.ok) throw new ToolFailure("unverified");
    const zone = "America/New_York";
    const items = report.findings.map(f => {
      const kinds = new Set(f.evidence.map(e => e.kind));
      const event = f.evidence.find(e => e.event_id)?.event_id;
      return {
        event: event ? this.session.event(event) : NOT_KNOWN,
        kind: kinds.size > 1 ? "messages disagree" : kinds.has("event-cancelled") ? "a message says it is cancelled while the calendar still shows it"
          : "a message says the room is unavailable while the calendar still lists it",
        starts_at: localIso(f.start_at, zone) ?? NOT_KNOWN,
        volunteers_contacted: f.evidence.some(e => e.not_contacted) ? "not contacted, according to the message" : NOT_KNOWN,
        label: f.uncertain ? "Worth a look" : "Needs a decision",
      };
    });
    const STATUS: Record<AttentionReport["status"], string> = { "needs-attention": "needs a decision", "worth-a-look": "worth a look", "checked-import-clear": "nothing found in the import" };
    return {
      source: "Fictional email and calendar import", check_time: checkTime(report.imported_at),
      completeness: report.stale ? "stale" : report.gaps.length ? "partial" : "complete",
      payload: { import: "invented example records", imported_at: localIso(report.imported_at, zone) ?? NOT_KNOWN, status: STATUS[report.status], items, gaps: report.gaps.length },
      list: "items",
    };
  }

  #rules(): Result {
    const { brief, capture } = this.#services();
    const rules = this.#data.rules;
    return {
      source: "Church rules on this Mac", check_time: checkTime(brief.checked_at ?? capture.completed_at), completeness: "complete",
      payload: {
        check_in_after_sundays_in_a_row: rules.checkInAfterSundaysInARow > 0 ? rules.checkInAfterSundaysInARow : "off",
        sunday_leads: rules.sundayLeads.flatMap(l => l.lead_position.trim() ? [{ lead_role: this.#roleOf(l.lead_position, l.team_id) }] : []),
        rooms: roomRules(rules).map(r => ({ room: this.session.room(r.room_id), rule: "not shared", setup_minutes: r.setup_minutes })),
      },
    };
  }

  /** Reads Planning Center again only when the last check is out of date or a recording (review B-S8); the host allows one per task. */
  async #refresh(signal: AbortSignal): Promise<Result> {
    const { refresh, connected, brief, capture } = this.#data;
    if (!refresh || !connected) throw new ToolFailure("denied");
    if (brief?.checked_at && capture && !this.#stale(brief.checked_at)) {
      return this.#servicesResult({ status: "not needed; the last check is current", mode: this.#data.mode, reads: brief.sources.reads, reads_not_completed: brief.sources.failed.length });
    }
    let next: HarnessData;
    try { next = await refresh(signal); } catch (e) { throw e instanceof ToolFailure ? e : new ToolFailure("provider-failure"); }
    if (signal.aborted) throw new ToolFailure("unverified");
    this.#data = next;
    const fresh = this.#services().brief;
    return this.#servicesResult({ status: "checked again", mode: next.mode, reads: fresh.sources.reads, reads_not_completed: fresh.sources.failed.length });
  }

  /**
   * A draft only to someone the check listed for a role that still needs people (reviews B-S1, N3): otherwise no
   * draft. The asked-for person and role are echoed under `asked_for`, and neither they nor the draft count as evidence.
   */
  #draft(person: string, role: string): Result {
    const { brief, zone } = this.#services();
    const asked_for = { person, role };
    const finding = this.#needsFor(role).find(f => this.#listed(f).some(p => p.person === person));
    if (!finding) return this.#servicesResult({ asked_for, status: "no draft prepared", reason: "not listed for an open need of this role" });
    const start = localIso(finding.position?.interval?.starts_at, zone);
    // When: the service time, else the plan's own church-local date, else nothing; never a fixed "this Sunday", since the
    // service may be on any day (onboarding spec §5, decision 18). The vocabulary has no words for "the next service".
    const date = brief.plan.date && isIsoTime(brief.plan.date) ? brief.plan.date : null;
    // Ozzie's own wording (as draft-request.ts), in labels and an ISO time; restored to the first name, the time in words and the sender on this Mac.
    const draft = [
      `Hi ${person},`,
      `We still need someone for ${role}${start ? ` at ${start}` : date ? ` on ${date}` : ""}. Would you be able to help?`,
      "It's completely fine to say no. Just let me know either way so we can plan.",
      `Thank you,\n${YOUR_NAME}`,
    ].join("\n\n");
    const listed = this.#people(this.#needsFor(role)).find(p => p["person"] === person)!["status"];
    return this.#servicesResult({ asked_for, draft, status: "draft only; nothing has been sent", listed_for_role: listed });
  }
}

/** The result with its fact ids (header): one for the payload, one per row of its FACT_LISTS, or a draft id for a draft. */
function numbered(tool: ToolName, r: Result, n: Numbering): Result {
  const payload: Record<string, unknown> = typeof r.payload["draft"] === "string" ? { draft_id: `d${++n.draft}`, ...r.payload } : { fact: `f${++n.fact}`, ...r.payload };
  for (const list of FACT_LISTS[tool] ?? []) {
    const rows = payload[list];
    if (Array.isArray(rows)) payload[list] = rows.map(row => row && typeof row === "object" && !Array.isArray(row) ? { fact: `f${++n.fact}`, ...row } : row);
  }
  return { ...r, payload };
}

/** Every key and string value, so a check never reads JSON escapes ("\n" glued to a word). */
function stringsOf(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringsOf(v, out);
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) { out.push(k); stringsOf(v, out); }
  return out;
}

/** Keeps a result within HARNESS_LIMITS.envelopeChars by leaving out entries at the end of its main list, and says how many. */
function fit(r: Result): Result {
  const size = (x: Result) => JSON.stringify({ tool: "x".repeat(24), source: x.source, check_time: x.check_time, completeness: x.completeness, payload: x.payload }).length;
  if (!r.list || size(r) <= HARNESS_LIMITS.envelopeChars) return r;
  const list = [...(r.payload[r.list] as unknown[])];
  let dropped = 0;
  let out: Result = r;
  while (list.length && size(out) > HARNESS_LIMITS.envelopeChars) {
    list.pop(); dropped++;
    out = { ...r, completeness: r.completeness === "complete" ? "partial" : r.completeness, payload: { ...r.payload, [r.list]: [...list], left_out_for_length: dropped } };
  }
  return out;
}
