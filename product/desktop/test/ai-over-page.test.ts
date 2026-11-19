// The AI screens opened over a page: the sidebar's "AI: … Change" and Today's Finish setting up (live in the release app,
// 2026-11-18). Every Change shows "How should Ozzie use AI?" from its top, even while a key guide is open, and the button
// after a working key names the page it really goes back to: "Back to Today", at Today's top, or "Back to Settings", at
// Settings' AI help section. The whole app on a fake native side; fictional data only, and no key: the fake native side
// answers the key check with "works", as native does after taking a key in its own window.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeDom } from "./fake-dom.js";
import { nov22Capture } from "../../../core/src/fictional-sunday.js";

const ORG = "1001";
const native = vi.hoisted(() => ({
  status: null as Record<string, unknown> | null, keychain: null as Record<string, unknown> | null,
  recordings: [] as { organization: string; plan_id: string; completed_at: string; path_id: string }[], saved: new Map<string, unknown>(),
  model: null as Record<string, unknown> | null, works: null as Record<string, unknown> | null,
  /** AI on this Mac's check and the key check: answered when the test says. */
  check: null as null | Promise<unknown>, enter: null as null | Promise<unknown>,
  /** What finding AI on this Mac answers, when a test says (the catalogue of models Ozzie downloads and sets up). */
  find: null as Record<string, unknown> | null,
  /** How the last download and set-up ended, as native remembers it (`local_model_progress`). */
  progress: null as Record<string, unknown> | null,
  /** How getting Ollama last ended, as native remembers it (`ollama_install_progress`). */
  ollama: null as Record<string, unknown> | null,
  /** Every command the page sent, in order. */
  sent: [] as string[],
  /** Native's events, by name: each listener the page holds (review M-1). */
  listeners: new Map<string, Set<(event: { payload: unknown }) => void>>(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args: Record<string, unknown> = {}) => {
    native.sent.push(command);
    switch (command) {
      case "connection_status": return native.status;
      case "check_saved_connection": if (native.keychain && args.organization === native.keychain.organization) native.status = { ...native.keychain }; return native.status;
      case "dev_defaults": return { clientId: "", organization: "", serviceTypeId: "", planId: "", autopilot: false };
      case "list_sunday_recordings": return native.recordings.filter(r => r.organization === args.organization);
      case "load_sunday_recording": { const c = native.saved.get(String(args.pathId)); if (!c) throw { recording: "not-found" }; return c; }
      case "background_info": return { fastSchedule: false, probe: false, tickMs: 30_000 };
      case "update_status": return null;
      case "notification_permission": return "unknown";
      case "responsibility_list": throw "unavailable";
      case "model_status": return native.model;
      case "managed_offer": return { open: false, reason: "closed" };
      case "own_key_providers": return [
        { id: "openai", name: "ChatGPT", company: "OpenAI", tag: "easiest", model: "gpt-5-mini", min_topup: "$5", typical_month: "under $1", retention_line: null,
          free_plan: false, checked_on: "2026-11-17", verified_live: true },
        { id: "anthropic", name: "Claude", company: "Anthropic", tag: null, model: "claude-haiku", min_topup: null, typical_month: null, retention_line: null,
          free_plan: false, checked_on: "2026-11-17", verified_live: true }];
      // The key is taken by native's own window and checked there; the page hears only the verdict.
      case "own_key_enter": if (native.enter) return native.enter; native.model = native.works; return { verdict: "works", status: native.works };
      case "own_key_forget": return null;
      case "local_ai_find": return native.find ?? { memory_gb: 16, advice: "medium", recommended: "qwen3:8b", recommended_size_bytes: 5_225_388_164, apps: [
        { app: "ollama", installed: true, running: true, start_hint: "", models: [{ id: "qwen3:8b", size_bytes: 5_225_388_164, fits: true, recommended: true }] },
        { app: "lm-studio", installed: false, running: false, start_hint: "", models: [] }] };
      case "local_ai_check": return native.check ?? new Promise(() => {});
      // "Download and set up": the first step at once; the rest comes as ozzie:local-model events, sent by the test.
      case "local_model_download": return { model: args.model, phase: "starting", done_bytes: 0, total_bytes: 5_225_388_164, end: null, check: null };
      case "local_model_progress": return native.progress;
      // "Download Ollama and set it up": the first step at once; the rest comes as ozzie:ollama-install events.
      case "ollama_install": return { phase: "starting", done_bytes: 0, total_bytes: 0, end: null };
      case "ollama_install_progress": return native.ollama;
      // No AI for now (contract N5 `set_no_ai`): no route at all.
      case "set_no_ai": native.model = { configured: false, route: "none", label: "No AI model set up", setup: "no-route" }; return native.model;
      default: return new Promise(() => {});
    }
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (event: string, handle: (e: { payload: unknown }) => void) => {
  const set = native.listeners.get(event) ?? new Set();
  set.add(handle);
  native.listeners.set(event, set);
  return () => { set.delete(handle); };
}) }));

