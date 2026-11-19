// A church on B1 Church or Breeze as App holds it (system-church.ts useSystemChurch): Check now and a newly chosen service
// always read what they name, even when a check of the service watched before was already under way; a failed check of
// another church is never said on this one's page. Fictional captures; the schedule and native side are stand-ins.
import React from "react";
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => new Promise(() => {})) }));
import { installFakeDom } from "./fake-dom.js";
import { churchSystemStore, type SystemConnection } from "../src/church-system.js";
import { useSystemChurch, type SystemChurch } from "../src/system-church.js";
import { SystemReadFailure } from "../src/proactive.js";
import type { SystemCapture } from "../../../core/src/church-systems/types.js";
import { b1Capture, NOW } from "../../../core/test/church-systems/fixtures.js";

const dom = installFakeDom();
const B1: SystemConnection = { system: "b1", church_id: "CHU0000cedar", church_name: "Cedar Hollow Fellowship", address: "cedarhollow", service_id: "PLA0000nov29",
  service_day: "2026-11-29", service_name: "Sunday Gathering", zone: "America/Chicago", result_seen: true };
const of = (service: string): SystemCapture => b1Capture({ service: { ...b1Capture().service!, id: service } });

async function mount(checkNow: () => Promise<SystemCapture>) {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const kept = new Map<string, string>();
  const store = churchSystemStore({ getItem: k => kept.get(k) ?? null, setItem: (k, v) => { kept.set(k, v); } });
  store.set({ main: "b1", connection: B1, genesis: null });
  const bridge = { check: async () => ({ outcome: "ok", capture: null }), savedChecks: async () => [], loadCheck: async () => ({ outcome: "not-found", capture: null }) };
  const held: { sys: SystemChurch | null } = { sys: null };
  function Probe() { held.sys = useSystemChurch(NOW, [], checkNow, store, bridge); return null; }
  const root = createRoot(dom.root as unknown as Element);
  await act(async () => { root.render(React.createElement(Probe)); });
  return { held, act, unmount: () => act(async () => { root.unmount(); }) };
}

describe("checking a church on another system", () => {
  it("reads the service now watched when the check under way was of the one before", async () => {
    // The schedule hands back the check already under way (of the service before), then the one asked for.
    const answers = [of("PLA0000nov22"), of("PLA0000nov29")];
    const checkNow = vi.fn(async () => answers.shift()!);
    const m = await mount(checkNow);
    let outcome = "";
    await m.act(async () => { outcome = await m.held.sys!.check(); });
    expect(outcome).toBe("ok");
    expect(checkNow).toHaveBeenCalledTimes(2);
    await m.unmount();
  });

  it("says so when it still couldn't read the service named", async () => {
    const checkNow = vi.fn(async () => of("PLA0000nov22"));
    const m = await mount(checkNow);
    let outcome = "";
    await m.act(async () => { outcome = await m.held.sys!.check(); });
    expect(outcome).toBe("busy");
    expect(m.held.sys!.problem).toBe("Ozzie is already reading B1 Church. Wait a moment, then check again.");
    await m.unmount();
  });

  it("never says on this church's page why a check of another church failed", async () => {
    const m = await mount(async () => of("PLA0000nov29"));
    await m.act(async () => { m.held.sys!.fail(new SystemReadFailure("b1", "key-refused", "CHU0000other")); });
    expect(m.held.sys!.problem).toBe("");
    await m.act(async () => { m.held.sys!.fail(new SystemReadFailure("b1", "key-refused", "CHU0000cedar")); });
    expect(m.held.sys!.problem).toMatch(/B1 Church no longer accepts the key Ozzie has/u);
    await m.unmount();
  });
});
