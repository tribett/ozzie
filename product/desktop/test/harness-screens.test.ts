// What the harness adds to each screen, on fixed fictional data with static rendering: What happened
// lists the task ledger in plain words, Church rules shows What the AI is asked to do, and Sunday's "Why I
// flagged this" links to the procedure behind each finding. No native calls.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => new Promise(() => {})) }));
import { bundledSkills } from "../../../core/src/harness/bundled-skills.js";
import { nov22Capture } from "../../../core/src/fictional-sunday.js";
import { withFictionalOperations } from "../../../core/src/fictional-operations.js";
import { sundayOperations } from "../../../core/src/operations-capture.js";
import { buildSundayBrief } from "../../../core/src/sunday-brief.js";
import { ActivityPage, byDay, dayLabel, LEDGER_UNAVAILABLE, RECENT_SHOWN, RecentWork } from "../src/activity-page.js";
import { PROCEDURE_ORDER } from "../src/harness-bridge.js";
import { aiText, stepText, taskAccount, taskLine, TOOL_PHRASES, type TaskEventRow } from "../src/harness-words.js";
import { HowOzzieChecks, RulesPage } from "../src/rules-page.js";
import { FIXED_HOW, GroupMeetings, OperationsSection, readsFor, SundayPage, Why } from "../src/sunday-page.js";
import { HIDDEN_WORDS, row, text } from "./harness-fakes.js";
import type { FailureCode } from "../../../core/src/harness/contract.js";
import { DayProvider } from "../src/day-words.js";
import { wednesdayWords } from "../../../core/test/fixtures/service-days/wednesday.js";

const skills = await bundledSkills();
const ordered = PROCEDURE_ORDER.map(id => skills.get(id)!);
const now = new Date("2026-11-20T23:00:00Z");
const at = "2026-11-20T21:42:00Z";
const ev = (sequence: number, type: TaskEventRow["type"], detail = ""): TaskEventRow => ({ task_id: "t", sequence, at, type, detail });
const clock = new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

// The native record's own shape (agent_tests.rs): each AI step is written twice, reserved ("1") and finished ("1 stop").
const answered = row({ kind: "ask", state: "verified", events: [
  ev(0, "admitted"), ev(1, "running"), ev(2, "model", "1"), ev(3, "model", "1 tool_calls"), ev(4, "tool", "sunday.open_needs complete"),
  ev(5, "tool", "sunday.who_could_help partial"), ev(6, "tool", "denied"), ev(7, "model", "2"), ev(8, "model", "2 stop"), ev(9, "verified"),
] });
const automatic = row({ task_id: "00000000-0000-4000-8000-000000000002", kind: "check", state: "verified", created_at: "2026-11-20T21:00:00Z",
  events: [ev(0, "admitted"), ev(1, "running"), ev(2, "tool", "planning_center.refresh complete"), ev(3, "verified")] });
const failed = row({ task_id: "00000000-0000-4000-8000-000000000003", kind: "ask", state: "failed", failure: "fidelity",
  events: [ev(0, "admitted"), ev(1, "running"), ev(2, "model", "1"), ev(3, "model", "1 stop"), ev(4, "failed", "fidelity")] });
const interrupted = row({ task_id: "00000000-0000-4000-8000-000000000004", kind: "skill", state: "failed", failure: "interrupted",
  events: [ev(0, "admitted"), ev(1, "running"), ev(2, "failed", "interrupted")] });

