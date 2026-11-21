// Ask with more than one service watched, each with a role of the same name (rehearsal of 0.5.2): every line names the
// role's service, a role at no time Ozzie could read says so, and each service's lines sit together. With one service
// the answer reads exactly as before. The service names are put in on this Mac only; the AI sees the same labels it
// always did. Fixed fictional data, clock pinned to the fictional check.
import { describe, expect, it } from "vitest";
import { mergedNames, mergeParts, teamServices } from "../src/services-merge.js";
import { buildSundayBrief, type SundayBrief } from "../../../core/src/sunday-brief.js";
import { nov22Capture } from "../../../core/src/fictional-sunday.js";
import { wednesdayCapture } from "../../../core/test/fixtures/service-days/wednesday.js";
import { bundledSkills } from "../../../core/src/harness/bundled-skills.js";
import { composeAnswer } from "../../../core/src/harness/compose.js";
import type { AgentStepReply, AgentStepRequest, ModelStep } from "../../../core/src/harness/contract.js";
import { Harness } from "../../../core/src/harness/index.js";
import type { HarnessData } from "../../../core/src/harness/tools.js";
import { TsLoop } from "../../../core/src/harness/ts-loop.js";

const skills = await bundledSkills();
const rules = { sundayLeads: [], checkInAfterSundaysInARow: 3 };
const sunday = nov22Capture();
const NOW = sunday.completed_at;
const WEEKEND = "Weekend Service", YOUTH = "Ozzie Demo Youth Night (fictional)";

/**
 * A second service with only a Greeter that still needs 2, at no time Planning Center ties to it and with no one on its
 * team (the rehearsal's "Ozzie Demo Youth Night (fictional)"): its own plan and teams, as Planning Center keeps them.
 */
function youthNight(): { capture: ReturnType<typeof wednesdayCapture>; brief: SundayBrief } {
  const capture = { ...wednesdayCapture(), service_type_id: "1700", plan_id: "94000001" };
  const built = buildSundayBrief(capture, rules, capture.completed_at);
  const team = (id: string) => `y${id}`;
  const greeter = built.findings.find(f => f.kind === "needs-people" && f.position?.name === "Greeter")!;
  const position = { ...greeter.position!, team_id: team(greeter.position!.team_id), interval: null };
  const brief: SundayBrief = {
    ...built,
    findings: [{ ...greeter, position, remaining: 2, people: { suggestions: [], conflicts: [], unverified: [], left_out: [] }, confirmed: [] }],
    positions: built.positions.filter(p => p.name === "Greeter").map(p => ({ ...p, team_id: team(p.team_id), interval: null })),
  };
  return { capture, brief };
}

/** What Ask reads: the first service's check with the other joined in (App mergedHarness), or the first alone. */
function data(several: boolean): HarnessData {
  const main = buildSundayBrief(sunday, rules, NOW);
  if (!several) return { capture: sunday, brief: main, operations: null, decisions: [], rules, attention: null, granted: ["services"], mode: "live", connected: true };
  const other = youthNight();
  const m = mergeParts({ brief: main, decisions: [] }, [{ plan_id: other.capture.plan_id, brief: other.brief, decisions: [] }]);
  const serviceOfTeam = teamServices({ brief: main, name: WEEKEND }, [{ brief: other.brief, name: YOUTH }])!;
  return { capture: mergedNames(sunday, [other.capture]), brief: m.brief, operations: null, decisions: m.decisions, rules, attention: null,
    granted: ["services"], mode: "live", connected: true, serviceOfTeam };
}

const call = (name: string, args: Record<string, unknown> = {}): AgentStepReply => ({ content: "", tool_calls: [{ id: "c", name, arguments: JSON.stringify(args) }], finish: "tool_calls" });
const reply = (o: unknown): AgentStepReply => ({ content: JSON.stringify(o), tool_calls: [], finish: "stop" });
const results = (r: AgentStepRequest) => r.messages.flatMap(m => m.role === "tool" ? [JSON.parse(m.content) as { tool: string; payload: Record<string, unknown> }] : []);
const roleIn = (r: AgentStepRequest) => /\[Role \d+\]/u.exec(r.messages[1]!.content)![0];
/** Every fact a result holds: its own, then each row's, in the order the tool gave them. */
const everyFact = (p: Record<string, unknown>) => [p["fact"] as string, ...["times", "people", "findings", "needs"].flatMap(k => Array.isArray(p[k]) ? (p[k] as { fact: string }[]).map(x => x.fact) : [])];

