// A watched service's name in Ask (owner request 2026-11-21, "address fully now"): with two services watched, each
// with a Greeter, a question or chip naming a service is sent with that service's [Service N] label, the AI's lookups
// read that service only, and the answer is about it alone, its name put back on this Mac. No service's name, no role's
// name and no person's name is in any request a model could receive. With one service, and for every question that
// names no service, every request is byte for byte what 0.5.6 sent (hashes recorded from 0.5.6's code with this very
// scripted model). Fixed fictional data, clock pinned to the fictional check.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => { throw new Error("NATIVE_CALL_FORBIDDEN"); }) }));
import { AskPanel } from "../src/ask-panel.js";
import { askOzzie, overviewAnswer, type AskTurn } from "../src/harness-bridge.js";
import { askServices, MANY_SERVICES, mergedNames, mergeParts, teamServices } from "../src/services-merge.js";
import { containsNameWord, REFUSALS, rolePositions, suggestedQuestions } from "../../../core/src/ask.js";
import { buildSundayBrief, type SundayBrief } from "../../../core/src/sunday-brief.js";
import { nov22Capture, TEAMS } from "../../../core/src/fictional-sunday.js";
import { wednesdayCapture } from "../../../core/test/fixtures/service-days/wednesday.js";
import { pinnedRequestProblems } from "../../../core/test/harness/native-rules.js";
import { sharedEnvelopes } from "../../../core/mcp/snapshot.js";
import { bundledSkills } from "../../../core/src/harness/bundled-skills.js";
import { composeAnswer, NOTHING_OPEN } from "../../../core/src/harness/compose.js";
import type { AgentStepReply, AgentStepRequest, AgentTask, ModelStep, TaskOutcome } from "../../../core/src/harness/contract.js";
import { Harness } from "../../../core/src/harness/index.js";
import { HarnessSession } from "../../../core/src/harness/session.js";
import { HarnessTools, type HarnessData } from "../../../core/src/harness/tools.js";
import { TsLoop } from "../../../core/src/harness/ts-loop.js";

const skills = await bundledSkills();
const rules = { sundayLeads: [], checkInAfterSundaysInARow: 3 };
const WEEKEND = "Weekend Service", YOUTH = "Ozzie Demo Youth Night (fictional)";
const TASK = "00000000-0000-4000-8000-0000000000c1";

/** The rehearsal's second service: its own plan and teams, with only a Greeter (named `role`) that still needs 2. */
function youthNight(role = "Greeter", name = YOUTH) {
  const capture = { ...wednesdayCapture(), service_type_id: "1700", plan_id: "94000001" };
  const built = buildSundayBrief(capture, rules, capture.completed_at);
  const team = (id: string) => `y${id}`;
  const greeter = built.findings.find(f => f.kind === "needs-people" && f.position?.name === "Greeter")!;
  const position = { ...greeter.position!, name: role, team_id: team(greeter.position!.team_id), interval: null };
  const brief: SundayBrief = {
    ...built,
    findings: [{ ...greeter, position, remaining: 2, people: { suggestions: [], conflicts: [], unverified: [], left_out: [] }, confirmed: [] }],
    positions: built.positions.filter(p => p.name === "Greeter").map(p => ({ ...p, name: role, team_id: team(p.team_id), interval: null })),
  };
  return { capture, brief, name };
}
/** A third service read with nothing open and no positions at all (review of polish 4: a service with no positions). */
function quiet(name = "Quiet Hour") {
  const capture = { ...wednesdayCapture(), service_type_id: "1800", plan_id: "95000001" };
  const built = buildSundayBrief(capture, rules, capture.completed_at);
  return { capture, brief: { ...built, findings: [], positions: [] } as SundayBrief, name };
}
function weekend(name = WEEKEND) { const capture = nov22Capture(); return { capture, brief: buildSundayBrief(capture, rules, capture.completed_at), name }; }

type Part = ReturnType<typeof weekend>;
interface Case { data: HarnessData; chips: string[]; now: string }
/**
 * What Ask reads and suggests, as App builds it (pcHarnessData): the first service's check with the others joined in,
 * each team's and each finding's service, and every service watched (`unread`: watched, no check read yet).
 */
function watched(main: Part, others: Part[] = [], unread: string[] = []): Case {
  const now = main.capture.completed_at;
  const base = { operations: null, rules, attention: null, granted: ["services"], mode: "live", connected: true } as const;
  const asked = askServices({ brief: main.brief, name: main.name }, others.map(o => ({ plan_id: o.capture.plan_id, brief: o.brief, name: o.name })), unread);
  if (!others.length) return { data: { ...base, capture: main.capture, brief: main.brief, decisions: [], ...asked }, chips: suggestedQuestions(main.brief), now };
  const m = mergeParts({ brief: main.brief, decisions: [] }, others.map(o => ({ plan_id: o.capture.plan_id, brief: o.brief, decisions: [] })));
  const serviceOfTeam = teamServices({ brief: main.brief, name: main.name }, others.map(o => ({ brief: o.brief, name: o.name })))!;
  return {
    data: { ...base, capture: mergedNames(main.capture, others.map(o => o.capture)), brief: m.brief, decisions: m.decisions, serviceOfTeam, ...asked },
    chips: suggestedQuestions({ ...main.brief, day: MANY_SERVICES }, { teams: serviceOfTeam, positions: rolePositions(m.brief) }), now,
  };
}
/** The same check as 0.5.6's app built it: no service's name known to Ask. */
const as056 = (c: Case): Case => {
  const data: HarnessData = { ...c.data };
  delete data.services;
  delete data.serviceOfFinding;
  return { ...c, data };
};

const call = (step: number, name: string, args: Record<string, unknown> = {}): AgentStepReply => ({ content: "", tool_calls: [{ id: `call_${step}_0`, name, arguments: JSON.stringify(args) }], finish: "tool_calls" });
const reply = (o: unknown): AgentStepReply => ({ content: JSON.stringify(o), tool_calls: [], finish: "stop" });
const results = (r: AgentStepRequest) => r.messages.flatMap(m => m.role === "tool" ? [JSON.parse(m.content) as { tool: string; payload: Record<string, unknown> }] : []);
const everyFact = (p: Record<string, unknown>) => [p["fact"] as string, ...["times", "people", "findings", "needs", "pending", "check_ins"].flatMap(k => Array.isArray(p[k]) ? (p[k] as { fact: string }[]).map(x => x.fact) : [])];

