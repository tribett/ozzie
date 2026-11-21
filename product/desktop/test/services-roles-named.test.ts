// Lines that speak of every service at once name each role's service while more than one is watched (rehearsal of
// 0.5.2): Today's decisions and its waiting-for-an-answer card, Thursday's "Ready for" brief, the spoken briefing, and
// Keeping watch's "What it does". Two services with a Greeter each; with one service every line reads as before. Fixed
// fictional data, clock pinned to the fictional check.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { mergeParts, teamServices } from "../src/services-merge.js";
import { decisionLines } from "../src/today-groups.js";
import { sundayReadyLine } from "../src/sunday-ready.js";
import { ProactivePage } from "../src/proactive-page.js";
import type { ProactiveView } from "../src/proactive.js";
import { watchesText } from "../src/responsibility-words.js";
import { buildSundayBrief, roleWithService, withServices, type SundayBrief } from "../../../core/src/sunday-brief.js";
import { applyDecisions } from "../../../core/src/sunday-decisions.js";
import { buildSpokenBriefing } from "../../../core/src/spoken-briefing.js";
import { nov22Capture } from "../../../core/src/fictional-sunday.js";
import { wednesdayCapture } from "../../../core/test/fixtures/service-days/wednesday.js";

const rules = { sundayLeads: [], checkInAfterSundaysInARow: 3 };
const sunday = nov22Capture();
const NOW = sunday.completed_at;
const ZONE = "America/New_York";
const WEEKEND = "Weekend Service", YOUTH = "Ozzie Demo Youth Night (fictional)";
const main = buildSundayBrief(sunday, rules, NOW);

/** The rehearsal's second service: a Greeter that still needs 2, at no time tied to it, its own team. */
function youthNight(): SundayBrief {
  const capture = { ...wednesdayCapture(), service_type_id: "1700", plan_id: "94000001" };
  const built = buildSundayBrief(capture, rules, capture.completed_at);
  const greeter = built.findings.find(f => f.kind === "needs-people" && f.position?.name === "Greeter")!;
  return {
    ...built,
    findings: [{ ...greeter, position: { ...greeter.position!, team_id: `y${greeter.position!.team_id}`, interval: null }, remaining: 2,
      people: { suggestions: [], conflicts: [], unverified: [], left_out: [] }, confirmed: [] }],
    positions: built.positions.filter(p => p.name === "Greeter").map(p => ({ ...p, team_id: `y${p.team_id}`, interval: null })),
  };
}
const other = youthNight();
const merged = mergeParts({ brief: main, decisions: [] }, [{ plan_id: "94000001", brief: other, decisions: [] }]);
const services = teamServices({ brief: main, name: WEEKEND }, [{ brief: other, name: YOUTH }])!;
const decided = applyDecisions(merged.brief, merged.decisions);

describe("a role with its service", () => {
  it("is said as Ask's answers say it, and alone with one service", () => {
    expect(roleWithService("Greeter", "Youth Night")).toBe("Greeter (Youth Night)");
    expect(roleWithService("Greeter", null)).toBe("Greeter");
    // A service whose own name already ends in brackets follows a dash: never a pair of brackets inside another (polish 3).
    expect(roleWithService("Greeter", "Youth Night (fictional)")).toBe("Greeter — Youth Night (fictional)");
    expect(roleWithService("Greeter", " Youth Night (fictional) ")).toBe("Greeter — Youth Night (fictional)");
    expect(roleWithService("Greeter (9 AM)", "Youth Night")).toBe("Greeter (9 AM) — Youth Night");
    expect(roleWithService("Greeter", "Youth (6–8) Night")).toBe("Greeter — Youth (6–8) Night");
    const f = merged.brief.findings.at(-1)!;
    expect(withServices(f, services).position!.name).toBe(`Greeter — ${YOUTH}`);
    expect(withServices(f, undefined)).toBe(f);
  });
});

describe("Today's decisions name each role's service while more than one is watched", () => {
  it("each Greeter with its service; the one at no time isn't given every service's day words", () => {
    const { named } = decisionLines(decided.items, { rooms: 0, followUps: 0 }, ZONE, merged.brief.day, services);
    expect(named.map(l => l.text)).toEqual([
      `Greeter (${WEEKEND}): 1 more person needed, Sun 9:30 AM. 1 on the team is clear for that time.`,
      `Nursery (${WEEKEND}): 1 more person needed, Sun 9:30 AM. No one else on the team is clear for that time.`,
      `Greeter — ${YOUTH}: 2 more people needed. No one else on the team is clear.`,
    ]);
  });

  it("a background check on a team with no time of its own runs out before its own service", () => {
    const check = { ...merged.brief.findings.at(-1)!, id: "bg", key: "bg", kind: "background-check" as const, tone: "decision" as const, check: "expires-before-sunday" as const };
    const { named } = decisionLines([{ finding: check, state: "open" }], { rooms: 0, followUps: 0 }, ZONE, merged.brief.day, services);
    expect(named.map(l => l.text)).toEqual([`Greeter — ${YOUTH}: a background check on file expires before ${YOUTH}.`]);
  });

  it("with one service, exactly as before", () => {
    const { named } = decisionLines(applyDecisions(main, []).items, { rooms: 0, followUps: 0 }, ZONE, main.day);
    expect(named.map(l => l.text)).toEqual([
      "Greeter: 1 more person needed, Sun 9:30 AM. 1 on the team is clear for that time.",
      "Nursery: 1 more person needed, Sun 9:30 AM. No one else on the team is clear for that time.",
    ]);
  });
});

