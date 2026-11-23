// The whole app for a church on B1 Church or Breeze, with jobs (0.8.0), on a fake native side: fictional captures only, no
// key, no Keychain, no network, no AI. A Mac set up on the system sets up Keep services covered and the morning briefing
// from Keeping watch, through the one plan to confirm; each runs its first check over the system's own read (never
// Planning Center's); and Today shows them under In progress, what they noticed under Ready to review and Needs a
// decision, the briefing's preview and "Listen to today's briefing", all in the system's own name.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeDom } from "./fake-dom.js";
import { b1Capture, breezeUntimedCapture } from "../../../core/test/church-systems/fixtures.js";
import { defaultPlan } from "../../../core/src/harness/responsibilities.js";

const native = vi.hoisted(() => {
  type Job = { id: string; template: string; title: string; skill_id: string; status: string; created_at: string; confirmed_at: string; runs: Record<string, unknown>[];
    open_run: Record<string, unknown> | null; [k: string]: unknown };
  const titles: Record<string, [string, string]> = { "keep-sunday-covered": ["Keep Sunday covered", "sunday-ready"], "morning-briefing": ["Morning briefing", "sunday-ready"],
    "watch-room-bookings": ["Watch room bookings", "room-check"] };
  const state = { calls: [] as [string, Record<string, unknown>][], capture: "" as string, jobs: [] as Job[], n: 0 };
  const now = () => new Date().toISOString();
  const id = (k: number) => `00000000-0000-4000-8000-${k.toString(16).padStart(12, "0")}`;
  const listing = () => ({ paused_all: false, items: JSON.parse(JSON.stringify(state.jobs)) as Job[] });
  const find = (rid: unknown) => { const j = state.jobs.find(x => x.id === rid); if (!j) throw "unknown"; return j; };
  /** responsibilities.rs, as far as these cases need it: one per template, a run at a time. */
  const jobs = (command: string, args: Record<string, unknown>): unknown => {
    switch (command) {
      case "responsibility_list": return listing();
      case "responsibility_create": {
        const plan = args.plan as { template: string };
        if (state.jobs.some(j => j.template === plan.template && j.status !== "ended")) throw "exists";
        const [title, skill] = titles[plan.template]!;
        const j: Job = { ...plan, id: id(++state.n), title, skill_id: skill, status: "active", created_at: now(), confirmed_at: now(), runs: [], open_run: null };
        state.jobs.push(j);
        return JSON.parse(JSON.stringify(j));
      }
      case "responsibility_run_begin": {
        const j = find(args.id);
        if (j.open_run) throw "busy";
        const run = { run_id: id(1000 + ++state.n), trigger: args.trigger, started_at: now(), ended_at: null, outcome: null, code: null, noticed: 0, drafts: 0, ai_steps: 0 };
        j.runs.unshift(run);
        j.open_run = run;
        return { run_id: run.run_id, ai_steps: 0, checks_left: 5 };
      }
      case "responsibility_run_end": {
        const j = find(args.id);
        const run = j.runs.find(r => r.run_id === args.runId && !r.ended_at)!;
        Object.assign(run, { ended_at: now(), outcome: args.outcome, code: args.code, noticed: args.noticed, drafts: args.drafts });
        j.open_run = null;
        return JSON.parse(JSON.stringify(j));
      }
      case "responsibility_pause": { const j = find(args.id); j.status = "paused"; return JSON.parse(JSON.stringify(j)); }
      case "responsibility_resume": { const j = find(args.id); j.status = "active"; return JSON.parse(JSON.stringify(j)); }
      case "responsibility_stop": { const j = find(args.id); j.status = "ended"; return JSON.parse(JSON.stringify(j)); }
      case "responsibility_edit": { const j = find(args.id); Object.assign(j, args.plan); return JSON.parse(JSON.stringify(j)); }
      case "responsibility_pause_all": return listing();
      default: return undefined;
    }
  };
  return Object.assign(state, { jobs_: jobs });
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args: Record<string, unknown> = {}) => {
    native.calls.push([command, args]);
    if (command.startsWith("responsibility_")) return native.jobs_(command, args);
    if (command === "dev_defaults" || command === "connection_status") await new Promise(r => setTimeout(r, 20));
    switch (command) {
      case "connection_status": return null;
      case "check_saved_connection": return null;
      case "dev_defaults": return { clientId: "", organization: "", serviceTypeId: "", planId: "", autopilot: false };
      case "planning_center_app": return true;
      case "list_sunday_recordings": return [];
      case "background_info": return { fastSchedule: false, probe: false, tickMs: 30_000 };
      case "update_status": return null;
      case "notification_permission": return "unknown";
      case "model_status": return { configured: false, route: "none", label: "", setup: "no-route" };
      case "set_no_ai": return { configured: false, route: "none", label: "", setup: "no-route" };
      case "own_key_providers": return [];
      case "managed_offer": return { open: false, reason: "closed" };
      case "church_system_verify": return { outcome: "works", church: { id: "CHU0000cedar", name: "Cedar Hollow Fellowship" } };
      case "church_system_check": {
        const zone = typeof args.zone === "string" ? args.zone : null;
        return { outcome: "ok", capture: native.capture || JSON.stringify(b1Capture({ church: { id: "CHU0000cedar", time_zone: zone ?? "America/Chicago" } })) };
      }
      case "church_system_saved": return [];
      case "church_system_saved_checks": return [];
      case "notify_sunday_attention": return null;
      case "notify_ozzie": return null;
      default: return new Promise(() => {});
    }
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const dom = installFakeDom();
const kept = new Map<string, string>();
const storage = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => { kept.set(k, String(v)); },
  removeItem: (k: string) => { kept.delete(k); }, clear: () => kept.clear(), key: (i: number) => [...kept.keys()][i] ?? null, get length() { return kept.size; } };
Object.assign(globalThis, { localStorage: storage });
Object.assign(globalThis.window as object, { localStorage: storage });

const tick = () => new Promise(r => setTimeout(r, 0));
const all = (n: { childNodes: unknown[] }): unknown[] => [n, ...n.childNodes.flatMap(c => all(c as { childNodes: unknown[] }))];
const buttonStarting = (text: string) => all(dom.root as unknown as { childNodes: unknown[] })
  .find(n => (n as { tagName?: string }).tagName === "BUTTON" && ((n as { textContent: string }).textContent ?? "").startsWith(text)) as Parameters<typeof dom.press>[0] | undefined;
type Props = Record<string, { onClick?: (e: unknown) => void }>;
const propsOf = (el: unknown) => { const o = el as Props; return o[Object.keys(o).find(k => k.startsWith("__reactProps$"))!]; };
/** Planning Center by name anywhere but a plain line that something works with Planning Center only. */
const misnamed = (t: string) => {
  const rest = t.replace(/[^.]*works? with Planning Center only for now[^.]*\./gu, "").replace(/Ozzie can't do (?:this|these) with [A-Za-z0-9 ]+ yet\./gu, "");
  return [...rest.matchAll(/Planning Center/gu)].map(m => rest.slice(Math.max(0, m.index - 60), m.index + 60));
};
let unmount: (() => Promise<void>) | null = null;
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers({ shouldAdvanceTime: true }); vi.setSystemTime(new Date("2026-11-20T15:05:00Z")); kept.clear();
  native.calls = []; native.capture = ""; native.jobs = []; native.n = 0;
});
afterEach(async () => { await unmount?.(); unmount = null; vi.useRealTimers(); });

