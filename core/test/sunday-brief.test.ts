import { describe, expect, it } from "vitest";
import { buildSundayBrief, leadKey, needKey, teamLeaders } from "../src/sunday-brief.js";
import type { SundayCapture } from "../src/sunday-capture.js";
import { nov22Capture, PEOPLE, TEAMS } from "../src/fictional-sunday.js";

const NOW = "2026-11-20T15:05:00Z";
const rules = { sundayLeads: [], checkInAfterSundaysInARow: 3 };

describe("Sunday brief", () => {
  it("leads with the two open positions, then the pending lyrics assignment and the serving streak", () => {
    const brief = buildSundayBrief(nov22Capture(), rules, NOW);
    expect(brief.findings.map(f => f.kind)).toEqual(["needs-people", "needs-people", "pending", "streak"]);
    expect(brief.findings[0]).toMatchObject({ tone: "decision", remaining: 1, position: { name: "Greeter" } });
    expect(brief.findings[2]).toMatchObject({ person_id: PEOPLE.lyricsPending, notification: "unsent" });
  });

  it("separates suggestions, possible conflicts, unverified and left-out people with reasons", () => {
    const greeter = buildSundayBrief(nov22Capture(), rules, NOW).findings[0]!;
    expect(greeter.people!.suggestions.map(p => p.person_id)).toEqual([PEOPLE.riley]);
    expect(greeter.people!.conflicts.map(p => p.person_id)).toEqual([PEOPLE.casey]);
    expect(greeter.people!.unverified.map(p => p.person_id)).toEqual([PEOPLE.drew]);
    expect(greeter.people!.left_out.map(p => p.person_id).sort()).toEqual([PEOPLE.sam, PEOPLE.morgan].sort());
    expect(greeter.people!.left_out.find(p => p.person_id === PEOPLE.sam)!.reasons.join(" ")).toContain("blockout");
  });

  it("changing the Church rule from 3 to 2 Sundays adds a finding without another read", () => {
    const capture = nov22Capture();
    const before = buildSundayBrief(capture, rules, NOW).findings.filter(f => f.kind === "streak");
    const after = buildSundayBrief(capture, { ...rules, checkInAfterSundaysInARow: 2 }, NOW).findings.filter(f => f.kind === "streak");
    expect(before).toHaveLength(1);
    expect(after.map(f => f.person_id)).toContain(PEOPLE.nurseryConfirmed);
  });

  it("a failed read adds a Worth a look note and names what wasn't checked", () => {
    const capture = nov22Capture();
    capture.reads.find(r => r.collection === "needed_positions")!.outcome = "provider_failure";
    const brief = buildSundayBrief(capture, rules, NOW);
    expect(brief.status).toBe("unverified");
    expect(brief.findings.some(f => f.kind === "needs-people")).toBe(false);
    expect(brief.findings.at(-1)!.kind).toBe("worth-a-look");
    expect(brief.not_checked.join(" ")).toContain("didn't complete");
  });

  it("no finding text contains a person's name", () => {
    const capture = nov22Capture();
    const text = JSON.stringify(buildSundayBrief(capture, { ...rules, checkInAfterSundaysInARow: 1 }, NOW));
    for (const name of Object.values(capture.names)) expect(text).not.toContain(name);
  });

  it("labels the fictional example and the recording distinctly", () => {
    expect(buildSundayBrief(nov22Capture(), rules, NOW, true).mode).toBe("fictional");
    expect(buildSundayBrief({ ...nov22Capture(), kind: "recording" }, rules, NOW).mode).toBe("recording");
  });
});

const nurseryLead = { ...rules, sundayLeads: [{ team_id: TEAMS.nursery, lead_position: "Nursery Lead" }] };
type Row = { id: string; type: string; attributes: Record<string, unknown>; relationships: Record<string, unknown> };
const rowsOf = (capture: SundayCapture, collection: string) => capture.reads.find(r => r.collection === collection)!.body!.data as Row[];

