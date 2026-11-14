import { describe, expect, it } from "vitest";
import { AuthorizationBroker } from "../src/broker.js";
import { neededPositionsTool, fictionalPlans } from "../src/tools.js";
import { EgressBoundary } from "../src/egress.js";

describe("review fixes: egress allowlist (not blacklist)", () => {
  const egress = new EgressBoundary("church-a", ["Alex Example"]);
  it("fails closed on undeclared fields and formatted phone numbers", () => {
    expect(() => egress.toModelPayload({ room: "Room 1" })).toThrow("fail-closed");
    expect(() => egress.toModelPayload({ note: "Call (202) 555.0100 today" })).toThrow("fail-closed");
    expect(() => egress.toModelPayload({ note: "Please pray for our family" })).toThrow("fail-closed");
  });
  it("placeholder-looking literal text survives a round trip", () => {
    const original = "Person-A met Alex Example";
    expect(egress.restoreLocal(egress.toModel(original))).toBe(original);
  });
  it("double-dash and double-letter literals survive a round trip", () => {
    expect(egress.restoreLocal(egress.toModel("Person--A"))).toBe("Person--A");
    expect(egress.restoreLocal(egress.toModel("Person-AA"))).toBe("Person-AA");
  });
});

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