async function launch() {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { App } = await import("../src/App.js");
  const root = createRoot(dom.root as unknown as Element);
  await act(async () => { root.render(React.createElement(App)); });
  const settle = async (n = 30) => { for (let i = 0; i < n; i++) await act(async () => { await tick(); }); };
  await settle();
  unmount = async () => { await act(async () => { root.unmount(); }); };
  const press = async (label: string) => {
    const b = dom.button(label) ?? buttonStarting(label);
    if (!b) throw new Error(`no button "${label}" in: ${dom.seen().slice(0, 900)}`);
    await act(async () => { dom.press(b); await tick(); });
    await settle();
  };
  const waitFor = async (text: string) => {
    for (let i = 0; i < 40 && !dom.seen().includes(text); i++) { await act(async () => { await vi.advanceTimersByTimeAsync(250); }); await settle(5); }
    if (!dom.seen().includes(text)) throw new Error(`never saw "${text}" in: ${dom.seen().slice(0, 1500)}`);
  };
  const go = async (label: string) => {
    const a = all(dom.root as unknown as { childNodes: unknown[] }).find(n => (n as { tagName?: string }).tagName === "A" && (n as { textContent: string }).textContent.startsWith(label));
    await act(async () => { propsOf(a)?.onClick?.({ preventDefault() {} }); await tick(); });
    await settle();
  };
  return { press, waitFor, go, settle };
}
const seed = (system: "b1" | "breeze") => kept.set("ozzie.church-system.v1", JSON.stringify({
  main: system, genesis: null,
  connection: system === "b1"
    ? { system, church_id: "CHU0000cedar", church_name: "Cedar Hollow Fellowship", address: "cedarhollow", service_id: "PLA0000nov22", service_day: "2026-11-22",
      service_name: "Sunday Gathering", zone: "America/Chicago", result_seen: true }
    : { system, church_id: "perlandera", church_name: "Perlandera Fictional Church", address: "perlandera", service_id: "90001", service_day: "2026-11-22",
      service_name: null, zone: null, result_seen: true },
}));

