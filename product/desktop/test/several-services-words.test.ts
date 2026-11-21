// Words seen in 0.5.3 with two Planning Center services watched (polish 3): what Ask says it can do speaks of "the
// services it watches", an answer's procedure and Church rules' procedures are named for every service at once, the
// line about what a procedure's "Sunday" means sits only above a text that says Sunday, and the Siri link says the page
// it opens. With one service each reads exactly as before. Fixed fictional data, clock pinned to the fictional check.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => new Promise(() => {})) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { installFakeDom } from "./fake-dom.js";
import { fictionalData, greeterTurns, scripted, text } from "./harness-fakes.js";
import { AskPanel, helpFor } from "../src/ask-panel.js";
import { RulesPage } from "../src/rules-page.js";
import { WatchedServices } from "../src/watch-another.js";
import { OPEN_NAME, SiriShortcutsSection } from "../src/siri-shortcuts-section.js";
import { DayProvider } from "../src/day-words.js";
import { COMPOSED_NOTE, composedNote, HELP, HELP_SERVICES } from "../src/harness-words.js";
import { MANY_SERVICES, mergeParts, watchesSeveral } from "../src/services-merge.js";
import { systemWords } from "../src/church-system.js";
import { askOzzie, createAppHarness, PROCEDURE_ORDER } from "../src/harness-bridge.js";
import { saysSunday } from "../src/procedure-text.js";
import { buildSundayBrief } from "../../../core/src/sunday-brief.js";
import { nov22Capture } from "../../../core/src/fictional-sunday.js";
import { bundledSkills } from "../../../core/src/harness/bundled-skills.js";
import { HarnessSession } from "../../../core/src/harness/session.js";
import { parseRequest } from "../../../core/src/harness/responsibilities.js";
import { dayWords } from "../../../core/src/service-day.js";
import { wednesdayCapture, wednesdayWords } from "../../../core/test/fixtures/service-days/wednesday.js";

const dom = installFakeDom();
type FakeNode = { tagName?: string; childNodes: FakeNode[]; getAttribute?: (n: string) => string | null };
const walk = (n: FakeNode): FakeNode[] => [n, ...n.childNodes.flatMap(walk)];
const nodesOf = () => walk(dom.root as unknown as FakeNode);
const skills = await bundledSkills();
const rules = { sundayLeads: [], checkInAfterSundaysInARow: 3 };
const sunday = nov22Capture();
const wed = wednesdayCapture();
const first = buildSundayBrief(sunday, rules, sunday.completed_at);
/** Two services, as App gives Ask their brief: the first's findings with the other's joined in, and every service's day words. */
const both = mergeParts({ brief: first, decisions: [] }, [{ plan_id: "94000001", brief: buildSundayBrief(wed, rules, wed.completed_at), decisions: [] }]).brief;
const WED_FIRST = wednesdayWords();

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); vi.setSystemTime(new Date(sunday.completed_at)); });
let unmount: (() => Promise<void>) | null = null;
afterEach(async () => { await unmount?.(); unmount = null; vi.useRealTimers(); });

describe("several services' day words are told apart from one plan's", () => {
  it("only every service's words at once count as several; one plan over several days keeps its dates", () => {
    expect(watchesSeveral(both.day)).toBe(true);
    expect(watchesSeveral(MANY_SERVICES)).toBe(true);
    expect(watchesSeveral(first.day)).toBe(false);
    expect(watchesSeveral(dayWords({ sort_date: "2026-11-25T19:00:00Z", times: ["2026-11-26T01:00:00Z", "2026-11-29T15:00:00Z"] }, "America/Chicago"))).toBe(false);
    expect(watchesSeveral(null)).toBe(false);
  });
});