describe("What happened: the task ledger in plain words", () => {
  it("gives each task one line: what it was, how it ended, how much was looked at, and when", () => {
    expect(taskLine(answered, { now })).toBe(`Answered a question · checked · 3 things looked at · ${clock}`);
    expect(taskLine(automatic, { now, trigger: "automatic" })).toBe(`Planning Center check, on its own · ${new Date("2026-11-20T21:00:00Z").toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`);
    expect(taskLine(automatic, { now, trigger: "manual" })).toMatch(/^Planning Center check you started · /u);
    expect(taskLine({ ...automatic, events: [...automatic.events.slice(0, 2), ev(2, "tool", "planning_center.refresh partial"), ev(3, "verified")] }, { now }))
      .toMatch(/^Planning Center check · part of it couldn't be read · /u);
    expect(taskLine(failed, { now })).toBe(`A question · Couldn't finish: the answer couldn't be backed up by what Ozzie read · ${clock}`);
    // Every id the AI chose was one it had read, only too many of them (native step outcome "too-many-facts"): said so,
    // so beside "Answered on this Mac" the two rows explain why Ozzie answered itself (review L4).
    const tooMany = row({ ...failed, events: [ev(0, "admitted"), ev(1, "running"), ev(2, "model", "1"), ev(3, "model", "1 tool_calls"),
      ev(4, "tool", "sunday.overview complete"), ev(5, "model", "2"), ev(6, "model", "2 too-many-facts"), ev(7, "failed", "fidelity")] });
    expect(taskLine(tooMany, { now })).toBe(`A question · Couldn't finish: the AI's answer listed more facts than Ozzie checks in one answer · ${clock}`);
    expect(taskAccount(tooMany, { now }).ended).toBe("The AI's answer listed more facts than Ozzie checks in one answer, so it wasn't shown.");
    expect(stepText("model", "2 too-many-facts")).toBe("Asked the AI (step 2); the AI's answer listed more facts than Ozzie checks in one answer");
    expect(taskAccount(failed, { now }).ended).toBe("The AI's answer didn't check out against what Ozzie read, so nothing was shown.");
    expect(taskLine(interrupted, { now, procedures: skills })).toBe(`Sunday ready · Couldn't finish: it was stopped before it finished · ${clock}`);
    expect(taskLine(row({ kind: "ask", state: "cancelled" }), { now })).toBe(`A question · You stopped it · ${clock}`);
    // A Sunday check that couldn't finish says why, true to the cause (harness-bridge.ts checkFailure).
    const check = (failure: FailureCode) => row({ kind: "check", state: "failed", failure, events: [ev(0, "admitted"), ev(1, "running"), ev(2, "failed", failure)] });
    const why = (failure: FailureCode) => taskLine(check(failure), { now, trigger: "automatic" });
    expect(why("denied")).toBe(`Planning Center check, on its own · Couldn't finish: Planning Center access wasn't available · ${clock}`);
    // Out of reach, a 429 or a 5xx alike (review N, 8).
    expect(why("provider-failure")).toBe(`Planning Center check, on its own · Couldn't finish: Planning Center didn't answer just now · ${clock}`);
    expect(why("unverified")).toBe(`Planning Center check, on its own · Couldn't finish: Ozzie couldn't confirm which church its sign-in to Planning Center belongs to, so nothing was read · ${clock}`);
    expect(why("cancelled")).toBe(`Planning Center check, on its own · Couldn't finish: Ozzie's sign-in to Planning Center was busy with something else, or this Mac's credential storage was locked, so the check stopped · ${clock}`);
    expect(taskAccount(check("unverified"), { now, start: "automatic" }).ended)
      .toBe("Couldn't finish: Ozzie couldn't confirm which church its sign-in to Planning Center belongs to, so nothing was read.");
    expect(taskAccount(check("cancelled"), { now, start: "manual" }).ended)
      .toBe("Couldn't finish: Ozzie's sign-in to Planning Center was busy with something else, or this Mac's credential storage was locked, so the check stopped.");
    // Any other task keeps its own words for the same codes.
    expect(taskLine(row({ kind: "ask", state: "failed", failure: "cancelled" }), { now })).toBe(`A question · Couldn't finish: you stopped it · ${clock}`);
    expect(taskLine(row({ kind: "ask", state: "failed", failure: "unverified" }), { now })).toBe(`A question · Couldn't finish: something couldn't be confirmed · ${clock}`);
    expect(taskLine(row({ kind: "skill", skill_id: "room-check", state: "running" }), { now, procedures: skills })).toBe(`Room check · Still running · ${clock}`);
    // Another day shows the day too.
    const asked = new Date(answered.events.at(-1)!.at).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    expect(taskLine(answered, { now: new Date("2026-11-23T12:00:00Z") })).toContain(`· ${asked}, `);
  });

  it("opens each task to a short account: what started it, what Ozzie looked at, the AI, and how it ended (audit item 7)", () => {
    const t = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    // A question through the AI: two steps, three reads (one Ozzie doesn't allow is never named), checked, answered.
    expect(taskAccount(answered, { now })).toEqual({
      started: `You asked a question at ${clock}.`,
      looked: ["Looked at the open roles in the last check — all of it", "Looked at who is on the team for an open role — part of it couldn't be read",
        "Tried something Ozzie doesn't allow — not shared with Ozzie"],
      ai: "Ozzie asked the AI twice. The AI answered with a list of facts, which Ozzie checked against what it had read before writing anything.",
      ended: "Answered.",
    });
    expect(taskAccount(answered, { now, end: "nothing-needs-a-decision" }).ended).toBe("Nothing needed a decision.");
    expect(taskAccount(answered, { now, end: "not-covered" }).ended).toBe("What Ozzie read didn't answer it, and the answer said so.");
    // A question answered on this Mac: no AI.
    expect(taskAccount(row({ kind: "ask", state: "verified", events: [ev(0, "admitted"), ev(1, "running"), ev(2, "tool", "sunday.overview complete"), ev(3, "verified")] }),
      { now, start: "on-this-mac" })).toMatchObject({ looked: ["Looked at the overview of the last check — all of it"], ai: "No AI was used: Ozzie answered this on this Mac from its last check." });
    // The regular Sunday check, and one the leader started: Ozzie's own check, no AI.
    expect(taskAccount(automatic, { now, start: "automatic" })).toEqual({
      started: `Ozzie checked Planning Center on its own at ${t("2026-11-20T21:00:00Z")}.`, looked: ["Read the service from Planning Center — all of it"],
      ai: "No AI was used: this was Ozzie's own check of Planning Center.", ended: "Finished.",
    });
    expect(taskAccount(automatic, { now, start: "manual" }).started).toBe(`You asked Ozzie to check Planning Center at ${t("2026-11-20T21:00:00Z")}.`);
    // A job's run: named by the job and why it ran; the write-up stays with the job, never here.
    const job = row({ kind: "skill", skill_id: "sunday-ready", state: "verified", events: [ev(0, "admitted"), ev(1, "running"), ev(2, "model", "1"), ev(3, "model", "1 tool_calls"),
      ev(4, "tool", "sunday.overview complete"), ev(5, "tool", "sunday.not_checked complete"), ev(6, "model", "2"), ev(7, "model", "2 stop"), ev(8, "verified")] });
    expect(taskAccount(job, { now, start: "job:keep-sunday-covered:scheduled" })).toEqual({
      started: `Keep services covered ran on schedule, at ${clock}.`,
      looked: ["Looked at the overview of the last check — all of it", "Looked at what the check couldn't read — all of it"],
      ai: "Ozzie asked the AI twice. The AI answered with a list of facts, which Ozzie checked against what it had read before writing anything.",
      ended: "Finished. Ozzie wrote up the facts the AI chose, and the write-up is with this job.",
    });
    expect(taskLine(job, { now, trigger: "job:keep-sunday-covered:scheduled", procedures: skills })).toBe(`Keep services covered · checked · 2 things looked at · ${clock}`);
    expect(taskAccount(job, { now, start: "who-could-help" }).started).toBe(`You asked Ozzie to look at who could help with a role, at ${clock}.`);
    // Who could help: true to what the AI did, whether it asked for the list of people, and never a note shown (review G, N3, N4).
    const look = row({ kind: "skill", skill_id: "who-could-help", state: "verified", events: [ev(0, "model", "1"), ev(1, "model", "1 tool_calls"),
      ev(2, "tool", "sunday.who_could_help partial"), ev(3, "model", "2"), ev(4, "model", "2 stop"), ev(5, "verified")] });
    expect(taskAccount(look, { now, start: "who-could-help", end: "facts" }).ended).toBe("Finished. Ozzie showed what the AI found beside the list from its own check.");
    expect(taskAccount(job, { now, start: "who-could-help", end: "facts" }).ended)
      .toBe("Finished. The AI didn't ask for this role's list of people; Ozzie showed what it said about the role.");
    expect(taskAccount(look, { now, start: "who-could-help", end: "draft" }).ended).toBe("Finished. The AI asked for a note, which isn't prepared from this card.");
    expect(taskAccount(look, { now, start: "who-could-help", end: "not-covered" }).ended).toBe("The AI couldn't tell more than the list showed, and Ozzie said so.");
    expect(taskAccount(job, { now, procedures: skills }).started).toBe(`Sunday ready ran at ${clock}.`);
    // How it ended when it didn't answer.
    expect(taskAccount(failed, { now }).ended).toBe("The AI's answer didn't check out against what Ozzie read, so nothing was shown.");
    expect(taskAccount(row({ kind: "skill", state: "failed", failure: "limit" }), { now }).ended).toBe("Stopped at its limit.");
    expect(taskAccount(interrupted, { now }).ended).toBe("Couldn't finish: it was stopped before it finished.");
    expect(taskAccount(row({ kind: "skill", state: "cancelled" }), { now, start: "job:morning-briefing:scheduled" }).ended).toBe("Stopped by you.");
    expect(taskAccount(row({ kind: "ask", state: "running" }), { now }).ended).toBe("Still running.");
    expect(aiText("ask", undefined, 0, false)).toBe("Ozzie didn't reach the AI.");
    // 13 fixed sentences, each pinned to its tool (review H, M15), none a tool's own name.
    expect(TOOL_PHRASES).toEqual({
      "sunday.overview": "Looked at the overview of the last check", "sunday.open_needs": "Looked at the open roles in the last check",
      "sunday.who_could_help": "Looked at who is on the team for an open role", "sunday.pending_requests": "Looked at requests still waiting for an answer",
      "sunday.rule_checkins": "Looked at the check-ins your Church rules suggest", "sunday.not_checked": "Looked at what the check couldn't read",
      "rooms.conflicts": "Looked at room bookings", "followups.unowned": "Looked at follow-ups without an owner", "groups.clashes": "Looked at group meetings on the service's day",
      "today.attention": "Looked at the fictional email and calendar import", "rules.current": "Looked at your Church rules",
      "planning_center.refresh": "Looked at whether Planning Center needed reading again", "drafts.prepare_note": "Asked for a draft note",
    });
    expect(Object.keys(TOOL_PHRASES)).toHaveLength(13);
    // An out-of-date check isn't called a saved copy (L3); checking again where it isn't offered never reads as done (L2).
    expect(taskAccount(row({ kind: "ask", state: "verified", events: [ev(0, "tool", "sunday.overview stale")] }), { now }).looked)
      .toEqual(["Looked at the overview of the last check — from a check that is too old to treat as current"]);
    expect(taskAccount(row({ kind: "skill", state: "verified", events: [ev(0, "tool", "planning_center.refresh denied")] }), { now }).looked)
      .toEqual(["Didn't read Planning Center again: that isn't possible here"]);
    for (const [name, phrase] of Object.entries(TOOL_PHRASES)) { expect(phrase).not.toContain(name); expect(phrase).toMatch(/^[A-Z][a-z]/u); }
  });

  it("lists tasks newest first, each expandable, beside every read in the latest check", () => {
    const html = renderToStaticMarkup(React.createElement(ActivityPage, {
      capture: nov22Capture(), tasks: [automatic, failed, answered], procedures: skills, trigger: id => id === automatic.task_id ? "automatic" : undefined, now,
    }));
    const t = text(html);
    expect(t).toContain("What Ozzie did");
    expect(t).toContain("Recent work");
    expect(t).toContain("Every read in the latest check");
    expect(t.indexOf("A question · Couldn't finish")).toBeLessThan(t.indexOf("Planning Center check, on its own"));
    expect(html.match(/<details class="recent-task">/g)).toHaveLength(3);
    expect(html).not.toMatch(/<details[^>]*open/);
    expect(t).toContain("Looked at the open roles in the last check — all of it");
    expect(t).toContain("No AI was used: this was Ozzie's own check of Planning Center.");
    expect(t).toContain("The AI's answer didn't check out against what Ozzie read, so nothing was shown.");
    expect(t).toContain("Read the service's plan");
    expect(t).not.toMatch(HIDDEN_WORDS);
    expect(t).not.toMatch(/sunday\.|planning_center|tool_calls|fidelity|egress|answer-from/u);
  });

  it("groups recent work by day under Today, Yesterday or the date, and shows the newest 10 with Show earlier work", () => {
    const local = (day: number, hour: number) => new Date(2026, 10, day, hour, 0).toISOString();
    const here = new Date(2026, 10, 20, 18, 0);
    expect(dayLabel(local(20, 9), here)).toBe("Today");
    expect(dayLabel(local(19, 23), here)).toBe("Yesterday");
    expect(dayLabel(local(17, 9), here)).toBe(new Date(2026, 10, 17).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }));
    const tasks = Array.from({ length: 14 }, (_, i) => row({ task_id: `00000000-0000-4000-8000-${String(100 + i).padStart(12, "0")}`, kind: "check", state: "verified",
      created_at: local(20 - Math.floor(i / 5), 17 - (i % 5)), events: [ev(0, "admitted"), ev(1, "verified")] }));
    expect(byDay(tasks, here).map(d => [d.day, d.tasks.length])).toEqual([["Today", 5], ["Yesterday", 5], [dayLabel(local(18, 9), here), 4]]);
    const html = renderToStaticMarkup(React.createElement(RecentWork, { tasks, now: here }));
    expect(html.match(/<details class="recent-task">/g)).toHaveLength(RECENT_SHOWN);
    expect(html.match(/<h3 [^>]*class="recent-day-h">/g)).toHaveLength(2);
    expect(text(html)).toMatch(/Today .* Yesterday .* Show earlier work \(4 more\)/u);
    expect(html).toMatch(/<button type="button" class="btn btn-quiet btn-sm btn-flush" aria-expanded="false" aria-controls="[^"]+">/u);
    // Ten or fewer: no button.
    expect(renderToStaticMarkup(React.createElement(RecentWork, { tasks: tasks.slice(0, 10), now: here }))).not.toContain("Show earlier work");
  });

  it("says so quietly when the list isn't available, and nothing while loading", () => {
    const unavailable = renderToStaticMarkup(React.createElement(RecentWork, { tasks: null }));
    expect(text(unavailable)).toContain(LEDGER_UNAVAILABLE);
    expect(unavailable).not.toMatch(/role="alert"|problem/u);
    expect(renderToStaticMarkup(React.createElement(RecentWork, { tasks: undefined }))).toBe("");
    expect(text(renderToStaticMarkup(React.createElement(RecentWork, { tasks: [] })))).toContain("Nothing yet.");
    // The reads list still shows with an unavailable ledger.
    expect(text(renderToStaticMarkup(React.createElement(ActivityPage, { capture: nov22Capture(), tasks: null })))).toContain("Read the service's plan");
  });
});

