// The AI screens (onboarding spec §3 S6–S10, §4.4; native contract N5–N7): every closed verdict code has its own plain
// sentence; nothing is chosen for the person; Ozzie's AI is offered only as the server's offer says; nothing a native
// reply or an AI company wrote, and nothing key-like, is ever shown; buttons are full-size; Escape closes only sheets.
// Fictional data and a fake native side (test/onboarding-fakes.ts) only.
import { readdirSync, readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installFakeDom } from "./fake-dom.js";
import { fakeNative } from "./onboarding-fakes.js";
// Every native call, from the bridge and from model.ts alike, goes to the fake native side of the test that is running.
const native = vi.hoisted(() => ({ invoke: null as null | ((command: string, args?: Record<string, unknown>) => Promise<unknown>) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn((command: string, args?: Record<string, unknown>) => native.invoke ? native.invoke(command, args) : new Promise(() => {})) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
import type { DownloadRefusal, KeyVerdict, LocalVerdict, ModelEnd, ModelPhase, ModelRemoved, PaidEnd } from "../src/onboarding-bridge.js";
import { aiLine, bytesText, CHOICE, COMPANIES, downloadSaid, downloadTime, endedAwaySaid, KEY, keySaid, LIMIT, localSaid, MAC, OLLAMA, ollamaDoneSaid, ollamaEndSaid,
  ollamaRefusedSaid, ollamaRevealSaid, OZZIE, ozzieState, paidSaid, refusedSaid, removedSaid } from "../src/ai-words.js";
import type { OllamaEnd, OllamaPhase, OllamaRefusal } from "../src/onboarding-bridge.js";
import { ActivityPage } from "../src/activity-page.js";
import { modelProblem, monthLimitText, NO_PLAN_TEXT, pausedLine, untilWhen, type ManagedAccount, type ModelStatus } from "../src/model.js";
import { parseKeyResult, parseOllamaHistory, parseOllamaProgress, parseProviders } from "../src/onboarding-bridge.js";
import { AiChoice, AiFlow } from "../src/ai-choice.js";
import { AiLine } from "../src/ai-line.js";
import { MacEndedLine } from "../src/ai-this-mac.js";
import { DayProvider, UNKNOWN_WORDS, type DayWords } from "../src/day-words.js";
import { AiSettings } from "../src/ai-settings.js";

/** Words the product language rules keep off every surface (AGENTS.md, spec §6). */
const FORBIDDEN = /\b(?:skills?|sessions?|agents?|logs?|connectors?|harness|Ozzie managed|trial|Keychain|OpenAI-compatible|placeholders?|zero data retention|Approve|Block)\b/u;

const KEY_VERDICTS: KeyVerdict[] = ["works", "refused", "no-credit", "unreachable", "wrong-kind", "not-a-key", "model-unavailable", "slow-down", "daily-limit",
  "not-saved", "empty", "cancelled", "too-many-checks", "failed", "needs-workspace", "wrong-address", "not-verified-yet", "not-an-ai-key", "admin-key", "region", "restricted-key", "provider-busy",
  "needs-project-setup", "auth-conflict", "confirm-unknown-shape", "needs-billing", "needs-organization", "sign-in-token", "choice-changed", "unavailable"];
const LOCAL_VERDICTS: LocalVerdict[] = ["answers", "no-tools", "lost-start", "small-context", "thinks-too-long", "lookup-instead", "too-slow", "stopped", "not-found",
  "not-on-this-mac", "choice-changed", "unavailable"];
const PAID_ENDS: PaidEnd[] = ["payment-cancelled", "cancelled", "expired", "not-finished", "busy", "browser-unavailable", "refused", "keychain", "unreachable"];

describe("what the key check said (spec S8c)", () => {
  it("says the spec's sentence for each verdict, naming the company", () => {
    expect(keySaid("works", "openai")?.text).toBe("It works. Ozzie will use your OpenAI account. The key is kept safely on this Mac.");
    expect(keySaid("refused", "openai")?.text).toBe("OpenAI didn't accept this key. Part of it may be missing. Copy it again from OpenAI's keys page and paste it here.");
    expect(keySaid("refused", "openai")?.extra).toEqual({ label: "Open OpenAI's keys page", page: "keys" });
    // One wording for every company (review F, no-credit): never "no credit yet"; only OpenAI documents a delay.
    expect(keySaid("no-credit", "anthropic")?.text).toBe("Your Anthropic account has no credit left, or has reached a spending limit. Add credit or raise the limit on their billing page, then press Check this key again.");
    expect(keySaid("no-credit", "gemini")?.text).toBe("Your Google account has no credit left, or has reached a spending limit. Add credit or raise the limit on their billing page, then press Check this key again.");
    expect(keySaid("no-credit", "other")?.text).toBe("Your account with the AI company has no credit left, or has reached a spending limit. Add credit or raise the limit on their billing page, then press Check this key again.");
    for (const p of ["openai", "anthropic", "gemini", "other"] as const) expect(keySaid("no-credit", p)!.text).not.toContain("no credit yet");
    // OpenAI's own words for it cover a spending limit and the minutes a new purchase can take (verify-openai.md).
    expect(keySaid("no-credit", "openai")?.text).toBe("Your OpenAI account has no credit left, or has reached a spending limit. Add credit or raise the limit on their billing page, then press Check this key again. If you just added credit, this can take a few minutes.");
    expect(keySaid("no-credit", "openai")?.extra).toEqual({ label: "Open OpenAI's billing page", page: "billing" });
    expect(keySaid("no-credit", "openai")?.again).toBe(true);
    expect(keySaid("no-credit", "anthropic")?.extra).toEqual({ label: "Open Anthropic's billing page", page: "billing" });
    expect(keySaid("no-credit", "anthropic")?.again).toBe(true);
    expect(keySaid("unreachable", "openai")?.text).toBe("Ozzie couldn't reach OpenAI just now. Check that this Mac is online, then try again. Your key wasn't saved yet.");
    expect(keySaid("wrong-kind", "openai", "anthropic")?.text).toBe("This looks like an Anthropic key, not an OpenAI key.");
    expect(keySaid("wrong-kind", "openai", "anthropic")?.extra).toEqual({ label: "Use it with Anthropic", useOther: "anthropic" });
    expect(keySaid("wrong-kind", "anthropic", "gemini")?.text).toBe("This looks like a Google key, not an Anthropic key.");
    expect(keySaid("not-a-key", "gemini")?.text).toBe("That doesn't look like a whole key. A key is one long line with no spaces. Copy it again.");
    // OpenAI: a project limited to some models (verify-openai.md); the others keep the new-account sentence.
    expect(keySaid("model-unavailable", "openai")?.text).toBe("This key's project can't use the model Ozzie asks for. In OpenAI's settings, allow all models for the project, or make a key in the default project.");
    expect(keySaid("model-unavailable", "openai")?.extra).toEqual({ label: "Open OpenAI's settings", page: "settings" });
    expect(keySaid("model-unavailable", "anthropic")?.text).toBe("This key works, but this Anthropic account can't use the AI model Ozzie needs yet. New accounts sometimes need a day, or a verified organization on Anthropic's page.");
    expect(keySaid("slow-down", "anthropic")?.text).toBe("Anthropic asked Ozzie to wait. Try again in a minute.");
    expect(keySaid("daily-limit", "gemini")?.text).toBe("This key has used today's free limit. Try again tomorrow, or add billing in Google AI Studio.");
    expect(keySaid("not-saved", "openai")?.text).toBe("The key works, but this Mac didn't let Ozzie keep it. Unlock this Mac, then press Check this key again.");
    // The contract's extra verdicts, in plain sentences.
    expect(keySaid("empty", "openai")?.text).toBe("Ozzie didn't get a key. Copy the key from OpenAI's keys page, then press Paste my key again.");
    expect(keySaid("failed", "openai")?.text).toBe("OpenAI didn't take Ozzie's check just now, so your key wasn't saved. This is on Ozzie's side, not your key's. Try again later, or see Check my setup.");
    expect(keySaid("too-many-checks", "openai")?.text).toBe("Ozzie has checked keys 10 times in the last hour, so it's pausing to be safe. Try again in an hour. Your key wasn't saved yet.");
    expect(keySaid("unavailable", "openai")?.text).toBe("Ozzie couldn't check the key just now, so nothing was saved. Try again in a minute.");
    // Closing the native window says nothing.
    expect(keySaid("cancelled", "openai")).toBeNull();
  });

  it("says each refusal the check can end with in its own sentence (review M13)", () => {
    // Worded generically: Anthropic's own text for it isn't documented (contract 13).
    expect(keySaid("needs-workspace", "anthropic")?.text).toBe("Anthropic refused this key for this workspace. Make a new key on Anthropic's keys page and choose a workspace for it.");
    expect(keySaid("needs-workspace", "anthropic")?.extra).toEqual({ label: "Open Anthropic's keys page", page: "keys" });
    expect(keySaid("wrong-address", "other", undefined, "api.example.com")?.text).toBe("api.example.com answered, but not as an AI service Ozzie can use at that address. Check the address in your AI company's instructions, then try again.");
    expect(keySaid("not-verified-yet", "anthropic")?.text).toBe("Anthropic isn't ready in Ozzie yet. Choose another company, or AI on this Mac.");
    expect(keySaid("daily-limit", "openai")?.text).toBe("This key has used today's limit at OpenAI. Try again tomorrow.");
    const said = (["needs-workspace", "wrong-address", "not-verified-yet", "failed", "slow-down", "daily-limit"] as const).map(v => keySaid(v, "anthropic")!.text);
    expect(new Set(said).size).toBe(said.length);
    expect(keySaid("slow-down", "openai")!.text).not.toBe(keySaid("daily-limit", "openai")!.text);
  });

  it("has a sentence for every verdict and company, with no company pages for Another AI company", () => {
    for (const p of ["openai", "anthropic", "gemini", "other"] as const) {
      for (const v of KEY_VERDICTS) {
        const said = keySaid(v, p, p === "openai" ? "gemini" : "openai");
        if (v === "cancelled") { expect(said).toBeNull(); continue; }
        expect(said?.text, `${p} ${v}`).toMatch(/^[A-Z].*\.$/u);
        expect(said!.text).not.toMatch(FORBIDDEN);
        expect(said!.text).not.toMatch(/\{|\}|undefined|null/u);
        if (p === "other" && said!.extra && "page" in said!.extra) throw new Error(`other company has a page: ${v}`);
      }
    }
    expect(keySaid("works", "other")?.text).toBe("It works. Ozzie will use your account with the AI company. The key is kept safely on this Mac.");
    expect(keySaid("refused", "other")?.text).toBe("The AI company didn't accept this key. Part of it may be missing. Copy it again from the company's keys page and paste it here.");
    // Another AI company has no handoff button: the sentence says where to go instead (re-check Low).
    expect(keySaid("wrong-kind", "other", "anthropic")?.text).toBe("This looks like an Anthropic key. Go back, choose Claude (Anthropic), and paste it there.");
    expect(keySaid("wrong-kind", "other", "anthropic")?.extra).toBeNull();
    // An OpenRouter key on a company's card (native re-check Low 3): no handoff, it goes through Another AI company.
    expect(keySaid("wrong-kind", "openai", "openrouter")?.text).toBe("This looks like an OpenRouter key, not an OpenAI key. To use it, go back, choose Another AI company, and give OpenRouter's address.");
    expect(keySaid("wrong-kind", "openai", "openrouter")?.extra).toBeNull();
    // Another service's secret (a GitHub or Slack token, a Stripe key): refused before it went anywhere (native re-check NM2).
    expect(keySaid("not-an-ai-key", "openai")?.text).toBe("This doesn't look like an OpenAI key. Nothing was sent. Copy the key from OpenAI's keys page, then paste it here.");
    expect(keySaid("not-an-ai-key", "openai")?.extra).toEqual({ label: "Open OpenAI's keys page", page: "keys" });
    expect(keySaid("not-an-ai-key", "other")?.text).toBe("This doesn't look like a key for the company you chose. Nothing was sent. Copy the key from the company's website, then paste it here.");
    // A wrong-kind verdict naming no other company (or the same one) is read as not a whole key.
    expect(keySaid("wrong-kind", "openai")?.text).toBe(keySaid("not-a-key", "openai")?.text);
  });
});

describe("what the local check said (spec S9)", () => {
  it("says the spec's sentence for each verdict, with the real day", () => {
    expect(localSaid("answers", "ollama", "llama3.2:latest", "Sunday", 14).lines).toEqual([
      "It answers. A typical answer took 14 seconds on this Mac.", "Ozzie will use llama3.2 on this Mac. Nothing leaves this Mac."]);
    expect(localSaid("no-tools", "ollama", "x", "Wednesday").lines).toEqual(["It answered, but it can't use Ozzie's lookups, so it can't answer questions about Wednesday. Choose another model."]);
    expect(localSaid("lost-start", "ollama", "x", "this weekend's services").lines)
      .toEqual(["It answered, but it lost the start of the question, so it can't hold everything about this weekend's services on this Mac. Choose a larger model, or a key from an AI company."]);
    // Native waits two minutes for the first question and one for the second (local_ai.rs ANSWER_WAIT, START_WAIT);
    // `seconds` comes only when the first was answered.
    // Review L-5: no smaller model is offered under Medium, so the way on is what is true for every model.
    expect(localSaid("too-slow", "ollama", "x", "Sunday").lines).toEqual(["It didn't answer within two minutes. This Mac may be too busy, or the model too large for it. Try again when this Mac is less busy, or use a key from an AI company."]);
    expect(localSaid("too-slow", "ollama", "x", "Sunday", 40).lines).toEqual(["It answered the first question, but didn't answer the second within a minute. This Mac may be too busy, or the model too large for it. Try again when this Mac is less busy, or use a key from an AI company."]);
    expect(localSaid("stopped", "lm-studio", "x", "Sunday").lines).toEqual(["LM Studio stopped answering. Open LM Studio, then try again."]);
    expect(localSaid("not-found", "ollama", "x", "Sunday").lines).toEqual(["Ollama doesn't list that model any more. Press Look again, then choose a model."]);
    // A model the app lists that runs elsewhere: nothing was asked of it (2026-11-19).
    expect(localSaid("not-on-this-mac", "ollama", "gpt-oss:120b-cloud", "Sunday").lines)
      .toEqual(["gpt-oss:120b-cloud runs on Ollama's servers, not on this Mac, so Ozzie doesn't use it here. Choose a model on this Mac."]);
    expect(localSaid("not-on-this-mac", "lm-studio", "far/model", "Sunday").lines)
      .toEqual(["far/model runs on another computer, not on this Mac, so Ozzie doesn't use it here. Choose a model on this Mac."]);
    for (const v of LOCAL_VERDICTS) {
      const said = localSaid(v, "ollama", "llama3.2", "Sunday", 3);
      expect(said.tone).toBe(v === "answers" ? "ok" : "problem");
      for (const line of said.lines) expect(line).not.toMatch(FORBIDDEN);
    }
  });

  it("never promises \"on this Mac\" for LM Studio, whose LM Link can answer from another computer, and keeps Ollama's promise (2026-11-19)", () => {
    // LM Studio's docs (developer/core/lmlink, lmlink/basics/faq, developer/rest/list): a model on another linked computer
    // answers this Mac's localhost "as if it were loaded locally", and no field LM Studio's server lists says where it is.
    expect(MAC.lmLink).toBe("LM Studio can be set up to run its models on another of your computers (its LM Link feature). Ozzie can't see that setting, so if you use LM Link, your questions may go to that computer.");
    expect(localSaid("answers", "lm-studio", "qwen/qwen3-8b", "Sunday", 14).lines).toEqual([
      "It answers. A typical answer took 14 seconds.", "Ozzie will use qwen/qwen3-8b through LM Studio.", MAC.lmLink]);
    expect(localSaid("answers", "lm-studio", "qwen/qwen3-8b", "Sunday").lines[0]).toBe("It answers.");
    expect(localSaid("answers", "ollama", "qwen3:8b", "Sunday", 14).lines).toEqual([
      "It answers. A typical answer took 14 seconds on this Mac.", "Ozzie will use qwen3:8b on this Mac. Nothing leaves this Mac."]);
    // LM Link's words only for LM Studio's success; Ollama's promise never for LM Studio.
    for (const v of LOCAL_VERDICTS) for (const app of ["ollama", "lm-studio"] as const) {
      const lines = localSaid(v, app, "m", "Sunday", 3, true).lines.join(" ");
      expect(lines.includes(MAC.lmLink), `${v} ${app}`).toBe(app === "lm-studio" && v === "answers");
      if (app === "lm-studio") expect(lines, v).not.toMatch(/Nothing leaves this Mac|will use \S+ on this Mac|seconds on this Mac/u);
    }
    // Settings: Ollama's promise for Ollama only; an app native didn't name is promised nothing.
    expect(LIMIT.localChecked("November 17 at 9:14 AM", "ollama")).toBe("Answered Ozzie's check on November 17 at 9:14 AM. Nothing leaves this Mac.");
    expect(LIMIT.localChecked("November 17 at 9:14 AM", "lm-studio")).toBe("Answered Ozzie's check on November 17 at 9:14 AM.");
    expect(LIMIT.localChecked("November 17 at 9:14 AM", null)).toBe("Answered Ozzie's check on November 17 at 9:14 AM.");
    expect(MAC.lmLink).not.toMatch(FORBIDDEN);
    expect(MAC.lmLink).not.toMatch(/[—–]/u);
  });

  it("says what to change in the app when it gave the model too little room, and names thinking that ran out (live, 2026-11-18)", () => {
    // Ollama's own setting, as its app names it (Settings, Context length, 8k on its slider); a key stays the other way.
    expect(localSaid("small-context", "ollama", "qwen3:8b", "Sunday").lines).toEqual([
      "It lost the start of the question. Ollama keeps only the end of a question longer than its context length. In Ollama's Settings, set Context length to 8k or more, then press Check that it answers again. Or choose a key from an AI company."]);
    // LM Studio's per-model load settings (its My Models tab, the gear by the model); the setting applies when it loads.
    expect(localSaid("small-context", "lm-studio", "qwen/qwen3-8b", "Sunday").lines).toEqual([
      "It didn't get the whole question. LM Studio gives a model only as much of a question as its context length allows. In LM Studio's My Models, press the gear next to this model, set its context length to 8192 or more, load the model again, then press Check that it answers again. Or choose a key from an AI company."]);
    expect(localSaid("thinks-too-long", "ollama", "x", "Wednesday").lines).toEqual([
      "It spent its whole answer thinking and never finished, so it would be too slow for questions about Wednesday on this Mac. Choose another model, or a key from an AI company."]);
    // Asked for one word, it used a lookup instead (review M2): nothing is known about its room, so nothing is said of it.
    // Choosing another model leads (review L-5): asking the same model again often gives the same answer.
    expect(localSaid("lookup-instead", "ollama", "qwen3:8b", "Sunday").lines).toEqual([
      "It used one of Ozzie's lookups when asked for a single word, so Ozzie couldn't tell whether it can hold everything about Sunday on this Mac. Choose another model, or press Check that it answers again."]);
    expect(localSaid("lookup-instead", "lm-studio", "x", "Sunday").lines[0]).not.toMatch(/context length|room|lost the start/iu);
    // A model that lost the start though the app gave it room keeps the larger-model advice.
    expect(localSaid("lost-start", "ollama", "x", "Sunday").lines[0]).toContain("Choose a larger model, or a key from an AI company.");
    for (const app of ["ollama", "lm-studio"] as const) {
      expect(localSaid("small-context", app, "x", "Sunday").lines[0]).toContain("Check that it answers");
      expect(localSaid("small-context", app, "x", "Sunday").lines[0]).toMatch(/Or choose a key from an AI company\.$/u);
    }
  });

  it("keeps how long the first question took when the second one timed out, and only then", async () => {
    const { parseLocalCheck } = await import("../src/onboarding-bridge.js");
    expect(parseLocalCheck({ verdict: "too-slow", seconds: 41 })).toEqual({ verdict: "too-slow", seconds: 41 });
    expect(parseLocalCheck({ verdict: "too-slow", seconds: null })).toEqual({ verdict: "too-slow" });
    expect(parseLocalCheck({ verdict: "small-context", seconds: 41 })).toEqual({ verdict: "small-context" });
    expect(parseLocalCheck({ verdict: "thinks-too-long", seconds: 41 })).toEqual({ verdict: "thinks-too-long" });
    expect(parseLocalCheck({ verdict: "lookup-instead", seconds: 41 })).toEqual({ verdict: "lookup-instead" });
    expect(parseLocalCheck({ verdict: "too-long-for-it" })).toEqual({ verdict: "unavailable" });
  });

  it("says how long the check can take and an answer on this Mac can take, as measured (2026-11-18)", () => {
    // ANSWER_WAIT (120 s) and START_WAIT (60 s): three minutes at most.
    expect(MAC.checking("qwen3:8b")).toBe("Asking qwen3:8b a test question. This can take up to three minutes…");
    // An Ask on a 16 GB Mac with qwen3:8b took 22 seconds for a small church's facts and 52 for a larger church's.
    expect(MAC.honest).toBe("AI on this Mac is private and free. It is slower than an AI company's, an answer can take a minute, and its answers are simpler. Ozzie works the same either way.");
    expect(MAC.ollamaRoom).toBe("Before you check, open Ollama's Settings and set Context length to 8k or more, so it can read a whole question.");
  });

  it("says what this Mac's memory means, and that Ozzie downloads the model itself once Ollama answers (owner, 2026-11-18)", () => {
    // An 8 GB Mac: only the small model fits there, and it never finished an answer that needed a lookup (2026-11-18).
    expect(MAC.memory("too-small", 8)).toBe("This Mac has 8 GB of memory. AI on this Mac needs a Mac with 16 GB of memory or more.");
    expect(MAC.tooSmallWays).toBe("You can use a key from an AI company instead, or no AI for now: everything else in Ozzie works without it.");
    expect(MAC.memory("medium", 16)).toBe("This Mac has 16 GB of memory: a medium model will work well.");
    // The large model fits from 32 GB but couldn't be tested: said so, and the medium one stays the recommendation.
    expect(MAC.memory("large", 64)).toBe("This Mac has 64 GB of memory: a medium model will work well. The large one fits too, but it hasn't been tested with Ozzie yet.");
    // Native couldn't tell: nothing about memory.
    expect(MAC.memory("unknown", 0)).toBeNull();
    expect(MAC.getModel(2_019_393_189)).toBe("Then press Look again. Ozzie offers the model that suits this Mac (about 2.0 GB), downloads it from Ollama's library and sets it up for you.");
    // Model sizes come only from native: no size is written into the words.
    expect(MAC.getModel(null)).not.toMatch(/GB/u);
    expect(MAC.guide[1].text).toBe("Open the downloaded file, move Ollama into Applications, then open it. If your Mac asks whether to open it, choose Open. A small llama picture appears at the top of your screen.");
    expect(MAC.pickHint).toBe("Choose a model above, then press Check that it answers.");
    expect(JSON.stringify(MAC)).not.toMatch(/for me|Terminal|ollama pull/u);
  });
});

describe("Ozzie's AI in words (spec S10)", () => {
  const account = (over: Partial<ManagedAccount> = {}): ManagedAccount => ({
    plan: "personal", allowance_steps: 1200, used_steps: 300, period_ends: "2026-12-17T00:00:00.000Z", warning: null, checked_at_ms: 0, offline: false, ...over });

  it("says how each paid attempt ended, and never that a second try charges again", () => {
    expect(paidSaid("payment-cancelled")).toBe("No payment was taken, and nothing changed.");
    // Cancelled here or "Don't connect" on the site may come after paying (the site asks before connecting): never "no payment".
    // The plan may not be on the account yet, so it's never said to be (review M10).
    expect(paidSaid("cancelled")).toBe("This Mac isn't connected to Ozzie's AI. If you finished paying, wait until your account page shows Personal, then press Try again and choose Connect this Mac. You won't be charged again.");
    expect(paidSaid("expired")).toBe("Ozzie stopped waiting. If you finished paying, wait until your account page shows Personal, then press Try again and choose Connect this Mac. You won't be charged again.");
    // A paid connect's hour ran out: never "couldn't reach its website" (review M2).
    expect(paidSaid("not-finished")).toBe("Ozzie stopped waiting after an hour. If you finished paying, wait until your account page shows Personal, then press Try again and choose Connect this Mac. You won't be charged again.");
    for (const end of PAID_ENDS) {
      expect(paidSaid(end)).not.toMatch(FORBIDDEN);
      expect(paidSaid(end)).not.toMatch(/Personal is on your account/u);
    }
    expect(OZZIE.on("About 400 answers a month", "December 17")).toBe("Ozzie's AI is on. About 400 answers this month; it starts again on December 17.");
    expect(OZZIE.on(null, "December 17")).toBe("Ozzie's AI is on.");
  });

  it("says each later state: on, near the end, paused, a failed payment, ended, no plan", () => {
    // 900 units left at 3.75 a answer (the website's UNITS_PER_ANSWER): 240, never a fraction.
    expect(ozzieState(account(), null)).toEqual({ kind: "on", text: "About 240 answers left this month. They start again on December 17." });
    expect(ozzieState(account({ warning: "three-quarters", used_steps: 900 }), null).text)
      .toBe("Ozzie's AI has used about three quarters of this month's answers. When they run out, AI pauses until December 17. Everything else keeps working, and nothing extra is charged.");
    expect(ozzieState(account({ warning: "nine-tenths", used_steps: 1080 }), null).text).toContain("about nine tenths of this month's answers");
    expect(ozzieState(account({ warning: "paused", used_steps: 1200 }), null).text)
      .toBe("Ozzie's AI is paused until December 17: this month's answers are used. Everything else in Ozzie still works.");
    const none = account({ plan: "none", allowance_steps: 0, used_steps: 0 });
    expect(ozzieState(none, "payment-failed").text).toBe("Ozzie's AI is off because the last payment didn't go through. Everything else still works.");
    expect(ozzieState(none, "cancelled").text).toBe("Ozzie's AI ended on December 17. Everything else in Ozzie keeps working.");
    expect(ozzieState(none, "none").text).toBe(NO_PLAN_TEXT);
    expect(NO_PLAN_TEXT).toBe("Ozzie's AI is off: there's no plan on your account. Everything else in Ozzie keeps working, and nothing charges itself.");
    expect(OZZIE.stopBody("December 17")).toBe("Cancelling stops the next payment. Ozzie's AI keeps working until December 17. What's been paid isn't refunded, except where the law requires.");
  });

  it("says until when Ozzie's AI is paused when the account says (paused_until), on this Mac's clock, never in a minute", () => {
    const now = Date.UTC(2026, 10, 17, 18, 0);
    expect(untilWhen("2026-11-18T00:00:00Z", now, "America/Chicago")).toBe("today, 6:00 PM");
    expect(untilWhen("2026-11-18T18:30:00Z", now, "America/Chicago")).toBe("tomorrow, 12:30 PM");
    expect(untilWhen("2026-12-17T00:00:00Z", now, "America/Chicago")).toBe("December 16, 6:00 PM");
    expect(untilWhen("not a time", now)).toBeNull();
    const daily = account({ paused_until: "2026-11-18T18:30:00Z" });
    expect(ozzieState(daily, null, now, "America/Chicago")).toEqual({ kind: "paused", text: "Ozzie's AI is paused until tomorrow, 12:30 PM. Everything else in Ozzie still works." });
    // A pause that has ended is no pause.
    expect(ozzieState(daily, null, Date.UTC(2026, 10, 19), "America/Chicago").kind).toBe("on");
    const future = new Date(Date.now() + 3_600_000).toISOString();
    // The account's daily ceiling is its own code now (native re-check NM1): rate-limited is only "busy", whatever the account says.
    expect(modelProblem("rate-limited", { ...daily, paused_until: future })).toBe("The AI service asked Ozzie to slow down. Try again in a minute.");
    expect(modelProblem("allowance-paused", { ...daily, paused_until: future })).toContain(pausedLine(untilWhen(future)!));
    expect(modelProblem("rate-limited")).toBe("The AI service asked Ozzie to slow down. Try again in a minute.");
    expect(aiLine({ configured: true, route: "managed", label: "x", setup: "ready", managed: "connected", account: { ...daily, paused_until: future } }).trouble).toBe("paused");
  });

  it("says nothing extra is charged, and refunds as the terms say (review M3)", () => {
    expect(OZZIE.checks).toEqual([
      "When the month's answers run out, AI pauses until the next month. Everything else in Ozzie keeps working, and nothing extra is charged.",
      "Cancel any time. Payments aren't refunded, except where the law requires. When you cancel, Ozzie's AI keeps working until the end of the month you've paid for.",
      "Every request goes only to AI services that keep nothing, and never with the names Ozzie reads from Planning Center.",
      "For one person, on up to 3 of their Macs. Plans for teams are coming."]);
    // Folded under its own question, so the wait stays three short steps (first-run review, S10b).
    expect(OZZIE.waitHelpTitle).toBe("Paid, but the page is gone?");
    expect(readFileSync(new URL("../src/ai-ozzie.tsx", import.meta.url), "utf8")).toContain('<details className="fr-fold"><summary><Icon name="chev" small />{OZZIE.waitHelpTitle}</summary><p>{OZZIE.waitHelp}</p></details>');
    expect(OZZIE.waitHelp).toBe("Paid, but closed the page before choosing Connect this Mac, or Ozzie's website said it couldn't confirm the payment? Wait until your account page shows Personal (usually a few minutes), then press Open the page again and choose Connect this Mac. You won't be charged again.");
  });
});

describe("the monthly limit and the AI line (spec S8, §4.4)", () => {
  const own = (over: Partial<ModelStatus> = {}): ModelStatus => ({ configured: true, route: "own", label: "ChatGPT, with your key (gpt-5-mini)", setup: "ready",
    key_account: "own-provider:api.openai.com", provider: "openai", month: { used: 12, limit: 1000, resets_on: "2026-12-01" }, ...over });

  it("says the month-limit sentence wherever AI was asked for", () => {
    expect(monthLimitText("December 1")).toBe("AI has paused on this Mac until December 1, as your monthly limit says. Everything else in Ozzie still works.");
    expect(modelProblem("month-limit")).toMatch(/^AI has paused on this Mac until [A-Z][a-z]+ 1, as your monthly limit says\. Everything else in Ozzie still works\. Your draft is unchanged\.$/u);
  });

  it("names the AI in use from closed codes only, and says when it's paused or not answering", () => {
    expect(aiLine(null)).toEqual({ text: "AI: none", trouble: null });
    expect(aiLine({ configured: false, route: "none", label: "No AI model set up" })).toEqual({ text: "AI: none", trouble: null });
    expect(aiLine(own())).toEqual({ text: "AI: ChatGPT, your key", trouble: null });
    expect(aiLine(own({ provider: "anthropic" })).text).toBe("AI: Claude, your key");
    expect(aiLine(own({ provider: "gemini" })).text).toBe("AI: Gemini, your key");
    expect(aiLine(own({ provider: null, label: "Your AI provider at api.example.com (vendor/model)" })).text).toBe("AI: another AI company, your key");
    expect(aiLine(own({ setup: "month-limit", configured: true })).trouble).toBe("paused");
    expect(aiLine(own({ setup: "no-key", configured: false })).trouble).toBe("not answering");
    expect(aiLine({ configured: true, route: "managed", label: "x", setup: "ready", managed: "connected", account: null })).toEqual({ text: "AI: Ozzie's AI", trouble: null });
    expect(aiLine({ configured: false, route: "managed", label: "x", setup: "reconnect", managed: "reconnect" }).trouble).toBe("not answering");
    const local = { configured: true, route: "local" as const, label: "AI model on this Mac (llama3.2:latest)", setup: "ready" as const, checked_at_ms: 1 };
    expect(aiLine(local)).toEqual({ text: "AI: on this Mac (llama3.2)", trouble: null });
    // Never "In use" before the check passes.
    expect(aiLine({ ...local, configured: false, setup: "not-checked", checked_at_ms: null }).trouble).toBe("not checked yet");
    // Native's label is never shown as such: an odd one leaves only the closed words.
    expect(aiLine({ ...local, label: "AI model on this Mac (sk-ant-api03-SECRET and more)" }).text).toBe("AI: on this Mac");
    // Review L-4: a model Ozzie no longer offers, set up before it was withdrawn, keeps working and the line says so,
    // in the words of its row on AI on this Mac; its "Check" opens that screen (ai-settings `fix`).
    const small = { ...local, label: "AI model on this Mac (qwen3:4b)", not_offered: true };
    expect(aiLine(small)).toEqual({ text: "AI: on this Mac (qwen3:4b)", trouble: "not offered any more" });
    expect(MAC.notOffered.toLowerCase()).toBe("not offered any more");
    // Not answering says that first; a model still offered says nothing.
    expect(aiLine({ ...small, configured: false, setup: "no-key" }).trouble).toBe("not answering");
    expect(aiLine({ ...local, not_offered: false }).trouble).toBeNull();
  });

  it("never calls a model that runs elsewhere AI on this Mac: the line, Settings, rewording and the setup check say it isn't used (2026-11-19)", async () => {
    const away = { configured: false, route: "local" as const, label: "AI model on this Mac (gpt-oss:120b-cloud)", setup: "not-on-this-mac" as const, checked_at_ms: 1,
      local_app: "ollama" as const };
    expect(aiLine(away)).toEqual({ text: "AI: gpt-oss:120b-cloud, not on this Mac", trouble: "not used" });
    expect(LIMIT.localElsewhere("gpt-oss:120b-cloud", "ollama"))
      .toBe("gpt-oss:120b-cloud runs on Ollama's servers, not on this Mac, so Ozzie doesn't use it here. Choose a model on this Mac, or another way to use AI.");
    expect(LIMIT.localElsewhere("far/model", "lm-studio"))
      .toBe("far/model runs on another computer, not on this Mac, so Ozzie doesn't use it here. Choose a model on this Mac, or another way to use AI.");
    expect(LIMIT.localElsewhere(null, null)).toBe("The model chosen doesn't run on this Mac, so Ozzie doesn't use it here. Choose a model on this Mac, or another way to use AI.");
    expect(modelProblem("not-on-this-mac")).toBe("The AI model chosen for AI on this Mac doesn't run on this Mac, so Ozzie didn't send it anything. Your draft is unchanged.");
    for (const said of [aiLine(away).text, LIMIT.localElsewhere("gpt-oss:120b-cloud", "ollama"), modelProblem("not-on-this-mac")]) expect(said).not.toMatch(FORBIDDEN);
    const fake = fakeNative({ model_status: away, local_ai_find: FOUND });
    native.invoke = fake.invoke as never;
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(dom.root as unknown as Element);
    await act(async () => { root.render(React.createElement(AiSettings, { onChange() {} })); });
    await settle();
    unmount = async () => { await act(async () => { root.unmount(); }); };
    expect(seen()).toContain("AI: gpt-oss:120b-cloud, not on this Mac · not used");
    expect(seen()).toContain(LIMIT.localElsewhere("gpt-oss:120b-cloud", "ollama"));
    expect(seen()).not.toContain(LIMIT.localNotChecked);
    expect(seen()).not.toMatch(/Answered Ozzie's check/u);
    expect(fake.calls.map(c => c.command).filter(c => /^(?:set_|save_|remove_|local_model_remove|managed_)/u.test(c))).toEqual([]);
    await press("Choose a model on this Mac");
    expect(seen()).toContain(MAC.title);
  });

  it("Settings › AI help says plainly when AI on this Mac is a model Ozzie no longer offers, without switching it off (review L-4)", async () => {
    const STATUS = { configured: true, route: "local", label: "AI model on this Mac (qwen3:4b)", setup: "ready", checked_at_ms: 1_763_400_000_000, not_offered: true };
    const fake = fakeNative({ model_status: STATUS });
    native.invoke = fake.invoke as never;
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(dom.root as unknown as Element);
    await act(async () => { root.render(React.createElement(AiSettings, { onChange() {} })); });
    await settle();
    unmount = async () => { await act(async () => { root.unmount(); }); };
    expect(seen()).toContain("AI: on this Mac (qwen3:4b) · not offered any more");
    expect(seen()).toContain(MAC.notOfferedInUse("qwen3:4b"));
    expect(MAC.notOfferedInUse("qwen3:4b")).toBe("Ozzie no longer sets up qwen3:4b: in Ozzie's tests it never finished an answer that needed one of Ozzie's lookups. Ozzie keeps using it until you choose another model or another way to use AI.");
    // Nothing is switched off or changed by showing it.
    expect(fake.calls.map(c => c.command).filter(c => /^(?:set_|save_|remove_|local_model_remove|managed_)/u.test(c))).toEqual([]);
    await press("Check");
    expect(seen()).toContain(MAC.title);
  });
});

describe("the AI screens' stylesheet", () => {
  const css = readFileSync(new URL("../src/ai-screens.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//gu, "");
  it("sizes text only with the type tokens (titles 28px), and gives cards, rows and quiet links a 44px target", () => {
    const sizes = [...css.matchAll(/font(?:-size)?:\s*([^;}]+)/gu)].map(m => m[1]!);
    for (const s of sizes) expect(s, s).toMatch(/var\(--t-(?:xs|sm|md|lg)\)|28px|inherit/u);
    for (const sel of [".ai-card", ".ai-row", ".ai-link"]) {
      const rule = new RegExp(`\\.oz \\${sel}\\s*\\{[^}]*min-height:\\s*var\\(--h-btn\\)`, "u");
      expect(css, sel).toMatch(rule);
    }
    expect(css).toMatch(/max-width:\s*640px/u);
    expect(css).toMatch(/@media \(max-width: 759px\)/u);
    expect(css).toMatch(/prefers-contrast: more/u);
    expect(css).toMatch(/prefers-reduced-motion: reduce/u);
    expect(css).toMatch(/:focus-visible/u);
  });

  it("gives cards and model rows a button's edge: 1.5px of --control, at least 3:1 against the page (review M7)", () => {
    for (const sel of [".ai-card", ".ai-row"]) expect(css, sel).toMatch(new RegExp(`\\.oz \\${sel}\\s*\\{[^}]*border:\\s*1\\.5px solid var\\(--control\\)`, "u"));
    // Hearth's own tokens, light and dark: the edge against the page and against the card's fill.
    const hearth = readFileSync(new URL("../src/hearth.css", import.meta.url), "utf8");
    const token = (block: string, name: string) => new RegExp(`--${name}:(#[0-9A-Fa-f]{6})`, "u").exec(block)?.[1];
    const lum = (hex: string) => { const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!; };
    const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };
    const light = hearth.slice(0, hearth.indexOf(".oz.dark")), dark = hearth.slice(hearth.indexOf(".oz.dark"));
    for (const block of [light, dark]) for (const against of ["paper", "surface"]) {
      expect(ratio(token(block, "control")!, token(block, against)!)).toBeGreaterThanOrEqual(3);
    }
  });
});

// ---- The screens, mounted on the fake document ----------------------------------------------------------------------

const dom = installFakeDom();
type Node = { tagName?: string; textContent: string; childNodes: Node[]; getAttribute?: (n: string) => string | null } & Record<string, unknown>;
const all = (n: Node): Node[] => [n, ...n.childNodes.flatMap(all)];
const nodes = () => all(dom.root as unknown as Node);
const buttons = () => nodes().filter(n => n.tagName === "BUTTON");
const button = (start: string) => buttons().find(b => b.textContent.startsWith(start)) ?? null;
const reactProps = (n: Node) => n[Object.keys(n).find(k => k.startsWith("__reactProps$"))!] as Record<string, ((e: unknown) => void) | undefined> | undefined;
const isDisabled = (n: Node) => n.disabled === true || n.getAttribute?.("disabled") != null;
const seen = () => dom.seen();
async function settle() {
  const { act } = await import("react");
  await act(async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); });
}
async function press(start: string) {
  const b = button(start);
  if (!b) throw new Error(`No button starting "${start}" in: ${seen()}`);
  const { act } = await import("react");
  await act(async () => { dom.press(b as never); });
  await settle();
}
async function type(id: string, value: string) {
  const field = nodes().find(n => n.tagName === "INPUT" && n.getAttribute?.("id") === id)!;
  const { act } = await import("react");
  await act(async () => { reactProps(field)!.onChange!({ target: { value }, currentTarget: { value } }); });
}
let unmount: (() => Promise<void>) | null = null;
afterEach(async () => { await unmount?.(); unmount = null; native.invoke = null; vi.useRealTimers(); });

/** The fictional replies a working native side gives; each test overrides what it is about. */
const OFFER_OPEN = { open: true, plan: "personal", price_text: "$19 a month", answers_text: "About 400 answers a month" };
const LEAK = "sk-proj-LEAKLEAKLEAK1234";
const PROVIDERS = [
  { id: "openai", name: "ChatGPT", company: "OpenAI", tag: "easiest", model: "gpt-5-mini", min_topup: "$5", typical_month: "under $1",
    retention_line: "OpenAI may keep what it gets for up to 30 days.", free_plan: false, checked_on: "2026-11-17", note: LEAK, verified_live: true },
  { id: "anthropic", name: "Claude", company: "Anthropic", tag: null, model: "claude-haiku", min_topup: null, typical_month: null, retention_line: null, free_plan: false,
    checked_on: "2026-11-17", verified_live: true, key_note: "When you create the key, choose a workspace for it, and choose Never for when it expires unless your church's policy says otherwise." },
  { id: "gemini", name: "Gemini", company: "Google", tag: null, model: "gemini-flash", min_topup: "$5", typical_month: null, retention_line: null, free_plan: true, checked_on: "2026-11-17",
    verified_live: true, free_plan_not_for_church_data: true,
    free_plan_line: "On the free plan, Google may use what the app sends to improve its products, and people at Google may read it." },
];
/** The same companies as native gives them today: none has passed this release's live test (decision 19). */
const UNCHECKED = PROVIDERS.map(p => ({ ...p, verified_live: false }));
const FOUND = { memory_gb: 16, advice: "medium", recommended: "llama3.2", recommended_size_bytes: 2_019_393_189, apps: [
  { app: "ollama", installed: true, running: true, models: [
    { id: "llama3.2:latest", size_bytes: 2_019_393_189, fits: true, recommended: true },
    { id: "llama3.1:70b", size_bytes: 42_000_000_000, fits: false, recommended: false }] },
  { app: "lm-studio", installed: false, running: false, models: [] }] };
const base = (over: Record<string, unknown> = {}) => ({ managed_offer: OFFER_OPEN, own_key_providers: PROVIDERS, own_key_forget: null, local_ai_find: FOUND, ...over });

/** `day`: the watched service's words (none given: the Sunday words every page has outside the app). */
async function mount(replies: Record<string, unknown>, mode: "first-run" | "settings" = "first-run", day?: DayWords) {
  const fake = fakeNative(replies);
  native.invoke = fake.invoke as never;
  const onDone = vi.fn(), onModel = vi.fn(), onCheckSetup = vi.fn();
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.root as unknown as Element);
  const choice = React.createElement(AiChoice, { mode, onModel, onDone, onCheckSetup, bridge: fake.bridge });
  await act(async () => { root.render(day ? React.createElement(DayProvider, { value: day }, choice) : choice); });
  await settle();
  unmount = async () => { await act(async () => { root.unmount(); }); };
  return { ...fake, onDone, onModel, onCheckSetup };
}
/** Buttons are 44px: a full button (never the small one), a card, a model row, or a quiet link with a 44px target. */
const allFullSize = () => {
  for (const b of buttons()) {
    const cls = b.getAttribute?.("class") ?? "";
    expect(cls, b.textContent).toMatch(/\bbtn\b|\bai-card\b|\bai-row\b|\bai-link\b/u);
    expect(cls, b.textContent).not.toMatch(/btn-sm/u);
  }
};

describe("S6: how should Ozzie use AI?", () => {
  it("offers three cards with nothing chosen, Ozzie's AI at the server's own price, and Not now", async () => {
    const s = await mount(base());
    const text = seen();
    expect(text).toContain("One more choice (optional)");
    expect(text).toContain("How should Ozzie use AI?");
    expect(text).toContain("Everything you just saw works without AI. AI can also reword a note, answer your questions about Sunday, and look at who could help with a role.");
    const cards = buttons().filter(b => /ai-card/u.test(b.getAttribute?.("class") ?? ""));
    expect(cards.map(c => c.textContent)).toEqual([
      "Ozzie's AIReady to use, nothing to set up. $19 a month for about 400 answers. Cancel any time.",
      "Your church's own AIOzzie charges nothing. Pay an AI company a few dollars yourself, or use free AI on this Mac.",
      "No AI for nowFree. Everything you just saw keeps working."]);
    for (const c of cards) {
      expect(c.getAttribute?.("aria-pressed") ?? null).toBeNull();
      expect(c.getAttribute?.("aria-checked") ?? null).toBeNull();
      expect(isDisabled(c)).toBe(false);
    }
    expect(text).toContain(CHOICE.small);
    // Exactly true: a name a person types into a question isn't caught, so the claim is about the names Ozzie reads (NM4).
    expect(text).toContain("Whichever you choose, the AI never sees the names Ozzie reads from Planning Center.");
    allFullSize();
    // First run's quiet way out isn't an answer: "Decide later", never a second "No AI for now" (review M1).
    expect(button("Not now")).toBeNull();
    await press("Decide later");
    expect(s.onDone).toHaveBeenCalledWith("later");
    expect(s.calls.some(c => c.command === "set_no_ai")).toBe(false);
  });

  it("marks the way in use now on its card, here and on the next screen, in first run and Settings alike (live, 2026-11-19)", async () => {
    const cards = () => buttons().filter(b => /ai-card/u.test(b.getAttribute?.("class") ?? ""));
    const tagged = () => cards().filter(c => all(c).some(n => n.getAttribute?.("class") === "ai-tag" && n.textContent === "In use now")).map(c => c.textContent.split("In use now")[0]);
    const status = (route: string, configured: boolean, setup = "ready") => ({ configured, route, label: "x", setup });
    const cases: [Record<string, unknown>, string[], string[]][] = [
      [status("managed", true), ["Ozzie's AI"], []],
      [status("own", true), ["Your church's own AI"], ["A key from an AI company"]],
      [status("local", true), ["Your church's own AI"], ["AI on this Mac"]],
      // Nothing chosen yet, or a way that doesn't work now: nothing marked.
      [status("none", false, "no-route"), [], []],
      [status("local", false, "not-checked"), [], []],
      [status("local", false, "not-on-this-mac"), [], []],
      [status("own", false, "no-key"), [], []],
    ];
    for (const mode of ["first-run", "settings"] as const) for (const [model_status, first, second] of cases) {
      await mount(base({ model_status }), mode);
      expect(tagged(), `${mode} ${JSON.stringify(model_status)}`).toEqual(first);
      await press("Your church's own AI");
      expect(tagged(), `${mode} ${JSON.stringify(model_status)}`).toEqual(second);
      await unmount!(); unmount = null;
    }
    expect(CHOICE.inUse).toBe("In use now");
    expect(CHOICE.inUse).not.toMatch(FORBIDDEN);
  });

  it("puts focus on the title when S6 opens, never on a card, and no card asks for focus (review M2b)", async () => {
    const doc = globalThis.document as unknown as { createElement: (t: string) => Node; activeElement: unknown };
    const make = doc.createElement.bind(doc);
    doc.createElement = (t: string) => { const el = make(t); el.focus = function (this: Node) { doc.activeElement = this; }; return el; };
    try {
      await mount(base());
      const focused = doc.activeElement as Node;
      expect(focused.tagName).toBe("H2");
      expect(focused.textContent).toBe("How should Ozzie use AI?");
      for (const b of buttons()) expect(b.getAttribute?.("autofocus") ?? null).toBeNull();
    } finally { doc.createElement = make; }
    const html = renderToStaticMarkup(React.createElement(AiChoice, { mode: "first-run", onModel() {}, onDone() {}, bridge: fakeNative(base()).bridge }));
    expect(html).not.toMatch(/autofocus/iu);
  });

  it("keeps Ozzie's AI closed when the offer is closed, can't be reached, or isn't known yet, and still lets Tab reach its reason", async () => {
    // Closed or unreadable: "Not open for sign-up yet". Unreachable: "Can't check just now" (review L9). Never a way to buy.
    const shut = "Ozzie's AINot open for sign-up yet. The free ways work today.", away = "Ozzie's AICan't check just now. The free ways work today.";
    for (const [offer, said] of [[{ open: false }, shut], [{ open: false, reason: "closed" }, shut], [{ open: true, plan: "personal", price_text: "<b>free</b>", answers_text: "lots" }, shut],
      [{ open: false, reason: "unreachable" }, away], [() => { throw "unreachable"; }, away]] as const) {
      const s = await mount(base({ managed_offer: offer }));
      const card = button("Ozzie's AI")!;
      // aria-disabled, not disabled: the card stays in the Tab order so its reason is heard (review L11).
      expect(card.getAttribute?.("aria-disabled")).toBe("true");
      expect(card.getAttribute?.("disabled") ?? null).toBeNull();
      expect(card.textContent).toBe(said);
      await press("Ozzie's AI");
      expect(seen()).toContain("How should Ozzie use AI?");
      expect(seen()).not.toContain("Pay $");
      expect(s.calls.map(c => c.command)).toContain("managed_offer");
      await unmount!(); unmount = null;
    }
    // Before the offer arrives: neither a price nor a choice.
    const html = renderToStaticMarkup(React.createElement(AiChoice, { mode: "first-run", onModel() {}, onDone() {}, bridge: fakeNative({ managed_offer: new Promise(() => {}) }).bridge }));
    expect(html).toMatch(/<button type="button" class="ai-card" aria-disabled="true">.*Checking whether it&#x27;s open for sign-up…/u);
    expect(html).not.toMatch(/class="ai-card" disabled/u);
  });

  it("makes No AI for now a real answer: native sets no route first, then it is reported; and drops the eyebrow in Settings", async () => {
    let s = await mount(base({ set_no_ai: { configured: false, route: "none", label: "No AI model set up", setup: "no-route" } }));
    await press("No AI for now");
    expect(s.calls.filter(c => c.command === "set_no_ai")).toEqual([{ command: "set_no_ai", args: {} }]);
    expect(s.onModel).toHaveBeenCalledWith(false);
    expect(s.onDone).toHaveBeenCalledWith("none");
    await unmount!(); unmount = null;
    // If native couldn't do it, nothing is reported and the person is told.
    s = await mount(base({ set_no_ai: () => { throw "unavailable"; } }));
    await press("No AI for now");
    expect(s.onDone).not.toHaveBeenCalled();
    expect(seen()).toContain(CHOICE.noneFailed);
    await unmount!(); unmount = null;
    await mount(base(), "settings");
    expect(seen()).not.toContain("One more choice (optional)");
    expect(seen()).toContain("Everything else in Ozzie works without AI.");
    expect(button("No AI for now")!.textContent).toBe("No AI for nowFree. Everything else in Ozzie keeps working.");
    expect(button("Back")).not.toBeNull();
  });

  it("shows exactly what is sent in a sheet that Escape closes, and Escape does nothing anywhere else", async () => {
    await mount(base());
    // No screen listens for Escape: only a sheet does.
    expect(nodes().filter(n => reactProps(n)?.onKeyDown)).toEqual([]);
    await press("See exactly what is sent");
    const sheet = nodes().find(n => n.getAttribute?.("role") === "dialog")!;
    expect(sheet.getAttribute?.("aria-modal")).toBe("true");
    const text = sheet.textContent;
    expect(text).toContain("What the AI sees");
    expect(text).toContain("The instructions Ozzie gives:");
    expect(text).toContain("Make it warmer.");
    expect(text).toContain("Hi [Volunteer A],");
    expect(text).toContain("[Your name]");
    expect(text).toContain("Names, email addresses, phone numbers and background checks are taken out on this Mac before anything is sent, and checked again before it leaves.");
    const { act } = await import("react");
    await act(async () => { reactProps(sheet)!.onKeyDown!({ key: "Enter", stopPropagation() {} }); });
    expect(nodes().some(n => n.getAttribute?.("role") === "dialog")).toBe(true);
    await act(async () => { reactProps(sheet)!.onKeyDown!({ key: "Escape", stopPropagation() {} }); });
    expect(nodes().some(n => n.getAttribute?.("role") === "dialog")).toBe(false);
    expect(seen()).toContain("How should Ozzie use AI?");
  });
});

describe("S7–S8: a key from an AI company", () => {
  const toCompany = async () => { await press("Your church's own AI"); await press("A key from an AI company"); };

  it("walks to the companies with Back on every screen, nothing chosen, and the company's three steps", async () => {
    const s = await mount(base({ open_help_page: null }));
    await press("Your church's own AI");
    expect(seen()).toContain("Your church's own AI");
    expect(button("A key from an AI company")!.textContent).toBe("A key from an AI companyYou pay the company directly, usually a few dollars a month or less. Answers are quick and good.");
    expect(button("Back")).not.toBeNull();
    await press("A key from an AI company");
    expect(seen()).toContain("Which AI company?");
    const cards = buttons().filter(b => /ai-card/u.test(b.getAttribute?.("class") ?? ""));
    expect(cards.map(c => c.textContent)).toEqual([
      "ChatGPT (OpenAI)Easiest to startPay as you go. The smallest amount you can add is $5.",
      // No amount where native has none; never "top-up"; Google's free plan is never suggested (contract N5).
      "Claude (Anthropic)Pay as you go.",
      "Gemini (Google)Pay as you go, with billing turned on. The smallest amount you can add is $5.",
      "Another AI companyFor a company with an OpenAI-style address. You'll need its address and model name."]);
    expect(seen()).toContain("You'll add a few dollars of credit with the company for Ozzie to use.");
    expect(seen()).not.toMatch(/top-up|free plan|Free to start/u);
    for (const c of cards) expect(c.getAttribute?.("aria-pressed") ?? null).toBeNull();
    expect(seen()).toContain("More choices");
    allFullSize();
    await press("ChatGPT (OpenAI)");
    const text = seen();
    expect(text).toContain("Use ChatGPT's company, OpenAI");
    // What a key is, said again where it is made (review M13).
    expect(text).toContain("A key is a long password for apps. Ozzie keeps it on this Mac and sends it only to OpenAI.");
    // Checked against OpenAI's docs on 2026-11-17 (verify-openai.md): a ChatGPT sign-in usually works (not a work
    // account with single sign-on); the smallest purchase is $5; auto-reload is on by default.
    expect(text).toContain("Sign in at OpenAI's developer site. Your ChatGPT sign-in usually works there.");
    expect(text).toContain("Add a payment card, then buy credit. The smallest purchase is $5. OpenAI turns on automatic top-ups by default: switch off “auto-reload” unless your church wants it.");
    expect(text).not.toContain("The smallest amount you can add");
    expect(text).toContain("Make a key: choose Create new secret key, then Copy. OpenAI shows the key only once, so copy it before you close that window.");
    expect(text).toContain("You pay OpenAI directly. For a typical church that's under $1 a month.");
    expect(text).toContain("What Ozzie sends OpenAI: your question or the note to reword, and the facts it needs about Sunday (roles, times, team names), with stand-ins like [Volunteer A] instead of names. Never the names Ozzie read from Planning Center, and never email addresses, phone numbers or background checks. OpenAI may keep what it gets for up to 30 days.");
    expect(text).toContain("Ozzie will ask for the key: click in the box, then press Command and V together.");
    expect(text).not.toMatch(/monthly limit on the same page/u);
    // "top-up" only in the warning about OpenAI's own automatic top-ups (on by default), never as advice to top up.
    expect(text.match(/top-up/gu)).toHaveLength(1);
    expect(text).toContain("OpenAI turns on automatic top-ups by default: switch off “auto-reload” unless your church wants it.");
    expect(text).not.toContain(LEAK);
    // "What Ozzie sends" at 16px in --ink-2 (.ai-body), not the 15px grey small print.
    const sends = nodes().find(n => n.tagName === "P" && n.textContent.startsWith("What Ozzie sends OpenAI"))!;
    expect(sends.getAttribute?.("class")).toBe("ai-body");
    // A drawing for each step with its button circled, said to be a drawing.
    const drawings = nodes().filter(n => n.tagName === "svg" && /ai-draw/u.test(n.getAttribute?.("class") ?? ""));
    expect(drawings.map(d => d.getAttribute?.("aria-label"))).toEqual([
      "A drawing of OpenAI's sign-in page, not the real page. The button to sign in is circled.",
      "A drawing of OpenAI's billing page, not the real page. The button to buy credits is circled.",
      "A drawing of OpenAI's keys page, not the real page. The Create new secret key button is circled."]);
    for (const d of drawings) {
      expect(d.getAttribute?.("role")).toBe("img");
      expect(all(d).some(n => n.tagName === "ellipse")).toBe(true);
    }
    for (const [label, page] of [["Open OpenAI's sign-in page", "openai-sign-in"], ["Open OpenAI's billing page", "openai-billing"], ["Open OpenAI's keys page", "openai-keys"]]) {
      await press(label!);
      expect(s.calls.at(-1)).toEqual({ command: "open_help_page", args: { page } });
    }
    allFullSize();
    await press("I'll do this later");
    expect(s.onDone).toHaveBeenCalledWith("later");
  });

  it("renders the sentence for every verdict, and never the key or what the company said", async () => {
    for (const verdict of KEY_VERDICTS.filter(v => v !== "unavailable")) {
      const s = await mount(base({ own_key_enter: { verdict, provider: "openai", looks_like: "anthropic", key: LEAK,
        message: `Incorrect API key provided: ${LEAK}`, status: { configured: true, route: "own", label: `OpenAI ${LEAK}`, key_account: "own-provider:api.openai.com" } } }));
      await toCompany();
      await press("ChatGPT (OpenAI)");
      await press("Paste my key");
      const said = keySaid(verdict, "openai", "anthropic");
      if (said) expect(seen(), verdict).toContain(said.text);
      else expect(seen()).not.toMatch(/role="alert"/u);
      expect(seen()).not.toMatch(/sk-proj|Incorrect API key|own-provider|api\.openai\.com/u);
      // The page asked for a check and passed only the company: no key in any argument.
      const checks = s.calls.filter(c => ["own_key_enter", "own_key_paste", "own_key_check_again"].includes(c.command));
      expect(checks.length).toBeGreaterThan(0);
      for (const c of checks) expect(c.args).toEqual({ provider: "openai" });
      if (verdict === "works") {
        expect(s.onModel).toHaveBeenCalledWith(true);
        await press("Next: open Services");
        expect(s.onDone).toHaveBeenCalledWith("chosen");
      }
      if (said && !said.extra && !said.again && verdict !== "works") expect(button("Check this key again")).toBeNull();
      if (said?.again) expect(button("Check this key again")).not.toBeNull();
      allFullSize();
      await unmount!(); unmount = null;
      // The key native held is dropped when the screen closes.
      expect(s.calls.at(-1)?.command).toBe("own_key_forget");
    }
  });

  it("uses the clipboard when the native window isn't built, says so when neither is, and checks again with the other company", async () => {
    let s = await mount(base({ own_key_paste: { verdict: "no-credit" } }));
    await toCompany(); await press("ChatGPT (OpenAI)"); await press("Paste my key");
    expect(s.calls.map(c => c.command)).toEqual(expect.arrayContaining(["own_key_enter", "own_key_paste"]));
    expect(seen()).toContain(keySaid("no-credit", "openai")!.text);
    await unmount!(); unmount = null;

    s = await mount(base());
    await toCompany(); await press("ChatGPT (OpenAI)"); await press("Paste my key");
    expect(seen()).toContain("Ozzie couldn't check the key just now, so nothing was saved. Try again in a minute.");
    expect(seen()).toContain("Check my setup");
    await press("Check my setup");
    expect(s.onCheckSetup).toHaveBeenCalled();
    await unmount!(); unmount = null;

    s = await mount(base({ own_key_enter: { verdict: "wrong-kind", looks_like: "anthropic" }, own_key_check_again: ({ provider }: Record<string, unknown>) => ({ verdict: provider === "anthropic" ? "works" : "refused" }) }));
    await toCompany(); await press("ChatGPT (OpenAI)"); await press("Paste my key");
    await press("Use it with Anthropic");
    expect(s.calls.find(c => c.command === "own_key_check_again")?.args).toEqual({ provider: "anthropic" });
    expect(seen()).toContain("Use Claude's company, Anthropic");
    expect(seen()).toContain("It works. Ozzie will use your Anthropic account. The key is kept safely on this Mac.");
  });

  it("shows no company until this release's live test passed for it, and says so when none has (decision 19)", async () => {
    let s = await mount(base({ own_key_providers: UNCHECKED, local_ai_find: FOUND }));
    await toCompany();
    expect(seen()).toContain("Ozzie is still checking these companies. AI on this Mac works today.");
    expect(button("ChatGPT")).toBeNull();
    expect(button("Claude")).toBeNull();
    expect(button("Gemini")).toBeNull();
    expect(seen()).not.toContain(COMPANIES.subscription);
    // Another AI company stays under More choices.
    expect(seen()).toContain("More choices");
    expect(button("Another AI company")).not.toBeNull();
    await press("Use AI on this Mac");
    expect(seen()).toContain("Found Ollama on this Mac");
    await unmount!(); unmount = null;
    // Only the companies that passed: here Claude.
    s = await mount(base({ own_key_providers: PROVIDERS.map(p => ({ ...p, verified_live: p.id === "anthropic" })) }));
    await toCompany();
    expect(buttons().filter(b => /ai-card/u.test(b.getAttribute?.("class") ?? "")).map(b => b.textContent))
      .toEqual(["Claude (Anthropic)Pay as you go.", "Another AI companyFor a company with an OpenAI-style address. You'll need its address and model name."]);
    expect(seen()).not.toContain("Ozzie is still checking");
    expect(s.calls.some(c => c.command === "own_key_providers")).toBe(true);
    // Only a literal true from native counts.
    expect(parseProviders([{ ...PROVIDERS[0], verified_live: "true" }])[0]?.verified).toBe(false);
  });

  it("adds Anthropic's own note to its key step, and puts billing first for Google with Google's terms, never its free plan", async () => {
    await mount(base({ open_help_page: null }));
    await toCompany(); await press("Claude (Anthropic)");
    // The expiry note is native's own (providers.json key_note), shown as sent, never written again here.
    expect(seen()).toContain("Make a key: choose Create key, then copy the key it shows. When you create the key, choose a workspace for it, and choose Never for when it expires unless your church's policy says otherwise. Anthropic shows the key only once, so copy it before you close that window.");
    expect(seen()).toContain("Add a little credit.");
    expect(seen()).not.toContain("The smallest amount you can add");
    expect(seen()).not.toMatch(/preview/iu);
    await press("Back");
    await press("Gemini (Google)");
    const text = seen();
    expect(text).toContain("A key is a long password for apps. Ozzie keeps it on this Mac and sends it only to Google.");
    expect(text).toContain("Turn on billing before you make the key. The smallest amount you can add is $5. On Google's API keys page, your project should show a paid tier, not “Set up billing”.");
    expect(text).toContain("Make a key: open API keys in the left menu, then choose Create API key, then copy the key.");
    // Ozzie can't tell a free-plan key from a paid one (decision 22): one honest line, for Google only, and no number of days.
    expect(text).toContain("Ozzie can't tell whether this key is on Google's free plan. On the free plan, Google may use what is sent to improve its products.");
    expect(text).not.toMatch(/\d+ days/u);
    expect(text).toContain("Google's terms say, in short: On the free plan, Google may use what the app sends to improve its products, and people at Google may read it.");
    expect(text).toContain("You pay Google directly.");
    expect(text).not.toMatch(/No card needed|Free to start|choose another company/u);
    // Without native's data, Google still gets billing first.
    expect(KEY.steps("gemini", null)[1]!.text).toBe("Turn on billing before you make the key. On Google's API keys page, your project should show a paid tier, not “Set up billing”.");
  });

  it("draws each company's buttons with the words on its page today (checked 2026-11-17)", () => {
    const drawn = (c: "openai" | "anthropic" | "gemini") => KEY.steps(c, null).map(st => st.drawn);
    expect(drawn("openai")).toEqual(["Sign in", "Buy credits", "Create new secret key"]);
    expect(drawn("anthropic")).toEqual(["Sign in", "Buy credits", "Create key"]);
    expect(drawn("gemini")).toEqual(["Sign in", "Set up billing", "Create API key"]);
    expect(KEY.steps("anthropic", null)[2]!.alt).toBe("A drawing of Anthropic's keys page, not the real page. The Create key button is circled.");
    expect(KEY.steps("openai", null)[1]!.alt).toBe("A drawing of OpenAI's billing page, not the real page. The button to buy credits is circled.");
  });

  it("says what is true when the key comes from what was copied (no native window in this build)", async () => {
    await mount(base({ own_key_paste: { verdict: "empty" } }));
    await toCompany(); await press("ChatGPT (OpenAI)");
    expect(seen()).toContain(KEY.askWindow);
    await press("Paste my key");
    expect(seen()).toContain("Copy the key first. When you press Paste my key, Ozzie takes what you copied.");
    expect(seen()).not.toContain(KEY.askWindow);
  });

  it("asks Another AI company for its https address and model, never Planning Center's", async () => {
    const s = await mount(base({ own_key_enter: { verdict: "works" } }));
    await toCompany(); await press("Another AI company");
    expect(seen()).toContain("Use another AI company");
    await press("Paste my key");
    expect(seen()).toContain("Ozzie needs the company's https address");
    await type("ai-other-address", "https://api.planningcenteronline.com/v1"); await type("ai-other-model", "vendor/model-1");
    await press("Paste my key");
    expect(s.calls.some(c => c.command === "own_key_enter")).toBe(false);
    await type("ai-other-address", "https://api.example.com/v1");
    await press("Paste my key");
    expect(s.calls.find(c => c.command === "own_key_enter")?.args).toEqual({ provider: "other", baseUrl: "https://api.example.com/v1", model: "vendor/model-1" });
    expect(seen()).toContain("It works. Ozzie will use your account with the AI company.");
  });
});

describe("S9: AI on this Mac", () => {
  const toMac = async () => { await press("Your church's own AI"); await press("AI on this Mac"); };

  it("lists the models with the one for this Mac marked and chosen to begin with, and checks before using one", async () => {
    const s = await mount(base({ local_ai_check: { verdict: "answers", seconds: 14, status: { configured: true, route: "local", label: "x" } } }));
    await toMac();
    const text = seen();
    expect(text).toContain("Found Ollama on this Mac, with 2 AI models ready.");
    expect(text).toContain("This Mac has 16 GB of memory: a medium model will work well.");
    expect(text).toContain("AI on this Mac is private and free.");
    const rows = buttons().filter(b => /ai-row/u.test(b.getAttribute?.("class") ?? ""));
    expect(rows.map(r => r.textContent)).toEqual(["llama3.2 · 2.0 GBRecommended for this Mac", "llama3.1:70b · 42.0 GBToo big for this Mac's memory"]);
    // The row native marks for this Mac is chosen to begin with (review M6); choosing isn't using: the check still has to pass.
    expect(rows.map(r => r.getAttribute?.("aria-pressed"))).toEqual(["true", "false"]);
    expect(isDisabled(rows[1]!)).toBe(true);
    expect(isDisabled(button("Check that it answers")!)).toBe(false);
    expect(text).toContain("Choose a model above, then press Check that it answers.");
    // Ollama gives a model 4k by default under 24 GB of graphics memory, too little for the check's question.
    expect(text).toContain(MAC.ollamaRoom);
    expect(text).not.toMatch(/In use|for me/u);
    expect(s.calls.some(c => c.command === "local_ai_check")).toBe(false);
    expect(s.onModel).not.toHaveBeenCalled();
    await press("Check that it answers");
    expect(s.calls.find(c => c.command === "local_ai_check")?.args).toEqual({ app: "ollama", model: "llama3.2:latest" });
    expect(seen()).toContain("It answers. A typical answer took 14 seconds on this Mac.");
    expect(seen()).toContain("Ozzie will use llama3.2 on this Mac. Nothing leaves this Mac.");
    expect(seen()).not.toContain(MAC.ollamaRoom);
    expect(s.onModel).toHaveBeenCalledWith(true);
    allFullSize();
  });

  it("keeps a passing check's success and adds one line on giving the model room when Ollama gave it little (B-2)", async () => {
    const s = await mount(base({ local_ai_check: { verdict: "answers", seconds: 30, small_room: true, status: { configured: true, route: "local", label: "x" } } }));
    await toMac();
    await press("Check that it answers");
    const text = seen();
    const advice = localSaid("answers", "ollama", "llama3.2:latest", "Sunday", 30, true).advice!;
    expect(text).toContain("It answers. A typical answer took 30 seconds on this Mac.");
    expect(text).toContain(advice);
    // Under the success, not in place of it; the route is in use.
    expect(text.indexOf(advice)).toBeGreaterThan(text.indexOf("Nothing leaves this Mac."));
    expect(s.onModel).toHaveBeenCalledWith(true);
    await unmount!(); unmount = null;
    // Room enough, or unknown: nothing more.
    await mount(base({ local_ai_check: { verdict: "answers", seconds: 30, status: { configured: true, route: "local", label: "x" } } }));
    await toMac();
    await press("Check that it answers");
    expect(seen()).not.toContain(advice);
  });

  it("says what Ollama's context length must be only when Ollama's models are shown", async () => {
    const app = (name: string, over: Record<string, unknown>) => ({ app: name, installed: false, running: false, models: [], ...over });
    await mount(base({ local_ai_find: { ...FOUND, apps: [app("ollama", {}), app("lm-studio", { installed: true, running: true, models: [{ id: "qwen/qwen3-8b", size_bytes: null }] })] } }));
    await toMac();
    expect(seen()).toContain("Found LM Studio on this Mac");
    expect(seen()).not.toContain(MAC.ollamaRoom);
  });

  it("says once, under LM Studio's models and then in its success, that LM Link can answer from another computer; never for Ollama (2026-11-19)", async () => {
    const app = (name: string, over: Record<string, unknown>) => ({ app: name, installed: false, running: false, models: [], ...over });
    const LM = { ...FOUND, apps: [app("ollama", {}), app("lm-studio", { installed: true, running: true, models: [{ id: "qwen/qwen3-8b", size_bytes: null, recommended: true }] })] };
    const once = () => seen().includes(MAC.lmLink) && seen().indexOf(MAC.lmLink) === seen().lastIndexOf(MAC.lmLink);
    const s = await mount(base({ local_ai_find: LM, local_ai_check: { verdict: "answers", seconds: 14, status: { configured: true, route: "local", label: "x", local_app: "lm-studio" } } }));
    await toMac();
    expect(seen()).toContain("Found LM Studio on this Mac, with 1 AI model ready.");
    expect(seen().indexOf(MAC.lmLink)).toBeGreaterThan(seen().indexOf("qwen/qwen3-8b"));
    expect(once()).toBe(true);
    await press("Check that it answers");
    expect(s.calls.find(c => c.command === "local_ai_check")?.args).toEqual({ app: "lm-studio", model: "qwen/qwen3-8b" });
    expect(seen()).toContain("It answers. A typical answer took 14 seconds.");
    expect(seen()).toContain("Ozzie will use qwen/qwen3-8b through LM Studio.");
    expect(once()).toBe(true);
    expect(seen()).not.toMatch(/Nothing leaves this Mac|seconds on this Mac/u);
    await unmount!(); unmount = null;
    // Ollama's models: its promise as before, and no word of LM Link before or after the check.
    await mount(base({ local_ai_check: { verdict: "answers", seconds: 14, status: { configured: true, route: "local", label: "x", local_app: "ollama" } } }));
    await toMac();
    expect(seen()).not.toMatch(/LM Link/u);
    await press("Check that it answers");
    expect(seen()).toContain("Ozzie will use llama3.2 on this Mac. Nothing leaves this Mac.");
    expect(seen()).not.toMatch(/LM Link/u);
  });

  it("says nothing about memory when native couldn't tell it", async () => {
    await mount(base({ local_ai_find: { ...FOUND, memory_gb: null, advice: "unknown" } }));
    await toMac();
    expect(seen()).toContain("Found Ollama on this Mac");
    expect(seen()).not.toMatch(/This Mac has|GB of memory/u);
  });

  it("chooses nothing to begin with when native marks no row, or the marked one is too big", async () => {
    const models = [{ id: "llama3.2:latest", size_bytes: 2_019_393_189, fits: true, recommended: false }, { id: "big:70b", size_bytes: 42e9, fits: false, recommended: true }];
    await mount(base({ local_ai_find: { ...FOUND, apps: [{ ...FOUND.apps[0], models }, FOUND.apps[1]] } }));
    await toMac();
    const rows = buttons().filter(b => /ai-row/u.test(b.getAttribute?.("class") ?? ""));
    expect(rows.map(r => r.getAttribute?.("aria-pressed"))).toEqual(["false", "false"]);
    expect(isDisabled(button("Check that it answers")!)).toBe(true);
    expect(seen()).toContain(MAC.pickHint);
  });

  it("uses each app's own start hint from native for an app that is on this Mac but not answering", async () => {
    const lmHint = "LM Studio's server doesn't start by itself. In LM Studio, open the Developer tab and turn on Start server, then press Look again.";
    // providers.json's own: "Open Ollama" waits for Ollama and carries on by itself (2026-11-19), so nothing says to open
    // it from Applications by hand; Look again stays.
    const olHint = "Press Open Ollama, and Ozzie carries on once Ollama answers.";
    const local = (JSON.parse(readFileSync(new URL("../../../core/native-auth/src/providers.json", import.meta.url), "utf8")) as { local: Record<string, string> }).local;
    expect(local.ollama_start).toBe(olHint);
    expect(local.lm_studio_start).toBe(lmHint);
    const app = (name: string, over: Record<string, unknown>) => ({ app: name, installed: false, running: false, models: [], ...over });
    await mount(base({ local_ai_find: { ...FOUND, apps: [app("ollama", {}), app("lm-studio", { installed: true, start_hint: lmHint })] } }));
    await toMac();
    expect(seen()).toContain(`LM Studio is on this Mac. ${lmHint}`);
    expect(seen()).not.toContain(MAC.lmServerOff);
    expect(button("Look again")).not.toBeNull();
    await unmount!(); unmount = null;
    await mount(base({ local_ai_find: { ...FOUND, apps: [app("ollama", { installed: true, start_hint: olHint }), app("lm-studio", {})] } }));
    await toMac();
    expect(seen()).toContain(`Ollama is on this Mac but isn't open. ${olHint}`);
    expect(seen()).not.toMatch(/Applications folder|starts by itself/u);
    expect(button("Open Ollama")).not.toBeNull();
    expect(button("Look again")).not.toBeNull();
  });

  it("a look that still finds nothing says so, politely and with when, so Look again visibly did something (0.3.0 live)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const app = (name: string) => ({ app: name, installed: false, running: false, models: [] });
    const s = await mount(base({ local_ai_find: { ...FOUND, apps: [app("ollama"), app("lm-studio")] }, open_help_page: null }));
    await toMac();
    expect(seen()).toContain("Ozzie didn't find AI on this Mac.");
    // The first look says nothing more.
    expect(seen()).not.toContain(MAC.stillNothing);
    // The person installs Ollama themselves (decision 25 keeps the guide behind "I'll install it myself").
    await press("I'll install it myself");
    const finds = () => s.calls.filter(c => c.command === "local_ai_find").length;
    const before = finds();
    await press("Look again");
    expect(finds()).toBe(before + 1);
    expect(seen()).toContain("Looked just now. Ozzie still doesn't find AI on this Mac.");
    // Said in the polite status line, so a screen reader hears it once.
    const status = nodes().find(n => n.getAttribute?.("role") === "status");
    expect(status?.textContent).toBe("Looked just now. Ozzie still doesn't find AI on this Mac.");
    expect(status?.getAttribute?.("aria-live")).toBe("polite");
    // "I've opened Ollama" is a look too.
    await press("I've opened Ollama");
    expect(finds()).toBe(before + 2);
    expect(seen()).toContain(MAC.stillNothing);
    // A minute on, "just now" becomes the time Ozzie looked.
    const { act } = await import("react");
    await act(async () => { await vi.advanceTimersByTimeAsync(61_000); });
    expect(seen()).toMatch(/Looked at \d{1,2}:\d{2} [AP]M\. Ozzie still doesn't find AI on this Mac\./u);
    vi.useRealTimers();
  });

  it("renders the sentence for every check verdict", async () => {
    for (const verdict of LOCAL_VERDICTS.filter(v => v !== "answers" && v !== "unavailable")) {
      const s = await mount(base({ local_ai_check: { verdict, seconds: 3, error: "model 'x' not found, try pulling it first" } }));
      await toMac(); await press("llama3.2"); await press("Check that it answers");
      // Native's `seconds` is kept for too-slow only (the first question was answered, the second wasn't).
      expect(seen(), verdict).toContain(localSaid(verdict, "ollama", "llama3.2:latest", "Sunday", verdict === "too-slow" ? 3 : undefined).lines[0]);
      expect(seen()).not.toMatch(/pulling|not found,/u);
      expect(s.onModel).not.toHaveBeenCalled();
      await unmount!(); unmount = null;
    }
  });

  it("says the first sentence that fits what Ozzie found, and that Ozzie gets the model once Ollama answers", async () => {
    const app = (name: string, over: Record<string, unknown>) => ({ app: name, installed: false, running: false, models: [], ...over });
    const cases: [unknown[], string][] = [
      [[app("ollama", { installed: true }), app("lm-studio", {})], "Ollama is on this Mac but isn't open."],
      [[app("ollama", {}), app("lm-studio", { installed: true })], MAC.lmServerOff],
      [[app("ollama", { installed: true, running: true }), app("lm-studio", {})], "Ollama is open but has no AI models yet."],
      [[app("ollama", {}), app("lm-studio", { installed: true, running: true, models: [{ id: "qwen2.5-7b-instruct", size_bytes: null }] })], "Found LM Studio on this Mac, with 1 AI model ready."],
      [[app("ollama", {}), app("lm-studio", {})], "Ozzie didn't find AI on this Mac."],
    ];
    for (const [apps, sentence] of cases) {
      const s = await mount(base({ local_ai_find: { ...FOUND, apps }, local_ai_open: null, open_help_page: null }));
      await toMac();
      expect(seen()).toContain(sentence);
      expect(seen()).not.toMatch(/for me|Terminal/u);
      if (sentence.startsWith("Ozzie didn't find")) {
        // Ozzie offers to get Ollama first (decision 25); nothing is downloaded before the press, and the person's own
        // way opens Ollama's download page and keeps today's guide.
        expect(seen()).toContain(OLLAMA.offerTitle);
        expect(s.calls.some(c => c.command === "ollama_install")).toBe(false);
        expect(seen()).not.toContain("Download Ollama, a free app that runs AI on your Mac.");
        await press("I'll install it myself");
        expect(s.calls.at(-1)).toEqual({ command: "open_help_page", args: { page: "ollama-download" } });
        expect(seen()).not.toContain(OLLAMA.offerTitle);
        expect(seen()).toContain("Download Ollama, a free app that runs AI on your Mac.");
        expect(seen()).toContain("If your Mac asks whether to open it, choose Open.");
        expect(seen()).toContain("Ozzie offers the model that suits this Mac (about 2.0 GB), downloads it from Ollama's library and sets it up for you.");
        // Step 3 says "press Look again": that button is there (review L5).
        expect(seen()).toContain("Then press Look again.");
        expect(button("Look again")).not.toBeNull();
        await press("Open ollama.com");
        expect(s.calls.at(-1)).toEqual({ command: "open_help_page", args: { page: "ollama-download" } });
      }
      if (sentence.startsWith("Ollama is on")) {
        await press("Open Ollama");
        expect(s.calls.at(-1)).toEqual({ command: "local_ai_open", args: { app: "ollama" } });
      }
      allFullSize();
      await unmount!(); unmount = null;
    }
  });
});

describe("S9: a model that runs elsewhere is never listed (2026-11-19)", () => {
  const toMac = async () => { await press("Your church's own AI"); await press("AI on this Mac"); };
  it("lists only models on this Mac and says once why the others aren't there, in Ollama's and LM Studio's words", async () => {
    expect(MAC.elsewhere("ollama", 1)).toBe("One model in Ollama runs on Ollama's servers, not on this Mac, so Ozzie doesn't list it.");
    expect(MAC.elsewhere("ollama", 3)).toBe("3 models in Ollama run on Ollama's servers, not on this Mac, so Ozzie doesn't list them.");
    expect(MAC.elsewhere("lm-studio", 1)).toBe("One model in LM Studio runs on another computer, not on this Mac, so Ozzie doesn't list it.");
    const withAway = (n: number) => ({ ...FOUND, apps: [{ ...FOUND.apps[0], elsewhere: n }, FOUND.apps[1]] });
    await mount(base({ local_ai_find: withAway(2) }));
    await toMac();
    expect(seen()).toContain("Found Ollama on this Mac, with 2 AI models ready.");
    expect(seen()).toContain(MAC.elsewhere("ollama", 2));
    await unmount!(); unmount = null;
    // None of the ones on this Mac: never "no AI models yet" over models it does list.
    const onlyAway = { ...FOUND, apps: [{ app: "ollama", installed: true, running: true, models: [], elsewhere: 1 }, FOUND.apps[1]] };
    await mount(base({ local_ai_find: onlyAway }));
    await toMac();
    expect(seen()).toContain(MAC.ollamaNoModelsHere);
    expect(seen()).not.toContain(MAC.ollamaNoModels);
    expect(seen()).toContain(MAC.elsewhere("ollama", 1));
    await unmount!(); unmount = null;
    // Nothing elsewhere: nothing said.
    await mount(base());
    await toMac();
    expect(seen()).not.toMatch(/not on this Mac, so Ozzie doesn't list/u);
  });

  it("reads native's count only as a small whole number", async () => {
    const { parseLocal } = await import("../src/onboarding-bridge.js");
    const found = (elsewhere: unknown) => parseLocal({ ...FOUND, apps: [{ ...FOUND.apps[0], elsewhere }, FOUND.apps[1]] }).apps[0]!.elsewhere;
    expect([found(2), found(undefined), found(-1), found("3"), found(2.5), found(1e9)]).toEqual([2, 0, 0, 0, 0, 0]);
  });
});

describe("S9: models Ozzie downloads and sets up itself (owner's request, 2026-11-18)", () => {
  const toMac = async () => { await press("Your church's own AI"); await press("AI on this Mac"); };
  /**
   * Native's three rows on a 16 GB Mac: the medium one suits it; the large one is more than half its memory; the small
   * one isn't offered (it never finished a lookup question in Ozzie's tests, 2026-11-18), so it isn't shown.
   */
  const row = (size: string, id: string, size_bytes: number, over: Record<string, unknown> = {}) =>
    ({ size, id, size_bytes, fits: true, offered: true, recommended: false, downloaded: false, set_up: false, disk: "enough", downloaded_by_ozzie: false, ...over });
  const CATALOGUE = [row("small", "qwen3:4b", 2_500_000_000, { offered: false }), row("medium", "qwen3:8b", 5_225_388_164, { recommended: true }),
    row("large", "gpt-oss:20b", 13_780_173_839, { fits: false })];
  const SETUP = { ...FOUND, memory_gb: 16, advice: "medium", free_bytes: 30_000_000_000, catalogue: CATALOGUE, apps: [
    { app: "ollama", installed: true, running: true, models: [{ id: "llama3.2:latest", size_bytes: 2_019_393_189, fits: true, recommended: false }] },
    { app: "lm-studio", installed: false, running: false, models: [] }] };
  const progress = (phase: ModelPhase, done = 0, over: Record<string, unknown> = {}) =>
    ({ model: "qwen3:8b", phase, done_bytes: done, total_bytes: 5_225_388_164, end: null, check: null, ...over });
  const rows = () => buttons().filter(b => /ai-row/u.test(b.getAttribute?.("class") ?? ""));
  const emit = async (s: { emit: (e: string, p: unknown) => void }, payload: unknown) => {
    const { act } = await import("react");
    await act(async () => { s.emit("ozzie:local-model", payload); });
    await settle();
  };

  it("says LM Link's words once under LM Studio's own models beside Ozzie's offer, and never under Ollama's (2026-11-19)", async () => {
    const LM_OWN = { ...SETUP, apps: [{ app: "ollama", installed: true, running: true, models: [] },
      { app: "lm-studio", installed: true, running: true, models: [{ id: "qwen/qwen3-8b", size_bytes: null }] }] };
    await mount(base({ local_ai_find: LM_OWN, local_model_progress: null }));
    await toMac();
    const text = seen();
    expect(rows().map(r => r.textContent)).toContain("qwen/qwen3-8b");
    expect(text.indexOf(MAC.lmLink)).toBeGreaterThan(text.indexOf("Or use a model you already have"));
    expect(text.indexOf(MAC.lmLink)).toBe(text.lastIndexOf(MAC.lmLink));
    await unmount!(); unmount = null;
    await mount(base({ local_ai_find: SETUP, local_model_progress: null }));
    await toMac();
    expect(seen()).toContain("Or use a model you already have");
    expect(seen()).not.toMatch(/LM Link/u);
  });

  it("offers the models Ozzie offers with the one for this Mac chosen, says what downloading means, and keeps the person's own models under them", async () => {
    const s = await mount(base({ local_ai_find: SETUP, local_model_progress: null }));
    await toMac();
    const text = seen();
    expect(text).toContain("Found Ollama on this Mac, with 1 AI model ready.");
    expect(text).toContain("This Mac has 16 GB of memory: a medium model will work well.");
    expect(text).toContain("Ozzie can download a model that suits this Mac and set it up for you.");
    expect(rows().map(r => r.textContent)).toEqual(["Medium, 5.2 GBRecommended for this Mac", "Large, 13.8 GBToo big for this Mac's memory", "llama3.2 · 2.0 GB"]);
    expect(rows().map(r => r.getAttribute?.("aria-pressed"))).toEqual(["true", "false", "false"]);
    expect(isDisabled(rows()[1]!)).toBe(true);
    // How long, for its size (review L-7): 5.2 GB at a modest church connection is about 15 minutes.
    expect(text).toContain("It downloads qwen3:8b (5.2 GB) from Ollama's library onto this Mac, then sets it up and checks that it answers. On a typical church connection this takes about 15 minutes, longer on slow Wi-Fi. Nothing about your church is sent.");
    // One primary, naming the effect; nothing is downloaded until it is pressed.
    expect(button("Download and set up")).not.toBeNull();
    expect(button("Check that it answers")).toBeNull();
    expect(s.calls.some(c => c.command === "local_model_download")).toBe(false);
    // Ozzie's copy carries its own room: Ollama's Context length hint is only for a model the person brought.
    expect(text).not.toContain(MAC.ollamaRoom);
    expect(text).toContain("Or use a model you already have");
    await press("llama3.2");
    expect(seen()).toContain(MAC.ollamaRoom);
    expect(button("Check that it answers")).not.toBeNull();
    expect(button("Download and set up")).toBeNull();
    allFullSize();
  });

  it("downloads with a real bar and a Stop, says each step once, and chooses the model when it answers", async () => {
    const s = await mount(base({ local_ai_find: SETUP, local_model_progress: null, local_model_download: progress("starting"), local_model_cancel: true }));
    await toMac();
    await press("Download and set up");
    expect(s.calls.find(c => c.command === "local_model_download")?.args).toEqual({ model: "qwen3:8b" });
    expect(seen()).toContain("Starting the download of qwen3:8b from Ollama's library…");
    await emit(s, progress("downloading", 1_200_000_000));
    const bar = nodes().find(n => n.tagName === "PROGRESS")!;
    expect([bar.getAttribute?.("value"), bar.getAttribute?.("max"), bar.getAttribute?.("aria-label")]).toEqual(["1200000000", "5225388164", "Downloading qwen3:8b"]);
    expect(seen()).toContain("1.2 of 5.2 GB downloaded");
    expect(seen()).toContain("You can close this window: Ozzie keeps downloading while it runs in the menu bar. Quitting Ozzie stops the download.");
    // The step is said in the polite status line; the bytes are not (a screen reader hears each step once).
    const steps = nodes().filter(n => n.getAttribute?.("role") === "status").map(n => n.textContent);
    expect(steps).toContain("Downloading qwen3:8b…");
    expect(steps.some(t => /GB downloaded/u.test(t))).toBe(false);
    // Nothing else can be chosen or started meanwhile.
    expect(rows().every(isDisabled)).toBe(true);
    expect(isDisabled(button("Download and set up")!)).toBe(true);
    await press("Stop the download");
    expect(s.calls.at(-1)?.command).toBe("local_model_cancel");
    await emit(s, progress("verifying", 5_225_388_164));
    expect(seen()).toContain("Downloaded. Ollama is making sure every part of qwen3:8b arrived whole…");
    await emit(s, progress("setting-up", 5_225_388_164));
    expect(seen()).toContain("Setting up qwen3:8b with room for Ozzie's longer questions…");
    // Past the download: no bar and no Stop, but never a spinner without words.
    expect(nodes().some(n => n.tagName === "PROGRESS")).toBe(false);
    expect(button("Stop the download")).toBeNull();
    await emit(s, progress("checking", 5_225_388_164));
    expect(seen()).toContain("Asking qwen3:8b a test question. This can take up to three minutes…");
    expect(s.onModel).not.toHaveBeenCalled();
    const finds = s.calls.filter(c => c.command === "local_ai_find").length;
    // It answers: the check's own words, the plain model name, and no advice about Ollama's settings even if the room was small.
    await emit(s, progress("checking", 5_225_388_164, { end: "done", check: { verdict: "answers", seconds: 31, small_room: true } }));
    expect(seen()).toContain("It answers. A typical answer took 31 seconds on this Mac.");
    expect(seen()).toContain("Ozzie will use qwen3:8b on this Mac. Nothing leaves this Mac.");
    expect(seen()).not.toMatch(/ozzie-qwen3|Context length/u);
    expect(s.onModel).toHaveBeenCalledWith(true);
    // The rows are read again (now on this Mac), and the way on is the screen's own.
    expect(s.calls.filter(c => c.command === "local_ai_find").length).toBe(finds + 1);
    expect(button("Next: open")).not.toBeNull();
  });

  it("keeps an ending native told before the press's own answer came, so the screen is never left at work (2026-11-19)", async () => {
    // Native tells the job's first step, then can end it (Ollama not answering, a model already set up whose check fails
    // at once) before "Download and set up"'s own answer reaches the page.
    let fake: ReturnType<typeof fakeNative> | null = null;
    const ended = progress("starting", 0, { end: "stopped" });
    const s = await mount(base({ local_ai_find: SETUP, local_model_progress: null,
      local_model_download: () => { fake!.emit("ozzie:local-model", ended); return progress("starting"); } }));
    fake = s;
    await toMac();
    await press("Download and set up");
    expect(seen()).toContain(downloadSaid("stopped", "qwen3:8b"));
    expect(seen()).not.toContain("Starting the download of qwen3:8b");
    expect(button("Stop the download")).toBeNull();
    expect(isDisabled(button("Download and set up")!)).toBe(false);
    // A step told before the answer stays too: it is newer than the first step.
    let fake2: ReturnType<typeof fakeNative> | null = null;
    await unmount!(); unmount = null;
    const s2 = await mount(base({ local_ai_find: SETUP, local_model_progress: null,
      local_model_download: () => { fake2!.emit("ozzie:local-model", progress("downloading", 1_200_000_000)); return progress("starting"); } }));
    fake2 = s2;
    await toMac();
    await press("Download and set up");
    expect(seen()).toContain("1.2 of 5.2 GB downloaded");
  });

  it("puts no line on Today for a download the person stopped (review L-7)", () => {
    const stopped = { model: "qwen3:8b", phase: "downloading" as ModelPhase, done_bytes: 10, total_bytes: 5_225_388_164, end: "cancelled" as const, check: null };
    expect(endedAwaySaid("cancelled", null, "qwen3:8b")).toBeNull();
    expect(MacEndedLine({ progress: stopped, onOpen: () => {}, onClose: () => {} })).toBeNull();
    // Even when the Stop landed after the download finished: the person pressed it, so Today stays quiet.
    expect(MacEndedLine({ progress: { ...stopped, phase: "setting-up", done_bytes: stopped.total_bytes }, onOpen: () => {}, onClose: () => {} })).toBeNull();
    expect(MacEndedLine({ progress: { ...stopped, end: "stalled" }, onOpen: () => {}, onClose: () => {} })).not.toBeNull();
  });

  it("says how each download ended in its own words, and why one couldn't start", async () => {
    const ends: Exclude<ModelEnd, "done">[] = ["cancelled", "no-space", "offline", "not-found", "stopped", "stalled", "failed", "not-set-up"];
    for (const end of ends) {
      const s = await mount(base({ local_ai_find: SETUP, local_model_progress: null, local_model_download: progress("starting") }));
      await toMac(); await press("Download and set up");
      await emit(s, progress("downloading", 10, { end }));
      expect(seen(), end).toContain(downloadSaid(end, "qwen3:8b"));
      expect(s.onModel).not.toHaveBeenCalled();
      // The model can be asked for again.
      expect(isDisabled(button("Download and set up")!)).toBe(false);
      await unmount!(); unmount = null;
    }
    // A Stop that lands after the download finished (native: Ollama said success, and the job ends at setting up): the
    // model is on this Mac, and the page says so instead of "the download is stopped" (review L-5).
    {
      const s = await mount(base({ local_ai_find: SETUP, local_model_progress: null, local_model_download: progress("starting") }));
      await toMac(); await press("Download and set up");
      await emit(s, progress("setting-up", 5_225_388_164, { end: "cancelled" }));
      expect(seen()).toContain(downloadSaid("cancelled", "qwen3:8b", true));
      expect(downloadSaid("cancelled", "qwen3:8b", true)).toBe("The download had already finished when Stop was pressed, so qwen3:8b is on this Mac but not set up yet. Press Set up to finish.");
      expect(seen()).not.toContain(downloadSaid("cancelled", "qwen3:8b"));
      await unmount!(); unmount = null;
    }
    // Every byte came, but Stop landed while Ollama was still checking the files or writing the manifest: native recorded
    // nothing and Ollama doesn't list the model, so it is the ordinary stopped sentence, never "Press Set up" (review L-1).
    for (const phase of ["verifying", "finishing"] as const) {
      const s = await mount(base({ local_ai_find: SETUP, local_model_progress: null, local_model_download: progress("starting") }));
      await toMac(); await press("Download and set up");
      await emit(s, progress(phase, 5_225_388_164, { end: "cancelled" }));
      expect(seen(), phase).toContain(downloadSaid("cancelled", "qwen3:8b"));
      expect(seen(), phase).not.toContain(downloadSaid("cancelled", "qwen3:8b", true));
      await unmount!(); unmount = null;
    }
    const refusals: DownloadRefusal[] = ["busy", "not-running", "too-big", "no-room", "not-in-catalogue", "not-offered"];
    for (const refusal of refusals) {
      await mount(base({ local_ai_find: SETUP, local_model_progress: null, local_model_download: () => { throw refusal; } }));
      await toMac(); await press("Download and set up");
      expect(seen(), refusal).toContain(refusedSaid(refusal));
      await unmount!(); unmount = null;
    }
    // A check verdict other than answers keeps the problem's words, with the way to try again named as the button is.
    const s = await mount(base({ local_ai_find: { ...SETUP, catalogue: [CATALOGUE[0], { ...CATALOGUE[1], downloaded: true, set_up: true, disk: "not-needed" }, CATALOGUE[2]] },
      local_model_progress: null, local_model_download: progress("checking") }));
    await toMac(); await press("Check that it answers");
    await emit(s, progress("checking", 0, { end: "done", check: { verdict: "choice-changed", seconds: 20 } }));
    expect(seen()).toContain(localSaid("choice-changed", "ollama", "qwen3:8b", "Sunday").lines[0]);
    expect(button("Check that it answers")).not.toBeNull();
    expect(s.onModel).not.toHaveBeenCalled();
  });

  it("offers Set up for a model already on this Mac, and Check that it answers once Ozzie set it up, through the same steps", async () => {
    const downloaded = { ...SETUP, catalogue: [CATALOGUE[0], { ...CATALOGUE[1], downloaded: true, disk: "not-needed" }, CATALOGUE[2]] };
    const s = await mount(base({ local_ai_find: downloaded, local_model_progress: null, local_model_download: progress("setting-up") }));
    await toMac();
    expect(rows()[0]!.textContent).toBe("Medium, 5.2 GBRecommended for this MacOn this Mac");
    expect(seen()).toContain("qwen3:8b is already on this Mac. Ozzie sets it up with room for longer questions, then checks that it answers. Nothing about your church is sent.");
    await press("Set up");
    expect(s.calls.find(c => c.command === "local_model_download")?.args).toEqual({ model: "qwen3:8b" });
    expect(s.calls.some(c => c.command === "local_ai_check")).toBe(false);
  });

  it("refuses a model the disk can't hold, saying how much is free, and never offers one too big for the memory", async () => {
    const full = { ...SETUP, free_bytes: 6_000_000_000, catalogue: [CATALOGUE[0], { ...CATALOGUE[1], disk: "not-enough" }, CATALOGUE[2]] };
    await mount(base({ local_ai_find: full, local_model_progress: null }));
    await toMac();
    expect(rows()[0]!.textContent).toBe("Medium, 5.2 GBRecommended for this MacNot enough free space");
    expect(isDisabled(rows()[0]!)).toBe(true);
    expect(seen()).toContain("Ollama's folder on this Mac has 6.0 GB free. A model needs its own size and about 3 GB more, so your Mac keeps room to work.");
    // The one for this Mac can't be had, so nothing is chosen to begin with, and nothing can be downloaded; the small one
    // that would fit is never offered instead.
    expect(rows().map(r => r.getAttribute?.("aria-pressed"))).toEqual(["false", "false", "false"]);
    expect(isDisabled(button("Download and set up")!)).toBe(true);
    expect(seen()).not.toContain("Small, 2.5 GB");
  });

  it("picks up a download under way when the screen opens again", async () => {
    const s = await mount(base({ local_ai_find: SETUP, local_model_progress: progress("downloading", 2_600_000_000, { total_bytes: 5_225_388_164 }),
      local_model_cancel: true }));
    await toMac();
    expect(rows()[0]!.getAttribute?.("aria-pressed")).toBe("true");
    expect(seen()).toContain("2.6 of 5.2 GB downloaded");
    expect(button("Stop the download")).not.toBeNull();
    expect(s.calls.some(c => c.command === "local_model_download")).toBe(false);
  });

  it("removes only Ozzie's own after asking, and says what was removed", async () => {
    const mine = { ...SETUP, catalogue: [CATALOGUE[0], { ...CATALOGUE[1], downloaded: true, set_up: true, disk: "not-needed", downloaded_by_ozzie: true }, CATALOGUE[2]] };
    const s = await mount(base({ local_ai_find: mine, local_model_progress: null, local_model_remove: { removed: "removed", route_cleared: true } }));
    await toMac();
    await press("Remove this model from this Mac");
    expect(seen()).toContain("Remove qwen3:8b from this Mac?");
    // Plainly, and "up to": Ollama keeps any file another model of the person's shares (review L-7).
    expect(seen()).toContain("Ozzie deletes qwen3:8b, which it downloaded, and the version of it Ozzie set up for longer questions. This frees up to 5.2 GB. If Ozzie uses it now, Ozzie stops using AI.");
    await press("Keep it");
    expect(s.calls.some(c => c.command === "local_model_remove")).toBe(false);
    await press("Remove this model from this Mac");
    await press("Remove it from this Mac");
    expect(s.calls.find(c => c.command === "local_model_remove")?.args).toEqual({ model: "qwen3:8b" });
    expect(seen()).toContain("qwen3:8b is removed from this Mac. Ozzie won't use AI now.");
    expect(s.onModel).toHaveBeenCalledWith(false);
    await unmount!(); unmount = null;
    // The person's own download, set up by Ozzie: only Ozzie's copy goes, and the sheet says so.
    const theirs = { ...SETUP, catalogue: [CATALOGUE[0], { ...CATALOGUE[1], downloaded: true, set_up: true, disk: "not-needed" }, CATALOGUE[2]] };
    await mount(base({ local_ai_find: theirs, local_model_progress: null }));
    await toMac();
    await press("Remove this model from this Mac");
    expect(seen()).toContain("Ozzie deletes the version of qwen3:8b it set up for longer questions. qwen3:8b itself stays in Ollama, because Ozzie didn't download it.");
    await unmount!(); unmount = null;
    // Nothing of Ozzie's: no way to remove anything.
    await mount(base({ local_ai_find: SETUP, local_model_progress: null }));
    await toMac();
    expect(button("Remove this model from this Mac")).toBeNull();
  });

  it("has words for every step, ending and refusal, none of them forbidden", () => {
    const phases: ModelPhase[] = ["starting", "downloading", "verifying", "finishing", "setting-up", "checking"];
    const ends: Exclude<ModelEnd, "done">[] = ["cancelled", "no-space", "offline", "not-found", "stopped", "stalled", "failed", "not-set-up"];
    const refusals: DownloadRefusal[] = ["busy", "not-running", "too-big", "no-room", "not-in-catalogue", "not-offered", "unavailable"];
    const removals: ModelRemoved[] = ["removed", "none", "stopped", "failed", "busy"];
    const all = [...phases.map(p => MAC.step(p, "qwen3:8b")), ...ends.map(e => downloadSaid(e, "qwen3:8b")), ...refusals.map(refusedSaid),
      ...removals.map(r => removedSaid(r, "qwen3:8b", true).text), MAC.willDownload("qwen3:8b", 5_225_388_164), MAC.willSetUp("qwen3:8b"), MAC.keepsGoing,
      MAC.space(1e9), MAC.removeBody("qwen3:8b", true, 1), MAC.removeBody("qwen3:8b", false, 1), MAC.memory("too-small", 8)!, MAC.tooSmallWays, MAC.ownStill,
      MAC.notOfferedLine("qwen3:4b"), endedAwaySaid("done", "answers", "qwen3:8b")!.text, endedAwaySaid("done", "choice-changed", "qwen3:8b")!.text,
      endedAwaySaid("stalled", null, "qwen3:8b")!.text];
    // Each says its own thing, except that a model native didn't know and a native side that didn't say read the same.
    expect(refusedSaid("not-in-catalogue")).toBe(refusedSaid("unavailable"));
    expect(new Set(all).size).toBe(all.length - 1);
    for (const text of all) {
      expect(text).not.toMatch(FORBIDDEN);
      expect(text).not.toMatch(/ozzie-|for me|Terminal|ollama pull/u);
    }
    expect(removals.map(r => removedSaid(r, "qwen3:8b", false).ok)).toEqual([true, true, false, false, false]);
    expect(MAC.amount(1_234_000_000, 5_225_388_164)).toBe("1.2 of 5.2 GB downloaded");
    expect(MAC.catalogueRow("large", 13_780_173_839)).toBe("Large, 13.8 GB");
  });

  it("says how long a download takes for its size, at a modest church connection (review L-7)", () => {
    // 50 megabits a second (assumed), rounded up to five minutes; an hour or more is said so.
    expect([2_500_000_000, 5_225_388_164, 13_780_173_839, 30_000_000_000].map(downloadTime))
      .toEqual(["about 10 minutes", "about 15 minutes", "about 40 minutes", "an hour or more"]);
    expect(MAC.willDownload("gpt-oss:20b", 13_780_173_839)).toContain("On a typical church connection this takes about 40 minutes, longer on slow Wi-Fi.");
    expect(JSON.stringify(MAC)).not.toMatch(/several minutes|set-up copy|frees about/u);
  });

  describe("a Mac too small for the models Ozzie offers (2026-11-18: the small model never finished a lookup question)", () => {
    const EIGHT = { memory_gb: 8, advice: "too-small", recommended: null, recommended_size_bytes: null, free_bytes: 30_000_000_000,
      catalogue: [row("small", "qwen3:4b", 2_500_000_000, { offered: false }), row("medium", "qwen3:8b", 5_225_388_164, { fits: false }),
        row("large", "gpt-oss:20b", 13_780_173_839, { fits: false })],
      apps: [{ app: "ollama", installed: true, running: true, models: [] }, { app: "lm-studio", installed: false, running: false, models: [] }] };
    const NONE_STATUS = { configured: false, route: "none", label: "No AI model set up", setup: "no-route" };

    it("says plainly that AI on this Mac needs 16 GB or more, offers the other two ways, and never a download", async () => {
      const s = await mount(base({ local_ai_find: EIGHT, local_model_progress: null }));
      await toMac();
      const text = seen();
      expect(text).toContain("This Mac has 8 GB of memory. AI on this Mac needs a Mac with 16 GB of memory or more.");
      expect(text).toContain("You can use a key from an AI company instead, or no AI for now: everything else in Ozzie works without it.");
      expect(text).not.toContain("Ozzie can download a model that suits this Mac");
      // Ollama is open with no models: the 16 GB line says what matters, never "no AI models yet" over an empty list
      // (review L-7).
      expect(text).not.toContain(MAC.ollamaNoModels);
      expect(rows()).toEqual([]);
      expect(button("Download and set up")).toBeNull();
      expect(button("Check that it answers")).toBeNull();
      await press("Use a key from an AI company");
      expect(seen()).toContain("Which AI company?");
      expect(s.calls.some(c => c.command === "local_model_download")).toBe(false);
      allFullSize();
      await unmount!(); unmount = null;
      const t = await mount(base({ local_ai_find: EIGHT, local_model_progress: null, set_no_ai: NONE_STATUS }));
      await toMac();
      await press("No AI for now");
      expect(t.calls.some(c => c.command === "set_no_ai")).toBe(true);
      expect(t.onDone).toHaveBeenCalledWith("none");
    });

    it("keeps a model of the person's own to check, and one of Ozzie's it no longer offers to remove", async () => {
      const mine = { ...EIGHT, catalogue: [row("small", "qwen3:4b", 2_500_000_000, { offered: false, downloaded: true, set_up: true, disk: "not-needed", downloaded_by_ozzie: true }),
        ...EIGHT.catalogue.slice(1)],
        apps: [{ app: "ollama", installed: true, running: true, models: [{ id: "llama3.2:latest", size_bytes: 2_019_393_189, fits: true, recommended: false }] },
          { app: "lm-studio", installed: false, running: false, models: [] }] };
      const s = await mount(base({ local_ai_find: mine, local_model_progress: null, local_model_remove: { removed: "removed", route_cleared: false } }));
      await toMac();
      expect(rows().map(r => r.textContent)).toEqual(["Small, 2.5 GBOn this MacNot offered any more", "llama3.2 · 2.0 GB"]);
      await press("Small, 2.5 GB");
      expect(seen()).toContain("Ozzie no longer sets up qwen3:4b: in Ozzie's tests it never finished an answer that needed one of Ozzie's lookups. You can remove it from this Mac.");
      expect(button("Download and set up")).toBeNull();
      expect(button("Set up")).toBeNull();
      await press("Remove this model from this Mac");
      await press("Remove it from this Mac");
      expect(s.calls.find(c => c.command === "local_model_remove")?.args).toEqual({ model: "qwen3:4b" });
      // The person's own model keeps today's path: chosen, then checked.
      await press("llama3.2");
      expect(isDisabled(button("Check that it answers")!)).toBe(false);
    });

    it("with nothing found, points to a model of their own, not to installing Ollama", async () => {
      const nothing = { ...EIGHT, catalogue: [], apps: [{ app: "ollama", installed: false, running: false, models: [] }, { app: "lm-studio", installed: false, running: false, models: [] }] };
      const s = await mount(base({ local_ai_find: nothing, local_model_progress: null }));
      await toMac();
      const text = seen();
      expect(text).toContain("Ozzie didn't find AI on this Mac.");
      expect(text).toContain("If you already run a model of your own in Ollama or LM Studio, open it, then press Look again.");
      expect(text).toContain("AI on this Mac needs a Mac with 16 GB of memory or more.");
      expect(button("Open ollama.com")).toBeNull();
      expect(button("Look again")).not.toBeNull();
      // The 16 GB rule: Ozzie never offers to get Ollama for a Mac that can't run a model it offers (decision 25).
      expect(text).not.toContain(OLLAMA.offerTitle);
      expect(button(OLLAMA.install)).toBeNull();
      expect(s.calls.some(c => c.command === "ollama_install")).toBe(false);
    });
  });
});

describe("S9c: Ozzie gets Ollama itself (owner's request, 2026-11-18; decision 25)", () => {
  const toMac = async () => { await press("Your church's own AI"); await press("AI on this Mac"); };
  const nobody = (name: string) => ({ app: name, installed: false, running: false, models: [] });
  /** A 16 GB Mac with nothing on it: the offer to get Ollama. */
  const NOTHING = { ...FOUND, recommended: "qwen3:8b", recommended_size_bytes: 5_225_388_164, apps: [nobody("ollama"), nobody("lm-studio")], free_bytes: null, catalogue: [] };
  /** The same Mac once Ollama answers: the model offer of S9b, with the model for this Mac chosen. */
  const ANSWERING = { ...NOTHING, free_bytes: 30_000_000_000, apps: [{ app: "ollama", installed: true, running: true, models: [] }, nobody("lm-studio")],
    catalogue: [{ size: "medium", id: "qwen3:8b", size_bytes: 5_225_388_164, fits: true, offered: true, recommended: true, downloaded: false, set_up: false, disk: "enough", downloaded_by_ozzie: false }] };
  const QUIET_ON_THIS_MAC = { ...NOTHING, apps: [{ app: "ollama", installed: true, running: false, models: [] }, nobody("lm-studio")] };
  const at = (phase: OllamaPhase, done = 0, total = 0, end: OllamaEnd | null = null) => ({ phase, done_bytes: done, total_bytes: total, end });
  const emit = async (s: { emit: (e: string, p: unknown) => void }, payload: unknown) => {
    const { act } = await import("react");
    await act(async () => { s.emit("ozzie:ollama-install", payload); });
    await settle();
  };
  /** Native's finding, one after another (the last repeats). */
  const finding = (...each: unknown[]) => { let n = 0; return () => each[Math.min(n++, each.length - 1)]; };
  const ENDS: OllamaEnd[] = ["ready", "cancelled", "offline", "redirected", "too-large", "stalled", "download-failed", "no-room", "bad-archive", "not-signed",
    "wrong-team", "wrong-app", "not-notarized", "outdated", "already-installed", "cant-install", "install-failed", "wont-open", "not-answering", "failed"];
  const REFUSALS: OllamaRefusal[] = ["busy", "too-small", "already-installed", "already-running", "unavailable"];
  const PHASES: OllamaPhase[] = ["starting", "downloading", "checking", "installing", "opening", "still-starting"];

  it("asks first in plain words, with what Ollama is, where it comes from, how it is checked, and nothing downloaded before the press", async () => {
    const s = await mount(base({ local_ai_find: NOTHING, open_help_page: null }));
    await toMac();
    const text = seen();
    expect(text).toContain("Ozzie didn't find AI on this Mac.");
    expect(text).toContain("Ozzie can get Ollama for you");
    // Scannable (live, 2026-11-19): three short sentences up front (who makes it, from where, where it goes, what comes
    // next with the model's size), a short list, and the checks under one fold in the app's style. Every promise kept.
    const card = nodes().find(n => n.getAttribute?.("class") === "ai-get")!;
    const up = card.childNodes.filter(n => n.tagName === "P").map(n => n.textContent);
    expect(up).toEqual(["Ozzie can get Ollama for you",
      "Ollama is a free app from another company, also called Ollama, that runs AI on this Mac.",
      "Ozzie downloads it from ollama.com, checks it, and puts it in your Applications folder.",
      "Then Ozzie offers the AI model that suits this Mac (about 5.2 GB), downloads it and sets it up for you."]);
    const list = card.childNodes.find(n => n.tagName === "UL")!;
    expect(list.childNodes.map(n => n.textContent)).toEqual([
      "Nothing about your church leaves this Mac: the AI models Ozzie sets up in Ollama run here.",
      "You see the download's size as it starts, and you can stop it.",
      "Ollama starts by itself whenever you sign in to this Mac. To stop that, search System Settings for Login Items and turn off Ollama under Allow in the Background."]);
    const fold = card.childNodes.find(n => n.tagName === "DETAILS")!;
    expect(fold.getAttribute?.("class")).toBe("ai-more");
    const summary = fold.childNodes.find(n => n.tagName === "SUMMARY")!;
    expect(summary.textContent).toBe("What Ozzie checks before installing");
    expect(all(summary).some(n => /\bic\b/u.test(n.getAttribute?.("class") ?? ""))).toBe(true);
    expect(fold.textContent).toContain("Ozzie downloads Ollama only from ollama.com, Ollama's own website, and stops if the download is sent somewhere Ozzie doesn't trust.");
    expect(fold.textContent).toContain("Before anything is opened, Ozzie checks that Ollama's makers signed it and that Apple checked it. If either check fails, Ozzie deletes it and installs nothing.");
    for (const line of [...OLLAMA.offer, ...OLLAMA.facts, OLLAMA.checksTitle, ...OLLAMA.checks]) expect(line).not.toMatch(FORBIDDEN);
    // No size in fixed words: the download's own size is shown once it starts.
    expect([...OLLAMA.offer, ...OLLAMA.facts, ...OLLAMA.checks].join(" ")).not.toMatch(/\d+(\.\d+)? ?(MB|GB)/u);
    // Two buttons, each naming the person and the effect; nothing is asked of native but a look.
    expect(button("Download Ollama and set it up")).not.toBeNull();
    expect(button("I'll install it myself")).not.toBeNull();
    expect(button("Open ollama.com")).toBeNull();
    expect(s.calls.map(c => c.command).filter(c => /^ollama_install$|^ollama_reveal$|^open_help_page$/u.test(c))).toEqual([]);
    allFullSize();
    // "I'll install it myself": Ollama's download page in the browser, today's guide, and still nothing downloaded.
    await press("I'll install it myself");
    expect(s.calls.at(-1)).toEqual({ command: "open_help_page", args: { page: "ollama-download" } });
    expect(seen()).toContain(MAC.guide[0].text);
    expect(seen()).not.toContain(OLLAMA.offerTitle);
    expect(s.calls.some(c => c.command === "ollama_install")).toBe(false);
  });

  it("downloads with its real size, a bar and a Stop, says each step once, and hands over to the model offer when Ollama answers", async () => {
    let answering = false;
    const s = await mount(base({ local_ai_find: () => answering ? ANSWERING : NOTHING, ollama_install: at("starting"), ollama_install_cancel: true, local_model_progress: null }));
    await toMac();
    await press("Download Ollama and set it up");
    expect(s.calls.find(c => c.command === "ollama_install")?.args).toEqual({});
    const status = () => nodes().filter(n => n.getAttribute?.("role") === "status").map(n => n.textContent);
    expect(status()).toContain("Starting the download of Ollama from ollama.com…");
    // Nothing else is offered meanwhile; Stop is.
    expect(button("Download Ollama and set it up")).toBeNull();
    expect(button("I'll install it myself")).toBeNull();
    expect(button("Stop the download")).not.toBeNull();
    await emit(s, at("downloading", 12_400_000, 229_245_253));
    const bar = nodes().find(n => n.tagName === "PROGRESS")!;
    expect([bar.getAttribute?.("value"), bar.getAttribute?.("max"), bar.getAttribute?.("aria-label")]).toEqual(["12400000", "229245253", "Downloading Ollama"]);
    expect(seen()).toContain("12 of 229 MB downloaded");
    expect(status()).toContain("Downloading Ollama (229 MB) from ollama.com…");
    expect(status().some(t => /MB downloaded/u.test(t))).toBe(false);
    expect(seen()).toContain(MAC.keepsGoing);
    await press("Stop the download");
    expect(s.calls.at(-1)?.command).toBe("ollama_install_cancel");
    // Checking, installing and opening take seconds: no bar and no Stop, never a spinner without words.
    await emit(s, at("checking", 229_245_253, 229_245_253));
    expect(status()).toContain("Downloaded. Checking that Ollama's makers signed it and that Apple checked it…");
    expect(button("Stop the download")).toBeNull();
    expect(nodes().some(n => n.tagName === "PROGRESS")).toBe(false);
    await emit(s, at("installing", 229_245_253, 229_245_253));
    expect(status()).toContain("Putting Ollama in your Applications folder…");
    await emit(s, at("opening", 229_245_253, 229_245_253));
    expect(status()).toContain("Opening Ollama. Ollama may open its own window and ask for your Mac's password to add a tool of its own. Ozzie doesn't need either, so you can close that window.");
    await emit(s, at("still-starting", 229_245_253, 229_245_253));
    expect(status()).toContain("Ollama is still starting. The first time can take a minute. Ollama may open its own window and ask for your Mac's password to add a tool of its own. Ozzie doesn't need either, so you can close that window.");
    const finds = s.calls.filter(c => c.command === "local_ai_find").length;
    answering = true;
    await emit(s, at("opening", 229_245_253, 229_245_253, "ready"));
    // Ollama answers: Ozzie looks again, and the model offer is there with this Mac's model chosen; its own press starts it.
    expect(s.calls.filter(c => c.command === "local_ai_find").length).toBe(finds + 1);
    expect(seen()).toContain("Ollama is installed and open.");
    expect(seen()).toContain("Ollama is open but has no AI models yet.");
    const rows = buttons().filter(b => /ai-row/u.test(b.getAttribute?.("class") ?? ""));
    expect(rows.map(r => r.getAttribute?.("aria-pressed"))).toEqual(["true"]);
    expect(button("Download and set up")).not.toBeNull();
    expect(s.calls.some(c => c.command === "local_model_download")).toBe(false);
    expect(seen()).not.toContain(OLLAMA.offerTitle);
  });

  it("says how each ending went in its own words, offers the person's own way where pressing again won't help, and Finder where Applications needs a password", async () => {
    for (const end of ENDS.filter(e => e !== "ready")) {
      const after = end === "already-installed" || end === "wont-open" || end === "not-answering" ? QUIET_ON_THIS_MAC : NOTHING;
      const s = await mount(base({ local_ai_find: finding(NOTHING, after), ollama_install: at("starting"), open_help_page: null, local_ai_open: null,
        ollama_reveal: () => { throw "not-there"; } }));
      await toMac(); await press("Download Ollama and set it up");
      await emit(s, at("downloading", 100, 229_245_253, end));
      const said = ollamaEndSaid(end);
      // Once the look after it shows Ollama on this Mac, its card says how it is now: "it didn't open" and "it hasn't
      // started answering" aren't said over it (live, 2026-11-19); "already in Applications" still says why nothing came.
      const replaced = end === "wont-open" || end === "not-answering";
      if (replaced) expect(seen(), end).not.toContain(said.text); else expect(seen(), end).toContain(said.text);
      expect(seen(), end).not.toMatch(/\/Users|\/Applications|codesign|spctl|ditto|Team ID|3MU9H2V9Y9|github/u);
      if (after === QUIET_ON_THIS_MAC) {
        // What is on this Mac now says the next step: Ollama is there but quiet, so "Open Ollama".
        expect(seen(), end).toContain("Ollama is on this Mac but isn't open.");
        expect(button("Open Ollama"), end).not.toBeNull();
      }
      if (said.reveal) {
        expect(button("Download Ollama and set it up"), end).toBeNull();
        await press("Show Ollama in Finder");
        expect(s.calls.at(-1)?.command).toBe("ollama_reveal");
        expect(seen()).toContain(ollamaRevealSaid("not-there"));
        expect(button("Look again")).not.toBeNull();
      } else if (after === NOTHING) {
        // The offer stays, to press again or to install it themselves.
        expect(button("Download Ollama and set it up"), end).not.toBeNull();
      }
      if (said.myself) {
        expect(seen(), end).toContain("You can install Ollama yourself from ollama.com.");
        await press("I'll install it myself");
        expect(s.calls.at(-1), end).toEqual({ command: "open_help_page", args: { page: "ollama-download" } });
        expect(seen(), end).toContain(MAC.guide[0].text);
      }
      await unmount!(); unmount = null;
    }
    // The exact words of the checks that fail, each its own.
    expect(ollamaEndSaid("not-signed").text).toBe("The download isn't signed by Ollama's makers, so Ozzie deleted it. Nothing was installed. You can install Ollama yourself from ollama.com.");
    expect(ollamaEndSaid("wrong-team").text).toBe("The download is signed by someone other than Ollama's makers, so Ozzie deleted it. Nothing was installed. You can install Ollama yourself from ollama.com.");
    expect(ollamaEndSaid("wrong-app").text).toBe("The download is signed by Ollama's makers, but it isn't the Ollama app, so Ozzie deleted it. Nothing was installed. You can install Ollama yourself from ollama.com.");
    expect(ollamaEndSaid("not-notarized").text).toBe("Apple hasn't checked this download, so Ozzie deleted it. Nothing was installed. You can install Ollama yourself from ollama.com.");
    expect(ollamaEndSaid("outdated").text).toBe("The download is an older Ollama than Ozzie installs, so Ozzie deleted it. Nothing was installed. You can install Ollama yourself from ollama.com.");
    expect(ollamaEndSaid("cant-install").text).toBe("Adding apps to the Applications folder on this Mac needs an administrator's password, and Ozzie never asks for one. Ozzie checked Ollama and kept it for you: press Show Ollama in Finder, drag Ollama into Applications, open it, then press Look again.");
    expect(ollamaEndSaid("not-answering").text).toBe("Ollama is in your Applications folder now, but it hasn't started answering yet.");
    expect(ollamaEndSaid("cancelled").text).toBe("The download is stopped, and Ozzie deleted what came. Nothing was installed.");
  });

  it("says Ollama is open but not answering when its program runs, never that it isn't open (live, 2026-11-19)", async () => {
    const OPEN_NOT_ANSWERING = { ...NOTHING, apps: [{ app: "ollama", installed: true, running: false, open: true, models: [] }, nobody("lm-studio")] };
    expect(MAC.ollamaQuiet).toBe("Ollama is open, but it isn't answering yet. If it doesn't answer in a minute, quit Ollama from the llama picture at the top of your screen, then press Open Ollama.");
    const s = await mount(base({ local_ai_find: finding(NOTHING, OPEN_NOT_ANSWERING), ollama_install: at("starting"), local_ai_open: null }));
    await toMac(); await press("Download Ollama and set it up");
    await emit(s, at("opening", 0, 229_245_253, "not-answering"));
    expect(seen()).toContain(MAC.ollamaQuiet);
    expect(seen()).not.toContain(MAC.ollamaClosed);
    expect(seen()).not.toContain(ollamaEndSaid("not-answering").text);
    expect(button("Open Ollama")).not.toBeNull();
    expect(button("Look again")).not.toBeNull();
    for (const line of [MAC.ollamaQuiet, MAC.opening, OLLAMA.still]) expect(line).not.toMatch(FORBIDDEN);
  });

  it("after Open Ollama, waits for it and shows the model offer by itself, with Ozzie back in front (live, 2026-11-19)", async () => {
    vi.useFakeTimers();
    let up = false;
    const s = await mount(base({ local_ai_find: () => up ? ANSWERING : QUIET_ON_THIS_MAC, ollama_install_progress: at("opening", 0, 229_245_253, "not-answering"), local_ai_open: null, come_forward: null }));
    await toMac();
    expect(seen()).toContain(MAC.ollamaClosed);
    // Ozzie's window had the keyboard when Open Ollama was pressed; Ollama's own then came in front.
    let front = true;
    (document as unknown as { hasFocus: () => boolean }).hasFocus = () => front;
    await press("Open Ollama");
    expect(s.calls.find(c => c.command === "local_ai_open")?.args).toEqual({ app: "ollama" });
    expect(seen()).toContain(MAC.opening);
    expect(seen()).not.toContain(MAC.ollamaClosed);
    expect(button("Open Ollama")).toBeNull();
    front = false;
    const { act } = await import("react");
    await act(async () => { await vi.advanceTimersByTimeAsync(2_100); });
    await settle();
    expect(seen()).toContain(MAC.opening);
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    await settle();
    // Still not answering after 20 seconds: the same words as after installing it.
    expect(seen()).toContain(OLLAMA.still);
    up = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(2_100); });
    await settle();
    // Ollama answers: the model offer, without Look again, and nothing stale above it.
    expect(seen()).toContain("Ozzie can download a model that suits this Mac and set it up for you.");
    expect(seen()).not.toContain(OLLAMA.still);
    expect(seen()).not.toContain(ollamaEndSaid("not-answering").text);
    expect(s.calls.filter(c => c.command === "come_forward")).toHaveLength(1);
    const asked = s.calls.filter(c => c.command === "local_ai_find").length;
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(s.calls.filter(c => c.command === "local_ai_find").length).toBe(asked);
    delete (document as unknown as { hasFocus?: unknown }).hasFocus;
  });

  it("stops waiting after two minutes and says how Ollama is then; Ozzie isn't brought forward when it stayed in front", async () => {
    vi.useFakeTimers();
    const OPEN_NOT_ANSWERING = { ...NOTHING, apps: [{ app: "ollama", installed: true, running: false, open: true, models: [] }, nobody("lm-studio")] };
    const s = await mount(base({ local_ai_find: OPEN_NOT_ANSWERING, local_ai_open: null, come_forward: null }));
    await toMac();
    await press("Open Ollama");
    const { act } = await import("react");
    await act(async () => { await vi.advanceTimersByTimeAsync(121_000); });
    await settle();
    expect(seen()).toContain(MAC.ollamaQuiet);
    expect(seen()).not.toContain(OLLAMA.still);
    expect(button("Open Ollama")).not.toBeNull();
    const asked = s.calls.filter(c => c.command === "local_ai_find").length;
    expect(asked).toBeLessThanOrEqual(1 + 61);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(s.calls.filter(c => c.command === "local_ai_find").length).toBe(asked);
    expect(s.calls.some(c => c.command === "come_forward")).toBe(false);
  });

  it("says why it couldn't start, and keeps today's guide when this build's native side can't get Ollama", async () => {
    for (const refusal of REFUSALS) {
      const s = await mount(base({ local_ai_find: NOTHING, ollama_install: () => { throw refusal; } }));
      await toMac(); await press("Download Ollama and set it up");
      expect(seen(), refusal).toContain(ollamaRefusedSaid(refusal));
      // Already there: Ozzie looks again, so the next step shows.
      const looks = s.calls.filter(c => c.command === "local_ai_find").length;
      expect(looks, refusal).toBe(refusal === "already-installed" || refusal === "already-running" ? 2 : 1);
      await unmount!(); unmount = null;
    }
    // No such command on this build: the guide, nothing downloaded and no browser opened by itself.
    const s = await mount(base({ local_ai_find: NOTHING }));
    await toMac(); await press("Download Ollama and set it up");
    expect(seen()).toContain(MAC.guide[0].text);
    expect(s.calls.some(c => c.command === "open_help_page")).toBe(false);
  });

  it("reads native's progress and record as closed words and numbers only, and an ending always gets through", () => {
    expect(parseOllamaProgress(at("downloading", 5, 10))).toEqual(at("downloading", 5, 10));
    // A word native doesn't have is a failure, never work still going on; numbers past the cap or broken don't hold it.
    expect(parseOllamaProgress({ phase: "downloading", done_bytes: 1, total_bytes: 2, end: "finished-somehow" })?.end).toBe("failed");
    expect(parseOllamaProgress({ phase: "who-knows", done_bytes: "x", total_bytes: 2e12, end: "ready" })).toEqual(at("starting", 0, 0, "ready"));
    expect(parseOllamaProgress({ phase: "downloading", done_bytes: 9, total_bytes: 5, end: null })).toEqual(at("downloading", 5, 5));
    expect(parseOllamaProgress({ phase: "who-knows", end: null })).toBeNull();
    expect(parseOllamaProgress("ready")).toBeNull();
    // The record keeps a time and a closed word per ending; anything else is dropped.
    expect(parseOllamaHistory({ done: [{ at_ms: 1, end: "ready" }, { at_ms: 2, end: "/Applications/Ollama.app" }, { at_ms: -1, end: "ready" }, "x"], installed_at_ms: 1 }))
      .toEqual({ done: [{ at_ms: 1, end: "ready" }], installed_at_ms: 1 });
    expect(parseOllamaHistory({ done: "x", installed_at_ms: "soon" })).toEqual({ done: [], installed_at_ms: null });
    expect(parseOllamaHistory(null)).toBeNull();
  });

  it("keeps an ending native told before the press's own answer came, so the screen is never left at work", async () => {
    let fake: ReturnType<typeof fakeNative> | null = null;
    const s = await mount(base({ local_ai_find: NOTHING, ollama_install: () => { fake!.emit("ozzie:ollama-install", at("starting", 0, 0, "offline")); return at("starting"); } }));
    fake = s;
    await toMac(); await press("Download Ollama and set it up");
    expect(seen()).toContain(ollamaEndSaid("offline").text);
    expect(button("Stop the download")).toBeNull();
    expect(button("Download Ollama and set it up")).not.toBeNull();
  });

  it("picks up getting Ollama under way when the screen opens again", async () => {
    const s = await mount(base({ local_ai_find: NOTHING, ollama_install_progress: at("downloading", 100_000_000, 229_245_253), ollama_install_cancel: true }));
    await toMac();
    expect(seen()).toContain("100 of 229 MB downloaded");
    expect(button("Stop the download")).not.toBeNull();
    expect(button("Download Ollama and set it up")).toBeNull();
    expect(s.calls.some(c => c.command === "ollama_install")).toBe(false);
  });

  it("has words for every step, ending and refusal, none forbidden, none with a path or a tool's name", () => {
    const all = [...PHASES.map(p => OLLAMA.step(p, 229_245_253)), ...ENDS.map(e => ollamaEndSaid(e).text), ...REFUSALS.map(ollamaRefusedSaid),
      ...(["not-there", "finder-unavailable", "busy"] as const).map(ollamaRevealSaid), ...ENDS.map(ollamaDoneSaid), ...OLLAMA.offer, OLLAMA.then(5e9),
      OLLAMA.settingsTitle, OLLAMA.settingsBody("November 18, 2026"), OLLAMA.settingsRemove, OLLAMA.windowNote, OLLAMA.install, OLLAMA.myself, OLLAMA.reveal];
    for (const text of all) {
      expect(text).not.toMatch(FORBIDDEN);
      expect(text).not.toMatch(/\/Users|\/Applications|codesign|spctl|ditto|sudo|Terminal|3MU9H2V9Y9|github|undefined|null/u);
      expect(text, text).toMatch(/^[A-Z]/u);
    }
    // Every ending has a sentence of its own on this screen.
    const ends = ENDS.map(e => ollamaEndSaid(e).text);
    expect(new Set(ends).size).toBe(ends.length);
    expect(OLLAMA.step("downloading", 0)).toBe("Downloading Ollama from ollama.com…");
    expect([bytesText(229_245_253), bytesText(1_000_000_000), bytesText(40_000)]).toEqual(["229 MB", "1.0 GB", "1 MB"]);
    expect(OLLAMA.amount(0, 229_245_253)).toBe("0 of 229 MB downloaded");
  });

  it("Settings › AI help says Ollama was installed by Ozzie and how to remove it, only while it is", async () => {
    const STATUS = { configured: true, route: "local", label: "AI model on this Mac (qwen3:8b)", setup: "ready", checked_at_ms: 1_763_500_000_000 };
    const at_ms = Date.UTC(2026, 10, 18, 18);
    for (const installed of [at_ms, null]) {
      const fake = fakeNative({ model_status: STATUS, ollama_install_history: { done: [{ at_ms, end: "ready" }], installed_at_ms: installed } });
      native.invoke = fake.invoke as never;
      const { act } = await import("react");
      const { createRoot } = await import("react-dom/client");
      const root = createRoot(dom.root as unknown as Element);
      await act(async () => { root.render(React.createElement(AiSettings, { onChange() {} })); });
      await settle();
      unmount = async () => { await act(async () => { root.unmount(); }); };
      if (installed) {
        expect(seen()).toContain("Ollama, which Ozzie installed");
        expect(seen()).toContain("Ozzie downloaded Ollama from ollama.com and put it in your Applications folder on November 18, 2026. Ollama is another company's app, with its own settings and its own updates. Ozzie doesn't remove other companies' apps.");
        expect(seen()).toContain(OLLAMA.settingsRemove);
        // It starts at login, said with the way Ollama's own FAQ gives to turn that off (live, 2026-11-19).
        expect(seen()).toContain("Ollama starts by itself whenever you sign in to this Mac. To stop that, search System Settings for Login Items and turn off Ollama under Allow in the Background.");
        expect(OLLAMA.settingsRemove).toContain("drag Ollama from Applications to the Trash");
        expect(OLLAMA.settingsRemove).toContain("the .ollama folder in your home folder");
      } else expect(seen()).not.toContain("Ollama, which Ozzie installed");
      // Showing it removes nothing and starts nothing.
      expect(fake.calls.map(c => c.command).filter(c => /^ollama_install$|^ollama_reveal$|remove/u.test(c))).toEqual([]);
      await unmount!(); unmount = null;
    }
  });

  it("What happened has a plain line for each time, with no path", () => {
    const html = renderToStaticMarkup(React.createElement(DayProvider, { value: UNKNOWN_WORDS }, React.createElement(ActivityPage, { capture: null, tasks: [],
      ollama: [{ at_ms: Date.UTC(2026, 10, 18, 18), end: "wrong-team" }, { at_ms: Date.UTC(2026, 10, 18, 19), end: "ready" }] })));
    const text = html.replace(/<[^>]+>/gu, " ").replace(/&#x27;/gu, "'").replace(/\s+/gu, " ");
    expect(text).toContain("Getting Ollama");
    expect(text).toContain("Downloaded Ollama from ollama.com, checked that Ollama's makers signed it and that Apple checked it, and put it in Applications.");
    expect(text).toContain("Downloaded Ollama from ollama.com, but it didn't pass Ozzie's check, so Ozzie deleted it. Nothing was installed.");
    // Newest first.
    expect(text.indexOf("and put it in Applications")).toBeLessThan(text.indexOf("didn't pass Ozzie's check"));
    expect(text).not.toMatch(/\/Users|\/Applications|Library|Caches/u);
    // None yet: no section.
    expect(renderToStaticMarkup(React.createElement(DayProvider, { value: UNKNOWN_WORDS }, React.createElement(ActivityPage, { capture: null, tasks: [], ollama: [] })))).not.toContain("Getting Ollama");
  });
});

describe("S10: Ozzie's AI", () => {
  const PAID = { plan: "personal", allowance_steps: 1200, used_steps: 0, period_ends: "2026-12-17T00:00:00Z", warning: null, checked_at_ms: 0, offline: false };
  const NONE = { ...PAID, plan: "none", allowance_steps: 0 };
  const ROUTE = { configured: true, route: "managed", label: "x", setup: "ready", managed: "connected" };
  /** S10's first screen from Settings ("Start Ozzie's AI"), the one way to it while S6's card can't be chosen. */
  const mountSettingsOzzie = async (offer: unknown) => {
    const fake = fakeNative({ model_status: { configured: false, route: "managed", label: "x", setup: "not-connected", managed: "not-connected" }, managed_offer: offer });
    native.invoke = fake.invoke as never;
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(dom.root as unknown as Element);
    await act(async () => { root.render(React.createElement(AiSettings, { onChange() {} })); });
    await settle();
    unmount = async () => { await act(async () => { root.unmount(); }); };
    await press("Start Ozzie's AI");
  };

  it("with the service's day not known yet, its way on reads as a sentence: Next: open Services (walk-through, 2026-11-18)", async () => {
    const s = await mount(base({ managed_connect: PAID, set_model_route: ROUTE }), "first-run", UNKNOWN_WORDS);
    // The choice's own words with no day known: "your questions about your service".
    expect(seen()).toContain("answer your questions about your service, and look at who could help with a role.");
    await press("Ozzie's AI");
    await press("Pay $19 a month in my browser");
    expect(button("Next: open Your service")).toBeNull();
    await press("Next: open Services");
    expect(s.onDone).toHaveBeenCalledWith("chosen");
  });

  it("explains the price from the offer, then waits, then says it's on", async () => {
    const s = await mount(base({ managed_connect: PAID, set_model_route: ROUTE }));
    await press("Ozzie's AI");
    const text = seen();
    expect(text).toContain("AI that's ready to use, with nothing to set up.");
    expect(text).toContain("Personal · $19 a month");
    expect(text).toContain("About 400 answers a month. Asking Ozzie who could help with a role is one answer.");
    // S10's four lines, word for word, the refunds line among them (review M9).
    const checks = nodes().find(n => n.tagName === "UL" && n.getAttribute?.("class") === "ai-checks")!;
    expect(checks.childNodes.map(li => li.textContent)).toEqual([
      "When the month's answers run out, AI pauses until the next month. Everything else in Ozzie keeps working, and nothing extra is charged.",
      "Cancel any time. Payments aren't refunded, except where the law requires. When you cancel, Ozzie's AI keeps working until the end of the month you've paid for.",
      "Every request goes only to AI services that keep nothing, and never with the names Ozzie reads from Planning Center.",
      "For one person, on up to 3 of their Macs. Plans for teams are coming."]);
    expect(text).toContain("You'll sign in with your email (no password) and pay on Stripe's page. Paying means you agree to the terms.");
    expect(button("Back")).not.toBeNull();
    allFullSize();
    await press("Pay $19 a month in my browser");
    expect(s.calls.find(c => c.command === "managed_connect")?.args).toEqual({ plan: "personal" });
    expect(s.calls.find(c => c.command === "set_model_route")?.args).toEqual({ route: "managed", baseUrl: null, model: null });
    expect(seen()).toContain("Ozzie's AI is on. About 400 answers this month; it starts again on December 17.");
    expect(s.onModel).toHaveBeenCalledWith(true);
    await press("Next: open Services");
    expect(s.onDone).toHaveBeenCalledWith("chosen");
  });

  it("while paid but not yet on, reads the account every 5 seconds, and after 2 minutes says so calmly and keeps checking", async () => {
    vi.useFakeTimers();
    let paidNow = false;
    const s = await mount(base({ managed_connect: NONE, set_model_route: ROUTE, managed_account_now: () => paidNow ? PAID : NONE }));
    await press("Ozzie's AI"); await press("Pay $19 a month in my browser");
    expect(seen()).toContain("Payment received. Turning on Ozzie's AI…");
    const { act } = await import("react");
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(s.calls.filter(c => c.command === "managed_account_now")).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(s.calls.filter(c => c.command === "managed_account_now").length).toBeGreaterThanOrEqual(24);
    expect(seen()).toContain("Your payment went through, but Ozzie's AI isn't on yet. This can take a few minutes; Ozzie keeps checking.");
    // After 30 minutes it stops reading, and says so, with Check again still there (re-check Low).
    await act(async () => { await vi.advanceTimersByTimeAsync(30 * 60_000); });
    expect(seen()).toContain("Ozzie stopped checking after 30 minutes. If you finished paying, press Check again.");
    const stoppedAt = s.calls.filter(c => c.command === "managed_account_now").length;
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000); });
    expect(s.calls.filter(c => c.command === "managed_account_now")).toHaveLength(stoppedAt);
    paidNow = true;
    await press("Check again");
    expect(seen()).toContain("Ozzie's AI is on.");
  });

  it("offers a quiet way on while the payment is applied, and keeps checking after the screen closes (review M4)", async () => {
    vi.useFakeTimers();
    let paidNow = false;
    const s = await mount(base({ managed_connect: NONE, set_model_route: ROUTE, managed_account_now: () => paidNow ? PAID : NONE }));
    await press("Ozzie's AI"); await press("Pay $19 a month in my browser");
    expect(seen()).toContain("Payment received. Turning on Ozzie's AI…");
    s.onModel.mockClear();
    await press("Open Services (Ozzie keeps checking)");
    expect(s.onDone).toHaveBeenCalledWith("chosen");
    await unmount!(); unmount = null;
    const { act } = await import("react");
    const reads = () => s.calls.filter(c => c.command === "managed_account_now").length;
    const before = reads();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(reads()).toBeGreaterThan(before);
    expect(s.onModel).not.toHaveBeenCalled();
    paidNow = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(s.onModel).toHaveBeenCalledWith(true);
    const after = reads();
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(reads()).toBe(after);
  });

  it("waits up to an hour with a calm line after 55 minutes, says to choose Connect this Mac after paying, never cancels on Escape, and Cancel says what is still true", async () => {
    vi.useFakeTimers();
    const s = await mount(base({ managed_connect: new Promise(() => {}), managed_connect_cancel: null }));
    await press("Ozzie's AI"); await press("Pay $19 a month in my browser");
    expect(seen()).toContain("Waiting for you in your browser");
    expect(seen()).toContain("Type your email, then the code Ozzie's website emails you.");
    expect(seen()).toContain("Finish in your browser: after paying, choose Connect this Mac.");
    expect(seen()).toContain("On the page that says Payment received, choose Connect this Mac.");
    // A closed tab after paying, or a payment still being confirmed, has a way to finish from here with no new charge.
    expect(seen()).toContain("Wait until your account page shows Personal (usually a few minutes), then press Open the page again and choose Connect this Mac. You won't be charged again.");
    expect(seen()).not.toContain("Still there?");
    const { act } = await import("react");
    await act(async () => { await vi.advanceTimersByTimeAsync(54 * 60_000); });
    expect(seen()).not.toContain("Still there?");
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(seen()).toContain("Still there? Ozzie waits about 5 more minutes.");
    expect(nodes().filter(n => reactProps(n)?.onKeyDown)).toEqual([]);
    allFullSize();
    await press("Cancel");
    expect(s.calls.some(c => c.command === "managed_connect_cancel")).toBe(true);
    expect(seen()).toContain("This Mac isn't connected to Ozzie's AI.");
    expect(seen()).not.toContain("No payment was taken");
    await press("Choose another way");
    expect(seen()).toContain("How should Ozzie use AI?");
  });

  it("Open the page again re-opens the waiting attempt's own page, never a second connect; a new one only when none waits", async () => {
    let reopen: unknown = null;
    const s = await mount(base({ managed_connect: new Promise(() => {}), managed_connect_reopen: () => { if (reopen) throw reopen; return null; } }));
    await press("Ozzie's AI"); await press("Pay $19 a month in my browser");
    await press("Open the page again");
    const commands = () => s.calls.map(c => c.command);
    expect(commands().filter(c => c === "managed_connect")).toHaveLength(1);
    expect(commands()).toContain("managed_connect_reopen");
    expect(commands()).not.toContain("managed_connect_cancel");
    reopen = "browser-unavailable";
    await press("Open the page again");
    expect(seen()).toContain(paidSaid("browser-unavailable"));
    expect(commands().filter(c => c === "managed_connect")).toHaveLength(1);
    reopen = "no-attempt";
    await press("Open the page again");
    expect(commands().filter(c => c === "managed_connect")).toHaveLength(2);
  });

  it("after the hour ran out, Try again is a fresh attempt that turns Ozzie's AI on once the website gives this Mac its code (seen live 2026-11-18)", async () => {
    // The owner's first payment failed on the website; a later one went through after Ozzie had stopped waiting. Try
    // again opens the connect page again, where an account that already has Personal only chooses Connect this Mac.
    let tries = 0;
    const s = await mount(base({ managed_connect: () => { tries += 1; if (tries === 1) throw "not-finished"; return PAID; }, set_model_route: ROUTE }));
    await press("Ozzie's AI"); await press("Pay $19 a month in my browser");
    expect(seen()).toContain("Ozzie stopped waiting after an hour. If you finished paying, wait until your account page shows Personal, then press Try again and choose Connect this Mac. You won't be charged again.");
    await press("Try again");
    // A new attempt with the plan, never Open the page again for the ended one; then on, with no new screen in between.
    expect(s.calls.filter(c => c.command === "managed_connect").map(c => c.args)).toEqual([{ plan: "personal" }, { plan: "personal" }]);
    expect(s.calls.some(c => c.command === "managed_connect_reopen")).toBe(false);
    expect(seen()).toContain("Ozzie's AI is on. About 400 answers this month; it starts again on December 17.");
    expect(s.onModel).toHaveBeenCalledWith(true);
  });

  /** The same bridge mounted again, as the app keeps one bridge while its screens come and go (leaving the wait). */
  const mountAgain = async (fake: ReturnType<typeof fakeNative>) => {
    native.invoke = fake.invoke as never;
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(dom.root as unknown as Element);
    await act(async () => { root.render(React.createElement(AiChoice, { mode: "settings", onModel() {}, onDone() {}, bridge: fake.bridge })); });
    await settle();
    unmount = async () => { await act(async () => { root.unmount(); }); };
  };

  it("leaving the wait and paying again follows the wait still running: no second connect, never busy, and it ends as that wait ends (review M2)", async () => {
    let finish: (a: unknown) => void = () => {};
    const running = new Promise(resolve => { finish = resolve; });
    let connects = 0;
    const fake = fakeNative(base({ managed_connect: () => { connects += 1; if (connects > 1) throw "busy"; return running; }, set_model_route: ROUTE,
      managed_connect_reopen: null }));
    await mountAgain(fake);
    await press("Ozzie's AI"); await press("Pay $19 a month in my browser");
    expect(seen()).toContain("Waiting for you in your browser");
    // The person goes to another page; Ozzie still waits for the browser.
    await unmount!(); unmount = null;
    await mountAgain(fake);
    await press("Ozzie's AI"); await press("Pay $19 a month in my browser");
    expect(connects).toBe(1);
    expect(seen()).toContain("Waiting for you in your browser");
    expect(seen()).toContain(OZZIE.stillWaiting);
    expect(OZZIE.stillWaiting).toBe("Ozzie is still waiting for you in your browser.");
    expect(seen()).not.toContain("start fresh");
    // Open the page again acts on that wait.
    await press("Open the page again");
    expect(fake.calls.filter(c => c.command === "managed_connect_reopen")).toHaveLength(1);
    expect(connects).toBe(1);
    // The wait ends as it ends: here, connected with the plan on.
    const { act } = await import("react");
    await act(async () => { finish(PAID); await Promise.resolve(); });
    await settle();
    expect(seen()).toContain("Ozzie's AI is on.");
    expect(fake.calls.find(c => c.command === "set_model_route")?.args).toEqual({ route: "managed", baseUrl: null, model: null });
  });

  it("native busy (a wait this screen didn't start) shows that wait with true words; Open the page again and Cancel act on it; once the plan is on, it's on (review M2)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let paidNow = false;
    const s = await mount(base({ managed_connect: () => { throw "busy"; }, managed_connect_reopen: null, managed_connect_cancel: null, set_model_route: ROUTE,
      managed_account_now: () => paidNow ? PAID : NONE }));
    await press("Ozzie's AI"); await press("Pay $19 a month in my browser");
    expect(seen()).toContain("Waiting for you in your browser");
    expect(seen()).toContain("Ozzie is still waiting for you in your browser.");
    expect(button("Try again")).toBeNull();
    await press("Open the page again");
    expect(s.calls.filter(c => c.command === "managed_connect_reopen")).toHaveLength(1);
    expect(s.calls.filter(c => c.command === "managed_connect")).toHaveLength(1);
    // The person pays in the browser: the plan shows on the account, and Ozzie's AI turns on here.
    paidNow = true;
    const { act } = await import("react");
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    await settle();
    expect(seen()).toContain("Ozzie's AI is on.");
    expect(s.calls.find(c => c.command === "set_model_route")?.args).toEqual({ route: "managed", baseUrl: null, model: null });
    await unmount!(); unmount = null;
    // Cancel stops the wait that is running.
    const t = await mount(base({ managed_connect: () => { throw "busy"; }, managed_connect_cancel: null, managed_account_now: NONE }));
    await press("Ozzie's AI"); await press("Pay $19 a month in my browser");
    await press("Cancel");
    expect(t.calls.some(c => c.command === "managed_connect_cancel")).toBe(true);
    expect(seen()).toContain("This Mac isn't connected to Ozzie's AI.");
  });

  it("native busy: following that wait stops after its hour with the true ending, saying Still there? first, and reads the account no more (review 2026-11-18)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let reads = 0;
    const s = await mount(base({ managed_connect: () => { throw "busy"; }, managed_account_now: () => { reads += 1; return NONE; } }));
    await press("Ozzie's AI"); await press("Pay $19 a month in my browser");
    expect(seen()).toContain(OZZIE.stillWaiting);
    const { act } = await import("react");
    await act(async () => { await vi.advanceTimersByTimeAsync(54 * 60_000); });
    expect(seen()).not.toContain("Still there?");
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(seen()).toContain("Still there? Ozzie waits about 5 more minutes.");
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000); });
    await settle();
    expect(seen()).toContain(paidSaid("not-finished"));
    expect(button("Try again")).not.toBeNull();
    expect(button("Choose another way")).not.toBeNull();
    const after = reads;
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000); });
    expect(reads).toBe(after);
    expect(s.calls.filter(c => c.command === "managed_connect")).toHaveLength(1);
  });

  it("native busy: when Open the page again finds no wait any more, the followed wait has ended: on if the plan is, otherwise said, never a new payment (review 2026-11-18)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let paidNow = false;
    const s = await mount(base({ managed_connect: () => { throw "busy"; }, managed_connect_reopen: () => { throw "no-attempt"; }, set_model_route: ROUTE,
      managed_account_now: () => paidNow ? PAID : NONE }));
    await press("Ozzie's AI"); await press("Pay $19 a month in my browser");
    await press("Open the page again");
    await settle();
    expect(seen()).toContain(paidSaid("expired"));
    expect(s.calls.filter(c => c.command === "managed_connect")).toHaveLength(1);
    const { act } = await import("react");
    const reads = s.calls.filter(c => c.command === "managed_account_now").length;
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000); });
    expect(s.calls.filter(c => c.command === "managed_account_now")).toHaveLength(reads);
    await unmount!(); unmount = null;
    // The followed wait ended with the plan on: it's on.
    paidNow = true;
    const t = await mount(base({ managed_connect: () => { throw "busy"; }, managed_connect_reopen: () => { throw "no-attempt"; }, set_model_route: ROUTE,
      managed_account_now: () => paidNow ? PAID : NONE }));
    await press("Ozzie's AI"); await press("Pay $19 a month in my browser");
    await press("Open the page again");
    await settle();
    expect(seen()).toContain("Ozzie's AI is on.");
    expect(t.calls.filter(c => c.command === "managed_connect")).toHaveLength(1);
  });

  it("says how each attempt ended, by its closed code only, and every ending offers another way (review M4)", async () => {
    // `busy` is no ending: it is a wait still running, shown as one (review M2, above).
    for (const code of [...PAID_ENDS.filter(e => e !== "unreachable" && e !== "busy"), "something the server wrote: card_declined"]) {
      const s = await mount(base({ managed_connect: () => { throw code; } }));
      await press("Ozzie's AI"); await press("Pay $19 a month in my browser");
      const end = ((PAID_ENDS as string[]).includes(code) ? code : "unreachable") as PaidEnd;
      expect(seen(), code).toContain(paidSaid(end));
      expect(seen()).not.toContain("card_declined");
      expect(button("Try again")).not.toBeNull();
      expect(button("Choose another way"), code).not.toBeNull();
      allFullSize();
      await press("Choose another way");
      expect(seen()).toContain("How should Ozzie use AI?");
      expect(s.onDone).not.toHaveBeenCalled();
      await unmount!(); unmount = null;
    }
  });

  it("says Ozzie couldn't check, not that sign-up is closed, when the offer couldn't be read", async () => {
    await mountSettingsOzzie({ open: false, reason: "unreachable" });
    expect(seen()).toContain("Ozzie couldn't check whether Ozzie's AI is open just now. The free ways work today.");
    await unmount!(); unmount = null;
    await mountSettingsOzzie({ open: false, reason: "closed" });
    expect(seen()).toContain("Ozzie's AI isn't open for sign-up yet. The free ways work today.");
  });
});