describe("Thursday's brief names each role's service while more than one is watched", () => {
  it("each open role with its service", () => {
    const lines = decided.items.map(i => sundayReadyLine(i.finding, {}, merged.brief.day!, services));
    expect(lines).toContain(`Greeter (${WEEKEND}) still needs one more person.`);
    expect(lines).toContain(`Greeter — ${YOUTH} still needs 2 more people.`);
    expect(lines).toContain(`Someone on the team hasn't accepted Lyrics (${WEEKEND}) yet. Planning Center shows the request hasn't been sent.`);
  });

  it("a kids team short of confirmed people at no time of its own: its service, never \"this Sunday\" for another day", () => {
    const few = { ...merged.brief.findings.at(-1)!, id: "few", key: "few", kind: "too-few-confirmed" as const, confirmed: [], needed: 2 };
    expect(sundayReadyLine(few, {}, merged.brief.day!, services)).toBe(`No confirmed people in Greeter — ${YOUTH}.`);
    // One service on a Wednesday: its own day words (it said "this Sunday" before), and a Sunday's unchanged.
    expect(sundayReadyLine(few, {}, { ...main.day!, kind: "weekday", weekday: 3, day: "Wednesday", thisOne: "this Wednesday" })).toBe("No confirmed people in Greeter this Wednesday.");
    expect(sundayReadyLine(few, {}, main.day!)).toBe("No confirmed people in Greeter this Sunday.");
  });

  it("with one service, exactly as before", () => {
    const lines = applyDecisions(main, []).items.map(i => sundayReadyLine(i.finding, {}, main.day!));
    expect(lines.slice(0, 2)).toEqual(["Greeter still needs one more person.", "Nursery still needs one more person."]);
  });
});

describe("the spoken briefing names each role's service while more than one is watched", () => {
  const spoken = (brief: SundayBrief, more: { teamServices?: typeof services } = {}) =>
    buildSpokenBriefing({ attention: null, sunday: brief, decided: applyDecisions(brief, brief === main ? [] : merged.decisions) }, { timeZone: ZONE, ...more })
      .sections.find(s => s.id === "decisions")!.sentences;

  it("each Greeter with its service, and never \"your services\" after a role", () => {
    expect(spoken(merged.brief, { teamServices: services })).toEqual([
      `For your services, Greeter (${WEEKEND}) still needs one more person at the 9:30 AM service. One person on the team could help with no overlap found, and one with a possible conflict. One person's availability couldn't be checked.`,
      `Nursery (${WEEKEND}) still needs one more person at the 9:30 AM service. No one else on this team is clear for this time.`,
      `Greeter — ${YOUTH} still needs 2 more people. No one else on this team is clear.`,
    ]);
  });

  it("a kids team's background check runs out before its own service, never before \"your services\"", () => {
    const youthTeam = merged.brief.findings.at(-1)!.position!;
    const check = { ...merged.brief.findings.at(-1)!, id: "bg", key: "bg", kind: "background-check" as const, tone: "decision" as const, check: "expires-before-sunday" as const, person_id: "9" };
    const brief = { ...merged.brief, findings: [check] };
    const lines = buildSpokenBriefing({ attention: null, sunday: brief, decided: applyDecisions(brief, []) }, { timeZone: ZONE, teamServices: services })
      .sections.find(s => s.id === "decisions")!.sentences;
    expect(lines).toHaveLength(1);
    // After "For your services, " the fixed opening is in lower case (it read "For your services, One person…").
    expect(lines[0]).toBe(`For your services, one person on Greeter — ${YOUTH} has a background check on file that expires before ${YOUTH}.`);
    expect(youthTeam.interval).toBeNull();
  });

  it("with one service, exactly as before", () => {
    expect(spoken(main)).toEqual([
      "For Sunday, Greeter still needs one more person at the 9:30 AM service. One person on the team could help with no overlap found, and one with a possible conflict. One person's availability couldn't be checked.",
      "Nursery still needs one more person at the 9:30 AM service. No one else on this team is clear for this time.",
    ]);
  });
});

describe("Keeping watch says each service while more than one is watched", () => {
  const view = { prefs: { intervalMinutes: 60, runOnLaunch: true, quietStart: "21:00", quietEnd: "07:00", urgentDuringQuiet: false, urgentWithinHours: 24 },
    schedule: { paused: false, failures: 0, held: false, last_run: null, next_run_at: null }, latest: {}, history: [], running: false } as unknown as ProactiveView;
  const page = (several?: boolean) => renderToStaticMarkup(React.createElement(ProactivePage, {
    view, names: {}, organization: "1001", planId: "92902197", readiness: "ready", busy: false, now: NOW,
    onCheckNow: () => {}, onPause: () => {}, onResume: () => {}, onPrefs: () => {}, ...(several === undefined ? {} : { several }),
  })).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

  it("What it does: each service with several, the service with one (unchanged)", () => {
    expect(page(true)).toContain("Reads open roles, who is scheduled and service times for each service Ozzie watches, then compares them with the last check.");
    for (const one of [page(false), page()]) expect(one).toContain("Reads open roles, who is scheduled and service times for the service Ozzie watches, then compares them with the last check.");
  });

  it("Telling you: each service's notice names its own day (proactive.ts), so with several the quoted one is an example", () => {
    expect(page(true)).toContain("When something gets worse, a private notice on this Mac, such as “Sunday coverage needs attention. Open Ozzie to see details.”");
    expect(page(false)).toContain("When something gets worse, a private notice on this Mac: “Sunday coverage needs attention. Open Ozzie to see details.”");
  });

  it("Keep services covered watches each service with several, the service with one (unchanged)", () => {
    expect(watchesText("keep-sunday-covered", main.day!, true)).toBe("Open roles, who has accepted or declined, and scheduled leads for each service Ozzie watches.");
    expect(watchesText("keep-sunday-covered", main.day!)).toBe("Open roles, who has accepted or declined, and scheduled leads for the service Ozzie watches.");
  });
});
