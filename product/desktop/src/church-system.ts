// Which church system a church uses (onboarding decision 21; docs/design/church-systems-design.md), what this Mac keeps
// about that connection, the native calls that read it, and the one source of every word a page says about the system.
// One main system at a time: Planning Center, B1 Church or Breeze. Genesis can't feed the service check, so it is only
// "also read" (groups, events, forms) beside the main system. Ozzie only reads: nothing here can change any system.
//
// Keys never reach the page: native takes a key from the clipboard or its own secure window, checks it against the
// system and keeps it in this Mac's Keychain (src-tauri/src/church_systems.rs). The page holds only ids, the church's
// name and the words the person typed for its address. Native text is never shown: each outcome is a closed word.
import { invoke } from "@tauri-apps/api/core";
import { createContext, useContext, useEffect, useState } from "react";
import { cannotSee, howToConnect } from "../../../core/src/church-systems/facts.js";
import { isKnownZone, SYSTEM_IDS, SYSTEMS, untimed, type SystemId } from "../../../core/src/church-systems/types.js";
import { isDateOnly } from "../../../core/src/read-result.js";

/** The church's main system: the one its services, roles and volunteers live in. */
export type MainSystem = "planning-center" | "b1" | "breeze" | "genesis";
/** A main system other than Planning Center. */
export type OtherSystem = Extract<SystemId, "b1" | "breeze">;
export const MAIN_SYSTEMS: readonly MainSystem[] = ["planning-center", "b1", "breeze", "genesis"];
export const isOtherSystem = (s: unknown): s is OtherSystem => s === "b1" || s === "breeze";

/** A B1 Church or Breeze connection as this Mac keeps it: ids, the church's name and the plan watched. Never a key. */
export interface SystemConnection {
  system: OtherSystem;
  /** The system's own id for the church (B1's church id; Breeze's subdomain). */
  church_id: string;
  church_name: string | null;
  /** The church's own part of its address, as the person typed it and native accepted it ("grace" for grace.b1.church). */
  address: string;
  /** The plan (B1 Church) or event (Breeze) Ozzie watches; null until one is chosen. */
  service_id: string | null;
  /** That service's day as the system lists it (YYYY-MM-DD) and its name, for the pages' words before a check reads it. */
  service_day: string | null;
  service_name: string | null;
  /** The IANA zone the person confirmed for the church (B1 Church asks; Breeze gives its own). */
  zone: string | null;
  /** A result of the watched service has been on screen (first run is done once it has). */
  result_seen: boolean;
}
/**
 * Genesis: read beside the main system (design §8), or as the main system itself (round 5: a church that uses only
 * Genesis): groups, events and forms only. `result_seen`: as the main system, its first result has been on screen.
 */
export interface AlsoRead { system: "genesis"; church_id: string; church_name: string | null; zone: string | null; result_seen?: boolean }
export interface ChurchSystemState {
  /** null: not chosen yet on this Mac (the first run asks). */
  main: MainSystem | null;
  connection: SystemConnection | null;
  genesis: AlsoRead | null;
  /**
   * "Use a different system" was pressed and nothing is chosen yet: kept so a Mac that once used Planning Center (its
   * settings still name the church) comes back to "What does your church use?" after a quit, never to Planning Center
   * (polish 2026-11-21). Only while `main` is null; choosing a system drops it.
   */
  choosing?: true;
}
const KEY = "ozzie.church-system.v1";
export const NO_SYSTEM: ChurchSystemState = Object.freeze({ main: null, connection: null, genesis: null });

const ID = /^[A-Za-z0-9_-]{1,64}$/u;
/** A zone this Mac knows in the spelling the coverage check and native code agree on; anything else is no zone. */
const zoneOf = (v: unknown): string | null => isKnownZone(v) ? v : null;
const text = (v: unknown, max: number): string | null => typeof v === "string" && v.length > 0 && v.length <= max ? v : null;
const id = (v: unknown): string | null => typeof v === "string" && ID.test(v) ? v : null;