// Live in 0.3.3, 2026-11-19: a subscriber chose AI on this Mac to try it, then Ozzie's AI again, and was shown the price and
// "Pay $19 a month in my browser". Choosing a way never ends this Mac's connection (native keeps the device token on every
// route; hosted_tests.rs pins it), and native's status reads the connection and the account whatever way is in use: here
// the fake gives that status, with fictional accounts.
describe("S10: a Mac that still holds its connection to Ozzie's AI (live, 2026-11-19)", () => {
  const PAID = { plan: "personal", allowance_steps: 1500, used_steps: 375, period_ends: "2026-12-18T00:00:00Z", warning: null, checked_at_ms: 0, offline: false, answers_left: 300 };
  const ENDED = { ...PAID, plan: "none", allowance_steps: 0, plan_reason: "cancelled" };
  const LOCAL = { configured: true, route: "local", label: "AI model on this Mac (qwen3:8b)", setup: "ready", managed: "connected", account: PAID, local_app: "ollama", checked_at_ms: 1 };
  const MANAGED = { configured: true, route: "managed", label: "x", setup: "ready", managed: "connected", account: PAID };
  const NO_ROUTE = { configured: false, route: "none", label: "No AI model set up", setup: "no-route", managed: "connected", account: PAID };
  const ozzieCard = () => buttons().find(b => /ai-card/u.test(b.getAttribute?.("class") ?? "") && b.textContent.startsWith("Ozzie's AI"))!;
  /** Every word of the sales screen and its browser trip: none of them is said to a Mac that holds the connection. */
  const PITCH = ["$19", "Pay ", "Stripe", "Personal ·", "sign in with your email", "Ready to use, nothing to set up", "in my browser"];
  /** Nothing on the way back goes to the browser, connects, disconnects or asks for a payment. */
  const NO_TRIP = ["managed_connect", "managed_connect_reopen", "managed_connect_cancel", "managed_disconnect", "open_help_page"];
  const mountSettingsWith = async (replies: Record<string, unknown>) => {
    const fake = fakeNative(replies);
    native.invoke = fake.invoke as never;
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(dom.root as unknown as Element);
    await act(async () => { root.render(React.createElement(AiSettings, { onChange() {} })); });
    await settle();
    unmount = async () => { await act(async () => { root.unmount(); }); };
    return fake;
  };

  it("back from AI on this Mac, the card says this Mac has Ozzie's AI, and using it again only switches the route back: no price, no browser", async () => {
    for (const mode of ["first-run", "settings"] as const) {
      let route: Record<string, unknown> = LOCAL;
      const s = await mount(base({ model_status: () => route, set_model_route: (a: Record<string, unknown>) => { if (a.route === "managed") route = MANAGED; return route; } }), mode);
      // The card says so in plain words in place of the price; AI on this Mac's card is the one in use.
      expect(ozzieCard().textContent).toBe("Ozzie's AIYou already have Ozzie's AI on this Mac.");
      expect(ozzieCard().getAttribute?.("aria-disabled") ?? null).toBeNull();
      expect(seen()).toContain("Your church's own AIIn use now");
      await press("Ozzie's AI");
      expect(seen()).toContain("You already have Ozzie's AI on this Mac. Switching back to it charges nothing.");
      for (const word of PITCH) expect(seen(), `${mode} ${word}`).not.toContain(word);
      expect(button("Back")).not.toBeNull();
      expect(button("Not now")).not.toBeNull();
      allFullSize();
      await press("Use Ozzie's AI again");
      // Only the route, saved on this Mac: Ozzie's AI again, on the connection it held.
      expect(s.calls.filter(c => c.command === "set_model_route").map(c => c.args)).toEqual([{ route: "managed", baseUrl: null, model: null }]);
      for (const never of NO_TRIP) expect(s.calls.some(c => c.command === never), never).toBe(false);
      expect(s.onModel).toHaveBeenCalledWith(true);
      // The account's own line, never the offer's whole month (only true just after paying).
      expect(seen()).toContain("Ozzie's AI is in use on this Mac.");
      expect(seen()).toContain("About 300 answers left this month. They start again on December 18.");
      expect(seen()).not.toContain("About 400 answers");
      await press(mode === "settings" ? "Back to Settings" : "Next: open Services");
      expect(s.onDone).toHaveBeenCalledWith("chosen");
      await unmount!(); unmount = null;
    }
  });

  it("Settings: switching away and back through the screens keeps the connection and ends on Ozzie's AI, with a way to disconnect it meanwhile", async () => {
    // Ozzie's AI in use, then No AI for now (native keeps the connection), then Ozzie's AI again.
    let route: Record<string, unknown> = MANAGED;
    const s = await mountSettingsWith({ model_status: () => route, set_no_ai: () => { route = NO_ROUTE; return route; },
      set_model_route: (a: Record<string, unknown>) => { if (a.route === "managed") route = MANAGED; return route; }, managed_offer: OFFER_OPEN, open_help_page: null });
    expect(seen()).toContain("AI: Ozzie's AI");
    // While Ozzie's AI is in use, its own Disconnect this Mac is the way, as before: no second one.
    expect(button("Disconnect this Mac")!.textContent).toBe("Disconnect this Mac");
    expect(button("Disconnect this Mac from Ozzie's AI")).toBeNull();
    await press("Change");
    await press("No AI for now");
    expect(seen()).toContain("AI: none");
    expect(seen()).toContain("This Mac is still connected to Ozzie's AI. To use it again, choose Change, then Ozzie's AI.");
    expect(button("Disconnect this Mac from Ozzie's AI")).not.toBeNull();
    await press("Change");
    expect(ozzieCard().textContent).toBe("Ozzie's AIYou already have Ozzie's AI on this Mac.");
    await press("Ozzie's AI");
    for (const word of PITCH) expect(seen(), word).not.toContain(word);
    await press("Use Ozzie's AI again");
    await press("Back to Settings");
    expect(seen()).toContain("AI: Ozzie's AI");
    expect(seen()).toContain("About 300 answers left this month. They start again on December 18.");
    expect(seen()).not.toContain("This Mac is still connected to Ozzie's AI.");
    for (const never of NO_TRIP.filter(c => c !== "open_help_page")) expect(s.calls.some(c => c.command === never), never).toBe(false);
  });

  it("with Ozzie's AI in use, its card and screen say this Mac has it and offer keeping it, never the price", async () => {
    const s = await mount(base({ model_status: MANAGED, set_model_route: MANAGED }), "settings");
    expect(ozzieCard().textContent).toBe("Ozzie's AIIn use nowYou already have Ozzie's AI on this Mac.");
    await press("Ozzie's AI");
    expect(seen()).toContain("You already have Ozzie's AI on this Mac.");
    expect(seen()).not.toContain("Switching back");
    for (const word of PITCH) expect(seen(), word).not.toContain(word);
    await press("Keep using Ozzie's AI");
    expect(seen()).toContain("Ozzie's AI is in use on this Mac.");
    for (const never of NO_TRIP) expect(s.calls.some(c => c.command === never), never).toBe(false);
  });

  it("a held connection can be used again while sign-up is closed or can't be checked: nothing is bought on the way", async () => {
    for (const offer of [{ open: false, reason: "closed" }, { open: false, reason: "unreachable" }]) {
      let route: Record<string, unknown> = LOCAL;
      const s = await mount(base({ managed_offer: offer, model_status: () => route, set_model_route: () => (route = MANAGED) }), "settings");
      expect(ozzieCard().getAttribute?.("aria-disabled") ?? null).toBeNull();
      expect(ozzieCard().textContent).toBe("Ozzie's AIYou already have Ozzie's AI on this Mac.");
      await press("Ozzie's AI");
      await press("Use Ozzie's AI again");
      expect(seen()).toContain("Ozzie's AI is in use on this Mac.");
      expect(s.calls.some(c => c.command === "managed_connect")).toBe(false);
      await unmount!(); unmount = null;
    }
  });

  it("an account Ozzie couldn't read just now: used again, and says the numbers couldn't be checked", async () => {
    const unread = { ...LOCAL, account: null };
    let route: Record<string, unknown> = unread;
    await mount(base({ model_status: () => route, set_model_route: () => (route = { ...MANAGED, account: null }) }), "settings");
    expect(ozzieCard().textContent).toBe("Ozzie's AIYou already have Ozzie's AI on this Mac.");
    await press("Ozzie's AI");
    await press("Use Ozzie's AI again");
    expect(seen()).toContain("Ozzie's AI is in use on this Mac.");
    expect(seen()).toContain("This Mac is connected. Ozzie couldn't check this month's answers just now.");
  });

  it("a new customer, or an account whose plan has ended, still sees the price and Pay exactly as before", async () => {
    const fresh = { configured: true, route: "local", label: "AI model on this Mac (qwen3:8b)", setup: "ready", managed: "not-connected", account: null };
    for (const model_status of [undefined, fresh, { ...LOCAL, account: ENDED }]) {
      const s = await mount(base({ ...(model_status ? { model_status } : {}), managed_connect: PAID, set_model_route: MANAGED }), "first-run");
      expect(ozzieCard().textContent).toBe("Ozzie's AIReady to use, nothing to set up. $19 a month for about 400 answers. Cancel any time.");
      await press("Ozzie's AI");
      expect(seen()).toContain("AI that's ready to use, with nothing to set up.");
      expect(seen()).toContain("Personal · $19 a month");
      expect(seen()).toContain("You'll sign in with your email (no password) and pay on Stripe's page. Paying means you agree to the terms.");
      expect(seen()).not.toContain("You already have Ozzie's AI");
      expect(button("Use Ozzie's AI again")).toBeNull();
      await press("Pay $19 a month in my browser");
      expect(s.calls.find(c => c.command === "managed_connect")?.args).toEqual({ plan: "personal" });
      await unmount!(); unmount = null;
    }
    // With no connection, sign-up closed still means the card can't be chosen.
    await mount(base({ managed_offer: { open: false, reason: "closed" }, model_status: fresh }));
    expect(ozzieCard().getAttribute?.("aria-disabled")).toBe("true");
  });

  it("a connection ozzie.church refused leads to connecting again, never the price, even while sign-up is closed", async () => {
    const refused = { ...LOCAL, managed: "reconnect", account: null };
    for (const offer of [OFFER_OPEN, { open: false, reason: "closed" }, { open: false, reason: "unreachable" }]) {
      const s = await mount(base({ managed_offer: offer, model_status: refused, managed_connect: PAID, set_model_route: MANAGED }), "settings");
      expect(ozzieCard().textContent).toBe("Ozzie's AIThis Mac's connection has ended. Connect it again; a plan you already have isn't charged again.");
      expect(ozzieCard().getAttribute?.("aria-disabled") ?? null).toBeNull();
      await press("Ozzie's AI");
      expect(seen()).toContain(OZZIE.reconnect);
      for (const word of ["$19", "Pay ", "Stripe"]) expect(seen(), word).not.toContain(word);
      await press("Connect this Mac again in my browser");
      // The same paid connect as before: the website charges nothing for an account that already has a plan.
      expect(s.calls.find(c => c.command === "managed_connect")?.args).toEqual({ plan: "personal" });
      await unmount!(); unmount = null;
    }
  });

  it("a connection or plan that ended since the screen opened is said, never as on, and the way in use stays (review M1)", async () => {
    const refused = { configured: true, route: "local", label: "AI model on this Mac (qwen3:8b)", setup: "ready", managed: "reconnect", account: null };
    for (const [after, says] of [[refused, OZZIE.reconnect], [{ ...LOCAL, account: ENDED }, "Personal · $19 a month"]] as const) {
      // Held when the screen opened; by the press, the reading says otherwise: the route is never touched.
      let current: Record<string, unknown> = LOCAL;
      const s = await mount(base({ model_status: () => current, set_model_route: MANAGED }), "settings");
      await press("Ozzie's AI");
      current = after;
      await press("Use Ozzie's AI again");
      expect(s.calls.some(c => c.command === "set_model_route"), says).toBe(false);
      expect(s.onModel).not.toHaveBeenCalled();
      expect(seen()).not.toContain("Ozzie's AI is in use on this Mac.");
      expect(seen()).toContain(says);
      expect(s.calls.some(c => c.command === "managed_connect")).toBe(false);
      await unmount!(); unmount = null;
    }
    // The moment between the reading and the save: the saved route's own status is checked too.
    let s = await mount(base({ model_status: LOCAL, set_model_route: { configured: false, route: "managed", label: "x", setup: "reconnect", managed: "reconnect", account: null } }), "settings");
    await press("Ozzie's AI");
    await press("Use Ozzie's AI again");
    expect(seen()).not.toContain("Ozzie's AI is in use on this Mac.");
    expect(seen()).toContain(OZZIE.reconnect);
    expect(button("Connect this Mac again in my browser")).not.toBeNull();
    await unmount!(); unmount = null;
    s = await mount(base({ model_status: LOCAL, set_model_route: { ...MANAGED, account: ENDED } }), "settings");
    await press("Ozzie's AI");
    await press("Use Ozzie's AI again");
    expect(seen()).not.toContain("Ozzie's AI is in use on this Mac.");
    expect(seen()).toContain("Personal · $19 a month");
    expect(s.calls.some(c => c.command === "managed_connect")).toBe(false);
  });

  it("until the AI status is read, neither the card nor the screen shows the price or Pay (review M3)", async () => {
    let release: (s: unknown) => void = () => {};
    const pending = new Promise(r => { release = r; });
    const s = await mount(base({ model_status: () => pending, set_model_route: MANAGED }), "settings");
    expect(ozzieCard().textContent).toBe("Ozzie's AIChecking whether it's open for sign-up…");
    expect(ozzieCard().getAttribute?.("aria-disabled")).toBe("true");
    // ("Pay an AI company…" is the church's own AI card's line.)
    for (const word of ["$19", "Pay $"]) expect(seen(), word).not.toContain(word);
    const { act } = await import("react");
    await act(async () => { release(LOCAL); });
    await settle();
    expect(ozzieCard().textContent).toBe("Ozzie's AIYou already have Ozzie's AI on this Mac.");
    await unmount!(); unmount = null;
    // S10 opened straight from Settings (its Check, Start Ozzie's AI) before the reading: Back and Not now only.
    const later = new Promise(() => {});
    const fake = fakeNative({ ...base(), model_status: () => later });
    native.invoke = fake.invoke as never;
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(dom.root as unknown as Element);
    await act(async () => { root.render(React.createElement(AiFlow, { mode: "settings", onModel() {}, onDone() {}, bridge: fake.bridge, start: { at: "ozzie" } })); });
    await settle();
    unmount = async () => { await act(async () => { root.unmount(); }); };
    expect(seen()).toContain("Checking whether it's open for sign-up…");
    for (const word of ["$19", "Pay ", "Stripe", "AI that's ready to use"]) expect(seen(), word).not.toContain(word);
    expect(buttons().map(b => b.textContent)).toEqual(["Back", "Not now"]);
    expect(s.calls.some(c => c.command === "managed_connect")).toBe(false);
  });

  it("says a paused plan before the press and after it, calmly, never as part of the success (review L3)", async () => {
    const PAUSED = { ...PAID, used_steps: 1500, warning: "paused", answers_left: 0 };
    await mount(base({ model_status: { ...LOCAL, account: PAUSED }, set_model_route: { ...MANAGED, account: PAUSED } }), "settings");
    expect(ozzieCard().textContent).toBe("Ozzie's AIYou already have Ozzie's AI on this Mac.");
    await press("Ozzie's AI");
    const pausedLine = "Ozzie's AI is paused until December 18: this month's answers are used. Everything else in Ozzie still works.";
    expect(seen()).toContain(pausedLine);
    await press("Use Ozzie's AI again");
    expect(seen()).toContain("Ozzie's AI is in use on this Mac.");
    const notice = nodes().find(n => n.getAttribute?.("class") === "ai-problem" && n.textContent.includes(pausedLine));
    expect(notice?.getAttribute?.("role")).toBe("status");
  });

  it("waits visibly while the press reads the status and saves the route, and can't be pressed twice (review L5)", async () => {
    let save: (s: unknown) => void = () => {};
    const s = await mount(base({ model_status: LOCAL, set_model_route: () => new Promise(r => { save = r; }) }), "settings");
    await press("Ozzie's AI");
    await press("Use Ozzie's AI again");
    expect(seen()).toContain("Checking this Mac's connection to Ozzie's AI…");
    expect(isDisabled(button("Use Ozzie's AI again")!)).toBe(true);
    const { act } = await import("react");
    await act(async () => { save(MANAGED); });
    await settle();
    expect(seen()).toContain("Ozzie's AI is in use on this Mac.");
    expect(s.calls.filter(c => c.command === "set_model_route")).toHaveLength(1);
  });

  it("Settings: Disconnect this Mac from Ozzie's AI, while another way is in use, ends the connection there and says the plan isn't cancelled (review M2)", async () => {
    const gone = { ...LOCAL, managed: "not-connected", account: null };
    let held = true;
    const s = await mountSettingsWith({ model_status: () => held ? LOCAL : gone, managed_disconnect: () => { held = false; return gone; }, open_help_page: null });
    expect(seen()).toContain("AI: on this Mac (qwen3:8b)");
    expect(seen()).toContain("This Mac is still connected to Ozzie's AI. To use it again, choose Change, then Ozzie's AI.");
    await press("Disconnect this Mac from Ozzie's AI");
    expect(s.calls.filter(c => c.command === "managed_disconnect")).toHaveLength(1);
    expect(seen()).toContain("This Mac is disconnected from Ozzie's AI. Your plan isn't cancelled: to stop paying for it, choose See my plan.");
    expect(seen()).not.toContain("This Mac is still connected to Ozzie's AI.");
    expect(button("Disconnect this Mac from Ozzie's AI")).toBeNull();
    await press("See my plan");
    expect(s.calls.at(-1)).toEqual({ command: "open_help_page", args: { page: "ozzie-account" } });
    // The way in use is untouched.
    expect(seen()).toContain("AI: on this Mac (qwen3:8b)");
    expect(s.calls.some(c => c.command === "set_model_route" || c.command === "set_no_ai")).toBe(false);
    await unmount!(); unmount = null;
    // An account with no plan: the plain line, no plan to stop, and never "use it again" before (review L4).
    held = true;
    const noPlan = { ...LOCAL, account: ENDED };
    await mountSettingsWith({ model_status: () => held ? noPlan : gone, managed_disconnect: () => { held = false; return gone; } });
    expect(seen()).not.toContain("To use it again");
    await press("Disconnect this Mac from Ozzie's AI");
    expect(seen()).toContain("This Mac is disconnected from Ozzie's AI.");
    expect(seen()).not.toContain("Your plan isn't cancelled");
    expect(button("See my plan")).toBeNull();
  });

  it("has words for each of these, none forbidden", () => {
    for (const w of [CHOICE.ozzieHeld, CHOICE.ozzieReconnect, OZZIE.held, OZZIE.heldFree, OZZIE.useAgain, OZZIE.keepUsing, OZZIE.switching, OZZIE.usingNow, OZZIE.heldSettings,
      OZZIE.disconnectHeld, OZZIE.disconnected, OZZIE.disconnectedPlan]) {
      expect(w).not.toMatch(FORBIDDEN);
      expect(w).not.toMatch(/\$|Pay\b|Stripe/u);
    }
  });
});

