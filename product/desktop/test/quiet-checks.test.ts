// What happened folds quiet checks (owner's request, 2026-11-19): two or more checks in a row on one day that Ozzie started
// by itself, that read everything and are kept as having found nothing new share one line, which opens to each check as
// it shows on its own. What a check found is kept by its task id beside the ledger (harness-words.ts CheckFound); a check
// whose outcome isn't known is never folded, and nothing is taken out of the record. Fictional fixed data only.
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { nov22Capture, PEOPLE, TEAMS } from "../../../core/src/fictional-sunday.js";
import { FICTIONAL_CARDS, withFictionalOperations } from "../../../core/src/fictional-operations.js";
import { stableFindingKey } from "../../../core/src/finding-feedback.js";
import { sundayOperations } from "../../../core/src/operations-capture.js";
import { BACKGROUND_CHECKS } from "../../../core/src/kids-rules.js";
import type { SundayCapture, SundayRules } from "../../../core/src/sunday-capture.js";
import { foldKey, foldQuiet, RecentWork } from "../src/activity-page.js";
import { desktopRecorder, LedgerRecorder, localTriggers } from "../src/harness-bridge.js";
import { quietCheck, quietChecksLine, taskLine, type CheckFound, type TaskEventRow, type TaskRow, type TaskStart } from "../src/harness-words.js";
import { createProactive, desktopProactive, type KeyValueStore, type ProactiveDeps, type ProactiveHooks } from "../src/proactive.js";
import { sundayProblem, type Settings } from "../src/sunday-source.js";
import type { ConnectionStatus } from "../src/connection.js";
import { fakeNative, row, taskIds } from "./harness-fakes.js";

const settings: Settings = { clientId: "fictional-client", organization: "1001", serviceTypeId: "1500", planId: "92902197" };
const connected: ConnectionStatus = { state: "connected", organization: "1001", checked_at_ms: null, source: "", problem: null };
const rules: SundayRules = { sundayLeads: [], checkInAfterSundaysInARow: 3 };
const names = Object.values(nov22Capture().names);

/** The fictional Sunday, read at `iso`, optionally changed. */
function captureAt(iso: string, change?: (c: SundayCapture) => void, base: () => SundayCapture = nov22Capture): SundayCapture {
  const c = base();
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
const greeterNeeds = (quantity: number) => (c: SundayCapture) => { rows(c, "needed_positions").find(n => n.attributes.team_position_name === "Greeter")!.attributes.quantity = quantity; };
/** The pending Lyrics request is declined. Nothing else changes. */
const lyricsDeclined = (c: SundayCapture) => { rows(c, "team_members").find(m => m.id === "403")!.attributes.status = "D"; };
/** Planning Center People's background check for the Nursery volunteer, expiring on `expires`. */
const onFile = (expires: string) => (c: SundayCapture) => {
  c.reads.push({ collection: BACKGROUND_CHECKS, people_person_id: PEOPLE.nurseryConfirmed, offset: 0, checked_at: c.completed_at, outcome: "ok", body: {
    data: [{ type: "BackgroundCheck", id: "901", attributes: { status: "complete_clear", current: true, expires_on: expires }, relationships: { person: { data: { type: "Person", id: PEOPLE.nurseryConfirmed } } } }],
    meta: { count: 1, total_count: 1 } } });
};
/** One read that didn't complete (a person's blockouts). */
const oneReadFailed = (c: SundayCapture) => { const r = c.reads.find(x => x.collection === "person_blockouts")!; r.outcome = "failed"; delete r.body; };

function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, get: k => data.get(k) ?? null, set: (k, v) => { data.set(k, v); } };
}

