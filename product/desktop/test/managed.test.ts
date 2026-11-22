// Ozzie's AI in the app (spec S10, §9; native contract N7): usage in plain words, the later states in Settings (on,
// near the end, paused, a failed payment, ended, no plan, a connection that ended), how to stop paying, the paused
// message wherever AI help was asked for, and the native commands it calls, with no token or key in any argument.
// "Ozzie managed" and "trial" are retired words. Fixed fictional accounts; the native side is a recording fake.
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installFakeDom } from "./fake-dom.js";
import { fakeNative } from "./onboarding-fakes.js";
const native = vi.hoisted(() => ({ invoke: null as null | ((command: string, args?: Record<string, unknown>) => Promise<unknown>) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn((command: string, args?: Record<string, unknown>) => native.invoke ? native.invoke(command, args) : new Promise(() => {})) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
import { AiSettings } from "../src/ai-settings.js";
import {
  answersLeft, BACKGROUND_NOTE_TEXT, HIDDEN_NOTE_TEXT, managedProblem, model, modelProblem, NO_PLAN_TEXT, offlineLine, PAUSED_TEXT, resetDay, REWORD_NEEDS_AI, STEPS_PER_ANSWER,
  type ManagedAccount, type ModelStatus,
} from "../src/model.js";
import { ChooseAiContext } from "../src/ai-line.js";
import { NEEDS_AI } from "../src/ai-words.js";
import { Draft } from "../src/sunday-page.js";
import { buildSundayBrief } from "../../../core/src/sunday-brief.js";
import { nov22Capture } from "../../../core/src/fictional-sunday.js";
import { createOnboardingBridge } from "../src/onboarding-bridge.js";
import { REFUSALS } from "../../../core/src/ask.js";
import { HIDDEN_WORDS } from "./harness-fakes.js";

const dom = installFakeDom();
type Node = { tagName?: string; textContent: string; childNodes: Node[]; getAttribute?: (n: string) => string | null } & Record<string, unknown>;
const all = (n: Node): Node[] => [n, ...n.childNodes.flatMap(all)];
const button = (start: string) => all(dom.root as unknown as Node).find(b => b.tagName === "BUTTON" && b.textContent.startsWith(start)) ?? null;
let unmount: (() => Promise<void>) | null = null;
afterEach(async () => { await unmount?.(); unmount = null; native.invoke = null; });

/** A time as model.ts says it ("November 14 at 7:00 AM"), on this Mac's own clock, so the test holds in any zone. */
const macDay = (ms: number) => new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(ms));
const account = (over: Partial<ManagedAccount> = {}): ManagedAccount => ({
  plan: "personal", allowance_steps: 300, used_steps: 120, period_ends: "2026-12-01T00:00:00.000Z",
  warning: null, checked_at_ms: Date.UTC(2026, 10, 14, 12, 0), offline: false, ...over,
});
const status = (over: Partial<ModelStatus> = {}): ModelStatus => ({
  configured: true, route: "managed", label: "Ozzie managed AI through ozzie.church, zero data retention", setup: "ready",
  key_account: null, managed: "connected", account: account(), ...over,
});
async function settle() { const { act } = await import("react"); await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); }); }
async function settings(s: ModelStatus, replies: Record<string, unknown> = {}) {
  const fake = fakeNative({ model_status: s, ...replies });
  native.invoke = fake.invoke as never;
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.root as unknown as Element);
  await act(async () => { root.render(React.createElement(AiSettings, { onChange() {} })); });
  await settle();
  unmount = async () => { await act(async () => { root.unmount(); }); };
  return fake;
}
async function press(start: string) {
  const b = button(start);
  if (!b) throw new Error(`No button "${start}" in: ${dom.seen()}`);
  const { act } = await import("react");
  await act(async () => { dom.press(b as never); });
  await settle();
}

