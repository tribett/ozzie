import { describe, expect, it } from "vitest";
import { possibleMatches, RECOGNIZED_TEXT_MAX, reviewedList, sameNameCards, suggestFields } from "../src/card-fields.js";

// Every name, number and address here is invented test data, shaped like Tesseract output
// for the synthetic printed cards used in development. No real card was read.
const clean = [
  "Welcome! Visitor card", "",
  "Name: Riley Thornbury",
  "Phone: (555) 014-2290",
  "Email: riley.t@example.com", "",
  "Prayer request: Please pray for my",
  "new job starting Monday.", "",
].join("\n");

describe("suggested card fields from on-device text recognition", () => {
  it("fills labeled fields and keeps the request's exact words and line breaks", () => {
    expect(suggestFields(clean)).toEqual({
      name: { text: "Riley Thornbury", unclear: false },
      phone: { text: "(555) 014-2290", unclear: false },
      email: { text: "riley.t@example.com", unclear: false },
      request: { text: "Please pray for my\nnew job starting Monday.", unclear: false },
    });
  });

  it("flags a phone it can't read cleanly and leaves it blank instead of correcting letters to digits", () => {
    const s = suggestFields("Name: Jordan Quillfeather\nPhone: 555 O1Z 77\nEmail:\n\nHow can we pray for you?\nFor my mom, who is in the hospital.\n");
    expect(s.phone).toEqual({ text: "", unclear: true });
    // A label with nothing read after it may be blank on the card, faint, or on the next line: a person checks.
    expect(s.email).toEqual({ text: "", unclear: true });
    expect(suggestFields("Phone:\n555-014-2290").phone).toEqual({ text: "", unclear: true });
    expect(s.name).toEqual({ text: "Jordan Quillfeather", unclear: false });
    expect(s.request).toEqual({ text: "For my mom, who is in the hospital.", unclear: false });
  });

  it("flags an email without a clean address shape and never repairs it", () => {
    expect(suggestFields("E-mail: riley.t©example.com").email).toEqual({ text: "", unclear: true });
    expect(suggestFields("Email address: riley.t @example .com").email).toEqual({ text: "", unclear: true });
    expect(suggestFields("Email: Riley.T@Example.com").email).toEqual({ text: "Riley.T@Example.com", unclear: false });
  });

  it("flags a name with digits or stray marks rather than guessing", () => {
    expect(suggestFields("Name: R1ley Th0rnbury").name).toEqual({ text: "", unclear: true });
    expect(suggestFields("Name: Riley | Thornbury").name).toEqual({ text: "", unclear: true });
    expect(suggestFields("Name: Siobhán O’Rourke-Day").name).toEqual({ text: "Siobhán O’Rourke-Day", unclear: false });
  });

  it("leaves everything blank when nothing is labeled, and never picks a name out of free text", () => {
    expect(suggestFields("Thank you for visiting\nRiley Thornbury\nwe are glad you came")).toEqual({
      name: { text: "", unclear: false }, phone: { text: "", unclear: false },
      email: { text: "", unclear: false }, request: { text: "", unclear: false },
    });
  });

  it("never takes an unlabeled phone or email: the church's own may be printed on the card", () => {
    const s = suggestFields("Harbor Example Church\n(555) 014-0000\noffice@harbor.example\nName: Riley Thornbury");
    expect(s.phone).toEqual({ text: "", unclear: false });
    expect(s.email).toEqual({ text: "", unclear: false });
    const inside = suggestFields("Prayer request: please call my sister at 555-014-2290 or sis@example.com");
    expect(inside.phone).toEqual({ text: "", unclear: false });
    expect(inside.email).toEqual({ text: "", unclear: false });
    expect(inside.request.text).toBe("please call my sister at 555-014-2290 or sis@example.com");
  });

  it("flags two phone lines or two name lines as unclear instead of choosing one", () => {
    expect(suggestFields("Phone: 555-014-2290\nCell: 555-014-9999").phone).toEqual({ text: "", unclear: true });
    expect(suggestFields("Name: Riley Thornbury\nName: Sam Whitcombe").name).toEqual({ text: "", unclear: true });
  });

  it("keeps odd characters in a request but flags it, so a person compares every word", () => {
    expect(suggestFields("Prayer request: for my dad's surg|ery ~ next week").request)
      .toEqual({ text: "for my dad's surg|ery ~ next week", unclear: true });
  });

  it("ends the request at the next labeled line", () => {
    const s = suggestFields("How can we pray for you?\n\nFor peace at home.\nAnd patience.\nPhone: 555.014.2290");
    expect(s.request).toEqual({ text: "For peace at home.\nAnd patience.", unclear: false });
    expect(s.phone).toEqual({ text: "555.014.2290", unclear: false });
    expect(suggestFields("Request: Healing for my knee\nAddress: 12 Fictional Lane").request).toEqual({ text: "Healing for my knee", unclear: false });
  });

  it("never shows a request that may have been cut short as a clean reading", () => {
    expect(suggestFields("Prayer request: For my dad.\n\nAnd for my sister, too.").request).toEqual({ text: "For my dad.", unclear: true });
    expect(suggestFields("How can we pray for you?\nFor peace at home.\n\nThanks for visiting!").request.unclear).toBe(true);
    // Sentences that merely start like another label don't end the request or create a phone.
    const s = suggestFields("Prayer request: For my mom.\nChildren at home are worried.\nTelling her doctors we're grateful.");
    expect(s.request).toEqual({ text: "For my mom.\nChildren at home are worried.\nTelling her doctors we're grateful.", unclear: false });
    expect(s.phone).toEqual({ text: "", unclear: false });
  });

  // Second independent review (ported from the reviewer's probe, asserting the fixed behaviour).
  it("a line that only starts like a label, with no colon, may be the request going on: unclear, never clean", () => {
    const cases: [string, string][] = [
      ["Name: Alex Harbor\nPrayer request: Please pray for my family.\nPhone calls from the hospital scare me.\nPhone: 202-555-0142", "Please pray for my family."],
      ["Name: Alex Harbor\nPrayer request: Please pray for my mom.\nName her in your prayers please.", "Please pray for my mom."],
      ["Prayer request: My son is sick.\nEmail me if you need anything.", "My son is sick."],
    ];
    for (const [card, words] of cases) expect(suggestFields(card).request, card).toEqual({ text: words, unclear: true });
    // A second request label is unclear as before; a labeled line with a colon still ends it cleanly.
    expect(suggestFields("Prayer request: Pray for our move.\nRequest: also for my job").request).toEqual({ text: "", unclear: true });
    expect(suggestFields("Prayer request: Pray for our move.\nPhone: 202-555-0142").request).toEqual({ text: "Pray for our move.", unclear: false });
    expect(suggestFields("Prayer request: Pray for our move.\nEmail - pat@example.com").request.unclear).toBe(true);
  });

  it("never shortens a request: one too long for review is flagged and left blank", () => {
    expect(suggestFields(`Prayer request: ${"a".repeat(2001)}`).request).toEqual({ text: "", unclear: true });
  });

  it("treats oversized or non-text input as unreadable and returns nothing from it", () => {
    const big = suggestFields(`Name: Riley Thornbury\n${"x".repeat(RECOGNIZED_TEXT_MAX)}`);
    expect(Object.values(big)).toEqual(Array(4).fill({ text: "", unclear: true }));
    expect(Object.values(suggestFields(undefined as unknown as string))).toEqual(Array(4).fill({ text: "", unclear: false }));
  });
});

