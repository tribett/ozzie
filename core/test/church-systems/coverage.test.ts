// A B1 Church or Breeze capture turned into the coverage engine's input, then run through the real engine
// (core/src/coverage.ts): open roles, who answered, who could help, and every place a read that failed or a fact the
// system doesn't give stays "couldn't be verified" instead of becoming "covered". Fictional data only.
import { describe, expect, it } from "vitest";
import { evaluateCoverage, type CoverageResult } from "../../src/coverage.js";
import { captureToCoverage, LIVE_CHECK_VALID_MS } from "../../src/sunday-capture.js";
import { nov22Capture, PEOPLE } from "../../src/fictional-sunday.js";
import { completenessOf, systemCaptureToCoverage, ZONE_CONFIRMATION_SCOPE, type SystemCoverage, type SystemLeadRules } from "../../src/church-systems/coverage.js";
import { parseSystemCapture, READ_OUTCOMES, type SystemCapture } from "../../src/church-systems/types.js";
import { asJson, B1_READS, b1Capture, breezeCapture, CHECKED, factsCapture, NOW, readsOf } from "./fixtures.js";

/**
 * No lead rules, and the leader confirmed in Ozzie exactly the zone this capture carries: `mapped` and `run` resolve it
 * per capture. UNCONFIRMED: no zone confirmed.
 */
const NO_LEADS: SystemLeadRules = Object.freeze({ sundayLeads: [] });
const UNCONFIRMED: SystemLeadRules = { sundayLeads: [], confirmedZone: null };
const resolve = (capture: SystemCapture, rules: SystemLeadRules) =>
  rules === NO_LEADS ? { sundayLeads: [], confirmedZone: capture.church.time_zone } : rules;
function mapped(capture: SystemCapture, rules: SystemLeadRules = NO_LEADS, now = NOW): Extract<SystemCoverage, { ok: true }> {
  const result = systemCaptureToCoverage(capture, resolve(capture, rules), now);
  if (!result.ok) throw new Error(result.reason);
  return result;
}
const run = (capture: SystemCapture, rules: SystemLeadRules = NO_LEADS, now = NOW): CoverageResult => evaluateCoverage(mapped(capture, rules, now).input);
const position = (result: CoverageResult, id: string) => result.positions.find(p => p.position_id === id)!;
const disposition = (result: CoverageResult, positionId: string, person: string) =>
  position(result, positionId).candidates.find(c => c.person_id === person)?.disposition ?? "not offered";

/** Every role filled by someone who said yes, and nobody else on either team: nothing left to find. */
function filledB1(over: Partial<SystemCapture> = {}): SystemCapture {
  return b1Capture({
    assignments: [
      { id: "ASN-rowan", position_id: "POS-vocals", person_id: "PER-rowan", status: "accepted", asked: null },
      { id: "ASN-tamsin", position_id: "POS-vocals", person_id: "PER-tamsin", status: "accepted", asked: null },
      { id: "ASN-bram", position_id: "POS-guitar", person_id: "PER-bram", status: "accepted", asked: null },
      { id: "ASN-lark", position_id: "POS-greeter", person_id: "PER-lark", status: "accepted", asked: null },
      { id: "ASN-wren", position_id: "POS-greeter", person_id: "PER-wren", status: "accepted", asked: null },
    ],
    team_members: [],
    ...over,
  });
}