describe("Church rules: What the AI is asked to do (review H, L6)", () => {
  it("lists every procedure by title and purpose, with its exact text under See how this works, read only", () => {
    const html = renderToStaticMarkup(React.createElement(HowOzzieChecks, { procedures: ordered }));
    const t = text(html);
    // The heading says what the text under it says: these are the AI's steps, not Ozzie's own checks.
    expect(t.trim()).toMatch(/^What the AI is asked to do These are the steps the AI follows when Ozzie asks it for help/u);
    expect(t).not.toContain("How Ozzie checks");
    for (const p of ordered) {
      expect(t).toContain(p.title);
      expect(t).toContain(p.purpose);
      expect(t).toContain(p.body.replace(/\s+/g, " "));
    }
    expect(html.match(/See how this works/g)).toHaveLength(ordered.length);
    expect(html).not.toMatch(/<details[^>]*open/);
    expect(html).not.toMatch(/<(?:input|textarea|select)/u);
    expect(t).not.toMatch(HIDDEN_WORDS);
  });

  it("opens the procedure a Sunday card pointed to", () => {
    const html = renderToStaticMarkup(React.createElement(HowOzzieChecks, { procedures: ordered, focus: "room-check" }));
    expect(html.match(/<details[^>]*open=""/g)).toHaveLength(1);
    expect(html).toMatch(/id="procedure-room-check"[^]*?<details[^>]*open=""/u);
  });

  it("sits on the Church rules page once the procedures are loaded", () => {
    const rules = { sundayLeads: [], checkInAfterSundaysInARow: 3 };
    expect(text(renderToStaticMarkup(React.createElement(RulesPage, { rules, onChange: () => undefined, positions: [], procedures: ordered })))).toContain("What the AI is asked to do");
    expect(text(renderToStaticMarkup(React.createElement(RulesPage, { rules, onChange: () => undefined, positions: [] })))).not.toContain("What the AI is asked to do");
  });
});

