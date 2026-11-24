// The kids rule for a church on B1 Church or Breeze (0.10.0): marking on Church rules, the card on the Services page, Today's
// line, the spoken briefing, Keeping watch and its notice, the jobs, and Settings, each in the system's own words, from
// fixed fictional checks with no native side. Planning Center's pages are unchanged by any of it.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => new Promise(() => {})) }));
import { installFakeDom } from "./fake-dom.js";
import { churchSystemStore, SystemWordsContext, systemWords, type SystemConnection } from "../src/church-system.js";
import { RulesPage, SYSTEM_RULES } from "../src/rules-page.js";
import { SYSTEM_KIDS_WORDS } from "../src/system-kids-rules.js";
import { fewConfirmedBody, fewConfirmedTitle, SundayPage } from "../src/sunday-page.js";
import { decisionLines } from "../src/today-groups.js";
import { useSystemChurch, type SystemChurch } from "../src/system-church.js";
import { systemDigest, createSystemProactive, systemCheck } from "../src/system-watch.js";
import { systemJobBrief, systemJobCheck, systemJobHarness } from "../src/system-jobs.js";
import { KIDS_WITH, ONLY_PLANNING_CENTER } from "../src/system-settings.js";
import type { KeyValueStore, ProactiveContext, ProactiveHooks, SystemWatch } from "../src/proactive.js";
import type { Settings } from "../src/sunday-source.js";
import { buildSystemBrief } from "../../../core/src/church-systems/brief.js";
import { kidsChoices, kidsMarked, withSystemKids } from "../../../core/src/church-systems/kids.js";
import type { SystemCapture } from "../../../core/src/church-systems/types.js";
import { buildSpokenBriefing } from "../../../core/src/spoken-briefing.js";
import type { SundayRules } from "../../../core/src/sunday-capture.js";
import { applyDecisions } from "../../../core/src/sunday-decisions.js";
import { b1KidsCapture, breezeKidsCapture, breezeUntimedCapture, NOW } from "../../../core/test/church-systems/fixtures.js";

