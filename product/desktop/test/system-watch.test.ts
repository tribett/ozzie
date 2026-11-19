// Keeping watch for a church on B1 Church or Breeze (system-watch.ts): the same Sunday schedule as Planning Center's, with
// its own state. Fictional captures only, a fixed clock and no native side: what a check compares, what it tells and
// when, and that nothing is compared or told about a church let go meanwhile.
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { SystemReadFailure, type KeyValueStore, type ProactiveContext, type ProactiveHooks, type SystemWatch } from "../src/proactive.js";
import { createSystemProactive, systemCheck, systemDigest, systemProblem, systemReady } from "../src/system-watch.js";
import type { SystemConnection } from "../src/church-system.js";
import type { SystemCapture } from "../../../core/src/church-systems/types.js";
import type { SundayRules } from "../../../core/src/sunday-capture.js";
import type { Settings } from "../src/sunday-source.js";
import { B1_READS, b1Capture, breezeCapture, readsOf } from "../../../core/test/church-systems/fixtures.js";

const settings: Settings = { clientId: "", organization: "", serviceTypeId: "", planId: "" };
const rules: SundayRules = { sundayLeads: [], checkInAfterSundaysInARow: 3 };
const B1: SystemConnection = { system: "b1", church_id: "CHU0000cedar", church_name: "Cedar Hollow Fellowship", address: "cedarhollow", service_id: "PLA0000nov22",
  service_day: "2026-11-22", service_name: "Sunday Gathering", zone: "America/Chicago", result_seen: true };
const BREEZE: SystemConnection = { system: "breeze", church_id: "juniperstreet", church_name: "Juniper Street Church", address: "juniperstreet", service_id: "88120031",
  service_day: "2026-11-22", service_name: null, zone: null, result_seen: true };

/** `base` read at `iso`: when it started and finished and when each read ran, every list in another order each time. */
function readAt(iso: string, base: SystemCapture, flip: boolean): SystemCapture {
  const delta = Date.parse(iso) - Date.parse(base.completed_at);
  const shift = (t: string) => new Date(Date.parse(t) + delta).toISOString().replace(/\.000Z$/u, "Z");
  const order = <T>(list: readonly T[]) => flip ? [...list].reverse() : [...list];
  return { ...base, started_at: shift(base.started_at), completed_at: shift(base.completed_at), reads: order(base.reads.map(r => ({ ...r, checked_at: shift(r.checked_at) }))),
    positions: order(base.positions), assignments: order(base.assignments), team_members: order(base.team_members) };
}
function memoryStore(): KeyValueStore & { dump: () => string } {
  const data = new Map<string, string>();
  return { get: k => data.get(k) ?? null, set: (k, v) => { data.set(k, v); }, dump: () => [...data.entries()].map(([k, v]) => `${k}=${v}`).join("\n") };
}

function harness(start: string, connection: SystemConnection = B1, base: () => SystemCapture = b1Capture) {
  let now = start;
  let flip = false;
  let shape: (c: SystemCapture) => SystemCapture = c => c;
  let watched: SystemConnection | null = connection;
  let before: (() => void) | null = null;
  const reads = vi.fn(async () => {
    before?.();
    flip = !flip;
    return shape(readAt(now, base(), flip));
  });
  const watch = (): SystemWatch | null => watched ? { connection: watched, read: reads } : null;
  const notify = vi.fn(async (options?: unknown) => { void options; });
  const found = vi.fn();
  const store = memoryStore();
  const p = createSystemProactive({
    store, now: () => now, timeZone: () => "UTC", notify, found,
    check: (ctx, _s, _t, _source, onTask) => { onTask?.(`task-${reads.mock.calls.length + 1}`); return systemCheck(ctx, w => w.read()); },
    timers: { setInterval: () => 0, clearInterval: () => {} },
  });
  const context = (): ProactiveContext => ({ settings, rules, status: null, system: watch() });
  const onCapture = vi.fn();
  const onFailure = vi.fn();
  const hooks: ProactiveHooks<SystemCapture> = { context, onStatus: () => {}, onCapture, onFailure };
  return {
    p, reads, notify, found, store, onCapture, onFailure,
    set: (iso: string) => { now = iso; },
    change: (f: (c: SystemCapture) => SystemCapture) => { shape = f; },
    connect: (c: SystemConnection | null) => { watched = c; },
    /** Runs `f` while the next read is under way (a switch or a disconnect mid-check). */
    during: (f: () => void) => { before = () => { before = null; f(); }; },
    launch: async () => { p.start(hooks); await p.tick(); },
  };
}
const rowanDeclines = (c: SystemCapture): SystemCapture => ({ ...c, assignments: c.assignments.map(a => a.id === "ASN-rowan" ? { ...a, status: "declined" } : a) });
const names = Object.values(b1Capture().names);

