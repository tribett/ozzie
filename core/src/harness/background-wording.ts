// Background-check wording (owner decision 2026-11-14: background-check facts are never sent to any model route, even
// as placeholders; review Q H2, reviews B and B2). One list, fixed/background-wording.json, read three times:
//   - here, for the page: prepareAsk (core/src/ask.ts) refuses a question with it before any request exists,
//     compose.ts routes such a question to an answer written on this Mac, and templateDraft (draft-request.ts) sends a
//     position name holding it as [Role];
//   - natively (core/native-auth/src/background.rs, the same file through include_str!), before any request to any
//     model route: rewording, Ask and every agent step, tool results included; and before the copy shared with other
//     AI apps is written (shared_check.rs);
//   - on ozzie.church (web/src/lib/hosted/background.ts, a byte-for-byte copy of the file and a verbatim copy of the
//     section below, both pinned by web/test/hosted-parity.test.ts), before AI Gateway.
// What is tested, not assumed: on the oracle corpus (background-wording-oracle.test.ts) the list refuses everything the
// page regex of v0.1.0 refused apart from Ozzie's one own sentence; the page, native and ozzie.church reach the same
// verdict on every text of that corpus and the same words for every Unicode scalar value under each folding
// (background-wording-differential.test.ts); background-wording-vectors.json runs on all three.
//
// A text that is exactly one of Ozzie's own sentences (the file's ozzies_own, carried whole by a tool result) holds no
// wording. Otherwise it holds wording when any of three foldings does (the file's `about` spells them out): format and
// default-ignorable characters deleted ("join", so "scr​eened" is "screened"), as word breaks ("split", so
// "DBSㅤrenewal" is "dbs renewal"), or as v0.1.0 read them ("v010"). Characters newer than the page's Unicode data are
// mapped from the file first, so the engine's data never decides. Words are runs of a-z and 0-9; every apostrophe,
// hyphen and other mark separates them, so "DBS's" is "dbs" and "s". Limits: letters from other scripts that only look
// Latin (Cyrillic "а"), letter-spaced or digit-for-letter spellings and paraphrases are not caught.
import wordingText from "./fixed/background-wording.json?raw";

/** The list file, as loaded here; checked below, and every text holds wording if it doesn't parse. */
const LIST: unknown = (() => { try { return JSON.parse(wordingText) as unknown; } catch { return null; } })();

// ---- The rule. web/src/lib/hosted/background.ts holds this section verbatim (web/test/hosted-parity.test.ts). ----

/** Letters that keep their stroke or ligature through NFD, spelled plainly (name_guard.rs `plain_letters`). */
const PLAIN_LETTERS: Readonly<Record<string, string>> = {
  "ø": "o", "ł": "l", "đ": "d", "ħ": "h", "ı": "i", "ß": "ss", "æ": "ae", "œ": "oe", "þ": "th",
  "ð": "d", "ς": "σ",
};
/** Format, private-use and default-ignorable characters and the blank braille pattern: what each folding deletes or breaks on. */
const IGNORABLE = /[\p{Cf}\p{Co}\p{Default_Ignorable_Code_Point}⠀͏︀-️\u{E0000}-\u{E007F}]/u;
/** What v0.1.0's fold deleted (draft-request.ts `fold`); it read every other ignorable character as a word break. */
const DELETED_IN_V010 = /[\p{Cf}\p{Co}͏︀-️\u{E0000}-\u{E007F}]/u;
const MARK = /\p{M}/u;

/** The three foldings: ignorables deleted, ignorables as word breaks, or as v0.1.0 read them. */
export type Folding = "join" | "split" | "v010";
export const FOLDINGS: readonly Folding[] = ["join", "split", "v010"];
interface Alternative { readonly word: string; readonly prefix: boolean }
type Phrase = readonly (readonly Alternative[])[];
interface Compiled {
  readonly phrases: readonly Phrase[]; readonly texts: readonly string[]; readonly own: readonly string[];
  readonly removed: ReadonlySet<number>; readonly letters: ReadonlyMap<number, string>;
}

const WORD = /^[a-z0-9]+$/u;
const HEX = /^[0-9A-F]{4,6}$/u;
/** One phrase: slots split on single spaces, alternatives on |, a prefix when it ends in *. Null when it isn't that. */
function parsePhrase(text: string): Phrase | null {
  const slots = text.split(" ").map(slot => slot.split("|").map(alt => {
    const prefix = alt.endsWith("*");
    const word = prefix ? alt.slice(0, -1) : alt;
    return WORD.test(word) ? { word, prefix } : null;
  }));
  return slots.every(slot => slot.every(alt => alt !== null)) ? slots as Alternative[][] : null;
}
const isStrings = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every(s => typeof s === "string");
/** The list's phrases, Ozzie's own sentences and the newer characters, or null when any part doesn't parse. */
function compile(list: unknown): Compiled | null {
  if (typeof list !== "object" || list === null) return null;
  const { phrases, ozzies_own: own, newer_unicode: newer } = list as { phrases?: unknown; ozzies_own?: unknown; newer_unicode?: unknown };
  if (!isStrings(phrases) || !isStrings(own) || phrases.length === 0 || own.some(s => s.length === 0)) return null;
  if (typeof newer !== "object" || newer === null) return null;
  const { removed, letters } = newer as { removed?: unknown; letters?: unknown };
  if (!isStrings(removed) || typeof letters !== "object" || letters === null) return null;
  const mapped = Object.entries(letters as Record<string, unknown>);
  if (![...removed, ...mapped.map(([hex]) => hex)].every(hex => HEX.test(hex))) return null;
  if (!mapped.every(([, to]) => typeof to === "string" && WORD.test(to))) return null;
  const parsed = phrases.map(parsePhrase);
  if (!parsed.every(p => p !== null)) return null;
  return {
    phrases: parsed as Phrase[], texts: phrases, own,
    removed: new Set(removed.map(hex => parseInt(hex, 16))),
    letters: new Map(mapped.map(([hex, to]) => [parseInt(hex, 16), to as string])),
  };
}
const COMPILED = compile(LIST);
/** The phrases exactly as the file holds them (empty if it doesn't parse). */
export const BACKGROUND_PHRASES: readonly string[] = COMPILED?.texts ?? [];
/** Ozzie's own fixed sentences, each holding no wording when it is the whole text (empty if the file doesn't parse). */
export const OZZIES_OWN: readonly string[] = COMPILED?.own ?? [];
/**
 * Whether c is one of the file's newer characters: a hidden character wherever one is refused (a question, a note, a
 * position name), since no one types them and each folding reads them only one way (review B3 L-1). Every character is
 * one if the file doesn't parse.
 */