/**
 * A scripted model that does what a model asked this question would (the one 0.5.6's hashes were recorded with): who
 * could help when the question holds a role's label, pending requests for who hasn't answered, the overview otherwise;
 * a note for someone with no overlap found when asked for one; then every fact of the first result. `summaryOnly`: only
 * the result's own fact; `nothing`: "nothing needs a decision" when the overview counts none.
 */
function scripted(sent: AgentStepRequest[], opts: { summaryOnly?: boolean; nothing?: boolean } = {}): ModelStep {
  return async r => {
    sent.push(r);
    const question = r.messages[1]!.content, role = /\[Role \d+\]/u.exec(question)?.[0];
    const got = results(r);
    if (!got.length) return role ? call(sent.length, "sunday.who_could_help", { role }) : /answered|pending/iu.test(question) ? call(sent.length, "sunday.pending_requests") : call(sent.length, "sunday.overview");
    const draft = got.find(g => g.tool === "drafts.prepare_note");
    if (draft) return reply({ answer: "draft", draft: draft.payload["draft_id"], facts: [] });
    const free = (got[0]!.payload["people"] as { person: string; status: string }[] | undefined)?.find(p => p.status === "no overlap found");
    if (role && /^Draft a note/u.test(question) && free) return call(sent.length, "drafts.prepare_note", { person: free.person, role });
    if (opts.nothing && got[0]!.tool === "sunday.overview" && got[0]!.payload["needs_a_decision"] === 0) return reply({ answer: "nothing-needs-a-decision" });
    return reply({ answer: "facts", facts: opts.summaryOnly ? [got[0]!.payload["fact"]] : everyFact(got[0]!.payload).slice(0, 24) });
  };
}
const harness = (c: Case, sent: AgentStepRequest[], opts: Parameters<typeof scripted>[1] = {}) =>
  new Harness({ workspace_id: "fictional", data: c.data, skills, runtime: new TsLoop(), model: scripted(sent, opts), now: () => c.now, newId: () => TASK, macZone: "America/New_York" });