describe("the AI line and Settings", () => {
  it("shows the AI in use with a quiet Change, or Check when it's paused or not answering", () => {
    const html = (status: ModelStatus | null, small = false) => renderToStaticMarkup(React.createElement(AiLine, { status, onChange() {}, small }));
    expect(html(null)).toContain("AI: none");
    expect(html(null)).toContain(">Change</button>");
    const paused: ModelStatus = { configured: true, route: "own", label: `x ${LEAK}`, setup: "month-limit", provider: "anthropic" };
    expect(html(paused)).toContain("AI: Claude, your key<span class=\"ai-line-trouble\"> · paused</span>");
    expect(html(paused)).toContain(">Check</button>");
    expect(html(paused)).not.toContain(LEAK);
    expect(html(paused, true)).toContain("ai-line is-small");
  });

  const mountSettings = async (replies: Record<string, unknown>) => {
    const fake = fakeNative(replies);
    native.invoke = fake.invoke as never;
    const onChange = vi.fn(), onCheckSetup = vi.fn();
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(dom.root as unknown as Element);
    await act(async () => { root.render(React.createElement(AiSettings, { onChange, onCheckSetup, labelledBy: "ai-title" })); });
    await settle();
    unmount = async () => { await act(async () => { root.unmount(); }); };
    return { ...fake, onChange, onCheckSetup };
  };
  const OWN: ModelStatus = { configured: true, route: "own", label: `ChatGPT, with your key (gpt-5-mini) ${LEAK}`, setup: "ready", key_account: "own-provider:api.openai.com",
    provider: "openai", month: { used: 12, limit: 1000, resets_on: "2026-12-01" } };

  it("shows the church's own key with this month's count, changes the limit, and removes the key only after asking", async () => {
    const s = await mountSettings({ model_status: OWN, set_month_limit: ({ limit }: Record<string, unknown>) => ({ ...OWN, month: { ...OWN.month!, limit } }),
      remove_own_key: { removed: "removed", status: { configured: false, route: "none", label: "No AI model set up", setup: "no-route" } } });
    expect(s.onChange).toHaveBeenCalledWith(true);
    let text = seen();
    expect(text).toContain("AI: ChatGPT, your key");
    expect(text).toContain("12 of 1,000 AI requests used this month. The count starts again on December 1.");
    expect(text).not.toMatch(/sk-proj|own-provider|gpt-5-mini|Terminal|security add-generic-password|Copy command/u);
    allFullSize();
    await press("Change the limit");
    await type(nodes().find(n => n.tagName === "INPUT")!.getAttribute!("id")!, "50");
    await press("Save the limit");
    expect(seen()).toContain("Choose a number from 100 to 20,000.");
    await type(nodes().find(n => n.tagName === "INPUT")!.getAttribute!("id")!, "2,000");
    await press("Save the limit");
    expect(s.calls.find(c => c.command === "set_month_limit")?.args).toEqual({ limit: 2000 });
    expect(seen()).toContain("12 of 2,000 AI requests used this month.");
    await press("Remove my key from this Mac");
    expect(seen()).toContain("Remove the key from this Mac?");
    expect(seen()).toContain("Ozzie forgets the key and stops using AI. To use OpenAI again later, you'll paste a key again.");
    expect(s.calls.some(c => c.command === "remove_own_key")).toBe(false);
    await press("Yes, remove the key");
    expect(s.calls.filter(c => c.command === "remove_own_key")).toEqual([{ command: "remove_own_key", args: {} }]);
    expect(s.calls.some(c => c.command === "own_key_remove")).toBe(false);
    text = seen();
    expect(text).toContain("AI: none");
    expect(text).toContain("The key is removed from this Mac.");
  });

  it("says every company whose key it removes when more than one is kept, and offers no removal once none is (live, 2026-11-18)", async () => {
    // Three companies' keys kept, Gemini in use: removing takes all three (native `remove_own_key`), and the box says so.
    const NONE: ModelStatus = { configured: false, route: "none", label: "No AI model set up", setup: "no-route" };
    const GEMINI: ModelStatus = { ...OWN, provider: "gemini", key_account: "own-provider:generativelanguage.googleapis.com" };
    let saved = ["gemini", "openai", "anthropic"], route = GEMINI;
    const s = await mountSettings({ model_status: () => route, own_key_saved: () => saved,
      remove_own_key: () => { saved = []; route = NONE; return { removed: "removed", status: NONE }; } });
    // More than one company's key kept: the button itself says keys (review L-4; seen live with OpenAI and Anthropic).
    expect(button("Remove my key from this Mac")).toBeNull();
    await press("Remove my keys from this Mac");
    const sheet = () => nodes().find(n => n.getAttribute?.("role") === "dialog")?.textContent ?? "";
    expect(sheet()).toContain("Remove your keys from this Mac?");
    expect(sheet()).toContain("Ozzie forgets the keys for OpenAI, Anthropic and Google and stops using AI. To use one again later, you'll paste a key again.");
    expect(sheet()).not.toContain("Remove the key from this Mac?");
    expect(sheet()).not.toMatch(FORBIDDEN);
    expect(button("Keep my key")!.textContent).toBe("Keep my keys");
    expect(button("Yes, remove the key")!.textContent).toBe("Yes, remove the keys");
    expect(s.calls.some(c => c.command === "remove_own_key")).toBe(false);
    await press("Yes, remove the keys");
    expect(s.calls.filter(c => c.command === "remove_own_key")).toEqual([{ command: "remove_own_key", args: {} }]);
    expect(seen()).toContain("AI: none");
    expect(seen()).toContain("The keys are removed from this Mac.");
    // Nothing is left on this Mac after that removal, so there is nothing to remove.
    expect(button("Remove my key from this Mac")).toBeNull();
    expect(button("Remove my keys from this Mac")).toBeNull();
    await unmount!(); unmount = null;
    // No AI for now with two keys still kept (one for another company): the box names both, and doesn't say AI stops.
    saved = ["other", "openai"]; route = NONE;
    await mountSettings({ model_status: () => route, own_key_saved: () => saved, remove_own_key: { removed: "removed", status: NONE } });
    await press("Remove my keys from this Mac");
    expect(sheet()).toContain("Remove your keys from this Mac?");
    expect(sheet()).toContain("Ozzie forgets the keys for OpenAI and another AI company. To use one again later, you'll paste a key again.");
    await unmount!(); unmount = null;
    // No AI chosen and Ozzie's own list of keys empty: the way to remove one is still offered (review M3), since
    // removing also deletes keys that list can't name (one added by hand, one saved the old way, or one whose entry
    // couldn't be written). The words are the one-key words.
    saved = [];
    await mountSettings({ model_status: NONE, own_key_saved: () => saved, remove_own_key: { removed: "none", status: NONE } });
    expect(seen()).toContain("AI: none");
    expect(button("Remove my key from this Mac")).not.toBeNull();
    await press("Remove my key from this Mac");
    expect(sheet()).toContain("Remove the key from this Mac?");
    // Once a removal in this visit said there was none, it isn't offered again.
    await press("Yes, remove the key");
    expect(seen()).toContain("There's no key on this Mac.");
    expect(button("Remove my key from this Mac")).toBeNull();
    await unmount!(); unmount = null;
    // Native couldn't say which keys are kept: still offered.
    await mountSettings({ model_status: NONE, own_key_saved: () => { throw "unavailable"; } });
    expect(button("Remove my key from this Mac")).not.toBeNull();
  });

  it("offers the removal again after a removal the Mac refused, and once a new key is in use (review M3)", async () => {
    const NONE: ModelStatus = { configured: false, route: "none", label: "No AI model set up", setup: "no-route" };
    let route: ModelStatus = NONE, removed = "refused";
    const s = await mountSettings({ model_status: () => route, own_key_saved: [], set_no_ai: () => { route = NONE; return NONE; }, managed_offer: { open: false },
      own_key_providers: PROVIDERS, own_key_forget: null, own_key_enter: () => { route = OWN; return { verdict: "works", status: OWN }; },
      remove_own_key: () => ({ removed, status: NONE }) });
    // The Mac refused: the key may still be there, so the way to remove it stays.
    await press("Remove my key from this Mac");
    await press("Yes, remove the key");
    expect(seen()).toContain(LIMIT.removeRefused);
    expect(button("Remove my key from this Mac")).not.toBeNull();
    // Removed this time: gone from this visit.
    removed = "removed";
    await press("Remove my key from this Mac");
    await press("Yes, remove the key");
    expect(seen()).toContain("The key is removed from this Mac.");
    expect(button("Remove my key from this Mac")).toBeNull();
    // A new key in use, then No AI for now: that key is on this Mac again, so the way to remove it is back.
    await press("Change");
    await press("Your church's own AI"); await press("A key from an AI company"); await press("ChatGPT (OpenAI)");
    await press("Paste my key");
    await press("Back to Settings");
    expect(seen()).toContain("AI: ChatGPT, your key");
    await press("Change");
    await press("No AI for now");
    expect(seen()).toContain("AI: none");
    expect(button("Remove my key from this Mac")).not.toBeNull();
    expect(s.calls.filter(c => c.command === "remove_own_key")).toHaveLength(2);
  });

  it("keeps today's words when exactly one company's key is kept, and drops the way to remove it once it's gone", async () => {
    const NONE: ModelStatus = { configured: false, route: "none", label: "No AI model set up", setup: "no-route" };
    let saved = ["openai"], route: ModelStatus = OWN;
    await mountSettings({ model_status: () => route, own_key_saved: () => saved,
      remove_own_key: () => { saved = []; route = NONE; return { removed: "removed", status: NONE }; } });
    await press("Remove my key from this Mac");
    expect(seen()).toContain("Remove the key from this Mac?");
    expect(seen()).toContain("Ozzie forgets the key and stops using AI. To use OpenAI again later, you'll paste a key again.");
    expect(button("Keep my key")!.textContent).toBe("Keep my key");
    expect(button("Yes, remove the key")!.textContent).toBe("Yes, remove the key");
    await press("Yes, remove the key");
    expect(seen()).toContain("AI: none");
    expect(seen()).toContain("The key is removed from this Mac.");
    expect(button("Remove my key from this Mac")).toBeNull();
  });

  it("after a key from another company works, says the earlier key is still kept on this Mac (contract item 10)", async () => {
    let route: ModelStatus = OWN;
    const CLAUDE: ModelStatus = { ...OWN, provider: "anthropic", key_account: "own-provider:api.anthropic.com" };
    await mountSettings({ model_status: () => route, own_key_providers: PROVIDERS, managed_offer: { open: false }, own_key_forget: null,
      own_key_enter: () => { route = CLAUDE; return { verdict: "works", status: CLAUDE }; } });
    await press("Change");
    await press("Your church's own AI"); await press("A key from an AI company"); await press("Claude (Anthropic)");
    await press("Paste my key");
    await press("Back to Settings");
    expect(seen()).toContain("Your OpenAI key is still kept on this Mac. You can remove it in Settings.");
    expect(seen()).toContain("AI: Claude, your key");
  });

  it("offers removing a key with no AI chosen only while one is kept, by native's count from the Keychain's list (review L-4)", async () => {
    const NONE: ModelStatus = { configured: false, route: "none", label: "No AI model set up", setup: "no-route" };
    // No key of the church's own on this Mac (a church that never saved one): nothing to remove, so nothing offered.
    const s = await mountSettings({ model_status: NONE, own_key_saved: [], own_key_count: 0 });
    expect(seen()).toContain("AI: none");
    expect(button("Remove my key from this Mac")).toBeNull();
    expect(button("Remove my keys from this Mac")).toBeNull();
    expect(s.calls.filter(c => c.command === "own_key_count")).toEqual([{ command: "own_key_count", args: {} }]);
    await unmount!(); unmount = null;
    // One kept that Ozzie's own list can't name (added by hand): offered, in the one-key words.
    await mountSettings({ model_status: NONE, own_key_saved: [], own_key_count: 1 });
    expect(button("Remove my key from this Mac")).not.toBeNull();
    await unmount!(); unmount = null;
    // Two kept: the button says keys, though Ozzie's own list names only one of them.
    await mountSettings({ model_status: NONE, own_key_saved: ["openai"], own_key_count: 2 });
    expect(button("Remove my keys from this Mac")).not.toBeNull();
    await unmount!(); unmount = null;
    // The Keychain couldn't list them (or this build can't count): still offered, as before.
    await mountSettings({ model_status: NONE, own_key_saved: [], own_key_count: () => { throw "unavailable"; } });
    expect(button("Remove my key from this Mac")).not.toBeNull();
    await unmount!(); unmount = null;
    await mountSettings({ model_status: NONE, own_key_saved: [], own_key_count: "2" });
    expect(button("Remove my key from this Mac")).not.toBeNull();
  });

  it("says each way removing the key can end: none there, or the Mac refused and nothing else changed", async () => {
    const NONE: ModelStatus = { configured: false, route: "none", label: "No AI model set up", setup: "no-route" };
    for (const [reply, said] of [[{ removed: "none", status: NONE }, LIMIT.removeNone], [{ removed: "refused", status: NONE }, LIMIT.removeRefused],
      [() => { throw "unavailable"; }, LIMIT.removeFailed]] as const) {
      await mountSettings({ model_status: NONE, remove_own_key: reply });
      // With no AI chosen, a key may still be on this Mac: it can be removed from here.
      await press("Remove my key from this Mac");
      expect(seen()).toContain("Ozzie forgets any key of your church's that it kept on this Mac.");
      await press("Yes, remove the key");
      expect(seen()).toContain(said);
      await unmount!(); unmount = null;
    }
    expect(LIMIT.removeNone).toBe("There's no key on this Mac.");
    expect(LIMIT.removeRefused).toBe("This Mac didn't let Ozzie remove the key. Unlock this Mac, then try again. Nothing else changed.");
  });

  it("No AI for now from Settings sets no route and says what stays, never removing the key by itself", async () => {
    const NONE: ModelStatus = { configured: false, route: "none", label: "No AI model set up", setup: "no-route" };
    let route: ModelStatus = OWN;
    let s = await mountSettings({ model_status: () => route, set_no_ai: () => { route = NONE; return NONE; }, managed_offer: { open: false }, open_help_page: null });
    await press("Change");
    await press("No AI for now");
    expect(s.calls.some(c => c.command === "set_no_ai")).toBe(true);
    expect(s.calls.some(c => ["remove_own_key", "own_key_remove"].includes(c.command))).toBe(false);
    expect(seen()).not.toContain("Remove the key from this Mac?");
    expect(seen()).toContain("Ozzie won't use AI now. Your key is still on this Mac. To remove it, choose Remove my key from this Mac.");
    await unmount!(); unmount = null;
    const PAIDUP: ModelStatus = { configured: true, route: "managed", label: "x", setup: "ready", managed: "connected",
      account: { plan: "personal", allowance_steps: 1500, used_steps: 0, period_ends: "2026-12-17T00:00:00Z", warning: null, checked_at_ms: 0, offline: false } };
    route = PAIDUP;
    s = await mountSettings({ model_status: () => route, set_no_ai: () => { route = NONE; return NONE; }, managed_offer: { open: false }, open_help_page: null });
    await press("Change");
    await press("No AI for now");
    expect(seen()).toContain("Ozzie won't use AI now. Your plan for Ozzie's AI isn't cancelled: to stop paying for it, choose See my plan.");
    await press("See my plan");
    expect(s.calls.at(-1)).toEqual({ command: "open_help_page", args: { page: "ozzie-account" } });
  });

  it("after No AI for now, says the keys still on this Mac in the same number as the removal beside it (live, 2026-11-18)", async () => {
    const NONE: ModelStatus = { configured: false, route: "none", label: "No AI model set up", setup: "no-route" };
    // OpenAI and Anthropic kept, OpenAI in use: "keys", as the link says.
    let route: ModelStatus = OWN;
    await mountSettings({ model_status: () => route, set_no_ai: () => { route = NONE; return NONE; }, own_key_saved: ["openai", "anthropic"], own_key_count: 2,
      managed_offer: { open: false } });
    await press("Change");
    await press("No AI for now");
    expect(seen()).toContain("Ozzie won't use AI now. Your keys are still on this Mac. To remove them, choose Remove my keys from this Mac.");
    expect(seen()).not.toContain("Your key is still on this Mac");
    expect(button("Remove my keys from this Mac")).not.toBeNull();
    await unmount!(); unmount = null;
    // One key kept: the words as before, and the link agrees.
    route = OWN;
    await mountSettings({ model_status: () => route, set_no_ai: () => { route = NONE; return NONE; }, own_key_saved: ["openai"], own_key_count: 1,
      managed_offer: { open: false } });
    await press("Change");
    await press("No AI for now");
    expect(seen()).toContain("Ozzie won't use AI now. Your key is still on this Mac. To remove it, choose Remove my key from this Mac.");
    expect(button("Remove my key from this Mac")).not.toBeNull();
    expect(LIMIT.noneOwn(false)).toBe("Ozzie won't use AI now. Your key is still on this Mac. To remove it, choose Remove my key from this Mac.");
  });

  it("says the monthly pause with Change the limit and Check my setup, and offers Paste my key when the key is missing", async () => {
    let s = await mountSettings({ model_status: { ...OWN, setup: "month-limit", month: { used: 1000, limit: 1000, resets_on: "2026-12-01" } } });
    expect(seen()).toContain("AI has paused on this Mac until December 1, as your monthly limit says. Everything else in Ozzie still works.");
    expect(button("Change the limit")).not.toBeNull();
    await press("Check my setup");
    expect(s.onCheckSetup).toHaveBeenCalled();
    await unmount!(); unmount = null;
    s = await mountSettings({ model_status: { ...OWN, configured: false, setup: "own-key-not-bound" }, managed_offer: OFFER_OPEN, own_key_providers: PROVIDERS });
    expect(seen()).toContain("A key saved the old way, in Terminal, isn't tied to the company's address");
    await press("Paste my key");
    expect(seen()).toContain("Use ChatGPT's company, OpenAI");
    expect(seen()).not.toContain("One more choice (optional)");
  });

  it("never says AI on this Mac is in use before it answered the check, and opens Change on the same screens as first run", async () => {
    await mountSettings({ model_status: { configured: false, route: "local", label: "AI model on this Mac (llama3.2:latest)", setup: "not-checked", checked_at_ms: null }, managed_offer: { open: false } });
    expect(seen()).toContain("AI: on this Mac (llama3.2) · not checked yet");
    expect(seen()).toContain("AI on this Mac is chosen, but Ozzie hasn't checked that it answers yet.");
    expect(seen()).not.toContain("In use");
    await press("Check");
    expect(seen()).toContain("AI on this Mac");
    await unmount!(); unmount = null;
    await mountSettings({ model_status: { configured: false, route: "none", label: "No AI model set up", setup: "no-route" }, managed_offer: { open: false } });
    expect(seen()).toContain("AI: none");
    await press("Change");
    expect(seen()).toContain("How should Ozzie use AI?");
    expect(button("Ozzie's AI")!.getAttribute?.("aria-disabled")).toBe("true");
  });
});

