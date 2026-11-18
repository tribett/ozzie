// The words every surface uses for the watched service (onboarding spec §5.1, decision 18): the real day, never
// "Sunday" for a service on another day. Fixed fictional plans; no clock, no I/O.
import { describe, expect, it } from "vitest";
import { dayWords, planTimes, SUNDAY_WORDS } from "../src/service-day.js";

const CHICAGO = "America/Chicago";
// Planning Center's sort_date is the church's wall-clock time with a misleading Z (church-time.ts).
const sunday = { sort_date: "2026-11-22T09:00:00Z", times: ["2026-11-22T15:00:00Z", "2026-11-22T17:00:00Z"] };
const saturday = { sort_date: "2026-11-21T17:00:00Z", times: ["2026-11-21T23:00:00Z"] };
const wednesday = { sort_date: "2026-11-25T19:00:00Z", times: ["2026-11-26T01:00:00Z"] };
const weekend = { sort_date: "2026-11-21T17:00:00Z", times: ["2026-11-21T23:00:00Z", "2026-11-22T15:00:00Z"] };
const spread = { sort_date: "2026-11-25T19:00:00Z", times: ["2026-11-26T01:00:00Z", "2026-11-29T15:00:00Z"] };

describe("dayWords", () => {
  it("a Sunday plan reads Sunday", () => {
    const w = dayWords(sunday, CHICAGO);
    expect(w).toMatchObject({ kind: "weekday", weekday: 0, day: "Sunday", Day: "Sunday", page: "Sunday", question: "Is Sunday covered?",
      date: "Sunday, November 22", thisOne: "this Sunday" });
  });

  it("a Saturday plan reads Saturday", () => {
    expect(dayWords(saturday, CHICAGO)).toMatchObject({ kind: "weekday", weekday: 6, day: "Saturday", page: "Saturday", question: "Is Saturday covered?",
      date: "Saturday, November 21", thisOne: "this Saturday" });
  });

  it("a Wednesday plan reads Wednesday, from its service time in the church's zone, never Sunday", () => {
    const w = dayWords(wednesday, CHICAGO);
    expect(w).toMatchObject({ day: "Wednesday", question: "Is Wednesday covered?", date: "Wednesday, November 25", thisOne: "this Wednesday" });
    expect(JSON.stringify(w)).not.toContain("Sunday");
  });

  it("times on the Saturday and Sunday of one weekend read as this weekend's services", () => {
    expect(dayWords(weekend, CHICAGO)).toMatchObject({ kind: "weekend", day: "this weekend's services", Day: "This weekend's services", page: "This weekend",
      question: "Are this weekend's services covered?", date: "Saturday, November 21 and Sunday, November 22", thisOne: "this weekend" });
  });

  it("any other spread reads as these services, with the dates", () => {
    expect(dayWords(spread, CHICAGO)).toMatchObject({ kind: "spread", day: "these services", Day: "These services", page: "These services",
      question: "Are these services covered?", date: "Wednesday, November 25 to Sunday, November 29", thisOne: "these services" });
  });

  it("nothing chosen reads as your service", () => {
    const w = dayWords(null, CHICAGO);
    expect(w).toMatchObject({ kind: "unknown", weekday: null, day: "your service", Day: "Your service", question: "Is your service covered?", date: null });
    expect(JSON.stringify(w)).not.toContain("Sunday");
  });

  it("before the first read (no times, no zone), the weekday of sort_date", () => {
    expect(dayWords({ sort_date: "2026-11-25T19:00:00Z" }, null)).toMatchObject({ day: "Wednesday", date: "Wednesday, November 25" });
    expect(dayWords({ sort_date: "not a date" }, null).kind).toBe("unknown");
  });

  it("a late-evening service is on the church's day, not UTC's (the time-zone edge at midnight)", () => {
    // 11:30 PM Saturday in Chicago is Sunday 05:30 UTC.
    const late = { sort_date: "2026-11-21T23:30:00Z", times: ["2026-11-22T05:30:00Z"] };
    expect(dayWords(late, CHICAGO).day).toBe("Saturday");
    expect(dayWords(late, "Asia/Tokyo").day).toBe("Sunday");
  });

  it("the generic Sunday words (the fictional example and tests) say Sunday without a date", () => {
    expect(SUNDAY_WORDS).toMatchObject({ day: "Sunday", page: "Sunday", question: "Is Sunday covered?", date: null, thisOne: "this Sunday" });
  });

  it("reads the service times from a check's plan_times, leaving out rehearsals", () => {
    const reads = [{ collection: "plan_times", outcome: "ok", body: { data: [
      { type: "PlanTime", id: "1", attributes: { starts_at: "2026-11-22T15:00:00Z", time_type: "service" } },
      { type: "PlanTime", id: "2", attributes: { starts_at: "2026-11-21T23:00:00Z", time_type: "rehearsal" } },
      { type: "PlanTime", id: "3", attributes: { starts_at: "nope", time_type: "service" } },
    ] } }];
    expect(planTimes(reads)).toEqual(["2026-11-22T15:00:00Z"]);
    expect(planTimes([])).toEqual([]);
  });
});
