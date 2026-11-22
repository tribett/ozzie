// A part of the check that couldn't be verified, in every answer Ozzie writes on this Mac (found in 0.5.7: Ask answered
// "Worth a look: Part of this check couldn't be verified: 0 Planning Center reads didn't complete." for a service whose
// every read completed and whose only gap was a Greeter tied to no service time). When the only reasons are facts about
// roles, Ask, a job's write-up, the spoken briefing and Thursday's brief say how many roles couldn't be checked and each
// plain reason, as the Services page does, the role named on this Mac; a read that really failed keeps its true count;
// and no count of none is said as a problem. All of it is written on this Mac from what the check already holds: every
// request a model receives is byte for byte what 0.5.7 sent (hashes recorded from 0.5.7's code, d6c36f32, with this
// very scripted model), and no role's or person's name is in any of them. Fixed fictional data, clocks pinned.
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => { throw new Error("NATIVE_CALL_FORBIDDEN"); }) }));
import { askOzzie, keptWriteup, shownAnswer } from "../src/harness-bridge.js";
import { askServices, mergedNames, mergeParts, teamServices } from "../src/services-merge.js";
import { sundayReadyLine } from "../src/sunday-ready.js";
import { buildSundayBrief, type SundayBrief } from "../../../core/src/sunday-brief.js";
import { buildSpokenBriefing } from "../../../core/src/spoken-briefing.js";
import { nov22Capture } from "../../../core/src/fictional-sunday.js";
import type { SundayCapture } from "../../../core/src/sunday-capture.js";
import { wednesdayCapture } from "../../../core/test/fixtures/service-days/wednesday.js";
import { bundledSkills } from "../../../core/src/harness/bundled-skills.js";
import { composeAnswer, composeFacts } from "../../../core/src/harness/compose.js";
import type { AgentStepReply, AgentStepRequest, ModelStep, ToolEnvelope } from "../../../core/src/harness/contract.js";
import { Harness } from "../../../core/src/harness/index.js";
import { HarnessSession } from "../../../core/src/harness/session.js";
import { HarnessTools, type HarnessData } from "../../../core/src/harness/tools.js";
import { TsLoop } from "../../../core/src/harness/ts-loop.js";
import { factsText } from "../../../core/mcp/render.js";
import { buildSystemBrief } from "../../../core/src/church-systems/brief.js";
import { systemHarnessCapture } from "../../../core/src/church-systems/harness.js";
import { SYSTEMS, type SystemCapture } from "../../../core/src/church-systems/types.js";
import { b1Capture, breezeCapture, NOW as SYSTEM_NOW } from "../../../core/test/church-systems/fixtures.js";

const skills = await bundledSkills();
const rules = { sundayLeads: [], checkInAfterSundaysInARow: 3 };
const WEEKEND = "Weekend Service", YOUTH = "Ozzie Demo Youth Night (fictional)";
const TASK = "00000000-0000-4000-8000-0000000000d1";

type Rel = { id: string; relationships: Record<string, { data: unknown }> };
const rows = (c: SundayCapture, collection: string) => c.reads.find(r => r.collection === collection)!.body!.data as Rel[];
/** A role with no service time in Planning Center: its scheduled person, and its needed position when given, tied to none. */
function untimed(c: SundayCapture, member: string, need: string | null): SundayCapture {
  rows(c, "team_members").find(m => m.id === member)!.relationships["times"] = { data: [] };
  if (need) rows(c, "needed_positions").find(n => n.id === need)!.relationships["time"] = { data: null };
  return c;
}
/** One read that really didn't complete: Drew's blockouts timed out. */
const failedRead = (c: SundayCapture): SundayCapture => ({ ...c, reads: c.reads.map(r => r.collection === "person_blockouts" && r.person_id === "515" ? { ...r, outcome: "timeout" as const } : r) });
interface Part { capture: SundayCapture; name: string; built?: SundayBrief }
const weekend = (c = nov22Capture()): Part => ({ capture: c, name: WEEKEND });
/** The second service: the fictional plan on a Wednesday, with teams of its own, and its Greeter tied to no service time. */
const youth = (): Part => {
  const own = JSON.parse(JSON.stringify(wednesdayCapture()).replace(/\b75933(5[024])\b/gu, "85933$1")) as SundayCapture;
  return { capture: untimed({ ...own, service_type_id: "1700", plan_id: "94000001" }, "401", "301"), name: YOUTH };
};
const brief = (p: Part) => p.built ?? buildSundayBrief(p.capture, rules, p.capture.completed_at);
/** The second service with a gap of its own that isn't about roles, every read of it complete. */
const SCOPE_REASON = "Part of what Planning Center sent was missing, repeated or out of date, so Ozzie didn't rely on it.";
const youthScopeGap = (): Part => {
  const p = youth(), b = brief(p);
  return { ...p, built: { ...b, findings: b.findings.map(f => f.kind === "worth-a-look" ? { id: f.id, key: f.key, kind: f.kind, tone: f.tone, why: [SCOPE_REASON] } : f) } };
};

