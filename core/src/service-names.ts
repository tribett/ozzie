// Watched services' names in a question (owner request 2026-11-21: "address fully now"). With more than one service
// watched, a service's own Planning Center name is church data that never goes to a model: Ask turns it into a
// [Service N] label before anything is sent (core/src/ask.ts prepareAsk), the harness fails a task that still holds one
// (harness/index.ts Harness.check), and the native agent_step check refuses one too (native-auth name_guard.rs
// `service_named`, the same rules; shared vectors in core/test/service-names-parity.json). Nothing here sends anything.
//
// How a service's name is found, in a question already cleaned by Ask (NFKC, one line, brackets turned into parentheses):
//  - words are runs of letters of a spaced script and decimal digits, compared folded (case, accents, stroked letters and
//    compatibility forms ignored, as roster names are); a mark continues a word, and so does an apostrophe between two
//    letters, which is dropped ("Children's" reads "childrens", as "Childrens" does); invisible and format characters
//    neither split nor join one; the last word may take a plural "s" or "es" ("Weekend Services", "Youth Nights");
//  - a service's whole name, its words in order, each pair separated by one to three characters that aren't letters,
//    digits or line breaks ("Weekend Service", "weekend  service", "Greeter (Weekend Service)", "Ozzie Demo Youth Night
//    (fictional)"), or joined by "-", "_" or "/", or run together ("WeekendService"; a name made only of everyday words run
//    together needs its capitals, as spaced, so "lighthouse" or "everyone" is never "Light House" or "Every One";
//    review B, round 3, R1);
//  - a part of a longer name, two or more of its words in a row ("Youth Night" for "Ozzie Demo Youth Night (fictional)"),
//    only when it holds a word that marks it out (review A, M1): a word that isn't an everyday one, of three letters or
//    more ("Riverside", "Ozzie"), or one the service writes with a capital, typed with one, that no other watched
//    service's name has ("Night" beside "Weekend Service"), or two or more words the service writes with capitals, typed
//    with them, whoever else's name has them ("Youth Night" of "Youth Night Worship" and "Youth Night Prayer"; review A,
//    round 2, N1); never a number, a single letter, "s", "am" or "pm". So "in the"
//    of "Worship in the Park", "00 AM" of "8:00 AM" and "AM Service" of two services' "9:00 AM Service" and "11:00 AM
//    Service" never count. Run together, a part needs a word that isn't an everyday one or two of its words' capitals,
//    read where each word starts ("RiversideCampus" for "Riverside Campus Sunday", "YouthNight"; never "youthnight", nor
//    "Sunday" for "Sun Day Camp"). In the strict name mode (no common words) a small word ("the", "of", "in" …) never
//    marks a part either. A part that is another service's whole name belongs to that service; a marked part two
//    services' names share is said to be unclear ("Riverside Campus" of "Riverside Campus 9am" and "11am"), so Ask can
//    refuse it rather than guess or send it; never a single word;
//  - the owner's name rule ("capitalized only", core/src/harness/names.ts), for names made only of everyday words
//    (common-words.txt, a weekday or month, their plurals, and numbers): such a name, or part, counts only where every
//    word the service writes with a capital is typed with one ("Sunday Morning", not "sunday morning"), unless its words
//    are joined or run together, which ordinary prose doesn't do. A name of one word that is a weekday or month never
//    counts ("Sunday"), as for roster names. Without the common words (the strict name mode) everyday names count in any
//    case;
//  - a name in a script written without spaces (Han, Hangul, Kana, Thai) is found anywhere, whole.
//  - letters of another script that imitate Latin ones (the native name check's own table, name_guard.rs `lookalike`) are
//    read as the Latin letters, so "Wеekend Service" with a Cyrillic е is that service too.
// Deliberately not found here, as for roster names: a name glued to other letters ("WeekendServiceTeam") or broken inside a
// word. With fewer than two watched services nothing counts: a church with one service reads exactly as before. Two
// watched services whose names read the same are one service here, and both count as watched.
import { fold, UNSPACED } from "./draft-request.js";

