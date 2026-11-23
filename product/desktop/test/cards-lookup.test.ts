// The Visitor cards page looking each card's name up in Planning Center People (owner decision 2026-11-23): only while
// the cards are being checked, once per name, stopped and dropped with the cards, nothing to an AI model or ozzie.church,
// and what each card then says. The native bridge is the real one over a fake `invoke`; `fetch` is a trap. Fictional
// cards and the test church's fictional people only.
import React from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installFakeDom } from "./fake-dom.js";
const invoked: [string, unknown][] = [];
let answer: (name: string) => Promise<unknown> = async () => ({ result: "no-one" });
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((command: string, args?: unknown) => {
    invoked.push([command, args]);
    if (command === "look_up_card_name") return answer((args as { name: string }).name);
    // The card reader waits, as on a Mac still getting it ready.
    if (command === "prepare_card_reader") return new Promise(() => {});
    return Promise.resolve();
  }),
}));
import { CardReviewController } from "../../src/card-review/controller.js";
import { CardsReview, emptyUi, KEPT_LOOKUP, KeptCards, readingFor, NO_LOOKUP_VIEW, type LookupView } from "../src/cards-page.js";
import { CARD_NAMES_NEW, SOURCE, UNCLEAR_NOT_LOOKED_UP, type NameLookup } from "../src/card-lookup.js";
import { ALLOW_PEOPLE, CARDS_PEOPLE_TITLE, type PeopleAccess } from "../src/people-question.js";
import { SystemWordsContext, systemWords } from "../src/church-system.js";

const dom = installFakeDom();
const trap = vi.fn(() => { throw new Error("NETWORK_FORBIDDEN"); });
globalThis.fetch = trap as unknown as typeof fetch;
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const CHURCH = "1001";
const AT = Date.UTC(2026, 10, 22, 15, 42);
const RILEY = "Riley Fictional", FLO = "Flo901 Visitor";
const REQUEST = "Please call me about the youth group.";

async function review(names: string[], hard: boolean[] = []) {
  let n = 0;
  const controller = new CardReviewController("fictional-test", {
    foreground: () => true, createURL: () => `blob:fictional-${++n}`, revokeURL() {}, decode: async () => true,
  });
  const ticket = controller.choose(() => {})!;
  const files = names.map((_, i) => new File([PNG], `fictional-${i}.png`, { type: "image/png" }));
  expect(await controller.select(ticket, files)).toBe("ok");
  names.forEach((name, i) => {
    expect(controller.edit(ticket, { card: i + 1, field: "name", text: name, state: readingFor(name, hard[i] ?? false) })).toBe("ok");
  });
  controller.edit(ticket, { card: 1, field: "request", text: REQUEST, state: "typed" });
  return { controller, ticket };
}
const lookedUp = () => invoked.filter(([c]) => c === "look_up_card_name").map(([, a]) => a);
const settle = async () => { const { act } = await import("react"); for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); }); };
const noAccess: PeopleAccess = { start: async () => undefined, status: async () => null, cancel: async () => undefined };
type Props = Partial<Parameters<typeof KeptCards>[0]>;
async function mount(given: Awaited<ReturnType<typeof review>>, props: Props = {}) {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.root as unknown as Element);
  const draw = (more: Props = {}) => React.createElement(KeptCards, {
    check: null, example: false, inUse: CHURCH, disconnected: false, review: given, access: "allowed", shown: true, onScreen: true,
    openPerson: () => {}, peopleAccess: noAccess, ...props, ...more,
  });
  await act(async () => { root.render(draw()); });
  await settle();
  return {
    render: async (more: Props) => { await act(async () => { root.render(draw(more)); }); await settle(); },
    unmount: async () => { await act(async () => { root.unmount(); }); },
  };
}
/** The props React gave an element, to type into a field and leave it the way a person does. */
function field(id: string) {
  const all = (n: { childNodes: unknown[] }): unknown[] => [n, ...n.childNodes.flatMap(c => all(c as { childNodes: unknown[] }))];
  const el = all(dom.root as unknown as { childNodes: unknown[] }).find(n => (n as { getAttribute?: (a: string) => string | null }).getAttribute?.("id") === id);
  const key = el ? Object.keys(el).find(k => k.startsWith("__reactProps$")) : undefined;
  return (el as Record<string, { onChange: (e: unknown) => void; onBlur?: () => void }>)[key!]!;
}
afterEach(() => { invoked.length = 0; answer = async () => ({ result: "no-one" }); });