/** The regular check with a fake ledger: each check gets a task id, and what it found is kept by that id. */
function watching(start: string, store = memoryStore(), context = { settings, rules, status: connected as ConnectionStatus | null }, base: () => SundayCapture = nov22Capture) {
  let now = start, n = 0;
  let change: ((c: SundayCapture) => void) | undefined;
  let fail: unknown = null;
  const ids: string[] = [];
  const found = new Map<string, CheckFound>();
  const deps: ProactiveDeps = {
    store, now: () => now, timeZone: () => "America/Chicago", notify: async () => {}, problem: sundayProblem,
    timers: { setInterval: () => 0, clearInterval: () => {} },
    check: async (_ctx, _onStatus, _trigger, _source, onTask) => {
      const id = `task-${++n}`;
      ids.push(id);
      onTask?.(id);
      if (fail !== null) throw fail;
      return captureAt(now, change, base);
    },
    found: (id, f) => { found.set(id, f); },
  };
  const hooks: ProactiveHooks = { context: () => context, onStatus: () => {}, onCapture: () => {} };
  const p = createProactive(deps);
  return {
    p, store, ids, found, context,
    /** What the newest check is kept as having found; undefined when that isn't known. */
    last: () => found.get(ids.at(-1)!),
    launch: async () => { p.start(hooks); await p.tick(); },
    /** The scheduled check at `iso`, reading the Sunday as `f` leaves it. */
    at: async (iso: string, f?: (c: SundayCapture) => void) => { now = iso; change = f; await p.tick(); },
    changeTo: (f?: (c: SundayCapture) => void) => { change = f; },
    failWith: (e: unknown) => { fail = e; },
  };
}

