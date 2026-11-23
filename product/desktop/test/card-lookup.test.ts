// Looking up the name on each visitor card in Planning Center People (owner decision 2026-11-23), without React: which
// names go out, once each, one at a time, capped, stopped and dropped with the cards, and the words each answer gets.
// Fictional names only (the test church's "Flo901 Visitor" and "Riley Fictional"); no real card or person.
import { describe, expect, it, vi } from "vitest";
const invoked: [string, unknown][] = [];
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn((command: string, args?: unknown) => { invoked.push([command, args]); return Promise.resolve({ result: "no-one" }); }) }));
import {
  availabilityLine, cardNames, LONGEST_WAIT_MS, LOOK_AGAIN, lookFirstLine, lookupAvailability, lookupWords, MAX_NAMES, NAME_CHARS, NAME_DIGITS, NameLookups, readReply, RETRY_MS, sameName,
  searchName, SOURCE, TRIES, UNCLEAR_NOT_LOOKED_UP, type CardNames, type NameLookup,
} from "../src/card-lookup.js";

const CHURCH = "1001";
const AT = Date.UTC(2026, 10, 22, 15, 42);
/** The answer the native command gives for one person found. */
const one = (id: string, name: string) => ({ result: "people", people: [{ id, name }] });

/** A fake native bridge: each lookup waits until the test answers it; every call is recorded. */
function bridge() {
  const calls: { church: string; name: string; answer: (v: unknown) => void; refuse: (code: string) => void }[] = [];
  let cancels = 0;
  const names: CardNames = {
    lookUp: (church, name) => new Promise((answer, refuse) => { calls.push({ church, name, answer, refuse }); }),
    cancel: () => { cancels++; return Promise.resolve(); },
  };
  return { names, calls, cancels: () => cancels };
}
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
function lookups(names: CardNames, church: () => string | null = () => CHURCH) {
  const waits: number[] = [];
  let changes = 0, refused = 0;
  const l = new NameLookups({
    names, church, now: () => AT, wait: async ms => { waits.push(ms); }, onChange: () => { changes++; }, onRefused: () => { refused++; },
  });
  return { l, waits, changes: () => changes, refused: () => refused };
}

