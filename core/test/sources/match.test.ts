// Matching a list's rows to Planning Center teams and positions: Ozzie only suggests a same-named team or position,
// and a Sunday card shows a list's rows only where the leader chose the match, only the ticked columns. Nothing here
// takes a person's name from Planning Center, so nothing can compare one with a name in a list. Fictional data only.
import { describe, expect, it } from "vitest";
import type { PositionLabel } from "../../src/sunday-capture.js";
import { columnValues, matchFor, rowsFor, suggestMatches } from "../../src/sources/match.js";
import { parseSheet, type Sheet } from "../../src/sources/sheet.js";
import type { SheetSource, SourceMatch } from "../../src/sources/types.js";

const sheetOf = (text: string): Sheet => {
  const result = parseSheet(text);
  if (!result.ok) throw new Error(result.problem);
  return result.sheet;
};
const KEYS = sheetOf([
  "Name,Team,Door,Notes",
  "Dana Fictional,Door greeters,Side door,Opens at 8",
  "Lee Example,Ushers,Front door,",
  "Remy Sample,Parking,North gate,",
  "Zoe Sample,Ushers,,Back-up",
  "Sam Example,ushers,Office,",
].join("\n"));
const positions: PositionLabel[] = [
  { position_id: "position:1", team_id: "101", name: "Door greeter", interval: null },
  { position_id: "position:2", team_id: "101", name: "Usher", interval: null },
  { position_id: "position:3", team_id: "202", name: "Lot lead", interval: null },
  { position_id: "position:4", team_id: "303", name: "Leader", interval: null },
  { position_id: "position:5", team_id: "404", name: "Leader", interval: null },
];
const source = (over: Partial<Pick<SheetSource, "column" | "ticked">> & { matches?: Record<string, SourceMatch> } = {}): Pick<SheetSource, "column" | "ticked" | "matches"> => ({
  column: over.column === undefined ? "Team" : over.column,
  ticked: over.ticked ?? ["Name", "Door"],
  matches: new Map(Object.entries(over.matches ?? { Ushers: { team_id: "101" }, "Door greeters": { team_id: "101", position_name: "Door greeter" } })),
});

describe("suggestMatches: a same name, offered, never applied", () => {
  it("suggests the one team or position with the same name, ignoring case and spacing", () => {
    const suggestions = suggestMatches(["door  GREETER ", "Usher", "Leader", "Parking", "Ushers", "Usher", "Lot lead"], [...positions, { team_id: "202", name: "Parking" }]);
    expect(suggestions).toEqual([
      { value: "door  GREETER ", what: "position", match: { team_id: "101", position_name: "Door greeter" } },
      { value: "Usher", what: "position", match: { team_id: "101", position_name: "Usher" } },
      { value: "Parking", what: "team", match: { team_id: "202" } },
      { value: "Lot lead", what: "position", match: { team_id: "202", position_name: "Lot lead" } },
    ]);
  });

  it("suggests nothing when the same name belongs to more than one team or position, and prefers a team over its positions", () => {
    expect(suggestMatches(["Leader"], positions)).toEqual([]);
    expect(suggestMatches(["Parking"], [{ team_id: "202", name: "Parking" }, { team_id: "203", name: "parking" }])).toEqual([]);
    const greeters: PositionLabel = { position_id: "position:9", team_id: "101", name: "Greeters", interval: null };
    expect(suggestMatches(["Greeters"], [{ team_id: "101", name: "Greeters" }, greeters])).toEqual([{ value: "Greeters", what: "team", match: { team_id: "101" } }]);
    // The same position listed twice (two service times) is still one position.
    const again: PositionLabel = { ...positions[1]!, position_id: "position:6" };
    expect(suggestMatches(["Usher"], [...positions, again])).toHaveLength(1);
    expect(suggestMatches([""], [{ team_id: "1", name: "" }])).toEqual([]);
  });
});

describe("matchFor: what the leader's choice saves", () => {
  it("is a team by its id, or a position by its team's id and its own name", () => {
    expect(matchFor({ team_id: "202", name: "Parking" })).toEqual({ team_id: "202" });
    expect(matchFor(positions[0]!)).toEqual({ team_id: "101", position_name: "Door greeter" });
    expect(matchFor({ position_id: "position:1", team_id: "101", name: `  Door${String.fromCodePoint(0x202e)}  greeter ` })).toEqual({ team_id: "101", position_name: "Door greeter" });
    expect(matchFor({ team_id: "team-a", name: "Parking" })).toBeNull();
    expect(matchFor({ position_id: "position:1", team_id: "101", name: " " })).toBeNull();
  });
});