describe("what a check found is kept beside its task, in closed words", () => {
  it("'nothing-new' when it read everything and found what the check before did; 'changes' when something changed", async () => {
    const w = watching("2026-11-20T15:00:00Z");
    await w.launch();
    // The first look at a Sunday compares with nothing: not known.
    expect(w.ids).toHaveLength(1);
    expect(w.last()).toBeUndefined();
    await w.at("2026-11-20T16:00:00Z");
    expect(w.ids).toHaveLength(2);
    expect(w.last()).toBe("nothing-new");
    // Keeping watch's own list has nothing for a quiet check; the fact lives beside the task.
    expect(w.p.view().history.map(e => e.kind)).toEqual(["first-check"]);
    await w.at("2026-11-20T17:00:00Z", decline);
    expect(w.last()).toBe("changes");
    await w.at("2026-11-20T18:00:00Z", decline);
    expect(w.last()).toBe("nothing-new");
    // Kept for a check you started too (it is a fact about the check); What happened never folds one you started.
    await w.p.checkNow();
    expect(w.last()).toBe("nothing-new");
    expect(new Set(w.found.values())).toEqual(new Set(["nothing-new", "changes"]));
    for (const name of names) expect([...w.store.data.values()].join("\n")).not.toContain(name);
  });

  describe("rooms and follow-ups: a finding's id carries when it was read (live 0.3.3, 2026-11-19)", () => {
    const withRooms = () => withFictionalOperations(nov22Capture());
    it("two reads of the same rooms and follow-ups say nothing new, though each finding's id differs between them", async () => {
      // The id of a room or follow-up finding names the read it came from (its binding's access_epoch is the check's start).
      const [a, b] = ["2026-11-20T15:00:00Z", "2026-11-20T15:30:00Z"].map(at => sundayOperations(captureAt(at, undefined, withRooms), rules, { now: at })!.result!.findings);
      expect(a!.map(f => f.kind).sort()).toEqual(["room-overlap", "unowned-overdue"]);
      expect(a!.map(f => f.finding_id)).not.toEqual(b!.map(f => f.finding_id));
      expect(a!.map(f => stableFindingKey(f.finding_id))).toEqual(b!.map(f => stableFindingKey(f.finding_id)));

      const w = watching("2026-11-20T15:00:00Z", undefined, undefined, withRooms);
      await w.launch();
      await w.at("2026-11-20T16:00:00Z");
      expect(w.last()).toBe("nothing-new");
      await w.at("2026-11-20T17:00:00Z");
      expect(w.last()).toBe("nothing-new");
    });

    const changes: [string, (c: SundayCapture) => void][] = [
      ["an overdue follow-up's due date moved", c => { rows(c, "people_workflow_ready_cards").find(x => x.id === FICTIONAL_CARDS.unowned)!.attributes.calculated_due_at = "2026-10-27T21:27:40Z"; }],
      ["a room booking ending later", c => { rows(c, "calendar_resource_bookings").find(x => x.id === "41000002")!.attributes.ends_at = "2026-11-22T16:30:00Z"; }],
    ];
    for (const [name, change] of changes) {
      it(`still calls a real change there a change: ${name}`, async () => {
        const w = watching("2026-11-20T15:00:00Z", undefined, undefined, withRooms);
        await w.launch();
        await w.at("2026-11-20T16:00:00Z", change);
        // The same finding, still shown: nothing the Keeping watch comparison follows, and no new key.
        expect(w.p.view().history.map(e => e.kind)).toEqual(["first-check"]);
        expect(w.last()).toBe("changes");
        await w.at("2026-11-20T17:00:00Z", change);
        expect(w.last()).toBe("nothing-new");
      });
    }
  });

  it("calls a change a change when it brings no notice: an open role needing fewer people", async () => {
    const fewer = watching("2026-11-20T15:00:00Z");
    fewer.changeTo(greeterNeeds(3));
    await fewer.launch();
    await fewer.at("2026-11-20T16:00:00Z", greeterNeeds(2));
    expect(fewer.last()).toBe("changes");
  });

  it("calls a change a change when Church rules keep it out of Keeping watch: a declined request Ozzie was asked to stop flagging", async () => {
    const stopped = watching("2026-11-20T15:00:00Z");
    stopped.context.rules = { ...rules, feedback: [{ type: "stop", id: "s", kind: "pending", at: "2026-11-20T14:00:00Z", scope: { team_id: TEAMS.lyrics, person_id: PEOPLE.lyricsPending }, labels: {} }] };
    await stopped.launch();
    await stopped.at("2026-11-20T16:00:00Z", lyricsDeclined);
    expect(stopped.p.view().history.map(e => e.kind)).toEqual(["first-check"]);
    expect(stopped.last()).toBe("changes");
  });

  it("calls a new finding a change though the comparison doesn't follow its kind: a background check that expired", async () => {
    // Nobody asked to hear about these right away, so Keeping watch lists nothing, but the Sunday page shows a new finding.
    const expired = watching("2026-11-20T15:00:00Z");
    expired.context.rules = { ...rules, kidsTeams: [{ team_id: TEAMS.nursery, min_confirmed: 1 }] };
    expired.changeTo(onFile("2027-06-01"));
    await expired.launch();
    await expired.at("2026-11-20T16:00:00Z", onFile("2026-11-01"));
    expect(expired.p.view().history.map(e => e.kind)).toEqual(["first-check"]);
    expect(expired.last()).toBe("changes");
    await expired.at("2026-11-20T17:00:00Z", onFile("2026-11-01"));
    expect(expired.last()).toBe("nothing-new");
  });

  it("calls it a change when a card says something new under the same finding: a blockout gone moves someone off Left out (review 2026-11-19)", async () => {
    const noBlockout = (c: SundayCapture) => {
      const r = c.reads.find(x => x.collection === "person_blockouts" && (x.body?.data as { id: string }[] | undefined)?.some(b => b.id === "801"))!;
      r.body = { ...r.body!, data: (r.body!.data as { id: string }[]).filter(b => b.id !== "801") };
    };
    const w = watching("2026-11-20T15:00:00Z");
    await w.launch();
    await w.at("2026-11-20T16:00:00Z", noBlockout);
    // Nothing the comparison follows changed, and the Greeter card is still the Greeter card; what it says changed.
    expect(w.p.view().history.map(e => e.kind)).toEqual(["first-check"]);
    expect(w.last()).toBe("changes");
    await w.at("2026-11-20T17:00:00Z", noBlockout);
    expect(w.last()).toBe("nothing-new");
  });

  it("calls it a change when a finding about the same person says something new: a background check expiring, then expired", async () => {
    const w = watching("2026-11-20T15:00:00Z");
    w.context.rules = { ...rules, kidsTeams: [{ team_id: TEAMS.nursery, min_confirmed: 1 }] };
    // Expires the day before the service, then has expired: the same card, for the same person, saying something else.
    w.changeTo(onFile("2026-11-21"));
    await w.launch();
    await w.at("2026-11-20T16:00:00Z", onFile("2026-11-21"));
    expect(w.last()).toBe("nothing-new");
    await w.at("2026-11-20T17:00:00Z", onFile("2026-11-01"));
    expect(w.p.view().history.map(e => e.kind)).toEqual(["first-check"]);
    expect(w.last()).toBe("changes");
  });

  it("calls it a change when someone is newly scheduled and confirmed on a team that needs no one", async () => {
    const added = (c: SundayCapture) => {
      const members = rows(c, "team_members");
      members.push({ ...structuredClone(members.find(m => m.id === "403")!), id: "499", attributes: { ...members.find(m => m.id === "403")!.attributes, status: "C" } });
    };
    const w = watching("2026-11-20T15:00:00Z");
    await w.launch();
    await w.at("2026-11-20T16:00:00Z", added);
    expect(w.last()).toBe("changes");
  });

  it("says nothing new only after a check of the same service: switching to another and back is not known", async () => {
    const other = (c: SundayCapture) => { (c as { plan_id: string }).plan_id = "92902300"; };
    const w = watching("2026-11-20T15:00:00Z");
    await w.launch();
    await w.at("2026-11-20T16:00:00Z");
    expect(w.last()).toBe("nothing-new");
    await w.at("2026-11-20T17:00:00Z", other);
    expect(w.last()).toBeUndefined();
    await w.at("2026-11-20T18:00:00Z", other);
    expect(w.last()).toBe("nothing-new");
    // Back to the first service: nothing changed there since its own last check, but the check before this one was of the
    // other service, so this one doesn't say nothing new.
    await w.at("2026-11-20T19:00:00Z");
    expect(w.last()).toBeUndefined();
    await w.at("2026-11-20T20:00:00Z");
    expect(w.last()).toBe("nothing-new");
  });

  it("never says nothing new for a read that didn't complete after one that did", async () => {
    const w = watching("2026-11-20T15:00:00Z");
    await w.launch();
    await w.at("2026-11-20T16:00:00Z", oneReadFailed);
    expect(w.ids).toHaveLength(2);
    expect(w.last()).not.toBe("nothing-new");
  });

  it("keeps nothing when comparing stops partway: the check still finishes", async () => {
    const store = memoryStore();
    const w = watching("2026-11-20T15:00:00Z", store);
    await w.launch();
    const set = store.set;
    store.set = (k, v) => { if (k === "ozzie.proactive.sundays.v1") throw new Error("full"); set(k, v); };
    await w.at("2026-11-20T16:00:00Z");
    expect(w.ids).toHaveLength(2);
    expect(w.last()).toBeUndefined();
    expect(w.p.view().schedule.last_run).toMatchObject({ outcome: "ok" });
  });

  it("keeps nothing when it can't be sure: a read that didn't complete, a saved copy, a Sunday kept without its findings, a check that failed", async () => {
    const partial = watching("2026-11-20T15:00:00Z");
    partial.changeTo(oneReadFailed);
    await partial.launch();
    await partial.at("2026-11-20T16:00:00Z", oneReadFailed);
    expect(partial.p.view().history.map(e => e.kind)).toEqual(["first-check"]);
    expect(partial.last()).toBeUndefined();

    const saved = watching("2026-11-20T15:00:00Z");
    await saved.launch();
    await saved.at("2026-11-20T16:00:00Z", c => { (c as { kind: string }).kind = "recording"; });
    expect(saved.ids).toHaveLength(2);
    expect(saved.last()).toBeUndefined();

    // A Sunday remembered by an earlier Ozzie, before the findings each check showed (or their print) were kept: nothing to
    // compare them with.
    const earlier = watching("2026-11-20T15:00:00Z");
    await earlier.launch();
    const key = "ozzie.proactive.sundays.v1";
    for (const field of ["found", "prints"]) {
      const kept = JSON.parse(earlier.store.data.get(key)!) as Record<string, unknown>;
      const one = structuredClone(kept);
      expect(one[field]).toBeDefined();
      delete one[field];
      const store = memoryStore();
      store.data.set(key, JSON.stringify(one));
      const reopened = watching("2026-11-20T16:00:00Z", store);
      await reopened.launch();
      expect(reopened.ids).toHaveLength(1);
      expect(reopened.last(), field).toBeUndefined();
    }
    // With both kept, the same check says nothing new.
    const store = memoryStore();
    store.data.set(key, earlier.store.data.get(key)!);
    const both = watching("2026-11-20T16:00:00Z", store);
    await both.launch();
    expect(both.last()).toBe("nothing-new");

    const failed = watching("2026-11-20T15:00:00Z");
    await failed.launch();
    failed.failWith({ sunday_check: "provider" });
    await failed.at("2026-11-20T16:00:00Z");
    expect(failed.ids).toHaveLength(2);
    expect(failed.last()).toBeUndefined();
  });

  it("the ledger recorder tells the check's own task id, and keeps only the closed words", async () => {
    const ledger = fakeNative();
    const kept = new Map<string, string>();
    const triggers = localTriggers({ getItem: k => kept.get(k) ?? null, setItem: (k, v) => { kept.set(k, v); } });
    const r = new LedgerRecorder({ invoke: ledger.invoke, hashFor: async () => "a".repeat(64), newId: taskIds(), triggers });
    const capture = nov22Capture();
    let told: string | undefined;
    await expect(r.check(async () => capture, "automatic", id => { told = id; })).resolves.toBe(capture);
    await r.idle();
    expect(told).toBe(ledger.log.find(([c]) => c === "ledger_admit")![1]["taskId"]);
    r.checked(told!, "nothing-new");
    r.checked(told!, "Riley Thornbury" as never);
    triggers.setFound(told!, "Riley Thornbury" as never);
    expect(triggers.found(told!)).toBe("nothing-new");
    expect(triggers.get(told!)).toBe("automatic");
    expect(triggers.end(told!)).toBeUndefined();
    expect(JSON.parse(kept.get("ozzie.ledger.found.v1")!)).toEqual([[told, "nothing-new"]]);
    // Under its own key: the list of how tasks started holds no new word, so an earlier Ozzie still reads every entry.
    expect(JSON.parse(kept.get("ozzie.ledger.checks.v1")!)).toEqual([[told, "automatic"]]);
    // Being told never stops the check.
    await expect(r.check(async () => capture, "automatic", () => { throw new Error("boom"); })).resolves.toBe(capture);
  });

  it("an earlier Ozzie reading the list of how tasks started still finds every check's start", () => {
    const kept = new Map<string, string>();
    const triggers = localTriggers({ getItem: k => kept.get(k) ?? null, setItem: (k, v) => { kept.set(k, v); } });
    triggers.set("a", "automatic");
    triggers.setFound("a", "nothing-new");
    triggers.set("b", "automatic");
    triggers.setFound("b", "changes");
    triggers.set("c", "manual");
    // 0.3.2's own reading of that list (harness-bridge.ts at 5ed31b56): an entry whose third word it doesn't know is dropped.
    const earlier = (JSON.parse(kept.get("ozzie.ledger.checks.v1")!) as unknown[][])
      .filter(e => e[2] === undefined || ["facts", "not-covered", "nothing-needs-a-decision", "draft"].includes(e[2] as string));
    expect(earlier.map(e => [e[0], e[1]])).toEqual([["c", "manual"], ["b", "automatic"], ["a", "automatic"]]);
    expect(JSON.parse(kept.get("ozzie.ledger.found.v1")!)).toEqual([["b", "changes"], ["a", "nothing-new"]]);
  });
});

