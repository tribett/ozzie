// What the harness adds to each screen, on fixed fictional data with static rendering: What happened
// lists the task ledger in plain words, Church rules shows How Ozzie checks, and Sunday's "Why I
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
import { ActivityPage, LEDGER_UNAVAILABLE, RecentWork } from "../src/activity-page.js";
import { PROCEDURE_ORDER } from "../src/harness-bridge.js";
import { taskLine, taskSteps, type TaskEventRow } from "../src/harness-words.js";
import { HowOzzieChecks, RulesPage } from "../src/rules-page.js";
import { GroupMeetings, OperationsSection, procedureFor, PROCEDURE_FOR, SundayPage, Why } from "../src/sunday-page.js";
import { HIDDEN_WORDS, row, text } from "./harness-fakes.js";

const skills = await bundledSkills();
const ordered = PROCEDURE_ORDER.map(id => skills.get(id)!);
const now = new Date("2026-11-20T23:00:00Z");
const at = "2026-11-20T21:42:00Z";
const ev = (sequence: number, type: TaskEventRow["type"], detail = ""): TaskEventRow => ({ task_id: "t", sequence, at, type, detail });
const clock = new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

const answered = row({ kind: "ask", state: "verified", events: [
  ev(0, "admitted"), ev(1, "running"), ev(2, "model", "1"), ev(3, "tool", "sunday.open_needs complete"), ev(4, "tool", "sunday.who_could_help partial"),
  ev(5, "tool", "denied"), ev(6, "model", "2"), ev(7, "verified"),
] });
const automatic = row({ task_id: "00000000-0000-4000-8000-000000000002", kind: "check", state: "verified", created_at: "2026-11-20T21:00:00Z",
  events: [ev(0, "admitted"), ev(1, "running"), ev(2, "tool", "planning_center.refresh complete"), ev(3, "verified")] });
const failed = row({ task_id: "00000000-0000-4000-8000-000000000003", kind: "ask", state: "failed", failure: "fidelity",
  events: [ev(0, "admitted"), ev(1, "running"), ev(2, "model", "1 stop"), ev(3, "failed", "fidelity")] });
const interrupted = row({ task_id: "00000000-0000-4000-8000-000000000004", kind: "skill", state: "failed", failure: "interrupted",
  events: [ev(0, "admitted"), ev(1, "running"), ev(2, "failed", "interrupted")] });