describe.each([["b1", "B1 Church", "Cedar Hollow Fellowship"], ["breeze", "Breeze", "Perlandera Fictional Church"]] as const)("a Mac set up on %s, with jobs", (system, name, church) => {
  it("sets up Keep services covered and the morning briefing from Keeping watch, and Today shows them in the system's name", async () => {
    seed(system);
    if (system === "breeze") native.capture = JSON.stringify(breezeUntimedCapture());
    const app = await launch();
    await app.waitFor(`${name}: ${church}`);
    // Keep services covered: offered under the system's own regular check, confirmed once.
    await app.go("Keeping watch");
    await app.waitFor("Set up Keep services covered");
    expect(dom.seen()).not.toMatch(/(?:jobs|morning briefing)[^.]*only for now/u);
    await app.press("Set up Keep services covered");
    expect(dom.seen()).toContain(`${name}, ${church}. Reads only.`);
    await app.press("Looks good — start it");
    // Its card takes the offer's place under the system's regular check.
    await app.waitFor("Keeping an eye on it");
    // Its first check is the system's own read (shared from the one Ozzie made when it opened, or read again), never Planning Center's.
    for (let i = 0; i < 20 && !native.calls.some(([c]) => c === "responsibility_run_end"); i++) await app.settle(5);
    const commands = native.calls.map(([c]) => c);
    expect(commands).toContain("responsibility_create");
    expect(native.calls.find(([c]) => c === "responsibility_run_begin")?.[1]).toMatchObject({ trigger: "start" });
    expect(native.calls.find(([c]) => c === "responsibility_run_end")?.[1]).toMatchObject({ outcome: "ok" });
    expect(commands).not.toContain("check_sunday");
    expect(commands).not.toContain("agent_step");
    // The morning briefing, from Set up something new: only the jobs this system can run are offered.
    await app.go("Keeping watch");
    await app.press("Set up something new");
    expect(dom.seen()).not.toContain("Watch room bookings");
    expect(dom.seen()).toContain(`Watching room bookings, follow-ups and group meetings works with Planning Center only for now. Ozzie can't do this with ${name} yet.`);
    await app.press("Morning briefing");
    await app.press("Looks good — start it");
    for (let i = 0; i < 40 && native.calls.filter(([c]) => c === "responsibility_run_end").length < 2; i++) await app.settle(5);
    expect(native.calls.filter(([c]) => c === "responsibility_run_end")).toHaveLength(2);
    await app.go("Keeping watch");
    const watch = dom.seen();
    expect(watch).toContain(`${name}, ${church}`);
    expect(watch).toContain("Checks used1 of 6 in the last 24 hours.");
    expect(misnamed(watch)).toEqual([]);
    // Today: the jobs under In progress, the briefing ready to review, the preview, and the spoken briefing.
    await app.go("Today");
    await app.waitFor("Your morning briefing is ready.");
    const today = dom.seen();
    expect(today).toContain("In progress");
    expect(today).toContain("Ready to review");
    expect(today).toContain("Keep services coveredNext check");
    expect(today).toContain("Listen to today's briefing");
    expect(today).not.toMatch(/jobs work with Planning Center only/u);
    if (system === "breeze") expect(today).toContain("Breeze doesn't share how many people each role needs, so Ozzie can't say whether this Sunday is covered.");
    expect(misnamed(today)).toEqual([]);
    await app.press("Preview this briefing");
    expect(dom.seen()).toContain("Hide the preview");
    expect(misnamed(dom.seen())).toEqual([]);
    // Nothing a job did read Planning Center or asked an AI.
    expect(native.calls.map(([c]) => c).filter(c => c === "check_sunday" || c === "agent_step" || c === "responsibility_agent_step")).toEqual([]);
  }, 60_000);
});

