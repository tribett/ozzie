// A church on B1 Church or Breeze (onboarding decision 21; docs/design/church-systems-design.md): "What does your church
// use?", each system's connect screen with what Ozzie reads, what it can't see there and the one host it contacts, every
// key check's outcome in its own words, the time zone question, the service step, the service's page in the system's own
// words, and Settings. Rendered without native code: the native calls are stand-ins. Fictional data only.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => new Promise(() => {})) }));
import { installFakeDom } from "./fake-dom.js";
import { inZone } from "./zone.js";
import {
  addressLabel, churchSystemStore, CONNECT, connectProblem, HOST_SENTENCE, keyGoesTo, readChurchSystem, readProblemText, SystemWordsContext, systemWords,
  type ChurchSystemState, type Connected, type SystemConnection,
} from "../src/church-system.js";
import { CHOOSE, ChooseSystem, choiceLine, clockWords, pickService, SystemConnect, SystemService, systemCounts, systemFirstRunAt, soonest, TimeZoneQuestion, type SystemResultView } from "../src/system-setup.js";
import { OtherSystems, SystemFactsList, SystemSettings, switchForgets } from "../src/system-settings.js";
import { formatAt, NOT_CHOSEN, validChoices, validConnected } from "../src/church-system.js";
import { helpFor } from "../src/ask-panel.js";
import { HELP } from "../src/harness-words.js";
import { startIn } from "../src/system-setup.js";
import { refusalLine } from "../src/system-pages.js";
import { ofConnection, readSystem } from "../src/system-church.js";
import { SundayPage } from "../src/sunday-page.js";
import { canRemind, reminderDraft } from "../../../core/src/reminder-draft.js";
import { buildSystemBrief } from "../../../core/src/church-systems/brief.js";
import { cannotSee, howToConnect } from "../../../core/src/church-systems/facts.js";
import { applyDecisions } from "../../../core/src/sunday-decisions.js";
import { sundayShownCount } from "../../../core/src/sunday-brief.js";
import { B1_READS, b1Capture, breezeCapture, breezeUntimedCapture, factsCapture, NOW, readsOf } from "../../../core/test/church-systems/fixtures.js";
import { systemPromises } from "../src/system-setup.js";
import { decisionLines } from "../src/today-groups.js";
import { dayWords } from "../src/day-words.js";

const dom = installFakeDom();
const text = (html: string) => html.replace(/<[^>]+>/gu, " ").replace(/&#x27;/gu, "'").replace(/&amp;/gu, "&").replace(/&quot;/gu, "\"").replace(/&gt;/gu, ">").replace(/\s+/gu, " ");
const tick = () => new Promise(r => setTimeout(r, 0));
const none = () => {};
const B1: SystemConnection = { system: "b1", church_id: "CHU0000cedar", church_name: "Cedar Hollow Fellowship", address: "cedarhollow", service_id: "PLA0000nov22",
  service_day: "2026-11-22", service_name: "Sunday Gathering", zone: "America/Chicago", result_seen: true };
const BREEZE: SystemConnection = { system: "breeze", church_id: "juniperstreet", church_name: "Juniper Street Church", address: "juniperstreet", service_id: "88120031",
  service_day: "2026-11-22", service_name: null, zone: null, result_seen: true };
const all = (n: { childNodes: unknown[] }): unknown[] => [n, ...n.childNodes.flatMap(c => all(c as { childNodes: unknown[] }))];
type Props = Record<string, { onClick?: (e: unknown) => void; onChange?: (e: unknown) => void }>;
const propsOf = (el: unknown) => { const o = el as Props; return o[Object.keys(o).find(k => k.startsWith("__reactProps$"))!]; };
const byId = (id: string) => all(dom.root as unknown as { childNodes: unknown[] }).find(n => (n as { getAttribute?: (a: string) => string | null }).getAttribute?.("id") === id);
const buttonStarting = (label: string) => all(dom.root as unknown as { childNodes: unknown[] })
  .find(n => (n as { tagName?: string }).tagName === "BUTTON" && ((n as { textContent: string }).textContent ?? "").startsWith(label)) as Parameters<typeof dom.press>[0] | undefined;

async function mount(element: React.ReactElement) {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.root as unknown as Element);
  await act(async () => { root.render(element); });
  const settle = async (n = 10) => { for (let i = 0; i < n; i++) await act(async () => { await tick(); }); };
  await settle();
  return {
    settle, unmount: () => act(async () => { root.unmount(); }),
    press: async (label: string) => { const b = dom.button(label) ?? buttonStarting(label); if (!b) throw new Error(`no button ${label}: ${dom.seen().slice(0, 400)}`); await act(async () => { dom.press(b); await tick(); }); await settle(); },
    type: async (id: string, value: string) => { await act(async () => { propsOf(byId(id))?.onChange?.({ target: { value } }); await tick(); }); await settle(); },
  };
}

describe("what this Mac keeps about the church's system", () => {
  it("reads only what has the right shape, and never another system's connection", () => {
    expect(readChurchSystem(null)).toEqual({ main: null, connection: null, genesis: null });
    expect(readChurchSystem("not json")).toEqual({ main: null, connection: null, genesis: null });
    const kept = readChurchSystem(JSON.stringify({ main: "b1", connection: B1, genesis: { system: "genesis", church_id: "ORG-maple", church_name: null, zone: "America/Denver" } }));
    expect(kept.connection).toEqual(B1);
    expect(kept.genesis?.zone).toBe("America/Denver");
    // A Breeze connection under B1 Church as the main system is never used; a bad id or zone is left out, never guessed.
    expect(readChurchSystem(JSON.stringify({ main: "b1", connection: BREEZE })).connection).toBeNull();
    expect(readChurchSystem(JSON.stringify({ main: "b1", connection: { ...B1, church_id: "../x" } })).connection).toBeNull();
    expect(readChurchSystem(JSON.stringify({ main: "b1", connection: { ...B1, zone: "not a zone" } })).connection?.zone).toBeNull();
    expect(readChurchSystem(JSON.stringify({ main: "subsystem" })).main).toBeNull();
  });

  it("keeps \"Use a different system\" only while nothing is chosen, and only as true (polish 2026-11-21, item 7)", () => {
    expect(readChurchSystem(JSON.stringify({ main: null, choosing: true }))).toEqual({ main: null, connection: null, genesis: null, choosing: true });
    expect(readChurchSystem(JSON.stringify({ main: "b1", choosing: true }))).not.toHaveProperty("choosing");
    expect(readChurchSystem(JSON.stringify({ main: null, choosing: "yes" }))).not.toHaveProperty("choosing");
    const saved = new Map<string, string>();
    const store = churchSystemStore({ getItem: k => saved.get(k) ?? null, setItem: (k, v) => { saved.set(k, v); } });
    expect(store.set({ main: null, connection: null, genesis: null, choosing: true }).choosing).toBe(true);
    // Choosing a system drops it from what is kept, not only from what is read.
    store.set({ main: "breeze", connection: null, genesis: null, choosing: true });
    expect(JSON.parse(saved.get("ozzie.church-system.v1")!)).not.toHaveProperty("choosing");
  });

  it("first run opens at connect, then the service, then never again", () => {
    const state = (connection: SystemConnection | null): ChurchSystemState => ({ main: "b1", connection, genesis: null });
    expect(systemFirstRunAt(state(null), false)).toBe("connect");
    expect(systemFirstRunAt(state({ ...B1, service_id: null }), false)).toBe("service");
    expect(systemFirstRunAt(state(B1), false)).toBe("service");
    expect(systemFirstRunAt(state(B1), true)).toBeNull();
    expect(systemFirstRunAt({ main: "planning-center", connection: null, genesis: null }, false)).toBeNull();
  });
});

