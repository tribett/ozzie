// First run's screens (onboarding spec §2): the first screen's one sentence, three promises and one button; every promise
// one tap away; the step before the browser; waiting for Allow; back with "Connected to {church}"; each Planning Center
// failure in its fixed words. Rendered without native code (the Tauri bridge never answers here). Fictional data only.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => new Promise(() => {})) }));
import { FirstRun } from "../src/setup-flow.js";
import { BrowserStep, ConnectedBanner, FIRST_RUN, FirstScreen, NotMyChurchSheet, PromisesSheet, WaitingStep } from "../src/first-run-screens.js";
import { connectFailure, FAILURE_TEXT, RESUME_LINE, setupMemory } from "../src/first-run-state.js";
import { allPromises, firstScreenPromises } from "../src/promises.js";
import type { ConnectionStatus } from "../src/connection.js";
import { App, backToName } from "../src/App.js";
import { dayWords, SUNDAY_WORDS, UNKNOWN_WORDS } from "../src/day-words.js";

const text = (html: string) => html.replace(/<[^>]+>/gu, " ").replace(/&#x27;/gu, "'").replace(/&amp;/gu, "&").replace(/\s+/gu, " ");
const none = () => {};
const status = (state: ConnectionStatus["state"], more: Partial<ConnectionStatus> = {}): ConnectionStatus => ({ state, organization: "", checked_at_ms: null, source: "", problem: null, ...more });
const memoryOf = (raw: string | null) => setupMemory({ getItem: () => raw, setItem: () => {} });
const firstRun = (over: Partial<React.ComponentProps<typeof FirstRun>> = {}) => renderToStaticMarkup(React.createElement(FirstRun, {
  status: null, settings: { clientId: "", organization: "", serviceTypeId: "", planId: "" }, onSettings: none, onStatus: none, start: "first",
  read: () => new Promise<never>(() => {}), result: null, rules: false, intervalMinutes: 60, nowMs: Date.UTC(2026, 10, 20, 15), onExample: none, onLeave: none, onDeferred: none,
  builtIn: true, memory: memoryOf(null), ...over,
}));

describe("the first screen (S1)", () => {
  it("one sentence, three promises, one button, and a quiet way to see an example first", () => {
    const t = text(firstRun());
    expect(t).toContain("Ozzie reads your church's Planning Center and tells you what needs you before your next service.");
    for (const line of firstScreenPromises()) expect(t).toContain(line);
    expect(t).toContain("It only reads. It never changes anything in Planning Center.");
    expect(t).toContain("Connect Planning Center");
    expect(t).toContain("See an example church first");
    expect(t).toContain("Read all of Ozzie's promises");
    expect(t).toContain("Free and open source.");
    // Exactly one primary.
    expect(firstRun().match(/btn-primary/gu)).toHaveLength(1);
  });

  it("has no step counter, no name field and no Skip for now", () => {
    const html = firstRun();
    expect(text(html)).not.toMatch(/Step \d of|step \d of/u);
    expect(html).not.toContain("<input");
    expect(text(html)).not.toContain("Skip for now");
    expect(text(html)).not.toContain("Your name");
  });

  it("every promise is one tap away, and the sheet says how to leave it", () => {
    const t = text(renderToStaticMarkup(React.createElement(PromisesSheet, { onClose: none })));
    expect(t).toContain("What Ozzie does, and what it never does");
    for (const line of allPromises()) expect(t).toContain(line);
    expect(t).toContain("Back to setup");
    expect(renderToStaticMarkup(React.createElement(PromisesSheet, { onClose: none }))).toContain('role="dialog"');
  });

  it("lists every read Ozzie can make, before any happens, including one person's contact details for To (review P, L8)", () => {
    const t = text(renderToStaticMarkup(React.createElement(PromisesSheet, { onClose: none })));
    expect(t).toContain("Everything Ozzie can read from Planning Center");
    for (const line of FIRST_RUN.reads) expect(t).toContain(line);
    expect(t).toContain("that person's, and whether Planning Center lists them as a child. One is used to fill in To. They're kept nowhere and never go to an AI.");
    expect(t).toMatch(/Check-Ins and Registrations, as counts only/u);
    // Every read, including the other services those people are scheduled for (review L14), and that allowing People for
    // To also brings Calendar and Groups' reads (review H1).
    expect(t).toContain("and the other services they're scheduled for.");
    expect(t).toContain("Only if you turn them on in Settings: room bookings, follow-ups without an owner and group events");
    expect(t).toContain("Allowing People to fill in To doesn't turn any of these on.");
    expect(t).toMatch(/never a form's answers/u);
  });
});

describe("before the browser (S2)", () => {
  it("two marks, three reassurances, one button, Back, and what Ozzie will read", () => {
    const html = firstRun({ start: "browser" });
    const t = text(html);
    expect(t).toContain("Step 1 of 3");
    // The step is part of the focused title for VoiceOver; the visible eyebrow isn't read twice (review L10).
    expect(firstRun({ start: "browser" })).toMatch(/<h1 id="fr-title"[^>]*><span class="sr-only">Step 1 of 3: <\/span>Next, allow Ozzie/u);
    expect(firstRun({ start: "browser" })).toMatch(/<p class="eyebrow" aria-hidden="true">Step 1 of 3<\/p>/u);
    expect(t).toContain("Next, allow Ozzie to read your Planning Center");
    expect(t).toContain("Your browser will open Planning Center. Sign in as you always do, then choose Allow.");
    expect(t).toContain("Ozzie only reads. It can't change anything in Planning Center.");
    expect(t).toContain("Your password stays with Planning Center. Ozzie never sees it, and you can disconnect any time.");
    expect(t).toContain("Open Planning Center in my browser");
    expect(t).toContain("Back");
    expect(t).toContain("What will Ozzie read?");
    expect(t).toContain("Planning Center's page may say Ozzie could also make changes. That's how Planning Center words every connection. Ozzie still only reads.");
    expect(html).toContain(`aria-label="${FIRST_RUN.pictureAlt}"`);
  });

  it("offline, the button waits for the internet and says why", () => {
    const html = renderToStaticMarkup(React.createElement(BrowserStep, { failure: null, resume: null, offline: true, working: false, onOpen: none, onBack: none, onNotNow: none }));
    expect(text(html)).toContain("This Mac isn't connected to the internet. Connect to Wi-Fi, then try again.");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Open Planning Center in my browser/u);
  });

  it("after a relaunch mid-attempt: one line saying nothing was connected", () => {
    const t = text(firstRun({ start: "browser", memory: memoryOf('{"lastAttempt":"cancelled"}') }));
    expect(t).toContain("Last time, Planning Center didn't finish connecting. Nothing was connected.");
  });

  it("each failure in its own words, as an alert with Try again (and Not now where a step can wait)", () => {
    const denied = text(firstRun({ start: "browser", status: status("cancelled", { problem: "denied" }) }));
    expect(denied).toContain("You chose not to allow Ozzie in Planning Center, so nothing was connected.");
    expect(denied).toContain("Try again");
    expect(denied).toContain("Not now");
    const keychain = renderToStaticMarkup(React.createElement(BrowserStep, { failure: connectFailure(status("failed", { problem: "locked" })), resume: null, offline: false, working: false,
      onOpen: none, onBack: none, onNotNow: none }));
    expect(keychain).toContain('role="alert"');
    expect(text(keychain)).toContain("this Mac didn't let Ozzie keep the connection");
    expect(text(keychain)).not.toContain("Not now");
    // Cancelled here is a plain line, not an alert.
    const cancelled = firstRun({ start: "browser", status: status("cancelled") });
    expect(text(cancelled)).toContain("Nothing was connected.");
    expect(cancelled).not.toContain('role="alert"');
  });

  it("a church that already saw its result connects again without the step counter, and failures say service (review M8)", () => {
    const html = firstRun({ start: "browser", again: true, status: status("expired") });
    const t = text(html);
    expect(t).toContain("Connect Planning Center again");
    expect(t).not.toMatch(/Step \d of 3|Next, allow Ozzie/u);
    expect(t).not.toContain("Sunday");
    expect(text(firstRun({ start: "browser", status: status("failed", { problem: "invalid-token" }) }))).toContain("Connect again to see your service.");
  });

  it("a copy without Ozzie's own registration shows its own form, under its own name", () => {
    expect(text(firstRun({ start: "browser", builtIn: false }))).toContain("For a copy of Ozzie you built yourself");
  });
});

describe("waiting for Allow (S3) and back (S4)", () => {
  it("says what to do in the browser, with a new attempt and Cancel, and no countdown", () => {
    const t = text(firstRun({ start: "browser", status: status("waiting") }));
    expect(t).toContain("Step 2 of 3");
    expect(t).toContain("Waiting for you to choose Allow in your browser");
    expect(t).toContain("Sign in to Planning Center if it asks.");
    expect(t).toContain("If it asks which church, choose yours.");
    // macOS 14+ may keep the browser in front, so the step says both ways back (review M5).
    expect(t).toContain("Choose Allow. Then come back to Ozzie: it comes to the front, or press Go back to Ozzie on that page.");
    expect(t).not.toContain("comes back to the front by itself");
    expect(t).toContain("Open the page again");
    expect(t).toContain("Cancel");
    expect(t).not.toMatch(/five minutes|5 minutes|seconds left/u);
  });

  it("while Planning Center checks, and after four minutes, one calm line", () => {
    expect(text(renderToStaticMarkup(React.createElement(WaitingStep, { checking: true, slow: false, working: false, onAgain: none, onCancel: none }))))
      .toContain("Planning Center said yes. Checking which church it is…");
    expect(text(renderToStaticMarkup(React.createElement(WaitingStep, { checking: false, slow: true, working: false, onAgain: none, onCancel: none }))))
      .toContain("Still there? Ozzie waits about one more minute, then you can start again.");
  });

  it("back from the browser: the church it connected to, when, and a way out if it's the wrong one", () => {
    const t = text(renderToStaticMarkup(React.createElement(ConnectedBanner, { church: "Fictional Grace Church", checkedAt: "4:43 PM", onNotMine: none })));
    expect(t).toContain("Connected to Fictional Grace Church");
    expect(t).toContain("Signed in to Planning Center as part of Fictional Grace Church · checked 4:43 PM");
    expect(t).toContain("This isn't my church");
    const sheet = text(renderToStaticMarkup(React.createElement(NotMyChurchSheet, { church: "Fictional Grace Church", working: false, onDisconnect: none, onKeep: none })));
    expect(sheet).toContain("Disconnect Fictional Grace Church?");
    expect(sheet).toContain("Disconnect and try again");
    expect(sheet).toContain("Keep Fictional Grace Church");
  });
});

describe("the app", () => {
  it("keeps Settings and Visitor cards, and draws no page on a Mac with nothing saved until launch has decided", () => {
    const html = renderToStaticMarkup(React.createElement(App));
    expect(html).toContain("Visitor cards");
    expect(html).toContain("Settings");
    expect(html).not.toContain(FIRST_RUN.title.replace(/'/gu, "&#x27;"));
    // A brand-new Mac shows the first screen at once, with no flash of Today before it (0.3.0 live click-through);
    // a Mac with a church saved shows Today straight away (relaunch.test.ts).
    expect(html).not.toContain("What needs you today");
  });

  it("before connecting, no screen assumes the church meets on Sunday: Ozzie can't know its day yet (walk-through, 2026-11-18)", () => {
    expect(FIRST_RUN.title).toBe("Ozzie reads your church's Planning Center and tells you what needs you before your next service.");
    const before = [
      React.createElement(FirstScreen, { onConnect: none, onExample: none, onPromises: none }),
      React.createElement(PromisesSheet, { onClose: none }),
      React.createElement(BrowserStep, { failure: null, resume: null, offline: false, working: false, onOpen: none, onBack: none, onNotNow: none }),
      React.createElement(BrowserStep, { failure: null, resume: null, offline: false, working: false, onOpen: none, onBack: none, onNotNow: none, again: true }),
      React.createElement(WaitingStep, { checking: false, slow: true, working: false, onAgain: none, onCancel: none }),
    ];
    for (const el of before) expect(text(renderToStaticMarkup(el))).not.toMatch(/Sunday/u);
    for (const line of [...Object.values(FAILURE_TEXT), ...Object.values(RESUME_LINE)]) expect(line).not.toMatch(/Sunday/u);
  });

  it("the AI screens over a page name it by its sidebar name: Back to Services, whatever day the service is on", () => {
    const weekend = dayWords({ sort_date: "2026-11-21T17:00:00Z", times: ["2026-11-21T22:00:00Z", "2026-11-22T15:00:00Z"] }, "America/New_York");
    expect(weekend.kind).toBe("weekend");
    expect(backToName("sunday", UNKNOWN_WORDS)).toBe("Services");
    expect(backToName("sunday", weekend)).toBe("Services");
    expect(backToName("sunday", SUNDAY_WORDS)).toBe("Services");
    expect(backToName("today", UNKNOWN_WORDS)).toBe("Today");
    expect(backToName("connection", UNKNOWN_WORDS)).toBe("Settings");
    expect(backToName("automatic", SUNDAY_WORDS)).toBe("Keeping watch");
  });

  it("the first screen never lists a step counter or the old five steps", () => {
    const t = text(renderToStaticMarkup(React.createElement(FirstScreen, { onConnect: none, onExample: none, onPromises: none })));
    expect(t).not.toMatch(/AI help \(optional\)|Automatic checks and quiet hours|Choose the Sunday to check/u);
  });
});
