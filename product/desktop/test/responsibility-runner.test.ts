// Running what Ozzie keeps an eye on, with a fake native store, a fake clock and the fictional Sunday.
// Nothing native runs; no model and no Planning Center.
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => { throw new Error("NATIVE_CALL_FORBIDDEN"); }) }));
import { defaultPlan, MIN_GAP_MS, RETRY_MS, RUN_TIMEOUT_MS, TEMPLATES, type Plan, type Responsibility, type RunRow } from "../../../core/src/harness/responsibilities.js";
import { DEFAULT_QUIET_HOURS } from "../../../core/src/schedule.js";
import { nov22Capture } from "../../../core/src/fictional-sunday.js";
import { withFictionalOperations } from "../../../core/src/fictional-operations.js";
import type { SundayCapture } from "../../../core/src/sunday-capture.js";
import type { SundayChange } from "../../../core/src/sunday-changes.js";
import {
  createRunner, nativeResponsibilities, refusalOf, responsibilityStep, type Prepared, type ResponsibilityNative, type RunnerContext,
} from "../src/responsibility-runner.js";
import { noticedChanges, noticedTitle } from "../src/responsibility-words.js";
import { StepFailure } from "../src/harness-bridge.js";
import { fakeNative as fakeInvoke } from "./harness-fakes.js";

const ET = "America/New_York";
// Friday 20 November 2026, 10:00 in New York: two days before the fictional Sunday.
const FRI = "2026-11-20T15:00:00.000Z";
const names = nov22Capture().names;

type Row = { id: string; attributes: Record<string, unknown> };
const rows = (c: SundayCapture, collection: string) => c.reads.find(r => r.collection === collection)!.body!.data as Row[];
const decline = (c: SundayCapture) => {
  rows(c, "team_members").find(m => m.id === "401")!.attributes.status = "D";
  rows(c, "needed_positions").find(n => n.attributes.team_position_name === "Greeter")!.attributes.quantity = 2;
};
function captureAt(iso: string, change?: (c: SundayCapture) => void): SundayCapture {
  const c = withFictionalOperations(nov22Capture());
  change?.(c);
  const delta = Date.parse(iso) - Date.parse(c.completed_at);
  const shift = (t: string) => new Date(Date.parse(t) + delta).toISOString();
  return { ...c, started_at: shift(c.started_at), completed_at: shift(c.completed_at), reads: c.reads.map(r => ({ ...r, checked_at: shift(r.checked_at) })) };
}

/** The native store, faked with the rules the tests need: status, one per template, Pause everything, runs, the gap and busy. */
function fakeStore(clock: () => string) {
  const items: Responsibility[] = [];
  let pausedAll = false;
  let n = 0;
  const calls: string[] = [];
  /** `next`: refuse the next begin with this code; `always`: refuse every begin with it until cleared. */
  const refuse: { next: string | null; always: string | null } = { next: null, always: null };
  const id = (k: number) => `00000000-0000-4000-8000-${k.toString(16).padStart(12, "0")}`;
  const find = (rid: string) => { const r = items.find(x => x.id === rid); if (!r) throw "unknown"; return r; };
  const listing = () => {
    for (const r of items) if (r.lifetime.kind === "until" && clock() >= r.lifetime.ends_at) r.status = "ended";
    return { paused_all: pausedAll, items: structuredClone(items) };
  };
  const native: ResponsibilityNative = {
    list: async () => listing(),
    create: async plan => {
      if (items.some(x => x.template === plan.template && x.status !== "ended")) throw "exists";
      const t = TEMPLATES[plan.template];
      const r: Responsibility = { ...structuredClone(plan), id: id(++n), title: t.title, skill_id: t.skill_id, status: "active", created_at: clock(), confirmed_at: clock(), runs: [], open_run: null };
      items.push(r);
      calls.push(`create ${plan.template}`);
      return structuredClone(r);
    },
    edit: async (rid, plan) => { Object.assign(find(rid), structuredClone(plan)); return structuredClone(find(rid)); },
    pause: async rid => { find(rid).status = "paused"; calls.push("pause"); return structuredClone(find(rid)); },
    resume: async rid => { find(rid).status = "active"; return structuredClone(find(rid)); },
    stop: async rid => { find(rid).status = "ended"; return structuredClone(find(rid)); },
    pauseAll: async paused => { pausedAll = paused; calls.push(`pause-all ${paused}`); return listing(); },
    begin: async (rid, trigger) => {
      calls.push(`begin ${trigger}`);
      if (refuse.next) { const code = refuse.next; refuse.next = null; throw code; }
      if (refuse.always) throw refuse.always;
      if (pausedAll) throw "paused-all";
      const r = find(rid);
      if (r.status !== "active") throw r.status === "paused" ? "paused" : "ended";
      if (r.open_run) throw "busy";
      if (r.runs[0] && Date.parse(clock()) - Date.parse(r.runs[0].started_at) < MIN_GAP_MS) throw "too-soon";
      const run: RunRow = { run_id: id(1000 + ++n), trigger, started_at: clock(), ended_at: null, outcome: null, code: null, noticed: 0, drafts: 0, ai_steps: 0 };
      r.runs.unshift(run);
      r.open_run = run;
      return { run_id: run.run_id, ai_steps: 6, checks_left: 5 };
    },
    end: async (rid, runId, outcome, code, noticed, drafts) => {
      calls.push(`end ${outcome} ${code ?? "-"} ${noticed} ${drafts}`);
      const r = find(rid);
      const run = r.runs.find(x => x.run_id === runId && !x.ended_at);
      if (!run) throw "no-run";
      Object.assign(run, { ended_at: clock(), outcome, code, noticed, drafts });
      r.open_run = null;
      return structuredClone(r);
    },
  };
  return { native, calls, refuse, items, setPausedAll: (p: boolean) => { pausedAll = p; } };
}
/**
 * The native timer (always_on.rs Timer::next) WITHOUT its clamps, so these tests show the page alone never
 * asks for a busy loop: a due time at or before the clock wakes the page at once, and the clock moves 1 ms
 * per wake. Returns how many wakes happened (the review's probe found 744k in 200 ms).
 */
