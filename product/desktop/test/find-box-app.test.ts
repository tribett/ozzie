// Find in Ozzie through the whole app (owner decision 2026-11-24), for a church on Planning Center with a live check, on a
// fake native side: ⌘K, the menu bar's Find… and the sidebar's Find open it; a person goes to their card on the Services
// page, a Settings section and a Church rules heading are opened with the keyboard on them; typing keeps nothing and
// makes no native call; and only the Ask row the person chooses hands the words to Ask, whose request to the AI holds a
// label, never a name it read. The example church is found as its own pages show it. Fixed fictional data only.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeDom } from "./fake-dom.js";
import { nov22Capture } from "../../../core/src/fictional-sunday.js";
import { containsNameWord } from "../../../core/src/ask.js";
import { pinnedRequestProblems } from "../../../core/test/harness/native-rules.js";
import type { AgentStepRequest } from "../../../core/src/harness/contract.js";
import { pickReply, SUNDAY_MORNING } from "./onboarding-fakes.js";

const ORG = "1001";
const native = vi.hoisted(() => ({
  status: null as Record<string, unknown> | null, pick: null as unknown, calls: [] as [string, Record<string, unknown>][],
  recordings: [] as { organization: string; plan_id: string; completed_at: string; path_id: string }[],
  /** An AI model set up on this Mac, answering each step from what it was given (`agent_step`). */
  model: false,
  steps: [] as AgentStepRequest[],
  events: new Map<string, () => void>(),
}));
/** A model that asks for the overview, then answers with its one fact: it sees only what Ozzie sends. */
function step(request: AgentStepRequest) {
  const got = request.messages.flatMap(m => m.role === "tool" ? [JSON.parse(m.content) as { payload?: { fact?: string } }] : []);
  if (!got.length) return { content: "", tool_calls: [{ id: "call_1_0", name: "sunday.overview", arguments: "{}" }], finish: "tool_calls" };
  return { content: JSON.stringify({ answer: "facts", facts: [got[0]!.payload!.fact] }), tool_calls: [], finish: "stop" };
}
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args: Record<string, unknown> = {}) => {
    native.calls.push([command, args]);
    if (native.model && ["ledger_admit", "ledger_transition", "ledger_event"].includes(command)) return null;
    switch (command) {
      case "connection_status": return native.status;
      case "check_saved_connection": return native.status;
      case "dev_defaults": return { clientId: "", organization: "", serviceTypeId: "", planId: "", autopilot: false };
      case "planning_center_app": return true;
      case "connect_planning_center_app": native.status = { state: "waiting", organization: "", checked_at_ms: null, source: "", problem: null }; return native.status;
      case "list_sunday_recordings": return native.recordings.filter(r => r.organization === args.organization);
      case "pick_service": return native.pick;
      case "check_sunday": {
        const c = { ...nov22Capture(), plan_id: String(args.planId), completed_at: new Date().toISOString() };
        native.recordings.unshift({ organization: ORG, plan_id: c.plan_id, completed_at: c.completed_at, path_id: `sunday-${ORG}-${c.plan_id}-${Date.now()}.json` });
        return c;
      }
      case "background_info": return { fastSchedule: false, probe: false, tickMs: 30_000 };
      case "update_status": return null;
      case "notification_permission": return "unknown";
      case "model_status": return native.model
        ? { configured: true, route: "local", label: "AI model on this Mac (qwen3:8b)", setup: "ready", key_account: null, checked_at_ms: Date.parse("2026-11-20T15:00:00Z") }
        : { configured: false, route: "none", label: "", setup: "no-route" };
      case "agent_step": {
        const request = (args as { request: AgentStepRequest }).request;
        native.steps.push(structuredClone(request));
        return step(request);
      }
      case "responsibility_list": throw "unavailable";
      case "set_no_ai": return { configured: false, route: "none", label: "", setup: "no-route" };
      case "own_key_providers": return [];
      case "managed_offer": return { open: false, reason: "closed" };
      default: return new Promise(() => {});
    }
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (name: string, handler: () => void) => { native.events.set(name, handler); return () => {}; }) }));

