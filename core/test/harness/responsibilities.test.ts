// Ongoing responsibilities: due times, missed runs, lifetime, quiet hours, change triggers, limits and
// turning a typed request into a plan. Fake clocks only (every function takes `now`); no I/O.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_QUIET_HOURS, inQuietHours } from "../../src/schedule.js";
import {
  BRIEFING_WEEKDAYS, CHANGE_GAP_MS, changeEligible, checksFreeAt, DAY_MS, defaultPlan, sundayAhead, dueNow, includesSundayReady, settledPlan, FAST_MIN_GAP_MS, FAST_SLOT_MS, lifetimeEnded, limitsLeft, templateLimitsLeft, localInstant, MIN_GAP_MS, MISSED_AFTER_MS,
  nearDeadlineTimes, nextSlot, parseRequest, quietDeferral, RECHECK_MS, refusedUntil, RETRY_MS, retryAt, RUN_TIMEOUT_MS, scheduledSlots, TEMPLATE_IDS, TEMPLATES,
  untilLifetime, upcomingWeekday, usage, validPlan, wallInstant, type LocalState, type Plan, type Responsibility, type RunRow,
} from "../../src/harness/responsibilities.js";
import type { SundayChange } from "../../src/sunday-changes.js";

const ZONE = "America/New_York";
// Saturday 14 November 2026, 10:00 in New York (EST, UTC-5).
const SAT = "2026-11-14T15:00:00.000Z";
const at = (iso: string, minutes: number) => new Date(Date.parse(iso) + minutes * 60_000).toISOString();
const fresh: LocalState = { last_slot: null, last_run_at: null, retry_at: null, failures: 0 };

function responsibility(plan: Plan, over: Partial<Responsibility> = {}): Responsibility {
  const t = TEMPLATES[plan.template];
  return {
    ...plan, id: "00000000-0000-4000-8000-000000000001", title: t.title, skill_id: t.skill_id, status: "active",
    created_at: SAT, confirmed_at: SAT, runs: [], open_run: null, ...over,
  };
}
/** Keep Sunday covered with "Only until this Sunday" chosen (its default is every week until stopped: audit item 23). */
const sundayPlan = () => ({ ...defaultPlan("keep-sunday-covered", SAT, ZONE), lifetime: untilLifetime("2026-11-15", ZONE)! });
const worse = (id = "need-opened:x"): SundayChange => ({ id, kind: "need-opened", effect: "worse", urgency: "attention", position: "Greeter", from: 0, to: 1 });
const better: SundayChange = { id: "need-filled:x", kind: "need-filled", effect: "better", urgency: "none", position: "Greeter", from: 1, to: 0 };

