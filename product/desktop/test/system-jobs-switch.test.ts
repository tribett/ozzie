// Jobs when the Mac switches church (owner decision 2026-11-22: pause and ask once): each job keeps the church it was
// confirmed for; on a switch to another church, whatever system each is on, it pauses and Ozzie asks one question naming
// both churches; Yes keeps it for the new church, its first check a quiet baseline; No stops it; switching back before
// answering resumes it; a job from before churches were kept belongs to the Planning Center church in use, with no
// question and no burst of notices. Also: another church's items are never shown, a notice held about the old church never
// goes out, a run keeps the system it read, and the switch questions say what happens to jobs. Fixed fictional data, a
// fake native store and clock; nothing native runs.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => { throw new Error("NATIVE_CALL_FORBIDDEN"); }) }));
import { defaultPlan, type Plan, type Responsibility } from "../../../core/src/harness/responsibilities.js";
import { DEFAULT_QUIET_HOURS, type QuietHours } from "../../../core/src/schedule.js";
import { nov22Capture } from "../../../core/src/fictional-sunday.js";
import { withFictionalOperations } from "../../../core/src/fictional-operations.js";
import type { SundayCapture } from "../../../core/src/sunday-capture.js";
import type { SystemCapture } from "../../../core/src/church-systems/types.js";
import { b1Capture } from "../../../core/test/church-systems/fixtures.js";
import { createRunner, type JobChurch, type JobCheck, type NoticedItem, type Runner, type RunnerView } from "../src/responsibility-runner.js";
import { ResponsibilityList, type PlanActions, type PlanContext } from "../src/responsibility-views.js";
import { noticedTitle, switchQuestionText } from "../src/responsibility-words.js";
import { TodayPage } from "../src/today-page.js";
import { systemJobCheck } from "../src/system-jobs.js";
import { SystemWordsContext, systemWords } from "../src/church-system.js";
import { SystemReadFailure } from "../src/proactive.js";
import { switchCopy, type SwitchQuestion as ChurchSwitch } from "../src/connection.js";
import { switchForgets } from "../src/system-settings.js";
import { jobsAtStake, type JobAtStake } from "../src/jobs-at-stake.js";
import { text } from "./harness-fakes.js";
import { fakeJobStore, memoryStore } from "./job-fakes.js";

const ET = "America/New_York", CT = "America/Chicago";
const RULES = { sundayLeads: [], checkInAfterSundaysInARow: 3 };
/** Friday 20 November 2026, 10:05 AM in New York. */
const FRI = "2026-11-20T15:05:00.000Z";
type Key = "harbor" | "second" | "cedar" | "willow";
const CHURCH: Readonly<Record<Key, JobChurch>> = {
  harbor: { church: nov22Capture().organization, name: "Harbor Example Church", system: "planning-center" },
  second: { church: "1002", name: "Second Street Church", system: "planning-center" },
  cedar: { church: "b1:CHU0000cedar", name: "Cedar Hollow Fellowship", system: "b1" },
  willow: { church: "b1:CHU0000willow", name: "Willow Creek Fictional", system: "b1" },
};
/** Harbor's (or another Planning Center church's) check read at `iso`. */
function pcAt(iso: string, organization: string, change?: (c: SundayCapture) => void): SundayCapture {
  const c = withFictionalOperations(nov22Capture());
  change?.(c);
  const delta = Date.parse(iso) - Date.parse(c.completed_at);
  const shift = (t: string) => new Date(Date.parse(t) + delta).toISOString();
  return { ...c, organization, started_at: shift(c.started_at), completed_at: shift(c.completed_at), reads: c.reads.map(r => ({ ...r, checked_at: shift(r.checked_at) })) };
}
/** A B1 Church capture read at `iso`, for `church`. */
function b1At(iso: string, church = "CHU0000cedar", change?: (c: SystemCapture) => SystemCapture): SystemCapture {
  const base = change ? change(b1Capture()) : b1Capture();
  const delta = Date.parse(iso) - Date.parse(base.completed_at);
  const shift = (t: string) => new Date(Date.parse(t) + delta).toISOString().replace(/\.\d{3}Z$/u, "Z");
  return { ...base, church: { ...base.church, id: church }, started_at: shift(base.started_at), completed_at: shift(base.completed_at), reads: base.reads.map(r => ({ ...r, checked_at: shift(r.checked_at) })) };
}
const rowanDeclines = (c: SystemCapture): SystemCapture => ({ ...c, assignments: c.assignments.map(a => a.id === "ASN-rowan" ? { ...a, status: "declined" as const } : a) });
const keepPlan = (zone: string): Plan => defaultPlan("keep-sunday-covered", FRI, zone, { sunday: "2026-11-22" });

