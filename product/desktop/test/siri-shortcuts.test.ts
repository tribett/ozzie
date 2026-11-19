// "Let Siri and Shortcuts ask Ozzie" (ADR 0006): off by default; while on, only the Sunday overview of this church's
// current check goes to the native check, otherwise the copy is removed; a page from an ozzie:// link is one of two
// fixed pages; and Settings says plainly what Siri and Shortcuts can and can't hear and how to make the shortcuts.
// Fictional data and paths only.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
import { ConnectionPage, SavedRecordings } from "../src/connection-page.js";
import { OPENABLE_PAGES, SHORTCUTS_START_PROBLEM, SHORTCUTS_STOP_PROBLEM, ShortcutsControl, syncShortcuts, takeOpenedPage, type ShortcutsView } from "../src/siri-shortcuts.js";
import { readFileSync } from "node:fs";
import { ACTION_NAMES, ACTION_PHRASES, ACTIONS_IN_SHORTCUTS, ACTIONS_SIRI, ACTIONS_NOT_FOUND, ACTIONS_READY, ASK_NAME, ASK_STEPS, askCommand, BY_HAND, OPEN_LINK, OPEN_NAME, OPEN_STEPS, SCRIPTS_SETTING, SHORTCUTS_MISSING, SHORTCUTS_MOVE, SIRI_BODY, SIRI_HOW, SIRI_NEVER, SIRI_SEES, SiriShortcutsSection } from "../src/siri-shortcuts-section.js";
import type { ShareContext } from "../src/share-check.js";
import type { ConnectionStatus } from "../src/connection.js";
import { HarnessSession } from "../../../core/src/harness/session.js";
import { namedIn } from "../../../core/src/harness/names.js";
import { parseSharedCheck, sharedCheckText } from "../../../core/mcp/snapshot.js";
import { shortcutsAnswer } from "../../../core/mcp/shortcuts.js";
import { FRESH, harnessData } from "../../../core/test/harness/fixtures.js";
import type { ToolEnvelope } from "../../../core/src/harness/contract.js";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replaceAll("&#x27;", "'").replaceAll("&quot;", "\"").replaceAll("&gt;", ">").replace(/\s+/g, " ");
const ORG = "1001";
const connected = (organization = ORG) => ({ state: "connected", organization, checked_at_ms: 1, source: "", problem: null }) as ConnectionStatus;
const here: ShareContext = { organization: ORG, status: connected() };
const commands = (invoke: { mock: { calls: unknown[][] } }) => invoke.mock.calls.map(c => c[0] as string);
const HELPER = "/Applications/Ozzie.app/Contents/MacOS/ozzie-shortcuts";

describe("turning it on and off", () => {
  it("is off unless native says it's on, and off when native can't say", async () => {
    for (const [answer, on] of [[false, false], [true, true], [new Error("unavailable"), false]] as const) {
      const control = new ShortcutsControl((async () => { if (answer instanceof Error) throw answer; return answer; }) as never, () => {});
      expect(control.view).toEqual({ on: false, problem: null });
      await control.load();
      expect(control.view).toEqual({ on, problem: null });
    }
  });

  it("asks native to turn it on and off, and says plainly when it couldn't", async () => {
    const invoke = vi.fn(async (command: string) => { if (command === "stop_shortcuts") throw "unavailable"; });
    const shown: ShortcutsView[] = [];
    const control = new ShortcutsControl(invoke as never, v => shown.push(v));
    await control.change(true);
    expect(control.view).toEqual({ on: true, problem: null });
    await control.change(false);
    expect(control.view).toEqual({ on: true, problem: SHORTCUTS_STOP_PROBLEM });
    expect(commands(invoke)).toEqual(["start_shortcuts", "stop_shortcuts"]);
    const refusing = new ShortcutsControl((async () => { throw "unavailable"; }) as never, () => {});
    await refusing.change(true);
    expect(refusing.view).toEqual({ on: false, problem: SHORTCUTS_START_PROBLEM });
  });
});

