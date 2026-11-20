// The fictional Sunday (core/src/fictional-sunday.ts) with a second service time in the same plan, for the Services page's
// grouping by service time (owner decision 2026-11-19). Fictional people only; no clock, no I/O.
import { nov22Capture } from "../../../src/fictional-sunday.js";
import type { SundayCapture } from "../../../src/sunday-capture.js";

/**
 * The fictional Sunday with a second service at 11:00 AM in the same plan: Nursery is needed (and its confirmed person
 * serves) at 11:00 only; Greeter and Lyrics stay at 9:30.
 */
export function twoTimes(): SundayCapture {
  const c = nov22Capture();
  const eleven = { starts_at: "2026-11-22T16:00:00Z", ends_at: "2026-11-22T17:00:00Z" };
  const reads = c.reads.map(r => {
    const body = r.body as { data?: unknown } | undefined;
    if (r.collection === "plan_times") return { ...r, body: { data: [...(body!.data as unknown[]), { type: "PlanTime", id: "9002", attributes: { ...eleven, time_type: "service" } }], meta: { count: 2, total_count: 2 } } };
    if (r.collection === "needed_positions" || r.collection === "team_members") {
      const data = (body!.data as { id: string; relationships: Record<string, unknown> }[]).map(row => row.id === "302"
        ? { ...row, relationships: { ...row.relationships, time: { data: { type: "PlanTime", id: "9002" } } } }
        : row.id === "402" ? { ...row, relationships: { ...row.relationships, times: { data: [{ type: "PlanTime", id: "9002" }] } } } : row);
      return { ...r, body: { ...(r.body as object), data } };
    }
    return r;
  });
  return { ...c, reads } as SundayCapture;
}

