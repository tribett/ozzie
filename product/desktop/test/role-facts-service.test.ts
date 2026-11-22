// Which service's role couldn't be checked, in the lines that speak of every service at once (seen in 0.5.10 with two
// services watched, "Weekend Service" and "Ozzie Demo Youth Night (fictional)", each with a Greeter, the second's tied to
// no service time): the spoken briefing and Thursday's brief said "One role couldn't be checked, …" with no service,
// while the Services page shows it under the service's own heading and Ask says "At Ozzie Demo Youth Night (fictional),
// one role couldn't be checked." With more than one service watched they now open with the service, as Ask does, when
// its name is one a person would recognise (not a weekday alone, not another watched service's name); otherwise, and
// with one service, the words are exactly what they were. Written on this Mac only from what the check already holds:
// nothing here is sent anywhere. Fixed fictional data.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => { throw new Error("NATIVE_CALL_FORBIDDEN"); }) }));
import { findingServices, mergeParts, teamServices } from "../src/services-merge.js";
import { SundayReadyBrief, sundayReadyLine } from "../src/sunday-ready.js";
import { BriefingPanel } from "../src/briefing.js";
import { FindingServicesContext, TeamServicesContext } from "../src/team-labels.js";
import { DayProvider } from "../src/day-words.js";
import { buildSundayBrief, type Finding, type SundayBrief } from "../../../core/src/sunday-brief.js";
import { applyDecisions } from "../../../core/src/sunday-decisions.js";
import { buildSpokenBriefing } from "../../../core/src/spoken-briefing.js";
import { nov22Capture } from "../../../core/src/fictional-sunday.js";
import type { SundayCapture } from "../../../core/src/sunday-capture.js";
import { wednesdayCapture } from "../../../core/test/fixtures/service-days/wednesday.js";

const rules = { sundayLeads: [], checkInAfterSundaysInARow: 3 };
const ZONE = "America/New_York";
const WEEKEND = "Weekend Service", YOUTH = "Ozzie Demo Youth Night (fictional)";
const YOUTH_PLAN = "94000001";

type Rel = { id: string; relationships: Record<string, { data: unknown }> };
const rows = (c: SundayCapture, collection: string) => c.reads.find(r => r.collection === collection)!.body!.data as Rel[];
/** A role with no service time in Planning Center: its scheduled person, and its needed position when given, tied to none. */
function untimed(c: SundayCapture, member: string, need: string | null): SundayCapture {
  rows(c, "team_members").find(m => m.id === member)!.relationships["times"] = { data: [] };
  if (need) rows(c, "needed_positions").find(n => n.id === need)!.relationships["time"] = { data: null };
  return c;
}
const built = (c: SundayCapture) => buildSundayBrief(c, rules, c.completed_at);
/**
 * The first service: the fictional Sunday, every role tied to a time (or, with `lyrics`, Lyrics tied to none). Its other
 * Worth a look items are left out, so the spoken briefing (at most four lines a section) reads every one of the others.
 */
const weekendBrief = (lyrics = false): SundayBrief => {
  const b = built(lyrics ? untimed(nov22Capture(), "403", null) : nov22Capture());
  return { ...b, findings: b.findings.filter(f => f.tone === "decision" || f.kind === "worth-a-look") };
};
/** The second service: the fictional plan on a Wednesday, with teams of its own, and its Greeter tied to no service time. */
function youthBrief(): SundayBrief {
  const own = JSON.parse(JSON.stringify(wednesdayCapture()).replace(/\b75933(5[024])\b/gu, "85933$1")) as SundayCapture;
  return built(untimed({ ...own, service_type_id: "1700", plan_id: YOUTH_PLAN }, "401", "301"));
}
/** The same, with twelve roles tied to no service time. */
function manyRoles(b: SundayBrief): SundayBrief {
  const reasons = Array.from({ length: 12 }, (_, i) => [`Role ${i + 1} isn't tied to a service time in Planning Center, so Ozzie can't tell when it serves. Set the role's time in Planning Center to have it checked.`,
    `Ozzie couldn't tell from Planning Center who said yes for Role ${i + 1}, or when they serve.`]).flat();
  return { ...b, findings: b.findings.map(f => f.kind === "worth-a-look" ? { ...f, role_facts: { roles: 12, reasons } } : f) };
}

const GREETER = "Greeter isn't tied to a service time in Planning Center, so Ozzie can't tell when it serves. Set the role's time in Planning Center to have it checked. Ozzie couldn't tell from Planning Center who said yes for Greeter, or when they serve.";
const LYRICS = "Lyrics isn't tied to a service time in Planning Center, so Ozzie can't tell when it serves. Set the role's time in Planning Center to have it checked. Ozzie couldn't tell from Planning Center who said yes for Lyrics, or when they serve.";

