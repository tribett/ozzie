import { describe, expect, it } from "vitest";
import { evaluateAttentionImport } from "../src/attention-import/index.js";
import { harborAttentionImport } from "../src/fictional-attention.js";

describe("fictional attention briefing import", () => {
  const report = evaluateAttentionImport(harborAttentionImport());
  it("is accepted by the reviewed validator", () => expect(report.ok).toBe(true));
  it("raises exactly one item: tonight's orientation needs a location decision", () => {
    if (!report.ok) throw new Error("invalid");
    expect(report.findings.map(f => f.title)).toEqual(["Tonight's orientation needs a location decision."]);
    expect(report.findings[0]!.statement).toBe("A message reports the room unavailable; the calendar still lists it.");
    expect(report.findings[0]!.communication).toContain("have not been contacted");
    expect(report.findings[0]!.urgent).toBe(true);
  });
  it("says tonight only for an orientation still to come that same evening on the import's clock", () => {
    const titled = (change: (i: ReturnType<typeof harborAttentionImport>) => void) => {
      const input = harborAttentionImport(); change(input);
      const r = evaluateAttentionImport(input);
      return r.ok ? r.findings.map(f => f.title) : ["refused"];
    };
    const TONIGHT = ["Tonight's orientation needs a location decision."], RECORDED = ["The recorded event needs a location decision."];
    expect(titled(() => undefined)).toEqual(TONIGHT);
    // Tomorrow evening, or this afternoon: not tonight.
    expect(titled(i => { i.events[0]!.start_at = "2026-11-21T00:00:00Z"; i.events[0]!.end_at = "2026-11-21T01:00:00Z"; })).toEqual(RECORDED);
    expect(titled(i => { i.events[0]!.start_at = "2026-11-19T20:00:00Z"; i.events[0]!.end_at = "2026-11-19T21:00:00Z"; })).toEqual(RECORDED);
    // Read at 9 PM, after it started: no longer tonight's (review of d4bb7c4c, L3).
    expect(titled(i => { i.evaluated_at = "2026-11-20T02:00:00Z"; i.imported_at = "2026-11-20T02:00:00Z"; })).toEqual(RECORDED);
    // Another event with the same times is never the orientation.
    expect(titled(i => { i.events[0]!.title = "Board meeting"; })).toEqual(RECORDED);
  });
  it("the promotion, the handled invoice, the routine meeting and the injected instruction raise nothing", () => {
    if (!report.ok) throw new Error("invalid");
    const ids = report.findings.flatMap(f => f.source_ids);
    for (const id of ["MSG-02", "MSG-03", "MSG-04", "CAL-02"]) expect(ids).not.toContain(id);
    expect(report.gaps).toEqual([]);
  });
});
