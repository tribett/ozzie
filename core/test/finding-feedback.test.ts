import { describe, expect, it } from "vitest";
import { buildSundayBrief, type Finding, type SundayBrief } from "../src/sunday-brief.js";
import type { SundayCapture, SundayRules } from "../src/sunday-capture.js";
import { nov22Capture, nov22LaterCapture, PEOPLE, TEAMS } from "../src/fictional-sunday.js";
import { FICTIONAL_ROOM, FICTIONAL_STEP, FICTIONAL_WORKFLOW, withFictionalOperations } from "../src/fictional-operations.js";
import { sundayOperations } from "../src/operations-capture.js";
import { compareSundayCheck, describeChange, recordSundayCheck, type SundayChange } from "../src/sunday-changes.js";
import {
  alwaysEntry, alwaysFor, alwaysText, applyFeedback, briefTarget, canDemote, canPromote, correctionEntry, entryText, feedbackOf, foundOf, keptForBriefing, kindWords, NOTE_MAX, rightAwayChanges, roomTarget,
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

  it("a missing lead is about the whole team", () => {
    const b = brief(nov22Capture(), leadRules);
    const lead = target(b, "lead-missing");
    expect(stopScopes(lead)).toEqual([{ team_id: TEAMS.nursery }]);
    const entry = stopEntry(lead, { team_id: TEAMS.nursery }, AT);
    expect(stopText(entry, nameOf)).toBe("Don't flag a missing lead for the Nursery team.");
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

  it("asks what isn't right: only the finding itself hides it; a person's details or something else keep it showing (audit item 28)", () => {
    const first = brief();
    const nursery = target(first, "needs-people", "Nursery");
    for (const what of ["person", "other"] as const) {
      const entry = correctionEntry(nursery, "Drew moved to the 11:00", AT, what);
      expect(entry).toMatchObject({ type: "correction", what, note: "Drew moved to the 11:00" });
      const kept = brief(nov22Capture(), withFeedback([entry]));
      expect(find(kept, "needs-people", "Nursery")).toBeDefined();
      expect(kept.hidden ?? []).toEqual([]);
      expect(applyFeedback([nursery], x => x, [entry]).hidden).toEqual([]);
      // It is kept with the Church rules, and read back as written.
      expect(feedbackOf({ feedback: [entry] })).toEqual([entry]);
    }
    expect(entryText(correctionEntry(nursery, "", AT, "person"), nameOf)).toBe(`Open roles for Nursery: you said a person's details were wrong for ${first.plan.dates}.`);
    expect(entryText(correctionEntry(nursery, "", AT, "other"), nameOf)).toBe(`Open roles for Nursery: you said something else wasn't right for ${first.plan.dates}.`);
    // The finding itself: hidden, as before; such an entry carries no `what`, like every entry made before the question.
    const hide = correctionEntry(nursery, "", AT, "finding");
    expect(hide).not.toHaveProperty("what");
    expect(find(brief(nov22Capture(), withFeedback([hide])), "needs-people", "Nursery")).toBeUndefined();
    // Anything else in `what` is not this version's entry.
    expect(feedbackOf({ feedback: [{ ...hide, what: "role" }] })).toEqual([]);
    expect(feedbackOf({ feedback: [{ ...hide, what: "finding" }] })).toHaveLength(1);
    expect(() => correctionEntry(nursery, "", AT, "role" as never)).toThrow();
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
    expect(alwaysText(alwaysEntry(lead, AT), nameOf)).toBe("Always prepare a note to the team's leader about a missing lead for the Nursery team.");
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
    // A declined request, a missing lead and a partial check are Worth a look on their cards: they show, never as a notice.
    expect(routeChanges(all, [])).toEqual({ notify: [need], urgent: false, briefing: [], stopped: [], look: [declined, lead, unverified] });
    const briefing = urgencyEntry({ kind: "needs-people", tone: "decision" }, "briefing", AT);
    expect(routeChanges(all, [briefing])).toMatchObject({ notify: [], briefing: [need], look: [declined, lead, unverified], urgent: false });
    const rightAway = urgencyEntry({ kind: "needs-people", tone: "decision" }, "right-away", AT);
    expect(routeChanges(all, [rightAway])).toMatchObject({ notify: [need], look: [declined, lead, unverified], urgent: true });
    const stopLead: FeedbackEntry = { type: "stop", id: "s", kind: "lead-missing", at: AT, scope: { team_id: TEAMS.nursery }, labels: {} };
    const stopPending: FeedbackEntry = { type: "stop", id: "p", kind: "pending", at: AT, scope: { team_id: TEAMS.lyrics, position: "Lyrics", person_id: PEOPLE.lyricsPending }, labels: {} };
    expect(routeChanges(all, [stopLead, stopPending])).toMatchObject({ notify: [need], look: [unverified], stopped: [declined, lead] });
    // A change that couldn't be verified is never kept for the briefing or stopped, whatever is stored: it always shows.
    const forged = { type: "urgency", id: "u", kind: "worth-a-look", at: AT, level: "briefing" } as FeedbackEntry;
    expect(routeChanges([unverified], [forged])).toMatchObject({ notify: [], briefing: [], look: [unverified] });
    // Urgent inside the church's window stays urgent.
    expect(routeChanges([{ ...need, urgency: "urgent" }], []).urgent).toBe(true);
  });

  it("routes new findings the same way", () => {
    const briefing = urgencyEntry({ kind: "room-overlap", tone: "decision" }, "briefing", AT);
    const right = urgencyEntry({ kind: "needs-people", tone: "decision" }, "right-away", AT);
    expect(routeFindings([{ key: "a", kind: "needs-people", tone: "decision" }, { key: "b", kind: "room-overlap", tone: "decision" }], [briefing, right]))
      .toEqual({ notify: ["a"], urgent: true, briefing: ["b"], look: [] });
  });

  it("Worth a look never sends a notice: look changes and findings show in Ozzie, never as a notice, however close to Sunday", () => {
    // Inside the church's window a missing lead is still Worth a look: no notice, and nothing urgent.
    const lead = change("lead-missing", { team_id: TEAMS.nursery, position: "Nursery", urgency: "urgent" });
    const declined = change("pending-declined", { team_id: TEAMS.lyrics, position: "Lyrics", person_id: PEOPLE.lyricsPending });
    const unverified = change("coverage-unverified");
    expect(routeChanges([lead, declined, unverified], [])).toEqual({ notify: [], urgent: false, briefing: [], stopped: [], look: [lead, declined, unverified] });
    const found = [
      { key: "g", kind: "group-meeting", tone: "look" as const },
      { key: "r", kind: "room-overlap", tone: "look" as const },
      { key: "s", kind: "streak", tone: "look" as const },
    ];
    expect(routeFindings(found, [])).toEqual({ notify: [], urgent: false, briefing: [], look: ["g", "r", "s"] });
    // The one exception is the person's own rule: "Always tell me right away" about that kind still tells them,
    // but an uncertain item is never urgent, so quiet hours always hold it.
    const rooms = urgencyEntry({ kind: "room-overlap", tone: "decision" }, "right-away", AT);
    expect(routeFindings(found, [rooms])).toEqual({ notify: ["r"], urgent: false, briefing: [], look: ["g", "s"] });
    const told = { type: "urgency", id: "p", kind: "pending", at: AT, level: "right-away" } as FeedbackEntry;
    expect(routeChanges([declined, lead], [told])).toMatchObject({ notify: [declined], urgent: false, look: [lead] });
  });

  it("Always tell me right away about a kind the Sunday comparison doesn't follow: one newly found becomes a change that brings a notice", () => {
    const kids: SundayRules = { ...base, kidsTeams: [{ team_id: TEAMS.nursery, min_confirmed: 2 }] };
    const found = foundOf(brief(nov22Capture(), kids), null);
    const short = found.find(f => f.kind === "too-few-confirmed")!;
    expect(short).toMatchObject({ tone: "decision", key: JSON.stringify(["too-few-confirmed", TEAMS.nursery, "2026-11-22T14:30:00Z"]) });
    const told = urgencyEntry({ kind: "too-few-confirmed", tone: "decision" }, "right-away", AT);
    const before = found.filter(f => f !== short).map(f => f.key);
    const [change, ...rest] = rightAwayChanges(found, before, [told]);
    expect(rest).toEqual([]);
    expect(change).toMatchObject({ kind: "finding-new", effect: "worse", finding: { kind: "too-few-confirmed", key: short.key, tone: "decision" } });
    expect(routeChanges([change!], [told])).toMatchObject({ notify: [change], urgent: true });
    expect(describeChange(change!, nameOf)).toBe("New since the last check: kids teams with fewer confirmed people than your rule asks. Your Church rules say to tell you right away.");
    // Only kinds the person asked about, only new ones, never on a first check, and never kinds the comparison already follows.
    expect(rightAwayChanges(found, before, [])).toEqual([]);
    expect(rightAwayChanges(found, found.map(f => f.key), [told])).toEqual([]);
    expect(rightAwayChanges(found, null, [told])).toEqual([]);
    const openRoles = urgencyEntry({ kind: "needs-people", tone: "decision" }, "right-away", AT);
    expect(rightAwayChanges(found, [], [openRoles])).toEqual([]);
    // Name-free: ids and kinds only.
    for (const name of Object.values(names)) expect(JSON.stringify(change)).not.toContain(name);
  });

  it("rooms, follow-ups and group meetings are found with the tone their card shows; an uncertain one told right away is never urgent", () => {
    const ops = sundayOperations(withFictionalOperations(nov22Capture()), base)!;
    const found = foundOf({ findings: [] }, ops);
    expect(found.map(f => [f.kind, f.tone])).toEqual([["unowned-overdue", "decision"], ["room-overlap", "look"], ["group-meeting", "look"]]);
    const rooms = urgencyEntry({ kind: "room-overlap", tone: "decision" }, "right-away", AT);
    const changes = rightAwayChanges(found, [], [rooms]);
    expect(changes.map(c => c.finding?.kind)).toEqual(["room-overlap"]);
    expect(routeChanges(changes, [rooms])).toMatchObject({ notify: changes, urgent: false });
    // An out-of-date operations check shows nothing, so nothing is found from it.
    expect(foundOf({ findings: [] }, { ...ops, stale: true })).toEqual([]);
  });

  it("Put this in the briefing: the briefing lists each kind kept for it, with how many this check shows", () => {
    const found = foundOf(brief(), sundayOperations(withFictionalOperations(nov22Capture()), base));
    const keep = [urgencyEntry({ kind: "needs-people", tone: "decision" }, "briefing", AT), urgencyEntry({ kind: "unowned-overdue", tone: "decision" }, "briefing", AT)];
    expect(keptForBriefing(found, keep)).toEqual([{ kind: "needs-people", count: 2 }, { kind: "unowned-overdue", count: 1 }]);
    expect(keptForBriefing(found, [])).toEqual([]);
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

  it("keeps one note per kind on the same finding: a second of another kind never replaces the first (review P, L9)", () => {
    const nursery = target(brief(), "needs-people", "Nursery");
    const hide = correctionEntry(nursery, "Nursery is covered by the 9:00 team", AT, "finding");
    const person = correctionEntry(nursery, "Drew moved to the 11:00", "2026-11-20T15:20:00Z", "person");
    const other = correctionEntry(nursery, "The room changed", "2026-11-20T15:25:00Z", "other");
    // Each kind is kept beside the others, in the order said, and the finding stays hidden by the first.
    const all = withEntry(withEntry(withEntry([], hide), person), other);
    expect(all).toEqual([hide, person, other]);
    expect(applyFeedback([nursery], x => x, all).hidden.map(h => h.entry)).toEqual([hide]);
    // In either order: a note about a person never undoes "the finding isn't right".
    expect(withEntry(withEntry([], person), hide)).toEqual([person, hide]);
    // A second note of the same kind replaces that kind's earlier one, as before.
    const person2 = correctionEntry(nursery, "Drew is back at 9:00", "2026-11-20T15:30:00Z", "person");
    expect(withEntry(all, person2)).toEqual([hide, other, person2]);
    const hide2 = correctionEntry(nursery, "", "2026-11-20T15:35:00Z", "finding");
    expect(withEntry(all, hide2)).toEqual([person, other, hide2]);
  });

  it("names a new kind of finding plainly until it has its own words", () => {
    expect(kindWords("kids-room-adults")).toBe("findings like this");
    expect(stopText({ kind: "kids-room-adults", scope: { team_id: "9", position: "Kids" }, labels: {} }, nameOf)).toBe("Don't flag findings like this for Kids.");
  });
});

// Someone scheduled with a blockout over their serving time (fixture matrix C30-C37).
describe("someone scheduled with a blockout", () => {
  const blockedOut = (ends_at = "2026-11-23T04:59:59Z") => {
    const capture = nov22Capture();
    capture.reads.find(r => r.collection === "person_blockouts" && r.person_id === PEOPLE.greeterConfirmed)!.body = {
      data: [{ type: "Blockout", id: "b1", attributes: { starts_at: "2026-11-22T05:00:00Z", ends_at, repeat_frequency: "no_repeat" } }], meta: { count: 1, total_count: 1 } };
    return capture;
  };

  it("is about that person in that role, can be stopped for them or the role, and never sends a notice", () => {
    const t = target(brief(blockedOut()), "blockout");
    expect(t).toMatchObject({ kind: "blockout", tone: "look", scope: { team_id: TEAMS.greeter, position: "Greeter", person_id: PEOPLE.greeterConfirmed }, action: null });
    expect(stopScopes(t)).toEqual([{ team_id: TEAMS.greeter, position: "Greeter", person_id: PEOPLE.greeterConfirmed }, { team_id: TEAMS.greeter, position: "Greeter" }]);
    expect(stopText(stopEntry(t, stopScopes(t)[0]!, AT), nameOf)).toBe(`Don't flag blockouts during serving times for ${names[PEOPLE.greeterConfirmed]} as Greeter.`);
    expect(find(brief(blockedOut(), withFeedback([stopEntry(t, stopScopes(t)[0]!, AT)])), "blockout")).toBeUndefined();
    expect(canPromote(t)).toBe(false);
    expect(canDemote(t)).toBe(false);
  });

  it("This isn't right hides it only while the blockout's facts stay the same", () => {
    const entry = correctionEntry(target(brief(blockedOut()), "blockout"), "They moved it to Saturday", AT);
    expect(find(brief(blockedOut(), withFeedback([entry])), "blockout")).toBeUndefined();
    // Their serving rows changed (now pending as well as confirmed): it shows again.
    const more = blockedOut();
    (more.reads.find(r => r.collection === "team_members")!.body!.data as unknown[]).push({ type: "PlanPerson", id: "404",
      attributes: { status: "U", team_position_name: "Usher", notification_sent_at: null },
      relationships: { person: { data: { type: "Person", id: PEOPLE.greeterConfirmed } }, team: { data: { type: "Team", id: TEAMS.greeter } }, times: { data: [{ type: "PlanTime", id: "9001" }] } } });
    expect(find(brief(more, withFeedback([entry])), "blockout")).toBeDefined();
  });
});
