// Visitor cards and the church Ozzie uses (review P, L4 residual): the cards are kept by the church in use, never by an
// ID typed in Settings. Cards read with no church in use stay when the first church is signed in to; a switch to
// another church ends them (Switch Ozzie to this church? says so first); so does Disconnect, which asks first. A church
// in use dropping out for a moment, or coming back, keeps them. Mounted on the fake document (test/fake-dom.ts).
// Invented people only.
import React from "react";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { installFakeDom } from "./fake-dom.js";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => new Promise(() => {})) }));
import { CardReviewController } from "../../src/card-review/controller.js";
import { cardsAt, KEPT_ENDS, KeptCards, MATCHES_NEED_CHECK, MATCHES_NEED_CHURCH, MATCHES_NEED_SIGN_IN, MATCHES_NOT_IN_EXAMPLE, readingFor, type ShownCheck } from "../src/cards-page.js";
import { needsSignIn } from "../src/connection.js";
import { DISCONNECT_CARDS_ASK, DISCONNECT_DISCARD, DISCONNECT_FAILED, DISCONNECT_KEEP, DisconnectButton } from "../src/planning-center-forms.js";

const dom = installFakeDom();
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const NAME = "Riley Thornbury";

async function readCards() {
  const controller = new CardReviewController("fictional-test", { foreground: () => true, createURL: () => "blob:fictional", revokeURL() {}, decode: async () => true });
  const ticket = controller.choose(() => {})!;
  expect(await controller.select(ticket, [new File([PNG], "fictional.png", { type: "image/png" })])).toBe("ok");
  expect(controller.edit(ticket, { card: 1, field: "name", text: NAME, state: readingFor(NAME, false) })).toBe("ok");
  return { controller, ticket };
}

/** Mounts the kept cards with two read cards and returns a way to change the church in use and the discards. */
async function mount(inUse: string | null) {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const review = await readCards();
  const root = createRoot(dom.root as unknown as Element);
  const open: number[] = [];
  const show = async (church: string | null, discarded = 0) => {
    await act(async () => { root.render(React.createElement(KeptCards, { check: null, example: false, inUse: church, disconnected: false, discarded, onOpenCards: n => open.push(n), review })); });
  };
  await show(inUse);
  return { review, show, open, unmount: () => act(async () => { root.unmount(); }) };
}

describe("visitor cards and the church Ozzie uses", () => {
  it("read with no church in use: kept when the first church is signed in to, and theirs from then on", async () => {
    const m = await mount(null);
    expect(dom.seen()).toContain(NAME);
    await m.show("1001");
    expect(dom.seen()).toContain(NAME);
    expect(m.review.controller.status).toBe("active");
    // They now belong to that church: a switch to another one ends them.
    await m.show("2002");
    expect(dom.seen()).not.toContain(NAME);
    expect(m.review.controller.status).toBe("closed");
    await m.unmount();
  });

  it("a switch to another church ends them; the same church, or none for a moment, keeps them", async () => {
    const m = await mount("1001");
    await m.show(null);
    await m.show("1001");
    expect(dom.seen()).toContain(NAME);
    expect(m.review.controller.status).toBe("active");
    await m.show("2002");
    expect(dom.seen()).not.toContain(NAME);
    expect(m.review.controller.status).toBe("closed");
    await m.unmount();
  });

  it("a church in use that drops out and comes back as another church still ends them", async () => {
    const m = await mount("1001");
    await m.show(null);
    expect(dom.seen()).toContain(NAME);
    await m.show("2002");
    expect(dom.seen()).not.toContain(NAME);
    await m.unmount();
  });

  it("Disconnect, once the leader chose it, ends them", async () => {
    const m = await mount("1001");
    await m.show("1001", 1);
    expect(dom.seen()).not.toContain(NAME);
    expect(m.review.controller.status).toBe("closed");
    await m.unmount();
  });

  it("the rule, without a page", () => {
    const at = { church: null, epoch: 0 };
    // Nothing open: the next cards belong to the church in use now.
    expect(cardsAt(at, "1001", false)).toEqual({ church: "1001", epoch: 0 });
    // Open, read with no church: the first church keeps them.
    expect(cardsAt(at, "1001", true)).toEqual({ church: "1001", epoch: 0 });
    const a = { church: "1001", epoch: 3 };
    expect(cardsAt(a, "1001", true)).toBe(a);
    expect(cardsAt(a, null, true)).toBe(a);
    expect(cardsAt(a, "2002", true)).toEqual({ church: "2002", epoch: 4 });
  });

  it("is keyed in App by the church in use and Disconnect, never by the Organization ID in Settings", () => {
    const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
    expect(app).toContain("<KeptCards check={capture && { organization: capture.organization, names: capture.names }} example={fictional} inUse={inUseOrg ?? null} discarded={cardsDiscarded}");
    // "Connect Planning Center" only when the native status says it is disconnected (review K, L5).
    expect(app).toMatch(/<KeptCards [^>]*disconnected=\{status\?\.state === "disconnected"\}/u);
    expect(app).not.toMatch(/<CardsPage /u);
    expect(app).not.toContain("workspace={org");
    // Typing an ID under Advanced changes settings, which KeptCards never reads.
    const page = readFileSync(new URL("../src/cards-page.tsx", import.meta.url), "utf8");
    const kept = page.slice(page.indexOf("export function KeptCards"), page.indexOf("export function CardsPage"));
    expect(kept).not.toMatch(/settings/u);
    // The only organization it reads is the check's own, to compare with the church in use (namesBeside).
    expect(kept.match(/organization/gu) ?? []).toEqual([]);
  });

  it("says when they end exactly, and that Disconnect and a switch ask first", () => {
    expect(KEPT_ENDS[3]).toBe("Ozzie switches to another church, or you disconnect Planning Center. Ozzie asks first.");
  });
});

