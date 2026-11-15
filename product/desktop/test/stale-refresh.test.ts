import { describe, expect, it } from "vitest";
import { shouldRefreshStale, STALE_REFRESH_GAP_MS, type StaleRefreshInput } from "../src/stale-refresh.js";

const base: StaleRefreshInput = { visible: true, fictional: false, ready: true, staleLive: true, paused: false, running: false, nowMs: 1_000_000_000, lastAttemptMs: 0 };

describe("an out-of-date check while the window is open", () => {
  it("is read again", () => {
    expect(shouldRefreshStale(base)).toBe(true);
  });
  it.each([
    ["the window is closed", { visible: false }],
    ["the fictional example is showing", { fictional: true }],
    ["Planning Center isn't connected or no Sunday is chosen", { ready: false }],
    ["the check is still current, or a saved recording is showing", { staleLive: false }],
    ["automatic checks are paused", { paused: true }],
    ["a check is already running", { running: true }],
  ] as const)("is left alone when %s", (_name, change) => {
    expect(shouldRefreshStale({ ...base, ...change })).toBe(false);
  });
  it("waits ten minutes after an attempt before trying again", () => {
    const last = base.nowMs - STALE_REFRESH_GAP_MS + 1;
    expect(shouldRefreshStale({ ...base, lastAttemptMs: last })).toBe(false);
    expect(shouldRefreshStale({ ...base, lastAttemptMs: base.nowMs - STALE_REFRESH_GAP_MS })).toBe(true);
  });
});
