// Text size (accessibility audit B1, WCAG 1.4.4): View › Bigger Text (⌘=), Smaller Text (⌘−) and Actual Size (⌘0) are
// native menu items (src-tauri/src/text_size.rs) that zoom the whole page and keep the choice for next time. A menu
// item has one key, so ⌘+ itself (Shift held, or a keyboard with a + key of its own) is heard here and asks native for
// the same one step. The page never sets a size.
import { invoke } from "@tauri-apps/api/core";
import { useEffect } from "react";

/** Settings' line about it (connection-page.tsx), in plain words. */
export const TEXT_SIZE_NOTE = "To make everything bigger, press ⌘ and + (Command and plus). ⌘ and − makes it smaller, and ⌘ and 0 puts it back. " +
  "They are also in the View menu, and Ozzie keeps your choice.";

type Keys = { key: string; metaKey: boolean; shiftKey: boolean; altKey: boolean; ctrlKey: boolean };
/** ⌘+: Command with the + character (Shift and =, or a + key). Plain ⌘= is the menu's own key, so it isn't taken here. */
export const isBiggerKey = (e: Keys) => e.metaKey && !e.altKey && !e.ctrlKey && (e.key === "+" || (e.key === "=" && e.shiftKey));

const nativeBigger = () => invoke("text_size_step", { step: "bigger" });
/** While the app is open: ⌘+ asks for one step bigger, and the key goes no further (so it is never taken twice). */
export function useBiggerTextKey(step: () => Promise<unknown> = nativeBigger) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!isBiggerKey(e)) return;
      e.preventDefault();
      void step().catch(() => undefined);
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [step]);
}
