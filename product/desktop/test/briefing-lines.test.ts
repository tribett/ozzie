// Two parts of the morning briefing over fixed, fictional data: "Kept for your briefing" (what the person's
// Church rules keep for it instead of a notice) and the weekly roll-up of regular jobs (owner decision,
// October 26: quiet success, loud problems). No names, no model, no Planning Center.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { KeptForBriefing } from "../src/sunday-ready.js";
import { keptLines, weekRollup } from "../src/responsibility-words.js";
import type { RunRow } from "../../../core/src/harness/responsibilities.js";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replaceAll("&#x27;", "'").replace(/\s+/g, " ").trim();
const FORBIDDEN = /\b(approve|block|skills?|sessions?|agent|connector|harness|score|rank(ed|ing)?|at risk|drifting|log)\b/i;

describe("Kept for your briefing", () => {
  it("lists each kind the person keeps for the briefing under a plain heading, with how many", () => {
    const item = { kind: "briefing" as const, kept: [{ kind: "needs-people", count: 2 }, { kind: "room-overlap", count: 1 }] };
    expect(keptLines(item)).toEqual(["Open roles: 2", "Overlapping room bookings: 1"]);
    const t = text(renderToStaticMarkup(React.createElement(KeptForBriefing, { item })));
    expect(t).toMatch(/^Kept for your briefing Open roles: 2 Overlapping room bookings: 1 /u);
    expect(t).toContain("Your Church rules keep these for the briefing instead of a notice.");
    expect(t).not.toMatch(FORBIDDEN);
  });

  it("shows nothing when nothing is kept, or on anything but a briefing", () => {
    expect(renderToStaticMarkup(React.createElement(KeptForBriefing, { item: { kind: "briefing" } }))).toBe("");
    expect(keptLines({ kind: "found", kept: [{ kind: "needs-people", count: 2 }] })).toEqual([]);
    expect(keptLines({ kind: "briefing", kept: [{ kind: "needs-people", count: 0 }] })).toEqual([]);
  });
});

describe("the weekly roll-up of regular jobs", () => {
  const NOW = "2026-11-20T12:00:00.000Z";
  const DAY = 86_400_000;
  const run = (daysAgo: number, outcome: RunRow["outcome"], code: string | null = null): RunRow => {
    const started_at = new Date(Date.parse(NOW) - daysAgo * DAY).toISOString();
    return { run_id: `r-${daysAgo}-${outcome}`, trigger: "scheduled", started_at, ended_at: outcome ? started_at : null, outcome, code, noticed: 0, drafts: 0, ai_steps: 0 };
  };
  const job = (title: string, runs: RunRow[]) => ({ title, runs });

  it("quiet success: every job that ran in the last seven days finished, in one line", () => {
    const jobs = [
      job("Keep Sunday covered", [run(0.5, "ok"), run(1, "ok"), run(2, "ok")]),
      job("Watch room bookings", [run(3, "ok")]),
      job("Morning briefing", [run(1, "ok"), run(6.9, "ok")]),
    ];
    expect(weekRollup(jobs, NOW)).toEqual({ line: "3 regular jobs ran this week. All finished.", problems: [] });
    expect(weekRollup([jobs[1]!], NOW).line).toBe("1 regular job ran this week. All finished.");
  });

  it("loud problems: a check that couldn't finish or was cut off is named per job, plainly", () => {
    const jobs = [
      job("Keep Sunday covered", [run(0.5, "failed", "provider-failure"), run(1, "ok"), run(2, "interrupted")]),
      job("Watch room bookings", [run(3, "ok")]),
    ];
    const week = weekRollup(jobs, NOW);
    expect(week.line).toBe("2 regular jobs ran this week. 1 couldn't finish every check.");
    expect(week.problems).toEqual(["Keep Sunday covered couldn't finish 2 of 3 checks this week."]);
    for (const line of [week.line!, ...week.problems]) expect(line).not.toMatch(FORBIDDEN);
  });

  it("only the last seven days count; a run paused part-way or still running isn't a problem; nothing ran says nothing", () => {
    const jobs = [
      job("Keep Sunday covered", [run(0.5, "failed", "cancelled"), run(1, null), run(7.5, "failed", "provider-failure")]),
      job("Follow-ups without an owner", [run(8, "ok")]),
    ];
    expect(weekRollup(jobs, NOW)).toEqual({ line: "1 regular job ran this week. All finished.", problems: [] });
    expect(weekRollup([job("Follow-ups without an owner", [run(8, "ok")])], NOW)).toEqual({ line: null, problems: [] });
    expect(weekRollup([], NOW)).toEqual({ line: null, problems: [] });
  });
});
