// A church on B1 Church or Breeze, as Ask's tools read its check (core/src/harness/tools.ts HarnessData). The tools read
// who a check named (to label them; local only), whose church it is (the labels' scope) and when it finished from the
// check itself, and every Services fact from its brief, which the app passes beside it (brief.ts buildSystemBrief).
import type { SundayCapture } from "../sunday-capture.js";
import { namesOf, placeholderScope } from "./placeholders.js";
import type { SystemCapture } from "./types.js";

/**
 * The check as the harness holds it (HarnessData `capture`): who it named, local only, under the church's placeholder
 * scope (`<system>:<church id>`), when it finished, and whether it is a saved copy. It holds no Planning Center read, so
 * nothing of Calendar, People or Groups is ever said from it. The system is its service type, so a harness made for one
 * church's system never reads another's (host.ts binds each harness to the service type it first sees).
 */
export function systemHarnessCapture(capture: SystemCapture, saved: boolean): SundayCapture {
  return {
    version: 1, kind: saved ? "recording" : "live", organization: placeholderScope(capture), service_type_id: capture.system, plan_id: capture.service?.id ?? "",
    started_at: capture.started_at, completed_at: capture.completed_at, reads: [], names: namesOf(capture) as Record<string, string>, labels: {},
  };
}
