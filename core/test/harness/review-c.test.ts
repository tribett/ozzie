// The end-to-end review of 2026-11-14 (section C): the question-side
// findings fixed in the webview, each as a regression test. Native ones (C4, C7, C8, C11's step reservation)
// are in core/native-auth/src/agent_tests.rs and ledger_tests.rs; the loops' context size in the conformance
// suite. Fictional names only.
import { describe, expect, it } from "vitest";
import { AskSession, buildAskContext, hasContactDetailStrict, prepareAsk, REFUSALS } from "../../src/ask.js";
import { FICTIONAL_ROOM } from "../../src/fictional-operations.js";
import { nov22Capture, PEOPLE } from "../../src/fictional-sunday.js";
import { buildSundayBrief } from "../../src/sunday-brief.js";
import type { AgentStepReply, ModelStep } from "../../src/harness/contract.js";
import { bundledSkills } from "../../src/harness/bundled-skills.js";
import { Harness, prepareAgentQuestion } from "../../src/harness/index.js";
import { namedIn } from "../../src/harness/names.js";
import { HarnessSession, restoreLabels } from "../../src/harness/session.js";
import { TsLoop } from "../../src/harness/ts-loop.js";
import { FRESH, harnessData } from "./fixtures.js";

const skills = await bundledSkills();
/** The fictional Sunday with these names, and its room called `room` (in the check and in the operations it read). */
const withNames = (names: Record<string, string>, room?: string) => {
  const capture = nov22Capture();
  capture.names = { ...capture.names, ...names };
  const data = harnessData({ capture });
  if (!room) return data;
  return { ...data, capture: { ...data.capture!, labels: { ...(data.capture!.labels ?? {}), [`room:${FICTIONAL_ROOM}`]: room } },
    operations: { ...data.operations!, labels: { ...data.operations!.labels, [`room${FICTIONAL_ROOM}`]: room } } };
};
const question = (data: ReturnType<typeof harnessData>, typed: string) => prepareAgentQuestion(new HarnessSession(), data, typed);

describe("C5: place names are kept whole while person names are replaced", () => {
  it("a room named after a member's surname becomes the room's label, never \"[Person N] Hall\"", () => {
    const data = withNames({}, "Thornbury Hall");
    const q = question(data, "Is Thornbury Hall double booked?");
    expect(q.ok && q.question).toMatch(/^Is \[Room \d+\] double booked\?$/u);
    // The surname alone is still the member.
    const riley = question(data, "Is Thornbury in Thornbury Hall this week?");
    expect(riley.ok && riley.question).toMatch(/^Is \[Person \d+\] in \[Room \d+\] this week\?$/u);
  });

  it("the gate before the loop sets the harness's own labels aside, so a member named Room or Step doesn't stop the question", async () => {
    const data = withNames({ [PEOPLE.sam]: "Pat Room" }, "Fellowship Hall");
    const model: ModelStep = async (): Promise<AgentStepReply> => ({ content: "{\"answer\":\"not-covered\"}", tool_calls: [], finish: "stop" });
    const h = new Harness({ workspace_id: "fictional", data, skills, runtime: new TsLoop(), model, now: () => FRESH, newId: () => "00000000-0000-4000-8000-0000000000c5" });
    const prepared = h.prepare("Is Fellowship Hall booked twice?");
    expect(prepared.ok && prepared.question).toMatch(/^Is \[Room \d+\] booked twice\?$/u);
    const task = { id: "00000000-0000-4000-8000-0000000000c5", kind: "ask" as const, skill_id: "answer-from-what-was-read", question: prepared.ok ? prepared.question : "", workspace_id: "fictional", created_at: FRESH };
    expect(h.check(task)).toBeNull();
    expect(namedIn("Is [Room 1] booked twice?", { "1": "Pat Room" })).toBe(false);
    expect(namedIn("Is Room 1 booked twice?", { "1": "Pat Room" })).toBe(true);
  });
});

