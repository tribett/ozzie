// A watched service's name in a question (core/src/service-names.ts): the shared vectors native runs too
// (service-names-parity.json, name_guard.rs), where each name counts and which service it stands for, and the look-alike
// table, held to native's own. Fixed fictional names.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COMMON_WORDS } from "../src/harness/fixed.js";
import { lookalikes, serviceKey, serviceMatches, serviceNamed, wordRuns, type ServiceMatchOptions } from "../src/service-names.js";

const here = dirname(fileURLToPath(import.meta.url));
const parity = JSON.parse(readFileSync(join(here, "service-names-parity.json"), "utf8")) as { groups: { services: string[]; cases: { text: string; named: boolean }[] }[] };
const WEEKEND = "Weekend Service", YOUTH = "Ozzie Demo Youth Night (fictional)";
const common: ServiceMatchOptions = { common: COMMON_WORDS };
/** Each counted place, as the text it covers and the services it stands for. */
const found = (text: string, services: readonly string[], options: ServiceMatchOptions = common) =>
  serviceMatches(text, services, options).map(m => [text.slice(m.start, m.end), m.services.join(" | ")]);

describe("the shared vectors (native runs the same file)", () => {
  for (const group of parity.groups) {
    it(`${group.services.join(" + ")}`, () => {
      for (const c of group.cases) expect(serviceNamed(c.text, group.services, common), c.text).toBe(c.named);
    });
  }
});

