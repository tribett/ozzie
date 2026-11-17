// Visitor cards behind "Show the cards" (audit item 20, review P L1): the page mounted with React and two read cards on
// screen, then Ozzie's window off screen and back. No card's words may show again until the leader presses Show the
// cards. Invented people only; the fake document is test/fake-dom.ts.
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { installFakeDom } from "./fake-dom.js";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => new Promise(() => {})) }));
import { CardReviewController } from "../../src/card-review/controller.js";
import { CardsPage, readingFor, SHOW_CARDS, veiledText } from "../src/cards-page.js";

const dom = installFakeDom();
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const NAME = "Riley Thornbury", REQUEST = "Please pray for my new job starting Monday.";

async function readCards() {
  let n = 0;
  const controller = new CardReviewController("fictional-test", {
    foreground: () => true, createURL: () => `blob:fictional-${++n}`, revokeURL() {}, decode: async () => true,
  });
  const ticket = controller.choose(() => {})!;
  const files = [0, 1].map(i => new File([PNG], `fictional-${i}.png`, { type: "image/png" }));
  expect(await controller.select(ticket, files)).toBe("ok");
  expect(controller.edit(ticket, { card: 1, field: "name", text: NAME, state: readingFor(NAME, false) })).toBe("ok");
  expect(controller.edit(ticket, { card: 1, field: "request", text: REQUEST, state: readingFor(REQUEST, false) })).toBe("ok");
  return { controller, ticket };
}

describe("visitor cards wait behind Show the cards once the window was off screen", () => {
  it("shows no card's words after the window comes back until Show the cards is pressed", async () => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const review = await readCards();
    const root = createRoot(dom.root as unknown as Element);
    const page = (onScreen: boolean) => React.createElement(CardsPage, { people: {}, workspace: "fictional-test", onScreen, review });
    await act(async () => { root.render(page(true)); });
    // On screen: the cards are there to check, each beside its photo.
    expect(dom.seen()).toContain(NAME);
    expect(dom.seen()).toContain(REQUEST);
    expect(dom.pictures()).toEqual(["blob:fictional-1", "blob:fictional-2"]);
    expect(dom.button(SHOW_CARDS)).toBeNull();

    // The window goes off screen (closed, the screen locked, the Mac asleep)...
    await act(async () => { root.render(page(false)); });
    // ...and comes back: nothing from a card, only how many are open and the button.
    await act(async () => { root.render(page(true)); });
    expect(dom.seen()).not.toContain(NAME);
    expect(dom.seen()).not.toContain(REQUEST);
    // No photo either: no picture, and no photo's address anywhere in the page (review F, L1 residue).
    expect(dom.pictures()).toEqual([]);
    expect(dom.seen()).not.toContain("blob:");
    expect(dom.seen()).toContain(veiledText(2));
    const show = dom.button(SHOW_CARDS);
    expect(show).not.toBeNull();
    // The cards are still open (kept in memory), only out of sight.
    expect(review.controller.status).toBe("active");

    await act(async () => { dom.press(show!); });
    expect(dom.seen()).toContain(NAME);
    expect(dom.seen()).toContain(REQUEST);
    expect(dom.pictures()).toEqual(["blob:fictional-1", "blob:fictional-2"]);
    expect(dom.button(SHOW_CARDS)).toBeNull();
    await act(async () => { root.unmount(); });
  });

  it("stays as it was while the window stays on screen", async () => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const review = await readCards();
    const root = createRoot(dom.root as unknown as Element);
    await act(async () => { root.render(React.createElement(CardsPage, { people: {}, workspace: "fictional-test", onScreen: true, review })); });
    await act(async () => { root.render(React.createElement(CardsPage, { people: {}, workspace: "fictional-test", onScreen: true, review })); });
    expect(dom.seen()).toContain(NAME);
    expect(dom.button(SHOW_CARDS)).toBeNull();
    await act(async () => { root.unmount(); });
  });
});
