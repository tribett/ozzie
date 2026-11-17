// Structured answers (review 2026-11-14 section C): the model only chooses fact ids, and Ozzie writes the answer on
// this Mac from fixed sentences, in its own order, with drafts only ever the drafting tool's text. Fictional data.
import { describe, expect, it } from "vitest";
import type { AgentStepReply, AgentStepRequest, ModelStep, ToolEnvelope } from "../../src/harness/contract.js";
import { bundledSkills } from "../../src/harness/bundled-skills.js";
import {
  ALSO_ON_SUNDAY, BACKGROUND_OFF, BACKGROUND_ON_FILE, BACKGROUND_UNCONFIRMED, composeAnswer, DECISION_QUESTION, decisionsLeftOut, DRAFT_INTRO, isDecisionQuestion, KEPT_HERE,
  kidsAnswer, kidsQuestion, kidsWording, MEMBERS_UNREAD, NO_KIDS_TEAM, NOBODY_SCHEDULED, NOTHING_OPEN, ON_SUNDAY, openDecisions, setAside, NOT_COVERED_MORE, NOT_FREE, NOT_RANKED, NOTHING_TO_DECIDE,
} from "../../src/harness/compose.js";
import { envelopeProblems } from "../../src/harness/fixed.js";
import { Harness } from "../../src/harness/index.js";
import { HarnessSession, restoreLabels, showTimes } from "../../src/harness/session.js";
import { HarnessTools, type HarnessData } from "../../src/harness/tools.js";
import { TsLoop } from "../../src/harness/ts-loop.js";
import { NOT_COVERED } from "../../src/ask.js";
import { CHECKED, nov22Capture, TEAMS, withFictionalBackgroundChecks } from "../../src/fictional-sunday.js";
import type { SundayCapture } from "../../src/sunday-capture.js";
import type { Finding } from "../../src/sunday-brief.js";
import type { CorrectionEntry } from "../../src/finding-feedback.js";
import { decide } from "../../src/sunday-decisions.js";
import { allEnvelopes, FIXTURES, FRESH, harnessData, KIDS_RULES, LEAD_RULES, RULES } from "./fixtures.js";

const skills = await bundledSkills();
const signal = new AbortController().signal;
type Turn = (r: AgentStepRequest) => AgentStepReply;
const call = (name: string, args: Record<string, unknown> = {}): AgentStepReply => ({ content: "", tool_calls: [{ id: "c", name, arguments: JSON.stringify(args) }], finish: "tool_calls" });
const answer = (o: unknown): AgentStepReply => ({ content: JSON.stringify(o), tool_calls: [], finish: "stop" });
const results = (r: AgentStepRequest) => r.messages.flatMap(m => m.role === "tool" ? [JSON.parse(m.content) as { tool: string; payload: Record<string, unknown> }] : []);
const roleIn = (r: AgentStepRequest) => /\[Role \d+\]/u.exec(r.messages[1]!.content)![0];
type Person = { fact: string; person: string; status: string; role: string };

/** One question through the real harness with a scripted model; the answer composed and restored on this Mac. */
async function ask(question: string, turns: Turn[], data = harnessData()) {
  let n = 0;
  const model: ModelStep = async request => turns[n++]!(request);
  const h = new Harness({ workspace_id: "fictional", data, skills, runtime: new TsLoop(), model, now: () => FRESH, newId: () => "00000000-0000-4000-8000-0000000000aa" });
  const res = await h.ask(question);
  if (!res.ok) throw new Error(res.refusal);
  expect(res.outcome.status, `${question}: ${res.outcome.code}`).toBe("verified");
  const c = composeAnswer(res.outcome.answer!, res.outcome.evidence);
  return { ...c, restored: c.paragraphs.map(p => h.restore(p, { sender: "Pat" })), draftShown: c.draft ? h.restore(c.draft, { sender: "Pat", firstNames: true }) : null };
}

describe("who could help, as one line about the list (review K)", () => {
  it("says how many people the check listed, never in what order, counting those left out to fit", () => {
    // The app's card shows them alphabetically and Ask in person-id order: the line names neither.
    const envelope = (people: number, cut = 0): ToolEnvelope => ({
      tool: "sunday.who_could_help", source: "Planning Center Services", check_time: FRESH, completeness: cut ? "partial" : "complete",
      payload: {
        fact: "f1", asked_for: { role: "[Role 1]" },
        people: Array.from({ length: people }, (_, i) => ({ fact: `f${i + 2}`, role: "[Role 1]", person: `[Person ${i + 1}]`, status: "no overlap found" })),
        ...(cut ? { left_out_for_length: cut } : {}),
      },
    });
    const said = (e: ToolEnvelope) => composeAnswer(JSON.stringify({ answer: "facts", facts: ["f1"] }), [e]).paragraphs;
    expect(said(envelope(5))).toEqual(["On the team for [Role 1], the check listed 5 people."]);
    expect(said(envelope(1))).toEqual(["On the team for [Role 1], the check listed 1 person."]);
    // A copy cut to fit what the AI may read: the count is the check's, not the copy's.
    expect(said(envelope(38, 7))).toEqual(["On the team for [Role 1], the check listed 45 people."]);
  });
});

