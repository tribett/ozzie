// A true relaunch of the whole app (live click-through of 0.3.0: every launch reopened setup at step 3). The first run is
// done through the app itself, on a fake native side that keeps what a real one keeps across a quit (the connection in
// the Keychain, the saved checks) and, as native does, holds no connection status at launch until the page asks it to
// check the saved sign-in. The page's own storage is kept across the remount the way the web view keeps it. Then the app
// is torn down and mounted again. Fictional data only.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeDom } from "./fake-dom.js";
import { nov22Capture, nov22LaterCapture } from "../../../core/src/fictional-sunday.js";
import { NOTHING_PLANNED, pickReply, SUNDAY_MORNING } from "./onboarding-fakes.js";

const ORG = "1001";
type Status = Record<string, unknown>;
const native = vi.hoisted(() => ({
  status: null as Record<string, unknown> | null, recordings: [] as { organization: string; plan_id: string; completed_at: string; path_id: string }[],
  keychain: null as Record<string, unknown> | null, pick: null as unknown, checkFails: false, saved: new Map<string, unknown>(), later: false,
  hangStatus: false, hangCheck: false, hangDefaults: false, calls: [] as string[],
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args: Record<string, unknown> = {}) => {
    // Native answers over IPC, never in the same moment: what launch waits for comes back a little later, so a page
    // drawn before it (a flash of Today on a brand-new Mac) is seen here too.
    native.calls.push(command);
    if (command === "dev_defaults" || command === "connection_status" || command === "list_sunday_recordings") await new Promise(r => setTimeout(r, 40));
    // A native launch command that never answers (review L6).
    if ((command === "connection_status" && native.hangStatus) || (command === "check_saved_connection" && native.hangCheck)
      || (command === "dev_defaults" && native.hangDefaults)) return new Promise(() => {});
    switch (command) {
      case "connection_status": return native.status;
      // Native holds no status at launch until the page asks it to check the saved sign-in (proactive.ts
      // verifySavedOnLaunch); the check reaches Planning Center, so it answers a moment later.
      case "check_saved_connection": {
        await new Promise(r => setTimeout(r, 1500));
        if (native.checkFails) throw "transport";
        if (native.keychain && args.organization === native.keychain.organization) native.status = { ...native.keychain };
        return native.status;
      }
      case "dev_defaults": return { clientId: "", organization: "", serviceTypeId: "", planId: "", autopilot: false };
      case "planning_center_app": return true;
      case "connect_planning_center_app": native.status = { state: "waiting", organization: "", checked_at_ms: null, source: "", problem: null }; return native.status;
      case "list_sunday_recordings": return native.recordings.filter(r => r.organization === args.organization);
      case "pick_service": return native.pick;
      case "check_sunday": {
        const c = { ...(native.later ? nov22LaterCapture() : nov22Capture()), plan_id: String(args.planId), completed_at: new Date().toISOString() };
        const path = `sunday-${ORG}-${c.plan_id}-${Date.now()}.json`;
        native.recordings.unshift({ organization: ORG, plan_id: c.plan_id, completed_at: c.completed_at, path_id: path });
        native.saved.set(path, { ...c, kind: "recording" });
        return c;
      }
      // A saved check, always labeled a recording (works without a live session).
      case "load_sunday_recording": {
        const c = native.saved.get(String(args.pathId));
        if (!c) throw { recording: "not-found" };
        return c;
      }
      case "background_info": return { fastSchedule: false, probe: false, tickMs: 30_000 };
      case "update_status": return null;
      case "notification_permission": return "unknown";
      case "model_status": return { configured: false, route: "none", label: "", setup: "no-route" };
      case "disconnect_planning_center": native.status = { state: "disconnected", organization: "", checked_at_ms: null, source: "", problem: null }; native.keychain = null; return native.status;
      // The jobs' list isn't part of these cases: answered at once, so the app's runner never waits on it.
      case "responsibility_list": throw "unavailable";
      case "set_no_ai": return { configured: false, route: "none", label: "", setup: "no-route" };
      case "own_key_providers": return [];
      case "managed_offer": return { open: false, reason: "closed" };
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
const CONNECTED: Status = { state: "connected", organization: ORG, checked_at_ms: Date.parse("2026-11-20T15:00:00Z"), source: "Planning Center /oauth/userinfo", problem: null,
  found: true, found_at_ms: Date.parse("2026-11-20T15:00:00Z"), in_use: { organization: ORG, client_id: "", name: "Fictional Grace Church" }, organization_name: "Fictional Grace Church" };
/** What native reports after a launch's check of the saved sign-in: connected, not a new sign-in. */
const CHECKED: Status = { ...CONNECTED, found: undefined, found_at_ms: undefined };

const FIRST_SCREEN = "It only reads. It never changes anything in Planning Center.";
/** A brand-new Mac's first screen since a second church system shipped (onboarding decision 21). */
const CHOOSE_SCREEN = "What does your church use?";
/** The service page's and Today's word for a saved check (sunday-page.tsx), with its real time. */
const SAVED_LINE = "Saved copy of";
const STEP = /Step \d of 3/u;
const TODAY = "What needs you today";
const CHECKING = "Checking Planning Center…";
/** Never on screen for a church set up on this Mac while the launch check of its saved sign-in is still under way. */
const NOT_CONNECTED = ["Not connected yet", "Connect Planning Center", "Planning Center not connected"];
const neverNotConnected = (screens: string[]) => { for (const screen of screens) for (const t of NOT_CONNECTED) { const i = screen.indexOf(t); expect(i >= 0 ? screen.slice(Math.max(0, i - 300), i + 200) : "", t).not.toContain(t); } };

let unmount: (() => Promise<void>) | null = null;
beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); native.status = null; native.recordings = []; native.keychain = null; native.checkFails = false; native.later = false; native.saved.clear();
  native.hangStatus = false; native.hangCheck = false; native.hangDefaults = false; native.calls = []; kept.clear(); });
afterEach(async () => { await unmount?.(); unmount = null; vi.useRealTimers(); });

type Mounted = { settle: (n?: number) => Promise<void>; act: (f: () => Promise<void>) => Promise<void> };
/** Mounts the app; `seen`, when given, keeps every screen from the first render on, as the app settles. */
async function launch(seen?: string[]): Promise<Mounted> {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { App } = await import("../src/App.js");
  const root = createRoot(dom.root as unknown as Element);
  await act(async () => { root.render(React.createElement(App)); });
  seen?.push(dom.seen());
  const settle = async (n = 30) => { for (let i = 0; i < n; i++) { await act(async () => { await tick(); }); seen?.push(dom.seen()); } };
  await settle();
  unmount = async () => { await act(async () => { root.unmount(); }); };
  return { settle, act };
}
async function press(app: Mounted, label: string) {
  const b = dom.button(label) ?? buttonStarting(label);
  if (!b) throw new Error(`no button "${label}" in: ${dom.seen().slice(0, 600)}`);
  await app.act(async () => { dom.press(b); await tick(); });
  await app.settle();
}
/** Lets time pass, half a second at a time, until `text` is on screen. */
/** On a brand-new Mac, "What does your church use?" comes first: Planning Center goes on exactly as before. */
async function choosePlanningCenter(app: Mounted) {
  if (dom.seen().includes(CHOOSE_SCREEN)) await press(app, "Planning Center");
}
async function waitFor(app: Mounted, text: string, rounds = 40) {
  const { act } = await import("react");
  for (let i = 0; i < rounds && !dom.seen().includes(text); i++) { await act(async () => { await vi.advanceTimersByTimeAsync(500); }); await app.settle(5); }
  if (!dom.seen().includes(text)) throw new Error(`never saw "${text}" in: ${dom.seen().slice(0, 900)}`);
}
/** Quit: the app is torn down; native keeps the saved sign-in and the saved checks, and starts with no status. */
async function quit() {
  await unmount!(); unmount = null;
  native.keychain = { ...CHECKED };
  native.status = null;
}
/** Reopen, and keep every screen shown until the launch's check of the saved sign-in is long done. */
async function reopen() {
  const seen: string[] = [];
  const app = await launch(seen);
  const { act } = await import("react");
  for (let i = 0; i < 12; i++) { await act(async () => { await vi.advanceTimersByTimeAsync(500); }); await app.settle(5); seen.push(dom.seen()); }
  return { app, seen };
}

/** The first run through the app itself: connect, Allow, the one service picked by itself, its read, then the AI screen. */
async function firstRun(ai: "No AI for now" | "Decide later") {
  native.pick = pickReply(SUNDAY_MORNING);
  const app = await launch();
  await choosePlanningCenter(app);
  await press(app, "Connect Planning Center");
  if (dom.button("Open Planning Center in my browser")) await press(app, "Open Planning Center in my browser");
  native.status = { ...CONNECTED };
  await waitFor(app, "Next: choose how Ozzie uses AI");
  await press(app, "Next: choose how Ozzie uses AI");
  await waitFor(app, ai);
  await press(app, ai);
  expect(dom.seen()).not.toMatch(STEP);
  expect(dom.seen()).not.toContain(ai);
  return app;
}

// First in this file, so no earlier case's timers or checks are still running when the clock is set to November 20.
describe("after Disconnect (0.3.0 live click-through)", () => {
  it("shows no badge on the service's entry and says nothing about a chosen plan", async () => {
    // The later check has a decision to make, so the entry has a badge before the disconnect (read just after it was made).
    native.later = true;
    vi.setSystemTime(new Date("2026-11-20T17:20:00Z"));
    const app = await firstRun("No AI for now");
    const badge = () => all(dom.root as unknown as { childNodes: unknown[] })
      .some(n => (n as { getAttribute?: (a: string) => string | null }).getAttribute?.("class") === "count");
    const nav = (label: string) => all(dom.root as unknown as { childNodes: unknown[] }).find(n => (n as { tagName?: string }).tagName === "A"
      && (n as { textContent: string }).textContent.startsWith(label)) as Record<string, { onClick?: (e: unknown) => void }> | undefined;
    const go = async (label: string) => {
      const a = nav(label)!;
      const props = a[Object.keys(a).find(k => k.startsWith("__reactProps$"))!];
      await app.act(async () => { props?.onClick?.({ preventDefault() {} }); await tick(); });
      await app.settle();
    };
    expect(badge()).toBe(true);
    await go("Settings");
    await press(app, "Disconnect Planning Center");
    await waitFor(app, "Planning Center not connected");
    expect(badge()).toBe(false);
    expect(dom.seen()).not.toContain("Chosen now");
  }, 60_000);
});

describe("the sidebar's Setting up entry and the screen agree (0.3.0 live click-through)", () => {
  it("stays while setup is on screen, step 3 included, and goes once setup is left with everything done", async () => {
    native.pick = pickReply(SUNDAY_MORNING);
    const app = await launch();
    expect(dom.seen()).toContain("Setting up");
    await choosePlanningCenter(app);
  await press(app, "Connect Planning Center");
    if (dom.button("Open Planning Center in my browser")) await press(app, "Open Planning Center in my browser");
    native.status = { ...CONNECTED };
    await waitFor(app, "Next: choose how Ozzie uses AI");
    // Step 3 with the first result on screen: setup is still showing, so its entry is too.
    expect(dom.seen()).toMatch(STEP);
    expect(dom.seen()).toContain("Setting up");
    await press(app, "Next: choose how Ozzie uses AI");
    await waitFor(app, "No AI for now");
    expect(dom.seen()).toContain("Setting up");
    await press(app, "No AI for now");
    expect(dom.seen()).not.toContain("Setting up");
  }, 60_000);
});

describe("a relaunch after first run (0.3.0 live click-through: setup reopened at step 3 on every launch)", () => {
  it("lands on Today with no setup after No AI for now, and never shows a setup screen on the way", async () => {
    await firstRun("No AI for now");
    await quit();
    const { seen } = await reopen();
    for (const screen of seen) { expect(screen).not.toMatch(STEP); expect(screen).not.toContain(FIRST_SCREEN); expect(screen).not.toContain(CHOOSE_SCREEN); }
    neverNotConnected(seen);
    expect(dom.seen()).toContain(TODAY);
    expect(dom.seen()).not.toContain("Setting up");
    // A second relaunch is the same.
    await quit();
    const twice = await reopen();
    for (const screen of twice.seen) expect(screen).not.toMatch(STEP);
    neverNotConnected(twice.seen);
    expect(dom.seen()).toContain(TODAY);
  }, 60_000);

  it("lands on Today after Decide later, with the AI choice left on Today's list", async () => {
    await firstRun("Decide later");
    await quit();
    const { seen } = await reopen();
    for (const screen of seen) { expect(screen).not.toMatch(STEP); expect(screen).not.toContain(FIRST_SCREEN); expect(screen).not.toContain(CHOOSE_SCREEN); }
    neverNotConnected(seen);
    expect(dom.seen()).toContain(TODAY);
    // On the page itself: the closed Ask panel holds the same words on its button.
    const page = all(dom.root as unknown as { childNodes: unknown[] }).find(n => (n as { tagName?: string }).tagName === "MAIN") as { textContent: string };
    expect(page.textContent).toContain("Choose how Ozzie uses AI");
  }, 60_000);

  it("a church that left at S5d with nothing planned opens again at that step (no result yet), never at the first screen", async () => {
    native.pick = pickReply(NOTHING_PLANNED);
    const app = await launch();
    await choosePlanningCenter(app);
  await press(app, "Connect Planning Center");
    if (dom.button("Open Planning Center in my browser")) await press(app, "Open Planning Center in my browser");
    native.status = { ...CONNECTED };
    await waitFor(app, "Go to Today");
    await press(app, "Go to Today");
    await quit();
    const { seen } = await reopen();
    for (const screen of seen) { expect(screen).not.toContain(FIRST_SCREEN); expect(screen).not.toContain(CHOOSE_SCREEN); }
    // Nothing saved to show: only the quiet line while the check is under way, never "not connected".
    neverNotConnected(seen);
    expect(seen[0]).toContain(CHECKING);
    expect(dom.seen()).toContain("Planning Center has no upcoming Christmas Eve plans yet");
  }, 60_000);

  it("an install from before the new first run (a plan chosen, saved checks) lands on Today with no setup at all", async () => {
    kept.set("ozzie.settings.v1", JSON.stringify({ clientId: "", organization: ORG, serviceTypeId: "1500", planId: "92902197" }));
    const path = `sunday-${ORG}-92902197-1763218810000.json`;
    native.recordings = [{ organization: ORG, plan_id: "92902197", completed_at: "2026-11-15T15:00:10Z", path_id: path }];
    native.saved.set(path, { ...nov22Capture(), kind: "recording" });
    native.keychain = { ...CHECKED };
    const { seen } = await reopen();
    for (const screen of seen) { expect(screen).not.toMatch(STEP); expect(screen).not.toContain(FIRST_SCREEN); expect(screen).not.toContain(CHOOSE_SCREEN); }
    neverNotConnected(seen);
    expect(dom.seen()).toContain(TODAY);
    expect(dom.seen()).not.toContain("Setting up");
  }, 60_000);

  it("a set-up church whose launch check can't reach Planning Center still lands on Today, not the first screen", async () => {
    await firstRun("No AI for now");
    await quit();
    native.checkFails = true;
    const { seen } = await reopen();
    for (const screen of seen) { expect(screen).not.toMatch(STEP); expect(screen).not.toContain(FIRST_SCREEN); expect(screen).not.toContain(CHOOSE_SCREEN); }
    // Until the check has failed it says it is checking, never "not connected"; once it has, it says so, as before, and
    // the saved check stays on screen.
    neverNotConnected(seen.filter(screen => screen.includes(CHECKING)));
    expect(seen[0]).toContain(CHECKING);
    expect(dom.seen()).not.toContain(CHECKING);
    expect(dom.seen()).toContain("Planning Center not connected");
    expect(dom.seen()).toContain(TODAY);
    expect(dom.seen()).toContain(SAVED_LINE);
  }, 60_000);
});

describe("while the launch check of a saved sign-in is under way (0.3.0 live: 'Not connected yet' for a second or two)", () => {
  it("a set-up church sees its last saved check at once, with a quiet 'Checking Planning Center…', then the live Today", async () => {
    await firstRun("No AI for now");
    await quit();
    const { seen } = await reopen();
    neverNotConnected(seen);
    // From the very first screen: the saved check with its real time, and the quiet line in a polite status.
    expect(seen[0]).toContain(TODAY);
    expect(seen[0]).toContain(CHECKING);
    const early = seen.find(screen => screen.includes(SAVED_LINE));
    expect(early, "the saved check while checking").toBeDefined();
    expect(early).toContain(CHECKING);
    // Once checked: no quiet line, and the church named in the sidebar.
    expect(dom.seen()).not.toContain(CHECKING);
    expect(dom.seen()).toContain("Planning Center: Fictional Grace Church");
  }, 60_000);

  it("says the quiet line in a polite status, and nothing on the service page offers to connect", async () => {
    await firstRun("No AI for now");
    await quit();
    const app = await launch();
    const polite = all(dom.root as unknown as { childNodes: unknown[] }).filter(n => {
      const el = n as { getAttribute?: (a: string) => string | null; textContent?: string };
      return el.getAttribute?.("role") === "status" && el.getAttribute?.("aria-live") === "polite" && (el.textContent ?? "").includes(CHECKING);
    });
    expect(polite.length).toBeGreaterThan(0);
    const nav = all(dom.root as unknown as { childNodes: unknown[] }).find(n => (n as { tagName?: string; textContent?: string }).tagName === "A"
      && (n as { textContent: string }).textContent.startsWith("Sunday")) as Parameters<typeof dom.press>[0] | undefined;
    expect(nav).toBeDefined();
    const props = (nav as unknown as Record<string, { onClick?: (e: unknown) => void }>)[Object.keys(nav as object).find(k => k.startsWith("__reactProps$"))!];
    await app.act(async () => { props?.onClick?.({ preventDefault() {} }); await tick(); });
    expect(dom.seen()).toContain(CHECKING);
    neverNotConnected([dom.seen()]);
  }, 60_000);

  it("a brand-new Mac (nothing saved) shows the first screen at once, with no flash of Today", async () => {
    const seen: string[] = [];
    const app = await launch(seen);
    const { act } = await import("react");
    for (let i = 0; i < 6; i++) { await act(async () => { await vi.advanceTimersByTimeAsync(100); }); await app.settle(5); seen.push(dom.seen()); }
    for (const screen of seen) { expect(screen).not.toContain(TODAY); expect(screen).not.toContain(CHECKING); }
    expect(dom.seen()).toContain(CHOOSE_SCREEN);
  }, 60_000);

  it("a sign-in that is really gone is said as before, once the check has answered", async () => {
    await firstRun("No AI for now");
    await quit();
    native.keychain = { state: "disconnected", organization: ORG, checked_at_ms: null, source: "", problem: null };
    const { seen } = await reopen();
    neverNotConnected(seen.filter(screen => screen.includes(CHECKING)));
    expect(dom.seen()).not.toContain(CHECKING);
    expect(dom.seen()).toContain("Planning Center not connected");
  }, 60_000);
});

describe("review L6: a native launch command that never answers never leaves the page stuck", () => {
  const STUCK = "Ozzie couldn't check Planning Center just now.";
  /** Lets `seconds` pass a second at a time, keeping every screen. */
  const pass = async (app: Mounted, seconds: number, seen: string[]) => {
    const { act } = await import("react");
    for (let i = 0; i < seconds; i++) { await act(async () => { await vi.advanceTimersByTimeAsync(1000); }); await app.settle(3); seen.push(dom.seen()); }
  };

  it("a set-up church: after 20 seconds it keeps its saved check, says it couldn't check, offers Check the connection, and starts its checks", async () => {
    await firstRun("No AI for now");
    await quit();
    native.hangCheck = true;
    native.calls = [];
    const seen: string[] = [];
    const app = await launch(seen);
    await pass(app, 10, seen);
    expect(dom.seen()).toContain(CHECKING);
    expect(native.calls).not.toContain("responsibility_list");
    await pass(app, 15, seen);
    neverNotConnected(seen);
    expect(dom.seen()).not.toContain(CHECKING);
    expect(dom.seen()).toContain(STUCK);
    expect(dom.seen()).toContain(TODAY);
    expect(dom.seen()).toContain(SAVED_LINE);
    expect(dom.button("Check the connection")).not.toBeNull();
    // Automatic checks started (the jobs' runner reads its list once it starts).
    expect(native.calls).toContain("responsibility_list");
    // Check the connection asks native again; once it answers, the line goes.
    native.hangCheck = false;
    native.status = null;
    await press(app, "Check the connection");
    await pass(app, 3, seen);
    expect(dom.seen()).not.toContain(STUCK);
    expect(dom.seen()).toContain("Planning Center: Fictional Grace Church");
  }, 90_000);

  it("a brand-new Mac whose status never comes shows the first screen after 20 seconds, never an empty page for good", async () => {
    native.hangStatus = true;
    const seen: string[] = [];
    const app = await launch(seen);
    await pass(app, 22, seen);
    expect(dom.seen()).toContain(CHOOSE_SCREEN);
    for (const screen of seen) { expect(screen).not.toContain(TODAY); expect(screen).not.toContain(CHECKING); }
  }, 60_000);

  it("a brand-new Mac whose launch settings never come shows the first screen after 20 seconds", async () => {
    native.hangDefaults = true;
    const seen: string[] = [];
    const app = await launch(seen);
    await pass(app, 22, seen);
    expect(dom.seen()).toContain(CHOOSE_SCREEN);
    for (const screen of seen) expect(screen).not.toContain(TODAY);
  }, 60_000);
});

