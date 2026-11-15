import { describe, expect, it } from "vitest";
import { followUpAsks, followUpFor, possibleMatches, readLines, RECOGNIZED_TEXT_MAX, reviewedList, sameNameCards, suggestFields } from "../src/card-fields.js";

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
    expect(suggestFields("Prayer request: For my dad.\n\nAnd for my sister, too.").request).toEqual({ text: "For my dad.", unclear: true, more: true });
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
    for (const [card, words] of cases) expect(suggestFields(card).request, card).toEqual({ text: words, unclear: true, more: true });
    // A second request label is unclear as before; a labeled line with a colon still ends it cleanly.
    expect(suggestFields("Prayer request: Pray for our move.\nRequest: also for my job").request).toEqual({ text: "", unclear: true });
    expect(suggestFields("Prayer request: Pray for our move.\nPhone: 202-555-0142").request).toEqual({ text: "Pray for our move.", unclear: false });
    expect(suggestFields("Prayer request: Pray for our move.\nEmail - pat@example.com").request.unclear).toBe(true);
  });

  it("never shortens a request: one too long for review is flagged and left blank", () => {
    expect(suggestFields(`Prayer request: ${"a".repeat(2001)}`).request).toEqual({ text: "", unclear: true });
  });

  // Lines of `clean`: 0 heading, 1 blank, 2 name, 3 phone, 4 email, 5 blank, 6-7 request.
  it("keeps a low-confidence reading as a suggestion to check, flagged unclear, never as a clean fill", () => {
    expect(suggestFields(clean, [2])).toEqual({
      name: { text: "Riley Thornbury", unclear: true },
      phone: { text: "(555) 014-2290", unclear: false },
      email: { text: "riley.t@example.com", unclear: false },
      request: { text: "Please pray for my\nnew job starting Monday.", unclear: false },
    });
    expect(suggestFields(clean, [3]).phone).toEqual({ text: "(555) 014-2290", unclear: true });
    expect(suggestFields(clean, [4]).email).toEqual({ text: "riley.t@example.com", unclear: true });
    // Any line of the request, its label line or a later one, flags the whole request.
    expect(suggestFields(clean, [6]).request).toEqual({ text: "Please pray for my\nnew job starting Monday.", unclear: true });
    expect(suggestFields(clean, [7]).request).toEqual({ text: "Please pray for my\nnew job starting Monday.", unclear: true });
  });

  it("a low-confidence line outside every field changes nothing; a malformed value stays blank", () => {
    expect(suggestFields(clean, [0, 1, 5, 99])).toEqual(suggestFields(clean));
    expect(suggestFields("Phone: 555 O1Z 77", [0]).phone).toEqual({ text: "", unclear: true });
    const labelOnly = suggestFields("How can we pray for you?\nFor my mom, who is in the hospital.", [0]);
    expect(labelOnly.request).toEqual({ text: "For my mom, who is in the hospital.", unclear: true });
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

// The four fictional sample cards (docs/prep/card-samples) exactly as Ozzie's line assembly
// (card_lines in product/desktop/src-tauri/src/local_tools.rs) puts together what Ozzie's release
// card reader returned for them on 2026-11-15. local_tools.rs tests the same readings from the
// reader's own output. Invented people, reserved example.org addresses and 202-555-01xx numbers only.
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
const SAMPLE_C = [
  "WELCOME CARD - FICTIONAL TEST SAMPLE C",
  "Synthetic lettering; not a photograph or real human handwriting.",
  "Name: Morgan Vale", "Phone: 202-555-0119", "Email: morgan.vale@example.org",
  "Request: Please call me about the newcomers Lunch.", "",
  "No real person or church is represented. Do not send messages.",
].join("\n");

describe("the fictional sample cards as this Mac reads them", () => {
  it("fills a labeled card, and never lets printed words further down join the visitor's request", () => {
    expect(suggestFields(SAMPLE_D)).toEqual({
      name: { text: "Casey Brook", unclear: false },
      phone: { text: "202-555-0163", unclear: false },
      email: { text: "casey.brook@example.org", unclear: false },
      // More writing sits further down the card: the request may go on, so a person checks it.
      request: { text: "I would like to help with the food pantry.", unclear: true, more: true },
    });
    expect(suggestFields(SAMPLE_C).request).toEqual({ text: "Please call me about the newcomers Lunch.", unclear: true, more: true });
  });

  it("fills nothing on a card without labels, and lists every line it read for the person to place", () => {
    expect(Object.values(suggestFields(SAMPLE_A))).toEqual(Array(4).fill({ text: "", unclear: false }));
    expect(readLines(SAMPLE_A, [3])).toEqual([
      { line: 0, text: "VISITOR CARD — FICTIONAL TEST SAMPLE A", unclear: false },
      { line: 1, text: "Synthetic lettering; not a photograph or real human handwriting.", unclear: false },
      { line: 2, text: "Alex Harbor", unclear: false },
      { line: 3, text: "202-555-0142", unclear: true },
      { line: 4, text: "alex.harbor@example.org", unclear: false },
      { line: 5, text: "Please call me about the volunteer orientation.", unclear: false },
      { line: 7, text: "No real person or church is represented. Do not send messages.", unclear: false },
      { line: 8, text: "Sample B has a deliberately ambiguous contact character. Ask; do not guess.", unclear: false },
    ]);
  });

  it("lists nothing from text it couldn't trust", () => {
    expect(readLines(`Name: Riley Thornbury\n${"x".repeat(RECOGNIZED_TEXT_MAX)}`, [])).toEqual([]);
    expect(readLines(undefined as unknown as string, [])).toEqual([]);
    expect(readLines("  \n\n", [])).toEqual([]);
  });
});

describe("explicit follow-up requests, from a fixed list of words", () => {
  it("finds a plain ask to be called, emailed, texted or contacted", () => {
    expect(followUpAsks("Please call me about the volunteer orientation.")).toEqual(["call"]);
    expect(followUpAsks("Please send event information by email.")).toEqual(["email"]);
    expect(followUpAsks("Text me or call me this week")).toEqual(["call", "text"]);
    expect(followUpAsks("Would you e-mail me the schedule?")).toEqual(["email"]);
    expect(followUpAsks("Can someone contact me?")).toEqual(["contact"]);
    expect(followUpAsks("Please send me the newsletter")).toEqual(["contact"]);
    expect(followUpAsks("Give me a call\nabout small groups")).toEqual(["call"]);
  });

  it("never reads an ask into words that don't make one", () => {
    for (const words of [
      "I would like to help with the food pantry.",
      "Please call my sister, she is new here.",
      "I heard about you by email.",
      "Do not send messages.",
      "Please don't call me.",
      "Never call me at work",
      "Phone calls from the hospital scare me.",
      "",
    ]) expect(followUpAsks(words), words).toEqual([]);
    // A refusal only cancels its own part: "don't call me, email me" still asks for an email.
    expect(followUpAsks("Please don't call me, but email me instead.")).toEqual(["email"]);
    expect(followUpAsks(undefined as unknown as string)).toEqual([]);
  });

  it("prepares the visitor's exact words with the contact detail they gave for that way of reaching them", () => {
    const fields = {
      name: { text: "Alex Harbor", state: "typed" as const }, phone: { text: "202-555-0142", state: "typed" as const },
      email: { text: "alex.harbor@example.org", state: "typed" as const },
      request: { text: "Please call me about the volunteer orientation.", state: "typed" as const },
    };
    expect(followUpFor({ label: "Card 1", fields })).toEqual({
      label: "Card 1", asked: "asked for a call", words: "Please call me about the volunteer orientation.",
      details: ["Phone they gave: 202-555-0142"],
    });
    // A detail that isn't there or was hard to read says so; nothing is filled in.
    expect(followUpFor({ label: "Card 2", fields: {
      ...fields, email: { text: "", state: "unclear" }, request: { text: "Please send event information by email.", state: "typed" },
    } })!.details).toEqual(["Email they gave: unclear on the card"]);
    expect(followUpFor({ label: "Card 3", fields: {
      ...fields, phone: { text: "", state: "blank" }, email: { text: "pat@example.org", state: "unclear" }, request: { text: "Contact me please", state: "typed" },
    } })).toEqual({ label: "Card 3", asked: "asked to be contacted", words: "Contact me please",
      details: ["Phone they gave: none on the card", "Email they gave: pat@example.org (unclear on the card, worth a look)"] });
    expect(followUpFor({ label: "Card 4", fields: { ...fields, request: { text: "I would like to help.", state: "typed" } } })).toBeNull();
    expect(followUpFor({ label: "Card 5", fields: { ...fields, request: { text: "", state: "blank" } } })).toBeNull();
  });
});

describe("the reviewed list a person copies: who typed what, and prepared follow-ups", () => {
  it("labels a field a person typed by hand, and lists each prepared follow-up as its own section", () => {
    const list = reviewedList([
      { label: "Card 1", fields: {
        name: { text: "Alex Harbor", state: "typed" }, phone: { text: "202-555-0142", state: "typed" },
        email: { text: "alex.harbor@example.org", state: "typed" }, request: { text: "Please call me about the volunteer orientation.", state: "typed" } } },
      { label: "Card 2", fields: {
        name: { text: "Jordan Field", state: "typed" }, phone: { text: "202-555-0176", state: "typed" },
        email: { text: "jordan.field0@example.org", state: "typed", by: "person" },
        request: { text: "I would like to help.", state: "unclear", by: "person" } } },
    ]);
    expect(list).toBe([
      "Visitor cards checked in Ozzie: 2",
      "Each card was checked against its photo before this list was copied. Nothing was added to Planning Center.",
      "",
      "Card 1",
      "Name: Alex Harbor",
      "Phone: 202-555-0142",
      "Email: alex.harbor@example.org",
      "Request (their exact words):",
      "Please call me about the volunteer orientation.",
      "",
      "Card 2",
      "Name: Jordan Field",
      "Phone: 202-555-0176",
      "Email: jordan.field0@example.org (typed by a person)",
      "Request (their exact words, typed by a person, partly unclear):",
      "I would like to help.",
      "",
      "Prepared follow-ups: 1",
      "Suggested from the words on these cards. Ozzie didn't call, text or email anyone.",
      "",
      "Card 1 asked for a call",
      "Their words: “Please call me about the volunteer orientation.”",
      "Phone they gave: 202-555-0142",
      "Choose who will follow up in your church tools.",
      "",
    ].join("\n"));
    expect(reviewedList([{ label: "Card 1", fields: {
      name: { text: "Sam Lee", state: "unclear", by: "person" }, phone: { text: "", state: "blank", by: "person" },
      email: { text: "", state: "blank" }, request: { text: "", state: "blank" } } }]))
      .toContain("Name: Sam Lee (typed by a person; unclear on the card, worth a look)\nPhone: blank on the card\n");
  });
});
