// New versions of Ozzie in the app (src-tauri/src/updater.rs does the work): the Updates section in Settings, the
// calm line above Today, their fixed words, "Remind me tomorrow", and the four native commands the page may call.
// Fixed fictional states; the native side is a recording fake.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
const calls = vi.hoisted(() => [] as [string, unknown][]);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((command: string, args?: unknown) => {
    calls.push([command, args]);
    return new Promise(() => {});
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
import {
  AUTOMATIC_HELP, AUTOMATIC_LABEL, canInstall, CHECK_BUTTON, LATER_BUTTON, laterMemory, lastCheckedText, PLACE_TEXT, PROBLEM_TEXT, REOPEN_NOTE,
  statusLine, UPDATE_BUTTON, UPDATE_CARDS_ASK, UPDATE_DISCARD, UPDATE_HOW, UPDATE_KEEP_CARDS, updates, working, type UpdatesState, type UpdateView,
} from "../src/updates.js";
import { AUTOMATIC_OFF, UpdateLine, UpdatesSection } from "../src/updates-view.js";
import { ConnectionPage } from "../src/connection-page.js";
import { HIDDEN_WORDS, text } from "./harness-fakes.js";
import { promise } from "../src/promises.js";

// Thursday 2026-11-19, 2:30 PM on this Mac.
const NOW = new Date(2026, 10, 19, 14, 30).getTime();
const view = (over: Partial<UpdateView> = {}): UpdateView => ({
  current: "0.1.1", automatic: true, lastCheckedMs: new Date(2026, 10, 19, 9, 14).getTime(), phase: "idle", available: null, problem: null,
  place: "app", autopilot: false, probe: false, ...over,
});
const ready = (over: Partial<UpdateView> = {}) => view({ phase: "available", available: "0.1.2", ...over });
const state = (v: UpdateView | null, over: Partial<UpdatesState> = {}): UpdatesState => ({ view: v, check() {}, setAutomatic() {}, install() {}, ...over });
const memoryStore = () => { const m = new Map<string, string>(); return { get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => { m.set(k, v); } }; };
/** Whether the markup has a button with exactly this label (the words also appear in "See how this works"). */
const hasButton = (html: string, label: string) => html.includes(`>${label}</button>`);
const section = (v: UpdateView | null) => renderToStaticMarkup(React.createElement(UpdatesSection, { state: state(v), nowMs: NOW, cards: 0 }));
const line = (v: UpdateView | null, memory = laterMemory(memoryStore())) =>
  renderToStaticMarkup(React.createElement(UpdateLine, { state: state(v), nowMs: NOW, memory, cards: 0 }));

describe("updates: fixed words", () => {
  it("says when Ozzie last checked, in this Mac's time", () => {
    expect(lastCheckedText(view(), NOW)).toBe("Last checked today at 9:14 AM.");
    expect(lastCheckedText(view({ lastCheckedMs: new Date(2026, 10, 18, 21, 5).getTime() }), NOW)).toBe("Last checked yesterday at 9:05 PM.");
    expect(lastCheckedText(view({ lastCheckedMs: new Date(2026, 10, 16, 8, 0).getTime() }), NOW)).toBe("Last checked Monday, November 16 at 8:00 AM.");
    expect(lastCheckedText(view({ lastCheckedMs: null }), NOW)).toBe("Not checked yet.");
  });

  it("words every step and every problem plainly", () => {
    expect(statusLine(view())).toBe("Ozzie is up to date.");
    expect(statusLine(view({ lastCheckedMs: null }))).toBeNull();
    expect(statusLine(view({ phase: "checking" }))).toBe("Checking for a new version…");
    expect(statusLine(ready())).toBe("Ozzie 0.1.2 is ready to install.");
    expect(statusLine(ready({ phase: "downloading" }))).toBe("Getting Ozzie 0.1.2 ready…");
    expect(statusLine(ready({ phase: "waiting" }))).toBe("Ozzie is finishing what it's doing. Then it closes for a moment and opens again with the new version.");
    expect(statusLine(ready({ phase: "reopening" }))).toBe("Ozzie is reopening with the new version…");
    expect(statusLine(view({ problem: "check-failed" }))).toBe("Ozzie couldn't check for a new version. It will try again later.");
    expect(statusLine(ready({ problem: "install-failed" }))).toBe("Ozzie couldn't install the new version. Nothing was changed. Try again later, or download it from ozzie.church.");
    expect(statusLine(ready({ problem: "still-busy" }))).toBe("Ozzie stayed busy for a long time, so it didn't update. Try again when it has finished.");
    // A step under way says what's happening, not the last problem.
    expect(statusLine(ready({ phase: "checking", problem: "check-failed" }))).toBe("Checking for a new version…");
  });

  it("offers the update only for a newer version this copy can replace, and only when nothing is under way", () => {
    expect(canInstall(ready())).toBe(true);
    expect(canInstall(view())).toBe(false);
    for (const phase of ["checking", "downloading", "waiting", "reopening"] as const) {
      expect(canInstall(ready({ phase }))).toBe(false);
      expect(working(ready({ phase }))).toBe(true);
    }
    expect(canInstall(ready({ place: "not-an-app" }))).toBe(false);
    expect(canInstall(ready({ place: "move-to-applications" }))).toBe(false);
  });

  it("names the person's effect on every button and keeps the plumbing words off the screen", () => {
    expect(UPDATE_BUTTON).toBe("Update Ozzie and reopen it");
    expect([CHECK_BUTTON, AUTOMATIC_LABEL, LATER_BUTTON]).toEqual(["Check for a new version", "Check for new versions automatically", "Remind me tomorrow"]);
    const everything = [UPDATE_BUTTON, CHECK_BUTTON, AUTOMATIC_LABEL, AUTOMATIC_HELP, AUTOMATIC_OFF, LATER_BUTTON, REOPEN_NOTE, ...UPDATE_HOW,
      ...Object.values(PROBLEM_TEXT), ...Object.values(PLACE_TEXT), section(ready()), section(view({ automatic: false })), line(ready())].map(text).join(" ");
    expect(everything).not.toMatch(HIDDEN_WORDS);
    expect(everything).not.toMatch(/\b(?:feed|signature|signed|release channel|channel|plugin|updater|manifest|endpoint|approve|install now)\b/iu);
    // What leaves the Mac and why it is safe, said once, under "See how this works".
    expect(UPDATE_HOW[0]).toContain("Nothing about you or your church goes with it");
    expect(UPDATE_HOW[1]).toContain("never installs an older version");
    expect(UPDATE_HOW[2]).toContain("Nothing is installed until you choose Update Ozzie and reopen it");
  });
});

describe("updates: Settings section", () => {
  it("shows the version, when Ozzie last checked, a check now and the automatic setting, on by default", () => {
    const html = section(view());
    const t = text(html);
    expect(t).toContain("Updates");
    expect(t).toContain("This Mac has Ozzie 0.1.1. Last checked today at 9:14 AM.");
    expect(t).toContain("Ozzie is up to date.");
    expect(t).toContain(CHECK_BUTTON);
    expect(t).toContain(AUTOMATIC_LABEL);
    expect(t).toContain(AUTOMATIC_HELP);
    expect(html).toMatch(/<input type="checkbox" checked=""/u);
    expect(hasButton(html, UPDATE_BUTTON)).toBe(false);
    expect(hasButton(html, CHECK_BUTTON)).toBe(true);
    expect(t).toContain("See how this works");
  });

  it("offers the update with what reopening means when a newer version is ready", () => {
    const html = section(ready());
    const t = text(html);
    expect(t).toContain("Ozzie 0.1.2 is ready to install.");
    expect(hasButton(html, UPDATE_BUTTON)).toBe(true);
    expect(t).toContain(REOPEN_NOTE);
  });

  it("with visitor cards open, asks before updating, since reopening discards them (review P, L3)", () => {
    // No cards: the button updates at once, with no question.
    const plain = section(ready());
    expect(plain).not.toContain("visitor card");
    expect(plain).not.toContain("aria-expanded");
    // Cards open: the same button opens a question first, naming what updating does to them.
    const closed = renderToStaticMarkup(React.createElement(UpdatesSection, { state: state(ready()), nowMs: NOW, cards: 2 }));
    expect(closed).toContain('aria-expanded="false"');
    expect(text(closed)).not.toContain("visitor card");
    const asked = renderToStaticMarkup(React.createElement(UpdatesSection, { state: state(ready()), nowMs: NOW, cards: 2, asking: true }));
    expect(text(asked)).toContain(UPDATE_CARDS_ASK(2));
    expect(UPDATE_CARDS_ASK(2)).toBe("You have 2 visitor cards open. Updating closes Ozzie for a moment, which discards them.");
    expect(UPDATE_CARDS_ASK(1)).toBe("You have 1 visitor card open. Updating closes Ozzie for a moment, which discards it.");
    expect(hasButton(asked, UPDATE_DISCARD(2))).toBe(true);
    expect(UPDATE_DISCARD(2)).toBe("Update and discard the cards");
    expect(UPDATE_DISCARD(1)).toBe("Update and discard the card");
    expect(hasButton(asked, UPDATE_KEEP_CARDS)).toBe(true);
    expect(UPDATE_KEEP_CARDS).toBe("Keep the cards and update later");
    expect(asked).toContain('role="group"');
    // The line above Today asks the same way.
    const today = renderToStaticMarkup(React.createElement(UpdateLine, { state: state(ready()), nowMs: NOW, memory: laterMemory(memoryStore()), cards: 1, asking: true }));
    expect(text(today)).toContain(UPDATE_CARDS_ASK(1));
    expect(hasButton(today, UPDATE_DISCARD(1))).toBe(true);
    // Neither answer is the bare word the product language rules forbid.
    for (const label of [UPDATE_DISCARD(1), UPDATE_DISCARD(2), UPDATE_KEEP_CARDS]) expect(label).not.toMatch(/^(approve|confirm|ok|cancel|yes|no)$/iu);
  });

  it("turned off: says checks happen only on request, and the check button stays", () => {
    const html = section(view({ automatic: false }));
    expect(text(html)).toContain(AUTOMATIC_OFF);
    expect(html).not.toMatch(/checked=""/u);
    expect(text(html)).toContain(CHECK_BUTTON);
  });

  it("disables the check while one is under way, and shows a problem as an alert", () => {
    expect(section(view({ phase: "checking" }))).toMatch(/<button type="button" class="btn btn-secondary btn-sm" disabled="">Check for a new version/u);
    const failed = section(view({ problem: "check-failed" }));
    expect(failed).toMatch(/<p class="problem" role="alert">Ozzie couldn&#x27;t check for a new version\. It will try again later\.<\/p>/u);
  });

  it("a copy that can't replace itself says what to do instead of offering the button", () => {
    const dev = section(ready({ place: "not-an-app" }));
    expect(text(dev)).toContain(PLACE_TEXT["not-an-app"]);
    expect(hasButton(dev, UPDATE_BUTTON)).toBe(false);
    expect(text(section(ready({ place: "move-to-applications" })))).toContain("move Ozzie to your Applications folder");
  });

  it("isn't shown until native has answered, and sits after the closed-window section in Settings", () => {
    expect(section(null)).toBe("");
    const settings = text(renderToStaticMarkup(React.createElement(ConnectionPage, {
      status: null, settings: { clientId: "", organization: "", serviceTypeId: "", planId: "" }, onSettings() {}, onStatus() {}, oneClick: false,
      autostart: { get: () => new Promise<boolean>(() => {}), set: () => new Promise<boolean>(() => {}) },
      updates: React.createElement(UpdatesSection, { state: state(view()), nowMs: NOW, cards: 0 }),
    })));
    // The sections themselves, after Settings' index (audit item 27), which names them too.
    const sections = settings.slice(settings.indexOf(`Planning Center and which services Ozzie watches ${promise("readsShort")}`));
    expect(sections.indexOf("When the window is closed")).toBeGreaterThan(-1);
    expect(sections.indexOf("Updates")).toBeGreaterThan(sections.indexOf("When the window is closed"));
    expect(sections.indexOf("Saved checks")).toBeGreaterThan(sections.indexOf("Updates"));
  });
});

describe("updates: the line above Today", () => {
  it("shows nothing unless a newer version is ready", () => {
    expect(line(null)).toBe("");
    expect(line(view())).toBe("");
    expect(line(view({ problem: "check-failed" }))).toBe("");
  });

  it("one calm line with the update and a way to put it off until tomorrow", () => {
    const html = line(ready());
    const t = text(html);
    expect(t).toContain("A new version of Ozzie is ready: 0.1.2.");
    expect(hasButton(html, UPDATE_BUTTON)).toBe(true);
    expect(hasButton(html, LATER_BUTTON)).toBe(true);
    expect(html).toContain('class="banner update-line"');
    expect(html).not.toContain("btn-primary");
  });

  it("\"Remind me tomorrow\" hides it until the next morning, for that version only", () => {
    const store = memoryStore();
    const memory = laterMemory(store);
    memory.later("0.1.2", NOW);
    expect(memory.hidden("0.1.2", NOW)).toBe(true);
    expect(memory.hidden("0.1.2", new Date(2026, 10, 20, 7, 59).getTime())).toBe(true);
    expect(memory.hidden("0.1.2", new Date(2026, 10, 20, 8, 0).getTime())).toBe(false);
    expect(memory.hidden("0.1.3", NOW)).toBe(false);
    expect(line(ready(), memory)).toBe("");
    expect(text(line(ready({ available: "0.1.3" }), memory))).toContain("0.1.3");
    // Once the person has clicked, the steps show even if it had been put off.
    expect(text(line(ready({ phase: "waiting" }), memory))).toContain("Ozzie is finishing what it's doing.");
    // A store that can't be read never hides it.
    expect(laterMemory({ get: () => "{not json", set() {} }).hidden("0.1.2", NOW)).toBe(false);
  });

  it("says each step after the click, and why it stopped if it did", () => {
    expect(text(line(ready({ phase: "downloading" })))).toContain("Getting Ozzie 0.1.2 ready…");
    expect(text(line(ready({ phase: "reopening" })))).toContain("Ozzie is reopening with the new version…");
    expect(hasButton(line(ready({ phase: "downloading" })), UPDATE_BUTTON)).toBe(false);
    const failed = line(ready({ problem: "install-failed" }));
    expect(failed).toContain('role="alert"');
    expect(text(failed)).toContain("Nothing was changed.");
    expect(hasButton(failed, UPDATE_BUTTON)).toBe(true);
    const dev = line(ready({ place: "not-an-app" }));
    expect(text(dev)).toContain(PLACE_TEXT["not-an-app"]);
    expect(hasButton(dev, UPDATE_BUTTON)).toBe(false);
  });
});

describe("updates: the native commands", () => {
  it("asks native for the state, a check, the setting and the install, and nothing else", () => {
    calls.length = 0;
    void updates.status(); void updates.check(); void updates.setAutomatic(false); void updates.install();
    expect(calls).toEqual([["update_status", undefined], ["update_check", undefined], ["update_set_automatic", { on: false }], ["update_install", undefined]]);
    expect(calls.some(([c]) => c.startsWith("plugin:"))).toBe(false);
  });
});