const dom = installFakeDom({ focus: true });
const kept = new Map<string, string>();
const written: [string, string][] = [];
const storage = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => { written.push([k, String(v)]); kept.set(k, String(v)); },
  removeItem: (k: string) => { kept.delete(k); }, clear: () => kept.clear(), key: (i: number) => [...kept.keys()][i] ?? null, get length() { return kept.size; } };
Object.assign(globalThis, { localStorage: storage });
Object.assign(globalThis.window as object, { localStorage: storage });
// The window's width as the page asks for it (App.tsx useAskDocked): wide enough for Ask beside the page, or not.
const media = { wide: true, listeners: new Set<() => void>() };
Object.assign(globalThis.window as object, { matchMedia: (q: string) => ({ media: q, get matches() { return q.includes("min-width") ? media.wide : false; },
  addEventListener: (_t: string, l: () => void) => { media.listeners.add(l); }, removeEventListener: (_t: string, l: () => void) => { media.listeners.delete(l); } }) });

const tick = () => new Promise(r => setTimeout(r, 0));
type Node = { tagName?: string; textContent: string; childNodes: unknown[]; getAttribute?: (a: string) => string | null; hasAttribute?: (a: string) => boolean };
const all = (n: { childNodes: unknown[] }): Node[] => [n as Node, ...n.childNodes.flatMap(c => all(c as { childNodes: unknown[] }))];
const nodes = () => all(dom.root as unknown as { childNodes: unknown[] });
const props = (el: unknown) => { const o = el as Record<string, Record<string, (e: unknown) => void>>; return o[Object.keys(o).find(k => k.startsWith("__reactProps$"))!]!; };
const findBox = () => nodes().find(n => n.getAttribute?.("id") === "find-input");
const options = () => nodes().filter(n => n.getAttribute?.("role") === "option");
const focused = () => dom.focused() as unknown as Node | null;
const CONNECTED = { state: "connected", organization: ORG, checked_at_ms: Date.parse("2026-11-20T15:00:00Z"), source: "Planning Center /oauth/userinfo", problem: null,
  found: true, found_at_ms: Date.parse("2026-11-20T15:00:00Z"), in_use: { organization: ORG, client_id: "", name: "Fictional Grace Church" }, organization_name: "Fictional Grace Church" };

let unmount: (() => Promise<void>) | null = null;
let keyListeners: ((e: unknown) => void)[] = [];
const realAdd = document.addEventListener.bind(document);
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true }); vi.setSystemTime(new Date("2026-11-20T15:00:00Z"));
  native.status = null; native.pick = null; native.calls = []; native.recordings = []; native.model = false; native.steps = []; native.events.clear();
  kept.clear(); written.length = 0; keyListeners = []; media.wide = true;
  document.addEventListener = ((type: string, l: (e: unknown) => void, o?: unknown) => { if (type === "keydown") keyListeners.push(l); realAdd(type, l as never, o as never); }) as typeof document.addEventListener;
});
// Every mount is let go even when a case fails, so the next one starts clean.
afterEach(async () => { try { await unmount?.(); } finally { unmount = null; document.addEventListener = realAdd; vi.useRealTimers(); } });

