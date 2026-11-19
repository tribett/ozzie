import { invoke } from "@tauri-apps/api/core";
import type { DraftModelRequest } from "../../../core/src/draft-request.js";
import { pausedUntil } from "./onboarding-bridge.js";

/** Ozzie's AI notices (owner decision 2026-10-26): at three quarters, at nine tenths, and paused at the limit. */
export type ManagedWarning = "three-quarters" | "nine-tenths" | "paused";
/**
 * The account's plan and usage on ozzie.church (native hosted.rs Account): a plan id, counts of AI steps and the day
 * the allowance starts again. `offline`: ozzie.church couldn't be reached, so this is the reading from `checked_at_ms`.
 * `plan_reason` (contract N7): why there is no plan, read only through onboarding-bridge.ts `planReason`. `paused_until`:
 * when a pause ends (payments-go-live.md "For the app"), read only through `pausedUntil` / `pausedWhen`.
 */
export interface ManagedAccount {
  plan: string; allowance_steps: number; used_steps: number; period_ends: string;
  warning: ManagedWarning | null; checked_at_ms: number; offline: boolean; plan_reason?: unknown; paused_until?: unknown;
  /** ozzie.church's own count of whole answers left this month (payments-go-live.md), read only as a whole number. */
  answers_left?: unknown;
}
/** The own route's month (contract N5): AI requests used, the limit, and the day it starts again (`YYYY-MM-01`, UTC). */
export interface MonthUse { used: number; limit: number; resets_on: string }
/**
 * Which AI route is set up on this Mac (native model.rs ModelStatus). Keys live only in the Keychain and never reach the
 * web view. `setup` says what is missing: "ready"; "no-route" (nothing chosen); "no-key" (no key saved for the route);
 * "own-key-not-bound" (a key saved the old way, tied to no address and never used); "not-checked" (AI on this Mac
 * chosen, "Check that it answers" never passed: never ready before it); "not-on-this-mac" (AI on this Mac chosen, but
 * the model runs elsewhere, as Ollama's cloud models do: never used); "month-limit" (the church's own key reached
 * its monthly limit); for Ozzie's AI, "not-connected" or "reconnect". `provider`: the own route at a company Ozzie
 * knows. `month`: the own route's monthly count. `checked_at_ms`: when AI on this Mac last answered the check.
 * `label` is native's own description and is never shown: every word on screen comes from these closed codes.
 */
export interface ModelStatus {
  configured: boolean; route: "managed" | "own" | "local" | "none"; label: string;
  setup?: "ready" | "no-route" | "no-key" | "own-key-not-bound" | "not-checked" | "not-on-this-mac" | "month-limit" | "not-connected" | "reconnect";
  key_account?: string | null;
  managed?: "not-connected" | "connected" | "reconnect"; account?: ManagedAccount | null;
  provider?: "openai" | "anthropic" | "gemini" | null; month?: MonthUse | null; checked_at_ms?: number | null;
  /** The local route is a model Ozzie no longer offers, or Ozzie's copy of one; it keeps working (review L-4). */
  not_offered?: boolean;
  /** The local route's app ("ollama" | "lm-studio"), by its address; null on every other route. */
  local_app?: "ollama" | "lm-studio" | null;
}
export const model = {
  status: () => invoke<ModelStatus>("model_status"),
  /** Native call; the request has already passed the placeholder boundary. Returns the model's raw reply text. */
  reword: (request: DraftModelRequest) => invoke<string>("reword_draft", { request }),
  /** Saves the non-secret route only. A key is taken natively (onboarding-bridge.ts `enterKey`), never here. */
  setRoute: (route: "managed" | "own" | "local", baseUrl?: string, model?: string) =>
    invoke<ModelStatus>("set_model_route", { route, baseUrl: baseUrl || null, model: model || null }),
  /** Revokes this Mac's connection to Ozzie's AI (best effort) and forgets it. Resolves with the status after. */
  disconnect: () => invoke<ModelStatus>("managed_disconnect"),
};

/**
 * About how many AI steps one answer takes, to say usage in plain words: a question or a procedure usually looks
 * something up once or twice, then chooses the facts; rewording a note is one. ozzie.church counts units (a typical
 * step is one); this estimate only turns them into "about N answers", the same as the website's `UNITS_PER_ANSWER`
 * (web/src/lib/hosted/limits.ts), so Personal's 1,500 units read as about 400 answers (decision 17). Never a fraction.
 */
