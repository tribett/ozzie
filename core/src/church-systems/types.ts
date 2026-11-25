// What native code hands the page after reading another church system (B1 Church, Breeze or Genesis):
// one shape for all three, version 1. Pure: no I/O, no clock, no model.
// parseSystemCapture refuses the whole capture when anything in it falls outside this format (fail closed), with one
// closed reason word. Every person name is in `names` and every other free text in `labels`; nothing else is free
// text, and only placeholders.ts hands either of them out.
import { isTimeZone } from "../church-time.js";
import { isDateOnly, isJsonData } from "../read-result.js";

export const SYSTEM_IDS = ["b1", "breeze", "genesis"] as const;
export type SystemId = (typeof SYSTEM_IDS)[number];

/** What Ozzie gets from each system: what its documented API offers, less what Ozzie doesn't read yet. */
export interface SystemInfo {
  /** The name every fact and coverage scope carries as its source. */
  name: string;
  /** Open roles, who answered and who could help, for one dated service. */
  sundayCheck: boolean;
  blockouts: boolean;
  /** A team tied to each role, so its members may serve in it. Breeze has tags only; Genesis, groups only. */
  teamMembers: boolean;
  /** What else the people who could help are scheduled for around the service (`busy`). */
  busy: boolean;
  /**
   * Volunteers' answers in the system's own words, confirmed for every system (Breeze's codes by a live read: no
   * response, declined, accepted). Off, an answer other than "unknown" from that system refuses the capture.
   */
  answers: boolean;
  /** Whether each request was sent (`asked`). Breeze doesn't say, so its `asked` is always null. */
  asked: boolean;
  /** Attendance counts on events that Ozzie reads. Ozzie doesn't read B1 Church's or Breeze's yet. */
  attendance: boolean;
  /** The church's time zone may be one the system set by default rather than one the church chose. */
  zoneMayBeDefault: boolean;
  /**
   * When the system gives no zone this Mac knows (always for Genesis; for a B1 church that set none), the leader is
   * asked once which zone the church meets in.
   */
  zoneAsked: boolean;
  /** Native places the system's events in the zone the leader gave (Genesis gives local times only). */
  eventsNeedZone: boolean;
  /** None of the three exposes background checks. */
  backgroundChecks: false;
}
export const SYSTEMS: Readonly<Record<SystemId, Readonly<SystemInfo>>> = Object.freeze({
  b1: Object.freeze({ name: "B1 Church", sundayCheck: true, blockouts: true, teamMembers: true, busy: true, answers: true, asked: true, attendance: false,
    zoneMayBeDefault: true, zoneAsked: true, eventsNeedZone: false, backgroundChecks: false }),
  breeze: Object.freeze({ name: "Breeze", sundayCheck: true, blockouts: false, teamMembers: false, busy: false, answers: true, asked: false,
    // Ozzie reads the people checked in by name to the service, once it has ended, and the entries of 5 forms.
    attendance: true,
    zoneMayBeDefault: false, zoneAsked: false, eventsNeedZone: false, backgroundChecks: false }),
  genesis: Object.freeze({ name: "Genesis", sundayCheck: false, blockouts: false, teamMembers: false, busy: false, answers: true, asked: false, attendance: true,
    zoneMayBeDefault: false, zoneAsked: true, eventsNeedZone: true, backgroundChecks: false }),
});

/** The parts of a capture a read fills. */
export type CapturePart = "church" | "service" | "busy" | "positions" | "assignments" | "team_members" | "blockouts" | "groups" | "events" | "forms" | "people";
const table = (t: Record<string, readonly CapturePart[]>): Readonly<Record<string, readonly CapturePart[]>> =>
  Object.freeze(Object.fromEntries(Object.entries(t).map(([word, parts]) => [word, Object.freeze([...parts])])));
/**
 * Each system's closed list of read words and the parts of the capture each one fills. A word not listed for the
 * capture's system refuses the whole capture. Native code (core/church-systems) must use exactly these words.
 */
