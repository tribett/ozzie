import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { createProactive, notifySundayAttention, proactiveReadiness, verifiedSundayCheck, type KeyValueStore, type ProactiveDeps, type ProactiveHooks } from "../src/proactive.js";
import { sundayProblem, type Settings } from "../src/sunday-source.js";
import type { ConnectionStatus } from "../src/connection.js";
import { nov22Capture } from "../../../core/src/fictional-sunday.js";
import type { SundayCapture } from "../../../core/src/sunday-capture.js";

const settings: Settings = { clientId: "fictional-client", organization: "1001", serviceTypeId: "1500", planId: "92902197" };
const status = (state: ConnectionStatus["state"]): ConnectionStatus => ({ state, organization: "1001", checked_at_ms: null, source: "", problem: null });
const rules = { sundayLeads: [], checkInAfterSundaysInARow: 3 };
const ZONE = "America/Chicago";

/** The fictional Sunday, read at `iso`, optionally changed. */
function captureAt(iso: string, change?: (c: SundayCapture) => void): SundayCapture {
  const c = nov22Capture();
  change?.(c);
  const delta = Date.parse(iso) - Date.parse(c.completed_at);
  const shift = (t: string) => new Date(Date.parse(t) + delta).toISOString();
  return { ...c, started_at: shift(c.started_at), completed_at: shift(c.completed_at), reads: c.reads.map(r => ({ ...r, checked_at: shift(r.checked_at) })) };
}
type Row = { id: string; attributes: Record<string, unknown> };
const rows = (c: SundayCapture, collection: string) => c.reads.find(r => r.collection === collection)!.body!.data as Row[];
const decline = (c: SundayCapture) => {
  rows(c, "team_members").find(m => m.id === "401")!.attributes.status = "D";
  rows(c, "needed_positions").find(n => n.attributes.team_position_name === "Greeter")!.attributes.quantity = 2;
};

function harness(start: string, store = memoryStore()) {
  let now = start;
  let change: ((c: SundayCapture) => void) | undefined;
  let fail: unknown = null;
  let hold: Promise<void> | null = null;
  const check = vi.fn(async () => {
    if (hold) await hold;
    if (fail !== null) throw fail;
    return captureAt(now, change);
  });
  const notify = vi.fn(async () => {});
  const deps: ProactiveDeps = {
    store, now: () => now, timeZone: () => ZONE, check, notify, problem: sundayProblem,
    timers: { setInterval: () => 0, clearInterval: () => {} },
  };
  const context = { settings, rules, status: status("connected") as ConnectionStatus | null };
  const hooks: ProactiveHooks = { context: () => context, onStatus: () => {}, onCapture: vi.fn() };
  const p = createProactive(deps);
  return {
    p, check, notify, hooks, context, store,
    set: (iso: string) => { now = iso; },
    changeTo: (f?: (c: SundayCapture) => void) => { change = f; },
    failWith: (e: unknown) => { fail = e; },
    holdChecks: () => { let release!: () => void; hold = new Promise(r => { release = r; }); return () => { hold = null; release(); }; },
    /** Start the controller and wait for the launch check. */
    launch: async () => { p.start(hooks); await p.tick(); },
  };
}
function memoryStore(): KeyValueStore & { dump: () => string } {
  const data = new Map<string, string>();
  return { get: k => data.get(k) ?? null, set: (k, v) => { data.set(k, v); }, dump: () => [...data.values()].join("\n") };
}
const names = Object.values(nov22Capture().names);

