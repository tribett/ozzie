// Planning Center's jobs, byte for byte as before jobs ran for B1 Church and Breeze (recorded from 0.7.0's code, f6d705d4,
// before that change): every page a job appears on (the plan to confirm, the template picker, Keeping watch's list,
// Today's cards and the morning briefing's preview), the words a run is said in, and what the runner keeps on this Mac.
// Each page is rendered with no church system's words (Planning Center's, the default), then hashed. Times on this Mac's
// clock are set aside first (they follow the zone a test runs in); every other character counts. Fixed fictional data.
import { createHash } from "node:crypto";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => { throw new Error("NATIVE_CALL_FORBIDDEN"); }) }));
import { defaultPlan, TEMPLATES, untilLifetime, type Plan, type Responsibility, type RunRow } from "../../../core/src/harness/responsibilities.js";
import { nov22Capture } from "../../../core/src/fictional-sunday.js";
import { withFictionalOperations } from "../../../core/src/fictional-operations.js";
import { buildSundayBrief } from "../../../core/src/sunday-brief.js";
import { DEFAULT_QUIET_HOURS } from "../../../core/src/schedule.js";
import type { SundayCapture } from "../../../core/src/sunday-capture.js";
import { createRunner, type NoticedItem, type Runner, type RunnerView } from "../src/responsibility-runner.js";
import { NoticedCard, PlanCard, ResponsibilityList, startedText, TemplatePicker, watchLine, type PlanActions, type PlanContext } from "../src/responsibility-views.js";
import { limitsText, NO_WRITEUP, noticedTitle, problemText, runText, WRITEUP_CHECK, WRITEUP_HOW } from "../src/responsibility-words.js";
import { TodayPage } from "../src/today-page.js";
import { BriefingPreview } from "../src/sunday-ready.js";
import { fakeJobStore, memoryStore } from "./job-fakes.js";