describe("Ozzie's AI: usage in plain words", () => {
  it("turns steps into about how many answers are left, with the day they start again", () => {
    // The website's UNITS_PER_ANSWER (decision 17): Personal's 1,500 units read as about 400 answers, never a fraction.
    expect(STEPS_PER_ANSWER).toBe(3.75);
    expect(answersLeft(account({ allowance_steps: 1500, used_steps: 0 }))).toBe(400);
    expect(answersLeft(account())).toBe(48);
    expect(Number.isInteger(answersLeft(account({ used_steps: 121 })))).toBe(true);
    expect(answersLeft(account({ used_steps: 297 }))).toBe(0);
    expect(answersLeft(account({ used_steps: 400 }))).toBe(0);
    // ozzie.church's own count (answers_left), when it sends one, is the number said, so the app and the website agree.
    expect(answersLeft(account({ allowance_steps: 1500, used_steps: 0, answers_left: 399 }))).toBe(399);
    expect(answersLeft(account({ allowance_steps: 1500, used_steps: 0, answers_left: 0 }))).toBe(0);
    for (const odd of [-1, 2.5, "12", null, Number.NaN]) expect(answersLeft(account({ allowance_steps: 1500, used_steps: 0, answers_left: odd }))).toBe(400);
    expect(resetDay(account())).toBe("December 1");
    // A date-only day is that calendar day, not the evening before.
    expect(resetDay(account({ period_ends: "2026-12-01" }))).toBe("December 1");
    expect(resetDay(account({ period_ends: "not a date" }))).toBeNull();
    // When ozzie.church was last reached is on this Mac's clock: noon UTC on November 14 is November 15 on a Mac in Auckland.
    expect(offlineLine(account())).toBe(`Ozzie couldn't reach its website just now. These numbers are from ${macDay(Date.UTC(2026, 10, 14, 12, 0))}.`);
    expect(offlineLine(account({ checked_at_ms: Number.NaN }))).toBe("Ozzie couldn't reach its website just now. These numbers are from earlier.");
  });
});

