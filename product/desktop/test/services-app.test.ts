// More than one service watched, through the whole app (owner decision 2026-11-19): first run picks one service by itself
// as always; "Watch another service" on the Services page adds a second; one round reads both; the Services page shows
// each in date order with its own name and findings; the sidebar, Today and the page say the same count across both;
// "Stop watching" says what it forgets, deletes only that service's saved checks, and the count goes back. Fictional data
// only, on a fake native side.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeDom } from "./fake-dom.js";
import { nov22Capture } from "../../../core/src/fictional-sunday.js";
import { wednesdayCapture } from "../../../core/test/fixtures/service-days/wednesday.js";
import { pickReply, SUNDAY_MORNING, YOUTH_NIGHT } from "./onboarding-fakes.js";

const ORG = "1001";
const native = vi.hoisted(() => ({
  status: null as Record<string, unknown> | null, pick: null as unknown, calls: [] as [string, Record<string, unknown>][],
  recordings: [] as { organization: string; plan_id: string; completed_at: string; path_id: string }[],
  /** Youth Night's teams with ids of their own, as Planning Center gives each service type its own teams (same roles). */
  ownTeams: false,
  /** Changes in Planning Center turned on for the church (native `changes_status`); otherwise that call never answers. */
  changes: false,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args: Record<string, unknown> = {}) => {
    native.calls.push([command, args]);
    switch (command) {
      case "connection_status": return native.status;
      case "check_saved_connection": return native.status;
      case "dev_defaults": return { clientId: "", organization: "", serviceTypeId: "", planId: "", autopilot: false };
      case "planning_center_app": return true;
      case "connect_planning_center_app": native.status = { state: "waiting", organization: "", checked_at_ms: null, source: "", problem: null }; return native.status;
      case "list_sunday_recordings": return native.recordings.filter(r => r.organization === args.organization);
      case "pick_service": return native.pick;
      case "changes_status": return native.changes ? { organization: ORG, on: true } : new Promise(() => {});
      // One change got ready, as native answers after reading Planning Center again: for the plan asked about, on its day.
      case "change_prepare": {
        const youth = args.plan === "94000001";
        return { change: youth ? "b".repeat(32) : "a".repeat(32), plan: args.plan, team: args.team, person: args.person, position: args.position,
          sunday: youth ? "2026-11-25" : "2026-11-22", times: [{ starts_at: youth ? "2026-11-26T00:00:00Z" : "2026-11-22T14:30:00Z", ends_at: youth ? "2026-11-26T01:30:00Z" : "2026-11-22T15:30:00Z" }],
          still_needed: 1, kids_team: false, advised_against: false, checked_at: new Date().toISOString(), expires_at: new Date(Date.now() + 5 * 60_000).toISOString() };
      }
      case "check_sunday": {
        const plan = String(args.planId);
        // The first service is the fictional Sunday; Youth Night's plan is the fictional Wednesday, of its own service type.
        const wednesday = native.ownTeams ? JSON.parse(JSON.stringify(wednesdayCapture()).replace(/"75933(5[024])"/gu, '"86044$1"')) as ReturnType<typeof wednesdayCapture> : wednesdayCapture();
        const base = plan === "92902197" ? nov22Capture() : { ...wednesday, service_type_id: String(args.serviceTypeId) };
        const c = { ...base, plan_id: plan, completed_at: new Date().toISOString() };
        native.recordings.unshift({ organization: ORG, plan_id: plan, completed_at: c.completed_at, path_id: `sunday-${ORG}-${plan}-${Date.now()}.json` });
        return c;
      }
      case "delete_sunday_plan_recordings": {
        const plans = args.planIds as string[];
        native.recordings = native.recordings.filter(r => r.organization !== args.organization || !plans.includes(r.plan_id));
        return null;
      }
      case "background_info": return { fastSchedule: false, probe: false, tickMs: 30_000 };
      case "update_status": return null;
      case "notification_permission": return "unknown";
      case "model_status": return { configured: false, route: "none", label: "", setup: "no-route" };
      case "responsibility_list": throw "unavailable";
      case "set_no_ai": return { configured: false, route: "none", label: "", setup: "no-route" };
      case "own_key_providers": return [];
      case "managed_offer": return { open: false, reason: "closed" };
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
type Node = { tagName?: string; textContent: string; childNodes: unknown[]; getAttribute?: (a: string) => string | null };
const all = (n: { childNodes: unknown[] }): Node[] => [n as Node, ...n.childNodes.flatMap(c => all(c as { childNodes: unknown[] }))];
const nodes = () => all(dom.root as unknown as { childNodes: unknown[] });
const CONNECTED = { state: "connected", organization: ORG, checked_at_ms: Date.parse("2026-11-20T15:00:00Z"), source: "Planning Center /oauth/userinfo", problem: null,
  found: true, found_at_ms: Date.parse("2026-11-20T15:00:00Z"), in_use: { organization: ORG, client_id: "", name: "Fictional Grace Church" }, organization_name: "Fictional Grace Church" };

let unmount: (() => Promise<void>) | null = null;
beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); vi.setSystemTime(new Date("2026-11-20T15:00:00Z")); native.status = null; native.pick = null;
  native.calls = []; native.recordings = []; native.ownTeams = false; native.changes = false; kept.clear(); });
afterEach(async () => { await unmount?.(); unmount = null; vi.useRealTimers(); });

type Mounted = { settle: (n?: number) => Promise<void>; act: (f: () => Promise<void>) => Promise<void> };
async function launch(): Promise<Mounted> {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { App } = await import("../src/App.js");
  const root = createRoot(dom.root as unknown as Element);
  await act(async () => { root.render(React.createElement(App)); });
  const settle = async (n = 30) => { for (let i = 0; i < n; i++) await act(async () => { await tick(); }); };
  await settle();
  unmount = async () => { await act(async () => { root.unmount(); }); };
  return { settle, act };
}
async function press(app: Mounted, label: string) {
  const b = dom.button(label) ?? nodes().find(n => n.tagName === "BUTTON" && (n.textContent ?? "").startsWith(label)) as Parameters<typeof dom.press>[0] | undefined;
  if (!b) throw new Error(`no button "${label}" in: ${dom.seen().slice(0, 900)}`);
  await app.act(async () => { dom.press(b as Parameters<typeof dom.press>[0]); await tick(); });
  await app.settle();
}
async function waitFor(app: Mounted, text: string, rounds = 40) {
  const { act } = await import("react");
  for (let i = 0; i < rounds && !dom.seen().includes(text); i++) { await act(async () => { await vi.advanceTimersByTimeAsync(500); }); await app.settle(5); }
  if (!dom.seen().includes(text)) throw new Error(`never saw "${text}" in: ${dom.seen().slice(0, 1200)}`);
}
/** Lets time pass until Youth Night's plan has been read and is on the page (it is read a moment after it is added). */
async function youthRead(app: Mounted) {
  const { act } = await import("react");
  for (let i = 0; i < 40 && !(checked().includes("94000001") && !dom.seen().includes("Youth Night hasn't been checked yet")); i++) {
    await act(async () => { await vi.advanceTimersByTimeAsync(500); }); await app.settle(5);
  }
  expect(checked()).toContain("94000001");
}
async function go(app: Mounted, label: string) {
  const a = nodes().find(n => n.tagName === "A" && n.textContent.startsWith(label)) as unknown as Record<string, { onClick?: (e: unknown) => void }>;
  const props = a[Object.keys(a).find(k => k.startsWith("__reactProps$"))!];
  await app.act(async () => { props?.onClick?.({ preventDefault() {} }); await tick(); });
  await app.settle();
}
/** The sidebar's number beside Services (things to decide), or 0 when it shows none. */
const badge = () => {
  const link = nodes().find(n => n.tagName === "A" && n.getAttribute?.("href") === "#sunday");
  const count = link ? all(link as unknown as { childNodes: unknown[] }).find(n => n.getAttribute?.("class") === "count") : undefined;
  return count ? Number(/^\d+/u.exec(count.textContent)![0]) : 0;
};
const checked = () => native.calls.filter(([c]) => c === "check_sunday").map(([, a]) => a.planId);

/**
 * First run as a church with one service: connect, Allow, the service picked by itself and read, then No AI for now.
 * `scopes`: what the sign-in was granted (People too lets the change be offered).
 */
async function oneService(scopes?: string) {
  native.pick = pickReply(SUNDAY_MORNING);
  const app = await launch();
  if (dom.seen().includes("What does your church use?")) await press(app, "Planning Center");
  await press(app, "Connect Planning Center");
  if (dom.button("Open Planning Center in my browser")) await press(app, "Open Planning Center in my browser");
  native.status = { ...CONNECTED, ...(scopes ? { scopes } : {}) };
  await waitFor(app, "Next: choose how Ozzie uses AI");
  await press(app, "Next: choose how Ozzie uses AI");
  await waitFor(app, "No AI for now");
  await press(app, "No AI for now");
  return app;
}

describe("watching more than one service (owner decision 2026-11-19)", () => {
  it("first run picks one as always; Watch another service adds a second, read with the first, and every count says both", async () => {
    const app = await oneService();
    expect(checked()).toEqual(["92902197"]);
    await go(app, "Services");
    const one = dom.seen();
    const single = badge();
    expect(single).toBeGreaterThan(0);
    // One service: the page as before, and the offer to watch another at its end.
    expect(one).toContain("Are your services covered?");
    expect(one).not.toContain("across 2 services");
    expect(one).toContain("Which services Ozzie watches");
    native.pick = pickReply(SUNDAY_MORNING, YOUTH_NIGHT);
    await press(app, "Watch another service");
    await waitFor(app, "Watch Youth Night");
    // The service already watched isn't offered again.
    expect(dom.button("Watch Sunday Morning")).toBeNull();
    await press(app, "Watch Youth Night");
    await youthRead(app);
    // One round: the first service, then Youth Night's next plan.
    expect(checked().slice(-2)).toEqual(["92902197", "94000001"]);
    const page = dom.seen();
    // Each service under its own name, in date order (Sunday before Wednesday), with its own findings.
    const heads = nodes().filter(n => n.tagName === "H2" && (n.getAttribute?.("class") ?? "") === "h2").map(n => n.textContent);
    expect(heads).toEqual(["Sunday Morning", "Youth Night"]);
    expect(page.indexOf("Sunday Morning")).toBeLessThan(page.indexOf("Youth Night"));
    expect(page).toContain("Room bookings and group meetings aren't checked for this service. Follow-ups without an owner are shown with Sunday Morning.");
    // Each service's cards say its own day under More choices (polish 2026-11-21, item 2).
    const youth = page.slice(page.indexOf("Youth Night", page.indexOf("Sunday Morning") + 1));
    expect(page.slice(0, page.indexOf("Youth Night", page.indexOf("Sunday Morning") + 1))).toContain("For this Sunday only:Covered outside Planning CenterNot needed this Sunday");
    expect(youth).toContain("For this Wednesday only:Covered outside Planning CenterNot needed this Wednesday");
    expect(youth).not.toContain("this Sunday");
    // What the check is and when it was read is said once, above both services, with the one Check button.
    expect(page.match(/Live read from Planning Center Services/gu)).toHaveLength(1);
    expect(page.indexOf("Live read from Planning Center Services")).toBeLessThan(page.indexOf("Sunday Morning"));
    expect(nodes().filter(n => n.tagName === "BUTTON" && n.textContent === "Check Planning Center now")).toHaveLength(1);
    // The same number on the page, the sidebar and Today, now across both services.
    const both = badge();
    expect(both).toBeGreaterThan(single);
    expect(page).toMatch(new RegExp(`${both} things need a decision across 2 services`, "u"));
    await go(app, "Today");
    expect(dom.seen()).toContain(`Your services have ${both} things to decide.`);
    // Nothing of either service's people is kept by name in what the list keeps on this Mac.
    const list = kept.get("ozzie.also-watched.v1")!;
    for (const name of Object.values(nov22Capture().names)) expect(list).not.toContain(name);
  }, 120_000);

  it("the first result shown again names the other service and says the one count (coordinator's live read of 0.5.0)", async () => {
    const app = await oneService();
    await go(app, "Services");
    const single = badge();
    native.pick = pickReply(SUNDAY_MORNING, YOUTH_NIGHT);
    await press(app, "Watch another service");
    await waitFor(app, "Watch Youth Night");
    await press(app, "Watch Youth Night");
    await youthRead(app);
    const both = badge();
    expect(both).toBeGreaterThan(single);
    // Step 3 of 3 again, as signing in again shows it: the first service's own answer, then the other service and the total.
    await go(app, "Settings");
    await press(app, "Walk through setup again");
    await waitFor(app, "so your services have");
    const t = dom.seen();
    expect(t).toContain("Ozzie is watching Sunday, November 22");
    expect(t).toContain(`${single} things need a decision for Sunday, November 22.`);
    expect(t).toContain(`And ${both - single} more for Youth Night on Wednesday, November 25, so your services have ${both} things to decide in all.`);
    expect(t).toContain("You'll see every service on the Services page.");
  }, 120_000);

  it("Church rules and the kids question name each team's service, so two teams with the same roles are told apart (polish 2026-11-21, item 1)", async () => {
    native.ownTeams = true;
    const app = await oneService();
    await go(app, "Church rules");
    // One service: the teams as before, with no service named.
    expect(dom.seen()).toContain("Greeter team");
    expect(dom.seen()).not.toContain("Greeter team ·");
    await go(app, "Services");
    native.pick = pickReply(SUNDAY_MORNING, YOUTH_NIGHT);
    await press(app, "Watch another service");
    await waitFor(app, "Watch Youth Night");
    await press(app, "Watch Youth Night");
    await youthRead(app);
    await go(app, "Church rules");
    const rules = dom.seen();
    // Scheduled leads and Kids teams: every team row says its service; none reads the same as another.
    for (const label of ["Greeter team · Sunday Morning", "Greeter team · Youth Night", "Nursery team · Sunday Morning", "Nursery team · Youth Night"]) {
      expect(rules, label).toContain(label);
    }
    const labels = nodes().filter(n => n.tagName === "LABEL").map(n => n.textContent).filter(t => / team(?: ·|$)/u.test(t));
    expect(labels).toContain("Greeter team · Youth Night");
    expect(labels).toContain("Greeter team · Youth Night serves with kids");
    expect(labels).toContain("Greeter team · Sunday Morning serves with kids");
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels.some(t => /^Greeter team(?: serves with kids)?$/u.test(t))).toBe(false);
    // The kids question on the Services page says which service's Nursery it asks about.
    await go(app, "Services");
    expect(dom.seen()).toMatch(/Does Nursery \((?:Sunday Morning|Youth Night)\) serve with kids\?/u);
  }, 120_000);

  it("Stop watching says what it forgets, deletes only that service's saved checks, and the count goes back", async () => {
    const app = await oneService();
    await go(app, "Services");
    const single = badge();
    native.pick = pickReply(SUNDAY_MORNING, YOUTH_NIGHT);
    await press(app, "Watch another service");
    await waitFor(app, "Watch Youth Night");
    await press(app, "Watch Youth Night");
    await youthRead(app);
    expect(native.recordings.some(r => r.plan_id === "94000001")).toBe(true);
    await press(app, "Stop watching");
    expect(dom.seen()).toContain("Stop watching Youth Night? Ozzie forgets its saved checks and your decisions for it on this Mac. Planning Center doesn't change.");
    // Nothing is deleted until the person says so.
    expect(native.calls.some(([c]) => c === "delete_sunday_plan_recordings")).toBe(false);
    await press(app, "Yes, stop watching it");
    await app.settle();
    expect(native.calls.filter(([c]) => c === "delete_sunday_plan_recordings").map(([, a]) => a)).toEqual([{ organization: ORG, planIds: ["94000001"] }]);
    expect(native.recordings.map(r => r.plan_id)).not.toContain("94000001");
    expect(native.recordings.map(r => r.plan_id)).toContain("92902197");
    expect(dom.seen()).not.toContain("across 2 services");
    expect(badge()).toBe(single);
    // The next round reads the first service only.
    const before = checked().length;
    await press(app, "Check Planning Center now");
    await app.settle();
    expect(checked().slice(before)).toEqual(["92902197"]);
  }, 120_000);
});

