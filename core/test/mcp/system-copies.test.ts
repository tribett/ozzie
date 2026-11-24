// A church on B1 Church or Breeze in the copies for other AI apps and for Siri and Shortcuts (0.10.0): the same tools over
// the system's own check, the system part the copy carries (snapshot.ts), what the server and Siri say from it, word for
// word for a typical service on each system, Breeze never called covered where it gave no number of people needed, no
// name or role, team or church name anywhere, a copy never read as another system's, and Genesis's fixed line. Fictional
// captures only (core/test/church-systems/fixtures.ts, core/src/church-systems/fictional.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasContactDetail } from "../../src/ask.js";
import { bundledSkills } from "../../src/harness/bundled-skills.js";
import type { Skill, ToolEnvelope } from "../../src/harness/contract.js";
import { namedIn } from "../../src/harness/names.js";
import { composeFacts } from "../../src/harness/compose.js";
import { envelopeProblems } from "../../src/harness/fixed.js";
import { harnessData } from "../harness/fixtures.js";
import { HarnessSession } from "../../src/harness/session.js";
import { HarnessTools, type HarnessData } from "../../src/harness/tools.js";
import { buildSystemBrief } from "../../src/church-systems/brief.js";
import { fictionalB1, fictionalBreeze } from "../../src/church-systems/fictional.js";
import { systemHarnessCapture } from "../../src/church-systems/harness.js";
import { SYSTEMS, type SystemCapture } from "../../src/church-systems/types.js";
import { McpServer, INSTRUCTIONS, TOOLS, type Response } from "../../mcp/server.js";
import { checkText, happenedText, NOT_SHARED, rulesText } from "../../mcp/render.js";
import {
  parseSharedCheck, ROLE_NUMBERS, roleNumbersOf, SHARED_SYSTEMS, SHARED_TOOLS, sharedCheckText, sharedEnvelopes, sourcesFit, systemOf, type SharedSystem,
  type SharedTask,
} from "../../mcp/snapshot.js";
import { GENESIS, GENESIS_COPY, KIDS_UNITS, NO_CHECK, shortcutsAnswer, shortcutsEnvelopes } from "../../mcp/shortcuts.js";
import { b1Capture, b1KidsCapture, breezeCapture, breezeKidsCapture, breezeUntimedCapture, NOW } from "../church-systems/fixtures.js";
import { KIDS_UNIT, kidsMarked, withSystemKids } from "../../src/church-systems/kids.js";
import type { SundayRules } from "../../src/sunday-capture.js";

const skills: ReadonlyMap<string, Skill> = await bundledSkills();
const COPY = "B4K7Q2X9M3T8";
const CT = "America/Chicago";
// The reader decides "out of date" from this Mac's clock: pinned to the copy's own save time.
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(NOW)); });
afterEach(() => { vi.useRealTimers(); });