describe("keeping the copy", () => {
  it("hands native only the Sunday overview of this church's check, which answers in counts and times", async () => {
    const invoke = vi.fn<(command: string, args?: unknown) => Promise<undefined>>(async () => undefined);
    const data = harnessData({ mode: "live", now: FRESH, connected: true });
    const live = { ...data, capture: { ...data.capture!, organization: ORG } };
    expect(await syncShortcuts(live, new HarnessSession(), here, invoke as never)).toBe(true);
    expect(commands(invoke)).toEqual(["save_shortcuts_check"]);
    const { envelopes, copyId } = invoke.mock.calls[0]![1] as { envelopes: string[]; copyId: string };
    expect(envelopes.map(e => (JSON.parse(e) as ToolEnvelope).tool)).toEqual(["sunday.overview"]);
    // As native writes it, it reads back and answers without a single name.
    const copy = sharedCheckText(envelopes.map(e => JSON.parse(e) as ToolEnvelope), [], FRESH, copyId);
    expect(parseSharedCheck(copy)).not.toBeNull();
    const answer = shortcutsAnswer("sunday", { on: true, text: copy, nowMs: Date.parse(FRESH), timeZone: "America/New_York" });
    expect(answer).toMatch(/^Sunday, November 22 has 2 open spots across 2 roles\./u);
    expect(namedIn(answer, live.capture.names, "strict")).toBe(false);
  });

  it("removes the copy when the check isn't this church's, is gone, or native refuses it", async () => {
    const data = harnessData({ mode: "live", now: FRESH });
    const cases: [ReturnType<typeof harnessData>, ShareContext][] = [
      [{ ...data, capture: { ...data.capture!, organization: "2002" } }, here],
      [{ ...data, capture: null }, here],
      [{ ...data, capture: { ...data.capture!, organization: ORG } }, { organization: ORG, status: { ...connected(), state: "disconnected" } }],
    ];
    for (const [d, context] of cases) {
      const invoke = vi.fn(async () => undefined);
      expect(await syncShortcuts(d, new HarnessSession(), context, invoke as never)).toBe(false);
      expect(commands(invoke)).toEqual(["clear_shortcuts_check"]);
    }
    const refusing = vi.fn(async (command: string) => { if (command === "save_shortcuts_check") throw "invalid"; });
    expect(await syncShortcuts({ ...data, capture: { ...data.capture!, organization: ORG } }, new HarnessSession(), here, refusing as never)).toBe(false);
    expect(commands(refusing)).toEqual(["save_shortcuts_check", "clear_shortcuts_check"]);
    // A check whose saved recordings were deleted is no longer kept.
    const forgotten = { ...data, capture: { ...data.capture!, organization: ORG } };
    const invoke = vi.fn(async () => undefined);
    expect(await syncShortcuts(forgotten, new HarnessSession(), { ...here, forgotten: forgotten.capture }, invoke as never)).toBe(false);
    expect(commands(invoke)).toEqual(["clear_shortcuts_check"]);
  });
});

describe("pages opened by a link", () => {
  it("are only Today and Sunday", () => {
    expect(OPENABLE_PAGES).toEqual(["today", "sunday"]);
  });

  it("are taken from native once and opened only when guided setup isn't showing (review K L6)", async () => {
    for (const [page, ready, opened] of [["sunday", true, ["sunday"]], ["today", true, ["today"]], ["sunday", false, []],
      ["settings", true, []], [null, true, []], [42, true, []]] as const) {
      const shown: string[] = [];
      const invoke = vi.fn(async () => page);
      await takeOpenedPage(invoke as never, () => ready, p => shown.push(p));
      // The page is always taken, so a link ignored during setup isn't opened later.
      expect(commands(invoke)).toEqual(["take_opened_page"]);
      expect(shown).toEqual(opened);
    }
    const failing = vi.fn(async () => { throw "unavailable"; });
    const shown: string[] = [];
    await takeOpenedPage(failing as never, () => true, p => shown.push(p));
    expect(shown).toEqual([]);
  });
});

