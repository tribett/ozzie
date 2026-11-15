import { describe, expect, it } from "vitest";
import { buildSundayBrief, type Finding, type SundayBrief } from "../src/sunday-brief.js";
import type { SundayCapture, SundayRules } from "../src/sunday-capture.js";
import { nov22Capture, nov22LaterCapture, PEOPLE, TEAMS } from "../src/fictional-sunday.js";
import { FICTIONAL_ROOM, FICTIONAL_STEP, FICTIONAL_WORKFLOW, withFictionalOperations } from "../src/fictional-operations.js";
import { sundayOperations } from "../src/operations-capture.js";
import { compareSundayCheck, recordSundayCheck, type SundayChange } from "../src/sunday-changes.js";
import {
  alwaysEntry, alwaysFor, alwaysText, applyFeedback, briefTarget, canDemote, canPromote, correctionEntry, entryText, feedbackOf, kindWords, NOTE_MAX, roomTarget,
  routeChanges, routeFindings, stopEntry, stopScopes, stopText, urgencyEntry, urgencyFor, urgencyText, withEntry, withoutEntry,
  type FeedbackEntry, type FeedbackTarget,
} from "../src/finding-feedback.js";

const AT = "2026-11-20T15:10:00Z";
const base: SundayRules = { sundayLeads: [], checkInAfterSundaysInARow: 3 };
const withFeedback = (feedback: FeedbackEntry[], rules: SundayRules = base): SundayRules => ({ ...rules, feedback });
const brief = (capture: SundayCapture = nov22Capture(), rules: SundayRules = base) => buildSundayBrief(capture, rules, capture.completed_at);
const find = (b: SundayBrief, kind: Finding["kind"], position?: string) => b.findings.find(f => f.kind === kind && (!position || f.position?.name === position));
const target = (b: SundayBrief, kind: Finding["kind"], position?: string) => briefTarget(find(b, kind, position)!, b.plan.id, b.plan.dates);
const names = nov22Capture().names;
const nameOf = (id: string) => names[id];
const leadRules: SundayRules = { ...base, sundayLeads: [{ team_id: TEAMS.nursery, lead_position: "Nursery Lead" }] };
/** The same Sunday, with the Lyrics request sent and still unanswered. */
function sentRequest(): SundayCapture {
  const capture = nov22Capture();
  const members = capture.reads.find(r => r.collection === "team_members")!.body!.data as { id: string; attributes: Record<string, unknown> }[];
  members.find(m => m.id === "403")!.attributes.notification_sent_at = "2026-11-18T12:00:00Z";
  return capture;
}

