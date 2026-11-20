// The "also read" facts from any of the three systems: groups, events and forms with their counts, each with its
// source, check time and how its read ended. A count that is null says why: the system doesn't give it, Ozzie doesn't
// read it yet, or its read didn't finish. Never zero. And the plain sentences for what Ozzie can't read from each
// system, and the one question it asks to confirm. Fictional data only.
import { describe, expect, it } from "vitest";
import {
  B1_KEY_BOXES, cannotSee, FACT_READS, howToConnect, noRoles, notSharedYet, NULL_COUNTS, onServiceWithoutRole, readProblem, systemFacts, toConfirm,
  notSharedNotice, readableName, sharedLabel, unknownNeed, waitingForZone, whyNullSentence,
} from "../../src/church-systems/facts.js";
import { READ_OUTCOMES, readsFor, SYSTEM_IDS, SYSTEMS } from "../../src/church-systems/types.js";
import { NEWEST_ONLY } from "../../src/church-systems/facts.js";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { b1Capture, breezeCapture, CHECKED, factsCapture, readsOf } from "./fixtures.js";

/** Genesis events are placed in the zone the leader confirmed: the fixture's own. */
const DENVER = { confirmedZone: "America/Denver" };
/** The words a person should never have to know (product/desktop/test/words.test.ts FORBIDDEN, copied: not importable here). */
const FORBIDDEN = /\b(?:skills?|sessions?|agents?|logs?|logged|connectors?|harness)\b/iu;
/** Never score, rank or label a person; never a bare Approve or Block; the tool is never a person; no service is "Sunday". */
const NEVER = /\b(?:score[sd]?|rank(?:s|ed|ing)?|at[ -]risk|drifting|approve|block|pastor|shepherd|deacon|someone|I|I'm|me|my|Sunday|UTC)\b/iu;

describe("systemFacts", () => {
  it("lists Genesis groups, events and forms with their counts: null where Genesis doesn't say, zero only where it says zero", () => {
    const facts = systemFacts(factsCapture("genesis"), DENVER);
    const read = { source: "Genesis", checked_at: CHECKED, outcome: "ok", at_least: false };
    expect(facts.source).toBe("Genesis");
    expect(facts.groups).toEqual([
      { group_id: "G1", members: 12, why_null: null, ...read }, { group_id: "G2", members: null, why_null: "not-given", ...read }]);
    expect(facts.events).toEqual([
      { event_id: "E1", starts_at: "2026-11-15T09:00:00-07:00", ends_at: null, attendance: 140, why_null: null, ...read },
      { event_id: "E2", starts_at: "2026-11-01T09:00:00-07:00", ends_at: "2026-11-01T10:00:00-07:00", attendance: 0, why_null: null, ...read },
    ]);
    expect(facts.forms).toEqual([
      { form_id: "F1", submissions: 5, why_null: null, ...read }, { form_id: "F2", submissions: null, why_null: "not-given", ...read }]);
  });

  it("says where a count is one Ozzie doesn't read yet, not one the system doesn't give (M3)", () => {
    const b1 = systemFacts(b1Capture());
    expect(b1.groups.map(g => [g.group_id, g.members, g.why_null])).toEqual([["GRP-worship", 4, null], ["GRP-youth", null, "not-given"]]);
    expect(b1.forms.map(f => [f.submissions, f.why_null])).toEqual([[null, "not-read-yet"]]);
    expect(b1.events.map(e => [e.attendance, e.why_null])).toEqual([[null, "not-read-yet"]]);
    expect(SYSTEMS.b1.attendance).toBe(false);
    expect(NULL_COUNTS).toEqual({
      b1: { members: "not-given", attendance: "not-read-yet", submissions: "not-read-yet" },
      breeze: { members: "not-read-yet", attendance: "not-read-yet", submissions: "not-in-newest" },
      genesis: { members: "not-given", attendance: "not-given", submissions: "not-given" },
    });
    // Where Ozzie doesn't read a count, the capture can't carry one.
    for (const system of ["b1"] as const) expect(SYSTEMS[system].attendance, system).toBe(false);
    const breeze = systemFacts(breezeCapture({
      reads: readsOf(["breeze.events", "breeze.tags", "breeze.forms"]),
      groups: [{ id: "y_16681", members: null }],
      events: [{ id: "88120031", starts_at: "2026-11-22T10:30:00-05:00", ends_at: null, attendance: null }],
      forms: [{ id: "77", submissions: null }],
    }));
    // Tag sizes aren't read; the service's head count and form entries weren't read in this capture.
    expect([breeze.groups[0]!.why_null, breeze.events[0]!.why_null, breeze.forms[0]!.why_null]).toEqual(["not-read-yet", "not-checked", "not-checked"]);
    expect(SYSTEMS.breeze.attendance).toBe(true);
    expect(NULL_COUNTS.breeze).toEqual({ members: "not-read-yet", attendance: "not-read-yet", submissions: "not-in-newest" });
  });

  it("carries a Genesis events read cut short for want of the church's time zone, with no events", () => {
    const facts = systemFacts(factsCapture("genesis", { church: { id: "ORG-maple", time_zone: null }, events: [],
      labels: { church: "Maple Crossing Church", "group:G1": "Tuesday Group", "form:F1": "Prayer Card" },
      reads: readsOf(["genesis.me", "genesis.groups", "genesis.events", "genesis.forms", "genesis.form_submissions"], { "genesis.events": "truncated" }) }));
    expect(facts.reads.events).toEqual({ outcome: "truncated", checked_at: CHECKED });
    expect(facts.events).toEqual([]);
    expect(facts.reads.groups.outcome).toBe("ok");
  });

  it("review D L4: a Genesis events read cut short leaves out events, not part of a present event's count", () => {
    const facts = systemFacts(factsCapture("genesis", { reads: readsOf(["genesis.me", "genesis.groups", "genesis.events", "genesis.forms",
      "genesis.form_submissions"], { "genesis.events": "truncated", "genesis.form_submissions": "truncated" }) }), DENVER);
    expect(facts.reads.events.outcome).toBe("truncated");
    expect(facts.events.map(e => [e.event_id, e.attendance, e.at_least])).toEqual([["E1", 140, false], ["E2", 0, false]]);
    // A count read of its own that was cut short (a full page of submissions) does make the count a lower bound.
    expect(facts.forms.map(f => [f.form_id, f.submissions, f.at_least])).toEqual([["F1", 5, true], ["F2", null, false]]);
  });

  it("counts Breeze's head count for this service only, and form entries for the 5 newest forms only", () => {
    const facts = systemFacts(breezeCapture({
      reads: readsOf(["breeze.events", "breeze.attendance", "breeze.tags", "breeze.forms", "breeze.form_entries"]),
      events: [{ id: "88120031", starts_at: "2026-11-22T10:30:00-05:00", ends_at: null, attendance: 41 },
        { id: "88120032", starts_at: "2026-11-29T10:30:00-05:00", ends_at: null, attendance: null }],
      forms: [{ id: "77", submissions: 3 }, { id: "78", submissions: null }],
    }));
    expect(facts.events.map(e => [e.event_id, e.attendance, e.why_null])).toEqual([["88120031", 41, null], ["88120032", null, "not-read-yet"]]);
    expect(facts.forms.map(f => [f.form_id, f.submissions, f.why_null])).toEqual([["77", 3, null], ["78", null, "not-in-newest"]]);
    // The head count read failed: this service's count wasn't checked; another event's was never going to be read.
    const failed = systemFacts(breezeCapture({ reads: readsOf(["breeze.events", "breeze.attendance"], { "breeze.attendance": "timeout" }),
      events: [{ id: "88120031", starts_at: "2026-11-22T10:30:00-05:00", ends_at: null, attendance: null },
        { id: "88120032", starts_at: "2026-11-29T10:30:00-05:00", ends_at: null, attendance: null }] }));
    expect(failed.events.map(e => e.why_null)).toEqual(["not-checked", "not-read-yet"]);
  });

  it("says Breeze's check-ins aren't final because the service hasn't ended, only when the check finished before it ended", () => {
    const before = breezeCapture({ reads: readsOf(["breeze.events", "breeze.attendance"], { "breeze.attendance": "not-requested" }),
      events: [{ id: "88120031", starts_at: "2026-11-22T10:30:00-05:00", ends_at: null, attendance: null },
        { id: "88120032", starts_at: "2026-11-29T10:30:00-05:00", ends_at: null, attendance: null }] });
    // The fixture's check ran on 20 November, before the 22 November service.
    expect(systemFacts(before).events.map(e => e.why_null)).toEqual(["not-ended", "not-read-yet"]);
    // During the service (started, not ended): still not final.
    const during = breezeCapture({ ...before, started_at: "2026-11-22T15:45:00Z", completed_at: "2026-11-22T15:45:05Z",
      service: { id: "88120031", day: "2026-11-22", starts_at: "2026-11-22T10:30:00-05:00", ends_at: "2026-11-22T12:00:00-05:00", shared: null },
      reads: [{ read: "breeze.events", checked_at: "2026-11-22T15:45:01Z", outcome: "ok" },
        { read: "breeze.attendance", checked_at: "2026-11-22T15:45:02Z", outcome: "not-requested" }] });
    expect(systemFacts(during).events.map(e => e.why_null)).toEqual(["not-ended", "not-read-yet"]);
    // Skipped for another reason (the check ran after the service ended): not checked.
    const after = breezeCapture({ ...before, started_at: "2026-11-22T18:00:00Z", completed_at: "2026-11-22T18:00:05Z",
      reads: [{ read: "breeze.events", checked_at: "2026-11-22T18:00:01Z", outcome: "ok" },
        { read: "breeze.attendance", checked_at: "2026-11-22T18:00:02Z", outcome: "not-requested" }] });
    expect(systemFacts(after).events.map(e => e.why_null)).toEqual(["not-checked", "not-read-yet"]);
    // A failed read is not checked, whenever it ran.
    const failed = breezeCapture({ ...before, reads: readsOf(["breeze.events", "breeze.attendance"], { "breeze.attendance": "timeout" }) });
    expect(systemFacts(failed).events.map(e => e.why_null)).toEqual(["not-checked", "not-read-yet"]);
  });

  it("a Breeze form beyond the 5 newest is not-in-newest even when the entries read says it was cut short (live shape)", () => {
    const forms = Array.from({ length: 7 }, (_, i) => ({ id: `F${i}`, submissions: i < 5 ? i + 1 : null }));
    for (const outcome of ["truncated", "ok"] as const) {
      const facts = systemFacts(breezeCapture({ forms, reads: readsOf(["breeze.forms", "breeze.form_entries"], { "breeze.form_entries": outcome }) }));
      expect(facts.forms.map(f => f.why_null), outcome).toEqual([null, null, null, null, null, "not-in-newest", "not-in-newest"]);
      // Breeze gives a form's whole entry list in one answer: a count it has is exact, never "at least".
      expect(facts.forms.map(f => f.at_least), outcome).toEqual([false, false, false, false, false, false, false]);
    }
    for (const outcome of ["timeout", "not-requested", "key-refused"] as const) {
      const facts = systemFacts(breezeCapture({ forms, reads: readsOf(["breeze.forms", "breeze.form_entries"], { "breeze.form_entries": outcome }) }));
      expect(facts.forms.slice(5).map(f => f.why_null), outcome).toEqual(["not-checked", "not-checked"]);
    }
  });

  it("keeps at least for a Genesis count whose own read was cut short (a full page of submissions)", () => {
    const facts = systemFacts(factsCapture("genesis", { reads: readsOf(["genesis.forms", "genesis.form_submissions"], { "genesis.form_submissions": "truncated" }) }), DENVER);
    expect(facts.forms.map(f => [f.submissions, f.at_least])).toEqual([[5, true], [null, false]]);
  });

  it("re-check N1: a Breeze service with no end time never has its check-ins read, and says so instead of not-checked", () => {
    const noEnd = { id: "88120031", day: "2026-11-22", starts_at: "2026-11-22T10:30:00-05:00", ends_at: null, shared: null };
    const events = [{ id: "88120031", starts_at: "2026-11-22T10:30:00-05:00", ends_at: null, attendance: null }];
    for (const [started, completed] of [["2026-11-20T14:59:58Z", "2026-11-20T15:00:04Z"], ["2026-11-22T18:00:00Z", "2026-11-22T18:00:05Z"]]) {
      const facts = systemFacts(breezeCapture({ service: noEnd, events, started_at: started!, completed_at: completed!,
        reads: [{ read: "breeze.events", checked_at: completed!, outcome: "ok" }, { read: "breeze.attendance", checked_at: completed!, outcome: "not-requested" }] }));
      expect(facts.events[0]!.why_null, completed).toBe("no-end-time");
    }
    // A failed read is still not checked.
    const failed = systemFacts(breezeCapture({ service: noEnd, events, reads: readsOf(["breeze.events", "breeze.attendance"], { "breeze.attendance": "timeout" }) }));
    expect(failed.events[0]!.why_null).toBe("not-checked");
  });

  it("gives one plain sentence for each reason a count is missing", () => {
    expect(Object.fromEntries((["not-given", "not-read-yet", "not-checked", "not-in-newest", "not-ended", "no-end-time"] as const)
      .map(w => [w, whyNullSentence("breeze", w)]))).toEqual({
      "not-given": "Breeze doesn't give this number.",
      "not-read-yet": "Ozzie doesn't read this number from Breeze yet.",
      "not-checked": "Ozzie couldn't check this number this time.",
      // True for a form beyond the newest 5, an archived one, and one a check stopped before reaching (review E L2).
      "not-in-newest": "Ozzie counts entries for at most 5 Breeze forms, and didn't count this one.",
      "not-ended": "The service hasn't ended yet, so check-ins aren't final.",
      "no-end-time": "Breeze gives this service no end time, so Ozzie doesn't count the people checked in to it.",
    });
  });

  it("says a count wasn't checked when its read didn't finish", () => {
    const facts = systemFacts(factsCapture("genesis", { reads: readsOf(["genesis.groups"], { "genesis.groups": "timeout" }) }));
    expect(facts.groups.map(g => g.why_null)).toEqual([null, "not-checked"]);
    expect(facts.forms.map(f => f.why_null)).toEqual([null, "not-checked"]);
  });

  it("serves Breeze's part reads the same way", () => {
    expect(systemFacts(breezeCapture()).reads).toEqual({
      groups: { outcome: "ok", checked_at: CHECKED }, events: { outcome: "ok", checked_at: CHECKED }, forms: { outcome: "not-read", checked_at: null },
    });
  });

  it("keeps only events starting in the window, start included, end not", () => {
    const capture = factsCapture("genesis");
    expect(systemFacts(capture, { ...DENVER, window: { starts_at: "2026-11-08T00:00:00-07:00", ends_at: "2026-11-22T00:00:00-07:00" } }).events.map(e => e.event_id)).toEqual(["E1"]);
    expect(systemFacts(capture, { ...DENVER, window: { starts_at: "2026-11-01T09:00:00-07:00", ends_at: "2026-11-15T09:00:00-07:00" } }).events.map(e => e.event_id)).toEqual(["E2"]);
    expect(systemFacts(capture, { ...DENVER, window: { starts_at: "2026-11-01", ends_at: "2026-11-30" } }).events).toEqual([]);
  });

  it("says how each read ended: the list's own read for the list, the count's read for the count, worst page first", () => {
    const capture = factsCapture("genesis", { reads: [
      ...readsOf(["genesis.groups", "genesis.forms"]),
      { read: "genesis.groups", checked_at: "2026-11-20T14:59:59Z", outcome: "truncated" },
      { read: "genesis.events", checked_at: CHECKED, outcome: "timeout" },
      { read: "genesis.form_submissions", checked_at: CHECKED, outcome: "truncated" },
      { read: "genesis.form_submissions", checked_at: CHECKED, outcome: "key-refused" },
    ] });
    const facts = systemFacts(capture, DENVER);
    expect(facts.reads.groups).toEqual({ outcome: "truncated", checked_at: "2026-11-20T14:59:59Z" });
    expect(facts.counts.groups).toEqual({ outcome: "truncated", checked_at: "2026-11-20T14:59:59Z" });
    expect(facts.groups.map(g => [g.outcome, g.members, g.at_least, g.why_null])).toEqual([["truncated", 12, false, null], ["truncated", null, false, "not-checked"]]);
    expect(facts.events.every(e => e.outcome === "timeout" && !e.at_least)).toBe(true);
    expect(facts.reads.forms.outcome).toBe("ok");
    expect(facts.counts.forms.outcome).toBe("key-refused");
    expect(facts.forms.map(f => [f.outcome, f.why_null])).toEqual([["ok", null], ["ok", "not-checked"]]);
  });

  it.each(["genesis"] as const)("L3: %s forms read ok with none to count: the list stays ok, the skipped count read doesn't outrank it", system => {
    const list = "genesis.forms";
    const count = "genesis.form_submissions";
    const others = factsCapture(system).reads.filter(r => r.read !== list && r.read !== count);
    const facts = systemFacts(factsCapture(system, { forms: [], labels: { church: "Maple Crossing Church" },
      reads: [...others, ...readsOf([list, count], { [count]: "not-requested" })] }));
    expect(facts.reads.forms).toEqual({ outcome: "ok", checked_at: CHECKED });
    expect(facts.counts.forms).toEqual({ outcome: "not-requested", checked_at: CHECKED });
    expect(facts.forms).toEqual([]);
  });

  it("a count read that was skipped while there is something to count leaves that count not checked", () => {
    const facts = systemFacts(factsCapture("genesis", { reads: readsOf(["genesis.forms", "genesis.form_submissions"], { "genesis.form_submissions": "not-requested" }) }));
    expect(facts.forms.map(f => [f.outcome, f.submissions, f.why_null])).toEqual([["ok", 5, null], ["ok", null, "not-checked"]]);
    // With no count read at all, a count the system gives wasn't checked.
    expect(systemFacts(factsCapture("genesis", { reads: readsOf(["genesis.forms"]) })).forms[1]!.why_null).toBe("not-checked");
  });

  it("waits only on reads native code makes: every list and count read is in a committed capture from that system", () => {
    const dir = new URL("./captures/", import.meta.url);
    const made = new Map<string, Set<string>>();
    for (const file of existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith(".json")) : []) {
      const capture = JSON.parse(readFileSync(new URL(file, dir), "utf8")) as { system: string; reads: { read: string }[] };
      for (const r of capture.reads) made.set(capture.system, (made.get(capture.system) ?? new Set()).add(r.read));
    }
    for (const system of SYSTEM_IDS) {
      expect(made.get(system)?.size ?? 0, `no committed capture from ${system}`).toBeGreaterThan(0);
      for (const part of ["groups", "events", "forms"] as const) {
        for (const word of [...FACT_READS[system][part].list, ...FACT_READS[system][part].count]) {
          expect(made.get(system)?.has(word), `${system} ${part}: native code never makes ${word}`).toBe(true);
        }
      }
    }
  });

  it("lists and counts each part only through read words that fill that part", () => {
    for (const system of SYSTEM_IDS) {
      for (const part of ["groups", "events", "forms"] as const) {
        const fills = readsFor(system, part), { list, count } = FACT_READS[system][part];
        expect(list.length, `${system} ${part}`).toBeGreaterThan(0);
        for (const word of [...list, ...count]) expect(fills, `${system} ${part}`).toContain(word);
      }
    }
  });

  it.each(READ_OUTCOMES)("carries the outcome word %s from the read itself", outcome => {
    const facts = systemFacts(factsCapture("genesis", { reads: readsOf(["genesis.groups"], { "genesis.groups": outcome }) }), DENVER);
    expect(facts.groups[0]!.outcome).toBe(outcome);
    expect(facts.events[0]!.outcome).toBe("not-read");
  });
});