describe("B1 Church through the coverage engine", () => {
  it("counts accepted and unconfirmed as filling, never declined, and lists who hasn't answered", () => {
    const result = run(b1Capture());
    expect(position(result, "POS-vocals")).toMatchObject({ team_id: "GRP-worship", remaining_need: 1, pending_assignment_ids: [], lead: "not-required" });
    expect(position(result, "POS-guitar")).toMatchObject({ remaining_need: 1, pending_assignment_ids: [] });
    expect(position(result, "POS-greeter")).toMatchObject({ remaining_need: 1, pending_assignment_ids: ["ASN-lark"] });
  });

  it("never offers someone already on this service, and never suggests the person blocked out over it", () => {
    const result = run(b1Capture());
    for (const id of ["POS-vocals", "POS-guitar"]) {
      expect(position(result, id).candidates.map(c => c.person_id)).toEqual(["PER-ember", "PER-bram"]);
      expect(disposition(result, id, "PER-ember")).toBe("excluded");
      expect(position(result, id).candidates[0]!.reasons).toContain("Recorded overlapping blockout.");
    }
    expect(disposition(result, "POS-vocals", "PER-tamsin")).toBe("not offered");
  });

  it("suggests the free team member: on B1 Church the role's group is who may serve in it", () => {
    const result = run(b1Capture());
    // Bram's only blockout was the weekend before; Wren has none. Membership, eligibility (the role's group),
    // availability and blockouts all check out, and neither holds an answer on this service.
    for (const [id, person] of [["POS-vocals", "PER-bram"], ["POS-guitar", "PER-bram"], ["POS-greeter", "PER-wren"]] as const) {
      expect(position(result, id).candidates.find(c => c.person_id === person)).toEqual({
        person_id: person, disposition: "suggestion",
        reasons: ["Recorded team membership, role eligibility and availability; no overlapping serving assignment in checked scope. Willingness is not established."],
      });
    }
    // Every read complete, every answer known: open roles and an unanswered request are findings, nothing unverified.
    // The declined answer is a known answer, so it doesn't make the check unverified.
    expect(result.issues).toEqual([]);
    expect(result.status).toBe("findings");
  });

  it("finds open roles when nobody else is on the team, and is clear only when every role is filled and every read is complete", () => {
    expect(run(b1Capture({ team_members: [] })).status).toBe("findings");
    const clear = run(filledB1());
    expect(clear.status).toBe("checked-scope-clear");
    expect(clear.positions.map(p => p.remaining_need)).toEqual([0, 0, 0]);
  });

  it("builds one scope per read from B1 Church, fresh for the same window as a Planning Center check", () => {
    const { input } = mapped(b1Capture());
    expect(input.scopes.map(s => s.scope_id)).toEqual(["b1.plans", "b1.plans_day", "b1.times", "b1.positions", "b1.assignments", "b1.group_members", "b1.blockouts"]);
    for (const scope of input.scopes) {
      expect(scope).toEqual({ scope_id: scope.scope_id, source: "B1 Church", check_time: CHECKED, completeness: "complete",
        valid_until: new Date(Date.parse(CHECKED) + LIVE_CHECK_VALID_MS).toISOString() });
    }
    expect(input.required_scope_ids.slice(0, 4)).toEqual(["b1.plans", "b1.times", "b1.positions", "b1.assignments"]);
    expect(input.evaluated_at).toBe(NOW);
    expect(run(filledB1(), NO_LEADS, "2026-11-20T15:30:01Z").status).toBe("unverified");
  });

  it("gives each position the service's own start and end, every answer that interval, and whether each request was sent", () => {
    const { input } = mapped(b1Capture());
    const vocals = input.positions[0]!;
    expect(vocals.interval).toEqual({ starts_at: "2026-11-22T09:00:00-06:00", ends_at: "2026-11-22T10:30:00-06:00" });
    expect(vocals.assignments.value).toEqual([
      { assignment_id: "ASN-rowan", status: "C", notification: "sent", intervals: [vocals.interval], time_semantics: "verified" },
      { assignment_id: "ASN-tamsin", status: "D", notification: "sent", intervals: [vocals.interval], time_semantics: "verified" },
    ]);
    expect(input.positions[2]!.assignments.value[0]!.status).toBe("U");
    const ember = vocals.candidates[0]!;
    expect(ember).toMatchObject({
      person_id: "PER-ember", membership: { value: true }, eligibility: { value: true }, availability: { value: "unavailable" },
      blockouts: { value: [{ starts_at: "2026-11-21T00:00:00-06:00", ends_at: "2026-11-23T00:00:00-06:00" }] }, assignments: { value: [] },
    });
    expect(vocals.candidates[1]!.availability.value).toBe("available");
  });

  it.each(READ_OUTCOMES.filter(o => o !== "ok"))("a required read that ended %s is never all clear", outcome => {
    for (const word of ["b1.plans", "b1.times", "b1.positions", "b1.assignments"]) {
      const capture = filledB1({ reads: readsOf(["b1.church", "b1.plans", "b1.times", "b1.positions", "b1.assignments", "b1.group_members", "b1.blockouts"], { [word]: outcome }) });
      const result = run(capture);
      expect(result.status, word).toBe("unverified");
      expect(result.issues.some(i => i.code === "scope-unverified" && i.scope_id === word), word).toBe(true);
    }
  });

  it("a required read missing from the capture is never all clear", () => {
    const result = run(filledB1({ reads: readsOf(["b1.plans", "b1.times", "b1.positions"]) }));
    expect(result.status).toBe("unverified");
    expect(result.issues.find(i => i.code === "scope-unverified")?.scope_id).toBe("b1.assignments");
  });

  it("an answer B1 gave in a word Ozzie doesn't know is never all clear, and its role's need isn't counted", () => {
    const capture = filledB1();
    const result = run({ ...capture, assignments: capture.assignments.map(a => a.id === "ASN-bram" ? { ...a, status: "unknown" as const } : a) });
    expect(result.status).toBe("unverified");
    expect(position(result, "POS-guitar").remaining_need).toBeNull();
    expect(result.issues.map(i => i.code)).toContain("assignment-unverified");
  });

  it("with no end time the service's interval is unknown: positions and answers unverified", () => {
    const capture = filledB1({ service: { id: "PLA0000nov22", day: "2026-11-22", starts_at: "2026-11-22T09:00:00-06:00", ends_at: null, shared: null } });
    const { input } = mapped(capture);
    expect(input.positions.every(p => p.interval === null)).toBe(true);
    expect(input.positions[0]!.assignments.value[0]).toMatchObject({ intervals: [], time_semantics: "unverified" });
    const result = evaluateCoverage(input);
    expect(result.status).toBe("unverified");
    expect(result.issues.filter(i => i.code === "time-unverified").map(i => i.position_id)).toEqual(["POS-vocals", "POS-guitar", "POS-greeter"]);
  });

  it("a role with no wanted number has an unknown need, never zero", () => {
    const capture = filledB1();
    const result = run({ ...capture, positions: capture.positions.map(p => p.id === "POS-guitar" ? { ...p, needed: null } : p) });
    expect(position(result, "POS-guitar").remaining_need).toBeNull();
    expect(result.status).toBe("unverified");
  });

  it("blockouts not fully read leave availability unknown, never available", () => {
    const capture = b1Capture({ reads: readsOf(["b1.plans", "b1.times", "b1.positions", "b1.assignments", "b1.group_members", "b1.blockouts"], { "b1.blockouts": "truncated" }) });
    const { input } = mapped(capture);
    for (const candidate of input.positions[0]!.candidates) {
      expect(candidate.availability.value).toBe("unknown");
      expect(candidate.blockouts.value).toBeNull();
    }
    expect(evaluateCoverage(input).positions[0]!.candidates.map(c => c.disposition)).toEqual(["unverified", "unverified"]);
  });

  it("team members not fully read leave the people offered unverified", () => {
    const capture = b1Capture({ reads: readsOf(["b1.plans", "b1.times", "b1.positions", "b1.assignments", "b1.group_members", "b1.blockouts"], { "b1.group_members": "timeout" }) });
    const result = run(capture);
    expect(result.positions.flatMap(p => p.candidates.map(c => c.disposition)).every(d => d !== "suggestion")).toBe(true);
    expect(result.status).toBe("unverified");
  });

  it("takes the Sunday lead from Church rules, by the lead role's name in this system", () => {
    const rules: SystemLeadRules = { sundayLeads: [{ team_id: "GRP-worship", lead_position: "Vocals" }], confirmedZone: "America/Chicago" };
    const { input } = mapped(filledB1(), rules);
    expect(input.positions[1]!.lead.value).toEqual({ mapping: "required", assignment_ids: ["ASN-rowan", "ASN-tamsin"] });
    expect(input.positions[2]!.lead.value).toEqual({ mapping: "not-required", assignment_ids: [] });
    const result = run(filledB1(), rules);
    expect(result.positions.map(p => p.lead)).toEqual(["confirmed", "confirmed", "not-required"]);
    expect(result.status).toBe("checked-scope-clear");
    // A lead role nobody on the service holds is missing.
    expect(run(filledB1(), { sundayLeads: [{ team_id: "GRP-worship", lead_position: "Worship Leader" }], confirmedZone: "America/Chicago" }).positions[1]!.lead).toBe("missing");
  });

  it("can't tell the lead when a role on the team has no name: unverified, not missing", () => {
    const capture = filledB1();
    const labels = { ...capture.labels };
    delete labels["position:POS-guitar"];
    const result = run({ ...capture, labels }, { sundayLeads: [{ team_id: "GRP-worship", lead_position: "Worship Leader" }] });
    expect(result.positions.map(p => p.lead)).toEqual(["unverified", "unverified", "not-required"]);
    expect(result.status).toBe("unverified");
  });

  it("refuses to build a Sunday check from Genesis, or from a capture with no service", () => {
    expect(systemCaptureToCoverage(factsCapture("genesis"), NO_LEADS, NOW)).toEqual({ ok: false, reason: "no-sunday-check" });
    expect(systemCaptureToCoverage(b1Capture({ service: null }), NO_LEADS, NOW)).toEqual({ ok: false, reason: "no-service" });
    expect(systemCaptureToCoverage(breezeCapture({ service: null }), NO_LEADS, NOW)).toEqual({ ok: false, reason: "no-service" });
  });
});