const RULES: SundayRules = { sundayLeads: [], checkInAfterSundaysInARow: 3 };
/** Ask's data for a church on another system, as App builds it (App.tsx `harnessData`), with its kids marks when it has some. */
function dataFor(capture: SystemCapture, fictional = false, rules: SundayRules = RULES): HarnessData {
  const built = buildSystemBrief(capture, { confirmedZone: capture.church.time_zone, ...(rules.systemKids ? { systemKids: rules.systemKids } : {}) }, NOW, { fictional });
  if (!built.ok) throw new Error(built.reason);
  const kids = fictional ? [] : kidsMarked(capture, rules);
  return { capture: systemHarnessCapture(capture, false), brief: built.brief, operations: null, decisions: [], rules, attention: null,
    granted: ["services"], mode: fictional ? "fictional" : "live", connected: false, source: SYSTEMS[capture.system].name, ...(kids.length ? { kids } : {}) };
}
/** As the desktop app works it out (App.tsx, snapshot.ts roleNumbersOf). */
const systemFor = (c: SystemCapture): SharedSystem => ({ id: c.system as SharedSystem["id"], role_numbers: roleNumbersOf(c.positions) });
const TASKS: SharedTask[] = [
  { kind: "check", skill_id: "sunday-ready", state: "verified", created_at: "2026-11-20T15:00:00Z", updated_at: "2026-11-20T15:00:04Z", failure: null,
    events: [{ type: "admitted", detail: "", at: "2026-11-20T15:00:00Z" }, { type: "tool", detail: "complete", at: "2026-11-20T15:00:02Z" }] },
  { kind: "check", skill_id: "sunday-ready", state: "failed", created_at: "2026-11-20T14:00:00Z", updated_at: "2026-11-20T14:00:09Z", failure: "provider-failure",
    events: [{ type: "failed", detail: "provider-failure", at: "2026-11-20T14:00:09Z" }] },
  // From before the church switched: it read Planning Center, and says so.
  { kind: "check", skill_id: "sunday-ready", state: "verified", created_at: "2026-11-19T15:00:00Z", updated_at: "2026-11-19T15:00:04Z", failure: null,
    events: [{ type: "tool", detail: "planning_center.refresh complete", at: "2026-11-19T15:00:02Z" }] },
];
/** Both copies for a church's check: the one for other AI apps (with task rows) and the one for Siri and Shortcuts. */
async function copiesOf(capture: SystemCapture, fictional = false, rules: SundayRules = RULES) {
  const envelopes = await sharedEnvelopes(new HarnessTools(dataFor(capture, fictional, rules), new HarnessSession(), { now: () => NOW }));
  const system = systemFor(capture);
  return {
    envelopes, system,
    shared: sharedCheckText(envelopes, TASKS, NOW, COPY, system),
    siri: sharedCheckText(shortcutsEnvelopes(envelopes), [], NOW, COPY, system),
  };
}
const textOf = (r: Response | null): string => r && "result" in r ? JSON.stringify(r.result) : JSON.stringify(r);
const served = (text: string | null) => {
  const server = new McpServer({ read: () => text, skills });
  return [server.handle({ jsonrpc: "2.0", id: 1, method: "initialize" }), ...TOOLS.map(t => server.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: t.name, arguments: {} } }))]
    .map(textOf).join("\n");
};
const ask = (text: string | null, at: string, timeZone = CT) => shortcutsAnswer("sunday", { on: true, text, nowMs: Date.parse(at), timeZone });
/** Every name and free text the check holds: people, roles, teams, the church and the service. */
const secrets = (c: SystemCapture) => [...Object.values(c.names), ...Object.values(c.labels)].filter(s => s.trim().length >= 3);
/** A Breeze church whose event gives a number for the teacher only. */
const breezeSome = () => breezeCapture({ positions: [{ id: "9627", team_id: null, needed: 2 }, { id: "9628", team_id: null, needed: null }] });

const CASES: [string, () => SystemCapture, boolean][] = [
  ["B1 Church", b1Capture, false],
  ["Breeze, no number for any role", breezeUntimedCapture, false],
  ["Breeze, a number for some roles", breezeSome, false],
  ["Breeze, answers it couldn't read", breezeCapture, false],
  ["B1 Church's example", fictionalB1, true],
  ["Breeze's example", fictionalBreeze, true],
];

describe("what a church on another system's copies hold", () => {
  it.each(CASES)("%s: labels only, every result its system's own, and the server and Siri never say a name", async (_label, capture, fictional) => {
    const c = capture();
    const { envelopes, shared, siri, system } = await copiesOf(c, fictional);
    const name = SHARED_SYSTEMS[system.id];
    // The same tools as Ask, as Ask is offered them there: no check-ins (host.ts), no rooms, follow-ups or group meetings.
    expect(envelopes.map(e => e.tool)).toEqual(SHARED_TOOLS.filter(t => !["sunday.rule_checkins", "rooms.conflicts", "followups.unowned", "groups.clashes"].includes(t)));
    for (const e of envelopes) expect([name, "Church rules on this Mac"]).toContain(e.source);
    const check = parseSharedCheck(shared)!;
    expect(check).not.toBeNull();
    expect(systemOf(check)).toEqual(system);
    expect(parseSharedCheck(siri)).not.toBeNull();
    const words = [shared, siri, served(shared), ask(siri, "2026-11-20T15:12:00Z"), ask(siri, "2026-11-20T18:00:00Z")].join("\n");
    for (const s of secrets(c)) expect(words.includes(s), `${s} in ${words.slice(Math.max(0, words.indexOf(s) - 80), words.indexOf(s) + 40)}`).toBe(false);
    // Every part of every name, but the invented surname the examples share with Ozzie's own word for them ("fictional").
    expect(namedIn(words, Object.fromEntries(Object.entries(c.names).map(([id, n]) => [id, n.replace(/ Fictional$/u, "")])), "strict")).toBe(false);
    expect(hasContactDetail(words)).toBe(false);
    // Never Planning Center's own words about where the facts are.
    expect(served(shared)).not.toMatch(/check Planning Center again|changes Planning Center\.|Checked in Planning Center/u);
    expect(ask(siri, "2026-11-20T15:12:00Z")).not.toContain("Planning Center");
  });

  it("puts the system part straight after the format, both keys or neither", async () => {
    const { shared } = await copiesOf(b1Capture());
    expect(shared.startsWith('{"format":"ozzie-shared-check-2","system":"b1","role_numbers":"all","copy_id":"B4K7Q2X9M3T8",')).toBe(true);
    // A reader before 0.10.0 took exactly these keys, so it refuses a system's copy whole (and says nothing is shared).
    const keys = Object.keys(JSON.parse(shared) as object);
    expect(keys).toEqual(["format", "system", "role_numbers", "copy_id", "checked_at", "shared_at", "envelopes", "tasks"]);
    expect(keys.filter(k => !["format", "copy_id", "checked_at", "shared_at", "envelopes", "tasks"].includes(k))).toEqual(["system", "role_numbers"]);
    expect(ROLE_NUMBERS).toEqual(["all", "some", "none"]);
  });
});

