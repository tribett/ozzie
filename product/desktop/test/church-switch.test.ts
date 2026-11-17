import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConnectionPage } from "../src/connection-page.js";
import { SetupFlow } from "../src/setup-flow.js";
import { DEFAULT_PREFS } from "../src/proactive.js";
import { SwitchQuestionPanel, SwitchWaiting, StillSignedIn, answeredCopy } from "../src/planning-center-forms.js";
import {
  attemptCopy, churchLabel, churchList, churchName, churchShort, connectionProblem, declinedCopy, followInUse, leftBehindActions, leftBehindCopy,
  missingCopy, parseDeclined, parseInUse, parseLastAttempt, parseSwitchQuestion, parseUnretired, pendingSettings, seenInUse, signInInstead, switchCopy,
  switchProblem, switchSettings, type ConnectionStatus, type SwitchQuestion,
} from "../src/connection.js";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
const asked: SwitchQuestion = {
  id: 7, to: "2002", to_name: "Fictional Hope Chapel", from: "1001", from_name: "Fictional Grace Church", from_client: "",
  others: ["1001"], fresh: true,
};
const unnamed: SwitchQuestion = { id: 8, to: "2002", from: "1001", from_client: "", others: ["1001"], fresh: true };
const found: SwitchQuestion = { id: 9, to: "6006", from: "1001", from_name: "Fictional Grace Church", from_client: "", others: ["1001"], fresh: false };
/** The church Ozzie still uses while the question is open: saved on this Mac, needing its usual check. */
const on1001 = (over: Partial<ConnectionStatus> = {}): ConnectionStatus => ({
  state: "stored-unchecked", organization: "1001", checked_at_ms: null, source: "Planning Center /oauth/userinfo", problem: null, ...over,
});
const stillOn1001 = (over: Partial<ConnectionStatus> = {}) => on1001({ switch: asked, ...over });
const settings = { clientId: "", organization: "1001", serviceTypeId: "11", planId: "22" };
const page = (status: ConnectionStatus) => renderToStaticMarkup(React.createElement(ConnectionPage, {
  status, settings, onSettings: () => {}, onStatus: () => {}, oneClick: true,
}));
const labels = (q: SwitchQuestion) => switchCopy(q).actions.map(a => [a.label, a.decision]);
// AGENTS.md: plain English, buttons that name the person's choice and its effect.
const forbidden = /\b(approve|confirm|block|skills?|sessions?|agent|log|connector|harness|token|revoke)\b/i;