describe("a church on B1 Church or Breeze, kept watch over on a schedule", () => {
  beforeEach(() => invoke.mockReset());

  it("checks at launch and on its interval, finds nothing new when only when things were read differs, and tells a decline once, with no name", async () => {
    const h = harness("2026-11-20T15:00:04Z");
    await h.launch();
    expect(h.reads).toHaveBeenCalledTimes(1);
    expect(h.p.view().history.map(e => e.kind)).toEqual(["first-check"]);
    expect(h.p.view().schedule.next_run_at).toBe("2026-11-20T16:00:04.000Z");
    // An hour later: the same facts, read at other times and listed in another order. Nothing new: nothing listed, no notice.
    h.set("2026-11-20T16:00:04Z");
    await h.p.tick();
    expect(h.reads).toHaveBeenCalledTimes(2);
    expect(h.found).toHaveBeenLastCalledWith("task-2", "nothing-new");
    expect(h.p.view().history.map(e => e.kind)).toEqual(["first-check"]);
    expect(h.notify).not.toHaveBeenCalled();
    // Rowan, who had said yes to Vocals, now says no: one change by person id, and one notice whose words are native's.
    h.change(rowanDeclines);
    h.set("2026-11-20T17:00:04Z");
    await h.p.tick();
    expect(h.found).toHaveBeenLastCalledWith("task-3", "changes");
    const entry = h.p.view().history[0]!;
    expect(entry).toMatchObject({ kind: "changes", plan_id: "PLA0000nov22", notice: "sent" });
    expect(entry.changes!.map(c => [c.kind, c.person_id ?? null])).toContainEqual(["confirmed-declined", "PER-rowan"]);
    expect(h.notify).toHaveBeenCalledTimes(1);
    // The page passes native only closed words: whether it stays on this Mac, and the day. Never a name or a role.
    const options = h.notify.mock.calls[0]![0] as Record<string, unknown> | undefined;
    expect(Object.keys(options ?? {}).every(k => k === "localOnly" || k === "day")).toBe(true);
    expect(options?.day).toBe("sunday");
    // Nothing this Mac keeps for the schedule holds a name: changes and records carry person ids only.
    for (const name of [...names, "Cedar Hollow Fellowship"]) expect(h.store.dump()).not.toContain(name);
    // The same decline read again isn't told twice.
    h.set("2026-11-20T18:00:04Z");
    await h.p.tick();
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.found).toHaveBeenLastCalledWith("task-4", "nothing-new");
  });

  it("finds nothing new for B1 Church, whose forms list is always cut short by design (live, round 3)", async () => {
    const h = harness("2026-11-20T15:00:04Z", B1, () => b1Capture({ reads: readsOf(B1_READS, { "b1.forms": "truncated" }) }));
    await h.launch();
    h.set("2026-11-20T16:00:04Z");
    await h.p.tick();
    expect(h.found).toHaveBeenLastCalledWith("task-2", "nothing-new");
    // A read that truly didn't finish still keeps it from counting as nothing new.
    h.change(c => ({ ...c, reads: c.reads.map(r => r.read === "b1.events" ? { ...r, outcome: "timeout" as const } : r) }));
    h.set("2026-11-20T17:00:04Z");
    await h.p.tick();
    expect(h.found).not.toHaveBeenLastCalledWith("task-3", "nothing-new");
  });

  it("keeps its state apart from Planning Center's on this Mac", async () => {
    const h = harness("2026-11-20T15:00:04Z");
    await h.launch();
    const keys = h.store.dump().split("\n").map(l => l.slice(0, l.indexOf("=")));
    expect(keys.filter(k => k !== "ozzie.proactive.prefs.v1").every(k => k.startsWith("ozzie.proactive.system."))).toBe(true);
  });

  it("holds a notice for quiet hours, and drops it when the church is let go", async () => {
    const h = harness("2026-11-20T21:30:04Z");
    await h.launch();
    h.change(rowanDeclines);
    h.set("2026-11-20T22:30:04Z");
    await h.p.tick();
    expect(h.p.view().history[0]).toMatchObject({ kind: "changes", notice: "held" });
    expect(h.notify).not.toHaveBeenCalled();
    // The person disconnects (or switches) before quiet hours end: nothing about that church is told afterwards.
    h.connect(null);
    h.p.letGo();
    expect(h.p.view().schedule.held).toBeNull();
    // What changed was that church's: Keeping watch starts afresh for the next one.
    expect(h.p.view().history).toEqual([]);
    expect(h.p.view().schedule.failures).toBe(0);
    h.set("2026-11-21T07:30:00Z");
    await h.p.tick();
    expect(h.notify).not.toHaveBeenCalled();
    // And no check runs without a connection.
    expect(h.reads).toHaveBeenCalledTimes(2);
  });

  it("sends a held notice after quiet hours while the same church is still watched", async () => {
    const h = harness("2026-11-20T21:30:04Z");
    await h.launch();
    h.change(rowanDeclines);
    h.set("2026-11-20T22:30:04Z");
    await h.p.tick();
    h.set("2026-11-21T07:00:30Z");
    await h.p.tick();
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.p.view().history.find(e => e.kind === "changes")!.notice).toBe("sent-later");
  });

  it("compares and tells nothing about a check that ends after a switch or a disconnect", async () => {
    for (const next of [null, { ...B1, church_id: "CHU0000other" }, { ...B1, service_id: "PLA0000nov29" }]) {
      const h = harness("2026-11-20T15:00:04Z");
      await h.launch();
      h.change(rowanDeclines);
      h.set("2026-11-20T16:00:04Z");
      h.during(() => h.connect(next));
      await h.p.tick();
      expect(h.reads).toHaveBeenCalledTimes(2);
      expect(h.p.view().history.map(e => e.kind)).toEqual(["first-check"]);
      expect(h.notify).not.toHaveBeenCalled();
      expect(h.found).not.toHaveBeenCalledWith("task-2", expect.anything());
    }
  });

  it("tells nothing while B1 Church's time zone waits to be confirmed", async () => {
    const h = harness("2026-11-20T15:00:04Z", { ...B1, zone: null }, () => b1Capture({ church: { id: "CHU0000cedar", time_zone: null } }));
    // Not on its own: the church's zone isn't confirmed.
    expect(systemReady({ connection: { ...B1, zone: null }, read: h.reads })).toBe(false);
    // Asked (Check now), the check reads, but nothing of it is compared or told.
    h.p.start({ context: () => ({ settings, rules, status: null, system: { connection: { ...B1, zone: null }, read: h.reads } }), onStatus: () => {}, onCapture: h.onCapture });
    await h.p.checkNow();
    expect(h.onCapture).toHaveBeenCalledTimes(1);
    expect(h.p.view().history).toEqual([]);
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("Breeze: the same, by Breeze's own ids", async () => {
    const accepted = () => breezeCapture({ assignments: [
      { id: "71001", position_id: "9627", person_id: "157801", status: "accepted", asked: null },
      { id: "71002", position_id: "9628", person_id: "157802", status: "accepted", asked: null }] });
    const h = harness("2026-11-20T15:00:04Z", BREEZE, accepted);
    await h.launch();
    h.set("2026-11-20T16:00:04Z");
    await h.p.tick();
    expect(h.found).toHaveBeenLastCalledWith("task-2", "nothing-new");
    h.change(c => ({ ...c, assignments: c.assignments.map(a => a.id === "71002" ? { ...a, status: "declined" } : a) }));
    h.set("2026-11-20T17:00:04Z");
    await h.p.tick();
    expect(h.p.view().history[0]!.changes!.map(c => [c.kind, c.person_id ?? null])).toContainEqual(["confirmed-declined", "157802"]);
    expect(h.notify).toHaveBeenCalledTimes(1);
  });

  it("only checks on its own with a service, a first result and, for B1 Church, a confirmed zone; a failed check says why in plain words", async () => {
    const watch = (c: Partial<SystemConnection>): SystemWatch => ({ connection: { ...B1, ...c }, read: async () => b1Capture() });
    expect(systemReady(watch({}))).toBe(true);
    expect(systemReady(watch({ service_id: null }))).toBe(false);
    expect(systemReady(watch({ result_seen: false }))).toBe(false);
    expect(systemReady(watch({ zone: null }))).toBe(false);
    expect(systemReady({ connection: BREEZE, read: async () => breezeCapture() })).toBe(true);
    expect(systemReady(null)).toBe(false);
    await expect(systemCheck({ settings, rules, status: null, system: watch({ service_id: null }) }, w => w.read())).rejects.toBeInstanceOf(SystemReadFailure);
    expect(systemProblem(new SystemReadFailure("b1", "key-refused"))).toMatch(/B1 Church no longer accepts the key Ozzie has/u);
    expect(systemProblem("anything")).toBe("The check couldn't finish just now.");
    // A failure on its own is handed to the page, so it can say why.
    const h = harness("2026-11-20T15:00:04Z");
    h.change(() => { throw new SystemReadFailure("b1", "key-refused"); });
    await h.launch();
    expect(h.onFailure).toHaveBeenCalledTimes(1);
    expect(h.p.view().history[0]).toMatchObject({ kind: "failed" });
    expect(h.p.view().history[0]!.problem).toMatch(/B1 Church no longer accepts the key/u);
  });

  it("charges nothing of a failed check of a church let go of meanwhile to the church watched now", async () => {
    const h = harness("2026-11-20T15:00:04Z");
    await h.launch();
    h.set("2026-11-20T16:00:04Z");
    h.change(() => { throw new SystemReadFailure("b1", "key-refused", "CHU0000cedar"); });
    h.during(() => h.connect({ ...B1, church_id: "CHU0000other" }));
    await h.p.tick();
    expect(h.p.view().schedule.failures).toBe(0);
    expect(h.p.view().history.map(e => e.kind)).toEqual(["first-check"]);
    expect(h.onFailure).not.toHaveBeenCalled();
  });

  it("compares only a check of the church and service watched", () => {
    const ctx = (c: SystemConnection | null): ProactiveContext => ({ settings, rules, status: null, system: c ? { connection: c, read: async () => b1Capture() } : null });
    const at = "2026-11-20T15:10:00Z";
    expect(systemDigest(b1Capture(), ctx(B1), at)).toMatchObject({ owner: "b1:CHU0000cedar", plan_id: "PLA0000nov22", ops: null, complete: true });
    expect(systemDigest(b1Capture(), ctx(null), at)).toBeNull();
    expect(systemDigest(b1Capture(), ctx({ ...B1, church_id: "CHU0000other" }), at)).toBeNull();
    expect(systemDigest(b1Capture(), ctx(BREEZE), at)).toBeNull();
    expect(systemDigest(b1Capture({ reads: b1Capture().reads.map(r => r.read === "b1.blockouts" ? { ...r, outcome: "timeout" } : r) }), ctx(B1), at)?.complete).toBe(false);
  });
});