describe("names offered beside visitor cards as possible matches (review G)", () => {
  // Card 1 reads "Riley Thornbury". Church 1001's check lists a Riley Thornbury; church 2002's lists someone else.
  const A: ShownCheck = { organization: "1001", names: { "511": NAME } };
  const B: ShownCheck = { organization: "2002", names: { "611": "Sam Whitcombe" } };
  const RILEY = `Possible match: ${NAME}`;
  /** `disconnected`: the native status says Planning Center is disconnected (not a sign-in being checked). */
  async function mountWith(inUse: string | null, check: ShownCheck | null, example = false, disconnected = false, signInAgain = false) {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const review = await readCards();
    const root = createRoot(dom.root as unknown as Element);
    const show = async (church: string | null, shown: ShownCheck | null, ex = false, off = false) => {
      await act(async () => { root.render(React.createElement(KeptCards, { check: shown, example: ex, inUse: church, disconnected: off, signInAgain, review })); });
    };
    await show(inUse, check, example, disconnected);
    return { show, unmount: () => act(async () => { root.unmount(); }) };
  }

  it("while connected, offers names from a check of the church in use", async () => {
    const m = await mountWith("1001", A);
    expect(dom.seen()).toContain(RILEY);
    expect(dom.seen()).not.toContain(MATCHES_NEED_CHURCH);
    await m.unmount();
  });

  it("after a disconnect, offers none, even with a saved copy of that church's check on screen", async () => {
    const m = await mountWith(null, A, false, true);
    expect(dom.seen()).toContain(NAME);
    expect(dom.seen()).not.toContain(RILEY);
    expect(dom.seen()).toContain(MATCHES_NEED_CHURCH);
    expect(MATCHES_NEED_CHURCH).toBe("Connect Planning Center to see possible matches with the people in the latest check.");
    await m.unmount();
  });

  it("while Ozzie checks its sign-in (at launch, on a refresh), offers none and doesn't ask to connect (review K, L5)", async () => {
    // Native names no church in use while it checks; Planning Center isn't disconnected.
    const m = await mountWith(null, A);
    expect(dom.seen()).toContain(NAME);
    expect(dom.seen()).not.toContain(RILEY);
    expect(dom.seen()).not.toContain(MATCHES_NEED_CHURCH);
    expect(dom.seen()).toContain(MATCHES_NEED_CHECK);
    // Checked: the church is in use again, and its names are offered.
    await m.show("1001", A);
    expect(dom.seen()).toContain(RILEY);
    // Disconnected: then, and only then, it asks to connect.
    await m.show(null, A, false, true);
    expect(dom.seen()).not.toContain(RILEY);
    expect(dom.seen()).toContain(MATCHES_NEED_CHURCH);
    await m.unmount();
  });

  it("after a sign-in Planning Center no longer accepts, says to sign in again, not to wait for a check (review M, L5)", async () => {
    const m = await mountWith(null, A, false, false, true);
    expect(dom.seen()).not.toContain(RILEY);
    expect(dom.seen()).toContain(MATCHES_NEED_SIGN_IN);
    expect(dom.seen()).not.toContain(MATCHES_NEED_CHECK);
    expect(MATCHES_NEED_SIGN_IN).toBe("Sign in to Planning Center again in Settings to see possible matches.");
    await m.unmount();
    // Which failed sign-in needs signing in again: refused or nothing to renew with, or a grant Ozzie can't keep. Planning
    // Center out of reach or an organization check that didn't finish doesn't.
    const failed = (problem: string) => ({ state: "failed" as const, problem });
    expect(needsSignIn(failed("invalid-token"))).toBe(true);
    expect(needsSignIn(failed("scope-mismatch"))).toBe(true);
    for (const problem of ["provider-failure", "organization-unverified", "busy", "cancelled"]) expect(needsSignIn(failed(problem)), problem).toBe(false);
    expect(needsSignIn({ state: "connected", problem: "invalid-token" })).toBe(false);
    expect(needsSignIn(null)).toBe(false);
  });

  it("after a first sign-in to another church, offers that church's names once it is checked, never the first one's", async () => {
    const m = await mountWith(null, A);
    // Signed in to 2002; the saved copy of 1001 is still the check last shown.
    await m.show("2002", A);
    expect(dom.seen()).toContain(NAME);
    expect(dom.seen()).not.toContain(RILEY);
    expect(dom.seen()).toContain(MATCHES_NEED_CHECK);
    expect(MATCHES_NEED_CHECK).toBe("Possible matches appear once Ozzie has run a check for the church it's using.");
    await m.show("2002", B);
    expect(dom.seen()).not.toContain(RILEY);
    expect(dom.seen()).not.toContain(MATCHES_NEED_CHECK);
    await m.unmount();
  });

  it("while connected to one church, never offers names from a saved copy of another church's check", async () => {
    const m = await mountWith("2002", A);
    expect(dom.seen()).not.toContain(RILEY);
    expect(dom.seen()).toContain(MATCHES_NEED_CHECK);
    await m.unmount();
  });

  it("while the example is on, offers no names beside real cards", async () => {
    const m = await mountWith("1001", A, true);
    expect(dom.seen()).not.toContain(RILEY);
    expect(dom.seen()).toContain(MATCHES_NOT_IN_EXAMPLE);
    expect(MATCHES_NOT_IN_EXAMPLE).toBe("While the example is on, no names are offered as possible matches: its people are made up.");
    await m.unmount();
  });
});

