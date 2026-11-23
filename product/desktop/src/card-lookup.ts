// Visitor cards: whether someone with the name on a card is already in Planning Center (owner decision 2026-11-23).
// While a person checks visitor cards on this Mac, Ozzie looks up the name on each card in the church's Planning Center
// People, one name at a time, so the card can say plainly whether Planning Center has someone with that name. The
// decision's conditions are this file's rules:
//
// - Read-only, on this Mac. The only way out is the two native commands below, named here as literals and nowhere
//   else in the page: `look_up_card_name` (one name, for the church the cards belong to; native card_lookup.rs makes
//   one People name-search GET that returns each person's id and display name, at most five) and
//   `cancel_card_name_lookups`. The name goes only to the church's own Planning Center: never to an AI model, never to
//   ozzie.church, never to What happened, a notice, a log or storage. Nothing is added to Planning Center.
// - Only while cards are being checked: the page looks names up only while a review is open, on screen and shown
//   (cards-page.tsx), each distinct name once per review (again only after a lookup was stopped or couldn't finish, or
//   on "Look this name up again"), one at a time, at most MAX_NAMES names a review.
// - Nothing kept after the cards: what was found lives in `NameLookups`, beside the review, and is dropped with it
//   (`clear`); hiding the cards stops any lookup under way (`pause`).
// - Never a guess: a name match is never taken to be the same person. The words say it may be someone else, people
//   are listed in alphabetical order (never ranked), and more than five is said without anyone's name.
import { invoke } from "@tauri-apps/api/core";
import { nameTokens } from "../../../core/src/card-fields.js";

/** One person Planning Center's People search found: its id and its name as Planning Center has it. */
export interface FoundPerson { readonly id: string; readonly name: string }
/** Native's closed reasons for not looking a name up (card_lookup.rs `NotLookedUp`). */
export type NotLookedUp = "invalid-name" | "not-connected" | "church-changed" | "not-allowed" | "busy" | "too-many-just-now" | "could-not-check" | "cancelled";
const NOT_LOOKED_UP: readonly NotLookedUp[] = ["invalid-name", "not-connected", "church-changed", "not-allowed", "busy", "too-many-just-now", "could-not-check", "cancelled"];

/** The native bridge. Tests pass their own. */
export interface CardNames {
  lookUp(church: string, name: string): Promise<unknown>;
  cancel(): Promise<unknown>;
}
export const cardNames: CardNames = {
  lookUp: (church, name) => invoke<unknown>("look_up_card_name", { church, name }),
  cancel: () => invoke<unknown>("cancel_card_name_lookups"),
};

// ---- Which names go out --------------------------------------------------------------------------------------------