type Mounted = { settle: (n?: number) => Promise<void>; act: (f: () => Promise<void>) => Promise<void> };
async function launch(): Promise<Mounted> {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { App } = await import("../src/App.js");
  const root = createRoot(dom.root as unknown as Element);
  await act(async () => { root.render(React.createElement(App)); });
  unmount = async () => { await act(async () => { root.unmount(); }); };
  const settle = async (n = 30) => { for (let i = 0; i < n; i++) await act(async () => { await tick(); }); };
  await settle();
  return { settle, act };
}
async function press(app: Mounted, label: string) {
  const b = dom.button(label) ?? nodes().find(n => n.tagName === "BUTTON" && (n.textContent ?? "").startsWith(label)) as Parameters<typeof dom.press>[0] | undefined;
  if (!b) throw new Error(`no button "${label}" in: ${dom.seen().slice(0, 900)}`);
  await app.act(async () => { dom.press(b as Parameters<typeof dom.press>[0]); await tick(); });
  await app.settle();
}
async function waitFor(app: Mounted, text: string, rounds = 40) {
  const { act } = await import("react");
  for (let i = 0; i < rounds && !dom.seen().includes(text); i++) { await act(async () => { await vi.advanceTimersByTimeAsync(500); }); await app.settle(5); }
  if (!dom.seen().includes(text)) throw new Error(`never saw "${text}" in: ${dom.seen().slice(0, 1200)}`);
}
/** First run as a church with one service: connect, Allow, the service picked and read, then AI (or none). */
async function connected(model = false) {
  native.pick = pickReply(SUNDAY_MORNING);
  native.model = model;
  const app = await launch();
  if (dom.seen().includes("What does your church use?")) await press(app, "Planning Center");
  await press(app, "Connect Planning Center");
  if (dom.button("Open Planning Center in my browser")) await press(app, "Open Planning Center in my browser");
  native.status = CONNECTED;
  await waitFor(app, "Next: choose how Ozzie uses AI");
  await press(app, "Next: choose how Ozzie uses AI");
  await waitFor(app, "No AI for now");
  await press(app, "No AI for now");
  return app;
}
const cmdK = (app: Mounted) => app.act(async () => { for (const l of keyListeners) l({ key: "k", metaKey: true, shiftKey: false, altKey: false, ctrlKey: false, preventDefault() {} }); await tick(); });
const type = async (app: Mounted, text: string) => { await app.act(async () => { props(findBox()).onChange!({ target: { value: text } }); await tick(); }); await app.settle(3); };
/** A key in Find's box, going on up to its dialog as a browser sends it, unless something stopped it. */
const key = async (app: Mounted, k: string) => {
  await app.act(async () => {
    let stopped = false;
    const e = { key: k, preventDefault() {}, stopPropagation() { stopped = true; }, nativeEvent: { isComposing: false } };
    props(findBox()).onKeyDown!(e);
    const dialog = nodes().find(n => n.getAttribute?.("class") === "find-dialog");
    if (!stopped && dialog) props(dialog).onKeyDown?.(e);
    await tick();
  });
  await app.settle();
};
const setWide = (app: Mounted, wide: boolean) => app.act(async () => { media.wide = wide; for (const l of [...media.listeners]) l(); await tick(); });
/** The sidebar and the page: App alone makes them inert, for Ask over the page or for Find. */
const sideAndPage = () => nodes().filter(n => (n.tagName === "ASIDE" && (n.getAttribute?.("class") ?? "").startsWith("side")) || n.tagName === "MAIN");
const heading = () => nodes().find(n => n.tagName === "H1")?.textContent;

