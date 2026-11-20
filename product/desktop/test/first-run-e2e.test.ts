// The whole first run on a fake native side (onboarding spec §7 lane T): S1 → S5e in 3 clicks for a church with one
// service (Connect Planning Center · Open Planning Center in my browser · Allow, in the browser), 4 with two services (the
// pick). The browser's Allow is the status native reports next; the read returns the fictional church's recorded check.
// Fictional data only; nothing native runs.
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { installFakeDom } from "./fake-dom.js";

type Status = { state: string; organization: string; checked_at_ms: number | null; source: string; problem: unknown; organization_name?: string };
const native = vi.hoisted(() => ({ status: null as Status | null, calls: [] as string[] }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string) => {
    native.calls.push(command);
    if (command === "planning_center_app") return true;
    if (command === "connect_planning_center_app") { native.status = { state: "waiting", organization: "", checked_at_ms: null, source: "", problem: null }; return native.status; }
    if (command === "connection_status") return native.status;
    if (command === "cancel_connection") { native.status = { state: "cancelled", organization: "", checked_at_ms: null, source: "", problem: null }; return null; }
    return new Promise(() => {});
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
import { FirstRun } from "../src/setup-flow.js";
import { setupMemory } from "../src/first-run-state.js";
import type { ResultView } from "../src/your-service.js";
import type { ConnectionStatus } from "../src/connection.js";
import type { Settings } from "../src/sunday-source.js";
import { defaultRules } from "../src/sunday-source.js";
import { buildSundayBrief, sundayShownCount } from "../../../core/src/sunday-brief.js";
import { applyDecisions } from "../../../core/src/sunday-decisions.js";
import { nov22Capture } from "../../../core/src/fictional-sunday.js";
import type { SundayCapture } from "../../../core/src/sunday-capture.js";
import { decisionLines } from "../src/today-groups.js";
import { fakeNative, pickReply, SATURDAY_NIGHT, SUNDAY_MORNING } from "./onboarding-fakes.js";

const dom = installFakeDom();
const tick = () => new Promise(r => setTimeout(r, 0));
const all = (n: { childNodes: unknown[] }): unknown[] => [n, ...n.childNodes.flatMap(c => all(c as { childNodes: unknown[] }))];
const buttonStarting = (text: string) => all(dom.root as unknown as { childNodes: unknown[] })
  .find(n => (n as { tagName?: string }).tagName === "BUTTON" && ((n as { textContent: string }).textContent ?? "").startsWith(text)) as Parameters<typeof dom.press>[0] | undefined;

const resultOf = (c: SundayCapture): ResultView => {
  const brief = buildSundayBrief(c, defaultRules, "2026-11-20T15:01:00Z", false);
  const decided = applyDecisions(brief, []);
  const counts = sundayShownCount(decided, null);
  return { brief, capture: c, counts: { decisions: counts.decisions, looks: counts.looks }, lines: decisionLines(decided.items, { rooms: 0, followUps: 0 }, "America/Chicago").named };
};

async function run(services: unknown[]) {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  native.status = null; native.calls = [];
  const kept = new Map<string, string>();
  const memory = setupMemory({ getItem: k => kept.get(k) ?? null, setItem: (k, v) => { kept.set(k, v); } });
  const fake = fakeNative({ pick_service: pickReply(...services) });
  const left = vi.fn();
  let clicks = 0;
  let setStatusOutside: (s: ConnectionStatus | null) => void = () => {};
  function Parent() {
    const [status, setStatus] = React.useState<ConnectionStatus | null>(null);
    const [settings, setSettings] = React.useState<Settings>({ clientId: "", organization: "", serviceTypeId: "", planId: "" });
    const [result, setResult] = React.useState<ResultView | null>(null);
    setStatusOutside = setStatus;
    return React.createElement(FirstRun, {
      status, settings, onSettings: setSettings, onStatus: s => setStatus(s), start: "first", bridge: fake.bridge, memory, builtIn: true,
      read: async () => { const c = { ...nov22Capture(), plan_id: settings.planId || "92902197" }; setResult(resultOf(c)); return c; },
      result, rules: false, intervalMinutes: 60, nowMs: Date.parse("2026-11-20T15:00:00Z"), onExample() {}, onLeave: left, onDeferred() {},
      renderAi: done => React.createElement("div", null, React.createElement("p", null, "How should Ozzie use AI?"),
        React.createElement("button", { type: "button", onClick: () => done("none") }, "No AI for now")),
    });
  }
  const root = createRoot(dom.root as unknown as Element);
  await act(async () => { root.render(React.createElement(Parent)); });
  const click = async (label: string) => {
    const b = dom.button(label) ?? buttonStarting(label);
    if (!b) throw new Error(`no button "${label}" in: ${dom.seen().slice(0, 400)}`);
    clicks += 1;
    await act(async () => { dom.press(b); await tick(); });
    await act(async () => { await tick(); });
  };
  /** Allow, in the browser: native's next status is the church, connected. */
  const allow = async () => {
    clicks += 1;
    native.status = { state: "connected", organization: "1001", checked_at_ms: Date.parse("2026-11-20T21:43:00Z"), source: "", problem: null, organization_name: "Fictional Grace Church" };
    await act(async () => { setStatusOutside(native.status as ConnectionStatus); await tick(); });
    await act(async () => { await tick(); await tick(); });
  };
  return { click, allow, clicks: () => clicks, seen: () => dom.seen(), kept, left, unmount: () => act(async () => { root.unmount(); }) };
}

describe("first run, end to end on a fake native side", () => {
  it("one service: S1 → S5e in 3 clicks, with no decision before the result", async () => {
    const r = await run([SUNDAY_MORNING]);
    expect(r.seen()).toContain("Ozzie reads your church's Planning Center and tells you what needs you before your next service.");
    await r.click("Connect Planning Center");
    expect(r.seen()).toContain("Next, allow Ozzie to read your Planning Center");
    await r.click("Open Planning Center in my browser");
    expect(r.seen()).toContain("Waiting for you to choose Allow in your browser");
    // While waiting, quitting would leave this behind: a relaunch says nothing was connected.
    expect(JSON.parse(r.kept.get("ozzie.setup.v2")!).lastAttempt).toBe("cancelled");
    await r.allow();
    const t = r.seen();
    expect(t).toContain("Are your services covered?");
    expect(t).toMatch(/\d+ things? needs? a decision for Sunday, November 22\.|Everything Ozzie checks is covered for Sunday, November 22\./u);
    expect(t).toContain("Next: choose how Ozzie uses AI");
    expect(r.clicks()).toBe(3);
    // Connected: nothing about the attempt is kept any more.
    expect(JSON.parse(r.kept.get("ozzie.setup.v2")!).lastAttempt).toBeNull();
    // Then the AI screen, once, and afterwards the service's own page.
    await r.click("Next: choose how Ozzie uses AI");
    expect(r.seen()).toContain("How should Ozzie use AI?");
    // Shown is offered (spec S6), and "No AI for now" is kept as the answer, so Today doesn't ask again (review M1, M12).
    expect(JSON.parse(r.kept.get("ozzie.setup.v2")!)).toMatchObject({ aiOffered: true, aiAnswer: null });
    await r.click("No AI for now");
    expect(JSON.parse(r.kept.get("ozzie.setup.v2")!)).toMatchObject({ aiOffered: true, aiAnswer: "none" });
    expect(r.left).toHaveBeenCalledWith("sunday");
    await r.unmount();
  });

  it("two services: one more click, the pick", async () => {
    const r = await run([SATURDAY_NIGHT, SUNDAY_MORNING]);
    await r.click("Connect Planning Center");
    await r.click("Open Planning Center in my browser");
    await r.allow();
    expect(r.seen()).toContain("Which service should Ozzie watch?");
    expect(r.seen()).toContain("Connected to Fictional Grace Church");
    await r.click("Sunday Morning");
    expect(r.seen()).toContain("Are your services covered?");
    expect(r.seen()).toContain("Next: choose how Ozzie uses AI");
    expect(r.clicks()).toBe(4);
    await r.unmount();
  });

  it("Escape never cancels the sign-in or leaves setup; it closes only a sheet (spec §0.1, mutation M5)", async () => {
    // Every keydown listener anything adds to the document, so Escape can be pressed as a person would.
    const keys: ((e: unknown) => void)[] = [];
    const doc = globalThis.document as unknown as { addEventListener: (t: string, h: (e: unknown) => void) => void };
    const add = doc.addEventListener.bind(doc);
    doc.addEventListener = (t, h) => { if (t === "keydown") keys.push(h); add(t, h); };
    const escape = () => { for (const h of [...keys]) h({ key: "Escape", stopPropagation() {}, preventDefault() {} }); };
    const r = await run([SUNDAY_MORNING]);
    escape();
    expect(r.seen()).toContain("Ozzie reads your church's Planning Center");
    await r.click("Read all of Ozzie's promises");
    expect(r.seen()).toContain("What Ozzie does, and what it never does");
    const { act } = await import("react");
    await act(async () => { escape(); });
    expect(r.seen()).not.toContain("What Ozzie does, and what it never does");
    expect(r.seen()).toContain("Ozzie reads your church's Planning Center");
    await r.click("Connect Planning Center");
    await r.click("Open Planning Center in my browser");
    await act(async () => { escape(); });
    expect(r.seen()).toContain("Waiting for you to choose Allow in your browser");
    expect(native.calls).not.toContain("cancel_connection");
    expect(r.left).not.toHaveBeenCalled();
    doc.addEventListener = add;
    await r.unmount();
  });

  it("Cancel while waiting goes back a step, says nothing was connected, and never ends setup", async () => {
    const r = await run([SUNDAY_MORNING]);
    await r.click("Connect Planning Center");
    await r.click("Open Planning Center in my browser");
    await r.click("Cancel");
    expect(r.seen()).toContain("Next, allow Ozzie to read your Planning Center");
    expect(r.seen()).toContain("Nothing was connected.");
    expect(r.left).not.toHaveBeenCalled();
    await r.unmount();
  });
});