export const STEPS_PER_ANSWER = 3.75;
/** Whole answers left this month: ozzie.church's own count when it sends one, else worked out at STEPS_PER_ANSWER; never below zero. */
export const answersLeft = (a: ManagedAccount): number => typeof a.answers_left === "number" && Number.isInteger(a.answers_left) && a.answers_left >= 0
  ? a.answers_left : Math.max(0, Math.floor((a.allowance_steps - a.used_steps) / STEPS_PER_ANSWER));
/** A calendar day as "December 1", read as a date (UTC) so midnight never shows as the day before; null if unreadable. */
export function calendarDay(when: string): string | null {
  const at = new Date(when.length === 10 ? `${when}T00:00:00Z` : when);
  return Number.isNaN(at.getTime()) ? null : new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", timeZone: "UTC" }).format(at);
}
/** The day the allowance starts again, as "December 1". */
export const resetDay = (a: ManagedAccount): string | null => calendarDay(a.period_ends);
/** The first of next month (UTC), as "December 1": when a monthly limit starts again if native didn't say. */
export function nextMonthDay(now = Date.now()): string {
  const at = new Date(now);
  return calendarDay(new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1)).toISOString())!;
}
/**
 * When a pause ends (an account's `paused_until`), on this Mac's clock: "today, 7:00 PM", "tomorrow, 7:00 PM", or
 * "December 17, 7:00 PM". `zone` only for tests; null when the instant can't be read.
 */
export function untilWhen(instant: string, now = Date.now(), zone?: string): string | null {
  const at = Date.parse(instant);
  if (!Number.isFinite(at) || !Number.isFinite(now)) return null;
  const tz = zone ? { timeZone: zone } : {};
  const date = (ms: number) => new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", ...tz }).format(ms);
  const today = date(now);
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  const tomorrow = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", ...tz }).format(at);
  const day = date(at);
  return day === today ? `today, ${time}` : day === tomorrow ? `tomorrow, ${time}` : `${new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", ...tz }).format(at)}, ${time}`;
}
/** When a day's limit ends: AI starts again after midnight UTC (native model.rs DailyLimit), on this Mac's clock. */
export function dailyLimitEnds(now = Date.now(), zone?: string): string | null {
  const d = new Date(now);
  return untilWhen(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString(), now, zone);
}
/** Ozzie's AI paused until a known time (the account's `paused_until`), wherever AI help was asked for. */
export const pausedLine = (when: string) => `Ozzie's AI is paused until ${when}. Everything else in Ozzie still works.`;
/** The account's pause end on this Mac's clock, only while it is still ahead. */
export function pausedWhen(account: unknown, now = Date.now(), zone?: string): string | null {
  const until = pausedUntil(account);
  return until && Date.parse(until) > now ? untilWhen(until, now, zone) : null;
}
export const paused = (a: ManagedAccount) => a.warning === "paused" || a.used_steps >= a.allowance_steps;
/** No plan on the account: no allowance and no day to wait for. */
export const noPlan = (a: ManagedAccount) => a.plan === "none" || a.allowance_steps <= 0;

/** Ozzie's AI with no plan on the account (spec §9). */
export const NO_PLAN_TEXT = "Ozzie's AI is off: there's no plan on your account. Everything else in Ozzie keeps working, and nothing charges itself.";
/** The church's own key at its monthly limit (spec S8, "The monthly limit"). */
export const monthLimitText = (day: string | null = null) =>
  `AI has paused on this Mac until ${day ?? nextMonthDay()}, as your monthly limit says. Everything else in Ozzie still works.`;
/** When ozzie.church couldn't be reached: where the numbers came from. */
export function offlineLine(a: ManagedAccount): string {
  const at = new Date(a.checked_at_ms);
  const time = Number.isNaN(at.getTime()) ? "earlier" : new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }).format(at);
  return `Ozzie couldn't reach its website just now. These numbers are from ${time}.`;
}
/** Why disconnecting this Mac from Ozzie's AI didn't work, in plain words (native hosted.rs ManagedError). */
export function managedProblem(error: unknown): string {
  const code = typeof error === "string" ? error : "";
  switch (code) {
    case "cancelled": return "Nothing changed on this Mac.";
    case "keychain": return "This Mac didn't let Ozzie change its connection. Unlock this Mac (type your Mac password if it asks), then try again.";
    case "busy": return "Ozzie is already waiting for you in your browser.";
    default: return "Ozzie couldn't reach its website just now. Nothing changed. Try again in a minute.";
  }
}
/** Why a route couldn't be saved, in plain words. */
export function routeProblem(error: unknown): string {
  const known = JSON.stringify(error) ?? "";
  if (known.includes("name-present")) return "The model name looks like it holds a person's name, so Ozzie didn't save it. Check the model name and try again.";
  if (known.includes("not-on-this-mac")) return "That model doesn't run on this Mac, so Ozzie didn't choose it. Nothing changed.";
  if (known.includes("not-configured") || known.includes("invalid")) return "Ozzie couldn't use that address. It needs the AI company's https address (not Planning Center's).";
  return "Ozzie couldn't save that choice. Nothing changed. Try again.";
}
/**
 * A note with background-check wording, stopped on this Mac or by ozzie.church before the AI (native `background-check`;
 * owner decision 2026-11-14): the page's own words for a note about one (ask.ts REFUSALS.backgroundNote), then the draft.
 */