describe("templates", () => {
  it("is a fixed bundled set with fixed titles, procedures and needs", () => {
    expect(TEMPLATE_IDS).toEqual(["keep-sunday-covered", "watch-room-bookings", "follow-ups-without-owner", "group-night-clashes", "morning-briefing"]);
    expect(Object.fromEntries(TEMPLATE_IDS.map(id => [id, [TEMPLATES[id].title, TEMPLATES[id].skill_id, TEMPLATES[id].needs.join("+")]]))).toEqual({
      "keep-sunday-covered": ["Keep Sunday covered", "sunday-ready", "services"],
      "watch-room-bookings": ["Watch room bookings", "room-check", "services+operations"],
      "follow-ups-without-owner": ["Follow-ups without an owner", "follow-up-owners", "services+operations"],
      "group-night-clashes": ["Group night clashes", "group-night", "services+operations"],
      "morning-briefing": ["Morning briefing", "sunday-ready", "services"],
    });
    // Each procedure is one Ozzie ships.
    for (const id of TEMPLATE_IDS) expect(readFileSync(new URL(`../../skills/${TEMPLATES[id].skill_id}.md`, import.meta.url), "utf8")).toContain(`id: ${TEMPLATES[id].skill_id}`);
  });

  it("matches the native store's fixed table (responsibilities.rs) exactly", () => {
    const rust = readFileSync(new URL("../../native-auth/src/responsibilities.rs", import.meta.url), "utf8");
    for (const id of TEMPLATE_IDS) {
      const t = TEMPLATES[id];
      const row = new RegExp(`"${id}",\\s*"${t.title}",\\s*"${t.skill_id}",\\s*${t.max.checks_per_day},\\s*${t.max.ai_steps_per_day},\\s*${t.on_change}`, "u");
      expect(rust).toMatch(row);
    }
    // The gaps a refused run waits out are the store's own.
    expect(rust).toMatch(/pub const MIN_GAP_MS: u64 = 5 \* 60_000;/u);
    expect(rust).toMatch(/pub const FAST_MIN_GAP_MS: u64 = 20_000;/u);
    expect(rust).toMatch(/pub const RUN_TIMEOUT_MS: u64 = 10 \* 60_000;/u);
    expect([MIN_GAP_MS, FAST_MIN_GAP_MS, RUN_TIMEOUT_MS]).toEqual([5 * 60_000, 20_000, 10 * 60_000]);
  });

  it("Keep Sunday covered: daily at 7:00, sooner on change, every week until stopped by default (audit item 23)", () => {
    expect(defaultPlan("keep-sunday-covered", SAT, ZONE)).toEqual({
      template: "keep-sunday-covered", schedule: { time: "07:00", weekdays: [], on_change: true }, report: "decisions-only",
      lifetime: { kind: "until-stopped" }, limits: { checks_per_day: 6, ai_steps_per_day: 12 }, zone: ZONE,
    });
    // Whatever the day or the Sunday chosen in Settings.
    expect(defaultPlan("keep-sunday-covered", "2026-11-16T15:00:00.000Z", ZONE).lifetime).toEqual({ kind: "until-stopped" });
    expect(defaultPlan("keep-sunday-covered", SAT, ZONE, { sunday: "2026-11-22" }).lifetime).toEqual({ kind: "until-stopped" });
    // "Only until this Sunday" is still a plan it can run.
    expect(validPlan(sundayPlan(), SAT)).toBe(true);
    expect(sundayPlan().lifetime).toEqual({ kind: "until", until: "2026-11-15", ends_at: "2026-11-16T05:00:00.000Z" });
    expect(defaultPlan("watch-room-bookings", SAT, ZONE)).toMatchObject({ schedule: { weekdays: [4], on_change: false }, lifetime: { kind: "until-stopped" } });
    for (const id of TEMPLATE_IDS) expect(validPlan(defaultPlan(id, SAT, ZONE), SAT)).toBe(true);
  });

  it("Morning briefing: 7:00 AM on weekdays (owner, October 26), outside the default quiet hours", () => {
    expect(BRIEFING_WEEKDAYS).toEqual([1, 2, 3, 4, 5]);
    expect(defaultPlan("morning-briefing", SAT, ZONE)).toMatchObject({ schedule: { time: "07:00", weekdays: [1, 2, 3, 4, 5] }, lifetime: { kind: "until-stopped" }, report: "every-check" });
    const r = responsibility(defaultPlan("morning-briefing", SAT, ZONE));
    // Saturday 10:00 to the next Saturday: Monday through Friday at 7:00 New York, none on the weekend.
    expect(scheduledSlots(r, SAT, at(SAT, 7 * 24 * 60), ZONE)).toEqual([
      "2026-11-16T12:00:00.000Z", "2026-11-17T12:00:00.000Z", "2026-11-18T12:00:00.000Z", "2026-11-19T12:00:00.000Z", "2026-11-20T12:00:00.000Z",
    ]);
    expect(inQuietHours(DEFAULT_QUIET_HOURS, "2026-11-16T12:00:00.000Z", ZONE)).toBe(false);
  });

  it("Thursday's briefing includes the full Sunday Ready brief, on the church's own date", () => {
    expect(includesSundayReady("2026-11-19T12:00:00.000Z", ZONE)).toBe(true);
    expect(includesSundayReady("2026-11-18T12:00:00.000Z", ZONE)).toBe(false);
    // 11:30 PM Wednesday in New York is already Thursday in UTC: still Wednesday's briefing.
    expect(includesSundayReady("2026-11-19T04:30:00.000Z", ZONE)).toBe(false);
  });

  it("moves a saved briefing to the settled default only while it still has the earlier default time and days", () => {
    const earlier = responsibility({ ...defaultPlan("morning-briefing", SAT, ZONE), schedule: { time: "06:45", weekdays: [], on_change: false } });
    expect(settledPlan(earlier)).toEqual({ ...defaultPlan("morning-briefing", SAT, ZONE), lifetime: earlier.lifetime, limits: earlier.limits });
    expect(settledPlan({ ...earlier, schedule: { ...earlier.schedule, time: "06:30" } })).toBeNull();
    expect(settledPlan({ ...earlier, schedule: { ...earlier.schedule, weekdays: [1, 3] } })).toBeNull();
    expect(settledPlan({ ...earlier, status: "ended" })).toBeNull();
    expect(settledPlan(responsibility(sundayPlan()))).toBeNull();
    // One confirmed before zones were kept takes the zone given.
    expect(settledPlan({ ...earlier, zone: null }, "America/Chicago")?.zone).toBe("America/Chicago");
  });
});

describe("church-local dates", () => {
  it("finds the coming weekday, today included, in the church's zone", () => {
    expect(upcomingWeekday(SAT, ZONE, 0)).toBe("2026-11-15");
    expect(upcomingWeekday(SAT, ZONE, 6)).toBe("2026-11-14");
    // 23:30 Saturday in New York is already Sunday in UTC; the church's date decides.
    expect(upcomingWeekday("2026-11-15T04:30:00.000Z", ZONE, 0)).toBe("2026-11-15");
    expect(upcomingWeekday("2026-11-15T04:30:00.000Z", "UTC", 0)).toBe("2026-11-15");
    // 23:30 Sunday in New York is still that Sunday; 00:30 Monday looks to the next one.
    expect(upcomingWeekday("2026-11-16T04:30:00.000Z", ZONE, 0)).toBe("2026-11-15");
    expect(upcomingWeekday("2026-11-16T05:30:00.000Z", ZONE, 0)).toBe("2026-11-22");
  });
  it("places a wall-clock time on a local date, across daylight saving", () => {
    expect(localInstant("2026-11-22", "07:00", ZONE)).toBe("2026-11-22T12:00:00.000Z");
    expect(localInstant("2026-07-05", "07:00", ZONE)).toBe("2026-07-05T11:00:00.000Z");
    // 02:30 doesn't exist on 8 March 2026 in New York.
    expect(localInstant("2026-03-08", "02:30", ZONE)).toBeNull();
    expect(untilLifetime("2026-11-22", ZONE)).toEqual({ kind: "until", until: "2026-11-22", ends_at: "2026-11-23T05:00:00.000Z" });
    expect(untilLifetime("2026-02-30", ZONE)).toBeNull();
  });
});

