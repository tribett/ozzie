// The last check, shared with other AI apps on this Mac (harness plan H5). The desktop app builds it from the same
// read-only agent tools Ask Ozzie uses (core/src/harness/tools.ts), so its every string is a placeholder label, a
// count, an ISO time or a fixed word; the native `share_last_check` command checks each tool result again against
// every name the app has shown and the closed grammar, adds the task ledger's name-free rows, and writes the file.
// The server in this folder only reads that file. It never sees a name, never reads Planning Center and never writes.
//
// File: `shared-check.json` in Ozzie's app data folder (0600), one JSON object:
//   { "format": "ozzie-shared-check-2",
//     "copy_id": <random id for the set of labels this copy uses (COPY_ID), never derived from the data>,
//     "checked_at": <ISO instant: the earliest check_time among the envelopes, when the facts were read>,
//     "shared_at": <ISO instant: when this copy was saved, which can be long after the check>,
//     "envelopes": [<ToolEnvelope from one of SHARED_TOOLS, each tool at most once, at least one>],
//     "tasks": [{ kind, skill_id, state, created_at, updated_at, failure, events: [{ type, detail, at }] }] }
// A church on B1 Church or Breeze (0.10.0) is shared the same way, from the same tools over that system's own check,
// with two more keys straight after "format": "system" (SHARED_SYSTEMS: "b1" or "breeze") and "role_numbers"
// (ROLE_NUMBERS: whether that system gave the number of people needed for every role on the service, some or none).
// Every result of such a copy names that system or the Church rules on this Mac as its source, and at least one names
// the system; a copy without them names no other church system (shared_check.rs `sources_fit`); and its role numbers
// fit the roles it counts as needing people (`numbersFit`). A Planning Center copy
// has neither key and is byte for byte as before; a reader older than 0.10.0 checks the keys exactly, so it refuses a
// system's copy whole and says nothing is shared.
// parseSharedCheck refuses the whole file when anything in it falls outside that shape (fail closed).
import { hasContactDetail } from "../src/ask.js";
import { ToolFailure } from "../src/broker.js";
import { backgroundInToolResult } from "../src/harness/background-wording.js";
import type { TaskEvent, ToolEnvelope } from "../src/harness/contract.js";
import { envelopeProblems, isoMillis } from "../src/harness/fixed.js";
import { FAILURE_CODES, ledgerDetailOk } from "../src/harness/ledger-events.js";
import type { HarnessTools } from "../src/harness/tools.js";

export const SHARED_FORMAT = "ozzie-shared-check-2";
export const SHARED_FILE = "shared-check.json";
/** Present beside the copy while the leader has sharing on; holds nothing. The copy is read only while it is a regular file (shared_check.rs ON_FILE). */
export const ON_FILE = ".shared-check.on";
/** Largest file read; the native writer keeps it far smaller (9 envelopes of at most 6,000 characters, 20 tasks). */
export const MAX_SHARED_BYTES = 256 * 1024;
/** Most recent tasks kept for "what happened". */
export const MAX_SHARED_TASKS = 20;
/**
 * A church on B1 Church or Breeze: the id its copy carries, and the source every result of its check names
 * (fixed/vocabulary.json sources). Genesis shares no volunteer schedules, so it has no copy. Mirrored natively
 * (shared_check.rs SystemId).
 */
export const SHARED_SYSTEMS = Object.freeze({ b1: "B1 Church", breeze: "Breeze" } as const);
export type SharedSystemId = keyof typeof SHARED_SYSTEMS;
/**
 * Whether that system gave the number of people needed for every role on the service, for some of them, or for none
 * (Breeze's older volunteers page gives none): where it didn't, nothing that reads the copy may call a role full or the
 * service covered. Mirrored natively (shared_check.rs RoleNumbers).
 */
export const ROLE_NUMBERS = Object.freeze(["all", "some", "none"] as const);
export type RoleNumbers = (typeof ROLE_NUMBERS)[number];
/**
 * Whether `numbers` fits the rows (shared_check.rs `numbers_fit`): a role the overview or the open roles count as
 * needing people carries the system's number, or "not known" where there is none; a counted number means not "none",
 * and "not known" means not "all". Roles with no number that need nobody aren't rows, so the rest is the app's.
 */