/** One question through the real harness: every request a model received, what was shown, and the question as sent. */
async function asked(c: Case, typed: string, opts: Parameters<typeof scripted>[1] = {}) {
  const sent: AgentStepRequest[] = [];
  const h = harness(c, sent, opts);
  const res = await h.ask(typed);
  if (!res.ok) return { refusal: res.refusal, sent, h, shown: [] as string[], question: null };
  expect(res.outcome.status, `${typed}: ${res.outcome.code ?? ""}`).toBe("verified");
  const composed = composeAnswer(res.outcome.answer!, res.outcome.evidence, c.data.brief!.day ?? null);
  return { refusal: null, sent, h, question: res.task.question!, shown: [...composed.paragraphs, ...(composed.draft ? [composed.draft] : [])].map(p => h.restore(p)) };
}
const hash = (sent: readonly AgentStepRequest[]) => createHash("sha256").update(JSON.stringify(sent)).digest("hex");
const words = (list: readonly string[]) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${list.map(w => w.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replace(/\s+/gu, "\\s*[-_/]?\\s*")).join("|")})(?![\\p{L}\\p{N}])`, "iu");

/**
 * No watched service's name or a distinctive part of it, no role's name and no person's name, anywhere in what varies
 * in any request (the question, the model's turns, tool calls and results); the system message and tool specs are
 * Ozzie's own pinned words, checked against their pins below.
 */
function nothingNamed(c: Case, sent: readonly AgentStepRequest[]) {
  const varying = JSON.stringify(sent.map(r => r.messages.slice(1)));
  expect(varying).not.toMatch(words([...(c.data.services ?? []).map(s => s.name), "Youth Night", "Ozzie Demo", "Demo Youth", "WeekendService", "W\u0435ekend", "\u0423outh"]));
  expect(JSON.stringify(sent)).not.toMatch(words([...new Set(c.data.brief!.positions.map(p => p.name.trim())), "Greeter", "Nursery", "Lyrics"]));
  expect(containsNameWord(varying, c.data.capture!.names)).toBe(false);
  // Native's re-check (agent.rs check_step, mirrored) and the hosted pins: the system message and every tool spec as pinned.
  for (const r of sent) expect(pinnedRequestProblems(r, c.data.capture!.names), JSON.stringify(r.messages[1])).toEqual([]);
}

// Recorded from 0.5.6's code (before this change) with this scripted model: every request, hashed, for questions that
// name no service, with one service, with two that share Greeter, and with two that share no role's name.
const PINS: Record<string, Record<string, string>> = {
  one: {
    "Who could cover Greeter?": "a5213a0d5cfc76c8d8a78dea190e8f472a67a548fcd366600c979d0450ba4522",
    "What still needs a decision this Sunday?": "876b00c0a82b73b68bed4c8f89c86f1c8ac9029b08a00cce5b01f31c019854b0",
    "Why is Greeter flagged?": "401a470ad2a00fe970bf91b3892aa0a4e43e7a5c16e166adb66b2d7b57ff62f6",
    "Draft a note to someone who could cover Greeter": "3604d67b8eb00ab811a61ba492e8c684172717ed39f6ed0757a3a1ad2e590bfc",
    "What still needs a decision?": "5fc5ee0b9c416602c4f9eb1c76fa1f57018ef9270c56e5121ad556c13d6701a0",
    "Who hasn't answered yet?": "c4f7f96b662b753bb8ca0d588543d190153e105fb9ad52c120817a477ddf377f",
    "Is everything covered this weekend?": "946092a95d6921e879ecf1241edeeda0bc65eb72a0e4f51adb68204b53b57eea",
    "who could cover greeter": "c7e4a5277eed8f0225892ec0ac2706a16699069020a3760109308b25ec551411",
    "Who could cover Nursery?": "1b5697681a3aa484e92cd3e90f9a69868d0200edd42a9dfa95f848882efdd65d",
  },
  shared: {
    "Who could cover Greeter?": "f885c0cc52149c3b7be0581190751dfc577ddb329bfed63ec6281fff2bd68f2a",
    "What still needs a decision for your services?": "69fb3e46b2e9f9fd9315c8aef655ed8cfcb8f18c58e8ddef76134f3834ed17e5",
    "Why is Greeter flagged?": "3613d6fde9790fb3767efc6302143f0eb4516bcde99a9bf0c0aada9344f4ba96",
    "Draft a note to someone who could cover Greeter": "a55717411ba4639fffa4edfdae641fce31f776bf932a7d8bb5d1ced9e1a76260",
    "What still needs a decision?": "4561f4c951b217b08ed8989bd5486e3ce4aa5ca0e6c477fa01bbb0033aaa66eb",
    "Who hasn't answered yet?": "c4f7f96b662b753bb8ca0d588543d190153e105fb9ad52c120817a477ddf377f",
    "Is everything covered this weekend?": "120ce2a1453c55e54b98792509f1f14cc7f2b565294df206ca56b3e257ced2de",
    "who could cover greeter": "2097721f61848c673b414eb41062c422a7e3a8c553f919e1af7d2dece2dc07a6",
    "Who could cover Nursery?": "1b5697681a3aa484e92cd3e90f9a69868d0200edd42a9dfa95f848882efdd65d",
  },
  unshared: {
    "Who could cover Greeter?": "a5213a0d5cfc76c8d8a78dea190e8f472a67a548fcd366600c979d0450ba4522",
    "What still needs a decision for your services?": "305038b6bf730d31fff7fb935ff80f0d78b06874c471f68671e5a6714fe71dca",
    "Why is Greeter flagged?": "401a470ad2a00fe970bf91b3892aa0a4e43e7a5c16e166adb66b2d7b57ff62f6",
    "Draft a note to someone who could cover Greeter": "3604d67b8eb00ab811a61ba492e8c684172717ed39f6ed0757a3a1ad2e590bfc",
    "What still needs a decision?": "068c78d6b461e2c242c10ed74296214c112921e9d6e6114c510523341fa72332",
    "Who hasn't answered yet?": "c4f7f96b662b753bb8ca0d588543d190153e105fb9ad52c120817a477ddf377f",
    "Is everything covered this weekend?": "c3e03ea00640094ca0be1e3ee4b075241e849f08b61efed759053d9ae690a03a",
    "who could cover greeter": "c7e4a5277eed8f0225892ec0ac2706a16699069020a3760109308b25ec551411",
    "Who could cover Nursery?": "1b5697681a3aa484e92cd3e90f9a69868d0200edd42a9dfa95f848882efdd65d",
  },
};
// Recorded the same way from 0.5.6's code for questions that name a service or a name's ordinary words: what 0.5.6 sent,
// with one service (the name typed out, never labelled with one service), with two services named in everyday words,
// and with two services whose names hold small words, times or a possessive (review A, M1; review B's test notes).
const PINS_056: Record<string, Record<string, string>> = {
  one: {
    "Is Weekend Service covered?": "b7033284f57cc187f3c7e7de393ffbeaf5e4320b5362d39ff5a8f6f8fc61da2e",
    "Who could cover Greeter at Weekend Service?": "cd019a60d45aaedf18baee44ed500dd1d0411b4c8a76d5390291aecf7a528d31",
  },
  everyday: {
    "What still needs a decision for your services?": "69fb3e46b2e9f9fd9315c8aef655ed8cfcb8f18c58e8ddef76134f3834ed17e5",
    "Who is serving sunday morning?": "a09804c26acc69e3b5ae3619739eff4c4804613071840e2774613b76c543831f",
    "Are all services covered?": "363c7365979e112fa44dbc33e48f4d8c9133ccba316505efce9efaa84c448270",
    "Who could cover Greeter this Sunday?": "df12997840dced16e504b1386ce57bb44103b13d09000f6f3f86529d25b1ebd1",
  },
  park: {
    "Who could cover Greeter in the morning?": "b6b716ce99248a5da829a41805235023b302e9979f34e66527a668af39440a5b",
  },
  cross: {
    "What is the state of the plan?": "2a25bde70a69ad0a57c7e6cf186490c6dea49d031e8a61c1b295508f1497755b",
  },
  nineeleven: {
    "Who could cover Greeter at 10:00 AM?": "16b1aec82b45bdbe0cad9f36623450664a2efffe5e07d3d2934130e58111ac28",
  },
  eightten: {
    "Who could cover Greeter at 9:00 AM?": "7b7f02746d83c7146ceda3a3dd5ec83092fd4c2722c7111c0d1fcfa945bded2f",
  },
  children: {
    "Is the children's area covered?": "2235f8e0bc4ca63c29b12accc1c4099e0f9edd3c231befa7c471b8d669e0ad8c",
  },
};
const CASES: Record<string, () => Case> = {
  one: () => watched(weekend()),
  shared: () => watched(weekend(), [youthNight()]),
  unshared: () => watched(weekend(), [youthNight("Door Host")]),
};

describe("questions that name no service, and a church with one service: every request exactly as 0.5.6 sent it", () => {
  for (const [key, make] of Object.entries(CASES)) {
    it(`${key}: the same request hashes, with every service's name known to Ask`, async () => {
      const c = make();
      if (key !== "one") expect(c.data.services?.length).toBe(2);
      else expect(c.data.services).toBeUndefined();
      const got: Record<string, string> = {};
      for (const q of Object.keys(PINS[key]!)) {
        const r = await asked(c, q);
        expect(r.refusal, q).toBeNull();
        nothingNamed(c, r.sent);
        got[q] = hash(r.sent);
      }
      expect(got).toEqual(PINS[key]);
    });
  }

  it("one service read and another watched but not read yet: questions naming no service are 0.5.6's one-service requests", async () => {
    const c = watched(weekend(), [], ["Evening Prayer Gathering"]);
    expect(c.data.services?.length).toBe(2);
    for (const q of Object.keys(PINS["one"]!)) expect(hash((await asked(c, q)).sent), q).toBe(PINS["one"]![q]);
  });

  it("one service: the chips are 0.5.6's, and its name, typed, is sent as 0.5.6 sent it (nothing is labelled with one service)", async () => {
    const c = CASES["one"]!();
    expect(c.chips).toEqual(["Who could cover Greeter?", "What still needs a decision this Sunday?", "Why is Greeter flagged?", "Draft a note to someone who could cover Greeter"]);
    for (const q of Object.keys(PINS_056["one"]!)) {
      const now = await asked(c, q);
      expect(now.question).toContain("Weekend Service");
      expect(hash(now.sent), q).toBe(PINS_056["one"]![q]);
    }
  });

  it("two services named like everyday words: an everyday question in lower case is sent as typed, as without them", async () => {
    const c = watched(weekend("Sunday Morning"), [youthNight("Greeter", "Services")]);
    for (const q of Object.keys(PINS_056["everyday"]!)) {
      const now = await asked(c, q);
      expect(now.refusal, q).toBeNull();
      expect(now.question!.includes("[Service"), q).toBe(false);
      expect(hash(now.sent), q).toBe(PINS_056["everyday"]![q]);
    }
  });

  it("the copy shared with other AI apps is byte for byte the same with the services' names known (no tool there is scoped)", async () => {
    const c = CASES["shared"]!();
    const copy = async (data: HarnessData) => JSON.stringify(await sharedEnvelopes(new HarnessTools(data, new HarnessSession(), { now: () => c.now })));
    const [now, before] = [await copy(c.data), await copy(as056(c).data)];
    expect(now).toBe(before);
    expect(now).not.toContain("[Service");
  });
});

