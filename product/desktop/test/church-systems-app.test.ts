// The whole app for a church on B1 Church or Breeze, on a fake native side (fictional data only; no key, no Keychain,
// no network): a brand-new Mac's first run through "What does your church use?", B1 Church's key and address, the plan
// Ozzie picks, the time zone question, and the first result; then a relaunch that reads the service once on opening;
// and every page a pastor on another system reaches, said in that system's words, with nothing of Planning Center's.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeDom } from "./fake-dom.js";
import { b1Capture, breezeCapture, breezeUntimedCapture } from "../../../core/test/church-systems/fixtures.js";
import { fictionalGenesis } from "../../../core/src/church-systems/fictional.js";
import { nov22Capture } from "../../../core/src/fictional-sunday.js";
import { withFictionalOperations } from "../../../core/src/fictional-operations.js";

const native = vi.hoisted(() => ({ calls: [] as [string, Record<string, unknown>][], connect: [] as string[], capture: "" as string, keyGone: false,
  choices: null as unknown, pcSaved: null as unknown, pcStatus: null as unknown, saved: "" as string }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args: Record<string, unknown> = {}) => {
    native.calls.push([command, args]);
    if (command === "dev_defaults" || command === "connection_status") await new Promise(r => setTimeout(r, 20));
    switch (command) {
      case "connection_status": return native.pcStatus;
      case "check_saved_connection": return native.pcStatus;
      case "dev_defaults": return { clientId: "", organization: "", serviceTypeId: "", planId: "", autopilot: false };
      case "planning_center_app": return true;
      // A Mac that used Planning Center before switching keeps its saved Planning Center checks (native's, per church).
      case "list_sunday_recordings": return native.pcSaved ? [{ organization: "1001", plan_id: "9001", completed_at: "2026-11-20T15:00:00Z", path_id: "saved-1" }] : [];
      case "load_sunday_recording": return native.pcSaved ? { ...native.pcSaved as object, kind: "recording" } : Promise.reject("not-found");
      case "background_info": return { fastSchedule: false, probe: false, tickMs: 30_000 };
      case "update_status": return null;
      case "notification_permission": return "unknown";
      case "model_status": return { configured: false, route: "none", label: "", setup: "no-route" };
      case "responsibility_list": throw "unavailable";
      case "set_no_ai": return { configured: false, route: "none", label: "", setup: "no-route" };
      case "own_key_providers": return [];
      case "managed_offer": return { open: false, reason: "closed" };
      // The church systems' commands (src-tauri/src/church_systems.rs), with fictional answers.
      case "church_system_connect": {
        const outcome = native.connect.shift() ?? "works";
        return outcome === "works" ? { outcome, church: { id: "CHU0000cedar", name: "Cedar Hollow Fellowship" } } : { outcome, church: null };
      }
      case "church_system_choices": return native.choices ?? { outcome: "ok", choices: [{ id: "PLA0000nov22", day: "2099-11-22", name: "Sunday Gathering", shared: true }] };
      case "church_system_check": {
        if (native.keyGone) return { outcome: "key-refused", capture: null };
        // B1 Church's own zone is back-filled; the confirmed zone (an argument) is what the check is placed in.
        const zone = typeof args.zone === "string" ? args.zone : null;
        // Genesis's events are placed in the zone the person gave (native genesis.rs), as its capture says.
        const given = native.capture ? JSON.parse(native.capture) as { system: string; church: { time_zone: string | null } } : null;
        if (given?.system === "genesis" && zone) given.church.time_zone = zone;
        return { outcome: "ok", capture: given ? JSON.stringify(given) : JSON.stringify(b1Capture({ church: { id: "CHU0000cedar", time_zone: zone ?? "America/Chicago" } })) };
      }
      case "church_system_verify": return { outcome: "works", church: { id: "CHU0000cedar", name: "Cedar Hollow Fellowship" } };
      case "church_system_forget": return null;
      case "church_system_saved": return [];
      // A check kept on this Mac (native's saved checks), when the case sets one.
      case "church_system_saved_checks": return native.saved ? [{ path_id: "b1.CHU0000cedar.PLA0000nov22.1795014004000.json", service_id: "PLA0000nov22", completed_at: "2026-11-19T15:00:04Z" }] : [];
      case "church_system_load_check": return native.saved ? { outcome: "ok", capture: native.saved } : { outcome: "not-found", capture: null };
      case "church_system_delete_checks": { const had = native.saved ? 1 : 0; native.saved = ""; return had; }
      // The coverage notice: native shows its own fixed words.
      case "notify_sunday_attention": return null;
      default: return new Promise(() => {});
    }
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const dom = installFakeDom();
const kept = new Map<string, string>();
const storage = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => { kept.set(k, String(v)); },
  removeItem: (k: string) => { kept.delete(k); }, clear: () => kept.clear(), key: (i: number) => [...kept.keys()][i] ?? null, get length() { return kept.size; } };
Object.assign(globalThis, { localStorage: storage });
Object.assign(globalThis.window as object, { localStorage: storage });

const tick = () => new Promise(r => setTimeout(r, 0));
const all = (n: { childNodes: unknown[] }): unknown[] => [n, ...n.childNodes.flatMap(c => all(c as { childNodes: unknown[] }))];
const buttonStarting = (text: string) => all(dom.root as unknown as { childNodes: unknown[] })
  .find(n => (n as { tagName?: string }).tagName === "BUTTON" && ((n as { textContent: string }).textContent ?? "").startsWith(text)) as Parameters<typeof dom.press>[0] | undefined;
type Props = Record<string, { onClick?: (e: unknown) => void; onChange?: (e: unknown) => void }>;
const propsOf = (el: unknown) => { const o = el as Props; return o[Object.keys(o).find(k => k.startsWith("__reactProps$"))!]; };
const byId = (id: string) => all(dom.root as unknown as { childNodes: unknown[] }).find(n => (n as { getAttribute?: (a: string) => string | null }).getAttribute?.("id") === id);
/** A second Planning Center service a Mac watched before it switched systems, and anything that would show it. */
const WATCHED_TOO = { serviceTypeId: "8002", planId: "9002", name: "Saturday Vigil", sort_date: "2026-11-21T18:00:00Z", times: [], zone: "America/Chicago", past: [] };
const SEVERAL_SERVICES = /Saturday Vigil|Watch another service|Which services Ozzie watches|across \d+ services|Your services have|in your services/u;
const byIdIn = (root: unknown, id: string) => all(root as { childNodes: unknown[] }).some(n => (n as { getAttribute?: (a: string) => string | null }).getAttribute?.("id") === id);

/**
 * Where a page says Planning Center by name, other than its own plain lines that something works with Planning Center
 * only (which a pastor on another system is meant to read): a few words around each, so a failure shows where.
 */
const misnamed = (text: string) => {
  const rest = text.replace(/[^.]*(?:work|works) with Planning Center only for now[^.]*\./gu, "").replace(/Ozzie can't do (?:this|these) with [A-Za-z0-9 ]+ yet\./gu, "");
  return [...rest.matchAll(/Planning Center/gu)].map(m => rest.slice(Math.max(0, m.index - 60), m.index + 60));
};
let unmount: (() => Promise<void>) | null = null;
// The fixtures' checks were read at 15:00 UTC on November 20: the app's clock is just after.
// Each case is a fresh app: the page's module-level schedulers (proactive.ts, the jobs' runner) never carry over.
beforeEach(() => { vi.resetModules(); vi.useFakeTimers({ shouldAdvanceTime: true }); vi.setSystemTime(new Date("2026-11-20T15:05:00Z")); kept.clear(); native.calls = []; native.connect = []; native.capture = ""; native.keyGone = false;
  native.choices = null; native.pcSaved = null; native.pcStatus = null; native.saved = ""; });
afterEach(async () => { await unmount?.(); unmount = null; vi.useRealTimers(); });

async function launch() {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { App } = await import("../src/App.js");
  const root = createRoot(dom.root as unknown as Element);
  await act(async () => { root.render(React.createElement(App)); });
  const settle = async (n = 30) => { for (let i = 0; i < n; i++) await act(async () => { await tick(); }); };
  await settle();
  unmount = async () => { await act(async () => { root.unmount(); }); };
  const press = async (label: string) => {
    const b = dom.button(label) ?? buttonStarting(label);
    if (!b) throw new Error(`no button "${label}" in: ${dom.seen().slice(0, 700)}`);
    await act(async () => { dom.press(b); await tick(); });
    await settle();
  };
  const type = async (id: string, value: string) => { await act(async () => { propsOf(byId(id))?.onChange?.({ target: { value } }); await tick(); }); await settle(); };
  const waitFor = async (text: string) => {
    for (let i = 0; i < 40 && !dom.seen().includes(text); i++) { await act(async () => { await vi.advanceTimersByTimeAsync(250); }); await settle(5); }
    if (!dom.seen().includes(text)) throw new Error(`never saw "${text}" in: ${dom.seen().slice(0, 900)}`);
  };
  const go = async (label: string) => {
    const a = all(dom.root as unknown as { childNodes: unknown[] }).find(n => (n as { tagName?: string }).tagName === "A" && (n as { textContent: string }).textContent.startsWith(label));
    await act(async () => { propsOf(a)?.onClick?.({ preventDefault() {} }); await tick(); });
    await settle();
  };
  return { press, type, waitFor, go, settle };
}

describe("a brand-new Mac on B1 Church", () => {
  it("asks which system, connects B1 Church with its key and address, picks the plan, asks the time zone, and shows the first result", async () => {
    const app = await launch();
    await app.waitFor("What does your church use?");
    await app.press("B1 Church");
    expect(dom.seen()).toContain("Connect B1 Church");
    expect(dom.seen()).toContain("Ozzie reads your church's B1 Church account from api.churchapps.org.");
    await app.type("fr-system-address", "cedarhollow.b1.church");
    native.connect = ["not-found"];
    await app.press("Paste my key");
    expect(dom.seen()).toContain("B1 Church doesn't know a church at cedarhollow.b1.church.");
    await app.press("Paste my key");
    const connects = native.calls.filter(([c]) => c === "church_system_connect").map(([, a]) => a);
    expect(connects).toEqual([{ system: "b1", address: "cedarhollow", how: "paste" }, { system: "b1", address: "cedarhollow", how: "paste" }]);
    // The plan Ozzie picked, read at once; B1 Church's back-filled zone is asked about before anything is checked.
    await app.waitFor("Is that right?");
    // Named by its everyday name and city (round 3); the IANA name is what is kept.
    expect(dom.seen()).toContain("B1 Church says your church's time zone is Central Time (Chicago).");
    await app.press("Use Central Time (Chicago)");
    await app.waitFor("3 things need a decision");
    const checks = native.calls.filter(([c]) => c === "church_system_check").map(([, a]) => a);
    expect(checks.at(-1)).toEqual({ system: "b1", churchId: "CHU0000cedar", serviceId: "PLA0000nov22", zone: "America/Chicago" });
    expect(dom.seen()).toContain("B1 Church: Cedar Hollow Fellowship");
    expect(dom.seen()).not.toContain("Planning Center not connected");
    // No Planning Center call was made on the way.
    expect(native.calls.map(([c]) => c)).not.toContain("connect_planning_center_app");
    expect(native.calls.map(([c]) => c)).not.toContain("check_sunday");
  }, 60_000);
});

describe("a fresh Mac that hasn't chosen what its church uses (round 5)", () => {
  it("speaks neutrally everywhere and leads back to the choice, never assuming Planning Center", async () => {
    const app = await launch();
    await app.waitFor("What does your church use?");
    expect(dom.seen()).toContain("No church system connected yet");
    expect(dom.seen()).not.toContain("Planning Center not connected");
    expect(dom.seen()).toContain("The example church uses Planning Center.");
    await app.press("See an example church first");
    await app.waitFor("Example church, not real.");
    await app.press("Leave the example");
    // Back to the choice, not Planning Center's own service page.
    await app.waitFor("What does your church use?");
    for (const page of ["Today", "Services", "Keeping watch", "What happened", "Visitor cards"]) {
      await app.go(page);
      // Planning Center is named only among the choices ("Ozzie reads Planning Center, B1 Church or Breeze").
      expect(misnamed(dom.seen().replace(/Ozzie reads Planning Center, B1 Church, Breeze or Genesis/gu, "")), page).toEqual([]);
    }
    await app.go("Today");
    expect(dom.seen()).toContain("Choose what your church uses to see your service");
    expect(dom.seen()).toContain("Nothing runs yet. Ozzie keeps an eye on your services once your church's system is connected");
    await app.press("Choose what your church uses");
    await app.waitFor("What does your church use?");
    await app.go("Settings");
    expect(dom.seen()).toContain("No church system connected yet. Ozzie reads Planning Center, B1 Church, Breeze or Genesis");
    expect(dom.seen()).not.toContain("Planning Center now.");
  }, 60_000);
});

describe("a church that uses only Genesis (round 5)", () => {
  it("chooses Genesis, connects with its key, gives its time zone, and sees what Genesis shares, never a covered service", async () => {
    native.capture = JSON.stringify(fictionalGenesis());
    const app = await launch();
    await app.waitFor("What does your church use?");
    await app.press("Genesis");
    expect(dom.seen()).toContain("Connect Genesis");
    expect(dom.seen()).toContain("tick Read for Groups, Events and Forms only");
    await app.press("Paste my key");
    expect(native.calls.filter(([c]) => c === "church_system_connect").map(([, a]) => a)).toEqual([{ system: "genesis", address: null, how: "paste" }]);
    await app.waitFor("Which time zone does your church meet in?");
    await app.press("Use ");
    await app.waitFor("3 events in the next four weeks, 2 forms, 3 groups.");
    expect(dom.seen()).toContain("Genesis doesn't share volunteer schedules, so Ozzie can't check whether a service is covered.");
    expect(dom.seen()).not.toContain("Planning Center not connected");
    await app.press("Next: choose how Ozzie uses AI");
    await app.go("Today");
    await app.waitFor("From Genesis: 3 events in the next four weeks, 2 forms, 3 groups.");
    expect(dom.seen()).not.toMatch(/Nothing on [^.]* needs a decision|hasn't been checked yet/u);
    expect(dom.seen()).toContain("Genesis: Cedar Hollow Fellowship");
    // Review of e9cbd97d, H1: a connected Genesis church is never asked to connect, and its own reads are what runs.
    expect(dom.seen()).not.toContain("Not connected yet");
    expect(dom.seen()).not.toContain("Nothing runs yet");
    expect(dom.seen()).toContain("Ozzie reads Genesis on its own");
    expect(dom.seen()).toContain("Checks Genesis at least every hour while Ozzie is open, and when it opens.");
    // M6: first run's read is the one recorded; finishing doesn't read again.
    expect(native.calls.filter(([c]) => c === "church_system_check")).toHaveLength(1);
    expect(JSON.parse(kept.get("ozzie.church-system.v1")!).genesis.result_seen).toBe(true);
    // The Services page, as every church's (owner decision 2026-11-19): Genesis's events, never a coverage question.
    await app.go("Services");
    expect(dom.seen()).toContain("Coming up in Genesis");
    expect(dom.seen()).toContain("What Genesis shares");
    expect(dom.seen()).toContain("Live read from Genesis");
    expect(dom.seen()).toContain("Prayer Card: 7 entries");
    expect(dom.seen()).not.toMatch(/Are your services covered\?|Your service\b|Sunday page/u);
    // Ask answers here from what was read: nothing goes to an AI, and who is serving is plainly not shared.
    await app.press("Ask Ozzie");
    // M1: no "nothing checked" or "needs AI" over answers made here, and Genesis's own questions are offered.
    expect(dom.seen()).not.toContain("Nothing has been checked yet");
    expect(dom.seen()).not.toContain("Ask Ozzie needs AI");
    expect(dom.seen()).toContain("How many times was each form filled in?");
    expect(dom.seen()).toContain("Questions about what Genesis shares");
    const { act } = await import("react");
    const ask = async (q: string) => {
      await app.type("ask-input", q);
      const form = all(dom.root as unknown as { childNodes: unknown[] }).find(n => (n as { tagName?: string }).tagName === "FORM" && byIdIn(n, "ask-input"));
      await act(async () => { (propsOf(form) as unknown as { onSubmit: (e: unknown) => void }).onSubmit({ preventDefault() {} }); });
      await app.settle();
    };
    await ask("What events are coming up?");
    // The fixture's times carry Denver's offset; native places them in the zone given, so only the event and day are checked.
    expect(dom.seen()).toMatch(/Sunday Service, Sun, Nov 22, \d{1,2}:00 [AP]M\./u);
    await ask("Who is serving on Sunday?");
    expect(dom.seen()).toContain("Genesis doesn't share volunteer schedules, so Ozzie can't check whether a service is covered.");
    // Review of 4c3d32ac, H: a visitor card asked about by count is Genesis's form, never the cards page.
    await ask("How many times was the visitor card filled in?");
    expect(dom.seen()).toContain("Prayer Card: filled in 7 times.");
    expect(dom.seen()).not.toContain("Visitor cards are read on this Mac, on the Visitor cards page");
    expect(native.calls.map(([c]) => c)).not.toContain("agent_step");
    await app.go("What happened");
    expect(dom.seen()).toContain("Every read in the latest check");
    // M6: first run's read went through the recorder (What happened's ledger), once.
    expect(native.calls.filter(([c, a]) => c === "ledger_admit" && (a as { kind?: string }).kind === "check")).toHaveLength(1);
    await app.go("Settings");
    expect(dom.seen()).toContain("Connected to Cedar Hollow Fellowship in Genesis.");
    expect(dom.seen()).not.toContain("Also read Genesis");
    // M3: switching away keeps Genesis as Also read Genesis, and says so.
    await app.press("Switch to Breeze");
    expect(dom.seen()).toContain("Genesis stays connected: Ozzie reads it beside the system you switch to, under Also read Genesis in Settings");
    await app.press("Keep Genesis");
  }, 90_000);

  it("after a switch from Planning Center, nothing of Planning Center's check shows or runs on Genesis (review of e9cbd97d, H2, M4)", async () => {
    kept.set("ozzie.church-system.v1", JSON.stringify({ main: "genesis", connection: null,
      genesis: { system: "genesis", church_id: "CHU0000cedar", church_name: "Cedar Hollow Fellowship", zone: "America/Denver", result_seen: true } }));
    kept.set("ozzie.settings.v1", JSON.stringify({ clientId: "", organization: "1001", serviceTypeId: "8001", planId: "9001" }));
    native.pcSaved = withFictionalOperations(nov22Capture());
    // Planning Center still signed in on this Mac: its scheduled checks must not run, nor its check show.
    native.pcStatus = { state: "connected", organization: "1001", checked_at_ms: Date.parse("2026-11-20T15:00:00Z"), source: "", problem: null };
    native.capture = JSON.stringify(fictionalGenesis());
    // A second Planning Center service watched before the switch: nothing of it reaches Genesis (review of the Services merge).
    kept.set("ozzie.also-watched.v1", JSON.stringify({ organization: "1001", services: [WATCHED_TOO] }));
    const app = await launch();
    await app.waitFor("From Genesis: 3 events in the next four weeks, 2 forms, 3 groups.");
    const t = dom.seen();
    expect(t).not.toMatch(/things? to decide|See who could help|Greeter|Planning Center check/u);
    expect(t).not.toMatch(SEVERAL_SERVICES);
    await app.go("Services");
    expect(dom.seen()).not.toMatch(SEVERAL_SERVICES);
    const { act } = await import("react");
    for (let i = 0; i < 8; i++) await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    await app.settle();
    expect(native.calls.map(([c]) => c)).not.toContain("check_sunday");
    expect(native.calls.map(([c]) => c)).not.toContain("load_sunday_recording");
    // Review of 4c3d32ac, M-c: Check my setup asks native about no Planning Center service on Genesis.
    await app.go("Settings");
    expect(dom.seen()).not.toMatch(SEVERAL_SERVICES);
    await app.press("Check my setup");
    await app.settle();
    const setupChecks = native.calls.filter(([c]) => c === "setup_check").map(([, a]) => a as Record<string, unknown>);
    expect(setupChecks.length).toBeGreaterThan(0);
    for (const a of setupChecks) { expect(a.serviceTypeId).toBeUndefined(); expect(a.planId).toBeUndefined(); }
    // M4: disconnecting Genesis leaves nothing of its last read on Today.
    await app.go("Settings");
    await app.press("Disconnect Genesis and forget its key");
    await app.go("Today");
    await app.settle();
    expect(dom.seen()).not.toContain("From Genesis: 3 events");
    expect(dom.seen()).toContain("Connect Genesis");
  }, 90_000);

  it("switching back to Genesis reads it once, recorded once (review of 4c3d32ac, M-d)", async () => {
    kept.set("ozzie.church-system.v1", JSON.stringify({ main: "breeze", connection: null,
      genesis: { system: "genesis", church_id: "CHU0000cedar", church_name: "Cedar Hollow Fellowship", zone: "America/Denver", result_seen: true } }));
    native.capture = JSON.stringify(fictionalGenesis());
    const app = await launch();
    await app.waitFor("Connect Breeze");
    await app.go("Settings");
    await app.press("Switch to Genesis");
    await app.press("Switch to Genesis");
    await app.waitFor("3 events in the next four weeks, 2 forms, 3 groups.");
    await app.settle();
    expect(native.calls.filter(([c]) => c === "church_system_check")).toHaveLength(1);
    expect(native.calls.filter(([c, a]) => c === "ledger_admit" && (a as { kind?: string }).kind === "check")).toHaveLength(1);
  }, 90_000);

  it("shows its own fictional example church from the connect screen", async () => {
    const app = await launch();
    await app.waitFor("What does your church use?");
    await app.press("Genesis");
    await app.press("See an example church first");
    await app.waitFor("Example church, not real.");
    expect(dom.seen()).toContain("What Genesis shares");
    expect(dom.seen()).toContain("Prayer Card was filled in 2 more times since the last check (7 in all).");
    expect(native.calls.map(([c]) => c)).not.toContain("church_system_check");
  }, 60_000);
});

describe("each system's fictional example church", () => {
  it("B1 Church's connect screen offers its own example, said as fictional, in B1 Church's words", async () => {
    const app = await launch();
    await app.waitFor("What does your church use?");
    await app.press("B1 Church");
    await app.press("See an example church first");
    await app.waitFor("Fictional example data");
    const t = dom.seen();
    expect(t).toContain("Lark Fictional is pending for Greeter.");
    expect(t).toContain("Example church, not real.");
    expect(misnamed(t)).toEqual([]);
    expect(native.calls.map(([c]) => c)).not.toContain("church_system_check");
  }, 60_000);
});

describe("a Mac set up on B1 Church, opened again", () => {
  const seed = (system: "b1" | "breeze") => kept.set("ozzie.church-system.v1", JSON.stringify({
    main: system, genesis: null,
    connection: system === "b1"
      ? { system, church_id: "CHU0000cedar", church_name: "Cedar Hollow Fellowship", address: "cedarhollow", service_id: "PLA0000nov22", service_day: "2026-11-22",
        service_name: "Sunday Gathering", zone: "America/Chicago", result_seen: true }
      : { system, church_id: "juniperstreet", church_name: "Juniper Street Church", address: "juniperstreet", service_id: "88120031", service_day: "2026-11-22",
        service_name: null, zone: null, result_seen: true },
  }));

  it("reads the service once on opening and every page speaks B1 Church's name", async () => {
    seed("b1");
    const app = await launch();
    await app.waitFor("B1 Church: Cedar Hollow Fellowship");
    expect(native.calls.filter(([c]) => c === "church_system_check")).toHaveLength(1);
    expect(dom.seen()).not.toContain("What does your church use?");
    await app.go("Services");
    await app.waitFor("Live read from B1 Church");
    const sunday = dom.seen();
    expect(sunday).toContain("Check B1 Church now");
    expect(misnamed(sunday)).toEqual([]);
    // Keeping watch: B1 Church is checked on a schedule, as Planning Center is.
    await app.go("Keeping watch");
    expect(dom.seen()).toContain("Ozzie checks B1 Church for you and tells you privately when something needs you.");
    expect(dom.seen()).toContain("B1 Church, Cedar Hollow Fellowship");
    expect(dom.seen()).toContain("On schedule");
    expect(dom.seen()).not.toMatch(/(?:schedule|notices?)[^.]*only for now/u);
    expect(misnamed(dom.seen())).toEqual([]);
    await app.go("Church rules");
    expect(dom.seen()).toContain("What Ozzie checks with B1 Church");
    expect(misnamed(dom.seen())).toEqual([]);
    await app.go("What happened");
    expect(dom.seen()).not.toContain("aren't listed under Recent work");
    expect(misnamed(dom.seen())).toEqual([]);
    await app.go("Settings");
    expect(dom.seen()).toContain("Connected to Cedar Hollow Fellowship in B1 Church, at cedarhollow.b1.church.");
    expect(dom.seen()).toContain("Other church systems");
    expect(dom.seen()).toContain("Also read Genesis: groups, events and forms");
    // Check now reads B1 Church again, never Planning Center.
    await app.go("Services");
    await app.press("Check B1 Church now");
    expect(native.calls.filter(([c]) => c === "church_system_check")).toHaveLength(2);
    expect(native.calls.map(([c]) => c)).not.toContain("check_sunday");
  }, 60_000);

  it("moves on to B1 Church's next plan by itself once the watched one has passed, says so on Today, and reads that one", async () => {
    seed("b1");
    vi.setSystemTime(new Date("2026-11-24T15:05:00Z"));
    native.choices = { outcome: "ok", choices: [{ id: "PLA0000nov22", day: "2026-11-22", name: "Sunday Gathering", shared: true },
      { id: "PLA0000nov29", day: "2026-11-29", name: "Sunday Gathering", shared: true }] };
    const app = await launch();
    await app.waitFor("Moved on to");
    expect(dom.seen()).toContain("Moved on to Sunday, November 29 · Sunday Gathering because Sunday, November 22 has passed.");
    const saved = JSON.parse(storage.getItem("ozzie.church-system.v1")!) as { connection: { service_id: string; service_day: string } };
    expect(saved.connection).toMatchObject({ service_id: "PLA0000nov29", service_day: "2026-11-29" });
    // The new plan is the one read; a capture of any other plan is never shown for it.
    expect(native.calls.filter(([c]) => c === "church_system_check").map(([, a]) => a.serviceId)).toEqual(["PLA0000nov29"]);
    expect(dom.seen()).not.toContain("needs a decision for Sunday, November 22");
  }, 60_000);

  it("Use a different system on a Mac that once used Planning Center speaks neutrally while it chooses (release review L3)", async () => {
    kept.set("ozzie.church-system.v1", JSON.stringify({ main: "breeze", genesis: null, connection: null }));
    kept.set("ozzie.settings.v1", JSON.stringify({ clientId: "", organization: "1001", serviceTypeId: "8001", planId: "9001" }));
    native.pcStatus = { state: "disconnected", organization: "", checked_at_ms: null, source: "", problem: null };
    const app = await launch();
    await app.waitFor("Connect Breeze");
    await app.press("Use a different system");
    await app.waitFor("What does your church use?");
    expect(dom.seen()).toContain("No church system connected yet");
    expect(dom.seen()).not.toContain("Planning Center not connected");
  }, 60_000);

  it("after a switch from Planning Center, nothing of a saved Planning Center check shows beside B1 Church's", async () => {
    seed("b1");
    kept.set("ozzie.settings.v1", JSON.stringify({ clientId: "", organization: "1001", serviceTypeId: "8001", planId: "9001" }));
    native.pcSaved = withFictionalOperations(nov22Capture());
    // Planning Center was signed out by the switch.
    native.pcStatus = { state: "disconnected", organization: "", checked_at_ms: null, source: "", problem: null };
    const app = await launch();
    await app.go("Services");
    await app.waitFor("Live read from B1 Church");
    const t = dom.seen();
    // The sidebar's count is B1 Church's, whatever Planning Center's status says.
    expect(t).toContain("3 things to decide");
    expect(t).not.toContain("Room use");
    expect(t).not.toContain("Saved copy");
    expect(misnamed(t)).toEqual([]);
    await app.go("Today");
    expect(misnamed(dom.seen())).toEqual([]);
    // Its saved Planning Center check holds names: Settings counts it and Delete saved checks removes it (release review L2).
    await app.go("Settings");
    await app.waitFor("1 saved for this church.");
    await app.press("Delete saved checks");
    await app.press("Yes, delete it");
    expect(native.calls.filter(([c]) => c === "delete_sunday_recordings").map(([, a]) => a)).toEqual([{ organization: "1001" }]);
  }, 60_000);

  it("shows what else the check read from B1 Church, and Planning Center's scheduled checks never run, even if it is still signed in", async () => {
    seed("b1");
    kept.set("ozzie.settings.v1", JSON.stringify({ clientId: "", organization: "1001", serviceTypeId: "8001", planId: "9001" }));
    native.pcStatus = { state: "connected", organization: "1001", checked_at_ms: Date.parse("2026-11-20T15:00:00Z"), source: "", problem: null };
    // A second Planning Center service watched before the switch: B1 Church stays one service (review of the Services merge).
    kept.set("ozzie.also-watched.v1", JSON.stringify({ organization: "1001", services: [WATCHED_TOO] }));
    const app = await launch();
    await app.go("Services");
    await app.waitFor("Also read from B1 Church");
    expect(dom.seen()).toContain("Youth Night");
    const { act } = await import("react");
    for (let i = 0; i < 8; i++) await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    await app.settle();
    expect(native.calls.map(([c]) => c)).not.toContain("check_sunday");
    expect(misnamed(dom.seen())).toEqual([]);
    // B1 Church's own count, on the page and the sidebar; nothing of the other service anywhere.
    expect(dom.seen()).toContain("3 things to decide");
    expect(dom.seen()).not.toMatch(SEVERAL_SERVICES);
    for (const page of ["Today", "Settings"]) { await app.go(page); expect(dom.seen()).not.toMatch(SEVERAL_SERVICES); }
  }, 60_000);

  it("moves on only to the next one of the same service; with none listed yet, it waits and says so", async () => {
    seed("b1");
    vi.setSystemTime(new Date("2026-11-24T15:05:00Z"));
    native.choices = { outcome: "ok", choices: [{ id: "PLA0000youth", day: "2026-11-25", name: "Youth Night", shared: true }] };
    const app = await launch();
    // Finish setting up says Ozzie is waiting for the next one, as it does for Planning Center.
    await app.waitFor("Ozzie is waiting for the next plan");
    const saved = JSON.parse(storage.getItem("ozzie.church-system.v1")!) as { connection: { service_id: string } };
    expect(saved.connection.service_id).toBe("PLA0000nov22");
    // Until the next one is listed, the service it has is the one read, as Planning Center's plan is (round 2: every check is
    // the schedule's, and each one looks for the next service first).
    const read = native.calls.filter(([c]) => c === "church_system_check").map(([, a]) => a.serviceId);
    expect(read.length).toBeGreaterThan(0);
    expect(read.every(id => id === "PLA0000nov22")).toBe(true);
  }, 60_000);

  it("a key B1 Church no longer accepts is said plainly on the service's page", async () => {
    seed("b1");
    native.keyGone = true;
    const app = await launch();
    await app.go("Services");
    await app.waitFor("B1 Church no longer accepts the key Ozzie has");
  }, 60_000);

  it("checks again on its own on its interval, and tells a decline on Keeping watch with no name in the notice", async () => {
    seed("b1");
    const app = await launch();
    await app.waitFor("B1 Church: Cedar Hollow Fellowship");
    expect(native.calls.filter(([c]) => c === "church_system_check")).toHaveLength(1);
    // Rowan, who had said yes to Vocals, says no; an hour on, the schedule reads again by itself.
    native.capture = JSON.stringify(b1Capture({ church: { id: "CHU0000cedar", time_zone: "America/Chicago" }, started_at: "2026-11-20T16:05:30Z", completed_at: "2026-11-20T16:05:34Z",
      reads: b1Capture().reads.map(r => ({ ...r, checked_at: "2026-11-20T16:05:32Z" })),
      assignments: b1Capture().assignments.map(a => a.id === "ASN-rowan" ? { ...a, status: "declined" as const } : a) }));
    const { act } = await import("react");
    for (let i = 0; i < 8; i++) await act(async () => { await vi.advanceTimersByTimeAsync(8 * 60_000); });
    await app.settle();
    expect(native.calls.filter(([c]) => c === "church_system_check").length).toBeGreaterThanOrEqual(2);
    expect(native.calls.map(([c]) => c)).not.toContain("check_sunday");
    await app.go("Keeping watch");
    await app.waitFor("Rowan Fictional declined Vocals after confirming.");
    // The notice, sent now or held for quiet hours on this Mac's clock, is native's fixed words: the page passes no name.
    const notices = native.calls.filter(([c]) => c === "notify_sunday_attention").map(([, a]) => a);
    // Told: sent, held for quiet hours on this Mac's clock, or seen in Ozzie when its window's own re-read found it (as for
    // Planning Center). Keeping watch says which; never none of them.
    expect(notices.length > 0 || /Notice waiting for quiet hours to end|Notice sent|Seen in Ozzie/u.test(dom.seen())).toBe(true);
    for (const args of notices) expect(Object.keys(args).every(k => k === "localOnly" || k === "day")).toBe(true);
    expect(JSON.stringify(notices)).not.toMatch(/Fictional|Vocals|Cedar/u);
    expect(misnamed(dom.seen())).toEqual([]);
  }, 60_000);

  it("reads again while its window is on screen once what it shows is out of date, before the hour is up", async () => {
    seed("b1");
    const app = await launch();
    await app.waitFor("B1 Church: Cedar Hollow Fellowship");
    expect(native.calls.filter(([c]) => c === "church_system_check")).toHaveLength(1);
    const { act } = await import("react");
    // The fixture's check finished at 15:00:04 (the clock starts at 15:05): still current twenty minutes on.
    for (let i = 0; i < 4; i++) await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000); });
    await app.settle();
    expect(native.calls.filter(([c]) => c === "church_system_check")).toHaveLength(1);
    // Past half an hour it is out of date, well before the next hourly check: read again (the fake's answer keeps its old time).
    for (let i = 0; i < 2; i++) await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000); });
    await app.settle();
    expect(native.calls.filter(([c]) => c === "church_system_check").length).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it("shows the last saved check, labeled as one, when B1 Church can't be read", async () => {
    seed("b1");
    native.keyGone = true;
    native.saved = JSON.stringify(b1Capture({ started_at: "2026-11-19T14:59:58Z", completed_at: "2026-11-19T15:00:04Z", reads: b1Capture().reads.map(r => ({ ...r, checked_at: "2026-11-19T15:00:00Z" })) }));
    const app = await launch();
    await app.go("Services");
    await app.waitFor("Saved copy of a check of B1 Church");
    expect(dom.seen()).toContain("This is not a current check.");
    await app.waitFor("B1 Church no longer accepts the key Ozzie has");
    expect(native.calls.filter(([c]) => c === "church_system_load_check").map(([, a]) => a)).toEqual([{ system: "b1", churchId: "CHU0000cedar", pathId: "b1.CHU0000cedar.PLA0000nov22.1795014004000.json" }]);
    expect(misnamed(dom.seen())).toEqual([]);
    // Settings counts it, and deleting it removes it from this Mac.
    await app.go("Settings");
    expect(dom.seen()).toContain("1 saved for this church.");
    expect(dom.seen()).toContain("so your services can still be shown if B1 Church can't be reached");
    await app.press("Delete saved checks");
    await app.press("Yes, delete it");
    expect(native.calls.filter(([c]) => c === "church_system_delete_checks").map(([, a]) => a)).toEqual([{ system: "b1", churchId: "CHU0000cedar" }]);
    expect(dom.seen()).toContain("No saved checks for this church.");
  }, 60_000);

  it("a live check replaces the saved one, and Show the last saved check brings it back on request", async () => {
    seed("b1");
    native.saved = JSON.stringify(b1Capture({ started_at: "2026-11-19T14:59:58Z", completed_at: "2026-11-19T15:00:04Z", reads: b1Capture().reads.map(r => ({ ...r, checked_at: "2026-11-19T15:00:00Z" })) }));
    const app = await launch();
    await app.go("Services");
    await app.waitFor("Live read from B1 Church");
    // Today follows the live check once it lands, with no restart (round 5).
    await app.go("Today");
    expect(dom.seen()).not.toContain("Saved copy of the check from");
    await app.go("Services");
    await app.press("Show the last saved check");
    await app.waitFor("Saved copy of a check of B1 Church");
    await app.press("Check B1 Church now");
    await app.waitFor("Live read from B1 Church");
  }, 60_000);

  it("Today shows B1 Church's own schedule, and jobs are said plainly to need Planning Center for now", async () => {
    seed("b1");
    // This Mac on another zone than the church's (Chicago), so the briefing's times are shown to follow the church's
    // clock and not this Mac's (review of round 3, L9).
    const tz = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    let app: Awaited<ReturnType<typeof launch>>;
    try {
      app = await launch();
      await app.waitFor("Checks B1 Church at least every hour while Ozzie is open, and when it opens.");
      // The briefing says the service's time on the church's clock, as the cards above it do (round 3).
      expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe("America/Los_Angeles");
      expect(dom.seen()).toContain("Vocals: 1 more person needed, Sun 9:00 AM.");
      expect(dom.seen()).toContain("Vocals still needs one more person at the 9:00 AM service.");
    } finally {
      if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz;
    }
    expect(misnamed(dom.seen())).toEqual([]);
    await app.go("Keeping watch");
    expect(dom.seen()).toContain("Keep services covered, the morning briefing and other jobs work with Planning Center only for now. Ozzie can't do these with B1 Church yet.");
    // Asked to take something on, Ask says the same, here, and sends nothing.
    await app.press("Ask Ozzie");
    await app.type("ask-input", "Keep an eye on Sunday for me");
    const { act } = await import("react");
    const form = all(dom.root as unknown as { childNodes: unknown[] }).find(n => (n as { tagName?: string }).tagName === "FORM" && byIdIn(n, "ask-input"));
    await act(async () => { (propsOf(form) as unknown as { onSubmit: (e: unknown) => void }).onSubmit({ preventDefault() {} }); });
    await app.settle();
    expect(dom.seen()).toContain("Keep services covered, the morning briefing and other jobs work with Planning Center only for now.");
    expect(native.calls.map(([c]) => c)).not.toContain("agent_step");
  }, 60_000);

  it("Ask reads B1 Church's check, says so, and keeps names on this Mac", async () => {
    seed("b1");
    const app = await launch();
    await app.waitFor("B1 Church: Cedar Hollow Fellowship");
    await app.go("Services");
    await app.waitFor("Live read from B1 Church");
    await app.press("Ask Ozzie");
    const t = dom.seen();
    expect(t).toContain("Based on: B1 Church check at");
    expect(t).toContain("Ozzie replaces the names it read from B1 Church with labels before asking the AI.");
    expect(t).not.toContain("Ask Ozzie works with Planning Center only for now");
    // Without AI help set up, Ask says so, as it does for Planning Center; what Ozzie can do is answered here.
    await app.press("What can you do?");
    const help = dom.seen();
    expect(help).toContain("Here is what Ozzie can do for you, from what it reads in B1 Church:");
    expect(help).toContain("Show who on a team could help with an open role");
    expect(help).not.toContain("kids team counts and background checks");
    expect(misnamed(help)).toEqual([]);
  }, 60_000);

  it("Disconnect forgets the key and deletes the church's saved checks, and Keeping watch lets the church go", async () => {
    seed("b1");
    native.saved = JSON.stringify(b1Capture());
    const app = await launch();
    await app.waitFor("B1 Church: Cedar Hollow Fellowship");
    await app.go("Settings");
    await app.press("Disconnect B1 Church");
    expect(dom.seen()).toContain("Ozzie forgets its B1 Church key and the checks it saved on this Mac");
    await app.press("Disconnect and forget the key");
    const order = native.calls.map(([c]) => c).filter(c => c === "church_system_forget" || c === "church_system_delete_checks");
    expect(order).toEqual(["church_system_forget", "church_system_delete_checks"]);
    expect(native.calls.filter(([c]) => c === "church_system_delete_checks").map(([, a]) => a)).toEqual([{ system: "b1", churchId: "CHU0000cedar" }]);
    // Nothing runs for the church let go of, and Keeping watch starts afresh.
    const before = native.calls.filter(([c]) => c === "church_system_check").length;
    const { act } = await import("react");
    for (let i = 0; i < 8; i++) await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000); });
    await app.settle();
    expect(native.calls.filter(([c]) => c === "church_system_check")).toHaveLength(before);
    await app.go("Keeping watch");
    expect(dom.seen()).not.toContain("First check for");
  }, 60_000);

  it("Breeze, as the live test church showed it: no page prints midnight or lists what Ozzie doesn't know (round 4)", async () => {
    seed("breeze");
    const live = breezeUntimedCapture();
    native.capture = JSON.stringify(breezeUntimedCapture({ church: { id: "juniperstreet", time_zone: "America/Chicago" },
      service: { ...live.service!, id: "88120031" } }));
    const app = await launch();
    await app.waitFor("Breeze: Juniper Street Church");
    const clean = (where: string) => {
      const seen = dom.seen();
      expect(seen, where).not.toMatch(/12:00\s?AM/u);
      expect(seen, where).not.toMatch(/doesn't read this number|didn't count this one|couldn't be checked/u);
      // Settings offers other systems by name, Planning Center among them, as for B1 Church.
      if (where !== "Settings") expect(misnamed(seen), where).toEqual([]);
    };
    clean("Today");
    // Today never reassures where Breeze can't say (round 5): what is known, and what needs a look.
    expect(dom.seen()).not.toMatch(/Nothing needs you right now|needs a decision\./u);
    expect(dom.seen()).toContain("1 thing needs your attention.");
    expect(dom.seen()).toContain("On Sunday, 4 people are listed: 2 said yes, 1 hasn't answered, 1 said no.");
    expect(dom.seen()).toContain("Greeter: Wren Fictional hasn't answered yet.");
    expect(dom.seen()).toContain("Breeze doesn't share how many people each role needs, so Ozzie can't say whether this Sunday is covered.");
    await app.go("Services");
    await app.waitFor("Live read from Breeze");
    expect(dom.seen()).toContain("Breeze doesn't share how many people each role needs, so Ozzie can't say whether this Sunday is covered.");
    expect(dom.seen()).toContain("Wren Fictional hasn't answered yet.");
    expect(dom.seen()).toContain("Also read from Breeze:");
    clean("Sunday");
    for (const page of ["Keeping watch", "What happened", "Settings"]) {
      await app.go(page);
      clean(page);
    }
  }, 60_000);

  it("Breeze: its own words, and the request it doesn't report said as unknown", async () => {
    seed("breeze");
    native.capture = JSON.stringify(breezeCapture({ assignments: [
      { id: "71001", position_id: "9627", person_id: "157801", status: "unconfirmed", asked: null },
      { id: "71002", position_id: "9628", person_id: "157802", status: "accepted", asked: null }] }));
    const app = await launch();
    await app.waitFor("Breeze: Juniper Street Church");
    await app.go("Services");
    await app.waitFor("Live read from Breeze");
    expect(dom.seen()).toContain("Breeze doesn't say whether the request was sent.");
    expect(misnamed(dom.seen())).toEqual([]);
    await app.go("Today");
    expect(dom.seen()).toContain("Breeze");
    expect(misnamed(dom.seen())).toEqual([]);
    // Ask: Breeze ties no team to its roles, so what Ozzie can do doesn't offer who could help.
    await app.press("Ask Ozzie");
    expect(dom.seen()).toContain("Based on: Breeze check at");
    await app.press("What can you do?");
    expect(dom.seen()).toContain("from what it reads in Breeze:");
    expect(dom.seen()).not.toContain("Show who on a team could help");
  }, 60_000);
});
