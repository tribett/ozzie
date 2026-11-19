// Keeping watch, on screen: the plan to confirm, Ask, Keeping watch, Today,
// setup and Settings. Static rendering on fixed fictional data; nothing native runs.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => { throw new Error("NATIVE_CALL_FORBIDDEN"); }) }));
import { defaultPlan, parseRequest, TEMPLATES, untilLifetime, type Plan, type Responsibility, type RunRow } from "../../../core/src/harness/responsibilities.js";
import { nov22Capture } from "../../../core/src/fictional-sunday.js";
import { buildSundayBrief } from "../../../core/src/sunday-brief.js";
import { AskPanel, type PlanHooks, type Turn } from "../src/ask-panel.js";
import {
  againText, AutostartToggle, checksBack, NoticedCard, PlanCard, PlanEditor, PlanTurn, ResponsibilityList, startedText, TemplatePicker, watchLine, WriteUpBlock, type PlanActions, type PlanContext,
} from "../src/responsibility-views.js";
import { leftOutOfAnswer } from "../src/harness-words.js";
import { YourNameField } from "../src/connection-page.js";
import type { NoticedItem, Runner, RunnerView } from "../src/responsibility-runner.js";
import { TodayPage } from "../src/today-page.js";
import { FirstRun } from "../src/setup-flow.js";
import { ConnectionPage } from "../src/connection-page.js";
import { DEFAULT_PREFS } from "../src/proactive.js";
import { ProactivePage } from "../src/proactive-page.js";
import { newSchedule } from "../../../core/src/schedule.js";
import {
  foundText, keepAbout, lifetimeText, noticedTitle, oneOfEach, problemText, purposeText, QUIT_LINE, refusalText, runText, scheduleText, statusText, WATCH_HOW,
} from "../src/responsibility-words.js";
import { HIDDEN_WORDS, text } from "./harness-fakes.js";
import { DayProvider } from "../src/day-words.js";
import { wednesdayWords } from "../../../core/test/fixtures/service-days/wednesday.js";

const ET = "America/New_York";
const FRI = "2026-11-20T15:00:00.000Z";
const names = nov22Capture().names;
const context = (over: Partial<PlanContext> = {}): PlanContext => ({
  organization: "1001", granted: ["services"], modelReady: true, connected: true, zone: ET, now: () => FRI, ...over,
});
const actions: PlanActions = { start: async () => ({}), onSettings: () => {}, onAutomatic: () => {} };
const render = (el: React.ReactElement) => text(renderToStaticMarkup(el));
/** Keep Sunday covered with "Only until this Sunday" chosen (its default is every week until stopped: audit item 23). */
const sunday = (): Plan => ({ ...defaultPlan("keep-sunday-covered", FRI, ET), lifetime: untilLifetime("2026-11-22", ET)! });
const at_ = (iso: string, minutes: number) => new Date(Date.parse(iso) + minutes * 60_000).toISOString();
const NEVER = /\b(?:approve|block|all clear|at risk|drifting|score|rank)\b/iu;

function responsibility(plan: Plan, over: Partial<Responsibility> = {}): Responsibility {
  const t = TEMPLATES[plan.template];
  return { ...plan, id: "00000000-0000-4000-8000-000000000001", title: t.title, skill_id: t.skill_id, status: "active", created_at: FRI, confirmed_at: FRI, runs: [], open_run: null, ...over };
}
const run = (over: Partial<RunRow> = {}): RunRow => ({
  run_id: "00000000-0000-4000-8000-0000000000aa", trigger: "start", started_at: FRI, ended_at: FRI, outcome: "ok", code: null, noticed: 4, drafts: 1, ai_steps: 2, ...over,
});
const view = (over: Partial<RunnerView> = {}): RunnerView => ({
  available: true, paused_all: false, items: [], noticed: [], writeups: {}, next: {}, running: null, unseen: 0, open_today: false, ...over,
});
const fakeRunner = (v: RunnerView): Runner => ({
  start() {}, refresh: async () => {}, tick: async () => {}, wake() {}, takes: () => false, changes: async () => false, captured() {}, pausedElsewhere: async () => {},
  create: async () => v.items[0]!, edit: async () => v.items[0]!,
  pause: async () => {}, resume: async () => {}, stop: async () => {}, pauseAll: async () => {}, runNow: async () => ({ status: "skipped" }),
  markSeen() {}, clearOpenToday() {}, keepWriteupsFor() {}, forgetAllWriteups() {}, view: () => v, subscribe: () => () => {},
});

