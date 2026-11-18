// First run's state from facts, not a "closed" flag (onboarding spec §0.3, test P1): every combination of the facts opens
// the right screen; quitting mid-attempt resumes with the line; the first screen never shows once connected; every
// Planning Center outcome lands on its fixed sentence. Fictional data only.
import { describe, expect, it } from "vitest";
import { aiStillOpen, connectFailure, firstRunScreen, isConnected, readSetupMemory, RESUME_LINE, setupMemory, type SetupMemory } from "../src/first-run-state.js";
import type { ConnectionStatus } from "../src/connection.js";

const status = (state: ConnectionStatus["state"], more: Partial<ConnectionStatus> = {}): ConnectionStatus =>
  ({ state, organization: state === "connected" || state === "stored-unchecked" ? "1001" : "", checked_at_ms: null, source: "", problem: null, ...more });
const fresh: SetupMemory = { aiOffered: false, exampleSeen: false, lastAttempt: null, aiAnswer: null };
const facts = (over: Partial<Parameters<typeof firstRunScreen>[0]> = {}) => ({ status: null as ConnectionStatus | null, watching: false, resultSeen: false, memory: fresh, ...over });

describe("which first-run screen opens", () => {
  it("a new Mac opens the first screen; after an attempt that didn't finish, the browser step with the resume line", () => {
    expect(firstRunScreen(facts({ status: status("disconnected") }))).toBe("first");
    expect(firstRunScreen(facts())).toBe("first");
    expect(firstRunScreen(facts({ status: status("disconnected"), memory: { ...fresh, lastAttempt: "cancelled" } }))).toBe("browser");
    expect(RESUME_LINE.cancelled).toBe("Last time, Planning Center didn't finish connecting. Nothing was connected.");
  });

  it("waits while a sign-in is under way", () => {
    expect(firstRunScreen(facts({ status: status("waiting") }))).toBe("waiting");
    expect(firstRunScreen(facts({ status: status("checking") }))).toBe("waiting");
  });

  it("a failed or refused sign-in goes back to the browser step, never the first screen", () => {
    for (const s of [status("cancelled", { problem: "denied" }), status("expired"), status("cancelled"), status("failed", { problem: "scope-mismatch" })]) {
      expect(firstRunScreen(facts({ status: s }))).toBe("browser");
    }
  });

  it("connected but not watching, or watching but no result seen yet: the service step", () => {
    expect(firstRunScreen(facts({ status: status("connected") }))).toBe("service");
    expect(firstRunScreen(facts({ status: status("connected"), watching: true }))).toBe("service");
    expect(firstRunScreen(facts({ status: status("stored-unchecked"), watching: true }))).toBe("service");
  });

  it("connected, watching and a result seen: setup is done, and never opens by itself again", () => {
    expect(firstRunScreen(facts({ status: status("connected"), watching: true, resultSeen: true }))).toBeNull();
    // The AI screen isn't a required step: it opens only right after the first result, from that screen.
    expect(firstRunScreen(facts({ status: status("connected"), watching: true, resultSeen: true, memory: { ...fresh, aiOffered: false } }))).toBeNull();
  });

  it("a Mac already set up (a watched service, a saved check) with no status yet opens no setup (0.3.0 relaunch bug)", () => {
    // Native has no status until the launch check of the saved sign-in answers, and none if it couldn't: this Mac was set
    // up, so Today says how the connection stands; setup never opens at the first screen for it.
    expect(firstRunScreen(facts({ status: null, watching: true, resultSeen: true }))).toBeNull();
    expect(firstRunScreen(facts({ status: null, watching: true, resultSeen: true, memory: { ...fresh, lastAttempt: "cancelled" } }))).toBeNull();
    // Not set up: no status is the first screen, as before.
    expect(firstRunScreen(facts({ status: null }))).toBe("first");
    expect(firstRunScreen(facts({ status: null, watching: true }))).toBe("first");
  });

  it("the first screen never shows once connected, whatever else is true", () => {
    for (const watching of [false, true]) for (const resultSeen of [false, true]) for (const lastAttempt of [null, "denied", "expired", "cancelled"] as const) {
      for (const s of [status("connected"), status("stored-unchecked")]) {
        expect(firstRunScreen(facts({ status: s, watching, resultSeen, memory: { ...fresh, lastAttempt } }))).not.toBe("first");
      }
    }
  });

  it("a saved sign-in Planning Center couldn't be reached to check still counts as connected; one it refused doesn't", () => {
    expect(isConnected(status("failed", { organization: "1001", problem: "provider-failure" }))).toBe(true);
    expect(isConnected(status("failed", { organization: "1001", problem: "invalid-token" }))).toBe(false);
    expect(isConnected(status("disconnected"))).toBe(false);
  });
});