interface Watched { brief: SundayBrief; teams: Record<string, string> | undefined; findings: Record<string, string> | undefined }
/** What App hands Today: the merged brief, each team's service, and each finding's service by a name a person would recognise. */
function watched(main: { brief: SundayBrief; name: string | null }, others: { brief: SundayBrief; name: string | null }[] = [], unread: (string | null)[] = []): Watched {
  const parts = others.map(o => ({ plan_id: o.brief.plan.id, brief: o.brief, name: o.name }));
  return {
    brief: mergeParts({ brief: main.brief, decisions: [] }, parts.map(p => ({ plan_id: p.plan_id, brief: p.brief, decisions: [] }))).brief,
    teams: teamServices(main, parts), findings: findingServices(main, parts, unread),
  };
}
/** The spoken briefing's Worth a look lines, as Today's "Listen to today's briefing" builds them. */
const spokenLooks = (w: Watched) => buildSpokenBriefing({ attention: null, sunday: w.brief, decided: applyDecisions(w.brief, []) },
  { timeZone: ZONE, ...(w.teams ? { teamServices: w.teams } : {}), ...(w.findings ? { findingServices: w.findings } : {}) }).sections.find(s => s.id === "looks")!.sentences;
const looksOf = (w: Watched): Finding[] => w.brief.findings.filter(f => f.kind === "worth-a-look");
/** Thursday's brief's line for each part of the check that couldn't be checked. */
const readyLines = (w: Watched) => looksOf(w).map(f => sundayReadyLine(f, {}, w.brief.day, w.teams, w.brief.time_zone, w.findings));