const dom = installFakeDom();
const text = (html: string) => html.replace(/<[^>]+>/gu, " ").replace(/&#x27;/gu, "'").replace(/&amp;/gu, "&").replace(/&quot;/gu, "\"").replace(/\s+/gu, " ");
const none = () => {};
const NONE: SundayRules = { sundayLeads: [], checkInAfterSundaysInARow: 3 };
const B1_CHURCH = "b1:CHU0000cedar", BREEZE_CHURCH = "breeze:juniperstreet";
const B1_RULES = withSystemKids(NONE, B1_CHURCH, "GRP-kids", 2, "Kids Ministry");
const BREEZE_RULES = withSystemKids(NONE, BREEZE_CHURCH, "nursery", 2, "Nursery");
const B1: SystemConnection = { system: "b1", church_id: "CHU0000cedar", church_name: "Cedar Hollow Fellowship", address: "cedarhollow", service_id: "PLA0000nov22",
  service_day: "2026-11-22", service_name: "Sunday Gathering", zone: "America/Chicago", result_seen: true };
const names = { ...b1KidsCapture().names, ...breezeKidsCapture().names };

function briefOf(capture: SystemCapture, rules: SundayRules) {
  const built = buildSystemBrief(capture, { confirmedZone: capture.church.time_zone, ...(rules.systemKids ? { systemKids: rules.systemKids } : {}) }, NOW);
  if (!built.ok) throw new Error(built.reason);
  return built.brief;
}
const kidsFinding = (capture: SystemCapture, rules: SundayRules) => briefOf(capture, rules).findings.find(f => f.kind === "too-few-confirmed")!;
const rulesPage = (system: "b1" | "breeze" | "planning-center", rules: SundayRules, systemKids: Parameters<typeof RulesPage>[0]["systemKids"] = null) => text(renderToStaticMarkup(
  React.createElement(SystemWordsContext.Provider, { value: systemWords(system) }, React.createElement(RulesPage, { rules, onChange: none, positions: [], systemKids }))));

describe("Church rules on B1 Church and Breeze", () => {
  it("B1 Church: marks its teams, says what confirmed means there, and that background checks aren't read", () => {
    const t = rulesPage("b1", NONE, { system: "b1", church: B1_CHURCH, choices: kidsChoices(b1KidsCapture()), untied: 1 });
    const w = SYSTEM_KIDS_WORDS.b1;
    for (const line of [w.title, w.body, w.times, w.checks, w.untied!(1)]) expect(t).toContain(line);
    expect(t).toContain("Kids Ministry serves with kids");
    expect(t).toContain("Its roles: Nursery, Preschool");
    expect(t).toContain(SYSTEM_RULES(systemWords("b1")));
    expect(SYSTEM_RULES(systemWords("b1"))).toBe("With B1 Church, Ozzie checks what B1 Church shares about the service: its roles, how many people each needs and who answered, who on each role's team could help, and their blockouts, and the kids teams you mark below. Rules for scheduled leads, background checks, rooms, and serving many weeks in a row work with Planning Center only for now. Ozzie can't read background checks from B1 Church.");
    // Planning Center's own Kids teams section, and its background-check rule, aren't offered here.
    expect(t).not.toContain("Ask for a current background check");
  });

  it("Breeze: marks its roles by name, since Breeze ties no team to them", () => {
    const t = rulesPage("breeze", BREEZE_RULES, { system: "breeze", church: BREEZE_CHURCH, choices: kidsChoices(breezeKidsCapture()), untied: 0 });
    const w = SYSTEM_KIDS_WORDS.breeze;
    for (const line of [w.title, w.body, w.checks]) expect(t).toContain(line);
    expect(t).toContain("Nursery serves with kids");
    expect(t).toContain("Confirmed at each service");
    expect(t).toContain("people who accepted, not counting anyone who hasn't answered");
    expect(SYSTEM_RULES(systemWords("breeze"))).toContain("and the kids roles you mark below. Rules for scheduled leads, background checks, rooms");
    expect(SYSTEM_RULES(systemWords("breeze"))).not.toMatch(/kids teams and background checks/u);
  });

  it("Genesis: says kids rules work where volunteer schedules are shared, never that they are Planning Center's only (review L5)", () => {
    expect(SYSTEM_RULES(systemWords("genesis"))).toBe("With Genesis, Ozzie checks no service: Genesis doesn't share volunteer schedules. It shows the events coming up, how many attended the ones that have ended, your groups, and how many times each form was filled in. Kids rules work with Planning Center, B1 Church and Breeze, which share volunteer schedules. Rules for scheduled leads, background checks, rooms, and serving many weeks in a row work with Planning Center only for now. Ozzie can't read background checks from Genesis.");
  });

  it("lists a mark that isn't in the last check, so it can be removed", () => {
    const t = rulesPage("b1", withSystemKids(NONE, B1_CHURCH, "GRP-youth", 3, "Youth"), { system: "b1", church: B1_CHURCH, choices: kidsChoices(b1KidsCapture()), untied: 0 });
    expect(t).toContain("Youth Not in the last check. 3 confirmed at each service. Unmark this team");
  });

  it("marking a team and changing its count change only that church's rules", async () => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    let rules = NONE;
    const root = createRoot(dom.root as unknown as Element);
    const draw = () => root.render(React.createElement(SystemWordsContext.Provider, { value: systemWords("b1") }, React.createElement(RulesPage, {
      rules, onChange: next => { rules = next; draw(); }, positions: [], systemKids: { system: "b1", church: B1_CHURCH, choices: kidsChoices(b1KidsCapture()), untied: 0 } })));
    try {
      await act(async () => { draw(); });
      const props = (id: string) => {
        const find = (n: { childNodes: unknown[]; getAttribute?: (a: string) => string | null }): unknown => n.getAttribute?.("id") === id ? n
          : n.childNodes.map(c => find(c as typeof n)).find(Boolean);
        const el = find(dom.root as unknown as { childNodes: unknown[] }) as Record<string, { onChange?: (e: unknown) => void }>;
        return el[Object.keys(el).find(k => k.startsWith("__reactProps$"))!]!;
      };
      // Kids Ministry is the third team the check offers.
      await act(async () => { props("kids-b1-2").onChange?.({ target: { checked: true } }); });
      expect(rules.systemKids).toEqual({ [B1_CHURCH]: [{ id: "GRP-kids", min_confirmed: 2, name: "Kids Ministry" }] });
      await act(async () => { props("kids-min-b1-2").onChange?.({ target: { value: "3" } }); });
      expect(rules.systemKids).toEqual({ [B1_CHURCH]: [{ id: "GRP-kids", min_confirmed: 3, name: "Kids Ministry" }] });
      expect(rules.kidsTeams).toBeUndefined();
      await act(async () => { props("kids-b1-2").onChange?.({ target: { checked: false } }); });
      expect(rules).toEqual(NONE);
    } finally {
      await act(async () => { root.unmount(); });
    }
  });

  it("Planning Center's Church rules page is unchanged by marks kept for another system's church", () => {
    const pc: SundayRules = { ...NONE, kidsTeams: [{ team_id: "101", min_confirmed: 2, name: "Nursery" }] };
    expect(rulesPage("planning-center", { ...pc, systemKids: B1_RULES.systemKids! })).toBe(rulesPage("planning-center", pc));
    expect(rulesPage("planning-center", pc)).toContain("Ask for a current background check before anyone serves on these teams");
  });
});

