// A write-up kept on this Mac (responsibility-runner.ts): people as their Planning Center id in a fixed token, never
// their name, and filled in from the check on screen only when shown. Fictional data and a scripted model.
import { describe, expect, it } from "vitest";
import type { AgentStepReply, ModelStep } from "../../src/harness/contract.js";
import { bundledSkills } from "../../src/harness/bundled-skills.js";
import { composeAnswer } from "../../src/harness/compose.js";
import { Harness } from "../../src/harness/index.js";
import { fillPeople, keptNames, PERSON_TOKEN } from "../../src/harness/session.js";
import { TsLoop } from "../../src/harness/ts-loop.js";
import { FRESH, harnessData } from "./fixtures.js";

const skills = await bundledSkills();
const call = (name: string, args: Record<string, unknown> = {}): AgentStepReply => ({ content: "", tool_calls: [{ id: "c", name, arguments: JSON.stringify(args) }], finish: "tool_calls" });
const answer = (o: unknown): AgentStepReply => ({ content: JSON.stringify(o), tool_calls: [], finish: "stop" });

describe("a write-up in the form kept on this Mac", () => {
  it("holds each person as an id token and no name, and fills back to exactly what restore shows", async () => {
    const data = harnessData();
    let n = 0;
    const model: ModelStep = async request => {
      if (n++ === 0) return call("sunday.who_could_help", { role: /\[Role \d+\]/u.exec(request.messages[1]!.content)![0] });
      const people = (JSON.parse(request.messages.at(-1)!.content) as { payload: { people: { fact: string }[] } }).payload.people;
      return answer({ answer: "facts", facts: people.map(p => p.fact) });
    };
    const h = new Harness({ workspace_id: "fictional", data, skills, runtime: new TsLoop(), model, now: () => FRESH, newId: () => "00000000-0000-4000-8000-0000000000ab" });
    const res = await h.ask("Who could cover Greeter?");
    if (!res.ok) throw new Error(res.refusal);
    const { paragraphs } = composeAnswer(res.outcome.answer!, res.outcome.evidence);
    const kept = paragraphs.map(p => h.keep(p));
    const names = data.capture!.names;
    const joined = kept.join("\n");
    for (const name of Object.values(names)) for (const part of name.split(/\s+/u)) expect(joined).not.toContain(part);
    expect(joined).toMatch(PERSON_TOKEN);
    expect(joined).not.toMatch(/\[(?:Person|Role) \d+\]/u);
    // The role and its time are Ozzie's own words; only people wait for the check on screen.
    expect(kept[0]).toBe("{{person:" + Object.keys(names).find(id => names[id] === "Riley Thornbury") + "}} has no overlap found for Greeter.");
    expect(kept.map(p => fillPeople(p, names))).toEqual(paragraphs.map(p => h.restore(p)));
  });

  it("a person the check on screen doesn't hold is shown as a team member, never as their id", () => {
    expect(fillPeople("{{person:401}} has no overlap found for Greeter.", { 401: "Avery Brightwater" })).toBe("Avery Brightwater has no overlap found for Greeter.");
    expect(fillPeople("{{person:999}} has no overlap found for Greeter.", { 401: "Avery Brightwater" })).toBe("a team member has no overlap found for Greeter.");
    expect(fillPeople("{{person:constructor}} is pending.", {})).toBe("a team member is pending.");
    expect(keptNames({ 401: "Avery Brightwater", "bad id": "X" })).toEqual({ 401: "{{person:401}}" });
  });
});
