import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { createProactive, notifySundayAttention, proactiveReadiness, verifiedSundayCheck, verifySavedOnLaunch, type KeyValueStore, type ProactiveDeps, type ProactiveHooks } from "../src/proactive.js";
import { sundayProblem, type Settings } from "../src/sunday-source.js";
import type { ConnectionStatus } from "../src/connection.js";
import { nov22Capture, PEOPLE, TEAMS } from "../../../core/src/fictional-sunday.js";
import { BACKGROUND_CHECKS } from "../../../core/src/kids-rules.js";
import { describeChange } from "../../../core/src/sunday-changes.js";
import type { SundayCapture, SundayRules } from "../../../core/src/sunday-capture.js";

const settings: Settings = { clientId: "fictional-client", organization: "1001", serviceTypeId: "1500", planId: "92902197" };
const status = (state: ConnectionStatus["state"]): ConnectionStatus => ({ state, organization: "1001", checked_at_ms: null, source: "", problem: null });
const rules: SundayRules = { sundayLeads: [], checkInAfterSundaysInARow: 3 };
const ZONE = "America/Chicago";

/** The fictional Sunday, read at `iso`, optionally changed. */
function captureAt(iso: string, change?: (c: SundayCapture) => void): SundayCapture {
  const c = nov22Capture();
  change?.(c);
  const delta = Date.parse(iso) - Date.parse(c.completed_at);
  const shift = (t: string) => new Date(Date.parse(t) + delta).toISOString();
  return { ...c, started_at: shift(c.started_at), completed_at: shift(c.completed_at), reads: c.reads.map(r => ({ ...r, checked_at: shift(r.checked_at) })) };
}
type Row = { id: string; attributes: Record<string, unknown> };
const rows = (c: SundayCapture, collection: string) => c.reads.find(r => r.collection === collection)!.body!.data as Row[];
const decline = (c: SundayCapture) => {
  rows(c, "team_members").find(m => m.id === "401")!.attributes.status = "D";
  rows(c, "needed_positions").find(n => n.attributes.team_position_name === "Greeter")!.attributes.quantity = 2;
};

function harness(start: string, store = memoryStore()) {
  let now = start;
  let change: ((c: SundayCapture) => void) | undefined;
  let fail: unknown = null;
  let hold: Promise<void> | null = null;
  const check = vi.fn(async () => {
    if (hold) await hold;
    if (fail !== null) throw fail;
    return captureAt(now, change);
  });
  const notify = vi.fn(async () => {});
  const deps: ProactiveDeps = {
    store, now: () => now, timeZone: () => ZONE, check, notify, problem: sundayProblem,
    timers: { setInterval: () => 0, clearInterval: () => {} },
  };
  const context = { settings, rules, status: status("connected") as ConnectionStatus | null };
  const hooks: ProactiveHooks = { context: () => context, onStatus: () => {}, onCapture: vi.fn() };
  const p = createProactive(deps);
  return {
    p, check, notify, hooks, context, store,
    set: (iso: string) => { now = iso; },
    changeTo: (f?: (c: SundayCapture) => void) => { change = f; },
    failWith: (e: unknown) => { fail = e; },
    holdChecks: () => { let release!: () => void; hold = new Promise(r => { release = r; }); return () => { hold = null; release(); }; },
    /** Start the controller and wait for the launch check. */
    launch: async () => { p.start(hooks); await p.tick(); },
  };
}
function memoryStore(): KeyValueStore & { dump: () => string } {
  const data = new Map<string, string>();
  return { get: k => data.get(k) ?? null, set: (k, v) => { data.set(k, v); }, dump: () => [...data.values()].join("\n") };
}
const names = Object.values(nov22Capture().names);