describe("What happened: the task ledger in plain words", () => {
  it("gives each task one line: what it was, how it ended, how much was looked at, and when", () => {
    expect(taskLine(answered, { now })).toBe(`Answered a question · checked · 3 things looked at · ${clock}`);
    expect(taskLine(automatic, { now, trigger: "automatic" })).toBe(`Automatic Sunday check · ${new Date("2026-11-20T21:00:00Z").toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`);
    expect(taskLine(automatic, { now, trigger: "manual" })).toMatch(/^Sunday check you started · /u);
    expect(taskLine({ ...automatic, events: [...automatic.events.slice(0, 2), ev(2, "tool", "planning_center.refresh partial"), ev(3, "verified")] }, { now }))
      .toMatch(/^Sunday check · part of this couldn't be read · /u);
    expect(taskLine(failed, { now })).toBe(`A question · Couldn't finish: the answer couldn't be backed up by what Ozzie read · ${clock}`);
    expect(taskLine(interrupted, { now, procedures: skills })).toBe(`Sunday ready · Couldn't finish: Ozzie closed before it finished · ${clock}`);
    expect(taskLine(row({ kind: "ask", state: "cancelled" }), { now })).toBe(`A question · You stopped it · ${clock}`);
    expect(taskLine(row({ kind: "skill", skill_id: "room-check", state: "running" }), { now, procedures: skills })).toBe(`Room check · Still running · ${clock}`);
    // Another day shows the day too.
    expect(taskLine(answered, { now: new Date("2026-11-23T12:00:00Z") })).toMatch(/· [A-Z][a-z]{2}, Nov 20, /u);
  });

  it("opens each task to its steps in plain words", () => {
    expect(taskSteps(answered)).toEqual([
      "Asked the AI (step 1)", "Looked at Sunday's open roles — complete", "Looked at who on the team could help — part of this couldn't be read",
      "Tried something Ozzie doesn't allow — not shared with Ozzie", "Asked the AI (step 2)", "Checked the facts it chose against what was read",
    ]);
    expect(taskSteps(automatic)).toEqual(["Read this Sunday from Planning Center — complete", "Finished the check"]);
    expect(taskSteps(failed)).toEqual(["Asked the AI (step 1); it chose the facts for the answer", "Stopped: the answer couldn't be backed up by what Ozzie read"]);
    expect(taskSteps(row({ kind: "ask", state: "failed", failure: "egress", events: [ev(0, "admitted"), ev(1, "running"), ev(2, "model", "1 egress"), ev(3, "failed", "egress")] })))
      .toEqual(["Asked the AI (step 1); it would have sent details Ozzie keeps on this Mac", "Stopped: it would have sent details Ozzie keeps on this Mac"]);
  });

  it("lists tasks newest first, each expandable, beside every read in the latest check", () => {
    const html = renderToStaticMarkup(React.createElement(ActivityPage, {
      capture: nov22Capture(), tasks: [automatic, failed, answered], procedures: skills, trigger: id => id === automatic.task_id ? "automatic" : undefined, now,
    }));
    const t = text(html);
    expect(t).toContain("What Ozzie did");
    expect(t).toContain("Recent work");
    expect(t).toContain("Every read in the latest check");
    expect(t.indexOf("A question · Couldn't finish")).toBeLessThan(t.indexOf("Automatic Sunday check"));
    expect(html.match(/<details class="recent-task">/g)).toHaveLength(3);
    expect(html).not.toMatch(/<details[^>]*open/);
    expect(t).toContain("Looked at Sunday's open roles — complete");
    expect(t).toContain("Read this Sunday's plan");
    expect(t).not.toMatch(HIDDEN_WORDS);
    expect(t).not.toMatch(/sunday\.|planning_center|tool_calls|fidelity|egress|answer-from/u);
  });

  it("says so quietly when the list isn't available, and nothing while loading", () => {
    const unavailable = renderToStaticMarkup(React.createElement(RecentWork, { tasks: null }));
    expect(text(unavailable)).toContain(LEDGER_UNAVAILABLE);
    expect(unavailable).not.toMatch(/role="alert"|problem/u);
    expect(renderToStaticMarkup(React.createElement(RecentWork, { tasks: undefined }))).toBe("");
    expect(text(renderToStaticMarkup(React.createElement(RecentWork, { tasks: [] })))).toContain("Nothing yet.");
    // The reads list still shows with an unavailable ledger.
    expect(text(renderToStaticMarkup(React.createElement(ActivityPage, { capture: nov22Capture(), tasks: null })))).toContain("Read this Sunday's plan");
  });
});

describe("Church rules: How Ozzie checks", () => {
  it("lists every procedure by title and purpose, with its exact text under See how this works, read only", () => {
    const html = renderToStaticMarkup(React.createElement(HowOzzieChecks, { procedures: ordered }));
    const t = text(html);
    expect(t).toContain("How Ozzie checks");
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
    expect(text(renderToStaticMarkup(React.createElement(RulesPage, { rules, onChange: () => undefined, positions: [], procedures: ordered })))).toContain("How Ozzie checks");
    expect(text(renderToStaticMarkup(React.createElement(RulesPage, { rules, onChange: () => undefined, positions: [] })))).not.toContain("How Ozzie checks");
  });
});

describe("Sunday: Why I flagged this links to the procedure", () => {
  const capture = withFictionalOperations(nov22Capture());
  const rules = { sundayLeads: [], checkInAfterSundaysInARow: 3 };
  const brief = buildSundayBrief(capture, rules, capture.completed_at, true);
  const operations = sundayOperations(capture, rules, {})!;

  it("maps each kind of finding to its procedure, and every one exists", () => {
    const needs = brief.findings.find(f => f.kind === "needs-people")!;
    const streak = brief.findings.find(f => f.kind === "streak")!;
    expect(procedureFor(needs)).toBe("who-could-help");
    expect(procedureFor(streak)).toBe("sunday-ready");
    expect(PROCEDURE_FOR).toEqual({ needs: "who-could-help", room: "room-check", followUp: "follow-up-owners", group: "group-night", overall: "sunday-ready" });
    for (const id of Object.values(PROCEDURE_FOR)) expect(skills.has(id)).toBe(true);
  });

  it("shows See how this works inside Why I flagged this when it can open the procedure", () => {
    const needs = brief.findings.find(f => f.kind === "needs-people")!;
    const opened: string[] = [];
    const open = renderToStaticMarkup(React.createElement(Why, { finding: needs, checkedAt: brief.checked_at, defaultOpen: true, onHow: () => opened.push("x") }));
    expect(open).toContain("See how this works");
    expect(renderToStaticMarkup(React.createElement(Why, { finding: needs, checkedAt: brief.checked_at, defaultOpen: true }))).not.toContain("See how this works");
    // Folded until the person opens Why I flagged this.
    expect(renderToStaticMarkup(React.createElement(Why, { finding: needs, checkedAt: brief.checked_at, onHow: () => undefined }))).not.toContain("See how this works");
    const ops = renderToStaticMarkup(React.createElement(OperationsSection, { operations, whyOpen: true, onHow: () => undefined }));
    expect(ops.match(/See how this works/g)?.length).toBe(operations.result!.findings.length);
    const groups = renderToStaticMarkup(React.createElement(GroupMeetings, { items: operations.group_meetings, names: capture.names, whyOpen: true, onHow: () => undefined }));
    expect(groups.match(/See how this works/g)?.length).toBe(operations.group_meetings.length);
  });

  it("adds nothing to a card until Why I flagged this is opened", () => {
    const page = (onHow?: (id: string) => void) => renderToStaticMarkup(React.createElement(SundayPage, {
      brief, names: capture.names, busy: false, problem: "", sender: "", connected: false, hasRecording: false, configured: false, canReword: false,
      decisions: [], onDecisions: () => undefined, operations, onCheck: () => undefined, onRecording: () => undefined, onExample: () => undefined,
      ...(onHow ? { onHow } : {}),
    }));
    expect(page()).toBe(page(() => undefined));
    expect(text(page())).not.toMatch(HIDDEN_WORDS);
  });
});