describe("when a responsibility is due", () => {
  const r = responsibility(sundayPlan(), { lifetime: untilLifetime("2026-11-22", ZONE)! });

  it("runs once when it starts, then at its scheduled time", () => {
    expect(dueNow(r, fresh, SAT, ZONE)).toEqual({ due: true, trigger: "start", slot: null, missed: [] });
    const started: LocalState = { ...fresh, last_slot: SAT, last_run_at: SAT };
    expect(dueNow(r, started, at(SAT, 60), ZONE)).toEqual({ due: false, next: "2026-11-15T12:00:00.000Z" });
    expect(dueNow(r, started, "2026-11-15T12:00:00.000Z", ZONE)).toEqual({ due: true, trigger: "scheduled", slot: "2026-11-15T12:00:00.000Z", missed: [] });
  });

  it("adds checks in the two days before Sunday, within the limits", () => {
    const slots = scheduledSlots(r, SAT, "2026-11-23T05:00:00.000Z", ZONE);
    const local = slots.map(s => new Date(s).toLocaleString("en-US", { timeZone: ZONE, weekday: "short", hour: "numeric", minute: "2-digit" }));
    expect(local).toEqual([
      "Sun 7:00 AM", "Mon 7:00 AM", "Tue 7:00 AM", "Wed 7:00 AM", "Thu 7:00 AM",
      "Fri 7:00 AM", "Fri 12:00 PM", "Fri 5:00 PM", "Sat 7:00 AM", "Sat 12:00 PM", "Sat 5:00 PM", "Sun 7:00 AM",
    ]);
    expect(Math.max(...[...new Set(slots.map(s => s.slice(0, 10)))].map(d => slots.filter(s => s.startsWith(d)).length))).toBeLessThanOrEqual(r.limits.checks_per_day);
  });

  it("a slot missed while the Mac slept or Ozzie was closed is caught up once, never in a burst", () => {
    const s: LocalState = { ...fresh, last_slot: SAT, last_run_at: SAT };
    // Asleep from Monday 6:00 to Saturday 14:00: eleven scheduled checks passed.
    const woke = "2026-11-21T19:00:00.000Z";
    const due = dueNow(r, s, woke, ZONE);
    expect(due.due && due.trigger).toBe("catch-up");
    if (!due.due) throw new Error("not due");
    expect(due.missed.length).toBeGreaterThan(5);
    expect(due.slot).toBe("2026-11-21T17:00:00.000Z");
    // After the one catch-up run, nothing else is due until the next slot.
    expect(dueNow(r, { ...s, last_slot: due.slot, last_run_at: woke }, at(woke, 1), ZONE)).toEqual({ due: false, next: "2026-11-21T22:00:00.000Z" });
  });

  it("a check a few minutes late is just late, not missed", () => {
    const s: LocalState = { ...fresh, last_slot: SAT, last_run_at: SAT };
    const due = dueNow(r, s, at("2026-11-15T12:00:00.000Z", 4), ZONE);
    expect(due).toMatchObject({ due: true, trigger: "scheduled", missed: [] });
    expect(dueNow(r, s, at("2026-11-15T12:00:00.000Z", MISSED_AFTER_MS / 60_000 + 1), ZONE)).toMatchObject({ trigger: "catch-up", missed: ["2026-11-15T12:00:00.000Z"] });
  });

  it("retries an hour after a failed check, and never past its lifetime", () => {
    const failedAt = "2026-11-15T12:00:30.000Z";
    const s: LocalState = { last_slot: "2026-11-15T12:00:00.000Z", last_run_at: failedAt, retry_at: retryAt(r, failedAt), failures: 1 };
    expect(s.retry_at).toBe(at(failedAt, RETRY_MS / 60_000));
    expect(dueNow(r, s, at(failedAt, 30), ZONE)).toEqual({ due: false, next: s.retry_at });
    expect(dueNow(r, s, s.retry_at!, ZONE)).toEqual({ due: true, trigger: "retry", slot: null, missed: [] });
    expect(retryAt(r, "2026-11-23T04:30:00.000Z")).toBeNull();
  });

  it("paused, stopped and ended responsibilities are never due", () => {
    for (const status of ["paused", "ended"] as const) expect(dueNow({ ...r, status }, fresh, SAT, ZONE)).toEqual({ due: false, next: null });
    expect(lifetimeEnded(r, "2026-11-23T04:59:59.000Z")).toBe(false);
    expect(lifetimeEnded(r, "2026-11-23T05:00:00.000Z")).toBe(true);
    expect(dueNow(r, fresh, "2026-11-23T05:00:00.000Z", ZONE)).toEqual({ due: false, next: null });
    expect(nextSlot(r, "2026-11-22T12:00:00.000Z", ZONE)).toBeNull();
    const weekly = responsibility(defaultPlan("watch-room-bookings", SAT, ZONE));
    expect(lifetimeEnded(weekly, "2030-01-01T00:00:00.000Z")).toBe(false);
  });

  it("weekly ones run on their weekday", () => {
    const weekly = responsibility(defaultPlan("watch-room-bookings", SAT, ZONE));
    expect(nextSlot(weekly, SAT, ZONE)).toBe("2026-11-19T14:00:00.000Z");
    expect(scheduledSlots(weekly, SAT, "2026-12-01T00:00:00.000Z", ZONE)).toEqual(["2026-11-19T14:00:00.000Z", "2026-11-26T14:00:00.000Z"]);
  });

  it("a developer's fast schedule makes due times minutes apart", () => {
    const s: LocalState = { ...fresh, last_slot: SAT, last_run_at: SAT };
    expect(dueNow(r, s, at(SAT, 1), ZONE, { fast: true })).toEqual({ due: false, next: at(SAT, FAST_SLOT_MS / 60_000) });
    expect(dueNow(r, s, at(SAT, FAST_SLOT_MS / 60_000), ZONE, { fast: true })).toMatchObject({ due: true, trigger: "scheduled" });
  });
});