describe("one source of each system's words", () => {
  it("Planning Center's are exactly the words the pages said before", () => {
    const pc = systemWords(null);
    expect(pc).toBe(systemWords("planning-center"));
    expect([pc.liveRead, pc.savedCopy, pc.checkNow, pc.checking, pc.connect, pc.openIn]).toEqual([
      "Live read from Planning Center Services", "Saved copy of a check of Planning Center Services", "Check Planning Center now", "Checking Planning Center…",
      "Connect Planning Center", "Open in Planning Center"]);
    expect(pc.say("Nothing in Planning Center changed.")).toBe("Nothing in Planning Center changed.");
    expect(pc.reads).toBeNull();
  });

  it("B1 Church and Breeze name themselves, have no link into the system, and say what works with Planning Center only", () => {
    for (const [system, name] of [["b1", "B1 Church"], ["breeze", "Breeze"]] as const) {
      const w = systemWords(system);
      expect([w.liveRead, w.checkNow, w.checking, w.connect]).toEqual([`Live read from ${name}`, `Check ${name} now`, `Checking ${name}…`, `Connect ${name}`]);
      expect(w.openIn).toBeNull();
      // Checks on their own and saved checks work with B1 Church and Breeze too (round 2), and so do jobs (Keep services
      // covered and the morning briefing, 0.8.0); sharing and the extras don't yet.
      expect([w.checksOnItsOwn, w.savedChecks, w.jobs, w.askAndShare, w.extras]).toEqual([true, true, true, false, false]);
      expect(w.say("Nothing in Planning Center Services changed, and Planning Center still counts them.")).toBe(`Nothing in ${name} changed, and ${name} still counts them.`);
      expect(w.notHere("Ask Ozzie")).toBe(`Ask Ozzie works with Planning Center only for now. Ozzie can't do this with ${name} yet.`);
    }
    // Breeze doesn't say whether a request was sent, and ties no team to a role; B1 Church says both.
    expect(systemWords("breeze").sentUnknown).toBe("Breeze doesn't say whether the request was sent.");
    expect(systemWords("b1").sentUnknown).toBeNull();
    expect(systemWords("breeze").noTeam).toBe("Breeze doesn't tie a team to each role, so Ozzie can't suggest who could help.");
    expect(systemWords("b1").noTeam).toBeNull();
    // Genesis shares no volunteer schedules: no job reads it.
    expect(systemWords("genesis").jobs).toBe(false);
  });

  it("each host is disclosed in the design's own sentence (design §7)", () => {
    expect(HOST_SENTENCE).toEqual({
      b1: "Ozzie reads your church's B1 Church account from api.churchapps.org.",
      breeze: "Ozzie reads your church's Breeze account at its own breezechms.com address.",
      genesis: "Ozzie reads your church's Genesis account from the address Genesis publishes for its API.",
    });
    expect(keyGoesTo("breeze", "juniperstreet")).toBe("Ozzie sends the key only to juniperstreet.breezechms.com.");
    expect(keyGoesTo("b1", "cedarhollow")).toBe("Ozzie sends the key only to api.churchapps.org.");
  });

  it("takes the church's address as people type it, and nothing that isn't one", () => {
    expect(addressLabel("b1", "cedarhollow.b1.church")).toBe("cedarhollow");
    expect(addressLabel("b1", " https://CedarHollow.b1.church/settings ")).toBe("cedarhollow");
    expect(addressLabel("breeze", "juniperstreet.breezechms.com")).toBe("juniperstreet");
    expect(addressLabel("breeze", "juniperstreet")).toBe("juniperstreet");
    for (const bad of ["", "two words", "-lead", "xn--evil", "pastor@grace.org", "under_score"]) expect(addressLabel("breeze", bad), bad).toBeNull();
  });
});

describe("every key check's outcome in its own words", () => {
  it("a wrong key, a wrong church address, no permission and can't reach it are each said differently, and none quotes native text", () => {
    const said = (outcome: string, system: "b1" | "breeze" = "b1") => connectProblem(system, outcome, "cedarhollow")?.text ?? null;
    expect(said("works")).toBeNull();
    expect(said("key-refused")).toBe("B1 Church didn't accept this key for cedarhollow.b1.church. Check that you copied the whole key, that it was made in this church's B1 Church, and that it hasn't been deleted or passed its expiry date. Nothing was saved.");
    expect(said("not-found")).toBe("B1 Church doesn't know a church at cedarhollow.b1.church. Check the address, then try again. Nothing was saved.");
    expect(said("refused")).toContain("didn't let Ozzie read your church's account");
    expect(said("unreachable")).toBe("Ozzie couldn't reach B1 Church just now, so nothing was saved. Check that this Mac is online, then try again.");
    expect(said("format")).toContain("(it starts with cak_)");
    expect(said("address", "breeze")).toBe("That doesn't look like a Breeze address. Type the address you sign in to Breeze at, like yourchurch.breezechms.com.");
    expect(said("locked")).toContain("this Mac didn't let Ozzie keep it");
    expect(connectProblem("b1", "cancelled", null)).toEqual({ text: "Nothing was saved.", alert: false });
    const words = ["key-refused", "not-found", "refused", "unreachable", "rate-limited", "invalid-response", "format", "address", "empty", "busy", "locked"];
    expect(new Set(words.map(w => said(w))).size).toBe(words.length);
    // Something native never says is still one fixed sentence.
    expect(said("<script>")).toBe("B1 Church couldn't be checked just now, so nothing was saved. Try again in a moment.");
    expect(readProblemText("breeze", "key-refused")).toBe("Breeze no longer accepts the key Ozzie has, so nothing was read. Connect Breeze again in Settings with a new key.");
  });
});