/** What `ozzie.church-system.v1` holds, read strictly: anything out of shape is left out, never guessed. */
export function readChurchSystem(raw: string | null): ChurchSystemState {
  try {
    const v: unknown = raw ? JSON.parse(raw) : null;
    if (!v || typeof v !== "object" || Array.isArray(v)) return { ...NO_SYSTEM };
    const r = v as Record<string, unknown>;
    const main = MAIN_SYSTEMS.includes(r.main as MainSystem) ? r.main as MainSystem : null;
    const c = r.connection as Record<string, unknown> | null | undefined;
    const connection: SystemConnection | null = c && typeof c === "object" && isOtherSystem(c.system) && id(c.church_id) && id(c.address) ? {
      system: c.system, church_id: c.church_id as string, church_name: text(c.church_name, 200), address: c.address as string,
      service_id: id(c.service_id), service_day: isDateOnly(c.service_day) ? c.service_day : null,
      service_name: text(c.service_name, 200), zone: zoneOf(c.zone),
      result_seen: c.result_seen === true,
    } : null;
    const g = r.genesis as Record<string, unknown> | null | undefined;
    const genesis: AlsoRead | null = g && typeof g === "object" && g.system === "genesis" && id(g.church_id) ? {
      system: "genesis", church_id: g.church_id as string, church_name: text(g.church_name, 200),
      zone: zoneOf(g.zone), ...(g.result_seen === true ? { result_seen: true } : {}),
    } : null;
    // A connection belongs to the main system it was made for; another main system's is never used.
    return { main, connection: connection && connection.system === main ? connection : null, genesis, ...(main === null && r.choosing === true ? { choosing: true as const } : {}) };
  } catch { return { ...NO_SYSTEM }; }
}
type Store = Pick<Storage, "getItem" | "setItem">;
const browser = (): Store | null => { try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; } };
/** This Mac's record of the church's system. Per-device; never synced. */
export function churchSystemStore(store: Store | null = browser()) {
  const get = (): ChurchSystemState => { try { return readChurchSystem(store?.getItem(KEY) ?? null); } catch { return { ...NO_SYSTEM }; } };
  return {
    get,
    set(next: ChurchSystemState): ChurchSystemState {
      // `choosing` is kept only while nothing is chosen (undefined is left out of the JSON).
      const kept = { ...next, choosing: next.main === null && next.choosing === true ? true : undefined };
      try { store?.setItem(KEY, JSON.stringify(kept)); } catch { /* per-device convenience only */ }
      return get();
    },
  };
}
export const churchSystem = churchSystemStore();

/** A church's key Ozzie let go of: its system and its id there. */
export interface LetGo { system: SystemId; church_id: string }
const LET_GO = "ozzie.church-system.let-go.v1";
/**
 * The churches whose key Ozzie let go of (another church connected in its place) but which this Mac's Keychain didn't
 * let it remove just then: kept here, ids only, and tried again when Ozzie starts and after each connect, so a key is
 * never left behind unasked. Only keys Ozzie itself chose to let go of are ever here.
 */
export function letGoStore(store: Store | null = browser()) {
  const get = (): LetGo[] => {
    try {
      const raw = JSON.parse(store?.getItem(LET_GO) ?? "[]") as unknown;
      return Array.isArray(raw) ? raw.flatMap((x: unknown) => {
        const v = x && typeof x === "object" ? x as Record<string, unknown> : {};
        return (SYSTEM_IDS as readonly unknown[]).includes(v.system) && id(v.church_id) ? [{ system: v.system as SystemId, church_id: v.church_id as string }] : [];
      }).slice(0, 20) : [];
    } catch { return []; }
  };
  const put = (list: LetGo[]) => { try { store?.setItem(LET_GO, JSON.stringify(list)); } catch { /* per-device convenience only */ } };
  const same = (a: LetGo, b: LetGo) => a.system === b.system && a.church_id === b.church_id;
  return {
    get,
    add(c: LetGo) { const all = get(); if (!all.some(x => same(x, c))) put([...all, { system: c.system, church_id: c.church_id }].slice(-20)); },
    remove(c: LetGo) { put(get().filter(x => !same(x, c))); },
  };
}
export const letGoLater = letGoStore();
/**
 * Lets a church's key go: removed from this Mac's Keychain (and that church's saved checks deleted); when the Keychain
 * doesn't let it just then, kept to try again (`letGoLater`). Resolves true once it is gone.
 */
export async function letChurchGo(c: LetGo, bridge: Pick<typeof churchSystems, "forget" | "deleteChecks"> = churchSystems, later = letGoLater): Promise<boolean> {
  const word = await bridge.forget(c.system, c.church_id);
  if (word !== "forgotten") { later.add(c); return false; }
  if (c.system !== "genesis" && await bridge.deleteChecks(c.system, c.church_id) !== "deleted") { later.add(c); return false; }
  later.remove(c);
  return true;
}
/**
 * Deletes a church's saved checks after its key was forgotten (a disconnect, a switch); when that doesn't go through,
 * the church is kept to let go of again (`letGoLater`), so its volunteers' names never stay on this Mac unasked.
 */
export async function deleteChecksOrLater(c: LetGo, bridge: Pick<typeof churchSystems, "deleteChecks"> = churchSystems, later = letGoLater): Promise<boolean> {
  if (c.system === "genesis") return true;
  if (await bridge.deleteChecks(c.system, c.church_id) === "deleted") return true;
  later.add(c);
  return false;
}
/**
 * Tries again to let go of every church kept to let go of, except one this Mac uses now (the main system's church or
 * Genesis's, read beside it): it may have been connected again since.
 */
export async function letGoAgain(state: ChurchSystemState, bridge: Pick<typeof churchSystems, "forget" | "deleteChecks"> = churchSystems, later = letGoLater): Promise<void> {
  const inUse = [state.connection, state.genesis].filter((c): c is NonNullable<typeof c> => c !== null);
  for (const c of later.get()) {
    if (inUse.some(u => u.system === c.system && u.church_id === c.church_id)) { later.remove(c); continue; }
    await letChurchGo(c, bridge, later);
  }
}

