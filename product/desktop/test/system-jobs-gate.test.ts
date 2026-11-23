// A church on B1 Church or Breeze, wired as App wires it (its own schedule, the jobs gate, handChanges): a change its
// schedule finds brings exactly one notice, from Keep services covered; and a key the system refuses, or a service with no
// roles, holds the church's jobs back without using their checks until Ozzie's own check reads the service again (review
// of 0.8.0, L1). Fixed fictional data, a fake native store and clock; nothing native runs.
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => { throw new Error("NATIVE_CALL_FORBIDDEN"); }) }));
import { defaultPlan, type Plan } from "../../../core/src/harness/responsibilities.js";
import { DEFAULT_QUIET_HOURS } from "../../../core/src/schedule.js";
import type { SystemCapture } from "../../../core/src/church-systems/types.js";
import { buildSystemBrief } from "../../../core/src/church-systems/brief.js";
import { b1Capture } from "../../../core/test/church-systems/fixtures.js";
import { createRunner, handChanges, type JobChurch } from "../src/responsibility-runner.js";
import { noticedTitle } from "../src/responsibility-words.js";
import { createJobsGate, systemJobCheck } from "../src/system-jobs.js";
import type { SystemConnection } from "../src/church-system.js";
import { SystemReadFailure, type ProactiveContext, type SystemWatch } from "../src/proactive.js";
import { createSystemProactive, systemCheck, systemReady } from "../src/system-watch.js";
import { fakeJobStore, memoryStore } from "./job-fakes.js";

const ET = "America/New_York", CT = "America/Chicago";
const RULES = { sundayLeads: [], checkInAfterSundaysInARow: 3 };
const FRI = "2026-11-20T15:05:00.000Z";
const CHURCH: Readonly<Record<"cedar", JobChurch>> = { cedar: { church: "b1:CHU0000cedar", name: "Cedar Hollow Fellowship", system: "b1" } };
/** A B1 Church capture read at `iso`, for `church`. */
function b1At(iso: string, church = "CHU0000cedar", change?: (c: SystemCapture) => SystemCapture): SystemCapture {
  const base = change ? change(b1Capture()) : b1Capture();
  const delta = Date.parse(iso) - Date.parse(base.completed_at);
  const shift = (t: string) => new Date(Date.parse(t) + delta).toISOString().replace(/\.\d{3}Z$/u, "Z");
  return { ...base, church: { ...base.church, id: church }, started_at: shift(base.started_at), completed_at: shift(base.completed_at), reads: base.reads.map(r => ({ ...r, checked_at: shift(r.checked_at) })) };
}
const rowanDeclines = (c: SystemCapture): SystemCapture => ({ ...c, assignments: c.assignments.map(a => a.id === "ASN-rowan" ? { ...a, status: "declined" as const } : a) });
const keepPlan = (zone: string): Plan => defaultPlan("keep-sunday-covered", FRI, zone, { sunday: "2026-11-22" });

const CEDAR: SystemConnection = { system: "b1", church_id: "CHU0000cedar", church_name: "Cedar Hollow Fellowship", address: "cedarhollow", service_id: "PLA0000nov22",
  service_day: "2026-11-22", service_name: "Sunday Gathering", zone: CT, result_seen: true };
function wired() {
  let now = "2026-11-20T15:00:04Z";
  let change: ((c: SystemCapture) => SystemCapture) | undefined;
  let fail: unknown = null;
  const clock = () => now;
  const store = memoryStore();
  const fake = fakeJobStore(clock);
  const gate = createJobsGate();
  const reads = vi.fn(async () => { if (fail !== null) throw fail; return b1At(now, "CHU0000cedar", change); });
  const watch: SystemWatch = { connection: CEDAR, read: reads };
  const regular = vi.fn(async () => {});
  const jobNotice = vi.fn(async () => {});
  const schedule = createSystemProactive({ store, now: clock, timeZone: () => ET, notify: regular,
    check: ctx => systemCheck(ctx, w => w.read()), timers: { setInterval: () => 0, clearInterval: () => {} } });
  const runner = createRunner({ native: fake.native, store, now: clock, notify: jobNotice });
  const context = (): ProactiveContext => ({ settings: { clientId: "", organization: "", serviceTypeId: "", planId: "" }, rules: RULES, status: null, system: watch, also: [] });
  schedule.start({
    context, onStatus: () => {},
    onCapture: c => { const j = systemJobCheck(c, CT); if (j) { runner.captured(j); gate.checked(c, CT); } },
    onFailure: e => gate.failed(CHURCH.cedar.church, e),
    onChanges: handChanges(runner),
  });
  runner.start({
    context: () => ({ ready: systemReady(watch) && !gate.blocked(CHURCH.cedar.church), granted: ["services"], rules: RULES, zone: CT, macZone: ET, quiet: DEFAULT_QUIET_HOURS,
      urgentWithinHours: 48, modelReady: false, system: "b1" }),
    check: async () => systemJobCheck(await schedule.checkNow("automatic"), CT)!,
    prepare: async () => null, belongs: c => c.organization === CHURCH.cedar.church,
  });
  runner.churchInUse(CHURCH.cedar);
  return { schedule, runner, fake, gate, reads, regular, jobNotice, set: (iso: string) => { now = iso; }, now: clock,
    changeTo: (f?: (c: SystemCapture) => SystemCapture) => { change = f; }, failWith: (e: unknown) => { fail = e; } };
}

