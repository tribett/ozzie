// A Wednesday service for the "real day" tests (onboarding spec §5, decision 18): the fictional capture's shape, moved
// three days later to Wednesday, November 25, with its own title. Every name and id is the fictional church's invented
// test data; the fictional church itself (core/src/fictional-sunday.ts) stays a Sunday. Pure: no clock, no I/O.
import { nov22Capture, withFictionalBackgroundChecks, FICTIONAL_ZONE } from "../../../src/fictional-sunday.js";
import { withFictionalOperations } from "../../../src/fictional-operations.js";
import { dayWords, type DayWords } from "../../../src/service-day.js";
import type { SundayCapture } from "../../../src/sunday-capture.js";

/** Each date of the fictional Sunday's weeks, moved to the same Wednesday-based week (Sundays Nov 8/15/22 → Wednesdays Nov 11/18/25). */
const MOVED: Readonly<Record<string, string>> = {
  "2026-11-08": "2026-11-11", "2026-11-15": "2026-11-18", "2026-11-21": "2026-11-24", "2026-11-22": "2026-11-25", "2026-11-23": "2026-11-26",
};
export const WEDNESDAY_DATE = "2026-11-25";
export const WEDNESDAY_ZONE = FICTIONAL_ZONE;
export const WEDNESDAY_TITLE = "Youth Night (fictional)";
/** The plan as the picker and the day words see it: Planning Center's wall clock (misleading Z) and the service start. */
export const WEDNESDAY_PLAN = { sort_date: "2026-11-25T09:30:00Z", times: ["2026-11-25T14:30:00Z"] } as const;

function moved<T>(value: T): T {
  const json = JSON.stringify(value)
    .replace(/2026-11-(08|15|21|22|23)/gu, date => MOVED[date] ?? date)
    .replaceAll("November 22, 2026", "November 25, 2026")
    .replaceAll("Ozzie Demo — Main Sunday (fictional)", WEDNESDAY_TITLE);
  return JSON.parse(json) as T;
}

/** The fictional capture on a Wednesday: same people, teams and findings, different day. */
export const wednesdayCapture = (): SundayCapture => moved(nov22Capture());
/** With the kids-team background-check reads, moved the same way (one runs out the day before the service). */
export const wednesdayWithChecks = (): SundayCapture => moved(withFictionalBackgroundChecks(nov22Capture()));
/** With the fictional rooms, follow-ups and group reads, moved the same way. */
export const wednesdayWithOperations = (): SundayCapture => moved(withFictionalOperations(nov22Capture()));
/** Both: the background-check reads and the rooms, follow-ups and group reads, moved the same way. */
export const wednesdayWithEverything = (): SundayCapture => moved(withFictionalOperations(withFictionalBackgroundChecks(nov22Capture())));
/** The words every page gets for this plan: "Wednesday", "Is Wednesday covered?", "this Wednesday". */
export const wednesdayWords = (): DayWords => dayWords({ sort_date: WEDNESDAY_PLAN.sort_date, times: [...WEDNESDAY_PLAN.times] }, WEDNESDAY_ZONE);
