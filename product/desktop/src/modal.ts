// A question over the page keeps the keyboard inside it (accessibility audit S2, WCAG 2.4.3 and 2.4.11): while it is
// open everything else on the page is inert (WebKit has `inert` on macOS 14, Ozzie's oldest), so Tab, Full Keyboard
// Access and VoiceOver stay in the question instead of reaching controls under its shade. When it closes, the page comes
// back first and then the keyboard returns to what had it before (the control that opened it). Live status lines stay
// as they are, so what they say is still heard.
import { useEffect, type RefObject } from "react";

/** Marks everything outside `dialog` inert, and returns how to undo exactly that (never an element that was inert already). */
export function inertOutside(dialog: Element): () => void {
  const made: Element[] = [];
  for (let at: Element = dialog; at.parentNode && at.tagName !== "BODY"; at = at.parentNode as Element) {
    for (const sibling of Array.from(at.parentNode.childNodes)) {
      if (sibling === at || sibling.nodeType !== 1) continue;
      const el = sibling as Element;
      if (el.hasAttribute("inert") || el.hasAttribute("aria-live") || el.getAttribute("role") === "status" || el.getAttribute("role") === "alert") continue;
      el.setAttribute("inert", "");
      made.push(el);
    }
  }
  return () => { for (const el of made) el.removeAttribute("inert"); };
}

/**
 * For a modal question: on opening, the page outside `dialog` goes inert and `first` (its title, or its safe answer)
 * takes the keyboard; on closing, the page comes back and the keyboard returns where it was.
 */
export function useModal(dialog: RefObject<HTMLElement | null>, first: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (typeof document === "undefined" || !dialog.current) return;
    const before = document.activeElement as HTMLElement | null;
    const restore = inertOutside(dialog.current);
    first.current?.focus();
    return () => { restore(); before?.focus?.(); };
  }, []);
}
