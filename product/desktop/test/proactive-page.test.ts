import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { createProactive, type KeyValueStore, type ProactiveView } from "../src/proactive.js";
import { ProactivePage } from "../src/proactive-page.js";
import { sundayProblem, type Settings } from "../src/sunday-source.js";
import { nov22Capture } from "../../../core/src/fictional-sunday.js";
import type { SundayCapture } from "../../../core/src/sunday-capture.js";
import type { Readiness } from "../src/proactive.js";

const settings: Settings = { clientId: "fictional-client", organization: "1001", serviceTypeId: "1500", planId: "92902197" };
type Row = { id: string; attributes: Record<string, unknown> };
const rows = (c: SundayCapture, collection: string) => c.reads.find(r => r.collection === collection)!.body!.data as Row[];
function captureAt(iso: string, declined: boolean): SundayCapture {
  const c = nov22Capture();
  if (declined) {
    rows(c, "team_members").find(m => m.id === "401")!.attributes.status = "D";
    rows(c, "needed_positions").find(n => n.attributes.team_position_name === "Greeter")!.attributes.quantity = 2;
  }
  const delta = Date.parse(iso) - Date.parse(c.completed_at);
  const shift = (t: string) => new Date(Date.parse(t) + delta).toISOString();
  return { ...c, started_at: shift(c.started_at), completed_at: shift(c.completed_at), reads: c.reads.map(r => ({ ...r, checked_at: shift(r.checked_at) })) };
}

/** A real controller run on fixed fictional data: baseline, a missed hour, then a decline. */
async function viewAfterDecline(): Promise<ProactiveView> {
  const data = new Map<string, string>();
  const store: KeyValueStore = { get: k => data.get(k) ?? null, set: (k, v) => { data.set(k, v); } };
  let now = "2026-11-20T15:00:00Z", declined = false;
  const p = createProactive({
    store, now: () => now, timeZone: () => "America/Chicago", check: async () => captureAt(now, declined),
    notify: async () => {}, problem: sundayProblem, timers: { setInterval: () => 0, clearInterval: () => {} },
  });
  const status = { state: "connected" as const, organization: "1001", checked_at_ms: null, source: "", problem: null };
  p.start({ context: () => ({ settings, rules: { sundayLeads: [], checkInAfterSundaysInARow: 3 }, status }), onStatus: () => {}, onCapture: () => {} });
  await p.tick();
  declined = true;
  now = "2026-11-20T18:00:00Z";
  await p.tick();
  return p.view();
}
const render = (view: ProactiveView, names: Record<string, string>, readiness: Readiness = "ready") => renderToStaticMarkup(React.createElement(ProactivePage, {
  view, names, organization: "1001", planId: "92902197", readiness, busy: false, now: "2026-11-20T18:05:00Z",
  onCheckNow: () => {}, onPause: () => {}, onResume: () => {}, onPrefs: () => {},
}));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&quot;/g, "\"").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