describe("stable finding identity", () => {
  it("keys findings by team and position, so reordering Planning Center's rows keeps each key", () => {
    const capture = nov22Capture();
    const before = buildSundayBrief(capture, rules, NOW).findings;
    rowsOf(capture, "needed_positions").reverse();
    rowsOf(capture, "team_members").reverse();
    const after = buildSundayBrief(capture, rules, NOW).findings;
    const byName = (fs: typeof before) => Object.fromEntries(fs.filter(f => f.kind === "needs-people").map(f => [f.position!.name, f.key]));
    expect(byName(after)).toEqual(byName(before));
    expect(byName(before).Greeter).toBe(needKey(TEAMS.greeter, "Greeter"));
    expect(before.find(f => f.kind === "needs-people" && f.position!.name === "Greeter")!.id)
      .not.toBe(after.find(f => f.kind === "needs-people" && f.position!.name === "Greeter")!.id);
    expect(before.find(f => f.kind === "pending")!.key).toBe(after.find(f => f.kind === "pending")!.key);
  });

  it("carries the facts a later check is compared against: confirmed people and the team's leaders", () => {
    const findings = buildSundayBrief(nov22Capture(), rules, NOW).findings;
    const nursery = findings.find(f => f.kind === "needs-people" && f.position!.name === "Nursery")!;
    expect(nursery.confirmed).toEqual([PEOPLE.nurseryConfirmed]);
    expect(nursery.leaders).toEqual([PEOPLE.nurseryLeader]);
    expect(nursery.position!.team_id).toBe(TEAMS.nursery);
    const greeter = findings.find(f => f.kind === "needs-people" && f.position!.name === "Greeter")!;
    expect(greeter.leaders).toEqual([]); // read, and Planning Center lists none
  });

  it("a team-leader read that didn't complete leaves leaders unknown, not empty", () => {
    const capture = nov22Capture();
    const read = capture.reads.find(r => r.collection === "team_leaders" && r.team_id === TEAMS.nursery)!;
    read.outcome = "timeout"; delete read.body;
    const nursery = buildSundayBrief(capture, rules, NOW).findings.find(f => f.position?.name === "Nursery")!;
    expect(nursery.leaders).toBeUndefined();
  });

  it("accepts the leader relationship as person or people, one or many", () => {
    const capture = nov22Capture();
    const read = capture.reads.find(r => r.collection === "team_leaders" && r.team_id === TEAMS.nursery)!;
    read.body!.data = [
      { type: "TeamLeader", id: "1", attributes: {}, relationships: { person: { data: { type: "Person", id: "9" } } } },
      { type: "TeamLeader", id: "2", attributes: {}, relationships: { people: { data: [{ type: "Person", id: "8" }, { type: "Person", id: "9" }] } } },
    ];
    expect(teamLeaders(capture)[TEAMS.nursery]).toEqual(["9", "8"]);
  });
});