describe("the four suggested questions, answered from facts the model chose", () => {
  it("Who could cover Greeter? People in label order whatever order the model chose, and what no overlap doesn't mean", async () => {
    const out = await ask("Who could cover Greeter?", [
      r => call("sunday.who_could_help", { role: roleIn(r) }),
      // The model lists the people backwards and the role's time last: neither order is shown.
      r => { const p = results(r)[0]!.payload as { times: { fact: string }[]; people: Person[] }; return answer({ answer: "facts", facts: [...p.people.map(x => x.fact).reverse(), p.times[0]!.fact] }); },
    ]);
    expect(out.restored).toEqual([
      "Greeter at 9:30 AM on November 22 still needs 1 more person, by Planning Center's count.",
      "Riley Thornbury has no overlap found for Greeter.",
      "Casey Pemberly has a possible conflict for Greeter: pending elsewhere at this time.",
      "Drew Halvorsen's availability for Greeter needs confirmation: a blockout couldn't be checked.",
      "Sam Whitcombe was left out for Greeter: a blockout covers this time.",
      "Morgan Ellingsworth was left out for Greeter: confirmed elsewhere at this time.",
      NOT_FREE, NOT_RANKED,
    ]);
    expect(out.paragraphs[1]).toBe("[Person 1] has no overlap found for [Role 1].");
  });

  it("What still needs a decision this Sunday? The findings that need one, with Planning Center's own count", async () => {
    const out = await ask("What still needs a decision this Sunday?", [
      () => call("sunday.overview"),
      r => { const p = results(r)[0]!.payload as { findings: { fact: string; tone: string }[] }; return answer({ answer: "facts", facts: p.findings.filter(f => f.tone === "needs a decision").map(f => f.fact) }); },
    ]);
    expect(out.restored).toEqual([
      "Needs a decision: Greeter at 9:30 AM on November 22 still needs 1 more person, by Planning Center's count.",
      "Needs a decision: Nursery at 9:30 AM on November 22 still needs 1 more person, by Planning Center's count.",
    ]);
  });

  it("Why is Greeter flagged? The open role as the check found it", async () => {
    const out = await ask("Why is Greeter flagged?", [
      () => call("sunday.open_needs"),
      r => { const p = results(r)[0]!.payload as { needs: { fact: string; role: string }[] }; return answer({ answer: "facts", facts: p.needs.filter(x => x.role === roleIn(r)).map(x => x.fact) }); },
    ]);
    expect(out.restored).toEqual(["Greeter at 9:30 AM on November 22 still needs 1 more person, by Planning Center's count. Already confirmed: Avery Brightwater. " +
      "On the team: 1 with no overlap found, 1 with a possible conflict, 1 whose availability needs confirmation and 2 left out. Planning Center lists no team leader."]);
  });

  it("Draft a note to someone who could cover Greeter: the drafting tool's own text, greeting by first name and signed by the sender", async () => {
    const out = await ask("Draft a note to someone who could cover Greeter", [
      r => call("sunday.who_could_help", { role: roleIn(r) }),
      r => { const x = (results(r)[0]!.payload as { people: Person[] }).people.find(y => y.status === "no overlap found")!; return call("drafts.prepare_note", { person: x.person, role: x.role }); },
      r => { const [help, draft] = results(r); return answer({ answer: "draft", draft: draft!.payload["draft_id"], facts: [(help!.payload as { people: Person[] }).people.find(y => y.status === "no overlap found")!.fact] }); },
    ]);
    expect(out.kind).toBe("draft");
    expect(out.restored).toEqual([DRAFT_INTRO, "Riley Thornbury has no overlap found for Greeter.", NOT_FREE]);
    expect(out.draftShown).toBe("Hi Riley,\n\nWe still need someone for Greeter at 9:30 AM on November 22. Would you be able to help?\n\n" +
      "It's completely fine to say no. Just let me know either way so we can plan.\n\nThank you,\nPat");
  });
});

