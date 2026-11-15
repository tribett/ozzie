import React from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => { throw new Error("NATIVE_CALL_FORBIDDEN"); }) }));
import { CardReviewController } from "../../src/card-review/controller.js";
import type { CardView } from "../../../core/src/card-review/lifecycle.js";
import { reviewedList } from "../../../core/src/card-fields.js";
import { CardsReview, checkCard, emptyUi, listFor, lookFirst, readCardsLocally, readingFor, type CardsUi, type CardTextResult, type ReadState } from "../src/cards-page.js";

// Invented people and synthetic printed-card text only. No real card or photo is used.
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const people = { "511": "Riley Thornbury", "512": "Sam Whitcombe" };
const CARD_A = "Name: Riley Thornbury\nPhone: (555) 014-2290\nEmail: riley.t@example.com\n\nPrayer request: Please pray for my\nnew job starting Monday.\n";
const CARD_B = "Name: Jordan Quillfeather\nPhone: 555 O1Z 77\nEmail:\n\nHow can we pray for you?\nFor my mom, who is in the hospital.\n";
/** No email line at all: nothing is suggested for it. */
const CARD_C = "Name: Jordan Quillfeather\nPhone: 555 O1Z 77\n\nHow can we pray for you?\nFor my mom, who is in the hospital.\n";

async function openReview(count: number) {
  const revoked: string[] = [];
  let n = 0;
  const controller = new CardReviewController("fictional-test", {
    foreground: () => true, createURL: () => `blob:fictional-${++n}`, revokeURL: url => { revoked.push(url); }, decode: async () => true,
  });
  const ticket = controller.choose(() => {})!;
  const files = Array.from({ length: count }, (_, i) => new File([PNG], `fictional-${i}.png`, { type: "image/png" }));
  expect(await controller.select(ticket, files)).toBe("ok");
  return { controller, ticket, files, revoked };
}
const cardsOf = (c: CardReviewController) => { let cards: CardView[] = []; c.render(v => { cards = [...v.cards]; }); return cards; };
const fieldsOf = (card: CardView) => Object.fromEntries((["name", "phone", "email", "request"] as const).map(f => [f, { text: card.fields[f].text, state: card.fields[f].state }]));

async function readWith(texts: (CardTextResult | Error)[], count = texts.length) {
  const review = await openReview(count);
  const states: Record<number, ReadState> = {};
  const suggested: Record<number, string[]> = {};
  let recognizer = "unknown";
  const pending = [...review.files] as (File | null)[];
  let i = 0;
  await readCardsLocally({
    controller: review.controller, ticket: review.ticket, files: pending, live: () => review.controller.status === "active",
    read: async image => { expect(image.byteLength).toBe(PNG.byteLength); const r = texts[i++]!; if (r instanceof Error) throw r; return r; },
    onState: (id, s) => { states[id] = s; }, onSuggested: (id, f) => { suggested[id] = f; }, onRecognizer: r => { recognizer = r; },
  });
  return { ...review, states, suggested, recognizer, pending };
}