describe("columnValues", () => {
  it("lists the different values in a column in file order, blanks left out", () => {
    expect(columnValues(KEYS, "Team")).toEqual(["Door greeters", "Ushers", "Parking", "ushers"]);
    expect(columnValues(KEYS, "Door")).toEqual(["Side door", "Front door", "North gate", "Office"]);
    expect(columnValues(KEYS, "Missing")).toEqual([]);
  });
});

describe("rowsFor: a list's rows beside a matched Sunday card", () => {
  it("shows the rows matched to the card's team or position, in file order, only the ticked columns", () => {
    expect(rowsFor(KEYS, source(), { team_id: "101", position_id: "position:1", name: "Door greeter" })).toEqual({
      columns: ["Name", "Door"],
      rows: [["Dana Fictional", "Side door"], ["Lee Example", "Front door"], ["Zoe Sample", ""]],
    });
    // A team match shows on every position of that team; a position match only on that position.
    expect(rowsFor(KEYS, source(), { team_id: "101", position_id: "position:2", name: "Usher" })?.rows).toEqual([["Lee Example", "Front door"], ["Zoe Sample", ""]]);
    // A card for the team itself shows only what was matched to the team.
    expect(rowsFor(KEYS, source(), { team_id: "101", name: "Door greeter" })?.rows).toEqual([["Lee Example", "Front door"], ["Zoe Sample", ""]]);
    // A position with the same name on another team gets nothing.
    expect(rowsFor(KEYS, source(), { team_id: "999", position_id: "position:7", name: "Door greeter" })).toBeNull();
  });

  it("matches only the exact value the leader matched: never a near name, never a person", () => {
    // "ushers" (lower case) was not matched, so Sam's row isn't shown.
    const shown = rowsFor(KEYS, source({ ticked: ["Name"] }), { team_id: "101", position_id: "position:2", name: "Usher" });
    expect(shown?.rows).toEqual([["Lee Example"], ["Zoe Sample"]]);
    expect(rowsFor(KEYS, source({ matches: {} }), { team_id: "101", position_id: "position:1", name: "Door greeter" })).toBeNull();
    // A name that happens to match a position's name means nothing unless chosen as the column and matched.
    expect(rowsFor(KEYS, source({ column: "Name", matches: { "Door greeter": { team_id: "101" } } }), { team_id: "101", position_id: "position:1", name: "Door greeter" })).toBeNull();
  });

  it("shows ticked columns in the sheet's order, at most 8, and leaves out a row with nothing in them", () => {
    expect(rowsFor(KEYS, source({ ticked: ["Door", "Name", "Team"] }), { team_id: "101", position_id: "position:2", name: "Usher" })?.columns).toEqual(["Name", "Team", "Door"]);
    expect(rowsFor(KEYS, source({ ticked: ["Door"] }), { team_id: "101", position_id: "position:2", name: "Usher" })?.rows).toEqual([["Front door"]]);
    const wide = sheetOf(`${Array.from({ length: 12 }, (_, i) => `C${i}`).join(",")}\n${Array.from({ length: 12 }, (_, i) => (i === 0 ? "Ushers" : `v${i}`)).join(",")}\n`);
    const all = rowsFor(wide, { column: "C0", ticked: Array.from({ length: 12 }, (_, i) => `C${i}`), matches: new Map([["Ushers", { team_id: "101" }]]) }, { team_id: "101", name: "Ushers" });
    expect(all?.columns).toEqual(["C0", "C1", "C2", "C3", "C4", "C5", "C6", "C7"]);
    expect(all?.rows[0]).toHaveLength(8);
  });

  it("shows nothing without a chosen column that is still in the file, or without a ticked column that is", () => {
    const card = { team_id: "101", position_id: "position:2", name: "Usher" };
    expect(rowsFor(KEYS, source({ column: null }), card)).toBeNull();
    expect(rowsFor(KEYS, source({ column: "Role" }), card)).toBeNull();
    expect(rowsFor(KEYS, source({ ticked: [] }), card)).toBeNull();
    expect(rowsFor(KEYS, source({ ticked: ["Phone"] }), card)).toBeNull();
    // A header named twice: the first column of that name is the one used.
    const twice = sheetOf("Team,Name,Team\nUshers,Lee Example,Parking\n");
    expect(rowsFor(twice, { column: "Team", ticked: ["Name", "Team"], matches: new Map([["Ushers", { team_id: "101" }]]) }, card)).toEqual({ columns: ["Team", "Name"], rows: [["Ushers", "Lee Example"]] });
  });
});
