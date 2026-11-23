// Jobs for a church on B1 Church or Breeze (0.8.0): Keep services covered and the morning briefing, through the same plan
// screen, runner, limits, lifetime, pause and stop, missed-run reporting, notices and write-ups as Planning Center's, said
// in the system's own name, over the system check Ozzie already makes. Fixed fictional captures only (core
// church-systems fixtures), a fake native store, a fake clock and a scripted model; nothing native runs and nothing is
// read from any church system.
import { existsSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => { throw new Error("NATIVE_CALL_FORBIDDEN"); }) }));
vi.mock("server-only", () => ({}));
import { defaultPlan, parseRequest, type Plan } from "../../../core/src/harness/responsibilities.js";
import { DEFAULT_QUIET_HOURS } from "../../../core/src/schedule.js";
import { buildSystemBrief } from "../../../core/src/church-systems/brief.js";
import type { SystemCapture } from "../../../core/src/church-systems/types.js";
import { buildSpokenBriefing } from "../../../core/src/spoken-briefing.js";
import { bundledSkills } from "../../../core/src/harness/bundled-skills.js";
import type { AgentStepReply, AgentStepRequest, ModelStep } from "../../../core/src/harness/contract.js";
import { Harness } from "../../../core/src/harness/index.js";
import { TsLoop } from "../../../core/src/harness/ts-loop.js";
import { nov22Capture } from "../../../core/src/fictional-sunday.js";
import { b1Capture, breezeCapture, breezeUntimedCapture } from "../../../core/test/church-systems/fixtures.js";
import { SystemWordsContext, systemWords } from "../src/church-system.js";
import { SystemReadFailure } from "../src/proactive.js";
import { createRunner, type NoticedItem, type Prepared, type RunnerContext, type RunnerView, type Runner } from "../src/responsibility-runner.js";
import { NoticedCard, PlanCard, ResponsibilityList, TemplatePicker, startedText, type PlanActions, type PlanContext } from "../src/responsibility-views.js";
import { noticedChanges, noticedTitle, runText } from "../src/responsibility-words.js";
import { SundayReadyBrief } from "../src/sunday-ready.js";
import { forSystem, runsOn, systemJobCheck, systemJobHarness, SYSTEM_TEMPLATES } from "../src/system-jobs.js";
import { keptWriteup } from "../src/harness-bridge.js";
import { HIDDEN_WORDS, text } from "./harness-fakes.js";
import { ONLY_PLANNING_CENTER } from "../src/system-settings.js";
import { helpFor } from "../src/ask-panel.js";
import { progressEmptyText } from "../src/today-groups.js";
import { fakeJobStore, memoryStore } from "./job-fakes.js";