async function wakesFromTheNativeTimer(h: ReturnType<typeof setup>, limit = 1_000): Promise<number> {
  let wakes = 0;
  const started = Date.parse(h.now());
  for (;;) {
    const asked = h.nextDue.mock.calls.at(-1)?.[0] as string | null | undefined;
    if (!asked || Date.parse(asked) > Date.parse(h.now()) || wakes >= limit || Date.parse(h.now()) - started >= 200) return wakes;
    wakes++;
    h.set(new Date(Date.parse(h.now()) + 1).toISOString());
    await h.runner.tick();
  }
}
/** A check that waits until the test lets it finish. */
function heldCheck() {
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  return { gate, release: () => release() };
}
function memoryStore() {
  const data = new Map<string, string>();
  return { get: (k: string) => data.get(k) ?? null, set: (k: string, v: string) => { data.set(k, v); }, dump: () => [...data.values()].join("\n") };
}

function setup(over: Partial<RunnerContext> = {}) {
  let now = FRI;
  let change: ((c: SundayCapture) => void) | undefined;
  let fail: unknown = null;
  const clock = () => now;
  const store = memoryStore();
  const fake = fakeStore(clock);
  const notify = vi.fn(async () => {});
  const nextDue = vi.fn();
  const check = vi.fn(async () => { if (fail !== null) throw fail; return captureAt(now, change); });
  const prepare = vi.fn(async (): Promise<Prepared | null> => null);
  const context: RunnerContext = {
    ready: true, granted: ["services"], rules: { sundayLeads: [], checkInAfterSundaysInARow: 3 }, zone: ET, macZone: ET,
    quiet: DEFAULT_QUIET_HOURS, urgentWithinHours: 48, modelReady: false, ...over,
  };
  const lines: string[] = [];
  const runner = createRunner({ native: fake.native, store, now: clock, notify, nextDue, log: l => lines.push(l) });
  runner.start({ context: () => context, check, prepare });
  return {
    runner, fake, notify, nextDue, check, prepare, context, store, lines,
    now: () => now,
    set: (iso: string) => { now = iso; },
    changeTo: (f?: (c: SundayCapture) => void) => { change = f; },
    failWith: (e: unknown) => { fail = e; },
    /** Confirm a plan and let its first check finish. */
    start: async (plan: Plan) => { const r = await runner.create(plan); await runner.tick(); return r; },
  };
}
const sunday = () => defaultPlan("keep-sunday-covered", FRI, ET);
const at = (iso: string, minutes: number) => new Date(Date.parse(iso) + minutes * 60_000).toISOString();

