// Round 2's loose ends for a church on B1 Church or Breeze: a key let go of is removed for sure (tried again when the
// Keychain refuses, never the one in use); B1 Church's plans listed a day early far ahead of UTC still count as upcoming;
// Check my setup and its report say the church's own system, never Planning Center's connection in its place; Finish
// setting up speaks the system's name. Fictional data; no native side.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => new Promise(() => {})) }));
import { letChurchGo, letGoAgain, letGoStore, SystemWordsContext, systemWords, type ChurchSystemState } from "../src/church-system.js";
import { listedToday, soonest } from "../src/system-setup.js";
import { reportFor, setupRows, type CheckFacts, type SetupKnown } from "../src/check-setup.js";
import { FinishSettingUp, type FinishFacts } from "../src/finish-list.js";
import type { ConnectionStatus } from "../src/connection.js";

const memory = () => { const kept = new Map<string, string>(); return { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => { kept.set(k, v); } }; };
const B1_STATE: ChurchSystemState = { main: "b1", genesis: { system: "genesis", church_id: "ORG-maple", church_name: null, zone: "America/Denver" },
  connection: { system: "b1", church_id: "CHU0000cedar", church_name: "Cedar Hollow Fellowship", address: "cedarhollow", service_id: "PLA0000nov22", service_day: "2026-11-22",
    service_name: "Sunday Gathering", zone: "America/Chicago", result_seen: true } };

describe("letting a church's key go", () => {
  it("removes it and its saved checks, or keeps it to try again when the Keychain refuses", async () => {
    const later = letGoStore(memory());
    const calls: string[] = [];
    let answer = "locked";
    const bridge = {
      forget: async (system: string, church: string) => { calls.push(`forget ${system} ${church}`); return answer; },
      deleteChecks: async (system: string, church: string) => { calls.push(`delete ${system} ${church}`); return "deleted"; },
    };
    expect(await letChurchGo({ system: "b1", church_id: "CHU0000old" }, bridge, later)).toBe(false);
    expect(later.get()).toEqual([{ system: "b1", church_id: "CHU0000old" }]);
    expect(calls).toEqual(["forget b1 CHU0000old"]);
    // Tried again (at launch, or when the church connected changes): this time it goes, with its saved checks.
    answer = "forgotten";
    await letGoAgain(B1_STATE, bridge, later);
    expect(later.get()).toEqual([]);
    expect(calls.slice(1)).toEqual(["forget b1 CHU0000old", "delete b1 CHU0000old"]);
  });

  it("never lets go of the church in use, or Genesis read beside it, even when it was kept to let go of", async () => {
    const later = letGoStore(memory());
    later.add({ system: "b1", church_id: "CHU0000cedar" });
    later.add({ system: "genesis", church_id: "ORG-maple" });
    later.add({ system: "breeze", church_id: "oldchurch" });
    const forgotten: string[] = [];
    await letGoAgain(B1_STATE, { forget: async (s, c) => { forgotten.push(`${s} ${c}`); return "forgotten"; }, deleteChecks: async () => "deleted" }, later);
    expect(forgotten).toEqual(["breeze oldchurch"]);
    expect(later.get()).toEqual([]);
  });

  it("keeps only well-formed entries, and at most twenty", () => {
    const store = memory();
    store.setItem("ozzie.church-system.let-go.v1", JSON.stringify([{ system: "b1", church_id: "ok_1" }, { system: "planning-center", church_id: "x" }, { system: "b1", church_id: "../x" }, "junk"]));
    expect(letGoStore(store).get()).toEqual([{ system: "b1", church_id: "ok_1" }]);
    const many = letGoStore(memory());
    for (let i = 0; i < 25; i++) many.add({ system: "breeze", church_id: `church${i}` });
    expect(many.get()).toHaveLength(20);
  });
});

