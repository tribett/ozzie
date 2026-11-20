// One count everywhere (review of 00d38d00..55279877, item 1): Today and the sidebar count what the Sunday page shows from
// the check on screen (sundayShownCount), rooms, follow-ups and group meetings included, whatever the connection holds
// since. Ask's overview, its "On the Sunday page, needing a decision" list and what it says wasn't checked follow the
// same check by the same rule: with the scopes held, after a later Services-only sign-in, and on a saved check shown at
// launch. Fictional fixed data; no native calls, no AI.
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => { throw new Error("NATIVE_CALL_FORBIDDEN"); }) }));
import { NOTHING_OPEN, onPage, openDecisions } from "../../../core/src/harness/compose.js";
import { HarnessSession } from "../../../core/src/harness/session.js";
import { HarnessTools } from "../../../core/src/harness/tools.js";
import { withFictionalOperations, withFictionalOperationsOff } from "../../../core/src/fictional-operations.js";
import { nov22Capture } from "../../../core/src/fictional-sunday.js";
import { sundayOperations } from "../../../core/src/operations-capture.js";
import { buildSundayBrief, sundayShownCount } from "../../../core/src/sunday-brief.js";
import type { SundayCapture } from "../../../core/src/sunday-capture.js";
import { applyDecisions, decide, type SundayDecision } from "../../../core/src/sunday-decisions.js";
import { SUNDAY_WORDS } from "../../../core/src/service-day.js";
import type { ConnectionStatus } from "../src/connection.js";
import { buildHarnessData } from "../src/harness-bridge.js";
import { RULES } from "./harness-fakes.js";

const NOW = "2026-11-20T15:05:00Z";
const signal = new AbortController().signal;
const status = (scopes: string): ConnectionStatus =>
  ({ state: "connected", organization: "1001", checked_at_ms: 1, source: "test", problem: null, scopes } as ConnectionStatus);
/** The live-style church: two roles that need people and a follow-up with no owner (no room rule, so its overlap is worth a look). */
const live = (): SundayCapture => ({ ...withFictionalOperations(nov22Capture()), kind: "live" });

/** What Today, the sidebar and the Services page count, built as App builds it from the check on screen. */
function page(capture: SundayCapture, decisions: readonly SundayDecision[]) {
  const brief = buildSundayBrief(capture, RULES, NOW, false);
  const operations = sundayOperations(capture, RULES, { now: NOW });
  return { brief, operations, counts: sundayShownCount(applyDecisions(brief, decisions), operations) };
}

/** What Ask says from the same check, built as App builds its harness data. */
async function ask(capture: SundayCapture, decisions: readonly SundayDecision[], connection: ConnectionStatus | null) {
  const { brief, operations } = page(capture, decisions);
  const data = buildHarnessData({ capture, fictional: false, rules: RULES, decisions, status: connection, configured: true, now: NOW, brief, operations });
  const tools = new HarnessTools(data, new HarnessSession(), { now: () => NOW });
  const overview = (await tools.run("sunday.overview", {}, signal)).payload as { needs_a_decision: number; worth_a_look: number; findings: { kind: string }[] };
  const notChecked = (await tools.run("sunday.not_checked", {}, signal)).payload as { rooms_follow_ups_groups: string[] };
  const listed = await openDecisions(tools, signal);
  return { overview, notChecked, listed: listed.paragraphs };
}

describe("Today and Ask say the same count for the same check", () => {
  const settled = () => {
    const need = page(live(), []).brief.findings.find(f => f.kind === "needs-people")!;
    return [decide(need, "covered-outside", "A parent is covering", NOW)];
  };
  const cases: [string, () => SundayCapture, () => SundayDecision[], ConnectionStatus | null][] = [
    ["Calendar, People and Groups held", live, () => [], status("services-and-operations")],
    ["a later Services-only sign-in, with the older check that read them still on screen", live, () => [], status("services")],
    ["a saved check shown at launch, before the saved sign-in is checked", () => ({ ...live(), kind: "recording" }), () => [], null],
    ["a saved check shown, the connection now Services only", () => ({ ...live(), kind: "recording" }), () => [], status("services")],
    ["a decision the leader settled, Services only", live, settled, status("services")],
  ];

  for (const [name, capture, decisions, connection] of cases) {
    it(name, async () => {
      const shown = page(capture(), decisions());
      // The page shows the follow-up and the group meeting from this check.
      expect(shown.operations?.result?.findings.some(f => f.kind === "unowned-overdue")).toBe(true);
      const said = await ask(capture(), decisions(), connection);
      expect(said.overview.needs_a_decision).toBe(shown.counts.decisions);
      expect(said.overview.worth_a_look).toBe(shown.counts.looks);
      expect(said.overview.findings.map(f => f.kind)).toEqual(expect.arrayContaining(["needs an owner", "group meets while serving"]));
      // "On the Sunday page, needing a decision:" then each of them, the follow-up included.
      expect(said.listed[0]).toBe(onPage(SUNDAY_WORDS));
      expect(said.listed.slice(1).filter(p => p !== NOTHING_OPEN)).toHaveLength(shown.counts.decisions);
      expect(said.listed.some(p => p.endsWith("has no owner."))).toBe(true);
      // What wasn't checked is the page's own "What I didn't check" for this check, never "not part of this connection".
      expect(said.notChecked.rooms_follow_ups_groups).toEqual(shown.operations!.not_checked);
    });
  }

  it("a check that never read them says so, and counts none of them, on both sides", async () => {
    // Services only, and the check on screen made with Services only: every Calendar, People and Groups read not requested.
    const capture: SundayCapture = { ...withFictionalOperationsOff(nov22Capture()), kind: "live" };
    const shown = page(capture, []);
    const said = await ask(capture, [], status("services"));
    expect(said.overview.needs_a_decision).toBe(shown.counts.decisions);
    expect(said.overview.worth_a_look).toBe(shown.counts.looks);
    expect(said.overview.findings.map(f => f.kind)).not.toContain("needs an owner");
    expect(said.notChecked.rooms_follow_ups_groups).toEqual(["Rooms, follow-ups and group meetings are not part of this connection."]);
  });
});
