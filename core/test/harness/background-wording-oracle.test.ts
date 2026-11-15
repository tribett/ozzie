// The oracle for background-check wording (reviews B and B2): the page regex the shared list replaced, verbatim as it
// stood in core/src/ask.ts in v0.1.0 over that version's fold, runs on a broad corpus, and the list must refuse
// everything it refused, apart from Ozzie's one own sentence as a whole string. The corpus has possessives, "is the check
// in", last and latest checks, invisible and ignorable characters between and inside words, characters newer than the
// page's Unicode data, and Ozzie's three out-of-date sentences inside other text. Its verdicts are pinned by a digest
// that the native check (background.rs) and ozzie.church (hosted-parity.test.ts) must reach too.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fold } from "../../src/draft-request.js";
import { backgroundWording, OZZIES_OWN } from "../../src/harness/background-wording.js";

/** BACKGROUND_WORDING from core/src/ask.ts in v0.1.0, unchanged; it read the page's fold (draft-request.ts `fold`, unchanged). */
const OLD_PAGE_REGEX = new RegExp([
  "\\bbackground[\\s-]*(?:checks?|checked|checking|screen\\w*|clearances?|vett\\w*)",
  "\\bbg\\s+checks?\\b", "\\bclearances?\\b", "\\b(?:un|not\\s+(?:yet\\s+)?|never\\s+)cleared\\b",
  "\\bcleared\\s+(?:to|for)\\s+(?:serve|serving|work|working|volunteer\\w*|help\\w*|be\\s+with|kids|children|the\\s+nursery|nursery|childcare)",
  "\\bscreened\\b", "\\bscreenings?\\b", "\\b(?:dbs|crb|pvg|wwcc)\\b", "\\bsafeguarding\\b", "\\bvett(?:ed|ing)\\b", "\\bfingerprint\\w*",
  "\\bcriminal\\s+(?:records?|history|background|checks?)", "\\b(?:police|record|records|disclosure|sex\\s+offender\\w*)\\s+checks?\\b",
  "\\bworking\\s+with\\s+(?:children|kids|vulnerable)\\s+checks?\\b",
  "\\b(?:checks?|certificates?|clearances?)\\s+(?:has\\s+|have\\s+|had\\s+|is\\s+|was\\s+|are\\s+|were\\s+)?(?:expir\\w*|lapsed|out\\s+of\\s+date|run\\s+out|overdue)",
].join("|"), "u");
const oldRefuses = (text: string) => OLD_PAGE_REGEX.test(fold(text));

interface Oracle {
  prefixes: string[]; words: string[]; suffixes: string[]; subjects: string[]; verbs: string[]; tails: string[];
  separators: string[]; sentences: string[]; affixes: string[]; rows: string[]; allowlist: string[]; digest: string;
}
const oracle = JSON.parse(readFileSync(new URL("./background-wording-oracle.json", import.meta.url), "utf8")) as Oracle;
const vectors = JSON.parse(readFileSync(new URL("./background-wording-vectors.json", import.meta.url), "utf8")) as Record<string, unknown>;

/** The corpus, built the same way on every side (the fixture's `about`). */
function oracleCorpus(o: Oracle): string[] {
  const generated: string[] = [];
  for (const p of o.prefixes) for (const w of o.words) for (const s of o.suffixes) generated.push(p + w + s);
  for (const p of o.prefixes) for (const subject of o.subjects) for (const verb of o.verbs) for (const tail of o.tails) {
    generated.push(`${p}${subject} ${verb ? `${verb} ` : ""}${tail}`);
  }
  const separated: string[] = [];
  for (const j of o.separators) for (const w of o.words) separated.push(w.split(" ").join(j) + j + "renewal", w.slice(0, 1) + j + w.slice(1));
  const embedded: string[] = [];
  for (const s of o.sentences) for (const a of o.affixes) embedded.push(a + s, s + a, a + s + a);
  return [...generated, ...generated.map(t => t.toUpperCase()), ...separated, ...embedded, ...o.rows];
}
const corpus = oracleCorpus(oracle);
const digestOf = (texts: readonly string[], refuses: (t: string) => boolean) =>
  createHash("sha256").update(texts.map(t => `${refuses(t) ? "1" : "0"} ${t}\n`).join(""), "utf8").digest("hex");

describe("the shared list refuses at least everything the page's earlier regex refused, on the oracle corpus (reviews B, B2)", () => {
  it("over the whole corpus and the shared vectors, apart from the allowlist", () => {
    const shared = [...corpus, ...(["match", "refused_on_purpose", "pass", "known_misses"] as const).flatMap(k => vectors[k] as string[])];
    const oldRefused = shared.filter(oldRefuses);
    expect(corpus.length).toBeGreaterThan(35_000);
    expect(oldRefused.length).toBeGreaterThan(30_000);
    const missed = [...new Set(oldRefused.filter(t => !backgroundWording(t)))].sort();
    expect(missed).toEqual([...oracle.allowlist].sort());
  });
  it("whose one entry is Ozzie's own sentence, exactly as written and whole; inside any other text it is refused", () => {
    expect([...oracle.allowlist].sort()).toEqual([...OZZIES_OWN].sort());
    for (const sentence of oracle.allowlist) {
      expect(oldRefuses(sentence) && !backgroundWording(sentence), sentence).toBe(true);
      for (const affix of oracle.affixes) {
        for (const text of [affix + sentence, sentence + affix, affix + sentence + affix]) expect(backgroundWording(text), JSON.stringify(text)).toBe(true);
      }
    }
  });
  it("names the reviews' regressions in the corpus: possessives, \"is the check in\", last or latest checks, invisible blanks, embedded sentences", () => {
    for (const text of ["Is Blake's BG check in?", "Has Blake's DBS's renewal come back?", "Has Blake’s DBS’s renewal come back?", "Blake's last check expired",
      "his latest check is overdue for nursery", "BG check in?", "police check in March", "x'dbs", "o'clearance", "Blake's vetting's", "Blake's safeguarding's",
      "Blake's DBSㅤrenewal?", "Is Blake's DBS⠀done?", "Has Blake been screenedᅟyet?", "Is Blake's DBS\u{E0080}done?", "DBSㅤTeam", "Security⠀Screening",
      "police Use it at most once, and only when the last check is out of date.", "dbsㅤrenewal", "d​bs"]) {
      expect(corpus.includes(text) || corpus.some(t => t.toLowerCase() === text.toLowerCase()), JSON.stringify(text)).toBe(true);
      expect(backgroundWording(text), JSON.stringify(text)).toBe(true);
    }
  });
  it("gives verdicts the native check and ozzie.church must reach too (the pinned digest)", () => {
    expect(digestOf(corpus, backgroundWording), "the list changed: put this digest in background-wording-oracle.json").toBe(oracle.digest);
  });
});
