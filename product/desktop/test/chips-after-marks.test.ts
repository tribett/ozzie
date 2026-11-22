// Ask's suggested questions after the person's own marks (seen in 0.5.7: Nursery volunteer marked "Covered outside
// Planning Center" on the Services page, and Ask still offered "Who could cover Nursery volunteer?", "Why is Nursery
// volunteer flagged?" and a note for it). Now a role the person settled since the check, by a mark or by an add made
// through Ozzie that fills it, gives way to the next role still open, named with its service when two services hold it;
// undoing the mark brings it back; with nothing else open, the first role as before. With no marks the questions are
// exactly 0.5.7's (recorded from its code, d6c36f32). Display only: a question tapped is prepared like any other.
// Fixed fictional data.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => { throw new Error("NATIVE_CALL_FORBIDDEN"); }) }));
import { AskPanel, settledRoles } from "../src/ask-panel.js";
import { filledByAdds, type ChangeResult } from "../src/change-card.js";
import type { AskTurn } from "../src/harness-bridge.js";
import { askServices, MANY_SERVICES, mergedNames, mergeParts, teamServices } from "../src/services-merge.js";
import { rolePositions, suggestedQuestions, type ChipServices } from "../../../core/src/ask.js";
import { buildSundayBrief, type Finding, type SundayBrief } from "../../../core/src/sunday-brief.js";
import { decide, type SundayDecision } from "../../../core/src/sunday-decisions.js";
import { nov22Capture } from "../../../core/src/fictional-sunday.js";
import type { SundayCapture } from "../../../core/src/sunday-capture.js";
import { wednesdayCapture } from "../../../core/test/fixtures/service-days/wednesday.js";
import { bundledSkills } from "../../../core/src/harness/bundled-skills.js";
import { Harness } from "../../../core/src/harness/index.js";
import { TsLoop } from "../../../core/src/harness/ts-loop.js";
import { buildSystemBrief } from "../../../core/src/church-systems/brief.js";
import type { SystemCapture } from "../../../core/src/church-systems/types.js";
import { b1Capture, breezeCapture, NOW as SYSTEM_NOW } from "../../../core/test/church-systems/fixtures.js";

const rules = { sundayLeads: [], checkInAfterSundaysInARow: 3 };
const WEEKEND = "Weekend Service", YOUTH = "Ozzie Demo Youth Night (fictional)";
const AT = "2026-11-20T16:00:00Z";
const weekendCapture = () => nov22Capture();
const weekend = () => { const c = weekendCapture(); return buildSundayBrief(c, rules, c.completed_at); };
/** The second service: teams of its own, holding only a Nursery role (so Nursery is in both services, Greeter in one). */
const youthCapture = (): SundayCapture => ({ ...JSON.parse(JSON.stringify(wednesdayCapture()).replace(/\b75933(5[024])\b/gu, "85933$1")) as SundayCapture,
  service_type_id: "1700", plan_id: "94000001" });
const youth = (): SundayBrief => {
  const c = youthCapture(), b = buildSundayBrief(c, rules, c.completed_at);
  return { ...b, findings: b.findings.filter(f => f.position?.name === "Nursery"), positions: b.positions.filter(p => p.name === "Nursery") };
};
const system = (c: SystemCapture) => { const b = buildSystemBrief(c, { confirmedZone: c.church.time_zone }, SYSTEM_NOW); if (!b.ok) throw new Error(b.reason); return b.brief; };
const breezeAnswers = () => breezeCapture({ assignments: [
  { id: "71001", position_id: "9627", person_id: "157801", status: "unconfirmed", asked: null },
  { id: "71002", position_id: "9628", person_id: "157802", status: "accepted", asked: null }] });

/** Ask's suggestions as App builds them with two services watched: the first service's brief, every service's positions. */
function two() {
  const main = weekend(), other = youth();
  const m = mergeParts({ brief: main, decisions: [] }, [{ plan_id: "94000001", brief: other, decisions: [] }]);
  const teams = teamServices({ brief: main, name: WEEKEND }, [{ brief: other, name: YOUTH }])!;
  return { main, other, m, services: { teams, positions: rolePositions(m.brief) } as ChipServices, ask: { ...main, day: MANY_SERVICES } };
}
const need = (b: SundayBrief, role: string) => b.findings.find(f => f.kind === "needs-people" && f.position?.name === role)!;
const mark = (f: Finding, choice: SundayDecision["choice"] = "covered-outside") => decide(f, choice, "A parent is covering", AT);
/** An add made through Ozzie this session, as the Services page keeps its result (change-card.tsx ChangeResult). */
const added = (f: Finding, plan: string, over: Partial<ChangeResult> = {}): ChangeResult => ({
  id: 1, ask: { key: f.key, plan, service: WEEKEND, team: f.position!.team_id, role: f.position!.name, person: "512", full: "Sam Whitcombe", at: null },
  plan, day: "2026-11-22", sentence: "", tone: "made", row: "9990001", undo: "can", addedAt: "2026-11-20T15:20:00Z", answer: null, offAt: null, ...over,
});