describe("the app's own wiring: the regular check, the ledger recorder and the store What happened reads", () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); invoke.mockReset(); });

  it("keeps each check's finding against the very task What happened lists, and the page folds the quiet ones", async () => {
    const local = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => local.get(k) ?? null, setItem: (k: string, v: string) => { local.set(k, v); }, removeItem: (k: string) => { local.delete(k); } });
    vi.useFakeTimers({ toFake: ["Date"] });
    let change: ((c: SundayCapture) => void) | undefined;
    invoke.mockImplementation(async (command: string) => command === "check_sunday" ? captureAt(new Date().toISOString(), change) : undefined);
    const times = ["2026-11-20T15:00:00Z", "2026-11-20T15:30:00Z", "2026-11-20T16:00:00Z", "2026-11-20T16:30:00Z"];
    vi.setSystemTime(new Date(times[0]!));
    const p = desktopProactive();
    p.start({ context: () => ({ settings, rules, status: connected }), onStatus: () => {}, onCapture: () => {} });
    await p.tick();
    // Read again by Ozzie on its own (as when what's on screen goes out of date), twice unchanged, then with a decline.
    for (const [i, at] of times.slice(1).entries()) {
      vi.setSystemTime(new Date(at));
      change = i === 2 ? decline : undefined;
      await p.checkNow("automatic");
    }
    p.stop();
    await desktopRecorder().idle();
    // The ids the ledger was asked to admit, oldest first; how each started and what it found, kept beside them.
    const admitted = invoke.mock.calls.filter(([c]) => c === "ledger_admit").map(([, a]) => (a as { taskId: string }).taskId);
    expect(admitted).toHaveLength(4);
    const store = localTriggers({ getItem: k => local.get(k) ?? null, setItem: () => {} });
    expect(admitted.map(id => [store.get(id), store.found(id)])).toEqual([["automatic", undefined], ["automatic", "nothing-new"], ["automatic", "nothing-new"], ["automatic", "changes"]]);

    // What happened, from those tasks as the ledger lists them and what this Mac kept beside them.
    vi.useRealTimers();
    const tasks = [...admitted].map((task_id, i) => checkRow(task_id, times[i]!));
    const html = renderToStaticMarkup(React.createElement(RecentWork, { tasks, trigger: store.get, end: store.end, found: store.found, now: new Date(times.at(-1)!) }));
    const ln = (i: number) => taskLine(tasks[i]!, { trigger: "automatic", now: new Date(times.at(-1)!) });
    expect(lines(html)).toEqual([ln(3), { fold: quietChecksLine([tasks[1]!, tasks[2]!]), checks: [ln(2), ln(1)] }, ln(0)]);
    expect(quietChecksLine([tasks[1]!, tasks[2]!])).toMatch(/^Checked Planning Center twice on its own, \S+ \S+ to \S+ \S+ · nothing new$/u);
    // The app hands What happened the same store's three accessors.
    const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
    expect(app).toMatch(/<ActivityPage [^>]*trigger=\{triggers\.get\} end=\{triggers\.end\} found=\{triggers\.found\}/u);
  });
});