describe("Sunday: See how this works says the finding came from Ozzie's own check, with no AI (audit item 9a)", () => {
  const capture = withFictionalOperations(nov22Capture());
  const rules = { sundayLeads: [], checkInAfterSundaysInARow: 3 };
  const brief = buildSundayBrief(capture, rules, capture.completed_at, true);
  const operations = sundayOperations(capture, rules, {})!;

  it("names the reads each kind of finding is worked out from, in What happened's own words, and never a procedure", () => {
    for (const f of brief.findings) for (const r of readsFor(f)) expect(r).toMatch(/^Read |^Every read in this check/u);
    // Held to the engine in who-could-help.test.ts (review H, L5).
    expect(readsFor({ kind: "rooms" })).toEqual(["Read the service's plan", "Read the church's time zone", "Read the list of rooms", "Read room bookings for the service's day",
      "Read one event's room conflicts"]);
    expect(readsFor({ kind: "group-meetings" })).toEqual(["Read the service's plan", "Read the service times", "Read who is scheduled", "Read the church's time zone",
      "Read one person's groups", "Read one group's events on the service's day"]);
  });

  it("puts See how this works inside Why I flagged this on every card: Services, rooms, follow-ups and group meetings", () => {
    const needs = brief.findings.find(f => f.kind === "needs-people")!;
    const open = renderToStaticMarkup(React.createElement(Why, { finding: needs, checkedAt: brief.checked_at, defaultOpen: true }));
    expect(open).toContain("See how this works");
    // Folded until the person opens Why I flagged this.
    expect(renderToStaticMarkup(React.createElement(Why, { finding: needs, checkedAt: brief.checked_at }))).not.toContain("See how this works");
    const ops = renderToStaticMarkup(React.createElement(OperationsSection, { operations, whyOpen: true }));
    // Every card's Why I flagged this has it, the "couldn't be confirmed" card included.
    expect(ops.match(/See how this works/g)?.length).toBe(ops.match(/Why I flagged this/g)?.length);
    expect(ops.match(/See how this works/g)!.length).toBeGreaterThanOrEqual(operations.result!.findings.length);
    const groups = renderToStaticMarkup(React.createElement(GroupMeetings, { items: operations.group_meetings, names: capture.names, whyOpen: true }));
    expect(groups.match(/See how this works/g)?.length).toBe(operations.group_meetings.length);
    expect(FIXED_HOW).toMatch(/^Ozzie's own check of Planning Center found this, with no AI\./u);
    expect(FIXED_HOW).not.toMatch(/procedure|AI chose|the AI (?:looked|picked)/iu);
  });

  it("adds nothing to a card until Why I flagged this is opened, and no longer links a card to a procedure", () => {
    const page = renderToStaticMarkup(React.createElement(SundayPage, {
      brief, names: capture.names, busy: false, problem: "", sender: "", connected: false, hasRecording: false, configured: false, canReword: false,
      decisions: [], onDecisions: () => undefined, operations, onCheck: () => undefined, onRecording: () => undefined, onExample: () => undefined,
    }));
    expect(page).not.toContain("See how this works");
    expect(text(page)).not.toMatch(HIDDEN_WORDS);
    expect(text(page)).not.toMatch(/procedure|Who could help ·/u);
  });
});

describe("What happened for a church whose service is on a Wednesday (onboarding spec §5)", () => {
  it("names jobs and the procedure by the real day, and points to the Services page; a check's own line names no day", () => {
    const day = wednesdayWords();
    const job = row({ kind: "skill", skill_id: "sunday-ready", state: "verified", events: [ev(0, "admitted"), ev(1, "running"), ev(2, "tool", "sunday.overview complete"), ev(3, "verified")] });
    expect(taskLine(job, { now, day, trigger: "job:keep-sunday-covered:scheduled", procedures: skills })).toBe(`Keep services covered · checked · 1 thing looked at · ${clock}`);
    expect(taskAccount(job, { now, day, start: "job:keep-sunday-covered:scheduled" }).started).toBe(`Keep services covered ran on schedule, at ${clock}.`);
    expect(taskAccount(job, { now, day, procedures: skills }).started).toBe(`Ready for Wednesday ran at ${clock}.`);
    const lines = [taskLine(automatic, { now, day, trigger: "automatic" }), JSON.stringify(taskAccount(automatic, { now, day, start: "automatic" })), JSON.stringify(taskAccount(job, { now, day }))];
    for (const line of lines) expect(line).not.toContain("Sunday");
    const page = text(renderToStaticMarkup(React.createElement(DayProvider, { value: day }, React.createElement(ActivityPage, { capture: null, tasks: [], now }))));
    expect(page).toContain("Every read appears here once your services are checked, or when you open the fictional example on the Services page.");
    expect(page).not.toContain("Sunday");
    expect(page).not.toMatch(HIDDEN_WORDS);
  });
});