describe("two services each with a Greeter: chips name the service, and asking one sends its labels only", () => {
  it("chips say Greeter (Weekend Service), and the dash form for a service whose own name holds brackets; the panel shows them", () => {
    expect(watched(weekend(), [youthNight()]).chips).toEqual([
      `Who could cover Greeter (${WEEKEND})?`, "What still needs a decision for your services?", `Why is Greeter (${WEEKEND}) flagged?`,
      `Draft a note to someone who could cover Greeter (${WEEKEND})`,
    ]);
    expect(watched(youthNight(), [weekend()]).chips).toEqual([
      `Who could cover Greeter — ${YOUTH}?`, "What still needs a decision for your services?", `Why is Greeter — ${YOUTH} flagged?`,
      `Draft a note to someone who could cover Greeter — ${YOUTH}`,
    ]);
    const chipsOf = (html: string) => [...html.matchAll(/class="chip"[^>]*>([^<]*)</gu)].map(m => m[1]!.replaceAll("&#x27;", "'"));
    const main = weekend(), other = youthNight();
    const m = mergeParts({ brief: main.brief, decisions: [] }, [{ plan_id: other.capture.plan_id, brief: other.brief, decisions: [] }]);
    const teams = teamServices({ brief: main.brief, name: WEEKEND }, [{ brief: other.brief, name: YOUTH }])!;
    const panel = (brief: SundayBrief, services?: React.ComponentProps<typeof AskPanel>["services"]) => renderToStaticMarkup(React.createElement(AskPanel, {
      open: true, onClose: () => {}, ask: () => new Promise<AskTurn>(() => {}), brief, modelReady: true, onOpen: () => {}, services }));
    expect(chipsOf(panel({ ...main.brief, day: MANY_SERVICES }, { teams, positions: rolePositions(m.brief) }))).toEqual(watched(main, [other]).chips);
    expect(chipsOf(panel(main.brief))).toEqual(watched(weekend()).chips);
  });

  for (const [order, make, service, other] of [["Weekend Service first", () => watched(weekend(), [youthNight()]), WEEKEND, YOUTH], ["Youth Night first", () => watched(youthNight(), [weekend()]), YOUTH, WEEKEND]] as const) {
    it(`each chip, ${order}: labels only in every request, and what is shown is that service's alone`, async () => {
      const c = make();
      for (const chip of c.chips) {
        const r = await asked(c, chip);
        expect(r.refusal, chip).toBeNull();
        nothingNamed(c, r.sent);
        if (!chip.includes("Greeter")) continue;
        expect(r.question, chip).toMatch(/\[Role \d+\](?: \(| — )\[Service \d+\]\)?/u);
        const shown = r.shown.join("\n");
        expect(shown, chip).toContain(service === WEEKEND ? `Greeter (${WEEKEND})` : `Greeter — ${YOUTH}`);
        expect(shown, chip).not.toContain(other);
      }
    });
  }
});

/** What a typed question becomes, or that it is sent as typed (everyday words or a name Ozzie never read), or refused. */
type Expect = { sent: string } | "as typed" | { refused: string };
const MATRIX: [string, Expect][] = [
  // A service alone, and beside a role in both forms, any case and spacing.
  ["Is Weekend Service covered?", { sent: "Is [Service 1] covered?" }],
  ["IS WEEKEND SERVICE COVERED?", { sent: "IS [Service 1] COVERED?" }],
  ["Is Weekend   Service covered?", { sent: "Is [Service 1] covered?" }],
  ["Who could cover Greeter (Weekend Service)?", { sent: "Who could cover [Role 1] ([Service 1])?" }],
  ["who could cover greeter (WEEKEND SERVICE)", { sent: "who could cover [Role 1] ([Service 1])" }],
  ["Who could cover Greeter [Weekend Service]?", { sent: "Who could cover [Role 1] ([Service 1])?" }],
  ["Who could cover Greeter — Weekend Service?", { sent: "Who could cover [Role 1] — [Service 1]?" }],
  ["Who could cover Greeter—Weekend Service?", { sent: "Who could cover [Role 1] — [Service 1]?" }],
  [`Who could cover Greeter — ${YOUTH}?`, { sent: "Who could cover [Role 1] — [Service 1]?" }],
  [`Who could cover Greeter (${YOUTH})?`, { sent: "Who could cover [Role 1] ([Service 1])?" }],
  ["who could cover greeter at ozzie demo youth night (FICTIONAL)", { sent: "who could cover [Role 1] at [Service 1]" }],
  // Run together, hyphenated, and look-alike letters (a Cyrillic \u0435, a Cyrillic \u0423).
  ["Who could cover Greeter at WeekendService?", { sent: "Who could cover [Role 1] at [Service 1]?" }],
  ["who could cover greeter at weekend-service", { sent: "who could cover [Role 1] at [Service 1]" }],
  ["Is weekend_service covered?", { sent: "Is [Service 1] covered?" }],
  ["Is W\u0435ekend Service covered?", { sent: "Is [Service 1] covered?" }],
  ["Is \u0423outh Night covered?", { sent: "Is [Service 1] covered?" }],
  // A part of a longer name that is that service's alone; the question about it and a role.
  ["What still needs a decision at Youth Night?", { sent: "What still needs a decision at [Service 1]?" }],
  ["Who could cover Greeter at Ozzie Demo?", { sent: "Who could cover [Role 1] at [Service 1]?" }],
  ["Who hasn't answered yet at Weekend Service?", { sent: "Who hasn't answered yet at [Service 1]?" }],
  ["Draft a note to someone who could cover Greeter (Weekend Service)", { sent: "Draft a note to someone who could cover [Role 1] ([Service 1])" }],
  ["Is Weekend Service or Youth Night short?", { sent: "Is [Service 1] or [Service 2] short?" }],
  // Naming a service refuses nothing its name typed out didn't; asking to change something is still refused.
  ["Please confirm Weekend Service is covered", { sent: "Please confirm [Service 1] is covered" }],
  ["Add Riley Thornbury to Weekend Service", { refused: REFUSALS.send }],
  // Everyday words in lower case, a single word, a service Ozzie doesn't watch: as typed (the Ask note says so).
  ["is weekend service covered?", "as typed"],
  ["Is Weekend service covered?", "as typed"],
  ["is youth night covered?", "as typed"],
  ["Is everything covered this weekend?", "as typed"],
  ["Is Evening Service covered?", "as typed"],
  ["Who could cover Greeter at WeekendServiceTeam?", "as typed"],
  // Only names or roles: refused as any such question is.
  ["Weekend Service", { refused: REFUSALS.onlyNames }],
];

