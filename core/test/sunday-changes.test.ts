import { describe, expect, it } from "vitest";
import { compareSundayCheck, describeChange, diffSundayChecks, recordSundayCheck, type SundayChange, type SundayCheckMemory } from "../src/sunday-changes.js";
import { nov22Capture, nov22LaterCapture, PEOPLE, TEAMS } from "../src/fictional-sunday.js";
import type { SundayCapture, SundayRead, SundayRules } from "../src/sunday-capture.js";

// Fixture: checked Nov 20 15:00Z; the service starts Nov 22 14:30Z (47.5 hours later).
const NOW = "2026-11-20T15:05:00Z";
const rules: SundayRules = { sundayLeads: [], checkInAfterSundaysInARow: 3 };
const urgent48 = { now: NOW, urgentWithinHours: 48 };

type Row = { type: string; id: string; attributes: Record<string, unknown>; relationships: Record<string, { data: unknown }> };
const rowsOf = (read: SundayRead) => read.body!.data as Row[];
const readOf = (c: SundayCapture, collection: string, extra: Partial<SundayRead> = {}) =>
  c.reads.find(r => r.collection === collection && Object.entries(extra).every(([k, v]) => r[k as keyof SundayRead] === v))!;
const member = (c: SundayCapture, id: string) => rowsOf(readOf(c, "team_members")).find(m => m.id === id)!;
const need = (c: SundayCapture, name: string) => rowsOf(readOf(c, "needed_positions")).find(n => n.attributes.team_position_name === name);
const shift = (c: SundayCapture, minutes: number): SundayCapture => {
  const later = (iso: string) => new Date(Date.parse(iso) + minutes * 60_000).toISOString();
  return { ...c, started_at: later(c.started_at), completed_at: later(c.completed_at), reads: c.reads.map(r => ({ ...r, checked_at: later(r.checked_at) })) };
};
const at = (minutes: number) => new Date(Date.parse(NOW) + minutes * 60_000).toISOString();
const record = (c: SundayCapture, now = NOW, r = rules) => recordSundayCheck(c, r, now);
const kinds = (changes: SundayChange[]) => changes.map(c => c.kind);
const names = nov22Capture().names;
const nameOf = (id: string) => names[id];

