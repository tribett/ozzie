import { isTimeZone } from "../church-time.js";
import { isJsonData, isRecord, isSourceInstant } from "../read-result.js";
import type { OperationsInput } from "./types.js";
type Check = (v: unknown) => boolean;
const id: Check = v => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(v);
const one = (...values: unknown[]): Check => v => values.includes(v);
const nullable = (check: Check): Check => v => v === null || check(v);
const integer = (max: number): Check => v => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max;
const list = (check: Check, max: number): Check => v => Array.isArray(v) && v.length <= max && v.every(check);
const exact = (shape: Record<string, Check>): Check => v => isRecord(v) && Object.keys(v).length === Object.keys(shape).length &&
  Object.entries(shape).every(([key, check]) => Object.hasOwn(v, key) && check(v[key]));
const instant: Check = v => isSourceInstant(v) && Number(v.slice(0, 4)) >= 2000 && Number(v.slice(0, 4)) <= 2100;
const interval: Check = exact({ starts_at: instant, ends_at: instant });
const binding: Check = exact({ workspace_id: id, organization_id: id, access_epoch: id });
const target: Check = v => exact({ kind: one("room"), resource_id: id })(v) || exact({ kind: one("step"), workflow_id: id, step_id: id })(v);
const fact = (value: Check): Check => exact({ scope_id: id, value });
const required = exact({ scope_id: id, kind: one("bookings", "room-rule", "room-resolutions", "cards", "card-state", "assignments", "due", "snooze"), target });
const source = exact({ scope_id: id, binding, window: interval, source: one("normalized-calendar", "normalized-workflow", "church-rule"),
  check_time: instant, valid_until: instant, completeness: one("complete", "partial", "stale", "denied", "unreadable", "unverified"),
  enumeration_complete: one(true, false), expected_count: integer(512), errors: list(one("denied", "partial", "stale", "provider-failure", "unverified"), 8) });
const booking = exact({ scope_id: id, resource_id: id, booking_id: id, status: one("requested", "approved", "declined", "cancelled", "unknown"), interval: nullable(interval) });
const rule = exact({ scope_id: id, resource_id: id, rule_id: id, exclusive: one(true, false, null), additional_setup_minutes: nullable(integer(1440)) });
const resolution = exact({ scope_id: id, resource_id: id, booking_ids: v => Array.isArray(v) && v.length === 2 && v.every(id) && v[0] !== v[1], interval,
  state: one("unresolved", "shared", "resolved", "unknown") });
const card = exact({ scope_id: id, workflow_id: id, step_id: id, card_id: id,
  lifecycle: fact(exact({ state: one("active", "completed", "removed", "unknown"), readiness: one("ready", "not-ready", "unknown"), current_step_id: nullable(id) })),
  assignment: fact(one("assigned", "unassigned", "unknown")), due: fact(nullable(instant)),
  snooze: fact(exact({ state: one("unsnoozed", "snoozed", "unknown"), until: nullable(instant) })) });
// An IANA name this Mac knows, including ones it canonicalizes (Asia/Kolkata, Etc/UTC).
const zone: Check = isTimeZone;
const inputShape = exact({ binding, evaluated_at: instant, window: interval, churchTimeZone: zone,
  required_scopes: list(required, 128), scopes: list(source, 128), bookings: list(booking, 64), room_rules: list(rule, 64), resolutions: list(resolution, 512), cards: list(card, 128) });

/** Called before property reads, serialization or iteration of any source values. */
export function validate(value: unknown): "invalid-input" | "limit-exceeded" | null {
  if (!isJsonData(value)) return "invalid-input";
  if (JSON.stringify(value).length > 1_000_000) return "limit-exceeded";
  if (isRecord(value)) for (const [key, limit] of Object.entries({ required_scopes: 128, scopes: 128, bookings: 64, room_rules: 64, resolutions: 512, cards: 128 })) {
    if (Array.isArray(value[key]) && value[key].length > limit) return "limit-exceeded";
  }
  if (!inputShape(value)) return "invalid-input";
  const input = value as OperationsInput;
  const bounds = [input.window, ...input.scopes.map(s => s.window), ...input.bookings.flatMap(b => b.interval ? [b.interval] : []), ...input.resolutions.map(r => r.interval)];
  if (bounds.some(i => Date.parse(i.starts_at) >= Date.parse(i.ends_at)) || Date.parse(input.window.ends_at) - Date.parse(input.window.starts_at) > 31 * 86400000) return "invalid-input";
  return null;
}