interface Case { data: HarnessData; now: string }
/** Ask's data as App builds it: the first service's check with the others joined in, and each team's and finding's service. */
function watched(main: Part, others: Part[] = []): Case {
  const now = main.capture.completed_at;
  const base = { operations: null, rules, attention: null, granted: ["services"], mode: "live", connected: true } as const;
  const mainBrief = brief(main), otherBriefs = others.map(brief);
  const asked = askServices({ brief: mainBrief, name: main.name }, others.map((o, i) => ({ plan_id: o.capture.plan_id, brief: otherBriefs[i]!, name: o.name })));
  if (!others.length) return { data: { ...base, capture: main.capture, brief: mainBrief, decisions: [], ...asked }, now };
  const m = mergeParts({ brief: mainBrief, decisions: [] }, others.map((o, i) => ({ plan_id: o.capture.plan_id, brief: otherBriefs[i]!, decisions: [] })));
  const serviceOfTeam = teamServices({ brief: mainBrief, name: main.name }, others.map((o, i) => ({ brief: otherBriefs[i]!, name: o.name })))!;
  return { data: { ...base, capture: mergedNames(main.capture, others.map(o => o.capture)), brief: m.brief, decisions: m.decisions, serviceOfTeam, ...asked }, now };
}
/** A church on B1 Church or Breeze, as App builds Ask's data for it. */
function system(capture: SystemCapture): Case {
  const built = buildSystemBrief(capture, { confirmedZone: capture.church.time_zone }, SYSTEM_NOW);
  if (!built.ok) throw new Error(built.reason);
  return { now: SYSTEM_NOW, data: { capture: systemHarnessCapture(capture, false), brief: built.brief, operations: null, decisions: [], rules,
    attention: null, granted: ["services"], mode: "live", connected: false, source: SYSTEMS[capture.system].name } };
}
/** B1 Church didn't give Guitar's number; the rest is whole. */
const b1Partial = () => b1Capture({ positions: b1Capture().positions.map(p => p.id === "POS-guitar" ? { ...p, needed: null } : p) });
/** Breeze shares a number for Usher and none for Teacher; both answers were read. */
const breezePartial = () => breezeCapture({ positions: [{ id: "9627", team_id: null, needed: null }, { id: "9628", team_id: null, needed: 1 }],
  assignments: [{ id: "71001", position_id: "9627", person_id: "157801", status: "accepted", asked: null }, { id: "71002", position_id: "9628", person_id: "157802", status: "unconfirmed", asked: null }] });
const LATE = "2026-11-20T18:00:00Z";
/** One service read more than 30 minutes ago: out of date, every read complete. `refresh`: what a fresh check gives. */
function late(refresh?: () => HarnessData): Case {
  const c = watched(weekend());
  const data: HarnessData = { ...c.data, brief: buildSundayBrief(nov22Capture(), rules, LATE) };
  return { now: LATE, data: refresh ? { ...data, refresh: async () => refresh() } : data };
}

