// Runtime task events in the native task ledger's detail grammar (review 2026-11-14 A6). The loops emit
// "step 1", "sunday.open_needs:complete" and "unknown:denied"; the native ledger (core/native-auth/src/
// ledger.rs `detail_ok`) takes "1", "sunday.open_needs complete" and "denied". This is the one translation,
// so the app never maps event text itself. Anything that doesn't fit the native grammar is null and is
// never recorded: the ledger holds only allowlisted tool names, step numbers and fixed codes.
import { NATIVE_TOOL_ALLOWLIST, type FailureCode, type TaskEvent } from "./contract.js";

const COMPLETENESS: ReadonlySet<string> = new Set(["complete", "partial", "stale", "denied"]);
/** contract.ts FailureCode, as native's FailureCode::ALL. */
export const FAILURE_CODES: readonly FailureCode[] = Object.freeze(["denied", "stale", "partial", "provider-failure", "unverified", "invalid-task", "limit",
  "timeout", "cancelled", "egress", "fidelity", "transport", "no-model", "interrupted"]);
const FAILURES: ReadonlySet<string> = new Set(FAILURE_CODES);
const TOOLS: ReadonlySet<string> = new Set(NATIVE_TOOL_ALLOWLIST);
const FINISH: ReadonlySet<string> = new Set(["stop", "tool_calls", "length"]);
const STEP = /^[1-9]\d?$/u;
const status = (s: string) => COMPLETENESS.has(s) || FAILURES.has(s);

/** Native `detail_ok`, mirrored: at most 64 of [a-z0-9_.:\- ], then one closed grammar per event type. */
export function ledgerDetailOk(type: TaskEvent["type"], detail: string): boolean {
  if (detail.length > 64 || !/^[a-z0-9_.:\- ]*$/u.test(detail)) return false;
  const [head, rest, ...more] = detail.split(" ");
  if (more.length) return false;
  switch (type) {
    case "tool": return rest === undefined ? status(head!) : TOOLS.has(head!) && status(rest);
    case "model": return STEP.test(head!) && (rest === undefined || FINISH.has(rest) || FAILURES.has(rest));
    case "admitted": case "running": case "verified": return detail === "";
    case "failed": return FAILURES.has(detail);
    case "cancelled": return detail === "" || detail === "cancelled";
    default: return false;
  }
}

/**
 * The native ledger detail for one runtime event, or null when it can't be expressed:
 *   model "step <n>" [outcome]          → "<n>" or "<n> <stop|tool_calls|length|FailureCode>"
 *   tool "<allowlisted tool>:<status>"  → "<tool> <status>"   (status: a Completeness value or a FailureCode)
 *   tool "unknown:<status>" or "<status>" → "<status>" alone (a tool the allowlist doesn't hold is never named)
 *   failed "<FailureCode>", cancelled "" or "cancelled", and admitted, running and verified "" → unchanged.
 */
export function ledgerDetail(event: Pick<TaskEvent, "type" | "detail">): string | null {
  const { type, detail } = event;
  let out: string;
  if (type === "model") {
    const m = /^step ([1-9]\d?)(?: ([a-z_-]+))?$/u.exec(detail);
    if (!m) return null;
    out = m[2] === undefined ? m[1]! : `${m[1]} ${m[2]}`;
  } else if (type === "tool") {
    const at = detail.lastIndexOf(":");
    const name = at < 0 ? null : detail.slice(0, at), code = at < 0 ? detail : detail.slice(at + 1);
    out = name !== null && TOOLS.has(name) ? `${name} ${code}` : code;
  } else out = detail;
  return ledgerDetailOk(type, out) ? out : null;
}