const dom = installFakeDom();
const kept = new Map<string, string>();
const storage = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => { kept.set(k, String(v)); },
  removeItem: (k: string) => { kept.delete(k); }, clear: () => kept.clear(), key: (i: number) => [...kept.keys()][i] ?? null, get length() { return kept.size; } };
Object.assign(globalThis, { localStorage: storage });
Object.assign(globalThis.window as object, { localStorage: storage });

type El = { tagName?: string; textContent: string; childNodes: El[]; parentNode: El | null; scrollTop?: number; getAttribute?: (n: string) => string | null } & Record<string, unknown>;
const all = (n: El): El[] => [n, ...n.childNodes.flatMap(all)];
const nodes = () => all(dom.root as unknown as El);
const tagged = (tag: string) => nodes().find(n => n.tagName === tag)!;
const tick = () => new Promise(r => setTimeout(r, 0));
const TODAY = "What needs you today";
const CHOOSE = "How should Ozzie use AI?";
const WORKS = "It works. Ozzie will use your Anthropic account.";
const OWN_OPENAI = { configured: true, route: "own", label: "ChatGPT, with your key (gpt-5-mini)", setup: "ready", key_account: "own-provider:api.openai.com",
  provider: "openai", month: { used: 12, limit: 1000, resets_on: "2026-12-01" } };
const CLAUDE = { ...OWN_OPENAI, label: "Claude, with your key (claude-haiku)", key_account: "own-provider:api.anthropic.com", provider: "anthropic" };
const NONE = { configured: false, route: "none", label: "No AI model set up", setup: "no-route" };
const CHECKED = { state: "connected", organization: ORG, checked_at_ms: Date.parse("2026-11-20T15:00:00Z"), source: "Planning Center /oauth/userinfo", problem: null,
  in_use: { organization: ORG, client_id: "", name: "Fictional Grace Church" }, organization_name: "Fictional Grace Church" };

let unmount: (() => Promise<void>) | null = null;
const createElement = (globalThis.document as unknown as { createElement: (t: string) => El }).createElement;
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  kept.clear(); native.saved.clear();
  // A church set up on this Mac, with a saved check of its watched plan: launch lands on Today, the AI line in the sidebar.
  kept.set("ozzie.settings.v1", JSON.stringify({ clientId: "", organization: ORG, serviceTypeId: "1500", planId: "92902197" }));
  const path = `sunday-${ORG}-92902197-1763218810000.json`;
  native.recordings = [{ organization: ORG, plan_id: "92902197", completed_at: "2026-11-15T15:00:10Z", path_id: path }];
  native.saved.set(path, { ...nov22Capture(), kind: "recording" });
  native.keychain = { ...CHECKED }; native.status = null;
  native.model = { ...OWN_OPENAI }; native.works = { ...CLAUDE }; native.check = null; native.enter = null;
  native.find = null; native.progress = null; native.ollama = null; native.sent = []; native.listeners.clear();
});
afterEach(async () => {
  await unmount?.(); unmount = null; vi.useRealTimers();
  (globalThis.document as unknown as { createElement: unknown }).createElement = createElement;
});

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
  for (let i = 0; i < 40 && !(dom.seen().includes(TODAY) && dom.seen().includes("AI: ")); i++) { await act(async () => { await vi.advanceTimersByTimeAsync(500); }); await settle(5); }
  expect(dom.seen()).toContain(TODAY);
  return app;
}
async function pressOn(app: Mounted, b: El | undefined, label: string) {
  if (!b) throw new Error(`no "${label}" in: ${dom.seen().slice(0, 900)}`);
  await app.act(async () => { dom.press(b as never); await tick(); });
  await app.settle();
}
/** A button in the page (not the sidebar) whose words start with `label`. */
const press = (app: Mounted, label: string) =>
  pressOn(app, all(tagged("MAIN")).find(n => n.tagName === "BUTTON" && n.textContent.startsWith(label)), label);