describe("fixed framing for each kind of answer", () => {
  const help = async () => {
    const t = new HarnessTools(harnessData(), new HarnessSession(), { now: () => FRESH });
    const open = await t.run("sunday.open_needs", {}, signal, "x");
    const role = ((open.payload as { needs: { role: string }[] }).needs[0]!).role;
    return [open, await t.run("sunday.who_could_help", { role }, signal, "x"), await t.run("sunday.overview", {}, signal, "x")];
  };
  it("not covered: the fixed opening, then any facts read", async () => {
    const evidence = await help();
    expect(composeAnswer('{"answer":"not-covered"}', evidence).paragraphs).toEqual([NOT_COVERED]);
    const some = composeAnswer('{"answer":"not-covered","facts":["f1"]}', evidence);
    expect(some.paragraphs[0]).toBe(NOT_COVERED);
    expect(some.paragraphs[1]).toBe(NOT_COVERED_MORE);
    expect(some.paragraphs[2]).toMatch(/^This check found 2 roles that still need people and 0 with no scheduled lead\.$/u);
  });
  it("nothing needs a decision: the fixed sentence, then any facts", () => {
    const overview: ToolEnvelope = { tool: "sunday.overview", source: "Planning Center Services", check_time: "2026-11-20T15:00:00Z", completeness: "complete",
      payload: { fact: "f1", mode: "live", sunday: "2026-11-22", reads: 20, reads_not_completed: 0, needs_a_decision: 0, worth_a_look: 1,
        findings: [{ fact: "f2", kind: "check-in suggested", tone: "worth a look", person: "[Person 2]", sundays_in_a_row: 4 }] } };
    expect(composeAnswer('{"answer":"nothing-needs-a-decision","facts":["f2"]}', [overview]).paragraphs).toEqual([NOTHING_TO_DECIDE,
      "Worth a look: [Person 2] is scheduled 4 Sundays in a row. Your Church rules suggest a check-in, which is about care, not performance."]);
  });
  it("a draft is only the drafting tool's text (C1): a draft id with no draft, or another tool's, shows no draft", async () => {
    const evidence = await help();
    expect(composeAnswer('{"answer":"draft","draft":"d1"}', evidence)).toEqual({ kind: "not-covered", paragraphs: [NOT_COVERED], draft: null });
  });
  it("each person's sentence takes the person from the fact itself (C3), so a label can't be moved onto another person's fact", async () => {
    const evidence = await help();
    const people = (evidence[1]!.payload as { people: Person[] }).people;
    for (const p of people) {
      const [line] = composeAnswer(JSON.stringify({ answer: "facts", facts: [p.fact] }), evidence).paragraphs;
      expect(line!.startsWith(p.person), p.fact).toBe(true);
      expect(line).toContain(p.status === "left out" ? "was left out" : p.status === "no overlap found" ? "has no overlap found" : p.status === "possible conflict" ? "possible conflict" : "needs confirmation");
    }
  });
  it("numbers and times are the facts' own (C2): the remaining count and the start time, never another number in the evidence", async () => {
    const evidence = await help();
    const times = (evidence[1]!.payload as { times: { fact: string; remaining: number; time: { starts_at: string } }[] }).times[0]!;
    const [line] = composeAnswer(JSON.stringify({ answer: "facts", facts: [times.fact] }), evidence).paragraphs;
    expect(line).toBe(`${(evidence[1]!.payload as { asked_for: { role: string } }).asked_for.role} at ${times.time.starts_at} still needs ${times.remaining} more person, by Planning Center's count.`);
  });
});

describe("every fact every tool gives has a sentence", () => {
  it("over every fixture, with no fact left out and no label or time altered", async () => {
    let facts = 0;
    for (const [name, make] of [...FIXTURES, ["lead rule", () => harnessData({ rules: LEAD_RULES })] as const]) {
      const evidence = await allEnvelopes(make());
      for (const e of evidence) expect(envelopeProblems(e), `${name} ${e.tool}`).toEqual([]);
      const ids = [...new Set(evidence.flatMap(e => [...JSON.stringify(e.payload).matchAll(/"fact":"(f\d+)"/gu)].map(m => m[1]!)))];
      for (const id of ids) {
        const composed = composeAnswer(JSON.stringify({ answer: "facts", facts: [id] }), evidence);
        expect(composed.kind, `${name} ${id}`).toBe("facts");
        // Every label and ISO time in a sentence is one the evidence holds.
        const text = composed.paragraphs.join(" ");
        for (const label of text.match(/\[[^\]]*\]/gu) ?? []) expect(JSON.stringify(evidence), `${name} ${id} ${label}`).toContain(label);
        for (const time of text.match(/\d{4}-\d{2}-\d{2}(?:T[\d:+-]+)?/gu) ?? []) expect(JSON.stringify(evidence), `${name} ${id} ${time}`).toContain(time);
        facts++;
      }
    }
    expect(facts).toBeGreaterThan(200);
  });
});

describe("a sentence two tools both give is said once", () => {
  it("drops a need repeated at the start of a fuller sentence, and an exact repeat", () => {
    const evidence = [
      { tool: "sunday.open_needs", payload: { needs: [{ fact: "f1", kind: "needs people", role: "[Role 1]", time: { starts_at: "[Time 1]" }, remaining: 1, confirmed: ["[Person 1]"] }] } },
      { tool: "sunday.who_could_help", payload: { times: [{ fact: "f2", role: "[Role 1]", time: { starts_at: "[Time 1]" }, remaining: 1 }, { fact: "f3", role: "[Role 1]", time: { starts_at: "[Time 1]" }, remaining: 1 }] } },
    ] as unknown as ToolEnvelope[];
    const c = composeAnswer('{"answer":"facts","facts":["f1","f2","f3"]}', evidence);
    expect(c.paragraphs).toEqual(["[Role 1] at [Time 1] still needs 1 more person, by Planning Center's count. Already confirmed: [Person 1]."]);
  });
});


// ---- Release-app rehearsal, Nov 15: kids teams, open decisions and room wording -----------------------------------

/** The kids rules on the test organization's shape: the nursery's one position is "Nursery volunteer", as in the release app. */
const nurseryVolunteer = (): SundayCapture =>
  JSON.parse(JSON.stringify(withFictionalBackgroundChecks(nov22Capture())).split("\"Nursery\"").join("\"Nursery volunteer\"")) as SundayCapture;
