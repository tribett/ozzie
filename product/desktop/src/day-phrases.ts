// Small phrases built from the day words (core service-day.ts `dayWords`), for sentences the day words don't hold whole:
// "Nothing on Wednesday needs a decision." Pure. A weekday is named on its own ("Wednesday"); anything else by its "this
// one" form ("this weekend", "these services", "your service"), so a service on another day is never called "Sunday"
// (onboarding spec §5). The page, the job and Ozzie's hourly look are named for "your services" whatever the day (owner
// decision 2026-11-19): the day stays only where it says when.
import { SERVICES_PAGE, type DayWords } from "../../../core/src/service-day.js";
import type { NoticeDay } from "./onboarding-bridge.js";

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
/** The watched service by its day mid-sentence: "Wednesday", "this weekend", "these services", "your service". */
export const dayName = (d: DayWords): string => d.kind === "weekday" ? d.day : d.thisOne;
/** The same at the start of a sentence: "Wednesday", "This weekend", "These services", "Your service". */
export const DayName = (d: DayWords): string => capital(dayName(d));
/** The services Ozzie watches, as a sentence names them whatever their day. */
export const SERVICES = "your services";
export const Services = "Your services";
/** The button that opens the services' page. */
export const OPEN_SERVICES = `Open ${SERVICES_PAGE}`;
/** The job that also prepares notes, as shown (spec §5.2, §6; renamed 2026-11-19). The day words are no longer needed. */
export const keepTitle = (): string => "Keep services covered";
/** "Keep an eye on my services" (the job, as a person asks for it), "Ozzie keeps an eye on your services" (the hourly look, spec §6). */
export const watchTitle = (): string => "Keep an eye on my services";
export const eyeLine = (): string => `Ozzie keeps an eye on ${SERVICES}`;
/** The services' sidebar page, mid-sentence: "the Services page". */
export const pageRef = (): string => `the ${SERVICES_PAGE} page`;

const NOTICE_WEEKDAYS: readonly NoticeDay[] = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
/**
 * The day the coverage notice names (`notify_sunday_attention`'s `day`, native contract N8): the weekday, "weekend", or
 * "service" for anything else. A closed code, never text; "sunday" only when the day words say Sunday.
 */
export function noticeDayOf(d: DayWords | null | undefined): NoticeDay {
  if (d?.kind === "weekday" && d.weekday !== null) return NOTICE_WEEKDAYS[d.weekday] ?? "service";
  return d?.kind === "weekend" ? "weekend" : "service";
}
/** The fixed line native shows for each notice day (N8), word for word, for Settings' example. */
export function noticeLine(day: NoticeDay): string {
  if (day === "weekend") return "This weekend's coverage needs attention. Open Ozzie to see details.";
  if (day === "service") return "Service coverage needs attention. Open Ozzie to see details.";
  return `${capital(day)} coverage needs attention. Open Ozzie to see details.`;
}

const ON_SUNDAY = (d: DayWords) => d.kind === "weekday" && d.weekday === 0;
/** The first half of that line, said alone above a procedure text that doesn't say Sunday (procedure-text.tsx). */
export const EXACT_WORDS = "These are the exact words the AI is given.";
/**
 * The line above a procedure's exact text (core/skills, pinned) for a service not on a Sunday: the text stays word for
 * word, since it is what the AI is given, and this says what its "Sunday" means. Null for a Sunday service.
 */
export function procedureNote(d: DayWords): string | null {
  if (ON_SUNDAY(d)) return null;
  const meant = d.kind === "weekday" ? `your ${d.day} service` : d.kind === "unknown" ? "the service Ozzie watches" : d.day;
  return `${EXACT_WORDS} Where they say Sunday, they mean ${meant}.`;
}
/**
 * A procedure's purpose as shown above its exact text, the service named by its real day: "this Sunday" after a word like
 * "before" is the day's own "this one" ("before this Wednesday", "before your service"); elsewhere a weekday or weekend
 * is said the same way and anything else as "at these services". Unchanged for a Sunday service.
 */
export function procedurePurpose(purpose: string, d: DayWords): string {
  if (ON_SUNDAY(d)) return purpose;
  const bare = d.kind === "weekday" || d.kind === "weekend" ? d.thisOne : `at ${d.thisOne}`;
  return purpose.replace(/(\b(?:about|before|after|for|on|until) )?\bthis Sunday\b/gu, (_m, after: string | undefined) => after ? `${after}${d.thisOne}` : bare);
}
