import { describe, expect, it } from "vitest";
import { churchZone, isTimeZone, localDay, planDate, planStart } from "../src/church-time.js";
import { nov22Capture } from "../src/fictional-sunday.js";
import type { SundayCapture } from "../src/sunday-capture.js";

// Reference: the first minute whose local date is D, and the first whose local date is after D.
const dateIn = (t: number, zone: string) => new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t));
function reference(date: string, zone: string) {
  const base = Date.parse(`${date}T00:00:00Z`);
  let s = NaN, e = NaN;
  for (let t = base - 16 * 3600e3; t < base + 40 * 3600e3; t += 60e3) {
    const d = dateIn(t, zone);
    if (Number.isNaN(s) && d === date) s = t;
    if (!Number.isNaN(s) && Number.isNaN(e) && d > date) e = t;
  }
  return { starts_at: new Date(s).toISOString(), ends_at: new Date(e).toISOString() };
}

describe("the church-local day", () => {
  it.each([
    ["2026-11-01", "America/New_York"], ["2027-03-14", "America/New_York"],
    // Daylight saving starts at midnight here: the day begins at 01:00 local.
    ["2027-03-14", "America/Havana"], ["2026-09-06", "America/Santiago"],
    ["2026-11-01", "America/Havana"], ["2027-03-28", "Asia/Beirut"], ["2026-10-25", "Asia/Beirut"], ["2027-04-04", "America/Santiago"],
    ["2026-10-04", "America/Asuncion"], ["2026-11-22", "Pacific/Kiritimati"], ["2026-11-22", "Pacific/Pago_Pago"],
    // A name this Mac canonicalizes (to Asia/Katmandu) is still that zone.
    ["2026-11-22", "Asia/Kathmandu"], ["2026-11-22", "Asia/Kolkata"],
    ["2026-10-04", "Australia/Lord_Howe"], ["2027-04-04", "Australia/Lord_Howe"], ["2026-11-22", "Pacific/Chatham"], ["2026-03-29", "Europe/London"],
  ])("%s in %s matches the minute-by-minute reference", (date, zone) => {
    expect(localDay(date, zone)).toEqual(reference(date, zone));
  });
  it("refuses dates and zones it can't place", () => {
    expect(localDay("2026-02-30", "America/New_York")).toBeNull();
    expect(localDay("2026-11-22", "Eastern Time (US & Canada)")).toBeNull();
  });
});

describe("the church's time zone", () => {
  it("accepts IANA names, including canonicalized ones, and nothing else", () => {
    for (const zone of ["America/New_York", "Asia/Kolkata", "Asia/Kathmandu", "Etc/UTC", "UTC", "Etc/GMT+5", "America/Argentina/Buenos_Aires"]) expect(isTimeZone(zone)).toBe(true);
    for (const zone of ["Eastern Time (US & Canada)", "EST", "Nope/Zone", "", "America/New_York\u0000", 5, null, "A/".padEnd(70, "b")]) expect(isTimeZone(zone)).toBe(false);
  });
  it("comes only from this organization's Services Organization read", () => {
    expect(churchZone(nov22Capture())).toEqual({ zone: "America/New_York", problem: null });
    const without: SundayCapture = { ...nov22Capture(), reads: nov22Capture().reads.filter(r => r.collection !== "organization") };
    expect(churchZone(without)).toEqual({ zone: null, problem: "missing" });
    expect(churchZone({ ...nov22Capture(), organization: "1002" })).toEqual({ zone: null, problem: "failed" });
    const refused = nov22Capture();
    const read = refused.reads.find(r => r.collection === "organization")!;
    read.outcome = "denied"; delete read.body;
    expect(churchZone(refused)).toEqual({ zone: null, problem: "failed" });
    const twice = nov22Capture();
    twice.reads.push(structuredClone(twice.reads.find(r => r.collection === "organization")!));
    expect(churchZone(twice).zone).toBeNull();
  });
});

describe("Plan.sort_date is local wall-clock time (verified live 2026-11-13)", () => {
  it("its date part is the Sunday, whatever the suffix", () => {
    expect(planDate("2026-11-22T09:30:00Z")).toBe("2026-11-22");
    // An early service is still that Sunday: never converted from UTC.
    expect(planDate("2026-11-22T00:30:00Z")).toBe("2026-11-22");
    expect(planDate("2026-11-22T23:30:00-05:00")).toBe("2026-11-22");
    expect(planDate("not a date")).toBeNull();
    expect(planDate("2026-13-01T09:00:00Z")).toBeNull();
  });
  it("its time is local to the church: 09:30Z in Eastern is the 14:30Z instant", () => {
    expect(planStart("2026-11-22T09:30:00Z", "America/New_York")).toBe("2026-11-22T14:30:00.000Z");
    expect(planStart("2026-11-22T09:30:00Z", "Asia/Kathmandu")).toBe("2026-11-22T03:45:00.000Z");
    // Without the church's zone there is no instant to name.
    expect(planStart("2026-11-22T09:30:00Z", null)).toBeNull();
    // A wall-clock time skipped by daylight saving doesn't exist.
    expect(planStart("2027-03-14T02:30:00Z", "America/New_York")).toBeNull();
  });
  it("the fictional plan reads as Planning Center gives it", () => {
    const plan = nov22Capture().reads.find(r => r.collection === "plan")!.body!.data as { attributes: { sort_date: string } };
    expect(plan.attributes.sort_date).toBe("2026-11-22T09:30:00Z");
  });
});