describe("Breeze through the coverage engine", () => {
  /** A Breeze capture handed straight to the mapper with a tagged team on one role: native never sends this today. */
  const tagged = (over: Partial<SystemCapture> = {}) => breezeCapture({
    positions: [{ id: "9627", team_id: null, needed: 2 }, { id: "9628", team_id: "y_16681", needed: 1 }],
    team_members: [{ team_id: "y_16681", person_id: "157802" }, { team_id: "y_16681", person_id: "157803" }],
    ...over,
  });

  it("has no blockouts, so whoever could help is unverified, never suggested", () => {
    const { input } = mapped(tagged());
    const usher = input.positions[1]!;
    expect(usher.candidates.map(c => c.person_id)).toEqual(["157803"]);
    expect(usher.candidates[0]).toMatchObject({ availability: { value: "unknown" }, blockouts: { value: null } });
    const result = evaluateCoverage(input);
    expect(position(result, "9628").candidates[0]!.disposition).toBe("unverified");
    expect(result.status).toBe("unverified");
  });

  it("never suggests anyone from Breeze, even with every read complete and every answer known: tags aren't eligibility", () => {
    // The most favourable Breeze capture there can be, past what the parser takes: all reads ok, every answer
    // accepted, a free tagged person, an empty list of other commitments.
    const capture = tagged({ busy: [], assignments: [
      { id: "71001", position_id: "9627", person_id: "157801", status: "accepted", asked: null },
      { id: "71002", position_id: "9628", person_id: "157802", status: "accepted", asked: null }] });
    const { input } = mapped(capture);
    const sorrel = input.positions[1]!.candidates[0]!;
    expect(sorrel).toMatchObject({ person_id: "157803", membership: { value: true }, eligibility: { value: null } });
    const result = evaluateCoverage(input);
    expect(result.positions.flatMap(p => p.candidates.map(c => c.disposition))).toEqual(["unverified"]);
    expect(result.positions[1]!.candidates[0]!.reasons).toEqual(expect.arrayContaining([
      "Required role eligibility couldn't be verified.", "Blockouts couldn't be verified.",
    ]));
    expect(result.status).toBe("unverified");
  });

  it("an answer code Breeze doesn't document stays unknown: no role's need is counted and nothing is clear", () => {
    const result = run(breezeCapture());
    expect(position(result, "9627")).toMatchObject({ team_id: "?", remaining_need: null, candidates: [] });
    expect(position(result, "9628")).toMatchObject({ team_id: "?", remaining_need: null, candidates: [] });
    expect(result.issues.filter(i => i.code === "assignment-unverified").map(i => i.position_id)).toEqual(["9627", "9628"]);
    expect(result.status).toBe("unverified");
  });

  it("with real answers (confirmed live: no response, declined, accepted), parses and counts them like any system's", () => {
    const parsed = parseSystemCapture(asJson(breezeCapture({ assignments: [
      { id: "71001", position_id: "9627", person_id: "157801", status: "accepted", asked: null },
      { id: "71002", position_id: "9628", person_id: "157802", status: "unconfirmed", asked: null }] })));
    if (!parsed.ok) throw new Error(parsed.reason);
    const result = run(parsed.capture);
    expect(result.positions.map(p => [p.position_id, p.remaining_need, p.pending_assignment_ids])).toEqual([
      ["9627", 1, []], ["9628", 0, ["71002"]]]);
    expect(result.issues).toEqual([]);
    expect(result.status).toBe("findings");
  });

  it("names Breeze as the source, and its required reads are the event, its roles and its volunteers", () => {
    const { input, source, zone_needs_confirming } = mapped(breezeCapture());
    expect(source).toBe("Breeze");
    expect(zone_needs_confirming).toBe(false);
    expect(input.scopes.every(s => s.source === "Breeze")).toBe(true);
    expect(input.required_scope_ids.slice(0, 3)).toEqual(["breeze.events", "breeze.roles", "breeze.volunteers"]);
    const failed = run(breezeCapture({ reads: readsOf(["breeze.events", "breeze.roles", "breeze.volunteers"], { "breeze.volunteers": "key-refused" }) }));
    expect(failed.status).toBe("unverified");
  });
});

describe("read outcomes", () => {
  it("map to completeness the way Planning Center outcomes do", () => {
    expect(Object.fromEntries(READ_OUTCOMES.map(o => [o, completenessOf([o])]))).toEqual({
      ok: "complete", truncated: "partial", "not-requested": "unreadable", refused: "denied", "not-found": "unreadable",
      "rate-limited": "unreadable", timeout: "unreadable", unreachable: "unreadable", "too-large": "unreadable",
      "invalid-response": "unverified", "key-refused": "denied",
    });
  });

  it("across a read's pages, the worst one wins", () => {
    expect(completenessOf(["ok", "ok"])).toBe("complete");
    expect(completenessOf(["ok", "truncated"])).toBe("partial");
    expect(completenessOf(["truncated", "timeout"])).toBe("unreadable");
    expect(completenessOf(["timeout", "invalid-response"])).toBe("unverified");
    expect(completenessOf(["invalid-response", "refused", "ok"])).toBe("denied");
    expect(completenessOf([])).toBe("unreadable");
  });

  it("each page of one read is one scope", () => {
    const capture = filledB1({ reads: [...readsOf(["b1.plans", "b1.times", "b1.positions", "b1.assignments"]),
      { read: "b1.assignments", checked_at: "2026-11-20T14:59:59Z", outcome: "truncated" }] });
    const { input } = mapped(capture);
    expect(input.scopes.filter(s => s.scope_id === "b1.assignments")).toEqual([expect.objectContaining({ completeness: "partial", check_time: "2026-11-20T14:59:59Z" })]);
    expect(evaluateCoverage(input).status).toBe("unverified");
  });
});

describe("the service's real day", () => {
  it("names a Wednesday evening service Wednesday, from the system's own day or from its time in the church's zone", () => {
    for (const day of ["2026-11-25", null]) {
      const result = mapped(b1Capture({ service: { id: "PLA-wed", day, starts_at: "2026-11-25T18:30:00-06:00", ends_at: "2026-11-25T20:00:00-06:00", shared: true } }));
      expect(result.time_zone).toBe("America/Chicago");
      expect(result.day, String(day)).toMatchObject({ kind: "weekday", weekday: 3, day: "Wednesday", question: "Is Wednesday covered?", date: "Wednesday, November 25" });
    }
  });

  it("with no day from the system, keeps a Sunday evening service on Sunday though it starts on Monday in UTC", () => {
    const capture = b1Capture({ church: { id: "CHU0000cedar", time_zone: "America/Los_Angeles" },
      service: { id: "PLA-eve", day: null, starts_at: "2026-11-22T19:00:00-08:00", ends_at: "2026-11-22T20:30:00-08:00", shared: null } });
    expect(new Date(capture.service!.starts_at).getUTCDay()).toBe(1);
    const result = mapped(capture);
    expect(result.time_zone).toBe("America/Los_Angeles");
    expect(result.day).toMatchObject({ weekday: 0, day: "Sunday", date: "Sunday, November 22" });
  });

  it("names a Sunday plan Sunday though its first time is Saturday evening (M1)", () => {
    // A Sunday plan whose earliest time is a Saturday 7:00 PM rehearsal (Chicago), through Sunday's 9:00 AM service.
    const service = { id: "PLA-sun", day: "2026-11-22", starts_at: "2026-11-22T01:00:00Z", ends_at: "2026-11-22T16:30:00Z", shared: null };
    expect(mapped(b1Capture({ service })).day).toMatchObject({ weekday: 0, day: "Sunday", date: "Sunday, November 22" });
    // Without the system's own day, the first time read names it: Saturday.
    expect(mapped(b1Capture({ service: { ...service, day: null } })).day).toMatchObject({ weekday: 6, day: "Saturday" });
  });

  it("names the system's own day with no zone math (Breeze), and no day when there is neither a day nor a zone", () => {
    expect(mapped(breezeCapture({ church: { id: "juniperstreet", time_zone: null } })).day).toMatchObject({ weekday: 0, day: "Sunday" });
    const service = { id: "88120031", day: null, starts_at: "2026-11-22T10:30:00-05:00", ends_at: "2026-11-22T12:00:00-05:00", shared: null };
    const result = mapped(breezeCapture({ church: { id: "juniperstreet", time_zone: null }, service }));
    expect(result.time_zone).toBeNull();
    expect(result.day).toMatchObject({ kind: "unknown", weekday: null, day: "your service" });
  });

  it("asks once to confirm a B1 Church time zone, which may be B1's default (M2)", () => {
    expect(mapped(b1Capture(), UNCONFIRMED).zone_needs_confirming).toBe(true);
    expect(mapped(b1Capture()).zone_needs_confirming).toBe(false);
    // With no zone from B1, Ozzie asks which zone the church meets in (facts.ts toConfirm), confirmed or not.
    expect(mapped(b1Capture({ church: { id: "CHU0000cedar", time_zone: null } }), UNCONFIRMED).zone_needs_confirming).toBe(true);
    expect(mapped(b1Capture({ church: { id: "CHU0000cedar", time_zone: null } }), NO_LEADS).zone_needs_confirming).toBe(true);
    expect(mapped(breezeCapture()).zone_needs_confirming).toBe(false);
  });
});