describe("Settings", () => {
  /** `actions`: whether this Ozzie carries its Siri actions (ADR 0007); off unless a test says so. */
  const render = (on: boolean, path?: string | null, actions = false) =>
    renderToStaticMarkup(React.createElement(SiriShortcutsSection, { on, onChange: () => {}, problem: null, actions, ...(path !== undefined ? { path } : {}) }));
  const prose = (html: string) => text(html.replace(/<pre[^]*?<\/pre>/gu, " "));

  it("has the switch off with what Siri and Shortcuts can and can't hear, and no steps until it's on", () => {
    const html = render(false, HELPER);
    expect(html).toContain("Let Siri and Shortcuts ask Ozzie");
    expect(html).not.toContain("checked=\"\"");
    const words = prose(html);
    for (const line of [SIRI_BODY, SIRI_SEES, SIRI_NEVER, ...SIRI_HOW]) expect(words).toContain(line);
    expect(words).toContain("Off unless you turn it on.");
    expect(words).not.toContain("Make the shortcuts");
  });

  it("shows the steps for both shortcuts with this Ozzie's command and the link while it's on", () => {
    const html = render(true, HELPER);
    expect(html).toContain("checked=\"\"");
    expect(html).toContain(`<code>${askCommand(HELPER).replaceAll("'", "&#x27;")}</code>`);
    expect(html).toContain(`<code>${OPEN_LINK}</code>`);
    const words = prose(html);
    for (const step of [...ASK_STEPS, ...OPEN_STEPS]) expect(words).toContain(step);
    expect(words).toContain(`"${ASK_NAME}" answers`);
    expect(words).toContain(`"${OPEN_NAME}" opens`);
    expect(words).toContain("Allow Running Scripts");
  });

  it("says plainly that Allow Running Scripts is for all of Shortcuts, what that allows, and how to undo it (review K M3)", () => {
    expect(ASK_STEPS[0]).toContain("Allow Running Scripts");
    for (const words of ["for all of Shortcuts on this Mac", "any shortcut you have or add later can run commands as you", "not only Ozzie's",
      "only add shortcuts you trust", "turn it off again in the same place", "stops answering"]) expect(SCRIPTS_SETTING).toContain(words);
    const words = prose(render(true, HELPER));
    expect(words).toContain(SCRIPTS_SETTING);
    // Said before the step that asks for it.
    expect(words.indexOf(SCRIPTS_SETTING)).toBeLessThan(words.indexOf(ASK_STEPS[0]));
    expect(words).toContain("This one doesn't need Allow Running Scripts.");
  });

  it("lists everything an answer can say (review K L3)", () => {
    for (const words of ["open spots", "roles", "how many people are pending", "with and without a request sent", "teams without a confirmed lead",
      "kids teams with fewer confirmed people than your Church rules ask", "room booking overlaps and overdue follow-ups with no owner need a decision", "Worth a look", "how many you marked as handled",
      "couldn't be read", "too long to say in full", "some findings are shown only in Ozzie", "when it was checked"]) {
      expect(SIRI_SEES).toContain(words);
    }
  });

  it("says so when this Ozzie has no helper, or runs from a temporary copy", () => {
    expect(prose(render(true, null))).toContain(SHORTCUTS_MISSING);
    expect(prose(render(true, "/private/var/folders/x/T/AppTranslocation/1/d/Ozzie.app/Contents/MacOS/ozzie-shortcuts"))).toContain(SHORTCUTS_MOVE);
    // From a temporary copy, Siri couldn't rely on finding the actions either: only the move is asked for.
    const moved = prose(render(true, "/private/var/folders/x/T/AppTranslocation/1/d/Ozzie.app/Contents/MacOS/ozzie-shortcuts", true));
    expect(moved).toContain(SHORTCUTS_MOVE);
    expect(moved).not.toContain(ACTIONS_READY);
  });

  it("offers Ozzie's own Siri actions first when this Ozzie carries them, and the shortcuts by hand only as the fallback (ADR 0007)", () => {
    const html = render(true, HELPER, true);
    const words = prose(html);
    expect(words).toContain("Ask from Spotlight or Shortcuts");
    for (const line of [ACTIONS_READY, ACTIONS_IN_SHORTCUTS, ACTIONS_SIRI, ACTIONS_NOT_FOUND, BY_HAND, ...ACTION_NAMES]) expect(words).toContain(line);
    // Siri isn't promised: the newest Siri ran neither Ozzie's actions nor another app's (live, 2026-11-16).
    expect(ACTIONS_READY).not.toMatch(/Siri/u);
    expect(ACTIONS_SIRI).toContain(`"${ACTION_PHRASES[0]}"`);
    // Review J M1, L1: nobody is told to try Siri (it answered that phrase by itself, without Ozzie's check), nothing
    // forecasts what Siri will do, and Shortcuts is said to list the actions, which is what was seen.
    expect(ACTIONS_SIRI).toMatch(/didn't run Ozzie's actions when this was checked/u);
    expect(ACTIONS_SIRI).toMatch(/may answer by itself, without Ozzie's check\. Use Spotlight instead\.$/u);
    expect(ACTIONS_SIRI).not.toMatch(/you can try|\byet\b|Shortcuts do/u);
    expect(SIRI_BODY).not.toMatch(/Siri|Shortcuts app/u);
    expect(SIRI_HOW.join(" ")).not.toMatch(/When Siri/u);
    // The app never speaks as "we" (review L L7).
    expect(ACTIONS_SIRI).not.toMatch(/\bwe\b/iu);
    expect(ACTIONS_IN_SHORTCUTS).toMatch(/^They are also listed in the Shortcuts app/u);
    for (const step of [...ASK_STEPS, ...OPEN_STEPS]) expect(step).not.toMatch(/Ask Siri/u);
    expect(words.indexOf(ACTIONS_READY)).toBeLessThan(words.indexOf(SCRIPTS_SETTING));
    // The steps by hand, Allow Running Scripts with them, are folded away under the fallback.
    // Folded like every other fold, its chevron first (polish pass, 2026-11-18).
    const fallback = html.search(new RegExp(`<details class="listen-more"><summary><svg class="ic ic-sm" [^>]*><path d="m9 6 6 6-6 6"></path></svg>${BY_HAND}</summary>`, "u"));
    expect(fallback).toBeGreaterThan(-1);
    for (const later of ["Before you start:", `<code>${OPEN_LINK}</code>`, "Allow Running Scripts"]) expect(html.indexOf(later)).toBeGreaterThan(fallback);
    for (const step of [...ASK_STEPS, ...OPEN_STEPS]) expect(words).toContain(step);
    // Without them (a development build), the steps by hand are the way, as before.
    expect(prose(render(true, HELPER, false))).not.toContain(ACTIONS_READY);
  });

  it("names the Siri actions as Ozzie's actions and phrases do (helpers/siri-actions.swift)", () => {
    const actions = readFileSync(new URL("../src-tauri/helpers/siri-actions.swift", import.meta.url), "utf8");
    for (const phrase of ACTION_PHRASES) expect(actions).toContain(`"${phrase.replace(/\?$/u, "").replace("Ozzie", "\\(.applicationName)")}"`);
    expect([...ACTION_NAMES]).toEqual(["Is Sunday covered", "Open Ozzie's Sunday page", "Open Ozzie's Today page"]);
    for (const title of ACTION_NAMES) {
      expect(ACTIONS_IN_SHORTCUTS).toContain(title);
      expect(actions).toContain(`static let title: LocalizedStringResource = "${title}"`);
    }
    expect(SIRI_HOW.join(" ")).toContain("Ozzie's own actions don't need it.");
  });

  it("quotes the command so any folder name is one argument to the shell", () => {
    expect(askCommand(HELPER)).toBe(`'${HELPER}' sunday`);
    expect(askCommand("/Applications/Bob's $HOME `x` \"Tools\"/ozzie-shortcuts")).toBe("'/Applications/Bob'\\''s $HOME `x` \"Tools\"/ozzie-shortcuts' sunday");
  });

  it("uses plain words: none of the words kept off Ozzie's screens", () => {
    const all = prose(render(true, HELPER)) + prose(render(true, HELPER, true))
      + text(renderToStaticMarkup(React.createElement(SavedRecordings, { count: 2, onDelete: () => {}, sharing: false, siri: true, confirming: true })));
    expect(all).toContain("The copy Siri and Shortcuts answer from is removed too.");
    for (const banned of [/\bskills?\b/iu, /\bsessions?\b/iu, /\bagents?\b/iu, /\blogs?\b/iu, /\bconnectors?\b/iu, /\bharness\b/iu, /\bMCP\b/u]) {
      expect(all).not.toMatch(banned);
    }
  });

  it("appears in Settings only when the app passes the switch", () => {
    const props = { status: null, settings: { clientId: "", organization: "", serviceTypeId: "", planId: "" }, onSettings: () => {}, onStatus: () => {}, oneClick: false };
    expect(renderToStaticMarkup(React.createElement(ConnectionPage, props))).not.toContain("Siri and Shortcuts");
    expect(renderToStaticMarkup(React.createElement(ConnectionPage, { ...props, siri: { on: false, onChange: () => {}, problem: null } }))).toContain("Let Siri and Shortcuts ask Ozzie");
  });
});