/** One question through the real harness with a scripted model that chooses every fact; the answer as shown and as sent. */
async function ask(d: HarnessData, question: string, tool: string, withRole: boolean) {
  const turns: ((r: AgentStepRequest) => AgentStepReply)[] = [
    r => call(tool, withRole ? { role: roleIn(r) } : {}),
    r => reply({ answer: "facts", facts: everyFact(results(r)[0]!.payload).slice(0, 24) }),
  ];
  const sent: AgentStepRequest[] = [];
  let n = 0;
  const model: ModelStep = async request => { sent.push(request); return turns[n++]!(request); };
  const h = new Harness({ workspace_id: "fictional", data: d, skills, runtime: new TsLoop(), model, now: () => NOW, newId: () => "00000000-0000-4000-8000-0000000000ab" });
  const res = await h.ask(question);
  if (!res.ok) throw new Error(res.refusal);
  expect(res.outcome.status, res.outcome.code ?? "").toBe("verified");
  const c = composeAnswer(res.outcome.answer!, res.outcome.evidence, d.brief!.day ?? null);
  return { shown: c.paragraphs.map(p => h.restore(p)), sent: JSON.stringify(sent) };
}

describe("Ask with more than one service watched names each role's service (rehearsal of 0.5.2)", () => {
  it("Who could cover Greeter? Each service's Greeter with its own count, time and people, one service after the other", async () => {
    const { shown } = await ask(data(true), "Who could cover Greeter?", "sunday.who_could_help", true);
    expect(shown).toEqual([
      `On the team for Greeter (${WEEKEND}), the check listed 5 people.`,
      `Greeter (${WEEKEND}) at 9:30 AM on November 22 still needs 1 more person, by Planning Center's count.`,
      `Riley Thornbury has no overlap found for Greeter (${WEEKEND}).`,
      `Casey Pemberly has a possible conflict for Greeter (${WEEKEND}): pending elsewhere at this time.`,
      `Drew Halvorsen's availability for Greeter (${WEEKEND}) needs confirmation: a blockout couldn't be checked.`,
      `Sam Whitcombe was left out for Greeter (${WEEKEND}): a blockout covers this time.`,
      `Morgan Ellingsworth was left out for Greeter (${WEEKEND}): confirmed elsewhere at this time.`,
      `On the team for Greeter (${YOUTH}), the check listed 0 people.`,
      `Greeter (${YOUTH}) still needs 2 more people, by Planning Center's count. Ozzie can't tie this role to one service time.`,
      "That doesn't mean they're free or willing; only they can say.",
      "People are listed in no particular order, not ranked.",
    ]);
  });

  it("What still needs a decision? Each open role names its service; the one at no readable time says so", async () => {
    const { shown } = await ask(data(true), "What still needs a decision?", "sunday.overview", false);
    expect(shown).toContain(`Greeter (${WEEKEND}) at 9:30 AM on November 22 still needs 1 more person, by Planning Center's count.`);
    expect(shown).toContain(`Greeter (${YOUTH}) still needs 2 more people, by Planning Center's count. Ozzie can't tie this role to one service time.`);
    expect(shown).toContain(`Nursery (${WEEKEND}) at 9:30 AM on November 22 still needs 1 more person, by Planning Center's count.`);
    // Every line that names a role names its service.
    for (const line of shown) if (/\b(?:Greeter|Nursery|Lyrics)\b/u.test(line)) expect(line).toMatch(new RegExp(`\\((?:${WEEKEND}|${YOUTH.replace(/[()]/gu, "\\$&")})\\)`, "u"));
  });

  it("a note drafted for one service's Greeter names that service, even when the AI asked by the label for every Greeter", async () => {
    const d = data(true);
    const turns: ((r: AgentStepRequest) => AgentStepReply)[] = [
      r => call("sunday.who_could_help", { role: roleIn(r) }),
      r => { const x = (results(r)[0]!.payload["people"] as { person: string; status: string }[]).find(y => y.status === "no overlap found")!; return call("drafts.prepare_note", { person: x.person, role: roleIn(r) }); },
      r => reply({ answer: "draft", draft: results(r)[1]!.payload["draft_id"], facts: [] }),
    ];
    let n = 0;
    const h = new Harness({ workspace_id: "fictional", data: d, skills, runtime: new TsLoop(), model: async r => turns[n++]!(r), now: () => NOW, newId: () => "00000000-0000-4000-8000-0000000000ac" });
    const res = await h.ask("Draft a note to someone who could cover Greeter");
    if (!res.ok) throw new Error(res.refusal);
    const c = composeAnswer(res.outcome.answer!, res.outcome.evidence, d.brief!.day ?? null);
    expect(h.restore(c.draft!, { sender: "Pat", firstNames: true })).toBe(`Hi Riley,\n\nWe still need someone for Greeter (${WEEKEND}) at 9:30 AM on November 22. Would you be able to help?\n\n` +
      "It's completely fine to say no. Just let me know either way so we can plan.\n\nThank you,\nPat");
  });

  it("never sends the AI a service's name or a person's: each team's label is a label like any other", async () => {
    const { sent } = await ask(data(true), "Who could cover Greeter?", "sunday.who_could_help", true);
    for (const name of [WEEKEND, YOUTH, "Youth Night", "Weekend"]) expect(sent).not.toContain(name);
    expect(sent).not.toMatch(/Riley|Thornbury|Greeter \(/u);
  });
});

describe("several services: the AI's other lookups beside who could help", () => {
  it("a team's time and count said in the open roles' fuller words keeps its place among that team's lines", async () => {
    const d = data(true);
    const turns: ((r: AgentStepRequest) => AgentStepReply)[] = [
      () => call("sunday.open_needs"),
      r => call("sunday.who_could_help", { role: roleIn(r) }),
      r => { const [needs, help] = results(r); return reply({ answer: "facts", facts: [...everyFact(needs!.payload).slice(1), ...everyFact(help!.payload)].slice(0, 24) }); },
    ];
    let n = 0;
    const h = new Harness({ workspace_id: "fictional", data: d, skills, runtime: new TsLoop(), model: async r => turns[n++]!(r), now: () => NOW, newId: () => "00000000-0000-4000-8000-0000000000ad" });
    const res = await h.ask("Who could cover Greeter?");
    if (!res.ok) throw new Error(res.refusal);
    const shown = composeAnswer(res.outcome.answer!, res.outcome.evidence, d.brief!.day ?? null).paragraphs.map(p => h.restore(p));
    const weekend = shown.indexOf(`On the team for Greeter (${WEEKEND}), the check listed 5 people.`), youth = shown.indexOf(`On the team for Greeter (${YOUTH}), the check listed 0 people.`);
    expect(weekend).toBeGreaterThanOrEqual(0);
    expect(youth).toBeGreaterThan(weekend);
    // Each team's time and count, in the open roles' words, right under its own count; said once.
    expect(shown[weekend + 1]).toMatch(new RegExp(`^Greeter \\(${WEEKEND}\\) at 9:30 AM on November 22 still needs 1 more person, by Planning Center's count\\. Already confirmed`, "u"));
    expect(shown[youth + 1]).toMatch(/^Greeter \(Ozzie Demo Youth Night \(fictional\)\) still needs 2 more people, by Planning Center's count\. Ozzie can't tie this role to one service time\./u);
    expect(shown.filter(p => p.startsWith(`Greeter (${WEEKEND}) at 9:30 AM`))).toHaveLength(1);
    expect(shown.filter(p => p.startsWith(`Greeter (${YOUTH})`))).toHaveLength(1);
  });

  it("two teams of one service with the same role: one label for every Greeter, everyone listed once, as before", async () => {
    const d = data(true);
    const brief = d.brief!, greeter = brief.findings.find(f => f.kind === "needs-people" && f.position?.name === "Greeter")!;
    const second = { ...greeter, id: "need:second", key: "second-greeter", position: { ...greeter.position!, id: "position:second", team_id: "x7593350" } };
    const both: HarnessData = { ...d, brief: { ...brief, findings: [...brief.findings, second], positions: [...brief.positions, { ...brief.positions.find(p => p.name === "Greeter")!, team_id: "x7593350" }] },
      serviceOfTeam: { ...d.serviceOfTeam!, x7593350: WEEKEND } };
    const { shown } = await ask(both, "Who could cover Greeter?", "sunday.who_could_help", true);
    // Restored with no one service, since the label stands for both services' Greeter: never two "Greeter (Weekend Service)" headings.
    expect(shown[0]).toBe("On the team for Greeter, the check listed 5 people.");
    expect(shown.filter(p => p.startsWith("Riley Thornbury"))).toHaveLength(1);
  });
});

describe("with one service watched, the answer reads exactly as before", () => {
  it("Who could cover Greeter?", async () => {
    const { shown } = await ask(data(false), "Who could cover Greeter?", "sunday.who_could_help", true);
    expect(shown).toEqual([
      "On the team for Greeter, the check listed 5 people.",
      "Greeter at 9:30 AM on November 22 still needs 1 more person, by Planning Center's count.",
      "Riley Thornbury has no overlap found for Greeter.",
      "Casey Pemberly has a possible conflict for Greeter: pending elsewhere at this time.",
      "Drew Halvorsen's availability for Greeter needs confirmation: a blockout couldn't be checked.",
      "Sam Whitcombe was left out for Greeter: a blockout covers this time.",
      "Morgan Ellingsworth was left out for Greeter: confirmed elsewhere at this time.",
      "That doesn't mean they're free or willing; only they can say.",
      "People are listed in no particular order, not ranked.",
    ]);
  });
});