describe("Switch Ozzie to this church?", () => {
  it("names both churches, asks before anything is signed out, and says what each choice does", () => {
    const shown = text(page(stillOn1001()));
    expect(shown).toContain("Switch Ozzie to Fictional Hope Chapel?");
    expect(shown).toContain("You signed in to Planning Center for Fictional Hope Chapel (organization 2002). Ozzie works with one church at a time, and it's still using Fictional Grace Church (organization 1001).");
    // Review S2, N1: Planning Center stops accepting it; it isn't only this Mac.
    expect(shown).toContain("Switching checks Fictional Hope Chapel's sign-in with Planning Center first. Then Planning Center stops accepting Ozzie's sign-in for Fictional Grace Church (organization 1001), and it's removed from this Mac. Your church's information in Planning Center doesn't change.");
    expect(shown).toContain("Saved copies of Fictional Grace Church's checks stay on this Mac. Ozzie shows them only while it uses Fictional Grace Church.");
    expect(shown).toContain("What runs automatically stays set up. Ozzie checks Fictional Hope Chapel on its schedule once you choose which of its Sundays to check.");
    expect(shown).toContain("Keeping Fictional Grace Church checks its sign-in with Planning Center first. Then Planning Center stops accepting the new sign-in for Fictional Hope Chapel, and it's removed from this Mac.");
    const html = page(stillOn1001());
    expect(html).toContain('<button type="button" class="btn btn-primary btn-sm">Switch Ozzie to Fictional Hope Chapel</button>');
    expect(html).toContain('<button type="button" class="btn btn-secondary btn-sm">Keep Ozzie on Fictional Grace Church</button>');
  });
  it("for a sign-in Ozzie found, keeps the church in use as the main choice and offers a fresh sign-in, never a switch", () => {
    // Review S2, L3: a found sign-in may not be the person's; it is never switched to as it is.
    const copy = switchCopy(found);
    expect(copy.title).toBe("Ozzie found a saved sign-in for organization 6006 on this Mac");
    expect(copy.lead).toBe("Ozzie works with one church at a time, and it's using Fictional Grace Church (organization 1001). Ozzie doesn't switch to a sign-in it found; to use organization 6006, sign in to it.");
    expect(copy.effects).toEqual([
      "Keeping Fictional Grace Church checks its sign-in with Planning Center first. Then Planning Center stops accepting the saved sign-in for organization 6006, and it's removed from this Mac.",
      "Signing in to organization 6006 opens Planning Center in your browser. After you sign in, Ozzie asks before it stops using Fictional Grace Church.",
    ]);
    expect(labels(found)).toEqual([["Keep Ozzie on Fictional Grace Church", "stay"], ["Sign in to organization 6006 instead", "sign-in"]]);
    expect(copy.title + copy.lead).not.toMatch(/from before|you signed in/i);
    const html = page(on1001({ switch: found }));
    expect(html).toContain('<button type="button" class="btn btn-primary btn-sm">Keep Ozzie on Fictional Grace Church</button>');
    expect(html).toContain('<button type="button" class="btn btn-secondary btn-sm">Sign in to organization 6006 instead</button>');
    expect(html).not.toContain("Switch Ozzie to");
    expect(switchProblem("sign-in-instead", found)).toBe("Ozzie doesn't switch to a sign-in it found. To use organization 6006, choose Sign in to organization 6006 instead.");
    expect(answeredCopy({ decision: "sign-in", question: found, stake: { from: false, to: false } }, false)).toBe(
      "Ozzie still uses Fictional Grace Church (organization 1001). Sign in to organization 6006; once you have, Ozzie asks before it stops using Fictional Grace Church.");
  });
  it("with visitor cards open, says first that switching discards them, on the page and in setup (review P, L4)", () => {
    // The cards are kept per church (cards-page.tsx `workspace`): a switch ends them, so the question says so first.
    expect(switchCopy(asked, { from: false, to: false }, 3).effects[0]).toBe("You have 3 visitor cards open. Switching churches discards them.");
    expect(switchCopy(asked, { from: false, to: false }, 1).effects[0]).toBe("You have 1 visitor card open. Switching churches discards it.");
    expect(switchCopy(asked).effects.join(" ")).not.toContain("visitor card");
    // Keeping the church in use keeps them, and a found sign-in never switches, so neither says it.
    expect(switchCopy(found, { from: false, to: false }, 3).effects.join(" ")).not.toContain("visitor card");
    const shown = text(renderToStaticMarkup(React.createElement(ConnectionPage, {
      status: stillOn1001(), settings, onSettings: () => {}, onStatus: () => {}, oneClick: true, cards: 2,
    })));
    expect(shown).toContain("You have 2 visitor cards open. Switching churches discards them.");
    expect(text(page(stillOn1001()))).not.toContain("visitor card");
  });
  it("says truthfully what happens to Church rules set for a church's own teams and rooms", () => {
    const set = switchCopy(asked, { from: true, to: false }).effects;
    expect(set).toContain("Church rules for Fictional Grace Church's teams and rooms (kids teams, background checks, Sunday leads, room rules and what you told Ozzie about its findings) stay with Fictional Grace Church and don't apply to Fictional Hope Chapel. You can set them for Fictional Hope Chapel in Church rules.");
    expect(switchCopy(asked, { from: true, to: true }).effects.join(" ")).toContain("The ones you set for Fictional Hope Chapel before come back.");
    expect(switchCopy(asked, { from: false, to: true }).effects).toContain("Church rules you set for Fictional Hope Chapel's teams and rooms before come back.");
    expect(switchCopy(asked).effects.join(" ")).not.toContain("Church rules");
    expect(answeredCopy({ decision: "switch", question: asked, stake: { from: true, to: false } }, false)).toBe(
      "Ozzie now uses Fictional Hope Chapel (organization 2002). Choose which of its Sundays to check below. Church rules for Fictional Grace Church's teams and rooms are kept for that church. You can set Fictional Hope Chapel's in Church rules.");
    expect(answeredCopy({ decision: "stay", question: asked, stake: { from: false, to: false } }, false)).toBe(
      "Ozzie still uses Fictional Grace Church (organization 1001). Planning Center no longer accepts the sign-in for Fictional Hope Chapel, and it's removed from this Mac.");
    expect(answeredCopy({ decision: "stay", question: asked, stake: { from: false, to: false } }, true)).toBe("Ozzie still uses Fictional Grace Church (organization 1001).");
  });
  it("keeps numbers where there's no name, and numbers in the buttons when both names are the same", () => {
    const copy = switchCopy(unnamed);
    expect(copy.title).toBe("Switch Ozzie to this church?");
    expect(copy.lead).toBe("You signed in to Planning Center for organization 2002. Ozzie works with one church at a time, and it's still using organization 1001.");
    expect(labels(unnamed)).toEqual([["Switch Ozzie to organization 2002", "switch"], ["Keep Ozzie on organization 1001", "stay"]]);
    expect(labels({ ...asked, to_name: "Fictional Grace Church" }).map(l => l[0])).toEqual(["Switch Ozzie to Fictional Grace Church (2002)", "Keep Ozzie on Fictional Grace Church (1001)"]);
    const several = switchCopy({ ...asked, others: ["1001", "3003"] }).effects[0];
    expect(several).toContain("stops accepting Ozzie's sign-ins for Fictional Grace Church (organization 1001) and organization 3003, and they're removed from this Mac.");
    expect(churchList([{ organization: "1" }, { organization: "2" }, { organization: "3", name: "C" }])).toBe("organization 1, organization 2 and C (organization 3)");
    expect([churchLabel("1", "A"), churchShort("1"), churchShort("1", "A", "A")]).toEqual(["A (organization 1)", "organization 1", "A (1)"]);
  });
  it("holds signing in, other IDs, disconnecting and cancelling until the person answers", () => {
    const html = page(stillOn1001());
    expect(html).toMatch(/<button class="btn btn-secondary" disabled="">Connect Planning Center<\/button>/);
    expect(html).toMatch(/<button class="btn btn-secondary" disabled="">Also check rooms, follow-ups and group events<\/button>/);
    expect(html).not.toContain("Disconnect and revoke access");
    expect(html).toMatch(/<input id="[^"]+-org" inputMode="numeric" autoComplete="off" spellCheck="false" disabled="" value="1001"\/>/);
    expect(html).toMatch(/<button class="btn btn-secondary">Check saved connection<\/button>/);
    expect(page(stillOn1001({ state: "checking" }))).not.toContain("Cancel sign-in");
    expect(page(on1001({ state: "checking" }))).toContain("Cancel sign-in");
    const before = page(on1001({ state: "connected", checked_at_ms: 1_000, organization_name: "Fictional Grace Church" }));
    expect(before).not.toContain("Switch Ozzie to");
    expect(before).toContain("Disconnect and revoke access");
    expect(text(before)).toContain("Connected. Planning Center confirmed Fictional Grace Church (organization 1001) at");
    // The Connected line shows a name only as display text (review S2, M1).
    expect(text(page(on1001({ state: "connected", checked_at_ms: 1_000, organization_name: "\u202eGrace\u200b" }))))
      .toContain("Planning Center confirmed Grace (organization 1001)");
    expect(text(page(on1001({ state: "connected", checked_at_ms: 1_000, organization_name: "\u200b" }))))
      .toContain("Planning Center confirmed organization 1001 at");
  });
  it("is asked in guided setup too", () => {
    const html = renderToStaticMarkup(React.createElement(SetupFlow, {
      status: stillOn1001(), settings, onSettings() {}, onStatus() {}, prefs: DEFAULT_PREFS, onModel() {}, onClose() {}, onExample() {}, onAutomatic() {},
      initial: "connect",
    }));
    expect(text(html)).toContain("Switch Ozzie to Fictional Hope Chapel?");
    // With visitor cards open, setup's question says what switching does to them, as Settings does (review P, L4).
    const withCards = renderToStaticMarkup(React.createElement(SetupFlow, {
      status: stillOn1001(), settings, onSettings() {}, onStatus() {}, prefs: DEFAULT_PREFS, onModel() {}, onClose() {}, onExample() {}, onAutomatic() {},
      initial: "connect", cards: 1,
    }));
    expect(text(withCards)).toContain("You have 1 visitor card open. Switching churches discards it.");
  });
  it("uses only plain words, and never calls the tool a person", () => {
    for (const q of [asked, unnamed, found, { ...asked, fresh: false, others: ["1001", "3003"] }]) {
      for (const stake of [{ from: true, to: true }, { from: false, to: false }]) {
        const copy = switchCopy(q, stake);
        for (const line of [copy.title, copy.lead, ...copy.effects, ...copy.actions.map(a => a.label)]) expect(line).not.toMatch(forbidden);
      }
    }
    expect(declinedCopy("6006", { organization: "1001", name: "Fictional Grace Church" })).not.toMatch(forbidden);
    for (const reason of ["revoke-failed", "refused", "locked", "denied", "unavailable", "unfinished"] as const) {
      for (const ozzie_registration of [true, false, undefined]) {
        expect(leftBehindCopy({ organization: "1001", reason, ...(ozzie_registration === undefined ? {} : { ozzie_registration }) })).not.toMatch(forbidden);
      }
    }
    const banner = text(renderToStaticMarkup(React.createElement(SwitchWaiting, { question: asked, onOpen: () => {} })));
    expect(banner).toContain("Ozzie is still using Fictional Grace Church (organization 1001). A sign-in for Fictional Hope Chapel (organization 2002) is waiting for you to choose which church Ozzie uses.");
    expect(banner).not.toMatch(forbidden);
  });
  it("disables both answers while one is being carried out", () => {
    const html = renderToStaticMarkup(React.createElement(SwitchQuestionPanel, { question: asked, stake: { from: false, to: false }, working: true, onAnswer: () => {} }));
    expect(html.match(/disabled=""/g)).toHaveLength(2);
    expect(html).toContain('role="group" aria-labelledby="switch-church-q"');
  });
});