/** The same rule as native `SearchName` (source.rs): at most this many characters, in at most this many words. */
export const NAME_CHARS = 80;
export const NAME_WORDS = 6;
/** The most digits a name may hold ("Flo901"), so no phone number goes with it (native `NAME_DIGITS`). */
export const NAME_DIGITS = 3;
/** The most distinct names one review of cards looks up. */
export const MAX_NAMES = 50;
const PLAIN = /^[\p{Alphabetic}\p{N}'’.\- ]+$/u;
/**
 * A card's name as it may be looked up: one line, its whitespace collapsed, 2 to NAME_CHARS characters in at most
 * NAME_WORDS words, only letters, digits, spaces, apostrophes, hyphens and periods, with at least two letters, a letter
 * in every word and at most NAME_DIGITS digits (privacy review L1). Null for anything else (an email address, a phone
 * number or part of one, a single letter): that name is never sent.
 */
export function searchName(text: unknown): string | null {
  if (typeof text !== "string" || text.length > NAME_CHARS * 8) return null;
  const name = text.normalize("NFC").split(/\s+/u).filter(Boolean).join(" ");
  const words = name.split(" ").filter(Boolean).length;
  const chars = [...name].length;
  const letters = [...name].filter(c => /\p{Alphabetic}/u.test(c)).length;
  const digits = [...name].filter(c => /\p{N}/u.test(c)).length;
  const lettered = name.split(" ").every(word => /\p{Alphabetic}/u.test(word));
  return chars >= 2 && chars <= NAME_CHARS && words >= 1 && words <= NAME_WORDS && PLAIN.test(name) && letters >= 2 && lettered
    && digits <= NAME_DIGITS ? name : null;
}
/** One review looks a name up once, whatever its capitals. */
const keyOf = (name: string) => name.toLowerCase();

// ---- What came back ------------------------------------------------------------------------------------------------

/** How one name stands in this review. `at`: when Planning Center answered (this Mac's clock). */
export type NameLookup =
  | { readonly state: "looking" }
  | { readonly state: "found"; readonly people: readonly FoundPerson[]; readonly at: number }
  | { readonly state: "more"; readonly at: number }
  | { readonly state: "none"; readonly at: number }
  /** `cap`: the review already looked up MAX_NAMES names. */
  | { readonly state: "not-checked"; readonly why: "could-not-check" | "cap" };

const ID = /^[1-9]\d{0,31}$/u;
/** Native's reply, read strictly: anything else is a failure. People in alphabetical order, never Planning Center's. */
export function readReply(value: unknown, at: number): NameLookup | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.result === "no-one") return { state: "none", at };
  if (v.result === "more") return { state: "more", at };
  if (v.result !== "people" || !Array.isArray(v.people) || v.people.length < 1 || v.people.length > 5) return null;
  const people: FoundPerson[] = [];
  for (const p of v.people as unknown[]) {
    const { id, name } = (p ?? {}) as Record<string, unknown>;
    if (typeof id !== "string" || !ID.test(id) || typeof name !== "string" || !name.trim() || name.length > 400) return null;
    if (people.some(q => q.id === id)) return null;
    people.push({ id, name });
  }
  people.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { state: "found", people, at };
}
/**
 * Native's refusal (card_lookup.rs `Refused`): `{ reason, wait_seconds? }`, the wait given with `busy` (Planning Center's
 * Retry-After, or a change going ahead) and `too-many-just-now` (until there's room in the minute). A bare code is read
 * the same way; anything else is `could-not-check`.
 */
export function refusal(error: unknown): { reason: NotLookedUp; waitMs: number | null } {
  const raw = error && typeof error === "object" ? (error as Record<string, unknown>) : { reason: error };
  const reason = typeof raw.reason === "string" && (NOT_LOOKED_UP as readonly string[]).includes(raw.reason) ? raw.reason as NotLookedUp : "could-not-check";
  const seconds = raw.wait_seconds;
  const waits = reason === "busy" || reason === "too-many-just-now";
  return { reason, waitMs: waits && typeof seconds === "number" && Number.isSafeInteger(seconds) && seconds > 0 ? seconds * 1000 : null };
}

// ---- One review's lookups ------------------------------------------------------------------------------------------

/** Waits before asking again while Planning Center is being read, when native names no longer wait. */
export const RETRY_MS = 3000;
/** The longest native ever asks the page to wait (card_lookup.rs `LONGEST_WAIT`). */
export const LONGEST_WAIT_MS = 300_000;
/** How many times one name is asked for before it is said it couldn't be looked up. */
export const TRIES = 10;

export interface LookupDeps {
  names: CardNames;
  /** The church the cards belong to now (a Planning Center organization id), or null while none is in use. */
  church: () => string | null;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  /** Something changed that the page shows. */
  onChange: () => void;
  /** Planning Center refused People for this sign-in (`not-allowed`): no more names are looked up. */
  onRefused: () => void;
}
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * One review's name lookups, in memory only. `want` gives the names the cards hold now (each distinct name is looked
 * up once, in card order, one at a time; a lookup stopped by `pause` is asked again on `resume`, one that couldn't finish
 * on `again`); `pause` stops any lookup under way (natively too) and keeps what was found;
 * `clear` drops everything with the cards. A lookup that comes back after `pause` or `clear` is dropped.
 */