describe("the boundary: every request for a matrix of typed questions", () => {
  const c = watched(weekend(), [youthNight()]);
  for (const [typed, want] of MATRIX) {
    it(typed, async () => {
      const r = await asked(c, typed);
      if (typeof want === "object" && "refused" in want) {
        expect(r.refusal).toBe(want.refused);
        expect(r.sent).toEqual([]);
        return;
      }
      expect(r.refusal).toBeNull();
      if (want === "as typed") {
        expect(r.question!.replace(/\[Role \d+\]/gu, "Greeter")).toBe(typed.replace(/\s+/gu, " "));
        expect(r.question).not.toContain("[Service");
        return;
      }
      // Each question in a fresh session: the labels' numbers start again.
      expect(r.question).toBe(want.sent);
      nothingNamed(c, r.sent);
      for (const label of r.question!.match(/\[Service \d+\]/gu) ?? []) expect(r.h.session.target(label)?.kind).toBe("service");
    });
  }

  it("a service named like ordinary words counts only as the service writes it, and never refuses an ordinary question", async () => {
    const odd = watched(weekend("Sunday Morning"), [youthNight("Greeter", "Services")]);
    expect((await asked(odd, "Who could cover Greeter Sunday Morning?")).question).toBe("Who could cover [Role 1] [Service 1]?");
    expect((await asked(odd, "Are Services short?")).question).toBe("Are [Service 1] short?");
    for (const q of ["Who is serving sunday morning?", "Are all services covered?", "Is Sunday covered?"]) {
      const r = await asked(odd, q);
      expect(r.refusal, q).toBeNull();
      expect(r.question, q).toBe(q);
    }
  });

  it("prints what a model receives for three representative questions (the report's examples)", async () => {
    const out: Record<string, unknown> = {};
    for (const q of ["Who could cover Greeter (Weekend Service)?", "What still needs a decision at Youth Night?", "Is W\u0435ekend Service covered?"]) {
      const r = await asked(c, q);
      nothingNamed(c, r.sent);
      out[q] = r.sent.map(x => x.messages.slice(1));
    }
    if (process.env["OZZIE_PRINT_REQUESTS"]) console.log(JSON.stringify(out, null, 1));
    const questions = Object.values(out).map(sent => (sent as { content: string }[][])[0]![0]!.content);
    expect(questions).toEqual(["Who could cover [Role 1] ([Service 1])?", "What still needs a decision at [Service 1]?", "Is [Service 1] covered?"]);
  });
});

describe("answers are about the service the question names, restored on this Mac", () => {
  const c = watched(weekend(), [youthNight()]);

  it("Is Weekend Service covered? Weekend Service's findings only, grouped as the Sunday page groups them", async () => {
    const r = await asked(c, "Is Weekend Service covered?");
    expect(r.shown[0]).toBe(`For ${WEEKEND}, 2 things need a decision and 2 are worth a look.`);
    expect(r.shown).toContain("Needs a decision:");
    expect(r.shown).toContain(`Greeter (${WEEKEND}) at 9:30 AM on November 22 still needs 1 more person, by Planning Center's count.`);
    expect(r.shown.join("\n")).not.toContain(YOUTH);
    // The overview the AI read was for that service only, and said so first.
    const overview = results(r.sent.at(-1)!).find(e => e.tool === "sunday.overview")!;
    expect(Object.keys(overview.payload).slice(0, 2)).toEqual(["fact", "service"]);
    expect(overview.payload["service"]).toBe(/\[Service \d+\]/u.exec(r.question!)![0]);
  });

  it("Who could cover Greeter at Youth Night? That service's Greeter alone, every line naming it", async () => {
    const r = await asked(c, "Who could cover Greeter at Youth Night?");
    expect(r.shown).toEqual([
      `On the team for Greeter — ${YOUTH}, the check listed 0 people.`,
      `Greeter — ${YOUTH} still needs 2 more people, by Planning Center's count. Ozzie can't tie this role to one service time.`,
    ]);
  });

  it("Who could cover Greeter (Weekend Service)? Weekend's people only, and a note drafted names that service", async () => {
    const r = await asked(c, "Who could cover Greeter (Weekend Service)?");
    expect(r.shown[0]).toBe(`On the team for Greeter (${WEEKEND}), the check listed 5 people.`);
    expect(r.shown.join("\n")).not.toContain(YOUTH);
    const note = await asked(c, "Draft a note to someone who could cover Greeter (Weekend Service)");
    expect(note.shown.at(-1)).toContain(`We still need someone for Greeter (${WEEKEND}) at 9:30 AM on November 22.`);
  });

  it("Who hasn't answered yet at Weekend Service? Said for that service", async () => {
    const r = await asked(c, "Who hasn't answered yet at Weekend Service?");
    expect(r.shown[0]).toMatch(new RegExp(`^At ${WEEKEND}, Planning Center shows 1 pending request`, "u"));
  });

  it("nothing needs a decision at a service with nothing open (and no positions): said for that service, never the whole check", async () => {
    const three = watched(weekend(), [youthNight(), quiet()]);
    const r = await asked(three, "Is Quiet Hour covered?", { nothing: true });
    expect(r.shown[0]).toBe("Nothing at Quiet Hour needs a decision right now.");
    expect(r.shown.join("\n")).not.toMatch(/Greeter|Nursery|Weekend|Youth/u);
  });

  it("the open decisions Ozzie adds on this Mac are that service's alone (askOzzie, decisionsLeftOut)", async () => {
    const sent: AgentStepRequest[] = [];
    const turn = await askOzzie(harness(c, sent, { summaryOnly: true }), "What still needs a decision at Youth Night?", { skills });
    expect(turn.state).toBe("answered");
    if (turn.state !== "answered") return;
    expect(turn.answer.body).toContain(`Greeter — ${YOUTH} still needs 2 more people`);
    expect(turn.answer.body).not.toContain(WEEKEND);
    expect(turn.answer.body).not.toMatch(/Nursery|room/iu);
    nothingNamed(c, sent);
  });
});