describe("a copy is never read as another system's", () => {
  const swap = (text: string, edit: (v: Record<string, unknown>) => void) => { const v = JSON.parse(text) as Record<string, unknown>; edit(v); return JSON.stringify(v); };
  it("refuses a system part that is missing half, unknown, or doesn't match its results", async () => {
    const { shared } = await copiesOf(b1Capture());
    const { shared: breeze } = await copiesOf(breezeUntimedCapture());
    const cases: [string, string][] = [
      ["no role numbers", swap(shared, v => { delete v["role_numbers"]; })],
      ["role numbers with no system", swap(shared, v => { delete v["system"]; })],
      ["no system part on B1 Church's results", swap(shared, v => { delete v["system"]; delete v["role_numbers"]; })],
      ["Genesis", swap(shared, v => { v["system"] = "genesis"; })],
      ["Planning Center", swap(shared, v => { v["system"] = "planning-center"; })],
      ["a system's name for its id", swap(shared, v => { v["system"] = "B1 Church"; })],
      ["B1 Church's results as Breeze's", swap(shared, v => { v["system"] = "breeze"; })],
      ["Breeze's results as B1 Church's", swap(breeze, v => { v["system"] = "b1"; })],
      ["role numbers outside the closed words", swap(shared, v => { v["role_numbers"] = "most"; })],
      // As native checks (shared_check.rs numbers_fit): a counted role's number means not "none", "not known" not "all".
      ["none, beside roles counted with B1 Church's numbers", swap(shared, v => { v["role_numbers"] = "none"; })],
      ["all, beside a role counted with no number", swap(shared, v => {
        const overview = (v["envelopes"] as { tool: string; payload: { findings: Record<string, unknown>[] } }[]).find(e => e.tool === "sunday.overview")!;
        overview.payload.findings.find(f => f["kind"] === "needs people")!["remaining"] = "not known";
      })],
      ["another key beside them", swap(shared, v => { v["church"] = "x"; })],
    ];
    for (const [label, text] of cases) {
      expect(parseSharedCheck(text), label).toBeNull();
      expect(served(text), label).toContain(JSON.stringify(NOT_SHARED).slice(1, -1));
    }
  });

  it("a Planning Center copy holds no other system's results, and a system's holds a result of its own", () => {
    const envelope = (source: string) => ({ source }) as Pick<ToolEnvelope, "source">;
    expect(sourcesFit([envelope("Planning Center Services"), envelope("Church rules on this Mac")], null)).toBe(true);
    for (const other of ["B1 Church", "Breeze", "Genesis"]) expect(sourcesFit([envelope(other)], null), other).toBe(false);
    expect(sourcesFit([envelope("B1 Church"), envelope("Church rules on this Mac")], "b1")).toBe(true);
    expect(sourcesFit([envelope("Church rules on this Mac")], "b1")).toBe(false);
    expect(sourcesFit([envelope("B1 Church"), envelope("Planning Center Services")], "b1")).toBe(false);
    expect(sourcesFit([envelope("Breeze")], "b1")).toBe(false);
  });
});

