import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createWindowVisible, type VisibleDocument, type VisibleWindow } from "../src/window-visible.js";

/** A stand-in document and window whose events are fired by hand. */
function standIn(visibilityState: string, focused = false) {
  const listeners = new Map<string, Set<() => void>>();
  const on = (type: string, l: () => void) => { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type)!.add(l); };
  const off = (type: string, l: () => void) => { listeners.get(type)?.delete(l); };
  const doc = { visibilityState, focused, hasFocus() { return doc.focused; }, addEventListener: on, removeEventListener: off };
  const win = { addEventListener: on, removeEventListener: off };
  const fire = (type: string) => { for (const l of [...(listeners.get(type) ?? [])]) l(); };
  const count = () => [...listeners.values()].reduce((n, s) => n + s.size, 0);
  return { doc: doc as VisibleDocument & { visibilityState: string; focused: boolean }, win: win as VisibleWindow, fire, count };
}

describe("whether Ozzie's window is on screen", () => {
  it("is on screen when visible, hidden when hidden, and on screen where there is no document", () => {
    expect(createWindowVisible(standIn("visible").doc, undefined).visible()).toBe(true);
    expect(createWindowVisible(standIn("hidden").doc, undefined).visible()).toBe(false);
    expect(createWindowVisible(standIn("prerender").doc, undefined).visible()).toBe(true);
    expect(createWindowVisible(undefined, undefined).visible()).toBe(true);
  });

  // The 0.1.8 fault: the page started while the window was still hidden, the window was shown before the page's effect
  // listened, and the page believed it was hidden from then on, so lists and notes were never read after a restart.
  it("listens from the moment it is made, so a window shown before anyone subscribed is seen", () => {
    const s = standIn("hidden");
    const screen = createWindowVisible(s.doc, s.win);
    expect(screen.visible()).toBe(false);
    s.doc.visibilityState = "visible";
    s.fire("visibilitychange"); // nobody has subscribed yet
    const seen: boolean[] = [];
    screen.subscribe(v => seen.push(v));
    expect(seen).toEqual([true]);
  });

  it("tells a subscriber the answer at once, even when the change came with no event at all", () => {
    const s = standIn("hidden");
    const screen = createWindowVisible(s.doc, s.win);
    s.doc.visibilityState = "visible"; // no event fired
    const seen: boolean[] = [];
    screen.subscribe(v => seen.push(v));
    expect(seen).toEqual([true]);
  });

  it("sees a window that came forward while its visibility still says hidden, until the document speaks for itself", () => {
    const s = standIn("hidden");
    const screen = createWindowVisible(s.doc, s.win);
    const seen: boolean[] = [];
    screen.subscribe(v => seen.push(v));
    expect(seen).toEqual([false]);
    s.doc.focused = true;
    s.fire("focus");
    expect(seen.at(-1)).toBe(true);
  });

  // A screen that locks, or a display that sleeps, with Ozzie in front: the window keeps the keyboard, and it is hidden.
  it("takes the document's own word as final: hidden while it still has the keyboard is hidden", () => {
    const s = standIn("visible", true);
    const screen = createWindowVisible(s.doc, s.win);
    const seen: boolean[] = [];
    screen.subscribe(v => seen.push(v));
    s.doc.visibilityState = "hidden";
    s.fire("visibilitychange");
    expect(seen.at(-1)).toBe(false);
    s.fire("focus");
    s.fire("blur");
    s.fire("pageshow");
    expect(seen.at(-1)).toBe(false);
    expect(screen.visible()).toBe(false);
    s.doc.visibilityState = "visible";
    s.fire("visibilitychange");
    expect(seen.at(-1)).toBe(true);
  });

  it("stays hidden behind a closed window: neither visible nor focused", () => {
    const s = standIn("hidden", false);
    const screen = createWindowVisible(s.doc, s.win);
    s.fire("blur");
    s.fire("pageshow");
    expect(screen.visible()).toBe(false);
  });

  it("stops telling a subscriber that left, and stops listening when asked", () => {
    const s = standIn("visible");
    const screen = createWindowVisible(s.doc, s.win);
    const seen: boolean[] = [];
    const leave = screen.subscribe(v => seen.push(v));
    leave();
    s.doc.visibilityState = "hidden";
    s.fire("visibilitychange");
    expect(seen).toEqual([true]);
    expect(s.count()).toBe(4);
    screen.stop();
    expect(s.count()).toBe(0);
  });

  it("is the one way App asks whether its window is on screen", () => {
    const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
    expect(app).toContain("const onScreen = createWindowVisible(");
    expect(app).toContain("useEffect(() => onScreen.subscribe(setShown), []);");
    expect(app.match(/visibilityState|hasFocus/g) ?? []).toEqual([]);
  });
});
