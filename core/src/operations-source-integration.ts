import { evaluateOperations } from "./operations-findings/index.js";
import { validate } from "./operations-findings/validate.js";
import type { Booking, OperationsInput, OperationsResult, SourceScope } from "./operations-findings/types.js";
import { isJsonData, isRecord } from "./read-result.js";

/** Assertions supplied by the host are fictional local observations, not authorization. */
export interface OperationsSources extends Pick<OperationsInput, "binding" | "evaluated_at" | "window" | "churchTimeZone" | "required_scopes"> {
  scopes: Array<{ observation: SourceScope; grant: "asserted" | "denied" | "unknown" }>;
  calendar: {
    bookings: Array<Omit<Booking, "status"> & { lifecycle: "present" | "cancelled" | "unknown"; setup_coverage: "asserted" | "unknown" }>;
    requests: Array<{ resource_id: string; booking_id: string; status: "requested" | "approved" | "declined" | "unknown" }>;
    request_scopes: Array<{ observation: SourceScope; grant: "asserted" | "denied" | "unknown" }>;
    conflicts: OperationsInput["resolutions"];
  };
  church_rules: OperationsInput["room_rules"];
  workflow: { cards: OperationsInput["cards"] };
}

const exact = (v: unknown, keys: string[]): v is Record<string, unknown> =>
  isRecord(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const id = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(v);
const invalid = (): OperationsResult => evaluateOperations(null as unknown as OperationsInput);

/** No I/O: evaluate only explicitly supplied minimized observations and local rules. */
export function evaluateOperationsSources(value: unknown): OperationsResult {
  if (!isJsonData(value) || !exact(value, ["binding", "evaluated_at", "window", "churchTimeZone", "required_scopes", "scopes", "calendar", "church_rules", "workflow"]) ||
      JSON.stringify(value).length > 1_000_000 || !Array.isArray(value.scopes) || value.scopes.length > 128 ||
      !exact(value.calendar, ["bookings", "requests", "request_scopes", "conflicts"]) || !exact(value.workflow, ["cards"]) ||
      !Array.isArray(value.calendar.bookings) || value.calendar.bookings.length > 64 ||
      !Array.isArray(value.calendar.requests) || value.calendar.requests.length > 64 ||
      !Array.isArray(value.calendar.request_scopes) || value.calendar.request_scopes.length > 128) return invalid();
  if (!value.scopes.every(s => exact(s, ["observation", "grant"]) && ["asserted", "denied", "unknown"].includes(s.grant as string))) return invalid();
  if (!value.calendar.request_scopes.every(s => exact(s, ["observation", "grant"]) && ["asserted", "denied", "unknown"].includes(s.grant as string))) return invalid();
  if (!value.calendar.bookings.every(b => exact(b, ["scope_id", "resource_id", "booking_id", "interval", "lifecycle", "setup_coverage"]) &&
    ["present", "cancelled", "unknown"].includes(b.lifecycle as string) && ["asserted", "unknown"].includes(b.setup_coverage as string))) return invalid();
  if (!value.calendar.requests.every(r => exact(r, ["resource_id", "booking_id", "status"]) && id(r.resource_id) && id(r.booking_id) &&
    ["requested", "approved", "declined", "unknown"].includes(r.status as string))) return invalid();
  const source = value as unknown as OperationsSources;
  // Reject ambiguous or orphaned joins; an absent join is deliberately unknown.
  const key = (r: { resource_id: string; booking_id: string }) => JSON.stringify([r.resource_id, r.booking_id]);
  const bookingKeys = source.calendar.bookings.map(key), requestKeys = source.calendar.requests.map(key);
  if (new Set(requestKeys).size !== requestKeys.length || requestKeys.some(k => bookingKeys.filter(b => b === k).length !== 1)) return invalid();
  const input: OperationsInput = {
    binding: source.binding, evaluated_at: source.evaluated_at, window: source.window, churchTimeZone: source.churchTimeZone,
    required_scopes: source.required_scopes,
    scopes: source.scopes.map(({ observation }) => observation),
    bookings: source.calendar.bookings.map(booking => ({ scope_id: booking.scope_id, resource_id: booking.resource_id,
      booking_id: booking.booking_id, interval: booking.interval, status: booking.lifecycle === "cancelled" ? "cancelled" :
      booking.lifecycle === "present" ? source.calendar.requests.find(r => key(r) === key(booking))?.status ?? "unknown" : "unknown" })),
    room_rules: source.church_rules, resolutions: source.calendar.conflicts, cards: source.workflow.cards,
  };
  // Validate before editing scope assertions, so extra source fields cannot be discarded.
  if (validate(input)) return evaluateOperations(input);
  const requestScopes = source.calendar.request_scopes;
  if (validate({ ...input, scopes: requestScopes.map(s => s.observation) })) return invalid();
  if (requestScopes.some(s => !input.required_scopes.some(r => r.kind === "bookings" && r.scope_id === s.observation.scope_id)) ||
      new Set(requestScopes.map(s => s.observation.scope_id)).size !== requestScopes.length) return invalid();
  input.bookings = input.bookings.map((booking, i) => source.calendar.bookings[i]!.setup_coverage === "unknown" ? { ...booking, interval: null } : booking);
  input.scopes = source.scopes.map(({ observation, grant }) => grant === "asserted" ? observation : {
    ...observation, completeness: grant === "denied" ? "denied" : "unverified",
    enumeration_complete: false, errors: [...observation.errors, grant === "denied" ? "denied" : "unverified"],
  });
  input.scopes = input.scopes.map(scope => {
    if (!input.required_scopes.some(r => r.kind === "bookings" && r.scope_id === scope.scope_id)) return scope;
    const now = Date.parse(input.evaluated_at), check = Date.parse(scope.check_time), until = Date.parse(scope.valid_until);
    // The second observation must never make an invalid original scope appear current.
    if (!(check <= now && now < until && until - check <= 86400000)) return scope;
    const request = requestScopes.find(s => s.observation.scope_id === scope.scope_id);
    if (!request) return { ...scope, completeness: "unverified", enumeration_complete: false };
    const r = request.observation;
    const count = source.calendar.requests.filter(row => source.calendar.bookings.some(b => b.scope_id === scope.scope_id && key(b) === key(row))).length;
    const usable = request.grant === "asserted" && r.source === "normalized-calendar" &&
      r.binding.workspace_id === input.binding.workspace_id && r.binding.organization_id === input.binding.organization_id && r.binding.access_epoch === input.binding.access_epoch &&
      Date.parse(r.window.starts_at) === Date.parse(input.window.starts_at) && Date.parse(r.window.ends_at) === Date.parse(input.window.ends_at) &&
      r.completeness === "complete" && r.enumeration_complete && r.errors.length === 0 && r.expected_count === count &&
      Date.parse(r.check_time) <= now && now < Date.parse(r.valid_until) && Date.parse(r.valid_until) - Date.parse(r.check_time) <= 86400000;
    if (!usable) return { ...scope, completeness: request.grant === "denied" ? "denied" : "unverified", enumeration_complete: false };
    return { ...scope, check_time: Date.parse(scope.check_time) < Date.parse(r.check_time) ? scope.check_time : r.check_time,
      valid_until: Date.parse(scope.valid_until) < Date.parse(r.valid_until) ? scope.valid_until : r.valid_until };
  });
  return evaluateOperations(input);
}
