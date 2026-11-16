// Entry for Ozzie's bundled helper for Siri and Shortcuts (product/desktop/src-tauri/helpers/shortcuts.swift): the
// answers of shortcuts.ts built as one classic script for the Mac's own JavaScriptCore, so the release app needs no
// Node. The helper finds the copy and native's marker exactly as file.ts finds the shared check's, hands in whether the
// switch is on and a read of the copy, and prints what this returns. No file, network or process call here.
import { QUESTIONS, shortcutsAnswer } from "./shortcuts.js";

// The names of the copy and of the marker beside it, and the largest copy read, taken from here so they can't drift.
// OFF is also what Ozzie's Siri actions (siri-actions.swift) say when asked to open a page while the switch is off.
export { OFF, QUESTIONS, SHORTCUTS_FILE, SHORTCUTS_ON_FILE, UNKNOWN_QUESTION } from "./shortcuts.js";
export { MAX_SHARED_BYTES } from "./snapshot.js";

/**
 * What Ozzie says to `question`. `read` (the copy's text, or anything else for none) is called only for a known question
 * while the switch is on. `nowMs` is now on this Mac's clock and `timeZone` its time zone.
 */
export function answer(question: unknown, on: unknown, read: () => unknown, nowMs: unknown, timeZone: unknown): string {
  const asked = String(question);
  const isOn = on === true;
  const text = isOn && (QUESTIONS as readonly string[]).includes(asked) ? read() : null;
  return shortcutsAnswer(asked, {
    on: isOn, text: typeof text === "string" ? text : null,
    nowMs: typeof nowMs === "number" && Number.isFinite(nowMs) ? nowMs : Date.now(),
    timeZone: typeof timeZone === "string" ? timeZone : "UTC",
  });
}