// ---- Native ------------------------------------------------------------------------------------------------------

/** How a key check or a connection check ended. "works" or one closed word (native church_systems.rs). */
export interface Connected { outcome: string; church: { id: string; name: string | null } | null }
/**
 * A plan or event to watch. `time`: Breeze's start on the church's clock, "HH:MM" (null for an event with no time of
 * day, and for B1 Church). `people`: how many people Breeze lists on it, counted only for the events on the soonest day
 * when several share it (native breeze.rs `MAX_PICK_COUNTS`); null where not counted.
 */
export interface ServiceChoice { id: string; day: string; name: string | null; shared: boolean | null; time?: string | null; people?: number | null }
export interface Choices { outcome: string; choices: ServiceChoice[] }
export interface Checked { outcome: string; capture: string | null }
export interface SavedKey { system: SystemId; church_id: string }
/** A check of a watched service kept on this Mac (native church_systems.rs `save_check`), from its file name alone. */
export interface SavedCheck { path_id: string; service_id: string; completed_at: string }
/** Native's answer when the call itself failed: one closed word, never its text. */
const closed = (error: unknown): string => typeof error === "string" && /^[a-z-]{1,40}$/u.test(error) ? error : "unavailable";
async function call<T>(command: string, args: Record<string, unknown>, failed: (word: string) => T): Promise<T> {
  try { return await invoke<T>(command, args); } catch (error) { return failed(closed(error)); }
}
const word = (v: unknown): string => typeof v === "string" && /^[a-z-]{1,40}$/u.test(v) ? v : "invalid-response";
/** A connect or verify answer as the page may use it: a closed word, and a church with a checked id and a short name. */
export function validConnected(raw: unknown): Connected {
  const r = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const outcome = word(r.outcome);
  const c = r.church && typeof r.church === "object" ? r.church as Record<string, unknown> : null;
  const church = c && id(c.id) ? { id: c.id as string, name: text(c.name, 200) } : null;
  if (outcome === "works" && !church) return { outcome: "invalid-response", church: null };
  return { outcome, church: outcome === "works" ? church : null };
}
/** The plans or events to choose from, each with a checked id and a real date; anything else is left out. */
export function validChoices(raw: unknown): Choices {
  const r = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const list = Array.isArray(r.choices) ? r.choices : [];
  const choices = list.slice(0, 200).flatMap((x: unknown) => {
    const c = x && typeof x === "object" ? x as Record<string, unknown> : {};
    const time = typeof c.time === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(c.time) ? c.time : null;
    const people = typeof c.people === "number" && Number.isSafeInteger(c.people) && c.people >= 0 && c.people <= 100_000 ? c.people : null;
    return id(c.id) && isDateOnly(c.day) ? [{ id: c.id as string, day: c.day, name: text(c.name, 200), shared: typeof c.shared === "boolean" ? c.shared : null,
      ...(time ? { time } : {}), ...(people !== null ? { people } : {}) }] : [];
  });
  return { outcome: word(r.outcome), choices };
}
/** Saved checks as native lists them: each with a file name of its form, a checked id and a real time; anything else is left out. */
export function validSavedChecks(raw: unknown): SavedCheck[] {
  const list = Array.isArray(raw) ? raw : [];
  return list.slice(0, 200).flatMap((x: unknown) => {
    const c = x && typeof x === "object" ? x as Record<string, unknown> : {};
    return typeof c.path_id === "string" && /^[a-z0-9]+\.[A-Za-z0-9_-]{1,64}\.[A-Za-z0-9_-]{1,64}\.[1-9]\d{0,14}\.json$/u.test(c.path_id) && id(c.service_id)
      && typeof c.completed_at === "string" && Number.isFinite(Date.parse(c.completed_at))
      ? [{ path_id: c.path_id, service_id: c.service_id as string, completed_at: c.completed_at }] : [];
  });
}
/** The church system reads. Every one is a GET native allows for that system; nothing here can change anything there. */
export const churchSystems = {
  /** "Paste my key" (`paste`: this Mac's clipboard, read once) or "Type or paste it in a window" (`enter`). */
  connect: (system: SystemId, address: string | null, how: "paste" | "enter") =>
    call<unknown>("church_system_connect", { system, address, how }, outcome => ({ outcome, church: null })).then(validConnected),
  verify: (system: SystemId, churchId: string) =>
    call<unknown>("church_system_verify", { system, churchId }, outcome => ({ outcome, church: null })).then(validConnected),
  /** `from`: the first day the page counts as upcoming (system-setup.ts `listedToday`), so native counts who is on each of that day's events. */
  choices: (system: OtherSystem, churchId: string, from?: string) =>
    call<unknown>("church_system_choices", { system, churchId, ...(from ? { from } : {}) }, outcome => ({ outcome, choices: [] })).then(validChoices),
  check: (system: SystemId, churchId: string, serviceId: string | null, zone: string | null) =>
    call<Checked>("church_system_check", { system, churchId, serviceId, zone }, outcome => ({ outcome, capture: null })),
  forget: (system: SystemId, churchId: string) =>
    call<string | null>("church_system_forget", { system, churchId }, word => word).then(r => r ?? "forgotten"),
  saved: () => call<SavedKey[]>("church_system_saved", {}, () => []),
  /** How long a church system's Keychain call has waited on macOS, in milliseconds; null when none is under way. */
  keychainWait: () => call<unknown>("church_system_keychain_wait", {}, () => null).then(v => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null),
  /** The church's saved checks on this Mac, newest first. */
  savedChecks: (system: OtherSystem, churchId: string) =>
    call<unknown>("church_system_saved_checks", { system, churchId }, () => []).then(validSavedChecks),
  /** One saved check, as a check gives it (its names join native's guard on model requests first). */
  loadCheck: (system: OtherSystem, churchId: string, pathId: string) =>
    call<Checked>("church_system_load_check", { system, churchId, pathId }, outcome => ({ outcome, capture: null })),
  /** Removes the church's saved checks from this Mac: "deleted", or one closed word. */
  deleteChecks: (system: OtherSystem, churchId: string) =>
    call<unknown>("church_system_delete_checks", { system, churchId }, word => word).then(r => typeof r === "number" ? "deleted" : word(r)),
};