describe("proactive Sunday checks while Ozzie is open", () => {
  beforeEach(() => invoke.mockReset());

  it("checks on launch, keeps a baseline, and sends one discreet notice when a later check finds something worse", async () => {
    const h = harness("2026-11-20T15:00:00Z");
    await h.launch();
    expect(h.check).toHaveBeenCalledTimes(1);
    expect(h.p.view().history.map(e => e.kind)).toEqual(["first-check"]);
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.p.view().schedule.next_run_at).toBe("2026-11-20T16:00:00.000Z");

    h.set("2026-11-20T15:30:00Z");
    await h.p.tick();
    expect(h.check).toHaveBeenCalledTimes(1);

    h.changeTo(decline);
    h.set("2026-11-20T16:00:00Z");
    await h.p.tick();
    expect(h.check).toHaveBeenCalledTimes(2);
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify).toHaveBeenCalledWith();
    const [latest] = h.p.view().history;
    expect(latest).toMatchObject({ kind: "changes", trigger: "scheduled", notice: "sent" });
    expect(latest!.changes!.map(c => [c.kind, c.urgency])).toEqual([["confirmed-declined", "urgent"], ["need-increased", "urgent"]]);
    expect(h.hooks.onCapture).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "live" }), "scheduled");

    // The same facts an hour later: no new change and no second notice.
    h.set("2026-11-20T17:00:00Z");
    await h.p.tick();
    expect(h.check).toHaveBeenCalledTimes(3);
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.p.view().history).toHaveLength(2);
    for (const name of names) expect(h.store.dump()).not.toContain(name);
  });

  it("tells each check how it started, so the task ledger can say automatic or manual", async () => {
    const h = harness("2026-11-20T15:00:00Z");
    const trigger = () => (h.check.mock.calls.at(-1) as unknown[] | undefined)?.[2];
    await h.launch();
    expect(trigger()).toBe("launch");
    h.set("2026-11-20T16:00:00Z");
    await h.p.tick();
    expect(trigger()).toBe("scheduled");
    await h.p.checkNow();
    expect(trigger()).toBe("manual");
  });

  it("holds the notice during quiet hours and sends it once after they end", async () => {
    // 03:00Z is 9:00 PM in Chicago; quiet hours start at 9:30 PM.
    const h = harness("2026-11-21T03:00:00Z");
    await h.launch();
    h.changeTo(decline);
    h.set("2026-11-21T04:00:00Z");
    await h.p.tick();
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.p.view().history[0]).toMatchObject({ kind: "changes", notice: "held" });
    expect(h.p.view().schedule.held).not.toBeNull();

    h.set("2026-11-21T12:20:00Z"); // 6:20 AM, still quiet (the overdue check it runs finds nothing new)
    await h.p.tick();
    expect(h.notify).not.toHaveBeenCalled();
    h.set("2026-11-21T12:31:00Z"); // 6:31 AM
    await h.p.tick();
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.p.view().history.find(e => e.kind === "changes")!.notice).toBe("sent-later");
    await h.p.tick();
    expect(h.notify).toHaveBeenCalledTimes(1);
  });

  it("Pause everything pauses this check too, drops a held notice, and lifting it restores each to its own state", async () => {
    const h = harness("2026-11-21T03:00:00Z");
    await h.launch();
    h.changeTo(decline);
    h.set("2026-11-21T04:00:00Z");
    await h.p.tick();
    expect(h.p.view().history[0]).toMatchObject({ kind: "changes", notice: "held" });
    h.p.pauseWithEverything(true);
    expect(h.p.view().schedule).toMatchObject({ paused: true, held: null });
    // The held entry no longer says it is waiting, as the responsibilities' held notices don't.
    expect(h.p.view().history[0]!.notice).toBe("none");
    h.p.pauseWithEverything(false);
    expect(h.p.view().schedule.paused).toBe(false);
    // Resuming checks again at once; quiet hours end with nothing held to send.
    await h.p.tick();
    expect(h.p.view().schedule.held).toBeNull();
    h.set("2026-11-21T12:31:00Z");
    await h.p.tick();
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("lifting Pause everything leaves this check as the person last set it, even after a restart", async () => {
    // Paused on its own first: it stays paused.
    const h = harness("2026-11-20T15:00:00Z");
    await h.launch();
    h.p.pause();
    h.p.pauseWithEverything(true);
    const again = harness("2026-11-20T16:00:00Z", h.store);
    again.p.pauseWithEverything(false);
    expect(again.p.view().schedule.paused).toBe(true);
    // Paused on its own while everything was paused: lifting everything leaves it paused.
    const k = harness("2026-11-20T15:00:00Z");
    await k.launch();
    k.p.pauseWithEverything(true);
    k.p.resume();
    k.p.pause();
    k.p.pauseWithEverything(false);
    expect(k.p.view().schedule.paused).toBe(true);
    // Not paused on its own: lifting everything resumes it.
    const m = harness("2026-11-20T15:00:00Z");
    await m.launch();
    m.p.pauseWithEverything(true);
    m.p.pauseWithEverything(true);
    m.p.pauseWithEverything(false);
    expect(m.p.view().schedule.paused).toBe(false);
  });

  it("lets an urgent change through quiet hours only when the person chose that", async () => {
    const h = harness("2026-11-21T03:00:00Z");
    h.p.setPrefs({ ...h.p.view().prefs, urgentDuringQuiet: true });
    await h.launch();
    h.changeTo(decline);
    h.set("2026-11-21T04:00:00Z");
    await h.p.tick();
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.p.view().history[0]!.notice).toBe("sent");
  });

  it("reports a failed check once, retries with backoff, and never sends a notice for it", async () => {
    const h = harness("2026-11-20T15:00:00Z");
    h.failWith({ sunday_check: "provider" });
    await h.launch();
    const view = h.p.view();
    expect(view.schedule.last_run).toMatchObject({ outcome: "failed", problem: "Planning Center couldn't be checked just now. You can use the last saved recording instead." });
    expect(view.schedule.next_run_at).toBe("2026-11-20T15:05:00.000Z");
    h.set("2026-11-20T15:05:00Z");
    await h.p.tick();
    expect(h.p.view().schedule).toMatchObject({ failures: 2, next_run_at: "2026-11-20T15:15:00.000Z" });
    expect(h.p.view().history.map(e => e.kind)).toEqual(["failed"]);
    expect(h.notify).not.toHaveBeenCalled();
    expect(JSON.stringify(h.p.view())).not.toContain("provider");
  });

  it("Check now while a scheduled check is running waits for it instead of starting a second one", async () => {
    const h = harness("2026-11-20T15:00:00Z");
    const release = h.holdChecks();
    h.p.start(h.hooks);
    const ticking = h.p.tick();
    await Promise.resolve();
    const manual = h.p.checkNow();
    expect(h.p.view().running).toBe(true);
    release();
    const [capture] = await Promise.all([manual, ticking]);
    expect(capture.kind).toBe("live");
    expect(h.check).toHaveBeenCalledTimes(1);
  });

  it("a manual check records what changed but never sends a notice", async () => {
    const h = harness("2026-11-20T15:00:00Z");
    await h.launch();
    h.changeTo(decline);
    h.set("2026-11-20T15:10:00Z");
    await h.p.checkNow();
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.p.view().history[0]).toMatchObject({ kind: "changes", trigger: "manual", notice: "in-app" });
    expect(h.p.view().schedule.next_run_at).toBe("2026-11-20T16:10:00.000Z");
  });

  it("reports a check missed while Ozzie was closed on the next launch, then catches up", async () => {
    const store = memoryStore();
    const first = harness("2026-11-20T15:00:00Z", store);
    await first.launch();
    first.p.stop();
    const second = harness("2026-11-21T01:00:00Z", store);
    await second.launch();
    expect(second.p.view().history.map(e => e.kind)).toEqual(["missed", "first-check"]);
    expect(second.p.view().history[0]).toMatchObject({ kind: "missed", scheduled_for: "2026-11-20T16:00:00.000Z" });
    expect(second.p.view().schedule.last_run).toMatchObject({ trigger: "catch-up", outcome: "ok" });
    expect(second.check).toHaveBeenCalledTimes(1);
  });

  it("waits for a saved connection and a chosen Sunday instead of failing", async () => {
    const h = harness("2026-11-20T15:00:00Z");
    h.context.status = null;
    await h.launch();
    expect(h.check).not.toHaveBeenCalled();
    expect(h.p.view().schedule).toMatchObject({ failures: 0, waiting_since: "2026-11-20T15:00:00Z" });
    expect(h.p.view().history).toEqual([]);
    h.context.status = status("stored-unchecked");
    await h.p.tick();
    expect(h.check).toHaveBeenCalledTimes(1);
  });

  it("pausing stops automatic checks; Check now still works", async () => {
    const h = harness("2026-11-20T15:00:00Z");
    await h.launch();
    h.p.pause();
    h.set("2026-11-20T18:00:00Z");
    await h.p.tick();
    expect(h.check).toHaveBeenCalledTimes(1);
    await h.p.checkNow();
    expect(h.check).toHaveBeenCalledTimes(2);
    h.p.resume();
    await h.p.tick();
    expect(h.check).toHaveBeenCalledTimes(3);
  });

  it("a pause survives restarting Ozzie: no launch check, no missed check", async () => {
    const store = memoryStore();
    const first = harness("2026-11-20T15:00:00Z", store);
    await first.launch();
    first.p.pause();
    first.p.stop();
    const second = harness("2026-11-20T20:00:00Z", store);
    await second.launch();
    expect(second.check).not.toHaveBeenCalled();
    expect(second.p.view().schedule).toMatchObject({ paused: true, next_run_at: null });
    expect(second.p.view().history.map(e => e.kind)).toEqual(["first-check"]);
  });

  it("starting twice (as React does in development) runs the launch work once", async () => {
    const h = harness("2026-11-20T15:00:00Z");
    h.p.start(h.hooks);
    h.p.stop();
    await h.launch();
    expect(h.check).toHaveBeenCalledTimes(1);
    expect(h.p.view().schedule.last_run?.outcome).toBe("ok");
  });

  it("counts new attention until the page is seen", async () => {
    const h = harness("2026-11-20T15:00:00Z");
    await h.launch();
    h.changeTo(decline);
    h.set("2026-11-20T16:00:00Z");
    await h.p.tick();
    expect(h.p.view().unseen).toBe(1);
    h.p.markSeen();
    expect(h.p.view().unseen).toBe(0);
  });
});

