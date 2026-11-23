// What else Ozzie can check (onboarding decision 24, spec §4.4): after the first check of a church connected with
// Services only, one calm, optional offer of the checks that need Calendar, People and Groups, on the service's page and
// as the last item of Today's "Finish setting up". Each state on fixed, fictional data: Services only (the offer), held
// with the reads off (the switch only), dismissed (gone, and still gone after a relaunch), granted (gone, and the rooms
// and follow-ups sections render), refused by Planning Center (its words, with a message for the administrator). The
// sign-in is Settings' own: the same native command with the same arguments.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ calls: [] as { command: string; args: Record<string, unknown> }[], reads: false as boolean | null }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args: Record<string, unknown> = {}) => {
    native.calls.push({ command, args });
    switch (command) {
      case "planning_center_app": return true;
      case "connect_planning_center_app": case "connect_planning_center":
        return { state: "waiting", organization: "1001", checked_at_ms: null, source: "", problem: null };
      case "set_operations_reads": native.reads = args.on === true; return native.reads;
      case "operations_reads": return native.reads;
      case "cancel_connection": return null;
      default: return new Promise(() => {});
    }
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
import { installFakeDom } from "./fake-dom.js";
import { text } from "./harness-fakes.js";
import {
  MORE_AGAIN, MORE_BUTTON, MORE_CHECK, MORE_HIDDEN, MORE_HIDE, MORE_LEAD, MORE_LOST, MORE_NOT_NOW, MORE_PEOPLE_TO, moreAccess, moreHeld, moreTitle, productsAdminMessage, ReadMore,
  readMoreNeed, readMoreStore, refusedProducts, type ReadMoreNeed,
} from "../src/read-more.js";
import { resetOperationsReads, useOperationsReads, wantedAfter } from "../src/operations-reads.js";
import { ADMIN_COPY } from "../src/sunday-source.js";
import { ConnectionPage } from "../src/connection-page.js";
import { finishItems, FinishSettingUp, openItem, type FinishFacts } from "../src/finish-list.js";
import { finishStore, type KeyValue } from "../src/moments.js";
import { DayProvider } from "../src/day-words.js";
import { promise } from "../src/promises.js";
import { CARD_NAMES_READ, PEOPLE_ENDS, PEOPLE_READS, PEOPLE_TO_READ, PEOPLE_WAITING } from "../src/people-question.js";
import type { ConnectionStatus } from "../src/connection.js";
import { SundayPage } from "../src/sunday-page.js";
import { buildSundayBrief } from "../../../core/src/sunday-brief.js";
import { sundayOperations } from "../../../core/src/operations-capture.js";
import { nov22Capture } from "../../../core/src/fictional-sunday.js";
import { withFictionalOperations, withFictionalOperationsOff } from "../../../core/src/fictional-operations.js";
import type { SundayCapture, SundayRules } from "../../../core/src/sunday-capture.js";
import { wednesdayWords } from "../../../core/test/fixtures/service-days/wednesday.js";

const dom = installFakeDom();
const SETTINGS = { clientId: "", organization: "1001", serviceTypeId: "1500", planId: "92902197" };
const RULES: SundayRules = { sundayLeads: [], checkInAfterSundaysInARow: 3 };
const at = (scopes?: ConnectionStatus["scopes"], extra: Partial<ConnectionStatus> = {}): ConnectionStatus => ({
  state: "connected", organization: "1001", checked_at_ms: 1, source: "native", problem: null, ...(scopes ? { scopes } : {}), ...extra,
});
const SERVICES = at("services");
const GRANTED = at("services-and-operations");
const WAITING: ConnectionStatus = { state: "waiting", organization: "1001", checked_at_ms: null, source: "", problem: null };
/** The words a person should never have to know (AGENTS.md), and anything that says a problem was found before a read. */
const FORBIDDEN = /\b(?:skills?|sessions?|agents?|logs?|connectors?|harness|approve|block)\b/iu;
const ALARM = /\b(?:conflicts?|problems?|issues?|risk|at risk|missing|gaps?|wrong|may be|might be|could be)\b/iu;

