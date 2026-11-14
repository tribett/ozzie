// Regressions from the reviews of 2026-11-14 (B1, B-S4 and section C).
// Since structured answers (section C's decision) the model's final reply is only a choice of fact ids, so every
// answer the reviews found slipping past the old prose checks is refused outright as not the answer form, however it
// is worded or broken across lines; and the answers the old checks wrongly refused are now Ozzie's own sentences
// (compose.test.ts), which the old detectors find nothing in.
import { describe, expect, it } from "vitest";
import { CHARACTER, CLAIMS, NEAR_PERSON, RANKED, RELIGIOUS_REPLY, TEAM_MEMBER } from "../../src/ask.js";
import { fold, NOT_OURS } from "../../src/draft-request.js";
import type { ToolEnvelope } from "../../src/harness/contract.js";
import { composeAnswer, NOT_FREE, NOT_RANKED } from "../../src/harness/compose.js";
import { verifyAnswer } from "../../src/harness/verify.js";
import { allEnvelopes, FIXTURES } from "./fixtures.js";

const env = (tool: string, payload: unknown): ToolEnvelope => ({ tool, source: "Planning Center Services", check_time: "2026-11-20T15:00:00Z", completeness: "complete", payload });
/** The reviewer's evidence, with fact ids: one role, two people, one remaining. */
const REVIEW_EVIDENCE = [env("sunday.who_could_help", { fact: "f1", asked_for: { role: "[Role 1]" }, times: [{ fact: "f2", role: "[Role 1]", remaining: 1 }],
  people: [{ fact: "f3", role: "[Role 1]", person: "[Person 1]", status: "no overlap found" }, { fact: "f4", role: "[Role 1]", person: "[Person 2]", status: "possible conflict" }] })];

