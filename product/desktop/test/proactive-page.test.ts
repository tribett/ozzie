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

describe("What runs automatically", () => {
  it("says what runs, which account, what it can do, and how to stop it", async () => {
    const page = text(render(await viewAfterDecline(), {}));
    expect(page).toContain("Keeping an eye on Sunday");
    expect(page).toContain("The regular Sunday check");
    // Its interval, under Schedule and quiet hours, is named for it (Keep Sunday covered keeps its own times).
    expect(page).toContain("Regular Sunday check every");
    expect(page).toContain("Reads only. It never changes Planning Center or sends messages.");
    expect(page).toContain("Planning Center organization 1001");
    // Closing the window no longer stops Ozzie (it stays in the menu bar); quitting does.
    expect(page).toContain("When Ozzie opens, then every hour while Ozzie is running on this Mac, even with its window closed. Nothing runs after you quit it.");
    expect(page).toContain("Time zone");
    expect(page).toContain("Pause automatic checks");
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
    expect(paused).toContain("Resume automatic checks");
    expect(paused).toContain("Paused. Nothing runs automatically until you resume.");
  });

  it("uses plain product language", async () => {
    const page = text(render(await viewAfterDecline(), nov22Capture().names));
    expect(page).not.toMatch(/\b(agents?|logs?|sessions?|connectors?|skills?|harness|approve|block|all clear|at risk|drifting)\b/i);
  });
});
