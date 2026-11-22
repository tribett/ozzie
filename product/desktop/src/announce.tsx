// One polite announcer for the whole app (accessibility audit S4, WCAG 4.1.3): a single visually hidden status line that
// stays on the page, so VoiceOver says one short sentence when something the leader did finishes somewhere it can't see
// (Check now ending, a decision or its Undo moving a card, a "Looks good — I'll send it" mark made or taken back, a card
// set aside on Today). Today's own announcer moved up here. A page says a sentence with `useAnnounce()`; nothing here is
// sent anywhere, and the words are the page's own.
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

type Announce = (text: string) => void;
const AnnounceContext = createContext<Announce | null>(null);
const quiet: Announce = () => undefined;

/** Says `text` once, politely. Outside the app (a page drawn on its own in a test), nothing is said. */
export function useAnnounce(): Announce {
  return useContext(AnnounceContext) ?? quiet;
}

/**
 * The status line, and the way to it for everything under it. The same sentence twice in a row is still said twice: the
 * line's words change by a no-break space, which VoiceOver doesn't read.
 */
export function Announcer({ children }: { children: ReactNode }) {
  const [said, setSaid] = useState("");
  const announce = useCallback<Announce>(text => setSaid(before => before === text ? `${text} ` : text), []);
  return <AnnounceContext.Provider value={announce}>
    {children}
    <p className="sr-only" role="status" aria-live="polite">{said}</p>
  </AnnounceContext.Provider>;
}