describe("which names on the cards are looked up", () => {
  it("only a plain name, as native checks it: never an email address, a phone number or a single letter", () => {
    expect(searchName("  Riley \t Fictional\n")).toBe("Riley Fictional");
    for (const good of ["Riley Fictional", "Flo901 Visitor", "Zoë", "Mary-Jane Watson", "J. R. Example", "O’Neil", "O'Neil", "李小龍", "a b c d e f"]) {
      expect(searchName(good), good).toBe(good);
    }
    expect(searchName("a".repeat(NAME_CHARS))).not.toBeNull();
    for (const bad of ["", " ", "R", "5550101", "555 0101", "R2", "a".repeat(NAME_CHARS + 1), "a b c d e f g", "riley@example.org", "Riley%", "Riley_Fictional",
      "Riley & Sam", "Riley=1", "Riley[0]", "Riley, Sam", "Riley/Sam", "Riley#Sam", "Riley?", "Riley+Sam", "\"Riley\"", "Riley\u0000Fictional", "Riley‮Fictional",
      "Riley​Fictional", "<b>Riley</b>", "Riley;Sam", null, undefined, 7]) {
      expect(searchName(bad), JSON.stringify(bad)).toBeNull();
    }
    // Composed the way native compares it.
    expect(searchName("José Example")).toBe("José Example");
  });

  it("never a phone number, nor part of one: a letter in every word, at most three digits (privacy review L1)", () => {
    for (const good of ["Flo901 Visitor", "Ann 3rd", "Riley2 Fictional", "J.R. Example"]) expect(searchName(good), good).toBe(good);
    for (const bad of ["Ann 555 0101", "Ann 5550101", "Ann 555-0101", "Ann 555.0101", "Room 12", "Ann 7", "Flo9012 Visitor", "Ann12 Bo34", "Ann - Example", "Ann . Example"]) {
      expect(searchName(bad), bad).toBeNull();
    }
    expect(NAME_DIGITS).toBe(3);
  });

  it("reads native's answer strictly, and lists people alphabetically, never in Planning Center's order", () => {
    expect(readReply({ result: "no-one" }, AT)).toEqual({ state: "none", at: AT });
    expect(readReply({ result: "more" }, AT)).toEqual({ state: "more", at: AT });
    expect(readReply({ result: "people", people: [{ id: "52", name: "Riley Fictional" }, { id: "51", name: "Riley Fictional" }, { id: "50", name: "Avery Fictional" }] }, AT))
      .toEqual({ state: "found", at: AT, people: [{ id: "50", name: "Avery Fictional" }, { id: "51", name: "Riley Fictional" }, { id: "52", name: "Riley Fictional" }] });
    for (const bad of [null, "people", {}, { result: "people", people: [] }, { result: "people" }, { result: "people", people: [{ id: "0x1", name: "Riley" }] },
      { result: "people", people: [{ id: "50", name: "" }] }, { result: "people", people: [{ id: "50", name: "A" }, { id: "50", name: "B" }] },
      { result: "people", people: Array.from({ length: 6 }, (_, i) => ({ id: `${50 + i}`, name: "Riley" })) }, { result: "found" }]) {
      expect(readReply(bad, AT), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("one review's lookups", () => {
  it("go out only once resumed, once per distinct name, one at a time, to the cards' church", async () => {
    const b = bridge();
    const { l } = lookups(b.names);
    l.want(["Riley Fictional", "riley   fictional", "Flo901 Visitor", "riley.f@example.org", "(555) 014-2290", ""]);
    await settle();
    // Paused until the page says the cards are being checked.
    expect(b.calls).toEqual([]);
    expect(l.get("Riley Fictional")).toEqual({ state: "looking" });
    l.resume();
    await settle();
    expect(b.calls.map(c => [c.church, c.name])).toEqual([[CHURCH, "Riley Fictional"]]);
    b.calls[0]!.answer(one("50", "Riley Fictional"));
    await settle();
    expect(l.get("RILEY FICTIONAL")).toEqual({ state: "found", at: AT, people: [{ id: "50", name: "Riley Fictional" }] });
    expect(b.calls.map(c => c.name)).toEqual(["Riley Fictional", "Flo901 Visitor"]);
    b.calls[1]!.answer({ result: "no-one" });
    await settle();
    expect(l.get("Flo901 Visitor")).toEqual({ state: "none", at: AT });
    // Asked again with the same names: nothing more goes out.
    l.want(["Riley Fictional", "Flo901 Visitor"]);
    await settle();
    expect(b.calls).toHaveLength(2);
    expect(l.count).toBe(2);
    // Never an email address or a phone number.
    expect(b.calls.map(c => c.name).join(" ")).not.toMatch(/@|555/u);
  });

  it(`looks up at most ${MAX_NAMES} names in one review, and says so for the rest`, async () => {
    const b = bridge();
    const { l } = lookups(b.names);
    l.resume();
    const many = Array.from({ length: MAX_NAMES + 5 }, (_, i) => `Fictional Person${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`);
    l.want(many);
    for (let i = 0; i < MAX_NAMES + 5; i++) { await settle(); b.calls.at(-1)?.answer({ result: "no-one" }); }
    await settle();
    expect(b.calls).toHaveLength(MAX_NAMES);
    expect(l.count).toBe(MAX_NAMES);
    expect(l.get(many.at(-1)!)).toEqual({ state: "not-checked", why: "cap" });
    expect(lookupWords(many.at(-1)!, l.get(many.at(-1)!)!)?.body).toBe(`Ozzie looks up at most ${MAX_NAMES} names in one set of cards.`);
  });

  it("a name no card holds any more is taken off the queue before it goes out", async () => {
    const b = bridge();
    const { l } = lookups(b.names);
    l.resume();
    l.want(["Riley Fictional", "Flo901 Visit"]);
    await settle();
    // The second card's name was corrected before its turn came.
    l.want(["Riley Fictional", "Flo901 Visitor"]);
    b.calls[0]!.answer({ result: "no-one" });
    await settle();
    expect(b.calls.map(c => c.name)).toEqual(["Riley Fictional", "Flo901 Visitor"]);
    expect(l.get("Flo901 Visit")).toBeNull();
    expect(l.count).toBe(2);
  });

  it("pausing (the cards hidden) stops what's under way natively and drops its late answer; resuming asks again", async () => {
    const b = bridge();
    const { l } = lookups(b.names);
    l.resume();
    l.want(["Riley Fictional"]);
    await settle();
    expect(b.calls).toHaveLength(1);
    l.pause();
    expect(b.cancels()).toBe(1);
    b.calls[0]!.answer(one("50", "Riley Fictional"));
    await settle();
    expect(l.get("Riley Fictional")).toEqual({ state: "looking" });
    l.want(["Riley Fictional"]);
    await settle();
    expect(b.calls).toHaveLength(1);
    l.resume();
    await settle();
    expect(b.calls).toHaveLength(2);
    b.calls[1]!.answer(one("50", "Riley Fictional"));
    await settle();
    expect(l.get("Riley Fictional")?.state).toBe("found");
  });

  it("clearing (the cards discarded) stops what's under way and drops everything found", async () => {
    const b = bridge();
    const { l } = lookups(b.names);
    l.resume();
    l.want(["Riley Fictional", "Flo901 Visitor"]);
    await settle();
    b.calls[0]!.answer(one("50", "Riley Fictional"));
    await settle();
    expect(l.get("Riley Fictional")?.state).toBe("found");
    l.clear();
    expect(b.cancels()).toBe(1);
    b.calls[1]!.answer(one("51", "Flo901 Visitor"));
    await settle();
    expect(l.get("Riley Fictional")).toBeNull();
    expect(l.get("Flo901 Visitor")).toBeNull();
    expect(l.count).toBe(0);
    // Nothing goes out until a new review resumes it.
    l.want(["Riley Fictional"]);
    await settle();
    expect(b.calls).toHaveLength(2);
  });

  it("asks again while Planning Center is being read or asked Ozzie to wait, then says it couldn't", async () => {
    const b = bridge();
    const { l, waits } = lookups(b.names);
    l.resume();
    l.want(["Riley Fictional"]);
    for (let i = 0; i < TRIES; i++) { await settle(); b.calls.at(-1)!.refuse(i % 2 ? "busy" : "too-many-just-now"); }
    await settle();
    expect(b.calls).toHaveLength(TRIES);
    expect(waits).toEqual(Array(TRIES - 1).fill(RETRY_MS));
    expect(l.get("Riley Fictional")).toEqual({ state: "not-checked", why: "could-not-check" });
    // The person's own "Look this name up again".
    l.again("Riley Fictional");
    await settle();
    expect(b.calls).toHaveLength(TRIES + 1);
    b.calls.at(-1)!.answer({ result: "more" });
    await settle();
    expect(l.get("Riley Fictional")).toEqual({ state: "more", at: AT });
    // Only a name that couldn't be looked up is asked again.
    l.again("Riley Fictional");
    await settle();
    expect(b.calls).toHaveLength(TRIES + 1);
  });

  it("waits as long as Planning Center asked before asking again (privacy review L2: Retry-After)", async () => {
    const b = bridge();
    const { l, waits } = lookups(b.names);
    l.resume();
    l.want(["Riley Fictional"]);
    await settle();
    // Native says busy with Planning Center's wait, or too many with the time until there's room, as an object.
    b.calls[0]!.refuse({ reason: "busy", wait_seconds: 30 } as unknown as string);
    await settle();
    b.calls[1]!.refuse({ reason: "too-many-just-now", wait_seconds: 12 } as unknown as string);
    await settle();
    // Never longer than native's longest wait, never shorter than the page's own pause.
    b.calls[2]!.refuse({ reason: "busy", wait_seconds: 9000 } as unknown as string);
    await settle();
    b.calls[3]!.refuse({ reason: "busy" } as unknown as string);
    await settle();
    b.calls[4]!.answer({ result: "no-one" });
    await settle();
    expect(waits).toEqual([30_000, 12_000, LONGEST_WAIT_MS, RETRY_MS]);
    expect(l.get("Riley Fictional")).toEqual({ state: "none", at: AT });
    // Still one name, asked five times: the review's cap counts names, and native paces every lookup.
    expect(l.count).toBe(1);
    // Any other reason in that shape says it couldn't, at once.
    const c = bridge();
    const other = lookups(c.names);
    other.l.resume();
    other.l.want(["Flo901 Visitor"]);
    await settle();
    c.calls[0]!.refuse({ reason: "could-not-check", wait_seconds: 5 } as unknown as string);
    await settle();
    expect(c.calls).toHaveLength(1);
    expect(other.waits).toEqual([]);
  });

  it("any other failure says it couldn't, at once", async () => {
    for (const code of ["could-not-check", "not-connected", "church-changed", "invalid-name", "cancelled", "something new", 42]) {
      const b = bridge();
      const { l } = lookups(b.names);
      l.resume();
      l.want(["Riley Fictional"]);
      await settle();
      b.calls[0]!.refuse(code as string);
      await settle();
      expect(b.calls, String(code)).toHaveLength(1);
      expect(l.get("Riley Fictional")).toEqual({ state: "not-checked", why: "could-not-check" });
    }
  });

  it("Planning Center refusing People stops every lookup for these cards until People is allowed again", async () => {
    const b = bridge();
    const { l, refused } = lookups(b.names);
    l.resume();
    l.want(["Riley Fictional", "Flo901 Visitor"]);
    await settle();
    b.calls[0]!.refuse("not-allowed");
    await settle();
    expect(refused()).toBe(1);
    expect(b.calls).toHaveLength(1);
    expect(l.get("Riley Fictional")).toBeNull();
    l.want(["Riley Fictional", "Flo901 Visitor"]);
    await settle();
    expect(b.calls).toHaveLength(1);
    l.allowAgain();
    l.want(["Riley Fictional", "Flo901 Visitor"]);
    await settle();
    expect(b.calls.map(c => c.name)).toEqual(["Riley Fictional", "Riley Fictional"]);
  });

  it("with no church in use, nothing goes out", async () => {
    const b = bridge();
    const { l } = lookups(b.names, () => null);
    l.resume();
    l.want(["Riley Fictional"]);
    await settle();
    expect(b.calls).toEqual([]);
    expect(l.get("Riley Fictional")).toEqual({ state: "not-checked", why: "could-not-check" });
  });

  it("the bridge names only its two native commands, and sends only the church and the name", async () => {
    invoked.length = 0;
    await cardNames.lookUp(CHURCH, "Riley Fictional");
    await cardNames.cancel();
    expect(invoked).toEqual([["look_up_card_name", { church: CHURCH, name: "Riley Fictional" }], ["cancel_card_name_lookups", undefined]]);
  });
});

describe("whether names are looked up at all", () => {
  const base = { example: false, access: "allowed" as const, disconnected: false, signInAgain: false, inUse: CHURCH, cardsChurch: CHURCH };
  it("only for the church the cards belong to while it is in use, with People allowed, never while the example is on", () => {
    expect(lookupAvailability(base)).toBe("on");
    expect(lookupAvailability({ ...base, example: true })).toBe("example");
    expect(lookupAvailability({ ...base, access: "other-system" })).toBe("other-system");
    expect(lookupAvailability({ ...base, disconnected: true, inUse: null })).toBe("not-connected");
    expect(lookupAvailability({ ...base, signInAgain: true, inUse: null })).toBe("sign-in-again");
    expect(lookupAvailability({ ...base, inUse: null })).toBe("waiting");
    expect(lookupAvailability({ ...base, cardsChurch: "2002" })).toBe("waiting");
    expect(lookupAvailability({ ...base, access: "unknown" })).toBe("waiting");
    expect(lookupAvailability({ ...base, access: "not-allowed" })).toBe("not-allowed");
    // The example wins over everything: its people are made up, and the cards are real.
    expect(lookupAvailability({ ...base, example: true, access: "not-allowed" })).toBe("example");
  });

  it("says why, once, in plain words", () => {
    const notHere = (what: string) => `${what} works with Planning Center only for now. Ozzie can't do this with B1 Church yet.`;
    expect(availabilityLine("on", notHere)).toBeNull();
    expect(availabilityLine("waiting", notHere)).toBeNull();
    expect(availabilityLine("example", notHere)).toBe("Names on the cards aren't looked up in Planning Center People either.");
    expect(availabilityLine("other-system", notHere)).toBe("Looking up each card's name in Planning Center People works with Planning Center only for now. Ozzie can't do this with B1 Church yet.");
    expect(availabilityLine("not-connected", notHere)).toBe("Connect Planning Center to look up each card's name in Planning Center People.");
    expect(availabilityLine("sign-in-again", notHere)).toBe("Sign in to Planning Center again in Settings to look up each card's name in Planning Center People.");
    expect(availabilityLine("not-allowed", notHere)).toBe("Ozzie can look up the name on each card in Planning Center People to show whether someone with that name is already there. Your Planning Center connection doesn't include People yet.");
    expect(availabilityLine("refused", notHere)).toBe("Planning Center didn't let Ozzie read People, so names on the cards aren't looked up. A Planning Center administrator at your church can give your account access to People.");
  });
});

describe("the words on a card", () => {
  const time = new Date(AT).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const found = (...people: [string, string][]): NameLookup => ({ state: "found", at: AT, people: people.map(([id, name]) => ({ id, name })) });
  it("one person with the same name: never that it is the same person", () => {
    expect(lookupWords("Riley Fictional", found(["50", "Riley Fictional"]))).toEqual({
      lead: "Same name in Planning Center: Riley Fictional",
      body: "Planning Center has a person with this name. It may be someone else with the same name.",
      source: `Looked up in Planning Center People at ${time}. Ozzie won't combine anyone or add anyone.`, worth: true,
    });
    expect(SOURCE(AT)).toBe(`Looked up in Planning Center People at ${time}. Ozzie won't combine anyone or add anyone.`);
    // Capitals and accents aside, it's the same name; anything more is a similar name.
    expect(lookupWords("riley fictional", found(["50", "Riley Fictional"]))?.lead).toBe("Same name in Planning Center: Riley Fictional");
    expect(lookupWords("Riley Fictional", found(["51", "Riley Fictionalson"]))).toMatchObject({
      lead: "Similar name in Planning Center: Riley Fictionalson",
      body: "Planning Center found this person when Ozzie looked up the name on the card. It may be someone else.",
    });
    expect(sameName("Flo901 Visitor", "Flo901 Visitor")).toBe(true);
  });
  it("several, more than five, none, and couldn't", () => {
    expect(lookupWords("Riley Fictional", found(["50", "Riley Fictional"], ["52", "Riley Fictional"]))).toMatchObject({
      lead: "Same name in Planning Center: 2 people",
      body: "Riley Fictional and Riley Fictional. Only the names match: any of them, or none, may be this person.", worth: true,
    });
    expect(lookupWords("Riley", { state: "more", at: AT })).toMatchObject({
      lead: "Similar names in Planning Center: more than 5 people",
      body: "Search Planning Center People for this name to see whether one of them is this person.", worth: true,
    });
    expect(lookupWords("Flo901 Visitor", { state: "none", at: AT })).toEqual({
      lead: "Not found in Planning Center",
      // Privacy review L4: only what Ozzie found, never that no one in Planning Center has the name.
      body: "Ozzie found no one in Planning Center People with this name. They may be there under another spelling or name, or where your account can't see them, so check before adding anyone.",
      source: SOURCE(AT), worth: false,
    });
    expect(lookupWords("Flo901 Visitor", { state: "not-checked", why: "could-not-check" })).toEqual({
      lead: "Not looked up", body: "Ozzie couldn't look this name up in Planning Center just now.", source: null, worth: false,
    });
    expect(LOOK_AGAIN).toBe("Look this name up again");
    expect(UNCLEAR_NOT_LOOKED_UP).toBe("Not looked up while the name is marked hard to read. Check it against the photo first.");
  });
  it("Look at these first names Planning Center's people, never as the same person; nothing for none", () => {
    expect(lookFirstLine("Card 1", "Riley Fictional", found(["50", "Riley Fictional"]))).toBe(
      "Card 1: Planning Center People has someone with a name like “Riley Fictional” (Riley Fictional). Worth a look: only the name matches, which doesn't show it's the same person. Check Planning Center before adding anyone.");
    expect(lookFirstLine("Card 2", "Riley", { state: "more", at: AT })).toBe("Card 2: more than 5 people in Planning Center People have a name like “Riley”. Worth a look before adding anyone.");
    expect(lookFirstLine("Card 3", "Flo901 Visitor", { state: "none", at: AT })).toBeNull();
    expect(lookFirstLine("Card 3", "Flo901 Visitor", { state: "looking" })).toBeNull();
  });
  it("never scores, ranks or labels anyone", () => {
    const all = [
      lookupWords("Riley Fictional", found(["50", "Riley Fictional"])), lookupWords("Riley Fictional", found(["50", "Riley Fictional"], ["51", "Riley Fictionalson"])),
      lookupWords("Riley", { state: "more", at: AT }), lookupWords("Riley", { state: "none", at: AT }),
    ].map(w => `${w?.lead} ${w?.body} ${w?.source}`).join(" ");
    expect(all).not.toMatch(/\b(?:best|likely|probably|most|top|score|rank|match(?:es)? \d|%|risk|drifting|confident|definitely|certainly|is the same person)\b/iu);
  });
});