const kidsData = (rules = KIDS_RULES) => harnessData({ mode: "live", rules, capture: nurseryVolunteer() });
/** Every background check read and current, none expiring: the only check that may say "no one … without one". */
function allCleared(): SundayCapture {
  const c = withFictionalBackgroundChecks(nov22Capture());
  c.reads = c.reads.map(r => r.collection === "people_background_checks" ? { ...r, body: { data: [{ type: "BackgroundCheck", id: `9${r.people_person_id}`,
    attributes: { status: "complete_clear", current: true, expires_on: null }, relationships: { person: { data: { type: "Person", id: r.people_person_id } } } }] } } : r);
  return c;
}
/** The brief with these findings set aside by Church rules ("This isn't right"), as buildSundayBrief moves them. */
function setAsideIn(data: HarnessData, pick: (f: Finding) => boolean): HarnessData {
  const brief = data.brief!;
  return { ...data, brief: { ...brief, findings: brief.findings.filter(f => !pick(f)),
    hidden: brief.findings.filter(pick).map(finding => ({ finding, entry: { type: "correction" } as unknown as CorrectionEntry })) } };
}
/** One answer written on this Mac, restored as the panel shows it. */
async function local(typed: string, data = kidsData()) {
  const tools = new HarnessTools(data, new HarnessSession(), { now: () => FRESH });
  const q = kidsQuestion(typed, data);
  if (!q) return null;
  const out = await kidsAnswer(tools, q, signal);
  const restore = (t: string) => restoreLabels(t, tools.session, { names: data.capture!.names, organization: data.capture!.organization, timeZone: data.brief!.time_zone });
  return { ...out, restored: out.paragraphs.map(t => out.fill(restore(t))), tools };
}

describe("why “Is the nursery ready for Sunday?” wasn't answered in the release app", () => {
  it("reached the model with no label for the nursery and without the background check, so no fact it could choose answered it", async () => {
    const requests: AgentStepRequest[] = [];
    const model: ModelStep = async r => {
      requests.push(structuredClone(r));
      return requests.length === 1 ? call("sunday.overview") : { content: "I can't tell which of these roles is the nursery.", tool_calls: [], finish: "stop" };
    };
    const h = new Harness({ workspace_id: "w", data: kidsData(), skills, runtime: new TsLoop(), model, now: () => FRESH });
    const res = await h.ask("Is the nursery ready for Sunday?");
    if (!res.ok) throw new Error(res.refusal);
    // The position is "Nursery volunteer", so "nursery" alone is no position name and gets no [Role N] label.
    expect(res.task.question).toBe("Is the nursery ready for Sunday?");
    const seen = JSON.stringify(requests.map(r => r.messages));
    expect(seen).toContain("[Role 2]");
    expect(seen).not.toMatch(/background/iu);
    expect(seen).toContain("some findings are shown only in Ozzie on this Mac");
    // Any reply outside the closed answer form is "fidelity": "Ozzie couldn't back that answer up with what it read".
    expect(res.outcome).toMatchObject({ status: "failed", code: "fidelity" });
  });
});