describe("What does your church use? (decision 21)", () => {
  it("asks first: Planning Center, B1 Church, Breeze, then Genesis, said plainly as no service check (round 5)", () => {
    const t = text(renderToStaticMarkup(React.createElement(ChooseSystem, { onChoose: none, onExample: none })));
    expect(t).toContain(CHOOSE.title);
    expect(t.indexOf("Planning Center")).toBeLessThan(t.indexOf("B1 Church"));
    expect(t.indexOf("B1 Church")).toBeLessThan(t.indexOf("Breeze"));
    expect(t.indexOf("Breeze")).toBeLessThan(t.indexOf("Genesis"));
    expect(t).toContain("Groups, events with attendance, and forms. Genesis doesn't share volunteer schedules, so Ozzie can't check whether a service is covered.");
    expect(t).toContain("See an example church first");
    // Exactly these four, in this order: no other system is offered.
    expect(CHOOSE.systems.map(s => s.id)).toEqual(["planning-center", "b1", "breeze", "genesis"]);
  });

  it("choosing one says which", async () => {
    const chosen: string[] = [];
    const app = await mount(React.createElement(ChooseSystem, { onChoose: s => chosen.push(s), onExample: none }));
    await app.press("B1 Church");
    await app.press("Planning Center");
    expect(chosen).toEqual(["b1", "planning-center"]);
    await app.unmount();
  });
});

describe("each system's connect screen", () => {
  const connect = (system: "b1" | "breeze" | "genesis") => text(renderToStaticMarkup(React.createElement(SystemConnect, {
    system, step: "Step 1 of 2", connect: () => new Promise<Connected>(() => {}), onConnected: none, onBack: none,
  })));

  it("B1 Church: it only reads, names stay here, the host, what it can't see, and where the key is, in B1 Church's own words", () => {
    const t = connect("b1");
    expect(t).toContain("Ozzie only reads. It can't change anything in B1 Church.");
    expect(t).toContain("The names Ozzie reads from B1 Church stay on this Mac. The AI sees stand-ins instead.");
    expect(t).toContain(HOST_SENTENCE.b1);
    expect(t).toContain("Ozzie can't read background checks from B1 Church");
    for (const line of howToConnect("b1")) expect(t).toContain(line);
    for (const line of cannotSee("b1")) expect(t).toContain(line);
    expect(t).toContain("Your church's B1 Church address");
    expect(t).toContain("Paste my key");
    expect(t).not.toContain("Planning Center");
  });

  it("Breeze: says plainly it can't see blockout dates, who could help, the newer scheduling page or background checks", () => {
    const t = connect("breeze");
    for (const line of CONNECT.breeze.cantSee) expect(t).toContain(line);
    expect(t).toContain("Ozzie can't read blockout dates from Breeze.");
    expect(t).toContain(HOST_SENTENCE.breeze);
    expect(t).toContain("Breeze is becoming Tithely Church Management");
  });

  it("Genesis: no address to type, and no service check", () => {
    const t = connect("genesis");
    expect(t).not.toContain("Your church's Genesis address");
    expect(t).not.toContain("breezechms.com");
    expect(t).toContain("Ozzie can't check whether your service is covered from Genesis");
    expect(t).toContain(HOST_SENTENCE.genesis);
  });

  it("asks native with the address as typed, says a refused key in its own words, and hands on a key that works", async () => {
    const calls: [string | null, string][] = [];
    const answers: Connected[] = [{ outcome: "key-refused", church: null }, { outcome: "works", church: { id: "CHU0000cedar", name: "Cedar Hollow Fellowship" } }];
    const connected: unknown[] = [];
    const app = await mount(React.createElement(SystemConnect, {
      system: "b1", step: "Step 1 of 2", connect: async (address, how) => { calls.push([address, how]); return answers.shift()!; },
      onConnected: (church, address) => connected.push([church, address]),
    }));
    await app.type("fr-system-address", "https://cedarhollow.b1.church/");
    await app.press("Paste my key");
    expect(calls).toEqual([["cedarhollow", "paste"]]);
    expect(dom.seen()).toContain("B1 Church didn't accept this key for cedarhollow.b1.church.");
    expect(connected).toEqual([]);
    await app.press("Type or paste it in a window");
    expect(calls[1]).toEqual(["cedarhollow", "enter"]);
    expect(connected).toEqual([[{ id: "CHU0000cedar", name: "Cedar Hollow Fellowship" }, "cedarhollow"]]);
    await app.unmount();
  });
});

describe("the church's time zone, asked once", () => {
  it("B1 Church's own zone is asked about by name, with the start it gives", () => {
    const t = text(renderToStaticMarkup(React.createElement(TimeZoneQuestion, { system: "b1", systemZone: "America/Chicago", startsAt: "2026-11-22T15:00:00Z", onConfirm: none })));
    expect(t).toContain("B1 Church says your church's time zone is Central Time (Chicago). That makes this service start at Sunday, November 22 at 9:00 AM. Is that right?");
    expect(t).toContain("Use Central Time (Chicago)");
    // The menu lists each zone by the same name, its value the IANA name.
    expect(renderToStaticMarkup(React.createElement(TimeZoneQuestion, { system: "b1", systemZone: "America/Chicago", startsAt: null, onConfirm: none })))
      .toContain('<option value="America/New_York">Eastern Time (New York)</option>');
  });
  it("with no zone from the system, it asks which, with this Mac's zone as the default and the start that gives", () => {
    const t = text(renderToStaticMarkup(React.createElement(TimeZoneQuestion, { system: "b1", systemZone: null, startsAt: "2026-11-22T15:00:00Z", initial: "America/New_York", onConfirm: none })));
    expect(t).toContain("Which time zone does your church meet in? In Eastern Time (New York), this service starts Sunday, November 22 at 10:00 AM.");
    expect(t).not.toMatch(/America\/New/u);
  });
});

/** The first result as App builds it. */
function resultOf(capture = b1Capture(), zone: string | null = "America/Chicago"): SystemResultView {
  const built = buildSystemBrief(capture, { confirmedZone: zone }, NOW);
  if (!built.ok) throw new Error(built.reason);
  const decided = applyDecisions(built.brief, []);
  const counts = sundayShownCount(decided, null);
  return { brief: built.brief, capture, counts: { decisions: counts.decisions, looks: counts.looks },
    lines: decisionLines(decided.items, { rooms: 0, followUps: 0 }, "America/Chicago", built.brief.day).named, notices: built.notices, waitingForZone: built.coverage.waiting_for_zone };
}