describe("Find in a church on Planning Center", () => {
  it("⌘K finds a person on the plan, and choosing them opens the Services page with the keyboard on their card", async () => {
    const app = await connected();
    expect(findBox()).toBeUndefined();
    await cmdK(app);
    expect(findBox()).toBeDefined();
    expect(focused()).toBe(findBox());
    await type(app, "cameron");
    expect(options().map(o => o.textContent)).toEqual(expect.arrayContaining(["Cameron Larkspur is pending for Lyrics, Worth a look", "Cameron Larkspur, Lyrics"]));
    await key(app, "ArrowDown");
    expect(nodes().find(n => n.getAttribute?.("id") === findBox()!.getAttribute!("aria-activedescendant"))!.textContent).toBe("Cameron Larkspur, Lyrics");
    await key(app, "Enter");
    expect(findBox()).toBeUndefined();
    expect(heading()).toBe("Are your services covered?");
    expect(focused()?.tagName).toBe("H3");
    expect(focused()?.textContent).toMatch(/^Cameron Larkspur is pending for Lyrics\./u);
  }, 90_000);

  it("the menu bar's Find… and the sidebar's Find open it; a Settings section and a Church rules heading get the keyboard", async () => {
    const app = await connected();
    await app.act(async () => { native.events.get("ozzie:find")!(); await tick(); });
    expect(focused()).toBe(findBox());
    // Quiet hours are set in Keeping watch, and said in Settings' section about what Ozzie runs: both found, the page first.
    await type(app, "quiet hours");
    expect(options().slice(0, 2).map(o => o.textContent)).toEqual(["Keeping watch", "What Ozzie runs and notices, Settings"]);
    await key(app, "ArrowDown");
    await key(app, "Enter");
    expect(heading()).toBe("How Ozzie is set up on this Mac");
    expect(focused()?.getAttribute?.("id")).toBe("runs-title");
    const row = dom.button("Find⌘K")!;
    await app.act(async () => { dom.press(row); await tick(); });
    await type(app, "rooms");
    const rooms = options().findIndex(o => o.textContent === "Rooms, Church rules");
    expect(rooms).toBeGreaterThanOrEqual(0);
    for (let i = 0; i < rooms; i++) await key(app, "ArrowDown");
    await key(app, "Enter");
    expect(heading()).toBe("How your church wants its services checked");
    expect(focused()?.tagName).toBe("H2");
    expect(focused()?.textContent).toBe("Rooms");
  }, 90_000);

  it("Escape closes it and the keyboard goes back to Find in the sidebar; the page was inert under it", async () => {
    const app = await connected();
    const row = dom.button("Find⌘K")!;
    (row as unknown as { focus(): void }).focus();
    await app.act(async () => { dom.press(row); await tick(); });
    const shell = nodes().find(n => (n.getAttribute?.("class") ?? "").startsWith("shell"))!;
    const page = nodes().filter(n => n.tagName === "ASIDE" || n.tagName === "MAIN");
    expect(page.length).toBeGreaterThanOrEqual(3);
    for (const n of page) expect(n.hasAttribute!("inert"), n.tagName).toBe(true);
    expect(nodes().find(n => n.getAttribute?.("role") === "status" && (n.getAttribute?.("class") ?? "") === "sr-only")!.hasAttribute!("inert")).toBe(false);
    await type(app, "greeter");
    await app.act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(dom.seen()).toMatch(/\d+ results?\./u);
    await key(app, "Escape");
    expect(findBox()).toBeUndefined();
    for (const n of page) expect(n.hasAttribute!("inert"), n.tagName).toBe(false);
    expect(shell.hasAttribute!("inert")).toBe(false);
    expect(focused()).toBe(row);
  }, 90_000);

  it("Quit Ozzie? takes over from an open Find: Find closes, the question has the keyboard, and Find stays closed after", async () => {
    const app = await connected();
    await cmdK(app);
    await type(app, "greeter");
    await app.act(async () => { (native.events.get("ozzie:quit-asked") as unknown as (e: unknown) => void)({ payload: { cards: 0, checks: true } }); await tick(); });
    await app.settle();
    expect(findBox()).toBeUndefined();
    expect(focused()?.textContent).toBe("Keep Ozzie running");
    // ⌘K waits while the question is open.
    await cmdK(app);
    expect(findBox()).toBeUndefined();
    await press(app, "Keep Ozzie running");
    expect(findBox()).toBeUndefined();
    await cmdK(app);
    expect(findBox()).toBeDefined();
  }, 90_000);

  it("typing keeps nothing and asks native for nothing; no results never reach Ask", async () => {
    const app = await connected();
    await cmdK(app);
    const before = native.calls.length;
    written.length = 0;
    const typed = ["Ca", "Cameron Lark", "Avery Brightwater weeks", "zzqqxx"];
    for (const t of typed) await type(app, t);
    await key(app, "Enter");
    await key(app, "Enter");
    const during = native.calls.slice(before);
    // The page's own once-a-second status read may run meanwhile; nothing else, and nothing carries what was typed.
    expect(during.map(([c]) => c).filter(c => c !== "connection_status")).toEqual([]);
    for (const t of typed) {
      expect(JSON.stringify(during)).not.toContain(t);
      expect(JSON.stringify(written)).not.toContain(t);
      expect(JSON.stringify([...kept.values()])).not.toContain(t);
    }
    expect(native.steps).toEqual([]);
    expect(nodes().find(n => n.getAttribute?.("id") === "ask-panel")?.hasAttribute!("hidden")).toBe(true);
    expect(findBox()).toBeDefined();
  }, 90_000);
});

