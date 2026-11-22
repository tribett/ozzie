// "Looks good — I'll send it" (audit item 18): the leader's own mark that they'll ask someone, kept on this Mac by ids
// and times, shown quietly with Undo, dropped once the plan changes for that person or the Sunday passes, and never part
// of what a model, a notice, the copy for other AI apps or Siri is given. Fictional data only.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => { throw new Error("NATIVE_CALL_FORBIDDEN"); }) }));
import { askedMark, askedMemory, askedText, holding, placeIn } from "../src/asked.js";
import { DraftBox, LOOKS_GOOD, type AskedLine } from "../src/sunday-page.js";
import { NAME_HELP, NAME_LABEL } from "../src/draft-actions.js";
import { FirstRun } from "../src/setup-flow.js";
import { TodayPage } from "../src/today-page.js";
import { buildSundayBrief, type SundayBrief } from "../../../core/src/sunday-brief.js";
import { nov22Capture, nov22LaterCapture } from "../../../core/src/fictional-sunday.js";
import { ALL, code, imports, names as namesCommand, NATIVE_COMMANDS, OFF_THE_PAGE_APIS, reach, source } from "../../../core/test/stays-on-this-mac-imports.js";
import { text } from "./harness-fakes.js";

const rules = { sundayLeads: [], checkInAfterSundaysInARow: 3 };
const live = (capture = nov22Capture()): SundayBrief => ({ ...buildSundayBrief(capture, rules, capture.completed_at), mode: "live" });
const AT = "2026-11-16T15:00:00.000Z";
const memoryStore = () => { const m = new Map<string, string>(); return { get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => { m.set(k, v); }, m }; };
const greeterOf = (b: SundayBrief) => b.findings.find(f => f.kind === "needs-people" && f.position!.name === "Greeter")!;

describe("a mark is the leader's, by ids, and lasts only while the plan stays as it was for that person", () => {
  const brief = live();
  const greeter = greeterOf(brief);
  const riley = greeter.people!.suggestions[0]!.person_id;

  it("keeps ids and times only: the Sunday, the finding, the person and their place in it", () => {
    const mark = askedMark(brief, greeter, riley, AT)!;
    expect(mark).toEqual({ plan_id: brief.plan.id, plan_date: brief.plan.date, key: greeter.key, person_id: riley, facts: placeIn(greeter, riley), at: AT });
    expect(JSON.stringify(mark)).not.toMatch(new RegExp(Object.values(nov22Capture().names).join("|"), "u"));
    expect(askedMark(brief, greeter, "Riley", AT)).toBeNull();
    expect(holding([mark], brief)).toEqual([mark]);
    expect(holding([mark], null)).toEqual([]);
  });

  it("is dropped when the plan changes for that person, the finding is gone, or it's another Sunday", () => {
    const mark = askedMark(brief, greeter, riley, AT)!;
    // The later check: Riley's place on the Greeter card is different (or the card changed), so the mark no longer holds.
    const later = live(nov22LaterCapture());
    const again = greeterOf(later);
    const still = again && placeIn(again, riley) === mark.facts;
    expect(holding([mark], later)).toEqual(still ? [mark] : []);
    expect(holding([{ ...mark, facts: JSON.stringify(["needs-people", "conflict", false]) }], brief)).toEqual([]);
    expect(holding([{ ...mark, key: "gone" }], brief)).toEqual([]);
    expect(holding([{ ...mark, plan_id: "92902198" }], brief)).toEqual([]);
  });

  it("is kept on this Mac, undone, settled after a live check, and forgotten once its Sunday has passed", () => {
    const store = memoryStore();
    const marks = askedMemory(store, () => "2026-11-16");
    const mark = askedMark(brief, greeter, riley, AT)!;
    expect(marks.add(mark)).toEqual([mark]);
    expect(marks.add({ ...mark, at: "2026-11-17T15:00:00.000Z" })).toHaveLength(1);
    expect(marks.undo(mark)).toEqual([]);
    marks.add(mark);
    marks.add({ ...mark, key: "gone" });
    expect(marks.settle(brief)).toEqual([mark]);
    expect(askedMemory(store, () => "2026-11-23").all()).toEqual([]);
    // Anything of another shape is dropped: a name, a note, an address.
    store.set("ozzie.asked.v1", JSON.stringify({ version: 1, marks: [{ ...mark, name: "Riley Thornbury" }, { ...mark, person_id: "riley@example.org" }, mark] }));
    expect(askedMemory(store, () => "2026-11-16").all()).toEqual([mark]);
  });

  it("says it quietly with the first name read on this Mac", () => {
    const mark = askedMark(brief, greeter, riley, AT)!;
    // The day it was said on this Mac's clock ("Mon, Nov 16" here; Tuesday on a Mac in Tokyo).
    const day = new Date(AT).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    expect(askedText(mark, nov22Capture().names, "Greeter")).toBe(`On ${day} you said you'd ask ${nov22Capture().names[riley]!.split(" ")[0]} about Greeter.`);
    expect(askedText(mark, {}, null)).toBe(`On ${day} you said you'd ask this person.`);
  });
});