export function numbersFit(envelopes: readonly Pick<ToolEnvelope, "tool" | "payload">[], numbers: RoleNumbers): boolean {
  const list = (e: Pick<ToolEnvelope, "tool" | "payload">) => {
    const key = e.tool === "sunday.overview" ? "findings" : e.tool === "sunday.open_needs" ? "needs" : null;
    const rows = key && plain(e.payload) ? e.payload[key] : null;
    return Array.isArray(rows) ? rows.filter(plain) : [];
  };
  const numbered = envelopes.flatMap(list).filter(r => r["kind"] === "needs people").map(r => typeof r["remaining"] === "number");
  return numbers === "all" ? numbered.every(Boolean) : numbers === "none" ? !numbered.some(Boolean) : true;
}
/**
 * Whether a system gave the number of people needed for every role on the service, some or none, from the roles its
 * check read. "none" only where there are roles and none has a number: a service with no roles (or whose roles couldn't be
 * read, which the check says itself) claims nothing about numbers, so it is "all", never "none" (privacy review L2: B1
 * Church shares numbers, and Siri said otherwise for a B1 service whose roles weren't read).
 */
export function roleNumbersOf(positions: readonly { needed: number | null }[]): RoleNumbers {
  const without = positions.filter(p => p.needed === null).length;
  return without === 0 ? "all" : without < positions.length ? "some" : "none";
}
/** A church on another system, as the desktop app hands it to native with the results. */
export interface SharedSystem { id: SharedSystemId; role_numbers: RoleNumbers }
/** Every other church system a result can name: never in a copy with no system (shared_check.rs OTHER_SOURCES). */
const OTHER_SOURCES: ReadonlySet<string> = new Set(["B1 Church", "Breeze", "Genesis"]);
/** The Church rules' own source (tools.ts `#rules`): in every church's copy. */
const RULES_SOURCE = "Church rules on this Mac";
const isSystem = (v: unknown): v is SharedSystemId => typeof v === "string" && Object.hasOwn(SHARED_SYSTEMS, v);
const isRoleNumbers = (v: unknown): v is RoleNumbers => typeof v === "string" && (ROLE_NUMBERS as readonly string[]).includes(v);
/** The system a copy's results are shared as, from the copy (absent: Planning Center). */
export const systemOf = (check: Pick<SharedCheck, "system" | "role_numbers">): SharedSystem | null =>
  check.system && check.role_numbers ? { id: check.system, role_numbers: check.role_numbers } : null;
/**
 * Whether results fit the church system they are shared as: with `system`, every one names it or the Church rules on
 * this Mac, and at least one names it; with none (Planning Center), none names another church system.
 */
export function sourcesFit(envelopes: readonly Pick<ToolEnvelope, "source">[], system: SharedSystemId | null): boolean {
  if (system === null) return !envelopes.some(e => OTHER_SOURCES.has(e.source));
  const own = SHARED_SYSTEMS[system];
  return envelopes.every(e => e.source === own || e.source === RULES_SOURCE) && envelopes.some(e => e.source === own);
}

/**
 * The tools whose results are shared, in the order they are read. Left out on purpose: who could help (a list of
 * named-role candidates is more than another app needs), drafts, checking Planning Center again, and the fictional
 * email import. Mirrored natively (shared_check.rs SHARED_TOOLS).
 */
export const SHARED_TOOLS = Object.freeze([
  "sunday.overview", "sunday.open_needs", "sunday.pending_requests", "sunday.rule_checkins", "sunday.not_checked",
  "rooms.conflicts", "followups.unowned", "groups.clashes", "rules.current",
] as const);
export type SharedTool = (typeof SHARED_TOOLS)[number];
const SHARED: ReadonlySet<string> = new Set(SHARED_TOOLS);