/** The sidebar's AI line: "AI: ChatGPT, your key" and its quiet Change. */
const sidebarChange = (app: Mounted) => pressOn(app, all(tagged("ASIDE")).find(n => n.tagName === "BUTTON" && n.textContent === "Change"), "the sidebar's Change");
async function go(app: Mounted, label: string) {
  const link = all(tagged("ASIDE")).find(n => n.tagName === "A" && n.textContent.startsWith(label))!;
  const props = link[Object.keys(link).find(k => k.startsWith("__reactProps$"))!] as { onClick: (e: unknown) => void };
  await app.act(async () => { props.onClick({ preventDefault() {} }); await tick(); });
  await app.settle();
}
/** From "How should Ozzie use AI?" to Anthropic's key guide, and native's "works". */
async function claudeWorks(app: Mounted) {
  await press(app, "Your church's own AI");
  await press(app, "A key from an AI company");
  await press(app, "Claude (Anthropic)");
  await press(app, "Paste my key");
  expect(dom.seen()).toContain(WORKS);
}
const main = () => tagged("MAIN");
/**
 * Where things are on the page, as a browser measures them: Settings' AI help heading `at.top` px down its pane, less
 * however far the pane is scrolled; everything else at the pane's top.
 */
const at = { top: 0 };
function measured(top: number) {
  at.top = top;
  const doc = globalThis.document as unknown as { createElement: (t: string) => El; activeElement: unknown };
  doc.createElement = (t: string) => {
    const el = createElement.call(doc, t);
    Object.defineProperty(el, "parentElement", { get(this: El) { return this.parentNode; } });
    el.getBoundingClientRect = function (this: El) { return { top: this.getAttribute?.("id") === "ai-title" ? at.top - (main().scrollTop ?? 0) : 0 }; };
    el.focus = function (this: El) { doc.activeElement = this; };
    return el;
  };
  return doc;
}
const inPage = (label: string) => all(main()).find(n => n.tagName === "BUTTON" && n.textContent === label) ?? null;

describe("Change on the sidebar's AI line (live, 2026-11-18)", () => {
  it("always shows How should Ozzie use AI? from its top, even with a key guide open after It works.", async () => {
    const app = await launch();
    main().scrollTop = 600;
    await sidebarChange(app);
    expect(dom.seen()).toContain(CHOOSE);
    expect(main().scrollTop).toBe(0);
    await claudeWorks(app);
    main().scrollTop = 900;
    await sidebarChange(app);
    expect(dom.seen()).toContain(CHOOSE);
    expect(dom.seen()).not.toContain(WORKS);
    expect(dom.seen()).not.toContain("Use Claude's company, Anthropic");
    expect(main().scrollTop).toBe(0);
    // And again from a screen further in.
    await press(app, "Your church's own AI");
    await press(app, "A key from an AI company");
    await sidebarChange(app);
    expect(dom.seen()).toContain(CHOOSE);
    expect(dom.seen()).not.toContain("Which AI company?");
  }, 60_000);
});