describe("Ozzie's AI in Settings (spec S10d)", () => {
  it("says answers left, and the notices at three quarters and nine tenths, never in raw steps", async () => {
    await settings(status());
    let text = dom.seen();
    expect(text).toContain("AI: Ozzie's AI");
    expect(text).toContain("About 48 answers left this month. They start again on December 1.");
    expect(text).not.toMatch(/step|token|120|300|Ozzie managed|trial|zero data retention/u);
    await unmount!(); unmount = null;
    await settings(status({ account: account({ used_steps: 225, warning: "three-quarters" }) }));
    text = dom.seen();
    expect(text).toContain("Ozzie's AI has used about three quarters of this month's answers. When they run out, AI pauses until December 1. Everything else keeps working, and nothing extra is charged.");
    await unmount!(); unmount = null;
    await settings(status({ account: account({ used_steps: 270, warning: "nine-tenths", offline: true }) }));
    text = dom.seen();
    expect(text).toContain("about nine tenths of this month's answers");
    expect(text).toContain(`Ozzie couldn't reach its website just now. These numbers are from ${macDay(Date.UTC(2026, 10, 14, 12, 0))}.`);
    expect(text).not.toMatch(HIDDEN_WORDS);
  });

  it("when paused, after a failed payment, ended or with no plan, says so and offers the one thing to do", async () => {
    let fake = await settings(status({ account: account({ used_steps: 300, warning: "paused" }) }), { open_help_page: null });
    expect(dom.seen()).toContain("Ozzie's AI is paused until December 1: this month's answers are used. Everything else in Ozzie still works.");
    expect(dom.seen()).toContain("AI: Ozzie's AI · paused");
    await press("See my plan");
    expect(fake.calls.at(-1)).toEqual({ command: "open_help_page", args: { page: "ozzie-account" } });
    await unmount!(); unmount = null;

    const none = account({ plan: "none", allowance_steps: 0, used_steps: 0 });
    fake = await settings(status({ account: { ...none, plan_reason: "payment-failed" } }), { open_help_page: () => { throw "browser-unavailable"; } });
    expect(dom.seen()).toContain("Ozzie's AI is off because the last payment didn't go through. Everything else still works.");
    await press("Update my card in my browser");
    expect(fake.calls.at(-1)).toEqual({ command: "open_help_page", args: { page: "ozzie-account" } });
    expect(dom.seen()).toContain("Your browser didn't open. Go to ozzie.church/account in your browser.");
    await unmount!(); unmount = null;

    await settings(status({ account: { ...none, period_ends: "2026-11-17", plan_reason: "cancelled" } }));
    expect(dom.seen()).toContain("Ozzie's AI ended on November 17. Everything else in Ozzie keeps working.");
    expect(button("Start it again")).not.toBeNull();
    expect(button("Choose another way")).not.toBeNull();
    await unmount!(); unmount = null;

    // No plan: said once, never "No plan plan", never a past day to wait for.
    await settings(status({ account: { ...none, period_ends: "2026-10-01", warning: "paused", plan_reason: "something new" } }));
    const said = dom.seen();
    expect(said).toContain(NO_PLAN_TEXT);
    expect(said).not.toContain("No plan plan");
    expect(said).not.toMatch(/until (January|February|March|April|May|June|July|August|September|October|November|December)/u);
    expect(NO_PLAN_TEXT).toBe("Ozzie's AI is off: there's no plan on your account. Everything else in Ozzie keeps working, and nothing charges itself.");
  });

  it("says what stopping paying means before sending the person to the account page", async () => {
    const fake = await settings(status(), { open_help_page: null });
    await press("Stop paying for Ozzie's AI");
    const sheet = all(dom.root as unknown as Node).find(n => n.getAttribute?.("role") === "dialog")!;
    expect(sheet.textContent).toContain("Stop paying for Ozzie's AI?");
    expect(sheet.textContent).toContain("Cancelling stops the next payment. Ozzie's AI keeps working until December 1. What's been paid isn't refunded, except where the law requires.");
    expect(fake.calls.some(c => c.command === "open_help_page")).toBe(false);
    await press("Keep Ozzie's AI");
    expect(all(dom.root as unknown as Node).some(n => n.getAttribute?.("role") === "dialog")).toBe(false);
    await press("Stop paying for Ozzie's AI");
    await press("Cancel it in my browser");
    expect(fake.calls.at(-1)).toEqual({ command: "open_help_page", args: { page: "ozzie-account" } });
  });

  it("offers connecting again when this Mac's connection ended, without asking to pay first", async () => {
    const fake = await settings(status({ managed: "reconnect", setup: "reconnect", configured: false, account: null }), { managed_offer: { open: false }, managed_connect: new Promise(() => {}) });
    expect(dom.seen()).toContain("AI: Ozzie's AI · not answering");
    expect(dom.seen()).toContain("This Mac's connection to Ozzie's AI has ended");
    await press("Connect this Mac again in my browser");
    expect(dom.seen()).not.toContain("Pay ");
    await press("Connect this Mac again in my browser");
    expect(fake.calls.find(c => c.command === "managed_connect")?.args).toEqual({ plan: "personal" });
    expect(dom.seen()).toContain("Waiting for you in your browser");
  });
});