export interface SharedTaskEvent { type: TaskEvent["type"]; detail: string; at: string }
export interface SharedTask {
  kind: "ask" | "skill" | "check";
  skill_id: string;
  state: "proposed" | "admitted" | "running" | "verified" | "failed" | "cancelled";
  created_at: string;
  updated_at: string;
  failure: string | null;
  events: SharedTaskEvent[];
}
export interface SharedCheck {
  format: typeof SHARED_FORMAT;
  /** A church on B1 Church or Breeze: its system, and whether that system numbered every role. Both absent for Planning Center. */
  system?: SharedSystemId;
  role_numbers?: RoleNumbers;
  /** Labels such as [Person 1] mean one thing only within the copy with this id. */
  copy_id: string;
  /** When the facts were read: the earliest check time among the results. */
  checked_at: string;
  /** When the copy was saved. */
  shared_at: string;
  envelopes: ToolEnvelope[];
  tasks: SharedTask[];
}

/**
 * A copy id: six consonant-digit pairs, e.g. "B4K7Q2X9M3T8". Random (the desktop app draws one for each set of labels),
 * and shaped so it can't spell a word or a name, or hold a run of digits that reads as a phone number. Mirrored natively.
 */
export const COPY_ID = /^(?:[BCDFGHJKLMNPQRSTVWXZ][2-9]){6}$/u;

/**
 * The shared tool results for the app's current check: each of SHARED_TOOLS run once under one task id, so fact ids
 * are unique across them. A tool with nothing to read (no check yet) is left out; empty when there's no check at all.
 * A church on B1 Church or Breeze (HarnessData `source`) gets what Ask is offered there (host.ts): no check-ins, since
 * Ozzie doesn't count weeks in a row there (its rooms, follow-ups and group meetings refuse by themselves).
 */
export async function sharedEnvelopes(tools: HarnessTools): Promise<ToolEnvelope[]> {
  const out: ToolEnvelope[] = [];
  const signal = new AbortController().signal;
  for (const name of SHARED_TOOLS) {
    if (name === "sunday.rule_checkins" && tools.data.source !== undefined) continue;
    try { out.push(await tools.run(name, {}, signal, "shared-check")); }
    catch (error) { if (!(error instanceof ToolFailure)) throw error; }
  }
  return out;
}

/** When the facts in these results were read: the earliest check time among them (ISO, milliseconds), or null when none. */
export function checkedAtOf(envelopes: readonly ToolEnvelope[]): string | null {
  const times = envelopes.map(e => isoMillis(e.check_time));
  return times.length && times.every(t => t !== null) ? new Date(Math.min(...times as number[])).toISOString() : null;
}

/**
 * The file's text exactly as the native writer lays it out (for tests and for hosts without the desktop app); `system`
 * for a church on B1 Church or Breeze, right after the format as native writes it.
 */
export const sharedCheckText = (envelopes: readonly ToolEnvelope[], tasks: readonly SharedTask[], sharedAt: string, copyId: string,
  system: SharedSystem | null = null): string =>
  JSON.stringify({ format: SHARED_FORMAT, ...(system ? { system: system.id, role_numbers: system.role_numbers } : {}), copy_id: copyId,
    checked_at: checkedAtOf(envelopes), shared_at: sharedAt, envelopes, tasks });

const INSTANT =/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/u;
const instant = (v: unknown): v is string => typeof v === "string" && INSTANT.test(v) && isoMillis(v) !== null;
const plain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && Object.getPrototypeOf(v) === Object.prototype;
const exactly = (o: Record<string, unknown>, keys: readonly string[]) => Object.keys(o).length === keys.length && keys.every(k => Object.hasOwn(o, k));
const KINDS: ReadonlySet<string> = new Set(["ask", "skill", "check"]);
const STATES: ReadonlySet<string> = new Set(["proposed", "admitted", "running", "verified", "failed", "cancelled"]);
const EVENT_TYPES: ReadonlySet<string> = new Set(["admitted", "running", "tool", "model", "verified", "failed", "cancelled"]);
const FAILURES: ReadonlySet<string> = new Set(FAILURE_CODES);
/** A bundled procedure id's shape; which ids exist is checked where titles are known (render.ts). */
const SKILL_ID = /^[a-z][a-z-]{0,47}$/u;