describe("Keeping watch", () => {
  it("says what runs, which account, what it can do, and how to stop it", async () => {
    const page = text(render(await viewAfterDecline(), {}));
    expect(page).toContain("Keeping watch");
    expect(page).toContain("What Ozzie is watching");
    expect(page).toContain("Ozzie keeps an eye on Sunday Runs by itself whenever Ozzie is open.");
    // Its interval, under Schedule and quiet hours, is named for it (Keep Sunday covered keeps its own times), and is the
    // longest it waits: with its window on screen Ozzie reads again sooner (App's stale refresh).
    expect(page).toContain("Look at Sunday at least every");
    expect(page).toContain("Reads only. It never sends messages.");
    // Where Ozzie reads, with the church by its name when known; never its organization number (spec §6).
    expect(page).toContain("Planning Center Services Ozzie keeps an eye on Sunday");
    expect(page).not.toContain("1001");
    expect(page).not.toMatch(/runs automatically|automatic checks|regular Sunday check/u);
    // Closing the window doesn't stop Ozzie (it stays in the menu bar); quitting does, and so does sleep, said outside any fold.
    expect(page).toContain("How often When Ozzie opens, then at least every hour while it is running, even with its window closed. While its window is on screen, about every 30 minutes.");
    expect(page).toContain("What Ozzie is watching Nothing runs after you quit Ozzie or while this Mac is asleep.");
    expect(page).toContain("See how this works Ozzie keeps checking while its window is closed. It stays as the small Ozzie picture at the top of your screen.");
    expect(page).toContain("Time zone: ");
    expect(page).toContain("Pause keeping an eye on Sunday");
    expect(page).toContain("Check now");
    expect(page).toContain("“Sunday coverage needs attention. Open Ozzie to see details.” It never includes names or details.");
  });

  it("reports the missed check and lists changes, resolving names only from the names it is given", async () => {
    const view = await viewAfterDecline();
    const withNames = text(render(view, nov22Capture().names));
    expect(withNames).toContain("A scheduled check was missed at");
    expect(withNames).toContain("Avery Brightwater declined Greeter after confirming.");
    expect(withNames).toContain("Urgent");
    expect(withNames).toContain("Notice sent");
    const without = text(render(view, {}));
    expect(without).toContain("Someone declined Greeter after confirming.");
    for (const name of Object.values(nov22Capture().names)) expect(without).not.toContain(name);
  });

  it("doesn't claim a schedule before setup, and offers Resume when paused", async () => {
    const view = await viewAfterDecline();
    expect(text(render(view, {}, "not-connected"))).toContain("Not running yet. Connect Planning Center under Settings");
    const paused = text(render({ ...view, schedule: { ...view.schedule, paused: true, next_run_at: null } }, {}));
    expect(paused).toContain("Resume keeping an eye on Sunday");
    expect(paused).toContain("Paused. Ozzie doesn't look at Sunday until you resume.");
  });

  it("says how often as the most it waits, and the window's quicker reads only when they are quicker", async () => {
    const view = await viewAfterDecline();
    const at = (intervalMinutes: number, runOnLaunch: boolean) => text(render({ ...view, prefs: { ...view.prefs, intervalMinutes, runOnLaunch } }, {}));
    expect(at(120, false)).toContain("How often At least every 2 hours while it is running, even with its window closed. While its window is on screen, about every 30 minutes.");
    // Every 30 or 15 minutes already is as often as the window's reads: nothing more to say.
    expect(at(30, true)).toContain("How often When Ozzie opens, then at least every 30 minutes while it is running, even with its window closed. Telling you");
    expect(at(15, false)).toContain("How often At least every 15 minutes while it is running, even with its window closed. Telling you");
    for (const page of [at(60, true), at(60, false)]) expect(page).not.toMatch(/(?<!at least )\bevery hour\b/iu);
  });

  it("says a check outside the schedule was outside the schedule, never that someone pressed Check now", async () => {
    // Check now, Ozzie's own re-read while its window is on screen and a job's check all start as "manual"; the schedule can't tell them apart.
    const view = await viewAfterDecline();
    const last = { ...view.schedule.last_run!, trigger: "manual" as const };
    const page = text(render({ ...view, schedule: { ...view.schedule, last_run: last } }, {}));
    expect(page).toMatch(/Last check [^.]+, outside the schedule\. Finished\./u);
    expect(page).not.toMatch(/Last check [^.]+, Check now/u);
    // Paused, a check someone asked for is still outside the schedule.
    expect(text(render({ ...view, schedule: { ...view.schedule, paused: true, next_run_at: null, last_run: last } }, {}))).toMatch(/Last check [^.]+, outside the schedule\. Finished\./u);
    // A check the schedule started still says so.
    expect(text(render({ ...view, schedule: { ...view.schedule, last_run: { ...last, trigger: "scheduled" } } }, {}))).toMatch(/Last check [^.]+, on schedule\. Finished\./u);
  });

  it("lists what changed, and says only changes are listed once there is something to list", async () => {
    const view = await viewAfterDecline();
    expect(text(render(view, {}))).toContain("Only changes are listed. A check that finds the same facts as the one before adds nothing here.");
    const empty = text(render({ ...view, history: [] }, {}));
    expect(empty).toContain("What changed recently Nothing yet. After the first check, Ozzie lists what changes from one check to the next. Schedule and quiet hours");
  });

  it("uses plain product language", async () => {
    const page = text(render(await viewAfterDecline(), nov22Capture().names));
    expect(page).not.toMatch(/\b(agents?|logs?|sessions?|connectors?|skills?|harness|approve|block|all clear|at risk|drifting)\b/i);
  });
});
