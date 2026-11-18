// The words pass (onboarding spec §6, P7): one name for each thing, and none of the words people shouldn't have to know.
// Every page this lane owns, rendered on fixed data: no "skills", "sessions", "agent", "log", "connector" or "harness"
// anywhere in what a person reads (text, labels, placeholders), and "Keychain" only inside a "See how this works" fold.
// The retired names (§6) are gone from these pages.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => new Promise(() => {})) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { DayProvider } from "../src/day-words.js";
import { TodayPage } from "../src/today-page.js";
import { DRAFT_FOOTER, SundayPage } from "../src/sunday-page.js";
import { RulesPage } from "../src/rules-page.js";
import { ProactivePage } from "../src/proactive-page.js";
import { ActivityPage } from "../src/activity-page.js";
import { ConnectionPage } from "../src/connection-page.js";
import { AskPanel } from "../src/ask-panel.js";
import { QuitQuestion } from "../src/quit-question.js";
import { createProactive, DEFAULT_PREFS, type KeyValueStore } from "../src/proactive.js";
import { sundayProblem, type Settings } from "../src/sunday-source.js";
import { promise } from "../src/promises.js";
import { buildSundayBrief } from "../../../core/src/sunday-brief.js";
import { captureToCoverage, type SundayRules } from "../../../core/src/sunday-capture.js";
import { sundayOperations } from "../../../core/src/operations-capture.js";
import { TEAMS } from "../../../core/src/fictional-sunday.js";
import { withKidsTeam } from "../../../core/src/kids-rules.js";
import { wednesdayWithOperations, wednesdayWords } from "../../../core/test/fixtures/service-days/wednesday.js";

const NOW = "2026-11-20T15:10:00Z";
const ZONE = "America/New_York";
const settings: Settings = { clientId: "", organization: "1001", serviceTypeId: "1500", planId: "92902197" };
const rules: SundayRules = withKidsTeam({ sundayLeads: [{ team_id: TEAMS.nursery, lead_position: "Nursery Lead" }], checkInAfterSundaysInARow: 3 }, TEAMS.nursery, 2);
const capture = wednesdayWithOperations();
const brief = buildSundayBrief(capture, rules, NOW);
const memoryStore = (): KeyValueStore => { const data = new Map<string, string>(); return { get: k => data.get(k) ?? null, set: (k, v) => { data.set(k, v); } }; };
const page = (el: React.ReactElement) => renderToStaticMarkup(React.createElement(DayProvider, { value: wednesdayWords() }, el));

/** The words a person should never have to know (AGENTS.md product language; spec §6). Case-insensitive, whole words. */
const FORBIDDEN = /\b(?:skills?|sessions?|agents?|logs?|logged|connectors?|harness)\b/iu;
/** What a person reads: text and the attributes a screen reader or a field shows. Tags, classes and ids are code. */
function readable(html: string): string {
  const attrs = [...html.matchAll(/\b(?:aria-label|placeholder|title|alt)="([^"]*)"/gu)].map(m => m[1]);
  return `${html.replace(/<[^>]+>/gu, " ")} ${attrs.join(" ")}`.replaceAll("&#x27;", "'").replaceAll("&quot;", "\"").replace(/\s+/gu, " ");
}
/** The same, with every "See how this works" fold taken out: the one place "Keychain" may be said. */
const outsideHowItWorks = (html: string) => readable(html.replace(/<details\b[^>]*>\s*<summary>(?:(?!<\/summary>)[\s\S])*See how this works<\/summary>[\s\S]*?<\/details>/gu, " "));
/** Without the "For a copy of Ozzie you built yourself" fold: the one place a church's number and its ID field may show (§6). */
const outsideOwnCopy = (html: string) => readable(html.replace(/<details\b[^>]*>\s*<summary>(?:(?!<\/summary>)[\s\S])*For a copy of Ozzie you built yourself<\/summary>[\s\S]*?<\/details>/gu, " "));

async function proactiveView() {
  let now = "2026-11-20T15:00:00Z";
  const p = createProactive({
    store: memoryStore(), now: () => now, timeZone: () => ZONE, notify: async () => {}, problem: sundayProblem, timers: { setInterval: () => 0, clearInterval: () => {} },
    check: async () => ({ ...capture, completed_at: now }),
  });
  p.start({ context: () => ({ settings, rules, status: { state: "connected", organization: "1001", checked_at_ms: null, source: "", problem: null } }), onStatus: () => {}, onCapture: () => {} });
  await p.tick();
  now = "2026-11-20T16:00:00Z";
  return p.view();
}

