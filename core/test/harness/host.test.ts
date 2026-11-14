import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolFailure } from "../../src/broker.js";
import { HARNESS_LIMITS, type AgentTask, type Skill } from "../../src/harness/contract.js";
import { bundledSkills } from "../../src/harness/bundled-skills.js";
import { HarnessHost } from "../../src/harness/host.js";
import { HarnessSession } from "../../src/harness/session.js";
import { HarnessTools, type HarnessData } from "../../src/harness/tools.js";
import { harnessData } from "./fixtures.js";

const skills = await bundledSkills();
const task = (skill_id: string, over: Partial<AgentTask> = {}): AgentTask => ({ id: "t", kind: "skill", skill_id, workspace_id: "w", created_at: "2026-11-20T15:00:00Z", ...over });
const hostFor = (data: HarnessData = harnessData(), extra: Skill[] = []) => {
  const tools = new HarnessTools(data, new HarnessSession(), { now: () => "2026-11-20T15:05:00Z" });
  const all = new Map(skills);
  for (const s of extra) all.set(s.id, s);
  return { tools, host: new HarnessHost({ workspace_id: "w", tools, skills: all }) };
};
const names = (host: HarnessHost, t: AgentTask) => host.admitted(t).map(s => s.name);
const signal = () => new AbortController().signal;
afterEach(() => { vi.useRealTimers(); });

describe("what a task is admitted", () => {
  it("is the skill's tools, in its order", () => {
    const { host } = hostFor();
    expect(names(host, task("who-could-help"))).toEqual(["sunday.open_needs", "sunday.who_could_help", "drafts.prepare_note"]);
    expect(names(host, task("room-check"))).toEqual(["rooms.conflicts", "rules.current", "sunday.not_checked"]);
  });

  it("leaves out Calendar, People and Groups tools unless the connection was granted them", () => {
    const { host } = hostFor(harnessData({ granted: ["services"] }));
    expect(names(host, task("room-check"))).toEqual(["rules.current", "sunday.not_checked"]);
    expect(names(host, task("answer-from-what-was-read", { kind: "ask", question: "?" }))).not.toEqual(expect.arrayContaining(["rooms.conflicts"]));
    expect(names(host, task("group-night"))).toEqual(["sunday.not_checked"]);
  });

  it("offers a Planning Center refresh only with a usable connection and a skill that lists it", () => {
    expect(names(hostFor().host, task("sunday-ready"))).not.toContain("planning_center.refresh");
    const connected = hostFor(harnessData({ connected: true, refresh: async () => harnessData() })).host;
    expect(names(connected, task("sunday-ready"))[0]).toBe("planning_center.refresh");
    expect(names(connected, task("answer-from-what-was-read", { kind: "ask", question: "?" }))).not.toContain("planning_center.refresh");
  });

  it("is nothing for an unknown skill, another workspace, or a tool outside the allowlist", () => {
    const rogue = { ...skills.get("who-could-help")!, id: "rogue", tools: ["email.send", "planning_center.update", "sunday.overview"] } as unknown as Skill;
    const { host } = hostFor(harnessData(), [rogue]);
    expect(names(host, task("send-everyone"))).toEqual([]);
    expect(names(host, task("who-could-help", { workspace_id: "other" }))).toEqual([]);
    expect(names(host, task("rogue"))).toEqual(["sunday.overview"]);
  });
});