describe("the kids card, Today and the briefing on B1 Church and Breeze", () => {
  it("B1 Church: who accepted, who was asked and who wasn't sent the request yet, in B1 Church's words", () => {
    const f = kidsFinding(b1KidsCapture(), B1_RULES);
    expect(fewConfirmedTitle(f, undefined, false, "America/Chicago")).toBe("Only 1 person has accepted in Kids Ministry this Sunday.");
    expect(fewConfirmedBody(f)).toBe("1 more is asked but hasn't answered. 1 more is penciled in, but the request hasn't been sent. Your Church rules ask for at least 2 confirmed. Ozzie counts people who accepted in B1 Church as confirmed; it doesn't check ages.");
  });

  it("Breeze: never says a request was or wasn't sent", () => {
    const f = kidsFinding(breezeKidsCapture(), BREEZE_RULES);
    expect(fewConfirmedTitle(f, undefined, false, "America/New_York")).toBe("Only 1 person has accepted in Nursery at 10:30 AM.");
    expect(fewConfirmedBody(f)).toBe("1 more hasn't answered yet; Breeze doesn't say whether the request was sent. Your Church rules ask for at least 2 confirmed. Ozzie counts people who accepted in Breeze as confirmed; it doesn't check ages.");
  });

  it("Planning Center's card words are as before", () => {
    // Planning Center's findings carry their service time; B1 Church's are said by the day.
    const b1 = kidsFinding(b1KidsCapture(), B1_RULES);
    const pc = { ...b1, position: { ...b1.position!, interval: { starts_at: "2026-11-22T09:00:00-06:00", ends_at: "2026-11-22T10:30:00-06:00" } }, source: undefined, waiting: undefined } as unknown as Parameters<typeof fewConfirmedBody>[0];
    delete (pc as { source?: string }).source;
    expect(fewConfirmedTitle(pc, undefined, false, "America/Chicago")).toBe("Only 1 confirmed person in Kids Ministry at 9:00 AM.");
    expect(fewConfirmedBody(pc)).toBe("1 more is asked but hasn't answered. 1 more is penciled in, but the request hasn't been sent. Your Church rules ask for at least 2. Ozzie counts confirmed people; it doesn't check ages.");
  });

  it("shows on the Services page with why, its source and check time, and no Planning Center", () => {
    const brief = briefOf(b1KidsCapture(), B1_RULES);
    const t = text(renderToStaticMarkup(React.createElement(SystemWordsContext.Provider, { value: systemWords("b1") }, React.createElement(SundayPage, {
      brief, names, busy: false, problem: "", sender: "Pat", connected: true, hasRecording: false, configured: true, canReword: false, decisions: [],
      onDecisions: none, operations: null, onCheck: none, onRecording: none, onExample: none, openInPlanningCenter: null,
    }))));
    expect(t).toContain("Only 1 person has accepted in Kids Ministry");
    expect(t).toContain("Why I flagged this");
    expect(t).toContain("B1 Church");
    expect(t).toContain("Ozzie can't read background checks from B1 Church");
    expect(t).not.toContain("Planning Center");
  });

  it("counts on Today as a decision, named by its team, with no one's name", () => {
    const brief = briefOf(b1KidsCapture(), B1_RULES);
    const lines = decisionLines(applyDecisions(brief, []).items, { rooms: 0, followUps: 0 }, "America/Chicago").named.map(l => l.text);
    expect(lines.find(l => l.startsWith("Kids Ministry: fewer confirmed people than your rule asks"))).toBeDefined();
    expect(lines.find(l => l.startsWith("Kids Ministry"))).not.toContain("9:00 AM");
    for (const line of lines) for (const name of Object.values(names)) expect(line).not.toContain(name);
  });

  it("the spoken briefing says it in the system's words, with no names", () => {
    for (const [capture, rules, said] of [
      [b1KidsCapture(), B1_RULES, "Only one person has accepted in Kids Ministry this Sunday. Your Church rules ask for at least 2 confirmed. 2 more haven't answered yet."],
      [breezeKidsCapture(), BREEZE_RULES, "Only one person has accepted in Nursery at the 10:30 AM service. Your Church rules ask for at least 2 confirmed. One more hasn't answered yet."],
      // The first decision opens "For Sunday, " in lower case; a Breeze event with no time of day says its day.
      [breezeUntimedCapture(), withSystemKids(NONE, "breeze:perlandera", "greeter", 1, "Greeter"),
        "For Sunday, no one has accepted in Greeter this Sunday. Your Church rules ask for at least 1 confirmed. One more hasn't answered yet."],
    ] as const) {
      const b = buildSpokenBriefing({ attention: null, sunday: briefOf(capture, rules) }, { timeZone: capture.church.time_zone! });
      expect(b.text).toContain(said);
      for (const name of Object.values(capture.names)) expect(b.text).not.toContain(name);
      expect(b.text).not.toContain("Planning Center");
    }
  });
});

