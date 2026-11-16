// Reads a private calendar link's text off the page's main thread (calendars.ts `parseLink`), so a large or hostile
// calendar can never freeze the window: the page ends this worker if it takes too long. It only parses: it receives
// the text and sends back what touches the days shown. No network, no storage, nothing else.
import { readFromLink, type CalendarRead, type CalendarSource } from "../../../core/src/calendar/events.js";

interface Job { text: string; source: CalendarSource; checked_at: string; window: { from: string; to: string; dates: string[] }; zone: string }
const scope = self as unknown as { onmessage: ((event: MessageEvent<Job>) => void) | null; postMessage(read: CalendarRead): void };
scope.onmessage = event => {
  const { text, source, checked_at, window, zone } = event.data;
  scope.postMessage(readFromLink(text, source, checked_at, window, zone));
};
