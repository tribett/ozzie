// Round 5, live on Breeze: "Who could cover Greeter?" switched between "I" and "Ozzie", said "Here is what Ozzie did
// read:" above something it couldn't do, led with a caveat about numbers, and closed by offering who on a team could
// help. On a church system that ties no team to its roles, roster questions are answered on this Mac from who is on
// each role, every suggestion leads to such an answer, and the closing line offers only what works there.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => new Promise(() => {})) }));
import { suggestedQuestions } from "../../../core/src/ask.js";
import { buildSystemBrief } from "../../../core/src/church-systems/brief.js";
import { systemHarnessCapture } from "../../../core/src/church-systems/harness.js";
import { SYSTEMS, type SystemCapture } from "../../../core/src/church-systems/types.js";
import { bundledSkills } from "../../../core/src/harness/bundled-skills.js";
import { CANT_TELL, canDoWith, rosterQuestion } from "../../../core/src/harness/compose.js";
import { rosterSummary } from "../../../core/src/sunday-brief.js";
import { HarnessSession } from "../../../core/src/harness/session.js";
import type { HarnessData } from "../../../core/src/harness/tools.js";
import { b1Capture, breezeCapture, breezeUntimedCapture, NOW } from "../../../core/test/church-systems/fixtures.js";
import { agentStep, askOzzie, createAppHarness, StepNotes, type AskTurn } from "../src/harness-bridge.js";
import { CAN_DO_INSTEAD } from "../src/harness-words.js";
import { answer, calls, fakeNative, payloadOf } from "./harness-fakes.js";

const skills = await bundledSkills();
// The fixtures are a check made at NOW; the harness reads the clock, so pin it there (or a later run calls the check too old).
beforeAll(() => { vi.setSystemTime(NOW); });
afterAll(() => { vi.useRealTimers(); });
const dataFor = (capture: SystemCapture): HarnessData => {
  const built = buildSystemBrief(capture, { confirmedZone: capture.church.time_zone }, NOW);
  if (!built.ok) throw new Error(built.reason);
  return { capture: systemHarnessCapture(capture, false), brief: built.brief, operations: null, decisions: [], rules: { sundayLeads: [], checkInAfterSundaysInARow: 3 },
    attention: null, granted: ["services"], mode: "live", connected: false, source: SYSTEMS[capture.system].name };
};
/** Asks on this Mac's harness for `data`; the AI (native agent_step) answers as `reply` says, and every call is kept. */
async function ask(question: string, data = dataFor(breezeUntimedCapture()), reply: (step: number, request: Record<string, unknown>) => unknown = () => new Promise(() => {})) {
  let step = 0;
  const fake = fakeNative((command, args) => command === "agent_step" ? reply(++step, args["request"] as Record<string, unknown>) : {});
  const notes = new StepNotes();
  const h = createAppHarness({ workspace_id: "this-mac", data, skills, session: new HarnessSession(), loop: "pi", step: agentStep(fake.invoke, notes) });
  const turn = await askOzzie(h, question, { skills, notes, sender: "Pat" });
  return { turn, asked: fake.log.filter(([c]) => c === "agent_step").length };
}
const answered = (turn: AskTurn) => { if (turn.state !== "answered") throw new Error(JSON.stringify(turn)); return turn.answer; };
const FIRST_PERSON = /(?<![\p{L}])(?:I|I'm|I've|I'll|me|my)(?![\p{L}'])/u;

