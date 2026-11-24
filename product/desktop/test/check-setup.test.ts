// "Check my setup" (onboarding spec §4.3, P6): each row's verdicts and its one fix button, from native's setup_check
// (a fake, test/onboarding-fakes.ts) or, where native can't say or hasn't the command yet, from what the page knows;
// "Check again" reads everything again; "Copy a report" copies codes only. Fictional church only.
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { installFakeDom } from "./fake-dom.js";
import { fakeNative } from "./onboarding-fakes.js";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => new Promise(() => {})) }));
import { aiFrom, CHECK_TITLE, CheckMySetup, COPIED, FIX_LABEL, planningCenterFrom, setupRows, UNKNOWN, type CheckFacts, type SetupKnown, type SetupRow } from "../src/check-setup.js";
import { parseSetupCheck, type SetupCheck } from "../src/onboarding-bridge.js";
import { DayProvider, dayWords } from "../src/day-words.js";
import type { ConnectionStatus } from "../src/connection.js";
import type { ModelStatus } from "../src/model.js";

const dom = installFakeDom();
const ZONE = "America/Chicago";
const AT = Date.parse("2026-11-17T15:12:00Z"); // 9:12 AM in Chicago
const CHURCH = "Fictional Church of the Prairie";
const connected: ConnectionStatus = { state: "connected", organization: "123456", checked_at_ms: AT, source: "keychain", problem: null, scopes: "services", organization_name: CHURCH };
const ready: ModelStatus = { configured: true, route: "own", label: "OpenAI-compatible", setup: "ready" };
const KNOWN: SetupKnown = { connection: connected, watched: { service: "Sunday Morning", follows: true }, ai: ready, aiCompany: "openai" };
const nativeCheck = (over: Record<string, unknown> = {}) => ({
  planning_center: "connected", church: CHURCH, checked_at_ms: AT, service: "watching", ai: "ready", ai_route: "own", ai_provider: "openai",
  notices: "allowed", start_with_mac: "on", report: "planning_center: connected\nai: ready", ...over,
});
const facts = (over: Record<string, unknown> = {}, extra: Partial<CheckFacts> = {}): CheckFacts =>
  ({ check: parseSetupCheck(nativeCheck(over)), notices: "unknown", startOn: null, ...extra });
const row = (rows: SetupRow[], id: SetupRow["id"]) => rows.find(r => r.id === id)!;
const rowsOf = (f: CheckFacts, k: SetupKnown = KNOWN, date: string | null = "Sunday, November 22") => setupRows(f, k, { date, zone: ZONE });
const said = (r: SetupRow) => [r.verdict, r.fix ? FIX_LABEL[r.fix] : null];