describe("the button after a working key names where it goes (live, 2026-11-18)", () => {
  it("opened from Today: Back to Today, which opens Today at its top", async () => {
    const app = await launch();
    await sidebarChange(app);
    await claudeWorks(app);
    expect(inPage("Back to Settings")).toBeNull();
    expect(inPage("Back to Today")).not.toBeNull();
    main().scrollTop = 700;
    await press(app, "Back to Today");
    expect(dom.seen()).toContain(TODAY);
    expect(dom.seen()).not.toContain(CHOOSE);
    expect(main().scrollTop).toBe(0);
    expect(dom.seen()).toContain("AI: Claude, your key");
  }, 60_000);

  it("opened from Today's Finish setting up: Back to Today too", async () => {
    native.model = { ...NONE };
    const app = await launch();
    // Finish setting up opens at starting with this Mac; Not now moves it on to the AI item (on the page: the closed Ask
    // panel holds the same words on its button).
    expect(main().textContent).toContain("Choose how Ozzie uses AI");
    await press(app, "Not now");
    await pressOn(app, inPage("Choose") ?? undefined, "Finish setting up's Choose");
    expect(dom.seen()).toContain(CHOOSE);
    await claudeWorks(app);
    expect(inPage("Back to Settings")).toBeNull();
    main().scrollTop = 500;
    await press(app, "Back to Today");
    expect(dom.seen()).toContain(TODAY);
    expect(main().scrollTop).toBe(0);
  }, 60_000);

  it("opened from Settings: Back to Settings, which opens Settings at its AI help section", async () => {
    const doc = measured(900);
    const app = await launch();
    await go(app, "Settings");
    expect(dom.seen()).toContain("AI help");
    await sidebarChange(app);
    await claudeWorks(app);
    expect(inPage("Back to Today")).toBeNull();
    main().scrollTop = 0;
    await press(app, "Back to Settings");
    expect(dom.seen()).toContain("AI help");
    expect(dom.seen()).not.toContain(CHOOSE);
    const heading = doc.activeElement as El;
    expect(heading.tagName).toBe("H2");
    expect(heading.textContent).toBe("AI help");
    expect(main().scrollTop).toBe(900 - 16);
  }, 60_000);
});

describe("Ask with no AI leads to the AI choice, and back to the page it was over (walk-through, 2026-11-18)", () => {
  const askPanel = () => nodes().find(n => n.getAttribute?.("id") === "ask-panel")!;
  async function askFrom(app: Mounted) {
    await pressOn(app, all(tagged("ASIDE")).find(n => n.tagName === "BUTTON" && n.textContent === "Ask Ozzie"), "the sidebar's Ask Ozzie");
    expect(askPanel().textContent).toContain("Ask Ozzie needs AI, but everything else in Ozzie works without it.");
    await pressOn(app, all(askPanel()).find(n => n.tagName === "BUTTON" && n.textContent === "Choose how Ozzie uses AI"), "Ask's Choose how Ozzie uses AI");
    expect(dom.seen()).toContain(CHOOSE);
  }

  it("from Today: the choice opens over Today, and its way back says Back to Today", async () => {
    native.model = { ...NONE };
    const app = await launch();
    await askFrom(app);
    // The quiet way back on the choice itself names the page, not a bare "Back".
    expect(inPage("Back")).toBeNull();
    expect(inPage("Back to Today")).not.toBeNull();
    await press(app, "Back to Today");
    expect(dom.seen()).toContain(TODAY);
    expect(dom.seen()).not.toContain(CHOOSE);
  }, 60_000);

  it("from the service's page: the way back names that page, and goes there", async () => {
    native.model = { ...NONE };
    const app = await launch();
    // The service's page is named by the watched service's day, not read yet here: the sidebar says "Your service", and the
    // way back says it as a sentence would (setup-flow.test.ts backToName: "Sunday", "this weekend", "your service").
    const name = all(tagged("ASIDE")).find(n => n.tagName === "A" && n.getAttribute?.("href") === "#sunday")!.textContent;
    expect(name).toBe("Your service");
    await go(app, name);
    const title = all(main()).find(n => n.tagName === "H1")!.textContent;
    await askFrom(app);
    expect(inPage("Back to Your service")).toBeNull();
    expect(inPage("Back to your service")).not.toBeNull();
    await press(app, "Back to your service");
    expect(dom.seen()).not.toContain(CHOOSE);
    expect(all(main()).find(n => n.tagName === "H1")?.textContent).toBe(title);
  }, 60_000);
});

describe("Today's Finish setting up stops asking once AI is decided, wherever it was decided (walk-through, 2026-11-18)", () => {
  // The Finish setting up item's title. Only the page counts: the closed Ask panel holds the same words on its button.
  const ASKS = "Choose how Ozzie uses AI";
  const onToday = () => main().textContent;
  it("No AI for now in Settings' own AI section is an answer: Choose how Ozzie uses AI leaves Today", async () => {
    native.model = { ...NONE };
    const app = await launch();
    expect(onToday()).toContain(ASKS);
    await go(app, "Settings");
    // Settings' own AI section: its AI line's Change opens the choice inside the section, not over the page.
    await pressOn(app, inPage("Change") ?? undefined, "Settings' AI Change");
    expect(dom.seen()).toContain(CHOOSE);
    await press(app, "No AI for now");
    expect(dom.seen()).not.toContain(CHOOSE);
    await go(app, "Today");
    expect(onToday()).toContain(TODAY);
    expect(onToday()).not.toContain(ASKS);
    expect(JSON.parse(kept.get("ozzie.setup.v2")!)).toMatchObject({ aiAnswer: "none" });
  }, 60_000);

  it("a way chosen there is an answer too", async () => {
    native.model = { ...NONE };
    const app = await launch();
    expect(onToday()).toContain(ASKS);
    await go(app, "Settings");
    await pressOn(app, inPage("Change") ?? undefined, "Settings' AI Change");
    await claudeWorks(app);
    await press(app, "Back to Settings");
    await go(app, "Today");
    expect(onToday()).toContain(TODAY);
    expect(onToday()).not.toContain(ASKS);
    expect(JSON.parse(kept.get("ozzie.setup.v2")!)).toMatchObject({ aiAnswer: "chosen" });
  }, 60_000);
});

