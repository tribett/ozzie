// Find in Ozzie's box (owner decision 2026-11-24), mounted on the fake document with focus kept: it opens from the
// sidebar's Find, with ⌘K and from the menu bar's Find… (the page's event); the page under it is inert while it is open and
// the keyboard goes back where it was when it closes; it is a combobox over a listbox in groups, arrows move and Enter
// chooses; the app's one polite status line says how many were found; typing keeps and sends nothing; and the last row,
// "Ask Ozzie: …", hands over exactly what was typed only when the person picks it, never on its own when nothing is found.
// Fixed fictional data only.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const events = vi.hoisted(() => ({ handlers: new Map<string, () => void>() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => { throw new Error("NATIVE_CALL_FORBIDDEN"); }) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (name: string, handler: () => void) => { events.handlers.set(name, handler); return () => events.handlers.delete(name); }) }));
import { installFakeDom } from "./fake-dom.js";
import { invoke } from "@tauri-apps/api/core";
import { Announcer } from "../src/announce.js";
import { ANNOUNCE_AFTER_MS, FIND, FIND_EVENT, FindBox, FindRow, GROUP_ROWS, isFindKey, useFindOpener, useFoundFocus, type AskRow, type FoundFocus } from "../src/find-box.js";
import { useModal } from "../src/modal.js";
import { PEOPLE_ORDER, rulesHeadings, type FindInput, type FindTarget } from "../src/find-items.js";
import { systemWords } from "../src/church-system.js";
import { SETTINGS_SECTIONS } from "../src/connection-page.js";
import { buildSundayBrief } from "../../../core/src/sunday-brief.js";
import { nov22Capture } from "../../../core/src/fictional-sunday.js";
import { withFictionalOperations } from "../../../core/src/fictional-operations.js";
import { sundayOperations } from "../../../core/src/operations-capture.js";

const dom = installFakeDom({ focus: true });
type El = { tagName: string; childNodes: El[]; textContent: string; getAttribute(n: string): string | null; hasAttribute(n: string): boolean; setAttribute(n: string, v: string): void };
const all = (n: El): El[] => [n, ...(n.childNodes ?? []).flatMap(all)];
const els = () => all(dom.root as unknown as El).filter(n => n.tagName);
const byRole = (role: string) => els().filter(n => n.getAttribute?.("role") === role);
const props = (el: unknown) => { const o = el as Record<string, Record<string, (e: unknown) => void>>; return o[Object.keys(o).find(k => k.startsWith("__reactProps$"))!]!; };
const box = () => els().find(n => n.getAttribute?.("id") === "find-input");
const options = () => byRole("option");
const activeOption = () => { const id = box()?.getAttribute("aria-activedescendant"); return id ? options().find(o => o.getAttribute("id") === id) ?? null : null; };
const status = () => els().filter(n => n.tagName === "P" && n.getAttribute("role") === "status").map(n => n.textContent.trim());
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

const rules = { sundayLeads: [], checkInAfterSundaysInARow: 3 };
const KEY_HOLDERS = [{ id: "list-1", label: "Key holders", people: ["Jordan Quillfeather", "Pat Example"] }];
let listsNow: FindInput["lists"] = KEY_HOLDERS;
const capture = withFictionalOperations(nov22Capture());
const input = (): FindInput => ({
  words: systemWords("planning-center"), pages: [{ id: "today", label: "Today" }, { id: "sunday", label: "Services" }, { id: "connection", label: "Settings" }], settingUp: null,
  settings: SETTINGS_SECTIONS.map(s => ({ id: s.id, label: s.label })), rules: rulesHeadings({ other: false, systemName: "Planning Center", leads: "Scheduled leads", told: false, procedures: false }),
  procedures: [], example: false, openCards: 0, genesis: null, can: { check: true, ask: true, checkSetup: true },
  lists: listsNow,
  services: [{ name: null, brief: buildSundayBrief(capture, rules, capture.completed_at, true), decisions: [], operations: sundayOperations(capture, rules, {}), names: capture.names, capture, key: k => k }],
});

