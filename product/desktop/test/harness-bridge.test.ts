// The harness in the desktop app: native error mapping, the ledger grammar, a ledger that fails or
// stalls never breaking a task, HarnessData from app state, Sunday checks as ledger tasks, and Ask
// Ozzie end to end through the real harness with scripted models. Fictional fixed data; no native calls.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => { throw new Error("NATIVE_CALL_FORBIDDEN"); }) }));
import { REFUSALS } from "../../../core/src/ask.js";
import { backgroundInToolResult, backgroundWording } from "../../../core/src/harness/background-wording.js";
import { asksAboutChecksOrKids, NO_KIDS_TEAM } from "../../../core/src/harness/compose.js";
import { NATIVE_TOOL_ALLOWLIST, type AgentStepReply, type AgentStepRequest, type ModelStep, type TaskEvent } from "../../../core/src/harness/contract.js";
import { VOCABULARY } from "../../../core/src/harness/fixed.js";
import { bundledSkills } from "../../../core/src/harness/bundled-skills.js";
import type { Harness } from "../../../core/src/harness/index.js";
import { checkTime, HarnessSession, showTimes } from "../../../core/src/harness/session.js";
import { nov22Capture, TEAMS, withFictionalBackgroundChecks } from "../../../core/src/fictional-sunday.js";
import { FICTIONAL_ROOM, withFictionalOperations, withFictionalOperationsOff } from "../../../core/src/fictional-operations.js";
import type { SundayCapture } from "../../../core/src/sunday-capture.js";
import type { ConnectionStatus } from "../src/connection.js";
import {
  agentStep, askOzzie, buildHarnessData, checkFailure, createAppHarness, devLoop, grantedFor, LedgerRecorder, localTriggers, retryDenied, runtimeFor, StepFailure, stepFailure, StepNotes,
  type Invoke,
} from "../src/harness-bridge.js";
import { ASK_FAILURES, askFailureText, BACKGROUND_HERE, basedOnEvidence, CAN_DO_INSTEAD, CAN_DO_INSTEAD_SERVICES, canDoInstead, COMPOSED_ENDED, COMPOSED_NOTE, composedHow, ledgerDetail, taskLine } from "../src/harness-words.js";
import { MANY_SERVICES, mergedNames, mergeParts } from "../src/services-merge.js";
import { wednesdayCapture } from "../../../core/test/fixtures/service-days/wednesday.js";
import { SUNDAY_WORDS } from "../../../core/src/service-day.js";
import { buildSundayBrief, sundayShownCount } from "../../../core/src/sunday-brief.js";
import { applyDecisions } from "../../../core/src/sunday-decisions.js";
import { sundayCount } from "../src/today-groups.js";
import { crowded } from "../../../core/test/harness/fixtures.js";
import { answer, BACKGROUND_IN_REQUEST, calls, draftTurns, everyRequest, fakeNative as fakeLedger, fictionalData, greeterTurns, payloadOf, row, RULES, scripted, taskIds as ids, type Turn } from "./harness-fakes.js";
// The fixtures are a check made on 2026-11-20; the harness reads the clock, so pin it there (or the check reads as too old once that day has passed).
beforeAll(() => { vi.setSystemTime("2026-11-20T15:05:00Z"); });
afterAll(() => { vi.useRealTimers(); });

const skills = await bundledSkills();
const status = (over: Partial<ConnectionStatus> = {}): ConnectionStatus =>
  ({ state: "connected", organization: "1001", checked_at_ms: 1, source: "test", problem: null, scopes: "services-and-operations", ...over });
const harness = (model: ModelStep, recorder?: LedgerRecorder, data = fictionalData()): Harness =>
  createAppHarness({ workspace_id: "fictional", data, skills, session: new HarnessSession(), loop: "ts", step: model, ...(recorder ? { recorder } : {}) });
const hashOf = async (id: string) => skills.get(id)?.hash;
const recorder = (invoke: Invoke, over: Partial<ConstructorParameters<typeof LedgerRecorder>[0]> = {}) =>
  new LedgerRecorder({ invoke, hashFor: hashOf, newId: ids(), readyMs: 200, ...over });

// ---- agent_step ---------------------------------------------------------------------------------------