describe("Stop flagging this", () => {
  it("sets the finding aside from the next check on, says why, and comes back when the entry is deleted", () => {
    const first = brief();
    const streak = find(first, "streak")!;
    const entry = stopEntry(target(first, "streak"), stopScopes(target(first, "streak"))[0]!, AT);
    const next = brief(nov22Capture(), withFeedback([entry]));
    expect(find(next, "streak")).toBeUndefined();
    expect(next.hidden).toEqual([{ finding: expect.objectContaining({ key: streak.key }), entry }]);
    // Nothing else moved.
    expect(next.findings.map(f => f.key)).toEqual(first.findings.filter(f => f.kind !== "streak").map(f => f.key));
    expect(stopText(entry, nameOf)).toBe(`Don't flag serving streaks for ${names[streak.person_id!]}.`);
    const back = brief(nov22Capture(), withFeedback(withoutEntry([entry], entry.id)));
    expect(find(back, "streak")?.key).toBe(streak.key);
    expect(back.hidden).toBeUndefined();
  });

  it("is scoped narrowly: someone else's streak, or a request for another role, still shows", () => {
    const t = target(brief(), "streak");
    const other: FeedbackTarget = { ...t, key: JSON.stringify(["streak", PEOPLE.sam]), scope: { person_id: PEOPLE.sam } };
    const entry = stopEntry(t, t.scope, AT);
    expect(applyFeedback([t, other], x => x, [entry]).shown).toEqual([other]);
    // A request not yet accepted: this person in this role first, then anyone in that role.
    const pending = target(brief(), "pending");
    expect(stopScopes(pending)).toEqual([
      { team_id: TEAMS.lyrics, position: "Lyrics", person_id: PEOPLE.lyricsPending },
      { team_id: TEAMS.lyrics, position: "Lyrics" },
    ]);
    const narrow = stopEntry(pending, stopScopes(pending)[0]!, AT);
    const someoneElse = { ...pending, key: "other", scope: { ...pending.scope, person_id: PEOPLE.riley } };
    const otherRole = { ...pending, key: "role", scope: { ...pending.scope, team_id: TEAMS.greeter, position: "Greeter" } };
    expect(applyFeedback([pending, someoneElse, otherRole], x => x, [narrow]).shown).toEqual([someoneElse, otherRole]);
    const role = stopEntry(pending, stopScopes(pending)[1]!, AT);
    expect(applyFeedback([pending, someoneElse, otherRole], x => x, [role]).shown).toEqual([otherRole]);
    expect(stopText(narrow, nameOf)).toBe(`Don't flag requests not yet accepted for ${names[PEOPLE.lyricsPending]} as Lyrics.`);
    expect(stopText(role, nameOf)).toBe("Don't flag requests not yet accepted for Lyrics.");
  });

  it("a missing Sunday lead is about the whole team", () => {
    const b = brief(nov22Capture(), leadRules);
    const lead = target(b, "lead-missing");
    expect(stopScopes(lead)).toEqual([{ team_id: TEAMS.nursery }]);
    const entry = stopEntry(lead, { team_id: TEAMS.nursery }, AT);
    expect(stopText(entry, nameOf)).toBe("Don't flag a missing Sunday lead for the Nursery team.");
    expect(find(brief(nov22Capture(), withFeedback([entry], leadRules)), "lead-missing")).toBeUndefined();
  });

  it("is never offered for open roles or a check that couldn't be completed, and a forged entry can't hide either", () => {
    const failed = nov22Capture();
    failed.reads.find(r => r.collection === "plan_times")!.outcome = "timeout";
    const b = brief(failed);
    const incomplete = target(b, "worth-a-look");
    expect(stopScopes(incomplete)).toEqual([]);
    expect(stopScopes(target(brief(), "needs-people", "Greeter"))).toEqual([]);
    expect(() => stopEntry(target(brief(), "needs-people", "Greeter"), { team_id: TEAMS.greeter, position: "Greeter" }, AT)).toThrow();
    expect(() => correctionEntry(incomplete, "it's fine", AT)).toThrow();
    const forged = [
      { type: "stop", id: "a", kind: "worth-a-look", at: AT, scope: { team_id: "x" }, labels: {} },
      { type: "stop", id: "b", kind: "needs-people", at: AT, scope: { team_id: TEAMS.greeter, position: "Greeter" }, labels: {} },
      { type: "correction", id: "c", kind: "worth-a-look", at: AT, key: find(b, "worth-a-look")!.key, occurrence: b.plan.id, facts: incomplete.facts, scope: {}, labels: {}, note: "" },
    ];
    const rules = { ...base, feedback: forged } as unknown as SundayRules;
    expect(feedbackOf(rules).map(e => e.id)).toEqual(["c"]);
    expect(find(brief(failed, rules), "worth-a-look")).toBeDefined();
    expect(find(brief(nov22Capture(), rules), "needs-people", "Greeter")).toBeDefined();
  });
});