describe("What can you do? (item 1)", () => {
  /** "What can you do?" pressed as the panel's own suggestion, as a person does it (no AI set up, so it is the one chip). */
  async function helpShown(brief: typeof first): Promise<string> {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(dom.root as unknown as Element);
    await act(async () => { root.render(React.createElement(AskPanel, { open: true, onClose: () => {}, ask: () => new Promise<never>(() => {}), brief, modelReady: false,
      onOpen: () => {}, initialVoice: { ok: false, reason: "unavailable" } as never })); });
    unmount = async () => { await act(async () => { root.unmount(); }); };
    const chip = dom.button("What can you do?");
    if (!chip) throw new Error(`no chip in: ${dom.seen().slice(0, 600)}`);
    await act(async () => { dom.press(chip); await Promise.resolve(); });
    return dom.seen();
  }

  it("with two services watched, its lines about the service say the services Ozzie watches", async () => {
    const seen = await helpShown(both);
    expect(seen).toContain(HELP_SERVICES.check);
    expect(seen).toContain(HELP_SERVICES.keep);
    expect(seen).not.toContain(HELP.can[0]!);
    expect(seen).not.toContain(HELP.can[3]!);
    expect(seen).toContain(HELP_SERVICES.try);
    expect(seen).not.toContain(HELP.try);
    // Every other line is Planning Center's own, as before.
    for (const line of [HELP.can[1]!, HELP.can[2]!, HELP.can[4]!, HELP.can[5]!, HELP.never]) expect(seen).toContain(line);
  });

  it("with one service, exactly as before", async () => {
    const seen = await helpShown(first);
    for (const line of HELP.can) expect(seen).toContain(line);
    expect(seen).not.toContain(HELP_SERVICES.check);
  });

  it("only Planning Center watches several services: another system's list is its own either way", () => {
    expect(helpFor(systemWords("planning-center"))).toBe(HELP);
    expect(helpFor(systemWords("planning-center"), true).can).toEqual([HELP_SERVICES.check, HELP.can[1], HELP.can[2], HELP_SERVICES.keep, HELP.can[4], HELP.can[5]]);
    // The request it suggests is read as the same one as with one service.
    expect(parseRequest("Keep an eye on my services", sunday.completed_at, "America/Chicago")).toEqual(parseRequest("Keep an eye on the service", sunday.completed_at, "America/Chicago"));
    expect(HELP_SERVICES.try).toContain("“Keep an eye on my services”");
    for (const system of ["b1", "breeze"] as const) expect(helpFor(systemWords(system), true)).toEqual(helpFor(systemWords(system)));
  });
});

describe("a procedure's name and the line above its exact text (item 1 and the sweep)", () => {
  const ready = skills.get("sunday-ready")!, own = skills.get("answer-from-what-was-read")!;

  it("the line about what \"Sunday\" means sits only above a text that says Sunday", () => {
    expect(saysSunday(ready.body)).toBe(true);
    expect(saysSunday(own.body)).toBe(false);
    expect(saysSunday("Before Sunday's service.")).toBe(true);
    expect(saysSunday("Sundays in a row")).toBe(false);
  });

  it("in Ask with two services, an answer's procedure and notes speak for your services; a card keeps what was true when asked", async () => {
    const h = createAppHarness({ workspace_id: "fictional", data: fictionalData(), skills, session: new HarnessSession(), loop: "ts", step: scripted(greeterTurns).model });
    const turn = await askOzzie(h, "Who could cover Greeter?", { skills, sender: "Pat" });
    if (turn.state !== "answered") throw new Error(turn.state);
    // An answer Ozzie wrote itself, following "Sunday ready", as AI on this Mac's long answers are.
    const answered = { state: "answered" as const, answer: { ...turn.answer, composedHere: true, procedure: { title: ready.title, body: ready.body } } };
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(dom.root as unknown as Element);
    unmount = async () => { await act(async () => { root.unmount(); }); };
    // The first service is on a Wednesday (the page's own day words); Ask reads one service's brief or both.
    const draw = (brief: typeof first) => act(async () => { root.render(React.createElement(DayProvider, { value: WED_FIRST }, React.createElement(AskPanel, {
      open: true, onClose: () => {}, ask: async () => answered, brief, modelReady: true, onOpen: () => {}, initialVoice: { ok: false, reason: "unavailable" } as never }))); });
    /** Asks the panel's first suggestion, as a person presses it, and waits for the answer card. */
    const askFirstChip = async () => {
      const chip = nodesOf().find(n => n.tagName === "BUTTON" && (n.getAttribute?.("class") ?? "") === "chip");
      if (!chip) throw new Error(`no chip in: ${dom.seen().slice(0, 600)}`);
      await act(async () => { dom.press(chip as never); for (let i = 0; i < 5; i++) await Promise.resolve(); });
    };
    /** What the card on show says, with See how this works opened (it stays open for the next answer, as the panel keeps it). */
    const howShown = async () => {
      if (dom.seen().includes("Ozzie followed this procedure")) return dom.seen();
      const how = dom.button("See how this works");
      if (!how) throw new Error(`no See how this works in: ${dom.seen().slice(0, 600)}`);
      await act(async () => { dom.press(how); await Promise.resolve(); });
      return dom.seen();
    };
    // Asked while one service is watched: the first service's own day.
    await draw(first);
    await askFirstChip();
    expect(dom.seen()).toContain(COMPOSED_NOTE);
    const one = await howShown();
    expect(one).toContain("Ozzie followed this procedure: Ready for Wednesday");
    expect(one).toContain("Where they say Sunday, they mean your Wednesday service.");
    // A second service is watched now: the card already on show still says what was true when it was asked.
    await draw(both);
    expect(dom.seen()).toContain(COMPOSED_NOTE);
    expect(dom.seen()).toContain("Ozzie followed this procedure: Ready for Wednesday");
    expect(dom.seen()).not.toContain("every service it watches");
    // Asked now, with both watched: every service's words.
    await askFirstChip();
    expect(dom.seen()).toContain(composedNote(MANY_SERVICES));
    const two = await howShown();
    expect(two).toContain("Ozzie followed this procedure: Ready for your services");
    expect(two).toContain("Where they say Sunday, they mean your services.");
    expect(two).not.toContain("Ready for Wednesday");
  });

  it("Church rules with two services name each procedure for your services; the note only above those that say Sunday", () => {
    const procedures = PROCEDURE_ORDER.map(id => skills.get(id)!);
    const page = (procedureDay?: typeof MANY_SERVICES) => renderToStaticMarkup(React.createElement(DayProvider, { value: WED_FIRST },
      React.createElement(RulesPage, { rules, onChange: () => {}, positions: [], procedures, ...(procedureDay ? { procedureDay } : {}) })));
    const two = page(MANY_SERVICES), notes = text(two).split("Where they say Sunday, they mean your services.").length - 1;
    expect(text(two)).toContain("Ready for your services");
    expect(notes).toBe(procedures.filter(p => saysSunday(p.body)).length);
    expect(notes).toBeLessThan(procedures.length);
    // The rest of the page keeps the first service's day words (its scheduled leads are that service's).
    expect(text(two)).toContain("Wednesday leads");
    const one = text(page());
    expect(one).toContain("Ready for Wednesday");
    expect(one).not.toContain("they mean your services");
  });
});

