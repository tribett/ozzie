// S5, your service (onboarding spec §2, test P2): one service with a plan → no question, the read starts at once; two →
// "Which service should Ozzie watch?", soonest first, nothing preselected; none → "no upcoming plans yet"; progress lines
// from native's recorded stages (counts only), and from the pick alone when native sends none; the result in the plan's
// own day. Mounted on the fake document with a fake native side. Fictional church only.
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { installFakeDom } from "./fake-dom.js";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => new Promise(() => {})) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
import { decideService, NOT_PLANNED, progressLines, scheduledCounts, timesText, YourService, type ResultView } from "../src/your-service.js";
import { parsePick } from "../src/onboarding-bridge.js";
import type { SundayCapture } from "../../../core/src/sunday-capture.js";
import type { Settings } from "../src/sunday-source.js";
import { fakeNative, NOTHING_PLANNED, pickReply, planNext, SATURDAY_NIGHT, SUNDAY_MORNING, YOUTH_NIGHT } from "./onboarding-fakes.js";

const dom = installFakeDom();
const all = (n: { childNodes: unknown[] }): unknown[] => [n, ...n.childNodes.flatMap(c => all(c as { childNodes: unknown[] }))];
const buttonStarting = (text: string) => all(dom.root as unknown as { childNodes: unknown[] })
  .find(n => (n as { tagName?: string }).tagName === "BUTTON" && ((n as { textContent: string }).textContent ?? "").startsWith(text)) as Parameters<typeof dom.press>[0] | undefined;
const tick = () => new Promise(r => setTimeout(r, 0));

async function mount(replies: Record<string, unknown>, over: { settings?: Settings; read?: () => Promise<SundayCapture>; result?: ResultView | null } = {}) {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const native = fakeNative(replies);
  let settings: Settings = over.settings ?? { clientId: "", organization: "1001", serviceTypeId: "", planId: "" };
  const reads: string[] = [];
  const read = vi.fn(over.read ?? (() => { reads.push(settings.planId); return new Promise<SundayCapture>(() => {}); }));
  const next = vi.fn(), deferred = vi.fn();
  const root = createRoot(dom.root as unknown as Element);
  // Settings live in the parent, as in App: a pick changes them and the step renders again with them.
  function Parent() {
    const [s, setS] = React.useState(settings);
    settings = s;
    return React.createElement(YourService, {
      bridge: native.bridge, settings: s, onSettings: n => { settings = n; setS(n); }, church: "Fictional Grace Church", read,
      result: over.result ?? null, rules: false, intervalMinutes: 60, aiOffered: false, onNext: next, onDeferred: deferred, nowMs: Date.now(),
    });
  }
  await act(async () => { root.render(React.createElement(Parent)); });
  await act(async () => { await tick(); await tick(); });
  return { native, read, reads, next, deferred, settings: () => settings, seen: () => dom.seen(), act, unmount: () => act(async () => { root.unmount(); }) };
}