describe("daylight saving (New York springs forward at 02:00 on 8 March 2026)", () => {
  it("a time the clocks skip means the first moment after the gap", () => {
    expect(localInstant("2026-03-08", "02:30", ZONE)).toBeNull();
    expect(wallInstant("2026-03-08", "02:30", ZONE)).toBe("2026-03-08T07:00:00.000Z");
    expect(wallInstant("2026-03-08", "02:00", ZONE)).toBe("2026-03-08T07:00:00.000Z");
    expect(wallInstant("2026-03-08", "01:59", ZONE)).toBe("2026-03-08T06:59:00.000Z");
    expect(wallInstant("2026-03-08", "07:00", ZONE)).toBe("2026-03-08T11:00:00.000Z");
    expect(wallInstant("2026-02-30", "07:00", ZONE)).toBeNull();
  });

  it("a scheduled time in the gap runs at the first valid time instead of being skipped", () => {
    const r = responsibility({ ...defaultPlan("morning-briefing", "2026-03-06T15:00:00.000Z", ZONE), schedule: { time: "02:30", weekdays: [], on_change: false } });
    expect(scheduledSlots(r, "2026-03-07T00:00:00.000Z", "2026-03-10T00:00:00.000Z", ZONE)).toEqual([
      "2026-03-07T07:30:00.000Z", "2026-03-08T07:00:00.000Z", "2026-03-09T06:30:00.000Z",
    ]);
  });

  it("quiet hours that end inside the gap end at the first valid time, not a day later", () => {
    expect(quietDeferral("2026-03-08T06:30:00.000Z", { start: "01:00", end: "02:30" }, ZONE)).toEqual({ send: false, at: "2026-03-08T07:00:00.000Z" });
  });
});

describe("extra checks near Sunday", () => {
  const MON = "2026-11-16T14:00:00.000Z";
  const plan = (text: string, now = MON) => {
    const p = parseRequest(text, now, ZONE);
    if (p.kind !== "plan") throw new Error(`${text}: ${p.kind}`);
    return p.plan;
  };
  it("come in the two days before the Sunday it watches, on a plan that checks every day", () => {
    const toSunday = plan("Keep an eye on Sunday");
    expect(nearDeadlineTimes(toSunday, MON, ZONE)).toEqual(["12:00", "17:00"]);
    expect(nearDeadlineTimes({ ...toSunday, schedule: { ...toSunday.schedule, time: "12:00" } }, MON, ZONE)).toEqual(["17:00"]);
    // A dated plan watches the Sunday it runs up to, not every Sunday on the way.
    const twoWeeks = responsibility({ ...toSunday, lifetime: untilLifetime("2026-11-29", ZONE)! });
    const fridays = scheduledSlots(twoWeeks, MON, "2026-11-30T05:00:00.000Z", ZONE).filter(s => new Date(s).getUTCDay() === 5);
    expect(fridays).toEqual(["2026-11-20T12:00:00.000Z", "2026-11-27T12:00:00.000Z", "2026-11-27T17:00:00.000Z", "2026-11-27T22:00:00.000Z"]);
    // Until stopped, it watches each week's Sunday.
    const ongoing = responsibility(plan("Keep an eye on Sunday from now on"));
    expect(scheduledSlots(ongoing, MON, "2026-11-28T00:00:00.000Z", ZONE).filter(s => new Date(s).getUTCDay() === 5))
      .toEqual(["2026-11-20T12:00:00.000Z", "2026-11-20T17:00:00.000Z", "2026-11-20T22:00:00.000Z", "2026-11-27T12:00:00.000Z", "2026-11-27T17:00:00.000Z", "2026-11-27T22:00:00.000Z"]);
  });

  it("“every Friday” keeps to Friday's own time, and a plan ending on a Wednesday never reaches them", () => {
    const friday = plan("Keep an eye on Sunday every friday");
    expect(friday.schedule.weekdays).toEqual([5]);
    expect(scheduledSlots(responsibility(friday), MON, "2026-11-30T00:00:00.000Z", ZONE)).toEqual(["2026-11-20T12:00:00.000Z", "2026-11-27T12:00:00.000Z"]);
    expect(nearDeadlineTimes(friday, MON, ZONE)).toEqual([]);
    const wednesday = plan("Keep an eye on Sunday until Wednesday");
    expect(wednesday.lifetime).toMatchObject({ until: "2026-11-18" });
    expect(scheduledSlots(responsibility(wednesday), MON, "2026-11-19T05:00:00.000Z", ZONE)).toEqual(["2026-11-17T12:00:00.000Z", "2026-11-18T12:00:00.000Z"]);
    expect(nearDeadlineTimes(wednesday, MON, ZONE)).toEqual([]);
  });
});

