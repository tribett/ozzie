// What Ozzie keeps an eye on, on screen: the plan to confirm, Ask, What runs automatically, Today,
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
  AutostartToggle, NoticedFeed, PlanCard, PlanTurn, ResponsibilityList, startedText, TemplatePicker, WatchStrip, type PlanActions, type PlanContext,
} from "../src/responsibility-views.js";
import type { NoticedItem, Runner, RunnerView } from "../src/responsibility-runner.js";
import { TodayPage } from "../src/today-page.js";
import { SetupFlow } from "../src/setup-flow.js";
import { ConnectionPage } from "../src/connection-page.js";
import { DEFAULT_PREFS } from "../src/proactive.js";
import { problemText, PURPOSE, refusalText, scheduleText, statusText } from "../src/responsibility-words.js";
import { HIDDEN_WORDS, text } from "./harness-fakes.js";

const ET = "America/New_York";
const FRI = "2026-11-20T15:00:00.000Z";
const names = nov22Capture().names;
const context = (over: Partial<PlanContext> = {}): PlanContext => ({
  organization: "1001", granted: ["services"], modelReady: true, connected: true, zone: ET, now: () => FRI, ...over,
});
const actions: PlanActions = { start: async () => ({}), onSettings: () => {}, onAutomatic: () => {} };
const render = (el: React.ReactElement) => text(renderToStaticMarkup(el));
const sunday = (): Plan => defaultPlan("keep-sunday-covered", FRI, ET);
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
  available: true, paused_all: false, items: [], noticed: [], prepared: {}, next: {}, running: null, unseen: 0, open_today: false, ...over,
});
const fakeRunner = (v: RunnerView): Runner => ({
  start() {}, refresh: async () => {}, tick: async () => {}, wake() {}, changes: async () => {}, captured() {}, pausedElsewhere: async () => {},
  create: async () => v.items[0]!, edit: async () => v.items[0]!,
  pause: async () => {}, resume: async () => {}, stop: async () => {}, pauseAll: async () => {}, runNow: async () => ({ status: "skipped" }),
  markSeen() {}, clearOpenToday() {}, view: () => v, subscribe: () => () => {},
});