describe("cannotSee and toConfirm", () => {
  it("says, for each system, exactly what Ozzie can't read there", () => {
    expect(cannotSee("b1")).toEqual([
      "Ozzie can't check B1 Church blockouts that end on the day of a service once that day has begun in Greenwich time (6 pm the evening before in Chicago in winter, 7 pm in summer): B1 stops listing them then.",
      "Ozzie can't tell whether your church chose the time zone B1 Church shows, or B1 set it for you.",
      "Ozzie doesn't read attendance from B1 Church yet.",
      "Ozzie doesn't read how many times a B1 Church form was filled in: for most forms B1 shares that only with a key that can make changes.",
      "Ozzie can't see every B1 Church form: it sees only the forms the person who made the key can manage, so it doesn't report your church's forms as complete.",
      "Ozzie can't check a B1 Church plan until you've confirmed your church's time zone in Ozzie, whether B1 Church gives one or not.",
      "Ozzie checks only the times on the plan's own day that B1 marks as the service. If a plan has none marked that way, Ozzie uses the plan's other times and marks the check Worth a look.",
      "Ozzie can't trust the day B1 Church saves for a church in New Zealand, Tonga, Samoa or nearby, where B1 can save plans a day early, so it works the day out from your confirmed time zone.",
      "Ozzie can't see B1 Church events except for groups the person who made the key belongs to and groups your church put on a shared calendar.",
      "Ozzie can't read B1 Church events that repeat, so it leaves them out.",
      "Ozzie doesn't list B1 Church plans that have no roles yet, and it marks plans that aren't shared with volunteers yet in the list of plans.",
      "Ozzie can't read background checks from B1 Church: B1 has no built-in background-check feature, and Ozzie doesn't read a custom field or group your church might keep one in.",
    ]);
    expect(cannotSee("breeze")).toEqual([
      "Ozzie can't see roles or volunteers on Breeze's newer scheduling page: Breeze only shares what's on its older Volunteers page.",
      "Ozzie can't tell how many people a Breeze role needs when Breeze didn't share a number of people needed for that role.",
      "Ozzie can't tell from Breeze whether a volunteer who hasn't answered was sent the request: Breeze shows them only as no response.",
      "Ozzie can't place a Breeze time in an hour the clocks skip or repeat, so it can't check a service that starts in one.",
      "Ozzie can't see a change to a Breeze service's time or name until Breeze shares it, which can take up to 15 minutes.",
      "Ozzie can't tell what a Breeze volunteer listed on the service with no role is doing, so it counts them apart and fills no role with them.",
      "Ozzie can't read blockout dates from Breeze.",
      "Ozzie can't suggest who could help from Breeze: it doesn't tie a team to each role.",
      "Ozzie can't read how many people have each tag from Breeze yet.",
      "Ozzie doesn't count Breeze form entries beyond 5 forms, or anything for a service beyond the people checked in to it by name.",
      "Ozzie doesn't read Breeze's anonymous head counts, so a service counted only that way shows no one checked in by name.",
      "Ozzie doesn't read background checks from Breeze.",
    ]);
    expect(cannotSee("genesis")).toEqual([
      "Ozzie can't check whether your service is covered from Genesis: it doesn't share volunteer schedules.",
      "Ozzie can't place Genesis events until you tell it your church's time zone: Genesis gives their times without one.",
      "Ozzie can't place Genesis events that have no start time, so it leaves them out.",
      "Ozzie doesn't read background checks from Genesis.",
    ]);
    expect(Object.isFrozen(cannotSee("b1"))).toBe(true);
  });

  it("asks about B1 Church's time zone by name, and none for the others when a zone is known", () => {
    expect(toConfirm("b1", "America/Chicago", { source: "system" })).toBe("B1 Church says your church's time zone is America/Chicago. Is that right?");
    for (const system of ["breeze", "genesis"] as const) expect(toConfirm(system, "America/Chicago")).toBeNull();
  });

  it("re-check N9: says where the zone came from only when the page says so, and is true either way otherwise", () => {
    expect(toConfirm("b1", "Pacific/Auckland", { source: "system" })).toBe("B1 Church says your church's time zone is Pacific/Auckland. Is that right?");
    expect(toConfirm("b1", "Pacific/Auckland", { source: "person" })).toBe("You gave Pacific/Auckland as your church's time zone. Is that right?");
    expect(toConfirm("b1", "Pacific/Auckland")).toBe("This check has Pacific/Auckland as your church's time zone. Is that right?");
  });

  it("re-check N10: a zone counts only in its canonical spelling", () => {
    for (const zone of ["Pacific/auckland", "PACIFIC/AUCKLAND", "US/Central", "Etc/UTC"]) {
      expect(toConfirm("b1", zone, { source: "system" }), zone).toBe("Which time zone does your church meet in?");
      expect(toConfirm("genesis", zone), zone).toBe("Which time zone does your church meet in?");
    }
    expect(toConfirm("b1", "UTC", { source: "system" })).toBe("B1 Church says your church's time zone is UTC. Is that right?");
  });

  it("asks Genesis churches which time zone they meet in until they've given one this Mac knows (L5)", () => {
    expect(toConfirm("genesis", null)).toBe("Which time zone does your church meet in?");
    expect(toConfirm("genesis", "America/Nowhere")).toBe("Which time zone does your church meet in?");
    expect(toConfirm("genesis", "America/Denver")).toBeNull();
    for (const system of ["breeze"] as const) expect(toConfirm(system, null)).toBeNull();
  });

  it("names B1 Church's zone when B1 gave one this Mac knows, and otherwise asks which zone the church meets in (re-check N1)", () => {
    expect(toConfirm("b1", null)).toBe("Which time zone does your church meet in?");
    expect(toConfirm("b1", "America/Nowhere")).toBe("Which time zone does your church meet in?");
    expect(toConfirm("b1", "Pacific/Auckland", { source: "system" })).toBe("B1 Church says your church's time zone is Pacific/Auckland. Is that right?");
  });

  it("shows what B1's zone makes of this plan when the page passes the local start, so a wrong yes is harder", () => {
    expect(toConfirm("b1", "America/New_York", { source: "system", localStart: "Saturday, November 21 at 1:00 AM" }))
      .toBe("B1 Church says your church's time zone is America/New_York. That makes this service start at Saturday, November 21 at 1:00 AM. Is that right?");
    expect(toConfirm("b1", "America/New_York", { source: "system", localStart: "Sunday at 10:00 AM" }))
      .toBe("B1 Church says your church's time zone is America/New_York. That makes this service start at Sunday at 10:00 AM. Is that right?");
    // Nothing passed, or anything but a weekday, a month, "at", digits, AM or PM (re-check N11): the question without it.
    const starts = [undefined, "", "  ", "a\nb", "x".repeat(61), "Sunday at 10:00 with Avery Fictional", "\u202eMA 00:01 ta yadnuS",
      "Sunday\u200b at 10", "<b>Sunday</b>", "Sunday at 10:00 AM, ask Rowan", "Someday at 10:00 AM"];
    for (const localStart of starts) {
      expect(toConfirm("b1", "America/New_York", { source: "system", ...(localStart === undefined ? {} : { localStart }) }), String(localStart))
        .toBe("B1 Church says your church's time zone is America/New_York. Is that right?");
    }
    expect(toConfirm("b1", null, { localStart: "Sunday at 10:00 AM" })).toBe("Which time zone does your church meet in?");
    expect(toConfirm("genesis", null, { localStart: "Sunday at 10:00 AM" })).toBe("Which time zone does your church meet in?");
  });

  it("holds back Genesis events placed in a zone other than the one the leader confirmed", () => {
    const capture = factsCapture("genesis");
    const held = systemFacts(capture, { confirmedZone: "Pacific/Auckland" });
    expect(held.events).toEqual([]);
    expect(held.reads.events).toEqual({ outcome: "held-for-zone", checked_at: CHECKED });
    expect(held.counts.events).toEqual({ outcome: "held-for-zone", checked_at: CHECKED });
    // A zone in another spelling than its canonical one counts for nothing (re-check N10).
    const lower = factsCapture("genesis", { church: { id: "ORG-maple", time_zone: "america/denver" } });
    expect(systemFacts(lower, { confirmedZone: "america/denver" }).events).toEqual([]);
    expect(held.waiting_for_zone).toBe(true);
    for (const facts of [systemFacts(capture), systemFacts(capture, { confirmedZone: null })]) {
      expect(facts.events).toEqual([]);
      expect(facts.waiting_for_zone).toBe(true);
    }
    const shown = systemFacts(capture, { confirmedZone: "America/Denver" });
    expect(shown.events.map(e => e.event_id)).toEqual(["E1", "E2"]);
    expect(shown.waiting_for_zone).toBe(false);
    // Groups and forms don't depend on the zone; nor do other systems' events.
    expect(held.groups).toEqual(shown.groups);
    expect(systemFacts(b1Capture()).events.map(e => e.event_id)).toEqual(["SES-nov15"]);
  });

  it("says plainly that a B1 Church plan waits for the time zone to be confirmed (L6)", () => {
    expect(waitingForZone()).toBe("Ozzie is waiting for you to confirm your church's time zone before it checks this plan.");
  });

  it("builds B1 Church's key steps from one list of read boxes, and labels a plan not yet shared with volunteers", () => {
    // Live: a key with only the groups read box gave the same full check and plan list as one with three.
    expect(B1_KEY_BOXES).toEqual(["groups"]);
    expect(howToConnect("b1")[0]).toContain("ticking only the read box for groups: Ozzie needs nothing else.");
    expect(notSharedYet("b1")).toBe("Not shared with volunteers yet in B1 Church.");
    for (const system of ["breeze", "genesis"] as const) expect(notSharedYet(system)).toBeNull();
    // The plan list's `shared`: true needs no label, false is not shared yet, null couldn't be read.
    expect(sharedLabel("b1", true)).toBeNull();
    expect(sharedLabel("b1", false)).toBe("Not shared with volunteers yet in B1 Church.");
    expect(sharedLabel("b1", null)).toBe("Ozzie couldn't tell whether this plan is shared with volunteers yet.");
    expect(sharedLabel("breeze", null)).toBeNull();
    // On the checked plan's result, only when it isn't shared yet.
    expect(notSharedNotice("b1", false)).toBe("This plan isn't shared with volunteers yet in B1 Church, so they may not have seen it.");
    expect(notSharedNotice("b1", true)).toBeNull();
    expect(notSharedNotice("b1", null)).toBeNull();
    expect(notSharedNotice("breeze", false)).toBeNull();
  });

  it("says plainly what a church needs to let Ozzie read each system", () => {
    expect(howToConnect("b1")).toEqual([
      "An admin makes an API key in B1 Church under Settings > Developer > API Keys, ticking only the read box for groups: Ozzie needs nothing else.",
      "Leave the key's expiry date empty, or the key stops working on that date.",
      "Make the key as a person who can view group members in B1 Church (Group Members: View): team lists and names depend on it, and the key sees only what that person can see.",
    ]);
    expect(howToConnect("breeze")).toEqual([
      "The account owner copies the API key from the account's API Key page in Breeze (Manage Account > API Key).",
      "Breeze is becoming Tithely Church Management, so you may see that name instead.",
      "That key can make changes in Breeze, but Ozzie only reads.",
    ]);
    expect(howToConnect("genesis")).toEqual([
      "An owner or admin makes a key in Genesis under Settings > Integrations, in the section AI Assistants & Developer API: on the API keys tab, press Create key, give the key a name, and tick Read for Groups, Events and Forms only.",
      "Untick Read for People, which Genesis ticks for you: Ozzie doesn't read anyone's name from Genesis.",
      "Genesis shows the key only once, so paste it into Ozzie straight away.",
    ]);
  });

  it("turns every read outcome into one plain sentence for the page, with Breeze's key and slow-down words", () => {
    expect(readProblem("breeze", "key-refused")).toBe("Breeze didn't accept this key.");
    expect(readProblem("breeze", "rate-limited")).toBe("Breeze asked Ozzie to slow down, so this check stopped early. Check again in a few minutes.");
    // A Breeze read refused after others worked: that part only (the check went on).
    expect(readProblem("breeze", "refused")).toBe("Breeze didn't let Ozzie read this part.");
    expect(readProblem("b1", "ok")).toBeNull();
    expect(Object.fromEntries([...READ_OUTCOMES, "not-read", "held-for-zone"].map(o => [o, readProblem("genesis", o as "ok")]))).toEqual({
      ok: null,
      truncated: "Ozzie read only part of this from Genesis.",
      "not-requested": "Ozzie didn't read this from Genesis this time.",
      refused: "Genesis didn't let Ozzie read this.",
      "not-found": "Genesis couldn't find this.",
      "rate-limited": "Genesis asked Ozzie to slow down, so this check stopped early. Check again in a few minutes.",
      timeout: "Genesis took too long to answer.",
      unreachable: "Ozzie couldn't reach Genesis.",
      "too-large": "Genesis sent more than Ozzie reads at once.",
      "invalid-response": "Genesis sent something Ozzie couldn't read.",
      "key-refused": "Genesis didn't accept this key.",
      "not-read": "Ozzie didn't read this from Genesis.",
      "held-for-zone": "Ozzie is waiting for you to confirm your church's time zone before it shows these.",
    });
  });

  it("says how many people are on the service without a role, and that a role's number wasn't shared", () => {
    expect(onServiceWithoutRole(0)).toBeNull();
    expect(onServiceWithoutRole(1)).toBe("1 person is listed on this service without a role.");
    expect(onServiceWithoutRole(4)).toBe("4 people are listed on this service without a role.");
    expect(onServiceWithoutRole(-1)).toBeNull();
    expect(onServiceWithoutRole(1.5)).toBeNull();
    expect(unknownNeed("breeze")).toBe("Breeze didn't share a number of people needed for this role.");
    expect(unknownNeed("b1")).toBe("B1 Church didn't share a number of people needed for this role.");
    expect(unknownNeed("genesis")).toBeNull();
  });

  it("has a reason word ready for forms Ozzie didn't count because it counts only the newest few", () => {
    const words: string[] = ["not-given", "not-read-yet", "not-checked", "not-in-newest", "not-ended", "no-end-time"];
    expect(words).toContain(NEWEST_ONLY);
  });

  it("says plainly when a service's planning has no roles, with Breeze's newer scheduling page named", () => {
    expect(noRoles("b1")).toEqual(["Planning for this service has no roles in B1 Church."]);
    expect(noRoles("breeze")).toEqual([
      "Ozzie found no roles for this service in Breeze.",
      "Ozzie can't see roles or volunteers on Breeze's newer scheduling page: Breeze only shares what's on its older Volunteers page.",
    ]);
    expect(noRoles("genesis")).toEqual([]);
  });

  it.each(SYSTEM_IDS)("keeps %s's sentences in plain product language", system => {
    const questions = [toConfirm(system, "America/Chicago", { source: "system", localStart: "Wednesday, November 25 at 7:00 PM" }),
      toConfirm(system, "America/Chicago", { source: "person" }), toConfirm(system, "America/Chicago"), toConfirm(system, null)]
      .filter((q): q is string => q !== null);
    for (const line of [...cannotSee(system), ...questions, ...noRoles(system), ...howToConnect(system), waitingForZone()]) {
      expect(line.match(FORBIDDEN)?.[0] ?? null, line).toBeNull();
      expect(line.match(NEVER)?.[0] ?? null, line).toBeNull();
      expect(line.match(/\b(?:token|connector|credentials?)\b/iu)?.[0] ?? null, line).toBeNull();
      expect(line).toMatch(/^[A-Z].*[.?]$/u);
    }
    for (const line of cannotSee(system)) expect(line).toMatch(/^Ozzie (?:can't|doesn't|checks) [a-z].*\.$/u);
    for (const line of [...READ_OUTCOMES, "not-read", "held-for-zone"].flatMap(o => readProblem(system, o as "ok") ?? [])) {
      expect(line.match(FORBIDDEN)?.[0] ?? null, line).toBeNull();
      expect(line.match(NEVER)?.[0] ?? null, line).toBeNull();
      expect(line).toMatch(/^[A-Z].*\.$/u);
    }
    const whys = (["not-given", "not-read-yet", "not-checked", "not-in-newest", "not-ended", "no-end-time"] as const).map(w => whyNullSentence(system, w));
    for (const line of [onServiceWithoutRole(1), onServiceWithoutRole(3), unknownNeed(system), notSharedYet(system), sharedLabel(system, null), notSharedNotice(system, false), ...whys]
      .filter((l): l is string => l !== null)) {
      expect(line.match(FORBIDDEN)?.[0] ?? null, line).toBeNull();
      expect(line.match(NEVER)?.[0] ?? null, line).toBeNull();
    }
  });
});

