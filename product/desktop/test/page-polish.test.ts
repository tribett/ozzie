// The owner's polish pass on page copy and layout (click-through of 0.3.1, 2026-11-18), on fixed fictional data: every
// page headed the same way, What happened's rows opening with the app's own chevron, and Church rules' first card named
// so a pastor understands it at a glance. Visitor cards and Church lists have their own tests (cards-page.test.ts,
// church-sources.test.ts); the next step on a room or follow-up card is in sunday-page.test.ts.
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => new Promise(() => {})) }));
import { nov22Capture } from "../../../core/src/fictional-sunday.js";
import { CardReviewController } from "../../src/card-review/controller.js";
import { ActivityPage } from "../src/activity-page.js";
import { CardsReview, emptyUi } from "../src/cards-page.js";
import { ConnectionPage } from "../src/connection-page.js";
import { DEFAULT_PREFS } from "../src/proactive.js";
import { ProactivePage } from "../src/proactive-page.js";
import { newSchedule } from "../../../core/src/schedule.js";
import { RulesPage } from "../src/rules-page.js";
import type { UpdatesState } from "../src/updates.js";
import { UpdatesSection } from "../src/updates-view.js";
import { PhoneNoticeSection } from "../src/phone-notice-section.js";
import { row, text } from "./harness-fakes.js";

const settings = { clientId: "fictional-client", organization: "1001", serviceTypeId: "1500", planId: "92902197" };
const rules = { sundayLeads: [], checkInAfterSundaysInARow: 3 };
const PAGES = {
  "Visitor cards": () => renderToStaticMarkup(React.createElement(CardsReview, {
    controller: new CardReviewController("fictional-test", { foreground: () => true, createURL: () => "blob:x", revokeURL() {}, decode: async () => true }),
    ticket: null, ui: emptyUi, people: {}, lines: {}, onChoose() {}, onCopy() {}, onDiscard() {}, onSource() {}, onRemoved() {},
  })),
  "Church rules": () => renderToStaticMarkup(React.createElement(RulesPage, { rules, onChange: () => undefined, positions: [] })),
  "What happened": () => renderToStaticMarkup(React.createElement(ActivityPage, { capture: nov22Capture(), tasks: [] })),
  "Keeping watch": () => renderToStaticMarkup(React.createElement(ProactivePage, {
    view: { prefs: DEFAULT_PREFS, schedule: newSchedule(), history: [], latest: {}, running: false, unseen: 0 }, names: {}, organization: "1001", planId: "92902197",
    readiness: "ready", busy: false, now: "2026-11-20T15:00:00Z", onCheckNow() {}, onPause() {}, onResume() {}, onPrefs() {},
  })),
  Settings: () => renderToStaticMarkup(React.createElement(ConnectionPage, {
    status: null, settings, onSettings: () => {}, onStatus: () => {}, prefs: DEFAULT_PREFS, onAutomatic: () => {}, onSetup: () => {},
  })),
};

describe("every page is headed the same way: the page's name small above, then one title that says something", () => {
  for (const [name, render] of Object.entries(PAGES)) {
    it(name, () => {
      const html = render();
      const m = /^<div class="col[^"]*"[^>]*><p class="eyebrow">([^<]+)<\/p><h1 class="h1">([^<]+)<\/h1>/u.exec(html);
      expect(m, html.slice(0, 160)).not.toBeNull();
      expect(m![1]).toBe(name);
      expect(m![2]).not.toBe(name);
      // The title is still the page's first heading, and its only h1.
      expect(html.match(/<h1\b/gu)).toHaveLength(1);
      expect(html.search(/<h[1-6]\b/u)).toBe(html.indexOf("<h1"));
    });
  }

  it("Settings says what it holds, in the same voice as the other pages", () => {
    const t = text(PAGES.Settings());
    // Then where to make the text bigger (accessibility audit B1: View › Bigger Text), then the index.
    expect(t).toMatch(/^ Settings How Ozzie is set up on this Mac Which church and service Ozzie reads, how it uses AI and tells you things, and what it keeps here\. To make everything bigger, press ⌘ and \+ \(Command and plus\)\. ⌘ and − makes it smaller, and ⌘ and 0 puts it back\. They are also in the View menu, and Ozzie keeps your choice\. On this page /u);
  });

  it("What happened says the example church's reads are fictional, never from Planning Center (first-run walk, 2026-11-25)", () => {
    const real = text(renderToStaticMarkup(React.createElement(ActivityPage, { capture: nov22Capture(), tasks: [] })));
    expect(real).toContain("Planning Center · started");
    const example = text(renderToStaticMarkup(React.createElement(ActivityPage, { capture: nov22Capture(), tasks: [], fictional: true })));
    expect(example).toContain("Fictional example data · started");
    expect(example).not.toContain("Planning Center · started");
    const check = { started_at: "2026-11-20T15:00:00Z", reads: [] };
    const system = text(renderToStaticMarkup(React.createElement(ActivityPage, { capture: null, tasks: [], system: { name: "B1 Church", check }, fictional: true })));
    expect(system).toContain("Fictional example data · started");
    expect(system).not.toContain("B1 Church · started");
  });

  it("Settings puts its title where every other page does: 16px under the eyebrow, though its sections sit closer", () => {
    const css = ["hearth.css", "styles.css"].map(f => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8")).join("\n").replace(/\/\*[\s\S]*?\*\//gu, "");
    const decls = (selector: string) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
      .filter(m => m[1]!.split(",").map(x => x.trim().replace(/^\.oz /u, "")).includes(selector)).map(m => m[2]!).join(";");
    const px = (d: string, prop: string) => { const m = new RegExp(`(?:^|[;\\s])${prop}:\\s*(-?\\d+)px`, "gu"); return [...d.matchAll(m)].map(x => Number(x[1])).at(-1) ?? null; };
    const colGap = px(decls(".col"), "gap")!;
    expect(colGap).toBe(16);
    const settingsGap = px(decls(".settings"), "gap")!;
    const titleMargin = /margin:\s*(\d+)px 0/u.exec(decls(".settings > .h1"))?.[1];
    expect(settingsGap + Number(titleMargin ?? 0)).toBe(colGap);
  });
});