// ---- The fold on What happened ---------------------------------------------------------------------------------------

const here = new Date(2026, 10, 20, 18, 0);
const local = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).toISOString();
const ev = (type: TaskEventRow["type"], detail = ""): TaskEventRow => ({ task_id: "t", sequence: 0, at: "x", type, detail });
let n = 0;
const nextId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
/** A finished check as the ledger lists it: its one Planning Center read, complete unless said otherwise. */
const checkRow = (task_id: string, at: string, read = "complete"): TaskRow => row({ task_id, kind: "check", state: "verified", created_at: at, updated_at: at,
  events: [ev("admitted"), ev("running"), ev("tool", `planning_center.refresh ${read}`), ev("verified")] });
interface Task { row: TaskRow; start?: TaskStart; found?: CheckFound }
/** A check Ozzie started by itself, read in full, kept as having found nothing new. */
const quiet = (at: string): Task => ({ row: checkRow(nextId(), at), start: "automatic", found: "nothing-new" });
function render(tasks: readonly Task[], now = here) {
  const kept = new Map(tasks.map(t => [t.row.task_id, t]));
  return renderToStaticMarkup(React.createElement(RecentWork, {
    tasks: tasks.map(t => t.row), trigger: id => kept.get(id)?.start, found: id => kept.get(id)?.found, now,
  }));
}
/** A task's own line, as What happened shows it unfolded. */
const own = (t: Task, now = here) => taskLine(t.row, { ...(t.start ? { trigger: t.start } : {}), now });
const SUMMARY = /<summary><svg class="ic ic-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"><\/path><\/svg><span>([^<]+)<\/span><\/summary>/gu;
const decode = (s: string) => s.replaceAll("&#x27;", "'").replaceAll("&quot;", "\"").replaceAll("&amp;", "&");
/** Recent work's lines in order: a task's own line, or a fold with each check inside it. */
function lines(html: string): (string | { fold: string; checks: string[] })[] {
  const out: (string | { fold: string; checks: string[] })[] = [];
  for (const m of html.matchAll(/<details class="recent-task recent-fold">([\s\S]*?)<\/ol><\/details><\/li>|<details class="recent-task">(<summary>[\s\S]*?<\/summary>)/gu)) {
    if (m[1] !== undefined) {
      const [fold, ...checks] = [...m[1].matchAll(SUMMARY)].map(x => decode(x[1]!));
      out.push({ fold: fold!, checks });
    } else out.push(decode([...m[2]!.matchAll(SUMMARY)][0]![1]!));
  }
  return out;
}
const fold = (tasks: readonly Task[]) => ({ fold: quietChecksLine(tasks.map(t => t.row)), checks: tasks.map(t => own(t)) });
const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