describe("the plan Ozzie shows before taking something on", () => {
  it("says what it watches, which accounts, when it checks and tells you, until when, its limits and how to stop", () => {
    const page = render(React.createElement(PlanCard, { plan: sunday(), assumed: ["lifetime"], context: context(), actions }));
    for (const line of [
      "Plan · not started yet", "Keep Sunday covered",
      "What Ozzie will watch Open roles, who has accepted or declined, and scheduled leads for the service Ozzie watches.",
      "Accounts Planning Center Services. Reads only.",
      "When it checks Every day at 7:00 AM, and sooner when something changes. Also at 12:00 PM and 5:00 PM in the two days before Sunday.",
      "When it tells you Only when something needs a decision. A private notice on this Mac with no names or details; quiet hours hold it until they end.",
      "Until Until the end of Sunday, November 22. Then it stops on its own.",
      "Limits At most 6 checks a day. Uses the AI at most 12 times a day to write a short summary; it sees labels, not the names Ozzie read.",
      "How to stop Stop it any time in Keeping watch.",
      "You didn't say how long, so this ends after Sunday, November 22. Change it if you meant every week.",
      "It only reads. It never changes anything in Planning Center. It won't contact anyone; you decide what happens next.",
      "Looks good — start it", "Change it", "Not now",
    ]) expect(page).toContain(line);
    expect(page).not.toMatch(HIDDEN_WORDS);
    expect(page).not.toMatch(NEVER);
  });

  it("Keep Sunday covered keeps going every week by default, and Only until this Sunday is a choice (audit item 23)", () => {
    const plan = defaultPlan("keep-sunday-covered", FRI, ET, { sunday: "2026-11-22" });
    const page = render(React.createElement(PlanCard, { plan, context: context(), actions, assumed: ["lifetime"] }));
    expect(page).toContain("Until Every day until you stop it.");
    expect(page).toContain("You didn't say how long, so this runs until you stop it.");
    expect(page).not.toContain("This ends before");
    const editor = render(React.createElement(PlanEditor, { plan, context: context(), onDone: () => {}, onCancel: () => {} }));
    expect(editor).toContain("Until the end of Sunday, November 22");
    expect(renderToStaticMarkup(React.createElement(PlanEditor, { plan, context: context(), onDone: () => {}, onCancel: () => {} })))
      .toMatch(/<option value="until-stopped" selected="">Until you stop it<\/option>/u);
  });

  it("works without an AI model, and before Planning Center is connected says the first check waits", () => {
    const page = render(React.createElement(PlanCard, { plan: sunday(), context: context({ modelReady: false, connected: false }), actions }));
    expect(page).toContain("At most 6 checks a day. No AI model is set up, so Ozzie reports what Planning Center shows without a written summary.");
    expect(page).toContain("Planning Center isn't connected yet, so the first check waits until it is.");
    expect(page).toContain("Looks good — start it");
  });

  it("offers to set up missing access instead of widening it", () => {
    const page = render(React.createElement(PlanCard, { plan: defaultPlan("watch-room-bookings", FRI, ET), context: context(), actions }));
    expect(page).toContain("Room bookings are in Planning Center Calendar, which this connection doesn't include yet. Add rooms, follow-ups and group events under Settings first; Ozzie won't widen its access on its own.");
    expect(page).toContain("Set up access in Settings");
    expect(page).not.toContain("Looks good — start it");
    expect(page).toContain("Every Thursday at 9:00 AM.");
    expect(page).toContain("Weekly until you stop it.");
    const granted = render(React.createElement(PlanCard, { plan: defaultPlan("watch-room-bookings", FRI, ET), context: context({ granted: ["services", "operations"] }), actions }));
    // The church by its name, never its organization number (spec §6).
    expect(granted).toContain("Planning Center Services and Calendar. Reads only.");
    expect(granted).not.toContain("1001");
    expect(granted).toContain("Looks good — start it");
  });

  it("says when a plan would end before the service Ozzie watches", () => {
    const sat = "2026-11-14T15:00:00.000Z";
    const early = { ...defaultPlan("keep-sunday-covered", sat, ET), lifetime: untilLifetime("2026-11-15", ET)! };
    const page = render(React.createElement(PlanCard, { plan: early, context: context({ now: () => sat, sunday: "2026-11-22" }), actions }));
    expect(page).toContain("This ends before Sunday, November 22, the day of the service Ozzie watches. Change it if you meant to keep going until then.");
    const matched = { ...defaultPlan("keep-sunday-covered", sat, ET), lifetime: untilLifetime("2026-11-22", ET)! };
    expect(render(React.createElement(PlanCard, { plan: matched, context: context({ now: () => sat, sunday: "2026-11-22" }), actions }))).not.toContain("This ends before");
  });

  it("says whose clock the times are on when the church's zone isn't this Mac's", () => {
    // The plan carries the zone it was made in (the church's, once a check has read it).
    const chicago = defaultPlan("keep-sunday-covered", FRI, "America/Chicago");
    const central = render(React.createElement(PlanCard, { plan: chicago, context: context({ zone: "America/Chicago", macZone: ET }), actions }));
    expect(central).toMatch(/Every day at 7:00 AM, and sooner when something changes\. .*Times are the church's: Central Time \(America\/Chicago\)\./u);
    expect(render(React.createElement(PlanCard, { plan: sunday(), context: context({ macZone: ET }), actions }))).not.toContain("Times are the church's");
    // A responsibility keeps its own clock, whatever the zone on screen is now.
    const kept = render(React.createElement(ResponsibilityList, {
      view: view({ items: [responsibility(chicago)] }), context: context({ macZone: ET }), runner: fakeRunner(view()), actions,
    }));
    expect(kept).toContain("Times are the church's: Central Time (America/Chicago).");
  });

  it("asks back, in plain words, when the request left something important unclear", () => {
    const what = parseRequest("Keep an eye on things for me", FRI, ET);
    if (what.kind === "none") throw new Error("none");
    const asked = render(React.createElement(PlanTurn, { parsed: what, context: context(), actions }));
    expect(asked).toContain("What should Ozzie keep an eye on?");
    for (const id of Object.keys(TEMPLATES) as (keyof typeof TEMPLATES)[]) expect(asked).toContain(TEMPLATES[id].title);
    const when = render(React.createElement(PlanTurn, {
      parsed: { kind: "ask", need: "when", template: "keep-sunday-covered", choices: [untilLifetime("2026-11-22", ET)!, untilLifetime("2026-11-29", ET)!] }, context: context(), actions,
    }));
    expect(when).toContain("Keep Sunday covered: until when?");
    expect(when).toContain("Until the end of Sunday, November 22");
    expect(when).toContain("Until the end of Sunday, November 29");
  });

  it("“Set up something new” lists the fixed templates with what each does", () => {
    const page = render(React.createElement(TemplatePicker, { context: context(), actions, onCancel: () => {} }));
    expect(page).toContain("Keep Sunday covered Checks every day, more often as Sunday gets close, and tells you when a role needs a decision.");
    expect(page).toContain("Morning briefing Prepares Today's briefing each weekday at 7:00 AM, or the time you choose, if this Mac is awake and Ozzie is running. Thursday's includes the full “Ready for Sunday” brief.");
  });

  it("the morning briefing: weekdays at 7:00 AM, changeable to every day, and never “every day” when it isn't", () => {
    const plan = defaultPlan("morning-briefing", FRI, ET);
    expect(scheduleText(plan, { now: FRI, zone: ET })).toBe("Weekdays at 7:00 AM.");
    expect(lifetimeText(plan.lifetime, plan.template, plan.schedule.weekdays)).toBe("Weekdays until you stop it.");
    expect(lifetimeText(plan.lifetime, plan.template, [])).toBe("Every day until you stop it.");
    const card = render(React.createElement(PlanCard, { plan, context: context(), actions }));
    expect(card).toContain("When it checks Weekdays at 7:00 AM.");
    expect(card).toContain("Thursday's includes the full “Ready for Sunday” brief.");
    const editor = renderToStaticMarkup(React.createElement(PlanEditor, { plan, context: context(), onDone: () => {}, onCancel: () => {} }));
    // A labelled choice, chosen as weekdays.
    expect(editor).toContain("<label for=\"days-morning-briefing\">On</label><select id=\"days-morning-briefing\"");
    expect(editor).toContain("<option value=\"weekdays\" selected=\"\">Weekdays (Monday to Friday)</option><option value=\"every\">Every day</option>");
  });

  it("describes weekly days and times plainly", () => {
    expect(scheduleText({ template: "group-night-clashes", schedule: { time: "20:00", weekdays: [1, 3], on_change: false }, lifetime: { kind: "until-stopped" } }, { now: FRI, zone: ET }))
      .toBe("Mondays and Wednesdays at 8:00 PM.");
  });

  it("says when it checks from the times its schedule really uses: “every Friday” and “until Wednesday” get no extra times", () => {
    const mon = "2026-11-16T14:00:00.000Z";
    const plan = (text: string) => { const p = parseRequest(text, mon, ET); if (p.kind !== "plan") throw new Error(p.kind); return p.plan; };
    expect(scheduleText(plan("Keep an eye on Sunday"), { now: mon, zone: ET }))
      .toBe("Every day at 7:00 AM, and sooner when something changes. Also at 12:00 PM and 5:00 PM in the two days before Sunday.");
    expect(scheduleText(plan("Keep an eye on Sunday every friday"), { now: mon, zone: ET })).toBe("Every Friday at 7:00 AM, and sooner when something changes.");
    expect(scheduleText(plan("Keep an eye on Sunday until Wednesday"), { now: mon, zone: ET })).toBe("Every day at 7:00 AM, and sooner when something changes.");
    const card = render(React.createElement(PlanCard, { plan: plan("Keep an eye on Sunday until Wednesday"), context: context({ now: () => mon }), actions }));
    // On a Mac in another time zone the card also says whose times these are, between the two sentences.
    expect(card).toContain("When it checks Every day at 7:00 AM, and sooner when something changes.");
    expect(card).toContain("Only while this Mac is awake and Ozzie is running.");
    expect(card).not.toContain("two days before Sunday");
  });

  it("once started, says only what is true now: checking, waiting for Planning Center, or paused", () => {
    expect(startedText(sunday(), context())).toBe("Ozzie is checking now, then every day at 7:00 AM, and sooner when something changes. Also at 12:00 PM and 5:00 PM in the two days before Sunday. Only while this Mac is awake and Ozzie is running. Stop it any time in Keeping watch.");
    expect(startedText(sunday(), context({ connected: false }))).toMatch(/^Ozzie will check as soon as Planning Center is connected, then every day at 7:00 AM/u);
    expect(startedText(sunday(), context({ pausedAll: true }))).toMatch(/^Everything is paused, so Ozzie won't check until you resume everything\. Then every day at 7:00 AM/u);
    for (const c of [context(), context({ connected: false }), context({ pausedAll: true })]) expect(startedText(sunday(), c)).not.toMatch(HIDDEN_WORDS);
  });

  it("started while a sign-in for the church is in the browser: says the first check waits for it, never that it is checking (review of items 4 and 7)", () => {
    // The church is still connected (the words hold), but no check runs until the sign-in in the browser is done.
    const signing = context({ signingIn: true });
    expect(startedText(sunday(), signing)).toMatch(/^Ozzie will check once the Planning Center sign-in in your browser is done, then every day at 7:00 AM/u);
    expect(startedText(sunday(), signing)).not.toMatch(/checking now|isn't connected|is connected/u);
    const r = responsibility(sunday());
    const page = render(React.createElement(ResponsibilityList, { view: view({ items: [r] }), context: signing, runner: fakeRunner(view()), actions }));
    expect(page).toContain("Next check Once the Planning Center sign-in in your browser is done.");
    expect(page).not.toContain("Not scheduled.");
  });

  it("a write-up's Worth a look lines name the watched service's own page (review of item 6)", () => {
    const writeup = { item: "i", responsibility_id: "r", run_id: "x", organization: "1001", at: FRI, kind: "written" as const, lines: ["For Wednesday, this check found 2 items that need a decision and 40 worth a look."],
      based_on: "Based on: Planning Center Services, checked Wed", gaps: [leftOutOfAnswer("Planning Center Services", 3)], steps: [], ai_steps: 1 };
    const item = { template: "keep-sunday-covered" as const, at: FRI, trigger: "scheduled" as const };
    const wed = render(React.createElement(DayProvider, { value: wednesdayWords() }, React.createElement(WriteUpBlock, { item, writeup, names: {}, now: FRI })));
    expect(wed).toContain("so 3 findings were left out of this answer. They're on the Wednesday page.");
    expect(wed).not.toContain("Sunday page");
  });

  it("one of each kind: a second plan for the same thing offers to change the one Ozzie already keeps an eye on", () => {
    const running = responsibility(sunday(), { runs: [run()] });
    const page = render(React.createElement(PlanCard, { plan: sunday(), context: context({ existing: [running] }), actions: { ...actions, edit: async () => ({}) } }));
    expect(page).toContain("Ozzie is already keeping an eye on this.");
    expect(page).toContain("Change it");
    expect(page).toContain("Leave it as it is");
    expect(page).not.toContain("Looks good — start it");
    expect(page).not.toContain("Plan · not started yet");
    // Another kind, or one that has ended, is a new plan as usual.
    expect(render(React.createElement(PlanCard, { plan: defaultPlan("morning-briefing", FRI, ET), context: context({ existing: [running] }), actions }))).toContain("Looks good — start it");
    expect(render(React.createElement(PlanCard, { plan: sunday(), context: context({ existing: [{ ...running, status: "ended" }] }), actions }))).toContain("Looks good — start it");
    expect(refusalText("exists")).toBe("Ozzie is already keeping an eye on this.");
  });

  it("the morning briefing doesn't promise more than a Mac that is awake can do", () => {
    expect(purposeText("morning-briefing")).toBe("Prepares Today's briefing each weekday at 7:00 AM, or the time you choose, if this Mac is awake and Ozzie is running. Thursday's includes the full “Ready for Sunday” brief.");
    expect(render(React.createElement(TemplatePicker, { context: context(), actions, onCancel: () => {} }))).not.toMatch(/ready when you sit down|before you start/u);
  });
});

describe("Ask: “Keep an eye on Sunday” becomes a plan, with no AI model needed", () => {
  const plans: PlanHooks = { parse: t => parseRequest(t, FRI, ET), context: context({ modelReady: false }), actions };
  const panel = (over: Partial<React.ComponentProps<typeof AskPanel>> = {}) => renderToStaticMarkup(React.createElement(AskPanel, {
    open: true, onClose: () => {}, ask: null, brief: null, modelReady: false, onOpen: () => {}, plans, ...over,
  }));
  it("keeps the box open for taking something on when questions aren't available yet", () => {
    const html = panel();
    expect(html).not.toMatch(/<textarea[^>]*disabled=""/u);
    expect(html).toContain("Ask Ozzie to keep an eye on something…");
    // Without plans, the panel is exactly as before.
    expect(renderToStaticMarkup(React.createElement(AskPanel, { open: true, onClose: () => {}, ask: null, brief: null, modelReady: false, onOpen: () => {} })))
      .toMatch(/<textarea[^>]*disabled=""/u);
  });
  it("shows the plan card as Ozzie's reply; nothing was sent anywhere", () => {
    const parsed = parseRequest("Keep an eye on Sunday until Sunday", FRI, ET);
    if (parsed.kind === "none") throw new Error("none");
    const turns: Turn[] = [{ id: 1, question: "Keep an eye on Sunday until Sunday", state: "plan", parsed }];
    const brief = buildSundayBrief(nov22Capture(), { sundayLeads: [], checkInAfterSundaysInARow: 3 }, nov22Capture().completed_at, true);
    const page = text(panel({ initialTurns: turns, brief }));
    expect(page).toContain("Keep Sunday covered");
    expect(page).toContain("Looks good — start it");
    expect(page).toContain("Until the end of Sunday, November 22.");
    expect(page).not.toMatch(HIDDEN_WORDS);
  });
});

describe("Keeping watch: the home for responsibilities", () => {
  const items = [
    responsibility(sunday(), { runs: [run()] }),
    responsibility(defaultPlan("morning-briefing", FRI, ET), { id: "00000000-0000-4000-8000-000000000002", status: "paused" }),
    responsibility(defaultPlan("follow-ups-without-owner", FRI, ET), { id: "00000000-0000-4000-8000-000000000003", runs: [run({ outcome: "failed", code: "provider-failure", noticed: 0, drafts: 0 })] }),
  ];
  const v = view({ items, next: { [items[0]!.id]: "2026-11-20T17:00:00.000Z" } });
  const list = (over: Partial<RunnerView> = {}) => render(React.createElement(ResponsibilityList, { view: { ...v, ...over }, context: context(), runner: fakeRunner({ ...v, ...over }), actions }));

  it("lists each with a plain status, its schedule, last and next check, and controls", () => {
    const page = list();
    expect(page).toContain("What Ozzie is watching");
    expect(page).toContain("Keeping an eye on it");
    expect(page).toContain("Paused");
    expect(page).toContain("Couldn't finish last time");
    // Without the run's report, the count is labeled findings, so it can't be read as Sunday's things to decide.
    expect(page).toMatch(/Last check .+, when it started\. Finished: 4 findings; 1 note ready to review\./u);
    expect(page).toMatch(/Couldn't finish: Planning Center didn't answer\./u);
    expect(page).toContain("Checks used 1 of 6 in the last 24 hours.");
    // Where each one stands comes first on its card, then what it does.
    expect(page.indexOf("Keep Sunday covered Last check")).toBeGreaterThan(-1);
    expect(page.indexOf("Keep Sunday covered Last check")).toBeLessThan(page.indexOf("Watches Open roles"));
    for (const button of ["Check now", "Pause", "Resume", "Change", "Stop", "Pause everything", "Set up something new"]) expect(page).toContain(button);
    expect(page).toContain("See how this works Ozzie keeps checking while its window is closed. It stays as the small Ozzie picture at the top of your screen.");
    expect(page).not.toMatch(HIDDEN_WORDS);
    expect(page).not.toMatch(NEVER);
  });

  it("says what the last check found with each count labeled: things to decide apart from Worth a look", () => {
    const report: NoticedItem = { id: "r", responsibility_id: items[0]!.id, template: "keep-sunday-covered", at: FRI, kind: "found", decisions: 2, looks: 2, drafts: 1, run_id: run().run_id };
    expect(list({ noticed: [report] })).toMatch(/Last check .+, when it started\. Finished: 2 things to decide and 2 worth a look; 1 note ready to review\./u);
    expect(foundText({ ...report, decisions: 1, looks: 0 })).toBe("1 thing to decide");
    expect(foundText({ ...report, template: "watch-room-bookings", decisions: 0, looks: 0, findings: { rooms: 2 } })).toBe("2 room booking overlaps");
    // Group night clashes count each clash once (it is also its Worth a look).
    expect(foundText({ ...report, template: "group-night-clashes", decisions: 0, looks: 1, findings: { groups: 1 } })).toBe("1 group meeting clash");
    expect(runText(run(), FRI, { ...report, kind: "clear", decisions: 0, looks: 0 })).toMatch(/Finished: nothing new needs a decision; 1 note ready to review\.$/u);
  });

  it("a card says when the last check couldn't finish or couldn't start, and offers to try again", () => {
    const r = responsibility(sunday(), { runs: [run()] });
    const at = (over: Partial<RunnerView>) => render(React.createElement(ResponsibilityList, { view: view({ items: [r], ...over }), context: context(), runner: fakeRunner(view()), actions }));
    // The store refused the run (no run is listed), and that is the newest thing it reported.
    const refused: NoticedItem = { id: "n1", responsibility_id: r.id, template: r.template, at: at_(FRI, 5), kind: "couldnt-check", code: "unavailable", retry_at: at_(FRI, 65), scheduled_for: at_(FRI, 5) };
    const page = at({ noticed: [refused] });
    expect(page).toContain("Couldn't check last time");
    expect(page).toContain("Try again now");
    expect(page).toMatch(/Ozzie couldn't check Sunday at .+ — its list of what to keep an eye on couldn't be read on this Mac\. It will try again at .+\./u);
    // A check after it that went fine clears it.
    expect(at({ noticed: [{ ...refused, id: "n2", kind: "clear", at: at_(FRI, 70) }, refused] })).toContain("Keeping an eye on it");
    // A run the store closed as interrupted is a problem; one paused part-way isn't.
    expect(statusText({ ...r, runs: [run({ outcome: "interrupted", code: "interrupted" })] }, false).label).toBe("Couldn't finish last time");
    expect(statusText({ ...r, runs: [run({ outcome: "failed", code: "cancelled" })] }, false).label).toBe("Keeping an eye on it");
    // Never says Ozzie closed when it may have been a timeout or a pause.
    for (const code of ["interrupted", "timeout", "cancelled"]) expect(problemText(code)).not.toMatch(/closed/u);
    // Paused, or its check stopped because Ozzie's sign-in was busy or the Mac's credential storage was locked
    // (harness-bridge.ts checkFailure): true of each.
    expect(problemText("cancelled")).toBe("it was paused or stopped before it finished");
    // Every code a run can end with has its own words, never "something went wrong" (review L5).
    expect(problemText("invalid-arguments")).toBe("the AI asked to look something up in a way Ozzie doesn't allow");
    expect(problemText("unverified")).toBe("Ozzie couldn't confirm which church its sign-in to Planning Center belongs to");
    // Waiting for Planning Center: says so rather than "Not scheduled".
    const waiting = render(React.createElement(ResponsibilityList, { view: view({ items: [r] }), context: context({ connected: false }), runner: fakeRunner(view()), actions }));
    expect(waiting).toContain("Next check As soon as Planning Center is connected.");
  });

  it("shows Sunday as one item: Ozzie keeping an eye on Sunday, then Keep Sunday covered, each saying on its card what it is", () => {
    const morning = items[1]!;
    const regular = React.createElement("p", null, "REGULAR CHECK");
    const sundayList = (rs: Responsibility[]) => render(React.createElement(ResponsibilityList, { view: view({ items: rs }), context: context(), runner: fakeRunner(view({ items: rs })), actions, sunday: regular }));
    const page = sundayList([items[0]!, morning]);
    const at = (s: string) => page.indexOf(s);
    expect(at("What Ozzie is watching")).toBeLessThan(at("Sunday REGULAR CHECK"));
    // Keep Sunday covered says what it is in short sentences, apart from the steady look: a job started, with a plan, limits and an end.
    expect(page).toContain(`Keep Sunday covered ${keepAbout()} Last check`);
    expect(keepAbout()).toBe("A job you started, with a plan, limits and an end you chose. It checks more often as Sunday gets close, and sooner when the check above finds a change. It also prepares notes.");
    expect(at("REGULAR CHECK")).toBeLessThan(at("Keep Sunday covered A job you started"));
    expect(at("Keep Sunday covered A job you started")).toBeLessThan(at("Morning briefing Last check"));
    // Keep Sunday covered's card is listed once, in the Sunday item, not again among the rest; only it carries that line.
    expect(page.match(/Keep Sunday covered A job you started/gu)).toHaveLength(1);
    expect(page).not.toMatch(/Morning briefing A job/u);
    expect(page).toContain("Every day at 7:00 AM, and sooner when something changes. Also at 12:00 PM and 5:00 PM in the two days before Sunday.");
    // Not on: the Sunday item offers it, with the plan to confirm first; nothing else says "Nothing yet".
    const off = sundayList([morning]);
    expect(off).toMatch(/Sunday REGULAR CHECK Not on Keep Sunday covered A job you start\. You confirm a short plan first, with limits and an end you choose\. It checks more often as Sunday gets close, and sooner when the check above finds a change\. It prepares notes and tells you when something needs a decision\. Set up Keep Sunday covered/u);
    expect(sundayList([])).not.toContain("Nothing yet");
    expect(page).not.toMatch(HIDDEN_WORDS);
    expect(page).not.toMatch(NEVER);
  });

  it("on Keeping watch, the steady look at Sunday is inside the Sunday item, once, and says where it stands first", () => {
    const proactiveView = { prefs: DEFAULT_PREFS, schedule: newSchedule(), history: [], latest: {}, running: false, unseen: 0 };
    const page = render(React.createElement(ProactivePage, {
      view: proactiveView, names: {}, organization: "1001", planId: "92902197", readiness: "ready", busy: false, now: FRI,
      onCheckNow() {}, onPause() {}, onResume() {}, onPrefs() {},
      responsibilities: (regular: React.ReactNode) => React.createElement(ResponsibilityList, { view: v, context: context(), runner: fakeRunner(v), actions, sunday: regular }),
    }));
    const at = (s: string) => page.indexOf(s);
    // One name for it (spec §6): its card's title, said once; the page no longer repeats it in every line.
    expect(page.match(/Ozzie keeps an eye on Sunday/gu)).toHaveLength(1);
    expect(page.match(/keep(?:s|ing)? an eye on/giu)!.length).toBeLessThanOrEqual(5);
    expect(page).toContain("Sunday On schedule Planning Center Services Ozzie keeps an eye on Sunday Runs by itself whenever Ozzie is open. Last check Not yet. Next check");
    expect(at("On schedule")).toBeLessThan(at("Keep Sunday covered A job you started"));
    expect(at("Keep Sunday covered A job you started")).toBeLessThan(at("What changed recently"));
    expect(page).toContain("How often When Ozzie opens, then at least every hour while it is running, even with its window closed. While its window is on screen, about every 30 minutes.");
  });

  it("says when everything is paused, and when there's nothing yet", () => {
    const paused = list({ paused_all: true });
    expect(paused).toContain("Everything is paused. Nothing runs on its own until you resume.");
    expect(paused).toContain("Resume everything");
    expect(paused).toContain("Paused with everything");
    const empty = list({ items: [] });
    expect(empty).toContain("Nothing yet. Ask Ozzie something like “Keep an eye on Sunday”, or set one up here.");
    expect(list({ available: false })).toContain("couldn't be read on this Mac right now");
  });

  it("offers Pause everything whenever anything runs on its own, keeping an eye on Sunday alone included, and says what stops", () => {
    const regular = React.createElement("p", null, "REGULAR CHECK");
    const page = (over: Partial<RunnerView>, sunday?: React.ReactNode) =>
      render(React.createElement(ResponsibilityList, { view: view(over), context: context(), runner: fakeRunner(view(over)), actions, ...(sunday ? { sunday } : {}) }));
    const alone = page({ items: [] }, regular);
    expect(alone).toContain("Pause everything");
    expect(alone).toContain("Pause everything stops Ozzie keeping an eye on Sunday until you resume.");
    expect(page({ items }, regular)).toContain("Pause everything stops Ozzie keeping an eye on Sunday, and everything else here, until you resume.");
    expect(page({ items })).toContain("Pause everything stops everything here until you resume.");
    // Nothing runs automatically at all: nothing to pause.
    expect(page({ items: [] })).not.toContain("Pause everything");
    // Paused: Resume everything is always there, and the line about what stops gives way to saying it's paused.
    const paused = page({ items: [], paused_all: true }, regular);
    expect(paused).toContain("Resume everything");
    expect(paused).not.toContain("Pause everything stops");
    expect(alone).not.toMatch(HIDDEN_WORDS);
    expect(alone).not.toMatch(NEVER);
  });
});

describe("Keeping watch reads top to bottom: what is running, then how it works (polish, 2026-11-19)", () => {
  const keep = responsibility(sunday(), { runs: [run()] });
  const morning = responsibility(defaultPlan("morning-briefing", FRI, ET), { id: "00000000-0000-4000-8000-000000000002" });
  const proactiveView = { prefs: DEFAULT_PREFS, schedule: newSchedule(), history: [], latest: {}, running: false, unseen: 0 };
  const html = (items: Responsibility[]) => {
    const v = view({ items, next: { [keep.id]: "2026-11-20T17:00:00.000Z" } });
    return renderToStaticMarkup(React.createElement(ProactivePage, {
      view: proactiveView, names: {}, organization: "1001", planId: "92902197", readiness: "ready", busy: false, now: FRI,
      church: "Harbor Example Church", churchTimeZone: "America/Chicago", onCheckNow() {}, onPause() {}, onResume() {}, onPrefs() {},
      responsibilities: (regular: React.ReactNode) => React.createElement(ResponsibilityList, {
        view: v, context: context({ church: "Harbor Example Church" }), runner: fakeRunner(v), actions, sunday: regular }),
    }));
  };
  // Keep Sunday covered on (with another job), and not on (offered).
  const on = html([keep, morning]), off = html([]);
  const FOLD = '<details class="listen-more watch-how">';
  /** What a person reads without opening anything: every fold taken out. */
  const unfolded = (h: string) => text(h.replace(/<details\b[\s\S]*?<\/details>/gu, " "));
  /** What the "See how this works" fold holds. */
  const folded = (h: string) => text(/<details class="listen-more watch-how">[\s\S]*?<\/details>/u.exec(h)?.[0] ?? "");

  it("keeps every fact the old explanation gave: on the page, and at most one click away", () => {
    // The old lead, its paragraph, Pause everything's line, the line about the two things that look at Sunday, and the card's rows.
    const facts = [
      "tells you privately when something needs you", "Ozzie only reads.", "even with its window closed",
      "Ozzie keeps checking while its window is closed.", "It stays as the small Ozzie picture at the top of your screen.",
      QUIT_LINE, "Ozzie catches up once when it can.",
      "Ozzie runs one job of each kind at a time", "use Change on its card instead of setting up another",
      "Pause everything stops Ozzie keeping an eye on Sunday", "until you resume.",
      "Ozzie keeps an eye on Sunday", "Runs by itself whenever Ozzie is open.", "When something gets worse, a private notice on this Mac",
      "It never includes names or details.", "It checks more often as Sunday gets close, and sooner when the check above finds a change.",
      "Reads only. It never sends messages.", "then compares them with the last check.",
      "Planning Center Services, Harbor Example Church", "Time zone: Central Time (America/Chicago), the church's time zone in Planning Center.",
      "Last check", "Next check", "Quiet hours 9:00 PM to 7:00 AM: notices wait until they end.",
    ];
    for (const page of [on, off]) for (const fact of facts) expect(text(page), fact).toContain(fact);
    // Keep Sunday covered: a job a person starts, with a plan, limits and an end, that prepares notes and says when something needs a decision.
    for (const fact of ["A job you started, with a plan, limits and an end you chose.", "It also prepares notes.", "Tells you Only when something needs a decision."]) {
      expect(text(on), fact).toContain(fact);
    }
    for (const fact of ["A job you start. You confirm a short plan first, with limits and an end you choose.", "It prepares notes and tells you when something needs a decision."]) {
      expect(text(off), fact).toContain(fact);
    }
    // Anything not said outside a fold is in the one "See how this works" fold, a click away.
    for (const page of [on, off]) expect(folded(page)).toBe(` See how this works ${[...WATCH_HOW, oneOfEach()].join(" ")} `);
  });

  it("says Ozzie only reads, and that nothing runs after quitting or while asleep, without opening anything", () => {
    for (const page of [on, off]) {
      expect(unfolded(page)).toContain("tells you privately when something needs you. Ozzie only reads.");
      expect(unfolded(page)).toContain(QUIT_LINE);
      expect(unfolded(page)).toContain("Reads only. It never sends messages.");
      expect(unfolded(page)).not.toContain(WATCH_HOW[0]!);
    }
  });

  it("never promises an exact hour: Ozzie checks at least that often, and more often with its window on screen", () => {
    for (const page of [on, off]) {
      expect(text(page)).toContain("at least every hour");
      expect(text(page)).not.toMatch(/(?<!at least )\bevery hour\b/u);
      expect(text(page)).toContain("While its window is on screen, about every 30 minutes.");
    }
  });

  it("shows what is running and where it stands before the fold, with little to read before it", () => {
    for (const page of [on, off]) {
      const fold = page.indexOf(FOLD);
      expect(fold).toBeGreaterThan(-1);
      for (const status of [">On schedule<", ">Last check<", ">Next check<", ">Ozzie keeps an eye on Sunday<"]) {
        expect(page.indexOf(status), status).toBeGreaterThan(page.indexOf("<h1"));
        expect(page.indexOf(status), status).toBeLessThan(fold);
      }
      expect(page.indexOf(">Last check<")).toBeLessThan(page.indexOf(">What it does<"));
      // What a pastor reads before the steady look's last check: the title, a two-sentence lead, the heading, one short line,
      // the card's top (81 words with a job on; it was 269, three paragraphs of explanation, before 2026-11-19).
      const before = text(page).slice(0, text(page).indexOf(" Last check ")).trim().split(/\s+/u);
      expect(before.length, before.join(" ")).toBeLessThanOrEqual(90);
    }
    // Keep Sunday covered's own state, before the fold too.
    expect(on.indexOf(">Keeping an eye on it<")).toBeLessThan(on.indexOf(FOLD));
    expect(off.indexOf(">Not on<")).toBeLessThan(off.indexOf(FOLD));
  });

  it("heads its parts in order, one level at a time, and its fold opens like every other", () => {
    const headings = [...on.matchAll(/<h([1-6])\b[^>]*>([^<]*)<\/h\1>/gu)].map(m => `h${m[1]} ${m[2]}`);
    expect(headings).toEqual([
      "h1 What Ozzie does on its own", "h2 What Ozzie is watching", "h3 Sunday", "h4 Ozzie keeps an eye on Sunday", "h4 Keep Sunday covered",
      "h3 Morning briefing", "h2 What changed recently", "h2 Schedule and quiet hours",
    ]);
    const levels = headings.map(h => Number(h[1]));
    levels.forEach((l, i) => { if (i) expect(l - levels[i - 1]!, headings[i]).toBeLessThanOrEqual(1); });
    expect(on).toContain(`${FOLD}<summary><svg class="ic ic-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"></path></svg>See how this works</summary><ul class="small"><li>`);
    expect(on.match(/See how this works<\/summary>/gu)).toHaveLength(1);
    // Pause everything is still described by its own line.
    expect(on).toMatch(/aria-describedby="pause-scope"[^>]*>Pause everything<\/button>/u);
    expect(on).toContain('<span id="pause-scope">Pause everything stops Ozzie keeping an eye on Sunday, and everything else here, until you resume.</span>');
  });
});

describe("Today: what comes to the person", () => {
  const keep = responsibility(sunday(), { runs: [run()] });
  const morning = responsibility(defaultPlan("morning-briefing", FRI, ET), { id: "00000000-0000-4000-8000-000000000002" });
  const item = (over: Partial<NoticedItem>): NoticedItem => ({ id: "x", responsibility_id: keep.id, template: "keep-sunday-covered", at: FRI, kind: "found", ...over });
  const noticed: NoticedItem[] = [
    item({ id: "a", decisions: 2, looks: 1, drafts: 1, notice: "sent", run_id: run().run_id, changes: [{ id: "c", kind: "confirmed-declined", effect: "worse", urgency: "urgent", position: "Greeter", person_id: "501" }] }),
    item({ id: "b", kind: "missed", scheduled_for: "2026-11-20T12:00:00.000Z", missed_reason: "asleep", ran_at: FRI, missed_count: 1 }),
    item({ id: "c", responsibility_id: morning.id, template: "morning-briefing", kind: "briefing", notice: "held" }),
    item({ id: "d", kind: "couldnt-check", code: "provider-failure", retry_at: "2026-11-20T16:00:00.000Z", scheduled_for: FRI }),
    item({ id: "e", kind: "clear" }),
  ];
  const v = view({ items: [keep, morning], noticed, writeups: {
    a: { item: "a", responsibility_id: keep.id, run_id: run().run_id, organization: "fictional", at: FRI, kind: "written",
      lines: ["Greeter still needs one person.", "{{person:501}} hasn't accepted Greeter yet."], based_on: "Based on: Planning Center Services, checked Fri, Nov 20, 10:00 AM",
      gaps: [], steps: ["Looked at the open roles for Sunday — all of it"], ai_steps: 2 },
    c: { item: "c", responsibility_id: morning.id, run_id: "00000000-0000-4000-8000-0000000000bb", organization: "fictional", at: FRI, kind: "none", why: "spent" },
  } });
  const memoryStore = () => { const m = new Map<string, string>(); return { get: (k: string) => m.get(k) ?? null, set: (k: string, x: string) => { m.set(k, x); } }; };
  const today = (over: Partial<RunnerView> = {}, n: Readonly<Record<string, string>> = names) => render(React.createElement(TodayPage, {
    brief: null, onSunday: () => {}, names: { ...n }, now: FRI, zone: ET, store: memoryStore(),
    watch: { view: { ...v, ...over }, now: FRI, onAutomatic: () => {}, onOpen: () => {} },
  }));

  it("shows what Ozzie noticed, with prepared work, names only from this Mac's check", () => {
    const page = today();
    expect(page).toContain("Ozzie noticed · Keep Sunday covered");
    expect(page).toContain("Keep Sunday covered: 2 things need a decision.");
    expect(page).toContain("Avery Brightwater declined Greeter after confirming.");
    // The run's write-up leads its card (audit item 6), with names filled in on this Mac; the briefing says why it has none.
    expect(page).toMatch(/Keep Sunday covered: 2 things need a decision\.\s+Ozzie checked Sunday at .+: Greeter still needs one person\. Avery Brightwater hasn't accepted Greeter yet\. Based on: Planning Center Services, checked Fri, Nov 20, 10:00 AM See how this works/u);
    expect(page).not.toContain("Read Ozzie's write-up");
    expect(page).toMatch(/Your morning briefing is ready\.\s+No write-up this time: AI help has reached its limit for now\./u);
    expect(page).toContain("1 note is ready for you to review and send yourself.");
    expect(page).toMatch(/Your Mac was asleep at .+, so Ozzie checked at .+ instead\./u);
    expect(page).toContain("Your morning briefing is ready.");
    expect(page).toContain("Notice waiting for quiet hours to end");
    expect(page).toMatch(/Ozzie couldn't check Sunday at .+ — Planning Center didn't answer\. It will try again at .+\./u);
    // A check that found nothing new isn't news.
    expect(page).not.toContain("Nothing new needs a decision");
    const nameless = today({}, {});
    expect(nameless).toContain("Someone declined Greeter after confirming.");
    for (const name of Object.values(names)) expect(nameless).not.toContain(name);
    expect(nameless).toContain("a team member hasn't accepted Greeter yet.");
    expect(page).not.toMatch(HIDDEN_WORDS);
  });

  it("labels what came up overnight, and shows the full “Ready for Sunday” brief inside Thursday's briefing only", () => {
    const thursday = item({ id: "t", responsibility_id: morning.id, template: "morning-briefing", kind: "briefing", sunday_ready: true, overnight_count: 2, notice: "sent" });
    const night = item({ id: "n", decisions: 1, overnight: true, notice: "in-briefing" });
    const ready = React.createElement("p", null, "SUNDAY READY BRIEF");
    const card = (i: NoticedItem) => render(React.createElement(NoticedCard, { item: i, view: view({ noticed: [thursday, night] }), names, now: FRI, onOpen: () => {}, sundayReady: ready }));
    expect(card(thursday)).toContain("Your morning briefing is ready. Today it includes the full “Ready for Sunday” brief. 2 things came up overnight; they're marked Overnight.");
    expect(card(thursday)).toContain("SUNDAY READY BRIEF");
    expect(card(night)).toContain("Overnight");
    expect(card(night)).toContain("Brought into your morning briefing");
    expect(card(night)).not.toContain("SUNDAY READY BRIEF");
    // Any other day's briefing doesn't carry it.
    expect(card({ ...thursday, sunday_ready: false })).not.toContain("SUNDAY READY BRIEF");
    // In Today's groups, Thursday's briefing is under Ready to review with the Sunday Ready brief inside it.
    const page = today({ noticed: [thursday, ...noticed.filter(i => i.responsibility_id !== morning.id)] });
    const review = page.slice(page.indexOf("Ready to review"), page.indexOf("In progress"));
    expect(review).toContain(noticedTitle(thursday, FRI));
    expect(review).toContain("Ready for Sunday");
    expect(review).toContain("Sunday hasn't been checked yet, so this brief isn't here.");
    expect(noticedTitle(thursday, FRI)).toContain("Today it includes the full “Ready for Sunday” brief.");
  });

  it("puts prepared work in Ready to review and each responsibility, with its next check and problems, in In progress", () => {
    const page = today({ next: { [keep.id]: "2026-11-20T17:00:00.000Z" } });
    const at = (s: string) => page.indexOf(s);
    expect(at("Needs your attention")).toBeLessThan(at("Ready to review"));
    expect(at("Ready to review")).toBeLessThan(at("In progress"));
    const review = page.slice(at("Ready to review"), at("In progress"));
    expect(review).toContain("Ready to review 2 items");
    expect(review).toContain("Keep Sunday covered: 2 things need a decision.");
    expect(review).toContain("Your morning briefing is ready.");
    const progress = page.slice(at("In progress"));
    // The same labels as everywhere else: things to decide, and Worth a look apart.
    expect(progress).toMatch(/In progress 2 items Keeping an eye on it Started at .+ Keep Sunday covered Next check .+ · last check: 2 things to decide and 1 worth a look/u);
    // Without the run's report the count is labeled findings.
    const unlinked = today({ next: { [keep.id]: "2026-11-20T17:00:00.000Z" }, noticed: noticed.map(i => { const copy = { ...i }; delete copy.run_id; return copy; }) });
    expect(unlinked.slice(unlinked.indexOf("In progress"))).toMatch(/Keep Sunday covered Next check .+ · last check: 4 findings/u);
    expect(progress).toMatch(/Your Mac was asleep at .+, so Ozzie checked at .+ instead\./u);
    expect(progress).toContain("Change what Ozzie keeps an eye on");
    const none = today({ items: [], noticed: [] });
    // What would start something, never a pointer to Ask while the regular check may be running (audit item 4).
    expect(none).toContain("Nothing is running. Keep Sunday covered and other jobs start when you set them up in Keeping watch.");
    expect(none).toContain("See what Ozzie can keep an eye on");
  });
});

describe("a kind that has used its checks for the last 24 hours", () => {
  // The kind's six checks were used by one that was stopped and set up again; the oldest was at 8:00 (two hours before FRI).
  const used = Array.from({ length: 6 }, (_, i) => run({ run_id: `00000000-0000-4000-8000-0000000001${String(i).padStart(2, "0")}`, started_at: at_(FRI, -120 + i * 20) }));
  const stopped = responsibility(sunday(), { id: "00000000-0000-4000-8000-000000000009", status: "ended", runs: used });
  const fresh = responsibility(sunday());
  const soon = at_(FRI, 31);
  const v = view({ items: [fresh, stopped], next: { [fresh.id]: soon } });
  const free = at_(FRI, -120 + 24 * 60);

  it("says when it can check again, never a scheduled time it can't keep", () => {
    expect(checksBack(fresh, v, FRI)).toBe(free);
    const line = watchLine(fresh, v, FRI);
    expect(line).toBe(`Can check again ${againText(free, FRI)} · not checked yet`);
    expect(line).not.toContain("Next check");
    const card = render(React.createElement(ResponsibilityList, { view: v, context: context(), runner: fakeRunner(v), actions }));
    expect(card).toContain(`Next check It has used its checks for now. It can check again ${againText(free, FRI)}.`);
    expect(card).toContain("Checks used 6 of 6 in the last 24 hours.");
    // A scheduled time after its checks free up is one it can keep; with checks left, the schedule stands.
    const later = view({ items: [fresh, stopped], next: { [fresh.id]: at_(free, 60) } });
    expect(checksBack(fresh, later, FRI)).toBeNull();
    expect(watchLine(fresh, later, FRI)).toMatch(/^Next check /u);
    expect(checksBack(fresh, view({ items: [fresh], next: { [fresh.id]: soon } }), FRI)).toBeNull();
  });

  it("says the time plainly: today's time, tomorrow, or the day", () => {
    const now = new Date(2026, 10, 20, 10, 0).toISOString();
    expect(againText(new Date(2026, 10, 20, 15, 30).toISOString(), now)).toBe("at 3:30 PM");
    expect(againText(new Date(2026, 10, 21, 8, 0).toISOString(), now)).toBe("tomorrow at 8:00 AM");
    expect(againText(new Date(2026, 10, 23, 8, 0).toISOString(), now)).toBe("Mon 8:00 AM");
  });
});

describe("drafted notes and your name", () => {
  const stored = new Map<string, string>();
  const fakeStorage = { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, x: string) => { stored.set(k, x); }, removeItem: (k: string) => { stored.delete(k); } };
  const keep = responsibility(sunday());
  const item: NoticedItem = { id: "p", responsibility_id: keep.id, template: "keep-sunday-covered", at: FRI, kind: "found", decisions: 1, drafted: true, drafts: 1 };
  const card = () => render(React.createElement(NoticedCard, {
    item, view: view({ items: [keep], noticed: [item] }), names, now: FRI, onOpen: () => {}, written: { summary: null, draft: "Hi Riley,\n\nCould you help?\n\nThank you,\n[Your name]" },
  }));

  it("a note the AI drafted is signed with your name on this Mac, or keeps [Your name] when none is set", () => {
    vi.stubGlobal("localStorage", fakeStorage);
    try {
      stored.clear();
      expect(card()).toContain("Thank you, [Your name]");
      stored.set("ozzie.your-name.v1", "Pat Example");
      expect(card()).toContain("Thank you, Pat Example");
      expect(card()).not.toContain("[Your name]");
    } finally { vi.unstubAllGlobals(); }
  });

  it("Settings has a labelled field for it, kept on this Mac and never sent to an AI", () => {
    const saved: string[] = [];
    const html = renderToStaticMarkup(React.createElement(YourNameField, { store: { get: () => "Pat", set: v => { saved.push(v); } } }));
    expect(html).toContain('<label for="your-name" class="field-l">Your name for notes</label>');
    expect(html).toMatch(/<input id="your-name"[^>]*aria-describedby="your-name-help"[^>]*value="Pat"/u);
    expect(text(html)).toContain("It stays on this Mac and goes in after any AI rewording, so it's never sent to an AI. Leave it empty to keep [Your name] for you to fill in.");
    const settings = render(React.createElement(ConnectionPage, { status: null, settings: { clientId: "", organization: "", serviceTypeId: "", planId: "" }, onSettings: () => {}, onStatus: () => {},
      nameStore: { get: () => "", set: () => {} } }));
    expect(settings).toContain("Your name on notes");
    // Near the top of Settings (audit item 18): second, right after Planning Center and which Sunday, in the order a
    // leader meets them (audit item 27), and in the index at the very top.
    const sections = settings.slice(settings.indexOf("Planning Center and which service Ozzie watches Reads only."));
    expect(sections.indexOf("Your name on notes")).toBeGreaterThan(0);
    expect(sections.indexOf("Your name on notes")).toBeLessThan(sections.indexOf("AI help"));
    expect(settings.indexOf("On this page Planning Center and which service Ozzie watches Your name on notes")).toBeGreaterThan(-1);
  });
});

describe("a plan changed on a Sunday", () => {
  it("never offers a lifetime that ends today", () => {
    const SUN = "2026-11-15T14:00:00.000Z"; // Sunday 9:00 AM in New York
    const plan = { ...defaultPlan("keep-sunday-covered", SUN, ET), lifetime: untilLifetime("2026-11-22", ET)! };
    const editor = render(React.createElement(PlanEditor, { plan, context: context({ now: () => SUN }), onDone: () => {}, onCancel: () => {} }));
    expect(editor).toContain("Until the end of Sunday, November 22");
    expect(editor).toContain("Until the end of Sunday, November 29");
    expect(editor).not.toContain("November 15");
  });
});

describe("open at login and the closed window", () => {
  const off = { get: () => new Promise<boolean>(() => {}), set: vi.fn(async (v: boolean) => v) };
  it("isn't asked in first run: it waits on Today's Finish setting up (onboarding spec §4.1), and rendering asks nothing of the Mac (audit item 23)", () => {
    const html = renderToStaticMarkup(React.createElement(FirstRun, {
      status: null, settings: { clientId: "", organization: "", serviceTypeId: "", planId: "" }, onSettings() {}, onStatus() {}, start: "first",
      read: () => new Promise<never>(() => {}), result: null, rules: false, intervalMinutes: 60, nowMs: 0, onExample() {}, onLeave() {}, onDeferred() {}, builtIn: true,
    }));
    expect(text(html)).not.toMatch(/Start Ozzie|start-with-mac/u);
    expect(off.set).not.toHaveBeenCalled();
    expect(render(React.createElement(AutostartToggle, { autostart: off }))).toContain("On if you chose it in setup; you can change it here.");
    expect(render(React.createElement(AutostartToggle, { autostart: off }))).not.toContain("Off unless you turn it on.");
  });
  it("Settings explains the menu bar and how to quit", () => {
    const page = (autostart?: typeof off) => render(React.createElement(ConnectionPage, {
      status: null, settings: { clientId: "", organization: "", serviceTypeId: "", planId: "" }, onSettings() {}, onStatus() {}, autostart,
    }));
    // The menu bar named the first time for someone who has never heard the words (onboarding spec §6), then by name.
    expect(page(off)).toContain("When the window is closed Ozzie keeps running when you close its window, as the small Ozzie picture at the top of your screen, so it can keep an eye on what you asked. To stop it completely, click that picture in the menu bar and choose Quit Ozzie.");
    expect(page()).not.toContain("When the window is closed");
  });
});

describe("a church whose service is on a Wednesday (onboarding spec §5)", () => {
  const WED = "2026-11-25";
  const wed = (el: React.ReactElement) => render(React.createElement(DayProvider, { value: wednesdayWords() }, el));
  const keep = (over: Partial<Responsibility> = {}) => responsibility(defaultPlan("keep-sunday-covered", FRI, ET, { sunday: WED }), over);
  const morning = responsibility(defaultPlan("morning-briefing", FRI, ET), { id: "00000000-0000-4000-8000-000000000002" });

  it("names the job, its plan and the regular look by the real day, never Sunday", () => {
    const card = wed(React.createElement(PlanCard, { plan: defaultPlan("keep-sunday-covered", FRI, ET, { sunday: WED }), context: context({ sunday: WED }), actions }));
    expect(card).toContain("Keep Wednesday covered");
    expect(card).toContain("Also at 12:00 PM and 5:00 PM on Fridays and Saturdays.");
    expect(card).not.toContain("Sunday");
    const items = [keep({ runs: [run()] }), morning];
    const v = view({ items });
    const list = wed(React.createElement(ResponsibilityList, { view: v, context: context({ sunday: WED }), runner: fakeRunner(v), actions, sunday: React.createElement("p", null, "REGULAR") }));
    expect(list).toContain("Wednesday REGULAR");
    expect(list).toContain(`Keep Wednesday covered ${keepAbout(wednesdayWords())}`);
    expect(keepAbout(wednesdayWords())).toContain("It checks more often as Wednesday gets close");
    expect(list).toContain(oneOfEach(wednesdayWords()));
    expect(list).toContain("Pause everything stops Ozzie keeping an eye on Wednesday, and everything else here, until you resume.");
    expect(list).toContain("Thursday's includes the full “Ready for Wednesday” brief.");
    expect(list).not.toContain("Sunday");
    const picker = wed(React.createElement(TemplatePicker, { context: context(), actions, onCancel: () => {} }));
    expect(picker).toContain("Keep Wednesday covered Checks every day, more often as Wednesday gets close");
    expect(picker).not.toContain("Sunday");
    const empty = wed(React.createElement(ResponsibilityList, { view: view(), context: context(), runner: fakeRunner(view()), actions }));
    expect(empty).toContain("Ask Ozzie something like “Keep an eye on Wednesday”");
  });

  it("says what Ozzie noticed about the Wednesday service, and where to open it", () => {
    const k = keep();
    const found: NoticedItem = { id: "x", responsibility_id: k.id, template: "keep-sunday-covered", at: FRI, kind: "found", decisions: 2 };
    const ended: NoticedItem = { ...found, id: "e", kind: "ended", until: WED };
    const card = (i: NoticedItem) => wed(React.createElement(NoticedCard, { item: i, view: view({ items: [k], noticed: [i] }), names, now: FRI, onOpen: () => {} }));
    expect(card(found)).toContain("Keep Wednesday covered: 2 things need a decision.");
    expect(card(found)).toContain("Open Wednesday");
    expect(card(ended)).toContain("Anything still open is on the Wednesday page.");
    for (const i of [found, ended]) expect(card(i)).not.toContain("Sunday");
    expect(noticedTitle({ ...found, kind: "couldnt-check", code: "provider-failure" }, FRI, wednesdayWords())).toMatch(/^Ozzie couldn't check Wednesday at /u);
  });

  it("the Keeping watch page says the Wednesday notice line and never Sunday", () => {
    const proactiveView = { prefs: DEFAULT_PREFS, schedule: newSchedule(), history: [], latest: {}, running: false, unseen: 0 };
    const page = wed(React.createElement(ProactivePage, {
      view: proactiveView, names: {}, organization: "1001", planId: "92902197", readiness: "ready", busy: false, now: FRI, church: "Harbor Example Church",
      onCheckNow() {}, onPause() {}, onResume() {}, onPrefs() {},
    }));
    expect(page).toContain("Keeping watch");
    expect(page).toContain("Ozzie keeps an eye on Wednesday");
    expect(page).toContain("“Wednesday coverage needs attention. Open Ozzie to see details.”");
    // The church by its name beside where the card reads, as a job's card says it.
    expect(page).toContain("On schedule Planning Center Services, Harbor Example Church Ozzie keeps an eye on Wednesday");
    expect(page).toContain("Pause keeping an eye on Wednesday");
    expect(page).not.toContain("Sunday");
    expect(page).not.toContain("1001");
    expect(page).not.toMatch(/runs automatically|automatic checks/u);
  });
});
