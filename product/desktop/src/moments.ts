// The questions Ozzie asks at the moment they matter (onboarding spec §4.2, decision 13) and the "Finish setting up"
// list on Today (§4.1): what is remembered about them, on this Mac only, and when each one is due. Only answers are
// kept: "Leave [Your name] for now", "Open it without an address", a team's "No", the phone line's answer, and the
// list's "Not now" and "Hide this list". Never a name, a church, a plan or anything read from Planning Center (a team
// is kept by its Planning Center id only). Each question is asked once; once answered it never comes back by itself
// (NEVER-LIST 10), and every answer can still be changed where it lives (Settings, Church rules).
//
// Nothing here sends, records or notifies: it only reads and writes these two keys.

/** Where answers are kept. The app's is this Mac's localStorage; tests pass a Map-backed one. */
export interface KeyValue { getItem(key: string): string | null; setItem(key: string, value: string): void }
const browserStorage = (): KeyValue | null => { try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; } };

export const MOMENTS_KEY = "ozzie.moments.v1";
export const FINISH_KEY = "ozzie.finish-list.v1";

const teamId = (v: unknown): v is string => typeof v === "string" && /^[1-9]\d{0,31}$/u.test(v);
const plain = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
function read(storage: () => KeyValue | null, key: string): unknown {
  try { const raw = storage()?.getItem(key); return raw ? JSON.parse(raw) as unknown : null; } catch { return null; }
}
function write(storage: () => KeyValue | null, key: string, value: unknown) {
  try { storage()?.setItem(key, JSON.stringify(value)); } catch { /* a per-device convenience only: the question may come back */ }
}

// ---- ozzie.moments.v1 ---------------------------------------------------------------------------------------------

export interface Moments {
  /** "Leave [Your name] for now" was chosen on a note: the name question isn't asked again by itself. */
  name: "left" | null;
  /** "Open it without an address" was chosen: asked again only from the note's own "Fill in who it's to" link. */
  people: "declined" | null;
  /** Teams answered "No" to "Does {team} serve with kids?", by Planning Center team id. */
  kids: Readonly<Record<string, "no">>;
  /** The phone line on Today was answered ("Set up my phone" or "No thanks"). */
  phone: "set-up" | "no" | null;
  /** Ozzie has sent a notice on this Mac at least once (the phone line's trigger). */
  noticeSent: boolean;
}
export const NO_MOMENTS: Moments = Object.freeze({ name: null, people: null, kids: Object.freeze({}), phone: null, noticeSent: false });

/** What's kept, read strictly: anything unexpected is as if never answered. */
export function parseMoments(v: unknown): Moments {
  if (!plain(v)) return NO_MOMENTS;
  const kids: Record<string, "no"> = {};
  if (plain(v.kids)) for (const [k, answer] of Object.entries(v.kids).slice(0, 200)) if (teamId(k) && answer === "no") kids[k] = "no";
  return {
    name: v.name === "left" ? "left" : null,
    people: v.people === "declined" ? "declined" : null,
    kids,
    phone: v.phone === "set-up" || v.phone === "no" ? v.phone : null,
    noticeSent: v.noticeSent === true,
  };
}

export interface MomentsStore {
  get(): Moments;
  leaveName(): void;
  declinePeople(): void;
  answerKids(team: string): void;
  answerPhone(answer: "set-up" | "no"): void;
  /** Called when Ozzie has sent a notice on this Mac (the page's `background.notify` resolved). */
  noticeSent(): void;
}
export function momentsStore(storage: () => KeyValue | null = browserStorage): MomentsStore {
  const get = () => parseMoments(read(storage, MOMENTS_KEY));
  const put = (change: Partial<Moments>) => {
    const now = { ...get(), ...change };
    // Only what was answered is written: empty fields stay out of the record.
    write(storage, MOMENTS_KEY, {
      ...(now.name ? { name: now.name } : {}), ...(now.people ? { people: now.people } : {}),
      ...(Object.keys(now.kids).length ? { kids: now.kids } : {}), ...(now.phone ? { phone: now.phone } : {}), ...(now.noticeSent ? { noticeSent: true } : {}),
    });
  };
  return {
    get,
    leaveName: () => put({ name: "left" }),
    declinePeople: () => put({ people: "declined" }),
    answerKids: team => { if (teamId(team)) put({ kids: { ...get().kids, [team]: "no" } }); },
    answerPhone: answer => put({ phone: answer }),
    noticeSent: () => { if (!get().noticeSent) put({ noticeSent: true }); },
  };
}
/** This Mac's answers. */
export const moments: MomentsStore = momentsStore();

// ---- When each question is due (each fires once) ------------------------------------------------------------------

const PLACEHOLDER = "[Your name]";
/** "Your name for the end of notes": a prepared note still ends "[Your name]", no name is set, and it wasn't left. */
export const nameMomentDue = (memory: Moments, nameSet: boolean, text: string): boolean => !nameSet && memory.name !== "left" && text.includes(PLACEHOLDER);
/** "Fill in who it's to?": a note for one person, People isn't granted, and the person hasn't chosen to open without. */
export const peopleQuestionDue = (memory: Moments, peopleGranted: boolean): boolean => !peopleGranted && memory.people !== "declined";
/**
 * The phone line on Today: Ozzie has sent a notice on this Mac, the line was never answered, and phone notices aren't
 * already on. The page shows it the next time the window opens.
 */
