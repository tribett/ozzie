// How big one model step is, counted exactly as the native agent_step counts it (review 2026-11-14 C7):
// the messages and the tool specs, each serialized as JSON, in characters (code points, as Rust's
// `chars().count()`), added together. Both loops stop with "limit" before sending a step over
// HARNESS_LIMITS.contextChars, so native never has to refuse one.
import type { AgentStepRequest } from "./contract.js";

/** Code points, as Rust counts characters. */
const chars = (text: string) => Array.from(text).length;

/** Characters of `messages` and `tools` serialized, as native's CONTEXT_CHARS check counts them. */
export const contextSize = (request: Pick<AgentStepRequest, "messages" | "tools">): number =>
  chars(JSON.stringify(request.messages)) + chars(JSON.stringify(request.tools));