describe("possible matches with people already in the current Sunday check", () => {
  const names = { "511": "Riley Thornbury", "512": "Sam Whitcombe", "513": "Morgan Ellingsworth", "514": "Riley Thornbury-Hale" };
  it("matches the same name ignoring case, accents and punctuation", () => {
    expect(possibleMatches("riley  THORNBURY", names)).toEqual(["511"]);
    expect(possibleMatches("Sám Whitcombe.", names)).toEqual(["512"]);
  });
  it("matches first and last name when a middle name differs", () => {
    expect(possibleMatches("Morgan Lee Ellingsworth", names)).toEqual(["513"]);
  });
  it("needs a first and last name: one word or a different surname is no match", () => {
    expect(possibleMatches("Riley", names)).toEqual([]);
    expect(possibleMatches("Riley Thornton", names)).toEqual([]);
    expect(possibleMatches("", names)).toEqual([]);
  });
  it("finds the same name on two cards in this batch", () => {
    expect(sameNameCards([{ id: 1, name: "Riley Thornbury" }, { id: 2, name: "Sam W" }, { id: 3, name: "riley thornbury" }, { id: 4, name: "" }]))
      .toEqual([[1, 3]]);
  });
});

describe("the reviewed list a person copies", () => {
  it("is plain text, one block per card, with the request's exact words and every uncertainty spelled out", () => {
    const list = reviewedList([
      { label: "Card 1", fields: {
        name: { text: "Riley Thornbury", state: "typed" }, phone: { text: "(555) 014-2290", state: "typed" },
        email: { text: "riley.t@example.com", state: "typed" }, request: { text: "Please pray for my\nnew job starting Monday.", state: "typed" } } },
      { label: "Card 2", fields: {
        name: { text: "Jordan Quillfeather", state: "unclear" }, phone: { text: "", state: "unclear" },
        email: { text: "", state: "blank" }, request: { text: "", state: "not-readable" } } },
    ]);
    expect(list).toBe([
      "Visitor cards checked in Ozzie: 2",
      "Each card was checked against its photo before this list was copied. Nothing was added to Planning Center.",
      "",
      "Card 1",
      "Name: Riley Thornbury",
      "Phone: (555) 014-2290",
      "Email: riley.t@example.com",
      "Request (their exact words):",
      "Please pray for my",
      "new job starting Monday.",
      "",
      "Card 2",
      "Name: Jordan Quillfeather (unclear on the card, worth a look)",
      "Phone: unclear on the card",
      "Email: blank on the card",
      "Request: couldn't be read",
      "",
    ].join("\n"));
  });
});