describe("Ask on Breeze, answered from who is on each role (round 5)", () => {
  it("Who could cover Greeter? leads with the plain answer, then who is on Greeter, then only what works with Breeze", async () => {
    const { turn, asked } = await ask("Who could cover Greeter?");
    const a = answered(turn);
    expect(asked).toBe(0);
    expect(a.body.split("\n\n")).toEqual([
      "Breeze doesn't tie a team to each role, so Ozzie can't suggest who could help with Greeter.",
      "On Greeter now: Wren Fictional hasn't answered yet.",
      canDoWith("Breeze"),
    ]);
    expect(a.body).not.toMatch(/who on a team could help/u);
    // How many people a role needs isn't about this question: no caveat beside it.
    expect(a.gaps).toEqual([]);
    expect(a.body).not.toMatch(FIRST_PERSON);
    expect(a.basedOn).toMatch(/^Based on: Breeze/u);
  });

  it("Who is scheduled this Sunday? lists every role and its answers, adding up, with the limit after", async () => {
    const a = answered((await ask("Who is scheduled this Sunday?")).turn);
    expect(a.body.split("\n\n")).toEqual([
      "4 people are listed: 2 said yes, 1 hasn't answered, 1 said no.",
      "Greeter: Wren Fictional hasn't answered yet.\nUsher: Sam Fictional said yes; Lee Fictional said no.\nSound: Ivy Fictional said yes.",
      "On the service with no role: Kit Fictional.",
      "Breeze doesn't share how many people each role needs, so Ozzie can't say whether a role is full.",
    ]);
  });

  it("Who hasn't answered yet? names each one and their role, and that Breeze doesn't say a request was sent", async () => {
    const a = answered((await ask("Who hasn't answered yet?")).turn);
    expect(a.body.split("\n\n").slice(0, 2)).toEqual(["Wren Fictional hasn't answered for Greeter.", "Breeze doesn't say whether the request was sent."]);
  });

  it("a note to the person who hasn't answered is written here, and never claims a request was sent", async () => {
    const { turn, asked } = await ask("Draft a note to the person who hasn't answered for Greeter");
    const a = answered(turn);
    expect(asked).toBe(0);
    expect(a.draft).toBe("Hi Wren,\n\nBreeze has you down to serve as Greeter on Sunday, November 22, with no answer yet. Could you let me know either way when you get a chance? It's completely fine to say no.\n\nThank you,\nPat");
    expect(a.body).toContain("Nothing has been sent.");
    // By first name too, as people type it.
    expect(answered((await ask("Write a note to Wren about Greeter")).turn).draft).toMatch(/^Hi Wren,/u);
  });

  it("every suggestion on Breeze is one of these, and none leads to who could help", async () => {
    const data = dataFor(breezeUntimedCapture());
    const suggested = suggestedQuestions(data.brief);
    expect(suggested).toEqual(["Who is scheduled this Sunday?", "Who hasn't answered yet?", "Why is Greeter flagged?", "Draft a note to the person who hasn't answered for Greeter"]);
    for (const q of suggested.filter(q => !q.startsWith("Why"))) {
      const { turn, asked } = await ask(q, data);
      const a = answered(turn);
      expect(asked, q).toBe(0);
      expect(a.body, q).not.toMatch(/who on a team could help|can't tell/u);
    }
    // B1 Church keeps its own suggestions, who could cover among them.
    expect(suggestedQuestions(dataFor(b1Capture()).brief).some(q => /^Who could cover /u.test(q))).toBe(true);
  });

  it("an answer the AI couldn't back up is said in Ozzie's voice, and offers only what works with the system", async () => {
    const notCovered = (n: number, request: Record<string, unknown>) => n === 1 ? calls(["sunday.overview"])
      : answer(JSON.stringify({ answer: "not-covered", facts: [payloadOf(request as never, "sunday.overview")!["fact"]] }));
    const breeze = answered((await ask("Is the sound desk booked?", dataFor(breezeUntimedCapture()), notCovered)).turn);
    expect(breeze.body.split("\n\n")[0]).toBe(CANT_TELL);
    expect(breeze.body).not.toMatch(FIRST_PERSON);
    expect(breeze.body).not.toContain("Here is what Ozzie did read");
    expect(breeze.body.split("\n\n").at(-1)).toBe(canDoWith("Breeze"));
    const b1 = answered((await ask("Is the sound desk booked?", dataFor(b1Capture()), notCovered)).turn);
    expect(b1.body.split("\n\n")[0]).toBe("Ozzie can't tell from what it read.");
    expect(b1.body.split("\n\n").at(-1)).toBe(CAN_DO_INSTEAD);
  });

  it("a question about coverage is never answered \"nothing needs a decision\": what is known, and what needs a look", async () => {
    for (const q of ["What still needs a decision this Sunday?", "Is Sunday covered?"]) {
      const { turn, asked } = await ask(q);
      const a = answered(turn);
      expect(asked, q).toBe(0);
      expect(a.body.split("\n\n"), q).toEqual([
        "Ozzie can't say whether anything needs a decision this Sunday: Breeze doesn't share how many people each role needs.",
        "4 people are listed: 2 said yes, 1 hasn't answered, 1 said no.",
        "Greeter: Wren Fictional hasn't answered yet.",
      ]);
      expect(a.body, q).not.toMatch(/Nothing (?:in this check )?needs a decision/u);
    }
  });
});

describe("review of round 5", () => {
  const data = () => dataFor(breezeUntimedCapture());
  it("H1: an AI answer saying nothing needs a decision on Breeze always carries the caveat; a role's coverage is answered here", async () => {
    const nothing = (n: number, request: Record<string, unknown>) => n === 1 ? calls(["sunday.overview"])
      : answer(JSON.stringify({ answer: "nothing-needs-a-decision", facts: [payloadOf(request as never, "sunday.overview")!["fact"]] }));
    const a = answered((await ask("Anything about Sound I should see?", data(), nothing)).turn);
    expect(a.gaps).toContain("Breeze doesn't share how many people each role needs, so Ozzie can't say whether a role is full.");
    for (const q of ["Is Greeter covered?", "Do we have enough ushers?", "Are all the roles filled?"]) {
      const { turn, asked } = await ask(q);
      expect(asked, q).toBe(0);
      expect(answered(turn).body, q).not.toMatch(/Nothing (?:in this check )?needs a decision/u);
    }
    expect(answered((await ask("Is Greeter covered?")).turn).body.split("\n\n")[0]).toBe("Ozzie can't say whether Greeter is full: Breeze doesn't share how many people it needs.");
  });

  it("M1: Breeze roles that do have a number are said with it, never as if none had one", async () => {
    const numbered = dataFor(breezeCapture({ assignments: [{ id: "71001", position_id: "9627", person_id: "157801", status: "unconfirmed", asked: null }] }));
    const scheduled = answered((await ask("Who is scheduled?", numbered)).turn).body;
    expect(scheduled).not.toContain("doesn't share how many people");
    const who = answered((await ask("Who could cover Teacher?", numbered)).turn).body;
    expect(who).toContain("Teacher still needs 1 more person, by Breeze's numbers.");
  });

  it("M4, L1, L3: only a note to someone who hasn't answered is one; a role inside a longer name; who said no", () => {
    expect(rosterQuestion("Draft a reminder for everyone", data())).toBeNull();
    expect(rosterQuestion("Draft a reminder for the greeters about parking", data())).toBeNull();
    const lead = breezeUntimedCapture({ labels: { ...breezeUntimedCapture().labels, "position:R3": "Lead Greeter" } });
    expect(rosterQuestion("Draft a note to the person who hasn't answered for Lead Greeter", dataFor(lead))).toEqual({ kind: "note", roles: ["Lead Greeter"] });
    expect(rosterQuestion("Who said no?", data())).toEqual({ kind: "declined", roles: [] });
    expect(rosterQuestion("Who hasn't confirmed?", data())?.kind).toBe("not-answered");
  });

  it("release review L1, L2: a role named on its own beside a longer one counts; the full service isn't a coverage question", () => {
    const lead = dataFor(breezeUntimedCapture({ labels: { ...breezeUntimedCapture().labels, "position:R3": "Lead Greeter" } }));
    expect(rosterQuestion("Who could cover Lead Greeter?", lead)).toEqual({ kind: "who-could-help", roles: ["Lead Greeter"] });
    expect(rosterQuestion("Who could cover Greeter and Lead Greeter?", lead)?.roles.sort()).toEqual(["Greeter", "Lead Greeter"]);
    expect(rosterQuestion("Who is scheduled for the full service?", data())).toEqual({ kind: "scheduled", roles: [] });
    expect(rosterQuestion("Is Greeter full?", data())?.kind).toBe("decision");
  });

  it("L3: who said no is answered from the roster", async () => {
    expect(answered((await ask("Who said no?")).turn).body.split("\n\n")[0]).toBe("Lee Fictional said no for Usher.");
  });

  it("M5: someone on two roles is counted in each, so an unanswered place is never hidden", () => {
    const two = breezeUntimedCapture({ assignments: [...breezeUntimedCapture().assignments, { id: "V5", position_id: "R1", person_id: "P-sam", status: "unconfirmed", asked: null }] });
    const b = dataFor(two).brief!;
    expect(rosterSummary(b.roster!)).toBe("4 people are listed in 5 places on roles: 2 said yes, 2 haven't answered, 1 said no.");
  });

  it("L2: one person waiting on two roles is one person, asked about one role at a time", async () => {
    const two = breezeUntimedCapture({ assignments: [...breezeUntimedCapture().assignments, { id: "V5", position_id: "R3", person_id: "P-wren", status: "unconfirmed", asked: null }] });
    const a = answered((await ask("Write a note to Wren", dataFor(two))).turn);
    expect(a.draft).toBeNull();
    expect(a.body).toContain("Wren Fictional hasn't answered for Greeter and Sound. Ask for a note about one role at a time.");
  });
});