describe("each row's verdict and its one fix", () => {
  it("the test copy has no Starting with this Mac row: it has no login item", () => {
    const f = facts({});
    expect(setupRows(f, KNOWN, { date: "Sunday, November 22", zone: ZONE }).some(r => r.id === "start")).toBe(true);
    expect(setupRows(f, KNOWN, { date: "Sunday, November 22", zone: ZONE }, true).some(r => r.id === "start")).toBe(false);
  });

  it("Planning Center", () => {
    expect(said(row(rowsOf(facts()), "planning-center"))).toEqual([`Connected to ${CHURCH} · checked 9:12 AM`, null]);
    expect(said(row(rowsOf(facts({ planning_center: "sign-in-again" })), "planning-center"))).toEqual(["Needs you to connect again", "Connect again"]);
    expect(said(row(rowsOf(facts({ planning_center: "unreachable" })), "planning-center"))).toEqual(["Can't reach Planning Center right now", "Try again"]);
    expect(said(row(rowsOf(facts({ planning_center: "not-connected" })), "planning-center"))).toEqual(["Not connected yet", "Connect Planning Center"]);
  });

  it("the service Ozzie watches, on its real day", () => {
    expect(said(row(rowsOf(facts()), "service"))).toEqual(["Sunday, November 22 · Sunday Morning · moves on by itself", "Choose a different one"]);
    expect(said(row(rowsOf(facts({ service: "waiting" }), { ...KNOWN, watched: { service: "Youth Night", follows: true } }), "service")))
      .toEqual(["Waiting for the next Youth Night plan", "Choose a different one"]);
    expect(said(row(rowsOf(facts({ service: "none" }), { ...KNOWN, watched: null }), "service"))).toEqual(["No service chosen", "Choose a service"]);
    expect(said(row(rowsOf(facts({ service: "passed" }), KNOWN, "Wednesday, November 19"), "service")))
      .toEqual(["Wednesday, November 19 has passed · Ozzie moves on to the next one by itself", "Choose a different one"]);
    expect(said(row(rowsOf(facts({ service: "unknown" }), { ...KNOWN, watched: { service: "Sunday Morning", follows: false } }), "service")))
      .toEqual(["Sunday, November 22 · Sunday Morning", "Choose a different one"]);
  });

  it("AI, by route and company", () => {
    const ai = (over: Record<string, unknown>, k: Partial<SetupKnown> = {}) => said(row(rowsOf(facts(over), { ...KNOWN, ...k }), "ai"));
    expect(ai({})).toEqual(["ChatGPT, with your key · set up", "Change"]);
    expect(ai({}, { aiAnsweredAtMs: AT + 120_000 })).toEqual(["ChatGPT, with your key · answered at 9:14 AM", "Change"]);
    expect(ai({ ai: "none", ai_route: "none", ai_provider: null })).toEqual(["No AI (everything else works)", "Change"]);
    expect(ai({ ai: "no-key" })).toEqual(["OpenAI has no key saved on this Mac", "Check the key"]);
    expect(ai({}, { aiKeyRefused: true })).toEqual(["OpenAI didn't accept the key", "Check the key"]);
    expect(ai({ ai: "paused", ai_route: "managed", ai_provider: null }, { aiPausedUntil: "December 17" })).toEqual(["Ozzie's AI: paused until December 17", "See my plan"]);
    expect(ai({ ai: "month-limit", ai_provider: "anthropic" }, { aiPausedUntil: "December 1" })).toEqual(["Claude, with your key: paused until December 1", "Change"]);
    expect(ai({ ai: "not-checked", ai_route: "local", ai_provider: null })).toEqual(["AI on this Mac hasn't been checked yet", "Change"]);
    expect(ai({ ai: "ready", ai_route: "local", ai_provider: null }, { aiNotAnswering: true })).toEqual(["AI on this Mac isn't answering", "Open Ollama"]);
    expect(ai({ ai: "not-connected", ai_route: "managed", ai_provider: null })).toEqual(["Ozzie's AI isn't connected on this Mac", "Change"]);
    expect(ai({ ai: "reconnect", ai_route: "managed", ai_provider: null })).toEqual(["Ozzie's AI needs you to connect again", "Change"]);
    expect(ai({ ai: "ready", ai_provider: "gemini" })).toEqual(["Gemini, with your key · set up", "Change"]);
  });

  it("notices, starting with this Mac, and phone notices only when they were turned on", () => {
    const of = (over: Record<string, unknown>, id: SetupRow["id"], k: Partial<SetupKnown> = {}) => said(row(rowsOf(facts(over), { ...KNOWN, ...k }), id));
    expect(of({}, "notices")).toEqual(["Allowed", null]);
    expect(of({ notices: "denied" }, "notices")).toEqual(["Turned off for Ozzie in System Settings", "Open Notifications settings"]);
    expect(of({ notices: "not-asked" }, "notices")).toEqual(["Not asked yet", "Open Notifications settings"]);
    // This build can't read the setting (contract N8): said plainly, with the pane to look in.
    expect(of({ notices: "unknown" }, "notices")).toEqual(["Ozzie can't see this setting. Check in System Settings that Ozzie may send notices.", "Open Notifications settings"]);
    expect(of({}, "start")).toEqual(["On", null]);
    expect(of({ start_with_mac: "off" }, "start")).toEqual(["Off: Ozzie checks only while you have it open", "Turn it on"]);
    expect(rowsOf(facts()).map(r => r.id)).toEqual(["planning-center", "service", "ai", "notices", "start"]);
    expect(of({}, "phone", { phone: { on: true, lastTestMs: Date.parse("2026-11-20T18:00:00Z") } })).toEqual(["On · last test November 20", "Open phone settings"]);
    expect(of({}, "phone", { phone: { on: false, lastTestMs: null } })).toEqual(["Off", "Open phone settings"]);
  });
});

