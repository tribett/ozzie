// Settings' AI section after the new onboarding (spec §3 S8, §6; native contract N5): the key is taken natively and
// never typed, copied or shown in the app, so there is no Terminal command any more; a key saved the old way is
// explained and replaced in the app; "Keychain" is said only inside "See how this works"; a model name refused for
// holding a name is said plainly. Native is a recording fake.
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installFakeDom } from "./fake-dom.js";
import { fakeNative } from "./onboarding-fakes.js";
const native = vi.hoisted(() => ({ invoke: null as null | ((command: string, args?: Record<string, unknown>) => Promise<unknown>) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn((command: string, args?: Record<string, unknown>) => native.invoke ? native.invoke(command, args) : new Promise(() => {})) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
import { AiSettings } from "../src/ai-settings.js";
import { routeProblem, type ModelStatus } from "../src/model.js";
import { MAC } from "../src/ai-words.js";
import { HIDDEN_WORDS } from "./harness-fakes.js";

const dom = installFakeDom();
type Node = { tagName?: string; textContent: string; childNodes: Node[] } & Record<string, unknown>;
const all = (n: Node): Node[] => [n, ...n.childNodes.flatMap(all)];
let unmount: (() => Promise<void>) | null = null;
afterEach(async () => { await unmount?.(); unmount = null; native.invoke = null; });

async function shown(status: ModelStatus) {
  const fake = fakeNative({ model_status: status });
  native.invoke = fake.invoke as never;
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.root as unknown as Element);
  await act(async () => { root.render(React.createElement(AiSettings, { onChange() {} })); });
  await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); });
  unmount = async () => { await act(async () => { root.unmount(); }); };
  let outsideHow = (dom.root as unknown as Node).textContent;
  for (const how of all(dom.root as unknown as Node).filter(n => n.tagName === "DETAILS")) outsideHow = outsideHow.replace(how.textContent, "");
  return { text: dom.seen(), outsideHow, calls: fake.calls };
}
const own = (setup: NonNullable<ModelStatus["setup"]>): ModelStatus => ({ configured: setup === "ready", route: "own", label: "Your AI provider at api.example.com (vendor/model-1)",
  setup, key_account: "own-provider:api.example.com", provider: null, month: { used: 3, limit: 1000, resets_on: "2026-12-01" } });

describe("AI settings", () => {
  it("never shows a Terminal command, a Keychain account or a Copy command, whatever the key's state", async () => {
    for (const setup of ["no-key", "own-key-not-bound", "ready", "month-limit"] as const) {
      const { text, outsideHow, calls } = await shown(own(setup));
      expect(text, setup).not.toMatch(/security add-generic-password|Copy command|own-provider|api\.example\.com|vendor\/model-1|-w\b/u);
      // "Keychain" only inside "See how this works" (spec §6).
      expect(outsideHow, setup).not.toContain("Keychain");
      expect(text).not.toMatch(HIDDEN_WORDS);
      // Reading the section asks native for its status, whether Ozzie installed Ollama (times and closed words only, for
      // how to remove it; decision 25), which companies' keys are kept (closed ids, for "Remove my key from this Mac") and
      // how many keys removing would take (a count from the Keychain's list, review L-4), and nothing else; no call
      // carries any argument, so none can carry a key.
      expect(calls.map(c => c.command)).toEqual(["model_status", "ollama_install_history", "own_key_saved", "own_key_count"]);
      expect(calls.map(c => c.args)).toEqual([{}, {}, {}, {}]);
      await unmount!(); unmount = null;
    }
  });

  it("explains a key saved the old way, tied to no address, and replaces it in the app", async () => {
    const { text } = await shown(own("own-key-not-bound"));
    expect(text).toContain("A key saved the old way, in Terminal, isn't tied to the company's address, so Ozzie doesn't use it. Paste the key here instead and Ozzie keeps it safely on this Mac.");
    expect(text).toContain("Paste my key");
    await unmount!(); unmount = null;
    const missing = await shown(own("no-key"));
    expect(missing.text).toContain("Ozzie doesn't have the company's key on this Mac yet, so AI is off.");
  });

  it("says nothing is wrong when the key works, and nothing about a key for AI on this Mac", async () => {
    const ready = await shown(own("ready"));
    expect(ready.text).toContain("AI: another AI company, your key");
    expect(ready.text).toContain("3 of 1,000 AI requests used this month. The count starts again on December 1.");
    expect(ready.text).not.toMatch(/paused|not answering|doesn't have/u);
    await unmount!(); unmount = null;
    const local = await shown({ configured: true, route: "local", label: "AI model on this Mac (llama3.2:latest)", setup: "ready", key_account: null, checked_at_ms: Date.UTC(2026, 10, 17, 15, 14),
      local_app: "ollama" });
    expect(local.text).toContain("AI: on this Mac (llama3.2)");
    expect(local.text).toMatch(/Answered Ozzie's check on November 17(?:,| at) \d{1,2}:14 [AP]M\. Nothing leaves this Mac\./u);
    expect(local.text).not.toMatch(/key/iu);
    expect(local.text).not.toMatch(/LM Link/u);
  });

  it("says plainly for a chosen LM Studio model that its LM Link can answer from another computer, and never that nothing leaves this Mac (2026-11-19)", async () => {
    const lm = (over: Partial<ModelStatus>): ModelStatus => ({ configured: true, route: "local", label: "AI model on this Mac (qwen/qwen3-8b)", setup: "ready", key_account: null,
      checked_at_ms: Date.UTC(2026, 10, 17, 15, 14), local_app: "lm-studio", ...over });
    const ready = await shown(lm({}));
    expect(ready.text).toMatch(/Answered Ozzie's check on November 17(?:,| at) \d{1,2}:14 [AP]M\./u);
    expect(ready.text).not.toContain("Nothing leaves this Mac");
    expect(ready.text).toContain(MAC.lmLink);
    expect(ready.text.indexOf(MAC.lmLink)).toBe(ready.text.lastIndexOf(MAC.lmLink));
    await unmount!(); unmount = null;
    // Chosen, not checked yet: said too.
    const unchecked = await shown(lm({ configured: false, setup: "not-checked", checked_at_ms: null }));
    expect(unchecked.text).toContain("AI on this Mac is chosen, but Ozzie hasn't checked that it answers yet.");
    expect(unchecked.text).toContain(MAC.lmLink);
    await unmount!(); unmount = null;
    // A model that runs elsewhere already says so, and isn't used: LM Link's words would only repeat it.
    const away = await shown(lm({ configured: false, setup: "not-on-this-mac", label: "AI model on this Mac (far/model)" }));
    expect(away.text).toContain("far/model runs on another computer, not on this Mac, so Ozzie doesn't use it here.");
    expect(away.text).not.toContain(MAC.lmLink);
  });

  it("says plainly when a model name holds a person's name, or an address can't be used", () => {
    expect(routeProblem("name-present")).toMatch(/model name looks like it holds a person's name, so Ozzie didn't save it/u);
    expect(routeProblem("invalid-request")).toMatch(/https address/u);
    expect(routeProblem("provider-failure")).toBe("Ozzie couldn't save that choice. Nothing changed. Try again.");
  });
});
