// What a B1 Church or Breeze check is compared by (core/src/church-systems/changes.ts): two reads of the same facts
// compare as the same, whenever each ran and whatever order the system listed things in; a real change is told by
// person id, never by name. Fictional captures only.
import { describe, expect, it } from "vitest";
import { buildSystemBrief } from "../../src/church-systems/brief.js";
import { recordSystemCheck, steadyBrief, systemServing } from "../../src/church-systems/changes.js";
import type { SystemCapture } from "../../src/church-systems/types.js";
import { compareSundayCheck, describeChange, type SundayCheckRecord } from "../../src/sunday-changes.js";
import { b1Capture, breezeCapture, NOW, readsOf, B1_READS } from "./fixtures.js";

const built = (c: SystemCapture, now = NOW) => {
  const b = buildSystemBrief(c, { confirmedZone: c.church.time_zone }, now);
  if (!b.ok) throw new Error(b.reason);
  return b.brief;
};
const record = (c: SystemCapture, now = NOW) => recordSystemCheck(c, built(c, now));
/** A record apart from when its check finished, as the schedule compares two (proactive.ts `sameFacts`). */
const facts = (r: SundayCheckRecord) => JSON.stringify({ ...r, completed_at: "" });
/** What a brief shows, apart from when anything was read (proactive.ts `shownPrint` leaves these out). */
const READ_TIMES = new Set(["id", "why", "source", "checked_at", "check_time", "valid_until", "evaluated_at", "stale", "role_facts"]);
const shown = (c: SystemCapture, now = NOW) => JSON.stringify(steadyBrief(built(c, now)).findings, (k, v: unknown) => READ_TIMES.has(k) ? undefined : v);
const reversed = <T>(list: readonly T[]) => [...list].reverse();

const later = (t: string) => new Date(Date.parse(t) + 3_600_000).toISOString().replace(/\.000Z$/u, "Z");
/** The same capture read an hour later: when it started and finished and when each read ran. */
const anHourLater = (c: SystemCapture): SystemCapture => ({
  ...c, started_at: later(c.started_at), completed_at: later(c.completed_at), reads: c.reads.map(r => ({ ...r, checked_at: later(r.checked_at) })),
});
/** The same facts read again an hour later, every list in the other order. */
function readAgain(c: SystemCapture): SystemCapture {
  return {
    ...anHourLater(c),
    reads: reversed(anHourLater(c).reads),
    positions: reversed(c.positions), assignments: reversed(c.assignments), team_members: reversed(c.team_members),
    ...(c.blockouts ? { blockouts: reversed(c.blockouts) } : {}), ...(c.busy ? { busy: reversed(c.busy) } : {}),
    names: Object.fromEntries(reversed(Object.entries(c.names))), labels: Object.fromEntries(reversed(Object.entries(c.labels))),
  };
}
const LATER = "2026-11-20T16:10:00Z";