describe("when an answer changes nothing", () => {
  it("says which church couldn't be checked and why, in fixed words", () => {
    expect(switchProblem({ "keep-unchecked": "invalid-token" }, asked)).toBe(
      "Fictional Grace Church's sign-in no longer works with Planning Center, so nothing changed. You can switch to Fictional Hope Chapel now and sign in to Fictional Grace Church again afterwards; Ozzie asks before signing out of either.");
    expect(switchProblem({ "keep-unchecked": "provider-failure" }, unnamed)).toBe(
      "Ozzie couldn't reach Planning Center to check organization 1001's sign-in, so nothing changed. Try again when this Mac is online.");
    expect(switchProblem({ "keep-unchecked": { store: "locked" } }, asked)).toBe(
      "The Mac’s credential storage is locked, so Ozzie couldn't check Fictional Grace Church's sign-in. Nothing changed. Unlock it, then try again.");
    expect(switchProblem({ "switch-unchecked": "invalid-token" }, unnamed)).toBe(
      "Organization 2002's sign-in no longer works with Planning Center, so nothing changed. Keep organization 1001, or sign in to organization 2002 again.");
    expect(switchProblem({ "switch-unchecked": { store: "denied" } }, asked)).toBe(
      "The Mac didn't allow Ozzie to read Fictional Hope Chapel's sign-in. Nothing changed. Allow access in macOS, then try again.");
    expect(connectionProblem({ "switch-unchecked": { store: "denied" } })).not.toContain("Planning Center");
    expect(switchProblem("no-question", asked)).toBe("That question was already answered or replaced. The current one is shown here.");
    expect(connectionProblem("switch-pending")).toBe("Answer the question about switching churches first.");
    expect(connectionProblem("sign-in-instead")).toBe("Ozzie doesn't switch to a sign-in it found. To use that church, sign in to it instead.");
  });
});