/** Weekday and month names (as core/src/ask.ts CALENDAR_WORDS): a one-word service name of one never counts. */
const CALENDAR: ReadonlySet<string> = new Set(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]);
/** Characters that show nothing (name_guard.rs `invisible` and format or private-use): they neither split nor join a word. */
const SKIPPED = /[\p{Cf}\p{Co}\p{Default_Ignorable_Code_Point}\u2800]/u;
const WORD_START = (c: string) => (/\p{L}/u.test(c) && !UNSPACED.test(c)) || /\p{Nd}/u.test(c);
const MARK = /\p{M}/u;
const CAPITAL = /^[\p{Lu}\p{Lt}]/u;
const LINE_BREAK = /[\n\r\v\f\u0085\u2028\u2029]/u;
/** What may join a service's words into one: a hyphen (any dash folds to one), an underscore or a slash. */
const JOINERS: ReadonlySet<string> = new Set(["-", "_", "/"]);
/** Apostrophes (as fold unifies them): one between two letters is dropped and the word goes on. */
const APOSTROPHE = /^['\u2018\u2019\u02bc\u02b9`\u00b4]$/u;
/** Words that never mark out a part of a name: possessive "s" left alone, and times of day. */
const NEVER_MARKS: ReadonlySet<string> = new Set(["s", "am", "pm"]);
/** Small words that never mark out a part in the strict name mode, which has no common words to tell them by. */
const SMALL_WORDS: ReadonlySet<string> = new Set(["the", "of", "in", "and", "at", "on", "for", "to", "an", "by", "with", "from", "or"]);
/** Cyrillic, Greek, small-capital and IPA letters read as the Latin letter they imitate (name_guard.rs `lookalike`, the same table). */
const LOOKALIKE_TABLE: readonly [string, string][] = [
  ["\u{410}\u{391}", "A"],
  ["\u{412}\u{392}", "B"],
  ["\u{415}\u{395}", "E"],
  ["\u{405}", "S"],
  ["\u{406}\u{4c0}\u{399}", "I"],
  ["\u{408}\u{37f}", "J"],
  ["\u{41a}\u{39a}", "K"],
  ["\u{41c}\u{39c}", "M"],
  ["\u{41d}\u{4ba}\u{397}", "H"],
  ["\u{41e}\u{39f}", "O"],
  ["\u{420}\u{3a1}", "P"],
  ["\u{421}", "C"],
  ["\u{422}\u{3a4}", "T"],
  ["\u{423}\u{4ae}\u{3a5}", "Y"],
  ["\u{425}\u{3a7}", "X"],
  ["\u{51a}", "Q"],
  ["\u{51c}", "W"],
  ["\u{474}", "V"],
  ["\u{430}\u{3b1}\u{1d00}\u{251}", "a"],
  ["\u{432}\u{44c}\u{299}", "b"],
  ["\u{433}\u{280}", "r"],
  ["\u{435}\u{3b5}\u{1d07}", "e"],
  ["\u{43a}\u{3ba}\u{1d0b}", "k"],
  ["\u{43c}\u{1d0d}", "m"],
  ["\u{43d}\u{4bb}\u{29c}", "h"],
  ["\u{43e}\u{3bf}\u{1d0f}", "o"],
  ["\u{43f}\u{3b7}\u{274}", "n"],
  ["\u{440}\u{3c1}\u{1d18}", "p"],
  ["\u{441}\u{1d04}", "c"],
  ["\u{442}\u{3c4}\u{1d1b}", "t"],
  ["\u{443}\u{4af}\u{3b3}\u{28f}", "y"],
  ["\u{445}\u{3c7}", "x"],
  ["\u{455}\u{a731}", "s"],
  ["\u{456}\u{3b9}\u{26a}\u{269}", "i"],
  ["\u{4cf}\u{29f}", "l"],
  ["\u{458}\u{3f3}\u{1d0a}", "j"],
  ["\u{501}\u{1d05}", "d"],
  ["\u{51b}", "q"],
  ["\u{51d}\u{3c9}\u{1d21}", "w"],
  ["\u{475}\u{3bd}\u{1d20}\u{28b}", "v"],
  ["\u{396}", "Z"],
  ["\u{39d}", "N"],
  ["\u{3bc}\u{3c5}\u{1d1c}", "u"],
  ["\u{a730}", "f"],
  ["\u{262}\u{261}", "g"],
  ["\u{1d22}", "z"],
];
const LOOKALIKE: ReadonlyMap<string, string> = new Map(LOOKALIKE_TABLE.flatMap(([from, to]) => [...from].map(c => [c, to] as const)));
/** The look-alike table, for the test that holds it to the native one. */
export const lookalikes = (): ReadonlyMap<string, string> => LOOKALIKE;

/** A word: where it is, folded, whether it starts with a capital, and its letters before folding (look-alikes read as Latin). */
interface Token { start: number; end: number; folded: string; capital: boolean; raw: string }
/** The words of a text and the folded gaps around them: `gaps[i]` stands before `tokens[i]`. */
function tokenize(text: string): { tokens: Token[]; gaps: string[] } {
  const tokens: Token[] = [], gaps: string[] = [];
  let word = "", start = -1, end = -1, gap = "";
  const flush = () => {
    tokens.push({ start, end, folded: fold(word), capital: CAPITAL.test(word), raw: word });
    word = ""; start = -1;
  };
  for (let i = 0; i < text.length;) {
    const raw = String.fromCodePoint(text.codePointAt(i)!), next = i + raw.length, c = LOOKALIKE.get(raw) ?? raw;
    if (SKIPPED.test(c)) { i = next; continue; }
    if (word && APOSTROPHE.test(c) && next < text.length) {
      const after = String.fromCodePoint(text.codePointAt(next)!);
      if (WORD_START(LOOKALIKE.get(after) ?? after)) { end = next; i = next; continue; }
    }
    if (WORD_START(c) || (word && MARK.test(c))) {
      if (!word) { gaps.push(fold(gap)); gap = ""; start = i; }
      word += c; end = next;
    } else {
      if (word) flush();
      gap += c;
    }
    i = next;
  }
  if (word) flush();
  gaps.push(fold(gap));
  return { tokens, gaps };
}

/** A word that ordinary prose uses: a common word, a weekday or month, a plural of one, or a number. */
function everyday(word: string, common: ReadonlySet<string>): boolean {
  const plain = (w: string) => common.has(w) || CALENDAR.has(w);
  return /^\d+$/u.test(word) || plain(word) || (word.endsWith("s") && plain(word.slice(0, -1))) || (word.endsWith("es") && common.has(word.slice(0, -2)));
}

interface Service {
  name: string; words: string[]; caps: boolean[]; anywhere: string | null;
  /** What the name has before its first word and after its last ("(" or ")"), as cleaned, so a match takes them too. */
  lead: string; trail: string;
}
/** A watched service's name as words, or as one string found anywhere for an unspaced script; null when it has neither. */
function service(name: string): Service | null {
  const trimmed = name.trim();
  // Cleaned the way Ask cleans a question (ask.ts `clean`): compatibility forms, square brackets as parentheses, one space.
  const text = trimmed.normalize("NFKC").replace(/\[/gu, "(").replace(/\]/gu, ")").replace(/\s+/gu, " ");
  if (UNSPACED.test(text)) { const anywhere = fold(text).trim(); return anywhere ? { name: trimmed, words: [], caps: [], anywhere, lead: "", trail: "" } : null; }
  const { tokens } = tokenize(text);
  if (!tokens.length) return null;
  return { name: trimmed, words: tokens.map(t => t.folded), caps: tokens.map(t => t.capital), anywhere: null,
    lead: text.slice(0, tokens[0]!.start).trim(), trail: text.slice(tokens.at(-1)!.end).trim() };
}
/**
 * Whether a service's own name, written as it is, counts in a question (chips name a service only then): it has a word,
 * and isn't a weekday or month alone (review A, L3).
 */
export function nameable(name: string): boolean {
  const s = service(name);
  return s !== null && (s.anywhere !== null || !(s.words.length === 1 && CALENDAR.has(s.words[0]!)));
}
/** The key two names are the same service by (case, spacing and punctuation aside), or "" for a name with no words. */
export function serviceKey(name: string): string {
  const s = service(name);
  return s ? s.anywhere ?? s.words.join(" ") : "";
}

/** Every run of two or more words of a name, in the form ServiceMatchOptions `exclude` takes (a roster member's name). */
export function wordRuns(name: string): string[] {
  const words = tokenize(name.normalize("NFKC")).tokens.map(t => t.folded), out: string[] = [];
  for (let a = 0; a < words.length; a++) for (let b = a + 2; b <= words.length; b++) out.push(words.slice(a, b).join(" "));
  return out;
}

/** One place a watched service's name counts, in the text's own indices, and which services it can stand for. */
export interface ServiceMatch {
  readonly start: number;
  readonly end: number;
  /** A service's whole name (or a name in an unspaced script), not a part of one: only a whole name beats a position. */
  readonly whole: boolean;
  /** The one service it names, by its own name as given; two or more when it is a part those services share (unclear). */
  readonly services: readonly string[];
}
export interface ServiceMatchOptions {
  /** Lower-case common English words: the owner's name rule for everyday names. Absent: everyday names count in any case. */
  readonly common?: ReadonlySet<string> | undefined;
  /** Parts never read as a service (a roster member's full name, folded words one space apart), as Ask reads them. */
  readonly exclude?: ReadonlySet<string> | undefined;
}

/**
 * Every place in `text` a watched service's name counts (header), longest first, which may overlap; empty with no
 * service's name. `services` is every watched service's own name; two that read the same are one service (the first).
 */
export function serviceMatches(text: string, services: readonly string[], options: ServiceMatchOptions = {}): ServiceMatch[] {
  const known: Service[] = [];
  let watched = 0;
  for (const name of services) {
    const s = service(name);
    if (!s) continue;
    watched++;
    if (!known.some(k => (k.anywhere ?? k.words.join(" ")) === (s.anywhere ?? s.words.join(" ")))) known.push(s);
  }
  if (watched < 2) return [];
  // Whole names first: a part that is another service's whole name is that service's.
  const whole = new Map<string, number>(), parts = new Map<string, Set<number>>();
  known.forEach((s, i) => { if (s.words.length) whole.set(s.words.join(" "), i); });
  known.forEach((s, i) => {
    for (let a = 0; a < s.words.length; a++) for (let b = a + 2; b <= s.words.length; b++) {
      if (a === 0 && b === s.words.length) continue;
      const key = s.words.slice(a, b).join(" ");
      if (whole.has(key) || options.exclude?.has(key)) continue;
      parts.set(key, (parts.get(key) ?? new Set()).add(i));
    }
  });
  const owners = (key: string): number[] => whole.has(key) ? [whole.get(key)!] : [...(parts.get(key) ?? [])];
  const { tokens, gaps } = tokenize(text);
  const out = new Map<string, ServiceMatch>();
  const add = (start: number, end: number, of: number[], whole: boolean) => {
    const services = of.map(i => known[i]!.name);
    out.set(`${start}:${end}:${services.join("\u0000")}`, { start, end, services, whole });
  };
  /** A word no other watched service's name has. */
  const own = (of: number, w: string) => known.every((k, i) => i === of || !k.words.includes(w));
  /** A word that could ever mark out a part: never a number, a single letter, "s", "am" or "pm". */
  const markable = (w: string) => !/^\d+$/u.test(w) && [...w].length >= 2 && !NEVER_MARKS.has(w);
  /** A word that marks out a part on its own (header), typed with a capital or not (`capital`). */
  const marks = (of: number, m: number, capital: boolean) => {
    const w = known[of]!.words[m]!;
    if (!markable(w)) return false;
    if (!options.common) return [...w].length >= 3 && !SMALL_WORDS.has(w);
    if (!everyday(w, options.common)) return [...w].length >= 3;
    return known[of]!.caps[m]! && capital && own(of, w);
  };
  /**
   * Whether a part, its words typed with these capitals, is marked out (header): one word that marks it, or two capitals.
   * Run together (`joined`), one capital marks nothing: a compound word starts with one ("Sunday", "Everyone").
   */
  const marked = (of: number, a: number, k: number, capitals: readonly boolean[], joined = false) =>
    Array.from({ length: k }, (_, m) => m).some(m => marks(of, a + m, !joined && capitals[m]!)) ||
    Array.from({ length: k }, (_, m) => m).filter(m => known[of]!.caps[a + m]! && capitals[m]! && markable(known[of]!.words[a + m]!)).length >= 2;
  /** Where each word of a part run together into one starts in what was typed: capital or not (none when folding changed its length). */
  const gluedCapitals = (token: Token, words: readonly string[]) => {
    const raw = [...token.raw];
    if (raw.length !== [...token.folded].length) return words.map(() => false);
    let at = 0;
    return words.map(w => { const c = raw[at]; at += [...w].length; return c !== undefined && CAPITAL.test(c); });
  };
  /** The last word typed, or with a plural "s" or "es". */
  const last = (typed: string, w: string) => typed === w || typed === `${w}s` || typed === `${w}es`;
  /** The name's own punctuation right before its first word or after its last, typed the same, goes with it. */
  const same = (at: number, piece: string) => piece !== "" && at >= 0 && at + piece.length <= text.length && fold(text.slice(at, at + piece.length)) === fold(piece);
  const widened = (s: Service, a: number, b: number, start: number, end: number): [number, number] =>
    [a === 0 && same(start - s.lead.length, s.lead) ? start - s.lead.length : start, b === s.words.length && same(end, s.trail) ? end + s.trail.length : end];
  // Each phrase a service's name gives: its whole name, and each part of two or more words.
  const phrases: { of: number; a: number; b: number }[] = [];
  known.forEach((s, of) => {
    for (let a = 0; a < s.words.length; a++) for (let b = a + 1; b <= s.words.length; b++) {
      const key = s.words.slice(a, b).join(" ");
      if ((a === 0 && b === s.words.length) || (b - a >= 2 && owners(key).length && !(whole.has(key) && whole.get(key) !== of))) phrases.push({ of, a, b });
    }
  });
  for (const { of, a, b } of phrases) {
    const s = known[of]!, words = s.words.slice(a, b), k = words.length, key = words.join(" "), whole = a === 0 && b === s.words.length;
    const counts = (at: number, joined: boolean) => {
      if (k === 1 && CALENDAR.has(words[0]!)) return false;
      // A part counts only with a word that marks it out (header; review A, M1).
      if (!whole && !marked(of, a, k, words.map((_, m) => tokens[at + m]!.capital))) return false;
      if (joined || !options.common || !words.every(w => everyday(w, options.common!))) return true;
      return words.every((_, m) => !s.caps[a + m] || tokens[at + m]!.capital);
    };
    for (let t = 0; t < tokens.length; t++) {
      // Run together into one word ("WeekendService"): a whole name (with its capitals when it is only everyday words), or a
      // part marked out as typed (a word that isn't everyday, or two of its words' capitals).
      const glued = k >= 2 && last(tokens[t]!.folded, words.join("")) ? gluedCapitals(tokens[t]!, words) : null;
      if (glued && (whole
        ? !options.common || !words.every(w => everyday(w, options.common!)) || words.every((_, m) => !s.caps[a + m] || glued[m])
        : marked(of, a, k, glued, true))) {
        add(...widened(s, a, b, tokens[t]!.start, tokens[t]!.end), owners(key), whole);
        continue;
      }
      if (t + k > tokens.length || !words.every((w, m) => m === k - 1 ? last(tokens[t + m]!.folded, w) : tokens[t + m]!.folded === w)) continue;
      const between = gaps.slice(t + 1, t + k);
      if (!between.every(g => [...g].length >= 1 && [...g].length <= 3 && !LINE_BREAK.test(g))) continue;
      if (counts(t, k >= 2 && between.every(g => JOINERS.has(g)))) add(...widened(s, a, b, tokens[t]!.start, tokens[t + k - 1]!.end), owners(key), whole);
    }
  }
  // A name in an unspaced script: anywhere, whole, in the folded text (mapped back to the text's own indices).
  const anywhere = known.flatMap((s, i) => s.anywhere ? [[s.anywhere, i] as const] : []);
  if (anywhere.length) {
    let f = "";
    const from: number[] = [], to: number[] = [];
    for (let i = 0; i < text.length;) {
      const size = text.codePointAt(i)! > 0xffff ? 2 : 1, piece = fold(text.slice(i, i + size));
      for (let n = 0; n < piece.length; n++) { from.push(i); to.push(i + size); }
      f += piece; i += size;
    }
    for (const [term, i] of anywhere) for (let at = f.indexOf(term); at >= 0; at = f.indexOf(term, at + 1)) add(from[at]!, to[at + term.length - 1]!, [i], true);
  }
  return [...out.values()].sort((x, y) => (y.end - y.start) - (x.end - x.start) || x.start - y.start);
}

/** Whether a watched service's name counts anywhere in `text` (header): what the harness's second check refuses. */
export const serviceNamed = (text: string, services: readonly string[], options: ServiceMatchOptions = {}): boolean =>
  serviceMatches(text, services, options).length > 0;