describe("a B1 Church or Breeze check, as the schedule compares it", () => {
  it("is the same for the same facts read again: when each read ran and the order of every list don't count", () => {
    for (const first of [b1Capture(), breezeCapture()]) {
      const again = readAgain(first);
      expect(again.completed_at).not.toBe(first.completed_at);
      const [a, b] = [record(first), record(again, LATER)];
      expect(b.completed_at).toBe(again.completed_at);
      expect(facts(b)).toBe(facts(a));
      expect(shown(again, LATER)).toBe(shown(first));
      // Compared, nothing changed.
      const { changes } = compareSundayCheck({ latest: a, known: a }, b, { now: LATER, urgentWithinHours: 48 });
      expect(changes).toEqual([]);
    }
  });

  it("is the same when someone blocked out for two roles, or busy twice, is listed in another order", () => {
    // Rowan says yes to Vocals and to Guitar while blocked out all weekend; Bram, who could help, is on two other plans.
    const base = b1Capture({
      assignments: [...b1Capture().assignments, { id: "ASN-rowan2", position_id: "POS-guitar", person_id: "PER-rowan", status: "accepted", asked: true }],
      blockouts: [...b1Capture().blockouts!, { person_id: "PER-rowan", starts_at: "2026-11-21T00:00:00-06:00", ends_at: "2026-11-23T00:00:00-06:00" }],
      busy: [...b1Capture().busy!, { person_id: "PER-bram", starts_at: "2026-11-22T08:00:00-06:00", ends_at: "2026-11-22T10:00:00-06:00", answer: "unconfirmed" },
        { person_id: "PER-bram", starts_at: "2026-11-22T09:15:00-06:00", ends_at: "2026-11-22T09:45:00-06:00", answer: "accepted" }],
    });
    const again = readAgain(base);
    expect(facts(record(again, LATER))).toBe(facts(record(base)));
    expect(shown(again, LATER)).toBe(shown(base));
    // The blockout card names its roles in one order, the first as its role.
    const blockout = built(base).findings.find(f => f.kind === "blockout" && f.person_id === "PER-rowan")!;
    expect(blockout.serving!.map(s => s.name)).toEqual(["Guitar", "Vocals"]);
    expect(blockout.position!.name).toBe("Guitar");
  });

  it("is of the church and service it read: `<system>:<church id>` and the system's own service id", () => {
    expect(record(b1Capture())).toMatchObject({ organization: "b1:CHU0000cedar", plan_id: "PLA0000nov22", fully_read: true });
    expect(record(breezeCapture())).toMatchObject({ organization: "breeze:juniperstreet", plan_id: "88120031" });
  });

  it("tells a volunteer who said yes and now says no, by person id only, in the system's own words", () => {
    const first = b1Capture();
    const declined = { ...anHourLater(first), assignments: first.assignments.map(a => a.id === "ASN-rowan" ? { ...a, status: "declined" as const } : a) };
    const a = record(first), b = record(declined, LATER);
    const { changes } = compareSundayCheck({ latest: a, known: a }, b, { now: LATER, urgentWithinHours: 48 });
    const kinds = changes.map(c => c.kind);
    expect(kinds).toContain("confirmed-declined");
    expect(kinds).toContain("need-increased");
    const declinedChange = changes.find(c => c.kind === "confirmed-declined")!;
    expect(declinedChange).toMatchObject({ id: "confirmed-declined:ASN-rowan", person_id: "PER-rowan", position: "Vocals", team_id: "GRP-worship", effect: "worse" });
    // Inside the church's window before the service, with Vocals open: urgent.
    expect(declinedChange.urgency).toBe("urgent");
    // Nothing a change carries is a name; the name is resolved on this Mac only when it is shown.
    expect(JSON.stringify(changes)).not.toMatch(/Fictional/u);
    expect(describeChange(declinedChange, id => first.names[id], undefined, "B1 Church")).toBe("Rowan Fictional declined Vocals after confirming.");
    const filled = changes.find(c => c.kind === "need-increased")!;
    expect(describeChange(filled, () => undefined, undefined, "B1 Church")).toBe("Vocals now needs 2 more people, up from 1.");
  });

  it("says a role is filled, and a read that didn't complete, in the system's own name", () => {
    // Breeze's own answers (no response, declined, accepted) as Ozzie keeps them: Linden said yes to Usher, which needed one.
    const first = breezeCapture({ assignments: [
      { id: "71001", position_id: "9627", person_id: "157801", status: "accepted", asked: null },
      { id: "71002", position_id: "9628", person_id: "157802", status: "declined", asked: null }] });
    const filled = { ...anHourLater(first), assignments: first.assignments.map(a => a.id === "71002" ? { ...a, status: "accepted" as const } : a) };
    const a = record(first), b = record(filled, LATER);
    const { changes } = compareSundayCheck({ latest: a, known: a }, b, { now: LATER, urgentWithinHours: 48 });
    const done = changes.find(c => c.kind === "need-filled")!;
    expect(describeChange(done, () => undefined, undefined, "Breeze")).toBe("Usher no longer needs anyone, by Breeze's numbers.");
    expect(describeChange({ id: "coverage-unverified", kind: "coverage-unverified", effect: "worse", urgency: "attention", failed_reads: 2 }, () => undefined, undefined, "Breeze"))
      .toBe("Some coverage couldn't be verified: 2 Breeze reads didn't complete.");
    expect(describeChange({ id: "coverage-verified", kind: "coverage-verified", effect: "better", urgency: "none" }, () => undefined, undefined, "Breeze"))
      .toBe("Every Breeze read completed again.");
    // Planning Center's own words are unchanged.
    expect(describeChange(done, () => undefined)).toBe("Usher no longer has an open request in Planning Center.");
  });

  it("reads nobody as gone when who is scheduled, or the roles, couldn't be read whole", () => {
    const first = b1Capture();
    for (const word of ["b1.assignments", "b1.positions"]) {
      const broken = { ...anHourLater(first), reads: anHourLater({ ...first, reads: readsOf(B1_READS, { [word]: "timeout" }) }).reads, assignments: [] };
      expect(systemServing(broken)).toBeNull();
      const a = record(first), b = record(broken, LATER);
      const { changes } = compareSundayCheck({ latest: a, known: a }, b, { now: LATER, urgentWithinHours: 48 });
      expect(changes.map(c => c.kind)).not.toContain("confirmed-removed");
      expect(changes.map(c => c.kind)).not.toContain("confirmed-declined");
    }
  });

  it("keeps each answer in the comparison's closed words, by the system's own assignment ids", () => {
    expect(systemServing(b1Capture())).toEqual([
      { assignment_id: "ASN-lark", team_id: "GRP-hosp", position: "Greeter", person_id: "PER-lark", status: "U" },
      { assignment_id: "ASN-rowan", team_id: "GRP-worship", position: "Vocals", person_id: "PER-rowan", status: "C" },
      { assignment_id: "ASN-tamsin", team_id: "GRP-worship", position: "Vocals", person_id: "PER-tamsin", status: "D" },
    ]);
    // Breeze: no team tied to a role, and an answer it doesn't give is neither yes nor no.
    expect(systemServing(breezeCapture())?.map(s => [s.team_id, s.status])).toEqual([["?", "other"], ["?", "other"]]);
  });
});