const chosen: FindTarget[] = [];
const handed: string[] = [];
let ask: AskRow = "ai";
/** The app as Find sits in it: the sidebar with Find, the page, the status line; Find over all of it while open. */
function Host() {
  const find = useFindOpener(true);
  return React.createElement(Announcer, null,
    React.createElement("div", { className: "shell" },
      React.createElement("aside", null, React.createElement(FindRow, { onOpen: find.show })),
      React.createElement("main", null, React.createElement("button", { type: "button" }, "Something on the page"))),
    find.open && React.createElement(FindBox, { input, ask, asked: find.asked, onChoose: (t: FindTarget) => { find.close(); chosen.push(t); },
      onAsk: (t: string) => { find.close(); handed.push(t); }, onClose: find.close }));
}

let keyListeners: ((e: unknown) => void)[] = [];
const realAdd = document.addEventListener.bind(document);
const realRemove = document.removeEventListener.bind(document);
let unmount: (() => Promise<void>) | null = null;
beforeEach(() => {
  chosen.length = 0; handed.length = 0; ask = "ai"; keyListeners = []; vi.mocked(invoke).mockClear(); listsNow = KEY_HOLDERS;
  document.addEventListener = ((type: string, l: (e: unknown) => void) => { if (type === "keydown") keyListeners.push(l); realAdd(type, l); }) as typeof document.addEventListener;
  document.removeEventListener = ((type: string, l: (e: unknown) => void) => { keyListeners = keyListeners.filter(x => x !== l); realRemove(type, l); }) as typeof document.removeEventListener;
});
afterEach(async () => { await unmount?.(); unmount = null; document.addEventListener = realAdd; document.removeEventListener = realRemove; });

async function mount() {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.root as unknown as Element);
  await act(async () => { root.render(React.createElement(Host)); });
  await act(flush);
  unmount = async () => { await act(async () => { root.unmount(); }); unmount = null; };
  const run = async (f: () => void) => { await act(async () => { f(); }); await act(flush); };
  const type = (text: string) => run(() => props(box()).onChange!({ target: { value: text } }));
  /** A key in the box, going on up to the dialog as a browser sends it, unless something stopped it. */
  const key = (k: string, composing = false) => run(() => {
    let stopped = false;
    const e = { key: k, preventDefault() {}, stopPropagation() { stopped = true; }, nativeEvent: { isComposing: composing } };
    props(box()).onKeyDown!(e);
    if (!stopped) props(byRole("dialog")[0]).onKeyDown?.(e);
  });
  /** Lets the pause before the count is said go by. */
  const said = async () => { await act(async () => { await new Promise<void>(r => setTimeout(r, ANNOUNCE_AFTER_MS + 30)); }); await act(flush); };
  const findRow = () => dom.button(`${FIND.label}⌘K`)!;
  const openFromRow = async () => { const b = findRow(); (b as unknown as { focus(): void }).focus(); await run(() => dom.press(b)); };
  return { run, type, key, findRow, openFromRow, said };
}