describe("What happened: each row opens like every other fold in the app", () => {
  const tasks = [row({ kind: "check", state: "verified" })];
  const html = renderToStaticMarkup(React.createElement(ActivityPage, { capture: nov22Capture(), tasks }));

  it("shows the chevron icon before the row's words, never the browser's own triangle", () => {
    expect(html).toMatch(/<details class="recent-task"><summary><svg class="ic ic-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"><\/path><\/svg><span>[^<]+<\/span><\/summary>/u);
    // Still a native fold: the summary is what the keyboard reaches and what VoiceOver reads (the icon is hidden from it).
    expect(html).not.toMatch(/<summary[^>]*(?:role|tabindex|aria-)/u);
    expect(html).not.toContain("▶");
  });

  it("hides the marker, turns the chevron when open, and keeps a 44px row", () => {
    const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.oz \.recent-task > summary \{[^}]*list-style: none;[^}]*\}/u);
    expect(css).toMatch(/\.oz \.recent-task > summary::-webkit-details-marker \{ display: none; \}/u);
    expect(css).toMatch(/\.oz \.recent-task\[open\] > summary \.ic \{ transform: rotate\(90deg\); \}/u);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \.oz \.recent-task > summary \.ic \{ transition: none; \} \}/u);
    expect(css).not.toMatch(/\.recent-task > summary \{[^}]*list-style-position/u);
  });
});

describe("Settings: every fold shows it opens, with the same chevron", () => {
  // The steps by hand for Siri and for other AI apps show once native answers: siri-shortcuts.test.ts, other-ai-apps-setup.test.ts.
  it("See how this works (Planning Center, other AI apps, Siri and Shortcuts, Updates) and the plan picker, outside AI help", () => {
    const updates: UpdatesState = {
      view: { current: "0.3.1", automatic: true, lastCheckedMs: null, phase: "idle", available: null, problem: null, place: "app", autopilot: false, probe: false },
      check() {}, setAutomatic() {}, install() {},
    };
    const html = renderToStaticMarkup(React.createElement(ConnectionPage, {
      status: null, settings, onSettings: () => {}, onStatus: () => {}, prefs: DEFAULT_PREFS, onAutomatic: () => {}, onSetup: () => {},
      sharing: { on: true, onChange: () => {} }, siri: { on: true, onChange: () => {}, problem: null },
      updates: React.createElement(UpdatesSection, { state: updates, nowMs: Date.parse("2026-11-18T15:00:00Z"), cards: 0 }),
      // A notice on your phone is another lane's section; AI help has its own screens (ai-screens.test.ts).
      phone: null,
    }));
    const outsideAi = html.slice(0, html.indexOf('aria-labelledby="ai-title"')) + html.slice(html.indexOf('aria-labelledby="runs-title"'));
    const summaries = [...outsideAi.matchAll(/<summary[^>]*>([\s\S]*?)<\/summary>/gu)].map(m => m[1]!);
    expect(summaries.length).toBeGreaterThanOrEqual(5);
    for (const s of summaries) expect(s, s).toMatch(/^<svg class="ic ic-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"><\/path><\/svg>/u);
    expect(summaries.filter(s => s.endsWith("See how this works"))).toHaveLength(4);
  });
});

