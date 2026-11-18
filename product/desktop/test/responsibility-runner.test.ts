// Running what Ozzie keeps an eye on, with a fake native store, a fake clock and the fictional Sunday.
// Nothing native runs; no model and no Planning Center.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => { throw new Error("NATIVE_CALL_FORBIDDEN"); }) }));
import { defaultPlan, MIN_GAP_MS, RETRY_MS, RUN_TIMEOUT_MS, TEMPLATES, type Plan, type Responsibility, type RunRow, untilLifetime } from "../../../core/src/harness/responsibilities.js";
import { DEFAULT_QUIET_HOURS } from "../../../core/src/schedule.js";
import { nov22Capture } from "../../../core/src/fictional-sunday.js";
import { FICTIONAL_ROOM, withFictionalOperations } from "../../../core/src/fictional-operations.js";
import type { SundayCapture } from "../../../core/src/sunday-capture.js";
import type { SundayChange } from "../../../core/src/sunday-changes.js";
import type { FeedbackEntry } from "../../../core/src/finding-feedback.js";
import {
  allowanceSpent, createRunner, handChanges, nativeResponsibilities, refusalOf, responsibilityStep, WRITEUPS_KEPT_PER_JOB, type Prepared, type ResponsibilityNative, type RunnerContext,
} from "../src/responsibility-runner.js";
import { keptLines, noticedBadge, noticedChanges, noticedTitle } from "../src/responsibility-words.js";
import { StepFailure, StepNotes } from "../src/harness-bridge.js";
import { createProactive } from "../src/proactive.js";
import { sundayProblem } from "../src/sunday-source.js";
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
  // App names the church in use as soon as it knows it; until then no write-up is shown (review H, L9).
  runner.keepWriteupsFor(nov22Capture().organization);
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
/** A write-up as App's prepare hook returns it: Ozzie's sentences with people as id tokens (core session.ts keep). */
const WRITTEN: Prepared = {
  status: "verified", code: null, ai_steps: 2,
  writeup: {
    lines: ["For Sunday 2026-11-22, this check found 2 items that need a decision and 2 worth a look.", "{{person:501}} has no overlap found for Greeter."],
    based_on: "Based on: Planning Center Services, checked Fri, Nov 20, 10:00 AM", gaps: [],
    steps: ["Looked at this Sunday's overview — complete", "Checked the facts it chose against what was read"],
  },
};
/** Keep Sunday covered with "Only until this Sunday" chosen (its default is every week until stopped: audit item 23). */
const sunday = () => ({ ...defaultPlan("keep-sunday-covered", FRI, ET), lifetime: untilLifetime("2026-11-22", ET)! });
const at = (iso: string, minutes: number) => new Date(Date.parse(iso) + minutes * 60_000).toISOString();

describe("a check of a church Ozzie no longer uses (review S2, L1)", () => {
  it("is never shared with a run, and one that finishes after a switch isn't acted on", async () => {
    const h = setup();
    let church = nov22Capture().organization;
    h.runner.start({ context: () => h.context, check: h.check, prepare: h.prepare, belongs: c => c.organization === church });
    await h.start(sunday());
    expect(h.check).toHaveBeenCalledTimes(1);
    // The regular Sunday check finished just before the switch; the runner would share it for two minutes.
    h.set("2026-11-20T17:40:00.000Z");
    h.runner.captured(captureAt(h.now(), decline));
    church = "fictional-other-church";
    await h.runner.changes([{ id: "x", kind: "need-opened", effect: "worse", urgency: "attention", position: "Greeter", from: 0, to: 1 }]);
    // Not shared: a fresh check ran, and it too was of the old church (finished after the switch), so the run failed
    // as "couldn't check" rather than reporting the old church's Sunday.
    expect(h.check).toHaveBeenCalledTimes(2);
    expect(h.fake.calls.at(-1)).toMatch(/^end failed denied/u);
    expect(h.runner.view().noticed[0]).toMatchObject({ kind: "couldnt-check" });
  });
});

