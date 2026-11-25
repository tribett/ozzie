// How far the example church is moved in time on this Mac right now (core example-dates.ts, owner decision
// 2026-11-25): its Sunday is the coming Sunday and nothing in it is later than now. Worked out when the example is
// opened and kept until it is left or opened again, so every page of one visit shows the same week. Outside a visit it
// is worked out from the clock each time it is asked for, so an app left running for days never shows an old week
// (review of d4bb7c4c, M1 and L2).
import { exampleShift, type ExampleShift } from "../../../core/src/example-dates.js";
import { exampleSundayOnly } from "../../../core/src/example.js";

let visit: ExampleShift | null = null;
let last: ExampleShift | null = null;
let firstCheck: { shift: ExampleShift; completed_at: string } | null = null;
/** The same object for the same shift, so what is built from it is built once. */
function kept(shift: ExampleShift): ExampleShift {
  if (!last || last.weeks !== shift.weeks || last.back !== shift.back) last = shift;
  return last;
}
/** The shift in use: this visit's, or with no visit, the one for this moment. */
export const exampleNow = (): ExampleShift => visit ?? kept(exampleShift(Date.now()));
/** Opening the example: work the shift out from the clock (or from `now`, for a fixed moment) and keep it for the visit. */
export function openExample(now: number | string = Date.now()): ExampleShift {
  visit = kept(exampleShift(now));
  return visit;
}
/** Leaving the example: the next look at it is worked out from the clock again. */
export function leaveExampleVisit(): void { visit = null; }
/** When the example's first check finished, as shown now: what tells it from its later check. */
export function exampleFirstCheck(): string {
  const shift = exampleNow();
  if (firstCheck?.shift !== shift) firstCheck = { shift, completed_at: exampleSundayOnly(shift).completed_at };
  return firstCheck.completed_at;
}