describe("B1 Church's plans far ahead of UTC", () => {
  it("count a plan B1 lists a day early as upcoming on its own morning", () => {
    // Sunday 10:00 AM in Auckland is Saturday 21:00 UTC: B1 lists Sunday's plan as Saturday.
    const ms = Date.parse("2026-11-21T21:00:00Z");
    expect(listedToday("b1", ms, "2026-11-22")).toBe("2026-11-21");
    const choices = [{ id: "PLAthis", day: "2026-11-21", name: "Sunday Gathering", shared: true }, { id: "PLAnext", day: "2026-11-28", name: "Sunday Gathering", shared: true }];
    expect(soonest(choices, listedToday("b1", ms, "2026-11-22"))?.id).toBe("PLAthis");
    // Breeze lists each event on its own day: this Mac's date.
    expect(listedToday("breeze", ms, "2026-11-22")).toBe("2026-11-22");
    // West of UTC this Mac's date is the earlier: unchanged there (Saturday 7:30 PM in Chicago is Sunday in UTC).
    expect(listedToday("b1", Date.parse("2026-11-22T01:30:00Z"), "2026-11-21")).toBe("2026-11-21");
  });
});

describe("Check my setup for a church on B1 Church", () => {
  const signedOut: ConnectionStatus = { state: "disconnected", organization: "", checked_at_ms: null, source: "", problem: null };
  const known: SetupKnown = { connection: signedOut, watched: { service: "Sunday Gathering", follows: true, date: "Sunday, November 22" }, waiting: true, ai: null,
    system: { name: "B1 Church", church: "Cedar Hollow Fellowship", connected: true, id: "b1" } };
  const facts: CheckFacts = { check: null, notices: "unknown", startOn: true };

  it("says the system's connection on its own row, and the service waiting for its next plan, which Ozzie finds by itself", () => {
    const rows = setupRows(facts, known, { date: "Sunday, November 22", zone: "America/Chicago" });
    expect(rows[0]).toMatchObject({ label: "B1 Church", verdict: "Connected to Cedar Hollow Fellowship" });
    expect(rows.find(r => r.id === "service")?.verdict).toBe("Waiting for the next Sunday Gathering plan");
    expect(setupRows(facts, { ...known, system: { ...known.system!, name: "Breeze", id: "breeze" } }).find(r => r.id === "service")?.verdict)
      .toBe("Waiting for the next Sunday Gathering event");
  });

  it("reports B1 Church's connection as its own, and Planning Center as what is known of it, never as connected in its place", () => {
    const rows = setupRows(facts, known, { zone: "America/Chicago" });
    const report = reportFor(facts, known, rows, Date.parse("2026-11-20T15:00:00Z"));
    expect(report).toContain("church-system: b1\n");
    expect(report).toContain("church-system-connection: connected\n");
    expect(report).toContain("planning-center: not-connected\n");
    expect(report).not.toContain("Cedar Hollow");
    expect(report).not.toContain("Sunday Gathering");
  });
});

describe("Finish setting up for a church on another system", () => {
  const facts: FinishFacts = { start: { asked: true, on: true }, service: { deferred: false, watching: true }, kids: { looking: false, answered: false },
    ai: { left: false, chosen: true }, plan: { waiting: true, found: false, service: "Sunday Gathering" } };
  const shown = (system: "b1" | "breeze") => renderToStaticMarkup(React.createElement(SystemWordsContext.Provider, { value: systemWords(system) },
    React.createElement(FinishSettingUp, { facts, onStartWithMac: () => {}, onChooseService: () => {}, onKidsRules: () => {}, onChooseAi: () => {},
      store: { get: () => ({ notNow: [], hidden: false }), notNow: () => {}, hide: () => {} } }))).replace(/&#x27;/gu, "'");
  it("says the next plan or event is found in the church's own system", () => {
    expect(shown("b1")).toContain("When someone at your church adds the next Sunday Gathering plan in B1 Church, Ozzie finds it by itself and watches it.");
    expect(shown("breeze")).toContain("adds the next Sunday Gathering event in Breeze");
    expect(shown("b1")).not.toContain("Planning Center");
  });
});
