import { invoke } from "@tauri-apps/api/core";
import type { DraftModelRequest } from "../../../core/src/draft-request.js";
import type { AskModelRequest } from "../../../core/src/ask.js";

/** Which model route is set up on this Mac. Keys live only in the Keychain and never reach the webview. */
export interface ModelStatus { configured: boolean; route: "managed" | "own" | "local" | "none"; label: string }
export const model = {
  status: () => invoke<ModelStatus>("model_status"),
  /** Native call; the request has already passed the placeholder boundary. Returns the model's raw reply text. */
  reword: (request: DraftModelRequest) => invoke<string>("reword_draft", { request }),
  /** Native call; the request came from core/src/ask.ts prepareAsk. Returns the raw reply, which acceptAskReply checks before display. */
  ask: (request: AskModelRequest) => invoke<string>("ask_ozzie", { request }),
  /** Saves the non-secret route only; keys are added to the Keychain outside the app. */
  setRoute: (route: "managed" | "own" | "local", baseUrl?: string, model?: string) =>
    invoke<ModelStatus>("set_model_route", { route, baseUrl: baseUrl || null, model: model || null }),
};
export function modelProblem(error: unknown): string {
  const known = JSON.stringify(error) ?? "";
  if (known.includes("not-configured")) return "Rewording needs an AI model. Set one up under Settings.";
  if (known.includes("name-present")) return "Ozzie stopped this request because it contained a person's name. Nothing was sent; your draft is unchanged.";
  if (known.includes("model-not-allowed")) return "The chosen AI model isn't enabled for this account. Your draft is unchanged.";
  if (known.includes("budget")) return "The AI spending cap for this Mac has been reached. Your draft is unchanged.";
  if (known.includes("rate-limited")) return "The AI service asked Ozzie to slow down. Try again in a minute.";
  return "The AI model couldn't be reached. Your draft is unchanged.";
}
/** The same closed reason codes as rewording, worded for a question. Provider text never reaches here. */
export function askProblem(error: unknown): string {
  const known = JSON.stringify(error) ?? "";
  if (known.includes("not-configured")) return "Ask Ozzie needs an AI model. Set one up under Settings.";
  if (known.includes("name-present")) return "Ozzie stopped this question because it contained a name from Planning Center. Nothing was sent.";
  if (known.includes("model-not-allowed")) return "The chosen AI model isn't enabled for this account.";
  if (known.includes("budget")) return "The AI spending cap for this Mac has been reached.";
  if (known.includes("rate-limited")) return "The AI service asked Ozzie to slow down. Try again in a minute.";
  if (known.includes("invalid-request")) return "Ozzie couldn't send this question in a safe form. Try a shorter or simpler one.";
  return "The AI model couldn't be reached. Try again in a minute.";
}