describe("Keeping watch, jobs and Settings on B1 Church and Breeze", () => {
  const settings: Settings = { clientId: "", organization: "", serviceTypeId: "", planId: "" };
  const watchOf = (capture: SystemCapture): SystemWatch => ({ connection: B1, read: async () => capture });
  const ctx = (rules: SundayRules, capture = b1KidsCapture()): ProactiveContext => ({ settings, rules, status: null, system: watchOf(capture) });

  it("the schedule compares the brief with the kids team in it, and counts it as a decision", () => {
    const without = systemDigest(b1KidsCapture(), ctx(NONE), NOW)!;
    const marked = systemDigest(b1KidsCapture(), ctx(B1_RULES), NOW)!;
    expect(marked.brief.findings.some(f => f.kind === "too-few-confirmed")).toBe(true);
    expect(without.brief.findings.some(f => f.kind === "too-few-confirmed")).toBe(false);
    expect(marked.record.decisions).toBe(without.record.decisions + 1);
    // Nothing the schedule keeps names anyone.
    for (const name of Object.values(names)) expect(JSON.stringify(marked.record)).not.toContain(name);
  });

  it("tells a kids team's yes turning into a no with native's fixed notice, naming no one", async () => {
    const data = new Map<string, string>();
    const store: KeyValueStore = { get: k => data.get(k) ?? null, set: (k, v) => { data.set(k, v); } };
    let now = "2026-11-20T15:00:04Z";
    let capture = b1KidsCapture();
    const notify = vi.fn(async (options?: unknown) => { void options; });
    const p = createSystemProactive({
      store, now: () => now, timeZone: () => "UTC", notify, found: vi.fn(),
      check: (c, _s, _t, _source, onTask) => { onTask?.("task"); return systemCheck(c, w => w.read()); },
      timers: { setInterval: () => 0, clearInterval: () => {} },
    });
    const hooks: ProactiveHooks<SystemCapture> = {
      context: () => ({ settings, rules: B1_RULES, status: null, system: { connection: B1, read: async () => ({ ...capture, completed_at: now, reads: capture.reads.map(r => ({ ...r, checked_at: now })), started_at: now }) } }),
      onStatus: () => {}, onCapture: vi.fn(), onFailure: vi.fn(),
    };
    try {
      p.start(hooks);
      await p.tick();
      expect(notify).not.toHaveBeenCalled();
      // Ivy, the one person who accepted in Kids Ministry, now says no.
      capture = b1KidsCapture({ assignments: b1KidsCapture().assignments.map(a => a.person_id === "PER-ivy" ? { ...a, status: "declined" as const } : a) });
      now = "2026-11-20T16:00:04Z";
      await p.tick();
      expect(notify).toHaveBeenCalledTimes(1);
      const options = notify.mock.calls[0]![0] as Record<string, unknown> | undefined;
      expect(Object.keys(options ?? {}).every(k => k === "localOnly" || k === "day")).toBe(true);
      for (const [, v] of data) for (const name of Object.values(names)) expect(v).not.toContain(name);
    } finally {
      p.stop();
    }
  });

  it("the jobs read the same brief, and Ask's data for them carries the church's own marks", () => {
    const check = systemJobCheck(b1KidsCapture(), "America/Chicago")!;
    const built = systemJobBrief(check, B1_RULES, NOW);
    if (!built.ok) throw new Error(built.reason);
    expect(built.brief.findings.filter(f => f.kind === "too-few-confirmed").map(f => f.position?.name)).toEqual(["Kids Ministry"]);
    expect(systemJobHarness(check, B1_RULES, [], NOW)?.kids).toEqual(kidsMarked(b1KidsCapture(), B1_RULES));
    expect(systemJobHarness(check, NONE, [], NOW)?.kids).toBeUndefined();
  });

  it("the page's brief for the church connected includes its kids team", async () => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const kept = new Map<string, string>();
    const store = churchSystemStore({ getItem: k => kept.get(k) ?? null, setItem: (k, v) => { kept.set(k, v); } });
    store.set({ main: "b1", connection: B1, genesis: null });
    const bridge = { check: async () => ({ outcome: "ok", capture: null }), savedChecks: async () => [], loadCheck: async () => ({ outcome: "not-found", capture: null }) };
    const held: { sys: SystemChurch | null } = { sys: null };
    function Probe() { held.sys = useSystemChurch(NOW, { feedback: [], systemKids: B1_RULES.systemKids }, async () => b1KidsCapture(), store, bridge); return null; }
    const root = createRoot(dom.root as unknown as Element);
    try {
      await act(async () => { root.render(React.createElement(Probe)); });
      await act(async () => { held.sys!.take(b1KidsCapture()); });
      expect(held.sys!.built?.brief.findings.some(f => f.kind === "too-few-confirmed" && f.position?.name === "Kids Ministry")).toBe(true);
    } finally {
      await act(async () => { root.unmount(); });
    }
  });

  it("Settings says the kids rule works there, and that background checks aren't read there", () => {
    expect(KIDS_WITH("b1")).toBe("Kids teams work with B1 Church too: mark the teams that serve with kids in Church rules, and Ozzie counts who accepted on them. Ozzie can't read background checks from B1 Church, so it doesn't check them there.");
    expect(KIDS_WITH("breeze")).toContain("mark the roles that serve with kids in Church rules");
    // The sentence about what still works with Planning Center only is unchanged.
    expect(ONLY_PLANNING_CENTER("B1 Church")).not.toMatch(/kids/iu);
  });
});
