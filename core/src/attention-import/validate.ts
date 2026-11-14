import { isJsonData, isRecord, isSourceInstant } from "../read-result.js";
import type { Anchor, AttentionInput } from "./index.js";

const keys = (value: unknown, names: string[]): value is Record<string, unknown> =>
  isRecord(value) && Object.keys(value).length === names.length && names.every(key => Object.hasOwn(value, key));
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const rows = (value: unknown, max: number): value is unknown[] => Array.isArray(value) && value.length <= max;
const unique = (values: string[]) => new Set(values).size === values.length;
const binding = (value: unknown) => keys(value, ["workspace_id", "account_id"]) && id(value.workspace_id) && id(value.account_id);
const instant = (value: unknown): value is string => isSourceInstant(value);
function anchor(value: unknown, body: string): value is Anchor {
  return keys(value, ["start", "end", "quote"]) &&
    Number.isInteger(value.start) && Number.isInteger(value.end) &&
    typeof value.start === "number" && typeof value.end === "number" &&
    value.start >= 0 && value.end > value.start && value.end <= body.length &&
    text(value.quote, 1024) && body.slice(value.start, value.end) === value.quote;
}

/** Validate inert data before reading fields. Errors deliberately contain no input. */
export function validate(value: unknown): "invalid-import" | "binding-denied" | AttentionInput {
  if (!isJsonData(value) || !keys(value, ["kind", "host", "workspace_id", "account_id", "timezone",
    "imported_at", "evaluated_at", "valid_until", "scopes", "messages", "events", "assertions"])) return "invalid-import";
  if (value.kind !== "fictional-import" || value.timezone !== "America/New_York" || !binding(value.host) ||
    !id(value.workspace_id) || !id(value.account_id) ||
    !instant(value.imported_at) || !instant(value.evaluated_at) || !instant(value.valid_until) ||
    !keys(value.scopes, ["mail", "calendar"]) || !rows(value.messages, 32) || !rows(value.events, 32) || !rows(value.assertions, 64)) return "invalid-import";
  const imported = Date.parse(value.imported_at);
  if (imported > Date.parse(value.evaluated_at) || Date.parse(value.valid_until) <= imported ||
    Date.parse(value.valid_until) - imported > 172800000) return "invalid-import";
  for (const scope of Object.values(value.scopes)) {
    if (!keys(scope, ["outcome", "expected_ids"]) ||
      !["complete", "partial", "stale", "denied"].includes(scope.outcome as string) ||
      !rows(scope.expected_ids, 32) || !scope.expected_ids.every(id) || !unique(scope.expected_ids)) return "invalid-import";
  }
  for (const message of value.messages) {
    if (!keys(message, ["workspace_id", "account_id", "id", "received_at", "subject", "body"]) ||
      !id(message.workspace_id) || !id(message.account_id) || !id(message.id) ||
      !instant(message.received_at) || Date.parse(message.received_at) > imported ||
      !text(message.subject, 256) || !text(message.body, 4096)) return "invalid-import";
  }
  for (const event of value.events) {
    if (!keys(event, ["workspace_id", "account_id", "id", "modified_at", "title", "start_at", "end_at", "location", "status"]) ||
      !id(event.workspace_id) || !id(event.account_id) || !id(event.id) ||
      !instant(event.modified_at) || Date.parse(event.modified_at) > imported ||
      !instant(event.start_at) || !instant(event.end_at) || Date.parse(event.end_at) <= Date.parse(event.start_at) ||
      !text(event.title, 256) || !text(event.location, 256) ||
      !["confirmed", "cancelled", "unknown"].includes(event.status as string)) return "invalid-import";
  }
  const input = value as unknown as AttentionInput;
  if (input.host.workspace_id !== input.workspace_id || input.host.account_id !== input.account_id ||
    [...input.messages, ...input.events].some(row => row.workspace_id !== input.workspace_id || row.account_id !== input.account_id)) return "binding-denied";
  if (!unique([...input.scopes.mail.expected_ids, ...input.scopes.calendar.expected_ids]) ||
    !unique([...input.messages, ...input.events].map(row => row.id)) ||
    input.messages.some(m => !input.scopes.mail.expected_ids.includes(m.id)) ||
    input.events.some(e => !input.scopes.calendar.expected_ids.includes(e.id))) return "invalid-import";
  for (const assertion of input.assertions) {
    if (!keys(assertion, ["kind", "message_id", "event_id", "anchor", "not_contacted"]) ||
      !["location-unavailable", "event-cancelled", "explicitly-no-action", "untrusted-instruction"].includes(assertion.kind) ||
      !id(assertion.message_id)) return "invalid-import";
    const message = input.messages.find(m => m.id === assertion.message_id);
    if (!message || !anchor(assertion.anchor, message.body) ||
      (assertion.not_contacted !== null && !anchor(assertion.not_contacted, message.body))) return "invalid-import";
    const operational = assertion.kind === "location-unavailable" || assertion.kind === "event-cancelled";
    if (operational && assertion.event_id === null) return "invalid-import";
    if (assertion.event_id !== null && (!id(assertion.event_id) ||
      !input.scopes.calendar.expected_ids.includes(assertion.event_id))) return "invalid-import";
    if (!operational && assertion.not_contacted !== null) return "invalid-import";
  }
  return input;
}
