// App-level behaviour around a church switch (review S, M1 and L5), driven through the functions App.tsx runs on every
// status: what may be shown, which Church rules apply, and which church Settings show. App's effects themselves need a
// DOM, which this repository's tests don't have; these follow the same order App applies them in.
import { describe, expect, it } from "vitest";
import { nov22Capture } from "../../../core/src/fictional-sunday.js";
import { backgroundCheckTeamIds } from "../../../core/src/kids-rules.js";
import type { SundayCapture, SundayRules } from "../../../core/src/sunday-capture.js";
import { buildHarnessData } from "../src/harness-bridge.js";
import {
  adoptRules, loadRulesByChurch, moveRules, NO_CHURCH, ofChurchInUse, onScreenCapture, rulesAtStake, rulesInUse, saveRulesByChurch, type RulesByChurch,
} from "../src/church-in-use.js";
import { backgroundChecksOn } from "../../../core/src/kids-rules.js";
import { followInUse, fresher, pendingSettings, parseSwitchQuestion, switchSettings, type ConnectionStatus, type InUse } from "../src/connection.js";

const of = (organization: string): SundayCapture => ({ ...nov22Capture(), organization });
const status = (over: Partial<ConnectionStatus>): ConnectionStatus => ({
  state: "connected", organization: "1001", checked_at_ms: 1, source: "", problem: null, ...over,
});
const inUse = (organization: string, client_id = ""): InUse => ({ organization, client_id });

describe("after a switch nothing from the old church is shown or used", () => {
  const capture1001 = of("1001");
  it("hides the old church's check from every page and from Ask Ozzie", () => {
    // Before: Ozzie uses 1001, its check is on screen.
    expect(onScreenCapture(capture1001, false, "1001", "1001")).toBe(capture1001);
    // During the question Ozzie still uses 1001: still shown.
    expect(onScreenCapture(capture1001, false, "1001", "1001")).toBe(capture1001);
    // After "Switch": Settings and the church in use are 2002. Today, Sunday, Teams, Cards, Ask and sharing all read
    // this one gated capture, so none of 1001's names or findings appear under 2002.
    const shown = onScreenCapture(capture1001, false, "2002", "2002");
    expect(shown).toBeNull();
    const data = buildHarnessData({ capture: shown, fictional: false, rules: { sundayLeads: [], checkInAfterSundaysInARow: 3 }, decisions: [], status: status({ organization: "2002" }), configured: true, now: "2026-11-20T15:00:00Z" });
    expect([data.capture, data.brief, data.operations]).toEqual([null, null, null]);
    expect(JSON.stringify(data)).not.toMatch(/Avery|Brightwater|Ellingsworth/);
    // Equally when the native church differs from the page's, for whatever reason.
    expect(onScreenCapture(capture1001, false, "1001", "2002")).toBeNull();
    // Not connected yet (no native church): the church in Settings decides, as before.
    expect(onScreenCapture(capture1001, false, "1001", undefined)).toBe(capture1001);
    // The fictional example belongs to no church and stays.
    expect(onScreenCapture(capture1001, true, "2002", "2002")).toBe(capture1001);
  });
});

describe("Church rules set for one church's teams stay with that church", () => {
  const rules1001: SundayRules = {
    sundayLeads: [{ team_id: "71", lead_position: "Lead" }], checkInAfterSundaysInARow: 4,
    rooms: [{ room_id: "81", exclusive: true, setup_minutes: 15 }],
    kidsTeams: [{ team_id: "77", min_confirmed: 2, name: "Fictional kids team" }], kidsBackgroundChecks: true,
    feedback: [],
  };
  const bound: RulesByChurch = { church: "1001", kept: {} };
  it("are kept aside on a switch and never applied to another church's teams", () => {
    expect(backgroundCheckTeamIds(rules1001)).toEqual(["77"]);
    const moved = moveRules(rules1001, bound, "2002", "Fictional Grace Church")!;
    // What applies to 2002: nothing church-specific; Sundays in a row applies to any church.
    expect(moved.rules).toEqual({ sundayLeads: [], checkInAfterSundaysInARow: 4 });
    expect(backgroundCheckTeamIds(moved.rules)).toEqual([]);
    expect(moved.store.church).toBe("2002");
    expect(moved.store.kept["1001"]?.name).toBe("Fictional Grace Church");
    // Switching back brings them back exactly.
    const back = moveRules(moved.rules, moved.store, "1001")!;
    expect(back.rules).toEqual(rules1001);
    expect(back.store).toEqual({ church: "1001", kept: {} });
  });
  it("include the forms watched and the Check-Ins rooms matched: another church never reads them", () => {
    const withChurchReads: SundayRules = { ...rules1001, forms: { on: true, watched: ["610"] }, checkIns: { event_id: "620", rooms: [{ location_id: "650", team_id: "77" }] } };
    const moved = moveRules(withChurchReads, bound, "2002")!;
    expect(moved.rules).toEqual({ sundayLeads: [], checkInAfterSundaysInARow: 4 });
    expect(moveRules(moved.rules, moved.store, "1001")!.rules).toEqual(withChurchReads);
    // Forms turned on alone is a rule for that church, named in the switch question.
    const formsOnly: SundayRules = { sundayLeads: [], checkInAfterSundaysInARow: 0, forms: { on: true, watched: [] } };
    expect(rulesAtStake({ from: "1001", to: "2002" }, formsOnly, bound).from).toBe(true);
  });
  it("aren't used in the moment before they are moved, and the first church seen adopts them", () => {
    expect(backgroundCheckTeamIds(rulesInUse(rules1001, bound, "2002"))).toEqual([]);
    expect(rulesInUse(rules1001, bound, "1001")).toBe(rules1001);
    expect(rulesInUse(rules1001, bound, undefined)).toBe(rules1001);
    expect(moveRules(rules1001, NO_CHURCH, "1001")).toEqual({ rules: rules1001, store: { church: "1001", kept: {} } });
    expect(moveRules(rules1001, bound, "1001")).toBeNull();
  });
  it("are named in the question when they are at stake", () => {
    expect(rulesAtStake({ from: "1001", to: "2002" }, rules1001, bound)).toEqual({ from: true, to: false });
    expect(rulesAtStake({ from: "1001", to: "2002" }, { sundayLeads: [], checkInAfterSundaysInARow: 4 }, { church: "1001", kept: { "2002": { rules: {} } } }))
      .toEqual({ from: false, to: true });
  });
});

