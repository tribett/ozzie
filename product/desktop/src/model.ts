import { invoke } from "@tauri-apps/api/core";
import type { DraftModelRequest } from "../../../core/src/draft-request.js";
import type { AskModelRequest } from "../../../core/src/ask.js";

/** Ozzie managed's notices (owner decision 2026-10-26): at three quarters, at nine tenths, and paused at the limit. */
export type ManagedWarning = "three-quarters" | "nine-tenths" | "paused";
/**
 * The church's plan and usage on ozzie.church (native hosted.rs Account): a plan id, counts of AI steps and the day
 * the allowance resets. `offline`: ozzie.church couldn't be reached, so this is the reading from `checked_at_ms`.
 */
export interface ManagedAccount {
  plan: string; allowance_steps: number; used_steps: number; period_ends: string;
  warning: ManagedWarning | null; checked_at_ms: number; offline: boolean;
}
/**
 * Which model route is set up on this Mac (native model.rs ModelStatus). Keys live only in the Keychain and never
 * reach the webview. `setup` says what is missing: "ready"; "no-route" (nothing chosen); "no-key" (nothing saved
 * under `key_account`); "own-key-not-bound" (an own provider's key saved under the old account "own-provider", which
 * is tied to no address and never used); for Ozzie managed, "not-connected" (this Mac isn't connected) or "reconnect"
 * (ozzie.church no longer accepts this Mac's connection). `key_account` is the Keychain account the route's key belongs
 * under (service KEYCHAIN_SERVICE), such as "own-provider:api.example.com"; null for a model on this Mac and for Ozzie
 * managed, whose device token the app saves itself. Never a key. `managed` and `account`: Ozzie managed on this Mac,
 * whichever route is chosen.
 */
export interface ModelStatus {
  configured: boolean; route: "managed" | "own" | "local" | "none"; label: string;
  setup?: "ready" | "no-route" | "no-key" | "own-key-not-bound" | "not-connected" | "reconnect"; key_account?: string | null;
  managed?: "not-connected" | "connected" | "reconnect"; account?: ManagedAccount | null;
}
/** The Keychain service every model key is saved under (model.rs KEYCHAIN_SERVICE). */
export const KEYCHAIN_SERVICE = "church.ozzie.model.v1";
/**
 * The Terminal command that saves a route's key under its account. `-w` comes last with no value, so `security`
 * asks for the key at a hidden prompt: the key is never on a command line, and Ozzie never sees it.
 */
export const keychainCommand = (account: string) => `security add-generic-password -a "${account.replace(/["\\$`]/gu, "")}" -s ${KEYCHAIN_SERVICE} -w`;
export const model = {
  status: () => invoke<ModelStatus>("model_status"),
  /** Native call; the request has already passed the placeholder boundary. Returns the model's raw reply text. */
  reword: (request: DraftModelRequest) => invoke<string>("reword_draft", { request }),
  /**
   * The earlier fact-sheet route (native ask_ozzie), used only by the debug autopilot for comparison. Ask
   * Ozzie in the app runs through the harness (harness-bridge.ts) and native agent_step.
   */
  ask: (request: AskModelRequest) => invoke<string>("ask_ozzie", { request }),
  /** Saves the non-secret route only; keys are added to the Keychain outside the app. */
  setRoute: (route: "managed" | "own" | "local", baseUrl?: string, model?: string) =>
    invoke<ModelStatus>("set_model_route", { route, baseUrl: baseUrl || null, model: model || null }),
  /**
   * Connects this Mac to Ozzie managed: the sign-in opens in the browser and comes back to Ozzie; the device token is
   * kept in the Keychain natively and never reaches the webview. Resolves with the church's plan and usage.
   */
  connect: () => invoke<ManagedAccount>("managed_connect"),
  /** Stops a connect that is waiting for the browser. */
  cancelConnect: () => invoke<void>("managed_connect_cancel"),
  /** Revokes this Mac's connection (best effort) and deletes it from the Keychain. Resolves with the status after. */
  disconnect: () => invoke<ModelStatus>("managed_disconnect"),
};

/**
 * About how many AI steps one answer takes, to say usage in plain words: a question or a procedure usually looks
 * something up once or twice, then chooses the facts (the harness allows at most six steps); rewording a note is one.
 * ozzie.church counts steps; this estimate only turns them into "about N AI answers".
 */