// ---- Words -------------------------------------------------------------------------------------------------------

/**
 * Every word a page says about the church's main system, in one place. Planning Center's are exactly the words the
 * pages said before a second system existed. A feature a system doesn't have is null here, and the page leaves its
 * control out (where the pastor would otherwise wonder, `cantSee` says so plainly).
 */
export interface SystemWords {
  system: MainSystem;
  /** "Planning Center", "B1 Church", "Breeze". */
  name: string;
  /** Where service plans live: "Planning Center Services", "B1 Church", "Breeze". */
  services: string;
  /** The check line on the service's page. */
  liveRead: string;
  savedCopy: string;
  checkNow: string;
  checking: string;
  connect: string;
  /** "Open in Planning Center"; null where Ozzie has no link into the system. */
  openIn: string | null;
  /** The request on a card not answered yet, where the system says it wasn't sent. */
  notSent: string;
  /** The same, where the system doesn't say whether it was sent (Breeze); null where it always says. */
  sentUnknown: string | null;
  /** The sidebar's line: not connected, connected, and connected to a named church. */
  notConnected: string;
  connected: string;
  connectedTo: (church: string) => string;
  /** Ozzie's checks on their own: the schedule, what changed, quiet hours and private notices. */
  checksOnItsOwn: boolean;
  /**
   * Jobs (Keep {day} covered, the morning briefing): Planning Center, B1 Church and Breeze (system-jobs.ts; there, only those
   * two: watching room bookings, follow-ups and group meetings reads Planning Center's Calendar, People and Groups).
   */
  jobs: boolean;
  /** Siri and Shortcuts, and the copy for other AI apps, read only Planning Center checks for now (Ask reads every system's). */
  askAndShare: boolean;
  /** Saved copies of checks. */
  savedChecks: boolean;
  /** Rooms, follow-ups, group meetings, forms, Check-Ins and Registrations: Planning Center only. */
  extras: boolean;
  /** One plain line for a feature this system doesn't have, said where the pastor would look for it (`plural`: several). */
  notHere: (what: string, plural?: boolean) => string;
  /**
   * Ozzie's own fixed sentences that name Planning Center only as where the facts are, said for this system: the name in
   * place of "Planning Center Services" and "Planning Center". Planning Center's own words are returned unchanged.
   */
  say: (text: string) => string;
  /** "See how this works" on a card: the reads each finding comes from, in plain words; null: Planning Center's table. */
  reads: readonly string[] | null;
  /** That fold's last line. */
  howEnd: string;
  /** An open role's card when the system ties no team to its roles (Breeze); null where it does. */
  noTeam: string | null;
  /** An open role still open after the person decided it, as the system's count says it. */
  remaining: (n: number) => string;
  /** Nothing chosen yet (NOT_CHOSEN): pages lead to "What does your church use?" instead of a system's own step. */
  unchosen?: true;
}
const PLANNING_CENTER: SystemWords = Object.freeze({
  system: "planning-center", name: "Planning Center", services: "Planning Center Services",
  liveRead: "Live read from Planning Center Services", savedCopy: "Saved copy of a check of Planning Center Services",
  checkNow: "Check Planning Center now", checking: "Checking Planning Center…", connect: "Connect Planning Center", openIn: "Open in Planning Center",
  notSent: "Planning Center shows the request hasn't been sent yet. Is that expected?", sentUnknown: null,
  notConnected: "Planning Center not connected", connected: "Planning Center connected", connectedTo: (church: string) => `Planning Center: ${church}`,
  checksOnItsOwn: true, jobs: true, askAndShare: true, savedChecks: true, extras: true, notHere: (what: string) => what,
  say: (text: string) => text, reads: null,
  // Reading changes nothing; the one change a leader may confirm (planning-center-changes.ts) is never made from a card's reading.
  howEnd: "Why I flagged this lists the rule and the facts. Every read in the latest check is on What happened. Reading it changed nothing in Planning Center.",
  noTeam: null,
  // The leader's own decision changed nothing in Planning Center (true whether or not Ozzie can add people there).
  remaining: (n: number) => `Planning Center still shows ${n === 1 ? "1 remaining request" : `${n} remaining requests`}; your decision here didn't change anything there.`,
});
const other = (system: SystemId): SystemWords => {
  const name = SYSTEMS[system].name;
  return Object.freeze({
    system, name, services: name,
    liveRead: `Live read from ${name}`, savedCopy: `Saved copy of a check of ${name}`,
    checkNow: `Check ${name} now`, checking: `Checking ${name}…`, connect: `Connect ${name}`, openIn: null,
    notSent: `${name} shows the request hasn't been sent yet. Is that expected?`,
    sentUnknown: SYSTEMS[system].asked ? null : `${name} doesn't say whether the request was sent.`,
    notConnected: `${name} not connected`, connected: `${name} connected`, connectedTo: (church: string) => `${name}: ${church}`,
    checksOnItsOwn: true, jobs: system !== "genesis", askAndShare: false, savedChecks: true, extras: false,
    notHere: (what: string, plural = false) => `${what} ${plural ? "work" : "works"} with Planning Center only for now. Ozzie can't do ${plural ? "these" : "this"} with ${name} yet.`,
    say: (text: string) => text.replace(/Planning Center Services/gu, name).replace(/Planning Center/gu, name),
    reads: system === "b1"
      ? ["The plan and the times B1 Church marks as the service", "Its roles and how many people each needs", "Who is scheduled and how each answered",
        "Each role's team", "Those people's blockouts", "Other plans they're on that day", "Their names, kept on this Mac"]
      : system === "genesis" ? ["Groups", "Events from yesterday through the next four weeks, with how many attended the ones that have ended", "Forms and how many times each was filled in"]
      // Breeze leaves the number wanted empty on live roles (breeze.rs): said only where it gives one (release review).
      : ["The event and its time", "Its roles, and how many people each needs where Breeze gives a number", "Who is scheduled and how each answered", "Their names, kept on this Mac"],
    howEnd: `Why I flagged this lists the rule and the facts. Nothing in ${name} changed.`,
    noTeam: SYSTEMS[system].teamMembers ? null : `${name} doesn't tie a team to each role, so Ozzie can't suggest who could help.`,
    remaining: (n: number) => `By ${name}'s numbers, ${n === 1 ? "1 more person is" : `${n} more people are`} still needed; Ozzie hasn't changed anything there.`,
  });
};
const WORDS: Readonly<Record<MainSystem, SystemWords>> = Object.freeze({ "planning-center": PLANNING_CENTER, b1: other("b1"), breeze: other("breeze"),
  // Genesis as the main system (round 5): no service check, saved checks or jobs; its own checks run while Ozzie is open.
  genesis: Object.freeze({ ...other("genesis"), savedChecks: false, jobs: false }) });
