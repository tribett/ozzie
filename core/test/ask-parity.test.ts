// The webview half of core/test/ask-parity.json. The native half runs the same vectors
// (core/native-auth/src/name_guard.rs and model_tests.rs), so the two boundaries can't drift apart.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { askNameTerms, AskSession, buildAskContext, containsNameWord, hasContactDetail, prepareAsk } from "../src/ask.js";
import { fold, nameTerms } from "../src/draft-request.js";
import { buildSundayBrief } from "../src/sunday-brief.js";
import { nov22Capture } from "../src/fictional-sunday.js";

interface Parity {
  fold: [string, string][];
  terms: { name: string; reword: string[]; ask: string[] }[];
  roster: string[];
  names: { found: string[]; notFound: string[] };
  contact: { found: string[]; notFound: string[] };
  questionLines: string[];
}
const parity = JSON.parse(readFileSync(new URL("./ask-parity.json", import.meta.url), "utf8")) as Parity;
const roster = Object.fromEntries(parity.roster.map((name, i) => [String(i + 1), name]));
const contact = (text: string) => hasContactDetail(text) || hasContactDetail(text.normalize("NFKC"));

describe("Ask parity vectors (shared with the native guard)", () => {
  it("fold stroked letters, ligatures and final sigma the same way", () => {
    for (const [input, folded] of parity.fold) expect(fold(input), input).toBe(folded);
  });
  it("make the same name terms: rewording's, and Ask's with joined runs of parts", () => {
    for (const { name, reword, ask } of parity.terms) {
      expect([...nameTerms({ "1": name })].sort(), name).toEqual(reword);
      expect(askNameTerms(name).sort(), name).toEqual(ask);
    }
  });
  it("find roster names as whole words, spelled out and beside unspaced scripts", () => {
    for (const text of parity.names.found) expect(containsNameWord(text, roster), text).toBe(true);
    for (const text of parity.names.notFound) expect(containsNameWord(text, roster), text).toBe(false);
  });
  it("find email addresses and phone numbers in any digits and separators, but not dates and times", () => {
    for (const text of parity.contact.found) expect(contact(text), text).toBe(true);
    for (const text of parity.contact.notFound) expect(contact(text), text).toBe(false);
  });
  it("never send a line break or control character in the question, which the native route refuses", () => {
    const capture = nov22Capture();
    const brief = buildSundayBrief(capture, { sundayLeads: [], checkInAfterSundaysInARow: 3 }, capture.completed_at, true);
    for (const typed of parity.questionLines) {
      const session = new AskSession();
      const context = buildAskContext(session, { brief, names: capture.names, organization: capture.organization }, { timeZone: "America/New_York" })!;
      const prepared = prepareAsk(session, context, typed);
      expect(prepared.ok, typed).toBe(true);
      if (!prepared.ok) continue;
      expect(prepared.asked.sent, typed).not.toMatch(/[\p{Cc}\p{Cf}\p{Co}\p{Zl}\p{Zp}]/u);
      expect(prepared.asked.request.user.split(/\r\n|[\n\r\u2028\u2029\u0085]/u).at(-1), typed).toBe(`Q | ${prepared.asked.sent}`);
    }
  });
});
