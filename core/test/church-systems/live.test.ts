// An opt-in viewer for captures from a live read of a real test church: skipped unless OZZIE_LIVE_CAPTURE_DIR names a
// folder of capture files (kept outside the repo). For each file it prints what the page makes of it, with ids only:
// parse, the Sunday check with the zone unconfirmed and confirmed, the engine's result and the also-read facts. It pins
// nothing; it asserts only that nothing throws and that no name or label is in what it prints.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateCoverage } from "../../src/coverage.js";
import { systemCaptureToCoverage, type SystemLeadRules } from "../../src/church-systems/coverage.js";
import { systemFacts } from "../../src/church-systems/facts.js";
import { labelsOf, namesOf } from "../../src/church-systems/placeholders.js";
import { parseSystemCapture, parseSystemCaptureText, SYSTEMS, type SystemCapture } from "../../src/church-systems/types.js";

const DIR = process.env["OZZIE_LIVE_CAPTURE_DIR"];
const files = DIR ? readdirSync(DIR).filter(f => f.endsWith(".json")).sort() : [];

/** One readable, name-free summary of what the page makes of a capture. */
function summary(capture: SystemCapture): string[] {
  const lines: string[] = [];
  if (SYSTEMS[capture.system].sundayCheck) {
    // Before any zone is confirmed, and as if the leader confirmed the very zone the capture carries.
    for (const confirmedZone of [null, capture.church.time_zone]) {
      const rules: SystemLeadRules = { sundayLeads: [], confirmedZone };
      const coverage = systemCaptureToCoverage(capture, rules, capture.completed_at);
      lines.push(`-- confirmedZone=${confirmedZone}: mapping ${coverage.ok ? "ok" : coverage.reason}`);
      if (!coverage.ok) continue;
      const result = evaluateCoverage(coverage.input);
      lines.push(`   status=${result.status} day="${coverage.day.day}" (${coverage.day.date ?? "no date"}) time_zone=${coverage.time_zone}` +
        ` zone_unknown=${coverage.zone_unknown} zone_needs_confirming=${coverage.zone_needs_confirming} waiting_for_zone=${coverage.waiting_for_zone}` +
        ` zone_mismatch=${coverage.zone_mismatch}`);
      for (const p of result.positions) {
        lines.push(`   position ${p.position_id} team=${p.team_id} remaining_need=${p.remaining_need} lead=${p.lead} pending=${p.pending_assignment_ids.length}`);
        for (const c of p.candidates) lines.push(`     ${c.person_id}:${c.disposition} [${c.reasons.join(" ")}]`);
      }
      const issues = [...new Set(result.issues.map(i => `${i.code}@${i.scope_id ?? "-"}`))];
      lines.push(`   issues: ${issues.length ? issues.join(", ") : "none"}`);
    }
  } else {
    lines.push(`-- no Sunday check: ${(systemCaptureToCoverage(capture, { sundayLeads: [] }, capture.completed_at) as { reason?: string }).reason}`);
  }
  const facts = systemFacts(capture, { confirmedZone: capture.church.time_zone });
  const counts = (items: { id: string; count: number | null; why: string | null }[]) =>
    items.length ? items.map(i => `${i.id}=${i.count ?? "null"}${i.why ? `(${i.why})` : ""}`).join(" ") : "none";
  lines.push(`   facts reads: groups=${facts.reads.groups.outcome} events=${facts.reads.events.outcome} forms=${facts.reads.forms.outcome}`);
  lines.push(`   groups: ${counts(facts.groups.map(g => ({ id: g.group_id, count: g.members, why: g.why_null })))}`);
  lines.push(`   events: ${counts(facts.events.map(e => ({ id: e.event_id, count: e.attendance, why: e.why_null })))}`);
  lines.push(`   forms: ${counts(facts.forms.map(f => ({ id: f.form_id, count: f.submissions, why: f.why_null })))}`);
  return lines;
}

/** The capture with every name and label replaced by its own marker, parsed again. */
function marked(capture: SystemCapture): SystemCapture {
  let n = 0;
  const swap = (record: Readonly<Record<string, string>>, kind: string) => Object.fromEntries(Object.keys(record).map(k => [k, `Zq${n++}${kind}`]));
  const parsed = parseSystemCapture(JSON.parse(JSON.stringify({ ...capture, names: swap(namesOf(capture), "Name"), labels: swap(labelsOf(capture), "Label") })));
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.capture;
}

describe.skipIf(!DIR)("live captures (OZZIE_LIVE_CAPTURE_DIR)", () => {
  it.each(files.length ? files : ["(none)"])("%s", file => {
    if (!files.length) throw new Error("OZZIE_LIVE_CAPTURE_DIR has no .json capture");
    // A broken file prints only its name and the closed reason word: a JSON error would quote the text around the fault.
    const parsed = parseSystemCaptureText(readFileSync(join(DIR!, file), "utf8"));
    if (!parsed.ok) {
      console.log(`== ${file}: parse refused (${parsed.reason})`);
      return;
    }
    const capture = parsed.capture;
    const printed = [`== ${file}: parse ok, system=${capture.system} (${SYSTEMS[capture.system].name}), church=${capture.church.id}` +
      ` time_zone=${capture.church.time_zone} service day=${capture.service?.day ?? "null"}`, ...summary(capture)].join("\n");
    // The header is ids, a zone name and a date only; the marker check below covers every summary line.
    // Never a name or label in what is printed: not as given, and not when each is a unique marker.
    // A failure names the key (a person id, or a label key such as "event:<id>"), never the value. A value of one or
    // two characters (a Breeze tag can be named "A") turns up inside ids and words by chance, so only the marker check
    // below covers it; that check proves no name or label goes through at all.
    for (const [key, word] of [...Object.entries(namesOf(capture)), ...Object.entries(labelsOf(capture))]) {
      if (word.length >= 3) expect(printed.includes(word), `${file}: the name or label for ${key} would be printed`).toBe(false);
    }
    expect(summary(marked(capture)).join("\n")).not.toMatch(/Zq\d+(?:Name|Label)/u);
    console.log(printed);
  });
});