/** The runner as App sets it up, on whichever church the Mac uses (`use` switches, as App's churchInUse does). */
function switching(start: Key = "harbor", over: { quiet?: QuietHours } = {}) {
  let now = FRI;
  let on: Key = start;
  let change: ((c: SystemCapture) => SystemCapture) | undefined;
  let fail: unknown = null;
  let during: (() => void) | null = null;
  /** The app knows no church in use (a setup left unfinished, a disconnect). */
  let unknownNow = false;
  const clock = () => now;
  const store = memoryStore();
  const fake = fakeJobStore(clock);
  const notify = vi.fn(async () => {});
  const check = vi.fn(async (): Promise<JobCheck> => {
    const at = on;
    if (during) { const f = during; during = null; f(); }
    if (fail !== null) throw fail;
    const c = CHURCH[at];
    return c.system === "b1" ? systemJobCheck(b1At(now, c.church!.slice(3), change), CT)! : pcAt(now, c.church!);
  });
  const context = () => ({
    ready: true, granted: ["services" as const], rules: RULES, zone: CHURCH[on].system === "b1" ? CT : ET, macZone: ET, quiet: over.quiet ?? DEFAULT_QUIET_HOURS,
    urgentWithinHours: 48, modelReady: false, ...(CHURCH[on].system === "b1" ? { system: "b1" as const } : {}), church: unknownNow ? null : CHURCH[on].church,
  });
  const make = () => {
    const runner = createRunner({ native: fake.native, store, now: clock, notify });
    runner.start({ context, check, prepare: async () => null, belongs: c => c.organization === CHURCH[on].church });
    return runner;
  };
  let runner = make();
  return {
    get runner() { return runner; }, fake, store, notify, check,
    now: () => now, set: (iso: string) => { now = iso; },
    changeTo: (f?: (c: SystemCapture) => SystemCapture) => { change = f; },
    failWith: (e: unknown) => { fail = e; },
    /** Runs `f` while the next check is under way. */
    whileChecking: (f: () => void) => { during = f; },
    /** What the app's context says the church's system is, changed without anything told to the runner. */
    flipTo: (k: Key) => { on = k; },
    /** The Mac uses `k` now (App: churchInUse), then whatever that queued has finished. */
    use: async (k: Key) => { on = k; runner.churchInUse(CHURCH[k]); await runner.refresh(); },
    /** Before the church is known (a launch), or with none connected. */
    unknown: async () => { runner.churchInUse(null); await runner.refresh(); },
    /** The app uses a system with no church connected yet (App: churchInUse with no church). */
    noChurch: async (system: JobChurch["system"]) => { unknownNow = true; runner.churchInUse({ church: null, name: null, system }); await runner.refresh(); },
    /** The church is known again (connected again). */
    back: async (k: Key) => { unknownNow = false; on = k; runner.churchInUse(CHURCH[k]); await runner.refresh(); },
    /** Ozzie opened again on the same Mac (same native store, same storage). */
    relaunch: () => { runner = make(); },
    calls: () => fake.calls.filter(c => c.startsWith("begin") || c === "pause" || c === "resume" || c === "stop"),
  };
}
describe("a job when the Mac switches church: pause and ask once (owner decision 2026-11-22)", () => {
  it("a job confirmed for Harbor on Planning Center pauses on a switch to Cedar Hollow on B1 Church, and asks once, in plain words", async () => {
    const h = switching();
    await h.use("harbor");
    const r = await h.runner.create(keepPlan(ET));
    await h.runner.tick();
    expect(h.runner.view().noticed[0]).toMatchObject({ church: CHURCH.harbor.church, kind: "found" });
    await h.use("cedar");
    expect(h.calls()).toEqual(["begin start", "pause"]);
    const v = h.runner.view();
    expect(v.questions).toEqual([{ responsibility_id: r.id, template: "keep-sunday-covered", title: "Keep Sunday covered", from: CHURCH.harbor, to: CHURCH.cedar }]);
    // Its card gives way to the question, and Harbor's findings aren't shown on Cedar Hollow's pages.
    expect(v.items).toEqual([]);
    expect(v.noticed).toEqual([]);
    const said = switchQuestionText(v.questions![0]!);
    expect(said.title).toBe("Keep services covered was set up for Harbor Example Church on Planning Center. Keep it for Cedar Hollow Fellowship on B1 Church?");
    expect(said.body).toBe("Until you answer, it's paused: it checks nothing and tells you nothing. If you keep it, its first check of Cedar Hollow Fellowship only learns what is there now and tells you nothing about it; after that it tells you what changes. If you stop it, it ends, as Stop does.");
    expect([said.keep, said.stop]).toEqual(["Yes, keep it for Cedar Hollow Fellowship", "No, stop it"]);
    // Until answered: no reads, no notices, no checks used, even at its scheduled times.
    for (const at of ["2026-11-20T18:00:30.000Z", "2026-11-20T23:00:30.000Z", "2026-11-21T13:00:30.000Z"]) { h.set(at); await h.runner.tick(); }
    expect(h.calls()).toEqual(["begin start", "pause"]);
    expect(h.check).toHaveBeenCalledTimes(1);
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.runner.view().questions).toHaveLength(1);
  });

  it("Yes keeps it for Cedar Hollow, on its clock: its first check there tells nothing already there; later changes are told", async () => {
    const h = switching();
    await h.use("harbor");
    const r = await h.runner.create(keepPlan(ET));
    await h.runner.tick();
    await h.use("cedar");
    h.set("2026-11-20T16:00:00.000Z");
    await h.runner.answerSwitch(r.id, true);
    await h.runner.tick();
    expect(h.calls()).toEqual(["begin start", "pause", "resume", "begin start"]);
    expect(h.fake.items[0]!.zone).toBe(CT);
    const first = h.runner.view().noticed[0]!;
    expect(first).toMatchObject({ church: CHURCH.cedar.church, system: "b1", kind: "found", notice: "in-app" });
    expect(h.runner.view().questions).toBeUndefined();
    expect(h.runner.view().items.map(x => x.id)).toEqual([r.id]);
    // The next scheduled check with the same facts: nothing new, so nothing is told.
    h.set("2026-11-20T18:00:30.000Z");
    await h.runner.tick();
    expect(h.notify).not.toHaveBeenCalled();
    // A real change after that is told, once, with no names.
    h.changeTo(rowanDeclines);
    h.set("2026-11-20T23:00:30.000Z");
    await h.runner.tick();
    expect(h.notify.mock.calls).toEqual([["needs-decision"]]);
  });

  it("No stops it, as Stop does: it never checks again", async () => {
    const h = switching();
    await h.use("harbor");
    const r = await h.runner.create(keepPlan(ET));
    await h.runner.tick();
    await h.use("cedar");
    await h.runner.answerSwitch(r.id, false);
    h.set("2026-11-21T13:00:30.000Z");
    await h.runner.tick();
    expect(h.calls()).toEqual(["begin start", "pause", "stop"]);
    expect(h.fake.items[0]!.status).toBe("ended");
    expect(h.runner.view().questions).toBeUndefined();
  });

  it("switching back to Harbor before answering simply resumes it: no question, nothing told", async () => {
    const h = switching();
    await h.use("harbor");
    await h.runner.create(keepPlan(ET));
    await h.runner.tick();
    await h.use("cedar");
    await h.use("harbor");
    expect(h.runner.view().questions).toBeUndefined();
    h.set("2026-11-20T17:00:30.000Z");
    await h.runner.tick();
    expect(h.calls()).toEqual(["begin start", "pause", "resume", "begin scheduled"]);
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.runner.view().noticed.every(i => i.church === CHURCH.harbor.church)).toBe(true);
  });

  it("asks between any two churches: Planning Center to Planning Center, and B1 Church to B1 Church", async () => {
    const pc = switching();
    await pc.use("harbor");
    await pc.runner.create(keepPlan(ET));
    await pc.runner.tick();
    await pc.use("second");
    expect(switchQuestionText(pc.runner.view().questions![0]!).title)
      .toBe("Keep services covered was set up for Harbor Example Church on Planning Center. Keep it for Second Street Church on Planning Center?");
    const b1 = switching("cedar");
    await b1.use("cedar");
    await b1.runner.create(defaultPlan("morning-briefing", FRI, CT));
    await b1.runner.tick();
    await b1.use("willow");
    expect(switchQuestionText(b1.runner.view().questions![0]!).title)
      .toBe("Morning briefing was set up for Cedar Hollow Fellowship on B1 Church. Keep it for Willow Creek Fictional on B1 Church?");
    expect(switchQuestionText(b1.runner.view().questions![0]!).keep).toBe("Yes, keep it for Willow Creek Fictional");
  });

  it("a notice held for quiet hours about Harbor never goes out after the switch", async () => {
    // Quiet from 4:00 PM, so Friday's 5:00 PM check is in them.
    const h = switching("harbor", { quiet: { start: "16:00", end: "07:00" } });
    await h.use("harbor");
    await h.runner.create(keepPlan(ET));
    await h.runner.tick();
    h.set("2026-11-20T22:00:30.000Z");
    // Harbor's Greeter declines after confirming (Planning Center's fixture): a notice is held until 7:00 AM.
    h.check.mockImplementationOnce(async () => pcAt(h.now(), CHURCH.harbor.church!, c => {
      const rows = (k: string) => c.reads.find(x => x.collection === k)!.body!.data as { id: string; attributes: Record<string, unknown> }[];
      rows("team_members").find(m => m.id === "401")!.attributes.status = "D";
    }));
    await h.runner.tick();
    expect(h.runner.view().noticed[0]).toMatchObject({ church: CHURCH.harbor.church, notice: "held" });
    await h.use("cedar");
    h.set("2026-11-21T12:30:00.000Z");
    await h.runner.tick();
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("a run keeps the church and system it read when it started, even if the church changes while it reads", async () => {
    const h = switching("cedar");
    await h.use("cedar");
    await h.runner.create(keepPlan(CT));
    await h.runner.tick();
    h.failWith(new SystemReadFailure("b1", "timeout", "CHU0000cedar"));
    h.whileChecking(() => h.flipTo("harbor"));
    h.set("2026-11-20T18:00:30.000Z");
    await h.runner.tick();
    const failed = (h.store.dump().find(([k]) => k === "ozzie.responsibilities.noticed.v1")![1]);
    const items = (JSON.parse(failed) as { items: NoticedItem[] }).items;
    const item = items.find(i => i.kind === "couldnt-check")!;
    expect(item).toMatchObject({ system: "b1", church: CHURCH.cedar.church, read: "timeout" });
  });
});

