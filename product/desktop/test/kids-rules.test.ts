// Kids rules on screen: the Church rules section, and the two Sunday cards. Fictional data only.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { backgroundTitle, fewConfirmedBody, fewConfirmedTitle, SundayPage } from "../src/sunday-page.js";
import { RulesPage } from "../src/rules-page.js";
import { KidsTeamsRules } from "../src/kids-rules-section.js";
import { buildSundayBrief, type Finding, type SundayBrief } from "../../../core/src/sunday-brief.js";
import type { SundayRules } from "../../../core/src/sunday-capture.js";
import { nov22Capture, PEOPLE, TEAMS, withFictionalBackgroundChecks } from "../../../core/src/fictional-sunday.js";
import { applyDecisions, openCount } from "../../../core/src/sunday-decisions.js";
import { kidsTeams, withKidsTeam } from "../../../core/src/kids-rules.js";
import { groupToday, todayItems } from "../src/today-groups.js";

const base: SundayRules = { sundayLeads: [], checkInAfterSundaysInARow: 3 };
const kids: SundayRules = { ...base, kidsTeams: [{ team_id: TEAMS.nursery, min_confirmed: 2 }, { team_id: TEAMS.lyrics, min_confirmed: 1 }] };
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replaceAll("&#x27;", "'").replaceAll("&quot;", "\"").replace(/\s+/g, " ");
const FORBIDDEN = /\b(approve|block|skills?|sessions?|agent|connector|harness|score|rank(ed|ing)?|at risk|drifting|adults?)\b/i;
const positions = [
  { position_id: "position:1", team_id: TEAMS.greeter, name: "Greeter", interval: null },
  { position_id: "position:2", team_id: TEAMS.nursery, name: "Nursery", interval: null },
];
function page(b: SundayBrief) {
  return renderToStaticMarkup(React.createElement(SundayPage, {
    brief: b, names: nov22Capture().names, busy: false, problem: "", sender: "Pat", connected: false, hasRecording: false, configured: false,
    canReword: false, decisions: [], onDecisions: () => undefined, operations: null, onCheck: () => undefined, onRecording: () => undefined, onExample: () => undefined,
  }));
}
const capture = withFictionalBackgroundChecks(nov22Capture());
const brief = buildSundayBrief(capture, kids, "2026-11-20T15:05:00Z");

describe("Church rules: Kids teams", () => {
  it("assumes no team, and says ages aren't checked", () => {
    const t = text(renderToStaticMarkup(React.createElement(RulesPage, { rules: base, onChange: () => undefined, positions })));
    expect(t).toContain("Kids teams");
    expect(t).toContain("Nursery team serves with kids");
    expect(t).toContain("it doesn't check ages");
    expect(t).not.toContain("Ask for a current background check");
    const html = renderToStaticMarkup(React.createElement(KidsTeamsRules, { rules: base, onChange: () => undefined, teams: [[TEAMS.nursery, ["Nursery"]]] }));
    expect(html).not.toMatch(/checked=""/);
  });

  it("shows a marked team's count and the background-check rule with what it reads", () => {
    const html = renderToStaticMarkup(React.createElement(KidsTeamsRules, { rules: kids, onChange: () => undefined, teams: [[TEAMS.nursery, ["Nursery"]], [TEAMS.greeter, ["Greeter"]]] }));
    const t = text(html);
    expect(html).toMatch(/id="kids-7593352"[^>]*checked=""/);
    expect(html).toMatch(/value="2"/);
    expect(t).toContain("Ask for a current background check before anyone serves on these teams");
    expect(t).toContain("never its details");
    expect(t).toContain("It needs People in your Planning Center connection");
    expect(t).not.toMatch(FORBIDDEN);
    expect(text(renderToStaticMarkup(React.createElement(KidsTeamsRules, { rules: base, onChange: () => undefined, teams: [] })))).toContain("Check a Sunday first to see its teams.");
  });
});

