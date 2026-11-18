// The real day of the watched service, for every page (onboarding spec §5, decision 18). App works out the words once
// from the plan Ozzie watches (core service-day.ts `dayWords`) and provides them; a page reads them with `useDay()`.
// Outside a provider (tests of one page), the generic Sunday words apply, as for the fictional example church.
import { createContext, useContext } from "react";
import { SUNDAY_WORDS, type DayWords } from "../../../core/src/service-day.js";
export { dayWords, SUNDAY_WORDS, UNKNOWN_WORDS, type DayWords } from "../../../core/src/service-day.js";

export const DayContext = createContext<DayWords>(SUNDAY_WORDS);
export const DayProvider = DayContext.Provider;
/** The words for the service Ozzie watches: `day`, `Day`, `page`, `question`, `date`, `thisOne`. */
export const useDay = (): DayWords => useContext(DayContext);
