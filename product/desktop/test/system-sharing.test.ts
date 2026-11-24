// A church on B1 Church or Breeze in "Use Ozzie's last check in other AI apps" and "Let Siri and Shortcuts ask Ozzie"
// (0.10.0): the same switches and the same native checks as Planning Center's, its own check shared only while it is
// the church connected and ready, native told its system and whether it numbered every role, a check never shared as
// another system's, Planning Center's calls exactly as before, Genesis's fixed line, and Settings in each system's
// words. Fictional captures and a fake native side only; nothing is written unless native's switch is on.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
import { ConnectionPage, NO_SCHEDULES_TO_SHARE, SHARE_HOW } from "../src/connection-page.js";
import { SystemWordsContext, systemWords, type MainSystem } from "../src/church-system.js";
import { roleNumbersOf, shareable, syncShared, type ShareContext, type SystemShare } from "../src/share-check.js";
import { syncShortcuts } from "../src/siri-shortcuts.js";
import { SIRI_HOW, SIRI_NEVER } from "../src/siri-shortcuts-section.js";
import { SETUP_NEVER } from "../src/other-ai-apps-setup.js";
import type { ConnectionStatus } from "../src/connection.js";
import type { ToolEnvelope } from "../../../core/src/harness/contract.js";
import { namedIn } from "../../../core/src/harness/names.js";
import { HarnessSession } from "../../../core/src/harness/session.js";
import type { HarnessData } from "../../../core/src/harness/tools.js";
import { buildSystemBrief } from "../../../core/src/church-systems/brief.js";
import { fictionalB1 } from "../../../core/src/church-systems/fictional.js";
import { systemHarnessCapture } from "../../../core/src/church-systems/harness.js";
import { placeholderScope } from "../../../core/src/church-systems/placeholders.js";
import { SYSTEMS, type SystemCapture } from "../../../core/src/church-systems/types.js";
import { parseSharedCheck, sharedCheckText } from "../../../core/mcp/snapshot.js";
import { shortcutsAnswer } from "../../../core/mcp/shortcuts.js";
import { harnessData } from "../../../core/test/harness/fixtures.js";
import { b1Capture, breezeUntimedCapture, NOW } from "../../../core/test/church-systems/fixtures.js";

const RULES = { sundayLeads: [], checkInAfterSundaysInARow: 3 };
/** The church's check as App.tsx builds Ask's data for it (`harnessData`). */
function dataFor(capture: SystemCapture, fictional = false): HarnessData {
  const built = buildSystemBrief(capture, { confirmedZone: capture.church.time_zone }, NOW, { fictional });
  if (!built.ok) throw new Error(built.reason);
  return { capture: systemHarnessCapture(capture, false), brief: built.brief, operations: null, decisions: [], rules: RULES, attention: null,
    granted: ["services"], mode: fictional ? "fictional" : "live", connected: false, source: SYSTEMS[capture.system].name };
}
/** As App.tsx makes it for the church connected: ready unless said otherwise. */
const contextFor = (capture: SystemCapture, over: Partial<SystemShare> = {}, organization = placeholderScope(capture)): ShareContext =>
  ({ organization, status: null, system: { id: capture.system as SystemShare["id"], role_numbers: roleNumbersOf(capture.positions), ready: true, ...over } });
const commands = (invoke: { mock: { calls: unknown[][] } }) => invoke.mock.calls.map(c => c[0] as string);
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replaceAll("&#x27;", "'").replaceAll("&quot;", "\"").replace(/\s+/g, " ");

describe("whether a role's numbers were shared", () => {
  it("all, some or none; never none for a service with no roles read (privacy review L2)", () => {
    expect(roleNumbersOf([{ needed: 2 }, { needed: 1 }])).toBe("all");
    expect(roleNumbersOf([{ needed: 2 }, { needed: null }])).toBe("some");
    expect(roleNumbersOf([{ needed: null }, { needed: null }])).toBe("none");
    expect(roleNumbersOf([])).toBe("all");
  });
});