const call = (step: number, name: string): AgentStepReply => ({ content: "", tool_calls: [{ id: `call_${step}_0`, name, arguments: "{}" }], finish: "tool_calls" });
const reply = (o: unknown): AgentStepReply => ({ content: JSON.stringify(o), tool_calls: [], finish: "stop" });
const results = (r: AgentStepRequest) => r.messages.flatMap(m => m.role === "tool" ? [JSON.parse(m.content) as { tool: string; payload: Record<string, unknown> }] : []);
/** A scripted model (the one 0.5.7's hashes were recorded with): the overview, or what wasn't checked, then every fact it gave. */
function scripted(sent: AgentStepRequest[], tool = "sunday.overview"): ModelStep {
  return async r => {
    sent.push(r);
    const got = results(r);
    if (!got.length) return call(sent.length, tool);
    const p = got[0]!.payload;
    return reply({ answer: "facts", facts: [p["fact"], ...(Array.isArray(p["findings"]) ? (p["findings"] as { fact: string }[]).map(f => f.fact) : [])] });
  };
}
const hash = (sent: readonly AgentStepRequest[]) => createHash("sha256").update(JSON.stringify(sent)).digest("hex");
const harness = (c: Case, sent: AgentStepRequest[], tool?: string) =>
  new Harness({ workspace_id: "fictional", data: c.data, skills, runtime: new TsLoop(), model: scripted(sent, tool), now: () => c.now, newId: () => TASK, macZone: "America/New_York" });
/** One question as the Ask panel asks it: the paragraphs shown, and every request a model received. */
async function ask(c: Case, typed: string, tool?: string) {
  const sent: AgentStepRequest[] = [];
  const turn = await askOzzie(harness(c, sent, tool), typed, { skills });
  if (turn.state !== "answered") throw new Error(`${typed}: ${JSON.stringify(turn)}`);
  return { shown: turn.answer.body.split("\n\n"), body: turn.answer.body, sent };
}

/** "0 … didn't complete": any count of none said as reads that didn't finish. */
const NONE_FAILED = /(?<![\d,.])0 (?:[\w ]+ )?didn't complete/u;
/** No position's name and no person's name in anything a model received. */
function nothingNamed(c: Case, sent: readonly AgentStepRequest[]) {
  const all = JSON.stringify(sent);
  for (const p of c.data.brief!.positions) expect(all, p.name).not.toContain(p.name.trim());
  for (const name of Object.values(c.data.capture!.names)) for (const word of name.split(/\s+/u)) expect(all, word).not.toContain(word);
}

const GREETER = "Greeter isn't tied to a service time in Planning Center, so Ozzie can't tell when it serves. Set the role's time in Planning Center to have it checked. Ozzie couldn't tell from Planning Center who said yes for Greeter, or when they serve.";
const LYRICS = "Lyrics isn't tied to a service time in Planning Center, so Ozzie can't tell when it serves. Set the role's time in Planning Center to have it checked. Ozzie couldn't tell from Planning Center who said yes for Lyrics, or when they serve.";

// Recorded from 0.5.7's code (d6c36f32, before this change) with this scripted model: every request, hashed.
const PINS: Readonly<Record<string, string>> = {
  "two: What still needs a decision at Youth Night?": "13bc1b1169460f5afad8ac0e2951ddbefc756d13986e1adf86b24e37b7ce6dd6",
  "two: What still needs a decision?": "6215d451337a04cf46c6bb47eb7e8fb81c38498ba476264c3e9d24cd401c3381",
  "two: What wasn't checked?": "cbcca6eb0138218ee2d69cc7636937f24b925c44b93e307bc5f1adfd93d8b885",
  "failed: What still needs a decision?": "bf4619f0e4c40edbc3d3a821452e1a05576a58e4b15140a1219984f63c25857e",
  "failed-two: What still needs a decision?": "5396c4a54de68635f38563ee8c6f60a40ec4a72dc88677f6c8a8eb7901977cce",
  "one: What still needs a decision?": "d7059c1097b4ec4f6dd7e7eac80a7dbd47dad4fa2377ac0bfb0648722fd8c4d0",
  "b1: What still needs a decision?": "2d6bc7ef290e2305523096c8f054488f1b51bb09c50be5ecbcd859a75cddc643",
  "breeze: Is anything worth a look?": "414ea0952f1ebd092c41613dd5f1184afb37e55839c1960add5cad9538ec13ac",
  "stale: What still needs a decision?": "6985f405388e1e871e55388584a46e851ddcc59d8f79e2b3fa1b51f56ed091c1",
};
const CASES: Readonly<Record<string, () => Case>> = {
  two: () => watched(weekend(), [youth()]), failed: () => watched(weekend(failedRead(nov22Capture()))),
  "failed-two": () => watched(weekend(failedRead(nov22Capture())), [youth()]), one: () => watched(weekend(untimed(nov22Capture(), "403", null))),
  b1: () => system(b1Partial()), breeze: () => system(breezePartial()), stale: () => late(),
};