describe("What happened folds quiet checks in a row", () => {
  it("six in a row share one line, which opens to each check exactly as it shows on its own", () => {
    const six = [14, 13, 12, 11, 10, 9].map(h => quiet(local(20, h)));
    const html = render(six);
    expect(lines(html)).toEqual([fold(six)]);
    expect(lines(html)[0]).toEqual({
      fold: `Checked Planning Center 6 times on its own, ${time(local(20, 9))} to ${time(local(20, 14))} · nothing new`,
      checks: [14, 13, 12, 11, 10, 9].map(h => `Planning Center check, on its own · ${time(local(20, h))}`),
    });
    // Not "hourly": with the window on screen Ozzie also reads again when what's shown goes out of date.
    expect(html).not.toMatch(/hourly/u);
    // Each check inside, with its account, is the very markup it has unfolded.
    for (const t of six) {
      const alone = render([t]);
      const li = /<li class="">[\s\S]*<\/li>/u.exec(alone)![0];
      expect(html).toContain(li);
    }
  });

  it("a fold keeps its place as newer quiet checks join it, so one that is open stays open (review 2026-11-19)", () => {
    const [c, b, a] = [quiet(local(20, 11)), quiet(local(20, 10)), quiet(local(20, 9))].map(t => t.row) as [TaskRow, TaskRow, TaskRow];
    expect(foldKey([c, b, a])).toBe(foldKey([b, a]));
    expect(foldKey([b, a])).not.toBe(foldKey([c, b]));
  });

  it("one alone is an ordinary line; two make a fold", () => {
    const one = quiet(local(20, 9));
    expect(lines(render([one]))).toEqual([own(one)]);
    const two = [quiet(local(20, 10)), quiet(local(20, 9))];
    expect(lines(render(two))).toEqual([fold(two)]);
    expect(lines(render(two))[0]).toMatchObject({ fold: expect.stringMatching(/^Checked Planning Center twice on its own, /u) });
  });

  describe("never folds these, and any of them between quiet checks breaks the run", () => {
    const at = local(20, 12);
    const cases: [string, Task][] = [
      ["a check that failed", { row: row({ task_id: nextId(), kind: "check", state: "failed", failure: "provider-failure", created_at: at, events: [ev("admitted"), ev("running"), ev("failed", "provider-failure")] }), start: "automatic", found: "nothing-new" }],
      ["a check that was partial", { row: checkRow(nextId(), at, "partial"), start: "automatic", found: "nothing-new" }],
      ["a check that found changes", { row: checkRow(nextId(), at), start: "automatic", found: "changes" }],
      ["a check you started", { row: checkRow(nextId(), at), start: "manual", found: "nothing-new" }],
      ["a check whose outcome isn't known (kept before this change)", { row: checkRow(nextId(), at), start: "automatic" }],
      ["a check with no start kept", { row: checkRow(nextId(), at), found: "nothing-new" }],
      // Listed between its read and its end (What happened reads the ledger every few seconds).
      ["a check still running", { row: row({ task_id: nextId(), kind: "check", state: "running", created_at: at,
        events: [ev("admitted"), ev("running"), ev("tool", "planning_center.refresh complete")] }), start: "automatic", found: "nothing-new" }],
      ["a check whose read wasn't recorded", { row: row({ task_id: nextId(), kind: "check", state: "verified", created_at: at, events: [ev("admitted"), ev("running"), ev("verified")] }), start: "automatic", found: "nothing-new" }],
      ["a question answered", { row: row({ task_id: nextId(), kind: "ask", state: "verified", created_at: at, events: [ev("admitted"), ev("verified")] }), start: "on-this-mac", found: "nothing-new" }],
      ["a job's run", { row: row({ task_id: nextId(), kind: "skill", state: "verified", created_at: at, events: [ev("admitted"), ev("verified")] }), start: "job:keep-sunday-covered:scheduled", found: "nothing-new" }],
    ];
    for (const [name, breaker] of cases) {
      it(name, () => {
        expect(quietCheck(breaker.row, breaker.start, breaker.found)).toBe(false);
        const after = [quiet(local(20, 14)), quiet(local(20, 13))], before = [quiet(local(20, 11)), quiet(local(20, 10))];
        expect(lines(render([...after, breaker, ...before]))).toEqual([fold(after), own(breaker), fold(before)]);
        // Between two single quiet checks: three ordinary lines.
        const single = [quiet(local(20, 13)), breaker, quiet(local(20, 11))];
        expect(lines(render(single))).toEqual(single.map(t => own(t)));
      });
    }
  });

  it("a run never crosses a day", () => {
    const today = [quiet(local(20, 1)), quiet(local(20, 0, 30))], yesterday = [quiet(local(19, 23, 30)), quiet(local(19, 23))];
    const html = render([...today, ...yesterday]);
    const days = html.split("<section").slice(1);
    expect(days.map(d => /<h3[^>]*>([^<]+)<\/h3>/u.exec(d)![1])).toEqual(["Today", "Yesterday"]);
    expect(days.map(lines)).toEqual([[fold(today)], [fold(yesterday)]]);
    // One each side of midnight: two ordinary lines, under their own days.
    const pair = [quiet(local(20, 0, 30)), quiet(local(19, 23, 30))];
    expect(render(pair).split("<section").slice(1).map(lines)).toEqual([[own(pair[0]!)], [own(pair[1]!)]]);
    expect(foldQuiet(pair.map(t => t.row), () => true)).toHaveLength(1);
  });

  it("checks kept before this change, with no finding beside them, show exactly as they did", () => {
    const older = [14, 13, 12, 11].map(h => ({ row: checkRow(nextId(), local(20, h)), start: "automatic" as const }));
    expect(lines(render(older))).toEqual(older.map(t => own(t)));
    expect(render(older)).not.toContain("recent-fold");
  });

  it("nothing vanishes: every task is still a line of its own inside, and Show earlier work counts lines", () => {
    const quietRun = Array.from({ length: 20 }, (_, i) => quiet(local(20, 17 - Math.floor(i / 2), i % 2 ? 0 : 30)));
    const others = Array.from({ length: 12 }, (_, i): Task => ({ row: row({ task_id: nextId(), kind: "ask", state: "verified", created_at: local(19, 20 - i), events: [ev("admitted"), ev("verified")] }) }));
    const html = render([...quietRun, ...others]);
    const shown = lines(html);
    // One fold of 20 and nine questions: ten lines; three more behind the button.
    expect(shown).toHaveLength(10);
    expect(shown[0]).toEqual(fold(quietRun));
    expect(decode(html)).toContain("Show earlier work (3 more)");
    // Fewer than ten lines: every task appears once, folded or not, and nothing is hidden.
    const ask = (at: string): Task => ({ row: row({ task_id: nextId(), kind: "ask", state: "verified", created_at: at, events: [ev("admitted"), ev("verified")] }) });
    const mixed = [...quietRun.slice(0, 6), ask(local(20, 14, 45)), ...quietRun.slice(6, 9), ask(local(20, 13, 15)), ask(local(20, 13, 10))];
    const all = render(mixed);
    expect(lines(all)).toEqual([fold(mixed.slice(0, 6)), own(mixed[6]!), fold(mixed.slice(7, 10)), own(mixed[10]!), own(mixed[11]!)]);
    expect(all.match(/<details class="recent-task">/gu)).toHaveLength(mixed.length);
    expect(lines(all).flatMap(l => typeof l === "string" ? [l] : l.checks).sort()).toEqual(mixed.map(t => own(t)).sort());
    expect(all).not.toContain("Show earlier work");
  });

  it("opens like the page's other folds: the chevron before plain words, a native fold VoiceOver reads, and a list inside", () => {
    const html = render([quiet(local(20, 10)), quiet(local(20, 9))]);
    expect(html).toMatch(/<details class="recent-task recent-fold"><summary><svg class="ic ic-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"><\/path><\/svg><span>[^<]+<\/span><\/summary><ol class="log recent"><li class=""><details class="recent-task"><summary>/u);
    expect(html).not.toMatch(/<summary[^>]*(?:role|tabindex|aria-)/u);
    expect(html).not.toMatch(/<details[^>]*open/u);
    const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
    // The fold is a .recent-task: the same hidden marker, 44px row and turning chevron; its list sits inset.
    expect(css).toMatch(/\.oz \.recent-task\[open\] > summary \.ic \{ transform: rotate\(90deg\); \}/u);
    expect(css).toMatch(/\.oz \.recent-fold > \.log \{ margin: 10px 16px 12px; \}/u);
  });
});