describe("one notice through B1 Church's own schedule, and a key it refuses", () => {
  it("a change the schedule finds is handed to Keep services covered, which sends the one notice", async () => {
    const w = wired();
    await w.schedule.tick();
    await w.runner.create(keepPlan(CT));
    await w.runner.tick();
    expect(w.jobNotice).not.toHaveBeenCalled();
    w.changeTo(rowanDeclines);
    w.set("2026-11-20T16:10:00Z");
    await w.schedule.tick();
    await w.runner.tick();
    for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));
    expect(w.jobNotice.mock.calls).toEqual([["needs-decision"]]);
    expect(w.regular).not.toHaveBeenCalled();
    expect(w.schedule.view().history.find(e => e.kind === "changes")?.notice).toBe("responsibility");
  });

  it("a key refused mid-run holds the job back without using its checks, until a check reads B1 Church again", async () => {
    const w = wired();
    await w.schedule.tick();
    await w.runner.create(keepPlan(CT));
    await w.runner.tick();
    const begun = () => w.fake.calls.filter(c => c.startsWith("begin")).length;
    expect(begun()).toBe(1);
    // The key is revoked: the job's next run reads B1 Church and is refused.
    w.failWith(new SystemReadFailure("b1", "key-refused", "CHU0000cedar"));
    w.set("2026-11-20T18:00:30Z");
    await w.runner.tick();
    expect(begun()).toBe(2);
    const item = w.runner.view().noticed[0]!;
    expect(item).toMatchObject({ kind: "couldnt-check", read: "key-refused", system: "b1" });
    expect(w.gate.blocked(CHURCH.cedar.church)).toBe("key");
    // It waits: no more runs (and no checks used), however long the key stays refused.
    for (const at of ["2026-11-20T18:31:00Z", "2026-11-20T19:31:00Z", "2026-11-20T23:00:30Z", "2026-11-21T13:00:30Z"]) { w.set(at); await w.runner.tick(); }
    expect(begun()).toBe(2);
    // Connected again: the schedule's check reads B1 Church, and the job runs, saying what it missed and why.
    w.failWith(null);
    w.set("2026-11-21T14:00:00Z");
    await w.schedule.checkNow();
    await w.runner.tick();
    expect(begun()).toBe(3);
    const missed = w.runner.view().noticed.find(i => i.kind === "missed")!;
    expect(noticedTitle(missed, w.now())).toMatch(/^B1 Church couldn't be checked yet at .+, so Ozzie checked at .+ instead\.$/u);
  });

  it("a service with no roles holds jobs back too, until it has some", async () => {
    const w = wired();
    // The check Ozzie makes when it opens, then one of a service whose roles were all taken off.
    await w.schedule.checkNow();
    w.changeTo(c => ({ ...c, positions: [], assignments: [] }));
    w.set("2026-11-20T15:20:00Z");
    await w.schedule.checkNow();
    expect(w.gate.blocked(CHURCH.cedar.church)).toBe("no-roles");
    await w.runner.create(keepPlan(CT));
    await w.runner.tick();
    expect(w.fake.calls.filter(c => c.startsWith("begin"))).toEqual([]);
    w.changeTo(undefined);
    w.set("2026-11-20T16:10:00Z");
    await w.schedule.checkNow();
    expect(w.gate.blocked(CHURCH.cedar.church)).toBeNull();
    await w.runner.tick();
    expect(w.fake.calls.filter(c => c.startsWith("begin"))).toEqual(["begin start"]);
    expect(buildSystemBrief(b1Capture({ positions: [] }), { confirmedZone: CT }, FRI)).toMatchObject({ ok: false, reason: "no-roles" });
  });
});
