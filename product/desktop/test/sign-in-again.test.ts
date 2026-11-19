// Every sign-in again asks for what the church holds (review 2026-11-18, late). Settings' "Connect again" asked
// Planning Center for Services alone, so allowing it dropped Calendar, People and Groups (and Check-Ins and
// Registrations) while the rooms, follow-ups and group switch still said on. Now every plain sign-in for a church saved on
// this Mac sends native `again` with that church, and native asks for what its saved sign-in holds, for the reads only
// while they are on (main.rs `again_ask`, tested there). Each entry point: Settings' Connect again and Connect Planning
// Center after Planning Center stopped accepting the saved sign-in (the renewal card sends the person there), the
// registration typed under Advanced, first run's and Today's Sign in again, and "Sign in to {church} instead" in both
// places. A first sign-in, with no church known, stays a plain one. Fictional data only.
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ calls: [] as { command: string; args: Record<string, unknown> }[] }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args: Record<string, unknown> = {}) => {
    native.calls.push({ command, args });
    switch (command) {
      case "planning_center_app": return true;
      case "connect_planning_center_app": case "connect_planning_center":
        return { state: "waiting", organization: "", checked_at_ms: null, source: "", problem: null };
      case "answer_church_switch": return { status: { state: "connected", organization: "1001", checked_at_ms: 1, source: "", problem: null }, client_id: "", organization: "1001" };
      case "operations_reads": return true;
      case "connection_status": return null;
      default: return new Promise(() => {});
    }
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
import { installFakeDom } from "./fake-dom.js";
import { ConnectionPage } from "../src/connection-page.js";
import { FirstRun } from "../src/setup-flow.js";
import { setupMemory } from "../src/first-run-state.js";
import { FIRST_RUN } from "../src/first-run-screens.js";
import { againFor, type ConnectionStatus, type SwitchQuestion } from "../src/connection.js";
import { resetOperationsReads } from "../src/operations-reads.js";

const dom = installFakeDom();
const SETTINGS = { clientId: "", organization: "1001", serviceTypeId: "1500", planId: "92902197" };
const status = (over: Partial<ConnectionStatus> = {}): ConnectionStatus => ({
  state: "connected", organization: "1001", checked_at_ms: 1, source: "native", problem: null,
  in_use: { organization: "1001", client_id: "" }, scopes: "services-and-operations+check-ins", ...over,
});
const without = (s: ConnectionStatus, ...keys: (keyof ConnectionStatus)[]) => { const c = { ...s }; for (const k of keys) delete c[k]; return c; };
/** Planning Center stopped accepting the saved sign-in: the renewal card and Today send the person to sign in again. */
const REFUSED = without(status({ state: "failed", problem: "invalid-token", checked_at_ms: null }), "in_use", "scopes");
/** The church in use while "Ozzie found a saved sign-in for organization 6006" is asked. */
const FOUND = without(status({ state: "stored-unchecked" }), "scopes");
const found: SwitchQuestion = { id: 9, to: "6006", from: "1001", from_name: "Fictional Grace Church", from_client: "", others: ["1001"], fresh: false };
const sent = () => native.calls.filter(c => c.command.startsWith("connect_planning_center")).map(c => [c.command, c.args]);
const tick = () => new Promise(r => setTimeout(r, 0));

async function mount(element: React.ReactElement) {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.root as unknown as Element);
  await act(async () => { root.render(element); });
  for (let i = 0; i < 5; i++) await act(async () => { await tick(); });
  return {
    press: async (label: string) => {
      const b = dom.button(label);
      if (!b) throw new Error(`no "${label}" in: ${dom.seen().slice(0, 900)}`);
      await act(async () => { dom.press(b); await tick(); });
      for (let i = 0; i < 5; i++) await act(async () => { await tick(); });
    },
    unmount: async () => { await act(async () => { root.unmount(); }); },
  };
}
const settingsPage = (s: ConnectionStatus | null, over: Record<string, unknown> = {}) => React.createElement(ConnectionPage, {
  status: s, settings: SETTINGS, onSettings: () => {}, onStatus: () => {}, oneClick: true, phone: null, ...over,
});
const firstRun = (s: ConnectionStatus | null, over: Record<string, unknown> = {}) => React.createElement(FirstRun, {
  status: s, settings: SETTINGS, onSettings: () => {}, onStatus: () => {}, start: "browser", read: () => new Promise<never>(() => {}), result: null,
  rules: false, intervalMinutes: 60, nowMs: Date.UTC(2026, 10, 20, 15), onExample: () => {}, onLeave: () => {}, onDeferred: () => {},
  builtIn: true, memory: setupMemory({ getItem: () => null, setItem: () => {} }), again: true, ...over,
});

