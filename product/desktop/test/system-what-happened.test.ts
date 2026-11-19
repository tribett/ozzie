// What happened for a church on B1 Church or Breeze: each check of it is a task in the ledger like Planning Center's,
// named by the system it read (kept beside it on this Mac; the ledger itself names no tool for it), and quiet checks in a
// row fold into one line in that system's name. The app's own wiring: the system's schedule, the ledger recorder and the
// store What happened reads. Fictional fixed data only; the native side is faked.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { ActivityPage, RecentWork } from "../src/activity-page.js";
import { desktopRecorder, LedgerRecorder, localTriggers, systemCheckFailure } from "../src/harness-bridge.js";
import { quietCheck, quietChecksLine, stepText, taskAccount, taskLine, type TaskEventRow, type TaskRow } from "../src/harness-words.js";
import { SystemReadFailure } from "../src/proactive.js";
import { readSystem } from "../src/system-church.js";
import { desktopSystemProactive } from "../src/system-watch.js";
import type { SystemConnection } from "../src/church-system.js";
import type { SundayRules } from "../../../core/src/sunday-capture.js";
import { B1_READS, b1Capture, BREEZE_READS, breezeUntimedCapture, readsOf } from "../../../core/test/church-systems/fixtures.js";
import type { ReadOutcome } from "../../../core/src/church-systems/types.js";
import { row } from "./harness-fakes.js";

const rules: SundayRules = { sundayLeads: [], checkInAfterSundaysInARow: 3 };
const B1: SystemConnection = { system: "b1", church_id: "CHU0000cedar", church_name: "Cedar Hollow Fellowship", address: "cedarhollow", service_id: "PLA0000nov22",
  service_day: "2026-11-22", service_name: "Sunday Gathering", zone: "America/Chicago", result_seen: true };
const ev = (type: TaskEventRow["type"], detail = ""): TaskEventRow => ({ task_id: "t", sequence: 0, at: "x", type, detail });
/** A finished check as the ledger lists it: its one read, by how complete it was and no tool name. */
const checkRow = (task_id: string, at: string, read = "complete"): TaskRow => row({ task_id, kind: "check", state: "verified", created_at: at, updated_at: at,
  events: [ev("admitted"), ev("running"), ev("tool", read), ev("verified")] });

