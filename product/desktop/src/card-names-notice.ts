// "New: … Ozzie now looks up the name on each card …" (privacy review L5): said once on the Visitor cards page, the first
// time cards are checked with lookups on, so a church whose connection already held People learns of the new read and
// how to stop it. Only `{ "seen": true }` is kept, on this Mac: never a name, a card or anything Planning Center said.
// App owns it and hands the cards page only `seen` and `see`, so the cards' own code keeps no storage.
import type { KeyValue } from "./moments.js";

export const CARD_NAMES_NOTICE_KEY = "ozzie.card-names-notice.v1";
export interface CardNamesNotice { seen(): boolean; see(): void }
const thisMac = (): KeyValue | null => { try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; } };
export function cardNamesNotice(storage: () => KeyValue | null = thisMac): CardNamesNotice {
  return {
    seen: () => { try { return (JSON.parse(storage()?.getItem(CARD_NAMES_NOTICE_KEY) ?? "null") as { seen?: unknown } | null)?.seen === true; } catch { return false; } },
    see: () => { try { storage()?.setItem(CARD_NAMES_NOTICE_KEY, JSON.stringify({ seen: true })); } catch { /* said again next time, at worst */ } },
  };
}
export const cardNamesNoticeMemory: CardNamesNotice = cardNamesNotice();
