// "Use Ozzie's last check in other AI apps" (harness plan H5): off by default, shares only the agent tools'
// placeholder results through the native check, and says so in plain words. Fictional data only.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { ConnectionPage, SHARE_BODY, SHARE_HOW } from "../src/connection-page.js";
import { copyIdFor, SHARE_START_PROBLEM, SHARE_STOP_PROBLEM, shareable, SharingControl, syncShared, type ShareContext, type SharingView } from "../src/share-check.js";
import type { ConnectionStatus } from "../src/connection.js";
import type { HarnessData } from "../../../core/src/harness/tools.js";
import { namedIn } from "../../../core/src/harness/names.js";
import { HarnessSession } from "../../../core/src/harness/session.js";
import { COPY_ID, parseSharedCheck, SHARED_TOOLS, sharedCheckText } from "../../../core/mcp/snapshot.js";
import { harnessData } from "../../../core/test/harness/fixtures.js";
import type { ToolEnvelope } from "../../../core/src/harness/contract.js";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replaceAll("&#x27;", "'").replaceAll("&quot;", "\"").replace(/\s+/g, " ");

const ORG = "1001";
const connected = (organization = ORG) => ({ state: "connected", organization, checked_at_ms: 1, source: "", problem: null }) as ConnectionStatus;
const here: ShareContext = { organization: ORG, status: connected() };
const commands = (invoke: { mock: { calls: unknown[][] } }) => invoke.mock.calls.map(c => c[0] as string);

describe("turning sharing on and off", () => {
  it("is off unless native says it's on, and off when native can't say", async () => {
    for (const [answer, on] of [[false, false], [true, true], [new Error("unavailable"), false]] as const) {
      const shown: SharingView[] = [];
      const control = new SharingControl((async () => { if (answer instanceof Error) throw answer; return answer; }) as never, v => shown.push(v));
      expect(control.view).toEqual({ on: false, problem: null });
      await control.load();
      expect(control.view).toEqual({ on, problem: null });
    }
  });

  it("a choice made while native is still answering wins", async () => {
    let answer!: (on: boolean) => void;
    const invoke = vi.fn(async (command: string) => command === "sharing_check_status" ? new Promise<boolean>(r => { answer = r; }) : undefined);
    const control = new SharingControl(invoke as never, () => {});
    const loading = control.load();
    await new Promise(r => setTimeout(r, 0));
    const choosing = control.change(false);
    answer(true);
    await Promise.all([loading, choosing]);
    expect(control.view).toEqual({ on: false, problem: null });
  });

  it("asks native to turn it on and off; a copy it couldn't remove is said plainly and it stays on to try again", async () => {
    const invoke = vi.fn(async (command: string) => { if (command === "stop_sharing_check" && invoke.mock.calls.length === 2) throw "unavailable"; });
    const control = new SharingControl(invoke as never, () => {});
    await control.change(true);
    expect(control.view).toEqual({ on: true, problem: null });
    await control.change(false);
    expect(control.view).toEqual({ on: true, problem: SHARE_STOP_PROBLEM });
    await control.change(false);
    expect(control.view).toEqual({ on: false, problem: null });
    expect(commands(invoke)).toEqual(["start_sharing_check", "stop_sharing_check", "stop_sharing_check"]);
  });

  it("a failure to turn it on leaves it off and says so", async () => {
    const control = new SharingControl((async () => { throw "unavailable"; }) as never, () => {});
    await control.change(true);
    expect(control.view).toEqual({ on: false, problem: SHARE_START_PROBLEM });
  });
});

