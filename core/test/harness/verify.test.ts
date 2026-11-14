// Answer verification (build contract §8: deterministic, no second model), since structured answers (review
// 2026-11-14 section C): the model's final reply is only a choice of fact ids from this task's evidence, in the closed
// grammar core/test/answer-parity.json pins on both sides; Ozzie writes the sentences (compose.test.ts).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ToolEnvelope } from "../../src/harness/contract.js";
import { parseAnswer } from "../../src/harness/fixed.js";
import { verifyAnswer } from "../../src/harness/verify.js";

const env = (tool: string, payload: unknown): ToolEnvelope => ({ tool, source: "Planning Center Services", check_time: "2026-11-20T15:00:00Z", completeness: "complete", payload });
const HELP = env("sunday.who_could_help", { fact: "f1", asked_for: { role: "[Role 1]" }, times: [{ fact: "f2", role: "[Role 1]", time: { starts_at: "2026-11-22T09:30-05:00", ends_at: "2026-11-22T10:30-05:00" }, remaining: 1 }],
  people: [{ fact: "f3", role: "[Role 1]", person: "[Person 1]", status: "no overlap found" }, { fact: "f4", role: "[Role 1]", person: "[Person 2]", status: "possible conflict" }] });
const DRAFT = env("drafts.prepare_note", { draft_id: "d1", asked_for: { person: "[Person 1]", role: "[Role 1]" }, draft: "Hi [Person 1],\n\nThank you,\n[Your name]", status: "draft only; nothing has been sent" });
const overview = (decisions: number) => env("sunday.overview", { fact: "f9", mode: "live", sunday: "2026-11-22", reads: 20, reads_not_completed: 0, needs_a_decision: decisions, worth_a_look: 1, findings: [] });
const verdict = (answer: string, evidence: ToolEnvelope[] = [HELP]) => verifyAnswer(answer, evidence);

describe("answer verification", () => {
  it("accepts a choice of facts the evidence holds, and returns it in the one form Ozzie keeps", () => {
    expect(verdict('{"answer":"facts","facts":["f4","f3"]}')).toEqual({ ok: true, answer: '{"answer":"facts","facts":["f4","f3"]}' });
    expect(verdict(' ```json\n{ "facts": ["f2"], "answer": "facts" }\n``` ')).toEqual({ ok: true, answer: '{"answer":"facts","facts":["f2"]}' });
    expect(verdict('{"answer":"not-covered"}', [])).toEqual({ ok: true, answer: '{"answer":"not-covered"}' });
    expect(verdict('{"answer":"not-covered","facts":[]}')).toEqual({ ok: true, answer: '{"answer":"not-covered"}' });
    expect(verdict('{"answer":"draft","draft":"d1","facts":["f3"]}', [HELP, DRAFT])).toEqual({ ok: true, answer: '{"answer":"draft","facts":["f3"],"draft":"d1"}' });
  });

  it("refuses prose, whatever it says, as an answer that isn't the answer form", () => {
    for (const prose of ["[Person 1] has no overlap found for [Role 1].", "I can't tell from what I read.", "Riley Thornbury could help.", "Sent to [Person 1].",
      'Sure! {"answer":"facts","facts":["f3"]}', ""]) expect(verdict(prose), prose).toEqual({ ok: false, code: "fidelity" });
  });

  it("refuses an id no tool result of this task holds, or one a tool only echoed back", () => {
    expect(verdict('{"answer":"facts","facts":["f3","f5"]}')).toEqual({ ok: false, code: "fidelity" });
    expect(verdict('{"answer":"draft","draft":"d1"}')).toEqual({ ok: false, code: "fidelity" });
    expect(verdict('{"answer":"draft","draft":"d2"}', [HELP, DRAFT])).toEqual({ ok: false, code: "fidelity" });
    // An id under asked_for (the tool's echo of its arguments) never counts as evidence (review B-S1).
    const echoed = env("sunday.who_could_help", { fact: "f1", asked_for: { role: "[Role 1]", fact: "f7" }, people: [] });
    expect(verdict('{"answer":"facts","facts":["f7"]}', [echoed])).toEqual({ ok: false, code: "fidelity" });
    expect(verdict('{"answer":"facts","facts":["f1"]}', [echoed]).ok).toBe(true);
  });

  it("says nothing needs a decision only beside an overview that counts none", () => {
    expect(verdict('{"answer":"nothing-needs-a-decision"}', [overview(0)]).ok).toBe(true);
    expect(verdict('{"answer":"nothing-needs-a-decision","facts":["f9"]}', [overview(0)]).ok).toBe(true);
    expect(verdict('{"answer":"nothing-needs-a-decision"}', [overview(2)])).toEqual({ ok: false, code: "fidelity" });
    expect(verdict('{"answer":"nothing-needs-a-decision"}', [HELP])).toEqual({ ok: false, code: "fidelity" });
    expect(verdict('{"answer":"nothing-needs-a-decision"}', [overview(0), overview(1)])).toEqual({ ok: false, code: "fidelity" });
  });

  it("reads every answer as core/test/answer-parity.json says, the vectors native runs too", () => {
    const parity = JSON.parse(readFileSync(new URL("../answer-parity.json", import.meta.url), "utf8")) as {
      valid: { text: string; answer: string; facts: string[]; draft: string | null }[]; invalid: string[];
    };
    for (const v of parity.valid) expect(parseAnswer(v.text), v.text).toEqual({ answer: v.answer, facts: v.facts, draft: v.draft });
    for (const text of parity.invalid) expect(parseAnswer(text), text).toBeNull();
    expect(parity.valid.length).toBeGreaterThanOrEqual(10);
    expect(parity.invalid.length).toBeGreaterThanOrEqual(30);
  });
});