describe("the service step for a system", () => {
  it("picks the soonest service itself, reads it, and shows the first result in the system's own words", async () => {
    const reads: SystemConnection[] = [];
    let connection: SystemConnection = { ...B1, service_id: null, service_day: null, service_name: null, result_seen: false };
    const result = resultOf();
    const app = await mount(React.createElement(SystemService, {
      connection, onConnection: next => { connection = next; }, nowMs: Date.parse(NOW), aiOffered: true, onNext: none,
      list: async () => ({ outcome: "ok", choices: [{ id: "PLA0000nov29", day: "2099-11-29", name: "Later", shared: true }, { id: "PLA0000nov22", day: "2099-11-22", name: "Sunday Gathering", shared: true },
        { id: "PLA0000old", day: "2000-01-02", name: "Past", shared: true }] }),
      read: async c => { reads.push(c); return "ok"; }, result: null, day: result.brief.day!,
    }));
    expect(connection.service_id).toBe("PLA0000nov22");
    expect(reads.map(r => r.service_id)).toEqual(["PLA0000nov22"]);
    await app.unmount();
    // The result, once App has it: the answer, its lines, the system as the source, and no promise of checks on its own.
    const done = await mount(React.createElement(SystemService, {
      connection: B1, onConnection: none, nowMs: Date.parse(NOW), aiOffered: true, onNext: none,
      list: async () => ({ outcome: "ok", choices: [] }), read: async () => "ok", result, day: result.brief.day!,
    }));
    const t = dom.seen();
    expect(t).toContain("Are your services covered?");
    expect(t).toContain("3 things need a decision for Sunday, November 22.");
    expect(t).toContain("B1 Church · checked");
    // Kept watch over on a schedule, as Planning Center's first result says (round 2).
    expect(t).toContain("Ozzie keeps an eye on your services at least every hour while it's open, and moves on to the next plan by itself after this one. To read it now, press Check B1 Church now on");
    expect(t).not.toContain("Planning Center Services");
    await done.unmount();
  });

  it("says plainly when nothing is planned, and when the list couldn't be read", async () => {
    const app = await mount(React.createElement(SystemService, {
      connection: { ...BREEZE, service_id: null }, onConnection: none, nowMs: Date.parse(NOW), aiOffered: true, onNext: none,
      list: async () => ({ outcome: "ok", choices: [] }), read: async () => "ok", result: null, day: dayWords(null, null),
    }));
    expect(dom.seen()).toContain("Breeze has no events in the next four weeks");
    await app.unmount();
    const refused = await mount(React.createElement(SystemService, {
      connection: { ...BREEZE, service_id: null }, onConnection: none, nowMs: Date.parse(NOW), aiOffered: true, onNext: none,
      list: async () => ({ outcome: "key-refused", choices: [] }), read: async () => "ok", result: null, day: dayWords(null, null),
    }));
    expect(dom.seen()).toContain("Breeze no longer accepts the key Ozzie has");
    await refused.unmount();
  });

  it("counts the people scheduled once each, from the answers", () => {
    expect(systemCounts(b1Capture())).toEqual({ scheduled: 2, yes: 1, waiting: 1 });
    expect(soonest([{ id: "a", day: "2026-11-29", name: null, shared: null }, { id: "b", day: "2026-11-22", name: null, shared: null }], "2026-11-21")?.id).toBe("b");
  });
});

describe("the service's page on another system", () => {
  const page = (system: "b1" | "breeze", brief: ReturnType<typeof resultOf>["brief"], names: Record<string, string>) => text(renderToStaticMarkup(
    React.createElement(SystemWordsContext.Provider, { value: systemWords(system) }, React.createElement(SundayPage, {
      brief, names, busy: false, problem: "", sender: "Pat", connected: true, hasRecording: false, configured: true, canReword: false, decisions: [],
      onDecisions: none, operations: null, onCheck: none, onRecording: none, onExample: none, openInPlanningCenter: null,
    }))));

  it("B1 Church: a live read from B1 Church, its own check button, and not a word of Planning Center", () => {
    const capture = b1Capture({ blockouts: [{ person_id: "PER-rowan", starts_at: "2026-11-21T00:00:00-06:00", ends_at: "2026-11-23T00:00:00-06:00" }] });
    const t = page("b1", resultOf(capture).brief, capture.names);
    expect(t).toContain("Live read from B1 Church");
    expect(t).toContain("Check B1 Church now");
    expect(t).toContain("Rowan Fictional is scheduled for Vocals");
    expect(t).toContain("has a blockout in B1 Church");
    expect(t).toContain("B1 Church shows the request hasn't been sent yet. Is that expected?");
    expect(t).toContain("Ozzie can't read background checks from B1 Church");
    expect(t).not.toContain("Planning Center");
    expect(t).not.toContain("Open in");
  });

  it("names the plan's own title beside its date only when it adds something (round 3)", () => {
    // Drawn on a Mac on the church's own clock (Chicago), so the date line names no zone; on another clock it does, after
    // the time (the next test).
    const titled = (title: string) => { const c = b1Capture({ labels: { ...b1Capture().labels, service: title } }); return inZone("America/Chicago", () => page("b1", resultOf(c).brief, c.names)); };
    expect(titled("Sunday Gathering")).toContain("Sunday, November 22 · 9:00 AM · Sunday Gathering");
    expect(titled("Sunday Nov 22")).not.toContain("Sunday Nov 22");
    expect(titled("Sunday Nov 22")).toContain("Sunday, November 22");
  });

  it("on any Mac clock, the service's and its roles' times are the church's, and another clock is told which zone that is (0.5.4 used the Mac's on the cards)", () => {
    const b1 = b1Capture(), breeze = breezeCapture(), untimed = breezeUntimedCapture();
    for (const zone of ["America/Chicago", "America/New_York", "UTC", "Asia/Tokyo"]) {
      const at = (system: "b1" | "breeze", r: ReturnType<typeof resultOf>, names: Record<string, string>) => inZone(zone, () => page(system, r.brief, names));
      // B1 Church, its zone confirmed (Chicago): every role at 9:00 AM, the zone named off Chicago's clock.
      const confirmed = at("b1", resultOf(b1), b1.names);
      expect(confirmed, zone).toContain(`Sunday, November 22 · 9:00 AM${zone === "America/Chicago" ? "" : " Central Time (Chicago)"} · Sunday Gathering`);
      for (const role of ["Vocals", "Guitar", "Greeter"]) expect(confirmed, zone).toContain(`${role} · Sunday, November 22 at 9:00 AM`);
      // Still waiting for the leader to confirm it: no role time is said, and the date line's time names the zone B1
      // gave, the one the time zone question asks about.
      const waiting = at("b1", resultOf(b1, null), b1.names);
      expect(waiting, zone).toContain(`Sunday, November 22 · 9:00 AM${zone === "America/Chicago" ? "" : " Central Time (Chicago)"} · Sunday Gathering`);
      expect(waiting, zone).not.toMatch(/ · Sunday, November 2\d at /u);
      // Breeze with a time (New York's 10:30 AM), and with none: never a time, never a zone.
      expect(at("breeze", resultOf(breeze, null), breeze.names), zone).toContain(`Sunday, November 22 · 10:30 AM${zone === "America/New_York" ? "" : " Eastern Time (New York)"} Are your services covered?`);
      const day = at("breeze", resultOf(untimed, null), untimed.names);
      expect(day, zone).toContain(" Sunday, November 22 · Event Location limit Are your services covered?");
      expect(day, zone).toContain("Greeter · this Sunday");
      expect(day, zone).not.toMatch(/ · Sunday, November 2\d at /u);
    }
  });

  it("Breeze: a request it doesn't report is unknown, and no team is claimed", () => {
    const capture = breezeCapture({ assignments: [
      { id: "71001", position_id: "9627", person_id: "157801", status: "unconfirmed", asked: null },
      { id: "71002", position_id: "9628", person_id: "157802", status: "accepted", asked: null }] });
    const t = page("breeze", resultOf(capture, null).brief, capture.names);
    expect(t).toContain("Breeze doesn't say whether the request was sent.");
    expect(t).toContain("Breeze doesn't tie a team to each role, so Ozzie can't suggest who could help.");
    expect(t).not.toContain("hasn't been sent yet");
    expect(t).not.toContain("on this team");
    expect(t).toContain("Ozzie can't read blockout dates from Breeze.");
    expect(t).not.toContain("Planning Center");
  });
});