describe("proactive Sunday checks while Ozzie is open", () => {
  beforeEach(() => invoke.mockReset());

  it("checks on launch, keeps a baseline, and sends one discreet notice when a later check finds something worse", async () => {
    const h = harness("2026-11-20T15:00:00Z");
    await h.launch();
    expect(h.check).toHaveBeenCalledTimes(1);
    expect(h.p.view().history.map(e => e.kind)).toEqual(["first-check"]);
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.p.view().schedule.next_run_at).toBe("2026-11-20T16:00:00.000Z");

    h.set("2026-11-20T15:30:00Z");
    await h.p.tick();
    expect(h.check).toHaveBeenCalledTimes(1);

    h.changeTo(decline);
    h.set("2026-11-20T16:00:00Z");
    await h.p.tick();
    expect(h.check).toHaveBeenCalledTimes(2);
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify).toHaveBeenCalledWith();
    const [latest] = h.p.view().history;
    expect(latest).toMatchObject({ kind: "changes", trigger: "scheduled", notice: "sent" });
    expect(latest!.changes!.map(c => [c.kind, c.urgency])).toEqual([["confirmed-declined", "urgent"], ["need-increased", "urgent"]]);
    expect(h.hooks.onCapture).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "live" }), "scheduled");

    // The same facts an hour later: no new change and no second notice.
    h.set("2026-11-20T17:00:00Z");
    await h.p.tick();
    expect(h.check).toHaveBeenCalledTimes(3);
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.p.view().history).toHaveLength(2);
    for (const name of names) expect(h.store.dump()).not.toContain(name);
  });

  it("tells each check how it started, so the task ledger can say automatic or manual", async () => {
    const h = harness("2026-11-20T15:00:00Z");
    const trigger = () => (h.check.mock.calls.at(-1) as unknown[] | undefined)?.[2];
    await h.launch();
    expect(trigger()).toBe("launch");
    h.set("2026-11-20T16:00:00Z");
    await h.p.tick();
    expect(trigger()).toBe("scheduled");
    await h.p.checkNow();
    expect(trigger()).toBe("manual");
  });

  it("holds the notice during quiet hours and sends it once after they end", async () => {
    // 02:30Z is 8:30 PM in Chicago; quiet hours start at 9:00 PM.
    const h = harness("2026-11-21T02:30:00Z");
    await h.launch();
    h.changeTo(decline);
    h.set("2026-11-21T04:00:00Z");
    await h.p.tick();
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.p.view().history[0]).toMatchObject({ kind: "changes", notice: "held" });
    expect(h.p.view().schedule.held).not.toBeNull();

    h.set("2026-11-21T12:50:00Z"); // 6:50 AM, still quiet (the overdue check it runs finds nothing new)
    await h.p.tick();
    expect(h.notify).not.toHaveBeenCalled();
    h.set("2026-11-21T13:01:00Z"); // 7:01 AM
    await h.p.tick();
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.p.view().history.find(e => e.kind === "changes")!.notice).toBe("sent-later");
    await h.p.tick();
    expect(h.notify).toHaveBeenCalledTimes(1);
  });

  it("a held notice is rechecked when quiet hours end: a decline restored overnight brings no notice", async () => {
    // 02:30Z is 8:30 PM in Chicago. Greeter is declined at 10:00 PM and restored before 7:00 AM; other roles stay open.
    const h = harness("2026-11-21T02:30:00Z");
    await h.launch();
    h.changeTo(decline);
    h.set("2026-11-21T04:00:00Z");
    await h.p.tick();
    expect(h.p.view().history[0]).toMatchObject({ kind: "changes", notice: "held" });
    h.changeTo(undefined);
    h.set("2026-11-21T12:50:00Z"); // 6:50 AM, still quiet: the overdue check reads it restored
    await h.p.tick();
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.p.view().latest["1001:92902197"]!.status).not.toBe("checked-scope-clear");
    h.set("2026-11-21T13:01:00Z"); // 7:01 AM: nothing held still holds, so nothing is sent
    await h.p.tick();
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.p.view().schedule.held).toBeNull();
    expect(h.p.view().history.find(e => e.kind === "changes" && e.changes!.some(c => c.kind === "confirmed-declined"))!.notice).toBe("none");
    await h.p.tick();
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("a held notice is rechecked against the latest saved check: still declined there, it goes out once", async () => {
    const h = harness("2026-11-21T02:30:00Z");
    await h.launch();
    h.changeTo(decline);
    h.set("2026-11-21T04:00:00Z");
    await h.p.tick();
    h.set("2026-11-21T12:50:00Z"); // 6:50 AM: a newer check still reads the decline
    await h.p.tick();
    expect(h.notify).not.toHaveBeenCalled();
    h.set("2026-11-21T13:01:00Z");
    await h.p.tick();
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.p.view().history.find(e => e.kind === "changes")!.notice).toBe("sent-later");
    await h.p.tick();
    expect(h.notify).toHaveBeenCalledTimes(1);
  });

  it("a held notice is rechecked against the person's Church rules too: a kind kept for the briefing overnight sends none", async () => {
    const h = harness("2026-11-21T02:30:00Z");
    await h.launch();
    h.changeTo(decline);
    h.set("2026-11-21T04:00:00Z");
    await h.p.tick();
    h.context.rules = { ...rules, feedback: [{ type: "urgency", id: "u", kind: "needs-people", at: "2026-11-21T05:00:00Z", level: "briefing" }] };
    h.set("2026-11-21T13:01:00Z");
    await h.p.tick();
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("Pause everything pauses this check too, drops a held notice, and lifting it restores each to its own state", async () => {
    const h = harness("2026-11-21T03:00:00Z");
    await h.launch();
    h.changeTo(decline);
    h.set("2026-11-21T04:00:00Z");
    await h.p.tick();
    expect(h.p.view().history[0]).toMatchObject({ kind: "changes", notice: "held" });
    h.p.pauseWithEverything(true);
    expect(h.p.view().schedule).toMatchObject({ paused: true, held: null });
    // The held entry no longer says it is waiting, as the responsibilities' held notices don't.
    expect(h.p.view().history[0]!.notice).toBe("none");
    h.p.pauseWithEverything(false);
    expect(h.p.view().schedule.paused).toBe(false);
    // Resuming checks again at once; quiet hours end with nothing held to send.
    await h.p.tick();
    expect(h.p.view().schedule.held).toBeNull();
    h.set("2026-11-21T12:31:00Z");
    await h.p.tick();
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("lifting Pause everything leaves this check as the person last set it, even after a restart", async () => {
    // Paused on its own first: it stays paused.
    const h = harness("2026-11-20T15:00:00Z");
    await h.launch();
    h.p.pause();
    h.p.pauseWithEverything(true);
    const again = harness("2026-11-20T16:00:00Z", h.store);
    again.p.pauseWithEverything(false);
    expect(again.p.view().schedule.paused).toBe(true);
    // Paused on its own while everything was paused: lifting everything leaves it paused.
    const k = harness("2026-11-20T15:00:00Z");
    await k.launch();
    k.p.pauseWithEverything(true);
    k.p.resume();
    k.p.pause();
    k.p.pauseWithEverything(false);
    expect(k.p.view().schedule.paused).toBe(true);
    // Not paused on its own: lifting everything resumes it.
    const m = harness("2026-11-20T15:00:00Z");
    await m.launch();
    m.p.pauseWithEverything(true);
    m.p.pauseWithEverything(true);
    m.p.pauseWithEverything(false);
    expect(m.p.view().schedule.paused).toBe(false);
  });

  it("Worth a look never sends a notice: a declined request or a check that couldn't be completed shows in Ozzie, with no notice", async () => {
    const h = harness("2026-11-20T15:00:00Z");
    await h.launch();
    // The pending Lyrics request is declined: Worth a look on its Sunday card.
    const declined = (c: SundayCapture) => { rows(c, "team_members").find(m => m.id === "403")!.attributes.status = "D"; };
    h.changeTo(declined);
    h.set("2026-11-20T16:00:00Z");
    await h.p.tick();
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.p.view().history[0]).toMatchObject({ kind: "changes", trigger: "scheduled", notice: "none" });
    expect(h.p.view().history[0]!.changes!.map(c => c.kind)).toEqual(["pending-declined"]);
    // It still shows as new in Ozzie.
    expect(h.p.view().unseen).toBe(1);
    // A Planning Center read that didn't complete: the check isn't a full picture, Worth a look too.
    h.changeTo(c => { declined(c); c.reads.find(r => r.collection === "needed_positions")!.outcome = "provider_failure"; });
    h.set("2026-11-20T17:00:00Z");
    await h.p.tick();
    expect(h.p.view().history[0]!.changes!.map(c => c.kind)).toEqual(["coverage-unverified"]);
    expect(h.p.view().history[0]!.notice).toBe("none");
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("lets an urgent change through quiet hours only when the person chose that", async () => {
    const h = harness("2026-11-21T03:00:00Z");
    h.p.setPrefs({ ...h.p.view().prefs, urgentDuringQuiet: true });
    await h.launch();
    h.changeTo(decline);
    h.set("2026-11-21T04:00:00Z");
    await h.p.tick();
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.p.view().history[0]!.notice).toBe("sent");
  });

  it("Put this in the briefing: a kind the person keeps for the briefing changes in Ozzie but sends no notice", async () => {
    const h = harness("2026-11-20T15:00:00Z");
    h.context.rules = { ...rules, feedback: [{ type: "urgency", id: "u", kind: "needs-people", at: "2026-11-20T14:00:00Z", level: "briefing" }] };
    await h.launch();
    h.changeTo(decline);
    h.set("2026-11-20T16:00:00Z");
    await h.p.tick();
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.p.view().history[0]).toMatchObject({ kind: "changes", notice: "briefing" });
    expect(h.p.view().history[0]!.changes!.map(c => c.kind)).toEqual(["confirmed-declined", "need-increased"]);
  });

  it("Always tell me right away: outside the urgent window it still waits for quiet hours, unless urgent ones are let through", async () => {
    for (const [urgentDuringQuiet, expected] of [[false, "held"], [true, "sent"]] as const) {
      const h = harness("2026-11-21T02:30:00Z");
      h.p.setPrefs({ ...h.p.view().prefs, urgentDuringQuiet, urgentWithinHours: 1 });
      h.context.rules = { ...rules, feedback: [{ type: "urgency", id: "r", kind: "needs-people", at: "2026-11-20T14:00:00Z", level: "right-away" }] };
      await h.launch();
      h.changeTo(decline);
      h.set("2026-11-21T04:00:00Z"); // 10:00 PM in Chicago
      await h.p.tick();
      expect(h.p.view().history[0]!.notice).toBe(expected);
    }
    // Without the rule, a change outside the window waits even with urgent ones let through.
    const h = harness("2026-11-21T02:30:00Z");
    h.p.setPrefs({ ...h.p.view().prefs, urgentDuringQuiet: true, urgentWithinHours: 1 });
    await h.launch();
    h.changeTo(decline);
    h.set("2026-11-21T04:00:00Z");
    await h.p.tick();
    expect(h.p.view().history[0]!.notice).toBe("held");
  });

  it("Always tell me right away about a kind the Sunday comparison doesn't follow: a background check newly found missing brings a notice", async () => {
    /** Planning Center People's background check for the Nursery volunteer, expiring on `expires`. */
    const onFile = (expires: string) => (c: SundayCapture) => {
      c.reads.push({ collection: BACKGROUND_CHECKS, people_person_id: PEOPLE.nurseryConfirmed, offset: 0, checked_at: c.completed_at, outcome: "ok", body: {
        data: [{ type: "BackgroundCheck", id: "901", attributes: { status: "complete_clear", current: true, expires_on: expires }, relationships: { person: { data: { type: "Person", id: PEOPLE.nurseryConfirmed } } } }],
        meta: { count: 1, total_count: 1 } } });
    };
    for (const told of [false, true]) {
      const h = harness("2026-11-20T15:00:00Z");
      h.context.rules = { ...rules, kidsTeams: [{ team_id: TEAMS.nursery, min_confirmed: 1 }],
        feedback: told ? [{ type: "urgency", id: "r", kind: "background-check", at: "2026-11-20T14:00:00Z", level: "right-away" }] : [] };
      h.changeTo(onFile("2027-06-01"));
      await h.launch();
      // An hour later the check on file has expired. Nothing about who serves changed.
      h.changeTo(onFile("2026-11-01"));
      h.set("2026-11-20T16:00:00Z");
      await h.p.tick();
      expect(h.notify).toHaveBeenCalledTimes(told ? 1 : 0);
      const entry = h.p.view().history[0]!;
      if (!told) { expect(entry.kind).toBe("first-check"); continue; }
      expect(entry).toMatchObject({ kind: "changes", notice: "sent" });
      expect(entry.changes!.map(c => describeChange(c, () => undefined))).toEqual([
        "New since the last check: missing or expiring background checks. Your Church rules say to tell you right away."]);
      // The same finding an hour later is not new: no second notice.
      h.set("2026-11-20T17:00:00Z");
      await h.p.tick();
      expect(h.notify).toHaveBeenCalledTimes(1);
      for (const name of names) expect(h.store.dump()).not.toContain(name);
    }
  });

  it("moves saved quiet hours still on the earlier default to 9:00 PM to 7:00 AM, once, and never changes a person's own", () => {
    const earlier = memoryStore();
    earlier.set("ozzie.proactive.prefs.v1", JSON.stringify({ intervalMinutes: 30, runOnLaunch: true, quietStart: "21:30", quietEnd: "06:30", urgentDuringQuiet: false, urgentWithinHours: 48 }));
    const h = harness("2026-11-20T15:00:00Z", earlier);
    expect(h.p.view().prefs).toMatchObject({ intervalMinutes: 30, quietStart: "21:00", quietEnd: "07:00" });
    // Then a person picks 9:30 PM to 6:30 AM on purpose: it stays after a restart.
    h.p.setPrefs({ ...h.p.view().prefs, quietStart: "21:30", quietEnd: "06:30" });
    expect(harness("2026-11-20T15:00:00Z", earlier).p.view().prefs).toMatchObject({ quietStart: "21:30", quietEnd: "06:30" });
    const own = memoryStore();
    own.set("ozzie.proactive.prefs.v1", JSON.stringify({ intervalMinutes: 60, runOnLaunch: true, quietStart: "22:00", quietEnd: "06:30", urgentDuringQuiet: false, urgentWithinHours: 48 }));
    expect(harness("2026-11-20T15:00:00Z", own).p.view().prefs).toMatchObject({ quietStart: "22:00", quietEnd: "06:30" });
    // Nothing saved yet: the settled default.
    expect(harness("2026-11-20T15:00:00Z").p.view().prefs).toMatchObject({ quietStart: "21:00", quietEnd: "07:00" });
  });

  it("reports a failed check once, retries with backoff, and never sends a notice for it", async () => {
    const h = harness("2026-11-20T15:00:00Z");
    h.failWith({ sunday_check: "provider" });
    await h.launch();
    const view = h.p.view();
    expect(view.schedule.last_run).toMatchObject({ outcome: "failed", problem: "Planning Center couldn't be checked just now. You can show the last saved check instead." });
    expect(view.schedule.next_run_at).toBe("2026-11-20T15:05:00.000Z");
    h.set("2026-11-20T15:05:00Z");
    await h.p.tick();
    expect(h.p.view().schedule).toMatchObject({ failures: 2, next_run_at: "2026-11-20T15:15:00.000Z" });
    expect(h.p.view().history.map(e => e.kind)).toEqual(["failed"]);
    expect(h.notify).not.toHaveBeenCalled();
    expect(JSON.stringify(h.p.view())).not.toContain("provider");
  });

  it("Check now while a scheduled check is running waits for it instead of starting a second one", async () => {
    const h = harness("2026-11-20T15:00:00Z");
    const release = h.holdChecks();
    h.p.start(h.hooks);
    const ticking = h.p.tick();
    await Promise.resolve();
    const manual = h.p.checkNow();
    expect(h.p.view().running).toBe(true);
    release();
    const [capture] = await Promise.all([manual, ticking]);
    expect(capture.kind).toBe("live");
    expect(h.check).toHaveBeenCalledTimes(1);
  });

  it("a manual check records what changed but never sends a notice", async () => {
    const h = harness("2026-11-20T15:00:00Z");
    await h.launch();
    h.changeTo(decline);
    h.set("2026-11-20T15:10:00Z");
    await h.p.checkNow();
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.p.view().history[0]).toMatchObject({ kind: "changes", trigger: "manual", notice: "in-app" });
    expect(h.p.view().schedule.next_run_at).toBe("2026-11-20T16:10:00.000Z");
  });

  it("reports a check missed while Ozzie was closed on the next launch, then catches up", async () => {
    const store = memoryStore();
    const first = harness("2026-11-20T15:00:00Z", store);
    await first.launch();
    first.p.stop();
    const second = harness("2026-11-21T01:00:00Z", store);
    await second.launch();
    expect(second.p.view().history.map(e => e.kind)).toEqual(["missed", "first-check"]);
    expect(second.p.view().history[0]).toMatchObject({ kind: "missed", scheduled_for: "2026-11-20T16:00:00.000Z" });
    expect(second.p.view().schedule.last_run).toMatchObject({ trigger: "catch-up", outcome: "ok" });
    expect(second.check).toHaveBeenCalledTimes(1);
  });

  it("waits for a saved connection and a chosen Sunday instead of failing", async () => {
    const h = harness("2026-11-20T15:00:00Z");
    h.context.status = null;
    await h.launch();
    expect(h.check).not.toHaveBeenCalled();
    expect(h.p.view().schedule).toMatchObject({ failures: 0, waiting_since: "2026-11-20T15:00:00Z" });
    expect(h.p.view().history).toEqual([]);
    h.context.status = status("stored-unchecked");
    await h.p.tick();
    expect(h.check).toHaveBeenCalledTimes(1);
  });

  it("pausing stops automatic checks; Check now still works", async () => {
    const h = harness("2026-11-20T15:00:00Z");
    await h.launch();
    h.p.pause();
    h.set("2026-11-20T18:00:00Z");
    await h.p.tick();
    expect(h.check).toHaveBeenCalledTimes(1);
    await h.p.checkNow();
    expect(h.check).toHaveBeenCalledTimes(2);
    h.p.resume();
    await h.p.tick();
    expect(h.check).toHaveBeenCalledTimes(3);
  });

  it("a pause survives restarting Ozzie: no launch check, no missed check", async () => {
    const store = memoryStore();
    const first = harness("2026-11-20T15:00:00Z", store);
    await first.launch();
    first.p.pause();
    first.p.stop();
    const second = harness("2026-11-20T20:00:00Z", store);
    await second.launch();
    expect(second.check).not.toHaveBeenCalled();
    expect(second.p.view().schedule).toMatchObject({ paused: true, next_run_at: null });
    expect(second.p.view().history.map(e => e.kind)).toEqual(["first-check"]);
  });

  it("starting twice (as React does in development) runs the launch work once", async () => {
    const h = harness("2026-11-20T15:00:00Z");
    h.p.start(h.hooks);
    h.p.stop();
    await h.launch();
    expect(h.check).toHaveBeenCalledTimes(1);
    expect(h.p.view().schedule.last_run?.outcome).toBe("ok");
  });

  it("counts new attention until the page is seen", async () => {
    const h = harness("2026-11-20T15:00:00Z");
    await h.launch();
    h.changeTo(decline);
    h.set("2026-11-20T16:00:00Z");
    await h.p.tick();
    expect(h.p.view().unseen).toBe(1);
    h.p.markSeen();
    expect(h.p.view().unseen).toBe(0);
  });
});