describe("a refused run is asked for again later, never in a loop", () => {
  const run = (minutes: number, over: Partial<RunRow> = {}): RunRow => ({
    run_id: `00000000-0000-4000-8000-${String(Math.abs(minutes)).padStart(12, "0")}`, trigger: "scheduled", started_at: at(SAT, minutes), ended_at: at(SAT, minutes + 1),
    outcome: "ok", code: null, noticed: 0, drafts: 0, ai_steps: 0, ...over,
  });
  const r = (runs: RunRow[], over: Partial<Responsibility> = {}) => responsibility(sundayPlan(), { runs, open_run: runs[0]?.ended_at === null ? runs[0] : null, ...over });
  it("waits out the store's own gap, an open run's timeout, or the day's oldest check", () => {
    expect(refusedUntil(r([run(-2)]), "too-soon", SAT)).toBe(at(SAT, 3));
    expect(refusedUntil(r([run(0)]), "too-soon", SAT, { fast: true })).toBe(new Date(Date.parse(SAT) + FAST_MIN_GAP_MS).toISOString());
    expect(refusedUntil(r([run(-1, { ended_at: null, outcome: null })]), "busy", SAT)).toBe(at(SAT, RUN_TIMEOUT_MS / 60_000 - 1));
    const day = [run(-60), run(-10 * 60), run(-20 * 60)];
    expect(refusedUntil(r(day, { limits: { checks_per_day: 3, ai_steps_per_day: 6 } }), "checks-limit", SAT)).toBe(at(SAT, 4 * 60));
    expect(refusedUntil(r([]), "unavailable", SAT)).toBe(at(SAT, RETRY_MS / 60_000));
    expect(refusedUntil(r([]), "invalid", SAT, { fast: true })).toBe(new Date(Date.parse(SAT) + FAST_SLOT_MS / 2).toISOString());
    expect(refusedUntil(r([]), "paused-all", SAT)).toBe(new Date(Date.parse(SAT) + RECHECK_MS).toISOString());
  });
  it("is never now: a stale listing still waits at least a second", () => {
    expect(refusedUntil(r([run(-MIN_GAP_MS / 60_000 - 5)]), "too-soon", SAT)).toBe(new Date(Date.parse(SAT) + 1_000).toISOString());
    expect(refusedUntil(r([]), "busy", SAT)).toBe(at(SAT, MIN_GAP_MS / 60_000));
  });
});

describe("change-triggered checks", () => {
  const r = responsibility(sundayPlan());
  const s: LocalState = { ...fresh, last_slot: SAT, last_run_at: SAT };
  it("run sooner only for something worse, on a template that watches for changes, not too often", () => {
    expect(changeEligible(r, s, [better], at(SAT, 90))).toBe(false);
    expect(changeEligible(r, s, [worse()], at(SAT, 10))).toBe(false);
    expect(changeEligible(r, s, [worse()], at(SAT, CHANGE_GAP_MS / 60_000))).toBe(true);
    expect(changeEligible({ ...r, schedule: { ...r.schedule, on_change: false } }, s, [worse()], at(SAT, 90))).toBe(false);
    expect(changeEligible({ ...r, status: "paused" }, s, [worse()], at(SAT, 90))).toBe(false);
    expect(changeEligible(r, s, [worse()], "2026-11-16T05:00:00.000Z")).toBe(false);
  });
});