describe("This isn't right", () => {
  it("hides that one occurrence with what the person said, and only while its facts stay the same", () => {
    const first = brief();
    const nursery = target(first, "needs-people", "Nursery");
    const entry = correctionEntry(nursery, "  The   class has two helpers already  ", AT);
    expect(entry).toMatchObject({ type: "correction", kind: "needs-people", note: "The class has two helpers already", occurrence: first.plan.id });
    expect(entryText(entry, nameOf)).toBe(`Open roles for Nursery: you said this wasn't right for ${first.plan.dates}.`);
    const same = brief(nov22Capture(), withFeedback([entry]));
    expect(find(same, "needs-people", "Nursery")).toBeUndefined();
    expect(same.hidden?.[0]?.entry).toBe(entry);
    // Planning Center changed for Nursery: it comes back.
    expect(find(brief(nov22LaterCapture(), withFeedback([entry])), "needs-people", "Nursery")).toBeDefined();
    // Another Sunday is another occurrence.
    const other = nov22Capture();
    other.plan_id = "92902198";
    expect(find(brief(other, withFeedback([entry])), "needs-people", "Nursery")).toBeDefined();
  });

  it("keeps an optional note short", () => {
    const t = target(brief(), "streak");
    expect(correctionEntry(t, "", AT).note).toBe("");
    expect(() => correctionEntry(t, "x".repeat(NOTE_MAX + 1), AT)).toThrow(/shorter/);
  });
});

describe("Always do this", () => {
  it("fits a request with no answer yet (a reminder) and a missing lead with a listed leader (a note to the leader), for the role or team", () => {
    // A request that was never sent gets no reminder: sending it is the person's step in Planning Center.
    expect(target(brief(), "pending").action).toBeNull();
    const pending = target(brief(sentRequest()), "pending");
    expect(pending.action).toBe("prepare-reminder");
    const entry = alwaysEntry(pending, AT);
    expect(entry.scope).toEqual({ team_id: TEAMS.lyrics, position: "Lyrics" });
    expect(alwaysText(entry, nameOf)).toBe("Always prepare a reminder note when a request for Lyrics has no answer yet.");
    expect(alwaysFor([entry], { ...pending, scope: { ...pending.scope, person_id: PEOPLE.riley } })).toBe(entry);
    expect(alwaysFor([entry], { ...pending, scope: { team_id: TEAMS.greeter, position: "Greeter", person_id: PEOPLE.riley } })).toBeNull();
    const lead = target(brief(nov22Capture(), leadRules), "lead-missing");
    expect(lead.action).toBe("prepare-leader-note");
    expect(alwaysText(alwaysEntry(lead, AT), nameOf)).toBe("Always prepare a note to the team's leader about a missing Sunday lead for the Nursery team.");
    expect(target(brief(), "streak").action).toBeNull();
    expect(() => alwaysEntry(target(brief(), "streak"), AT)).toThrow();
  });
});