describe("sign-ins Ozzie couldn't sign out of yet", () => {
  it("gives each its own reason, a retry for what may still work, and a truthful way out for what Planning Center refused", () => {
    expect(leftBehindCopy({ organization: "1001", name: "Fictional Grace Church", reason: "revoke-failed" })).toBe(
      "Ozzie couldn't sign out of Fictional Grace Church (organization 1001) yet because Planning Center couldn't be reached. That sign-in stays saved on this Mac until Ozzie signs out of it. Try again when this Mac is online.");
    // Review S2, N3: a refused read may be of the church kept, not only the one left behind.
    expect(leftBehindCopy({ organization: "1001", reason: "denied" })).toBe(
      "Ozzie couldn't sign out of organization 1001 yet because the Mac didn't allow Ozzie to read the sign-ins it needed. That sign-in stays saved on this Mac until Ozzie signs out of it. Allow access in macOS, then try again.");
    // Review S2, M2 and N2: removing doesn't sign it out at Planning Center; where to disconnect it there.
    expect(leftBehindCopy({ organization: "3003", reason: "refused", ozzie_registration: true })).toBe(
      "Planning Center wouldn't sign Ozzie out of organization 3003, so that sign-in is still saved on this Mac. Trying again may not help. Ozzie can remove it from this Mac, but it may stay active at Planning Center until it expires or an administrator disconnects it there (Account Settings, Integrations, where it's listed as Ozzie for Mac).");
    expect(leftBehindCopy({ organization: "3003", reason: "refused", ozzie_registration: false })).toContain(
      "(Account Settings, Integrations, where it's listed under the registration typed in Ozzie's Advanced settings).");
    const both = { left: [{ organization: "1001", reason: "denied" as const }, { organization: "3003", reason: "refused" as const }] };
    expect(leftBehindActions(both)).toEqual({ retryLabel: "Try signing out of organization 1001 again", removeLabel: "Remove that sign-in from this Mac anyway" });
    const html = renderToStaticMarkup(React.createElement(StillSignedIn, { unretired: both, working: false, onRetry: () => {}, onRemove: () => {} }));
    expect(text(html)).toContain("Try signing out of organization 1001 again");
    expect(text(html)).toContain("Remove that sign-in from this Mac anyway");
  });
  it("hides both actions while a question is open (native code refuses them too)", () => {
    const left = { left: [{ organization: "1001", reason: "revoke-failed" as const }] };
    const asking = text(page(on1001({ switch: { ...asked, to: "1001", from: "2002", others: ["2002"] }, organization: "2002", unretired: left })));
    expect(asking).toContain("Ozzie couldn't sign out of organization 1001 yet");
    expect(asking).not.toContain("Try signing out of");
    expect(asking).toContain("Answer the question above first; then you can try again here.");
    expect(text(page(on1001({ state: "connected", organization: "2002", unretired: left })))).toContain("Try signing out of organization 1001 again");
  });
});