describe("daily limits", () => {
  const run = (minutes: number, ai_steps = 0): RunRow => ({
    run_id: `00000000-0000-4000-8000-${String(minutes).padStart(12, "0")}`, trigger: "scheduled", started_at: at(SAT, minutes), ended_at: at(SAT, minutes + 1),
    outcome: "ok", code: null, noticed: 0, drafts: 0, ai_steps,
  });
  it("count checks and AI steps over the last 24 hours", () => {
    const runs = [run(-25 * 60, 6), run(-60, 6), run(-30, 2)];
    expect(usage(runs, SAT)).toEqual({ checks: 2, ai_steps: 8 });
    const r = responsibility(sundayPlan(), { runs });
    expect(limitsLeft(r, SAT)).toEqual({ checks: 4, ai_steps: 4 });
    expect(limitsLeft({ ...r, runs: [...runs, run(-20, 4), run(-10), run(-5), run(-1)] }, SAT)).toEqual({ checks: 0, ai_steps: 0 });
  });
  it("count a kind's checks across a stopped one and its replacement, as the Mac's store does", () => {
    const stopped = responsibility(sundayPlan(), { status: "ended", runs: [run(-120), run(-90), run(-60), run(-30), run(-20)] });
    const fresh = responsibility(sundayPlan(), { id: "00000000-0000-4000-8000-000000000002", runs: [run(-5)] });
    const briefing = responsibility(defaultPlan("morning-briefing", SAT, ZONE), { id: "00000000-0000-4000-8000-000000000003", runs: [run(-3)] });
    expect(limitsLeft(fresh, SAT).checks).toBe(5);
    expect(templateLimitsLeft(fresh, [stopped, fresh, briefing], SAT).checks).toBe(0);
  });
  it("say when a kind whose checks are used can check again: when its oldest counted check turns 24 hours old", () => {
    const stopped = responsibility(sundayPlan(), { status: "ended", runs: [run(-120), run(-90), run(-60), run(-30), run(-20)] });
    const fresh = responsibility(sundayPlan(), { id: "00000000-0000-4000-8000-000000000002", runs: [run(-5)] });
    const briefing = responsibility(defaultPlan("morning-briefing", SAT, ZONE), { id: "00000000-0000-4000-8000-000000000003", runs: [run(-3)] });
    // Six of six used across the stopped one and its replacement: free again when the one from two hours ago is a day old.
    expect(checksFreeAt(fresh, [stopped, fresh, briefing], SAT)).toBe(at(SAT, -120 + 24 * 60));
    // With a check left, nothing to wait for.
    expect(checksFreeAt(fresh, [fresh, briefing], SAT)).toBeNull();
    expect(checksFreeAt(briefing, [stopped, fresh, briefing], SAT)).toBeNull();
    // A check older than a day doesn't count; an open run does, once.
    const older = responsibility(sundayPlan(), { status: "ended", runs: [run(-25 * 60), run(-90), run(-60), run(-30), run(-20)] });
    expect(checksFreeAt(fresh, [older, fresh], SAT)).toBeNull();
    const open = { ...fresh, open_run: run(-1), runs: [run(-5), run(-1)] };
    expect(checksFreeAt(open, [older, open], SAT)).toBe(at(SAT, -90 + 24 * 60));
  });
});

describe("quiet hours", () => {
  const quiet = { start: "21:30", end: "06:30" };
  it("defer a notice to when they end; they never drop it", () => {
    expect(quietDeferral(SAT, quiet, ZONE)).toEqual({ send: true });
    expect(quietDeferral("2026-11-15T03:00:00.000Z", quiet, ZONE)).toEqual({ send: false, at: "2026-11-15T11:30:00.000Z" });
    expect(quietDeferral("2026-11-15T10:00:00.000Z", quiet, ZONE)).toEqual({ send: false, at: "2026-11-15T11:30:00.000Z" });
    expect(quietDeferral("2026-11-15T11:30:00.000Z", quiet, ZONE)).toEqual({ send: true });
  });
});

