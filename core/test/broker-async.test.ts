import { describe, expect, it } from "vitest";
import { AuthorizationBroker, ToolFailure, type Envelope } from "../src/broker.js";

const request = {
  workspace_id: "church-a",
  tool: "pco.needed_positions",
  args: { workspace_id: "church-a", service_type_id: "st-1", plan_id: "plan-1" },
};
const envelope: Envelope = {
  source: "fictional delayed read",
  check_time: "2026-10-30T13:00:00Z",
  completeness: "partial",
  payload: [{ remaining_need: 1 }],
};

describe("AuthorizationBroker asynchronous read boundary", () => {
  it("returns the resolved checked envelope rather than the read promise", async () => {
    let finish!: (value: Envelope) => void;
    const delayed = new Promise<Envelope>((resolve) => { finish = resolve; });
    const broker = new AuthorizationBroker("church-a", ["st-1"]);
    broker.register({ name: "pco.needed_positions", read: () => delayed });

    let settled = false;
    const result = broker.run(request).then((value) => { settled = true; return value; });
    await Promise.resolve();
    try {
      expect(settled).toBe(false);
    } finally {
      finish(envelope);
    }
    expect(await result).toEqual({ ok: true, envelope });
  });

  it("returns a typed failure without forwarding private provider diagnostics", async () => {
    const broker = new AuthorizationBroker("church-a", ["st-1"]);
    broker.register({ name: "pco.needed_positions", read: async () => {
      throw new Error("fictional provider diagnostic CANARY_PRIVATE_DETAIL");
    } });
    await expect(broker.run(request)).resolves.toEqual({ ok: false, error: "provider-failure" });
  });

  it.each(["denied", "stale", "partial", "provider-failure", "unverified"] as const)("retains an asynchronous declared %s failure", async (code) => {
    const broker = new AuthorizationBroker("church-a", ["st-1"]);
    broker.register({ name: "pco.needed_positions", read: async () => { throw new ToolFailure(code); } });
    expect(await broker.run(request)).toEqual({ ok: false, error: code });
  });

  it.each(["complete", "partial", "stale", "denied"] as const)("preserves %s source evidence after awaiting", async (completeness) => {
    const broker = new AuthorizationBroker("church-a", ["st-1"]);
    const checked = { ...envelope, completeness };
    broker.register({ name: "pco.needed_positions", read: async () => checked });
    expect(await broker.run(request)).toEqual({ ok: true, envelope: checked });
  });

  it.each([
    { ...request, workspace_id: "church-b" },
    { ...request, tool: "pco.update_plan" },
    { ...request, args: { ...request.args, workspace_id: "church-b" } },
    { ...request, args: { ...request.args, service_type_id: "st-other" } },
  ])("denies unauthorized asynchronous retrieval before invoking it: %j", async (unauthorized) => {
    let retrieved = 0;
    const broker = new AuthorizationBroker("church-a", ["st-1"]);
    broker.register({ name: "pco.needed_positions", read: async () => { retrieved++; return envelope; } });
    expect(await broker.run(unauthorized)).toEqual({ ok: false, error: "denied" });
    expect(retrieved).toBe(0);
    expect(broker.toolNames()).toEqual(["pco.needed_positions"]);
  });

  it("also sanitizes an unexpected synchronous reader failure", async () => {
    const broker = new AuthorizationBroker("church-a", ["st-1"]);
    broker.register({ name: "pco.needed_positions", read: () => { throw new Error("CANARY_PRIVATE_DETAIL"); } });
    expect(await broker.run(request)).toEqual({ ok: false, error: "provider-failure" });
  });
});