describe("church names: one rule, the same on both sides", () => {
  const parity = JSON.parse(readFileSync(new URL("../../../core/test/church-name-parity.json", import.meta.url), "utf8")) as
    { cases: { label: string; input: string; expected: string | null }[] };
  it("matches native code on every shared case, and is stable on its own output", () => {
    expect(parity.cases.length).toBeGreaterThanOrEqual(20);
    for (const { label, input, expected } of parity.cases) {
      expect(churchName(input), label).toBe(expected ?? undefined);
      if (expected !== null) expect(churchName(expected), `${label} again`).toBe(expected);
    }
  });
  it("shows the question for every name native code passes on, and the number for every name it drops", () => {
    for (const { label, input, expected } of parity.cases) {
      // What native code sends: the filtered name, or none.
      const sent = expected === null ? {} : { to_name: expected, from_name: expected };
      const q = parseSwitchQuestion({ ...asked, to_name: undefined, from_name: undefined, ...sent });
      expect(q, label).toBeDefined();
      expect(q?.to_name, label).toBe(expected ?? undefined);
      if (expected === null) expect(switchCopy(q!).actions[0]!.label, label).toBe("Switch Ozzie to organization 2002");
      // Even a raw, unfiltered name never hides the question, the church in use or what is left behind.
      const raw = parseSwitchQuestion({ ...asked, to_name: input, from_name: input });
      expect(raw?.to_name, `${label} raw`).toBe(expected ?? undefined);
      expect(parseInUse({ organization: "2002", client_id: "", name: input })?.organization, label).toBe("2002");
      expect(parseUnretired({ left: [{ organization: "2002", name: input, reason: "refused" }] })?.left[0]?.name, label).toBe(expected ?? undefined);
    }
    expect(parseSwitchQuestion({ ...asked, to_name: 7 })?.to_name).toBeUndefined();
  });
});

