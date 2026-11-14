// The UI polish pass: what each screen shows, checked on fixed fictional data with static rendering.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => new Promise(() => {})) }));
import { nov22Capture } from "../../../core/src/fictional-sunday.js";
import { buildSundayBrief } from "../../../core/src/sunday-brief.js";
import { AskSession } from "../../../core/src/ask.js";
import { SundayPage } from "../src/sunday-page.js";
import { TodayPage } from "../src/today-page.js";
import { AskPanel } from "../src/ask-panel.js";
import { ConnectionPage } from "../src/connection-page.js";
import { SetupFlow } from "../src/setup-flow.js";
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
    open: true, onClose: () => {}, session: new AskSession(), brief: null, names: {}, organization: "", decisions: [], modelReady: false, sender: "", onOpen: () => {}, ...(page ? { page } : {}),
  }));
  it("offers no button to the page already on screen", () => {
    expect(panel("connection")).not.toContain(">Open Settings</button>");
    expect(panel("connection")).toContain("Set one up in Wording help on this page.");
    expect(panel("sunday")).not.toContain(">Open Sunday</button>");
    expect(panel("today")).toContain(">Open Settings</button>");
    expect(panel("today")).toContain(">Open Sunday</button>");
  });
});

describe("Settings", () => {
  const html = renderToStaticMarkup(React.createElement(ConnectionPage, {
    status: null, settings, onSettings: () => {}, onStatus: () => {}, prefs: DEFAULT_PREFS, onAutomatic: () => {}, onSetup: () => {},
  }));
  it("is titled Settings, with its sections in a fixed order", () => {
    expect(html).toContain("<h1 class=\"h1\">Settings</h1>");
    const order = ["Planning Center</h2>", "Sign in</h3>", "Which Sunday</h3>", "Rooms, follow-ups and group events</h3>",
      "Wording help</h2>", "Automatic checks</h2>", "Saved recordings</h2>", "Guided setup</h2>"].map(s => html.indexOf(s));
    expect(order.every(i => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text(html)).toContain("Every hour, and when Ozzie opens.");
    expect(text(html)).toContain("Change these in What runs automatically");
  });
  it("uses the same sign-in form and Sunday fields as guided setup", () => {
    const connect = renderToStaticMarkup(React.createElement(SetupFlow, {
      status: null, settings, onSettings() {}, onStatus() {}, prefs: DEFAULT_PREFS, onModel() {}, onClose() {}, onExample() {}, onAutomatic() {}, initial: "connect",
    }));
    const sunday = renderToStaticMarkup(React.createElement(SetupFlow, {
      status: null, settings, onSettings() {}, onStatus() {}, prefs: DEFAULT_PREFS, onModel() {}, onClose() {}, onExample() {}, onAutomatic() {}, initial: "sunday",
    }));
    for (const part of [connect, html]) expect(part).toContain("class=\"form connect-form\"");
    for (const label of ["Paste the plan&#x27;s address (optional)", "Service type ID", "Plan ID"]) {
      expect(sunday).toContain(label);
      expect(html).toContain(label);
    }
  });
  it("shows each wording-help route as one row with one action, and the own-provider fields only when asked for", () => {
    const ai = renderToStaticMarkup(React.createElement(AiSettings, { onChange: () => {} }));
    expect(ai.match(/<li class="route"/g)).toHaveLength(3);
    expect(ai.match(/>Use this<\/button>/g)).toHaveLength(2);
    expect(ai).toContain(">Set up</button>");
    expect(ai).not.toContain("own-url");
  });
});

describe("What runs automatically: time zone", () => {
  it("names the church's zone when a check read it, and says when this Mac's clock differs", () => {
    expect(zoneText("America/Chicago", "America/New_York")).toMatch(/^.*\(America\/Chicago\), the church's time zone in Planning Center\. Times on this page and quiet hours follow this Mac's clock: .*\(America\/New_York\)\.$/);
    expect(zoneText("America/New_York", "America/New_York")).toContain("This Mac is on the same time.");
    expect(zoneText(null, "America/New_York")).toMatch(/\(America\/New_York\), this Mac's time\. The church's own time zone shows here once a check reads it/);
  });
});
