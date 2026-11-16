// The list of church-added sources as native code sends it to the page: a closed format, refused whole when anything
// in it falls outside (as core/mcp/snapshot.ts parseSharedCheck refuses its file). Fictional data only.
import { describe, expect, it } from "vitest";
import { MAX_LINKS, MAX_SOURCES, MAX_TICKED, parseSourceList, SOURCE_KINDS, type SheetSource } from "../../src/sources/types.js";

const cp = (...points: number[]) => String.fromCodePoint(...points);
const fileEntry = (over: Record<string, unknown> = {}) => ({
  id: "src-1", kind: "file", label: "Key holders", shown: "key-holders.csv", column: "Team", ticked: ["Name", "Door"],
  matches: { Ushers: { team_id: "123" }, "Door greeters": { team_id: "123", position_name: "Door greeter" } },
  read_at: "2026-11-15T15:06:00.000Z", ...over,
});
const linkEntry = (over: Record<string, unknown> = {}) => ({
  id: "src-2", kind: "link", label: "Snack rota", shown: "docs.google.com/…/pub", column: null, ticked: [], matches: {}, read_at: null, ...over,
});
const notesEntry = (over: Record<string, unknown> = {}) => ({
  id: "src-3", kind: "notes", label: "Welcome team notes", shown: "welcome.md",
  attachments: [{ section: "Child safety policy", team_id: "456" }, { section: "Building keys", finding_kind: "lead-missing" }],
  read_at: "2026-11-15T15:06:00Z", ...over,
});
/** As it would come through the bridge: JSON, parsed. */
const wire = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;

describe("a pointer's title and occurrence (review V)", () => {
  it("keeps which occurrence of a repeated title was chosen, and reads an older pointer as the first", () => {
    const list = parseSourceList([{ id: "n1", kind: "notes", label: "Policy", shown: "policy.md", read_at: null,
      attachments: [{ section: "Who to call", team_id: "1" }, { section: "Who to call", finding_kind: "pending", occurrence: 2 }] }]);
    expect(list?.[0]).toMatchObject({ attachments: [{ section: "Who to call", team_id: "1" }, { section: "Who to call", finding_kind: "pending", occurrence: 2 }] });
  });

  it("checks a title with joiners set aside, so a runtime reading them another way never makes the whole list unreadable", () => {
    const zwj = String.fromCodePoint(0x200d);
    // A joiner this page's rule would drop (before a space), as native code may have kept it.
    const list = parseSourceList([{ id: "n1", kind: "notes", label: "Policy", shown: "policy.md", read_at: null, attachments: [{ section: `Snow${zwj} days`, team_id: "1" }] }]);
    expect(list).not.toBeNull();
    // Anything else outside a title's form is still refused.
    for (const section of ["Snow  days", " Snow days", `Snow${String.fromCodePoint(0x202e)} days`, "x".repeat(121)]) {
      expect(parseSourceList([{ id: "n1", kind: "notes", label: "Policy", shown: "policy.md", read_at: null, attachments: [{ section, team_id: "1" }] }]), section).toBeNull();
    }
  });
});