describe("turning a request into a plan (no model)", () => {
  const plan = (text: string, now = SAT) => {
    const p = parseRequest(text, now, ZONE);
    if (p.kind !== "plan") throw new Error(`${text}: ${p.kind}`);
    return p;
  };
  it("without a date, keeps going every week, and \"until Sunday\" follows the Sunday chosen in Settings", () => {
    // Saturday the 14th, with the plan for Sunday the 22nd chosen: "Keep an eye on Sunday" keeps going until stopped.
    const p = parseRequest("Keep an eye on Sunday for me", SAT, ZONE, { sunday: "2026-11-22" });
    expect(p).toMatchObject({ kind: "plan", plan: { lifetime: { kind: "until-stopped" } }, assumed: ["lifetime", "time"] });
    // "Until Sunday" means the one chosen while it's ahead; a chosen Sunday already past, or no check yet: the coming Sunday.
    expect(parseRequest("Keep an eye on Sunday until Sunday", SAT, ZONE, { sunday: "2026-11-22" })).toMatchObject({ plan: { lifetime: untilLifetime("2026-11-22", ZONE) } });
    expect(parseRequest("Keep an eye on Sunday until Sunday", SAT, ZONE, { sunday: "2026-11-08" })).toMatchObject({ plan: { lifetime: { until: "2026-11-15" } } });
    expect(parseRequest("Keep an eye on Sunday until Sunday", SAT, ZONE, { sunday: null })).toMatchObject({ plan: { lifetime: { until: "2026-11-15" } } });
    // Said in words, "this Sunday" still means the coming one.
    expect(parseRequest("Keep an eye on this Sunday", SAT, ZONE, { sunday: "2026-11-22" })).toMatchObject({ plan: { lifetime: { until: "2026-11-15" } } });
  });

  it("keep an eye on Sunday: every week until stopped, assumed and said so", () => {
    const p = plan("Keep an eye on Sunday for me");
    expect(p.plan.template).toBe("keep-sunday-covered");
    expect(p.plan.lifetime).toEqual({ kind: "until-stopped" });
    expect(p.assumed).toContain("lifetime");
  });

  it("this Sunday, said on a Monday", () => {
    const p = plan("Let me know if anyone declines this Sunday", "2026-11-16T14:00:00.000Z");
    expect(p.plan).toMatchObject({ template: "keep-sunday-covered", report: "decisions-only", lifetime: { until: "2026-11-22" } });
    expect(p.assumed).not.toContain("lifetime");
  });

  it("until Saturday", () => {
    const p = plan("Watch room bookings until Saturday", "2026-11-16T14:00:00.000Z");
    expect(p.plan).toMatchObject({ template: "watch-room-bookings", lifetime: { kind: "until", until: "2026-11-21", ends_at: "2026-11-22T05:00:00.000Z" } });
    expect(plan("Can you watch the rooms until 11/28?").plan.lifetime).toMatchObject({ until: "2026-11-28" });
    expect(plan("Keep an eye on follow-ups until December 3rd").plan).toMatchObject({ template: "follow-ups-without-owner", lifetime: { until: "2026-12-03" } });
  });

  it("every week, until stopped", () => {
    expect(plan("Every week, check for follow-ups without an owner").plan).toMatchObject({ template: "follow-ups-without-owner", lifetime: { kind: "until-stopped" } });
    expect(plan("Watch for group night clashes every Wednesday at 8am").plan).toMatchObject({
      template: "group-night-clashes", schedule: { time: "08:00", weekdays: [3] }, lifetime: { kind: "until-stopped" },
    });
    expect(plan("Please give me a morning briefing every day at 6:30").plan).toMatchObject({ template: "morning-briefing", schedule: { time: "06:30", weekdays: [] } });
    expect(plan("Give me a morning briefing daily").plan.schedule.weekdays).toEqual([]);
    expect(plan("Give me a morning briefing every morning").plan.schedule.weekdays).toEqual([]);
    expect(plan("Give me a morning briefing on weekdays at 7:30").plan).toMatchObject({ schedule: { time: "07:30", weekdays: [1, 2, 3, 4, 5] } });
    expect(plan("Give me a morning briefing from now on").plan.schedule.weekdays).toEqual([1, 2, 3, 4, 5]);
    expect(plan("Keep watch on Sunday coverage weekly and tell me every time you check").plan).toMatchObject({ report: "every-check", lifetime: { kind: "until-stopped" } });
  });

  it("asks rather than guessing when something important is unclear", () => {
    expect(parseRequest("Keep an eye on next Sunday", SAT, ZONE)).toEqual({
      kind: "ask", need: "when", template: "keep-sunday-covered",
      choices: [untilLifetime("2026-11-15", ZONE), untilLifetime("2026-11-22", ZONE)],
    });
    expect(parseRequest("Keep an eye on things for me", SAT, ZONE)).toEqual({ kind: "ask", need: "what", choices: [...TEMPLATE_IDS] });
    expect(parseRequest("Watch the rooms and the group nights", SAT, ZONE)).toEqual({ kind: "ask", need: "what", choices: ["watch-room-bookings", "group-night-clashes"] });
    // An "until" it can't read asks between two different answers: until the Sunday being watched, or until stopped.
    expect(parseRequest("Keep an eye on Sunday until February 30", SAT, ZONE)).toEqual({ kind: "ask", need: "when", template: "keep-sunday-covered",
      choices: [untilLifetime("2026-11-15", ZONE), { kind: "until-stopped" }] });
    expect(parseRequest("Watch room bookings until February 30", SAT, ZONE)).toMatchObject({ kind: "ask", choices: [untilLifetime("2026-11-15", ZONE), { kind: "until-stopped" }] });
  });

  it("leaves ordinary questions and requests to Ask", () => {
    for (const text of [
      "Who could cover the open Greeter spot this Sunday?", "What still needs a decision before Sunday?", "Let me know who could cover Greeter",
      "Draft a note to the Nursery team leader", "Find someone to watch the nursery", "When will you check again?", "", "   ",
    ]) expect(parseRequest(text, SAT, ZONE)).toEqual({ kind: "none" });
  });

  it("until Sunday means the Sunday being watched when one is chosen, but this Sunday is the coming one", () => {
    // Saturday the 14th, the plan for Sunday the 29th chosen in Settings.
    expect(parseRequest("Keep an eye on Sunday coverage until Sunday", SAT, ZONE, { sunday: "2026-11-29" })).toMatchObject({ kind: "plan", plan: { lifetime: untilLifetime("2026-11-29", ZONE) } });
    expect(parseRequest("Keep an eye on Sunday coverage until this Sunday", SAT, ZONE, { sunday: "2026-11-29" })).toMatchObject({ plan: { lifetime: { until: "2026-11-15" } } });
    // A chosen Saturday-evening plan: until the Sunday after it. One already past: the coming Sunday.
    expect(parseRequest("Keep an eye on Sunday coverage until Sunday", SAT, ZONE, { sunday: "2026-11-28" })).toMatchObject({ plan: { lifetime: { until: "2026-11-29" } } });
    expect(parseRequest("Keep an eye on Sunday coverage until Sunday", SAT, ZONE, { sunday: "2026-11-08" })).toMatchObject({ plan: { lifetime: { until: "2026-11-15" } } });
    expect(parseRequest("Keep an eye on Sunday coverage until Sunday", SAT, ZONE)).toMatchObject({ plan: { lifetime: { until: "2026-11-15" } } });
  });

  describe("said on a Sunday", () => {
    // Sunday 15 November 2026, 9:00 in New York.
    const SUN = "2026-11-15T14:00:00.000Z";
    it("until Sunday is the Sunday being watched, never today", () => {
      // The reported case: typed on Sunday the 15th with the plan for the 29th chosen.
      expect(parseRequest("Keep an eye on Sunday coverage until Sunday", SUN, ZONE, { sunday: "2026-11-29" })).toMatchObject({ kind: "plan", plan: { lifetime: untilLifetime("2026-11-29", ZONE) } });
      // Nothing chosen, or today's plan chosen: next Sunday.
      expect(parseRequest("Keep an eye on Sunday coverage until Sunday", SUN, ZONE)).toMatchObject({ plan: { lifetime: untilLifetime("2026-11-22", ZONE) } });
      expect(parseRequest("Keep an eye on Sunday coverage until Sunday", SUN, ZONE, { sunday: "2026-11-15" })).toMatchObject({ plan: { lifetime: { until: "2026-11-22" } } });
      expect(parseRequest("Let me know if anyone declines this Sunday", SUN, ZONE)).toMatchObject({ plan: { lifetime: { until: "2026-11-22" } } });
      expect(defaultPlan("keep-sunday-covered", SUN, ZONE).lifetime).toEqual({ kind: "until-stopped" });
      // "Next Sunday" asks between the two Sundays after today.
      expect(parseRequest("Keep an eye on next Sunday", SUN, ZONE)).toEqual({
        kind: "ask", need: "when", template: "keep-sunday-covered", choices: [untilLifetime("2026-11-22", ZONE), untilLifetime("2026-11-29", ZONE)],
      });
      expect(sundayAhead(SUN, ZONE)).toBe("2026-11-22");
      expect(sundayAhead(SAT, ZONE)).toBe("2026-11-15");
    });

    it("leaves more than a day, at every hour of the church's Sunday", () => {
      for (let hour = 0; hour < 24; hour++) {
        // 00:30 to 23:30 on Sunday the 15th in New York (UTC-5).
        const now = new Date(Date.parse("2026-11-15T05:30:00.000Z") + hour * 3_600_000).toISOString();
        for (const text of ["Keep an eye on Sunday coverage until Sunday", "Let me know if anyone declines this Sunday"]) {
          const p = parseRequest(text, now, ZONE);
          if (p.kind !== "plan" || p.plan.lifetime.kind !== "until") throw new Error(`${text} at ${now}: ${p.kind}`);
          expect(Date.parse(p.plan.lifetime.ends_at) - Date.parse(now), `${text} at ${now}`).toBeGreaterThan(DAY_MS);
        }
      }
    });

    it("goes by the church's date, not UTC's", () => {
      // 03:30 UTC on the 15th is still Saturday evening in New York: until Sunday is tomorrow.
      expect(parseRequest("Keep an eye on Sunday coverage until Sunday", "2026-11-15T03:30:00.000Z", ZONE)).toMatchObject({ plan: { lifetime: untilLifetime("2026-11-15", ZONE) } });
      // Noon UTC on Saturday the 14th is already 1:00 on Sunday the 15th in Auckland: next Sunday there.
      const NZ = "Pacific/Auckland";
      expect(parseRequest("Keep an eye on Sunday coverage until Sunday", "2026-11-14T12:00:00.000Z", NZ)).toMatchObject({ plan: { lifetime: untilLifetime("2026-11-22", NZ) } });
      expect(sundayAhead("2026-11-14T12:00:00.000Z", NZ)).toBe("2026-11-22");
    });
  });

  it("never echoes what was typed: a plan holds only fixed fields", () => {
    const p = plan("Keep an eye on Sunday for Avery Brightwater until Saturday");
    expect(JSON.stringify(p)).not.toMatch(/avery|brightwater/i);
    expect(Object.keys(p.plan).sort()).toEqual(["lifetime", "limits", "report", "schedule", "template", "zone"]);
    expect(p.plan.zone).toBe(ZONE);
  });
});

