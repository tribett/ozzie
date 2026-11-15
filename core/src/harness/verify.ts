// Final-answer verification (build contract §8): deterministic inspect-own-work, no second model. Runs before
// anyone sees an answer; a rejected answer is never shown or restored.
//
// Since the structured-answer decision (review 2026-11-14 section C) the model writes no prose about people. Its final
// reply is only a choice among the facts the tools gave it, in a closed grammar (fixed.ts parseAnswer, mirrored by the
// native agent_step's reply check):
//   {"answer":"facts","facts":["f3","f7"]} | {"answer":"not-covered"} | {"answer":"nothing-needs-a-decision"}
//   | {"answer":"draft","draft":"d1","facts":[…]}
// and Ozzie writes every sentence on this Mac from fixed templates (compose.ts). So verification is exact, and
// "fidelity" when it fails:
//   - the reply fits the grammar: no other text, at most max_facts distinct fact ids;
//   - every fact id and the draft id is one a tool result in this task's evidence holds, from a tool the model actually
//     called and never one only echoed back under `asked_for` (fixed.ts idsIn);
//   - "nothing-needs-a-decision" only when this task read the overview and it counts nothing that needs a decision.
// A prose answer, an invented or borrowed id, or a claim the overview contradicts can't pass. On success the answer is
// returned in the one form Ozzie keeps (fixed.ts answerText).
import type { RuntimeDeps, ToolEnvelope } from "./contract.js";
import { answerText, idsIn, parseAnswer } from "./fixed.js";

export type Verdict = ReturnType<RuntimeDeps["verify"]>;

/** Deterministic checks of one final answer against the evidence this task's tools returned. */
export function verifyAnswer(answer: string, evidence: readonly ToolEnvelope[]): Verdict {
  const parsed = parseAnswer(answer);
  if (!parsed) return { ok: false, code: "fidelity" };
  const known = new Set(evidence.flatMap(e => [...idsIn(e)]));
  if (!parsed.facts.every(id => known.has(id)) || (parsed.draft !== null && !known.has(parsed.draft))) return { ok: false, code: "fidelity" };
  if (parsed.answer === "nothing-needs-a-decision") {
    const overview = evidence.filter(e => e.tool === "sunday.overview").map(e => e.payload as { needs_a_decision?: unknown; kept_on_this_mac?: unknown } | null);
    // Findings kept on this Mac (background checks) aren't counted there, so "nothing" can't be said while any may exist.
    if (!overview.length || overview.some(p => p?.needs_a_decision !== 0 || p?.kept_on_this_mac !== undefined)) return { ok: false, code: "fidelity" };
  }
  return { ok: true, answer: answerText(parsed) };
}

/** RuntimeDeps.verify. */
export const verifier: RuntimeDeps["verify"] = (answer, evidence) => verifyAnswer(answer, evidence);