describe.each([["b1", b1Capture], ["breeze", breezeUntimedCapture]] as const)("%s: sharing the church's own check", (system, capture) => {
  it("hands native its results, its system and whether it numbered every role, and the copy reads back with no name", async () => {
    const c = capture();
    const data = dataFor(c);
    const context = contextFor(c);
    expect(shareable(data, context)).toBe(true);
    const invoke = vi.fn<(command: string, args?: unknown) => Promise<undefined>>(async () => undefined);
    expect(await syncShared(data, new HarnessSession(), context, invoke as never)).toBe(true);
    const [command, args] = invoke.mock.calls[0] as [string, { envelopes: string[]; copyId: string; system: unknown }];
    expect(command).toBe("share_last_check");
    expect(Object.keys(args)).toEqual(["envelopes", "copyId", "system"]);
    expect(args.system).toEqual({ id: system, role_numbers: system === "b1" ? "all" : "none" });
    const envelopes = args.envelopes.map(e => JSON.parse(e) as ToolEnvelope);
    for (const e of envelopes) expect([SYSTEMS[system].name, "Church rules on this Mac"]).toContain(e.source);
    const all = args.envelopes.join("\n");
    expect(namedIn(all, c.names, "strict")).toBe(false);
    for (const label of Object.values(c.labels)) expect(all.includes(label), label).toBe(false);
    expect(parseSharedCheck(sharedCheckText(envelopes, [], NOW, args.copyId, args.system as never))).not.toBeNull();

    // Siri and Shortcuts: the overview only, with the same system part.
    const siri = vi.fn<(command: string, args?: unknown) => Promise<undefined>>(async () => undefined);
    expect(await syncShortcuts(data, new HarnessSession(), context, siri as never)).toBe(true);
    const [saved, kept] = siri.mock.calls[0] as [string, { envelopes: string[]; copyId: string; system: unknown }];
    expect(saved).toBe("save_shortcuts_check");
    expect(kept.envelopes.map(e => (JSON.parse(e) as ToolEnvelope).tool)).toEqual(["sunday.overview"]);
    expect(kept.system).toEqual(args.system);
    const copy = sharedCheckText(kept.envelopes.map(e => JSON.parse(e) as ToolEnvelope), [], NOW, kept.copyId, kept.system as never);
    const answer = shortcutsAnswer("sunday", { on: true, text: copy, nowMs: Date.parse(NOW), timeZone: "America/Chicago" });
    expect(answer).toContain(`Checked in ${SYSTEMS[system].name} today at`);
    expect(namedIn(answer, c.names, "strict")).toBe(false);
  });

  const cases: [string, (c: SystemCapture) => [HarnessData, ShareContext]][] = [
    ["not ready (not connected, or B1 Church's time zone not confirmed yet)", c => [dataFor(c), contextFor(c, { ready: false })]],
    ["another church on the same system", c => [dataFor(c), contextFor(c, {}, `${c.system}:another-church`)]],
    ["no church connected", c => [dataFor(c), contextFor(c, {}, "")]],
    ["its check as Planning Center's", c => [dataFor(c), { organization: placeholderScope(c), status: { state: "connected", organization: placeholderScope(c) } as ConnectionStatus }]],
    ["its check as the other system's", c => [dataFor(c), { ...contextFor(c), system: { id: c.system === "b1" ? "breeze" : "b1", role_numbers: "all", ready: true } }]],
    ["Planning Center's check as its own", c => [harnessData({ mode: "live" }), contextFor(c, {}, "1001")]],
    ["no check yet", c => [{ ...dataFor(c), capture: null }, contextFor(c)]],
    ["a check whose saved copies were deleted", c => { const d = dataFor(c); return [d, { ...contextFor(c), forgotten: d.capture }]; }],
  ];
  it.each(cases)("removes both copies, sharing nothing, with %s", async (_label, make) => {
    const [data, context] = make(capture());
    expect(shareable(data, context)).toBe(false);
    const invoke = vi.fn(async () => undefined);
    expect(await syncShared(data, new HarnessSession(), context, invoke as never)).toBe(false);
    expect(await syncShortcuts(data, new HarnessSession(), context, invoke as never)).toBe(false);
    expect(commands(invoke)).toEqual(["clear_shared_check", "clear_shortcuts_check"]);
  });

  it("a share native refuses (sharing off, a name it has seen) leaves no copy behind", async () => {
    const c = capture();
    const invoke = vi.fn(async (command: string) => { if (command === "share_last_check" || command === "save_shortcuts_check") throw "off"; });
    expect(await syncShared(dataFor(c), new HarnessSession(), contextFor(c), invoke as never)).toBe(false);
    expect(await syncShortcuts(dataFor(c), new HarnessSession(), contextFor(c), invoke as never)).toBe(false);
    expect(commands(invoke)).toEqual(["share_last_check", "clear_shared_check", "save_shortcuts_check", "clear_shortcuts_check"]);
  });
});