describe("plan validation (mirrors the native store)", () => {
  it("refuses anything outside the fixed templates and limits", () => {
    const p = sundayPlan();
    expect(validPlan(p, SAT)).toBe(true);
    expect(validPlan({ ...p, template: "send-reminders" as never }, SAT)).toBe(false);
    expect(validPlan({ ...p, limits: { checks_per_day: 7, ai_steps_per_day: 12 } }, SAT)).toBe(false);
    expect(validPlan({ ...p, limits: { checks_per_day: 0, ai_steps_per_day: 12 } }, SAT)).toBe(false);
    expect(validPlan({ ...p, schedule: { ...p.schedule, time: "7am" } }, SAT)).toBe(false);
    expect(validPlan({ ...p, schedule: { ...p.schedule, weekdays: [7] } }, SAT)).toBe(false);
    expect(validPlan({ ...defaultPlan("watch-room-bookings", SAT, ZONE), schedule: { time: "09:00", weekdays: [4], on_change: true } }, SAT)).toBe(false);
    expect(validPlan({ ...p, lifetime: { kind: "until", until: "2026-11-15", ends_at: "2026-11-20T05:00:00.000Z" } }, SAT)).toBe(false);
    expect(validPlan({ ...p, lifetime: { kind: "until", until: "2026-11-13", ends_at: "2026-11-14T05:00:00.000Z" } }, SAT)).toBe(false);
    expect(validPlan({ ...p, report: "loudly" as never }, SAT)).toBe(false);
    // The zone is a time zone this Mac knows, never free text.
    expect(validPlan({ ...p, zone: "Avery Brightwater" }, SAT)).toBe(false);
    expect(validPlan({ ...p, zone: "Mars/Olympus_Mons" }, SAT)).toBe(false);
    expect(validPlan({ ...p, zone: "America/Chicago" }, SAT)).toBe(true);
  });
});