describe("after an upgrade: jobs from before churches were kept", () => {
  /** A job as 0.7.0 left it: it ran, and nothing on this Mac says which church it was for. */
  async function fromBefore() {
    const h = switching();
    await h.unknown();
    await h.runner.create(keepPlan(ET));
    await h.runner.tick();
    // What 0.7.0 kept: no church for the job, and items with no church or system.
    for (const key of ["ozzie.responsibilities.churches.v1", "ozzie.responsibilities.switch.v1"]) h.store.set(key, "");
    const kept = JSON.parse(h.store.get("ozzie.responsibilities.noticed.v1")!) as { version: 1; items: NoticedItem[] };
    h.store.set("ozzie.responsibilities.noticed.v1", JSON.stringify({ ...kept, items: kept.items.map(({ church: _c, system: _s, ...rest }) => { void _c; void _s; return rest; }) }));
    h.relaunch();
    return h;
  }
  it("on the Planning Center church in use it belongs to that church: no question, nothing paused, no burst of notices", async () => {
    const h = await fromBefore();
    await h.use("harbor");
    expect(h.runner.view().questions).toBeUndefined();
    h.set("2026-11-20T17:00:30.000Z");
    await h.runner.tick();
    expect(h.calls()).toEqual(["begin start", "begin scheduled"]);
    expect(h.notify).not.toHaveBeenCalled();
    expect(JSON.parse(h.store.get("ozzie.responsibilities.churches.v1")!)).toEqual({ [h.fake.items[0]!.id]: CHURCH.harbor });
    // Its items from before are Harbor's and still shown.
    expect(h.runner.view().noticed.length).toBe(2);
    expect(h.runner.view().noticed.every(i => i.church === CHURCH.harbor.church)).toBe(true);
  });

  it("on B1 Church it was Planning Center's (jobs ran nowhere else): asked about once, its old items not shown", async () => {
    const h = await fromBefore();
    await h.use("cedar");
    const q = h.runner.view().questions![0]!;
    expect(switchQuestionText(q).title).toBe("Keep services covered was set up for your church on Planning Center. Keep it for Cedar Hollow Fellowship on B1 Church?");
    expect(h.runner.view().noticed).toEqual([]);
    expect(h.notify).not.toHaveBeenCalled();
  });
});

