// Review H, M1, L2 and L10: Ask's card and What happened say the same number of AI calls for the same task, from the
// native record's own shape (each step written as reserved, "1", then finished, "1 stop"); a step says what really
// happened (checking again, a draft); and how a task started and ended is kept in closed words only. Fictional data and
// scripted models; nothing native runs.
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => { throw new Error("NATIVE_CALL_FORBIDDEN"); }) }));
import { bundledSkills } from "../../../core/src/harness/bundled-skills.js";
import type { ModelStep } from "../../../core/src/harness/contract.js";
import { HarnessSession } from "../../../core/src/harness/session.js";
import { withFictionalOperations } from "../../../core/src/fictional-operations.js";
import { nov22Capture } from "../../../core/src/fictional-sunday.js";
import { askOzzie, buildHarnessData, createAppHarness, keptWriteup, LedgerRecorder, localTriggers, type Invoke } from "../src/harness-bridge.js";
import { taskAccount, type TaskRow } from "../src/harness-words.js";
import { answerAccount } from "../src/ask-panel.js";
import { calls, draftTurns, facts, fictionalData, greeterTurns, payloadOf, RULES, scripted } from "./harness-fakes.js";

const skills = await bundledSkills();

/** A task record kept as native keeps it: admitted and its events from the page, and two model events per AI step. */
function nativeRecord() {
  const rows = new Map<string, TaskRow>();
  const at = () => new Date().toISOString();
  const push = (id: string, type: TaskRow["events"][number]["type"], detail: string) => {
    const r = rows.get(id); if (r) r.events.push({ task_id: id, sequence: r.events.length + 1, at: at(), type, detail });
  };
  const invoke: Invoke = async <T,>(command: string, args: Record<string, unknown> = {}) => {
    const id = String(args["taskId"]);
    if (command === "ledger_admit") rows.set(id, { task_id: id, kind: args["kind"] as TaskRow["kind"], skill_id: String(args["skillId"]), skill_hash: String(args["skillHash"]),
      state: "admitted", created_at: at(), updated_at: at(), failure: null, events: [] });
    if (command === "ledger_transition") { const r = rows.get(id)!; r.state = args["to"] as TaskRow["state"]; push(id, args["to"] as never, String(args["code"] ?? "")); }
    if (command === "ledger_event") push(id, args["kind"] as never, String(args["detail"]));
    return {} as T;
  };
  /** The model step, recorded natively: reserved, then finished with its outcome. */
  const step = (model: ModelStep): ModelStep => async (request, signal) => {
    const n = (rows.get(request.task_id)?.events.filter(e => e.type === "model").length ?? 0) / 2 + 1;
    push(request.task_id, "model", String(n));
    const reply = await model(request, signal);
    push(request.task_id, "model", `${n} ${reply.finish}`);
    return reply;
  };
  return { rows, invoke, step };
}

describe("one count of AI calls, wherever it is shown (review H, M1)", () => {
  it("Ask's card and What happened say the same number for the same task, from native's two events a step", async () => {
    const record = nativeRecord();
    const recorder = new LedgerRecorder({ invoke: record.invoke, hashFor: async id => skills.get(id)?.hash, readyMs: 200 });
    const m = scripted(greeterTurns);
    const h = createAppHarness({ workspace_id: "fictional", data: fictionalData(), skills, session: new HarnessSession(), loop: "pi", step: record.step(m.model), recorder });
    const turn = await askOzzie(h, "Who could cover Greeter?", { skills, recorder });
    await recorder.idle();
    if (turn.state !== "answered") throw new Error(turn.state);
    const row = [...record.rows.values()][0]!;
    expect(row.events.filter(e => e.type === "model").map(e => e.detail)).toEqual(["1", "1 tool_calls", "2", "2 stop"]);
    expect(answerAccount(turn.answer).ai).toBe(taskAccount(row).ai);
    expect(taskAccount(row).ai).toMatch(/^Ozzie asked the AI twice\./u);
  });

  it("a step reserved but never finished isn't counted as an answer from the AI, and says no answer came (review G)", () => {
    const row: TaskRow = { task_id: "t", kind: "ask", skill_id: "answer-from-what-was-read", skill_hash: "a".repeat(64), state: "failed", created_at: "2026-11-20T21:42:00Z",
      updated_at: "2026-11-20T21:42:00Z", failure: "interrupted", events: [{ task_id: "t", sequence: 1, at: "2026-11-20T21:42:00Z", type: "model", detail: "1" }] };
    expect(taskAccount(row).ai).toBe("Ozzie got no answer from the AI.");
    // With no step at all, it never reached the AI.
    expect(taskAccount({ ...row, events: [] }).ai).toBe("Ozzie didn't reach the AI.");
  });
});