describe("Settings and Keeping watch for another system", () => {
  it("shows the church, checks the connection, disconnects only after saying what it forgets, and says what it can't see", async () => {
    const verify = vi.fn(async (): Promise<Connected> => ({ outcome: "works", church: { id: "CHU0000cedar", name: "Cedar Hollow Fellowship" } }));
    const forget = vi.fn(async () => "forgotten");
    const forgot = vi.fn();
    const app = await mount(React.createElement(SystemSettings, { connection: B1, onConnection: none, onForget: forgot, onConnect: none, startsAt: null, systemZone: null,
      bridge: { verify, forget, choices: async () => ({ outcome: "ok", choices: [] }), check: async () => ({ outcome: "ok", capture: null }), connect: async () => ({ outcome: "cancelled", church: null }), saved: async () => [] } }));
    expect(dom.seen()).toContain("Connected to Cedar Hollow Fellowship in B1 Church, at cedarhollow.b1.church.");
    expect(dom.seen()).toContain(HOST_SENTENCE.b1);
    expect(dom.seen()).toContain("Ozzie uses Central Time (Chicago) for Cedar Hollow Fellowship's times and days.");
    await app.press("Check the connection");
    expect(verify).toHaveBeenCalledWith("b1", "CHU0000cedar");
    expect(dom.seen()).toContain("It works: B1 Church accepts Ozzie's key for Cedar Hollow Fellowship.");
    await app.press("Disconnect B1 Church");
    expect(dom.seen()).toContain("Ozzie forgets its B1 Church key and the checks it saved on this Mac, and stops reading B1 Church. Nothing changes in B1 Church.");
    expect(forget).not.toHaveBeenCalled();
    await app.press("Disconnect and forget the key");
    expect(forget).toHaveBeenCalledWith("b1", "CHU0000cedar");
    expect(forgot).toHaveBeenCalled();
    await app.unmount();
  });

  it("switching says what it forgets before it does anything", async () => {
    expect(switchForgets("b1", "Cedar Hollow Fellowship")).toBe("Switching forgets Cedar Hollow Fellowship in B1 Church on this Mac: the key in this Mac's Keychain, the church, the service Ozzie watches and its saved checks. Nothing changes in B1 Church.");
    expect(switchForgets("planning-center", null)).toBe("Switching signs Ozzie out of Planning Center on this Mac. Nothing changes in Planning Center, and your Church rules stay here. Its saved checks stay on this Mac until you delete them in Settings. Switching back asks you to allow Ozzie in Planning Center again.");
    const switched: string[] = [];
    // The first try can't let B1 Church go (this Mac refused): it says so and nothing switches; the second works.
    const answers = ["This Mac didn't let Ozzie remove the B1 Church key just now, so nothing was switched.", null];
    const app = await mount(React.createElement(OtherSystems, { state: { main: "b1", connection: B1, genesis: null },
      onSwitch: async to => { switched.push(to); return answers.shift() ?? null; }, genesis: null }));
    await app.press("Switch to Breeze");
    expect(switched).toEqual([]);
    expect(dom.seen()).toContain("Switch to Breeze? Switching forgets Cedar Hollow Fellowship in B1 Church");
    await app.press("Keep B1 Church");
    await app.press("Switch to Planning Center");
    await app.press("Switch to Planning Center");
    expect(dom.seen()).toContain("so nothing was switched.");
    await app.press("Switch to Planning Center");
    expect(switched).toEqual(["planning-center", "planning-center"]);
    expect(dom.seen()).not.toContain("so nothing was switched.");
    await app.unmount();
  });


});

describe("reading a system's check on the page", () => {
  it("keeps only a capture the page accepts, of the church and service watched", async () => {
    const good = await readSystem(B1, { check: async () => ({ outcome: "ok", capture: JSON.stringify(b1Capture()) }) });
    expect(good.outcome).toBe("ok");
    expect(ofConnection(good.capture, B1)).toBe(true);
    expect(ofConnection(good.capture, { ...B1, service_id: "another" })).toBe(false);
    expect(ofConnection(good.capture, { ...B1, church_id: "CHU0000other" })).toBe(false);
    const broken = await readSystem(B1, { check: async () => ({ outcome: "ok", capture: "{\"names\":{\"p\":Avery}}" }) });
    expect(broken).toEqual({ outcome: "invalid-response", capture: null });
    expect(await readSystem(B1, { check: async () => ({ outcome: "key-refused", capture: null }) })).toEqual({ outcome: "key-refused", capture: null });
    expect(await readSystem({ ...B1, service_id: null }, { check: async () => ({ outcome: "ok", capture: null }) })).toEqual({ outcome: "bad-id", capture: null });
  });
});