export const READS: Readonly<Record<SystemId, Readonly<Record<string, readonly CapturePart[]>>>> = Object.freeze({
  b1: table({
    "b1.church": ["church"], "b1.plans": ["service"], "b1.plans_day": ["busy"], "b1.times": ["service"], "b1.positions": ["positions"],
    "b1.assignments": ["assignments"], "b1.group_members": ["team_members"], "b1.blockouts": ["blockouts"],
    "b1.groups": ["groups"], "b1.events": ["events"], "b1.attendance": ["events"], "b1.forms": ["forms"],
    "b1.form_submissions": ["forms"], "b1.people": ["people"],
  }),
  breeze: table({
    "breeze.account": ["church"], "breeze.events": ["service", "events"], "breeze.roles": ["positions"],
    "breeze.volunteers": ["assignments"], "breeze.tags": ["groups"], "breeze.attendance": ["events"],
    "breeze.forms": ["forms"], "breeze.form_entries": ["forms"], "breeze.people": ["people"],
  }),
  genesis: table({
    "genesis.me": ["church"], "genesis.groups": ["groups"], "genesis.group_members": ["groups"], "genesis.events": ["events"],
    "genesis.forms": ["forms"], "genesis.form_submissions": ["forms"], "genesis.contacts": ["people"],
  }),
});
/** The read words that fill `part` for `system`, in the order listed. */
export const readsFor = (system: SystemId, part: CapturePart): string[] =>
  Object.entries(READS[system]).filter(([, parts]) => parts.includes(part)).map(([word]) => word);

export const READ_ERRORS = ["refused", "not-found", "rate-limited", "timeout", "unreachable", "too-large", "invalid-response", "key-refused"] as const;
export const READ_OUTCOMES = ["ok", "truncated", "not-requested", ...READ_ERRORS] as const;
export type ReadOutcome = (typeof READ_OUTCOMES)[number];
export const ASSIGNMENT_STATUSES = ["accepted", "unconfirmed", "declined", "unknown"] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];
/** How the person answered the other thing they're scheduled for: said yes, or hasn't answered yet. */
export const BUSY_ANSWERS = ["accepted", "unconfirmed"] as const;
export type BusyAnswer = (typeof BUSY_ANSWERS)[number];

export interface SystemRead { read: string; checked_at: string; outcome: ReadOutcome }
/**
 * `day`: the system's own calendar day for the service (YYYY-MM-DD), or null when it doesn't give one. `shared`: whether
 * the plan is shared with volunteers yet (B1 Church only; null when the system doesn't say or it couldn't be read).
 * `times`: how many separate start times the plan has in this service (B1 Church, whose plan's times are merged into
 * one span from the earliest start to the latest end). Absent when the system has one time a service (Breeze) and in a
 * check kept before this was recorded. More than one: no role's own time is known (`rolesShareOneTime`).
 */
export interface SystemService { id: string; day: string | null; starts_at: string; ends_at: string | null; shared: boolean | null; times?: number }
/**
 * Whether every role in this service serves at its one time, so a role can be said "at 9:00 AM". False when the plan
 * has several start times (B1 Church): the system doesn't say which of them a role serves, and Ozzie names the day.
 */