describe("one service watched: exactly the words it had", () => {
  it("a Wednesday's Greeter tied to no time, and a Sunday's Lyrics", () => {
    const youth = watched({ brief: youthBrief(), name: YOUTH });
    expect(youth.findings).toBeUndefined();
    expect(spokenLooks(youth)).toContain(`One role couldn't be checked, so Ozzie won't call Wednesday covered. ${GREETER}`);
    expect(readyLines(youth)).toEqual([`One role couldn't be checked, so it isn't a full picture. ${GREETER}`]);
    const sunday = watched({ brief: weekendBrief(true), name: WEEKEND });
    expect(sunday.findings).toBeUndefined();
    expect(spokenLooks(sunday)).toContain(`One role couldn't be checked, so Ozzie won't call Sunday covered. ${LYRICS}`);
    expect(readyLines(sunday)).toEqual([`One role couldn't be checked, so it isn't a full picture. ${LYRICS}`]);
  });

  it("many roles: still pointed to on screen, with no service", () => {
    const many = watched({ brief: manyRoles(youthBrief()), name: YOUTH });
    expect(spokenLooks(many)).toContain("12 roles couldn't be checked, so Ozzie won't call Wednesday covered. The roles and why are listed on screen.");
    expect(readyLines(many)[0]).toMatch(/^12 roles couldn't be checked, so it isn't a full picture\. Role 1 isn't tied/u);
  });
});

describe("two services watched: the role's own service, as Ask says it", () => {
  it("the second service's Greeter tied to no time: \"At Ozzie Demo Youth Night (fictional), one role couldn't be checked, …\"", () => {
    const two = watched({ brief: weekendBrief(), name: WEEKEND }, [{ brief: youthBrief(), name: YOUTH }]);
    expect(two.findings?.[`${YOUTH_PLAN}:worth-a-look:scope`]).toBe(YOUTH);
    expect(spokenLooks(two)).toContain(`At ${YOUTH}, one role couldn't be checked, so Ozzie won't call it covered. ${GREETER}`);
    expect(readyLines(two)).toEqual([`At ${YOUTH}, one role couldn't be checked, so it isn't a full picture. ${GREETER}`]);
    // 0.5.10 said neither which service nor anything else different.
    expect(spokenLooks(two).join(" ")).not.toContain("One role couldn't be checked");
  });

  it("each service's own role, said at its own service", () => {
    const two = watched({ brief: weekendBrief(true), name: WEEKEND }, [{ brief: youthBrief(), name: YOUTH }]);
    expect(readyLines(two)).toEqual([
      `At ${WEEKEND}, one role couldn't be checked, so it isn't a full picture. ${LYRICS}`,
      `At ${YOUTH}, one role couldn't be checked, so it isn't a full picture. ${GREETER}`,
    ]);
    const looks = buildSpokenBriefing({ attention: null, sunday: two.brief }, { timeZone: ZONE, teamServices: two.teams!, findingServices: two.findings! }).text;
    expect(looks).toContain(`At ${WEEKEND}, one role couldn't be checked, so Ozzie won't call it covered. ${LYRICS}`);
  });

  it("many roles: the service, then pointed to on screen", () => {
    const two = watched({ brief: weekendBrief(), name: WEEKEND }, [{ brief: manyRoles(youthBrief()), name: YOUTH }]);
    expect(spokenLooks(two)).toContain(`At ${YOUTH}, 12 roles couldn't be checked, so Ozzie won't call it covered. The roles and why are listed on screen.`);
    expect(readyLines(two)[0]).toMatch(/^At Ozzie Demo Youth Night \(fictional\), 12 roles couldn't be checked, so it isn't a full picture\. Role 1 isn't tied/u);
  });

  it("on Today itself: Thursday's brief and the written briefing, from what App provides", () => {
    const two = watched({ brief: weekendBrief(), name: WEEKEND }, [{ brief: youthBrief(), name: YOUTH }]);
    const wrap = (el: React.ReactElement) => text(renderToStaticMarkup(React.createElement(TeamServicesContext.Provider, { value: two.teams },
      React.createElement(FindingServicesContext.Provider, { value: two.findings }, React.createElement(DayProvider, { value: two.brief.day! }, el)))));
    expect(wrap(React.createElement(SundayReadyBrief, { brief: two.brief, names: {}, onSunday: () => undefined })))
      .toContain(`At ${YOUTH}, one role couldn't be checked, so it isn't a full picture. ${GREETER}`);
    expect(wrap(React.createElement(BriefingPanel, { input: { attention: null, sunday: two.brief }, names: {}, timeZone: ZONE })))
      .toContain(`At ${YOUTH}, one role couldn't be checked, so Ozzie won't call it covered. ${GREETER}`);
  });
});

describe("a service whose name isn't one a person would recognise: the words it had", () => {
  const plain = `One role couldn't be checked, so Ozzie won't call your services covered. ${GREETER}`;
  const plainReady = `One role couldn't be checked, so it isn't a full picture. ${GREETER}`;
  it("a weekday alone", () => {
    const two = watched({ brief: weekendBrief(), name: WEEKEND }, [{ brief: youthBrief(), name: "Wednesday" }]);
    expect(two.findings?.[`${YOUTH_PLAN}:worth-a-look:scope`]).toBeUndefined();
    expect(spokenLooks(two)).toContain(plain);
    expect(readyLines(two)).toEqual([plainReady]);
  });

  it("the same name as another watched service, read or not read yet", () => {
    for (const two of [
      watched({ brief: weekendBrief(), name: WEEKEND }, [{ brief: youthBrief(), name: "weekend  service" }]),
      watched({ brief: weekendBrief(), name: WEEKEND }, [{ brief: youthBrief(), name: YOUTH }], [YOUTH.toUpperCase()]),
    ]) {
      expect(two.findings?.[`${YOUTH_PLAN}:worth-a-look:scope`]).toBeUndefined();
      expect(spokenLooks(two)).toContain(plain);
      expect(readyLines(two)).toEqual([plainReady]);
    }
  });

  it("days, months and clock times in any form, or a name that would break the sentence (review of 0.5.11)", () => {
    for (const name of ["Wednesdays", "9:00 AM", "Sunday 9:00 AM Service", "Sat PM", "Youth, Family Night", "Youth Night."]) {
      const two = watched({ brief: weekendBrief(), name: WEEKEND }, [{ brief: youthBrief(), name }]);
      expect(two.findings?.[`${YOUTH_PLAN}:worth-a-look:scope`], name).toBeUndefined();
      expect(spokenLooks(two), name).toContain(plain);
      expect(readyLines(two), name).toEqual([plainReady]);
    }
    // A day with a word of its own is a name.
    const named = watched({ brief: weekendBrief(), name: WEEKEND }, [{ brief: youthBrief(), name: "Wednesday Youth" }]);
    expect(spokenLooks(named).join("\n")).toContain("At Wednesday Youth, one role couldn't be checked, so Ozzie won't call it covered.");
  });

  it("no name at all", () => {
    const two = watched({ brief: weekendBrief(), name: WEEKEND }, [{ brief: youthBrief(), name: null }]);
    expect(spokenLooks(two)).toContain(plain);
    expect(readyLines(two)).toEqual([plainReady]);
  });
});

function text(html: string): string {
  return html.replace(/<[^>]+>/gu, " ").replace(/&#x27;/gu, "'").replace(/&quot;/gu, "\"").replace(/&amp;/gu, "&").replace(/\s+/gu, " ").trim();
}
