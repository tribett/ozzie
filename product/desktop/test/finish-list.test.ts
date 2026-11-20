// "Finish setting up" on Today (onboarding spec §4.1): the items in order, only those that apply, one open at a time (the
// first not done), "Not now" collapses, "Hide this list" hides it for good and it never returns by itself, and done-ness
// comes from facts. Rendered as markup for each state, and mounted on the fake document (test/fake-dom.ts) to press.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { installFakeDom } from "./fake-dom.js";
import { text } from "./harness-fakes.js";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => new Promise(() => {})) }));
import { FinishSettingUp, finishItems, HIDDEN_LINE, openItem, START_FAILED_LINE, type FinishFacts } from "../src/finish-list.js";
import { finishStore, type KeyValue } from "../src/moments.js";
import { DayProvider, dayWords } from "../src/day-words.js";

const dom = installFakeDom();
const storage = (seed: Record<string, string> = {}) => {
  const map = new Map(Object.entries(seed));
  const kv: KeyValue = { getItem: k => map.get(k) ?? null, setItem: (k, v) => { map.set(k, v); } };
  return { map, store: finishStore(() => kv) };
};
/** Nothing left: start answered, nothing else applies. */
const SETTLED: FinishFacts = {
  start: { asked: true, on: true }, service: { deferred: false, watching: true }, kids: { looking: false, answered: true },
  ai: { left: false, chosen: true }, plan: { waiting: false, found: true },
};
const ALL_OPEN: FinishFacts = {
  start: { asked: false, on: false }, service: { deferred: true, watching: false }, kids: { looking: true, answered: false },
  ai: { left: true, chosen: false }, plan: { waiting: true, found: false, service: "Youth Night" },
};
const noop = () => {};
const props = (facts: FinishFacts, store = storage().store) => ({ facts, store, onStartWithMac: noop, onChooseService: noop, onKidsRules: noop, onChooseAi: noop });
const render = (facts: FinishFacts, extra: Partial<ReturnType<typeof props>> & { startFailed?: boolean } = {}) =>
  renderToStaticMarkup(React.createElement(FinishSettingUp, { ...props(facts), ...extra }));

describe("which items, in which order", () => {
  it("lists the spec's items in order, each only when it applies", () => {
    expect(finishItems({ ...SETTLED, start: { asked: false, on: false } }).map(i => i.id)).toEqual(["start"]);
    expect(finishItems({ ...SETTLED, ai: { left: true, chosen: false }, service: { deferred: true, watching: false } }).map(i => i.id)).toEqual(["start", "service", "ai"]);
    expect(finishItems({ ...SETTLED, kids: { looking: true, answered: false } }).map(i => [i.id, i.done])).toEqual([["start", true], ["kids", false]]);
    expect(finishItems(ALL_OPEN.plan.waiting ? { ...SETTLED, plan: ALL_OPEN.plan } : SETTLED).map(i => i.title))
      .toEqual(["Start Ozzie when this Mac starts", "Ozzie is waiting for the next plan"]);
  });

  it("shows at most four, letting done ones go first, then the last open ones", () => {
    expect(finishItems(ALL_OPEN).map(i => i.id)).toEqual(["start", "service", "kids", "ai"]);
    expect(finishItems({ ...ALL_OPEN, start: { asked: true, on: null } }).map(i => i.id)).toEqual(["service", "kids", "ai", "waiting"]);
  });

  it("computes done from facts: start once answered or already on; the others from what's true now", () => {
    const done = (f: FinishFacts) => Object.fromEntries(finishItems(f).map(i => [i.id, i.done]));
    expect(done({ ...SETTLED, start: { asked: false, on: true } }).start).toBe(true);
    expect(done({ ...SETTLED, start: { asked: true, on: false } }).start).toBe(true);
    expect(done({ ...SETTLED, start: { asked: false, on: null } }).start).toBe(false);
    expect(done({ ...SETTLED, service: { deferred: true, watching: true } }).service).toBe(true);
    expect(done({ ...SETTLED, ai: { left: true, chosen: true } }).ai).toBe(true);
    expect(done({ ...SETTLED, plan: { waiting: true, found: true } }).waiting).toBe(true);
  });

  it("opens the first item not done and not set aside", () => {
    const items = finishItems(ALL_OPEN);
    expect(openItem(items, [])).toBe("start");
    expect(openItem(items, ["start"])).toBe("service");
    expect(openItem(items, ["start", "service", "kids", "ai"])).toBeNull();
    expect(openItem(finishItems({ ...ALL_OPEN, start: { asked: true, on: false } }), [])).toBe("service");
  });
});