describe("Sunday changes between two checks", () => {
  it("a refresh with identical facts and only new check times is not a material change", () => {
    const first = record(nov22Capture());
    const again = record(shift(nov22Capture(), 60), at(60));
    expect(diffSundayChecks(first, again, { now: at(60), urgentWithinHours: 48 })).toEqual([]);
  });

  it("reordered Planning Center rows and people produce no change", () => {
    const reordered = nov22Capture();
    for (const r of reordered.reads) if (Array.isArray(r.body?.data)) r.body!.data = [...(r.body!.data as unknown[])].reverse();
    expect(diffSundayChecks(record(nov22Capture()), record(reordered), urgent48)).toEqual([]);
  });

  it("a confirmed volunteer declining inside 48 hours of the service is urgent", () => {
    const next = nov22Capture();
    member(next, "401").attributes.status = "D";
    need(next, "Greeter")!.attributes.quantity = 2;
    const changes = diffSundayChecks(record(nov22Capture()), record(next), urgent48);
    expect(kinds(changes)).toEqual(["confirmed-declined", "need-increased"]);
    expect(changes[0]).toMatchObject({ effect: "worse", urgency: "urgent", person_id: PEOPLE.greeterConfirmed, position: "Greeter", service_starts_at: "2026-11-22T14:30:00Z" });
    expect(changes[1]).toMatchObject({ effect: "worse", urgency: "urgent", from: 1, to: 2 });
    expect(describeChange(changes[0]!, nameOf)).toBe("Avery Brightwater declined Greeter after confirming.");
    expect(describeChange(changes[0]!, () => undefined)).toBe("Someone declined Greeter after confirming.");
    expect(describeChange(changes[1]!, nameOf)).toBe("Greeter now needs 2 more people, up from 1.");
  });

  it("the later fictional check (a confirmed Nursery volunteer declined) is urgent two days out", () => {
    const later = "2026-11-20T17:20:00Z";
    const changes = diffSundayChecks(record(nov22Capture()), record(nov22LaterCapture(), later), { now: later, urgentWithinHours: 48 });
    expect(changes.map(c => [c.kind, c.urgency, c.position])).toEqual([["confirmed-declined", "urgent", "Nursery"], ["need-increased", "urgent", "Nursery"]]);
    expect(describeChange(changes[0]!, nameOf)).toBe("Blake Ashgrove declined Nursery after confirming.");
  });

  it("the same decline outside the church's urgency window is a normal attention change", () => {
    const next = nov22Capture();
    member(next, "401").attributes.status = "D";
    need(next, "Greeter")!.attributes.quantity = 2;
    const changes = diffSundayChecks(record(nov22Capture()), record(next), { now: NOW, urgentWithinHours: 24 });
    expect(changes.map(c => c.urgency)).toEqual(["attention", "attention"]);
    // Church-adjustable: a wider window makes the same change urgent.
    expect(diffSundayChecks(record(nov22Capture()), record(next), { now: NOW, urgentWithinHours: 72 }).map(c => c.urgency)).toEqual(["urgent", "urgent"]);
  });

  it("a confirmed volunteer removed from the plan, leaving the role open, is urgent", () => {
    const next = nov22Capture();
    const members = readOf(next, "team_members");
    members.body!.data = rowsOf(members).filter(m => m.id !== "402");
    need(next, "Nursery")!.attributes.quantity = 2;
    const changes = diffSundayChecks(record(nov22Capture()), record(next), urgent48);
    expect(changes[0]).toMatchObject({ kind: "confirmed-removed", urgency: "urgent", person_id: PEOPLE.nurseryConfirmed, position: "Nursery" });
    expect(describeChange(changes[0]!, nameOf)).toBe("Blake Ashgrove is no longer scheduled for Nursery. They had confirmed.");
  });

  it("a newly open required position without a confirmed loss is a normal attention change", () => {
    const next = nov22Capture();
    rowsOf(readOf(next, "needed_positions")).push({ type: "NeededPosition", id: "303", attributes: { quantity: 1, team_position_name: "Lyrics" },
      relationships: { team: { data: { type: "Team", id: TEAMS.lyrics } }, time: { data: { type: "PlanTime", id: "9001" } } } });
    const changes = diffSundayChecks(record(nov22Capture()), record(next), urgent48);
    expect(changes).toEqual([expect.objectContaining({ kind: "need-opened", effect: "worse", urgency: "attention", position: "Lyrics", to: 1 })]);
    expect(describeChange(changes[0]!, nameOf)).toBe("Lyrics now needs one more person.");
  });

  it("a filled or reduced need is a better change and never urgent", () => {
    const next = nov22Capture();
    const needs = readOf(next, "needed_positions");
    needs.body!.data = rowsOf(needs).filter(n => n.attributes.team_position_name !== "Nursery");
    const changes = diffSundayChecks(record(nov22Capture()), record(next), urgent48);
    expect(changes).toEqual([expect.objectContaining({ kind: "need-filled", effect: "better", urgency: "none", position: "Nursery" })]);
    expect(describeChange(changes[0]!, nameOf)).toBe("Nursery no longer has an open request in Planning Center.");
  });

  it("a pending request that is answered says how it was answered", () => {
    const accepted = nov22Capture();
    member(accepted, "403").attributes.status = "C";
    const yes = diffSundayChecks(record(nov22Capture()), record(accepted), urgent48);
    expect(yes).toEqual([expect.objectContaining({ kind: "pending-accepted", effect: "better", urgency: "none", person_id: PEOPLE.lyricsPending })]);
    expect(describeChange(yes[0]!, nameOf)).toBe("Cameron Larkspur accepted Lyrics.");

    const declined = nov22Capture();
    member(declined, "403").attributes.status = "D";
    const no = diffSundayChecks(record(nov22Capture()), record(declined), urgent48);
    expect(no).toEqual([expect.objectContaining({ kind: "pending-declined", effect: "worse", urgency: "attention" })]);
    expect(describeChange(no[0]!, nameOf)).toBe("Cameron Larkspur declined the Lyrics request.");
  });

  it("a suggestion that now has a possible conflict or is left out is a change", () => {
    const conflicting = nov22Capture();
    readOf(conflicting, "person_schedules", { person_id: PEOPLE.riley }).body = {
      data: [{ type: "Schedule", id: "751", attributes: { status: "U", team_position_name: "Usher", sort_date: "2026-11-22T14:30:00Z" },
        relationships: { plan: { data: { type: "Plan", id: "92900003" } }, times: { data: [{ type: "PlanTime", id: "9401" }] } } }],
      included: [{ type: "PlanTime", id: "9401", attributes: { starts_at: "2026-11-22T14:30:00Z", ends_at: "2026-11-22T15:30:00Z" } }],
      meta: { count: 1, total_count: 1 },
    };
    const conflict = diffSundayChecks(record(nov22Capture()), record(conflicting), urgent48);
    expect(conflict).toEqual([expect.objectContaining({ kind: "suggestion-conflict", effect: "worse", urgency: "attention", person_id: PEOPLE.riley, position: "Greeter" })]);
    expect(describeChange(conflict[0]!, nameOf)).toBe("Riley Thornbury now has a possible conflict for Greeter.");

    const blocked = nov22Capture();
    readOf(blocked, "person_blockouts", { person_id: PEOPLE.riley }).body = {
      data: [{ type: "Blockout", id: "803", attributes: { starts_at: "2026-11-22T13:00:00Z", ends_at: "2026-11-22T18:00:00Z", repeat_frequency: "no_repeat" } }],
      meta: { count: 1, total_count: 1 },
    };
    const left = diffSundayChecks(record(nov22Capture()), record(blocked), urgent48);
    expect(left).toEqual([expect.objectContaining({ kind: "suggestion-left-out", person_id: PEOPLE.riley })]);
  });

  it("a read now failing makes coverage unverified and never reads as resolved", () => {
    const failing = nov22Capture();
    readOf(failing, "needed_positions").outcome = "provider_failure";
    const changes = diffSundayChecks(record(nov22Capture()), record(failing), urgent48);
    expect(changes).toEqual([expect.objectContaining({ kind: "coverage-unverified", effect: "worse", urgency: "attention", failed_reads: 1 })]);
    expect(describeChange(changes[0]!, nameOf)).toBe("Some coverage couldn't be verified: 1 Planning Center read didn't complete.");
    expect(record(failing).fully_read).toBe(false);
  });

  it("puts urgent changes first, then other worse changes, then better ones", () => {
    const next = nov22Capture();
    member(next, "403").attributes.status = "C";
    member(next, "401").attributes.status = "D";
    need(next, "Greeter")!.attributes.quantity = 2;
    rowsOf(readOf(next, "needed_positions")).push({ type: "NeededPosition", id: "303", attributes: { quantity: 1, team_position_name: "Lyrics" },
      relationships: { team: { data: { type: "Team", id: TEAMS.lyrics } }, time: { data: { type: "PlanTime", id: "9001" } } } });
    expect(diffSundayChecks(record(nov22Capture()), record(next), urgent48).map(c => [c.kind, c.urgency]))
      .toEqual([["confirmed-declined", "urgent"], ["need-increased", "urgent"], ["need-opened", "attention"], ["pending-accepted", "none"]]);
  });

  it("a Sunday lead going missing inside the window is urgent", () => {
    const leadRules: SundayRules = { ...rules, sundayLeads: [{ team_id: TEAMS.greeter, lead_position: "Greeter Lead" }] };
    const withLead = () => {
      const c = nov22Capture();
      rowsOf(readOf(c, "team_members")).push({ type: "PlanPerson", id: "404",
        attributes: { status: "C", team_position_name: "Greeter Lead", notification_sent_at: "2026-11-01T12:00:00Z" },
        relationships: { person: { data: { type: "Person", id: "520" } }, team: { data: { type: "Team", id: TEAMS.greeter } }, times: { data: [{ type: "PlanTime", id: "9001" }] } } });
      return c;
    };
    const next = withLead();
    member(next, "404").attributes.status = "D";
    const changes = diffSundayChecks(record(withLead(), NOW, leadRules), record(next, NOW, leadRules), urgent48);
    expect(changes.map(c => [c.kind, c.urgency, c.position])).toEqual([
      ["confirmed-declined", "urgent", "Greeter Lead"], ["lead-missing", "urgent", "Greeter"],
    ]);
    expect(describeChange(changes[1]!, nameOf)).toBe("No one is confirmed to lead Greeter this Sunday now.");
  });

  it("records and changes carry ids only, never a person's name", () => {
    const next = nov22Capture();
    member(next, "401").attributes.status = "D";
    member(next, "403").attributes.status = "C";
    const text = JSON.stringify([record(nov22Capture()), record(next), diffSundayChecks(record(nov22Capture()), record(next), urgent48)]);
    for (const name of Object.values(names)) expect(text).not.toContain(name);
  });
});