/** The end-to-end review's paraphrases (C2) and the answer-side usability list, which the prose checks got wrong both ways. */
const C2: [string, string][] = [
  ...["The conflict has been resolved.", "Handled.", "The note was dispatched to [Person 1].", "A reminder is queued for [Person 1].", "The note went to [Person 1].", "Sent!",
    "I can send this note to [Person 1].", "Want me to send it?", "Shall I text [Person 1]?", "I can update Planning Center for you."].map(a => ["C2 claims", a] as [string, string]),
  ...["[Person 1] is likely to say yes.", "[Person 1] agreed to cover [Role 1].", "[Person 1] said yes last time.", "[Person 1] won't mind.", "[Person 1] is clear on Sunday.",
    "[Person 1] isn't busy.", "[Person 1] has a free morning.", "Nothing is stopping [Person 1]."].map(a => ["C2 willingness", a] as [string, string]),
  ...["I'd lean toward [Person 1].", "If I were you, I'd ask [Person 1].", "Consider asking [Person 1].", "[Person 1] is the obvious one.",
    "1. [Person 1]\n2. [Person 2]\nTry them in that order.", "Here they are in order of fit: [Person 1], [Person 2]."].map(a => ["C2 ranking", a] as [string, string]),
  ...["[Person 2] is pulling away from the team.", "[Person 2] needs a break.", "[Person 2] might be tired.", "[Person 2] is in a busy season of life.",
    "[Person 2] is having a hard time lately."].map(a => ["C2 describing", a] as [string, string]),
  ...["[Role 1] needs 3 more.", "[Role 1] needs three more.", "It's on November 11.", "It starts at 10:30."].map(a => ["C2 numbers", a] as [string, string]),
  ...["[Riley] hasn't accepted the request yet.", "Hi Cameron, please don't let us down!"].map(a => ["C1/C3 attribution and drafts", a] as [string, string]),
  ...["Happy to help!", "I can help you draft a note if you'd like.", "I can't tell from what I read whether [Person 1] is free.", "Nobody on the team is free.",
    "First, [Person 1]. Second, [Person 2].", "No messages were sent.", "No volunteers have been contacted."].map(a => ["C usability (answer side)", a] as [string, string]),
];
const BYPASSES: [source: string, answer: string][] = [
  // review B1: willingness and availability (contract §5)
  ...["[Person 1] is free on Sunday and happy to help.", "[Person 1] is available, so [Role 1] is covered.", "[Person 1] would probably say yes.",
    "[Person 1] should be able to cover [Role 1].", "[Person 1] can cover [Role 1].", "[Person 1] might be available."].map(a => ["B1 availability", a] as [string, string]),
  // review B1: picking or ordering people
  ...["I'd recommend [Person 1] for [Role 1].", "I'd go with [Person 1].", "[Person 1] would be my pick.", "1st: [Person 1]. 2nd: [Person 2].",
    "#1 [Person 1], #2 [Person 2].", "[Person 1] before [Person 2].", "[Person 1], followed by [Person 2].", "Ask [Person 1]; if they say no, ask [Person 2] next.",
    "[Person 1] is a safer bet than [Person 2].", "[Person 1] is the most experienced on the team.", "[Person 1] has served the longest, so they're the natural choice.",
  ].map(a => ["B1 ranking", a] as [string, string]),
  // review B1: describing a person
  ...["[Person 2] tends to flake and seems worn out lately.", "[Person 2] is going through a hard time and is overwhelmed."].map(a => ["B1 describing", a] as [string, string]),
  // review B1: claims of sending or changing
  ...["[Person 1] has been notified and added to the schedule.", "Sent to [Person 1].", "All done. [Person 1] is now on the schedule.", "I let [Person 1] know.",
    "I followed up with [Person 1].", "I've reserved [Room 1] for you.", "I've approved the booking and resolved the conflict.", "I took care of it.",
    "Your note to [Person 1] is on its way."].map(a => ["B1 claims", a] as [string, string]),
  // review B1: religious content
  ...["Be strong and courageous, [Person 1]!", "I can do all things through Him who strengthens me.", "Philippians 4.13 fits here.", "Hallelujah, [Role 1] is covered!",
    "We're lifting [Person 2] up this week.", "Grace and peace to you."].map(a => ["B1 religious", a] as [string, string]),
  // review B1: numbers and times the evidence doesn't hold (it says 1 remaining)
  ...["[Role 1] still needs 5 more people, and 3 people have no overlap found.", "[Role 1] is at 11:00 AM on December 6.", "[Role 1] is at 2026-12-06T11:00-05:00."]
    .map(a => ["B1 numbers", a] as [string, string]),
  // security note 1: a denial or negation earlier in the sentence launders a later claim
  ...["No doubt I've sent the note to [Person 1].", "No worries, I've sent the note to [Person 1].", "Never mind: [Person 1] is free.",
    "Not only is [Person 1] free, they're happy to help.", "Nothing to worry about, I scheduled [Person 1].",
    "Nothing says otherwise, and [Person 1] is free and willing to help.", "Nothing says otherwise and [Person 1] is free.",
    "No changes yet but [Person 1] would say yes.", "Not ranked — [Person 1] is the best fit.", "Not ranked -- [Person 1] is the best fit.",
    "Not ranked - [Person 1] is the best fit.", "It doesn't mean much, but [Person 1] is available.", "That doesn't mean anything; [Person 1] can cover [Role 1].",
    "This doesn't mean [Role 1] is short and [Person 1] is free.", "No one else is free, so [Person 1] is free.", "No other volunteer is the best fit like [Person 1].",
    "Not surprisingly [Person 1] is available.", "If anything, [Person 1] is free.", "Who knows, [Person 1] would say yes.",
    "Nobody minds and I've sent the note.", "Never a problem — I've reserved [Room 1]."].map(a => ["security 1: laundering", a] as [string, string]),
  // security note 2: idioms, distant negators, relative and question words
  ...["No doubt [Person 1] is free to help.", "Not surprisingly, [Person 1] would say yes.", "No worries, [Person 1] is available.",
    "[Person 1], who is available, can help.", "Who is free: [Person 1].", "Someone who is willing: [Person 2].",
    "Ask whether they're free; [Person 1] is free.", "If [Person 1] can cover, great.", "[Person 1] isn't busy, so they're free.",
    "That doesn't mean they're free or willing — [Person 1] is free.", "Nothing has been changed, and I've sent the note.",
    "People are listed in no particular order, not ranked: [Person 1] is the best fit."].map(a => ["security 2: idioms and relatives", a] as [string, string]),
  // security note 3: an allowed clause turned around by the words around it
  ...["It's untrue that nothing has been sent.", "It is false that [Person 1] isn't ranked first.", "Wrong: nothing was changed — [Person 1] was added.",
    "Not that it doesn't mean [Person 1] is free or willing.", "Actually, nothing has been changed in Planning Center.",
    "Nothing has been sent, but I've emailed [Person 1].", "In fact no one has been contacted; [Person 1] was notified.",
    "They say it doesn't mean they're free or willing, though [Person 1] is free.", "[Person 1] was added to [Role 1]."]
    .map(a => ["security 3: reversed clauses", a] as [string, string]),
  // security note 4: a phrase split across a line break (each rule)
  ...["[Person 1] has been\nnotified.", "[Person 1] is the\nbest fit.", "[Person 2] is\nfree and willing.", "I let\n[Person 1] know.", "I let [Person 1]\nknow.",
    "[Person 1]\nbefore\n[Person 2].", "I'd go\nwith [Person 1].", "[Person 1] would be my\npick.", "[Person 2] seems\nburned out.", "[Person 2] tends to\nflake.",
    "[Person 1] should be able\nto cover [Role 1].", "[Role 1] still needs\n5 more people.", "[Role 1] is at 11:00\nAM.", "Here you go\nSent to [Person 1].",
    "It's untrue that\nnothing has been sent.", "It is false that\n[Person 1] isn't ranked first.", "Not that\nit doesn't mean [Person 1] is free or willing.",
    "Be strong and\ncourageous, [Person 1]!", "[Person 1] is a safer\nbet than [Person 2].", "Your note to [Person 1] is on its\nway."]
    .map(a => ["security 4: line breaks", a] as [string, string]),
  // security note 5: an allowed clause running across a line break swallowing a claim, and every kind of line break alike
  ...["It doesn't mean\n\n[Person 1] is free and willing.", "Nothing has been sent\nto anyone but [Person 1] was added.", "That doesn't mean\n[Person 1] is free or willing.",
    "It doesn't mean\r\n[Person 1] is free.", "It doesn't mean\u0085[Person 1] is free.", "It doesn't mean\v[Person 1] is free.", "It doesn't mean\f[Person 1] is free.",
    "It doesn't mean\u2029[Person 1] is free.", "[Person 1] has been\u0085notified.", "[Person 2] is\ffree and willing.", "I let\v[Person 1] know.", "[Person 1] is the\u2029best fit."]
    .map(a => ["security 5: clauses end at line breaks", a] as [string, string]),
  ...C2,
];
const BREAKS: [string, string][] = [["as written", ""], ["\\n", "\n"], ["\\r\\n", "\r\n"], ["blank lines", "\n\n\n"], ["\\u2028", "\u2028"], ["\\u2029", "\u2029"],
  ["\\u0085", "\u0085"], ["\\v", "\v"], ["\\f", "\f"], ["\\r", "\r"]];