export const STEPS_PER_ANSWER = 3;
/** Whole answers left this month at STEPS_PER_ANSWER, never below zero. */
export const answersLeft = (a: ManagedAccount): number => Math.max(0, Math.floor((a.allowance_steps - a.used_steps) / STEPS_PER_ANSWER));
/** The day the allowance resets, as "December 1". Read as a calendar date (UTC), so midnight never shows as the day before. */
export function resetDay(a: ManagedAccount): string | null {
  const when = new Date(a.period_ends.length === 10 ? `${a.period_ends}T00:00:00Z` : a.period_ends);
  return Number.isNaN(when.getTime()) ? null : new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", timeZone: "UTC" }).format(when);
}
/** "small-church" as "Small church". */
export const planName = (plan: string): string => {
  if (plan === "none") return "No plan";
  const words = plan.replace(/-/gu, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : "Ozzie managed";
};
const paused = (a: ManagedAccount) => a.warning === "paused" || a.used_steps >= a.allowance_steps;
/** No plan on ozzie.church (a trial ended without a subscription): no allowance and no reset to wait for. */
const noPlan = (a: ManagedAccount) => a.plan === "none" || a.allowance_steps <= 0;
export const NO_PLAN_TEXT = "Your Ozzie managed trial has ended, so AI help through ozzie.church is off. Choose a plan at ozzie.church/account to turn it back on. Lists, Church rules, checks and briefings keep working, and nothing charges itself.";
/** Usage in plain work, never raw counts: "About 60 AI answers left this month. It resets on December 1." */
export function usageLine(a: ManagedAccount): string {
  if (noPlan(a)) return "No plan right now, so AI help through ozzie.church is off.";
  const day = resetDay(a);
  if (paused(a)) return day ? `AI help is paused until ${day}.` : "AI help is paused until the allowance resets.";
  const n = answersLeft(a);
  const left = n === 0 ? "Almost no AI help left this month" : n === 1 ? "About 1 AI answer left this month" : `About ${n} AI answers left this month`;
  return day ? `${left}. It resets on ${day}.` : `${left}.`;
}
/**
 * The notice at three quarters, at nine tenths and at the limit (owner decision 2026-10-26): what pauses, what keeps
 * working, and that nothing charges itself.
 */
export function managedNotice(a: ManagedAccount): string | null {
  if (noPlan(a)) return NO_PLAN_TEXT;
  const day = resetDay(a);
  const until = day ? `it resets on ${day}` : "it resets";
  const keeps = "Lists, Church rules, checks and briefings keep working, and nothing charges itself.";
  const near = (part: string) => `Your church has used about ${part} of this month's AI help. When it runs out, AI drafting and answers pause until ${until}. ${keeps}`;
  switch (a.warning) {
    case "three-quarters": return near("three quarters");
    case "nine-tenths": return near("nine tenths");
    case "paused": return `AI drafting and answers are paused until the allowance resets${day ? ` on ${day}` : ""} or your church changes plan. ${keeps}`;
    default: return null;
  }
}
/** When ozzie.church couldn't be reached: where the numbers came from. */
export function offlineLine(a: ManagedAccount): string {
  const at = new Date(a.checked_at_ms);
  const time = Number.isNaN(at.getTime()) ? "earlier" : new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }).format(at);
  return `Ozzie couldn't reach ozzie.church just now. These numbers are from ${time}.`;
}
/** Why connecting to or disconnecting from Ozzie managed didn't work, in plain words (native hosted.rs ManagedError). */
export function managedProblem(error: unknown): string {
  const code = typeof error === "string" ? error : "";
  switch (code) {
    case "cancelled": return "Connecting was cancelled. Nothing changed on this Mac.";
    case "expired": return "Connecting took longer than five minutes, so Ozzie stopped waiting. Try again when you're ready.";
    case "browser-unavailable": return "Ozzie couldn't open your browser to connect. Try again.";
    case "refused": return "ozzie.church didn't accept that sign-in. Try connecting again.";
    case "keychain": return "Ozzie couldn't save or remove this Mac's connection in the Keychain. Unlock this Mac's Keychain and try again.";
    case "busy": return "Ozzie is already waiting for you to finish connecting in your browser.";
    default: return "Ozzie couldn't reach ozzie.church just now. Try again in a minute.";
  }
}
/** Why Settings couldn't save a route, in plain words. */
export function routeProblem(error: unknown): string {
  const known = JSON.stringify(error) ?? "";
  if (known.includes("name-present")) return "The model name looks like it holds a person's name, so Ozzie didn't save it. Check the model name and try again.";
  if (known.includes("not-configured") || known.includes("invalid")) return "Ozzie couldn't use that address. It needs an https address for the provider (not Planning Center), or a model on this Mac.";
  return "Ozzie couldn't save that choice. Try again.";
}
/** Ozzie managed's allowance is spent (native `allowance-paused`): the same words wherever AI help was asked for. */
export const PAUSED_TEXT = "Your church's AI help is paused until the allowance resets or your church changes plan. Checks, lists, Church rules and briefings keep working.";
export function modelProblem(error: unknown): string {
  const known = JSON.stringify(error) ?? "";
  if (known.includes("allowance-paused")) return `${PAUSED_TEXT} Your draft is unchanged.`;
  if (known.includes("not-configured")) return "Rewording needs an AI model. Set one up under Settings.";
  if (known.includes("name-present")) return "Ozzie stopped this request because it contained a person's name. Nothing was sent; your draft is unchanged.";
  if (known.includes("model-not-allowed")) return "The chosen AI model isn't enabled for this account. Your draft is unchanged.";
  if (known.includes("budget")) return "The AI spending cap for this Mac has been reached. Your draft is unchanged.";
  if (known.includes("rate-limited")) return "The AI service asked Ozzie to slow down. Try again in a minute.";
  if (known.includes("contact-detail")) return "This note looks like it holds a phone number or email address, so Ozzie managed didn't send it to the AI. Your draft is unchanged.";
  return "The AI model couldn't be reached. Your draft is unchanged.";
}