describe("Review B findings, through the real engine", () => {
  it("H1: the same person twice on one role fills one place, with no issue raised", () => {
    const capture = b1Capture({
      positions: [{ id: "POS-vocals", team_id: "GRP-worship", needed: 2 }, { id: "POS-guitar", team_id: "GRP-worship", needed: 1 }],
      assignments: [
        { id: "ASN-1", position_id: "POS-vocals", person_id: "PER-rowan", status: "accepted", asked: null },
        { id: "ASN-2", position_id: "POS-vocals", person_id: "PER-rowan", status: "unconfirmed", asked: null },
        // On two different roles the same person really fills both.
        { id: "ASN-3", position_id: "POS-guitar", person_id: "PER-rowan", status: "accepted", asked: null },
      ],
      team_members: [],
    });
    const result = run(capture);
    expect(result.positions.map(p => [p.position_id, p.remaining_need])).toEqual([["POS-vocals", 1], ["POS-guitar", 0]]);
    expect(result.issues).toEqual([]);
    expect(result.status).toBe("findings");
  });

  it("H3: someone busy elsewhere at the same time is not suggested; their other commitment is a confirmed one", () => {
    const capture = b1Capture({ busy: [
      { person_id: "PER-rowan", starts_at: "2026-11-22T11:00:00-06:00", ends_at: "2026-11-22T12:00:00-06:00", answer: "accepted" },
      { person_id: "PER-bram", starts_at: "2026-11-22T09:30:00-06:00", ends_at: "2026-11-22T10:00:00-06:00", answer: "accepted" },
      { person_id: "PER-bram", starts_at: "2026-11-22T13:00:00-06:00", ends_at: "2026-11-22T14:00:00-06:00", answer: "accepted" },
    ] });
    const { input } = mapped(capture);
    expect(input.positions[0]!.candidates[1]!.assignments).toEqual({ scope_id: "b1.plans_day", value: [
      { assignment_id: "busy:1", status: "C", notification: "unknown", time_semantics: "verified",
        intervals: [{ starts_at: "2026-11-22T09:30:00-06:00", ends_at: "2026-11-22T10:00:00-06:00" }] },
      { assignment_id: "busy:2", status: "C", notification: "unknown", time_semantics: "verified",
        intervals: [{ starts_at: "2026-11-22T13:00:00-06:00", ends_at: "2026-11-22T14:00:00-06:00" }] },
    ] });
    const result = evaluateCoverage(input);
    expect(disposition(result, "POS-vocals", "PER-bram")).toBe("excluded");
    expect(position(result, "POS-vocals").candidates[1]!.reasons).toContain("Confirmed overlapping serving assignment.");
    // Wren isn't busy: still a suggestion.
    expect(disposition(result, "POS-greeter", "PER-wren")).toBe("suggestion");
  });

  it("H3: with other commitments not read, nobody is suggested", () => {
    const cases: [string, SystemCapture][] = [
      ["busy null", b1Capture({ busy: null })],
      ["read failed", b1Capture({ reads: readsOf(B1_READS, { "b1.plans_day": "timeout" }) })],
      ["read cut short", b1Capture({ reads: readsOf(B1_READS, { "b1.plans_day": "truncated" }) })],
      ["read missing", b1Capture({ reads: readsOf(B1_READS.filter(w => w !== "b1.plans_day")) })],
    ];
    for (const [label, capture] of cases) {
      const result = run(capture);
      for (const [id, person] of [["POS-vocals", "PER-bram"], ["POS-greeter", "PER-wren"]] as const) {
        expect(disposition(result, id, person), label).toBe("unverified");
        expect(position(result, id).candidates.find(c => c.person_id === person)!.reasons, label).toContain("Serving assignments couldn't be verified.");
      }
      expect(result.status, label).toBe("unverified");
    }
  });

  it("C-M3: an unanswered request elsewhere is a possible conflict, worded as the Planning Center path words it", () => {
    const capture = b1Capture({ busy: [
      { person_id: "PER-bram", starts_at: "2026-11-22T09:30:00-06:00", ends_at: "2026-11-22T10:00:00-06:00", answer: "unconfirmed" },
    ] });
    const { input } = mapped(capture);
    expect(input.positions[0]!.candidates[1]!.assignments.value).toEqual([{ assignment_id: "busy:0", status: "U", notification: "unknown",
      time_semantics: "verified", intervals: [{ starts_at: "2026-11-22T09:30:00-06:00", ends_at: "2026-11-22T10:00:00-06:00" }] }]);
    const bram = position(evaluateCoverage(input), "POS-vocals").candidates.find(c => c.person_id === "PER-bram")!;
    // Casey in the fictional Planning Center Sunday holds an unanswered request on another plan at the same time.
    const pco = captureToCoverage(nov22Capture(), { sundayLeads: [], checkInAfterSundaysInARow: 0 }, "2026-11-20T15:10:00Z");
    const casey = evaluateCoverage(pco.input).positions.flatMap(p => p.candidates).find(c => c.person_id === PEOPLE.casey)!;
    expect(casey.disposition).toBe("possible-conflict");
    expect(bram).toEqual({ ...casey, person_id: "PER-bram" });
    expect(bram.reasons).toEqual(["Possible conflict: unconfirmed scheduling record; sending couldn't be verified."]);
    expect(bram.reasons).not.toContain("Confirmed overlapping serving assignment.");
  });

  it("C-M2: with no day from the system, an Auckland Sunday service is Sunday in the church's zone", () => {
    // B1 saved the plan a day early for this church, so native sends no day. Sunday 10:00 NZDT is Saturday 21:00 UTC.
    const capture = b1Capture({ church: { id: "CHU0000cedar", time_zone: "Pacific/Auckland" },
      service: { id: "PLA-akl", day: null, starts_at: "2026-11-21T21:00:00.000Z", ends_at: "2026-11-21T22:30:00.000Z", shared: null } });
    expect(mapped(capture).day).toMatchObject({ weekday: 0, day: "Sunday", date: "Sunday, November 22" });
  });

  it("a time zone this Mac doesn't know is no zone: no day guessed from it, and flagged", () => {
    // Breeze: the zone only names the day, so the check itself is unchanged.
    const nowhere = { id: "juniperstreet", time_zone: "America/Nowhere" };
    const noDay = breezeCapture({ church: nowhere, service: { id: "88120031", day: null, starts_at: "2026-11-22T10:30:00-05:00", ends_at: "2026-11-22T12:00:00-05:00", shared: null } });
    const result = mapped(noDay);
    expect(result).toMatchObject({ time_zone: null, zone_unknown: true, zone_needs_confirming: false, waiting_for_zone: false });
    expect(result.day).toMatchObject({ kind: "unknown", day: "your service" });
    expect(mapped(breezeCapture({ church: nowhere })).day).toMatchObject({ day: "Sunday" });
    expect(evaluateCoverage(result.input)).toEqual(evaluateCoverage(mapped(breezeCapture({ service: noDay.service })).input));
    // B1: a zone this Mac doesn't know is held back like no zone, even when "confirmed".
    const b1 = mapped(b1Capture({ church: { id: "CHU0000cedar", time_zone: "America/Nowhere" } }), NO_LEADS);
    expect(b1).toMatchObject({ time_zone: null, zone_unknown: true, waiting_for_zone: true, zone_needs_confirming: true });
    expect(mapped(b1Capture()).zone_unknown).toBe(false);
    expect(mapped(b1Capture({ church: { id: "CHU0000cedar", time_zone: null } })).zone_unknown).toBe(false);
  });

  it("H2: a B1 blockout read cut short (its last day under way) leaves availability unknown, and nobody is suggested", () => {
    // Saturday 8:00 PM Central: B1 no longer lists Ember's blockout that ends Sunday, so native marks the read truncated.
    const capture = b1Capture({
      started_at: "2026-11-22T01:59:58Z", completed_at: "2026-11-22T02:00:04Z",
      reads: B1_READS.map(read => ({ read, checked_at: "2026-11-22T02:00:00Z", outcome: read === "b1.blockouts" ? "truncated" as const : "ok" as const })),
      team_members: [{ team_id: "GRP-worship", person_id: "PER-ember" }],
      blockouts: [],
    });
    const { input } = mapped(capture, NO_LEADS, "2026-11-22T02:05:00Z");
    expect(input.positions[0]!.candidates[0]).toMatchObject({ person_id: "PER-ember", availability: { value: "unknown" }, blockouts: { value: null } });
    const result = evaluateCoverage(input);
    expect(disposition(result, "POS-vocals", "PER-ember")).toBe("unverified");
    expect(result.status).toBe("unverified");
  });

  it("L4: a capture at every cap maps in under 2 seconds", () => {
    const team = Array.from({ length: 2000 }, (_, i) => `PER${i}`);
    const capture = b1Capture({
      positions: Array.from({ length: 200 }, (_, i) => ({ id: `POS${i}`, team_id: "GRP-all", needed: 3 })),
      // No one assigned, so every team member is offered on every role: the review's worst case, 400,000 candidates.
      assignments: [],
      team_members: team.map(person_id => ({ team_id: "GRP-all", person_id })),
      blockouts: team.map(person_id => ({ person_id, starts_at: "2026-11-14T00:00:00-06:00", ends_at: "2026-11-15T00:00:00-06:00" })),
      busy: team.map(person_id => ({ person_id, starts_at: "2026-11-22T13:00:00-06:00", ends_at: "2026-11-22T14:00:00-06:00", answer: "accepted" as const })),
      labels: {}, names: {},
    });
    const started = performance.now();
    const { input } = mapped(capture);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(input.positions.reduce((n, p) => n + p.candidates.length, 0)).toBe(200 * 2000);
  });
});

