/** Machine-readable source outcomes. Messages never interpolate provider text. */
export type Completeness = "complete" | "partial" | "stale" | "denied";
export type ReadErrorCode = "denied" | "stale" | "partial" | "provider-failure" | "unverified";
export type ReadReason = "http-status" | "transport" | "invalid-data" | "invalid-total" |
  "invalid-count" | "invalid-row" | "duplicate-row" | "count-mismatch" | "invalid-link" |
  "path-denied" | "page-limit" | "row-limit" | "pagination-cycle" | "timeout" |
  "operation-timeout" | "cancelled" | "retry-limit" | "retry-delay" | "invalid-config" |
  "checksum" | "unsupported-format" | "invalid-bundle" | "missing-path" | "mixed-times" | "expired";
export interface ReadIssue { code: ReadErrorCode; reason: ReadReason }
export class ReadError extends Error {
  readonly completeness: Completeness;
  constructor(readonly code: ReadErrorCode, readonly reason: ReadReason, readonly status?: number) {
    super(`${code}: ${reason}`);
    this.name = "ReadError";
    this.completeness = code === "denied" ? "denied" : code === "stale" ? "stale" : "partial";
  }
}
export interface ReadResult {
  source: string;
  check_time: string;
  completeness: Completeness;
  rows: unknown[];
  counts: { raw: number; unique: number; total: number | null; pages: number };
  provenance: { origin: string; path: string; requested_version: string;
    /** Header observations only: not a documented server confirmation mechanism. */
    response_version_headers: Array<string | null>; provider_version: null };
  errors: ReadIssue[];
}
export const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

export const isDateOnly = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;

export const isSourceInstant = (v: unknown): v is string => typeof v === "string" &&
  /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(v) &&
  isDateOnly(v.slice(0, 10)) && Number.isFinite(Date.parse(v));

/** Bounded, inert JSON data only; never invoke source accessors or toJSON hooks. */
export function isJsonData(value: unknown): boolean {
  let nodes = 0, bytes = 0;
  const ancestors = new Set<object>();
  const visit = (v: unknown, depth: number): boolean => {
    if (++nodes > 100_000 || depth > 32) return false;
    if (typeof v === "string") { bytes += v.length * 3; return bytes <= 5_000_000; }
    if (v === null || typeof v === "boolean") return true;
    if (typeof v === "number") return Number.isFinite(v);
    if (typeof v !== "object" || ancestors.has(v)) return false;
    const array = Array.isArray(v);
    const prototype = Object.getPrototypeOf(v);
    if ((array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(v).length) return false;
    ancestors.add(v);
    let indices = 0;
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(v))) {
      if (array && key === "length") continue;
      if (!descriptor.enumerable || !("value" in descriptor)) return false;
      if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= v.length)) return false;
      bytes += key.length * 3;
      if (bytes > 5_000_000 || !visit(descriptor.value, depth + 1)) return false;
      indices++;
    }
    ancestors.delete(v);
    return !array || indices === v.length;
  };
  try { return visit(value, 0); } catch { return false; }
}