const actions: PlanActions = { start: async () => ({}), onSettings: () => {}, onAutomatic: () => {} };
const fakeRunner = (v: RunnerView, answers: [string, boolean][] = []): Runner => ({
  start() {}, refresh: async () => {}, tick: async () => {}, wake() {}, takes: () => false, changes: async () => false, captured() {}, pausedElsewhere: async () => {},
  create: async () => v.items[0]!, edit: async () => v.items[0]!, pause: async () => {}, resume: async () => {}, stop: async () => {}, pauseAll: async () => {},
  runNow: async () => ({ status: "skipped" }), markSeen() {}, clearOpenToday() {}, keepWriteupsFor() {}, forgetAllWriteups() {},
  answerSwitch: async (id, keep) => { answers.push([id, keep]); }, view: () => v, subscribe: () => () => {},
});
const job = (over: Partial<Responsibility> = {}): Responsibility => ({ ...keepPlan(CT), id: "00000000-0000-4000-8000-000000000001", title: "Keep Sunday covered", skill_id: "sunday-ready",
  status: "active", created_at: FRI, confirmed_at: FRI, runs: [], open_run: null, ...over });
const QUESTION = { responsibility_id: "00000000-0000-4000-8000-000000000001", template: "keep-sunday-covered" as const, title: "Keep Sunday covered", from: CHURCH.harbor, to: CHURCH.cedar };
const view = (over: Partial<RunnerView> = {}): RunnerView => ({ available: true, paused_all: false, items: [], noticed: [], writeups: {}, next: {}, running: null, unseen: 0, open_today: false, ...over });
const render = (system: "b1" | null, el: React.ReactElement) => text(renderToStaticMarkup(React.createElement(SystemWordsContext.Provider, { value: systemWords(system) }, el)));
const context: PlanContext = { organization: CHURCH.cedar.church!, granted: ["services"], modelReady: true, connected: true, zone: CT, macZone: ET, now: () => FRI, church: "Cedar Hollow Fellowship" };