describe("Church rules: kids teams beyond the last check, and at most ten (review M1)", () => {
  it("lists a team marked earlier that isn't on the Sunday checked last, by its kept name, with Unmark this team", () => {
    let latest: SundayRules | null = null;
    const rules = withKidsTeam(base, "7599999", 2, "Toddlers");
    const el = KidsTeamsRules({ rules, onChange: r => { latest = r; }, teams: [[TEAMS.nursery, ["Nursery"]]] });
    const t = text(renderToStaticMarkup(el));
    expect(t).toContain("Toddlers team Not on the Sunday checked last. 2 confirmed at each time. Unmark this team");
    // Pressing it unmarks the team.
    const find = (node: React.ReactNode): React.ReactElement<{ onClick?: () => void; children?: React.ReactNode }> | null => {
      if (!React.isValidElement(node)) return Array.isArray(node) ? node.map(find).find(Boolean) ?? null : null;
      const props = node.props as { onClick?: () => void; children?: React.ReactNode };
      if (props.onClick && props.children === "Unmark this team") return node as React.ReactElement<{ onClick?: () => void }>;
      return find(props.children);
    };
    find(el)!.props.onClick!();
    expect(kidsTeams(latest!)).toEqual([]);
  });

  it("stops at ten: an unmarked team can't be ticked, and says why", () => {
    const ten = Array.from({ length: 10 }, (_, i) => ({ team_id: String(7600000 + i), min_confirmed: 2 }));
    const html = renderToStaticMarkup(React.createElement(KidsTeamsRules, { rules: { ...base, kidsTeams: ten }, onChange: () => undefined, teams: [[TEAMS.nursery, ["Nursery"]]] }));
    expect(html).toMatch(/id="kids-7593352"[^>]*disabled=""/);
    expect(text(html)).toContain("That's 10 kids teams, the most Ozzie checks.");
    expect(text(html)).toContain("never sent to an AI");
  });
});

describe("Sunday cards for kids rules", () => {
  it("says confirmed people, never adults, and never counts pending", () => {
    const [nursery, lyrics] = brief.findings.filter(f => f.kind === "too-few-confirmed");
    expect(fewConfirmedTitle(nursery!)).toMatch(/^Only 1 confirmed person in Nursery at \d{1,2}:30/);
    expect(fewConfirmedBody(nursery!)).toBe("No one else is asked yet. Your Church rules ask for at least 2. Ozzie counts confirmed people; it doesn't check ages.");
    expect(fewConfirmedTitle(lyrics!)).toMatch(/^No confirmed people in Lyrics at /);
    expect(fewConfirmedBody(lyrics!)).toContain("1 more is penciled in, but the request hasn't been sent.");
    const asked: Finding = { ...nursery!, asked: ["551", "552"], not_sent: [] };
    expect(fewConfirmedBody(asked)).toContain("2 more are asked but haven't answered.");
  });

  it("names a background check only as on file or not, or as expiring before Sunday", () => {
    expect(backgroundTitle("Blake Ashgrove", "none-current")).toBe("Blake Ashgrove has no current background check on file.");
    expect(backgroundTitle("Cameron Larkspur", "expires-before-sunday")).toBe("Cameron Larkspur's background check on file expires before Sunday.");
    const t = text(page(brief));
    expect(t).toContain("Blake Ashgrove has no current background check on file.");
    expect(t).toContain("Cameron Larkspur's background check on file expires before Sunday.");
    expect(t).toContain("Planning Center People");
    expect(t).not.toMatch(/complete_clear|2026-11-21|cleared|not clear/i);
    expect(t.replaceAll("not ranked", "")).not.toMatch(FORBIDDEN);
  });

  it("count toward Today's \"Sunday has N things to decide\" under Needs your attention", () => {
    const plain = buildSundayBrief(nov22Capture(), base, "2026-11-20T15:05:00Z");
    const before = openCount(applyDecisions(plain, [])).decisions, after = openCount(applyDecisions(brief, [])).decisions;
    expect(after - before).toBe(4);
    const items = todayItems({ now: "2026-11-20T15:05:00Z", attention: null, watch: null, firstSeen: {},
      sunday: { plan_id: brief.plan.id, checked_at: brief.completed_at, decisions: after, answers: [] } });
    const grouped = groupToday(items, {}, "2026-11-20T15:05:00Z");
    expect(grouped.attention.map(i => i.subject)).toContainEqual(expect.objectContaining({ type: "sunday", decisions: after }));
  });

  it("each card carries its own source and check time, and the kids findings need a decision", () => {
    const html = page(brief);
    expect(text(html)).toContain("Only 1 confirmed person in Nursery");
    expect(brief.findings.filter(f => f.kind === "background-check").map(f => [f.person_id, f.tone, f.source]))
      .toEqual([[PEOPLE.nurseryConfirmed, "decision", "Planning Center People"], [PEOPLE.lyricsPending, "decision", "Planning Center People"]]);
  });
});