describe("opening and closing Find", () => {
  it("the sidebar's Find opens it over an inert page with the keyboard in the box; Escape closes it and gives the keyboard back", async () => {
    const f = await mount();
    expect(f.findRow().getAttribute("aria-keyshortcuts")).toBe("Meta+K");
    expect(byRole("dialog")).toHaveLength(0);
    await f.openFromRow();
    const [dialog] = byRole("dialog");
    expect(dialog!.getAttribute("aria-modal")).toBe("true");
    expect(els().find(n => n.getAttribute("id") === dialog!.getAttribute("aria-labelledby"))!.textContent).toBe(FIND.title);
    expect(dom.focused()).toBe(box());
    expect(box()!.getAttribute("role")).toBe("combobox");
    expect(box()!.getAttribute("placeholder")).toBe(FIND.placeholder);
    // The page under it is inert; the status line isn't, so the count is still heard.
    expect(els().find(n => n.getAttribute("class") === "shell")!.hasAttribute("inert")).toBe(true);
    expect(els().find(n => n.getAttribute("role") === "status")!.hasAttribute("inert")).toBe(false);
    await f.key("Escape");
    expect(byRole("dialog")).toHaveLength(0);
    expect(els().find(n => n.getAttribute("class") === "shell")!.hasAttribute("inert")).toBe(false);
    expect(dom.focused()).toBe(f.findRow());
  });

  it("⌘K opens it from anywhere on the page, and again puts the keyboard back in the box; other keys don't", async () => {
    const f = await mount();
    const press = (e: Record<string, unknown>) => f.run(() => { for (const l of keyListeners) l({ key: "k", metaKey: false, shiftKey: false, altKey: false, ctrlKey: false, preventDefault() {}, ...e }); });
    await press({ metaKey: true, shiftKey: true });
    await press({ ctrlKey: true });
    expect(byRole("dialog")).toHaveLength(0);
    let prevented = false;
    await press({ metaKey: true, preventDefault() { prevented = true; } });
    expect(prevented).toBe(true);
    expect(byRole("dialog")).toHaveLength(1);
    const elsewhere = els().find(n => n.tagName === "H2")!;
    elsewhere.setAttribute("tabindex", "-1");
    (elsewhere as unknown as { focus(): void }).focus();
    await press({ key: "K", metaKey: true });
    expect(dom.focused()).toBe(box());
    expect(isFindKey({ key: "k", metaKey: true, shiftKey: false, altKey: true, ctrlKey: false })).toBe(false);
  });

  it("the menu bar's Find… (its event) opens it", async () => {
    const f = await mount();
    expect(events.handlers.has(FIND_EVENT)).toBe(true);
    await f.run(() => events.handlers.get(FIND_EVENT)!());
    expect(byRole("dialog")).toHaveLength(1);
    expect(dom.focused()).toBe(box());
  });
});

describe("finding", () => {
  it("before anything is typed: what can be found, and a few starting points", async () => {
    const f = await mount();
    await f.openFromRow();
    expect(dom.seen()).toContain(FIND.empty);
    expect(dom.seen()).toContain(FIND.kept);
    expect(byRole("group").map(g => els().find(n => n.getAttribute("id") === g.getAttribute("aria-labelledby"))!.textContent)).toEqual([FIND.starting]);
    expect(options().map(o => o.textContent)).toEqual(["Today", "Services", "Check Planning Center now", "AI help, Settings", "Make text bigger, ⌘+"]);
  });

  it("groups what matches under headings; arrows move the chosen row, Enter goes there; the count is said politely", async () => {
    const f = await mount();
    await f.openFromRow();
    await f.type("greeter");
    const headings = byRole("group").map(g => els().find(n => n.getAttribute("id") === g.getAttribute("aria-labelledby"))!.textContent);
    expect(headings).toEqual(["Things to decide", "People on your plans"]);
    // The people's order is said not to be a ranking.
    expect(dom.seen()).toContain(PEOPLE_ORDER);
    expect(options().map(o => o.textContent)).toEqual([
      "Greeter still needs one more person, Needs a decision", "Avery Brightwater, Greeter", "Ask Ozzie: “greeter”, " + FIND.askAi,
    ]);
    // Said once typing pauses, never on every key.
    expect(status()).not.toContain("2 results.");
    await f.said();
    expect(status()).toContain("2 results.");
    expect(activeOption()!.textContent).toMatch(/^Greeter still needs/u);
    expect(activeOption()!.getAttribute("aria-selected")).toBe("true");
    await f.key("ArrowDown");
    expect(activeOption()!.textContent).toBe("Avery Brightwater, Greeter");
    await f.key("Enter");
    expect(chosen).toEqual([{ to: "card", key: input().services[0]!.brief.findings.find(x => x.kind === "streak")!.key }]);
    expect(handed).toEqual([]);
    expect(byRole("dialog")).toHaveLength(0);
  });

  it("finds pages, Settings' sections and safe actions by plain words, title first", async () => {
    const f = await mount();
    await f.openFromRow();
    await f.type("quiet hours");
    expect(options().map(o => o.textContent)[0]).toBe("What Ozzie runs and notices, Settings");
    await f.key("Enter");
    expect(chosen).toEqual([{ to: "settings", section: "runs-title" }]);
  });

  it("typing keeps and sends nothing: no storage, no native call, no network", async () => {
    const set = vi.fn(), fetchSpy = vi.fn(async () => new Response(""));
    const store = { getItem: () => null, setItem: set, removeItem: set, clear: set, key: () => null, length: 0 };
    const before = { localStorage: globalThis.localStorage, sessionStorage: globalThis.sessionStorage, fetch: globalThis.fetch };
    Object.assign(globalThis, { localStorage: store, sessionStorage: store, fetch: fetchSpy });
    try {
      const f = await mount();
      await f.openFromRow();
      for (const text of ["A", "Av", "Avery Brightwater", "greeter", "zzzz", ""]) await f.type(text);
      await f.key("ArrowDown");
      await f.key("Escape");
    } finally { Object.assign(globalThis, before); }
    expect(set).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(vi.mocked(invoke)).not.toHaveBeenCalled();
    expect(handed).toEqual([]);
    expect(chosen).toEqual([]);
  });
});