describe("where the question appears", () => {
  it("Keeping watch: first, with both buttons, in place of the offer to set the job up again", () => {
    const v = view({ questions: [QUESTION] });
    const page = render("b1", React.createElement(ResponsibilityList, { view: v, context, runner: fakeRunner(v), actions, sunday: React.createElement("p", null, "regular") }));
    expect(page).toContain("Paused · needs your answer Keeping watch Keep services covered was set up for Harbor Example Church on Planning Center. Keep it for Cedar Hollow Fellowship on B1 Church?");
    expect(page).toContain("Yes, keep it for Cedar Hollow Fellowship No, stop it");
    expect(page).not.toContain("Set up Keep services covered");
    const html = renderToStaticMarkup(React.createElement(ResponsibilityList, { view: v, context, runner: fakeRunner(v), actions }));
    // Real buttons (keyboard), each described by the question.
    expect(html).toMatch(/<button type="button" class="btn btn-primary btn-sm" aria-describedby="switch-q-00000000-0000-4000-8000-000000000001">Yes, keep it for Cedar Hollow Fellowship<\/button>/u);
  });

  it("Today: under Needs your attention, counted there", () => {
    const store = () => { const m = new Map<string, string>(); return { get: (k: string) => m.get(k) ?? null, set: (k: string, x: string) => { m.set(k, x); } }; };
    const page = render("b1", React.createElement(TodayPage, { brief: null, onSunday: () => {}, now: FRI, zone: ET, store: store(),
      watch: { view: view({ questions: [QUESTION] }), now: FRI, onAutomatic: () => {}, onOpen: () => {}, runner: { answerSwitch: async () => {} } } }));
    expect(page).toMatch(/Needs your attention 2 items .*Paused · needs your answer Keeping watch Keep services covered was set up for Harbor Example Church on Planning Center\. Keep it for Cedar Hollow Fellowship on B1 Church\?/u);
    expect(page).toContain("Yes, keep it for Cedar Hollow Fellowship No, stop it");
  });

  it("a run is said in the system it read: an old Planning Center run stays Planning Center's on a B1 Church page", () => {
    const pcRun = { run_id: "00000000-0000-4000-8000-0000000000aa", trigger: "scheduled" as const, started_at: FRI, ended_at: FRI, outcome: "failed" as const, code: "provider-failure" as const,
      noticed: 0, drafts: 0, ai_steps: 0 };
    const old = view({ items: [job({ runs: [pcRun] })] });
    expect(render("b1", React.createElement(ResponsibilityList, { view: old, context, runner: fakeRunner(old), actions, sunday: null }))).toContain("Couldn't finish: Planning Center didn't answer.");
    const mine = view({ items: [job({ runs: [pcRun] })], run_systems: { [pcRun.run_id]: "b1" } });
    expect(render("b1", React.createElement(ResponsibilityList, { view: mine, context, runner: fakeRunner(mine), actions, sunday: null }))).toContain("Couldn't finish: B1 Church didn't answer.");
  });
});

