// Choosing the Sunday in setup from the upcoming plans. Fixed fictional data; the two native reads
// are mocked, and only their names and arguments are checked here (native sunday_picker.rs has its own tests).
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => ({ items: [], more: false })) }));
import { invoke } from "@tauri-apps/api/core";
import { choicesProblem, sundaySource, type Choices, type PlanChoice, type ServiceTypeChoice } from "../src/sunday-source.js";
import { planName, planWhen, serialReads, sundayChoices, SundayChoicesView, typeAfterLoad, withPlan, type Loaded, type PickerSource } from "../src/sunday-picker.js";
import { SetupFlow } from "../src/setup-flow.js";
import { DEFAULT_PREFS } from "../src/proactive.js";
import { text } from "./harness-fakes.js";

const NOW = "2026-11-20T15:00:00.000Z";
const settings = { clientId: "fictional-client", organization: "1001", serviceTypeId: "", planId: "" };
const types: Choices<ServiceTypeChoice> = { items: [{ id: "1500", name: "Sunday Morning" }, { id: "1502", name: null }], more: false };
const plans: Choices<PlanChoice> = { items: [
  { id: "92902197", sort_date: "2026-11-29T09:00:00Z", dates: "November 29, 2026", title: "Ozzie Demo — Main Sunday (fictional)", series_title: null },
  { id: "92902300", sort_date: "2026-12-06T09:00:00Z", dates: "December 6, 2026", title: null, series_title: "Advent" },
], more: true };
const ready = <T,>(value: Choices<T>): Loaded<T> => ({ state: "ready", value });
const view = (over: Partial<React.ComponentProps<typeof SundayChoicesView>> = {}) => renderToStaticMarkup(React.createElement(SundayChoicesView, {
  connected: true, settings, onSettings: () => {}, types: ready(types), typeId: "1500", onType: () => {}, plans: ready(plans),
  onRetry: () => {}, now: NOW, handOpen: false, onHand: () => {}, ...over,
}));

describe("the two reads behind the picker", () => {
  beforeEach(() => vi.mocked(invoke).mockClear());
  it("are the native list commands, with only a service type id to send", async () => {
    await sundaySource.serviceTypes();
    await sundaySource.upcomingPlans("1500");
    expect(vi.mocked(invoke).mock.calls).toEqual([["list_service_types"], ["list_upcoming_plans", { serviceTypeId: "1500" }]]);
  });
  it("explain a failure in fixed words, never Planning Center's or the Mac's own text", () => {
    expect(choicesProblem("not-connected")).toBe("Connect Planning Center first. Then your upcoming Sundays are listed here.");
    expect(choicesProblem({ "sunday-choices": "rate-limited" })).toContain("asked Ozzie to slow down");
    expect(choicesProblem({ "sunday-choices": "busy" })).toContain("Try again in a moment.");
    // A refused read says which access could be missing, who can give it and what next (audit item 5).
    expect(choicesProblem({ "sunday-choices": "denied" })).toBe("Planning Center didn't let Ozzie list your church's plans. Either the login you signed in with can't see Planning Center Services, or that sign-in is no longer accepted. A Planning Center administrator at your church can give your login access to Services; then sign in again. You can also enter a plan by hand.");
    expect(choicesProblem({ "sunday-choices": "organization-unverified" })).toContain("couldn't be verified");
    const odd = choicesProblem({ "sunday-choices": "provider-failure", detail: "Avery Brightwater <script>" });
    expect(odd).toBe("Planning Center couldn't be read just now. Try again, or enter the plan by hand.");
  });
});

describe("choosing a plan", () => {
  it("shows the chosen type's plans when it is listed, otherwise Planning Center's first type's", () => {
    expect(typeAfterLoad(types.items, "1502")).toBe("1502");
    expect(typeAfterLoad(types.items, "9999")).toBe("1500");
    expect(typeAfterLoad(types.items, "")).toBe("1500");
    expect(typeAfterLoad([], "1500")).toBe("");
  });
  it("keeps only the two ids, as typing them did", () => {
    expect(withPlan({ ...settings, serviceTypeId: "1", planId: "2" }, "1500", "92902197"))
      .toEqual({ clientId: "fictional-client", organization: "1001", serviceTypeId: "1500", planId: "92902197" });
  });
  it("names each plan by its Sunday on Planning Center's own clock, and its title and series", () => {
    expect(planWhen(plans.items[0]!, NOW)).toBe("Sunday, November 29 · 9:00 AM");
    expect(planWhen({ sort_date: "2027-01-03T10:30:00Z", dates: null }, NOW)).toBe("Sunday, January 3, 2027 · 10:30 AM");
    expect(planWhen({ sort_date: "soon", dates: "Easter" }, NOW)).toBe("Easter");
    expect(planName(plans.items[0]!)).toBe("Ozzie Demo — Main Sunday (fictional)");
    expect(planName(plans.items[1]!)).toBe("Advent");
    expect(planName({ title: "Communion", series_title: "Advent" })).toBe("Communion · Advent");
  });
});

