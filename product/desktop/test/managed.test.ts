// Ozzie managed in the app (the hosted Ozzie contract, Mac side): the Settings row's actions by where this Mac
// stands, the church's plan and usage in plain words, the notices at three quarters, nine tenths and paused (owner
// decision 2026-10-26), the paused message wherever AI help was asked for, the first-run "coming soon", and the
// native commands the row calls. Fixed fictional accounts; the native side is a recording fake.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
const calls = vi.hoisted(() => [] as [string, unknown][]);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((command: string, args?: unknown) => {
    calls.push([command, args]);
    return new Promise(() => {});
  }),
}));
import { AiSettings, ManagedActions, ManagedDetails } from "../src/ai-settings.js";
import {
  answersLeft, BACKGROUND_NOTE_TEXT, HIDDEN_NOTE_TEXT, managedNotice, managedProblem, model, modelProblem, offlineLine, PAUSED_TEXT, planName, resetDay, routeBadge, routeStatusLine,
  STEPS_PER_ANSWER, usageLine,
  type ManagedAccount, type ModelStatus,
} from "../src/model.js";
import { REFUSALS } from "../../../core/src/ask.js";
import { HIDDEN_WORDS, text } from "./harness-fakes.js";

const account = (over: Partial<ManagedAccount> = {}): ManagedAccount => ({
  plan: "small-church", allowance_steps: 300, used_steps: 120, period_ends: "2026-12-01T00:00:00.000Z",
  warning: null, checked_at_ms: Date.UTC(2026, 10, 14, 12, 0), offline: false, ...over,
});
const status = (over: Partial<ModelStatus> = {}): ModelStatus => ({
  configured: true, route: "managed", label: "Ozzie managed AI through ozzie.church, zero data retention", setup: "ready",
  key_account: null, managed: "connected", account: account(), ...over,
});
const details = (s: ModelStatus | null) => text(renderToStaticMarkup(React.createElement(ManagedDetails, { status: s }))).trim();
const actions = (s: ModelStatus | null, over: Partial<React.ComponentProps<typeof ManagedActions>> = {}) =>
  text(renderToStaticMarkup(React.createElement(ManagedActions, {
    status: s, selected: false, soon: false, connecting: false, describedBy: "x", onUse() {}, onConnect() {}, onCancel() {}, onDisconnect() {}, ...over,
  }))).trim();

describe("Ozzie managed: usage in plain words", () => {
  it("turns steps into about how many answers are left, with the day it resets", () => {
    expect(STEPS_PER_ANSWER).toBe(3);
    expect(answersLeft(account())).toBe(60);
    expect(answersLeft(account({ used_steps: 299 }))).toBe(0);
    expect(answersLeft(account({ used_steps: 400 }))).toBe(0);
    expect(resetDay(account())).toBe("December 1");
    // A date-only reset day is that calendar day, not the evening before.
    expect(resetDay(account({ period_ends: "2026-12-01" }))).toBe("December 1");
    expect(resetDay(account({ period_ends: "not a date" }))).toBeNull();
    expect(usageLine(account())).toBe("About 60 AI answers left this month. It resets on December 1.");
    expect(usageLine(account({ used_steps: 296 }))).toBe("About 1 AI answer left this month. It resets on December 1.");
    expect(usageLine(account({ used_steps: 299 }))).toBe("Almost no AI help left this month. It resets on December 1.");
    expect(usageLine(account({ used_steps: 300, warning: "paused" }))).toBe("AI help is paused until December 1.");
    expect(usageLine(account({ used_steps: 300 }))).toBe("AI help is paused until December 1.");
    expect(planName("small-church")).toBe("Small church");
    expect(planName("trial")).toBe("Trial");
    // Never raw counts of steps or tokens.
    expect(usageLine(account())).not.toMatch(/step|token|120|300/u);
  });

  it("warns at three quarters and nine tenths, and says what pauses, what keeps working and that nothing charges itself", () => {
    expect(managedNotice(account())).toBeNull();
    const quarters = managedNotice(account({ used_steps: 225, warning: "three-quarters" }))!;
    expect(quarters).toBe("Your church has used about three quarters of this month's AI help. When it runs out, AI drafting and answers pause until it resets on December 1. Lists, Church rules, checks and briefings keep working, and nothing charges itself.");
    const tenths = managedNotice(account({ used_steps: 270, warning: "nine-tenths" }))!;
    expect(tenths).toContain("about nine tenths of this month's AI help");
    expect(tenths).toContain("pause until it resets on December 1");
    const pausedNotice = managedNotice(account({ used_steps: 300, warning: "paused" }))!;
    expect(pausedNotice).toBe("AI drafting and answers are paused until the allowance resets on December 1 or your church changes plan. Lists, Church rules, checks and briefings keep working, and nothing charges itself.");
    for (const notice of [quarters, tenths, pausedNotice]) {
      expect(notice).toContain("nothing charges itself");
      expect(notice).not.toMatch(HIDDEN_WORDS);
    }
  });

  it("shows plan, usage and the notice under the row, and where the numbers came from when ozzie.church can't be reached", () => {
    expect(details(status())).toBe("Small church plan. About 60 AI answers left this month. It resets on December 1.");
    const warned = details(status({ account: account({ used_steps: 270, warning: "nine-tenths" }) }));
    expect(warned).toContain("About 10 AI answers left this month.");
    expect(warned).toContain("about nine tenths of this month's AI help");
    const offline = details(status({ account: account({ offline: true }) }));
    expect(offline).toContain("Ozzie couldn't reach ozzie.church just now. These numbers are from November 14");
    expect(offlineLine(account({ checked_at_ms: Number.NaN }))).toBe("Ozzie couldn't reach ozzie.church just now. These numbers are from earlier.");
    expect(details(status({ account: null }))).toBe("This Mac is connected. Ozzie couldn't check this month's usage just now.");
    expect(details(status({ managed: "reconnect", account: null, configured: false, setup: "reconnect" })))
      .toBe("This Mac's connection to Ozzie managed has ended, so AI help through ozzie.church is off. Connect again to keep using it.");
    expect(details(status({ managed: "not-connected", account: null }))).toBe("");
    expect(details(null)).toBe("");
    for (const s of [status(), status({ account: account({ offline: true, warning: "paused", used_steps: 300 }) })]) expect(details(s)).not.toMatch(HIDDEN_WORDS);
  });
});

