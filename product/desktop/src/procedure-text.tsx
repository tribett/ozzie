// A procedure's exact text (core/skills, pinned) where it is shown: Church rules › What the AI is asked to do, Ask's and
// the who-could-help card's "See how this works". The text is what the AI is given, so it is shown word for word; for a
// service not on a Sunday one line above it says what its "Sunday" means (onboarding spec §5, decision 18).
import { useDay } from "./day-words.js";
import { procedureNote } from "./day-phrases.js";

export function ProcedureBody({ body }: { body: string }) {
  const note = procedureNote(useDay());
  return <>
    {note && <p className="small">{note}</p>}
    <div className="procedure-body">{body}</div>
  </>;
}
