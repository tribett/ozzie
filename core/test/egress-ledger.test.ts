import { describe, expect, it } from "vitest";
import { EgressBoundary } from "../src/egress.js";
import { TaskLedger } from "../src/ledger.js";

describe("Egress Placeholder Boundary", () => {
  const egress = new EgressBoundary("church-a", ["Alex Example", "Sam Sample"]);

  it("replaces known names with stable placeholders and restores locally", () => {
    const out = egress.toModel("Alex Example can cover if Sam Sample cannot.");
    expect(out).not.toContain("Alex Example");
    expect(out).not.toContain("Sam Sample");
    expect(out).toContain("Person-A");
    expect(egress.toModel("Alex Example returns.")).toContain("Person-A");
    expect(egress.restoreLocal(out)).toBe("Alex Example can cover if Sam Sample cannot.");
  });

  it("fails closed on undeclared contact or care fields", () => {
    expect(() => egress.toModelPayload({ note: "call 555-0100" })).toThrow("fail-closed");
    expect(() => egress.toModelPayload({ prayer: "please pray" })).toThrow("fail-closed");
    expect(egress.toModelPayload({ note: "Nursery needs one person." })).toEqual({ note: "Nursery needs one person." });
  });
});

describe("TaskLedger cancellation and late results", () => {
  it("cancelled runs cannot be revived by late results", () => {
    const ledger = new TaskLedger();
    ledger.transition("task-1", "admitted");
    ledger.transition("task-1", "running");
    ledger.transition("task-1", "cancelled");
    expect(() => ledger.transition("task-1", "verified")).toThrow("cancelled");
    expect(ledger.state("task-1")).toBe("cancelled");
  });

  it("keeps accepted, prepared, and verified distinct", () => {
    const ledger = new TaskLedger();
    ledger.transition("task-2", "admitted");
    expect(ledger.state("task-2")).toBe("admitted");
    ledger.transition("task-2", "running");
    ledger.transition("task-2", "verified");
    expect(ledger.state("task-2")).toBe("verified");
  });
});
