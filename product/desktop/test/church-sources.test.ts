// The church's own lists in the app: the controller that reads them through native code and keeps them in memory
// (church-sources.ts), the Lists & notes page, and the box beside a matched Sunday card. A stand-in for the native
// church_* commands; fictional lists only. Native code itself is tested in src-tauri/src/church_sources_tests.rs; this
// file also holds the two sides to the same codes and limits.
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => "sent") }));
import { invoke as tauri } from "@tauri-apps/api/core";
import { MAX_CELL, MAX_HEADER, MAX_ROWS, MAX_SHEET_BYTES, SHEET_PROBLEMS } from "../../../core/src/sources/sheet.js";
import { MAX_LABEL, MAX_LINKS, MAX_NAME, MAX_SHOWN, MAX_SOURCES, MAX_TICKED } from "../../../core/src/sources/types.js";
import {
  CELLS_CUT, GUESSED_LETTERS, LINK_ONLY_PROBLEMS, LINK_PROBLEMS, listFrame, NATIVE_SOURCE_PROBLEMS, readFrom, ROWS_CUT, SAME_NAME, SOURCE_PROBLEMS, UNKNOWN_PROBLEM,
  USE_MATCH,
} from "../../../core/src/sources/words.js";
import type { PositionLabel } from "../../../core/src/sunday-capture.js";
import {
  allowed, CALL_LIMIT_MS, createChurchSources, LINK_CALL_LIMIT_MS, NO_ADDRESS, NO_LABEL, NO_NOTES_LABEL, READ_AGAIN_MS, readSource, SOURCE_COMMANDS,
  TOO_MANY_LISTS, TOO_MANY_TICKED, type Invoke,
} from "../src/church-sources.js";
import * as page from "../src/church-lists-page.js";
import * as linkForm from "../src/church-link-form.js";
import * as notesPage from "../src/church-notes.js";
import { NOTE_KIND_WORDS, NOTES_FRAME, NOTES_WORDS, notesBeside } from "../../../core/src/sources/words.js";
import { NOTE_FINDING_KINDS } from "../../../core/src/sources/types.js";
import { MAX_NOTE_LINE, MAX_NOTE_LINES, MAX_NOTES_BYTES, MAX_TITLE } from "../../../core/src/sources/notes.js";
import { noteLine } from "../../../core/src/sources/text.js";
import { ChurchListsPage, matchText, teamNames } from "../src/church-lists-page.js";
import { ChurchOwnWords, moreRows, openLabel, ROWS_BESIDE } from "../src/church-own-words.js";
import { text } from "./harness-fakes.js";

const encode = (s: string) => new TextEncoder().encode(s).buffer;
const CSV = ["Name,Team,Door,Phone", "Avery Brightwater,Greeter,East door,555-0100", "Blake Ashgrove,Nursery,West door,555-0101",
  "Cameron Larkspur,Greeter,North door,", "Drew Halvorsen,Ushers,,555-0103"].join("\r\n");
const entry = (over: Record<string, unknown> = {}) => ({
  id: "keys", kind: "file", label: "Key holders", shown: "key-holders.csv", column: null, ticked: [], matches: {}, read_at: null, ...over,
});
/** A private link's list as native code lists it: the host with the rest masked, never the address. */
const HOST = "sheets.fictional-church.example";
const linkEntry = (over: Record<string, unknown> = {}) => entry({ id: "0123456789abcdef", kind: "link", label: "Snack rota", shown: `${HOST}/•••`, ...over });
/** The address a leader pastes (fictional): it may reach native code once, and nothing else. */
const ADDRESS = `https://${HOST}/d/e/2PACX-QZXADDRESS0123/pub?gid=0&single=true&output=csv`;
const SECRET = "QZXADDRESS0123";
const POSITIONS: PositionLabel[] = [
  { position_id: "position:1", team_id: "7593350", name: "Greeter", interval: null },
  { position_id: "position:2", team_id: "7593350", name: "Usher", interval: null },
  { position_id: "position:3", team_id: "7593352", name: "Nursery", interval: null },
];
let clock = "2026-11-16T15:06:00.000Z";

interface Fake { invoke: Invoke; calls: [string, Record<string, unknown> | undefined][] }
/** Native code's side: answers each church_* command as `answers` says (a value, a function of the arguments, or an Error to reject with its message). */
function fake(answers: Record<string, unknown> = {}): Fake {
  const calls: Fake["calls"] = [];
  let list: unknown[] = [entry()];
  const all: Record<string, unknown> = {
    church_sources: () => list,
    church_source_read: () => encode(CSV),
    church_source_set: (args: Record<string, unknown>) => {
      const matches = Object.fromEntries((args["matches"] as { value: string }[]).map(({ value, ...m }) => [value, m]));
      const next = { ...entry(), id: args["id"], label: args["label"], column: args["column"], ticked: args["ticked"], matches };
      list = list.map(e => (e as { id: string }).id === args["id"] ? next : e);
      return next;
    },
    church_source_choose_file: () => { const added = entry({ id: "rota", label: "Snack rota", shown: "rota.tsv" }); list = [...list, added]; return added; },
    church_source_remove: (args: Record<string, unknown>) => { list = list.filter(e => (e as { id: string }).id !== args["id"]); return null; },
    church_sources_forget_all: () => { list = []; return null; },
    // A link: native code reads it once when it is added and gives the sheet back with the new list (a byte array).
    church_link_add: (args: Record<string, unknown>) => {
      const added = linkEntry({ label: args["label"], read_at: clock });
      list = [...list, added];
      return { source: added, sheet: [...new TextEncoder().encode(CSV)] };
    },
    church_link_read: () => encode(CSV),
    church_link_remove: (args: Record<string, unknown>) => { list = list.filter(e => (e as { id: string }).id !== args["id"]); return null; },
    church_links_forget_all: () => { list = list.filter(e => (e as { kind: string }).kind !== "link"); return null; },
    ...answers,
  };
  const invoke = (async (command: string, args?: Record<string, unknown>) => {
    calls.push([command, args]);
    if (!Object.hasOwn(all, command)) throw new Error(`unexpected ${command}`);
    const answer = all[command];
    const value = typeof answer === "function" ? (answer as (a: Record<string, unknown>) => unknown)(args ?? {}) : answer;
    if (value instanceof Error) throw value.message;
    return value;
  }) as Invoke;
  return { invoke, calls };
}
const controller = (f: Fake, over: { callLimitMs?: number } = {}) => createChurchSources({ invoke: f.invoke, now: () => clock, ...over });

