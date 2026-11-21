import { describe, expect, it } from "vitest";
import { buildSundayBrief, byServiceTime, findingTime, leadKey, needKey, NO_ONE_TIME, shownUncertainties, sundayShownCount, teamLeaders } from "../src/sunday-brief.js";
import type { SundayCapture } from "../src/sunday-capture.js";
import { nov22Capture, PEOPLE, SERVICE, TEAMS } from "../src/fictional-sunday.js";
import { fictionalOperations, withFictionalOperations } from "../src/fictional-operations.js";
import { sundayOperations, type SundayOperations } from "../src/operations-capture.js";
import { applyDecisions, decide } from "../src/sunday-decisions.js";
import { wednesdayCapture, wednesdayWords } from "./fixtures/service-days/wednesday.js";
import { twoTimes } from "./fixtures/service-days/two-times.js";

const NOW = "2026-11-20T15:05:00Z";
const rules = { sundayLeads: [], checkInAfterSundaysInARow: 3 };

describe("what the Sunday page shows, counted (one number for the headline, the sidebar and Today)", () => {
  const example = withFictionalOperations(nov22Capture());
  const brief = buildSundayBrief(example, rules, example.completed_at, true);
  const ops = sundayOperations(example, rules, {})!;

  it("counts open Services findings, rooms by certainty, follow-ups, room details that couldn't be confirmed and group meetings", () => {
    // Services: two open roles (decisions), the pending request and the streak (Worth a look). Rooms and follow-ups: the follow-up
    // without an owner (a decision), the room overlap no Church rule confirms and the card saying why (Worth a look), and one group meeting.
    expect(ops.result!.findings.map(f => f.label)).toEqual(["Follow-up needs an owner", "Worth a look"]);
    expect(sundayShownCount(applyDecisions(brief, []), ops)).toEqual({ decisions: 3, looks: 5, resolved: 0 });
    // A room the Church rules say isn't shared, with an unresolved overlap: Room use needs review is a decision, and nothing is uncertain.
    expect(sundayShownCount(applyDecisions(brief, []), fictionalOperations())).toEqual({ decisions: 4, looks: 2, resolved: 0 });
  });

  it("leaves out what the person resolved (counted as resolved) and what an out-of-date or missing rooms check doesn't show", () => {
    const nursery = brief.findings.find(f => f.kind === "needs-people" && f.position!.name === "Nursery")!;
    const decided = applyDecisions(brief, [decide(nursery, "not-needed", "Only two babies registered", NOW)]);
    expect(sundayShownCount(decided, ops)).toEqual({ decisions: 2, looks: 5, resolved: 1 });
    const stale: SundayOperations = { ...ops, result: null, group_meetings: [], stale: true, checked_at: null };
    expect(sundayShownCount(applyDecisions(brief, []), stale)).toEqual({ decisions: 2, looks: 2, resolved: 0 });
    expect(sundayShownCount(applyDecisions(brief, []), null)).toEqual({ decisions: 2, looks: 2, resolved: 0 });
  });

  it("a part that couldn't be read is under What I didn't check, not an open question", () => {
    const result = { ...ops.result!, unchecked_scope_ids: ["room887596-rule"] };
    expect(shownUncertainties(result)).toEqual([]);
    expect(shownUncertainties(ops.result)).toHaveLength(1);
    expect(shownUncertainties(null)).toEqual([]);
    expect(sundayShownCount(applyDecisions(brief, []), { ...ops, result })).toEqual({ decisions: 3, looks: 4, resolved: 0 });
  });
});

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

  // B-1 (2026-11-18): a scheduled lead's row attaches to every position of their team, so a pending lead on a team with
  // two positions was listed as pending once per position, under the same id, and named with each position's name.
  it("a pending scheduled lead on a team with two positions is one pending finding, named for the lead's own role", () => {
    const withLead = (helper: boolean) => {
      const capture = nov22Capture();
      if (helper) rowsOf(capture, "needed_positions").push({ type: "NeededPosition", id: "303", attributes: { quantity: 1, team_position_name: "Nursery Helper" },
        relationships: { team: { data: { type: "Team", id: TEAMS.nursery } }, time: { data: { type: "PlanTime", id: "9001" } } } });
      rowsOf(capture, "team_members").push({ type: "PlanPerson", id: "404", attributes: { status: "U", team_position_name: "Nursery Lead", notification_sent_at: "2026-11-01T12:00:00Z" },
        relationships: { person: { data: { type: "Person", id: PEOPLE.nurseryLeader } }, team: { data: { type: "Team", id: TEAMS.nursery } }, times: { data: [{ type: "PlanTime", id: "9001" }] } } });
      return buildSundayBrief(capture, nurseryLead, NOW);
    };
    const brief = withLead(true);
    const ids = brief.findings.map(f => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(brief.findings.filter(f => f.kind === "pending").map(f => [f.id, f.person_id, f.position!.name, f.notification])).toEqual([
      ["pending:404", PEOPLE.nurseryLeader, "Nursery Lead", "sent"],
      ["pending:403", PEOPLE.lyricsPending, "Lyrics", "unsent"],
    ]);
    // A second position on the team adds its own need, and nothing to Worth a look: the count Today and the sidebar show.
    const one = sundayShownCount(applyDecisions(withLead(false), []), null), two = sundayShownCount(applyDecisions(brief, []), null);
    expect(two).toEqual({ ...one, decisions: one.decisions + 1 });
    // The pending lead is still a fact on the lead card, as before.
    expect(brief.findings.find(f => f.kind === "lead-missing")!.pending_leads).toEqual([PEOPLE.nurseryLeader]);
    expect(brief.findings.find(f => f.id === "pending:404")!.position!.interval).toEqual(SERVICE);
    // A lead serving another time is named at their own time, not at the first position's of their team.
    const capture = nov22Capture();
    const later = { starts_at: "2026-11-22T17:00:00Z", ends_at: "2026-11-22T18:00:00Z" };
    rowsOf(capture, "plan_times").push({ type: "PlanTime", id: "9002", attributes: { ...later, time_type: "service" }, relationships: {} });
    rowsOf(capture, "team_members").push({ type: "PlanPerson", id: "404", attributes: { status: "U", team_position_name: "Nursery Lead", notification_sent_at: null },
      relationships: { person: { data: { type: "Person", id: PEOPLE.nurseryLeader } }, team: { data: { type: "Team", id: TEAMS.nursery } }, times: { data: [{ type: "PlanTime", id: "9002" }] } } });
    expect(buildSundayBrief(capture, nurseryLead, NOW).findings.find(f => f.id === "pending:404")!.position).toMatchObject({ name: "Nursery Lead", interval: later });
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

  it("a check whose only gap is a role not tied to a service time says it as that role, never as a failed read (polish 2026-11-21, item 6)", () => {
    const untimed = () => {
      const c = nov22Capture();
      const members = c.reads.find(r => r.collection === "team_members")!.body!.data as { id: string; relationships: Record<string, { data: unknown }> }[];
      members.find(m => m.id === "403")!.relationships.times = { data: [] };
      return c;
    };
    const look = (c: ReturnType<typeof nov22Capture>, now = NOW) => buildSundayBrief(c, rules, now).findings.find(f => f.kind === "worth-a-look");
    expect(look(untimed())?.role_facts).toEqual({ roles: 1, reasons: [
      "Lyrics isn't tied to a service time in Planning Center, so Ozzie can't tell when it serves. Set the role's time in Planning Center to have it checked.",
      "Ozzie couldn't tell from Planning Center who said yes for Lyrics, or when they serve.",
    ] });
    // A read that failed, or a check out of date, is never said as roles alone.
    const failed = untimed();
    failed.reads = failed.reads.map(r => r.collection === "person_blockouts" ? { ...r, outcome: "timeout" as const } : r);
    expect(look(failed)?.unread?.length).toBeGreaterThan(0);
    expect(look(failed)?.role_facts).toBeUndefined();
    expect(look(untimed(), "2026-11-20T16:30:00Z")?.stale).toBe(true);
    expect(look(untimed(), "2026-11-20T16:30:00Z")?.role_facts).toBeUndefined();
    // Every read complete and no role in question: no such note at all.
    expect(look(nov22Capture())).toBeUndefined();
  });

  it("rooms and follow-ups are left to the operations check; group events are named as unchecked", () => {
    const text = buildSundayBrief(nov22Capture(), rules, NOW).not_checked.join(" ");
    expect(text).toContain("Group events weren't part of this check.");
    // Polish 2026-11-21: "Groups events" was a typo on What I didn't check.
    expect(text).not.toContain("Groups events");
    expect(text).not.toContain("rooms");
  });
});

// Someone scheduled who has a blockout over their serving time (fixture matrix C30-C37): Worth a look, never a gap, and
// Planning Center's own count of who is needed stays as it reads.
describe("someone scheduled with a blockout at that time", () => {
  const ALL_DAY = { starts_at: "2026-11-22T05:00:00Z", ends_at: "2026-11-23T04:59:59Z" };
  const blockouts = (capture: SundayCapture, person: string, ...attributes: Record<string, unknown>[]) => {
    capture.reads.find(r => r.collection === "person_blockouts" && r.person_id === person)!.body = {
      data: attributes.map((a, i) => ({ type: "Blockout", id: `b${person}-${i}`, attributes: { repeat_frequency: "no_repeat", ...a } })),
      meta: { count: attributes.length, total_count: attributes.length } };
    return capture;
  };
  /** Every role filled and nothing else to look at: the one path to "Everything Ozzie checked is covered". */
  const covered = () => {
    const capture = nov22Capture();
    blockouts(capture, PEOPLE.drew);
    capture.reads.find(r => r.collection === "needed_positions")!.body = { data: [], meta: { count: 0, total_count: 0 } };
    const members = rowsOf(capture, "team_members");
    members.splice(members.findIndex(m => m.id === "403"), 1);
    for (const read of capture.reads.filter(r => r.collection === "team_position_assignments")) {
      read.body!.data = (read.body!.data as Row[]).filter(a => [PEOPLE.greeterConfirmed, PEOPLE.nurseryConfirmed].includes((a.relationships.person as { data: { id: string } }).data.id));
    }
    return capture;
  };
  const blocked = (brief: ReturnType<typeof buildSundayBrief>) => brief.findings.filter(f => f.kind === "blockout");
  /** No Church-rule check-ins, so a covered Sunday has nothing else on it. */
  const quiet = { ...rules, checkInAfterSundaysInARow: 0 };

  it("C30 a confirmed person on a fully covered role is one Worth a look finding, and the check no longer reads as all clear", () => {
    expect(buildSundayBrief(covered(), quiet, NOW).status).toBe("checked-scope-clear");
    const brief = buildSundayBrief(blockouts(covered(), PEOPLE.greeterConfirmed, ALL_DAY), quiet, NOW);
    expect(brief.status).toBe("findings");
    expect(brief.findings).toEqual([{
      id: `blockout:${PEOPLE.greeterConfirmed}`, key: JSON.stringify(["blockout", PEOPLE.greeterConfirmed]), kind: "blockout", tone: "look",
      position: { id: "position:1", team_id: TEAMS.greeter, name: "Greeter", interval: SERVICE }, person_id: PEOPLE.greeterConfirmed,
      serving: [{ name: "Greeter", team_id: TEAMS.greeter, status: "confirmed", interval: SERVICE }],
      why: [
        "Planning Center Services has them confirmed for Greeter.",
        "Planning Center has a blockout for them that overlaps that time. A blockout is when someone has told Planning Center they'll be away.",
        "Planning Center still counts them as scheduled, so its count of who is still needed doesn't change, and Ozzie doesn't change it either.",
        "This is a schedule fact, not a judgment about anyone.",
      ],
    }]);
    // The role still reads as Planning Center reads it: nothing remaining, nothing pending.
    expect(brief.positions.find(p => p.name === "Greeter")).toEqual({ team_id: TEAMS.greeter, name: "Greeter", remaining: 0, pending: 0, lead: "not-required" });
    expect(sundayShownCount(applyDecisions(brief, []), null)).toEqual({ decisions: 0, looks: 1, resolved: 0 });
  });

  it("C30 an open role keeps Planning Center's own count beside it, and a pending person is named as pending as well", () => {
    const capture = blockouts(blockouts(nov22Capture(), PEOPLE.greeterConfirmed, ALL_DAY), PEOPLE.lyricsPending, { starts_at: "2026-11-22T15:00:00Z", ends_at: "2026-11-22T17:00:00Z" });
    const brief = buildSundayBrief(capture, rules, NOW);
    const greeter = brief.findings.find(f => f.kind === "needs-people" && f.position!.name === "Greeter")!;
    expect(greeter.remaining).toBe(1);
    expect(greeter.why[0]).toBe("Planning Center reports 1 remaining request for Greeter.");
    expect(blocked(brief).map(f => [f.person_id, f.serving!.map(s => s.status)])).toEqual([[PEOPLE.greeterConfirmed, ["confirmed"]], [PEOPLE.lyricsPending, ["pending"]]]);
    expect(brief.findings.filter(f => f.kind === "pending").map(f => f.person_id)).toEqual([PEOPLE.lyricsPending]);
    // After each role's own findings, before the Church-rule check-ins.
    expect(brief.findings.map(f => f.kind)).toEqual(["needs-people", "needs-people", "pending", "blockout", "blockout", "streak"]);
  });

  it("C31-C33 a declined person, someone not on the plan and a blockout that doesn't overlap produce nothing", () => {
    const declined = blockouts(nov22Capture(), PEOPLE.nurseryConfirmed, ALL_DAY);
    rowsOf(declined, "team_members").find(m => m.id === "402")!.attributes.status = "D";
    expect(blocked(buildSundayBrief(declined, rules, NOW))).toEqual([]);
    // Riley could help with Greeter but isn't on the plan: the blockout only leaves them out of the people who could help.
    const notOnPlan = buildSundayBrief(blockouts(nov22Capture(), PEOPLE.riley, ALL_DAY), rules, NOW);
    expect(blocked(notOnPlan)).toEqual([]);
    expect(notOnPlan.findings[0]!.people!.left_out.map(p => p.person_id)).toContain(PEOPLE.riley);
    const before = blockouts(nov22Capture(), PEOPLE.greeterConfirmed, { starts_at: "2026-11-22T12:00:00Z", ends_at: "2026-11-22T14:30:00Z" });
    expect(blocked(buildSundayBrief(before, rules, NOW))).toEqual([]);
  });

  it("C34/C37 two blockouts make one finding, and someone on two roles at once is one finding naming both", () => {
    expect(blocked(buildSundayBrief(blockouts(covered(), PEOPLE.greeterConfirmed, ALL_DAY, { starts_at: "2026-11-22T14:00:00Z", ends_at: "2026-11-22T16:00:00Z" }), rules, NOW))).toHaveLength(1);
    const capture = blockouts(covered(), PEOPLE.greeterConfirmed, ALL_DAY);
    rowsOf(capture, "team_members").push({ type: "PlanPerson", id: "404", attributes: { status: "U", team_position_name: "Usher", notification_sent_at: null },
      relationships: { person: { data: { type: "Person", id: PEOPLE.greeterConfirmed } }, team: { data: { type: "Team", id: TEAMS.greeter } }, times: { data: [{ type: "PlanTime", id: "9001" }] } } });
    const found = blocked(buildSundayBrief(capture, rules, NOW));
    expect(found).toHaveLength(1);
    expect(found[0]!.serving).toEqual([
      { name: "Greeter", team_id: TEAMS.greeter, status: "confirmed", interval: SERVICE },
      { name: "Usher", team_id: TEAMS.greeter, status: "pending", interval: SERVICE },
    ]);
    expect(found[0]!.why.slice(0, 2)).toEqual(["Planning Center Services has them confirmed for Greeter.", "Planning Center Services has them pending for Usher."]);
  });

  it("C35 a scheduled person's blockout that can't be checked is named under What I didn't check, never as clear or as a finding", () => {
    const brief = buildSundayBrief(blockouts(covered(), PEOPLE.greeterConfirmed, { ...ALL_DAY, repeat_frequency: "every_1_week" }), quiet, NOW);
    expect(blocked(brief)).toEqual([]);
    expect(brief.status).toBe("unverified");
    expect(brief.not_checked).toContain("Blockouts for 1 scheduled person couldn't be checked for this service time.");
    // The person and the reason stay out of the "couldn't be checked" card: nothing failed to read.
    expect(brief.findings.some(f => f.kind === "worth-a-look")).toBe(false);
  });

  it("holds no name, and names the service by its own day", () => {
    const capture = blockouts(nov22Capture(), PEOPLE.greeterConfirmed, ALL_DAY);
    const text = JSON.stringify(buildSundayBrief(capture, rules, NOW));
    for (const name of Object.values(capture.names)) expect(text).not.toContain(name);
    const wed = wednesdayCapture();
    const read = wed.reads.find(r => r.collection === "person_blockouts" && r.person_id === PEOPLE.greeterConfirmed)!;
    read.body = { data: [{ type: "Blockout", id: "w1", attributes: { starts_at: "2026-11-25T05:00:00Z", ends_at: "2026-11-26T04:59:59Z", repeat_frequency: "no_repeat" } }], meta: { count: 1, total_count: 1 } };
    const b = buildSundayBrief(wed, rules, wed.completed_at);
    expect(blocked(b)).toHaveLength(1);
    expect(blocked(b)[0]!.why.join(" ")).not.toMatch(/sunday/iu);
  });
});

// Onboarding spec §5 (decision 18): a brief for a Wednesday plan carries Wednesday's words, and every fixed sentence in it
// names the service by its day; nothing calls it Sunday.
describe("a Wednesday plan", () => {
  const wed = wednesdayCapture();
  const leadRules = { ...rules, sundayLeads: [{ team_id: TEAMS.nursery, lead_position: "Nursery Lead" }] };
  const b = buildSundayBrief(wed, leadRules, wed.completed_at);

  it("carries the day words of its service time in the church's zone", () => {
    expect(b.day).toEqual(wednesdayWords());
    expect(buildSundayBrief(nov22Capture(), rules, NOW).day).toMatchObject({ day: "Sunday", thisOne: "this Sunday" });
  });

  it("says Wednesday lead, this Wednesday and weeks in a row, and never Sunday", () => {
    const why = b.findings.flatMap(f => f.why);
    expect(why).toContain('Your Church rules ask for a scheduled Wednesday lead on this team (position "Nursery Lead").');
    expect(why).toContain("Planning Center lists 1 team leader for this team. Leading the team isn't the same as being scheduled to lead this Wednesday.");
    expect(why).toContain("Your Church rules say: check in with anyone scheduled 3 weeks in a row.");
    expect(why).toContain("Planning Center shows them confirmed 3 weeks in a row (Greeter), ending this Wednesday.");
    // Every sentence the brief holds for a person to read (field names like `sundays` are code, never shown).
    expect([...why, ...b.not_checked, ...b.findings.flatMap(f => f.unread ?? []), b.plan.title ?? ""].join(" ")).not.toMatch(/sunday/iu);
  });
});

describe("one plan with two service times: what each service needs (owner decision 2026-11-19)", () => {
  const two = twoTimes();
  const brief = buildSundayBrief(two, rules, two.completed_at, true);
  const shown = (groups: ReturnType<typeof byServiceTime<(typeof brief.findings)[number]>>) =>
    groups?.map(g => [g.label, g.items.map(f => `${f.kind}${f.position ? ` ${f.position.name}` : ""}`)]);

  it("keeps both service times, earliest first, as read", () => {
    expect(brief.times).toEqual([SERVICE.starts_at, "2026-11-22T16:00:00Z"]);
  });

  it("puts each finding under the service time it is about, every time named, and what names no one time last", () => {
    expect(shown(byServiceTime(brief.findings, findingTime, brief.times, brief.time_zone))).toEqual([
      ["9:30 AM", ["needs-people Greeter", "pending Lyrics"]],
      ["11:00 AM", ["needs-people Nursery"]],
      [NO_ONE_TIME, ["streak"]],
    ]);
    // A time with nothing open is still named, so a pastor sees each service.
    const greeterOnly = brief.findings.filter(f => f.position?.name === "Greeter");
    expect(shown(byServiceTime(greeterOnly, findingTime, brief.times, brief.time_zone))).toEqual([["9:30 AM", ["needs-people Greeter"]], ["11:00 AM", []]]);
  });

  it("a plan with one service time isn't grouped: the page lists everything together, as before", () => {
    const one = buildSundayBrief(nov22Capture(), rules, nov22Capture().completed_at, true);
    expect(one.times).toEqual([SERVICE.starts_at]);
    expect(byServiceTime(one.findings, findingTime, one.times, one.time_zone)).toBeNull();
    expect(byServiceTime(brief.findings, findingTime, undefined, brief.time_zone)).toBeNull();
  });

  it("a check that couldn't be completed, and a person's weeks in a row, name no single time", () => {
    expect(findingTime({ kind: "worth-a-look" })).toBeNull();
    expect(findingTime({ kind: "streak" })).toBeNull();
    expect(findingTime({ kind: "needs-people", position: { id: "p", team_id: "t", name: "Greeter", interval: null } })).toBeNull();
  });
});