describe("C6: the \"capitalized only\" rule refined for weekdays, months, \"Church rules\" and contractions", () => {
  it("a member named Sunday, June or Church doesn't turn ordinary words into labels or refusals", () => {
    const data = withNames({ [PEOPLE.sam]: "Quinn Sunday", [PEOPLE.casey]: "June Church", [PEOPLE.drew]: "Don Halvorsen" });
    for (const typed of ["Who could cover Greeter this Sunday?", "What do the Church rules say about Sundays?", "Is anything due in June?", "Don't we have a lead for Nursery?"]) {
      const q = question(data, typed);
      expect(q.ok, typed).toBe(true);
      expect(q.ok && q.question, typed).not.toMatch(/\[(?:Person|a team member)/u);
    }
    // Beside the rest of the name, or a common word written as a name, it is still the member.
    expect(question(data, "Can Quinn Sunday cover Greeter?")).toMatchObject({ ok: true, question: expect.stringMatching(/^Can \[Person \d+\] cover \[Role \d+\]\?$/u) });
    expect(question(data, "Is Sunday, Quinn free?")).toMatchObject({ ok: true, question: expect.stringMatching(/^Is \[Person \d+\] free\?$/u) });
    expect(question(data, "Can Don cover Greeter?")).toMatchObject({ ok: true, question: expect.stringMatching(/^Can \[Person \d+\] cover \[Role \d+\]\?$/u) });
  });
});

describe("C11: a written-out email is contact detail, and \"[a team member]\" restores to plain words", () => {
  it("refuses an email address written out before anything is sent", () => {
    for (const typed of ["Is pat [at] example [dot] org on the team?", "Is pat at example dot org right?", "Who is pat (at) example.org?", "Call 555----123----4567 about Greeter"]) {
      expect(question(harnessData(), typed), typed).toEqual({ ok: false, refusal: REFUSALS.contact });
    }
    expect(question(harnessData(), "Look at the plan for Greeter at 9:30.").ok).toBe(true);
  });

  it("restores [a team member] as \"a team member\"", () => {
    expect(restoreLabels("Is [a team member] on [Role 9]?", new HarnessSession(), { names: {} })).toBe("Is a team member on a role?");
  });

  it("matches the native strict contact vectors (core/test/ask-parity.json pendingNative.contact)", async () => {
    const parity = (await import("../ask-parity.json", { with: { type: "json" } })).default as { pendingNative: { contact: { found: string[]; notFound: string[] } } };
    for (const text of parity.pendingNative.contact.found) expect(hasContactDetailStrict(text), text).toBe(true);
    for (const text of parity.pendingNative.contact.notFound) expect(hasContactDetailStrict(text), text).toBe(false);
  });
});

describe("Usability (question side): only actual requests to contact people or change records are refused as sending or changing", () => {
  const capture = nov22Capture();
  const brief = buildSundayBrief(capture, { sundayLeads: [], checkInAfterSundaysInARow: 3 }, capture.completed_at, true);
  const prepare = (typed: string) => {
    const session = new AskSession();
    const context = buildAskContext(session, { brief, names: capture.names, organization: capture.organization }, { timeZone: "America/New_York" })!;
    return prepareAsk(session, context, typed);
  };
  it("passes the review's questions", () => {
    for (const typed of [
      "Can you confirm whether Greeter is covered?", "Could you update me on Sunday?", "Can you add up how many people are confirmed?",
      "Please call out anything I missed.", "Please post the open roles summary here.", "Mark is asking: who covers Nursery?",
      "What percent of our roles are filled?", "How many roles are filled, as a %?", "Can you send me the open roles?", "Remind me who is pending.",
      "Can you change the wording of the note?", "Ask Riley about Greeter",
    ]) expect(prepare(typed).ok, typed).toBe(true);
  });
  it("still refuses requests to contact someone or change a record", () => {
    for (const typed of [
      "Text Riley about Sunday", "Send a reminder to the team", "Email the volunteers", "Can you call Riley?", "Please notify everyone.",
      "Remind them about Sunday", "Post this to the team", "Add Riley to Greeter", "Assign someone to Nursery", "Schedule Casey for Sunday",
      "Update the schedule", "Change Nursery to two people", "Delete the booking", "Cancel the room booking", "Mark Riley as confirmed",
      "Confirm Riley for Greeter", "Let Riley know", "Can you reach out to Riley?", "I need you to update Planning Center", "Who is free? Then text them.",
    ]) expect(prepare(typed), typed).toEqual({ ok: false, refusal: REFUSALS.send });
  });
});