export class NameLookups {
  private readonly results = new Map<string, NameLookup>();
  /** Names counted against MAX_NAMES: asked for, or waiting to be. */
  private readonly asked = new Set<string>();
  private queue: { key: string; name: string }[] = [];
  private generation = 0;
  private running = false;
  private paused = true;
  private refused = false;
  private readonly now: () => number;
  private readonly wait: (ms: number) => Promise<void>;
  constructor(private readonly deps: LookupDeps) {
    this.now = deps.now ?? Date.now;
    this.wait = deps.wait ?? sleep;
  }
  /** What is known about a card's name, or null when it isn't one that is looked up. */
  get(text: string): NameLookup | null {
    const name = searchName(text);
    return name ? this.results.get(keyOf(name)) ?? null : null;
  }
  /** How many distinct names this review has asked about (a count only). */
  get count(): number { return this.asked.size; }
  /**
   * The names the cards hold now, to look up while the review is shown. A name no card holds any more is taken off the
   * queue before it goes out (and no longer counts); one already asked about keeps its answer until the cards end.
   */
  want(texts: readonly string[]): void {
    if (this.refused) return;
    const wanted = new Map<string, string>();
    for (const text of texts) {
      const name = searchName(text);
      if (name && !wanted.has(keyOf(name))) wanted.set(keyOf(name), name);
    }
    const inFlight = this.running ? this.queue[0]?.key : undefined;
    this.queue = this.queue.filter(item => {
      if (wanted.has(item.key) || item.key === inFlight) return true;
      this.asked.delete(item.key);
      this.results.delete(item.key);
      return false;
    });
    let changed = false;
    for (const [key, name] of wanted) {
      if (this.results.has(key)) continue;
      if (this.asked.size >= MAX_NAMES) { this.results.set(key, { state: "not-checked", why: "cap" }); changed = true; continue; }
      this.asked.add(key);
      this.results.set(key, { state: "looking" });
      this.queue.push({ key, name });
      changed = true;
    }
    if (changed) this.deps.onChange();
    this.pump();
  }
  /** The person's own "Look this name up again" on a name that couldn't be looked up. */
  again(text: string): void {
    const name = searchName(text);
    if (!name || this.refused) return;
    const key = keyOf(name);
    const known = this.results.get(key);
    if (known?.state !== "not-checked" || known.why !== "could-not-check") return;
    this.results.set(key, { state: "looking" });
    this.queue.push({ key, name });
    this.deps.onChange();
    this.pump();
  }
  /** People was allowed again after Planning Center refused it: names may be looked up again. */
  allowAgain(): void {
    if (!this.refused) return;
    this.refused = false;
    this.deps.onChange();
  }
  /** The cards are shown and being checked: lookups may go out. */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.pump();
  }
  /** The cards are hidden (another page, the window off screen) or lookups can't go out now: stop what's under way. */
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.stopNow();
  }
  /** The cards ended: everything found is dropped, and anything under way is stopped. */
  clear(): void {
    this.paused = true;
    this.stopNow();
    this.queue = [];
    this.results.clear();
    this.asked.clear();
    this.refused = false;
  }
  private stopNow(): void {
    this.generation++;
    if (this.running) { this.running = false; void this.deps.names.cancel().catch(() => undefined); }
  }
  private pump(): void {
    if (this.running || this.paused || this.refused || !this.queue.length) return;
    this.running = true;
    const generation = this.generation;
    void this.run(generation);
  }
  private async run(generation: number): Promise<void> {
    const live = () => generation === this.generation && !this.paused;
    while (live() && this.queue.length) {
      const item = this.queue[0]!;
      const outcome = await this.one(item.name, live);
      if (!live()) return;
      this.queue.shift();
      if (outcome === "refused") {
        this.refused = true;
        for (const rest of [item, ...this.queue]) this.results.delete(rest.key);
        this.queue = [];
        this.running = false;
        this.deps.onRefused();
        this.deps.onChange();
        return;
      }
      this.results.set(item.key, outcome);
      this.deps.onChange();
    }
    if (generation === this.generation) this.running = false;
  }
  /** One name: asked again while Planning Center is busy or asked Ozzie to wait, up to TRIES times. */
  private async one(name: string, live: () => boolean): Promise<NameLookup | "refused"> {
    for (let attempt = 1; attempt <= TRIES; attempt++) {
      let reason: NotLookedUp;
      let waitMs: number | null = null;
      const church = this.deps.church();
      if (church === null || !ID.test(church)) return { state: "not-checked", why: "could-not-check" };
      try {
        const reply = readReply(await this.deps.names.lookUp(church, name), this.now());
        if (reply) return reply;
        reason = "could-not-check";
      } catch (error) { ({ reason, waitMs } = refusal(error)); }
      if (!live()) return { state: "not-checked", why: "could-not-check" };
      if (reason === "not-allowed") return "refused";
      if ((reason === "busy" || reason === "too-many-just-now") && attempt < TRIES) {
        // As long as Planning Center (or native's pace) asked, never longer than native's longest, never shorter than ours.
        await this.wait(Math.min(Math.max(waitMs ?? RETRY_MS, RETRY_MS), LONGEST_WAIT_MS));
        if (!live()) return { state: "not-checked", why: "could-not-check" };
        continue;
      }
      break;
    }
    return { state: "not-checked", why: "could-not-check" };
  }
}