describe("the card", () => {
  it("is titled with a count and opens one item, the rest one line each", () => {
    const html = render({ ...ALL_OPEN, start: { asked: true, on: false }, plan: { waiting: false, found: false } });
    expect(text(html)).toMatch(/Finish setting up 1 of 4 done/u);
    expect(html.match(/class="finish-open"/gu)).toHaveLength(1);
    expect(html).toMatch(/<h3 class="finish-item-t" tabindex="-1">Choose which service Ozzie watches<\/h3>/u);
    // Done: a check mark and "done" for VoiceOver; collapsed: one line that opens it.
    expect(html).toContain("<span>Start Ozzie when this Mac starts</span><span class=\"sr-only\">, done</span>");
    expect(html.match(/aria-expanded="false"/gu)).toHaveLength(2);
    // Exactly one primary: the open item's.
    expect(html.match(/btn-primary/gu)).toHaveLength(1);
    expect(text(html)).toContain("Not now");
    expect(text(html)).toContain("Hide this list");
  });

  it("says item 1 of your services, whatever their day, and its two answers, Yes first", () => {
    const html = render(ALL_OPEN);
    expect(text(html)).toContain("Ozzie can only keep an eye on your services while it's running.");
    expect(text(html)).toMatch(/Yes, start Ozzie with this Mac No, I'll open it myself Not now/u);
    const wednesday = dayWords({ sort_date: "2026-11-25T19:00:00Z" }, null);
    const onWednesday = renderToStaticMarkup(React.createElement(DayProvider, { value: wednesday }, React.createElement(FinishSettingUp, props(ALL_OPEN))));
    expect(text(onWednesday)).toContain("Ozzie can only keep an eye on your services while it's running.");
    expect(onWednesday).not.toContain("Sunday");
    expect(render(ALL_OPEN, { startFailed: true })).toContain(`<p role="alert" class="problem finish-problem">${START_FAILED_LINE.replaceAll("'", "&#x27;")}</p>`);
  });

  it("names each item's one button, and the waiting item has none", () => {
    const only = (f: Partial<FinishFacts>) => text(render({ ...SETTLED, ...f }));
    expect(only({ service: { deferred: true, watching: false } })).toContain("Choose a service");
    expect(only({ kids: { looking: true, answered: false } })).toContain("Open Church rules");
    expect(only({ ai: { left: true, chosen: false } })).toMatch(/Choose how Ozzie uses AI .* Choose Not now/u);
    const waiting = render({ ...SETTLED, plan: { waiting: true, found: false, service: "Youth Night" } });
    expect(text(waiting)).toContain("When someone at your church makes the next Youth Night plan in Planning Center Services, Ozzie finds it by itself. It looks again every hour while it's open. If it's the only service with a plan, Ozzie starts watching it by itself; otherwise it asks you on Today.");
    expect(waiting).not.toContain("btn-primary");
  });

  it("isn't shown when nothing is left, or once hidden", () => {
    expect(render(SETTLED)).toBe("");
    const { store } = storage({ "ozzie.finish-list.v1": JSON.stringify({ hidden: true, notNow: [] }) });
    expect(render(ALL_OPEN, { store })).toBe("");
  });

  it("never names a person, scores anything or uses the words the app never says", () => {
    const words = text(render(ALL_OPEN)) + text(render({ ...ALL_OPEN, start: { asked: true, on: false } }));
    expect(words).not.toMatch(/\b(skills?|sessions?|agent|log|connector|harness|approve|block|risk|score)\b/iu);
  });
});

describe("pressing it", () => {
  async function mount(facts: FinishFacts, seed: Record<string, string> = {}) {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const s = storage(seed);
    const calls: string[] = [];
    const root = createRoot(dom.root as unknown as Element);
    const draw = (f: FinishFacts) => React.createElement(FinishSettingUp, {
      facts: f, store: s.store, onStartWithMac: yes => calls.push(`start:${yes}`), onChooseService: () => calls.push("service"),
      onKidsRules: () => calls.push("kids"), onChooseAi: () => calls.push("ai"),
    });
    await act(async () => { root.render(draw(facts)); });
    const press = async (label: string) => { const b = dom.button(label); if (!b) throw new Error(`no button ${label}: ${dom.seen()}`); await act(async () => { dom.press(b); }); };
    return { s, calls, press, rerender: (f: FinishFacts) => act(async () => { root.render(draw(f)); }), unmount: () => act(async () => { root.unmount(); }) };
  }

  it("Not now collapses the open item, opens the next, and is remembered", async () => {
    const m = await mount(ALL_OPEN);
    await m.press("Yes, start Ozzie with this Mac");
    expect(m.calls).toEqual(["start:true"]);
    await m.press("Not now");
    expect(m.s.store.get().notNow).toEqual(["start"]);
    expect(dom.seen()).toContain("Ozzie watches one service from your church's Planning Center.");
    expect(dom.seen()).not.toContain("Ozzie can only keep an eye on");
    await m.press("Choose a service");
    expect(m.calls).toEqual(["start:true", "service"]);
    await m.unmount();
  });

  it("a collapsed line opens when pressed, one at a time", async () => {
    const m = await mount(ALL_OPEN);
    await m.press("Choose how Ozzie uses AI");
    expect(dom.seen()).toContain("Everything else works without AI.");
    expect(dom.seen()).not.toContain("Ozzie can only keep an eye on");
    await m.press("Choose");
    expect(m.calls).toEqual(["ai"]);
    await m.unmount();
  });

  it("Hide this list hides it for good: it says so once, and never returns by itself", async () => {
    const m = await mount(ALL_OPEN);
    await m.press("Hide this list");
    expect(m.s.store.get().hidden).toBe(true);
    expect(dom.seen()).toContain(HIDDEN_LINE);
    expect(dom.button("Not now")).toBeNull();
    await m.unmount();
    // Next time Today opens, with new things to finish, still nothing.
    const again = await mount({ ...ALL_OPEN, kids: { looking: true, answered: false } }, { "ozzie.finish-list.v1": JSON.stringify({ hidden: true, notNow: [] }) });
    expect(dom.seen().trim()).toBe("");
    await again.unmount();
  });

  it("an item done since goes to a check mark, and the card leaves when all are done", async () => {
    const m = await mount({ ...SETTLED, start: { asked: false, on: false }, ai: { left: true, chosen: false } });
    expect(dom.seen()).toContain("0 of 2 done");
    await m.rerender({ ...SETTLED, start: { asked: true, on: true }, ai: { left: true, chosen: false } });
    expect(dom.seen()).toContain("1 of 2 done");
    expect(dom.seen()).toContain("Everything else works without AI.");
    await m.rerender({ ...SETTLED, ai: { left: true, chosen: true } });
    expect(dom.seen().trim()).toBe("");
    await m.unmount();
  });
});