describe("the picker on screen", () => {
  it("lists the service types and the upcoming plans as one group of choices, the chosen one selected", () => {
    const html = view({ settings: { ...settings, serviceTypeId: "1500", planId: "92902197" } });
    const t = text(html);
    expect(html).toMatch(/<label[^>]*>Service type<\/label><select[^>]*>.*<option value="1500"[^>]*>Sunday Morning<\/option><option value="1502"[^>]*>Service type 1502<\/option>/u);
    expect(html).toMatch(/<fieldset class="picker-plans"><legend class="field-l">Upcoming plans<\/legend>/u);
    expect(html.match(/type="radio"/gu)).toHaveLength(2);
    expect(html).toMatch(/<label class="choice is-sel"><input type="radio"[^>]*checked=""/u);
    expect(t).toContain("Sunday, November 29 · 9:00 AM Ozzie Demo — Main Sunday (fictional)");
    expect(t).toContain("Sunday, December 6 · 9:00 AM Advent");
    expect(t).toContain("Showing the next 2. A later Sunday can be entered by hand below.");
    expect(t).not.toContain("Chosen now");
    // Typing the ids is still there, folded away.
    expect(html).toMatch(/<details class="picker-hand"><summary>.*Enter the plan by hand<\/summary>/u);
    expect(t).toContain("Service type ID");
  });
  it("says what is happening at each step, and what to do when nothing can be listed", () => {
    expect(text(view({ connected: false, types: { state: "idle" }, plans: { state: "idle" }, handOpen: true })))
      .toContain("Connect Planning Center first. Then your upcoming Sundays are listed here to choose from.");
    expect(view({ connected: false, types: { state: "idle" }, plans: { state: "idle" }, handOpen: true })).toMatch(/<details class="picker-hand" open="">/u);
    expect(text(view({ types: { state: "loading" }, plans: { state: "idle" } }))).toContain("Reading your service types from Planning Center…");
    expect(text(view({ plans: { state: "loading" } }))).toContain("Reading upcoming plans…");
    expect(text(view({ types: ready({ items: [types.items[0]!], more: false }) }))).toMatch(/Service type Sunday Morning Upcoming plans/u);
    expect(text(view({ types: ready({ items: [], more: false }), plans: { state: "idle" } }))).toContain("Planning Center shows no service types this account can see.");
    expect(text(view({ plans: ready({ items: [], more: false }) }))).toContain("No upcoming plans in this service type. Choose another, or enter the plan by hand below.");
    const problem = text(view({ types: { state: "problem", text: choicesProblem("denied") }, plans: { state: "idle" } }));
    expect(problem).toContain("Planning Center didn't let Ozzie list your church's plans.");
    expect(problem).toContain("Try again");
    expect(text(view({ settings: { ...settings, serviceTypeId: "1500", planId: "92900001" } }))).toContain("Chosen now: a plan entered by hand. It isn't in this list.");
  });
  it("is the Sunday step of guided setup, with the fields for typing the ids kept", () => {
    const step = (connected: boolean) => text(renderToStaticMarkup(React.createElement(SetupFlow, {
      status: connected ? { state: "connected", organization: "1001", checked_at_ms: Date.UTC(2026, 10, 20, 15), source: "", problem: null } : null,
      settings, onSettings() {}, onStatus() {}, prefs: DEFAULT_PREFS, onModel() {}, onClose() {}, onExample() {}, onAutomatic() {}, initial: "sunday",
    })));
    expect(step(false)).toContain("Choose it from your upcoming plans");
    expect(step(false)).toContain("Connect Planning Center first.");
    expect(step(false)).toContain("Enter the plan by hand");
    expect(step(true)).not.toContain("Connect Planning Center first.");
    expect(step(true)).toContain("Paste the plan's address (optional)");
  });
});

/** A native side that, like the real controller, refuses a second read while one is in flight. Each read waits to be settled by the test. */
function nativeReads() {
  const calls: string[] = [];
  const open: { name: string; resolve: (value: unknown) => void; reject: (error: unknown) => void }[] = [];
  let busy = false;
  const read = <T,>(name: string) => {
    calls.push(name);
    if (busy) return Promise.reject<T>({ "sunday-choices": "busy" });
    busy = true;
    return new Promise<T>((resolve, reject) => open.push({
      name, resolve: value => { busy = false; resolve(value as T); }, reject: error => { busy = false; reject(error); },
    }));
  };
  const source: PickerSource = { serviceTypes: () => read("types"), upcomingPlans: id => read(`plans:${id}`) };
  /** Settles the read in flight, which must be `name`. */
  const settle = async (name: string, value: unknown, failed = false) => {
    const next = open.shift();
    expect(next?.name).toBe(name);
    if (failed) next!.reject(value); else next!.resolve(value);
    await flush();
  };
  return { source, calls, settle, pending: () => open.map(o => o.name) };
}
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const plansOf = (id: string): Choices<PlanChoice> => ({ items: [{ id: `${id}01`, sort_date: "2026-11-29T09:00:00Z", dates: null, title: `Plans of ${id}`, series_title: null }], more: false });
const shown = (choices: ReturnType<typeof sundayChoices>) => {
  const v = choices.view();
  return { types: v.types.state === "ready" ? v.types.value.items.map(t => t.id) : v.types.state, typeId: v.typeId,
    plans: v.plans.state === "ready" ? v.plans.value.items.map(p => p.title) : v.plans.state === "problem" ? v.plans.text : v.plans.state };
};

