// The phone line on Today (onboarding spec §4.2): after Ozzie has sent its first notice on this Mac, the next time the
// window opens Today carries one line offering the same notice on the person's phone. Asked once: either answer is
// remembered (ozzie.moments.v1 `phone`) and the line never comes back by itself. "Set up my phone" goes to Settings'
// existing "A notice on your phone" section, where nothing is turned on until the person does it there.
import { useState } from "react";
import { moments as thisMac, phoneMomentDue, type MomentsStore } from "./moments.js";
import "./finish.css";

export { phoneMomentDue } from "./moments.js";
export const PHONE_MOMENT = "Ozzie sent you a notice on this Mac. Want the same short line on your phone too?";

export function PhoneMoment({ onSetUp, memory = thisMac }: {
  /** Opens Settings at "A notice on your phone". */
  onSetUp: () => void;
  /** Where the answer is kept (tests pass their own). */
  memory?: MomentsStore | undefined;
}) {
  const [answered, setAnswered] = useState(() => memory.get().phone !== null);
  if (answered) return null;
  const answer = (a: "set-up" | "no") => { memory.answerPhone(a); setAnswered(true); if (a === "set-up") onSetUp(); };
  return <div className="phone-moment" role="group" aria-label="A notice on your phone">
    <p>{PHONE_MOMENT}</p>
    <div className="finish-acts">
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => answer("set-up")}>Set up my phone</button>
      <button type="button" className="btn btn-quiet btn-sm" onClick={() => answer("no")}>No thanks</button>
    </div>
  </div>;
}

/** Whether Today shows the line now: due by moments.ts, read from this Mac. */
export const phoneMomentNow = (noticeSentOnThisMac: boolean, phoneOn = false, memory: MomentsStore = thisMac) =>
  phoneMomentDue(memory.get(), noticeSentOnThisMac, phoneOn);