describe("what Siri and Shortcuts say, word for word", () => {
  it("B1 Church: open spots, who is pending and a request B1 Church says wasn't sent, checked in B1 Church", async () => {
    const { siri } = await copiesOf(b1Capture());
    expect(ask(siri, "2026-11-20T15:12:00Z")).toBe("Sunday, November 22 has 3 open spots across 3 roles. 1 person is pending, and B1 Church shows the request hasn't been sent yet. Checked in B1 Church today at 9:00 AM.");
    expect(ask(siri, "2026-11-20T18:00:00Z")).toBe("When Ozzie last checked, Sunday, November 22 had 3 open spots across 3 roles. 1 person was pending, and B1 Church showed the request hadn't been sent yet. Checked in B1 Church today at 9:00 AM. Things may have changed since then; open Ozzie to see the latest.");
    expect(ask(siri, "2026-11-24T12:00:00Z")).toBe("Ozzie's last check was for Sunday, November 22, which has passed. Checked in B1 Church on Friday, November 20 at 9:00 AM. Open Ozzie to check the next Sunday.");
  });

  it("Breeze with no number for any role: never covered, never \"no roles\"; who is pending, without saying a request was sent", async () => {
    const { siri } = await copiesOf(breezeUntimedCapture());
    const now = ask(siri, "2026-11-20T15:12:00Z");
    expect(now).toBe("Breeze doesn't share how many people each role needs, so Ozzie can't say whether Sunday, November 22 is covered. 1 person is pending. Checked in Breeze today at 9:00 AM.");
    expect(ask(siri, "2026-11-20T18:00:00Z")).toBe("When Ozzie last checked, Breeze didn't share how many people each role needed, so Ozzie couldn't say whether Sunday, November 22 was covered. 1 person was pending. Checked in Breeze today at 9:00 AM. Things may have changed since then; open Ozzie to see the latest.");
    for (const said of [now, ask(siri, "2026-11-20T18:00:00Z")]) expect(said).not.toMatch(/\bno roles?\b|\bnone of the roles\b|request (?:was|wasn't|hasn't been) sent|open spot/iu);
  });

  it("Breeze with a number for some roles: counts only those, and says the others can't be called full", async () => {
    const { siri } = await copiesOf(breezeSome());
    expect(ask(siri, "2026-11-20T15:12:00Z")).toBe("None of the roles Ozzie could count for Sunday, November 22 still need people. Breeze doesn't share how many people some roles need, so Ozzie can't say whether they are full. Worth a look: part of the check couldn't be verified, so this may be incomplete. Checked in Breeze today at 9:00 AM.");
  });

  it("Breeze with every number but answers it couldn't read: the count, and that part couldn't be verified", async () => {
    const { siri } = await copiesOf(breezeCapture());
    expect(ask(siri, "2026-11-20T15:12:00Z")).toBe("No roles for Sunday, November 22 still need people. Worth a look: part of the check couldn't be verified, so this may be incomplete. Checked in Breeze today at 9:00 AM.");
  });

  it("each system's example says it is one, naming no check of that system", async () => {
    expect(ask((await copiesOf(fictionalBreeze(), true)).siri, "2026-11-20T15:12:00Z")).toBe("This is Ozzie's fictional example, not a real church; no check of Breeze is behind it. Sunday, November 22 has 1 open spot across 1 role. 1 person is pending.");
    expect(ask((await copiesOf(fictionalB1(), true)).siri, "2026-11-20T15:12:00Z")).toMatch(/^This is Ozzie's fictional example, not a real church; no check of B1 Church is behind it\. /u);
  });

  it("a church on Genesis hears that Genesis shares no volunteer schedules; the fixed line is no check, and nothing else reads as it", () => {
    expect(ask(GENESIS_COPY, "2026-11-20T15:12:00Z")).toBe(GENESIS);
    expect(GENESIS).toBe("Genesis shares no volunteer schedules, so Ozzie checks no service there and can't say whether one is covered. Open Ozzie to see what Genesis shares.");
    expect(shortcutsAnswer("sunday", { on: false, text: GENESIS_COPY, nowMs: Date.parse(NOW), timeZone: CT })).not.toBe(GENESIS);
    expect(parseSharedCheck(GENESIS_COPY)).toBeNull();
    for (const near of [`${GENESIS_COPY} `, GENESIS_COPY.replace("genesis", "Genesis"), '{"system":"genesis","format":"ozzie-shared-check-2"}']) expect(ask(near, NOW)).toBe(NO_CHECK);
    // The copy for other AI apps never reads it as anything.
    expect(served(GENESIS_COPY)).toContain(JSON.stringify(NOT_SHARED).slice(1, -1));
  });
});

describe("what other AI apps read", () => {
  it("names the system where Planning Center's copy names Planning Center, from the handshake on", async () => {
    const { shared } = await copiesOf(b1Capture());
    const init = new McpServer({ read: () => shared, skills }).handle({ jsonrpc: "2.0", id: 1, method: "initialize" }) as { result: { instructions: string } };
    expect(init.result.instructions).toBe(INSTRUCTIONS.replace("check Planning Center again", "check B1 Church again"));
    const check = parseSharedCheck(shared)!;
    expect(checkText(check, ["sunday.overview"])).toContain("It can't check B1 Church again or change anything, and people decide what to do.");
    expect(checkText(check, ["sunday.overview"])).toContain("## Overview (from B1 Church, checked ");
    expect(checkText(check, ["rooms.conflicts", "followups.unowned", "groups.clashes"])).toMatch(/\n\nRooms, follow-ups and group meetings work with Planning Center only for now\. Ozzie can't do these with B1 Church yet\.$/u);
    expect(checkText(check, ["sunday.rule_checkins"])).toContain("Check-ins after several weeks in a row work with Planning Center only for now. Ozzie can't do these with B1 Church yet.");
    // No copy, or Planning Center's: the instructions as before.
    const none = new McpServer({ read: () => null, skills }).handle({ jsonrpc: "2.0", id: 1, method: "initialize" }) as { result: { instructions: string } };
    expect(none.result.instructions).toBe(INSTRUCTIONS);
  });

  it("Breeze with no number for any role: says so above what needs people, so nothing there reads as covered", async () => {
    const check = parseSharedCheck((await copiesOf(breezeUntimedCapture())).shared)!;
    const LIMIT = "Breeze doesn't share how many people each role needs, so Ozzie can't say whether a role is full.";
    for (const tool of ["sunday.overview", "sunday.open_needs"] as const) {
      const said = checkText(check, [tool]).split("\n");
      expect(said[said.findIndex(l => l.startsWith("## ")) + 1], tool).toBe(LIMIT);
    }
    // What it can't see in Breeze, as Ozzie's fixed sentences, where the check says what it couldn't cover.
    expect(checkText(check, ["sunday.not_checked"])).toContain("Ozzie can't read blockout dates from Breeze.");
    const some = parseSharedCheck((await copiesOf(breezeSome())).shared)!;
    expect(checkText(some, ["sunday.overview"])).toContain("Breeze doesn't share how many people some roles need, so Ozzie can't say whether they are full.");
    // B1 Church gave every number: no such line.
    expect(checkText(parseSharedCheck((await copiesOf(b1Capture())).shared)!, ["sunday.overview", "sunday.open_needs"])).not.toContain("doesn't share how many people");
  });

  it("lists only the procedures that work with the system, in its name; a check whose record names no Planning Center read names no system", async () => {
    const b1 = parseSharedCheck((await copiesOf(b1Capture())).shared)!;
    const breeze = parseSharedCheck((await copiesOf(breezeUntimedCapture())).shared)!;
    const listed = (text: string) => text.split("\n").filter(l => l.startsWith("- ")).map(l => l.slice(2, l.indexOf(":")));
    expect(listed(rulesText(b1, skills))).toEqual(["Answer from what was read", "Sunday ready", "Who could help"]);
    expect(listed(rulesText(breeze, skills))).toEqual(["Answer from what was read", "Sunday ready"]);
    expect(rulesText(b1, skills)).toContain("none of them sends anything or changes B1 Church.");
    expect(rulesText(breeze, skills)).toContain("using only what Ozzie already read from Breeze.");
    // Planning Center only where something works there alone (the weeks-in-a-row rule), never as where Breeze's facts are.
    expect(rulesText(breeze, skills).replaceAll("work with Planning Center only for now", "")).not.toContain("Planning Center");
    expect(happenedText(b1, skills).split("\n").slice(2)).toEqual([
      "- 3:00 PM UTC on November 20: A Sunday check. Finished.",
      "- 2:00 PM UTC on November 20: A Sunday check. Didn't finish: the church system didn't answer.",
      "- 3:00 PM UTC on November 19: A Sunday check of Planning Center. Finished. It looked at a fresh Planning Center check.",
    ]);
  });
});

describe("kids teams and kids roles marked (the kids rule and these copies together)", () => {
  const B1_KIDS = withSystemKids(RULES, "b1:CHU0000cedar", "GRP-kids", 2, "Kids Ministry");
  const BREEZE_KIDS = withSystemKids(RULES, "breeze:juniperstreet", "nursery", 2, "Nursery");

  it("B1 Church marks teams: Siri says a kids team, with no name of the team, its roles or anyone on them", async () => {
    const c = b1KidsCapture();
    const { siri, shared } = await copiesOf(c, false, B1_KIDS);
    const said = ask(siri, "2026-11-20T15:12:00Z");
    expect(said).toBe("Sunday, November 22 has 3 open spots across 3 roles. 1 kids team has fewer confirmed people than your Church rules ask. 3 people are pending: 1 request was sent with no answer yet, and B1 Church shows 2 requests haven't been sent yet. Checked in B1 Church today at 9:00 AM.");
    for (const s of secrets(c)) expect(`${said}\n${served(shared)}`.includes(s), s).toBe(false);
  });

  it("Breeze marks roles: Siri says a kids role, never a kids team", async () => {
    // The unit each system marks, as the kids rule has it (kids.ts KIDS_UNIT), is the one Siri says.
    expect(KIDS_UNITS).toEqual(KIDS_UNIT);
    const c = breezeKidsCapture();
    const { siri, shared } = await copiesOf(c, false, BREEZE_KIDS);
    const said = ask(siri, "2026-11-20T15:12:00Z");
    expect(said).toBe("Sunday, November 22 has 1 open spot across 1 role. 1 kids role has fewer confirmed people than your Church rules ask. 1 person is pending. Checked in Breeze today at 9:00 AM.");
    expect(said).not.toMatch(/kids team/u);
    expect(ask(siri, "2026-11-20T18:00:00Z")).toContain("1 kids role had fewer confirmed people than your Church rules ask.");
    for (const s of secrets(c)) expect(`${said}\n${served(shared)}`.includes(s), s).toBe(false);
  });
});

describe("the Church rules for a church on another system", () => {
  it("never claim a check-in suggestion there: weeks in a row are said to be Planning Center's only, in the tool's result and its words", async () => {
    for (const capture of [b1Capture(), breezeUntimedCapture()]) {
      const data = dataFor(capture);
      const rules = await new HarnessTools(data, new HarnessSession(), { now: () => NOW }).run("rules.current", {}, new AbortController().signal);
      expect(envelopeProblems(rules)).toEqual([]);
      expect(Object.keys(rules.payload as object)).not.toContain("check_in_after_sundays_in_a_row");
      const said = composeFacts([(rules.payload as { fact: string }).fact], [rules]).join(" ");
      expect(said).toContain("Check-ins after several weeks in a row work with Planning Center only for now.");
      expect(said).not.toMatch(/suggest a check-in/u);
      const check = parseSharedCheck((await copiesOf(capture)).shared)!;
      expect(rulesText(check, skills)).not.toMatch(/suggest a check-in|don't suggest check-ins/u);
    }
    // Planning Center's, with the same rule, as before.
    const pc = await new HarnessTools(harnessData({ mode: "live" }), new HarnessSession(), { now: () => NOW }).run("rules.current", {}, new AbortController().signal);
    expect(composeFacts([(pc.payload as { fact: string }).fact], [pc]).join(" ")).toMatch(/^Your Church rules suggest a check-in after 3 weeks in a row\./u);
  });
});

describe("a service whose roles weren't read, or that has none", () => {
  it("B1 Church: never says B1 Church doesn't share how many people a role needs; says part of the check couldn't be read", async () => {
    expect(roleNumbersOf([])).toBe("all");
    expect([roleNumbersOf([{ needed: 2 }]), roleNumbersOf([{ needed: 2 }, { needed: null }]), roleNumbersOf([{ needed: null }])]).toEqual(["all", "some", "none"]);
    const unread = b1Capture({ positions: [], assignments: [], reads: b1Capture().reads.map(r => r.read === "b1.positions" ? { ...r, outcome: "timeout" as const } : r) });
    const { siri, system } = await copiesOf(unread);
    expect(system.role_numbers).toBe("all");
    const said = ask(siri, "2026-11-20T15:12:00Z");
    expect(said).not.toMatch(/doesn't share how many people/u);
    expect(said).toContain("Worth a look: part of the check couldn't be read, so this may be incomplete.");
    // Its roles read whole and none there: no check is built, so nothing is shared and Siri says it has no saved check.
    const none = b1Capture({ positions: [], assignments: [] });
    expect(buildSystemBrief(none, { confirmedZone: none.church.time_zone }, NOW)).toEqual({ ok: false, reason: "no-roles" });
  });
});