describe("looking each card's name up, as the page runs it", () => {
  it("goes out only while the cards are on this page and on screen, once per distinct name, and nowhere but the two native commands", async () => {
    answer = async name => name === RILEY ? { result: "people", people: [{ id: "50", name: RILEY }] } : { result: "no-one" };
    const r = await review([RILEY, FLO, "riley  fictional"]);
    // Another page shown: nothing is looked up.
    const page = await mount(r, { shown: false });
    expect(lookedUp()).toEqual([]);
    await page.render({ shown: true });
    expect(lookedUp()).toEqual([{ church: CHURCH, name: RILEY }, { church: CHURCH, name: FLO }]);
    expect(dom.seen()).toContain(`Same name in Planning Center: ${RILEY}`);
    expect(dom.seen()).toContain("Planning Center has a person with this name. It may be someone else with the same name.");
    expect(dom.seen()).toContain("Not found in Planning Center");
    expect(dom.seen()).toContain(SOURCE(AT).slice(0, "Looked up in Planning Center People at".length));
    // Look at these first names it, as a possible duplicate, never as the same person.
    expect(dom.seen()).toContain("Planning Center People has someone with a name like “Riley Fictional” (Riley Fictional). Worth a look");
    // Only the card reader's and the lookup's native commands, with only the church and the name; no network from the page.
    expect([...new Set(invoked.map(([c]) => c))].sort()).toEqual(["look_up_card_name", "prepare_card_reader"]);
    expect(JSON.stringify(lookedUp())).not.toContain(REQUEST);
    expect(trap).not.toHaveBeenCalled();
    await page.unmount();
  });

  it("stops what's under way when the window goes off screen, and asks again only after Show the cards", async () => {
    let release: (v: unknown) => void = () => {};
    answer = () => new Promise(resolve => { release = resolve; });
    const r = await review([RILEY]);
    const page = await mount(r);
    expect(lookedUp()).toHaveLength(1);
    await page.render({ onScreen: false });
    expect(invoked.some(([c]) => c === "cancel_card_name_lookups")).toBe(true);
    release({ result: "people", people: [{ id: "50", name: RILEY }] });
    await page.render({ onScreen: true });
    // Behind Show the cards: nothing about anyone, and nothing asked again.
    expect(dom.seen()).not.toContain(RILEY);
    expect(lookedUp()).toHaveLength(1);
    answer = async () => ({ result: "people", people: [{ id: "50", name: RILEY }] });
    const { act } = await import("react");
    await act(async () => { dom.press(dom.button("Show the cards")!); });
    await settle();
    expect(lookedUp()).toHaveLength(2);
    expect(dom.seen()).toContain(`Same name in Planning Center: ${RILEY}`);
    await page.unmount();
  });

  it("discarding the cards stops any lookup and drops everything it found", async () => {
    let release: (v: unknown) => void = () => {};
    answer = async name => name === RILEY ? { result: "people", people: [{ id: "50", name: RILEY }] } : new Promise(resolve => { release = resolve; });
    const r = await review([RILEY, FLO]);
    const page = await mount(r);
    expect(dom.seen()).toContain(`Same name in Planning Center: ${RILEY}`);
    const { act } = await import("react");
    await act(async () => { r.controller.discard(r.ticket); });
    await settle();
    expect(invoked.some(([c]) => c === "cancel_card_name_lookups")).toBe(true);
    release({ result: "people", people: [{ id: "51", name: FLO }] });
    await settle();
    expect(dom.seen()).not.toContain(RILEY);
    expect(dom.seen()).not.toContain("Planning Center People has");
    expect(lookedUp()).toHaveLength(2);
    await page.unmount();
  });

  it("a typed name is looked up once typing it is done, and a name marked hard to read isn't", async () => {
    const r = await review(["", "Avery Fictnal"], [false, true]);
    const page = await mount(r);
    expect(lookedUp()).toEqual([]);
    expect(dom.seen()).toContain(UNCLEAR_NOT_LOOKED_UP);
    const { act } = await import("react");
    await act(async () => { field("card-1-name").onChange({ target: { value: "Flo" } }); });
    await act(async () => { field("card-1-name").onChange({ target: { value: FLO } }); });
    await settle();
    expect(lookedUp()).toEqual([]);
    await act(async () => { field("card-1-name").onBlur!(); });
    await settle();
    expect(lookedUp()).toEqual([{ church: CHURCH, name: FLO }]);
    await page.unmount();
  });

  it("looks nothing up while the example is on, on another system, without People, or for another church", async () => {
    for (const props of [{ example: true }, { access: "other-system" as const }, { access: "not-allowed" as const }, { access: "unknown" as const },
      { disconnected: true, inUse: null }, { signInAgain: true, inUse: null }] as Props[]) {
      const r = await review([RILEY]);
      const page = await mount(r, props);
      expect(lookedUp(), JSON.stringify(props)).toEqual([]);
      await page.unmount();
    }
    // Without People, the page offers the same People question, asked for the cards.
    const r = await review([RILEY]);
    const page = await mount(r, { access: "not-allowed" });
    expect(dom.seen()).toContain("Your Planning Center connection doesn't include People yet.");
    const { act } = await import("react");
    await act(async () => { dom.press(dom.button(ALLOW_PEOPLE)!); });
    expect(dom.seen()).toContain(CARDS_PEOPLE_TITLE);
    expect(dom.button("Open it without an address")).toBeNull();
    // People allowed: the names are looked up.
    await page.render({ access: "allowed" });
    expect(lookedUp()).toEqual([{ church: CHURCH, name: RILEY }]);
    await page.unmount();
  });

  it("turning the example on drops every name Planning Center gave, and turning it off looks them up afresh (privacy review M1)", async () => {
    const MEMBER = "Riley Member";
    answer = async () => ({ result: "people", people: [{ id: "50", name: MEMBER }] });
    const r = await review([RILEY]);
    const page = await mount(r);
    expect(dom.seen()).toContain(MEMBER);
    expect(dom.seen()).toContain("Open in Planning Center");
    // On for a demo: nothing Planning Center said is on the cards, and no way to open anyone.
    await page.render({ example: true });
    for (const gone of [MEMBER, "Looked up in Planning Center People", "Planning Center People has", "Open in Planning Center"]) expect(dom.seen()).not.toContain(gone);
    expect(lookedUp()).toHaveLength(1);
    // Off again: the answer was dropped, not hidden, so the name is looked up afresh.
    await page.render({ example: false });
    expect(lookedUp()).toHaveLength(2);
    expect(dom.seen()).toContain(MEMBER);
    // The same for another church system.
    await page.render({ access: "other-system" });
    expect(dom.seen()).not.toContain(MEMBER);
    await page.render({ access: "allowed" });
    expect(lookedUp()).toHaveLength(3);
    // Names shown only while lookups can happen: not while Ozzie re-checks its sign-in either.
    await page.render({ access: "unknown" });
    expect(dom.seen()).not.toContain(MEMBER);
    expect(dom.seen()).not.toContain("Open in Planning Center");
    await page.unmount();
    // App gives no way to open anyone while the example is on.
    const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
    expect(app).toContain("openPerson={offPc || fictional ? null : id => { void openInPlanningCenter(\"person\", id); }}");
  });

  it("a switch to another church while a lookup is under way stops it, ends the cards and drops its answer", async () => {
    let release: (v: unknown) => void = () => {};
    answer = () => new Promise(resolve => { release = resolve; });
    const r = await review([RILEY]);
    const page = await mount(r);
    expect(lookedUp()).toEqual([{ church: CHURCH, name: RILEY }]);
    await page.render({ inUse: "2002" });
    expect(invoked.some(([c]) => c === "cancel_card_name_lookups")).toBe(true);
    release({ result: "people", people: [{ id: "50", name: RILEY }] });
    await page.render({ inUse: "2002" });
    // The cards ended with the switch; nothing about anyone, and nothing looked up for the other church.
    expect(dom.seen()).not.toContain(RILEY);
    expect(lookedUp()).toEqual([{ church: CHURCH, name: RILEY }]);
    await page.unmount();
  });

  it("says once, the first time cards are checked with lookups on, that names are now looked up and how to stop it (privacy review L5)", async () => {
    let seen = false, marked = 0;
    const notice = { seen: () => seen, see: () => { seen = true; marked++; } };
    // The example on: not said, and not counted as said.
    const first = await mount(await review([RILEY]), { example: true, notice });
    expect(dom.seen()).not.toContain(CARD_NAMES_NEW);
    expect(marked).toBe(0);
    await first.unmount();
    // Lookups on: said for this set of cards, and remembered (a flag only, never a name).
    const r = await review([RILEY]);
    const page = await mount(r, { notice });
    expect(dom.seen()).toContain(CARD_NAMES_NEW);
    expect(marked).toBe(1);
    expect(CARD_NAMES_NEW).toBe("New: while you check cards, Ozzie now looks up the name on each card in your church's Planning Center People, read-only, to show whether someone with that name is already there. Only the name goes, and only to Planning Center: nothing is added there, nothing goes to an AI, and nothing is kept after the cards end. To stop it, choose Connect again with Services only in Settings, under Rooms, follow-ups and group events; that also stops filling in To on notes, adding people to open roles, and the kids-team background-check reads.");
    // When these cards end says what was looked up ends with them.
    expect(dom.seen()).toContain(KEPT_LOOKUP);
    expect(KEPT_LOOKUP).toBe("While they're open, the name on each card is looked up in Planning Center People, read-only, and what Ozzie found ends with them.");
    const { act } = await import("react");
    await act(async () => { r.controller.discard(r.ticket); });
    await page.unmount();
    // The next set of cards: not said again.
    const again = await mount(await review([RILEY]), { notice });
    expect(dom.seen()).not.toContain(CARD_NAMES_NEW);
    expect(marked).toBe(1);
    await again.unmount();
    // Settings shows how to stop it whenever People is held, the reads on or off.
    const settings = readFileSync(new URL("../src/connection-page.tsx", import.meta.url), "utf8");
    expect(settings.match(/>Connect again with Services only<\/button>/gu)).toHaveLength(2);
    // The memory is a flag on this Mac only, outside the cards' code.
    const store = readFileSync(new URL("../src/card-names-notice.ts", import.meta.url), "utf8");
    expect(store).toContain('JSON.stringify({ seen: true })');
  });

  it("Planning Center refusing People says who can give it and stops asking", async () => {
    answer = async () => { throw "not-allowed"; };
    const r = await review([RILEY, FLO]);
    const page = await mount(r);
    expect(lookedUp()).toHaveLength(1);
    expect(dom.seen()).toContain("Planning Center didn't let Ozzie read People, so names on the cards aren't looked up.");
    await page.unmount();
  });
});

