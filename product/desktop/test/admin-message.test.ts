// "Copy a message for your administrator" (walk-through, 2026-11-18): wherever a refusal says a Planning Center
// administrator at the church can give the account access, one button copies a short, ready-to-send message. It names
// what Ozzie is, that it only reads, the Services permission Ozzie needs (Viewer: the lowest level that sees plans the
// person isn't scheduled on) and where an administrator changes it, as Planning Center's own help says it. It holds no
// name, church, service or number. Fictional data; the clipboard is a stand-in.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => new Promise(() => {})) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
import { installFakeDom } from "./fake-dom.js";
import { text } from "./harness-fakes.js";
import { ADMIN_COPIED, ADMIN_COPY, adminMessage, CHECK_REFUSED, choicesProblem, PICKER_REFUSED, sundayProblem, type Settings } from "../src/sunday-source.js";
import { CopyForAdministrator } from "../src/planning-center-forms.js";
import { SundayPage } from "../src/sunday-page.js";
import { SundayChoicesView } from "../src/sunday-picker.js";
import { ProactivePage } from "../src/proactive-page.js";
import { createProactive, type KeyValueStore } from "../src/proactive.js";
import { promise } from "../src/promises.js";
import { nov22Capture } from "../../../core/src/fictional-sunday.js";

const dom = installFakeDom();
afterEach(() => { vi.unstubAllGlobals(); });
const BUTTON = `>${ADMIN_COPY}</button>`;

describe("the message", () => {
  it("is short and plain: what Ozzie is, that it only reads, the permission it needs and where it's changed", () => {
    const m = adminMessage();
    expect(ADMIN_COPY).toBe("Copy a message for your administrator");
    expect(m).toBe("Hi! I'd like to use Ozzie, an app on my Mac that reads our church's Planning Center Services to show me who's scheduled and what still needs people. "
      + `${promise("request")} Planning Center doesn't let my account see our service plans yet. Could you give my account the Viewer permission in Services? `
      + "In Services, open People, choose my name, then Actions, then Manage permissions. Set People and Plans to Viewer, then choose Update. Thank you!");
    // The build's own promise, from promises.ts only (form B: this build can make the one change a person confirms).
    expect(m).toContain(promise("request"));
    expect(promise("request")).toBe("It changes nothing unless I confirm it.");
    expect(m.length).toBeLessThan(520);
    // No name, church, service, number or address: nothing beyond what the person sees on screen.
    expect(m).not.toMatch(/\d|@|https?:|Grace|Fictional|Sunday Morning|\[/u);
    expect(m).not.toMatch(/\b(?:API|OAuth|scope|token|Keychain|organization)\b/iu);
  });
});

describe("beside every refusal that says an administrator can give access", () => {
  const page = (problem: string, refused: boolean) => renderToStaticMarkup(React.createElement(SundayPage, {
    brief: null, names: {}, busy: false, problem, sender: "", connected: true, hasRecording: false, configured: true, canReword: false,
    decisions: [], onDecisions: () => undefined, operations: null, onCheck: () => undefined, onRecording: () => undefined, onExample: () => undefined,
    refused, onSettings: () => undefined,
  }));

  it("the service page's refused check, and its one-line form", () => {
    const html = page(sundayProblem("denied"), true);
    expect(text(html)).toContain("A Planning Center administrator at your church can give that account access to it in Planning Center Services.");
    expect(html).toContain(BUTTON);
    // The same refusal said as one line (a check refused when the page can't offer its steps).
    expect(sundayProblem("denied")).toBe(CHECK_REFUSED);
    expect(page(CHECK_REFUSED, false)).toContain(BUTTON);
    // Never beside a problem an administrator can't fix.
    for (const other of [sundayProblem("rate-limited"), sundayProblem("provider-failure"), sundayProblem("not-connected")]) expect(page(other, false)).not.toContain(ADMIN_COPY);
  });

  it("Settings' list of services, when Planning Center refused it", () => {
    const settings: Settings = { clientId: "", organization: "1001", serviceTypeId: "", planId: "" };
    const view = (problem: string) => renderToStaticMarkup(React.createElement(SundayChoicesView, {
      connected: true, settings, onSettings() {}, types: { state: "problem", text: problem }, plans: { state: "idle" }, typeId: "", onType() {},
      handOpen: false, onHand() {}, onRetry() {}, now: "2026-11-18T15:00:00Z",
    }));
    expect(choicesProblem("denied")).toBe(PICKER_REFUSED);
    expect(view(PICKER_REFUSED)).toContain(BUTTON);
    expect(view(choicesProblem("rate-limited"))).not.toContain(ADMIN_COPY);
  });

  it("Keeping watch, when the last check was refused", async () => {
    const data = new Map<string, string>();
    const store: KeyValueStore = { get: k => data.get(k) ?? null, set: (k, v) => { data.set(k, v); } };
    const view = async (error: unknown) => {
      data.clear();
      const p = createProactive({ store, now: () => "2026-11-20T15:00:00Z", timeZone: () => "America/New_York", notify: async () => {}, problem: sundayProblem,
        timers: { setInterval: () => 0, clearInterval: () => {} }, check: async () => { throw error; } });
      p.start({ context: () => ({ settings: { clientId: "", organization: "1001", serviceTypeId: "1500", planId: "92902197" }, rules: { sundayLeads: [], checkInAfterSundaysInARow: 3 },
        status: { state: "connected", organization: "1001", checked_at_ms: null, source: "", problem: null } }), onStatus: () => {}, onCapture: () => {} });
      await p.tick();
      return renderToStaticMarkup(React.createElement(ProactivePage, { view: p.view(), names: nov22Capture().names, organization: "1001", planId: "92902197", readiness: "ready",
        busy: false, now: "2026-11-20T15:05:00Z", onCheckNow: () => {}, onPause: () => {}, onResume: () => {}, onPrefs: () => {} }));
    };
    const refused = await view("denied");
    expect(text(refused)).toContain(`The last check couldn't finish. ${CHECK_REFUSED}`);
    expect(refused).toContain(BUTTON);
    expect(await view("rate-limited")).not.toContain(ADMIN_COPY);
  });
});

describe("pressing it", () => {
  /** `writeText`: this Mac's clipboard, stood in for after React's own first look at the browser. */
  async function mount(writeText: (t: string) => Promise<void>) {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const root = createRoot(dom.root as unknown as Element);
    await act(async () => { root.render(React.createElement(CopyForAdministrator)); });
    const press = async () => { await act(async () => { dom.press(dom.button(ADMIN_COPY)!); await Promise.resolve(); }); };
    return { press, unmount: async () => { await act(async () => { root.unmount(); }); } };
  }

  it("copies the message and says Copied, as Ozzie's other copy buttons do", async () => {
    const copied: string[] = [];
    const m = await mount(async t => { copied.push(t); });
    expect(dom.seen()).not.toContain(adminMessage());
    await m.press();
    expect(copied).toEqual([adminMessage()]);
    expect(dom.button("Copied")).not.toBeNull();
    expect(dom.seen()).toContain(ADMIN_COPIED);
    expect(ADMIN_COPIED).toBe("Copied. Paste it into an email or a message to your Planning Center administrator.");
    await m.unmount();
  });

  it("when this Mac won't copy, shows the message to select and copy by hand", async () => {
    const m = await mount(async () => { throw new Error("not allowed"); });
    await m.press();
    expect(dom.seen()).toContain("That couldn't be copied. Select the message below and copy it yourself.");
    expect(dom.seen()).toContain(adminMessage());
    expect(dom.seen()).not.toContain(ADMIN_COPIED);
    await m.unmount();
  });
});