describe("sharing the last check", () => {
  it("hands native only the shared tools' placeholder results and one copy id per set of labels, which the server accepts", async () => {
    const invoke = vi.fn(async () => undefined);
    const data = harnessData({ mode: "live" });
    const session = new HarnessSession();
    expect(await syncShared(data, session, here, invoke as never)).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
    const [command, args] = invoke.mock.calls[0] as unknown as [string, { envelopes: string[]; copyId: string }];
    expect(command).toBe("share_last_check");
    const envelopes = args.envelopes.map(e => JSON.parse(e) as ToolEnvelope);
    expect(envelopes.map(e => e.tool)).toEqual([...SHARED_TOOLS]);
    const all = args.envelopes.join("\n");
    expect(namedIn(all, data.capture!.names, "strict")).toBe(false);
    expect(args.copyId).toMatch(COPY_ID);
    expect(copyIdFor(session)).toBe(args.copyId);
    expect(copyIdFor(new HarnessSession())).not.toBe(args.copyId);
    expect(parseSharedCheck(sharedCheckText(envelopes, [], "2026-11-20T15:06:00Z", args.copyId))).not.toBeNull();
  });

  const cases: [string, HarnessData, ShareContext][] = [
    ["no check yet", { ...harnessData(), capture: null, brief: null, operations: null, mode: "live" }, here],
    ["another church's check", harnessData({ mode: "live" }), { organization: "2002", status: connected("2002") }],
    ["no church in Settings", harnessData({ mode: "live" }), { organization: "", status: connected() }],
    ["the connection not known yet", harnessData({ mode: "live" }), { organization: ORG, status: null }],
    ["Planning Center disconnected", harnessData({ mode: "recording" }), { organization: ORG, status: { ...connected(), state: "disconnected" } }],
    ["a connection bound to another church", harnessData({ mode: "live" }), { organization: ORG, status: connected("2002") }],
  ];
  it.each(cases)("removes the copy, sharing nothing, with %s", async (_label, data, context) => {
    const invoke = vi.fn(async () => undefined);
    expect(shareable(data, context)).toBe(false);
    expect(await syncShared(data, new HarnessSession(), context, invoke as never)).toBe(false);
    expect(commands(invoke)).toEqual(["clear_shared_check"]);
  });

  it("removes the copy once the check's saved recordings are deleted, and shares the next check", async () => {
    const invoke = vi.fn(async () => undefined);
    const data = harnessData({ mode: "live" });
    expect(await syncShared(data, new HarnessSession(), { ...here, forgotten: data.capture }, invoke as never)).toBe(false);
    expect(commands(invoke)).toEqual(["clear_shared_check"]);
    const next = harnessData({ mode: "live" });
    expect(await syncShared(next, new HarnessSession(), { ...here, forgotten: data.capture }, invoke as never)).toBe(true);
  });

  it("shares the fictional example whatever church is set, since it holds no church's data", async () => {
    const invoke = vi.fn(async () => undefined);
    expect(await syncShared(harnessData(), new HarnessSession(), { organization: "", status: null }, invoke as never)).toBe(true);
    expect(commands(invoke)).toEqual(["share_last_check"]);
  });

  it("a refused share removes the copy rather than keep an older one, and doesn't stop later shares", async () => {
    const invoke = vi.fn(async (command: string) => { if (command === "share_last_check" && invoke.mock.calls.length === 1) throw "invalid"; });
    expect(await syncShared(harnessData(), new HarnessSession(), here, invoke as never)).toBe(false);
    expect(commands(invoke)).toEqual(["share_last_check", "clear_shared_check"]);
    expect(await syncShared(harnessData(), new HarnessSession(), here, invoke as never)).toBe(true);
  });

  it("a copy that couldn't be removed is reported to the caller", async () => {
    const invoke = vi.fn(async () => { throw "unavailable"; });
    await expect(syncShared(harnessData({ mode: "live" }), new HarnessSession(), { organization: "2002", status: null }, invoke as never)).rejects.toBe("unavailable");
  });

  it("removes the copy only after a share already in flight, so turning it off can't be undone by a late share", async () => {
    const order: string[] = [];
    let release!: () => void;
    const slow = new Promise<void>(r => { release = r; });
    const invoke = vi.fn(async (command: string) => { if (command === "share_last_check") await slow; order.push(command); });
    const sharing = syncShared(harnessData(), new HarnessSession(), here, invoke as never);
    const stopping = new SharingControl(invoke as never, () => {}).change(false);
    await new Promise(r => setTimeout(r, 20));
    expect(order).toEqual([]);
    release();
    await Promise.all([sharing, stopping]);
    expect(order).toEqual(["share_last_check", "stop_sharing_check"]);
  });
});

describe("the Settings line", () => {
  const settings = { clientId: "", organization: "", serviceTypeId: "", planId: "" };
  const page = (on: boolean, problem: string | null = null) => text(renderToStaticMarkup(React.createElement(ConnectionPage, {
    status: null, settings, onSettings: () => {}, onStatus: () => {}, sharing: { on, onChange: () => {}, problem },
  })));

  it("says what it does in plain words, with See how this works", () => {
    const shown = page(false);
    expect(shown).toContain("Other AI apps");
    expect(shown).toContain("Use Ozzie's last check in other AI apps");
    expect(shown).toContain("See how this works");
    expect(shown).toContain("Off unless you turn it on. Turning it off removes the copy.");
    expect(shown).not.toContain(SHARE_STOP_PROBLEM);
    for (const line of SHARE_HOW) expect(shown).toContain(line);
  });

  it("says plainly when the copy couldn't be removed", () => {
    expect(page(true, SHARE_STOP_PROBLEM)).toContain("Ozzie couldn't remove the shared copy. Try turning it off again.");
  });

  it("never uses the words people shouldn't have to know", () => {
    const copy = [SHARE_BODY, ...SHARE_HOW, SHARE_STOP_PROBLEM, SHARE_START_PROBLEM, page(true)].join(" ");
    expect(copy).not.toMatch(/\b(?:MCP|server|connector|skills?|sessions?|agents?|logs?|harness|Approve|Block|protocol|JSON)\b/iu);
  });

  it("is left out when the app doesn't offer it", () => {
    const shown = text(renderToStaticMarkup(React.createElement(ConnectionPage, { status: null, settings, onSettings: () => {}, onStatus: () => {} })));
    expect(shown).not.toContain("Other AI apps");
  });
});