describe("a zone, date or name a church system sends is never trusted to format (coordinator's security finding)", () => {
  const BAD_ZONES = ["Not/AZone", "", "A/".padEnd(300, "x"), "Etc/../../x"];

  it("formats with a zone only when this Mac knows it, never throws, and says nothing for a date it can't read", () => {
    const at = "2026-11-22T15:00:00Z";
    for (const zone of BAD_ZONES) expect(formatAt(at, { hour: "numeric", minute: "2-digit" }, zone)).toBe(formatAt(at, { hour: "numeric", minute: "2-digit" }));
    expect(formatAt(at, { hour: "numeric", minute: "2-digit" }, "Not/AZone", "America/Chicago")).toBe("9:00 AM");
    for (const bad of ["not a date", "", "2026-13-45T99:00:00Z", Number.NaN]) expect(formatAt(bad, { hour: "numeric" }, "America/Chicago")).toBeNull();
    for (const zone of BAD_ZONES) expect(startIn(at, zone)).toBeNull();
    expect(startIn("not a date", "America/Chicago")).toBeNull();
  });

  it("the also-read list renders with a bad zone and a bad date in the capture, as the system sent them", () => {
    for (const zone of [...BAD_ZONES, null]) {
      const capture = { ...b1Capture(), church: { id: "CHU0000cedar", time_zone: zone },
        events: [{ id: "SES-bad", starts_at: "not a date", ends_at: null, attendance: null }, { id: "SES-nov15", starts_at: "2026-11-15T09:00:00-06:00", ends_at: null, attendance: null }],
        labels: { ...b1Capture().labels, "event:SES-bad": "Odd Event" } };
      for (const confirmed of [...BAD_ZONES, null]) {
        const t = text(renderToStaticMarkup(React.createElement(SystemFactsList, { capture, zone: confirmed })));
        expect(t).toContain("Odd Event, a time Ozzie couldn't read");
        expect(t).toContain("Live read from B1 Church");
      }
    }
  });

  it("the time zone question takes no bad zone as its answer, whatever the system or this Mac's storage says", () => {
    for (const zone of BAD_ZONES) {
      const t = text(renderToStaticMarkup(React.createElement(TimeZoneQuestion, { system: "b1", systemZone: zone, startsAt: "not a date", initial: zone, onConfirm: none })));
      expect(t).toContain("Which time zone does your church meet in?");
      if (zone) expect(t).not.toContain(`Use ${zone.replace(/_/gu, " ")}`);
    }
  });

  it("what this Mac keeps drops a zone it doesn't know and a date that isn't one", () => {
    const kept = readChurchSystem(JSON.stringify({ main: "b1", connection: { ...B1, zone: "Not/AZone", service_day: "2026-13-45" },
      genesis: { system: "genesis", church_id: "ORG-maple", church_name: null, zone: "A/".padEnd(300, "x") } }));
    expect(kept.connection).toMatchObject({ zone: null, service_day: null });
    expect(kept.genesis?.zone).toBeNull();
  });

  it("native's lists and church answers are checked before the page uses them", () => {
    expect(validChoices({ outcome: "ok", choices: [
      { id: "PLA1", day: "2026-11-22", name: "Sunday", shared: true },
      { id: "../x", day: "2026-11-22", name: null, shared: null },
      { id: "PLA2", day: "2026-13-45", name: null, shared: null },
      { id: "PLA3", day: "not a date", name: "x".repeat(500), shared: "yes" },
      { id: "PLA4", day: "2026-11-29", name: "x".repeat(500), shared: "yes" },
    ] })).toEqual({ outcome: "ok", choices: [{ id: "PLA1", day: "2026-11-22", name: "Sunday", shared: true }, { id: "PLA4", day: "2026-11-29", name: null, shared: null }] });
    expect(validChoices("nonsense")).toEqual({ outcome: "invalid-response", choices: [] });
    expect(validConnected({ outcome: "works", church: { id: "CHU0000cedar", name: "Cedar Hollow" } })).toEqual({ outcome: "works", church: { id: "CHU0000cedar", name: "Cedar Hollow" } });
    expect(validConnected({ outcome: "works", church: { id: "a b", name: "x" } })).toEqual({ outcome: "invalid-response", church: null });
    expect(validConnected({ outcome: "<b>bold</b>", church: null })).toEqual({ outcome: "invalid-response", church: null });
    expect(validConnected({ outcome: "key-refused", church: { id: "CHU0000cedar", name: "x" } })).toEqual({ outcome: "key-refused", church: null });
  });
});

describe("a check that builds no service check, and answers not read whole (final review M1, M3)", () => {
  it("says why in place of \"hasn't been checked yet\", on the service's page and in first run", async () => {
    expect(refusalLine("breeze", "no-roles")).toContain("Ozzie found no roles for this service in Breeze.");
    expect(refusalLine("b1", "no-service")).toBe("Ozzie couldn't read this service's times from B1 Church, so it couldn't check it. Check B1 Church again in a moment; What happened lists which read didn't finish.");
    expect(refusalLine("b1", null)).toBeNull();
    const t = text(renderToStaticMarkup(React.createElement(SystemWordsContext.Provider, { value: systemWords("breeze") }, React.createElement(SundayPage, {
      brief: null, names: {}, busy: false, problem: "", sender: "", connected: true, hasRecording: false, configured: true, canReword: false, decisions: [],
      onDecisions: none, operations: null, onCheck: none, onRecording: none, onExample: none, uncheckedLine: refusalLine("breeze", "no-roles"),
    }))));
    expect(t).toContain("Ozzie found no roles for this service in Breeze.");
    expect(t).not.toContain("hasn't been checked yet");
    const app = await mount(React.createElement(SystemService, {
      connection: BREEZE, onConnection: none, nowMs: Date.parse(NOW), aiOffered: true, onNext: none,
      list: async () => ({ outcome: "ok", choices: [] }), read: async () => "ok", result: null, day: dayWords(null, null), refusal: refusalLine("breeze", "no-roles"),
    }));
    expect(dom.seen()).toContain("Ozzie found no roles for this service in Breeze.");
    expect(dom.button("Go to Today")).not.toBeNull();
    await app.unmount();
  });

  it("never says nobody is scheduled when who is scheduled wasn't read whole", async () => {
    const capture = b1Capture({ assignments: [], reads: readsOf(B1_READS, { "b1.assignments": "timeout" }) });
    const result = resultOf(capture);
    const app = await mount(React.createElement(SystemService, {
      connection: B1, onConnection: none, nowMs: Date.parse(NOW), aiOffered: true, onNext: none,
      list: async () => ({ outcome: "ok", choices: [] }), read: async () => "ok", result, day: result.brief.day!,
    }));
    expect(dom.seen()).not.toContain("Nobody is scheduled");
    expect(dom.seen()).toContain("Part of Sunday couldn't be checked");
    await app.unmount();
  });
});

/**
 * The same capture, read at seven minutes to the hour. When Ozzie checked is said on this Mac's clock, so the fixture's
 * 3:00 PM UTC check is 12:00 AM on a Mac in Tokyo: a true time, and not what the midnight checks below are about (an
 * untimed service, role or event said as midnight). Seven to the hour is never on the hour in any zone (every offset is a
 * whole, half or three-quarter hour), so any 12:00 AM left is one said of something with no time.
 */
const offTheHour = <C extends { started_at: string; completed_at: string; reads: { checked_at: string }[] }>(c: C): C =>
  ({ ...c, started_at: "2026-11-20T14:52:58Z", completed_at: "2026-11-20T14:53:04Z", reads: c.reads.map(r => ({ ...r, checked_at: "2026-11-20T14:53:00Z" })) });