describe("kids teams and background checks, answered on this Mac without the AI", () => {
  it("recognises questions about a kids team, kids in general or background checks, and leaves the rest and drafts to Ask", () => {
    const data = kidsData();
    const teams = (typed: string) => kidsQuestion(typed, data)?.teams ?? null;
    expect(teams("Is the nursery ready for Sunday?")).toEqual([TEAMS.nursery]);
    expect(teams("How are the Nursery volunteers looking?")).toEqual([TEAMS.nursery]);
    expect(teams("Are the kids teams covered?")).toEqual([TEAMS.nursery, TEAMS.lyrics]);
    expect(teams("Any background check problems?")).toEqual([TEAMS.nursery, TEAMS.lyrics]);
    expect(kidsQuestion("Does everyone in the nursery have a background-check?", data)).toMatchObject({ teams: [TEAMS.nursery], background: true });
    expect(kidsQuestion("Who could cover the nursery?", data)).toMatchObject({ teams: [TEAMS.nursery], who: true });
    for (const typed of ["Who could cover Greeter?", "What still needs a decision this Sunday?", "Is the room double booked?", "Draft a note to someone who could cover the nursery",
      "Who could cover Greeter or the nursery?"]) expect(kidsQuestion(typed, data), typed).toBeNull();
    // Without kids rules a kids word still answers here, for the teams it names; any other question goes to Ask.
    expect(kidsQuestion("Is the nursery ready?", kidsData(RULES))).toMatchObject({ teams: [TEAMS.nursery], marked: false });
    expect(kidsQuestion("Is Greeter ready?", kidsData(RULES))).toBeNull();
  });

  it("Is the nursery ready for Sunday? Every Nursery item the Sunday page shows, the background check from local data, kept on this Mac", async () => {
    const out = (await local("Is the nursery ready for Sunday?"))!;
    expect(out.restored).toEqual([
      "Needs a decision: Nursery volunteer at 9:30 AM on November 22 still needs 1 more person, by Planning Center's count. Already confirmed: Blake Ashgrove. " +
        "Team leaders in Planning Center: Jordan Ashdown (oversight of the team, not a Sunday assignment).",
      "Needs a decision: Nursery volunteer at 9:30 AM on November 22 has 1 confirmed person, and your Church rules ask for at least 2. Pending isn't counted, and Ozzie doesn't check ages.",
      "Needs a decision: Blake Ashgrove has no current background check on file. Scheduled for Nursery volunteer at 9:30 AM on November 22. " +
        `Your Church rules ask for a current background check before serving with kids. From Planning Center People, checked 10:00 AM on November 20. ${KEPT_HERE}`,
    ]);
    expect(out.restored.join(" ")).not.toMatch(/Lyrics|Cameron|Greeter/u);
    // Where it came from: Services for the Sunday, People for the background check, and the Church rules that ask for both.
    expect(out.evidence.map(e => e.tool)).toEqual(["sunday.overview", "sunday.open_needs"]);
    expect(out.sources.map(s => s.source)).toEqual(["Planning Center People", "Church rules on this Mac"]);
    expect(out.gaps).toEqual([]);
  });

  it("Any background check problems? Only background checks, across the kids teams", async () => {
    const out = (await local("Any background check problems?"))!;
    expect(out.restored).toEqual([
      expect.stringMatching(/^Needs a decision: Blake Ashgrove has no current background check on file\. Scheduled for Nursery volunteer at 9:30 AM on November 22\./u),
      expect.stringMatching(/^Needs a decision: Cameron Larkspur's background check on file expires before Sunday\. Scheduled for Lyrics at 9:30 AM on November 22\..* Kept on this Mac; never sent to an AI\.$/u),
    ]);
  });

  it("Who could cover the nursery? The open role and the people on its team, in label order, with what no overlap doesn't mean", async () => {
    const out = (await local("Who could cover the nursery?"))!;
    expect(out.restored).toEqual([
      expect.stringMatching(/^Needs a decision: Nursery volunteer at 9:30 AM on November 22 still needs 1 more person/u),
      "The check found no one else on the team for Nursery volunteer.",
      expect.stringMatching(/^Needs a decision: Nursery volunteer at 9:30 AM on November 22 has 1 confirmed person/u),
      expect.stringMatching(/^Needs a decision: Blake Ashgrove has no current background check on file\..* Kept on this Mac; never sent to an AI\.$/u),
    ]);
    expect(out.evidence.map(e => e.tool)).toEqual(["sunday.overview", "sunday.open_needs", "sunday.who_could_help"]);
    // A kids team with people on it: each one in label order (labels follow the order the tools first met people, which
    // says nothing about anyone), never ranked, and what no overlap doesn't mean.
    const greeters = (await local("Who could cover the greeters?", harnessData({ mode: "live", rules: { ...RULES, kidsTeams: [{ team_id: TEAMS.greeter, min_confirmed: 1 }] } })))!;
    expect(greeters.restored).toEqual([
      expect.stringMatching(/^Needs a decision: Greeter at 9:30 AM on November 22 still needs 1 more person/u),
      "Riley Thornbury has no overlap found for Greeter.",
      "Sam Whitcombe was left out for Greeter: a blockout covers this time.",
      "Morgan Ellingsworth was left out for Greeter: confirmed elsewhere at this time.",
      "Casey Pemberly has a possible conflict for Greeter: pending elsewhere at this time.",
      "Drew Halvorsen's availability for Greeter needs confirmation: a blockout couldn't be checked.",
      NOT_FREE, NOT_RANKED,
    ]);
  });

  it("says plainly when nothing was found, what it didn't check, and when no kids team is marked", async () => {
    // Nothing on the kids team: said, never left blank, with what wasn't counted as Worth a look.
    const quiet = harnessData({ mode: "live", rules: { ...RULES, kidsTeams: [{ team_id: "7599999", min_confirmed: 2 }] } });
    const clear = (await local("Are the kids teams ready?", quiet))!;
    expect(clear.restored).toEqual(["This check found nothing for your kids teams that needs a decision or is worth a look."]);
    expect(clear.gaps).toEqual(["1 kids team isn't on this Sunday's plan, so it wasn't counted."]);
    // Background checks that weren't part of the check are Worth a look, never "on file".
    const unread = harnessData({ mode: "live", rules: KIDS_RULES });
    const lines = (await local("Do the kids teams have background checks?", unread))!;
    expect(lines.restored).toEqual([BACKGROUND_UNCONFIRMED]);
    expect(lines.gaps).toEqual(["Background checks weren't part of this check. Check Planning Center again to include them."]);
    // Every background check read and none flagged: only then is "on file" said.
    const onFile = (await local("Any background check problems?", harnessData({ mode: "live", rules: KIDS_RULES, capture: allCleared() })))!;
    expect(onFile.restored).toEqual([BACKGROUND_ON_FILE]);
    // The rule turned off: said so.
    const off = (await local("Any background check problems?", kidsData({ ...KIDS_RULES, kidsBackgroundChecks: false })))!;
    expect(off.restored).toEqual([BACKGROUND_OFF]);
    // No kids team marked: said so, with what the check found for the team named.
    const none = (await local("Is the nursery ready?", kidsData(RULES)))!;
    expect(none.restored[0]).toBe(NO_KIDS_TEAM);
    expect(none.sources.map(s => s.source)).toEqual(["Church rules on this Mac"]);
    expect(kidsWording("Is the nursery ready?") && kidsWording("Any background-check problems?") && !kidsWording("Draft a note for the nursery") && !kidsWording("Is Greeter ready?")).toBe(true);
    expect(none.restored[1]).toMatch(/^Needs a decision: Nursery volunteer at 9:30 AM on November 22 still needs 1 more person/u);
    expect(none.restored.join(" ")).not.toMatch(/background check on file/u);
    // Who could cover it doesn't need that line.
    expect((await local("Who could cover the nursery?", kidsData(RULES)))!.restored[0]).toMatch(/^Needs a decision: Nursery volunteer at 9:30 AM/u);
  });
});

describe("a decision question: open decisions the answer left out are added on this Mac", () => {
  it("What still needs a decision this Sunday? The answer's own items, then the background checks, the follow-up and the room overlap it left out", async () => {
    const data = kidsData();
    const model: ModelStep = async r => r.messages.length < 3 ? call("sunday.overview")
      : answer({ answer: "facts", facts: (results(r)[0]!.payload as { findings: { fact: string; tone: string }[] }).findings.filter(f => f.tone === "needs a decision").map(f => f.fact) });
    const h = new Harness({ workspace_id: "w", data, skills, runtime: new TsLoop(), model, now: () => FRESH });
    const res = await h.ask("What still needs a decision this Sunday?");
    if (!res.ok) throw new Error(res.refusal);
    expect(DECISION_QUESTION.test("What still needs a decision this Sunday?")).toBe(true);
    const left = await decisionsLeftOut(h.tools, res.outcome.answer!, res.outcome.evidence, signal);
    const shown = left.paragraphs.map(p => left.fill(h.restore(p)));
    expect(shown[0]).toBe(ALSO_ON_SUNDAY);
    expect(shown.slice(1)).toEqual([
      expect.stringMatching(/^Needs a decision: Blake Ashgrove has no current background check on file\..* Kept on this Mac; never sent to an AI\.$/u),
      expect.stringMatching(/^Needs a decision: Cameron Larkspur's background check on file expires before Sunday\..* Kept on this Mac; never sent to an AI\.$/u),
      expect.stringMatching(/^Room use needs review: Sanctuary \(fictional\) has bookings that overlap on November 22 from /u),
      "Welcome follow-up (fictional), step Call a first-time guest, was due 5:27 PM on October 26 and has no owner.",
    ]);
    expect(left.evidence.map(e => e.tool)).toEqual(["sunday.overview", "rooms.conflicts", "followups.unowned"]);
    expect(left.sources.map(s => s.source)).toEqual(["Planning Center People"]);
  });

  it("adds nothing the answer already said, and nothing a leader already decided", async () => {
    const data = kidsData();
    const tools = new HarnessTools(data, new HarnessSession(), { now: () => FRESH });
    const evidence = [await tools.run("sunday.overview", {}, signal, "t"), await tools.run("rooms.conflicts", {}, signal, "t"), await tools.run("followups.unowned", {}, signal, "t")];
    const ids = evidence.flatMap(e => [...JSON.stringify(e.payload).matchAll(/"fact":"(f\d+)"/gu)].map(m => m[1]!));
    const all = await decisionsLeftOut(tools, JSON.stringify({ answer: "facts", facts: ids.slice(0, 24) }), evidence, signal);
    // Only the background checks: they never reach an answer the AI chose.
    expect(all.paragraphs.slice(1).every(p => p.endsWith(KEPT_HERE))).toBe(true);
    expect(all.paragraphs).toHaveLength(3);
    // A tool's own summary of rooms or follow-ups counts as saying them.
    const summaries = evidence.slice(1).map(e => (e.payload as { fact: string }).fact);
    const counted = await decisionsLeftOut(tools, JSON.stringify({ answer: "facts", facts: summaries }), evidence, signal);
    expect(counted.paragraphs.join(" ")).not.toMatch(/\[Room \d+\] has bookings|has no owner/u);
    // A decided finding is settled: never listed again unless a later check reopened it.
    const greeter = data.brief!.findings.find(f => f.kind === "needs-people")!;
    const decidedData = { ...data, decisions: [decide(greeter, "covered-outside", "A parent is covering", CHECKED)] };
    const decidedTools = new HarnessTools(decidedData, new HarnessSession(), { now: () => FRESH });
    const left = await decisionsLeftOut(decidedTools, '{"answer":"not-covered"}', [], signal);
    const decided = left.paragraphs.map(p => left.fill(restoreLabels(p, decidedTools.session, { names: data.capture!.names, timeZone: data.brief!.time_zone })));
    expect(decided.filter(p => /still needs 1 more person/u.test(p))).toEqual([expect.stringMatching(/^Needs a decision: Nursery volunteer at/u)]);
    expect(decided.join(" ")).not.toContain("Greeter");
  });
});

describe("room overlaps in the Sunday page's tone, the date said once", () => {
  const rooms = (row: Record<string, unknown>): ToolEnvelope[] => [{ tool: "rooms.conflicts", source: "Planning Center Calendar", check_time: "2026-11-20T15:00:00Z", completeness: "complete",
    payload: { fact: "f1", status: "room use needs review", worth_a_look: 0, rooms: [{ fact: "f2", room: "[Room 1]", setup_minutes: 30, church_rule: "not shared", worked_out_in_planning_center: "not worked out", ...row }] } }];
  const sentence = (row: Record<string, unknown>) => composeAnswer('{"answer":"facts","facts":["f2"]}', rooms(row)).paragraphs[0];
  const on = (a: string, b: string) => ({ starts_at: a, ends_at: b });
  it("says a one-day overlap's date once, and the bookings' too when they fall on it", () => {
    const shown = showTimes(sentence({ label: "Room use needs review", overlap: on("2026-11-29T10:15-05:00", "2026-11-29T11:00-05:00"),
      bookings: [{ time: on("2026-11-29T09:00-05:00", "2026-11-29T11:00-05:00"), approval: "approved" }, { time: on("2026-11-29T10:45-05:00", "2026-11-29T11:15-05:00"), approval: "approved" }] })!, "America/New_York");
    expect(shown).toBe("Room use needs review: [Room 1] has bookings that overlap on November 29 from 10:15 AM to 11:00 AM; the bookings are from 9:00 AM to 11:00 AM (approved) " +
      "and from 10:45 AM to 11:15 AM (approved), with 30 minutes of setup time. Your Church rules say this room isn't shared. Planning Center doesn't show it as worked out.");
  });
  it("keeps each date when they differ, and Worth a look for an overlap the Church rules can't confirm", () => {
    const shown = showTimes(sentence({ label: "Worth a look", church_rule: "no rule set", overlap: on("2026-11-29T23:30-05:00", "2026-11-30T00:30-05:00"),
      bookings: [{ time: on("2026-11-29T23:00-05:00", "2026-11-30T01:00-05:00"), approval: "approved" }, { time: on("2026-11-29T21:00-05:00", "2026-11-29T23:45-05:00"), approval: "pending" }] })!, "America/New_York");
    expect(shown).toBe("Worth a look: [Room 1] has bookings that overlap from 11:30 PM on November 29 to 12:30 AM on November 30; the bookings are from 11:00 PM on November 29 to 1:00 AM on November 30 (approved) " +
      "and on November 29 from 9:00 PM to 11:45 PM (pending), with 30 minutes of setup time. No room rule is set for it. Planning Center doesn't show it as worked out.");
  });
});

describe("review Q: never an implied all clear, never blank, decided and set-aside items said, labels kept apart", () => {
  it("says no one is without a current background check only when the check supports it exactly (H1)", async () => {
    const ask = async (data: HarnessData) => (await local("Any background check problems?", data))!;
    // The one case that may say it: who is scheduled read, someone scheduled, every check read, complete and current.
    expect((await ask(harnessData({ mode: "live", rules: KIDS_RULES, capture: allCleared() }))).restored).toEqual([BACKGROUND_ON_FILE]);
    // Who is scheduled didn't load.
    const unloaded = allCleared();
    unloaded.reads = unloaded.reads.map(r => r.collection === "team_members" ? { ...r, outcome: "denied", body: null } as unknown as typeof r : r);
    const a = await ask(harnessData({ mode: "live", rules: KIDS_RULES, capture: unloaded }));
    expect(a.restored).toEqual([BACKGROUND_UNCONFIRMED]);
    expect(a.gaps).toContain(MEMBERS_UNREAD);
    // A finding set aside with "This isn't right": counted, never read as "no one".
    const both = await ask(setAsideIn(kidsData(), f => f.kind === "background-check"));
    expect(both.restored).toEqual([setAside(2, "background check")]);
    expect(setAside(2, "background check")).toBe("2 background checks are set aside by your Church rules, so they aren't listed here; they're on the Sunday page.");
    const one = await ask(setAsideIn(kidsData(), f => f.kind === "background-check" && f.position?.team_id === TEAMS.nursery));
    expect(one.restored).toEqual([expect.stringMatching(/^Needs a decision: Cameron Larkspur's background check/u),
      "One background check is set aside by your Church rules, so it isn't listed here; it's on the Sunday page."]);
    // An out-of-date check, and a saved recording, aren't current.
    const stale = await ask(harnessData({ mode: "live", rules: KIDS_RULES, capture: allCleared(), now: "2026-11-20T17:00:00Z" }));
    expect(stale.restored).toEqual([BACKGROUND_UNCONFIRMED]);
    expect(stale.evidence.map(e => [e.tool, e.completeness])).toEqual([["sunday.not_checked", "stale"]]);
    expect((await ask(harnessData({ mode: "recording", rules: KIDS_RULES, capture: allCleared() }))).restored).toEqual([BACKGROUND_UNCONFIRMED]);
    // Nobody confirmed or pending on a kids team: said as that, never as "everyone has one".
    expect((await ask(harnessData({ mode: "live", rules: { ...RULES, kidsTeams: [{ team_id: "7599999", min_confirmed: 2 }] }, capture: allCleared() }))).restored)
      .toEqual([NOBODY_SCHEDULED]);
    // A readiness answer about a team whose findings are all set aside says so, never "nothing found".
    const quiet = (await local("Is the nursery ready?", setAsideIn(kidsData(), f => f.position?.team_id === TEAMS.nursery)))!;
    expect(quiet.restored).toEqual([setAside(3)]);
    expect(quiet.restored.join(" ")).not.toMatch(/found nothing/u);
  });

  it("answers here only what is about a kids team or background checks; a whole-Sunday question goes to Ask (M2)", () => {
    const named = (name: string) => kidsData({ ...RULES, kidsTeams: [{ team_id: TEAMS.nursery, min_confirmed: 2, name }] });
    expect(kidsQuestion("Is everything ready for next Sunday?", named("Next Gen"))).toBeNull();
    expect(kidsQuestion("Is Next Gen ready?", named("Next Gen"))).toMatchObject({ teams: [TEAMS.nursery], named: true });
    expect(kidsQuestion("What still needs a decision at the first service?", named("First Steps"))).toBeNull();
    expect(kidsQuestion("Is First Steps covered?", named("First Steps"))).toMatchObject({ named: true });
    for (const typed of ["Is everything ready for Sunday, including the kids?", "What still needs a decision this Sunday?", "Are we ready, kids included?",
      "Is everything ready for the nursery and Greeter?"]) expect(kidsQuestion(typed, kidsData()), typed).toBeNull();
    // A decision question about a kids team by name stays local; one that names background checks gets the whole Sunday.
    expect(kidsQuestion("What still needs a decision for the nursery?", kidsData())).toMatchObject({ teams: [TEAMS.nursery], named: true, whole: false });
    expect(kidsQuestion("What still needs a decision this Sunday? Any background check issues?", kidsData())).toMatchObject({ background: true, whole: true, named: false });
  });

  it("never answers with nothing, and points to Church rules when no kids team is marked (M3)", async () => {
    for (const [typed, data] of [["Who could help with the kids?", kidsData(RULES)], ["Who can sub for children's church?", kidsData(RULES)],
      ["Is anyone available for childcare?", kidsData(RULES)], ["Any background check problems?", kidsData(RULES)], ["Who could help with the kids?", kidsData()],
      ["Is anyone available for childcare?", kidsData()]] as const) {
      const out = (await local(typed, data))!;
      expect(out.paragraphs.length, typed).toBeGreaterThan(0);
    }
    expect((await local("Who could help with the kids?", kidsData(RULES)))!.restored).toEqual([NO_KIDS_TEAM]);
    expect(NO_KIDS_TEAM).toContain("Church rules, under Kids teams");
  });

  it("words a role the leader resolved as resolved, unless a later check reopened it (L1)", async () => {
    const data = kidsData();
    const need = data.brief!.findings.find(f => f.kind === "needs-people" && f.position?.team_id === TEAMS.nursery)!;
    const out = (await local("Is the nursery ready?", { ...data, decisions: [decide(need, "covered-outside", "A parent is covering", CHECKED)] }))!;
    expect(out.restored[0]).toMatch(/^Resolved by you: Nursery volunteer at 9:30 AM on November 22 still needs 1 more person.* You decided: covered outside Planning Center\.$/u);
    expect(out.restored[1]).toMatch(/^Needs a decision: Nursery volunteer at 9:30 AM on November 22 has 1 confirmed person/u);
  });

  it("composes background checks with names looked up here, never minting labels shared with the AI or other AI apps (L2)", async () => {
    const data = kidsData(), session = new HarnessSession();
    const out = await kidsAnswer(new HarnessTools(data, session, { now: () => FRESH }), kidsQuestion("Any background check problems?", data)!, signal);
    expect(session.has("[Person 1]")).toBe(false);
    expect(out.paragraphs.join(" ")).not.toMatch(/\[(?:Person|Role) \d+\]/u);
    expect(out.paragraphs.join(" ")).toMatch(/\[Kept person 1\]/u);
    // The decisions addition mints exactly the labels its own tool reads do, in the same order.
    const a = new HarnessSession(), b = new HarnessSession();
    await decisionsLeftOut(new HarnessTools(data, a, { now: () => FRESH }), '{"answer":"not-covered"}', [], signal);
    const tb = new HarnessTools(data, b, { now: () => FRESH });
    for (const t of ["sunday.overview", "rooms.conflicts", "followups.unowned"]) await tb.run(t, {}, signal, "x");
    for (let n = 1; n <= 20; n++) for (const f of ["Person", "Role"]) expect(a.target(`[${f} ${n}]`), `${f} ${n}`).toEqual(b.target(`[${f} ${n}]`));
  });

  it("knows more ways of asking what needs a decision (L4)", () => {
    for (const q of ["What still needs a decision this Sunday?", "Any problems this Sunday?", "Anything I should know about Sunday?", "Are we good for Sunday?", "Is Sunday covered?",
      "What's open for Sunday?", "Anything I need to deal with this weekend?", "What needs my attention?", "Is everything set for Sunday?", "Any issues?"]) expect(isDecisionQuestion(q), q).toBe(true);
    for (const q of ["Who could cover Greeter?", "When is the youth retreat?", "Draft a note to Riley"]) expect(isDecisionQuestion(q), q).toBe(false);
  });

  it("lists every open decision here when a decision question names background checks, and says when nothing is open (H2, M2)", async () => {
    const data = kidsData(), tools = new HarnessTools(data, new HarnessSession(), { now: () => FRESH });
    const out = await openDecisions(tools, signal);
    const shown = out.paragraphs.map(p => out.fill(restoreLabels(p, tools.session, { names: data.capture!.names, timeZone: data.brief!.time_zone })));
    expect(shown[0]).toBe(ON_SUNDAY);
    const kind = (p: string) => p.startsWith("Needs a decision: ") ? (p.endsWith(KEPT_HERE) ? "background check" : "decision") : p.startsWith("Room use needs review: ") ? "room"
      : p.endsWith(" has no owner.") ? "follow-up" : p;
    expect(shown.slice(1).map(kind)).toEqual(["decision", "decision", "decision", "decision", "background check", "background check", "room", "follow-up"]);
    // Every role filled and no rooms or follow-ups read: nothing open, said plainly (with its gaps, never as all clear).
    const capture = nov22Capture();
    capture.reads = capture.reads.map(r => r.collection === "needed_positions" ? { ...r, body: { ...r.body!, data: [] } } : r);
    const empty = harnessData({ mode: "live", capture, operationsOff: true });
    const none = await openDecisions(new HarnessTools(empty, new HarnessSession(), { now: () => FRESH }), signal);
    expect(none.paragraphs[0]).toBe(NOTHING_OPEN);
  });
});
