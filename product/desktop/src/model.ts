import { invoke } from "@tauri-apps/api/core";
import type { DraftModelRequest } from "../../../core/src/draft-request.js";
import type { AskModelRequest } from "../../../core/src/ask.js";

/**
 * Which model route is set up on this Mac (native model.rs ModelStatus). Keys live only in the Keychain and never
 * reach the webview. `setup` says what is missing: "ready"; "no-route" (nothing chosen); "no-key" (nothing saved
 * under `key_account`); "own-key-not-bound" (an own provider's key saved under the old account "own-provider", which
 * is tied to no address and never used). `key_account` is the Keychain account the route's key belongs under
 * (service KEYCHAIN_SERVICE), such as "own-provider:api.example.com"; null for a model on this Mac. Never a key.
 */
export interface ModelStatus {
  configured: boolean; route: "managed" | "own" | "local" | "none"; label: string;
  setup?: "ready" | "no-route" | "no-key" | "own-key-not-bound"; key_account?: string | null;
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
};
/** Why Settings couldn't save a route, in plain words. */
export function routeProblem(error: unknown): string {
  const known = JSON.stringify(error) ?? "";
  if (known.includes("name-present")) return "The model name looks like it holds a person's name, so Ozzie didn't save it. Check the model name and try again.";
  if (known.includes("not-configured") || known.includes("invalid")) return "Ozzie couldn't use that address. It needs an https address for the provider (not Planning Center), or a model on this Mac.";
  return "Ozzie couldn't save that choice. Try again.";
}
export function modelProblem(error: unknown): string {
  const known = JSON.stringify(error) ?? "";
  if (known.includes("not-configured")) return "Rewording needs an AI model. Set one up under Settings.";
  if (known.includes("name-present")) return "Ozzie stopped this request because it contained a person's name. Nothing was sent; your draft is unchanged.";
  if (known.includes("model-not-allowed")) return "The chosen AI model isn't enabled for this account. Your draft is unchanged.";
  if (known.includes("budget")) return "The AI spending cap for this Mac has been reached. Your draft is unchanged.";
  if (known.includes("rate-limited")) return "The AI service asked Ozzie to slow down. Try again in a minute.";
  return "The AI model couldn't be reached. Your draft is unchanged.";
}
