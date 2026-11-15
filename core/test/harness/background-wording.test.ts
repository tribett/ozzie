// Background-check wording (owner decision 2026-11-14; review Q H2, reviews B and B2): the one list in
// fixed/background-wording.json, as the page reads it. The same vectors run natively (core/native-auth/src/background.rs)
// and on ozzie.church (web/test/hosted-parity.test.ts), so the three refusals can't drift apart. Ozzie's own pinned words
// and every tool result over every fixture must hold none of it, or the native and hosted checks would refuse ordinary
// work. At run time only Ozzie's one own sentence is set aside, and only as a whole string.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ASK_SYSTEM, hiddenInQuestion, mentionsBackgroundCheck } from "../../src/ask.js";
import { acceptModelReply, buildRewordRequest, hiddenInNote, REWORDINGS, templateDraft, type Rewording } from "../../src/draft-request.js";
import {
  ALSO_OTHER_THINGS, BACKGROUND_PHRASES, backgroundInToolResult, backgroundWording, namesACheck, newerCharacter, OZZIES_OWN, wordingTokens,
  type Folding,
} from "../../src/harness/background-wording.js";
import { bundledSkills } from "../../src/harness/bundled-skills.js";
import { POLICY, PROCEDURE_PROMPT, systemText, TOOL_SPEC_LIST, VOCABULARY } from "../../src/harness/fixed.js";
import { allEnvelopes, FIXTURES, harnessData } from "./fixtures.js";

interface Vectors {
  match: string[]; refused_on_purpose: string[]; pass: string[]; known_misses: string[]; hidden: string[]; tool_match: string[];
  tool_pass: string[]; tokens: [string, Folding, string[]][];
}
const vectors = JSON.parse(readFileSync(new URL("./background-wording-vectors.json", import.meta.url), "utf8")) as Vectors;
const listFile = JSON.parse(readFileSync(new URL("../../src/harness/fixed/background-wording.json", import.meta.url), "utf8")) as {
  phrases: string[]; ozzies_own: string[]; newer_unicode: { removed: string[]; letters: Record<string, string> };
};
const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const skills = await bundledSkills();
/**
 * The two out-of-date sentences in Ozzie's pinned texts (the refresh tool's spec, the sunday-ready procedure). Pinned texts
 * are compared byte for byte, never scanned, so these are set aside here, in the test, and nowhere at run time.
 */
const PINNED_OUT_OF_DATE = [
  "Use it at most once, and only when the last check is out of date.",
  "If the last check is out of date and Planning Center can be checked again, check again first.",
];
const pinnedText = (text: string) => PINNED_OUT_OF_DATE.reduce((rest, s) => rest.split(s).join(" "), text);