describe("a Breeze service, as the live test church showed it (round 4)", () => {
  const capture = breezeUntimedCapture();
  const sunday = (c = capture) => text(renderToStaticMarkup(React.createElement(SystemWordsContext.Provider, { value: systemWords("breeze") }, React.createElement(SundayPage, {
    brief: resultOf(c, null).brief, names: c.names, busy: false, problem: "", sender: "Pat", connected: true, hasRecording: false, configured: true,
    canReword: false, decisions: [], onDecisions: none, operations: null, onCheck: none, onRecording: none, onExample: none, openInPlanningCenter: null,
  }))));

  it("says once that Breeze shares no number needed, never that part couldn't be checked, and who said yes, hasn't answered or said no", () => {
    const t = sunday();
    // The facts first, adding up to the whole; the limit on a quieter line of its own (round 5).
    expect(t).toContain("4 people are listed: 2 said yes, 1 hasn't answered, 1 said no. 1 thing is worth a look.");
    expect(t).toContain("Breeze doesn't share how many people each role needs, so Ozzie can't say whether this Sunday is covered.");
    expect(t).not.toMatch(/couldn't be checked|isn't a full picture/u);
    expect(t).toContain("Greeter : Wren Fictional hasn't answered yet.");
    expect(t).toContain("Usher : Sam Fictional said yes; Lee Fictional said no.");
    expect(t).toContain("Sound : Ivy Fictional said yes.");
    expect(t).toContain("On the service with no role: Kit Fictional.");
    expect(t).toContain("All 3 roles, and who answered");
    // Said as the page's second line, and once in What I didn't check; never beside each role.
    expect(t.match(/Breeze doesn't share how many people each role needs/gu)).toHaveLength(2);
    // Someone with no role is said once, in the card (round 5).
    expect(t.match(/with no role|without a role/gu)).toHaveLength(1);
    // The rarer limits are folded under their own line.
    expect(t).toContain("More that Ozzie can't see in Breeze");
    expect(t.match(/Breeze doesn't share how many people each role needs, so Ozzie can't say whether a role is full/gu)).toHaveLength(1);
  });

  it("a read that truly failed is named, with what to do", () => {
    const failed = breezeUntimedCapture({ reads: capture.reads.map(r => r.read === "breeze.volunteers" ? { ...r, outcome: "timeout" as const } : r) });
    const t = text(renderToStaticMarkup(React.createElement(SystemWordsContext.Provider, { value: systemWords("breeze") }, React.createElement(SundayPage, {
      brief: resultOf(failed, null).brief, names: failed.names, busy: false, problem: "", sender: "Pat", connected: true, hasRecording: false, configured: true,
      canReword: false, decisions: [], onDecisions: none, operations: null, onCheck: none, onRecording: none, onExample: none, openInPlanningCenter: null,
    }))));
    expect(t).toContain("Part of this Sunday couldn't be checked.");
    expect(t).toContain("Breeze didn't give Ozzie every part this time. What's missing, and what to do, is listed below.");
    expect(t).toContain("Who is scheduled: took too long. Check Breeze again in a moment.");
  });

  it("the pending card offers a reminder, worded so it never claims a request was sent (round 5)", () => {
    expect(sunday()).toContain("Prepare a reminder");
    const pending = resultOf(capture, null).brief.findings.find(f => f.kind === "pending")!;
    expect(canRemind(pending)).toBe(true);
    expect(reminderDraft(pending, "2026-11-22").text).toContain("Breeze has you down to serve as [Role] on Sunday, November 22, with no answer yet.");
    // Planning Center's rule is unchanged: only a request it shows as sent.
    const { source: _ignored, ...planningCenter } = pending;
    void _ignored;
    expect(canRemind(planningCenter)).toBe(false);
  });

  it("never prints midnight for an event with no time of day", () => {
    for (const zone of ["America/Chicago", "Asia/Tokyo", "Pacific/Auckland", "UTC"]) {
      const t = inZone(zone, () => sunday(offTheHour(capture)));
      expect(t, zone).not.toMatch(/12:00\s?AM/u);
      expect(t, zone).toContain("Greeter · this Sunday");
    }
  });

  it("the first result says the same, and never calls the service covered", async () => {
    const app = await mount(React.createElement(SystemService, {
      connection: { ...BREEZE, church_id: "perlandera", service_id: "90001" }, onConnection: none, nowMs: Date.parse(NOW), aiOffered: true, onNext: none,
      list: async () => ({ outcome: "ok", choices: [{ id: "90001", day: "2026-11-22", name: "Event Location limit", shared: null }] }),
      read: async () => "ok", result: resultOf(capture, null), day: dayWords(null, null),
    }));
    await new Promise(r => setTimeout(r, 0));
    expect(dom.seen()).toContain("4 people are listed: 2 said yes, 1 hasn't answered, 1 said no.");
    expect(dom.seen()).toContain("Breeze doesn't share how many people each role needs, so Ozzie can't say whether");
    expect(dom.seen()).toContain("1 person is listed on this service without a role.");
    expect(dom.seen()).not.toContain("Everything Ozzie checks is covered");
    expect(dom.seen()).not.toContain("couldn't be checked");
    await app.unmount();
  });
});

describe("Also read, redesigned for every system (round 4)", () => {
  const many = breezeUntimedCapture({
    groups: Array.from({ length: 10 }, (_, i) => ({ id: `T${i}`, members: null })),
    events: Array.from({ length: 20 }, (_, i) => ({ id: `E${i}`, starts_at: "2026-11-22T00:00:00-06:00", ends_at: null, attendance: null })),
    forms: Array.from({ length: 20 }, (_, i) => ({ id: `F${i}`, submissions: i < 5 ? i + 1 : null })),
    labels: {
      ...breezeUntimedCapture().labels,
      ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`group:T${i}`, `Tag ${i}`])),
      ...Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`event:E${i}`, `Event ${i}`])),
      ...Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`form:F${i}`, `Form ${i}`])),
    },
  });
  const list = (capture = many) => text(renderToStaticMarkup(React.createElement(SystemFactsList, { capture, zone: null })));
  /** As `list`, read at seven to the hour (offTheHour) and shown on a Mac in each zone: an untimed event is never said as midnight. */
  const untimedNeverMidnight = () => {
    for (const zone of ["America/Chicago", "Asia/Tokyo", "Pacific/Auckland", "UTC"]) expect(inZone(zone, () => list(offTheHour(many))), zone).not.toMatch(/12:00\s?AM/u);
  };

  it("is one folded line, with what it read in counts", () => {
    const html = renderToStaticMarkup(React.createElement(SystemFactsList, { capture: many, zone: null }));
    expect(html.startsWith("<details")).toBe(true);
    expect(html).not.toMatch(/<details[^>]* open/u);
    expect(text(html)).toContain("Also read from Breeze: 10 tags, 20 events in the next four weeks, 20 forms");
  });

  it("lists only what Ozzie has, says each limit once, and caps long lists", () => {
    const t = list();
    expect(t).not.toMatch(/doesn't read this number|didn't count this one/u);
    expect(t.match(/Ozzie doesn't read how many people have each tag from Breeze yet\./gu)).toHaveLength(1);
    expect(t.match(/Ozzie counts entries for the 5 newest Breeze forms\./gu)).toHaveLength(1);
    expect(t.match(/Ozzie counts the people checked in by name only for the service it watches, once it has ended\./gu)).toHaveLength(1);
    // Tag names on one wrapped line; five events shown, then Show all; counted forms with their counts.
    expect(t).toContain("Tag 0, Tag 1, Tag 2");
    expect(t).toContain("Event 0, Sun, Nov 22");
    expect(t).not.toContain("Event 5,");
    expect(t).toContain("Show all 20");
    expect(t).toContain("Form 4: 5 entries");
    untimedNeverMidnight();
  });

  it("a list read cut short still lists what it read, says so once, and is counted as \"at least\" (review of round 4, L3)", () => {
    const cut = { ...many, reads: many.reads.map(r => r.read === "breeze.forms" ? { ...r, outcome: "truncated" as const } : r) };
    const t = list(cut);
    expect(t).toContain("Also read from Breeze: 10 tags, 20 events in the next four weeks, at least 20 forms");
    expect(t).toContain("Ozzie read only part of this from Breeze.");
    expect(t).toContain("Form 4: 5 entries");
    // B1 Church's forms are always cut by design: listed, with why, never as the church's whole list.
    const b1 = text(renderToStaticMarkup(React.createElement(SystemFactsList, { capture: b1Capture({ reads: readsOf(B1_READS, { "b1.forms": "truncated" }) }), zone: "America/Chicago" })));
    expect(b1).toContain("Ozzie sees only the forms the person who made the key can manage.");
    expect(b1).toContain("Serve Sign-up");
    expect(b1).toMatch(/at least 1 form\b/u);
  });

  it("B1 Church and Genesis read the same way: counts where known, names otherwise", () => {
    const b1 = text(renderToStaticMarkup(React.createElement(SystemFactsList, { capture: b1Capture(), zone: "America/Chicago" })));
    expect(b1).toContain("Also read from B1 Church:");
    expect(b1).not.toMatch(/doesn't read this number/u);
  });
});

describe("the event Ozzie picks by itself on Breeze (round 4)", () => {
  const day = [
    { id: "6001", day: "2026-11-22", name: "Event Location limit", shared: null },
    { id: "6002", day: "2026-11-22", name: "Breeze Sunday", shared: null, time: "09:35" },
    { id: "6003", day: "2026-11-22", name: "Youth Night", shared: null, time: "18:00" },
    { id: "6004", day: "2026-11-29", name: "Advent One", shared: null, time: "09:00" },
  ];

  it("prefers the one with people on it, then one with a start time, then a name like a service, and says how many there were", () => {
    expect(pickService(day.map(c => ({ ...c, people: c.id === "6003" ? 4 : 0 })), "2026-11-21")).toEqual({ choice: { ...day[2], people: 4 }, sameDay: 3, because: "people" });
    // Not every event that day counted (native counts at most 4): people never decide, so an uncounted service isn't lost.
    const five = [...day.slice(0, 3).map(c => ({ ...c, people: c.id === "6003" ? 12 : 1 })), { id: "6005", day: "2026-11-22", name: "Worship Service", shared: null, time: "10:30" }];
    expect(pickService(five, "2026-11-21")).toMatchObject({ choice: { id: "6002" }, because: "time" });
    expect(pickService(five.map(c => c.id === "6002" ? { ...c, time: null } : c), "2026-11-21")).toMatchObject({ choice: { id: "6005" }, because: "time" });
    // No counts (more than native counts, or the count failed): the timed ones first, the earliest of them.
    expect(pickService(day, "2026-11-21")).toMatchObject({ choice: { id: "6002" }, sameDay: 3, because: "time" });
    expect(pickService([{ id: "1", day: "2026-11-22", name: "Fellowship Lunch", shared: null }, { id: "2", day: "2026-11-22", name: "Sunday Worship", shared: null }], "2026-11-21"))
      .toMatchObject({ choice: { id: "2" }, because: "name" });
    // One that day: as before.
    expect(pickService([day[3]!], "2026-11-21")).toEqual({ choice: day[3], sameDay: 1, because: "first" });
    expect(pickService(day, "2026-12-01")).toBeNull();
  });

  it("says the time of day only when the event has one, never midnight", () => {
    expect(clockWords("09:35")).toBe("9:35 AM");
    expect(clockWords("18:00")).toBe("6:00 PM");
    expect(clockWords("00:30")).toBe("12:30 AM");
    expect(clockWords(null)).toBeNull();
    expect(choiceLine(day[1]!)).toBe("Sunday, November 22 at 9:35 AM · Breeze Sunday");
    expect(choiceLine(day[0]!)).toBe("Sunday, November 22 · Event Location limit");
  });

  it("the first result names how many there were that day and offers the others as a real button", async () => {
    const choices = day.map(c => ({ ...c, people: c.id === "6002" ? 2 : 0 }));
    const Host = () => {
      const [connection, setConnection] = React.useState<SystemConnection>({ ...BREEZE, church_id: "perlandera", service_id: null, service_day: null, service_name: null, result_seen: false });
      return React.createElement(SystemService, { connection, onConnection: setConnection, nowMs: Date.parse(NOW), aiOffered: true, onNext: none,
        list: async () => ({ outcome: "ok", choices }), read: async () => "ok", result: null, day: dayWords(null, null) });
    };
    const app = await mount(React.createElement(Host));
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    expect(dom.seen()).toContain("Ozzie found 3 events on Sunday, November 22. It picked Breeze Sunday at 9:35 AM, the one with the most people listed on it.");
    expect(dom.button("Choose a different one")).not.toBeNull();
    await app.unmount();
  });
});

describe("What can you do? before anything is chosen (release review L5)", () => {
  it("says no system by name on a fresh Mac, and Planning Center's own list is unchanged", () => {
    const fresh = helpFor(NOT_CHOSEN);
    expect(fresh.intro).toBe("Here is what Ozzie can do for you, from what it reads in your church's system:");
    expect(fresh.first).toMatch(/^To start, choose what your church uses in Settings, or open the fictional example/u);
    expect(`${fresh.intro} ${fresh.never} ${fresh.first}`).not.toContain("Planning Center");
    expect(helpFor(systemWords("planning-center"))).toBe(HELP);
  });
});

describe("Also read Genesis as seen live (2026-11-19)", () => {
  it("says no attendance for an event to come, a form's slug readably, and no names promise it doesn't need", () => {
    const capture = factsCapture("genesis", {
      church: { id: "ORG-maple", time_zone: "America/New_York" }, completed_at: "2026-11-25T17:00:00Z",
      events: [{ id: "picnic", starts_at: "2026-12-02T11:00:00-05:00", ends_at: "2026-12-02T14:00:00-05:00", attendance: 0 },
        { id: "dinner", starts_at: "2026-11-24T18:00:00-05:00", ends_at: "2026-11-24T20:00:00-05:00", attendance: 31 }],
      forms: [{ id: "FRMv", submissions: 18 }],
      labels: { ...factsCapture("genesis").labels, "event:picnic": "Spring Family Picnic", "event:dinner": "Harvest Dinner", "form:FRMv": "visitor-connection-card" },
    });
    const t = text(renderToStaticMarkup(React.createElement(SystemFactsList, { capture, zone: "America/New_York", folded: false })));
    // The picnic to come: its day and time, then straight on to the next event, with nothing about attendance.
    expect(t).toContain("Spring Family Picnic, Wed, Dec 2, 11:00 AM Harvest Dinner");
    expect(t).not.toContain("0 attended");
    expect(t).toContain("Harvest Dinner, Tue, Nov 24, 6:00 PM: 31 attended");
    expect(t).toContain("Visitor connection card: 18 entries");
    expect(t).not.toContain("visitor-connection-card");
    expect(t).not.toContain("hasn't happened");
    // Genesis's key reads no People: no promise about names it never reads; B1 Church and Breeze keep theirs.
    expect(systemPromises("genesis")).toContain("Ozzie reads no one's name from Genesis.");
    expect(systemPromises("genesis").join(" ")).not.toContain("stand-ins");
    for (const system of ["b1", "breeze"] as const) expect(systemPromises(system).join(" ")).toContain("The AI sees stand-ins instead.");
    expect(howToConnect("genesis")).toContain("Untick Read for People, which Genesis ticks for you: Ozzie doesn't read anyone's name from Genesis.");
  });
});