describe("the last folds with the browser's triangle: A notice on your phone, AI help, Ended recently", () => {
  const CHEVRON = '<svg class="ic ic-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"></path></svg>';
  const source = (file: string) => readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
  it("A notice on your phone's See how this works opens with the same chevron", () => {
    const html = renderToStaticMarkup(React.createElement(PhoneNoticeSection, { initial: { on: false, channel: null } }));
    expect(html).toContain(`<details class="listen-more"><summary>${CHEVRON}See how this works</summary>`);
  });
  it("AI help's fold and Keeping watch's Ended recently do too, with the marker hidden and the chevron turned when open", () => {
    expect(source("ai-settings.tsx")).toContain('<details className="ai-more"><summary><Icon name="chev" small />{AI.howTitle}</summary>');
    expect(source("responsibility-views.tsx")).toContain('<details className="resp-ended"><summary><Icon name="chev" small />Ended recently</summary>');
    const css = source("styles.css");
    expect(css).toMatch(/\.oz \.resp-ended > summary \{[^}]*list-style: none;[^}]*\}/u);
    expect(css).toMatch(/\.oz \.resp-ended > summary::-webkit-details-marker \{ display: none; \}/u);
    expect(css).toMatch(/\.oz \.resp-ended\[open\] > summary \.ic \{ transform: rotate\(90deg\); \}/u);
    // AI help's fold already had its styles (ai-screens.css): only the icon was missing.
    expect(source("ai-screens.css")).toMatch(/\.oz \.ai-more\[open\] > summary \.ic \{ transform: rotate\(90deg\); \}/u);
    // None of these three is left without the chevron.
    for (const file of ["ai-settings.tsx", "phone-notice-section.tsx", "responsibility-views.tsx"]) {
      expect(source(file), file).not.toMatch(/<summary>(?!<Icon name="chev" small \/>)/u);
    }
  });
});

describe("Keeping watch's See how this works opens like every other fold, after what is running (review 2026-11-19)", () => {
  const CHEVRON = '<svg class="ic ic-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"></path></svg>';
  const source = (file: string) => readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
  it("is the app's See how this works fold, with the chevron, below the card and never above it", () => {
    const html = PAGES["Keeping watch"]();
    const fold = html.indexOf(`<details class="listen-more watch-how"><summary>${CHEVRON}See how this works</summary><ul class="small"><li>`);
    expect(fold).toBeGreaterThan(-1);
    expect(html.indexOf(">Last check<")).toBeLessThan(fold);
    expect(html.indexOf("<h2", fold)).toBe(html.indexOf('<h2 id="changes-title"'));
    // Both places that render it, the list on Keeping watch and the page without it, build it the same way.
    for (const file of ["responsibility-views.tsx", "proactive-page.tsx"]) {
      expect(source(file), file).toContain('<details className="listen-more watch-how"><summary><Icon name="chev" small />See how this works</summary>');
      expect(source(file), file).not.toMatch(/<summary>(?!<Icon name="chev" small \/>)/u);
    }
    // The fold's own styles: the marker hidden, the chevron turned when open, no turning for reduced motion.
    const css = source("styles.css");
    expect(css).toMatch(/\.oz \.listen-more > summary \{[^}]*list-style: none;[^}]*\}/u);
    expect(css).toMatch(/\.oz \.listen-more > summary::-webkit-details-marker \{ display: none; \}/u);
    expect(css).toMatch(/\.oz \.listen-more\[open\] > summary \.ic \{ transform: rotate\(90deg\); \}/u);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \.oz \.listen-more > summary \.ic \{ transition: none; \} \}/u);
  });
});

describe("Church rules' See how this works opens like every other fold (review 2026-11-19)", () => {
  it("shows the chevron, which turns when open, never an info icon turned on its side", () => {
    const src = readFileSync(new URL("../src/rules-page.tsx", import.meta.url), "utf8");
    expect(src).toContain('<summary><Icon name="chev" small />See how this works</summary>');
    expect(src).not.toMatch(/<summary><Icon name="info"/u);
  });
});

describe("Church rules: the first card names itself plainly", () => {
  it("is about someone serving many weeks in a row, with its care note and its number", () => {
    const html = renderToStaticMarkup(React.createElement(RulesPage, { rules, onChange: () => undefined, positions: [] }));
    const t = text(html);
    expect(html).toContain('<h2 class="h3">Serving many weeks in a row</h2>');
    expect(t).not.toContain("Check in after weeks in a row");
    expect(t).toContain("Serving many weeks in a row Flag anyone confirmed this many weeks in a row, so a person can check in. It's about care, not performance. Weeks in a row");
    expect(t).toContain("Flag at 3");
  });

  it("says what a not-shared room means in two sentences, not one of 35 words", () => {
    const t = text(renderToStaticMarkup(React.createElement(RulesPage, { rules, onChange: () => undefined, positions: [], rooms: [{ room_id: "hall", name: "Fellowship Hall" }] })));
    expect(t).toContain("For a room set as not shared, Ozzie counts its setup time before each booking and reads Calendar's own conflict records. "
      + "An overlap Calendar lists as not yet resolved shows as Room use needs review. Overlaps in a room with no rule set, or that Ozzie can't confirm, show as Worth a look.");
  });
});