describe("before native's setup_check is built: what the page knows, and Couldn't check just now only where nothing does", () => {
  const none: CheckFacts = { check: null, notices: "denied", startOn: false };
  it("fills every row from the page's own statuses", () => {
    const rows = rowsOf(none);
    expect(rows.map(said)).toEqual([
      [`Connected to ${CHURCH} · checked 9:12 AM`, null],
      ["Sunday, November 22 · Sunday Morning · moves on by itself", "Choose a different one"],
      ["ChatGPT, with your key · set up", "Change"],
      ["Turned off for Ozzie in System Settings", "Open Notifications settings"],
      ["Off: Ozzie checks only while you have it open", "Turn it on"],
    ]);
  });

  it("says Couldn't check just now only for what nothing knows", () => {
    const rows = rowsOf({ check: null, notices: "unknown", startOn: null }, { connection: null, watched: null, ai: null });
    expect(rows.map(r => r.verdict)).toEqual([UNKNOWN, "No service chosen", UNKNOWN, "Ozzie can't see this setting. Check in System Settings that Ozzie may send notices.", UNKNOWN]);
    expect(rows.filter(r => r.verdict === UNKNOWN).every(r => r.fix === null)).toBe(true);
  });

  it("reads the connection and AI statuses the page has", () => {
    const status = (state: ConnectionStatus["state"], problem: unknown = null) => ({ ...connected, state, problem });
    expect(planningCenterFrom(status("failed", "invalid-token"))).toBe("sign-in-again");
    expect(planningCenterFrom(status("failed", "provider-failure"))).toBe("unreachable");
    expect(planningCenterFrom(status("failed", "locked"))).toBe("unknown");
    expect(planningCenterFrom(status("disconnected"))).toBe("not-connected");
    expect(planningCenterFrom(status("waiting"))).toBe("unknown");
    expect(aiFrom({ configured: false, route: "none", label: "" })).toBe("none");
    expect(aiFrom({ ...ready, setup: "no-key" })).toBe("no-key");
    expect(aiFrom({ ...ready, setup: "own-key-not-bound" })).toBe("no-key");
    expect(aiFrom({ configured: true, route: "managed", label: "", setup: "ready", account: { plan: "personal", allowance_steps: 1, used_steps: 1, period_ends: "2026-12-17", warning: "paused", checked_at_ms: AT, offline: false } })).toBe("paused");
    expect(aiFrom({ configured: true, route: "managed", label: "", setup: "reconnect" })).toBe("reconnect");
  });
});