describe("Final check findings, through the real engine", () => {
  it.each<[string, SystemCapture]>([
    ["failed", b1Capture({ team_members: [], reads: readsOf(B1_READS, { "b1.group_members": "timeout" }) })],
    ["cut short", b1Capture({ team_members: [], reads: readsOf(B1_READS, { "b1.group_members": "truncated" }) })],
    ["skipped", b1Capture({ team_members: [], reads: readsOf(B1_READS, { "b1.group_members": "not-requested" }) })],
    ["missing", b1Capture({ team_members: [], reads: readsOf(B1_READS.filter(w => w !== "b1.group_members")) })],
  ])("M1: a team read that %s never looks like nobody on the team is free", (_, capture) => {
    const result = run(capture);
    expect(result.status).toBe("unverified");
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "scope-unverified", scope_id: "b1.group_members" }));
    // The roles' own needs are still read.
    expect(result.positions.map(p => p.remaining_need)).toEqual([1, 1, 1]);
  });

  it("M1: with no role tied to a team, the team read isn't needed", () => {
    const capture = b1Capture({ positions: [{ id: "POS-vocals", team_id: null, needed: 2 }], labels: {},
      assignments: [{ id: "ASN-rowan", position_id: "POS-vocals", person_id: "PER-rowan", status: "accepted", asked: null }],
      team_members: [], reads: readsOf(B1_READS.filter(w => w !== "b1.group_members")) });
    const result = run(capture);
    expect(result.issues).toEqual([]);
    expect(result.status).toBe("findings");
  });

  /**
   * A New Zealand church whose B1 Church account still shows B1's default zone, America/New_York. B1 saved the plan a
   * day early (Saturday 21 November); Sunday 10:00 NZDT is Saturday 21:00 UTC. Native placed Drew's Sunday blockout in
   * the default zone, so it misses the service.
   */
  const nzDefault = b1Capture({
    church: { id: "CHU0000cedar", time_zone: "America/New_York" },
    service: { id: "PLA-nz", day: "2026-11-21", starts_at: "2026-11-21T21:00:00Z", ends_at: "2026-11-21T22:30:00Z", shared: null },
    busy: [], assignments: [], team_members: [{ team_id: "GRP-worship", person_id: "PER-ember" }], names: {}, labels: {},
    blockouts: [{ person_id: "PER-ember", starts_at: "2026-11-22T05:00:00Z", ends_at: "2026-11-23T05:00:00Z" }],
  });

  it("B1 default zone, unconfirmed: no suggestion from blockouts placed in that zone, and no day named", () => {
    const result = mapped(nzDefault, UNCONFIRMED);
    expect(result).toMatchObject({ time_zone: "America/New_York", zone_needs_confirming: true });
    expect(result.day).toMatchObject({ kind: "unknown", weekday: null, day: "your service" });
    expect(result.input.positions[0]!.candidates[0]).toMatchObject({ availability: { value: "unknown" }, blockouts: { value: null } });
    const evaluated = evaluateCoverage(result.input);
    expect(disposition(evaluated, "POS-vocals", "PER-ember")).toBe("unverified");
    expect(evaluated.status).toBe("unverified");
  });

  it("B1 zone confirmed as the church's real one: blockouts count and the day is right", () => {
    // Confirmed as Pacific/Auckland, native places the blockout in that zone and sends no day (B1 saves it a day early there).
    const confirmed = b1Capture({ ...nzDefault, church: { id: "CHU0000cedar", time_zone: "Pacific/Auckland" },
      service: { ...nzDefault.service!, day: null },
      blockouts: [{ person_id: "PER-ember", starts_at: "2026-11-21T11:00:00Z", ends_at: "2026-11-22T11:00:00Z" }] });
    const result = mapped(confirmed, NO_LEADS);
    expect(result.zone_needs_confirming).toBe(false);
    expect(result.day).toMatchObject({ weekday: 0, day: "Sunday", date: "Sunday, November 22" });
    expect(disposition(evaluateCoverage(result.input), "POS-vocals", "PER-ember")).toBe("excluded");
    // A Chicago church whose zone is confirmed: as before.
    expect(mapped(b1Capture(), NO_LEADS).day).toMatchObject({ day: "Sunday" });
    expect(mapped(b1Capture(), UNCONFIRMED).day).toMatchObject({ day: "your service" });
  });
});