// Recorded from 0.5.7's code (d6c36f32) with no marks.
const AS_057 = {
  one: ["Who could cover Greeter?", "What still needs a decision this Sunday?", "Why is Greeter flagged?", "Draft a note to someone who could cover Greeter"],
  two: ["Who could cover Greeter?", "What still needs a decision for your services?", "Why is Greeter flagged?", "Draft a note to someone who could cover Greeter"],
  b1: ["Who could cover Vocals?", "What still needs a decision this Sunday?", "Why is Vocals flagged?", "Draft a note to someone who could cover Vocals"],
  breeze: ["Who is scheduled this Sunday?", "Who hasn't answered yet?", "What still needs a decision this Sunday?", "Why is Teacher flagged?"],
};
const NURSERY_WEEKEND = ["Who could cover Nursery (Weekend Service)?", "What still needs a decision for your services?", "Why is Nursery (Weekend Service) flagged?",
  "Draft a note to someone who could cover Nursery (Weekend Service)"];

describe("Ask's suggested questions after the person's own marks", () => {
  it("with no marks, exactly 0.5.7's questions, for one service, two, B1 Church and Breeze", () => {
    const t = two();
    expect(suggestedQuestions(weekend())).toEqual(AS_057.one);
    expect(suggestedQuestions(weekend(), undefined, settledRoles(weekend(), []))).toEqual(AS_057.one);
    expect(suggestedQuestions(t.ask, t.services)).toEqual(AS_057.two);
    expect(suggestedQuestions(t.ask, t.services, settledRoles(t.main, []))).toEqual(AS_057.two);
    expect(suggestedQuestions(system(b1Capture()), undefined, new Set())).toEqual(AS_057.b1);
    expect(suggestedQuestions(system(breezeAnswers()), undefined, new Set())).toEqual(AS_057.breeze);
  });

  it("marking the first role covered or not needed moves them to the next open role, with its service when two services hold it; undoing comes back", () => {
    const t = two();
    const greeter = need(t.main, "Greeter");
    for (const choice of ["covered-outside", "not-needed"] as const) {
      expect(suggestedQuestions(t.ask, t.services, settledRoles(t.main, [mark(greeter, choice)])), choice).toEqual(NURSERY_WEEKEND);
    }
    // Undone (the mark taken away): back to the first role.
    expect(suggestedQuestions(t.ask, t.services, settledRoles(t.main, []))).toEqual(AS_057.two);
    // One service: the next role, named as it always is.
    const one = weekend();
    expect(suggestedQuestions(one, undefined, settledRoles(one, [mark(need(one, "Greeter"))])))
      .toEqual(["Who could cover Nursery?", "What still needs a decision this Sunday?", "Why is Nursery flagged?", "Draft a note to someone who could cover Nursery"]);
    // B1 Church: the same.
    const b1 = system(b1Capture());
    expect(suggestedQuestions(b1, undefined, settledRoles(b1, [mark(need(b1, "Vocals"))]))[0]).toBe("Who could cover Guitar?");
  });

  it("a mark a later check reopened counts as open again; with every role that needs people settled, the first as before", () => {
    const t = two();
    const greeter = need(t.main, "Greeter"), nursery = need(t.main, "Nursery");
    // A decision made when Planning Center counted none still needed, and this check counts one: reopened, so not settled.
    const reopened = { ...mark(greeter), facts: { ...mark(greeter).facts, remaining: 0 } };
    expect(suggestedQuestions(t.ask, t.services, settledRoles(t.main, [reopened]))).toEqual(AS_057.two);
    // Both roles that need people settled: who could cover falls back to the first, as before. Lyrics is still flagged
    // (pending, no mark can settle it), so that is what "Why is … flagged?" asks about.
    expect(suggestedQuestions(t.ask, t.services, settledRoles(t.main, [mark(greeter), mark(nursery)])))
      .toEqual(["Who could cover Greeter?", "What still needs a decision for your services?", "Why is Lyrics flagged?", "Draft a note to someone who could cover Greeter"]);
    // Nothing flagged but the settled roles: every question falls back to the first role.
    const only = { ...t.main, findings: [greeter, nursery] };
    expect(suggestedQuestions({ ...only, day: MANY_SERVICES }, t.services, settledRoles(only, [mark(greeter), mark(nursery)]))).toEqual(AS_057.two);
  });

  it("an add made through Ozzie that fills the role moves them on; taken off again, or shown by a later check, it doesn't count", () => {
    const t = two();
    const greeter = need(t.main, "Greeter"), plan = t.main.plan.id;
    // As App builds them: the person's marks, and what adds made this session fill (change-card.tsx filledByAdds).
    const chips = (results: ChangeResult[], b: SundayBrief = t.main) => suggestedQuestions({ ...b, day: MANY_SERVICES }, t.services, settledRoles(b, [], filledByAdds(b, results)));
    expect(greeter.remaining).toBe(1);
    expect(chips([added(greeter, plan)])).toEqual(NURSERY_WEEKEND);
    // Taken off again, or already gone: the place is open again.
    for (const result of ["removed", "already-gone"] as const) expect(chips([added(greeter, plan, { undo: "done", answer: { result }, offAt: AT })]), result).toEqual(AS_057.two);
    // Not taken off (Planning Center refused): the add stands.
    expect(chips([added(greeter, plan, { undo: "done", answer: { result: "refused-by-planning-center", status: 403, not_allowed: true } })])).toEqual(NURSERY_WEEKEND);
    // A check read after the add already shows it: never counted twice.
    expect(chips([added(greeter, plan)], { ...t.main, checked_at: "2026-11-20T15:30:00Z" })).toEqual(AS_057.two);
    // An add on another service's plan, an add whose answer isn't known, or one place of two: the role is still open.
    expect(chips([added(greeter, "94000001")])).toEqual(AS_057.two);
    expect(chips([added(greeter, plan, { tone: "look", row: null })])).toEqual(AS_057.two);
    expect(chips([added(greeter, plan)], { ...t.main, findings: t.main.findings.map(f => f.key === greeter.key ? { ...f, remaining: 2 } : f) })).toEqual(AS_057.two);
  });

  it("a settled role's own pending request gives way too, when another role is open", () => {
    const t = two();
    const greeter = need(t.main, "Greeter");
    // Someone pending on Greeter, listed right after Greeter's own finding (as the brief lists a role's findings).
    const pending: Finding = { id: "pending:x", key: "pending-x", kind: "pending", tone: "look", position: greeter.position!, person_id: "512", notification: "unsent", why: [] };
    const withPending = { ...t.main, findings: [greeter, pending, ...t.main.findings.filter(f => f !== greeter)] };
    expect(suggestedQuestions({ ...withPending, day: MANY_SERVICES }, t.services, settledRoles(withPending, [mark(greeter)])))
      .toEqual(NURSERY_WEEKEND);
    // Unmarked, exactly as before: Greeter first.
    expect(suggestedQuestions({ ...withPending, day: MANY_SERVICES }, t.services, settledRoles(withPending, []))).toEqual(AS_057.two);
  });

  it("only App takes the filled roles from the change code, and hands Ask nothing but keys", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const dir = new URL("../src/", import.meta.url);
    const imports = readdirSync(dir).filter(f => /\.tsx?$/u.test(f) && /import\s*\{[^}]*\bfilledByAdds\b[^}]*\}\s*from/u.test(readFileSync(new URL(f, dir), "utf8")));
    expect(imports).toEqual(["App.tsx"]);
    expect(readFileSync(new URL("App.tsx", dir), "utf8")).toContain("settledRoles(brief, decisions, filledByAdds(brief, changes.results))");
  });

  it("the Ask panel shows them, and a question tapped is prepared as any other: labels only", async () => {
    const t = two();
    const chipsOf = (html: string) => [...html.matchAll(/class="chip"[^>]*>([^<]*)</gu)].map(m => m[1]!.replaceAll("&#x27;", "'"));
    const panel = (settled?: ReadonlySet<string>) => renderToStaticMarkup(React.createElement(AskPanel, {
      open: true, onClose: () => {}, ask: () => new Promise<AskTurn>(() => {}), brief: t.ask, modelReady: true, onOpen: () => {}, services: t.services, settled }));
    expect(chipsOf(panel())).toEqual(AS_057.two);
    expect(chipsOf(panel(settledRoles(t.main, [mark(need(t.main, "Greeter"))])))).toEqual(NURSERY_WEEKEND);
    // The chip's text goes through the same preparation as anything typed: the role and service by their labels.
    const capture = mergedNames(weekendCapture(), [youthCapture()]);
    const asked = askServices({ brief: t.main, name: WEEKEND }, [{ plan_id: "94000001", brief: t.other, name: YOUTH }]);
    const h = new Harness({ workspace_id: "fictional", skills: await bundledSkills(), runtime: new TsLoop(), model: async () => { throw new Error("no model here"); },
      data: { capture, brief: t.m.brief, decisions: t.m.decisions, operations: null, rules, attention: null, granted: ["services"], mode: "live", connected: true,
        serviceOfTeam: t.services.teams, ...asked } });
    for (const chip of NURSERY_WEEKEND.filter(c => /Nursery/u.test(c))) {
      const prepared = h.prepare(chip);
      expect(prepared.ok, chip).toBe(true);
      if (prepared.ok) expect(prepared.question, chip).not.toMatch(/Nursery|Weekend|Youth/u);
    }
  });
});
