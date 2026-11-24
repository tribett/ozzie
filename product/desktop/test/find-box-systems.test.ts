// Find in Ozzie for a church on B1 Church, Breeze or Genesis (owner decision 2026-11-24), through the whole app on a fake
// native side: it finds what that church's own pages show (its people, its findings, its events) and its own "Check …
// now", and nothing of a Planning Center check this Mac kept from before a switch. Fixed fictional data only; no key, no
// Keychain, no network.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeDom } from "./fake-dom.js";
import { b1Capture, breezeUntimedCapture } from "../../../core/test/church-systems/fixtures.js";
import { fictionalGenesis } from "../../../core/src/church-systems/fictional.js";
import { nov22Capture } from "../../../core/src/fictional-sunday.js";
import { withFictionalOperations } from "../../../core/src/fictional-operations.js";

const native = vi.hoisted(() => ({ calls: [] as [string, Record<string, unknown>][], capture: "" as string, pcSaved: null as unknown, pcStatus: null as unknown }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args: Record<string, unknown> = {}) => {
    native.calls.push([command, args]);
    switch (command) {
      case "connection_status": return native.pcStatus;
      case "check_saved_connection": return native.pcStatus;
      case "dev_defaults": return { clientId: "", organization: "", serviceTypeId: "", planId: "", autopilot: false };
      case "planning_center_app": return true;
      case "list_sunday_recordings": return native.pcSaved ? [{ organization: "1001", plan_id: "9001", completed_at: "2026-11-20T15:00:00Z", path_id: "saved-1" }] : [];
      case "load_sunday_recording": return native.pcSaved ? { ...native.pcSaved as object, kind: "recording" } : Promise.reject("not-found");
      case "background_info": return { fastSchedule: false, probe: false, tickMs: 30_000 };
      case "update_status": return null;
      case "notification_permission": return "unknown";
      case "model_status": return { configured: false, route: "none", label: "", setup: "no-route" };
      case "responsibility_list": throw "unavailable";
      case "own_key_providers": return [];
      case "managed_offer": return { open: false, reason: "closed" };
      case "church_system_choices": return { outcome: "ok", choices: [] };
      case "church_system_check": {
        const zone = typeof args.zone === "string" ? args.zone : null;
        const given = native.capture ? JSON.parse(native.capture) as { system: string; church: { time_zone: string | null } } : null;
        if (given?.system === "genesis" && zone) given.church.time_zone = zone;
        return { outcome: "ok", capture: given ? JSON.stringify(given) : JSON.stringify(b1Capture({ church: { id: "CHU0000cedar", time_zone: zone ?? "America/Chicago" } })) };
      }
      case "church_system_saved": return [];
      case "church_system_saved_checks": return [];
      default: return new Promise(() => {});
    }
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const dom = installFakeDom({ focus: true });
const kept = new Map<string, string>();
const storage = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => { kept.set(k, String(v)); },
  removeItem: (k: string) => { kept.delete(k); }, clear: () => kept.clear(), key: (i: number) => [...kept.keys()][i] ?? null, get length() { return kept.size; } };
Object.assign(globalThis, { localStorage: storage });
Object.assign(globalThis.window as object, { localStorage: storage });

const tick = () => new Promise(r => setTimeout(r, 0));
type Node = { tagName?: string; textContent: string; childNodes: unknown[]; getAttribute?: (a: string) => string | null };
const all = (n: { childNodes: unknown[] }): Node[] => [n as Node, ...n.childNodes.flatMap(c => all(c as { childNodes: unknown[] }))];
const nodes = () => all(dom.root as unknown as { childNodes: unknown[] });
const props = (el: unknown) => { const o = el as Record<string, Record<string, (e: unknown) => void>>; return o[Object.keys(o).find(k => k.startsWith("__reactProps$"))!]!; };
const findBox = () => nodes().find(n => n.getAttribute?.("id") === "find-input");
const options = () => nodes().filter(n => n.getAttribute?.("role") === "option").map(n => n.textContent);
const PC_NAMES = Object.values(nov22Capture().names);

let unmount: (() => Promise<void>) | null = null;
beforeEach(() => { vi.resetModules(); vi.useFakeTimers({ shouldAdvanceTime: true }); vi.setSystemTime(new Date("2026-11-20T15:05:00Z")); kept.clear(); native.calls = [];
  native.capture = ""; native.pcSaved = null; native.pcStatus = null; });
afterEach(async () => { try { await unmount?.(); } finally { unmount = null; vi.useRealTimers(); } });

/** A Mac already set up on `system`, which once used Planning Center (its saved check still on this Mac), opened again. */
async function launch(system: "b1" | "breeze" | "genesis") {
  kept.set("ozzie.church-system.v1", JSON.stringify(system === "genesis"
    ? { main: "genesis", connection: null, genesis: { system: "genesis", church_id: "CHU0000cedar", church_name: "Cedar Hollow Fellowship", zone: "America/Denver", result_seen: true } }
    : { main: system, genesis: null, connection: system === "b1"
      ? { system, church_id: "CHU0000cedar", church_name: "Cedar Hollow Fellowship", address: "cedarhollow", service_id: "PLA0000nov22", service_day: "2026-11-22",
        service_name: "Sunday Gathering", zone: "America/Chicago", result_seen: true }
      : { system, church_id: "juniperstreet", church_name: "Juniper Street Church", address: "juniperstreet", service_id: "90001", service_day: "2026-11-22",
        service_name: null, zone: null, result_seen: true } }));
  kept.set("ozzie.settings.v1", JSON.stringify({ clientId: "", organization: "1001", serviceTypeId: "8001", planId: "9001" }));
  native.pcSaved = withFictionalOperations(nov22Capture());
  native.pcStatus = { state: "disconnected", organization: "", checked_at_ms: null, source: "", problem: null };
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { App } = await import("../src/App.js");
  const root = createRoot(dom.root as unknown as Element);
  await act(async () => { root.render(React.createElement(App)); });
  unmount = async () => { await act(async () => { root.unmount(); }); };
  const settle = async (n = 30) => { for (let i = 0; i < n; i++) await act(async () => { await tick(); }); };
  const waitFor = async (text: string) => {
    for (let i = 0; i < 40 && !dom.seen().includes(text); i++) { await act(async () => { await vi.advanceTimersByTimeAsync(250); }); await settle(5); }
    if (!dom.seen().includes(text)) throw new Error(`never saw "${text}" in: ${dom.seen().slice(0, 900)}`);
  };
  await settle();
  const open = async () => { await act(async () => { dom.press(dom.button("Find⌘K")!); await tick(); }); await settle(3); };
  const type = async (text: string) => { await act(async () => { props(findBox()).onChange!({ target: { value: text } }); await tick(); }); await settle(3); };
  /** Everything found for each of Planning Center's people's names: nothing but the Ask row. */
  const noPlanningCenter = async () => {
    for (const name of PC_NAMES) {
      await type(name);
      expect(options().filter(o => !o.startsWith("Ask Ozzie")), name).toEqual([]);
    }
  };
  return { waitFor, open, type, noPlanningCenter };
}

describe("Find for a church on another system", () => {
  it("B1 Church: its own people and findings and its own check, nothing of the Planning Center check kept from before", async () => {
    const app = await launch("b1");
    await app.waitFor("B1 Church: Cedar Hollow Fellowship");
    await app.open();
    await app.type("lark");
    expect(options()).toEqual(expect.arrayContaining(["Lark Fictional is pending for Greeter, Worth a look", "Lark Fictional, Greeter"]));
    await app.type("check now");
    expect(options()).toContain("Check B1 Church now");
    expect(options()).not.toContain("Check Planning Center now");
    await app.noPlanningCenter();
  }, 90_000);

  it("Breeze: its people by role, someone on the service with no role too", async () => {
    native.capture = JSON.stringify(breezeUntimedCapture({ church: { id: "juniperstreet", time_zone: "America/Chicago" }, service: { ...breezeUntimedCapture().service!, id: "90001" } }));
    const app = await launch("breeze");
    await app.waitFor("Breeze: Juniper Street Church");
    await app.open();
    await app.type("fictional");
    // Nothing here needs a decision (Breeze shares no numbers needed), so A to Z; never someone who said no.
    expect(options().filter(o => !o.startsWith("Ask Ozzie") && !o.includes(" is "))).toEqual([
      "Ivy Fictional, Sound", "Kit Fictional, On the service, with no role", "Sam Fictional, Usher", "Wren Fictional, Greeter",
    ]);
    await app.noPlanningCenter();
  }, 90_000);

  it("Genesis: its events and forms, answered on this Mac in Ask, no service's people and nothing of Planning Center's", async () => {
    native.capture = JSON.stringify(fictionalGenesis());
    const app = await launch("genesis");
    await app.waitFor("From Genesis: 3 events in the next four weeks, 2 forms, 3 groups.");
    await app.open();
    await app.type("midweek");
    expect(options()).toContain("Midweek Prayer, Thu, Nov 26, 6:30 PM");
    expect(options().at(-1)).toBe("Ask Ozzie: “midweek”, Answered on this Mac from what Genesis shares. Nothing is sent to an AI.");
    await app.type("check now");
    expect(options()).toContain("Check Genesis now");
    await app.noPlanningCenter();
  }, 90_000);
});
