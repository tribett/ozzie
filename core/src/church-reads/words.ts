// Plain-English times and dates for church-read facts, in the church's own time zone. Pure.
import { localDate } from "../church-time.js";

// Newer ICU data writes a narrow no-break space before AM/PM; facts use a plain space.
const plain = (text: string) => text.replace(/[  ]/gu, " ");
/** "9:00 AM" at `iso` in `zone`. */
export const clockIn = (iso: string, zone: string) =>
  plain(new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: zone }));
/** "Sunday, November 8" for a calendar date `YYYY-MM-DD`. */
export const dayWords = (date: string) =>
  plain(new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" }));
/** "Friday, November 20 at 6:00 PM" for `iso` in `zone`. */
export const whenIn = (iso: string, zone: string) => `${dayWords(localDate(iso, zone))} at ${clockIn(iso, zone)}`;
/** Whether a calendar date `YYYY-MM-DD` is a Sunday. */
export const isSunday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay() === 0;
