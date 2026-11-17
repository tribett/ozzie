// A job's write-up (audit item 6) is what the AI chose for a run, in Ozzie's own sentences, kept on this Mac with the run.
// It holds people only as their Planning Center ids, and role, room, follow-up and group names as Planning Center has
// them (review H, M4: so a person's name a church typed into one is kept with it); it reaches nothing that leaves Ozzie or that the harness or sharing code reads:
// not the task record (ledger), not the copy for other AI apps (core/mcp), not Siri's copy, never a notice on this Mac or
// the phone, and no localStorage key but its own. Shown here at run time with fictional data and a scripted model, and
// in the source: the key and the write-up are named only where they are made and shown.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => { throw new Error("NATIVE_CALL_FORBIDDEN"); }) }));
import { bundledSkills } from "../../../core/src/harness/bundled-skills.js";
import { HarnessSession } from "../../../core/src/harness/session.js";
import { defaultPlan, TEMPLATES, untilLifetime, type Responsibility, type RunRow } from "../../../core/src/harness/responsibilities.js";
import { nov22Capture } from "../../../core/src/fictional-sunday.js";
import { withFictionalOperations } from "../../../core/src/fictional-operations.js";
import { DEFAULT_QUIET_HOURS } from "../../../core/src/schedule.js";
import type { HarnessData } from "../../../core/src/harness/index.js";
import { buildHarnessData, createAppHarness, keptWriteup, LedgerRecorder, localTriggers } from "../src/harness-bridge.js";
import { createRunner, type Prepared, type ResponsibilityNative } from "../src/responsibility-runner.js";
import { calls, facts, fakeNative, fictionalData, payloadOf, RULES, scripted, taskIds } from "./harness-fakes.js";

const skills = await bundledSkills();
const names = nov22Capture().names;
const FRI = "2026-11-20T15:00:00.000Z";
const ET = "America/New_York";
const CANARY = "QZX-WRITEUP-7731";
const words = Object.values(names).flatMap(n => n.split(/\s+/u)).filter(w => w.length >= 3);
const holds = (text: string) => [CANARY, ...words].filter(w => text.includes(w));

/** sunday-ready through the real harness with a scripted model, recorded in a fake ledger; then kept as a write-up. */
async function aRun() {
  const ledger = fakeNative();
  const store = new Map<string, string>();
  const triggers = localTriggers({ getItem: k => store.get(k) ?? null, setItem: (k, v) => { store.set(k, v); } });
  const recorder = new LedgerRecorder({ invoke: ledger.invoke, hashFor: async id => skills.get(id)?.hash, newId: taskIds(), readyMs: 200, triggers });
  const m = scripted([
    () => calls(["sunday.overview"], ["sunday.pending_requests"]),
    r => facts([String(payloadOf(r, "sunday.overview")?.["fact"]), ...((payloadOf(r, "sunday.pending_requests")?.["pending"] as { fact: string }[]) ?? []).map(p => p.fact)]),
  ]);
  const h = createAppHarness({ workspace_id: "fictional", data: fictionalData(), skills, session: new HarnessSession(), loop: "ts", step: m.model, recorder });
  const observer = recorder.task("skill", "sunday-ready", "job:keep-sunday-covered:scheduled");
  const outcome = await h.runSkill("sunday-ready", { onEvent: observer.onEvent });
  expect(outcome.status).toBe("verified");
  await recorder.idle();
  return { writeup: keptWriteup(h, outcome), ledger, store, requests: m.requests };
}