describe("running a tool", () => {
  it("returns the tool's envelope for an admitted call", async () => {
    const { host, tools } = hostFor();
    const r = await host.run(task("who-could-help"), "sunday.open_needs", {}, signal());
    expect(r.ok && r.envelope).toEqual(await tools.run("sunday.open_needs", {}, signal()));
  });

  it("denies a tool the task wasn't admitted, a write-like name, another workspace, and never runs it", async () => {
    let refreshed = 0;
    const { host } = hostFor(harnessData({ refresh: async () => { refreshed++; return harnessData(); } }));
    expect(await host.run(task("who-could-help"), "rooms.conflicts", {}, signal())).toEqual({ ok: false, error: "denied" });
    expect(await host.run(task("sunday-ready"), "planning_center.refresh", {}, signal())).toEqual({ ok: false, error: "denied" });
    expect(refreshed).toBe(0);
    for (const name of ["planning_center.update", "email.send", "shell.exec", ""]) expect(await host.run(task("who-could-help"), name, {}, signal())).toEqual({ ok: false, error: "denied" });
    expect(await host.run(task("who-could-help", { workspace_id: "other" }), "sunday.open_needs", {}, signal())).toEqual({ ok: false, error: "denied" });
  });

  it("denies arguments that don't fit the schema or name a label this session never issued", async () => {
    const { host } = hostFor();
    const t = task("who-could-help");
    await host.run(t, "sunday.open_needs", {}, signal());
    for (const args of [{}, { role: 1 }, { role: "Greeter" }, { role: "[Role 1]", extra: true }, { role: "[Role 99]" }, { role: "[Person 1]" }]) {
      expect(await host.run(t, "sunday.who_could_help", args as Record<string, unknown>, signal()), JSON.stringify(args)).toEqual({ ok: false, error: "denied" });
    }
    expect((await host.run(t, "sunday.who_could_help", { role: "[Role 1]" }, signal())).ok).toBe(true);
  });

  it("gives up after toolMs, aborting the tool's signal, as a provider failure", async () => {
    vi.useFakeTimers();
    let seen: AbortSignal | null = null;
    const { host } = hostFor(harnessData({ mode: "recording", connected: true, refresh: s => { seen = s; return new Promise(() => {}); } }));
    const pending = host.run(task("sunday-ready"), "planning_center.refresh", {}, signal());
    await vi.advanceTimersByTimeAsync(HARNESS_LIMITS.toolMs);
    expect(await pending).toEqual({ ok: false, error: "provider-failure" });
    expect(seen!.aborted).toBe(true);
  });

  it("maps a cancelled task to unverified and failures to the contract's codes", async () => {
    const stopped = new AbortController();
    stopped.abort();
    expect(await hostFor().host.run(task("who-could-help"), "sunday.open_needs", {}, stopped.signal)).toEqual({ ok: false, error: "unverified" });
    const cancelling = new AbortController();
    const slow = hostFor(harnessData({ mode: "recording", connected: true, refresh: () => new Promise(() => {}) })).host;
    const pending = slow.run(task("sunday-ready"), "planning_center.refresh", {}, cancelling.signal);
    cancelling.abort();
    expect(await pending).toEqual({ ok: false, error: "unverified" });
    const stale = hostFor(harnessData({ mode: "recording", connected: true, refresh: () => Promise.reject(new ToolFailure("stale")) })).host;
    expect(await stale.run(task("sunday-ready"), "planning_center.refresh", {}, signal())).toEqual({ ok: false, error: "stale" });
    const broken = hostFor(harnessData({ mode: "recording", connected: true, refresh: () => { throw new TypeError("boom"); } })).host;
    expect(await broken.run(task("sunday-ready"), "planning_center.refresh", {}, signal())).toEqual({ ok: false, error: "provider-failure" });
  });
});

describe("review 2026-11-14 regressions", () => {
  it("allows one Planning Center refresh per task (B-S8: the review ran ten in one task)", async () => {
    let refreshed = 0;
    const refresh = async (): Promise<HarnessData> => { refreshed++; return harnessData({ mode: "recording", connected: true, refresh }); };
    const { host } = hostFor(harnessData({ mode: "recording", connected: true, refresh }));
    const t = task("sunday-ready", { id: "a" });
    expect((await host.run(t, "planning_center.refresh", {}, signal())).ok).toBe(true);
    for (let i = 0; i < 9; i++) expect(await host.run(t, "planning_center.refresh", {}, signal())).toEqual({ ok: false, error: "denied" });
    expect(refreshed).toBe(1);
    expect((await host.run(task("sunday-ready", { id: "b" }), "planning_center.refresh", {}, signal())).ok).toBe(true);
    expect(refreshed).toBe(2);
  });

  it("binds the broker to the service type it was set up for, not to whatever check it reads later (N7)", async () => {
    const { host, tools } = hostFor();
    expect((await host.run(task("who-could-help"), "sunday.open_needs", {}, signal())).ok).toBe(true);
    const other = harnessData();
    tools.update({ ...other, capture: { ...other.capture!, service_type_id: "9999" } });
    expect(await host.run(task("who-could-help"), "sunday.open_needs", {}, signal())).toEqual({ ok: false, error: "denied" });
    const configured = new HarnessHost({ workspace_id: "w", tools: new HarnessTools(harnessData(), new HarnessSession()), skills, serviceTypes: ["9999"] });
    expect(await configured.run(task("who-could-help"), "sunday.open_needs", {}, signal())).toEqual({ ok: false, error: "denied" });
  });

  it("removes the listener it adds to the task's signal (N7)", async () => {
    const { host } = hostFor();
    const controller = new AbortController();
    const added: unknown[] = [], removed: unknown[] = [];
    const add = controller.signal.addEventListener.bind(controller.signal), remove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.addEventListener = ((type: string, fn: EventListener, o?: AddEventListenerOptions) => { added.push(fn); add(type, fn, o); }) as typeof add;
    controller.signal.removeEventListener = ((type: string, fn: EventListener, o?: EventListenerOptions) => { removed.push(fn); remove(type, fn, o); }) as typeof remove;
    for (let i = 0; i < 3; i++) expect((await host.run(task("who-could-help"), "sunday.open_needs", {}, controller.signal)).ok).toBe(true);
    expect(added.length).toBeGreaterThan(0);
    expect(added.every(fn => removed.includes(fn))).toBe(true);
  });
});