describe("Planning Center outcomes, in fixed words (spec rows 1–13)", () => {
  it("each outcome has its sentence and buttons", () => {
    expect(connectFailure(status("cancelled", { problem: "denied" }))).toMatchObject({ row: 1, alert: true, notNow: true,
      text: "You chose not to allow Ozzie in Planning Center, so nothing was connected. Ozzie can't show your service without it." });
    expect(connectFailure(status("expired"))).toMatchObject({ row: 2, text: "That took longer than 5 minutes, so Ozzie stopped waiting. Nothing was connected." });
    expect(connectFailure(status("cancelled"))).toMatchObject({ row: 3, alert: false, text: "Nothing was connected." });
    expect(connectFailure("browser-unavailable")).toMatchObject({ row: 4 });
    expect(connectFailure(status("failed", { problem: "provider-failure" }))!.text).toMatch(/^Planning Center said yes, but the internet connection dropped/u);
    expect(connectFailure(status("failed", { problem: "locked" }))).toMatchObject({ row: 10, notNow: false });
    expect(connectFailure(status("failed", { problem: "denied" }))).toMatchObject({ row: 10 });
    expect(connectFailure(status("failed", { problem: "scope-mismatch" }))).toMatchObject({ row: 11 });
    expect(connectFailure(status("failed", { problem: "organization-unverified" }))).toMatchObject({ row: 12, notNow: true });
    expect(connectFailure("rate-limited")).toMatchObject({ row: 13 });
    expect(connectFailure(status("connected"))).toBeNull();
    expect(connectFailure(status("waiting"))).toBeNull();
  });

  it("never shows native or provider text, whatever comes back", () => {
    const odd = connectFailure(status("failed", { problem: "Error: HTTP 500 at https://api.planningcenteronline.com" }))!;
    expect(odd.text).not.toMatch(/http|500|Error/u);
    expect(connectFailure({ weird: "<script>" })!.text).not.toContain("script");
  });

  it("an organization check that couldn't reach Planning Center reads as the dropped connection", () => {
    expect(connectFailure(status("failed", { problem: "provider-failure", organization_diagnostic: { version: 1, stage: "userinfo", reason: "transport-failure" } }))!.row).toBe(5);
    expect(connectFailure(status("failed", { problem: "organization-unverified", organization_diagnostic: { version: 1, stage: "userinfo", reason: "invalid-json" } }))!.row).toBe(12);
  });
});

describe("what setup remembers on this Mac", () => {
  it("only three facts, read defensively", () => {
    expect(readSetupMemory(null)).toEqual(fresh);
    expect(readSetupMemory('{"aiOffered":true,"lastAttempt":"denied","church":"Grace"}')).toEqual({ aiOffered: true, exampleSeen: false, lastAttempt: "denied", aiAnswer: null });
    expect(readSetupMemory('{"aiAnswer":"none"}').aiAnswer).toBe("none");
    expect(readSetupMemory('{"aiAnswer":"sk-proj-x"}').aiAnswer).toBeNull();
    expect(readSetupMemory('{"lastAttempt":"whatever"}').lastAttempt).toBeNull();
    expect(readSetupMemory("not json")).toEqual(fresh);
  });

  it("keeps nothing about the church", () => {
    const kept = new Map<string, string>();
    const store = setupMemory({ getItem: k => kept.get(k) ?? null, setItem: (k, v) => { kept.set(k, v); } });
    store.set({ lastAttempt: "expired" });
    store.set({ aiOffered: true });
    expect(JSON.parse(kept.get("ozzie.setup.v2")!)).toEqual({ aiOffered: true, exampleSeen: false, lastAttempt: "expired", aiAnswer: null });
  });

  it("the AI screen, once offered, is remembered as offered (mutation M12)", () => {
    const kept = new Map<string, string>();
    const store = setupMemory({ getItem: k => kept.get(k) ?? null, setItem: (k, v) => { kept.set(k, v); } });
    store.set({ aiOffered: true, aiAnswer: "later" });
    expect(setupMemory({ getItem: k => kept.get(k) ?? null, setItem: () => {} }).get()).toMatchObject({ aiOffered: true, aiAnswer: "later" });
  });
});

describe("whether choosing AI is still open on Finish setting up (review M1, spec §4.1 item 4)", () => {
  const route = (r: "none" | "own") => ({ route: r });
  it("No AI for now is an answer: the card doesn't ask again", () => {
    expect(aiStillOpen({ ...fresh, aiOffered: true, aiAnswer: "none" }, route("none"), true)).toBe(false);
  });
  it("Decide later (or leaving the screen) keeps it on the card until a way is chosen", () => {
    expect(aiStillOpen({ ...fresh, aiOffered: true, aiAnswer: "later" }, route("none"), true)).toBe(true);
    expect(aiStillOpen({ ...fresh, aiOffered: true, aiAnswer: "later" }, route("own"), true)).toBe(false);
    // Any way chosen ends it: the church's own key, AI on this Mac, Ozzie's AI (walk-through, 2026-11-18).
    for (const r of ["own", "local", "managed"]) {
      expect(aiStillOpen({ ...fresh, aiOffered: true, aiAnswer: "later" }, { route: r }, true), r).toBe(false);
      expect(aiStillOpen({ ...fresh, aiOffered: true }, { route: r }, true), r).toBe(false);
      expect(aiStillOpen(fresh, { route: r }, true), r).toBe(false);
    }
    // Left the AI screen by the sidebar or a quit: offered, no answer, so still open (spec S6).
    expect(aiStillOpen({ ...fresh, aiOffered: true }, route("none"), true)).toBe(true);
  });
  it("a church set up before the AI screen existed, with no AI and a result seen, is offered it once on the card", () => {
    expect(aiStillOpen(fresh, route("none"), true)).toBe(true);
    expect(aiStillOpen(fresh, route("none"), false)).toBe(false);
    expect(aiStillOpen(fresh, null, true)).toBe(false);
  });
});
