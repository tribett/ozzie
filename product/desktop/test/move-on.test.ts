// Moving on by itself (onboarding spec §5.3): once the watched plan's day has passed in the church's zone, Ozzie asks for
// the same service's next plan, maybe next Wednesday, never assuming Sunday. Fixed plans and clocks; a fake `nextPlan`.
import { describe, expect, it, vi } from "vitest";
import { hasPassed, movedText, moveOn, planLocalDate, waitingText, WAIT_AGAIN_MS, type WatchedPlan } from "../src/move-on.js";
import type { PlanOption } from "../src/onboarding-bridge.js";

const CHICAGO = "America/Chicago";
// Youth Night, Wednesday November 18, 7:00 PM in Chicago: 01:00 the next day in UTC. Planning Center's sort_date is the
// church's wall clock with a misleading Z.
const youthNight: WatchedPlan = { serviceTypeId: "1694699", planId: "92900018", sort_date: "2026-11-18T19:00:00Z", times: ["2026-11-19T01:00:00Z"], serviceName: "Youth Night" };
const nextWednesday: PlanOption = { id: "92900025", sort_date: "2026-11-25T19:00:00Z", title: null, series_title: null, times: ["2026-11-26T01:00:00Z"] };

describe("the watched plan's day, in the church's zone", () => {
  it("is the local date of its service time, not the UTC date", () => {
    expect(planLocalDate(youthNight, CHICAGO)).toBe("2026-11-18");
    // Without the zone, the date part of Planning Center's wall clock.
    expect(planLocalDate(youthNight, null)).toBe("2026-11-18");
  });

  it("has passed only once the church's own midnight has", () => {
    // 11:00 PM Wednesday in Chicago: already Thursday in UTC, but the service's day hasn't passed.
    expect(hasPassed(youthNight, CHICAGO, "2026-11-19T05:00:00Z")).toBe(false);
    // 11:59:59 PM Wednesday: still Wednesday.
    expect(hasPassed(youthNight, CHICAGO, "2026-11-19T05:59:59Z")).toBe(false);
    // Midnight in Chicago: Thursday, so Wednesday has passed.
    expect(hasPassed(youthNight, CHICAGO, "2026-11-19T06:00:00Z")).toBe(true);
    // Earlier the same Wednesday: not passed.
    expect(hasPassed(youthNight, CHICAGO, "2026-11-18T15:00:00Z")).toBe(false);
  });

  it("a weekend plan passes only after its last service day", () => {
    const weekend = { sort_date: "2026-11-21T17:00:00Z", times: ["2026-11-21T23:00:00Z", "2026-11-22T15:00:00Z"] };
    expect(hasPassed(weekend, CHICAGO, "2026-11-22T12:00:00Z")).toBe(false);
    expect(hasPassed(weekend, CHICAGO, "2026-11-23T06:00:00Z")).toBe(true);
  });

  it("can't be placed: kept, never guessed", () => {
    expect(hasPassed({ sort_date: null }, CHICAGO, "2026-12-01T12:00:00Z")).toBe(false);
    expect(hasPassed(youthNight, "Not/AZone", "2026-12-01T12:00:00Z")).toBe(false);
  });
});

describe("moveOn", () => {
  it("a passed plan moves on to the next plan of the same service, with What happened's sentence", async () => {
    const nextPlan = vi.fn(async () => nextWednesday);
    const result = await moveOn(youthNight, CHICAGO, "2026-11-19T12:00:00Z", nextPlan);
    expect(nextPlan).toHaveBeenCalledWith("1694699", "2026-11-18");
    expect(result).toEqual({ kind: "moved", plan: nextWednesday, passed: "2026-11-18",
      line: "Moved on to Wednesday, November 25 (Youth Night) because November 18 has passed." });
    expect(result.kind === "moved" && result.line).not.toContain("Sunday");
  });

  it("a plan whose day hasn't passed: nothing happens and native isn't asked", async () => {
    const nextPlan = vi.fn(async () => nextWednesday);
    // Late Wednesday evening in Chicago (Thursday in UTC).
    expect(await moveOn(youthNight, CHICAGO, "2026-11-19T05:00:00Z", nextPlan)).toEqual({ kind: "stay" });
    // A plan someone chose further ahead stays until it passes.
    expect(await moveOn({ ...youthNight, sort_date: "2026-12-02T19:00:00Z", times: ["2026-12-03T01:00:00Z"] }, CHICAGO, "2026-11-19T12:00:00Z", nextPlan)).toEqual({ kind: "stay" });
    expect(nextPlan).not.toHaveBeenCalled();
  });

  it("none planned yet: waiting, with Today's sentence, and Ozzie looks again in an hour", async () => {
    const result = await moveOn(youthNight, CHICAGO, "2026-11-19T12:00:00Z", async () => null);
    expect(result).toEqual({ kind: "waiting", passed: "2026-11-18", line: "Ozzie is waiting for the next Youth Night plan in Planning Center." });
    expect(WAIT_AGAIN_MS).toBe(3_600_000);
  });

  it("never moves to the same plan, or to one that isn't after the passed day", async () => {
    const same = { ...nextWednesday, id: youthNight.planId };
    expect((await moveOn(youthNight, CHICAGO, "2026-11-19T12:00:00Z", async () => same)).kind).toBe("waiting");
    const sameDay = { ...nextWednesday, sort_date: "2026-11-18T21:00:00Z", times: ["2026-11-19T03:00:00Z"] };
    expect((await moveOn(youthNight, CHICAGO, "2026-11-19T12:00:00Z", async () => sameDay)).kind).toBe("waiting");
  });

  it("at the church's midnight exactly, it moves on", async () => {
    const result = await moveOn(youthNight, CHICAGO, "2026-11-19T06:00:00Z", async () => nextWednesday);
    expect(result.kind).toBe("moved");
  });

  it("a Sunday service still moves on to its next Sunday", async () => {
    const sunday: WatchedPlan = { serviceTypeId: "1694698", planId: "92902197", sort_date: "2026-11-22T09:00:00Z", times: ["2026-11-22T15:00:00Z"], serviceName: "Sunday Morning" };
    const next: PlanOption = { id: "92902200", sort_date: "2026-11-29T09:00:00Z", title: "Advent 1", series_title: null, times: ["2026-11-29T15:00:00Z"] };
    const result = await moveOn(sunday, CHICAGO, "2026-11-23T08:00:00Z", async () => next);
    expect(result).toMatchObject({ kind: "moved", line: "Moved on to Sunday, November 29 (Sunday Morning) because November 22 has passed." });
  });

  it("a rejected ask rejects, so the caller keeps its plan and tries again at the next check", async () => {
    await expect(moveOn(youthNight, CHICAGO, "2026-11-19T12:00:00Z", async () => { throw { "sunday-choices": "rate-limited" }; })).rejects.toEqual({ "sunday-choices": "rate-limited" });
  });
});

describe("the words", () => {
  it("name the service by its Planning Center name, or say plainly when it has none", () => {
    expect(waitingText(null)).toBe("Ozzie is waiting for the next plan in Planning Center.");
    expect(movedText(nextWednesday, null, "2026-11-18", CHICAGO)).toBe("Moved on to Wednesday, November 25 because November 18 has passed.");
    // Without its times, the plan's own wall-clock date.
    expect(movedText({ sort_date: "2026-11-25T19:00:00Z", times: [] }, "Youth Night", "2026-11-18", null)).toBe("Moved on to Wednesday, November 25 (Youth Night) because November 18 has passed.");
  });
});