describe("A part of the check that couldn't be verified, in Ask's answers", () => {
  it("two services, the second's Greeter tied to no service time and every read complete: how many roles, and why, never a read that failed", async () => {
    const scoped = await ask(CASES["two"]!(), "What still needs a decision at Youth Night?");
    expect(scoped.shown[0]).toBe("For Ozzie Demo Youth Night (fictional), 2 things need a decision and 3 are worth a look.");
    // 0.5.7: "Part of this check couldn't be verified: 0 Planning Center reads didn't complete."
    expect(scoped.shown).toContain(`One role couldn't be checked. ${GREETER}`);
    // The whole check: which service it is at, since the overview names none.
    const whole = await ask(CASES["two"]!(), "What still needs a decision?");
    expect(whole.shown).toContain(`At Ozzie Demo Youth Night (fictional), one role couldn't be checked. ${GREETER}`);
    for (const r of [scoped, whole]) {
      expect(r.body).not.toContain("0 Planning Center reads didn't complete");
      expect(r.body).not.toMatch(NONE_FAILED);
      expect(r.body).not.toContain("Part of this check couldn't be verified");
    }
    // What wasn't checked still says every read completed.
    expect((await ask(CASES["two"]!(), "What wasn't checked?", "sunday.not_checked")).shown[0]).toMatch(/^All 52 Planning Center reads completed\. /u);
  });

  it("a read that really didn't complete keeps its true count; beside a role's facts in another service, each is said for what it is", async () => {
    const one = await ask(CASES["failed"]!(), "What still needs a decision?");
    expect(one.shown[0]).toBe("For Sunday, November 22, 2 things need a decision and 3 are worth a look. 1 Planning Center read didn't complete.");
    expect(one.shown).toContain("Part of this check couldn't be verified: 1 Planning Center read didn't complete.");
    // 0.5.7 said the count once for both services' rows, the second a repeat of the first.
    const two = await ask(CASES["failed-two"]!(), "What still needs a decision?");
    expect(two.shown).toContain("Part of this check couldn't be verified: 1 Planning Center read didn't complete.");
    expect(two.shown).toContain(`At Ozzie Demo Youth Night (fictional), one role couldn't be checked. ${GREETER}`);
  });

  it("one service with a role tied to no time: the same words, with no service named", async () => {
    const r = await ask(CASES["one"]!(), "What still needs a decision?");
    expect(r.shown).toContain(`One role couldn't be checked. ${LYRICS}`);
    expect(r.body).not.toMatch(NONE_FAILED);
  });

  it("B1 Church and Breeze: each system's own reason, in its own name", async () => {
    const b1 = await ask(CASES["b1"]!(), "What still needs a decision?");
    expect(b1.shown).toContain("One role couldn't be checked. B1 Church didn't share how many people Guitar needs, so Ozzie can't say whether it is full.");
    const breeze = await ask(CASES["breeze"]!(), "Is anything worth a look?");
    expect(breeze.shown).toContain("One role couldn't be checked. Breeze didn't share how many people Teacher needs, so Ozzie can't say whether it is full.");
    for (const r of [b1, breeze]) {
      expect(r.body).not.toMatch(NONE_FAILED);
      expect(r.body).not.toMatch(/Planning Center/u);
    }
  });

  it("out of date with every read complete: says that, never a count of none", async () => {
    const r = await ask(CASES["stale"]!(), "What still needs a decision?");
    // 0.5.7: "…: 0 Planning Center reads didn't complete. The check is also too old to treat as current."
    expect(r.shown).toContain("Part of this check couldn't be verified: the check is too old to treat as current.");
    expect(r.body).not.toMatch(NONE_FAILED);
  });

  it("every request is byte for byte what 0.5.7 sent, and names no role and no person", async () => {
    for (const [key, pin] of Object.entries(PINS)) {
      const [name, question] = key.split(": ") as [string, string];
      const c = CASES[name]!();
      const r = await ask(c, question, question === "What wasn't checked?" ? "sunday.not_checked" : undefined);
      expect(hash(r.sent), key).toBe(pin);
      nothingNamed(c, r.sent);
    }
  });

  it("an answer keeps the reasons of the check it read, never a later check's or another service's", async () => {
    // One service: Lyrics was the role tied to no time when the AI read the overview; a later check finds Greeter instead.
    const c = CASES["one"]!();
    const h = harness(c, []);
    const res = await h.ask("What still needs a decision?");
    if (!res.ok) throw new Error(res.refusal);
    const later = watched(weekend(untimed(nov22Capture(), "401", "301")));
    h.update({ ...later.data, brief: { ...later.data.brief!, checked_at: "2026-11-20T15:05:00Z" } as SundayBrief });
    const body = shownAnswer(h, res.outcome, undefined, "").body;
    expect(body).toContain(`One role couldn't be checked. ${LYRICS}`);
    expect(body).not.toContain("Greeter isn't tied");
    // Two services: the second is checked again (its Nursery now tied to no time); the answer is still about its Greeter.
    const two = CASES["two"]!();
    const h2 = harness(two, []);
    const res2 = await h2.ask("What still needs a decision?");
    if (!res2.ok) throw new Error(res2.refusal);
    const nursery = (): Part => { const p = youth(); return { ...p, capture: untimed(JSON.parse(JSON.stringify(wednesdayCapture()).replace(/\b75933(5[024])\b/gu, "85933$1")) as SundayCapture, "402", "302") }; };
    h2.update(watched(weekend(), [{ ...nursery(), capture: { ...nursery().capture, service_type_id: "1700", plan_id: "94000001" } }]).data);
    expect(shownAnswer(h2, res2.outcome, undefined, "").body).toContain(`At Ozzie Demo Youth Night (fictional), one role couldn't be checked. ${GREETER}`);
    // A result this Mac didn't give out here (another session): only that part couldn't be verified, never a count of none.
    const elsewhere = harness(c, []);
    const composed = composeAnswer(res.outcome.answer!, res.outcome.evidence, c.data.brief!.day ?? null, elsewhere.tools);
    const shown = composed.paragraphs.map(p => composed.fill(elsewhere.restore(p)));
    expect(shown).toContain("Part of this check couldn't be verified.");
    expect(shown.join("\n")).not.toMatch(NONE_FAILED);
  });

  it("two services, one with a read that didn't complete and one with a gap that isn't about roles: each row says its own", async () => {
    const r = await ask(watched(weekend(failedRead(nov22Capture())), [youthScopeGap()]), "What still needs a decision?");
    expect(r.shown).toContain("Part of this check couldn't be verified: 1 Planning Center read didn't complete.");
    // 0.5.7 gave this row the other service's count, then left it out as a repeat.
    expect(r.shown).toContain(`At Ozzie Demo Youth Night (fictional), part of this check couldn't be verified. ${SCOPE_REASON}`);
  });

  it("a question naming both services: the row still says which service it is at", async () => {
    const r = await ask(CASES["two"]!(), "What still needs a decision at Weekend Service and Youth Night?");
    // Sent with both services' labels, so the overview is for both (scoped), not the whole check.
    expect(r.sent[0]!.messages[1]!.content).toMatch(/\[Service \d+\] and \[Service \d+\]/u);
    expect(r.shown).toContain(`At Ozzie Demo Youth Night (fictional), one role couldn't be checked. ${GREETER}`);
    expect(r.body).not.toMatch(NONE_FAILED);
  });
});