describe("the system's example, Planning Center and Genesis", () => {
  it("shares the system's own example whatever church is set, since it holds no church's data", async () => {
    const example = fictionalB1();
    const invoke = vi.fn(async () => undefined);
    expect(await syncShared(dataFor(example, true), new HarnessSession(), contextFor(example, { ready: false }, ""), invoke as never)).toBe(true);
  });

  it("calls native for Planning Center's check exactly as before: no system part", async () => {
    const invoke = vi.fn<(command: string, args?: unknown) => Promise<undefined>>(async () => undefined);
    const data = harnessData({ mode: "live" });
    const here: ShareContext = { organization: "1001", status: { state: "connected", organization: "1001", checked_at_ms: 1, source: "", problem: null } as ConnectionStatus };
    expect(await syncShared(data, new HarnessSession(), here, invoke as never)).toBe(true);
    expect(await syncShortcuts(data, new HarnessSession(), here, invoke as never)).toBe(true);
    for (const call of invoke.mock.calls) expect(Object.keys(call[1] as object)).toEqual(["envelopes", "copyId"]);
  });

  it("Genesis: Siri and Shortcuts get native's fixed line, nothing from the page; the copy for other AI apps stays empty", async () => {
    const genesis: ShareContext = { organization: "", status: null, genesis: true };
    const invoke = vi.fn<(command: string, args?: unknown) => Promise<undefined>>(async () => undefined);
    const none = { ...harnessData(), capture: null, brief: null, operations: null, mode: "live" as const };
    expect(await syncShortcuts(none, new HarnessSession(), genesis, invoke as never)).toBe(true);
    expect(invoke.mock.calls).toEqual([["save_shortcuts_genesis"]]);
    expect(await syncShared(none, new HarnessSession(), genesis, invoke as never)).toBe(false);
    expect(commands(invoke).slice(1)).toEqual(["clear_shared_check"]);
    // Refused (the switch off): the copy is removed.
    const refusing = vi.fn(async (command: string) => { if (command === "save_shortcuts_genesis") throw "off"; });
    expect(await syncShortcuts(none, new HarnessSession(), genesis, refusing as never)).toBe(false);
    expect(commands(refusing)).toEqual(["save_shortcuts_genesis", "clear_shortcuts_check"]);
  });
});

describe("Settings in each system's words", () => {
  const settings = { clientId: "", organization: "", serviceTypeId: "", planId: "" };
  const page = (system: MainSystem | null, on = true) => text(renderToStaticMarkup(React.createElement(SystemWordsContext.Provider, { value: systemWords(system) },
    React.createElement(ConnectionPage, { status: null, settings, onSettings: () => {}, onStatus: () => {},
      sharing: { on, onChange: () => {}, problem: null }, siri: { on, onChange: () => {}, problem: null } }))));

  it.each([["b1", "B1 Church"], ["breeze", "Breeze"]] as const)("%s: offers both, with no \"Planning Center only\" line, naming %s where Planning Center's say Planning Center", (system, name) => {
    const shown = page(system, false);
    expect(shown).toContain("Use Ozzie's last check in other AI apps");
    expect(shown).toContain("Let Siri and Shortcuts ask Ozzie");
    expect(shown).not.toMatch(/(?:AI apps|Spotlight and Shortcuts|Sharing Ozzie's last check)[^.]*Planning Center only/u);
    for (const line of SHARE_HOW) expect(shown).toContain(line.replaceAll("Planning Center", name));
    expect(shown).toContain(SIRI_NEVER.replaceAll("Planning Center", name));
    for (const line of SIRI_HOW) expect(shown).toContain(line.replaceAll("Planning Center", name));
    expect(shown).not.toContain(NO_SCHEDULES_TO_SHARE("Genesis"));
  });

  it("offers the setup for other AI apps while it's on, in the system's words", async () => {
    const { OtherAiAppsSetup } = await import("../src/other-ai-apps-setup.js");
    const shown = text(renderToStaticMarkup(React.createElement(SystemWordsContext.Provider, { value: systemWords("breeze") },
      React.createElement(OtherAiAppsSetup, { on: true, path: "/Applications/Ozzie.app/Contents/MacOS/ozzie-share" }))));
    expect(shown).toContain("Add Ozzie to an AI app on this Mac");
    expect(shown).toContain(SETUP_NEVER.replaceAll("Planning Center", "Breeze"));
  });

  it("Genesis: says it shares no volunteer schedules, and what Spotlight and Shortcuts say", () => {
    expect(page("genesis")).toContain(NO_SCHEDULES_TO_SHARE("Genesis"));
    expect(NO_SCHEDULES_TO_SHARE("Genesis")).toBe("Genesis shares no volunteer schedules, so Ozzie has no check of a service to share with other AI apps. With Siri and Shortcuts turned on, Spotlight and Shortcuts say that when asked.");
  });

  it("Planning Center: every line as before", () => {
    const shown = page(null);
    for (const line of [...SHARE_HOW, SIRI_NEVER, ...SIRI_HOW]) expect(shown).toContain(line);
    expect(shown).not.toContain(NO_SCHEDULES_TO_SHARE("Planning Center"));
  });
});