const PAGES: Record<string, () => Promise<string> | string> = {
  Today: () => page(React.createElement(TodayPage, { brief, names: capture.names, onSunday: () => {}, now: NOW, zone: ZONE, store: memoryStore(),
    regular: { ready: true, paused: true, running: false, intervalMinutes: 60, runOnLaunch: true, last: null, next: null, missed: [] } })),
  "Today, not connected": () => page(React.createElement(TodayPage, { brief: null, onSunday: () => {}, now: NOW, zone: ZONE, store: memoryStore(),
    notConnected: { onConnect: () => {}, onExample: () => {} } })),
  "The service page": () => page(React.createElement(SundayPage, {
    brief, names: capture.names, busy: false, problem: "", sender: "Pat", connected: true, hasRecording: true, configured: true, canReword: false,
    decisions: [], onDecisions: () => {}, operations: sundayOperations(capture, rules, { now: NOW }), onCheck: () => {}, onRecording: () => {}, onExample: () => {},
  })),
  "The service page, refused": () => page(React.createElement(SundayPage, {
    brief: null, names: {}, busy: false, problem: sundayProblem("denied"), sender: "", connected: true, hasRecording: false, configured: true, canReword: false,
    decisions: [], onDecisions: () => {}, operations: null, onCheck: () => {}, onRecording: () => {}, onExample: () => {}, refused: true, onSettings: () => {},
  })),
  "Church rules": () => page(React.createElement(RulesPage, { rules, onChange: () => {}, positions: captureToCoverage(capture, rules, NOW).positions, names: capture.names, rooms: [] })),
  "Keeping watch": async () => page(React.createElement(ProactivePage, {
    view: await proactiveView(), names: capture.names, organization: "1001", planId: "92902197", readiness: "ready", busy: false, now: "2026-11-20T16:05:00Z",
    onCheckNow: () => {}, onPause: () => {}, onResume: () => {}, onPrefs: () => {},
  })),
  "What happened": () => page(React.createElement(ActivityPage, { capture })),
  Settings: () => page(React.createElement(ConnectionPage, {
    status: null, settings, onSettings: () => {}, onStatus: () => {}, oneClick: true, prefs: DEFAULT_PREFS, onAutomatic: () => {}, onSetup: () => {}, onCheckSetup: () => {},
    autostart: { get: async () => false, set: async () => false }, recordingCount: 1, onDeleteRecordings: () => {}, nameStore: { get: () => "", set: () => {} },
    sharing: { on: true, onChange: () => {} }, siri: { on: true, onChange: () => {}, problem: null },
  })),
  "The Ask panel": () => page(React.createElement(AskPanel, { open: true, onClose: () => {}, ask: () => new Promise<never>(() => {}), brief, modelReady: true, onOpen: () => {} })),
  "Asking before quitting": () => page(React.createElement(QuitQuestion, { ask: { cards: 1, checks: true }, onQuit: () => {}, onKeep: () => {} })),
};

describe("the words a person reads (onboarding spec §6)", () => {
  for (const [name, render] of Object.entries(PAGES)) {
    it(`${name}: no word people shouldn't have to know, and Keychain only under See how this works`, async () => {
      const html = await render();
      expect(readable(html).match(FORBIDDEN)?.[0] ?? null).toBeNull();
      expect(outsideHowItWorks(html)).not.toMatch(/Keychain/u);
      // The retired names (spec §6), each replaced by one name for the thing.
      for (const old of ["What runs automatically", "regular Sunday check", "Automatic checks", "Check saved connection", "Sign in again", "Disconnect and revoke access",
        "Advanced: use your own Planning Center registration", "placeholders like", "Guided setup"]) {
        expect(readable(html), old).not.toContain(old);
      }
      for (const id of ["organization 1001", "Organization ID"]) expect(outsideOwnCopy(html), id).not.toContain(id);
    });
  }

  it("Settings keeps Keychain inside its fold, says the menu bar the plain way first, and names the promise once", async () => {
    const html = await PAGES.Settings!();
    const t = readable(html);
    expect(t).toContain("Keychain");
    expect(t.indexOf("the small Ozzie picture at the top of your screen")).toBeLessThan(t.indexOf("the menu bar"));
    expect(t).toContain(`${promise("readsShort")} Planning Center's page may say Ozzie could also make changes. That's how Planning Center words every connection. ${promise("still")}`);
    expect(t).toContain("For a copy of Ozzie you built yourself");
    expect(t).toContain("Start Ozzie when this Mac starts");
  });

  it("Settings checking a sign-in says which church it is checking, never \"the organization\" (spec §6; walk-through, 2026-11-18)", () => {
    const html = page(React.createElement(ConnectionPage, {
      status: { state: "checking", organization: "1001", checked_at_ms: null, source: "", problem: null }, settings, onSettings: () => {}, onStatus: () => {}, oneClick: true,
      prefs: DEFAULT_PREFS, nameStore: { get: () => "", set: () => {} },
    }));
    expect(readable(html)).toContain("Checking which church it is with Planning Center…");
    expect(outsideOwnCopy(html)).not.toMatch(/\borganization\b/iu);
  });

  it("a note's footer says stand-ins, and claims only what is true: the names Ozzie read (NM4)", () => {
    expect(DRAFT_FOOTER).toBe("Ozzie never sends messages. The AI sees stand-ins like [Volunteer A] instead of the names Ozzie reads from Planning Center.");
    expect(DRAFT_FOOTER).not.toMatch(/placeholder/iu);
  });
});