describe("a job set up for another church, on a Mac now on B1 Church (owner decision 2026-11-22)", () => {
  /** Keep services covered, confirmed for Harbor on Planning Center and running, as this Mac kept it before the switch. */
  const seedJob = () => {
    const plan = defaultPlan("keep-sunday-covered", "2026-11-19T15:00:00Z", "America/New_York");
    native.jobs = [{ ...plan, id: "00000000-0000-4000-8000-0000000000f1", title: "Keep Sunday covered", skill_id: "sunday-ready", status: "active",
      created_at: "2026-11-19T15:00:00Z", confirmed_at: "2026-11-19T15:00:00Z", runs: [], open_run: null }];
    kept.set("ozzie.responsibilities.churches.v1", JSON.stringify({ "00000000-0000-4000-8000-0000000000f1": { church: "1001", name: "Harbor Example Church", system: "planning-center" } }));
  };
  const QUESTION = "Keep services covered was set up for Harbor Example Church on Planning Center. Keep it for Cedar Hollow Fellowship on B1 Church?";

  it("pauses it and asks once, on Today and Keeping watch; Yes keeps it for Cedar Hollow, says so on the status line, and its first check tells nothing", async () => {
    seed("b1");
    seedJob();
    const app = await launch();
    await app.waitFor(QUESTION);
    expect(native.calls.map(([c]) => c)).toContain("responsibility_pause");
    expect(native.calls.filter(([c]) => c === "responsibility_run_begin")).toEqual([]);
    expect(dom.seen()).toMatch(/Needs your attention\d/u);
    await app.go("Keeping watch");
    expect(dom.seen()).toContain(QUESTION);
    expect(dom.seen()).not.toContain("Set up Keep services covered");
    await app.press("Yes, keep it for Cedar Hollow Fellowship");
    for (let i = 0; i < 20 && !native.calls.some(([c]) => c === "responsibility_run_end"); i++) await app.settle(5);
    expect(dom.seen()).toContain("Keep services covered keeps an eye on Cedar Hollow Fellowship now.");
    expect(dom.seen()).not.toContain(QUESTION);
    expect(native.calls.map(([c]) => c)).toContain("responsibility_resume");
    expect(native.calls.find(([c]) => c === "responsibility_edit")?.[1]).toMatchObject({ plan: { zone: "America/Chicago" } });
    expect(native.calls.find(([c]) => c === "responsibility_run_begin")?.[1]).toMatchObject({ trigger: "start" });
    expect(native.calls.map(([c]) => c)).not.toContain("notify_ozzie");
    expect(JSON.parse(storage.getItem("ozzie.responsibilities.churches.v1")!)).toEqual({ "00000000-0000-4000-8000-0000000000f1": { church: "b1:CHU0000cedar", name: "Cedar Hollow Fellowship", system: "b1" } });
  }, 60_000);

  it("No stops it, from Today, and says so", async () => {
    seed("b1");
    seedJob();
    const app = await launch();
    await app.waitFor(QUESTION);
    await app.press("No, stop it");
    expect(dom.seen()).toContain("Keep services covered is stopped.");
    expect(native.calls.map(([c]) => c)).toContain("responsibility_stop");
    expect(native.calls.filter(([c]) => c === "responsibility_run_begin")).toEqual([]);
  }, 60_000);
});