export const rolesShareOneTime = (service: SystemService): boolean => (service.times ?? 1) <= 1;
/** Something else a person is scheduled for around the service, such as another plan the same day, and their answer. */
export interface SystemBusy { person_id: string; starts_at: string; ends_at: string; answer: BusyAnswer }
export interface SystemPosition { id: string; team_id: string | null; needed: number | null }
/** `asked`: whether the person was sent the request; null when the system doesn't say. */
export interface SystemAssignment { id: string; position_id: string; person_id: string; status: AssignmentStatus; asked: boolean | null }
export interface SystemTeamMember { team_id: string; person_id: string }
export interface SystemBlockout { person_id: string; starts_at: string; ends_at: string }
export interface SystemGroup { id: string; members: number | null }
export interface SystemEvent { id: string; starts_at: string; ends_at: string | null; attendance: number | null }
export interface SystemForm { id: string; submissions: number | null }
export interface SystemCapture {
  version: 1;
  system: SystemId;
  /**
   * `time_zone`: an IANA zone name, or null when the system doesn't say. Ozzie never guesses one. Only its shape is
   * checked here: a name this Mac's time-zone data doesn't know is treated as no zone by the mapper, not refused.
   */
  church: { id: string; time_zone: string | null };
  started_at: string; completed_at: string;
  reads: SystemRead[];
  service: SystemService | null;
  /** null: not read (or the system has none). */
  busy: SystemBusy[] | null;
  /** Person ids scheduled for this service who hold no role (Breeze volunteers in no role). Each has a name entry. */
  on_service: string[];
  positions: SystemPosition[];
  assignments: SystemAssignment[];
  team_members: SystemTeamMember[];
  /** null: this system has none, or they weren't read. */
  blockouts: SystemBlockout[] | null;
  groups: SystemGroup[];
  events: SystemEvent[];
  forms: SystemForm[];
  /** Person id to name, on a null prototype. LOCAL ONLY: read through placeholders.ts `namesOf`. */
  names: Record<string, string>;
  /** "church", "service" or "<position|team|group|event|form>:<id>" to its display name, on a null prototype. LOCAL ONLY. */
  labels: Record<string, string>;
}

/** Why a capture was refused. Closed: never the source's own text. */
export const REFUSALS = [
  "not-json", "shape", "version", "system", "id", "time", "time-zone", "read", "outcome", "status", "count",
  "duplicate", "unknown-position", "label-key", "unknown-reference", "text", "too-many", "not-supplied", "invalid",
] as const;
export type CaptureRefusal = (typeof REFUSALS)[number];
export type ParsedCapture = { ok: true; capture: SystemCapture } | { ok: false; reason: CaptureRefusal };

/** Size caps: anything larger refuses the whole capture ("too-many"). */
export const MAX = Object.freeze({
  reads: 1000, on_service: 500, positions: 200, assignments: 500, team_members: 2000, blockouts: 2000, busy: 2000, groups: 200, events: 200, forms: 200,
  names: 3000, labels: 3000, text: 200, service_times: 100,
});

const ID = /^[A-Za-z0-9_-]{1,64}$/u;
const LABEL_KEY = /^(?:church|service|(?:position|team|group|event|form):[A-Za-z0-9_-]{1,64})$/u;
const canonical = new Map<string, boolean>();
/**
 * A zone name this Mac knows, in the exact spelling Intl gives back for it, so the page and native code mean the same
 * zone: Intl takes "Pacific/auckland" as Pacific/Auckland, but native code's zone data doesn't know that spelling and
 * places nothing in it. Intl also rewrites some aliases (US/Central to America/Chicago; with this ICU, Asia/Kolkata to
 * Asia/Calcutta and Europe/Kyiv to Europe/Kiev), and those don't count either: the page must store the name its own
 * zone picker (Intl) gives. "UTC" counts.
 */
export function isKnownZone(v: unknown): v is string {
  if (!isTimeZone(v)) return false;
  const known = canonical.get(v);
  if (known !== undefined) return known;
  let ok: boolean;
  try { ok = new Intl.DateTimeFormat("en-US", { timeZone: v }).resolvedOptions().timeZone === v; } catch { ok = false; }
  if (canonical.size < 512) canonical.set(v, ok);
  return ok;
}

/** The shape of an IANA zone name, as core/src/church-time.ts `isTimeZone` checks it before asking Intl. */
const ZONE = /^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+)$/u;
const TOP = ["version", "system", "church", "started_at", "completed_at", "reads", "service", "busy", "on_service", "positions", "assignments",
  "team_members", "blockouts", "groups", "events", "forms", "names", "labels"] as const;

// Explicit offsets only, the rule in core/src/coverage.ts `instant` (kept private there): Date.parse alone accepts
// local timestamps and normalizes invalid dates.
export function instant(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return NaN;
  const [, year, month, day, hour, minute, second, zone] = match;
  const days = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > days ||
      Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 ||
      (zone !== "Z" && (Number(zone!.slice(1, 3)) > 23 || Number(zone!.slice(4)) > 59))) return NaN;
  return Date.parse(value);
}

