// The seam between the native crate and the page: every capture the crate writes from its own fixed, fictional test
// data (core/test/church-systems/captures/*.json) must parse here, go through the Sunday check and the also-read facts
// without throwing, never come out all clear when a read the check depends on didn't finish, and never carry a name or
// label into anything returned. What the page makes of each committed file is pinned below, so a change on either
// side fails here. The crate writes these files; this test only reads them.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluateCoverage } from "../../src/coverage.js";
import { systemCaptureToCoverage, type SystemLeadRules } from "../../src/church-systems/coverage.js";
import { systemFacts } from "../../src/church-systems/facts.js";
import { namesOf, labelsOf } from "../../src/church-systems/placeholders.js";
import { parseSystemCapture, readsFor, SYSTEM_IDS, SYSTEMS, type SystemCapture } from "../../src/church-systems/types.js";

const DIR = new URL("./captures/", import.meta.url);
const files = existsSync(DIR) ? readdirSync(DIR).filter(f => f.endsWith(".json")).sort() : [];
/**
 * No lead rules and, by default, the leader confirmed in Ozzie exactly the zone each capture carries (so B1's check runs
 * and Genesis events are shown); UNCONFIRMED, no zone confirmed.
 */
const UNCONFIRMED: SystemLeadRules = { sundayLeads: [], confirmedZone: null };
/** Ozzie's own fixed sentences and day words: left out when looking for the church's words in what comes back. */
const FIXED_TEXT = new Set(["day", "reasons", "message", "cannot_see"]);
const withoutFixedText = (value: unknown) => JSON.stringify(value, (key, v: unknown) => FIXED_TEXT.has(key) ? undefined : v);

function load(file: string): SystemCapture {
  const parsed = parseSystemCapture(JSON.parse(readFileSync(new URL(file, DIR), "utf8")));
  if (!parsed.ok) throw new Error(`${file} was refused: ${parsed.reason}`);
  return parsed.capture;
}
/** Everything the page computes from a capture, evaluated one minute after it finished. */
function everything(capture: SystemCapture, rules: SystemLeadRules = { sundayLeads: [], confirmedZone: capture.church.time_zone }) {
  const now = new Date(Date.parse(capture.completed_at) + 60_000).toISOString();
  const coverage = systemCaptureToCoverage(capture, rules, now);
  return { coverage, result: coverage.ok ? evaluateCoverage(coverage.input) : null,
    facts: systemFacts(capture, { confirmedZone: rules.confirmedZone ?? null }) };
}
/** The capture with every name and label replaced by its own marker, parsed again. */
function marked(capture: SystemCapture): SystemCapture {
  let n = 0;
  const swap = (record: Readonly<Record<string, string>>, kind: string) => Object.fromEntries(Object.keys(record).map(k => [k, `Zq${n++}${kind}`]));
  const parsed = parseSystemCapture(JSON.parse(JSON.stringify({ ...capture, names: swap(namesOf(capture), "Name"), labels: swap(labelsOf(capture), "Label") })));
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.capture;
}

type Count = [id: string, count: number | null, why_null: string | null];
interface Summary {
  system: string;
  /** "ok", or the refusal word. */
  coverage: string;
  status?: string;
  /** The day word with the zone confirmed, and before it is. */
  day?: [confirmed: string, unconfirmed: string];
  /** Each role: remaining need, lead, and each person offered by id with the engine's disposition. */
  positions?: [id: string, need: number | null, lead: string, candidates: Record<string, string>][];
  /** Issue codes with their scope, distinct, in order. */
  issues?: string[];
  /** People on the service with no role. */
  on_service?: number;
  /** Whether the checked plan is shared with volunteers yet (B1 Church). */
  plan_shared?: boolean | null;
  /** With the zone not yet confirmed: the status and the distinct issues (B1 holds the plan's times back). */
  unconfirmed?: [status: string, issues: string[]];
  facts: { groups: Count[]; events: Count[]; forms: Count[] };
}
const issueCodes = (issues: readonly { code: string; scope_id: string | null }[]) => [...new Set(issues.map(i => `${i.code}@${i.scope_id ?? "-"}`))];
function summarise(capture: SystemCapture): Summary {
  const { coverage, result, facts } = everything(capture);
  const held = everything(capture, UNCONFIRMED);
  const unconfirmed = held.coverage;
  const counts = {
    groups: facts.groups.map((g): Count => [g.group_id, g.members, g.why_null]),
    events: facts.events.map((e): Count => [e.event_id, e.attendance, e.why_null]),
    forms: facts.forms.map((f): Count => [f.form_id, f.submissions, f.why_null]),
  };
  if (!coverage.ok || !result || !unconfirmed.ok) return { system: capture.system, coverage: coverage.ok ? "ok" : coverage.reason, facts: counts };
  return {
    system: capture.system, coverage: "ok", status: result.status, day: [coverage.day.day, unconfirmed.day.day],
    positions: result.positions.map(p => [p.position_id, p.remaining_need, p.lead,
      Object.fromEntries(p.candidates.map(c => [c.person_id, c.disposition]))]),
    issues: issueCodes(result.issues), on_service: coverage.on_service_count, plan_shared: coverage.plan_shared,
    unconfirmed: [held.result!.status, issueCodes(held.result!.issues)],
    facts: counts,
  };
}