export const phoneMomentDue = (memory: Moments, noticeSentOnThisMac: boolean, phoneOn = false): boolean =>
  noticeSentOnThisMac && memory.phone === null && !phoneOn;

// ---- Kids teams: the fixed list (spec §4.2) ----------------------------------------------------------------------

/** The words that make a team look like it serves with kids, as the spec lists them. */
export const KIDS_WORDS = ["kids", "kid's", "children", "nursery", "preschool", "pre-k", "toddler", "infant", "elementary", "kindergarten", "VBS", "check-in"] as const;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
/**
 * One word of the list as a pattern. Rules, decided here and tested (moments.test.ts):
 * - case doesn't matter; a curly apostrophe counts as a straight one;
 * - a hyphen in the list may be a hyphen, a dash, a space or nothing ("Pre-K", "Pre K", "PreK"; "Check In", "Checkin");
 * - the word must start and end at a word's edge: nothing letter-like before or after, so "Kidney" and "Skids" don't
 *   match, nor "Checking"; a small letter followed by a capital is an edge too, so "KidsZone" and "SuperKids" do;
 * - a plural counts ("Toddlers", "Infants", "Check-ins"; "Nurseries" for "nursery"); "kids" and "kid's" are their own.
 */
function wordPattern(word: string): string {
  const lower = word.toLowerCase();
  const plural = lower.endsWith("s") ? "" : lower.endsWith("y") ? null : "(?:s|es)?";
  const stem = plural === null ? lower.slice(0, -1) : lower;
  const body = [...stem].map(c => c === "'" ? "['’]" : c === "-" ? "[-‐‑–—\\s]?" : escape(c)).join("");
  return plural === null ? `${body}(?:y|ies)` : `${body}${plural}`;
}
const KIDS_PATTERN = new RegExp(`(?<![\\p{L}\\p{N}])(?:${KIDS_WORDS.map(wordPattern).join("|")})(?![\\p{L}\\p{N}])`, "iu");
/** Whether a Planning Center team name looks like a team that serves with kids. */
export const looksLikeKids = (name: unknown): boolean =>
  typeof name === "string" && KIDS_PATTERN.test(name.normalize("NFKC").replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2"));

export interface Team { id: string; name: string | null }
/**
 * The one team to ask "Does {team} serve with kids?" about: the first, in the order given (the check's), whose name is
 * on the list and that wasn't answered "No". None while any team is already marked a kids team in Church rules: the
 * question is only for a church that hasn't marked one.
 */
export function kidsTeamToAsk(teams: readonly Team[], markedKidsTeamIds: readonly string[], memory: Moments): Team | null {
  if (markedKidsTeamIds.some(teamId)) return null;
  return teams.find(t => teamId(t.id) && looksLikeKids(t.name) && memory.kids[t.id] !== "no") ?? null;
}
/**
 * The facts behind "Mark the teams that serve with kids" on the Finish list: `looking`, a team in the check looks like
 * one; `answered`, a team is marked, or every one that looks like one was answered "No".
 */
export function kidsFacts(teams: readonly Team[], markedKidsTeamIds: readonly string[], memory: Moments): { looking: boolean; answered: boolean } {
  const looking = teams.some(t => teamId(t.id) && looksLikeKids(t.name));
  return { looking, answered: markedKidsTeamIds.some(teamId) || kidsTeamToAsk(teams, markedKidsTeamIds, memory) === null };
}

// ---- ozzie.finish-list.v1 -----------------------------------------------------------------------------------------

export type FinishItemId = "start" | "service" | "kids" | "ai" | "waiting";
export const FINISH_IDS: readonly FinishItemId[] = ["start", "service", "kids", "ai", "waiting"];
/** `hidden`: "Hide this list" was chosen, for good. `notNow`: items collapsed with "Not now". */
export interface FinishMemory { hidden: boolean; notNow: readonly FinishItemId[] }
export function parseFinish(v: unknown): FinishMemory {
  if (!plain(v)) return { hidden: false, notNow: [] };
  const notNow = Array.isArray(v.notNow) ? FINISH_IDS.filter(id => (v.notNow as unknown[]).includes(id)) : [];
  return { hidden: v.hidden === true, notNow };
}
export interface FinishStore { get(): FinishMemory; notNow(id: FinishItemId): void; hide(): void }
export function finishStore(storage: () => KeyValue | null = browserStorage): FinishStore {
  const get = () => parseFinish(read(storage, FINISH_KEY));
  return {
    get,
    notNow: id => { const m = get(); if (!m.notNow.includes(id)) write(storage, FINISH_KEY, { hidden: m.hidden, notNow: [...m.notNow, id] }); },
    hide: () => write(storage, FINISH_KEY, { hidden: true, notNow: get().notNow }),
  };
}
/** This Mac's list memory. */
export const finishMemory: FinishStore = finishStore();