const memory = (seed: Record<string, string> = {}) => {
  const map = new Map(Object.entries(seed));
  const kv: KeyValue = { getItem: k => map.get(k) ?? null, setItem: (k, v) => { map.set(k, v); } };
  return { map, store: readMoreStore(() => kv), finish: finishStore(() => kv) };
};
const html = (need: ReadMoreNeed | null, place: "service" | "today" = "service", extra: Record<string, unknown> = {}, words = wednesdayWords()) => {
  const m = memory();
  return renderToStaticMarkup(React.createElement(DayProvider, { value: words }, React.createElement(ReadMore, {
    need, place, status: SERVICES, settings: SETTINGS, onStatus: () => {}, church: "Fictional Grace Church", oneClick: true, store: m.store, finish: m.finish, ...extra,
  })));
};

beforeEach(() => { native.calls = []; native.reads = false; resetOperationsReads(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("when it is offered", () => {
  it("only after a check of the church's own service, with a connection checked this session, until it's hidden", () => {
    expect(readMoreNeed({ status: SERVICES, readsOn: false, checked: true, hidden: false })).toBe("sign-in");
    // The access held (People allowed for a note's To line) with the reads off: only the switch, no new sign-in.
    expect(readMoreNeed({ status: GRANTED, readsOn: false, checked: true, hidden: false })).toBe("switch");
    // Granted and on: nothing to offer.
    expect(readMoreNeed({ status: GRANTED, readsOn: true, checked: true, hidden: false })).toBeNull();
    // Native couldn't say whether the reads are on: nothing is offered rather than a guess.
    expect(readMoreNeed({ status: GRANTED, readsOn: null, checked: true, hidden: false })).toBeNull();
    // Before the first check (first run included), never.
    expect(readMoreNeed({ status: SERVICES, readsOn: false, checked: false, hidden: false })).toBeNull();
    // Hidden for good.
    expect(readMoreNeed({ status: SERVICES, readsOn: false, checked: true, hidden: true })).toBeNull();
    // The access isn't known until the connection was checked this session; nor while signing in or disconnected.
    expect(readMoreNeed({ status: at(), readsOn: false, checked: true, hidden: false })).toBeNull();
    expect(readMoreNeed({ status: WAITING, readsOn: false, checked: true, hidden: false })).toBeNull();
    expect(readMoreNeed({ status: null, readsOn: false, checked: true, hidden: false })).toBeNull();
    expect(readMoreNeed({ status: { ...SERVICES, state: "disconnected" }, readsOn: false, checked: true, hidden: false })).toBeNull();
  });
});

describe("the reads on, the access gone after a sign-in (review 2026-11-18, late)", () => {
  // Settings' Connect again used to ask for Services alone; and Planning Center lets an administrator narrow what a
  // sign-in is given. Either way the switch still says on while Calendar, People and Groups aren't held: said once,
  // plainly, where the offer would be, never the first-time offer as if nothing happened.
  it("is its own need: never the first-time offer", () => {
    expect(readMoreNeed({ status: SERVICES, readsOn: true, checked: true, hidden: false })).toBe("lost");
    expect(readMoreNeed({ status: at("services+check-ins+registrations"), readsOn: true, checked: true, hidden: false })).toBe("lost");
    // Off, or native couldn't say: the offer as before.
    expect(readMoreNeed({ status: SERVICES, readsOn: false, checked: true, hidden: false })).toBe("sign-in");
    expect(readMoreNeed({ status: SERVICES, readsOn: null, checked: true, hidden: false })).toBe("sign-in");
    // Hidden for good, or before the first check: nothing here (Settings still says it).
    expect(readMoreNeed({ status: SERVICES, readsOn: true, checked: true, hidden: true })).toBeNull();
    expect(readMoreNeed({ status: SERVICES, readsOn: true, checked: false, hidden: false })).toBeNull();
  });
  it("says what happened in one sentence, with the way to allow it again and a message for the administrator", () => {
    expect(MORE_LOST).toBe("Your last Planning Center sign-in didn't include Calendar, People and Groups, so Ozzie can't check rooms, follow-ups and group events until they're allowed again.");
    for (const place of ["service", "today"] as const) {
      const t = text(html("lost", place));
      expect(t).toContain(MORE_LOST);
      expect(t).not.toContain(MORE_LEAD);
      expect(t).not.toContain("Check the rooms booked for");
      expect(t).toContain(moreAccess());
      expect(t).toContain(ADMIN_COPY);
      // Its button names what the person does: allowing again what the church had, not the first-time offer's.
      expect(MORE_AGAIN).toBe("Allow Calendar, People and Groups again in my browser");
      expect(t).toContain(MORE_AGAIN);
      expect(t).not.toContain(MORE_BUTTON);
      expect(t).not.toMatch(FORBIDDEN);
    }
    // A status, said once: no "Not now" to fold it, only "Don't show this again".
    expect(text(html("lost", "service"))).toContain(MORE_HIDE);
    expect(text(html("lost", "service"))).not.toContain(MORE_NOT_NOW);
  });
  it("isn't folded away by an earlier Not now for the offer (review 2026-11-19)", () => {
    const m = memory({ "ozzie.finish-list.v1": JSON.stringify({ notNow: ["more"] }) });
    const folded = (need: ReadMoreNeed) => text(renderToStaticMarkup(React.createElement(DayProvider, { value: wednesdayWords() }, React.createElement(ReadMore, {
      need, place: "service", status: SERVICES, settings: SETTINGS, onStatus: () => {}, church: "Fictional Grace Church", oneClick: true, store: m.store, finish: m.finish,
    }))));
    expect(folded("sign-in")).not.toContain(MORE_LEAD);
    expect(folded("lost")).toContain(MORE_LOST);
  });
  it("after a church switch, the earlier church's switch is never taken for the new one's (review 2026-11-19)", async () => {
    native.reads = true;
    const m = await mount(memory(), SERVICES, {});
    expect(text(dom.seen())).toContain(MORE_LOST);
    // Another church, Services only, whose own switch native hasn't answered yet: nothing is said about its access.
    native.reads = null;
    let answer: (v: boolean) => void = () => {};
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockImplementationOnce(async (command: string) => {
      native.calls.push({ command, args: {} });
      return new Promise(r => { answer = r as (v: boolean) => void; });
    });
    await m.show(at("services", { organization: "2002" }));
    expect(text(dom.seen())).not.toContain(MORE_LOST);
    answer(false);
    await m.show(at("services", { organization: "2002" }));
    expect(text(dom.seen())).toContain(MORE_LEAD);
    await m.unmount();
  });
  it("Settings' granted line says the same, and nothing else does while the reads are off", async () => {
    const { grantedCopy } = await import("../src/connection-page.js");
    expect(grantedCopy(SERVICES, true)).toBe(`Granted: Services only. ${MORE_LOST}`);
    expect(grantedCopy(SERVICES, false)).toBe("Granted: Services only. Rooms, follow-ups and group events aren't checked.");
    expect(grantedCopy(SERVICES, null)).toBe("Granted: Services only. Rooms, follow-ups and group events aren't checked.");
    expect(grantedCopy(GRANTED, true)).toBe("Granted: Services, Calendar, People and Groups. Ozzie reads rooms, follow-ups and group events.");
  });
  it("pressing it asks for the access as the offer does", async () => {
    native.reads = true;
    const m = await mount(memory(), SERVICES, {});
    expect(text(dom.seen())).toContain(MORE_LOST);
    await m.press(MORE_AGAIN);
    expect(native.calls.filter(c => c.command === "connect_planning_center_app").map(c => c.args)).toEqual([{ operations: true, purpose: "operations" }]);
    await m.unmount();
  });
});

describe("Services only: the offer", () => {
  it("says what else Ozzie can check and what each needs, in the church's own day words, with the promises", () => {
    const h = html("sign-in");
    const t = text(h);
    expect(t).toContain(moreTitle("Fictional Grace Church"));
    expect(t).toContain("What else Ozzie can check for Fictional Grace Church");
    expect(t).toContain(MORE_LEAD);
    expect(t).toContain("Right now Ozzie doesn't read Calendar, People or Groups in your church's Planning Center. With them, it could also:");
    expect(t).toContain("Check the rooms booked for Wednesday for times that overlap: needs Planning Center Calendar.");
    expect(t).toContain("Find follow-ups that are past due with no one assigned: needs Planning Center People.");
    expect(t).toContain("Check that each person scheduled on a team you mark as serving with kids has a current background check on file: needs Planning Center People.");
    expect(t).toContain("Notice when someone scheduled to serve has a group meeting at the same time: needs Planning Center Groups.");
    // One consent for all three, said plainly, with reads-only and names-stay-here from promises.ts.
    expect(t).toContain(moreAccess());
    expect(t).toContain("Planning Center gives Calendar, People and Groups together, in one sign-in in your browser, and words them as read-and-write.");
    expect(t).toContain(promise("connectAnd"));
    expect(t).toContain(promise("names"));
    // People's other read, said where it is first allowed, in the To sheet's own tested sentences (review L8).
    expect(t).toContain(MORE_PEOPLE_TO);
    // Both of People's other reads, in the People sheet's own sentences (owner decision 2026-11-23: the names on visitor cards).
    expect(MORE_PEOPLE_TO).toBe(`With People, Ozzie also fills in To on a note and looks up the names on visitor cards. ${PEOPLE_TO_READ} ${CARD_NAMES_READ}`);
    expect(PEOPLE_READS.startsWith(`${PEOPLE_TO_READ} ${CARD_NAMES_READ} `)).toBe(true);
    expect(t).toContain(MORE_BUTTON);
    expect(t).toContain("Not now");
    expect(t).toContain(MORE_HIDE);
    // A Wednesday church is never told about Sunday; nothing says a problem was found; no forbidden words.
    expect(t).not.toContain("Sunday");
    expect(t.replace(MORE_PEOPLE_TO, "")).not.toMatch(ALARM);
    expect(t).not.toMatch(FORBIDDEN);
    // Calm on the service's page: the page's own "Check Planning Center now" stays its one primary button.
    expect(h).not.toContain("btn-primary");
    // Not a finding: no decision or Worth a look badge.
    expect(t).not.toMatch(/Needs a decision|Worth a look/u);
  });

  it("names the church when it can, and says your church when it can't; a weekend church gets its own words", () => {
    expect(text(html("sign-in", "service", { church: null }))).toContain("What else Ozzie can check for your church");
    const weekend = { ...wednesdayWords(), kind: "weekend" as const, weekday: null, day: "this weekend's services", page: "This weekend", thisOne: "this weekend" };
    expect(text(html("sign-in", "service", {}, weekend))).toContain("Check the rooms booked for this weekend for times that overlap");
  });

  it("on Today it is the Finish list's item body: no title of its own, no own Not now, the list's one primary", () => {
    const h = html("sign-in", "today");
    const t = text(h);
    expect(t).not.toContain("What else Ozzie can check for");
    expect(t).not.toContain("Not now");
    expect(t).not.toContain(MORE_HIDE);
    expect(h).toMatch(/class="btn btn-primary"[^>]*>Let Ozzie read more in Planning Center<\/button>/u);
  });

  it("with the access already held and the reads off, needs no new sign-in and doesn't offer what is read already", () => {
    const t = text(html("switch", "service", { status: GRANTED }));
    expect(t).toContain(moreHeld());
    expect(t).toContain("Your connection already includes Calendar, People and Groups, so this needs no new sign-in.");
    // Background checks need People only, so they are read already; To is filled in already.
    expect(t).not.toContain("background check");
    expect(t).not.toContain(MORE_PEOPLE_TO);
    expect(t).not.toContain(MORE_LEAD);
    expect(t).toContain("Check the rooms booked for Wednesday");
  });

  it("is Finish setting up's last item, offered and then done; never there when it isn't offered", () => {
    const SETTLED: FinishFacts = {
      start: { asked: true, on: true }, service: { deferred: false, watching: true }, kids: { looking: false, answered: true },
      ai: { left: false, chosen: true }, plan: { waiting: false, found: true },
    };
    expect(finishItems(SETTLED).map(i => i.id)).toEqual(["start"]);
    expect(finishItems({ ...SETTLED, more: { offered: false, done: false } }).map(i => i.id)).toEqual(["start"]);
    expect(finishItems({ ...SETTLED, more: { offered: true, done: false } }).map(i => [i.id, i.title, i.done]))
      .toEqual([["start", "Start Ozzie when this Mac starts", true], ["more", "Choose what else Ozzie checks", false]]);
    expect(finishItems({ ...SETTLED, more: { offered: true, done: true } }).find(i => i.id === "more")?.done).toBe(true);
    // With four open before it, it is the one that waits.
    const ALL: FinishFacts = { start: { asked: false, on: false }, service: { deferred: true, watching: false }, kids: { looking: true, answered: false },
      ai: { left: true, chosen: false }, plan: { waiting: false, found: false }, more: { offered: true, done: false } };
    expect(finishItems(ALL).map(i => i.id)).toEqual(["start", "service", "kids", "ai"]);
    // Rendered open with its body when it is the first not done.
    const card = renderToStaticMarkup(React.createElement(FinishSettingUp, {
      facts: { ...SETTLED, more: { offered: true, done: false } }, onStartWithMac: () => {}, onChooseService: () => {}, onKidsRules: () => {}, onChooseAi: () => {},
      moreBody: React.createElement("p", null, "the offer"), store: memory().finish,
    }));
    expect(card).toMatch(/<h3 class="finish-item-t" tabindex="-1">Choose what else Ozzie checks<\/h3><p>the offer<\/p>/u);
  });
});

// Mounted on the fake document, with a stand-in for App: the offer's need comes from native's switch and the status,
// as App works it out, and the status changes as native's would.
type Mounted = { show: (status: ConnectionStatus | null, more?: Record<string, unknown>) => Promise<void>; press: (label: string) => Promise<void>; unmount: () => Promise<void> };
async function mount(m = memory(), first: ConnectionStatus | null = SERVICES, more: Record<string, unknown> = {}): Promise<Mounted> {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.root as unknown as Element);
  function Page({ status, extra }: { status: ConnectionStatus | null; extra: Record<string, unknown> }) {
    const reads = useOperationsReads(status);
    const need = readMoreNeed({ status, readsOn: reads.on, checked: true, hidden: m.store.hidden() });
    return React.createElement(ReadMore, { need, place: "service", status, settings: SETTINGS, onStatus: () => {}, church: "Fictional Grace Church", oneClick: true,
      store: m.store, finish: m.finish, onCheck: () => {}, ...extra });
  }
  const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };
  const show = async (status: ConnectionStatus | null, extra: Record<string, unknown> = more) => {
    await act(async () => { root.render(React.createElement(Page, { status, extra })); });
    await settle();
  };
  await show(first);
  return {
    show,
    press: async (label: string) => {
      const b = dom.button(label);
      if (!b) throw new Error(`no "${label}" in: ${dom.seen()}`);
      await act(async () => { dom.press(b); });
      await settle();
    },
    unmount: async () => { await act(async () => { root.unmount(); }); },
  };
}
const sent = (command: string) => native.calls.filter(c => c.command === command).map(c => c.args);

describe("pressing it: Settings' own sign-in", () => {
  it("asks Planning Center for Calendar, People and Groups with the same command and arguments as Settings", async () => {
    const page = await mount();
    await page.press(MORE_BUTTON);
    const offer = sent("connect_planning_center_app");
    // Said to be for these reads, so native lets only this sign-in's grant turn them on (review M1).
    expect(offer).toEqual([{ operations: true, purpose: "operations" }]);
    await page.unmount();
    // Settings' "Also check rooms, follow-ups and group events", on the same connection.
    native.calls = [];
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(dom.root as unknown as Element);
    await act(async () => { root.render(React.createElement(ConnectionPage, { status: SERVICES, settings: SETTINGS, onSettings: () => {}, onStatus: () => {}, oneClick: true, phone: null })); });
    const b = dom.button("Also check rooms, follow-ups and group events")!;
    await act(async () => { dom.press(b); await new Promise(r => setTimeout(r, 0)); });
    expect(sent("connect_planning_center_app")).toEqual(offer);
    await act(async () => { root.unmount(); });
  });

  it("keeps the Check-Ins and Registrations the connection has, and a registration typed for a copy built at home", async () => {
    const page = await mount(memory(), at("services+check-ins"));
    await page.press(MORE_BUTTON);
    expect(sent("connect_planning_center_app")).toEqual([{ operations: true, checkIns: true, purpose: "operations" }]);
    await page.unmount();
    native.calls = []; resetOperationsReads();
    // A registration typed under "For a copy of Ozzie you built yourself": the same call Settings makes with it.
    const own = await mount(memory(), SERVICES, { settings: { ...SETTINGS, clientId: "fictional-client" } });
    await own.press(MORE_BUTTON);
    expect(sent("connect_planning_center_app")).toEqual([]);
    expect(sent("connect_planning_center")).toEqual([{ clientId: "fictional-client", organization: "1001", registered: true, operations: true, purpose: "operations" }]);
    await own.unmount();
  });

  it("waits with the person, then, granted, turns the reads on and says they start at the next check", async () => {
    const page = await mount();
    await page.press(MORE_BUTTON);
    await page.show(WAITING);
    expect(dom.seen()).toContain(PEOPLE_WAITING);
    expect(dom.button("Cancel")).not.toBeNull();
    expect(dom.button(MORE_BUTTON)).toBeNull();
    expect(sent("set_operations_reads")).toEqual([]);
    await page.show(GRANTED);
    expect(sent("set_operations_reads")).toEqual([{ on: true, pressed: false }]);
    expect(dom.seen()).toContain("Planning Center added Calendar, People and Groups. Ozzie reads rooms, follow-ups and group meetings from its next check of your services.");
    expect(dom.button(MORE_CHECK)).not.toBeNull();
    expect(dom.seen()).not.toContain(MORE_LEAD);
    await page.unmount();
  });

  it("Cancel stops the sign-in, as Settings' does, and nothing changes", async () => {
    const page = await mount();
    await page.press(MORE_BUTTON);
    await page.show(WAITING);
    await page.press("Cancel");
    expect(sent("cancel_connection")).toEqual([{}]);
    await page.show(at("services", { last_attempt: { state: "cancelled", organization: "1001", checked_at_ms: null, source: "", problem: "cancelled" } }));
    expect(dom.seen()).toContain("Nothing changed.");
    expect(dom.button(MORE_BUTTON)).not.toBeNull();
    expect(sent("set_operations_reads")).toEqual([]);
    await page.unmount();
  });

  it("with the access already held, only turns the switch on: no sign-in", async () => {
    const page = await mount(memory(), GRANTED);
    await page.show(GRANTED);
    expect(dom.seen()).toContain(moreHeld());
    await page.press(MORE_BUTTON);
    expect(sent("connect_planning_center_app")).toEqual([]);
    // A person's press, with the access held: native allows it.
    expect(sent("set_operations_reads")).toEqual([{ on: true, pressed: true }]);
    expect(dom.seen()).toContain("Ozzie reads rooms, follow-ups and group meetings from its next check of your services.");
    await page.unmount();
  });

  it("Settings' button, through the same path, turns the reads on once Planning Center granted the access, not before", async () => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(dom.root as unknown as Element);
    const settings = (status: ConnectionStatus) => React.createElement(ConnectionPage, { status, settings: SETTINGS, onSettings: () => {}, onStatus: () => {}, oneClick: true, phone: null });
    const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };
    await act(async () => { root.render(settings(SERVICES)); });
    await settle();
    await act(async () => { dom.press(dom.button("Also check rooms, follow-ups and group events")!); });
    await settle();
    await act(async () => { root.render(settings(WAITING)); });
    await settle();
    expect(sent("set_operations_reads")).toEqual([]);
    await act(async () => { root.render(settings(GRANTED)); });
    await settle();
    expect(sent("set_operations_reads")).toEqual([{ on: true, pressed: false }]);
    expect(dom.seen()).toContain("Granted: Services, Calendar, People and Groups. Ozzie reads rooms, follow-ups and group events.");
    await act(async () => { root.unmount(); });
  });

  it("the reads go on whichever page is open when Planning Center answers, after the offer's page was left", async () => {
    const page = await mount();
    await page.press(MORE_BUTTON);
    await page.show(WAITING);
    await page.unmount();
    // App holds the same switch on every page (useOperationsReads): the answer comes back while Today is open.
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(dom.root as unknown as Element);
    function Elsewhere({ status }: { status: ConnectionStatus }) { useOperationsReads(status); return null; }
    await act(async () => { root.render(React.createElement(Elsewhere, { status: GRANTED })); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect(sent("set_operations_reads")).toEqual([{ on: true, pressed: false }]);
    await act(async () => { root.unmount(); });
  });

  it("never says Planning Center added Calendar, People and Groups for a To line's grant that replaced its own sign-in (review 2026-11-18)", async () => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { connection } = await import("../src/connection.js");
    const m = memory();
    const root = createRoot(dom.root as unknown as Element);
    let switchReads: (on: boolean) => Promise<boolean | null> = async () => null;
    function Page({ status }: { status: ConnectionStatus }) {
      const reads = useOperationsReads(status);
      switchReads = reads.switchReads;
      const need = readMoreNeed({ status, readsOn: reads.on, checked: true, hidden: false });
      return React.createElement(ReadMore, { need, place: "service", status, settings: SETTINGS, onStatus: () => {}, church: "Fictional Grace Church", oneClick: true,
        store: m.store, finish: m.finish, onCheck: () => {} });
    }
    const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };
    const show = async (status: ConnectionStatus) => { await act(async () => { root.render(React.createElement(Page, { status })); }); await settle(); };
    await show(SERVICES);
    await act(async () => { dom.press(dom.button(MORE_BUTTON)!); });
    await settle();
    await show(WAITING);
    // The card's own sign-in is left in the browser; a note's To line starts its own, which replaces it, and is granted.
    await act(async () => { await connection.connectApp(true, {}, "people-for-to"); });
    await show(WAITING);
    await show(GRANTED);
    expect(sent("set_operations_reads")).toEqual([]);
    // Later the person turns the reads on in Settings: the card says they start at the next check, never that its own
    // sign-in added the access.
    await act(async () => { await switchReads(true); });
    await settle();
    expect(sent("set_operations_reads")).toEqual([{ on: true, pressed: true }]);
    expect(dom.seen()).not.toContain("Planning Center added Calendar, People and Groups.");
    await act(async () => { root.unmount(); });
  });

  it("a People grant for a note's To line never turns the reads on, even after this offer's own sign-in ended without it", () => {
    expect(wantedAfter(false, GRANTED)).toEqual({ wanted: false, turnOn: false });
    expect(wantedAfter("asked", SERVICES)).toEqual({ wanted: "asked", turnOn: false });
    expect(wantedAfter("asked", WAITING)).toEqual({ wanted: "waiting", turnOn: false });
    expect(wantedAfter("waiting", GRANTED)).toEqual({ wanted: false, turnOn: true });
    // Ended without the grant: forgotten, so a later grant from the note doesn't count as this one.
    expect(wantedAfter("waiting", SERVICES)).toEqual({ wanted: false, turnOn: false });
  });
});