describe("Watch another service names the first service from the list it reads (item 3; review of polish 3, L3)", () => {
  const SUNDAY_MORNING = { id: "1500", name: "Sunday Morning", problem: null, next: null };
  const YOUTH_NIGHT = { id: "1700", name: "Youth Night", problem: null, next: null };
  async function listed(mainName: string | null) {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const told: [string, string][] = [];
    const root = createRoot(dom.root as unknown as Element);
    unmount = async () => { await act(async () => { root.unmount(); }); };
    await act(async () => { root.render(React.createElement(WatchedServices, { mainName, mainTypeId: "1500", also: [], connected: true, zone: "America/Chicago",
      pick: async () => ({ services: [SUNDAY_MORNING, YOUTH_NIGHT], time_zone: "America/Chicago", more: false }), onAdd: () => {}, onRemove: async () => null,
      onMainName: (name, type) => { told.push([name, type]); } })); });
    await act(async () => { dom.press(dom.button("Watch another service")!); for (let i = 0; i < 5; i++) await Promise.resolve(); });
    return told;
  }
  it("hands App the first service's name with the service type it was asked for, only when it wasn't known", async () => {
    expect(await listed(null)).toEqual([["Sunday Morning", "1500"]]);
    await unmount!(); unmount = null;
    expect(await listed("Sunday Morning")).toEqual([]);
  });
});

describe("the note under an answer Ozzie wrote itself (sweep)", () => {
  it("says it covers every service watched, or the whole service with one", () => {
    expect(composedNote(MANY_SERVICES)).toContain("it covers every service it watches.");
    expect(composedNote(first.day)).toBe(COMPOSED_NOTE);
    expect(COMPOSED_NOTE).toContain("it covers the whole service.");
  });
});

describe("the Siri link's page (sweep)", () => {
  it("says it opens the Services page, true with one service or several", () => {
    // A helper found in a lasting place (built in parts: the export scan refuses a local path written whole).
    const helper = ["", "Applications", "Ozzie.app", "Contents", "MacOS", "ozzie-shortcut"].join("/");
    const t = text(renderToStaticMarkup(React.createElement(SiriShortcutsSection, { on: true, onChange: () => {}, problem: null, path: helper, actions: false })));
    expect(OPEN_NAME).toBe("Open Ozzie's Services page");
    expect(t).toContain(`"${OPEN_NAME}" opens Ozzie on that page. This one doesn't need Allow Running Scripts.`);
    expect(t).not.toContain("the page of the service it watches");
  });
});