const ET = "America/New_York", CT = "America/Chicago";
// ozzie.church's own request check (not part of the public repository: there, that part is skipped).
const REQUESTS = "../../../web/src/lib/hosted/requests.js";
const VOCABULARY = "../../../web/src/lib/hosted/fixed/vocabulary.json";
const SITE = existsSync(new URL(VOCABULARY, import.meta.url));
const RULES = { sundayLeads: [], checkInAfterSundaysInARow: 3 };
/** Friday 20 November 2026, 9:05 AM in Chicago, 10:05 AM in New York: two days before each fictional church's Sunday. */
const FRI = "2026-11-20T15:05:00.000Z";
type System = "b1" | "breeze";
const NAME: Readonly<Record<System, string>> = { b1: "B1 Church", breeze: "Breeze" };
const CHURCH: Readonly<Record<System, string>> = { b1: "b1:CHU0000cedar", breeze: "breeze:juniperstreet" };
/** The words a page says about Planning Center by name, other than a line that something works with Planning Center only. */
const misnamed = (t: string) => t.replace(/[^.]*works? with Planning Center only for now[^.]*\./gu, "").replace(/Ozzie can't do (?:this|these) with [A-Za-z0-9 ]+ yet\./gu, "").match(/Planning Center/gu) ?? [];
const at = (iso: string, minutes: number) => new Date(Date.parse(iso) + minutes * 60_000).toISOString();

/** A capture as native hands it at `iso`: every time it was read moved to then (its service stays where it is). */
function readAt(c: SystemCapture, iso: string): SystemCapture {
  const delta = Date.parse(iso) - Date.parse(c.completed_at);
  const shift = (t: string) => new Date(Date.parse(t) + delta).toISOString().replace(/\.\d{3}Z$/u, "Z");
  return { ...c, started_at: shift(c.started_at), completed_at: shift(c.completed_at), reads: c.reads.map(r => ({ ...r, checked_at: shift(r.checked_at) })) };
}
/** B1 Church's Vocals: Rowan, who had said yes, now says no. */
const rowanDeclines = (c: SystemCapture): SystemCapture => ({ ...c, assignments: c.assignments.map(a => a.id === "ASN-rowan" ? { ...a, status: "declined" as const } : a) });
/** Breeze's Usher: Sam, who had said yes, now says no. */
const samDeclines = (c: SystemCapture): SystemCapture => ({ ...c, assignments: c.assignments.map(a => a.id === "V2" ? { ...a, status: "declined" as const } : a) });
/** Juniper Street on Breeze with a number for Usher: 2 wanted, 1 said yes, so 1 more is needed (a decision). */
const breezeOpen = () => breezeCapture({ positions: [{ id: "9628", team_id: null, needed: 2 }],
  assignments: [{ id: "71002", position_id: "9628", person_id: "157802", status: "accepted", asked: null }] });
/** B1 Church didn't give Guitar's number; the rest is whole. */
const b1Partial = () => b1Capture({ positions: b1Capture().positions.map(p => p.id === "POS-guitar" ? { ...p, needed: null } : p) });
/** Breeze shares a number for Usher and none for Teacher; both answers were read. */
const breezePartial = () => breezeCapture({ positions: [{ id: "9627", team_id: null, needed: null }, { id: "9628", team_id: null, needed: 1 }],
  assignments: [{ id: "71001", position_id: "9627", person_id: "157801", status: "accepted", asked: null }, { id: "71002", position_id: "9628", person_id: "157802", status: "unconfirmed", asked: null }] });

/**
 * The runner as App sets it up for a church on `system`: its own checks (the zone confirmed for B1 Church, the system's for
 * Breeze), its jobs' templates, its church's placeholder scope for write-ups.
 */
function setup(system: System, base: () => SystemCapture = system === "b1" ? () => b1Capture() : breezeOpen, over: Partial<RunnerContext> = {}) {
  let now = FRI;
  let change: ((c: SystemCapture) => SystemCapture) | undefined;
  let fail: unknown = null;
  const clock = () => now;
  const store = memoryStore();
  const fake = fakeJobStore(clock);
  const notify = vi.fn(async () => {});
  const zone = system === "b1" ? CT : null;
  const check = vi.fn(async () => {
    if (fail !== null) throw fail;
    const c = readAt(change ? change(base()) : base(), now);
    return systemJobCheck(c, zone)!;
  });
  const prepare = vi.fn(async (): Promise<Prepared | null> => null);
  const churchZone = base().church.time_zone ?? ET;
  const context: RunnerContext = {
    ready: true, granted: ["services"], rules: RULES, zone: zone ?? churchZone, macZone: ET, quiet: DEFAULT_QUIET_HOURS, urgentWithinHours: 48, modelReady: false,
    system, decisionsFor: () => [], ...over,
  };
  const runner = createRunner({ native: fake.native, store, now: clock, notify });
  runner.start({ context: () => context, check, prepare, belongs: c => c.organization === CHURCH[system] || c.organization === `breeze:perlandera` });
  runner.keepWriteupsFor(base().system === "breeze" && base().church.id === "perlandera" ? "breeze:perlandera" : CHURCH[system]);
  return {
    runner, fake, notify, check, prepare, context, store, zone: context.zone,
    now: () => now, set: (iso: string) => { now = iso; },
    changeTo: (f?: (c: SystemCapture) => SystemCapture) => { change = f; },
    failWith: (e: unknown) => { fail = e; },
    start: async (plan: Plan) => { const r = await runner.create(plan); await runner.tick(); return r; },
  };
}
/** Keep services covered as its plan screen offers it, on the church's clock. */
const keepPlan = (zone: string): Plan => defaultPlan("keep-sunday-covered", FRI, zone, { sunday: "2026-11-22" });

const render = (system: System | null, el: React.ReactElement) =>
  text(renderToStaticMarkup(React.createElement(SystemWordsContext.Provider, { value: systemWords(system) }, el)));
const actions: PlanActions = { start: async () => ({}), onSettings: () => {}, onAutomatic: () => {} };
const planContext = (system: System, over: Partial<PlanContext> = {}): PlanContext => ({
  organization: CHURCH[system], granted: ["services"], modelReady: true, connected: true, zone: system === "b1" ? CT : ET, macZone: ET, now: () => FRI,
  church: system === "b1" ? "Cedar Hollow Fellowship" : "Juniper Street Church", ...over,
});
const fakeRunner = (v: RunnerView): Runner => ({
  start() {}, refresh: async () => {}, tick: async () => {}, wake() {}, takes: () => false, changes: async () => false, captured() {}, pausedElsewhere: async () => {},
  create: async () => v.items[0]!, edit: async () => v.items[0]!,
  pause: async () => {}, resume: async () => {}, stop: async () => {}, pauseAll: async () => {}, runNow: async () => ({ status: "skipped" }),
  markSeen() {}, clearOpenToday() {}, keepWriteupsFor() {}, forgetAllWriteups() {}, view: () => v, subscribe: () => () => {},
});

describe.each(["b1", "breeze"] as const)("%s: the plan screen", system => {
  const name = NAME[system];
  it("offers Keep services covered and the morning briefing, and says plainly that the rest work with Planning Center only", () => {
    const page = render(system, React.createElement(TemplatePicker, { context: planContext(system), actions, onCancel: () => {} }));
    expect(page).toContain("Keep services covered");
    expect(page).toContain("Morning briefing");
    expect(page).not.toMatch(/Watch room bookings|Follow-ups without an owner|Group night clashes/u);
    expect(page).toContain(`Watching room bookings, follow-ups and group meetings works with Planning Center only for now. Ozzie can't do this with ${name} yet.`);
    expect(misnamed(page)).toEqual([]);
  });

  it("one confirmation: what it watches in the system's words, its accounts, when, limits, until when and how to stop", () => {
    const zone = system === "b1" ? CT : ET;
    const page = render(system, React.createElement(PlanCard, { plan: keepPlan(zone), context: planContext(system), actions }));
    expect(page).toContain(`Plan · not started yet ${name}`);
    expect(page).toContain(system === "b1"
      ? "What Ozzie will watch Open roles, and who has accepted or declined, for the service Ozzie watches."
      : "What Ozzie will watch Who has said yes, hasn't answered or said no on each role of the service Ozzie watches, and open roles where Breeze gives a number.");
    expect(page).toContain(`Accounts ${name}, ${system === "b1" ? "Cedar Hollow Fellowship" : "Juniper Street Church"}. Reads only.`);
    expect(page).toContain("Limits At most 6 checks a day. Uses the AI at most 12 times a day to write a short summary; it sees labels, not the names Ozzie read.");
    expect(page).toContain(`It only reads. It never changes anything in ${name}. It won't contact anyone; you decide what happens next.`);
    expect(page).toContain("How to stop Stop it any time in Keeping watch.");
    expect(page).toContain("Looks good — start it");
    expect(page).not.toContain("scheduled leads");
    expect(misnamed(page)).toEqual([]);
    expect(page).not.toMatch(HIDDEN_WORDS);
    // Without AI help, it says what the system shows.
    const off = render(system, React.createElement(PlanCard, { plan: defaultPlan("morning-briefing", FRI, zone), context: planContext(system, { modelReady: false }), actions }));
    expect(off).toContain(`No AI model is set up, so Ozzie reports what ${name} shows without a written summary.`);
    expect(off).toContain("Thursday's includes the full “Ready for Sunday” brief.");
  });

  it("before the system can be checked, says why in its own words and that the first check waits", () => {
    const zone = system === "b1" ? CT : ET;
    const why = system === "b1" ? "Confirm your church's time zone under Settings, then checks start on their own." : `Finish setting up ${name}, then checks start on their own.`;
    const page = render(system, React.createElement(PlanCard, { plan: keepPlan(zone), context: planContext(system, { connected: false, notReady: why }), actions }));
    expect(page).toContain(`${why} The first check waits until then.`);
    expect(startedText(keepPlan(zone), planContext(system, { connected: false }), undefined, systemWords(system)))
      .toMatch(new RegExp(`^Ozzie will check as soon as ${name} can be checked, then every day at 7:00 AM`, "u"));
    expect(misnamed(page)).toEqual([]);
  });
});

describe("asking Ozzie to take something on, on B1 Church or Breeze", () => {
  const parse = (typed: string) => parseRequest(typed, FRI, CT, { sunday: "2026-11-22" });
  it("plans Keep services covered and the morning briefing; the rest is said plainly to work with Planning Center only", () => {
    expect(forSystem(parse("Keep an eye on Sunday for me"))).toMatchObject({ plan: { kind: "plan", plan: { template: "keep-sunday-covered" } }, notHere: false });
    expect(forSystem(parse("Give me a morning briefing every weekday"))).toMatchObject({ plan: { kind: "plan", plan: { template: "morning-briefing" } }, notHere: false });
    expect(forSystem(parse("Watch room bookings for me"))).toEqual({ plan: { kind: "none" }, notHere: true });
    expect(forSystem(parse("Keep an eye on follow-ups"))).toEqual({ plan: { kind: "none" }, notHere: true });
    // A request that doesn't say what: only what can run here is offered.
    const what = forSystem(parse("Keep an eye on things for me"));
    expect(what.notHere).toBe(false);
    if (what.plan.kind === "ask" && what.plan.need === "what") expect(what.plan.choices.every(t => SYSTEM_TEMPLATES.includes(t))).toBe(true);
    expect(forSystem(parse("What still needs a decision?"))).toEqual({ plan: { kind: "none" }, notHere: false });
    expect(runsOn("watch-room-bookings", "b1")).toBe(false);
    expect(runsOn("watch-room-bookings", null)).toBe(true);
  });
});

describe.each(["b1", "breeze"] as const)("%s: a job, from its first check to what Ozzie noticed", system => {
  const name = NAME[system];
  it("starts through the plan, checks the system once (never Planning Center), and tells the person in Ozzie, not with a notice", async () => {
    const h = setup(system);
    const r = await h.start(keepPlan(h.zone));
    expect(h.fake.calls.slice(0, 3)).toEqual(["create keep-sunday-covered", "begin start", expect.stringMatching(/^end ok - \d+ \d+$/u)]);
    expect(h.check).toHaveBeenCalledTimes(1);
    const item = h.runner.view().noticed[0]!;
    expect(item).toMatchObject({ responsibility_id: r.id, kind: "found", trigger: "start", notice: "in-app", system, check: { plan_id: system === "b1" ? "PLA0000nov22" : "88120031" } });
    expect(item.decisions).toBeGreaterThan(0);
    expect(h.notify).not.toHaveBeenCalled();
    const title = noticedTitle(item, h.now());
    expect(title).toMatch(/^Keep services covered: \d+ things? needs? a decision\.$/u);
    expect(misnamed(title)).toEqual([]);
    // What it keeps on this Mac names no one: ids, counts and codes only.
    const kept = JSON.stringify(h.store.dump());
    for (const n of Object.values((system === "b1" ? b1Capture() : breezeOpen()).names)) expect(kept).not.toContain(n.split(" ")[0]);
  });

  it("a later check finding nothing new tells no one", async () => {
    const h = setup(system);
    await h.start(keepPlan(h.zone));
    // The next scheduled time (12:00 PM on the church's clock, two days before Sunday).
    h.set(system === "b1" ? "2026-11-20T18:00:30.000Z" : "2026-11-20T17:00:30.000Z");
    await h.runner.tick();
    expect(h.fake.calls).toContain("begin scheduled");
    const item = h.runner.view().noticed[0]!;
    expect(item).toMatchObject({ trigger: "scheduled", notice: "none", changes: [] });
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("a later check finding a change sends one private notice with no names, and says the change on this Mac only", async () => {
    const base = system === "b1" ? () => b1Capture() : () => breezeUntimedCapture();
    const h = setup(system, base);
    await h.start(keepPlan(h.zone));
    h.changeTo(system === "b1" ? rowanDeclines : samDeclines);
    h.set(system === "b1" ? "2026-11-20T18:00:30.000Z" : "2026-11-20T18:00:30.000Z");
    await h.runner.tick();
    expect(h.notify).toHaveBeenCalledTimes(1);
    // The notice is native's fixed line, by kind: the page passes no text at all.
    expect(h.notify.mock.calls[0]).toEqual(["needs-decision"]);
    const item = h.runner.view().noticed[0]!;
    expect(item).toMatchObject({ kind: "found", notice: "sent", system });
    const said = noticedChanges(item, base().names);
    expect(said).toContain(system === "b1" ? "Rowan Fictional declined Vocals after confirming." : "Sam Fictional declined Usher after confirming.");
    // Without this Mac's names, nobody is named.
    expect(noticedChanges(item, {}).join(" ")).not.toMatch(/Rowan|Sam|Fictional/u);
    expect(JSON.stringify(h.store.dump())).not.toMatch(/Rowan|Sam Fictional|Fictional/u);
  });

  it("a check of the regular schedule that found a change hands it over: the job runs on that check and sends the one notice", async () => {
    const h = setup(system);
    await h.start(keepPlan(h.zone));
    h.set(at(FRI, 30));
    const shared = systemJobCheck(readAt(system === "b1" ? rowanDeclines(b1Capture()) : b1Capture(), h.now()), h.zone)!;
    if (system !== "b1") return; // Breeze's change is covered above; this one is the hand-over.
    h.runner.captured(shared);
    const decided = await h.runner.changes([{ id: "confirmed-declined:ASN-rowan", kind: "confirmed-declined", effect: "worse", urgency: "urgent", position: "Vocals", person_id: "PER-rowan" }],
      { plan_id: "PLA0000nov22", notice: true });
    expect(decided).toBe(true);
    expect(h.check).toHaveBeenCalledTimes(1);
    expect(h.notify.mock.calls).toEqual([["needs-decision"]]);
  });

  it("limits reached: says so once, plainly, in the job's own words", async () => {
    const h = setup(system);
    await h.start(keepPlan(h.zone));
    h.fake.refuse.always = "checks-limit";
    h.set(system === "b1" ? "2026-11-20T18:00:30.000Z" : "2026-11-20T17:00:30.000Z");
    await h.runner.tick();
    const limit = h.runner.view().noticed.find(i => i.kind === "limit")!;
    expect(limit).toMatchObject({ system });
    expect(noticedTitle(limit, h.now())).toBe("Keep services covered has used its checks for now. It will check again later, within its limits.");
  });

  it("a run missed while this Mac slept is said plainly and caught up once", async () => {
    const h = setup(system);
    await h.start(keepPlan(h.zone));
    h.set("2026-11-21T00:30:00.000Z");
    h.runner.wake(9 * 3_600_000, h.now());
    await h.runner.tick();
    const missed = h.runner.view().noticed.find(i => i.kind === "missed")!;
    expect(missed).toMatchObject({ missed_reason: "asleep", trigger: "catch-up", system });
    expect(noticedTitle(missed, h.now())).toMatch(/^Your Mac was asleep at .+ and 1 other time, so Ozzie checked at .+ instead\.$/u);
    expect(h.fake.calls.filter(c => c === "begin catch-up")).toHaveLength(1);
  });

  it("pause, resume and stop take effect at once; a paused or stopped job doesn't check", async () => {
    const h = setup(system);
    const r = await h.start(keepPlan(h.zone));
    await h.runner.pause(r.id);
    h.set(system === "b1" ? "2026-11-20T18:00:30.000Z" : "2026-11-20T17:00:30.000Z");
    await h.runner.tick();
    expect(h.fake.calls.filter(c => c.startsWith("begin"))).toEqual(["begin start"]);
    await h.runner.resume(r.id);
    await h.runner.stop(r.id);
    h.set("2026-11-21T13:00:30.000Z");
    await h.runner.tick();
    expect(h.fake.calls.filter(c => c.startsWith("begin"))).toEqual(["begin start"]);
    expect(h.runner.view().items[0]!.status).toBe("ended");
  });

  it("a read the system refused says why in the system's own words, and tries again later", async () => {
    const h = setup(system);
    await h.start(keepPlan(h.zone));
    h.failWith(new SystemReadFailure(system, "key-refused", system === "b1" ? "CHU0000cedar" : "juniperstreet"));
    h.set(system === "b1" ? "2026-11-20T18:00:30.000Z" : "2026-11-20T17:00:30.000Z");
    await h.runner.tick();
    const item = h.runner.view().noticed[0]!;
    expect(item).toMatchObject({ kind: "couldnt-check", read: "key-refused", system });
    expect(noticedTitle(item, h.now())).toMatch(new RegExp(`^Ozzie couldn't check your services at .+\\. ${name} no longer accepts the key Ozzie has, so nothing was read\\. Connect ${name} again in Settings with a new key\\. It will try again at .+\\.$`, "u"));
  });

  it("the morning briefing: ready each weekday, and Thursday's includes the full Ready for Sunday brief", async () => {
    const h = setup(system);
    h.set("2026-11-19T13:05:00.000Z");
    await h.start(defaultPlan("morning-briefing", h.now(), h.zone));
    const item = h.runner.view().noticed[0]!;
    expect(item).toMatchObject({ kind: "briefing", sunday_ready: true, system });
    expect(noticedTitle(item, h.now())).toBe("Your morning briefing is ready. Today it includes the full “Ready for Sunday” brief.");
    // Thursday's brief, from the system's own check, as Today's briefing card shows it.
    const capture = readAt(system === "b1" ? b1Capture() : breezeUntimedCapture(), "2026-11-19T15:05:00Z");
    const built = buildSystemBrief(capture, { confirmedZone: system === "b1" ? CT : null }, "2026-11-19T15:10:00Z");
    if (!built.ok) throw new Error(built.reason);
    const brief = render(system, React.createElement(SundayReadyBrief, { brief: built.brief, names: capture.names, onSunday: () => {} }));
    expect(misnamed(brief)).toEqual([]);
    if (system === "breeze") expect(brief).toMatch(/Breeze doesn't share how many people each role needs/u);
    else expect(brief).toContain("Needs a decision Vocals still needs one more person. Guitar still needs one more person.");
  });

  it("jobs that read Planning Center's Calendar, People or Groups wait, unshown, and never check", async () => {
    const h = setup(system);
    // Made while the church used Planning Center: it waits here, and runs again if the church switches back.
    await h.runner.create(defaultPlan("watch-room-bookings", FRI, h.zone));
    await h.runner.tick();
    expect(h.fake.calls).toEqual(["create watch-room-bookings"]);
    expect(h.runner.view().items).toEqual([]);
    const back = (h.context as { system?: unknown }).system;
    (h.context as { system?: unknown }).system = undefined;
    await h.runner.refresh();
    expect(h.runner.view().items.map(r => r.template)).toEqual(["watch-room-bookings"]);
    (h.context as { system?: unknown }).system = back;
  });

  it("a write-up asks the AI with labels only, and says the system as where the facts are", async () => {
    const capture = readAt(system === "b1" ? b1Partial() : breezePartial(), FRI);
    const check = systemJobCheck(capture, system === "b1" ? CT : null)!;
    const data = systemJobHarness(check, RULES, [], FRI)!;
    const sent: AgentStepRequest[] = [];
    const h = new Harness({ workspace_id: "this-mac", data, skills: await bundledSkills(), runtime: new TsLoop(), model: scripted(sent), now: () => FRI,
      newId: () => "00000000-0000-4000-8000-0000000000d1", macZone: ET });
    const outcome = await h.runSkill("sunday-ready");
    expect(outcome.status).toBe("verified");
    const kept = keptWriteup(h, outcome);
    // The part of the check that couldn't be verified is said plainly, the role named on this Mac only.
    expect(kept.lines).toContain(`One role couldn't be checked. ${name} didn't share how many people ${system === "b1" ? "Guitar" : "Teacher"} needs, so Ozzie can't say whether it is full.`);
    expect(kept.based_on).toContain(name);
    expect(misnamed(kept.lines.join(" ") + kept.based_on)).toEqual([]);
    // Nothing a model received names a person or a role.
    nothingNamed(data.brief!.positions.map(p => p.name), Object.values(capture.names), sent);
    // No Planning Center check again, and nothing of Calendar, People or Groups, is offered.
    const offered = sent.flatMap(r => (r.tools ?? []).map(t => t.name));
    expect(offered).not.toContain("planning_center.refresh");
    expect(offered.filter(t => /^(?:rooms|follow_ups|groups|calendar|people)\./u.test(t))).toEqual([]);
    // Through Ozzie's AI, every step is accepted by ozzie.church's own request check, as Ask's are (core
    // church-systems/hosted-step.test.ts): the procedure as a procedure, each tool result with the system as its source.
    if (SITE) {
      const { checkAgentStep } = (await import(/* @vite-ignore */ REQUESTS)) as { checkAgentStep: (body: unknown) => { ok: boolean } };
      for (const step of sent) {
        expect(checkAgentStep({ task_id: step.task_id, messages: step.messages, tools: step.tools, max_tokens: step.max_tokens, kind: "procedure" }), name).toMatchObject({ ok: true });
      }
      expect(sent.length).toBeGreaterThan(1);
      // The check is a real one: the same step sent as a question is refused.
      expect(checkAgentStep({ task_id: sent[1]!.task_id, messages: sent[1]!.messages, tools: sent[1]!.tools, max_tokens: sent[1]!.max_tokens, kind: "ask" })).toMatchObject({ ok: false });
    }
  });
});

describe("Breeze, where no role has a number: the roster's own words", () => {
  it("never says nothing needs a decision; counts the roles that need a look, and says the limit", async () => {
    const h = setup("breeze", () => breezeUntimedCapture());
    await h.start(keepPlan(CT));
    const item = h.runner.view().noticed[0]!;
    // Greeter: someone hasn't answered (the page's one worth a look). Usher has a yes beside its no; Sound has a yes.
    expect(item).toMatchObject({ kind: "found", unnumbered: true, decisions: 0, looks: 1 });
    const title = noticedTitle(item, h.now());
    expect(title).toBe("Keep services covered: 1 thing is worth a look. Breeze doesn't share how many people each role needs, so Ozzie can't say whether this Sunday is covered.");
    expect(h.notify).not.toHaveBeenCalled();
    // Nobody waiting: what is known, never "nothing needs a decision".
    const calm = setup("breeze", () => breezeUntimedCapture({ assignments: breezeUntimedCapture().assignments.map(a => a.id === "V1" ? { ...a, status: "accepted" as const } : a) }));
    await calm.start(keepPlan(CT));
    const clear = calm.runner.view().noticed[0]!;
    expect(clear).toMatchObject({ kind: "clear", unnumbered: true });
    expect(noticedTitle(clear, calm.now())).toMatch(/^Keep services covered: checked at .+\. Nothing new to tell you\. Breeze doesn't share how many people each role needs, so Ozzie can't say whether this Sunday is covered\.$/u);
    const r = calm.runner.view().items[0]!;
    expect(runText(r.runs[0]!, calm.now(), clear)).toMatch(/Finished: nothing new to tell you\.$/u);
    for (const t of [title, noticedTitle(clear, calm.now())]) expect(t).not.toMatch(/nothing needs a decision|Nothing new needs a decision/iu);
  });

  it("Keeping watch and Today's card name no team and suggest no one", () => {
    const item: NoticedItem = { id: "x", responsibility_id: "00000000-0000-4000-8000-000000000001", template: "keep-sunday-covered", at: FRI, kind: "found", looks: 1, unnumbered: true, system: "breeze" };
    const v: RunnerView = { available: true, paused_all: false, items: [], noticed: [item], writeups: {}, next: {}, running: null, unseen: 0, open_today: false };
    const card = render("breeze", React.createElement(NoticedCard, { item, view: v, names: {}, now: FRI, onOpen: () => {} }));
    expect(card).toContain("Breeze doesn't share how many people each role needs");
    expect(card).not.toMatch(/who could help|team/iu);
  });
});

describe.each(["b1", "breeze"] as const)("%s: the spoken briefing", system => {
  const name = NAME[system];
  it("says the service on the church's clock and what couldn't be checked, within two minutes and the voice's limit", () => {
    const partial = system === "b1" ? b1Partial() : breezePartial();
    const built = buildSystemBrief(partial, { confirmedZone: partial.church.time_zone }, "2026-11-20T15:10:00Z");
    if (!built.ok) throw new Error(built.reason);
    const spoken = buildSpokenBriefing({ attention: null, sunday: built.brief }, { timeZone: partial.church.time_zone!, checkedTimeZone: ET });
    expect(spoken.text).toContain(`One role couldn't be checked, so Ozzie won't call Sunday covered. ${name} didn't share how many people ${system === "b1" ? "Guitar" : "Teacher"} needs, so Ozzie can't say whether it is full.`);
    expect(misnamed(spoken.text)).toEqual([]);
    expect(spoken.text.length).toBeLessThan(3800);
    expect(spoken.seconds).toBeLessThanOrEqual(120);
    // A service with many roles still fits: the decisions are read, the rest points to the screen.
    const many = { ...partial, positions: Array.from({ length: 40 }, (_, i) => ({ id: `R${i}`, team_id: partial.positions[0]!.team_id, needed: i % 2 ? 2 : null })),
      labels: { ...partial.labels, ...Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`position:R${i}`, `Role ${i + 1}`])) } };
    const big = buildSystemBrief(many, { confirmedZone: partial.church.time_zone }, "2026-11-20T15:10:00Z");
    if (!big.ok) throw new Error(big.reason);
    const long = buildSpokenBriefing({ attention: null, sunday: big.brief }, { timeZone: partial.church.time_zone!, checkedTimeZone: ET });
    expect(long.text.length).toBeLessThan(3800);
    expect(long.seconds).toBeLessThanOrEqual(120);
  });
});

describe("Keeping watch on B1 Church: the job's card", () => {
  it("speaks B1 Church's name, its checks used, and its write-up's reason in B1 Church's words", () => {
    const plan = keepPlan(CT);
    const r = { ...plan, id: "00000000-0000-4000-8000-000000000001", title: "Keep Sunday covered", skill_id: "sunday-ready", status: "active" as const, created_at: FRI, confirmed_at: FRI,
      runs: [{ run_id: "00000000-0000-4000-8000-0000000000aa", trigger: "start" as const, started_at: FRI, ended_at: FRI, outcome: "failed" as const, code: "provider-failure" as const, noticed: 0, drafts: 0, ai_steps: 0 }], open_run: null };
    const found: NoticedItem = { id: "f", responsibility_id: r.id, template: "keep-sunday-covered", at: FRI, kind: "found", decisions: 2, run_id: "00000000-0000-4000-8000-0000000000ab", system: "b1" };
    // The failed run read B1 Church (its item says so; the runner keeps that by run id), so it is said in B1 Church's name.
    const v: RunnerView = { available: true, paused_all: false, items: [r], noticed: [found], next: { [r.id]: at(FRI, 180) }, running: null, unseen: 0, open_today: false,
      run_systems: { "00000000-0000-4000-8000-0000000000aa": "b1" },
      writeups: { f: { item: "f", responsibility_id: r.id, run_id: found.run_id!, organization: CHURCH.b1, at: FRI, kind: "none", why: "unavailable" } } };
    const page = render("b1", React.createElement(ResponsibilityList, { view: v, context: planContext("b1"), runner: fakeRunner(v), actions, sunday: React.createElement("p", null, "regular") }));
    expect(page).toContain("B1 Church, Cedar Hollow Fellowship");
    expect(page).toContain("Couldn't finish: B1 Church didn't answer.");
    expect(page).toContain("Checks used 1 of 6 in the last 24 hours.");
    expect(page).toContain("Watches Open roles, and who has accepted or declined, for the service Ozzie watches.");
    expect(misnamed(page)).toEqual([]);
    const card = render("b1", React.createElement(NoticedCard, { item: found, view: v, names: {}, now: FRI, onOpen: () => {} }));
    expect(card).toContain("No write-up this time: it couldn't be prepared. This card shows what Ozzie's own check of B1 Church found.");
    expect(misnamed(card)).toEqual([]);
  });
});

describe("a Planning Center check is never a B1 Church or Breeze job's", () => {
  it("a check shared from Planning Center isn't used: the job reads the system itself", async () => {
    const h = setup("b1");
    h.runner.start({ context: () => h.context, check: h.check, prepare: h.prepare, belongs: c => c.organization === CHURCH.b1 });
    h.runner.captured(nov22Capture() as never);
    await h.start(keepPlan(CT));
    expect(h.check).toHaveBeenCalledTimes(1);
    expect(h.runner.view().noticed[0]).toMatchObject({ system: "b1", check: { plan_id: "PLA0000nov22" } });
  });
});

describe.each(["b1", "breeze"] as const)("%s: what Settings, Ask and Today say works", system => {
  const name = NAME[system];
  it("says exactly what works now and what still works with Planning Center only", () => {
    expect(ONLY_PLANNING_CENTER(name)).toBe(`Keep services covered and the morning briefing work with ${name} too; set them up in Keeping watch. Siri and Shortcuts, the copy for other AI apps, and rooms, follow-ups and group meetings (and the jobs that watch them) work with Planning Center only for now. Ozzie can't do these with ${name} yet.`);
    const help = helpFor(systemWords(system));
    expect(help.can).toContain("Give you a morning briefing on Today.");
    expect(help.can.join(" ")).not.toMatch(/room bookings|follow-ups|group meetings|kids team/u);
    // In progress with nothing in it points to Keeping watch, as on Planning Center.
    expect(progressEmptyText({ ready: true, paused: false, running: false, intervalMinutes: 60, runOnLaunch: true, last: null, next: null, missed: [] }, false, systemWords(system)))
      .toBe("Nothing is running. Keep services covered and other jobs start when you set them up in Keeping watch.");
    // Genesis has none, and keeps saying so.
    expect(systemWords("genesis").jobs).toBe(false);
  });
});

// ---- A scripted model, as partial-words.test.ts records 0.5.7's requests with -----------------------------------------

const call = (step: number, name: string): AgentStepReply => ({ content: "", tool_calls: [{ id: `call_${step}_0`, name, arguments: "{}" }], finish: "tool_calls" });
const reply = (o: unknown): AgentStepReply => ({ content: JSON.stringify(o), tool_calls: [], finish: "stop" });
const results = (r: AgentStepRequest) => r.messages.flatMap(m => m.role === "tool" ? [JSON.parse(m.content) as { tool: string; payload: Record<string, unknown> }] : []);
function scripted(sent: AgentStepRequest[], tool = "sunday.overview"): ModelStep {
  return async r => {
    sent.push(r);
    const got = results(r);
    if (!got.length) return call(sent.length, tool);
    const p = got[0]!.payload;
    return reply({ answer: "facts", facts: [p["fact"], ...(Array.isArray(p["findings"]) ? (p["findings"] as { fact: string }[]).map(f => f.fact) : [])] });
  };
}
/** No role's name and no person's name in anything a model received (partial-words.test.ts `nothingNamed`). */
function nothingNamed(roles: readonly string[], names: readonly string[], sent: readonly AgentStepRequest[]) {
  const all = JSON.stringify(sent);
  expect(sent.length).toBeGreaterThan(0);
  for (const role of roles) expect(all, role).not.toContain(role.trim());
  for (const name of names) for (const word of name.split(/\s+/u)) expect(all, word).not.toContain(word);
}