describe("review D L6: a B1 Church zone not yet confirmed holds back the plan's times", () => {
  it("unconfirmed: no role reads as covered, nobody is suggested, and the reason is a closed issue", () => {
    const result = mapped(filledB1({ team_members: b1Capture().team_members }), UNCONFIRMED);
    expect(result.waiting_for_zone).toBe(true);
    expect(ZONE_CONFIRMATION_SCOPE).toBe("b1.zone-confirmation");
    expect(result.input.positions.every(p => p.interval === null)).toBe(true);
    expect(result.input.positions[0]!.assignments.value[0]).toMatchObject({ intervals: [], time_semantics: "unverified" });
    const evaluated = evaluateCoverage(result.input);
    expect(evaluated.status).toBe("unverified");
    expect(evaluated.issues).toContainEqual(expect.objectContaining({ code: "scope-unverified", scope_id: "b1.zone-confirmation" }));
    expect(evaluated.issues.filter(i => i.code === "time-unverified").map(i => i.position_id)).toEqual(["POS-vocals", "POS-guitar", "POS-greeter"]);
    expect(evaluated.positions.flatMap(p => p.candidates.map(c => c.disposition)).every(d => d !== "suggestion")).toBe(true);
    // The same plan, all filled with nobody else on a team, is all clear once the zone is confirmed.
    expect(run(filledB1(), UNCONFIRMED).status).toBe("unverified");
    expect(run(filledB1(), NO_LEADS).status).toBe("checked-scope-clear");
  });

  it("confirmed: as before, with nothing held back", () => {
    const result = mapped(b1Capture(), NO_LEADS);
    expect(result.waiting_for_zone).toBe(false);
    const evaluated = evaluateCoverage(result.input);
    expect(evaluated.issues.some(i => i.scope_id === "b1.zone-confirmation" || i.code === "time-unverified")).toBe(false);
    expect(disposition(evaluated, "POS-greeter", "PER-wren")).toBe("suggestion");
  });

  it("re-check N1: a B1 church with no time zone is held back too, until a zone is confirmed (the Auckland no-zone probe)", () => {
    // An Auckland church with no zone in B1: the plan stored as Saturday 21 November, the service Sunday 10:00 NZDT
    // (Saturday 21:00 UTC). With no zone, native places Ember's Sunday blockout on the UTC day, so it misses the
    // service; before this fix Ember was suggested with every read ok and no issue.
    const capture = b1Capture({
      church: { id: "CHU0000cedar", time_zone: null },
      service: { id: "PLA-akl", day: "2026-11-21", starts_at: "2026-11-21T21:00:00Z", ends_at: "2026-11-21T22:15:00Z", shared: null },
      busy: [], assignments: [], team_members: [{ team_id: "GRP-worship", person_id: "PER-ember" }], names: {}, labels: {},
      blockouts: [{ person_id: "PER-ember", starts_at: "2026-11-22T00:00:00Z", ends_at: "2026-11-23T00:00:00Z" }],
    });
    for (const rules of [UNCONFIRMED, NO_LEADS]) {
      const result = mapped(capture, rules);
      expect(result).toMatchObject({ waiting_for_zone: true, zone_needs_confirming: true, time_zone: null });
      expect(result.day).toMatchObject({ kind: "unknown", day: "your service" });
      expect(result.input.positions.every(p => p.interval === null)).toBe(true);
      const evaluated = evaluateCoverage(result.input);
      expect(evaluated.status).toBe("unverified");
      expect(evaluated.issues).toContainEqual(expect.objectContaining({ code: "scope-unverified", scope_id: ZONE_CONFIRMATION_SCOPE }));
      expect(disposition(evaluated, "POS-vocals", "PER-ember")).toBe("unverified");
    }
    // Once the leader gives the zone, native emits it in the capture; confirmed, the check runs.
    const given = b1Capture({ ...capture, church: { id: "CHU0000cedar", time_zone: "Pacific/Auckland" },
      service: { ...capture.service!, day: null },
      blockouts: [{ person_id: "PER-ember", starts_at: "2026-11-21T11:00:00Z", ends_at: "2026-11-22T11:00:00Z" }] });
    const confirmed = mapped(given, NO_LEADS);
    expect(confirmed.waiting_for_zone).toBe(false);
    expect(disposition(evaluateCoverage(confirmed.input), "POS-vocals", "PER-ember")).toBe("excluded");
  });

  it("re-check N1: the fixture church with no zone is held back, and nobody is suggested", () => {
    const result = mapped(b1Capture({ church: { id: "CHU0000cedar", time_zone: null } }), NO_LEADS);
    expect(result.waiting_for_zone).toBe(true);
    const evaluated = evaluateCoverage(result.input);
    expect(evaluated.status).toBe("unverified");
    expect(evaluated.positions.flatMap(p => p.candidates.map(c => c.disposition)).every(d => d !== "suggestion")).toBe(true);
  });

  it("Breeze has no zone to confirm, so nothing is held back", () => {
    expect(mapped(breezeCapture(), UNCONFIRMED).waiting_for_zone).toBe(false);
  });
});

describe("a service whose planning has no roles", () => {
  const empty = { positions: [], assignments: [], team_members: [], busy: [], blockouts: [], names: {},
    labels: { church: "Cedar Hollow Fellowship", service: "Sunday Gathering" } };

  it("says there are no roles, from B1 Church and from Breeze, when the roles and answers were read whole", () => {
    expect(systemCaptureToCoverage(b1Capture(empty), NO_LEADS, NOW)).toEqual({ ok: false, reason: "no-roles" });
    expect(systemCaptureToCoverage(breezeCapture({ ...empty, busy: null, blockouts: null, labels: { church: "Juniper Street Church" } }), NO_LEADS, NOW))
      .toEqual({ ok: false, reason: "no-roles" });
  });

  it.each(["truncated", "timeout", "not-requested", "invalid-response"] as const)("a roles read that ended %s is unverified, never no roles", outcome => {
    const result = run(b1Capture({ ...empty, reads: readsOf(B1_READS, { "b1.positions": outcome }) }));
    expect(result.status).toBe("unverified");
  });

  it.each(["truncated", "timeout"] as const)("an answers read that ended %s is unverified, never no roles", outcome => {
    expect(run(b1Capture({ ...empty, reads: readsOf(B1_READS, { "b1.assignments": outcome }) })).status).toBe("unverified");
  });

  it("a roles read missing from the capture is unverified, never no roles", () => {
    expect(run(b1Capture({ ...empty, reads: readsOf(B1_READS.filter(w => w !== "b1.positions")) })).status).toBe("unverified");
  });
});