describe("the Ask row", () => {
  it("is last and only there with words; it hands over exactly what was typed, and only when chosen", async () => {
    const f = await mount();
    await f.openFromRow();
    expect(options().some(o => o.textContent.startsWith("Ask Ozzie:"))).toBe(false);
    const typed = "  Who could cover Greeter for Avery Brightwater?  ";
    await f.type(typed);
    expect(handed).toEqual([]);
    const last = options().at(-1)!;
    expect(last.textContent).toBe(`Ask Ozzie: “Who could cover Greeter for Avery Brightwater?”, ${FIND.askAi}`);
    // Enter chooses the first result, never the Ask row by itself.
    expect(activeOption()).not.toBe(last);
    await f.key("ArrowUp");
    expect(activeOption()).toBe(last);
    await f.key("Enter");
    expect(handed).toEqual([typed]);
    expect(chosen).toEqual([]);
  });

  it("a click on it hands the words over too", async () => {
    const f = await mount();
    await f.openFromRow();
    await f.type("Who is pending?");
    await f.run(() => props(options().at(-1)).onClick!({}));
    expect(handed).toEqual(["Who is pending?"]);
  });

  it("with nothing found, Enter does nothing: Ask is only ever a row the person moves to", async () => {
    const f = await mount();
    await f.openFromRow();
    await f.type("zzqqxx");
    expect(dom.seen()).toContain(FIND.none("zzqqxx"));
    expect(options().map(o => o.textContent)).toEqual([`Ask Ozzie: “zzqqxx”, ${FIND.askAi}`]);
    expect(activeOption()).toBeNull();
    await f.said();
    expect(status()).toContain("Nothing found. Ask Ozzie is the one row.");
    await f.key("Enter");
    await f.key("Enter");
    expect(handed).toEqual([]);
    expect(chosen).toEqual([]);
    expect(byRole("dialog")).toHaveLength(1);
    // Moving to it and choosing it is the person's own choice.
    await f.key("ArrowDown");
    await f.key("Enter");
    expect(handed).toEqual(["zzqqxx"]);
  });

  it("without AI set up it says so and goes to choosing AI, never to Ask; with no Ask, there is no row", async () => {
    ask = "needs-ai";
    const f = await mount();
    await f.openFromRow();
    await f.type("Who could cover Greeter?");
    expect(options().at(-1)!.textContent).toBe(`Ask Ozzie: “Who could cover Greeter?”, ${FIND.askNeedsAi}`);
    await f.key("ArrowUp");
    await f.key("Enter");
    expect(chosen).toEqual([{ to: "do", action: "ai" }]);
    expect(handed).toEqual([]);
    await unmount!();
    ask = null;
    const g = await mount();
    await g.openFromRow();
    await g.type("Who could cover Greeter?");
    expect(options().some(o => o.textContent.startsWith("Ask Ozzie"))).toBe(false);
  });
});

describe("Find's words", () => {
  it("use none of the words a person shouldn't have to know, and name no score or rank", async () => {
    const FORBIDDEN = /\b(?:skills?|sessions?|agents?|logs?|logged|connectors?|harness)\b/iu;
    const f = await mount();
    await f.openFromRow();
    const seen: string[] = [dom.seen()];
    for (const text of ["a", "greeter", "settings", "check", "zzqq"]) { await f.type(text); seen.push(dom.seen()); }
    const attrs = els().flatMap(n => ["aria-label", "placeholder", "title"].map(a => n.getAttribute?.(a) ?? ""));
    const words = [...seen, ...attrs, ...Object.values(FIND).filter(v => typeof v === "string"), PEOPLE_ORDER].join(" ");
    expect(words).not.toMatch(FORBIDDEN);
    expect(words).not.toMatch(/\b(?:score|at risk|drifting|best match|top)\b/iu);
  });
});

