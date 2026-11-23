// Review of 0.8.0, M1 and M2: a Breeze job's write-up and a Breeze morning briefing never read as all clear (Breeze
// shares no number for any role), and a church on Genesis is told where jobs work and why none reads it. Fixed fictional
// data and a scripted model; nothing native runs.
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => { throw new Error("NATIVE_CALL_FORBIDDEN"); }) }));
import { bundledSkills } from "../../../core/src/harness/bundled-skills.js";
import type { AgentStepReply, AgentStepRequest, ModelStep } from "../../../core/src/harness/contract.js";
import { Harness } from "../../../core/src/harness/index.js";
import { TsLoop } from "../../../core/src/harness/ts-loop.js";
import { breezeUntimedCapture } from "../../../core/test/church-systems/fixtures.js";
import type { NoticedItem } from "../src/responsibility-runner.js";
import { noticedTitle } from "../src/responsibility-words.js";
import { systemJobCheck, systemJobHarness } from "../src/system-jobs.js";
import { genesisNoJobs } from "../src/day-phrases.js";
import { keptWriteup } from "../src/harness-bridge.js";
import { progressEmptyText } from "../src/today-groups.js";
import { systemWords } from "../src/church-system.js";

const ET = "America/New_York";
const RULES = { sundayLeads: [], checkInAfterSundaysInARow: 3 };
const FRI = "2026-11-20T15:05:00.000Z";

describe("Breeze never reads as all clear (M1), and Genesis is told the truth (M2)", () => {
  it("a Breeze job's write-up says Breeze shares no numbers, as Ask does", async () => {
    const capture = breezeUntimedCapture({ assignments: breezeUntimedCapture().assignments.map(a => a.id === "V1" ? { ...a, status: "accepted" as const } : a) });
    const data = systemJobHarness(systemJobCheck(capture, null)!, RULES, [], "2026-11-20T15:10:00Z")!;
    const sent: AgentStepRequest[] = [];
    const h = new Harness({ workspace_id: "this-mac", data, skills: await bundledSkills(), runtime: new TsLoop(), model: scripted(sent), now: () => "2026-11-20T15:10:00Z",
      newId: () => "00000000-0000-4000-8000-0000000000d1", macZone: ET });
    const kept = keptWriteup(h, await h.runSkill("sunday-ready"));
    expect(kept.gaps).toContain("Breeze doesn't share how many people each role needs, so Ozzie can't say whether a role is full.");
  });
  it("a Breeze morning briefing other than Thursday's says the limit; Thursday's full brief says it itself", () => {
    const item: NoticedItem = { id: "b", responsibility_id: "x", template: "morning-briefing", at: FRI, kind: "briefing", unnumbered: true, system: "breeze" };
    expect(noticedTitle(item, FRI)).toBe("Your morning briefing is ready. Breeze doesn't share how many people each role needs, so Ozzie can't say whether this Sunday is covered.");
    expect(noticedTitle({ ...item, sunday_ready: true }, FRI)).toBe("Your morning briefing is ready. Today it includes the full “Ready for Sunday” brief.");
  });
  it("Genesis: jobs work with Planning Center, B1 Church and Breeze, and none reads Genesis", () => {
    expect(genesisNoJobs()).toBe("Keep services covered and the morning briefing work with Planning Center, B1 Church and Breeze. Genesis shares no volunteer schedules, so no job reads it.");
    // Today's In progress with nothing in it, once Genesis reads on its own (second-pass review, L4).
    expect(progressEmptyText({ ready: true, paused: false, running: false, intervalMinutes: 60, runOnLaunch: true, last: null, next: null, missed: [] }, false, systemWords("genesis")))
      .toBe("Nothing is running. Keep services covered and the morning briefing work with Planning Center, B1 Church and Breeze. Genesis shares no volunteer schedules, so no job reads it.");
  });
});

const call = (step: number, name: string): AgentStepReply => ({ content: "", tool_calls: [{ id: `call_${step}_0`, name, arguments: "{}" }], finish: "tool_calls" });
const reply = (o: unknown): AgentStepReply => ({ content: JSON.stringify(o), tool_calls: [], finish: "stop" });
function scripted(sent: AgentStepRequest[]): ModelStep {
  return async r => {
    sent.push(r);
    const got = r.messages.flatMap(m => m.role === "tool" ? [JSON.parse(m.content) as { payload: Record<string, unknown> }] : []);
    if (!got.length) return call(sent.length, "sunday.overview");
    return reply({ answer: "facts", facts: [got[0]!.payload["fact"]] });
  };
}