describe("the lists in memory", () => {
  it("lists them and reads each one, in memory, calling only the church_* commands with an id at most", async () => {
    const f = fake();
    const c = controller(f);
    expect(c.state().sources).toBeNull();
    await c.load();
    const s = c.state();
    expect(s.sources!.map(x => x.label)).toEqual(["Key holders"]);
    const read = s.reads.get("keys");
    expect(read?.ok && read.sheet.headers).toEqual(["Name", "Team", "Door", "Phone"]);
    expect(read?.ok && read.sheet.rows.length).toBe(4);
    expect(s.readAt).toBe(clock);
    expect(f.calls).toEqual([["church_sources", undefined], ["church_source_read", { id: "keys" }]]);
    for (const [command] of f.calls) expect(SOURCE_COMMANDS).toContain(command);
  });

  it("says why a list couldn't be shown, for each of native code's codes and the sheet's own", async () => {
    for (const code of ["file-missing", "not-allowed", "not-the-file", "private-place", "too-large", "workbook", "not-text", "unavailable"]) {
      const c = controller(fake({ church_source_read: new Error(code) }));
      await c.load();
      expect(c.state().reads.get("keys")).toEqual({ ok: false, at: clock, problem: SOURCE_PROBLEMS[code as keyof typeof SOURCE_PROBLEMS] });
    }
    // The page's own reading of the bytes: no header row, a workbook, nothing in it.
    for (const [bytes, code] of [[encode(",,\nAvery,Greeter\n"), "no-header"], [new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1]).buffer, "workbook"], [encode(""), "empty"]] as const) {
      const c = controller(fake({ church_source_read: bytes }));
      await c.load();
      expect(c.state().reads.get("keys")).toMatchObject({ ok: false, problem: SOURCE_PROBLEMS[code] });
    }
    // Anything else native code might send is read as not read, never shown as text.
    const odd = controller(fake({ church_source_read: new Error("<b>QZX</b>") }));
    await odd.load();
    expect(odd.state().reads.get("keys")).toMatchObject({ problem: UNKNOWN_PROBLEM });
    expect(readSource("Name\nAvery", clock)).toEqual({ ok: false, at: clock, problem: UNKNOWN_PROBLEM });
    expect(readSource([78, 97, 109, 101, 10, 65], clock)).toMatchObject({ ok: true });
    expect(readSource(new TextEncoder().encode("Name\nA"), clock)).toMatchObject({ ok: true });
  });

  it("treats a list it can't read, from native code or in an unexpected form, as unreadable, and offers to forget it", async () => {
    const native = controller(fake({ church_sources: new Error("list-unreadable") }));
    await native.load();
    expect(native.state()).toMatchObject({ sources: [], listUnreadable: true, listProblem: SOURCE_PROBLEMS["list-unreadable"] });
    for (const odd of [[entry({ path: "/x/key-holders.csv" })], [entry({ label: "" })], { sources: [] }, [entry(), entry()]]) {
      const c = controller(fake({ church_sources: odd }));
      await c.load();
      expect(c.state(), JSON.stringify(odd)).toMatchObject({ sources: [], listUnreadable: true });
    }
    const f = fake({ church_sources: new Error("list-unreadable") });
    const c = controller(f);
    await c.load();
    expect(await c.forgetAll()).toBeNull();
    expect(c.state()).toMatchObject({ sources: [], listUnreadable: false, listProblem: null });
    expect(f.calls.at(-1)).toEqual(["church_sources_forget_all", undefined]);
  });

  it("reads again only when Sunday or Lists & notes comes forward after an hour, or on Read again", async () => {
    clock = "2026-11-16T15:06:00.000Z";
    const f = fake();
    const c = controller(f);
    await c.readIfOld();
    const reads = () => f.calls.filter(([command]) => command === "church_source_read").length;
    expect(reads()).toBe(1);
    clock = "2026-11-16T16:05:00.000Z";
    await c.readIfOld();
    expect(reads()).toBe(1);
    clock = new Date(Date.parse("2026-11-16T15:06:00.000Z") + READ_AGAIN_MS).toISOString();
    await c.readIfOld();
    expect(reads()).toBe(2);
    await c.readOne("keys");
    expect(reads()).toBe(3);
    expect(c.state().reads.get("keys")?.at).toBe(clock);
  });

  it("gives up on a call that never answers, so nothing waits forever", async () => {
    vi.useFakeTimers();
    try {
      const c = controller(fake({ church_source_read: () => new Promise(() => undefined) }));
      const loading = c.load();
      await vi.advanceTimersByTimeAsync(CALL_LIMIT_MS + 1);
      await loading;
      expect(c.state().reads.get("keys")).toMatchObject({ ok: false, problem: SOURCE_PROBLEMS.unavailable });
      expect(c.state().reading).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it("adds a chosen file and reads it; a cancel or a refusal adds nothing", async () => {
    const f = fake();
    const c = controller(f);
    await c.load();
    expect(await c.choose()).toEqual({ added: "rota" });
    expect(c.state().sources!.map(s => s.id)).toEqual(["keys", "rota"]);
    expect(c.state().reads.get("rota")?.ok).toBe(true);
    expect(f.calls.find(([command]) => command === "church_source_choose_file")).toEqual(["church_source_choose_file", undefined]);
    const cancel = controller(fake({ church_source_choose_file: null }));
    await cancel.load();
    expect(await cancel.choose()).toEqual({ cancelled: true });
    expect(cancel.state().sources).toHaveLength(1);
    const book = controller(fake({ church_source_choose_file: new Error("workbook") }));
    await book.load();
    expect(await book.choose()).toEqual({ problem: SOURCE_PROBLEMS.workbook });
    // At the limit, the panel isn't even shown.
    const many = fake({ church_sources: Array.from({ length: MAX_SOURCES }, (_, i) => entry({ id: `l${i}` })) });
    const full = controller(many);
    await full.load();
    expect(await full.choose()).toEqual({ problem: TOO_MANY_LISTS });
    expect(many.calls.some(([command]) => command === "church_source_choose_file")).toBe(false);
  });

  it("saves the leader's changes through native code whole, and shows what native code kept", async () => {
    const f = fake();
    const c = controller(f);
    await c.load();
    expect(await c.update("keys", { column: "Team", ticked: ["Name", "Door"] })).toBeNull();
    expect(f.calls.at(-1)).toEqual(["church_source_set", { id: "keys", label: "Key holders", column: "Team", ticked: ["Name", "Door"], matches: [] }]);
    expect(await c.update("keys", { matches: new Map([["Greeter", { team_id: "7593350", position_name: "Greeter" }], ["Ushers", { team_id: "7593350" }]]) })).toBeNull();
    expect(f.calls.at(-1)![1]).toEqual({ id: "keys", label: "Key holders", column: "Team", ticked: ["Name", "Door"],
      matches: [{ value: "Greeter", team_id: "7593350", position_name: "Greeter" }, { value: "Ushers", team_id: "7593350" }] });
    expect([...c.state().sources![0]!.matches]).toEqual([["Greeter", { team_id: "7593350", position_name: "Greeter" }], ["Ushers", { team_id: "7593350" }]]);
    // A label is one plain line; none at all isn't sent.
    const zw = String.fromCodePoint(0x200b);
    const before = f.calls.length;
    expect(await c.update("keys", { label: ` ${zw} ` })).toBe(NO_LABEL);
    expect(f.calls.length).toBe(before);
    expect(await c.update("keys", { label: `  Key${zw}\nholders  ` })).toBeNull();
    expect(f.calls.at(-1)![1]).toMatchObject({ label: "Key holders" });
    // Native code's refusal in plain words; a reply that isn't a list is not taken.
    const refused = controller(fake({ church_source_set: new Error("unavailable") }));
    await refused.load();
    expect(await refused.update("keys", { column: "Team" })).toBe(SOURCE_PROBLEMS.unavailable);
    const odd = controller(fake({ church_source_set: { id: "keys", label: "", path: "/x" } }));
    await odd.load();
    expect(await odd.update("keys", { column: "Team" })).toBe(UNKNOWN_PROBLEM);
    expect(odd.state().sources![0]!.column).toBeNull();
    expect(await c.update("nope", { column: "Team" })).toBe(SOURCE_PROBLEMS.unavailable);
  });

  it("saves two quick changes one after the other, so both land (review S, L5)", async () => {
    // Native code that answers slowly: each set waits until the test lets it go.
    const waiting: (() => void)[] = [];
    const f = fake();
    const slow = fake({
      church_source_set: (args: Record<string, unknown>) => new Promise(resolve => {
        waiting.push(() => { void f.invoke("church_source_set", args).then(resolve); });
      }),
    });
    const c = controller(slow);
    await c.load();
    // Two ticks and two matches made from the same screen, before native code has answered the first.
    const first = c.update("keys", { ticked: now => [...now, "Name"] });
    const second = c.update("keys", { ticked: now => [...now, "Door"] });
    const third = c.update("keys", { matches: now => new Map([...now, ["Greeter", { team_id: "7593350" }]]) });
    const fourth = c.update("keys", { matches: now => new Map([...now, ["Nursery", { team_id: "7593352" }]]) });
    await vi.waitFor(() => expect(waiting).toHaveLength(1));
    // Only one is with native code at a time.
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(waiting).toHaveLength(1);
    for (let n = 1; n <= 4; n++) {
      await vi.waitFor(() => expect(waiting).toHaveLength(n));
      waiting[n - 1]!();
    }
    expect(await Promise.all([first, second, third, fourth])).toEqual([null, null, null, null]);
    const sets = slow.calls.filter(([command]) => command === "church_source_set").map(([, args]) => args);
    expect(sets.map(a => a!["ticked"])).toEqual([["Name"], ["Name", "Door"], ["Name", "Door"], ["Name", "Door"]]);
    expect(sets.at(-1)!["matches"]).toEqual([{ value: "Greeter", team_id: "7593350" }, { value: "Nursery", team_id: "7593352" }]);
    const kept = c.state().sources![0]!;
    expect(kept.ticked).toEqual(["Name", "Door"]);
    expect([...kept.matches.keys()]).toEqual(["Greeter", "Nursery"]);
    // A refused change doesn't stop the next one.
    const refusing = controller(fake({ church_source_set: new Error("unavailable") }));
    await refusing.load();
    expect(await refusing.update("keys", { label: "Keys" })).toBe(SOURCE_PROBLEMS.unavailable);
    expect(await refusing.update("keys", { label: "" })).toBe(NO_LABEL);
  });

  it("never brings back a removed list when a save sent before the removal answers after it (review S2, B)", async () => {
    const answers: ((v: unknown) => void)[] = [];
    const f = fake();
    const slow = fake({ church_source_set: (args: Record<string, unknown>) => new Promise(resolve => { answers.push(() => { void f.invoke("church_source_set", args).then(resolve); }); }) });
    const c = controller(slow);
    await c.load();
    const saving = c.update("keys", { column: "Team" });
    await vi.waitFor(() => expect(answers).toHaveLength(1));
    expect(await c.remove("keys")).toBeNull();
    answers[0]!(undefined);
    expect(await saving).toBeNull();
    expect(c.state().sources).toEqual([]);
    expect(c.state().reads.size).toBe(0);
  });

  it("says plainly when one column too many is ticked, even two quick ticks apart (review S2, C)", async () => {
    const eight = ["A", "B", "C", "D", "E", "F", "G", "H"];
    const c = controller(fake({ church_sources: [entry({ ticked: eight.slice(0, 7) })] }));
    await c.load();
    const first = c.update("keys", { ticked: now => [...now, "H"] });
    const second = c.update("keys", { ticked: now => [...now, "I"] });
    expect(await first).toBeNull();
    expect(await second).toBe(TOO_MANY_TICKED);
    expect(TOO_MANY_TICKED).toBe(`Ozzie shows up to ${MAX_TICKED} columns beside a Sunday card. Untick one to show another.`);
    expect(c.state().sources![0]!.ticked).toEqual(eight);
  });

  it("forgets what it read when a list is removed, even a read still under way", async () => {
    const answers: ((v: unknown) => void)[] = [];
    const f = fake({ church_source_read: () => new Promise(resolve => { answers.push(resolve); }) });
    const c = controller(f);
    const loading = c.load();
    await vi.waitFor(() => expect(answers).toHaveLength(1));
    expect(await c.remove("keys")).toBeNull();
    answers[0]!(encode(CSV));
    await loading;
    expect(c.state().sources).toEqual([]);
    expect(c.state().reads.size).toBe(0);
    expect(f.calls.some(([command, args]) => command === "church_source_remove" && args?.["id"] === "keys")).toBe(true);
  });

  it("keeps the newer of two reads of one list", async () => {
    const answers: ((v: unknown) => void)[] = [];
    const c = controller(fake({ church_source_read: () => new Promise(resolve => { answers.push(resolve); }) }));
    const first = c.load();
    await vi.waitFor(() => expect(answers).toHaveLength(1));
    const second = c.readOne("keys");
    await vi.waitFor(() => expect(answers).toHaveLength(2));
    answers[1]!(encode("Name\nNewer"));
    answers[0]!(encode("Name\nOlder"));
    await Promise.all([first, second]);
    const read = c.state().reads.get("keys");
    expect(read?.ok && read.sheet.rows).toEqual([["Newer"]]);
  });
});

describe("beside a Sunday card", () => {
  const greeter = { team_id: "7593350", position_id: "position:9", name: "Greeter" };
  const loaded = async (over: Record<string, unknown>, csv = CSV) => {
    const c = controller(fake({ church_sources: [entry(over)], church_source_read: encode(csv) }));
    await c.load();
    return c.state();
  };
  const render = (state: Parameters<typeof ChurchOwnWords>[0]["state"], card = greeter, onOpen?: () => void) =>
    renderToStaticMarkup(React.createElement(ChurchOwnWords, { state, card, ...(onOpen ? { onOpen } : {}) }));

  it("shows the matched rows, only the ticked columns, framed as the church's own and not checked", async () => {
    const state = await loaded({ column: "Team", ticked: ["Name", "Door"], matches: { Greeter: { team_id: "7593350", position_name: "Greeter" } } });
    const html = render(state);
    expect(html.startsWith("<section class=\"church-own-words\">")).toBe(true);
    expect(text(html)).toContain(listFrame("Key holders"));
    expect(html).toContain("<th scope=\"col\">Name</th><th scope=\"col\">Door</th>");
    expect(text(html)).toContain("Avery Brightwater East door");
    expect(text(html)).toContain("Cameron Larkspur North door");
    // Not the columns left unticked, nor anyone matched to something else.
    expect(html).not.toContain("555-01");
    expect(html).not.toContain("Blake");
    // No action on a row.
    expect(html).not.toMatch(/<button|<a[\s>]|<img|<input/u);
    // The same position on another team, or another position, shows nothing.
    expect(render(state, { ...greeter, team_id: "7593352" })).toBe("");
    expect(render(state, { ...greeter, name: "Usher" })).toBe("");
    // A team match covers the team's card and every position on it.
    const team = await loaded({ column: "Team", ticked: ["Name"], matches: { Greeter: { team_id: "7593350" } } });
    expect(text(render(team, { team_id: "7593350", name: "Usher", position_id: "position:2" }))).toContain("Avery Brightwater");
  });

  it("shows nothing until a column is chosen, a column ticked and a value matched", async () => {
    expect(render(await loaded({}))).toBe("");
    expect(render(await loaded({ column: "Team", matches: { Greeter: { team_id: "7593350" } } }))).toBe("");
    expect(render(await loaded({ column: "Team", ticked: ["Name"] }))).toBe("");
    // A list that couldn't be read shows nothing beside a card.
    const c = controller(fake({ church_sources: [entry({ column: "Team", ticked: ["Name"], matches: { Greeter: { team_id: "7593350" } } })], church_source_read: new Error("file-missing") }));
    await c.load();
    expect(render(c.state())).toBe("");
  });

  it("shows a few rows and says how many more are in Lists & notes", async () => {
    const rows = Array.from({ length: ROWS_BESIDE + 3 }, (_, i) => `Person ${i},Greeter`);
    const state = await loaded({ column: "Team", ticked: ["Name"], matches: { Greeter: { team_id: "7593350" } } }, ["Name,Team", ...rows].join("\n"));
    const html = render(state, greeter, () => undefined);
    expect(html.match(/<tr>/gu)).toHaveLength(ROWS_BESIDE + 1);
    expect(text(html)).toContain(moreRows(3));
    expect(moreRows(3)).toBe("and 3 more in Lists & notes");
    expect(html).toContain("<button type=\"button\" class=\"btn btn-quiet btn-sm\">and 3 more in Lists &amp; notes</button>");
    expect(render(state)).not.toContain("<button");
  });

  it("renders a cell that looks like markup or a formula as the text it is", async () => {
    const state = await loaded({ column: "Team", ticked: ["Name", "Door"], matches: { Greeter: { team_id: "7593350" } } },
      "Name,Team,Door\n<img src=x onerror=alert(1)>,Greeter,=HYPERLINK(\"https://example.org\")\n");
    const html = render(state);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("=HYPERLINK(&quot;https://example.org&quot;)");
    expect(html).not.toMatch(/<img|<a[\s>]/u);
  });
});

describe("the Lists & notes page", () => {
  const renderPage = async (over: Record<string, unknown>, answers: Record<string, unknown> = {}, positions = POSITIONS) => {
    const c = controller(fake({ church_sources: [entry(over)], ...answers }));
    await c.load();
    return renderToStaticMarkup(React.createElement(ChurchListsPage, { sources: c, positions }));
  };

  it("frames the list as the church's own, says when and where it was read, and shows it in file order with a find box", async () => {
    clock = "2026-11-16T15:06:00.000Z";
    const html = await renderPage({});
    const words = text(html);
    for (const line of [page.LISTS_TITLE, page.LISTS_BODY, page.LISTS_STAYS, page.LIST_FRAME, page.ADD_LIST, page.ADD_HELP, page.COLUMN_QUESTION, page.FIND_LABEL,
      page.SHOW_QUESTION, page.SHOW_NONE, page.READ_AGAIN, page.REMOVE_LIST, page.FORGET_ALL]) expect(words, line).toContain(line);
    expect(words).toMatch(/Read from key-holders\.csv at \d{1,2}:\d{2} (?:AM|PM)/u);
    // The table, in the file's order, with every column.
    expect(words).toContain("Name Team Door Phone Avery Brightwater Greeter East door 555-0100 Blake Ashgrove Nursery West door 555-0101 Cameron Larkspur");
    expect(html).toContain("type=\"search\"");
    // Nothing to act on in a row: no link, picture, copy or mail.
    expect(html).not.toMatch(/<a[\s>]|<img|mailto:|Copy|Open in Mail|Prepare a note/u);
  });

  it("offers a same-named position as a suggestion to use, and every team by its positions' names", async () => {
    const html = await renderPage({ column: "Team" });
    const words = text(html);
    expect(words).toContain(page.MATCH_HELP);
    // "Greeter" and "Nursery" are positions in the check; "Ushers" isn't a name Ozzie read.
    expect(words).toContain(`${SAME_NAME.position}: Greeter on the Greeter, Usher team ${USE_MATCH}`);
    expect(words).toContain(`${SAME_NAME.position}: Nursery on the Nursery team ${USE_MATCH}`);
    expect(html.match(new RegExp(`>${USE_MATCH}</button>`, "gu"))).toHaveLength(2);
    // A suggestion counts for nothing until it is used: nothing is matched yet.
    expect(html).not.toContain("match-now");
    expect(words).not.toContain("Everyone on the");
    expect(html).toContain("<optgroup label=\"Greeter, Usher team\"><option value=\"[&quot;7593350&quot;,null]\">The whole team</option>");
    expect(html).toContain("<option value=\"[&quot;7593350&quot;,&quot;Usher&quot;]\">Usher</option>");
    // Without a check on screen, it says to check a Sunday first and offers no choices.
    const none = await renderPage({ column: "Team" }, {}, []);
    expect(text(none)).toContain(page.NEEDS_CHECK);
    expect(none).not.toContain("<optgroup");
  });

  it("shows a match the leader made instead of a suggestion, in words", async () => {
    const html = await renderPage({ column: "Team", matches: { Greeter: { team_id: "7593350", position_name: "Greeter" }, Ushers: { team_id: "7593350" } } });
    const words = text(html);
    expect(words).toContain("Greeter on the Greeter, Usher team");
    expect(words).toContain("Everyone on the Greeter, Usher team");
    // Only "Nursery" is left to suggest.
    expect(html.match(new RegExp(`>${USE_MATCH}</button>`, "gu"))).toHaveLength(1);
    const teams = teamNames(POSITIONS);
    expect(matchText({ team_id: "9", position_name: "Greeter" }, teams)).toBe("Greeter on a team not in this check");
    expect(matchText({ team_id: "9" }, teams)).toBe("A team not in this check");
  });

  it("keeps a match to a team not in this check until the leader chooses Not matched, with or without a check on screen", async () => {
    for (const positions of [POSITIONS, []]) {
      const html = await renderPage({ column: "Team", matches: { Ushers: { team_id: "9" } } }, {}, positions);
      expect(text(html)).toContain("Ushers A team not in this check");
      expect(html).toContain(`<option value="keep" selected="">${page.KEEP_MATCH}</option><option value="">${page.NOT_MATCHED}</option>`);
    }
    // Without a check, a value with no match has nothing to choose from.
    expect(await renderPage({ column: "Team" }, {}, [])).not.toContain("<select class=\"input match-select\"");
  });

  it("offers to try again when the lists couldn't be listed just now, and to forget them when they can't be read", async () => {
    const busy = controller(fake({ church_sources: new Error("unavailable") }));
    await busy.load();
    const html = renderToStaticMarkup(React.createElement(ChurchListsPage, { sources: busy, positions: POSITIONS }));
    expect(text(html)).toContain(`${SOURCE_PROBLEMS.unavailable} ${page.READ_AGAIN}`);
    expect(text(html)).not.toContain(page.FORGET_ALL);
    const damaged = controller(fake({ church_sources: new Error("list-unreadable") }));
    await damaged.load();
    const unreadable = text(renderToStaticMarkup(React.createElement(ChurchListsPage, { sources: damaged, positions: POSITIONS })));
    expect(unreadable).toContain(SOURCE_PROBLEMS["list-unreadable"]);
    expect(unreadable).toContain(page.FORGET_ALL);
    expect(unreadable).not.toContain(page.READ_AGAIN);
  });

  it("says plainly why a list couldn't be shown, and what was left out", async () => {
    expect(text(await renderPage({}, { church_source_read: new Error("file-missing") }))).toContain(SOURCE_PROBLEMS["file-missing"]);
    // A read that didn't work says why, and which file it is, but not that it was read or when, and no check mark
    // (review S, L3; review S2, A).
    for (const code of ["file-missing", "not-allowed", "not-the-file", "private-place", "workbook"]) {
      const failed = await renderPage({}, { church_source_read: new Error(code) });
      expect(text(failed)).toContain(SOURCE_PROBLEMS[code as keyof typeof SOURCE_PROBLEMS]);
      const line = /<div class="checkline">([\s\S]*?)<\/div>/u.exec(failed)?.[1] ?? "";
      expect(text(line).trim()).toBe(`key-holders.csv ${page.READ_AGAIN}`);
      expect(text(failed)).not.toMatch(/Read from|\d:\d\d/u);
      expect(line).not.toContain("<svg");
    }
    expect(/<div class="checkline">([\s\S]*?)<\/div>/u.exec(await renderPage({}))?.[1]).toContain("<svg");
    const long = ["Name", ...Array.from({ length: MAX_ROWS + 1 }, (_, i) => `${"x".repeat(i === 0 ? 600 : 3)}`)].join("\n");
    const cut = text(await renderPage({}, { church_source_read: encode(long) }));
    expect(cut).toContain(ROWS_CUT);
    expect(cut).toContain(CELLS_CUT);
    expect(cut).toContain(page.someShown(page.SHOWN_ROWS, MAX_ROWS));
    // Long cells: the table stops at its share of characters, never at no rows.
    // Each row: a 4-letter name and two cells cut to 500 characters, so 149 rows fit in 150,000 characters.
    const wide = ["Name,Notes,More", ...Array.from({ length: 400 }, (_, i) => `P${String(i).padStart(3, "0")},${"y".repeat(600)},${"z".repeat(600)}`)].join("\n");
    expect(page.SHOWN_CHARACTERS).toBe(150_000);
    expect(text(await renderPage({}, { church_source_read: encode(wide) }))).toContain(page.someShown(149, 400));
    expect(page.shownRows([["x".repeat(page.SHOWN_CHARACTERS * 2)]])).toHaveLength(1);
    expect(page.shownRows(Array.from({ length: 300 }, () => ["a"]))).toHaveLength(page.SHOWN_ROWS);
    const guessed = text(await renderPage({}, { church_source_read: new Uint8Array([0x4e, 0x61, 0x6d, 0x65, 0x0a, 0x4a, 0x6f, 0x73, 0xe9]).buffer }));
    expect(guessed).toContain(GUESSED_LETTERS);
    expect(guessed).toContain("José");
  });
});

describe("a list from a private link", () => {
  /** Everything the page holds or shows, as text: the address may be in none of it. */
  const held = (c: ReturnType<typeof controller>) => JSON.stringify(c.state(), (_, v: unknown) => v instanceof Map ? [...v] : v);
  const renderOf = (c: ReturnType<typeof controller>) => renderToStaticMarkup(React.createElement(ChurchListsPage, { sources: c, positions: POSITIONS }));

  it("adds a link: the address goes to native code once and is kept nowhere on the page, and the sheet the add read is shown without a second read", async () => {
    const f = fake();
    const c = controller(f);
    await c.load();
    expect(await c.addLink(" Snack\u200b rota ", ADDRESS)).toEqual({ added: "0123456789abcdef" });
    // The label made plain; the address exactly as pasted, once, in the one command that takes it.
    const withAddress = f.calls.filter(([, args]) => JSON.stringify(args ?? {}).includes(SECRET));
    expect(withAddress).toEqual([["church_link_add", { label: "Snack rota", address: ADDRESS }]]);
    expect(f.calls.some(([command]) => command === "church_link_read")).toBe(false);
    const s = c.state();
    expect(s.sources!.map(x => [x.kind, x.label, x.shown])).toEqual([["file", "Key holders", "key-holders.csv"], ["link", "Snack rota", `${HOST}/•••`]]);
    const read = s.reads.get("0123456789abcdef");
    expect(read?.ok && read.sheet.headers).toEqual(["Name", "Team", "Door", "Phone"]);
    expect(held(c)).not.toContain(SECRET);
    expect(renderOf(c)).not.toContain(SECRET);
    // The same column choice, ticks and matches as a file's, saved the same way.
    expect(await c.update("0123456789abcdef", { column: "Team", ticked: ["Name"], matches: new Map([["Greeter", { team_id: "7593350" }]]) })).toBeNull();
    expect(f.calls.at(-1)).toEqual(["church_source_set", { id: "0123456789abcdef", label: "Snack rota", column: "Team", ticked: ["Name"], matches: [{ value: "Greeter", team_id: "7593350" }] }]);
  });

  it("refuses before asking native code: no name, no link, 8 links already, or 20 lists", async () => {
    const f = fake();
    const c = controller(f);
    await c.load();
    const before = f.calls.length;
    expect(await c.addLink(" \u200b ", ADDRESS)).toEqual({ problem: NO_LABEL });
    expect(await c.addLink("Snack rota", "  ")).toEqual({ problem: NO_ADDRESS });
    expect(f.calls.length).toBe(before);
    const links = controller(fake({ church_sources: Array.from({ length: MAX_LINKS }, (_, i) => linkEntry({ id: `${i}`.padStart(16, "0") })) }));
    await links.load();
    expect(await links.addLink("Snack rota", ADDRESS)).toEqual({ problem: SOURCE_PROBLEMS["too-many-links"] });
    const lists = fake({ church_sources: Array.from({ length: MAX_SOURCES }, (_, i) => entry({ id: `l${i}` })) });
    const full = controller(lists);
    await full.load();
    expect(await full.addLink("Snack rota", ADDRESS)).toEqual({ problem: TOO_MANY_LISTS });
    expect(lists.calls.some(([command]) => command === "church_link_add")).toBe(false);
  });

  it("says why a link couldn't be added or read, for every code native code can give, in the link's own words", async () => {
    const codes = [...LINK_ONLY_PROBLEMS, "too-large", "workbook", "not-text", "unavailable"] as const;
    for (const code of codes) {
      const words = code in LINK_PROBLEMS ? LINK_PROBLEMS[code as keyof typeof LINK_PROBLEMS] : SOURCE_PROBLEMS[code as keyof typeof SOURCE_PROBLEMS];
      expect(words, code).toBeTruthy();
      const adding = controller(fake({ church_link_add: new Error(code) }));
      await adding.load();
      expect(await adding.addLink("Snack rota", ADDRESS), code).toEqual({ problem: words });
      expect(adding.state().sources).toHaveLength(1);
      const reading = controller(fake({ church_sources: [linkEntry()], church_link_read: new Error(code) }));
      await reading.load();
      expect(reading.state().reads.get("0123456789abcdef"), code).toEqual({ ok: false, at: clock, problem: words });
    }
    // What the page reads in the sheet itself, said of a sheet.
    const header = controller(fake({ church_sources: [linkEntry()], church_link_read: encode(",,\nAvery,Greeter\n") }));
    await header.load();
    expect(header.state().reads.get("0123456789abcdef")).toMatchObject({ ok: false, problem: "That sheet has no header row." });
    // A reply to an add that isn't one is not taken, and the address isn't in what the page says.
    for (const odd of [null, { source: linkEntry() }, { source: { ...linkEntry(), address: ADDRESS }, sheet: [] }, { source: entry(), sheet: [] }, linkEntry()]) {
      const c = controller(fake({ church_link_add: odd }));
      await c.load();
      const result = await c.addLink("Snack rota", ADDRESS);
      expect(result, JSON.stringify(odd)).toEqual({ problem: UNKNOWN_PROBLEM });
      expect(c.state().sources).toHaveLength(1);
      expect(held(c)).not.toContain(SECRET);
    }
  });

  it("reads and removes a link with its own commands, and a file with the file's", async () => {
    const f = fake({ church_sources: [entry(), linkEntry()] });
    const c = controller(f);
    await c.load();
    expect(f.calls.slice(1).map(([command, args]) => [command, args])).toEqual([["church_source_read", { id: "keys" }], ["church_link_read", { id: "0123456789abcdef" }]]);
    await c.readOne("0123456789abcdef");
    expect(f.calls.at(-1)).toEqual(["church_link_read", { id: "0123456789abcdef" }]);
    expect(await c.remove("0123456789abcdef")).toBeNull();
    expect(f.calls.at(-1)).toEqual(["church_link_remove", { id: "0123456789abcdef" }]);
    expect(await c.remove("keys")).toBeNull();
    expect(f.calls.at(-1)).toEqual(["church_source_remove", { id: "keys" }]);
    expect(c.state().sources).toEqual([]);
    expect(c.state().reads.size).toBe(0);
  });

  it("reads a link again only when Sunday or Lists & notes comes forward after an hour, or on Read again", async () => {
    clock = "2026-11-16T15:06:00.000Z";
    const f = fake({ church_sources: [linkEntry()] });
    const c = controller(f);
    const reads = () => f.calls.filter(([command]) => command === "church_link_read").length;
    await c.readIfOld();
    expect(reads()).toBe(1);
    clock = "2026-11-16T16:05:59.000Z";
    await c.readIfOld();
    await c.readIfOld();
    expect(reads()).toBe(1);
    clock = "2026-11-16T16:06:00.000Z";
    await c.readIfOld();
    expect(reads()).toBe(2);
    await c.readOne("0123456789abcdef");
    expect(reads()).toBe(3);
    // Nothing else reads it: no timer, no other command.
    expect(new Set(f.calls.map(([command]) => command))).toEqual(new Set(["church_sources", "church_link_read"]));
  });

  it("waits longer for a link than for a file, and still gives up", async () => {
    expect(LINK_CALL_LIMIT_MS).toBeGreaterThan(20_000 + 5_000);
    expect(LINK_CALL_LIMIT_MS).toBeGreaterThan(CALL_LIMIT_MS);
    vi.useFakeTimers();
    try {
      const c = controller(fake({ church_sources: [linkEntry()], church_link_read: () => new Promise(() => undefined) }));
      const loading = c.load();
      await vi.advanceTimersByTimeAsync(CALL_LIMIT_MS + 1);
      expect(c.state().reading).toBe(true);
      await vi.advanceTimersByTimeAsync(LINK_CALL_LIMIT_MS);
      await loading;
      expect(c.state().reads.get("0123456789abcdef")).toMatchObject({ ok: false, problem: SOURCE_PROBLEMS.unavailable });
    } finally { vi.useRealTimers(); }
  });

  it("says where and when a link was read only for a read that worked, never the address", async () => {
    clock = "2026-11-16T15:06:00.000Z";
    const ok = controller(fake({ church_sources: [linkEntry()] }));
    await ok.load();
    const html = renderOf(ok);
    const words = text(html);
    expect(words).toMatch(new RegExp(`Read from ${HOST.replaceAll(".", "\\.")} at \\d{1,2}:\\d{2} (?:AM|PM) ${page.READ_AGAIN}`, "u"));
    expect(/<div class="checkline">([\s\S]*?)<\/div>/u.exec(html)?.[1]).toContain("<svg");
    expect(words).not.toContain("/•••");
    for (const code of ["web-page", "timeout", "link-missing"]) {
      const failed = controller(fake({ church_sources: [linkEntry()], church_link_read: new Error(code) }));
      await failed.load();
      const shown = text(renderOf(failed));
      expect(shown).toContain(SOURCE_PROBLEMS[code as keyof typeof SOURCE_PROBLEMS]);
      expect(shown).not.toMatch(/Read from|Read again/u);
      // Which link it is, masked, with nothing said of a read, then the way to try again.
      expect(shown).toContain(`${page.LINK_TO} ${HOST}/•••. ${page.TRY_AGAIN}`);
    }
    // Not read yet: where it points, masked, and that it hasn't been read.
    const waiting = controller(fake({ church_sources: [linkEntry()], church_link_read: () => new Promise(() => undefined) }));
    void waiting.load();
    await vi.waitFor(() => expect(waiting.state().sources).toHaveLength(1));
    expect(text(renderOf(waiting))).toContain(`${page.LINK_TO} ${HOST}/•••. ${page.NOT_READ}`);
    // Its removal says what goes, and that the sheet stays.
    expect(page.removeLinkConfirm("Snack rota")).toBe("Remove “Snack rota” from Ozzie? Ozzie forgets this list, its matches and its link, and deletes the link from this Mac's Keychain. The sheet itself doesn't change.");
  });

  it("offers a way to add a link, with the address hidden as it is typed and never in the page", async () => {
    const c = controller(fake());
    await c.load();
    const html = renderToStaticMarkup(React.createElement(linkForm.LinkForm, { sources: c, onDone: () => undefined }));
    const words = text(html);
    for (const line of [linkForm.LINK_TITLE, linkForm.LINK_HELP, linkForm.LINK_NAME, linkForm.LINK_ADDRESS, linkForm.LINK_ADDRESS_HELP, linkForm.ADD_THIS_LIST]) {
      expect(words, line).toContain(line);
    }
    expect(html).toMatch(/<input[^>]*type="password"[^>]*autocomplete="off"/iu);
    expect(html).not.toMatch(/<a[\s>]|<img/u);
    // The page offers it beside "Add a list from this Mac".
    expect(text(renderOf(c))).toContain(`${page.ADD_LIST} ${page.ADD_LINK}`);
  });

  it("offers Forget all private links when their list can't be read, which forgets only the links", async () => {
    const f = fake({ church_sources: [entry(), linkEntry()], church_link_read: new Error("links-unreadable") });
    const c = controller(f);
    await c.load();
    expect(c.state().linksUnreadable).toBe(true);
    const words = text(renderOf(c));
    // The reason stands beside the way out, at the top of the page, and on the link's own card.
    expect(words).toContain(`${SOURCE_PROBLEMS["links-unreadable"]} ${page.FORGET_LINKS}`);
    expect(words.split(SOURCE_PROBLEMS["links-unreadable"]).length).toBe(3);
    expect(await c.forgetLinks()).toBeNull();
    expect(f.calls.at(-1)).toEqual(["church_links_forget_all", undefined]);
    expect(c.state().sources!.map(s => s.id)).toEqual(["keys"]);
    expect(c.state().linksUnreadable).toBe(false);
    expect([...c.state().reads.keys()]).toEqual(["keys"]);
    expect(text(renderOf(c))).not.toContain(page.FORGET_LINKS);
    expect(page.FORGET_LINKS_CONFIRM).toBe("Forget all private links? Ozzie deletes every sheet link it saved in this Mac's Keychain, and the lists that read from them. The sheets themselves don't change, and you can add links again afterwards.");
  });

  it("lists again after an add the page stopped waiting for, or one already added, so a retry can't add it twice (review T, B)", async () => {
    vi.useFakeTimers();
    try {
      // Native code saves the link but answers after the page has stopped waiting.
      let list: unknown[] = [entry()];
      const late = fake({
        church_sources: () => list,
        church_link_add: () => { list = [...list, linkEntry({ read_at: clock })]; return new Promise(() => undefined); },
      });
      const c = controller(late);
      await c.load();
      const adding = c.addLink("Snack rota", ADDRESS);
      await vi.advanceTimersByTimeAsync(LINK_CALL_LIMIT_MS + 1);
      expect(await adding).toEqual({ problem: SOURCE_PROBLEMS.unavailable });
      expect(late.calls.filter(([command]) => command === "church_sources")).toHaveLength(2);
      expect(c.state().sources!.map(x => x.id)).toEqual([entry().id, linkEntry().id]);
      // Listing again reads nothing new: the late list waits for its own read.
      expect(late.calls.some(([command]) => command === "church_link_read")).toBe(false);
    } finally { vi.useRealTimers(); }
    const twice = fake({ church_link_add: new Error("link-already-added") });
    const c = controller(twice);
    await c.load();
    expect(await c.addLink("Snack rota", ADDRESS)).toEqual({ problem: SOURCE_PROBLEMS["link-already-added"] });
    expect(twice.calls.filter(([command]) => command === "church_sources")).toHaveLength(2);
  });

  it("forgets the lists when the Keychain keeps the links' addresses for now, and says so (review T, L7)", async () => {
    const f = fake({ church_sources: [entry(), linkEntry()], church_sources_forget_all: new Error("links-left-in-keychain") });
    const c = controller(f);
    await c.load();
    expect(await c.forgetAll()).toBe(SOURCE_PROBLEMS["links-left-in-keychain"]);
    expect(c.state()).toMatchObject({ sources: [], listUnreadable: false, linksUnreadable: false });
    expect(c.state().reads.size).toBe(0);
    // Review U, finding 3 (the reviewer's l7-relist case): the next opening of Sunday or Lists & notes lists natively,
    // at once and whatever the time, which is what removes the addresses; only once.
    f.calls.length = 0;
    const listed = () => f.calls.filter(([command]) => command === "church_sources").length;
    await c.readIfOld();
    expect(f.calls[0]?.[0]).toBe("church_sources");
    await c.readIfOld();
    expect(listed()).toBe(1);
    expect(SOURCE_PROBLEMS["links-left-in-keychain"]).toBe("Ozzie forgot your lists and notes, but this Mac's Keychain didn't answer, so the private links' addresses are still in it. Ozzie removes them the next time you open Lists & notes and the Keychain answers.");
  });

  it("never reads a link on its own: a day with no page opened and no button pressed reads nothing (review T, L3)", async () => {
    vi.useFakeTimers();
    try {
      const f = fake({ church_sources: [entry(), linkEntry()] });
      const c = controller(f);
      await c.load();
      const before = f.calls.length;
      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
      expect(f.calls.slice(before)).toEqual([]);
      expect(f.calls.filter(([command]) => command === "church_link_read")).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  it("shows a link's matched rows beside a Sunday card exactly as a file's", async () => {
    const over = { column: "Team", ticked: ["Name", "Door"], matches: { Greeter: { team_id: "7593350", position_name: "Greeter" } } };
    const asFile = controller(fake({ church_sources: [entry(over)] }));
    const asLink = controller(fake({ church_sources: [linkEntry({ ...over, label: "Key holders" })] }));
    await asFile.load();
    await asLink.load();
    const card = { team_id: "7593350", position_id: "position:9", name: "Greeter" };
    const box = (c: ReturnType<typeof controller>) => renderToStaticMarkup(React.createElement(ChurchOwnWords, { state: c.state(), card }));
    expect(box(asLink)).toBe(box(asFile));
    expect(text(box(asLink))).toContain("Avery Brightwater East door");
  });
});

describe("the church's own notes", () => {
  const NOTES = ["# Child safety policy", "Two adults in every room. See https://example.org/policy", "", "# Snow days", "We text by 6 AM.", "Café opens at 8."].join("\n");
  const notesEntry = (over: Record<string, unknown> = {}) => ({
    id: "notes1", kind: "notes", label: "Policies", shown: "policies.md", attachments: [], read_at: null, ...over,
  });
  const withNotes = (over: Record<string, unknown> = {}, answers: Record<string, unknown> = {}) => fake({
    church_sources: [entry(), notesEntry(over)],
    church_source_read: (args: Record<string, unknown>) => args["id"] === "notes1" ? encode(NOTES) : encode(CSV),
    church_notes_set: (args: Record<string, unknown>) => notesEntry({ label: args["label"], attachments: args["attachments"] }),
    church_notes_choose_file: () => notesEntry({ id: "notes2", label: "Snow", shown: "snow.txt" }),
    ...answers,
  });
  const notesOf = (c: ReturnType<typeof controller>, id = "notes1") => { const r = c.state().noteReads.get(id); return r?.ok ? r.notes : null; };

  it("lists notes apart from lists and reads them like a list's file, in memory", async () => {
    const f = withNotes();
    const c = controller(f);
    await c.load();
    expect(c.state().sources!.map(x => x.id)).toEqual(["keys"]);
    expect(c.state().notes.map(n => [n.id, n.kind, n.label, n.shown])).toEqual([["notes1", "notes", "Policies", "policies.md"]]);
    expect(notesOf(c)!.sections.map(x => x.title)).toEqual(["Child safety policy", "Snow days"]);
    expect(f.calls.filter(([command]) => command === "church_source_read").map(([, a]) => a)).toEqual([{ id: "keys" }, { id: "notes1" }]);
    // Read again with the lists; removed with church_source_remove; nothing read is kept after.
    await c.readOne("notes1");
    expect(f.calls.at(-1)).toEqual(["church_source_read", { id: "notes1" }]);
    expect(await c.remove("notes1")).toBeNull();
    expect(f.calls.at(-1)).toEqual(["church_source_remove", { id: "notes1" }]);
    expect(c.state().notes).toEqual([]);
    expect(c.state().noteReads.size).toBe(0);
  });

  it("says why notes couldn't be shown in notes' own words", async () => {
    for (const code of ["pdf", "workbook", "too-large", "file-missing"]) {
      const c = controller(withNotes({}, { church_source_read: (a: Record<string, unknown>) => a["id"] === "notes1" ? Promise.reject(code) : encode(CSV) }));
      await c.load();
      expect(c.state().noteReads.get("notes1"), code).toEqual({ ok: false, at: clock, problem: code in NOTES_WORDS ? NOTES_WORDS[code as keyof typeof NOTES_WORDS] : SOURCE_PROBLEMS[code as keyof typeof SOURCE_PROBLEMS] });
    }
    const big = controller(withNotes({}, { church_source_read: (a: Record<string, unknown>) => a["id"] === "notes1" ? new Uint8Array(MAX_NOTES_BYTES + 1).fill(97).buffer : encode(CSV) }));
    await big.load();
    expect(big.state().noteReads.get("notes1")).toMatchObject({ ok: false, problem: SOURCE_PROBLEMS["notes-too-large"] });
  });

  it("adds notes from Ozzie's own panel and reads them; a PDF is refused in plain words", async () => {
    const f = withNotes();
    const c = controller(f);
    await c.load();
    expect(await c.chooseNotes()).toEqual({ added: "notes2" });
    expect(c.state().notes.map(n => n.id)).toEqual(["notes1", "notes2"]);
    expect(c.state().noteReads.get("notes2")?.ok).toBe(true);
    const pdf = controller(withNotes({}, { church_notes_choose_file: new Error("pdf") }));
    await pdf.load();
    expect(await pdf.chooseNotes()).toEqual({ problem: NOTES_WORDS.pdf });
    const none = controller(withNotes({}, { church_notes_choose_file: null }));
    await none.load();
    expect(await none.chooseNotes()).toEqual({ cancelled: true });
  });

  it("saves the label and the sections attached through native code whole, one change after another", async () => {
    const f = withNotes();
    const c = controller(f);
    await c.load();
    const team = c.updateNotes("notes1", { attachments: now => [...now, { section: "Child safety policy", team_id: "7593352" }] });
    const kind = c.updateNotes("notes1", { attachments: now => [...now, { section: "Snow days", finding_kind: "needs-people" }] });
    expect(await team).toBeNull();
    expect(await kind).toBeNull();
    expect(f.calls.filter(([command]) => command === "church_notes_set").map(([, a]) => a)).toEqual([
      { id: "notes1", label: "Policies", attachments: [{ section: "Child safety policy", team_id: "7593352" }] },
      { id: "notes1", label: "Policies", attachments: [{ section: "Child safety policy", team_id: "7593352" }, { section: "Snow days", finding_kind: "needs-people" }] },
    ]);
    expect(c.state().notes[0]!.attachments).toHaveLength(2);
    expect(await c.updateNotes("notes1", { label: " \u200b " })).toBe(NO_NOTES_LABEL);
    expect(await c.updateNotes("nope", { label: "x" })).toBe(SOURCE_PROBLEMS.unavailable);
  });

  it("opens a section asked for from Sunday, and forgets the ask once shown", async () => {
    const c = controller(withNotes());
    await c.load();
    c.focus({ id: "notes1", section: 1 });
    expect(c.state().focus).toEqual({ id: "notes1", section: 1 });
    const html = renderToStaticMarkup(React.createElement(ChurchListsPage, { sources: c, positions: POSITIONS }));
    expect(html).toMatch(/<details[^>]*open=""[^>]*>[\s\S]*?Snow days[\s\S]*?We text by 6 AM\./u);
    expect(text(html)).not.toContain("Two adults in every room");
    c.focus(null);
    expect(c.state().focus).toBeNull();
  });

  it("shows notes as written: framed as the church's own, sections closed until opened, URLs as text, a find that marks what it found", async () => {
    const c = controller(withNotes());
    await c.load();
    const html = renderToStaticMarkup(React.createElement(ChurchListsPage, { sources: c, positions: POSITIONS }));
    const words = text(html);
    expect(NOTES_FRAME).toBe("Your church's own notes. Ozzie doesn't check or follow these.");
    for (const line of [notesPage.NOTES_TITLE, notesPage.ADD_NOTES, notesPage.ADD_NOTES_HELP, NOTES_FRAME, notesPage.FIND_NOTES, "Child safety policy", "Snow days"]) {
      expect(words, line).toContain(line);
    }
    expect(words).toMatch(/Read from policies\.md at \d{1,2}:\d{2} (?:AM|PM)/u);
    expect(words).not.toContain("Two adults");
    expect(html).not.toMatch(/<a[\s>]|<img|<script|dangerouslySetInnerHTML/u);
    // A find, highlighted by splitting the text: a URL stays text, accents and case folded.
    const found = renderToStaticMarkup(React.createElement(notesPage.NotesFound, { notes: notesOf(c)!, query: "CAFE" }));
    expect(found).toContain("<mark>Café</mark> opens at 8.");
    const url = renderToStaticMarkup(React.createElement(notesPage.NotesFound, { notes: notesOf(c)!, query: "example.org" }));
    expect(url).toContain("See https://<mark>example.org</mark>/policy");
    expect(url).not.toMatch(/<a[\s>]/u);
    expect(text(renderToStaticMarkup(React.createElement(notesPage.NotesFound, { notes: notesOf(c)!, query: "nothing like this" }))).trim()).toBe(notesPage.NOTHING_IN_NOTES);
    // The attach choice, in an opened section: nowhere, a team in this check, or one of the closed kinds, in plain words.
    expect(html).not.toContain(notesPage.ATTACH_LABEL);
    c.focus({ id: "notes1", section: 0 });
    const opened = renderToStaticMarkup(React.createElement(ChurchListsPage, { sources: c, positions: POSITIONS }));
    expect(text(opened)).toContain(notesPage.ATTACH_LABEL);
    expect(opened).toContain(`<option value="" selected="">${notesPage.NOT_ON_SUNDAY}</option>`);
    for (const kind of NOTE_FINDING_KINDS) expect(opened).toContain(`>${NOTE_KIND_WORDS[kind]}</option>`);
    expect(opened).toContain(">Greeter, Usher team</option>");
  });

  it("points to an attached section beside a Sunday card for its team or its kind, as the church's own notes, with Open", async () => {
    const c = controller(withNotes({ attachments: [{ section: "Child safety policy", team_id: "7593352" }, { section: "Snow days", finding_kind: "pending" }, { section: "Gone", team_id: "7593352" }] }));
    await c.load();
    const opened: unknown[] = [];
    const box = (card: Record<string, unknown>) => renderToStaticMarkup(React.createElement(ChurchOwnWords, { state: c.state(), card: card as never, onOpen: t => { opened.push(t); } }));
    const nursery = box({ kind: "needs-people", team_id: "7593352", name: "Nursery" });
    expect(text(nursery)).toContain(`${notesBeside("Child safety policy")} · Open`);
    expect(nursery).toMatch(/^<section class="church-own-words/u);
    expect(text(nursery)).not.toMatch(/Two adults|Snow days/u);
    expect(text(box({ kind: "pending", team_id: "7593354", name: "Lyrics" }))).toContain(notesBeside("Snow days"));
    expect(box({ kind: "streak" })).toBe("");
    expect(box({ kind: "needs-people", team_id: "9", name: "Ushers" })).toBe("");
    // Notes that couldn't be read point to nothing.
    const failed = controller(withNotes({ attachments: [{ section: "Snow days", finding_kind: "pending" }] }, { church_source_read: () => Promise.reject("file-missing") }));
    await failed.load();
    expect(renderToStaticMarkup(React.createElement(ChurchOwnWords, { state: failed.state(), card: { kind: "pending" } as never }))).toBe("");
  });

  it("shows every line of every section as written, the documented cleaning aside, and drops nothing (review V, H1)", async () => {
    const zw = String.fromCodePoint(0x200b), rlo = String.fromCodePoint(0x202e);
    const para = (n: number) => `Paragraph ${n}: ${"every adult who serves with children stays two-deep, ".repeat(4)}end of paragraph ${n}.`;
    const fixtures = [
      // One-line paragraphs over 120 characters between blank lines, as TextEdit or a pasted email gives them.
      [1, 2, 3].map(para).join("\n\n"),
      // Markdown with text before its first heading.
      ["Read this before Sunday.", "Questions go to the office.", "", "# Child safety", "Two adults in every room.", "", "# Snow days", "We text by 6 AM."].join("\n"),
      // A heading of 300 characters.
      [`# ${"Heading words ".repeat(21)}end`, "Under a long heading."].join("\n"),
      // Spacing, tabs, hidden characters, a long line, a bare heading, two sections with one title, a non-heading.
      ["#  Snow   days  ", "\tIndented\twith tabs   ", `Hidden${zw}${rlo} characters`, "x".repeat(MAX_NOTE_LINE + 500), "", "", "#", "Under a bare heading.",
        "## Who to call", "Nursery: the office.", "## Who to call", "Kids: the front desk.", "    # four spaces is text"].join("\r\n"),
    ];
    const HEADING = /^ {0,3}#{1,6}(?: |$)/u, MARKER = /^ {0,3}#{1,6}/u;
    const decode = (html: string) => html.replace(/<[^>]+>/gu, "").replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", "\"").replaceAll("&#x27;", "'");
    for (const text of fixtures) {
      // The file's lines after the documented cleaning only: hidden format characters out, a tab or other control as a
      // space, nothing kept after the last character, a line over 2,000 characters cut and marked; a heading's marker
      // starts its section and isn't text. Blank lines separate and aren't compared.
      const expected = text.split(/\r\n|\n|\r/u).map(l => noteLine(l, MAX_NOTE_LINE).text).map(l => HEADING.test(l) ? l.replace(MARKER, "").trimStart() : l).filter(l => l !== "");
      const c = controller(withNotes({}, { church_source_read: (a: Record<string, unknown>) => a["id"] === "notes1" ? encode(text) : encode(CSV) }));
      await c.load();
      const notes = notesOf(c)!;
      const shown: string[] = [];
      for (const [i, section] of notes.sections.entries()) {
        c.focus({ id: "notes1", section: i });
        const html = renderToStaticMarkup(React.createElement(ChurchListsPage, { sources: c, positions: POSITIONS }));
        const open = /<details[^>]*open=""[^>]*>([\s\S]*?)<\/details>/u.exec(html)?.[1] ?? "";
        const lines = [...open.matchAll(/<div class="note-line[^"]*">([\s\S]*?)<\/div>/gu)].map(m => decode(m[1]!));
        // A heading's title is its text unless the page shows the heading as written in the section (cut or tidied).
        if (section.heading && section.title && section.written === undefined) shown.push(section.title);
        shown.push(...lines.filter(l => l !== "\u00a0" && l !== ""));
      }
      expect(shown, text.slice(0, 40)).toEqual(expected);
    }
  });

  const pageOf = (c: ReturnType<typeof controller>) => renderToStaticMarkup(React.createElement(ChurchListsPage, { sources: c, positions: POSITIONS }));
  const opened = (html: string) => /<details[^>]*open=""[^>]*>([\s\S]*?)<\/details>/u.exec(html)?.[1] ?? "";
  const withText = (text: string, over: Record<string, unknown> = {}) =>
    controller(withNotes(over, { church_source_read: (a: Record<string, unknown>) => a["id"] === "notes1" ? encode(text) : encode(CSV) }));
  const TWICE = "# Nursery\n## Who to call\nNursery lead\n# Kids\n## Who to call\nKids lead\n";

  it("names sections with one title apart, points to the one chosen, and opens that one (review V, M1)", async () => {
    const c = withText(TWICE, { attachments: [{ section: "Who to call", team_id: "7593352", occurrence: 2 }] });
    await c.load();
    const words = text(pageOf(c));
    expect(words).toContain("Who to call (1)");
    expect(words).toContain("Who to call (2)");
    // Only the second's choice shows the team.
    c.focus({ id: "notes1", section: 1 });
    expect(opened(pageOf(c))).toContain(`<option value="" selected="">${notesPage.NOT_ON_SUNDAY}</option>`);
    c.focus({ id: "notes1", section: 3 });
    expect(opened(pageOf(c))).toMatch(/<option value="team:7593352" selected="">/u);
    // Choosing keeps which one: the second carries occurrence 2, the first none, and another choice for it replaces its own.
    expect(notesPage.choosePointer([], "Who to call", 2, "kind:pending")).toEqual([{ section: "Who to call", finding_kind: "pending", occurrence: 2 }]);
    expect(notesPage.choosePointer([{ section: "Who to call", team_id: "1", occurrence: 2 }], "Who to call", 1, "team:9"))
      .toEqual([{ section: "Who to call", team_id: "1", occurrence: 2 }, { section: "Who to call", team_id: "9" }]);
    expect(notesPage.choosePointer([{ section: "Who to call", team_id: "1", occurrence: 2 }], "Who to call", 2, "")).toEqual([]);
    // On Sunday: the second by its name, and Open opens the second.
    const asked: unknown[] = [];
    const box = renderToStaticMarkup(React.createElement(ChurchOwnWords, { state: c.state(), card: { kind: "needs-people", team_id: "7593352", name: "Nursery" }, onOpen: t => { asked.push(t); } }));
    expect(text(box)).toContain(notesBeside("Who to call (2)"));
    expect(box).toContain(`aria-label="${openLabel("Who to call (2)").replaceAll("&", "&amp;")}"`);
  });

  it("frames a section on Sunday as the church's own and not checked (review V, L1)", () => {
    expect(notesBeside("Snow days")).toBe("From your church's own notes (not checked by Ozzie): Snow days");
  });

  it("offers no choice for a section without a title, and says when a section has no text (review V, L2, L7)", async () => {
    const c = withText("#\nUnder a bare heading.\n# Empty\n# Next\nx\n");
    await c.load();
    c.focus({ id: "notes1", section: 0 });
    expect(text(opened(pageOf(c)))).not.toContain(notesPage.ATTACH_LABEL);
    expect(text(opened(pageOf(c)))).toContain("Under a bare heading.");
    c.focus({ id: "notes1", section: 1 });
    expect(text(opened(pageOf(c)))).toContain(notesPage.EMPTY_SECTION);
    expect(text(opened(pageOf(c)))).toContain(notesPage.ATTACH_LABEL);
  });

  it("says plainly when a section shown on Sunday is no longer in the file, with a way to forget it (review V, L3)", async () => {
    const c = withText(TWICE, { attachments: [{ section: "Gone away", team_id: "7593352" }, { section: "Who to call", finding_kind: "pending", occurrence: 3 }] });
    await c.load();
    const words = text(pageOf(c));
    expect(words).toContain(notesPage.goneNotice("Gone away"));
    expect(words).toContain(notesPage.goneNotice("Who to call (3)"));
    expect(words).toContain(notesPage.FORGET_POINTER);
    expect(notesPage.goneNotice("Gone away")).toBe("“Gone away” was shown on Sunday, but it is no longer in these notes. If a section with that title comes back, Ozzie shows it there again.");
  });

  it("keeps at most 50 sections on Sunday for one file of notes, and says so (review V, L7)", async () => {
    const f = withNotes({ attachments: Array.from({ length: 50 }, (_, i) => ({ section: `S${i}`, team_id: "1" })) });
    const c = controller(f);
    await c.load();
    expect(await c.updateNotes("notes1", { attachments: now => [...now, { section: "Snow days", team_id: "1" }] })).toBe(notesPage.TOO_MANY_POINTERS);
    expect(f.calls.some(([command]) => command === "church_notes_set")).toBe(false);
    expect(await c.updateNotes("notes1", { label: "" })).toBe(NO_NOTES_LABEL);
    expect(NO_NOTES_LABEL).toBe("Give these notes a name, up to 60 characters.");
  });

  it("opens a section asked for past the first 200, moves to it, and announces a find that finds nothing (review V, L4)", async () => {
    const many = Array.from({ length: 250 }, (_, i) => `# Section ${i}\nText ${i}.`).join("\n");
    const c = withText(many);
    await c.load();
    c.focus({ id: "notes1", section: 230 });
    const html = pageOf(c);
    expect(text(opened(html))).toContain("Text 230.");
    expect(text(html)).toContain(notesPage.MORE_SECTIONS);
    expect(text(html)).toContain(notesPage.sectionsShown(231, 250));
    const none = renderToStaticMarkup(React.createElement(notesPage.NotesFound, { notes: notesOf(c)!, query: "nothing like this" }));
    expect(none).toMatch(/<p [^>]*role="status"[^>]*>Nothing in these notes matches that\.<\/p>/u);
    for (const line of [notesPage.MORE_PLACES, notesPage.PART_SHOWN, notesPage.sectionsShown(200, 250)]) expect(line).not.toMatch(/Find narrows/u);
    expect(notesPage.MORE_PLACES).toBe("Ozzie marked the first 1,000 places. Type more to narrow them.");
  });

  it("Open scrolls only the pane the section is in, then moves focus there without scrolling again (the coordinator's 0.1.8 click-through)", () => {
    const calls: unknown[] = [];
    const pane = { scrollTop: 300, getBoundingClientRect: () => ({ top: 40 }) };
    const summary = {
      closest: (selector: string) => { calls.push(["closest", selector]); return pane; },
      getBoundingClientRect: () => ({ top: 940 }),
      focus: (options?: unknown) => { calls.push(["focus", options]); },
      scrollIntoView: () => { throw new Error("scrollIntoView scrolls the app around the pane too"); },
    };
    notesPage.showInPane(summary);
    expect(pane.scrollTop).toBe(300 + 940 - 40 - notesPage.PANE_MARGIN);
    expect(calls).toEqual([["closest", "main"], ["focus", { preventScroll: true }]]);
    // Outside a pane, only the focus moves, and still without scrolling.
    calls.length = 0;
    notesPage.showInPane({ ...summary, closest: () => null });
    expect(calls).toEqual([["focus", { preventScroll: true }]]);
    expect(readFileSync(new URL("../src/church-notes.tsx", import.meta.url), "utf8")).not.toMatch(/\.scrollIntoView|\.focus\(\)/u);
  });

  it("limits a section's title as the core does", () => {
    expect(MAX_TITLE).toBe(120);
  });
});

describe("plain words", () => {
  const lines: string[] = [...(Object.values(page) as unknown[]).filter((v): v is string => typeof v === "string"),
    ...(Object.values(linkForm) as unknown[]).filter((v): v is string => typeof v === "string"),
    ...(Object.values(notesPage) as unknown[]).filter((v): v is string => typeof v === "string"), notesPage.removeNotesConfirm("Policies"),
    notesPage.sectionsShown(200, 250), notesPage.goneNotice("Snow days"), NO_NOTES_LABEL,
    page.removeConfirm("Key holders"), page.removeLinkConfirm("Snack rota"), page.someShown(200, 2000), page.valuesShown(50, 120), readFrom(HOST, "9:06 AM")];
  it("uses none of the words kept off every screen, never calls the list checked, and never ranks or labels a person", () => {
    expect(lines.length).toBeGreaterThan(25);
    for (const line of [...lines, TOO_MANY_LISTS, TOO_MANY_TICKED, NO_LABEL, NO_ADDRESS, moreRows(3), listFrame("Key holders")]) {
      expect(line).not.toMatch(/\b(?:skills?|sessions?|agents?|logs?|connectors?|harness|MCP|servers?|JSON|stdio|protocol|parse[ds]?|parser|encoding|delimiter|bytes?|sync(?:ed)?)\b/iu);
      expect(line).not.toMatch(/\b(?:approve|block(?:ed)?|risk|drift(?:ing)?|score|rank(?:ed|ing)?|verified|confirmed|accurate)\b/iu);
      expect(line.replace("not checked by Ozzie", "")).not.toMatch(/\bchecked\b/iu);
      expect(line.trim()).toBe(line);
    }
    // The list is the church's own: the page says Ozzie doesn't check it, and that it stays on this Mac.
    expect(page.LIST_FRAME).toBe("This is your church's own list. Ozzie shows it as written and doesn't check it.");
    // Review S, L7: the match it keeps sits beside the choice, and each app's own way to save CSV.
    expect(page.KEEP_MATCH).toBe("Keep this match");
    expect(page.ADD_HELP).toBe("Choose a spreadsheet saved as CSV or tab-separated text, up to 2 MB. In Numbers choose File › Export To › CSV. In Excel choose File › Save As and pick CSV UTF-8.");
    expect(page.LISTS_STAYS).toMatch(/stay on this Mac/u);
    expect(page.LISTS_STAYS).toMatch(/aren't sent to AI help, shared with other AI apps or Siri, or put in any notice/u);
  });
});

describe("the bridge to native code", () => {
  it("refuses any command not in its list before anything is sent, however the name was made (review S2, finding 1)", async () => {
    const sent = vi.mocked(tauri);
    sent.mockClear();
    for (const command of ["notify_ozzie", ["open", "draft"].join("_"), "church_x", "", "church_sources ", "toString", "__proto__"]) expect(allowed(command), command).toBe(false);
    for (const command of SOURCE_COMMANDS) expect(allowed(command), command).toBe(true);
    // Review U, finding 1 (u14): the guard is literal comparisons, so widening a built-in's prototype widens nothing.
    const has = Set.prototype.has;
    try {
      Set.prototype.has = () => true;
      expect(allowed(["speak", "briefing"].join("_"))).toBe(false);
    } finally { Set.prototype.has = has; }
    // A controller made with no invoke of its own sends through the guarded bridge, by the commands' own names.
    expect(sent).not.toHaveBeenCalled();
    await createChurchSources().load();
    expect(sent.mock.calls.map(c => c[0])).toEqual(["church_sources"]);
  });
});

describe("native code and the page agree", () => {
  const rust = readFileSync(new URL("../src-tauri/src/church_sources.rs", import.meta.url), "utf8");
  const main = readFileSync(new URL("../src-tauri/src/main.rs", import.meta.url), "utf8");

  it("on the closed codes: native code's are exactly the page's native ones, a link's among them, and the sheet's it checks", () => {
    const body = /pub enum SourceError \{([^}]*)\}/u.exec(rust)![1]!;
    const codes = [...body.matchAll(/^\s{4}([A-Z][A-Za-z]+),$/gmu)].map(m => m[1]!.replace(/[A-Z]/gu, (c, i: number) => (i ? "-" : "") + c.toLowerCase()));
    expect(rust).toContain("#[serde(rename_all = \"kebab-case\")]\npub enum SourceError");
    expect(codes.sort()).toEqual([...NATIVE_SOURCE_PROBLEMS, "too-large", "workbook", "not-text"].sort());
    for (const code of codes) expect(Object.hasOwn(SOURCE_PROBLEMS, code), code).toBe(true);
    for (const code of ["too-large", "workbook", "not-text"]) expect(SHEET_PROBLEMS).toContain(code);
  });

  it("on notes: their size, sections attached, a title's length, and the closed kinds of finding", () => {
    const constant = (name: string) => new RegExp(`^pub const ${name}: \\w+ = (.+);$`, "mu").exec(rust)?.[1];
    expect(constant("MAX_NOTES_BYTES")).toBe("1024 * 1024");
    expect(1024 * 1024).toBe(MAX_NOTES_BYTES);
    expect(Number(constant("MAX_ATTACHMENTS"))).toBe(50);
    expect(Number(constant("MAX_TITLE"))).toBe(MAX_TITLE);
    expect(constant("MAX_NOTE_LINES")).toBe("20_000");
    expect(20_000).toBe(MAX_NOTE_LINES);
    const kinds = /pub const NOTE_FINDING_KINDS: \[&str; \d+\] = \[([^\]]*)\]/u.exec(rust)?.[1] ?? "";
    expect([...kinds.matchAll(/"([^"]+)"/gu)].map(m => m[1])).toEqual([...NOTE_FINDING_KINDS]);
    // Each is a kind the Sunday brief makes (core/src/sunday-brief.ts).
    const brief = readFileSync(new URL("../../../core/src/sunday-brief.ts", import.meta.url), "utf8");
    const union = /kind: ("needs-people"[^;]*);/u.exec(brief)?.[1] ?? "";
    for (const kind of NOTE_FINDING_KINDS) expect(union, kind).toContain(`"${kind}"`);
  });

  it("on how a link the links' store doesn't hold is listed: no host, which the page reads as any other place (review U, finding 2)", async () => {
    expect(new RegExp('^pub const LINK_NOT_HELD: &str = "(.+)";$', "mu").exec(rust)?.[1]).toBe("\\u{2022}\\u{2022}\\u{2022}");
    const f = fake({ church_sources: [linkEntry({ shown: "\u2022\u2022\u2022" })] });
    const c = controller(f);
    await c.load();
    expect(c.state().sources?.map(s => s.shown)).toEqual(["\u2022\u2022\u2022"]);
  });

  it("on the limits", () => {
    const constant = (name: string) => new RegExp(`^pub const ${name}: \\w+ = (.+);$`, "mu").exec(rust)?.[1];
    expect(constant("MAX_SOURCE_BYTES")).toBe("2 * 1024 * 1024");
    expect(2 * 1024 * 1024).toBe(MAX_SHEET_BYTES);
    expect(MAX_SHEET_BYTES).toBe(2_097_152);
    for (const [name, value] of [["MAX_SOURCES", MAX_SOURCES], ["MAX_LINKS", MAX_LINKS], ["MAX_TICKED", MAX_TICKED], ["MAX_LABEL", MAX_LABEL], ["MAX_SHOWN", MAX_SHOWN],
      ["MAX_HEADER", MAX_HEADER], ["MAX_CELL", MAX_CELL], ["MAX_NAME", MAX_NAME], ["MAX_MATCHES", MAX_ROWS]] as const) {
      expect(Number(constant(name)), name).toBe(value);
    }
  });

  it("on the commands: the twelve the bridge lists, registered in main.rs, each taking an id, a change, or a new link's label and address", () => {
    const registered = [...main.matchAll(/church_sources::(\w+),/gu)].map(m => m[1]);
    expect(registered).toEqual([...SOURCE_COMMANDS]);
    const commands = [...rust.matchAll(/#\[tauri::command\]\npub async fn (\w+)\(([^)]*)\)/gu)].map(m => [m[1], m[2]!.replace(/\s+/gu, " ").trim()]);
    expect(commands.map(([name]) => name)).toEqual([...SOURCE_COMMANDS]);
    expect(SOURCE_COMMANDS).toHaveLength(12);
    for (const [name, args] of commands) {
      const names = [...args!.matchAll(/(\w+): /gu)].map(m => m[1]);
      expect(names[0], name).toBe("app");
      if (name === "church_source_set") expect(names).toEqual(["app", "id", "label", "column", "ticked", "matches"]);
      else if (name === "church_link_add") expect(names).toEqual(["app", "label", "address"]);
      else if (name === "church_notes_set") expect(names).toEqual(["app", "id", "label", "attachments"]);
      else expect(names.slice(1).every(n => n === "id"), `${name}: ${args}`).toBe(true);
    }
    // Only the add takes an address, and the page sends it nowhere else.
    const bridge = readFileSync(new URL("../src/church-sources.ts", import.meta.url), "utf8");
    const code = bridge.split("\n").filter(l => !/^\s*(?:\/\/|\*|\/\*\*)/u.test(l));
    // The parameter, the check that something was pasted, and the one call that takes it: nothing stores or shows it.
    expect(code.filter(l => /\baddress\b/u.test(l)).map(l => l.trim())).toEqual([
      "async addLink(label: string, address: string): Promise<AddLinkResult> {",
      "if (!address.trim()) return { problem: NO_ADDRESS };",
      "try { reply = await call<unknown>(\"church_link_add\", { label: name, address }, LINK_CALL_LIMIT_MS); }",
    ]);
    // main.rs names it only in the module line and the six command names.
    expect(main.split("\n").filter(l => l.includes("church_sources")).map(l => l.trim()))
      .toEqual(["mod church_sources;", ...SOURCE_COMMANDS.map(c => `church_sources::${c},`)]);
  });
});