describe("Always tell me right away / Put this in the briefing", () => {
  const change = (kind: SundayChange["kind"], extra: Partial<SundayChange> = {}): SundayChange =>
    ({ id: `${kind}:x`, kind, effect: "worse", urgency: "attention", ...extra });

  it("is one choice per kind; Worth a look never interrupts, and the briefing is offered only where a notice could come", () => {
    const need = target(brief(), "needs-people", "Greeter"), streak = target(brief(), "streak"), pending = target(brief(), "pending");
    expect(canPromote(need)).toBe(true);
    expect(canPromote(streak)).toBe(false);
    expect(canPromote(pending)).toBe(false);
    expect(() => urgencyEntry(streak, "right-away", AT)).toThrow(/never interrupts/);
    // A declined request or a lead who dropped out can bring a notice; a serving streak never does.
    expect([need, pending, target(brief(nov22Capture(), leadRules), "lead-missing")].map(canDemote)).toEqual([true, true, true]);
    expect(canDemote(streak)).toBe(false);
    expect(() => urgencyEntry(streak, "briefing", AT)).toThrow();
    let entries = withEntry([], urgencyEntry(need, "right-away", AT));
    entries = withEntry(entries, urgencyEntry(need, "briefing", "2026-11-20T15:11:00Z"));
    expect(entries.map(e => e.type === "urgency" && e.level)).toEqual(["briefing"]);
    expect(urgencyFor(entries, "needs-people")).toBe("briefing");
    expect(urgencyText({ kind: "needs-people", level: "right-away" })).toBe("Always tell me right away about open roles.");
    expect(urgencyText({ kind: "streak", level: "briefing" })).toBe("Put serving streaks in the briefing.");
  });

  it("routes a check's changes: the briefing keeps a kind out of notices, right away marks it urgent, stopped ones drop out", () => {
    const need = change("need-increased", { team_id: TEAMS.greeter, position: "Greeter", from: 1, to: 2 });
    const declined = change("pending-declined", { team_id: TEAMS.lyrics, position: "Lyrics", person_id: PEOPLE.lyricsPending });
    const lead = change("lead-missing", { team_id: TEAMS.nursery, position: "Nursery" });
    const unverified = change("coverage-unverified");
    const better = { ...change("need-filled"), effect: "better" as const };
    const all = [need, declined, lead, unverified, better];
    expect(routeChanges(all, [])).toEqual({ notify: [need, declined, lead, unverified], urgent: false, briefing: [], stopped: [] });
    const briefing = urgencyEntry({ kind: "needs-people", tone: "decision" }, "briefing", AT);
    expect(routeChanges(all, [briefing])).toMatchObject({ notify: [declined, lead, unverified], briefing: [need], urgent: false });
    const rightAway = urgencyEntry({ kind: "needs-people", tone: "decision" }, "right-away", AT);
    expect(routeChanges(all, [rightAway])).toMatchObject({ notify: [need, declined, lead, unverified], urgent: true });
    const stopLead: FeedbackEntry = { type: "stop", id: "s", kind: "lead-missing", at: AT, scope: { team_id: TEAMS.nursery }, labels: {} };
    const stopPending: FeedbackEntry = { type: "stop", id: "p", kind: "pending", at: AT, scope: { team_id: TEAMS.lyrics, position: "Lyrics", person_id: PEOPLE.lyricsPending }, labels: {} };
    expect(routeChanges(all, [stopLead, stopPending])).toMatchObject({ notify: [need, unverified], stopped: [declined, lead] });
    // A change that couldn't be verified is never routed away, whatever is stored.
    const forged = { type: "urgency", id: "u", kind: "worth-a-look", at: AT, level: "briefing" } as FeedbackEntry;
    expect(routeChanges([unverified], [forged]).notify).toEqual([unverified]);
    // Urgent inside the church's window stays urgent.
    expect(routeChanges([{ ...need, urgency: "urgent" }], []).urgent).toBe(true);
  });

  it("routes new findings the same way", () => {
    const briefing = urgencyEntry({ kind: "room-overlap", tone: "decision" }, "briefing", AT);
    const right = urgencyEntry({ kind: "needs-people", tone: "decision" }, "right-away", AT);
    expect(routeFindings([{ key: "a", kind: "needs-people", tone: "decision" }, { key: "b", kind: "room-overlap", tone: "decision" }], [briefing, right]))
      .toEqual({ notify: ["a"], urgent: true, briefing: ["b"] });
  });

  it("a stopped lead no longer brings a change notice from the regular check", () => {
    const rules = withFeedback([{ type: "stop", id: "s", kind: "lead-missing", at: AT, scope: { team_id: TEAMS.nursery }, labels: {} }], leadRules);
    const confirmedLead = nov22Capture();
    const members = confirmedLead.reads.find(r => r.collection === "team_members")!.body!.data as unknown[];
    members.push({ type: "PlanPerson", id: "499", attributes: { status: "C", team_position_name: "Nursery Lead", notification_sent_at: "2026-11-18T00:00:00Z" },
      relationships: { person: { data: { type: "Person", id: PEOPLE.nurseryLeader } }, team: { data: { type: "Team", id: TEAMS.nursery } }, times: { data: [{ type: "PlanTime", id: "9001" }] } } });
    const before = compareSundayCheck(null, recordSundayCheck(confirmedLead, rules, confirmedLead.completed_at), { now: AT, urgentWithinHours: 48 });
    const after = compareSundayCheck(before.memory, recordSundayCheck(nov22Capture(), rules, AT), { now: AT, urgentWithinHours: 48 });
    const lead = after.changes.find(c => c.kind === "lead-missing")!;
    expect(lead).toMatchObject({ team_id: TEAMS.nursery, effect: "worse" });
    expect(routeChanges(after.changes, feedbackOf(rules)).stopped).toEqual([lead]);
  });
});