// ---- Whether names are looked up at all ----------------------------------------------------------------------------

/**
 * Whether the names on these cards can be looked up now, and if not why: the example is on (its people are made up),
 * the church uses another system, Planning Center isn't connected or needs signing in to again, Ozzie is still checking
 * its sign-in or the church the cards belong to isn't in use yet ("waiting"), the sign-in doesn't include People
 * ("not-allowed": the page offers the People question), or Planning Center refused People ("refused").
 */
export type LookupAvailability = "on" | "example" | "other-system" | "not-connected" | "sign-in-again" | "waiting" | "not-allowed" | "refused";
/** What App knows about People access: allowed, not allowed, not known yet, or the church uses another system. */
export type PeopleAccessKnown = "allowed" | "not-allowed" | "unknown" | "other-system";
export function lookupAvailability({ example, access, disconnected, signInAgain, inUse, cardsChurch }: {
  example: boolean; access: PeopleAccessKnown; disconnected: boolean; signInAgain: boolean; inUse: string | null; cardsChurch: string | null;
}): LookupAvailability {
  if (example) return "example";
  if (access === "other-system") return "other-system";
  if (disconnected) return "not-connected";
  if (signInAgain) return "sign-in-again";
  if (inUse === null || cardsChurch !== inUse || !ID.test(inUse) || access === "unknown") return "waiting";
  return access === "allowed" ? "on" : "not-allowed";
}

// ---- Words ---------------------------------------------------------------------------------------------------------

/** Said once on the page, above the cards, when names aren't looked up; null when they are (or when nothing helps). */
export function availabilityLine(a: LookupAvailability, notHere: (what: string) => string): string | null {
  switch (a) {
    case "on": case "waiting": return null;
    case "example": return "Names on the cards aren't looked up in Planning Center People either.";
    case "other-system": return notHere("Looking up each card's name in Planning Center People");
    case "not-connected": return "Connect Planning Center to look up each card's name in Planning Center People.";
    case "sign-in-again": return "Sign in to Planning Center again in Settings to look up each card's name in Planning Center People.";
    case "not-allowed": return "Ozzie can look up the name on each card in Planning Center People to show whether someone with that name is already there. Your Planning Center connection doesn't include People yet.";
    case "refused": return "Planning Center didn't let Ozzie read People, so names on the cards aren't looked up. A Planning Center administrator at your church can give your account access to People.";
  }
}
const clock = (ms: number) => new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
const joined = (items: readonly string[]) => items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
/** Whether Planning Center's name for someone is the card's name, letters only, whatever the capitals or accents. */
export const sameName = (card: string, theirs: string) => {
  const a = nameTokens(card).join(" "), b = nameTokens(theirs).join(" ");
  return a !== "" && a === b;
};

