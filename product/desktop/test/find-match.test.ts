// Find in Ozzie's matching (owner decision 2026-11-24): case and accents don't matter and no letter is lost, every typed
// word must start a word of the item, five letters or more may have one letter off, a title match comes before one in
// an item's other words and a clean match before one with a letter off, and equal matches keep their order. Pure: fixed
// words only.
import { describe, expect, it } from "vitest";
import { fold, itemWords, matching, matchTier, typedWords, wordMatch } from "../src/find-match.js";

const titles = (list: { title: string }[]) => list.map(i => i.title);

describe("folding what is typed and what is found", () => {
  it("drops case and accents, keeps every letter, and spells the few whole letters plainly", () => {
    expect(fold("Zoë Ångström")).toBe("zoe angstrom");
    expect(fold("Sørensen Łukasz Strauß Đặng Æsir Œuvre")).toBe("sorensen lukasz strauss dang aesir oeuvre");
    // Letters with no plain spelling are kept, never dropped.
    expect(fold("Чайковский 王芳 김민준")).toBe("чаиковскии 王芳 김민준");
    expect(fold("İlkay")).toBe("ilkay");
  });

  it("splits words at spaces and punctuation, joins apostrophes, and keeps a hyphenated name findable whole and in parts", () => {
    expect(typedWords("  O'Brien,   mary-jane ")).toEqual(["obrien", "mary", "jane"]);
    expect(typedWords("Ríley’s")).toEqual(["rileys"]);
    expect(itemWords("Mary-Jane O’Brien")).toEqual(["mary", "jane", "maryjane", "obrien"]);
    expect(typedWords("—")).toEqual([]);
  });
});

describe("one typed word against one word", () => {
  it("matches the start of a word, never the middle", () => {
    expect(wordMatch("gre", "greeter")).toBe(2);
    expect(wordMatch("eter", "greeter")).toBe(0);
    expect(wordMatch("greeter", "gre")).toBe(0);
  });

  it("forgives one letter changed, missing, extra or swapped, but only from five letters", () => {
    expect(wordMatch("greter", "greeter")).toBe(1); // missing
    expect(wordMatch("greeeter", "greeter")).toBe(1); // extra
    expect(wordMatch("greiter", "greeter")).toBe(1); // changed
    expect(wordMatch("gerete", "greeter")).toBe(1); // swapped neighbours, at the start of the word
    expect(wordMatch("nursary", "nursery")).toBe(1);
    expect(wordMatch("nurs", "nursery")).toBe(2);
    // Four letters: no forgiveness ("rily" is not "riley").
    expect(wordMatch("rily", "riley")).toBe(0);
    expect(wordMatch("ryley", "riley")).toBe(1);
    // Two letters off is not one.
    expect(wordMatch("grxxter", "greeter")).toBe(0);
    expect(wordMatch("abcdef", "greeter")).toBe(0);
  });
});

describe("an item against everything typed", () => {
  it("needs every typed word, each starting a word of the item, in any order", () => {
    expect(matchTier(typedWords("gre vol"), { title: "Greeter volunteers" })).toBe(0);
    expect(matchTier(typedWords("vol gre"), { title: "Greeter volunteers" })).toBe(0);
    expect(matchTier(typedWords("gre kids"), { title: "Greeter volunteers" })).toBeNull();
    expect(matchTier([], { title: "Greeter" })).toBeNull();
  });

  it("finds accented names typed plainly and plain names typed with accents", () => {
    expect(matchTier(typedWords("zoe"), { title: "Zoë Brightwater" })).toBe(0);
    expect(matchTier(typedWords("ZOË"), { title: "Zoe Brightwater" })).toBe(0);
    expect(matchTier(typedWords("sorensen"), { title: "Ingrid Sørensen" })).toBe(0);
    expect(matchTier(typedWords("王"), { title: "王芳" })).toBe(0);
  });

  it("tiers: clean in the title, then a letter off in the title, then other words, clean before a letter off", () => {
    expect(matchTier(typedWords("settings"), { title: "Settings" })).toBe(0);
    expect(matchTier(typedWords("setings"), { title: "Settings" })).toBe(1);
    expect(matchTier(typedWords("quiet"), { title: "What Ozzie runs and notices", other: ["quiet hours"] })).toBe(2);
    expect(matchTier(typedWords("quiat hours"), { title: "What Ozzie runs and notices", other: ["quiet hours"] })).toBe(3);
    // A word found in the title with a letter off counts as in the title.
    expect(matchTier(typedWords("notises"), { title: "What Ozzie runs and notices", other: ["notices"] })).toBe(1);
  });
});

describe("a list of items", () => {
  const items = [
    { title: "Keeping watch", other: ["notifications", "quiet hours"] },
    { title: "What Ozzie runs and notices", other: ["notifications", "quiet hours"] },
    { title: "Notifications" },
    { title: "Notifications" },
  ];

  it("puts title matches first, clean before forgiven, and keeps the given order between equals", () => {
    const found = matching("notifications", items);
    expect(titles(found)).toEqual(["Notifications", "Notifications", "Keeping watch", "What Ozzie runs and notices"]);
    expect(found[0]).toBe(items[2]);
    expect(found[1]).toBe(items[3]);
    expect(titles(matching("notifcations", items))).toEqual(["Notifications", "Notifications", "Keeping watch", "What Ozzie runs and notices"]);
  });

  it("keeps the given order when asked, whatever matched better (a list of people is never reordered by match)", () => {
    const people = [{ title: "Avery Sorensen" }, { title: "Sorensen Blake" }, { title: "Casey", other: ["Sorensen"] }];
    expect(titles(matching("soren", people, true))).toEqual(["Avery Sorensen", "Sorensen Blake", "Casey"]);
    expect(titles(matching("soren", people))).toEqual(["Avery Sorensen", "Sorensen Blake", "Casey"]);
    expect(titles(matching("sorensn", [{ title: "Casey", other: ["Sorensen"] }, { title: "Avery Sorensen" }], true))).toEqual(["Casey", "Avery Sorensen"]);
  });

  it("finds nothing for nothing typed, and nothing for words that start no word", () => {
    expect(matching("   ", items)).toEqual([]);
    expect(matching("zzzz", items)).toEqual([]);
  });
});

describe("folding keeps every script's letters (review of release-find, Low)", () => {
  it("reads ligatures and full-width letters as plain letters, and keeps the signs of scripts whose marks are part of the letter", () => {
    expect(fold("ﬁnn Ｇｒａｃｅ")).toBe("finn grace");
    // Devanagari's vowel signs are marks, and part of the word: kept, and the word stays one word.
    expect(fold("किशोर")).toBe("किशोर");
    expect(typedWords("किशोर दास")).toEqual(["किशोर", "दास"]);
    expect(matchTier(typedWords("किशो"), { title: "किशोर दास" })).toBe(0);
    // Latin, Greek and Cyrillic accents still come off.
    expect(fold("Ἀθηνᾶ Zoë Йосип")).toBe("αθηνα zoe иосип");
  });
});