describe("what the page trusts from native code", () => {
  it("shows a question only when every other field is well formed", () => {
    expect(parseSwitchQuestion(asked)).toEqual(asked);
    expect(parseSwitchQuestion(unnamed)).toEqual(unnamed);
    for (const bad of [
      null, "2002", [], { ...asked, to: "1001" }, { ...asked, to: "02002" }, { ...asked, others: [] }, { ...asked, others: ["3003"] },
      { ...asked, others: ["1001", "2002"] }, { ...asked, fresh: "yes" }, { ...asked, from_client: "a\nb" }, { ...asked, others: "1001" },
      { ...asked, id: -1 }, { ...asked, id: "7" },
      Object.assign(Object.create({ polluted: true }) as object, asked),
    ]) expect(parseSwitchQuestion(bad)).toBeUndefined();
    expect(parseUnretired({ left: [{ organization: "1001", reason: "refused", ozzie_registration: true }] }))
      .toEqual({ left: [{ organization: "1001", reason: "refused", ozzie_registration: true }] });
    for (const bad of [{ left: [] }, { left: [{ organization: "1001", reason: "other" }] }, { left: [{ organization: "x", reason: "locked" }] }]) {
      expect(parseUnretired(bad)).toBeUndefined();
    }
    expect(parseInUse({ organization: "02002", client_id: "" })).toBeUndefined();
  });
});

describe("which church Settings shows", () => {
  it("keeps the church Ozzie still uses while the question is open, even over IDs typed for the new one", () => {
    const typed = { clientId: "fictional-own-client", organization: "2002", serviceTypeId: "11", planId: "22" };
    expect(pendingSettings(typed, asked)).toEqual({ clientId: "", organization: "1001", serviceTypeId: "11", planId: "22" });
    expect(pendingSettings(settings, asked)).toBeNull();
  });
  it("takes the church the answer names, clearing the chosen Sunday only for a different church", () => {
    expect(switchSettings(settings, { client_id: "", organization: "2002" })).toEqual({ clientId: "", organization: "2002", serviceTypeId: "", planId: "" });
    expect(switchSettings(settings, { client_id: "", organization: "1001" })).toEqual(settings);
    expect(switchSettings(settings, { client_id: "", organization: "01" })).toBe(settings);
  });
  it("follows the church native code uses at a launch, keeping the chosen Sunday when it is that church's (review S3, L1)", () => {
    const sunday = { serviceTypeId: "11", planId: "22" };
    // IDs typed under Advanced for 6006, then a quit: native code kept 1001, the church whose Sunday this is.
    const typed = { clientId: "fictional-own-client", organization: "6006", ...sunday };
    expect(followInUse(typed, { organization: "1001", client_id: "" }, null, "1001|")).toEqual({
      settings: { clientId: "", organization: "1001", ...sunday }, last: "1001|",
    });
    // A switch carried out just before a quit the page never heard back from: 2002 is in use, and 1001's Sunday goes.
    expect(followInUse({ ...settings, ...sunday }, { organization: "2002", client_id: "" }, null, "1001|")).toEqual({
      settings: { clientId: "", organization: "2002", serviceTypeId: "", planId: "" }, last: "2002|",
    });
    // While Ozzie runs, IDs being typed aren't undone; and nothing moves when Settings already name the church in use.
    expect(followInUse(typed, { organization: "1001", client_id: "" }, "1001|", "1001|")).toEqual({ settings: null, last: "1001|" });
    expect(followInUse({ ...settings, ...sunday }, { organization: "1001", client_id: "" }, null, null)).toEqual({ settings: null, last: "1001|" });
    // Nothing recorded on this Mac yet (an upgrade): another church clears the Sunday, as before.
    expect(followInUse(typed, { organization: "1001", client_id: "" }, null, null).settings).toEqual({ clientId: "", organization: "1001", serviceTypeId: "", planId: "" });
  });
  it("remembers the church last seen in use on this Mac only, and ignores a damaged record", () => {
    const stored = new Map<string, string>();
    const local = { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => { stored.set(k, v); }, removeItem: (k: string) => { stored.delete(k); } };
    const previous = (globalThis as { localStorage?: unknown }).localStorage;
    (globalThis as { localStorage?: unknown }).localStorage = local;
    try {
      expect(seenInUse.get()).toBeNull();
      seenInUse.set("1001|fictional-own-client");
      expect(seenInUse.get()).toBe("1001|fictional-own-client");
      for (const bad of ["01001|", "1001", "1001|a|b", "x|", "1001|a\nb"]) {
        stored.set("ozzie.church-in-use-seen.v1", bad);
        expect(seenInUse.get(), bad).toBeNull();
      }
    } finally {
      (globalThis as { localStorage?: unknown }).localStorage = previous;
    }
  });
});

