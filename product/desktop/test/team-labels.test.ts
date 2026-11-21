// Teams named by their roles, and by their service while more than one service is watched (polish 2026-11-21, item 1):
// two services each with a "Greeter" team showed two identical "Greeter team" rows in Church rules. Fictional data only.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => new Promise(() => {})) }));
import { teamLabel, teamNames, TeamServicesContext } from "../src/team-labels.js";
import { matchText, teamNames as listTeamNames } from "../src/church-lists-page.js";
import { RulesPage } from "../src/rules-page.js";
import { kidsQuestionTitle, kidsTeamName } from "../src/kids-question.js";
import { withKidsTeam } from "../../../core/src/kids-rules.js";
import type { PositionLabel, SundayRules } from "../../../core/src/sunday-capture.js";
import { text } from "./harness-fakes.js";

const p = (team_id: string, name: string, position_id: string): PositionLabel => ({ team_id, name, position_id, interval: null });
// Each service type has teams of its own in Planning Center: the same roles, different team ids.
const POSITIONS = [p("700", "Greeter", "position:1"), p("701", "Nursery", "position:2"), p("800", "Greeter", "position:1"), p("801", "Nursery", "position:2")];
const SERVICES = { "700": "Weekend Service", "701": "Weekend Service", "800": "Youth Night", "801": "Youth Night" };
const rules: SundayRules = { sundayLeads: [], checkInAfterSundaysInARow: 3 };
const rulesPage = (services: Record<string, string> | undefined, r: SundayRules = rules) => renderToStaticMarkup(React.createElement(TeamServicesContext.Provider, { value: services },
  React.createElement(RulesPage, { rules: r, onChange: () => undefined, positions: POSITIONS })));
const labels = (html: string) => [...html.matchAll(/<label[^>]*>(?:<input[^>]*>)?(?:<span>)?([^<]*)/gu)].map(m => m[1]!.replaceAll("&#x27;", "'")).filter(t => t.includes(" team"));

describe("a team's name says its service while more than one is watched", () => {
  it("names the service with more than one service watched, and nothing more with one", () => {
    expect(teamLabel("Greeter", "800", SERVICES)).toBe("Greeter team · Youth Night");
    expect(teamLabel("Greeter", "800")).toBe("Greeter team");
    // A team whose service has no name Ozzie keeps is named as before.
    expect(teamLabel("Greeter", "999", SERVICES)).toBe("Greeter team");
    expect([...teamNames(POSITIONS, SERVICES).values()]).toEqual(["Greeter team · Weekend Service", "Nursery team · Weekend Service", "Greeter team · Youth Night", "Nursery team · Youth Night"]);
    expect([...teamNames(POSITIONS).values()]).toEqual(["Greeter team", "Nursery team", "Greeter team", "Nursery team"]);
    // Church lists' matching says the same (its own copy, church-notes.tsx, so the lists' code reaches nothing else).
    const lists = listTeamNames(POSITIONS, new Map(Object.entries(SERVICES)));
    expect([...lists.values()]).toEqual([...teamNames(POSITIONS, SERVICES).values()]);
    expect([...listTeamNames(POSITIONS).values()]).toEqual([...teamNames(POSITIONS).values()]);
    expect(matchText({ team_id: "800" }, lists)).toBe("Everyone on the Greeter team · Youth Night");
    expect(matchText({ team_id: "700", position_name: "Greeter" }, lists)).toBe("Greeter on the Greeter team · Weekend Service");
  });

  it("Church rules: no two team rows read the same in Scheduled leads or Kids teams", () => {
    const shown = labels(rulesPage(SERVICES));
    expect(shown).toEqual([
      "Greeter team · Weekend Service", "Nursery team · Weekend Service", "Greeter team · Youth Night", "Nursery team · Youth Night",
      "Greeter team · Weekend Service serves with kids", "Nursery team · Weekend Service serves with kids", "Greeter team · Youth Night serves with kids", "Nursery team · Youth Night serves with kids",
    ]);
    expect(new Set(shown).size).toBe(shown.length);
    // A marked team's count is labelled with the same name, for VoiceOver.
    const marked = rulesPage(SERVICES, withKidsTeam(rules, "801", 2, "Nursery"));
    expect(marked).toContain('aria-label="Confirmed people Nursery team · Youth Night needs at each service time"');
  });

  it("one service watched: Church rules as before", () => {
    const t = text(rulesPage(undefined));
    expect(t).not.toContain(" · Weekend Service");
    expect(labels(rulesPage(undefined))).toContain("Greeter team serves with kids");
  });

  it("the kids question names the team's service only while more than one is watched", () => {
    expect(kidsQuestionTitle(kidsTeamName("Nursery", "Youth Night"))).toBe("Does Nursery (Youth Night) serve with kids?");
    expect(kidsQuestionTitle(kidsTeamName("Nursery", null))).toBe("Does Nursery serve with kids?");
    // A service whose own name ends in brackets follows a dash, as Ask's answers say it (polish 3).
    expect(kidsQuestionTitle(kidsTeamName("Nursery", "Youth Night (fictional)"))).toBe("Does Nursery — Youth Night (fictional) serve with kids?");
  });
});