export function newerCharacter(c: string): boolean {
  const at = c.codePointAt(0) ?? 0;
  return !COMPILED || COMPILED.removed.has(at) || COMPILED.letters.has(at);
}

/** One folding of a text, before it is split into words (the file's `about`). */
export function wordingFold(text: string, folding: Folding): string {
  let mapped = "";
  for (const c of text) {
    const at = c.codePointAt(0) ?? 0;
    const letter = COMPILED?.letters.get(at);
    if (letter !== undefined) mapped += folding === "join" ? letter : " ";
    else if (COMPILED?.removed.has(at)) mapped += folding === "join" ? "" : " ";
    else mapped += c;
  }
  let kept = "";
  for (const c of mapped.normalize("NFKC")) {
    if (!IGNORABLE.test(c)) kept += c;
    else if (folding === "split" || (folding === "v010" && !DELETED_IN_V010.test(c) && !MARK.test(c))) kept += " ";
  }
  return kept.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[øłđħıßæœþðς]/g, c => PLAIN_LETTERS[c] ?? c);
}

const isWordChar = (c: string) => (c >= "a" && c <= "z") || (c >= "0" && c <= "9");
/** The words of a text under one folding: runs of a-z and 0-9; everything else separates. */
export function wordingTokens(text: string, folding: Folding = "join"): string[] {
  const out: string[] = [];
  let word = "";
  for (const c of wordingFold(text, folding)) {
    if (isWordChar(c)) word += c;
    else if (word) { out.push(word); word = ""; }
  }
  if (word) out.push(word);
  return out;
}

const fits = (alt: Alternative, token: string) => alt.prefix ? token.startsWith(alt.word) : token === alt.word;
const phraseAt = (phrase: Phrase, tokens: readonly string[], at: number) =>
  at + phrase.length <= tokens.length && phrase.every((slot, k) => slot.some(alt => fits(alt, tokens[at + k] ?? "")));

/**
 * Whether text holds background-check wording: under any of the three foldings, unless the whole text is one of Ozzie's
 * own sentences. Every text does if the list didn't parse.
 */
export function backgroundWording(text: string): boolean {
  if (!COMPILED) return true;
  const { phrases, own } = COMPILED;
  if (own.includes(text)) return false;
  return FOLDINGS.some(folding => {
    const tokens = wordingTokens(text, folding);
    return tokens.some((_, at) => phrases.some(phrase => phraseAt(phrase, tokens, at)));
  });
}

/** Every string literal of a JSON text, keys and values alike, decoded, in order; null when the text isn't JSON. */
function jsonStrings(text: string): string[] | null {
  try { JSON.parse(text); } catch { return null; }
  const out: string[] = [];
  for (let at = text.indexOf("\""); at !== -1; at = text.indexOf("\"", at)) {
    let end = at + 1;
    while (end < text.length && text[end] !== "\"") end += text[end] === "\\" ? 2 : 1;
    out.push(JSON.parse(text.slice(at, end + 1)) as string);
    at = end + 1;
  }
  return out;
}
/**
 * Whether a tool result holds the wording: each of its strings on its own, so a key and a neighbouring value never join
 * into a phrase ("records", "check_time") and Ozzie's own sentence is set aside only as a whole string; the whole text
 * when it isn't JSON.
 */
export function backgroundInToolResult(text: string): boolean {
  const strings = jsonStrings(text);
  return strings === null ? backgroundWording(text) : strings.some(backgroundWording);
}

// ---- End of the rule. ----

/**
 * Phrases that also name things other than a check: a team or policy name, a craft, a print job (reviews B2 L-3, B3
 * N-2). They refuse like every other phrase (when in doubt, refuse); only what the page shows beside the refusal
 * differs (harness-bridge.ts `askOzzie`). Each is one of the list's phrases exactly (background-wording.test.ts).
 */
export const ALSO_OTHER_THINGS: readonly string[] = [
  "background come|comes|came back", "finger print*", "sex offender*", "registered offender*", "offender registry|registries",
  "safe sanctuaries",
];
/**
 * Whether text holds the wording by a phrase that names a check (any phrase but ALSO_OTHER_THINGS), under any folding.
 * It only chooses what is shown for a question the list already stopped; it never decides what is sent.
 */
export function namesACheck(text: string): boolean {
  if (!COMPILED) return true;
  if (COMPILED.own.includes(text)) return false;
  const { phrases, texts } = COMPILED;
  const naming = phrases.filter((_, k) => !ALSO_OTHER_THINGS.includes(texts[k] ?? ""));
  return FOLDINGS.some(folding => {
    const tokens = wordingTokens(text, folding);
    return tokens.some((_, at) => naming.some(phrase => phraseAt(phrase, tokens, at)));
  });
}
