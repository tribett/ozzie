import { evaluateAttentionImport, type AttentionResult } from "../../../core/src/attention-import/index.js";
import { preparedAttentionImport } from "./prepared.js";

export interface AttentionOutline {
  variant: "room" | "cancellation";
  coverage: "complete" | "calendar-denied" | "mail-denied" | "calendar-partial" | "mail-partial" | "stale";
  evaluation: "original" | "later";
}
export interface AttentionReview {
  phase: "outline" | "review" | "cancelled";
  generation: number;
  result: AttentionResult | null;
  outline: AttentionOutline;
  error: string | null;
}
export function createAttentionReview(): AttentionReview {
  return { phase: "outline", generation: 0, result: null, error: null,
    outline: { variant: "room", coverage: "complete", evaluation: "original" } };
}
const selections = {
  variant: ["room", "cancellation"],
  coverage: ["complete", "calendar-denied", "mail-denied", "calendar-partial", "mail-partial", "stale"],
  evaluation: ["original", "later"],
} as const;
export function updateAttentionOutline(state: AttentionReview, patch: unknown): AttentionReview {
  const next: AttentionReview = { ...state, phase: "outline", generation: state.generation + 1, result: null, error: null };
  if (!patch || typeof patch !== "object" || Array.isArray(patch) ||
    Object.entries(Object.getOwnPropertyDescriptors(patch)).some(([key, descriptor]) =>
      !Object.hasOwn(selections, key) || !descriptor.enumerable || !("value" in descriptor) ||
      !(selections[key as keyof AttentionOutline] as readonly unknown[]).includes(descriptor.value)) ||
    Object.getOwnPropertySymbols(patch).length) return { ...next, error: "Choose one of the prepared examples." };
  return { ...next, outline: { ...state.outline, ...patch } };
}
export function cancelAttentionReview(state: AttentionReview): AttentionReview {
  return { ...state, phase: "cancelled", generation: state.generation + 1, result: null, error: null };
}
export function confirmAttentionReview(state: AttentionReview, generation: number): AttentionReview {
  if (state.phase !== "outline" || generation !== state.generation || state.error) return state;
  const input = preparedAttentionImport();
  if (state.outline.variant === "cancellation") {
    input.messages[0]!.subject = "Orientation cancelled";
    input.messages[0]!.body = "The volunteer orientation tonight is cancelled. Please update our plans. I have not contacted the volunteers.";
    input.assertions[0] = { kind: "event-cancelled", message_id: "MSG-01", event_id: "CAL-01",
      anchor: { start: 0, end: 47, quote: "The volunteer orientation tonight is cancelled." },
      not_contacted: { start: 73, end: 109, quote: "I have not contacted the volunteers." } };
  }
  const coverage = state.outline.coverage;
  if (coverage === "calendar-denied") { input.scopes.calendar.outcome = "denied"; input.events = []; }
  if (coverage === "mail-denied") { input.scopes.mail.outcome = "denied"; input.messages = []; input.assertions = []; }
  if (coverage === "calendar-partial") { input.scopes.calendar.outcome = "partial"; input.events = input.events.slice(1); }
  if (coverage === "mail-partial") { input.scopes.mail.outcome = "partial"; input.messages = input.messages.slice(0, 1); input.assertions = input.assertions.slice(0, 1); }
  if (coverage === "stale") { input.scopes.mail.outcome = "stale"; input.scopes.calendar.outcome = "stale"; }
  if (state.outline.evaluation === "later") input.evaluated_at = "2026-11-20T14:00:00Z";
  return { ...state, phase: "review", result: evaluateAttentionImport(input) };
}
