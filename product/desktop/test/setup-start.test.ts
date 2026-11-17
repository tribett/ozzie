// "Start Ozzie when you turn on this Mac?" in guided setup (audit item 23, review P L5): first time, Yes is chosen to
// begin with; reopened after it was answered, the choice starts from what this Mac is set to now, so Finish never turns
// it back on unasked. Mounted on the fake document (test/fake-dom.ts) so the Mac's answer arrives as it does in the app.
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { installFakeDom } from "./fake-dom.js";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => new Promise(() => {})) }));
import { SetupFlow } from "../src/setup-flow.js";
import { DEFAULT_PREFS } from "../src/proactive.js";

const dom = installFakeDom();
const YES = "Yes, start Ozzie with this Mac (recommended)", NO = "No, I'll open it myself";
/** Which of the two answers is chosen, by its radio's `checked`. */
const chosen = () => {
  const all = (n: { childNodes: unknown[] }): unknown[] => [n, ...n.childNodes.flatMap(c => all(c as { childNodes: unknown[] }))];
  const radios = all(dom.root as unknown as { childNodes: unknown[] })
    .filter(n => (n as { tagName?: string; type?: string }).tagName === "INPUT" && (n as { type?: string }).type === "radio") as { checked: boolean; parentNode: { textContent: string } }[];
  return radios.filter(r => r.checked).map(r => r.parentNode.textContent);
};

async function mount(asked: boolean, on: boolean | "fails") {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const autostart = {
    get: vi.fn(() => on === "fails" ? Promise.reject(new Error("closed")) : Promise.resolve(on)),
    set: vi.fn(async (v: boolean) => v),
  };
  const startStore = { asked: () => asked, answer: vi.fn() };
  const closed = vi.fn();
  const root = createRoot(dom.root as unknown as Element);
  await act(async () => {
    root.render(React.createElement(SetupFlow, {
      status: null, settings: { clientId: "", organization: "", serviceTypeId: "", planId: "" }, onSettings() {}, onStatus() {}, prefs: DEFAULT_PREFS,
      onModel() {}, onClose: closed, onExample() {}, onAutomatic() {}, initial: "automatic", autostart, startStore,
    }));
  });
  const finish = async () => { await act(async () => { dom.press(dom.button("Finish setup")!); }); };
  return { autostart, startStore, closed, finish, unmount: () => act(async () => { root.unmount(); }) };
}

describe("setup's start-with-this-Mac choice", () => {
  it("first time: Yes is chosen to begin with, without asking the Mac, and Finish applies it", async () => {
    const s = await mount(false, false);
    expect(chosen()).toEqual([YES]);
    expect(s.autostart.get).not.toHaveBeenCalled();
    await s.finish();
    expect(s.autostart.set).toHaveBeenCalledWith(true);
    expect(s.startStore.answer).toHaveBeenCalled();
    await s.unmount();
  });

  it("reopened after the leader turned it off: starts at No, and Finish keeps it off", async () => {
    const s = await mount(true, false);
    expect(s.autostart.get).toHaveBeenCalledTimes(1);
    expect(chosen()).toEqual([NO]);
    await s.finish();
    expect(s.autostart.set).toHaveBeenCalledWith(false);
    expect(s.autostart.set).not.toHaveBeenCalledWith(true);
    await s.unmount();
  });

  it("reopened while it's on: starts at Yes", async () => {
    const s = await mount(true, true);
    expect(chosen()).toEqual([YES]);
    await s.unmount();
  });

  it("reopened when the Mac can't say: neither is chosen, and Finish changes nothing", async () => {
    const s = await mount(true, "fails");
    expect(chosen()).toEqual([]);
    await s.finish();
    expect(s.autostart.set).not.toHaveBeenCalled();
    expect(s.closed).toHaveBeenCalled();
    await s.unmount();
  });
});