describe("after Find went to a page", () => {
  function Pane({ focus }: { focus: FoundFocus | null }) {
    const pane = React.useRef<HTMLElement>(null);
    const found = useFoundFocus(pane);
    React.useEffect(() => { if (focus) found(focus); }, [focus]);
    return React.createElement("main", { ref: pane },
      React.createElement("div", { hidden: true }, React.createElement("section", { id: "rooms-rules" }, React.createElement("h2", null, "Hidden"))),
      React.createElement("h1", null, "Services"),
      React.createElement("section", { id: "rooms-rules" }, React.createElement("p", null, "Before"), React.createElement("h2", null, "Rooms")),
      React.createElement("h2", { id: "kids-rules-title" }, "Kids teams"));
  }
  it("the keyboard goes to the page's title, a heading by id, or a section's heading by the section's id, never one hidden", async () => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(dom.root as unknown as Element);
    const at = async (focus: FoundFocus) => { await act(async () => { root.render(React.createElement(Pane, { focus })); }); await act(flush); return dom.focused() as unknown as El; };
    expect((await at({ title: true })).textContent).toBe("Services");
    const rooms = await at({ id: "rooms-rules" });
    expect(rooms.tagName).toBe("H2");
    expect(rooms.textContent).toBe("Rooms");
    expect(rooms.getAttribute("tabindex")).toBe("-1");
    const kids = await at({ id: "kids-rules-title" });
    expect(kids.textContent).toBe("Kids teams");
    await act(async () => { root.unmount(); });
  });
});

describe("Ask takes the words Find hands it", () => {
  it("asks them once, exactly as typed, through its own steps; while a question runs they wait in the box instead", async () => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { AskPanel } = await import("../src/ask-panel.js");
    const voice = { status: async () => ({ status: "not-available" as const }), listen: async () => ({ status: "stopped" as const }), stop: async () => {}, cancel: async () => {} };
    const brief = buildSundayBrief(capture, rules, capture.completed_at, true);
    const asked: string[] = [];
    let taken = 0;
    const askFn = (typed: string) => { asked.push(typed); return new Promise<never>(() => {}); };
    const root = createRoot(dom.root as unknown as Element);
    const show = async (handed: { id: number; text: string } | null) => {
      await act(async () => { root.render(React.createElement(AskPanel, { open: true, onClose: () => {}, ask: askFn, brief, modelReady: true, onOpen: () => {}, voice,
        handed, onHanded: () => { taken++; } })); });
      await act(flush);
    };
    try {
      await show(null);
      expect(asked).toEqual([]);
      await show({ id: 1, text: "  Who could cover Greeter?  " });
      expect(asked).toEqual(["  Who could cover Greeter?  "]);
      expect(taken).toBe(1);
      // The same words again (a render, not a new choice): not asked twice.
      await show({ id: 1, text: "  Who could cover Greeter?  " });
      expect(asked).toHaveLength(1);
      // Chosen again while the first question still runs: they wait in the box for the person to send.
      await show({ id: 2, text: "Who is pending?" });
      expect(asked).toHaveLength(1);
      expect(taken).toBe(2);
      expect(els().find(n => n.tagName === "TEXTAREA") as unknown as { value: string }).toMatchObject({ value: "Who is pending?" });
    } finally { await act(async () => { root.unmount(); }); }
  });
});