/** A card's line: a short lead, then what it means, then where it came from and when. */
export interface LookupWords { lead: string; body: string; source: string | null; worth: boolean }
export const SOURCE = (at: number) => `Looked up in Planning Center People at ${clock(at)}. Ozzie won't combine anyone or add anyone.`;
/**
 * The words for a card whose name is `card`. Null while it's being looked up only when nothing should show yet; the
 * page shows its own "Looking…" line for `looking`.
 */
export function lookupWords(card: string, lookup: NameLookup): LookupWords | null {
  switch (lookup.state) {
    case "looking": return { lead: "Looking for this name in Planning Center People…", body: "", source: null, worth: false };
    case "found": {
      const same = lookup.people.every(p => sameName(card, p.name));
      const names = lookup.people.map(p => p.name);
      if (lookup.people.length === 1) {
        return same
          ? { lead: `Same name in Planning Center: ${names[0]}`, body: "Planning Center has a person with this name. It may be someone else with the same name.", source: SOURCE(lookup.at), worth: true }
          : { lead: `Similar name in Planning Center: ${names[0]}`, body: "Planning Center found this person when Ozzie looked up the name on the card. It may be someone else.", source: SOURCE(lookup.at), worth: true };
      }
      return {
        lead: `${same ? "Same name" : "Similar names"} in Planning Center: ${lookup.people.length} people`,
        body: `${joined(names)}. Only the names match: any of them, or none, may be this person.`,
        source: SOURCE(lookup.at), worth: true,
      };
    }
    case "more": return {
      lead: "Similar names in Planning Center: more than 5 people",
      body: "Search Planning Center People for this name to see whether one of them is this person.",
      source: SOURCE(lookup.at), worth: true,
    };
    case "none": return {
      lead: "Not found in Planning Center",
      // Only what Ozzie found: the account may not see everyone in People (privacy review L4).
      body: "Ozzie found no one in Planning Center People with this name. They may be there under another spelling or name, or where your account can't see them, so check before adding anyone.",
      source: SOURCE(lookup.at), worth: false,
    };
    case "not-checked": return lookup.why === "cap"
      ? { lead: "Not looked up", body: `Ozzie looks up at most ${MAX_NAMES} names in one set of cards.`, source: null, worth: false }
      : { lead: "Not looked up", body: "Ozzie couldn't look this name up in Planning Center just now.", source: null, worth: false };
  }
}
export const LOOK_AGAIN = "Look this name up again";
/**
 * Said once, the first time cards are checked with lookups on (privacy review L5; App's card-names-notice.ts remembers
 * it): what is now read, that it only reads, and how to stop it (Settings' own way to drop People access).
 */
export const CARD_NAMES_NEW = "New: while you check cards, Ozzie now looks up the name on each card in your church's Planning Center People, read-only, to show whether someone with that name is already there. Only the name goes, and only to Planning Center: nothing is added there, nothing goes to an AI, and nothing is kept after the cards end. To stop it, choose Connect again with Services only in Settings, under Rooms, follow-ups and group events; that also stops filling in To on notes, adding people to open roles, and the kids-team background-check reads.";
/** A name marked hard to read isn't looked up until it's checked against the photo. */
export const UNCLEAR_NOT_LOOKED_UP = "Not looked up while the name is marked hard to read. Check it against the photo first.";
/** "Look at these first" for a card whose name Planning Center has (one, several or more than five). */
export function lookFirstLine(label: string, card: string, lookup: NameLookup): string | null {
  if (lookup.state === "found") {
    const names = joined(lookup.people.map(p => p.name));
    return `${label}: Planning Center People has ${lookup.people.length === 1 ? "someone" : `${lookup.people.length} people`} with a name like “${card}” (${names}). Worth a look: only the name matches, which doesn't show it's the same person. Check Planning Center before adding anyone.`;
  }
  if (lookup.state === "more") return `${label}: more than 5 people in Planning Center People have a name like “${card}”. Worth a look before adding anyone.`;
  return null;
}