describe("reading visitor cards on this Mac", () => {
  it("fills what was read cleanly, flags what wasn't, and lets go of each photo's file once read", async () => {
    const { controller, states, suggested, recognizer, pending } = await readWith([{ status: "read", text: CARD_A, unclearLines: [] }, { status: "read", text: CARD_B, unclearLines: [] }]);
    const [a, b] = cardsOf(controller);
    expect(fieldsOf(a!)).toEqual({
      name: { text: "Riley Thornbury", state: "typed" }, phone: { text: "(555) 014-2290", state: "typed" },
      email: { text: "riley.t@example.com", state: "typed" }, request: { text: "Please pray for my\nnew job starting Monday.", state: "typed" },
    });
    expect(fieldsOf(b!)).toEqual({
      name: { text: "Jordan Quillfeather", state: "typed" }, phone: { text: "", state: "unclear" },
      email: { text: "", state: "unclear" }, request: { text: "For my mom, who is in the hospital.", state: "typed" },
    });
    expect(a!.reviewed || b!.reviewed).toBe(false);
    expect(states).toEqual({ 1: "read", 2: "read" });
    expect(suggested).toEqual({ 1: ["name", "phone", "email", "request"], 2: ["name", "phone", "email", "request"] });
    expect(recognizer).toBe("available");
    expect(pending).toEqual([null, null]);
  });

  it("when this Mac can't read card text, leaves every field empty for typing", async () => {
    const { controller, states, recognizer, pending } = await readWith([{ status: "not-available" }], 2);
    expect(recognizer).toBe("not-available");
    expect(states).toEqual({ 1: "by-hand", 2: "by-hand" });
    for (const card of cardsOf(controller)) for (const f of Object.values(fieldsOf(card))) expect(f).toEqual({ text: "", state: "unreviewed" });
    expect(pending).toEqual([null, null]);
  });

  it("a card the reader fails on is left for typing; the others still read", async () => {
    const { controller, states } = await readWith([new Error("closed reason only"), { status: "read", text: CARD_A, unclearLines: [] }]);
    expect(states).toEqual({ 1: "failed", 2: "read" });
    expect(cardsOf(controller)[0]!.fields.name.state).toBe("unreviewed");
  });

  it("a line this Mac couldn't read clearly keeps its words only as a flagged suggestion to check", async () => {
    // CARD_A's lines: 0 name, 1 phone, 2 email, 3 blank, 4-5 request.
    const { controller, ticket, suggested } = await readWith([{ status: "read", text: CARD_A, unclearLines: [1, 5] }]);
    const [card] = cardsOf(controller);
    expect(fieldsOf(card!)).toEqual({
      name: { text: "Riley Thornbury", state: "typed" }, phone: { text: "(555) 014-2290", state: "unclear" },
      email: { text: "riley.t@example.com", state: "typed" }, request: { text: "Please pray for my\nnew job starting Monday.", state: "unclear" },
    });
    expect(suggested).toEqual({ 1: ["name", "phone", "email", "request"] });
    // Checking the card keeps them marked unclear in the copied list unless the person clears the mark.
    checkCard(controller, ticket, card!);
    expect(listFor(controller).text).toContain("Phone: (555) 014-2290 (unclear on the card, worth a look)");
  });

  it("a reading without well-formed unclear lines is not trusted: the card is left for typing", async () => {
    const odd = [undefined, null, "1", [-1], [1.5], ["1"]] as unknown as number[][];
    const { controller, states } = await readWith(odd.map(unclearLines => ({ status: "read", text: CARD_A, unclearLines })));
    expect(Object.values(states)).toEqual(Array(odd.length).fill("failed"));
    for (const card of cardsOf(controller)) expect(card.fields.name.state).toBe("unreviewed");
  });

  it("drops a reading that arrives after the review was discarded, and the photos' addresses are revoked", async () => {
    const review = await openReview(2);
    const pending = [...review.files] as (File | null)[];
    let release!: (r: CardTextResult) => void;
    const run = readCardsLocally({
      controller: review.controller, ticket: review.ticket, files: pending, live: () => review.controller.status === "active",
      read: () => new Promise(r => { release = r; }), onState: () => {}, onSuggested: () => {}, onRecognizer: () => {},
    });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    review.controller.discard(review.ticket);
    release({ status: "read", text: CARD_A, unclearLines: [] });
    await run;
    expect(cardsOf(review.controller)).toEqual([]);
    expect(pending).toEqual([null, null]);
    expect(review.revoked.sort()).toEqual(["blob:fictional-1", "blob:fictional-2"]);
  });
});

describe("checking and finishing", () => {
  it("a person's check makes empty fields blank on the card and keeps unclear ones marked", async () => {
    const { controller, ticket } = await readWith([{ status: "read", text: CARD_C, unclearLines: [] }]);
    expect(cardsOf(controller)[0]!.fields.email.state).toBe("unreviewed");
    expect(checkCard(controller, ticket, cardsOf(controller)[0]!)).toBe("ok");
    const card = cardsOf(controller)[0]!;
    expect(card.reviewed).toBe(true);
    expect(fieldsOf(card).email).toEqual({ text: "", state: "blank" });
    expect(fieldsOf(card).phone).toEqual({ text: "", state: "unclear" });
    controller.edit(ticket, { card: 1, field: "name", text: "Jordan Quillfeathers", state: readingFor("Jordan Quillfeathers", false) });
    expect(cardsOf(controller)[0]!.reviewed).toBe(false);
  });

  it("copies the plain list exactly as reviewed", async () => {
    const { controller, ticket } = await readWith([{ status: "read", text: CARD_A, unclearLines: [] }, { status: "read", text: CARD_B, unclearLines: [] }]);
    for (const card of cardsOf(controller)) checkCard(controller, ticket, card);
    const { text, count } = listFor(controller);
    expect(count).toBe(2);
    expect(text).toBe(reviewedList(cardsOf(controller).map(c => ({ label: c.label, fields: fieldsOf(c) as never }))));
    expect(text).toContain("Request (their exact words):\nPlease pray for my\nnew job starting Monday.");
    expect(text).toContain("Phone: unclear on the card");
    expect(controller.finish(ticket)).toBe("finished");
    expect(cardsOf(controller)).toEqual([]);
  });

  it("maps the person's two choices to a reading", () => {
    expect(readingFor("Riley", false)).toBe("typed");
    expect(readingFor("", false)).toBe("blank");
    expect(readingFor("Ri?ey", true)).toBe("unclear");
    expect(readingFor("", true)).toBe("unclear");
  });
});

