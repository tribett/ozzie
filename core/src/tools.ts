import { ToolFailure, type Envelope, type ReadTool } from "./broker.js";

interface PlanPersonRow { position: string; status: "C" | "U" | "D" }
interface NeededRow { position: string; quantity: number }
export interface FictionalPlan { needed: NeededRow[]; people: PlanPersonRow[]; fetched: number; total: number }

/** Fictional in-memory provider data only. No network, no real people. */
export const fictionalPlans: Record<string, FictionalPlan> = {
  "plan-1": {
    needed: [
      { position: "Nursery support", quantity: 1 },
      { position: "Greeter", quantity: 1 },
    ],
    people: [
      { position: "Nursery support", status: "U" },
      { position: "Nursery support", status: "D" },
    ],
    fetched: 2,
    total: 2,
  },
  "plan-truncated": {
    needed: [{ position: "Nursery support", quantity: 1 }],
    people: [],
    fetched: 1,
    total: 3,
  },
};

export function neededPositionsTool(plans: Record<string, FictionalPlan>): ReadTool {
  return {
    name: "pco.needed_positions",
    read(args): Envelope {
      const planId = args["plan_id"];
      if (typeof planId !== "string" || typeof args["service_type_id"] !== "string") {
        throw new ToolFailure("denied");
      }
      const plan = plans[planId];
      if (!plan) throw new ToolFailure("unverified");
      const payload = plan.needed.map((n) => ({
        position: n.position,
        // quantity IS remaining need; assignments are never subtracted again.
        remaining_need: n.quantity,
        pending: plan.people.filter((p) => p.position === n.position && p.status === "U").length,
      }));
      return {
        source: "fictional in-memory Planning Center stand-in",
        check_time: "2026-10-30T12:00:00Z",
        completeness: plan.fetched === plan.total ? "complete" : "partial",
        payload,
      };
    },
  };
}