describe("the background-check wording list (shared vectors)", () => {
  it("is the file's list, and the page's own check reads it", () => {
    expect(BACKGROUND_PHRASES).toEqual(listFile.phrases);
    expect(OZZIES_OWN).toEqual(listFile.ozzies_own);
    expect(BACKGROUND_PHRASES.length).toBeGreaterThan(20);
    // No phrase sets anything aside by its neighbours: every slot is words (review B H1).
    for (const phrase of BACKGROUND_PHRASES) expect(phrase, phrase).toMatch(/^[a-z0-9*|]+(?: [a-z0-9*|]+)*$/u);
    for (const q of ["clearance", "screened", "screening", "DBS", "safeguarding check", "fingerprinted", "cleared to serve", "vetted", "criminal record"]) {
      expect(mentionsBackgroundCheck(q), q).toBe(true);
    }
  });
  it("splits text into the same words on every side, under each folding", () => {
    for (const [text, folding, tokens] of vectors.tokens) expect(wordingTokens(text, folding), `${JSON.stringify(text)} ${folding}`).toEqual(tokens);
  });
  it("finds background-check wording through case, possessives, punctuation, look-alike forms, invisible characters inside or between words", () => {
    for (const text of vectors.match) expect(backgroundWording(text), JSON.stringify(text)).toBe(true);
  });
  it("refuses ordinary text that reads exactly like a background-check question, as v0.1.0 did", () => {
    for (const text of vectors.refused_on_purpose) expect(backgroundWording(text), JSON.stringify(text)).toBe(true);
  });
  it("leaves ordinary Sunday words alone: the screen team, check-in, a cleared room, Ozzie's own sentence as a whole", () => {
    for (const text of vectors.pass) expect(backgroundWording(text), JSON.stringify(text)).toBe(false);
  });
  it("keeps its limits written down: look-alike letters from other scripts, spaced or digit spellings and paraphrases aren't caught", () => {
    for (const text of vectors.known_misses) expect(backgroundWording(text), JSON.stringify(text)).toBe(false);
  });
  it("refuses, as holding a hidden character, a question whose invisible or newer characters spell the wording past every folding (review B3 L-1)", () => {
    expect(vectors.hidden.length).toBeGreaterThan(180);
    // Each needs deleting at one point and a word break at another, which no folding does, so no folding reads it; the
    // question rule refuses it whole, as typed and as cleaning leaves it (askOzzie, harness-bridge.test.ts).
    for (const text of vectors.hidden) {
      expect(backgroundWording(text), JSON.stringify(text)).toBe(false);
      expect(hiddenInQuestion(text), JSON.stringify(text)).toBe(true);
    }
    // Every newer character, letters included, is one no question, note or position name may hold.
    for (const hex of [...listFile.newer_unicode.removed, ...Object.keys(listFile.newer_unicode.letters)]) {
      const c = String.fromCodePoint(parseInt(hex, 16));
      expect(newerCharacter(c), hex).toBe(true);
      expect(hiddenInQuestion(`Who is on the Gre${c}eter team?`), hex).toBe(true);
      expect(hiddenInNote(`Hi [Volunteer A], could you help as Gre${c}eter?`), hex).toBe(true);
    }
    // Ordinary text holds none: accents, other scripts, emoji.
    for (const text of ["Who can cover Greeter?", "Café crew", "Zoë and Łukasz", "日曜日のチーム", "Coffee ☕ Team", "🙂"]) {
      expect(hiddenInQuestion(text), text).toBe(false);
      expect([...text].some(newerCharacter), text).toBe(false);
    }
  });
  it("reads a tool result one string at a time, so a key and a neighbouring value never join into a phrase", () => {
    for (const text of vectors.tool_match) expect(backgroundInToolResult(text), text).toBe(true);
    for (const text of vectors.tool_pass) expect(backgroundInToolResult(text), text).toBe(false);
    // Whole, the first would read "records check time".
    expect(backgroundWording(vectors.tool_pass[0]!)).toBe(true);
  });
});

describe("which stopped questions the page answers (reviews B2 L-3, B3 L-2, B3 N-2); it never decides what is sent", () => {
  it("sets aside only phrases of the list itself, which still refuse", () => {
    expect(ALSO_OTHER_THINGS.length).toBeGreaterThan(0);
    for (const phrase of ALSO_OTHER_THINGS) expect(BACKGROUND_PHRASES, phrase).toContain(phrase);
  });
  it("finds a check named in a question, and not one that only names a team, a policy, a craft or a print job", () => {
    for (const q of ["Any background check problems?", "Is Riley cleared to teach?", "Has Cameron been screened?", "Does Blake have a DBS?",
      "Is this check out of date?", "Who will run the bg-check table?", "Is Blake a registered sex offender? Has his background check come back?"]) {
      expect(namesACheck(q), q).toBe(true);
    }
    for (const q of ["Who is on the Safe Sanctuaries team?", "Is there a sex offender policy for Sunday?", "Where is our registered offender policy?",
      "Who is leading the finger print art craft?", "Has the background come back from the printer?", "Is the offender registry open on Sunday?"]) {
      expect(namesACheck(q), q).toBe(false);
      expect(backgroundWording(q), q).toBe(true);
    }
    expect(namesACheck(OZZIES_OWN[0]!)).toBe(false);
  });
});

