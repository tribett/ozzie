// Name matching in the harness's question and answer paths: one function, two modes (owner decision
// 2026-11-14, "capitalized only" by default; "strict" kept for comparison). The shared vectors in
// core/test/ask-parity.json "capitalizedCommonWords" are run natively too.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { containsNameWord } from "../../src/ask.js";
import type { AgentStepReply, ModelStep } from "../../src/harness/contract.js";
import { bundledSkills } from "../../src/harness/bundled-skills.js";
import { Harness, prepareAgentQuestion } from "../../src/harness/index.js";
import { DEFAULT_NAME_MODE, namedIn } from "../../src/harness/names.js";
import { HarnessSession } from "../../src/harness/session.js";
import { TsLoop } from "../../src/harness/ts-loop.js";
import { verifyAnswer } from "../../src/harness/verify.js";
import { nov22Capture, PEOPLE } from "../../src/fictional-sunday.js";
import { FRESH, harnessData } from "./fixtures.js";

interface Vectors { roster: string[]; found: string[]; notFound: string[] }
const parity = JSON.parse(readFileSync(new URL("../ask-parity.json", import.meta.url), "utf8")) as { capitalizedCommonWords: Vectors };
const vectors = parity.capitalizedCommonWords;
const roster = Object.fromEntries(vectors.roster.map((name, i) => [String(i + 1), name]));
const skills = await bundledSkills();
const withName = (id: string, name: string) => { const capture = nov22Capture(); capture.names = { ...capture.names, [id]: name }; return harnessData({ capture }); };

describe("the two name modes", () => {
  it("default to the owner's \"capitalized only\" rule", () => {
    expect(DEFAULT_NAME_MODE).toBe("capitalized-common-words");
  });

  it("capitalized only: the shared parity vectors", () => {
    for (const text of vectors.found) expect(namedIn(text, roster), text).toBe(true);
    for (const text of vectors.notFound) expect(namedIn(text, roster), text).toBe(false);
  });

  it("strict: every whole-word match counts, in any case, as Ask's own check does today", () => {
    for (const text of vectors.found) expect(namedIn(text, roster, "strict"), text).toBe(true);
    for (const text of ["Who will cover the 9:30 service?", "It may need a closer look.", "the church rules apply", "don't worry about it"]) {
      expect(namedIn(text, roster, "strict"), text).toBe(true);
      expect(containsNameWord(text, roster), text).toBe(true);
    }
    expect(namedIn("Is anyone free?", roster, "strict")).toBe(false);
  });
});

describe("the question path", () => {
  it("leaves an ordinary word in lower case alone, and still labels the name written with a capital", () => {
    const data = withName(PEOPLE.sam, "Will Whitcombe");
    const q = prepareAgentQuestion(new HarnessSession(), data, "Who will cover Nursery this week?");
    expect(q.ok && q.question).toMatch(/^Who will cover \[Role \d+\] this week\?$/u);
    const named = prepareAgentQuestion(new HarnessSession(), data, "Can Will cover Nursery this week?");
    expect(named.ok && named.question).toMatch(/^Can \[Person \d+\] cover \[Role \d+\] this week\?$/u);
    const strict = prepareAgentQuestion(new HarnessSession(), data, "Who will cover Nursery this week?", "strict");
    expect(strict.ok && strict.question).toMatch(/^Who \[Person \d+\] cover \[Role \d+\] this week\?$/u);
  });

  it("and the gate before the loop agrees, in either mode", async () => {
    const model: ModelStep = async (): Promise<AgentStepReply> => ({ content: "{\"answer\":\"not-covered\"}", tool_calls: [], finish: "stop" });
    const make = (mode?: "strict") => new Harness({ workspace_id: "fictional", data: withName(PEOPLE.sam, "Will Whitcombe"), skills, runtime: new TsLoop(), model, now: () => FRESH,
      newId: () => "00000000-0000-4000-8000-000000000001", ...(mode ? { nameMode: mode } : {}) });
    const task = { id: "00000000-0000-4000-8000-000000000001", kind: "ask" as const, skill_id: "answer-from-what-was-read", question: "Who will be there?", workspace_id: "fictional", created_at: FRESH };
    expect(make().check(task)).toBeNull();
    expect(make("strict").check(task)).toBe("egress");
    expect(make().check({ ...task, question: "Will is out?" })).toBe("egress");
    expect(make().check({ ...task, question: "Is will whitcombe out?" })).toBe("egress");
  });
});

describe("the answer path", () => {
  // Since structured answers (review 2026-11-14 section C) the model's answer is only fact ids, so no name can be in
  // it: the name rules apply to the question alone, and the answer's sentences are Ozzie's own (compose.test.ts).
  const evidence = [{ tool: "sunday.overview", source: "Planning Center Services", check_time: "2026-11-20T15:00:00Z", completeness: "complete" as const,
    payload: { fact: "f1", findings: [{ fact: "f2", kind: "needs people", tone: "needs a decision", role: "[Role 1]", time: { starts_at: "2026-06-14T09:30-04:00", ends_at: "2026-06-14T10:30-04:00" }, remaining: 1 }] } }];

  it("holds no words at all, so no name of any kind can be in it", () => {
    expect(verifyAnswer('{"answer":"facts","facts":["f2"]}', evidence).ok).toBe(true);
    for (const prose of ["No one will need to change anything.", "Will can't make it.", "The Church rules suggest a check-in.", "[Role 1] is at 2026-06-14T09:30-04:00."]) {
      expect(verifyAnswer(prose, evidence), prose).toEqual({ ok: false, code: "fidelity" });
    }
  });
});