describe("Sign in to X instead (review S3, M1 and L3)", () => {
  it("starts a sign-in with the registration in use, and never puts X into Settings", () => {
    const own = { ...settings, clientId: "fictional-own-client" };
    // The church's own registration, built in or not: a sign-in with those IDs, for X.
    expect(signInInstead(own, "6006", true, true)).toEqual({ clientId: "fictional-own-client", organization: "6006", registered: true });
    expect(signInInstead(own, "6006", false, false)).toEqual({ clientId: "fictional-own-client", organization: "6006", registered: false });
    // Ozzie's own registration: one click.
    expect(signInInstead(settings, "6006", true, true)).toBe("one-click");
    // Neither (a copy built without Ozzie's registration, and no IDs typed): nothing starts.
    expect(signInInstead(settings, "6006", true, false)).toBeNull();
    expect(signInInstead(own, "06006", true, true)).toBeNull();
    // What it hands back names no Sunday and no Settings to apply.
    expect(Object.keys(signInInstead(own, "6006", true, true) as object).sort()).toEqual(["clientId", "organization", "registered"]);
  });
});

describe("a check of a church Ozzie doesn't use without a new sign-in (review S3, M1 and L1)", () => {
  const declinedStatus = (over: Partial<ConnectionStatus> = {}): ConnectionStatus => on1001({
    state: "connected", checked_at_ms: 1_000, organization_name: "Fictional Grace Church", declined: "6006",
    in_use: { organization: "1001", client_id: "", name: "Fictional Grace Church" }, ...over,
  });
  it("says plainly which church Ozzie still uses, and how to use the other", () => {
    expect(declinedCopy("6006", { organization: "1001", name: "Fictional Grace Church" })).toBe(
      "Ozzie still uses Fictional Grace Church (organization 1001). To use organization 6006 instead, sign in to it.");
    expect(text(page(declinedStatus()))).toContain("Ozzie still uses Fictional Grace Church (organization 1001). To use organization 6006 instead, sign in to it.");
    // Not when the question already asks about that church, and not about the church in use.
    expect(text(page(declinedStatus({ switch: found })))).not.toContain("instead, sign in to it");
    expect(text(page(declinedStatus({ declined: "1001" })))).not.toContain("instead, sign in to it");
    expect([parseDeclined("6006"), parseDeclined("06006"), parseDeclined(6006), parseDeclined(undefined)]).toEqual(["6006", undefined, undefined, undefined]);
  });
  it("reports a sign-in Ozzie hadn't finished signing out of when it closed, with a retry", () => {
    const left = { left: [{ organization: "1001", name: "Fictional Grace Church", reason: "unfinished" as const }] };
    expect(parseUnretired(left)).toEqual(left);
    expect(leftBehindCopy(left.left[0]!)).toBe(
      "Ozzie hadn't finished signing out of Fictional Grace Church (organization 1001) when it last closed. That sign-in stays saved on this Mac until Ozzie signs out of it. Try again now.");
    expect(leftBehindActions(left)).toEqual({ retryLabel: "Try signing out of Fictional Grace Church (organization 1001) again", removeLabel: null });
  });
});