describe("rooms, follow-ups and group meetings", () => {
  const capture = () => withFictionalOperations(nov22Capture());
  const sanctuary: SundayRules = { ...base, rooms: [{ room_id: FICTIONAL_ROOM, exclusive: true, setup_minutes: 30 }] };

  it("sets a room overlap aside by room, and never then says nothing was found", () => {
    const ops = sundayOperations(capture(), sanctuary)!;
    const room = ops.result!.findings.find(f => f.kind === "room-overlap")!;
    expect(room).toBeDefined();
    const t = roomTarget(room, "92902197", ops.labels);
    expect(t.scope).toEqual({ room_id: room.resource_id });
    expect(room.resource_id).toContain(FICTIONAL_ROOM);
    const entry = stopEntry(t, t.scope, AT);
    const after = sundayOperations(capture(), withFeedback([entry], sanctuary))!;
    expect(after.result!.findings.some(f => f.kind === "room-overlap")).toBe(false);
    expect(after.hidden).toEqual([expect.objectContaining({ kind: "room-overlap", entry })]);
    expect(after.clear).toEqual([]);
    expect(stopText(entry, nameOf)).toMatch(/^Don't flag overlapping room bookings in .+\.$/u);
  });

  it("a follow-up is about its step first, then the whole follow-up; a group meeting is about the person", () => {
    const ops = sundayOperations(capture(), base)!;
    const followUp = ops.result!.findings.find(f => f.kind === "unowned-overdue")!;
    const b = brief(capture());
    const follow = { kind: followUp.kind, scope: { workflow_id: FICTIONAL_WORKFLOW, step_id: FICTIONAL_STEP } };
    expect(stopScopes(follow)).toEqual([{ workflow_id: FICTIONAL_WORKFLOW, step_id: FICTIONAL_STEP }, { workflow_id: FICTIONAL_WORKFLOW }]);
    const meeting = ops.group_meetings[0]!;
    const entry: FeedbackEntry = { type: "stop", id: "g", kind: "group-meeting", at: AT, scope: { person_id: meeting.person_id }, labels: {} };
    const after = sundayOperations(capture(), withFeedback([entry]))!;
    expect(after.group_meetings.some(m => m.person_id === meeting.person_id)).toBe(false);
    expect(after.hidden).toEqual([{ kind: "group-meeting", key: `group:${meeting.person_id}`, entry }]);
    expect(b.findings.length).toBeGreaterThan(0);
  });
});

describe("keeping entries", () => {
  it("replaces an entry that says the same thing, deletes by id, and drops anything of another shape", () => {
    const t = target(brief(), "streak");
    const one = stopEntry(t, t.scope, AT), again = stopEntry(t, t.scope, "2026-11-20T15:20:00Z");
    expect(withEntry(withEntry([], one), again)).toEqual([again]);
    expect(withoutEntry([one], one.id)).toEqual([]);
    const junk = [null, 3, { type: "stop", id: "x", kind: "streak", at: AT, scope: {}, labels: {} }, { type: "always", id: "y", kind: "pending", at: AT, action: "send-it", scope: { position: "Lyrics" }, labels: {} },
      { type: "urgency", id: "z", kind: "streak", at: AT, level: "loud" }, one];
    expect(feedbackOf({ feedback: junk })).toEqual([one]);
    expect(feedbackOf({ feedback: "nope" })).toEqual([]);
    expect(feedbackOf({})).toEqual([]);
  });

  it("names a new kind of finding plainly until it has its own words", () => {
    expect(kindWords("kids-room-adults")).toBe("findings like this");
    expect(stopText({ kind: "kids-room-adults", scope: { team_id: "9", position: "Kids" }, labels: {} }, nameOf)).toBe("Don't flag findings like this for Kids.");
  });
});