describe("A part of the check that couldn't be verified, elsewhere on this Mac and in the copy for other AI apps", () => {
  it("a job's write-up (kept on this Mac) says the role and why", async () => {
    const h = harness(CASES["two"]!(), []);
    const res = await h.ask("What still needs a decision at Youth Night?");
    if (!res.ok) throw new Error(res.refusal);
    const lines = keptWriteup(h, res.outcome).lines;
    expect(lines).toContain(`One role couldn't be checked. ${GREETER}`);
    expect(lines.join("\n")).not.toMatch(NONE_FAILED);
    expect(lines.join("\n")).not.toMatch(/\[Kept part \d+\]/u);
  });

  it("the copy for other AI apps says only what its result holds: no role's name, and no count of none", async () => {
    const h = harness(CASES["two"]!(), []);
    const res = await h.ask("What still needs a decision at Youth Night?");
    if (!res.ok) throw new Error(res.refusal);
    const overview = res.outcome.evidence.find((e: ToolEnvelope) => e.tool === "sunday.overview")!;
    const copy = factsText(overview);
    expect(copy).toContain("Part of this check couldn't be verified.");
    expect(copy.join("\n")).not.toMatch(NONE_FAILED);
    expect(copy.join("\n")).not.toMatch(/Greeter|Kept part/u);
  });

  it("the spoken briefing and Thursday's brief say how many roles and each reason, for Planning Center and Breeze", () => {
    const youthBrief = brief(youth());
    const look = youthBrief.findings.find(f => f.kind === "worth-a-look")!;
    expect(buildSpokenBriefing({ attention: null, sunday: youthBrief }, { timeZone: "America/New_York" }).text)
      .toContain(`One role couldn't be checked, so Ozzie won't call Wednesday covered. ${GREETER}`);
    expect(sundayReadyLine(look, {})).toBe(`One role couldn't be checked, so it isn't a full picture. ${GREETER}`);
    const breeze = system(breezePartial()).data.brief!;
    const said = "Breeze didn't share how many people Teacher needs, so Ozzie can't say whether it is full.";
    expect(buildSpokenBriefing({ attention: null, sunday: breeze }, { timeZone: "America/New_York" }).text)
      .toContain(`One role couldn't be checked, so Ozzie won't call Sunday covered. ${said}`);
    expect(sundayReadyLine(breeze.findings.find(f => f.kind === "worth-a-look")!, {})).toBe(`One role couldn't be checked, so it isn't a full picture. ${said}`);
  });

  it("the spoken briefing with many roles tied to no time points to the screen, and stays within two minutes and the voice's limit", () => {
    const youthBrief = brief(youth());
    const reasons = Array.from({ length: 12 }, (_, i) => [`Role ${i + 1} isn't tied to a service time in Planning Center, so Ozzie can't tell when it serves. Set the role's time in Planning Center to have it checked.`,
      `Ozzie couldn't tell from Planning Center who said yes for Role ${i + 1}, or when they serve.`]).flat();
    const many: SundayBrief = { ...youthBrief, findings: youthBrief.findings.map(f => f.kind === "worth-a-look" ? { ...f, role_facts: { roles: 12, reasons } } : f) };
    const spoken = buildSpokenBriefing({ attention: null, sunday: many }, { timeZone: "America/New_York" });
    expect(spoken.text).toContain("12 roles couldn't be checked, so Ozzie won't call Wednesday covered. The roles and why are listed on screen.");
    expect(spoken.text).not.toContain("Role 1 isn't tied");
    expect(spoken.text.length).toBeLessThan(3800);
    expect(spoken.seconds).toBeLessThanOrEqual(120);
    // The decisions are all still read.
    expect(spoken.sections.find(x => x.id === "decisions")!.sentences).toEqual(buildSpokenBriefing({ attention: null, sunday: youthBrief }, { timeZone: "America/New_York" })
      .sections.find(x => x.id === "decisions")!.sentences);
  });

  it("checking Planning Center again: every read completed is said as that, never \"0 didn't complete\"; a read that didn't keeps its count", async () => {
    const again = async (fresh: () => HarnessData) => {
      const c = late(fresh);
      const tools = new HarnessTools(c.data, new HarnessSession(), { now: () => c.now });
      const e = await tools.run("planning_center.refresh", {}, new AbortController().signal);
      return composeFacts([(e.payload as { fact: string }).fact], [e]);
    };
    // 0.5.7: "Ozzie checked Planning Center again: 26 reads, 0 didn't complete."
    expect(await again(() => watched(weekend()).data)).toEqual(["Ozzie checked Planning Center again: all 26 reads completed."]);
    expect(await again(() => watched(weekend(failedRead(nov22Capture()))).data)).toEqual(["Ozzie checked Planning Center again: 26 reads, 1 didn't complete."]);
  });
});