describe("the note card: signed before it goes, and the mark is a separate click", () => {
  const box = (over: Partial<React.ComponentProps<typeof DraftBox>> = {}) => renderToStaticMarkup(React.createElement(DraftBox, {
    label: "Draft note", to: "Riley", body: "Hi Riley,\n\nCould you help?\n\nThank you,\n[Your name]", onBody: () => {}, onClose: () => {}, footer: "Ozzie never sends messages.", ...over,
  }));
  it("asks for the name the note ends with before it's copied or opened, once, under the note (spec §4.2, audit item 18)", () => {
    const html = box({ signName: { set: () => {} } });
    const t = text(html);
    expect(t).toContain(NAME_LABEL);
    expect(t).toContain(NAME_HELP);
    expect(t.indexOf(NAME_LABEL)).toBeLessThan(t.indexOf("Copy draft"));
    expect(t).toContain("Use this name");
    expect(t).toContain("Leave [Your name] for now");
    // A note already signed asks nothing.
    expect(text(box({ body: "Hi Riley,\n\nThank you,\nPat", signName: { set: () => {} } }))).not.toContain(NAME_LABEL);
  });

  it("offers Looks good — I'll send it only where a note is for one person, and shows the mark with Undo once made", () => {
    expect(box()).not.toContain(LOOKS_GOOD);
    const offer = text(box({ mark: { line: null, onMark: () => {} } }));
    expect(offer).toContain(`${LOOKS_GOOD} Marks it on this Mac so this page and Today show you said you'd ask. Nothing is sent and Planning Center doesn't change.`);
    const line: AskedLine = { key: "k", person_id: "511", text: "On Mon, Nov 16 you said you'd ask Riley about Greeter.", undo: () => {} };
    const made = text(box({ mark: { line, onMark: () => {} } }));
    expect(made).toContain("On Mon, Nov 16 you said you'd ask Riley about Greeter. Undo");
    expect(made).not.toContain(LOOKS_GOOD);
    expect(LOOKS_GOOD).toBe("Looks good — I'll send it");
  });

  it("is never made by opening the note, addressed or not: only the leader's own click marks it", async () => {
    let marked = 0;
    const html = renderToStaticMarkup(React.createElement(DraftBox, {
      label: "Draft note", to: "Riley", body: "Hi", onBody: () => {}, onClose: () => {}, footer: "x", mark: { line: null, onMark: () => { marked++; } },
      openTo: async () => ({ app: "Mail", result: "addressed" }), open: async () => ({ app: "Mail" }),
      addressee: { person: "511", name: "Riley", peopleGranted: true },
    }));
    expect(text(html)).toContain(LOOKS_GOOD);
    const { handOffTo, handOff } = await import("../src/draft-actions.js");
    await handOffTo("mail", "Hi", "511", async () => ({ app: "Mail", result: "addressed" }));
    await handOff("messages", "Hi", async () => ({ app: "Messages" }));
    expect(marked).toBe(0);
    // The draft's actions know nothing of the mark: it is a separate control.
    expect(code("product/desktop/src/draft-actions.tsx")).not.toMatch(/onMark|askedMark|AskedLine|askedMemory|NoteMark/u);
  });
});