/**
 * A time a system wrote as its church's own midnight, with the church's offset: Breeze writes an event that has no time
 * of day that way (round 4, live: "Sunday, November 22 at 12:00 AM" for events with no time). Such a time names its day
 * only; it is never shown as a time. B1 Church's times are UTC (`Z`) and are never read this way.
 */
export const untimed = (value: string): boolean => /T00:00:00(?:\.0{1,3})?[+-]\d{2}:\d{2}$/u.test(value) && Number.isFinite(instant(value));

class Refused extends Error { constructor(readonly reason: CaptureRefusal) { super(reason); } }
const refuse = (reason: CaptureRefusal): never => { throw new Refused(reason); };

type Plain = Record<string, unknown>;
const plain = (v: unknown): v is Plain => typeof v === "object" && v !== null && !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
/** An object with exactly these keys, or the capture is refused. */
function object(v: unknown, keys: readonly string[]): Plain {
  if (!plain(v)) return refuse("shape");
  const own = Object.keys(v);
  return own.length === keys.length && keys.every(k => Object.hasOwn(v, k)) ? v : refuse("shape");
}
/** An array of at most `max` items, holes visited (Array.from), or the capture is refused. */
function list<T>(v: unknown, max: number, item: (x: unknown) => T): T[] {
  if (!Array.isArray(v)) return refuse("shape");
  if (v.length > max) return refuse("too-many");
  return Array.from(v as unknown[], item);
}
const id = (v: unknown): string => typeof v === "string" && ID.test(v) ? v : refuse("id");
const optionalId = (v: unknown): string | null => v === null ? null : id(v);
const time = (v: unknown): string => typeof v === "string" && Number.isFinite(instant(v)) ? v : refuse("time");
const utc = (v: unknown): string => time(v).endsWith("Z") ? v as string : refuse("time");
const count = (v: unknown): number | null => v === null || (Number.isSafeInteger(v) && (v as number) >= 0) ? v as number | null : refuse("count");
const text = (v: unknown): string => typeof v === "string" && v.length >= 1 && v.length <= MAX.text ? v : refuse("text");
const oneOf = <T extends string>(words: readonly T[], reason: CaptureRefusal) => (v: unknown): T =>
  typeof v === "string" && (words as readonly string[]).includes(v) ? v as T : refuse(reason);
function unique(ids: readonly string[]): void { if (new Set(ids).size !== ids.length) refuse("duplicate"); }
/** `ends_at` after `starts_at` (or, with `orEqual`, not before it). */
function ordered(starts_at: string, ends_at: string, orEqual = false): void {
  const a = instant(starts_at), b = instant(ends_at);
  if (orEqual ? b < a : b <= a) refuse("time");
}
/** A blockout: a person and a span that ends after it starts. */
function span(x: unknown): SystemBlockout {
  const b = object(x, ["person_id", "starts_at", "ends_at"]);
  const entry = { person_id: id(b["person_id"]), starts_at: time(b["starts_at"]), ends_at: time(b["ends_at"]) };
  ordered(entry.starts_at, entry.ends_at);
  return entry;
}
/** Something else a person is scheduled for: a span and their answer to it. */
function busyEntry(x: unknown): SystemBusy {
  const b = object(x, ["person_id", "starts_at", "ends_at", "answer"]);
  const entry = { person_id: id(b["person_id"]), starts_at: time(b["starts_at"]), ends_at: time(b["ends_at"]),
    answer: oneOf(BUSY_ANSWERS, "status")(b["answer"]) };
  ordered(entry.starts_at, entry.ends_at);
  return entry;
}
/** Free text by key, on a null prototype so an id such as "constructor" never finds anything inherited. */
function record(v: unknown, max: number, key: (k: string) => void): Record<string, string> {
  if (!plain(v)) return refuse("shape");
  const entries = Object.entries(v);
  if (entries.length > max) return refuse("too-many");
  const out = Object.create(null) as Record<string, string>;
  // A null prototype has no __proto__ setter, so even that key is stored as data.
  for (const [k, value] of entries) { key(k); out[k] = text(value); }
  return out;
}

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === "object") { Object.values(v).forEach(deepFreeze); Object.freeze(v); }
  return v;
}