describe("a church's own list in Find", () => {
  it("is found by its name and the people's names in it, goes to the list by its id alone, and hands nothing of it to Ask, storage, native code or the network", async () => {
    const set = vi.fn(), fetchSpy = vi.fn(async () => new Response(""));
    const store = { getItem: () => null, setItem: set, removeItem: set, clear: set, key: () => null, length: 0 };
    const before = { localStorage: globalThis.localStorage, sessionStorage: globalThis.sessionStorage, fetch: globalThis.fetch };
    Object.assign(globalThis, { localStorage: store, sessionStorage: store, fetch: fetchSpy });
    try {
      const f = await mount();
      await f.openFromRow();
      await f.type("quill");
      const lists = byRole("group").find(g => els().find(n => n.getAttribute("id") === g.getAttribute("aria-labelledby"))!.textContent === "Church lists")!;
      expect(all(lists).filter(n => n.getAttribute?.("role") === "option").map(o => o.textContent)).toEqual(["Jordan Quillfeather, In Key holders"]);
      // The Ask row hands over what was typed, never the name it found.
      await f.key("ArrowUp");
      await f.key("Enter");
      expect(handed).toEqual(["quill"]);
      await f.openFromRow();
      await f.type("quill");
      await f.key("Enter");
      expect(chosen).toEqual([{ to: "list", id: "list-1" }]);
      await f.openFromRow();
      await f.type("key holders");
      await f.key("Enter");
      expect(chosen.at(-1)).toEqual({ to: "list", id: "list-1" });
    } finally { Object.assign(globalThis, before); }
    expect(JSON.stringify([chosen, handed])).not.toMatch(/Quillfeather|Key holders/u);
    expect(set).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(vi.mocked(invoke)).not.toHaveBeenCalled();
  });
});

describe("review of release-find", () => {
  it("M1: words naming someone only in the church's lists get no Ask row, and Find says why; a name on the plans still can", async () => {
    const f = await mount();
    await f.openFromRow();
    await f.type("Is Pat Example free Sunday?");
    expect(options().some(o => o.textContent.startsWith("Ask Ozzie"))).toBe(false);
    expect(dom.seen()).toContain(FIND.notSent);
    await f.key("ArrowUp");
    await f.key("Enter");
    await f.said();
    expect(handed).toEqual([]);
    // The status line says why there is no Ask row, after the count.
    expect(status().join(" ")).toContain(`Nothing found. ${FIND.notSent}`);
    // Avery is on the plan: Ask puts a label in place of that name, so the row is offered.
    await f.type("Is Avery Brightwater free Sunday?");
    expect(options().at(-1)!.textContent).toBe(`Ask Ozzie: “Is Avery Brightwater free Sunday?”, ${FIND.askAi}`);
    // No notice in the box (the status line keeps saying what it last said until it has something new).
    expect(els().some(n => (n.getAttribute?.("class") ?? "").includes("find-not-sent"))).toBe(false);
    expect(FIND.askAi).toContain("the names on your plans");
  });

  it("M3: Escape closes Find from anywhere in it and goes no further, but not while a word is being composed", async () => {
    const f = await mount();
    await f.openFromRow();
    await f.key("Escape", true);
    expect(byRole("dialog")).toHaveLength(1);
    // From the Close button: the dialog hears it and stops it there.
    let stopped = false;
    await f.run(() => props(byRole("dialog")[0]).onKeyDown!({ key: "Escape", target: dom.button(FIND.close), preventDefault() {}, stopPropagation() { stopped = true; },
      nativeEvent: { isComposing: false } }));
    expect(stopped).toBe(true);
    expect(byRole("dialog")).toHaveLength(0);
  });

  it("M3: ⌘K and the menu's Find… don't open Find while another question is over the page", async () => {
    function Sheet() {
      const sheet = React.useRef<HTMLDivElement>(null), first = React.useRef<HTMLButtonElement>(null);
      useModal(sheet, first);
      return React.createElement("div", { role: "dialog", "aria-modal": "true", ref: sheet }, React.createElement("button", { type: "button", ref: first }, "Keep"));
    }
    const f = await mount();
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const host = dom.root.appendChild(document.createElement("div") as unknown as typeof dom.root);
    const sheetRoot = createRoot(host as unknown as Element);
    await act(async () => { sheetRoot.render(React.createElement(Sheet)); });
    try {
      await f.run(() => { for (const l of keyListeners) l({ key: "k", metaKey: true, shiftKey: false, altKey: false, ctrlKey: false, preventDefault() {} }); });
      await f.run(() => events.handlers.get(FIND_EVENT)!());
      expect(byRole("dialog").filter(d => d.getAttribute("class") === "find-dialog")).toHaveLength(0);
    } finally { await act(async () => { sheetRoot.unmount(); }); dom.root.removeChild(host); }
    await f.run(() => events.handlers.get(FIND_EVENT)!());
    expect(byRole("dialog").filter(d => d.getAttribute("class") === "find-dialog")).toHaveLength(1);
  });

  it("Low: a group shows at most GROUP_ROWS rows until the person asks for all, even with 5,000 to choose from", async () => {
    listsNow = [{ id: "big", label: "Everyone", people: Array.from({ length: 5000 }, (_, i) => `Volunteer Person${String.fromCharCode(97 + (i % 26))}${i}`) }];
    const f = await mount();
    await f.openFromRow();
    await f.type("volunteer");
    const group = byRole("group").find(g => els().find(n => n.getAttribute("id") === g.getAttribute("aria-labelledby"))!.textContent === "Church lists")!;
    const shown = all(group).filter(n => n.getAttribute?.("role") === "option");
    expect(shown.length).toBe(GROUP_ROWS + 1);
    expect(shown[GROUP_ROWS]!.textContent).toBe(FIND.more(5000, "Church lists"));
    // Fewer than a hundred rows are drawn in all (the Services page is found too, by its word "volunteers").
    expect(options().length).toBeLessThan(100);
    await f.said();
    // Every name in this list has the word "Volunteer", so the Ask row isn't offered, and the status line says why.
    expect(status().join(" ")).toContain(`5001 results. ${FIND.notSent}`);
    await unmount!();
    listsNow = [{ id: "mid", label: "Ushers", people: Array.from({ length: 30 }, (_, i) => `Usher Person${String.fromCharCode(97 + i % 26)}`) }];
    const g = await mount();
    await g.openFromRow();
    await g.type("usher");
    for (let i = 0; i < GROUP_ROWS; i++) await g.key("ArrowDown");
    // The list's own name ("Ushers") and its 30 people.
    expect(activeOption()!.textContent).toBe(FIND.more(31, "Church lists"));
    await g.key("Enter");
    expect(options().filter(o => o.textContent.startsWith("Usher Person"))).toHaveLength(30);
    expect(byRole("dialog")).toHaveLength(1);
  });

  it("Low: the words before anything is typed name Church lists, and the starting rows are headed Go to", async () => {
    const f = await mount();
    await f.openFromRow();
    expect(dom.seen()).toContain("Find Ozzie's pages and settings, your Church rules and lists, what needs a decision, and the people on your plans.");
    expect(dom.seen()).toContain("Go to");
    expect(dom.seen()).not.toContain("Starting points");
  });
});

