// The example church as the app shows it: the fixed fictional data, moved in time so its Sunday is the coming one and
// nothing in it is later than now (example-dates.ts, owner decision 2026-11-25). Everything else about it is the
// fixtures' own: the same church, people, roles and findings. With no shift each is the fixture as written.
import type { AttentionInput } from "./attention-import/index.js";
import { fictionalB1, fictionalBreeze, fictionalGenesis } from "./church-systems/fictional.js";
import type { SystemCapture } from "./church-systems/types.js";
import { shiftExample, shiftNamedDays, type ExampleShift } from "./example-dates.js";
import { harborAttentionImport, INVOICE_DUE } from "./fictional-attention.js";
import { withFictionalOperations } from "./fictional-operations.js";
import { nov22Capture, nov22LaterCapture } from "./fictional-sunday.js";
import type { SundayCapture } from "./sunday-capture.js";

/** The example's Sunday check, with its rooms, follow-ups and group meetings. */
export const exampleCapture = (shift: ExampleShift): SundayCapture => shiftExample(withFictionalOperations(nov22Capture()), shift);
/** The same Sunday checked again two hours later ("See a later fictional check"). */
export const exampleLaterCapture = (shift: ExampleShift): SundayCapture => shiftExample(withFictionalOperations(nov22LaterCapture()), shift);
/** The Sunday check alone, for the sample of what the AI is sent. */
export const exampleSundayOnly = (shift: ExampleShift): SundayCapture => shiftExample(nov22Capture(), shift);
/** The labeled fictional email and calendar import behind Today. */
export const exampleAttention = (shift: ExampleShift): AttentionInput => shiftExample(harborAttentionImport(shiftNamedDays(INVOICE_DUE, shift)), shift);
/** The example churches of the other systems, each on its own church's clock. */
export function exampleSystem(system: "b1" | "breeze" | "genesis", shift: ExampleShift): SystemCapture {
  const capture = system === "b1" ? fictionalB1() : system === "breeze" ? fictionalBreeze() : fictionalGenesis();
  const zone = capture.church.time_zone ?? undefined, moved = shiftExample(capture, shift, zone);
  // A church's events keep their weekdays (Genesis: "Midweek Prayer" on Thursday, review of d4bb7c4c L1): each moves by
  // whole weeks, and one that had already happened when the example was checked is the week before when it would
  // otherwise come after the moved check.
  const checked = Date.parse(capture.completed_at), movedCheck = Date.parse(moved.completed_at);
  const events = capture.events.map(event => {
    const byWeeks = shiftExample(event, { weeks: shift.weeks, back: 0 }, zone);
    const over = Date.parse(event.ends_at ?? event.starts_at) <= checked;
    return over && Date.parse(byWeeks.ends_at ?? byWeeks.starts_at) > movedCheck ? shiftExample(event, { weeks: shift.weeks - 1, back: 0 }, zone) : byWeeks;
  });
  return { ...moved, events };
}