describe("the switch questions say what happens to jobs", () => {
  const asked: ChurchSwitch = { to: "1002", to_name: "Second Street Church", from: "1001", from_name: "Harbor Example Church", others: ["1001"], fresh: true } as ChurchSwitch;
  it("Planning Center to another Planning Center church: only where there are jobs, the rest exactly as before", () => {
    const before = switchCopy(asked).effects;
    expect(switchCopy(asked, { from: false, to: false }, 0, 0).effects).toEqual(before);
    const two = switchCopy(asked, { from: false, to: false }, 0, 2).effects;
    expect(two).toContain("Ozzie's own check stays set up: it checks Second Street Church on its schedule once you choose which of its services to check. Your 2 jobs in Keeping watch pause until you say whether to keep each one for Second Street Church.");
    expect(two.filter(l => !before.includes(l))).toHaveLength(1);
    expect(switchCopy(asked, { from: false, to: false }, 0, 1).effects.join(" ")).toContain("Your job in Keeping watch pauses until you say whether to keep it for Second Street Church.");
  });
  /** Jobs confirmed for Harbor on Planning Center. */
  const harbor = (...templates: JobAtStake["template"][]): JobAtStake[] => templates.map(template => ({ template, church: CHURCH.harbor }));
  it("another system: jobs pause until you answer for the church you connect, or wait on Genesis", () => {
    expect(switchForgets("planning-center", null, 0, harbor("keep-sunday-covered"), "b1")).toBe("Switching signs Ozzie out of Planning Center on this Mac. Nothing changes in Planning Center, and your Church rules stay here. Its saved checks stay on this Mac until you delete them in Settings. Switching back asks you to allow Ozzie in Planning Center again. Your job in Keeping watch pauses until you say whether to keep it for the church you connect.");
    expect(switchForgets("b1", "Cedar Hollow Fellowship", 0, harbor("keep-sunday-covered", "morning-briefing"), "genesis")).toBe("Switching forgets Cedar Hollow Fellowship in B1 Church on this Mac: the key in this Mac's Keychain, the church, the service Ozzie watches and its saved checks. Nothing changes in B1 Church. Your 2 jobs in Keeping watch wait: Genesis shares no volunteer schedules, so no job reads it.");
    // Only the jobs the new system runs are asked about (review L3); the rest wait, said as that.
    expect(switchForgets("planning-center", null, 0, harbor("keep-sunday-covered", "watch-room-bookings"), "b1")).toBe("Switching signs Ozzie out of Planning Center on this Mac. Nothing changes in Planning Center, and your Church rules stay here. Its saved checks stay on this Mac until you delete them in Settings. Switching back asks you to allow Ozzie in Planning Center again. Your job in Keeping watch pauses until you say whether to keep it for the church you connect. The other one waits until you're back on Planning Center: B1 Church doesn't share rooms, follow-ups or group meetings.");
    expect(switchForgets("planning-center", null, 0, harbor("watch-room-bookings", "group-night-clashes"), "breeze")).toBe("Switching signs Ozzie out of Planning Center on this Mac. Nothing changes in Planning Center, and your Church rules stay here. Its saved checks stay on this Mac until you delete them in Settings. Switching back asks you to allow Ozzie in Planning Center again. Your 2 jobs in Keeping watch wait until you're back on Planning Center: Breeze doesn't share rooms, follow-ups or group meetings.");
    expect(switchForgets("b1", "Cedar Hollow Fellowship", 0, harbor("keep-sunday-covered", "watch-room-bookings"), "planning-center")).toContain("Your 2 jobs in Keeping watch pause until you say whether to keep each one for the church you connect.");
    // Back to Harbor (third-pass review, L3): Harbor's own job resumes with no question, so only Cedar Hollow's is asked about.
    const both: JobAtStake[] = [{ template: "keep-sunday-covered", church: CHURCH.cedar }, { template: "watch-room-bookings", church: CHURCH.harbor }];
    expect(switchForgets("b1", "Cedar Hollow Fellowship", 0, both, "planning-center", CHURCH.harbor.church)).toBe("Switching forgets Cedar Hollow Fellowship in B1 Church on this Mac: the key in this Mac's Keychain, the church, the service Ozzie watches and its saved checks. Nothing changes in B1 Church. Your job in Keeping watch pauses until you say whether to keep it for the church you connect.");
    expect(jobsAtStake(both, "planning-center", CHURCH.harbor.church)).toEqual({ asked: 1, waiting: 0 });
    // One from before churches were kept is taken over by any Planning Center church: no question either.
    expect(jobsAtStake([{ template: "morning-briefing", church: { church: null, name: null, system: "planning-center" } }], "planning-center", "1002")).toEqual({ asked: 0, waiting: 0 });
    expect(switchForgets("b1", "Cedar Hollow Fellowship")).toBe("Switching forgets Cedar Hollow Fellowship in B1 Church on this Mac: the key in this Mac's Keychain, the church, the service Ozzie watches and its saved checks. Nothing changes in B1 Church.");
  });
});