const ET = "America/New_York";
const FRI = "2026-11-20T15:00:00.000Z";
const THU = "2026-11-19T12:00:00.000Z";
const names = nov22Capture().names;
const context = (over: Partial<PlanContext> = {}): PlanContext => ({
  organization: "1001", granted: ["services"], modelReady: true, connected: true, zone: ET, macZone: ET, now: () => FRI, church: "Harbor Example Church", ...over,
});
const actions: PlanActions = { start: async () => ({}), onSettings: () => {}, onAutomatic: () => {} };
/** Times, weekdays and dates on this Mac's clock, set aside so the hash is the same in every zone a test runs in. */
const steady = (html: string) => html
  .replace(/\b(?:tomorrow at |at |on )?(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:at )?)?\d{1,2}:\d{2}(?:\s|&nbsp;|\u202f)?[AP]M\b/gu, "T")
  .replace(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}\b/gu, "D")
  .replace(/\bchecked (?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day, (?:January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}\b/gu, "checked D");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const html = (el: React.ReactElement) => steady(renderToStaticMarkup(el));
const sunday = (): Plan => ({ ...defaultPlan("keep-sunday-covered", FRI, ET), lifetime: untilLifetime("2026-11-22", ET)! });
const run = (over: Partial<RunRow> = {}): RunRow => ({
  run_id: "00000000-0000-4000-8000-0000000000aa", trigger: "start", started_at: FRI, ended_at: FRI, outcome: "ok", code: null, noticed: 4, drafts: 1, ai_steps: 2, ...over,
});
function job(plan: Plan, over: Partial<Responsibility> = {}): Responsibility {
  const t = TEMPLATES[plan.template];
  return { ...plan, id: "00000000-0000-4000-8000-000000000001", title: t.title, skill_id: t.skill_id, status: "active", created_at: FRI, confirmed_at: FRI, runs: [], open_run: null, ...over };
}
const view = (over: Partial<RunnerView> = {}): RunnerView => ({
  available: true, paused_all: false, items: [], noticed: [], writeups: {}, next: {}, running: null, unseen: 0, open_today: false, ...over,
});
const fakeRunner = (v: RunnerView): Runner => ({
  start() {}, refresh: async () => {}, tick: async () => {}, wake() {}, takes: () => false, changes: async () => false, captured() {}, pausedElsewhere: async () => {},
  create: async () => v.items[0]!, edit: async () => v.items[0]!,
  pause: async () => {}, resume: async () => {}, stop: async () => {}, pauseAll: async () => {}, runNow: async () => ({ status: "skipped" }),
  markSeen() {}, clearOpenToday() {}, keepWriteupsFor() {}, forgetAllWriteups() {}, view: () => v, subscribe: () => () => {},
});

const keep = job(sunday(), { runs: [run()] });
const morning = job(defaultPlan("morning-briefing", FRI, ET), { id: "00000000-0000-4000-8000-000000000002", runs: [run({ run_id: "00000000-0000-4000-8000-0000000000ab", outcome: "failed", code: "provider-failure", noticed: 0, drafts: 0 })] });
const item = (over: Partial<NoticedItem>): NoticedItem => ({ id: "x", responsibility_id: keep.id, template: "keep-sunday-covered", at: FRI, kind: "found", ...over });
const noticed: NoticedItem[] = [
  item({ id: "a", decisions: 2, looks: 1, drafts: 1, notice: "sent", run_id: run().run_id, changes: [{ id: "c", kind: "confirmed-declined", effect: "worse", urgency: "urgent", position: "Greeter", person_id: "501" }] }),
  item({ id: "b", kind: "missed", scheduled_for: "2026-11-20T12:00:00.000Z", missed_reason: "asleep", ran_at: FRI, missed_count: 2 }),
  item({ id: "c", responsibility_id: morning.id, template: "morning-briefing", kind: "briefing", notice: "held", sunday_ready: true, overnight_count: 2, kept: [{ kind: "needs-people", count: 2 }] }),
  item({ id: "d", kind: "couldnt-check", code: "provider-failure", retry_at: "2026-11-20T16:00:00.000Z", scheduled_for: FRI }),
  item({ id: "e", kind: "clear" }),
  item({ id: "f", kind: "limit" }),
  item({ id: "g", kind: "missed", scheduled_for: "2026-11-20T12:00:00.000Z", missed_reason: "waiting", before_end: true, missed_count: 1 }),
  item({ id: "h", kind: "ended", until: "2026-11-22" }),
  item({ id: "i", template: "watch-room-bookings", kind: "couldnt-check", code: "denied", access: true, scheduled_for: FRI }),
];
const v = view({ items: [keep, morning], noticed, next: { [keep.id]: "2026-11-20T17:00:00.000Z" }, writeups: {
  a: { item: "a", responsibility_id: keep.id, run_id: run().run_id, organization: "1001", at: FRI, kind: "written",
    lines: ["Greeter still needs one person.", "{{person:501}} hasn't accepted Greeter yet."], based_on: "Based on: Planning Center Services, checked Fri, Nov 20, 10:00 AM",
    gaps: [], steps: ["Looked at the open roles for Sunday — all of it"], ai_steps: 2 },
  c: { item: "c", responsibility_id: morning.id, run_id: "00000000-0000-4000-8000-0000000000bb", organization: "1001", at: FRI, kind: "none", why: "spent" },
} });
const pcBrief = buildSundayBrief(nov22Capture(), { sundayLeads: [], checkInAfterSundaysInARow: 3 }, nov22Capture().completed_at);
const store = () => { const m = new Map<string, string>(); return { get: (k: string) => m.get(k) ?? null, set: (k: string, x: string) => { m.set(k, x); } }; };

/** Everything a Planning Center church sees of its jobs, rendered. */
function pages(): Record<string, string> {
  return {
    plan: html(React.createElement(PlanCard, { plan: sunday(), assumed: ["lifetime"], context: context(), actions })),
    briefingPlan: html(React.createElement(PlanCard, { plan: defaultPlan("morning-briefing", FRI, ET), context: context({ connected: false, modelReady: false }), actions })),
    roomsPlan: html(React.createElement(PlanCard, { plan: defaultPlan("watch-room-bookings", FRI, ET), context: context(), actions })),
    picker: html(React.createElement(TemplatePicker, { context: context(), actions, onCancel: () => {} })),
    list: html(React.createElement(ResponsibilityList, { view: v, context: context(), runner: fakeRunner(v), actions, sunday: React.createElement("p", null, "regular"), names })),
    listAlone: html(React.createElement(ResponsibilityList, { view: view(), context: context({ connected: false }), runner: fakeRunner(view()), actions })),
    cards: noticed.map(i => html(React.createElement(NoticedCard, { item: i, view: v, names, now: FRI, onOpen: () => {}, sundayReady: React.createElement("p", null, "ready") }))).join("\n"),
    preview: html(React.createElement(BriefingPreview, { next: "2026-11-23T12:00:00.000Z", thursday: "2026-11-26T12:00:00.000Z", zone: ET, brief: pcBrief, names, onSunday: () => {} })),
    today: html(React.createElement(TodayPage, { brief: pcBrief, onSunday: () => {}, names: { ...names }, now: FRI, zone: ET, store: store(),
      watch: { view: v, now: FRI, onAutomatic: () => {}, onOpen: () => {} } })),
    words: steady([
      startedText(sunday(), context(), undefined), startedText(sunday(), context({ connected: false }), undefined), startedText(sunday(), context({ signingIn: true }), undefined),
      startedText(sunday(), context({ pausedAll: true }), undefined), limitsText(sunday(), true), limitsText(sunday(), false), WRITEUP_CHECK, WRITEUP_HOW, ...Object.values(NO_WRITEUP),
      ...["provider-failure", "denied", "partial", "interrupted", "timeout", "cancelled", "unverified", "limit", "unavailable", "invalid", "transport", "no-model", "invalid-arguments", "invalid-task", "x"].map(problemText),
      ...noticed.map(i => noticedTitle(i, FRI)), runText(run(), FRI, noticed[0]), runText(run({ noticed: 0, drafts: 0 }), FRI, null),
      runText(morning.runs[0]!, FRI), watchLine(keep, v, FRI), watchLine(morning, v, FRI),
    ].join("\n")),
  };
}

/** A Planning Center job's first check and a briefing on Thursday, through the runner: what it keeps on this Mac. */
async function kept(): Promise<string> {
  let now = FRI;
  const clock = () => now;
  const fake = fakeJobStore(clock);
  const data = memoryStore();
  const notify = vi.fn(async () => {});
  const captureAt = (iso: string): SundayCapture => {
    const c = withFictionalOperations(nov22Capture());
    const delta = Date.parse(iso) - Date.parse(c.completed_at);
    const shift = (t: string) => new Date(Date.parse(t) + delta).toISOString();
    return { ...c, started_at: shift(c.started_at), completed_at: shift(c.completed_at), reads: c.reads.map(r => ({ ...r, checked_at: shift(r.checked_at) })) };
  };
  const runner = createRunner({ native: fake.native, store: data, now: clock, notify });
  runner.start({
    context: () => ({ ready: true, granted: ["services", "operations"], rules: { sundayLeads: [], checkInAfterSundaysInARow: 3 }, zone: ET, macZone: ET,
      quiet: DEFAULT_QUIET_HOURS, urgentWithinHours: 48, modelReady: false }),
    check: async () => captureAt(now), prepare: async () => null,
  });
  runner.keepWriteupsFor(nov22Capture().organization);
  // The church in use, as App says it (owner decision 2026-11-22: each job keeps the church it was confirmed for).
  runner.churchInUse({ church: nov22Capture().organization, name: "Harbor Example Church", system: "planning-center" });
  await runner.create(sunday());
  await runner.tick();
  now = THU;
  await runner.create({ ...defaultPlan("morning-briefing", THU, ET) });
  await runner.tick();
  now = "2026-11-20T17:00:00.000Z";
  await runner.tick();
  return JSON.stringify({ store: data.dump(), calls: fake.calls, notices: notify.mock.calls, view: runner.view() });
}

// Recorded from 0.7.0's code (f6d705d4), before jobs ran for B1 Church and Breeze; `preview` from the same code before its
// last sentence named the system a check read.
const PINS: Readonly<Record<string, string>> = {
  plan: "90e7bd66c5b997adccfdd844194b773750508e0749bb93139a00f95001beb7ac",
  briefingPlan: "a79d78135b4ed1062a223e4f1804aef018c1a452a50280e33841c576a4c56144",
  roomsPlan: "bd393c1169c4d233e1b5b2b8f3b57c7d84db1162ba305534937bdb29d4d2d3c8",
  picker: "d8cab11ee9420659402bf598f11fcec7b76c1485db66d959aeeea135329c4dc8",
  list: "f180bac1d1478f4879bb8fc8277ad21f8834d611abecc1ef74da907bddcc7c15",
  listAlone: "8687557d261b312d1627a76b125ffaa450c9d799c4b5c88ba18774f06637e46d",
  cards: "37d06c50943f8d843547c055fa21e69f01a420a6d9fb15077e9664df72f23b75",
  today: "25c8e49c4c8844c5ff42b0ecacfd0b8f07efb4842b675250f0570a07034338d4",
  preview: "d00741522ef7d8b64083389803077b38b536ce2880dc7d6d072926ff8c6416d0",
  words: "2058482cf4ae8aa86c9040e8624f40276c6af6ec23005c2c21c54b33a37824d0",
  // Changed deliberately with the owner's decision of 2026-11-22 (jobs keep the church they were confirmed for): the
  // same native calls and notices as 0.7.0; what is kept adds ozzie.responsibilities.churches.v1 (each job's church),
  // ozzie.responsibilities.switch.v1 (no questions: {}) and "church" on each noticed item. 0.7.0's was
  // fd60ff50a85e39a1477524a2c64cdf4e8b51b0565e33e03b58b0cd6afae0ba24.
  // Third-pass review of 0.8.0 (M1): also the last church in use Ozzie knew (ozzie.responsibilities.church.v1), so a
  // Planning Center church's jobs stay shown while it is disconnected. Before that, d6825a9f1030a6771f8059d202a42c34ee81d3ef5c56167b3b48dfda7921a7fd.
  kept: "392471339ef1d470cd6d1bca55bdfbd33ada7441ac54c9bb8cb2f069965e7a3a",
};

describe("Planning Center's jobs are byte for byte as before", () => {
  it("every page a job appears on", () => {
    const shown = pages();
    for (const [k, s] of Object.entries(shown)) expect(sha(s), k).toBe(PINS[k]);
  });

  it("what the runner keeps on this Mac, the native calls it makes and the notices it sends", async () => {
    expect(sha(await kept())).toBe(PINS["kept"]);
  });
});