describe("a job's write-up stays where it is kept", () => {
  it("is Ozzie's sentences with people as id tokens; the task record and the note beside it hold none of it", async () => {
    const { writeup, ledger, store, requests } = await aRun();
    const kept = writeup.lines.join("\n");
    // The run's own words: a person the check found pending, kept as their id, never their name.
    expect(kept).toMatch(/\{\{person:\d+\}\} is pending for Lyrics/u);
    expect(holds(kept)).toEqual([]);
    // What went to the model held no name either (the boundary, as always).
    expect(holds(JSON.stringify(requests))).toEqual([]);
    // The ledger holds kinds, codes and tool names only: none of the write-up's lines, tokens, names or sources.
    const recorded = JSON.stringify(ledger.log);
    for (const line of writeup.lines) expect(recorded).not.toContain(line.slice(0, 30));
    expect(recorded).not.toMatch(/\{\{person:|Lyrics|Greeter|Based on/u);
    expect(holds(recorded)).toEqual([]);
    expect(ledger.log.map(([c]) => c)).toEqual(["ledger_admit", "ledger_transition", "ledger_event", "ledger_event", "ledger_transition"]);
    // Beside the ledger on this Mac: how it started and how it ended, in closed words.
    expect([...store.values()].join("")).toMatch(/^\[\["[0-9a-f-]{36}","job:keep-sunday-covered:scheduled"\]\]$/u);
  });

  it("never reaches a notice, the native store, or any key but its own, whatever it says", async () => {
    const items: Responsibility[] = [];
    const nativeCalls: unknown[][] = [];
    let clock = FRI;
    const native: ResponsibilityNative = {
      list: async () => ({ paused_all: false, items: structuredClone(items) }),
      create: async plan => { const t = TEMPLATES[plan.template]; const r: Responsibility = { ...structuredClone(plan), id: "00000000-0000-4000-8000-000000000001", title: t.title, skill_id: t.skill_id, status: "active", created_at: clock, confirmed_at: clock, runs: [], open_run: null }; items.push(r); return structuredClone(r); },
      edit: async () => items[0]!, pause: async () => items[0]!, resume: async () => items[0]!, stop: async () => items[0]!, pauseAll: async () => ({ paused_all: false, items }),
      begin: async (id, trigger) => { nativeCalls.push(["begin", id, trigger]); const run: RunRow = { run_id: "00000000-0000-4000-8000-0000000000aa", trigger, started_at: clock, ended_at: null, outcome: null, code: null, noticed: 0, drafts: 0, ai_steps: 0 }; items[0]!.runs.unshift(run); items[0]!.open_run = run; return { run_id: run.run_id, ai_steps: 6, checks_left: 5 }; },
      end: async (...args) => { nativeCalls.push(["end", ...args]); Object.assign(items[0]!.runs[0]!, { ended_at: clock, outcome: args[2] }); items[0]!.open_run = null; return items[0]!; },
    };
    const data = new Map<string, string>();
    const notify = vi.fn(async () => {});
    const runner = createRunner({ native, store: { get: k => data.get(k) ?? null, set: (k, v) => { data.set(k, v); } }, now: () => clock, notify });
    runner.keepWriteupsFor(nov22Capture().organization);
    const { writeup } = await aRun();
    const prepared: Prepared = { status: "verified", code: null, ai_steps: 2, writeup: { ...writeup, lines: [...writeup.lines, `${CANARY} {{person:501}}`] } };
    runner.start({
      context: () => ({ ready: true, granted: ["services"], rules: { sundayLeads: [], checkInAfterSundaysInARow: 3 }, zone: ET, macZone: ET, quiet: DEFAULT_QUIET_HOURS, urgentWithinHours: 48, modelReady: true }),
      check: async () => ({ ...withFictionalOperations(nov22Capture()), completed_at: clock }), prepare: async () => prepared,
    });
    await runner.create({ ...defaultPlan("keep-sunday-covered", FRI, ET), lifetime: untilLifetime("2026-11-22", ET)! });
    await runner.tick();
    // A scheduled run later: its notice decided without the write-up.
    clock = "2026-11-20T17:00:00.000Z";
    await runner.tick();
    expect(Object.values(runner.view().writeups).some(w => w.lines?.some(l => l.includes(CANARY)))).toBe(true);
    // Notices carry a kind at most; the native store a run's counts and codes.
    expect(holds(JSON.stringify(notify.mock.calls))).toEqual([]);
    expect(holds(JSON.stringify(nativeCalls))).toEqual([]);
    expect(JSON.stringify(nativeCalls)).not.toContain("{{person:");
    // Every key but its own: nothing of it.
    for (const [key, value] of data) {
      if (key === "ozzie.responsibilities.writeups.v1") { expect(value).toContain(CANARY); expect(holds(value.replaceAll(CANARY, ""))).toEqual([]); continue; }
      expect(value, key).not.toContain(CANARY);
      expect(value, key).not.toContain("{{person:");
    }
  });

  it("is named only where it is made, kept and shown: never by sharing, Siri, notices, the ledger or the copy for other AI apps", () => {
    // Every source file on disk under these folders, so a copy without git (a ZIP of the public repository) is checked
    // too. Build output (dist*, git-ignored) and installed packages are left out; in a clean checkout that is exactly what
    // git tracks there, and in a working tree it also takes in files not yet added (review N, 9).
    const tracked = ["product/desktop/src", "core/src", "core/mcp"].flatMap(dir =>
      readdirSync(new URL(`../../../${dir}`, import.meta.url), { recursive: true, encoding: "utf8" })
        .map(f => `${dir}/${f.replaceAll("\\", "/")}`))
      .filter(f => /\.(?:ts|tsx|mjs)$/u.test(f) && !f.split("/").some(part => /^(?:dist(?:-.+)?|node_modules)$/u.test(part)));
    expect(tracked.length).toBeGreaterThan(100);
    const naming = (re: RegExp) => tracked.filter(f => re.test(readFileSync(new URL(`../../../${f}`, import.meta.url), "utf8"))).sort();
    // The key: only the runner reads or writes it.
    expect(naming(/ozzie\.responsibilities\.writeups/u)).toEqual(["product/desktop/src/responsibility-runner.ts"]);
    // The write-up itself: made in App and harness-bridge, kept by the runner, shown on Today, What runs automatically and the briefing.
    expect(naming(/\bwriteups?\b|\bWriteUp\b|keptWriteup|WriteUpBlock/u)).toEqual([
      "product/desktop/src/App.tsx", "product/desktop/src/harness-bridge.ts", "product/desktop/src/responsibility-runner.ts",
      "product/desktop/src/responsibility-views.tsx", "product/desktop/src/today-groups.ts", "product/desktop/src/today-page.tsx",
    ]);
    // App forgets every write-up when saved checks are deleted and on every status that is disconnected (review H, M4;
    // review G, N2): the one funnel every status passes through forgets them, and each path goes through it.
    const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
    expect(app).toMatch(/onDeleteRecordings=\{\(\) => \{[^}]*runner\.forgetAllWriteups\(\)/u);
    const funnel = /const setStatus = useCallback\(\(next: ConnectionStatus \| null\) => \{[^]*?\n {2}\}, \[\]\);/u.exec(app)?.[0] ?? "";
    expect(funnel).toMatch(/if \(next\?\.state === "disconnected"\) runner\.forgetAllWriteups\(\);\n\s*setShownStatus\(next\);/u);
    // Nothing sets the shown status any other way.
    expect(app.match(/setShownStatus\(/gu)).toHaveLength(1);
    // The status poll, the scheduler, the launch check, and Settings and setup.
    expect(app).toMatch(/connection\.status\(\)\.then\(v => \{ if \(alive\) setStatus\(v\); \}\)/u);
    expect(app).toMatch(/onStatus: setStatus,/u);
    expect(app).toMatch(/setStatus\(verified\);/u);
    expect(app.match(/onStatus=\{setStatus\}/gu)).toHaveLength(2);
    expect(app).not.toMatch(/onStatus=\{(?!setStatus\})/u);
    // What leaves Ozzie, or that the harness and sharing code read, never imports the runner's view of it.
    for (const f of ["product/desktop/src/share-check.ts", "product/desktop/src/siri-shortcuts.ts", "product/desktop/src/phone-notice.ts", "product/desktop/src/proactive.ts",
      "product/desktop/src/background.ts", "core/mcp/snapshot.ts", "core/mcp/shortcuts.ts", "core/mcp/server.ts", "core/src/harness/tools.ts", "core/src/harness/ledger-events.ts"]) {
      const source = readFileSync(new URL(`../../../${f}`, import.meta.url), "utf8");
      expect(source, f).not.toMatch(/writeup|keptWriteup|fillPeople|PERSON_TOKEN|\.view\(\)/iu);
    }
  });
});

/** The fictional example with place names a church typed with a person's name in them, as real churches do (review H). */
function namedPlaces(): HarnessData {
  const capture = withFictionalOperations(nov22Capture());
  const labels = { ...capture.labels };
  for (const k of Object.keys(labels)) {
    if (k.startsWith("room")) labels[k] = "Thornbury Hall";
    if (k.startsWith("workflow")) labels[k] = "Avery Brightwater's welcome calls";
    if (k.startsWith("step")) labels[k] = "Call from Sam Whitcombe";
  }
  return buildHarnessData({ capture: { ...capture, labels }, fictional: false, rules: RULES, decisions: [], status: null, configured: false, now: "2026-11-20T15:05:00Z" });
}

describe("exactly what a kept write-up holds (review H, M4)", () => {
  it("people as their Planning Center ids; room, follow-up and step names as Planning Center has them, a name typed into one included; none of it sent", async () => {
    const data = namedPlaces();
    const parts = Object.values(data.capture!.names).flatMap(n => n.split(/\s+/u));
    for (const [skill, tool, list] of [["room-check", "rooms.conflicts", "rooms"], ["follow-up-owners", "followups.unowned", "follow_ups"]] as const) {
      const m = scripted([() => calls([tool]), r => facts(((payloadOf(r, tool)?.[list] as { fact: string }[]) ?? []).map(x => x.fact))]);
      const h = createAppHarness({ workspace_id: "x", data: { ...data, granted: ["services", "operations"] }, skills, session: new HarnessSession(), loop: "ts", step: m.model });
      const outcome = await h.runSkill(skill);
      expect(outcome.status, skill).toBe("verified");
      // The model saw labels only.
      expect(parts.filter(n => JSON.stringify(m.requests).includes(n)), skill).toEqual([]);
      // Kept: the place names as the church typed them, so the person's name in one is kept too, on this Mac.
      const kept = keptWriteup(h, outcome).lines.join("\n");
      expect(kept, skill).toMatch(skill === "room-check" ? /Thornbury Hall/u : /Avery Brightwater's welcome calls/u);
    }
  });
});