describe("the add confirmation names the service it adds to, the first one too (polish 3, item 3; write-back review L1)", () => {
  const RILEY = "Add Riley to Greeter in Planning Center…";
  /** The Add buttons for Riley on Greeter, in page order: the first service's part first (parts are in date order). */
  const addRiley = () => nodes().filter(n => n.tagName === "BUTTON" && n.textContent === RILEY);
  const title = () => nodes().find(n => n.tagName === "H4" && (n.getAttribute?.("class") ?? "").split(" ").includes("change-title"))?.textContent ?? null;
  /** Presses one of those buttons and waits for its confirmation; returns its title, then closes it with Don't add. */
  async function confirmation(app: Mounted, at: number): Promise<string | null> {
    const button = addRiley()[at];
    if (!button) throw new Error(`no "${RILEY}" #${at} in: ${dom.seen().slice(0, 900)}`);
    await app.act(async () => { dom.press(button as unknown as Parameters<typeof dom.press>[0]); await tick(); });
    await waitFor(app, "Don't add Riley");
    const shown = title();
    await press(app, "Don't add Riley");
    return shown;
  }

  it("with one service, the title names that service and its day", async () => {
    native.changes = true;
    const app = await oneService("services-and-operations");
    await go(app, "Services");
    await waitFor(app, RILEY);
    expect(await confirmation(app, 0)).toBe("Add Riley Thornbury to the Sunday Morning plan for Sunday, Nov 22?");
  }, 120_000);

  it("with two, the first chosen by ids only (Settings' picker before): Watch another service learns its name, and each title names its own", async () => {
    native.changes = true;
    await oneService("services-and-operations");
    // As a plan chosen in Settings' picker before this kept its name: the first service's ids and day, and no name; then
    // Ozzie is opened again.
    const kept0 = JSON.parse(kept.get("ozzie.watched-day.v1")!) as Record<string, unknown>;
    kept.set("ozzie.watched-day.v1", JSON.stringify({ ...kept0, service: null }));
    await unmount!();
    const app = await launch();
    await go(app, "Services");
    if (!dom.seen().includes(RILEY)) await press(app, "Check Planning Center now");
    await waitFor(app, RILEY);
    expect(await confirmation(app, 0)).toBe("Add Riley Thornbury to the plan for Sunday, Nov 22?");
    native.pick = pickReply(SUNDAY_MORNING, YOUTH_NIGHT);
    await press(app, "Watch another service");
    await waitFor(app, "Watch Youth Night");
    await press(app, "Watch Youth Night");
    await youthRead(app);
    // The list of services read for Watch another service named the first one too: kept on this Mac, and shown.
    expect(JSON.parse(kept.get("ozzie.watched-day.v1")!)).toMatchObject({ planId: "92902197", service: "Sunday Morning" });
    const heads = nodes().filter(n => n.tagName === "H2" && (n.getAttribute?.("class") ?? "") === "h2").map(n => n.textContent);
    expect(heads).toEqual(["Sunday Morning", "Youth Night"]);
    expect(addRiley()).toHaveLength(2);
    expect(await confirmation(app, 0)).toBe("Add Riley Thornbury to the Sunday Morning plan for Sunday, Nov 22?");
    expect(await confirmation(app, 1)).toBe("Add Riley Thornbury to the Youth Night plan for Wednesday, Nov 25?");
    // Each Add asked native code for its own plan only.
    expect(native.calls.filter(([c]) => c === "change_prepare").map(([, a]) => a.plan)).toEqual(["92902197", "92902197", "94000001"]);
  }, 120_000);
});