describe("Disconnect with visitor cards open", () => {
  /** `after`: the state the disconnect comes back with, or null when it failed (a problem shown, like not-revoked). */
  async function button(cards: number, after: "disconnected" | "connected" | null = "disconnected") {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const calls: string[] = [];
    const root = createRoot(dom.root as unknown as Element);
    const onDisconnect = async () => {
      calls.push("disconnect");
      return after === null ? null : { state: after, organization: after === "connected" ? "1001" : "", checked_at_ms: null, source: "", problem: null };
    };
    await act(async () => {
      root.render(React.createElement(DisconnectButton, { cards, working: false, onDisconnect, onDiscardCards: () => calls.push("discard") }));
    });
    const press = async (label: string) => { const b = dom.button(label); expect(b, label).not.toBeNull(); await act(async () => { dom.press(b!); }); };
    return { calls, press, unmount: () => act(async () => { root.unmount(); }) };
  }

  it("asks first, and only discards the cards when the leader chooses to disconnect", async () => {
    const b = await button(2);
    await b.press("Disconnect Planning Center");
    expect(b.calls).toEqual([]);
    expect(dom.seen()).toContain(DISCONNECT_CARDS_ASK(2));
    expect(DISCONNECT_CARDS_ASK(2)).toBe("You have 2 visitor cards open. Disconnecting discards them.");
    expect(DISCONNECT_CARDS_ASK(1)).toBe("You have 1 visitor card open. Disconnecting discards it.");
    expect([DISCONNECT_KEEP, DISCONNECT_DISCARD(2), DISCONNECT_DISCARD(1)]).toEqual(["Keep the cards and stay connected", "Disconnect and discard the cards", "Disconnect and discard the card"]);
    await b.press(DISCONNECT_KEEP);
    expect(b.calls).toEqual([]);
    expect(dom.seen()).not.toContain(DISCONNECT_CARDS_ASK(2));
    await b.press("Disconnect Planning Center");
    await b.press(DISCONNECT_DISCARD(2));
    // The cards end only once Planning Center is disconnected (review G, L-d).
    expect(b.calls).toEqual(["disconnect", "discard"]);
    expect(dom.seen()).not.toContain(DISCONNECT_FAILED);
    await b.unmount();
  });

  it("keeps the cards, and says so, when the disconnect didn't happen", async () => {
    for (const after of [null, "connected"] as const) {
      const b = await button(2, after);
      await b.press("Disconnect Planning Center");
      await b.press(DISCONNECT_DISCARD(2));
      expect(b.calls, String(after)).toEqual(["disconnect"]);
      expect(dom.seen()).toContain(DISCONNECT_FAILED);
      expect(DISCONNECT_FAILED).toBe("Planning Center is still connected, so your visitor cards are still open.");
      await b.unmount();
    }
  });

  it("with no cards open, disconnects at once, as before", async () => {
    const b = await button(0);
    await b.press("Disconnect Planning Center");
    expect(b.calls).toEqual(["disconnect"]);
    expect(dom.seen()).not.toContain("visitor card");
    await b.unmount();
  });
});