describe("the plan Ozzie shows before taking something on", () => {
  it("says what it watches, which accounts, when it checks and tells you, until when, its limits and how to stop", () => {
    const page = render(React.createElement(PlanCard, { plan: sunday(), assumed: ["lifetime"], context: context(), actions }));
    for (const line of [
      "Plan · not started yet", "Keep Sunday covered",
      "What Ozzie will watch Open roles, who has accepted or declined, and Sunday leads for the Sunday chosen in Settings.",
      "Accounts Planning Center Services, organization 1001. Reads only.",
      "When it checks Every day at 7:00 AM, and sooner when something changes. Also at 12:00 PM and 5:00 PM in the two days before Sunday.",
      "When it tells you Only when something needs a decision. A private notice on this Mac with no names or details; quiet hours hold it until they end.",
      "Until Until the end of Sunday, November 22. Then it stops on its own.",
      "Limits At most 6 checks a day. Uses the AI at most 12 times a day to write a short summary; names never reach it.",
      "How to stop Stop it any time in What runs automatically.",
      "You didn't say how long, so this ends after Sunday, November 22. Change it if you meant every week.",
      "Ozzie only reads. It won't change Planning Center or contact anyone; you decide what happens next.",
      "Looks good — start it", "Change it", "Not now",
    ]) expect(page).toContain(line);
    expect(page).not.toMatch(HIDDEN_WORDS);
    expect(page).not.toMatch(NEVER);
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
    expect(granted).toContain("Planning Center Services and Calendar, organization 1001. Reads only.");
    expect(granted).toContain("Looks good — start it");
  });

  it("says when a plan would end before the Sunday chosen in Settings", () => {
    const sat = "2026-11-14T15:00:00.000Z";
    const early = defaultPlan("keep-sunday-covered", sat, ET);
    const page = render(React.createElement(PlanCard, { plan: early, context: context({ now: () => sat, sunday: "2026-11-22" }), actions }));
    expect(page).toContain("This ends before Sunday, November 22, the Sunday chosen in Settings. Change it if you meant that Sunday.");
    const matched = defaultPlan("keep-sunday-covered", sat, ET, { sunday: "2026-11-22" });
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
    expect(page).toContain("Keep Sunday covered Checks every day until Sunday and tells you when a role needs a decision.");
    expect(page).toContain("Morning briefing Prepares Today's briefing each morning at the time you choose, if this Mac is awake and Ozzie is running.");
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
    expect(startedText(sunday(), context())).toBe("Ozzie is checking now, then every day at 7:00 AM, and sooner when something changes. Also at 12:00 PM and 5:00 PM in the two days before Sunday. Only while this Mac is awake and Ozzie is running. Stop it any time in What runs automatically.");
    expect(startedText(sunday(), context({ connected: false }))).toMatch(/^Ozzie will check as soon as Planning Center is connected, then every day at 7:00 AM/u);
    expect(startedText(sunday(), context({ pausedAll: true }))).toMatch(/^Everything is paused, so Ozzie won't check until you resume everything\. Then every day at 7:00 AM/u);
    for (const c of [context(), context({ connected: false }), context({ pausedAll: true })]) expect(startedText(sunday(), c)).not.toMatch(HIDDEN_WORDS);
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
    expect(PURPOSE["morning-briefing"]).toBe("Prepares Today's briefing each morning at the time you choose, if this Mac is awake and Ozzie is running.");
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

describe("What runs automatically: the home for responsibilities", () => {
  const items = [
    responsibility(sunday(), { runs: [run()] }),
    responsibility(defaultPlan("morning-briefing", FRI, ET), { id: "00000000-0000-4000-8000-000000000002", status: "paused" }),
    responsibility(defaultPlan("follow-ups-without-owner", FRI, ET), { id: "00000000-0000-4000-8000-000000000003", runs: [run({ outcome: "failed", code: "provider-failure", noticed: 0, drafts: 0 })] }),
  ];
  const v = view({ items, next: { [items[0]!.id]: "2026-11-20T17:00:00.000Z" } });
  const list = (over: Partial<RunnerView> = {}) => render(React.createElement(ResponsibilityList, { view: { ...v, ...over }, context: context(), runner: fakeRunner({ ...v, ...over }), actions }));

  it("lists each with a plain status, its schedule, last and next check, and controls", () => {
    const page = list();
    expect(page).toContain("What Ozzie is keeping an eye on");
    expect(page).toContain("Keeping an eye on it");
    expect(page).toContain("Paused");
    expect(page).toContain("Couldn't finish last time");
    expect(page).toMatch(/Last check .+, when it started\. Finished: 4 things need you; 1 note ready to review\./u);
    expect(page).toMatch(/Couldn't finish: Planning Center didn't answer\./u);
    expect(page).toContain("1 of 6 checks used in the last 24 hours.");
    for (const button of ["Check now", "Pause", "Resume", "Change", "Stop", "Pause everything", "Set up something new"]) expect(page).toContain(button);
    expect(page).toContain("Ozzie keeps checking while its window is closed; it stays in the menu bar.");
    expect(page).not.toMatch(HIDDEN_WORDS);
    expect(page).not.toMatch(NEVER);
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
    expect(problemText("cancelled")).toBe("it was paused before it finished");
    // Waiting for Planning Center: says so rather than "Not scheduled".
    const waiting = render(React.createElement(ResponsibilityList, { view: view({ items: [r] }), context: context({ connected: false }), runner: fakeRunner(view()), actions }));
    expect(waiting).toContain("Next check As soon as Planning Center is connected.");
  });

  it("says when everything is paused, and when there's nothing yet", () => {
    const paused = list({ paused_all: true });
    expect(paused).toContain("Everything is paused. Nothing runs automatically until you resume.");
    expect(paused).toContain("Resume everything");
    expect(paused).toContain("Paused with everything");
    const empty = list({ items: [] });
    expect(empty).toContain("Nothing yet. Ask Ozzie something like “Keep an eye on Sunday”, or set one up here.");
    expect(list({ available: false })).toContain("couldn't be read on this Mac right now");
  });
});

describe("Today: what comes to the person", () => {
  const item = (over: Partial<NoticedItem>): NoticedItem => ({ id: "x", responsibility_id: "r", template: "keep-sunday-covered", at: FRI, kind: "found", ...over });
  const noticed: NoticedItem[] = [
    item({ id: "a", decisions: 2, looks: 1, drafts: 1, notice: "sent", changes: [{ id: "c", kind: "confirmed-declined", effect: "worse", urgency: "urgent", position: "Greeter", person_id: "501" }] }),
    item({ id: "b", kind: "missed", scheduled_for: "2026-11-20T12:00:00.000Z", missed_reason: "asleep", ran_at: FRI, missed_count: 1 }),
    item({ id: "c", template: "morning-briefing", kind: "briefing", notice: "held" }),
    item({ id: "d", kind: "couldnt-check", code: "provider-failure", retry_at: "2026-11-20T16:00:00.000Z", scheduled_for: FRI }),
    item({ id: "e", kind: "clear" }),
  ];
  const v = view({ items: [responsibility(sunday(), { runs: [run()] })], noticed, prepared: { a: { summary: "Greeter still needs one person.", draft: null } } });

  it("shows what Ozzie noticed, with prepared work, names only from this Mac's check", () => {
    const page = render(React.createElement(NoticedFeed, { view: v, names, now: FRI, onOpen: () => {} }));
    expect(page).toContain("Ozzie noticed");
    expect(page).toContain("Keep Sunday covered: 2 things need a decision.");
    expect(page).toContain("Avery Brightwater declined Greeter after confirming.");
    expect(page).toContain("Greeter still needs one person.");
    expect(page).toContain("1 note is ready for you to review and send yourself.");
    expect(page).toMatch(/Your Mac was asleep at .+, so Ozzie checked at .+ instead\./u);
    expect(page).toContain("Your morning briefing is ready.");
    expect(page).toContain("Notice waiting for quiet hours to end");
    expect(page).toMatch(/Ozzie couldn't check Sunday at .+ — Planning Center didn't answer\. It will try again at .+\./u);
    // A check that found nothing new isn't news.
    expect(page).not.toContain("Nothing new needs a decision");
    const nameless = render(React.createElement(NoticedFeed, { view: v, names: {}, now: FRI, onOpen: () => {} }));
    expect(nameless).toContain("Someone declined Greeter after confirming.");
    for (const name of Object.values(names)) expect(nameless).not.toContain(name);
    expect(page).not.toMatch(HIDDEN_WORDS);
  });

  it("lists each responsibility with its next check, and Today shows both first", () => {
    const strip = render(React.createElement(WatchStrip, { view: { ...v, next: { [v.items[0]!.id]: "2026-11-20T17:00:00.000Z" } }, now: FRI, onAutomatic: () => {} }));
    expect(strip).toMatch(/What Ozzie is keeping an eye on Keep Sunday covered · next check .+ · last: 4 to look at/u);
    const none = render(React.createElement(WatchStrip, { view: view(), now: FRI, onAutomatic: () => {} }));
    expect(none).toContain("Nothing yet. Ask Ozzie, “Keep an eye on Sunday,” and it will check without being asked again.");
    const today = render(React.createElement(TodayPage, { brief: null, onSunday: () => {}, names, watch: { view: v, now: FRI, onAutomatic: () => {}, onOpen: () => {} } }));
    expect(today.indexOf("Ozzie noticed")).toBeLessThan(today.indexOf("Fictional import"));
    expect(today.indexOf("What Ozzie is keeping an eye on")).toBeLessThan(today.indexOf("Fictional import"));
  });
});

describe("open at login and the closed window", () => {
  const off = { get: () => new Promise<boolean>(() => {}), set: async (v: boolean) => v };
  it("is offered in setup, unticked until the person chooses", () => {
    const html = renderToStaticMarkup(React.createElement(SetupFlow, {
      status: null, settings: { clientId: "", organization: "", serviceTypeId: "", planId: "" }, onSettings() {}, onStatus() {}, prefs: DEFAULT_PREFS,
      onModel() {}, onClose() {}, onExample() {}, onAutomatic() {}, initial: "automatic", autostart: off,
    }));
    expect(text(html)).toContain("Open Ozzie when I log in");
    expect(text(html)).toContain("When you close its window, it keeps running in the menu bar.");
    expect(text(html)).toContain("Nothing runs after you quit Ozzie.");
    expect(html).not.toMatch(/type="checkbox" checked=""[^>]*>\s*<span>Open Ozzie when I log in/u);
    expect(render(React.createElement(AutostartToggle, { autostart: off }))).toContain("Off unless you turn it on.");
  });
  it("Settings explains the menu bar and how to quit", () => {
    const page = (autostart?: typeof off) => render(React.createElement(ConnectionPage, {
      status: null, settings: { clientId: "", organization: "", serviceTypeId: "", planId: "" }, onSettings() {}, onStatus() {}, autostart,
    }));
    expect(page(off)).toContain("When the window is closed Ozzie keeps running in the menu bar when you close its window, so it can keep an eye on what you asked. To stop it completely, choose Quit Ozzie from the menu bar icon.");
    expect(page()).not.toContain("When the window is closed");
  });
});