describe("review D second re-check: a confirmation names its zone", () => {
  /** The capture made with Pacific/Auckland given (Sunday 10:00 NZDT), Ember blocked out that Sunday, Wren free. */
  const auckland = b1Capture({
    church: { id: "CHU0000cedar", time_zone: "Pacific/Auckland" },
    service: { id: "PLA-akl", day: "2026-11-22", starts_at: "2026-11-21T21:00:00Z", ends_at: "2026-11-21T22:15:00Z", shared: null },
    busy: [], assignments: [],
    team_members: [{ team_id: "GRP-worship", person_id: "PER-ember" }, { team_id: "GRP-hosp", person_id: "PER-wren" }],
    names: {}, labels: {},
    blockouts: [{ person_id: "PER-ember", starts_at: "2026-11-21T11:00:00Z", ends_at: "2026-11-22T11:00:00Z" }],
  });

  it("N7 probe 1: the Auckland capture relabelled America/Chicago, with Pacific/Auckland confirmed, is held back as a mismatch", () => {
    const relabelled = b1Capture({ ...auckland, church: { id: "CHU0000cedar", time_zone: "America/Chicago" } });
    const result = mapped(relabelled, { sundayLeads: [], confirmedZone: "Pacific/Auckland" });
    expect(result).toMatchObject({ waiting_for_zone: true, zone_mismatch: true, zone_needs_confirming: false });
    expect(result.day).toMatchObject({ kind: "unknown", day: "your service" });
    const evaluated = evaluateCoverage(result.input);
    expect(evaluated.status).toBe("unverified");
    expect(evaluated.issues).toContainEqual(expect.objectContaining({ code: "scope-unverified", scope_id: ZONE_CONFIRMATION_SCOPE }));
    expect(disposition(evaluated, "POS-greeter", "PER-wren")).toBe("unverified");
    // The matching capture runs.
    const matching = mapped(auckland, { sundayLeads: [], confirmedZone: "Pacific/Auckland" });
    expect(matching).toMatchObject({ waiting_for_zone: false, zone_mismatch: false });
    expect(disposition(evaluateCoverage(matching.input), "POS-vocals", "PER-ember")).toBe("excluded");
  });

  it("N7 probe 2: the Auckland church left on America/New_York with nothing confirmed is held back and asked about", () => {
    // Native took the Saturday rehearsal through Sunday's end on B1's stored day, in B1's default zone.
    const leftOnDefault = b1Capture({ ...auckland, church: { id: "CHU0000cedar", time_zone: "America/New_York" },
      service: { id: "PLA-akl", day: "2026-11-21", starts_at: "2026-11-21T06:00:00Z", ends_at: "2026-11-21T22:15:00Z", shared: null },
      blockouts: [{ person_id: "PER-ember", starts_at: "2026-11-22T05:00:00Z", ends_at: "2026-11-23T05:00:00Z" }] });
    for (const confirmedZone of [null, "Pacific/Auckland"]) {
      const result = mapped(leftOnDefault, { sundayLeads: [], confirmedZone });
      expect(result.waiting_for_zone).toBe(true);
      expect(result.zone_mismatch).toBe(confirmedZone !== null);
      expect(result.zone_needs_confirming).toBe(confirmedZone === null);
      expect(disposition(evaluateCoverage(result.input), "POS-vocals", "PER-ember")).toBe("unverified");
    }
    // A wrong "yes" to B1's default can't be told apart from a right one: it runs, which is why the question shows
    // what the zone makes of this plan (facts.ts toConfirm).
    expect(mapped(leftOnDefault, { sundayLeads: [], confirmedZone: "America/New_York" }).waiting_for_zone).toBe(false);
  });

  it("a confirmed zone this Mac doesn't know confirms nothing, and a capture with no zone never matches", () => {
    expect(mapped(auckland, { sundayLeads: [], confirmedZone: "Pacific/Nowhere" })).toMatchObject({ waiting_for_zone: true, zone_mismatch: false });
    const noZone = b1Capture({ ...auckland, church: { id: "CHU0000cedar", time_zone: null } });
    expect(mapped(noZone, { sundayLeads: [], confirmedZone: "Pacific/Auckland" })).toMatchObject({ waiting_for_zone: true, zone_mismatch: true });
    expect(mapped(breezeCapture(), { sundayLeads: [], confirmedZone: "Pacific/Auckland" })).toMatchObject({ waiting_for_zone: false, zone_mismatch: false });
  });

  it("third re-check N10: a zone in another case than its canonical spelling counts for nothing (the reviewer's probe)", () => {
    // An Auckland church with no zone in B1; the caller gave "Pacific/auckland". Native's zone data doesn't know that
    // spelling, so it fell back to B1's stored day (Saturday) and placed Ember's Sunday blockout on the UTC day, which
    // misses the service. Before this fix the page took the spelling as known and suggested Ember.
    const capture = b1Capture({ ...auckland, church: { id: "CHU0000cedar", time_zone: "Pacific/auckland" },
      service: { id: "PLA-akl", day: "2026-11-21", starts_at: "2026-11-21T21:00:00Z", ends_at: "2026-11-21T22:15:00Z", shared: null },
      blockouts: [{ person_id: "PER-ember", starts_at: "2026-11-22T00:00:00Z", ends_at: "2026-11-23T00:00:00Z" }] });
    const result = mapped(capture, { sundayLeads: [], confirmedZone: "Pacific/auckland" });
    expect(result).toMatchObject({ time_zone: null, zone_unknown: true, waiting_for_zone: true, zone_mismatch: false, zone_needs_confirming: true });
    expect(result.day).toMatchObject({ kind: "unknown", day: "your service" });
    const evaluated = evaluateCoverage(result.input);
    expect(evaluated.status).toBe("unverified");
    expect(disposition(evaluated, "POS-vocals", "PER-ember")).toBe("unverified");
    // An alias Intl rewrites (US/Central to America/Chicago) also counts for nothing; the canonical name does.
    for (const zone of ["US/Central", "america/chicago", "Etc/UTC"]) {
      const aliased = mapped(b1Capture({ church: { id: "CHU0000cedar", time_zone: zone } }), { sundayLeads: [], confirmedZone: zone });
      expect(aliased, zone).toMatchObject({ time_zone: null, zone_unknown: true, waiting_for_zone: true });
    }
    expect(mapped(b1Capture(), { sundayLeads: [], confirmedZone: "America/Chicago" }).waiting_for_zone).toBe(false);
    expect(mapped(b1Capture({ church: { id: "CHU0000cedar", time_zone: "UTC" } }), { sundayLeads: [], confirmedZone: "UTC" }).waiting_for_zone).toBe(false);
  });

  it("N8: with no day from the system and its times read cut short, no day is named from the guessed start", () => {
    const service = { id: "PLA0000nov22", day: null, starts_at: "2026-11-21T23:00:00Z", ends_at: "2026-11-22T16:30:00Z", shared: null };
    const cut = b1Capture({ service, reads: readsOf(B1_READS, { "b1.times": "truncated" }) });
    expect(mapped(cut).day).toMatchObject({ kind: "unknown", day: "your service" });
    expect(mapped(b1Capture({ service })).day).toMatchObject({ day: "Saturday" });
    const breezeCut = breezeCapture({ service: { id: "88120031", day: null, starts_at: "2026-11-22T10:30:00-05:00", ends_at: "2026-11-22T12:00:00-05:00", shared: null },
      reads: readsOf(["breeze.account", "breeze.events", "breeze.roles", "breeze.volunteers"], { "breeze.events": "truncated" }) });
    expect(mapped(breezeCut).day).toMatchObject({ kind: "unknown", day: "your service" });
  });
});