export const BACKGROUND_NOTE_TEXT = "Ozzie doesn't use AI help for notes with background-check or child-safety screening wording, so nothing was sent. Your draft is unchanged.";
/** A note holding a hidden or invisible character, stopped on this Mac or by ozzie.church before the AI (native `hidden-character`). */
export const HIDDEN_NOTE_TEXT = "This note has a hidden or invisible character in it, so Ozzie didn't send it to the AI. Your draft is unchanged.";
/** Rewording with no AI that works (native `not-configured`): the note offers "Choose how Ozzie uses AI" under it. */
export const REWORD_NEEDS_AI = "Rewording needs AI, but everything else in Ozzie works without it. Your draft is unchanged.";
/**
 * Rewording on AI on this Mac whose model runs elsewhere (native `not-on-this-mac`: Ollama's cloud models): nothing was
 * sent; "Choose how Ozzie uses AI" under it, as for no AI.
 */
export const REWORD_NOT_ON_MAC = "The AI model chosen for AI on this Mac doesn't run on this Mac, so Ozzie didn't send it anything. Your draft is unchanged.";
/** Ozzie's AI's allowance is spent (native `allowance-paused`): the same words wherever AI help was asked for. */
export const PAUSED_TEXT = "Ozzie's AI is paused until this month's answers start again. Everything else in Ozzie still works.";
/**
 * Why AI help didn't happen, in plain words. `account`: Ozzie's AI's account when the page has it; when it says until when
 * AI is paused (`paused_until`), a pause or a slow-down says that time, never "try again in a minute".
 */
export function modelProblem(error: unknown, account?: unknown): string {
  const known = JSON.stringify(error) ?? "";
  if (known.includes("month-limit")) return `${monthLimitText()} Your draft is unchanged.`;
  // The church's own AI company says the account has no credit left (native no-credit, in normal use).
  if (known.includes("no-credit")) return "The AI company says your account has no credit left, or has reached a spending limit. Add credit or raise the limit on their billing page, then try again. Your draft is unchanged.";
  const when = pausedWhen(account);
  // rate-limited is only "busy" now: the account's daily ceiling has its own code, daily-limit (native re-check NM1).
  if (when && known.includes("allowance-paused")) return `${pausedLine(when)} Your draft is unchanged.`;
  if (known.includes("allowance-paused")) return `${PAUSED_TEXT} Your draft is unchanged.`;
  // A day's limit (native `daily-limit`): until the account's time, or midnight UTC on this Mac's clock, never "in a
  // minute", and never "tomorrow" when that is this evening (re-check Low).
  if (known.includes("daily-limit")) return `Ozzie's AI has reached today's limit. It starts again ${when ?? dailyLimitEnds() ?? "within a day"}. Your draft is unchanged.`;
  if (known.includes("not-on-this-mac")) return REWORD_NOT_ON_MAC;
  if (known.includes("not-configured")) return REWORD_NEEDS_AI;
  if (known.includes("name-present")) return "Ozzie stopped this request because it contained a person's name. Nothing was sent; your draft is unchanged.";
  if (known.includes("model-not-allowed")) return "The chosen AI model isn't available to this account. Your draft is unchanged.";
  if (known.includes("budget")) return "Ozzie has reached its AI limit on this Mac for now. Your draft is unchanged.";
  if (known.includes("rate-limited")) return "The AI service asked Ozzie to slow down. Try again in a minute.";
  if (known.includes("contact-detail")) return "This note looks like it holds a phone number or email address, so Ozzie's AI didn't send it. Your draft is unchanged.";
  if (known.includes("background-check")) return BACKGROUND_NOTE_TEXT;
  if (known.includes("hidden-character")) return HIDDEN_NOTE_TEXT;
  return "The AI couldn't be reached. Your draft is unchanged.";
}