describe("which service Ozzie watches", () => {
  it("one service with a plan: no question; Ozzie picks its next plan and starts reading at once", async () => {
    const s = await mount({ pick_service: pickReply(SUNDAY_MORNING, NOTHING_PLANNED) });
    expect(s.seen()).not.toContain("Which service should Ozzie watch?");
    expect(s.settings()).toMatchObject({ serviceTypeId: "1500", planId: "92902197" });
    expect(s.seen()).toContain("Are your services covered?");
    expect(s.seen()).toContain("Ozzie is watching Sunday, November 22 · 9:00 and 11:00 AM · Sunday Morning");
    expect(s.reads).toEqual(["92902197"]);
    await s.unmount();
  });

  it("a Wednesday service is asked about as Wednesday, never Sunday", async () => {
    const s = await mount({ pick_service: pickReply(YOUTH_NIGHT) });
    expect(s.seen()).toContain("Are your services covered?");
    expect(s.seen()).toContain("Wednesday, November 25 · 7:00 PM · Youth Night");
    expect(s.seen()).not.toContain("Sunday");
    await s.unmount();
  });

  it("two services with plans: the question, soonest first as native ordered them, nothing preselected; a pick reads that one", async () => {
    const s = await mount({ pick_service: pickReply(SATURDAY_NIGHT, SUNDAY_MORNING, NOTHING_PLANNED) });
    const text = s.seen();
    expect(text).toContain("Which service should Ozzie watch?");
    expect(text.indexOf("Saturday Night")).toBeLessThan(text.indexOf("Sunday Morning"));
    expect(text).toContain("Saturday, November 21 · 5:00 PM");
    expect(text).toContain("Services with nothing planned yet (1)");
    expect(text).not.toMatch(/usual|recommended/iu);
    expect(s.settings().planId).toBe("");
    expect(s.read).not.toHaveBeenCalled();
    await s.act(async () => { dom.press(buttonStarting("Saturday Night")!); });
    await s.act(async () => { await tick(); });
    expect(s.settings()).toMatchObject({ serviceTypeId: "1600", planId: "93000001" });
    expect(s.seen()).toContain("Are your services covered?");
    await s.unmount();
  });

  it("Not now on the question goes to Today and leaves the choice for Finish setting up", async () => {
    const s = await mount({ pick_service: pickReply(SATURDAY_NIGHT, SUNDAY_MORNING) });
    await s.act(async () => { dom.press(dom.button("Not now")!); });
    expect(s.deferred).toHaveBeenCalled();
    expect(s.next).toHaveBeenCalledWith("today");
    await s.unmount();
  });

  it("no upcoming plan: says so, says Ozzie looks every hour (App does: decideService below), and looks again on request", async () => {
    const s = await mount({ pick_service: pickReply(NOTHING_PLANNED) });
    expect(s.seen()).toContain("Planning Center has no upcoming Christmas Eve plans yet");
    // The promise S5d makes, word for word (review H2, mutation M14): App's hourly look keeps it.
    expect(s.seen()).toContain(NOT_PLANNED.body);
    // What the hourly look does with what it finds, said plainly (re-check Low).
    expect(NOT_PLANNED.body).toBe("When someone at your church makes the next plan in Planning Center Services, Ozzie finds it by itself. It looks again every hour while it's open. If it's the only service with a plan, Ozzie starts watching it by itself; otherwise it asks you on Today.");
    await s.act(async () => { dom.press(dom.button("Look again now")!); });
    await s.act(async () => { await tick(); });
    expect(s.native.calls.filter(c => c.command === "pick_service")).toHaveLength(2);
    await s.unmount();
  });

  it("offline while finding the services: says so plainly, under a title it can stand behind (review M9)", async () => {
    const s = await mount({ pick_service: () => { throw { "sunday-choices": "provider-failure" }; } });
    expect(s.seen()).toContain("Finding your services in Planning Center");
    expect(s.seen()).toContain("Ozzie couldn't reach Planning Center just now, so it couldn't see your services. Check that this Mac is online, then press Try again.");
    expect(s.seen()).not.toContain("Which service should Ozzie watch?");
    expect(s.seen()).not.toContain("read part of");
    await s.unmount();
  });

  it("an account that can't see Services is told what to ask for, and can copy the request", async () => {
    const s = await mount({ pick_service: () => { throw { "sunday-choices": "denied" }; } });
    expect(s.seen()).toContain("You're signed in to Planning Center as part of Fictional Grace Church, but this account can't see Services");
    expect(dom.button("Copy this request")).not.toBeNull();
    expect(dom.button("Try again")).not.toBeNull();
    await s.unmount();
  });

  it("a plan already chosen is read as it is, without asking again", async () => {
    const s = await mount({ pick_service: pickReply(SATURDAY_NIGHT, SUNDAY_MORNING) }, { settings: { clientId: "", organization: "1001", serviceTypeId: "1500", planId: "92902197" } });
    expect(s.seen()).not.toContain("Which service should Ozzie watch?");
    expect(s.reads).toEqual(["92902197"]);
    await s.unmount();
  });
});