describe("a church on B1 Church, on What happened", () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); invoke.mockReset(); });

  it("records each check as a task beside the system it read, and folds the quiet ones in that system's name", async () => {
    const local = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => local.get(k) ?? null, setItem: (k: string, v: string) => { local.set(k, v); }, removeItem: (k: string) => { local.delete(k); } });
    vi.useFakeTimers({ toFake: ["Date"] });
    let declined = false;
    invoke.mockImplementation(async (command: string) => {
      if (command !== "church_system_check") return undefined;
      const at = new Date().toISOString().replace(/\.000Z$/u, "Z");
      const base = b1Capture();
      return { outcome: "ok", capture: JSON.stringify({ ...base, started_at: at, completed_at: at, reads: base.reads.map(r => ({ ...r, checked_at: at })),
        assignments: base.assignments.map(a => declined && a.id === "ASN-rowan" ? { ...a, status: "declined" } : a) }) };
    });
    const times = ["2026-11-20T15:00:00Z", "2026-11-20T16:00:00Z", "2026-11-20T17:00:00Z", "2026-11-20T18:00:00Z"];
    vi.setSystemTime(new Date(times[0]!));
    const p = desktopSystemProactive();
    const read = async () => { const r = await readSystem(B1); if (!r.capture) throw new SystemReadFailure("b1", r.outcome); return r.capture; };
    p.start({ context: () => ({ settings: { clientId: "", organization: "", serviceTypeId: "", planId: "" }, rules, status: null, system: { connection: B1, read } }),
      onStatus: () => {}, onCapture: () => {} });
    await p.tick();
    for (const [i, at] of times.slice(1).entries()) {
      vi.setSystemTime(new Date(at));
      declined = i === 2;
      await p.tick();
    }
    p.stop();
    await desktopRecorder().idle();
    // Every read went to B1 Church's own command, never to Planning Center's.
    expect(invoke.mock.calls.map(([c]) => c)).not.toContain("check_sunday");
    expect(invoke.mock.calls.filter(([c]) => c === "church_system_check")).toHaveLength(4);
    // The ledger is told only closed words: the read's event names no tool, and no name or church goes in.
    const admitted = invoke.mock.calls.filter(([c]) => c === "ledger_admit").map(([, a]) => (a as { taskId: string }).taskId);
    expect(admitted).toHaveLength(4);
    const ledger = JSON.stringify(invoke.mock.calls.filter(([c]) => String(c).startsWith("ledger_")));
    expect(ledger).not.toMatch(/Fictional|Cedar Hollow|church_system/u);
    const store = localTriggers({ getItem: k => local.get(k) ?? null, setItem: () => {} });
    expect(admitted.map(id => [store.get(id), store.found(id), store.source(id)])).toEqual([
      ["automatic", undefined, "b1"], ["automatic", "nothing-new", "b1"], ["automatic", "nothing-new", "b1"], ["automatic", "changes", "b1"]]);

    vi.useRealTimers();
    const tasks = admitted.map((task_id, i) => checkRow(task_id, times[i]!));
    const now = new Date(times.at(-1)!);
    const html = renderToStaticMarkup(React.createElement(RecentWork, { tasks, trigger: store.get, end: store.end, found: store.found, source: store.source, now }));
    expect(html).toContain(quietChecksLine([tasks[1]!, tasks[2]!], "B1 Church"));
    expect(quietChecksLine([tasks[1]!, tasks[2]!], "B1 Church")).toMatch(/^Checked B1 Church twice on its own, \S+ \S+ to \S+ \S+ · nothing new$/u);
    expect(html).toContain(taskLine(tasks[3]!, { trigger: "automatic", now, source: "B1 Church" }));
    expect(html).not.toContain("Planning Center");
  });

  it("says each check, its read and how it ended in the system's name", () => {
    const at = "2026-11-20T15:00:00Z";
    const now = new Date("2026-11-20T15:30:00Z");
    const done = checkRow("a", at);
    expect(taskLine(done, { trigger: "automatic", now, source: "B1 Church" })).toMatch(/^B1 Church check, on its own · /u);
    expect(taskLine(done, { trigger: "manual", now, source: "Breeze" })).toMatch(/^Breeze check you started · /u);
    const account = taskAccount(done, { start: "automatic", now, source: "B1 Church" });
    expect(account.started).toMatch(/^Ozzie checked B1 Church on its own at /u);
    expect(account.looked).toEqual(["Read the service from B1 Church — all of it"]);
    expect(account.ai).toBe("No AI was used: this was Ozzie's own check of B1 Church.");
    expect(stepText("tool", "partial", "check", "Breeze")).toMatch(/^Read the service from Breeze — /u);
    // A failed check: why, in plain words of that system.
    const failed = row({ task_id: "f", kind: "check", state: "failed", failure: "denied", created_at: at, updated_at: at, events: [ev("admitted"), ev("running"), ev("failed", "denied")] });
    expect(taskLine(failed, { trigger: "automatic", now, source: "B1 Church" })).toContain("Couldn't finish: the key Ozzie keeps for B1 Church wasn't there or wasn't accepted");
    expect(systemCheckFailure(new SystemReadFailure("b1", "key-refused"))).toBe("denied");
    expect(systemCheckFailure(new SystemReadFailure("breeze", "unreachable"))).toBe("provider-failure");
    expect(systemCheckFailure(new SystemReadFailure("b1", "locked"))).toBe("cancelled");
    // Folded only as that system's own complete check; a Planning Center check of the same shape isn't one of them.
    expect(quietCheck(done, "automatic", "nothing-new", "B1 Church")).toBe(true);
    expect(quietCheck(done, "automatic", "nothing-new")).toBe(false);
    expect(quietCheck(checkRow("p", at, "partial"), "automatic", "nothing-new", "B1 Church")).toBe(false);
    // Planning Center's own words are unchanged.
    expect(taskLine(row({ task_id: "pc", kind: "check", state: "verified", created_at: at, updated_at: at,
      events: [ev("admitted"), ev("running"), ev("tool", "planning_center.refresh complete"), ev("verified")] }), { trigger: "automatic", now })).toMatch(/^Planning Center check, on its own · /u);
  });

  it("records a B1 Church check as complete when only its forms list was cut short by design, and names a part that wasn't read", async () => {
    const local = new Map<string, string>();
    const store = { getItem: (k: string) => local.get(k) ?? null, setItem: (k: string, v: string) => { local.set(k, v); } };
    invoke.mockImplementation(async (command: string) => command === "ledger_admit" ? true : undefined);
    const recorder = new LedgerRecorder({ triggers: localTriggers(store), newId: () => `00000000-0000-4000-8000-00000000000${local.size}` });
    const reads = (over: Record<string, ReadOutcome>) => b1Capture({ reads: readsOf(B1_READS, over) });
    let ids: string[] = [];
    await recorder.checkSystem(async () => reads({ "b1.forms": "truncated" }), "b1", "automatic", id => { ids = [...ids, id]; });
    await recorder.checkSystem(async () => reads({ "b1.forms": "truncated", "b1.events": "timeout" }), "b1", "automatic", id => { ids = [...ids, id]; });
    await recorder.idle();
    const tools = invoke.mock.calls.filter(([c, a]) => c === "ledger_event" && (a as { kind: string }).kind === "tool")
      .map(([, a]) => (a as { detail: string }).detail);
    expect(tools).toEqual(["complete", "partial"]);
    const kept = localTriggers(store);
    expect(kept.parts(ids[0]!)).toBeUndefined();
    expect(kept.parts(ids[1]!)).toEqual(["events"]);
    // What happened says which part.
    const at = "2026-11-20T15:00:00Z";
    const row = checkRow(ids[1]!, at, "partial");
    const account = taskAccount(row, { start: "automatic", now: new Date("2026-11-20T15:30:00Z"), source: "B1 Church", unread: ["events"] });
    expect(account.looked).toEqual(["Read the service from B1 Church — part of it couldn't be read: events"]);
    expect(account.ended).toBe("Finished, though part of the check couldn't be read: events.");
  });

  it("lists a read cut short by design as read, in its own words, and a failed one as a problem (review of round 3, L6)", () => {
    const capture = b1Capture({ reads: readsOf(B1_READS, { "b1.forms": "truncated", "b1.events": "timeout" }) });
    const html = renderToStaticMarkup(React.createElement(ActivityPage, { capture: null, system: { name: "B1 Church", check: capture } }));
    const items = [...html.matchAll(/<li class="(is-problem)?">(.*?)<\/li>/gu)].map(m => ({ problem: !!m[1], text: m[2]!.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim() }));
    const forms = items.find(i => / Forms /u.test(` ${i.text} `))!;
    expect(forms).toMatchObject({ problem: false });
    expect(forms.text).toContain("Read: only the forms the person who made the key can manage");
    expect(items.find(i => /Events/u.test(i.text))).toMatchObject({ problem: true });
    // Only partly read when it isn't by design.
    const cut = b1Capture({ reads: readsOf(B1_READS, { "b1.blockouts": "truncated" }) });
    const cutHtml = renderToStaticMarkup(React.createElement(ActivityPage, { capture: null, system: { name: "B1 Church", check: cut } }));
    expect(cutHtml).toMatch(/<li class="is-problem">[^]*?Blockouts[^]*?Only partly read/u);
  });

  it("Breeze's check-ins, left until the service has ended, say so rather than \"not read this time\" (round 4)", () => {
    const capture = breezeUntimedCapture({ reads: readsOf([...BREEZE_READS, "breeze.attendance"], { "breeze.attendance": "not-requested", "breeze.form_entries": "truncated" }) });
    const html = renderToStaticMarkup(React.createElement(ActivityPage, { capture: null, system: { name: "Breeze", check: capture } }));
    expect(html).toMatch(/<li class="">[^]*?Check-ins[^]*?Read once the service has ended/u);
    expect(html).toMatch(/<li class="">[^]*?Form entries[^]*?Counted for the 5 newest forms only/u);
    expect(html).not.toContain("is-problem");
  });

  it("never folds a check of one system with another's", () => {
    const at = (h: number) => `2026-11-20T${String(h).padStart(2, "0")}:00:00Z`;
    const tasks = [checkRow("1", at(15)), checkRow("2", at(16)), checkRow("3", at(17)), checkRow("4", at(18))];
    const source = (id: string) => (id === "1" || id === "2" ? "b1" : "breeze") as "b1" | "breeze";
    const html = renderToStaticMarkup(React.createElement(RecentWork, { tasks, trigger: () => "automatic" as const, found: () => "nothing-new" as const, source, now: new Date(at(19)) }));
    expect(html).toContain(quietChecksLine([tasks[2]!, tasks[3]!], "Breeze"));
    expect(html).toContain(quietChecksLine([tasks[0]!, tasks[1]!], "B1 Church"));
  });
});
