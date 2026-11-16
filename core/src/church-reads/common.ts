// Shared reading of the church reads in a Sunday capture (People forms, Check-Ins, Registrations).
// Pure: no I/O, no clock, no model. Rows are read defensively: anything that isn't the shape the
// native projection writes is skipped or makes the read count as not fully read, never guessed.
import type { SundayCapture, SundayRead } from "../sunday-capture.js";
import { isSourceInstant } from "../read-result.js";

export interface Row { type?: unknown; id?: unknown; attributes?: Record<string, unknown>; relationships?: Record<string, { data?: unknown } | undefined> }
export const asRows = (data: unknown): Row[] => (Array.isArray(data) ? data : data ? [data] : []).filter((r): r is Row => !!r && typeof r === "object");
export const bodyRows = (reads: readonly SundayRead[]) => reads.flatMap(r => r.body ? asRows(r.body.data) : []);
export const includedRows = (reads: readonly SundayRead[]) => reads.flatMap(r => r.body && Array.isArray(r.body.included) ? asRows(r.body.included) : []);
export const isId = (v: unknown): v is string => typeof v === "string" && /^[1-9]\d{0,19}$/.test(v);
export const rowId = (row: Row, type: string) => row.type === type && isId(row.id) ? row.id : null;
export const attr = (row: Row, key: string): unknown => row.attributes?.[key];
/** A to-one link's id: undefined when absent, null when explicitly empty, "" when it isn't a usable id of `type`. */
export function link(row: Row, key: string, type: string): string | null | undefined {
  const rel = row.relationships?.[key];
  if (!rel || typeof rel !== "object" || !("data" in rel)) return undefined;
  if (rel.data === null) return null;
  const data = rel.data && typeof rel.data === "object" ? rel.data as { id?: unknown; type?: unknown } : {};
  return data.type === type && isId(data.id) ? data.id : "";
}
/** A to-many link's ids of `type`, in order; null when it isn't a list. */
export function links(row: Row, key: string, type: string): string[] | null {
  const data = row.relationships?.[key]?.data;
  if (!Array.isArray(data)) return null;
  return data.flatMap(d => d && typeof d === "object" && (d as { type?: unknown }).type === type && isId((d as { id?: unknown }).id) ? [(d as { id: string }).id] : []);
}
export const instant = (v: unknown): string | null => isSourceInstant(v) && Number(v.slice(0, 4)) >= 2000 && Number(v.slice(0, 4)) <= 2100 ? v : null;
export const count = (v: unknown): number | null => Number.isSafeInteger(v) && (v as number) >= 0 ? v as number : null;
export const ms = (s: string) => Date.parse(s);
export const unique = <T>(xs: readonly T[]) => [...new Set(xs)];
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const answered = (r: SundayRead) => (r.outcome === "ok" || r.outcome === "truncated") && !!r.body;
export const earliest = (reads: readonly SundayRead[]) => reads.map(r => instant(r.checked_at)).filter((t): t is string => !!t).sort((a, b) => ms(a) - ms(b))[0] ?? null;

/** How a set of pages ended, for the "not checked" lines: every page complete, or the first reason it isn't. */
export type State = "ok" | "not-requested" | "denied" | "truncated" | "timeout" | "failed" | "missing";
export function stateOf(reads: readonly SundayRead[]): State {
  if (!reads.length) return "missing";
  const outcomes = reads.map(r => r.outcome);
  if (outcomes.every(o => o === "not-requested")) return "not-requested";
  if (outcomes.some(o => o === "denied")) return "denied";
  if (outcomes.some(o => o === "timeout")) return "timeout";
  if (outcomes.some(o => o !== "ok" && o !== "truncated") || reads.some(r => !r.body)) return "failed";
  if (outcomes.some(o => o === "truncated")) return "truncated";
  return "ok";
}
export const REASON: Record<Exclude<State, "ok">, string> = {
  "not-requested": "not connected for this yet", denied: "Planning Center didn't allow it", truncated: "only partly read",
  timeout: "took too long", failed: "couldn't be read", missing: "weren't part of this check",
};

/** A row's display name from the capture's local labels: single line, bounded, never empty. LOCAL ONLY. */
export function labelOf(capture: SundayCapture, prefix: string, id: string): string | null {
  const key = `${prefix}:${id}`;
  const text = capture.labels && Object.hasOwn(capture.labels, key) ? capture.labels[key] : undefined;
  if (typeof text !== "string") return null;
  const clean = text.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 120);
  return clean || null;
}
/** When the facts hold: a recording as of its completion, a live check as of the given time. */
export const evaluatedAt = (capture: SundayCapture, now?: string) => capture.kind === "recording" ? capture.completed_at : now ?? capture.completed_at;
