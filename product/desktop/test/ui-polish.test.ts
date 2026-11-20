// The UI polish pass: what each screen shows, checked on fixed fictional data with static rendering.
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => new Promise(() => {})) }));
import { nov22Capture } from "../../../core/src/fictional-sunday.js";
import { buildSundayBrief } from "../../../core/src/sunday-brief.js";
import { SundayPage } from "../src/sunday-page.js";
import { TodayPage } from "../src/today-page.js";
import { AskPanel } from "../src/ask-panel.js";
import { ConnectionPage, SavedRecordings } from "../src/connection-page.js";
import { FirstRun } from "../src/setup-flow.js";
import { DEFAULT_PREFS } from "../src/proactive.js";
import { zoneText } from "../src/proactive-page.js";
import { AiSettings } from "../src/ai-settings.js";

const capture = nov22Capture();
const rules = { sundayLeads: [], checkInAfterSundaysInARow: 3 };
const brief = buildSundayBrief(capture, rules, capture.completed_at, true);
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replaceAll("&#x27;", "'").replaceAll("&quot;", "\"").replace(/\s+/g, " ");
const settings = { clientId: "fictional-client", organization: "1001", serviceTypeId: "1500", planId: "92902197" };

describe("Today: the spoken briefing", () => {
  const html = renderToStaticMarkup(React.createElement(TodayPage, { brief, names: capture.names, onSunday: () => {} }));
  it("comes after the decisions, with the written script folded away until asked for", () => {
    expect(html.indexOf("Sunday has")).toBeLessThan(html.indexOf("Listen to today&#x27;s briefing"));
    expect(html.indexOf("Needs a decision")).toBeLessThan(html.indexOf("Listen to today&#x27;s briefing"));
    expect(html).toMatch(/<details class="listen-more"><summary>.*Show what will be read<\/summary>/);
    expect(html).not.toMatch(/<details[^>]*open/);
  });
});

describe("Sunday: a needs-people card with no one to list", () => {
  const t = text(renderToStaticMarkup(React.createElement(SundayPage, {
    brief, names: capture.names, busy: false, problem: "", sender: "Pat", connected: false, hasRecording: false, configured: false,
    canReword: false, decisions: [], onDecisions: () => undefined, operations: null, onCheck: () => undefined, onRecording: () => undefined, onExample: () => undefined,
  })));
  it("has no show/hide toggle, only who could help instead", () => {
    const nursery = t.slice(t.indexOf("Nursery still needs"), t.indexOf("Why I flagged this", t.indexOf("Nursery still needs")));
    expect(nursery).not.toMatch(/Hide people|See who could help/);
    expect(nursery).toContain("You could ask the team's leader who else could help.");
    expect(nursery).toContain("Prepare a note to the team's leader");
    // A card with people keeps its toggle.
    expect(t.slice(t.indexOf("Greeter still needs"), t.indexOf("Nursery still needs"))).toContain("Hide people");
  });
});

describe("Ask Ozzie beside Settings", () => {
  const panel = (page?: string) => renderToStaticMarkup(React.createElement(AskPanel, {
    open: true, onClose: () => {}, ask: null, brief: null, modelReady: false, onOpen: () => {}, ...(page ? { page } : {}),
  }));
  it("offers no button to the page already on screen", () => {
    expect(panel("connection")).not.toContain(">Open Settings</button>");
    // No AI: the same sentence on every page, Settings included; its one step opens the AI choice over the page (App's
    // ChooseAiContext, ask-panel.test.ts), not Settings (walk-through, 2026-11-18).
    expect(panel("connection")).toContain("Ask Ozzie needs AI, but everything else in Ozzie works without it.");
    expect(panel("sunday")).not.toContain(">Open Services</button>");
    expect(panel("today")).not.toContain(">Open Settings</button>");
    expect(panel("today")).toContain(">Open Services</button>");
  });
});

