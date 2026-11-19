// Round 3, live finding A: when Ozzie's AI's own check of a question turns it down (ozzie.church 400 invalid-request,
// native `not-accepted`), the Ask panel, What happened and rewording say so plainly, never "couldn't be reached".
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => new Promise(() => {})) }));
import { bundledSkills } from "../../../core/src/harness/bundled-skills.js";
import { HarnessSession } from "../../../core/src/harness/session.js";
import { agentStep, askOzzie, createAppHarness, stepFailure, StepNotes } from "../src/harness-bridge.js";
import { ASK_FAILURES, askedInRecord, askFailureText, FAILURE_REASONS, NOT_ACCEPTED, stepText, taskAccount, taskLine, type TaskEventRow } from "../src/harness-words.js";
import { problemText } from "../src/responsibility-words.js";
import { modelProblem } from "../src/model.js";
import { calls, fakeNative, fictionalData, row } from "./harness-fakes.js";

const skills = await bundledSkills();

describe("Ozzie's AI turning a question down", () => {
  it("is its own sentence in Ask, and What happened says it wasn't in a form Ozzie can run, never the network", () => {
    expect(stepFailure("not-accepted")).toBe("invalid-task");
    expect(stepFailure("provider-failure")).toBe("transport");
    const said = askFailureText(stepFailure("not-accepted"), "not-accepted");
    expect(said).toBe(ASK_FAILURES.notAccepted);
    expect(said).toContain("This isn't a connection problem");
    expect(said).not.toMatch(/couldn't be reached/u);
    // Review of round 3, M1: seen live at the second step, after the AI had the question, so it never says nothing was sent.
    expect(said).not.toMatch(/nothing was sent/u);
    expect(said).toContain("before the AI saw it");
    expect(FAILURE_REASONS["invalid-task"]).not.toMatch(/reached/u);
  });

  it("at the second step, as seen live: the Ask panel says so, after the first step's read", async () => {
    let step = 0;
    const fake = fakeNative(command => {
      if (command !== "agent_step") return {};
      step += 1;
      return step === 1 ? calls(["sunday.overview"]) : Promise.reject("not-accepted");
    });
    const notes = new StepNotes();
    const h = createAppHarness({ workspace_id: "fictional", data: fictionalData(), skills, session: new HarnessSession(), loop: "pi", step: agentStep(fake.invoke, notes) });
    for (const question of ["What still needs a decision this Sunday?", "Why is Greeter flagged?"]) {
      step = 0;
      expect(await askOzzie(h, question, { skills, notes }), question).toEqual({ state: "problem", code: "invalid-task", text: ASK_FAILURES.notAccepted });
    }
  });

  it("What happened says the step was turned down before the AI saw it, and doesn't count it as asking the AI", () => {
    // Native records each step reserved ("2") and finished ("2 not-accepted"); the task fails invalid-task.
    expect(stepText("model", "2 not-accepted")).toBe("Step 2 went to Ozzie's AI, whose own check turned it down before the AI saw it");
    const ev = (sequence: number, type: TaskEventRow["type"], detail = ""): TaskEventRow => ({ task_id: "t", sequence, at: "2026-11-20T21:42:00Z", type, detail });
    const failed = row({ kind: "ask", state: "failed", failure: "invalid-task", events: [
      ev(1, "admitted"), ev(2, "running"), ev(3, "model", "1"), ev(4, "model", "1 tool_calls"), ev(5, "tool", "sunday.overview complete"),
      ev(6, "model", "2"), ev(7, "model", "2 not-accepted"), ev(8, "failed", "invalid-task"),
    ] });
    expect(askedInRecord(failed)).toBe(1);
    const now = new Date("2026-11-20T22:00:00Z");
    expect(taskAccount(failed, { now }).ended).toBe(`Couldn't finish: ${NOT_ACCEPTED}.`);
    expect(taskLine(failed, { now })).toContain(NOT_ACCEPTED);
    expect(taskLine(failed, { now })).not.toMatch(/reached|didn't answer/u);
    // A job's write-up says the same in its own words.
    expect(problemText("invalid-task")).toBe("Ozzie's own check turned a step down before the AI saw it");
  });

  it("rewording says the same", () => {
    expect(modelProblem("not-accepted")).toBe("Ozzie's AI didn't accept this request, so nothing was sent to the AI. This isn't a connection problem; try again later. Your draft is unchanged.");
  });
});