beforeEach(() => { native.calls = []; resetOperationsReads(); });

describe("which church a sign-in again is for", () => {
  it("the church in use, else the one the saved sign-in is bound to, else Settings'; none for a first sign-in", () => {
    expect(againFor(status(), SETTINGS)).toBe("1001");
    expect(againFor(status({ in_use: { organization: "2002", client_id: "" } }), SETTINGS)).toBe("2002");
    expect(againFor(REFUSED, SETTINGS)).toBe("1001");
    expect(againFor({ ...REFUSED, organization: "" }, { organization: "3003" })).toBe("3003");
    // Disconnected: nothing is saved, so Settings' church (native then asks for Services alone).
    expect(againFor(without(status({ state: "disconnected", organization: "4004" }), "in_use"), SETTINGS)).toBe("1001");
    expect(againFor(null, { organization: "" })).toBe("");
    expect(againFor({ state: "waiting", organization: "" }, { organization: "x" })).toBe("");
  });
});

describe("Settings", () => {
  it("Connect again asks for what the church holds, never Services alone", async () => {
    const page = await mount(settingsPage(status()));
    await page.press("Connect again");
    expect(sent()).toEqual([["connect_planning_center_app", { again: "1001" }]]);
    await page.unmount();
  });

  it("after Planning Center stopped accepting the saved sign-in (the renewal card's Connect again in Settings), the same", async () => {
    const page = await mount(settingsPage(REFUSED));
    await page.press("Connect Planning Center");
    expect(sent()).toEqual([["connect_planning_center_app", { again: "1001" }]]);
    await page.unmount();
  });

  it("with a registration typed under Advanced, for the church those IDs name", async () => {
    const page = await mount(settingsPage(REFUSED, { oneClick: false, settings: { ...SETTINGS, clientId: "fictional-client" } }));
    await page.press("Connect Planning Center");
    expect(sent()).toEqual([["connect_planning_center", { clientId: "fictional-client", organization: "1001", registered: true, again: "1001" }]]);
    await page.unmount();
  });

  it("Sign in to {church} instead asks for what that church's saved sign-in holds", async () => {
    const page = await mount(settingsPage({ ...FOUND, switch: found }));
    await page.press("Sign in to organization 6006 instead");
    expect(native.calls.map(c => c.command)).toContain("answer_church_switch");
    expect(sent()).toEqual([["connect_planning_center_app", { again: "6006" }]]);
    await page.unmount();
  });

  it("the choices that ask for something else keep their own asks", async () => {
    // Connect again with Services only narrows on purpose; the reads switch goes off first.
    const page = await mount(settingsPage(status(), { operationsReads: true }));
    await page.press("Connect again with Services only");
    expect(sent()).toEqual([["connect_planning_center_app", { checkIns: true }]]);
    const order = native.calls.map(c => c.command);
    expect(native.calls.find(c => c.command === "set_operations_reads")?.args).toEqual({ on: false, pressed: true });
    expect(order.indexOf("set_operations_reads")).toBeLessThan(order.indexOf("connect_planning_center_app"));
    await page.unmount();
  });
});

describe("first run and Today", () => {
  it("Sign in again for a church saved here (Today's Connect Planning Center, Check my setup's Connect again) asks for what it holds", async () => {
    const page = await mount(firstRun(REFUSED));
    await page.press(FIRST_RUN.tryAgain);
    expect(sent()).toEqual([["connect_planning_center_app", { again: "1001" }]]);
    await page.unmount();
  });

  it("a first connection on a new Mac stays a plain sign-in", async () => {
    const page = await mount(firstRun(null, { settings: { ...SETTINGS, organization: "" }, again: false }));
    await page.press(FIRST_RUN.open);
    expect(sent()).toEqual([["connect_planning_center_app", {}]]);
    await page.unmount();
  });

  it("Sign in to {church} instead inside first run asks for what that church holds", async () => {
    const page = await mount(firstRun({ ...FOUND, switch: found }));
    await page.press("Sign in to organization 6006 instead");
    expect(sent()).toEqual([["connect_planning_center_app", { again: "6006" }]]);
    await page.unmount();
  });
});