describe("what Ozzie decides from the church's services (S5 and App's hourly look, review H2)", () => {
  it("one service with a plan: picks it; two or more: asks; none planned: waits; none at all: says so", () => {
    const one = decideService(parsePick(pickReply(SUNDAY_MORNING, NOTHING_PLANNED))!);
    expect(one).toMatchObject({ kind: "one", service: { id: "1500" }, plan: { id: "92902197" }, zone: "America/Chicago" });
    expect(decideService(parsePick(pickReply(SATURDAY_NIGHT, SUNDAY_MORNING))!).kind).toBe("several");
    expect(decideService(parsePick(pickReply(NOTHING_PLANNED))!)).toMatchObject({ kind: "none", service: { name: "Christmas Eve" } });
    expect(decideService(parsePick(pickReply())!).kind).toBe("no-services");
  });
  it("past the first 20 services, or a service native didn't read: says so, and never picks by itself (contract L7)", async () => {
    const notRead = { id: "1900", name: "Twenty-first service", next: null, problem: "not-read" };
    expect(decideService(parsePick(pickReply(SUNDAY_MORNING, notRead))!).kind).toBe("several");
    expect(decideService(parsePick({ ...pickReply(SUNDAY_MORNING), more: true })!).kind).toBe("several");
    const s = await mount({ pick_service: pickReply(SUNDAY_MORNING, notRead, { ...NOTHING_PLANNED, problem: "provider-failure" }) });
    expect(s.seen()).toContain("Which service should Ozzie watch?");
    expect(s.seen()).toContain("Ozzie read the first 20 services. If yours isn't listed, choose it in Settings.");
    expect(s.seen()).toContain("Couldn't read its plans just now");
    expect(s.seen()).not.toContain("Twenty-first service");
    await s.unmount();
  });

  it("several services with nothing planned: the title names no one of them (review L4)", async () => {
    const s = await mount({ pick_service: pickReply(NOTHING_PLANNED, { ...NOTHING_PLANNED, id: "1801", name: "Good Friday" }) });
    expect(s.seen()).toContain("Planning Center has no upcoming plans yet");
    expect(s.seen()).not.toContain("Christmas Eve plans");
    await s.unmount();
  });
});

describe("the first read's progress", () => {
  const plan = SUNDAY_MORNING.next;
  it("from native's stages: each line as its stage starts, ticked when it ends, counts only", () => {
    const lines = progressLines({ plan, zone: "America/Chicago", church: "Fictional Grace Church", rules: true, finished: false, events: [
      { stage: "plan", done: false, count: null }, { stage: "plan", done: true, count: 2 }, { stage: "teams", done: false, count: 6 }, { stage: "teams", done: true, count: null },
      { stage: "people", done: false, count: 31 },
    ] });
    expect(lines).toEqual([
      { stage: "plan", text: "Found 2 services: 9:00 and 11:00 AM.", done: true },
      { stage: "teams", text: "Read 6 teams and their roles.", done: true },
      { stage: "people", text: "Checking who said yes: 31 people scheduled so far…", done: false },
    ]);
  });

  it("without native's stages: every line from the pick, none ticked until the read ends", () => {
    const waiting = progressLines({ plan, zone: "America/Chicago", church: "Fictional Grace Church", rules: false, finished: false, events: [] });
    expect(waiting.map(l => l.text)).toEqual(["Reading Sunday, November 22 at Fictional Grace Church…", "Reading the teams and their roles…", "Checking who said yes…",
      "Checking the times people said they'll be away…"]);
    expect(waiting.every(l => !l.done)).toBe(true);
    expect(progressLines({ plan, zone: "America/Chicago", church: "x", rules: false, finished: true, events: [] }).every(l => l.done)).toBe(true);
  });

  it("times read as people say them", () => {
    expect(timesText(planNext("1", "2026-11-22T09:00:00Z", ["2026-11-22T15:00:00Z", "2026-11-23T00:00:00Z"]), "America/Chicago")).toBe("9:00 AM and 6:00 PM");
    expect(timesText(planNext("1", "2026-11-22T09:30:00Z"), null)).toBe("9:30 AM");
    expect(timesText(planNext("1", "2026-11-22T09:00:00Z", ["2026-11-22T14:00:00Z", "2026-11-22T15:30:00Z", "2026-11-22T17:00:00Z"]), "America/Chicago")).toBe("8:00, 9:30 and 11:00 AM");
  });

  it("people counts come from who is scheduled, without names", () => {
    const capture = { reads: [{ collection: "team_members", outcome: "ok", body: { data: [
      { attributes: { status: "C" }, relationships: { person: { data: { id: "501" } } } },
      { attributes: { status: "U" }, relationships: { person: { data: { id: "502" } } } },
      { attributes: { status: "D" }, relationships: { person: { data: { id: "503" } } } },
      { attributes: { status: "C" }, relationships: { person: { data: { id: "502" } } } },
    ] } }] } as unknown as SundayCapture;
    expect(scheduledCounts(capture)).toEqual({ scheduled: 2, yes: 2, waiting: 0 });
  });
});