describe("review of release-find, M2: the sidebar and the page have one owner of inert", () => {
  it("Ask coming over the page while Find is open: after Escape the page stays inert under Ask", async () => {
    const app = await connected();
    await press(app, "Ask Ozzie");
    expect(sideAndPage()).toHaveLength(2);
    for (const n of sideAndPage()) expect(n.hasAttribute!("inert"), n.tagName).toBe(false);
    await cmdK(app);
    for (const n of sideAndPage()) expect(n.hasAttribute!("inert"), n.tagName).toBe(true);
    // Text made bigger twice: the window is narrower than Ask docks at, and Ask now lies over the page.
    await setWide(app, false);
    await key(app, "Escape");
    expect(findBox()).toBeUndefined();
    for (const n of sideAndPage()) expect(n.hasAttribute!("inert"), n.tagName).toBe(true);
  }, 90_000);

  it("Ask going back beside the page while Find is open: the page under Find stays inert until Find closes", async () => {
    const app = await connected();
    await setWide(app, false);
    await press(app, "Ask Ozzie");
    for (const n of sideAndPage()) expect(n.hasAttribute!("inert"), n.tagName).toBe(true);
    await cmdK(app);
    await setWide(app, true);
    for (const n of sideAndPage()) expect(n.hasAttribute!("inert"), n.tagName).toBe(true);
    await key(app, "Escape");
    for (const n of sideAndPage()) expect(n.hasAttribute!("inert"), n.tagName).toBe(false);
  }, 90_000);
});

describe("the Ask row through the whole app", () => {
  it("hands Ask exactly what was typed when chosen; what reaches the AI holds a label for the name, never the name", async () => {
    const app = await connected(true);
    await waitFor(app, "AI: on this Mac (qwen3:8b)");
    await cmdK(app);
    const typed = "Has Cameron Larkspur answered for Lyrics yet?";
    await type(app, typed);
    expect(native.steps).toEqual([]);
    const ask = options().at(-1)!;
    expect(ask.textContent).toMatch(new RegExp(`^Ask Ozzie: “${typed.replace(/[?]/gu, "\\?")}”`, "u"));
    await key(app, "ArrowUp");
    await key(app, "Enter");
    await waitFor(app, "Ozzie answered", 20).catch(() => undefined);
    await app.settle();
    // Ask is open with the words as its question, asked as if typed there.
    expect(nodes().find(n => n.getAttribute?.("id") === "ask-panel")!.hasAttribute!("hidden")).toBe(false);
    expect(nodes().filter(n => n.tagName === "H3" && (n.getAttribute?.("class") ?? "").includes("ask-q")).map(n => n.textContent)).toEqual([typed]);
    expect(native.steps.length).toBeGreaterThan(0);
    const names = nov22Capture().names;
    const varying = JSON.stringify(native.steps.map(r => r.messages.slice(1)));
    expect(containsNameWord(varying, names)).toBe(false);
    expect(varying).not.toMatch(/Cameron|Larkspur/u);
    expect(native.steps[0]!.messages[1]!.content).toMatch(/\[Person \d+\]/u);
    for (const r of native.steps) expect(pinnedRequestProblems(r, names)).toEqual([]);
  }, 90_000);
});

describe("Find beside the example church", () => {
  it("finds the example's own people and findings, and offers no check of a church", async () => {
    const app = await launch();
    if (dom.seen().includes("What does your church use?")) await press(app, "Planning Center");
    await press(app, "See an example church first");
    await waitFor(app, "Example church, not real.");
    await cmdK(app);
    await type(app, "avery");
    expect(options().map(o => o.textContent)).toEqual(expect.arrayContaining(["Avery Brightwater, Greeter"]));
    await type(app, "check planning center now");
    expect(options().map(o => o.textContent)).not.toContain("Check Planning Center now");
  }, 90_000);
});
