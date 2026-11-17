import { describe, expect, it } from "vitest";
import { AuthorizationBroker } from "../src/broker.js";
import { neededPositionsTool, fictionalPlans } from "../src/tools.js";

describe("review fixes: broker scope and unknown plans", () => {
  const broker = new AuthorizationBroker("church-a", ["st-1"]);
  broker.register(neededPositionsTool(fictionalPlans));
  const run = (args: Record<string, unknown>) =>
    broker.run({ workspace_id: "church-a", tool: "pco.needed_positions", args });

  it("denies service types outside the authorized scope", async () => {
    expect(await run({ workspace_id: "church-a", service_type_id: "st-other", plan_id: "plan-1" }))
      .toEqual({ ok: false, error: "denied" });
  });
  it("unknown plan is unverified, never a complete empty all-clear", async () => {
    expect(await run({ workspace_id: "church-a", service_type_id: "st-1", plan_id: "nope" }))
      .toEqual({ ok: false, error: "unverified" });
  });
  it("missing typed args are denied", async () => {
    expect(await run({ workspace_id: "church-a" })).toEqual({ ok: false, error: "denied" });
  });
});