describe("where a watched service's name counts, and which service it is", () => {
  const two = [WEEKEND, YOUTH];
  it("a whole name takes the name's own brackets with it, in either form a role is said with its service", () => {
    expect(found("Who could cover Greeter (Weekend Service)?", two)).toEqual([["Weekend Service", WEEKEND]]);
    // Longest first: the whole name (with its closing bracket), then its parts, which Ask never takes inside it.
    expect(found(`Who could cover Greeter — ${YOUTH}?`, two)[0]).toEqual([YOUTH, YOUTH]);
    expect(found(`Who could cover Greeter — ${YOUTH}?`, two).every(([, s]) => s === YOUTH)).toBe(true);
    // Square brackets were turned into parentheses when the question was cleaned; a name written with them reads the same.
    expect(found("Is Ozzie Demo Youth Night (fictional) short?", [WEEKEND, "Ozzie Demo Youth Night [fictional]"])[0]).toEqual([YOUTH, "Ozzie Demo Youth Night [fictional]"]);
  });

  it("a part of two or more words belongs to its one service; a part two services share stands for both (unclear); never one word", () => {
    expect(found("Is Youth Night short?", two)).toEqual([["Youth Night", YOUTH]]);
    expect(found("Is Weekend short?", two)).toEqual([]);
    const campuses = ["Riverside Campus 9am", "Riverside Campus 11am"];
    expect(found("Is Riverside Campus short?", campuses)).toEqual([["Riverside Campus", "Riverside Campus 9am | Riverside Campus 11am"]]);
    expect(found("Is Riverside Campus 11am short?", campuses)[0]).toEqual(["Riverside Campus 11am", "Riverside Campus 11am"]);
    // A part that is another watched service's whole name is that service.
    expect(found("Is Youth Night short?", [YOUTH, "Youth Night"])).toEqual([["Youth Night", "Youth Night"]]);
  });

  it("a part counts only with a word that marks it out (review A, M1): never small words, numbers, AM or a lone possessive", () => {
    expect(found("Who could cover Greeter in the morning?", [WEEKEND, "Worship in the Park"])).toEqual([]);
    expect(found("Who could cover Greeter in the Park?", [WEEKEND, "Worship in the Park"])[0]).toEqual(["in the Park", "Worship in the Park"]);
    expect(found("Who could cover Greeter at 9:00 AM?", ["8:00 AM", "10:30 AM"])).toEqual([]);
    expect(found("Is the 10:00 AM Service covered?", ["9:00 AM Service", "11:00 AM Service"])).toEqual([]);
    expect(found("Is the children's area covered?", [WEEKEND, "Children's Church"])).toEqual([]);
    // A marked part shared by two services stands for both (Ask labels each).
    expect(found("who serves at the main campus this week?", ["Main Campus 9am", "Main Campus 11am"])).toEqual([["main campus", "Main Campus 9am | Main Campus 11am"]]);
  });

  it("in the strict name mode a small word never marks a part either (review A, round 2, N4)", () => {
    expect(found("Who could cover Greeter in the morning?", [WEEKEND, "Worship in the Park"], {})).toEqual([]);
    expect(found("Who could cover Greeter in the Park?", [WEEKEND, "Worship in the Park"], {})[0]).toEqual(["in the Park", "Worship in the Park"]);
  });

  it("a plural or possessive on the name's last word, and an apostrophe inside a word, still name it (review A, L1)", () => {
    expect(found("Are the Weekend Services covered?", [WEEKEND, YOUTH])[0]).toEqual(["Weekend Services", WEEKEND]);
    expect(found("Is Men's Breakfast covered?", ["Mens Breakfast", "Women's Breakfast"])).toEqual([["Men's Breakfast", "Mens Breakfast"]]);
  });

  it("a part that is a roster member's name is never read as a service (Ask passes them, ask.ts)", () => {
    const named = ["Riley Thornbury Memorial Service", WEEKEND];
    expect(found("Is Riley Thornbury free?", named)).toEqual([["Riley Thornbury", "Riley Thornbury Memorial Service"]]);
    expect(found("Is Riley Thornbury free?", named, { ...common, exclude: new Set(wordRuns("Riley Thornbury")) })).toEqual([]);
    expect(wordRuns("Mary Kate de la Cruz")).toContain("de la cruz");
  });

  it("everyday names follow the owner's capital rule, unless run together; the strict mode reads them in any case", () => {
    const ordinary = ["Sunday Morning", "Services"];
    expect(found("who is serving sunday morning?", ordinary)).toEqual([]);
    expect(found("who is serving sunday morning?", ordinary, {})).toEqual([["sunday morning", "Sunday Morning"]]);
    expect(found("Who is serving Sunday Morning?", ordinary)).toEqual([["Sunday Morning", "Sunday Morning"]]);
    expect(found("who is serving sunday-morning?", ordinary)).toEqual([["sunday-morning", "Sunday Morning"]]);
    // A weekday alone is never a service, even in the strict mode.
    expect(found("Is Sunday short?", ["Sunday", WEEKEND], {})).toEqual([]);
  });

  it("names that read the same are one service, and both are watched; with fewer than two services nothing counts", () => {
    expect(serviceKey("  Weekend   SERVICE ")).toBe(serviceKey("weekend service"));
    expect(found("Is Weekend Service short?", [WEEKEND, "weekend service"])).toEqual([["Weekend Service", WEEKEND]]);
    expect(found("Is Sunday Service short?", ["Sunday Service", "Sunday Service"])).toEqual([["Sunday Service", "Sunday Service"]]);
    expect(found("Is Weekend Service short?", [WEEKEND])).toEqual([]);
    expect(found("Is Weekend Service short?", [])).toEqual([]);
  });
});

describe("look-alike letters", () => {
  it("are read through the native check's own table, entry for entry", () => {
    const rust = readFileSync(join(here, "../native-auth/src/name_guard.rs"), "utf8");
    const body = rust.slice(rust.indexOf("fn lookalike(c: char) -> Option<char> {"), rust.indexOf("fn lookalike_fold"));
    const native = new Map<string, string>();
    for (const arm of body.matchAll(/((?:'\\u\{[0-9a-f]+\}'\s*\|?\s*)+)=>\s*'([A-Za-z])'/gu)) {
      for (const cp of arm[1]!.matchAll(/\\u\{([0-9a-f]+)\}/gu)) native.set(String.fromCodePoint(parseInt(cp[1]!, 16)), arm[2]!);
    }
    expect(native.size).toBeGreaterThan(90);
    expect(new Map([...lookalikes()].sort())).toEqual(new Map([...native].sort()));
  });
});