describe("a responsibility, from confirmation to what Ozzie noticed", () => {
  it("checks once as soon as it starts, prepares the work, and tells the person in Ozzie, not with a notice", async () => {
    const h = setup();
    await h.start(sunday());
    expect(h.fake.calls).toEqual(["create keep-sunday-covered", "begin start", "end ok - 4 1"]);
    const item = h.runner.view().noticed[0]!;
    expect(item).toMatchObject({ kind: "found", trigger: "start", decisions: 2, looks: 2, drafts: 1, notice: "in-app" });
    expect(noticedTitle(item, FRI)).toBe("Keep Sunday covered: 2 things need a decision.");
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.check).toHaveBeenCalledTimes(1);
    expect(h.lines).toContain("responsibility: created template=keep-sunday-covered lifetime=until:2026-11-22");
    expect(h.lines).toContain("responsibility: run status=ok code=- noticed=4 drafts=1");
    // The native timer is asked to wake Ozzie for the next check: Friday 12:00 in New York.
    expect(h.nextDue).toHaveBeenLastCalledWith("2026-11-20T17:00:00.000Z");
  });

  it("runs on schedule and sends one discreet notice when something new needs a decision", async () => {
    const h = setup();
    await h.start(sunday());
    h.set("2026-11-20T17:00:00.000Z");
    h.changeTo(decline);
    await h.runner.tick();
    // After the decline the fixed data shows 2 decisions and 1 worth a look (one fewer than before).
    expect(h.fake.calls.slice(-2)).toEqual(["begin scheduled", "end ok - 3 1"]);
    expect(h.runner.view().noticed[0]).toMatchObject({ decisions: 2, looks: 1 });
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify).toHaveBeenCalledWith("needs-decision");
    const item = h.runner.view().noticed[0]!;
    expect(item.notice).toBe("sent");
    expect(noticedChanges(item, names)).toContain("Avery Brightwater declined Greeter after confirming.");
    // Nothing new at the next check: no notice.
    h.set("2026-11-20T22:00:00.000Z");
    await h.runner.tick();
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.runner.view().noticed[0]).toMatchObject({ kind: "found", notice: "none" });
  });

  it("a Mac that slept through three checks gets one catch-up run, reported plainly", async () => {
    const h = setup();
    await h.start(sunday());
    const woke = "2026-11-21T13:12:00.000Z";
    h.set(woke);
    h.runner.wake(Date.parse(woke) - Date.parse(at(FRI, 60)), woke);
    await h.runner.tick();
    expect(h.fake.calls.filter(c => c.startsWith("begin"))).toEqual(["begin start", "begin catch-up"]);
    const missed = h.runner.view().noticed.find(i => i.kind === "missed")!;
    expect(missed).toMatchObject({ missed_reason: "asleep", missed_count: 3, scheduled_for: "2026-11-20T17:00:00.000Z", ran_at: woke });
    expect(noticedTitle(missed, woke)).toMatch(/^Your Mac was asleep at .+ and 2 other times, so Ozzie checked at .+ instead\.$/u);
  });

  it("a check missed while Ozzie wasn't running is caught up on the next launch", async () => {
    const h = setup();
    await h.start(sunday());
    // Ozzie quits; it is opened again Saturday morning with the same saved state.
    const later = "2026-11-21T14:00:00.000Z";
    h.set(later);
    const again = createRunner({ native: h.fake.native, store: h.store, now: () => later, notify: h.notify });
    again.start({ context: () => h.context, check: h.check, prepare: h.prepare });
    await again.tick();
    expect(again.view().noticed.find(i => i.kind === "missed")).toMatchObject({ missed_reason: "closed", missed_count: 3 });
    expect(h.fake.calls.filter(c => c === "begin catch-up")).toHaveLength(1);
  });

  it("quiet hours hold the morning briefing's notice until they end, then open Today", async () => {
    const h = setup();
    await h.start({ ...defaultPlan("morning-briefing", FRI, ET), schedule: { time: "06:00", weekdays: [], on_change: false } });
    expect(h.runner.view().noticed[0]).toMatchObject({ kind: "briefing", notice: "in-app" });
    h.set("2026-11-21T11:00:00.000Z");
    await h.runner.tick();
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.runner.view().noticed[0]).toMatchObject({ kind: "briefing", trigger: "scheduled", notice: "held" });
    h.set("2026-11-21T11:31:00.000Z");
    await h.runner.tick();
    expect(h.notify).toHaveBeenCalledWith("briefing-ready");
    expect(h.runner.view().noticed[0]!.notice).toBe("sent-later");
    expect(h.runner.view().open_today).toBe(true);
    h.runner.clearOpenToday();
    expect(h.runner.view().open_today).toBe(false);
  });

  it("a check that couldn't finish says so once, and tries again an hour later", async () => {
    const h = setup();
    await h.start(sunday());
    h.set("2026-11-20T17:00:00.000Z");
    h.failWith("rate-limited");
    await h.runner.tick();
    const item = h.runner.view().noticed[0]!;
    expect(item).toMatchObject({ kind: "couldnt-check", code: "provider-failure", retry_at: "2026-11-20T18:00:00.000Z", notice: "sent" });
    expect(noticedTitle(item, "2026-11-20T17:00:00.000Z")).toMatch(/^Ozzie couldn't check Sunday at .+ — Planning Center didn't answer\. It will try again at .+\.$/u);
    expect(h.notify).toHaveBeenCalledWith("couldnt-check");
    expect(h.fake.calls.at(-1)).toBe("end failed provider-failure 0 0");
    h.set("2026-11-20T18:00:00.000Z");
    await h.runner.tick();
    expect(h.fake.calls.at(-2)).toBe("begin retry");
    expect(h.notify).toHaveBeenCalledTimes(1);
    h.failWith(null);
    h.set("2026-11-20T22:00:00.000Z");
    await h.runner.tick();
    expect(h.runner.view().noticed[0]!.kind).toBe("found");
  });

  it("never widens access: a room watch without Calendar access reports that instead of checking", async () => {
    const h = setup();
    await h.start(defaultPlan("watch-room-bookings", FRI, ET));
    expect(h.check).not.toHaveBeenCalled();
    const item = h.runner.view().noticed[0]!;
    expect(item).toMatchObject({ kind: "couldnt-check", code: "denied", access: true, retry_at: null });
    expect(noticedTitle(item, FRI)).toMatch(/this connection doesn't include what it needs\. Add access under Settings, then it can check\.$/u);
  });

  it("with Calendar access, a room watch reports overlaps, once", async () => {
    const h = setup({ granted: ["services", "operations"] });
    await h.start({ ...defaultPlan("watch-room-bookings", FRI, ET), report: "decisions-only" });
    expect(h.runner.view().noticed[0]).toMatchObject({ kind: "found", findings: { rooms: 1 } });
    expect(noticedTitle(h.runner.view().noticed[0]!, FRI)).toBe("Watch room bookings: 1 room booking overlap needs review.");
    // The same overlap a week later is not announced again.
    h.set("2026-11-26T14:00:00.000Z");
    await h.runner.tick();
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("does nothing while everything is paused, doesn't call those times missed, and reports a limit once", async () => {
    const h = setup();
    const r = await h.start(sunday());
    await h.runner.pauseAll(true);
    h.set("2026-11-20T17:00:00.000Z");
    await h.runner.tick();
    expect(h.fake.calls.filter(c => c.startsWith("begin"))).toEqual(["begin start"]);
    expect(h.nextDue).toHaveBeenLastCalledWith(null);
    h.set("2026-11-20T17:10:00.000Z");
    await h.runner.pauseAll(false);
    await h.runner.tick();
    // 12:00 passed while paused: not missed, not caught up.
    expect(h.fake.calls.filter(c => c.startsWith("begin"))).toEqual(["begin start"]);
    expect(h.runner.view().noticed.some(i => i.kind === "missed")).toBe(false);
    h.set("2026-11-20T22:00:00.000Z");
    h.fake.refuse.next = "checks-limit";
    await h.runner.tick();
    expect(h.runner.view().noticed[0]).toMatchObject({ kind: "limit", responsibility_id: r.id });
    expect(h.lines).toContain("responsibility: begin refused=checks-limit");
    expect(h.check).toHaveBeenCalledTimes(1);
  });

  it("waits while Planning Center isn't connected, then says why it checked late", async () => {
    const h = setup();
    await h.start(sunday());
    h.context.ready = false;
    h.set("2026-11-20T17:00:00.000Z");
    await h.runner.tick();
    expect(h.fake.calls.filter(c => c.startsWith("begin"))).toHaveLength(1);
    h.context.ready = true;
    h.set("2026-11-20T17:30:00.000Z");
    await h.runner.tick();
    expect(h.runner.view().noticed.find(i => i.kind === "missed")).toMatchObject({ missed_reason: "waiting" });
  });

  it("a relevant change brings a check sooner, not more than every half hour", async () => {
    const h = setup();
    await h.start(sunday());
    const worse: SundayChange = { id: "need-opened:x", kind: "need-opened", effect: "worse", urgency: "attention", position: "Greeter", from: 0, to: 1 };
    h.set(at(FRI, 10));
    await h.runner.changes([worse]);
    expect(h.fake.calls.filter(c => c.startsWith("begin"))).toEqual(["begin start"]);
    h.set(at(FRI, 45));
    await h.runner.changes([worse]);
    expect(h.fake.calls.filter(c => c.startsWith("begin"))).toEqual(["begin start", "begin change"]);
  });

  it("with an AI model, keeps the prepared summary in memory only; storage stays name-free", async () => {
    const h = setup({ modelReady: true });
    h.prepare.mockResolvedValue({ status: "verified", code: null, summary: "Avery Brightwater declined Greeter.", draft: "Hi Avery, could you help?", ai_steps: 2 });
    await h.start(sunday());
    const item = h.runner.view().noticed[0]!;
    expect(item).toMatchObject({ summarized: true, drafts: 2 });
    expect(h.runner.view().prepared[item.id]).toEqual({ summary: "Avery Brightwater declined Greeter.", draft: "Hi Avery, could you help?" });
    expect(h.prepare).toHaveBeenCalledTimes(1);
    const stored = h.store.dump();
    for (const name of Object.values(names)) for (const part of name.split(" ")) expect(stored).not.toContain(part);
  });

  it("says once when a dated responsibility ends as planned", async () => {
    const h = setup();
    await h.start(sunday());
    // Every check through Sunday runs on time.
    for (const slot of ["2026-11-20T17:00:00.000Z", "2026-11-20T22:00:00.000Z", "2026-11-21T12:00:00.000Z", "2026-11-21T17:00:00.000Z", "2026-11-21T22:00:00.000Z", "2026-11-22T12:00:00.000Z"]) {
      h.set(slot);
      await h.runner.tick();
    }
    expect(h.fake.calls.filter(c => c.startsWith("begin"))).toHaveLength(7);
    h.set("2026-11-23T05:00:00.000Z");
    await h.runner.tick();
    await h.runner.tick();
    const ended = h.runner.view().noticed.filter(i => i.kind === "ended");
    expect(ended).toHaveLength(1);
    expect(h.runner.view().noticed.some(i => i.kind === "missed")).toBe(false);
    expect(noticedTitle(ended[0]!)).toBe("Keep Sunday covered ended after Sunday, November 22, as planned. Anything still open is on the Sunday page.");
  });

  it("before saying it ended, says which checks it missed, and doesn't call that “as planned”", async () => {
    const h = setup();
    await h.start(sunday());
    for (const slot of ["2026-11-20T17:00:00.000Z", "2026-11-20T22:00:00.000Z", "2026-11-21T12:00:00.000Z", "2026-11-21T17:00:00.000Z"]) {
      h.set(slot);
      await h.runner.tick();
    }
    // Ozzie isn't running from Saturday afternoon until Monday: 5:00 PM Saturday and 7:00 AM Sunday pass.
    const monday = "2026-11-23T14:00:00.000Z";
    h.set(monday);
    const again = createRunner({ native: h.fake.native, store: h.store, now: () => monday, notify: h.notify });
    again.start({ context: () => h.context, check: h.check, prepare: h.prepare });
    await again.tick();
    const [ended, missed] = again.view().noticed;
    expect(missed).toMatchObject({ kind: "missed", before_end: true, missed_count: 2, scheduled_for: "2026-11-21T22:00:00.000Z", missed_reason: "closed" });
    expect(missed!.ran_at).toBeUndefined();
    expect(noticedTitle(missed!, monday)).toMatch(/^Ozzie wasn't running at .+ and 1 other time, and Keep Sunday covered ended before it could check again\.$/u);
    expect(ended).toMatchObject({ kind: "ended", missed_count: 2 });
    expect(noticedTitle(ended!)).toBe("Keep Sunday covered ended after Sunday, November 22. Anything still open is on the Sunday page.");
    // Nothing ran after the end.
    expect(h.fake.calls.filter(c => c.startsWith("begin"))).toEqual(["begin start", ...Array(4).fill("begin scheduled")]);
  });

  it("a responsibility a person stopped never says it ended as planned", async () => {
    const h = setup();
    const r = await h.start(sunday());
    await h.runner.stop(r.id);
    h.set("2026-11-23T05:00:00.000Z");
    await h.runner.tick();
    expect(h.runner.view().noticed.filter(i => i.kind === "ended" || i.kind === "missed")).toEqual([]);
  });

  it("seeing it in Ozzie counts as being told", async () => {
    const h = setup();
    await h.start(sunday());
    h.set("2026-11-20T17:00:00.000Z");
    h.changeTo(decline);
    await h.runner.tick();
    expect(h.runner.view().unseen).toBeGreaterThan(0);
    h.runner.markSeen();
    expect(h.runner.view().unseen).toBe(0);
  });
});

describe("something due that can't run never asks to be woken now (no busy loop)", () => {
  it("waiting for Planning Center: the regular tick covers it", async () => {
    const h = setup();
    const r = await h.start(sunday());
    h.context.ready = false;
    h.set("2026-11-20T17:00:00.000Z");
    await h.runner.tick();
    expect(await wakesFromTheNativeTimer(h)).toBe(0);
    expect(h.runner.view().next[r.id]).toBeNull();
    expect(h.fake.calls.filter(c => c.startsWith("begin"))).toHaveLength(1);
  });

  it("too soon after the last run: asks again when the store's gap is over", async () => {
    const h = setup();
    h.set("2026-11-20T16:58:00.000Z");
    await h.start(sunday());
    h.set("2026-11-20T17:00:00.000Z");
    await h.runner.tick();
    expect(h.lines).toContain("responsibility: begin refused=too-soon");
    expect(await wakesFromTheNativeTimer(h)).toBe(0);
    expect(h.nextDue).toHaveBeenLastCalledWith(at("2026-11-20T16:58:00.000Z", MIN_GAP_MS / 60_000));
    // Nothing asks the store again before then, however often the page is woken.
    await h.runner.tick();
    expect(h.fake.calls.filter(c => c === "begin scheduled")).toHaveLength(1);
    h.set("2026-11-20T17:03:00.000Z");
    await h.runner.tick();
    expect(h.fake.calls.filter(c => c === "begin scheduled")).toHaveLength(2);
    expect(h.runner.view().noticed[0]).toMatchObject({ kind: "found", trigger: "scheduled" });
  });

  it("a run still open (from before a restart): asks again when the store closes it", async () => {
    const h = setup();
    const r = await h.start(sunday());
    h.set("2026-11-20T16:55:00.000Z");
    await h.fake.native.begin(r.id, "manual");
    h.set("2026-11-20T17:00:00.000Z");
    await h.runner.tick();
    expect(h.lines).toContain("responsibility: begin refused=busy");
    expect(await wakesFromTheNativeTimer(h)).toBe(0);
    expect(h.nextDue).toHaveBeenLastCalledWith(at("2026-11-20T16:55:00.000Z", RUN_TIMEOUT_MS / 60_000));
  });

  it("a store that couldn't be read says Ozzie couldn't check, and tries again an hour later", async () => {
    const h = setup();
    h.fake.refuse.always = "unavailable";
    await h.start(sunday());
    const item = h.runner.view().noticed[0]!;
    expect(item).toMatchObject({ kind: "couldnt-check", code: "unavailable", retry_at: at(FRI, RETRY_MS / 60_000), notice: "in-app" });
    expect(noticedTitle(item, FRI)).toMatch(/^Ozzie couldn't check Sunday at .+ — its list of what to keep an eye on couldn't be read on this Mac\. It will try again at .+\.$/u);
    expect(await wakesFromTheNativeTimer(h)).toBe(0);
    h.fake.refuse.always = null;
    h.set(at(FRI, RETRY_MS / 60_000));
    await h.runner.tick();
    expect(h.fake.calls.filter(c => c.startsWith("begin"))).toEqual(["begin start", "begin start"]);
    expect(h.runner.view().noticed[0]).toMatchObject({ kind: "found" });
  });
});

describe("sharing one Planning Center check", () => {
  const briefingAtNoon = () => ({ ...defaultPlan("morning-briefing", FRI, ET), schedule: { time: "12:00", weekdays: [], on_change: false } });
  it("runs due together share one check, and one the app just made", async () => {
    const h = setup();
    await h.start(sunday());
    await h.start(briefingAtNoon());
    expect(h.check).toHaveBeenCalledTimes(1);
    h.set("2026-11-20T17:00:00.000Z");
    await h.runner.tick();
    expect(h.fake.calls.filter(c => c === "begin scheduled")).toHaveLength(2);
    expect(h.check).toHaveBeenCalledTimes(2);
    // The regular Sunday check just read Planning Center; a change it found brings a run that uses the same check.
    h.set("2026-11-20T17:40:00.000Z");
    h.runner.captured(captureAt(h.now(), decline));
    await h.runner.changes([{ id: "x", kind: "need-opened", effect: "worse", urgency: "attention", position: "Greeter", from: 0, to: 1 }]);
    expect(h.fake.calls.at(-2)).toBe("begin change");
    expect(h.check).toHaveBeenCalledTimes(2);
    // Check now always reads again.
    h.set("2026-11-20T17:41:00.000Z");
    h.fake.items.forEach(r => { r.runs = r.runs.map(x => ({ ...x, started_at: at(FRI, -60) })); });
    await h.runner.runNow(h.fake.items[0]!.id);
    expect(h.check).toHaveBeenCalledTimes(3);
  });

  it("after Planning Center asks Ozzie to slow down, no new check starts until that's over", async () => {
    const h = setup();
    await h.start(sunday());
    await h.start(briefingAtNoon());
    h.set("2026-11-20T17:00:00.000Z");
    h.failWith({ "sunday-check": "rate-limited" });
    await h.runner.tick();
    // The first run couldn't finish; the second didn't start a check of its own.
    expect(h.fake.calls.filter(c => c === "begin scheduled")).toHaveLength(1);
    expect(h.check).toHaveBeenCalledTimes(2);
    expect(await wakesFromTheNativeTimer(h)).toBe(0);
    expect(h.nextDue).toHaveBeenLastCalledWith("2026-11-20T17:05:00.000Z");
    h.failWith(null);
    h.set("2026-11-20T17:05:00.000Z");
    await h.runner.tick();
    expect(h.fake.calls.filter(c => c === "begin scheduled")).toHaveLength(2);
    expect(h.check).toHaveBeenCalledTimes(3);
    // A check that came back with a rate-limited read slows the next new check down the same way.
    h.set("2026-11-20T17:30:00.000Z");
    const limited = captureAt(h.now());
    h.runner.captured({ ...limited, reads: limited.reads.map(r => ({ ...r, outcome: "rate-limited" })) });
    const worse: SundayChange = { id: "y", kind: "need-opened", effect: "worse", urgency: "attention", position: "Greeter", from: 0, to: 1 };
    h.set("2026-11-20T17:33:00.000Z");
    await h.runner.changes([worse]);
    expect(h.fake.calls).not.toContain("begin change");
    expect(h.check).toHaveBeenCalledTimes(3);
    h.set("2026-11-20T17:36:00.000Z");
    await h.runner.changes([worse]);
    expect(h.fake.calls).toContain("begin change");
    expect(h.check).toHaveBeenCalledTimes(4);
  });
});

describe("pausing", () => {
  it("Pause everything takes effect at once: the running run ends as cancelled, quietly", async () => {
    const h = setup();
    await h.start(sunday());
    const held = heldCheck();
    h.check.mockImplementationOnce(async () => { await held.gate; return captureAt(h.now()); });
    h.set("2026-11-20T17:00:00.000Z");
    const ticking = h.runner.tick();
    await vi.waitFor(() => expect(h.runner.view().running).not.toBeNull());
    // Resolves while the check is still out: it doesn't wait for the run.
    await h.runner.pauseAll(true);
    await ticking;
    expect(h.fake.calls.slice(-2)).toEqual(["pause-all true", "end failed cancelled 0 0"]);
    expect(h.runner.view().running).toBeNull();
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.runner.view().noticed.some(i => i.kind === "couldnt-check")).toBe(false);
    held.release();
  });

  it("from the menu bar too: the running run stops as soon as the page hears", async () => {
    const h = setup();
    const r = await h.start(sunday());
    const held = heldCheck();
    h.check.mockImplementationOnce(async () => { await held.gate; return captureAt(h.now()); });
    h.set("2026-11-20T17:00:00.000Z");
    const ticking = h.runner.tick();
    await vi.waitFor(() => expect(h.runner.view().running).toBe(r.id));
    h.fake.setPausedAll(true);
    await h.runner.pausedElsewhere(true);
    await ticking;
    expect(h.fake.calls.at(-1)).toBe("end failed cancelled 0 0");
    expect(h.runner.view().paused_all).toBe(true);
    held.release();
  });

  it("checks the store again just before a notice: paused meanwhile, nothing is sent", async () => {
    const h = setup();
    await h.start(sunday());
    const held = heldCheck();
    h.check.mockImplementationOnce(async () => { await held.gate; return captureAt(h.now(), decline); });
    h.set("2026-11-20T17:00:00.000Z");
    const ticking = h.runner.tick();
    await vi.waitFor(() => expect(h.check).toHaveBeenCalledTimes(2));
    // Paused from the menu bar; the page hasn't heard yet.
    h.fake.setPausedAll(true);
    held.release();
    await ticking;
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.runner.view().noticed[0]).toMatchObject({ kind: "found", notice: "none" });
  });

  it("drops a notice held for quiet hours, as the regular Sunday check's pause does", async () => {
    const h = setup();
    await h.start({ ...defaultPlan("morning-briefing", FRI, ET), schedule: { time: "06:00", weekdays: [], on_change: false } });
    h.set("2026-11-21T11:00:00.000Z");
    await h.runner.tick();
    expect(h.runner.view().noticed[0]).toMatchObject({ kind: "briefing", notice: "held" });
    await h.runner.pauseAll(true);
    expect(h.runner.view().noticed[0]!.notice).toBe("none");
    await h.runner.pauseAll(false);
    h.set("2026-11-21T11:31:00.000Z");
    await h.runner.tick();
    expect(h.notify).not.toHaveBeenCalled();
  });
});