describe("a step says what really happened (review H, L2)", () => {
  const live = (withRefresh: boolean) => {
    const capture = withFictionalOperations(nov22Capture());
    const status = { state: "connected", organization: capture.organization } as never;
    return buildHarnessData({ capture, fictional: false, rules: RULES, decisions: [], status, configured: true, now: capture.completed_at },
      withRefresh ? async () => { throw new Error("not needed: the check is current"); } : undefined);
  };
  const refreshTurns = () => scripted([() => calls(["planning_center.refresh"]), r => facts([String(payloadOf(r, "planning_center.refresh")?.["fact"] ?? "f1")])]);

  it("checking again: 'recent enough' when it wasn't needed, and never 'checked' where it isn't offered", async () => {
    const offered = createAppHarness({ workspace_id: "x", data: live(true), skills, session: new HarnessSession(), loop: "ts", step: refreshTurns().model });
    const recent = await offered.runSkill("sunday-ready");
    expect(recent.status).toBe("verified");
    expect(keptWriteup(offered, recent).steps).toEqual(["Saw that the last check was recent enough"]);
    const job = createAppHarness({ workspace_id: "x", data: live(false), skills, session: new HarnessSession(), loop: "ts",
      step: scripted([() => calls(["planning_center.refresh"]), () => calls(["sunday.overview"]), r => facts([String(payloadOf(r, "sunday.overview")?.["fact"])])]).model });
    const noRefresh = await job.runSkill("sunday-ready");
    expect(noRefresh.status).toBe("verified");
    const steps = keptWriteup(job, noRefresh).steps;
    expect(steps[0]).toBe("Didn't read Planning Center again: that isn't possible here");
    expect(steps.join(" ")).not.toMatch(/Checked Planning Center again|Read Planning Center again/u);
  });

  it("a draft: 'Prepared a draft note' only when one was prepared", async () => {
    const h = createAppHarness({ workspace_id: "fictional", data: fictionalData(), skills, session: new HarnessSession(), loop: "ts", step: scripted(draftTurns).model });
    const turn = await askOzzie(h, "Draft a note to someone who could cover Greeter", { skills, sender: "Pat" });
    if (turn.state !== "answered") throw new Error(turn.state);
    expect(turn.answer.steps).toContain("Prepared a draft note");
    // From the record alone: asked for, with no "all of it" (a draft isn't a read).
    const row: TaskRow = { task_id: "t", kind: "ask", skill_id: "answer-from-what-was-read", skill_hash: "a".repeat(64), state: "verified", created_at: "2026-11-20T21:42:00Z",
      updated_at: "2026-11-20T21:42:00Z", failure: null, events: [{ task_id: "t", sequence: 1, at: "2026-11-20T21:42:00Z", type: "tool", detail: "drafts.prepare_note complete" }] };
    expect(taskAccount(row).looked).toEqual(["Asked for a draft note"]);
  });
});

describe("how a task started and ended is kept in closed words only, on write as on read (review H, L10)", () => {
  it("never keeps a word outside the closed list", () => {
    const kept = new Map<string, string>();
    const triggers = localTriggers({ getItem: k => kept.get(k) ?? null, setItem: (k, v) => { kept.set(k, v); } });
    triggers.set("a", "job:keep-sunday-covered:scheduled");
    triggers.setEnd("a", "facts");
    triggers.set("b", "Riley Thornbury" as never);
    triggers.set("c", "job:keep-sunday-covered:Riley" as never);
    triggers.setEnd("a", "Riley" as never);
    expect(JSON.parse(kept.get("ozzie.ledger.checks.v1")!)).toEqual([["a", "job:keep-sunday-covered:scheduled", "facts"]]);
    expect(triggers.get("b")).toBeUndefined();
  });
});
