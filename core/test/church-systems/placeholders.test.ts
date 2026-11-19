// Names and labels stay in the capture: the Sunday check and the also-read facts return ids only, and placeholders.ts
// is the one way either leaves a capture. Every name and label below is a unique marker that must never come out.
// Fictional data only.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluateCoverage } from "../../src/coverage.js";
import { systemCaptureToCoverage } from "../../src/church-systems/coverage.js";
import { cannotSee, systemFacts } from "../../src/church-systems/facts.js";
import { labelsOf, namesOf, placeholderScope } from "../../src/church-systems/placeholders.js";
import { parseSystemCapture, type SystemCapture } from "../../src/church-systems/types.js";
import { asJson, b1Capture, breezeCapture, factsCapture, NOW } from "./fixtures.js";

const MARKER = /Zq\d+(?:Name|Label)/u;
/** The capture with every name and every label replaced by its own marker. */
function marked(capture: SystemCapture): SystemCapture {
  let n = 0;
  const swap = (record: Record<string, string>, kind: string) => Object.fromEntries(Object.keys(record).map(k => [k, `Zq${n++}${kind}`]));
  return { ...capture, names: swap(capture.names, "Name"), labels: swap(capture.labels, "Label") };
}

describe("names and labels stay in the capture", () => {
  it("no name or label is in the Sunday check, the engine's result, the facts or what Ozzie can't see", () => {
    for (const capture of [b1Capture(), breezeCapture(), factsCapture("genesis")].map(marked)) {
      const parsed = parseSystemCapture(asJson(capture));
      if (!parsed.ok) throw new Error(parsed.reason);
      expect(JSON.stringify(parsed.capture)).toMatch(MARKER);
      // A lead rule that matches a role by its marked name still returns only ids.
      const lead = Object.entries(capture.labels).find(([k]) => k.startsWith("position:"));
      const rules = { sundayLeads: lead ? [{ team_id: capture.positions[0]!.team_id ?? "none", lead_position: lead[1] }] : [] };
      const coverage = systemCaptureToCoverage(parsed.capture, rules, NOW);
      expect(JSON.stringify(coverage)).not.toMatch(MARKER);
      if (coverage.ok) expect(JSON.stringify(evaluateCoverage(coverage.input))).not.toMatch(MARKER);
      expect(JSON.stringify(systemFacts(parsed.capture))).not.toMatch(MARKER);
      expect(JSON.stringify(cannotSee(parsed.capture.system))).not.toMatch(MARKER);
    }
  });

  it("the lead rule above really matched a role by its marked name", () => {
    const capture = marked(b1Capture());
    const rules = { sundayLeads: [{ team_id: "GRP-worship", lead_position: capture.labels["position:POS-vocals"]! }] };
    const coverage = systemCaptureToCoverage(capture, rules, NOW);
    if (!coverage.ok) throw new Error(coverage.reason);
    expect(coverage.input.positions[0]!.lead.value).toEqual({ mapping: "required", assignment_ids: ["ASN-rowan", "ASN-tamsin"] });
  });

  it("hands names and labels out only through namesOf and labelsOf, under the scope <system>:<church id>", () => {
    const capture = b1Capture();
    expect(placeholderScope(capture)).toBe("b1:CHU0000cedar");
    expect(placeholderScope(breezeCapture())).toBe("breeze:juniperstreet");
    expect(namesOf(capture)["PER-rowan"]).toBe("Rowan Fictional");
    expect(labelsOf(capture)["position:POS-vocals"]).toBe("Vocals");
  });

  it("no other file in core/src/church-systems reads a capture's names or labels directly", () => {
    const dir = new URL("../../src/church-systems/", import.meta.url);
    for (const file of ["coverage.ts", "facts.ts", "index.ts"]) {
      const source = readFileSync(new URL(file, dir), "utf8");
      expect(source, file).not.toMatch(/\.(?:names|labels)\b|\[\s*["'](?:names|labels)["']\s*\]/u);
    }
    // Neither the Sunday check nor the facts needs a person's name at all.
    for (const file of ["coverage.ts", "facts.ts"]) expect(readFileSync(new URL(file, dir), "utf8"), file).not.toMatch(/\bnamesOf\b/u);
  });
});