describe("second review of release-find", () => {
  it("Low: the notice says the words might name someone, and the status line says it too, once", async () => {
    const f = await mount();
    await f.openFromRow();
    await f.type("Is Pat's shift covered?");
    expect(FIND.notSent).toBe("Not sent to Ask: it might name someone from your Church lists, and Ask can't replace that name with a label.");
    expect(dom.seen()).toContain(FIND.notSent);
    expect(options().some(o => o.textContent.startsWith("Ask Ozzie"))).toBe(false);
    await f.said();
    expect(status().join(" ")).toContain(FIND.notSent);
  });

  it("Low: a question left open on a page that isn't shown doesn't keep Find from opening", async () => {
    function Sheet() {
      const sheet = React.useRef<HTMLDivElement>(null), first = React.useRef<HTMLButtonElement>(null);
      useModal(sheet, first);
      return React.createElement("div", { role: "dialog", "aria-modal": "true", ref: sheet }, React.createElement("button", { type: "button", ref: first }, "Keep"));
    }
    const f = await mount();
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const host = dom.root.appendChild(document.createElement("div") as unknown as typeof dom.root);
    const sheetRoot = createRoot(host as unknown as Element);
    // As Visitor cards keeps its page, hidden, while another page is shown.
    await act(async () => { sheetRoot.render(React.createElement("div", { hidden: true }, React.createElement(Sheet))); });
    try {
      await f.run(() => events.handlers.get(FIND_EVENT)!());
      expect(byRole("dialog").filter(d => d.getAttribute("class") === "find-dialog")).toHaveLength(1);
    } finally { await act(async () => { sheetRoot.unmount(); }); dom.root.removeChild(host); }
  });
});