describe("the picker's reads never trip over each other", () => {
  it("reads once when React runs the connect effect twice in development", async () => {
    const native = nativeReads();
    const choices = sundayChoices(native.source, "", true, serialReads());
    choices.connect(true);
    choices.connect(true);
    await flush();
    expect(native.calls).toEqual(["types"]);
    await native.settle("types", types);
    expect(native.pending()).toEqual(["plans:1500"]);
    await native.settle("plans:1500", plansOf("1500"));
    expect(shown(choices)).toEqual({ types: ["1500", "1502"], typeId: "1500", plans: ["Plans of 1500"] });
    expect(native.calls).toEqual(["types", "plans:1500"]);
  });
  it("starts a second read only once the first is done, so the native side never answers busy", async () => {
    const native = nativeReads();
    const queue = serialReads();
    // Two pickers at once (a remount while the first still reads) share one queue.
    const first = sundayChoices(native.source, "", true, queue);
    const second = sundayChoices(native.source, "1502", true, queue);
    first.connect(true);
    second.connect(true);
    await flush();
    expect(native.pending()).toEqual(["types"]);
    await native.settle("types", types);
    expect(native.pending()).toEqual(["types"]);
    await native.settle("types", types);
    await native.settle("plans:1500", plansOf("1500"));
    await native.settle("plans:1502", plansOf("1502"));
    expect(shown(first).plans).toEqual(["Plans of 1500"]);
    expect(shown(second).plans).toEqual(["Plans of 1502"]);
    expect(native.calls.length).toBe(4);
  });
  it("Try again while a read is in flight waits for it, ignores its result, and shows the new one", async () => {
    const native = nativeReads();
    const choices = sundayChoices(native.source, "", true, serialReads());
    choices.connect(true);
    await flush();
    choices.retry();
    await flush();
    expect(native.pending()).toEqual(["types"]);
    // The first answer is stale now; the retried read follows it.
    await native.settle("types", { items: [{ id: "1400", name: "Old" }], more: false });
    expect(shown(choices).types).toBe("loading");
    await native.settle("types", types);
    await native.settle("plans:1500", plansOf("1500"));
    expect(shown(choices)).toEqual({ types: ["1500", "1502"], typeId: "1500", plans: ["Plans of 1500"] });
    expect(native.calls).toEqual(["types", "types", "plans:1500"]);
  });
  it("Try again after a problem reads both lists again", async () => {
    const native = nativeReads();
    const choices = sundayChoices(native.source, "1500", true, serialReads());
    choices.connect(true);
    await flush();
    await native.settle("types", types);
    await native.settle("plans:1500", { "sunday-choices": "rate-limited" }, true);
    expect(shown(choices).plans).toContain("asked Ozzie to slow down");
    expect(choices.view().handOpen).toBe(true);
    choices.retry();
    await flush();
    await native.settle("types", types);
    await native.settle("plans:1500", plansOf("1500"));
    expect(shown(choices).plans).toEqual(["Plans of 1500"]);
  });
  it("choosing another service type mid-read shows that type's plans, never the earlier one's", async () => {
    const native = nativeReads();
    const choices = sundayChoices(native.source, "1500", true, serialReads());
    choices.connect(true);
    await flush();
    await native.settle("types", types);
    expect(native.pending()).toEqual(["plans:1500"]);
    choices.chooseType("1502");
    choices.chooseType("1500");
    choices.chooseType("1502");
    await flush();
    expect(shown(choices)).toMatchObject({ typeId: "1502", plans: "loading" });
    await native.settle("plans:1500", plansOf("1500"));
    expect(shown(choices).plans).toBe("loading");
    // Only the latest choice is read; the ones it replaced before their turn are never sent.
    await native.settle("plans:1502", plansOf("1502"));
    expect(shown(choices)).toEqual({ types: ["1500", "1502"], typeId: "1502", plans: ["Plans of 1502"] });
    expect(native.calls).toEqual(["types", "plans:1500", "plans:1502"]);
  });
  it("disconnecting mid-read drops what was being read", async () => {
    const native = nativeReads();
    const choices = sundayChoices(native.source, "", true, serialReads());
    choices.connect(true);
    await flush();
    choices.connect(false);
    await native.settle("types", types);
    expect(shown(choices)).toEqual({ types: "idle", typeId: "", plans: "idle" });
    expect(native.calls).toEqual(["types"]);
  });
  it("tells subscribers when what is shown changes", async () => {
    const native = nativeReads();
    const choices = sundayChoices(native.source, "", false, serialReads());
    expect(choices.view().handOpen).toBe(true);
    let seen = 0;
    const stop = choices.subscribe(() => { seen += 1; });
    choices.connect(true);
    expect(seen).toBe(1);
    stop();
    await flush();
    await native.settle("types", types);
    expect(seen).toBe(1);
  });
});
