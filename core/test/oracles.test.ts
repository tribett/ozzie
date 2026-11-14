import { describe, expect, it } from "vitest";
import { isUrgent, inQuietHours } from "../src/oracles.js";

const SUNDAY = new Date("2026-11-22T14:00:00Z"); // Sunday service instant

describe("48h urgency boundary (checked, solid facts only)", () => {
  it("47:59 before is urgent, exactly 48:00 is urgent, 48:00:01 is not", () => {
    expect(isUrgent(new Date(SUNDAY.getTime() - (47 * 3600 + 59 * 60) * 1000), SUNDAY)).toBe(true);
    expect(isUrgent(new Date(SUNDAY.getTime() - 48 * 3600 * 1000), SUNDAY)).toBe(true);
    expect(isUrgent(new Date(SUNDAY.getTime() - (48 * 3600 + 1) * 1000), SUNDAY)).toBe(false);
  });
  it("uncertain items never interrupt, however close", () => {
    expect(isUrgent(new Date(SUNDAY.getTime() - 3600 * 1000), SUNDAY, false)).toBe(false);
  });
});

describe("quiet hours 21:00-07:00 with injected clock", () => {
  it("inside, outside, and boundary instants", () => {
    expect(inQuietHours(new Date("2026-11-20T21:00:00"))).toBe(true);
    expect(inQuietHours(new Date("2026-11-21T03:30:00"))).toBe(true);
    expect(inQuietHours(new Date("2026-11-21T07:00:00"))).toBe(false);
    expect(inQuietHours(new Date("2026-11-21T12:00:00"))).toBe(false);
    expect(inQuietHours(new Date("2026-11-21T20:59:00"))).toBe(false);
  });
});
