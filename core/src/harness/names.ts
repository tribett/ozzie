// Name matching for the harness's question and answer checks: one function, two modes (owner decision
// 2026-11-14, the "Ordinary-word name parts" decision, with the coordinator's refinement
// of the same day).
//   "capitalized-common-words" (the default): a full name always counts. A weekday or month name, and
//     "church" in Ozzie's own "Church rules", counts only beside another part of the same member's name. Any
//     other single name part that is also a common English word (fixed/common-words.txt: Will, Grace, Hope,
//     Don…) counts only when written with a capital, a capital at the start of a sentence included, and never
//     with a contraction straight after it ("Don't"). "Who will cover" and "this Sunday" are not names.
//   "strict": any whole-word match of any name part counts, in any case (Ask's own rule today).
// Disguised spellings, unspaced scripts and contact details stay strict in both. Every label the harness issues
// ([Room 1], [Workflow 1] …) is set aside first, as the native check sets it aside, so a member named Room or
// Step can't make a labelled question fail. The native agent_step check reads the same list and must agree
// (core/test/ask-parity.json "capitalizedCommonWords").
import { containsNameWord, TEAM_MEMBER, type NameMatchOptions } from "../ask.js";
import { COMMON_WORDS } from "./fixed.js";
import { LABEL_PATTERN, YOUR_NAME } from "./session.js";

export type NameMode = "strict" | "capitalized-common-words";
export const DEFAULT_NAME_MODE: NameMode = "capitalized-common-words";

/** What ask.ts's matchers take for a mode. */
export const nameOptions = (mode: NameMode = DEFAULT_NAME_MODE): NameMatchOptions => mode === "strict" ? {} : { common: COMMON_WORDS };

const LABELS = new RegExp(`${LABEL_PATTERN.source}|${[TEAM_MEMBER, YOUR_NAME].map(l => l.replace(/[[\]]/gu, "\\$&")).join("|")}`, "gu");

/** Whether any roster name appears in the text as a name, under the mode, with the harness's labels removed outright and as spaces. */
export function namedIn(text: string, names: Readonly<Record<string, string>>, mode: NameMode = DEFAULT_NAME_MODE): boolean {
  const options = nameOptions(mode);
  return containsNameWord(text.replace(LABELS, ""), names, options) || containsNameWord(text.replace(LABELS, " "), names, options);
}