describe("native boundaries", () => {
  beforeEach(() => invoke.mockReset());

  it("the notice is fixed in native code; the webview sends no text", async () => {
    invoke.mockResolvedValue(undefined);
    await notifySundayAttention();
    expect(invoke).toHaveBeenCalledWith("notify_sunday_attention");
    expect(invoke.mock.calls[0]).toHaveLength(1);
  });

  it("re-verifies a saved connection before reading, as the Sunday page always has", async () => {
    invoke.mockImplementation(async (command: string) => command === "check_saved_connection" ? status("connected") : captureAt("2026-11-20T15:00:00Z"));
    const seen: ConnectionStatus[] = [];
    await verifiedSundayCheck({ settings, status: status("stored-unchecked") }, s => seen.push(s));
    expect(invoke.mock.calls.map(c => c[0])).toEqual(["check_saved_connection", "check_sunday"]);
    expect(seen.map(s => s.state)).toEqual(["connected"]);

    invoke.mockReset();
    invoke.mockResolvedValue(status("expired"));
    await expect(verifiedSundayCheck({ settings, status: status("stored-unchecked") }, () => {})).rejects.toBe("not-connected");
    expect(invoke.mock.calls.map(c => c[0])).toEqual(["check_saved_connection"]);

    invoke.mockReset();
    invoke.mockResolvedValue(captureAt("2026-11-20T15:00:00Z"));
    await verifiedSundayCheck({ settings, status: status("connected") }, () => {});
    expect(invoke.mock.calls).toEqual([["check_sunday", { serviceTypeId: "1500", planId: "92902197" }]]);
  });

  it("runs only with a saved connection and a chosen Sunday, never during sign-in", () => {
    expect(proactiveReadiness(settings, status("connected"))).toBe("ready");
    expect(proactiveReadiness(settings, status("stored-unchecked"))).toBe("ready");
    for (const state of ["waiting", "checking", "disconnected", "cancelled", "expired", "failed"] as const) {
      expect(proactiveReadiness(settings, status(state))).toBe("not-connected");
    }
    expect(proactiveReadiness(settings, null)).toBe("not-connected");
    expect(proactiveReadiness({ ...settings, planId: "" }, status("connected"))).toBe("not-configured");
  });
});