describe("Settings follow the church Ozzie uses natively", () => {
  /** App's order on each status: drop older ones, keep Settings on the church in use while asking, follow a change. */
  function apply(page: { settings: typeof start; newest: number; last: string | null }, next: ConnectionStatus) {
    if (!fresher(next, page.newest)) return page;
    let { settings } = page;
    const kept = pendingSettings(settings, parseSwitchQuestion(next.switch));
    if (kept) settings = kept;
    const followed = followInUse(settings, next.in_use, page.last);
    return { settings: followed.settings ?? settings, newest: next.revision ?? page.newest, last: followed.last };
  }
  const start = { clientId: "", organization: "1001", serviceTypeId: "11", planId: "22" };
  const question = { id: 1, to: "2002", from: "1001", from_client: "", others: ["1001"], fresh: true };
  it("after an answer, even when an older poll arrives later", () => {
    let page = { settings: start, newest: 0, last: null as string | null };
    page = apply(page, status({ revision: 3, in_use: inUse("1001") }));
    page = apply(page, status({ revision: 4, switch: question, in_use: inUse("1001"), state: "stored-unchecked" }));
    expect(page.settings).toEqual(start);
    // The answer's status (revision 6), then a poll read just before it (revision 4, still asking) resolves late.
    page = apply(page, status({ revision: 6, organization: "2002", in_use: inUse("2002") }));
    page = apply(page, status({ revision: 4, switch: question, in_use: inUse("1001"), state: "stored-unchecked" }));
    expect(page.settings).toEqual({ clientId: "", organization: "2002", serviceTypeId: "", planId: "" });
  });
  it("after a window reopened while an answer was carried out", () => {
    const reopened = apply({ settings: start, newest: 0, last: null }, status({ revision: 9, organization: "2002", in_use: inUse("2002") }));
    expect(reopened.settings.organization).toBe("2002");
  });
  it("and not while IDs for another church are being typed under Advanced", () => {
    let page = { settings: start, newest: 0, last: null as string | null };
    page = apply(page, status({ revision: 3, in_use: inUse("1001") }));
    page = { ...page, settings: { ...page.settings, clientId: "fictional-own-client", organization: "2002" } };
    page = apply(page, status({ revision: 3, in_use: inUse("1001") }));
    expect(page.settings.organization).toBe("2002");
    // A pasted sign-in for it opens the question: Settings show 1001 again until the person switches.
    page = apply(page, status({ revision: 5, switch: question, in_use: inUse("1001"), state: "stored-unchecked" }));
    expect(page.settings).toEqual(start);
    page = apply(page, status({ revision: 6, organization: "2002", in_use: inUse("2002", "fictional-own-client") }));
    expect(page.settings).toEqual(switchSettings(start, { client_id: "fictional-own-client", organization: "2002" }));
  });
});

// What a v0.1.0 install has in ozzie.rules.v1 and ozzie.settings.v1 (fictional ids). Ported from review S2's page probe.
const v010Rules = {
  sundayLeads: [{ team_id: "71", lead_position: "Lead" }], checkInAfterSundaysInARow: 4,
  rooms: [{ room_id: "9", exclusive: true, setup_minutes: 10 }],
  kidsTeams: [{ team_id: "88", min_confirmed: 2, name: "Kids" }], kidsBackgroundChecks: true,
  feedback: [],
} as SundayRules;
const v010Settings = { clientId: "", organization: "513367", serviceTypeId: "123", planId: "456" };