describe("whose clock", () => {
  it("each responsibility keeps the zone it was confirmed in; one from before zones were kept keeps the zone at launch", async () => {
    const h = setup();
    await h.start(defaultPlan("keep-sunday-covered", FRI, "America/Chicago"));
    // Friday 12:00 in Chicago, not in New York.
    expect(h.nextDue).toHaveBeenLastCalledWith("2026-11-20T18:00:00.000Z");
    h.fake.items[0]!.zone = null;
    // The church's zone becomes known mid-session; the zone-less one stays on the zone it had at launch.
    h.context.zone = "America/Los_Angeles";
    await h.runner.refresh();
    expect(h.nextDue).toHaveBeenLastCalledWith("2026-11-20T17:00:00.000Z");
  });
});

describe("a run the store closed as interrupted", () => {
  it("says Ozzie couldn't check, once, and tries again later", async () => {
    const h = setup();
    await h.start(sunday());
    // As if Ozzie had closed while it ran: the store closed it as interrupted.
    Object.assign(h.fake.items[0]!.runs[0]!, { outcome: "interrupted", code: "interrupted", ended_at: at(FRI, 10) });
    h.set(at(FRI, 15));
    await h.runner.tick();
    await h.runner.tick();
    const items = h.runner.view().noticed.filter(i => i.code === "interrupted");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "couldnt-check", retry_at: at(FRI, 75), scheduled_for: FRI });
    expect(noticedTitle(items[0]!, FRI)).toMatch(/— it was cut off before it finished\. It will try again at .+\.$/u);
    h.set(at(FRI, 75));
    await h.runner.tick();
    expect(h.fake.calls.filter(c => c.startsWith("begin")).at(-1)).toBe("begin retry");
  });
});