describe("the model step over native agent_step", () => {
  it("maps every native error code (a bare string) to the loop's FailureCode", () => {
    expect(stepFailure("egress")).toBe("egress");
    expect(stepFailure("limit")).toBe("limit");
    expect(stepFailure("budget")).toBe("limit");
    expect(stepFailure("not-configured")).toBe("no-model");
    expect(stepFailure("model-not-allowed")).toBe("no-model");
    // Review C9: the codes H5b added keep their meaning.
    expect(stepFailure("denied")).toBe("denied");
    expect(stepFailure("invalid-task")).toBe("invalid-task");
    expect(stepFailure("daily-limit")).toBe("limit");
    expect(stepFailure("ledger-unavailable")).toBe("transport");
    for (const code of ["rate-limited", "provider-failure", "invalid-request", "something-new", ""]) expect(stepFailure(code)).toBe("transport");
    expect(stepFailure(new Error("egress"))).toBe("transport");
    expect(stepFailure(undefined)).toBe("transport");
  });

  it("tells a spent allowance, today's allowance and an unavailable record apart in the Ask panel (review C9)", async () => {
    // A day's limit says until when: midnight UTC on this Mac's clock when no account time is known (re-check Low).
    const { dailyLimitEnds } = await import("../src/model.js");
    for (const [native, text] of [["budget", ASK_FAILURES.allowance], ["daily-limit", ASK_FAILURES.todayUntil(dailyLimitEnds()!)], ["ledger-unavailable", ASK_FAILURES.ledger],
      ["denied", ASK_FAILURES.denied], ["invalid-task", ASK_FAILURES.invalid], ["limit", ASK_FAILURES.steps],
      // Ozzie managed's own refusals each say what happened (hosted review 2026-11-14), never "couldn't finish".
      ["rate-limited", ASK_FAILURES.slowDown], ["contact-detail", ASK_FAILURES.contact], ["provider-failure", ASK_FAILURES.unfinished]] as const) {
      const notes = new StepNotes();
      const failing = fakeLedger(() => Promise.reject(native));
      const h = createAppHarness({ workspace_id: "fictional", data: fictionalData(), skills, session: new HarnessSession(), loop: "ts", step: agentStep(failing.invoke, notes) });
      const turn = await askOzzie(h, "Who could cover Greeter?", { skills, notes });
      expect(turn, native).toMatchObject({ state: "problem", text });
    }
    expect(ASK_FAILURES.ledger).toBe("Ozzie's record of its work isn't available, so it didn't ask the AI.");
    expect(`${ASK_FAILURES.today} ${ASK_FAILURES.allowance}`).toMatch(/today's allowance for AI help.*its allowance for AI help/u);
  });

  it("says a paused Ozzie managed allowance as its own message, and never retries it (hosted Ozzie)", async () => {
    expect(stepFailure("allowance-paused")).toBe("limit");
    const notes = new StepNotes();
    let asked = 0;
    const paused = fakeLedger(() => { asked += 1; return Promise.reject("allowance-paused"); });
    const h = createAppHarness({ workspace_id: "fictional", data: fictionalData(), skills, session: new HarnessSession(), loop: "ts", step: agentStep(paused.invoke, notes) });
    const turn = await askOzzie(h, "Who could cover Greeter?", { skills, notes });
    expect(turn).toEqual({ state: "problem", code: "limit", text: ASK_FAILURES.paused });
    expect(asked).toBe(1);
    // ozzie.church's 402 allowance-paused is a used month (until its date) or a pause for everyone (payments-go-live.md,
    // "For the app"); the daily ceiling and too many requests at once are 429 rate-limited, said by slowDown.
    // A subscription renews by itself, so never "nothing charges itself": nothing extra is charged.
    expect(ASK_FAILURES.paused).toBe("Ozzie's AI is paused, so Ozzie didn't ask the AI: this month's answers are used, or Ozzie's AI is pausing for everyone for a while. It starts again by itself, and nothing extra is charged. Checks, lists, Church rules and briefings keep working.");
    expect(ASK_FAILURES.paused).not.toMatch(/allowance resets|changes plan|charges itself/u);
  });

  it("says the own key's monthly pause, never \"couldn't be reached\", and never retries it (contract N5 month-limit)", async () => {
    expect(stepFailure("month-limit")).toBe("limit");
    const notes = new StepNotes();
    let asked = 0;
    const spent = fakeLedger(() => { asked += 1; return Promise.reject("month-limit"); });
    const h = createAppHarness({ workspace_id: "fictional", data: fictionalData(), skills, session: new HarnessSession(), loop: "ts", step: agentStep(spent.invoke, notes) });
    const turn = await askOzzie(h, "Who could cover Greeter?", { skills, notes });
    expect(turn).toMatchObject({ state: "problem", code: "limit" });
    expect((turn as { text: string }).text).toMatch(/^AI has paused on this Mac until [A-Z][a-z]+ 1, as your monthly limit says\. Everything else in Ozzie still works\.$/u);
    expect(asked).toBe(1);
  });

  it("says until when Ozzie's AI is paused when the account says, never \"in a minute\"", () => {
    expect(askFailureText("limit", "allowance-paused", "tomorrow, 7:00 PM")).toBe("Ozzie's AI is paused until tomorrow, 7:00 PM, so Ozzie didn't ask the AI. Checks, lists, Church rules and briefings keep working.");
    // The daily ceiling is daily-limit now (native re-check NM1): rate-limited is only "busy, try again in a minute".
    expect(askFailureText("transport", "rate-limited", "tomorrow, 7:00 PM")).toBe(ASK_FAILURES.slowDown);
    expect(askFailureText("transport", "rate-limited")).toBe(ASK_FAILURES.slowDown);
    expect(askFailureText("limit", "allowance-paused", null)).toBe(ASK_FAILURES.paused);
  });

  it("sends the request as is and throws an object with the mapped code", async () => {
    const reply: AgentStepReply = { content: "Fine.", tool_calls: [], finish: "stop" };
    const ok = fakeLedger(() => reply);
    const request: AgentStepRequest = { task_id: "00000000-0000-4000-8000-000000000001", messages: [{ role: "user", content: "Hi" }], tools: [], max_tokens: 700 };
    await expect(agentStep(ok.invoke)(request, new AbortController().signal)).resolves.toEqual(reply);
    expect(ok.log).toEqual([["agent_step", { request }]]);
    for (const [native, code] of [["egress", "egress"], ["budget", "limit"], ["not-configured", "no-model"], ["rate-limited", "transport"], ["contact-detail", "egress"],
      ["background-check", "egress"]] as const) {
      const failing = fakeLedger(() => Promise.reject(native));
      const error = await agentStep(failing.invoke)(request, new AbortController().signal).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(StepFailure);
      expect((error as StepFailure).code).toBe(code);
    }
  });

  it("gives up at once when the task is stopped", async () => {
    const never = fakeLedger(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = agentStep(never.invoke)({ task_id: "x", messages: [], tools: [], max_tokens: 1 }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "transport" });
  });
});

// ---- the ledger grammar ---------------------------------------------------------------------------------

describe("runtime events in the native ledger grammar", () => {
  it("translates every event shape the conformance suite produces", () => {
    for (const tool of NATIVE_TOOL_ALLOWLIST) {
      for (const status of ["complete", "partial", "stale", "denied", "provider-failure", "unverified"]) {
        expect(ledgerDetail("tool", `${tool}:${status}`)).toBe(`${tool} ${status}`);
      }
    }
    // A name the model chose that isn't allowlisted is never written: only its status.
    expect(ledgerDetail("tool", "unknown:denied")).toBe("denied");
    expect(ledgerDetail("tool", "email.send:denied")).toBe("denied");
    expect(ledgerDetail("tool", "sunday.open_needs:whatever")).toBeNull();
    expect(ledgerDetail("model", "step 1")).toBe("1");
    expect(ledgerDetail("model", "step 6", "tool_calls")).toBe("6 tool_calls");
    expect(ledgerDetail("model", "step 2", "stop")).toBe("2 stop");
    expect(ledgerDetail("model", "step 3", "egress")).toBe("3 egress");
    expect(ledgerDetail("model", "step 3", "nonsense")).toBe("3");
    expect(ledgerDetail("model", "step 0")).toBeNull();
    for (const code of ["invalid-task", "limit", "timeout", "egress", "fidelity", "transport", "no-model", "stale", "partial", "provider-failure", "unverified", "denied"]) {
      expect(ledgerDetail("failed", code)).toBe(code);
    }
    expect(ledgerDetail("failed", "Sam")).toBeNull();
    expect(ledgerDetail("cancelled", "cancelled")).toBe("");
    expect(ledgerDetail("verified", "")).toBe("");
    expect(ledgerDetail("admitted", "")).toBe("");
    expect(ledgerDetail("running", "")).toBe("");
  });
});

// ---- the recorder ---------------------------------------------------------------------------------------

const ledgerOnly = (log: [string, Record<string, unknown>][]) => log.filter(([c]) => c.startsWith("ledger_"));
const shape = (log: [string, Record<string, unknown>][]) => ledgerOnly(log).map(([c, a]) =>
  c === "ledger_admit" ? `admit ${a["kind"]} ${a["skillId"]}` : c === "ledger_transition" ? `to ${a["to"]}${a["code"] ? ` ${a["code"]}` : ""}` : `${a["kind"]} ${a["detail"]}`);

describe("the ledger recorder", () => {
  it("admits the task, records each tool and the outcome, but not model steps (native records those)", async () => {
    const ledger = fakeLedger();
    const r = recorder(ledger.invoke);
    const turn = await askOzzie(harness(scripted(greeterTurns).model, r), "Who could cover Greeter?", { recorder: r, skills });
    await r.idle();
    expect(turn.state).toBe("answered");
    expect(shape(ledger.log)).toEqual(["admit ask answer-from-what-was-read", "to running", "tool sunday.who_could_help complete", "to verified"]);
    const [, admit] = ledgerOnly(ledger.log)[0]!;
    expect(admit).toEqual({ taskId: expect.stringMatching(/^[0-9a-f-]{36}$/u), kind: "ask", skillId: "answer-from-what-was-read", skillHash: skills.get("answer-from-what-was-read")!.hash });
    // Name-free: nothing typed, answered or read reaches the ledger.
    expect(JSON.stringify(ledger.log)).not.toMatch(/Greeter|Riley|Thornbury|\[Person|\[Role/u);
  });

  it("is admitted and running before the first model step reaches native", async () => {
    let running = false;
    const ledger = fakeLedger(async (command, args) => {
      if (command === "ledger_transition" && args["to"] === "running") { await new Promise(r => setTimeout(r, 30)); running = true; }
      return {};
    });
    const r = recorder(ledger.invoke);
    const seen: boolean[] = [];
    const m = scripted([() => { seen.push(running); return answer("{\"answer\":\"not-covered\"}"); }]);
    const turn = await askOzzie(harness(m.model, r), "What still needs a decision this Sunday?", { recorder: r, skills });
    expect(turn.state).toBe("answered");
    expect(seen).toEqual([true]);
  });

  it("can record model steps with their outcome when switched on", async () => {
    const ledger = fakeLedger();
    const r = recorder(ledger.invoke, { recordModelEvents: true });
    await askOzzie(harness(scripted(greeterTurns).model, r), "Who could cover Greeter?", { recorder: r, skills });
    await r.idle();
    expect(shape(ledger.log)).toEqual(["admit ask answer-from-what-was-read", "to running", "model 1 tool_calls", "tool sunday.who_could_help complete", "model 2 stop", "to verified"]);
    const failing = fakeLedger();
    const r2 = recorder(failing.invoke, { recordModelEvents: true });
    await askOzzie(harness(scripted([() => new StepFailure("no-model")]).model, r2), "Who could cover Greeter?", { recorder: r2, skills });
    await r2.idle();
    expect(shape(failing.log)).toEqual(["admit ask answer-from-what-was-read", "to running", "model 1 no-model", "to failed no-model"]);
  });

  it("never breaks the task when the ledger is unavailable, and logs only fixed codes", async () => {
    const lines: string[] = [];
    const ledger = fakeLedger(() => Promise.reject("unavailable"));
    const r = recorder(ledger.invoke, { log: line => lines.push(line) });
    const turn = await askOzzie(harness(scripted(greeterTurns).model, r), "Who could cover Greeter?", { recorder: r, skills });
    await r.idle();
    expect(turn.state).toBe("answered");
    // After a failed admit nothing else is tried for that task.
    expect(shape(ledger.log)).toEqual(["admit ask answer-from-what-was-read"]);
    expect(lines).toEqual(["ledger: admit unavailable"]);
    // A throwing invoke and a strange rejection are handled the same way.
    const throwing = recorder(() => { throw new Error("Riley Thornbury"); }, { log: line => lines.push(line) });
    expect((await askOzzie(harness(scripted(greeterTurns).model, throwing), "Who could cover Greeter?", { recorder: throwing, skills })).state).toBe("answered");
    await throwing.idle();
    expect(lines.at(-1)).toBe("ledger: admit unknown");
    expect(lines.join("\n")).not.toMatch(/Riley|Greeter/u);
  });

  it("never holds up the task when the ledger stalls", async () => {
    const ledger = fakeLedger(() => new Promise(() => {}));
    const r = recorder(ledger.invoke, { readyMs: 20 });
    const started = Date.now();
    const turn = await askOzzie(harness(scripted(greeterTurns).model, r), "Who could cover Greeter?", { recorder: r, skills });
    expect(turn.state).toBe("answered");
    // Waiting for the ledger to catch up is bounded too (the autopilot waits on it).
    await r.idle(30);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("keeps going when an event is refused, and still records the outcome", async () => {
    const ledger = fakeLedger((command) => command === "ledger_event" ? Promise.reject("full") : {});
    const lines: string[] = [];
    const r = recorder(ledger.invoke, { log: line => lines.push(line) });
    await askOzzie(harness(scripted(greeterTurns).model, r), "Who could cover Greeter?", { recorder: r, skills });
    await r.idle();
    expect(shape(ledger.log).at(-1)).toBe("to verified");
    expect(lines).toEqual(["ledger: event full"]);
  });

  it("records a task the harness refused before any step as running then failed", async () => {
    const ledger = fakeLedger();
    const r = recorder(ledger.invoke);
    const observer = r.task("ask", "answer-from-what-was-read");
    observer.onEvent({ task_id: "00000000-0000-4000-8000-0000000000aa", sequence: 1, at: "2026-11-20T15:05:00Z", type: "failed", detail: "egress" });
    await r.idle();
    expect(shape(ledger.log)).toEqual(["admit ask answer-from-what-was-read", "to running", "to failed egress"]);
    // Cancelled straight from admitted.
    const cancelled = fakeLedger();
    const r2 = recorder(cancelled.invoke);
    const o2 = r2.task("skill", "sunday-ready");
    const ev = (type: TaskEvent["type"], sequence: number, detail = ""): TaskEvent => ({ task_id: "00000000-0000-4000-8000-0000000000bb", sequence, at: "x", type, detail });
    o2.onEvent(ev("admitted", 1)); o2.onEvent(ev("cancelled", 2));
    await r2.idle();
    expect(shape(cancelled.log)).toEqual(["admit skill sunday-ready", "to cancelled"]);
  });

  it("records nothing for a question refused before anything was sent", async () => {
    const ledger = fakeLedger();
    const r = recorder(ledger.invoke);
    const turn = await askOzzie(harness(scripted([]).model, r), "What's Riley Thornbury's phone number? Call 555-123-4567", { recorder: r, skills });
    await r.idle();
    expect(turn).toEqual({ state: "refused", text: REFUSALS.contact });
    expect(ledger.log).toEqual([]);
  });
});

// ---- Sunday checks --------------------------------------------------------------------------------------

describe("Sunday checks in the ledger", () => {
  const capture = nov22Capture();
  it("records each check as a check task under Sunday ready, with no model", async () => {
    const ledger = fakeLedger();
    const store = new Map<string, string>();
    const triggers = localTriggers({ getItem: k => store.get(k) ?? null, setItem: (k, v) => { store.set(k, v); } });
    const r = recorder(ledger.invoke, { triggers });
    await expect(r.check(async () => capture, "manual")).resolves.toBe(capture);
    const partial: SundayCapture = { ...capture, reads: [...capture.reads, { ...capture.reads[0]!, outcome: "failed" }] };
    await r.check(async () => partial);
    await expect(r.check(() => Promise.reject("not-connected"))).rejects.toBe("not-connected");
    await expect(r.check(() => Promise.reject("rate-limited"))).rejects.toBe("rate-limited");
    await r.idle();
    // Each task's calls are in order; different tasks may interleave.
    const tasks = [...new Set(ledgerOnly(ledger.log).map(([, a]) => a["taskId"] as string))];
    expect(tasks.map(id => shape(ledger.log.filter(([, a]) => a["taskId"] === id)))).toEqual([
      ["admit check sunday-ready", "to running", "tool planning_center.refresh complete", "to verified"],
      ["admit check sunday-ready", "to running", "tool planning_center.refresh partial", "to verified"],
      ["admit check sunday-ready", "to running", "to failed denied"],
      ["admit check sunday-ready", "to running", "to failed provider-failure"],
    ]);
    expect(ledgerOnly(ledger.log)[0]![1]["skillHash"]).toBe(skills.get("sunday-ready")!.hash);
    expect(ledger.log.some(([c]) => c === "agent_step")).toBe(false);
    const [first, second] = tasks as [string, string];
    expect(triggers.get(first)).toBe("manual");
    expect(triggers.get(second)).toBe("automatic");
  });

  it("never fails or delays a check when the ledger does", async () => {
    const r = recorder(fakeLedger(() => new Promise(() => {})).invoke);
    await expect(r.check(async () => capture)).resolves.toBe(capture);
    const broken = recorder(() => { throw new Error("boom"); });
    await expect(broken.check(async () => capture)).resolves.toBe(capture);
    expect(checkFailure("invalid-credentials")).toBe("denied");
    expect(checkFailure({ sunday_check: "timeout" })).toBe("provider-failure");
  });

  it("records why a check failed true to its cause, never 'couldn't be reached' when Planning Center was reached", () => {
    for (const [error, code] of [
      // No sign-in Ozzie could use: none connected, one that couldn't be renewed, or the Mac refused it.
      ["not-connected", "denied"], [{ "sunday-check": "missing-credentials" }, "denied"],
      [{ "sign-in-not-renewed": "invalid-credentials" }, "denied"], [{ authentication: "invalid-token" }, "denied"],
      [{ "sunday-check": "denied" }, "denied"], [{ "sign-in-not-renewed": "store-unavailable" }, "denied"],
      // Ozzie couldn't confirm which church the sign-in belongs to.
      [{ "sunday-check": "organization-unverified" }, "unverified"], [{ "sign-in-not-renewed": "organization-unverified" }, "unverified"],
      [{ authentication: "organization-unverified" }, "unverified"],
      // The sign-in was busy (another read, a sign-in, Disconnect) or this Mac's credential storage was locked.
      [{ "sunday-check": "busy" }, "cancelled"], [{ "sign-in-not-renewed": "busy" }, "cancelled"], [{ "sunday-check": "cancelled" }, "cancelled"],
      [{ "sign-in-not-renewed": "cancelled" }, "cancelled"], [{ "sign-in-not-renewed": "locked" }, "cancelled"], [{ "sunday-check": "locked" }, "cancelled"],
      [{ authentication: { store: "locked" } }, "cancelled"],
      // Planning Center out of reach, and anything not known.
      [{ "sign-in-not-renewed": "provider-failure" }, "provider-failure"], [{ "sunday-check": "provider-failure" }, "provider-failure"], [undefined, "provider-failure"],
    ] as const) expect(checkFailure(error), JSON.stringify(error)).toBe(code);
  });
});

// ---- HarnessData ------------------------------------------------------------------------------------------

describe("HarnessData from the app's state", () => {
  const capture = withFictionalOperations(nov22Capture());
  const base = { rules: RULES, decisions: [], now: "2026-11-20T15:05:00Z" };
  const refresh = async () => fictionalData();

  it("the fictional example: everything granted, its own import, never a real Planning Center check", () => {
    const data = buildHarnessData({ ...base, capture, fictional: true, status: status(), configured: true }, refresh);
    expect(data.mode).toBe("fictional");
    expect(data.granted).toEqual(["services", "operations"]);
    expect(data.attention?.ok).toBe(true);
    expect(data.connected).toBe(false);
    expect(data.refresh).toBeUndefined();
    expect(data.brief?.mode).toBe("fictional");
    expect(data.operations).not.toBeNull();
  });

  it("a live check: the verified scopes, and a fresh check only with a usable connection", () => {
    const live = { ...capture, kind: "live" as const };
    const both = buildHarnessData({ ...base, capture: live, fictional: false, status: status(), configured: true }, refresh);
    expect(both.mode).toBe("live");
    expect(both.granted).toEqual(["services", "operations"]);
    expect(both.attention).toBeNull();
    expect(both.connected).toBe(true);
    expect(both.refresh).toBe(refresh);
    const servicesOnly = buildHarnessData({ ...base, capture: live, fictional: false, status: status({ scopes: "services" }), configured: true }, refresh);
    expect(servicesOnly.granted).toEqual(["services"]);
    const signedOut = buildHarnessData({ ...base, capture: live, fictional: false, status: status({ state: "disconnected" }), configured: true }, refresh);
    expect(signedOut.connected).toBe(false);
    expect(signedOut.refresh).toBeUndefined();
    expect(buildHarnessData({ ...base, capture: live, fictional: false, status: status(), configured: false }, refresh).connected).toBe(false);
  });

  it("a saved recording: recording mode; scopes from what the check itself read until the connection is verified", () => {
    const recording = { ...capture, kind: "recording" as const };
    const data = buildHarnessData({ ...base, capture: recording, fictional: false, status: null, configured: true });
    expect(data.mode).toBe("recording");
    expect(data.granted).toEqual(["services", "operations"]);
    expect(data.connected).toBe(false);
    expect(grantedFor({ ...withFictionalOperationsOff(nov22Capture()), kind: "recording" }, false, null)).toEqual(["services"]);
  });

  it("nothing checked yet", () => {
    const data = buildHarnessData({ ...base, capture: null, fictional: false, status: null, configured: false });
    expect(data).toMatchObject({ capture: null, brief: null, operations: null, mode: "live", granted: ["services"] });
  });
});

// ---- Ask Ozzie through the harness -------------------------------------------------------------------------

describe("Ask Ozzie as a harness task", () => {
  for (const loop of ["pi", "ts"] as const) {
    it(`gives a verified answer restored on this Mac, with its sources, procedure and steps (${loop})`, async () => {
      const h = createAppHarness({ workspace_id: "fictional", data: fictionalData(), skills, session: new HarnessSession(), loop, step: scripted(greeterTurns).model });
      const turn = await askOzzie(h, "Who could cover Greeter?", { skills, sender: "Pat" });
      if (turn.state !== "answered") throw new Error(turn.state);
      expect(turn.answer.body).toBe("Riley Thornbury has no overlap found for Greeter.\n\nThat doesn't mean they're free or willing; only they can say.");
      expect(turn.answer.basedOn).toMatch(/^Based on: fictional example data as of /u);
      expect(turn.answer.procedure).toEqual({ title: "Answer from what was read", body: skills.get("answer-from-what-was-read")!.body });
      // What it looked at; asking the AI and checking its choice are said apart (harness-words aiText).
      expect(turn.answer.steps).toEqual(["Looked at who is on the team for an open role — all of it"]);
      expect(turn.answer.aiSteps).toBe(2);
      expect(turn.answer.end).toBe("facts");
      expect(turn.answer.notCovered).toBe(false);
      expect(turn.answer.draft).toBeNull();
    });
  }

  it("splits a drafted note out, greeting by first name and signing with the sender", async () => {
    const h = harness(scripted(draftTurns).model);
    const turn = await askOzzie(h, "Draft a note to someone who could cover Greeter", { skills, sender: "Pat" });
    if (turn.state !== "answered") throw new Error(turn.state);
    expect(turn.answer.body).toBe("Here is a draft for you to read, change and send yourself. Nothing has been sent.\n\nRiley Thornbury has no overlap found for Greeter.\n\nThat doesn't mean they're free or willing; only they can say.");
    expect(turn.answer.draft).toMatch(/^Hi Riley,/u);
    expect(turn.answer.draft).toMatch(/Thank you,\nPat$/u);
  });

  it("says plainly why a question couldn't be answered", async () => {
    const run = async (turns: Turn[]) => askOzzie(harness(scripted(turns).model), "Who could cover Greeter?", { skills });
    expect(await run([() => new StepFailure("no-model")])).toEqual({ state: "no-model" });
    expect(await run([() => new StepFailure("egress")])).toEqual({ state: "problem", code: "egress", text: ASK_FAILURES.egress });
    expect(await run([() => answer("[Person 99] could help.")])).toEqual({ state: "problem", code: "fidelity", text: ASK_FAILURES.fidelity });
    expect(await run([() => new StepFailure("transport")])).toEqual({ state: "problem", code: "transport", text: ASK_FAILURES.unfinished });
    expect(await run([() => new StepFailure("limit")])).toEqual({ state: "problem", code: "limit", text: ASK_FAILURES.steps });
    expect(ASK_FAILURES.egress).toMatch(/^That question includes details Ozzie keeps on this Mac/u);
    expect(ASK_FAILURES.fidelity).toMatch(/^Ozzie couldn't back that answer up with what it read, so it isn't shown\. /u);
    expect(ASK_FAILURES.unfinished).toBe("Ozzie couldn't finish that just now.");
  });

  it("says plainly, on AI on this Mac only, that it misses more often and what helps (measured 2026-11-18)", async () => {
    const run = async (turns: Turn[], local?: boolean) =>
      askOzzie(harness(scripted(turns).model), "Who could cover Greeter?", { skills, ...(local === undefined ? {} : { local }) });
    const unbacked = () => answer('{"answer":"facts","facts":["f4"]}');
    expect(await run([unbacked], true)).toEqual({ state: "problem", code: "fidelity", text: `${ASK_FAILURES.fidelity} ${ASK_FAILURES.fidelityHere}` });
    expect(ASK_FAILURES.fidelityHere).toBe("AI on this Mac misses more often than an AI company's. A key from an AI company, in Settings › AI help, gives steadier answers.");
    // An AI company, Ozzie's AI, or a route not known: the sentence as it was.
    for (const local of [false, undefined]) expect(await run([unbacked], local)).toEqual({ state: "problem", code: "fidelity", text: ASK_FAILURES.fidelity });
    // Every other failure on this Mac keeps its own words.
    expect(await run([() => new StepFailure("egress")], true)).toEqual({ state: "problem", code: "egress", text: ASK_FAILURES.egress });
    expect(await run([() => new StepFailure("limit")], true)).toEqual({ state: "problem", code: "limit", text: ASK_FAILURES.steps });
  });

  it("stops when the person cancels", async () => {
    const controller = new AbortController();
    const h = harness(() => new Promise(() => {}));
    const pending = askOzzie(h, "Who could cover Greeter?", { skills, signal: controller.signal });
    controller.abort();
    expect(await pending).toEqual({ state: "cancelled", text: ASK_FAILURES.cancelled });
  });

  it("uses the Pi loop; the plain loop only through the debug-only setting", () => {
    expect(runtimeFor("pi").name).toBe("pi");
    expect(runtimeFor("ts").name).toBe("ts");
    const store = new Map<string, string>([["ozzie.dev.loop", "ts"]]);
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } });
    try {
      expect(devLoop.get(false)).toBe("pi");
      expect(devLoop.get(true)).toBe("ts");
      devLoop.set("pi");
      expect(devLoop.get(true)).toBe("pi");
    } finally { vi.unstubAllGlobals(); }
  });
});

describe("retrying a reply native dropped as denied", () => {
  it("tries once more after denied, and only once", async () => {
    const { retryDenied } = await import("../src/harness-bridge.js");
    let calls = 0;
    const ok = await retryDenied(async () => { calls++; if (calls === 1) throw "denied"; return "reply"; }, new AbortController().signal);
    expect([ok, calls]).toEqual(["reply", 2]);
    calls = 0;
    await expect(retryDenied(async () => { calls++; throw "denied"; }, new AbortController().signal)).rejects.toBe("denied");
    expect(calls).toBe(2);
  });
  it("doesn't retry other failures or after a cancel", async () => {
    const { retryDenied } = await import("../src/harness-bridge.js");
    let calls = 0;
    await expect(retryDenied(async () => { calls++; throw "egress"; }, new AbortController().signal)).rejects.toBe("egress");
    const c = new AbortController(); c.abort();
    await expect(retryDenied(async () => { calls++; throw "denied"; }, c.signal)).rejects.toBe("denied");
    expect(calls).toBe(2);
  });
});

// ---- Answers written on this Mac (release-app rehearsal, Nov 15) -------------------------------------------------

describe("Ask answers written on this Mac", () => {
  /** The test organization's shape: Nursery's position is "Nursery volunteer", marked as a kids team with Lyrics; the Sanctuary isn't shared. */
  const kidsCapture = (): SundayCapture => JSON.parse(JSON.stringify(withFictionalOperations(withFictionalBackgroundChecks(nov22Capture())))
    .split("\"Nursery\"").join("\"Nursery volunteer\"")) as SundayCapture;
  const kidsRules = { ...RULES, kidsTeams: [{ team_id: TEAMS.nursery, min_confirmed: 2 }, { team_id: TEAMS.lyrics, min_confirmed: 1 }],
    rooms: [{ room_id: FICTIONAL_ROOM, exclusive: true, setup_minutes: 15 }] };
  const kidsData = () => buildHarnessData({ capture: kidsCapture(), fictional: false, rules: kidsRules, decisions: [], status: null, configured: false, now: "2026-11-20T15:05:00Z" });

  it("answers “Is the nursery ready for Sunday?” here, without the AI, with the background check kept on this Mac and where it came from", async () => {
    const m = scripted([]);
    const native = fakeLedger();
    const kept = new Map<string, string>();
    const rec = recorder(native.invoke, { triggers: { get: id => kept.get(id) as never, set: (id, t) => { kept.set(id, t); }, end: () => undefined, setEnd: () => {} } });
    const turn = await askOzzie(harness(m.model, undefined, kidsData()), "Is the nursery ready for Sunday?", { skills, recorder: rec });
    // When Ozzie checked, on this Mac's own clock (polish 4); the service time stays on the church's.
    const checkedOnThisMac = showTimes(checkTime(kidsData().brief!.findings.find(f => f.kind === "background-check")!.checked_at!));
    if (turn.state !== "answered") throw new Error(turn.state);
    expect(m.requests).toHaveLength(0);
    // Recorded in What happened as a question answered on this Mac: name-free, the same task record as any question (review Q L3).
    await rec.idle();
    expect(native.log.map(([c, a]) => [c, a["detail"] ?? a["to"] ?? a["kind"] ?? null])).toEqual([["ledger_admit", "ask"], ["ledger_transition", "running"],
      ["ledger_event", "sunday.overview complete"], ["ledger_event", "sunday.open_needs complete"], ["ledger_transition", "verified"]]);
    expect(JSON.stringify(native.log)).not.toMatch(/nursery|Blake|background/iu);
    expect([...kept.values()]).toEqual(["on-this-mac"]);
    expect(taskLine(row({ kind: "ask", state: "verified", events: [{ task_id: "x", sequence: 3, at: "2026-11-20T21:42:01Z", type: "tool", detail: "sunday.overview complete" }] }),
      { trigger: "on-this-mac", now: new Date("2026-11-20T22:00:00Z") })).toMatch(/^Answered on this Mac · checked · 1 thing looked at · /u);
    const a = turn.answer;
    expect(a.local).toBe(true);
    expect(a.aiSteps).toBe(0);
    expect(a.body.split("\n\n")).toEqual([
      expect.stringMatching(/^Needs a decision: Nursery volunteer at 9:30 AM on November 22 still needs 1 more person, by Planning Center's count\. Already confirmed: Blake Ashgrove\./u),
      expect.stringMatching(/^Needs a decision: Nursery volunteer at 9:30 AM on November 22 has 1 confirmed person, and your Church rules ask for at least 2\./u),
      expect.stringMatching(new RegExp(`^Needs a decision: Blake Ashgrove has no current background check on file\\. .* From Planning Center People, checked ${checkedOnThisMac}\\. Kept on this Mac; never sent to an AI\\.$`, "u")),
    ]);
    expect(a.basedOn).toMatch(/^Based on: Planning Center Services and People, checked [^;]+; your Church rules$/u);
    expect(a.steps).toEqual(["Looked at the overview of the last check — all of it", "Looked at the open roles in the last check — all of it", "Looked at background checks, kept on this Mac"]);
    expect(a.notCovered).toBe(false);
    expect(a.body).not.toMatch(/\[(?:Person|Role) \d+\]/u);
  });

  it("still refuses what may not be asked before answering anything here", async () => {
    const m = scripted([]);
    const h = harness(m.model, undefined, kidsData());
    expect(await askOzzie(h, "Rank the nursery volunteers", { skills })).toEqual({ state: "refused", text: REFUSALS.rank });
    expect(await askOzzie(h, "Write a prayer for the nursery", { skills })).toEqual({ state: "refused", text: REFUSALS.religious });
    expect(await askOzzie(h, "Text the nursery team", { skills })).toEqual({ state: "refused", text: REFUSALS.send });
    expect(m.requests).toHaveLength(0);
  });

  it("adds the open decisions a decision question's answer left out, in fixed words, with their sources; background checks never reach the AI", async () => {
    // The answer chose the roles and kids teams that need a decision, not the overview's room overlap or follow-up.
    const m = scripted([
      () => ({ content: "", tool_calls: [{ id: "c", name: "sunday.overview", arguments: "{}" }], finish: "tool_calls" }),
      r => answer(JSON.stringify({ answer: "facts", facts: ((JSON.parse(r.messages.at(-1)!.content) as { payload: { findings: { fact: string; tone: string; kind: string }[] } }).payload.findings)
        .filter(f => f.tone === "needs a decision" && f.kind !== "room use needs review" && f.kind !== "needs an owner").map(f => f.fact) })),
    ]);
    const turn = await askOzzie(harness(m.model, undefined, kidsData()), "What still needs a decision this Sunday?", { skills });
    if (turn.state !== "answered") throw new Error(turn.state);
    const parts = turn.answer.body.split("\n\n");
    // One label line for the rows the answer chose, none on each row; with no overview sentence chosen, each keeps its date.
    expect(parts.slice(0, 5)).toEqual([
      "Needs a decision:",
      expect.stringMatching(/^Greeter at 9:30 AM on November 22 still needs 1 more person/u),
      expect.stringMatching(/^Nursery volunteer at 9:30 AM on November 22 still needs 1 more person/u),
      expect.stringMatching(/^Nursery volunteer at 9:30 AM on November 22 has 1 confirmed person/u),
      expect.stringMatching(/^Lyrics at 9:30 AM on November 22 has no confirmed people/u),
    ]);
    // The heading says each of these needs a decision, so none says it again (owner's read of 0.3.2).
    expect(parts.slice(5)).toEqual([
      "Also on the Services page, needing a decision:",
      expect.stringMatching(/^Blake Ashgrove has no current background check on file\..*Kept on this Mac; never sent to an AI\.$/u),
      expect.stringMatching(/^Cameron Larkspur's background check on file expires before Sunday\..*Kept on this Mac; never sent to an AI\.$/u),
      expect.stringMatching(/^Room use needs review: Sanctuary \(fictional\) has bookings that overlap on November 22 from 10:30 AM to 11:00 AM; the bookings are from /u),
      "Welcome follow-up (fictional), step Call a first-time guest, was due 5:27 PM on October 26 and has no owner.",
    ]);
    expect(turn.answer.added).toBe(true);
    expect(turn.answer.basedOn).toMatch(/^Based on: Planning Center Services, Calendar and People, checked [^;]+$/u);
    expect(turn.answer.steps).toEqual(["Looked at the overview of the last check — all of it",
      "Looked at room bookings — all of it", "Looked at follow-ups without an owner — all of it", "Looked at background checks, kept on this Mac"]);
    expect(JSON.stringify(m.requests)).not.toMatch(/background/iu);
  });

  it("never says nothing needs a decision while the room and the follow-up still need one", async () => {
    // Every Services role filled, while the room and the follow-up still need a decision: the overview counts them, as the
    // Sunday page does (live review 2026-11-18), so "nothing needs a decision" is refused, and its facts say them.
    const capture = withFictionalOperations(nov22Capture());
    capture.reads = capture.reads.map(r => r.collection === "needed_positions" ? { ...r, body: { ...r.body!, data: [] } } : r);
    const data = buildHarnessData({ capture, fictional: false, rules: { ...RULES, rooms: kidsRules.rooms }, decisions: [], status: null, configured: false, now: "2026-11-20T15:05:00Z" });
    expect(data.brief!.findings.filter(f => f.tone === "decision")).toEqual([]);
    const look: Turn = () => ({ content: "", tool_calls: [{ id: "c", name: "sunday.overview", arguments: "{}" }], finish: "tool_calls" });
    const nothing = await askOzzie(harness(scripted([look, () => answer('{"answer":"nothing-needs-a-decision"}')]).model, undefined, data), "Is there anything I need to decide?", { skills });
    expect(nothing).toMatchObject({ state: "problem", code: "fidelity" });
    const every: Turn = r => { const p = payloadOf(r, "sunday.overview") as { fact: string; findings: { fact: string; tone: string }[] };
      return answer(JSON.stringify({ answer: "facts", facts: [p.fact, ...p.findings.filter(f => f.tone === "needs a decision").map(f => f.fact)] })); };
    const turn = await askOzzie(harness(scripted([look, every]).model, undefined, data), "Is there anything I need to decide?", { skills });
    if (turn.state !== "answered") throw new Error(turn.state);
    const parts = turn.answer.body.split("\n\n");
    expect(parts[0]).toBe("For Sunday, November 22, 2 things need a decision and 3 are worth a look.");
    expect(parts.slice(1)).toEqual(["Needs a decision:", expect.stringMatching(/^Sanctuary \(fictional\) has bookings that overlap from 10:30 AM to 11:00 AM\.$/u),
      expect.stringMatching(/^.* has no owner\.$/u)]);
    expect(turn.answer.added).toBeUndefined();
  });

  it("says what Ozzie can do instead when it can't tell, or couldn't back an answer up", async () => {
    const m = scripted([() => answer('{"answer":"not-covered"}')]);
    const turn = await askOzzie(harness(m.model), "When is the youth retreat?", { skills });
    if (turn.state !== "answered") throw new Error(turn.state);
    expect(turn.answer.body.split("\n\n")).toEqual(["Ozzie can't tell from what it read.", CAN_DO_INSTEAD]);
    expect(ASK_FAILURES.fidelity).toContain("What can you do?");
  });

  it("with more than one service watched, what Ozzie can do instead speaks of the services it watches (polish 3, item 1)", async () => {
    const one = fictionalData();
    const wed = wednesdayCapture();
    const other = buildSundayBrief(wed, RULES, wed.completed_at);
    const m = mergeParts({ brief: one.brief!, decisions: [] }, [{ plan_id: "94000001", brief: other, decisions: [] }]);
    const several = { ...one, capture: mergedNames(one.capture!, [wed]), brief: m.brief, decisions: m.decisions };
    const turn = await askOzzie(harness(scripted([() => answer('{"answer":"not-covered"}')]).model, undefined, several), "When is the youth retreat?", { skills });
    if (turn.state !== "answered") throw new Error(turn.state);
    expect(turn.answer.body.split("\n\n")).toEqual(["Ozzie can't tell from what it read.", CAN_DO_INSTEAD_SERVICES]);
    expect(CAN_DO_INSTEAD_SERVICES).toContain("for the services it watches");
    expect(CAN_DO_INSTEAD_SERVICES.replace("the services it watches", "the service it watches")).toBe(CAN_DO_INSTEAD);
    // One service, or a single plan whose times fall on several days (it has its dates), keeps the one service's words.
    expect(canDoInstead(one.brief!.day)).toBe(CAN_DO_INSTEAD);
    expect(canDoInstead(MANY_SERVICES)).toBe(CAN_DO_INSTEAD_SERVICES);
    expect(canDoInstead({ ...MANY_SERVICES, day: "these services", date: "Wednesday, November 25 to Sunday, November 29" })).toBe(CAN_DO_INSTEAD);
    expect(canDoInstead(null)).toBe(CAN_DO_INSTEAD);
  });
});

describe("background checks never reach the AI, by any Ask path (review Q H2)", () => {
  const kidsCapture = (): SundayCapture => JSON.parse(JSON.stringify(withFictionalOperations(withFictionalBackgroundChecks(nov22Capture())))
    .split("\"Nursery\"").join("\"Nursery volunteer\"")) as SundayCapture;
  const kidsRules = { ...RULES, kidsTeams: [{ team_id: TEAMS.nursery, min_confirmed: 2 }, { team_id: TEAMS.lyrics, min_confirmed: 1 }],
    rooms: [{ room_id: FICTIONAL_ROOM, exclusive: true, setup_minutes: 15 }] };
  const kidsData = (now = "2026-11-20T15:05:00Z") => buildHarnessData({ capture: kidsCapture(), fictional: false, rules: kidsRules, decisions: [], status: null, configured: false, now });
  /** A model that would answer anything: if any of these questions reached it, the test would see the request. */
  const anyModel = () => scripted([() => calls(["sunday.overview"]), () => answer('{"answer":"not-covered"}')]);

  it("answers questions naming a background check, or its usual names, on this Mac with nothing sent", async () => {
    for (const q of ["Any background check problems?", "Is Blake Ashgrove's clearance current?", "Has Cameron been screened?", "Does Blake have a DBS?", "Is the safeguarding check done?",
      "Was Blake fingerprinted?", "Is Blake cleared to serve in the nursery?", "Blake's check expired, who else can cover the nursery?", "Has anyone been vetted for the kids?",
      "Does Greeter have background checks?"]) {
      const m = anyModel();
      const turn = await askOzzie(harness(m.model, undefined, kidsData()), q, { skills });
      expect(m.requests, q).toHaveLength(0);
      if (turn.state !== "answered") throw new Error(`${q}: ${turn.state}`);
      expect(turn.answer.local, q).toBe(true);
      expect(turn.answer.body, q).toMatch(/background check/u);
    }
  });

  it("never drafts a note about a background check with AI help: the facts here, and the note left to the leader", async () => {
    for (const q of ["Draft a note to Blake Ashgrove saying his background check expired and he can't serve in the nursery", "Write a message to Cameron about her clearance"]) {
      const m = anyModel();
      const turn = await askOzzie(harness(m.model, undefined, kidsData()), q, { skills });
      expect(m.requests, q).toHaveLength(0);
      if (turn.state !== "answered") throw new Error(`${q}: ${turn.state}`);
      const parts = turn.answer.body.split("\n\n");
      expect(parts[0]).toBe(REFUSALS.backgroundNote);
      expect(parts.slice(1)).toEqual([expect.stringMatching(/^Needs a decision: Blake Ashgrove has no current background check on file\./u),
        expect.stringMatching(/^Needs a decision: Cameron Larkspur's background check on file expires before Sunday\./u)]);
      expect(turn.answer.draft).toBeNull();
    }
    // Asking to send one is refused as any send is, and nothing is sent either.
    const m = anyModel();
    expect(await askOzzie(harness(m.model, undefined, kidsData()), "Text Blake that his background check expired", { skills })).toEqual({ state: "refused", text: REFUSALS.send });
    expect(m.requests).toHaveLength(0);
  });

  it("answers a whole-Sunday decision question that names background checks with every open decision, here", async () => {
    for (const q of ["What still needs a decision this Sunday? Any background check issues?", "Is everything ready? Any background checks missing?"]) {
      const m = anyModel();
      const turn = await askOzzie(harness(m.model, undefined, kidsData()), q, { skills });
      expect(m.requests, q).toHaveLength(0);
      if (turn.state !== "answered") throw new Error(turn.state);
      const parts = turn.answer.body.split("\n\n");
      // It says first why it was answered here (review B2 L-3).
      expect(parts.slice(0, 2)).toEqual([BACKGROUND_HERE, "On the Services page, needing a decision:"]);
      expect(parts.join(" ")).toMatch(/Greeter at 9:30 AM.*Blake Ashgrove has no current background check.*Room use needs review.*has no owner\./su);
    }
  });

  it("says first why a background-check question wasn't sent, then that no kids team is marked when none is (reviews B2 L-3, B3 L-2)", async () => {
    // The fictional Sunday marks no kids team, as a new church's doesn't: that note is why there are no background checks
    // to show, and how to get them, so it answers these.
    for (const q of ["Any background check problems?", "Who on the kids team has a background check that expired?", "Is Riley cleared to teach?",
      "Who will run the bg-check table?", "Is this check out of date?", "Has Cameron been screened?", "Who is on the Safe Sanctuaries team for the kids?"]) {
      const m = anyModel();
      const turn = await askOzzie(harness(m.model), q, { skills });
      expect(m.requests, q).toHaveLength(0);
      if (turn.state !== "answered") throw new Error(`${q}: ${turn.state}`);
      expect(turn.answer.body.split("\n\n"), q).toEqual([BACKGROUND_HERE, NO_KIDS_TEAM]);
      expect(turn.answer.local, q).toBe(true);
      expect(turn.answer.draft, q).toBeNull();
    }
    // With kids teams marked, the background checks themselves under the same first line, and never the kids-team note.
    const m = anyModel();
    const turn = await askOzzie(harness(m.model, undefined, kidsData()), "Any background check problems?", { skills });
    if (turn.state !== "answered") throw new Error(turn.state);
    expect(turn.answer.body.split("\n\n")[0]).toBe(BACKGROUND_HERE);
    expect(turn.answer.body).toMatch(/Blake Ashgrove has no current background check on file/u);
    expect(turn.answer.body).not.toContain(NO_KIDS_TEAM);
    expect(m.requests).toHaveLength(0);
    // Team and policy names that read like child-safety screening are refused too (when in doubt, refuse), and say so: with
    // nothing about checks or kids, nothing written here answers them, so nothing is shown beside the refusal, with or
    // without kids teams (reviews B2 L-3, B3 N-2).
    for (const data of [fictionalData(), kidsData()]) {
      for (const q of ["Who is on the Safe Sanctuaries team?", "Is there a sex offender policy for Sunday?", "Where is our registered offender policy?",
        "Who is leading the finger print art craft?", "Has the background come back from the printer?", "Is Blake a registered sex offender?",
        "Did Blake's background come back?", "Is the offender registry open on Sunday?"]) {
        const sent = anyModel();
        expect(await askOzzie(harness(sent.model, undefined, data), q, { skills }), q).toEqual({ state: "refused", text: REFUSALS.background });
        expect(sent.requests, q).toHaveLength(0);
      }
    }
    expect(REFUSALS.background).toBe("Ozzie doesn't send questions with background-check or child-safety screening wording to the AI, so this one wasn't sent. "
      + "Ask about the team by its role instead, or look at the Services page.");
  });

  it("keeps the kids-team note beside a background-check note request when no kids team is marked, and refuses other note wording plainly", async () => {
    const m = anyModel();
    const turn = await askOzzie(harness(m.model), "Draft a note to Blake Ashgrove saying his background check expired", { skills });
    expect(m.requests).toHaveLength(0);
    if (turn.state !== "answered") throw new Error(turn.state);
    expect(turn.answer.body.split("\n\n")).toEqual([REFUSALS.backgroundNote, NO_KIDS_TEAM]);
    expect(turn.answer.draft).toBeNull();
    for (const data of [fictionalData(), kidsData()]) {
      const sent = anyModel();
      expect(await askOzzie(harness(sent.model, undefined, data), "Write a message to the Safe Sanctuaries team about Sunday", { skills }))
        .toEqual({ state: "refused", text: REFUSALS.backgroundNoteAlone });
      expect(sent.requests).toHaveLength(0);
    }
  });

  it("refuses every question the shared list holds, with or without kids teams, sends nothing, and shows the kids-team note only under why", async () => {
    const vectors = JSON.parse(readFileSync(new URL("../../../core/test/harness/background-wording-vectors.json", import.meta.url), "utf8")) as Record<string, string[]>;
    const questions = [...vectors["match"]!, ...vectors["refused_on_purpose"]!];
    expect(questions.length).toBeGreaterThan(150);
    const byThisList = new Set<string>([REFUSALS.background, REFUSALS.backgroundNoteAlone]);
    const answeredFirst = new Set<string>([BACKGROUND_HERE, REFUSALS.backgroundNote]);
    let refused = 0, answered = 0, noted = 0;
    for (const [data, kidsMarked] of [[fictionalData(), false], [kidsData(), true]] as const) {
      for (const q of questions) {
        const m = anyModel();
        const turn = await askOzzie(harness(m.model, undefined, data), q, { skills });
        expect(m.requests, JSON.stringify(q)).toHaveLength(0);
        const shown = turn.state === "answered" ? turn.answer.body : turn.state === "refused" ? turn.text : "";
        // The kids-team note only under a first line that says why, only with no kids team marked, and only for a question
        // about checks or kids (review B3 L-2); never on its own (review B2 L-3).
        if (shown.includes(NO_KIDS_TEAM)) {
          expect(turn.state, JSON.stringify(q)).toBe("answered");
          expect(kidsMarked, JSON.stringify(q)).toBe(false);
          expect(asksAboutChecksOrKids(q), JSON.stringify(q)).toBe(true);
          expect(shown, JSON.stringify(q)).not.toBe(NO_KIDS_TEAM);
          noted += 1;
        }
        if (turn.state === "answered") {
          expect(answeredFirst.has(turn.answer.body.split("\n\n")[0]!), JSON.stringify(q)).toBe(true);
          expect(asksAboutChecksOrKids(q), JSON.stringify(q)).toBe(true);
          answered += 1;
        } else {
          expect(turn.state, JSON.stringify(q)).toBe("refused");
          if (byThisList.has(shown)) refused += 1;
        }
      }
    }
    // Most are this list's own refusal or an answer that says why first; the rest were refused earlier for another reason.
    expect(refused + answered).toBeGreaterThan(questions.length);
    expect(noted).toBeGreaterThan(0);
  });

  it("refuses a question whose hidden characters could spell the wording past every folding, and sends nothing (review B3 L-1)", async () => {
    const vectors = JSON.parse(readFileSync(new URL("../../../core/test/harness/background-wording-vectors.json", import.meta.url), "utf8")) as Record<string, string[]>;
    const hidden = vectors["hidden"]!;
    expect(hidden.length).toBeGreaterThan(180);
    for (const data of [fictionalData(), kidsData()]) {
      for (const q of hidden) {
        const m = anyModel();
        const turn = await askOzzie(harness(m.model, undefined, data), q, { skills });
        expect(m.requests, JSON.stringify(q)).toHaveLength(0);
        expect(turn.state, JSON.stringify(q)).toBe("refused");
      }
    }
    for (const q of ["Is Blake's crim\u2800inal\u209Drecord clean?", "Is Blake not\u209Dyet clear\u2800ed?", "Is Blake not\u200Bclear\u2800ed?",
      "Is Blake's crim\u05C8inal\u05C8record clean?"]) {
      const m = anyModel();
      expect(await askOzzie(harness(m.model), q, { skills }), q).toEqual({ state: "refused", text: REFUSALS.hidden });
      expect(m.requests, q).toHaveLength(0);
    }
    expect(REFUSALS.hidden).toBe("This question has a hidden or invisible character in it, so Ozzie didn't send it to the AI. Try typing it again in plain words.");
  });

  it("carries the out-of-date line the rest of Ask uses (review Q H1)", async () => {
    const turn = await askOzzie(harness(anyModel().model, undefined, kidsData("2026-11-20T17:00:00Z")), "Any background check problems?", { skills });
    if (turn.state !== "answered") throw new Error(turn.state);
    expect(turn.answer.gaps).toContain("Planning Center Services: from a check that's too old to treat as current.");
    expect(turn.answer.body).not.toContain("found no one confirmed or pending");
  });

  it("sends a whole-Sunday question that mentions the kids the usual way, and still adds what it left out (review Q M2)", async () => {
    const m = scripted([() => calls(["sunday.overview"]), r => answer(JSON.stringify({ answer: "facts",
      facts: (payloadOf(r, "sunday.overview")!["findings"] as { fact: string; tone: string }[]).filter(f => f.tone === "needs a decision").map(f => f.fact) }))]);
    const turn = await askOzzie(harness(m.model, undefined, kidsData()), "Is everything ready for Sunday, including the kids?", { skills });
    expect(m.requests.length).toBeGreaterThan(0);
    if (turn.state !== "answered") throw new Error(turn.state);
    expect(turn.answer.body).toMatch(/Greeter at 9:30 AM[^]*Also on the Services page, needing a decision:[^]*Blake Ashgrove has no current background check/u);
  });

  it("doesn't offer what it can do below decisions it added", async () => {
    const m = scripted([() => answer('{"answer":"not-covered"}')]);
    const turn = await askOzzie(harness(m.model, undefined, kidsData()), "What still needs a decision this Sunday?", { skills });
    if (turn.state !== "answered") throw new Error(turn.state);
    expect(turn.answer.body.split("\n\n")[0]).toBe("Ozzie can't tell from what it read.");
    expect(turn.answer.body).toContain("Also on the Services page, needing a decision:");
    expect(turn.answer.body).not.toContain(CAN_DO_INSTEAD);
  });

  it("shows the page's own refusal when this Mac or ozzie.church refuses the wording, and the ledger keeps only “egress”", async () => {
    // As if the page had let a question through (a bug, or a new caller): native agent_step refuses it before any
    // request, or ozzie.church does before the AI. Both answer with the same fixed code.
    expect(stepFailure("background-check")).toBe("egress");
    const native = fakeLedger(command => command === "agent_step" ? Promise.reject("background-check") : {});
    const notes = new StepNotes();
    const r = recorder(native.invoke);
    const h = createAppHarness({ workspace_id: "fictional", data: kidsData(), skills, session: new HarnessSession(), loop: "ts", recorder: r, step: agentStep(native.invoke, notes) });
    const turn = await askOzzie(h, "Who could cover Greeter?", { recorder: r, skills, notes });
    await r.idle();
    expect(turn).toEqual({ state: "refused", text: REFUSALS.background });
    expect(ASK_FAILURES.background).toBe(REFUSALS.background);
    // The task is recorded as stopped for "egress", a fixed code; nothing typed or read is in any ledger call.
    expect(shape(native.log)).toEqual(["admit ask answer-from-what-was-read", "to running", "to failed egress"]);
    expect(JSON.stringify(ledgerOnly(native.log))).not.toMatch(/Greeter|background|\[Role|\[Person/iu);
  });
});

afterAll(() => {
  // Over every question this file asked through a model, none carried background-check wording (review Q H2), and none
  // would be refused by the native or ozzie.church check, which scan what varies with the page's own list.
  expect(everyRequest.length).toBeGreaterThan(10);
  for (const r of everyRequest) {
    expect(JSON.stringify(r)).not.toMatch(BACKGROUND_IN_REQUEST);
    for (const m of r.messages) {
      if (m.role === "system") continue;
      const texts = [m.content, ...(m.role === "assistant" ? (m.tool_calls ?? []).map(c => c.arguments) : [])];
      if (m.role === "tool") expect(backgroundInToolResult(m.content), m.content).toBe(false);
      else for (const t of texts) expect(backgroundWording(t), t).toBe(false);
    }
  }
});

describe("review F7: a no-credit answer is never asked again", () => {
  it("Ask sends exactly one request and says so; nothing retries it (the reviewer's mutation P3)", async () => {
    const notes = new StepNotes();
    let asked = 0;
    const broke = fakeLedger(() => { asked += 1; return Promise.reject("no-credit"); });
    const h = createAppHarness({ workspace_id: "fictional", data: fictionalData(), skills, session: new HarnessSession(), loop: "ts", step: agentStep(broke.invoke, notes) });
    const turn = await askOzzie(h, "Who could cover Greeter?", { skills, notes });
    expect(turn).toMatchObject({ state: "problem", code: "limit", text: ASK_FAILURES.noCredit });
    expect(asked).toBe(1);
  });
  it("retryDenied, the only retry, passes a no-credit refusal straight through", async () => {
    let calls = 0;
    await expect(retryDenied(async () => { calls += 1; throw "no-credit"; }, new AbortController().signal)).rejects.toBe("no-credit");
    expect(calls).toBe(1);
  });
});

describe("the church's own AI account out of credit in normal use (native no-credit, 2026-11-17)", () => {
  it("is a limit, never retried, and says to add credit, in Ask and in rewording", async () => {
    const { modelProblem } = await import("../src/model.js");
    expect(stepFailure("no-credit")).toBe("limit");
    expect(askFailureText("limit", "no-credit")).toBe("The AI company says your account has no credit left, or has reached a spending limit, so Ozzie didn't ask the AI. Add credit or raise the limit on their billing page, then ask again. Checks, lists, Church rules and briefings keep working.");
    expect(modelProblem("no-credit")).toBe("The AI company says your account has no credit left, or has reached a spending limit. Add credit or raise the limit on their billing page, then try again. Your draft is unchanged.");
  });
});

describe("contract 14: Gemini spent its whole answer thinking (thought-only)", () => {
  it("Ask says so in its own words, as a failure that isn't a limit and isn't retried", async () => {
    expect(stepFailure("thought-only")).toBe("transport");
    expect(askFailureText("transport", "thought-only")).toBe("Gemini used up its answer before saying anything, so there is no answer this time. Ask again, or choose another company in Settings › AI help.");
    const notes = new StepNotes();
    let asked = 0;
    const thinking = fakeLedger(() => { asked += 1; return Promise.reject("thought-only"); });
    const h = createAppHarness({ workspace_id: "fictional", data: fictionalData(), skills, session: new HarnessSession(), loop: "ts", step: agentStep(thinking.invoke, notes) });
    const turn = await askOzzie(h, "Who could cover Greeter?", { skills, notes });
    expect(turn).toMatchObject({ state: "problem", text: ASK_FAILURES.thoughtOnly });
    expect(asked).toBe(1);
  });
});


describe("native invalid-arguments: the AI asked for a lookup in a way the tool doesn't take (2026-11-18)", () => {
  /** native agent_step: the first step asks for the open roles with a `role` they don't take, refused as native refuses it. */
  const refusing = (code: string) => fakeLedger(command => command === "agent_step" ? Promise.reject(code) : {});
  it("is its own code end to end, with a true sentence, never the question's egress", async () => {
    expect(stepFailure("invalid-arguments")).toBe("invalid-arguments");
    expect(askFailureText("invalid-arguments", "invalid-arguments")).toBe(ASK_FAILURES.arguments);
    // "That lookup", never "nothing": an earlier step of the same question may have read something (review L3).
    expect(ASK_FAILURES.arguments).toBe("The AI asked to look something up in a way Ozzie doesn't allow, so that lookup didn't happen and there's no answer this time. Try asking in other words.");
    expect(ASK_FAILURES.arguments).not.toMatch(/question includes|keeps on this Mac/u);
    for (const local of [true, false]) {
      const native = refusing("invalid-arguments");
      const notes = new StepNotes();
      const r = recorder(native.invoke);
      const h = createAppHarness({ workspace_id: "fictional", data: fictionalData(), skills, session: new HarnessSession(), loop: "pi", recorder: r, step: agentStep(native.invoke, notes) });
      const turn = await askOzzie(h, "Why is Greeter flagged?", { recorder: r, skills, notes, local });
      await r.idle();
      expect(turn).toEqual({ state: "problem", code: "invalid-arguments", text: ASK_FAILURES.arguments });
      // Recorded as its own fixed code; What happened says what happened.
      expect(shape(native.log)).toEqual(["admit ask answer-from-what-was-read", "to running", "to failed invalid-arguments"]);
    }
    expect(taskLine(row({ kind: "ask", state: "failed", failure: "invalid-arguments" }), { now: new Date("2026-11-20T22:00:00Z") }))
      .toMatch(/^A question · Couldn't finish: the AI asked to look something up in a way Ozzie doesn't allow · /u);
    expect(ledgerDetail("model", "step 2", "invalid-arguments")).toBe("2 invalid-arguments");
    expect(ledgerDetail("failed", "invalid-arguments")).toBe("invalid-arguments");
    // A question that holds details kept on this Mac is still egress, in its own words.
    const egress = refusing("egress");
    const notes = new StepNotes();
    const h = createAppHarness({ workspace_id: "fictional", data: fictionalData(), skills, session: new HarnessSession(), loop: "pi", step: agentStep(egress.invoke, notes) });
    expect(await askOzzie(h, "Why is Greeter flagged?", { skills, notes })).toEqual({ state: "problem", code: "egress", text: ASK_FAILURES.egress });
  });
});

describe("where the overview's rooms, follow-ups and group meetings come from (review item 5)", () => {
  type Rows = { fact: string; findings: { fact: string; kind: string }[] };
  /** A live check of the fictional Sunday (no room rule) with these reads ending `outcome`. */
  const live = (outcome: Record<string, string> = {}) => {
    const capture = withFictionalOperations(nov22Capture());
    capture.reads = capture.reads.map(r => outcome[r.collection] ? { ...r, outcome: outcome[r.collection]! } as typeof r : r);
    return buildHarnessData({ capture, fictional: false, rules: RULES, decisions: [], status: null, configured: false, now: "2026-11-20T15:05:00Z" });
  };
  /** The overview read, then an answer choosing its rows of `kinds`. */
  const choosing = async (data: ReturnType<typeof live>, kinds: string[]) => {
    const turn = await askOzzie(harness(scripted([() => calls(["sunday.overview"]), r => {
      const p = payloadOf(r, "sunday.overview") as Rows;
      return answer(JSON.stringify({ answer: "facts", facts: p.findings.filter(f => kinds.includes(f.kind)).map(f => f.fact) }));
    }]).model, undefined, data), "What about rooms and follow-ups?", { skills });
    if (turn.state !== "answered") throw new Error(JSON.stringify(turn));
    return turn.answer;
  };

  it("the row for details that couldn't be confirmed names its own source: a room's is Calendar", async () => {
    const a = await choosing(live(), ["a detail couldn't be verified"]);
    expect(a.body).toBe("Worth a look:\n\nSome room or follow-up details couldn't be confirmed.");
    expect(a.basedOn).toMatch(/^Based on: Planning Center Services and Calendar, checked [^;]+$/u);
    expect(a.basedOn).not.toContain("People");
  });

  it("a row whose own Planning Center reads didn't all complete says so, by that source only", async () => {
    // Calendar's conflict records timed out: the room row's source is said to be incomplete, the follow-up's isn't.
    const calendar = live({ calendar_conflicts: "timeout" });
    expect((await choosing(calendar, ["room use needs review"])).gaps).toEqual(["Planning Center Calendar: part of this couldn't be read."]);
    expect((await choosing(calendar, ["needs an owner"])).gaps).toEqual([]);
    // People's workflows timed out: the follow-up's source is.
    expect((await choosing(live({ people_workflows: "timeout" }), ["needs an owner"])).gaps).toEqual(["Planning Center People: part of this couldn't be read."]);
    expect((await choosing(live({ groups_group_events: "timeout" }), ["group meets while serving"])).gaps).toEqual(["Planning Center Groups: part of this couldn't be read."]);
    // Every read complete: nothing to say.
    expect((await choosing(live(), ["room use needs review", "needs an owner", "group meets while serving"])).gaps).toEqual([]);
  });
});

describe("Based on: each source and each check time said once (owner's read of 0.3.2)", () => {
  const at = (iso: string) => new Date(iso).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const T = "2026-11-19T08:53:00Z", LATER = "2026-11-19T09:10:00Z";
  const read = (source: string, check_time = T) => ({ source, check_time });
  const all = ["Services", "Calendar", "Groups", "People"].map(p => read(`Planning Center ${p}`));

  it("names the sources checked at the same time once, with that time, in the order they were read", () => {
    expect(basedOnEvidence(all, "live")).toBe(`Based on: Planning Center Services, Calendar, Groups and People, checked ${at(T)}`);
    expect(basedOnEvidence(all.slice(0, 2), "live")).toBe(`Based on: Planning Center Services and Calendar, checked ${at(T)}`);
    expect(basedOnEvidence(all.slice(0, 1), "live")).toBe(`Based on: Planning Center Services, checked ${at(T)}`);
  });

  it("keeps each time when they differ, grouping only the sources that share one, and never drops a source or a time", () => {
    const said = basedOnEvidence([...all.slice(0, 3), read("Planning Center People", LATER), read("Church rules on this Mac")], "live");
    expect(said).toBe(`Based on: Planning Center Services, Calendar and Groups, checked ${at(T)}; Planning Center People, checked ${at(LATER)}; your Church rules`);
    // A source read twice is said at its newest time.
    expect(basedOnEvidence([read("Planning Center Services"), read("Planning Center Calendar", LATER), read("Planning Center Services", LATER)], "live"))
      .toBe(`Based on: Planning Center Services and Calendar, checked ${at(LATER)}`);
    // A saved copy and the fictional example are said as before.
    expect(basedOnEvidence(all, "recording")).toBe(`Based on: a saved copy of the Planning Center check at ${at(T)}`);
    expect(basedOnEvidence(all, "fictional")).toBe(`Based on: fictional example data as of ${at(T)}`);
  });
});

describe("an overview too long for one answer (review item 6)", () => {
  it("says the full totals, every decision, and that findings were left out of the answer, never that Planning Center couldn't be read", async () => {
    const data = crowded();
    const shown = sundayShownCount(applyDecisions(data.brief!, data.decisions), data.operations);
    const every: Turn = r => { const p = payloadOf(r, "sunday.overview") as { fact: string; left_out_for_length: number; findings: { fact: string; tone: string }[] };
      return answer(JSON.stringify({ answer: "facts", facts: [p.fact, ...p.findings.filter(f => f.tone === "needs a decision").map(f => f.fact)] })); };
    const turn = await askOzzie(harness(scripted([() => calls(["sunday.overview"]), every]).model, undefined, data), "What still needs a decision this Sunday?", { skills });
    if (turn.state !== "answered") throw new Error(JSON.stringify(turn));
    const parts = turn.answer.body.split("\n\n");
    // The full totals, though rows were left out to fit; then one label line and every decision under it.
    expect(shown.looks).toBeGreaterThan(0);
    expect(parts[0]).toBe(`For Sunday, November 22, ${shown.decisions} things need a decision and ${shown.looks} are worth a look.`);
    expect(parts[1]).toBe("Needs a decision:");
    expect(parts.slice(2)).toHaveLength(shown.decisions);
    for (const p of parts.slice(2)) expect(p).not.toMatch(/^(?:Needs a decision|Worth a look|Resolved by you)|on November 22/u);
    expect(turn.answer.added).toBeUndefined();
    const cut = (turn.answer.gaps.join(" ").match(/so (\d+) findings were left out/u) ?? [])[1];
    expect(turn.answer.gaps).toEqual([`Planning Center Services: the list was too long to say in full, so ${cut} findings were left out of this answer. They're on the Services page.`]);
    expect(Number(cut)).toBeGreaterThan(0);
    expect(turn.answer.steps).toContain("Looked at the overview of the last check — a shortened list");
    expect(JSON.stringify(turn.answer)).not.toContain("couldn't be read");
    // A check whose reads didn't all complete still says so, beside the cut.
    const failed = crowded();
    failed.brief = { ...failed.brief!, sources: { ...failed.brief!.sources, failed: [{ collection: "team_members", outcome: "timeout" }] } };
    const both = await askOzzie(harness(scripted([() => calls(["sunday.overview"]), every]).model, undefined, failed), "What still needs a decision this Sunday?", { skills });
    if (both.state !== "answered") throw new Error(JSON.stringify(both));
    expect(both.answer.gaps).toEqual(["Planning Center Services: part of this couldn't be read.", expect.stringMatching(/^Planning Center Services: the list was too long to say in full, so \d+ findings were left out of this answer\. They're on the Services page\.$/u)]);
  });
});

describe("a decision question says the Sunday page's count, on every route (live review 2026-11-18)", () => {
  // The test church: two roles that need people and a follow-up with no owner. Today and the sidebar say 3 things to decide.
  const DECISION = "What still needs a decision this Sunday?";
  const pageCount = () => { const d = fictionalData(); return sundayCount(sundayShownCount(applyDecisions(d.brief!, d.decisions), d.operations)); };
  type Overview = { fact: string; findings: { fact: string; kind: string; tone: string }[] };
  const overviewIn = (r: AgentStepRequest) => payloadOf(r, "sunday.overview") as Overview;
  /** As Ozzie's AI answered live: the overview, open roles and pending requests read, then the summary and the two roles chosen. */
  const looked: Turn = () => calls(["sunday.overview"], ["sunday.open_needs"], ["sunday.pending_requests"]);
  const roles: Turn = r => { const p = overviewIn(r); return answer(JSON.stringify({ answer: "facts", facts: [p.fact, ...p.findings.filter(f => f.kind === "needs people").map(f => f.fact)] })); };
  const everyDecision: Turn = r => { const p = overviewIn(r); return answer(JSON.stringify({ answer: "facts", facts: [p.fact, ...p.findings.filter(f => f.tone === "needs a decision").map(f => f.fact)] })); };
  // The Sunday page's words for its counts; under it, the date it names isn't said again (owner's read of 0.3.2).
  const SUMMARY = "For Sunday, November 22, 3 things need a decision and 5 are worth a look. This is fictional example data.";
  const GREETER = "Greeter at 9:30 AM still needs 1 more person, by Planning Center's count.";
  const NURSERY = "Nursery at 9:30 AM still needs 1 more person, by Planning Center's count.";
  const FOLLOW_UP = "Welcome follow-up (fictional), step Call a first-time guest, was due 5:27 PM on October 26 and has no owner.";

  it("an answer choosing the two roles: the page's count, then the follow-up it left out, once, on Ozzie's AI and on AI on this Mac", async () => {
    expect(pageCount()).toBe(3);
    for (const local of [false, true]) {
      const turn = await askOzzie(harness(scripted([looked, roles]).model), DECISION, { skills, local });
      if (turn.state !== "answered") throw new Error(JSON.stringify(turn));
      expect(turn.answer.body.split("\n\n"), String(local)).toEqual([SUMMARY, "Needs a decision:", GREETER, NURSERY, "Also on the Services page, needing a decision:", FOLLOW_UP]);
      expect(turn.answer.page).toBe("sunday");
    }
  });

  it("an answer choosing every decision the overview holds: each said once, nothing added, and the follow-up's own source named", async () => {
    const turn = await askOzzie(harness(scripted([looked, everyDecision]).model), DECISION, { skills });
    if (turn.state !== "answered") throw new Error(JSON.stringify(turn));
    expect(turn.answer.body.split("\n\n")).toEqual([SUMMARY, "Needs a decision:", GREETER, NURSERY, FOLLOW_UP]);
    expect(turn.answer.added).toBeUndefined();
    expect(turn.answer.basedOn).toMatch(/^Based on: fictional example data as of /u);
    const live = buildHarnessData({ capture: withFictionalOperations(nov22Capture()), fictional: false, rules: RULES, decisions: [], status: null, configured: false, now: "2026-11-20T15:05:00Z" });
    const liveTurn = await askOzzie(harness(scripted([looked, everyDecision]).model, undefined, live), DECISION, { skills });
    if (liveTurn.state !== "answered") throw new Error(JSON.stringify(liveTurn));
    expect(liveTurn.answer.basedOn).toMatch(/^Based on: Planning Center Services and People, checked [^;]+$/u);
  });

  it("AI on this Mac choosing too many facts: Ozzie's own answer says the page's count and every decision once", async () => {
    let step = 0;
    const fake = fakeLedger(command => {
      if (command !== "agent_step") return {};
      step += 1;
      return step === 1 ? calls(["sunday.overview"]) : Promise.reject("too-many-facts");
    });
    const notes = new StepNotes();
    const h = createAppHarness({ workspace_id: "fictional", data: fictionalData(), skills, session: new HarnessSession(), loop: "pi", step: agentStep(fake.invoke, notes) });
    const turn = await askOzzie(h, DECISION, { skills, notes, local: true });
    if (turn.state !== "answered") throw new Error(JSON.stringify(turn));
    expect(turn.answer.composedHere).toBe(true);
    expect(turn.answer.body.split("\n\n")).toEqual([SUMMARY, "On the Services page, needing a decision:", GREETER, NURSERY, FOLLOW_UP]);
  });
});

describe("AI on this Mac: an answer choosing more than 24 facts (native too-many-facts, measured 2026-11-18)", () => {
  const DECISION = "What still needs a decision this Sunday?";
  /** native agent_step: the overview first, then a final answer native refuses with `code` (or the answer the turn gives). */
  const native = (last: (request: AgentStepRequest) => Promise<AgentStepReply>, first: [string, Record<string, unknown>?] = ["sunday.overview"]) => {
    let step = 0;
    return fakeLedger((command, args) => {
      if (command !== "agent_step") return {};
      step += 1;
      return step === 1 ? calls(first) : last(args["request"] as AgentStepRequest);
    });
  };
  const ask = async (fake: ReturnType<typeof native>, question: string, local: boolean | undefined, rec?: LedgerRecorder) => {
    const notes = new StepNotes();
    const h = createAppHarness({ workspace_id: "fictional", data: fictionalData(), skills, session: new HarnessSession(), loop: "pi", ...(rec ? { recorder: rec } : {}), step: agentStep(fake.invoke, notes) });
    return askOzzie(h, question, { skills, notes, ...(local === undefined ? {} : { local }), ...(rec ? { recorder: rec } : {}) });
  };
  const tooMany = () => Promise.reject("too-many-facts");

  it("is fidelity to the loop; every other route and question says the true reason, never that the answer couldn't be backed up", async () => {
    expect(stepFailure("too-many-facts")).toBe("fidelity");
    // Every id was one the task had read: the true reason is how many there were (review L4), the number the shared
    // vocabulary holds.
    expect(VOCABULARY.answer.max_facts).toBe(24);
    expect(ASK_FAILURES.tooMany).toBe("The AI's answer listed more than 24 facts, more than Ozzie checks in one answer, so it isn't shown. Try asking about one role or one thing at a time, or ask “What can you do?”");
    expect(askFailureText("fidelity", "too-many-facts")).toBe(ASK_FAILURES.tooMany);
    for (const local of [false, undefined]) expect(await ask(native(tooMany), DECISION, local)).toEqual({ state: "problem", code: "fidelity", text: ASK_FAILURES.tooMany });
    // Not a decision question: no answer is written for it.
    expect(await ask(native(tooMany), "Why is Greeter flagged?", true)).toEqual({ state: "problem", code: "fidelity", text: `${ASK_FAILURES.tooMany} ${ASK_FAILURES.fidelityHere}` });
    expect(await ask(native(tooMany), "Why is Greeter flagged?", false)).toEqual({ state: "problem", code: "fidelity", text: ASK_FAILURES.tooMany });
    // Any other refused answer, on this Mac too.
    expect(await ask(native(() => Promise.reject("invalid-answer")), DECISION, true)).toEqual({ state: "problem", code: "fidelity", text: `${ASK_FAILURES.fidelity} ${ASK_FAILURES.fidelityHere}` });
    // No overview was read: nothing to write it from.
    expect(await ask(native(tooMany, ["sunday.open_needs"]), DECISION, true)).toEqual({ state: "problem", code: "fidelity", text: `${ASK_FAILURES.tooMany} ${ASK_FAILURES.fidelityHere}` });
  });

  it("on AI on this Mac, Ozzie writes a decision question's answer itself from the overview, as an answer choosing only its summary reads, and says so", async () => {
    const ledger = fakeLedger();
    const r = recorder(ledger.invoke);
    const fake = native(tooMany);
    const turn = await ask(fake, DECISION, true, r);
    if (turn.state !== "answered") throw new Error(JSON.stringify(turn));
    const a = turn.answer;
    expect(a.composedHere).toBe(true);
    // The same words as when the AI chooses only the overview's summary fact, under "On" rather than "Also on".
    const summaryOnly = native(async request => answer(JSON.stringify({ answer: "facts", facts: [payloadOf(request, "sunday.overview")!["fact"]] })));
    const chosen = await ask(summaryOnly, DECISION, true);
    if (chosen.state !== "answered") throw new Error(chosen.state);
    expect(chosen.answer.composedHere).toBeUndefined();
    expect(a.body).toBe(chosen.answer.body.replace("Also on the Services page, needing a decision:", "On the Services page, needing a decision:"));
    const paragraphs = a.body.split("\n\n");
    expect(paragraphs[0]).toMatch(/^For Sunday, November 22, \d+ things? needs? a decision and \d+ (?:is|are) worth a look\./u);
    expect(paragraphs[1]).toBe("On the Services page, needing a decision:");
    expect(paragraphs.length).toBeGreaterThan(2);
    // Never presented as the AI's choice or as an answer without the AI.
    expect([a.local, a.end, a.added]).toEqual([undefined, undefined, undefined]);
    expect(a).toMatchObject({ procedure: null, notCovered: false, page: "sunday", aiSteps: 2, draft: null });
    expect(a.steps[0]).toBe("Looked at the overview of the last check — all of it");
    // The AI's task is recorded as refused (fidelity); what Ozzie wrote is recorded as answered on this Mac.
    await r.idle();
    expect(shape(ledger.log)).toEqual(["admit ask answer-from-what-was-read", "to running", "tool sunday.overview complete", "to failed fidelity",
      "admit ask answer-from-what-was-read", "to running", "tool sunday.overview complete", "tool rooms.conflicts partial", "tool followups.unowned partial", "to verified"]);
  });

  it("a decision question that names one person gets the whole service's answer, and the note under it says so (review L6)", async () => {
    const turn = await ask(native(tooMany), "What still needs a decision about Riley?", true);
    if (turn.state !== "answered") throw new Error(JSON.stringify(turn));
    expect(turn.answer.composedHere).toBe(true);
    expect(turn.answer.body.split("\n\n")[0]).toMatch(/^For Sunday, November 22, \d+ things? needs? a decision/u);
    expect(COMPOSED_NOTE).toContain("it covers the whole service");
  });

  it("says its number from the shared vocabulary, never typed into its words (review L4)", () => {
    const source = readFileSync(new URL("../src/harness-words.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/more than 24\b/u);
    for (const words of [COMPOSED_NOTE, COMPOSED_ENDED, composedHow(SUNDAY_WORDS), ASK_FAILURES.tooMany]) {
      expect(words).toContain(`more than ${VOCABULARY.answer.max_facts} facts`);
    }
  });
});