describe("Ozzie's AI: native commands and the words wherever AI was asked for", () => {
  it("calls the native commands with no token or key in any argument", async () => {
    const calls: [string, unknown][] = [];
    native.invoke = async (command, args) => { calls.push([command, args]); return new Promise(() => {}); };
    void model.disconnect();
    const bridge = createOnboardingBridge(async (command, args) => { calls.push([command, args]); return new Promise(() => {}); });
    void bridge.payAndConnect();
    void bridge.cancelPay();
    void bridge.accountNow();
    await Promise.resolve();
    expect(calls).toEqual([["managed_disconnect", undefined], ["managed_connect", { plan: "personal" }], ["managed_connect_cancel", undefined], ["managed_account_now", undefined]]);
  });

  it("says plainly why disconnecting didn't work, and that a paused allowance leaves the draft and everything else alone", () => {
    expect(managedProblem("cancelled")).toBe("Nothing changed on this Mac.");
    expect(managedProblem("keychain")).toBe("This Mac didn't let Ozzie change its connection. Unlock this Mac (type your Mac password if it asks), then try again.");
    expect(managedProblem("busy")).toMatch(/already waiting/u);
    for (const other of ["provider-failure", "unavailable", "something-new", undefined]) {
      expect(managedProblem(other)).toBe("Ozzie couldn't reach its website just now. Nothing changed. Try again in a minute.");
    }
    expect(PAUSED_TEXT).toBe("Ozzie's AI is paused until this month's answers start again. Everything else in Ozzie still works.");
    expect(modelProblem("allowance-paused")).toBe(`${PAUSED_TEXT} Your draft is unchanged.`);
    expect(modelProblem("contact-detail")).toBe("This note looks like it holds a phone number or email address, so Ozzie's AI didn't send it. Your draft is unchanged.");
    expect(modelProblem("rate-limited")).toBe("The AI service asked Ozzie to slow down. Try again in a minute.");
    expect(modelProblem("not-configured")).toBe("Rewording needs AI, but everything else in Ozzie works without it. Your draft is unchanged.");
    expect(modelProblem("not-configured")).toBe(REWORD_NEEDS_AI);
    // A note with background-check wording, stopped on this Mac or by ozzie.church: the page's own words for a note about one.
    expect(modelProblem("background-check")).toBe(BACKGROUND_NOTE_TEXT);
    expect(BACKGROUND_NOTE_TEXT).toBe("Ozzie doesn't use AI help for notes with background-check or child-safety screening wording, so nothing was sent. Your draft is unchanged.");
    expect(REFUSALS.backgroundNote.startsWith(BACKGROUND_NOTE_TEXT.replace(" Your draft is unchanged.", ""))).toBe(true);
    // A note holding a hidden character, stopped on this Mac or by ozzie.church (review B2 M-1).
    expect(modelProblem("hidden-character")).toBe(HIDDEN_NOTE_TEXT);
    expect(HIDDEN_NOTE_TEXT).toBe("This note has a hidden or invisible character in it, so Ozzie didn't send it to the AI. Your draft is unchanged.");
    // A person's name stops the request before anything is sent.
    expect(modelProblem("name-present")).toBe("Ozzie stopped this request because it contained a person's name. Nothing was sent; your draft is unchanged.");
    for (const code of ["allowance-paused", "contact-detail", "not-configured", "month-limit", "model-not-allowed", "budget", "x"]) {
      expect(modelProblem(code)).not.toMatch(/Ozzie managed|trial|Keychain|zero data retention/u);
    }
  });

  it("a reword with no AI says so calmly, keeps the draft, and offers the one step to How should Ozzie use AI? (walk-through, 2026-11-18)", async () => {
    // AI was on when the note opened (the chips show) and isn't by the time a chip is pressed: native says not-configured.
    const fake = fakeNative({ model_status: { configured: false, route: "none", label: "No AI model set up", setup: "no-route" }, reword_draft: () => { throw "not-configured"; } });
    native.invoke = fake.invoke as never;
    const capture = nov22Capture();
    const greeter = buildSundayBrief(capture, { sundayLeads: [], checkInAfterSundaysInARow: 3 }, capture.completed_at, true).findings.find(f => f.kind === "needs-people" && f.position?.name === "Greeter")!;
    const opened: string[] = [];
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(dom.root as unknown as Element);
    await act(async () => {
      root.render(React.createElement(ChooseAiContext.Provider, { value: () => { opened.push("ai"); } },
        React.createElement(Draft, { finding: greeter, person: greeter.people!.suggestions[0]!.person_id, names: capture.names, sender: "Pat", sunday: null, canReword: true, onClose() {} })));
    });
    unmount = async () => { await act(async () => { root.unmount(); }); };
    const before = dom.seen();
    await press("Warmer");
    expect(dom.seen()).toContain(REWORD_NEEDS_AI);
    expect(dom.seen()).not.toMatch(/AI model|Set one up|in Settings\./u);
    await press(NEEDS_AI.button);
    expect(opened).toEqual(["ai"]);
    // The note itself is as it was.
    expect(before).toContain("Hi ");
    expect(dom.seen()).toContain(before.slice(before.indexOf("Hi "), before.indexOf("Hi ") + 40));
  });
});