describe("whether a request was sent (asked)", () => {
  it("turns asked into the request's notification, as the Planning Center path turns its sent time", () => {
    const { input } = mapped(b1Capture());
    expect(input.positions[0]!.assignments.value.map(a => a.notification)).toEqual(["sent", "sent"]);
    expect(input.positions[2]!.assignments.value[0]).toMatchObject({ assignment_id: "ASN-lark", status: "U", notification: "unsent" });
    const unknown = mapped(b1Capture({ assignments: b1Capture().assignments.map(a => ({ ...a, asked: null })) }));
    expect(unknown.input.positions[2]!.assignments.value[0]!.notification).toBe("unknown");
    expect(mapped(breezeCapture()).input.positions[0]!.assignments.value[0]!.notification).toBe("unknown");
  });

  it("an unanswered request not yet sent reads as Planning Center reads an unsent one: still pending, the same record", () => {
    const pco = captureToCoverage(nov22Capture(), { sundayLeads: [], checkInAfterSundaysInARow: 0 }, "2026-11-20T15:10:00Z");
    const pcoUnsent = pco.input.positions.flatMap(p => p.assignments.value).find(a => a.assignment_id === "403")!;
    const pcoPending = evaluateCoverage(pco.input).positions.find(p => p.pending_assignment_ids.includes("403"))!;
    expect(pcoUnsent).toMatchObject({ status: "U", notification: "unsent", time_semantics: "verified" });
    const { input } = mapped(b1Capture());
    const ours = input.positions[2]!.assignments.value[0]!;
    expect({ status: ours.status, notification: ours.notification, time_semantics: ours.time_semantics })
      .toEqual({ status: pcoUnsent.status, notification: pcoUnsent.notification, time_semantics: pcoUnsent.time_semantics });
    expect(position(evaluateCoverage(input), "POS-greeter").pending_assignment_ids).toEqual(["ASN-lark"]);
    expect(pcoPending.pending_assignment_ids).toContain("403");
  });
});

describe("whether the checked plan is shared with volunteers yet", () => {
  it("is returned as plan_shared, and a plan not shared yet is still checked", () => {
    expect(mapped(b1Capture()).plan_shared).toBe(true);
    const notShared = b1Capture({ service: { ...b1Capture().service!, shared: false } });
    const result = mapped(notShared);
    expect(result.plan_shared).toBe(false);
    expect(result.waiting_for_zone).toBe(false);
    expect(evaluateCoverage(result.input)).toEqual(evaluateCoverage(mapped(b1Capture()).input));
    expect(mapped(breezeCapture()).plan_shared).toBeNull();
  });
});

describe("people on the service with no role (Breeze's volunteers in no role)", () => {
  it("are never offered for a role, fill no role, and are counted for the page", () => {
    // Wren is on the service with no role; Lark answered for Greeter.
    const capture = b1Capture({ on_service: ["PER-wren"] });
    const result = mapped(capture);
    expect(result.on_service_count).toBe(1);
    const evaluated = evaluateCoverage(result.input);
    expect(disposition(evaluated, "POS-greeter", "PER-wren")).toBe("not offered");
    expect(position(evaluated, "POS-greeter").remaining_need).toBe(1);
    expect(mapped(b1Capture()).on_service_count).toBe(0);
    // Review E L5: someone also holding a role on this service isn't counted as without one.
    expect(mapped(b1Capture({ on_service: ["PER-wren", "PER-lark"] })).on_service_count).toBe(1);
  });

  it("from Breeze, with every read whole, the check goes on instead of stopping at Worth a look", () => {
    const answered = breezeCapture({ on_service: ["157803"], names: { "157801": "Juniper Fictional", "157802": "Linden Fictional", "157803": "Sorrel Fictional" },
      assignments: [
        { id: "71001", position_id: "9627", person_id: "157801", status: "accepted", asked: null },
        { id: "71002", position_id: "9628", person_id: "157802", status: "accepted", asked: null }] });
    const result = mapped(answered);
    expect(result.on_service_count).toBe(1);
    const evaluated = evaluateCoverage(result.input);
    expect(evaluated.issues).toEqual([]);
    expect(evaluated.positions.map(p => [p.position_id, p.remaining_need])).toEqual([["9627", 1], ["9628", 0]]);
  });
});

describe("a fixture used with a check time", () => {
  it("evaluates within the freshness window", () => {
    expect(Date.parse(NOW) - Date.parse(CHECKED)).toBeLessThan(LIVE_CHECK_VALID_MS);
  });
});

describe("people already scheduled who are blocked out (CoveragePosition.scheduled, design §11)", () => {
  // Rowan said yes to Vocals and has a blockout over the whole service; Lark hasn't answered Greeter and is blocked out too.
  const blocked = (over: Partial<SystemCapture> = {}) => b1Capture({
    blockouts: [
      { person_id: "PER-rowan", starts_at: "2026-11-21T00:00:00-06:00", ends_at: "2026-11-23T00:00:00-06:00" },
      { person_id: "PER-lark", starts_at: "2026-11-22T08:00:00-06:00", ends_at: "2026-11-22T09:30:00-06:00" },
      { person_id: "PER-ember", starts_at: "2026-11-21T00:00:00-06:00", ends_at: "2026-11-23T00:00:00-06:00" },
    ],
    ...over,
  });

  it("B1: someone who said yes or hasn't answered and is blocked out over the service is pointed out, as on Planning Center", () => {
    const result = run(blocked());
    expect(position(result, "POS-vocals").scheduled_blockouts).toEqual([
      { assignment_id: "ASN-rowan", person_id: "PER-rowan", interval: { starts_at: "2026-11-22T09:00:00-06:00", ends_at: "2026-11-22T10:30:00-06:00" } }]);
    expect(position(result, "POS-greeter").scheduled_blockouts.map(b => b.person_id)).toEqual(["PER-lark"]);
    // The place still counts as filled: Vocals still needs only one more, as B1 counts it.
    expect(position(result, "POS-vocals").remaining_need).toBe(1);
    expect(result.status).toBe("findings");
  });

  it("B1: the mapper hands every scheduled person's own blockouts to the engine, from the blockouts read", () => {
    const input = mapped(blocked()).input;
    const vocals = input.positions.find(p => p.position_id === "POS-vocals")!;
    expect(vocals.scheduled).toEqual([
      { assignment_id: "ASN-rowan", person_id: "PER-rowan", blockouts: { scope_id: "b1.blockouts", value: [{ starts_at: "2026-11-21T00:00:00-06:00", ends_at: "2026-11-23T00:00:00-06:00" }] } },
      { assignment_id: "ASN-tamsin", person_id: "PER-tamsin", blockouts: { scope_id: "b1.blockouts", value: [] } },
    ]);
  });

  it("B1: a declined answer is never pointed out, and nobody without a blockout is", () => {
    const result = run(b1Capture({ blockouts: [{ person_id: "PER-tamsin", starts_at: "2026-11-21T00:00:00-06:00", ends_at: "2026-11-23T00:00:00-06:00" }] }));
    expect(result.positions.flatMap(p => p.scheduled_blockouts)).toEqual([]);
  });

  it("B1: blockouts read only in part never clear a scheduled person: Worth a look, never silently covered", () => {
    const capture = blocked({ reads: readsOf(B1_READS, { "b1.blockouts": "truncated" }) });
    const result = run(capture);
    expect(result.positions.flatMap(p => p.scheduled_blockouts)).toEqual([]);
    expect(result.status).toBe("unverified");
    const vocals = mapped(capture).input.positions.find(p => p.position_id === "POS-vocals")!;
    expect(vocals.scheduled?.every(s => s.blockouts.value === null)).toBe(true);
  });

  it("B1: while the church's time zone waits to be confirmed, nobody is pointed out and the check is held", () => {
    const result = run(blocked(), UNCONFIRMED);
    expect(result.positions.flatMap(p => p.scheduled_blockouts)).toEqual([]);
    expect(result.status).toBe("unverified");
  });

  it("Breeze has no blockouts: no scheduled blockout is checked and nothing changes", () => {
    const input = mapped(breezeCapture()).input;
    expect(input.positions.every(p => p.scheduled === undefined)).toBe(true);
  });
});
