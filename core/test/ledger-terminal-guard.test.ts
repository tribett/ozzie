import { expect, it } from "vitest";
import { TaskLedger } from "../src/ledger.js";

it("commits cancellation selected by the final guard without reopening a terminal task", () => {
  const ledger = new TaskLedger();
  ledger.transition("task", "admitted"); ledger.transition("task", "running");
  const selected = ledger.settle("task", "failed", () => {
    expect(ledger.state("task")).toBe("failed");
    return "cancelled";
  });
  expect(selected).toBe("cancelled");
  expect(ledger.state("task")).toBe("cancelled");
  expect(() => ledger.transition("task", "failed")).toThrow();
  expect(() => ledger.settle("task", "failed", () => "failed")).toThrow();
  expect(ledger.state("task")).toBe("cancelled");
});

it("rolls back an unconfirmed terminal choice and permits a later guarded failure", () => {
  const ledger = new TaskLedger();
  ledger.transition("task", "admitted"); ledger.transition("task", "running");
  for (const confirm of [() => { throw new Error("guard failed"); }, () => Promise.resolve("failed") as never]) {
    expect(() => ledger.settle("task", "failed", confirm)).toThrow();
    expect(ledger.state("task")).toBe("running");
  }
  expect(ledger.settle("task", "failed", () => "failed")).toBe("failed");
  expect(ledger.state("task")).toBe("failed");
  expect(() => ledger.transition("task", "cancelled")).toThrow();
});

it("refuses nested settlement and never downgrades a cancelled choice", () => {
  const ledger = new TaskLedger();
  ledger.transition("task", "admitted"); ledger.transition("task", "running");
  expect(() => ledger.settle("task", "cancelled", () => "failed")).toThrow();
  expect(ledger.state("task")).toBe("running");
  expect(ledger.settle("task", "cancelled", () => {
    expect(() => ledger.settle("task", "failed", () => "failed")).toThrow();
    return "cancelled";
  })).toBe("cancelled");
  expect(ledger.state("task")).toBe("cancelled");
  expect(ledger.state("unrelated")).toBe("proposed");
});