describe("the AI line in the sidebar stays true while the AI screens open and close (review L5, 2026-11-18)", () => {
  const LOCAL = { configured: true, route: "local", label: "AI model on this Mac (qwen3:8b)", setup: "ready", key_account: null, checked_at_ms: Date.parse("2026-11-18T13:00:00Z") };
  const sidebar = () => all(tagged("ASIDE")).find(n => n.textContent.startsWith("AI: "))?.textContent ?? "";

  it("Change reads the AI in use again, so a route saved meanwhile is shown", async () => {
    const app = await launch();
    expect(sidebar()).toContain("AI: ChatGPT, your key");
    // Native saved another route while the page wasn't looking (a check the page had let go of).
    native.model = { ...CLAUDE };
    await sidebarChange(app);
    expect(dom.seen()).toContain(CHOOSE);
    expect(sidebar()).toContain("AI: Claude, your key");
  }, 60_000);

  it("leaving the AI screens reads it again too", async () => {
    const app = await launch();
    await sidebarChange(app);
    native.model = { ...CLAUDE };
    await press(app, "Back");
    expect(dom.seen()).not.toContain(CHOOSE);
    expect(sidebar()).toContain("AI: Claude, your key");
  }, 60_000);

  it("a check let go of by pressing Change still updates the line when it answers", async () => {
    let answer: (v: unknown) => void = () => {};
    native.check = new Promise(resolve => { answer = resolve; });
    const app = await launch();
    await sidebarChange(app);
    await press(app, "Your church's own AI");
    await press(app, "AI on this Mac");
    await press(app, "Check that it answers");
    expect(dom.seen()).toContain("Asking qwen3:8b a test question.");
    // Change while it is checking: the screens start afresh, and the check's answer has nowhere to show.
    await sidebarChange(app);
    expect(dom.seen()).toContain(CHOOSE);
    expect(sidebar()).toContain("AI: ChatGPT, your key");
    // Native saves the route when the model answers, and then answers the page.
    native.model = { ...LOCAL };
    await app.act(async () => { answer({ verdict: "answers", seconds: 30, status: LOCAL }); await tick(); });
    await app.settle();
    expect(sidebar()).toContain("AI: on this Mac (qwen3:8b)");
    expect(dom.seen()).toContain(CHOOSE);
  }, 60_000);

  it("so does a key check let go of the same way", async () => {
    let answer: (v: unknown) => void = () => {};
    native.enter = new Promise(resolve => { answer = resolve; });
    const app = await launch();
    await sidebarChange(app);
    await press(app, "Your church's own AI");
    await press(app, "A key from an AI company");
    await press(app, "Claude (Anthropic)");
    await press(app, "Paste my key");
    await sidebarChange(app);
    expect(sidebar()).toContain("AI: ChatGPT, your key");
    native.model = { ...CLAUDE };
    await app.act(async () => { answer({ verdict: "works", status: CLAUDE }); await tick(); });
    await app.settle();
    expect(sidebar()).toContain("AI: Claude, your key");
    expect(dom.seen()).not.toContain(WORKS);
  }, 60_000);
});

