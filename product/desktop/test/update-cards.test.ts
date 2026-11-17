// "Update Ozzie and reopen it" with visitor cards open (review P L3, review F residue): the line above Today and the
// Updates section ask first, by the count App gives them, the same count it gives the question on quitting
// (useQuitGuard). Pressed on the fake document (test/fake-dom.ts), so what installs is what is checked. The count is a
// required prop, so a place that shows the update without it doesn't compile; tsc is one of the gates.
import React from "react";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { installFakeDom } from "./fake-dom.js";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => new Promise(() => {})) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
import { laterMemory, UPDATE_BUTTON, UPDATE_CARDS_ASK, UPDATE_DISCARD, UPDATE_KEEP_CARDS, type UpdatesState, type UpdateView } from "../src/updates.js";
import { UpdateLine, UpdatesSection } from "../src/updates-view.js";

const dom = installFakeDom();
const NOW = new Date(2026, 10, 19, 14, 30).getTime();
const ready: UpdateView = { current: "0.1.9", automatic: true, lastCheckedMs: NOW - 3_600_000, phase: "available", available: "0.1.10", problem: null,
  place: "app", autopilot: false, probe: false };
const memory = () => { const m = new Map<string, string>(); return laterMemory({ get: k => m.get(k) ?? null, set: (k, v) => { m.set(k, v); } }); };

async function mount(which: "line" | "section", cards: number) {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  let installs = 0;
  const state: UpdatesState = { view: ready, check() {}, setAutomatic() {}, install() { installs++; } };
  const root = createRoot(dom.root as unknown as Element);
  await act(async () => {
    root.render(which === "line" ? React.createElement(UpdateLine, { state, nowMs: NOW, memory: memory(), cards })
      : React.createElement(UpdatesSection, { state, nowMs: NOW, cards }));
  });
  const press = async (label: string) => { const b = dom.button(label); expect(b, label).not.toBeNull(); await act(async () => { dom.press(b!); }); };
  return { installs: () => installs, press, unmount: () => act(async () => { root.unmount(); }) };
}

describe("updating with visitor cards open", () => {
  for (const which of ["line", "section"] as const) {
    it(`${which === "line" ? "the line above Today" : "Settings › Updates"}: asks first with cards open, and updates only on the leader's choice`, async () => {
      const u = await mount(which, 2);
      await u.press(UPDATE_BUTTON);
      expect(u.installs()).toBe(0);
      expect(dom.seen()).toContain(UPDATE_CARDS_ASK(2));
      await u.press(UPDATE_KEEP_CARDS);
      expect(u.installs()).toBe(0);
      expect(dom.seen()).not.toContain(UPDATE_CARDS_ASK(2));
      await u.press(UPDATE_BUTTON);
      await u.press(UPDATE_DISCARD(2));
      expect(u.installs()).toBe(1);
      await u.unmount();
    });

    it(`${which === "line" ? "the line above Today" : "Settings › Updates"}: with no cards open, updates at once`, async () => {
      const u = await mount(which, 0);
      await u.press(UPDATE_BUTTON);
      expect(u.installs()).toBe(1);
      expect(dom.seen()).not.toContain("visitor card");
      await u.unmount();
    });
  }

  it("is given the same count App gives the question on quitting", () => {
    const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
    expect(app).toContain("useQuitGuard(openCards, ");
    expect(app).toContain("<UpdateLine state={updateState} nowMs={Date.parse(now)} cards={openCards} />");
    expect(app).toContain("<UpdatesSection state={updateState} nowMs={Date.parse(now)} cards={openCards} />");
  });
});