describe("changes handed to Keep Sunday covered", () => {
  beforeEach(() => invoke.mockReset());
  /** A hand-off the test settles: `true` when Keep Sunday covered decided the notice itself. */
  function handOff() {
    let settle: (decided: boolean) => void = () => {};
    const onChanges = vi.fn(() => new Promise<boolean>(resolve => { settle = resolve; }));
    return { onChanges, settle: (decided: boolean) => settle(decided) };
  }
  const changed = async (h: ReturnType<typeof harness>, at: string) => { h.changeTo(decline); h.set(at); await h.p.tick(); };
  const entry = (h: ReturnType<typeof harness>) => h.p.view().history.find(e => e.kind === "changes")!;

  it("says which Sunday and whether it has a notice, then sends none when Keep Sunday covered decided one", async () => {
    const h = harness("2026-11-20T15:00:00Z");
    const hand = handOff();
    h.hooks.onChanges = hand.onChanges;
    await h.launch();
    await changed(h, "2026-11-20T16:00:00Z");
    expect(hand.onChanges).toHaveBeenCalledWith(expect.any(Array), { plan_id: settings.planId, notice: true });
    expect(entry(h).notice).toBe("handed");
    hand.settle(true);
    await vi.waitFor(() => expect(entry(h).notice).toBe("responsibility"));
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("sends its own notice after all when Keep Sunday covered didn't decide one", async () => {
    const h = harness("2026-11-20T15:00:00Z");
    const hand = handOff();
    h.hooks.onChanges = hand.onChanges;
    await h.launch();
    await changed(h, "2026-11-20T16:00:00Z");
    hand.settle(false);
    await vi.waitFor(() => expect(entry(h).notice).toBe("sent"));
    expect(h.notify).toHaveBeenCalledTimes(1);
  });

  it("the fallback respects quiet hours: held, then sent once when they end", async () => {
    const h = harness("2026-11-21T02:30:00Z");
    const hand = handOff();
    h.hooks.onChanges = hand.onChanges;
    await h.launch();
    await changed(h, "2026-11-21T04:00:00Z");
    hand.settle(false);
    await vi.waitFor(() => expect(entry(h).notice).toBe("held"));
    expect(h.notify).not.toHaveBeenCalled();
    h.set("2026-11-21T13:01:00Z");
    await h.p.tick();
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(entry(h).notice).toBe("sent-later");
  });

  it("paused while it waited: no notice, as a held one is dropped", async () => {
    const h = harness("2026-11-20T15:00:00Z");
    const hand = handOff();
    h.hooks.onChanges = hand.onChanges;
    await h.launch();
    await changed(h, "2026-11-20T16:00:00Z");
    h.p.pause();
    hand.settle(false);
    await vi.waitFor(() => expect(entry(h).notice).toBe("none"));
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("seen in Ozzie while it waited: that counts as being told", async () => {
    const h = harness("2026-11-20T15:00:00Z");
    const hand = handOff();
    h.hooks.onChanges = hand.onChanges;
    await h.launch();
    await changed(h, "2026-11-20T16:00:00Z");
    h.set("2026-11-20T16:01:00Z");
    h.p.markSeen();
    hand.settle(false);
    await vi.waitFor(() => expect(entry(h).notice).toBe("in-app"));
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("Ozzie closed before Keep Sunday covered decided: the notice waits like a held one and goes out once", async () => {
    const store = memoryStore();
    const first = harness("2026-11-20T15:00:00Z", store);
    first.hooks.onChanges = handOff().onChanges;
    await first.launch();
    await changed(first, "2026-11-20T16:00:00Z");
    expect(entry(first).notice).toBe("handed");
    first.p.stop();
    const second = harness("2026-11-20T16:10:00Z", store);
    second.changeTo(decline);
    await second.launch();
    expect(second.notify).toHaveBeenCalledTimes(1);
    expect(entry(second).notice).toBe("sent-later");
  });

  it("nothing handed over (no promise back): the notice goes out straight away, as before", async () => {
    const h = harness("2026-11-20T15:00:00Z");
    h.hooks.onChanges = vi.fn(() => undefined);
    await h.launch();
    await changed(h, "2026-11-20T16:00:00Z");
    expect(entry(h).notice).toBe("sent");
    expect(h.notify).toHaveBeenCalledTimes(1);
  });
});

describe("native boundaries", () => {
  beforeEach(() => invoke.mockReset());

  it("the notice is fixed in native code; the webview sends no text", async () => {
    invoke.mockResolvedValue(undefined);
    await notifySundayAttention();
    expect(invoke).toHaveBeenCalledWith("notify_sunday_attention");
    expect(invoke.mock.calls[0]).toHaveLength(1);
  });

  it("re-verifies a saved connection before reading, as the Sunday page always has", async () => {
    invoke.mockImplementation(async (command: string) => command === "check_saved_connection" ? status("connected") : captureAt("2026-11-20T15:00:00Z"));
    const seen: ConnectionStatus[] = [];
    await verifiedSundayCheck({ settings, status: status("stored-unchecked") }, s => seen.push(s));
    expect(invoke.mock.calls.map(c => c[0])).toEqual(["check_saved_connection", "check_sunday"]);
    expect(seen.map(s => s.state)).toEqual(["connected"]);

    invoke.mockReset();
    invoke.mockResolvedValue(status("expired"));
    await expect(verifiedSundayCheck({ settings, status: status("stored-unchecked") }, () => {})).rejects.toBe("not-connected");
    expect(invoke.mock.calls.map(c => c[0])).toEqual(["check_saved_connection"]);

    invoke.mockReset();
    invoke.mockResolvedValue(captureAt("2026-11-20T15:00:00Z"));
    await verifiedSundayCheck({ settings, status: status("connected") }, () => {});
    expect(invoke.mock.calls).toEqual([["check_sunday", { serviceTypeId: "1500", planId: "92902197" }]]);
  });

  it("runs only with a saved connection and a chosen Sunday, never during sign-in", () => {
    expect(proactiveReadiness(settings, status("connected"))).toBe("ready");
    expect(proactiveReadiness(settings, status("stored-unchecked"))).toBe("ready");
    for (const state of ["waiting", "checking", "disconnected", "cancelled", "expired", "failed"] as const) {
      expect(proactiveReadiness(settings, status(state))).toBe("not-connected");
    }
    expect(proactiveReadiness(settings, null)).toBe("not-connected");
    expect(proactiveReadiness({ ...settings, planId: "" }, status("connected"))).toBe("not-configured");
  });
  it("needs the connection to be for the organization in Settings, and works with Ozzie's own registration", () => {
    expect(proactiveReadiness({ ...settings, organization: "2002" }, status("connected"))).toBe("not-connected");
    expect(proactiveReadiness({ ...settings, clientId: "" }, status("connected"))).toBe("ready");
  });

  it("checks the saved sign-in once on launch, only when an organization is set and nothing has started", async () => {
    const calls: string[] = [];
    const refresh = async (c: string, o: string) => { calls.push(`${c}|${o}`); return status("connected"); };
    expect(await verifySavedOnLaunch({ ...settings, clientId: "" }, null, refresh)).toMatchObject({ state: "connected" });
    expect(calls).toEqual(["|1001"]);
    expect(await verifySavedOnLaunch({ ...settings, organization: "" }, null, refresh)).toBeNull();
    expect(await verifySavedOnLaunch(settings, status("waiting"), refresh)).toBeNull();
    expect(calls).toHaveLength(1);
    expect(await verifySavedOnLaunch(settings, null, async () => { throw "invalid-token"; })).toBeNull();
  });
});