describe("parseSourceList", () => {
  it("reads one source of each kind, with matches by the value in the chosen column", () => {
    expect(SOURCE_KINDS).toEqual(["file", "link", "notes"]);
    const list = parseSourceList(wire([fileEntry(), linkEntry(), notesEntry()]));
    expect(list).not.toBeNull();
    const [file, link, notes] = list!;
    expect(file).toMatchObject({ id: "src-1", kind: "file", label: "Key holders", shown: "key-holders.csv", column: "Team", ticked: ["Name", "Door"], read_at: "2026-11-15T15:06:00.000Z" });
    const matches = (file as SheetSource).matches;
    expect(matches).toBeInstanceOf(Map);
    expect([...matches]).toEqual([["Ushers", { team_id: "123" }], ["Door greeters", { team_id: "123", position_name: "Door greeter" }]]);
    expect(link).toMatchObject({ kind: "link", column: null, ticked: [], read_at: null });
    expect(notes).toEqual(wire(notesEntry()));
    expect(parseSourceList(wire([]))).toEqual([]);
  });

  it("keys matches safely: a value that names a built-in property is just a value", () => {
    const list = parseSourceList(JSON.parse(`[${JSON.stringify(fileEntry({ matches: {} })).replace("\"matches\":{}", "\"matches\":{\"__proto__\":{\"team_id\":\"9\"},\"constructor\":{\"team_id\":\"8\"}}")}]`));
    const matches = (list![0] as SheetSource).matches;
    expect(matches.get("__proto__")).toEqual({ team_id: "9" });
    expect(matches.get("constructor")).toEqual({ team_id: "8" });
    expect(matches.get("toString")).toBeUndefined();
    expect(({} as Record<string, unknown>)["team_id"]).toBeUndefined();
  });

  it("refuses the whole list for anything outside the format", () => {
    const bad: unknown[] = [
      null, {}, "[]", [null], [7],
      [fileEntry({ extra: true })],
      [Object.fromEntries(Object.entries(fileEntry()).filter(([k]) => k !== "read_at"))],
      [fileEntry({ kind: "sheet" })], [fileEntry({ kind: "notes" })], [notesEntry({ kind: "file" })],
      [fileEntry({ id: "" })], [fileEntry({ id: "a/b" })], [fileEntry({ id: "x".repeat(65) })], [fileEntry(), fileEntry()],
      [fileEntry({ label: "" })], [fileEntry({ label: "x".repeat(61) })], [fileEntry({ label: "Key  holders" })], [fileEntry({ label: ` Key holders` })],
      [fileEntry({ label: `Key${cp(0x202e)} holders` })], [fileEntry({ label: `Key\nholders` })], [fileEntry({ label: 7 })],
      [fileEntry({ shown: "" })], [fileEntry({ shown: "x".repeat(256) })],
      [fileEntry({ column: "" })], [fileEntry({ column: "x".repeat(121) })], [fileEntry({ column: 3 })],
      [fileEntry({ ticked: "Name" })], [fileEntry({ ticked: ["Name", "Name"] })], [fileEntry({ ticked: [""] })],
      [fileEntry({ ticked: Array.from({ length: MAX_TICKED + 1 }, (_, i) => `C${i}`) })], [fileEntry({ ticked: [`Na${cp(0x200b)}me`] })],
      [fileEntry({ matches: [] })], [fileEntry({ matches: null })],
      [fileEntry({ matches: { "": { team_id: "1" } } })], [fileEntry({ matches: { [`U${cp(0x202e)}shers`]: { team_id: "1" } } })],
      [fileEntry({ matches: { Ushers: { team_id: "0" } } })], [fileEntry({ matches: { Ushers: { team_id: "team-a" } } })],
      [fileEntry({ matches: { Ushers: { team_id: "1".repeat(21) } } })], [fileEntry({ matches: { Ushers: { team_id: 123 } } })],
      [fileEntry({ matches: { Ushers: { team_id: "1", position_name: "" } } })], [fileEntry({ matches: { Ushers: { team_id: "1", position_name: "Door  greeter" } } })],
      [fileEntry({ matches: { Ushers: { team_id: "1", position_id: "position:1" } } })], [fileEntry({ matches: { Ushers: { team_id: "1", position_name: null } } })],
      [fileEntry({ matches: Object.fromEntries(Array.from({ length: 2001 }, (_, i) => [`v${i}`, { team_id: "1" }])) })],
      [fileEntry({ read_at: "yesterday" })], [fileEntry({ read_at: "2026-11-15" })], [fileEntry({ read_at: "2026-13-45T25:00:00Z" })],
      [notesEntry({ attachments: [{ section: "Keys", team_id: "1", finding_kind: "lead-missing" }] })],
      [notesEntry({ attachments: [{ section: "Keys" }] })], [notesEntry({ attachments: [{ section: "", team_id: "1" }] })],
      [notesEntry({ attachments: [{ section: "Keys", finding_kind: "Lead Missing" }] })], [notesEntry({ attachments: {} })],
      // Which occurrence of a repeated title: a whole number from 2 (the first is said by leaving it out).
      [notesEntry({ attachments: [{ section: "Keys", team_id: "1", occurrence: 1 }] })], [notesEntry({ attachments: [{ section: "Keys", team_id: "1", occurrence: 2.5 }] })],
      [notesEntry({ attachments: [{ section: "Keys", team_id: "1", occurrence: "2" }] })], [notesEntry({ attachments: [{ section: "Keys", team_id: "1", occurrence: 20_001 }] })],
      // Only the closed kinds, as native code keeps them: a kind of finding the Sunday brief doesn't make is refused.
      [notesEntry({ attachments: [{ section: "Keys", finding_kind: "room-overlap" }] })], [notesEntry({ attachments: [{ section: "Keys", finding_kind: "worth-a-look" }] })],
      [notesEntry({ column: "Team" })],
      Array.from({ length: MAX_SOURCES + 1 }, (_, i) => fileEntry({ id: `s${i}` })),
      Array.from({ length: MAX_LINKS + 1 }, (_, i) => linkEntry({ id: `l${i}` })),
    ];
    for (const value of bad) expect(parseSourceList(value), JSON.stringify(value)?.slice(0, 160)).toBeNull();
    // A sparse array (possible from a caller in the page, never from JSON) is refused, holes and all.
    for (const holes of [[fileEntry(), , linkEntry()], [fileEntry({ ticked: ["Name", , "Door"] })], [notesEntry({ attachments: [, { section: "Keys", team_id: "1" }] })]]) {
      expect(parseSourceList(holes)).toBeNull();
    }
    // Objects that aren't plain JSON objects are refused too.
    expect(parseSourceList([Object.assign(Object.create(null) as object, fileEntry())])).toBeNull();
    // The limits themselves are allowed.
    expect(parseSourceList(wire(Array.from({ length: MAX_LINKS }, (_, i) => linkEntry({ id: `l${i}` }))))).toHaveLength(MAX_LINKS);
    expect(parseSourceList(wire([fileEntry({ ticked: Array.from({ length: MAX_TICKED }, (_, i) => `C${i}`) })]))).toHaveLength(1);
  });
});