describe("where the name is asked for and the mark is shown", () => {
  it("first run doesn't ask for the name for notes: it's asked when the first note is prepared (spec §4.2)", () => {
    const t = text(renderToStaticMarkup(React.createElement(FirstRun, {
      status: null, settings: { clientId: "", organization: "", serviceTypeId: "", planId: "" }, onSettings() {}, onStatus() {}, start: "first",
      read: () => new Promise<never>(() => {}), result: null, rules: false, intervalMinutes: 60, nowMs: 0, onExample() {}, onLeave() {}, onDeferred() {}, builtIn: true,
    })));
    expect(t).not.toContain("Your name");
    expect(t).toContain("Connect Planning Center");
  });

  it("Today says it on the Sunday card, with Undo", () => {
    const line: AskedLine = { key: "k", person_id: "511", text: "On Mon, Nov 16 you said you'd ask Riley about Greeter.", undo: () => {} };
    const brief = live();
    const t = text(renderToStaticMarkup(React.createElement(TodayPage, { brief, names: nov22Capture().names, onSunday: () => {}, asked: [line], now: AT, zone: "America/Chicago",
      store: { get: () => null, set: () => {} } })));
    const card = t.slice(t.indexOf("Sunday has"), t.indexOf("Ready to review"));
    expect(card).toContain("On Mon, Nov 16 you said you'd ask Riley about Greeter. Undo");
  });
});

describe("the marks stay on this Mac: nothing that builds what is sent can reach them", () => {
  const ASKED = "product/desktop/src/asked.ts";
  const APP = "product/desktop/src/App.tsx";
  /** Commands that reach a model, send a notice, write the copy for other AI apps or Siri, or carry text off the page. */
  const OUTWARD = ["reword_draft", "agent_step", "responsibility_agent_step", "share_last_check", "notify_sunday_attention", "notify_ozzie", "managed_connect",
    "save_shortcuts_check", "speak_briefing", "open_draft", "open_draft_to", "open_in_planning_center", "phone_notice_test"];
  it("is imported by App.tsx alone, which hands the pages only words and Undo", () => {
    expect(ALL).toContain(ASKED);
    for (const c of OUTWARD) expect(NATIVE_COMMANDS, c).toContain(c);
    expect(ALL.filter(p => imports(p).includes(ASKED))).toEqual([APP]);
    for (const c of OUTWARD) expect(namesCommand(source(APP), c), c).toBe(false);
  });
  it("no module that names a sending command, and nothing in the harness or core/mcp, reaches it", () => {
    const boundary = ALL.filter(p => p !== ASKED && (OUTWARD.some(c => namesCommand(source(p), c)) || p.startsWith("core/src/harness/") || p.startsWith("core/mcp/")));
    expect(boundary).toContain("product/desktop/src/draft-actions.tsx");
    expect(boundary.filter(p => reach(p).has(ASKED))).toEqual([]);
    for (const p of ["product/desktop/src/sunday-page.tsx", "product/desktop/src/today-page.tsx", "product/desktop/src/sunday-ready.tsx"]) expect(reach(p).has(ASKED), p).toBe(false);
  });
  it("names no native command, no way off the page, and no storage of its own: App gives it the store", () => {
    const own = source(ASKED);
    expect(own).not.toMatch(OFF_THE_PAGE_APIS);
    expect(own).not.toContain("@tauri-apps");
    for (const c of NATIVE_COMMANDS) expect(namesCommand(own, c), c).toBe(false);
  });
});