/**
 * The words before a church has chosen what it uses (a fresh Mac, round 5): neutral, never "Planning Center not
 * connected", and the way on is "Choose what your church uses". Planning Center's structure otherwise (it was every
 * page's before a second system existed); a Mac that chose or connected Planning Center keeps Planning Center's words.
 */
export const NOT_CHOSEN: SystemWords = Object.freeze({
  ...PLANNING_CENTER, name: "your church's system", services: "your church's system",
  liveRead: "Live read", savedCopy: "Saved copy of a check", checkNow: "Check now", checking: "Checking…", connect: "Choose what your church uses",
  notConnected: "No church system connected yet", connected: "Connected", connectedTo: (church: string) => church, unchosen: true,
  say: (text: string) => text.replace(/([Cc])onnect Planning Center in Settings/gu, (_, c: string) => `${c === "C" ? "C" : "c"}hoose what your church uses in Settings`)
    .replace(/Planning Center Services|Planning Center/gu, "your church's system"),
});
/** The words for `system`; Planning Center's when none is chosen (every page before a second system existed). */
export const systemWords = (system: MainSystem | null | undefined): SystemWords => WORDS[system ?? "planning-center"];

/** The one sentence that says which host Ozzie contacts for each system (design §7). */
export const HOST_SENTENCE: Readonly<Record<SystemId, string>> = Object.freeze({
  b1: "Ozzie reads your church's B1 Church account from api.churchapps.org.",
  breeze: "Ozzie reads your church's Breeze account at its own breezechms.com address.",
  genesis: "Ozzie reads your church's Genesis account from the address Genesis publishes for its API.",
});
/** Where the key is sent, as the key window and the connect screen say it. */
export function keyGoesTo(system: SystemId, address: string | null): string {
  if (system === "b1") return "Ozzie sends the key only to api.churchapps.org.";
  if (system === "breeze") return address ? `Ozzie sends the key only to ${address}.breezechms.com.` : "Ozzie sends the key only to your church's breezechms.com address.";
  return "Ozzie sends the key only to the address Genesis publishes for its API.";
}