describe("second-pass review fixes", () => {
  it("M1: after a switch to B1 Church whose setup isn't finished, nothing of Harbor's is shown, and it doesn't run", async () => {
    const h = switching();
    await h.use("harbor");
    await h.runner.create(keepPlan(ET));
    await h.runner.tick();
    expect(h.runner.view().items).toHaveLength(1);
    await h.noChurch("b1");
    const v = h.runner.view();
    expect(v.items).toEqual([]);
    expect(v.noticed).toEqual([]);
    expect(v.questions).toBeUndefined();
    h.set("2026-11-20T18:00:30.000Z");
    await h.runner.tick();
    expect(h.calls()).toEqual(["begin start"]);
  });

  it("third pass, M1: Planning Center disconnected or its sign-in revoked: Harbor's job and items stay shown, waiting, and nothing runs", async () => {
    const h = switching();
    await h.use("harbor");
    await h.runner.create(keepPlan(ET));
    await h.runner.tick();
    await h.noChurch("planning-center");
    const v = h.runner.view();
    expect(v.items.map(r => r.template)).toEqual(["keep-sunday-covered"]);
    expect(v.noticed.map(i => i.church)).toEqual([CHURCH.harbor.church]);
    expect(v.questions).toBeUndefined();
    // Keeping watch: its card, waiting with the reason, and no offer to set it up again.
    const page = render(null, React.createElement(ResponsibilityList, { view: v, context: { ...context, organization: "1001", connected: false, zone: ET },
      runner: fakeRunner(v), actions, sunday: React.createElement("p", null, "regular") }));
    expect(page).toContain("Next check As soon as Planning Center is connected.");
    expect(page).not.toContain("Set up Keep services covered");
    h.set("2026-11-20T18:00:30.000Z");
    await h.runner.tick();
    expect(h.calls()).toEqual(["begin start"]);
  });

  it("third pass, M1: the pages are redrawn as soon as the church they show changes, with nothing read from native for it", async () => {
    const h = switching();
    await h.use("harbor");
    await h.runner.create(keepPlan(ET));
    await h.runner.tick();
    const lists = () => h.fake.calls.length;
    const before = lists();
    let drawn = 0;
    h.runner.subscribe(() => { drawn++; });
    h.runner.churchInUse({ church: null, name: null, system: "b1" });
    for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));
    expect(h.runner.view().items).toEqual([]);
    expect(drawn).toBeGreaterThan(0);
    // A disconnect on the same system: Harbor's still shown, its next time no longer promised (its card says what it waits for).
    const h2 = switching();
    await h2.use("harbor");
    const r = await h2.runner.create(keepPlan(ET));
    await h2.runner.tick();
    expect(h2.runner.view().next[r.id]).not.toBeNull();
    const calls2 = h2.fake.calls.length;
    h2.runner.churchInUse({ church: null, name: null, system: "planning-center" });
    for (let i = 0; i < 5; i++) await new Promise(r2 => setTimeout(r2, 0));
    expect(h2.runner.view().items).toHaveLength(1);
    expect(h2.fake.calls.length).toBe(calls2);
    await h2.runner.tick();
    expect(h2.runner.view().next[r.id]).toBeNull();
    expect(lists()).toBe(before);
  });

  it("third pass, M1: a launch before Planning Center's status arrives (or never, past the 20-second wait): its jobs and items are shown", async () => {
    const h = switching();
    await h.use("harbor");
    await h.runner.create(keepPlan(ET));
    await h.runner.tick();
    h.relaunch();
    await h.noChurch("planning-center");
    expect(h.runner.view().items.map(r => r.template)).toEqual(["keep-sunday-covered"]);
    expect(h.runner.view().noticed).toHaveLength(1);
    h.set("2026-11-20T18:00:30.000Z");
    await h.runner.tick();
    expect(h.calls()).toEqual(["begin start"]);
  });

  it("third pass, L1: a time missed while Planning Center was disconnected is said as that once it is back", async () => {
    const h = switching();
    await h.use("harbor");
    await h.runner.create(keepPlan(ET));
    await h.runner.tick();
    // Disconnected; its 12:00 PM time comes while Planning Center isn't connected (as the runner test's own case).
    await h.noChurch("planning-center");
    h.set("2026-11-20T17:00:00.000Z");
    await h.runner.tick();
    await h.back("harbor");
    h.set("2026-11-20T17:30:00.000Z");
    await h.runner.tick();
    const missed = h.runner.view().noticed.find(i => i.kind === "missed")!;
    expect(missed).toMatchObject({ missed_reason: "waiting" });
    expect(noticedTitle(missed, h.now())).toMatch(/^Planning Center wasn't connected at .+, so Ozzie checked at .+ instead\.$/u);
  });

  it("third pass, L2: a check of the job's own church rejected because the church changed as it read ends quietly", async () => {
    const h = switching();
    await h.use("harbor");
    await h.runner.create(keepPlan(ET));
    await h.runner.tick();
    // Harbor's check comes back after the app moved to Cedar Hollow (the runner not told yet): App's belongs refuses it.
    h.check.mockImplementationOnce(async () => { const c = pcAt(h.now(), CHURCH.harbor.church!); h.flipTo("cedar"); return c; });
    h.set("2026-11-20T17:00:30.000Z");
    await h.runner.tick();
    expect(h.fake.calls.at(-1)).toBe("end failed cancelled 0 0");
    expect(h.runner.view().noticed.filter(i => i.kind === "couldnt-check")).toEqual([]);
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("L1: a job never runs, reads or tells for a church the app already uses but hasn't told the runner about yet", async () => {
    const h = switching();
    await h.use("harbor");
    await h.runner.create(keepPlan(ET));
    await h.runner.tick();
    // The app is on Cedar Hollow already; the runner hasn't been told. A catch-up time passes.
    h.flipTo("cedar");
    h.set("2026-11-20T23:30:00.000Z");
    await h.runner.tick();
    expect(h.calls()).toEqual(["begin start"]);
    expect(h.check).toHaveBeenCalledTimes(1);
    expect(h.notify).not.toHaveBeenCalled();
    // When it is told, the question comes, and nothing was kept of Cedar Hollow for Harbor's job.
    await h.use("cedar");
    expect(h.runner.view().questions).toHaveLength(1);
    expect(JSON.parse(h.store.get("ozzie.responsibilities.noticed.v1")!).items.filter((i: NoticedItem) => i.church === CHURCH.cedar.church)).toEqual([]);
  });

  it("L1: a check that turns out to be another church's ends the run quietly: nothing kept, nothing told", async () => {
    const h = switching();
    await h.use("harbor");
    await h.runner.create(keepPlan(ET));
    await h.runner.tick();
    // The church changes while the check reads, and it comes back from Cedar Hollow (what App's check gives then).
    h.check.mockImplementationOnce(async () => { h.flipTo("cedar"); return systemJobCheck(b1At(h.now()), CT)!; });
    h.set("2026-11-20T17:00:30.000Z");
    await h.runner.tick();
    expect(h.fake.calls.at(-1)).toBe("end failed cancelled 0 0");
    expect(h.runner.view().noticed.every(i => i.church === CHURCH.harbor.church)).toBe(true);
    expect(h.runner.view().noticed).toHaveLength(1);
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("L2: a job from before churches were kept, asked about on B1 Church, is simply taken over by the Planning Center church switched to", async () => {
    const h = switching();
    await h.unknown();
    await h.runner.create(keepPlan(ET));
    await h.runner.tick();
    for (const key of ["ozzie.responsibilities.churches.v1", "ozzie.responsibilities.switch.v1"]) h.store.set(key, "");
    const kept = JSON.parse(h.store.get("ozzie.responsibilities.noticed.v1")!) as { version: 1; items: NoticedItem[] };
    h.store.set("ozzie.responsibilities.noticed.v1", JSON.stringify({ ...kept, items: kept.items.map(({ church: _c, ...rest }) => { void _c; return rest; }) }));
    h.relaunch();
    await h.use("cedar");
    expect(h.runner.view().questions).toHaveLength(1);
    await h.use("harbor");
    expect(h.runner.view().questions).toBeUndefined();
    expect(JSON.parse(h.store.get("ozzie.responsibilities.churches.v1")!)).toEqual({ [h.fake.items[0]!.id]: CHURCH.harbor });
    h.set("2026-11-20T17:00:30.000Z");
    await h.runner.tick();
    expect(h.calls()).toEqual(["begin start", "pause", "resume", "begin scheduled"]);
    expect(h.notify).not.toHaveBeenCalled();
  });
});