// B1 Church, Sunday 22 November 9:00 AM Chicago (America/Chicago). Vocals: Avery said yes, Blake hasn't answered.
// Greeter: Casey declined. Drew (worship) is blocked out that Sunday; Ellis (welcome) is free.
const B1_FACTS = {
  groups: [["GRPworship", 3, null], ["GRPwelcome", 2, null], ["GRPyouth", null, "not-given"]] as Count[],
  events: [["EVTsupper", null, "not-read-yet"]] as Count[],
  forms: [["FRMfall", null, "not-read-yet"]] as Count[],
};
/**
 * Before the leader confirms B1's zone: the plan's times are held back (native picks them by that zone), so every role
 * and answer is unverified, with the closed reason on the zone-confirmation scope.
 */
const HELD = ["scope-unverified@b1.zone-confirmation", "time-unverified@-", "assignment-unverified@b1.assignments"];
/** With blockouts not fully read, nobody offered is suggested. */
const B1_BLOCKOUTS_UNREAD: Summary = {
  system: "b1", coverage: "ok", status: "unverified", day: ["Sunday", "your service"],
  positions: [
    ["POSvocal", 0, "not-required", { PERdrew: "unverified" }],
    ["POSsound", 1, "not-required", { PERdrew: "unverified" }],
    ["POSgreet", 2, "not-required", { PERellis: "unverified" }],
  ],
  issues: ["observation-unverified@b1.blockouts", "candidate-unverified@-"], on_service: 0, plan_shared: true,
  unconfirmed: ["unverified", HELD.slice(0, 3).concat("observation-unverified@b1.blockouts", "candidate-unverified@-")],
  facts: B1_FACTS,
};
const EXPECTED: Record<string, Summary> = {
  "b1-full.json": {
    system: "b1", coverage: "ok", status: "findings", day: ["Sunday", "your service"],
    positions: [
      ["POSvocal", 0, "not-required", { PERdrew: "excluded" }],
      ["POSsound", 1, "not-required", { PERdrew: "excluded" }],
      ["POSgreet", 2, "not-required", { PERellis: "suggestion" }],
    ],
    issues: [], on_service: 0, plan_shared: true, unconfirmed: ["unverified", [...HELD, "candidate-unverified@-"]], facts: B1_FACTS,
  },
  // An Auckland church with no zone in B1; the leader gave Pacific/Auckland, which native used and emits. B1 stored the
  // plan as Saturday 21 November; the real day is Sunday 22 November, 10:00 NZDT (21:00 UTC Saturday), the Saturday
  // rehearsal left out. Confirmed: Drew's Sunday blockout covers the service, Ellis is free. Not yet confirmed: held back.
  // Its plan answer has no "prepared" field, so whether it is shared with volunteers couldn't be told (null).
  "b1-zone-supplied.json": {
    system: "b1", coverage: "ok", status: "findings", day: ["Sunday", "your service"],
    positions: [
      ["POSvocal", 0, "not-required", { PERdrew: "excluded" }],
      ["POSsound", 1, "not-required", { PERdrew: "excluded" }],
      ["POSgreet", 2, "not-required", { PERellis: "suggestion" }],
    ],
    issues: [], on_service: 0, plan_shared: null, unconfirmed: ["unverified", [...HELD, "candidate-unverified@-"]], facts: B1_FACTS,
  },
  // b1-full's plan, not shared with volunteers yet: checked all the same, and the result says it isn't shared.
  "b1-not-shared.json": {
    system: "b1", coverage: "ok", status: "findings", day: ["Sunday", "your service"],
    positions: [
      ["POSvocal", 0, "not-required", { PERdrew: "excluded" }],
      ["POSsound", 1, "not-required", { PERdrew: "excluded" }],
      ["POSgreet", 2, "not-required", { PERellis: "suggestion" }],
    ],
    issues: [], on_service: 0, plan_shared: false, unconfirmed: ["unverified", [...HELD, "candidate-unverified@-"]], facts: B1_FACTS,
  },
  // The blockouts read timed out.
  "b1-failed-read.json": B1_BLOCKOUTS_UNREAD,
  // Checked on the service's own day: B1 stops listing a blockout during its last day, so native marks the read cut short.
  "b1-service-day.json": B1_BLOCKOUTS_UNREAD,
  // Breeze, with its answer codes confirmed: 9627 needs 2, one hasn't answered and one declined; 9628's one volunteer
  // declined; 9629's said yes. No team is tied to a role, so nobody is offered. The day is Breeze's own. The check ran
  // on 17 November, before the service ended, so its check-ins weren't final; both forms are among those counted.
  "breeze-full.json": {
    system: "breeze", coverage: "ok", status: "findings", day: ["Sunday", "Sunday"],
    positions: [["9627", 1, "not-required", {}], ["9628", 1, "not-required", {}], ["9629", 0, "not-required", {}]],
    // Breeze has no zone to confirm: nothing is held back.
    issues: [], on_service: 1, plan_shared: null, unconfirmed: ["findings", []],
    facts: {
      groups: [["301", null, "not-read-yet"]],
      events: [["4401", null, "not-ended"], ["4402", null, "not-read-yet"]],
      forms: [["41", 2, null], ["42", 0, null]],
    },
  },
  "genesis-full.json": {
    system: "genesis", coverage: "no-sunday-check",
    facts: {
      groups: [["grp-1", 12, null], ["grp-2", null, "not-given"]],
      events: [["evt-1", 142, null], ["evt-2", null, "not-given"]],
      forms: [["FRMfall", 2, null], ["FRMcare", 0, null]],
    },
  },
};