/** Every space between words turned into `brk`, labels left whole. */
const split = (answer: string, brk: string) => brk ? answer.split(/(\[[^\]]*\])/u).map((part, i) => i % 2 ? part : part.replace(/ /gu, brk)).join("") : answer;

describe("every answer the reviews reported is refused: prose is never the answer form", () => {
  for (const [source, answer] of BYPASSES) {
    it(`${source}: ${JSON.stringify(answer)}`, () => {
      for (const [kind, brk] of BREAKS) {
        const variant = split(answer, brk);
        expect(verifyAnswer(variant, REVIEW_EVIDENCE), `${kind}: ${JSON.stringify(variant)}`).toEqual({ ok: false, code: "fidelity" });
      }
    });
  }
  it("covers each review list and security note", () => {
    expect(new Set(BYPASSES.map(([s]) => s.split(":")[0]!.split(" ")[0] === "security" ? s.split(":")[0] : s.split(" ")[0])))
      .toEqual(new Set(["B1", "security 1", "security 2", "security 3", "security 4", "security 5", "C2", "C1/C3", "C"]));
  });
  it("and an answer that only cites the right facts passes", () => {
    expect(verifyAnswer('{"answer":"facts","facts":["f3","f4"]}', REVIEW_EVIDENCE).ok).toBe(true);
  });
});

const FIXED_NEGATIONS = [NOT_FREE, NOT_RANKED, "Whether someone is willing to serve isn't something Planning Center records."];
describe("Ozzie's own sentences: what the old checks looked for is never in them", () => {
  it("over every fact every tool gives over every fixture, one at a time and all together", async () => {
    const marked = (t: string) => fold(t.replace(/\[(?:Person [1-9]\d{0,3}|a team member)\]/gu, " \u0001 ").replace(/\[[^\]]*\]/gu, " ")).replace(/\s+/gu, " ");
    const plain = (t: string) => fold(t.replace(/\[[^\]]*\]/gu, " ")).replace(/\s+/gu, " ");
    let checked = 0;
    for (const [name, make] of FIXTURES) {
      const evidence = await allEnvelopes(make());
      const ids = [...new Set(evidence.flatMap(e => [...JSON.stringify(e.payload).matchAll(/"fact":"(f\d+)"/gu)].map(m => m[1]!)))];
      for (const choice of [...ids.map(id => [id]), ids.slice(0, 12)]) {
        const composed = composeAnswer(JSON.stringify({ answer: "facts", facts: choice }), evidence);
        for (const paragraph of composed.paragraphs) {
          const where = `${name} ${choice.join(",")}: ${paragraph}`;
          // Ozzie's fixed sentences that say what isn't known or done (the old checks' allowed clauses) are set aside.
          const text = FIXED_NEGATIONS.reduce((t, n) => t.replace(n, ""), paragraph);
          expect(NOT_OURS.test(plain(text)) || RELIGIOUS_REPLY.test(plain(text)), where).toBe(false);
          expect(CLAIMS.test(plain(text)), where).toBe(false);
          expect(RANKED.test(plain(text)) || NEAR_PERSON.test(marked(text)), where).toBe(false);
          expect(CHARACTER.test(plain(text)), where).toBe(false);
          expect(/\b(?:free|willing|available|happy to|glad to|would say yes|can cover)\b/iu.test(text), where).toBe(false);
          expect(paragraph.includes(TEAM_MEMBER), where).toBe(false);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(500);
  });
});