describe("what can't be answered is refused, and nothing is sent; what can be is never refused", () => {
  it("words two watched services' names share stand for both, never a refusal (reviews A M1, B F1)", async () => {
    const campuses = watched(weekend("Main Campus 9am"), [youthNight("Greeter", "Main Campus 11am")]);
    const r = await asked(campuses, "who serves at the main campus this week?");
    expect(r.refusal).toBeNull();
    expect(r.question).toBe("who serves at the [Service 1] and [Service 2] this week?");
    nothingNamed(campuses, r.sent);
    expect((await asked(campuses, "Is Main Campus 11am covered?")).question).toBe("Is [Service 1] covered?");
  });

  it("a watched service no check has read yet", async () => {
    const pending = watched(weekend(), [youthNight()], ["Evening Prayer Gathering"]);
    const r = await asked(pending, "Is Evening Prayer Gathering covered?");
    expect(r.refusal).toBe(REFUSALS.serviceUnread);
    expect(r.sent).toEqual([]);
  });

  it("a task that still holds a watched service's name fails as egress before any model step (Harness.check)", async () => {
    const c = watched(weekend(), [youthNight()]);
    const sent: AgentStepRequest[] = [];
    const h = harness(c, sent);
    const task = (question: string): AgentTask => ({ id: TASK, kind: "ask", skill_id: "answer-from-what-was-read", question, workspace_id: "fictional", created_at: c.now });
    for (const q of ["Is Weekend Service covered?", "Is Youth Night covered?", "Is WeekendService covered?", "Is W\u0435ekend Service covered?"]) {
      expect(h.check(task(q)), q).toBe("egress");
      expect((await h.run(task(q))).code).toBe("egress");
    }
    expect(sent).toEqual([]);
    // Ordinary words and a name Ozzie doesn't watch go on to the loop's own checks.
    for (const q of ["is weekend service covered?", "Is Evening Service covered?"]) expect(h.check(task(q)), q).toBeNull();
  });
});