describe("what a card says", () => {
  const view = (found: Record<string, NameLookup>, more: Partial<LookupView> = {}): LookupView => ({ ...NO_LOOKUP_VIEW, availability: "on", found: n => found[n] ?? null, ...more });
  const shown = async (names: string[], lookup: LookupView, people: Record<string, string> = {}, system: "planning-center" | "b1" = "planning-center", noMatches: string | null = null) => {
    const { controller, ticket } = await review(names);
    return renderToStaticMarkup(React.createElement(SystemWordsContext.Provider, { value: systemWords(system) },
      React.createElement(CardsReview, { controller, ticket, ui: emptyUi, people, noMatches, lines: {}, onChoose() {}, onCopy() {}, onDiscard() {}, onSource() {}, onRemoved() {}, lookup })))
      .replace(/&#x27;/gu, "'").replace(/&quot;/gu, "\"").replace(/&amp;/gu, "&");
  };
  it("one person with the same name: who, that it may be someone else, where and when, and a way to open them", async () => {
    const html = await shown([RILEY], view({ [RILEY]: { state: "found", at: AT, people: [{ id: "50", name: RILEY }] } }, { openPerson: () => {} }),
      { "511": RILEY });
    expect(html).toContain(`Same name in Planning Center: ${RILEY}`);
    expect(html).toContain("It may be someone else with the same name.");
    expect(html).toContain(SOURCE(AT));
    expect(html).toContain(">Open in Planning Center<");
    // The badge on its own line above the heading, as on other finding cards (live test, 2026-11-23).
    expect(html).toContain(`Worth a look</span></div><p class="bold">Same name in Planning Center: ${RILEY}</p>`);
    // Planning Center's answer is said in place of the check's possible match: never two lines.
    expect(html).not.toContain("Possible match:");
  });
  it("none found, where the latest check has the same name: only the check's possible match, never a contradiction", async () => {
    const html = await shown([RILEY], view({ [RILEY]: { state: "none", at: AT } }), { "511": RILEY });
    expect(html).toContain("Possible match:");
    expect(html).not.toContain("Not found in Planning Center");
  });
  it("several, more than five, couldn't, and the page's lines", async () => {
    const several = await shown([RILEY], view({ [RILEY]: { state: "found", at: AT, people: [{ id: "50", name: RILEY }, { id: "52", name: RILEY }] } }, { openPerson: () => {} }));
    expect(several).toContain("Same name in Planning Center: 2 people");
    expect(several).toContain("Riley Fictional and Riley Fictional. Only the names match: any of them, or none, may be this person.");
    expect(several.match(/>Open Riley Fictional in Planning Center</gu)).toHaveLength(2);
    const more = await shown(["Riley"], view({ Riley: { state: "more", at: AT } }));
    expect(more).toContain("Similar names in Planning Center: more than 5 people");
    const couldnt = await shown([RILEY], view({ [RILEY]: { state: "not-checked", why: "could-not-check" } }));
    expect(couldnt).toContain("Ozzie couldn't look this name up in Planning Center just now.");
    expect(couldnt).toContain(">Look this name up again<");
    // While names are looked up, why the check offers none isn't said; when they aren't, it is, with why.
    const on = await shown([RILEY], view({}), {}, "planning-center", "Possible matches appear once Ozzie has run a check for the church it's using.");
    expect(on).not.toContain("Possible matches appear once");
    const example = await shown([RILEY], { ...NO_LOOKUP_VIEW, availability: "example" }, {}, "planning-center", "While the example is on, no names are offered as possible matches: its people are made up.");
    expect(example).toContain("While the example is on, no names are offered as possible matches: its people are made up.");
    expect(example).toContain("Names on the cards aren't looked up in Planning Center People either.");
    const disconnected = await shown([RILEY], { ...NO_LOOKUP_VIEW, availability: "not-connected" });
    expect(disconnected).toContain("Connect Planning Center to look up each card's name in Planning Center People.");
    const notAllowed = await shown([RILEY], { ...NO_LOOKUP_VIEW, availability: "not-allowed" });
    expect(notAllowed).toContain(`>${ALLOW_PEOPLE}<`);
  });
  it("on another church system: matching with Planning Center People only, said once", async () => {
    const html = await shown([RILEY], { ...NO_LOOKUP_VIEW, availability: "other-system" }, {}, "b1");
    expect(html).toContain("Looking up each card's name in Planning Center People works with Planning Center only for now. Ozzie can't do this with B1 Church yet.");
    expect(html).not.toContain("Not found in Planning Center");
  });
});
