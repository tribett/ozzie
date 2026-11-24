// Matching for Find in Ozzie (owner decision 2026-11-24: a ⌘K find box). Pure and synchronous: it compares what was
// typed with what the page already holds, on this Mac, and keeps nothing. No storage, no native call, no network.
//
// The rules, in plain words:
// - Case and accents don't matter, and no letter is dropped: "zoe" finds "Zoë", "sorensen" finds "Sørensen", a ligature
//   or a full-width letter reads as its plain letters, and a name in another script keeps every sign it is written with.
// - Every typed word must match the start of a word in the item ("gre vol" finds "Greeter volunteers").
// - A typed word of five letters or more may have one letter wrong, missing, extra, or two neighbours swapped.
// - A match in an item's title comes before one found only in its other words (its detail and plain-English synonyms),
//   and a clean match before one with a letter wrong. Equal matches keep the order they were given in.

/**
 * Some letters have no accent to take off: Unicode treats them as letters of their own, so decomposing leaves them as
 * they are. A person typing on a plain keyboard writes them like this instead (each pair: the letter, then its spelling).
 */
const PLAIN = new Map(("ß ss|ẞ ss|æ ae|œ oe|ø o|ł l|đ d|ð d|þ th|ı i|ħ h|ŧ t|ŋ n|ĸ k").split("|").map(pair => pair.split(" ") as [string, string]));
/** Scripts whose accents are marks a reader drops without losing the letter; in other scripts a mark is part of it. */
const ACCENTED = /[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}]/u;
const MARK = /\p{M}/u;

/**
 * Lower case; ligatures and full-width letters as their plain letters; accents taken off letters of the Latin, Greek and
 * Cyrillic scripts only (the vowel signs of other scripts stay); and the few letters above written plainly.
 */
export function fold(text: string): string {
  let out = "", base = "";
  for (const ch of text.toLowerCase().normalize("NFKD")) {
    if (MARK.test(ch)) { if (!ACCENTED.test(base)) out += ch; continue; }
    base = ch;
    out += PLAIN.get(ch) ?? ch;
  }
  // Put back together what decomposing split apart and is still there (Hangul syllables, other scripts' signs).
  return out.normalize("NFC");
}

/** The longest word compared, so a pasted run of letters costs no more than a long name. */
const LONGEST = 64;
/** Apostrophes join a word ("O'Brien" is "obrien"); anything else that isn't a letter or digit separates words. */
const APOSTROPHES = /['’ʼ`]/gu;
const SEPARATORS = /[^\p{L}\p{M}\p{N}]+/u;

/** The words of what was typed, folded. */
export function typedWords(text: string): string[] {
  return fold(text).replace(APOSTROPHES, "").split(SEPARATORS).filter(Boolean).map(w => w.slice(0, LONGEST));
}

/**
 * The words of an item, folded: each part, and a part joined to its neighbours where only a hyphen, dot or slash
 * separated them, so "Mary-Jane" is found by "mary", "jane" and "maryjane".
 */
export function itemWords(text: string): string[] {
  const out: string[] = [];
  for (const chunk of fold(text).replace(APOSTROPHES, "").split(/\s+/u)) {
    const parts = chunk.split(SEPARATORS).filter(Boolean).map(w => w.slice(0, LONGEST));
    out.push(...parts);
    if (parts.length > 1) out.push(parts.join("").slice(0, LONGEST));
  }
  return out;
}

/** Five letters or more may have one letter wrong. */
export const FORGIVING_FROM = 5;

/**
 * Whether `typed` is within one edit of the start of `word`: one letter changed, missing or extra, or two neighbours
 * swapped. The edit distance from `typed` to the closest start of `word`, computed row by row and stopped early.
 */
function nearStart(typed: string, word: string): boolean {
  const a = [...typed], b = [...word];
  const n = a.length, m = Math.min(b.length, n + 1);
  // rows[i][j]: edits from a[0..i) to b[0..j). Three rows kept for the swap of neighbours.
  let before: number[] = [], last: number[] = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const row = [i];
    for (let j = 1; j <= m; j++) {
      let cost = Math.min(last[j]! + 1, row[j - 1]! + 1, last[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cost = Math.min(cost, before[j - 2]! + 1);
      row.push(cost);
    }
    if (Math.min(...row) > 1) return false;
    before = last; last = row;
  }
  // The typed word against any start of the item's word: its whole length, one letter shorter or one longer.
  return Math.min(...last.slice(Math.max(0, n - 1))) <= 1;
}

/** How a typed word meets one item word: 2 a clean start, 1 a start with one letter off, 0 not at all. */
export function wordMatch(typed: string, word: string): 0 | 1 | 2 {
  if (word.startsWith(typed)) return 2;
  return [...typed].length >= FORGIVING_FROM && nearStart(typed, word) ? 1 : 0;
}

/** Something that can be found: its title (what the row shows first) and its other words. */
export interface Matchable { title: string; other?: readonly string[] | undefined }
/** An item with its words folded once, when Find opens, never again for each key pressed. */
export interface Prepared<T> { item: T; title: readonly string[]; other: readonly string[] }
export const prepare = <T extends Matchable>(item: T): Prepared<T> => ({ item, title: itemWords(item.title), other: (item.other ?? []).flatMap(itemWords) });

/**
 * How well `item` matches the typed words, lower first: 0 every word clean in the title, 1 in the title with a letter
 * off, 2 clean but partly in its other words, 3 partly in its other words with a letter off. Null: some typed word
 * matches nothing, or nothing was typed.
 */
export function matchTier(words: readonly string[], item: Matchable | Prepared<unknown>): 0 | 1 | 2 | 3 | null {
  if (!words.length) return null;
  const { title, other } = "item" in item ? item : prepare(item);
  let inTitle = true, clean = true;
  for (const typed of words) {
    const best = (list: readonly string[]) => list.reduce<0 | 1 | 2>((b, w) => b === 2 ? 2 : Math.max(b, wordMatch(typed, w)) as 0 | 1 | 2, 0);
    // The title first, even with a letter off: where a word matched counts for more than how cleanly.
    const t = best(title);
    if (t === 2) continue;
    if (t === 1) { clean = false; continue; }
    const o = best(other);
    if (o === 0) return null;
    inTitle = false;
    if (o === 1) clean = false;
  }
  return inTitle ? (clean ? 0 : 1) : (clean ? 2 : 3);
}

/**
 * The items that match `typed`, best first and otherwise in the order given. `keepOrder`: matches only, in the order
 * given whatever their tier (a list of people is never reordered by how well a name matched).
 */
export function matching<T extends Matchable>(typed: string, items: readonly T[], keepOrder = false): T[] {
  return matchesOf(typed, items.map(prepare), keepOrder).map(f => f.item);
}
/** The same over prepared items, each with how well it matched (matchTier). */
export function matchesOf<T>(typed: string, items: readonly Prepared<T>[], keepOrder = false): { item: T; tier: 0 | 1 | 2 | 3 }[] {
  const words = typedWords(typed);
  const found = items.flatMap((p, at) => { const tier = matchTier(words, p); return tier === null ? [] : [{ item: p.item, at, tier }]; });
  if (!keepOrder) found.sort((x, y) => x.tier - y.tier || x.at - y.at);
  return found.map(({ item, tier }) => ({ item, tier }));
}