describe("native is told the watched services' names, and only while more than one is watched", () => {
  it("App hands askServices' names to remember_watched_services, which native registers; one service sends none", () => {
    const root = join(__dirname, "../../..");
    const app = readFileSync(join(root, "product/desktop/src/App.tsx"), "utf8");
    const main = readFileSync(join(root, "product/desktop/src-tauri/src/main.rs"), "utf8");
    expect(app).toMatch(/invoke\("remember_watched_services", \{ names: /u);
    expect(app).toMatch(/askedServices\?\.services\.map\(s => s\.name\) \?\? \[\]/u);
    expect(main).toMatch(/fn remember_watched_services\(session: tauri::State<'_, SessionNames>, names: Vec<String>\)/u);
    expect(main).toMatch(/generate_handler!\[\s*remember_watched_services,/u);
    // Told when the page starts and on every change, kept as told only once native took it, retried for each list (review A, L6).
    expect(app).toMatch(/const toldNative = useRef<string \| null>\(null\);/u);
    expect(app).toMatch(/if \(nativeTries\.current\.names !== watchedNames\) nativeTries\.current = \{ names: watchedNames, count: 0 \};/u);
    expect(app).toMatch(/\+\+nativeTries\.current\.count <= 3/u);
    expect(askServices({ brief: weekend().brief, name: WEEKEND }, [])).toBeUndefined();
    expect(askServices({ brief: weekend().brief, name: WEEKEND }, [], ["Youth Night"])?.services.map(s => [s.name, s.read, s.first ?? false])).toEqual([[WEEKEND, true, true], ["Youth Night", false, false]]);
    // The first service is marked, never taken from the list's order: with no name, no service is first (round 2, N3/N4).
    const y = youthNight(), q = quiet();
    expect(askServices({ brief: weekend().brief, name: null }, [{ plan_id: "1", brief: y.brief, name: YOUTH }, { plan_id: "2", brief: q.brief, name: "Quiet Hour" }])
      ?.services.some(s => s.first)).toBe(false);
  });
});

/** A brief with one more position (and, for a needs-people finding, one more finding) of `name` on another team. */
function withTeam(part: Part, name: string, team: string): Part {
  const b = part.brief, f = b.findings.find(x => x.kind === "needs-people" && x.position?.name === name);
  const position = b.positions.find(p => p.name === name) ?? { ...b.positions[0]!, name };
  return { ...part, brief: {
    ...b, positions: [...b.positions, { ...position, name, team_id: team }],
    findings: f ? [...b.findings, { ...f, id: `${f.id}-${team}`, key: `${f.key}-${team}`, position: { ...f.position!, team_id: team } }] : b.findings,
  } };
}

describe("the reviews' findings, each held", () => {
  it("review A M1: two-word parts of small words, times and possessives never name a service; those questions are as 0.5.6 sent them", async () => {
    for (const [key, c] of [
      ["park", watched(weekend(), [youthNight("Greeter", "Worship in the Park")])],
      ["cross", watched(weekend(), [youthNight("Greeter", "Stations of the Cross")])],
      ["nineeleven", watched(weekend("9:00 AM Service"), [youthNight("Greeter", "11:00 AM Service")])],
      ["eightten", watched(weekend("8:00 AM"), [youthNight("Greeter", "10:30 AM")])],
      ["children", watched(weekend(), [youthNight("Greeter", "Children's Church")])],
    ] as const) {
      for (const q of Object.keys(PINS_056[key]!)) {
        const now = await asked(c, q);
        expect(now.refusal, q).toBeNull();
        expect(now.question, q).not.toContain("[Service");
        expect(hash(now.sent), q).toBe(PINS_056[key]![q]);
      }
    }
  });

  it("review A L1: a plural or possessive on the name, and an apostrophe left out, still name it", async () => {
    const c = watched(weekend(), [youthNight()]);
    expect((await asked(c, "Are the Weekend Services covered?")).question).toBe("Are the [Service 1] covered?");
    expect((await asked(c, "Who could cover Greeter at Youth Nights?")).question).toBe("Who could cover [Role 1] at [Service 1]?");
    const breakfast = watched(weekend("Mens Breakfast"), [youthNight("Greeter", "Women's Breakfast")]);
    expect((await asked(breakfast, "Is Men's Breakfast covered?")).question).toBe("Is [Service 1] covered?");
  });

  it("review A L2: two services named alike are both watched: their name is labelled for both, and no chip names it", async () => {
    const c = watched(weekend("Sunday Service"), [youthNight("Greeter", "SUNDAY SERVICE")]);
    expect(c.chips[0]).toBe("Who could cover Greeter?");
    const r = await asked(c, "Is Sunday Service covered?");
    expect(r.question).toBe("Is [Service 1] covered?");
    nothingNamed(c, r.sent);
    const overview = results(r.sent.at(-1)!).find(e => e.tool === "sunday.overview")!;
    expect((overview.payload["findings"] as { kind: string }[]).filter(f => f.kind === "needs people")).toHaveLength(3);
  });

  it("review A L3: a service named for a weekday alone is never named in a chip", () => {
    expect(watched(weekend("Sunday"), [youthNight("Greeter", "Wednesday")]).chips[0]).toBe("Who could cover Greeter?");
  });

  it("review A L4: a kids-team question naming a service goes to the AI with its label, never answered here for another service", async () => {
    const base = watched(weekend(), [youthNight()]);
    const c = { ...base, data: { ...base.data, rules: { ...rules, kidsTeams: [{ team_id: TEAMS.nursery, min_confirmed: 2 }] } } };
    const sent: AgentStepRequest[] = [];
    const turn = await askOzzie(harness(c, sent), "Who could cover the nursery at Youth Night?", { skills });
    expect(sent.length).toBeGreaterThan(0);
    expect(sent[0]!.messages[1]!.content).toMatch(/^Who could cover the \[Role \d+\] at \[Service \d+\]\?$/u);
    expect(turn.state).toBe("answered");
    // Answered about Youth Night alone (the role's own service is said with it, as answers always say it): no Weekend
    // Service coverage, which the answer written here gave before.
    if (turn.state === "answered") {
      expect(turn.answer.body).toContain(`has no open need at ${YOUTH} in the last check.`);
      expect(turn.answer.body).not.toMatch(/still needs|Needs a decision/u);
    }
  });

  it("review A L5: a position keeps its words when a part of a service's name runs into it", async () => {
    const c = watched(withTeam(weekend(), "Night Host", "t-host"), [youthNight()]);
    const r = await asked(c, "Who could cover Youth Night Host?");
    expect(r.question).toMatch(/^Who could cover Youth \[Role \d+\]\?$/u);
  });

  it("review B F2: a room or follow-up whose name holds a service's name is labelled whole, as in 0.5.6", async () => {
    const base = watched(weekend(), [youthNight()]);
    const capture = { ...base.data.capture!, labels: { "room:9001": "Youth Night Prayer Chapel", "workflow:9002": "Weekend Service Connection Cards" } };
    const c = { ...base, data: { ...base.data, capture } };
    expect((await asked(c, "Is Youth Night Prayer Chapel booked twice?")).question).toBe("Is [Room 1] booked twice?");
    const r = await asked(c, "Who owns Weekend Service Connection Cards?");
    expect(r.question).toBe("Who owns [Workflow 1]?");
    expect(JSON.stringify(r.sent)).not.toMatch(/Prayer Chapel|Connection Cards/u);
  });

  it("automated review 1: a service's name inside a room's name that can't be labelled as typed is refused, never sent", async () => {
    const base = watched(weekend(), [youthNight()]);
    const capture = { ...base.data.capture!, labels: { "room:9001": "Café Youth Night", "room:9003": "Youth Night Prayer Chapel" } };
    const c = { ...base, data: { ...base.data, capture } };
    // The room's own name typed differently (no accent, a plural): the place can't be labelled, so the question can't be
    // sent without the room's or the service's words; refused before anything is sent.
    for (const q of ["Is Cafe Youth Night free?", "Are the Youth Night Prayer Chapels free?"]) {
      const prepared = harness(c, []).prepare(q);
      if (prepared.ok) expect(prepared.question, q).not.toMatch(/Youth Night|Cafe|Chapel/u);
      const r = await asked(c, q);
      expect(r.refusal, q).toBe(REFUSALS.apart);
      expect(r.sent).toEqual([]);
    }
    // As typed, the room is labelled whole; a service whose name holds a room's whole name is the service.
    expect((await asked(c, "Is Café Youth Night free?")).question).toBe("Is [Room 1] free?");
    const chapel = watched(weekend("Chapel Service"), [youthNight()]);
    const withRoom = { ...chapel, data: { ...chapel.data, capture: { ...chapel.data.capture!, labels: { "room:9004": "Chapel" } } } };
    expect((await asked(withRoom, "Is Chapel Service covered?")).question).toBe("Is [Service 1] covered?");
  });

  it("review B F3: an answer about one service says that service's own reads, never another's failures", async () => {
    const failing = youthNight();
    failing.brief = { ...failing.brief, sources: { ...failing.brief.sources, failed: [{ collection: "person_blockouts", outcome: "timeout" }, { collection: "person_schedules", outcome: "timeout" }] } };
    const c = watched(weekend(), [failing]);
    const r = await asked(c, "Is Weekend Service covered?");
    expect(r.shown[0]).toBe(`For ${WEEKEND}, 2 things need a decision and 2 are worth a look.`);
    const overview = results(r.sent.at(-1)!).find(e => e.tool === "sunday.overview")!;
    expect(overview.payload["reads_not_completed"]).toBe(0);
    expect((JSON.parse(r.sent.at(-1)!.messages.at(-1)!.content) as { completeness: string }).completeness).toBe("complete");
    // About the service whose reads failed, they are said.
    expect((await asked(c, "Is Youth Night covered?")).shown[0]).toMatch(/2 Planning Center reads didn't complete\./u);
  });

  it("review B F4: one service's two teams with the role's name are listed once, as without the service", async () => {
    const c = watched(withTeam(weekend(), "Greeter", "t-second-greeters"), [youthNight()]);
    const r = await asked(c, "Who could cover Greeter at Weekend Service?");
    expect(r.shown.filter(l => l.startsWith("On the team for"))).toEqual([`On the team for Greeter (${WEEKEND}), the check listed 5 people.`]);
    expect(r.shown.join("\n")).not.toContain(YOUTH);
  });

  it("review B F5: when Ozzie writes a scoped answer itself, nothing open is said for that service, never the whole check", async () => {
    const c = watched(weekend(), [youthNight(), quiet()]);
    const sent: AgentStepRequest[] = [];
    const h = harness(c, sent);
    const signal = new AbortController().signal;
    const overview = await h.tools.run("sunday.overview", {}, signal, "t", ["Quiet Hour"]);
    const outcome: TaskOutcome = { status: "failed", code: "fidelity", answer: null, evidence: [overview], events: [] };
    const own = await overviewAnswer(h, outcome, signal, ["Quiet Hour"]);
    expect(own!.answer.body).toContain("This check found nothing open at Quiet Hour that needs a decision.");
    expect(own!.answer.body).not.toContain(NOTHING_OPEN);
  });

  it("review B F7: what wasn't checked, for one service, is that service's own", async () => {
    const c = watched(weekend(), [youthNight()]);
    const h = harness(c, []);
    const env = await h.tools.run("sunday.not_checked", {}, new AbortController().signal, "t", [YOUTH]);
    const p = env.payload as Record<string, unknown>;
    expect(p["service"]).toBe(h.session.service(YOUTH));
    expect(p["reads"]).toBe(youthNight().brief.sources.reads);
    expect(p).not.toHaveProperty("rooms_follow_ups_groups");
  });
});

describe("the reviews' second and third rounds, each held", () => {
  it("A N1: a part two services share, capitalised as they write it, stands for both; in lower case it is ordinary words", async () => {
    const c = watched(weekend("Youth Night Worship"), [youthNight("Greeter", "Youth Night Prayer")]);
    const r = await asked(c, "Is Youth Night covered?");
    expect(r.question).toBe("Is [Service 1] and [Service 2] covered?");
    nothingNamed(c, r.sent);
    expect((await asked(c, "is youth night covered?")).question).toBe("is youth night covered?");
  });

  it("A N2: a part run together with its own capitals is that service's", async () => {
    expect((await asked(watched(weekend(), [youthNight()]), "Is YouthNight covered?")).question).toBe("Is [Service 1] covered?");
  });

  it("B N1: when one service's name holds another's whole name, the longer name typed is the longer service, alone", async () => {
    const c = watched(weekend("Youth Night"), [youthNight()]);
    const one = await asked(c, "Who could cover Greeter at Demo Youth Night?");
    expect(one.question).toBe("Who could cover [Role 1] at [Service 1]?");
    expect(one.h.session.target("[Service 1]")).toEqual({ kind: "service", name: YOUTH });
    const two = await asked(c, "Is Ozzie Demo Youth Night covered?");
    expect(two.question).toBe("Is [Service 1] covered?");
    expect(two.h.session.target("[Service 1]")).toEqual({ kind: "service", name: YOUTH });
    expect((await asked(c, "Is Youth Night covered?")).h.session.target("[Service 1]")).toEqual({ kind: "service", name: "Youth Night" });
  });

  it("A round 3: a place a position's name breaks is never relied on to hold a service's name; a place named like a service yields", async () => {
    const base = watched(withTeam(weekend("Weekend Greeter Service"), "Greeter", "t-host"), [youthNight()]);
    const c = { ...base, data: { ...base.data, capture: { ...base.data.capture!, labels: { "room:9006": "Weekend Greeter Service Hall", "workflow:9005": YOUTH } } } };
    const r = await asked(c, "Is Weekend Greeter Service Hall booked?");
    expect(r.refusal).toBe(REFUSALS.apart);
    expect(r.sent).toEqual([]);
    const same = await asked(c, `Is ${YOUTH} covered?`);
    expect(same.question).toBe("Is [Service 1] covered?");
  });

  it("A L2 and B N5: a name a read service shares with one not read yet is the read one's; a shared part stands for the read ones", async () => {
    const same = watched(weekend("Sunday Service"), [youthNight()], ["Sunday Service"]);
    const r = await asked(same, "Is Sunday Service covered?");
    expect(r.refusal).toBeNull();
    expect(r.question).toBe("Is [Service 1] covered?");
    const campuses = watched(weekend("Main Campus 9am"), [youthNight("Greeter", "Main Campus 11am")], ["Main Campus 5pm"]);
    const s2 = await asked(campuses, "who serves at the main campus this week?");
    expect(s2.question).toBe("who serves at the [Service 1] and [Service 2] this week?");
    expect([s2.h.session.target("[Service 1]"), s2.h.session.target("[Service 2]")].map(t => t?.kind === "service" ? t.name : null).sort()).toEqual(["Main Campus 11am", "Main Campus 9am"]);
  });

  it("B N2: an answer about one service has that service's own check time, never another's older one", async () => {
    const early = youthNight();
    const weekendPart = weekend();
    const before = new Date(Date.parse(weekendPart.brief.checked_at!) - 2 * 3600_000).toISOString();
    early.brief = { ...early.brief, checked_at: before };
    const c = watched(weekendPart, [early]);
    expect(c.data.brief!.checked_at).toBe(before);
    const r = await asked(c, "Is Weekend Service covered?");
    const env = JSON.parse(r.sent.at(-1)!.messages.at(-1)!.content) as { check_time: string; completeness: string };
    expect(Date.parse(env.check_time)).toBe(Date.parse(weekendPart.brief.checked_at!));
    expect(env.completeness).toBe("complete");
  });

  it("B N3: a note can be drafted for someone on one service's second team of the role, by the label the merged list gives", async () => {
    const part = withTeam(weekend(), "Greeter", "t-second-greeters");
    const greeters = part.brief.findings.find(f => f.kind === "needs-people" && f.position?.name === "Greeter")!.people!;
    const greeterIds = new Set(Object.values(greeters).flat().map(x => x.person_id));
    // Someone the check named who isn't on the first Greeter team: only on the second one.
    const other = { ...greeters.suggestions[0]!, person_id: Object.keys(part.capture.names).find(id => !greeterIds.has(id))! };
    part.brief = { ...part.brief, findings: part.brief.findings.map(f => f.position?.team_id === "t-second-greeters"
      ? { ...f, people: { suggestions: [other], conflicts: [], unverified: [], left_out: [] } } : f) };
    const c = watched(part, [youthNight()]);
    const h = harness(c, []);
    const signal = new AbortController().signal;
    h.session.role("Greeter");
    const help = await h.tools.run("sunday.who_could_help", { role: "[Role 1]" }, signal, "t", [WEEKEND]);
    const rows = (help.payload as { people: { role: string; person: string }[] }).people;
    const row = rows.find(x => h.session.target(x.person)?.kind === "person" && (h.session.target(x.person) as { id: string }).id === other.person_id)!;
    const note = await h.tools.run("drafts.prepare_note", { person: row.person, role: row.role }, signal, "t", [WEEKEND]);
    expect((note.payload as Record<string, unknown>)["status"]).toBe("draft only; nothing has been sent");
  });

  it("A L4: a service with no such need says the role plainly, never with another service's name", async () => {
    const base = watched(weekend(), [youthNight()]);
    const r = await asked(base, "Who could cover Nursery at Youth Night?");
    expect(r.shown[0]).toBe(`Nursery has no open need at ${YOUTH} in the last check.`);
  });
});