/**
 * Whether one ToolEnvelope from a shared tool fits the closed grammar, with no contact detail anywhere in it and no
 * background-check wording in any of its strings (owner decision 2026-11-14: never in the shared copy; shared_check.rs
 * refuses the same before writing).
 */
export function sharedEnvelopeOk(envelope: unknown): envelope is ToolEnvelope {
  if (!plain(envelope) || typeof envelope["tool"] !== "string" || !SHARED.has(envelope["tool"])) return false;
  if (envelopeProblems(envelope).length) return false;
  const text = JSON.stringify(envelope);
  return !hasContactDetail(text) && !hasContactDetail(text.normalize("NFKC")) && !backgroundInToolResult(text);
}

function taskOk(t: unknown): t is SharedTask {
  if (!plain(t) || !exactly(t, ["kind", "skill_id", "state", "created_at", "updated_at", "failure", "events"])) return false;
  if (typeof t["kind"] !== "string" || !KINDS.has(t["kind"]) || typeof t["skill_id"] !== "string" || !SKILL_ID.test(t["skill_id"])) return false;
  if (typeof t["state"] !== "string" || !STATES.has(t["state"]) || !instant(t["created_at"]) || !instant(t["updated_at"])) return false;
  if (t["failure"] !== null && (typeof t["failure"] !== "string" || !FAILURES.has(t["failure"]))) return false;
  const events = t["events"];
  return Array.isArray(events) && events.length <= 64 && events.every(e => plain(e) && exactly(e, ["type", "detail", "at"]) &&
    typeof e["type"] === "string" && EVENT_TYPES.has(e["type"]) && typeof e["detail"] === "string" &&
    ledgerDetailOk(e["type"] as TaskEvent["type"], e["detail"]) && instant(e["at"]));
}

/** The shared file's text as a SharedCheck, or null when any part of it is outside the format. */
export function parseSharedCheck(text: string): SharedCheck | null {
  if (text.length > MAX_SHARED_BYTES) return null;
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (!plain(value)) return null;
  // A church on another system: its system and role numbers, both or neither (Planning Center's keys, exactly as before).
  const onSystem = Object.hasOwn(value, "system");
  const keys = ["format", ...(onSystem ? ["system", "role_numbers"] : []), "copy_id", "checked_at", "shared_at", "envelopes", "tasks"];
  if (!exactly(value, keys) || (onSystem && (!isSystem(value["system"]) || !isRoleNumbers(value["role_numbers"])))) return null;
  if (value["format"] !== SHARED_FORMAT || !instant(value["shared_at"]) || !instant(value["checked_at"])) return null;
  const { copy_id, checked_at, envelopes, tasks } = value;
  if (typeof copy_id !== "string" || !COPY_ID.test(copy_id)) return null;
  if (!Array.isArray(envelopes) || !envelopes.length || envelopes.length > SHARED_TOOLS.length || !envelopes.every(sharedEnvelopeOk)) return null;
  if (new Set(envelopes.map(e => e.tool)).size !== envelopes.length) return null;
  const system = onSystem ? value["system"] as SharedSystemId : null;
  if (!sourcesFit(envelopes, system) || (onSystem && !numbersFit(envelopes, value["role_numbers"] as RoleNumbers))) return null;
  // The check time must be the facts' own: the earliest among the results, never a later save time.
  const earliest = checkedAtOf(envelopes);
  if (earliest === null || isoMillis(checked_at as string) !== isoMillis(earliest)) return null;
  if (!Array.isArray(tasks) || tasks.length > MAX_SHARED_TASKS || !tasks.every(taskOk)) return null;
  return {
    format: SHARED_FORMAT, ...(system ? { system, role_numbers: value["role_numbers"] as RoleNumbers } : {}), copy_id, checked_at: checked_at as string,
    shared_at: value["shared_at"], envelopes, tasks,
  };
}