describe("captures written by the native crate", () => {
  it("are there: at least one for each of the three systems, and each one's result is pinned here", () => {
    expect(existsSync(DIR), "core/test/church-systems/captures/ is missing: the native crate writes it from its fixed test data").toBe(true);
    expect(files.length, "core/test/church-systems/captures/ has no .json capture yet: the native crate writes them").toBeGreaterThan(0);
    const systems = new Set(files.map(file => (JSON.parse(readFileSync(new URL(file, DIR), "utf8")) as { system?: unknown }).system));
    for (const system of SYSTEM_IDS) expect(systems.has(system), `no capture from ${system} in core/test/church-systems/captures/`).toBe(true);
    expect(files, "a capture file with no pinned result, or a pinned result with no file").toEqual(Object.keys(EXPECTED).sort());
  });

  it("b1-zone-supplied.json: confirmed, the real Sunday and its own times; not confirmed, nothing placed", () => {
    const capture = load("b1-zone-supplied.json");
    const { coverage } = everything(capture);
    if (!coverage.ok) throw new Error(coverage.reason);
    expect(coverage).toMatchObject({ time_zone: "Pacific/Auckland", waiting_for_zone: false, zone_needs_confirming: false });
    expect(coverage.day).toMatchObject({ weekday: 0, day: "Sunday", date: "Sunday, November 22" });
    expect(coverage.input.positions[0]!.interval).toEqual({ starts_at: "2026-11-21T21:00:00.000Z", ends_at: "2026-11-21T22:15:00.000Z" });
    const held = everything(capture, UNCONFIRMED).coverage;
    if (!held.ok) throw new Error(held.reason);
    expect(held).toMatchObject({ waiting_for_zone: true, zone_needs_confirming: true });
    expect(held.day).toMatchObject({ kind: "unknown", day: "your service" });
    expect(held.input.positions.every(p => p.interval === null)).toBe(true);
  });

  it.each(files.length ? files : ["(none)"])("%s parses, maps as pinned and never carries a name or label out", file => {
    if (!files.length) throw new Error("core/test/church-systems/captures/ is missing or empty: nothing to check");
    const capture = load(file);
    expect(summarise(capture)).toEqual(EXPECTED[file]);
    const { coverage, result, facts } = everything(capture);
    if (SYSTEMS[capture.system].sundayCheck && coverage.ok) {
      const required = ["service", "positions", "assignments"].flatMap(part => readsFor(capture.system, part as "service"));
      const notOk = required.some(word => {
        const reads = capture.reads.filter(r => r.read === word);
        return !reads.length || reads.some(r => r.outcome !== "ok");
      });
      if (notOk) expect(result!.status, `${file}: a required read didn't finish`).not.toBe("checked-scope-clear");
    }
    expect(facts.source).toBe(SYSTEMS[capture.system].name);
    // The church's own words don't come back, outside Ozzie's fixed sentences.
    const returned = withoutFixedText({ coverage, result, facts, unconfirmed: everything(capture, UNCONFIRMED) });
    for (const word of [...Object.values(namesOf(capture)), ...Object.values(labelsOf(capture))]) {
      expect(returned.includes(word), `${file}: "${word}" came back`).toBe(false);
    }
    // And with every name and label made a unique marker, none comes back anywhere, fixed sentences included.
    const again = marked(capture);
    expect(JSON.stringify([everything(again), everything(again, UNCONFIRMED)])).not.toMatch(/Zq\d+(?:Name|Label)/u);
  });
});