describe("a responsibility, from confirmation to what Ozzie noticed", () => {
  it("checks once as soon as it starts, prepares the work, and tells the person in Ozzie, not with a notice", async () => {
    const h = setup();
    await h.start(sunday());
    expect(h.fake.calls).toEqual(["create keep-sunday-covered", "begin start", "end ok - 4 1"]);
    const item = h.runner.view().noticed[0]!;
    expect(item).toMatchObject({ kind: "found", trigger: "start", decisions: 2, looks: 2, drafts: 1, notice: "in-app" });
    // Which run and which check it came from (ids and a time only), so Today can tell it is about the Sunday on screen.
    expect(item.run_id).toBe(h.runner.view().items[0]!.runs[0]!.run_id);
    expect(item.check).toEqual({ plan_id: nov22Capture().plan_id, completed_at: FRI });
    // A write-up is kept apart from the item (writeups), so the item never says whether one was written.
    expect(item).not.toHaveProperty("drafted");
    expect(item).not.toHaveProperty("summarized");
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
    // Quiet hours end at 7:00 AM (owner decision, October 26): 6:59 still holds it.
    h.set("2026-11-21T11:59:00.000Z");
    await h.runner.tick();
    expect(h.notify).not.toHaveBeenCalled();
    h.set("2026-11-21T12:01:00.000Z");
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

  it("with Calendar access, a room watch reports overlaps, once, as the Sunday page labels them", async () => {
    const h = setup({ granted: ["services", "operations"] });
    await h.start({ ...defaultPlan("watch-room-bookings", FRI, ET), report: "decisions-only" });
    // No room rule says the room can't be shared: the overlap is Worth a look, as on the Sunday page.
    expect(h.runner.view().noticed[0]).toMatchObject({ kind: "found", decisions: 0, findings: { rooms_uncertain: 1 } });
    expect(h.runner.view().noticed[0]!.findings!.rooms).toBeUndefined();
    expect(noticedTitle(h.runner.view().noticed[0]!, FRI)).toBe("Watch room bookings: 1 room booking overlap is worth a look.");
    expect(noticedBadge(h.runner.view().noticed[0]!)).toEqual({ label: "Worth a look", tone: "look" });
    // The same overlap a week later is not announced again.
    h.set("2026-11-26T14:00:00.000Z");
    await h.runner.tick();
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("a room rule that confirms the overlap makes it Needs a decision, as on the Sunday page", async () => {
    const h = setup({ granted: ["services", "operations"], rules: { sundayLeads: [], checkInAfterSundaysInARow: 3, rooms: [{ room_id: FICTIONAL_ROOM, exclusive: true, setup_minutes: 30 }] } });
    await h.start({ ...defaultPlan("watch-room-bookings", FRI, ET), report: "decisions-only" });
    const item = h.runner.view().noticed[0]!;
    expect(item).toMatchObject({ kind: "found", findings: { rooms: 1 } });
    expect(noticedTitle(item, FRI)).toBe("Watch room bookings: 1 room booking overlap needs review.");
    expect(noticedBadge(item)).toEqual({ label: "Needs a decision", tone: "attn" });
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

  it("with an AI model, keeps the write-up with its run on this Mac, name-free, and shows it again after a restart", async () => {
    const h = setup({ modelReady: true });
    h.prepare.mockResolvedValue(WRITTEN);
    await h.start(sunday());
    const item = h.runner.view().noticed[0]!;
    const run = h.runner.view().items[0]!.runs[0]!;
    expect(h.runner.view().writeups[item.id]).toEqual({
      item: item.id, responsibility_id: item.responsibility_id, run_id: run.run_id, organization: nov22Capture().organization, at: item.at, kind: "written", ...WRITTEN.writeup, ai_steps: 2,
    });
    expect(h.prepare).toHaveBeenCalledTimes(1);
    const stored = h.store.dump();
    for (const name of Object.values(names)) for (const part of name.split(" ")) expect(stored).not.toContain(part);
    expect(stored).toContain("{{person:501}}");
    // Quit and open again: the write-up is still with its run.
    const again = createRunner({ native: h.fake.native, store: h.store, now: h.now, notify: h.notify });
    // Nothing shows until the church in use is known (review H, L9); then its write-ups do.
    expect(again.view().writeups).toEqual({});
    again.keepWriteupsFor(nov22Capture().organization);
    expect(again.view().writeups[item.id]?.lines).toEqual(WRITTEN.writeup!.lines);
    // Deleting saved checks or disconnecting Planning Center forgets them all (review H, M4).
    again.forgetAllWriteups();
    expect(again.view().writeups).toEqual({});
    expect(h.store.get("ozzie.responsibilities.writeups.v1")).toBe(JSON.stringify({ version: 1, items: [] }));
  });

  it("says why there is no write-up when AI help is set up, never a blank; with no AI route, keeps nothing (review H, L15)", async () => {
    const off = setup();
    await off.start(sunday());
    expect(Object.values(off.runner.view().writeups)).toEqual([]);
    expect(off.prepare).not.toHaveBeenCalled();
    const spent = setup({ modelReady: true });
    spent.fake.native.begin = (b => async (rid, trigger) => ({ ...await b(rid, trigger), ai_steps: 0 }))(spent.fake.native.begin);
    await spent.start(sunday());
    expect(Object.values(spent.runner.view().writeups)).toEqual([expect.objectContaining({ kind: "none", why: "spent" })]);
    expect(spent.prepare).not.toHaveBeenCalled();
    // A "limit" is the allowance only when native said so; otherwise it is the run's own (review G).
    for (const [code, why, allowance, noCredit] of [["fidelity", "unverified", false, false], ["limit", "run-limit", false, false], ["limit", "spent", true, false],
      ["transport", "unavailable", false, false], ["egress", "unavailable", false, false],
      // Review F5: the AI company's account out of credit is its own case, never "ran past what one run may use".
      ["limit", "no-credit", false, true]] as const) {
      const h = setup({ modelReady: true });
      h.prepare.mockResolvedValue({ status: "failed", code, writeup: null, ai_steps: 1, ...(allowance ? { allowance } : {}), ...(noCredit ? { noCredit } : {}) });
      await h.start(sunday());
      expect(Object.values(h.runner.view().writeups), code).toEqual([expect.objectContaining({ kind: "none", why })]);
      expect(Object.values(h.runner.view().writeups)[0]!.lines).toBeUndefined();
    }
    // A write-up that came back without passing its checks is never kept as written (review H, M18).
    const unchecked = setup({ modelReady: true });
    unchecked.prepare.mockResolvedValue({ ...WRITTEN, status: "failed", code: "fidelity" });
    await unchecked.start(sunday());
    expect(Object.values(unchecked.runner.view().writeups)).toEqual([expect.objectContaining({ kind: "none", why: "unverified" })]);
    const thrown = setup({ modelReady: true });
    thrown.prepare.mockRejectedValue(new Error("boom"));
    await thrown.start(sunday());
    expect(Object.values(thrown.runner.view().writeups)).toEqual([expect.objectContaining({ kind: "none", why: "unavailable" })]);
  });

  it("decides nothing: the run's findings, notices and stored run rows are byte-identical with and without a write-up", async () => {
    // The same day three ways: no AI, a write-up, and a write-up that didn't check out.
    const day = async (h: ReturnType<typeof setup>) => {
      await h.start(sunday());
      h.set("2026-11-20T17:00:00.000Z");
      h.changeTo(decline);
      await h.runner.tick();
      h.set("2026-11-21T04:00:00.000Z");
      await h.runner.tick();
      h.set("2026-11-21T12:01:00.000Z");
      await h.runner.tick();
      const view = h.runner.view();
      return JSON.stringify({
        calls: h.fake.calls, notified: h.notify.mock.calls, noticed: view.noticed, runs: view.items.map(r => r.runs),
        stored: ["ozzie.responsibilities.state.v1", "ozzie.responsibilities.noticed.v1", "ozzie.responsibilities.held.v1"].map(k => h.store.get(k)),
      });
    };
    const plain = setup();
    const written = setup({ modelReady: true });
    written.prepare.mockResolvedValue(WRITTEN);
    const failed = setup({ modelReady: true });
    failed.prepare.mockResolvedValue({ status: "failed", code: "fidelity", writeup: null, ai_steps: 2 });
    const [a, b, c] = [await day(plain), await day(written), await day(failed)];
    const runs = written.fake.calls.filter(x => x.startsWith("end ok")).length;
    expect(runs).toBeGreaterThanOrEqual(3);
    expect(written.prepare).toHaveBeenCalledTimes(runs);
    expect(Object.values(written.runner.view().writeups).filter(w => w.kind === "written")).toHaveLength(runs);
    expect(Object.values(failed.runner.view().writeups).every(w => w.kind === "none" && w.why === "unverified")).toBe(true);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it("forgets a write-up still being prepared when every write-up is forgotten, Ozzie switches church, or its job is stopped (review G, N2)", async () => {
    for (const how of ["forget", "switch", "stop", "neither"] as const) {
      const h = setup({ modelReady: true });
      let release: (p: Prepared) => void = () => {};
      const r = await h.start(sunday());
      h.prepare.mockImplementation(() => new Promise<Prepared>(resolve => { release = resolve; }));
      h.set(at(FRI, 31));
      const running = h.runner.runNow(r.id);
      // The start run asked first; this run's write-up is the second.
      await vi.waitFor(() => expect(h.prepare).toHaveBeenCalledTimes(2));
      // Saved checks deleted or Planning Center disconnected (or the job stopped) while the AI is still writing.
      if (how === "forget") h.runner.forgetAllWriteups();
      if (how === "switch") h.runner.keepWriteupsFor("fictional-other-church");
      // Stopping waits for the run it stops, so it is let go of here and awaited once the write-up has come back.
      const stopping = how === "stop" ? h.runner.stop(r.id) : null;
      await new Promise(resolve => setTimeout(resolve, 0));
      release(WRITTEN);
      await running;
      await stopping;
      const kept = Object.values(h.runner.view().writeups);
      expect(kept.filter(w => w.kind === "written"), how).toHaveLength(how === "neither" ? 1 : 0);
      expect(h.store.get("ozzie.responsibilities.writeups.v1")!.includes("{{person:501}}"), how).toBe(how === "neither");
    }
    // One started after the forget is kept as usual.
    const h = setup({ modelReady: true });
    h.prepare.mockResolvedValue(WRITTEN);
    const r = await h.start(sunday());
    h.runner.forgetAllWriteups();
    h.set(at(FRI, 31));
    await h.runner.runNow(r.id);
    expect(Object.values(h.runner.view().writeups).filter(w => w.kind === "written")).toHaveLength(1);
  });

  it("forgets the write-up of a run that was still reading Planning Center when every write-up was forgotten (review K, L3)", async () => {
    for (const how of ["forget", "switch", "neither"] as const) {
      const h = setup({ modelReady: true });
      h.prepare.mockResolvedValue(WRITTEN);
      const r = await h.start(sunday());
      h.runner.forgetAllWriteups();
      const read = heldCheck();
      h.check.mockImplementationOnce(async () => { await read.gate; return captureAt(h.now()); });
      h.set(at(FRI, 31));
      const running = h.runner.runNow(r.id);
      await vi.waitFor(() => expect(h.check).toHaveBeenCalledTimes(2));
      // Disconnected (or switched church and back) while the run's check is still reading, before any write-up is asked for.
      if (how === "forget") h.runner.forgetAllWriteups();
      if (how === "switch") { h.runner.keepWriteupsFor("fictional-other-church"); h.runner.keepWriteupsFor(nov22Capture().organization); }
      read.release();
      await running;
      // The write-up was still asked for: only keeping it depends on when the run started.
      expect(h.prepare, how).toHaveBeenCalledTimes(2);
      expect(Object.values(h.runner.view().writeups).filter(w => w.kind === "written"), how).toHaveLength(how === "neither" ? 1 : 0);
      expect(h.store.get("ozzie.responsibilities.writeups.v1")!.includes("{{person:501}}"), how).toBe(how === "neither");
    }
  });

  it("notes the native code a job's AI step was refused with, so a spent allowance is told apart from the run's own limit (review G)", async () => {
    const notes = new StepNotes();
    const step = responsibilityStep("run-1", async () => { throw "daily-limit"; }, notes);
    await expect(step({ task_id: "task-1" } as never, new AbortController().signal)).rejects.toMatchObject({ code: "limit" });
    expect(notes.take("task-1")).toBe("daily-limit");
    // App's prepare hook passes this on: the allowance codes, and only those.
    // The own key's month (contract N5 month-limit) is a spent allowance too, never "couldn't be reached".
    expect(["budget", "daily-limit", "allowance-paused", "month-limit"].every(allowanceSpent)).toBe(true);
    expect(["limit", "egress", "provider-failure", "no-credit", undefined].some(allowanceSpent)).toBe(false);
    expect(readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8")).toMatch(/const native = stepNotes\.take\([^)]*\);[^]*?allowance: allowanceSpent\(native\), noCredit: native === "no-credit"/u);
  });

  it("decides and sends the notice before the write-up is asked for, and a pause during the write-up leaves the check and its notice standing (review H, L14)", async () => {
    const h = setup({ modelReady: true });
    let release: (p: Prepared) => void = () => {};
    // App's hook is called with the run's signal (fourth): a pause aborts the pending write-up.
    h.prepare.mockImplementation(((...args: unknown[]) => new Promise<Prepared>((resolve, reject) => {
      release = resolve; (args[3] as AbortSignal | undefined)?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })) as () => Promise<Prepared>);
    // The first run (start) is told in Ozzie; let its write-up finish.
    const first = h.runner.create(sunday());
    await vi.waitFor(() => expect(h.prepare).toHaveBeenCalledTimes(1));
    release(WRITTEN);
    await first; await h.runner.tick();
    // A scheduled run with something new to decide: the notice goes out while the model step is still waiting.
    h.set("2026-11-20T17:00:00.000Z");
    h.changeTo(decline);
    const run = h.runner.tick();
    await vi.waitFor(() => expect(h.prepare).toHaveBeenCalledTimes(2));
    // The start run is told in Ozzie, so this is the scheduled run's notice, sent before its write-up came back.
    expect(h.notify.mock.calls).toEqual([["needs-decision"]]);
    // Paused while the write-up is pending: the write-up stops; the run ends ok with its counts, and the notice stands.
    const r = h.runner.view().items[0]!;
    await h.runner.pause(r.id);
    await run;
    expect(h.fake.calls.filter(c => c.startsWith("end"))).toEqual(["end ok - 4 1", "end ok - 3 1"]);
    expect(h.runner.view().noticed.find(i => i.trigger === "scheduled")).toMatchObject({ notice: "sent" });
    expect(Object.values(h.runner.view().writeups)).toHaveLength(1);
  });

  it("keeps the last few write-ups of each job, and forgets a job's when it is stopped or the church changes", async () => {
    const h = setup({ modelReady: true });
    h.prepare.mockResolvedValue(WRITTEN);
    const r = await h.start(sunday());
    for (let i = 1; i <= 7; i++) { h.set(at(FRI, 31 * i)); await h.runner.runNow(r.id); }
    const kept = Object.values(h.runner.view().writeups);
    expect(kept).toHaveLength(WRITEUPS_KEPT_PER_JOB);
    // The newest are kept.
    expect(kept.map(w => w.at).sort().at(-1)).toBe(at(FRI, 31 * 7));
    // Once Ozzie says which church it uses, only that church's write-ups are shown, even one written later by a check of
    // another church that was still running, so an id is never filled in with another church's names.
    h.runner.keepWriteupsFor("fictional-other-church");
    expect(h.runner.view().writeups).toEqual({});
    expect(h.store.get("ozzie.responsibilities.writeups.v1")).not.toContain(nov22Capture().organization);
    h.set(at(FRI, 31 * 8));
    await h.runner.runNow(r.id);
    expect(Object.keys(h.runner.view().writeups)).toHaveLength(0);
    h.runner.keepWriteupsFor(nov22Capture().organization);
    expect(Object.keys(h.runner.view().writeups)).toHaveLength(1);
    await h.runner.stop(r.id);
    expect(h.runner.view().writeups).toEqual({});
    expect(h.store.get("ozzie.responsibilities.writeups.v1")).not.toContain(r.id);
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

  it("a held notice is rechecked when quiet hours end: a decline a newer check reads as restored brings no notice", async () => {
    const h = setup({ urgentWithinHours: 1 });
    await h.start(sunday());
    // 11:00 PM Friday in New York: a decline brings the Sunday check sooner; its notice waits for quiet hours.
    h.set("2026-11-21T04:00:00.000Z");
    h.changeTo(decline);
    await h.runner.changes([{ id: "need-increased:x", kind: "need-increased", effect: "worse", urgency: "attention", position: "Greeter", from: 1, to: 2 }]);
    const night = h.runner.view().noticed.find(i => i.trigger === "change")!;
    expect(night.notice).toBe("held");
    // 6:30 AM: the regular Sunday check reads it restored (no new read is needed when quiet hours end).
    h.changeTo(undefined);
    h.set("2026-11-21T11:30:00.000Z");
    h.runner.captured(captureAt(h.now()));
    h.set("2026-11-21T12:01:00.000Z");
    await h.runner.tick();
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.runner.view().noticed.find(i => i.id === night.id)!.notice).toBe("none");
  });

  it("a held notice whose cause still holds in the latest saved check goes out once when quiet hours end", async () => {
    const h = setup({ urgentWithinHours: 1 });
    await h.start(sunday());
    h.set("2026-11-21T04:00:00.000Z");
    h.changeTo(decline);
    await h.runner.changes([{ id: "need-increased:x", kind: "need-increased", effect: "worse", urgency: "attention", position: "Greeter", from: 1, to: 2 }]);
    const night = h.runner.view().noticed.find(i => i.trigger === "change")!;
    h.set("2026-11-21T12:01:00.000Z");
    await h.runner.tick();
    expect(h.notify.mock.calls).toEqual([["needs-decision"]]);
    expect(h.runner.view().noticed.find(i => i.id === night.id)!.notice).toBe("sent-later");
  });

  it("a held 'couldn't check' is dropped when a later check of the same job finished", async () => {
    const h = setup();
    await h.start(sunday());
    h.set("2026-11-21T04:00:00.000Z");
    h.failWith("network");
    await h.runner.changes([{ id: "need-opened:x", kind: "need-opened", effect: "worse", urgency: "attention", position: "Greeter", from: 0, to: 1 }]);
    const failed = h.runner.view().noticed[0]!;
    expect(failed).toMatchObject({ kind: "couldnt-check", notice: "held" });
    // Its retry an hour later finishes, still in quiet hours.
    h.failWith(null);
    h.set("2026-11-21T05:00:00.000Z");
    await h.runner.tick();
    expect(h.runner.view().noticed[0]!.kind).toBe("found");
    h.set("2026-11-21T12:01:00.000Z");
    await h.runner.tick();
    expect((h.notify.mock.calls as unknown[][]).filter(([k]) => k === "couldnt-check")).toEqual([]);
    expect(h.runner.view().noticed.find(i => i.id === failed.id)!.notice).toBe("none");
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
    h.set("2026-11-21T12:01:00.000Z");
    await h.runner.tick();
    expect(h.notify).not.toHaveBeenCalled();
  });
});

describe("the settled briefing defaults (owner decision, October 26)", () => {
  const THU = "2026-11-19T15:00:00.000Z";
  const worse: SundayChange = { id: "need-opened:x", kind: "need-opened", effect: "worse", urgency: "attention", position: "Greeter", from: 0, to: 1 };

  it("moves a saved briefing still on the earlier 6:45 every-day default to 7:00 AM on weekdays, once", async () => {
    const h = setup();
    const r = await h.start({ ...defaultPlan("morning-briefing", FRI, ET), schedule: { time: "06:45", weekdays: [], on_change: false } });
    expect(h.fake.items.find(x => x.id === r.id)!.schedule).toEqual({ time: "07:00", weekdays: [1, 2, 3, 4, 5], on_change: false });
    expect(h.lines).toContain("responsibility: settled defaults template=morning-briefing");
    // A person who then picks 6:45 every day keeps it.
    await h.runner.edit(r.id, { ...defaultPlan("morning-briefing", FRI, ET), schedule: { time: "06:45", weekdays: [], on_change: false } });
    await h.runner.tick();
    expect(h.fake.items.find(x => x.id === r.id)!.schedule).toMatchObject({ time: "06:45", weekdays: [] });
    // Anything a person chose is never moved.
    const other = setup();
    const own = await other.start({ ...defaultPlan("morning-briefing", FRI, ET), schedule: { time: "06:30", weekdays: [], on_change: false } });
    expect(other.fake.items.find(x => x.id === own.id)!.schedule.time).toBe("06:30");
  });

  it("Thursday's briefing includes the full Sunday Ready brief; Friday's doesn't", async () => {
    const h = setup();
    h.set(THU);
    await h.start(defaultPlan("morning-briefing", THU, ET));
    const thursday = h.runner.view().noticed[0]!;
    expect(thursday).toMatchObject({ kind: "briefing", sunday_ready: true });
    expect(noticedTitle(thursday, THU)).toBe("Your morning briefing is ready. Today it includes the full “Ready for Sunday” brief.");
    h.set("2026-11-20T12:00:00.000Z"); // Friday 7:00 AM in New York
    await h.runner.tick();
    const friday = h.runner.view().noticed[0]!;
    expect(friday).toMatchObject({ kind: "briefing", trigger: "scheduled" });
    expect(friday.sunday_ready).toBeUndefined();
  });

  it("what came up overnight is labelled Overnight and brought into the morning briefing, not sent as its own notice", async () => {
    const h = setup({ urgentWithinHours: 1 });
    h.set(THU);
    await h.start(sunday());
    await h.start(defaultPlan("morning-briefing", THU, ET));
    // 11:00 PM Thursday in New York: quiet hours. A decline brings the Sunday check sooner.
    h.set("2026-11-20T04:00:00.000Z");
    h.changeTo(decline);
    await h.runner.changes([worse]);
    const night = h.runner.view().noticed.find(i => i.trigger === "change")!;
    expect(night).toMatchObject({ kind: "found", overnight: true, notice: "held" });
    expect(h.notify).not.toHaveBeenCalled();
    // 7:00 AM Friday: the briefing runs and brings it in. One notice, the briefing's.
    h.set("2026-11-20T12:00:00.000Z");
    await h.runner.tick();
    expect(h.notify.mock.calls).toEqual([["briefing-ready"]]);
    expect(h.runner.view().noticed.find(i => i.id === night.id)!.notice).toBe("in-briefing");
    const briefing = h.runner.view().noticed.find(i => i.kind === "briefing" && i.trigger === "scheduled")!;
    expect(briefing.overnight_count).toBe(1);
    expect(noticedTitle(briefing, "2026-11-20T12:00:00.000Z")).toBe("Your morning briefing is ready. One thing came up overnight; it's marked Overnight.");
  });
});

describe("the person's Church rules on notices", () => {
  const briefingRule: FeedbackEntry = { type: "urgency", id: "u", kind: "needs-people", at: FRI, level: "briefing" };
  const rightAway: FeedbackEntry = { type: "urgency", id: "r", kind: "needs-people", at: FRI, level: "right-away" };
  const rulesWith = (feedback: FeedbackEntry[]) => ({ sundayLeads: [], checkInAfterSundaysInARow: 3, feedback });

  it("Put this in the briefing: open roles that get worse show in Ozzie but bring no notice", async () => {
    const h = setup({ rules: rulesWith([briefingRule]) });
    await h.start(sunday());
    h.set("2026-11-20T17:00:00.000Z");
    h.changeTo(decline);
    await h.runner.tick();
    expect(h.notify).not.toHaveBeenCalled();
    const item = h.runner.view().noticed[0]!;
    expect(item).toMatchObject({ kind: "found", notice: "briefing" });
    expect(noticedChanges(item, names)).toContain("Avery Brightwater declined Greeter after confirming.");
  });

  it("Put this in the briefing: the morning briefing lists what the person keeps for it", async () => {
    const h = setup({ granted: ["services", "operations"], rules: rulesWith([briefingRule, { type: "urgency", id: "f", kind: "unowned-overdue", at: FRI, level: "briefing" }]) });
    await h.start(defaultPlan("morning-briefing", FRI, ET));
    const item = h.runner.view().noticed[0]!;
    expect(item).toMatchObject({ kind: "briefing", kept: [{ kind: "needs-people", count: 2 }, { kind: "unowned-overdue", count: 1 }] });
    expect(noticedTitle(item, FRI)).toBe("Your morning briefing is ready. It includes 3 things your Church rules keep for the briefing.");
    expect(keptLines(item)).toEqual(["Open roles: 2", "Follow-ups without an owner: 1"]);
    // Nothing kept for it: nothing extra to list.
    const plain = setup();
    await plain.start(defaultPlan("morning-briefing", FRI, ET));
    expect(plain.runner.view().noticed[0]!.kept).toBeUndefined();
    expect(keptLines(plain.runner.view().noticed[0]!)).toEqual([]);
  });

  it("Always tell me right away: quiet hours still hold it, unless the person let urgent notices through", async () => {
    for (const [urgentDuringQuiet, expected] of [[false, "held"], [true, "sent"]] as const) {
      const h = setup({ rules: rulesWith([rightAway]), urgentWithinHours: 1, urgentDuringQuiet });
      await h.start(sunday());
      h.set("2026-11-21T04:00:00.000Z"); // 11:00 PM Friday in New York
      h.changeTo(decline);
      await h.runner.changes([{ id: "need-increased:x", kind: "need-increased", effect: "worse", urgency: "attention", position: "Greeter", from: 1, to: 2 }]);
      expect(h.runner.view().noticed.find(i => i.trigger === "change")!.notice).toBe(expected);
      expect(h.notify).toHaveBeenCalledTimes(expected === "sent" ? 1 : 0);
    }
    // Without the rule, a change outside the church's urgent window waits, even with urgent notices let through.
    const h = setup({ urgentWithinHours: 1, urgentDuringQuiet: true });
    await h.start(sunday());
    h.set("2026-11-21T04:00:00.000Z");
    h.changeTo(decline);
    await h.runner.changes([{ id: "need-increased:x", kind: "need-increased", effect: "worse", urgency: "attention", position: "Greeter", from: 1, to: 2 }]);
    expect(h.runner.view().noticed.find(i => i.trigger === "change")!.notice).toBe("held");
  });
});

describe("Worth a look never sends a notice", () => {
  /** The same Sunday before the group's meeting or the room's bookings were in Planning Center. */
  const empty = (collection: string) => (c: SundayCapture) => {
    for (const r of c.reads.filter(x => x.collection === collection)) r.body = { data: [], meta: { count: 0, total_count: 0 } };
  };

  it("Worth a look never sends a notice: a new group meeting clash shows in Ozzie as Worth a look", async () => {
    const h = setup({ granted: ["services", "operations"] });
    h.changeTo(empty("groups_group_events"));
    await h.start(defaultPlan("group-night-clashes", FRI, ET));
    expect(h.runner.view().noticed[0]!.findings).toEqual({ groups: 0 });
    // Wednesday 9:00 AM: the group now meets while someone serves.
    h.changeTo(undefined);
    h.set("2026-11-25T14:00:00.000Z");
    await h.runner.tick();
    const item = h.runner.view().noticed[0]!;
    expect(item).toMatchObject({ kind: "found", trigger: "scheduled", findings: { groups: 1 }, notice: "none" });
    expect(noticedBadge(item)).toEqual({ label: "Worth a look", tone: "look" });
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("Worth a look never sends a notice: a new room overlap no room rule confirms shows in Ozzie, unless the person asked to hear right away", async () => {
    for (const told of [false, true]) {
      const rightAway: FeedbackEntry[] = told ? [{ type: "urgency", id: "r", kind: "room-overlap", at: FRI, level: "right-away" }] : [];
      const h = setup({ granted: ["services", "operations"], rules: { sundayLeads: [], checkInAfterSundaysInARow: 3, feedback: rightAway } });
      h.changeTo(empty("calendar_resource_bookings"));
      await h.start(defaultPlan("watch-room-bookings", FRI, ET));
      // Thursday 9:00 AM: two bookings now overlap.
      h.changeTo(undefined);
      h.set("2026-11-26T14:00:00.000Z");
      await h.runner.tick();
      const item = h.runner.view().noticed[0]!;
      expect(item).toMatchObject({ kind: "found", trigger: "scheduled", findings: { rooms_uncertain: 1 }, notice: told ? "sent" : "none" });
      // "Always tell me right away" is the person's own rule: it tells them, and never makes an uncertain overlap urgent.
      expect(h.notify.mock.calls).toEqual(told ? [["needs-decision"]] : []);
    }
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

describe("one change, one notice: the regular Sunday check and Keep Sunday covered together", () => {
  /** Both controllers wired as App.tsx wires them, on one clock, each with its own notice. */
  function together(start: string, over: Partial<RunnerContext> = {}) {
    let now = start;
    let change: ((c: SundayCapture) => void) | undefined;
    /** Keep Sunday covered's own check fails (and so it can't share the regular check's). */
    let runnerCheckFails = false;
    const clock = () => now;
    const fake = fakeStore(clock);
    const sundayNotice = vi.fn(async () => {});
    const runnerNotice = vi.fn(async (kind: string) => { void kind; });
    const context: RunnerContext = {
      ready: true, granted: ["services"], rules: { sundayLeads: [], checkInAfterSundaysInARow: 3 }, zone: ET, macZone: ET,
      quiet: DEFAULT_QUIET_HOURS, urgentWithinHours: 48, modelReady: false, ...over,
    };
    const proactive = createProactive({
      store: memoryStore(), now: clock, timeZone: () => ET, check: async () => captureAt(now, change), notify: sundayNotice, problem: sundayProblem,
      timers: { setInterval: () => 0, clearInterval: () => {} },
    });
    const runner = createRunner({ native: fake.native, store: memoryStore(), now: clock, notify: runnerNotice });
    const settings = { clientId: "fictional-client", organization: "1001", serviceTypeId: "1500", planId: nov22Capture().plan_id };
    const status = { state: "connected", organization: "1001", checked_at_ms: null, source: "", problem: null } as const;
    proactive.start({
      context: () => ({ settings, rules: context.rules, status }), onStatus: () => {},
      onCapture: c => { if (!runnerCheckFails) runner.captured(c); }, onChanges: handChanges(runner),
    });
    runner.start({
      context: () => context, check: () => runnerCheckFails ? Promise.reject("network") : proactive.checkNow("automatic"), prepare: async () => null,
    });
    const regular = () => proactive.view().history.find(e => e.kind === "changes");
    return {
      proactive, runner, fake, context, regular,
      set: (iso: string) => { now = iso; },
      changeTo: (f?: (c: SundayCapture) => void) => { change = f; },
      failRunnerChecks: () => { runnerCheckFails = true; },
      /** Every notice either one sent. */
      notices: () => [...sundayNotice.mock.calls.map(() => "sunday-attention"), ...runnerNotice.mock.calls.map(([k]) => k)],
      /** One regular check, then whatever it handed to Keep Sunday covered, until its notice is decided. */
      check: async () => {
        await proactive.tick();
        await runner.tick();
        await vi.waitFor(() => expect(regular()?.notice).not.toBe("handed"));
      },
    };
  }
  const settle = async (h: ReturnType<typeof together>) => { await h.proactive.tick(); await h.runner.tick(); };

  it("with Keep Sunday covered active for this Sunday, its run sends the one notice; the regular check sends none", async () => {
    const h = together(FRI);
    await settle(h);
    await h.runner.create(sunday());
    await h.runner.tick();
    expect(h.notices()).toEqual([]);
    h.set("2026-11-20T16:00:00.000Z");
    h.changeTo(decline);
    await h.check();
    expect(h.notices()).toEqual(["needs-decision"]);
    expect(h.regular()).toMatchObject({ trigger: "scheduled", notice: "responsibility" });
    const item = h.runner.view().noticed.find(i => i.trigger === "change")!;
    expect(item).toMatchObject({ kind: "found", notice: "sent", check: { plan_id: nov22Capture().plan_id } });
    expect(noticedChanges(item, names)).toContain("Avery Brightwater declined Greeter after confirming.");
  });

  it("without a responsibility, the regular check sends its notice as before, straight away", async () => {
    const h = together(FRI);
    await settle(h);
    h.set("2026-11-20T16:00:00.000Z");
    h.changeTo(decline);
    await h.proactive.tick();
    expect(h.regular()).toMatchObject({ notice: "sent" });
    expect(h.notices()).toEqual(["sunday-attention"]);
  });

  it("Keep Sunday covered paused: the regular check sends its notice", async () => {
    const h = together(FRI);
    await settle(h);
    const r = await h.runner.create(sunday());
    await h.runner.tick();
    await h.runner.pause(r.id);
    h.set("2026-11-20T16:00:00.000Z");
    h.changeTo(decline);
    await h.check();
    expect(h.regular()).toMatchObject({ notice: "sent" });
    expect(h.notices()).toEqual(["sunday-attention"]);
    expect(h.fake.calls.filter(c => c.startsWith("begin"))).toEqual(["begin start"]);
  });

  it("Keep Sunday covered over its limit for the day: the regular check's notice goes out instead", async () => {
    const h = together(FRI);
    await settle(h);
    await h.runner.create(sunday());
    await h.runner.tick();
    h.fake.refuse.always = "checks-limit";
    h.set("2026-11-20T16:00:00.000Z");
    h.changeTo(decline);
    await h.check();
    expect(h.fake.calls.filter(c => c.startsWith("begin"))).toEqual(["begin start", "begin change"]);
    expect(h.regular()).toMatchObject({ notice: "sent" });
    expect(h.notices()).toEqual(["sunday-attention"]);
  });

  it("Keep Sunday covered's run failed: the regular check's notice is the one notice; the failure shows in Ozzie", async () => {
    const h = together(FRI);
    await settle(h);
    await h.runner.create(sunday());
    await h.runner.tick();
    h.failRunnerChecks();
    h.set("2026-11-20T16:00:00.000Z");
    h.changeTo(decline);
    await h.check();
    expect(h.runner.view().noticed[0]).toMatchObject({ kind: "couldnt-check", trigger: "change", code: "provider-failure", notice: "none" });
    expect(h.regular()).toMatchObject({ notice: "sent" });
    expect(h.notices()).toEqual(["sunday-attention"]);
  });

  it("Keep Sunday covered couldn't start (its store unreadable): the regular check's notice is the one notice", async () => {
    const h = together(FRI);
    await settle(h);
    await h.runner.create(sunday());
    await h.runner.tick();
    h.fake.refuse.next = "unavailable";
    h.set("2026-11-20T16:00:00.000Z");
    h.changeTo(decline);
    await h.check();
    expect(h.runner.view().noticed[0]).toMatchObject({ kind: "couldnt-check", trigger: "change", code: "unavailable", notice: "none" });
    expect(h.regular()).toMatchObject({ notice: "sent" });
    expect(h.notices()).toEqual(["sunday-attention"]);
  });

  it("a later failure with nothing handed over still says Ozzie couldn't check, as before", async () => {
    const h = setup();
    await h.start(sunday());
    h.failWith("network");
    h.set(at(FRI, 45));
    await h.runner.changes([{ id: "need-opened:x", kind: "need-opened", effect: "worse", urgency: "attention", position: "Greeter", from: 0, to: 1 }]);
    expect(h.runner.view().noticed[0]).toMatchObject({ kind: "couldnt-check", trigger: "change", notice: "sent" });
    expect(h.notify.mock.calls).toEqual([["couldnt-check"]]);
  });

  it("during quiet hours the one notice waits, and goes out once when they end", async () => {
    // Thursday 9:30 PM in New York: quiet hours.
    const h = together("2026-11-20T02:30:00.000Z");
    await settle(h);
    await h.runner.create(defaultPlan("keep-sunday-covered", "2026-11-20T02:30:00.000Z", ET));
    await h.runner.tick();
    h.set("2026-11-20T03:30:00.000Z");
    h.changeTo(decline);
    await h.check();
    expect(h.notices()).toEqual([]);
    expect(h.regular()).toMatchObject({ notice: "responsibility" });
    expect(h.runner.view().noticed.find(i => i.trigger === "change")).toMatchObject({ notice: "held", overnight: true });
    expect(h.proactive.view().schedule.held).toBeNull();
    // 7:01 AM Friday.
    h.set("2026-11-20T12:01:00.000Z");
    await settle(h);
    await settle(h);
    expect(h.notices()).toEqual(["needs-decision"]);
  });

  it("with a morning briefing, what came up overnight is folded into it: still one notice", async () => {
    const h = together("2026-11-20T02:30:00.000Z");
    await settle(h);
    await h.runner.create(defaultPlan("keep-sunday-covered", "2026-11-20T02:30:00.000Z", ET));
    await h.runner.create(defaultPlan("morning-briefing", "2026-11-20T02:30:00.000Z", ET));
    await h.runner.tick();
    h.set("2026-11-20T03:30:00.000Z");
    h.changeTo(decline);
    await h.check();
    expect(h.notices()).toEqual([]);
    h.set("2026-11-20T12:01:00.000Z");
    await settle(h);
    await settle(h);
    expect(h.notices()).toEqual(["briefing-ready"]);
    expect(h.runner.view().noticed.find(i => i.trigger === "change")!.notice).toBe("in-briefing");
  });

  it("Put this in the briefing: neither one sends a notice", async () => {
    const h = together(FRI, { rules: { sundayLeads: [], checkInAfterSundaysInARow: 3, feedback: [{ type: "urgency", id: "u", kind: "needs-people", at: FRI, level: "briefing" }] } });
    await settle(h);
    await h.runner.create(sunday());
    await h.runner.tick();
    h.set("2026-11-20T16:00:00.000Z");
    h.changeTo(decline);
    await h.check();
    expect(h.regular()).toMatchObject({ notice: "briefing" });
    expect(h.runner.view().noticed.find(i => i.trigger === "change")).toMatchObject({ notice: "briefing" });
    expect(h.notices()).toEqual([]);
  });
});
