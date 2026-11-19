import { describe, expect, it } from "vitest";
import { evaluateAttentionImport, type AttentionReport } from "../src/attention-import/index.js";
import { harborAttentionImport } from "../src/fictional-attention.js";
import { CHECKED, nov22Capture, nov22LaterCapture, TEAMS } from "../src/fictional-sunday.js";
import { FICTIONAL_ROOM, withFictionalOperations } from "../src/fictional-operations.js";
import { sundayOperations } from "../src/operations-capture.js";
import { buildSundayBrief, needKey, sundayShownCount, type Finding, type SundayBrief } from "../src/sunday-brief.js";
import { applyDecisions, decide } from "../src/sunday-decisions.js";
import { buildSpokenBriefing, MAX_SPOKEN_CHARS, MAX_SPOKEN_SECONDS, SPOKEN_WORDS_PER_MINUTE } from "../src/spoken-briefing.js";
import { wednesdayCapture, wednesdayWords } from "./fixtures/service-days/wednesday.js";

const rules = { sundayLeads: [{ team_id: TEAMS.nursery, lead_position: "Nursery lead" }], checkInAfterSundaysInARow: 3 };
const capture = nov22Capture();
const sunday = buildSundayBrief(capture, rules, capture.completed_at, true);
const pending = sunday.findings.find(f => f.kind === "pending")!;
const report = evaluateAttentionImport(harborAttentionImport());
if (!report.ok) throw new Error("fixture");
const attention: AttentionReport = report;
const tz = "America/New_York";
const base = { attention, ignoredInstructions: 1, quietCount: 3, sunday };
const DEVOTIONAL = /\b(pray|prayer|prayers|bless|blessing|scripture|verse|god|lord|amen|devotion|devotional|sermon|faith|spiritual)\b/i;

