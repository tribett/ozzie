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
  it("the promotion, the handled invoice, the routine meeting and the injected instruction raise nothing", () => {
    if (!report.ok) throw new Error("invalid");
    const ids = report.findings.flatMap(f => f.source_ids);
    for (const id of ["MSG-02", "MSG-03", "MSG-04", "CAL-02"]) expect(ids).not.toContain(id);
    expect(report.gaps).toEqual([]);
  });
});