describe("Ozzie's own sentence is the only thing set aside, and only as a whole string (review B2 L-1)", () => {
  it("is a whole string of a tool result, and any other text holding it is refused", () => {
    expect(OZZIES_OWN).toEqual(["Rooms, follow-ups and group meetings: this check is out of date, so they aren't shown."]);
    for (const sentence of OZZIES_OWN) {
      expect(source("src/operations-capture.ts").includes(`"${sentence}"`), sentence).toBe(true);
      expect(backgroundWording(sentence), sentence).toBe(false);
      for (const text of [sentence.toLowerCase(), ` ${sentence}`, `${sentence} `, `police ${sentence}`, `${sentence} Her check expired.`, sentence.slice(0, -1)]) {
        expect(backgroundWording(text), JSON.stringify(text)).toBe(true);
      }
    }
  });
  it("the two pinned out-of-date sentences are in Ozzie's pinned texts and are refused anywhere they are scanned", () => {
    const pinned = [source("src/harness/fixed/tool-specs.json"), ...[...skills.values()].map(systemText)];
    for (const sentence of PINNED_OUT_OF_DATE) {
      expect(pinned.some(text => text.includes(sentence)), sentence).toBe(true);
      expect(backgroundWording(sentence), sentence).toBe(true);
    }
  });
});