function parse(value: unknown): SystemCapture {
  if (!isJsonData(value)) return refuse("not-json");
  const v = object(value, TOP);
  if (v["version"] !== 1) return refuse("version");
  const system = oneOf(SYSTEM_IDS, "system")(v["system"]);
  const info = SYSTEMS[system];
  const c = object(v["church"], ["id", "time_zone"]);
  const zone = c["time_zone"];
  if (zone !== null && (typeof zone !== "string" || zone.length > 64 || !ZONE.test(zone))) return refuse("time-zone");
  const church = { id: id(c["id"]), time_zone: zone as string | null };
  const started_at = utc(v["started_at"]), completed_at = utc(v["completed_at"]);
  ordered(started_at, completed_at, true);

  const words = READS[system];
  const reads = list(v["reads"], MAX.reads, x => {
    const r = object(x, ["read", "checked_at", "outcome"]);
    if (typeof r["read"] !== "string" || !Object.hasOwn(words, r["read"])) return refuse("read");
    const read = { read: r["read"], checked_at: time(r["checked_at"]), outcome: oneOf(READ_OUTCOMES, "outcome")(r["outcome"]) };
    // A read is checked during the capture, never before it started or after it finished.
    if (instant(read.checked_at) < instant(started_at) || instant(read.checked_at) > instant(completed_at)) return refuse("time");
    return read;
  });

  let service: SystemService | null = null;
  if (v["service"] !== null) {
    // `times` is left out where the system has none to count, and in a check kept before it was recorded.
    const counted = plain(v["service"]) && Object.hasOwn(v["service"], "times");
    const s = object(v["service"], ["id", "day", "starts_at", "ends_at", "shared", ...(counted ? ["times"] : [])]);
    const shared = s["shared"] === null || typeof s["shared"] === "boolean" ? s["shared"] : refuse("status");
    const day = s["day"] === null ? null : isDateOnly(s["day"]) ? s["day"] : refuse("time");
    const times = counted ? (Number.isSafeInteger(s["times"]) && (s["times"] as number) >= 1 && (s["times"] as number) <= MAX.service_times ? s["times"] as number : refuse("count")) : null;
    service = { id: id(s["id"]), day, starts_at: time(s["starts_at"]), ends_at: s["ends_at"] === null ? null : time(s["ends_at"]), shared, ...(times === null ? {} : { times }) };
    if (service.ends_at !== null) ordered(service.starts_at, service.ends_at);
  }
  const busy = v["busy"] === null ? null : list(v["busy"], MAX.busy, busyEntry);
  const on_service = list(v["on_service"], MAX.on_service, id);
  unique(on_service);
  const positions = list(v["positions"], MAX.positions, x => {
    const p = object(x, ["id", "team_id", "needed"]);
    return { id: id(p["id"]), team_id: optionalId(p["team_id"]), needed: count(p["needed"]) };
  });
  unique(positions.map(p => p.id));
  const positionIds = new Set(positions.map(p => p.id));
  const assignments = list(v["assignments"], MAX.assignments, x => {
    const a = object(x, ["id", "position_id", "person_id", "status", "asked"]);
    const asked = a["asked"] === null || typeof a["asked"] === "boolean" ? a["asked"] : refuse("status");
    const assignment = { id: id(a["id"]), position_id: id(a["position_id"]), person_id: id(a["person_id"]),
      status: oneOf(ASSIGNMENT_STATUSES, "status")(a["status"]), asked };
    return positionIds.has(assignment.position_id) ? assignment : refuse("unknown-position");
  });
  unique(assignments.map(a => a.id));
  const team_members = list(v["team_members"], MAX.team_members, x => {
    const m = object(x, ["team_id", "person_id"]);
    return { team_id: id(m["team_id"]), person_id: id(m["person_id"]) };
  });
  unique(team_members.map(m => `${m.team_id} ${m.person_id}`));
  const blockouts = v["blockouts"] === null ? null : list(v["blockouts"], MAX.blockouts, span);
  const groups = list(v["groups"], MAX.groups, x => {
    const g = object(x, ["id", "members"]);
    return { id: id(g["id"]), members: count(g["members"]) };
  });
  unique(groups.map(g => g.id));
  const events = list(v["events"], MAX.events, x => {
    const e = object(x, ["id", "starts_at", "ends_at", "attendance"]);
    const event = { id: id(e["id"]), starts_at: time(e["starts_at"]), ends_at: e["ends_at"] === null ? null : time(e["ends_at"]),
      attendance: count(e["attendance"]) };
    if (event.ends_at !== null) ordered(event.starts_at, event.ends_at, true);
    return event;
  });
  unique(events.map(e => e.id));
  const forms = list(v["forms"], MAX.forms, x => {
    const f = object(x, ["id", "submissions"]);
    return { id: id(f["id"]), submissions: count(f["submissions"]) };
  });
  unique(forms.map(f => f.id));
  const names = record(v["names"], MAX.names, k => { id(k); });
  const labels = record(v["labels"], MAX.labels, k => { if (!LABEL_KEY.test(k)) refuse("label-key"); });

  // A system can't hand over what Ozzie doesn't get from it (SYSTEMS). Breeze sends no busy times today, but a list
  // from it isn't refused: the mapper reads busy times only through a read word that fills them.
  if (!info.sundayCheck && (service !== null || busy !== null || on_service.length || positions.length || assignments.length)) return refuse("not-supplied");
  if (!info.blockouts && blockouts !== null) return refuse("not-supplied");
  if (!info.teamMembers && team_members.length) return refuse("not-supplied");
  if (!info.answers && assignments.some(a => a.status !== "unknown")) return refuse("not-supplied");
  if (!info.asked && assignments.some(a => a.asked !== null)) return refuse("not-supplied");
  if (!info.attendance && events.some(e => e.attendance !== null)) return refuse("not-supplied");

  // Every name is someone in the capture, and every label is for something in it.
  const people = new Set([...[...assignments, ...team_members, ...(blockouts ?? []), ...(busy ?? [])].map(x => x.person_id), ...on_service]);
  // The page can name everyone on the service with no role: each has a name entry.
  if (on_service.some(person => !Object.hasOwn(names, person))) return refuse("unknown-reference");
  // Nobody is both in a role and on the service with no role.
  const inRole = new Set(assignments.map(a => a.person_id));
  if (on_service.some(person => inRole.has(person))) return refuse("duplicate");
  // Only B1 Church says whether a plan is shared with volunteers yet.
  if (system !== "b1" && service !== null && service.shared !== null) return refuse("not-supplied");
  if (Object.keys(names).some(person => !people.has(person))) return refuse("unknown-reference");
  const things = new Set<string>(["church", ...(service ? ["service"] : []), ...positions.map(p => `position:${p.id}`),
    ...[...positions.flatMap(p => p.team_id ?? []), ...team_members.map(m => m.team_id)].map(t => `team:${t}`),
    ...groups.map(g => `group:${g.id}`), ...events.map(e => `event:${e.id}`), ...forms.map(f => `form:${f.id}`)]);
  if (Object.keys(labels).some(key => !things.has(key))) return refuse("unknown-reference");

  return { version: 1, system, church, started_at, completed_at, reads, service, busy, on_service, positions, assignments, team_members,
    blockouts, groups, events, forms, names, labels };
}

/**
 * The capture from its text, as native code writes it. Text that isn't JSON is "not-json", and nothing from the text
 * is kept or quoted (a JSON error message would quote the text around the fault). Never throws.
 */
export function parseSystemCaptureText(text: unknown): ParsedCapture {
  if (typeof text !== "string") return { ok: false, reason: "not-json" };
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { ok: false, reason: "not-json" }; }
  return parseSystemCapture(value);
}

/** The capture native code sent, deeply frozen, or the one closed reason it was refused. Never throws. */
export function parseSystemCapture(value: unknown): ParsedCapture {
  try {
    return { ok: true, capture: deepFreeze(parse(value)) };
  } catch (error) {
    return { ok: false, reason: error instanceof Refused ? error.reason : "invalid" };
  }
}