/** The church's address as the person may type it: the part before .b1.church or .breezechms.com, or the whole address. */
export function addressLabel(system: OtherSystem, typed: string): string | null {
  let t = typed.trim().toLowerCase().replace(/^https?:\/\//u, "").split(/[/?#]/u)[0]!.replace(/\.+$/u, "");
  const suffix = system === "b1" ? ".b1.church" : ".breezechms.com";
  if (t.endsWith(suffix)) t = t.slice(0, -suffix.length);
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(t) && !t.startsWith("xn--") ? t : null;
}

/** Each system's own words for the key and the address, and what Ozzie reads there (design §1, its documented API). */
export interface ConnectWords {
  title: string; keyName: string; addressLabel: string | null; addressPlaceholder: string | null; addressHelp: string | null;
  reads: string;
  /** What Ozzie can't see there, the most important first (section 1's table, in plain words). */
  cantSee: readonly string[];
  /** Every sentence of facts.ts `cannotSee`, for the fold. */
  everything: readonly string[];
  steps: readonly string[];
}
export const CONNECT: Readonly<Record<SystemId, ConnectWords>> = Object.freeze({
  b1: {
    title: "Connect B1 Church", keyName: "B1 Church API key",
    addressLabel: "Your church's B1 Church address", addressPlaceholder: "yourchurch.b1.church",
    addressHelp: "B1 Church shows it at the top of Settings.",
    reads: "For the plan Ozzie watches: its times, its roles and how many people each needs, who is scheduled and how they answered, each role's team, those people's blockouts, and other plans they're on that day. Also your church's groups, upcoming events and forms, as counts.",
    cantSee: [
      "Ozzie can't read background checks from B1 Church: B1 has no background-check record.",
      "Ozzie can't check a plan until you've confirmed your church's time zone in Ozzie.",
      "Ozzie doesn't read attendance from B1 Church yet.",
    ],
    everything: cannotSee("b1"), steps: howToConnect("b1"),
  },
  breeze: {
    title: "Connect Breeze", keyName: "Breeze API key",
    addressLabel: "Your church's Breeze address", addressPlaceholder: "yourchurch.breezechms.com",
    addressHelp: "The address you sign in to Breeze at.",
    reads: "For the event Ozzie watches: its time, its roles (and how many people each needs, where Breeze gives a number), who is scheduled and how they answered, and how many people were checked in to it by name once it has ended. Also your church's tags and the entry counts of its 5 newest forms.",
    cantSee: [
      "Ozzie can't read blockout dates from Breeze.",
      "Ozzie can't suggest who could help from Breeze: it doesn't tie a team to each role.",
      "Ozzie can't see roles or volunteers on Breeze's newer scheduling page: Breeze only shares what's on its older Volunteers page.",
      "Ozzie doesn't read background checks from Breeze.",
    ],
    everything: cannotSee("breeze"), steps: howToConnect("breeze"),
  },
  genesis: {
    title: "Connect Genesis", keyName: "Genesis API key", addressLabel: null, addressPlaceholder: null, addressHelp: null,
    reads: "Your church's groups, its events from yesterday through the next four weeks with how many attended, and its forms with how many times each was filled in. No one's name.",
    cantSee: [
      "Ozzie can't check whether your services are covered from Genesis: it doesn't share volunteer schedules.",
      "Ozzie doesn't read background checks from Genesis.",
    ],
    everything: cannotSee("genesis"), steps: howToConnect("genesis"),
  },
});

/** The name of the Keychain item Ozzie keeps a system's key in (native keys.rs `service`), as Keychain Access lists it. */
export const keychainItem = (system: SystemId): string => `church.ozzie.church-system.${system}.v1`;
/** Each key check's outcome as its own plain sentence (fixed local copy; native text is never shown). null: it worked. */
export function connectProblem(system: SystemId, outcome: string, address: string | null): { text: string; alert: boolean } | null {
  const name = SYSTEMS[system].name;
  const where = system === "b1" ? (address ? `${address}.b1.church` : "that address") : system === "breeze" ? (address ? `${address}.breezechms.com` : "that address") : name;
  const alert = (t: string) => ({ text: t, alert: true });
  switch (outcome) {
    case "works": return null;
    case "cancelled": return { text: "Nothing was saved.", alert: false };
    case "empty": return alert(`There was no key to check. Copy the key in ${name}, then press Paste my key again.`);
    case "address": return alert(system === "b1"
      ? "That doesn't look like a B1 Church address. Type the address B1 Church shows at the top of Settings, like yourchurch.b1.church."
      : "That doesn't look like a Breeze address. Type the address you sign in to Breeze at, like yourchurch.breezechms.com.");
    case "format": return alert(system === "b1" ? "That doesn't look like a B1 Church API key. Copy the whole key again (it starts with cak_), then try again."
      : system === "genesis" ? "That doesn't look like a Genesis API key. Copy the whole key again (it starts with gk_live_), then try again."
      : "That doesn't look like a Breeze API key. Copy the whole key from Breeze's API Key page again, then try again.");
    case "not-found": return alert(system === "genesis" ? "Genesis couldn't find the church this key is for, so nothing was saved. Make a new key in Genesis, then try again."
      : `${name} doesn't know a church at ${where}. Check the address, then try again. Nothing was saved.`);
    case "key-refused": return alert(system === "b1"
      ? `B1 Church didn't accept this key for ${where}. Check that you copied the whole key, that it was made in this church's B1 Church, and that it hasn't been deleted or passed its expiry date. Nothing was saved.`
      : system === "breeze" ? `Breeze didn't accept this key at ${where}. Check that you copied the whole key from that church's Breeze account. Nothing was saved.`
      : "Genesis didn't accept this key. Check that you copied the whole key and that it hasn't been deleted. Nothing was saved.");
    case "refused": return alert(system === "b1"
      ? "B1 Church accepted the key but didn't let Ozzie read your church's account. Make the key as someone who can view group members, with the groups read box ticked. Nothing was saved."
      : `${name} accepted the key but didn't let Ozzie read your church's account. Nothing was saved.`);
    case "unreachable": case "timeout": return alert(`Ozzie couldn't reach ${name} just now, so nothing was saved. Check that this Mac is online, then try again.`);
    case "rate-limited": return alert(`${name} asked Ozzie to slow down. Wait a minute, then try again.`);
    case "too-large": case "invalid-response": return alert(`${name} answered with something Ozzie couldn't read, so nothing was saved. Try again in a moment.`);
    // macOS was asked whether Ozzie may replace a key kept on this Mac (one another program saved) and the answer was Deny.
    case "denied": return alert(`${name} accepted the key, but macOS didn't let Ozzie replace the key this Mac already keeps for your church, so nothing was saved. Try again, and when macOS asks, choose Allow (type your Mac password if it asks).`);
    case "locked": case "unavailable": return alert(`${name} accepted the key, but this Mac didn't let Ozzie keep it. Unlock this Mac (type your Mac password if it asks), then try again.`);
    // An older key for this church saved by another program, which macOS won't let Ozzie remove (native keys.rs
    // `InTheWay`, round 4): trying again can't help, so the way out is named, with the item's exact name.
    // Keychain Access isn't in Utilities on current macOS (review of round 4, H1): Spotlight finds it. The account names
    // the church where the page knows its id (Breeze: the address), so another church's working key is never deleted.
    case "in-the-way": return alert(`${name} accepted the key, but this Mac already keeps an older ${name} key for your church that another program saved, and macOS won't let Ozzie replace it, so nothing was saved. To clear it, open Keychain Access (press Command-Space, type Keychain Access, then press Return), search for ${keychainItem(system)}, delete the item${system === "breeze" && address ? ` whose account is ["local","${address}"]` : " for this church"}, then press Paste my key again.`);
    case "busy": return alert("Ozzie is still checking the last key. Wait a few seconds, then try again.");
    case "no-key": return alert(`Ozzie has no ${name} key on this Mac any more. Connect ${name} again.`);
    default: return alert(`${name} couldn't be checked just now, so nothing was saved. Try again in a moment.`);
  }
}

/** A check's or a list's outcome as one sentence, for the service's page and setup. null when it worked. */
export function readProblemText(system: SystemId, outcome: string): string | null {
  const name = SYSTEMS[system].name;
  switch (outcome) {
    case "ok": case "works": return null;
    case "no-key": return `Ozzie has no ${name} key on this Mac. Connect ${name} again in Settings.`;
    case "key-refused": return `${name} no longer accepts the key Ozzie has, so nothing was read. Connect ${name} again in Settings with a new key.`;
    case "refused": return `${name} didn't let Ozzie read this. The key sees only what the person who made it can see.`;
    case "not-found": case "bad-id": return `${name} couldn't find the service Ozzie watches. Choose it again in Settings.`;
    case "rate-limited": return `${name} asked Ozzie to slow down. Wait a minute, then check again.`;
    case "unreachable": case "timeout": return `Ozzie couldn't reach ${name} just now. Check that this Mac is online, then check again.`;
    case "bad-zone": return "Ozzie doesn't know that time zone on this Mac. Choose your church's time zone again.";
    // macOS asked whether Ozzie may use the key (one another program saved, or an earlier Ozzie signed differently) and
    // the answer was Deny: connecting again saves a fresh copy that is Ozzie's own.
    case "denied": return `Ozzie couldn't read the key it keeps for ${name} from this Mac's Keychain: macOS didn't allow it. Connect ${name} again with your key, and Ozzie keeps a fresh copy it can read without asking.`;
    case "locked": case "unavailable": return "This Mac didn't let Ozzie use the key it keeps. Unlock this Mac (type your Mac password if it asks), then check again.";
    case "busy": return `Ozzie is already reading ${name}. Wait a moment, then check again.`;
    default: return `${name} couldn't be read just now. Try again in a moment.`;
  }
}

/** A Keychain call that has waited this long is waiting on macOS's own question to the person (native KeychainWatch). */
export const KEYCHAIN_ASKING_MS = 3_000;
/** Said while macOS asks the person about a key Ozzie keeps (`name`: the system), until they answer. */
export const keychainAsking = (name: string) =>
  `macOS is asking whether Ozzie may use the key it keeps for ${name} in this Mac's Keychain. Look for its window (it may be behind this one) and choose Always Allow, or type your Mac password if it asks for it. Ozzie carries on as soon as you answer.`;
/**
 * Whether macOS is asking the person about a church system's key now: while `active` (a step that may read the Keychain
 * is under way), native is asked each second how long its Keychain call has waited. False otherwise.
 */
export function useKeychainAsking(active: boolean, bridge: Pick<typeof churchSystems, "keychainWait"> = churchSystems): boolean {
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    if (!active) { setAsking(false); return; }
    let alive = true;
    const look = () => { void bridge.keychainWait().then(ms => { if (alive) setAsking(ms !== null && ms >= KEYCHAIN_ASKING_MS); }); };
    const timer = setInterval(look, 1000);
    return () => { alive = false; clearInterval(timer); };
  }, [active, bridge]);
  return active && asking;
}