describe("Settings opened at AI help stays there while the sections above it finish reading (review L6, 2026-11-18)", () => {
  async function backToSettings() {
    measured(900);
    const app = await launch();
    await go(app, "Settings");
    await sidebarChange(app);
    await claudeWorks(app);
    main().scrollTop = 0;
    await press(app, "Back to Settings");
    expect(main().scrollTop).toBe(900 - 16);
    return app;
  }
  const wait = (app: Mounted, ms: number) => app.act(async () => { await vi.advanceTimersByTimeAsync(ms); });

  it("moves with AI help when a section above grows just after opening", async () => {
    const app = await backToSettings();
    // A section above finished reading and grew by 200px.
    at.top = 1100;
    await wait(app, 2_000);
    expect(main().scrollTop).toBe(1100 - 16);
    // Only for a moment: later changes are the page's own.
    at.top = 1400;
    await wait(app, 5_000);
    expect(main().scrollTop).toBe(1100 - 16);
  }, 60_000);

  it("never fights the person's own scrolling", async () => {
    const app = await backToSettings();
    main().scrollTop = 300;
    at.top = 1100;
    await wait(app, 2_000);
    expect(main().scrollTop).toBe(300);
  }, 60_000);
});

describe("a download and set-up that ends after its screen was left (review M-1, 2026-11-18)", () => {
  const LOCAL = { configured: true, route: "local", label: "AI model on this Mac (qwen3:8b)", setup: "ready", key_account: null, checked_at_ms: Date.parse("2026-11-18T13:00:00Z") };
  const sidebar = () => all(tagged("ASIDE")).find(n => n.textContent.startsWith("AI: "))?.textContent ?? "";
  const row = (size: string, id: string, bytes: number, fits: boolean, recommended: boolean) =>
    ({ size, id, size_bytes: bytes, fits, offered: true, recommended, downloaded: false, set_up: false, disk: "enough", downloaded_by_ozzie: false });
  const FOUND = { memory_gb: 16, advice: "medium", recommended: "qwen3:8b", recommended_size_bytes: 5_225_388_164, free_bytes: 100_000_000_000,
    apps: [{ app: "ollama", installed: true, running: true, start_hint: "", models: [] }, { app: "lm-studio", installed: false, running: false, start_hint: "", models: [] }],
    catalogue: [row("medium", "qwen3:8b", 5_225_388_164, true, true), row("large", "gpt-oss:20b", 13_780_173_839, false, false)] };
  const step = (phase: string, end: string | null = null, verdict: string | null = null) =>
    ({ model: "qwen3:8b", phase, done_bytes: 1_000_000_000, total_bytes: 5_225_388_164, end, check: verdict ? { verdict, seconds: 31, small_room: false } : null });
  /** Native's ozzie:local-model event, to every listener the page holds. */
  async function emit(app: Mounted, payload: unknown) {
    await app.act(async () => { for (const handle of native.listeners.get("ozzie:local-model") ?? []) handle({ payload }); await tick(); });
    await app.settle();
  }
  async function downloadThenLeave(app: Mounted) {
    await sidebarChange(app);
    await press(app, "Your church's own AI");
    await press(app, "AI on this Mac");
    expect(dom.seen()).toContain("Medium, 5.2 GB");
    await press(app, "Download and set up");
    await emit(app, step("downloading"));
    expect(dom.seen()).toContain("Downloading qwen3:8b");
    // The screen says the window can close; the person goes back instead, all the way to Today.
    await press(app, "Back");
    await press(app, "Back");
    await press(app, "Back to Today");
    expect(dom.seen()).toContain(TODAY);
  }

  it("switches the AI when it answers, and the sidebar and Today say so", async () => {
    native.find = FOUND;
    const app = await launch();
    await downloadThenLeave(app);
    expect(sidebar()).toContain("AI: ChatGPT, your key");
    await emit(app, step("setting-up"));
    await emit(app, step("checking"));
    expect(sidebar()).toContain("AI: ChatGPT, your key");
    // Native saved the route when its check answered (no other choice was made since the press).
    native.model = { ...LOCAL };
    await emit(app, step("checking", "done", "answers"));
    expect(sidebar()).toContain("AI: on this Mac (qwen3:8b)");
    expect(main().textContent).toContain("qwen3:8b is downloaded and set up, and it answered Ozzie's check. Ozzie uses AI on this Mac now. Nothing leaves this Mac.");
    expect(JSON.parse(kept.get("ozzie.setup.v2")!)).toMatchObject({ aiAnswer: "chosen" });
    await press(app, "Close");
    expect(main().textContent).not.toContain("is downloaded and set up");
  }, 60_000);

  it("a choice made since leaves the AI as chosen, and says so", async () => {
    native.find = FOUND;
    const app = await launch();
    await downloadThenLeave(app);
    await emit(app, step("checking", "done", "choice-changed"));
    expect(sidebar()).toContain("AI: ChatGPT, your key");
    expect(main().textContent).toContain("qwen3:8b is downloaded and set up on this Mac, but you chose another way to use AI since, so Ozzie didn't switch to it.");
  }, 60_000);

  it("one that didn't finish says so, and its button opens AI on this Mac at its ending", async () => {
    native.find = FOUND;
    const app = await launch();
    await downloadThenLeave(app);
    const stalled = step("downloading", "stalled");
    await emit(app, stalled);
    expect(sidebar()).toContain("AI: ChatGPT, your key");
    expect(main().textContent).toContain("Setting up qwen3:8b on this Mac didn't finish. Open AI on this Mac to see why.");
    // Native remembers how the last one ended (local_model_progress), which the screen reads as it opens.
    native.progress = stalled;
    await press(app, "Open AI on this Mac");
    expect(dom.seen()).toContain("AI on this Mac");
    expect(dom.seen()).toContain("The download hasn't moved for two minutes, so Ozzie stopped it.");
    expect(main().textContent).not.toContain("Setting up qwen3:8b on this Mac didn't finish.");
  }, 60_000);

  it("ending while AI on this Mac is open: the screen says it, and Today adds nothing", async () => {
    native.find = FOUND;
    const app = await launch();
    await sidebarChange(app);
    await press(app, "Your church's own AI");
    await press(app, "AI on this Mac");
    await press(app, "Download and set up");
    native.model = { ...LOCAL };
    await emit(app, step("checking", "done", "answers"));
    expect(sidebar()).toContain("AI: on this Mac (qwen3:8b)");
    expect(dom.seen()).toContain("Ozzie will use qwen3:8b on this Mac.");
    await press(app, "Back to Today");
    expect(main().textContent).not.toContain("is downloaded and set up");
  }, 60_000);
});

