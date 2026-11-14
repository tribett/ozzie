import { describe, expect, it } from "vitest";
import { AuthorizationBroker } from "../src/broker.js";
import { neededPositionsTool, fictionalPlans } from "../src/tools.js";

const broker = new AuthorizationBroker("church-a", ["st-1"]);
broker.register(neededPositionsTool(fictionalPlans));

describe("AuthorizationBroker with the one frozen read tool", () => {
  it("admits an authorized fictional read with source and check time", async () => {
    const r = await broker.run({
      workspace_id: "church-a",
      tool: "pco.needed_positions",
      args: { workspace_id: "church-a", service_type_id: "st-1", plan_id: "plan-1" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.envelope.completeness).toBe("complete");
    expect(r.envelope.source).toContain("fictional");
    // NeededPosition.quantity IS remaining need: nursery needs 1, never re-subtracted.
    expect(r.envelope.payload).toEqual([
      { position: "Nursery support", remaining_need: 1, pending: 1 },
      { position: "Greeter", remaining_need: 1, pending: 0 },
    ]);
  });

  it("exposes no write tool and denies write-shaped requests outside model control", async () => {
    expect(broker.toolNames()).toEqual(["pco.needed_positions"]);
    const r = await broker.run({
      workspace_id: "church-a",
      tool: "pco.update_plan",
      args: { workspace_id: "church-a" },
    });
    expect(r).toEqual({ ok: false, error: "denied" });
  });

  it("denies a workspace mismatch before any retrieval", async () => {
    const r = await broker.run({
      workspace_id: "church-b",
      tool: "pco.needed_positions",
      args: { workspace_id: "church-a", service_type_id: "st-1", plan_id: "plan-1" },
    });
    expect(r).toEqual({ ok: false, error: "denied" });
  });

  it("marks incomplete pages partial, never complete", async () => {
    const r = await broker.run({
      workspace_id: "church-a",
      tool: "pco.needed_positions",
      args: { workspace_id: "church-a", service_type_id: "st-1", plan_id: "plan-truncated" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.envelope.completeness).toBe("partial");
  });
});
