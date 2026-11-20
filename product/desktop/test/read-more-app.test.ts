// What else Ozzie can check, in the whole app (onboarding decision 24): a church set up on this Mac with Services only,
// with a saved check of its watched service. Today's "Finish setting up" holds the offer as its last item; the service's
// page holds it as a card; pressing it sends native the very command Settings' "Also check rooms, follow-ups and group
// events" sends, with the same arguments, and once Planning Center grants the access native's switch goes on. "Don't
// show this again" holds across a quit and a relaunch. The whole app on a fake native side; fictional data only.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeDom } from "./fake-dom.js";
import { nov22Capture } from "../../../core/src/fictional-sunday.js";
import { withFictionalOperationsOff } from "../../../core/src/fictional-operations.js";

const ORG = "1001";
const native = vi.hoisted(() => ({
  status: null as Record<string, unknown> | null, keychain: null as Record<string, unknown> | null,
  recordings: [] as { organization: string; plan_id: string; completed_at: string; path_id: string }[], saved: new Map<string, unknown>(),
  /** Native's switch for rooms, follow-ups and group events, for this church. */
  reads: false,
  /** Every command the page sent, with its arguments, in order. */
  sent: [] as { command: string; args: Record<string, unknown> }[],
  /** Native's order of statuses (connections.rs `revision`): a sign-in starting or ending is a newer one. */
  revision: 1,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args: Record<string, unknown> = {}) => {
    native.sent.push({ command, args });
    switch (command) {
      case "connection_status": return native.status;
      // The launch's check of the saved sign-in reaches Planning Center, so it answers a moment later; meanwhile the page
      // shows the last saved check (as in relaunch.test.ts).
      case "check_saved_connection": {
        await new Promise(r => setTimeout(r, 1500));
        if (native.keychain && args.organization === native.keychain.organization) native.status = { ...native.keychain };
        return native.status;
      }
      case "dev_defaults": return { clientId: "", organization: "", serviceTypeId: "", planId: "", autopilot: false };
      case "list_sunday_recordings": return native.recordings.filter(r => r.organization === args.organization);
      case "load_sunday_recording": { const c = native.saved.get(String(args.pathId)); if (!c) throw { recording: "not-found" }; return c; }
      // The check itself, as a Services-only connection records it.
      case "check_sunday": return { ...withFictionalOperationsOff(nov22Capture()), plan_id: String(args.planId), completed_at: new Date().toISOString() };
      case "background_info": return { fastSchedule: false, probe: false, tickMs: 30_000 };
      case "update_status": return null;
      case "notification_permission": return "unknown";
      case "responsibility_list": throw "unavailable";
      case "model_status": return { configured: false, route: "none", label: "No AI model set up", setup: "no-route" };
      case "managed_offer": return { open: false, reason: "closed" };
      case "planning_center_app": return true;
      case "operations_reads": return native.reads;
      case "set_operations_reads": native.reads = args.on === true; return native.reads;
      // A sign-in starts in the browser: native waits for Allow, a newer status than any read before it.
      case "connect_planning_center_app": native.status = { ...native.status, state: "waiting", problem: null, revision: ++native.revision }; return native.status;
      // Cancel sign-in: native puts the church it replaced back in use (its saved sign-in, not checked again yet) and keeps
      // how the attempt ended (connections.rs `abandoned`).
      case "cancel_connection": native.status = { ...native.keychain, state: "stored-unchecked", checked_at_ms: null, scopes: undefined, problem: null,
        last_attempt: { state: "cancelled", organization: "", checked_at_ms: null, source: "", problem: null }, revision: ++native.revision }; return null;
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

type El = { tagName?: string; textContent: string; childNodes: El[] } & Record<string, unknown>;
const all = (n: El): El[] => [n, ...n.childNodes.flatMap(all)];
const tagged = (tag: string) => all(dom.root as unknown as El).find(n => n.tagName === tag)!;
const tick = () => new Promise(r => setTimeout(r, 0));
const TODAY = "What needs you today";
// The item's title says what to do, among the list's other action titles and once ticked (review 2026-11-18); the card
// keeps the offer's own heading.
const ITEM = "Choose what else Ozzie checks";
const CARD = "What else Ozzie can check for Fictional Grace Church";
const BUTTON = "Let Ozzie read more in Planning Center";
/** Said while the launch's check of the saved sign-in is under way (sunday-page.tsx CHECKING_LINE). */
const CHECKING = "Checking Planning Center…";
/** The church set up on this Mac, checked at launch: connected with Services only. */
const CHECKED = { state: "connected", organization: ORG, checked_at_ms: Date.parse("2026-11-20T15:00:00Z"), source: "Planning Center /oauth/userinfo", problem: null,
  in_use: { organization: ORG, client_id: "", name: "Fictional Grace Church" }, organization_name: "Fictional Grace Church", scopes: "services", revision: 1 };

let unmount: (() => Promise<void>) | null = null;
beforeEach(async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  kept.clear(); native.saved.clear();
  kept.set("ozzie.settings.v1", JSON.stringify({ clientId: "", organization: ORG, serviceTypeId: "1500", planId: "92902197" }));
  // The saved check of a Services-only connection: every Calendar, People and Groups read recorded as not asked.
  const path = `sunday-${ORG}-92902197-1763218810000.json`;
  native.recordings = [{ organization: ORG, plan_id: "92902197", completed_at: "2026-11-15T15:00:10Z", path_id: path }];
  native.saved.set(path, { ...withFictionalOperationsOff(nov22Capture()), kind: "recording" });
  native.keychain = { ...CHECKED }; native.status = null; native.reads = false; native.sent = []; native.revision = 1;
  (await import("../src/operations-reads.js")).resetOperationsReads();
});
afterEach(async () => { await unmount?.(); unmount = null; vi.useRealTimers(); });

type Mounted = { settle: (n?: number) => Promise<void>; act: (f: () => Promise<void>) => Promise<void> };
async function launch(): Promise<Mounted> {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { App } = await import("../src/App.js");
  const root = createRoot(dom.root as unknown as Element);
  await act(async () => { root.render(React.createElement(App)); });
  const settle = async (n = 30) => { for (let i = 0; i < n; i++) await act(async () => { await tick(); }); };
  unmount = async () => { await act(async () => { root.unmount(); }); };
  const app = { settle, act };
  await waitFor(app, TODAY);
  // The check of the watched service names its day in the sidebar.
  const named = () => all(tagged("ASIDE")).some(n => n.tagName === "A" && n.textContent.startsWith("Services"));
  for (let i = 0; i < 40 && !named(); i++) { await act(async () => { await vi.advanceTimersByTimeAsync(500); }); await settle(5); }
  if (!named()) throw new Error(`the service's page was never named Sunday: ${dom.seen().slice(0, 1200)}`);
  // And the launch's check of the saved sign-in has answered, so it can't land on top of a sign-in started after it.
  for (let i = 0; i < 20 && dom.seen().includes(CHECKING); i++) { await act(async () => { await vi.advanceTimersByTimeAsync(500); }); await settle(5); }
  if (dom.seen().includes(CHECKING)) throw new Error("the launch's check never answered");
  return app;
}
/** Lets time pass, half a second at a time (the page reads native's status every second), until `text` is on screen. */
async function waitFor(app: Mounted, text: string, rounds = 40) {
  const { act } = await import("react");
  for (let i = 0; i < rounds && !dom.seen().includes(text); i++) { await act(async () => { await vi.advanceTimersByTimeAsync(500); }); await app.settle(5); }
  if (!dom.seen().includes(text)) {
    const seen = dom.seen(), at = Math.max(0, seen.indexOf("What else Ozzie can check"));
    throw new Error(`never saw "${text}" in: ${seen.slice(0, 600)} … ${seen.slice(at, at + 1700)}`);
  }
}
async function press(app: Mounted, label: string) {
  const b = all(tagged("MAIN")).find(n => n.tagName === "BUTTON" && n.textContent === label);
  if (!b) throw new Error(`no "${label}" in: ${dom.seen().slice(0, 1200)}`);
  await app.act(async () => { dom.press(b as never); await tick(); });
  await app.settle();
}
async function go(app: Mounted, label: string) {
  const link = all(tagged("ASIDE")).find(n => n.tagName === "A" && n.textContent.startsWith(label))!;
  const props = link[Object.keys(link).find(k => k.startsWith("__reactProps$"))!] as { onClick: (e: unknown) => void };
  await app.act(async () => { props.onClick({ preventDefault() {} }); await tick(); });
  await app.settle();
}
const sent = (command: string) => native.sent.filter(c => c.command === command).map(c => c.args);
const page = () => tagged("MAIN").textContent;

describe("Services only, after the first check", () => {
  it("Today's Finish setting up lists it last, and the service's page offers it as a card", async () => {
    const app = await launch();
    await waitFor(app, ITEM);
    // One item open at a time: starting with this Mac comes first; this one is a line until then.
    expect(page()).toContain("Start Ozzie when this Mac starts");
    await go(app, "Services");
    await waitFor(app, CARD);
    expect(page()).toContain("Check the rooms booked for Sunday for times that overlap: needs Planning Center Calendar.");
  }, 60_000);

  it("pressed on Today: the item keeps its waiting line while the browser is open, then shows done", async () => {
    const app = await launch();
    await waitFor(app, ITEM);
    // The item's line opens it (the list keeps one open at a time).
    const line = all(tagged("MAIN")).find(n => n.tagName === "BUTTON" && n.textContent.startsWith(ITEM));
    await app.act(async () => { dom.press(line as never); await tick(); });
    await app.settle();
    await press(app, BUTTON);
    expect(sent("connect_planning_center_app")).toEqual([{ operations: true, purpose: "operations" }]);
    await waitFor(app, "Waiting for you to choose Allow in your browser");
    expect(page()).toContain("Finish setting up");
    native.status = { ...CHECKED, scopes: "services-and-operations", revision: ++native.revision };
    const { act } = await import("react");
    for (let i = 0; i < 10 && sent("set_operations_reads").length === 0; i++) { await act(async () => { await vi.advanceTimersByTimeAsync(500); }); await app.settle(5); }
    expect(sent("set_operations_reads")).toEqual([{ on: true, pressed: false }]);
    await app.settle();
    // Done: the list's check mark, and nothing more to press for it.
    expect(page()).toContain(ITEM);
    expect(page()).not.toContain(BUTTON);
  }, 60_000);

  it("while its sign-in is in the browser, Today never says Planning Center isn't connected (review L8)", async () => {
    const app = await launch();
    await go(app, "Services");
    await waitFor(app, CARD);
    await press(app, BUTTON);
    await waitFor(app, "Waiting for you to choose Allow in your browser");
    await go(app, "Today");
    await app.settle();
    expect(page()).toContain(TODAY);
    // The church in use stays connected for the pages while only more access is being added.
    expect(dom.seen()).not.toContain("Planning Center not connected");
    expect(tagged("ASIDE").textContent).toContain("Planning Center: Fictional Grace Church");
    expect(page()).toContain("Finish setting up");
    // The regular check keeps saying what was true before the sign-in started (review 2026-11-18): the church is still
    // connected, so never "Nothing runs yet … once Planning Center is connected".
    expect(page()).toContain("Checks Planning Center at least every");
    expect(page()).not.toContain("Nothing runs yet");
  }, 60_000);

  it("while any sign-in is in the browser, Today's regular check says what was true before it started (review 2026-11-18)", async () => {
    const app = await launch();
    expect(page()).toContain("Checks Planning Center at least every");
    // Sign in again, from Settings: a sign-in with no stated purpose.
    native.status = { ...native.status, state: "waiting", problem: null, revision: ++native.revision };
    const { act } = await import("react");
    for (let i = 0; i < 6; i++) { await act(async () => { await vi.advanceTimersByTimeAsync(500); }); await app.settle(5); }
    expect(page()).toContain("Checks Planning Center at least every");
    expect(page()).not.toContain("Nothing runs yet");
  }, 60_000);

  it("pressing it sends the command Settings sends, with the same arguments; granted, native's switch goes on", async () => {
    // Settings first: "Also check rooms, follow-ups and group events".
    const settingsApp = await launch();
    await go(settingsApp, "Settings");
    await press(settingsApp, "Also check rooms, follow-ups and group events");
    const fromSettings = sent("connect_planning_center_app");
    expect(fromSettings).toEqual([{ operations: true, purpose: "operations" }]);
    await unmount!(); unmount = null;

    // A fresh launch: the same from the service's page.
    native.status = null; native.sent = []; native.reads = false;
    (await import("../src/operations-reads.js")).resetOperationsReads();
    const app = await launch();
    await go(app, "Services");
    await waitFor(app, CARD);
    await press(app, BUTTON);
    expect(sent("connect_planning_center_app")).toEqual(fromSettings);
    await waitFor(app, "Waiting for you to choose Allow in your browser");
    expect(sent("set_operations_reads")).toEqual([]);
    // While the browser is open the church stays connected: nothing offers to connect it, setup doesn't come back, and
    // Today keeps its Finish list with the same waiting line.
    expect(page()).not.toContain("Connect Planning Center");
    expect(tagged("ASIDE").textContent).not.toContain("Planning Center not connected");
    expect(tagged("ASIDE").textContent).not.toContain("Setting up");
    await go(app, "Today");
    expect(page()).toContain("Finish setting up");
    expect(page()).not.toContain("Connect Planning Center");
    await go(app, "Services");
    expect(page()).toContain("Waiting for you to choose Allow in your browser");
    // The person chooses Allow; Planning Center grants Calendar, People and Groups.
    native.status = { ...CHECKED, scopes: "services-and-operations", revision: ++native.revision };
    await waitFor(app, "Planning Center added Calendar, People and Groups.");
    expect(sent("set_operations_reads")).toEqual([{ on: true, pressed: false }]);
    expect(native.reads).toBe(true);
    expect(page()).not.toContain(BUTTON);
  }, 90_000);
});

describe("a sign-in for the church already connected (review items 4 and 7)", () => {
  const button = (label: string) => all(tagged("MAIN")).find(n => n.tagName === "BUTTON" && n.textContent === label) as (El & { hasAttribute(name: string): boolean }) | undefined;
  /** Whether the button is shown and can't be pressed (React marks it with the attribute). */
  const off = (label: string) => button(label)?.hasAttribute("disabled");
  it("Settings' Connect again: nothing says Planning Center isn't connected while it is in the browser, nor after Cancel sign-in", async () => {
    const app = await launch();
    await go(app, "Keeping watch");
    expect(page()).toContain("On schedule");
    const checks = () => sent("check_sunday").length;
    await go(app, "Settings");
    await waitFor(app, "Connected. Planning Center confirmed Fictional Grace Church");
    await press(app, "Connect again");
    // A sign-in again for the church in use: native asks for what it holds now, with no stated purpose from the page
    // (review 2026-11-18, late; it used to ask for Services alone).
    expect(sent("connect_planning_center_app")).toEqual([{ again: ORG }]);
    await waitFor(app, "Finish signing in in your browser.");
    const before = checks();
    const { act } = await import("react");
    for (let i = 0; i < 6; i++) { await act(async () => { await vi.advanceTimersByTimeAsync(500); }); await app.settle(5); }
    // Settings: still "Connect again" (pressed, so off while the browser waits), Cancel sign-in beside it, and the service list.
    expect(off("Connect again")).toBe(true);
    expect(button("Connect Planning Center")).toBeUndefined();
    expect(button("Cancel sign-in")).toBeDefined();
    expect(page()).not.toContain("Connect Planning Center first");
    // The sidebar: the church by name, and setup doesn't come back.
    expect(tagged("ASIDE").textContent).toContain("Planning Center: Fictional Grace Church");
    expect(tagged("ASIDE").textContent).not.toContain("Planning Center not connected");
    expect(tagged("ASIDE").textContent).not.toContain("Setting up");
    // Keeping watch says what was true before it started (review item 4).
    await go(app, "Keeping watch");
    expect(page()).toContain("On schedule");
    expect(page()).not.toContain("Waiting for setup");
    expect(page()).not.toContain("Not running yet");
    expect(page()).not.toContain("After Planning Center is connected");
    // A job's plan doesn't say Planning Center isn't connected either.
    await press(app, "Set up something new");
    await press(app, "Keep services covered");
    expect(page()).toContain("Looks good — start it");
    expect(page()).not.toContain("Planning Center isn't connected yet");
    // Words only: the checks still waited while the sign-in was in the browser.
    expect(checks()).toBe(before);

    // Cancel sign-in: as before it started, with no need to press "Check the connection".
    await go(app, "Settings");
    const rechecks = sent("check_saved_connection").length;
    await press(app, "Cancel sign-in");
    await waitFor(app, "Sign-in was cancelled on this Mac. Ozzie still uses Fictional Grace Church.");
    expect(page()).not.toContain("(organization 1001)");
    expect(off("Connect again")).toBe(false);
    expect(button("Connect Planning Center")).toBeUndefined();
    expect(page()).toContain("Connected. Planning Center confirmed Fictional Grace Church");
    expect(page()).not.toContain("Connect Planning Center first");
    expect(page()).not.toContain("hasn't been checked yet");
    expect(sent("check_saved_connection").length).toBe(rechecks);
    expect(tagged("ASIDE").textContent).toContain("Planning Center: Fictional Grace Church");
  }, 90_000);

  it("never shows a Connected line from before a check of the saved sign-in failed (review of item 7)", async () => {
    const app = await launch();
    await go(app, "Settings");
    await waitFor(app, "Connected. Planning Center confirmed Fictional Grace Church");
    // A later check of the saved sign-in fails; then a sign-in is started from Settings, and cancelled.
    native.status = { ...CHECKED, state: "failed", problem: "provider-failure", checked_at_ms: null, scopes: undefined, revision: ++native.revision };
    const { act } = await import("react");
    for (let i = 0; i < 4; i++) { await act(async () => { await vi.advanceTimersByTimeAsync(500); }); await app.settle(5); }
    expect(page()).not.toContain("Connected. Planning Center confirmed");
    await press(app, "Connect Planning Center");
    await waitFor(app, "Finish signing in in your browser.");
    await press(app, "Cancel sign-in");
    await waitFor(app, "Sign-in was cancelled on this Mac. Ozzie still uses Fictional Grace Church.");
    expect(page()).not.toContain("Connected. Planning Center confirmed");
  }, 90_000);
});

describe("the reads on, and a later sign-in without the access (review 2026-11-18, late)", () => {
  // An administrator narrowed what the account is given, or a sign-in asked for less: the switch still says on while
  // Calendar, People and Groups aren't held. Said plainly where the offer would be, in Settings and in What happened,
  // never the first-time offer as if nothing had happened.
  const LOST = "Your last Planning Center sign-in didn't include Calendar, People and Groups, so Ozzie can't check rooms, follow-ups and group events until they're allowed again.";
  it("the service's page, Settings and What happened each say so", async () => {
    native.reads = true;
    const app = await launch();
    await go(app, "Services");
    await waitFor(app, LOST);
    expect(page()).not.toContain("Right now Ozzie doesn't read Calendar, People or Groups");
    expect(page()).toContain("Copy a message for your administrator");
    await go(app, "Settings");
    await waitFor(app, `Granted: Services only. ${LOST}`);
    expect(page()).not.toContain("Rooms, follow-ups and group events aren't checked.");
    await go(app, "What happened");
    await waitFor(app, "Not asked — Planning Center didn't grant this");
    expect(page()).not.toContain("Not asked — turned off in Settings");
    // Asking again is the offer's own sign-in, for these reads.
    await go(app, "Services");
    await waitFor(app, LOST);
    await press(app, "Allow Calendar, People and Groups again in my browser");
    expect(sent("connect_planning_center_app")).toEqual([{ operations: true, purpose: "operations" }]);
  }, 90_000);
});

describe("a People grant for a note's To line starts nothing else (review M1)", () => {
  it("pressed, left in the browser, then a note's To line allowed People: the grant never turns on rooms, follow-ups or group events", async () => {
    // The Friday the fictional check was made, so its open roles (and their notes) are current.
    vi.setSystemTime(new Date("2026-11-20T15:05:00Z"));
    const app = await launch();
    await go(app, "Services");
    await waitFor(app, CARD);
    // "Let Ozzie read more in Planning Center", and the browser tab is left unfinished.
    await press(app, BUTTON);
    await waitFor(app, "Waiting for you to choose Allow in your browser");
    // Within the sign-in's five minutes, a note for one person: the To sheet asks for People.
    const note = all(tagged("MAIN")).find(n => n.tagName === "BUTTON" && n.textContent === "Prepare a note");
    if (!note) throw new Error(`no "Prepare a note" in: ${page().slice(0, 1500)}`);
    await app.act(async () => { dom.press(note as never); await tick(); });
    await app.settle();
    await press(app, "Open in Mail");
    await waitFor(app, "Fill in who it's to?");
    // The sheet's own promise, which this test holds the app to.
    expect(page()).toContain("Allowing it starts nothing else: room bookings, follow-ups and group meetings are read only if you turn them on in Settings.");
    await press(app, "Allow People access in my browser");
    // Native starts a new sign-in, which stops the first: each says what it is for.
    expect(sent("connect_planning_center_app")).toEqual([{ operations: true, purpose: "operations" }, { operations: true, purpose: "people-for-to" }]);
    // Planning Center grants Calendar, People and Groups to the To line's sign-in.
    native.status = { ...CHECKED, scopes: "services-and-operations", revision: ++native.revision };
    const { act } = await import("react");
    for (let i = 0; i < 12; i++) { await act(async () => { await vi.advanceTimersByTimeAsync(500); }); await app.settle(5); }
    // The note opens addressed, and nothing turned the reads on.
    expect(sent("open_draft_to").length).toBe(1);
    expect(sent("set_operations_reads").filter(a => a.on === true)).toEqual([]);
    expect(native.reads).toBe(false);
    // The offer's card says what is true now: the access is held, and the reads are still off until a person turns them on.
    await waitFor(app, "Your connection already includes Calendar, People and Groups, so this needs no new sign-in.");
    expect(page()).not.toContain("Planning Center added Calendar, People and Groups.");
  }, 90_000);
});

describe("dismissed", () => {
  it("Don't show this again holds across a quit and a relaunch, on the service's page and on Today", async () => {
    const app = await launch();
    await go(app, "Services");
    await waitFor(app, CARD);
    await press(app, "Don't show this again");
    expect(page()).toContain("Ozzie won't offer this again.");
    await waitFor(app, "Ozzie won't offer this again.");
    await go(app, "Today");
    expect(page()).not.toContain(ITEM);
    // Quit and open again: native keeps the saved sign-in and checks; the page keeps its own storage.
    await unmount!(); unmount = null;
    native.status = null;
    (await import("../src/operations-reads.js")).resetOperationsReads();
    const again = await launch();
    const { act } = await import("react");
    for (let i = 0; i < 8; i++) { await act(async () => { await vi.advanceTimersByTimeAsync(500); }); await again.settle(5); }
    expect(page()).not.toContain(ITEM);
    await go(again, "Services");
    await again.settle();
    expect(page()).toContain("Rooms and follow-ups weren't checked. Turn this on in Settings.");
    expect(page()).not.toContain("What else Ozzie can check");
    expect(page()).not.toContain(ITEM);
    // Settings still has it.
    await go(again, "Settings");
    expect(page()).toContain("Also check rooms, follow-ups and group events");
  }, 90_000);
});