describe("getting Ollama that ends after its screen was left (2026-11-19)", () => {
  const nobody = (app: string) => ({ app, installed: false, running: false, start_hint: "", models: [] });
  const NOTHING = { memory_gb: 16, advice: "medium", recommended: "qwen3:8b", recommended_size_bytes: 5_225_388_164, free_bytes: null, catalogue: [],
    apps: [nobody("ollama"), nobody("lm-studio")] };
  const at = (phase: string, end: string | null = null) => ({ phase, done_bytes: 0, total_bytes: 229_245_253, end });
  async function emit(app: Mounted, payload: unknown) {
    await app.act(async () => { for (const handle of native.listeners.get("ozzie:ollama-install") ?? []) handle({ payload }); await tick(); });
    await app.settle();
  }
  async function getThenLeave(app: Mounted) {
    await sidebarChange(app);
    await press(app, "Your church's own AI");
    await press(app, "AI on this Mac");
    await press(app, "Download Ollama and set it up");
    await emit(app, at("downloading"));
    expect(dom.seen()).toContain("Downloading Ollama");
    await press(app, "Back");
    await press(app, "Back");
    await press(app, "Back to Today");
    expect(dom.seen()).toContain(TODAY);
  }

  it("says how it ended on Today in the install's own words, with the way back to AI on this Mac", async () => {
    native.find = NOTHING;
    const app = await launch();
    await getThenLeave(app);
    await emit(app, at("opening", "ready"));
    // Ollama answers now: the model offer comes next, on AI on this Mac.
    expect(main().textContent).toContain("Ollama is installed and open.");
    native.ollama = at("opening", "ready");
    await press(app, "Open AI on this Mac");
    expect(dom.seen()).toContain("AI on this Mac");
    expect(main().textContent).not.toContain("Ollama is installed and open.Open AI on this Mac");
  }, 60_000);

  it("one that didn't finish says why, and Close takes the line away", async () => {
    native.find = NOTHING;
    const app = await launch();
    await getThenLeave(app);
    await emit(app, at("downloading", "offline"));
    expect(main().textContent).toContain("Ozzie couldn't reach ollama.com. Check that this Mac is online, then press Download Ollama and set it up again.");
    expect(inPage("Open AI on this Mac")).not.toBeNull();
    await press(app, "Close");
    expect(main().textContent).not.toContain("Ozzie couldn't reach ollama.com.");
  }, 60_000);

  it("a Stop says nothing on Today, and an ending while the screen is open says it there only", async () => {
    native.find = NOTHING;
    const app = await launch();
    await getThenLeave(app);
    await emit(app, at("downloading", "cancelled"));
    expect(main().textContent).not.toContain("The download is stopped");
    expect(inPage("Open AI on this Mac")).toBeNull();
    await sidebarChange(app);
    await press(app, "Your church's own AI");
    await press(app, "AI on this Mac");
    await press(app, "Download Ollama and set it up");
    await emit(app, at("downloading", "offline"));
    expect(dom.seen()).toContain("Ozzie couldn't reach ollama.com.");
    await press(app, "Back");
    await press(app, "Back");
    await press(app, "Back to Today");
    expect(main().textContent).not.toContain("Ozzie couldn't reach ollama.com.");
  }, 60_000);
});