describe("Genesis as seen live (2026-11-19)", () => {
  it("says no attendance for an event still to come, and says it for one that has ended", () => {
    const facts = systemFacts(factsCapture("genesis", { church: { id: "ORG-maple", time_zone: "America/New_York" }, completed_at: "2026-11-25T17:00:00Z", events: [
      { id: "picnic", starts_at: "2026-12-02T11:00:00-05:00", ends_at: "2026-12-02T14:00:00-05:00", attendance: 0 },
      { id: "dinner", starts_at: "2026-11-24T18:00:00-05:00", ends_at: "2026-11-24T20:00:00-05:00", attendance: 31 },
      { id: "nightly", starts_at: "2026-11-25T11:00:00-05:00", ends_at: null, attendance: 4 }] }), { confirmedZone: "America/New_York" });
    expect(facts.events.map(e => [e.event_id, e.attendance, e.why_null])).toEqual([["picnic", null, "upcoming"], ["dinner", 31, null], ["nightly", 4, null]]);
    expect(whyNullSentence("genesis", "upcoming")).toBe("Not yet: this event hasn't happened.");
  });

  it("makes a form's slug readable and leaves a church's own wording alone", () => {
    expect(readableName("visitor-connection-card")).toBe("Visitor connection card");
    expect(readableName("prayer_card")).toBe("Prayer card");
    for (const kept of ["Prayer Card", "prayer", "Fall Sign-up", "Youth Night 2026", "a-b c"]) expect(readableName(kept)).toBe(kept);
  });
});
