import React from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => { throw new Error("NATIVE_CALL_FORBIDDEN"); }) }));
import { CardReviewController } from "../../src/card-review/controller.js";
import type { CardView } from "../../../core/src/card-review/lifecycle.js";
import { readLines, reviewedList, type ReadLine } from "../../../core/src/card-fields.js";
import {
  cardPhotoFiles, CardsReview, checkCard, emptyUi, escapeCloses, listFor, lookFirst, pickCards, PICK_PROBLEM, placeLine, readCardsLocally, readingFor,
  type CardsUi, type CardTextResult, type FieldSource, type ReadState,
} from "../src/cards-page.js";

// Invented people and synthetic printed-card text only. No real card or photo is used.
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
/** The Mac's reply to "Choose card photos" (src-tauri/src/card_picker.rs `frame`): kind, 4-byte length, bytes. */
const frameOf = (...photos: [number, Uint8Array][]) => {
  const out = new Uint8Array(photos.reduce((n, [, b]) => n + 5 + b.byteLength, 0));
  let at = 0;
  for (const [kind, bytes] of photos) {
    out[at] = kind; new DataView(out.buffer).setUint32(at + 1, bytes.byteLength); out.set(bytes, at + 5); at += 5 + bytes.byteLength;
  }
  return out;
};
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
  const suggested: Record<number, Partial<Record<string, FieldSource>>> = {};
  const lines: Record<number, readonly ReadLine[]> = {};
  let recognizer = "unknown";
  const pending = [...review.files] as (File | null)[];
  let i = 0;
  await readCardsLocally({
    controller: review.controller, ticket: review.ticket, files: pending, live: () => review.controller.status === "active",
    read: async image => { expect(image.byteLength).toBe(PNG.byteLength); const r = texts[i++]!; if (r instanceof Error) throw r; return r; },
    onState: (id, s) => { states[id] = s; }, onSuggested: (id, f) => { suggested[id] = f; }, onRead: (id, l) => { lines[id] = l; },
    onRecognizer: r => { recognizer = r; },
  });
  return { ...review, states, suggested, lines, recognizer, pending };
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
    expect(suggested).toEqual({ 1: { name: "read", phone: "read", email: "read", request: "read" }, 2: { name: "read", phone: "read", email: "read", request: "read" } });
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
    expect(suggested).toEqual({ 1: { name: "read", phone: "read", email: "read", request: "read" } });
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
      read: () => new Promise(r => { release = r; }), onState: () => {}, onSuggested: () => {}, onRead: () => { throw new Error("read lines kept after discard"); }, onRecognizer: () => {},
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
  const render = (controller: CardReviewController, ticket: number | null, ui: Partial<CardsUi> = {}, lines: Record<number, readonly ReadLine[]> = {}) =>
    renderToStaticMarkup(React.createElement(CardsReview, {
      controller, ticket, ui: { ...emptyUi, ...ui }, people, lines, onChoose() {}, onCopy() {}, onDiscard() {}, onSource() {}, onRemoved() {},
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
    const ui = { reading: { 1: "read", 2: "read" } as const, source: { 1: { name: "read", phone: "read", email: "read", request: "read" }, 2: { name: "read", phone: "read", email: "read", request: "read" } } as const };
    const html = render(controller, ticket, ui);
    const first = html.indexOf("Look at these first");
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(html.indexOf("card-1-name"));
    expect(html).toContain("Card 1: “Riley Thornbury” has the same name as Riley Thornbury in this Sunday&#x27;s check. Worth a look: only the name matches, which doesn&#x27;t show it&#x27;s the same person. Ozzie won&#x27;t combine them. Check Planning Center before adding anyone.");
    // On the card itself: worth a look, and a name alone is not enough to say it's the same person.
    expect(html).toMatch(/Worth a look<\/span> Possible match: Riley Thornbury in this Sunday&#x27;s check has the same name\. Only the name matches, and a name alone doesn&#x27;t show it&#x27;s the same person\. Ozzie won&#x27;t combine them\./);
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
    const html = render(controller, ticket, { reading: { 1: "read" }, source: { 1: { name: "read", phone: "read", email: "read", request: "read" } } });
    expect(html.match(/Ozzie couldn&#x27;t read this clearly — check it against the card\./g)!.length).toBe(2);
    // Two flagged fields (the possible-match note on this card has its own "Worth a look").
    expect(html.match(/Worth a look<\/span><\/div>/g)!.length).toBe(2);
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

// Two of the fictional sample cards (docs/prep/card-samples) as Ozzie's line assembly delivers what
// the release card reader returned for them (see core/test/card-fields.test.ts). Invented people only.
const SAMPLE_A = [
  "VISITOR CARD — FICTIONAL TEST SAMPLE A",
  "Synthetic lettering; not a photograph or real human handwriting.",
  "Alex Harbor", "202-555-0142", "alex.harbor@example.org",
  "Please call me about the volunteer orientation.", "",
  "No real person or church is represented. Do not send messages.",
  "Sample B has a deliberately ambiguous contact character. Ask; do not guess.",
].join("\n");
const SAMPLE_D = [
  "WELCOME CARD - FICTIONAL TEST SAMPLE D",
  "Synthetic lettering; not a photograph or real human handwriting.",
  "Name: Casey Brook", "Phone: 202-555-0163", "Email: casey.brook@example.org",
  "Request: I would like to help with the food pantry.", "",
  "No real person or church is represented. Do not send messages.",
].join("\n");
const CARD_WORDS = ["Alex", "Harbor", "202-555", "example.org", "orientation", "Riley", "Thornbury", "Casey", "pantry", "Quillfeather"];

const renderPage = (controller: CardReviewController, ticket: number | null, ui: Partial<CardsUi> = {}, lines: Record<number, readonly ReadLine[]> = {}) =>
  renderToStaticMarkup(React.createElement(CardsReview, {
    controller, ticket, ui: { ...emptyUi, ...ui }, people, lines, onChoose() {}, onCopy() {}, onDiscard() {}, onSource() {}, onRemoved() {},
  }));

/** Sample A, read on this Mac and placed field by field by a person from what it read. */
async function placedSampleA(unclearLines: number[] = []) {
  const read = await readWith([{ status: "read", text: SAMPLE_A, unclearLines }]);
  const line = (text: string) => read.lines[1]!.find(l => l.text === text)!;
  const card = () => cardsOf(read.controller)[0]!;
  const source: Record<string, FieldSource> = {};
  for (const [field, text] of [["name", "Alex Harbor"], ["phone", "202-555-0142"], ["email", "alex.harbor@example.org"],
    ["request", "Please call me about the volunteer orientation."]] as const) {
    source[field] = placeLine(read.controller, read.ticket, card(), field, line(text), undefined)!;
  }
  return { ...read, card, line, source: { 1: source } };
}

describe("what this Mac read, for a person to put where it belongs", () => {
  it("fills nothing from a card without labels, and keeps every line it read for this review only", async () => {
    const { controller, states, suggested, lines } = await readWith([{ status: "read", text: SAMPLE_A, unclearLines: [] }]);
    expect(states).toEqual({ 1: "read" });
    expect(suggested).toEqual({ 1: {} });
    for (const f of Object.values(fieldsOf(cardsOf(controller)[0]!))) expect(f).toEqual({ text: "", state: "unreviewed" });
    expect(lines[1]).toEqual(readLines(SAMPLE_A, []));
  });

  it("lists the lines by the photo, each with one control to put it in a field, and says why nothing was filled", async () => {
    const { controller, ticket, lines } = await readWith([{ status: "read", text: SAMPLE_A, unclearLines: [3] }]);
    const html = renderPage(controller, ticket, { reading: { 1: "read" }, source: { 1: {} } }, lines);
    expect(html).toContain("What this Mac read on the card");
    expect(html).toContain("This Mac read this card but found no printed labels like “Name:”, so it filled nothing in. Put the lines it read where they belong, or type what you see.");
    expect(html.indexOf("What this Mac read on the card")).toBeLessThan(html.indexOf('id="card-1-name"'));
    expect(html.match(/<select[^>]*aria-label="Use line \d+ as"/g)!.length).toBe(8);
    // The line the reader couldn't read clearly says so, with the reason.
    expect(html).toMatch(/<span id="card-1-line-4" class="cards-line-t">202-555-0142<\/span><span class="badge b-look">.*?Worth a look<\/span><span class="small">Hard to read<\/span>/);
    expect(html).toMatch(/<select[^>]*aria-label="Use line 4 as"[^>]*aria-describedby="card-1-line-4"/);
    for (const option of [">Use as…</option>", ">Name</option>", ">Phone</option>", ">Email</option>", ">Request</option>"]) expect(html).toContain(option);
  });

  it("puts a line where the person chooses: name, phone and email take it, the request adds it on a new line", async () => {
    const { controller, ticket, card, line } = await placedSampleA([3]);
    expect(placeLine(controller, ticket, card(), "request", line("Alex Harbor"), "typed")).toBe("typed");
    expect(fieldsOf(card())).toEqual({
      // A line this Mac couldn't read clearly stays marked hard to read in its field.
      name: { text: "Alex Harbor", state: "typed" }, phone: { text: "202-555-0142", state: "unclear" },
      email: { text: "alex.harbor@example.org", state: "typed" },
      request: { text: "Please call me about the volunteer orientation.\nAlex Harbor", state: "typed" },
    });
    const html = renderPage(controller, ticket, { reading: { 1: "read" }, source: { 1: { name: "chosen", phone: "chosen" } } }, { 1: readLines(SAMPLE_A, [3]) });
    expect(html).toContain("You put this line here from what this Mac read. Compare it with the photo.");
    expect(html).toContain("This Mac couldn&#x27;t read that line clearly — check it against the card.");
    expect(html).toContain(">Request (add this line)</option>");
    // A line too long for a field is never cut to fit.
    expect(placeLine(controller, ticket, card(), "name", { line: 9, text: "x".repeat(257), unclear: false }, "chosen")).toBeNull();
    expect(card().fields.name.text).toBe("Alex Harbor");
  });

  it("fills a labeled card; printed words further down never join the request, and the reason is shown", async () => {
    const { controller, ticket, suggested, lines } = await readWith([{ status: "read", text: SAMPLE_D, unclearLines: [] }]);
    expect(fieldsOf(cardsOf(controller)[0]!)).toEqual({
      name: { text: "Casey Brook", state: "typed" }, phone: { text: "202-555-0163", state: "typed" },
      email: { text: "casey.brook@example.org", state: "typed" }, request: { text: "I would like to help with the food pantry.", state: "unclear" },
    });
    expect(suggested).toEqual({ 1: { name: "read", phone: "read", email: "read", request: "read-more" } });
    const html = renderPage(controller, ticket, { reading: { 1: "read" }, source: suggested }, lines);
    expect(html).toContain("There&#x27;s more writing on the card after these words. Check whether any of it belongs to their request, and compare every word with the photo.");
    expect(html).not.toContain("found no printed labels");
    expect(lookFirst(cardsOf(controller), {}, suggested).map(x => x.text))
      .toEqual(["Card 1: there's more writing on the card after the request. Worth a look: check whether it belongs to it."]);
  });
});

describe("prepared follow-ups and the copied list", () => {
  it("once a person checks a card that asks for a call, prepares it with their exact words and the phone they gave", async () => {
    const { controller, ticket, card, source } = await placedSampleA();
    const lines = { 1: readLines(SAMPLE_A, []) };
    expect(renderPage(controller, ticket, { reading: { 1: "read" }, source }, lines)).not.toContain("Prepared follow-up");
    expect(checkCard(controller, ticket, card())).toBe("ok");
    const html = renderPage(controller, ticket, { reading: { 1: "read" }, source }, lines);
    expect(html).toContain("Prepared follow-up");
    expect(html).toContain("Suggested because their words ask for a call. Check that this is what they meant.");
    expect(html).toContain("“Please call me about the volunteer orientation.”");
    expect(html).toContain("Phone they gave: 202-555-0142");
    expect(html).toContain("Choose who will follow up in your church tools.");
    expect(html).toContain("Ozzie won&#x27;t call, text or email anyone. This goes in the list you copy; nothing is added to Planning Center.");
  });

  it("labels what a person typed by hand in the copied list, and adds each follow-up as its own section", async () => {
    const { controller, ticket, card, source } = await placedSampleA();
    checkCard(controller, ticket, card());
    const { text, count, followUps } = listFor(controller, { 1: { ...source[1], email: "typed" } });
    expect(count).toBe(1);
    expect(followUps).toBe(1);
    expect(text).toContain("Name: Alex Harbor\nPhone: 202-555-0142\nEmail: alex.harbor@example.org (typed by a person)\nRequest (their exact words):\nPlease call me about the volunteer orientation.\n");
    expect(text).toContain("Prepared follow-ups: 1\nSuggested from the words on these cards. Ozzie didn't call, text or email anyone.\n\nCard 1 asked for a call\nTheir words: “Please call me about the volunteer orientation.”\nPhone they gave: 202-555-0142\nChoose who will follow up in your church tools.");
    // Typed when this Mac couldn't read cards at all: every typed field says so.
    expect(listFor(controller, { 1: { name: "typed", phone: "typed", email: "typed", request: "typed" } }).text).toContain("Request (their exact words, typed by a person):");
  });

  it("after copying, says the cards were reviewed here and nothing was saved to the church's tools", () => {
    const controller = new CardReviewController("fictional-test", { foreground: () => true, createURL: () => "blob:x", revokeURL() {}, decode: async () => true });
    const html = renderPage(controller, null, { ended: "copied", copied: 2, followUps: 1 });
    expect(html).toContain("Reviewed here; nothing saved to your church&#x27;s tools.");
    expect(html).toContain("The list includes 1 prepared follow-up. Choose who will follow up in your church tools; Ozzie won&#x27;t contact anyone.");
    expect(renderPage(controller, null, { ended: "copied", copied: 1, followUps: 0 })).not.toContain("prepared follow-up");
  });
});

describe("photos, controls and what is announced", () => {
  it("chooses photos only through Ozzie's own photo window, which the page can't hand a file name or path", () => {
    const source = readFileSync(new URL("../src/cards-page.tsx", import.meta.url), "utf8");
    // No browser file input is left to bypass the Mac's own checks.
    expect(source).not.toMatch(/type\s*=\s*["']file["']|createElement\(["']input["']\)|accept\s*=/u);
    expect(source).toContain('invoke<unknown>("choose_card_photos")');
    expect(source).not.toMatch(/invoke<[^>]*>\("choose_card_photos",/u);
  });

  it("opens the photos the Mac checked, in the order chosen, named only by card number", async () => {
    const jpeg = new Uint8Array([255, 216, 255, 224, 0, 16]);
    const reply = frameOf([1, PNG], [2, jpeg]);
    const files = cardPhotoFiles(reply.buffer)!;
    expect(files.map(f => [f.name, f.type, f.size])).toEqual([["Card 1.png", "image/png", PNG.byteLength], ["Card 2.jpg", "image/jpeg", jpeg.byteLength]]);
    expect(new Uint8Array(await files[1]!.arrayBuffer())).toEqual(jpeg);
    expect(cardPhotoFiles(reply)).toHaveLength(2);
    expect(cardPhotoFiles(new ArrayBuffer(0))).toEqual([]);
    // Anything that isn't the Mac's reply opens nothing.
    for (const bad of [
      frameOf([3, PNG]), frameOf([0, PNG]), frameOf([1, new Uint8Array(0)]), frameOf([1, PNG]).slice(0, 9), new Uint8Array([1, 0, 0]),
      frameOf(...Array.from({ length: 9 }, () => [1, PNG] as [number, Uint8Array])), new Uint8Array([1, 0x00, 0x80, 0x00, 0x01, 137]),
    ]) expect(cardPhotoFiles(bad.buffer.slice(bad.byteOffset, bad.byteOffset + bad.byteLength)), String(bad.slice(0, 6))).toBeNull();
    for (const bad of [null, undefined, "photos", [1, 2, 3], { 0: 1 }]) expect(cardPhotoFiles(bad)).toBeNull();
  });

  it("hands the chosen photos to the review once, closes quietly on Cancel and says plainly why photos were refused", async () => {
    const make = () => new CardReviewController("fictional-test", { foreground: () => true, createURL: () => "blob:x", revokeURL() {}, decode: async () => true });
    const settle = () => new Promise(resolve => setTimeout(resolve, 0));
    const run = async (reply: () => Promise<unknown>) => {
      const controller = make();
      const chosen: File[][] = [];
      const refused: string[] = [];
      const calls: unknown[][] = [];
      const ticket = pickCards(controller, (...args: unknown[]) => { calls.push(args); return reply(); },
        (t, files) => { expect(t).toBe(ticket); chosen.push(files); }, p => { refused.push(p); });
      expect(controller.status).toBe("choosing");
      await settle();
      // The page asks for the window and passes nothing to it.
      expect(calls).toEqual([[]]);
      return { controller, ticket: ticket!, chosen, refused };
    };
    const picked = await run(async () => frameOf([1, PNG], [1, PNG]).buffer);
    expect([picked.chosen.length, picked.chosen[0]!.length, picked.refused]).toEqual([1, 2, []]);
    expect(await picked.controller.select(picked.ticket, picked.chosen[0]!)).toBe("ok");
    const cancelled = await run(async () => new ArrayBuffer(0));
    expect([cancelled.controller.status, cancelled.chosen, cancelled.refused]).toEqual(["closed", [], []]);
    for (const [code, words] of [
      ["not-a-photo", "That isn&#x27;t a photo Ozzie can read. Choose a PNG or JPEG picture of each card."],
      ["too-large", "That photo is over 8 MB. Choose PNG or JPEG photos of 8 MB or less."],
      ["too-much-together", "Those photos are over 24 MB together. Choose fewer at a time."],
      ["too-many", "That&#x27;s more than 8 photos. Choose up to 8 at a time."],
      ["unavailable", "The window for choosing photos couldn&#x27;t open. Try again."],
      ["something-new", "Those photos couldn&#x27;t be opened. Choose PNG or JPEG photos: up to 8 at a time, 8 MB each."],
    ] as const) {
      const r = await run(() => Promise.reject(code));
      const problem = code === "something-new" ? "unreadable" : code;
      expect([r.controller.status, r.chosen, r.refused]).toEqual(["closed", [], [problem]]);
      expect(PICK_PROBLEM[problem]).toBe(words.replaceAll("&#x27;", "'"));
      const html = renderPage(r.controller, null, { refused: problem });
      expect(html).toContain(`<p role="alert" class="problem">${words}</p>`);
      expect(html).toContain("Choose card photos");
    }
    // A reply that isn't photos is refused, not opened.
    const garbled = await run(async () => "not photos");
    expect([garbled.controller.status, garbled.refused]).toEqual(["closed", ["unreadable"]]);
    // Another photo window already open carries on; nothing is said.
    const busy = await run(() => Promise.reject("busy"));
    expect([busy.controller.status, busy.refused]).toEqual(["closed", []]);
  });

  it("still refuses anything but PNG and JPEG in the review itself, with the same message", async () => {
    for (const file of [new File(["# notes"], "README.md", { type: "text/markdown" }), new File(["<svg/>"], "visitor-a.svg", { type: "image/svg+xml" })]) {
      const controller = new CardReviewController("fictional-test", { foreground: () => true, createURL: () => "blob:x", revokeURL() {}, decode: async () => true });
      const ticket = controller.choose(() => {})!;
      expect(await controller.select(ticket, [file])).toBe("invalid");
      expect(renderPage(controller, null)).toContain("Those photos couldn&#x27;t be opened. Choose PNG or JPEG photos: up to 8 at a time, 8 MB each.");
    }
  });

  it("closes the larger photo with Escape; its button works from the keyboard and says whether it is pressed", async () => {
    let closed = 0;
    const stop = vi.fn();
    escapeCloses(true, () => { closed++; })({ key: "Escape", stopPropagation: stop });
    expect([closed, stop.mock.calls.length]).toEqual([1, 1]);
    escapeCloses(false, () => { closed++; })({ key: "Escape", stopPropagation: stop });
    escapeCloses(true, () => { closed++; })({ key: "Enter", stopPropagation: stop });
    expect(closed).toBe(1);
    const { controller, ticket } = await readWith([{ status: "read", text: CARD_A, unclearLines: [] }]);
    expect(renderPage(controller, ticket, { reading: { 1: "read" } })).toMatch(/<button type="button" class="btn btn-quiet btn-sm" aria-pressed="false">See the photo larger/);
  });

  it("names each repeated control with its card and field", async () => {
    const { controller, ticket } = await readWith([{ status: "read", text: CARD_A, unclearLines: [] }, { status: "read", text: CARD_B, unclearLines: [] }]);
    const html = renderPage(controller, ticket, { reading: { 1: "read", 2: "read" } });
    expect(html).toContain('See the photo larger<span class="sr-only"> (Card 1)</span>');
    expect(html).toContain('Remove this card<span class="sr-only"> (Card 2)</span>');
    expect(html).toContain('<span class="sr-only">Card 2 phone: </span>Hard to read on the card');
  });

  it("never announces card contents: live regions carry counts and status only", async () => {
    const regions = (html: string) => {
      const out: string[] = [];
      const open = /<(p|div|span|section)\b[^>]*(?:role="(?:status|alert)"|aria-live="[^"]+")[^>]*>/g;
      for (let m; (m = open.exec(html));) {
        const close = new RegExp(`<${m[1]}\\b[^>]*>|</${m[1]}>`, "g");
        close.lastIndex = open.lastIndex;
        let depth = 1, end = html.length;
        for (let t; depth && (t = close.exec(html));) { depth += t[0].startsWith("</") ? -1 : 1; end = close.lastIndex; }
        out.push(html.slice(m.index, end));
      }
      return out;
    };
    const { controller, ticket, card, source } = await placedSampleA([3]);
    const lines = { 1: readLines(SAMPLE_A, [3]) };
    const pages = [renderPage(controller, ticket, { reading: { 1: "read" }, source }, lines)];
    checkCard(controller, ticket, card());
    pages.push(renderPage(controller, ticket, { reading: { 1: "read" }, source, copyProblem: true }, lines));
    controller.discard(ticket);
    pages.push(renderPage(controller, null, { ended: "copied", copied: 1, followUps: 1 }));
    expect(pages[0]).toContain("Alex Harbor");
    const found = pages.flatMap(regions);
    expect(found.length).toBeGreaterThanOrEqual(3);
    for (const region of found) for (const word of CARD_WORDS) expect(region, region).not.toContain(word);
  });
});
