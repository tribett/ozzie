// Review of round 4, M5: on Breeze, which shares no number needed for any role, an answer that read the service always
// says Ozzie can't say whether a role is full, so "nothing needs a decision" is never the whole answer. Local words only.
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => new Promise(() => {})) }));
import { systemGaps } from "../src/harness-bridge.js";
import { buildSystemBrief } from "../../../core/src/church-systems/brief.js";
import { systemHarnessCapture } from "../../../core/src/church-systems/harness.js";
import { SYSTEMS, type SystemCapture } from "../../../core/src/church-systems/types.js";
import type { HarnessData } from "../../../core/src/harness/tools.js";
import { b1Capture, breezeUntimedCapture, NOW } from "../../../core/test/church-systems/fixtures.js";

const dataFor = (capture: SystemCapture): HarnessData => {
  const built = buildSystemBrief(capture, { confirmedZone: capture.church.time_zone }, NOW);
  if (!built.ok) throw new Error(built.reason);
  return { capture: systemHarnessCapture(capture, false), brief: built.brief, operations: null, decisions: [], rules: { sundayLeads: [], checkInAfterSundaysInARow: 3 },
    attention: null, granted: ["services"], mode: "live", connected: false, source: SYSTEMS[capture.system].name };
};

describe("an answer on Breeze, whose roles have no number needed", () => {
  it("says once that Ozzie can't say whether a role is full, when it read the service", () => {
    const data = dataFor(breezeUntimedCapture());
    expect(systemGaps(data, [{ source: "Breeze" }, { source: "Church rules on this Mac" }]))
      .toEqual(["Breeze doesn't share how many people each role needs, so Ozzie can't say whether a role is full."]);
    // An answer that didn't read the service, B1 Church, and Planning Center: nothing added.
    expect(systemGaps(data, [{ source: "Church rules on this Mac" }])).toEqual([]);
    expect(systemGaps(dataFor(b1Capture()), [{ source: "B1 Church" }])).toEqual([]);
    const planningCenter: HarnessData = { ...data };
    delete planningCenter.source;
    expect(systemGaps(planningCenter, [{ source: "Breeze" }])).toEqual([]);
  });
});