describe("the native bridge", () => {
  it("sends only a plan's fixed fields and reads refusals as closed codes", async () => {
    const { invoke, log } = fakeInvoke(() => ({ paused_all: false, items: [] }));
    const native = nativeResponsibilities(invoke);
    await native.create({ ...sunday(), note: "Avery" } as unknown as Plan);
    await native.begin("id", "catch-up");
    await native.end("id", "run", "failed", "provider-failure", 0, 0);
    expect(log.map(([c]) => c)).toEqual(["responsibility_create", "responsibility_run_begin", "responsibility_run_end"]);
    expect(Object.keys(log[0]![1].plan as object).sort()).toEqual(["lifetime", "limits", "report", "schedule", "template", "zone"]);
    expect(log[2]![1]).toEqual({ id: "id", runId: "run", outcome: "failed", code: "provider-failure", noticed: 0, drafts: 0 });
    expect(refusalOf("too-soon")).toBe("too-soon");
    expect(refusalOf("Planning Center said no")).toBe("unavailable");
  });

  it("pays each AI step from the run's grant, through responsibility_agent_step", async () => {
    const { invoke, log } = fakeInvoke(command => { if (command === "responsibility_agent_step") throw "limit"; });
    const step = responsibilityStep("run-1", invoke);
    const request = { task_id: "t", messages: [], tools: [], max_tokens: 10 };
    await expect(step(request, new AbortController().signal)).rejects.toMatchObject({ code: "limit" });
    expect(log).toEqual([["responsibility_agent_step", { runId: "run-1", request }]]);
    await expect(step(request, AbortSignal.abort())).rejects.toBeInstanceOf(StepFailure);
  });
});
