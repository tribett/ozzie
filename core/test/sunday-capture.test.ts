import { describe, expect, it } from "vitest";
import { captureToCoverage, servingStreaks, type SundayRules } from "../src/sunday-capture.js";
import { evaluateCoverage } from "../src/coverage.js";
import { CHECKED, PEOPLE, TEAMS, nov22Capture } from "../src/fictional-sunday.js";

const NOW = "2026-11-20T15:05:00Z";
/** Drew's repeating blockout is a deliberate "Worth a look"; remove it to test overall status paths. */
const settled = () => {
  const c = nov22Capture();
  const b = c.reads.find(x => x.collection === "person_blockouts" && x.person_id === PEOPLE.drew)!;
  b.body = { data: [], meta: { count: 0, total_count: 0 } };
  return c;
};
const rules: SundayRules = { sundayLeads: [], checkInAfterSundaysInARow: 3 };
const evaluate = (capture = nov22Capture(), r = rules, now = NOW) => {
  const mapped = captureToCoverage(capture, r, now);
  return { mapped, result: evaluateCoverage(mapped.input) };
};
const position = (r: ReturnType<typeof evaluate>, name: string) => {
  const id = r.mapped.positions.find(p => p.name === name)!.position_id;
  return r.result.positions.find(p => p.position_id === id)!;
};
const disposition = (r: ReturnType<typeof evaluate>, name: string, person: string) =>
  position(r, name).candidates.find(c => c.person_id === person)?.disposition;

describe("Sunday capture to coverage", () => {
  it("reports Planning Center's remaining need as-is and keeps pending separate", () => {
    const r = evaluate();
    expect(position(r, "Greeter").remaining_need).toBe(1);
    expect(position(r, "Nursery").remaining_need).toBe(1);
    expect(position(r, "Lyrics").remaining_need).toBe(0);
    expect(position(r, "Lyrics").pending_assignment_ids).toEqual(["403"]);
    expect(evaluate(settled()).result.status).toBe("findings");
    expect(r.result.status).toBe("unverified"); // one candidate is Worth a look
  });

  it("sorts candidates into suggestion, conflict and exclusion from sourced facts only", () => {
    const r = evaluate();
    expect(disposition(r, "Greeter", PEOPLE.riley)).toBe("suggestion");
    expect(disposition(r, "Greeter", PEOPLE.sam)).toBe("excluded");
    expect(disposition(r, "Greeter", PEOPLE.morgan)).toBe("excluded");
    expect(disposition(r, "Greeter", PEOPLE.casey)).toBe("possible-conflict");
    expect(disposition(r, "Greeter", PEOPLE.drew)).toBe("unverified");
    // Already scheduled on this position: never re-suggested.
    expect(disposition(r, "Greeter", PEOPLE.greeterConfirmed)).toBeUndefined();
  });

  it("keeps the unsent invitation distinct from a sent request", () => {
    const r = evaluate();
    const lyrics = r.mapped.input.positions.find(p => p.position_id === r.mapped.positions.find(x => x.name === "Lyrics")!.position_id)!;
    expect(lyrics.assignments.value[0]).toMatchObject({ status: "U", notification: "unsent" });
  });

  it("a failed person read leaves only that person unverified and is reported", () => {
    const capture = nov22Capture();
    const blockouts = capture.reads.find(x => x.collection === "person_blockouts" && x.person_id === PEOPLE.riley)!;
    blockouts.outcome = "denied"; delete blockouts.body;
    const r = evaluate(capture);
    expect(disposition(r, "Greeter", PEOPLE.riley)).toBe("unverified");
    expect(disposition(r, "Greeter", PEOPLE.sam)).toBe("excluded");
    expect(r.result.status).toBe("unverified");
    expect(r.result.issues.some(i => i.person_id === PEOPLE.riley || i.scope_id === `person:${PEOPLE.riley}`)).toBe(true);
  });

  it("a truncated core read never yields an all-clear", () => {
    const capture = nov22Capture();
    capture.reads.find(x => x.collection === "team_members")!.outcome = "truncated";
    expect(evaluate(capture).result.status).toBe("unverified");
  });

  it("an empty but complete Sunday is the only path to checked-scope-clear", () => {
    const capture = settled();
    capture.reads.find(x => x.collection === "needed_positions")!.body = { data: [], meta: { count: 0, total_count: 0 } };
    const members = capture.reads.find(x => x.collection === "team_members")!;
    members.body!.data = (members.body!.data as { id: string }[]).filter(m => m.id !== "403");
    for (const read of capture.reads.filter(x => x.collection === "team_position_assignments")) {
      read.body!.data = (read.body!.data as { relationships: { person: { data: { id: string } } } }[])
        .filter(a => [PEOPLE.greeterConfirmed, PEOPLE.nurseryConfirmed].includes(a.relationships.person.data.id));
    }
    expect(evaluate(capture).result.status).toBe("checked-scope-clear");
    capture.reads.find(x => x.collection === "plan_times")!.outcome = "truncated";
    expect(evaluate(capture).result.status).toBe("unverified");
  });

  it("evaluates a recording as of its capture time, not as a current check", () => {
    const capture = { ...settled(), kind: "recording" as const };
    const r = evaluate(capture, rules, "2026-11-26T09:00:00Z");
    expect(r.mapped.input.evaluated_at).toBe(capture.completed_at);
    expect(r.result.status).toBe("findings");
  });

  it("an expired live check is not treated as current", () => {
    const r = evaluate(settled(), rules, "2026-11-20T18:00:00Z");
    expect(r.result.status).toBe("unverified");
  });

  it("never puts a person's name into the coverage input", () => {
    const capture = nov22Capture();
    const wire = JSON.stringify(captureToCoverage(capture, rules, NOW).input);
    for (const name of Object.values(capture.names)) expect(wire).not.toContain(name);
  });

  it("a Church rule for a Sunday lead reports the lead as missing when none is scheduled", () => {
    const r = evaluate(nov22Capture(), { ...rules, sundayLeads: [{ team_id: TEAMS.nursery, lead_position: "Nursery Lead" }] });
    expect(position(r, "Nursery").lead).toBe("missing");
    expect(position(r, "Greeter").lead).toBe("not-required");
  });

  it("all source check times are carried through to the scopes", () => {
    const r = evaluate();
    expect(r.mapped.input.scopes.every(s => s.check_time === CHECKED)).toBe(true);
  });
});

describe("Church rule: check in after N Sundays in a row", () => {
  it("flags only confirmed runs that reach the church's number", () => {
    expect(servingStreaks(nov22Capture(), 3).map(s => [s.person_id, s.sundays])).toEqual([[PEOPLE.greeterConfirmed, 3]]);
  });
  it("changing the rule from 3 to 2 adds the nursery volunteer", () => {
    expect(servingStreaks(nov22Capture(), 2).map(s => s.person_id).sort()).toEqual([PEOPLE.greeterConfirmed, PEOPLE.nurseryConfirmed].sort());
  });
  it("a pending (unconfirmed) Sunday does not count toward a run", () => {
    expect(servingStreaks(nov22Capture(), 1).map(s => s.person_id)).not.toContain(PEOPLE.lyricsPending);
  });
  it("an unreadable schedule never produces a run", () => {
    const capture = nov22Capture();
    capture.reads.find(x => x.collection === "person_schedules" && x.person_id === PEOPLE.greeterConfirmed)!.outcome = "denied";
    expect(servingStreaks(capture, 3)).toEqual([]);
  });
});