describe("spoken briefing script", () => {
  const b = buildSpokenBriefing(base, { timeZone: tz });

  it("opens with how many things need a decision and how many are worth a look", () => {
    expect(b.sections[0]!.sentences).toEqual(["Here is today's briefing. 3 things need a decision, and 3 are worth a look."]);
    const quiet = buildSpokenBriefing({ attention: null, sunday: { ...sunday, findings: [pending] } }, { timeZone: tz });
    expect(quiet.sections[0]!.sentences).toEqual(["Here is today's briefing. Nothing needs a decision, and one is worth a look."]);
  });

  it("reads what needs a decision first: tonight's room, then Sunday's open positions", () => {
    const decisions = b.sections.find(s => s.id === "decisions")!;
    expect(decisions.sentences[0]).toBe("Tonight's orientation needs a location decision. A message reports the room unavailable; the calendar still lists it. According to the message, volunteers have not been contacted. Next step: decide the location and communicate the plans yourself.");
    expect(decisions.sentences.slice(1)).toEqual([
      "For Sunday, Greeter still needs one more person at the 9:30 AM service. One person on the team could help with no overlap found, and one with a possible conflict. One person's availability couldn't be checked.",
      "Nursery still needs one more person at the 9:30 AM service. No one else on this team is clear for this time.",
    ]);
  });

  it("then what's worth a look, without names by default", () => {
    const looks = b.sections.find(s => s.id === "looks")!.sentences;
    expect(looks).toContain("No one is scheduled to lead Nursery this Sunday. Your Church rules ask for a scheduled lead.");
    expect(looks).toContain("Someone scheduled for Lyrics hasn't accepted yet. Planning Center shows the request hasn't been sent yet.");
    expect(looks).toContain("Someone has been scheduled 3 weeks in a row. Your Church rules suggest a quick check-in.");
    expect(looks).toContain("Ozzie ignored one email that contained instructions. It never follows instructions found inside email, and nothing was done.");
    expect(looks).toContain("Ozzie read 3 other emails and calendar items. Nothing is needed from you there.");
    for (const name of Object.values(capture.names)) expect(b.text).not.toContain(name);
    for (const id of Object.keys(capture.names)) expect(b.text).not.toContain(id);
  });

  it("says what wasn't checked and when each source was read", () => {
    expect(b.sections.find(s => s.id === "unchecked")!.sentences).toEqual(sunday.not_checked);
    expect(b.sections.find(s => s.id === "times")!.sentences).toEqual([
      "The email and calendar items are the fictional example, imported Thursday, November 19 at 9:00 AM. No mailbox was read.",
      "The Sunday check is the fictional example, read Friday, November 20 at 10:00 AM.",
    ]);
    expect(b.sections.at(-1)!.sentences).toEqual(["Stopping or skipping this briefing doesn't mark anything done. The details and sources are on screen."]);
  });

  it("is one to two minutes of plain words, with no devotional wording", () => {
    expect(b.seconds).toBeGreaterThanOrEqual(60);
    expect(b.seconds).toBeLessThanOrEqual(MAX_SPOKEN_SECONDS);
    expect(b.seconds).toBe(Math.round(b.words / SPOKEN_WORDS_PER_MINUTE * 60));
    expect(b.text).not.toMatch(DEVOTIONAL);
    expect(b.text).not.toMatch(/[·•→]|\[|\]/);
    expect(b.text).toBe(b.sections.map(s => s.sentences.join(" ")).join("\n\n"));
  });

  it("names people only when names are turned on, and only from this check", () => {
    const named = buildSpokenBriefing(base, { timeZone: tz, includeNames: true, names: capture.names });
    expect(named.text).toContain("Cameron Larkspur hasn't accepted Lyrics yet.");
    expect(named.text).toContain("Avery Brightwater has been scheduled 3 weeks in a row.");
    expect(buildSpokenBriefing(base, { timeZone: tz, includeNames: true, names: {} }).text).toContain("Someone scheduled for Lyrics hasn't accepted yet.");
  });

  it("doesn't read a Sunday item the person already decided as open", () => {
    const greeter = sunday.findings.find(f => f.key === needKey("7593350", "Greeter"))!;
    const decided = applyDecisions(sunday, [decide(greeter, "covered-outside", "A parent is covering", "2026-11-20T16:00:00Z")]);
    const s = buildSpokenBriefing({ ...base, decided }, { timeZone: tz });
    expect(s.text).not.toContain("Greeter still needs");
    expect(s.sections.find(x => x.id === "decisions")!.sentences).toContain("You already decided one Sunday item, for this Sunday only.");
  });

  it("reads a decision Planning Center changed since as needing attention again", () => {
    const greeter = sunday.findings.find(f => f.key === needKey("7593352", "Nursery"))!;
    const later = nov22LaterCapture();
    const now = buildSundayBrief(later, rules, later.completed_at, true);
    const decided = applyDecisions(now, [decide(greeter, "not-needed", "Small class this week", "2026-11-20T16:00:00Z")]);
    const s = buildSpokenBriefing({ ...base, sunday: now, decided }, { timeZone: tz });
    expect(s.text).toContain("This needs attention again: Nursery still needs 2 more people");
  });

  it("says plainly when Sunday or email wasn't checked at all, and never calls that clear", () => {
    const s = buildSpokenBriefing({ attention: null, sunday: null }, { timeZone: tz });
    expect(s.sections.find(x => x.id === "decisions")!.sentences).toEqual(["Nothing Ozzie read needs a decision."]);
    expect(s.sections.find(x => x.id === "unchecked")!.sentences).toEqual(["Sunday hasn't been checked yet.", "No email or calendar was read."]);
    expect(s.text).not.toMatch(/covered|all clear|nothing to worry/i);
  });

  it("speaks each time the way its page shows it: email in the import's zone, Sunday in this Mac's", () => {
    const s = buildSpokenBriefing(base, { timeZone: "America/Chicago", attentionTimeZone: tz });
    expect(s.sections.find(x => x.id === "times")!.sentences).toEqual([
      "The email and calendar items are the fictional example, imported Thursday, November 19 at 9:00 AM. No mailbox was read.",
      "The Sunday check is the fictional example, read Friday, November 20 at 9:00 AM.",
    ]);
    expect(s.text).toContain("Greeter still needs one more person at the 8:30 AM service.");
  });

  it("says the service's times on a church's own clock and when it was checked on this Mac's, when they differ (round 3)", () => {
    const live = buildSundayBrief(capture, rules, "2026-11-20T18:00:00Z");
    const s = buildSpokenBriefing({ attention: null, sunday: live }, { timeZone: "America/Chicago", checkedTimeZone: "America/Los_Angeles" });
    expect(s.sections.find(x => x.id === "times")!.sentences[0]).toBe(
      "Planning Center was checked Friday, November 20 at 7:00 AM. That's more than 30 minutes ago, so it may not be current.");
    // The service's own time stays on the church's clock.
    expect(buildSpokenBriefing(base, { timeZone: "America/Chicago", checkedTimeZone: "America/Los_Angeles" }).text)
      .toContain("Greeter still needs one more person at the 8:30 AM service.");
  });

  it("says when a live check is out of date", () => {
    const live = buildSundayBrief(capture, rules, "2026-11-20T18:00:00Z");
    const s = buildSpokenBriefing({ attention: null, sunday: live }, { timeZone: tz });
    expect(s.sections.find(x => x.id === "times")!.sentences).toEqual([
      "Planning Center was checked Friday, November 20 at 10:00 AM. That's more than 30 minutes ago, so it may not be current.",
    ]);
    expect(s.text).toContain("This check is out of date. Check Planning Center again before relying on it.");
  });

  it("stays under two minutes on a busy Sunday by pointing to the screen for the rest", () => {
    const many: Finding[] = Array.from({ length: 12 }, (_, i) => ({
      id: `need:${i}`, key: `k${i}`, kind: "needs-people", tone: "decision", remaining: 2,
      position: { id: `${i}`, team_id: `t${i}`, name: `Position ${i}`, interval: null },
      people: { suggestions: [], conflicts: [], unverified: [], left_out: [] }, why: [],
    }));
    const busy: SundayBrief = { ...sunday, findings: [...many, ...sunday.findings] };
    const s = buildSpokenBriefing({ ...base, sunday: busy }, { timeZone: tz });
    expect(s.seconds).toBeLessThanOrEqual(MAX_SPOKEN_SECONDS);
    expect(s.text).toContain("And 11 more that need a decision, listed on screen.");
    // Well inside what the native voice accepts (MAX_SPEECH_CHARS in local_tools.rs).
    expect(s.text.length).toBeLessThan(4000);
  });

  it("reads fewer items per section when even four each would run past two minutes", () => {
    const wordy = (i: number): Finding => ({
      id: `look:${i}`, key: `l${i}`, kind: "lead-missing", tone: "look",
      position: { id: `${i}`, team_id: `t${i}`, name: `Hospitality and welcome table setup crew for the second service ${i}`, interval: null }, why: [],
    });
    const notChecked = Array.from({ length: 10 }, (_, i) => `Blockouts for ${i + 2} people on the hospitality and welcome table setup crew: took too long.`);
    const heavy: SundayBrief = { ...sunday, findings: [...Array.from({ length: 8 }, (_, i) => wordy(i)), ...sunday.findings], not_checked: notChecked };
    const attentionHeavy: AttentionReport = { ...attention, findings: Array.from({ length: 6 }, () => attention.findings[0]!) };
    const s = buildSpokenBriefing({ ...base, attention: attentionHeavy, sunday: heavy }, { timeZone: tz });
    expect(s.seconds).toBeLessThanOrEqual(MAX_SPOKEN_SECONDS);
    expect(s.text.length).toBeLessThanOrEqual(MAX_SPOKEN_CHARS);
    expect(s.text).toMatch(/And \d+ more things Ozzie couldn't check, listed on screen\./);
    // Four per section would have run past two minutes here; the script reads fewer.
    expect(s.text).not.toContain("And 4 more that need a decision");
    expect(s.text).toContain("And 6 more that need a decision, listed on screen.");
  });
});

// Second independent review (ported from the reviewer's probes, asserting the fixed behaviour).
describe("spoken briefing: rooms, follow-ups and group meetings, and what couldn't be checked", () => {
  const withOps = withFictionalOperations(nov22Capture());
  // No lead rule or streak rule, so every rooms and follow-ups line fits the four read per section.
  const quiet = { sundayLeads: [], checkInAfterSundaysInARow: 0 };
  const opsBrief = buildSundayBrief(withOps, quiet, withOps.completed_at, true);
  const section = (s: ReturnType<typeof buildSpokenBriefing>, id: string) => s.sections.find(x => x.id === id)?.sentences ?? [];

  it("counts what the Sunday page shows: a follow-up with no owner, a room overlap, a group meeting (M4)", () => {
    const operations = sundayOperations(withOps, quiet)!;
    const s = buildSpokenBriefing({ attention: null, sunday: opsBrief, operations }, { timeZone: tz });
    expect(section(s, "intro")).toEqual(["Here is today's briefing. 3 things need a decision, and 4 are worth a look."]);
    // Where to choose, named as its card names it: it was read from Planning Center People's workflows (polish pass).
    expect(section(s, "decisions")).toContain("One follow-up has no owner and is past due. Choose who will handle it in Planning Center People.");
    expect(s.text).not.toContain("church tools");
    expect(section(s, "looks")).toEqual(expect.arrayContaining(["Two room bookings overlap, and it's worth a look.",
      "One person on Sunday's plan has a group meeting at the same time they serve."]));
    // Counts only: no room, workflow, step or person name is spoken.
    for (const name of [...Object.values(withOps.labels!), ...Object.values(withOps.names)]) expect(s.text).not.toContain(name);
    // A not-shared room with Calendar's unresolved record is a room use that needs review.
    const confirmed = buildSpokenBriefing({ attention: null, sunday: opsBrief, operations: sundayOperations(withOps, { ...quiet, rooms: [{ room_id: FICTIONAL_ROOM, exclusive: true, setup_minutes: 30 }] }) },
      { timeZone: tz });
    expect(section(confirmed, "decisions")).toContain("One room use needs review: bookings overlap in a room your Church rules say isn't shared.");
  });

  it("counts each follow-up and group meeting as the Sunday page does, however many one line says (live review 2026-11-18)", () => {
    const operations = sundayOperations(withOps, quiet)!;
    const followUp = operations.result!.findings.find(f => f.kind === "unowned-overdue")!, meeting = operations.group_meetings[0]!;
    const more = { ...operations, result: { ...operations.result!, findings: [...operations.result!.findings, { ...followUp, finding_id: `${followUp.finding_id}-2`, card_id: "c2" }] },
      group_meetings: [meeting, { ...meeting, person_id: "p2" }] };
    const shown = sundayShownCount(applyDecisions(opsBrief, []), more);
    expect(shown).toMatchObject({ decisions: 4, looks: 5 });
    const s = buildSpokenBriefing({ attention: null, sunday: opsBrief, operations: more }, { timeZone: tz });
    expect(section(s, "intro")).toEqual(["Here is today's briefing. 4 things need a decision, and 5 are worth a look."]);
    expect(section(s, "decisions")).toContain("2 follow-ups have no owner and are past due. Choose who will handle them in Planning Center People.");
    // One whose source isn't known: the generic words, for all of them.
    const unknown = { ...more, result: { ...more.result, findings: more.result.findings.map(f => f.finding_id === `${followUp.finding_id}-2`
      ? { ...f, evidence: f.evidence.map(e => ({ ...e, source: "church-rule" as const })) } : f) } };
    const generic = buildSpokenBriefing({ attention: null, sunday: opsBrief, operations: unknown }, { timeZone: tz });
    expect(section(generic, "decisions")).toContain("2 follow-ups have no owner and are past due. Choose who will handle them in your church tools.");
  });

  it("reads the rooms and follow-ups gaps, and the Groups gap when Groups couldn't be read (P8, L8)", () => {
    const refused = withFictionalOperations(nov22Capture());
    for (const r of refused.reads.filter(r => r.collection.startsWith("groups_"))) { r.outcome = "denied"; delete r.body; }
    const brief = buildSundayBrief(refused, rules, refused.completed_at, true);
    expect(brief.not_checked).toContain("Groups for 3 people: Planning Center didn't allow it.");
    const s = buildSpokenBriefing({ attention: null, sunday: brief, operations: sundayOperations(refused, rules) }, { timeZone: tz });
    expect(section(s, "unchecked")).toContain("Groups for 3 people: Planning Center didn't allow it.");
    // Said once: the rooms and follow-ups check doesn't repeat it as a group-meetings line.
    expect(sundayOperations(refused, rules)!.not_checked.filter(l => l.startsWith("Group meetings"))).toEqual([]);
    // Some people's groups read, one person's not: how many is named.
    const one = withFictionalOperations(nov22Capture());
    const r = one.reads.find(x => x.collection === "groups_person_memberships")!;
    r.outcome = "timeout"; delete r.body;
    expect(buildSundayBrief(one, rules, one.completed_at, true).not_checked).toContain("Groups for 1 person: took too long.");
    // A bookings read that failed is said too.
    const rooms = withFictionalOperations(nov22Capture());
    for (const x of rooms.reads.filter(x => x.collection === "calendar_resource_bookings")) { x.outcome = "denied"; delete x.body; }
    const spoken = buildSpokenBriefing({ attention: null, sunday: buildSundayBrief(rooms, rules, rooms.completed_at, true), operations: sundayOperations(rooms, rules) }, { timeZone: tz });
    expect(spoken.text).toContain("Room bookings: Planning Center didn't allow it.");
    // A check with none of those reads says rooms and follow-ups weren't part of it.
    const none = buildSpokenBriefing({ attention: null, sunday: buildSundayBrief(nov22Capture(), rules, CHECKED, true), operations: null }, { timeZone: tz });
    expect(none.text).toContain("Room bookings and follow-ups weren't part of this check.");
  });

  it("an out-of-date check reads no rooms, follow-ups or group meetings as current", () => {
    const live = { ...withOps, kind: "live" as const };
    const now = "2026-11-20T18:00:00Z";
    const s = buildSpokenBriefing({ attention: null, sunday: buildSundayBrief(live, rules, now), operations: sundayOperations(live, rules, { now }) }, { timeZone: tz });
    expect(s.text).not.toContain("follow-up has no owner");
    expect(s.text).not.toContain("group meeting at the same time");
    expect(s.text).toContain("Rooms, follow-ups and group meetings: this check is out of date, so they aren't shown.");
  });

  it("says how many people couldn't be checked when no one else is clear (L2)", () => {
    const need: Finding = { id: "need:1", key: "k", kind: "needs-people", tone: "decision", remaining: 1,
      position: { id: "1", team_id: "t", name: "Greeter", interval: { starts_at: "2026-11-22T14:30:00Z", ends_at: "2026-11-22T15:30:00Z" } },
      people: { suggestions: [], conflicts: [], unverified: ["a", "b", "c"].map(person_id => ({ person_id, reasons: [] })), left_out: [] }, why: [] };
    const s = buildSpokenBriefing({ attention: null, sunday: { ...sunday, findings: [need] } }, { timeZone: tz });
    expect(section(s, "decisions")).toEqual(["For Sunday, Greeter still needs one more person at the 9:30 AM service. No one else on this team is clear for this time. 3 people's availability couldn't be checked."]);
  });

  it("never passes markup to the voice: <, > and & become spaces (M5)", () => {
    const ssml = '<speak><prosody rate="x-fast">Greeter</prosody> & <break time="9s"/></speak>';
    const need: Finding = { id: "need:1", key: "k", kind: "needs-people", tone: "decision", remaining: 1,
      position: { id: "1", team_id: "t", name: ssml, interval: null }, people: { suggestions: [], conflicts: [], unverified: [], left_out: [] }, why: [] };
    const s = buildSpokenBriefing({ attention: null, sunday: { ...sunday, findings: [need], not_checked: ["Blockouts for <b>2</b> people & more."] } }, { timeZone: tz });
    expect(s.text).not.toMatch(/[<>&]/);
    for (const part of s.sections) for (const sentence of part.sentences) expect(sentence).not.toMatch(/[<>&]/);
    expect(s.text).toContain("speak  prosody rate=\"x-fast\" Greeter /prosody");
  });
});

// Onboarding spec §5 (decision 18): a service on a Wednesday is never called Sunday, said or written.
describe("a Wednesday service, by its own day", () => {
  const wed = wednesdayCapture();
  const brief = buildSundayBrief(wed, rules, wed.completed_at, true);

  it("names Wednesday wherever Sunday would have been said, and never says Sunday", () => {
    const s = buildSpokenBriefing({ attention: null, sunday: brief }, { timeZone: tz });
    expect(s.text).toContain("For Wednesday, Greeter still needs one more person at the 9:30 AM service.");
    expect(s.text).toContain("No one is scheduled to lead Nursery this Wednesday. Your Church rules ask for a scheduled lead.");
    expect(s.text).toContain("Someone has been scheduled 3 weeks in a row.");
    expect(s.text).toContain("The Wednesday check is the fictional example, read Friday, November 20 at 10:00 AM.");
    expect(s.text).not.toMatch(/sunday/iu);
  });

  it("before any check, says the watched day hasn't been checked, from the day words it's given", () => {
    const s = buildSpokenBriefing({ attention: null, sunday: null }, { timeZone: tz, day: wednesdayWords() });
    expect(s.sections.find(x => x.id === "unchecked")!.sentences[0]).toBe("Wednesday hasn't been checked yet.");
  });

  it("a decided item and a partial read are said for this Wednesday", () => {
    const greeter = brief.findings.find(f => f.key === needKey("7593350", "Greeter"))!;
    const decided = applyDecisions(brief, [decide(greeter, "covered-outside", "A parent is covering", "2026-11-20T16:00:00Z")]);
    const s = buildSpokenBriefing({ attention: null, sunday: brief, decided }, { timeZone: tz });
    expect(s.sections.find(x => x.id === "decisions")!.sentences).toContain("You already decided one Wednesday item, for this Wednesday only.");
    const partial: SundayBrief = { ...brief, findings: [{ id: "worth-a-look:scope", key: "w", kind: "worth-a-look", tone: "look", why: [] }] };
    expect(buildSpokenBriefing({ attention: null, sunday: partial }, { timeZone: tz }).text)
      .toContain("Part of this Wednesday couldn't be checked, so Ozzie won't call Wednesday covered.");
  });
});

// Someone scheduled with a blockout over their serving time (fixture matrix C30-C37): Worth a look, never a gap.
describe("spoken briefing: someone scheduled with a blockout", () => {
  const blocked = (people: string[]) => {
    const c = nov22Capture();
    for (const person of people) {
      c.reads.find(r => r.collection === "person_blockouts" && r.person_id === person)!.body = {
        data: [{ type: "Blockout", id: `b${person}`, attributes: { starts_at: "2026-11-22T05:00:00Z", ends_at: "2026-11-23T04:59:59Z", repeat_frequency: "no_repeat" } }],
        meta: { count: 1, total_count: 1 } };
    }
    return c;
  };
  const c = blocked(["501"]);
  const brief = buildSundayBrief(c, rules, c.completed_at, true);

  it("is read under Worth a look, without a name by default and with one only when names are on", () => {
    const quiet = buildSpokenBriefing({ attention: null, sunday: brief }, { timeZone: tz });
    expect(quiet.sections.find(s => s.id === "looks")!.sentences).toContain("Someone scheduled for Greeter at 9:30 AM has a blockout in Planning Center at that time.");
    expect(quiet.sections.find(s => s.id === "decisions")!.sentences.join(" ")).not.toContain("blockout");
    for (const name of Object.values(c.names)) expect(quiet.text).not.toContain(name);
    const named = buildSpokenBriefing({ attention: null, sunday: brief }, { timeZone: tz, includeNames: true, names: c.names });
    expect(named.text).toContain("Avery Brightwater is scheduled for Greeter at 9:30 AM and has a blockout in Planning Center at that time.");
  });

  it("counts it with the other things worth a look", () => {
    const without = buildSpokenBriefing({ attention: null, sunday }, { timeZone: tz });
    const withIt = buildSpokenBriefing({ attention: null, sunday: brief }, { timeZone: tz });
    const looks = (s: typeof without) => Number(/and (\d+) are worth a look/u.exec(s.sections[0]!.sentences[0]!)?.[1]);
    expect(looks(withIt)).toBe(looks(without) + 1);
  });
});