describe("the page", () => {
  async function mount(replies: Record<string, unknown>, k: SetupKnown = KNOWN, wrap?: (e: React.ReactElement) => React.ReactElement) {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const native = fakeNative(replies);
    const pressed: string[] = [];
    const clipboard: string[] = [];
    const autostart = { get: vi.fn(async () => false) };
    const box = dom.root.appendChild((dom.root.ownerDocument as unknown as { createElement(t: string): typeof dom.root }).createElement("div"));
    const root = createRoot(box as unknown as Element);
    const page = React.createElement(CheckMySetup, {
      known: k, serviceTypeId: "1500", planId: "92902197", planDate: "2026-11-22", bridge: native.bridge, autostart, zone: ZONE, clock: () => AT,
      copy: async (t: string) => { clipboard.push(t); },
      onConnect: () => pressed.push("connect"), onChooseService: () => pressed.push("service"), onChangeAi: () => pressed.push("ai"),
      onOpenNotices: () => pressed.push("notices"), onTurnOnStart: () => pressed.push("start"), onPhone: () => pressed.push("phone"), onCheckAgain: () => pressed.push("again"),
    });
    await act(async () => { root.render(wrap ? wrap(page) : page); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    const press = async (label: string) => {
      const b = dom.button(label);
      if (!b) throw new Error(`no button "${label}" in ${dom.seen()}`);
      await act(async () => { dom.press(b); await new Promise(r => setTimeout(r, 0)); });
    };
    return { native, pressed, clipboard, autostart, press, unmount: async () => { await act(async () => { root.unmount(); }); dom.root.removeChild(box); } };
  }

  it("checks once when it opens, shows each row, and Check again reads everything again", async () => {
    const m = await mount({ setup_check: nativeCheck({ notices: "denied", start_with_mac: "off" }), notification_permission: "denied" });
    expect(dom.seen()).toContain(CHECK_TITLE);
    expect(dom.seen()).toContain("Checked at 9:12 AM.");
    expect(dom.seen()).toContain(`Connected to ${CHURCH} · checked 9:12 AM`);
    // The watched plan's own local date goes too, so native can tell "passed" from a plan it just didn't list (contract L7).
    expect(m.native.calls.filter(c => c.command === "setup_check")).toEqual([{ command: "setup_check", args: { serviceTypeId: "1500", planId: "92902197", planDate: "2026-11-22" } }]);
    await m.press("Open Notifications settings");
    await m.press("Turn it on");
    await m.press("Change");
    expect(m.pressed).toEqual(["notices", "start", "ai"]);
    await m.press("Check again");
    expect(m.pressed.at(-1)).toBe("again");
    expect(m.native.calls.filter(c => c.command === "setup_check")).toHaveLength(2);
    await m.unmount();
  });

  it("works without native's setup_check: rows from the page, notices and the Mac's own answers", async () => {
    const m = await mount({ notification_permission: "allowed" });
    expect(m.autostart.get).toHaveBeenCalled();
    expect(dom.seen()).toContain("Allowed");
    expect(dom.seen()).toContain("Off: Ozzie checks only while you have it open");
    expect(dom.seen()).not.toContain(UNKNOWN);
    await m.unmount();
  });

  it("Copy a report copies codes only: no church, no service name, no key", async () => {
    const m = await mount({ setup_check: nativeCheck({ report: `planning_center: connected\nchurch: ${CHURCH}` }), notification_permission: "allowed" });
    await m.press("Copy a report");
    expect(m.clipboard).toHaveLength(1);
    const report = m.clipboard[0]!;
    expect(report).toContain("planning-center: connected");
    expect(report).toContain("ai-company: openai");
    expect(report).toContain("from-native: left-out");
    for (const secret of [CHURCH, "Prairie", "Sunday Morning", "123456"]) expect(report).not.toContain(secret);
    expect(dom.seen()).toContain(COPIED);
    await m.unmount();
  });

  it("names the watched service's real day", async () => {
    const wednesday = dayWords({ sort_date: "2026-11-25T19:00:00Z" }, null);
    const m = await mount({ setup_check: nativeCheck() }, { ...KNOWN, watched: { service: "Youth Night", follows: true } },
      page => React.createElement(DayProvider, { value: wednesday }, page));
    expect(dom.seen()).toContain("Wednesday, November 25 · Youth Night · moves on by itself");
    expect(dom.seen()).not.toContain("Sunday");
    await m.unmount();
  });

  it("before the first answer: just the title and a calm waiting line", () => {
    const html = renderToStaticMarkup(React.createElement(CheckMySetup, {
      known: KNOWN, bridge: fakeNative({}).bridge, autostart: { get: async () => true }, onConnect() {}, onChooseService() {}, onChangeAi() {}, onOpenNotices() {}, onTurnOnStart() {}, onPhone() {},
    }));
    expect(html).toContain(">Check my setup</h2>");
    expect(html).toContain('role="status" aria-live="polite"');
    expect(html.match(/btn-primary/gu)).toHaveLength(1);
    expect(html).not.toMatch(/\b(skills?|sessions?|agent|log|connector|harness|Keychain)\b/iu);
  });
});

describe("the native reply is read strictly", () => {
  it("anything unexpected is unknown, never shown as text", () => {
    const odd = parseSetupCheck({ ...nativeCheck(), service: "<b>soon</b>", ai: "great", notices: 1, start_with_mac: null }) as SetupCheck;
    const rows = rowsOf({ check: odd, notices: "unknown", startOn: null }, { ...KNOWN, ai: null });
    expect(rows.map(r => r.verdict).join(" ")).not.toMatch(/soon|great/u);
    expect(row(rows, "service").verdict).toBe("Sunday, November 22 · Sunday Morning · moves on by itself");
    expect(row(rows, "ai").verdict).toBe(UNKNOWN);
  });
});

// Polish 4: everything this screen times happened on this Mac, so it is on this Mac's clock, never the church's.
describe("Check my setup's times are this Mac's", () => {
  it("every time on it follows the zone it is given, and App gives it this Mac's zone, never the church's", () => {
    const k: SetupKnown = { ...KNOWN, aiAnsweredAtMs: AT + 120_000, phone: { on: true, lastTestMs: Date.parse("2026-11-17T05:30:00Z") } };
    const verdicts = (zone: string) => setupRows(facts({}), k, { date: "Sunday, November 22", zone }).map(r => r.verdict).join(" | ");
    // A Mac in Tokyo with a church in Chicago: checked and answered at Tokyo's 12:12 and 12:14 AM, the last test on Tokyo's November 17.
    expect(verdicts("Asia/Tokyo")).toContain(`Connected to ${CHURCH} · checked 12:12 AM`);
    expect(verdicts("Asia/Tokyo")).toContain("answered at 12:14 AM");
    expect(verdicts("Asia/Tokyo")).toContain("On · last test November 17");
    expect(verdicts(ZONE)).toContain("On · last test November 16");
    // The page is given this Mac's zone (App.tsx), whatever zone the church's check reads in.
    const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
    const element = /<CheckMySetup\b[^]*?\/>/u.exec(app)![0];
    expect(element).toMatch(/\bzone=\{macZone\(\)\}/u);
    expect(element).not.toMatch(/time_zone/u);
    expect(/const macZone = \(\) => Intl\.DateTimeFormat\(\)\.resolvedOptions\(\)\.timeZone;/u.test(app)).toBe(true);
  });
});
