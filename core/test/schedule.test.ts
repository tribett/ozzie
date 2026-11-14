import { describe, expect, it } from "vitest";
import {
  DEFAULT_QUIET_HOURS, DEFAULT_SCHEDULE, finishRun, holdNotice, inQuietHours, launchSchedule, newSchedule, noticeDecision,
  parseClock, pauseSchedule, releaseHeld, resumeSchedule, retryDelayMs, rescheduleFor, startManual, tickSchedule,
  type ScheduleState,
} from "../src/schedule.js";

// A fake clock: every function takes `now`; nothing reads the system time.
const T0 = Date.parse("2026-11-20T15:00:00Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const settings = DEFAULT_SCHEDULE;
const ok = { ok: true } as const;
const failed = { ok: false, problem: "Planning Center couldn't be checked just now." } as const;
const ready = true;

/** Launch, run the launch check, and finish it successfully at `minutes`. */
function afterFirstCheck(minutes = 0): ScheduleState {
  const launched = launchSchedule(newSchedule(), settings, at(minutes)).state;
  const started = tickSchedule(launched, at(minutes), ready);
  expect(started.start).toBe("launch");
  return finishRun(started.state, settings, at(minutes + 1), ok);
}

describe("scheduled Sunday checks", () => {
  it("checks on launch, then every 60 minutes by default", () => {
    expect(DEFAULT_SCHEDULE).toEqual({ intervalMinutes: 60, runOnLaunch: true });
    const s = afterFirstCheck();
    expect(s.last_run).toMatchObject({ trigger: "launch", outcome: "ok", started_at: at(0), finished_at: at(1) });
    expect(s.next_run_at).toBe(at(61));
    expect(tickSchedule(s, at(60), ready).start).toBeUndefined();
    expect(tickSchedule(s, at(61), ready).start).toBe("scheduled");
  });

  it("an adjusted interval moves the next check from the last one", () => {
    const s = afterFirstCheck();
    expect(rescheduleFor(s, { ...settings, intervalMinutes: 30 }, at(10)).next_run_at).toBe(at(31));
    // Already overdue under the new interval: due now, not in the past.
    expect(rescheduleFor(s, { ...settings, intervalMinutes: 15 }, at(40)).next_run_at).toBe(at(40));
  });

  it("never starts a second check while one is running", () => {
    const launched = launchSchedule(newSchedule(), settings, at(0)).state;
    const running = tickSchedule(launched, at(0), ready).state;
    expect(running.running).toMatchObject({ trigger: "launch", started_at: at(0) });
    expect(tickSchedule(running, at(1), ready).start).toBeUndefined();
    expect(startManual(running, at(1)).start).toBeUndefined();
    const s = finishRun(running, settings, at(2), ok);
    expect(startManual(s, at(3))).toMatchObject({ start: "manual", state: { running: { trigger: "manual" } } });
  });

  it("a manual check resets the schedule from when it finished", () => {
    const s = afterFirstCheck();
    const manual = startManual(s, at(30)).state;
    expect(finishRun(manual, settings, at(31), ok)).toMatchObject({ next_run_at: at(91), last_run: { trigger: "manual" } });
  });

  it("ignores a finish for a run it doesn't know about", () => {
    const s = afterFirstCheck();
    expect(finishRun(s, settings, at(5), failed)).toBe(s);
  });

  it("backs off after failures and returns to the regular interval after a success", () => {
    let s = afterFirstCheck();
    const delays: number[] = [];
    let clock = 61;
    for (let i = 0; i < 8; i++) {
      const started = tickSchedule(s, at(clock), ready);
      expect(started.start).toBe(i === 0 ? "scheduled" : "retry");
      s = finishRun(started.state, settings, at(clock), failed);
      const next = (Date.parse(s.next_run_at!) - Date.parse(at(clock))) / 60_000;
      delays.push(next);
      clock += next;
    }
    expect(delays).toEqual([5, 10, 20, 40, 80, 160, 240, 240]);
    expect(s).toMatchObject({ failures: 8, last_run: { outcome: "failed", problem: failed.problem } });
    const recovered = finishRun(tickSchedule(s, at(clock), ready).state, settings, at(clock), ok);
    expect(recovered).toMatchObject({ failures: 0, next_run_at: at(clock + 60) });
  });

  it("retry delays never exceed a long chosen interval's own spacing", () => {
    expect(retryDelayMs(1, 12 * 3_600_000)).toBe(5 * 60_000);
    expect(retryDelayMs(20, 12 * 3_600_000)).toBe(12 * 3_600_000);
    expect(retryDelayMs(20, 15 * 60_000)).toBe(4 * 3_600_000);
  });

  it("pausing stops automatic checks; Check now still works; resuming checks right away", () => {
    const paused = pauseSchedule(afterFirstCheck());
    expect(paused).toMatchObject({ paused: true, next_run_at: null });
    expect(tickSchedule(paused, at(500), ready).start).toBeUndefined();
    const manual = startManual(paused, at(500));
    expect(manual.start).toBe("manual");
    const done = finishRun(manual.state, settings, at(501), ok);
    expect(done).toMatchObject({ paused: true, next_run_at: null });
    const resumed = resumeSchedule(done, at(600));
    expect(resumed).toMatchObject({ paused: false, next_run_at: at(600) });
    expect(tickSchedule(resumed, at(600), ready).start).toBe("resume");
  });

  it("reports a check missed while Ozzie was closed and catches up on the next launch", () => {
    const s = afterFirstCheck(); // next at 61
    const relaunch = launchSchedule(s, settings, at(61 + 9 * 60));
    expect(relaunch.missed).toBe(at(61));
    expect(relaunch.state.next_run_at).toBe(at(61 + 9 * 60));
    expect(tickSchedule(relaunch.state, at(61 + 9 * 60), ready).start).toBe("catch-up");
  });

  it("doesn't call a check missed when Ozzie reopens on time, was paused, or was waiting for setup", () => {
    const s = afterFirstCheck();
    expect(launchSchedule(s, settings, at(62)).missed).toBeUndefined();
    expect(launchSchedule(pauseSchedule(s), settings, at(600)).missed).toBeUndefined();
    const waiting = tickSchedule(s, at(61), false).state;
    expect(waiting.waiting_since).toBe(at(61));
    expect(launchSchedule(waiting, settings, at(600)).missed).toBeUndefined();
  });

  it("without a launch check, an on-time schedule is kept across a restart", () => {
    const s = afterFirstCheck();
    const relaunch = launchSchedule(s, { ...settings, runOnLaunch: false }, at(30));
    expect(relaunch.state.next_run_at).toBe(at(61));
  });

  it("reports a check missed while this Mac was asleep with Ozzie open", () => {
    const s = afterFirstCheck();
    const woke = tickSchedule(s, at(61 + 180), ready);
    expect(woke).toMatchObject({ start: "catch-up", missed: at(61) });
    // A tick a little late is not a missed check.
    expect(tickSchedule(s, at(63), ready)).toMatchObject({ start: "scheduled" });
    expect(tickSchedule(s, at(63), ready).missed).toBeUndefined();
  });

  it("a check interrupted by closing Ozzie is recorded on the next launch", () => {
    const running = tickSchedule(afterFirstCheck(), at(61), ready).state;
    const relaunch = launchSchedule(running, settings, at(65));
    expect(relaunch.interrupted).toMatchObject({ trigger: "scheduled", started_at: at(61), finished_at: at(65), outcome: "interrupted" });
    expect(relaunch.state.running).toBeNull();
    expect(relaunch.state.last_run?.outcome).toBe("interrupted");
  });

  it("waits, without running or failing, until Planning Center and a Sunday are set up", () => {
    const launched = launchSchedule(newSchedule(), settings, at(0)).state;
    const waiting = tickSchedule(launched, at(0), false);
    expect(waiting.start).toBeUndefined();
    expect(waiting.state).toMatchObject({ running: null, failures: 0, waiting_since: at(0) });
    const later = tickSchedule(waiting.state, at(300), true);
    expect(later).toMatchObject({ start: "launch", state: { waiting_since: null } });
    expect(later.missed).toBeUndefined();
    // Same for a regular check that came due after the connection was lost.
    const disconnected = tickSchedule(afterFirstCheck(), at(61), false).state;
    const reconnected = tickSchedule(disconnected, at(400), true);
    expect(reconnected.start).toBe("scheduled");
    expect(reconnected.missed).toBeUndefined();
  });

  it("the first launch with no launch check still checks right away", () => {
    const s = launchSchedule(newSchedule(), { ...settings, runOnLaunch: false }, at(0)).state;
    expect(s).toMatchObject({ next_run_at: at(0), next_trigger: "launch" });
  });
});

describe("quiet hours and notices", () => {
  const zone = "America/Chicago";
  // 03:30Z = 9:30 PM Chicago (CST, UTC-6) on Nov 20.
  const local = (hhmm: string, day = "2026-11-21") => {
    const [h, m] = hhmm.split(":").map(Number);
    return new Date(Date.parse(`${day}T00:00:00Z`) + ((h! + 6) * 60 + m!) * 60_000).toISOString();
  };

  it("defaults to 9:30 PM to 6:30 AM, in this Mac's local time, across midnight", () => {
    expect(DEFAULT_QUIET_HOURS).toEqual({ start: "21:30", end: "06:30" });
    expect(inQuietHours(DEFAULT_QUIET_HOURS, local("21:29"), zone)).toBe(false);
    expect(inQuietHours(DEFAULT_QUIET_HOURS, local("21:30"), zone)).toBe(true);
    expect(inQuietHours(DEFAULT_QUIET_HOURS, local("23:59"), zone)).toBe(true);
    expect(inQuietHours(DEFAULT_QUIET_HOURS, local("00:00"), zone)).toBe(true);
    expect(inQuietHours(DEFAULT_QUIET_HOURS, local("06:29"), zone)).toBe(true);
    expect(inQuietHours(DEFAULT_QUIET_HOURS, local("06:30"), zone)).toBe(false);
    expect(inQuietHours(DEFAULT_QUIET_HOURS, local("12:00"), zone)).toBe(false);
  });

  it("supports daytime quiet hours, treats equal times as off, and rejects bad times", () => {
    expect(inQuietHours({ start: "12:00", end: "13:00" }, local("12:30"), zone)).toBe(true);
    expect(inQuietHours({ start: "12:00", end: "13:00" }, local("13:00"), zone)).toBe(false);
    expect(inQuietHours({ start: "22:00", end: "22:00" }, local("22:00"), zone)).toBe(false);
    expect(parseClock("06:30")).toBe(390);
    for (const bad of ["6:30", "24:00", "12:60", "", "noon"]) expect(parseClock(bad)).toBeNull();
    expect(inQuietHours({ start: "nope", end: "06:30" }, local("23:00"), zone)).toBe(false);
  });

  it("follows the Mac's time zone, including daylight saving", () => {
    // 2026-07-01 02:00Z is 9:00 PM CDT (UTC-5): before quiet hours.
    expect(inQuietHours(DEFAULT_QUIET_HOURS, "2026-07-01T02:00:00Z", zone)).toBe(false);
    expect(inQuietHours(DEFAULT_QUIET_HOURS, "2026-07-01T02:30:00Z", zone)).toBe(true);
    // The same instant is 11:30 AM in Tokyo.
    expect(inQuietHours(DEFAULT_QUIET_HOURS, "2026-07-01T02:30:00Z", "Asia/Tokyo")).toBe(false);
  });

  it("sends when something got worse, holds during quiet hours, and lets urgent through only if chosen", () => {
    const quiet = { quiet: DEFAULT_QUIET_HOURS, urgentDuringQuiet: false };
    expect(noticeDecision({ worse: false, urgent: false }, quiet, local("12:00"), zone)).toBe("none");
    expect(noticeDecision({ worse: true, urgent: false }, quiet, local("12:00"), zone)).toBe("send");
    expect(noticeDecision({ worse: true, urgent: false }, quiet, local("23:00"), zone)).toBe("hold");
    expect(noticeDecision({ worse: true, urgent: true }, quiet, local("23:00"), zone)).toBe("hold");
    expect(noticeDecision({ worse: true, urgent: true }, { ...quiet, urgentDuringQuiet: true }, local("23:00"), zone)).toBe("send");
    expect(noticeDecision({ worse: true, urgent: false }, { ...quiet, urgentDuringQuiet: true }, local("23:00"), zone)).toBe("hold");
  });

  it("delivers a held notice once, after quiet hours end", () => {
    const held = holdNotice(afterFirstCheck(), local("23:00"), false);
    expect(held.held).toEqual({ since: local("23:00"), urgent: false });
    expect(holdNotice(held, local("23:30"), true).held).toEqual({ since: local("23:00"), urgent: true });
    const night = releaseHeld(held, true);
    expect(night.deliver).toBe(false);
    const morning = releaseHeld(held, false);
    expect(morning).toMatchObject({ deliver: true, state: { held: null } });
    expect(releaseHeld(morning.state, false).deliver).toBe(false);
  });

  it("pausing drops a held notice", () => {
    expect(pauseSchedule(holdNotice(afterFirstCheck(), local("23:00"), false)).held).toBeNull();
  });
});
