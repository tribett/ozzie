// A procedure's exact text (core/skills, pinned) where it is shown: Church rules › What the AI is asked to do, Ask's and
// the who-could-help card's "See how this works". The text is what the AI is given, so it is shown word for word; for a
// service not on a Sunday one line above it says these are the AI's exact words and, above a text that says Sunday, what
// its "Sunday" means (onboarding spec §5, decision 18); Ask's own procedure and the follow-ups one don't say Sunday.
import { useDay } from "./day-words.js";
import { EXACT_WORDS, procedureNote } from "./day-phrases.js";

/** Whether a procedure's text says "Sunday" as a word, so the line about what it means belongs above it. */
export const saysSunday = (body: string): boolean => /(?<![\p{L}\p{N}])Sunday(?![\p{L}\p{N}])/u.test(body);

export function ProcedureBody({ body }: { body: string }) {
  const d = useDay();
  const full = procedureNote(d);
  const note = full && !saysSunday(body) ? EXACT_WORDS : full;
  return <>
    {note && <p className="small">{note}</p>}
    <div className="procedure-body">{body}</div>
  </>;
}
