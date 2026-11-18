import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installFakeDom } from "./fake-dom.js";

// Native keeps the rooms, follow-ups and group events switch per church (operations_reads, decided per organization):
// Settings asks again whenever the church in use changes, so one church's answer is never shown for another's.
const reads = vi.hoisted(() => ({ answers: new Map<string, boolean>(), current: "1001", calls: 0 }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((command: string) => {
    if (command === "operations_reads") { reads.calls++; return Promise.resolve(reads.answers.get(reads.current) ?? false); }
    return new Promise(() => {});
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
import { ConnectionPage } from "../src/connection-page.js";
import type { ConnectionStatus } from "../src/connection.js";

const dom = installFakeDom();
const settings = { clientId: "fictional-client", organization: "1001", serviceTypeId: "1500", planId: "92902197" };
const status = (organization: string): ConnectionStatus =>
  ({ state: "connected", organization, checked_at_ms: 1, source: "native", problem: null, scopes: "services-and-operations" });
let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; });

describe("the rooms, follow-ups and group events switch, per church", () => {
  it("reads native's switch again when Ozzie moves to another church", async () => {
    reads.answers.set("1001", true); reads.answers.set("2002", false); reads.current = "1001"; reads.calls = 0;
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(dom.root as unknown as Element);
    unmount = () => { act(() => root.unmount()); };
    const render = async (org: string) => {
      await act(async () => { root.render(React.createElement(ConnectionPage, { status: status(org), settings: { ...settings, organization: org }, onSettings: () => {}, onStatus: () => {} })); });
      await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); });
    };
    await render("1001");
    expect(reads.calls).toBe(1);
    expect(dom.button("Turn off rooms, follow-ups and group events")).not.toBeNull();
    reads.current = "2002";
    await render("2002");
    expect(reads.calls).toBe(2);
    expect(dom.button("Turn off rooms, follow-ups and group events")).toBeNull();
  });
});
