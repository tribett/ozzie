// What quitting would stop (review P, L2): whether checks are on, as native code is told it for the question on quitting.
// The decision is a pure helper; the hook App uses is mounted on the fake document (test/fake-dom.ts), so what reaches
// native code is what is checked. Fictional settings only.
import React from "react";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { installFakeDom } from "./fake-dom.js";
const invoke = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { checksOn, useQuitGuard, type ChecksState } from "../src/quit-question.js";
import { proactiveReadiness } from "../src/proactive.js";

const dom = installFakeDom();
const job = (status: string) => ({ status });
const state = (over: Partial<ChecksState> = {}): ChecksState => ({
  readiness: "ready", schedule: { paused: false }, watch: { paused_all: false, items: [] }, ...over,
});
const off: Partial<ChecksState> = { readiness: "not-connected", watch: { paused_all: false, items: [] } };

describe("whether quitting would stop checks", () => {
  it("is on for the regular Sunday check or any job that's on, and off when neither is", () => {
    // The regular Sunday check: on while Ozzie can check this church and its schedule isn't paused.
    expect(checksOn(state())).toBe(true);
    expect(checksOn(state({ schedule: { paused: true } }))).toBe(false);
    expect(checksOn(state({ readiness: "not-configured" }))).toBe(false);
    // A job that's on, even with the regular check off; Pause everything stops every job.
    expect(checksOn(state({ ...off, watch: { paused_all: false, items: [job("paused"), job("active")] } }))).toBe(true);
    expect(checksOn(state({ ...off, watch: { paused_all: true, items: [job("active")] } }))).toBe(false);
    expect(checksOn(state({ ...off, watch: { paused_all: false, items: [job("paused"), job("stopped")] } }))).toBe(false);
    // Both off.
    expect(checksOn(state({ ...off, schedule: { paused: true } }))).toBe(false);
  });

  it("with the fictional example on, follows this Mac's own church and jobs, which the example never changes", () => {
    // Opened from setup before connecting: nothing of the church's runs, so quitting stops nothing.
    const firstRun = proactiveReadiness({ clientId: "", organization: "", serviceTypeId: "", planId: "" }, null);
    expect(checksOn(state({ readiness: firstRun }))).toBe(false);
    // Opened by a church that is set up: its own regular check still runs behind the example.
    const setUp = proactiveReadiness({ clientId: "", organization: "1001", serviceTypeId: "11", planId: "22" },
      { state: "connected", organization: "1001", checked_at_ms: 1, source: "", problem: null });
    expect(checksOn(state({ readiness: setUp }))).toBe(true);
  });

  it("tells native code the open cards and whether checks are on, again whenever either changes", async () => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const Guard = ({ cards, s }: { cards: number; s: ChecksState }) => { useQuitGuard(cards, s); return null; };
    const root = createRoot(dom.root as unknown as Element);
    const told = () => invoke.mock.calls.filter(c => (c as unknown[])[0] === "quit_guard_set").map(c => (c as unknown[])[1]);
    invoke.mockClear();
    await act(async () => { root.render(React.createElement(Guard, { cards: 0, s: state() })); });
    expect(told()).toEqual([{ cards: 0, checks: true }]);
    await act(async () => { root.render(React.createElement(Guard, { cards: 2, s: state() })); });
    await act(async () => { root.render(React.createElement(Guard, { cards: 2, s: state({ ...off }) })); });
    expect(told()).toEqual([{ cards: 0, checks: true }, { cards: 2, checks: true }, { cards: 2, checks: false }]);
    await act(async () => { root.unmount(); });
  });

  it("is what App tells native code: its own settings' readiness, the regular check's schedule and the jobs", () => {
    const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
    expect(app).toContain("useQuitGuard(openCards, { readiness, schedule: automatic.schedule, watch });");
    expect(app).not.toMatch(/quitting\.guard\(/u);
  });
});