describe("Ozzie managed: the Settings row", () => {
  it("offers the action that fits where this Mac stands", () => {
    expect(actions(status({ managed: "not-connected", account: null, configured: false, setup: "not-connected" }))).toBe("Connect to Ozzie managed");
    expect(actions(status({ managed: "reconnect", account: null }))).toBe("Connect again");
    expect(actions(status(), { selected: true })).toBe("Disconnect this Mac");
    expect(actions(status({ route: "local" }))).toBe("Use this Disconnect this Mac");
    expect(actions(status(), { connecting: true })).toBe("Waiting for you to finish in your browser… Cancel");
    // Not known yet: choose it like any route; once known, the row offers connecting.
    expect(actions(null)).toBe("Use this");
    // Coming soon in first-run setup: no action at all.
    expect(actions(status({ managed: "not-connected" }), { soon: true })).toBe("");
    for (const label of ["Connect to Ozzie managed", "Connect again", "Disconnect this Mac"]) expect(label).not.toMatch(/^(?:Approve|Block)$/u);
  });

  it("shows Ozzie managed as coming soon in first-run setup, and as needing an account in Settings", () => {
    const setup = text(renderToStaticMarkup(React.createElement(AiSettings, { onChange() {}, preview: true })));
    expect(setup).toContain("Ozzie managed (coming soon)");
    expect(setup).toContain("Managed plans through ozzie.church are coming soon. You can connect this Mac later under Settings.");
    expect(setup).not.toContain("Connect to Ozzie managed");
    const settings = text(renderToStaticMarkup(React.createElement(AiSettings, { onChange() {} })));
    expect(settings).toContain("Ozzie managed");
    expect(settings).not.toContain("coming soon)");
    expect(settings).toContain("Through ozzie.church, with zero data retention required on every request.");
    expect(settings).toContain("Needs an Ozzie managed account. Managed plans are coming soon.");
    for (const html of [setup, settings]) expect(html).not.toMatch(HIDDEN_WORDS);
  });

  it("calls the native commands with no token or key in any argument", () => {
    calls.length = 0;
    void model.connect();
    void model.cancelConnect();
    void model.disconnect();
    expect(calls).toEqual([["managed_connect", undefined], ["managed_connect_cancel", undefined], ["managed_disconnect", undefined]]);
  });

  it("says plainly why connecting didn't work, and that a paused allowance leaves the draft and everything else alone", () => {
    expect(managedProblem("cancelled")).toBe("Connecting was cancelled. Nothing changed on this Mac.");
    expect(managedProblem("expired")).toMatch(/longer than five minutes/u);
    expect(managedProblem("browser-unavailable")).toMatch(/couldn't open your browser/u);
    expect(managedProblem("refused")).toMatch(/didn't accept that sign-in/u);
    expect(managedProblem("keychain")).toMatch(/Keychain/u);
    expect(managedProblem("busy")).toMatch(/already waiting/u);
    for (const other of ["provider-failure", "unavailable", "something-new", undefined]) {
      expect(managedProblem(other)).toBe("Ozzie couldn't reach ozzie.church just now. Try again in a minute.");
    }
    expect(modelProblem("allowance-paused")).toBe(`${PAUSED_TEXT} Your draft is unchanged.`);
    // Ozzie managed's other refusals each say what happened (hosted review 2026-11-14).
    expect(modelProblem("contact-detail")).toBe(
      "This note looks like it holds a phone number or email address, so Ozzie managed didn't send it to the AI. Your draft is unchanged.",
    );
    expect(modelProblem("rate-limited")).toBe("The AI service asked Ozzie to slow down. Try again in a minute.");
    // A note with background-check wording, stopped on this Mac or by ozzie.church: the page's own words for a note about one.
    expect(modelProblem("background-check")).toBe(BACKGROUND_NOTE_TEXT);
    expect(BACKGROUND_NOTE_TEXT).toBe("Ozzie doesn't use AI help for notes with background-check or child-safety screening wording, so nothing was sent. Your draft is unchanged.");
    expect(REFUSALS.backgroundNote.startsWith(BACKGROUND_NOTE_TEXT.replace(" Your draft is unchanged.", ""))).toBe(true);
    // A note holding a hidden character, stopped on this Mac or by ozzie.church (review B2 M-1).
    expect(modelProblem("hidden-character")).toBe(HIDDEN_NOTE_TEXT);
    expect(HIDDEN_NOTE_TEXT).toBe("This note has a hidden or invisible character in it, so Ozzie didn't send it to the AI. Your draft is unchanged.");
    expect(PAUSED_TEXT).toBe("Your church's AI help is paused until the allowance resets or your church changes plan. Checks, lists, Church rules and briefings keep working.");
  });
});

describe("AI help at a glance (audit item 4)", () => {
  it("marks a route In use only when AI help works through it now, and says what stands in the way otherwise", () => {
    expect(routeBadge(status(), "managed")).toEqual({ text: "In use", tone: "ok" });
    expect(routeBadge(status(), "own")).toBeNull();
    // Chosen, but this Mac isn't connected to Ozzie managed (or a key isn't saved): never "In use".
    const unconnected = status({ configured: false, managed: "not-connected", setup: "not-connected", account: null });
    expect(routeBadge(unconnected, "managed")).toEqual({ text: "Chosen, not ready yet", tone: "look" });
    expect(routeStatusLine(unconnected)).toBe("Chosen: Ozzie managed AI through ozzie.church, zero data retention. Not ready yet.");
    expect(routeBadge(status({ route: "own", configured: false, setup: "no-key", managed: "not-connected", account: null }), "own")?.text).toBe("Chosen, not ready yet");
    // Connected with no plan, or the allowance spent: AI help is off, and the row says so.
    const none = status({ account: account({ plan: "none", allowance_steps: 0, used_steps: 0 }) });
    expect(routeBadge(none, "managed")).toEqual({ text: "Off: no plan right now", tone: "muted" });
    expect(routeStatusLine(none)).toBe("AI help is off: Ozzie managed has no plan right now. Drafts still work.");
    const spent = status({ account: account({ used_steps: 300, warning: "paused" }) });
    expect(routeBadge(spent, "managed")).toEqual({ text: "Paused this month", tone: "muted" });
    expect(routeStatusLine(spent)).toBe("AI help is paused until this month's allowance resets. Drafts still work.");
    expect(routeStatusLine(status())).toBe("Using: Ozzie managed AI through ozzie.church, zero data retention");
    expect(routeStatusLine(null)).toBe("Not set up. Drafts still work; only rewording and questions are off.");
    expect(routeStatusLine(status({ route: "none", configured: false }))).toBe("Not set up. Drafts still work; only rewording and questions are off.");
    // Before the status is known (it loads after the first render), nothing is marked In use.
    expect(text(renderToStaticMarkup(React.createElement(AiSettings, { onChange() {} })))).not.toContain("In use");
  });

  it("never says “No plan plan.”: with no plan the usage line alone says so", () => {
    const none = status({ account: account({ plan: "none", allowance_steps: 0, used_steps: 0, warning: "paused" }) });
    const said = details(none);
    expect(said).not.toContain("No plan plan");
    expect(said.startsWith("No plan right now, so AI help through ozzie.church is off.")).toBe(true);
    expect(details(status())).toBe("Small church plan. About 60 AI answers left this month. It resets on December 1.");
  });
});

describe("no plan after a trial ends", () => {
  it("says the trial ended and where to choose a plan, never a past reset date", async () => {
    const { usageLine, managedNotice, planName, NO_PLAN_TEXT } = await import("../src/model.js");
    const none = { plan: "none", allowance_steps: 0, used_steps: 0, period_ends: "2026-10-01", warning: "paused" as const, checked_at_ms: 0, offline: false };
    expect(planName("none")).toBe("No plan");
    expect(usageLine(none)).toBe("No plan right now, so AI help through ozzie.church is off.");
    expect(managedNotice(none)).toBe(NO_PLAN_TEXT);
    expect(managedNotice(none)).not.toMatch(/until (January|February|March|April|May|June|July|August|September|October|November|December)/u);
  });
});