describe("upgrading from v0.1.0 keeps every rule and setting", () => {
  it("first launch, restart, a late status and the church in use dropping out for a moment change nothing", () => {
    // App's initial state: the rules are adopted for the church in Settings.
    let store = adoptRules(NO_CHURCH, v010Settings.organization);
    expect(store).toEqual({ church: "513367", kept: {} });
    // Before any status, and while in_use drops out during a Keychain write: the rules as set.
    expect(rulesInUse(v010Rules, store, undefined, v010Settings.organization)).toBe(v010Rules);
    // The launch check reports 513367: nothing moves.
    expect(moveRules(v010Rules, store, "513367", undefined, v010Settings.organization)).toBeNull();
    expect(rulesInUse(v010Rules, store, "513367", v010Settings.organization)).toBe(v010Rules);
    expect(backgroundChecksOn(rulesInUse(v010Rules, store, "513367", v010Settings.organization))).toBe(true);
    // Settings and the chosen Sunday are untouched.
    expect(followInUse(v010Settings, { organization: "513367", client_id: "" }, null).settings).toBeNull();
    expect(followInUse(v010Settings, { organization: "513367", client_id: "", name: "Fictional Grace Church" }, "513367|").settings).toBeNull();
    expect(pendingSettings(v010Settings, undefined)).toBeNull();
    // Even if a build without the initial adoption first saw 513367, the result is the same.
    const moved = moveRules(v010Rules, NO_CHURCH, "513367", undefined, v010Settings.organization)!;
    expect(moved.rules).toBe(v010Rules);
    store = moved.store;
    expect(store).toEqual({ church: "513367", kept: {} });
  });
  it("signing in to another organization first files the rules under the church they were set for (review S2, M3)", () => {
    // 513367's sign-in isn't working at the first launch, and the browser's Planning Center login is another church.
    const first = moveRules(v010Rules, NO_CHURCH, "2002", undefined, v010Settings.organization)!;
    expect(first.store.church).toBe("2002");
    expect(backgroundChecksOn(first.rules)).toBe(false);
    expect(first.rules).toEqual({ sundayLeads: [], checkInAfterSundaysInARow: 4 });
    expect(first.store.kept["513367"]?.rules.kidsTeams).toEqual(v010Rules.kidsTeams);
    // And while that move hasn't run yet, 513367's rules don't apply to 2002.
    expect(backgroundChecksOn(rulesInUse(v010Rules, NO_CHURCH, "2002", v010Settings.organization))).toBe(false);
    // Back on 513367: its own rules come back, background-check rule on.
    const back = moveRules(first.rules, first.store, "513367")!;
    expect(back.rules).toEqual(v010Rules);
    expect(backgroundChecksOn(back.rules)).toBe(true);
  });
  it("keeps a church's background-check rule turned off across a switch and back (review S2, N5)", () => {
    const off = { sundayLeads: [], checkInAfterSundaysInARow: 3, kidsBackgroundChecks: false } as SundayRules;
    const away = moveRules(off, { church: "1001", kept: {} }, "2002")!;
    expect(away.rules.kidsBackgroundChecks).toBeUndefined();
    expect(moveRules(away.rules, away.store, "1001")!.rules.kidsBackgroundChecks).toBe(false);
  });
});

describe("a check that finishes or is reused after a switch is dropped (review S2, L1)", () => {
  it("belongs only while it is of the church in use", () => {
    const check1001 = of("1001");
    expect(ofChurchInUse(check1001, "1001", "1001")).toBe(true);
    expect(ofChurchInUse(check1001, "1001", undefined)).toBe(true);
    expect(ofChurchInUse(check1001, "2002", "2002")).toBe(false);
    expect(ofChurchInUse(check1001, "1001", "2002")).toBe(false);
  });
});

describe("a damaged record of which church the rules belong to (review S3, L4)", () => {
  it("is read as no church, so the rules go to the church in Settings and are never filed where they'd be dropped", () => {
    const stored = new Map<string, string>();
    const local = { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => { stored.set(k, v); }, removeItem: (k: string) => { stored.delete(k); } };
    const previous = (globalThis as { localStorage?: unknown }).localStorage;
    (globalThis as { localStorage?: unknown }).localStorage = local;
    try {
      for (const church of ["abc", "0513367", " 513367", "513367x"]) {
        stored.set("ozzie.rules-by-church.v1", JSON.stringify({ church, kept: {} }));
        const store = loadRulesByChurch();
        expect(store.church, church).toBe("");
        expect(adoptRules(store, v010Settings.organization).church).toBe("513367");
      }
      // A sound record reads back as written.
      saveRulesByChurch({ church: "513367", kept: { "2002": { rules: { rooms: [] }, name: "Fictional Hope Chapel" } } });
      expect(loadRulesByChurch()).toEqual({ church: "513367", kept: { "2002": { rules: { rooms: [] }, name: "Fictional Hope Chapel" } } });
    } finally {
      (globalThis as { localStorage?: unknown }).localStorage = previous;
    }
  });
});