/** The church's system's words for the pages under it (App provides it); Planning Center's when nothing says otherwise. */
export const SystemWordsContext = createContext<SystemWords>(systemWords(null));
export const useSystemWords = (): SystemWords => useContext(SystemWordsContext);

/** Each read word of a system's check in plain words, for What happened (types.ts READS holds the closed list). */
export const READ_LABELS: Readonly<Record<string, string>> = Object.freeze({
  "b1.church": "Your church's account", "b1.plans": "The plan", "b1.times": "The plan's times", "b1.positions": "Roles",
  "b1.assignments": "Who is scheduled", "b1.group_members": "Each role's team", "b1.blockouts": "Blockouts", "b1.plans_day": "Other plans that day",
  "b1.people": "Names, kept on this Mac", "b1.groups": "Groups", "b1.events": "Events", "b1.forms": "Forms",
  "b1.attendance": "Attendance", "b1.form_submissions": "Form submissions",
  "breeze.account": "Your church's account", "breeze.events": "The event", "breeze.roles": "Roles", "breeze.volunteers": "Who is scheduled",
  "breeze.tags": "Tags", "breeze.attendance": "Check-ins", "breeze.forms": "Forms", "breeze.form_entries": "Form entries",
  "breeze.people": "Names, kept on this Mac",
  "genesis.me": "Your church's account", "genesis.groups": "Groups", "genesis.group_members": "Group members", "genesis.events": "Events",
  "genesis.forms": "Forms", "genesis.form_submissions": "Form submissions", "genesis.contacts": "Names",
});
/** How one read ended, in a few words. */
export const readOutcome = (outcome: string, name: string): string => outcome === "ok" ? "Read" : outcome === "truncated" ? "Only partly read"
  : outcome === "not-requested" ? "Not read this time" : outcome === "refused" || outcome === "key-refused" ? `${name} didn't allow it` : "Didn't complete";