describe("a sign-in that didn't connect while a church was in use (review S4, M1)", () => {
  const grace = { organization: "1001", client_id: "", name: "Fictional Grace Church" };
  /** 1001 back in use (saved, not yet checked again) after a sign-in that ended as `attempt`. */
  const restored = (attempt: Partial<ConnectionStatus>, over: Partial<ConnectionStatus> = {}): ConnectionStatus => on1001({
    organization_name: "Fictional Grace Church", in_use: grace, scopes: "services",
    last_attempt: { state: "cancelled", organization: "", checked_at_ms: null, source: "", problem: null, ...attempt }, ...over,
  });
  const mismatch = { state: "failed" as const, organization: "3003", problem: "organization-unverified",
    organization_diagnostic: { version: 1 as const, stage: "organization-binding" as const, reason: "organization-mismatch" as const } };
  it("Sign in again, cancelled: says so where it always did, with the church Ozzie still uses", () => {
    const shown = text(page(restored({ state: "cancelled" })));
    expect(shown).toContain("Sign-in was cancelled on this Mac. Ozzie still uses Fictional Grace Church (organization 1001).");
    expect(shown).not.toContain("hasn't been checked yet");
  });
  it("the rooms, follow-ups and group events opt-in, refused at Planning Center: said in the sign-in section as before", () => {
    const shown = text(page(restored({ state: "cancelled" })));
    const line = shown.indexOf("Sign-in was cancelled on this Mac. Ozzie still uses Fictional Grace Church (organization 1001).");
    expect(line).toBeGreaterThan(-1);
    expect(line).toBeLessThan(shown.indexOf("Rooms, follow-ups and group events"));
    expect(page(restored({ state: "cancelled" }))).toMatch(/<button class="btn btn-secondary">Also check rooms, follow-ups and group events<\/button>/);
  });
  it("IDs typed under Advanced for the wrong organization: the reason, as an alert, in a copy without Ozzie's registration", () => {
    const own = { clientId: "fictional-own-client", organization: "1001", serviceTypeId: "11", planId: "22" };
    const html = renderToStaticMarkup(React.createElement(ConnectionPage, {
      status: restored(mismatch, { in_use: { ...grace, client_id: "fictional-own-client" } }), settings: own, onSettings: () => {}, onStatus: () => {}, oneClick: false,
    }));
    expect(html).toContain('<p role="alert" class="problem">You signed in to a different Planning Center organization than the one in Ozzie&#x27;s settings.');
    expect(text(html)).toContain("check the organization ID under Advanced. Nothing new was saved. Ozzie still uses Fictional Grace Church (organization 1001).");
  });
  it("Sign in to X instead, left to expire: in Settings and in guided setup", () => {
    const line = "Sign-in expired before it finished. Ozzie still uses Fictional Grace Church (organization 1001).";
    expect(text(page(restored({ state: "expired" })))).toContain(line);
    const setup = renderToStaticMarkup(React.createElement(SetupFlow, {
      status: restored({ state: "expired" }), settings, onSettings() {}, onStatus() {}, prefs: DEFAULT_PREFS, onModel() {}, onClose() {}, onExample() {},
      onAutomatic() {}, initial: "connect",
    }));
    expect(text(setup)).toContain(line);
  });
  it("goes once native code clears it (a new sign-in or check started), and is shown only for an ended sign-in", () => {
    expect(text(page(on1001({ in_use: grace })))).toContain("A connection is saved on this Mac but hasn't been checked yet.");
    expect(text(page(on1001({ in_use: grace })))).not.toContain("Ozzie still uses");
    for (const bad of [null, "cancelled", [], { state: "waiting" }, { state: "connected", organization: "1001" }]) {
      expect(parseLastAttempt(bad)).toBeUndefined();
    }
    expect(parseLastAttempt(mismatch)).toEqual({ ...mismatch, checked_at_ms: null, source: "" });
    // Without a church in use there is nothing to keep: the sign-in's own status says it, as always.
    expect(text(page(on1001({ state: "cancelled", last_attempt: { state: "cancelled", organization: "", checked_at_ms: null, source: "", problem: null } }))))
      .toContain("Sign-in was cancelled on this Mac.");
  });
  it("uses plain words", () => {
    for (const attempt of [{ state: "cancelled" as const }, { state: "expired" as const }, mismatch]) {
      expect(attemptCopy({ organization: "", checked_at_ms: null, source: "", problem: null, ...attempt }, grace)).not.toMatch(forbidden);
    }
    expect(missingCopy("1001", { organization: "2002", name: "Fictional Hope Chapel" })).not.toMatch(forbidden);
  });
});

describe("a record naming a church whose sign-in is gone (review S4, L3)", () => {
  it("says plainly that Ozzie now uses the church in Settings", () => {
    const status = on1001({ state: "connected", organization: "2002", organization_name: "Fictional Hope Chapel", checked_at_ms: 1_000, missing: "1001",
      in_use: { organization: "2002", client_id: "", name: "Fictional Hope Chapel" } });
    const line = "The sign-in for organization 1001, the church Ozzie used last, is no longer on this Mac, so Ozzie now uses Fictional Hope Chapel (organization 2002).";
    expect(missingCopy("1001", { organization: "2002", name: "Fictional Hope Chapel" })).toBe(line);
    expect(text(renderToStaticMarkup(React.createElement(ConnectionPage, {
      status, settings: { ...settings, organization: "2002" }, onSettings: () => {}, onStatus: () => {}, oneClick: true,
    })))).toContain(line);
    expect(text(page(on1001({ state: "connected", checked_at_ms: 1_000, missing: "02002" })))).not.toContain("no longer on this Mac");
  });
});