describe("nothing Ozzie itself sends to a model holds the wording, so scanning what varies never refuses ordinary work", () => {
  it("not the policy, any procedure's system message, any tool spec, the procedure prompt or a fixed value", () => {
    expect(backgroundWording(POLICY)).toBe(false);
    expect(skills.size).toBeGreaterThan(5);
    for (const skill of skills.values()) expect(backgroundWording(pinnedText(systemText(skill))), skill.id).toBe(false);
    for (const spec of TOOL_SPEC_LIST) expect(backgroundWording(pinnedText(JSON.stringify(spec))), spec.name).toBe(false);
    expect(backgroundWording(PROCEDURE_PROMPT)).toBe(false);
    for (const value of VOCABULARY.values) expect(backgroundWording(value), value).toBe(false);
    // A tool sentence is words from this list in any order; none is wording on its own.
    for (const word of VOCABULARY.sentence_words) expect(backgroundWording(word), word).toBe(false);
  });
  it("not the Ask legend, the rewording instructions or Ozzie's own note", () => {
    expect(backgroundWording(ASK_SYSTEM)).toBe(false);
    const data = harnessData();
    const finding = data.brief!.findings.find(f => f.kind === "needs-people")!;
    const draft = templateDraft({ finding, person_id: Object.keys(data.capture!.names)[0]!, sunday: data.brief!.plan.date }, data.capture!.names);
    expect(backgroundWording(draft.text)).toBe(false);
    for (const choice of Object.keys(REWORDINGS) as Rewording[]) {
      const request = buildRewordRequest(draft, choice, data.capture!.names);
      expect(backgroundWording(request.system), choice).toBe(false);
      expect(backgroundWording(request.user), choice).toBe(false);
    }
  });
  it("sends a position named with the wording, or with a hidden character, as [Role], so its note can still be reworded (reviews B L4, B2 M-1)", () => {
    const data = harnessData();
    const finding = data.brief!.findings.find(f => f.kind === "needs-people" && f.position)!;
    const draftFor = (name: string) => templateDraft({ finding: { ...finding, position: { ...finding.position!, name } },
      person_id: Object.keys(data.capture!.names)[0]!, sunday: data.brief!.plan.date }, data.capture!.names);
    for (const name of ["Security Screening", "Background Check Desk", "Safeguarding Lead", "DBSㅤTeam", "Security⠀Screening", "Greeter⠀Team", "Greeter​Team"]) {
      const draft = draftFor(name);
      expect(draft.role, JSON.stringify(name)).toEqual({ sent: "[Role]", original: name });
      expect(backgroundWording(buildRewordRequest(draft, "warmer", data.capture!.names).user), name).toBe(false);
    }
    // An ordinary, accented or emoji name still goes as written.
    for (const name of ["Greeter", "Café Team", "Coffee ☕ Team"]) expect(draftFor(name).role.sent, name).toBe(name);
    // A name holding one of the list's newer characters, or named exactly as Ozzie's own sentence, which holds the wording
    // once it is inside a note, goes as [Role] too (reviews B3 L-1, B3 N-1).
    for (const name of ["Gre\u05C8eter", "Gree\u209Dter", ...OZZIES_OWN]) {
      const draft = draftFor(name);
      expect(draft.role, JSON.stringify(name)).toEqual({ sent: "[Role]", original: name });
      const user = buildRewordRequest(draft, "warmer", data.capture!.names).user;
      expect(backgroundWording(user), name).toBe(false);
      expect(hiddenInNote(user), name).toBe(false);
    }
  });
  it("keeps a reworded note in a form the next reword accepts: line endings and tabs as a note spells them (review B3 L-3)", () => {
    const data = harnessData();
    const names = data.capture!.names;
    const finding = data.brief!.findings.find(f => f.kind === "needs-people" && f.position)!;
    const first = templateDraft({ finding, person_id: Object.keys(names)[0]!, sunday: data.brief!.plan.date }, names);
    const replies = [
      "Hi [Volunteer A],\r\n\r\nCould you help as [Role] on Sunday? It's fine to say no.\r\n\r\nThanks,\r\n[Your name]",
      "\tHi [Volunteer A],\rCould you help as [Role] on Sunday?\tNo pressure at all.\n[Your name]",
    ];
    for (const reply of replies) {
      let draft = acceptModelReply(reply, first, names);
      expect(draft.text, JSON.stringify(reply)).not.toMatch(/[\r\t]/u);
      // Reworded again and again, each request holds nothing the native and ozzie.church checks refuse before sending.
      for (const choice of Object.keys(REWORDINGS) as Rewording[]) {
        const user = buildRewordRequest(draft, choice, names).user;
        const note = user.slice(user.indexOf("Note:\n") + "Note:\n".length);
        expect(hiddenInNote(note), `${JSON.stringify(reply)} ${choice}`).toBe(false);
        expect(backgroundWording(note), `${JSON.stringify(reply)} ${choice}`).toBe(false);
        draft = acceptModelReply(`${draft.text}\r\n`, draft, names);
      }
    }
    // A reply holding what the next reword would refuse is never kept, so it is never shown.
    for (const reply of ["Hi [Volunteer A],\u2028could you help as [Role]?", "Hi [Volunteer A], could you help as Gre\u2800eter?",
      "Hi [Volunteer A], could you help as [Role]? Gre\u05C8eter", "Hi [Volunteer A], is your background check current?"]) {
      expect(() => acceptModelReply(reply, first, names), JSON.stringify(reply)).toThrow("The reworded draft wasn't usable. Your current draft is unchanged.");
    }
    // An emoji the model adds is fine.
    expect(acceptModelReply("Hi [Volunteer A], could you help as [Role]? 🙏🏽 ❤️", first, names).text).toContain("❤️");
  });
  it("not any result of any tool over any fixture, out-of-date checks and kids teams included, string by string", async () => {
    let stale = 0;
    for (const [label, make] of FIXTURES) {
      for (const envelope of await allEnvelopes(make())) {
        const text = JSON.stringify(envelope);
        if (text.includes("this check is out of date")) stale += 1;
        expect(backgroundInToolResult(text), `${label}: ${envelope.tool}`).toBe(false);
      }
    }
    // Ozzie's own "this check is out of date" line reached a tool result, as a whole string, and was set aside.
    expect(stale).toBeGreaterThan(0);
  });
});