describe("Settings", () => {
  const html = renderToStaticMarkup(React.createElement(ConnectionPage, {
    status: null, settings, onSettings: () => {}, onStatus: () => {}, prefs: DEFAULT_PREFS, onAutomatic: () => {}, onSetup: () => {},
  }));
  it("is titled Settings, with its sections in a fixed order", () => {
    // Named Settings as its eyebrow, under a title like every other page's (polish pass, 2026-11-18; page-polish.test.ts).
    expect(html).toContain("<p class=\"eyebrow\">Settings</p><h1 class=\"h1\">How Ozzie is set up on this Mac</h1>");
    // In the order a leader meets them (audit item 27); Your name on notes second, near the top (audit item 18).
    const order = ["Planning Center and which service Ozzie watches</h2>", "Sign in</h3>", "Which service Ozzie watches</h3>", "Rooms, follow-ups and group events</h3>",
      "Your name on notes</h2>", "AI help</h2>", "What Ozzie runs and notices</h2>", "Keeping watch</h3>", "A notice on your phone</h3>",
      "Church lists</h2>", "Saved checks</h2>", "Check my setup</h2>"].map(s => html.indexOf(s));
    expect(order.every(i => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text(html)).not.toMatch(/wording help/iu);
    // Named as everywhere else (onboarding spec §6): Ozzie keeps an eye on the watched service, by its day.
    expect(text(html)).toContain("Ozzie keeps an eye on your services: at least every hour, and when Ozzie opens.");
    expect(text(html)).toContain("Keep services covered and other jobs are set up in Keeping watch.");
    expect(text(html)).toContain("Change these in Keeping watch");
  });
  it("uses the same sign-in form in first run (a copy built yourself) as Settings, and keeps the plan fields in Settings", () => {
    const connect = renderToStaticMarkup(React.createElement(FirstRun, {
      status: null, settings, onSettings() {}, onStatus() {}, start: "browser", read: () => new Promise<never>(() => {}), result: null, rules: false, intervalMinutes: 60,
      nowMs: 0, onExample() {}, onLeave() {}, onDeferred() {}, builtIn: false,
    }));
    for (const part of [connect, html]) expect(part).toContain("class=\"form connect-form\"");
    for (const label of ["Paste the plan&#x27;s address (optional)", "Service type ID", "Plan ID"]) expect(html).toContain(label);
  });
  it("chooses the Sunday with the same picker as guided setup, typing the plan by hand folded below", () => {
    expect(html).toContain("class=\"picker\"");
    expect(html).toMatch(/<details class="picker-hand"[^>]*><summary>.*My plan isn&#x27;t listed<\/summary>/u);
  });
  it("asks once before deleting saved checks, and says what deleting does", () => {
    const closed = renderToStaticMarkup(React.createElement(SavedRecordings, { count: 3, onDelete: () => {}, sharing: false }));
    expect(closed).toMatch(/<button[^>]*aria-expanded="false"[^>]*aria-controls="delete-recordings"[^>]*>Delete saved checks<\/button>/u);
    expect(closed).not.toContain("Yes, delete");
    const open = text(renderToStaticMarkup(React.createElement(SavedRecordings, { count: 3, onDelete: () => {}, sharing: true, confirming: true })));
    expect(open).toContain("Delete all 3 saved checks from this Mac? Your services can't be shown from them afterwards. The copy for other AI apps is removed too.");
    expect(open).toContain("Yes, delete them");
    expect(open).toContain("Keep them");
    const one = text(renderToStaticMarkup(React.createElement(SavedRecordings, { count: 1, onDelete: () => {}, sharing: false, confirming: true })));
    expect(one).toContain("Delete the saved check from this Mac? Your services can't be shown from it afterwards. Planning Center doesn't change.");
    expect(one).toContain("Keep it");
    expect(text(renderToStaticMarkup(React.createElement(SavedRecordings, { count: 0, onDelete: () => {}, sharing: false, confirming: true }))))
      .toBe(" No saved checks for this church. ");
  });
  it("shows AI in Settings as one line about the AI in use, with no route rows, small buttons or address fields until asked for", () => {
    // The choices themselves are the first-run screens (ai-choice.tsx), opened by "Change"; test/ai-screens.test.ts covers them.
    const ai = renderToStaticMarkup(React.createElement(AiSettings, { onChange: () => {} }));
    expect(ai).toContain("Checking which AI Ozzie uses…");
    expect(ai).not.toMatch(/class="route|btn-sm|ai-other-address|<input/u);
  });
});

describe("click targets: at least 44 by 44 CSS pixels (ui-build-handoff)", () => {
  const css = ["hearth.css", "styles.css"].map(f => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8")).join("\n").replace(/\/\*[\s\S]*?\*\//gu, "");
  /** Every declaration given to `selector` (outside media queries' own selectors too), in order. */
  const decls = (selector: string) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
    .filter(m => m[1]!.split(",").map(x => x.trim().replace(/^\.oz /u, "")).includes(selector)).map(m => m[2]!).join(";");
  const px = (d: string, prop: string) => { const m = new RegExp(`(?:^|[;\\s])${prop}:\\s*(-?\\d+)px`, "gu"); return [...d.matchAll(m)].map(x => Number(x[1])).at(-1) ?? null; };
  /**
   * A visual height plus the hit area its ::after adds above and below ("inset: -Npx ..."). The ::after is placed from
   * inside the control's 1px border, so each side reaches one pixel less beyond the control than its inset says.
   */
  const reach = (selector: string, height: number) => {
    const after = /inset:\s*-(\d+)px/u.exec(decls(`${selector}::after`));
    return height + 2 * Math.max(0, Number(after?.[1] ?? 0) - 1);
  };

  /** A size Hearth keeps as a token on `.oz` (hearth.css), in px. */
  const token = (name: string) => Number(new RegExp(`${name}:(\\d+)px`, "u").exec(css)?.[1] ?? Number.NaN);

  it("small buttons, chips and the microphone look compact but take clicks over 44px; full buttons are 44px (audit item 22b)", () => {
    expect(token("--h-btn")).toBeGreaterThanOrEqual(44);
    expect(decls(".btn")).toMatch(/height:var\(--h-btn\)/u);
    // Small buttons and chips are 40px to look at, sized by the same token.
    expect(token("--h-btn-sm")).toBe(40);
    for (const s of [".btn-sm", ".chip"]) expect(decls(s)).toMatch(/height:var\(--h-btn-sm\)/u);
    expect(px(decls(".btn-sm"), "min-width")).toBeGreaterThanOrEqual(44);
    expect(reach(".btn-sm", token("--h-btn-sm"))).toBeGreaterThanOrEqual(44);
    expect(reach(".chip", token("--h-btn-sm"))).toBeGreaterThanOrEqual(44);
    expect(reach(".ask-mic", px(decls(".ask-mic"), "height")!)).toBeGreaterThanOrEqual(44);
    // The round microphone reaches as far left and right as up and down.
    expect(decls(".ask-mic::after")).toMatch(/inset:\s*-5px\s*(?:;|$)/u);
    for (const s of [".btn-sm", ".chip", ".ask-mic"]) expect(decls(s)).toMatch(/position:\s*relative/u);
    // The source link in an answer: at least 32px tall to look at (it was 26), reaching 44.
    expect(px(decls(".ask-links .src"), "min-height")).toBeGreaterThanOrEqual(32);
    expect(reach(".ask-links .src", px(decls(".ask-links .src"), "min-height")!)).toBeGreaterThanOrEqual(44);
  });

  it("disclosures and checkbox labels are at least 44px tall", () => {
    for (const s of [".listen-more > summary", ".today-aside > summary", ".picker-hand > summary", ".recent-task > summary", ".resp-ended > summary", ".confirmation", ".cards-first a"]) {
      expect(px(decls(s), "min-height"), s).toBeGreaterThanOrEqual(44);
    }
  });

  it("rows of small buttons sit far enough apart that their click areas never overlap", () => {
    // 8px both ways (it was 8px between rows and 4px between buttons in a row: the click areas touched; audit item 22b).
    expect(decls(".find-feedback > .find-next")).toMatch(/gap:\s*8px\s*(?:;|$)/u);
    expect(px(decls(".find-feedback > .find-next"), "margin-top")).toBeGreaterThanOrEqual(8);
    expect(decls(".today-later")).toMatch(/gap:\s*8px/u);
  });
});

describe("the window: only the page pane scrolls (the coordinator's 0.1.8 click-through)", () => {
  const css = ["hearth.css", "styles.css"].map(f => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8")).join("\n").replace(/\/\*[\s\S]*?\*\//gu, "");
  /** The last value `selector` is given for `prop`, in the order the two files apply. */
  const last = (selector: string, prop: string) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
    .filter(m => m[1]!.split(",").map(x => x.trim()).includes(selector))
    .flatMap(m => [...m[2]!.matchAll(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, "gu"))].map(x => x[1]!.trim())).at(-1) ?? null;

  it("the app and its two columns clip what overflows rather than hide it, so nothing can scroll them", () => {
    // "Open" on Sunday's notes box scrolled the whole app up by a few hundred pixels in the real app: `overflow: hidden`
    // still lets a script (scrollIntoView, focus) scroll a box, and the app had more to show than its height because
    // a visually hidden label far down Church lists was placed against the app, not the pane. `clip` can't be scrolled.
    expect(last(".oz.app", "overflow")).toBe("clip");
    expect(last(".oz .shell", "overflow")).toBe("clip");
    for (const root of ["html", "body", "#root"]) expect(last(root, "overflow"), root).toBe("clip");
  });

  it("the page pane places what it positions, so a hidden label scrolls and clips with the page", () => {
    expect(last(".oz .main", "position")).toBe("relative");
    expect(last(".oz .main", "overflow-y")).toBe("auto");
  });
});

describe("a heading focus moves to (audit item 4)", () => {
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//gu, "");
  it("keeps the focus for VoiceOver and the keyboard, with no focus box that reads as a glitch", () => {
    expect(css).toMatch(/\.oz :is\(h1, h2, h3, h4\)\[tabindex="-1"\]:focus \{ outline: none; \}/u);
    // First run's screen title still takes focus, with its ring only for the keyboard.
    const html = renderToStaticMarkup(React.createElement(FirstRun, {
      status: null, settings, onSettings() {}, onStatus() {}, start: "first", read: () => new Promise<never>(() => {}), result: null, rules: false, intervalMinutes: 60,
      nowMs: 0, onExample() {}, onLeave() {}, onDeferred() {}, builtIn: true,
    }));
    expect(html).toMatch(/<h1 id="fr-title" class="fr-title" tabindex="-1">/u);
    expect(readFileSync(new URL("../src/first-run.css", import.meta.url), "utf8")).toContain(".oz .fr-title:focus { outline: none; }");
    // Every control keeps its ring.
    expect(readFileSync(new URL("../src/hearth.css", import.meta.url), "utf8")).toContain(".oz :focus-visible,.oz .is-focus{outline:3px solid var(--focus);outline-offset:2px}");
  });
});

describe("What runs automatically: time zone", () => {
  it("names the church's zone when a check read it, and says when this Mac's clock differs", () => {
    expect(zoneText("America/Chicago", "America/New_York")).toMatch(/^Central Time \(Chicago\), the church's time zone in Planning Center\. Times on this page and quiet hours follow this Mac's clock: Eastern Time \(New York\)\.$/);
    expect(zoneText("America/New_York", "America/New_York")).toContain("This Mac is on the same time.");
    expect(zoneText(null, "America/New_York")).toMatch(/^Eastern Time \(New York\), this Mac's time\. The church's own time zone shows here once a check reads it/);
  });
});