describe("remembering what was already known", () => {
  const step = (memory: SundayCheckMemory | null, c: SundayCapture, now = NOW) => compareSundayCheck(memory, record(c, now), { now, urgentWithinHours: 48 });

  it("the first check for a Sunday is a baseline with no changes", () => {
    const first = step(null, nov22Capture());
    expect(first.changes).toEqual([]);
    expect(first.memory.latest.plan_id).toBe("92902197");
  });

  it("recovering after a failed read reports the recovery, not facts that were already known", () => {
    const failing = nov22Capture();
    readOf(failing, "needed_positions").outcome = "provider_failure";
    const one = step(null, nov22Capture());
    const two = step(one.memory, failing);
    const three = step(two.memory, nov22Capture());
    expect(kinds(two.changes)).toEqual(["coverage-unverified"]);
    expect(three.changes).toEqual([expect.objectContaining({ kind: "coverage-verified", effect: "better", urgency: "none" })]);
    expect(describeChange(three.changes[0]!, nameOf)).toBe("Every Planning Center read completed again.");
  });

  it("a change that happened while a read was failing is reported once it can be read", () => {
    const failing = nov22Capture();
    readOf(failing, "needed_positions").outcome = "provider_failure";
    const grown = nov22Capture();
    need(grown, "Greeter")!.attributes.quantity = 3;
    const one = step(null, nov22Capture());
    const two = step(one.memory, failing);
    const three = step(two.memory, grown);
    expect(three.changes.map(c => [c.kind, c.from, c.to])).toEqual([["need-increased", 1, 3], ["coverage-verified", undefined, undefined]]);
  });

  it("a change found during a partly failed check is not reported again once reads recover", () => {
    const declinedPartly = nov22Capture();
    member(declinedPartly, "401").attributes.status = "D";
    need(declinedPartly, "Greeter")!.attributes.quantity = 2;
    readOf(declinedPartly, "person_blockouts", { person_id: PEOPLE.riley }).outcome = "provider_failure";
    const declined = nov22Capture();
    member(declined, "401").attributes.status = "D";
    need(declined, "Greeter")!.attributes.quantity = 2;

    const one = step(null, nov22Capture());
    const two = step(one.memory, declinedPartly);
    const three = step(two.memory, declined);
    expect(kinds(two.changes)).toEqual(["confirmed-declined", "need-increased", "coverage-unverified"]);
    expect(kinds(three.changes)).toEqual(["coverage-verified"]);
  });

  it("a different Sunday starts a new baseline", () => {
    const one = step(null, nov22Capture());
    const other = { ...nov22Capture(), plan_id: "92902999" };
    member(other, "401").attributes.status = "D";
    const two = step(one.memory, other);
    expect(two.changes).toEqual([]);
    expect(two.memory.latest.plan_id).toBe("92902999");
  });
});
