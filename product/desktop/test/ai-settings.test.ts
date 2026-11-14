// AI settings after the H5b hardening (harness plan, integration item 2): what model_status.setup says is missing,
// the own-provider key's account bound to the provider's address, the exact Terminal command (the key typed at a
// hidden prompt, never on a command line), and a model name refused for holding a name. No native calls.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => { throw new Error("NATIVE_CALL_FORBIDDEN"); }) }));
import { SetupNeeds } from "../src/ai-settings.js";
import { keychainCommand, routeProblem, type ModelStatus } from "../src/model.js";
import { HIDDEN_WORDS, text } from "./harness-fakes.js";

const shown = (status: ModelStatus | null) => text(renderToStaticMarkup(React.createElement(SetupNeeds, { status })));
const own = (setup: NonNullable<ModelStatus["setup"]>): ModelStatus =>
  ({ configured: setup === "ready", route: "own", label: "Your AI provider at api.example.com (vendor/model-1)", setup, key_account: "own-provider:api.example.com" });

describe("AI settings", () => {
  it("shows the exact Keychain command for the route's own account, with the key asked for at a hidden prompt", () => {
    expect(keychainCommand("own-provider:api.example.com")).toBe('security add-generic-password -a "own-provider:api.example.com" -s church.ozzie.model.v1 -w');
    expect(keychainCommand("own-provider:api.example.com:8443")).toBe('security add-generic-password -a "own-provider:api.example.com:8443" -s church.ozzie.model.v1 -w');
    // Nothing from the account can break out of its quotes.
    expect(keychainCommand('own-provider:x"; rm -rf ~ #')).toBe('security add-generic-password -a "own-provider:x; rm -rf ~ #" -s church.ozzie.model.v1 -w');
    const missing = shown(own("no-key"));
    expect(missing).toContain("under the account “own-provider:api.example.com”");
    expect(missing).toContain('security add-generic-password -a "own-provider:api.example.com" -s church.ozzie.model.v1 -w');
    expect(missing).toContain("hidden prompt");
    expect(missing).not.toMatch(HIDDEN_WORDS);
  });

  it("explains a key saved under the old account that is tied to no address", () => {
    const old = shown(own("own-key-not-bound"));
    expect(old).toContain("old Keychain account “own-provider”");
    expect(old).toContain("Save it again under “own-provider:api.example.com”");
    expect(old).toContain('-a "own-provider:api.example.com"');
  });

  it("says nothing more when the route is ready, not chosen, or a model on this Mac", () => {
    expect(shown(own("ready"))).toBe("");
    expect(shown({ configured: false, route: "none", label: "No AI model set up", setup: "no-route", key_account: null })).toBe("");
    expect(shown({ configured: true, route: "local", label: "AI model on this Mac (llama)", setup: "ready", key_account: null })).toBe("");
    expect(shown(null)).toBe("");
    // The managed route's account is the gateway key's.
    expect(shown({ configured: false, route: "managed", label: "Ozzie managed AI", setup: "no-key", key_account: "vercel-ai-gateway" }))
      .toContain('-a "vercel-ai-gateway" -s church.ozzie.model.v1 -w');
  });

  it("says plainly when a model name holds a person's name, or an address can't be used", () => {
    expect(routeProblem("name-present")).toMatch(/model name looks like it holds a person's name, so Ozzie didn't save it/u);
    expect(routeProblem("invalid-request")).toMatch(/https address/u);
    expect(routeProblem("provider-failure")).toBe("Ozzie couldn't save that choice. Try again.");
  });
});