/** A read cut short by design every time (reads.ts PARTIAL_BY_DESIGN): read as far as Ozzie reads it, so never a problem (review of round 3, L6). */
export const BY_DESIGN_OUTCOME: Readonly<Record<string, string>> = Object.freeze({
  "b1.forms": "Read: only the forms the person who made the key can manage",
  "breeze.form_entries": "Counted for the 5 newest forms only",
});
/** A read left for later by design (round 4): Breeze's check-ins are read once the service has ended, never before. */
export const NOT_YET_OUTCOME: Readonly<Record<string, string>> = Object.freeze({
  "breeze.attendance": "Read once the service has ended",
});

/**
 * When an event from a church system is, as words: "Sun, Nov 22, 9:35 AM", or "Sun, Nov 22" for one with no time of day
 * (Breeze writes it as the church's midnight, types.ts `untimed`): never 12:00 AM (round 4). Its own date is used for
 * that, so no zone can move it to another day. null when it isn't a time.
 */
export function eventWhen(system: SystemId, iso: string, ...zones: readonly (string | null | undefined)[]): string | null {
  // Only Breeze writes "no time" as midnight; another system's midnight is a real time (review of round 4, L1).
  if (system === "breeze" && untimed(iso)) return formatAt(`${iso.slice(0, 10)}T12:00:00Z`, { weekday: "short", month: "short", day: "numeric" }, "UTC");
  return formatAt(iso, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }, ...zones);
}
/**
 * A time as words, never throwing: `iso` must be an instant, and `zone` is used only when this Mac knows it (a zone from
 * a church system's answer may be anything); otherwise this Mac's own zone. null when there is nothing to say.
 */
export function formatAt(iso: string | number, options: Intl.DateTimeFormatOptions, ...zones: readonly (string | null | undefined)[]): string | null {
  const at = typeof iso === "number" ? iso : Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const zone = zones.find(z => isKnownZone(z));
  try { return new Date(at).toLocaleString("en-US", { ...options, ...(zone ? { timeZone: zone } : {}) }).replace(/\u202f/gu, " "); }
  catch { return null; }
}
