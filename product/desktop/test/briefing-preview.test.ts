// "Preview this briefing" (owner decision 2026-11-15): what the morning briefing will include on its next run, from
// Ozzie's last check, so Thursday's Sunday Ready brief can be shown on any day. Nothing is read or sent to make it.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BriefingPreview, briefingPreviewTimes, sundayReadyLine } from "../src/sunday-ready.js";
import { TodayPage } from "../src/today-page.js";
import { buildSundayBrief } from "../../../core/src/sunday-brief.js";
import { nov22Capture } from "../../../core/src/fictional-sunday.js";
import { defaultPlan, TEMPLATES, type Responsibility } from "../../../core/src/harness/responsibilities.js";
import type { RunnerView } from "../src/responsibility-runner.js";

const ZONE = "America/New_York";
const MON = "2026-11-23T15:00:00.000Z"; // Monday 10:00 AM in New York
const WED_NIGHT = "2026-11-25T23:00:00.000Z"; // Wednesday 6:00 PM in New York
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replaceAll("&#x27;", "'").replaceAll("&quot;", "\"").replace(/\s+/g, " ");
const FORBIDDEN = /\b(approve|block|skills?|sessions?|agent|connector|harness|score|rank(ed|ing)?|at risk|drifting|log)\b/i;
const capture = nov22Capture();
const brief = buildSundayBrief(capture, { sundayLeads: [], checkInAfterSundaysInARow: 3 }, capture.completed_at, true);

function briefing(over: Partial<Responsibility> = {}): Responsibility {
  const t = TEMPLATES["morning-briefing"];
  return {
    ...defaultPlan("morning-briefing", MON, ZONE), id: "00000000-0000-4000-8000-0000000000b1", title: t.title, skill_id: t.skill_id, status: "active",
    created_at: MON, confirmed_at: MON, runs: [], open_run: null, ...over,
  };
}

describe("Preview this briefing", () => {
  it("finds the next briefing and the next Thursday's, on the church's own clock", () => {
    // Monday after 7:00: next is Tuesday 7:00, Thursday's is Nov 26.
    expect(briefingPreviewTimes(briefing(), MON, "UTC")).toEqual({ next: "2026-11-24T12:00:00.000Z", thursday: "2026-11-26T12:00:00.000Z", zone: ZONE });
    // Wednesday evening: the next one is Thursday's.
    const wed = briefingPreviewTimes(briefing(), WED_NIGHT, "UTC");
    expect(wed.next).toBe(wed.thursday);
    // The runner's own next time wins (it knows about pauses and catch-up).
    expect(briefingPreviewTimes(briefing(), MON, "UTC", "2026-11-23T15:05:00.000Z").next).toBe("2026-11-23T15:05:00.000Z");
    // A briefing without a valid zone of its own uses the Mac's.
    expect(briefingPreviewTimes(briefing({ zone: null }), MON, ZONE).zone).toBe(ZONE);
  });

  it("on a day before Thursday, shows the next briefing and the Sunday Ready brief Thursday's will carry", () => {
    const t = text(renderToStaticMarkup(React.createElement(BriefingPreview, {
      ...briefingPreviewTimes(briefing(), MON, "UTC"), brief, names: capture.names, onSunday: () => undefined,
    })));
    expect(t).toContain("Next briefing: Tue, Nov 24");
    expect(t).toContain("Thursday's briefing, Thu, Nov 26");
    expect(t).toContain("also includes the full Sunday Ready brief. From Ozzie's last check, it would say:");
    expect(t).toContain("Sunday Ready");
    expect(t).toContain("Needs a decision");
    expect(t).toContain("Nothing was read or sent to make it.");
    expect(t).not.toMatch(FORBIDDEN);
  });

  it("when the next briefing is Thursday's, says so and shows its Sunday Ready brief", () => {
    const t = text(renderToStaticMarkup(React.createElement(BriefingPreview, {
      ...briefingPreviewTimes(briefing(), WED_NIGHT, "UTC"), brief, names: capture.names, onSunday: () => undefined,
    })));
    expect(t).toContain("Next briefing: Thu, Nov 26");
    expect(t).toContain("It's Thursday's, so it includes the full Sunday Ready brief:");
    expect(t).toContain("Sunday Ready");
  });

  it("without a check yet, says the Sunday Ready brief isn't here rather than inventing one", () => {
    const t = text(renderToStaticMarkup(React.createElement(BriefingPreview, {
      next: null, thursday: null, zone: ZONE, brief: null, names: {}, onSunday: () => undefined,
    })));
    expect(t).toContain("No briefing is scheduled right now");
    expect(t).toContain("Sunday hasn't been checked yet");
  });

  it("Today's morning briefing card offers it, folded until asked for", () => {
    const r = briefing();
    const view = {
      available: true, items: [r], noticed: [], next: { [r.id]: "2026-11-24T12:00:00.000Z" }, running: null, paused_all: false, prepared: {},
    } as unknown as RunnerView;
    const html = renderToStaticMarkup(React.createElement(TodayPage, {
      brief, onSunday: () => undefined, names: capture.names, now: MON, zone: ZONE,
      watch: { view, onOpen: () => undefined } as never,
    }));
    expect(html).toMatch(/aria-expanded="false"[^>]*>Preview this briefing<\/button>/);
    expect(text(html)).not.toContain("Next briefing:");
  });

  it("names the kids team, the time and (on this Mac) the person in the kids lines, as the Sunday page does", () => {
    const base = brief.findings[0]!;
    const position = { id: "p", team_id: "t", name: "Nursery", interval: { starts_at: "2026-11-29T14:30:00Z", ends_at: "2026-11-29T15:30:00Z" } };
    expect(sundayReadyLine({ ...base, kind: "too-few-confirmed", position, confirmed: ["1"], needed: 2, why: ["rule"] } as never, {}))
      .toMatch(/^Only 1 confirmed person in Nursery at /u);
    expect(sundayReadyLine({ ...base, kind: "background-check", position, person_id: "9", check: "none-current", why: ["rule"] } as never, { "9": "Pat Example" }))
      .toBe("Pat Example has no current background check on file.");
  });

  it("keeps the fictional email example off Today once a real Planning Center connection exists", () => {
    const today = (example: boolean) => text(renderToStaticMarkup(React.createElement(TodayPage, { brief, onSunday: () => undefined, names: capture.names, now: MON, zone: ZONE, example })));
    expect(today(true)).toContain("Tonight's orientation needs a location decision.");
    expect(today(true)).toContain("Ignored on purpose");
    const real = today(false);
    expect(real).not.toContain("Tonight's orientation");
    expect(real).not.toContain("Ignored on purpose");
    expect(real).not.toContain("Read, nothing needed from you");
    expect(real).not.toContain("Fictional import");
    expect(real).toContain("Listen to today's briefing");
  });
});