describe("the key never touches the page (review M8)", () => {
  const SRC = new URL("../src/", import.meta.url);
  const files = (readdirSync(SRC, { recursive: true }) as string[]).filter(f => /\.(?:ts|tsx)$/u.test(f));
  const strip = (code: string) => code.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/(^|[^:"'`])\/\/.*$/gmu, "$1");
  it("never reads the clipboard in any page file: only native does", () => {
    expect(files.length).toBeGreaterThan(50);
    for (const f of files) {
      const code = strip(readFileSync(new URL(f, SRC), "utf8"));
      expect(code, f).not.toMatch(/clipboard\s*\??\.\s*read(?:Text)?\s*\(|\breadText\s*\(|execCommand\(\s*["']paste|["']paste["']\s*,/u);
    }
  });
  it("never keeps anything key-like in localStorage or sessionStorage, and the AI screens use neither", () => {
    const KEYLIKE = /api[_-]?key|apikey|secret|token|password|credential|bearer|sk-|own[_-]?key|key_?account/iu;
    for (const f of files) {
      const code = strip(readFileSync(new URL(f, SRC), "utf8"));
      for (const line of code.split("\n").filter(l => /(?:local|session)Storage|\.setItem\s*\(/u.test(l))) expect(line, f).not.toMatch(KEYLIKE);
      expect(code, f).not.toMatch(/sessionStorage/u);
      if (/^(?:ai-|onboarding-bridge)/u.test(f)) expect(code, f).not.toMatch(/localStorage|\.setItem\s*\(/u);
    }
  });
});

describe("every AI screen's words", () => {
  it("use none of the retired or forbidden words", async () => {
    const screens: string[] = [];
    await mount(base({ open_help_page: null, own_key_enter: { verdict: "refused" } }));
    screens.push(seen());
    await press("Your church's own AI"); screens.push(seen());
    await press("A key from an AI company"); screens.push(seen());
    await press("Gemini (Google)"); screens.push(seen());
    await press("Paste my key"); screens.push(seen());
    await press("Back"); await press("Back"); await press("AI on this Mac"); screens.push(seen());
    await press("Back"); await press("Back"); await press("Ozzie's AI"); screens.push(seen());
    for (const text of screens) expect(text).not.toMatch(FORBIDDEN);
  });
});

describe("re-check Lows on the key guide", () => {
  it("every drawing has a visible caption that it is a drawing, and Google's note is a paraphrase, said as one", () => {
    expect(KEY.drawingCaption).toBe("A drawing of the page. Yours may look a little different.");
    const own = readFileSync(new URL("../src/ai-own-key.tsx", import.meta.url), "utf8");
    expect(own).toMatch(/<StepDrawing[^>]*\/>\s*<p className="ai-small ai-caption">\{KEY\.drawingCaption\}<\/p>/u);
    const google = KEY.steps("gemini", { free_plan_not_for_church_data: true, free_plan_line: "On the free plan, Google may use what the app sends to improve its products." } as never).find(st => st.page === "billing")!;
    expect(google.note).toBe("Google's terms say, in short: On the free plan, Google may use what the app sends to improve its products.");
  });
});

describe("re-check Low: a day's limit says when it ends, in Ask and in rewording", () => {
  it("Ask: today's allowance, with the time the account gives when it gives one; rewording: today's limit", async () => {
    const { askFailureText } = await import("../src/harness-words.js");
    const { modelProblem } = await import("../src/model.js");
    const { dailyLimitEnds } = await import("../src/model.js");
    expect(askFailureText(null, "daily-limit", "tomorrow, 7:00 PM")).toBe("Ozzie has reached today's allowance for AI help, so it didn't ask the AI. Everything else still works, and it can ask again from tomorrow, 7:00 PM.");
    // Without the account's time, the day's limit still ends after midnight UTC (native model.rs DailyLimit): in the
    // afternoon in Chicago that is this evening, never "tomorrow" (the coordinator's sentence, made true).
    expect(dailyLimitEnds(Date.UTC(2026, 10, 17, 21, 0), "America/Chicago")).toBe("today, 6:00 PM");
    expect(dailyLimitEnds(Date.UTC(2026, 10, 18, 2, 0), "America/Chicago")).toBe("tomorrow, 6:00 PM");
    expect(askFailureText(null, "daily-limit")).toMatch(/^Ozzie has reached today's allowance for AI help, so it didn't ask the AI\. Everything else still works, and it can ask again from (?:today|tomorrow), \d{1,2}:\d{2} [AP]M\.$/u);
    expect(modelProblem("daily-limit")).toMatch(/^Ozzie's AI has reached today's limit\. It starts again (?:today|tomorrow), \d{1,2}:\d{2} [AP]M\. Your draft is unchanged\.$/u);
    expect(modelProblem("daily-limit", { plan: "personal", allowance_steps: 1500, used_steps: 10, period_ends: "2026-12-01T00:00:00Z", warning: null, checked_at_ms: 1, offline: false, paused_until: new Date(Date.now() + 3_600_000).toISOString() })).toMatch(/It starts again (?:today|tomorrow), /u);
  });
});

describe("native's new key verdicts (checked against each company's docs, 2026-11-17)", () => {
  it("says what each means and what to do, with the right button, and never that the key wasn't accepted", () => {
    const say = (v: KeyVerdict, p: "openai" | "anthropic" | "gemini" | "other" = "openai") => keySaid(v, p)!;
    expect(say("admin-key").text).toBe("That's an admin key. It can't be used for AI requests. Make a regular key on OpenAI's keys page.");
    expect(say("admin-key").extra).toEqual({ label: "Open OpenAI's keys page", page: "keys" });
    expect(say("region").text).toBe("OpenAI isn't available from where this Mac connects. If you use a VPN, turn it off and try again.");
    expect(say("region").again).toBe(true);
    expect(say("restricted-key").text).toBe("This key is limited and can't ask for answers. Make a new key and leave its permissions on All.");
    expect(say("restricted-key").extra).toEqual({ label: "Open OpenAI's keys page", page: "keys" });
    expect(say("provider-busy", "anthropic").text).toBe("Anthropic is busy right now. Your key was not checked. Try again in a minute.");
    expect(say("provider-busy", "anthropic").again).toBe(true);
    expect(say("needs-project-setup", "gemini").text).toBe("Google needs you to finish setting up this project before the key works. Open Google's API keys page and follow what it asks.");
    expect(say("needs-project-setup", "gemini").extra).toEqual({ label: "Open Google's keys page", page: "keys" });
    expect(say("needs-project-setup", "gemini").again).toBe(true);
    // Review F3: Google may issue only this kind of key now, so no "make a new key"; the ways on are another company or this Mac.
    expect(say("auth-conflict", "gemini").text).toBe("Google didn't accept this kind of key at the address Ozzie uses. For now, choose another company, or AI on this Mac.");
    expect(say("auth-conflict", "gemini").extra).toBeNull();
    expect(say("auth-conflict", "gemini").elsewhere).toBe(true);
    expect(say("auth-conflict", "gemini").again).toBe(false);
    // Review F2: Google's free plan isn't offered in this country.
    expect(say("needs-billing", "gemini").text).toBe("Google's free plan isn't offered in your country. Turn on billing for this project, then press Check this key again.");
    expect(say("needs-billing", "gemini").extra).toEqual({ label: "Open Google's billing page", page: "billing" });
    expect(say("needs-billing", "gemini").again).toBe(true);
    // Contract 14: OpenAI says the account must belong to an organization.
    expect(say("needs-organization", "openai").text).toBe("Your OpenAI account isn't set up to use keys yet. On OpenAI's site, finish creating or joining an organization, then press Check this key again.");
    expect(say("needs-organization", "openai").extra).toEqual({ label: "Open OpenAI's settings", page: "settings" });
    expect(say("needs-organization", "openai").again).toBe(true);
    // Contract 14: xAI and Groq keys are named, with no "Use it with" button (Ozzie has no card for them).
    expect(keySaid("wrong-kind", "openai", "xai")?.text).toBe("This looks like an xAI key, not an OpenAI key. To use it, go back, choose Another AI company, and give xAI's address.");
    expect(keySaid("wrong-kind", "anthropic", "groq")?.text).toBe("This looks like a Groq key, not an Anthropic key. To use it, go back, choose Another AI company, and give Groq's address.");
    expect(keySaid("wrong-kind", "anthropic", "groq")?.extra).toBeNull();
    expect(parseKeyResult({ verdict: "wrong-kind", provider: "openai", looks_like: "xai" })).toEqual({ verdict: "wrong-kind", looks_like: "xai" });
    expect(parseKeyResult({ verdict: "wrong-kind", provider: "openai", looks_like: "groq" })).toEqual({ verdict: "wrong-kind", looks_like: "groq" });
    for (const v of ["admin-key", "region", "restricted-key", "provider-busy", "needs-project-setup", "auth-conflict"] as const) {
      for (const p of ["openai", "anthropic", "gemini", "other"] as const) {
        const t = keySaid(v, p)!.text;
        expect(t, `${v} ${p}`).not.toMatch(/didn't accept this key|undefined/u);
        // Another AI company has no pages of Ozzie's to open.
        if (p === "other") expect(keySaid(v, p)!.extra, `${v} other`).toBeNull();
      }
    }
    // Only if native's own question was skipped (contract 13): nothing was sent, and it says what to do.
    expect(say("confirm-unknown-shape", "gemini").text).toBe("This doesn't look like the Google keys Ozzie knows, so it wasn't sent. Copy the key from Google's API keys page and try again.");
    expect(say("confirm-unknown-shape", "gemini").extra).toEqual({ label: "Open Google's keys page", page: "keys" });
    // Native's wire names are closed words: these come through, anything else is "unavailable".
    for (const v of ["admin-key", "region", "restricted-key", "provider-busy", "needs-project-setup", "auth-conflict", "confirm-unknown-shape", "needs-billing", "needs-organization"] as const)
      expect(parseKeyResult({ verdict: v, provider: "openai" })).toEqual({ verdict: v });
  });
});

describe("review F3: a kind of Google key Ozzie's address doesn't take", () => {
  const toCompany = async () => { await press("Your church's own AI"); await press("A key from an AI company"); };
  it("offers the company list and AI on this Mac, and nothing about making a new key", async () => {
    await mount(base({ own_key_paste: { verdict: "auth-conflict", provider: "gemini" } }));
    await toCompany(); await press("Gemini (Google)"); await press("Paste my key");
    expect(seen()).toContain("Google didn't accept this kind of key at the address Ozzie uses. For now, choose another company, or AI on this Mac.");
    expect(button("Check this key again")).toBeNull();
    expect(button("Open Google's keys page")).not.toBeNull(); // the guide's own step 3 button, not the problem's
    await press("Choose another company");
    expect(seen()).toContain("Which AI company?");
    await press("Gemini (Google)"); await press("Paste my key");
    await press("Use AI on this Mac");
    expect(seen()).toContain("AI on this Mac");
  });
});


describe("review 2026-11-18: a check overtaken by another choice, sign-in tokens, admin keys by company, a small window", () => {
  it("says a key check overtaken by another choice switched nothing and kept nothing", () => {
    expect(keySaid("choice-changed", "openai")?.text).toBe("The key works, but you chose something else while Ozzie was checking it, so Ozzie didn't switch to OpenAI and didn't keep the key. To use it, paste it again.");
    expect(keySaid("choice-changed", "other")?.text).toBe("The key works, but you chose something else while Ozzie was checking it, so Ozzie didn't switch to the AI company and didn't keep the key. To use it, paste it again.");
    expect(keySaid("choice-changed", "anthropic")?.again).toBe(false);
    expect(keySaid("choice-changed", "anthropic")?.extra).toBeNull();
    expect(parseKeyResult({ verdict: "choice-changed", provider: "openai", status: { configured: true } })).toEqual({ verdict: "choice-changed" });
  });

  it("says a check on this Mac overtaken by another choice switched nothing", async () => {
    const said = localSaid("choice-changed", "ollama", "qwen3:8b", "Sunday");
    expect(said).toEqual({ tone: "problem", lines: ["qwen3:8b answers, but you chose something else while Ozzie was checking it, so Ozzie didn't switch to it. To use it, press Check that it answers again."] });
    const { parseLocalCheck } = await import("../src/onboarding-bridge.js");
    expect(parseLocalCheck({ verdict: "choice-changed", seconds: 9, status: { configured: true } })).toEqual({ verdict: "choice-changed" });
  });

  it("names an Anthropic sign-in token as what it is, never as a key cut short (review L-3b)", () => {
    expect(keySaid("sign-in-token", "anthropic")?.text).toBe("That's a sign-in token from Claude, not a key for apps. Nothing was sent. Make a key on Anthropic's keys page, then paste it here.");
    expect(keySaid("sign-in-token", "anthropic")?.extra).toEqual({ label: "Open Anthropic's keys page", page: "keys" });
    expect(keySaid("sign-in-token", "other")?.text).toBe("That's a sign-in token from Claude, not a key for apps. Nothing was sent. Make a key on Anthropic's keys page, then paste it here.");
    expect(keySaid("sign-in-token", "other")?.extra).toBeNull();
    expect(keySaid("sign-in-token", "anthropic")!.text).not.toMatch(/whole key|Copy it again/u);
  });

  it("names the company whose admin key it is on Another AI company (review L-3a)", () => {
    expect(keySaid("admin-key", "other", "openai")?.text).toBe("That's an OpenAI admin key. It can't be used for AI requests. Make a regular key on OpenAI's keys page.");
    expect(keySaid("admin-key", "other", "anthropic")?.text).toBe("That's an Anthropic admin key. It can't be used for AI requests. Make a regular key on Anthropic's keys page.");
    expect(keySaid("admin-key", "other", "anthropic")?.extra).toBeNull();
    expect(keySaid("admin-key", "other")!.text).not.toContain("the company's keys page");
    // On the company's own card, the words are as before.
    expect(keySaid("admin-key", "openai", "openai")?.text).toBe("That's an admin key. It can't be used for AI requests. Make a regular key on OpenAI's keys page.");
    // Native names the company with admin-key now; only a company Ozzie offers comes through.
    expect(parseKeyResult({ verdict: "admin-key", provider: "other", looks_like: "anthropic" })).toEqual({ verdict: "admin-key", looks_like: "anthropic" });
    expect(parseKeyResult({ verdict: "admin-key", provider: "other", looks_like: "xai" })).toEqual({ verdict: "admin-key" });
    expect(parseKeyResult({ verdict: "admin-key", provider: "other", looks_like: "api.example.com" })).toEqual({ verdict: "admin-key" });
  });

  it("keeps a passing check's success and adds how to give the model more room when the app gave it little (B-2)", async () => {
    const ollama = localSaid("answers", "ollama", "qwen3:8b", "Sunday", 30, true);
    expect(ollama.tone).toBe("ok");
    expect(ollama.lines).toEqual(["It answers. A typical answer took 30 seconds on this Mac.", "Ozzie will use qwen3:8b on this Mac. Nothing leaves this Mac."]);
    expect(ollama.advice).toBe("Ollama gives this model less room than Ozzie's longer questions need, so those could be cut short. To give it room, set Context length to 8k or more in Ollama's Settings.");
    expect(localSaid("answers", "lm-studio", "qwen/qwen3-8b", "Sunday", 30, true).advice).toBe("LM Studio gives this model less room than Ozzie's longer questions need, so those could be cut short. To give it room, in LM Studio's My Models, press the gear next to this model, set its context length to 8192 or more, then load the model again.");
    // Room enough, or the app doesn't say: nothing extra.
    expect(localSaid("answers", "ollama", "qwen3:8b", "Sunday", 30).advice).toBeUndefined();
    expect(localSaid("answers", "ollama", "qwen3:8b", "Sunday", 30, false).advice).toBeUndefined();
    for (const app of ["ollama", "lm-studio"] as const) expect(localSaid("answers", app, "x", "Sunday", 3, true).advice).not.toMatch(FORBIDDEN);
    const { parseLocalCheck } = await import("../src/onboarding-bridge.js");
    expect(parseLocalCheck({ verdict: "answers", seconds: 30, small_room: true })).toEqual({ verdict: "answers", seconds: 30, small_room: true });
    expect(parseLocalCheck({ verdict: "answers", seconds: 30, small_room: false })).toEqual({ verdict: "answers", seconds: 30 });
    expect(parseLocalCheck({ verdict: "answers", seconds: 30, small_room: "yes" })).toEqual({ verdict: "answers", seconds: 30 });
    expect(parseLocalCheck({ verdict: "small-context", small_room: true })).toEqual({ verdict: "small-context" });
  });
});

describe("live in the release app, 2026-11-18: a kept key, the Ask panel over the AI screens", () => {
  const toCompanies = async () => { await press("Your church's own AI"); await press("A key from an AI company"); };
  const WORKS = { verdict: "works", provider: "anthropic", looks_like: null, status: { configured: true, route: "own", label: "Claude", provider: "anthropic" } };
  const cards = () => buttons().filter(b => /ai-card/u.test(b.getAttribute?.("class") ?? "")).map(b => b.textContent);

  it("marks the companies with a key on this Mac, leads with Use the key already on this Mac, and checks it natively", async () => {
    const s = await mount(base({ own_key_saved: ["openai", "anthropic"], own_key_use_kept: WORKS }));
    await toCompanies();
    expect(cards()).toEqual(expect.arrayContaining([expect.stringMatching(/^ChatGPT \(OpenAI\)Easiest to startKey on this Mac/u),
      expect.stringMatching(/^Claude \(Anthropic\)Key on this Mac/u), expect.stringMatching(/^Gemini \(Google\)Pay as you go/u)]));
    await press("Claude (Anthropic)");
    expect(seen()).toContain("A key for Anthropic is already on this Mac. Ozzie can check that it still works and use it.");
    // It leads as the one primary; the guide and a different key stay below.
    expect(button("Use the key already on this Mac")!.getAttribute?.("class")).toContain("btn-primary");
    expect(button("Paste a different key")!.getAttribute?.("class")).toContain("btn-secondary");
    expect(button("Paste my key")).toBeNull();
    expect(button("Open Anthropic's keys page")).not.toBeNull();
    await press("Use the key already on this Mac");
    // Only the company's closed id goes to native; no key comes back or is shown.
    expect(s.calls.find(c => c.command === "own_key_use_kept")).toEqual({ command: "own_key_use_kept", args: { provider: "anthropic" } });
    expect(seen()).toContain("It works. Ozzie will use your Anthropic account. The key is kept safely on this Mac.");
    expect(s.onModel).toHaveBeenCalledWith(true);
    expect(button("Next: open")).not.toBeNull();
    expect(seen()).not.toContain(LEAK);
  });

  it("a kept key that no longer works says so in the company's words, and Paste a different key stays", async () => {
    const s = await mount(base({ own_key_saved: ["anthropic"], own_key_use_kept: { verdict: "refused", provider: "anthropic" }, own_key_enter: { verdict: "cancelled" } }));
    await toCompanies(); await press("Claude (Anthropic)");
    await press("Use the key already on this Mac");
    expect(seen()).toContain("Anthropic no longer accepts the key on this Mac. Make a new key on Anthropic's keys page, then press Paste a different key.");
    expect(s.onModel).not.toHaveBeenCalled();
    await press("Paste a different key");
    expect(s.calls.at(-1)?.command).toBe("own_key_enter");
    await unmount!(); unmount = null;
    // Chosen something else meanwhile: nothing switched, and the key is said to stay (it was kept before).
    await mount(base({ own_key_saved: ["anthropic"], own_key_use_kept: { verdict: "choice-changed", provider: "anthropic" } }));
    await toCompanies(); await press("Claude (Anthropic)");
    await press("Use the key already on this Mac");
    expect(seen()).toContain("The key on this Mac works, but you chose something else while Ozzie was checking it, so Ozzie didn't switch to Anthropic. The key stays on this Mac.");
    expect(seen()).not.toContain("didn't keep the key");
    await unmount!(); unmount = null;
    // None kept any more: said, and the screen goes back to Paste my key.
    await mount(base({ own_key_saved: ["anthropic"], own_key_use_kept: { verdict: "no-kept-key", provider: "anthropic" } }));
    await toCompanies(); await press("Claude (Anthropic)");
    await press("Use the key already on this Mac");
    expect(seen()).toContain("There's no Anthropic key on this Mac any more. Make one on Anthropic's keys page, then press Paste my key.");
    expect(button("Use the key already on this Mac")).toBeNull();
    expect(button("Paste my key")!.getAttribute?.("class")).toContain("btn-primary");
  });

  it("after a working check, the success line and the way back sit together at the top, the guide folds away, and a different key is one press away", async () => {
    const order = (texts: string[]) => texts.map(t => nodes().findIndex(n => n.textContent.startsWith(t) && !n.childNodes.some(c => c.textContent.startsWith(t))));
    for (const how of ["kept", "pasted"] as const) {
      const s = await mount(base({ own_key_saved: how === "kept" ? ["anthropic"] : [], own_key_use_kept: WORKS, own_key_enter: WORKS }));
      await toCompanies(); await press("Claude (Anthropic)");
      await press(how === "kept" ? "Use the key already on this Mac" : "Paste my key");
      const works = "It works. Ozzie will use your Anthropic account. The key is kept safely on this Mac.";
      expect(seen()).toContain(works);
      // Success, then its button, then the folded guide: the button is no longer far down the page.
      const [line, next, folded] = order([works, "Next: open", "See the steps again"]);
      expect(line, how).toBeGreaterThan(-1);
      expect(next, how).toBeGreaterThan(line!);
      expect(folded, how).toBeGreaterThan(next!);
      const details = nodes().find(n => n.tagName === "DETAILS")!;
      expect(details.getAttribute?.("open") ?? null, how).toBeNull();
      expect(all(details).some(n => n.textContent.startsWith("Sign in at Anthropic's developer site"))).toBe(true);
      // The success is said once, and nothing asks for a key that already works.
      expect(seen().split(works).length - 1, how).toBe(1);
      expect(button("Paste my key")).toBeNull();
      expect(button("Use the key already on this Mac")).toBeNull();
      expect(seen()).not.toContain(KEY.askWindow);
      // A different key stays reachable, and asks native for one.
      const calls = s.calls.length;
      await press("Paste a different key");
      expect(s.calls.slice(calls).some(c => c.command === "own_key_enter")).toBe(true);
      await unmount!(); unmount = null;
    }
  });

  it("with no key kept for a company, its screen is as before", async () => {
    await mount(base({ own_key_saved: ["openai"] }));
    await toCompanies(); await press("Claude (Anthropic)");
    expect(button("Use the key already on this Mac")).toBeNull();
    expect(button("Paste my key")!.getAttribute?.("class")).toContain("btn-primary");
    expect(seen()).not.toContain("already on this Mac");
  });

  it("the Ask panel's Choose how Ozzie uses AI closes the panel as it opens the AI screens; elsewhere the button only opens them", async () => {
    const { AskPanel } = await import("../src/ask-panel.js");
    const { ChooseAiButton, ChooseAiContext } = await import("../src/ai-line.js");
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const happened: string[] = [];
    const root = createRoot(dom.root as unknown as Element);
    const panel = React.createElement(AskPanel, { open: true, onClose: () => { happened.push("close"); }, ask: () => new Promise<never>(() => {}), brief: null, modelReady: false,
      onOpen: () => {}, initialVoice: { ok: false, reason: "unavailable" } as never });
    await act(async () => { root.render(React.createElement(ChooseAiContext.Provider, { value: () => { happened.push("choose"); } }, panel)); });
    await settle();
    unmount = async () => { await act(async () => { root.unmount(); }); };
    await press("Choose how Ozzie uses AI");
    expect(happened).toEqual(["close", "choose"]);
    await unmount(); unmount = null;
    // On a page (rewording, the who-could-help look), the same button doesn't close anything.
    happened.length = 0;
    const page = createRoot(dom.root as unknown as Element);
    await act(async () => { page.render(React.createElement(ChooseAiContext.Provider, { value: () => { happened.push("choose"); } }, React.createElement(ChooseAiButton))); });
    unmount = async () => { await act(async () => { page.unmount(); }); };
    await press("Choose how Ozzie uses AI");
    expect(happened).toEqual(["choose"]);
  });
});