describe("refused by Planning Center", () => {
  it("Allow refused in the browser: the refusal in Ozzie's own words, and nothing changed", async () => {
    const page = await mount();
    await page.press(MORE_BUTTON);
    await page.show(WAITING);
    await page.show(at("services", { last_attempt: { state: "cancelled", organization: "1001", checked_at_ms: null, source: "", problem: "denied" } }));
    expect(dom.seen()).toContain(PEOPLE_ENDS.denied);
    expect(sent("set_operations_reads")).toEqual([]);
    expect(dom.button(MORE_BUTTON)).not.toBeNull();
    await page.unmount();
  });

  it("Planning Center gave Services only: says so, who can give access, and copies a message for the administrator", async () => {
    let copied = "";
    vi.stubGlobal("navigator", { clipboard: { writeText: async (t: string) => { copied = t; } } });
    const page = await mount();
    await page.press(MORE_BUTTON);
    await page.show(WAITING);
    await page.show(SERVICES);
    expect(dom.seen()).toContain("Planning Center didn't add Calendar, People and Groups this time, so nothing changed. "
      + "If the account you signed in with can't use them, a Planning Center administrator at your church can give it access.");
    await page.press(ADMIN_COPY);
    expect(copied).toBe(productsAdminMessage(["Calendar", "People", "Groups"]));
    expect(sent("set_operations_reads")).toEqual([]);
    await page.unmount();
  });

  it("granted, but the account can't see a product: the check's refusal, said with its message, nothing offered again", async () => {
    native.reads = true;
    const capture = withFictionalOperations(nov22Capture());
    const reads = capture.reads.map(r => r.collection.startsWith("calendar_") ? { ...r, outcome: "denied", body: null } : r);
    expect(refusedProducts(reads)).toEqual(["Calendar"]);
    expect(refusedProducts(capture.reads)).toEqual([]);
    // The kids rule's background-check read says its own refusals.
    expect(refusedProducts([{ collection: "people_background_checks", outcome: "denied" }])).toEqual([]);
    const page = await mount(memory(), GRANTED, { reads });
    await page.show(GRANTED, { reads });
    expect(dom.seen()).toContain("Planning Center didn't let Ozzie read Calendar at the last check. The account you signed in with may not have access to it there. "
      + "A Planning Center administrator at your church can give it access.");
    expect(dom.button(ADMIN_COPY)).not.toBeNull();
    expect(dom.button(MORE_BUTTON)).toBeNull();
    await page.unmount();
  });

  it("the administrator's message: plain, only reads, nothing about the church", () => {
    const m = productsAdminMessage(["Calendar", "Groups"]);
    expect(m).toBe("Hi! I'd like to use Ozzie, an app on my Mac that reads our church's Planning Center to show me who's scheduled and what still needs people. "
      + `${promise("request")} Planning Center doesn't let my account see Calendar and Groups yet. Could you give my account access to them in Planning Center? Thank you!`);
    expect(productsAdminMessage(["People"])).toContain("see People yet. Could you give my account access to it in Planning Center?");
    expect(m).not.toMatch(/\d|@|https?:|Grace|Fictional|\[/u);
    expect(m).not.toMatch(/\b(?:API|OAuth|scope|token|Keychain|organization)\b/iu);
  });
});

describe("dismissed", () => {
  it("Don't show this again: gone here and on Today, says where it still is, and stays gone after a relaunch", async () => {
    const m = memory();
    const page = await mount(m);
    await page.press(MORE_HIDE);
    expect(dom.seen()).toContain(MORE_HIDDEN);
    expect(m.store.hidden()).toBe(true);
    expect(JSON.parse(m.map.get("ozzie.read-more.v1")!)).toEqual({ hidden: true });
    await page.unmount();
    // A relaunch: the same memory, a fresh page.
    const again = await mount(m);
    expect(dom.seen()).toBe("");
    expect(readMoreNeed({ status: SERVICES, readsOn: false, checked: true, hidden: m.store.hidden() })).toBeNull();
    // Settings still has it.
    await again.unmount();
  });

  it("Not now: one quiet line here and a folded item on Today, kept across a relaunch; the line opens it again", async () => {
    const m = memory();
    const page = await mount(m);
    await page.press("Not now");
    expect(dom.button(MORE_BUTTON)).toBeNull();
    expect(dom.seen()).toBe(moreTitle("Fictional Grace Church"));
    expect(m.finish.get().notNow).toEqual(["more"]);
    expect(openItem([{ id: "more", title: "", done: false }], m.finish.get().notNow)).toBeNull();
    await page.unmount();
    const again = await mount(m);
    expect(dom.button(MORE_BUTTON)).toBeNull();
    await again.press(moreTitle("Fictional Grace Church"));
    expect(dom.button(MORE_BUTTON)).not.toBeNull();
    await again.unmount();
  });
});

describe("on the service's page", () => {
  const page = (capture: SundayCapture, more: React.ReactNode, mode: "live" | "fictional" = "live") => text(renderToStaticMarkup(React.createElement(SundayPage, {
    brief: buildSundayBrief(capture, RULES, capture.completed_at, mode === "fictional"), names: capture.names, busy: false, problem: "", sender: "", connected: true,
    hasRecording: false, configured: true, canReword: false, decisions: [], onDecisions: () => undefined, operations: sundayOperations(capture, RULES),
    onCheck: () => undefined, onRecording: () => undefined, onExample: () => undefined, more,
  })));
  const offer = (need: ReadMoreNeed | null, reads: SundayCapture["reads"] = []) => React.createElement(ReadMore, {
    need, place: "service", status: need === "sign-in" ? SERVICES : GRANTED, settings: SETTINGS, onStatus: () => {}, oneClick: true, reads, store: memory().store, finish: memory().finish,
  });

  it("Services only: the offer sits where rooms and follow-ups show once read, before what wasn't checked", () => {
    const capture = { ...withFictionalOperationsOff(nov22Capture()), kind: "live" as const };
    const t = page(capture, offer("sign-in"));
    expect(t).toContain("What else Ozzie can check for your church");
    expect(t.indexOf("What else Ozzie can check")).toBeLessThan(t.indexOf("What I didn't check"));
    // The facts of the check are unchanged: what wasn't read is still said there.
    expect(t).toContain("Rooms and follow-ups weren't checked. Turn this on in Settings.");
  });

  it("never on the fictional example", () => {
    const t = page(withFictionalOperationsOff(nov22Capture()), offer("sign-in"), "fictional");
    expect(t).not.toContain("What else Ozzie can check");
  });

  it("granted: gone, and the rooms, follow-ups and group meetings sections render", () => {
    const capture = { ...withFictionalOperations(nov22Capture()), kind: "live" as const };
    const t = page(capture, offer(null, capture.reads));
    expect(t).not.toContain("What else Ozzie can check");
    expect(t).not.toContain(MORE_BUTTON);
    expect(t).toContain("Rooms and follow-ups");
    expect(t).toContain("Sanctuary (fictional) has overlapping bookings from");
    expect(t).toContain("“Call a first-time guest” has no owner.");
    expect(t).toContain("has a group meeting at the same time.");
  });
});