describe("the review page", () => {
  const render = (controller: CardReviewController, ticket: number | null, ui: Partial<CardsUi> = {}) =>
    renderToStaticMarkup(React.createElement(CardsReview, {
      controller, ticket, ui: { ...emptyUi, ...ui }, people, onChoose() {}, onCopy() {}, onDiscard() {}, onEdited() {},
    }));

  it("explains the temporary review before any photo is chosen", () => {
    const controller = new CardReviewController("fictional-test", { foreground: () => true, createURL: () => "blob:x", revokeURL() {}, decode: async () => true });
    const html = render(controller, null);
    expect(html).toContain("Read visitor cards");
    expect(html).toContain("Choose card photos");
    expect(html).toContain("discards these cards right away");
    expect(html).toContain("Nothing here is saved in Ozzie, sent to an AI model or added to Planning Center.");
    expect(render(controller, null, { recognizer: "not-available" })).toContain("This Mac can&#x27;t read card text, so please type each card.");
    expect(html).not.toContain("Getting this Mac ready");
    // The first preparation on a Mac can take a while; it never uses a card.
    expect(render(controller, null, { recognizer: "preparing" }))
      .toContain("Getting this Mac ready to read cards. The first time can take a minute or two; nothing from your cards is used for this.");
  });

  it("puts possible matches and unclear readings first, marks every field until a person checks the card, and holds the copy until then", async () => {
    const { controller, ticket } = await readWith([{ status: "read", text: CARD_A, unclearLines: [] }, { status: "read", text: CARD_B, unclearLines: [] }]);
    const ui = { reading: { 1: "read", 2: "read" } as const, suggested: { 1: ["name", "phone", "email", "request"] as const, 2: ["name", "phone", "email", "request"] as const } };
    const html = render(controller, ticket, ui);
    const first = html.indexOf("Look at these first");
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(html.indexOf("card-1-name"));
    expect(html).toContain("Card 1: “Riley Thornbury” may already be in this Sunday&#x27;s check as Riley Thornbury. Ozzie won&#x27;t combine them.");
    expect(html).toContain("Card 2: the phone and email are hard to read.");
    expect(html).toContain("Looks right — keep the unclear parts marked");
    expect(html.match(/Needs a person to check/g)!.length).toBe(2 + 8);
    expect(html).toContain("This Mac couldn&#x27;t read this clearly. Type what you see on the card.");
    expect(html).toContain("Read by this Mac. Compare it with the photo.");
    expect(html).toMatch(/<button type="button" class="btn btn-primary" disabled="">Copy the reviewed list/);
    expect(html).toContain("Discard these cards");
    for (const card of cardsOf(controller)) checkCard(controller, ticket, card);
    const checked = render(controller, ticket, ui);
    expect(checked).not.toContain("Needs a person to check");
    expect(checked).toContain("Checked by you");
    expect(checked).toMatch(/<button type="button" class="btn btn-primary">Copy the reviewed list/);
  });

  it("shows words this Mac couldn't read clearly as a suggestion to check, worth a look", async () => {
    const { controller, ticket } = await readWith([{ status: "read", text: CARD_A, unclearLines: [1, 5] }]);
    const html = render(controller, ticket, { reading: { 1: "read" }, suggested: { 1: ["name", "phone", "email", "request"] } });
    expect(html.match(/Ozzie couldn&#x27;t read this clearly — check it against the card\./g)!.length).toBe(2);
    expect(html.match(/Worth a look<\/span>/g)!.length).toBe(2);
    expect(html).toContain('value="(555) 014-2290"');
    expect(html).toContain("Card 1: the phone and request are hard to read.");
    expect(html).toContain("Looks right — keep the unclear parts marked");
  });

  it("lists repeated names in the batch as possibly the same person, never merged", async () => {
    const { controller } = await readWith([{ status: "read", text: CARD_B, unclearLines: [] }, { status: "read", text: CARD_B, unclearLines: [] }]);
    expect(lookFirst(cardsOf(controller), {}).map(x => x.text)).toContain("Cards 1 and 2 have the same name. They may be the same person.");
  });

  it("keeps no copy anywhere: the page has no storage, logging or network code", () => {
    const source = readFileSync(new URL("../src/cards-page.tsx", import.meta.url), "utf8");
    for (const banned of ["localStorage", "sessionStorage", "indexedDB", "console.", "fetch(", "XMLHttpRequest", "caches."]) expect(source).not.toContain(banned);
  });
});