describe("Sunday lead rule", () => {
  it("asks once per team, with the team's leader attached as oversight", () => {
    const capture = nov22Capture();
    rowsOf(capture, "needed_positions").push({ type: "NeededPosition", id: "303", attributes: { quantity: 1, team_position_name: "Nursery Helper" },
      relationships: { team: { data: { type: "Team", id: TEAMS.nursery } }, time: { data: { type: "PlanTime", id: "9001" } } } });
    const leads = buildSundayBrief(capture, nurseryLead, NOW).findings.filter(f => f.kind === "lead-missing");
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({ key: leadKey(TEAMS.nursery), leaders: [PEOPLE.nurseryLeader], pending_leads: [] });
    expect(leads[0]!.why.join(" ")).toContain("isn't the same as being scheduled to lead");
  });

  it("keeps a pending scheduled lead as a fact, so a later decline can be noticed", () => {
    const capture = nov22Capture();
    rowsOf(capture, "team_members").push({ type: "PlanPerson", id: "404", attributes: { status: "U", team_position_name: "Nursery Lead", notification_sent_at: "2026-11-01T12:00:00Z" },
      relationships: { person: { data: { type: "Person", id: PEOPLE.nurseryLeader } }, team: { data: { type: "Team", id: TEAMS.nursery } }, times: { data: [{ type: "PlanTime", id: "9001" }] } } });
    const lead = buildSundayBrief(capture, nurseryLead, NOW).findings.find(f => f.kind === "lead-missing")!;
    expect(lead.pending_leads).toEqual([PEOPLE.nurseryLeader]);
  });

  it("a lead whose serving time can't be verified is Worth a look, never a confirmed lead", () => {
    const capture = nov22Capture();
    rowsOf(capture, "team_members").push({ type: "PlanPerson", id: "405", attributes: { status: "C", team_position_name: "Nursery Lead", notification_sent_at: null },
      relationships: { person: { data: { type: "Person", id: PEOPLE.nurseryLeader } }, team: { data: { type: "Team", id: TEAMS.nursery } }, times: { data: [] } } });
    const brief = buildSundayBrief(capture, nurseryLead, NOW);
    expect(brief.findings.some(f => f.kind === "lead-missing")).toBe(false);
    const unverified = brief.findings.filter(f => f.kind === "lead-unverified");
    expect(unverified).toHaveLength(1);
    expect(unverified[0]).toMatchObject({ tone: "look", key: JSON.stringify(["lead-unverified", TEAMS.nursery]) });
    expect(brief.positions.find(p => p.name === "Nursery")!.lead).toBe("unverified");
  });
});

describe("Worth a look and What I didn't check", () => {
  it("names each part that wasn't read, in plain words", () => {
    const capture = nov22Capture();
    for (const person of [PEOPLE.riley, PEOPLE.sam]) {
      const read = capture.reads.find(r => r.collection === "person_blockouts" && r.person_id === person)!;
      read.outcome = "timeout"; delete read.body;
    }
    capture.reads.find(r => r.collection === "needed_positions")!.outcome = "denied";
    const brief = buildSundayBrief(capture, rules, NOW);
    const look = brief.findings.find(f => f.kind === "worth-a-look")!;
    expect(look.unread).toEqual(["Open positions: Planning Center didn't allow it.", "Blockouts for 2 people: took too long."]);
    expect(brief.not_checked).toEqual(expect.arrayContaining(look.unread!));
  });

  it("a live check older than 30 minutes is stale; a recording or the example is not", () => {
    expect(buildSundayBrief(nov22Capture(), rules, "2026-11-20T15:20:00Z").stale).toBe(false);
    const late = buildSundayBrief(nov22Capture(), rules, "2026-11-20T18:00:00Z");
    expect(late.stale).toBe(true);
    expect(late.findings.find(f => f.kind === "worth-a-look")?.stale).toBe(true);
    expect(buildSundayBrief({ ...nov22Capture(), kind: "recording" }, rules, "2026-11-26T09:00:00Z").stale).toBe(false);
  });

  it("lists each position as read, so a filled gap can be told apart from a decision", () => {
    const positions = buildSundayBrief(nov22Capture(), rules, NOW).positions;
    expect(positions).toEqual(expect.arrayContaining([
      { team_id: TEAMS.greeter, name: "Greeter", remaining: 1, pending: 0, lead: "not-required" },
      { team_id: TEAMS.lyrics, name: "Lyrics", remaining: 0, pending: 1, lead: "not-required" },
    ]));
  });

  it("rooms and follow-ups are left to the operations check; Groups events are named as unchecked", () => {
    const text = buildSundayBrief(nov22Capture(), rules, NOW).not_checked.join(" ");
    expect(text).toContain("Groups events weren't part of this check.");
    expect(text).not.toContain("rooms");
  });
});