describe("on AI on this Mac, choosing or downloading never changes the AI in use until the check answers (2026-11-18)", () => {
  it("with a key from an AI company in use", async () => {
    const LOCAL = { configured: true, route: "local", label: "AI model on this Mac (qwen3:8b)", setup: "ready", key_account: null, checked_at_ms: Date.parse("2026-11-18T13:00:00Z") };
    const sidebar = () => all(tagged("ASIDE")).find(n => n.textContent.startsWith("AI: "))?.textContent ?? "";
    const row = (size: string, id: string, bytes: number) => ({ size, id, size_bytes: bytes, fits: true, offered: true, recommended: size === "medium", downloaded: false, set_up: false,
      disk: "enough", downloaded_by_ozzie: false });
    native.find = { memory_gb: 32, advice: "large", recommended: "gpt-oss:20b", recommended_size_bytes: 13_780_173_839, free_bytes: 100_000_000_000,
      apps: [{ app: "ollama", installed: true, running: true, start_hint: "", models: [{ id: "llama3.2:latest", size_bytes: 2_019_393_189, fits: true, recommended: false }] },
        { app: "lm-studio", installed: false, running: false, start_hint: "", models: [] }],
      catalogue: [row("medium", "qwen3:8b", 5_225_388_164), row("large", "gpt-oss:20b", 13_780_173_839)] };
    const emit = async (app: Mounted, payload: unknown) => {
      await app.act(async () => { for (const handle of native.listeners.get("ozzie:local-model") ?? []) handle({ payload }); await tick(); });
      await app.settle();
    };
    const app = await launch();
    await sidebarChange(app);
    await press(app, "Your church's own AI");
    await press(app, "AI on this Mac");
    const changes = () => native.sent.filter(c => /^(set_|own_key_(enter|paste|use_kept|check_again|remove)|remove_own_key|local_ai_check|managed_connect)/u.test(c));
    // Choosing rows: each of the three, and the person's own model, then back.
    await press(app, "Large, 13.8 GB");
    await press(app, "llama3.2");
    await press(app, "Medium, 5.2 GB");
    expect(changes()).toEqual([]);
    expect(sidebar()).toContain("AI: ChatGPT, your key");
    // Downloading, each step, and a check that doesn't answer.
    await press(app, "Download and set up");
    for (const phase of ["downloading", "verifying", "finishing", "setting-up", "checking"]) {
      await emit(app, { model: "qwen3:8b", phase, done_bytes: 1, total_bytes: 5_225_388_164, end: null, check: null });
      expect(sidebar()).toContain("AI: ChatGPT, your key");
    }
    await emit(app, { model: "qwen3:8b", phase: "checking", done_bytes: 5_225_388_164, total_bytes: 5_225_388_164, end: "done", check: { verdict: "thinks-too-long", seconds: 40, small_room: false } });
    expect(sidebar()).toContain("AI: ChatGPT, your key");
    expect(changes()).toEqual([]);
    // Only an answer switches it, and native does that itself: the page sends nothing that changes the AI.
    native.model = { ...LOCAL };
    await press(app, "Download and set up");
    await emit(app, { model: "qwen3:8b", phase: "checking", done_bytes: 5_225_388_164, total_bytes: 5_225_388_164, end: "done", check: { verdict: "answers", seconds: 40, small_room: false } });
    expect(sidebar()).toContain("AI: on this Mac (qwen3:8b)");
    expect(changes()).toEqual([]);
  }, 60_000);
});
